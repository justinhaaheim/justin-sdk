#!/usr/bin/env bun

/**
 * justin-sdk CLI — the `bin` entry point. The whole command tree lives in
 * cli-main.ts; this file exists so ONE hot path can answer before that tree
 * loads.
 *
 * F8 (home-base-vzwbj.4.9): the commit nudge (`thread nudge`, a PostToolUse
 * hook with matcher Bash) runs after EVERY Bash call Claude makes in an
 * enrolled repo, and almost none of them is a commit. Loading cli-main.ts —
 * yargs plus every command module, all imported statically — measured 62-65 ms
 * per call on a non-commit payload (`bun run measure:thread-hook --hook
 * nudge`, 2026-10-11). So when argv is exactly `thread nudge` (optionally
 * `--explain`), the payload is read HERE:
 *
 *  - a Bash command that contains neither the word `commit` nor the word
 *    `close` exits 0 silently. That is the full hook's own answer, not an
 *    approximation: its two decision tables are silent on "not a git commit"
 *    and "not a br close of a bead id", isGitCommitCommand cannot match a
 *    command without `commit`, and brCloseIds (the last-request warning,
 *    home-base-yukaf.3) cannot find an id without a `close` token.
 *  - anything else (a commit, a close, a payload this cannot read) goes to the
 *    full hook, runThreadNudgeHook, with the payload already read — stdin can
 *    be read only once.
 *
 * The hook dispatcher (`hook <Event>`, optionally `--dry-run`, home-base-rtsx1.1)
 * answers here too, for the same reason: in a dispatch-mode repo it is the
 * entry for EVERY prompt, tool batch, Bash call and turn end, and it needs
 * nothing from the command tree. Its handlers are children that come back
 * through this file, so `thread nudge` keeps its own fast path.
 *
 * `thread brake` (the spend quota's PreToolUse brake, every tool) answers here
 * too: exactly `thread brake`, nothing after it.
 *
 * Every other argv — `thread nudge --help` and `hook --help` included — goes to
 * cli-main.ts untouched, so help still prints help and does nothing else.
 */

import {readFileSync} from 'node:fs';

/**
 * True only when the payload is a JSON object whose `tool_input.command` is a
 * string WITHOUT the word `commit` and WITHOUT the word `close`. Anything not
 * provably that is false, and the full hook decides.
 */
function provablySilent(raw: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (parsed == null || typeof parsed !== 'object') return false;
  const input = (parsed as {tool_input?: unknown}).tool_input;
  const command =
    input != null && typeof input === 'object'
      ? (input as {command?: unknown}).command
      : undefined;
  return (
    typeof command === 'string' &&
    !command.includes('commit') &&
    !command.includes('close')
  );
}

const argv = process.argv.slice(2);
const explain = argv.length === 3 && argv[2] === '--explain';

/** `hook <Event>` or `hook <Event> --dry-run`, and nothing else. */
const hookEvent =
  argv[0] === 'hook' &&
  argv[1] != null &&
  !argv[1].startsWith('-') &&
  (argv.length === 2 || (argv.length === 3 && argv[2] === '--dry-run'))
    ? argv[1]
    : null;

if (hookEvent != null) {
  const {runHookCommand} = await import('./hook-dispatch');
  process.exit(
    await runHookCommand({dryRun: argv.length === 3, event: hookEvent}),
  );
} else if (argv[0] === 'thread' && argv[1] === 'brake' && argv.length === 2) {
  // The quota brake runs on EVERY tool call where the quota is on (home-base-
  // ys9t7.5 D6): its cached path must not load the command tree.
  const {runThreadBrakeHook} = await import('./thread/quota-brake');
  process.exit(await runThreadBrakeHook());
} else if (
  argv[0] === 'thread' &&
  argv[1] === 'nudge' &&
  (argv.length === 2 || explain)
) {
  let raw: string;
  try {
    raw = readFileSync(0, 'utf8');
  } catch {
    raw = '';
  }
  if (provablySilent(raw)) {
    if (explain) {
      console.error(
        'thread nudge: silent — not a git commit or a br close (fast path: the command tree was not loaded)',
      );
    }
    process.exit(0);
  }
  const {runThreadNudgeHook} = await import('./thread/nudge');
  process.exit(await runThreadNudgeHook({explain, stdin: raw}));
} else {
  await import('./cli-main');
}
