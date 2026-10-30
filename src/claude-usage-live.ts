/**
 * live — the statusline usage store: what every open Claude window records and
 * reads between the hourly /usage samples (home-base-neapv.1 D1–D3, the display
 * read of neapv.6 D4).
 *
 * WHY (Justin, 2026-10-17): he wants to know as precisely as possible how close
 * the week got to 100% in the minutes before the weekly reset, and he wants idle
 * windows to show the newest number any session has seen. The statusline
 * payload carries the server's own 5-hour and 7-day percentages, but only as of
 * the last API response THAT session received. An idle session redraws the same
 * old numbers every 30 s, so a payload alone never says its numbers are fresh.
 * His words on that: "carefully validate the data that gets written to the
 * common usage store -- i just want to make sure that idle sessions don't write
 * out of date data there."
 *
 * HOW FRESHNESS IS PROVEN (D3), never assumed:
 *   1. Change proof. Claude Code changes rate_limits only when a response
 *      arrives, so a window is a CANDIDATE only when it differs from what this
 *      session's previous render saw (a per-session last-seen file). An idle
 *      session never produces one. A session's first render only seeds that
 *      file, and so does a render whose last-seen file is more than 10 minutes
 *      old (a resumed session keeps its id; its first numbers in a new process
 *      prove nothing — conductor refinement, 2026-10-17).
 *   2. Shape: a finite percentage in [0, 101]; 100–101 clamps to 100; above
 *      101 is Claude Code bug #52326 (the field carried the reset epoch).
 *   3. Expiry: a window whose reset has passed is over.
 *   4. Too far ahead (added 2026-10-17, beyond D3): a reset more than one
 *      window length plus an hour away cannot be real. Without it, one bad
 *      reading — or a test fixture's year-2033 reset — would become "the newest
 *      window" and every real reading after it would be refused as older, for
 *      years.
 *   5. Against live, same window (resets within 30 min of each other, because
 *      /usage prints a minute earlier than the statusline): lower than live is
 *      refused (usage within a window does not go down, so a lower number is
 *      old). An older window is refused. A newer window, or no current live
 *      reading, is accepted.
 * An accepted reading is appended to statusline.jsonl and written to live.json
 * (tmp + rename). A refused one is appended to the rejections log with the rule
 * that refused it. A live.json that cannot be parsed refuses every candidate
 * (`live-unreadable`): with no baseline nothing can be validated, and the next
 * /usage sample rewrites the file whole.
 *
 * CONCURRENCY: dozens of windows render every 30 s. The history append is one
 * O_APPEND write. live.json is last-rename-wins; a lost update heals on the next
 * change, and the history keeps both lines.
 *
 * COST: this runs inside the renderer process the statusline already spawns, so
 * it adds no process. An idle render reads two small files and, at most once a
 * minute, rewrites its own last-seen file. Nothing here reads the history.
 *
 * ONE OWNER (request home-base-ys9t7.5, D11; moved 2026-10-30 by
 * home-base-ys9t7.5.3). This module was home-base's src/claude-usage/live.ts,
 * with `storePaths` and `cacheDir` from its paths.ts. It moved WHOLE, not just
 * its file format: nothing in it depended on home-base code (only on the
 * samples module beside it), so the renderer's validation, the /usage feed and
 * the readers stay one file with one set of rules. Writers: home-base's
 * statusline renderer (src/starship/render-statusline.ts, `observeRender`) and
 * its hourly sampler (src/claude-usage/sample.ts, `feedLiveFromSample`).
 * Readers: the statusline's limits segment, `claude-usage`, and the spend
 * quota's week reader (thread/quota-week.ts). Behaviour is unchanged by the
 * move; its tests stay in home-base (src/claude-usage/live.test.ts), where
 * they also drive the near-reset reads.
 *
 * SESSION COST (home-base-ys9t7.8.1, 2026-10-30): the same render also records
 * Claude Code's own cost figure for the session when it changed, into
 * session-cost.jsonl beside statusline.jsonl. The format, the write rule and
 * the readers are claude-usage-cost.ts; this store calls it and owns its paths.
 */
import type {CostObservation} from './claude-usage-cost';
import type {OkSample, UnreadableLine, UsageEnv} from './claude-usage-samples';

import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {homedir} from 'node:os';
import {basename, dirname, join} from 'node:path';

import {recordSessionCost} from './claude-usage-cost';
import {dataDir, stateDir} from './claude-usage-samples';

// ─── where the store lives (neapv.1 D2) ──────────────────────────────────────

/**
 * The environment the store's paths are read from. `process.env` satisfies
 * it; tests pass a scratch one.
 */
export type Env = UsageEnv;

/** Replaces the cache directory (the per-session last-seen files). */
export const CACHE_DIR_ENV = 'CLAUDE_USAGE_CACHE_DIR';

function fromEnv(env: Env, key: string): string | null {
  const value = env[key]?.trim();
  // An empty override is a mistake, not a request for the current directory.
  return value == null || value === '' ? null : value;
}

