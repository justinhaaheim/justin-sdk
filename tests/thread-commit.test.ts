/**
 * The tool commits the threads repo itself (home-base-p1uj.11).
 *
 * These run against REAL git in a real temp repo, not a fake: the whole claim
 * being tested is "a commit exists afterwards", and a mocked git would only
 * prove that a function was called. Each assertion below reads the repo back
 * with `git log` / `git status`.
 *
 * NEGATIVE CONTROLS are recorded next to the tests that need them, because an
 * unproven test is no test:
 *
 *   commit-after-write: with `commitThreadsRepo` removed from `runThreadDone`
 *     (the call commented out), "done commits the close" failed on exactly the
 *     line that reads `git log --oneline` back — 1 commit found, 2 expected —
 *     and passed again when restored. Run 2026-09-12.
 *   nothing-to-commit vs failed: with `run(dir, ['add', …])`'s failure branch
 *     changed to `return {kind: 'nothing-to-commit'}`, "a repo that is not a
 *     git repo is a FAILURE, never 'nothing to commit'" failed on the kind
 *     assertion. Restored, it passes. Run 2026-09-12.
 *   the lock: with `acquireCommitLock` changed to `return {path}` without the
 *     O_EXCL open, "the lock is exclusive" failed — the second acquire
 *     succeeded while the first was held. Run 2026-09-12.
 */

import {describe, expect, test} from 'bun:test';
import {execFileSync} from 'child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'fs';
import {mkdirSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {
  acquireCommitLock,
  commitThreadsRepo,
  describeCommit,
  describePush,
  releaseCommitLock,
} from '../src/thread/commit';
import {runThreadDone} from '../src/thread/done';
import {uncommittedLine, unpushedLine} from '../src/thread/board';

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, {cwd: dir, encoding: 'utf8'});
}

/** A real git repo with a real `.beads/issues.jsonl`, committed once. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'threads-commit-'));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  mkdirSync(join(dir, '.beads'), {recursive: true});
  writeFileSync(join(dir, '.beads', 'issues.jsonl'), '{"id":"th-1"}\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'seed']);
  return dir;
}

function appendBead(dir: string, id: string): void {
  const path = join(dir, '.beads', 'issues.jsonl');
  writeFileSync(path, `${readFileSync(path, 'utf8')}{"id":"${id}"}\n`);
}

function logLines(dir: string): string[] {
  return git(dir, ['log', '--oneline'])
    .trim()
    .split('\n')
    .filter((line) => line !== '');
}

/**
 * A REAL remote, as a bare repo on disk (home-base-p1uj.20).
 *
 * A path remote, never github.com: pushing to a path needs no network, which is
 * both what makes these tests hermetic and what makes them runnable inside the
 * Claude Code sandbox, where egress is blocked and a real push would fail with a
 * connection error that proves nothing about the code. It is still git's own
 * push machinery end to end — exit codes, the `! [rejected]` message, the
 * remote-tracking ref update — so what is faked here is the network, not the
 * thing under test.
 */
function addBareRemote(workDir: string): string {
  const bare = mkdtempSync(join(tmpdir(), 'threads-bare-'));
  git(bare, ['init', '-q', '--bare', '-b', 'main', '.']);
  git(workDir, ['remote', 'add', 'origin', bare]);
  return bare;
}

/** Make origin's `main` ahead of `workDir`, so the next push is non-fast-forward. */
function advanceRemote(bare: string): void {
  const clone = mkdtempSync(join(tmpdir(), 'threads-clone-'));
  git(clone, ['clone', '-q', bare, '.']);
  git(clone, ['config', 'user.email', 'other@example.com']);
  git(clone, ['config', 'user.name', 'Other']);
  writeFileSync(join(clone, '.beads', 'issues.jsonl'), '{"id":"th-remote"}\n');
  git(clone, ['commit', '-q', '-am', 'a write from another machine']);
  git(clone, ['push', '-q', 'origin', 'main']);
  rmSync(clone, {force: true, recursive: true});
}

