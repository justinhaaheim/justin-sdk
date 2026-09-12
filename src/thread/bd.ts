/**
 * The bd adapter — the ONLY place this SDK talks to ~/Dev/life's beads
 * (home-base-p1uj D2, D9).
 *
 * HOW bd IS REACHED. `bd` is a zsh alias for `bun run bd` inside ~/Dev/life; it
 * is not on a non-interactive PATH, so every call here is `bun run bd …` with
 * cwd set to the life workspace. The workspace is `JUSTIN_THREADS_LIFE_DIR`-
 * overridable, which is also how the "bd unreachable" path gets exercised for
 * real rather than mocked.
 *
 * NOTHING HERE THROWS PAST THE ADAPTER. Every function returns a Result, and
 * the failure side is a tagged union rather than a string, because the four
 * failures need four different responses:
 *
 *   sandbox-denied  the Claude Code sandbox refused Dolt's LOCK file. The fix
 *                   is an allowlist entry, and the caller says so — it never
 *                   tells anyone to re-run with the sandbox disabled.
 *   unreachable     bun, bd or the workspace is missing. Nothing to retry.
 *   locked          a concurrent writer. Retried with backoff, then reported.
 *   failed          bd ran and said no. Carries its exit code and stderr.
 *   bad-json        bd printed something we could not parse. NEVER treated as
 *                   an empty result: "no thread bead exists" and "I could not
 *                   read the answer" are opposite facts, and confusing them
 *                   would create a second thread bead for a session that
 *                   already had one, every time.
 *
 * MEASURED FACTS this file depends on (2026-09-12, bd 1.1.0):
 *   - `bd list` and `bd ready` default to a LIMIT. Always pass `--limit 0`.
 *   - `bd delete` wedges auto-export (the JSONL keeps records Dolt no longer
 *     has, and every later export refuses). This adapter therefore NEVER
 *     deletes. Asks are closed, threads are closed; nothing is removed.
 *   - `--metadata @file.json` MERGES into existing metadata on update — it does
 *     NOT replace, despite D9's wording. So every writer here sends the FULL
 *     key set on every write, with explicit nulls, which makes the merge
 *     behave as a replacement for our keys. Verified: nulls and `[]` both
 *     persist and overwrite.
 *   - `bd show <id> --json` returns an ARRAY of one issue; `metadata` is absent
 *     entirely when the issue has none.
 *   - `bd comments <id> --json` lists; `bd comments list <id>` is an error.
 */

import {spawnSync} from 'child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {lifeRepoDir} from './paths';

import type {EnvLike} from './paths';

export type BdFailure =
  | {kind: 'sandbox-denied'; command: string; detail: string}
  | {kind: 'unreachable'; command: string; detail: string}
  | {kind: 'locked'; command: string; detail: string}
  | {kind: 'failed'; command: string; exitCode: number | null; detail: string}
  | {kind: 'bad-json'; command: string; detail: string};

export type BdResult<T> =
  | {ok: true; value: T}
  | {ok: false; failure: BdFailure};

/**
 * How much of a failing command line the banner shows.
 *
 * A bd write carries the whole rendered report in `--notes`, so the untruncated
 * command is thousands of characters and buries the actual error under the very
 * report the reader just looked at.
 */
const COMMAND_DISPLAY_CAP = 160;

function shortCommand(command: string): string {
  const oneLine = command.replace(/\s+/g, ' ');
  return oneLine.length > COMMAND_DISPLAY_CAP
    ? `${oneLine.slice(0, COMMAND_DISPLAY_CAP)}…`
    : oneLine;
}

/** One line naming the failing command and why, for the NOT RECORDED banner. */
export function describeBdFailure(rawFailure: BdFailure): string {
  const failure = {...rawFailure, command: shortCommand(rawFailure.command)};
  switch (failure.kind) {
    case 'sandbox-denied':
      return `${failure.command} — the sandbox refused it (${failure.detail})`;
    case 'unreachable':
      return `${failure.command} — bd is unreachable (${failure.detail})`;
    case 'locked':
      return `${failure.command} — the beads database stayed locked (${failure.detail})`;
    case 'failed':
      return `${failure.command} — exit ${failure.exitCode ?? 'null'}: ${failure.detail}`;
    case 'bad-json':
      return `${failure.command} — unparseable output (${failure.detail})`;
  }
}

