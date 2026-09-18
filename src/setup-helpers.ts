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

import {findLocalPrettier} from './local-fs';

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
 * `readJson` and `findLocalPrettier` LIVE in `local-fs.ts` — see the header
 * there for why they are split out at all (it was the plugin's import-closure
 * constraint, retired in dchjw.8). They are re-exported here, not
 * re-implemented, so their ~17 existing callers keep one import site and there
 * is exactly one copy of each.
 */
export {findLocalPrettier, readJson} from './local-fs';

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
 *
 * This is a RAW SUBSTRING check, and that is deliberate: two callers depend on
 * it (base-setup searches for the `dynamic-version.local` PREFIX shared by two
 * lines, and a caller may search for a markdown reference). For ignore files
 * — .gitignore, .prettierignore — use `ensureIgnoreEntries` instead: substring
 * matching is what let a globstar-prefixed `.claude/worktrees/` be appended
 * next to an existing plain `.claude/worktrees` (home-base-dchjw.6).
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
// Ignore files (.gitignore / .prettierignore)
// ---------------------------------------------------------------------------

/**
 * Reduce an ignore-file pattern to the form used for "do we already ignore
 * this?" comparisons: trim, strip a leading globstar prefix (two stars and a
 * slash), strip a trailing `/`.
 *
 * Those three spellings denote the same path in both gitignore and prettier
 * syntax: a globstar-prefixed `dist`, `dist/` and `dist` all match dist at any
 * depth, and the trailing slash only narrows the match to directories.
 *
 * A leading `/` is deliberately NOT stripped: `/tmp` (root only) and `tmp`
 * (any depth) are genuinely different patterns, and rewriting one into the
 * other would change which files the tool touches.
 */
export function normalizeIgnorePattern(line: string): string {
  let out = line.trim();
  if (out.startsWith('**/')) out = out.slice(3);
  if (out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

/** Lines that carry no pattern: blank, comment, or a negation (`!foo`). */
function isIgnoreEntryLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('!')) {
    return false;
  }
  return normalizeIgnorePattern(trimmed) !== '';
}

export interface EnsureIgnoreEntriesResult {
  /** Entries that were not present in any spelling and were appended. */
  added: ReadonlyArray<string>;
  /** Lines rewritten from a different spelling to the canonical one. */
  rewritten: ReadonlyArray<{from: string; to: string}>;
  /** Redundant repeats of a canonical entry that were collapsed away. */
  removed: ReadonlyArray<string>;
  /** True when the file was written. */
  changed: boolean;
}

/**
 * Make `entries` present, exactly once each, in an ignore file — matching by
 * NORMALIZED LINE rather than substring.
 *
 * For each entry, in order:
 *  - no line normalizes to it → append it (all appends land in one block).
 *  - a line normalizes to it under a different spelling → REWRITE that line to
 *    the canonical spelling (Justin, 2026-09-16: "we should replace the
 *    `.claude/worktrees` entry", not add a second one beside it).
 *  - more than one line normalizes to it → keep the first, drop the rest. They
 *    are the same pattern twice, so dropping them ignores exactly the same
 *    paths as before.
 *
 * Comments, blank lines and negations (`!foo`) are never matched or touched,
 * and nothing outside a matched line is reordered. The file is written only
 * when something actually changed, so a re-run is a true no-op.
 */
export function ensureIgnoreEntries(
  filePath: string,
  entries: ReadonlyArray<string>,
  options: {sectionHeader?: string} = {},
): EnsureIgnoreEntriesResult {
  const original = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '';
  // `null` marks a line scheduled for removal; filtered out at the end.
  const lines: Array<string | null> =
    original === '' ? [] : original.replace(/\n$/, '').split('\n');

  const added: string[] = [];
  const rewritten: Array<{from: string; to: string}> = [];
  const removed: string[] = [];

  for (const entry of entries) {
    const wanted = normalizeIgnorePattern(entry);
    const matches: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line == null || !isIgnoreEntryLine(line)) continue;
      if (normalizeIgnorePattern(line) === wanted) matches.push(i);
    }

    if (matches.length === 0) {
      added.push(entry);
      continue;
    }

    const [keep, ...extras] = matches;
    const existing = lines[keep] as string;
    // NEVER STRIP A TRAILING SLASH (dchjw.15). The slash is not a spelling
    // variant: `tmp/` ignores the DIRECTORY tmp and `tmp` ignores anything of
    // that name, file included. Normalizing it away is right for MATCHING (the
    // two patterns are about the same path) and wrong for WRITING — a baseline
    // entry spelled without the slash would silently widen every repo's
    // directory-only rule into a file-and-directory rule. So the canonical
    // spelling is adopted for everything else (the globstar prefix, which does
    // not change what matches) and the existing line's slash is carried over.
    const target =
      existing.trim().endsWith('/') && !entry.endsWith('/')
        ? `${entry}/`
        : entry;
    if (existing.trim() !== target) {
      rewritten.push({from: existing.trim(), to: target});
      lines[keep] = target;
    }
    for (const idx of extras) {
      removed.push((lines[idx] as string).trim());
      lines[idx] = null;
    }
  }

  const changed =
    added.length > 0 || rewritten.length > 0 || removed.length > 0;
  if (!changed) return {added, changed: false, removed, rewritten};

  let body = lines.filter((line): line is string => line != null).join('\n');
  if (body !== '') body += '\n';

  if (added.length > 0) {
    if (body !== '') body += '\n';
    if (options.sectionHeader != null) body += `# ${options.sectionHeader}\n`;
    body += added.join('\n') + '\n';
  }

  writeFileSync(filePath, body);
  return {added, changed: true, removed, rewritten};
}

// ---------------------------------------------------------------------------
// SDK metadata helpers
// ---------------------------------------------------------------------------

/**
 * `getSdkVersion` lives in sdk-identity.ts (D4). It used to live here and answer
 * `'0.0.0'` on failure; it now answers `null`, and the move is what makes the
 * new signature visible at every import site rather than silently compatible.
 */

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
