/**
 * drafts-scan-health — is the hourly unsent-drafts scan working? The verdict
 * the chores board shows for it (home-base-fmf1n D6). Read-only: it reads the
 * scan's run log, the capture log and the sessions index, and writes nothing.
 *
 * HOOK-STARTED RUNS ONLY. The log also holds scans typed by hand (trigger
 * manual), and the threads dashboard runs one before it loads. Those are not
 * judged: a manual scan refused by the Claude Code sandbox says nothing about
 * the hook, and a manual scan that worked does not prove the hook works.
 *
 * THE VERDICT, in order, over the hook-started runs:
 *   - The run log cannot be read: unknown.
 *   - The last two hook runs, or more, were all not `scanned`: failed, since
 *     the first of that unbroken run of failures, with the last one's error.
 *   - home-base Claude Code sessions were active in at least two whole
 *     wall-clock hours after the last hook run started, whatever its outcome,
 *     and no hook run followed: failed. Activity is a capture.jsonl record
 *     (one per capture-hook run) whose session the sessions index places in
 *     home-base. An hour counts once it has ended, so a scan still running
 *     this hour is never missed.
 *   - Otherwise ok, saying when the last hook scan ran. When that scan failed
 *     (and the one before it did not), ok names the failure and says the next
 *     scan decides.
 *
 * ONE FAILED SCAN IS TOLERATED (home-base-fmf1n.1). A single scan fails when
 * the Mac is overloaded: on 2026-11-15 at 03:00, with load 196 on 14 cores,
 * `cmux tree` timed out after 30 s, and the next hour's scan normally works.
 * The watched launchd agents tolerate one missed run for the same reason.
 *
 * IDLE TIME NEVER ALARMS: no activity means nothing was there to scan.
 * Justin, 2026-11-12: "An alert that I quickly learn to just ignore is not a
 * good alert." Two hours, not one, so a single hour whose only activity came
 * from a session outside cmux (which never claims) is not an alert.
 */

import {readFileSync} from 'fs';

import {captureRunLogPath} from './archive';
import {
  type DraftsScanRun,
  hourLabel,
  readDraftsScanRuns,
} from './drafts-scan-runs';
import {readSessionIndex} from './session-index';

type Env = Record<string, string | undefined>;

export type DraftsScanHealth =
  | {detail: string; kind: 'ok'}
  | {kind: 'failed'; reason: string; since: Date | null}
  | {kind: 'unknown'; reason: string};

/** Active whole hours with no run after the last one before it fails (D6). */
export const ACTIVE_HOURS_BEFORE_ALERT = 2;

/** Failed hook runs in a row that still read ok (home-base-fmf1n.1). */
export const FAILED_RUNS_TOLERATED = 1;

/** With no run recorded at all, how far back activity is looked for. */
export const NO_RUN_LOOKBACK_HOURS = 48;

/** The repo whose sessions run the hook. */
export const DRAFTS_SCAN_REPO = 'home-base';

function stamp(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    month: '2-digit',
    timeZone,
    year: 'numeric',
  }).formatToParts(instant);
  const part = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? '??';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
}

/** `2026-11-15T09` → `2026-11-15 09:00`, for messages. */
function hourWords(label: string): string {
  return `${label.replace('T', ' ')}:00`;
}

function describeRun(run: DraftsScanRun, timeZone: string): string {
  return `${stamp(new Date(run.startedAt), timeZone)} (${run.trigger === 'hook' ? 'started by the hourly hook' : 'run by hand'})`;
}

/** `ended unreachable: <error>`, for a run that was not scanned. */
function describeEnding(run: DraftsScanRun): string {
  return `ended ${run.outcome}${run.error == null ? '' : `: ${run.error}`}`;
}

type Activity =
  | {firstAt: Date | null; hours: string[]; kind: 'read'}
  | {kind: 'unknown'; reason: string};

/**
 * The whole hours, after `afterLabel` and before `nowLabel`, in which a
 * session of `repo` was active. Sorted. `unknown` when the evidence could not
 * be read, never an empty list (rule 7).
 */
