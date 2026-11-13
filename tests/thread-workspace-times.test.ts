/**
 * The workspace description's times line (home-base-1rxt0.8 D2). Every Date
 * is built with the local-time constructor, so "today" and the printed hours
 * are the same in any time zone the suite runs in.
 */

import type {MessageLine} from '../src/thread/message-log';

import {describe, expect, test} from 'bun:test';
import {writeFileSync} from 'fs';
import {join} from 'path';

import {ICON_LAST, ICON_STARTED} from '../src/session-glyphs';
import {readMessageLogAt} from '../src/thread/message-log';
import {
  formatClockTime,
  formatMonthDay,
  formatTimesLine,
  sessionTimesFromLog,
  sessionTimesOf,
  TIMES_LINE,
  UNKNOWN_TIME,
} from '../src/thread/workspace-times';
import {createSandbox} from './sandbox';

const S = ICON_STARTED;
const L = ICON_LAST;

/** 2026-11-12 at h:m, local time; the month index is 0-based. */
const nov = (day: number, hour: number, minute = 0): Date =>
  new Date(2026, 10, day, hour, minute);

const NOW = nov(12, 18, 5);
const dated = {compactToday: false, now: NOW};
const compact = {compactToday: true, now: NOW};

describe('formatClockTime: 12-hour, a/p, no ":00", no leading zero', () => {
  test.each([
    [nov(12, 0, 0), '12a'],
    [nov(12, 0, 30), '12:30a'],
    [nov(12, 9, 0), '9a'],
    [nov(12, 9, 5), '9:05a'],
    [nov(12, 10, 0), '10a'],
    [nov(12, 11, 59), '11:59a'],
    [nov(12, 12, 0), '12p'],
    [nov(12, 13, 7), '1:07p'],
    [nov(12, 15, 30), '3:30p'],
    [nov(12, 23, 59), '11:59p'],
  ])('%s is %s', (when, text) => {
    expect(formatClockTime(when)).toBe(text);
  });

  test('seconds are dropped, never rounded up to the next minute', () => {
    expect(formatClockTime(new Date(2026, 10, 12, 15, 30, 59))).toBe('3:30p');
  });
});

describe('formatMonthDay: M/D, no leading zeros, no year', () => {
  test.each([
    [new Date(2026, 0, 5, 9), '1/5'],
    [new Date(2026, 10, 4, 9), '11/4'],
    [new Date(2026, 11, 31, 23), '12/31'],
    [new Date(2027, 1, 1, 0), '2/1'],
  ])('%s is %s', (when, text) => {
    expect(formatMonthDay(when)).toBe(text);
  });
});

describe('formatTimesLine, as built now (always dated)', () => {
  test('last activity today: both values carry date and time', () => {
    expect(
      formatTimesLine(
        {lastActiveAt: nov(12, 15, 30), startedAt: nov(12, 10)},
        dated,
      ),
    ).toBe(`${S} 11/12 10a  ${L} 11/12 3:30p`);
  });

  test('last activity not today: both values are dates only', () => {
    expect(
      formatTimesLine(
        {lastActiveAt: nov(10, 16), startedAt: nov(4, 9, 15)},
        dated,
      ),
    ).toBe(`${S} 11/4  ${L} 11/10`);
  });

  test('started on an earlier day, active today: the start keeps its own date', () => {
    expect(
      formatTimesLine(
        {lastActiveAt: nov(12, 12), startedAt: nov(4, 9, 5)},
        dated,
      ),
    ).toBe(`${S} 11/4 9:05a  ${L} 11/12 12p`);
  });

  test('one minute before midnight is not today one minute after it', () => {
    const justAfter = {compactToday: false, now: nov(12, 0, 1)};
    expect(
      formatTimesLine(
        {lastActiveAt: nov(11, 23, 59), startedAt: nov(11, 22)},
        justAfter,
      ),
    ).toBe(`${S} 11/11  ${L} 11/11`);
    expect(
      formatTimesLine(
        {lastActiveAt: nov(12, 0, 0), startedAt: nov(11, 22)},
        justAfter,
      ),
    ).toBe(`${S} 11/11 10p  ${L} 11/12 12a`);
  });

  test('a value that is not known is an em dash, never a made-up time', () => {
    expect(formatTimesLine({lastActiveAt: null, startedAt: null}, dated)).toBe(
      `${S} ${UNKNOWN_TIME}  ${L} ${UNKNOWN_TIME}`,
    );
    expect(
      formatTimesLine({lastActiveAt: nov(12, 15, 30), startedAt: null}, dated),
    ).toBe(`${S} —  ${L} 11/12 3:30p`);
    expect(
      formatTimesLine({lastActiveAt: null, startedAt: nov(4, 9)}, dated),
    ).toBe(`${S} 11/4  ${L} —`);
  });

  test('the glyphs are the statusline codepoints, one character each', () => {
    const line = formatTimesLine(
      {lastActiveAt: nov(12, 15, 30), startedAt: nov(12, 10)},
      dated,
    );
    expect(line.codePointAt(0)).toBe(0xf017);
    expect([...line]).toContain(String.fromCodePoint(0xf075));
  });
});

