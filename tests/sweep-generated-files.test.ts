/**
 * Tests for home-base-j8q3e.1.11: a sweep commit never carries generated state
 * that the primary checkout keeps out of git — above all git-lfs's hooks.
 *
 * THE DEFECT. In a repo with Git LFS and husky, git's hooks path is `.husky/_`.
 * husky creates it on `prepare`, together with a `.gitignore` of `*`; bun never
 * runs `prepare`, so a fresh sweep worktree has no `.husky/_` at all. The first
 * index refresh there runs git-lfs's filter, which writes git-lfs's four hooks
 * into the missing directory, and `git add -A` staged them. screenshot-app's
 * sweep commit e9a87c9 (2026-10-15) carried them, and the fast-forward then
 * overwrote the primary's ignored husky stubs with git-lfs's hooks.
 *
 * The git-lfs tests need a real `git-lfs` and are SKIPPED, visibly, where it is
 * absent. The legs that do not need git-lfs are tested hermetically below them.
 * Every git-lfs fixture sets the lfs filter in its OWN config, so the result
 * does not depend on whether the machine ran `git lfs install`.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {spawnSync} from 'child_process';
import {chmodSync, existsSync, mkdirSync, readFileSync} from 'fs';
import {join} from 'path';

import {
  addSweepWorktree,
  ignoredInPrimary,
  partitionGeneratedPaths,
  runSweep,
  stageForCommit,
} from '../src/sweep';
import {git, initPrimary, write} from './git-fixtures';
import {createSandbox, type Sandbox} from './sandbox';
import {captureLog, e2eRepo, expectNoSweepRemains} from './sweep-e2e-fixtures';

const sandboxes: Sandbox[] = [];
function track(sb: Sandbox): Sandbox {
  sandboxes.push(sb);
  return sb;
}
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

const HAS_GIT_LFS =
  spawnSync('git', ['lfs', 'version'], {stdio: 'ignore'}).status === 0;

/** The four hooks git-lfs 3.x installs, in `git diff --name-only` order. */
const LFS_HOOKS = [
  '.husky/_/post-checkout',
  '.husky/_/post-commit',
  '.husky/_/post-merge',
  '.husky/_/pre-push',
];

/** What husky's `prepare` leaves in the PRIMARY: stubs, kept out of git. */
const HUSKY_STUB = '#!/bin/sh\n# husky stub (fixture)\nexit 0\n';

/**
 * Turn `repo` into an LFS + husky repo the way screenshot-app and
 * nature-sounds are: lfs filter configured, one LFS-tracked file committed,
 * `core.hooksPath=.husky/_`, and the primary's husky stubs present but ignored.
 */
