/**
 * `worktree-salvage hook` and `hook-json` (epic home-base-us739, D9; dispatch
 * 2, home-base-us739.2).
 *
 * THE HOOK is a Claude Code PreToolUse hook for the ExitWorktree tool. It
 * reads one payload from stdin and acts ONLY when `tool_name` is
 * `ExitWorktree`, `tool_input.action` is `remove` AND
 * `tool_input.discard_changes` is true. ExitWorktree itself refuses to remove
 * a dirty worktree without `discard_changes`, so a first call never removes
 * anything; saving on it would save every dirty worktree twice. The checkout
 * is the payload's `cwd`.
 *
 *   - Anything else, or a clean checkout: exit 0, no output.
 *   - A dirty checkout saved: exit 0, and a `systemMessage` for Justin only
 *     (through src/hook-output.ts, `forClaude` empty) naming where it went.
 *   - A save that fails, an unreadable payload, a broken config: exit 2 with
 *     the reason on stderr. Claude Code treats exit 2 as a block of the tool
 *     call and shows stderr to Claude, so the worktree is NOT removed.
 *
 * Why PreToolUse and not WorktreeRemove: Claude Code's hooks reference (read
 * 2026-10-17) says WorktreeRemove "Runs when Claude Code cleans up a worktree
 * that your WorktreeCreate hook created", and that "For git-based worktrees,
 * Claude Code handles cleanup automatically with `git worktree remove`". The
 * full reading is on home-base-us739.2.
 *
 * HOOK-JSON prints the settings entries for both forms; registering either
 * one is a human step (follow-up home-base-us739.4). The SDK never writes a
 * settings file.
 *
 * THE USER-LEVEL FORM FAILS CLOSED (home-base-us739.8). It is one sh line:
 * when `justin-sdk-latest` is not on PATH it prints one line to stderr and
 * exits 2, so ExitWorktree is blocked; otherwise it runs `justin-sdk-latest
 * worktree-salvage hook` in EVERY repo, enrolled or not. It deliberately does
 * not reuse src/user-level-hook.ts's guard, whose two tests both exit 0:
 *   - `[ -e "$CLAUDE_PROJECT_DIR/justin-sdk.config.json" ]` skips enrolled
 *     repos. Right for session-start, where the project hook does strictly
 *     more; wrong here, because nothing registers the project form yet, so
 *     an enrolled repo would get no protection at all. The cost it avoided
 *     (the ls-remote inside justin-sdk-latest) is paid only on an
 *     ExitWorktree call, which is rare.
 *   - `! command -v justin-sdk-latest` makes a missing launcher exit 0. Right
 *     for session-start, where a hook that errors in every session is worse
 *     than none; wrong for a safety hook, where exit 0 lets ExitWorktree
 *     remove the worktree unsaved.
 */

import type {Destination} from './config';
import type {CommandIo, IgnoredSurvey, SaveResult} from './save';

import {z} from 'zod';

import {renderHookOutput} from '../hook-output';
import {SDK_LATEST, sdkRun} from '../sdk-invocation';
import {describeDestinationSource, resolveDestination} from './config';
import {
  formatBytes,
  formatCount,
  processIo,
  renderSaveResult,
  saveCheckout,
} from './save';

/** Claude Code reads exit 2 from a PreToolUse hook as "block this tool call". */
export const HOOK_BLOCK_EXIT = 2;

/** The tool the hook guards, and its settings matcher. */
export const HOOK_MATCHER = 'ExitWorktree';

/** The project-level hook command (D1's hook form of the SDK invocation). */
export const PROJECT_HOOK_COMMAND = sdkRun('worktree-salvage hook');

/** The first line of every block, from the hook and from the user-level sh line. */
const BLOCKED_HEADLINE =
  'worktree-salvage hook: ExitWorktree was BLOCKED so the worktree is not removed unsaved';

/**
 * The one stderr line the user-level command prints when the launcher is
 * missing. It sits inside single quotes in sh, so it must hold no `'`.
 */
