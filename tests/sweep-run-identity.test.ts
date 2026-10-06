/**
 * home-base-39co9.6 — a name per run, fetch first, leftovers reported rather
 * than blocking, a log from the start, and unpushed work that fails the run.
 *
 * The end-to-end tests run the REAL orchestrator against the hermetic fixture
 * from sweep-e2e-fixtures.ts, plus a bare repo playing "origin" and a second
 * clone playing "another machine" — the browser-automation-central shape of
 * 2026-10-05 (local main 9 behind, push rejected, local main left diverged).
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {spawn} from 'child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import {join} from 'path';

import {deriveBeadsPrefix} from '../src/beads-setup';
import {
  addSweepWorktree,
  isSweepWorktreeName,
  LEGACY_SWEEP_NAME,
  planFreshBase,
  runSweep,
  SWEEP_WORKTREES_DIR,
  sweepBranchFor,
  sweepRunNames,
  sweepRunStamp,
  type UpstreamComparison,
} from '../src/sweep';
import {git} from './git-fixtures';
import {createSandbox, type Sandbox} from './sandbox';
import {
  captureLog,
  e2eRepo,
  expectNoSweepRemains,
  sweepRemains,
} from './sweep-e2e-fixtures';

const sandboxes: Sandbox[] = [];
function track(sb: Sandbox): Sandbox {
  sandboxes.push(sb);
  return sb;
}
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

/** A value the test needs, or a failure that names it — instead of `!`. */
function must<T>(value: T | null | undefined, what: string): T {
  if (value == null) throw new Error(`missing: ${what}`);
  return value;
}

/** Each e2e run installs two file: deps and runs both gates twice. */
const E2E_TIMEOUT = 60_000;

// ---------------------------------------------------------------------------
// Fixtures: an origin, and another machine pushing to it
// ---------------------------------------------------------------------------

/** Give `repo` a bare origin, push main there, and track it. Returns the bare path. */
function withOrigin(sb: Sandbox, repo: string, name: string): string {
  const bare = join(sb.path, `${name}-origin.git`);
  git(sb.path, ['init', '-q', '--bare', '-b', 'main', bare]);
  git(repo, ['remote', 'add', 'origin', bare]);
  git(repo, ['push', '-q', '-u', 'origin', 'main']);
  return bare;
}

/** A second clone of `bare` — "another machine" that pushes to it. */
function elsewhere(sb: Sandbox, bare: string, name: string): string {
  const clone = join(sb.path, `${name}-elsewhere`);
  git(sb.path, ['clone', '-q', bare, clone]);
  git(clone, ['config', 'user.email', 'other@example.com']);
  git(clone, ['config', 'user.name', 'Other']);
  return clone;
}

function commitAndPush(clone: string, file: string, subject: string): void {
  writeFileSync(join(clone, file), `${subject}\n`);
  git(clone, ['add', '-A']);
  git(clone, ['commit', '-qm', subject]);
  git(clone, ['push', '-q', 'origin', 'HEAD:main']);
}

/** Install `body` as `repo`'s post-commit hook — it runs inside the sweep's commit. */
function postCommitHook(sb: Sandbox, repo: string, body: string): void {
  const hooks = join(sb.path, `${repo.split('/').pop() ?? 'repo'}-hooks`);
  mkdirSync(hooks, {recursive: true});
  writeFileSync(join(hooks, 'post-commit'), `#!/bin/sh\n${body}\n`);
  chmodSync(join(hooks, 'post-commit'), 0o755);
  git(repo, ['config', 'core.hooksPath', hooks]);
}

function sha(repo: string, ref: string): string {
  return git(repo, ['rev-parse', ref]).trim();
}

/** The summary section of a run's output (everything after "Summary"). */
function summaryOf(out: string): string {
  return out.slice(out.lastIndexOf('Summary'));
}

// ---------------------------------------------------------------------------
// S1 — the run's own name
// ---------------------------------------------------------------------------

