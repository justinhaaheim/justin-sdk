/**
 * Tests for `justin-sdk ralph`.
 *
 * The focus is `parseUsage`, which is the highest-consequence pure function in
 * the runner: it reads the REAL subscription quota out of `/usage` text and is
 * the only thing standing between a loop and eating the whole 5-hour window.
 * A silent misparse is the worst failure mode available — returning null (which
 * the loop treats as fail-closed) is always correct when the shape is unknown,
 * but returning a WRONG number is not. So these tests pin the happy path, the
 * fail-closed path, and the boundary between them.
 *
 * The verbatim fixture below is real output captured from
 * `claude -p "/usage" --output-format json` on 2026-07-16 (v2.1.212), with the
 * separator character (·) preserved exactly as emitted.
 */

import {describe, expect, test} from 'bun:test';

import {DEFAULT_OPTIONS, parseUsage, VERDICT_SCHEMA} from '../src/ralph';

const REAL_USAGE_OUTPUT = `You are currently using your subscription to power your Claude Code usage

Current session: 5% used · resets Jul 16 at 10:50pm (America/Los_Angeles)
Current week (all models): 10% used · resets Jul 18 at 4pm (America/Los_Angeles)
Current week (Fable): 2% used · resets Jul 18 at 4pm (America/Los_Angeles)

What's contributing to your limits usage?
Approximate, based on local sessions on this machine — does not include other devices or claude.ai.

Last 24h · 647 requests · 8 sessions
  91% of your usage came from subagent-heavy sessions`;

describe('parseUsage', () => {
  test('parses real /usage output', () => {
    const usage = parseUsage(REAL_USAGE_OUTPUT);
    expect(usage).not.toBeNull();
    expect(usage?.sessionPct).toBe(5);
    expect(usage?.weekPct).toBe(10);
    expect(usage?.isSubscription).toBe(true);
  });

  test('extracts reset timestamps', () => {
    const usage = parseUsage(REAL_USAGE_OUTPUT);
    expect(usage?.sessionResetsAt).toBe('Jul 16 at 10:50pm');
    expect(usage?.weekResetsAt).toBe('Jul 18 at 4pm');
  });

  test('does not confuse the per-model week line with the all-models line', () => {
    // "Current week (Fable): 2%" must never be read as the all-models number,
    // or the weekly gate would read far too low and never trip.
    const usage = parseUsage(REAL_USAGE_OUTPUT);
    expect(usage?.weekPct).toBe(10);
    expect(usage?.weekPct).not.toBe(2);
  });

  test('reads high percentages, not just single digits', () => {
    const usage = parseUsage(
      'Current session: 100% used · resets Jul 16 at 10:50pm\n' +
        'Current week (all models): 87% used · resets Jul 18 at 4pm',
    );
    expect(usage?.sessionPct).toBe(100);
    expect(usage?.weekPct).toBe(87);
  });

  test('fails closed on unrecognized output', () => {
    // Anything we cannot read must be null so the loop refuses to spend quota
    // it cannot measure, rather than defaulting to 0% and running free.
    expect(parseUsage('')).toBeNull();
    expect(parseUsage('Some unrelated CLI output')).toBeNull();
    expect(parseUsage('Credit balance: $12.00')).toBeNull();
  });

  test('fails closed when only the session line is present', () => {
    // A partial parse is a misparse: without the weekly number the weekly gate
    // would silently never trip.
    expect(parseUsage('Current session: 42% used · resets Jul 16')).toBeNull();
  });

  test('flags API billing rather than assuming subscription', () => {
    const usage = parseUsage(
      'Current session: 5% used · resets Jul 16 at 10:50pm\n' +
        'Current week (all models): 10% used · resets Jul 18 at 4pm',
    );
    expect(usage).not.toBeNull();
    expect(usage?.isSubscription).toBe(false);
  });
});

describe('defaults', () => {
  test("session gate defaults to Justin's 50%", () => {
    expect(DEFAULT_OPTIONS.sessionStopPct).toBe(50);
  });

  test('defaults to pausing rather than burning through the gate', () => {
    expect(DEFAULT_OPTIONS.onGateHit).toBe('pause');
  });

  test('never resumes a session — fresh context per iteration is the technique', () => {
    // Guard against someone "helpfully" adding --resume later.
    expect(DEFAULT_OPTIONS.prompt).toBe('/loop-session');
  });
});

describe('VERDICT_SCHEMA', () => {
  test('pins the four stop states the loop switches on', () => {
    expect(VERDICT_SCHEMA.properties.status.enum).toEqual([
      'CONTINUE',
      'COMPLETE',
      'BLOCKED',
      'FAILED',
    ]);
  });

  test('requires every field the runner reads', () => {
    expect(VERDICT_SCHEMA.required).toEqual(['status', 'summary', 'followUps']);
  });
});