describe('commitThreadsRepo', () => {
  test('a changed JSONL becomes a commit, and the sha comes back', () => {
    const dir = makeRepo();
    try {
      appendBead(dir, 'th-2');
      const outcome = commitThreadsRepo('thread th-2: report #1', {
        autoCommit: true,
        dir,
        env: process.env,
      });
      expect(outcome.kind).toBe('committed');
      if (outcome.kind !== 'committed') throw new Error('unreachable');
      expect(outcome.subject).toBe('thread th-2: report #1');
      expect(outcome.sha).not.toBe('UNKNOWN');

      const log = logLines(dir);
      expect(log.length).toBe(2);
      expect(log[0]).toContain('thread th-2: report #1');
      // MEASURED clean afterwards — the point of the whole feature.
      expect(git(dir, ['status', '--porcelain']).trim()).toBe('');
    } finally {
      rmSync(dir, {force: true, recursive: true});
    }
  });

  test('an unchanged JSONL is nothing-to-commit, and makes NO commit', () => {
    const dir = makeRepo();
    try {
      const outcome = commitThreadsRepo('thread th-1: report #2', {
        autoCommit: true,
        dir,
        env: process.env,
      });
      expect(outcome.kind).toBe('nothing-to-commit');
      expect(logLines(dir).length).toBe(1);
    } finally {
      rmSync(dir, {force: true, recursive: true});
    }
  });

  test('autoCommit false makes no commit and says `disabled`, not `clean`', () => {
    const dir = makeRepo();
    try {
      appendBead(dir, 'th-3');
      const outcome = commitThreadsRepo('thread th-3: report #1', {
        autoCommit: false,
        dir,
        env: process.env,
      });
      expect(outcome.kind).toBe('disabled');
      expect(logLines(dir).length).toBe(1);
      // The distinction is the whole point: the JSONL is still dirty, and
      // `disabled` says so where `nothing-to-commit` would have lied.
      expect(git(dir, ['status', '--porcelain']).trim()).not.toBe('');
    } finally {
      rmSync(dir, {force: true, recursive: true});
    }
  });

  test('a repo that is not a git repo is a FAILURE, never "nothing to commit"', () => {
    const dir = mkdtempSync(join(tmpdir(), 'threads-nogit-'));
    try {
      const outcome = commitThreadsRepo('thread th-9: report #1', {
        autoCommit: true,
        dir,
        env: process.env,
      });
      expect(outcome.kind).toBe('failed');
      if (outcome.kind !== 'failed') throw new Error('unreachable');
      expect(outcome.command).toContain('git add');
      expect(outcome.detail).toContain('not a git repository');
      // And it is LOUD: a failure always produces a line to print.
      expect(describeCommit(outcome, 'the threads repo')).toContain('WARNING');
    } finally {
      rmSync(dir, {force: true, recursive: true});
    }
  });

  test('a known-unwritable .git is SKIPPED rather than spent, and stays silent', () => {
    // bd already told us it could not git-stage; running git would fail the
    // same way. The EXPORT_UNSTAGED warning is the line that gets printed on
    // that path, so this outcome must not add a second one.
    const dir = makeRepo();
    try {
      appendBead(dir, 'th-4');
      const outcome = commitThreadsRepo('thread th-4: report #1', {
        autoCommit: true,
        dir,
        env: process.env,
        exportUnstaged: true,
      });
      expect(outcome.kind).toBe('skipped-export-unstaged');
      expect(logLines(dir).length).toBe(1);
      expect(describeCommit(outcome, 'the threads repo')).toBeNull();
    } finally {
      rmSync(dir, {force: true, recursive: true});
    }
  });

  test('success and no-op print nothing alarming; only failure warns', () => {
    expect(
      describeCommit(
        {kind: 'nothing-to-commit', push: {kind: 'not-ahead'}},
        'the threads repo',
      ),
    ).toBeNull();
    expect(describeCommit({kind: 'disabled'}, 'the threads repo')).toBeNull();
    expect(
      describeCommit(
        {
          kind: 'committed',
          push: {kind: 'no-remote'},
          sha: 'abc1234',
          subject: 'thread th-1: start',
        },
        'the threads repo',
      ),
    ).toContain('abc1234');
  });
});

