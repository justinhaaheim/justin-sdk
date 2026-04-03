#!/usr/bin/env bun
/**
 * setup-env.ts — Ensure development tools are installed and available.
 *
 * Behavior differs by environment:
 *   - Remote (CLAUDE_CODE_REMOTE=true): Installs mise, runs `mise install`,
 *     adds shims to PATH, initializes beads_rust, runs `bun install`.
 *     Falls back to direct GitHub release download if mise is rate-limited.
 *   - Local: Validates that required tools are available and prints
 *     actionable errors if they're not. Does not install anything.
 *
 * This script is designed to be copied into any project at scripts/setup-env.ts
 * and referenced by a SessionStart hook in .claude/settings.json.
 *
 * It is idempotent and safe to re-run.
 */

import {execSync} from 'child_process';
import {appendFileSync, existsSync, readFileSync} from 'fs';
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
// beads_rust version from mise.toml
// ---------------------------------------------------------------------------

function getBeadsVersionFromMiseToml(): string | null {
  const miseToml = resolve(PROJECT_ROOT, 'mise.toml');
  if (!existsSync(miseToml)) return null;
  const content = readFileSync(miseToml, 'utf-8');
  const match = /Dicklesworthstone\/beads_rust.*?version\s*=\s*"([^"]+)"/.exec(
    content,
  );
  return match?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Direct install fallback (when mise is rate-limited by GitHub)
// ---------------------------------------------------------------------------

const BR_DIRECT_BIN = resolve(HOME, '.local/bin/br');

function installBrDirect(): boolean {
  const version = getBeadsVersionFromMiseToml();
  if (!version) {
    warn(
      'Cannot determine beads_rust version from mise.toml. Skipping direct install.',
    );
    return false;
  }

  const versionTag = version.startsWith('v') ? version : `v${version}`;
  log(
    `Installing br ${versionTag} directly from GitHub releases (mise fallback)...`,
  );

  try {
    run(
      `curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/beads_rust/main/install.sh" | bash -s -- --version ${versionTag} --quiet --skip-skills`,
    );
  } catch {
    warn('Direct br install failed.');
    return false;
  }

  if (existsSync(BR_DIRECT_BIN)) {
    log(`br installed successfully at ${BR_DIRECT_BIN}`);
    return true;
  }

  warn('br binary not found after direct install.');
  return false;
}

// ---------------------------------------------------------------------------
// Beads initialization (shared between remote and local)
// ---------------------------------------------------------------------------

function initializeBeads(brBin: string): void {
  const beadsDir = resolve(PROJECT_ROOT, '.beads');
  const beadsDb = resolve(beadsDir, 'beads.db');

  if (existsSync(beadsDb)) {
    log('beads_rust already initialized.');
    return;
  }

  // Check for old beads data that needs migration
  const metadataPath = resolve(beadsDir, 'metadata.json');
  if (existsSync(metadataPath)) {
    try {
      const meta = readFileSync(metadataPath, 'utf-8');
      if (meta.includes('"dolt"')) {
        warn(
          'Existing .beads/ directory uses Dolt backend. ' +
            'Run the beads-setup.md migration steps before initializing beads_rust.',
        );
        return;
      }
    } catch {
      // metadata unreadable — proceed with init
    }
  }

  log('Initializing beads_rust workspace...');
  run(`"${brBin}" init`);

  // Generate AGENTS.md
  run(`"${brBin}" agents --add --force`, {ignoreError: true});

  // Verify
  const version = run(`"${brBin}" --version`, {ignoreError: true});
  if (version) {
    log(`beads_rust ${version} initialized successfully.`);
  }
}

// ---------------------------------------------------------------------------
// Remote environment setup
// ---------------------------------------------------------------------------

function setupRemote(): void {
  log('Remote environment detected. Installing tools...');

  // 1. Install node dependencies
  log('Installing node dependencies...');
  run('bun install', {ignoreError: true});

  // 2. Install mise if not present
  if (!existsSync(MISE_BIN)) {
    log('Installing mise...');
    run('curl -fsSL https://mise.run | sh');
  }

  const miseAvailable = existsSync(MISE_BIN);
  if (!miseAvailable) {
    warn(
      `mise binary not found at ${MISE_BIN} after install. Will try direct fallback for tools.`,
    );
  }

  // 3. Install mise-managed tools from mise.toml
  if (miseAvailable) {
    if (existsSync(resolve(PROJECT_ROOT, 'mise.toml'))) {
      log('Installing mise tools from mise.toml...');
      run(`"${MISE_BIN}" install --yes`, {ignoreError: true});
    } else {
      log('No mise.toml found. Skipping mise tool installation.');
    }
  }

  // 4. Add mise shims to PATH via CLAUDE_ENV_FILE
  const envFile = process.env.CLAUDE_ENV_FILE;
  if (envFile) {
    if (miseAvailable) {
      log('Adding mise shims to PATH...');
      appendFileSync(envFile, `export PATH="${MISE_SHIMS_DIR}:$PATH"\n`);
    }
    // Ensure ~/.local/bin is on PATH for direct-install fallback
    const localBin = resolve(HOME, '.local/bin');
    appendFileSync(envFile, `export PATH="${localBin}:$PATH"\n`);
  } else {
    warn(
      'CLAUDE_ENV_FILE not set. Tool binaries may not be on PATH for subsequent commands.',
    );
  }

  // 5. Initialize beads_rust if br is available and .beads/ doesn't exist
  const brBin = resolve(MISE_SHIMS_DIR, 'br');
  if (existsSync(brBin)) {
    initializeBeads(brBin);
  } else {
    // Fallback: install br directly from GitHub releases (mise may be rate-limited)
    log('br not found in mise shims. Trying direct install from GitHub...');
    if (installBrDirect()) {
      initializeBeads(BR_DIRECT_BIN);
    } else {
      warn('br could not be installed. Skipping beads initialization.');
    }
  }

  log('Remote setup complete.');
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
