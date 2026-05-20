/**
 * prettier-setup.ts — Deterministic prettier setup for any project.
 *
 * Orchestrates: package.json devDependencies (prettier pinned), .prettierrc.json,
 * .prettierignore, package.json signal-source:PRETTIER script, and the
 * prettier-setup component registration.
 *
 * Runs base-setup as a precondition so the foundation layer is always
 * present before prettier-specific steps run.
 *
 * Idempotent: every step detects existing state and only writes when
 * something actually needs to change.
 *
 * Does NOT run `bun add` itself — it edits package.json directly so the
 * function is fast, offline, and unit-testable. The `j init` orchestrator
 * (or the user) runs `bun install` once at the end to materialize the dep.
 */

import {cpSync, existsSync, readFileSync} from 'fs';
import {basename, resolve} from 'path';

import {runBaseSetup} from './base-setup';
import {PINNED} from './pinned-versions';
import {
  appendIfMissing,
  fail,
  readJson,
  setQuiet,
  stepHeader,
  success,
  warn,
  writeJson,
} from './setup-helpers';

// ---------------------------------------------------------------------------
// Step implementations
// ---------------------------------------------------------------------------

/**
 * Ensure prettier is listed in devDependencies at the PINNED version.
 *
 * Behavior:
 *  - Missing → add at PINNED.prettier.
 *  - Present at PINNED.prettier → noop.
 *  - Present at a different version → warn and leave alone unless `force`.
 *
 * Does NOT run `bun add` (no network, no install). The orchestrator runs
 * `bun install` once at the end.
 */
function stepPrettierDep(projectRoot: string, force: boolean): boolean {
  const pkgPath = resolve(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) {
    fail('package.json not found — cannot add prettier dep');
    return false;
  }

  const pkg = readJson(pkgPath);
  if (pkg == null) {
    fail('package.json is not valid JSON');
    return false;
  }

  const devDeps = ((pkg.devDependencies as
    | Record<string, string>
    | undefined) ?? {}) as Record<string, string>;
  const target = PINNED.prettier;
  const existing = devDeps.prettier;

  if (existing == null) {
    devDeps.prettier = target;
    pkg.devDependencies = devDeps;
    writeJson(pkgPath, pkg);
    success(`Added prettier@${target} to devDependencies`);
    return true;
  }

  if (existing === target) {
    success(`prettier@${target} already in devDependencies`);
    return true;
  }

  if (force) {
    devDeps.prettier = target;
    pkg.devDependencies = devDeps;
    writeJson(pkgPath, pkg);
    success(`Overwrote prettier devDependency to ${target} (--force)`);
    return true;
  }

  warn(
    `prettier devDependency is ${existing}, pinned is ${target} — leaving as-is. Re-run with --force to overwrite.`,
  );
  return true;
}

/**
 * Write .prettierrc.json from the template.
 *
 * Behavior:
 *  - Missing → copy template.
 *  - Exists and matches template byte-for-byte → noop.
 *  - Exists and differs → warn + skip (user-customized), unless `force`.
 */
function stepPrettierrc(projectRoot: string, force: boolean): boolean {
  const targetPath = resolve(projectRoot, '.prettierrc.json');
  const templatePath = resolve(
    import.meta.dirname,
    '..',
    'templates',
    'configs',
    '.prettierrc.json',
  );
  if (!existsSync(templatePath)) {
    fail(`.prettierrc.json template not found at ${templatePath}`);
    return false;
  }

  if (!existsSync(targetPath)) {
    cpSync(templatePath, targetPath);
    success('Copied .prettierrc.json from template');
    return true;
  }

  const templateContent = readFileSync(templatePath, 'utf-8');
  const existingContent = readFileSync(targetPath, 'utf-8');

  if (existingContent === templateContent) {
    success('.prettierrc.json matches current template');
    return true;
  }

  if (force) {
    cpSync(templatePath, targetPath);
    success('Overwrote .prettierrc.json (--force)');
    return true;
  }

  warn(
    '.prettierrc.json differs from SDK template (user-customized). ' +
      'Re-run with --force to overwrite.',
  );
  return true;
}

const PRETTIERIGNORE_BASELINE_ENTRIES: ReadonlyArray<string> = [
  'node_modules',
  'dist',
  'build',
  'coverage',
  '*.tsbuildinfo',
  '.beads',
  'tmp',
  '*.log',
];

/**
 * Write .prettierignore from the template.
 *
 * Behavior:
 *  - Missing → copy template (which already contains all baseline entries).
 *  - Exists and matches template byte-for-byte → noop.
 *  - Exists and differs → warn + skip overwrite, but `appendIfMissing` each
 *    of the baseline entries so we never leave a project missing essentials.
 *  - `force` → overwrite with template.
 */