/**
 * THE PUSH (home-base-p1uj.20, D22).
 *
 * NEGATIVE CONTROLS, all six run 2026-09-15: each broke one line, watched the
 * named assertion fail, and restored the line. Verbatim results:
 *
 *   a push that claims success and does nothing — `['push', '--quiet',
 *     PUSH_REMOTE, 'HEAD']` swapped for `['rev-parse', 'HEAD']`, so the outcome
 *     still says `pushed`. "a committed write reaches origin" failed on the
 *     BARE REPO's log: `Expected to contain: "thread th-10: report #1" /
 *     Received: "3433564 seed\n"`. That is why these assert against the remote
 *     and not against the return value.
 *   a refused push reported as a success — `if (!pushed.ok)` weakened to
 *     `if (false)`. "a refused push is ONE warning" failed with
 *     `Expected: "failed" / Received: "pushed"`.
 *   an absent origin treated as breakage — `remote.status === 1` changed to
 *     `=== 99`. "no origin: nothing is attempted" failed with
 *     `Expected: "no-remote" / Received: "failed"`.
 *   the knob ignored — `if (!autoPush)` weakened to `if (false)`. "autoPush
 *     false pushes NOTHING" failed with `Expected: "disabled" / Received:
 *     "pushed"`.
 *   the board's backlog line suppressed — `if (count === 0) return null`
 *     changed to `if (count >= 0) return null`. TWO tests failed: "names the
 *     backlog when a push did NOT happen" on `expect(received).not.toBeNull() /
 *     Received: null`, and the knob-off test on its board assertion.
 *   a refused push made non-zero — `runThreadDone` changed to
 *     `if (…push.kind === 'failed') return 1`. "a REFUSED push still exits 0"
 *     failed with `Expected: 0 / Received: 1`, while its sibling stayed green.
 *
 * Three more for the ahead-of-origin change (conductor review), run the same
 * way on 2026-09-15:
 *
 *   the no-op path stops pushing a backlog — the `nothing-to-commit` branch put
 *     back to `push: {kind: 'not-ahead'}`, i.e. the pre-review behaviour. TWO
 *     tests failed: "a BACKLOG is pushed" with `Expected: "pushed" / Received:
 *     "not-ahead"`, and "a backlog that CANNOT be pushed still warns" with
 *     `Expected: "failed" / Received: "not-ahead"`.
 *   the level short-circuit removed — `if (ahead.kind === 'level')` weakened to
 *     `if (false)`, so a repo level with origin hits the network anyway. "NO
 *     push is attempted" failed with `Expected: "not-ahead" / Received:
 *     "pushed"`.
 */
