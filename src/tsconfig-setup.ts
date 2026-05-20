/**
 * tsconfig-setup.ts — Deterministic installer for the TypeScript layer
 * of the justin-sdk component stack.
 *
 * Installs:
 *  - typescript + @types/bun in package.json devDependencies (pinned via
 *    src/pinned-versions.ts). Edits package.json directly — does NOT run
 *    `bun add`. The orchestrator runs `bun install` at the end.
 *  - tsconfig.json copied from templates/configs/tsconfig.node-cli.json.
 *  - "signal-source:TS": "tsc --noEmit" script in package.json.
 *
 * Runs base-setup as a precondition so the foundation layer is always
 * present (and 'tsconfig-setup' gets registered in justin-sdk.config.json's
 * components array up-front).
 *
 * Idempotent: every step detects existing state and only writes when
 * something actually needs to change. Existing devDep versions and
 * tsconfig.json contents are preserved unless `force: true`, in which
 * case tsconfig.json gets overwritten.
 *
 * Justin targets Bun, not Node — `@types/node` is intentionally NOT
 * installed (and is intentionally absent from pinned-versions.ts).
 */

import {cpSync, existsSync, readFileSync} from 'fs';
import {basename, resolve} from 'path';

import {runBaseSetup} from './base-setup';
import {PINNED} from './pinned-versions';
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
 * Ensure typescript and @types/bun are declared in package.json
 * devDependencies at the pinned versions. Preserves existing devDeps.
 *
 * Behavior per package:
 *  - Missing → add at pinned version.
 *  - Present at pinned version → noop.
 *  - Present at a different version → warn and skip (unless force).
 *
 * Does NOT run `bun add` — the orchestrator runs `bun install` at the
 * end of the full setup sequence. Keeps this step fast and offline.
 *
 * Note: @types/node is intentionally NOT installed. Justin's projects
 * target Bun, and pinned-versions.ts deliberately does not export it.
 */
export function stepTypescriptDevDeps(
  projectRoot: string,
  force = false,
): boolean {
  const pkgPath = resolve(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) {
    fail('package.json not found — cannot add typescript devDependencies');
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

  const targets: Array<{name: 'typescript' | '@types/bun'; version: string}> = [
    {name: 'typescript', version: PINNED.typescript},
    {name: '@types/bun', version: PINNED['@types/bun']},
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
 * Write tsconfig.json from the templates/configs/tsconfig.node-cli.json
 * template.
 *
 * Behavior:
 *  - Missing → copy template.
 *  - Exists and matches template byte-for-byte → noop.
 *  - Exists and differs → warn and skip (recommend --force).
 *  - force: true → overwrite from template.
 */
export function stepTsconfigJson(projectRoot: string, force = false): boolean {
  const targetPath = resolve(projectRoot, 'tsconfig.json');
  const templatePath = resolve(
    import.meta.dirname,
    '..',
    'templates',
    'configs',
    'tsconfig.node-cli.json',
  );
  if (!existsSync(templatePath)) {
    fail(`tsconfig template not found at ${templatePath}`);
    return false;
  }

  if (!existsSync(targetPath)) {
    cpSync(templatePath, targetPath);
    success('Created tsconfig.json from template');
    return true;
  }

  const templateContent = readFileSync(templatePath, 'utf-8');
  const existingContent = readFileSync(targetPath, 'utf-8');

  if (existingContent === templateContent) {
    success('tsconfig.json matches current template');
    return true;
  }

  if (force) {
    cpSync(templatePath, targetPath);
    success('Overwrote tsconfig.json from template (--force)');
    return true;
  }

  warn(
    'tsconfig.json differs from SDK template (hand-modified or older). ' +
      'Re-run with --force to overwrite.',
  );
  return true;
}

/**
 * Add `signal-source:TS` script to package.json if missing. Preserves
 * existing scripts (including custom signal-source:TS values).
 */
export function stepSignalSourceTsScript(projectRoot: string): boolean {
  const pkgPath = resolve(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) {
    fail('package.json not found — cannot add signal-source:TS script');
    return false;
  }

  const pkg = readJson(pkgPath);
  if (pkg == null) {
    fail('package.json is not valid JSON');
    return false;
  }

  const scripts = ((pkg.scripts as Record<string, string> | undefined) ??
    {}) as Record<string, string>;

  if (scripts['signal-source:TS'] != null) {
    success(
      `signal-source:TS script already present: "${scripts['signal-source:TS']}"`,
    );
    return true;
  }

  scripts['signal-source:TS'] = 'tsc --noEmit';
  pkg.scripts = scripts;
  writeJson(pkgPath, pkg);
  success('Added signal-source:TS script to package.json');
  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface TsconfigSetupOptions {
  /** Project root (defaults to cwd) */
  projectRoot?: string;
  /** Suppress non-error output (for tests / nested invocation) */
  quiet?: boolean;
  /**
   * Force-overwrite files that already exist and differ from the SDK's
   * current expected state (currently: tsconfig.json + devDep versions).
   */
  force?: boolean;
}

/**
 * Install the tsconfig component layer in a project.
 *
 * Runs base-setup first (idempotent) so the foundation is in place, then
 * adds typescript + @types/bun to devDependencies, writes tsconfig.json
 * from the SDK template, and registers the `signal-source:TS` script.
 *
 * The orchestrator that wires multiple `j add ...` components together is
 * responsible for running `bun install` once at the end — this function
 * does NOT install packages itself.
 */
export async function runTsconfigSetup(
  options: TsconfigSetupOptions = {},
): Promise<number> {
  setQuiet(options.quiet ?? false);
  const quiet = options.quiet ?? false;
  const projectRoot = options.projectRoot ?? process.cwd();
  const force = options.force ?? false;

  if (!quiet) {
    console.log(
      `\n\x1b[1mInstalling justin-sdk tsconfig-setup in ${basename(projectRoot)}\x1b[0m\n`,
    );
  }

  // Step 0: Ensure base-setup is installed first (foundation layer).
  // Pre-registers 'tsconfig-setup' as a component so we don't have to
  // update justin-sdk.config.json twice.
  stepHeader('0. base-setup (foundation layer)');
  const baseExit = await runBaseSetup({
    projectRoot,
    quiet: true,
    extraComponents: ['tsconfig-setup'],
  });
  if (baseExit !== 0) {
    fail('base-setup failed — cannot proceed with tsconfig-setup');
    return baseExit;
  }
  // base-setup toggles quiet internally; restore our own setting.
  setQuiet(quiet);
  success('base-setup ready');

  stepHeader('1. package.json: typescript + @types/bun devDependencies');
  if (!stepTypescriptDevDeps(projectRoot, force)) return 1;

  stepHeader('2. tsconfig.json');
  if (!stepTsconfigJson(projectRoot, force)) return 1;

  stepHeader('3. package.json: signal-source:TS script');
  if (!stepSignalSourceTsScript(projectRoot)) return 1;

  if (!quiet) {
    console.log(
      `\n\x1b[32m\x1b[1mtsconfig-setup ready\x1b[0m in ${basename(projectRoot)}. ` +
        `Run \`bun install\` to fetch typescript + @types/bun.\n`,
    );
  }

  return 0;
}
