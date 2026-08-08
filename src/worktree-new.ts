/**
 * worktree-new — create a worktree the way Claude Code does, then hydrate it.
 *
 * Split out of the hydration engine (src/setup-env.ts) when that engine was
 * repurposed as the general `setup-env` command (home-base-j2n7): creating
 * worktrees is `wt`'s job, hydrating any checkout is setup-env's. This module
 * owns the CREATE half and delegates hydration back to setupEnv().
 *
 * Shares setup-env's stdout contract (D1): the ONLY stdout line is the
 * absolute worktree path, which the `wt` zsh function captures to `cd`.
 */

import {existsSync} from 'node:fs';
import {join, resolve} from 'node:path';

import type {SetupEnvResult} from './setup-env';

import {
  BOLD,
  DIM,
  RED,
  RESET,
  YELLOW,
  gitSucceeds,
  report,
  resolvePrimaryCheckout,
  runChild,
  setupEnv,
  SLUG_PATTERN,
  WORKTREE_BRANCH_PREFIX,
  WORKTREE_DIR_SEGMENTS,
} from './setup-env';

/**
 * Slugs of nothing but dots — `.` and `..` — which SLUG_PATTERN happily accepts
 * because `.` is in its character class (finding F2). They are not names, they
 * are directory references: `..` makes the worktree path collapse to
 * `<primary>/.claude`, so `worktree-new ..` in a repo with no `.claude` yet
 * would attempt `git worktree add` AT the `.claude` directory itself. Every
 * other pure-dot form is equally meaningless, hence `+` not a literal pair.
 */
const PURE_DOT_SLUG_PATTERN = /^\.+$/;

export interface WorktreeNewOptions {
  /** Where the command was invoked; used to resolve the repo. Defaults to cwd. */
  cwd?: string;
  /** Skip hydration entirely (just create the worktree). */
  noSetup?: boolean;
  slug: string;
}

export interface WorktreeNewResult {
  /** `origin/HEAD` or `HEAD`, or null if creation never happened. */
  baseRef: string | null;
  branch: string;
  exitCode: number;
  /** Absolute worktree path — null if it was not created. */
  path: string | null;
  setup: SetupEnvResult | null;
}

/**
 * Create a worktree exactly the way Claude Code does — directory
 * `<primary>/.claude/worktrees/<slug>`, branch `worktree-<slug>` (D2) — and
 * then hydrate it.
 *
 * Prints the absolute worktree path as the ONLY stdout line, as soon as
 * creation succeeds: creation is the irreversible fact, so the `wt` zsh
 * function can still `cd` there to debug when hydration afterwards fails. The
 * exit code reflects hydration.
 *
 * Refuses rather than guesses when the name is partly taken: an existing
 * directory is the `wt` function's own switch-to-existing case, and an existing
 * branch with no directory would mean silently attaching to unknown work.
 */
export function worktreeNew(options: WorktreeNewOptions): WorktreeNewResult {
  const {slug} = options;
  const branch = `${WORKTREE_BRANCH_PREFIX}${slug}`;
  const cwd = resolve(options.cwd ?? process.cwd());
  const failed = (message: string): WorktreeNewResult => {
    report(`${RED}Error:${RESET} ${message}`);
    return {baseRef: null, branch, exitCode: 1, path: null, setup: null};
  };

  if (!SLUG_PATTERN.test(slug)) {
    return failed(
      `invalid slug ${JSON.stringify(slug)} — must match ${String(SLUG_PATTERN)} (no slashes: the slug names both the directory and the branch)`,
    );
  }
  if (PURE_DOT_SLUG_PATTERN.test(slug)) {
    return failed(
      `invalid slug ${JSON.stringify(slug)} — a slug of only dots is a directory reference, not a name (\`..\` would point the worktree at the \`.claude\` directory itself)`,
    );
  }

  const primary = resolvePrimaryCheckout(cwd);
  if (primary == null) {
    return failed(`not inside a git repository: ${cwd}`);
  }

  const worktreePath = join(primary, ...WORKTREE_DIR_SEGMENTS, slug);
  if (existsSync(worktreePath)) {
    return failed(
      `worktree directory already exists: ${worktreePath} (use \`wt\` to switch to it)`,
    );
  }
  if (
    gitSucceeds(
      ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
      cwd,
    )
  ) {
    return failed(
      `branch ${branch} already exists but ${worktreePath} does not — refusing to attach silently. Delete the branch, pick another slug, or create the worktree yourself.`,
    );
  }

  // origin/HEAD when it already resolves locally; never fetch (a create should
  // not block on the network).
  const baseRef = gitSucceeds(
    ['rev-parse', '--verify', '--quiet', 'origin/HEAD'],
    cwd,
  )
    ? 'origin/HEAD'
    : 'HEAD';
  report(`${BOLD}worktree-new${RESET} ${branch} ${DIM}from ${baseRef}${RESET}`);

  const add = runChild(
    ['git', 'worktree', 'add', '-b', branch, worktreePath, baseRef],
    cwd,
  );
  if (add.exitCode !== 0) {
    report(
      `${RED}Error:${RESET} git worktree add exited ${add.exitCode}${add.error == null ? '' : ` (${add.error})`}`,
    );
    return {baseRef, branch, exitCode: 1, path: null, setup: null};
  }

  // The one and only stdout line (D1).
  process.stdout.write(`${worktreePath}\n`);

  if (options.noSetup === true) {
    report(`  ${DIM}⊘ hydration skipped (--no-setup)${RESET}`);
    return {baseRef, branch, exitCode: 0, path: worktreePath, setup: null};
  }

  const setup = setupEnv({target: worktreePath});
  if (setup.exitCode !== 0) {
    report(
      `${YELLOW}⚠${RESET} worktree created at ${worktreePath} but hydration failed`,
    );
  }
  return {
    baseRef,
    branch,
    exitCode: setup.exitCode,
    path: worktreePath,
    setup,
  };
}
