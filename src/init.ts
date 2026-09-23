/**
 * init.ts — `justin-sdk init`: ENROL a repo, and nothing more (D3).
 *
 * This is npm's `init`. It writes the manifest — justin-sdk.config.json, the
 * SDK devDependency (pinned to a tag verified on the remote) and the shared
 * package.json scripts — and then stops. No components.
 *
 * It used to scaffold the whole preset, which is how enrolling a repo came to
 * install a dozen components nobody asked for, including the retired `prompts`
 * one. Components are `add`'s job; `add core` installs everything that applies.
 *
 * Phases:
 *   1. Preflight       — require .git/, clean tree (unless --allow-dirty)
 *   2. package.json    — scaffold a minimal one if missing
 *   3. config          — justin-sdk.config.json (no `components` key unless
 *                        --components was passed)
 *   4. devDependency   — @justinhaaheim/justin-sdk, tag verified on the remote
 *   5. scripts         — the shared package.json aliases
 *   6. bun install     — pull deps so the local bin resolves
 *   7. Self-check      — run doctor
 *   8. Git commit      — single "Initial scaffold" commit (unless --no-commit)
 *
 * Idempotent: re-running on a partly-enrolled directory is safe — every step
 * handles its own existing-state detection.
 */

import {existsSync, writeFileSync} from 'fs';
import {basename, resolve} from 'path';

import {
  addComponentsToConfig,
  stepDepsHasSdk,
  stepJustinSdkConfig,
  stepPackageScripts,
} from './base-setup';
import {
  COMPONENT_NAMES,
  type ComponentName,
  componentNameForConfigName,
  configNameFor,
} from './component-registry';
import {runDoctor} from './doctor';
import {getSdkVersion} from './sdk-identity';
import {
  exec,
  fail,
  kebabCase,
  setQuiet,
  stepHeader,
  success,
  warn,
} from './setup-helpers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Re-export so tests can `import {kebabCase} from '../src/init'`.
// The implementation lives in setup-helpers.ts so beads-setup.ts can
// use it without creating a circular dep on init.ts.
export {kebabCase} from './setup-helpers';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface InitOptions {
  /** Allow running with uncommitted changes (default false) */
  allowDirty?: boolean;
  /**
   * Write an explicit `components` list into the new config. Absent (the
   * default) leaves the key out, which means "track the core preset".
   */
  components?: readonly string[];
  /** Pass --force to underlying add commands (default false) */
  force?: boolean;
  /** Skip the final git commit (default false) */
  noCommit?: boolean;
  projectRoot?: string;
  quiet?: boolean;
  /**
   * The remote to verify the SDK tag against before writing the pin. Defaults
   * to the real published repo; tests point it at a local bare repo so the real
   * `git ls-remote` path runs without the suite reaching GitHub.
   */
  sdkRepoUrl?: string;
  /** Skip the `bun run justin-sdk doctor` self-check at the end (default false) */
  skipDoctor?: boolean;
  /** Skip `bun install` (default false — tests should set true) */
  skipInstall?: boolean;
}

/**
 * Run the full scaffold sequence. Returns an exit code (0 = success).
 */
