/**
 * The AHEAD gap, attributed to the right cause.
 *
 * A row says AHEAD 22 and its sentence says 20 commits exist only here. The gap
 * has TWO independent causes and the old text blamed all of it on one:
 *
 *   - `git cherry` never lists MERGE commits, so a merge-from-main widens the
 *     gap while carrying no work of its own.
 *   - `git cherry` lists, with a `-`, every commit whose patch-id is ALREADY on
 *     the baseline — real work that landed by another route (a cherry-pick, a
 *     rescue commit, a squash).
 *
 * Calling the second one a "merge commit" is not a wording slip. The two facts
 * point opposite ways: "already on the baseline" is reassuring and is the thing
 * a reader wants to know, while "merge commit" means inert. All three round-3
 * blind reviewers hit this independently on a branch with ZERO merge commits
 * that the report described as having two (home-base-qyu1.33.11 F1).
 *
 * Part of home-base-qyu1.33.11.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {execFileSync} from 'child_process';
import {mkdirSync, writeFileSync} from 'fs';
import {join} from 'path';

import {type BranchRow, buildReport} from '../src/repo-status/report';
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

function rowFor(repo: string, branch: string): BranchRow {
  const report = buildReport({
    cwd: repo,
    mergePreview: false,
    overlaps: false,
    prs: false,
    sinceDays: null,
    submodules: false,
    worktreeState: false,
  });
  if (report == null) throw new Error('expected a report');
  const row = (report.branches ?? []).find((r) => r.name === branch);
  if (row == null) throw new Error(`no row for ${branch}`);
  return row;
}

describe('the AHEAD gap names the right cause', () => {
  test('a commit already on the baseline by content is NOT called a merge commit', () => {
    const sb = track(createSandbox());
    const repo = init(join(sb.path, 'work'));
    const base = commit(repo, 'README.md', 'x\n', 'initial');

    // The branch carries two commits. One of them is then cherry-picked onto
    // main, so `git cherry` reports it as `-` — patch-id present on the
    // baseline — while the branch history stays perfectly linear with NO merges.
    git(repo, ['checkout', '-q', '-b', 'feature', base]);
    const landed = commit(
      repo,
      'landed.txt',
      'shared\n',
      'work that also landed',
    );
    commit(repo, 'mine.txt', 'only here\n', 'work that did not');

    // Main moves FIRST, so the cherry-pick lands on a different parent and gets
    // a different sha. Without this the replay is byte-identical — same tree,
    // same parent, same message, same timestamp — and git reuses the very same
    // commit object, which is plain reachability rather than the patch-id
    // equivalence this test is about.
    git(repo, ['checkout', '-q', 'main']);
    commit(repo, 'theirs.txt', 'main work\n', 'main moves on');
    git(repo, ['cherry-pick', landed]);

    // Negative control for the fixture itself: if this branch had a merge
    // commit, the test below would prove nothing about the mislabelling.
    expect(
      git(repo, ['rev-list', '--count', '--merges', 'main..feature']),
    ).toBe('0');

    const row = rowFor(repo, 'feature');
    expect(row.ahead).toBe(2);
    expect(row.why).toContain('1 commit exists only here');
    expect(row.why).toContain('1 already on main by content');
    // THE REGRESSION: the old text said "also counts 1 merge commit" here.
    expect(row.why).not.toContain('merge commit');
  });

  test('a real merge commit IS called a merge commit', () => {
    const sb = track(createSandbox());
    const repo = init(join(sb.path, 'work'));
    const base = commit(repo, 'README.md', 'x\n', 'initial');

    git(repo, ['checkout', '-q', '-b', 'feature', base]);
    commit(repo, 'mine.txt', 'only here\n', 'branch work');

    git(repo, ['checkout', '-q', 'main']);
    commit(repo, 'theirs.txt', 'main work\n', 'main moves on');

    // Merge main INTO the branch: the tip advances, the merge carries no work
    // of its own, and `git cherry` does not list it.
    git(repo, ['checkout', '-q', 'feature']);
    git(repo, [
      'merge',
      '-q',
      '--no-ff',
      'main',
      '-m',
      'Merge main into feature',
    ]);

    const row = rowFor(repo, 'feature');
    expect(row.ahead).toBe(2);
    expect(row.why).toContain('1 commit exists only here');
    expect(row.why).toContain('1 merge commit');
    expect(row.why).not.toContain('by content');
  });

  test('both causes at once are reported separately, not summed', () => {
    const sb = track(createSandbox());
    const repo = init(join(sb.path, 'work'));
    const base = commit(repo, 'README.md', 'x\n', 'initial');

    git(repo, ['checkout', '-q', '-b', 'feature', base]);
    const landed = commit(
      repo,
      'landed.txt',
      'shared\n',
      'work that also landed',
    );
    commit(repo, 'mine.txt', 'only here\n', 'work that did not');

    // Main moves before the cherry-pick, for the same reason as above: a replay
    // onto the identical parent would produce the identical sha.
    git(repo, ['checkout', '-q', 'main']);
    commit(repo, 'theirs.txt', 'main work\n', 'main moves on');
    git(repo, ['cherry-pick', landed]);

    git(repo, ['checkout', '-q', 'feature']);
    git(repo, [
      'merge',
      '-q',
      '--no-ff',
      'main',
      '-m',
      'Merge main into feature',
    ]);

    const row = rowFor(repo, 'feature');
    expect(row.why).toContain('1 already on main by content');
    expect(row.why).toContain('1 merge commit');
  });

  test('no gap means no arithmetic in the sentence', () => {
    const sb = track(createSandbox());
    const repo = init(join(sb.path, 'work'));
    const base = commit(repo, 'README.md', 'x\n', 'initial');

    git(repo, ['checkout', '-q', '-b', 'feature', base]);
    commit(repo, 'mine.txt', 'only here\n', 'branch work');

    const row = rowFor(repo, 'feature');
    expect(row.ahead).toBe(1);
    expect(row.why).toContain('1 commit exists only here');
    expect(row.why).not.toContain('AHEAD 1 =');
  });
});
