/**
 * The quota verdict (request home-base-ys9t7.5 D2–D4, D10, built by
 * home-base-ys9t7.5.2), as a table: fine, over each limit, unknown, the
 * attended grace on and off, and handoff/spawn ignoring the grace.
 */

import type {GroupSpend} from '../src/thread/quota-group';
import type {QuotaLimits} from '../src/thread/quota-knob';
import type {ProjectSpend} from '../src/thread/quota-project';
import type {SpendTotals} from '../src/thread/quota-spend';
import type {WeekReading} from '../src/thread/quota-week';

import {describe, expect, test} from 'bun:test';

import {
  type QuotaPurpose,
  type QuotaVerdict,
  quotaVerdict,
} from '../src/thread/quota-verdict';

const NOW = Date.parse('2030-01-01T12:00:00Z');
const MINUTE = 60_000;

const LIMITS: QuotaLimits = {
  attendedGraceMinutes: 30,
  chainWeekPercent: 5,
  dollarsPerWeekPercent: {fable: 12.9, opus: 32.3, other: 12.9, sonnet: 16.8},
  floorWeekPercent: 75,
  projectDayWeekPercent: 10,
};

function totals(weekPercent: number): SpendTotals {
  const zero = {usd: 0, weekPercent: 0};
  return {
    byFamily: {
      fable: {usd: weekPercent * 12.9, weekPercent},
      opus: zero,
      other: zero,
      sonnet: zero,
    },
    usd: weekPercent * 12.9,
    weekPercent,
  };
}

function group(
  weekPercent: number,
  typedMinutesAgo: number | null,
): GroupSpend {
  return {
    firstUnattendedAtMs: null,
    kind: 'known',
    latestTypedAtMs:
      typedMinutesAgo == null ? null : NOW - typedMinutesAgo * MINUTE,
    members: [],
    requests: 1,
    root: 'b-root',
    spend: totals(weekPercent),
    typed: {
      kind: 'complete',
      latestTypedAtMs:
        typedMinutesAgo == null ? null : NOW - typedMinutesAgo * MINUTE,
    },
    unparseableLines: 0,
  };
}

function project(weekPercent: number): ProjectSpend {
  return {
    cutoffMs: NOW - 24 * 60 * MINUTE,
    dirs: [],
    files: 1,
    firstCountedAtMs: null,
    kind: 'known',
    latestTypedAtMs: null,
    projectSlug: '-repo',
    requests: 1,
    spend: totals(weekPercent),
    unparseableLines: 0,
    windowStartMs: NOW - 24 * 60 * MINUTE,
  };
}

function week(
  allModels: number,
  byModel: Record<string, number> = {},
): WeekReading {
  const reading = (percent: number) => ({
    ageMinutes: 10,
    at: new Date(NOW - 10 * MINUTE).toISOString(),
    measuredBy: 'usage' as const,
    path: '/scratch/samples.jsonl',
    percent,
    sessionId: null,
    source: 'samples' as const,
  });
  return {
    allModels: reading(allModels),
    byModel: Object.fromEntries(
      Object.entries(byModel).map(([model, percent]) => [
        model,
        reading(percent),
      ]),
    ),
    kind: 'known',
    notes: [],
  };
}

const UNKNOWN_WEEK: WeekReading = {
  kind: 'unknown',
  notes: [],
  reason: 'no fresh usage sample',
};

function verdict(input: {
  group?: GroupSpend;
  project?: ProjectSpend;
  purpose?: QuotaPurpose;
  week?: WeekReading;
}): QuotaVerdict {
  return quotaVerdict({
    group: input.group ?? group(1, 60),
    limits: LIMITS,
    nowMs: NOW,
    project: input.project ?? project(2),
    purpose: input.purpose ?? 'running',
    week: input.week ?? week(40),
  });
}

/** The limits a verdict says are crossed, or its kind when none are. */
function crossed(result: QuotaVerdict): string {
  if (result.kind !== 'over') return result.kind;
  return result.over
    .map((entry) =>
      entry.limit === 'floor' ? `floor:${entry.window}` : entry.limit,
    )
    .join(',');
}

