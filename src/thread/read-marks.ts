/**
 * Justin's own read / unread marks on a session (home-base-yukaf.9, epic
 * home-base-yukaf D-READ-STATE): `<threadsStateDir>/read-marks.jsonl`.
 *
 * Separate from Claude Code's and cmux's read state on purpose (Justin,
 * 2026-10-17: "marked read as in within the threads tooling itself"). Local
 * state, not session beads (ask home-base-aasbl.15, default a). Append-only:
 * every `thread read` / `thread unread` adds one line, and the newest line for
 * a session decides.
 *
 * UNREAD (`unreadFrom`) means work happened since he last looked: the
 * session's last ASSISTANT line in its message log is newer than what his
 * newest read mark saw — not `lastActivityAt`, which his own prompt bumps.
 * A session he has never marked is unread; one whose newest mark is `unread`
 * is unread whatever the times say. When the marks file cannot be read, or the
 * session has no assistant line to compare, the answer is null, never false
 * (rule 7).
 *
 *   thread read <sessionId> [--seen <iso>]   mark read (default --seen: the
 *                                            log's last assistant line now)
 *   thread unread <sessionId>                mark unread
 */

import type {EnvLike} from './paths';

import {appendFileSync, mkdirSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {z} from 'zod';

import {parseInstant} from './answer-store';
import {messageLogPath} from './archive';
import {isSafeSessionId, readLastAssistantLine} from './message-log';
import {threadsStateDir} from './paths';

export const READ_MARKS_FILE = 'read-marks.jsonl';

/** What an unread session's heading starts with, in `thread inbox` and the threads TUI. */
export const UNREAD_MARKER = '●';

export function readMarksPath(env: EnvLike = process.env): string {
  return join(threadsStateDir(env), READ_MARKS_FILE);
}

const markSchema = z.object({
  at: z.string(),
  mark: z.enum(['read', 'unread']),
  /** The session's last assistant line `at` when he marked it; null = none yet. */
  seenAssistantAt: z.string().nullable(),
  sessionId: z.string(),
});

export type ReadMark = z.infer<typeof markSchema>;

/** Each session's marks in file order (oldest first), or why they could not be read. */
export type ReadMarksRead =
  | {bySessionId: Map<string, ReadMark[]>; kind: 'read'}
  | {kind: 'failed'; reason: string};

/**
 * No file is a measured "no marks yet". A line that does not parse — other
 * than a partial LAST line, an append in flight — fails the whole read: it
 * could be any session's newest mark.
 */
export function readReadMarks(env: EnvLike = process.env): ReadMarksRead {
  const path = readMarksPath(env);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {bySessionId: new Map(), kind: 'read'};
    }
    return {
      kind: 'failed',
      reason: `${path} could not be read: ${String(error)}`,
    };
  }
  const raw = text.split('\n');
  const endsClean = text.endsWith('\n') || text === '';
  const bySessionId = new Map<string, ReadMark[]>();
  for (const [index, line] of raw.entries()) {
    if (line.trim() === '') continue;
    let json: unknown;
    try {
      json = JSON.parse(line) as unknown;
    } catch {
      json = undefined;
    }
    const parsed = markSchema.safeParse(json);
    if (!parsed.success) {
      if (!endsClean && index === raw.length - 1) continue;
      return {
        kind: 'failed',
        reason: `${path} line ${index + 1} is not a read mark, so no session's read state is known until it is repaired`,
      };
    }
    const list = bySessionId.get(parsed.data.sessionId) ?? [];
    list.push(parsed.data);
    bySessionId.set(parsed.data.sessionId, list);
  }
  return {bySessionId, kind: 'read'};
}

export function appendReadMark(
  mark: ReadMark,
  env: EnvLike = process.env,
): {error: string; kind: 'failed'} | {kind: 'ok'} {
  const path = readMarksPath(env);
  try {
    mkdirSync(dirname(path), {recursive: true});
    appendFileSync(path, `${JSON.stringify(mark)}\n`);
    return {kind: 'ok'};
  } catch (error) {
    return {error: `${path}: ${String(error)}`, kind: 'failed'};
  }
}

/**
 * D-READ-STATE's rule for one session. `marks` is that session's marks in file
 * order; `lastAssistantAt` its newest assistant line's `at`.
 */
export function unreadFrom(
  marks: readonly ReadMark[],
  lastAssistantAt: string | null,
): boolean | null {
  if (lastAssistantAt == null) return null;
  const activity = parseInstant(lastAssistantAt);
  if (activity == null) return null;
  const newest = marks.at(-1);
  if (newest == null) return true;
  if (newest.mark === 'unread') return true;
  if (newest.seenAssistantAt == null) return true;
  const seen = parseInstant(newest.seenAssistantAt);
  if (seen == null) return null;
  return activity > seen;
}

/** The inbox's per-session answer: null whenever the marks could not be read. */
export function unreadFor(
  marks: ReadMarksRead,
  sessionId: string,
  lastAssistantAt: string | null,
): boolean | null {
  if (marks.kind === 'failed') return null;
  return unreadFrom(marks.bySessionId.get(sessionId) ?? [], lastAssistantAt);
}

