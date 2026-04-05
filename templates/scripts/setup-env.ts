#!/usr/bin/env bun
/**
 * setup-env.ts — Ensure development tools are installed and available.
 *
 * Behavior differs by environment:
 *   - Remote (CLAUDE_CODE_REMOTE=true): Bootstraps mise + PATH, then
 *     delegates to `doctor --fix` for tool installation and validation.
 *   - Local: Runs `doctor --quiet` to validate the environment.
 *
 * This script is designed to be copied into any project at scripts/setup-env.ts
 * and referenced by a SessionStart hook in .claude/settings.json.
 *
 * It is idempotent and safe to re-run.
 */

import {execSync} from 'child_process';
import {appendFileSync, existsSync} from 'fs';
import {resolve} from 'path';

const HOME = process.env.HOME ?? '/root';
const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const MISE_BIN = resolve(HOME, '.local/bin/mise');
const MISE_SHIMS_DIR = resolve(HOME, '.local/share/mise/shims');
const IS_REMOTE = process.env.CLAUDE_CODE_REMOTE === 'true';

function run(
  cmd: string,
  options?: {cwd?: string; ignoreError?: boolean},
): string {
  try {
    return execSync(cmd, {
      cwd: options?.cwd ?? PROJECT_ROOT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    if (options?.ignoreError) return '';
    throw error;
  }
}

function log(msg: string): void {
  console.log(`[setup-env] ${msg}`);
}

function warn(msg: string): void {
  console.warn(`[setup-env] ⚠ ${msg}`);
}

// ---------------------------------------------------------------------------
// Remote environment setup
// ---------------------------------------------------------------------------

function setupRemote(): void {
  log('Remote environment detected. Installing tools...');

  // Phase 1: Bootstrap — things that must happen before doctor can run

  // 1a. Install node dependencies (needed for SDK / doctor to be available)
  log('Installing node dependencies...');
  run('bun install', {ignoreError: true});

  // 1b. Install mise if not present
  if (!existsSync(MISE_BIN)) {
    log('Installing mise...');
    run('curl -fsSL https://mise.run | sh', {ignoreError: true});
  }

  // 1c. Ensure mise shims + ~/.local/bin are on PATH
  const envFile = process.env.CLAUDE_ENV_FILE;
  if (envFile) {
    if (existsSync(MISE_BIN)) {
      log('Adding mise shims to PATH...');
      appendFileSync(envFile, `export PATH="${MISE_SHIMS_DIR}:$PATH"\n`);
    }
    const localBin = resolve(HOME, '.local/bin');
    appendFileSync(envFile, `export PATH="${localBin}:$PATH"\n`);
  } else {
    warn(
      'CLAUDE_ENV_FILE not set. Tool binaries may not be on PATH for subsequent commands.',
    );
  }

  // Phase 2: Delegate to doctor --fix for everything else
  // Doctor handles: mise install, br install (with direct fallback),
  // br init, AGENTS.md generation, and all other component checks.
  log('Running doctor --fix...');
  try {
    execSync('bun run doctor --fix', {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      stdio: 'inherit',
    });
    log('Remote setup complete.');
  } catch {
    warn('doctor --fix reported failures. Check output above.');
  }
}

// ---------------------------------------------------------------------------
// Local environment validation
// ---------------------------------------------------------------------------

function validateLocal(): void {
  const doctorScript = resolve(PROJECT_ROOT, 'scripts/doctor.ts');
  if (!existsSync(doctorScript)) {
    log('Local environment OK (doctor script not found, skipping checks).');
    return;
  }

  try {
    execSync('bun scripts/doctor.ts --quiet', {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      stdio: 'inherit',
    });
  } catch {
    // doctor prints its own output — no need to duplicate
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  if (IS_REMOTE) {
    setupRemote();
  } else {
    validateLocal();
  }
}

main();