describe('S1: each run names its branch and worktree with its stamp', () => {
  test('the stamp is the run-log stamp, and names the branch and worktree', () => {
    const stamp = sweepRunStamp(new Date('2026-10-05T14:03:22.123Z'));
    expect(stamp).toBe('2026-10-05T14-03-22.123Z');
    expect(sweepRunNames(stamp)).toEqual({
      branch: 'worktree-sdk-sweep-2026-10-05T14-03-22.123Z',
      name: 'sdk-sweep-2026-10-05T14-03-22.123Z',
      worktreeSegments: [
        '.claude',
        'worktrees',
        'sdk-sweep-2026-10-05T14-03-22.123Z',
      ],
    });
  });

  test('the stamped branch is a valid git ref name', () => {
    const sb = track(createSandbox());
    const repo = e2eRepo(sb, 'refname');
    const {branch} = sweepRunNames(sweepRunStamp(new Date()));
    expect(() =>
      git(repo, ['check-ref-format', '--branch', branch]),
    ).not.toThrow();
  });

  test('only names the sweep made are recognised as its leftovers', () => {
    expect(isSweepWorktreeName(LEGACY_SWEEP_NAME)).toBe(true);
    expect(isSweepWorktreeName('sdk-sweep-2026-10-05T14-03-22.123Z')).toBe(
      true,
    );
    // A person's own worktree must never be mistaken for one (the scan may
    // auto-remove what it recognises, when it is provably empty).
    expect(isSweepWorktreeName('sdk-sweep-notes')).toBe(false);
    expect(isSweepWorktreeName('sdk-sweep-2026-10-05')).toBe(false);
    expect(isSweepWorktreeName('my-sdk-sweep')).toBe(false);
  });

  test('a beads prefix is still derived from the REPO in a stamped worktree, not the worktree name', () => {
    const sb = track(createSandbox());
    const repo = e2eRepo(sb, 'my-real-repo');
    const names = sweepRunNames(sweepRunStamp(new Date()));
    const path = join(repo, ...names.worktreeSegments);
    git(repo, ['worktree', 'add', '-q', '-b', names.branch, path, 'main']);

    const derived = deriveBeadsPrefix(path);
    expect(derived).toMatchObject({ok: true, prefix: 'my-real-repo'});
    // Negative control in-line: the worktree's own basename would differ.
    expect(path.split('/').pop()).not.toBe('my-real-repo');
  });

  test('a taken name is refused and NOTHING is removed (no salvage of another run)', () => {
    const sb = track(createSandbox());
    const repo = e2eRepo(sb, 'collision');
    const names = sweepRunNames('2026-10-05T14-03-22.123Z');
    // Another run's branch, already holding a commit, under the same name.
    git(repo, ['branch', names.branch, 'main']);
    const other = join(sb.path, 'other-wt');
    git(repo, ['worktree', 'add', '-q', other, names.branch]);
    writeFileSync(join(other, 'work.txt'), 'theirs\n');
    git(other, ['add', '-A']);
    git(other, ['commit', '-qm', 'another run, same millisecond']);
    // Its worktree is gone and the branch is checked out NOWHERE — the shape in
    // which git would let a salvage `branch -D` it. (Measured: with the branch
    // still checked out, git refuses the delete, and an unguarded add only
    // survived by that accident.)
    git(repo, ['worktree', 'remove', other]);
    const theirs = sha(repo, names.branch);

    const result = addSweepWorktree(
      repo,
      join(repo, ...names.worktreeSegments),
      names.branch,
      sha(repo, 'main'),
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('already taken');
    expect(sha(repo, names.branch)).toBe(theirs);
  });
});

// ---------------------------------------------------------------------------
// S5 — the fresh-base decision, as a table
// ---------------------------------------------------------------------------

describe('planFreshBase (S5)', () => {
  const compared = (
    localOnly: string[],
    remoteOnly: string[],
  ): UpstreamComparison => ({
    kind: 'compared',
    localOnly,
    remoteOnly,
    upstream: 'origin/main',
    upstreamSha: 'f'.repeat(40),
  });
  const plan = (
    comparison: UpstreamComparison,
    primaryBranch: string | null = 'main',
    primaryTrackedClean: boolean | null = true,
  ) =>
    planFreshBase({
      comparison,
      defaultBranch: 'main',
      primaryBranch,
      primaryTrackedClean,
      repo: '/r',
    });

  test('up to date proceeds silently', () => {
    expect(plan(compared([], []))).toEqual({kind: 'proceed', note: null});
  });

  test('strictly behind, on main, clean → fast-forward', () => {
    expect(plan(compared([], ['b1 one', 'b2 two']))).toMatchObject({
      kind: 'fast-forward',
      upstreamSha: 'f'.repeat(40),
    });
  });

  test('strictly behind but on another branch, dirty, or unreadable → COULD NOT SWEEP', () => {
    for (const [branch, clean, words] of [
      ['feature', true, 'is on feature'],
      [null, true, 'detached HEAD'],
      ['main', false, 'uncommitted changes to tracked files'],
      ['main', null, 'could not be read'],
    ] as const) {
      const verdict = plan(compared([], ['b1 one']), branch, clean);
      expect(verdict.kind).toBe('block');
      if (verdict.kind === 'block') {
        expect(verdict.reason).toContain(words);
        expect(verdict.reason).toContain('b1 one');
      }
    }
  });

  test('diverged → COULD NOT SWEEP with BOTH commit lists', () => {
    const verdict = plan(compared(['l1 mine'], ['r1 theirs', 'r2 theirs']));
    expect(verdict.kind).toBe('block');
    if (verdict.kind !== 'block') return;
    expect(verdict.reason).toContain('DIVERGED');
    expect(verdict.reason).toContain('only on main (1):');
    expect(verdict.reason).toContain('l1 mine');
    expect(verdict.reason).toContain('only on origin/main (2):');
    expect(verdict.reason).toContain('r2 theirs');
  });

  test('ahead only proceeds, and says the push will publish those commits', () => {
    const verdict = plan(compared(['l1 mine'], []));
    expect(verdict.kind).toBe('proceed');
    expect(verdict.kind === 'proceed' ? verdict.note : null).toContain(
      '1 commit(s) ahead',
    );
  });

  test('an UNKNOWN comparison is refused, never assumed fresh (rule 7)', () => {
    expect(
      plan({
        detail: '`git fetch origin` failed',
        kind: 'unknown',
        output: null,
      }),
    ).toMatchObject({kind: 'block'});
  });

  test('no upstream proceeds with a note', () => {
    const verdict = plan({
      detail: 'main tracks no upstream — nothing fetched',
      kind: 'no-upstream',
    });
    expect(verdict.kind).toBe('proceed');
    expect(verdict.kind === 'proceed' ? verdict.note : null).toContain(
      'no upstream',
    );
  });
});

// ---------------------------------------------------------------------------
// AC3 — fetch first, end to end
// ---------------------------------------------------------------------------

describe('fetch first, end to end (S5, AC3)', () => {
  test(
    'a local main strictly BEHIND origin is fast-forwarded first, and the push lands cleanly',
    async () => {
      const sb = track(createSandbox());
      const repo = e2eRepo(sb, 'behind');
      const bare = withOrigin(sb, repo, 'behind');
      const other = elsewhere(sb, bare, 'behind');
      commitAndPush(other, 'remote-1.txt', 'pushed from elsewhere 1');
      commitAndPush(other, 'remote-2.txt', 'pushed from elsewhere 2');

      const {out, value} = await captureLog(() =>
        runSweep({
          component: 'gitignore',
          logDir: join(sb.path, 'logs'),
          repos: [repo],
        }),
      );

      expect(value).toBe(0);
      expect(out).toContain(
        'main was 2 commit(s) behind origin/main — fast-forwarded before branching',
      );
      expect(out).toContain('merged into main, pushed');
      // Local and origin agree, and origin holds both remote commits AND the
      // sweep commit on top of them.
      expect(sha(repo, 'main')).toBe(sha(bare, 'main'));
      const originLog = git(bare, ['log', '--format=%s', 'main']);
      expect(originLog).toContain('pushed from elsewhere 2');
      expect(originLog.split('\n')[0]).toContain('chore(sdk): sweep gitignore');
      expectNoSweepRemains(repo);
    },
    E2E_TIMEOUT,
  );

  test(
    'DIVERGED: COULD NOT SWEEP up front, both commit lists printed, no worktree created',
    async () => {
      const sb = track(createSandbox());
      const repo = e2eRepo(sb, 'diverged');
      const bare = withOrigin(sb, repo, 'diverged');
      commitAndPush(
        elsewhere(sb, bare, 'diverged'),
        'r.txt',
        'only on the remote',
      );
      writeFileSync(join(repo, 'l.txt'), 'local\n');
      git(repo, ['add', '-A']);
      git(repo, ['commit', '-qm', 'only on local main']);
      const before = sha(repo, 'main');

      const {out, value} = await captureLog(() =>
        runSweep({
          component: 'gitignore',
          logDir: join(sb.path, 'logs'),
          repos: [repo],
        }),
      );

      expect(value).toBe(1);
      expect(out).toContain('COULD NOT SWEEP: diverged');
      expect(out).toContain('main and origin/main have DIVERGED');
      expect(out).toContain('only on local main');
      expect(out).toContain('only on the remote');
      // No work at all: no worktree, no branch, main untouched, nothing hydrated.
      expectNoSweepRemains(repo);
      expect(sha(repo, 'main')).toBe(before);
      expect(out).not.toContain('baseline:');
    },
    E2E_TIMEOUT,
  );

  test(
    'behind, but the primary has tracked changes: COULD NOT SWEEP, and the checkout is not moved',
    async () => {
      const sb = track(createSandbox());
      const repo = e2eRepo(sb, 'behind-dirty');
      const bare = withOrigin(sb, repo, 'behind-dirty');
      commitAndPush(
        elsewhere(sb, bare, 'behind-dirty'),
        'r.txt',
        'newer upstream',
      );
      writeFileSync(join(repo, 'package.json'), '{"name":"edited"}\n');
      const before = sha(repo, 'main');

      const {out, value} = await captureLog(() =>
        runSweep({
          component: 'gitignore',
          logDir: join(sb.path, 'logs'),
          repos: [repo],
        }),
      );

      expect(value).toBe(1);
      expect(out).toContain('1 commit(s) behind origin/main');
      expect(out).toContain('uncommitted changes to tracked files');
      expect(sha(repo, 'main')).toBe(before);
      expectNoSweepRemains(repo);
    },
    E2E_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// AC4 / S6 / S7 — a push rejected after the local merge
// ---------------------------------------------------------------------------

describe('a push rejected after the local merge is a red step (S6, S7, AC4)', () => {
  test(
    'origin moves DURING the run: PUSH FAILED, counted, exit 1, recovery steps, evidence logged',
    async () => {
      const sb = track(createSandbox());
      const repo = e2eRepo(sb, 'raced');
      const bare = withOrigin(sb, repo, 'raced');
      const other = elsewhere(sb, bare, 'raced');
      // The race, made deterministic: the sweep's own commit fires this hook
      // (--no-verify skips pre-commit, not post-commit), which pushes from
      // "another machine" AFTER the sweep fetched and BEFORE it pushes.
      postCommitHook(
        sb,
        repo,
        [
          'unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_PREFIX GIT_COMMON_DIR',
          `cd '${other}' || exit 0`,
          'echo raced >> raced.txt',
          'git add -A',
          "git commit -qm 'pushed from elsewhere mid-sweep'",
          'git push -q origin HEAD:main',
        ].join('\n'),
      );
      const before = sha(repo, 'main');

      const {out, value} = await captureLog(() =>
        runSweep({
          component: 'gitignore',
          logDir: join(sb.path, 'logs'),
          repos: [repo],
        }),
      );

      expect(value).toBe(1);
      const summary = summaryOf(out);
      expect(summary).toContain('PUSH FAILED');
      expect(summary).toContain('1 push-failed');
      expect(summary).toContain('MERGED LOCALLY BUT NOT PUSHED: raced');
      // The recovery steps name the sweep commit and the pre-merge sha.
      const sweepCommit = sha(repo, 'main');
      expect(summary).toContain(`sweep commit ${sweepCommit.slice(0, 12)}`);
      expect(summary).toContain(`git -C ${repo} pull --rebase`);
      expect(summary).toContain(
        `git -C ${repo} reset --keep ${before.slice(0, 12)}`,
      );
      // The state the steps describe is the real one: local main holds the
      // sweep commit, origin holds the other machine's, neither has both.
      expect(git(repo, ['show', 'main:.gitignore'])).toContain(
        'justin-sdk baseline',
      );
      expect(git(bare, ['log', '--format=%s', '-1', 'main'])).toContain(
        'pushed from elsewhere mid-sweep',
      );
      // Evidence in the log: the push step with git's own rejection.
      const logPath = /failure log: (\S+\.log)/.exec(out)?.[1];
      const written = readFileSync(
        must(logPath, 'log path in the output'),
        'utf-8',
      );
      expect(written).toContain('raced · step: push');
      expect(written).toMatch(/rejected|non-fast-forward|fetch first/);
      expectNoSweepRemains(repo);
    },
    E2E_TIMEOUT,
  );

  test(
    'a repo with NO remote is still a success (S7)',
    async () => {
      const sb = track(createSandbox());
      const repo = e2eRepo(sb, 'no-remote');

      const {out, value} = await captureLog(() =>
        runSweep({
          component: 'gitignore',
          logDir: join(sb.path, 'logs'),
          repos: [repo],
        }),
      );

      expect(value).toBe(0);
      expect(out).toContain('merged into main, no remote');
      expect(out).toContain('main tracks no upstream — nothing fetched');
    },
    E2E_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// AC1 / AC2 / S2 / S3 — leftovers are listed, never blocking, never deleted with work
// ---------------------------------------------------------------------------

/** A leftover as an earlier run left it: a worktree + branch under `name`, holding one commit. */
function leftoverWithCommit(repo: string, name: string, subject: string): void {
  const path = join(repo, ...SWEEP_WORKTREES_DIR, name);
  mkdirSync(join(repo, ...SWEEP_WORKTREES_DIR), {recursive: true});
  git(repo, [
    'worktree',
    'add',
    '-q',
    '-b',
    sweepBranchFor(name),
    path,
    'main',
  ]);
  writeFileSync(join(path, 'held.txt'), 'held\n');
  git(path, ['add', '-A']);
  git(path, ['commit', '-qm', subject]);
}

describe('leftovers are reported, not blocking (S2, S3, AC1, AC2)', () => {
  test(
    "the LEGACY fixed-name leftover holding a green commit (ynab's shape) does not block, and is listed",
    async () => {
      const sb = track(createSandbox());
      const repo = e2eRepo(sb, 'legacy-held');
      leftoverWithCommit(
        repo,
        LEGACY_SWEEP_NAME,
        'chore: an old sweep commit nobody merged',
      );
      const held = sha(repo, sweepBranchFor(LEGACY_SWEEP_NAME));

      const {out, value} = await captureLog(() =>
        runSweep({
          component: 'gitignore',
          logDir: join(sb.path, 'logs'),
          repos: [repo],
        }),
      );

      expect(value).toBe(0);
      expect(out).not.toContain('COULD NOT SWEEP');
      const summary = summaryOf(out);
      expect(summary).toContain(
        'leftover from an earlier run, KEPT: sdk-sweep (branch worktree-sdk-sweep)',
      );
      expect(summary).toContain('chore: an old sweep commit nobody merged');
      expect(summary).toContain(
        `inspect: git -C ${repo} log --stat main..worktree-sdk-sweep`,
      );
      expect(summary).toContain('1 leftover(s) from earlier runs KEPT');
      // S3: it survives, untouched — and this run's own work still landed.
      expect(sha(repo, sweepBranchFor(LEGACY_SWEEP_NAME))).toBe(held);
      expect(
        existsSync(join(repo, ...SWEEP_WORKTREES_DIR, LEGACY_SWEEP_NAME)),
      ).toBe(true);
      expect(git(repo, ['show', 'main:.gitignore'])).toContain(
        'justin-sdk baseline',
      );
      expect(sweepRemains(repo)).toEqual([LEGACY_SWEEP_NAME]);
      // …and it is in the run log too.
      const logPath = /run log: (\S+\.log)/.exec(out)?.[1];
      expect(
        readFileSync(must(logPath, 'log path in the output'), 'utf-8'),
      ).toContain('leftover from an earlier run, KEPT: sdk-sweep');
    },
    E2E_TIMEOUT,
  );

  test(
    'a STAMPED leftover with no commits and a clean tree is still auto-removed',
    async () => {
      const sb = track(createSandbox());
      const repo = e2eRepo(sb, 'stamped-empty');
      const name = 'sdk-sweep-2026-09-18T10-00-00.000Z';
      mkdirSync(join(repo, ...SWEEP_WORKTREES_DIR), {recursive: true});
      git(repo, [
        'worktree',
        'add',
        '-q',
        '-b',
        sweepBranchFor(name),
        join(repo, ...SWEEP_WORKTREES_DIR, name),
        'main',
      ]);

      const {out, value} = await captureLog(() =>
        runSweep({
          component: 'gitignore',
          logDir: join(sb.path, 'logs'),
          repos: [repo],
        }),
      );

      expect(value).toBe(0);
      expect(out).toContain(
        `auto-removed a leftover from an earlier run (${name})`,
      );
      expect(summaryOf(out)).not.toContain('KEPT');
      expectNoSweepRemains(repo);
    },
    E2E_TIMEOUT,
  );

  test(
    'AC1: a run KILLED after committing leaves its log and its commit; the next run proceeds and lists it',
    async () => {
      const sb = track(createSandbox());
      const repo = e2eRepo(sb, 'interrupted');
      const logDir = join(sb.path, 'logs');
      const release = join(sb.path, 'release');
      // Holds the sweep inside its own commit (post-commit runs after the
      // commit is written), so the kill lands exactly "after committing".
      postCommitHook(
        sb,
        repo,
        `i=0; while [ ! -f '${release}' ] && [ $i -lt 600 ]; do sleep 0.1; i=$((i+1)); done; exit 0`,
      );

      const child = spawn(
        'bun',
        [
          join(import.meta.dir, 'sweep-child-runner.ts'),
          JSON.stringify({component: 'gitignore', logDir, repos: [repo]}),
        ],
        {detached: true, stdio: 'ignore'},
      );
      const exited = new Promise<void>((done) =>
        child.on('exit', () => done()),
      );
      // Wait for the run log to say it committed — read from DISK, as an
      // operator would after the fact.
      const logFile = (): string | null => {
        if (!existsSync(logDir)) return null;
        const found = readdirSync(logDir).find((entry) =>
          entry.endsWith('.log'),
        );
        return found == null ? null : join(logDir, found);
      };
      // "After committing" is measured, not timed: the log names the branch,
      // and the kill waits until that branch really holds a commit beyond main
      // (the hook is then holding git inside its post-commit step).
      const committedOnBranch = (): boolean => {
        const file = logFile();
        if (file == null) return false;
        const branch = /branch: (worktree-sdk-sweep-\S+)/.exec(
          readFileSync(file, 'utf-8'),
        )?.[1];
        if (branch == null) return false;
        try {
          return (
            git(repo, ['rev-list', '--count', `main..${branch}`]).trim() === '1'
          );
        } catch {
          return false;
        }
      };
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline && !committedOnBranch()) {
        await Bun.sleep(100);
      }
      process.kill(-must(child.pid, 'child pid'), 'SIGKILL');
      writeFileSync(release, 'go\n');
      await exited;

      // AC5: the log was on disk from the start, and says how far the run got.
      const firstLog = readFileSync(
        must(logFile(), 'the first run log'),
        'utf-8',
      );
      expect(firstLog).toContain('justin-sdk sweep — run ');
      expect(firstLog).toContain('branch: worktree-sdk-sweep-');
      expect(firstLog).toContain('interrupted: created worktree');
      expect(firstLog).toContain(
        'interrupted: committing on worktree-sdk-sweep-',
      );
      expect(firstLog).not.toContain('interrupted: merged');
      expect(firstLog).not.toContain('exit ');
      const [found, ...rest] = sweepRemains(repo);
      const firstRun = must(found, 'the first run leftover');
      expect(rest).toEqual([]);
      expect(firstLog).toContain(`branch: ${sweepBranchFor(firstRun)}`);
      const firstCommit = sha(repo, sweepBranchFor(firstRun));

      // The second run.
      const {out, value} = await captureLog(() =>
        runSweep({component: 'gitignore', logDir, repos: [repo]}),
      );

      expect(value).toBe(0);
      expect(out).not.toContain('COULD NOT SWEEP');
      const summary = summaryOf(out);
      expect(summary).toContain(
        `leftover from an earlier run, KEPT: ${firstRun}`,
      );
      expect(summary).toContain('1 commit(s) beyond the default branch:');
      expect(summary).toContain(firstCommit.slice(0, 7));
      expect(summary).toContain(
        `inspect: git -C ${repo} log --stat main..${sweepBranchFor(firstRun)}`,
      );
      // S3: the first run's commit is still there; the second run's landed.
      expect(sha(repo, sweepBranchFor(firstRun))).toBe(firstCommit);
      expect(git(repo, ['show', 'main:.gitignore'])).toContain(
        'justin-sdk baseline',
      );
      expect(sweepRemains(repo)).toEqual([firstRun]);
    },
    E2E_TIMEOUT,
  );
});
