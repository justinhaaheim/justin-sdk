/**
 * Tests for project-prime — branch/worktree divergence detection.
 *
 * Builds real git repos (with real branches/worktrees) in a sandbox and runs
 * the actual git plumbing against them, since the whole point of this module
 * is correctly interpreting `git for-each-ref` / `rev-list` / `worktree list`
 * output.
 */

import type {BranchDivergence} from '../src/repo-status/types';

import {afterEach, describe, expect, test} from 'bun:test';
import {execFileSync, execSync} from 'child_process';
import {writeFileSync} from 'fs';
import {join} from 'path';

import {
  formatRepoState,
  runDivergenceCheck,
} from '../src/repo-status/prime-view';
import {createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];

function track(sandbox: Sandbox): Sandbox {
  sandboxes.push(sandbox);
  return sandbox;
}

afterEach(() => {
  while (sandboxes.length > 0) {
    const sb = sandboxes.pop();
    sb?.cleanup();
  }
});

function git(cwd: string, args: string, dateIso?: string): string {
  const env =
    dateIso != null
      ? {
          ...process.env,
          GIT_AUTHOR_DATE: dateIso,
          GIT_COMMITTER_DATE: dateIso,
        }
      : process.env;
  return execSync(`git ${args}`, {cwd, encoding: 'utf-8', env}).trim();
}

function initRepo(sb: Sandbox): void {
  git(sb.path, 'init -q -b main');
  git(sb.path, 'config user.email test@example.com');
  git(sb.path, 'config user.name Test');
  sb.writeFile('README.md', 'hello\n');
  git(sb.path, 'add README.md');
  git(sb.path, 'commit -q -m initial');
}

function commit(
  sb: Sandbox,
  file: string,
  msg: string,
  dateIso?: string,
): void {
  sb.writeFile(file, `${msg}\n`);
  git(sb.path, `add ${file}`);
  git(sb.path, `commit -q -m "${msg}"`, dateIso);
}

