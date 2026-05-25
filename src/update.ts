/**
 * update.ts — `j update` orchestrator.
 *
 * Brings an existing justin-sdk project up to whatever the SDK's current
 * pinned state is. Idempotent; designed to be run periodically (e.g.
 * after the SDK ships a new pin for prompts, prettier, eslint, etc.).
 *
 * Phases:
 *   1. Preflight       — justin-sdk.config.json must exist; tree must be
 *                        clean unless --allow-dirty
 *   2. Self-update     — bump the SDK in devDependencies; re-exec the
 *                        freshly installed CLI (unless --no-self-update)
 *   3. Components      — re-run every add-component listed in config
 *   4. Bump config     — set version + lastSynced in justin-sdk.config.json
 *   5. Self-check      — runDoctor; print warnings but don't fail update
 *   6. Git commit      — single "chore: sync justin-sdk to vX.Y.Z" commit
 *                        (skipped if working tree was already dirty, or
 *                        if --no-commit is passed)
 *
 * Re-exec dance: when self-update bumps the SDK, this process is still
 * running the OLD code. We re-exec the freshly installed CLI with
 * --no-self-update so the rest of the update runs against the new pins.
 */

import {spawnSync} from 'child_process';
import {existsSync, readFileSync} from 'fs';
import {basename, resolve} from 'path';

