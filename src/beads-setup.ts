/**
 * beads-setup.ts — Deterministic beads_rust setup for any project.
 *
 * Orchestrates: mise.toml, br install, migration, br init, .prettierignore,
 * .claude/settings.json, and the beads-setup component registration.
 *
 * This is tooling-only. Beads *guidance* is authored in the prompts repo and
 * injected by the `prime` SessionStart hook — beads-setup writes no prompts.
 *
 * Runs base-setup as a precondition so the foundation layer is always
 * present before beads-specific steps run.
 *
 * Bails with a clear error on unexpected state rather than guessing.
 */

import {
  appendFileSync,
  cpSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import {basename, dirname, resolve} from 'path';

import {runBaseSetup} from './base-setup';
import {
  appendIfMissing,
  ensureDir,
  exec,
  fail,
  getPinnedToolVersion,
  kebabCase,
  log,
  readJson,
  setQuiet,
  stepHeader,
  success,
  warn,
  writeJson,
} from './setup-helpers';

// ---------------------------------------------------------------------------
// Version pin
// ---------------------------------------------------------------------------

function getPinnedVersion(): string {
  const version = getPinnedToolVersion('beads_rust');
  if (version == null) {
    throw new Error(
      'beads_rust version not found in versions.json. Cannot determine pinned beads_rust version.',
    );
  }
  return version;
}

// ---------------------------------------------------------------------------
// Step implementations
// ---------------------------------------------------------------------------

function stepMiseToml(projectRoot: string, version: string): boolean {
  const miseToml = resolve(projectRoot, 'mise.toml');
  const entry = `"github:Dicklesworthstone/beads_rust" = { version = "${version}", exe = "br" }`;

  if (!existsSync(miseToml)) {
    writeFileSync(miseToml, `[tools]\n${entry}\n`);
    success(`Created mise.toml with beads_rust ${version}`);
    return true;
  }

  const content = readFileSync(miseToml, 'utf-8');
  if (content.includes('beads_rust')) {
    // Check if version matches
    const match = /beads_rust.*?version\s*=\s*"([^"]+)"/.exec(content);
    if (match?.[1] === version) {
      success(`mise.toml already has beads_rust ${version}`);
      return true;
    }
    // Update version
    const updated = content.replace(
      /("github:Dicklesworthstone\/beads_rust"\s*=\s*\{[^}]*version\s*=\s*")[^"]+(")/,
      `$1${version}$2`,
    );
    writeFileSync(miseToml, updated);
    success(`Updated mise.toml beads_rust version to ${version}`);
    return true;
  }

  // Add to existing [tools] section
  if (content.includes('[tools]')) {
    const updated = content.replace('[tools]', `[tools]\n${entry}`);
    writeFileSync(miseToml, updated);
  } else {
    appendFileSync(miseToml, `\n[tools]\n${entry}\n`);
  }
  success(`Added beads_rust ${version} to mise.toml`);
  return true;
}

function stepInstallBr(projectRoot: string, version: string): boolean {
  // Check if br is already installed and correct version
  const {stdout, exitCode} = exec('br --version', projectRoot);
  if (exitCode === 0) {
    const installed = stdout.replace(/^br\s*/, '').trim();
    if (installed === version) {
      success(`br ${version} already installed`);
      return true;
    }
    log(`br ${installed} installed, want ${version} — upgrading...`);
  }

  // Try mise install first
  const miseResult = exec('mise install --yes', projectRoot);
  if (miseResult.exitCode === 0) {
    const check = exec('br --version', projectRoot);
    if (check.exitCode === 0) {
      success(`br installed via mise: ${check.stdout}`);
      return true;
    }
  }

  // Fallback to direct install
  log('mise install failed or br not on PATH — trying direct install...');
  const versionTag = version.startsWith('v') ? version : `v${version}`;
  const curlResult = exec(
    `curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/beads_rust/main/install.sh" | bash -s -- --version ${versionTag} --quiet --skip-skills`,
    projectRoot,
  );
  if (curlResult.exitCode !== 0) {
    fail(`Failed to install br: ${curlResult.stderr}`);
    return false;
  }

  const verify = exec('br --version', projectRoot);
  if (verify.exitCode === 0) {
    success(`br installed via direct download: ${verify.stdout}`);
    return true;
  }

  // Check ~/.local/bin directly
  const home = process.env.HOME ?? '/root';
  const directBin = resolve(home, '.local/bin/br');
  if (existsSync(directBin)) {
    success(`br installed at ${directBin} (may need PATH update)`);
    return true;
  }

  fail('br could not be installed');
  return false;
}