/** `~/.cache/claude-usage`, or its XDG / env override (neapv.1 D2). */
export function cacheDir(env: Env = process.env): string {
  return (
    fromEnv(env, CACHE_DIR_ENV) ??
    join(
      fromEnv(env, 'XDG_CACHE_HOME') ?? join(homedir(), '.cache'),
      'claude-usage',
    )
  );
}

/** Every file the statusline store reads or writes, resolved once. */
export interface StorePaths {
  /**
   * Append-only: one line each time a session's Claude Code cost figure
   * changed (claude-usage-cost.ts, home-base-ys9t7.8.1).
   */
  costHistory: string;
  /** One file per session: the cost figure its last line recorded. */
  costSessions: string;
  /** Append-only: one line per accepted statusline window reading. */
  history: string;
  /** The newest validated reading per window; every statusline reads it. */
  live: string;
  /** Where a near-reset read's own output goes. */
  nearResetLog: string;
  /** The 3-minute slot lock files for near-reset reads. */
  nearResetSlots: string;
  /** One line per refused statusline reading, with the rule that refused it. */
  rejections: string;
  /** One file per session: the rate_limits its previous render saw. */
  sessions: string;
}

/**
 * The store's files. The statusline history is data Justin would miss, so it
 * sits next to samples.jsonl in the data dir; live.json, the rejections log
 * and the near-reset files are state; the last-seen files are cache.
 */
export function storePaths(env: Env = process.env): StorePaths {
  const state = stateDir(env);
  return {
    costHistory: join(dataDir(env), 'session-cost.jsonl'),
    costSessions: join(cacheDir(env), 'session-costs'),
    history: join(dataDir(env), 'statusline.jsonl'),
    live: join(state, 'live.json'),
    nearResetLog: join(state, 'near-reset.log'),
    nearResetSlots: join(state, 'near-reset'),
    rejections: join(state, 'statusline-rejected.jsonl'),
    sessions: join(cacheDir(env), 'sessions'),
  };
}

export const SCHEMA = 1;

/** `CLAUDE_USAGE_LIVE=0` turns recording, near-reset reads and the live display off (D6). */
export const LIVE_ENV = 'CLAUDE_USAGE_LIVE';

export function liveEnabled(env: Env): boolean {
  return env[LIVE_ENV]?.trim() !== '0';
}

export const WINDOWS = ['five_hour', 'seven_day'] as const;
export type WindowName = (typeof WINDOWS)[number];

const HOUR_MS = 60 * 60 * 1000;

/** How long each window lasts; bounds how far ahead a real reset can be. */
export const WINDOW_LENGTH_MS: Readonly<Record<WindowName, number>> = {
  five_hour: 5 * HOUR_MS,
  seven_day: 7 * 24 * HOUR_MS,
};

/** Resets closer than this are one window: /usage prints ~1 min earlier than the statusline (measured 2026-10-17). */
export const SAME_WINDOW_TOLERANCE_MS = 30 * 60 * 1000;

/** Slack on top of a window's length before a reset counts as impossibly far ahead. */
export const RESETS_AHEAD_SLACK_MS = HOUR_MS;

/** A last-seen file older than this re-seeds instead of producing a candidate. */
export const LAST_SEEN_MAX_AGE_MS = 10 * 60 * 1000;

/** An unchanged last-seen file is rewritten (to keep it young) at most this often. */
export const LAST_SEEN_REFRESH_MS = 60 * 1000;

/** Above this the percentage is Claude Code bug #52326, not a percentage. */
export const MAX_PCT = 101;

/** The debug logs (rejections, near-reset output) are truncated past this. */
export const LOG_CAP_BYTES = 256 * 1024;

// ─── payload ─────────────────────────────────────────────────────────────────

/** A window as one statusline payload carries it, after the shape check. */
export type PayloadWindow =
  | {kind: 'absent'}
  | {kind: 'invalid'; reason: string}
  | {
      kind: 'ok';
      /** Clamped to 100 when it was in (100, 101]; never floored here. */
      pct: number;
      /** Epoch SECONDS. Null when the payload carried none. */
      resetsAt: number | null;
    };

export type PayloadWindows = Readonly<Record<WindowName, PayloadWindow>>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

/**
 * Rounds away float noise: Claude Code appears to send utilization × 100, so a
 * server 29% can arrive as 28.999999999999996 (28.000000000000004 was seen
 * 2026-10-17). Unrounded, /usage's whole 29 would make the statusline's own 29
 * "lower than live", and Math.floor would show 28 (review finding 3,
 * 2026-10-17). Six decimals keeps any real fraction.
 */
