/**
 * Tests for --fix approval gating.
 *
 * Verifies that fixes marked `requiresApproval: true` are skipped by default
 * and only run when `yes: true` is passed.
 */

import {describe, test, expect, afterEach} from 'bun:test';
import {existsSync, readFileSync} from 'fs';
import {join} from 'path';

import type {CheckNode} from '../src/check-runner';
import {runCheckTree} from '../src/check-runner';

import {createSandbox, type Sandbox} from './sandbox';

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

describe('check-runner approval gating', () => {
  test('auto-fix runs project-local fixes without --yes', async () => {
    const sb = track(createSandbox());
    const markerFile = join(sb.path, 'marker.txt');

    let checked = false;
    const nodes: CheckNode[] = [
      {
        check: {
          label: 'MARKER',
          fn: () => {
            checked = true;
            if (existsSync(markerFile)) return {pass: true};
            return {
              fix: 'Create marker file',
              fixCommand: `touch '${markerFile}'`,
              message: 'marker missing',
              pass: false,
            };
          },
        },
      },
    ];

    const exitCode = await runCheckTree(nodes, {fix: true, quiet: true});
    expect(exitCode).toBe(0);
    expect(checked).toBe(true);
    expect(existsSync(markerFile)).toBe(true);
  });

  test('requiresApproval fix is skipped without --yes', async () => {
    const sb = track(createSandbox());
    const markerFile = join(sb.path, 'install-marker.txt');

    const nodes: CheckNode[] = [
      {
        check: {
          label: 'INSTALL',
          fn: () => {
            if (existsSync(markerFile)) return {pass: true};
            return {
              fix: 'Pretend to install something',
              fixCommand: `touch '${markerFile}'`,
              message: 'not installed',
              pass: false,
              requiresApproval: true,
            };
          },
        },
      },
    ];

    const exitCode = await runCheckTree(nodes, {fix: true, quiet: true});
    // Exit is 1 because the check still fails (we didn't fix it)
    expect(exitCode).toBe(1);
    // And the fix did not run
    expect(existsSync(markerFile)).toBe(false);
  });

  test('requiresApproval fix runs with yes: true', async () => {
    const sb = track(createSandbox());
    const markerFile = join(sb.path, 'install-marker.txt');

    const nodes: CheckNode[] = [
      {
        check: {
          label: 'INSTALL',
          fn: () => {
            if (existsSync(markerFile)) return {pass: true};
            return {
              fix: 'Pretend to install something',
              fixCommand: `touch '${markerFile}'`,
              message: 'not installed',
              pass: false,
              requiresApproval: true,
            };
          },
        },
      },
    ];

    const exitCode = await runCheckTree(nodes, {
      fix: true,
      quiet: true,
      yes: true,
    });
    expect(exitCode).toBe(0);
    expect(existsSync(markerFile)).toBe(true);
  });

  test('mixed: auto-fixes run, approval fixes skipped without --yes', async () => {
    const sb = track(createSandbox());
    const localMarker = join(sb.path, 'local.txt');
    const installMarker = join(sb.path, 'install.txt');

    const nodes: CheckNode[] = [
      {
        check: {
          label: 'LOCAL',
          fn: () => {
            if (existsSync(localMarker)) return {pass: true};
            return {
              fix: 'Create local file',
              fixCommand: `touch '${localMarker}'`,
              message: 'missing',
              pass: false,
            };
          },
        },
      },
      {
        check: {
          label: 'INSTALL',
          fn: () => {
            if (existsSync(installMarker)) return {pass: true};
            return {
              fix: 'Install something',
              fixCommand: `touch '${installMarker}'`,
              message: 'not installed',
              pass: false,
              requiresApproval: true,
            };
          },
        },
      },
    ];

    await runCheckTree(nodes, {fix: true, quiet: true});
    expect(existsSync(localMarker)).toBe(true);
    expect(existsSync(installMarker)).toBe(false);
  });

  test('mixed: both run with yes: true', async () => {
    const sb = track(createSandbox());
    const localMarker = join(sb.path, 'local.txt');
    const installMarker = join(sb.path, 'install.txt');

    const nodes: CheckNode[] = [
      {
        check: {
          label: 'LOCAL',
          fn: () => {
            if (existsSync(localMarker)) return {pass: true};
            return {
              fix: 'Create local file',
              fixCommand: `touch '${localMarker}'`,
              message: 'missing',
              pass: false,
            };
          },
        },
      },
      {
        check: {
          label: 'INSTALL',
          fn: () => {
            if (existsSync(installMarker)) return {pass: true};
            return {
              fix: 'Install something',
              fixCommand: `touch '${installMarker}'`,
              message: 'not installed',
              pass: false,
              requiresApproval: true,
            };
          },
        },
      },
    ];

    const exitCode = await runCheckTree(nodes, {
      fix: true,
      quiet: true,
      yes: true,
    });
    expect(exitCode).toBe(0);
    expect(existsSync(localMarker)).toBe(true);
    expect(existsSync(installMarker)).toBe(true);
  });
});
