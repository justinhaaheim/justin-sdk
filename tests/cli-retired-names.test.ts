/**
 * The retired command names and flags produce an ORDINARY usage error
 * (epic home-base-dchjw.9, 2026-09-18).
 *
 * Each of these had its one release of being accepted as a silent no-op or a
 * rewritten alias, and that grace period is what these tests close. The failure
 * they guard against is not a crash — it is the opposite: a dead spelling that
 * keeps quietly working, so every caller that types it goes on believing it is
 * current and the removal never actually lands.
 *
 * Driven through the real CLI, because the thing under test is yargs'
 * `.strict()` + `demandCommand` behaviour, not a function we could call.
 *
 * CWD IS A THROWAWAY DIRECTORY on purpose: if any of these somehow still
 * resolved to a real command, it would be `setup-env` or `worktree-new`, and
 * both write. An empty sandbox is where that is harmless and visible.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {spawnSync} from 'child_process';
import {resolve} from 'path';

import {createSandbox, type Sandbox} from './sandbox';

const CLI = resolve(import.meta.dirname, '..', 'src', 'cli.ts');

const sandboxes: Sandbox[] = [];
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

function runCli(args: string[]): {
  status: number | null;
  stderr: string;
  stdout: string;
} {
  const box = createSandbox();
  sandboxes.push(box);
  const run = spawnSync(process.execPath, [CLI, ...args], {
    cwd: box.path,
    encoding: 'utf-8',
    // The health-notice middleware would otherwise reach the network in front
    // of every one of these.
    env: {...process.env, JUSTIN_SDK_HEALTH_NOTICES: 'off'},
  });
  return {
    status: run.status,
    stderr: run.stderr ?? '',
    stdout: run.stdout ?? '',
  };
}

describe('retired command names', () => {
  test('`ralph` is an unknown command, not a rewrite of justin-loop', () => {
    // No `--help` here: yargs answers --help BEFORE it rejects an unknown
    // command, so `ralph --help` exits 0 printing the top-level help for any
    // unknown word. The bare word is what actually asks "is this a command?".
    const run = runCli(['ralph']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('ralph');
    expect(run.stderr).toMatch(/Unknown argument/);
    // The old behaviour, precisely: it printed this line and then ran
    // justin-loop's own --help on stdout.
    expect(run.stderr).not.toContain('ralph is now justin-loop');
    expect(run.stdout).toBe('');
  });

  test('`worktree-setup` is an unknown command, not an alias for setup-env', () => {
    const run = runCli(['worktree-setup', '--dry-run']);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/Unknown arguments?:.*worktree-setup/);
    expect(run.stdout).toBe('');
  });

  test('NEGATIVE CONTROL: `setup-env --help` is still a live command', () => {
    // Without this, every assertion above would pass just as well if the CLI
    // were broken outright, or if `--help` alone were the thing failing.
    const run = runCli(['setup-env', '--help']);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Hydrate this checkout');
    // …and it no longer advertises the alias.
    expect(run.stdout).not.toContain('worktree-setup');
  });
});

describe('retired v170 tier flags', () => {
  for (const flag of ['--lint', '--js', '--native']) {
    test(`\`setup-env ${flag}\` is an unknown option, not a silent no-op`, () => {
      const run = runCli(['setup-env', flag, '--dry-run']);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(`Unknown argument`);
      // The old behaviour: accepted, hidden, and warned about on stderr while
      // the command went ahead and ran.
      expect(run.stderr).not.toContain('the tier system was removed');
      expect(run.stdout).toBe('');
    });
  }

  test('`worktree-new` rejects them too', () => {
    const run = runCli(['worktree-new', 'probe', '--native', '--no-setup']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Unknown argument');
    expect(run.stdout).toBe('');
  });
});
