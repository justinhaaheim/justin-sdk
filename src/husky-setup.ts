/**
 * husky-setup.ts — Deterministic husky + lint-staged setup for any project.
 *
 * Orchestrates: package.json devDependencies (husky + lint-staged pinned),
 * package.json `prepare` script, `.husky/pre-commit` hook (chmod +x), and
 * a default `lint-staged` config in package.json.
 *
 * Runs base-setup as a precondition so the foundation layer is always
 * present before husky-specific steps run.
 *
 * Idempotent: every step detects existing state and only writes when
 * something actually needs to change.
 *
 * Does NOT run `bun add` or `bun run prepare` itself — it edits package.json
 * directly so the function is fast, offline, and unit-testable. The `j init`
 * orchestrator (or the user) runs `bun install` once at the end, which will
 * automatically execute the `prepare` script and wire husky into `.git/`.
 */

import {chmodSync, cpSync, existsSync, readFileSync} from 'fs';
import {basename, resolve} from 'path';

import {runBaseSetup} from './base-setup';
import {PINNED} from './pinned-versions';
import {
  ensureDir,
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

const DEFAULT_LINT_STAGED_CONFIG: Record<string, string[]> = {
  '*.{ts,tsx,js,jsx,cjs,mjs}': ['bun run lint-base -- --fix', 'prettier --write'],
  '*.{json,md,yml,yaml}': ['prettier --write'],
};

interface DevDepSpec {
  name: 'husky' | 'lint-staged';
  pinned: string;
}

const HUSKY_DEV_DEPS: ReadonlyArray<DevDepSpec> = [
  {name: 'husky', pinned: PINNED.husky},
  {name: 'lint-staged', pinned: PINNED['lint-staged']},
];

/**
 * Ensure husky + lint-staged are listed in devDependencies at PINNED versions.
 *
 * Per-package behavior:
 *  - Missing → add at PINNED version.
 *  - Present at PINNED version → noop.
 *  - Present at a different version → warn and leave alone unless `force`.
 *
 * Does NOT run `bun add` (no network, no install). The orchestrator runs
 * `bun install` once at the end.
 */
function stepHuskyDeps(projectRoot: string, force: boolean): boolean {
  const pkgPath = resolve(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) {
    fail('package.json not found — cannot add husky/lint-staged deps');
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
  let modified = false;

  for (const {name, pinned} of HUSKY_DEV_DEPS) {
    const existing = devDeps[name];
    if (existing == null) {
      devDeps[name] = pinned;
      modified = true;
      success(`Added ${name}@${pinned} to devDependencies`);
      continue;
    }
    if (existing === pinned) {
      success(`${name}@${pinned} already in devDependencies`);
      continue;
    }
    if (force) {
      devDeps[name] = pinned;
      modified = true;
      success(`Overwrote ${name} devDependency to ${pinned} (--force)`);
      continue;
    }
    warn(
      `${name} devDependency is ${existing}, pinned is ${pinned} — leaving as-is. Re-run with --force to overwrite.`,
    );
  }

  if (modified) {
    pkg.devDependencies = devDeps;
    writeJson(pkgPath, pkg);
  }
  return true;
}

const PREPARE_SCRIPT_VALUE = 'husky';

/**
 * Ensure package.json has a `prepare` script set to `"husky"`.
 *
 * Behavior:
 *  - Missing → add as `"husky"`.
 *  - Present and equal to `"husky"` → noop.
 *  - Present at any other value → warn + skip (projects often layer multiple
 *    prepare actions). Do NOT overwrite, even with `--force` — leave the
 *    user's setup intact; they likely need their custom prepare command.
 */
function stepPrepareScript(projectRoot: string): boolean {
  const pkgPath = resolve(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) {
    fail('package.json not found — cannot add prepare script');
    return false;
  }

  const pkg = readJson(pkgPath);
  if (pkg == null) {
    fail('package.json is not valid JSON');
    return false;
  }

  const scripts = ((pkg.scripts as Record<string, string> | undefined) ??
    {}) as Record<string, string>;
  const existing = scripts.prepare;

  if (existing == null) {
    scripts.prepare = PREPARE_SCRIPT_VALUE;
    pkg.scripts = scripts;
    writeJson(pkgPath, pkg);
    success(`Added "prepare" script ("${PREPARE_SCRIPT_VALUE}")`);
    return true;
  }

  if (existing === PREPARE_SCRIPT_VALUE) {
    success('"prepare" script already set to "husky"');
    return true;
  }

  warn(
    `package.json already has a "prepare" script ("${existing}") — leaving as-is. Make sure it invokes husky if you want git hooks installed.`,
  );
  return true;
}

/**
 * Write `.husky/pre-commit` from the SDK template and ensure it's executable.
 *
 * Behavior:
 *  - Ensures `.husky/` exists.
 *  - Missing file → copy from template.
 *  - Exists and matches template → noop.
 *  - Exists and differs → warn + skip (unless `force`).
 *  - `force: true` → overwrite.
 *  - In all cases where the file ends up present, chmod +x to make it
 *    executable (husky requires this).
 */
function stepPreCommitHook(projectRoot: string, force: boolean): boolean {
  const huskyDir = resolve(projectRoot, '.husky');
  const targetPath = resolve(huskyDir, 'pre-commit');
  const templatePath = resolve(
    import.meta.dirname,
    '..',
    'templates',
    'configs',
    '.husky',
    'pre-commit',
  );

  if (!existsSync(templatePath)) {
    fail(`.husky/pre-commit template not found at ${templatePath}`);
    return false;
  }

  ensureDir(huskyDir);

  const templateContent = readFileSync(templatePath, 'utf-8');

  if (!existsSync(targetPath)) {
    cpSync(templatePath, targetPath);
    chmodSync(targetPath, 0o755);
    success('Copied .husky/pre-commit from template (chmod +x)');
    return true;
  }

  const existingContent = readFileSync(targetPath, 'utf-8');

  if (existingContent === templateContent) {
    // Ensure executable bit is set even if file content matches.
    chmodSync(targetPath, 0o755);
    success('.husky/pre-commit matches current template');
    return true;
  }

  if (force) {
    cpSync(templatePath, targetPath);
    chmodSync(targetPath, 0o755);
    success('Overwrote .husky/pre-commit (--force, chmod +x)');
    return true;
  }

  warn(
    '.husky/pre-commit differs from SDK template (user-customized). Re-run with --force to overwrite.',
  );
  return true;
}

/**
 * Ensure package.json has a `lint-staged` config block.
 *
 * Behavior:
 *  - Missing → add the default config.
 *  - Present at any value → leave alone (lint-staged is intentionally
 *    customized often; no warn).
 */
function stepLintStagedConfig(projectRoot: string): boolean {
  const pkgPath = resolve(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) {
    fail('package.json not found — cannot add lint-staged config');
    return false;
  }

  const pkg = readJson(pkgPath);
  if (pkg == null) {
    fail('package.json is not valid JSON');
    return false;
  }

  if ('lint-staged' in pkg) {
    success('lint-staged config already present in package.json');
    return true;
  }

  pkg['lint-staged'] = {...DEFAULT_LINT_STAGED_CONFIG};
  writeJson(pkgPath, pkg);
  success('Added default lint-staged config to package.json');
  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface HuskySetupOptions {
  /** Project root (defaults to cwd) */
  projectRoot?: string;
  /** Suppress non-error output (for tests and chaining) */
  quiet?: boolean;
  /**
   * Force-overwrite hand-modified .husky/pre-commit and any husky/lint-staged
   * devDependency versions that differ from PINNED. Does NOT overwrite a
   * user's existing `prepare` script — that's always preserved.
   */
  force?: boolean;
}

/**
 * Install the justin-sdk husky-setup component in a project.
 *
 * Runs base-setup as a precondition so the foundation layer is always
 * present, registering 'husky-setup' in justin-sdk.config.json.
 *
 * Does NOT run `bun install` or `bun run prepare`. The `j init` orchestrator
 * (or the user) runs `bun install` once at the end after all components are
 * added, which automatically executes the `prepare` script and wires husky
 * into `.git/hooks/`.
 */
export async function runHuskySetup(
  options: HuskySetupOptions = {},
): Promise<number> {
  setQuiet(options.quiet ?? false);
  const quiet = options.quiet ?? false;
  const projectRoot = options.projectRoot ?? process.cwd();
  const force = options.force ?? false;

  if (!quiet) {
    console.log(
      `\n\x1b[1mSetting up husky ${PINNED.husky} + lint-staged ${PINNED['lint-staged']} in ${basename(projectRoot)}\x1b[0m\n`,
    );
  }

  // Step 0: Ensure base-setup is installed first (foundation layer).
  stepHeader('0. base-setup (foundation layer)');
  const baseExit = await runBaseSetup({
    projectRoot,
    quiet: true,
    extraComponents: ['husky-setup'],
  });
  if (baseExit !== 0) {
    fail('base-setup failed — cannot proceed with husky-setup');
    return baseExit;
  }
  // base-setup toggled quiet on/off internally; restore our own setting.
  setQuiet(quiet);
  success('base-setup ready');

  // Step 1: husky + lint-staged in package.json devDependencies
  stepHeader('1. package.json: husky + lint-staged devDependencies');
  if (!stepHuskyDeps(projectRoot, force)) return 1;

  // Step 2: prepare script in package.json
  stepHeader('2. package.json: "prepare" script');
  if (!stepPrepareScript(projectRoot)) return 1;

  // Step 3: .husky/pre-commit hook
  stepHeader('3. .husky/pre-commit');
  if (!stepPreCommitHook(projectRoot, force)) return 1;

  // Step 4: lint-staged config in package.json
  stepHeader('4. package.json: lint-staged config');
  if (!stepLintStagedConfig(projectRoot)) return 1;

  if (!quiet) {
    console.log(
      `\n\x1b[32m\x1b[1mhusky-setup ready\x1b[0m in ${basename(projectRoot)}.\n`,
    );
    console.log(
      '  Run `bun install` to fetch husky + lint-staged locally and let `prepare` wire the git hooks.\n',
    );
  }

  return 0;
}
