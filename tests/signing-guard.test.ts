/**
 * The signing guard (home-base-di8c7.1): the ioreg parser (D2), the reader, and
 * the wait (D3 to D6). Nothing here reads the real screen or sleeps for real:
 * the reader gets an injected runner, and the wait a fake clock, a fake sleep
 * and a scripted state sequence.
 *
 * FIXTURES. One real reading, `ioreg -n Root -d1` on this Mac while unlocked
 * (macOS 27.2.1, uid 501, 2026-11-21), with the user name and long name
 * replaced and everything else byte for byte. Every other case is SYNTHETIC,
 * derived from it by one text edit, and named "synthetic:". Nobody has seen
 * the text of a locked reading, so the locked cases are guesses at where the
 * key could sit; rule 1 does not depend on where (D1).
 */

import {describe, expect, test} from 'bun:test';
import {readFileSync} from 'fs';
import {resolve} from 'path';

import {
  assertUnlockedForSigning,
  type CommandRunner,
  DEFAULT_MAX_WAIT_SECONDS,
  formatWait,
  IOREG_TIMEOUT_MS,
  parseScreenLockState,
  readScreenLockState,
  runCommandSync,
  type ScreenLockState,
  type SigningGuardOptions,
  waitForUnlockedScreen,
} from '../src/signing-guard';

const REAL_UNLOCKED = readFileSync(
  resolve(
    import.meta.dir,
    'fixtures',
    'signing-guard',
    'ioreg-root-unlocked-2026-11-21.txt',
  ),
  'utf8',
);
const UID = 501;
const USERS_LINE_START = '"IOConsoleUsers" = ({';
const SESSION_END = ',"kCGSSessionUserIDKey"=501})';

/** The real reading with one edit; fails if the edit would change nothing. */
function synthetic(search: string, replacement: string): string {
  expect(REAL_UNLOCKED).toContain(search);
  const out = REAL_UNLOCKED.replace(search, replacement);
  expect(out).not.toBe(REAL_UNLOCKED);
  return out;
}

const USERS_LINE =
  REAL_UNLOCKED.split('\n').find((line) => line.includes(USERS_LINE_START)) ??
  '';

describe('the real fixture', () => {
  test('is the shape the conductor recorded (D1), with no personal names', () => {
    expect(USERS_LINE).toContain('"kCGSSessionUserIDKey"=501');
    expect(USERS_LINE).toContain('"kCGSSessionOnConsoleKey"=Yes');
    expect(USERS_LINE).toContain('"kCGSessionLoginDoneKey"=Yes');
    expect(REAL_UNLOCKED).not.toContain('CGSSessionScreenIsLocked');
    expect(USERS_LINE).toContain('"kCGSSessionUserNameKey"="testuser"');
    expect(USERS_LINE).toContain('"kCGSessionLongUserNameKey"="Test User"');
  });
});