// ---------------------------------------------------------------------------
// Beads workspace state (home-base-o33r)
// ---------------------------------------------------------------------------

/**
 * Artifacts that git actually CHECKS OUT for a beads workspace. `beads.db` is
 * NOT one of them — `.beads/.gitignore` ignores `*.db`, so a database file is
 * absent from every fresh worktree and every fresh clone of a repo that has had
 * beads for years.
 *
 * This list is the whole point of home-base-o33r: "no beads.db" and "no beads
 * workspace" are two different facts, and conflating them made the sweep re-init
 * every repo it touched — renaming each one's `issue_prefix` to the sweep
 * worktree's directory name and discarding its real configuration.
 */
const TRACKED_BEADS_ARTIFACTS = ['config.yaml', 'issues.jsonl'] as const;

export type BeadsWorkspaceState =
  /** No `.beads/` at all — a genuine first-time initialization. */
  | {kind: 'none'}
  /** A working `br` database is present. */
  | {kind: 'initialized'}
  /**
   * The repo carries a COMMITTED beads workspace but no database in this tree
   * (the normal state of a linked worktree or a fresh clone). Hydration
   * concern, never an init concern — the configuration must not be touched.
   */
  | {artifact: string; kind: 'tracked-not-hydrated'}
  /** `.beads/` exists but is not a usable beads_rust workspace. */
  | {kind: 'legacy'; reason: string};

/**
 * Classify what kind of beads workspace (if any) `projectRoot` has.
 *
 * Ordering is load-bearing: the `br list` probe only runs when a database file
 * actually exists, so the common worktree case is decided from the filesystem
 * alone and never spawns a process.
 */
export function detectBeadsWorkspace(projectRoot: string): BeadsWorkspaceState {
  const beadsDir = resolve(projectRoot, '.beads');
  if (!existsSync(beadsDir)) return {kind: 'none'};

  const metadataPath = resolve(beadsDir, 'metadata.json');
  if (existsSync(metadataPath)) {
    try {
      if (readFileSync(metadataPath, 'utf-8').includes('"dolt"')) {
        return {kind: 'legacy', reason: 'old Dolt (bd) backend'};
      }
    } catch {
      // Unreadable metadata decides nothing — fall through to the other probes.
    }
  }

  if (existsSync(resolve(beadsDir, 'beads.db'))) {
    const check = exec('br list --json', projectRoot);
    if (check.exitCode === 0) return {kind: 'initialized'};
    return {
      kind: 'legacy',
      reason: 'beads.db present but `br list` failed',
    };
  }

  for (const artifact of TRACKED_BEADS_ARTIFACTS) {
    if (existsSync(resolve(beadsDir, artifact))) {
      return {artifact, kind: 'tracked-not-hydrated'};
    }
  }

  return {
    kind: 'legacy',
    reason: '.beads/ exists with neither a database nor a tracked config',
  };
}

/**
 * The checkout that gives this project its IDENTITY: the MAIN worktree's root.
 *
 * `basename(projectRoot)` is the wrong answer in a linked worktree — there it is
 * the worktree's directory name (`sdk-sweep`), not the repo's. Deriving a beads
 * prefix from it is exactly how home-base-o33r renamed five repos' issue
 * prefixes to `sdk-sweep`.
 *
 * Returns null when git cannot answer (not a repo, bare repo, unusual layout).
 * The caller must treat that as "unknown", never silently substitute a value
 * that looks measured (critical rule 5).
 */
export function mainCheckoutRoot(projectRoot: string): string | null {
  const result = exec('git rev-parse --git-common-dir', projectRoot);
  if (result.exitCode !== 0) return null;
  const raw = result.stdout.trim();
  if (raw.length === 0) return null;
  // `.git` in a primary checkout, an absolute path in a linked worktree.
  const commonDir = resolve(projectRoot, raw);
  if (basename(commonDir) !== '.git') return null;
  return dirname(commonDir);
}

/**
 * The beads prefix for a genuinely uninitialized project, derived from the MAIN
 * checkout's directory name. `ok: false` when the identity could not be
 * measured — a failed derivation must not be representable as a real prefix.
 */
