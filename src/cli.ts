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
 *  - a Bash command that does not contain the word `commit` exits 0 silently.
 *    That is the full hook's own answer, not an approximation: the decision
 *    table is silent on "not a git commit", and isGitCommitCommand cannot match
 *    a command without that word (it only strips quoted text, then needs
 *    `git … commit`).
 *  - anything else (a commit, a payload this cannot read) goes to the full
 *    hook, runThreadNudgeHook, with the payload already read — stdin can be
 *    read only once.
 *
 * Every other argv — `thread nudge --help` included — goes to cli-main.ts
 * untouched, so help still prints help and does nothing else.
 */

import {readFileSync} from 'node:fs';

/**
 * True only when the payload is a JSON object whose `tool_input.command` is a
 * string WITHOUT the word `commit`. Anything not provably that is false, and
 * the full hook decides.
 */
function provablyNotACommit(raw: string): boolean {
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
  return typeof command === 'string' && !command.includes('commit');
}

const argv = process.argv.slice(2);
const explain = argv.length === 3 && argv[2] === '--explain';
if (
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
  if (provablyNotACommit(raw)) {
    if (explain) {
      console.error(
        'thread nudge: silent — not a git commit (fast path: the command tree was not loaded)',
      );
    }
    process.exit(0);
  }
  const {runThreadNudgeHook} = await import('./thread/nudge');
  process.exit(await runThreadNudgeHook({explain, stdin: raw}));
} else {
  await import('./cli-main');
}