export function normalisePct(pct: number): number {
  return Math.round(pct * 1e6) / 1e6;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Shape check for one `rate_limits.<window>` object (D3 rule 2). */
export function parsePayloadWindow(raw: unknown): PayloadWindow {
  if (raw == null) return {kind: 'absent'};
  if (!isObject(raw)) {
    return {kind: 'invalid', reason: `not an object: ${JSON.stringify(raw)}`};
  }
  const rawPct = raw.used_percentage;
  if (rawPct == null) return {kind: 'absent'};
  if (typeof rawPct !== 'number' || !Number.isFinite(rawPct)) {
    return {
      kind: 'invalid',
      reason: `used_percentage is not a finite number: ${JSON.stringify(rawPct)}`,
    };
  }
  // Every comparison and every display uses the normalised value.
  const pct = normalisePct(rawPct);
  if (pct < 0) {
    return {kind: 'invalid', reason: `used_percentage is negative: ${pct}`};
  }
  if (pct > MAX_PCT) {
    return {
      kind: 'invalid',
      reason: `used_percentage ${pct} is above ${MAX_PCT} (Claude Code bug #52326 puts the reset epoch there)`,
    };
  }
  const resets = raw.resets_at;
  if (resets == null)
    return {kind: 'ok', pct: Math.min(pct, 100), resetsAt: null};
  if (typeof resets !== 'number' || !Number.isFinite(resets) || resets <= 0) {
    return {
      kind: 'invalid',
      reason: `resets_at is not an epoch in seconds: ${JSON.stringify(resets)}`,
    };
  }
  return {kind: 'ok', pct: Math.min(pct, 100), resetsAt: resets};
}

/**
 * The raw window as one comparable string, or null when the payload has none.
 * Change detection compares these, BEFORE any validation, so even a malformed
 * value that changes is noticed (and then refused by the shape rule).
 */
function fingerprint(raw: unknown): string | null {
  if (raw == null) return null;
  if (!isObject(raw)) return JSON.stringify(raw);
  return JSON.stringify([raw.used_percentage ?? null, raw.resets_at ?? null]);
}

interface ParsedRateLimits {
  fingerprints: Record<WindowName, string | null>;
  windows: PayloadWindows;
}

/**
 * `rateLimitsJson` is the payload's `.rate_limits` as JSON, or '' when the
 * payload had none (non-subscriber, older Claude Code, no response yet).
 */
export function parseRateLimits(rateLimitsJson: string): ParsedRateLimits {
  const absent: ParsedRateLimits = {
    fingerprints: {five_hour: null, seven_day: null},
    windows: {five_hour: {kind: 'absent'}, seven_day: {kind: 'absent'}},
  };
  if (rateLimitsJson.trim() === '' || rateLimitsJson.trim() === 'null') {
    return absent;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rateLimitsJson);
  } catch (err) {
    const reason = `rate_limits is not JSON: ${err instanceof Error ? err.message : String(err)}`;
    return {
      fingerprints: {five_hour: rateLimitsJson, seven_day: rateLimitsJson},
      windows: {
        five_hour: {kind: 'invalid', reason},
        seven_day: {kind: 'invalid', reason},
      },
    };
  }
  if (!isObject(parsed)) {
    const reason = `rate_limits is not an object: ${rateLimitsJson}`;
    return {
      fingerprints: {five_hour: rateLimitsJson, seven_day: rateLimitsJson},
      windows: {
        five_hour: {kind: 'invalid', reason},
        seven_day: {kind: 'invalid', reason},
      },
    };
  }
  return {
    fingerprints: {
      five_hour: fingerprint(parsed.five_hour),
      seven_day: fingerprint(parsed.seven_day),
    },
    windows: {
      five_hour: parsePayloadWindow(parsed.five_hour),
      seven_day: parsePayloadWindow(parsed.seven_day),
    },
  };
}

// ─── live.json ───────────────────────────────────────────────────────────────

export type LiveSource = 'statusline' | 'usage';

export interface LiveWindow {
  /** When the reading was taken, ISO-8601. */
  at: string;
  pct: number;
  /** Epoch SECONDS. */
  resetsAt: number;
  /** The session whose statusline saw it; null for a /usage sample. */
  sessionId: string | null;
  source: LiveSource;
}

export interface LiveState {
  five_hour: LiveWindow | null;
  schema: typeof SCHEMA;
  seven_day: LiveWindow | null;
}

/** Missing (never written) is not empty, and neither is a file that cannot be read. */
export type LiveRead =
  | {
      /**
       * True when the file was read but its CONTENT is not a live state (not
       * JSON, wrong schema, a bad window) — such a file is quarantined. False
       * for an I/O failure (EACCES, EISDIR), which renaming would not fix.
       */
      corrupt: boolean;
      kind: 'failed';
      reason: string;
      /** The bytes that failed, so quarantine can check it renames THAT file. */
      text: string | null;
    }
  | {kind: 'missing'}
  | {kind: 'ok'; state: LiveState};

export function emptyLive(): LiveState {
  return {five_hour: null, schema: SCHEMA, seven_day: null};
}

function liveWindowProblem(value: unknown): string | null {
  if (value === null) return null;
  if (!isObject(value)) return 'not an object';
  if (typeof value.pct !== 'number' || !Number.isFinite(value.pct)) {
    return 'no finite pct';
  }
  if (value.pct < 0 || value.pct > 100) return `pct ${value.pct} out of range`;
  if (typeof value.resetsAt !== 'number' || !Number.isFinite(value.resetsAt)) {
    return 'no finite resetsAt';
  }
  if (typeof value.at !== 'string' || Number.isNaN(Date.parse(value.at))) {
    return 'no valid at';
  }
  if (value.source !== 'statusline' && value.source !== 'usage') {
    return `unknown source ${JSON.stringify(value.source)}`;
  }
  if (value.sessionId !== null && typeof value.sessionId !== 'string') {
    return 'sessionId is neither a string nor null';
  }
  return null;
}