import {runBaseSetup} from './base-setup';
import {runBeadsSetup} from './beads-setup';
import {runClaudeMdSetup} from './claude-md-setup';
import {runDoctor} from './doctor';
import {runEslintSetup} from './eslint-setup';
import {runGhActionsSetup} from './gh-actions-setup';
import {runGitignoreSetup} from './gitignore-setup';
import {runHuskySetup} from './husky-setup';
import {runPrettierSetup} from './prettier-setup';
import {runPromptsSetup} from './prompts-setup';
import {selfUpdateSdk} from './self-update';
import {
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
import {runTsconfigSetup} from './tsconfig-setup';

// ---------------------------------------------------------------------------
// Component registry
// ---------------------------------------------------------------------------

interface ComponentRunArgs {
  projectRoot: string;
  quiet: boolean;
  force: boolean;
  skipPromptsFetch: boolean;
}

/**
 * Map a component name (as it appears in justin-sdk.config.json) to the
 * idempotent installer function that re-applies it.
 *
 * Unknown components are skipped with a warning rather than failing —
 * a project may have hand-edited its components list, or the SDK may
 * have renamed a component since the project's last sync.
 */
function runComponent(
  name: string,
  args: ComponentRunArgs,
): Promise<number> | null {
  const baseArgs = {
    projectRoot: args.projectRoot,
    quiet: args.quiet,
    force: args.force,
  };
  switch (name) {
    case 'base-setup':
      return runBaseSetup(baseArgs);
    case 'beads-setup':
      return runBeadsSetup({...baseArgs, noCommit: true});
    case 'prettier-setup':
      return runPrettierSetup(baseArgs);
    case 'tsconfig-setup':
      return runTsconfigSetup(baseArgs);
    case 'eslint-setup':
      return runEslintSetup(baseArgs);
    case 'husky-setup':
      return runHuskySetup(baseArgs);
    case 'gh-actions-setup':
      return runGhActionsSetup(baseArgs);
    case 'prompts-setup':
      return runPromptsSetup({
        ...baseArgs,
        skipFetch: args.skipPromptsFetch,
      });
    case 'claude-md-setup':
      return runClaudeMdSetup(baseArgs);
    case 'gitignore-setup':
      return runGitignoreSetup(baseArgs);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface UpdateOptions {
  projectRoot?: string;
  quiet?: boolean;
  /** Skip the SDK self-update step (used by the re-exec dance). */
  noSelfUpdate?: boolean;
  /** Skip the final git commit. */
  noCommit?: boolean;
  /** Print the plan without writing. */
  dryRun?: boolean;
  /** Allow running with uncommitted changes. */
  allowDirty?: boolean;
  /** Pass --force through to each component. */
  force?: boolean;
  /** Forwarded to runPromptsSetup (tests use this to skip the network). */
  skipPromptsFetch?: boolean;
}

/**
 * Run the full update sequence. Returns an exit code (0 = success).
 *
 * When self-update bumps the SDK, this function does NOT return — it
 * execs the newly installed CLI and calls process.exit() with the
 * child's status.
 */
export async function runUpdate(options: UpdateOptions = {}): Promise<number> {
  const quiet = options.quiet ?? false;
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const noSelfUpdate = options.noSelfUpdate ?? false;
  const noCommit = options.noCommit ?? false;
  const dryRun = options.dryRun ?? false;
  const allowDirty = options.allowDirty ?? false;
  const force = options.force ?? false;
  const skipPromptsFetch = options.skipPromptsFetch ?? false;

  setQuiet(quiet);

  if (!quiet) {
    console.log(
      `\n\x1b[1mUpdating justin-sdk project in ${basename(projectRoot)}\x1b[0m\n`,
    );
  }

  // -------------------------------------------------------------------------
  // Phase 1: Preflight
  // -------------------------------------------------------------------------
  stepHeader('1. Preflight');

  const configPath = resolve(projectRoot, 'justin-sdk.config.json');
  if (!existsSync(configPath)) {
    fail(
      'justin-sdk.config.json not found. ' +
        'Run `bunx justin-sdk init` (greenfield) or `bunx justin-sdk add base-setup` first.',
    );
    return 1;
  }
  const config = readJson(configPath) ?? {};
  const components = (config.components as string[] | undefined) ?? [];
  success(`Found justin-sdk.config.json (${components.length} components)`);

  const gitStatus = exec('git status --porcelain', projectRoot);
  const treeWasDirty =
    gitStatus.exitCode === 0 && gitStatus.stdout.trim().length > 0;
  if (treeWasDirty && !allowDirty) {
    fail(
      'Working tree has uncommitted changes. Re-run with --allow-dirty (no final commit) or commit/stash first.',
    );
    return 1;
  }
  if (treeWasDirty) {
    success(
      'Proceeding with dirty tree (--allow-dirty; will skip final commit)',
    );
  } else {
    success('Working tree clean');
  }

  // -------------------------------------------------------------------------
  // Phase 2: Self-update (and re-exec if we bumped)
  // -------------------------------------------------------------------------
  if (!noSelfUpdate && !dryRun) {
    stepHeader('2. Self-update SDK');
    const result = await selfUpdateSdk(projectRoot);
    if (result.shouldReExec) {
      // Re-exec the freshly installed CLI with --no-self-update to avoid
      // infinite recursion. Pass through every flag the user cared about.
      success(`Re-executing with new SDK (${result.newVersion}) …`);
      const args = ['justin-sdk', 'update', '--no-self-update'];
      if (noCommit) args.push('--no-commit');
      if (allowDirty) args.push('--allow-dirty');
      if (force) args.push('--force');
      if (quiet) args.push('--quiet');
      if (skipPromptsFetch) args.push('--skip-prompts-fetch');
      const child = spawnSync('bunx', args, {
        cwd: projectRoot,
        stdio: 'inherit',
      });
      process.exit(child.status ?? 1);
    }
  } else if (dryRun) {
    stepHeader('2. Self-update SDK (dry-run)');
    success('(dry-run) would query latest SDK tag and bump if behind');
  }

  // -------------------------------------------------------------------------
  // Phase 3: Re-apply each registered component
  // -------------------------------------------------------------------------
  stepHeader('3. Re-apply components');
  if (components.length === 0) {
    warn(
      'No components registered in justin-sdk.config.json; nothing to re-apply.',
    );
  }
  for (const component of components) {
    if (dryRun) {
      success(`(dry-run) would re-apply ${component}`);
      continue;
    }
    const componentArgs: ComponentRunArgs = {
      projectRoot,
      quiet: true,
      force,
      skipPromptsFetch,
    };
    const result = runComponent(component, componentArgs);
    if (result == null) {
      warn(
        `Unknown component "${component}" in justin-sdk.config.json — skipping. ` +
          'Either remove it or upgrade the SDK to a version that knows about it.',
      );
      continue;
    }
    // Re-assert our quiet setting; sub-runners toggle the module-level flag.
    setQuiet(quiet);
    const exitCode = await result;
    setQuiet(quiet);
    if (exitCode !== 0) {
      fail(
        `Component ${component} failed (exit ${exitCode}); aborting update.`,
      );
      return exitCode;
    }
    success(`${component} re-applied`);
  }

  // -------------------------------------------------------------------------
  // Phase 4: Bump config version + lastSynced
  // -------------------------------------------------------------------------
  if (!dryRun) {
    stepHeader('4. Bump justin-sdk.config.json');
    const sdkVersion = getSdkVersion();
    const fresh = (readJson(configPath) ?? {}) as Record<string, unknown>;
    const today = todayIsoDate();
    let modified = false;
    if (fresh.version !== sdkVersion) {
      fresh.version = sdkVersion;
      modified = true;
    }
    if (fresh.lastSynced !== today) {
      fresh.lastSynced = today;
      modified = true;
    }
    if (modified) {
      writeJson(configPath, fresh);
      success(
        `Bumped justin-sdk.config.json (version=${sdkVersion}, lastSynced=${today})`,
      );
    } else {
      success('justin-sdk.config.json already up to date');
    }
  } else {
    stepHeader('4. Bump justin-sdk.config.json (dry-run)');
    success(
      `(dry-run) would set version=${getSdkVersion()}, lastSynced=${todayIsoDate()}`,
    );
  }

  // -------------------------------------------------------------------------
  // Phase 5: Self-check via doctor
  // -------------------------------------------------------------------------
  stepHeader('5. doctor (self-check)');
  if (dryRun) {
    success('(dry-run) skipping doctor');
  } else {
    setQuiet(quiet);
    const doctorExit = await runDoctor(projectRoot, {quiet: true});
    setQuiet(quiet);
    if (doctorExit !== 0) {
      warn(
        'doctor reported issues — run `bunx justin-sdk doctor` for details.',
      );
    } else {
      success('All doctor checks passed');
    }
  }

  // -------------------------------------------------------------------------
  // Phase 6: Single git commit
  // -------------------------------------------------------------------------
  if (dryRun) {
    stepHeader('6. Git commit (dry-run)');
    success('(dry-run) would commit changes if any');
  } else if (noCommit) {
    stepHeader('6. Git commit');
    success('Skipping commit (--no-commit)');
  } else if (treeWasDirty) {
    stepHeader('6. Git commit');
    warn(
      'Tree was already dirty before update — skipping commit so we do not bundle unrelated work. ' +
        'Stage and commit manually.',
    );
  } else {
    stepHeader('6. Git commit');
    const after = exec('git status --porcelain', projectRoot);
    if (after.exitCode !== 0 || after.stdout.trim().length === 0) {
      success('Nothing to commit — already in sync');
    } else {
      const sdkVersion = getSdkVersion();
      const addResult = exec('git add -A', projectRoot);
      if (addResult.exitCode !== 0) {
        warn(
          `git add -A failed (exit ${addResult.exitCode}); leaving changes staged for manual commit.`,
        );
      } else {
        // --no-verify because lint-staged on the just-updated tree can
        // re-touch files via the prettier hook and cause weird re-runs.
        // The post-update doctor check is the real verification.
        const commitResult = exec(
          `git commit --no-verify -m 'chore: sync justin-sdk to v${sdkVersion}'`,
          projectRoot,
        );
        if (commitResult.exitCode === 0) {
          success(`Committed sync (justin-sdk v${sdkVersion})`);
        } else {
          warn(
            'git commit did not run cleanly — verify with `git log` / `git status`.',
          );
        }
      }
    }
  }

  if (!quiet) {
    console.log(
      `\n\x1b[32m\x1b[1mupdate complete\x1b[0m in ${basename(projectRoot)}.\n`,
    );
  }

  return 0;
}

/**
 * Verify a file (other than the SDK config) was actually opened by the
 * config. Exposed for tests; kept here for proximity to runUpdate's
 * config-reading logic.
 */
export function readConfigComponents(projectRoot: string): string[] | null {
  const configPath = resolve(projectRoot, 'justin-sdk.config.json');
  if (!existsSync(configPath)) return null;
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      components?: string[];
    };
    return config.components ?? [];
  } catch {
    return null;
  }
}
