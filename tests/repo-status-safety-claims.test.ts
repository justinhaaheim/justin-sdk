/**
 * The three reassuring claims this report makes, and the evidence each needs.
 *
 * Every finding these cover came out of blind reviews of the ledger — three
 * models, given the output and nothing else, asked to check it against real git
 * (2026-09-07). All three independently landed on the same class of bug, which
 * is the class this repo's rule 6 is about: a statement that points toward
 * "safe / done / nothing to worry about" and was never actually measured.
 *
 *   1. "this branch exists nowhere else" was printed over branches sitting on
 *      origin at the identical sha. The remote refs were in the walk the whole
 *      time and were being discarded after deduping.
 *   2. "nothing to lose here" was printed over checkouts with uncommitted
 *      edits. It is a claim about a working tree and no working tree was read.
 *   3. "merges cleanly" was printed over a merge that REVERTS a submodule
 *      pointer three releases. git reports no conflict there — only one side
 *      moved the gitlink, so it takes that side — so exit 0 is silent about the
 *      single most damaging thing the merge does.
 *
 * Each test below asserts the evidence exists, and its negative half asserts
 * the claim is NOT made when the evidence is absent.
 *
 * Part of home-base-qyu1.33.5.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {execFileSync} from 'child_process';
import {mkdirSync, writeFileSync} from 'fs';
import {join} from 'path';

import {previewMerge} from '../src/repo-status/merge-preview';
import {renderReportPretty} from '../src/repo-status/pretty';
import {buildReport, type RepoStatusReport} from '../src/repo-status/report';
import {createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
function track(sb: Sandbox): Sandbox {
  sandboxes.push(sb);
  return sb;
}
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: 'pipe',
  }).trim();
}

function init(path: string): string {
  mkdirSync(path, {recursive: true});
  git(path, ['init', '-q', '-b', 'main']);
  git(path, ['config', 'user.email', 'test@example.com']);
  git(path, ['config', 'user.name', 'Test']);
  return path;
}

function commit(repo: string, file: string, body: string, msg: string): string {
  writeFileSync(join(repo, file), body);
  git(repo, ['add', '--', file]);
  git(repo, ['commit', '-q', '-m', msg]);
  return git(repo, ['rev-parse', 'HEAD']);
}

function reportFor(
  repo: string,
  over: Partial<Parameters<typeof buildReport>[0]> = {},
): RepoStatusReport {
  const report = buildReport({
    content: false,
    cwd: repo,
    prs: false,
    sinceDays: null,
    submodules: false,
    ...over,
  });
  if (report == null) throw new Error('expected a report');
  return report;
}

describe('claim 1: where else does this branch exist', () => {
  test('a branch on a remote is reported as being there, not as disk-only', () => {
    const sb = track(createSandbox());
    const repo = init(join(sb.path, 'work'));
    const base = commit(repo, 'README.md', 'x\n', 'initial');
    git(repo, ['checkout', '-q', '-b', 'pushed', base]);
    const tip = commit(repo, 'pushed.txt', 'work\n', 'pushed work');
    git(repo, ['checkout', '-q', 'main']);
    // A remote-tracking ref at the SAME sha — what `git push` leaves behind.
    git(repo, ['update-ref', 'refs/remotes/origin/pushed', tip]);

    const row = reportFor(repo).branches?.find((b) => b.name === 'pushed');
    expect(row?.remote?.ref).toBe('origin/pushed');
    expect(row?.remote?.inSync).toBe(true);
    expect(renderReportPretty(reportFor(repo))).not.toContain('THIS DISK ONLY');
  });

  test('a branch on no remote says so, loudly', () => {
    const sb = track(createSandbox());
    const repo = init(join(sb.path, 'work'));
    const base = commit(repo, 'README.md', 'x\n', 'initial');
    git(repo, ['checkout', '-q', '-b', 'local-only', base]);
    commit(repo, 'local.txt', 'work\n', 'local work');
    git(repo, ['checkout', '-q', 'main']);

    const row = reportFor(repo).branches?.find((b) => b.name === 'local-only');
    expect(row?.remote).toBeNull();
    expect(renderReportPretty(reportFor(repo))).toContain('THIS DISK ONLY');
  });

  test('a remote holding a DIFFERENT sha is not reported as a backup', () => {
    const sb = track(createSandbox());
    const repo = init(join(sb.path, 'work'));
    const base = commit(repo, 'README.md', 'x\n', 'initial');
    git(repo, ['checkout', '-q', '-b', 'drifted', base]);
    commit(repo, 'a.txt', 'one\n', 'first');
    // The remote is at the branch's OLD tip: the newer commit is on no remote.
    git(repo, ['update-ref', 'refs/remotes/origin/drifted', base]);
    git(repo, ['checkout', '-q', 'main']);

    const row = reportFor(repo).branches?.find((b) => b.name === 'drifted');
    expect(row?.remote?.inSync).toBe(false);
    expect(renderReportPretty(reportFor(repo))).toContain('(differs)');
  });
});

describe('claim 2: nothing to lose in this checkout', () => {
  test('a dirty worktree is reported, and the merged blurb no longer overclaims', () => {
    const sb = track(createSandbox());
    const repo = init(join(sb.path, 'work'));
    commit(repo, 'README.md', 'x\n', 'initial');
    git(repo, ['branch', '-q', 'landed', 'main']);
    const wt = join(sb.path, 'wt');
    git(repo, ['worktree', 'add', '-q', wt, 'landed']);
    // Uncommitted, and on no branch anywhere.
    writeFileSync(join(wt, 'scratch.txt'), 'unsaved work\n');

    const report = reportFor(repo);
    const row = report.branches?.find((b) => b.name === 'landed');
    expect(row?.disposition).toBe('merged');
    expect(row?.worktreeState?.dirty).toBe(true);

    const out = renderReportPretty(report);
    expect(out).toContain('[UNCOMMITTED]');
    expect(out).toContain('scratch.txt');
    // The sentence that authorised deleting the worktree is gone.
    expect(out).not.toContain('nothing to lose');
  });

  test('an untracked file counts — it is the easiest thing to lose', () => {
    const sb = track(createSandbox());
    const repo = init(join(sb.path, 'work'));
    commit(repo, 'README.md', 'x\n', 'initial');
    git(repo, ['branch', '-q', 'landed', 'main']);
    const wt = join(sb.path, 'wt');
    git(repo, ['worktree', 'add', '-q', wt, 'landed']);
    writeFileSync(join(wt, 'never-added.txt'), 'brand new\n');

    const row = reportFor(repo).branches?.find((b) => b.name === 'landed');
    expect(row?.worktreeState?.dirty).toBe(true);
    expect(row?.worktreeState?.samplePaths).toContain('never-added.txt');
  });

  test('skipping the check says so, rather than implying clean trees', () => {
    const sb = track(createSandbox());
    const repo = init(join(sb.path, 'work'));
    commit(repo, 'README.md', 'x\n', 'initial');
    git(repo, ['branch', '-q', 'landed', 'main']);

    const out = renderReportPretty(reportFor(repo, {worktreeState: false}));
    expect(out).toContain('Working trees: NOT inspected');
  });
});

describe('claim 3: this merge is clean', () => {
  /** A parent repo whose submodule pointer the branch drags BACKWARDS. */
  function submoduleFixture(sb: Sandbox): {parent: string} {
    const sub = init(join(sb.path, 'sub'));
    const old = commit(sub, 'v.txt', 'old\n', 'old release');
    const recent = commit(sub, 'v.txt', 'new\n', 'new release');

    const parent = init(join(sb.path, 'parent'));
    commit(parent, 'README.md', 'x\n', 'initial');
    execFileSync(
      'git',
      [
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        '-q',
        sub,
        'sub',
      ],
      {cwd: parent, stdio: 'pipe'},
    );
    git(parent, ['-C', 'sub', 'checkout', '-q', recent]);
    git(parent, ['add', 'sub']);
    git(parent, ['commit', '-q', '-m', 'point sub at the new release']);

    // The branch is off that commit and rolls the pointer back to `old`. Only
    // the branch side moves it, so git will merge this without a conflict.
    git(parent, ['checkout', '-q', '-b', 'stale-sub']);
    git(parent, ['-C', 'sub', 'checkout', '-q', old]);
    git(parent, ['add', 'sub']);
    git(parent, ['commit', '-q', '-m', 'branch drags sub backwards']);
    git(parent, ['checkout', '-q', 'main']);
    git(parent, ['-C', 'sub', 'checkout', '-q', recent]);
    return {parent};
  }

  test('a conflict-free merge that REVERTS a submodule is flagged as such', () => {
    const {parent} = submoduleFixture(track(createSandbox()));

    const preview = previewMerge('main', 'stale-sub', parent, {
      submodulePaths: ['sub'],
    });

    // git itself sees no conflict here — that is the entire hazard.
    expect(preview.kind).toBe('clean');
    const shift = preview.submoduleShifts?.find((s) => s.path === 'sub');
    expect(shift?.direction).toBe('regression');
    expect(preview.why).toContain('REVERTS submodule sub');
  });

  test('an ordinary forward bump is not flagged', () => {
    const sb = track(createSandbox());
    const sub = init(join(sb.path, 'sub'));
    const old = commit(sub, 'v.txt', 'old\n', 'old release');
    const recent = commit(sub, 'v.txt', 'new\n', 'new release');

    const parent = init(join(sb.path, 'parent'));
    commit(parent, 'README.md', 'x\n', 'initial');
    execFileSync(
      'git',
      [
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        '-q',
        sub,
        'sub',
      ],
      {cwd: parent, stdio: 'pipe'},
    );
    git(parent, ['-C', 'sub', 'checkout', '-q', old]);
    git(parent, ['add', 'sub']);
    git(parent, ['commit', '-q', '-m', 'point sub at the old release']);
    git(parent, ['checkout', '-q', '-b', 'bump-sub']);
    git(parent, ['-C', 'sub', 'checkout', '-q', recent]);
    git(parent, ['add', 'sub']);
    git(parent, ['commit', '-q', '-m', 'bump sub forward']);
    git(parent, ['checkout', '-q', 'main']);
    git(parent, ['-C', 'sub', 'checkout', '-q', old]);

    const preview = previewMerge('main', 'bump-sub', parent, {
      submodulePaths: ['sub'],
    });
    expect(preview.submoduleShifts?.[0]?.direction).toBe('advance');
    // A forward bump is the normal reason to merge; warning about it would
    // train the reader to skip the warnings that matter.
    expect(preview.why).not.toContain('WARNING');
  });

  test('no submodule paths means the check did NOT run, not that none moved', () => {
    const {parent} = submoduleFixture(track(createSandbox()));

    const preview = previewMerge('main', 'stale-sub', parent);
    expect(preview.kind).toBe('clean');
    // null, never [] — an empty array would say "checked, none moved", which is
    // the false reassurance this whole file is about.
    expect(preview.submoduleShifts).toBeNull();
    expect(preview.why).not.toContain('WARNING');
  });
});