function stepPrettierignore(projectRoot: string, force: boolean): boolean {
  const targetPath = resolve(projectRoot, '.prettierignore');
  const templatePath = resolve(
    import.meta.dirname,
    '..',
    'templates',
    'configs',
    '.prettierignore',
  );
  if (!existsSync(templatePath)) {
    fail(`.prettierignore template not found at ${templatePath}`);
    return false;
  }

  if (!existsSync(targetPath)) {
    cpSync(templatePath, targetPath);
    success('Copied .prettierignore from template');
    return true;
  }

  const templateContent = readFileSync(templatePath, 'utf-8');
  const existingContent = readFileSync(targetPath, 'utf-8');

  if (existingContent === templateContent) {
    success('.prettierignore matches current template');
    return true;
  }

  if (force) {
    cpSync(templatePath, targetPath);
    success('Overwrote .prettierignore (--force)');
    return true;
  }

  // User-customized file. Don't overwrite — but make sure baseline entries
  // are present (append any that are missing).
  let appendedAny = false;
  for (const entry of PRETTIERIGNORE_BASELINE_ENTRIES) {
    const added = appendIfMissing(targetPath, entry, `\n${entry}\n`);
    if (added) {
      success(`Appended ${entry} to .prettierignore`);
      appendedAny = true;
    }
  }
  if (!appendedAny) {
    success(
      '.prettierignore already has all baseline entries (user-customized)',
    );
  } else {
    warn(
      '.prettierignore differs from SDK template (user-customized). Baseline entries were appended where missing. Re-run with --force to overwrite entirely.',
    );
  }
  return true;
}

const SIGNAL_SOURCE_PRETTIER_SCRIPT = 'prettier --check .';
const SIGNAL_SOURCE_PRETTIER_KEY = 'signal-source:PRETTIER';

/**
 * Ensure package.json has a `signal-source:PRETTIER` script.
 * Preserves all other scripts. Only adds if missing.
 */
function stepSignalSourceScript(projectRoot: string): boolean {
  const pkgPath = resolve(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) {
    fail('package.json not found — cannot add signal-source:PRETTIER script');
    return false;
  }

  const pkg = readJson(pkgPath);
  if (pkg == null) {
    fail('package.json is not valid JSON');
    return false;
  }

  const scripts = ((pkg.scripts as Record<string, string> | undefined) ??
    {}) as Record<string, string>;

  if (SIGNAL_SOURCE_PRETTIER_KEY in scripts) {
    success(`${SIGNAL_SOURCE_PRETTIER_KEY} script already present`);
    return true;
  }

  scripts[SIGNAL_SOURCE_PRETTIER_KEY] = SIGNAL_SOURCE_PRETTIER_SCRIPT;
  pkg.scripts = scripts;
  writeJson(pkgPath, pkg);
  success(
    `Added ${SIGNAL_SOURCE_PRETTIER_KEY} script ("${SIGNAL_SOURCE_PRETTIER_SCRIPT}")`,
  );
  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface PrettierSetupOptions {
  /** Project root (defaults to cwd) */
  projectRoot?: string;
  /** Suppress non-error output (for tests and for use from other setup commands) */
  quiet?: boolean;
  /**
   * Force-overwrite hand-modified files (.prettierrc.json, .prettierignore)
   * and the prettier devDependency version.
   */
  force?: boolean;
}

/**
 * Install the justin-sdk prettier-setup component in a project.
 *
 * Runs base-setup as a precondition so the foundation layer is always
 * present, registering 'prettier-setup' in justin-sdk.config.json.
 *
 * Does NOT run `bun install`. The `j init` orchestrator (or the user)
 * runs that once at the end after all components are added.
 */
export async function runPrettierSetup(
  options: PrettierSetupOptions = {},
): Promise<number> {
  setQuiet(options.quiet ?? false);
  const quiet = options.quiet ?? false;
  const projectRoot = options.projectRoot ?? process.cwd();
  const force = options.force ?? false;

  if (!quiet) {
    console.log(
      `\n\x1b[1mSetting up prettier ${PINNED.prettier} in ${basename(projectRoot)}\x1b[0m\n`,
    );
  }

  // Step 0: Ensure base-setup is installed first (foundation layer).
  stepHeader('0. base-setup (foundation layer)');
  const baseExit = await runBaseSetup({
    projectRoot,
    quiet: true,
    extraComponents: ['prettier-setup'],
  });
  if (baseExit !== 0) {
    fail('base-setup failed — cannot proceed with prettier-setup');
    return baseExit;
  }
  // base-setup toggled quiet on/off internally; restore our own setting.
  setQuiet(quiet);
  success('base-setup ready');

  // Step 1: prettier in package.json devDependencies
  stepHeader('1. package.json: prettier devDependency');
  if (!stepPrettierDep(projectRoot, force)) return 1;

  // Step 2: .prettierrc.json
  stepHeader('2. .prettierrc.json');
  if (!stepPrettierrc(projectRoot, force)) return 1;

  // Step 3: .prettierignore
  stepHeader('3. .prettierignore');
  if (!stepPrettierignore(projectRoot, force)) return 1;

  // Step 4: signal-source:PRETTIER script
  stepHeader('4. package.json: signal-source:PRETTIER script');
  if (!stepSignalSourceScript(projectRoot)) return 1;

  if (!quiet) {
    console.log(
      `\n\x1b[32m\x1b[1mprettier-setup ready\x1b[0m in ${basename(projectRoot)}.\n`,
    );
    console.log(
      '  Run `bun install` to fetch prettier locally (if not already installed).\n',
    );
  }

  return 0;
}