describe('project-prime', () => {
  test('clean repo with no other branches still reports a "clean" state', () => {
    const sb = track(createSandbox());
    initRepo(sb);

    const report = runDivergenceCheck({cwd: sb.path});
    expect(report).not.toBeNull();
    expect(report?.groups).toEqual([]);
    const text = formatRepoState(report);
    expect(text).toContain('# Current repo state');
    expect(text).toContain('no unmerged work');
  });

  test('a recent branch ahead of current is flagged', () => {
    const sb = track(createSandbox());
    initRepo(sb);
    git(sb.path, 'checkout -q -b feature-x');
    commit(sb, 'feature.txt', 'feature work');
    git(sb.path, 'checkout -q main');

    const report = runDivergenceCheck({cwd: sb.path});
    expect(report?.currentBranch).toBe('main');
    expect(report?.groups).toHaveLength(1);
    expect(report?.groups[0]?.branches[0]?.name).toBe('feature-x');
    expect(report?.groups[0]?.aheadOfCurrent).toBe(1);
    expect(report?.groups[0]?.hasWorktree).toBe(false);

    const text = formatRepoState(report);
    expect(text).toContain('# Current repo state');
    expect(text).toContain('feature-x');
    expect(text).toContain('1 commit not on main');
    // Just-created commit is within 72h, so last-touched includes HH:MM.
    expect(text).toMatch(/last touched \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    // Guidance line when there IS unmerged work.
    expect(text).toContain(
      'the human may prefer for new work to base from the feature branches',
    );
  });

  test('a stale branch beyond sinceDays is filtered out', () => {
    const sb = track(createSandbox());
    initRepo(sb);
    git(sb.path, 'checkout -q -b old-feature');
    commit(sb, 'old.txt', 'old work', '2020-01-01T00:00:00');
    git(sb.path, 'checkout -q main');

    const report = runDivergenceCheck({cwd: sb.path, sinceDays: 30});
    expect(report?.groups).toEqual([]);
  });

  test('what the hidden branches hold is NOT COMPUTED here, and renders nothing', () => {
    const sb = track(createSandbox());
    initRepo(sb);
    git(sb.path, 'checkout -q -b old-feature');
    commit(sb, 'old.txt', 'old work', '2020-01-01T00:00:00');
    git(sb.path, 'checkout -q main');

    const report = runDivergenceCheck({cwd: sb.path, sinceDays: 30});

    // NULL, always, on this path (home-base-qyu1.33.9, epic decision D4).
    // Measuring the hidden set costs one `git cherry` per hidden tip, and the
    // filters exist here precisely so a hidden branch costs nothing at session
    // start. `status` is the only caller that fills this in.
    expect(report?.filtered.hiddenUnmerged).toBeNull();
    expect(report?.filtered.excludedAsStale).toBe(1);

    const text = formatRepoState(report);
    // The hidden line is EXACTLY what it was before the field existed.
    expect(text).toContain('Not listed: 1 branch(es) with no commit in 30d');
    // And the null renders as nothing at all — in particular not as a "none",
    // which is the one thing a not-computed measurement must never become.
    expect(text).not.toContain('not on main');
    expect(text).not.toContain('hidden branch');
    expect(text).not.toContain('COULD NOT BE CHECKED');
  });

  /** A second checkout on `wt-feature`, holding one commit dated `dateIso`. */
  function addWorktree(sb: Sandbox, dateIso?: string): string {
    git(sb.path, 'branch wt-feature');
    const wtPath = `${sb.path}-wt`;
    git(sb.path, `worktree add -q "${wtPath}" wt-feature`);
    writeFileSync(join(wtPath, 'wt.txt'), 'worktree work\n');
    git(wtPath, 'add wt.txt');
    git(wtPath, 'commit -q -m "worktree work"', dateIso);
    return wtPath;
  }

  test('a recent worktree with ahead commits is flagged, with its path set', () => {
    const sb = track(createSandbox());
    initRepo(sb);
    const wtPath = addWorktree(sb);
    try {
      const report = runDivergenceCheck({cwd: sb.path, sinceDays: 30});
      expect(report?.groups).toHaveLength(1);
      const group = report?.groups[0];
      expect(group?.hasWorktree).toBe(true);
      expect(group?.branches[0]?.worktreePath).toBe(wtPath);
    } finally {
      execSync(`git worktree remove --force "${wtPath}"`, {cwd: sb.path});
    }
  });

  test('a worktree branch past the age limit moves to the Not listed count', () => {
    const sb = track(createSandbox());
    initRepo(sb);
    const wtPath = addWorktree(sb, '2020-01-01T00:00:00');
    try {
      const report = runDivergenceCheck({cwd: sb.path, sinceDays: 30});
      expect(report?.groups).toHaveLength(0);
      expect(report?.filtered.excludedAsStale).toBe(1);
      expect(formatRepoState(report)).toContain(
        'Not listed: 1 branch(es) with no commit in 30d',
      );
    } finally {
      execSync(`git worktree remove --force "${wtPath}"`, {cwd: sb.path});
    }
  });

  test('from a worktree branch: main is never listed, and the header says where it stands', () => {
    const sb = track(createSandbox());
    initRepo(sb);
    const wtPath = addWorktree(sb);
    // Main moves on after the worktree was cut. Against the current branch,
    // this made `main` the one "branch with unmerged work" in 56 audited blocks.
    commit(sb, 'later.txt', 'later on main');
    try {
      const text = formatRepoState(
        runDivergenceCheck({cwd: wtPath, sinceDays: 30}),
      );
      expect(text).toContain(
        'On `wt-feature` (1 ahead of `main`, 1 behind) — no unmerged work on any other branch or worktree.',
      );
      expect(text).not.toContain('- main');
      expect(text).not.toContain('base from the feature branches');
    } finally {
      execSync(`git worktree remove --force "${wtPath}"`, {cwd: sb.path});
    }
  });

  test('the base-from-feature-branches sentence prints on the default branch only', () => {
    const sb = track(createSandbox());
    initRepo(sb);
    git(sb.path, 'checkout -q -b feature');
    commit(sb, 'f.txt', 'feature');
    git(sb.path, 'checkout -q -b other');
    commit(sb, 'o.txt', 'other');
    git(sb.path, 'checkout -q feature');
    const fromFeature = formatRepoState(
      runDivergenceCheck({cwd: sb.path, sinceDays: 30}),
    );
    expect(fromFeature).toContain('- other (2 commits not on main');
    expect(fromFeature).not.toContain('base from the feature branches');

    git(sb.path, 'checkout -q main');
    expect(
      formatRepoState(runDivergenceCheck({cwd: sb.path, sinceDays: 30})),
    ).toContain('base from the feature branches');
  });

  test('a partly merged branch reads "1 of 2 commits not on main"', () => {
    const sb = track(createSandbox());
    initRepo(sb);
    git(sb.path, 'checkout -q -b partly');
    commit(sb, 'landed.txt', 'landed elsewhere');
    commit(sb, 'unique.txt', 'still unique');
    git(sb.path, 'checkout -q main');
    // Main moves first, or the cherry-pick fast-forwards to the same hash.
    commit(sb, 'moved.txt', 'main moved');
    git(sb.path, 'cherry-pick partly~1');
    const report = runDivergenceCheck({cwd: sb.path, sinceDays: 30});
    expect(report?.groups[0]?.notOnBaseline).toBe(1);
    expect(formatRepoState(report)).toContain('1 of 2 commits not on main');
  });

  test('a failed patch check falls back to the plain count and says so, never zero', () => {
    const text = formatRepoState({
      baselineRef: 'main',
      currentBranch: 'main',
      defaultBranch: 'main',
      enumerationFailures: [],
      filtered: {
        excludeArchive: true,
        excludedAsArchive: 0,
        excludedAsStale: 0,
        hiddenUnmerged: null,
        keptForWorktree: 0,
        sinceDays: 30,
      },
      groups: [
        {
          aheadOfCurrent: 3,
          branches: [
            {
              divergence: {ahead: 3, behind: 0},
              lastCommitDate: '2026-11-01T00:00:00Z',
              name: 'x',
              tipSha: 'abc',
              worktreePath: null,
            } as BranchDivergence,
          ],
          hasWorktree: false,
          lastCommitDate: '2026-11-01T00:00:00Z',
          notOnBaseline: null,
          prNote: null,
          tipSha: 'abc',
        },
      ],
      standing: null,
    });
    expect(text).toContain(
      '3 commits ahead of main, patch check failed so some may already be merged',
    );
    expect(text).not.toContain('0 of 3');
    expect(text).not.toContain('commits not on main');
  });

  test('two branches at the same tip are grouped with a same-tip note', () => {
    const sb = track(createSandbox());
    initRepo(sb);
    git(sb.path, 'checkout -q -b feature-a');
    commit(sb, 'shared.txt', 'shared work');
    git(sb.path, 'checkout -q -b feature-b'); // branches off feature-a, identical tip
    git(sb.path, 'checkout -q main');

    const report = runDivergenceCheck({cwd: sb.path});
    expect(report?.groups).toHaveLength(1);
    expect(report?.groups[0]?.branches).toHaveLength(2);
    const names = report?.groups[0]?.branches.map((b) => b.name).sort();
    expect(names).toEqual(['feature-a', 'feature-b']);

    const text = formatRepoState(report);
    expect(text).toContain('same tip');
  });

  test('a branch name containing shell metacharacters is still counted correctly (not shell-interpolated)', () => {
    const sb = track(createSandbox());
    initRepo(sb);
    const trickyName = 'feature$(true)rest';
    // Create the branch via argv (not the shell-interpolating `git` test helper)
    // so the test setup itself doesn't fall into the same trap being tested.
    execFileSync('git', ['checkout', '-q', '-b', trickyName], {cwd: sb.path});
    commit(sb, 'feature.txt', 'feature work');
    git(sb.path, 'checkout -q main');

    const report = runDivergenceCheck({cwd: sb.path});
    expect(report?.groups).toHaveLength(1);
    expect(report?.groups[0]?.branches[0]?.name).toBe(trickyName);
    // If the implementation shell-interpolated the ref name, `$(true)` would
    // execute and the ref would fail to resolve, silently dropping to 0.
    expect(report?.groups[0]?.aheadOfCurrent).toBe(1);
  });

  test('PR enrichment is OFF by default — no network, no PR note', () => {
    const sb = track(createSandbox());
    initRepo(sb);
    git(sb.path, 'checkout -q -b feature-x');
    commit(sb, 'feature.txt', 'feature work');
    git(sb.path, 'checkout -q main');

    // The session-start hot path must not make a network call unless asked.
    // gh is unavailable in this sandbox anyway, so a regression that fetched
    // unconditionally would surface as a timeout rather than as wrong output —
    // assert the shape explicitly so the intent is pinned.
    const report = runDivergenceCheck({cwd: sb.path});
    expect(report?.groups[0]?.prNote).toBeNull();
    expect(formatRepoState(report)).not.toContain('PR #');
  });

  test('a branch fully merged into current (ahead=0) is not flagged', () => {
    const sb = track(createSandbox());
    initRepo(sb);
    git(sb.path, 'checkout -q -b feature-y');
    commit(sb, 'feature.txt', 'feature work');
    git(sb.path, 'checkout -q main');
    git(sb.path, 'merge -q feature-y --no-edit');

    const report = runDivergenceCheck({cwd: sb.path});
    expect(report?.groups).toEqual([]);
  });
});