describe('parseScreenLockState (D2)', () => {
  test('rule 5: the real unlocked reading is unlocked', () => {
    expect(parseScreenLockState(REAL_UNLOCKED, UID)).toEqual({
      state: 'unlocked',
    });
  });

  test('rule 1, synthetic: the lock key inside our session dict is locked', () => {
    const text = synthetic(
      USERS_LINE_START,
      `${USERS_LINE_START}"CGSSessionScreenIsLocked"=Yes,`,
    );
    expect(parseScreenLockState(text, UID)).toEqual({
      reason: '`ioreg -n Root -d1` reports "CGSSessionScreenIsLocked"=Yes',
      state: 'locked',
    });
  });

  test('rule 1, synthetic: the lock key as its own root property is locked', () => {
    const text = synthetic(
      '      "IOConsoleLocked" = No\n',
      '      "IOConsoleLocked" = No\n      "CGSSessionScreenIsLocked" = Yes\n',
    );
    expect(parseScreenLockState(text, UID).state).toBe('locked');
  });

  test('rule 1, synthetic: the lock key in an unrelated dict is still locked', () => {
    const text = synthetic(
      '"IORegistryPlanes" = {',
      '"IORegistryPlanes" = {"CGSSessionScreenIsLocked"=Yes,',
    );
    expect(parseScreenLockState(text, UID).state).toBe('locked');
  });

  test("rule 1, synthetic: the lock key in another user's session is still locked", () => {
    const text = synthetic(
      SESSION_END,
      ',"kCGSSessionUserIDKey"=501},{"kCGSSessionOnConsoleKey"=No,"CGSSessionScreenIsLocked"=Yes,"kCGSSessionUserIDKey"=502})',
    );
    expect(parseScreenLockState(text, UID).state).toBe('locked');
  });

  test('rule 1, synthetic: the lock key at No goes on to the other rules', () => {
    const text = synthetic(
      USERS_LINE_START,
      `${USERS_LINE_START}"CGSSessionScreenIsLocked"=No,`,
    );
    expect(parseScreenLockState(text, UID)).toEqual({state: 'unlocked'});
  });

  test('rule 1, synthetic: the lock key at a value that is neither Yes nor No is unknown', () => {
    const text = synthetic(
      USERS_LINE_START,
      `${USERS_LINE_START}"CGSSessionScreenIsLocked"=1,`,
    );
    expect(parseScreenLockState(text, UID)).toEqual({
      reason:
        '`ioreg -n Root -d1` printed "CGSSessionScreenIsLocked"=1, which is neither Yes nor No',
      state: 'unknown',
    });
  });

  test('rule 2, synthetic: no IOConsoleUsers line is unknown', () => {
    const text = synthetic(`${USERS_LINE}\n`, '');
    expect(parseScreenLockState(text, UID)).toEqual({
      reason: '`ioreg -n Root -d1` printed no IOConsoleUsers',
      state: 'unknown',
    });
  });

  test('rule 2, synthetic: an IOConsoleUsers that does not close is unknown', () => {
    const text = synthetic(SESSION_END, ',"kCGSSessionUserIDKey"=501');
    expect(parseScreenLockState(text, UID)).toEqual({
      reason:
        '`ioreg -n Root -d1` printed an IOConsoleUsers this could not read as a list',
      state: 'unknown',
    });
  });

  test('rule 2, synthetic: an IOConsoleUsers that is not a list is unknown', () => {
    const text = synthetic(
      USERS_LINE,
      '      "IOConsoleUsers" = {"kCGSSessionUserIDKey"=501}',
    );
    expect(parseScreenLockState(text, UID).state).toBe('unknown');
  });

  test('rule 2, synthetic: a list entry that is not a dict is unknown', () => {
    const text = synthetic(SESSION_END, `${SESSION_END.slice(0, -1)},7)`);
    expect(parseScreenLockState(text, UID)).toEqual({
      reason:
        '`ioreg -n Root -d1` printed an IOConsoleUsers entry that is not a dictionary',
      state: 'unknown',
    });
  });

  test('rule 2, synthetic: IOConsoleUsers printed twice is unknown', () => {
    const text = synthetic(`${USERS_LINE}\n`, `${USERS_LINE}\n${USERS_LINE}\n`);
    expect(parseScreenLockState(text, UID)).toEqual({
      reason: '`ioreg -n Root -d1` printed IOConsoleUsers 2 times',
      state: 'unknown',
    });
  });

  test('rule 3, synthetic: only another uid on the console is unknown', () => {
    const text = synthetic(
      '"kCGSSessionUserIDKey"=501',
      '"kCGSSessionUserIDKey"=502',
    );
    expect(parseScreenLockState(text, UID)).toEqual({
      reason: '`ioreg -n Root -d1` lists no console session for user id 501',
      state: 'unknown',
    });
  });

  test('rule 3: the real reading, asked about a different uid, is unknown', () => {
    expect(parseScreenLockState(REAL_UNLOCKED, 502).state).toBe('unknown');
  });

  test('rule 3, synthetic: an empty IOConsoleUsers list is unknown', () => {
    const text = synthetic(USERS_LINE, '      "IOConsoleUsers" = ()');
    expect(parseScreenLockState(text, UID).state).toBe('unknown');
  });

  test('rule 3, synthetic: two sessions for our uid is unknown', () => {
    const session = USERS_LINE.slice(
      USERS_LINE.indexOf('{'),
      USERS_LINE.lastIndexOf('}') + 1,
    );
    const text = synthetic(
      SESSION_END,
      `${SESSION_END.slice(0, -1)},${session})`,
    );
    expect(parseScreenLockState(text, UID)).toEqual({
      reason: '`ioreg -n Root -d1` lists 2 console sessions for user id 501',
      state: 'unknown',
    });
  });

  test('rule 3: no uid for this process is unknown', () => {
    expect(parseScreenLockState(REAL_UNLOCKED, null)).toEqual({
      reason: "could not read this process's user id",
      state: 'unknown',
    });
  });

  test('rule 4, synthetic: our session off the console is locked', () => {
    const text = synthetic(
      '"kCGSSessionOnConsoleKey"=Yes',
      '"kCGSSessionOnConsoleKey"=No',
    );
    expect(parseScreenLockState(text, UID)).toEqual({
      reason:
        "this user's session is not on the console (another user is switched in)",
      state: 'locked',
    });
  });

  test('rule 4, synthetic: fast user switching, the other user on the console, is locked', () => {
    const text = synthetic(
      '"kCGSSessionOnConsoleKey"=Yes',
      '"kCGSSessionOnConsoleKey"=No',
    ).replace(
      SESSION_END,
      ',"kCGSSessionUserIDKey"=501},{"kCGSSessionOnConsoleKey"=Yes,"kCGSSessionUserIDKey"=502})',
    );
    expect(parseScreenLockState(text, UID).state).toBe('locked');
  });

  test('rule 4, synthetic: OnConsole missing is unknown', () => {
    const text = synthetic('"kCGSSessionOnConsoleKey"=Yes,', '');
    expect(parseScreenLockState(text, UID)).toEqual({
      reason:
        '`ioreg -n Root -d1` printed no kCGSSessionOnConsoleKey for user id 501',
      state: 'unknown',
    });
  });

  test('rule 4, synthetic: OnConsole neither Yes nor No is unknown', () => {
    const text = synthetic(
      '"kCGSSessionOnConsoleKey"=Yes',
      '"kCGSSessionOnConsoleKey"=1',
    );
    expect(parseScreenLockState(text, UID)).toEqual({
      reason:
        '`ioreg -n Root -d1` printed kCGSSessionOnConsoleKey=1 for user id 501, which is neither Yes nor No',
      state: 'unknown',
    });
  });

  test('synthetic: a quoted value holding a comma, braces and a quote does not confuse the reader', () => {
    const text = synthetic(
      '"kCGSessionLongUserNameKey"="Test User"',
      '"kCGSessionLongUserNameKey"="User, Test {x} (y) \\"q\\""',
    );
    expect(parseScreenLockState(text, UID)).toEqual({state: 'unlocked'});
  });

  test('empty or blank output is unknown', () => {
    for (const text of ['', '\n', '   \n\t']) {
      expect(parseScreenLockState(text, UID)).toEqual({
        reason: '`ioreg -n Root -d1` printed nothing',
        state: 'unknown',
      });
    }
  });
});