describe('pushing after a commit', () => {
  test('a committed write reaches origin, and the branch is level again', () => {
    const dir = makeRepo();
    const bare = addBareRemote(dir);
    try {
      git(dir, ['push', '-q', 'origin', 'HEAD']);
      appendBead(dir, 'th-10');
      const outcome = commitThreadsRepo('thread th-10: report #1', {
        autoCommit: true,
        autoPush: true,
        dir,
        env: process.env,
      });
      expect(outcome.kind).toBe('committed');
      if (outcome.kind !== 'committed') throw new Error('unreachable');
      expect(outcome.push.kind).toBe('pushed');

      // ASSERTED ON THE REMOTE, not on the return value: the claim is that the
      // commit is somewhere other than this laptop.
      expect(git(bare, ['log', '--oneline'])).toContain(
        'thread th-10: report #1',
      );
      // And the ACCEPTANCE property itself — 0 ahead of origin afterwards.
      expect(
        git(dir, ['rev-list', '--count', 'origin/main..HEAD']).trim(),
      ).toBe('0');
      expect(unpushedLine(process.env, dir)).toBeNull();
    } finally {
      rmSync(dir, {force: true, recursive: true});
      rmSync(bare, {force: true, recursive: true});
    }
  });

  test('a refused push is ONE warning, exit-code-neutral, and loses nothing', () => {
    const dir = makeRepo();
    const bare = addBareRemote(dir);
    try {
      git(dir, ['push', '-q', 'origin', 'HEAD']);
      advanceRemote(bare);
      appendBead(dir, 'th-11');
      const outcome = commitThreadsRepo('thread th-11: report #1', {
        autoCommit: true,
        autoPush: true,
        dir,
        env: process.env,
      });
      // The COMMIT still succeeded. A refused push must never be readable as a
      // failed write — that conflation is p1uj.10's bug wearing a new hat.
      expect(outcome.kind).toBe('committed');
      if (outcome.kind !== 'committed') throw new Error('unreachable');
      expect(outcome.push.kind).toBe('failed');
      if (outcome.push.kind !== 'failed') throw new Error('unreachable');
      expect(outcome.push.command).toContain('git push');
      // It NAMES the git error rather than saying "push failed".
      expect(outcome.push.detail).toContain('rejected');

      const line = describeCommit(outcome, 'the threads repo');
      expect(line).not.toBeNull();
      expect((line ?? '').match(/WARNING/g)?.length).toBe(1);
      expect(line).toContain('rejected');
      // The commit is still here, and the warning says so.
      expect(line).toContain('Nothing was lost');
      expect(logLines(dir).length).toBe(2);
      expect(git(dir, ['status', '--porcelain']).trim()).toBe('');
    } finally {
      rmSync(dir, {force: true, recursive: true});
      rmSync(bare, {force: true, recursive: true});
    }
  });

  test('no origin: nothing is attempted and nothing is printed', () => {
    const dir = makeRepo();
    try {
      appendBead(dir, 'th-12');
      const outcome = commitThreadsRepo('thread th-12: report #1', {
        autoCommit: true,
        autoPush: true,
        dir,
        env: process.env,
      });
      expect(outcome.kind).toBe('committed');
      if (outcome.kind !== 'committed') throw new Error('unreachable');
      // MEASURED absence, not a failure: a threads repo with no remote never
      // promised a push, so it must not warn on every single write.
      expect(outcome.push.kind).toBe('no-remote');
      const line = describeCommit(outcome, 'the threads repo');
      expect(line).not.toContain('WARNING');
      expect(line).not.toContain('push');
      expect(unpushedLine(process.env, dir)).toBeNull();
    } finally {
      rmSync(dir, {force: true, recursive: true});
    }
  });

  test('autoPush false pushes NOTHING, and the board still names the backlog', () => {
    const dir = makeRepo();
    const bare = addBareRemote(dir);
    try {
      git(dir, ['push', '-q', 'origin', 'HEAD']);
      appendBead(dir, 'th-13');
      const outcome = commitThreadsRepo('thread th-13: report #1', {
        autoCommit: true,
        autoPush: false,
        dir,
        env: process.env,
      });
      expect(outcome.kind).toBe('committed');
      if (outcome.kind !== 'committed') throw new Error('unreachable');
      expect(outcome.push.kind).toBe('disabled');
      expect(describeCommit(outcome, 'the threads repo')).not.toContain('push');
      // The remote still has only the seed.
      expect(logLines(bare).length).toBe(1);

      // THE KNOB DOES NOT SILENCE THE BOARD. How much of this exists only on
      // this laptop is a fact about the repo, not about a setting.
      const line = unpushedLine(process.env, dir);
      expect(line).toContain('1 commit ahead of origin/main');
      expect(line).toContain('did NOT happen');
    } finally {
      rmSync(dir, {force: true, recursive: true});
      rmSync(bare, {force: true, recursive: true});
    }
  });

  test('a BACKLOG is pushed even when this run has nothing to commit', () => {
    // The real ~/Dev/threads on 2026-09-15: a commit the tool made before
    // autoPush existed, sitting unpushed. Before the conductor's review this
    // run would have returned `nothing-to-commit` and left it there, so
    // "0 ahead after every write" was false in exactly the case the feature is
    // for.
    // NEGATIVE CONTROL (2026-09-15): with the `nothing-to-commit` branch put
    // back to `return {kind: 'nothing-to-commit', push: {kind: 'not-ahead'}}`,
    // this failed on `push.kind` (not-ahead vs pushed) AND on the bare repo's
    // log, which never received the backlog commit.
    const dir = makeRepo();
    const bare = addBareRemote(dir);
    try {
      git(dir, ['push', '-q', 'origin', 'HEAD']);
      appendBead(dir, 'th-30');
      git(dir, ['commit', '-q', '-am', 'thread th-30: an unpushed write']);
      expect(git(bare, ['log', '--oneline'])).not.toContain('th-30');

      const outcome = commitThreadsRepo('thread th-30: report #2', {
        autoCommit: true,
        autoPush: true,
        dir,
        env: process.env,
      });
      expect(outcome.kind).toBe('nothing-to-commit');
      if (outcome.kind !== 'nothing-to-commit') throw new Error('unreachable');
      expect(outcome.push.kind).toBe('pushed');

      expect(git(bare, ['log', '--oneline'])).toContain(
        'thread th-30: an unpushed write',
      );
      expect(unpushedLine(process.env, dir)).toBeNull();
    } finally {
      rmSync(dir, {force: true, recursive: true});
      rmSync(bare, {force: true, recursive: true});
    }
  });

  test('level with origin and nothing to commit: NO push is attempted', () => {
    // The network cost of the no-op path is the whole reason the ahead check is
    // local. `not-ahead` is a measurement, not a shrug — it is what says the
    // network was skipped because there was nothing to send.
    // NEGATIVE CONTROL (2026-09-15): with `if (ahead.kind === 'level') return
    // {kind: 'not-ahead'}` removed from `pushIfAhead`, this failed on
    // `push.kind` with `Expected: "not-ahead" / Received: "pushed"`.
    const dir = makeRepo();
    const bare = addBareRemote(dir);
    try {
      git(dir, ['push', '-q', 'origin', 'HEAD']);
      const outcome = commitThreadsRepo('thread th-31: report #2', {
        autoCommit: true,
        autoPush: true,
        dir,
        env: process.env,
      });
      expect(outcome.kind).toBe('nothing-to-commit');
      if (outcome.kind !== 'nothing-to-commit') throw new Error('unreachable');
      expect(outcome.push.kind).toBe('not-ahead');
      expect(describeCommit(outcome, 'the threads repo')).toBeNull();
    } finally {
      rmSync(dir, {force: true, recursive: true});
      rmSync(bare, {force: true, recursive: true});
    }
  });

  test('a backlog that CANNOT be pushed still warns from the no-op path', () => {
    const dir = makeRepo();
    const bare = addBareRemote(dir);
    try {
      git(dir, ['push', '-q', 'origin', 'HEAD']);
      appendBead(dir, 'th-32');
      git(dir, ['commit', '-q', '-am', 'thread th-32: an unpushed write']);
      advanceRemote(bare);

      const outcome = commitThreadsRepo('thread th-32: report #2', {
        autoCommit: true,
        autoPush: true,
        dir,
        env: process.env,
      });
      expect(outcome.kind).toBe('nothing-to-commit');
      if (outcome.kind !== 'nothing-to-commit') throw new Error('unreachable');
      expect(outcome.push.kind).toBe('failed');
      // Silence here is what the first cut did, and it is how a backlog goes on
      // failing to leave the laptop without ever saying so. Its negative
      // control is the first of the three recorded above.
      const line = describeCommit(outcome, 'the threads repo');
      expect((line ?? '').match(/WARNING/g)?.length).toBe(1);
      expect(line).toContain('rejected');
    } finally {
      rmSync(dir, {force: true, recursive: true});
      rmSync(bare, {force: true, recursive: true});
    }
  });

  test('describePush: only a failure warns; absence and the knob are silent', () => {
    expect(describePush({kind: 'no-remote'}, 'the threads repo')).toBeNull();
    expect(describePush({kind: 'disabled'}, 'the threads repo')).toBeNull();
    expect(describePush({kind: 'not-ahead'}, 'the threads repo')).toBeNull();
    expect(
      describePush({kind: 'pushed', remote: 'origin'}, 'the threads repo'),
    ).toContain('origin');
    expect(
      describePush(
        {
          command: 'git push origin HEAD',
          detail: 'auth failed',
          kind: 'failed',
        },
        'the threads repo',
      ),
    ).toContain('WARNING');
  });
});