export interface BdIssue {
  close_reason?: string | null;
  id: string;
  issue_type?: string;
  metadata?: Record<string, unknown>;
  notes?: string | null;
  description?: string | null;
  parent?: string | null;
  priority?: number;
  status?: string;
  title?: string;
  updated_at?: string;
}

export interface BdComment {
  author?: string;
  created_at?: string;
  text?: string;
}

const MAX_LOCK_ATTEMPTS = 3;
const LOCK_BACKOFF_MS = [250, 750];

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * Does this stderr describe a LOCK we should retry? (F10, p1uj.6.)
 *
 * The old test was a bare `/lock/i`, which matched the substring in "blocked"
 * and "unlock" — so `Blocked by 3 open dependencies` earned three retries with
 * backoff and a banner naming a cause that was not the cause. Both of those
 * words are real bd output: `strings` over the shipped 1.1.0 binary (measured
 * 2026-09-12) finds `Blocked by %d open dependencies: %v`, ` blocked by %s: %s
 * [%s]`, `[blocked]  - Step is blocked by dependencies` and `depends on (is
 * blocked by) the specified issue.`
 *
 * The WORD BOUNDARY is what fixes it, and it is not a coincidence that it does:
 * `\block\b` cannot match inside "blocked" or "unlock", because in both the
 * letters are welded to another word character. Everything else here is
 * deliberately generous, because the real lock messages could NOT be provoked
 * live — six concurrent `bd create`s against an isolated $TMPDIR workspace all
 * exited 0 (the embedded backend serialises writers rather than failing them),
 * so the catalogue below comes from the binary rather than from a reproduction,
 * and may be incomplete:
 *
 *   embeddeddolt: another process holds the exclusive lock on %s; the embedded
 *                 backend supports only one writer at a time
 *   The Dolt database is locked.%s
 *   Stale lock files detected: %s. Lock files from crashed or killed bd
 *                 processes prevent new operations.
 *   timed out after %s opening beads storage. Another bd process or stale
 *                 storage lock may be blocking memory injection
 *
 * Under-matching here is the cheaper mistake: an unrecognised lock is reported
 * as `failed`, which still prints the real stderr, still spools the payload and
 * still exits non-zero — it only loses three retries.
 */
export function isLockedText(text: string): boolean {
  if (/\block(s|ed|ing|file|files)?\b/i.test(text)) return true;
  // EAGAIN from a non-blocking flock, which says nothing about locks at all.
  return /resource temporarily unavailable/i.test(text);
}

/**
 * Sandbox denial FIRST, before the lock test. The sandbox's own message is
 * `openat LOCK: operation not permitted`, which matches both patterns — and
 * retrying it three times with backoff would be pure latency for a failure that
 * can never clear on its own.
 */
function classify(
  command: string,
  exitCode: number | null,
  stderr: string,
  spawnError: Error | undefined,
): BdFailure {
  const text = `${stderr}${spawnError == null ? '' : ` ${spawnError.message}`}`;
  if (/operation not permitted|EPERM|permission denied/i.test(text)) {
    return {command, detail: text.trim().slice(0, 400), kind: 'sandbox-denied'};
  }
  // `Script not found "bd"` is what bun says when the workspace has no `bd`
  // script — i.e. when JUSTIN_THREADS_LIFE_DIR points somewhere that is not the
  // beads workspace. Measured 2026-09-12 while exercising the unreachable path.
  if (
    spawnError != null ||
    /ENOENT|command not found|no such file|script not found/i.test(text)
  ) {
    return {
      command,
      detail: (spawnError?.message ?? text).trim().slice(0, 400),
      kind: 'unreachable',
    };
  }
  if (isLockedText(text)) {
    return {command, detail: text.trim().slice(0, 400), kind: 'locked'};
  }
  return {command, detail: text.trim().slice(0, 400), exitCode, kind: 'failed'};
}