describe('formatTimesLine, the later compact form (one parameter)', () => {
  test('a last-active time that is today drops its date', () => {
    expect(
      formatTimesLine(
        {lastActiveAt: nov(12, 15, 30), startedAt: nov(12, 10)},
        compact,
      ),
    ).toBe(`${S} 11/12 10a  ${L} 3:30p`);
  });

  test('a last-active time that is not today is unchanged', () => {
    expect(
      formatTimesLine(
        {lastActiveAt: nov(10, 16), startedAt: nov(4, 9)},
        compact,
      ),
    ).toBe(`${S} 11/4  ${L} 11/10`);
  });
});

describe('TIMES_LINE recognises exactly what the formatter writes', () => {
  const cases: [string, Parameters<typeof formatTimesLine>[0]][] = [
    ['today', {lastActiveAt: nov(12, 15, 30), startedAt: nov(12, 10)}],
    ['not today', {lastActiveAt: nov(10, 16), startedAt: nov(4, 9)}],
    ['an earlier start', {lastActiveAt: nov(12, 12), startedAt: nov(4, 9, 5)}],
    ['midnight and noon', {lastActiveAt: nov(12, 12), startedAt: nov(12, 0)}],
    ['nothing known', {lastActiveAt: null, startedAt: null}],
    ['no start known', {lastActiveAt: nov(12, 1, 1), startedAt: null}],
  ];

  test.each(cases)('the dated form: %s', (_why, times) => {
    expect(TIMES_LINE.test(formatTimesLine(times, dated))).toBe(true);
  });

  test.each(cases)('the compact form: %s', (_why, times) => {
    expect(TIMES_LINE.test(formatTimesLine(times, compact))).toBe(true);
  });

  test.each([
    ['ordinary emoji in place of the glyphs', '🕐 11/12 10a  💬 11/12 3:30p'],
    ['words after it', `${S} 11/12 10a  ${L} 11/12 3:30p call Bob`],
    ['one space between the halves', `${S} 11/12 10a ${L} 11/12 3:30p`],
    ['":00", which the tool never writes', `${S} 11/12 10:00a  ${L} 3:30p`],
    ['a leading zero', `${S} 11/04  ${L} 11/10`],
    ['"am" rather than "a"', `${S} 11/12 10am  ${L} 11/12 3:30pm`],
    ['a year', `${S} 11/4/2026  ${L} 11/10`],
    ['a time-only start', `${S} 10a  ${L} 3:30p`],
    ['the glyphs swapped', `${L} 11/4  ${S} 11/10`],
    ['a note of his own after the clock', `${S} started on Monday`],
  ])('not his text with %s', (_why, line) => {
    expect(TIMES_LINE.test(line)).toBe(false);
  });
});

describe('the times of a message log', () => {
  const line = (role: MessageLine['role'], at: string | null): MessageLine => ({
    at,
    cwd: null,
    event: 'backfill',
    role,
    text: 'x',
  });

  test('the earliest user line, and the newest line of either role', () => {
    expect(
      sessionTimesOf([
        line('assistant', '2026-11-12T17:00:00.000Z'),
        line('user', '2026-11-12T18:00:00.000Z'),
        // A queued prompt carries the moment it was sent, which can be earlier
        // than the line above it.
        line('user', '2026-11-12T17:30:00.000Z'),
        line('assistant', '2026-11-12T23:30:00.000Z'),
        line('user', '2026-11-12T23:00:00.000Z'),
      ]),
    ).toEqual({
      lastActiveAt: new Date('2026-11-12T23:30:00.000Z'),
      startedAt: new Date('2026-11-12T17:30:00.000Z'),
    });
  });

  test('a line with no usable time is skipped, never read as a time', () => {
    expect(
      sessionTimesOf([
        line('user', null),
        line('user', 'not a time'),
        line('assistant', '2026-11-12T17:00:00.000Z'),
      ]),
    ).toEqual({
      lastActiveAt: new Date('2026-11-12T17:00:00.000Z'),
      startedAt: null,
    });
    expect(sessionTimesOf([])).toEqual({lastActiveAt: null, startedAt: null});
  });

  test('a real log file: missing is measured (no times), unreadable fails', () => {
    const sb = createSandbox();
    try {
      const path = join(sb.path, 'log.jsonl');
      expect(sessionTimesFromLog(readMessageLogAt(path))).toEqual({
        kind: 'read',
        times: {lastActiveAt: null, startedAt: null},
      });
      writeFileSync(
        path,
        [
          JSON.stringify(line('user', '2026-11-12T18:00:00.000Z')),
          JSON.stringify(line('assistant', '2026-11-12T18:05:00.000Z')),
          '',
        ].join('\n'),
      );
      expect(sessionTimesFromLog(readMessageLogAt(path))).toEqual({
        kind: 'read',
        times: {
          lastActiveAt: new Date('2026-11-12T18:05:00.000Z'),
          startedAt: new Date('2026-11-12T18:00:00.000Z'),
        },
      });
      // A directory where the log should be cannot be read as one.
      const unreadable = sessionTimesFromLog(readMessageLogAt(sb.path));
      expect(unreadable.kind).toBe('failed');
    } finally {
      sb.cleanup();
    }
  });
});
