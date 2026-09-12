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
  releaseCommitLock,
} from '../src/thread/commit';
import {runThreadDone} from '../src/thread/done';
import {uncommittedLine} from '../src/thread/board';

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
      describeCommit({kind: 'nothing-to-commit'}, 'the threads repo'),
    ).toBeNull();
    expect(describeCommit({kind: 'disabled'}, 'the threads repo')).toBeNull();
    expect(
      describeCommit(
        {kind: 'committed', sha: 'abc1234', subject: 'thread th-1: start'},
        'the threads repo',
      ),
    ).toContain('abc1234');
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
});
