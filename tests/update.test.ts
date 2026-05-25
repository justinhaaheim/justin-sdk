/**
 * Tests for runUpdate.
 *
 * The happy path (real self-update + re-exec) is covered by RIK-4
 * dogfood. These tests cover failure modes and dry-run behavior that
 * don't require network or installed SDK state.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {existsSync, readFileSync, writeFileSync} from 'fs';
import {join} from 'path';

import {runUpdate} from '../src/update';
import {createProjectSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];

afterEach(() => {
  while (sandboxes.length > 0) {
    const sb = sandboxes.pop();
    sb?.cleanup();
  }
});

function track(sb: Sandbox): Sandbox {
  sandboxes.push(sb);
  return sb;
}

describe('runUpdate', () => {
  test('bails when justin-sdk.config.json is missing', async () => {
    const sb = track(createProjectSandbox());

    const exitCode = await runUpdate({
      projectRoot: sb.path,
      noSelfUpdate: true,
      noCommit: true,
      quiet: true,
    });

    expect(exitCode).toBe(1);
  });

  test('dry-run on a configured project does not modify any files', async () => {
    const sb = track(createProjectSandbox());
    const configPath = join(sb.path, 'justin-sdk.config.json');
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          version: '0.0.1',
          components: ['base-setup'],
          lastSynced: '2000-01-01',
        },
        null,
        2,
      ),
    );
    const before = readFileSync(configPath, 'utf-8');

    const exitCode = await runUpdate({
      projectRoot: sb.path,
      noSelfUpdate: true,
      noCommit: true,
      dryRun: true,
      allowDirty: true,
      quiet: true,
    });

    expect(exitCode).toBe(0);
    // Config should be byte-identical
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
  });

  test('unknown components in config are skipped with a warning, not a failure', async () => {
    const sb = track(createProjectSandbox());
    writeFileSync(
      join(sb.path, 'justin-sdk.config.json'),
      JSON.stringify(
        {
          version: '0.0.1',
          components: ['totally-fake-component'],
          lastSynced: '2000-01-01',
        },
        null,
        2,
      ),
    );

    const exitCode = await runUpdate({
      projectRoot: sb.path,
      noSelfUpdate: true,
      noCommit: true,
      dryRun: true,
      allowDirty: true,
      quiet: true,
    });

    expect(exitCode).toBe(0);
  });

  test('refuses to run on a dirty tree without --allow-dirty', async () => {
    // The sandbox project has no git history, so any file is "untracked".
    // We use git init to make `git status --porcelain` produce output,
    // then run without allowDirty and expect a non-zero exit.
    const sb = track(createProjectSandbox());
    writeFileSync(
      join(sb.path, 'justin-sdk.config.json'),
      JSON.stringify({version: '0.0.1', components: []}, null, 2),
    );
    // git init + untracked file → dirty
    const {execSync} = await import('child_process');
    execSync('git init', {cwd: sb.path, stdio: 'ignore'});
    writeFileSync(join(sb.path, 'README.md'), 'hello');

    const exitCode = await runUpdate({
      projectRoot: sb.path,
      noSelfUpdate: true,
      noCommit: true,
      quiet: true,
    });

    expect(exitCode).toBe(1);
  });
});

describe('runUpdate (config integrity)', () => {
  test('non-dry run with no components leaves config valid (no crash)', async () => {
    const sb = track(createProjectSandbox());
    writeFileSync(
      join(sb.path, 'justin-sdk.config.json'),
      JSON.stringify({version: '0.0.1', components: []}, null, 2),
    );
    // Make tree clean by avoiding git entirely; runUpdate's git status
    // call exits non-zero (no .git), which leaves treeWasDirty=false.

    const exitCode = await runUpdate({
      projectRoot: sb.path,
      noSelfUpdate: true,
      noCommit: true,
      quiet: true,
    });

    expect(exitCode).toBe(0);
    expect(existsSync(join(sb.path, 'justin-sdk.config.json'))).toBe(true);
  });
});
