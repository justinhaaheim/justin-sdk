/**
 * A listing that FAILED must never read as a listing that came back empty
 * (home-base-qyu1.23).
 *
 * `getBranchTips` and `getWorktrees` both answered `[]` on any git failure. Both
 * empties are load-bearing sentences elsewhere:
 *
 *   no branches   -> the prime session-start view prints "no unmerged work on
 *                    any other branch or worktree", the one sentence in this
 *                    codebase that tells a reader it is safe to start building
 *                    where they stand.
 *   no worktrees  -> every local branch reads as checked out nowhere, which is
 *                    the precondition `buildPlan` archives on.
 *
 * ── Reachability, measured rather than assumed ───────────────────────────────
 *
 * BRANCHES is deterministic and cheap to reach: `for-each-ref
 * --format=…%(committerdate:iso-strict)` has to parse every tip commit, so ONE
 * missing loose object behind ONE ref fails the command for the WHOLE repo. The
 * fixture here destroys a single tip object and the entire repo — including
 * `main`, which is intact — becomes invisible.
 *
 * WORKTREES could not be broken from inside a repo. `git worktree list
 * --porcelain` was probed against a corrupt linked HEAD, a `gitdir` pointing at
 * a nonexistent path, a removed `gitdir`/`commondir`/`HEAD`, an unparseable
 * `config.worktree`, and a `.git/worktrees` directory at mode 000: every one
 * exited 0, some by silently omitting the worktree. So its failure is reached
 * the way the drift suite reaches an observation — a `git` earlier on the PATH
 * of a SUBPROCESS running the shipped CLI — which has the side benefit of
 * exercising the real end-to-end wiring rather than a hand-built report.
 *
 * That same mechanism gives the negative control REAL TEETH: a second shim makes
 * `git worktree list` succeed with EMPTY OUTPUT, which is precisely the value the
 * old code substituted on failure. Under it the shipped `apply` renames a branch
 * that a live worktree has checked out, and the worktree silently follows.
 *
 * ── The backstop this bug was filed under does not exist ─────────────────────
 *
 * qyu1.23 was filed believing "git itself refuses to move a checked-out branch,
 * so impact is an error surfaced late rather than data loss". That is FALSE for
 * the rename, and `git branch -m` is what `apply` runs on the local path. It is
 * asserted below in both directions: the rename succeeds and retargets the live
 * worktree's HEAD, while only `git branch -D` refuses.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {execFileSync, spawnSync} from 'child_process';
import {chmodSync, existsSync, mkdirSync, rmSync, writeFileSync} from 'fs';
import {join} from 'path';

import {
  buildCoreInventory,
  getBranchTips,
  getWorktrees,
} from '../src/repo-status/core';
import {buildPlan} from '../src/repo-status/plan';
import {formatRepoState, runDivergenceCheck} from '../src/repo-status/prime-view';
import {buildReport, type RepoStatusReport} from '../src/repo-status/report';
import {createSandbox, type Sandbox} from './sandbox';

const CLI = join(import.meta.dir, '../src/repo-status/repo-status.ts');

const sandboxes: Sandbox[] = [];
function track(sb: Sandbox): Sandbox {
  sandboxes.push(sb);
  return sb;
}
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {cwd, encoding: 'utf-8', stdio: 'pipe'});
}

/** Exit status of a git command, without throwing. */
function gitStatus(cwd: string, args: string[]): number {
  return spawnSync('git', args, {cwd, stdio: 'ignore'}).status ?? -1;
}

function commit(repo: string, file: string, msg: string): string {
  writeFileSync(join(repo, file), `${msg}\n`);
  git(repo, ['add', file]);
  git(repo, ['commit', '-q', '-m', msg]);
  return git(repo, ['rev-parse', 'HEAD']).trim();
}

function destroyObject(repo: string, sha: string): void {
  const path = join(repo, '.git', 'objects', sha.slice(0, 2), sha.slice(2));
  if (!existsSync(path)) {
    throw new Error(`expected a loose object at ${path}`);
  }
  rmSync(path);
}

function initRepo(sb: Sandbox, name: string): string {
  const repo = join(sb.path, name);
  mkdirSync(repo, {recursive: true});
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  return repo;
}

