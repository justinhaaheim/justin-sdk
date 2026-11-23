/**
 * Tests for mac-build-xcode.ts (home-base-0jeya.13, D1): mac-build opens the
 * workspace once, fire and forget, and polls Xcode from TypeScript until it has
 * loaded it. Everything runs against a fake osascript runner and a fake clock,
 * so no test talks to Xcode.
 */

import {describe, expect, test} from 'bun:test';

import {
  DIALOG_STOPS_WAIT_SECONDS,
  isAppleEventTimeout,
  openWorkspaceAndWaitForLoad,
  type OsascriptRun,
  WORKSPACE_LOAD_CEILING_SECONDS,
  type WorkspaceOpenDeps,
  workspaceOpenScript,
  workspacePollScript,
} from '../src/mac-build-xcode';
import {
  DIALOG_PROBLEM,
  type XcodeDialogReading,
} from '../src/mac-build-xcode-dialog';

const PATH = '/Users/someone/Dev/example-app/ios/ExampleAppPreview.xcworkspace';

/** What osascript printed on 2026-11-19 when Xcode did not answer `open`. */
const TIMEOUT_STDERR =
  '683:757: execution error: Xcode got an error: AppleEvent timed out. (-1712)';
const OTHER_ERROR_STDERR =
  '120:160: execution error: Xcode got an error: Can’t get workspace document 1. (-1728)';

/** A string is what the poll prints, or 'busy'; an object is the whole run. */
type Answer = OsascriptRun | string;

/** What the window server's list shows at a moment, by ms since the wait began. */
type DialogAt = (sinceStartMs: number) => XcodeDialogReading;

const NO_DIALOG: XcodeDialogReading = {status: 'none'};

/** The 2026-11-21 dialog, as the window server listed it. */
function dialogReading(windowNumber = 2392): XcodeDialogReading {
  return {
    dialogs: [{height: 432, title: null, width: 410, windowNumber}],
    status: 'dialog',
  };
}

const FAKE_PICTURE = '/state/justin-sdk/mac-build/xcode-dialog-fake.png';
const WITHOUT_CHECK = 'bun run mac -- --no-dialog-check';

/**
 * A fake Xcode. Each poll takes the next answer (a string is what the poll
 * script prints; 'busy' is a -1712 after the poll's 20 s); once the list is
 * empty, every poll is busy. The clock moves 50 ms per answered poll, 20 s per
 * busy one, and by every sleep. `dialogAt` is what a reading of the window
 * server's list shows (none by default); a reading takes no time.
 * `dialogCheckOff` is `--no-dialog-check`: deps.dialog is null.
 */
function fakeXcode(
  answers: Answer[],
  openResult: OsascriptRun = {status: 'ok', stdout: ''},
  dialogAt: DialogAt = () => NO_DIALOG,
  dialogCheckOff = false,
) {
  let clockMs = 1_000_000;
  const startMs = clockMs;
  const calls: ('open' | 'poll')[] = [];
  const logs: string[] = [];
  /** When each reading of the window list was taken, in ms since the start. */
  const readings: number[] = [];
  const captures: number[] = [];
  const pollScript = workspacePollScript(PATH);
  const openScript = workspaceOpenScript(PATH);
  const deps: WorkspaceOpenDeps = {
    dialog: dialogCheckOff
      ? null
      : {
          capture: (windowNumber) => {
            captures.push(windowNumber);
            return {path: FAKE_PICTURE, status: 'saved'};
          },
          detect: () => {
            readings.push(clockMs - startMs);
            return dialogAt(clockMs - startMs);
          },
          withoutCheckCommand: WITHOUT_CHECK,
        },
    log: (message) => {
      logs.push(message);
    },
    now: () => clockMs,
    osascript: (script) => {
      // A wait that never ends must fail the test, not hang it.
      if (calls.length > 5000) throw new Error('runaway: more than 5000 calls');
      if (script === openScript) {
        calls.push('open');
        clockMs += 100;
        return openResult;
      }
      if (script !== pollScript)
        throw new Error(`unexpected script: ${script}`);
      calls.push('poll');
      const next = answers.shift() ?? 'busy';
      if (next === 'busy') {
        clockMs += 20_000;
        return {status: 'failed', stderr: TIMEOUT_STDERR};
      }
      clockMs += 50;
      return typeof next === 'string' ? {status: 'ok', stdout: next} : next;
    },
    sleep: (seconds) => {
      clockMs += seconds * 1000;
    },
  };
  return {
    calls,
    captures,
    deps,
    logs,
    opens: () => calls.filter((call) => call === 'open').length,
    readings,
  };
}