function makeLfsHuskyRepo(repo: string): void {
  git(repo, ['config', 'filter.lfs.process', 'git-lfs filter-process']);
  git(repo, ['config', 'filter.lfs.required', 'true']);
  git(repo, ['config', 'filter.lfs.clean', 'git-lfs clean -- %f']);
  git(repo, ['config', 'filter.lfs.smudge', 'git-lfs smudge -- %f']);
  write(repo, '.husky/_/.gitignore', '*\n');
  for (const hook of LFS_HOOKS) {
    write(repo, hook, HUSKY_STUB);
    chmodSync(join(repo, hook), 0o755);
  }
  git(repo, ['config', 'core.hooksPath', '.husky/_']);
  write(repo, '.gitattributes', '*.bin filter=lfs diff=lfs merge=lfs -text\n');
  write(repo, 'sound.bin', 'not really audio\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '--no-verify', '-qm', 'add an LFS file']);
}

/**
 * An LFS + husky primary and a sweep worktree of it, made by the sweep's own
 * `addSweepWorktree` (hooks off), after one `git status` there — the index
 * refresh every gate does. Returns both paths.
 */
function lfsWorktree(sb: Sandbox): {primary: string; worktree: string} {
  const primary = initPrimary(sb, {
    '.gitignore': 'node_modules/\n',
    '.husky/pre-commit': 'bun run lint-staged\n',
    'package.json': '{"name": "fixture"}\n',
  });
  makeLfsHuskyRepo(primary);
  const worktree = join(sb.path, 'sweep-worktree');
  const base = git(primary, ['rev-parse', 'main']).trim();
  const add = addSweepWorktree(primary, worktree, 'sweep-fixture', base);
  if (!add.ok) throw new Error(add.detail);
  git(worktree, ['status', '--porcelain']);
  return {primary, worktree};
}

// ---------------------------------------------------------------------------
// Pure partition
// ---------------------------------------------------------------------------

describe('partitionGeneratedPaths', () => {
  test('husky generated dir is excluded by name, even when the primary ignores nothing', () => {
    expect(
      partitionGeneratedPaths(['.husky/_/post-commit', 'package.json'], []),
    ).toEqual({commit: ['package.json'], generated: ['.husky/_/post-commit']});
  });

  test('a path the primary ignores is excluded', () => {
    expect(
      partitionGeneratedPaths(['gen/out.txt', 'package.json'], ['gen/out.txt']),
    ).toEqual({commit: ['package.json'], generated: ['gen/out.txt']});
  });

  test('husky own hooks and lookalike siblings are kept', () => {
    // `.husky/pre-commit` is the repo's real, tracked hook; only `.husky/_/`
    // is husky's generated directory.
    const paths = ['.husky/pre-commit', '.husky/_x', '.husky/_'];
    expect(partitionGeneratedPaths(paths, [])).toEqual({
      commit: paths,
      generated: [],
    });
  });
});

// ---------------------------------------------------------------------------
// The primary's ignore rules (hermetic: no git-lfs needed)
// ---------------------------------------------------------------------------

describe('ignoredInPrimary', () => {
  test('reports the paths an untracked .gitignore in the primary ignores', () => {
    const sb = track(createSandbox());
    const primary = initPrimary(sb, {'package.json': '{}\n'});
    write(primary, 'gen/.gitignore', '*\n');

    expect(ignoredInPrimary(primary, ['gen/out.txt', 'package.json'])).toEqual([
      'gen/out.txt',
    ]);
  });

  test('none ignored is an empty list, not a failure (git exits 1)', () => {
    const sb = track(createSandbox());
    const primary = initPrimary(sb, {'package.json': '{}\n'});

    expect(ignoredInPrimary(primary, ['package.json', 'new.txt'])).toEqual([]);
  });

  test('a TRACKED file that matches an ignore pattern is not reported', () => {
    const sb = track(createSandbox());
    const primary = initPrimary(
      sb,
      {'.gitignore': '*.log\n', 'keep.log': 'tracked on purpose\n'},
      {forceAdd: ['keep.log']},
    );

    expect(ignoredInPrimary(primary, ['keep.log', 'new.log'])).toEqual([
      'new.log',
    ]);
  });

  test('a primary git cannot read is null, never "none ignored"', () => {
    const sb = track(createSandbox());
    const notARepo = join(sb.path, 'not-a-repo');
    mkdirSync(notARepo);

    expect(ignoredInPrimary(notARepo, ['package.json'])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// stageForCommit, hermetic legs
// ---------------------------------------------------------------------------

describe('stageForCommit leaves out generated state (hermetic)', () => {
  test('a primary that never ran prepare: .husky/_ files are still left out', () => {
    const sb = track(createSandbox());
    const primary = initPrimary(sb, {'package.json': '{}\n'});
    write(primary, 'package.json', '{"changed": true}\n');
    write(primary, '.husky/_/post-commit', 'git lfs post-commit "$@"\n');

    const result = stageForCommit(primary, {mode: 'full'}, primary);

    if (result.kind !== 'staged') throw new Error(result.detail);
    expect(result.staged).toEqual(['package.json']);
    expect(result.generated).toEqual(['.husky/_/post-commit']);
  });

  test('a file the primary ignores is left out; a tracked look-alike is committed', () => {
    const sb = track(createSandbox());
    const primary = initPrimary(
      sb,
      {'.gitignore': '*.log\n', 'keep.log': 'v1\n'},
      {forceAdd: ['keep.log']},
    );
    const worktree = join(sb.path, 'wt');
    git(primary, ['worktree', 'add', '-q', '-b', 'wt', worktree, 'main']);
    // In the primary only: the untracked .gitignore a tool writes for itself.
    write(primary, 'gen/.gitignore', '*\n');
    write(worktree, 'gen/out.txt', 'generated\n');
    write(worktree, 'keep.log', 'v2\n');

    const result = stageForCommit(worktree, {mode: 'full'}, primary);

    if (result.kind !== 'staged') throw new Error(result.detail);
    expect(result.staged).toEqual(['keep.log']);
    expect(result.generated).toEqual(['gen/out.txt']);
    // Un-staged, not deleted.
    expect(existsSync(join(worktree, 'gen', 'out.txt'))).toBe(true);
  });

  test('NEGATIVE CONTROL: the same worktree checked against itself stages gen/out.txt', () => {
    // Proves the test above passes because of the PRIMARY's ignore rules, not
    // because the worktree already ignored the file.
    const sb = track(createSandbox());
    const primary = initPrimary(sb, {'package.json': '{}\n'});
    const worktree = join(sb.path, 'wt');
    git(primary, ['worktree', 'add', '-q', '-b', 'wt', worktree, 'main']);
    write(primary, 'gen/.gitignore', '*\n');
    write(worktree, 'gen/out.txt', 'generated\n');

    const result = stageForCommit(worktree, {mode: 'full'}, worktree);

    if (result.kind !== 'staged') throw new Error(result.detail);
    expect(result.staged).toEqual(['gen/out.txt']);
    expect(result.generated).toEqual([]);
  });

  test('a primary git cannot read makes staging UNMEASURABLE, not a commit', () => {
    const sb = track(createSandbox());
    const primary = initPrimary(sb, {'package.json': '{}\n'});
    write(primary, 'package.json', '{"changed": true}\n');
    const notARepo = join(sb.path, 'not-a-repo');
    mkdirSync(notARepo);

    const result = stageForCommit(primary, {mode: 'full'}, notARepo);

    expect(result.kind).toBe('unmeasurable');
  });
});

// ---------------------------------------------------------------------------
// The real thing: git-lfs writing its hooks into a sweep worktree
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_GIT_LFS)('git-lfs hooks in a sweep worktree', () => {
  test('PRECONDITION: git-lfs writes its four hooks into the worktree, unignored', () => {
    // Without this, every test below could pass because nothing was written.
    const sb = track(createSandbox());
    const {worktree} = lfsWorktree(sb);

    for (const hook of LFS_HOOKS) {
      expect(readFileSync(join(worktree, hook), 'utf-8')).toContain('git lfs');
    }
    expect(git(worktree, ['status', '--porcelain'])).toContain('?? .husky/_/');
  });

  test('stageForCommit stages the payload and NOT the git-lfs hooks', () => {
    const sb = track(createSandbox());
    const {primary, worktree} = lfsWorktree(sb);
    write(worktree, 'package.json', '{"name": "fixture", "swept": true}\n');

    const result = stageForCommit(worktree, {mode: 'full'}, primary);

    if (result.kind !== 'staged') throw new Error(result.detail);
    expect(result.staged).toEqual(['package.json']);
    expect(result.generated).toEqual(LFS_HOOKS);
    // Asserted against git itself: this is what the commit would capture.
    expect(git(worktree, ['diff', '--cached', '--name-only']).trim()).toBe(
      'package.json',
    );
  });

  test('NEGATIVE CONTROL: plain `git add -A` on the same worktree stages the hooks', () => {
    // The pre-fix staging, on the same fixture: the defect is real here.
    const sb = track(createSandbox());
    const {worktree} = lfsWorktree(sb);
    write(worktree, 'package.json', '{"name": "fixture", "swept": true}\n');

    git(worktree, ['add', '-A']);

    expect(
      git(worktree, ['diff', '--cached', '--name-only'])
        .split('\n')
        .filter((line) => line !== ''),
    ).toEqual([...LFS_HOOKS, 'package.json']);
  });

  test('a whole sweep commits no .husky/_ file and leaves the primary husky stubs alone', async () => {
    const sb = track(createSandbox());
    const repo = e2eRepo(sb, 'lfs-husky');
    makeLfsHuskyRepo(repo);
    // The real gates refresh the index (`git status` and friends), and that
    // refresh is what runs git-lfs's filter in the worktree. The fixture's
    // signal does the same, or git-lfs would first run inside the sweep's own
    // `git add -A`, after the add has already listed the untracked files.
    write(
      repo,
      'scripts/fixture-signal.ts',
      [
        "import {execFileSync} from 'node:child_process';",
        "execFileSync('git', ['status', '--porcelain'], {stdio: 'inherit'});",
        "console.log('fixture signal: green');",
        '',
      ].join('\n'),
    );
    git(repo, ['add', '-A']);
    git(repo, ['commit', '--no-verify', '-qm', 'signal refreshes the index']);
    const before = git(repo, ['rev-parse', 'main']).trim();
    const logDir = join(sb.path, 'logs');

    const {out, value} = await captureLog(() =>
      runSweep({component: 'gitignore', logDir, repos: [repo]}),
    );

    expect(value).toBe(0);
    // The sweep made a commit (the gitignore payload)…
    const sweepCommit = git(repo, ['rev-parse', 'main']).trim();
    expect(sweepCommit).not.toBe(before);
    // …that holds no generated hook…
    const committed = git(repo, [
      'diff-tree',
      '--no-commit-id',
      '--name-only',
      '-r',
      'main',
    ]);
    expect(committed).toContain('.gitignore');
    expect(committed).not.toContain('.husky/_');
    // …and the run says which generated files it left out, which also proves
    // git-lfs really wrote them in the sweep worktree.
    expect(out).toContain(
      'generated state the primary keeps out of git: .husky/_/post-checkout',
    );
    // The damage screenshot-app took: the primary's stubs overwritten.
    for (const hook of LFS_HOOKS) {
      expect(readFileSync(join(repo, hook), 'utf-8')).toBe(HUSKY_STUB);
    }
    expect(git(repo, ['status', '--porcelain'])).toBe('');
    expectNoSweepRemains(repo);
  });
});
