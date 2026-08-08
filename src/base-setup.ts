/**
 * base-setup.ts — Deterministic installer for the justin-sdk foundation
 * layer. Every justin-sdk project needs this before anything else.
 *
 * Installs:
 *  - justin-sdk.config.json at project root (tracks SDK version + components)
 *  - package.json scripts (signal/doctor/setup-env using bunx @justinhaaheim/justin-sdk)
 *  - .gitignore entries (tmp/, dynamic-version.local.*, .beads/.br_recovery/)
 *  - .claude/settings.json with sandbox.excludedCommands scaffolding
 *    and the j2n7 SessionStart hook line (remote: setup-env bootstrap;
 *    local: read-only doctor --quiet)
 *
 * Removes (home-base-j2n7): the committed scripts/setup-env.ts copy, which
 * the SDK `setup-env` command supersedes — deleted when hash-recognized as an
 * unmodified template, flagged when hand-modified.
 *
 * Idempotent: every step detects existing state and only writes when
 * something actually needs to change.
 *
 * Bails on unexpected state rather than guessing.
 */

import {createHash} from 'crypto';
import {existsSync, readFileSync, rmSync, writeFileSync} from 'fs';
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
  'signal-source:LINT':
    'eslint --report-unused-disable-directives --max-warnings 0 .',
  'signal-source:PRETTIER': 'prettier --check .',
};

const SDK_SCRIPTS: Record<string, string> = {
  'setup-env': 'bunx @justinhaaheim/justin-sdk setup-env',
  signal: 'bunx @justinhaaheim/justin-sdk signal --quiet',
  'signal:verbose': 'bunx @justinhaaheim/justin-sdk signal',
  'signal:serial': 'bunx @justinhaaheim/justin-sdk signal --serial',
  doctor: 'bunx @justinhaaheim/justin-sdk doctor',
  'doctor:fix': 'bunx @justinhaaheim/justin-sdk doctor --fix',
  fix: 'bunx @justinhaaheim/justin-sdk fix',
};

/**
 * The one committed SessionStart hook line (home-base-j2n7 decision). Two
 * worlds, irreconcilable in a single bare invocation, hence the shell branch:
 *
 *  - REMOTE (fresh container, no node_modules): only the `github:` form can
 *    resolve — the scoped name is deliberately unpublished (home-base-2qhw),
 *    so a scoped bunx would 404 before the tree is installed. setup-env then
 *    bootstraps mise/PATH, hydrates, and runs doctor --fix --yes.
 *  - LOCAL session start: READ-ONLY by ruling (write actions need a trigger,
 *    not a heartbeat) — so it runs `doctor --quiet`, which carries the
 *    ENV_HYDRATION staleness warning. The scoped form resolves via the
 *    project's own devDep pin (fast, offline, pinned); `|| true` keeps a
 *    fresh clone (nothing resolvable yet) from greeting every session with a
 *    hard hook error.
 */
