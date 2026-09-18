/**
 * Tests for runUpdate.
 *
 * The happy path (real self-update + re-exec) is covered by RIK-4
 * dogfood. These tests cover failure modes and dry-run behavior that
 * don't require network or installed SDK state.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import {join} from 'path';

import {planUpdateReExec, runUpdate} from '../src/update';
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

describe('planUpdateReExec — the post-self-update re-exec (dchjw.17 F4)', () => {
  const FLAGS = {
    allowDirty: false,
    force: false,
    noCommit: false,
    quiet: false,
  };

  test("runs the REPO'S OWN binary, by absolute path", () => {
    const sb = track(createProjectSandbox());
    const bin = join(sb.path, 'node_modules', '.bin', 'justin-sdk');
    mkdirSync(join(sb.path, 'node_modules', '.bin'), {recursive: true});
    writeFileSync(bin, '#!/bin/sh\nexit 0\n');
    chmodSync(bin, 0o755);

    const plan = planUpdateReExec(sb.path, FLAGS);
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error('unreachable');
    expect(plan.argv[0]).toBe(bin);
    expect(plan.argv).toContain('--no-self-update');
    // The old spelling, which is what fell through to the PATH shim.
    expect(plan.argv.slice(0, 3)).not.toEqual(['bun', 'run', 'justin-sdk']);
  });

  test('REFUSES when the worktree has no SDK binary — naming the path', () => {
    const sb = track(createProjectSandbox());
    const plan = planUpdateReExec(sb.path, FLAGS);
    expect(plan.ok).toBe(false);
    if (plan.ok) throw new Error('unreachable');
    expect(plan.detail).toContain(
      join(sb.path, 'node_modules', '.bin', 'justin-sdk'),
    );
    expect(plan.detail).toContain('Refusing to fall back');
  });

  test('NEGATIVE CONTROL: a justin-sdk shim on PATH does not satisfy it', () => {
    // Under the old `sdkRunArgv` spelling this is exactly the shape that ran
    // the orchestrator's SDK and exited 0. The refusal must be about THIS
    // repo's node_modules, and nothing on PATH may change the answer.
    const sb = track(createProjectSandbox());
    const shimDir = join(sb.path, 'fake-path');
    mkdirSync(shimDir, {recursive: true});
    const shim = join(shimDir, 'justin-sdk');
    writeFileSync(shim, '#!/bin/sh\necho THE SHIM RAN\n');
    chmodSync(shim, 0o755);

    const originalPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${originalPath ?? ''}`;
    try {
      const plan = planUpdateReExec(sb.path, FLAGS);
      expect(plan.ok).toBe(false);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test('passes the flags the user cared about through', () => {
    const sb = track(createProjectSandbox());
    mkdirSync(join(sb.path, 'node_modules', '.bin'), {recursive: true});
    const bin = join(sb.path, 'node_modules', '.bin', 'justin-sdk');
    writeFileSync(bin, '#!/bin/sh\nexit 0\n');
    chmodSync(bin, 0o755);

    const plan = planUpdateReExec(sb.path, {
      allowDirty: true,
      force: true,
      noCommit: true,
      quiet: true,
    });
    if (!plan.ok) throw new Error('unreachable');
    expect(plan.argv).toEqual([
      bin,
      'update',
      '--no-self-update',
      '--no-commit',
      '--allow-dirty',
      '--force',
      '--quiet',
    ]);
    // update NEVER prunes: it is install with a pin bump in front, and install
    // does not remove (dchjw.17 F1/F2).
    expect(plan.argv).not.toContain('--prune');
  });
});

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
