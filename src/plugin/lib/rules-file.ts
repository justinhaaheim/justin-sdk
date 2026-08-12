/**
 * Shared contract for the deployed critical-rules file
 * (~/.claude/rules/justin-sdk/critical-rules.md): its path and the HTML-comment
 * stamp format. `sync-rules` WRITES the stamp; the SessionStart hook READS it
 * for the drift check — so both must agree, hence one module.
 *
 * The stamp is an HTML comment (Claude Code does not render HTML comments into
 * context, so it's invisible to the model) carrying the version-manager
 * version, the source commit sha, and a content hash. Example:
 *   <!-- justin-sdk rules · v0.4.14 · commit cc6573bb0834 · content 84bf3e47bf75 · generated 2026-… · GENERATED FILE — do not edit; run: bunx github:justinhaaheim/justin-sdk sync-rules -->
 */

import {execSync} from 'child_process';
import {createHash} from 'crypto';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

export const STAMP_PREFIX = '<!-- justin-sdk rules';

/** Stable short hash of the rules body — the drift/idempotency key. Both the
 * writer (sync-rules) and the reader (hook drift check) hash the SAME thing
 * (the Prettier'd, numbered assembled markdown), so drift = "would sync-rules
 * produce different content?" — immune to commits that don't change content
 * AND to meaningless formatting differences (Prettier normalizes them out). */
export function contentHash(markdown: string): string {
  return createHash('sha256').update(markdown).digest('hex').slice(0, 12);
}

/** Prettier is ON by default; JSDK_PRIME_PRETTIER=0/false/off/no disables it.
 * NOTE: this must be set consistently for the writer and the hook (it's part of
 * the hash); toggling it makes the next sync-rules re-stamp once. */
export function prettierEnabled(): boolean {
  const v = (process.env.JSDK_PRIME_PRETTIER ?? '').toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

/**
 * Format markdown with `bunx prettier --write <tmpfile>`. Uses bunx (not an
 * `import prettier`) ON PURPOSE: bunx self-fetches prettier, so this runs in the
 * plugin cache which has no node_modules — importing prettier would throw there.
 * Returns the input unchanged when disabled or on any failure (offline, etc.),
 * so it never blocks. Run BEFORE hashing so trivial formatting normalizes out.
 */
export function prettierMarkdown(markdown: string): string {
  if (!prettierEnabled()) return markdown.trimEnd();
  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(tmpdir(), 'jsdk-prettier-'));
    const file = join(dir, 'rules.md');
    writeFileSync(file, markdown);
    execSync(`bunx prettier --write ${file}`, {stdio: 'pipe', timeout: 60_000});
    return readFileSync(file, 'utf-8').trimEnd();
  } catch {
    return markdown.trimEnd();
  } finally {
    if (dir != null) rmSync(dir, {recursive: true, force: true});
  }
}

/**
 * Universal invocations. `@jhaa/justin-sdk` is a GitHub package (not on
 * npm), so `bunx @jhaa/justin-sdk …` only resolves in a project that
 * has it as a devDep. The `github:` spec works from ANY project, so it's what we
 * tell the user to run. (Where the devDep exists, the scoped form also works —
 * and the BARE name is never used anywhere: it falls through to the npm registry,
 * home-base-2qhw.)
 */
export const SDK_BUNX = 'bunx github:justinhaaheim/justin-sdk';
export const SYNC_RULES_CMD = `${SDK_BUNX} sync-rules`;
export const PRIME_FULL_CMD = `${SDK_BUNX} prime --full`;

/** ~/.claude/rules/justin-sdk/critical-rules.md — the user-level Claude Code
 * rules file that autoloads every session. */
export function rulesFilePath(): string {
  return join(
    process.env.HOME ?? '',
    '.claude',
    'rules',
    'justin-sdk',
    'critical-rules.md',
  );
}

export interface RulesStamp {
  version: string;
  /** Source commit sha (12 hex), possibly suffixed '-dirty', or 'unknown'. */
  commit: string;
  contentHash: string | null;
}

/** Parse the stamp from a deployed rules file. null = file missing, unreadable,
 * or unstamped. Never throws — a read error (EACCES, a directory at the path)
 * must not break the SessionStart hook. */
export function readDeployedStamp(file: string): RulesStamp | null {
  if (!existsSync(file)) return null;
  let firstLine: string;
  try {
    firstLine = readFileSync(file, 'utf-8').split('\n', 1)[0] ?? '';
  } catch {
    return null;
  }
  if (!firstLine.startsWith(STAMP_PREFIX)) return null;
  return {
    version: /· v(\S+)/.exec(firstLine)?.[1] ?? 'unknown',
    commit: /commit (\S+)/.exec(firstLine)?.[1] ?? 'unknown',
    contentHash: /content ([0-9a-f]+)/.exec(firstLine)?.[1] ?? null,
  };
}

export function buildStamp(opts: {
  version: string;
  commit: string; // sha, sha-dirty, or 'unknown'
  contentHash: string;
  generated: string; // ISO
}): string {
  return (
    `${STAMP_PREFIX} · v${opts.version} · commit ${opts.commit} · content ${opts.contentHash}` +
    ` · generated ${opts.generated} · GENERATED FILE — do not edit; run: ${SYNC_RULES_CMD} -->`
  );
}

/** The 12-char source sha the deployed file was generated from (strips
 * '-dirty'), or null if unknown. Drives the hook's drift fast-path. */
export function deployedSourceSha(stamp: RulesStamp | null): string | null {
  if (stamp == null) return null;
  const bare = stamp.commit.replace(/-dirty$/, '');
  return bare === 'unknown' ? null : bare.slice(0, 12);
}

/** True if the deployed file was generated from a dirty working tree. */
export function deployedIsDirty(stamp: RulesStamp | null): boolean {
  return stamp?.commit.endsWith('-dirty') ?? false;
}