export function readLive(path: string): LiveRead {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (err) {
    if ((err as {code?: string}).code === 'ENOENT') return {kind: 'missing'};
    return {
      corrupt: false,
      kind: 'failed',
      reason: `could not read ${path}: ${message(err)}`,
      text: null,
    };
  }
  const corrupt = (reason: string): LiveRead => ({
    corrupt: true,
    kind: 'failed',
    reason,
    text,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return corrupt(`${path} is not JSON: ${message(err)}`);
  }
  if (!isObject(parsed)) return corrupt(`${path} is not an object`);
  if (parsed.schema !== SCHEMA) {
    return corrupt(
      `${path} has schema ${JSON.stringify(parsed.schema)}, not ${SCHEMA}`,
    );
  }
  for (const window of WINDOWS) {
    const problem = liveWindowProblem(parsed[window] ?? null);
    if (problem != null) return corrupt(`${path}: ${window}: ${problem}`);
  }
  return {
    kind: 'ok',
    state: {
      five_hour: (parsed.five_hour ?? null) as LiveWindow | null,
      schema: SCHEMA,
      seven_day: (parsed.seven_day ?? null) as LiveWindow | null,
    },
  };
}

/** How many quarantined live.json copies are kept (review finding 9). */
export const KEEP_BAD_LIVE_FILES = 3;

export type QuarantineOutcome =
  | {kind: 'changed'}
  | {kind: 'failed'; reason: string}
  | {kind: 'renamed'; to: string};

/**
 * Move a corrupt live.json aside to `live.json.bad-<ISO stamp>-<pid>`, keeping
 * the newest KEEP_BAD_LIVE_FILES, so the store starts over instead of refusing
 * every reading until the next /usage sample (review finding 9, 2026-10-17).
 * The file is re-read first: if it no longer holds the bytes that failed,
 * another process has already replaced it, and that file is left alone.
 */
export function quarantineLive(
  path: string,
  badText: string | null,
  nowMs: number,
): QuarantineOutcome {
  try {
    if (readFileSync(path, 'utf-8') !== badText) return {kind: 'changed'};
  } catch (err) {
    if ((err as {code?: string}).code === 'ENOENT') return {kind: 'changed'};
    return {
      kind: 'failed',
      reason: `could not re-read ${path}: ${message(err)}`,
    };
  }
  const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, '-');
  const to = `${path}.bad-${stamp}-${process.pid}`;
  try {
    renameSync(path, to);
  } catch (err) {
    if ((err as {code?: string}).code === 'ENOENT') return {kind: 'changed'};
    return {
      kind: 'failed',
      reason: `could not rename ${path}: ${message(err)}`,
    };
  }
  try {
    const dir = dirname(path);
    const prefix = `${basename(path)}.bad-`;
    const bad = readdirSync(dir)
      .filter((name) => name.startsWith(prefix))
      .sort(); // ISO stamps sort oldest first
    for (const name of bad.slice(
      0,
      Math.max(0, bad.length - KEEP_BAD_LIVE_FILES),
    )) {
      rmSync(join(dir, name), {force: true});
    }
  } catch {
    // Pruning old copies is housekeeping; the rename is what mattered.
  }
  return {kind: 'renamed', to};
}

/**
 * Replace `path` in one step (tmp in the same directory, then rename), creating
 * its directory. The store's directories are this tool's own, so creating them
 * whole is right here — unlike atomic.ts, which refuses to conjure a Dropbox
 * tree for a configured path.
 */
function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), {recursive: true});
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, {force: true});
    throw err;
  }
}

export function writeLive(path: string, state: LiveState): void {
  writeFileAtomic(path, `${JSON.stringify(state)}\n`);
}

/** Append `text` (whole lines) with one write; past `cap` bytes the file starts over. */
function appendCapped(path: string, text: string, cap: number): void {
  mkdirSync(dirname(path), {recursive: true});
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    // No file yet: nothing to cap. Any other stat failure surfaces in the append.
  }
  if (size > cap) {
    writeFileSync(
      path,
      `${JSON.stringify({at: new Date().toISOString(), note: `truncated: the file had reached ${size} bytes`})}\n`,
    );
  }
  appendFileSync(path, text);
}

// ─── validation ──────────────────────────────────────────────────────────────

export type RejectRule =
  | 'expired'
  | 'live-unreadable'
  | 'lower-than-live'
  | 'older-window'
  | 'shape'
  | 'too-far-ahead';

export type Verdict =
  | {kind: 'accept'; pct: number; resetsAt: number}
  | {detail: string; kind: 'reject'; rule: RejectRule};

function isCurrent(resetsAt: number, nowMs: number): boolean {
  return resetsAt * 1000 > nowMs;
}

/**
 * Judge one candidate against the live reading for the same window (D3 rules
 * 2–5). `live` must already be known-good; an unreadable live.json is the
 * caller's `live-unreadable`.
 */
