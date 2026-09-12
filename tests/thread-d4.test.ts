/**
 * D4 — open asks carry forward and MUST be dispositioned.
 *
 * This is the housekeeping rule the whole epic hangs on. The sampling that
 * motivated it (2026-09-12, ten recent reports) found three of five replies
 * answering ZERO pending questions: the asks did not get declined, they
 * evaporated, and nothing anywhere recorded that they had. `thread report`
 * refuses a payload that leaves any open ask undispositioned, and this is the
 * test of that refusal.
 *
 * NEGATIVE CONTROL (run 2026-09-12): `checkPriorAskCoverage` was edited to
 * `return {ok: true}` unconditionally. Exactly the two refusal tests below
 * failed — "REFUSES a report that disposes of NOTHING" and "…only SOME of
 * them" — both at `expect(result.ok).toBe(false)`, `Expected: false Received:
 * true`. The other three legitimately expect `ok: true` and stayed green, which
 * is the right shape: only the refusal is being proved here. Restoring the
 * filter returned all five to green. Recorded on home-base-p1uj.1.
 */

import {describe, expect, test} from 'bun:test';

import {checkPriorAskCoverage} from '../src/thread/report';

import type {ThreadPriorAsk} from '../src/thread/schema';

function prior(
  id: string,
  disposition: ThreadPriorAsk['disposition'] = 'answered',
): ThreadPriorAsk {
  return {detail: 'because', disposition, id};
}

describe('checkPriorAskCoverage (D4)', () => {
  test('passes when there are no open asks at all', () => {
    expect(checkPriorAskCoverage([], [])).toEqual({ok: true});
  });

  test('REFUSES a report that disposes of NOTHING, naming every open ask', () => {
    const result = checkPriorAskCoverage(['jl-x7q.1', 'jl-x7q.2'], []);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.missing).toEqual(['jl-x7q.1', 'jl-x7q.2']);
  });

  test('REFUSES a report that disposes of only SOME of them', () => {
    const result = checkPriorAskCoverage(
      ['jl-x7q.1', 'jl-x7q.2'],
      [prior('jl-x7q.1')],
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.missing).toEqual(['jl-x7q.2']);
  });

  test('accepts every disposition, carried included', () => {
    for (const disposition of [
      'carried',
      'answered',
      'decided',
      'irrelevant',
    ] as const) {
      expect(
        checkPriorAskCoverage(['jl-x7q.1'], [prior('jl-x7q.1', disposition)]),
      ).toEqual({ok: true});
    }
  });

  test('dispositioning an ask that is not open is harmless', () => {
    expect(
      checkPriorAskCoverage(
        ['jl-x7q.1'],
        [prior('jl-x7q.1'), prior('jl-old.9')],
      ),
    ).toEqual({ok: true});
  });
});