describe('the checkout the reader is standing in', () => {
  test('its uncommitted files and upstream drift are both reported', () => {
    const sb = track(createSandbox());
    const repo = init(join(sb.path, 'work'));
    const base = commit(repo, 'README.md', 'x\n', 'initial');
    // An upstream that main is two commits ahead of.
    git(repo, ['update-ref', 'refs/remotes/origin/main', base]);
    // The fetch refspec is load-bearing: without it git cannot map
    // `refs/heads/main` on origin onto `refs/remotes/origin/main`, and
    // `@{upstream}` fails with "not stored as a remote-tracking branch" even
    // though branch.main.remote/merge are both set.
    git(repo, ['config', 'remote.origin.url', 'https://example.invalid/x.git']);
    git(repo, [
      'config',
      'remote.origin.fetch',
      '+refs/heads/*:refs/remotes/origin/*',
    ]);
    git(repo, ['config', 'branch.main.remote', 'origin']);
    git(repo, ['config', 'branch.main.merge', 'refs/heads/main']);
    commit(repo, 'a.txt', 'one\n', 'unpushed one');
    commit(repo, 'b.txt', 'two\n', 'unpushed two');
    writeFileSync(join(repo, 'dirty.txt'), 'uncommitted\n');

    const report = reportFor(repo);
    expect(report.repo.here?.upstream).toEqual({
      ahead: 2,
      behind: 0,
      ref: 'origin/main',
    });
    expect(report.repo.here?.state?.dirty).toBe(true);

    const out = renderReportPretty(report);
    expect(out).toContain('2 ahead / 0 behind origin/main');
    expect(out).toContain('Uncommitted here');
    expect(out).toContain('dirty.txt');
  });

  test('no upstream is stated, not silently rendered as in-sync', () => {
    const sb = track(createSandbox());
    const repo = init(join(sb.path, 'work'));
    commit(repo, 'README.md', 'x\n', 'initial');

    expect(reportFor(repo).repo.here?.upstream).toBeNull();
    expect(renderReportPretty(reportFor(repo))).toContain('(no upstream)');
  });
});