export function deriveBeadsPrefix(
  projectRoot: string,
): {ok: true; prefix: string; source: string} | {ok: false; reason: string} {
  // Three cases, kept distinct on purpose. Only the middle one is the o33r
  // hazard; the first genuinely cannot be a worktree, so the checkout dir IS
  // the identity there — that is a measurement, not a fallback.
  const insideRepo =
    exec('git rev-parse --is-inside-work-tree', projectRoot).exitCode === 0;
  const identityRoot = insideRepo ? mainCheckoutRoot(projectRoot) : projectRoot;
  if (identityRoot == null) {
    return {
      ok: false,
      reason:
        `${projectRoot} is inside a git repository, but its main checkout root ` +
        'could not be resolved (`git rev-parse --git-common-dir` gave no usable ' +
        'answer). Refusing to guess a beads prefix from the checkout directory — ' +
        'in a worktree that is the worktree name, not the repo (home-base-o33r). ' +
        'Run `br init --prefix <name>` by hand.',
    };
  }
  const rawPrefix = basename(identityRoot);
  const prefix = kebabCase(rawPrefix);
  if (prefix.length === 0) {
    return {
      ok: false,
      reason: `cannot derive a valid beads prefix from directory name "${rawPrefix}". Rename the directory or run br init manually.`,
    };
  }
  return {ok: true, prefix, source: identityRoot};
}

/**
 * Add the sync keys beads-setup owns to a `.beads/config.yaml`, preserving
 * every other line exactly.
 *
 * Pure, and deliberately a MERGE rather than a template render: the whole-file
 * overwrite this replaces is what silently discarded each repo's real
 * configuration (home-base-o33r fix shape 3). `issue_prefix` is never read and
 * never written here.
 */
export function mergeBeadsSyncConfig(original: string): string {
  const lines = original.split('\n');
  const syncIndex = lines.findIndex((line) => /^sync:\s*$/.test(line));

  if (syncIndex === -1) {
    const base =
      original.length === 0 || original.endsWith('\n')
        ? original
        : `${original}\n`;
    return `${base}\n# Sync behavior\nsync:\n  auto_import: true\n  auto_flush: true\n`;
  }

  // The block is the indented (or blank) run of lines after `sync:`.
  let end = syncIndex + 1;
  while (end < lines.length) {
    const line = lines[end] ?? '';
    if (line.trim() === '' || /^\s+\S/.test(line)) {
      end++;
      continue;
    }
    break;
  }
  while (end > syncIndex + 1 && (lines[end - 1] ?? '').trim() === '') end--;

  const block = lines.slice(syncIndex + 1, end);
  for (const key of ['auto_import', 'auto_flush'] as const) {
    const keyIndex = block.findIndex((line) =>
      new RegExp(`^\\s*${key}\\s*:`).test(line),
    );
    if (keyIndex === -1) {
      block.push(`  ${key}: true`);
    } else {
      block[keyIndex] = (block[keyIndex] ?? '').replace(
        new RegExp(`^(\\s*${key}\\s*:).*$`),
        '$1 true',
      );
    }
  }

  return [...lines.slice(0, syncIndex + 1), ...block, ...lines.slice(end)].join(
    '\n',
  );
}

function stepMigrateOldBeads(
  projectRoot: string,
  state: BeadsWorkspaceState,
): {
  hadOldData: boolean;
  jsonlPath: string | null;
  ok: boolean;
} {
  const beadsDir = resolve(projectRoot, '.beads');

  if (state.kind === 'none') {
    return {hadOldData: false, jsonlPath: null, ok: true};
  }
  if (state.kind === 'initialized') {
    success('beads_rust already initialized and working');
    return {hadOldData: false, jsonlPath: null, ok: true};
  }
  if (state.kind === 'tracked-not-hydrated') {
    // home-base-o33r: a committed workspace with no checked-out database. NOT a
    // migration — backing it up and deleting it is how the real config got
    // discarded. Say what was measured, and leave the directory alone.
    success(
      `beads workspace already present (.beads/${state.artifact} is committed); ` +
        'no database in this tree — hydration concern, not init. Leaving .beads/ untouched.',
    );
    return {hadOldData: false, jsonlPath: null, ok: true};
  }

  log(`Migrating legacy .beads/ (${state.reason})`);

  // Back up existing data
  const tmpDir = resolve(projectRoot, 'tmp');
  ensureDir(tmpDir);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupDir = resolve(tmpDir, `beads-backup-${timestamp}`);
  log(`Backing up .beads/ to ${backupDir}...`);
  cpSync(beadsDir, backupDir, {recursive: true});
  success(`Backup created at tmp/beads-backup-${timestamp}/`);

  // Find exportable JSONL
  let jsonlPath: string | null = null;
  const candidates = [
    resolve(backupDir, 'issues.jsonl'),
    resolve(backupDir, 'backup', 'issues.jsonl'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      const content = readFileSync(candidate, 'utf-8').trim();
      if (content.length > 0) {
        jsonlPath = candidate;
        break;
      }
    }
  }

  if (jsonlPath) {
    success(`Found exportable issues at ${jsonlPath}`);
  } else {
    warn('No issues.jsonl found in backup — issues may be lost');
  }

  // Check for Dolt backend
  const metadataPath = resolve(beadsDir, 'metadata.json');
  if (existsSync(metadataPath)) {
    try {
      const meta = readFileSync(metadataPath, 'utf-8');
      if (meta.includes('"dolt"')) {
        log('Detected old Dolt backend — removing for fresh init');
      }
    } catch {
      // proceed
    }
  }

  // Remove old .beads/ for fresh init
  rmSync(beadsDir, {recursive: true, force: true});
  success('Removed old .beads/ directory (backup preserved)');

  return {hadOldData: true, jsonlPath, ok: true};
}

