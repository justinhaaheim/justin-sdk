/**
 * The pacing rule's decision table (home-base-jm5kg.17): ok, warn, hold, each
 * margin at its edge, a window that just reset, and every way it is unknown.
 * Pure: no files, no clock.
 */

import type {OkSample, SamplesRead} from '../src/claude-usage-samples';

import {describe, expect, test} from 'bun:test';

import {PACING_DEFAULTS} from '../src/thread/defaults';
import {
  computePace,
  describePace,
  paceFromSamples,
  paceGapText,
  type PaceKnown,
  type PaceRead,
  WEEK_WINDOW_MS,
} from '../src/thread/pacing';

const RESET = '2030-01-05T23:00:00.000Z';
const RESET_MS = Date.parse(RESET);
const HOUR_MS = 60 * 60 * 1000;

/** The moment `elapsedPercent` of the week has passed. */
function at(elapsedPercent: number): number {
  return RESET_MS - WEEK_WINDOW_MS * (1 - elapsedPercent / 100);
}

function known(read: PaceRead): PaceKnown {
  if (read.kind !== 'known') throw new Error(`unknown: ${read.reason}`);
  return read;
}

function reasonOf(read: PaceRead): string {
  if (read.kind !== 'unknown') throw new Error(`known: ${read.verdict}`);
  return read.reason;
}

describe('computePace: the verdict', () => {
  test('ok: exactly on an even pace', () => {
    const pace = known(
      computePace({nowMs: at(50), resetsAt: RESET, weekPercent: 50}),
    );
    expect(pace.verdict).toBe('ok');
    expect(pace.evenPercent).toBe(50);
    expect(pace.pointsAhead).toBe(0);
    expect(pace.weekPercent).toBe(50);
    expect(pace.resetsAt).toBe(RESET);
    expect(pace.readAt).toBe(new Date(at(50)).toISOString());
  });

  test('ok: behind an even pace is a negative number, not zero', () => {
    const pace = known(
      computePace({nowMs: at(50), resetsAt: RESET, weekPercent: 20}),
    );
    expect(pace.verdict).toBe('ok');
    expect(pace.pointsAhead).toBe(-30);
  });

  test('his example: 85 % on Monday 3pm, with the reset on Saturday 3pm, is hold', () => {
    const pace = known(
      computePace({
        nowMs: RESET_MS - 5 * 24 * HOUR_MS,
        resetsAt: RESET,
        weekPercent: 85,
      }),
    );
    expect(pace.verdict).toBe('hold');
    expect(pace.evenPercent).toBeCloseTo((2 / 7) * 100, 6);
    expect(pace.pointsAhead).toBeCloseTo(85 - (2 / 7) * 100, 6);
  });

  test.each([
    {verdict: 'ok', week: 59},
    {verdict: 'ok', week: 60},
    {verdict: 'warn', week: 61},
    {verdict: 'warn', week: 74},
    {verdict: 'warn', week: 75},
    {verdict: 'hold', week: 76},
    {verdict: 'hold', week: 100},
  ])('half way through the week, $week used is $verdict', ({verdict, week}) => {
    expect(
      known(computePace({nowMs: at(50), resetsAt: RESET, weekPercent: week}))
        .verdict,
    ).toBe(verdict as PaceKnown['verdict']);
  });

  test('the margins are the placeholders the bead names: warn above 10, hold above 25', () => {
    expect(PACING_DEFAULTS).toEqual({holdPointsAhead: 25, warnPointsAhead: 10});
  });

  test('margins and the window length are inputs', () => {
    const margins = {holdPointsAhead: 3, warnPointsAhead: 1};
    const pace = known(
      computePace({
        margins,
        nowMs: RESET_MS - 2.5 * HOUR_MS,
        resetsAt: RESET,
        weekPercent: 54,
        windowMs: 5 * HOUR_MS,
      }),
    );
    expect(pace.evenPercent).toBe(50);
    expect(pace.verdict).toBe('hold');
    expect(pace.margins).toEqual(margins);
  });
});

describe('computePace: the ends of a window', () => {
  test('a window that just reset: 0 % a minute in is ok', () => {
    const pace = known(
      computePace({
        nowMs: RESET_MS - WEEK_WINDOW_MS + 60_000,
        resetsAt: RESET,
        weekPercent: 0,
      }),
    );
    expect(pace.verdict).toBe('ok');
    expect(pace.evenPercent).toBeCloseTo(0.0099, 3);
  });

  test('a window that just reset: its first hour can still be ahead', () => {
    const pace = known(
      computePace({
        nowMs: RESET_MS - WEEK_WINDOW_MS + HOUR_MS,
        resetsAt: RESET,
        weekPercent: 12,
      }),
    );
    expect(pace.verdict).toBe('warn');
  });

  test('a reset a minute more than a window away is the very start, not unknown (the panel jitters)', () => {
    const pace = known(
      computePace({
        nowMs: RESET_MS - WEEK_WINDOW_MS - 60_000,
        resetsAt: RESET,
        weekPercent: 1,
      }),
    );
    expect(pace.evenPercent).toBe(0);
    expect(pace.pointsAhead).toBe(1);
  });

  test('the last millisecond of a week is known', () => {
    const pace = known(
      computePace({nowMs: RESET_MS - 1, resetsAt: RESET, weekPercent: 100}),
    );
    expect(pace.verdict).toBe('ok');
    expect(pace.evenPercent).toBeCloseTo(100, 6);
  });
});

