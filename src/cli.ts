#!/usr/bin/env bun

/**
 * justin-sdk CLI
 *
 * Cross-project tooling for Justin's projects.
 * Provides doctor checks, signal (code quality) checks, and more.
 */

import yargs from 'yargs';
import {hideBin} from 'yargs/helpers';

import {runAgent} from './agent';
import {runBaseSetup} from './base-setup';
import {runBeadsSetup} from './beads-setup';
import {runDoctor} from './doctor';
import {runSignal} from './signal';

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
    'add <component>',
    'Add a justin-sdk component to the current project',
    (y) =>
      y
        .positional('component', {
          type: 'string',
          describe: 'Component to add',
          choices: ['base-setup', 'beads'],
        })
        .option('commit', {
          type: 'boolean',
          describe: 'Create a git commit at the end (use --no-commit to skip)',
          default: true,
        }),
    async (argv) => {
      if (argv.component === 'base-setup') {
        const exitCode = await runBaseSetup({
          projectRoot: process.cwd(),
        });
        process.exit(exitCode);
      }
      if (argv.component === 'beads') {
        const exitCode = await runBeadsSetup({
          noCommit: !argv.commit,
          projectRoot: process.cwd(),
        });
        process.exit(exitCode);
      }
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
  .demandCommand(1, 'Please specify a command')
  .strict()
  .help()
  .parse();
