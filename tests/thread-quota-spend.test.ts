/**
 * Spend in percent of the week (request home-base-ys9t7.5 D1, built by
 * home-base-ys9t7.5.2): each family's rate, `other` for haiku and the rest,
 * and an unpriced model giving unknown with the priced lower bound.
 */

import {describe, expect, test} from 'bun:test';

import {type CostRequest, estimateCost} from '../src/session-cost';
import {quotaFamilyOf, weekSpendOf} from '../src/thread/quota-spend';
import {TEST_RATES} from './quota-fixtures';

/** One request of `output` tokens on `model` (input and cache zero). */
function request(key: string, model: string, output: number): CostRequest {
  return {
    atMs: 0,
    key,
    outputRank: output,
    parts: [
      {
        cacheRead: 0,
        cacheWrite1h: 0,
        cacheWrite5m: 0,
        input: 0,
        model,
        output,
        speed: null,
        unsplitCacheWrite: 0,
      },
    ],
  };
}

describe('weekSpendOf', () => {
  test('each family is divided by its own rate', () => {
    // List output prices per million: fable-5-1 $50, opus-5-5 $20, sonnet-5-5 $10.
    const spend = weekSpendOf(
      estimateCost([
        request('a', 'claude-fable-5-1', 1_000_000),
        request('b', 'claude-opus-5-5', 1_000_000),
        request('c', 'claude-sonnet-5-5', 1_000_000),
      ]),
      TEST_RATES,
    );
    expect(spend.kind).toBe('known');
    if (spend.kind !== 'known') return;
    expect(spend.byFamily.fable).toEqual({usd: 50, weekPercent: 5});
    expect(spend.byFamily.opus).toEqual({usd: 20, weekPercent: 1});
    expect(spend.byFamily.sonnet).toEqual({usd: 10, weekPercent: 2});
    expect(spend.byFamily.other).toEqual({usd: 0, weekPercent: 0});
    expect(spend.usd).toBe(80);
    expect(spend.weekPercent).toBe(8);
  });

  test('haiku and Mythos take `other` and `fable`, as the calibration classified them', () => {
    expect(quotaFamilyOf('claude-haiku-5-5')).toBe('other');
    expect(quotaFamilyOf('claude-mythos-5-1')).toBe('fable');
    expect(quotaFamilyOf('some-new-model')).toBe('other');
    // haiku-4-5 lists output at $5 per million: $5 at the `other` rate of $1.
    const spend = weekSpendOf(
      estimateCost([request('h', 'claude-haiku-4-5', 1_000_000)]),
      TEST_RATES,
    );
    expect(spend).toMatchObject({
      byFamily: {other: {usd: 5, weekPercent: 5}},
      kind: 'known',
      weekPercent: 5,
    });
  });

  test('an unpriced model makes it unknown, with the priced part as a lower bound', () => {
    const spend = weekSpendOf(
      estimateCost([
        request('a', 'claude-opus-5-5', 1_000_000),
        request('b', 'claude-unreleased-9', 1_000_000),
      ]),
      TEST_RATES,
    );
    expect(spend.kind).toBe('unknown');
    if (spend.kind !== 'unknown') return;
    expect(spend.unpricedModels).toEqual(['claude-unreleased-9']);
    expect(spend.lowerBound.weekPercent).toBe(1);
    expect(spend.lowerBound.usd).toBe(20);
    expect(spend.reason).toContain('at least 1.00 % of the week');
    expect(spend.reason).toContain('no list price for claude-unreleased-9');
    // No number that reads as complete.
    expect('weekPercent' in spend).toBe(false);
  });
});
