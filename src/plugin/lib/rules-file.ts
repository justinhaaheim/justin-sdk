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

import {execFileSync, execSync} from 'child_process';
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
 * Format markdown with prettier. By default `bunx prettier --write <tmpfile>`,
 * using bunx (not an `import prettier`) ON PURPOSE: bunx self-fetches prettier,
 * so this runs in the plugin cache which has no node_modules — importing
 * prettier would throw there. Returns the input unchanged when disabled or on
 * any failure (offline, etc.), so it never blocks. Run BEFORE hashing so
 * trivial formatting normalizes out.
 *
 * `options.binary` runs THAT prettier instead (config still resolved by
 * prettier itself, from the temp file's location — so pass a config path via
 * the binary's own project if it matters). The committed per-repo artifact uses
 * this to format with the TARGET REPO'S OWN prettier: that artifact is checked
 * by the repo's `signal`/lint-staged, and a newer bunx prettier formatting it
 * differently from the repo's pinned one would fail that gate. Same reasoning
 * as `writeJson` in setup-helpers (Justin's 2026-08-08 ruling: always format
 * what we write with the repo's own prettier). Resolution of the binary lives
 * OUTSIDE this module on purpose — src/plugin/lib runs from the plugin cache
 * and must not import setup-helpers, which isn't shipped there.
 */
export function prettierMarkdown(
  markdown: string,
  options?: {binary?: string | null},
): string {
  if (!prettierEnabled()) return markdown.trimEnd();
  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(tmpdir(), 'jsdk-prettier-'));
    const file = join(dir, 'rules.md');
    writeFileSync(file, markdown);
    const binary = options?.binary;
    if (binary != null && binary.length > 0) {
      execFileSync(binary, ['--write', file], {stdio: 'pipe', timeout: 60_000});
    } else {
      execSync(`bunx prettier --write ${file}`, {
        stdio: 'pipe',
        timeout: 60_000,
      });
    }
    return readFileSync(file, 'utf-8').trimEnd();
  } catch {
    return markdown.trimEnd();
  } finally {
    if (dir != null) rmSync(dir, {recursive: true, force: true});
  }
}

/**
 * Universal invocations. `@justinhaaheim/justin-sdk` is a GitHub package (not on
 * npm), so `bunx @justinhaaheim/justin-sdk …` only resolves in a project that
 * has it as a devDep. The `github:` spec works from ANY project, so it's what we
 * tell the user to run. (Where the devDep exists, the scoped form also works —
 * and the BARE name is never used anywhere: it falls through to the npm registry,
 * home-base-2qhw.)
 */
export const SDK_BUNX = 'bunx github:justinhaaheim/justin-sdk';
export const SYNC_RULES_CMD = `${SDK_BUNX} sync-rules`;
export const PRIME_FULL_CMD = `${SDK_BUNX} prime --full`;
/** The pull channel for the COMMITTED per-repo artifact (t6a0.21 D4). Lands in
 * home-base-q1hp — stamped into artifacts now so the file names its own
 * regeneration command from day one. */
export const RULES_UPDATE_CMD = `${SDK_BUNX} rules-update`;

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

/**
 * Path segments of the COMMITTED per-repo rules artifact, relative to a project
 * root: `.claude/rules/justin-sdk/critical-rules.md` (t6a0.21 D1/D13).
 *
 * `.claude/rules/` is a first-class Claude Code autoload location (project
 * scope, recursive, same priority as CLAUDE.md, no truncation cap), and the
 * `justin-sdk/` subdirectory is tool-owned by contract — which is what lets
 * `rules-update` and the sweep overwrite anything under it.
 */
export const PROJECT_RULES_SEGMENTS = [
  '.claude',
  'rules',
  'justin-sdk',
  'critical-rules.md',
] as const;

export function projectRulesFilePath(projectRoot: string): string {
  return join(projectRoot, ...PROJECT_RULES_SEGMENTS);
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

/**
 * Build the stamp line.
 *
 * `version` is OPTIONAL and the committed per-repo artifact deliberately omits
 * it: stamping an SDK version there would make an SDK release change the bytes
 * of a committed file in twelve repos — the exact coupling `sweep --component`
 * exists to break. That artifact's identity is (prompts commit, content hash);
 * `readDeployedStamp` reports version 'unknown' for it, correctly.
 *
 * `command` names the regeneration command for the file being stamped —
 * `sync-rules` for the user-level file, `rules-update` for the committed one.
 * A wrong command here would send an editor to regenerate a DIFFERENT file.
 */
export function buildStamp(opts: {
  version?: string;
  commit: string; // sha, sha-dirty, or 'unknown'
  contentHash: string;
  generated: string; // ISO timestamp or YYYY-MM-DD date
  command?: string;
}): string {
  const version =
    opts.version != null && opts.version.length > 0
      ? ` · v${opts.version}`
      : '';
  return (
    `${STAMP_PREFIX}${version} · commit ${opts.commit} · content ${opts.contentHash}` +
    ` · generated ${opts.generated} · GENERATED FILE — do not edit; run: ${opts.command ?? SYNC_RULES_CMD} -->`
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