describe('openWorkspaceAndWaitForLoad', () => {
  test('already open and loaded: no open is sent', () => {
    const xcode = fakeXcode(['loaded']);
    const outcome = openWorkspaceAndWaitForLoad(PATH, xcode.deps);
    expect(outcome).toEqual({
      busyPolls: 0,
      openSent: false,
      polls: 1,
      seconds: 0,
      status: 'loaded',
    });
    expect(xcode.calls).toEqual(['poll']);
    expect(xcode.logs).toEqual([
      'The workspace was already open and loaded in Xcode.',
    ]);
  });

  test('already listed but still loading: it waits, and still sends no open', () => {
    const xcode = fakeXcode(['loading', 'busy', 'loading', 'loaded']);
    const outcome = openWorkspaceAndWaitForLoad(PATH, xcode.deps);
    expect(outcome.status).toBe('loaded');
    expect(xcode.opens()).toBe(0);
    expect(xcode.logs.at(-1)).toMatch(
      /^Xcode finished loading the workspace, which it already had open, in \d+s \(1 of 4 checks found Xcode too busy to answer within 20s\)\.$/,
    );
  });

  test('opened, then loaded after several busy polls: busy is not a failure, and the time is logged', () => {
    const xcode = fakeXcode([
      'absent',
      'busy',
      'busy',
      'busy',
      'loading',
      'loaded',
    ]);
    const outcome = openWorkspaceAndWaitForLoad(PATH, xcode.deps);
    // Open sent at +150 ms; three busy polls (20 s each) and four 2 s sleeps
    // later, plus two answered polls: loaded 70.1 s after the open.
    expect(outcome).toEqual({
      busyPolls: 3,
      openSent: true,
      polls: 6,
      seconds: 70,
      status: 'loaded',
    });
    expect(xcode.calls).toEqual([
      'poll',
      'open',
      'poll',
      'poll',
      'poll',
      'poll',
      'poll',
    ]);
    expect(xcode.logs.at(-1)).toBe(
      'Xcode opened and loaded the workspace in 70s (3 of 6 checks found Xcode too busy to answer within 20s).',
    );
  });

  test('busy before anything is known: it does not open until Xcode says the workspace is absent', () => {
    const xcode = fakeXcode(['busy', 'busy', 'absent', 'loaded']);
    const outcome = openWorkspaceAndWaitForLoad(PATH, xcode.deps);
    expect(outcome.status).toBe('loaded');
    expect(xcode.calls).toEqual(['poll', 'poll', 'poll', 'open', 'poll']);
  });

  test('the ceiling: it fails after 15 minutes, naming how long Xcode had been loading', () => {
    const xcode = fakeXcode(['absent']);
    const outcome = openWorkspaceAndWaitForLoad(PATH, xcode.deps);
    expect(outcome.status).toBe('failed');
    const reason = outcome.status === 'failed' ? outcome.reason : '';
    const match =
      /^Xcode had still not loaded (\S+) (\d+)s after it was asked to open it \(the limit is 15 minutes; (\d+) of (\d+) checks found Xcode too busy to answer within 20s\)\.$/.exec(
        reason,
      );
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe(PATH);
    const elapsed = Number(match?.[2]);
    expect(elapsed).toBeGreaterThanOrEqual(WORKSPACE_LOAD_CEILING_SECONDS);
    // At most one busy poll and one sleep past the ceiling.
    expect(elapsed).toBeLessThan(WORKSPACE_LOAD_CEILING_SECONDS + 23);
    expect(Number(match?.[4]) - Number(match?.[3])).toBe(1);
    expect(xcode.opens()).toBe(1);
    // A long wait says it is still going, about once a minute.
    const progress = xcode.logs.filter((line) =>
      line.startsWith('Still waiting for Xcode to load the workspace'),
    );
    expect(progress.length).toBeGreaterThanOrEqual(13);
    expect(progress.length).toBeLessThanOrEqual(15);
  });

  test('the ceiling when Xcode never answers at all: no open was ever sent', () => {
    const xcode = fakeXcode([]);
    const outcome = openWorkspaceAndWaitForLoad(PATH, xcode.deps);
    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' ? outcome.reason : '').toMatch(
      /^Xcode did not answer for \d+s \(\d+ of \d+ checks found Xcode too busy to answer within 20s\), so the workspace was never opened\.$/,
    );
    expect(xcode.opens()).toBe(0);
  });

  test('a poll error that is not a timeout fails at once, with what Xcode said', () => {
    const xcode = fakeXcode([
      'absent',
      'busy',
      {status: 'failed', stderr: OTHER_ERROR_STDERR},
      'loaded',
    ]);
    const outcome = openWorkspaceAndWaitForLoad(PATH, xcode.deps);
    expect(outcome).toEqual({
      reason: `Could not ask Xcode whether it has ${PATH} open — Xcode reported: ${OTHER_ERROR_STDERR}`,
      status: 'failed',
    });
    expect(xcode.calls).toEqual(['poll', 'open', 'poll', 'poll']);
  });

  test('a poll that fails with no stderr fails, and says so', () => {
    const xcode = fakeXcode([{status: 'failed', stderr: null}]);
    const outcome = openWorkspaceAndWaitForLoad(PATH, xcode.deps);
    expect(outcome).toEqual({
      reason: `Could not ask Xcode whether it has ${PATH} open — Xcode failed without reporting a reason.`,
      status: 'failed',
    });
  });

  test('open is never sent twice, whatever Xcode answers after it', () => {
    const xcode = fakeXcode([
      'absent',
      'absent',
      'not running',
      'absent',
      'loading',
      'absent',
      'busy',
      'absent',
      'loaded',
    ]);
    const outcome = openWorkspaceAndWaitForLoad(PATH, xcode.deps);
    expect(outcome.status).toBe('loaded');
    expect(xcode.opens()).toBe(1);
    expect(xcode.calls[1]).toBe('open');
  });

  test('an open that fails is not retried', () => {
    const xcode = fakeXcode(['absent', 'absent'], {
      status: 'failed',
      stderr: 'execution error: Can’t get application "Xcode". (-1728)',
    });
    const outcome = openWorkspaceAndWaitForLoad(PATH, xcode.deps);
    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' ? outcome.reason : '').toBe(
      `Could not ask Xcode to open ${PATH} — Xcode reported: execution error: Can’t get application "Xcode". (-1728)`,
    );
    expect(xcode.calls).toEqual(['poll', 'open']);
  });

  test('Xcode not running: the open launches it, and not running long after the open fails', () => {
    const xcode = fakeXcode([
      'not running',
      ...Array<string>(30).fill('not running'),
    ]);
    const outcome = openWorkspaceAndWaitForLoad(PATH, xcode.deps);
    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' ? outcome.reason : '').toMatch(
      /^Xcode was not running 3\ds after it was asked to open .*: it quit, or crashed, while opening it\.$/,
    );
    expect(xcode.opens()).toBe(1);
  });

  test('an answer it does not understand is a failure, never "loaded"', () => {
    const xcode = fakeXcode(['true']);
    const outcome = openWorkspaceAndWaitForLoad(PATH, xcode.deps);
    expect(outcome).toEqual({
      reason: `Xcode gave an answer this does not understand when asked whether it has ${PATH} open: "true".`,
      status: 'failed',
    });
  });
});