/**
 * Initialize a beads workspace — ONLY when the project genuinely has none.
 *
 * home-base-o33r: this used to decide from `existsSync('.beads/beads.db')`,
 * which is false in every worktree (the db is gitignored), so it re-inited
 * repos that already had a workspace and overwrote their config.yaml wholesale.
 * The decision now comes from `detectBeadsWorkspace`, and the config write is a
 * targeted merge.
 */
function stepInitBeads(
  projectRoot: string,
  state: BeadsWorkspaceState,
): boolean {
  if (state.kind === 'initialized') {
    success('beads_rust already initialized');
    return true;
  }
  if (state.kind === 'tracked-not-hydrated') {
    success(
      `beads_rust workspace already committed (.beads/${state.artifact}) — not re-initializing`,
    );
    return true;
  }

  const derived = deriveBeadsPrefix(projectRoot);
  if (!derived.ok) {
    fail(derived.reason);
    return false;
  }
  const {prefix} = derived;
  const result = exec(`br init --prefix '${prefix}'`, projectRoot);
  if (result.exitCode !== 0) {
    fail(`br init failed: ${result.stderr}`);
    return false;
  }
  success(`Initialized beads_rust with prefix "${prefix}"`);

  // Configure auto-sync — merged into whatever br init wrote, never a
  // whole-file template overwrite (home-base-o33r).
  const configPath = resolve(projectRoot, '.beads', 'config.yaml');
  if (existsSync(configPath)) {
    const config = readFileSync(configPath, 'utf-8');
    const merged = mergeBeadsSyncConfig(config);
    if (merged !== config) {
      writeFileSync(configPath, merged);
      success('Configured auto-sync in config.yaml');
    }
  }

  return true;
}

/**
 * The import that seeds a freshly-initialised workspace from the migrated JSONL. Exported so the regression test can run the EXACT shipped invocation rather than its own idea of it.
 *
 * `--force` used to be on this line, and it is a hard delete waiting for a caller. Measured on br 0.1.37 (the pinned version) and br 0.4.1: `br sync --import-only --force` DELETES — not tombstones — every issue in the database that the JSONL lacks, taking its comments, dependencies and labels with it, and exits 0 while reporting only what it "Created". Adding `--orphans allow` does not change that by one row; the two invocations produce identical destruction. For contrast, on 0.1.37 the documented destructive flag `--rebuild` TOMBSTONES those rows and says "Orphans removed: 1 issues (not in JSONL)"; on 0.4.1 `--rebuild` no longer exists at all.
 *
 * It was also unnecessary here. The comment it carried — "ensures we re-import even if br thinks the JSONL hash is unchanged" — cannot apply on this path: the step only runs after `stepMigrateOldBeads` deleted `.beads/` and `stepInitBeads` created a new one, so the stored hash belongs to the empty JSONL `br init` wrote and never to the non-empty backup copied over it. Measured: a plain `--import-only` into a fresh init imports every issue, comment, dependency and label. That made `--force` a destructive capability shipped into every enrolled repo in exchange for nothing.
 *
 * `--orphans allow` stays: legacy `bd` exports often carry dependency references to deleted issues, and strict mode rejects the referring issues instead of importing them.
 */
export const BEADS_IMPORT_COMMAND = 'br sync --import-only --orphans allow';

