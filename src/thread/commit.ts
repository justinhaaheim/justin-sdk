/**
 * Committing the threads repo after a write (home-base-p1uj.11).
 *
 * WHY THIS EXISTS, AND WHY IT DID NOT BEFORE. D13 said the tool must not commit
 * the beads JSONL: threads lived in ~/Dev/life, and a cross-repo commit fired
 * from every session's wrap-up would race life's own index (`index.lock`) and
 * bury a day of reports under thread churn. Justin moved threads into their own
 * repo on 2026-09-12 ("let's go ahead and put this in its own repo"), which
 * removes the other writer entirely — so D13 is RETRACTED and the commit is now
 * part of finishing a write. What is left to race is only another `thread`
 * process, and that is what the lock below is for.
 *
 * WHAT IS COMMITTED. `.beads/issues.jsonl` and nothing else. bd's auto-export
 * (`export.auto`, `git-add: true`) has already written and staged it; this adds
 * the `git add` again anyway, because auto-export is a background timer and a
 * run that beat it would otherwise commit nothing while reporting success.
 *
 * FAILURE IS A WARNING, NEVER A LOSS (rule 6, and p1uj.10's lesson). By the
 * time this runs, the beads are in Dolt. A commit that cannot be made leaves
 * the repo exactly as `git-add: true` left it — dirty, and visible to
 * `thread board`. So every failure returns a distinct outcome the caller
 * prints, and no failure here ever changes an exit code or prints NOT RECORDED.
 *
 * THE OUTCOMES ARE FOUR DIFFERENT FACTS and none of them is the others
 * (rule 6.1): `committed` (a sha exists), `nothing-to-commit` (measured clean —
 * bd exported nothing new, or a concurrent run already committed it),
 * `disabled` (the knob is off; nobody promised a commit), and `failed` (we
 * tried and could not). Collapsing `failed` into `nothing-to-commit` is exactly
 * the reassuring-direction substitution that rule forbids: it would report a
 * repo full of uncommitted reports as clean.
 */

import {spawnSync} from 'child_process';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import {join} from 'path';

import {resolveThreadConfig} from './config';
import {threadsRepoDir, threadsStateDir} from './paths';

import type {EnvLike} from './paths';

/** The file `thread` commits. Relative to the threads repo. */
export const BEADS_JSONL = '.beads/issues.jsonl';

export type CommitOutcome =
  | {kind: 'committed'; sha: string; subject: string}
  | {kind: 'nothing-to-commit'}
  | {kind: 'disabled'}
  | {kind: 'skipped-export-unstaged'}
  | {kind: 'failed'; command: string; detail: string};

export interface CommitOptions {
  /** Overrides the resolved knob. Tests and `--no-commit` callers use it. */
  autoCommit?: boolean;
  /** The repo to commit in. Defaults to the resolved threads repo. */
  dir?: string;
  env?: EnvLike;
  /**
   * True when bd already told us it could not git-stage the export — i.e. this
   * repo's `.git` is unwritable right now. Passing it skips a `git` run whose
   * failure is already known, which is the same contract `paths.ts` states for
   * bd calls: never spend a call you know will fail.
   */
  exportUnstaged?: boolean;
}

function run(
  dir: string,
  args: string[],
  env: EnvLike,
): {ok: true; stdout: string} | {ok: false; detail: string} {
  const result = spawnSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: env as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error != null) {
    return {detail: result.error.message, ok: false};
  }
  if (result.status !== 0) {
    const detail =
      `${(result.stderr ?? '').trim()} ${(result.stdout ?? '').trim()}`.trim();
    return {
      detail: detail === '' ? `git exited ${result.status}` : detail,
      ok: false,
    };
  }
  return {ok: true, stdout: result.stdout ?? ''};
}

/**
 * ONE COMMIT AT A TIME, ACROSS PROCESSES.
 *
 * Two sessions wrapping up at once would otherwise run `git add` + `git commit`
 * interleaved in the same repo: git's own `index.lock` makes one of them fail
 * outright, and the loser's beads sit uncommitted while its report says nothing
 * went wrong. `open(O_CREAT|O_EXCL)` in the state dir is the smallest thing
 * that serialises them — the same shape as the drain's `rename(2)` lock (F10),
 * and chosen for the same reason: atomicity is the filesystem's, not ours.
 *
 * The lock lives in the STATE dir, not the repo, on purpose. A lock file inside
 * the threads repo would be a new untracked path in the very repo whose
 * cleanliness this feature is about, and it would be unwritable in exactly the
 * case (a denied `.git`) where we most want to reason about the failure.
 *
 * A holder that DIES leaves the file behind, so the file carries its pid and a
 * waiter that finds a MEASURABLY dead owner steals it. "I could not tell
 * whether that pid is alive" leaves it alone and waits, which costs a commit
 * that the next write will make anyway.
 */
