/**
 * setup-helpers.ts — Shared utilities for justin-sdk's add subcommands
 * (base-setup, beads-setup, etc.). Provides command execution, colored
 * logging with a shared QUIET mode, filesystem helpers, and JSON helpers.
 *
 * All step functions across setup modules use these — keeps output
 * consistent and avoids duplication.
 */

import {execFileSync, execSync} from 'child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import {dirname, resolve} from 'path';

import {findLocalPrettier} from './plugin/lib/local-fs';

// ---------------------------------------------------------------------------
// Quiet mode (module-level flag toggled by runBase/runBeads/etc.)
// ---------------------------------------------------------------------------

let QUIET = false;

export function setQuiet(quiet: boolean): void {
  QUIET = quiet;
}

export function isQuiet(): boolean {
  return QUIET;
}

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function exec(cmd: string, cwd: string): ExecResult {
  try {
    const stdout = execSync(cmd, {
      cwd,
      // Pass the live process env explicitly. This is a no-op in normal use
      // (the default already inherits the environment), but Bun's execSync
      // snapshots env at startup and ignores later `process.env` mutations
      // unless `env` is passed — tests rely on setting env vars at runtime.
      env: process.env,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return {exitCode: 0, stdout, stderr: ''};
  } catch (error) {
    const err = error as {status?: number; stdout?: string; stderr?: string};
    return {
      exitCode: err.status ?? 1,
      stdout: (err.stdout ?? '').toString().trim(),
      stderr: (err.stderr ?? '').toString().trim(),
    };
  }
}

// ---------------------------------------------------------------------------
// Colored logging (respects QUIET)
// ---------------------------------------------------------------------------

export function log(msg: string): void {
  if (QUIET) return;
  console.log(`  ${msg}`);
}

export function stepHeader(msg: string): void {
  if (QUIET) return;
  console.log(`\x1b[1m${msg}\x1b[0m`);
}

export function success(msg: string): void {
  if (QUIET) return;
  console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
}

export function warn(msg: string): void {
  if (QUIET) return;
  console.warn(`  \x1b[33m⚠\x1b[0m ${msg}`);
}

/** Failures always print, even in quiet mode. */
export function fail(msg: string): void {
  console.error(`  \x1b[31m✗\x1b[0m ${msg}`);
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, {recursive: true});
}

/**
 * `readJson` and `findLocalPrettier` now LIVE in the plugin lib
 * (src/plugin/lib/local-fs.ts) because the SessionStart hook needs them and a
 * published plugin package contains only `src/plugin` — see the header there
 * (home-base-qjyj). They are re-exported here, not re-implemented, so their ~17
 * existing callers keep one import site and there is exactly one copy of each.
 */
export {findLocalPrettier, readJson} from './plugin/lib/local-fs';

/**
 * Write JSON and immediately format it IN PLACE with the target repo's own
 * prettier (binary resolved by walking up from the file; config resolved by
 * prettier itself from the file's location).
 *
 * Justin's ruling (2026-08-08, j2n7): ALWAYS format what we write — tool
 * output must be fully idempotent against a repo where prettier runs on
 * commit, and most fleet repos have one. Before this, every installer write
 * left a file the repo's own signal called dirty (the recurring t6a0.13
 * gotcha).
 *
 * No local prettier, or prettier errors → the plain 2-space JSON stands,
 * silently — exactly the old behavior.
 */
export function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
  const prettierBin = findLocalPrettier(dirname(resolve(path)));
  if (prettierBin == null) return;
  try {
    execFileSync(prettierBin, ['--write', '--ignore-unknown', path], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    });
  } catch {
    // Formatting is best-effort; the valid JSON already on disk stands.
  }
}

/**
 * Append `appendStr` to `filePath` only if `searchStr` is not already
 * present in the file. Creates the file with `appendStr` if missing.
 * Returns true if the file was modified.
 */
export function appendIfMissing(
  filePath: string,
  searchStr: string,
  appendStr: string,
): boolean {
  if (existsSync(filePath)) {
    const content = readFileSync(filePath, 'utf-8');
    if (content.includes(searchStr)) return false;
    appendFileSync(filePath, appendStr);
  } else {
    writeFileSync(filePath, appendStr);
  }
  return true;
}

// ---------------------------------------------------------------------------
// SDK metadata helpers
// ---------------------------------------------------------------------------

/** Read the SDK's own package.json version (the currently-running SDK). */
export function getSdkVersion(): string {
  const pkgPath = resolve(import.meta.dirname, '..', 'package.json');
  if (!existsSync(pkgPath)) return '0.0.0';
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Read the central versions.json pin for a tool (e.g., "beads_rust"). */
export function getPinnedToolVersion(toolName: string): string | null {
  const versionsPath = resolve(import.meta.dirname, '..', 'versions.json');
  if (!existsSync(versionsPath)) return null;
  try {
    const versions = JSON.parse(readFileSync(versionsPath, 'utf-8')) as Record<
      string,
      string
    >;
    return versions[toolName] ?? null;
  } catch {
    return null;
  }
}

/** Format today's date as YYYY-MM-DD. */
export function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Lowercase, replace any char outside [a-z0-9-] with '-', collapse
 * consecutive '-' into one, strip leading/trailing '-'.
 *
 * Used for both package.json names (npm requires kebab-style) and
 * beads issue prefixes (must be shell-safe and JSONL-friendly).
 */
export function kebabCase(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}
