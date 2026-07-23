/**
 * worktree-ignore.ts — detect whether a project ignores Claude Code's
 * background-job worktrees (`.claude/worktrees/<name>/`) on the surfaces that
 * matter.
 *
 * Those worktrees are full checkouts (own node_modules, and ios/Pods in RN
 * projects) that live INSIDE the repo. If a tool that walks the tree isn't told
 * to skip them it breaks: EAS archives balloon (a 5.3GB archive shipped once
 * because of this), and eslint + prettier lint the vendored copies, turning
 * `signal` red.
 *
 * There are THREE surfaces to enforce — NOT four. `tsconfig` needs nothing:
 * TypeScript's wildcard `include` globs skip dot-directories, so
 * `.claude/worktrees` is already invisible to `tsc`.
 *
 *   git      — must be covered by a COMMITTED ignore file so coverage travels
 *              with the repo. A match from only the personal global ignore
 *              (~/.config/git/ignore) or `.git/info/exclude` does NOT count —
 *              EAS Build and fresh clones can't see those. This is the crux.
 *   eslint   — flat/rc config `ignores` (ESLint 9 flat config only default-
 *              ignores node_modules/ and .git/) or a legacy `.eslintignore`.
 *   prettier — `.prettierignore`, OR the committed `.gitignore` (the prettier
 *              CLI's default ignore path is ['.gitignore', '.prettierignore']).
 *
 * Ignore matching for the gitignore-SYNTAX files (.gitignore, .prettierignore,
 * .eslintignore) uses the `ignore` package — the same parser prettier and
 * eslint use internally — not string-grepping. The git surface additionally
 * shells out to `git check-ignore` (git's own engine) to classify the
 * non-committed fallbacks. The eslint flat/rc config is minimatch globs in a JS
 * module, not a gitignore file, so no gitignore parser applies there.
 */

import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {isAbsolute, resolve, sep} from 'node:path';
import ignore from 'ignore';

/** A representative path under a live worktree — every surface is tested against it. */
export const WORKTREE_PROBE = '.claude/worktrees/probe.ts';

/** The canonical ignore line a fix should add. */
export const WORKTREE_IGNORE_LINE = '.claude/worktrees/';

function readIfExists(filePath: string): string | null {
  return existsSync(filePath) ? readFileSync(filePath, 'utf-8') : null;
}

/**
 * True if `content` (a gitignore-syntax file) ignores the worktree probe path,
 * per the `ignore` parser. Handles parent patterns (`.claude/`), directory
 * patterns (`.claude/worktrees/`), `**` globs, and in-file negations.
 */
export function ignoreContentCovers(content: string | null): boolean {
  if (content == null || content.trim() === '') return false;
  return ignore().add(content).ignores(WORKTREE_PROBE);
}

export type WorktreeGitStatus =
  | 'committed' // covered by a tracked ignore file — travels with the repo
  | 'ephemeral' // ignored only by the global ignore / .git/info/exclude
  | 'none' // not ignored by any layer
  | 'not-git'; // projectRoot is not a git repo — nothing to enforce

/**
 * Classify how `.claude/worktrees` is git-ignored, distinguishing coverage that
 * TRAVELS with the repo (committed) from coverage that doesn't (global ignore /
 * .git/info/exclude), which EAS Build and fresh clones cannot see.
 */
export function worktreeGitStatus(projectRoot: string): WorktreeGitStatus {
  if (!existsSync(resolve(projectRoot, '.git'))) return 'not-git';

  // Fast path: the committed top-level .gitignore is what a fix writes to and
  // covers the overwhelming majority of cases without spawning a subprocess.
  if (ignoreContentCovers(readIfExists(resolve(projectRoot, '.gitignore')))) {
    return 'committed';
  }

  // Otherwise ask git itself whether some OTHER layer ignores it, and where.
  let stdout: string;
  try {
    stdout = execFileSync(
      'git',
      ['check-ignore', '-v', '--no-index', WORKTREE_PROBE],
      {cwd: projectRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe']},
    ).trim();
  } catch {
    // Non-zero exit = not ignored by any layer (git check-ignore convention).
    return 'none';
  }
  if (stdout === '') return 'none';

  // `-v` output: "<source>:<line>:<pattern>\t<path>". A source that is an
  // absolute path (the personal global ignore) or lives under `.git/`
  // (info/exclude) does not travel; a committed file inside the repo does.
  const source = stdout.split(':')[0] ?? '';
  const absSource = isAbsolute(source) ? source : resolve(projectRoot, source);
  const travels =
    absSource.startsWith(projectRoot + sep) &&
    !absSource.includes(`${sep}.git${sep}`);
  return travels ? 'committed' : 'ephemeral';
}

const ESLINT_CONFIG_FILES = [
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintignore',
] as const;

export interface SurfaceStatus {
  /** Whether the tool is configured in this project at all. */
  applicable: boolean;
  /** Whether `.claude/worktrees` is ignored on this surface. */
  covered: boolean;
  /** The relevant config file (for messaging), or null. */
  configFile: string | null;
}

/**
 * Whether the eslint config ignores `.claude/worktrees`. `.eslintignore` is
 * gitignore syntax (parsed with `ignore`); flat/rc configs are JS glob arrays,
 * so we fall back to a textual pattern check for those.
 */
export function eslintWorktreeStatus(projectRoot: string): SurfaceStatus {
  const present = ESLINT_CONFIG_FILES.filter((name) =>
    existsSync(resolve(projectRoot, name)),
  );
  if (present.length === 0) {
    return {applicable: false, covered: false, configFile: null};
  }
  const covered = present.some((name) => {
    const content = readFileSync(resolve(projectRoot, name), 'utf-8');
    return name === '.eslintignore'
      ? ignoreContentCovers(content)
      : content.includes('.claude/worktrees');
  });
  return {applicable: true, covered, configFile: present[0] ?? null};
}

const PRETTIER_CONFIG_FILES = [
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.js',
  '.prettierrc.cjs',
  '.prettierrc.mjs',
  '.prettierrc.yaml',
  '.prettierrc.yml',
  'prettier.config.js',
  'prettier.config.cjs',
  'prettier.config.mjs',
] as const;

function hasPrettierDep(projectRoot: string): boolean {
  const content = readIfExists(resolve(projectRoot, 'package.json'));
  if (content == null) return false;
  try {
    const pkg = JSON.parse(content) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return (
      pkg.devDependencies?.prettier != null ||
      pkg.dependencies?.prettier != null
    );
  } catch {
    return false;
  }
}

/**
 * Whether prettier ignores `.claude/worktrees`. Passes if `.prettierignore`
 * covers it OR the committed `.gitignore` does (the prettier CLI reads
 * `.gitignore` by default), so the caller passes in the already-computed git
 * status to avoid re-running git.
 */
export function prettierWorktreeStatus(
  projectRoot: string,
  gitStatus: WorktreeGitStatus,
): SurfaceStatus {
  const prettierIgnorePath = resolve(projectRoot, '.prettierignore');
  const configured =
    existsSync(prettierIgnorePath) ||
    PRETTIER_CONFIG_FILES.some((name) =>
      existsSync(resolve(projectRoot, name)),
    ) ||
    hasPrettierDep(projectRoot);
  if (!configured) {
    return {applicable: false, covered: false, configFile: null};
  }
  if (gitStatus === 'committed') {
    return {applicable: true, covered: true, configFile: '.gitignore'};
  }
  const covered = ignoreContentCovers(readIfExists(prettierIgnorePath));
  return {applicable: true, covered, configFile: '.prettierignore'};
}
