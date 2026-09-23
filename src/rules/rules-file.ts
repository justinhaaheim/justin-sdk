/**
 * Shared contract for the deployed critical-rules file
 * (~/.claude/rules/justin-sdk/critical-rules.md): its path and the HTML-comment
 * stamp format. `sync-rules` WRITES the stamp; the SessionStart hook READS it
 * for the drift check — so both must agree, hence one module.
 *
 * The stamp is an HTML comment (Claude Code does not render HTML comments into
 * context, so it's invisible to the model) carrying the version-manager
 * version, the source commit sha, and a content hash. Example:
 *   <!-- justin-sdk rules · v0.4.14 · commit cc6573bb0834 · content 84bf3e47bf75 · generated 2026-… · GENERATED FILE — do not edit; run: bun run justin-sdk rules-update -->
 */

import {execFileSync} from 'child_process';
import {createHash} from 'crypto';
import {existsSync, readFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {SDK_BOOTSTRAP} from '../sdk-invocation';

export const STAMP_PREFIX = '<!-- justin-sdk rules';

/** Stable short hash of the rules body — the drift/idempotency key. Both the
 * writer (sync-rules) and the reader (hook drift check) hash the SAME thing
 * (the Prettier'd, numbered assembled markdown), so drift = "would sync-rules
 * produce different content?" — immune to commits that don't change content
 * AND to meaningless formatting differences (Prettier normalizes them out). */
export function contentHash(markdown: string): string {
  return createHash('sha256').update(markdown).digest('hex').slice(0, 12);
}

/**
 * Stable short hash of the RESOLVED module-name list — the second half of the
 * committed artifact's identity (epic home-base-dchjw D2/F3).
 *
 * The content hash alone cannot answer "would this repo get a different SET of
 * rules today?", because the rules-drift fast path short-circuits on the prompts
 * sha before any content is compared. A repo that gains `expo` after its
 * artifact was written resolves a LARGER module list from the SAME prompts
 * commit, so its sha is unchanged and only this fingerprint moves. Stamping it
 * is what makes that case report `stale` instead of a confident `in-sync`.
 *
 * Order matters and is index order, which is also the order the modules are
 * inlined in: a reordered index really does produce a different document.
 */
export function moduleFingerprint(names: readonly string[]): string {
  return createHash('sha256')
    .update(names.join('\n'))
    .digest('hex')
    .slice(0, 12);
}

/** Prettier is ON by default; JSDK_PRIME_PRETTIER=0/false/off/no disables it.
 * NOTE: this must be set consistently for the writer and the hook (it's part of
 * the hash); toggling it makes the next sync-rules re-stamp once. */
export function prettierEnabled(): boolean {
  const v = (process.env.JSDK_PRIME_PRETTIER ?? '').toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

/**
 * The outcome of a prettier pass.
 *
 * `failed` deliberately carries NO markdown: a caller cannot reach formatted
 * text without first narrowing, so it cannot accidentally treat "prettier blew
 * up" as "prettier had nothing to change" (the rule-5 conflation that made
 * home-base-t6a0.21.1 a P0 — the old bare `catch` returned the unformatted
 * input, indistinguishable from success). Each caller decides what a failure
 * means for it: a writer refuses to write, a reader reports cannot-check.
 *
 * `disabled` is distinct from `failed` on purpose — JSDK_PRIME_PRETTIER=0 is a
 * deliberate choice, not a defect.
 */
export type PrettierMarkdownResult =
  | {markdown: string; status: 'disabled' | 'formatted'}
  | {reason: string; status: 'failed'};

/** An ignore file with no rules in it. See `prettierMarkdown` for why. */
const IGNORE_NOTHING = '/dev/null';

/** One line naming what actually went wrong, stderr included — the whole point
 * of not swallowing the error. Kept local so this module stays import-free. */
function describeExecFailure(error: unknown): string {
  const e = error as {
    code?: unknown;
    signal?: unknown;
    status?: unknown;
    stderr?: unknown;
  };
  const bits: string[] = [];
  if (e?.status != null) bits.push(`exit ${String(e.status)}`);
  if (e?.signal != null) bits.push(`signal ${String(e.signal)}`);
  if (e?.code != null) bits.push(String(e.code));
  const stderr =
    typeof e?.stderr === 'string'
      ? e.stderr
      : e?.stderr != null
        ? String(e.stderr)
        : '';
  const trimmed = stderr.trim().split('\n').slice(0, 5).join(' / ');
  if (trimmed.length > 0) bits.push(trimmed);
  if (bits.length === 0) {
    bits.push(error instanceof Error ? error.message : String(error));
  }
  return bits.join(' — ');
}

/**
 * Format markdown with prettier, resolving that repo's OWN configuration.
 *
 * Content goes in on STDIN with `--stdin-filepath <the artifact's real path>`.
 * That flag is the whole fix for t6a0.21.1: prettier resolves `.prettierrc*` /
 * `package.json#prettier` / `.editorconfig` by walking up from the FILE'S OWN
 * path, so the previous implementation — write into a fresh `$TMPDIR` directory
 * and format there — ran the repo's BINARY with prettier's DEFAULT config. The
 * committed artifact then failed that repo's own `prettier --check .` (measured
 * on nature-sounds: `bracketSpacing: false` in its config vs. the default true,
 * inside a fenced json example), which is exactly the check the sweep gates on.
 * Prettier formats embedded code fences, so EVERY option a fence can exercise
 * is a divergence surface — this is not one option's problem.
 *
 * stdin (rather than formatting the real file in place) is what lets the WRITER
 * and the three READ-ONLY callers (rules-diff, rules-drift, the SessionStart
 * hook) share one code path and therefore produce byte-identical canonical
 * bytes. The readers must not write inside the repo, and any second mechanism
 * would be a second thing to keep byte-identical. It also works when the
 * artifact's directory does not exist yet (verified: prettier resolves config up
 * from a non-existent path just the same).
 *
 * `--ignore-path /dev/null` is load-bearing, not tidiness: prettier resolves
 * ignore files RELATIVE TO CWD (unlike config, which is file-relative), and a
 * stdin-filepath that lands under an ignore rule is passed through UNCHANGED
 * with exit 0 (measured). Since the writer, the CLI readers and the hook all run
 * with different cwds, honouring ignore files would mean the same artifact gets
 * formatted for one caller and not another — silent phantom drift. Neutralising
 * ignores makes the canonical bytes a function of the path alone. A repo that
 * ignores the artifact simply never checks it, so formatting it anyway is free.
 *
 * bunx (not `import prettier`) when no binary is given, ON PURPOSE: bunx
 * self-fetches prettier, so this works wherever the SDK runs from, including a
 * bunx cache with no node_modules of its own. `options.binary` runs THAT
 * prettier instead — the committed
 * per-repo artifact passes the target repo's own, because that artifact is
 * checked by the repo's `signal`/lint-staged and a newer bunx prettier
 * formatting it differently would turn every swept repo red. Same reasoning as
 * `writeJson` in setup-helpers (Justin's 2026-08-08 ruling: always format what
 * we write with the repo's own prettier). Resolution of the binary lives
 * OUTSIDE this module, in `local-fs.findLocalPrettier`, so this file stays free
 * of setup-helpers and its console output — a stray print here would corrupt
 * the session-start JSON envelope.
 *
 * Run BEFORE hashing, so trivial formatting normalizes out of the hash.
 */
export function prettierMarkdown(
  markdown: string,
  options?: {binary?: string | null; filePath?: string | null},
): PrettierMarkdownResult {
  if (!prettierEnabled()) {
    return {markdown: markdown.trimEnd(), status: 'disabled'};
  }
  // No filePath = the USER-LEVEL rules file, which is not in any repo. A path
  // under $TMPDIR keeps that caller's config resolution (and therefore its
  // content hash) exactly what it has always been. Nothing is written there —
  // the path only needs to name a .md file for parser + config resolution.
  const filePath =
    options?.filePath ?? join(tmpdir(), 'jsdk-prettier-rules.md');
  const given = options?.binary;
  const binary = given != null && given.length > 0 ? given : null;
  const label = binary ?? 'bunx prettier';
  const args = ['--ignore-path', IGNORE_NOTHING, '--stdin-filepath', filePath];
  const spawn: Parameters<typeof execFileSync>[2] & {encoding: 'utf-8'} = {
    encoding: 'utf-8',
    input: markdown,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 60_000,
  };

  let out: string;
  try {
    out =
      binary != null
        ? execFileSync(binary, args, spawn)
        : execFileSync('bunx', ['prettier', ...args], spawn);
  } catch (error) {
    return {
      reason: `${label} failed formatting ${filePath}: ${describeExecFailure(error)}`,
      status: 'failed',
    };
  }
  // Exit 0 with nothing on stdout is a failure wearing success's clothes (a
  // killed child, a shim that swallows stdin). Never let it become "the rules
  // are empty".
  if (out.trim().length === 0 && markdown.trim().length > 0) {
    return {
      reason: `${label} exited 0 but produced EMPTY output for ${filePath} — refusing to treat that as formatted content`,
      status: 'failed',
    };
  }
  return {markdown: out.trimEnd(), status: 'formatted'};
}

/**
 * Universal invocations — the spelling for commands that must run from ANY
 * project, INCLUDING ones that have never heard of the SDK. This is the D1(c)
 * BOOTSTRAP form, and these three commands are the reason it still exists:
 * `sync-rules` and `prime --full` write user-level files and are routinely run
 * from a directory with no pin to resolve.
 */
// Imported from sdk-invocation rather than spelled out here. It WAS spelled
// out, because this file shipped inside the plugin's self-contained file set
// and could import node builtins only; dchjw.8 retired that constraint, so the
// one place D1 names the bootstrap form is now also the only place it appears.
export const SDK_BUNX = SDK_BOOTSTRAP;
export const SYNC_RULES_CMD = `${SDK_BUNX} sync-rules`;
export const PRIME_FULL_CMD = `${SDK_BUNX} prime --full`;

/**
 * The LOCAL spelling, for commands whose only audience is someone sitting in a
 * repo that is already ENROLLED (home-base-r47v F4) — now `bun run justin-sdk`
 * (D1(b)) rather than a scoped bunx.
 *
 * Enrollment is what makes this correct by construction: an enrolled repo has
 * the SDK as a devDep at a pin new enough to carry these commands, and
 * `bun run` resolves that local copy from `node_modules/.bin` with no network.
 *
 * The `github:` spelling is actively WRONG here, which is why the two spellings
 * are separate constants rather than one: bunx caches a github spec under a hash
 * of the SPEC STRING, not the commit it resolved to, so an untagged
 * `github:…/justin-sdk rules-diff` can silently serve whatever commit it first
 * fetched (j2n7). Serving a stale binary is the single worst property a command
 * whose entire job is answering "are my rules current?" could have. The scoped
 * `bunx @justinhaaheim/justin-sdk` this used to be was wrong for a second
 * reason: unresolvable locally, it falls through to the npm registry, where the
 * scope is not demonstrably Justin's (home-base-2qhw).
 */
export const SDK_BUNX_LOCAL = 'bun run justin-sdk';
/** The pull channel for the COMMITTED per-repo artifact (t6a0.21 D4). Lands in
 * home-base-q1hp — stamped into artifacts now so the file names its own
 * regeneration command from day one. */
export const RULES_UPDATE_CMD = `${SDK_BUNX_LOCAL} rules-update`;
/** "What am I missing?" — the read half of the same channel (home-base-q1hp).
 * Lives here, next to its sibling, so the session notice and the doctor check
 * cannot name it two different ways (home-base-si46). */
export const RULES_DIFF_CMD = `${SDK_BUNX_LOCAL} rules-diff`;

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
  /** Source commit sha (12 hex), possibly suffixed '-dirty', or 'unknown'. */
  commit: string;
  contentHash: string | null;
  /**
   * `moduleFingerprint` of the module list the file was assembled from. null for
   * the user-level file, which does not carry one, and for any artifact written
   * before dchjw.3 — both of which must read as "not stated", never as a match.
   */
  moduleFingerprint: string | null;
  /** Committer date of the prompts commit (YYYY-MM-DD), when stated. */
  promptsDate: string | null;
  version: string;
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
    // `commit <sha>` is the user-level file's spelling; `prompts <sha> (<date>)`
    // is the committed artifact's (dchjw.3). ONE parser for both, so "which sha
    // was this generated from" cannot mean two different things.
    commit: /· (?:commit|prompts) (\S+)/.exec(firstLine)?.[1] ?? 'unknown',
    contentHash: /content ([0-9a-f]+)/.exec(firstLine)?.[1] ?? null,
    moduleFingerprint: /modules ([0-9a-f]+)/.exec(firstLine)?.[1] ?? null,
    promptsDate:
      /· prompts \S+ \((\d{4}-\d{2}-\d{2})\)/.exec(firstLine)?.[1] ?? null,
    version: /· v(\S+)/.exec(firstLine)?.[1] ?? 'unknown',
  };
}