describe('computePace: unknown is never a number', () => {
  test.each([
    {
      name: 'no reset, with the sample’s own reason',
      part: 'the panel line carries no resets clause',
      read: computePace({
        nowMs: at(50),
        resetsAt: null,
        resetsAtError: 'the panel line carries no resets clause',
        weekPercent: 50,
      }),
    },
    {
      name: 'no reset, with no reason',
      part: 'no reason recorded',
      read: computePace({nowMs: at(50), resetsAt: null, weekPercent: 50}),
    },
    {
      name: 'a reset that is not a time',
      part: '"soon" is not a time',
      read: computePace({nowMs: at(50), resetsAt: 'soon', weekPercent: 50}),
    },
    {
      name: 'a reset exactly at the reading',
      part: 'before the reading',
      read: computePace({nowMs: RESET_MS, resetsAt: RESET, weekPercent: 50}),
    },
    {
      name: 'a reset before the reading',
      part: 'before the reading',
      read: computePace({
        nowMs: RESET_MS + HOUR_MS,
        resetsAt: RESET,
        weekPercent: 50,
      }),
    },
    {
      name: 'a reset far more than a window away',
      part: 'more than one window away',
      read: computePace({
        nowMs: RESET_MS - WEEK_WINDOW_MS - 2 * HOUR_MS,
        resetsAt: RESET,
        weekPercent: 50,
      }),
    },
    {
      name: 'a percent that is not a number',
      part: 'is not a percentage',
      read: computePace({nowMs: at(50), resetsAt: RESET, weekPercent: NaN}),
    },
    {
      name: 'a negative percent',
      part: 'is not a percentage',
      read: computePace({nowMs: at(50), resetsAt: RESET, weekPercent: -1}),
    },
    {
      name: 'a reading with no time',
      part: 'is not a time',
      read: computePace({nowMs: NaN, resetsAt: RESET, weekPercent: 50}),
    },
    {
      name: 'a window of no length',
      part: 'is not a length',
      read: computePace({
        nowMs: at(50),
        resetsAt: RESET,
        weekPercent: 50,
        windowMs: 0,
      }),
    },
  ])('$name', ({part, read}) => {
    expect(reasonOf(read)).toContain(part);
    expect(Object.keys(read).sort()).toEqual(['kind', 'reason']);
  });
});

function sample(input: {
  fable?: number;
  resetsAt?: string | null;
  sampledMs: number;
  week: number;
}): OkSample {
  const resetsAt = input.resetsAt === undefined ? RESET : input.resetsAt;
  const window = (pct: number) => ({
    pct,
    resetsAt,
    resetsAtError: resetsAt == null ? 'no resets clause' : null,
    resetsText: null,
  });
  return {
    ok: true,
    raw: 'panel',
    sampledAt: new Date(input.sampledMs).toISOString(),
    schema: 1,
    session: null,
    week: window(input.week),
    weekByModel: input.fable == null ? {} : {Fable: window(input.fable)},
  };
}

function history(...samples: OkSample[]): SamplesRead {
  return {
    kind: 'ok',
    lastLineUnreadable: false,
    path: '/fake/samples.jsonl',
    samples,
    unreadable: [],
  };
}