const LOCK_NAME = 'threads-commit.lock';
const LOCK_ATTEMPTS = 40;
const LOCK_SLEEP_MS = 50;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** true = running, false = MEASURED gone, null = could not tell (rule 6). */
function pidAlive(pid: number): boolean | null {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code =
      error != null && typeof error === 'object' && 'code' in error
        ? String((error as {code: unknown}).code)
        : '';
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    return null;
  }
}

export type LockHandle = {path: string} | null;

/**
 * Take the commit lock, or return null after waiting ~2s.
 *
 * Null is NOT an error: the caller commits anyway. Losing the lock race only
 * means someone else is committing the same file, and the worst case is git
 * refusing one of the two — which is a warning, not a loss. Blocking a status
 * report for longer than that would be the worse trade.
 */
export function acquireCommitLock(stateDir: string): LockHandle {
  const path = join(stateDir, LOCK_NAME);
  try {
    mkdirSync(stateDir, {recursive: true});
  } catch {
    // Unwritable state dir: run unlocked rather than refuse to commit.
    return null;
  }
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      const fd = openSync(path, 'wx');
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return {path};
    } catch {
      let owner: number | null = null;
      try {
        const raw = readFileSync(path, 'utf8').trim();
        owner = /^[0-9]+$/.test(raw) ? Number(raw) : null;
      } catch {
        owner = null;
      }
      if (owner != null && owner !== process.pid && pidAlive(owner) === false) {
        try {
          rmSync(path, {force: true});
          continue;
        } catch {
          // Someone else reclaimed it; fall through to the wait.
        }
      }
      sleepSync(LOCK_SLEEP_MS);
    }
  }
  return null;
}

export function releaseCommitLock(handle: LockHandle): void {
  if (handle == null) return;
  try {
    rmSync(handle.path, {force: true});
  } catch {
    // A stranded lock file is reclaimed by the next waiter's pid check.
  }
}

/**
 * Stage and commit the threads repo's beads JSONL.
 *
 * `message` is the whole commit subject, and the callers spell it
 * `thread <id>: <what>` so `git log --oneline` in the threads repo reads as a
 * ledger of which thread changed when.
 */
export function commitThreadsRepo(
  message: string,
  options: CommitOptions = {},
): CommitOutcome {
  const env = options.env ?? process.env;
  const autoCommit =
    options.autoCommit ?? resolveThreadConfig({env}).autoCommit;
  if (!autoCommit) return {kind: 'disabled'};
  if (options.exportUnstaged === true) return {kind: 'skipped-export-unstaged'};

  const dir = options.dir ?? threadsRepoDir(env);
  const lock = acquireCommitLock(threadsStateDir(env));
  try {
    const added = run(dir, ['add', '--', BEADS_JSONL], env);
    if (!added.ok) {
      return {
        command: `git add -- ${BEADS_JSONL}`,
        detail: added.detail,
        kind: 'failed',
      };
    }
    // MEASURED clean, before committing: `git commit` with nothing staged exits
    // 1 with "nothing to commit", which is indistinguishable at the exit-code
    // level from a real failure. Asking first is what keeps those two apart.
    const staged = run(
      dir,
      ['diff', '--cached', '--quiet', '--', BEADS_JSONL],
      env,
    );
    if (staged.ok) return {kind: 'nothing-to-commit'};

    const committed = run(
      dir,
      ['commit', '-q', '-m', message, '--', BEADS_JSONL],
      env,
    );
    if (!committed.ok) {
      return {
        command: `git commit -m ${JSON.stringify(message)}`,
        detail: committed.detail,
        kind: 'failed',
      };
    }
    const head = run(dir, ['log', '-1', '--format=%h %s'], env);
    if (!head.ok) {
      // The commit happened; we just cannot read its sha back. Saying
      // "committed, sha unknown" is the honest shape — never a fabricated sha.
      return {kind: 'committed', sha: 'UNKNOWN', subject: message};
    }
    const line = head.stdout.trim();
    const space = line.indexOf(' ');
    return {
      kind: 'committed',
      sha: space === -1 ? line : line.slice(0, space),
      subject: space === -1 ? message : line.slice(space + 1),
    };
  } finally {
    releaseCommitLock(lock);
  }
}

/**
 * What the command prints about the commit — or null when there is nothing to
 * say.
 *
 * `disabled` and `nothing-to-commit` are silent on purpose: the first is what
 * the operator asked for, and the second means the repo is already in the state
 * the commit would have produced. Only a real outcome (a sha) or a real problem
 * (a failure) earns a line.
 */
export function describeCommit(
  outcome: CommitOutcome,
  repoDisplay: string,
): string | null {
  switch (outcome.kind) {
    case 'committed':
      return `  committed to ${repoDisplay}: ${outcome.sha} ${outcome.subject}`;
    case 'failed':
      return `⚠️ WARNING: recorded in Dolt, but ${repoDisplay} could NOT be committed (${outcome.command} — ${outcome.detail.slice(0, 200)}). Nothing was lost; \`justin-sdk thread board\` shows what is uncommitted.`;
    case 'disabled':
    case 'nothing-to-commit':
    case 'skipped-export-unstaged':
      return null;
  }
}