/**
 * Build the stamp line for the USER-LEVEL rules file (`sync-rules`).
 *
 * `version` is OPTIONAL. The committed per-repo artifact does not use this
 * builder at all — see `buildArtifactStamp`.
 */
export function buildStamp(opts: {
  // ISO timestamp or YYYY-MM-DD date
  command?: string;
  commit: string; // sha, sha-dirty, or 'unknown'
  contentHash: string;
  generated: string;
  version?: string;
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

/**
 * Build the stamp line for the COMMITTED per-repo artifact (epic
 * home-base-dchjw D2, constraints F3 + F6).
 *
 *   <!-- justin-sdk rules · prompts <sha12> (<date>) · modules <fp12> · content <hash12> · GENERATED — run: bun run justin-sdk rules-update -->
 *
 * EVERY FIELD IS LOAD-BEARING, and so is the one that is absent:
 *
 *  - NO SDK VERSION (F6). Stamping one would make every SDK release change the
 *    bytes of a committed file in twelve repos — the exact coupling
 *    `sweep --component` exists to break — and, worse, the writer skips the
 *    rewrite when the content is unchanged, so the stamped version would go
 *    stale and LIE about which SDK produced the file.
 *  - NO GENERATION TIMESTAMP. A date that moves on every run makes two
 *    same-source regenerations differ byte for byte, which is noise in twelve
 *    repos' diffs. The prompts COMMIT date is the meaningful date and it moves
 *    only when the source does.
 *  - `prompts <sha>` may carry a `-dirty` suffix, exactly as the user-level
 *    stamp does: content generated from an uncommitted prompts tree is not
 *    reproducible from that sha, so the sha must not be allowed to certify it.
 *  - `modules <fp>` is what catches a repo whose RESOLVED module set changed
 *    without the prompts sha moving (F3) — a repo that gained `expo`.
 *  - `content <hash>` is what catches a hand edit that kept the header: the
 *    drift check's cheap fast path compares the header alone, so without this
 *    field an edited artifact would be certified in sync by its own stamp.
 */
export function buildArtifactStamp(opts: {
  command?: string;
  contentHash: string;
  moduleFingerprint: string;
  /** Prompts commit date (YYYY-MM-DD), or 'unknown' — never a fabricated one. */
  promptsDate: string;
  /** 12-char prompts sha, optionally '-dirty'-suffixed, or 'unknown'. */
  promptsSha: string;
}): string {
  return (
    `${STAMP_PREFIX} · prompts ${opts.promptsSha} (${opts.promptsDate})` +
    ` · modules ${opts.moduleFingerprint} · content ${opts.contentHash}` +
    ` · GENERATED — run: ${opts.command ?? RULES_UPDATE_CMD} -->`
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

/**
 * One trailing newline, no trailing blank lines: the writer's own shape
 * (`${stamp}\n\n${pretty}\n`), so neither side can differ by whitespace alone.
 */
export function normalizeArtifactText(text: string): string {
  return `${text.trimEnd()}\n`;
}

/**
 * Strip the generated stamp from an artifact's bytes.
 *
 * Only a FIRST line that really is a stamp is removed; anything else is returned
 * as-is, so a file that was replaced by hand with un-stamped content diffs in
 * full rather than losing its first line.
 *
 * Lives here rather than in `rules-diff` (its original home) because the
 * staleness checker the SessionStart hook calls needs it, and the hook can only
 * import from this directory (home-base-qjyj). `rules-diff` imports it from here.
 */
export function artifactBody(fileContents: string): string {
  const lines = fileContents.split('\n');
  if (!(lines[0] ?? '').startsWith(STAMP_PREFIX)) {
    return normalizeArtifactText(fileContents);
  }
  let i = 1;
  while ((lines[i] ?? '').trim() === '') i += 1;
  return normalizeArtifactText(lines.slice(i).join('\n'));
}