describe('quotaVerdict', () => {
  test.each([
    ['everything under its limit', {}, 'fine'],
    ['chain spend at its limit is not over', {group: group(5, 60)}, 'fine'],
    ['chain spend above its limit', {group: group(5.01, 60)}, 'chain'],
    ['project spend above its limit', {project: project(10.5)}, 'project'],
    ['the all-models week at the floor', {week: week(75)}, 'floor:week'],
    [
      'a per-model week at the floor',
      {week: week(60, {Fable: 80})},
      'floor:Fable',
    ],
    [
      'every limit at once',
      {group: group(6, 60), project: project(11), week: week(76, {Opus: 90})},
      'chain,project,floor:week,floor:Opus',
    ],
  ] as const)('%s', (_name, input, expected) => {
    expect(crossed(verdict(input))).toBe(expected);
  });

  test('the attended grace: a running session Justin typed in 10 minutes ago is not braked by the floor', () => {
    const result = verdict({group: group(1, 10), week: week(90)});
    expect(result).toEqual({attended: true, kind: 'fine'});
    // ...and an unknown week does not matter to it, because it is not read.
    expect(verdict({group: group(1, 10), week: UNKNOWN_WEEK}).kind).toBe(
      'fine',
    );
  });

  test('past the grace, or with no typed line at all, the floor applies to a running session', () => {
    expect(crossed(verdict({group: group(1, 31), week: week(90)}))).toBe(
      'floor:week',
    );
    expect(crossed(verdict({group: group(1, null), week: week(90)}))).toBe(
      'floor:week',
    );
  });

  test.each(['handoff', 'spawn'] as const)(
    'a %s ignores the grace: the floor applies even when Justin just typed',
    (purpose) => {
      expect(
        crossed(verdict({group: group(1, 1), purpose, week: week(90)})),
      ).toBe('floor:week');
    },
  );

  test('an unknown group, project or week is unknown, never fine (D10)', () => {
    const unknownGroup: GroupSpend = {
      kind: 'unknown',
      lowerBound: null,
      members: [],
      reason: 'session bead b-x: not found',
      typed: {kind: 'unknown', reason: 'the group did not resolve'},
    };
    const unknownProject: ProjectSpend = {
      kind: 'unknown',
      lowerBound: null,
      projectSlug: '-repo',
      reason: '/x could not be read',
    };
    expect(verdict({group: unknownGroup})).toEqual({
      attendance: {kind: 'unknown', reason: 'the group did not resolve'},
      kind: 'unknown',
      // An unreadable group cannot prove attendance, so the week is read too.
      reasons: ['group: session bead b-x: not found'],
    });
    expect(verdict({project: unknownProject})).toEqual({
      attendance: {kind: 'unattended', latestTypedAtMs: NOW - 60 * MINUTE},
      kind: 'unknown',
      reasons: ['project: /x could not be read'],
    });
    expect(verdict({week: UNKNOWN_WEEK})).toEqual({
      attendance: {kind: 'unattended', latestTypedAtMs: NOW - 60 * MINUTE},
      kind: 'unknown',
      reasons: ['week: no fresh usage sample'],
    });
  });

  test('a limit proven crossed wins over an unknown input, which rides along', () => {
    const result = verdict({group: group(9, 60), week: UNKNOWN_WEEK});
    expect(result).toEqual({
      attended: false,
      kind: 'over',
      over: [
        {atLeast: false, limit: 'chain', limitPercent: 5, spentPercent: 9},
      ],
      unknown: ['week: no fresh usage sample'],
    });
  });

  test('a lower bound that already crosses the limit is over, marked at least', () => {
    const partial: GroupSpend = {
      kind: 'unknown',
      lowerBound: totals(7),
      members: [],
      reason: 'no list price for claude-unreleased-9',
      typed: {kind: 'complete', latestTypedAtMs: null},
    };
    const result = verdict({group: partial});
    expect(result.kind).toBe('over');
    if (result.kind !== 'over') return;
    expect(result.over).toEqual([
      {atLeast: true, limit: 'chain', limitPercent: 5, spentPercent: 7},
    ]);
    // A lower bound under the limit proves nothing: unknown.
    expect(verdict({group: {...partial, lowerBound: totals(2)}}).kind).toBe(
      'unknown',
    );
  });

  // Dispatch 2 item 1: attendance is its own fact, read before any pricing.
  describe('attendance apart from pricing', () => {
    const unpriced = (typed: GroupSpend['typed']): GroupSpend => ({
      kind: 'unknown',
      lowerBound: totals(1),
      members: [],
      reason: 'no list price for claude-unreleased-9',
      typed,
    });

    test('an attended group with unpriced spend is unknown AND attended', () => {
      const result = verdict({
        group: unpriced({
          kind: 'complete',
          latestTypedAtMs: NOW - 5 * MINUTE,
        }),
        week: week(90),
      });
      expect(result).toEqual({
        attendance: {kind: 'attended', latestTypedAtMs: NOW - 5 * MINUTE},
        kind: 'unknown',
        reasons: ['group: no list price for claude-unreleased-9'],
      });
    });

    test('a typed line older than the grace, or none, is unattended', () => {
      const old = verdict({
        group: unpriced({
          kind: 'complete',
          latestTypedAtMs: NOW - 31 * MINUTE,
        }),
        week: week(10),
      });
      expect(old.kind === 'unknown' ? old.attendance : null).toEqual({
        kind: 'unattended',
        latestTypedAtMs: NOW - 31 * MINUTE,
      });
      const none = verdict({
        group: unpriced({kind: 'complete', latestTypedAtMs: null}),
        week: week(10),
      });
      expect(none.kind === 'unknown' ? none.attendance : null).toEqual({
        kind: 'unattended',
        latestTypedAtMs: null,
      });
    });

    test('a partial read proves attended, never unattended', () => {
      const recent = verdict({
        group: unpriced({
          kind: 'partial',
          latestTypedAtMs: NOW - 2 * MINUTE,
          reason: 'b-2 could not be read',
        }),
        week: week(10),
      });
      expect(recent.kind === 'unknown' ? recent.attendance.kind : null).toBe(
        'attended',
      );
      const stale = verdict({
        group: unpriced({
          kind: 'partial',
          latestTypedAtMs: NOW - 90 * MINUTE,
          reason: 'b-2 could not be read',
        }),
        week: week(10),
      });
      expect(stale.kind === 'unknown' ? stale.attendance : null).toEqual({
        kind: 'unknown',
        reason:
          'no typed line within 30 min was found, and b-2 could not be read',
      });
    });

    test('a group that did not resolve has unknown attendance', () => {
      const result = verdict({
        group: {
          kind: 'unknown',
          lowerBound: null,
          members: [],
          reason: 'br failed',
          typed: {
            kind: 'unknown',
            reason: 'the group did not resolve: br failed',
          },
        },
        week: week(10),
      });
      expect(result.kind === 'unknown' ? result.attendance.kind : null).toBe(
        'unknown',
      );
    });
  });
});
