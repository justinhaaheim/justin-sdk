#!/usr/bin/env bun

/**
 * Doctor — validates that the development environment has all required tools
 * installed and configured correctly.
 *
 * Usage:
 *   bun scripts/doctor.ts           # Run all checks
 *   bun scripts/doctor.ts --fix     # Attempt to fix failures automatically
 *   bun scripts/doctor.ts --quiet   # Summary only
 */

import type {Check, CheckResult} from '@justinhaaheim/justin-sdk/check-runner';

import {execSync} from 'child_process';
import {existsSync, readFileSync} from 'fs';
import {resolve} from 'path';

import {runChecks} from '@justinhaaheim/justin-sdk/check-runner';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function exec(cmd: string): {exitCode: number; stdout: string} {
  try {
    const stdout = execSync(cmd, {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return {exitCode: 0, stdout};
  } catch {
    return {exitCode: 1, stdout: ''};
  }
}

// ---------------------------------------------------------------------------
// Checks — Base
// ---------------------------------------------------------------------------

function checkClaudeMdExists(): CheckResult {
  const claudeMd = resolve(PROJECT_ROOT, 'CLAUDE.md');
  if (!existsSync(claudeMd)) {
    return {
      message: 'No CLAUDE.md found',
      pass: false,
    };
  }
  return {pass: true};
}

function checkPackageScripts(): CheckResult {
  const pkgPath = resolve(PROJECT_ROOT, 'package.json');
  if (!existsSync(pkgPath)) {
    return {
      message: 'No package.json found',
      pass: false,
    };
  }

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
    scripts?: Record<string, string>;
  };
  const scripts = pkg.scripts ?? {};
  const required = ['setup-env', 'signal', 'doctor'];
  const missingScripts = required.filter((name) => !(name in scripts));

  if (missingScripts.length > 0) {
    return {
      fix: `Add missing scripts to package.json: ${missingScripts.join(', ')}`,
      message: `Missing package.json scripts: ${missingScripts.join(', ')}`,
      pass: false,
    };
  }

  return {pass: true};
}

// ---------------------------------------------------------------------------
// Checks — Beads (add these after applying beads-setup)
// ---------------------------------------------------------------------------

// Uncomment and add to the checks array after applying beads-setup:
//
// function checkMise(): CheckResult { ... }
// function checkMiseToml(): CheckResult { ... }
// function checkBeadsRust(): CheckResult { ... }
// function checkBeadsDb(): CheckResult { ... }
// function checkAgentsMd(): CheckResult { ... }
// function checkClaudeMdRef(): CheckResult { ... }
// function checkPrettierIgnoreBeads(): CheckResult { ... }
//
// See beads-setup.md Step 6 for the full check implementations.

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const checks: Check[] = [
  {fn: checkClaudeMdExists, label: 'CLAUDE_MD'},
  {fn: checkPackageScripts, label: 'PKG_SCRIPTS'},
];

const flags = new Set(process.argv.slice(2));

const exitCode = await runChecks(checks, {
  align: true,
  fix: flags.has('--fix'),
  quiet: flags.has('--quiet'),
  serial: true,
});

process.exit(exitCode);
