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
 *
 * AND THEN IT PUSHES (home-base-p1uj.20, decision D22). The threads repo got a
 * remote on 2026-09-15 (private, github.com/justinhaaheim/threads), and a
 * backup that only exists on this laptop is not a backup. D22 rejected a
 * watcher daemon of the dotfiles `gitwatch` shape for the same reason D13 was
 * reversed: this tool is the repo's only writer, so the push belongs where the
 * write finishes, not in a process that has to notice the write happened. The
 * push is therefore part of `commitThreadsRepo` — every caller (report, start,
 * answer, done, drain) gets it without opting in — and it carries the same
 * contract as the commit: the beads are already in Dolt and already committed,
 * so a push that cannot be made is ONE WARNING LINE and exit 0. Never
 * NOT RECORDED, never a retry loop, never `--force`.
 *
 * IT PUSHES WHENEVER THE BRANCH IS AHEAD, not only when this run committed
 * (conductor review of p1uj.20). The first cut pushed only after a commit,
 * which left one hole: a push that failed once stayed failed until the next
 * real write, so "0 ahead after every write" — the sentence this bead is
 * accepted against — was false in exactly the case the feature exists for. A
 * `git rev-list --count origin/<branch>..HEAD` is LOCAL and costs no network,
 * so the no-op path can ask before it decides, and still skips the network
 * entirely when there is nothing to send.
 */

import type {EnvLike} from './paths';

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

import {SDK_RUN} from '../sdk-invocation';
import {resolveThreadConfig} from './config';
import {THREAD_DEFAULT_AUTO_COMMIT, THREAD_DEFAULT_AUTO_PUSH} from './defaults';
import {threadsRepoDir, threadsStateDir} from './paths';

/** The file `thread` commits. Relative to the threads repo. */
export const BEADS_JSONL = '.beads/issues.jsonl';

/**
 * What happened to the push — four facts, none of them each other (rule 6.1).
 *
 * `pushed` means GIT ACCEPTED IT: origin now has this commit. It covers the
 * "Everything up-to-date" case too (a concurrent run pushed the same HEAD
 * first), because the claim being made is about where the commit IS, not about
 * whether bytes moved. `no-remote` is MEASURED absence — `git config --get`
 * exited 1, its documented "key not found" code — and is silent, because a
 * threads repo with no remote never promised a push. `disabled` is the knob.
 * `failed` is "we tried and could not", and is the only one that warns.
 *
 * There is deliberately no `up-to-date` member and no `unknown`: the first is a
 * distinction without a consequence, and the second would be a failure wearing
 * a calmer word.
 */
export type PushOutcome =
  | {kind: 'pushed'; remote: string}
  | {kind: 'no-remote'}
  | {kind: 'not-ahead'}
  | {kind: 'disabled'}
  | {command: string; detail: string; kind: 'failed'};

/**
 * How this branch stands against origin — the cheap, LOCAL answer.
 *
 * No network: it reads `origin/<branch>` as the remote-tracking ref git already
 * has, which is what `git push` itself updates on success. That is what makes
 * it affordable on the no-op path, where the whole point is to skip the network
 * when there is nothing to send.
 *
 * `unknown` carries the sentence the board prints, so there is one place where
 * "why can this not be measured" is worded. It is NOT `level`: a branch whose
 * `origin/<branch>` has never existed has everything to push, and calling that
 * zero would be the reassuring reading of a failed measurement (rule 6).
 */
export type AheadOutcome =
  | {branch: string; count: number; kind: 'ahead'}
  | {branch: string; kind: 'level'}
  | {kind: 'no-remote'}
  | {kind: 'unknown'; reason: string};

/**
 * A push is only ever reachable through a COMMIT that happened, and the types
 * say so: `push` lives on the `committed` member and nowhere else. A caller
 * cannot read a push outcome off an outcome where no commit was made, so "we
 * pushed" can never be printed about a write that never reached git.
 */
export type CommitOutcome =
  | {kind: 'committed'; push: PushOutcome; sha: string; subject: string}
  | {kind: 'nothing-to-commit'; push: PushOutcome}
  | {kind: 'disabled'}
  | {kind: 'skipped-export-unstaged'}
  | {command: string; detail: string; kind: 'failed'};