describe('the commit lock', () => {
  test('is exclusive, and releasing it lets the next caller in', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'threads-lock-'));
    try {
      const first = acquireCommitLock(stateDir);
      expect(first).not.toBeNull();
      // A second acquire cannot take it while this process holds it. It waits
      // out its attempts (~2s) and returns null rather than stealing: the
      // owner pid is alive, which is measured, not assumed.
      const started = Date.now();
      const second = acquireCommitLock(stateDir);
      expect(second).toBeNull();
      expect(Date.now() - started).toBeGreaterThan(500);

      releaseCommitLock(first);
      const third = acquireCommitLock(stateDir);
      expect(third).not.toBeNull();
      releaseCommitLock(third);
    } finally {
      rmSync(stateDir, {force: true, recursive: true});
    }
  });

  test('a lock left by a DEAD owner is reclaimed, not waited on forever', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'threads-lock-dead-'));
    try {
      // pid 0x7FFFFFFF is not a running process on macOS or Linux; `kill(0)`
      // on it raises ESRCH, which is the MEASURED-gone answer the reclaim
      // requires. (An unreadable or unparseable pid file is left alone.)
      writeFileSync(join(stateDir, 'threads-commit.lock'), '2147483647');
      const started = Date.now();
      const handle = acquireCommitLock(stateDir);
      expect(handle).not.toBeNull();
      expect(Date.now() - started).toBeLessThan(1000);
      releaseCommitLock(handle);
    } finally {
      rmSync(stateDir, {force: true, recursive: true});
    }
  });
});