/**
 * Did this bd run WRITE, and then fail only while exporting? (home-base-p1uj.10)
 *
 * MEASURED 2026-09-12, in the Claude Code sandbox with ~/Dev/life/.beads
 * allowlisted and ~/Dev/life/.git not. `bd create … --silent`:
 *
 *   exit 1
 *   stdout: jl-rg5a.1
 *   stderr: beads: auto-export warning: no Dolt remote configured.
 *           …
 *           Error: auto-export: git add failed: exit status 128: fatal: Unable
 *           to create '/Users/jhaa/Dev/life/.git/index.lock': Operation not
 *           permitted
 *
 * The bead EXISTS. Auto-export runs after the mutation has committed to Dolt,
 * so an auto-export error is by construction a post-write failure — and calling
 * it "the write failed" was manufacturing the opposite of the truth: `thread
 * report` printed NOT RECORDED, spooled the payload, exited 1, and left a real
 * thread bead behind, so the next `board` drain re-applied the report and
 * doubled its asks.
 *
 * CONSERVATIVE ON PURPOSE. Both halves are required: an auto-export mention AND
 * a git-staging failure. Anything else — including a bare EPERM, which is what
 * a genuinely refused Dolt LOCK looks like — keeps the old loud path. Under-
 * matching costs a spurious spool that drains cleanly; over-matching would
 * report a write that never happened as recorded.
 */
export function isExportOnlyFailure(stderr: string): boolean {
  if (!/auto-export/i.test(stderr)) return false;
  return /git add failed|index\.lock|git-add failed/i.test(stderr);
}

export interface BdContext {
  env: EnvLike;
  /**
   * Set when a write landed in Dolt but its JSONL export was not git-staged.
   * A WARNING for the command to print, never a failure — and never silence:
   * the repo is left in a state someone has to notice (D13).
   */
  exportUnstaged: boolean;
  lifeDir: string;
}

export function bdContext(env: EnvLike = process.env): BdContext {
  return {env, exportUnstaged: false, lifeDir: lifeRepoDir(env)};
}

/** The one line every command prints when `ctx.exportUnstaged` is set. */
export const EXPORT_UNSTAGED_WARNING =
  '⚠️ WARNING: recorded in Dolt, but .beads/issues.jsonl could not be git-staged (the sandbox denies ~/Dev/life/.git). Nothing was lost; `justin-sdk thread board` reminds you what is uncommitted.';

/**
 * Run one bd command, retrying only a `locked` failure.
 *
 * stdout is returned even on success paths that print nothing; stderr is
 * captured rather than inherited so a lock warning never lands in the middle of
 * the rendered report on the user's terminal.
 */