describe('paceFromSamples', () => {
  const NOW = new Date(at(50));

  test('the newest sample decides', () => {
    const older = sample({sampledMs: NOW.getTime() - HOUR_MS, week: 99});
    const newer = sample({sampledMs: NOW.getTime(), week: 50});
    expect(
      known(paceFromSamples(history(older, newer), {now: NOW})).verdict,
    ).toBe('ok');
  });

  test('the even pace is taken when the percent was read, not at the wall clock', () => {
    // Read at 50 % elapsed with 60 % used: exactly 10 ahead, then. Two hours
    // later the wall clock's share is 1.2 points higher, which must not flatter it.
    const read = history(sample({sampledMs: at(50), week: 61}));
    const later = new Date(at(50) + 2 * HOUR_MS);
    const pace = known(paceFromSamples(read, {now: later}));
    expect(pace.evenPercent).toBe(50);
    expect(pace.pointsAhead).toBe(11);
    expect(pace.verdict).toBe('warn');
  });

  test('a per-model week has no say: the rule is one account-wide comparison', () => {
    const read = history(
      sample({fable: 100, sampledMs: NOW.getTime(), week: 50}),
    );
    expect(known(paceFromSamples(read, {now: NOW})).verdict).toBe('ok');
  });

  test('margins pass through', () => {
    const read = history(sample({sampledMs: NOW.getTime(), week: 52}));
    const margins = {holdPointsAhead: 5, warnPointsAhead: 1};
    expect(known(paceFromSamples(read, {margins, now: NOW})).verdict).toBe(
      'warn',
    );
  });

  test('unknown: a failed newest read, with its reason, even with a good one before it', () => {
    const read: SamplesRead = {
      kind: 'ok',
      lastLineUnreadable: false,
      path: '/fake/samples.jsonl',
      samples: [
        sample({sampledMs: NOW.getTime() - HOUR_MS, week: 50}),
        {
          ok: false,
          reason: 'claude -p /usage exited 3',
          sampledAt: NOW.toISOString(),
          schema: 1,
        },
      ],
      unreadable: [],
    };
    const pace = paceFromSamples(read, {now: NOW});
    expect(reasonOf(pace)).toContain('claude -p /usage exited 3');
    expect(Object.keys(pace).sort()).toEqual(['kind', 'reason']);
  });

  test('unknown: a stale read past the limit, known at the limit', () => {
    const minute = 60_000;
    const read = history(sample({sampledMs: NOW.getTime(), week: 50}));
    expect(
      paceFromSamples(read, {
        now: new Date(NOW.getTime() + 150 * minute),
      }).kind,
    ).toBe('known');
    const stale = paceFromSamples(read, {
      now: new Date(NOW.getTime() + 151 * minute),
    });
    expect(reasonOf(stale)).toContain('151 minutes old');
    expect(
      paceFromSamples(read, {
        maxSampleAgeMinutes: 30,
        now: new Date(NOW.getTime() + 31 * minute),
      }).kind,
    ).toBe('unknown');
  });

  test('unknown: a read dated in the future', () => {
    const read = history(
      sample({sampledMs: NOW.getTime() + 6 * 60_000, week: 50}),
    );
    expect(reasonOf(paceFromSamples(read, {now: NOW}))).toContain(
      'in the future',
    );
  });

  test('unknown: a missing reset, with the sample’s reason', () => {
    const read = history(
      sample({resetsAt: null, sampledMs: NOW.getTime(), week: 50}),
    );
    expect(reasonOf(paceFromSamples(read, {now: NOW}))).toContain(
      'no resets clause',
    );
  });

  test('unknown: the sample’s week has since reset, so it says nothing about this one', () => {
    const read = history(sample({sampledMs: RESET_MS - 60_000, week: 95}));
    const pace = paceFromSamples(read, {now: new Date(RESET_MS + 60_000)});
    expect(reasonOf(pace)).toContain('no reading of the new week yet');
  });

  test.each<{name: string; part: string; read: SamplesRead}>([
    {
      name: 'no history',
      part: 'no usage history',
      read: {kind: 'missing', path: '/fake/samples.jsonl'},
    },
    {
      name: 'an unreadable history',
      part: 'EACCES',
      read: {kind: 'failed', path: '/fake/samples.jsonl', reason: 'EACCES'},
    },
    {
      name: 'an unreadable last line',
      part: 'an older sample is not used',
      read: {
        kind: 'ok',
        lastLineUnreadable: true,
        path: '/fake/samples.jsonl',
        samples: [],
        unreadable: [{line: 9, reason: 'not JSON'}],
      },
    },
    {
      name: 'a history with no samples',
      part: 'holds no readable sample',
      read: {
        kind: 'ok',
        lastLineUnreadable: false,
        path: '/fake/samples.jsonl',
        samples: [],
        unreadable: [],
      },
    },
  ])('unknown: $name', ({part, read}) => {
    expect(reasonOf(paceFromSamples(read, {now: NOW}))).toContain(part);
  });
});

describe('the words', () => {
  test('ahead and behind read as what they are', () => {
    expect(paceGapText(22)).toBe('22.0 points ahead of an even pace');
    expect(paceGapText(-43.74)).toBe('43.7 points behind an even pace');
    expect(paceGapText(0)).toBe('0.0 points ahead of an even pace');
  });

  test('describePace carries every number', () => {
    const pace = known(
      computePace({nowMs: at(50), resetsAt: RESET, weekPercent: 80}),
    );
    expect(describePace(pace)).toBe(
      'the week is at 80 % with 50.0 % of it elapsed since the reset: 30.0 points ahead of an even pace (warn above 10, hold above 25)',
    );
  });
});