describe("the board's uncommitted line", () => {
  test('is null when clean — the tool commits, so silence is correct', () => {
    const dir = makeRepo();
    try {
      expect(uncommittedLine(process.env, dir)).toBeNull();
    } finally {
      rmSync(dir, {force: true, recursive: true});
    }
  });

  test('names the dirty file when a commit did NOT happen', () => {
    const dir = makeRepo();
    try {
      appendBead(dir, 'th-5');
      const line = uncommittedLine(process.env, dir);
      expect(line).not.toBeNull();
      expect(line).toContain('UNCOMMITTED changes');
      expect(line).toContain(dir);
    } finally {
      rmSync(dir, {force: true, recursive: true});
    }
  });

  test('says UNKNOWN, never "clean", when git cannot be read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'threads-nogit-'));
    try {
      const line = uncommittedLine(process.env, dir);
      expect(line).toContain('UNKNOWN');
      expect(line).not.toContain('no uncommitted');
    } finally {
      rmSync(dir, {force: true, recursive: true});
    }
  });
});

describe("the board's unpushed line", () => {
  test('names the backlog when a push did NOT happen', () => {
    const dir = makeRepo();
    const bare = addBareRemote(dir);
    try {
      git(dir, ['push', '-q', 'origin', 'HEAD']);
      appendBead(dir, 'th-20');
      git(dir, ['commit', '-q', '-am', 'a write nobody pushed']);
      const line = unpushedLine(process.env, dir);
      expect(line).not.toBeNull();
      expect(line).toContain('1 commit ahead of origin/main');
      expect(line).toContain(dir);
      expect(line).toContain('git push');
    } finally {
      rmSync(dir, {force: true, recursive: true});
      rmSync(bare, {force: true, recursive: true});
    }
  });

  test('pluralises, because "1 commits" reads as a bug in the tool', () => {
    const dir = makeRepo();
    const bare = addBareRemote(dir);
    try {
      git(dir, ['push', '-q', 'origin', 'HEAD']);
      appendBead(dir, 'th-21');
      git(dir, ['commit', '-q', '-am', 'one']);
      appendBead(dir, 'th-22');
      git(dir, ['commit', '-q', '-am', 'two']);
      expect(unpushedLine(process.env, dir)).toContain('2 commits ahead');
    } finally {
      rmSync(dir, {force: true, recursive: true});
      rmSync(bare, {force: true, recursive: true});
    }
  });

  test('is null with no origin — there is nothing to be ahead of', () => {
    const dir = makeRepo();
    try {
      expect(unpushedLine(process.env, dir)).toBeNull();
    } finally {
      rmSync(dir, {force: true, recursive: true});
    }
  });

  test('says UNKNOWN, never 0, when the branch has never been pushed', () => {
    const dir = makeRepo();
    const bare = addBareRemote(dir);
    try {
      // origin exists, origin/main does not. "Nothing is waiting" would be the
      // reassuring reading and it would be wrong: everything is waiting.
      const line = unpushedLine(process.env, dir);
      expect(line).toContain('UNKNOWN');
      expect(line).toContain('never been pushed');
    } finally {
      rmSync(dir, {force: true, recursive: true});
      rmSync(bare, {force: true, recursive: true});
    }
  });

  test('says UNKNOWN, never 0, on a detached HEAD', () => {
    const dir = makeRepo();
    const bare = addBareRemote(dir);
    try {
      git(dir, ['push', '-q', 'origin', 'HEAD']);
      git(dir, ['checkout', '-q', '--detach']);
      const line = unpushedLine(process.env, dir);
      expect(line).toContain('UNKNOWN');
      expect(line).toContain('no branch to compare');
    } finally {
      rmSync(dir, {force: true, recursive: true});
      rmSync(bare, {force: true, recursive: true});
    }
  });
});