const LAUNCHER_MISSING_LINE = `${BLOCKED_HEADLINE}: ${SDK_LATEST} is not on PATH`;

/**
 * The user-level hook command: fail closed when `justin-sdk-latest` is
 * missing, and run in enrolled repos too. See the file header.
 */
export const USER_LEVEL_SALVAGE_HOOK_COMMAND = `command -v ${SDK_LATEST} >/dev/null 2>&1 || { echo '${LAUNCHER_MISSING_LINE}' >&2; exit ${HOOK_BLOCK_EXIT}; }; ${SDK_LATEST} worktree-salvage hook`;

const PayloadSchema = z
  .object({
    cwd: z.string().optional(),
    tool_input: z.unknown().optional(),
    tool_name: z.string().optional(),
  })
  .passthrough();

const ExitWorktreeInputSchema = z
  .object({
    action: z.unknown().optional(),
    discard_changes: z.unknown().optional(),
  })
  .passthrough();

/** What the hook decided about one payload, before any save. */
export type HookDecision =
  | {checkout: string; kind: 'save'}
  | {kind: 'block'; reason: string}
  | {kind: 'ignore'; why: string};

/** Decide from the raw stdin text. Pure. */
export function decideHook(stdin: string): HookDecision {
  let raw: unknown;
  try {
    raw = JSON.parse(stdin);
  } catch (error) {
    return {
      kind: 'block',
      reason: `the hook payload on stdin is not JSON (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  const payload = PayloadSchema.safeParse(raw);
  if (!payload.success) {
    return {
      kind: 'block',
      reason: `the hook payload has an unexpected shape: ${payload.error.issues[0]?.message ?? 'unknown'}`,
    };
  }
  if (payload.data.tool_name !== HOOK_MATCHER) {
    return {
      kind: 'ignore',
      why: `tool_name is ${payload.data.tool_name ?? 'absent'}`,
    };
  }
  const input = ExitWorktreeInputSchema.safeParse(
    payload.data.tool_input ?? {},
  );
  if (!input.success) {
    return {
      kind: 'block',
      reason: `ExitWorktree's tool_input has an unexpected shape: ${input.error.issues[0]?.message ?? 'unknown'}`,
    };
  }
  if (input.data.action !== 'remove')
    return {kind: 'ignore', why: 'action is not remove'};
  if (input.data.discard_changes !== true) {
    return {
      kind: 'ignore',
      why: 'discard_changes is not true, so ExitWorktree removes nothing dirty',
    };
  }
  const cwd = payload.data.cwd ?? '';
  if (cwd === '') {
    return {
      kind: 'block',
      reason:
        'the payload has no cwd, so the worktree being removed is unknown',
    };
  }
  return {checkout: cwd, kind: 'save'};
}

/** Each ignored path a save left out, with its size: `tmp/ (674 MB, 2,353 files)`. */
function notSavedLabels(
  ignored: Pick<IgnoredSurvey, 'paths' | 'skipped'>,
  copied: boolean,
): string[] {
  return [...(copied ? [] : ignored.paths), ...ignored.skipped].map((path) =>
    path.size.ok
      ? `${path.path} (${formatBytes(path.size.value.bytes)}, ${formatCount(path.size.value.files, 'file')})`
      : `${path.path} (size unknown)`,
  );
}

/**
 * Justin's `systemMessage` when there was nothing to save but git ignores
 * content in the checkout (fix round F1, home-base-us739.6). D2: ignored
 * content is never silent, and ExitWorktree is about to remove it; the
 * mail-scan worktree's only unique content was ignored. Null when the
 * checkout holds no ignored paths either: a truly clean checkout stays silent.
 */
