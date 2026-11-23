/**
 * `justin-sdk signing-guard` (home-base-di8c7.1): the options, the exit codes
 * (0, 3, 4), and the command after `--`, through the real yargs definition
 * with every effect injected (makeSigningGuardCommand). No test reads the real
 * screen, sleeps for real or runs the guarded command. The one test that runs
 * the real CLI is `--help`, which must exit 0 and run nothing.
 */

import type {CommandExit, ScreenLockState} from '../src/signing-guard';

import {describe, expect, test} from 'bun:test';
import {spawnSync} from 'child_process';
import {existsSync, mkdtempSync, rmSync} from 'fs';
import {tmpdir} from 'os';
import {join, resolve} from 'path';
import yargs from 'yargs';

import {
  commandAfterDashes,
  makeSigningGuardCommand,
} from '../src/signing-guard-command';

const LOCKED: ScreenLockState = {
  reason: '`ioreg -n Root -d1` reports "CGSSessionScreenIsLocked"=Yes',
  state: 'locked',
};
const UNLOCKED: ScreenLockState = {state: 'unlocked'};
const UNKNOWN: ScreenLockState = {
  reason: '`ioreg -n Root -d1` failed: it did not finish within 5 s',
  state: 'unknown',
};

interface CliRun {
  exitCode: number | null;
  failures: string[];
  reads: number;
  sleeps: number[];
  spawned: [string, readonly string[]][];
  stderr: string[];
  stdout: string[];
}

/** Run `args` through the real command definition with a fake world. */
async function cli(
  args: string[],
  states: ScreenLockState[],
  options: {
    env?: Record<string, string>;
    spawnResult?: CommandExit;
  } = {},
): Promise<CliRun> {
  let clockMs = 0;
  let index = 0;
  const run: CliRun = {
    exitCode: null,
    failures: [],
    reads: 0,
    sleeps: [],
    spawned: [],
    stderr: [],
    stdout: [],
  };
  const command = makeSigningGuardCommand({
    cli: {
      env: options.env ?? {},
      now: () => clockMs,
      readState: () => {
        run.reads += 1;
        const state = states[Math.min(index, states.length - 1)] ?? UNKNOWN;
        index += 1;
        return state;
      },
      sleep: (seconds) => {
        run.sleeps.push(seconds);
        clockMs += seconds * 1000;
      },
      spawn: (program, programArgs) => {
        run.spawned.push([program, programArgs]);
        return options.spawnResult ?? {code: 0, status: 'exited'};
      },
      stderr: (line) => {
        run.stderr.push(line);
      },
      stdout: (line) => {
        run.stdout.push(line);
      },
    },
    exit: (code) => {
      run.exitCode = code;
    },
    rawArgv: () => args,
  });
  // The real CLI's .fail (reportCliFailure) exits the process, so nothing runs
  // after a usage error. A .fail that returns lets yargs go on to the handler,
  // so this one throws, like the real one never returns.
  const usageError = new Error('usage error');
  try {
    await yargs(args)
      .command(command)
      .strict()
      .exitProcess(false)
      .fail((message, error) => {
        // yargs calls .fail again with the error thrown here; record it once.
        if (error !== usageError) run.failures.push(message ?? error.message);
        throw usageError;
      })
      .parseAsync();
  } catch (error) {
    if (error !== usageError) throw error;
  }
  return run;
}

const sum = (values: number[]): number =>
  values.reduce((total, value) => total + value, 0);

/** expect.stringMatching, typed for a string[] comparison. */
function matching(pattern: RegExp): string {
  return expect.stringMatching(pattern) as unknown as string;
}

