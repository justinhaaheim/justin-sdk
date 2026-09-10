/**
 * Sweep's children must never carry health notices (home-base-uxwc.6).
 *
 * D1 classifies `sweep` as NEVER — "sweep IS the upgrade" — but that only ever
 * covered the sweep PROCESS. Its gates spawn `bunx … doctor`, `… doctor --fix`
 * and `bun run signal` inside a fresh worktree per repo, and each of those is a
 * tier-2/tier-3 callsite in its own right. Because the notice throttle is keyed
 * by project root and every sweep worktree is a different absolute path, no
 * throttle applies across them: a 12-repo sweep could print the upgrade notice
 * 12 times into the run log an operator reads when a sweep goes red, and (since
 * home-base-uxwc.3) fire a doctor heartbeat inside a gate that is already
 * running doctor.
 *
 * `measureBaseline` is the narrowest exported thing that goes through sweep's
 * one child-spawning funnel, so the assertion is made on a real child's view of
 * its own environment rather than on a helper's return value.
 */

import {afterEach, describe, expect, test} from 'bun:test';

import {HEALTH_NOTICES_ENV_VAR} from '../src/health-notices';
import {measureBaseline} from '../src/sweep';
import {createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
const originalSwitch = process.env[HEALTH_NOTICES_ENV_VAR];

afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
  if (originalSwitch == null) {
    delete process.env[HEALTH_NOTICES_ENV_VAR];
  } else {
    process.env[HEALTH_NOTICES_ENV_VAR] = originalSwitch;
  }
});

function newSandbox(): Sandbox {
  const created = createSandbox();
  sandboxes.push(created);
  return created;
}

/**
 * Run a child through sweep's funnel with `console.log` silenced — `run()`
 * echoes every command and its output, which is the right behaviour in a sweep
 * and pure noise in a test.
 */
function childSees(variable: string): {exitCode: number | null; value: string} {
  const box = newSandbox();
  const original = console.log;
  console.log = () => {};
  try {
    const result = measureBaseline(['printenv', variable], box.path);
    return {exitCode: result.exitCode, value: result.output};
  } finally {
    console.log = original;
  }
}

describe('sweep child environment', () => {
  test('every child carries the health-notices kill switch', () => {
    // tests/sandbox.ts sets the switch process-wide at module load, so without
    // this line the child would inherit "off" and the test would pass for the
    // wrong reason. Set it to a value that is NOT "off" and watch it be
    // overridden anyway.
    process.env[HEALTH_NOTICES_ENV_VAR] = 'LOUD';

    const seen = childSees(HEALTH_NOTICES_ENV_VAR);
    expect(seen.exitCode).toBe(0);
    expect(seen.value).toBe('off\n');
  });

  test('it is set even when the parent has no value at all', () => {
    delete process.env[HEALTH_NOTICES_ENV_VAR];

    const seen = childSees(HEALTH_NOTICES_ENV_VAR);
    expect(seen.exitCode).toBe(0);
    expect(seen.value).toBe('off\n');
  });

  test('the rest of the environment still reaches the child', () => {
    // The fix must be an ADDITION to process.env, not a replacement of it: a
    // child without PATH cannot run `bunx` or `bun` at all.
    const parentPath = process.env.PATH;
    expect(parentPath).toBeString();
    const seen = childSees('PATH');
    expect(seen.exitCode).toBe(0);
    expect(seen.value.trimEnd()).toBe(parentPath ?? '');
  });

  test('printenv really does fail on an unset variable (the control)', () => {
    // Without this, "the child saw off" would be indistinguishable from
    // "printenv always exits 0 and prints nothing".
    const seen = childSees('JUSTIN_SDK_A_VARIABLE_NOBODY_SETS');
    expect(seen.exitCode).toBe(1);
    expect(seen.value).toBe('');
  });
});
