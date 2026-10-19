/**
 * One small file per session that says where the threads tooling has it, for
 * the Claude Code status line to read (decision D-STATUSLINE, epic
 * home-base-yukaf; built by home-base-yukaf.6).
 *
 *   <threadsStateDir>/status/<sessionId>.json
 *     {at, section, statusWord, openRequests, closedRequests, openP0,
 *      archived, done}
 *
 * Written by the detached `thread capture --apply` child after every prompt
 * and every stop (session-status-file.ts builds it from the session model),
 * and rewritten by `thread done` / `thread archive` (session-marks.ts), so a
 * marked session shows its mark on the next render.
 *
 * THIS MODULE IS A LEAF ON PURPOSE: it imports only node's fs, os and path.
 * The status line imports it on every render (about every 30 s in every open
 * window), and paths.ts pulls in config.ts, health-notices and usage-check,
 * which a render must not pay for. paths.ts's `threadsStateDir` delegates to
 * `resolveThreadsStateDir` here, so the two can never name different dirs.
 *
 * RULE 7. Reading keeps three outcomes apart: `absent` (no file: an untracked
 * session, or one no capture has written yet), `unreadable` (the file exists
 * but cannot be read or does not have this shape) and `read`. Staleness is the
 * reader's call, from `at`.
 */

import {mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'fs';
import {homedir} from 'os';
import {join} from 'path';

/** The env var that moves the threads state dir (tests, sandboxed runs). */
export const THREADS_STATE_DIR_ENV_VAR = 'JUSTIN_THREADS_STATE_DIR';

/** The threads state dir: the env override, else ~/.local/state/justin-threads. */
export function resolveThreadsStateDir(
  env: Record<string, string | undefined>,
): string {
  const override = env[THREADS_STATE_DIR_ENV_VAR];
  if (override != null && override !== '') return override;
  return join(homedir(), '.local', 'state', 'justin-threads');
}

/** The documented shape, field for field. */
export interface ThreadStatusFile {
  /** Justin archived the session (`thread archive`). */
  archived: boolean;
  /** When this file was written, ISO-8601. */
  at: string;
  /** Requests of this session that are closed. */
  closedRequests: number;
  /**
   * The session is done: Justin marked it done, or every request is closed
   * and the work landed. Never true for an archived session.
   */
  done: boolean;
  /** Open P0 questions: the session is stopped on Justin. */
  openP0: number;
  /** Requests of this session that are still open. */
  openRequests: number;
  /** The inbox section the session lands in (session-card.ts InboxSection). */
  section: string;
  /** The status kind (session-status.ts SessionStatus['kind']), e.g. openWork. */
  statusWord: string;
}

export type StatusFileRead =
  | {kind: 'absent'; path: string}
  | {error: string; kind: 'unreadable'; path: string}
  | {kind: 'read'; path: string; status: ThreadStatusFile};

export type StatusFileWrite =
  | {error: string; kind: 'failed'; path: string}
  | {kind: 'written'; path: string};

/**
 * A session id is used as a file name, so only the characters a Claude
 * session id is made of are accepted: anything else could name a path outside
 * the status dir.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function statusFilePath(stateDir: string, sessionId: string): string {
  return join(stateDir, 'status', `${sessionId}.json`);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** The file's text as the documented shape, or why it is not that shape. */
export function parseStatusFile(
  text: string,
): {error: string; ok: false} | {ok: true; status: ThreadStatusFile} {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {error: `not JSON: ${errorText(error)}`, ok: false};
  }
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {error: 'not a JSON object', ok: false};
  }
  const record = raw as Record<string, unknown>;
  const {
    archived,
    at,
    closedRequests,
    done,
    openP0,
    openRequests,
    section,
    statusWord,
  } = record;
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) {
    return {error: '`at` is not an ISO date', ok: false};
  }
  if (typeof archived !== 'boolean' || typeof done !== 'boolean') {
    return {error: '`archived` and `done` must be booleans', ok: false};
  }
  if (!isCount(openRequests) || !isCount(closedRequests) || !isCount(openP0)) {
    return {
      error: '`openRequests`, `closedRequests` and `openP0` must be counts',
      ok: false,
    };
  }
  if (typeof section !== 'string' || typeof statusWord !== 'string') {
    return {error: '`section` and `statusWord` must be strings', ok: false};
  }
  return {
    ok: true,
    status: {
      archived,
      at,
      closedRequests,
      done,
      openP0,
      openRequests,
      section,
      statusWord,
    },
  };
}

/** Read one session's status file. Never throws. */
export function readStatusFile(
  stateDir: string,
  sessionId: string,
): StatusFileRead {
  const path = statusFilePath(stateDir, sessionId);
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return {error: 'not a session id', kind: 'unreadable', path};
  }
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (error) {
    const code =
      error != null && typeof error === 'object' && 'code' in error
        ? String((error as {code: unknown}).code)
        : '';
    // ENOENT alone is "no file"; a denied or failed read is not (rule 7).
    if (code === 'ENOENT') return {kind: 'absent', path};
    return {error: errorText(error), kind: 'unreadable', path};
  }
  const parsed = parseStatusFile(text);
  return parsed.ok
    ? {kind: 'read', path, status: parsed.status}
    : {error: parsed.error, kind: 'unreadable', path};
}

/**
 * Write one session's status file atomically: a temp file in the same
 * directory, then rename(2), so a render never reads half a file. The temp
 * name carries the pid, so two writers of one session never share it. Never
 * throws: a failure comes back as `failed`, and the temp file is removed.
 */
export function writeStatusFile(
  stateDir: string,
  sessionId: string,
  status: ThreadStatusFile,
): StatusFileWrite {
  const path = statusFilePath(stateDir, sessionId);
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return {error: `not a session id: ${sessionId}`, kind: 'failed', path};
  }
  const tmp = `${path}.tmp.${process.pid}`;
  try {
    mkdirSync(join(stateDir, 'status'), {recursive: true});
    writeFileSync(tmp, `${JSON.stringify(status)}\n`);
    renameSync(tmp, path);
    return {kind: 'written', path};
  } catch (error) {
    try {
      rmSync(tmp, {force: true});
    } catch {
      // The write already failed; a leftover temp file is said by the caller's record.
    }
    return {error: errorText(error), kind: 'failed', path};
  }
}
