/**
 * Tests for the ONE retry loop over a `/usage` read (src/claude-usage.ts
 * `readUsageWithRetries`), lifted out of home-base's sampler by home-base-iqdmz
 * so justin-loop's gate could use the same one. The sampler's own tests
 * (home-base src/claude-usage/sample.test.ts) still cover the records it writes.
 *
 * Every reader here is a stub and every sleep is recorded, never waited.
 */
import {describe, expect, test} from 'bun:test';

import {
  readUsageWithRetries,
  USAGE_RETRY_ATTEMPTS,
  USAGE_RETRY_DELAYS_MS,
  type UsageAttemptFailure,
  type UsagePanelRead,
  type UsageRetryPolicy,
} from '../src/claude-usage';

const SAMPLED_AT = '2026-11-12T17:00:00.000Z';

function failedRead(reason: string): UsagePanelRead {
  return {kind: 'failed', raw: null, reason, sampledAt: SAMPLED_AT};
}

const OK_READ: UsagePanelRead = {
  kind: 'ok',
  panel: {
    isSubscription: true,
    session: null,
    week: {pct: 43, resetsAt: null, resetsAtError: null, resetsText: null},
    weekByModel: {},
  },
  raw: 'fixture',
  sampledAt: SAMPLED_AT,
};

/** A reader that answers from `reads` in order; the last one repeats. */
function scripted(reads: UsagePanelRead[]): {
  calls: () => number;
  read: () => Promise<UsagePanelRead>;
} {
  let calls = 0;
  return {
    calls: () => calls,
    read: () => {
      const read = reads[Math.min(calls, reads.length - 1)] ?? OK_READ;
      calls++;
      return Promise.resolve(read);
    },
  };
}

function policy(attempts: number, slept: number[]): UsageRetryPolicy {
  return {
    attempts,
    delaysMs: USAGE_RETRY_DELAYS_MS,
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
  };
}

/** A clock that hands out minute marks, so each attempt's start is distinct. */
function minuteClock(): () => Date {
  let minute = 0;
  return () => new Date(Date.UTC(2026, 10, 12, 17, minute++));
}

describe('readUsageWithRetries (home-base-iqdmz)', () => {
  test('the default policy is 3 attempts, 10 s then 30 s apart', () => {
    expect(USAGE_RETRY_ATTEMPTS).toBe(3);
    expect(USAGE_RETRY_DELAYS_MS).toEqual([10_000, 30_000]);
  });

  test('one failure, then ok: the ok is returned, and the failure is kept with its reason and start', async () => {
    const slept: number[] = [];
    const reader = scripted([failedRead('timed out after 60000ms'), OK_READ]);
    const out = await readUsageWithRetries(reader.read, policy(3, slept), {
      now: minuteClock(),
    });
    expect(out.read.kind).toBe('ok');
    expect(reader.calls()).toBe(2);
    expect(slept).toEqual([10_000]);
    expect(out.failedAttempts).toHaveLength(1);
    expect(out.failedAttempts[0]?.attempt).toBe(1);
    expect(out.failedAttempts[0]?.read.reason).toBe('timed out after 60000ms');
    expect(out.failedAttempts[0]?.startedAt.toISOString()).toBe(
      '2026-11-12T17:00:00.000Z',
    );
    // The ok attempt is the second, and its own start is reported.
    expect(out.startedAt.toISOString()).toBe('2026-11-12T17:01:00.000Z');
  });

  test('every attempt fails: the last failure is `read`, and each earlier one is its own entry', async () => {
    const slept: number[] = [];
    const reader = scripted([
      failedRead('first'),
      failedRead('second'),
      failedRead('third'),
    ]);
    const out = await readUsageWithRetries(reader.read, policy(3, slept));
    expect(reader.calls()).toBe(3);
    expect(slept).toEqual([10_000, 30_000]);
    expect(out.read.kind).toBe('failed');
    expect(out.read.kind === 'failed' ? out.read.reason : null).toBe('third');
    expect(out.failedAttempts.map((f) => [f.attempt, f.read.reason])).toEqual([
      [1, 'first'],
      [2, 'second'],
    ]);
  });

  test('the last delay repeats when attempts outnumber the delays', async () => {
    const slept: number[] = [];
    await readUsageWithRetries(
      scripted([failedRead('down')]).read,
      policy(5, slept),
    );
    expect(slept).toEqual([10_000, 30_000, 30_000, 30_000]);
  });

  test('one attempt, or no policy at all, is a single read with no wait', async () => {
    for (const retry of [undefined, policy(1, [])]) {
      const reader = scripted([failedRead('down'), OK_READ]);
      const out = await readUsageWithRetries(reader.read, retry);
      expect(reader.calls()).toBe(1);
      expect(out.read.kind).toBe('failed');
      expect(out.failedAttempts).toEqual([]);
    }
  });

  test('a first-try ok never sleeps and lists no failures', async () => {
    const slept: number[] = [];
    const out = await readUsageWithRetries(
      scripted([OK_READ]).read,
      policy(3, slept),
    );
    expect(out.read.kind).toBe('ok');
    expect(slept).toEqual([]);
    expect(out.failedAttempts).toEqual([]);
  });

  test('every failed attempt is reported as it happens, the last with no next wait', async () => {
    const events: string[] = [];
    const seen: UsageAttemptFailure[] = [];
    await readUsageWithRetries(
      scripted([failedRead('a'), failedRead('b'), failedRead('c')]).read,
      {
        attempts: 3,
        delaysMs: USAGE_RETRY_DELAYS_MS,
        sleep: (ms) => {
          events.push(`sleep ${ms}`);
          return Promise.resolve();
        },
      },
      {
        onFailedAttempt: (failure) => {
          events.push(`failed ${failure.attempt}`);
          seen.push(failure);
        },
      },
    );
    // Reported BEFORE the wait, so the output says what is coming.
    expect(events).toEqual([
      'failed 1',
      'sleep 10000',
      'failed 2',
      'sleep 30000',
      'failed 3',
    ]);
    expect(seen).toEqual([
      {attempt: 1, attempts: 3, nextInMs: 10_000, reason: 'a'},
      {attempt: 2, attempts: 3, nextInMs: 30_000, reason: 'b'},
      {attempt: 3, attempts: 3, nextInMs: null, reason: 'c'},
    ]);
  });

  test('a read of another shape with the same ok/failed contract is retried the same way', async () => {
    // justin-loop's `UsageRead` carries no `sampledAt` or `raw`; the loop needs
    // only `kind` and the failure's `reason`.
    type GateRead =
      | {kind: 'failed'; reason: string}
      | {kind: 'ok'; weekPct: number};
    const good: GateRead = {kind: 'ok', weekPct: 43};
    const reads: GateRead[] = [{kind: 'failed', reason: 'blip'}, good];
    let calls = 0;
    const out = await readUsageWithRetries<GateRead>(
      () => Promise.resolve(reads[calls++] ?? good),
      policy(3, []),
    );
    expect(out.read).toEqual(good);
    expect(out.failedAttempts.map((f) => f.read.reason)).toEqual(['blip']);
  });
});
