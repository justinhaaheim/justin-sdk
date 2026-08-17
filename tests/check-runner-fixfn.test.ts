/**
 * Tests for in-process function fixers — `CheckResult.fixFn` (home-base-r47v F1).
 *
 * WHAT WOULD BE SILENT IN PRODUCTION, which is what these tests are for:
 *
 *  1. A FIXER THAT NEVER RAN. The fix loops used to select failures by
 *     `checkResult.fixCommand`, so a check carrying only a fixFn would have been
 *     filtered out and the run would look exactly like "there was no fix to try".
 *     Every arm therefore asserts the fixer's SIDE EFFECT, not just the exit code.
 *  2. A FIXER THAT THREW AND WAS READ AS A FIX. `sh -c` failures are swallowed on
 *     purpose (the re-check catches them), but a thrown function is a program
 *     error and must be said out loud (critical rule 5) — asserted on stderr.
 *  3. TWO SIDE EFFECTS FROM ONE FAILURE. A result carrying both a fixFn and a
 *     fixCommand must run exactly one of them; the arm below proves the
 *     fixCommand's marker is NOT created.
 *  4. AN APPROVAL GATE THAT ONLY GUARDS SHELL COMMANDS. `requiresApproval` is
 *     about the BLAST RADIUS of a fix, not its implementation language, so both
 *     directions are pinned for fixFn too.
 *
 * check-runner is a published SDK export consumed by every project's
 * signal/doctor, so the string-fixCommand path must stay exactly as it was:
 * tests/check-runner-approval.test.ts and tests/fix.test.ts cover that, and the
 * last arm here re-pins it side by side with a fixFn in the same run.
 */

import {afterEach, describe, expect, spyOn, test} from 'bun:test';
import {existsSync} from 'fs';
import {join} from 'path';

import type {CheckNode} from '../src/check-runner';
import {runCheckTree, runChecks} from '../src/check-runner';

