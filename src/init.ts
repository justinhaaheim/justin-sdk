/**
 * init.ts — Greenfield scaffold orchestrator for `j init`.
 *
 * Composes the 8 add-component installers (plus beads) into a single
 * one-shot scaffold for a brand-new project. The component installers
 * are called in-process (not via `bunx`), which keeps init fast and
 * lets tests run offline.
 *
 * Phases:
 *   1. Preflight       — require .git/, clean tree (unless --allow-dirty)
 *   2. package.json    — scaffold a minimal one if missing
 *   3. Components      — run every add-component in dependency order
 *   4. bun install     — pull deps so future bunx calls work
 *   5. Self-check      — run doctor to confirm everything is healthy
 *   6. Git commit      — single "Initial scaffold" commit (unless --no-commit)
 *
 * Idempotent: re-running on a partly-scaffolded directory is safe — each
 * component handles its own existing-state detection.
 */

import {existsSync, writeFileSync} from 'fs';
import {basename, resolve} from 'path';

import {runBeadsSetup} from './beads-setup';
import {runClaudeMdSetup} from './claude-md-setup';
import {runDoctor} from './doctor';
import {runEslintSetup} from './eslint-setup';
import {runGhActionsSetup} from './gh-actions-setup';
import {runGitignoreSetup} from './gitignore-setup';
import {runHuskySetup} from './husky-setup';
import {runPrettierSetup} from './prettier-setup';
import {runPromptsSetup} from './prompts-setup';
import {
  exec,
  fail,
  getSdkVersion,
  kebabCase,
  setQuiet,
  stepHeader,
  success,
  warn,
} from './setup-helpers';
import {runTsconfigSetup} from './tsconfig-setup';

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
  projectRoot?: string;
  quiet?: boolean;
  /** Allow running with uncommitted changes (default false) */
  allowDirty?: boolean;
  /** Skip the final git commit (default false) */
  noCommit?: boolean;
  /** Pass --force to underlying add commands (default false) */
  force?: boolean;
  /** Skip `bun install` (default false — tests should set true) */
  skipInstall?: boolean;
  /** Skip fetching the prompts library (forwarded to runPromptsSetup) */
  skipPromptsFetch?: boolean;
  /** Skip the `bunx justin-sdk doctor` self-check at the end (default false) */
  skipDoctor?: boolean;
}

interface Component {
  name: string;
  run: () => Promise<number>;
}

/**
 * Run the full scaffold sequence. Returns an exit code (0 = success).
 */
export async function runInit(options: InitOptions = {}): Promise<number> {
  const quiet = options.quiet ?? false;
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const allowDirty = options.allowDirty ?? false;
  const noCommit = options.noCommit ?? false;
  const force = options.force ?? false;
  const skipInstall = options.skipInstall ?? false;
  const skipPromptsFetch = options.skipPromptsFetch ?? false;
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
      version: '0.0.1',
      type: 'module',
      private: true,
      scripts: {},
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
  // Phase 3: Run add components in dependency order
  // -------------------------------------------------------------------------
  // Note: every add component calls runBaseSetup internally — that's
  // idempotent and fine. We don't need to call it from init too.
  const baseArgs = {projectRoot, quiet: true, force};

  const components: Component[] = [
    {name: 'gitignore', run: () => runGitignoreSetup(baseArgs)},
    {name: 'prettier', run: () => runPrettierSetup(baseArgs)},
    {name: 'tsconfig', run: () => runTsconfigSetup(baseArgs)},
    {name: 'eslint', run: () => runEslintSetup(baseArgs)},
    {name: 'husky', run: () => runHuskySetup(baseArgs)},
    {name: 'gh-actions', run: () => runGhActionsSetup(baseArgs)},
    {
      name: 'prompts',
      run: () => runPromptsSetup({...baseArgs, skipFetch: skipPromptsFetch}),
    },
    {name: 'claude-md', run: () => runClaudeMdSetup(baseArgs)},
    {name: 'beads', run: () => runBeadsSetup({...baseArgs, noCommit: true})},
  ];

  stepHeader('3. Components');
  for (const component of components) {
    // The shared QUIET flag flips during each sub-call (they restore quiet
    // on the way in, but other code paths may not). Re-assert init's own
    // quiet setting before each component so our headers/messages print
    // when they should.
    setQuiet(quiet);
    const exitCode = await component.run();
    setQuiet(quiet);
    if (exitCode !== 0) {
      fail(`add ${component.name} failed; aborting init.`);
      return exitCode;
    }
    success(`add ${component.name} done`);
  }

  // -------------------------------------------------------------------------
  // Phase 4: bun install
  // -------------------------------------------------------------------------
  if (!skipInstall) {
    stepHeader('4. bun install');
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
    stepHeader('5. doctor (self-check)');
    setQuiet(quiet);
    const doctorExit = await runDoctor(projectRoot, {quiet: true});
    setQuiet(quiet);
    if (doctorExit !== 0) {
      warn(
        'doctor reported issues; review and re-run components or run `bunx justin-sdk doctor` for details.',
      );
    } else {
      success('All doctor checks passed');
    }
  }

  // -------------------------------------------------------------------------
  // Phase 6: Final git commit
  // -------------------------------------------------------------------------
  if (!noCommit) {
    stepHeader('6. Git commit');
    const sdkVersion = getSdkVersion();
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
