/**
 * Real-git fixture helpers, shared by the worktree tests.
 *
 * Fixtures are real git repos in $TMPDIR because the behavior under test IS git
 * behavior — worktree admin files, `--git-dir` vs `--git-common-dir`,
 * `check-ignore`'s index awareness — so mocking git would test nothing.
 *
 * Every fixture repo pins `core.excludesFile` to an empty controlled file. The
 * machine's real global ignore (~/.config/git/ignore) DOES ignore
 * .claude/worktrees on Justin's machine, and these tests turn on exactly which
 * files are gitignored, so without this they would pass or fail depending on the
 * host.
 *
 * Extracted from tests/worktree-setup.test.ts (dispatch 1), unchanged.
 */

import {execFileSync} from 'child_process';
import {mkdirSync, writeFileSync} from 'fs';
import {dirname, join} from 'path';

import {type Sandbox} from './sandbox';

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** Write a file under `root`, creating parent directories. */
export function write(root: string, relPath: string, content: string): void {
  const full = join(root, relPath);
  mkdirSync(dirname(full), {recursive: true});
  writeFileSync(full, content);
}

/**
 * Create a committed git repo at `<sandbox>/primary` containing `files`.
 * Anything matching the repo's own .gitignore stays untracked (`git add -A`
 * honors it), which is how the gitignored fixtures are made.
 */
export function initPrimary(
  sb: Sandbox,
  files: Record<string, string>,
  options?: {
    /**
     * Paths to `git add -f`, i.e. track them even though .gitignore matches.
     * That combination — tracked AND ignore-pattern-matched — is the only way
     * to exercise `git check-ignore`'s index awareness.
     */
    forceAdd?: string[];
  },
): string {
  const primary = join(sb.path, 'primary');
  mkdirSync(primary, {recursive: true});
  git(primary, ['init', '-q', '-b', 'main', '.']);
  git(primary, ['config', 'user.email', 'test@example.com']);
  git(primary, ['config', 'user.name', 'Test']);
  const excludes = join(primary, '.git', 'controlled-excludes');
  writeFileSync(excludes, '');
  git(primary, ['config', 'core.excludesFile', excludes]);
  for (const [relPath, content] of Object.entries(files)) {
    write(primary, relPath, content);
  }
  git(primary, ['add', '-A']);
  for (const relPath of options?.forceAdd ?? []) {
    git(primary, ['add', '-f', '--', relPath]);
  }
  git(primary, ['commit', '-qm', 'init']);
  return primary;
}

export function addLinkedWorktree(
  primary: string,
  dest: string,
  branch: string,
): string {
  mkdirSync(dirname(dest), {recursive: true});
  git(primary, ['worktree', 'add', '-q', '-b', branch, dest, 'main']);
  return dest;
}
