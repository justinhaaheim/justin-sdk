/**
 * D4 — open asks carry forward and MUST be dispositioned.
 *
 * SUPERSEDED BY D24 AT THE CALL SITE, 2026-09-15. `thread report` no longer
 * refuses an undispositioned open ask: it CLOSES it, "decided: <the default that
 * ask recorded>", which is the same housekeeping enforced from the other end.
 * `checkPriorAskCoverage` itself is unchanged and still exported, and these
 * tests still describe what it does — but nothing on the write path calls it any
 * more. The lifecycle that replaced it is tested in thread-ask-lifecycle.test.ts.
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

  test('accepts every v3 disposition', () => {
    for (const disposition of ['answered', 'irrelevant'] as const) {
      expect(
        checkPriorAskCoverage(['jl-x7q.1'], [prior('jl-x7q.1', disposition)]),
      ).toEqual({ok: true});
    }
  });

  // D24's one-release bridge: a v2 payload's `carried` ids reach this function
  // as the third argument, and they COVER the ask — it stays open on purpose,
  // which is a disposition even though it is not a `priorAsks` entry.
  test('a migration-kept ask counts as covered', () => {
    expect(checkPriorAskCoverage(['jl-x7q.1'], [], ['jl-x7q.1'])).toEqual({
      ok: true,
    });
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