describe('readScreenLockState', () => {
  test('runs `ioreg -n Root -d1` with a 5 s timeout and parses its output', () => {
    const calls: [string, readonly string[], number][] = [];
    const run: CommandRunner = (command, args, timeoutMs) => {
      calls.push([command, args, timeoutMs]);
      return {status: 'ok', stdout: REAL_UNLOCKED};
    };
    expect(readScreenLockState(run, UID)).toEqual({state: 'unlocked'});
    expect(calls).toEqual([['ioreg', ['-n', 'Root', '-d1'], 5000]]);
    expect(IOREG_TIMEOUT_MS).toBe(5000);
  });

  test('a failed ioreg is unknown, naming the command and its error', () => {
    const run: CommandRunner = () => ({
      detail: 'it did not finish within 5 s',
      status: 'failed',
    });
    expect(readScreenLockState(run, UID)).toEqual({
      reason: '`ioreg -n Root -d1` failed: it did not finish within 5 s',
      state: 'unknown',
    });
  });

  test('ioreg that prints nothing is unknown', () => {
    const run: CommandRunner = () => ({status: 'ok', stdout: ''});
    expect(readScreenLockState(run, UID).state).toBe('unknown');
  });
});

describe('runCommandSync (the real runner; no screen involved)', () => {
  test('returns the output of a command that succeeds', () => {
    expect(runCommandSync('echo', ['hi'], 5000)).toEqual({
      status: 'ok',
      stdout: 'hi\n',
    });
  });

  test('a non-zero exit is a failure with its code', () => {
    expect(runCommandSync('false', [], 5000)).toEqual({
      detail: 'it exited 1',
      status: 'failed',
    });
  });

  test('a missing command is a failure', () => {
    expect(
      runCommandSync('justin-sdk-no-such-command-for-this-test', [], 5000),
    ).toEqual({detail: 'the command was not found', status: 'failed'});
  });

  test('a command that runs past the timeout is a failure', () => {
    const result = runCommandSync('sleep', ['5'], 200);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.detail).toMatch(
        /did not finish within 0\.2 s|stopped by SIGTERM/,
      );
    }
  });
});

