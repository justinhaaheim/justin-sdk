/**
 * Shared contract for the deployed critical-rules file
 * (~/.claude/rules/justin-sdk/critical-rules.md): its path and the HTML-comment
 * stamp format. `sync-rules` WRITES the stamp; the SessionStart hook READS it
 * for the drift check — so both must agree, hence one module.
 *
 * The stamp is an HTML comment (Claude Code does not render HTML comments into
 * context, so it's invisible to the model) carrying the version-manager
 * version, the source commit sha, and a content hash. Example:
 *   <!-- justin-sdk rules · v0.4.14 · commit cc6573bb0834 · content 84bf3e47bf75 · generated 2026-… · GENERATED FILE — do not edit; run: bunx justin-sdk sync-rules -->
 */

import {createHash} from 'crypto';
import {existsSync, readFileSync} from 'fs';
import {join} from 'path';

export const STAMP_PREFIX = '<!-- justin-sdk rules';

/** Stable short hash of the rules body — the drift/idempotency key. Both the
 * writer (sync-rules) and the reader (hook drift check) hash the SAME thing
 * (the assembled universal markdown), so drift = "would sync-rules produce
 * different content?" — immune to commits that don't change rule content. */
export function contentHash(markdown: string): string {
  return createHash('sha256').update(markdown).digest('hex').slice(0, 12);
}

/**
 * Universal invocations. `@justinhaaheim/justin-sdk` is a GitHub package (not on
 * npm), so the short `bunx justin-sdk …` only resolves in a project that has it
 * as a devDep. The `github:` spec works from ANY project, so it's what we tell
 * the user to run. (Where the devDep exists, the short form also works.)
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

/** True if the deployed file was generated from a dirty working tree. */
export function deployedIsDirty(stamp: RulesStamp | null): boolean {
  return stamp?.commit.endsWith('-dirty') ?? false;
}
