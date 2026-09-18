/**
 * gh-actions-setup.ts — Installs a standard GitHub Actions workflow that
 * runs `bun run signal` on push/PR.
 *
 * Runs base-setup as a precondition so the foundation layer is always
 * present before the workflow file is written. It does NOT register itself in
 * justin-sdk.config.json — `add` writes `components` (constraint F11).
 *
 * Idempotent: every step detects existing state and only writes when
 * something actually needs to change.
 */

import {cpSync, existsSync, readFileSync} from 'fs';
import {basename, resolve} from 'path';

import {runBaseSetup} from './base-setup';
import {
  ensureDir,
  fail,
  setQuiet,
  stepHeader,
  success,
  warn,
} from './setup-helpers';

// ---------------------------------------------------------------------------
// Step implementations
// ---------------------------------------------------------------------------

export const WORKFLOW_RELATIVE_PATH = '.github/workflows/signal.yml';

function getTemplatePath(): string {
  return resolve(
    import.meta.dirname,
    '..',
    'templates',
    'configs',
    '.github',
    'workflows',
    'signal.yml',
  );
}

/**
 * Ensure `.github/workflows/` exists.
 */
function stepEnsureWorkflowsDir(projectRoot: string): boolean {
  const workflowsDir = resolve(projectRoot, '.github', 'workflows');
  if (existsSync(workflowsDir)) {
    success('.github/workflows/ already exists');
    return true;
  }
  ensureDir(workflowsDir);
  success('Created .github/workflows/');
  return true;
}

/**
 * Write `.github/workflows/signal.yml` from the SDK template.
 *
 * Behavior:
 *  - If missing → copy template.
 *  - If exists and matches template → success noop.
 *  - If exists and differs → warn and skip (unless `force: true`).
 *  - If `force: true` → overwrite.
 */
function stepWriteSignalWorkflow(projectRoot: string, force: boolean): boolean {
  const targetPath = resolve(projectRoot, WORKFLOW_RELATIVE_PATH);
  const templatePath = getTemplatePath();

  if (!existsSync(templatePath)) {
    fail(`signal.yml template not found at ${templatePath}`);
    return false;
  }

  const templateContent = readFileSync(templatePath, 'utf-8');

  if (!existsSync(targetPath)) {
    cpSync(templatePath, targetPath);
    success(`Copied ${WORKFLOW_RELATIVE_PATH} from template`);
    return true;
  }

  const existingContent = readFileSync(targetPath, 'utf-8');
  if (existingContent === templateContent) {
    success(`${WORKFLOW_RELATIVE_PATH} matches current template`);
    return true;
  }

  if (force) {
    cpSync(templatePath, targetPath);
    success(`Overwrote ${WORKFLOW_RELATIVE_PATH} (--force)`);
    return true;
  }

  warn(
    `${WORKFLOW_RELATIVE_PATH} differs from SDK template (hand-modified or unrecognized version). ` +
      'Re-run with --force to overwrite.',
  );
  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface GhActionsSetupOptions {
  /** Project root (defaults to cwd) */
  projectRoot?: string;
  /** Suppress non-error output (for tests and chaining) */
  quiet?: boolean;
  /** Overwrite an existing hand-modified signal.yml */
  force?: boolean;
  /**
   * The remote the SDK pin tag is verified against, forwarded to base-setup.
   * Tests point it at a local bare repo so the install is hermetic; production
   * omits it and base-setup uses the real SDK_REPO_URL (dchjw.17 F7).
   */
  sdkRepoUrl?: string;
}

/**
 * Install the gh-actions-setup component into a project.
 *
 * Calls runBaseSetup first as a precondition, then writes the signal.yml
 * workflow.
 */
export async function runGhActionsSetup(
  options: GhActionsSetupOptions = {},
): Promise<number> {
  setQuiet(options.quiet ?? false);
  const quiet = options.quiet ?? false;
  const projectRoot = options.projectRoot ?? process.cwd();
  const force = options.force ?? false;

  if (!quiet) {
    console.log(
      `\n\x1b[1mInstalling justin-sdk gh-actions-setup in ${basename(projectRoot)}\x1b[0m\n`,
    );
  }

  // Step 0: Ensure base-setup is installed first.
  stepHeader('0. base-setup (foundation layer)');
  const baseExit = await runBaseSetup({
    projectRoot,
    quiet: true,
    // dchjw.17 F7: hermetic when a caller supplies a remote; the real
    // SDK_REPO_URL when nobody does.
    ...(options.sdkRepoUrl == null ? {} : {sdkRepoUrl: options.sdkRepoUrl}),
  });
  if (baseExit !== 0) {
    fail('base-setup failed — cannot proceed with gh-actions-setup');
    return baseExit;
  }
  // base-setup toggled quiet on/off internally; restore our own setting.
  setQuiet(quiet);
  success('base-setup ready');

  // Step 1: Ensure .github/workflows/ exists
  stepHeader('1. .github/workflows/');
  if (!stepEnsureWorkflowsDir(projectRoot)) return 1;

  // Step 2: Write signal.yml workflow
  stepHeader('2. .github/workflows/signal.yml');
  if (!stepWriteSignalWorkflow(projectRoot, force)) return 1;

  if (!quiet) {
    console.log(
      `\n\x1b[32m\x1b[1mgh-actions-setup ready\x1b[0m in ${basename(projectRoot)}.\n`,
    );
  }

  return 0;
}
