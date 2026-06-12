/**
 * Tests for `justin-sdk fix` (runFix).
 *
 * runFix discovers `fix-source:*` scripts from package.json and runs them via
 * check-runner. Commands here are cwd-independent shell builtins (`true` /
 * `false`) so the tests assert exit-code behavior without depending on any
 * real linter/formatter being installed.
 */

import {afterEach, describe, expect, test} from 'bun:test';

import {runFix} from '../src/fix';
import {createProjectSandbox, createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];

function track(sandbox: Sandbox): Sandbox {
  sandboxes.push(sandbox);
  return sandbox;
}

afterEach(() => {
  while (sandboxes.length > 0) {
    const sb = sandboxes.pop();
    sb?.cleanup();
  }
});

describe('fix (runFix)', () => {
  test('errors (exit 1) when package.json is missing', async () => {
    const sb = track(createSandbox());
    const exit = await runFix(sb.path, {quiet: true});
    expect(exit).toBe(1);
  });

  test('errors (exit 1) when no fix-source:* scripts are present', async () => {
    const sb = track(
      createProjectSandbox({
        packageJson: {name: 'x', scripts: {build: 'true'}},
      }),
    );
    const exit = await runFix(sb.path, {quiet: true});
    expect(exit).toBe(1);
  });

  test('runs all fix-source:* scripts and passes (exit 0) when they succeed', async () => {
    const sb = track(
      createProjectSandbox({
        packageJson: {
          name: 'x',
          scripts: {
            'fix-source:LINT': 'true',
            'fix-source:PRETTIER': 'true',
          },
        },
      }),
    );
    const exit = await runFix(sb.path, {quiet: true});
    expect(exit).toBe(0);
  });

  test('fails (exit 1) when any fixer exits non-zero', async () => {
    const sb = track(
      createProjectSandbox({
        packageJson: {
          name: 'x',
          scripts: {
            'fix-source:LINT': 'true',
            'fix-source:PRETTIER': 'false',
          },
        },
      }),
    );
    const exit = await runFix(sb.path, {quiet: true});
    expect(exit).toBe(1);
  });
});
