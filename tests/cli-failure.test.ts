/**
 * The CLI's failure path (home-base-uxwc.5 F1).
 *
 * ONE CONTRACT: a failing justin-sdk command writes NOTHING to stdout. The `wt`
 * shell function `cd`s into whatever `worktree-new` printed on stdout and the
 * justin-loop runner parses the bead id `justin-loop handoff` printed there, so
 * a stray byte is a real bug — and yargs 18's default failure path emits one as
 * soon as any middleware is async, which the health-notice middleware is.
 *
 * Two levels, because neither alone is enough:
 *
 *  - the REAL cli.ts, so the handler being REGISTERED is under test;
 *  - a fixture CLI (throwing-cli-fixture.ts) with a handler that throws, which
 *    no real command does on demand — with its own control run that shows the
 *    byte appearing when the handler is left off.
 */

import {describe, expect, test} from 'bun:test';
import {spawnSync} from 'child_process';
import {resolve} from 'path';

import {createSandbox} from './sandbox';

const CLI = resolve(import.meta.dirname, '..', 'src', 'cli.ts');
const FIXTURE = resolve(import.meta.dirname, 'throwing-cli-fixture.ts');

function run(
  script: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): {status: number | null; stderr: string; stdout: string} {
  const box = createSandbox();
  try {
    const child = spawnSync(process.execPath, [script, ...args], {
      cwd: box.path,
      encoding: 'utf-8',
      env: {...process.env, ...extraEnv},
      input: '',
    });
    return {status: child.status, stderr: child.stderr, stdout: child.stdout};
  } finally {
    box.cleanup();
  }
}

describe('the real CLI', () => {
  test('an unknown command writes NOTHING to stdout and exits 1', () => {
    const {status, stderr, stdout} = run(CLI, ['no-such-command']);
    expect(stdout).toBe('');
    expect(status).toBe(1);
    // The reason, and the help to act on it, both on stderr.
    expect(stderr).toContain('Unknown argument: no-such-command');
    expect(stderr).toContain('justin-sdk <command>');
  });

  test('a missing positional writes NOTHING to stdout and exits 1', () => {
    const {status, stderr, stdout} = run(CLI, ['eas-update']);
    expect(stdout).toBe('');
    expect(status).toBe(1);
    expect(stderr).toContain('Not enough non-option arguments');
  });

  test('--help still goes to STDOUT and exits 0', () => {
    // The failure handler must not have swallowed the successful help path.
    const {status, stderr, stdout} = run(CLI, ['--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('justin-sdk <command>');
    expect(stderr).toBe('');
  });
});

describe('a handler that throws', () => {
  test('writes NOTHING to stdout, prints the stack on stderr, exits 1', () => {
    const {status, stderr, stdout} = run(FIXTURE, ['boom']);
    expect(stdout).toBe('');
    expect(status).toBe(1);
    expect(stderr).toContain('Error: boom from a sync handler');
    // The STACK, not just the message: an unplanned exception is a bug report.
    expect(stderr).toContain('throwing-cli-fixture.ts');
  });

  test('CONTROL: without the handler, yargs puts a byte on stdout', () => {
    // This is what cli.ts did before F1, and it is the whole reason the handler
    // exists. If this ever stops being true, the test above is proving nothing.
    const {status, stdout} = run(FIXTURE, ['boom'], {
      JSDK_FIXTURE_NO_FAIL: '1',
    });
    expect(stdout).toBe('\n');
    expect(status).toBe(1);
  });

  test('a command that does NOT throw still prints its stdout line', () => {
    const {status, stdout} = run(FIXTURE, ['fine']);
    expect(stdout).toBe('one stdout line\n');
    expect(status).toBe(0);
  });
});