/** A branch whose work was squash-merged into main — provably safe to archive. */
function addSquashMergedBranch(repo: string, name: string): void {
  git(repo, ['checkout', '-q', '-b', name]);
  commit(repo, `${name}.txt`, `${name} work`);
  git(repo, ['checkout', '-q', 'main']);
  git(repo, ['merge', '--squash', name]);
  git(repo, ['commit', '-q', '-m', `squashed ${name}`]);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A repo whose BRANCH listing cannot be read, next to a healthy control.
 *
 *   main     C0 -- M1              intact, and still invisible: one bad tip
 *   broken   C0 -- [B1 DESTROYED]  the tip object itself is gone
 */
function buildUnreadableBranchesRepo(sb: Sandbox): string {
  const repo = initRepo(sb, 'unreadable-branches');
  const base = commit(repo, 'README.md', 'c0');
  git(repo, ['checkout', '-q', '-b', 'broken', base]);
  const tip = commit(repo, 'b.txt', 'b1');
  git(repo, ['checkout', '-q', 'main']);
  commit(repo, 'm.txt', 'm1');
  destroyObject(repo, tip);
  return repo;
}

/** A healthy repo with one branch ahead of main, for the positive controls. */
function buildHealthyRepo(sb: Sandbox): string {
  const repo = initRepo(sb, 'healthy');
  const base = commit(repo, 'README.md', 'c0');
  git(repo, ['checkout', '-q', '-b', 'ahead', base]);
  commit(repo, 'a.txt', 'a1');
  git(repo, ['checkout', '-q', 'main']);
  return repo;
}

interface WorktreeFixture {
  repo: string;
  /** Linked worktree with `landed` checked out. */
  worktree: string;
}

/**
 * The shape the worktree half is about: a branch that is PROVEN SAFE and is also
 * checked out, plus an unattached proven-safe branch as the control that shows
 * the plan still does its job when nothing is wrong.
 *
 *   main      squashed landed, squashed unattached   the baseline
 *   landed    one commit, squash-merged              CHECKED OUT at ../wt
 *   unattached one commit, squash-merged             checked out nowhere
 */
function buildWorktreeFixture(sb: Sandbox): WorktreeFixture {
  const repo = initRepo(sb, 'worktree-fixture');
  commit(repo, 'README.md', 'c0');
  addSquashMergedBranch(repo, 'landed');
  addSquashMergedBranch(repo, 'unattached');
  const worktree = join(sb.path, 'wt');
  git(repo, ['worktree', 'add', '-q', worktree, 'landed']);
  return {repo, worktree};
}

/**
 * A `git` earlier on PATH that breaks exactly one subcommand and passes
 * everything else to the real one.
 *
 * `mode: 'fail'` is the bug's trigger — `git worktree list` exits non-zero.
 * `mode: 'empty'` is its old CONSEQUENCE — the command succeeds with no output,
 * which is byte-for-byte the `[]` the old code substituted, so running the real
 * `apply` under it shows what that substitution did.
 */
function installWorktreeListShim(sb: Sandbox, mode: 'empty' | 'fail'): string {
  const dir = join(sb.path, `shim-${mode}`);
  mkdirSync(dir, {recursive: true});
  const realGit = execFileSync('which', ['git'], {encoding: 'utf-8'}).trim();
  const body =
    mode === 'fail'
      ? ['  echo "fatal: simulated worktree list failure" >&2', '  exit 128']
      : ['  exit 0'];
  writeFileSync(
    join(dir, 'git'),
    [
      '#!/bin/sh',
      'if [ "$1" = "worktree" ] && [ "$2" = "list" ]; then',
      ...body,
      'fi',
      `exec '${realGit}' "$@"`,
      '',
    ].join('\n'),
  );
  chmodSync(join(dir, 'git'), 0o755);
  return dir;
}

interface CliRun {
  code: number;
  err: string;
  out: string;
}

function runCli(args: string[], shimDir?: string): CliRun {
  const result = spawnSync('bun', [CLI, ...args], {
    encoding: 'utf-8',
    env:
      shimDir != null
        ? {...process.env, PATH: `${shimDir}:${process.env.PATH ?? ''}`}
        : process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    code: result.status ?? -1,
    err: result.stderr ?? '',
    out: result.stdout ?? '',
  };
}

function reportFor(repo: string): RepoStatusReport {
  const report = buildReport({
    content: true,
    cwd: repo,
    prs: false,
    sinceDays: null,
    submodules: false,
  });
  if (report == null) throw new Error('expected a report');
  return report;
}

// ---------------------------------------------------------------------------
// The listings themselves
// ---------------------------------------------------------------------------

describe('the two listings report failure as failure', () => {
  test('null when git cannot answer, real values when it can', () => {
    const sb = track(createSandbox());
    const healthy = buildHealthyRepo(sb);
    const unreadable = buildUnreadableBranchesRepo(sb);
    const notARepo = join(sb.path, 'not-a-repo');
    mkdirSync(notARepo, {recursive: true});

    // The bug at its source. One destroyed tip object, and the branch listing
    // for the WHOLE repo is unavailable — `main` is intact and still unlisted.
    expect(getBranchTips(unreadable, [])).toBeNull();
    expect(getWorktrees(notARepo)).toBeNull();
    expect(getBranchTips(notARepo, [])).toBeNull();

    // ...while everything readable still reads. Without these controls,
    // "return null always" would satisfy every assertion above.
    expect(getWorktrees(healthy)?.map((w) => w.branch)).toEqual(['main']);
    expect(
      getBranchTips(healthy, getWorktrees(healthy))
        ?.map((t) => t.name)
        .sort(),
    ).toEqual(['ahead', 'main']);
  });

  test('the asymmetry: everything else about the repo still answers', () => {
    const sb = track(createSandbox());
    const repo = buildUnreadableBranchesRepo(sb);

    // This is why nothing downstream caught it: the repo looks entirely fine to
    // every other probe, so the empty branch list read as a fact about the repo
    // rather than as a failure to read it.
    expect({
      forEachRef: gitStatus(repo, [
        'for-each-ref',
        '--format=%(refname) %(objectname) %(committerdate:iso-strict)',
        'refs/heads',
        'refs/remotes',
      ]),
      revParseMain: gitStatus(repo, ['rev-parse', '--verify', '--quiet', 'main']),
      showToplevel: gitStatus(repo, ['rev-parse', '--show-toplevel']),
      worktreeList: gitStatus(repo, ['worktree', 'list', '--porcelain']),
    }).toEqual({
      forEachRef: 128,
      revParseMain: 0,
      showToplevel: 0,
      worktreeList: 0,
    });
  });

  test('the inventory carries the failure, naming the command', () => {
    const sb = track(createSandbox());
    const inventory = buildCoreInventory({
      baseline: 'current',
      cwd: buildUnreadableBranchesRepo(sb),
    });

    expect(inventory?.branches).toBeNull();
    // The worktree half is INDEPENDENT and still readable here — a failure in
    // one must not be reported as a failure in both.
    expect(inventory?.worktrees).not.toBeNull();
    expect(inventory?.enumerationFailures.map((f) => f.what)).toEqual([
      'branches',
    ]);
    const failure = inventory?.enumerationFailures[0];
    expect(failure?.command).toBe(
      "git for-each-ref '--format=%(refname) %(objectname) %(committerdate:iso-strict)' refs/heads refs/remotes",
    );
    expect(failure?.why).toContain('NOTHING COULD BE READ');
    expect(failure?.diagnose).toContain('git fsck --no-progress');
  });
});

// ---------------------------------------------------------------------------
// The false calm this bug is actually about
// ---------------------------------------------------------------------------

describe('the session-start view never calls an unreadable repo clean', () => {
  test('it says UNKNOWN, names the failed command, and drops the all-clear', () => {
    const sb = track(createSandbox());
    const report = runDivergenceCheck({cwd: buildUnreadableBranchesRepo(sb)});
    const text = formatRepoState(report);

    // The exact sentence this test exists to prevent. Before the fix this repo
    // produced it verbatim, with no other output at all.
    expect(text).not.toContain('no unmerged work');
    expect(text).toContain('# Current repo state');
    expect(text).toContain('UNKNOWN, not as clean');
    expect(text).toContain('could not enumerate branches');
    expect(text).toContain('git for-each-ref');
    expect(text).toContain('git fsck --no-progress');
  });

  test('a healthy repo still gets the all-clear, and a divergent one its list', () => {
    const sb = track(createSandbox());
    const repo = buildHealthyRepo(sb);

    // CONTROL. The all-clear sentence must still be reachable, or the test above
    // would pass just as well against a formatter that never printed it.
    const diverged = runDivergenceCheck({cwd: repo});
    expect(diverged?.enumerationFailures).toEqual([]);
    expect(formatRepoState(diverged)).toContain('1 commit ahead');

    git(repo, ['checkout', '-q', 'ahead']);
    const clean = runDivergenceCheck({cwd: repo});
    expect(formatRepoState(clean)).toContain(
      'no unmerged work on any other branch or worktree',
    );
  });
});

// ---------------------------------------------------------------------------
// status, through the shipped CLI
// ---------------------------------------------------------------------------

describe('status publishes the unknown rather than an empty ledger', () => {
  test('branches and summary are null, the failure is named, exit is non-zero', () => {
    const sb = track(createSandbox());
    const run = runCli([
      'status',
      '--repo',
      buildUnreadableBranchesRepo(sb),
      '--no-prs',
      '--no-submodules',
      '--json',
    ]);

    const parsed = JSON.parse(run.out) as RepoStatusReport;
    expect(parsed.branches).toBeNull();
    expect(parsed.summary).toBeNull();
    expect(parsed.enumerationFailures?.map((f) => f.what)).toEqual(['branches']);
    // A ledger missing its entire input is not a short ledger.
    expect(run.code).toBe(1);
    expect(run.err).toContain('severe: could not enumerate branches');
  });

  test('a healthy repo is unchanged: rows, a summary, and no new key', () => {
    const sb = track(createSandbox());
    const run = runCli([
      'status',
      '--repo',
      buildHealthyRepo(sb),
      '--no-prs',
      '--no-submodules',
      '--json',
    ]);

    const parsed = JSON.parse(run.out) as RepoStatusReport;
    expect(parsed.branches?.map((r) => r.name)).toEqual(['ahead']);
    expect(parsed.summary?.branches).toBe(1);
    // Present only when something failed, so healthy output is byte-for-byte
    // what it was before this key existed.
    expect('enumerationFailures' in parsed).toBe(false);
    expect(run.code).toBe(0);
    expect(run.err).not.toContain('severe:');
  });
});

// ---------------------------------------------------------------------------
// There is no plan over an unknown branch set
// ---------------------------------------------------------------------------

describe('plan and apply refuse a repo whose branches are unknown', () => {
  test('buildPlan returns null rather than four empty groups', () => {
    const sb = track(createSandbox());
    expect(buildPlan(reportFor(buildUnreadableBranchesRepo(sb)))).toBeNull();

    // CONTROL: a readable repo still gets a plan that proposes something.
    const healthy = buildWorktreeFixture(sb);
    const plan = buildPlan(reportFor(healthy.repo));
    expect(plan?.safe.map((a) => a.branch)).toEqual(['unattached']);
  });

  test('the CLI prints why there is no plan and exits non-zero, touching nothing', () => {
    const sb = track(createSandbox());
    const repo = buildUnreadableBranchesRepo(sb);
    const before = git(repo, ['rev-parse', 'broken']).trim();

    const planned = runCli(['plan', '--repo', repo, '--json']);
    expect(planned.code).toBe(1);
    // Nothing on stdout: an empty plan object is exactly the reading being
    // refused, so there must be no object to read.
    expect(planned.out.trim()).toBe('');
    expect(planned.err).toContain('no plan');
    expect(planned.err).toContain('NOT "nothing to clean up"');

    const applied = runCli([
      'apply',
      '--repo',
      repo,
      '--safe-only',
      '--yes',
      '--json',
    ]);
    expect(applied.code).toBe(1);
    expect(applied.err).toContain('no plan');
    // The refs are exactly where they were, under their original names.
    expect(git(repo, ['rev-parse', 'broken']).trim()).toBe(before);
    expect(gitStatus(repo, ['rev-parse', '--verify', '--quiet', 'archive/broken'])).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Unknown worktree state, end to end through the shipped CLI
// ---------------------------------------------------------------------------

describe('an unknown worktree state routes every local row to manual', () => {
  test('the plan proposes nothing local and says which command failed', () => {
    const sb = track(createSandbox());
    const fx = buildWorktreeFixture(sb);
    const shim = installWorktreeListShim(sb, 'fail');

    const run = runCli(['plan', '--repo', fx.repo, '--json'], shim);
    expect(run.code).toBe(0);
    const plan = JSON.parse(run.out) as ReturnType<typeof buildPlan> & object;

    // EVERY local row, not just the one that happens to be checked out: with no
    // listing, which of them is checked out is precisely what is unknown.
    expect(plan.safe).toEqual([]);
    expect(plan.manual.map((a) => a.branch).sort()).toEqual([
      'landed',
      'unattached',
    ]);
    const reason = plan.manual[0]?.reason ?? '';
    expect(reason).toContain('git worktree list --porcelain');
    expect(reason).toContain('UNKNOWN');
    expect(reason).toContain('does NOT refuse a checked-out branch');
  });

  test('apply leaves the checked-out branch and its worktree alone', () => {
    const sb = track(createSandbox());
    const fx = buildWorktreeFixture(sb);
    const shim = installWorktreeListShim(sb, 'fail');

    const run = runCli(
      ['apply', '--repo', fx.repo, '--safe-only', '--yes', '--json'],
      shim,
    );
    expect(run.code).toBe(0);
    expect(JSON.parse(run.out)).toEqual([]);
    expect(gitStatus(fx.repo, ['rev-parse', '--verify', '--quiet', 'landed'])).toBe(0);
    expect(
      gitStatus(fx.repo, ['rev-parse', '--verify', '--quiet', 'archive/landed']),
    ).not.toBe(0);
    expect(git(fx.worktree, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(
      'landed',
    );
  });

  /**
   * NEGATIVE CONTROL, run through the real shipped `apply`.
   *
   * The shim here does not fail — it makes `git worktree list` SUCCEED with no
   * output, which is byte-for-byte the `[]` the old code substituted when the
   * command failed. Everything downstream is the real thing, so this is what the
   * bug did: a live worktree's branch renamed out from under it, reported as an
   * ordinary success.
   */
  test('with an empty listing standing in for the old fabrication, apply renames it', () => {
    const sb = track(createSandbox());
    const fx = buildWorktreeFixture(sb);
    const shim = installWorktreeListShim(sb, 'empty');

    const run = runCli(
      ['apply', '--repo', fx.repo, '--safe-only', '--yes', '--json'],
      shim,
    );
    expect(run.code).toBe(0);
    expect(
      (JSON.parse(run.out) as {branch: string; outcome: string}[])
        .map((r) => [r.branch, r.outcome])
        .sort(),
    ).toEqual([
      ['landed', 'archived'],
      ['unattached', 'archived'],
    ]);

    // The damage, stated as repo state rather than as a result string: the
    // branch is gone under its old name and the LIVE worktree is now sitting on
    // the archive ref, with nothing anywhere having said so.
    expect(gitStatus(fx.repo, ['rev-parse', '--verify', '--quiet', 'landed'])).not.toBe(0);
    expect(git(fx.worktree, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(
      'archive/landed',
    );
  });

  test('without any shim the same repo behaves exactly as before', () => {
    const sb = track(createSandbox());
    const fx = buildWorktreeFixture(sb);

    // CONTROL: worktree state readable -> the checked-out branch is manual for
    // the ORIGINAL reason, and the unattached one is still archived. The fix
    // changes nothing on a repo git can read.
    const plan = buildPlan(reportFor(fx.repo));
    expect(plan?.safe.map((a) => a.branch)).toEqual(['unattached']);
    expect(plan?.manual.map((a) => a.branch)).toEqual(['landed']);
    expect(plan?.manual[0]?.reason).toContain('remove the worktree first');
  });
});

// ---------------------------------------------------------------------------
// The backstop the bug was filed under
// ---------------------------------------------------------------------------

describe('git does NOT refuse to rename a checked-out branch', () => {
  /**
   * The severity claim in home-base-qyu1.23 rested on git refusing this. It does
   * not. `apply`'s local path runs `git branch -m`, and git renames the branch
   * AND retargets the live worktree's HEAD, reporting success — so there was no
   * backstop under the archived-instead-of-manual case at all. Only the delete
   * path, which `apply` reaches solely for an already-mirrored branch, refuses.
   *
   * Asserted on real git (2.50.1 when written) rather than assumed, because the
   * whole severity argument turns on it.
   */
  test('branch -m succeeds and moves the worktree; branch -D is the only refusal', () => {
    const sb = track(createSandbox());
    const fx = buildWorktreeFixture(sb);
    const tip = git(fx.repo, ['rev-parse', 'landed']).trim();

    expect(gitStatus(fx.repo, ['branch', '-D', 'landed'])).toBe(1);
    expect(gitStatus(fx.repo, ['branch', '-m', 'landed', 'archive/landed'])).toBe(0);

    expect(git(fx.worktree, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(
      'archive/landed',
    );
    // Non-destructive, at least: every commit is still reachable under the new
    // name. The problem is that a live checkout was moved without a word.
    expect(git(fx.repo, ['rev-parse', 'archive/landed']).trim()).toBe(tip);
  });
});