export interface ReadMarkOptions {
  env?: EnvLike;
  mark: ReadMark['mark'];
  now?: Date;
  /** `--seen`: what the reader saw (the TUI passes its row's value). */
  seen: string | null;
  sessionId: string | null;
}

export type ReadMarkOutcome =
  | {kind: 'failed'; reason: string}
  | {kind: 'marked'; mark: ReadMark}
  | {kind: 'usage'; message: string};

export function markRead(options: ReadMarkOptions): ReadMarkOutcome {
  const env = options.env ?? process.env;
  const command = options.mark === 'read' ? 'thread read' : 'thread unread';
  const sessionId = options.sessionId?.trim() ?? '';
  if (sessionId === '' || !isSafeSessionId(sessionId)) {
    return {
      kind: 'usage',
      message: `name the session: ${command} <claude session id>`,
    };
  }
  let seen: string | null;
  if (options.seen != null) {
    if (parseInstant(options.seen) == null) {
      return {
        kind: 'usage',
        message: `--seen ${JSON.stringify(options.seen)} is not an ISO time`,
      };
    }
    seen = options.seen;
  } else {
    const last = readLastAssistantLine(messageLogPath(sessionId, env));
    if (last.kind === 'failed') {
      return {
        kind: 'failed',
        reason: `nothing was marked — the session's message log could not be read, so what you have seen is unknown: ${last.path}: ${last.error}`,
      };
    }
    seen = last.kind === 'found' ? last.line.at : null;
  }
  const mark: ReadMark = {
    at: (options.now ?? new Date()).toISOString(),
    mark: options.mark,
    seenAssistantAt: seen,
    sessionId,
  };
  const written = appendReadMark(mark, env);
  if (written.kind === 'failed') {
    return {kind: 'failed', reason: `nothing was marked: ${written.error}`};
  }
  return {kind: 'marked', mark};
}

/** One inbox row, as `thread read --all` needs it. */
export interface ReadAllRow {
  lastAssistantAt: string | null;
  sessionId: string;
  unread: boolean | null;
}

export interface ReadAllOutcome {
  /** Rows already read: nothing written. */
  alreadyRead: number;
  /** Why a write failed, one per failed session. */
  failures: string[];
  /** One read mark written per session that was unread. */
  marked: string[];
  /** Rows whose read state is unknown (no assistant line, or unreadable). */
  unknown: number;
}

/**
 * F7 (home-base-yukaf.14): mark every UNREAD row read, one record per
 * session, seen up to the assistant activity the inbox shows for it. A row
 * already read writes nothing; a row whose state is unknown (null) is
 * counted and skipped, never guessed.
 */
export function markAllRead(
  rows: readonly ReadAllRow[],
  options: {env?: EnvLike; now?: Date} = {},
): ReadAllOutcome {
  const env = options.env ?? process.env;
  const at = (options.now ?? new Date()).toISOString();
  const outcome: ReadAllOutcome = {
    alreadyRead: 0,
    failures: [],
    marked: [],
    unknown: 0,
  };
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.sessionId)) continue;
    seen.add(row.sessionId);
    if (row.unread === false) {
      outcome.alreadyRead += 1;
      continue;
    }
    if (row.unread == null || row.lastAssistantAt == null) {
      outcome.unknown += 1;
      continue;
    }
    const written = appendReadMark(
      {
        at,
        mark: 'read',
        seenAssistantAt: row.lastAssistantAt,
        sessionId: row.sessionId,
      },
      env,
    );
    if (written.kind === 'failed') {
      outcome.failures.push(`${row.sessionId}: ${written.error}`);
    } else {
      outcome.marked.push(row.sessionId);
    }
  }
  return outcome;
}

/** `thread read --all`: exit 0 every unread row marked · 1 a write or the inbox failed. */
export async function runReadAll(options: {
  cwd: string;
  env?: EnvLike;
  now?: Date;
}): Promise<number> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const {INBOX_DEFAULT_DAYS, readInbox} = await import('./session-inbox');
  const read = await readInbox({
    cwd: options.cwd,
    days: INBOX_DEFAULT_DAYS,
    env,
    now,
    repo: null,
  });
  if (read.kind === 'failed') {
    console.error(`thread read --all: nothing was marked: ${read.reason}`);
    return 1;
  }
  const outcome = markAllRead(read.read.rows, {env, now});
  console.log(
    `${outcome.marked.length} marked read, ${outcome.alreadyRead} already read, ${outcome.unknown} with no read state (no assistant line yet).`,
  );
  for (const failure of outcome.failures) {
    console.error(`thread read --all: not written: ${failure}`);
  }
  return outcome.failures.length > 0 ? 1 : 0;
}

export function runReadMark(options: ReadMarkOptions): number {
  const command = options.mark === 'read' ? 'thread read' : 'thread unread';
  const outcome = markRead(options);
  switch (outcome.kind) {
    case 'marked':
      console.log(
        `session ${outcome.mark.sessionId} marked ${outcome.mark.mark}${outcome.mark.seenAssistantAt == null ? '' : ` (seen up to ${outcome.mark.seenAssistantAt})`}`,
      );
      return 0;
    case 'usage':
      console.error(`${command}: ${outcome.message}`);
      return 2;
    case 'failed':
      console.error(`${command}: ${outcome.reason}`);
      return 1;
  }
}
