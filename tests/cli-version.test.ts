/**
 * `justin-sdk --version` prints the RUNNING SDK's version (home-base-ovzv O1).
 *
 * MEASURED BUG this is the regression test for: with no explicit `.version()`,
 * yargs guessed — walking up from its own `node_modules/yargs` to the workspace
 * root's package.json — and printed `0.1.0` for the 0.28.1 SDK, from the SDK
 * directory AND from an unrelated cwd (2026-09-12). A fleet sweep that ran that
 * day had no way to say which code it was propagating, and `--version` was the
 * one thing that should have answered.
 *
 * Spawns the REAL cli.ts, because the wiring under test IS the yargs
 * configuration.
 */

import {describe, expect, test} from 'bun:test';
import {spawnSync} from 'child_process';
import {resolve} from 'path';

import {getSdkVersion} from '../src/setup-helpers';
import {createSandbox} from './sandbox';

const CLI = resolve(import.meta.dirname, '..', 'src', 'cli.ts');

describe('justin-sdk --version', () => {
  test('prints the SDK package.json version, from an unrelated cwd', async () => {
    const box = createSandbox();
    try {
      const child = spawnSync(process.execPath, [CLI, '--version'], {
        cwd: box.path,
        encoding: 'utf-8',
        // Hermetic: the health-notice probe has no business on a --version run.
        env: {...process.env, JUSTIN_SDK_HEALTH_NOTICES: 'off'},
        input: '',
      });

      const pkg = (await Bun.file(
        resolve(import.meta.dirname, '..', 'package.json'),
      ).json()) as {version: string};

      expect(child.status).toBe(0);
      expect(child.stdout.trim()).toBe(pkg.version);
      // Both halves, so a future refactor cannot satisfy one and drift the
      // other: the CLI and getSdkVersion() must agree, and that is the same
      // version the SDK_VERSION check and the sweep's pin bump write.
      expect(child.stdout.trim()).toBe(getSdkVersion());
    } finally {
      box.cleanup();
    }
  });
});
