/**
 * Tests for rendering a PASSING check's `CheckResult.message` (home-base-dpm4).
 *
 * printSummary used to gate the message on `!ok`, so every message a check set
 * alongside `pass: true` — the bun version, the config files CONFIG_SCHEMA
 * validated, the latest SDK tag — was unreachable text that had never once been
 * shown. Justin's ruling (2026-09-10): print it in NON-quiet mode as a dim
 * continuation line under the check row, and leave `--quiet` exactly as it was.
 *
 * WHAT WOULD BE SILENT IN PRODUCTION, which is what these tests are for:
 *
 *  1. THE MESSAGE GOING DEAD AGAIN. A future edit re-gating on `!ok` would not
 *     fail any other test — nothing else reads a passing row's text — and the
 *     information would simply stop appearing. The first arm pins the exact
 *     rendered shape, indentation and DIM wrapper included.
 *  2. QUIET DRIFTING. The doctor heartbeat (src/health-notices.ts
 *     parseDoctorSummary) parses `--quiet` output and anchors on ` N pass` /
 *     `Ran N checks.` / `All N checks passed.`. A pass message leaking into
 *     quiet would add lines that parser has never seen, so both quiet shapes
 *     are pinned: the all-pass one-liner, and the mixed run where the failure
 *     block prints but passing rows must stay absent.
 *  3. THE FAILURE PATH REGRESSING. Widening the condition must not disturb the
 *     failure rendering that operators already depend on, so the last arm
 *     re-pins a failing message and its `Fix:` line side by side with a pass
 *     message in the same run.
 */

import {describe, expect, spyOn, test} from 'bun:test';

import type {Check, CheckNode} from '../src/check-runner';
import {runCheckTree, runChecks} from '../src/check-runner';

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

/** The exact continuation line printSummary should append for a message. */
function continuationLine(message: string): string {
  return `\n     ${DIM}${message}${RESET}`;
}

/**
 * Run something while console.log is captured, and return everything it said.
 * The recorded calls must be read BEFORE mockRestore(), which drops them.
 */
async function captureLog(
  run: () => Promise<number>,
): Promise<{exitCode: number; said: string}> {
  const logs = spyOn(console, 'log').mockImplementation(() => {});
  try {
    const exitCode = await run();
    const said = logs.mock.calls.map((call) => String(call[0])).join('\n');
    return {exitCode, said};
  } finally {
    logs.mockRestore();
  }
}

/** The line printed directly after the row carrying `label`. */
function lineAfter(said: string, label: string): string {
  const lines = said.split('\n');
  const index = lines.findIndex((line) => line.includes(label));
  expect(index).toBeGreaterThanOrEqual(0);
  return lines[index + 1] ?? '';
}

function passingCheck(label: string, message?: string): Check {
  return {
    label,
    fn: () => (message == null ? {pass: true} : {message, pass: true}),
  };
}

function failingCheck(label: string, message: string): Check {
  return {
    label,
    fn: () => ({fix: 'Run: the fix', message, pass: false}),
  };
}

describe('check-runner passing-check messages', () => {
  test('non-quiet: a passing check renders its message as a dim continuation line', async () => {
    const nodes: CheckNode[] = [
      {check: passingCheck('BUN', 'bun 1.4.2')},
      {check: passingCheck('SILENT')},
    ];

    const {exitCode, said} = await captureLog(() => runCheckTree(nodes, {}));

    expect(exitCode).toBe(0);
    // The row and its message are printed as ONE console.log call, so this
    // also pins that the message hangs under its own check rather than
    // floating somewhere else in the summary.
    expect(said).toContain(`BUN`);
    expect(said).toContain(continuationLine('bun 1.4.2'));
    // A passing check with no message gains no continuation line: the line
    // after SILENT's row is not an indented one.
    expect(lineAfter(said, 'SILENT').startsWith('     ')).toBe(false);
  });

  test('non-quiet: runChecks renders pass messages too, not only runCheckTree', async () => {
    const {said} = await captureLog(() =>
      runChecks([passingCheck('CONFIG_SCHEMA', 'config.json: valid')], {}),
    );

    expect(said).toContain(continuationLine('config.json: valid'));
  });

  test('quiet all-pass: still the one-liner, with no pass message anywhere', async () => {
    const nodes: CheckNode[] = [
      {check: passingCheck('BUN', 'bun 1.4.2')},
      {check: passingCheck('SDK_VERSION', '0.27.0 is the latest tag')},
    ];

    const {exitCode, said} = await captureLog(() =>
      runCheckTree(nodes, {quiet: true}),
    );

    expect(exitCode).toBe(0);
    // One console.log, one line: the whole quiet all-pass output.
    expect(said).toMatch(
      /^\x1b\[32m✓\x1b\[0m All 2 checks passed\. \x1b\[2m\[\d+ms\]\x1b\[0m$/,
    );
    expect(said).not.toContain('bun 1.4.2');
    expect(said).not.toContain('latest tag');
  });

  test('quiet with a failure: the failure block prints, passing messages do not', async () => {
    const nodes: CheckNode[] = [
      {check: passingCheck('BUN', 'bun 1.4.2')},
      {check: failingCheck('LINT_STAGED_INSTALLED', 'installed 14, pinned 16')},
    ];

    const {exitCode, said} = await captureLog(() =>
      runCheckTree(nodes, {quiet: true}),
    );

    expect(exitCode).toBe(1);
    expect(said).toContain('installed 14, pinned 16');
    // The passing check is absent entirely — row and message alike.
    expect(said).not.toContain('BUN');
    expect(said).not.toContain('bun 1.4.2');
    // The lines parseDoctorSummary anchors on are unchanged.
    expect(said).toContain('1 pass');
    expect(said).toContain('Ran 2 checks.');
  });

  test('non-quiet: the failure message and its Fix line are unchanged', async () => {
    const nodes: CheckNode[] = [
      {check: passingCheck('BUN', 'bun 1.4.2')},
      {check: failingCheck('BROKEN', 'the thing is wrong')},
    ];

    const {said} = await captureLog(() => runCheckTree(nodes, {}));

    expect(said).toContain(continuationLine('the thing is wrong'));
    expect(said).toContain(`\n     \x1b[33mFix: Run: the fix${RESET}`);
    expect(said).toContain(continuationLine('bun 1.4.2'));
  });
});
