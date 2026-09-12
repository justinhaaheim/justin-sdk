/**
 * repo-status — when were this checkout's remote refs last refreshed?
 *
 * WHY THIS EXISTS. The ledger prints `0 behind origin/main`, and a reader takes
 * that as "nothing new upstream". It is not: `origin/main` is a LOCAL ref that
 * only a fetch moves, so the sentence is really "0 behind whatever this disk
 * last downloaded" — and if that was three weeks ago the reassurance is worth
 * nothing. The precondition was never stated anywhere in the output, which is
 * the rule-6 shape arriving through a stale cache instead of an error path
 * (home-base-qyu1.33.6).
 *
 * `git rev-parse --git-path FETCH_HEAD` then `stat`. FETCH_HEAD is written by
 * every fetch and is PER-WORKTREE, so `--git-path` is what finds the right one —
 * a linked worktree has its own, and reading the primary's would report somebody
 * else's fetch as this checkout's.
 *
 * WHAT THE TIMESTAMP DOES AND DOES NOT PROVE. It bounds the age of the remote
 * refs from above: nothing here was refreshed more recently than this. It does
 * not prove every remote ref was updated then — `git fetch origin main` writes
 * FETCH_HEAD while touching one ref — so it is reported as an age, never as a
 * freshness guarantee.
 *
 * THREE STATES, TYPED. "fetched at T", "no fetch has ever happened in this
 * checkout", and "the age could not be read" are three different facts, and the
 * last two must not collapse into each other or into a fabricated recent
 * timestamp. A missing FETCH_HEAD is the ORDINARY state of a fresh clone that
 * has never fetched, and an unreadable one is a genuine unknown.
 */

import {execFileSync} from 'child_process';
import {statSync} from 'fs';
import {resolve} from 'path';

export type FetchAge =
  /** A fetch has happened in this checkout; `at` is when the last one finished. */
  | {kind: 'fetched'; at: string}
  /** No FETCH_HEAD: nothing has ever been fetched into this checkout. */
  | {kind: 'never'}
  /** The age could not be determined. NOT "recent" and not "never". */
  | {kind: 'unknown'; why: string};

/** Is this an ENOENT — the file genuinely not being there? */
function isMissing(err: unknown): boolean {
  return (err as {code?: string} | null)?.code === 'ENOENT';
}

function detail(err: unknown): string {
  const e = err as {message?: string; stderr?: string} | null;
  const stderr = e?.stderr?.toString().trim().split('\n')[0];
  if (stderr != null && stderr.length > 0) return stderr;
  return e?.message?.split('\n')[0] ?? 'no detail available';
}

/**
 * When this checkout last fetched, as far as FETCH_HEAD can say.
 *
 * Every failure is reported as `unknown` with git's own complaint, because the
 * alternative — treating an unreadable FETCH_HEAD as "never fetched" — would
 * print the more alarming claim, and treating it as fetched would print the
 * reassuring one. Neither is measured.
 */
export function readFetchAge(cwd: string): FetchAge {
  let path: string;
  try {
    path = execFileSync('git', ['rev-parse', '--git-path', 'FETCH_HEAD'], {
      cwd,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
  } catch (err) {
    return {
      kind: 'unknown',
      why: `\`git rev-parse --git-path FETCH_HEAD\` failed (${detail(err)})`,
    };
  }
  if (path.length === 0) {
    return {
      kind: 'unknown',
      why: '`git rev-parse --git-path FETCH_HEAD` printed nothing',
    };
  }
  // `--git-path` answers relative to the cwd git was run in when the repo is at
  // or below it, and absolutely otherwise. `resolve` is correct either way.
  const full = resolve(cwd, path);
  try {
    return {at: statSync(full).mtime.toISOString(), kind: 'fetched'};
  } catch (err) {
    if (isMissing(err)) return {kind: 'never'};
    return {kind: 'unknown', why: `could not stat ${full} (${detail(err)})`};
  }
}