describe('a dialog stops the load wait (D6, check 3)', () => {
  /** Enough loading answers to outlast every dialog these tests show. */
  const LOADING = Array<string>(400).fill('loading');
  const SHOWING_2392 =
    'Xcode is showing what looks like a dialog (a window with no readable title, 410x432, window number 2392); if it is still there in 30s, the wait stops.';

  test('a dialog that stays 30 s while the workspace loads fails the wait, naming it', () => {
    const xcode = fakeXcode(['absent', ...LOADING], undefined, () =>
      dialogReading(),
    );
    const outcome = openWorkspaceAndWaitForLoad(PATH, xcode.deps);
    expect(outcome.status).toBe('failed');
    const reason = outcome.status === 'failed' ? outcome.reason : '';
    const seconds = Number(/ for (\d+)s while /.exec(reason)?.[1]);
    expect(seconds).toBeGreaterThanOrEqual(DIALOG_STOPS_WAIT_SECONDS);
    expect(seconds).toBeLessThanOrEqual(DIALOG_STOPS_WAIT_SECONDS + 3);
    expect(reason).toBe(
      `Xcode has shown a dialog (a window with no readable title, 410x432, window number 2392) for ${seconds}s while ${PATH} had not loaded (${DIALOG_PROBLEM}). A picture of it: ${FAKE_PICTURE}. Look at Xcode and answer the dialog as problem 8 says. If that window is not a dialog, \`${WITHOUT_CHECK}\` skips this check.`,
    );
    expect(DIALOG_PROBLEM).toBe(
      'problem 8 in `bun run justin-sdk mac-build --problems`',
    );
    expect(xcode.captures).toEqual([2392]);
    expect(xcode.opens()).toBe(1);
    // It stopped about 30 s in, not at the 15-minute ceiling.
    expect(xcode.readings.at(-1)).toBeLessThan(35_000);
    expect(xcode.logs.filter((line) => line === SHOWING_2392)).toHaveLength(1);
  });

  test('a dialog that clears starts the count over, so two shorter spells do not fail the wait', () => {
    // 20 s of dialog, 4.5 s without, then 25.5 s of the same dialog: 45.5 s
    // in all, never 30 s at a stretch.
    const xcode = fakeXcode(
      ['absent', ...Array<string>(30).fill('loading'), 'loaded'],
      undefined,
      (t) =>
        t < 20_000 || (t >= 24_500 && t < 50_000) ? dialogReading() : NO_DIALOG,
    );
    const outcome = openWorkspaceAndWaitForLoad(PATH, xcode.deps);
    expect(outcome.status).toBe('loaded');
    expect(xcode.captures).toEqual([]);
    expect(xcode.logs.filter((line) => line === SHOWING_2392)).toHaveLength(2);
    expect(xcode.logs).toContain(
      'The window that looked like a dialog in Xcode has gone; still waiting for the workspace to load.',
    );
  });

  test('another window starts the count over: only the same window counts', () => {
    const xcode = fakeXcode(
      ['absent', ...Array<string>(30).fill('loading'), 'loaded'],
      undefined,
      (t) =>
        t < 20_000
          ? dialogReading(2392)
          : t < 45_000
            ? dialogReading(2500)
            : NO_DIALOG,
    );
    expect(openWorkspaceAndWaitForLoad(PATH, xcode.deps).status).toBe('loaded');
    expect(xcode.captures).toEqual([]);
  });

  test('a reading that could not be made fails nothing, and is logged once', () => {
    const xcode = fakeXcode(
      ['absent', ...Array<string>(20).fill('loading'), 'loaded'],
      undefined,
      () => ({reason: 'osascript reported: boom', status: 'unknown'}),
    );
    expect(openWorkspaceAndWaitForLoad(PATH, xcode.deps).status).toBe('loaded');
    expect(xcode.readings.length).toBe(21);
    expect(
      xcode.logs.filter((line) => line.includes('could not check')),
    ).toEqual([
      'Dialog check while Xcode loads the workspace: could not check (osascript reported: boom), so the wait goes on.',
    ]);
  });

  test('a reading that could not be made starts nothing over', () => {
    // 16 s of dialog, 8 s unreadable, then the same dialog: it has stayed
    // since the start, so the wait stops about 30 s in, not 30 s after 24 s.
    const xcode = fakeXcode(['absent', ...LOADING], undefined, (t) =>
      t >= 16_000 && t < 24_000
        ? {reason: 'osascript reported: boom', status: 'unknown'}
        : dialogReading(),
    );
    expect(openWorkspaceAndWaitForLoad(PATH, xcode.deps).status).toBe('failed');
    expect(xcode.readings.at(-1)).toBeLessThan(35_000);
  });

  test('every poll that does not end the wait takes a reading, busy and not running too; loaded takes none', () => {
    const xcode = fakeXcode([
      'busy',
      'not running',
      'loading',
      'absent',
      'loaded',
    ]);
    expect(openWorkspaceAndWaitForLoad(PATH, xcode.deps).status).toBe('loaded');
    expect(xcode.calls).toEqual([
      'poll',
      'poll',
      'open',
      'poll',
      'poll',
      'poll',
    ]);
    // One reading each after busy, not running, loading and absent.
    expect(xcode.readings).toEqual([20_000, 22_150, 24_200, 26_250]);
  });

  test('a dialog that keeps every poll busy stops the wait about 30 s in, not at the 15-minute ceiling', () => {
    // Xcode answers nothing (every poll is a -1712 after 20 s), and the window
    // server shows the same dialog at each reading: 20 s, 42 s and 64 s in.
    const xcode = fakeXcode([], undefined, () => dialogReading());
    const outcome = openWorkspaceAndWaitForLoad(PATH, xcode.deps);
    expect(outcome.status).toBe('failed');
    expect(xcode.readings).toEqual([20_000, 42_000, 64_000]);
    expect(outcome.status === 'failed' ? outcome.reason : '').toStartWith(
      `Xcode has shown a dialog (a window with no readable title, 410x432, window number 2392) for 44s while ${PATH} had not loaded`,
    );
    expect(xcode.opens()).toBe(0);
    expect(xcode.captures).toEqual([2392]);
  });

  test('--no-dialog-check: no reading, a dialog never stops the wait, and the log says the check is off', () => {
    const xcode = fakeXcode(
      ['absent', ...Array<string>(30).fill('loading'), 'loaded'],
      undefined,
      () => dialogReading(),
      true,
    );
    expect(openWorkspaceAndWaitForLoad(PATH, xcode.deps).status).toBe('loaded');
    expect(xcode.readings).toEqual([]);
    expect(xcode.captures).toEqual([]);
    expect(xcode.logs[0]).toBe(
      'Dialog check while Xcode loads the workspace: off (--no-dialog-check).',
    );
  });

  test('a wait with no dialog logs the first reading once, and nothing more about dialogs', () => {
    const xcode = fakeXcode(['absent', 'loading', 'loading', 'loaded']);
    expect(openWorkspaceAndWaitForLoad(PATH, xcode.deps).status).toBe('loaded');
    expect(xcode.readings).toHaveLength(3);
    expect(xcode.logs.filter((line) => line.includes('ialog'))).toEqual([
      'Dialog check while Xcode loads the workspace: Xcode shows none.',
    ]);
  });
});

