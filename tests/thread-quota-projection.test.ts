/**
 * Time to a spend limit (request home-base-ys9t7.5 D9, home-base-ys9t7.5.3
 * AC 5): the pure projection `thread quota` prints for each spend limit.
 */

import {describe, expect, test} from 'bun:test';

import {
  projectTimeToLimit,
  unattendedRate,
} from '../src/thread/quota-projection';

const NOW = Date.parse('2030-01-01T12:00:00Z');
const HOUR = 60 * 60 * 1000;

describe('unattendedRate', () => {
  test('2 % over the last 2 hours is 1 % per hour', () => {
    expect(
      unattendedRate({nowMs: NOW, sinceMs: NOW - 2 * HOUR, spentPercent: 2}),
    ).toEqual({elapsedMs: 2 * HOUR, percentPerHour: 1});
  });

  test('no start, or a start that is not in the past, gives no rate', () => {
    expect(unattendedRate({nowMs: NOW, sinceMs: null, spentPercent: 2})).toBe(
      null,
    );
    expect(unattendedRate({nowMs: NOW, sinceMs: NOW, spentPercent: 2})).toBe(
      null,
    );
    expect(
      unattendedRate({nowMs: NOW, sinceMs: NOW + HOUR, spentPercent: 2}),
    ).toBe(null);
  });
});

describe('projectTimeToLimit', () => {
  test('a known rate gives the right time: 2 % spent at 1 %/h reaches 5 % in 3 h', () => {
    expect(
      projectTimeToLimit({
        limitPercent: 5,
        nowMs: NOW,
        percentPerHour: 1,
        spentPercent: 2,
      }),
    ).toEqual({atMs: NOW + 3 * HOUR, inMs: 3 * HOUR, kind: 'at'});
  });

  test('a zero rate is none, never "infinitely far"', () => {
    expect(
      projectTimeToLimit({
        limitPercent: 5,
        nowMs: NOW,
        percentPerHour: 0,
        spentPercent: 0,
      }),
    ).toEqual({kind: 'none', reason: 'noRate'});
    expect(
      projectTimeToLimit({
        limitPercent: 5,
        nowMs: NOW,
        percentPerHour: null,
        spentPercent: 1,
      }),
    ).toEqual({kind: 'none', reason: 'noRate'});
  });

  test('a limit already crossed (or exactly reached) is none', () => {
    expect(
      projectTimeToLimit({
        limitPercent: 5,
        nowMs: NOW,
        percentPerHour: 1,
        spentPercent: 6,
      }),
    ).toEqual({kind: 'none', reason: 'reached'});
    expect(
      projectTimeToLimit({
        limitPercent: 5,
        nowMs: NOW,
        percentPerHour: 1,
        spentPercent: 5,
      }),
    ).toEqual({kind: 'none', reason: 'reached'});
  });
});