describe('a write batch commits without a manual step', () => {
  test('done closes the thread AND leaves a commit', async () => {
    const dir = makeRepo();
    try {
      // The bd half is faked through `deps`; what is real here is that after a
      // successful close, the repo has one more commit than it did before.
      // NEGATIVE CONTROL (2026-09-12): commenting out the commitThreadsRepo
      // call in runThreadDone made this fail at `log.length` with 1 vs 2.
      const deps = {
        closeIssue: async () => {
          appendBead(dir, 'th-6');
          return {ok: true as const, value: true as const};
        },
        listOpenAsks: async () => ({ok: true as const, value: []}),
        reopenIssue: async () => ({ok: true as const, value: true as const}),
        resolveThread: async () => ({
          issue: {id: 'th-6', title: 'a thread'},
          ok: true as const,
        }),
      };
      const code = await runThreadDone({
        autoCommit: true,
        deps,
        env: {...process.env, JUSTIN_THREADS_REPO_DIR: dir},
        threadId: 'th-6',
      });
      expect(code).toBe(0);
      const log = logLines(dir);
      expect(log.length).toBe(2);
      expect(log[0]).toContain('thread th-6: closed');
    } finally {
      rmSync(dir, {force: true, recursive: true});
    }
  });

  test('a REFUSED push still exits 0 — the write happened (D22)', async () => {
    // The acceptance sentence, at the command layer rather than the function
    // layer: a push that git rejects must not turn a recorded report into a
    // non-zero exit, because the exit code is what the wrap-up rule reads to
    // decide whether anything was lost.
    // NEGATIVE CONTROL (2026-09-15): with `runThreadDone` changed to keep the
    // commit outcome and `return 1` when its `push.kind === 'failed'`, this
    // failed with `Expected: 0 / Received: 1` while the sibling test above
    // stayed green.
    const dir = makeRepo();
    const bare = addBareRemote(dir);
    try {
      git(dir, ['push', '-q', 'origin', 'HEAD']);
      advanceRemote(bare);
      const deps = {
        closeIssue: async () => {
          appendBead(dir, 'th-7');
          return {ok: true as const, value: true as const};
        },
        listOpenAsks: async () => ({ok: true as const, value: []}),
        reopenIssue: async () => ({ok: true as const, value: true as const}),
        resolveThread: async () => ({
          issue: {id: 'th-7', title: 'a thread'},
          ok: true as const,
        }),
      };
      const code = await runThreadDone({
        autoCommit: true,
        deps,
        env: {...process.env, JUSTIN_THREADS_REPO_DIR: dir},
        threadId: 'th-7',
      });
      expect(code).toBe(0);
      expect(logLines(dir).length).toBe(2);
      // The remote refused, so it still has only the other machine's write.
      expect(git(bare, ['log', '--oneline'])).not.toContain('thread th-7');
    } finally {
      rmSync(dir, {force: true, recursive: true});
      rmSync(bare, {force: true, recursive: true});
    }
  });
});
