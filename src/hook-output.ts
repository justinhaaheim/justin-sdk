/**
 * hook-output — the ONE place the SDK builds a Claude Code hook's JSON output
 * (home-base-39co9.4, decision M3).
 *
 * Justin, 2026-10-05: "For the things injected to claude code, as a general rule
 * I want all of those things to MIRROR what is being injected to me via a system
 * message. [...] It is really helpful and important for me to be able to see
 * what messages cc is getting -- especially from our own tooling like this."
 *
 * So no hook builds `hookSpecificOutput.additionalContext`, or a Stop
 * `decision: "block"` with its `reason`, by hand. It hands this module two
 * things — what CLAUDE should read, and what only JUSTIN should read — and this
 * module puts a mirror of the Claude-bound text into `systemMessage` every
 * time. `tests/hook-output.test.ts` walks every SDK source file and fails when
 * anything outside this file spells either field as an object key, so the
 * mirror cannot be skipped by a hook written later.
 *
 * THE TWO CHANNELS, per https://code.claude.com/docs/en/hooks (read 2026-10-05):
 *  - `systemMessage` — "Warning message shown to the user." Universal: every
 *    event accepts it, though some events discard it (Notification, PreCompact,
 *    SessionEnd…; none of the events the SDK hooks).
 *  - `hookSpecificOutput.additionalContext` — "Claude Code wraps the string in a
 *    system reminder and inserts it into the conversation at the point where the
 *    hook fired. Claude reads the reminder on the next model request, but it
 *    doesn't appear as a chat message in the interface." Accepted by
 *    SessionStart, UserPromptSubmit, PostToolUse, PostToolBatch, Stop and
 *    SubagentStop.
 *  - Both are capped: "A hook's `additionalContext`, `systemMessage`, and
 *    `initialUserMessage` strings, and its plain stdout, are capped at 10,000
 *    characters" — over it, Claude gets a file path and a 2,000-character
 *    preview instead of the text. The mirror says so when that happens, because
 *    then what Justin reads is NOT what Claude got.
 *
 * MIRROR VERBATIM, UP TO A POINT (M3). A payload of up to MIRROR_MAX_LINES
 * lines is mirrored exactly. A longer one is mirrored as its first
 * MIRROR_MAX_LINES lines plus `(N more lines; print them with <command>)`, so a
 * full rules injection does not bury the terminal, and the reader still knows
 * both that something was cut and how to see it.
 *
 * ANSI IS STRIPPED FROM BOTH HALVES. `additionalContext` always was
 * (home-base-dchjw.9: escapes in a model's context are literal noise that costs
 * tokens). `systemMessage` used to carry only a plain header, so whether Claude
 * Code renders colour codes there was never tested; now that doctor's coloured
 * report goes there, plain text is the choice that cannot print `[32m` at
 * Justin.
 */

import {stripAnsi} from './check-runner';

/** Mirror at most this many lines of a Claude-bound payload (M3: "about 40"). */
export const MIRROR_MAX_LINES = 40;

/** Claude Code's per-field hook text cap, from the hooks reference. */
export const CLAUDE_CODE_HOOK_TEXT_CAP = 10_000;

/** What one hook run wants to say, to whom. */
export interface HookMessage {
  /**
   * The hook event this output answers (`SessionStart`, `UserPromptSubmit`,
   * `PostToolBatch`, …). Required by Claude Code inside `hookSpecificOutput`.
   */
  event: string;
  /**
   * Text injected into CLAUDE's context (`additionalContext`). Always mirrored
   * into `systemMessage`. Empty means the hook injects nothing.
   */
  forClaude: string;
  /**
   * Text only JUSTIN reads (the rest of `systemMessage`). Claude never sees it.
   */
  forJustin?: string;
  /**
   * A command that prints the full Claude-bound text. Named in the mirror when
   * the payload is longer than MIRROR_MAX_LINES; null when there is none, and
   * the mirror then says the rest went to Claude unseen.
   */
  fullTextCommand?: string | null;
}

/** The JSON object a hook prints. Fields absent when they would be empty. */
export interface HookOutputJson {
  hookSpecificOutput?: {additionalContext: string; hookEventName: string};
  systemMessage?: string;
}

