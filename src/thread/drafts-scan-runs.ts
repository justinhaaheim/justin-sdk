/**
 * drafts-scan-runs — the run log of `thread drafts scan` (home-base-fmf1n D5).
 *
 * `<threads state dir>/drafts-scan/runs.jsonl`, append-only, ONE JSON line per
 * scan run, whatever started it: the hourly hook (`thread drafts hook`, D1) or
 * a person (`thread drafts scan`). A hook that SKIPS writes nothing here and
 * takes no claim, so a skip can never read as a clean run.
 *
 * The hourly claims live beside it in `claims/` (D3), one file per wall-clock
 * hour label, so many sessions firing hooks at once start one scan an hour.
 *
 * A LEAF on purpose: node built-ins and status-file.ts only. The hook reads
 * the claim path on every prompt and turn end of every home-base session, so
 * nothing heavy may load from here. The reader that judges this log for
 * chores is drafts-scan-health.ts.
 */

import {appendFileSync, mkdirSync, readFileSync} from 'fs';
import {dirname, join} from 'path';

import {resolveThreadsStateDir} from './status-file';

type Env = Record<string, string | undefined>;

/** What started a run. */
export type DraftsScanTrigger = 'hook' | 'manual';

/**
 * How a run ended (D5).
 * - scanned: the scan finished and nothing failed (`thread drafts scan` exit 0).
 * - unreachable: cmux could not be reached; nothing was written (exit 2).
 * - failed: the scan finished but something failed (exit 1), or it threw, or
 *   the hook claimed the hour and could not start it.
 * - timed-out: the run stopped itself at its cap (D4).
 */
export type DraftsScanOutcome =
  | 'failed'
  | 'scanned'
  | 'timed-out'
  | 'unreachable';

export const DRAFTS_SCAN_OUTCOMES: readonly DraftsScanOutcome[] = [
  'failed',
  'scanned',
  'timed-out',
  'unreachable',
];

/** The scan's own counts, present whenever the scan itself finished. */
export interface DraftsScanCounts {
  claudePanes: number;
  cleared: number;
  failures: number;
  found: number;
  surfacesRead: number;
  unplaced: number;
  unreadable: number;
}

export interface DraftsScanRun {
  /** The counts, or null when the scan did not finish (unreachable, threw, timed out). */
  counts: DraftsScanCounts | null;
  /** ISO-8601 UTC. */
  endedAt: string;
  /** What went wrong, in words; null for a clean scan. */
  error: string | null;
  /** The exit code the run returned, or null when it never got one. */
  exitCode: number | null;
  outcome: DraftsScanOutcome;
  /**
   * The parent pid when the run ended. A hook-started scan outlives its hook,
   * so this is 1 for one: the evidence that it ran detached (D4).
   */
  parentPidAtEnd: number | null;
  pid: number | null;
  /** ISO-8601 UTC. */
  startedAt: string;
  trigger: DraftsScanTrigger;
}

/** The machine's own time zone, which the claims and the verdict both use. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * The wall-clock hour an instant falls in, `YYYY-MM-DDTHH` in `timeZone`
 * (D3: the chores rule, a calendar unit and never elapsed time). Labels sort
 * in wall-clock order. At the fall-back change the repeated hour has one
 * label, so it gets one scan.
 */
export function hourLabel(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    month: '2-digit',
    timeZone,
    year: 'numeric',
  }).formatToParts(instant);
  const part = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? '??';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}`;
}

/** `<threads state dir>/drafts-scan`. */
export function draftsScanDir(env: Env = process.env): string {
  return join(resolveThreadsStateDir(env), 'drafts-scan');
}

export function draftsScanRunsPath(env: Env = process.env): string {
  return join(draftsScanDir(env), 'runs.jsonl');
}

export function draftsScanClaimsDir(env: Env = process.env): string {
  return join(draftsScanDir(env), 'claims');
}

/** Append one record. Returns null when written, else why not. Never throws. */
export function appendDraftsScanRun(
  run: DraftsScanRun,
  env: Env = process.env,
): string | null {
  const path = draftsScanRunsPath(env);
  try {
    mkdirSync(dirname(path), {recursive: true});
    appendFileSync(path, `${JSON.stringify(run)}\n`);
    return null;
  } catch (error) {
    return `the drafts scan run log ${path} could not be written: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function isCounts(value: unknown): value is DraftsScanCounts {
  if (value == null || typeof value !== 'object') return false;
  const counts = value as Record<string, unknown>;
  return [
    'claudePanes',
    'cleared',
    'failures',
    'found',
    'surfacesRead',
    'unplaced',
    'unreadable',
  ].every((key) => typeof counts[key] === 'number');
}

const nullableNumber = (value: unknown): boolean =>
  value === null || typeof value === 'number';

/** One line, or the reason it is not a run record. */
export function parseDraftsScanRun(
  line: string,
): {ok: false; reason: string} | {ok: true; run: DraftsScanRun} {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    return {
      ok: false,
      reason: `not JSON (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  if (value == null || typeof value !== 'object') {
    return {ok: false, reason: 'not a JSON object'};
  }
  const run = value as Record<string, unknown>;
  const valid =
    typeof run.startedAt === 'string' &&
    !Number.isNaN(Date.parse(run.startedAt)) &&
    typeof run.endedAt === 'string' &&
    (run.trigger === 'hook' || run.trigger === 'manual') &&
    (DRAFTS_SCAN_OUTCOMES as readonly unknown[]).includes(run.outcome) &&
    nullableNumber(run.exitCode) &&
    (run.error === null || typeof run.error === 'string') &&
    (run.counts === null || isCounts(run.counts)) &&
    nullableNumber(run.pid) &&
    nullableNumber(run.parentPidAtEnd);
  return valid
    ? {ok: true, run: value as DraftsScanRun}
    : {ok: false, reason: 'not a drafts scan run record'};
}

export type DraftsScanRunsRead =
  /** No log yet: no scan has ever recorded a run here. */
  | {kind: 'missing'; path: string}
  /** The file exists and could not be read, or a line in it is not a record. */
  | {kind: 'unreadable'; path: string; reason: string}
  | {kind: 'read'; path: string; runs: DraftsScanRun[]};

/**
 * Every run, in file order. A malformed line makes the whole read unreadable
 * (rule 7): the verdict is then unknown, never a clean one built on the lines
 * that happened to parse.
 */
export function readDraftsScanRuns(env: Env = process.env): DraftsScanRunsRead {
  const path = draftsScanRunsPath(env);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as {code?: unknown}).code === 'ENOENT') {
      return {kind: 'missing', path};
    }
    return {
      kind: 'unreadable',
      path,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  const runs: DraftsScanRun[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (line.trim() === '') continue;
    const parsed = parseDraftsScanRun(line);
    if (!parsed.ok) {
      return {
        kind: 'unreadable',
        path,
        reason: `line ${index + 1}: ${parsed.reason}`,
      };
    }
    runs.push(parsed.run);
  }
  return {kind: 'read', path, runs};
}
