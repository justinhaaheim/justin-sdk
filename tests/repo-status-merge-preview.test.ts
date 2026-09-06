/**
 * Does this branch still merge? — and the trap that makes it hard to ask.
 *
 * `git merge-tree --write-tree` answers exactly, in the object store, with no
 * worktree and no index. The catch, measured 2026-09-06 on git 2.50.1, is that
 * its exit code cannot be read on its own:
 *
 *   conflict ....................... exit 1,   stdout starts with a tree OID
 *   `not something we can merge` .... exit 1,   stdout EMPTY
 *   `refusing unrelated histories` .. exit 128, stdout EMPTY
 *
 * Both ways of guessing from that number are wrong and they fail in opposite
 * directions. Treating every non-zero exit as "could not measure" — which is
 * what `core.ts`'s `gitArgv` would have done, since it collapses all of them to
 * null — buries every real conflict in noise. Treating exit 1 as "conflicts"
 * reports a broken ref as a measured merge result. So there are tests here for
 * both, and neither may pass by accident.
 *
 * THE ORACLE TEST is the load-bearing one: it does not compare the preview
 * against a hand-written expectation, it runs a REAL `git merge` in a scratch
 * clone of the same fixture and requires that git's own outcome and the
 * preview's verdict agree, branch for branch.
 *
 * Part of home-base-qyu1.33.2.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {execFileSync, spawnSync} from 'child_process';
import {writeFileSync} from 'fs';
import {join} from 'path';

import {previewMerge} from '../src/repo-status/merge-preview';
import {buildReport} from '../src/repo-status/report';
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
  return execFileSync('git', args, {cwd, encoding: 'utf-8', stdio: 'pipe'}).trim();
}

function commit(repo: string, file: string, body: string, msg: string): string {
  writeFileSync(join(repo, file), body);
  git(repo, ['add', '--', file]);
  git(repo, ['commit', '-q', '-m', msg]);
  return git(repo, ['rev-parse', 'HEAD']);
}

/**
 * One repo with a branch of each merge outcome.
 *
 *   clean-branch     touches a file main never touched     -> merges cleanly
 *   conflict-branch  edits the same line main edited        -> conflicts
 *   contained        no unique commits at all               -> nothing to preview
 */
function buildFixture(sb: Sandbox): string {
  const repo = sb.path;
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  const base = commit(repo, 'shared.txt', 'original\n', 'initial');

  git(repo, ['checkout', '-q', '-b', 'clean-branch', base]);
  commit(repo, 'only-here.txt', 'independent\n', 'independent work');

  git(repo, ['checkout', '-q', '-b', 'conflict-branch', base]);
  commit(repo, 'shared.txt', 'branch version\n', 'branch edits shared');

  git(repo, ['checkout', '-q', '-b', 'contained', base]);

  git(repo, ['checkout', '-q', 'main']);
  commit(repo, 'shared.txt', 'main version\n', 'main edits shared');

  return repo;
}