function stepImportIssues(
  projectRoot: string,
  jsonlPath: string | null,
): boolean {
  if (jsonlPath == null) return true;

  const targetJsonl = resolve(projectRoot, '.beads', 'issues.jsonl');
  log('Importing issues from backup...');

  // Count source issues for verification
  let sourceCount = 0;
  try {
    sourceCount = readFileSync(jsonlPath, 'utf-8')
      .split('\n')
      .filter((line) => line.trim() !== '').length;
  } catch {
    // ignore
  }

  // Copy JSONL into .beads/
  cpSync(jsonlPath, targetJsonl, {force: true});

  const result = exec(BEADS_IMPORT_COMMAND, projectRoot);
  if (result.exitCode !== 0) {
    fail(`${BEADS_IMPORT_COMMAND} failed: ${result.stderr}`);
    return false;
  }

  // Verify with --all (br list defaults to excluding closed issues)
  const verify = exec('br list --all --json', projectRoot);
  if (verify.exitCode === 0) {
    try {
      const data = JSON.parse(verify.stdout) as {issues?: unknown[]};
      const count = data.issues?.length ?? 0;
      if (sourceCount > 0 && count < sourceCount) {
        warn(
          `Imported ${count} issues, but source had ${sourceCount}. Some may have been dropped.`,
        );
      } else {
        success(`Imported ${count} issues`);
      }
    } catch {
      success('Issues imported (could not parse count)');
    }
  } else {
    warn('br list failed after import — verify manually');
  }

  return true;
}

// NOTE: beads-setup deliberately does NOT generate AGENTS.md and does NOT run
// `br agents --add`. The beads workflow guidance is authored once in the prompts
// repo (`~/Dev/prompts/src/rules/beads-workflow.md`) and delivered to every
// session by the `prime` SessionStart hook + `~/.claude/rules/`. `br agents`
// output is upstream-owned (beads_rust src/cli/commands/agents.rs) and had
// drifted from Justin's guidance — it still referenced `bd`, `br sync
// --flush-only`, and a session protocol that no longer applies now that every
// project auto-flushes. Installing a second, staler copy per-project was worse
// than having none. See home-base-t6a0.14.

function stepPrettierIgnore(projectRoot: string): boolean {
  const prettierIgnore = resolve(projectRoot, '.prettierignore');
  const added = appendIfMissing(
    prettierIgnore,
    '.beads',
    '\n# Beads issue tracker data\n.beads\n',
  );
  if (added) {
    success('Added .beads to .prettierignore');
  } else {
    success('.prettierignore already includes .beads');
  }
  return true;
}

function stepClaudeSettings(projectRoot: string): boolean {
  const settingsPath = resolve(projectRoot, '.claude', 'settings.json');
  ensureDir(resolve(projectRoot, '.claude'));

  const settings = readJson(settingsPath) ?? {};
  const sandbox = (settings.sandbox ?? {}) as Record<string, unknown>;
  const excluded = (sandbox.excludedCommands ?? []) as string[];

  if (excluded.includes('br')) {
    success('.claude/settings.json already excludes br from sandbox');
    return true;
  }

  excluded.push('br');
  sandbox.excludedCommands = excluded;
  settings.sandbox = sandbox;
  writeJson(settingsPath, settings);
  success('Added br to .claude/settings.json sandbox exclusions');
  return true;
}