export async function runInit(options: InitOptions = {}): Promise<number> {
  const quiet = options.quiet ?? false;
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const allowDirty = options.allowDirty ?? false;
  const noCommit = options.noCommit ?? false;
  const skipInstall = options.skipInstall ?? false;
  const skipDoctor = options.skipDoctor ?? false;

  setQuiet(quiet);

  if (!quiet) {
    console.log(
      `\n\x1b[1mInitializing justin-sdk project in ${basename(projectRoot)}\x1b[0m\n`,
    );
  }

  // -------------------------------------------------------------------------
  // Phase 1: Preflight
  // -------------------------------------------------------------------------
  stepHeader('1. Preflight');
  if (!existsSync(resolve(projectRoot, '.git'))) {
    fail(
      'Run `git init` first. `justin-sdk init` does not touch git state on its own.',
    );
    return 1;
  }
  success('.git/ found');

  const status = exec('git status --porcelain', projectRoot);
  if (status.exitCode === 0 && status.stdout.trim().length > 0 && !allowDirty) {
    fail(
      'Working tree has uncommitted changes. Re-run with --allow-dirty or commit first.',
    );
    return 1;
  }
  if (allowDirty && status.stdout.trim().length > 0) {
    success('Proceeding with dirty tree (--allow-dirty)');
  } else {
    success('Working tree clean');
  }

  // -------------------------------------------------------------------------
  // Phase 2: Scaffold package.json if missing
  // -------------------------------------------------------------------------
  stepHeader('2. package.json');
  const pkgPath = resolve(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) {
    const rawName = basename(projectRoot);
    const name = kebabCase(rawName);
    const pkg = {
      name: name.length > 0 ? name : 'unnamed-project',
      private: true,
      scripts: {},
      type: 'module',
      version: '0.0.1',
    };
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    success(`Created package.json (name: "${pkg.name}")`);
    if (name !== rawName) {
      warn(
        `Directory name "${rawName}" was normalized to "${pkg.name}" for the package name.`,
      );
    }
  } else {
    success('package.json already exists — leaving untouched');
  }

  // -------------------------------------------------------------------------
  // Phase 3: enrol the repo — config, SDK dependency, base scripts. NO
  // components (D3).
  // -------------------------------------------------------------------------
  // `init` is npm's `init`: it creates the manifest and nothing else. It used
  // to scaffold the whole core preset, which meant enrolling a repo installed a
  // dozen components nobody asked for — including, until Part A, the retired
  // `prompts` component. Components are `add`'s job now.
  //
  // `components` is left OUT of justin-sdk.config.json unless --components is
  // passed (D3): absent means the core preset, so a repo scaffolded today keeps
  // tracking core as the registry grows, instead of freezing today's list into
  // a file nobody revisits. `add core` is what installs it.
  stepHeader('3. justin-sdk.config.json');
  if (!stepJustinSdkConfig(projectRoot)) return 1;
  if (options.components != null && options.components.length > 0) {
    const configNames = options.components.map((name) =>
      (COMPONENT_NAMES as readonly string[]).includes(name)
        ? configNameFor(name as ComponentName)
        : name,
    );
    const unknown = configNames.filter(
      (name) => componentNameForConfigName(name) == null,
    );
    if (unknown.length > 0) {
      fail(
        `--components names ${unknown.join(', ')}, which this SDK does not know. Run \`justin-sdk list\` for the component names. Nothing was written to components.`,
      );
      return 1;
    }
    const added = addComponentsToConfig(projectRoot, configNames);
    success(
      `justin-sdk.config.json components = ${added.join(', ')} (run \`justin-sdk install\` to apply them)`,
    );
  }

  stepHeader('4. package.json: @justinhaaheim/justin-sdk devDependency');
  if (!stepDepsHasSdk(projectRoot, {sdkRepoUrl: options.sdkRepoUrl})) return 1;

  stepHeader('5. package.json scripts');
  if (!stepPackageScripts(projectRoot)) return 1;

  // -------------------------------------------------------------------------
  // Phase 4: bun install
  // -------------------------------------------------------------------------
  if (!skipInstall) {
    stepHeader('6. bun install');
    const installResult = exec('bun install', projectRoot);
    if (installResult.exitCode !== 0) {
      warn(
        'bun install failed — you may want to run it manually. ' +
          'Continuing so the package.json edits can still be committed.',
      );
      if (installResult.stderr.length > 0 && !quiet) {
        console.warn(installResult.stderr);
      }
    } else {
      success('Dependencies installed');
    }

    // After bun install, run prettier on the freshly-scaffolded files.
    // The SDK's writeJson uses JSON.stringify(.., null, 2) which expands
    // short arrays multi-line, but the project's installed prettier
    // collapses them — that mismatch causes `bun run signal` (prettier
    // --check) to fail on a brand-new scaffold. Normalizing once here
    // fixes that without changing any file contents semantically.
    const prettierResult = exec(
      'bunx prettier --write --log-level=warn .',
      projectRoot,
    );
    if (prettierResult.exitCode === 0) {
      success('Formatted scaffold with prettier');
    } else {
      warn(
        'Initial prettier --write did not run cleanly. ' +
          'Run `bun run prettier:write` or `bun run signal` to diagnose.',
      );
    }
  }

  // -------------------------------------------------------------------------
  // Phase 5: Self-check via doctor
  // -------------------------------------------------------------------------
  if (!skipDoctor) {
    stepHeader('7. doctor (self-check)');
    setQuiet(quiet);
    const doctorExit = await runDoctor(projectRoot, {quiet: true});
    setQuiet(quiet);
    if (doctorExit !== 0) {
      warn(
        'doctor reported issues; review and re-run components or run `bun run justin-sdk doctor` for details.',
      );
    } else {
      success('All doctor checks passed');
    }
  }

  // -------------------------------------------------------------------------
  // Phase 6: Final git commit
  // -------------------------------------------------------------------------
  if (!noCommit) {
    stepHeader('8. Git commit');
    // A commit message is prose, so an unreadable version degrades to the word
    // rather than refusing the commit — but it degrades VISIBLY (D4).
    const sdkVersion = getSdkVersion() ?? 'unknown';
    const addResult = exec('git add -A', projectRoot);
    if (addResult.exitCode !== 0) {
      warn(`git add -A failed (exit ${addResult.exitCode}); skipping commit.`);
    } else {
      // --no-verify skips husky pre-commit hooks (and lint-staged, which
      // can't function on the very first commit since there's no working
      // tree to back up). Subsequent commits the user makes will run hooks
      // normally. This is the right call ONLY for this scaffold commit.
      const commitResult = exec(
        `git commit --no-verify -m 'Initial scaffold via justin-sdk v${sdkVersion}'`,
        projectRoot,
      );
      if (commitResult.exitCode === 0) {
        success(`Committed initial scaffold (justin-sdk v${sdkVersion})`);
      } else {
        warn(
          'git commit did not run cleanly — nothing to commit, or commit was rejected. ' +
            'Verify with `git log` / `git status`.',
        );
      }
    }
  }

  if (!quiet) {
    console.log(
      `\n\x1b[32m\x1b[1minit complete\x1b[0m in ${basename(projectRoot)}.\n`,
    );
  }

  return 0;
}