describe('merge preview', () => {
  test('a clean merge is reported clean, with an empty conflict list', () => {
    const repo = buildFixture(track(createSandbox()));
    const preview = previewMerge('main', 'clean-branch', repo);

    expect(preview.kind).toBe('clean');
    expect(preview.conflictedFiles).toEqual([]);
    expect(preview.conflictedFileCount).toBe(0);
    expect(preview.command).toBeNull();
  });

  test('a conflicting merge is CONFLICTS, not unmeasured, and names the file', () => {
    const repo = buildFixture(track(createSandbox()));
    const preview = previewMerge('main', 'conflict-branch', repo);

    // The whole point: merge-tree exited 1 here, exactly as it does for a ref
    // it cannot resolve, and this must not be confused with a failure.
    expect(preview.kind).toBe('conflicts');
    expect(preview.conflictedFiles).toEqual(['shared.txt']);
    expect(preview.conflictedFileCount).toBe(1);
  });

  test('a ref git cannot resolve is UNMEASURED, not clean and not conflicts', () => {
    const repo = buildFixture(track(createSandbox()));
    const preview = previewMerge('main', 'no-such-branch', repo);

    expect(preview.kind).toBe('unmeasured');
    expect(preview.conflictedFiles).toBeNull();
    expect(preview.conflictedFileCount).toBeNull();
    // The failed command travels with the verdict so it can be re-run by hand.
    expect(preview.command).toContain('merge-tree');
    expect(preview.why).toContain('UNKNOWN');
  });

  test('unrelated histories are UNMEASURED', () => {
    const sb = track(createSandbox());
    const repo = sb.path;
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'Test']);
    commit(repo, 'a.txt', 'a\n', 'main');
    git(repo, ['checkout', '-q', '--orphan', 'stranger']);
    git(repo, ['rm', '-q', '-rf', '.']);
    commit(repo, 'b.txt', 'b\n', 'stranger');
    git(repo, ['checkout', '-q', 'main']);

    // git exits 128 here, not 1 — a third exit code, and the reason the
    // discriminator is the presence of a merged tree rather than the number.
    expect(previewMerge('main', 'stranger', repo).kind).toBe('unmeasured');
  });

  test('a path containing a newline stays ONE conflicted path', () => {
    const sb = track(createSandbox());
    const repo = sb.path;
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'Test']);
    const weird = 'two\nlines.txt';
    const base = commit(repo, weird, 'original\n', 'initial');

    git(repo, ['checkout', '-q', '-b', 'side', base]);
    commit(repo, weird, 'side\n', 'side edit');
    git(repo, ['checkout', '-q', 'main']);
    commit(repo, weird, 'main\n', 'main edit');

    const preview = previewMerge('main', 'side', repo);
    expect(preview.kind).toBe('conflicts');
    // Newline-separated parsing would have reported two invented paths here.
    expect(preview.conflictedFiles).toEqual([weird]);
    expect(preview.conflictedFileCount).toBe(1);
  });

  test('a branch with nothing to merge gets NO preview, never a clean one', () => {
    const repo = buildFixture(track(createSandbox()));
    const report = buildReport({
      content: false,
      cwd: repo,
      overlaps: false,
      prs: false,
      sinceDays: null,
      submodules: false,
    });
    const contained = report?.branches?.find((b) => b.name === 'contained');

    expect(contained?.ahead).toBe(0);
    // `null` is "not previewed". Reporting `clean` would be a claim about a
    // merge nobody performed.
    expect(contained?.mergePreview).toBeNull();
  });

  test('the preview leaves the working tree and index untouched', () => {
    const repo = buildFixture(track(createSandbox()));
    const before = git(repo, ['status', '--porcelain=v1']);
    const head = git(repo, ['rev-parse', 'HEAD']);

    previewMerge('main', 'conflict-branch', repo);

    expect(git(repo, ['status', '--porcelain=v1'])).toBe(before);
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(head);
    // A real merge that conflicted would have left MERGE_HEAD behind.
    expect(
      spawnSync('git', ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], {
        cwd: repo,
      }).status,
    ).not.toBe(0);
  });

  test('ORACLE: the verdict matches what a real `git merge` does', () => {
    const sb = track(createSandbox());
    const repo = buildFixture(sb);

    for (const branch of ['clean-branch', 'conflict-branch']) {
      const preview = previewMerge('main', branch, repo);

      // A throwaway clone, so the real merge cannot disturb the fixture.
      const clone = join(sb.path, `clone-${branch}`);
      execFileSync('git', ['clone', '-q', repo, clone], {stdio: 'pipe'});
      git(clone, ['config', 'user.email', 'test@example.com']);
      git(clone, ['config', 'user.name', 'Test']);
      const merge = spawnSync(
        'git',
        ['merge', '--no-edit', `origin/${branch}`],
        {cwd: clone, stdio: 'pipe'},
      );
      const reallyConflicted = merge.status !== 0;

      expect(preview.kind).toBe(reallyConflicted ? 'conflicts' : 'clean');
    }
  });
});
