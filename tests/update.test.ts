/**
 * Tests for runUpdate.
 *
 * The self-update + re-exec path runs with the tag lookup and the bump faked
 * (home-base-ipx4a), so nothing here reaches the network. The rest covers
 * failure modes and dry-run behavior.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {spawnSync} from 'child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import {join} from 'path';

import {planUpdateReExec, runUpdate} from '../src/update';
import {createProjectSandbox, createSandbox, type Sandbox} from './sandbox';
import {
  captureConsole,
  fakeGoodBump,
  fakeLatestTag,
  fakeStaleBump,
  git,
  initConsumerRepo,
  lockfileText,
  lockPinLine,
  NEW_TAG,
  OLD_TAG,
  packageJsonObject,
  pinSpec,
  writeBumpedPin,
} from './update-fixtures';

const PARENT_DRIVER = join(
  import.meta.dirname,
  'fixtures',
  'update-reexec-parent.ts',
);

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

  test('passes --commit through when the parent commits (the CLI defaults to no commit)', () => {
    const sb = track(createProjectSandbox());
    mkdirSync(join(sb.path, 'node_modules', '.bin'), {recursive: true});
    const bin = join(sb.path, 'node_modules', '.bin', 'justin-sdk');
    writeFileSync(bin, '#!/bin/sh\nexit 0\n');
    chmodSync(bin, 0o755);

    const plan = planUpdateReExec(sb.path, FLAGS);
    if (!plan.ok) throw new Error('unreachable');
    expect(plan.argv).toEqual([bin, 'update', '--no-self-update', '--commit']);
  });
});

describe('runUpdate', () => {
  test('bails when justin-sdk.config.json is missing', async () => {
    const sb = track(createProjectSandbox());

    const exitCode = await runUpdate({
      noCommit: true,
      noSelfUpdate: true,
      projectRoot: sb.path,
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
          components: ['base-setup'],
          lastSynced: '2000-01-01',
          version: '0.0.1',
        },
        null,
        2,
      ),
    );
    const before = readFileSync(configPath, 'utf-8');

    const exitCode = await runUpdate({
      allowDirty: true,
      dryRun: true,
      noCommit: true,
      noSelfUpdate: true,
      projectRoot: sb.path,
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
          components: ['totally-fake-component'],
          lastSynced: '2000-01-01',
          version: '0.0.1',
        },
        null,
        2,
      ),
    );

    const exitCode = await runUpdate({
      allowDirty: true,
      dryRun: true,
      noCommit: true,
      noSelfUpdate: true,
      projectRoot: sb.path,
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
      JSON.stringify({components: [], version: '0.0.1'}, null, 2),
    );
    // git init + untracked file → dirty
    const {execSync} = await import('child_process');
    execSync('git init', {cwd: sb.path, stdio: 'ignore'});
    writeFileSync(join(sb.path, 'README.md'), 'hello');

    const exitCode = await runUpdate({
      noCommit: true,
      noSelfUpdate: true,
      projectRoot: sb.path,
      quiet: true,
    });

    expect(exitCode).toBe(1);
  });
});

const DIRTY_MESSAGE =
  'Working tree has uncommitted changes. Re-run with --allow-dirty (no final commit) or commit/stash first.';

function commitCount(root: string): number {
  return Number(git(root, ['rev-list', '--count', 'HEAD']).trim());
}

function committedRepo(): string {
  const sb = track(createSandbox());
  initConsumerRepo(sb.path);
  return sb.path;
}

describe('runUpdate preflight: the SDK pin is not dirt (home-base-ipx4a D1)', () => {
  test('the re-exec child goes on past its parent’s bump, and commits it with the reconcile', async () => {
    // What the child sees: the parent bumped the pin, then re-executed with
    // --no-self-update, the only flag an OLD parent passes.
    const root = committedRepo();
    writeBumpedPin(root, NEW_TAG);
    const {output, result} = await captureConsole(() =>
      runUpdate({noSelfUpdate: true, projectRoot: root}),
    );
    expect(result).toBe(0);
    expect(output).not.toContain(DIRTY_MESSAGE);
    expect(output).toContain('The only uncommitted change is the SDK pin');
    expect(commitCount(root)).toBe(2);
    expect(git(root, ['status', '--porcelain'])).toBe('');
    const committed = git(root, ['show', '--name-only', '--format=', 'HEAD']);
    expect(committed).toContain('package.json');
    expect(committed).toContain('bun.lock');
    expect(git(root, ['show', 'HEAD:package.json'])).toContain(
      pinSpec(NEW_TAG),
    );
  });

  test('REFUSES the pin bump plus an unrelated package.json edit, with today’s message', async () => {
    const root = committedRepo();
    const pkg = packageJsonObject(NEW_TAG);
    pkg.scripts = {build: 'echo build', extra: 'echo mine'};
    writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2));
    writeFileSync(join(root, 'bun.lock'), lockfileText(NEW_TAG));
    const {output, result} = await captureConsole(() =>
      runUpdate({noSelfUpdate: true, projectRoot: root}),
    );
    expect(result).toBe(1);
    expect(output).toContain(DIRTY_MESSAGE);
    expect(output).toContain('package.json changes more than the SDK pin');
    expect(commitCount(root)).toBe(1);
  });

  test('REFUSES the pin bump plus an unrelated tracked file, with today’s message', async () => {
    const root = committedRepo();
    writeBumpedPin(root, NEW_TAG);
    writeFileSync(join(root, 'README.md'), '# my uncommitted work\n');
    const {output, result} = await captureConsole(() =>
      runUpdate({noSelfUpdate: true, projectRoot: root}),
    );
    expect(result).toBe(1);
    expect(output).toContain(DIRTY_MESSAGE);
    expect(output).toContain('README.md has uncommitted changes');
    expect(commitCount(root)).toBe(1);
  });

  test('a parent run on other dirt refuses before it bumps anything', async () => {
    const root = committedRepo();
    writeFileSync(join(root, 'README.md'), '# my uncommitted work\n');
    const calls: (readonly string[])[] = [];
    const {output, result} = await captureConsole(() =>
      runUpdate({
        projectRoot: root,
        selfUpdateDeps: {
          fetchLatestTag: fakeLatestTag(),
          runBump: fakeGoodBump(calls),
        },
      }),
    );
    expect(result).toBe(1);
    expect(output).toContain(DIRTY_MESSAGE);
    expect(calls).toEqual([]);
  });
});

describe('runUpdate after a bump that did not install its tag (home-base-ipx4a D2)', () => {
  test('exits non-zero, names both versions, and never says Bumped or Re-executing', async () => {
    const root = committedRepo();
    const {output, result} = await captureConsole(() =>
      runUpdate({
        projectRoot: root,
        selfUpdateDeps: {
          fetchLatestTag: fakeLatestTag(),
          runBump: fakeStaleBump(),
        },
      }),
    );
    expect(result).toBe(1);
    expect(output).toContain('holds version 0.1.0, not v0.2.0');
    expect(output).toContain('bun update @justinhaaheim/justin-sdk');
    expect(output).not.toContain('Bumped');
    expect(output).not.toContain('Re-executing');
    // Nothing was reconciled or committed on the strength of the wrong SDK.
    expect(output).not.toContain('Reconcile components');
    expect(commitCount(root)).toBe(1);
  });
});

describe('update in ONE invocation: bump, re-exec, reconcile, commit (home-base-ipx4a acceptance 1)', () => {
  test(
    'a clean repo one tag behind ends on a clean tree with the pin committed',
    () => {
      // The parent is the real runUpdate with only the tag lookup and the bump
      // faked (tests/fixtures/update-reexec-parent.ts). The child it re-execs
      // is node_modules/.bin/justin-sdk, which runs THIS checkout's CLI.
      const sb = track(createSandbox());
      initConsumerRepo(sb.path, {sdkBin: true});
      const run = spawnSync(process.execPath, [PARENT_DRIVER, sb.path], {
        cwd: sb.path,
        encoding: 'utf-8',
        env: process.env,
      });
      const output = `${run.stdout}\n${run.stderr}`;
      expect({output, status: run.status}).toMatchObject({status: 0});
      expect(output).toContain(
        `Bumped @justinhaaheim/justin-sdk: 0.1.0 → ${NEW_TAG}`,
      );
      expect(output).toContain(`Re-executing with new SDK (${NEW_TAG})`);
      expect(output).not.toContain(DIRTY_MESSAGE);
      expect(output).toContain('The only uncommitted change is the SDK pin');
      expect(output).toContain('Committed sync');
      expect(git(sb.path, ['status', '--porcelain'])).toBe('');
      expect(commitCount(sb.path)).toBe(2);
      const committed = git(sb.path, [
        'show',
        '--name-only',
        '--format=',
        'HEAD',
      ]);
      expect(committed).toContain('package.json');
      expect(committed).toContain('bun.lock');
      const lock = git(sb.path, ['show', 'HEAD:bun.lock']);
      expect(lock.split(lockPinLine(NEW_TAG)).length - 1).toBe(1);
      expect(lock).not.toContain(lockPinLine(OLD_TAG));
    },
    {timeout: 60_000},
  );
});

describe('runUpdate (config integrity)', () => {
  test('non-dry run with no components leaves config valid (no crash)', async () => {
    const sb = track(createProjectSandbox());
    writeFileSync(
      join(sb.path, 'justin-sdk.config.json'),
      JSON.stringify({components: [], version: '0.0.1'}, null, 2),
    );
    // Make tree clean by avoiding git entirely; runUpdate's git status
    // call exits non-zero (no .git), which leaves treeWasDirty=false.

    const exitCode = await runUpdate({
      noCommit: true,
      noSelfUpdate: true,
      projectRoot: sb.path,
      quiet: true,
    });

    expect(exitCode).toBe(0);
    expect(existsSync(join(sb.path, 'justin-sdk.config.json'))).toBe(true);
  });
});