describe('isAppleEventTimeout', () => {
  test('the 2026-11-19 message is a timeout; other errors and no stderr are not', () => {
    expect(isAppleEventTimeout(TIMEOUT_STDERR)).toBe(true);
    expect(isAppleEventTimeout(OTHER_ERROR_STDERR)).toBe(false);
    expect(isAppleEventTimeout(null)).toBe(false);
    expect(isAppleEventTimeout('')).toBe(false);
  });
});

describe('the scripts', () => {
  test('the poll has its own short timeout, never opens, and never launches Xcode', () => {
    const script = workspacePollScript(PATH);
    expect(script).toContain('with timeout of 20 seconds');
    expect(script).not.toContain('open ');
    expect(script).not.toContain('activate');
  });

  test('the poll asks whether Xcode runs before its tell block, never with `it`', () => {
    // Inside `tell application "Xcode"`, `it is not running` is always true
    // (measured 2026-11-21), so every poll answered "not running".
    // tests/mac-build.test.ts holds the same rule for the other scripts and
    // the scan of every literal in both source files.
    const script = workspacePollScript(PATH);
    expect(script).not.toContain('it is not running');
    expect(script.trimStart().split('\n')[0]).toBe(
      'if application "Xcode" is not running then return "not running"',
    );
    expect(script.indexOf('application "Xcode" is not running')).toBeLessThan(
      script.indexOf('tell application "Xcode"'),
    );
  });

  test('the open is fire and forget, and quotes the path', () => {
    const tricky = '/Users/someone/Dev/a "b" \\c/ios/X.xcworkspace';
    const script = workspaceOpenScript(tricky);
    expect(script).toContain('ignoring application responses');
    expect(script).toContain(
      'open "/Users/someone/Dev/a \\"b\\" \\\\c/ios/X.xcworkspace"',
    );
    expect(script.indexOf('ignoring application responses')).toBeLessThan(
      script.indexOf('open "'),
    );
    expect(script).not.toContain('with timeout');
  });
});
