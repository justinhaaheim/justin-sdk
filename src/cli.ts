#!/usr/bin/env bun

/**
 * justin-sdk CLI
 *
 * Cross-project tooling for Justin's projects.
 * Provides doctor checks, signal (code quality) checks, and more.
 */

import yargs from 'yargs';
import {hideBin} from 'yargs/helpers';

import {ADD_TARGETS, PRESET_NAMES, runAdd} from './add';
import {runAgent} from './agent';
import {runDoctor} from './doctor';
import {runFix} from './fix';
import {runInit} from './init';
import {runPrime} from './prime';
import {runSignal} from './signal';
import {runUpdate} from './update';

void yargs(hideBin(process.argv))
  .scriptName('justin-sdk')
  .command(
    'doctor',
    'Run environment checks based on justin-sdk.config.json components',
    (y) =>
      y
        .option('fix', {
          type: 'boolean',
          describe: 'Attempt to auto-fix failures',
          default: false,
        })
        .option('quiet', {
          type: 'boolean',
          describe: 'Summary only (one-liner on all-pass)',
          default: false,
        })
        .option('yes', {
          alias: 'y',
          type: 'boolean',
          describe:
            'Pre-approve fixes that modify system state (installs, global packages). Without this, those fixes are reported but skipped.',
          default: false,
        }),
    async (argv) => {
      const exitCode = await runDoctor(process.cwd(), {
        fix: argv.fix,
        quiet: argv.quiet,
        yes: argv.yes,
      });
      process.exit(exitCode);
    },
  )
  .command(
    'signal',
    'Run code quality checks from package.json signal-source:* scripts',
    (y) =>
      y
        .option('quiet', {
          type: 'boolean',
          describe: 'Summary only (one-liner on all-pass)',
          default: false,
        })
        .option('serial', {
          type: 'boolean',
          describe: 'Run checks sequentially instead of in parallel',
          default: false,
        }),
    async (argv) => {
      const exitCode = await runSignal(process.cwd(), {
        quiet: argv.quiet,
        serial: argv.serial,
      });
      process.exit(exitCode);
    },
  )
  .command(
    'fix',
    'Auto-fix code from package.json fix-source:* scripts (eslint --fix, prettier --write). Runs serially and mutates files. Distinct from doctor, which fixes scaffolding (configs/deps), not code.',
    (y) =>
      y.option('quiet', {
        type: 'boolean',
        describe: 'Summary only (one-liner on all-pass)',
        default: false,
      }),
    async (argv) => {
      const exitCode = await runFix(process.cwd(), {
        quiet: argv.quiet,
      });
      process.exit(exitCode);
    },
  )
  .command(
    'add <target>',
    `Add a justin-sdk component or preset (${PRESET_NAMES.join(', ')}) to the current project`,
    (y) =>
      y
        .positional('target', {
          type: 'string',
          describe:
            'Component to add, or a preset that expands to several (minimal = base-setup + beads; core = code-quality + beads; all = everything)',
          choices: ADD_TARGETS,
        })
        .option('commit', {
          type: 'boolean',
          describe:
            'Create a git commit at the end (single-component beads only). Default is off — pass --commit to opt in. Without it, files change in the working tree but nothing is committed, so you can run it like a dry run and inspect the diff first. Presets are always no-commit and ignore this flag.',
          default: false,
        })
        .option('force', {
          type: 'boolean',
          describe:
            "Overwrite hand-modified files (currently: scripts/setup-env.ts) that differ from the SDK template and don't match a known-old hash",
          default: false,
        }),
    async (argv) => {
      const exitCode = await runAdd(argv.target as string, {
        commit: argv.commit,
        force: argv.force,
        projectRoot: process.cwd(),
      });
      process.exit(exitCode);
    },
  )
  .command(
    'init',
    'Scaffold a greenfield project (package.json + all add components; pass --commit to also commit)',
    (y) =>
      y
        .option('preset', {
          type: 'string',
          describe: 'Preset to use',
          default: 'node-cli',
          choices: ['node-cli'],
        })
        .option('allow-dirty', {
          type: 'boolean',
          describe: 'Allow running with uncommitted changes',
          default: false,
        })
        .option('commit', {
          type: 'boolean',
          describe:
            'Create a single git commit at the end. Default is off — pass --commit to opt in. Without it, files change in the working tree but nothing is committed, so you can inspect the diff first.',
          default: false,
        })
        .option('force', {
          type: 'boolean',
          describe: 'Pass --force to underlying add commands',
          default: false,
        }),
    async (argv) => {
      if (argv.preset !== 'node-cli') {
        console.error(
          `Error: preset '${argv.preset}' not yet supported (planned for future release)`,
        );
        process.exit(1);
      }
      const exitCode = await runInit({
        allowDirty: argv['allow-dirty'],
        force: argv.force,
        noCommit: !argv.commit,
        projectRoot: process.cwd(),
      });
      process.exit(exitCode);
    },
  )
  .command(
    'update',
    "Sync this project to the SDK's current pinned state (re-applies all components)",
    (y) =>
      y
        .option('self-update', {
          type: 'boolean',
          describe:
            'Bump the SDK in devDependencies first, then re-exec the new CLI (use --no-self-update to skip)',
          default: true,
        })
        .option('commit', {
          type: 'boolean',
          describe:
            'Create a single git commit at the end. Default is off — pass --commit to opt in.',
          default: false,
        })
        .option('allow-dirty', {
          type: 'boolean',
          describe:
            'Allow running with uncommitted changes (commit step still respects --commit)',
          default: false,
        })
        .option('dry-run', {
          type: 'boolean',
          describe: 'Print the plan without writing',
          default: false,
        })
        .option('force', {
          type: 'boolean',
          describe: 'Pass --force to underlying add commands',
          default: false,
        })
        .option('skip-prompts-fetch', {
          type: 'boolean',
          describe: 'Skip fetching the prompts library (used by tests)',
          default: false,
        })
        .option('quiet', {
          type: 'boolean',
          describe: 'Suppress non-error output',
          default: false,
        }),
    async (argv) => {
      const exitCode = await runUpdate({
        allowDirty: argv['allow-dirty'],
        dryRun: argv['dry-run'],
        force: argv.force,
        noCommit: !argv.commit,
        noSelfUpdate: !argv['self-update'],
        projectRoot: process.cwd(),
        quiet: argv.quiet,
        skipPromptsFetch: argv['skip-prompts-fetch'],
      });
      process.exit(exitCode);
    },
  )
  .command(
    'agent',
    'Print the agent playbook (self-contained instructions for AI coding agents)',
    (y) => y,
    () => {
      runAgent();
      process.exit(0);
    },
  )
  .command(
    'prime',
    'Assemble + emit the critical-guidelines for the current project from the prompts repo (read-only, no network)',
    (y) =>
      y
        .option('format', {
          type: 'string',
          choices: ['markdown', 'hook'] as const,
          default: 'markdown',
          describe:
            'markdown = human-readable (default); hook = SessionStart additionalContext JSON envelope',
        })
        .option('prompts-dir', {
          type: 'string',
          describe:
            'Override the prompts repo location (default: $JSDK_PROMPTS_DIR or ~/Dev/prompts)',
        })
        .option('force-update', {
          type: 'boolean',
          describe:
            'Force a fetch/pull of the managed prompts clone, bypassing the staleness gate',
          default: false,
        }),
    (argv) => {
      const exitCode = runPrime(process.cwd(), {
        format: argv.format as 'markdown' | 'hook',
        promptsDir: argv['prompts-dir'],
        forceUpdate: argv['force-update'],
      });
      process.exit(exitCode);
    },
  )
  .demandCommand(1, 'Please specify a command')
  .strict()
  .help()
  .parse();
