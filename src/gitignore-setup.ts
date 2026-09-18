/**
 * gitignore-setup.ts — Install a richer baseline .gitignore for justin-sdk
 * projects.
 *
 * Composes on top of base-setup. base-setup.stepGitignore handles the
 * narrow set of must-haves (tmp/, dynamic-version.local.*). This component
 * installs the fuller baseline used across all of Justin's node-CLI
 * projects: node_modules, dist, build, coverage, logs, OS junk,
 * local-env patterns, beads recovery dirs, eslint cache, etc.
 *
 * Behavior:
 *  - If .gitignore is missing → copy the template verbatim.
 *  - If .gitignore exists → reconcile the baseline through
 *    `ensureIgnoreEntries`: append what is missing (one grouped section),
 *    rewrite a near-miss spelling to the canonical one, collapse repeats.
 *
 * Idempotent: re-running produces no spurious changes. Preserves any
 * user-added entries.
 */

import {copyFileSync, existsSync} from 'fs';
import {basename, resolve} from 'path';

import {runBaseSetup} from './base-setup';
import {
  ensureIgnoreEntries,
  fail,
  setQuiet,
  stepHeader,
  success,
} from './setup-helpers';

// ---------------------------------------------------------------------------
// Baseline entries
// ---------------------------------------------------------------------------

/**
 * The fuller baseline of .gitignore entries every justin-sdk node-CLI
 * project should have. Order matters when appending into an existing
 * .gitignore (we keep the order stable so re-runs produce the same diff).
 *
 * `.env` and `.env.local` are deliberately ABSENT (Justin, 2026-09-18,
 * home-base-dchjw.6). The local-only pattern across his repos is exactly the
 * three `*.local` lines below, which already cover `.env.local`; a bare `.env`
 * is not a pattern his projects use, and the SDK adding one to every repo was
 * noise. Existing `.env` lines in a consumer's file are left untouched — this
 * list only says what the SDK ADDS.
 */
export const BASELINE_ENTRIES: ReadonlyArray<string> = [
  'node_modules/',
  'dist/',
  'build/',
  'coverage/',
  '*.log',
  '*.tsbuildinfo',
  '.DS_Store',
  '*.local',
  '*.local.json',
  '*.local.*',
  'tmp/',
  '.bv/',
  '.beads/.br_recovery/',
  '.beads/.local_version',
  'dynamic-version.local.json',
  'dynamic-version.local.d.ts',
  '.eslintcache',
  '.claude/worktrees/',
];

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function stepGitignoreFile(projectRoot: string): boolean {
  const gitignorePath = resolve(projectRoot, '.gitignore');
  const templatePath = resolve(
    import.meta.dirname,
    '..',
    'templates',
    'configs',
    '.gitignore.node-cli',
  );

  if (!existsSync(templatePath)) {
    fail(`gitignore template not found at ${templatePath}`);
    return false;
  }

  if (!existsSync(gitignorePath)) {
    copyFileSync(templatePath, gitignorePath);
    success('Created .gitignore from template');
    return true;
  }

  const result = ensureIgnoreEntries(gitignorePath, BASELINE_ENTRIES, {
    sectionHeader: 'justin-sdk baseline (appended)',
  });

  if (!result.changed) {
    success('.gitignore already has baseline entries');
    return true;
  }

  if (result.added.length > 0) {
    success(`Added ${result.added.length} baseline entries to .gitignore`);
  }
  for (const {from, to} of result.rewritten) {
    success(
      `Rewrote .gitignore entry '${from}' → '${to}' (same paths, one spelling)`,
    );
  }
  for (const entry of result.removed) {
    success(`Removed a duplicate .gitignore entry '${entry}'`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface GitignoreSetupOptions {
  /** Project root (defaults to cwd) */
  projectRoot?: string;
  /** Suppress non-error output (useful for tests / chained setup commands) */
  quiet?: boolean;
  /**
   * Reserved for future use. The gitignore component has no
   * destructive-overwrite path today, so this currently has no effect.
   */
  force?: boolean;
  /**
   * The remote the SDK pin tag is verified against, forwarded to base-setup.
   * Tests point it at a local bare repo so the install is hermetic; production
   * omits it and base-setup uses the real SDK_REPO_URL (dchjw.17 F7).
   */
  sdkRepoUrl?: string;
}

/**
 * Install the richer .gitignore baseline in a project. Runs base-setup
 * as a precondition so the foundation layer is in place.
 */
export async function runGitignoreSetup(
  options: GitignoreSetupOptions = {},
): Promise<number> {
  setQuiet(options.quiet ?? false);
  const quiet = options.quiet ?? false;
  const projectRoot = options.projectRoot ?? process.cwd();

  if (!quiet) {
    console.log(
      `\n\x1b[1mInstalling gitignore-setup in ${basename(projectRoot)}\x1b[0m\n`,
    );
  }

  // Step 0: Ensure base-setup is installed first (foundation layer).
  // Pre-register 'gitignore-setup' as a component so we don't have to
  // update the config file twice. base-setup.stepGitignore will run too,
  // but its narrow appends are subsumed by our fuller baseline — both
  // remain idempotent.
  stepHeader('0. base-setup (foundation layer)');
  const baseExit = await runBaseSetup({
    projectRoot,
    quiet: true,
    // dchjw.17 F7: hermetic when a caller supplies a remote; the real
    // SDK_REPO_URL when nobody does.
    ...(options.sdkRepoUrl == null ? {} : {sdkRepoUrl: options.sdkRepoUrl}),
  });
  if (baseExit !== 0) {
    fail('base-setup failed — cannot proceed with gitignore-setup');
    return baseExit;
  }
  // base-setup toggles quiet internally; restore our setting.
  setQuiet(quiet);
  success('base-setup ready');

  // Step 1: .gitignore (fuller baseline)
  stepHeader('1. .gitignore (full baseline)');
  if (!stepGitignoreFile(projectRoot)) return 1;

  if (!quiet) {
    console.log(
      `\n\x1b[32m\x1b[1mgitignore-setup ready\x1b[0m in ${basename(projectRoot)}.\n`,
    );
  }

  return 0;
}