export function ignoredOnlyMessage(
  result: Extract<SaveResult, {kind: 'nothing-to-save'}>,
): string | null {
  const notSaved = notSavedLabels(result.ignored, false);
  if (notSaved.length === 0) return null;
  return [
    `⚠️ worktree-salvage saved nothing from ${result.facts.root} before ExitWorktree removes it: it has no modified or untracked files`,
    `NOT saved (ignored by git): ${notSaved.join(', ')}`,
    `to keep them, save first with \`${sdkRun(`worktree-salvage save --ignored ${result.facts.root}`)}\` (it never copies node_modules/ or .git/)`,
  ].join('\n');
}

/** Justin's `systemMessage` for a save the hook made. */
export function savedMessage(
  result: Extract<SaveResult, {kind: 'saved'}>,
): string {
  const {manifest} = result;
  const notSaved = notSavedLabels(manifest.ignored, manifest.ignored.copied);
  const nested = manifest.nestedCheckouts.map(
    (checkout) => `${checkout.path}/`,
  );
  return [
    `💾 worktree-salvage saved ${manifest.worktreePath} before ExitWorktree removes it`,
    `saved to: ${result.stampDir}`,
    `files: ${formatCount(manifest.totals.files, 'file')} copied, ${formatCount(manifest.totals.deletions, 'deletion')} recorded, ${formatCount(manifest.indexEntries.length, 'index-only version')}`,
    `destination: ${result.destination.dir} (${describeDestinationSource(result.destination)})`,
    ...(notSaved.length === 0
      ? []
      : [`NOT saved (ignored by git): ${notSaved.join(', ')}`]),
    ...(nested.length === 0
      ? []
      : [`NOT entered (nested checkouts): ${nested.join(', ')}`]),
  ].join('\n');
}

/**
 * Run the hook on one payload. Returns the exit code; prints only through
 * `io`. Never throws.
 */
export async function runHookCommand(
  stdin: string,
  io: CommandIo = processIo(),
): Promise<number> {
  const decision = decideHook(stdin);
  if (decision.kind === 'ignore') return 0;
  const blocked = async (reason: string): Promise<number> => {
    await io.stderr(`${BLOCKED_HEADLINE}.\n${reason}\n`);
    return HOOK_BLOCK_EXIT;
  };
  if (decision.kind === 'block') return await blocked(decision.reason);

  let destination: Destination;
  try {
    destination = resolveDestination(null, {
      cwd: decision.checkout,
      env: io.env,
    });
  } catch (error) {
    return await blocked(
      `the save destination could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = saveCheckout({
    checkout: decision.checkout,
    destination,
    includeIgnored: false,
  });
  switch (result.kind) {
    case 'nothing-to-save': {
      const message = ignoredOnlyMessage(result);
      if (message != null) {
        await io.stdout(
          renderHookOutput({
            event: 'PreToolUse',
            forClaude: '',
            forJustin: message,
          }),
        );
      }
      return 0;
    }
    case 'failed':
      return await blocked(renderSaveResult(result, io.stderrStyle));
    case 'saved':
      await io.stdout(
        renderHookOutput({
          event: 'PreToolUse',
          forClaude: '',
          forJustin: savedMessage(result),
        }),
      );
      return 0;
  }
}

/** The settings entries `hook-json` prints, built as objects and serialised. */
export function hookSettingsJson(): string {
  const entry = (command: string) => ({
    hooks: {
      PreToolUse: [
        {hooks: [{command, type: 'command'}], matcher: HOOK_MATCHER},
      ],
    },
  });
  return JSON.stringify(
    {
      note: 'justin-sdk never writes settings files. Merge ONE of these by hand; registering it is home-base-us739.4.',
      project: {
        file: '.claude/settings.json',
        settings: entry(PROJECT_HOOK_COMMAND),
      },
      userLevel: {
        file: '~/.claude/settings.json',
        settings: entry(USER_LEVEL_SALVAGE_HOOK_COMMAND),
      },
    },
    null,
    2,
  );
}

/** `worktree-salvage hook-json`. */
export async function runHookJsonCommand(
  io: CommandIo = processIo(),
): Promise<number> {
  await io.stdout(`${hookSettingsJson()}\n`);
  return 0;
}
