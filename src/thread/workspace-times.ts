/**
 * The times line of the cmux workspace description (home-base-1rxt0.8): when
 * the session started and when it was last active, as absolute times (D1:
 * never relative, because nothing rewrites the line every minute).
 *
 *   <clock> 11/12 10a  <comment> 11/12 3:30p    last activity is today
 *   <clock> 11/4  <comment> 11/10               last activity is not today
 *
 * D2, AS BUILT: ALWAYS DATED. Nothing rewrites the line at midnight (D4: cmux
 * refuses the chores launchd agent), so a time-only "3:30p" written today
 * would still read as today tomorrow. A line written in the first form stays
 * true tomorrow; it is only more precise than the second. The compact form,
 * `<comment> 3:30p` with no date when today, is `compactToday: true`, for when
 * a midnight rewrite exists.
 *
 * Times are 12-hour with a/p and no ":00" (10a, 3:30p). Dates are M/D, no
 * leading zeros, no year. "Today" is the Mac's local date. A value that is not
 * known is the statusline's em dash, never a made-up time (critical rule 7).
 */

import type {MessageLine, MessageLogRead} from './message-log';

import {ICON_LAST, ICON_STARTED} from '../session-glyphs';

/** The statusline's mark for a value that could not be measured. */
export const UNKNOWN_TIME = '—';

export interface SessionTimes {
  /** The session's newest message from either side; null when none has a time. */
  lastActiveAt: Date | null;
  /** The session's first user message; null when none has a time. */
  startedAt: Date | null;
}

export interface TimesLineOptions {
  /**
   * False now (D2): a last-active time that is today still carries its date.
   * True is the compact form (`<comment> 3:30p`), safe only once something
   * rewrites the line after midnight (D4).
   */
  compactToday: boolean;
  /** The clock, injected so tests can pin "today". */
  now: Date;
}

/** "11/12": M/D in local time, no leading zeros, no year. */
export function formatMonthDay(when: Date): string {
  return `${when.getMonth() + 1}/${when.getDate()}`;
}

/** "10a", "3:30p", "12p": 12-hour local time, a/p, no ":00". */
export function formatClockTime(when: Date): string {
  const hours = when.getHours();
  const minutes = when.getMinutes();
  const hour = hours % 12 === 0 ? 12 : hours % 12;
  const suffix = hours < 12 ? 'a' : 'p';
  return minutes === 0
    ? `${hour}${suffix}`
    : `${hour}:${String(minutes).padStart(2, '0')}${suffix}`;
}

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * The whole line. When the last activity is today both values carry date and
 * time; otherwise both are dates only (D2).
 */
export function formatTimesLine(
  times: SessionTimes,
  options: TimesLineOptions,
): string {
  const {lastActiveAt, startedAt} = times;
  const withTime =
    lastActiveAt != null && sameLocalDay(lastActiveAt, options.now);
  const dated = (when: Date): string =>
    withTime
      ? `${formatMonthDay(when)} ${formatClockTime(when)}`
      : formatMonthDay(when);
  const started = startedAt == null ? UNKNOWN_TIME : dated(startedAt);
  const last =
    lastActiveAt == null
      ? UNKNOWN_TIME
      : withTime && options.compactToday
        ? formatClockTime(lastActiveAt)
        : dated(lastActiveAt);
  return `${ICON_STARTED} ${started}  ${ICON_LAST} ${last}`;
}

const DATE = String.raw`(?:[1-9]|1[0-2])/(?:[1-9]|[12]\d|3[01])`;
const TIME = String.raw`(?:[1-9]|1[0-2])(?::(?!00)[0-5]\d)?[ap]`;
const STARTED_VALUE = `(?:${DATE}(?: ${TIME})?|${UNKNOWN_TIME})`;
/** The last-active value may also be time-only: the compact form. */
const LAST_VALUE = `(?:${DATE}(?: ${TIME})?|${TIME}|${UNKNOWN_TIME})`;

/**
 * Only a line `formatTimesLine` can write, in either form (D3). The workspace
 * description is the tool's only while every line is one it writes, so a
 * line Justin typed, however close, keeps the whole description his.
 */
export const TIMES_LINE = new RegExp(
  `^${ICON_STARTED} ${STARTED_VALUE}  ${ICON_LAST} ${LAST_VALUE}$`,
  'u',
);

function lineDate(line: MessageLine): Date | null {
  if (line.at == null) return null;
  const ms = Date.parse(line.at);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/**
 * The two times from a session's message log lines: the earliest user line
 * and the newest line of either role. Lines with no usable `at` are skipped,
 * never read as a time.
 */
export function sessionTimesOf(lines: readonly MessageLine[]): SessionTimes {
  let startedAt: Date | null = null;
  let lastActiveAt: Date | null = null;
  for (const line of lines) {
    const at = lineDate(line);
    if (at == null) continue;
    if (line.role === 'user' && (startedAt == null || at < startedAt)) {
      startedAt = at;
    }
    if (lastActiveAt == null || at > lastActiveAt) lastActiveAt = at;
  }
  return {lastActiveAt, startedAt};
}

export type SessionTimesRead =
  | {kind: 'failed'; reason: string}
  | {kind: 'read'; times: SessionTimes};

/**
 * One session's times from its message log. A missing log is measured: the
 * session has no recorded message, so both values are unknown. A log that
 * could not be read is `failed`, and the description is left as it was.
 */
export function sessionTimesFromLog(read: MessageLogRead): SessionTimesRead {
  if (read.kind === 'failed') {
    return {
      kind: 'failed',
      reason: `the message log ${read.path} could not be read: ${read.error}`,
    };
  }
  if (read.kind === 'missing') {
    return {kind: 'read', times: {lastActiveAt: null, startedAt: null}};
  }
  return {kind: 'read', times: sessionTimesOf(read.lines)};
}