const LOCKED: ScreenLockState = {
  reason: '`ioreg -n Root -d1` reports "CGSSessionScreenIsLocked"=Yes',
  state: 'locked',
};
const UNLOCKED: ScreenLockState = {state: 'unlocked'};
const UNKNOWN: ScreenLockState = {
  reason: '`ioreg -n Root -d1` failed: it did not finish within 5 s',
  state: 'unknown',
};

/**
 * A fake world: `states` are read in order (the last one repeats), the clock
 * moves only when the guard sleeps, and every read, sleep and line is kept.
 */
function world(states: ScreenLockState[]): {
  logs: string[];
  options: (extra?: Partial<SigningGuardOptions>) => SigningGuardOptions;
  reads: number[];
  sleeps: number[];
} {
  let clockMs = 1_700_000_000_000;
  let index = 0;
  const logs: string[] = [];
  const reads: number[] = [];
  const sleeps: number[] = [];
  return {
    logs,
    options: (extra = {}) => ({
      env: {},
      log: (line) => {
        logs.push(line);
      },
      now: () => clockMs,
      readState: () => {
        reads.push(clockMs);
        const state = states[Math.min(index, states.length - 1)] ?? UNKNOWN;
        index += 1;
        return state;
      },
      sleep: (seconds) => {
        sleeps.push(seconds);
        clockMs += seconds * 1000;
      },
      what: 'the test build',
      ...extra,
    }),
    reads,
    sleeps,
  };
}

const sum = (values: number[]): number =>
  values.reduce((total, value) => total + value, 0);

