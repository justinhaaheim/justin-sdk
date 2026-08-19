/**
 * Tests for project-prime — branch/worktree divergence detection.
 *
 * Builds real git repos (with real branches/worktrees) in a sandbox and runs
 * the actual git plumbing against them, since the whole point of this module
 * is correctly interpreting `git for-each-ref` / `rev-list` / `worktree list`
 * output.
 */

import {describe, test, expect, afterEach} from 'bun:test';
import {execFileSync, execSync} from 'child_process';
import {writeFileSync} from 'fs';
import {join} from 'path';

import {
  runDivergenceCheck,
  formatRepoState,
} from '../src/plugin/lib/repo-status/prime-view';
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
    const text = formatRepoState(report!);
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

    const text = formatRepoState(report!);
    expect(text).toContain('# Current repo state');
    expect(text).toContain('feature-x');
    expect(text).toContain('1 commit ahead');
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

  test('a worktree with ahead commits is flagged regardless of age, with its path set', () => {
    const sb = track(createSandbox());
    initRepo(sb);
    git(sb.path, 'branch wt-feature');
    const wtPath = `${sb.path}-wt`;
    git(sb.path, `worktree add -q "${wtPath}" wt-feature`);
    writeFileSync(join(wtPath, 'wt.txt'), 'worktree work\n');
    git(wtPath, 'add wt.txt');
    git(wtPath, 'commit -q -m "worktree work"', '2020-01-01T00:00:00');

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

    const text = formatRepoState(report!);
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
    expect(formatRepoState(report!)).not.toContain('PR #');
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
