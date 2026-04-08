/**
 * base-setup.ts — Deterministic installer for the justin-sdk foundation
 * layer. Every justin-sdk project needs this before anything else.
 *
 * Installs:
 *  - justin-sdk.config.json at project root (tracks SDK version + components)
 *  - package.json scripts (signal/doctor/setup-env using bunx justin-sdk)
 *  - scripts/setup-env.ts (copied from templates/)
 *  - .gitignore entries (tmp/, dynamic-version.local.*, .beads/.br_recovery/)
 *  - .claude/settings.json with sandbox.excludedCommands scaffolding
 *    and SessionStart hook for setup-env.ts
 *
 * Idempotent: every step detects existing state and only writes when
 * something actually needs to change.
 *
 * Bails on unexpected state rather than guessing.
 */

import {cpSync, existsSync, readFileSync, writeFileSync} from 'fs';
import {basename, resolve} from 'path';

import {
  appendIfMissing,
  ensureDir,
  exec,
  fail,
  getSdkVersion,
  readJson,
  setQuiet,
  stepHeader,
  success,
  todayIsoDate,
  warn,
  writeJson,
} from './setup-helpers';

// ---------------------------------------------------------------------------
// Step implementations
// ---------------------------------------------------------------------------

const DEFAULT_SIGNAL_SOURCE_SCRIPTS: Record<string, string> = {
  'signal-source:TS': 'tsc --noEmit',
  'signal-source:LINT': 'eslint --report-unused-disable-directives --max-warnings 0 .',
  'signal-source:PRETTIER': 'prettier --check .',
};

const SDK_SCRIPTS: Record<string, string> = {
  'setup-env': 'bun scripts/setup-env.ts',
  signal: 'bunx justin-sdk signal --quiet',
  'signal:verbose': 'bunx justin-sdk signal',
  'signal:serial': 'bunx justin-sdk signal --serial',
  doctor: 'bunx justin-sdk doctor',
  'doctor:fix': 'bunx justin-sdk doctor --fix',
};

/**
 * Create justin-sdk.config.json with sensible defaults if missing.
 * Updates lastSynced on every run. Does NOT overwrite existing fields.
 */
export function stepJustinSdkConfig(
  projectRoot: string,
  extraComponents: string[] = [],
): boolean {
  const configPath = resolve(projectRoot, 'justin-sdk.config.json');
  const sdkVersion = getSdkVersion();
  const today = todayIsoDate();

  if (!existsSync(configPath)) {
    const components = ['base-setup', ...extraComponents];
    const config = {
      version: sdkVersion,
      components,
      lastSynced: today,
    };
    writeJson(configPath, config);
    success(
      `Created justin-sdk.config.json (components: ${components.join(', ')})`,
    );
    return true;
  }

  // File exists — ensure base-setup is in components and update lastSynced
  const config = readJson(configPath) ?? {};
  const components = ((config.components as string[] | undefined) ?? []).slice();
  let modified = false;

  if (!components.includes('base-setup')) {
    components.unshift('base-setup');
    modified = true;
  }
  for (const extra of extraComponents) {
    if (!components.includes(extra)) {
      components.push(extra);
      modified = true;
    }
  }

  if (config.lastSynced !== today) {
    config.lastSynced = today;
    modified = true;
  }
  if (config.version !== sdkVersion) {
    // Don't overwrite — this is the version the project was LAST synced to.
    // Leave it as an informational marker the user can update manually.
  }

  if (modified) {
    config.components = components;
    writeJson(configPath, config);
    success(`Updated justin-sdk.config.json (components: ${components.join(', ')})`);
  } else {
    success('justin-sdk.config.json already up to date');
  }
  return true;
}

/**
 * Merge required scripts into package.json. Preserves existing scripts.
 * Only overwrites if the existing value looks like an old/stale version.
 */