describe('waitForUnlockedScreen (D3 to D6)', () => {
  test('unlocked: proceeds at once and prints nothing (D6)', () => {
    const w = world([UNLOCKED]);
    expect(waitForUnlockedScreen(w.options())).toEqual({
      action: 'proceed',
      checked: true,
      waitedSeconds: 0,
    });
    expect(w.logs).toEqual([]);
    expect(w.sleeps).toEqual([]);
    expect(w.reads).toHaveLength(1);
  });

  test('locked, then unlocked: waits, polling every 5 s, and says how long it waited (D3)', () => {
    const w = world([LOCKED, LOCKED, UNLOCKED]);
    expect(waitForUnlockedScreen(w.options())).toEqual({
      action: 'proceed',
      checked: true,
      waitedSeconds: 10,
    });
    expect(w.sleeps).toEqual([5, 5]);
    expect(w.logs).toHaveLength(2);
    const [waiting, proceeding] = w.logs;
    expect(waiting).toContain('[signing-guard] The screen is locked');
    expect(waiting).toContain('the test build is waiting to start');
    expect(waiting).toContain(
      'makes Xcode lose its Apple account sign-in (home-base-di8c7)',
    );
    expect(waiting).toContain('starts by itself once the screen is unlocked');
    expect(waiting).toContain('every 5 s, for up to 30 min');
    expect(waiting).toContain('Ctrl-C');
    expect(proceeding).toBe(
      '[signing-guard] The screen is unlocked; starting the test build after waiting 10 s.',
    );
  });

  test('locked past maxWait: stops, having waited exactly that long', () => {
    const w = world([LOCKED]);
    const outcome = waitForUnlockedScreen(w.options({maxWaitSeconds: 12}));
    expect(outcome).toEqual({
      action: 'stop',
      cause: 'timed-out',
      message: expect.stringContaining(
        'The screen was still locked after 12 s',
      ) as string,
    });
    // The last poll is cut short so the wait never runs past its limit.
    expect(w.sleeps).toEqual([5, 5, 2]);
    expect(w.reads).toHaveLength(4);
    expect(w.logs).toHaveLength(1);
  });

  test('the defaults: 30 minutes of 5 s polls', () => {
    const w = world([LOCKED]);
    const outcome = waitForUnlockedScreen(w.options());
    expect(outcome.action).toBe('stop');
    expect(sum(w.sleeps)).toBe(DEFAULT_MAX_WAIT_SECONDS);
    expect(w.sleeps).toHaveLength(DEFAULT_MAX_WAIT_SECONDS / 5);
    expect(new Set(w.sleeps)).toEqual(new Set([5]));
    if (outcome.action === 'stop') {
      expect(outcome.message).toContain('still locked after 30 min');
      expect(outcome.message).toContain('so the test build did not start');
    }
  });

  test('wait: false stops at once when locked, with the same explanation', () => {
    const w = world([LOCKED]);
    expect(waitForUnlockedScreen(w.options({wait: false}))).toEqual({
      action: 'stop',
      cause: 'locked',
      message:
        'The screen is locked (`ioreg -n Root -d1` reports "CGSSessionScreenIsLocked"=Yes), so the test build did not start. A signing build that starts while the screen is locked makes Xcode lose its Apple account sign-in (home-base-di8c7). Unlock the screen and run it again.',
    });
    expect(w.sleeps).toEqual([]);
    expect(w.logs).toEqual([]);
  });

  test('unknown stops at once, naming the reason and the off switch (D4)', () => {
    const w = world([UNKNOWN, UNLOCKED]);
    const outcome = waitForUnlockedScreen(w.options());
    expect(outcome.action).toBe('stop');
    if (outcome.action === 'stop') {
      expect(outcome.cause).toBe('unknown');
      expect(outcome.message).toContain(
        'Could not tell whether the screen is locked, so the test build did not start: `ioreg -n Root -d1` failed: it did not finish within 5 s.',
      );
      expect(outcome.message).toContain('JUSTIN_SDK_SIGNING_GUARD=off');
    }
    expect(w.reads).toHaveLength(1);
    expect(w.sleeps).toEqual([]);
  });

  test('unknown during the wait stops too; it never proceeds', () => {
    const w = world([LOCKED, LOCKED, UNKNOWN, UNLOCKED]);
    const outcome = waitForUnlockedScreen(w.options());
    expect(outcome.action).toBe('stop');
    if (outcome.action === 'stop') expect(outcome.cause).toBe('unknown');
    expect(w.sleeps).toEqual([5, 5]);
  });

  test('JUSTIN_SDK_SIGNING_GUARD=off proceeds without reading, and says so in one line (D5)', () => {
    const w = world([LOCKED]);
    expect(
      waitForUnlockedScreen(
        w.options({env: {JUSTIN_SDK_SIGNING_GUARD: 'off'}}),
      ),
    ).toEqual({action: 'proceed', checked: false});
    expect(w.reads).toEqual([]);
    expect(w.logs).toEqual([
      '[signing-guard] JUSTIN_SDK_SIGNING_GUARD=off, so the screen lock was NOT checked before the test build.',
    ]);
  });

  test('any other value of the switch leaves the guard on', () => {
    for (const value of [
      'OFF',
      'Off',
      ' off',
      'off ',
      '0',
      'false',
      'no',
      '',
    ]) {
      const w = world([LOCKED]);
      const outcome = waitForUnlockedScreen(
        w.options({env: {JUSTIN_SDK_SIGNING_GUARD: value}, wait: false}),
      );
      expect([value, outcome.action]).toEqual([value, 'stop']);
      expect(w.reads).toHaveLength(1);
    }
  });

  test('a wait limit or poll that would never end is refused', () => {
    const w = world([LOCKED]);
    expect(() =>
      waitForUnlockedScreen(w.options({maxWaitSeconds: Number.NaN})),
    ).toThrow(/maxWaitSeconds must be 0 or more/);
    expect(() => waitForUnlockedScreen(w.options({pollSeconds: 0}))).toThrow(
      /pollSeconds must be more than 0/,
    );
    expect(w.reads).toEqual([]);
  });
});

describe('assertUnlockedForSigning', () => {
  test('returns when the guard proceeds', () => {
    expect(assertUnlockedForSigning(world([UNLOCKED]).options())).toEqual({
      action: 'proceed',
      checked: true,
      waitedSeconds: 0,
    });
  });

  test('throws an Error carrying the stop message', () => {
    const expected = waitForUnlockedScreen(
      world([LOCKED]).options({wait: false}),
    );
    expect(expected.action).toBe('stop');
    if (expected.action !== 'stop') return;
    expect(() =>
      assertUnlockedForSigning(world([LOCKED]).options({wait: false})),
    ).toThrow(expected.message);
    expect(() => assertUnlockedForSigning(world([UNKNOWN]).options())).toThrow(
      /Could not tell whether the screen is locked/,
    );
  });
});

describe('formatWait', () => {
  test('seconds, then minutes', () => {
    expect([0, 5, 59.6, 60, 135, 1800].map(formatWait)).toEqual([
      '0 s',
      '5 s',
      '1 min',
      '1 min',
      '2 min 15 s',
      '30 min',
    ]);
  });
});