export const SESSION_START_HOOK_COMMAND =
  'if [ "$CLAUDE_CODE_REMOTE" = "true" ]; then bunx github:justinhaaheim/justin-sdk setup-env; else bunx @justinhaaheim/justin-sdk doctor --quiet || true; fi';

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
  const components = (
    (config.components as string[] | undefined) ?? []
  ).slice();
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
    config.version = sdkVersion;
    modified = true;
  }

  if (modified) {
    config.components = components;
    writeJson(configPath, config);
    success(
      `Updated justin-sdk.config.json (components: ${components.join(', ')})`,
    );
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

  // Add required SDK scripts. Overwrite if the existing value is a
  // known-stale shape:
  //   - Points at the old node_modules path
  //   - Points at a local scripts/{doctor,signal,check-runner,setup-env}.ts
  //     (pre-SDK / pre-j2n7 patterns; setup-env.ts is DELETED by
  //     stepSetupEnvScript this same run, so an un-migrated alias would point
  //     at a missing file)
  // Custom values that don't match a stale shape are preserved (e.g.,
  // apple-reminders-mcp's `signal: "bun run prettier-check"`).
  const STALE_LOCAL_SCRIPT_RE =
    /^bun(?:x)?\s+(?:run\s+)?(?:"\$CLAUDE_PROJECT_DIR\/)?scripts\/(?:doctor|signal|check-runner|setup-env)\.ts"?(?:\s.*)?$/;
  for (const [name, cmd] of Object.entries(SDK_SCRIPTS)) {
    const existing = scripts[name];
    const isStaleSdkScript =
      existing != null &&
      (existing.includes('node_modules/@justinhaaheim/justin-sdk') ||
        STALE_LOCAL_SCRIPT_RE.test(existing));
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

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Known hashes of retired versions of the setup-env.ts template. A committed
 * scripts/setup-env.ts matching one of these (or the final template still on
 * disk under templates/) is a known SDK artifact with no hand modifications —
 * safe to DELETE during migration to the SDK `setup-env` command.
 */
const KNOWN_OLD_SETUP_ENV_HASHES: ReadonlySet<string> = new Set<string>([
  // Fleet variants hashed 2026-08-08 (home-base-j2n7.3 audit). Every one is a
  // stale template generation or a pure prettier reformat — no unique logic.
  // audio-journal-1's fork is DELIBERATELY absent: it carried a real
  // symlinked-node_modules guard (now an ENV_HYDRATION detection), and its
  // deletion should be a reviewed step, not a silent one.
  'ed18903d547e32f2dff50e71c15a3f8c54ac2ad9213feaf8c9c88e780089e832', // home-base (pre-template generation, hardcoded initSubmodules)
  '1d0fae9d92c29ec8e295752d0d098f73dac3a9ce04b81d14258d309c25e1a958', // imessage-exporter (missing JSDK_SKIP_SETUP_ENV)
  '397b54e4f9eb45d0895215df06417563394b6c35f291ded03d2320adf08bcbd1', // browser-automation-central (pre-miseTrust)
  '68e0bd4e027d9b71c4dff6f9da17a9fec40394ab5770f107255a53228a9d5324', // apple-reminders-mcp (pre-miseTrust variant)
  '57849540e200828a512e1f98e704fe6de6700b7f8c0659d45585ba5ed41b2135', // raycast-j-recent (pure prettier reformat of current template)
]);

/**
 * REMOVE the committed scripts/setup-env.ts (home-base-j2n7): the copied
 * template is superseded by the SDK `setup-env` command — the per-project
 * surface is now the SessionStart hook line + the `setup-env` package.json
 * alias, both emitted by this component.
 *
 * Behavior:
 *  - File absent → nothing to do (the desired end state).
 *  - File matches the final template (kept on disk under templates/ exactly
 *    for this recognition) or a known-old hash → delete it.
 *  - Hand-modified (no hash match) → warn and keep, unless `force: true`.
 *    Project-specific logic belongs in setup-env:<LABEL> package.json
 *    scripts, which the SDK command runs in declaration order.
 */
export function stepSetupEnvScript(
  projectRoot: string,
  force = false,
): boolean {
  const targetPath = resolve(projectRoot, 'scripts', 'setup-env.ts');
  if (!existsSync(targetPath)) {
    success(
      'No committed scripts/setup-env.ts (superseded by the SDK setup-env command)',
    );
    return true;
  }

  const templatePath = resolve(
    import.meta.dirname,
    '..',
    'templates',
    'scripts',
    'setup-env.ts',
  );
  const existingHash = sha256(readFileSync(targetPath, 'utf-8'));
  const matchesTemplate =
    existsSync(templatePath) &&
    existingHash === sha256(readFileSync(templatePath, 'utf-8'));

  if (matchesTemplate || KNOWN_OLD_SETUP_ENV_HASHES.has(existingHash)) {
    rmSync(targetPath);
    success(
      'Deleted scripts/setup-env.ts (unmodified SDK template — superseded by the SDK setup-env command)',
    );
    return true;
  }

  if (force) {
    rmSync(targetPath);
    success('Deleted scripts/setup-env.ts (--force)');
    return true;
  }

  warn(
    'scripts/setup-env.ts differs from every known SDK template (hand-modified). ' +
      'Move project-specific logic into setup-env:<LABEL> package.json scripts ' +
      '(run by `bunx @justinhaaheim/justin-sdk setup-env` in declaration order), ' +
      'then delete the file or re-run with --force.',
  );
  return true;
}

/**
 * Ensure standard .gitignore entries are present.
 */
export function stepGitignore(projectRoot: string): boolean {
  const gitignore = resolve(projectRoot, '.gitignore');
  const entries: Array<{search: string; append: string; label: string}> = [
    {
      search: 'tmp/',
      append: '\n# Temporary / scratch files\ntmp/\n',
      label: 'tmp/',
    },
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

  // Ensure the SessionStart hook is the j2n7 command line — and MIGRATE any
  // pre-j2n7 entry that ran the committed scripts/setup-env.ts copy, which is
  // being deleted by stepSetupEnvScript (an un-migrated hook would error at
  // every session start pointing at a file that no longer exists).
  const hooks = ((settings.hooks as Record<string, unknown> | undefined) ??
    {}) as Record<string, unknown>;
  const sessionStart = (hooks.SessionStart as unknown[] | undefined) ?? [];
  const hasCurrentHook = JSON.stringify(sessionStart).includes(
    'justin-sdk setup-env',
  );
  if (!hasCurrentHook) {
    // Drop every entry that references the retired committed copy.
    const migrated = sessionStart.filter(
      (entry) => !JSON.stringify(entry).includes('scripts/setup-env.ts'),
    );
    migrated.push({
      hooks: [{type: 'command', command: SESSION_START_HOOK_COMMAND}],
    });
    hooks.SessionStart = migrated;
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

/**
 * Ensure `@justinhaaheim/justin-sdk` is declared as a dependency in
 * package.json so that fresh installs (especially Claude web session VMs)
 * actually link the SDK locally. Without it the script aliases have nothing
 * to resolve against, and `bunx @justinhaaheim/justin-sdk …` degrades to a
 * registry lookup of an unpublished scoped name — i.e. it FAILS, which is the
 * intended posture (home-base-2qhw) but still a broken project. Pins to the
 * currently-running SDK version.
 *
 * Skips the project if the SDK is already declared as a dep or devDep
 * regardless of source (workspace, github, file, registry, etc.), since
 * we don't want to flip an intentional workspace dep to a github URL.
 */
export function stepDepsHasSdk(projectRoot: string): boolean {
  const pkgPath = resolve(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) {
    fail('package.json not found — cannot declare SDK dep');
    return false;
  }

  const pkg = readJson(pkgPath);
  if (pkg == null) {
    fail('package.json is not valid JSON');
    return false;
  }

  const SDK_PKG = '@justinhaaheim/justin-sdk';
  const deps = (pkg.dependencies as Record<string, string> | undefined) ?? {};
  const devDeps =
    (pkg.devDependencies as Record<string, string> | undefined) ?? {};

  if (SDK_PKG in deps || SDK_PKG in devDeps) {
    success(`${SDK_PKG} already declared as a dependency`);
    return true;
  }

  // v-PREFIXED, always (home-base-l9tz / v170.15): the bare spelling has
  // 404'd (no such tag) and, worse, silently resolved a POISONED duplicate
  // tag pointing at the wrong tree. The release convention is vX.Y.Z.
  const sdkVersion = getSdkVersion();
  const ref = `github:justinhaaheim/justin-sdk#v${sdkVersion}`;
  devDeps[SDK_PKG] = ref;
  pkg.devDependencies = devDeps;
  writeJson(pkgPath, pkg);
  success(`Added ${SDK_PKG} to devDependencies (${ref})`);
  warn(
    'Run `bun install` to fetch the SDK locally. Without it, the ' +
      '`bunx @justinhaaheim/justin-sdk …` aliases have nothing to resolve ' +
      'against and will fail.',
  );
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
  /**
   * Force-DELETE a hand-modified scripts/setup-env.ts (one whose hash matches
   * no known SDK template). Hash-recognized copies are deleted without it.
   */
  force?: boolean;
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
  const force = options.force ?? false;

  if (!options.quiet) {
    console.log(
      `\n\x1b[1mInstalling justin-sdk base-setup in ${basename(projectRoot)}\x1b[0m\n`,
    );
  }

  stepHeader('1. justin-sdk.config.json');
  if (!stepJustinSdkConfig(projectRoot, extraComponents)) return 1;

  stepHeader('2. package.json: @justinhaaheim/justin-sdk dep');
  if (!stepDepsHasSdk(projectRoot)) return 1;

  stepHeader('3. package.json scripts');
  if (!stepPackageScripts(projectRoot)) return 1;

  stepHeader('4. scripts/setup-env.ts (retired — remove committed copy)');
  if (!stepSetupEnvScript(projectRoot, force)) return 1;

  stepHeader('5. .gitignore');
  if (!stepGitignore(projectRoot)) return 1;

  stepHeader('6. .claude/settings.json');
  if (!stepClaudeSettings(projectRoot)) return 1;

  if (!options.quiet) {
    console.log(
      `\n\x1b[32m\x1b[1mbase-setup ready\x1b[0m in ${basename(projectRoot)}.\n`,
    );
  }

  return 0;
}
