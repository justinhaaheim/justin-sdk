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

/**
 * Create a standalone committed repo at `<sandbox>/<name>`, usable as a
 * submodule source. Same controlled-excludes discipline as initPrimary.
 */
export function initRepo(
  sb: Sandbox,
  name: string,
  files: Record<string, string>,
): string {
  const root = join(sb.path, name);
  mkdirSync(root, {recursive: true});
  git(root, ['init', '-q', '-b', 'main', '.']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);
  const excludes = join(root, '.git', 'controlled-excludes');
  writeFileSync(excludes, '');
  git(root, ['config', 'core.excludesFile', excludes]);
  for (const [relPath, content] of Object.entries(files)) {
    write(root, relPath, content);
  }
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'init']);
  return root;
}

/**
 * Register `source` as a submodule of `repo` at `relPath`, and commit it.
 *
 * `-c protocol.file.allow=always` is REQUIRED: git refuses the `file` transport
 * for submodules by default (CVE-2022-39253), and a fixture's submodule URL can
 * only be a local path. It is passed on the COMMAND LINE because git
 * deliberately ignores `protocol.*.allow` from repo-local config — verified,
 * setting it with `git config` in the fixture does nothing.
 */
export function addSubmodule(
  repo: string,
  source: string,
  relPath: string,
): void {
  git(repo, [
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    '-q',
    source,
    relPath,
  ]);
  git(repo, ['commit', '-qm', `add submodule ${relPath}`]);
}

/**
 * Run `fn` with git's file-transport restriction lifted for CHILD processes.
 *
 * The production code must never pass `-c protocol.file.allow=always` (real
 * consumers use https/ssh URLs, and hardcoding a protocol override in a command
 * that clones would be a security regression), so the fixture supplies it out of
 * band via the env instead. `GIT_ALLOW_PROTOCOL` is a whitelist, so `file` is
 * the ONLY protocol allowed inside `fn` — which is exactly right for a hermetic
 * test: any accidental network clone fails loudly.
 */
export function withFileSubmodulesAllowed<T>(fn: () => T): T {
  const previous = process.env.GIT_ALLOW_PROTOCOL;
  process.env.GIT_ALLOW_PROTOCOL = 'file';
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.GIT_ALLOW_PROTOCOL;
    } else {
      process.env.GIT_ALLOW_PROTOCOL = previous;
    }
  }
}
