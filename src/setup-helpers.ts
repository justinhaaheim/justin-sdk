/**
 * setup-helpers.ts — Shared utilities for justin-sdk's add subcommands
 * (base-setup, beads-setup, etc.). Provides command execution, colored
 * logging with a shared QUIET mode, filesystem helpers, and JSON helpers.
 *
 * All step functions across setup modules use these — keeps output
 * consistent and avoids duplication.
 */

import {execSync} from 'child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import {resolve} from 'path';

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

export function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
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
