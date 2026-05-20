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
 * function is fast, offline, and unit-testable. The `j init` orchestrator
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

  const devDeps = ((pkg.devDependencies as
    | Record<string, string>
    | undefined) ?? {}) as Record<string, string>;
  let modified = false;

  const targets: Array<{name: string; version: string}> = [
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
 * Write eslint.config.cjs from the template.
 *
 * Behavior:
 *  - Missing → copy template.
 *  - Exists and matches template byte-for-byte → noop.
 *  - Exists and differs → warn + skip (user-customized), unless `force`.
 */
function stepEslintConfig(projectRoot: string, force: boolean): boolean {
  const targetPath = resolve(projectRoot, 'eslint.config.cjs');
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

  if (!existsSync(targetPath)) {
    cpSync(templatePath, targetPath);
    success('Copied eslint.config.cjs from template');
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

const SIGNAL_SOURCE_LINT_KEY = 'signal-source:LINT';
const SIGNAL_SOURCE_LINT_SCRIPT =
  'eslint --report-unused-disable-directives --max-warnings 0 .';

const LINT_SCRIPTS: ReadonlyArray<{key: string; value: string}> = [
  {
    key: 'lint-base',
    value: 'eslint --report-unused-disable-directives --max-warnings 0',
  },
  {key: 'lint', value: 'bun run lint-base -- .'},
  {key: 'lint:fix', value: 'bun run lint-base -- --fix .'},
  {key: 'lint:fix:file', value: 'bun run lint-base -- --fix'},
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

  const scripts = ((pkg.scripts as Record<string, string> | undefined) ??
    {}) as Record<string, string>;

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

  const scripts = ((pkg.scripts as Record<string, string> | undefined) ??
    {}) as Record<string, string>;
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
  /** Project root (defaults to cwd) */
  projectRoot?: string;
  /** Suppress non-error output (for tests and for use from other setup commands) */
  quiet?: boolean;
  /**
   * Force-overwrite hand-modified files (eslint.config.cjs) and pinned
   * devDependency versions when they differ from what the SDK pins.
   */
  force?: boolean;
}

/**
 * Install the justin-sdk eslint-setup component in a project.
 *
 * Runs base-setup as a precondition so the foundation layer is always
 * present, registering 'eslint-setup' in justin-sdk.config.json.
 *
 * Does NOT run `bun install`. The `j init` orchestrator (or the user)
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
    extraComponents: ['eslint-setup'],
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

  // Step 4: convenience lint scripts
  stepHeader(
    '4. package.json: lint convenience scripts (lint, lint:fix, lint:fix:file, lint-base)',
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
