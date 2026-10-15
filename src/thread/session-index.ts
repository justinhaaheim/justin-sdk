/**
 * The sessions index (status report v4, epic home-base-vzwbj.4 D1 "INDEX";
 * built by home-base-vzwbj.4.1).
 *
 * `<stateDir>/sessions.jsonl`, append-only, ONE JSON line per sighting of a
 * session's beads in a checkout:
 *
 *   {at, event: 'created' | 'adopted-in', sessionId, beadId, repo,
 *    checkoutPath, beadsDir, branch}
 *
 * - `created`    — the capture child filed the session bead (beadId = it).
 * - `adopted-in` — `thread request --bead` labelled a bead (or `--here` filed
 *                  one) in a beads DB the index had not yet named for that
 *                  session (beadId = that bead).
 *
 * POINTERS ONLY, never content: it is how every reader learns WHICH beads DB
 * holds a session without scanning every repo, and it survives a deleted
 * worktree (the reader then knows the path it expected and can say so). The
 * session's state lives in the beads; nothing here is ever rewritten.
 *
 * A malformed line is REPORTED, never skipped silently (rule 7): the reader
 * returns it beside the sessions it could read.
 */

import type {EnvLike} from './paths';

import {appendFileSync, mkdirSync, readFileSync} from 'fs';
import {dirname} from 'path';

import {sessionIndexPath} from './archive';
import {probeErrorMessage} from './paths';

export type SessionSightingEvent = 'adopted-in' | 'created';

export interface SessionSighting {
  /** ISO-8601 UTC, when this sighting was recorded. */
  at: string;
  /** The session bead (`created`) or the adopted/filed bead (`adopted-in`). */
  beadId: string;
  /** Absolute path of the `.beads/` directory holding that bead's database. */
  beadsDir: string;
  /** The checkout's branch, or null when git could not say (never ''). */
  branch: string | null;
  /** Absolute path of the checkout (the git toplevel) the beads live in. */
  checkoutPath: string;
  event: SessionSightingEvent;
  /** The repo's name (from git's common dir), or null when unknown. */
  repo: string | null;
  sessionId: string;
}

/** One session's sightings, NEWEST FIRST. */
export interface IndexedSession {
  /** The newest sighting's `at`. */
  newestAt: string;
  sessionId: string;
  sightings: SessionSighting[];
}

/** A line the reader could not use, kept so the caller can name it. */
export interface CorruptIndexLine {
  /** 1-based line number in the file. */
  lineNumber: number;
  reason: string;
  /** The line itself, cut to 200 characters. */
  text: string;
}

export type SessionIndexRead =
  | {
      corrupt: CorruptIndexLine[];
      kind: 'read';
      path: string;
      sessions: IndexedSession[];
    }
  | {error: string; kind: 'failed'; path: string}
  | {kind: 'missing'; path: string};

export type SightingAppendOutcome =
  | {error: string; kind: 'failed'; path: string}
  | {kind: 'appended'; path: string};

/** One line, keys in a fixed order so equal sightings serialise identically. */
export function serializeSighting(sighting: SessionSighting): string {
  return `${JSON.stringify({
    at: sighting.at,
    beadId: sighting.beadId,
    beadsDir: sighting.beadsDir,
    branch: sighting.branch,
    checkoutPath: sighting.checkoutPath,
    event: sighting.event,
    repo: sighting.repo,
    sessionId: sighting.sessionId,
  })}\n`;
}

/** Append one sighting. O_APPEND, one small write — no read, no rewrite. */
export function appendSessionSighting(
  sighting: SessionSighting,
  env: EnvLike = process.env,
): SightingAppendOutcome {
  const path = sessionIndexPath(env);
  try {
    mkdirSync(dirname(path), {recursive: true});
    appendFileSync(path, serializeSighting(sighting));
  } catch (error) {
    return {error: probeErrorMessage(error), kind: 'failed', path};
  }
  return {kind: 'appended', path};
}

function nonEmptyText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * One parsed sighting, or why the line is not one. `branch` and `repo` may be
 * null (git could not say); every other field is required.
 */
export function parseSighting(
  raw: string,
): {ok: false; reason: string} | {ok: true; sighting: SessionSighting} {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return {ok: false, reason: `not JSON: ${probeErrorMessage(error)}`};
  }
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return {ok: false, reason: 'not a JSON object'};
  }
  const record = value as Record<string, unknown>;
  const event = record.event;
  if (event !== 'created' && event !== 'adopted-in') {
    return {
      ok: false,
      reason: `event ${JSON.stringify(event ?? null)} is not created or adopted-in`,
    };
  }
  const at = nonEmptyText(record.at);
  const beadId = nonEmptyText(record.beadId);
  const beadsDir = nonEmptyText(record.beadsDir);
  const checkoutPath = nonEmptyText(record.checkoutPath);
  const sessionId = nonEmptyText(record.sessionId);
  const missing = Object.entries({
    at,
    beadId,
    beadsDir,
    checkoutPath,
    sessionId,
  })
    .filter(([, field]) => field == null)
    .map(([name]) => name);
  if (
    missing.length > 0 ||
    at == null ||
    beadId == null ||
    beadsDir == null ||
    checkoutPath == null ||
    sessionId == null
  ) {
    return {ok: false, reason: `missing ${missing.join(', ')}`};
  }
  return {
    ok: true,
    sighting: {
      at,
      beadId,
      beadsDir,
      branch: nonEmptyText(record.branch),
      checkoutPath,
      event,
      repo: nonEmptyText(record.repo),
      sessionId,
    },
  };
}