import {createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
function track(sandbox: Sandbox): Sandbox {
  sandboxes.push(sandbox);
  return sandbox;
}

afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

/** A check that passes once `marker` exists, and whose fixer creates it. */
function markerCheck(
  marker: string,
  options: {
    label?: string;
    requiresApproval?: boolean;
    shellMarker?: string;
    throws?: string;
  } = {},
): CheckNode {
  return {
    check: {
      label: options.label ?? 'MARKER',
      fn: () => {
        if (existsSync(marker)) return {pass: true};
        return {
          fixFn: () => {
            if (options.throws != null) throw new Error(options.throws);
            Bun.spawnSync(['touch', marker]);
          },
          ...(options.shellMarker != null
            ? {fixCommand: `touch '${options.shellMarker}'`}
            : {}),
          message: 'marker missing',
          pass: false,
          ...(options.requiresApproval === true
            ? {requiresApproval: true}
            : {}),
        };
      },
    },
  };
}

describe('runCheckTree honors fixFn', () => {
  test('a fixFn-only check is fixed and the re-check goes green', async () => {
    const sb = track(createSandbox());
    const marker = join(sb.path, 'fixed-by-fn.txt');

    const exitCode = await runCheckTree([markerCheck(marker)], {
      fix: true,
      quiet: true,
    });

    // The side effect is the proof the fixer ran at all; the exit code is the
    // proof the re-walk saw it.
    expect(existsSync(marker)).toBe(true);
    expect(exitCode).toBe(0);
  });

  test('without --fix, a fixFn is never invoked', async () => {
    const sb = track(createSandbox());
    const marker = join(sb.path, 'untouched.txt');

    const exitCode = await runCheckTree([markerCheck(marker)], {quiet: true});

    expect(existsSync(marker)).toBe(false);
    expect(exitCode).toBe(1);
  });

  test('fixFn WINS over fixCommand: exactly one side effect', async () => {
    const sb = track(createSandbox());
    const fnMarker = join(sb.path, 'by-fn.txt');
    const shellMarker = join(sb.path, 'by-shell.txt');

    await runCheckTree([markerCheck(fnMarker, {shellMarker})], {
      fix: true,
      quiet: true,
    });

    expect(existsSync(fnMarker)).toBe(true);
    expect(existsSync(shellMarker)).toBe(false);
  });

  test('a THROWING fixFn is reported loudly and the check stays red', async () => {
    const sb = track(createSandbox());
    const marker = join(sb.path, 'never-written.txt');
    const errors = spyOn(console, 'error').mockImplementation(() => {});

    let exitCode: number;
    let said: string;
    try {
      // quiet: true on purpose — a fix failure must print even when the runner
      // has been told to be quiet, because quiet suppresses SUCCESS noise only.
      exitCode = await runCheckTree(
        [markerCheck(marker, {label: 'BOOM', throws: 'the source is offline'})],
        {fix: true, quiet: true},
      );
      // Read the recorded calls BEFORE restoring: mockRestore() drops them.
      said = errors.mock.calls.map((call) => String(call[0])).join('\n');
    } finally {
      errors.mockRestore();
    }

    expect(said).toContain('BOOM');
    expect(said).toContain('fix FAILED');
    expect(said).toContain('the source is offline');
    // Not fixed, and not reported as fixed.
    expect(existsSync(marker)).toBe(false);
    expect(exitCode).toBe(1);
  });

  test('a throwing fixFn does not abort the run: sibling fixes still apply', async () => {
    const sb = track(createSandbox());
    const broken = join(sb.path, 'broken.txt');
    const sibling = join(sb.path, 'sibling.txt');
    const errors = spyOn(console, 'error').mockImplementation(() => {});

    try {
      await runCheckTree(
        [
          markerCheck(broken, {label: 'BOOM', throws: 'nope'}),
          markerCheck(sibling, {label: 'SIBLING'}),
        ],
        {fix: true, quiet: true},
      );
    } finally {
      errors.mockRestore();
    }

    expect(existsSync(broken)).toBe(false);
    expect(existsSync(sibling)).toBe(true);
  });

  test('an async fixFn is awaited before the re-check', async () => {
    const sb = track(createSandbox());
    const marker = join(sb.path, 'async.txt');

    const nodes: CheckNode[] = [
      {
        check: {
          label: 'ASYNC',
          fn: () => {
            if (existsSync(marker)) return {pass: true};
            return {
              fixFn: async () => {
                await Bun.sleep(25);
                Bun.spawnSync(['touch', marker]);
              },
              message: 'missing',
              pass: false,
            };
          },
        },
      },
    ];

    // If the loop did not await, the re-check would race the write and this
    // would be flaky-red rather than green.
    expect(await runCheckTree(nodes, {fix: true, quiet: true})).toBe(0);
    expect(existsSync(marker)).toBe(true);
  });
});

describe('fixFn under the approval gate', () => {
  test('requiresApproval blocks a fixFn without --yes', async () => {
    const sb = track(createSandbox());
    const marker = join(sb.path, 'needs-approval.txt');

    const exitCode = await runCheckTree(
      [markerCheck(marker, {requiresApproval: true})],
      {fix: true, quiet: true},
    );

    expect(existsSync(marker)).toBe(false);
    expect(exitCode).toBe(1);
  });

  test('and runs it with --yes', async () => {
    const sb = track(createSandbox());
    const marker = join(sb.path, 'approved.txt');

    const exitCode = await runCheckTree(
      [markerCheck(marker, {requiresApproval: true})],
      {fix: true, quiet: true, yes: true},
    );

    expect(existsSync(marker)).toBe(true);
    expect(exitCode).toBe(0);
  });
});

describe('runChecks (the flat runner) honors fixFn too', () => {
  test('fixFn and fixCommand checks are fixed in the same run', async () => {
    const sb = track(createSandbox());
    const fnMarker = join(sb.path, 'flat-fn.txt');
    const shellMarker = join(sb.path, 'flat-shell.txt');

    const exitCode = await runChecks(
      [
        markerCheck(fnMarker, {label: 'FN'}).check,
        {
          label: 'SHELL',
          fn: () => {
            if (existsSync(shellMarker)) return {pass: true};
            return {
              fixCommand: `touch '${shellMarker}'`,
              message: 'missing',
              pass: false,
            };
          },
        },
      ],
      {fix: true, quiet: true},
    );

    // The string-fixCommand path is untouched by F1 — proven here alongside the
    // new one rather than in a separate file, since "one of them regressed" is
    // the interesting failure.
    expect(existsSync(fnMarker)).toBe(true);
    expect(existsSync(shellMarker)).toBe(true);
    expect(exitCode).toBe(0);
  });
});
