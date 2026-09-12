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
  {ok: true; value: T} | {ok: false; failure: BdFailure};

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
  if (/lock|database is locked|resource temporarily unavailable/i.test(text)) {
    return {command, detail: text.trim().slice(0, 400), kind: 'locked'};
  }
  return {command, detail: text.trim().slice(0, 400), exitCode, kind: 'failed'};
}

export interface BdContext {
  env: EnvLike;
  lifeDir: string;
}

export function bdContext(env: EnvLike = process.env): BdContext {
  return {env, lifeDir: lifeRepoDir(env)};
}

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
  // A bead with no comments prints a human "no comments" line rather than [].
  if (trimmed === '' || !trimmed.startsWith('[')) return {ok: true, value: []};
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
 * `bd reopen <id> -r <reason>` exists and is NOT the same as `bd update -s
 * open`: it clears `closed_at` and emits a Reopened event (measured 2026-09-12
 * from `bd reopen --help`). Checked rather than assumed — flag and subcommand
 * parity across bd subcommands is not guaranteed, which is how dispatch 2 found
 * that `bd create` has no `-s` at all.
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