export interface CommitOptions {
  /** Overrides the resolved knob. Tests and `--no-commit` callers use it. */
  autoCommit?: boolean;
  /** Overrides `componentConfig.thread.autoPush`. Tests pin it. */
  autoPush?: boolean;
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

/**
 * `status` is carried on the failure so a caller can tell git's DOCUMENTED exit
 * codes apart — `git config --get` exits 1 for "key not found", which is a
 * measurement, from 3/4/6 and a spawn error, which are breakage. Null means the
 * process never produced a code (spawn error, or a signal such as the push
 * timeout's SIGTERM), which is its own third answer and never a number.
 */
type RunResult =
  | {ok: true; stdout: string}
  | {detail: string; ok: false; status: number | null};

function run(
  dir: string,
  args: string[],
  env: EnvLike,
  options: {timeoutMs?: number} = {},
): RunResult {
  const result = spawnSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: env as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(options.timeoutMs == null ? {} : {timeout: options.timeoutMs}),
  });
  if (result.error != null) {
    return {detail: result.error.message, ok: false, status: null};
  }
  // A timeout kills the child with a SIGNAL, and `status` is then null. Reading
  // that as a clean exit would turn "git hung on a credential prompt" into
  // "git said nothing is wrong" — the exact substitution rule 6 forbids.
  if (result.signal != null) {
    const detail = (result.stderr ?? '').trim();
    return {
      detail:
        `git was killed by ${result.signal}` +
        (options.timeoutMs == null ? '' : ` after ${options.timeoutMs}ms`) +
        (detail === '' ? '' : ` — ${detail}`),
      ok: false,
      status: null,
    };
  }
  if (result.status !== 0) {
    const detail =
      `${(result.stderr ?? '').trim()} ${(result.stdout ?? '').trim()}`.trim();
    return {
      detail: detail === '' ? `git exited ${result.status}` : detail,
      ok: false,
      status: result.status,
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

/**
 * true = running, false = MEASURED gone, null = could not tell (rule 6).
 *
 * Exported for `thread capture`'s per-session lock (k0b8n.9), which steals a
 * dead holder's lock by exactly this test.
 */
export function pidAlive(pid: number): boolean | null {
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

/** The only remote `thread` will ever push to (D22). */
export const PUSH_REMOTE = 'origin';

/**
 * A wrap-up must not hang on git.
 *
 * `GIT_TERMINAL_PROMPT=0` turns a credential prompt into an immediate error
 * rather than a blocked session, but it does not cover every way a push can
 * stall (an ssh passphrase is read from /dev/tty, a TCP connect to a dead
 * network just waits), so the timeout is the backstop rather than the polish.
 * Twenty seconds is chosen against what it costs to be wrong in each direction:
 * too short only defers a push the next write will make anyway, while too long
 * holds up the report Justin is waiting to read.
 */
export const PUSH_TIMEOUT_MS = 20_000;

/**
 * How far ahead of `origin/<branch>` this repo is, measured locally.
 *
 * ONE implementation, two readers: the no-op commit path uses it to decide
 * whether a push is worth a network round-trip, and `thread board` uses it to
 * tell Justin how much exists only on this laptop. A second copy of this
 * measurement is exactly the kind of thing that drifts until the warning and
 * the dashboard disagree about the same repo.
 */
export function aheadOfOrigin(dir: string, env: EnvLike): AheadOutcome {
  const remote = run(
    dir,
    ['config', '--get', `remote.${PUSH_REMOTE}.url`],
    env,
  );
  if (!remote.ok || remote.stdout.trim() === '') return {kind: 'no-remote'};

  const branch = run(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], env);
  const name = branch.ok ? branch.stdout.trim() : '';
  if (name === '' || name === 'HEAD') {
    return {
      kind: 'unknown',
      reason: `no branch to compare (${(branch.ok ? name : branch.detail).slice(0, 120)})`,
    };
  }
  // Asked separately from the count so "never pushed" gets its own sentence
  // instead of arriving as `fatal: ambiguous argument`.
  const tracked = run(
    dir,
    ['rev-parse', '--verify', '--quiet', `${PUSH_REMOTE}/${name}`],
    env,
  );
  if (!tracked.ok) {
    return {
      kind: 'unknown',
      reason: `${PUSH_REMOTE}/${name} does not exist locally, so there is nothing to compare against (this branch has never been pushed, or ${PUSH_REMOTE} has never been fetched)`,
    };
  }
  const counted = run(
    dir,
    ['rev-list', '--count', `${PUSH_REMOTE}/${name}..HEAD`],
    env,
  );
  if (!counted.ok) {
    return {
      kind: 'unknown',
      reason: `git could not be read (${counted.detail.slice(0, 120)})`,
    };
  }
  const raw = counted.stdout.trim();
  const count = Number(raw);
  // `Number('')` is 0, and a 0 here would read as "everything is pushed".
  if (raw === '' || !Number.isFinite(count)) {
    return {
      kind: 'unknown',
      reason: `git printed ${JSON.stringify(raw.slice(0, 40))}`,
    };
  }
  return count === 0
    ? {branch: name, kind: 'level'}
    : {branch: name, count, kind: 'ahead'};
}

/**
 * Push the current branch to `origin`, or say precisely why not (D22).
 *
 * `git push origin HEAD`, NOT a bare `git push`: the latter depends on
 * `push.default` and on an upstream being configured, and a threads repo whose
 * branch has no upstream would then warn on every single write. `origin HEAD`
 * asks for exactly one thing — this branch, onto the same name on origin — and
 * needs no tracking config to mean it.
 *
 * NEVER `--force`, and there is no retry. A rejected push means origin has work
 * this machine does not (D22 puts pulling out of scope — for now the repo has
 * one writing machine), and the answer to that is a human, not a louder push.
 * Nothing is lost while it waits: the commit is local, the beads are in Dolt,
 * the next successful push carries it, and `thread board` names the backlog
 * until then.
 */
export function pushThreadsRepo(
  dir: string,
  env: EnvLike,
  autoPush: boolean,
): PushOutcome {
  if (!autoPush) return {kind: 'disabled'};

  const remote = run(
    dir,
    ['config', '--get', `remote.${PUSH_REMOTE}.url`],
    env,
  );
  if (!remote.ok) {
    // Exit 1 is git-config's DOCUMENTED "the section or key is invalid" — the
    // measured fact that no origin is configured, which is silent by design.
    // Any other code (3 = unparseable config, a spawn failure, a signal) is
    // breakage, and breakage is never allowed to read as "there is no remote".
    if (remote.status === 1) return {kind: 'no-remote'};
    return {
      command: `git config --get remote.${PUSH_REMOTE}.url`,
      detail: remote.detail,
      kind: 'failed',
    };
  }
  if (remote.stdout.trim() === '') return {kind: 'no-remote'};

  const pushed = run(
    dir,
    ['push', '--quiet', PUSH_REMOTE, 'HEAD'],
    {...env, GIT_TERMINAL_PROMPT: '0'},
    {timeoutMs: PUSH_TIMEOUT_MS},
  );
  if (!pushed.ok) {
    return {
      command: `git push ${PUSH_REMOTE} HEAD`,
      detail: pushed.detail,
      kind: 'failed',
    };
  }
  return {kind: 'pushed', remote: PUSH_REMOTE};
}

/**
 * Push only if there is something to push — the no-op write's path.
 *
 * `level` is the ONLY answer that skips the push, and it is the only one that
 * has measured there is nothing to send. `unknown` pushes: a push on a branch
 * that turns out to be level is a harmless "Everything up-to-date", while
 * treating an unreadable measurement as "nothing to do" is the reassuring
 * substitution that leaves reports on one laptop.
 */
function pushIfAhead(
  dir: string,
  env: EnvLike,
  autoPush: boolean,
): PushOutcome {
  if (!autoPush) return {kind: 'disabled'};
  const ahead = aheadOfOrigin(dir, env);
  if (ahead.kind === 'no-remote') return {kind: 'no-remote'};
  if (ahead.kind === 'level') return {kind: 'not-ahead'};
  return pushThreadsRepo(dir, env, autoPush);
}

/**
 * Stage and commit the threads repo's beads JSONL, then push it.
 *
 * `message` is the whole commit subject, and the callers spell it
 * `thread <id>: <what>` so `git log --oneline` in the threads repo reads as a
 * ledger of which thread changed when.
 *
 * THE PUSH FOLLOWS A COMMIT AND ONLY A COMMIT (D22: "after a successful commit,
 * git push"). Nothing is pushed on `nothing-to-commit`, which keeps the common
 * no-op write free of a network round-trip and keeps the contract to one
 * sentence. The cost is that a push which failed earlier stays failed until the
 * next real write — so the gap is not left silent: `thread board` prints how
 * many commits are waiting, and the next commit pushes all of them, not just
 * its own.
 */
export function commitThreadsRepo(
  message: string,
  options: CommitOptions = {},
): CommitOutcome {
  const env = options.env ?? process.env;
  // One resolution for both knobs: reading the config twice would let a caller
  // that pins neither see two different files if one changed mid-run.
  const resolved =
    options.autoCommit == null || options.autoPush == null
      ? resolveThreadConfig({env})
      : null;
  const autoCommit =
    options.autoCommit ?? resolved?.autoCommit ?? THREAD_DEFAULT_AUTO_COMMIT;
  const autoPush =
    options.autoPush ?? resolved?.autoPush ?? THREAD_DEFAULT_AUTO_PUSH;
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
    // NOTHING NEW TO COMMIT IS NOT NOTHING TO PUSH. An earlier write may have
    // committed and failed to push (offline, auth, a refused non-fast-forward),
    // and that backlog would otherwise sit here until the next real write.
    // The ahead check is local, so the common case — level with origin — still
    // touches the network zero times.
    if (staged.ok) {
      return {kind: 'nothing-to-commit', push: pushIfAhead(dir, env, autoPush)};
    }

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
    // INSIDE THE LOCK, on purpose. Two sessions wrapping up together would
    // otherwise push the same branch at once and one would be told its push is
    // non-fast-forward — a WARNING about a race rather than about anything
    // wrong. The cost is that a slow push holds the lock, which can make
    // another process give up waiting (~2s) and commit unlocked; that is the
    // cheaper failure, and it is why the push has a timeout at all.
    const push = pushThreadsRepo(dir, env, autoPush);

    const head = run(dir, ['log', '-1', '--format=%h %s'], env);
    if (!head.ok) {
      // The commit happened; we just cannot read its sha back. Saying
      // "committed, sha unknown" is the honest shape — never a fabricated sha.
      return {kind: 'committed', push, sha: 'UNKNOWN', subject: message};
    }
    const line = head.stdout.trim();
    const space = line.indexOf(' ');
    return {
      kind: 'committed',
      push,
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
/**
 * A rejected push is six lines of git, four of them `hint:` prose aimed at
 * someone who is about to type `git pull`. Truncating that at 200 characters
 * spends the warning on the hint and cuts off mid-sentence, so the hints go and
 * the remaining lines join up — the reader gets `! [rejected] HEAD -> main
 * (fetch first)`, which is the fact, in the space available.
 *
 * Nothing is DROPPED except git's own hints: an unrecognised error keeps every
 * line it had, because a failure this code has never seen before is exactly the
 * one whose text must survive.
 */
function condenseGitError(detail: string): string {
  const lines = detail
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('hint:'));
  return lines.length === 0 ? detail.trim() : lines.join(' · ');
}

export function describePush(
  outcome: PushOutcome,
  repoDisplay: string,
): string | null {
  switch (outcome.kind) {
    case 'pushed':
      return `  pushed ${repoDisplay} to ${outcome.remote}`;
    case 'failed':
      return `⚠️ WARNING: the beads are recorded and committed, but ${repoDisplay} could NOT be pushed (${outcome.command} — ${condenseGitError(outcome.detail).slice(0, 200)}). Nothing was lost — the commits are local and the next write pushes them; \`${SDK_RUN} thread board\` shows what is unpushed.`;
    // Three different reasons NOT to have pushed, all of them silent, and none
    // of them a problem: the knob is off, there is no remote to push to, or
    // origin already has everything this branch has.
    case 'disabled':
    case 'no-remote':
    case 'not-ahead':
      return null;
  }
}

export function describeCommit(
  outcome: CommitOutcome,
  repoDisplay: string,
): string | null {
  switch (outcome.kind) {
    case 'committed': {
      // The push line rides along with the commit line rather than being a
      // second thing every call site has to remember to print. There are six
      // callers; one that forgot would drop a WARNING on the floor.
      const committed = `  committed to ${repoDisplay}: ${outcome.sha} ${outcome.subject}`;
      const pushed = describePush(outcome.push, repoDisplay);
      return pushed == null ? committed : `${committed}\n${pushed}`;
    }
    // Still silent when there was nothing to say — but a backlog this run
    // pushed, or failed to push, is something to say. Returning null here
    // unconditionally was how the first cut could clear (or fail to clear) a
    // backlog without a word.
    case 'nothing-to-commit':
      return describePush(outcome.push, repoDisplay);
    case 'failed':
      return `⚠️ WARNING: recorded in Dolt, but ${repoDisplay} could NOT be committed (${outcome.command} — ${outcome.detail.slice(0, 200)}). Nothing was lost; \`${SDK_RUN} thread board\` shows what is uncommitted.`;
    case 'disabled':
    case 'skipped-export-unstaged':
      return null;
  }
}