/** The JSON a blocking Stop hook prints, with its reason mirrored. */
export interface StopBlockJson {
  decision: 'block';
  reason: string;
  systemMessage: string;
}

function lineCount(text: string): number {
  return text === '' ? 0 : text.split('\n').length;
}

/**
 * Justin's copy of a Claude-bound payload: verbatim up to MIRROR_MAX_LINES
 * lines, then a pointer to the rest. Exported for tests and for anything that
 * needs to show the same cut elsewhere.
 */
export function mirrorForJustin(
  forClaude: string,
  fullTextCommand: string | null = null,
): string {
  // Trailing whitespace only: a final newline is not a line Justin needs shown.
  const body = forClaude.trimEnd();
  if (body === '') return '';
  const lines = body.split('\n');
  const parts: string[] = [];
  if (lines.length <= MIRROR_MAX_LINES) {
    parts.push(body);
  } else {
    const hidden = lines.length - MIRROR_MAX_LINES;
    parts.push(
      lines.slice(0, MIRROR_MAX_LINES).join('\n'),
      fullTextCommand == null
        ? `(${hidden} more lines, sent to Claude and not shown here)`
        : `(${hidden} more lines; print them with \`${fullTextCommand}\`)`,
    );
  }
  if (forClaude.length > CLAUDE_CODE_HOOK_TEXT_CAP) {
    parts.push(
      `⚠️ This is ${forClaude.length} characters, over Claude Code's ${CLAUDE_CODE_HOOK_TEXT_CAP}-character hook cap: Claude receives a file path and a 2,000-character preview instead of the text above.`,
    );
  }
  return parts.join('\n');
}

/**
 * Build the hook's JSON object, or null when there is nothing to say at all.
 *
 * `systemMessage` = the Justin-only text, then the mirror. When both are
 * present a one-line marker separates them, so Justin can tell which part
 * Claude also received; when the whole message IS the mirror, no marker is
 * added and the mirror is the message, byte for byte.
 */
export function hookOutputJson(message: HookMessage): HookOutputJson | null {
  // Claude's text is passed through untouched apart from the colour codes:
  // time-check and usage-check find their own earlier output in the transcript
  // by its exact text, so this module must not reformat it.
  const stripped = stripAnsi(message.forClaude);
  const forClaude = stripped.trim() === '' ? '' : stripped;
  const forJustin = stripAnsi(message.forJustin ?? '').trimEnd();
  const mirror = mirrorForJustin(forClaude, message.fullTextCommand ?? null);

  const systemMessage =
    forJustin !== '' && mirror !== ''
      ? `${forJustin}\n\n↓ also sent to Claude (${lineCount(forClaude.trimEnd())} lines):\n${mirror}`
      : forJustin !== ''
        ? forJustin
        : mirror;

  if (forClaude === '' && systemMessage === '') return null;
  return {
    ...(forClaude !== ''
      ? {
          hookSpecificOutput: {
            additionalContext: forClaude,
            hookEventName: message.event,
          },
        }
      : {}),
    ...(systemMessage !== '' ? {systemMessage} : {}),
  };
}

/** The hook's stdout: one JSON object and a newline, or '' when silent. */
export function renderHookOutput(message: HookMessage): string {
  const json = hookOutputJson(message);
  return json == null ? '' : `${JSON.stringify(json)}\n`;
}

/**
 * Print the hook's output to stdout. Prints nothing when there is nothing.
 *
 * Through `console.log`, which is what time-check and usage-check always used
 * and what their tests capture; in Bun it and `process.stdout.write` are
 * separate channels, so switching would silently blind those tests.
 */
export function emitHookOutput(message: HookMessage): void {
  const json = hookOutputJson(message);
  if (json != null) console.log(JSON.stringify(json));
}

/**
 * A blocking Stop decision. The `reason` is what Claude is told; it is mirrored
 * into `systemMessage` under the same rule as everything else, so Justin sees
 * exactly why the turn was taken back.
 */
export function stopBlockJson(reason: string): StopBlockJson {
  return {
    decision: 'block',
    reason,
    systemMessage: mirrorForJustin(stripAnsi(reason)),
  };
}
