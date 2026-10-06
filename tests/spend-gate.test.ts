/**
 * The spend gate on scripts that start real Claude Code sessions
 * (scripts/spend-gate.ts, Justin 2026-09-25).
 */

import {describe, expect, test} from 'bun:test';

import {checkSpendConsent, SPEND_FLAG} from '../scripts/spend-gate';

const OPTIONS = {script: 'bun run probe:x', spends: 'one haiku turn'};

describe('spend gate', () => {
  test('refuses a run without the flag, and says what it would have spent', () => {
    const consent = checkSpendConsent(['--model', 'haiku'], OPTIONS);
    expect(consent.ok).toBe(false);
    if (!consent.ok) {
      expect(consent.message).toContain('one haiku turn');
      expect(consent.message).toContain('Nothing was run');
      expect(consent.message).toContain(SPEND_FLAG);
    }
  });

  test('allows a run with the flag, and strips it before the script parses', () => {
    expect(
      checkSpendConsent(['--model', 'haiku', SPEND_FLAG], OPTIONS),
    ).toEqual({argv: ['--model', 'haiku'], ok: true});
  });

  test('--help never needs the flag', () => {
    expect(checkSpendConsent(['--help'], OPTIONS).ok).toBe(true);
    expect(checkSpendConsent(['-h'], OPTIONS).ok).toBe(true);
  });

  test('a declared no-spend mode needs no flag; anything else still does', () => {
    const replay = {
      ...OPTIONS,
      exempt: (argv: readonly string[]) =>
        argv.some((arg) => arg.startsWith('--replay')),
    };
    expect(checkSpendConsent(['--replay=/tmp/x'], replay).ok).toBe(true);
    expect(checkSpendConsent(['--scenario=a'], replay).ok).toBe(false);
  });
});