async function runBd(
  ctx: BdContext,
  args: string[],
): Promise<BdResult<string>> {
  const command = `bd ${args.join(' ')}`;
  let last: BdFailure | null = null;
  for (let attempt = 0; attempt < MAX_LOCK_ATTEMPTS; attempt += 1) {
    const result = spawnSync('bun', ['run', 'bd', ...args], {
      cwd: ctx.lifeDir,
      encoding: 'utf8',
      env: ctx.env as NodeJS.ProcessEnv,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error == null && result.status === 0) {
      return {ok: true, value: result.stdout ?? ''};
    }
    // The write LANDED and only its export failed (home-base-p1uj.10). Reported
    // as success carrying a warning, because that is what happened — the
    // alternative wrote a duplicate on the next drain.
    if (result.error == null && isExportOnlyFailure(result.stderr ?? '')) {
      ctx.exportUnstaged = true;
      return {ok: true, value: result.stdout ?? ''};
    }
    last = classify(
      command,
      result.status,
      result.stderr ?? '',
      result.error ?? undefined,
    );
    if (last.kind !== 'locked') return {failure: last, ok: false};
    const backoff = LOCK_BACKOFF_MS[attempt];
    if (backoff != null) await sleep(backoff);
  }
  return {
    failure: last ?? {
      command,
      detail: 'no attempt produced a result',
      kind: 'unreachable',
    },
    ok: false,
  };
}

function parseJson<T>(command: string, text: string): BdResult<T> {
  const trimmed = text.trim();
  if (trimmed === '') {
    return {
      failure: {command, detail: 'bd printed nothing', kind: 'bad-json'},
      ok: false,
    };
  }
  try {
    return {ok: true, value: JSON.parse(trimmed) as T};
  } catch (error) {
    return {
      failure: {
        command,
        detail: error instanceof Error ? error.message : String(error),
        kind: 'bad-json',
      },
      ok: false,
    };
  }
}

/**
 * Write a metadata document somewhere bd can read it.
 *
 * `$TMPDIR` on purpose: it is the one directory the Claude Code sandbox always
 * allows writes to, so passing metadata through a file does not add a second
 * path that has to be allowlisted.
 */
function withMetadataFile<T>(
  metadata: Record<string, unknown>,
  body: (path: string) => T,
): T {
  const dir = mkdtempSync(join(tmpdir(), 'justin-thread-'));
  try {
    const path = join(dir, 'metadata.json');
    writeFileSync(path, JSON.stringify(metadata));
    return body(path);
  } finally {
    rmSync(dir, {force: true, recursive: true});
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Is bd usable at all? A cheap read that touches the database. */
export async function checkBdReachable(
  ctx: BdContext,
): Promise<BdResult<true>> {
  const result = await runBd(ctx, ['types']);
  if (!result.ok) return result;
  return {ok: true, value: true};
}

export interface TypeCheck {
  missing: string[];
  registered: string[];
}

/**
 * Are the custom `thread` and `ask` types registered here?
 *
 * They live in bd's Dolt config store, which `.beads/.gitignore` excludes, so a
 * fresh clone or a second machine has NONE of them and `bd create -t thread`
 * fails with a cryptic "invalid issue type". Checking up front lets `prepare`
 * hand over the exact command that fixes it.
 */
export async function checkThreadTypes(
  ctx: BdContext,
): Promise<BdResult<TypeCheck>> {
  const result = await runBd(ctx, ['types']);
  if (!result.ok) return result;
  const text = result.value;
  const registered: string[] = [];
  const missing: string[] = [];
  for (const type of ['thread', 'ask']) {
    if (new RegExp(`\\b${type}\\b`).test(text)) registered.push(type);
    else missing.push(type);
  }
  return {ok: true, value: {missing, registered}};
}

/** The fix `prepare` prints when a type is missing. */
export const REGISTER_TYPES_COMMAND =
  'cd ~/Dev/life && bun run bd config set types.custom docs,question,source-email,source-message,thread,ask';

/**
 * The thread bead for one session, or null when there genuinely is none.
 *
 * Null here is a MEASURED absence — every failure path returns a failure, so a
 * caller can safely read null as "create one". More than one match is itself a
 * failure: D1 says one bead per session, and silently picking the first would
 * hide a duplicate forever.
 */
export async function findThreadBySession(
  ctx: BdContext,
  sessionId: string,
): Promise<BdResult<BdIssue | null>> {
  const args = [
    'list',
    '-t',
    'thread',
    '--metadata-field',
    `sessionId=${sessionId}`,
    '--limit',
    '0',
    '--all',
    '--json',
  ];
  const raw = await runBd(ctx, args);
  if (!raw.ok) return raw;
  const parsed = parseJson<BdIssue[]>(`bd ${args.join(' ')}`, raw.value);
  if (!parsed.ok) return parsed;
  const issues = Array.isArray(parsed.value) ? parsed.value : [];
  const open = issues.filter((issue) => issue.status !== 'closed');
  const chosen = open[0] ?? issues[0] ?? null;
  if (open.length > 1) {
    return {
      failure: {
        command: `bd ${args.join(' ')}`,
        detail: `${open.length} open thread beads carry sessionId=${sessionId} (${open
          .map((issue) => issue.id)
          .join(', ')}); D1 says there must be exactly one`,
        exitCode: 0,
        kind: 'failed',
      },
      ok: false,
    };
  }
  return {ok: true, value: chosen};
}

/** Full record for one bead, or a failure. Never null-for-failure. */
export async function showIssue(
  ctx: BdContext,
  id: string,
): Promise<BdResult<BdIssue | null>> {
  const args = ['show', id, '--json'];
  const raw = await runBd(ctx, args);
  if (!raw.ok) return raw;
  const parsed = parseJson<BdIssue[]>(`bd ${args.join(' ')}`, raw.value);
  if (!parsed.ok) return parsed;
  return {ok: true, value: parsed.value[0] ?? null};
}

/** The still-open ask beads under one thread. Empty means MEASURED empty. */
export async function listOpenAsks(
  ctx: BdContext,
  threadId: string,
): Promise<BdResult<BdIssue[]>> {
  const args = [
    'list',
    '--parent',
    threadId,
    '-t',
    'ask',
    '--limit',
    '0',
    '--json',
  ];
  const raw = await runBd(ctx, args);
  if (!raw.ok) return raw;
  const parsed = parseJson<BdIssue[]>(`bd ${args.join(' ')}`, raw.value);
  if (!parsed.ok) return parsed;
  const issues = Array.isArray(parsed.value) ? parsed.value : [];
  return {ok: true, value: issues.filter((issue) => issue.status !== 'closed')};
}

/**
 * EVERY thread bead, for the board (home-base-p1uj.2).
 *
 * ONE CALL, no per-row follow-up: the board's whole promise is that it is fast
 * enough to be the first thing run in the morning, and a per-thread `bd show`
 * would turn a 2-call render into a 2+N one. Everything a row needs already
 * lives in the listing's `metadata` (repo, branch, reportedAt, progressPercent,
 * stopReasonKind, mergeState — see metadata.ts).
 *
 * Closed threads are excluded unless asked for: a board is what is still live.
 */
export async function listThreads(
  ctx: BdContext,
  options: {includeClosed?: boolean} = {},
): Promise<BdResult<BdIssue[]>> {
  const args = ['list', '-t', 'thread', '--limit', '0', '--json'];
  if (options.includeClosed === true) args.push('--all');
  const raw = await runBd(ctx, args);
  if (!raw.ok) return raw;
  const parsed = parseJson<BdIssue[]>(`bd ${args.join(' ')}`, raw.value);
  if (!parsed.ok) return parsed;
  return {ok: true, value: Array.isArray(parsed.value) ? parsed.value : []};
}

/**
 * EVERY open ask, for the board's join.
 *
 * The board pairs these to threads CLIENT-SIDE on `parent`, which the listing
 * carries (measured 2026-09-12: `bd list -t ask --json` returns `parent`
 * alongside `metadata`). `metadata.threadId` is the fallback, because an ask
 * created outside `thread report` could have a parent and no metadata, or the
 * reverse, and dropping such a row would under-report what waits for Justin.
 */
export async function listAsks(
  ctx: BdContext,
  options: {includeClosed?: boolean} = {},
): Promise<BdResult<BdIssue[]>> {
  const args = ['list', '-t', 'ask', '--limit', '0', '--json'];
  if (options.includeClosed === true) args.push('--all');
  const raw = await runBd(ctx, args);
  if (!raw.ok) return raw;
  const parsed = parseJson<BdIssue[]>(`bd ${args.join(' ')}`, raw.value);
  if (!parsed.ok) return parsed;
  const issues = Array.isArray(parsed.value) ? parsed.value : [];
  return {
    ok: true,
    value:
      options.includeClosed === true
        ? issues
        : issues.filter((issue) => issue.status !== 'closed'),
  };
}

/** Justin's answers on one ask bead, oldest first (D3). */
export async function readComments(
  ctx: BdContext,
  id: string,
): Promise<BdResult<BdComment[]>> {
  const args = ['comments', id, '--json'];
  const raw = await runBd(ctx, args);
  if (!raw.ok) return raw;
  const trimmed = raw.value.trim();
  // ALWAYS PARSE (F3). This used to map any stdout not starting with `[` to an
  // EMPTY LIST, so a bd upgrade notice or a Dolt warning printed ahead of the
  // JSON became "he has not answered anything" — rule 6.2's "silence must be a
  // claim" broken in the reassuring direction, and the only read in this file
  // that did not route the condition to bad-json. Measured 2026-09-12: zero
  // comments prints exactly `[]`, so the prefix test protected against nothing
  // that happens while absorbing the case it was not written for. The one
  // exception kept is bd's literal "no comments" sentence, matched exactly.
  if (/^no comments\b/i.test(trimmed)) return {ok: true, value: []};
  const parsed = parseJson<BdComment[]>(`bd ${args.join(' ')}`, raw.value);
  if (!parsed.ok) return parsed;
  return {ok: true, value: Array.isArray(parsed.value) ? parsed.value : []};
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface ThreadBeadFields {
  description: string;
  metadata: Record<string, unknown>;
  notes: string;
  title: string;
}

/**
 * Create the session's thread bead. Returns its id.
 *
 * NO STATUS FLAG HERE, deliberately: `bd create` has no `-s`/`--status` at all
 * (measured 2026-09-12 — it fails with "unknown shorthand flag: 's'", which is
 * precisely how this was found). `in_progress` is set by the finalising write
 * that follows, which has to happen anyway to fold the ask ids into the notes.
 * Another instance of the standing bd warning: do not assume flag parity across
 * subcommands.
 */
export async function createThread(
  ctx: BdContext,
  fields: ThreadBeadFields,
): Promise<BdResult<string>> {
  const result = await withMetadataFile(fields.metadata, (metaPath) =>
    runBd(ctx, [
      'create',
      fields.title,
      '-t',
      'thread',
      '-p',
      '2',
      '-d',
      fields.description,
      '--notes',
      fields.notes,
      '--metadata',
      `@${metaPath}`,
      '--silent',
    ]),
  );
  if (!result.ok) return result;
  const id = result.value.trim().split('\n').pop()?.trim() ?? '';
  if (id === '') {
    return {
      failure: {
        command: 'bd create -t thread',
        detail: 'bd --silent printed no issue id',
        kind: 'bad-json',
      },
      ok: false,
    };
  }
  return {ok: true, value: id};
}

/**
 * Rewrite the thread bead in place (D1).
 *
 * Every field is sent every time, including the full metadata key set: update's
 * `--metadata` merges, so an omitted key would keep whatever the previous report
 * left there. Sending everything makes the merge a replacement.
 *
 * `-s in_progress` IS ENOUGH FOR A CLOSED THREAD — no `bd reopen` first (F8,
 * retired by measurement; see `reopenIssue` for the transcript). A session that
 * reports after `thread done` resurrects its bead cleanly: `closed_at` and
 * `close_reason` are both cleared by the status change. That resurrection is
 * intended, not a leak — the session is demonstrably still running, and a board
 * that hid it would be claiming less is in flight than there is.
 */
export async function updateThread(
  ctx: BdContext,
  id: string,
  fields: ThreadBeadFields,
): Promise<BdResult<true>> {
  const result = await withMetadataFile(fields.metadata, (metaPath) =>
    runBd(ctx, [
      'update',
      id,
      '--title',
      fields.title,
      '-d',
      fields.description,
      '--notes',
      fields.notes,
      '--metadata',
      `@${metaPath}`,
      '-s',
      'in_progress',
    ]),
  );
  if (!result.ok) return result;
  return {ok: true, value: true};
}

/**
 * The finalising write: the rendered report into `notes` (D10), the status into
 * `in_progress` (D1), and the metadata AGAIN — now carrying the ask bead ids,
 * which did not exist when the bead was first written.
 *
 * The metadata is rewritten rather than left alone because the first write
 * necessarily recorded `askIds: []`, and an empty list there would read as
 * "checked, and this report asked for nothing" — a measured zero standing in
 * for a value that simply was not known yet. Exactly the substitution rule 6
 * forbids, and it would be invisible: the report in `notes` shows the asks.
 */
export async function finalizeThread(
  ctx: BdContext,
  id: string,
  notes: string,
  metadata: Record<string, unknown>,
): Promise<BdResult<true>> {
  const result = await withMetadataFile(metadata, (metaPath) =>
    runBd(ctx, [
      'update',
      id,
      '--notes',
      notes,
      '--metadata',
      `@${metaPath}`,
      '-s',
      'in_progress',
    ]),
  );
  if (!result.ok) return result;
  return {ok: true, value: true};
}

/**
 * Move a thread bead to `in_progress` and nothing else (home-base-p1uj.3).
 *
 * `thread start` needs this because `bd create` has no status flag at all (see
 * createThread), so a freshly created bead lands as `open` and a second write is
 * unavoidable. It does NOT reuse `finalizeThread`: that one rewrites notes and
 * the whole metadata document, which at start time would mean sending the same
 * bytes twice for no reason, on the one code path that is paying a session's
 * startup latency. Each bd call costs ~1.3s wall clock (measured 2026-09-12),
 * so the smaller command is the point, not tidiness.
 */
export async function setThreadInProgress(
  ctx: BdContext,
  id: string,
): Promise<BdResult<true>> {
  const result = await runBd(ctx, ['update', id, '-s', 'in_progress']);
  if (!result.ok) return result;
  return {ok: true, value: true};
}

export interface AskBeadFields {
  blocking: boolean;
  description: string;
  metadata: Record<string, unknown>;
  title: string;
}

/** Create one ask bead as a child of the thread (D3). Returns its id. */
export async function createAsk(
  ctx: BdContext,
  threadId: string,
  fields: AskBeadFields,
): Promise<BdResult<string>> {
  const result = await withMetadataFile(fields.metadata, (metaPath) =>
    runBd(ctx, [
      'create',
      fields.title,
      '-t',
      'ask',
      '-p',
      fields.blocking ? '1' : '2',
      '--parent',
      threadId,
      '-d',
      fields.description,
      '--metadata',
      `@${metaPath}`,
      '--silent',
    ]),
  );
  if (!result.ok) return result;
  const id = result.value.trim().split('\n').pop()?.trim() ?? '';
  if (id === '') {
    return {
      failure: {
        command: 'bd create -t ask',
        detail: 'bd --silent printed no issue id',
        kind: 'bad-json',
      },
      ok: false,
    };
  }
  return {ok: true, value: id};
}

/**
 * Close one ask with its disposition as the reason (D4).
 *
 * Closing, never deleting: `bd delete` leaves records in the JSONL that Dolt no
 * longer has, and every subsequent auto-export refuses until someone runs a
 * manual `bd export`. A wedged export means later reports silently never reach
 * git, which is precisely the shape of failure this system exists to prevent.
 */
export async function closeAsk(
  ctx: BdContext,
  id: string,
  reason: string,
): Promise<BdResult<true>> {
  return closeIssue(ctx, id, reason);
}

/**
 * Close any bead — a thread (`thread done`) or an ask — with its reason.
 *
 * `closeAsk` is the D4 spelling of this and delegates here; they were one
 * command all along, and keeping two implementations would let the "never
 * delete" invariant drift apart between them.
 */
export async function closeIssue(
  ctx: BdContext,
  id: string,
  reason: string,
): Promise<BdResult<true>> {
  const result = await runBd(ctx, ['close', id, '--reason', reason]);
  if (!result.ok) return result;
  return {ok: true, value: true};
}

/**
 * Reopen a closed bead.
 *
 * `bd reopen <id> -r <reason>` reopens AS `open` and emits a Reopened event.
 *
 * IT IS NOT NEEDED TO CLEAR `closed_at`, and the earlier claim here that it was
 * has been retired (F8). MEASURED 2026-09-12 against real bd 1.1.0 in an
 * isolated `bd init` workspace under $TMPDIR, `bd show --json` after each step:
 *
 *   bd close p…-0x5 --reason "probe close"
 *     → status "closed",  closed_at "2026-09-12T14:26:48Z", close_reason set
 *   bd update p…-0x5 -s in_progress
 *     → status "in_progress", closed_at ABSENT, close_reason ABSENT,
 *       started_at "2026-09-12T14:26:53Z"
 *   bd reopen p…-a7l -r "probe reopen"   (a second, separately closed bead)
 *     → status "open", closed_at ABSENT
 *
 * So `bd update -s in_progress` already clears `closed_at`, and it lands on the
 * status D10 wants; `reopen` would need a second write to get there. That is
 * why `updateThread` reuses a closed thread with a plain status update rather
 * than reopening it first.
 */
export async function reopenIssue(
  ctx: BdContext,
  id: string,
  reason: string,
): Promise<BdResult<true>> {
  const result = await runBd(ctx, ['reopen', id, '-r', reason]);
  if (!result.ok) return result;
  return {ok: true, value: true};
}

/**
 * Add one comment to a bead — how Justin's answer is recorded (D3).
 *
 * D3 chose comments for answers on purpose, and the br "never use comments"
 * rule does not reach here: this is bd, where `bd comments <id>` is a real
 * surface that `thread prepare`, `thread show` and `thread inbox` all read.
 *
 * The text is passed as an ARGV entry, never through a shell, so newlines,
 * quotes and backticks in Justin's answer survive verbatim.
 */
export async function addComment(
  ctx: BdContext,
  id: string,
  text: string,
): Promise<BdResult<true>> {
  const result = await runBd(ctx, ['comments', 'add', id, text]);
  if (!result.ok) return result;
  return {ok: true, value: true};
}

/**
 * Merge a few keys into a bead's metadata, leaving the rest alone.
 *
 * THIS IS THE ONE PLACE THE MERGE SEMANTICS ARE WANTED. Everywhere else in this
 * file sends the full key set precisely because `--metadata @file` merges
 * instead of replacing (see the header). Here the merge IS the operation:
 * `thread answer` stamps `answeredAt` on an ask bead and must not disturb
 * `kind`, `blocking`, `defaultAction` or `threadId`, none of which it knows.
 */
export async function mergeMetadata(
  ctx: BdContext,
  id: string,
  metadata: Record<string, unknown>,
): Promise<BdResult<true>> {
  const result = await withMetadataFile(metadata, (metaPath) =>
    runBd(ctx, ['update', id, '--metadata', `@${metaPath}`]),
  );
  if (!result.ok) return result;
  return {ok: true, value: true};
}
