#!/usr/bin/env bun

/**
 * Signal check — runs TypeScript, ESLint, and Prettier checks in parallel.
 * Uses the check-runner engine for execution and reporting.
 *
 * Usage:
 *   bun scripts/signal.ts           # Parallel with output (default)
 *   bun scripts/signal.ts --quiet   # Summary only
 *   bun scripts/signal.ts --serial  # Sequential execution
 */

import type {Check} from '@justinhaaheim/justin-sdk/check-runner';

import {runChecks} from '@justinhaaheim/justin-sdk/check-runner';

const checks: Check[] = [
  {command: 'bun run ts-check', label: 'TS'},
  {command: 'bun run lint-base -- .', label: 'LINT'},
  {command: 'bun run prettier:check', label: 'PRETTIER'},
];

const flags = new Set(process.argv.slice(2));

const exitCode = await runChecks(checks, {
  align: flags.has('--align'),
  quiet: flags.has('--quiet'),
  serial: flags.has('--serial'),
});

process.exit(exitCode);