describe('signing-guard --status', () => {
  test('unlocked prints "unlocked" and exits 0', async () => {
    const run = await cli(['signing-guard', '--status'], [UNLOCKED]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toEqual(['unlocked']);
    expect(run.stderr).toEqual([]);
  });

  test('locked prints the reason and exits 3, without waiting', async () => {
    const run = await cli(['signing-guard', '--status'], [LOCKED, UNLOCKED]);
    expect(run.exitCode).toBe(3);
    expect(run.stdout).toEqual([`locked: ${LOCKED.reason}`]);
    expect(run.sleeps).toEqual([]);
    expect(run.reads).toBe(1);
  });

  test('unknown prints the reason and exits 4', async () => {
    const run = await cli(['signing-guard', '--status'], [UNKNOWN]);
    expect(run.exitCode).toBe(4);
    expect(run.stdout).toEqual([
      'unknown: `ioreg -n Root -d1` failed: it did not finish within 5 s',
    ]);
  });

  test('runs nothing, even with a command after --', async () => {
    const run = await cli(
      ['signing-guard', '--status', '--', 'echo', 'ok'],
      [UNLOCKED],
    );
    expect(run.exitCode).toBe(0);
    expect(run.spawned).toEqual([]);
  });

  test('with the guard off it still reads the state, and says the guard is off', async () => {
    const run = await cli(['signing-guard', '--status'], [LOCKED], {
      env: {JUSTIN_SDK_SIGNING_GUARD: 'off'},
    });
    expect(run.exitCode).toBe(3);
    expect(run.reads).toBe(1);
    expect(run.stderr).toEqual([matching(/JUSTIN_SDK_SIGNING_GUARD=off/)]);
  });
});

describe('signing-guard (bare check)', () => {
  test('unlocked exits 0 and prints nothing', async () => {
    const run = await cli(['signing-guard'], [UNLOCKED]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toEqual([]);
    expect(run.stderr).toEqual([]);
  });

  test('locked waits for the unlock, then exits 0', async () => {
    const run = await cli(['signing-guard'], [LOCKED, LOCKED, UNLOCKED]);
    expect(run.exitCode).toBe(0);
    expect(run.sleeps).toEqual([5, 5]);
    expect(run.stderr).toHaveLength(2);
    expect(run.stderr[0]).toContain('is waiting to start');
    expect(run.stderr[1]).toContain('after waiting 10 s');
  });

  test('--no-wait exits 3 at once when locked', async () => {
    const run = await cli(['signing-guard', '--no-wait'], [LOCKED, UNLOCKED]);
    expect(run.exitCode).toBe(3);
    expect(run.sleeps).toEqual([]);
    expect(run.stderr).toEqual([
      matching(/^\[signing-guard\] The screen is locked .* did not start/),
    ]);
  });

  test('the wait lasts 30 minutes by default, then exits 3', async () => {
    const run = await cli(['signing-guard'], [LOCKED]);
    expect(run.exitCode).toBe(3);
    expect(sum(run.sleeps)).toBe(1800);
    expect(run.stderr.at(-1)).toContain('still locked after 30 min');
  });

  test('--max-wait sets the limit in minutes', async () => {
    const run = await cli(['signing-guard', '--max-wait', '1'], [LOCKED]);
    expect(run.exitCode).toBe(3);
    expect(sum(run.sleeps)).toBe(60);
    expect(run.stderr.at(-1)).toContain('still locked after 1 min');
  });

  test('an unreadable state exits 4', async () => {
    const run = await cli(['signing-guard'], [UNKNOWN]);
    expect(run.exitCode).toBe(4);
    expect(run.stderr.at(-1)).toContain('JUSTIN_SDK_SIGNING_GUARD=off');
  });
});

describe('signing-guard -- <command>', () => {
  test('unlocked runs the command and exits with its exit code', async () => {
    const ok = await cli(['signing-guard', '--', 'echo', 'ok'], [UNLOCKED]);
    expect(ok.spawned).toEqual([['echo', ['ok']]]);
    expect(ok.exitCode).toBe(0);
    const seven = await cli(['signing-guard', '--', 'false'], [UNLOCKED], {
      spawnResult: {code: 7, status: 'exited'},
    });
    expect(seven.exitCode).toBe(7);
  });

  test('passes the command on exactly as typed, flags and numbers included', async () => {
    // yargs would turn 0x10 into 16 and read --no-wait as its own flag.
    const run = await cli(
      [
        'signing-guard',
        '--',
        'printf',
        '0x10',
        '007',
        '--device',
        '-n',
        '--help',
        '--no-wait',
      ],
      [LOCKED, UNLOCKED],
    );
    expect(run.spawned).toEqual([
      ['printf', ['0x10', '007', '--device', '-n', '--help', '--no-wait']],
    ]);
    // The --no-wait after -- belongs to printf: the guard waited.
    expect(run.sleeps).toEqual([5]);
    expect(run.exitCode).toBe(0);
  });

  test('locked with --no-wait exits 3 and never runs the command', async () => {
    const run = await cli(
      ['signing-guard', '--no-wait', '--', 'echo', 'ok'],
      [LOCKED],
    );
    expect(run.exitCode).toBe(3);
    expect(run.spawned).toEqual([]);
  });

  test('locked past --max-wait exits 3 and never runs the command', async () => {
    const run = await cli(
      ['signing-guard', '--max-wait', '0.5', '--', 'echo', 'ok'],
      [LOCKED],
    );
    expect(run.exitCode).toBe(3);
    expect(sum(run.sleeps)).toBe(30);
    expect(run.spawned).toEqual([]);
  });

  test('unknown exits 4 and never runs the command', async () => {
    const run = await cli(['signing-guard', '--', 'echo', 'ok'], [UNKNOWN]);
    expect(run.exitCode).toBe(4);
    expect(run.spawned).toEqual([]);
  });

  test('a command that cannot start exits 127; one ended by a signal exits 128 + N', async () => {
    const missing = await cli(['signing-guard', '--', 'nope'], [UNLOCKED], {
      spawnResult: {detail: 'spawnSync nope ENOENT', status: 'not-started'},
    });
    expect(missing.exitCode).toBe(127);
    expect(missing.stderr).toEqual([
      '[signing-guard] Could not start `nope`: spawnSync nope ENOENT',
    ]);
    const killed = await cli(
      ['signing-guard', '--', 'sleep', '9'],
      [UNLOCKED],
      {
        spawnResult: {signal: 'SIGTERM', status: 'signalled'},
      },
    );
    expect(killed.exitCode).toBe(143);
  });

  test('with the guard off it runs the command without reading the state', async () => {
    const run = await cli(['signing-guard', '--', 'echo', 'ok'], [LOCKED], {
      env: {JUSTIN_SDK_SIGNING_GUARD: 'off'},
    });
    expect(run.exitCode).toBe(0);
    expect(run.reads).toBe(0);
    expect(run.spawned).toEqual([['echo', ['ok']]]);
    expect(run.stderr).toEqual([
      '[signing-guard] JUSTIN_SDK_SIGNING_GUARD=off, so the screen lock was NOT checked before `echo ok`.',
    ]);
  });
});

describe('usage errors read nothing and run nothing', () => {
  const cases: [string[], RegExp][] = [
    [['signing-guard', 'echo', 'ok'], /Put the command after --/],
    [['signing-guard', '--'], /Nothing to run after --/],
    [
      ['signing-guard', '--max-wait', '0'],
      /--max-wait takes a number of minutes above 0/,
    ],
    [
      ['signing-guard', '--max-wait', '-5'],
      /--max-wait takes a number of minutes above 0/,
    ],
    [
      ['signing-guard', '--max-wait', 'soon'],
      /--max-wait takes a number of minutes above 0/,
    ],
  ];
  for (const [args, expected] of cases) {
    test(args.join(' '), async () => {
      const run = await cli(args, [UNLOCKED]);
      expect(run.failures).toEqual([matching(expected)]);
      expect(run.exitCode).toBeNull();
      expect(run.reads).toBe(0);
      expect(run.spawned).toEqual([]);
    });
  }
});

describe('commandAfterDashes', () => {
  test('everything after the first --, verbatim', () => {
    expect(commandAfterDashes(['signing-guard', '--', 'a', '--', 'b'])).toEqual(
      ['a', '--', 'b'],
    );
    expect(commandAfterDashes(['signing-guard', '--status'])).toBeNull();
    expect(commandAfterDashes(['signing-guard', '--'])).toEqual([]);
  });
});

describe('the real CLI', () => {
  const CLI = resolve(import.meta.dir, '..', 'src', 'cli.ts');

  test('--help exits 0, leads with the version header, and runs nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jsdk-signing-guard-'));
    try {
      const marker = join(dir, 'ran');
      const run = spawnSync(
        process.execPath,
        [CLI, 'signing-guard', '--help', '--', 'touch', marker],
        {
          encoding: 'utf-8',
          env: {...process.env, JUSTIN_SDK_HEALTH_NOTICES: 'off'},
        },
      );
      expect(run.status).toBe(0);
      expect(run.stdout.split('\n')[0]).toMatch(
        /^justin-sdk (v\d+\.\d+\.\d+|version unknown)/,
      );
      for (const text of [
        '--no-wait',
        '--max-wait',
        '--status',
        'JUSTIN_SDK_SIGNING_GUARD=off',
        'EXIT',
      ]) {
        expect(run.stdout).toContain(text);
      }
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, {force: true, recursive: true});
    }
  });

  test('a usage error exits 1 and runs nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jsdk-signing-guard-'));
    try {
      const marker = join(dir, 'ran');
      const run = spawnSync(
        process.execPath,
        [CLI, 'signing-guard', '--max-wait', '0', '--', 'touch', marker],
        {
          encoding: 'utf-8',
          env: {...process.env, JUSTIN_SDK_HEALTH_NOTICES: 'off'},
        },
      );
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(
        '--max-wait takes a number of minutes above 0, not 0.',
      );
      expect(run.stdout).toBe('');
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, {force: true, recursive: true});
    }
  });
});