export function judgeCandidate(
  window: WindowName,
  candidate: PayloadWindow,
  live: LiveWindow | null,
  nowMs: number,
): Verdict {
  if (candidate.kind === 'absent') {
    return {detail: 'the window is absent', kind: 'reject', rule: 'shape'};
  }
  if (candidate.kind === 'invalid') {
    return {detail: candidate.reason, kind: 'reject', rule: 'shape'};
  }
  const {pct, resetsAt} = candidate;
  if (resetsAt == null) {
    return {detail: 'no resets_at', kind: 'reject', rule: 'shape'};
  }
  const resetMs = resetsAt * 1000;
  if (resetMs <= nowMs) {
    return {
      detail: `the window reset at ${new Date(resetMs).toISOString()}`,
      kind: 'reject',
      rule: 'expired',
    };
  }
  const limitMs = nowMs + WINDOW_LENGTH_MS[window] + RESETS_AHEAD_SLACK_MS;
  if (resetMs > limitMs) {
    return {
      detail: `resets ${new Date(resetMs).toISOString()}, more than a ${window} window plus an hour away`,
      kind: 'reject',
      rule: 'too-far-ahead',
    };
  }
  if (live == null || !isCurrent(live.resetsAt, nowMs)) {
    return {kind: 'accept', pct, resetsAt};
  }
  const diffMs = resetMs - live.resetsAt * 1000;
  if (Math.abs(diffMs) <= SAME_WINDOW_TOLERANCE_MS) {
    if (pct < live.pct) {
      return {
        detail: `${pct} is below live's ${live.pct} in the same window`,
        kind: 'reject',
        rule: 'lower-than-live',
      };
    }
    return {kind: 'accept', pct, resetsAt};
  }
  if (diffMs < 0) {
    return {
      detail: `resets ${new Date(resetMs).toISOString()}, before live's window (${new Date(live.resetsAt * 1000).toISOString()})`,
      kind: 'reject',
      rule: 'older-window',
    };
  }
  return {kind: 'accept', pct, resetsAt};
}

// ─── per-session last-seen ───────────────────────────────────────────────────

interface LastSeen {
  schema: typeof SCHEMA;
  seenAt: string;
  windows: Record<WindowName, string | null>;
}

type LastSeenRead =
  | {kind: 'failed'; reason: string}
  | {kind: 'missing'}
  | {kind: 'ok'; seenAtMs: number; windows: Record<WindowName, string | null>};

/** Session ids become file names, so only UUID-like ids are recorded. */
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function sessionFile(paths: StorePaths, sessionId: string): string {
  return join(paths.sessions, `${sessionId}.json`);
}

/** A session's last recorded cost figure (claude-usage-cost.ts). */
export function costSessionFile(paths: StorePaths, sessionId: string): string {
  return join(paths.costSessions, `${sessionId}.json`);
}