function activeHours(args: {
  afterLabel: string;
  env: Env;
  nowLabel: string;
  repo: string;
  timeZone: string;
}): Activity {
  const path = captureRunLogPath(args.env);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as {code?: unknown}).code === 'ENOENT') {
      return {firstAt: null, hours: [], kind: 'read'};
    }
    return {
      kind: 'unknown',
      reason: `the capture log ${path} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  // Capture records in the window, by session. A malformed line is skipped:
  // many detached children append to this file, and a torn line is not
  // evidence either way.
  const inWindow: {at: Date; label: string; sessionId: string}[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (value == null || typeof value !== 'object') continue;
    const record = value as {at?: unknown; sessionId?: unknown};
    if (typeof record.at !== 'string' || typeof record.sessionId !== 'string') {
      continue;
    }
    const at = new Date(record.at);
    if (Number.isNaN(at.getTime())) continue;
    const label = hourLabel(at, args.timeZone);
    if (label <= args.afterLabel || label >= args.nowLabel) continue;
    inWindow.push({at, label, sessionId: record.sessionId});
  }
  if (inWindow.length === 0) return {firstAt: null, hours: [], kind: 'read'};

  const index = readSessionIndex(args.env);
  if (index.kind !== 'read') {
    return {
      kind: 'unknown',
      reason:
        index.kind === 'failed'
          ? `the sessions index ${index.path} could not be read (${index.error}), so which sessions were ${args.repo}'s is unknown`
          : `there is no sessions index at ${index.path}, so which sessions were ${args.repo}'s is unknown`,
    };
  }
  const repoSessions = new Set(
    index.sessions
      .filter((session) =>
        session.sightings.some((sighting) => sighting.repo === args.repo),
      )
      .map((session) => session.sessionId),
  );
  const hours = new Set<string>();
  let firstAt: Date | null = null;
  for (const record of inWindow) {
    if (!repoSessions.has(record.sessionId)) continue;
    hours.add(record.label);
    if (firstAt == null || record.at < firstAt) firstAt = record.at;
  }
  return {firstAt, hours: [...hours].sort(), kind: 'read'};
}

/** The verdict (D6). Never throws for unreadable evidence: that is `unknown`. */
export function draftsScanHealth(args: {
  env?: Env;
  now: Date;
  repo?: string;
  timeZone: string;
}): DraftsScanHealth {
  const env = args.env ?? process.env;
  const repo = args.repo ?? DRAFTS_SCAN_REPO;
  const read = readDraftsScanRuns(env);
  if (read.kind === 'unreadable') {
    return {
      kind: 'unknown',
      reason: `the drafts scan run log ${read.path} could not be read: ${read.reason}`,
    };
  }
  // Hook-started runs only: see HOOK-STARTED RUNS ONLY above.
  const runs = (read.kind === 'read' ? read.runs : []).filter(
    (run) => run.trigger === 'hook',
  );
  const last = runs.at(-1) ?? null;

  // The unbroken run of non-scanned hook runs at the end: its length, and its
  // first run, which is `since` when it fails.
  let failedInARow = 0;
  let firstBad: DraftsScanRun | null = null;
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index];
    if (run == null || run.outcome === 'scanned') break;
    failedInARow += 1;
    firstBad = run;
  }
  if (
    last != null &&
    firstBad != null &&
    failedInARow > FAILED_RUNS_TOLERATED
  ) {
    return {
      kind: 'failed',
      reason: `${failedInARow} drafts scans in a row failed, and only one is tolerated; the last, ${describeRun(last, args.timeZone)}, ${describeEnding(last)}`,
      since: new Date(firstBad.startedAt),
    };
  }
  // A single failed hook run (the one before it scanned, or there is none):
  // tolerated, but the activity rule below still counts from it.
  const tolerated = last != null && last.outcome !== 'scanned' ? last : null;

  const nowLabel = hourLabel(args.now, args.timeZone);
  const afterLabel =
    last == null
      ? hourLabel(
          new Date(
            args.now.getTime() - (NO_RUN_LOOKBACK_HOURS + 1) * 3_600_000,
          ),
          args.timeZone,
        )
      : hourLabel(new Date(last.startedAt), args.timeZone);
  const activity = activeHours({
    afterLabel,
    env,
    nowLabel,
    repo,
    timeZone: args.timeZone,
  });
  if (activity.kind === 'unknown') {
    return {kind: 'unknown', reason: activity.reason};
  }
  if (activity.hours.length >= ACTIVE_HOURS_BEFORE_ALERT) {
    const shown = activity.hours.slice(0, 3).map(hourWords).join(', ');
    const more =
      activity.hours.length > 3
        ? ` and ${activity.hours.length - 3} more hours`
        : '';
    return {
      kind: 'failed',
      reason:
        last == null
          ? `${repo} sessions were active in the hours from ${shown}${more}, but the hourly hook has started no drafts scan (none recorded in ${read.path}); it starts one from sessions inside cmux, and scans run by hand are not counted`
          : `${repo} sessions were active in the hours from ${shown}${more}, but no drafts scan ran since ${describeRun(last, args.timeZone)}${tolerated == null ? '' : `, which ${describeEnding(tolerated)}`}`,
      since: activity.firstAt,
    };
  }
  if (last == null) {
    return {
      detail: `the hourly hook has started no drafts scan yet, and no ${repo} session was active in two whole hours of the last ${NO_RUN_LOOKBACK_HOURS}`,
      kind: 'ok',
    };
  }
  if (tolerated != null) {
    return {
      // The error text comes last: it often ends with its own full stop.
      detail: `one failed scan is tolerated, and the next one decides; the last, ${describeRun(tolerated, args.timeZone)}, ${describeEnding(tolerated)}`,
      kind: 'ok',
    };
  }
  const panes =
    last.counts == null ? '' : `, ${last.counts.claudePanes} Claude panes`;
  return {
    detail: `last scan ${describeRun(last, args.timeZone)}${panes}`,
    kind: 'ok',
  };
}