function stepJustinSdkJson(projectRoot: string): boolean {
  // base-setup ensures the config file exists; we just need to add the
  // beads-setup component if it's not already there.
  const configPath = resolve(projectRoot, 'justin-sdk.config.json');
  const config = readJson(configPath);

  if (config == null) {
    fail(
      'justin-sdk.config.json not found after base-setup — this should not happen',
    );
    return false;
  }

  const components = (
    (config.components as string[] | undefined) ?? []
  ).slice();
  if (components.includes('beads-setup')) {
    success('justin-sdk.config.json already includes beads-setup component');
    return true;
  }

  components.push('beads-setup');
  config.components = components;
  writeJson(configPath, config);
  success('Added beads-setup to justin-sdk.config.json components');
  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BeadsSetupOptions {
  /** Skip git commit at the end */
  noCommit?: boolean;
  /** Project root (defaults to cwd) */
  projectRoot?: string;
  /** Suppress non-error output (useful for tests) */
  quiet?: boolean;
}

export async function runBeadsSetup(
  options: BeadsSetupOptions = {},
): Promise<number> {
  setQuiet(options.quiet ?? false);
  const quiet = options.quiet ?? false;
  const projectRoot = options.projectRoot ?? process.cwd();
  const version = getPinnedVersion();

  if (!quiet) {
    console.log(
      `\n\x1b[1mSetting up beads_rust ${version} in ${basename(projectRoot)}\x1b[0m\n`,
    );
  }

  // Step 0: Ensure base-setup is installed first (foundation layer).
  // This creates justin-sdk.config.json, package.json scripts,
  // scripts/setup-env.ts, .gitignore entries, and .claude/settings.json.
  // Pre-registers 'beads-setup' as a component so we don't have to
  // update the config file twice.
  stepHeader('0. base-setup (foundation layer)');
  const baseExit = await runBaseSetup({
    projectRoot,
    quiet: true,
    extraComponents: ['beads-setup'],
  });
  if (baseExit !== 0) {
    fail('base-setup failed — cannot proceed with beads-setup');
    return baseExit;
  }
  // base-setup toggled quiet on/off internally; restore our own setting.
  setQuiet(quiet);
  success('base-setup ready');

  // Step 1: mise.toml
  stepHeader('1. mise.toml');
  if (!stepMiseToml(projectRoot, version)) return 1;

  // Step 2: Install br
  stepHeader('2. Install br');
  if (!stepInstallBr(projectRoot, version)) return 1;

  // Step 3: Handle existing .beads/ data
  stepHeader('3. Migration check');
  // Classified ONCE, before anything is moved or deleted, and reused by both
  // steps — so "already has a workspace" cannot be answered differently by the
  // migration step and the init step (home-base-o33r).
  const state = detectBeadsWorkspace(projectRoot);
  const migration = stepMigrateOldBeads(projectRoot, state);
  if (!migration.ok) return 1;

  // Step 4: Initialize beads_rust
  stepHeader('4. Initialize beads_rust');
  if (!stepInitBeads(projectRoot, state)) return 1;

  // Step 5: Import old issues
  if (migration.hadOldData) {
    stepHeader('5. Import issues');
    if (!stepImportIssues(projectRoot, migration.jsonlPath)) return 1;
  }

  // Step 6: .prettierignore
  stepHeader('6. .prettierignore');
  if (!stepPrettierIgnore(projectRoot)) return 1;

  // Step 7: .claude/settings.json (add br to sandbox.excludedCommands)
  stepHeader('7. .claude/settings.json');
  if (!stepClaudeSettings(projectRoot)) return 1;

  // Step 8: justin-sdk.config.json (ensure beads-setup is in components)
  stepHeader('8. justin-sdk.config.json');
  if (!stepJustinSdkJson(projectRoot)) return 1;

  // Step 9: Git commit
  if (options.noCommit !== true) {
    stepHeader('9. Git commit');
    const status = exec('git status --porcelain', projectRoot);
    if (status.stdout.trim().length > 0) {
      // Stage each file individually so one missing file doesn't cause
      // the rest to be silently dropped (home-base-beq).
      const filesToAdd = [
        'mise.toml',
        '.beads/',
        '.claude/settings.json',
        '.prettierignore',
        'justin-sdk.config.json',
        'CLAUDE.md',
        'scripts/setup-env.ts',
        'package.json',
        '.gitignore',
      ];
      for (const path of filesToAdd) {
        const fullPath = resolve(projectRoot, path);
        if (existsSync(fullPath)) {
          exec(`git add '${path}'`, projectRoot);
        }
      }
      const commitResult = exec(
        `git commit -m 'Add beads_rust (br) issue tracking via justin-sdk'`,
        projectRoot,
      );
      if (commitResult.exitCode === 0) {
        success('Committed beads setup');
      } else {
        warn('Git commit failed — you may need to commit manually');
      }
    } else {
      success('No changes to commit');
    }
  }

  if (!quiet) {
    console.log(
      `\n\x1b[32m\x1b[1mDone!\x1b[0m beads_rust ${version} is ready in ${basename(projectRoot)}.\n`,
    );

    // Remind about agent-only tasks
    const agentTasks: string[] = [];
    const claudeMd = resolve(projectRoot, 'CLAUDE.md');
    if (existsSync(claudeMd)) {
      const content = readFileSync(claudeMd, 'utf-8');
      if (content.includes('bd ') || content.includes('bd\n')) {
        agentTasks.push(
          'CLAUDE.md has stale `bd` references — have an agent clean them up',
        );
      }
    }
    if (agentTasks.length > 0) {
      console.log('\x1b[33mRemaining tasks for an agent:\x1b[0m');
      for (const task of agentTasks) {
        console.log(`  • ${task}`);
      }
      console.log('');
    }
  }

  return 0;
}