function readLastSeen(path: string): LastSeenRead {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (err) {
    if ((err as {code?: string}).code === 'ENOENT') return {kind: 'missing'};
    return {
      kind: 'failed',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isObject(parsed) || parsed.schema !== SCHEMA) {
      return {kind: 'failed', reason: 'not a schema-1 last-seen record'};
    }
    const seenAtMs =
      typeof parsed.seenAt === 'string' ? Date.parse(parsed.seenAt) : NaN;
    const windows = parsed.windows;
    if (Number.isNaN(seenAtMs) || !isObject(windows)) {
      return {kind: 'failed', reason: 'no seenAt or windows'};
    }
    const value = (w: WindowName): string | null | undefined => {
      const v = windows[w];
      return v === null || typeof v === 'string' ? v : undefined;
    };
    const five = value('five_hour');
    const seven = value('seven_day');
    if (five === undefined || seven === undefined) {
      return {kind: 'failed', reason: 'a window fingerprint is malformed'};
    }
    return {kind: 'ok', seenAtMs, windows: {five_hour: five, seven_day: seven}};
  } catch (err) {
    return {
      kind: 'failed',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── one render ──────────────────────────────────────────────────────────────

export interface ObserveInput {
  ccVersion: string | null;
  /**
   * The payload's cost slice, `{cost, modelId, cwd, projectDir}` as JSON; ''
   * or absent when it had none (an older wrapper passes nothing). Recorded by
   * claude-usage-cost.ts when the figure changed (home-base-ys9t7.8.1).
   */
  costJson?: string;
  nowMs: number;
  paths: StorePaths;
  /** The payload's `.rate_limits` as JSON; '' when it had none. */
  rateLimitsJson: string;
  /** The payload's session_id; '' when it had none. */
  sessionId: string;
  /** The payload's transcript_path, written on a cost line; null when unknown. */
  transcriptPath?: string | null;
}

export interface Rejection {
  detail: string;
  rule: RejectRule;
  window: WindowName;
}

/** Why this render produced no candidates, when it did not compare at all. */
export type SeedReason =
  | 'first-render'
  | 'last-seen-stale'
  | 'last-seen-unreadable'
  | 'no-session-id';

export interface ObserveResult {
  accepted: WindowName[];
  /** What this render did about the session's cost figure. */
  cost: CostObservation;
  /** Store reads and writes that failed, each named. The render never throws for these. */
  errors: string[];
  /** live.json after this render's own update. */
  live: LiveRead;
  own: PayloadWindows;
  rejected: Rejection[];
  /** Non-null when this render only seeded (no comparison was possible). */
  seeded: SeedReason | null;
}

/** One line of statusline.jsonl (D2). */
export interface StatuslineReading {
  at: string;
  ccVersion: string | null;
  pct: number;
  /** Epoch SECONDS. */
  resetsAt: number;
  schema: typeof SCHEMA;
  sessionId: string;
  window: WindowName;
}

/**
 * Everything one statusline render does to the store (D3): parse its windows,
 * find candidates by comparing with this session's last-seen, judge each, and
 * write the accepted ones (history + live) and the refused ones (rejections).
 *
 * Never throws for an I/O failure — each is named in `errors` and the render
 * carries on with what it has. A bug elsewhere could still throw; the caller
 * catches that too.
 */
export function observeRender(input: ObserveInput): ObserveResult {
  const {nowMs, paths, sessionId} = input;
  const nowIso = new Date(nowMs).toISOString();
  const {fingerprints, windows: own} = parseRateLimits(input.rateLimitsJson);
  const errors: string[] = [];
  let live = readLive(paths.live);
  // A corrupt live.json is moved aside and the store starts over, rather than
  // refusing every reading until the next /usage sample (review finding 9).
  // An I/O failure is left as it is: renaming would not fix it.
  if (live.kind === 'failed' && live.corrupt) {
    const reason = live.reason;
    const moved = quarantineLive(paths.live, live.text, nowMs);
    if (moved.kind === 'failed') {
      errors.push(moved.reason);
    } else {
      if (moved.kind === 'renamed') {
        const event = {
          at: nowIso,
          event: 'quarantined',
          from: paths.live,
          reason,
          schema: SCHEMA,
          sessionId,
          to: moved.to,
        };
        try {
          appendCapped(
            paths.rejections,
            `${JSON.stringify(event)}\n`,
            LOG_CAP_BYTES,
          );
        } catch (err) {
          errors.push(
            `could not append to ${paths.rejections}: ${message(err)}`,
          );
        }
      }
      live = readLive(paths.live);
    }
  }
  let cost: CostObservation = {kind: 'no-session-id'};
  const result = (
    seeded: SeedReason | null,
    accepted: WindowName[] = [],
    rejected: Rejection[] = [],
  ): ObserveResult => ({accepted, cost, errors, live, own, rejected, seeded});

  if (!SAFE_SESSION_ID.test(sessionId)) return result('no-session-id');

  // 0. The session's cost figure (home-base-ys9t7.8.1): its own change proof,
  // independent of the rate_limits below; the no-change path reads one small
  // file. Before step 1 because step 1 can return early.
  cost = recordSessionCost({
    ccVersion: input.ccVersion,
    costJson: input.costJson ?? '',
    historyPath: paths.costHistory,
    lastPath: costSessionFile(paths, sessionId),
    nowMs,
    sessionId,
    transcriptPath: input.transcriptPath ?? null,
  });
  if (cost.kind === 'failed') errors.push(cost.reason);
  if (cost.kind === 'written' && cost.cacheError != null) {
    errors.push(cost.cacheError);
  }

  // 1. Change proof against this session's previous render.
  const seenPath = sessionFile(paths, sessionId);
  const seen = readLastSeen(seenPath);
  let seeded: SeedReason | null = null;
  if (seen.kind === 'missing') seeded = 'first-render';
  else if (seen.kind === 'failed') seeded = 'last-seen-unreadable';
  else if (nowMs - seen.seenAtMs > LAST_SEEN_MAX_AGE_MS) {
    seeded = 'last-seen-stale';
  }
  const changed = WINDOWS.filter(
    (w) =>
      seen.kind === 'ok' &&
      seen.windows[w] !== fingerprints[w] &&
      own[w].kind !== 'absent',
  );
  const candidates = seeded == null ? changed : [];
  // A window that drops out of the payload keeps its last fingerprint, so the
  // same old value coming back is not mistaken for a new one (review finding 4).
  const stored: Record<WindowName, string | null> = {
    five_hour: null,
    seven_day: null,
  };
  for (const w of WINDOWS) {
    stored[w] =
      own[w].kind === 'absent'
        ? seen.kind === 'ok'
          ? seen.windows[w]
          : null
        : fingerprints[w];
  }
  const unchanged =
    seen.kind === 'ok' && WINDOWS.every((w) => seen.windows[w] === stored[w]);
  if (
    seeded != null ||
    !unchanged ||
    nowMs - (seen.kind === 'ok' ? seen.seenAtMs : 0) >= LAST_SEEN_REFRESH_MS
  ) {
    const record: LastSeen = {
      schema: SCHEMA,
      seenAt: nowIso,
      windows: stored,
    };
    try {
      writeFileAtomic(seenPath, `${JSON.stringify(record)}\n`);
    } catch (err) {
      errors.push(`could not write ${seenPath}: ${message(err)}`);
    }
  }
  if (candidates.length === 0) return result(seeded);

  // 2. Judge each candidate against live.
  const accepted: WindowName[] = [];
  const rejected: Rejection[] = [];
  const history: StatuslineReading[] = [];
  const next: LiveState = live.kind === 'ok' ? {...live.state} : emptyLive();
  for (const window of candidates) {
    if (live.kind === 'failed') {
      rejected.push({detail: live.reason, rule: 'live-unreadable', window});
      continue;
    }
    const verdict = judgeCandidate(window, own[window], next[window], nowMs);
    if (verdict.kind === 'reject') {
      rejected.push({detail: verdict.detail, rule: verdict.rule, window});
      continue;
    }
    accepted.push(window);
    next[window] = {
      at: nowIso,
      pct: verdict.pct,
      resetsAt: verdict.resetsAt,
      sessionId,
      source: 'statusline',
    };
    history.push({
      at: nowIso,
      ccVersion: input.ccVersion,
      pct: verdict.pct,
      resetsAt: verdict.resetsAt,
      schema: SCHEMA,
      sessionId,
      window,
    });
  }

  // 3. Write what was decided. History first: it is the data Justin would miss.
  if (history.length > 0) {
    try {
      mkdirSync(dirname(paths.history), {recursive: true});
      appendFileSync(
        paths.history,
        history.map((h) => `${JSON.stringify(h)}\n`).join(''),
      );
    } catch (err) {
      errors.push(`could not append to ${paths.history}: ${message(err)}`);
    }
    try {
      writeLive(paths.live, next);
      live = {kind: 'ok', state: next};
    } catch (err) {
      errors.push(`could not write ${paths.live}: ${message(err)}`);
    }
  }
  if (rejected.length > 0 || errors.length > 0) {
    const lines = [
      ...rejected.map((r) => {
        const w = own[r.window];
        return {
          at: nowIso,
          ccVersion: input.ccVersion,
          detail: r.detail,
          live:
            live.kind === 'ok'
              ? (live.state[r.window] ?? null)
              : {
                  unreadable: live.kind === 'failed' ? live.reason : 'missing',
                },
          pct: w.kind === 'ok' ? w.pct : null,
          resetsAt: w.kind === 'ok' ? w.resetsAt : null,
          rule: r.rule,
          schema: SCHEMA,
          sessionId,
          window: r.window,
        };
      }),
      ...errors.map((e) => ({at: nowIso, error: e, schema: SCHEMA, sessionId})),
    ];
    try {
      appendCapped(
        paths.rejections,
        lines.map((l) => `${JSON.stringify(l)}\n`).join(''),
        LOG_CAP_BYTES,
      );
    } catch (err) {
      errors.push(`could not append to ${paths.rejections}: ${message(err)}`);
    }
  }
  return {accepted, cost, errors, live, own, rejected, seeded: null};
}

// ─── display (neapv.6 D4) ────────────────────────────────────────────────────

export type DisplayChoice =
  | {at: string; pct: number; resetsAt: number; source: 'live'}
  | {pct: number; resetsAt: number | null; source: 'own'}
  | {source: 'none'};

/**
 * What the bar shows for one window: live's reading when its window is
 * current, else this session's own when current (or when the payload gave no
 * reset, as the bash bar always did), else nothing.
 */
export function chooseDisplay(
  window: WindowName,
  own: PayloadWindow,
  live: LiveRead,
  nowMs: number,
): DisplayChoice {
  const fromLive = live.kind === 'ok' ? live.state[window] : null;
  if (fromLive != null && isCurrent(fromLive.resetsAt, nowMs)) {
    return {
      at: fromLive.at,
      pct: fromLive.pct,
      resetsAt: fromLive.resetsAt,
      source: 'live',
    };
  }
  if (
    own.kind === 'ok' &&
    (own.resetsAt == null || isCurrent(own.resetsAt, nowMs))
  ) {
    return {pct: own.pct, resetsAt: own.resetsAt, source: 'own'};
  }
  return {source: 'none'};
}

// ─── /usage feeds live (D3 rule 5) ───────────────────────────────────────────

export type UsageFeedOutcome =
  | {kind: 'failed'; reason: string}
  | {kind: 'unchanged'; reasons: string[]}
  | {kind: 'written'; path: string; reasons: string[]; windows: WindowName[]};

/**
 * After an OK /usage sample, set live's windows from it (source "usage").
 *
 * It is authoritative EVEN WHEN LOWER, so a real server-side correction
 * re-baselines the store within an hour — and, since review finding 1
 * (2026-10-17), even when live holds a NEWER window: one bad but plausible
 * reset (another account's session, a Claude Code resets_at bug) would
 * otherwise make every real reading an "older window" for up to a week, with
 * nothing to heal it. Two exceptions, both about a live reading taken at or
 * after `readStartMs`, the moment the successful /usage attempt started (the
 * panel is stamped ~6.5 s later, when the read finishes):
 *   - live holds a newer window read since then: that window really began;
 *   - live holds a HIGHER statusline reading of the same window read since
 *     then: it is fresher than the panel (review finding 2).
 * In the same window it keeps the LATER of the two resets: the panel prints
 * the reset a minute early ("3:59pm"), and a live window ending a minute early
 * would read as expired in the final minute before the reset (review finding
 * 5). A corrupt live.json is quarantined first, then replaced whole.
 */
export function feedLiveFromSample(
  path: string,
  sample: OkSample,
  options: {nowMs: number; readStartMs: number},
): UsageFeedOutcome {
  const {nowMs, readStartMs} = options;
  let current = readLive(path);
  const reasons: string[] = [];
  if (current.kind === 'failed') {
    reasons.push(`replacing an unreadable live.json: ${current.reason}`);
    if (current.corrupt) {
      const moved = quarantineLive(path, current.text, nowMs);
      if (moved.kind === 'renamed') reasons.push(`kept it as ${moved.to}`);
      if (moved.kind === 'failed') reasons.push(moved.reason);
      if (moved.kind === 'changed') current = readLive(path);
    }
  }
  const next: LiveState =
    current.kind === 'ok' ? {...current.state} : emptyLive();
  const sampledMs = Date.parse(sample.sampledAt);
  const pairs: [WindowName, OkSample['week']][] = [
    ['five_hour', sample.session],
    ['seven_day', sample.week],
  ];
  const windows: WindowName[] = [];
  for (const [window, usage] of pairs) {
    const resetMs = usage.resetsAt == null ? NaN : Date.parse(usage.resetsAt);
    if (Number.isNaN(resetMs)) {
      reasons.push(
        `${window}: the sample has no reset time, so it was not placed`,
      );
      continue;
    }
    if (!Number.isFinite(usage.pct) || usage.pct < 0 || usage.pct > MAX_PCT) {
      reasons.push(`${window}: ${usage.pct}% is not a percentage`);
      continue;
    }
    if (resetMs <= sampledMs || resetMs <= nowMs) {
      reasons.push(`${window}: the sample's window has already reset`);
      continue;
    }
    const pct = Math.min(normalisePct(usage.pct), 100);
    const existing = next[window];
    const existingCurrent =
      existing != null && isCurrent(existing.resetsAt, nowMs);
    const readSince =
      existing != null && Date.parse(existing.at) >= readStartMs;
    const sameWindow =
      existing != null &&
      Math.abs(resetMs - existing.resetsAt * 1000) <= SAME_WINDOW_TOLERANCE_MS;
    if (
      existingCurrent &&
      readSince &&
      resetMs < existing.resetsAt * 1000 - SAME_WINDOW_TOLERANCE_MS
    ) {
      reasons.push(
        `${window}: live holds a newer window read after this /usage read started`,
      );
      continue;
    }
    if (
      existingCurrent &&
      sameWindow &&
      readSince &&
      existing.source === 'statusline' &&
      pct < existing.pct
    ) {
      reasons.push(
        `${window}: live holds a higher statusline reading (${existing.pct}%) taken after this /usage read started`,
      );
      continue;
    }
    next[window] = {
      at: sample.sampledAt,
      pct,
      resetsAt:
        existingCurrent && sameWindow
          ? Math.max(existing.resetsAt, Math.round(resetMs / 1000))
          : Math.round(resetMs / 1000),
      sessionId: null,
      source: 'usage',
    };
    windows.push(window);
  }
  if (windows.length === 0) return {kind: 'unchanged', reasons};
  try {
    writeLive(path, next);
  } catch (err) {
    return {kind: 'failed', reason: `could not write ${path}: ${message(err)}`};
  }
  return {kind: 'written', path, reasons, windows};
}

// ─── reading the history back (D7) ───────────────────────────────────────────

export type StatuslineHistoryRead =
  | {kind: 'failed'; path: string; reason: string}
  | {kind: 'missing'; path: string}
  | {
      kind: 'ok';
      path: string;
      readings: StatuslineReading[];
      unreadable: UnreadableLine[];
    };

function readingProblem(value: unknown): string | null {
  if (!isObject(value)) return 'not a JSON object';
  if (value.schema !== SCHEMA) return `schema ${JSON.stringify(value.schema)}`;
  if (typeof value.at !== 'string' || Number.isNaN(Date.parse(value.at))) {
    return 'no valid at';
  }
  if (value.window !== 'five_hour' && value.window !== 'seven_day') {
    return `unknown window ${JSON.stringify(value.window)}`;
  }
  if (typeof value.pct !== 'number' || !Number.isFinite(value.pct)) {
    return 'no finite pct';
  }
  if (typeof value.resetsAt !== 'number' || !Number.isFinite(value.resetsAt)) {
    return 'no finite resetsAt';
  }
  if (typeof value.sessionId !== 'string') return 'no sessionId';
  return null;
}

/** Read statusline.jsonl; a malformed line is skipped AND reported, as readSamples does. */
export function readStatuslineHistory(path: string): StatuslineHistoryRead {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (err) {
    if ((err as {code?: string}).code === 'ENOENT')
      return {kind: 'missing', path};
    return {
      kind: 'failed',
      path,
      reason: `could not read ${path}: ${message(err)}`,
    };
  }
  const readings: StatuslineReading[] = [];
  const unreadable: UnreadableLine[] = [];
  text.split('\n').forEach((line, index) => {
    if (line.trim() === '') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      unreadable.push({line: index + 1, reason: `not JSON: ${message(err)}`});
      return;
    }
    const problem = readingProblem(parsed);
    if (problem == null) readings.push(parsed as StatuslineReading);
    else unreadable.push({line: index + 1, reason: problem});
  });
  return {kind: 'ok', path, readings, unreadable};
}
