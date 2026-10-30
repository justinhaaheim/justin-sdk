/**
 * `thread quota` (request home-base-ys9t7.5 D9, home-base-ys9t7.5.3): its pure
 * pieces, and that `--help` prints help and does nothing else. The live run
 * against a real session is recorded on home-base-ys9t7.5.3's notes.
 */

import {describe, expect, test} from 'bun:test';
import {join} from 'path';

import {
  formatDuration,
  limitTiming,
  verdictText,
} from '../src/thread/quota-command';

const NOW = Date.parse('2030-01-01T12:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;

const KNOWN_GROUP = {
  firstUnattendedAtMs: NOW - 2 * HOUR,
  kind: 'known' as const,
  latestTypedAtMs: NOW - 2 * HOUR,
  members: [],
  requests: 4,
  root: 'b-1',
  spend: {
    byFamily: {
      fable: {usd: 0, weekPercent: 0},
      opus: {usd: 64.6, weekPercent: 2},
      other: {usd: 0, weekPercent: 0},
      sonnet: {usd: 0, weekPercent: 0},
    },
    usd: 64.6,
    weekPercent: 2,
  },
  typed: {kind: 'complete' as const, latestTypedAtMs: NOW - 2 * HOUR},
  unparseableLines: 0,
};

describe('formatDuration', () => {
  test('minutes, hours and days, largest two units', () => {
    expect(formatDuration(30_000)).toBe('under a minute');
    expect(formatDuration(12 * MIN)).toBe('12 min');
    expect(formatDuration(3 * HOUR + 5 * MIN)).toBe('3 h 5 min');
    expect(formatDuration(2 * HOUR)).toBe('2 h');
    expect(formatDuration(50 * HOUR)).toBe('2 d 2 h');
  });
});

describe('limitTiming', () => {
  test('a known spend and rate: the projection', () => {
    expect(
      limitTiming({
        limitPercent: 5,
        nowMs: NOW,
        rate: {elapsedMs: 2 * HOUR, percentPerHour: 1},
        rateProblem: null,
        spend: KNOWN_GROUP,
      }),
    ).toEqual({
      kind: 'known',
      limitPercent: 5,
      projection: {atMs: NOW + 3 * HOUR, inMs: 3 * HOUR, kind: 'at'},
      spentPercent: 2,
    });
  });

  test('an unknown spend is unknown with its reason, never a projection', () => {
    expect(
      limitTiming({
        limitPercent: 5,
        nowMs: NOW,
        rate: null,
        rateProblem: 'the group is unknown',
        spend: {
          kind: 'unknown',
          lowerBound: null,
          members: [],
          reason: 'a transcript could not be read',
          typed: {kind: 'unknown', reason: 'a transcript could not be read'},
        },
      }),
    ).toEqual({
      kind: 'unknown',
      limitPercent: 5,
      reason: 'the spend is unknown: a transcript could not be read',
    });
  });
});

describe('verdictText', () => {
  test('fine, over and unknown each say what they are', () => {
    expect(verdictText({attended: false, kind: 'fine'})).toBe('fine');
    expect(verdictText({attended: true, kind: 'fine'})).toContain('attended');
    expect(
      verdictText({
        attended: false,
        kind: 'over',
        over: [
          {limit: 'floor', limitPercent: 75, weekPercent: 82, window: 'week'},
          {
            atLeast: true,
            limit: 'chain',
            limitPercent: 5,
            spentPercent: 6,
          },
        ],
        unknown: ['project: unreadable'],
      }),
    ).toBe(
      'OVER: floor: the week is at 82 % (limit 75 %); chain: the group spent at least 6.00 % of the week (limit 5 %); also unknown: project: unreadable',
    );
    expect(
      verdictText({
        attendance: {kind: 'unattended', latestTypedAtMs: null},
        kind: 'unknown',
        reasons: ['week: stale'],
      }),
    ).toBe('UNKNOWN (unattended): week: stale');
  });
});

describe('thread quota --help', () => {
  test('exits 0 and prints help only', () => {
    const result = Bun.spawnSync(
      [
        'bun',
        join(import.meta.dir, '..', 'src', 'cli.ts'),
        'thread',
        'quota',
        '--help',
      ],
      {
        env: {
          ...process.env,
          CLAUDE_CODE_SESSION_ID: '',
          JUSTIN_SDK_HEALTH_NOTICES: 'off',
        },
      },
    );
    const stdout = result.stdout.toString();
    expect(result.exitCode).toBe(0);
    expect(stdout).toContain('justin-sdk thread quota');
    expect(stdout).toContain('--json');
    expect(stdout).toContain('WHAT EACH PART MEANS');
    // The report's own first section never appears: nothing was measured.
    expect(stdout).not.toContain('Spend quota\n');
    expect(stdout).not.toContain('session bead:');
  });
});
