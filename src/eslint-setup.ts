/**
 * eslint-setup.ts — Deterministic ESLint setup for any project.
 *
 * Orchestrates: package.json devDependencies (eslint + typescript +
 * eslint-config-jha-react-node pinned), eslint.config.cjs from template,
 * signal-source:LINT script, and convenience lint scripts.
 *
 * Runs base-setup as a precondition so the foundation layer is always
 * present before eslint-specific steps run.
 *
 * Idempotent: every step detects existing state and only writes when
 * something actually needs to change.
 *
 * Does NOT run `bun add` itself — it edits package.json directly so the
 * function is fast, offline, and unit-testable. The `justin-sdk init` orchestrator
 * (or the user) runs `bun install` once at the end to materialize the deps.
 *
 * Pinned-versions note: `@typescript-eslint/parser` and
 * `@typescript-eslint/eslint-plugin` are deliberately NOT installed here.
 * They come transitively via `eslint-config-jha-react-node` (which depends
 * on the unified `typescript-eslint` package). pinned-versions.ts also
 * deliberately omits them.
 */

import {cpSync, existsSync, readFileSync} from 'fs';
import {basename, resolve} from 'path';

import {runBaseSetup} from './base-setup';
import {PINNED, PINNED_GITHUB} from './pinned-versions';
import {
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
 * Ensure eslint, typescript, and eslint-config-jha-react-node are listed in
 * devDependencies at the pinned versions. Preserves existing devDeps.
 *
 * Behavior per package:
 *  - Missing → add at pinned version.
 *  - Present at pinned version → noop.
 *  - Present at a different version → warn and skip (unless force).
 *
 * Does NOT run `bun add` — the orchestrator runs `bun install` at the
 * end. Network is the orchestrator's problem.
 *
 * Note: @typescript-eslint/parser and @typescript-eslint/eslint-plugin
 * are deliberately NOT installed — they come transitively from
 * eslint-config-jha-react-node.
 */
function stepEslintDevDeps(projectRoot: string, force: boolean): boolean {
  const pkgPath = resolve(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) {
    fail('package.json not found — cannot add eslint devDependencies');
    return false;
  }

  const pkg = readJson(pkgPath);
  if (pkg == null) {
    fail('package.json is not valid JSON');
    return false;
  }

  const devDeps =
    (pkg.devDependencies as Record<string, string> | undefined) ?? {};
  let modified = false;

  const targets: {name: string; version: string}[] = [
    {name: 'eslint', version: PINNED.eslint},
    {name: 'typescript', version: PINNED.typescript},
    {
      name: 'eslint-config-jha-react-node',
      version: PINNED_GITHUB['eslint-config-jha-react-node'],
    },
  ];

  for (const {name, version} of targets) {
    const existing = devDeps[name];
    if (existing == null) {
      devDeps[name] = version;
      success(`Added ${name}@${version} to devDependencies`);
      modified = true;
    } else if (existing === version) {
      success(`${name} already at ${version}`);
    } else if (force) {
      devDeps[name] = version;
      success(`Overwrote ${name}: ${existing} → ${version} (--force)`);
      modified = true;
    } else {
      warn(
        `${name} is at ${existing}, SDK pins ${version}. ` +
          `Re-run with --force to overwrite.`,
      );
    }
  }

  if (modified) {
    pkg.devDependencies = devDeps;
    writeJson(pkgPath, pkg);
  }

  return true;
}

/**
 * Every flat-config filename ESLint will load. ESLint resolves them in this
 * order and uses the FIRST one it finds, so a repo with two of them has one
 * config that silently does nothing.
 */
export const ESLINT_CONFIG_NAMES: readonly string[] = [
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
];

export const ESLINT_CONFIG_TARGET = 'eslint.config.cjs';

/**
 * Write eslint.config.cjs from the template.
 *
 * Behavior:
 *  - A config under ANY of the four names already exists, and it is not our
 *    .cjs → write NOTHING, name the file that exists, and say so. `--force`
 *    does not override this: the SDK never creates a second flat config
 *    (Justin, 2026-09-16: "It adds eslint.config.cjs even if there's already
 *    eslint.config.js. BAD!" — home-base-dchjw.6).
 *  - Nothing exists → copy template to eslint.config.cjs.
 *  - Only eslint.config.cjs exists, matching the template → noop.
 *  - Only eslint.config.cjs exists and differs → warn + skip
 *    (user-customized), unless `force`, which overwrites that file.
 */
function stepEslintConfig(projectRoot: string, force: boolean): boolean {
  const targetPath = resolve(projectRoot, ESLINT_CONFIG_TARGET);
  const templatePath = resolve(
    import.meta.dirname,
    '..',
    'templates',
    'configs',
    'eslint.config.cjs',
  );
  if (!existsSync(templatePath)) {
    fail(`eslint.config.cjs template not found at ${templatePath}`);
    return false;
  }

  // Look for EVERY flat-config name, not just ours. Checking only .cjs is what
  // made the SDK drop a second config next to an existing eslint.config.js.
  const otherConfigs = ESLINT_CONFIG_NAMES.filter(
    (name) =>
      name !== ESLINT_CONFIG_TARGET && existsSync(resolve(projectRoot, name)),
  );

  if (otherConfigs.length > 0) {
    const names = otherConfigs.join(', ');
    warn(
      `${names} already present — not writing ${ESLINT_CONFIG_TARGET}. ` +
        `ESLint loads exactly one flat config, so a second one would be dead ` +
        `code. --force will not add one either; delete the existing config ` +
        `first if you want the SDK's.`,
    );
    if (existsSync(targetPath)) {
      warn(
        `${ESLINT_CONFIG_TARGET} exists alongside ${names} — ESLint reads only ` +
          `the first it finds. Delete all but one.`,
      );
    }
    return true;
  }

  if (!existsSync(targetPath)) {
    cpSync(templatePath, targetPath);
    success(`Copied ${ESLINT_CONFIG_TARGET} from template`);
    return true;
  }

  const templateContent = readFileSync(templatePath, 'utf-8');
  const existingContent = readFileSync(targetPath, 'utf-8');

  if (existingContent === templateContent) {
    success('eslint.config.cjs matches current template');
    return true;
  }

  if (force) {
    cpSync(templatePath, targetPath);
    success('Overwrote eslint.config.cjs (--force)');
    return true;
  }

  warn(
    'eslint.config.cjs differs from SDK template (user-customized). ' +
      'Re-run with --force to overwrite.',
  );
  return true;
}

export const SIGNAL_SOURCE_LINT_KEY = 'signal-source:LINT';
export const SIGNAL_SOURCE_LINT_SCRIPT =
  'eslint --report-unused-disable-directives --max-warnings 0 .';

export const LINT_SCRIPTS: readonly {key: string; value: string}[] = [
  {
    key: 'lint-base',
    value: 'eslint --report-unused-disable-directives --max-warnings 0',
  },
  {key: 'lint', value: 'bun run lint-base -- .'},
  {key: 'lint:fix', value: 'bun run lint-base -- --fix .'},
  {key: 'lint:fix:file', value: 'bun run lint-base -- --fix'},
  // Code-fix counterpart to signal-source:LINT, discovered by `justin-sdk fix`.
  // Plain `eslint --fix .` (no --max-warnings gate): a fixer should fix what it
  // can and only exit non-zero on remaining errors, not surviving warnings.
  {key: 'fix-source:LINT', value: 'eslint --fix .'},
];

/**
 * Ensure package.json has a `signal-source:LINT` script. Preserves all
 * other scripts. Only adds if missing.
 */
function stepSignalSourceScript(projectRoot: string): boolean {
  const pkgPath = resolve(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) {
    fail('package.json not found — cannot add signal-source:LINT script');
    return false;
  }

  const pkg = readJson(pkgPath);
  if (pkg == null) {
    fail('package.json is not valid JSON');
    return false;
  }

  const scripts = (pkg.scripts as Record<string, string> | undefined) ?? {};

  if (SIGNAL_SOURCE_LINT_KEY in scripts) {
    success(`${SIGNAL_SOURCE_LINT_KEY} script already present`);
    return true;
  }

  scripts[SIGNAL_SOURCE_LINT_KEY] = SIGNAL_SOURCE_LINT_SCRIPT;
  pkg.scripts = scripts;
  writeJson(pkgPath, pkg);
  success(
    `Added ${SIGNAL_SOURCE_LINT_KEY} script ("${SIGNAL_SOURCE_LINT_SCRIPT}")`,
  );
  return true;
}

/**
 * Add convenience lint scripts (lint-base, lint, lint:fix, lint:fix:file)
 * to package.json. Preserves any existing custom values — only adds keys
 * that are missing.
 */
function stepLintScripts(projectRoot: string): boolean {
  const pkgPath = resolve(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) {
    fail('package.json not found — cannot add lint scripts');
    return false;
  }

  const pkg = readJson(pkgPath);
  if (pkg == null) {
    fail('package.json is not valid JSON');
    return false;
  }

  const scripts = (pkg.scripts as Record<string, string> | undefined) ?? {};
  let modified = false;

  for (const {key, value} of LINT_SCRIPTS) {
    if (key in scripts) {
      success(`${key} script already present (preserved: "${scripts[key]}")`);
      continue;
    }
    scripts[key] = value;
    success(`Added ${key} script ("${value}")`);
    modified = true;
  }

  if (modified) {
    pkg.scripts = scripts;
    writeJson(pkgPath, pkg);
  }

  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface EslintSetupOptions {
  /**
   * Force-overwrite hand-modified files (eslint.config.cjs) and pinned
   * devDependency versions when they differ from what the SDK pins.
   */
  force?: boolean;
  /** Project root (defaults to cwd) */
  projectRoot?: string;
  /** Suppress non-error output (for tests and for use from other setup commands) */
  quiet?: boolean;
  /**
   * The remote the SDK pin tag is verified against, forwarded to base-setup.
   * Tests point it at a local bare repo so the install is hermetic; production
   * omits it and base-setup uses the real SDK_REPO_URL (dchjw.17 F7).
   */
  sdkRepoUrl?: string;
}

/**
 * Install the justin-sdk eslint-setup component in a project.
 *
 * Runs base-setup as a precondition so the foundation layer is always
 * present, registering 'eslint-setup' in justin-sdk.config.json.
 *
 * Does NOT run `bun install`. The `justin-sdk init` orchestrator (or the user)
 * runs that once at the end after all components are added.
 */
export async function runEslintSetup(
  options: EslintSetupOptions = {},
): Promise<number> {
  setQuiet(options.quiet ?? false);
  const quiet = options.quiet ?? false;
  const projectRoot = options.projectRoot ?? process.cwd();
  const force = options.force ?? false;

  if (!quiet) {
    console.log(
      `\n\x1b[1mSetting up eslint ${PINNED.eslint} in ${basename(projectRoot)}\x1b[0m\n`,
    );
  }

  // Step 0: Ensure base-setup is installed first (foundation layer).
  // Pre-registers 'eslint-setup' as a component so we don't have to
  // update justin-sdk.config.json twice.
  stepHeader('0. base-setup (foundation layer)');
  const baseExit = await runBaseSetup({
    projectRoot,
    quiet: true,
    // dchjw.17 F7: hermetic when a caller supplies a remote; the real
    // SDK_REPO_URL when nobody does.
    ...(options.sdkRepoUrl == null ? {} : {sdkRepoUrl: options.sdkRepoUrl}),
  });
  if (baseExit !== 0) {
    fail('base-setup failed — cannot proceed with eslint-setup');
    return baseExit;
  }
  // base-setup toggled quiet on/off internally; restore our own setting.
  setQuiet(quiet);
  success('base-setup ready');

  // Step 1: eslint + typescript + eslint-config-jha-react-node devDeps
  stepHeader(
    '1. package.json: eslint + typescript + eslint-config-jha-react-node devDependencies',
  );
  if (!stepEslintDevDeps(projectRoot, force)) return 1;

  // Step 2: eslint.config.cjs
  stepHeader('2. eslint.config.cjs');
  if (!stepEslintConfig(projectRoot, force)) return 1;

  // Step 3: signal-source:LINT script
  stepHeader('3. package.json: signal-source:LINT script');
  if (!stepSignalSourceScript(projectRoot)) return 1;

  // Step 4: convenience lint scripts + fix-source:LINT
  stepHeader(
    '4. package.json: lint scripts (lint, lint:fix, lint:fix:file, lint-base, fix-source:LINT)',
  );
  if (!stepLintScripts(projectRoot)) return 1;

  if (!quiet) {
    console.log(
      `\n\x1b[32m\x1b[1meslint-setup ready\x1b[0m in ${basename(projectRoot)}.\n`,
    );
    console.log(
      '  Run `bun install` to fetch eslint + eslint-config-jha-react-node locally (if not already installed).\n',
    );
  }

  return 0;
}