export function stepPackageScripts(projectRoot: string): boolean {
  const pkgPath = resolve(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) {
    fail('package.json not found — cannot add scripts');
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

  // Add required SDK scripts (overwrite if they point at old node_modules path)
  for (const [name, cmd] of Object.entries(SDK_SCRIPTS)) {
    const existing = scripts[name];
    const isStaleSdkScript =
      existing != null &&
      existing.includes('node_modules/@justinhaaheim/justin-sdk');
    if (existing == null || isStaleSdkScript) {
      scripts[name] = cmd;
      modified = true;
    }
  }

  // Add default signal-source scripts only if NO signal-source:* scripts exist
  // (don't clobber a project that has adapted these).
  const hasSignalSource = Object.keys(scripts).some((k) =>
    k.startsWith('signal-source:'),
  );
  if (!hasSignalSource) {
    for (const [name, cmd] of Object.entries(DEFAULT_SIGNAL_SOURCE_SCRIPTS)) {
      scripts[name] = cmd;
      modified = true;
    }
  }

  if (modified) {
    pkg.scripts = scripts;
    writeJson(pkgPath, pkg);
    success('Added/updated justin-sdk scripts in package.json');
  } else {
    success('package.json scripts already up to date');
  }
  return true;
}

/**
 * Copy the setup-env.ts template into scripts/setup-env.ts.
 * Does NOT overwrite an existing file (users may have customized it).
 */
export function stepSetupEnvScript(projectRoot: string): boolean {
  const targetPath = resolve(projectRoot, 'scripts', 'setup-env.ts');
  if (existsSync(targetPath)) {
    success('scripts/setup-env.ts already exists');
    return true;
  }

  const templatePath = resolve(
    import.meta.dirname,
    '..',
    'templates',
    'scripts',
    'setup-env.ts',
  );
  if (!existsSync(templatePath)) {
    fail(`setup-env.ts template not found at ${templatePath}`);
    return false;
  }

  ensureDir(resolve(projectRoot, 'scripts'));
  cpSync(templatePath, targetPath);
  success('Copied scripts/setup-env.ts from template');
  return true;
}

/**
 * Ensure standard .gitignore entries are present.
 */
export function stepGitignore(projectRoot: string): boolean {
  const gitignore = resolve(projectRoot, '.gitignore');
  const entries: Array<{search: string; append: string; label: string}> = [
    {search: 'tmp/', append: '\n# Temporary / scratch files\ntmp/\n', label: 'tmp/'},
    {
      search: 'dynamic-version.local',
      append:
        '\n# Dynamic version artifacts (local-only)\ndynamic-version.local.json\ndynamic-version.local.d.ts\n',
      label: 'dynamic-version.local.*',
    },
  ];

  let anyAdded = false;
  for (const {search, append, label} of entries) {
    const added = appendIfMissing(gitignore, search, append);
    if (added) {
      success(`Added ${label} to .gitignore`);
      anyAdded = true;
    }
  }
  if (!anyAdded) {
    success('.gitignore already has standard entries');
  }
  return true;
}

/**
 * Ensure .claude/settings.json exists with the SessionStart hook and
 * a sandbox.excludedCommands array. Does not add any specific commands
 * (each component adds its own).
 */
export function stepClaudeSettings(projectRoot: string): boolean {
  const settingsDir = resolve(projectRoot, '.claude');
  const settingsPath = resolve(settingsDir, 'settings.json');
  ensureDir(settingsDir);

  const settings = (readJson(settingsPath) ?? {}) as Record<string, unknown>;
  let modified = false;

  // Ensure sandbox.excludedCommands exists (empty is fine)
  const sandbox = ((settings.sandbox as Record<string, unknown> | undefined) ??
    {}) as Record<string, unknown>;
  if (!Array.isArray(sandbox.excludedCommands)) {
    sandbox.excludedCommands = [];
    modified = true;
  }
  settings.sandbox = sandbox;

  // Ensure SessionStart hook runs setup-env.ts
  const hooks = ((settings.hooks as Record<string, unknown> | undefined) ??
    {}) as Record<string, unknown>;
  const setupCommand =
    'bun run "$CLAUDE_PROJECT_DIR/scripts/setup-env.ts"';
  const sessionStart = (hooks.SessionStart as unknown[] | undefined) ?? [];
  const hasSetupHook = JSON.stringify(sessionStart).includes(
    'scripts/setup-env.ts',
  );
  if (!hasSetupHook) {
    sessionStart.push({
      hooks: [{type: 'command', command: setupCommand}],
    });
    hooks.SessionStart = sessionStart;
    modified = true;
  }
  settings.hooks = hooks;

  if (modified) {
    writeJson(settingsPath, settings);
    success('Updated .claude/settings.json (sandbox + SessionStart hook)');
  } else {
    success('.claude/settings.json already has base-setup scaffolding');
  }
  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BaseSetupOptions {
  /** Project root (defaults to cwd) */
  projectRoot?: string;
  /** Suppress non-error output (for tests and for use from other setup commands) */
  quiet?: boolean;
  /** Extra components to register in justin-sdk.config.json (e.g., ['beads-setup']) */
  extraComponents?: string[];
}

/**
 * Install the justin-sdk foundation layer in a project.
 *
 * Callable both as the top-level `add base-setup` command and as a
 * precondition from other setup commands (e.g., beads-setup calls this
 * to ensure the foundation is in place before it adds its own content).
 */
export async function runBaseSetup(
  options: BaseSetupOptions = {},
): Promise<number> {
  setQuiet(options.quiet ?? false);
  const projectRoot = options.projectRoot ?? process.cwd();
  const extraComponents = options.extraComponents ?? [];

  if (!options.quiet) {
    console.log(
      `\n\x1b[1mInstalling justin-sdk base-setup in ${basename(projectRoot)}\x1b[0m\n`,
    );
  }

  stepHeader('1. justin-sdk.config.json');
  if (!stepJustinSdkConfig(projectRoot, extraComponents)) return 1;

  stepHeader('2. package.json scripts');
  if (!stepPackageScripts(projectRoot)) return 1;

  stepHeader('3. scripts/setup-env.ts');
  if (!stepSetupEnvScript(projectRoot)) return 1;

  stepHeader('4. .gitignore');
  if (!stepGitignore(projectRoot)) return 1;

  stepHeader('5. .claude/settings.json');
  if (!stepClaudeSettings(projectRoot)) return 1;

  if (!options.quiet) {
    console.log(
      `\n\x1b[32m\x1b[1mbase-setup ready\x1b[0m in ${basename(projectRoot)}.\n`,
    );
  }

  return 0;
}
