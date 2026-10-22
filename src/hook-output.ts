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

// ---------------------------------------------------------------------------
// Merging several handlers into one hook output (home-base-rtsx1.1)
// ---------------------------------------------------------------------------

/** What one handler child process did, as the dispatcher observed it. */
export interface HandlerRunResult {
  /** The exit code, or null when the child never exited on its own. */
  exitCode: number | null;
  id: string;
  /** Why the child could not be started, or null when it started. */
  spawnError: string | null;
  stderr: string;
  stdout: string;
  /** True when the dispatcher stopped it at its time limit. */
  timedOut: boolean;
  timeoutMs: number;
}

/** What the dispatcher prints and exits with. */
export interface MergedHookOutput {
  exitCode: 0 | 2;
  stderr: string;
  /** One JSON object and a newline, or '' when nobody said anything. */
  stdout: string;
}

/** The output keys a handler may print. Anything else is reported, not passed. */
const KNOWN_OUTPUT_KEYS = new Set([
  'continue',
  'decision',
  'hookSpecificOutput',
  'reason',
  'stopReason',
  'suppressOutput',
  'systemMessage',
]);

function firstLine(text: string): string | null {
  const line = text
    .split('\n')
    .map((part) => part.trim())
    .find((part) => part !== '');
  return line ?? null;
}

function parseOneObject(stdout: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return parsed != null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Merge every handler's output into the ONE output Claude Code reads from the
 * `hook <Event>` entry.
 *
 * WHAT IS PRESERVED, AND WHY EACH RULE IS SAFE:
 *  - Each handler's `additionalContext` and `systemMessage` pass through
 *    verbatim, joined by a blank line in handler order. Claude Code already
 *    joins several hooks' contexts ("When several hooks return
 *    additionalContext for the same event, Claude receives all of the values",
 *    hooks reference, read 2026-10-17), and time-check and usage-check find
 *    their own earlier notices in the transcript by exact text, so nothing is
 *    reworded. Nothing is mirrored again: each handler already mirrored itself.
 *  - A `decision: "block"` from any handler blocks; the reasons are joined.
 *  - A handler that EXITS 2 (thread stop-check blocks that way) makes the
 *    dispatcher exit 2 with that handler's stderr, exactly as Claude Code would
 *    have treated the handler on its own. stdout is still printed: "Claude Code
 *    still reads the JSON output fields, but they can't override the block".
 *    stderr then carries ONLY the blocking handlers' text, because on exit 2 it
 *    is what Claude is told.
 *
 * A FAILED HANDLER IS NAMED, NEVER SWALLOWED (critical rule 7), and never costs
 * the others their output: one that did not start, timed out, exited with any
 * code other than 0 or 2, or printed something that is not one JSON object gets
 * a line in `systemMessage` with what happened, and everyone else's output is
 * kept. Exiting non-zero for it instead would make Claude Code discard every
 * other handler's JSON.
 */
export function mergeHandlerOutputs(
  event: string,
  runs: readonly HandlerRunResult[],
): MergedHookOutput {
  const messages: string[] = [];
  const contexts: string[] = [];
  const blockReasons: string[] = [];
  const stopReasons: string[] = [];
  const failures: string[] = [];
  const blockingStderr: string[] = [];
  const passthroughStderr: string[] = [];
  let stopContinuing = false;
  // Tracked apart from blockingStderr: a handler that exits 2 blocks whether
  // or not it wrote a reason.
  let blocking = false;

  for (const run of runs) {
    if (run.spawnError != null) {
      failures.push(`${run.id} did not start (${run.spawnError})`);
      continue;
    }
    if (run.timedOut) {
      failures.push(
        `${run.id} was stopped after ${run.timeoutMs / 1000} s without finishing`,
      );
      continue;
    }

    const stderr = run.stderr.trimEnd();
    if (run.exitCode !== 0 && run.exitCode !== 2) {
      const detail = firstLine(stderr);
      failures.push(
        `${run.id} failed (exit ${run.exitCode ?? 'unknown'})${detail == null ? '' : `: ${detail}`}`,
      );
      continue;
    }
    if (run.exitCode === 2) {
      blocking = true;
      if (stderr !== '') blockingStderr.push(stderr);
    } else if (stderr !== '') {
      passthroughStderr.push(
        stderr
          .split('\n')
          .map((line) => `[${run.id}] ${line}`)
          .join('\n'),
      );
    }

    if (run.stdout.trim() === '') continue;
    const json = parseOneObject(run.stdout.trim());
    if (json == null) {
      failures.push(`${run.id} printed output that is not one JSON object`);
      continue;
    }

    const unknown = Object.keys(json).filter(
      (key) => !KNOWN_OUTPUT_KEYS.has(key),
    );
    if (unknown.length > 0) {
      failures.push(
        `${run.id} printed output keys the dispatcher does not pass on: ${unknown.join(', ')}`,
      );
    }
    if (typeof json.systemMessage === 'string' && json.systemMessage !== '') {
      messages.push(json.systemMessage);
    }
    const specific = json.hookSpecificOutput as
      | {additionalContext?: unknown}
      | undefined;
    if (
      specific != null &&
      typeof specific.additionalContext === 'string' &&
      specific.additionalContext !== ''
    ) {
      contexts.push(specific.additionalContext);
    }
    if (json.decision === 'block') {
      blockReasons.push(
        typeof json.reason === 'string' && json.reason !== ''
          ? json.reason
          : `${run.id} blocked without a reason`,
      );
    }
    if (json.continue === false) {
      stopContinuing = true;
      if (typeof json.stopReason === 'string' && json.stopReason !== '') {
        stopReasons.push(json.stopReason);
      }
    }
  }

  const failureLines = failures.map(
    (failure) => `⚠️ justin-sdk hook ${event}: ${failure}`,
  );
  const systemMessage = [...messages, ...failureLines].join('\n\n');

  const output: Record<string, unknown> = {};
  if (stopContinuing) {
    output.continue = false;
    if (stopReasons.length > 0) output.stopReason = stopReasons.join('\n\n');
  }
  if (blockReasons.length > 0) {
    output.decision = 'block';
    output.reason = blockReasons.join('\n\n');
  }
  if (contexts.length > 0) {
    output.hookSpecificOutput = {
      additionalContext: contexts.join('\n\n'),
      hookEventName: event,
    };
  }
  if (systemMessage !== '') output.systemMessage = systemMessage;

  return {
    exitCode: blocking ? 2 : 0,
    stderr: blocking
      ? blockingStderr.length > 0
        ? `${blockingStderr.join('\n')}\n`
        : ''
      : passthroughStderr.length > 0
        ? `${passthroughStderr.join('\n')}\n`
        : '',
    stdout:
      Object.keys(output).length === 0 ? '' : `${JSON.stringify(output)}\n`,
  };
}