function errorCode(error: unknown): string | null {
  return error != null && typeof error === 'object' && 'code' in error
    ? String((error as {code: unknown}).code)
    : null;
}

/** Newest first; ISO-8601 UTC strings sort lexicographically. */
function byNewest(a: SessionSighting, b: SessionSighting): number {
  if (a.at === b.at) return 0;
  return a.at < b.at ? 1 : -1;
}

/**
 * The whole index, grouped by session id, every group's sightings newest
 * first and the groups ordered by their newest sighting, newest first.
 *
 * `missing` (no file — nothing has ever been recorded) is a measured answer;
 * `failed` is not, and no caller may read it as "no sessions".
 */
export function readSessionIndex(env: EnvLike = process.env): SessionIndexRead {
  const path = sessionIndexPath(env);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return {kind: 'missing', path};
    return {error: probeErrorMessage(error), kind: 'failed', path};
  }
  const groups = new Map<string, SessionSighting[]>();
  const corrupt: CorruptIndexLine[] = [];
  text.split('\n').forEach((raw, index) => {
    if (raw.trim() === '') return;
    const parsed = parseSighting(raw);
    if (!parsed.ok) {
      corrupt.push({
        lineNumber: index + 1,
        reason: parsed.reason,
        text: raw.slice(0, 200),
      });
      return;
    }
    const list = groups.get(parsed.sighting.sessionId) ?? [];
    list.push(parsed.sighting);
    groups.set(parsed.sighting.sessionId, list);
  });
  const sessions: IndexedSession[] = [...groups.entries()].map(
    ([sessionId, sightings]) => {
      const sorted = [...sightings].sort(byNewest);
      return {newestAt: sorted[0]?.at ?? '', sessionId, sightings: sorted};
    },
  );
  sessions.sort((a, b) =>
    a.newestAt === b.newestAt ? 0 : a.newestAt < b.newestAt ? 1 : -1,
  );
  return {corrupt, kind: 'read', path, sessions};
}

export type SessionSightingsRead =
  | {
      corrupt: CorruptIndexLine[];
      kind: 'read';
      path: string;
      sightings: SessionSighting[];
    }
  | {error: string; kind: 'failed'; path: string}
  | {kind: 'missing'; path: string};

/**
 * ONE session's sightings, newest first — the fast path the prompt hook and
 * the request command use.
 *
 * Only lines that contain the session id as text are parsed, so the cost is a
 * file read plus a substring scan however long the index grows. A corrupt
 * line is reported when it mentions the session id (one that does not cannot
 * be attributed to this session, and `readSessionIndex` reports it).
 */
export function readSessionSightings(
  sessionId: string,
  env: EnvLike = process.env,
): SessionSightingsRead {
  const path = sessionIndexPath(env);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return {kind: 'missing', path};
    return {error: probeErrorMessage(error), kind: 'failed', path};
  }
  const sightings: SessionSighting[] = [];
  const corrupt: CorruptIndexLine[] = [];
  if (!text.includes(sessionId)) {
    return {corrupt, kind: 'read', path, sightings};
  }
  text.split('\n').forEach((raw, index) => {
    if (!raw.includes(sessionId)) return;
    const parsed = parseSighting(raw);
    if (!parsed.ok) {
      corrupt.push({
        lineNumber: index + 1,
        reason: parsed.reason,
        text: raw.slice(0, 200),
      });
      return;
    }
    if (parsed.sighting.sessionId === sessionId) {
      sightings.push(parsed.sighting);
    }
  });
  sightings.sort(byNewest);
  return {corrupt, kind: 'read', path, sightings};
}

/**
 * The corrupt index lines that mention this session, named for a reader
 * (home-base-vzwbj.4.9 R9), or null when there are none. A half-written
 * `created` line otherwise reads as "not filed yet" or "no session": every
 * reader of one session's sightings says this beside its answer.
 */
export function corruptSightingsNote(
  read: SessionSightingsRead,
): string | null {
  if (read.kind !== 'read' || read.corrupt.length === 0) return null;
  const where = read.corrupt
    .map((line) => `${read.path}:${line.lineNumber} (${line.reason})`)
    .join(', ');
  return `sessions index has a corrupt line for this session: ${where}`;
}

/** The sighting that records the session bead itself: the newest `created`. */
export function sessionBeadSighting(
  sightings: readonly SessionSighting[],
): SessionSighting | null {
  return sightings.find((sighting) => sighting.event === 'created') ?? null;
}
