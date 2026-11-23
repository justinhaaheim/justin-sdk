/**
 * Tests for mac-build-xcode-dialog.ts (home-base-0jeya.13, D6): reading the
 * window server's list for a dialog in Xcode. The fixtures are Xcode's windows
 * as listed at 2026-11-21 2:59am, with the dialog up (window 2392, "The
 * workspace file … has disappeared"), and the same list without it. Nothing
 * here reads the real window server or runs screencapture.
 */

import {describe, expect, test} from 'bun:test';
import {readFileSync} from 'fs';
import {join, resolve} from 'path';

import {
  type CaptureDeps,
  captureWindowPicture,
  checkForSteadyDialog,
  describeXcodeDialogs,
  detectXcodeDialog,
  DIALOG_RECHECK_SECONDS,
  dialogPicturePath,
  type JxaRun,
  parseXcodeWindows,
  pictureClause,
  SCREEN_RECORDING_SCRIPT,
  type ScreenRecordingAccess,
  screenRecordingAccess,
  XCODE_WINDOWS_SCRIPT,
  type XcodeDialogCheckDeps,
  type XcodeDialogReading,
} from '../src/mac-build-xcode-dialog';

const FIXTURES = resolve(import.meta.dir, 'fixtures', 'mac-build-xcode-dialog');
const WITH_DIALOG = readFileSync(
  join(FIXTURES, 'xcode-windows-with-dialog-2026-11-21.json'),
  'utf8',
);
const WITHOUT_DIALOG = readFileSync(
  join(FIXTURES, 'xcode-windows-without-dialog-2026-11-21.json'),
  'utf8',
);

const THE_DIALOG = {
  height: 432,
  title: null,
  width: 410,
  windowNumber: 2392,
};

/** One window-list entry shaped like the fixture's. */
function entry(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    kCGWindowBounds: {Height: 100, Width: 200, X: 0, Y: 0},
    kCGWindowLayer: 0,
    kCGWindowName: '',
    kCGWindowNumber: 1,
    kCGWindowOwnerName: 'Xcode',
    ...fields,
  };
}

describe('parseXcodeWindows', () => {
  test('the 2026-11-21 list with the dialog up: window 2392, and only it', () => {
    expect(parseXcodeWindows(WITH_DIALOG)).toEqual({
      dialogs: [THE_DIALOG],
      status: 'dialog',
    });
  });

  test('the same list without the dialog: none, though an off-screen layer-8 window remains', () => {
    // The fixture really holds that window: layer 8, not on screen.
    const windows = JSON.parse(WITHOUT_DIALOG) as {
      kCGWindowIsOnscreen?: boolean;
      kCGWindowLayer: number;
      kCGWindowNumber: number;
    }[];
    expect(
      windows
        .filter((w) => w.kCGWindowLayer === 8)
        .map((w) => [w.kCGWindowNumber, w.kCGWindowIsOnscreen ?? null]),
    ).toEqual([[2391, null]]);
    expect(windows.some((w) => w.kCGWindowNumber === 2392)).toBe(false);

    expect(parseXcodeWindows(WITHOUT_DIALOG)).toEqual({status: 'none'});
  });

  test('no Xcode windows at all is none (Xcode not running)', () => {
    expect(parseXcodeWindows('[]')).toEqual({status: 'none'});
  });

  test('a readable title is kept; another owner, or layer 0, is not a dialog', () => {
    const list = [
      entry({
        kCGWindowIsOnscreen: true,
        kCGWindowLayer: 8,
        kCGWindowName: 'Re-save?',
        kCGWindowNumber: 7,
      }),
      entry({
        kCGWindowIsOnscreen: true,
        kCGWindowLayer: 8,
        kCGWindowNumber: 8,
        kCGWindowOwnerName: 'Finder',
      }),
      entry({kCGWindowIsOnscreen: true, kCGWindowNumber: 9}),
    ];
    expect(parseXcodeWindows(JSON.stringify(list))).toEqual({
      dialogs: [{height: 100, title: 'Re-save?', width: 200, windowNumber: 7}],
      status: 'dialog',
    });
  });

  test('output that is not a JSON list is "could not check", never none', () => {
    expect(parseXcodeWindows('not json').status).toBe('unknown');
    expect(parseXcodeWindows('')).toMatchObject({status: 'unknown'});
    expect(parseXcodeWindows('{"a":1}')).toEqual({
      reason: 'the window list was not a JSON list',
      status: 'unknown',
    });
    expect(parseXcodeWindows('null').status).toBe('unknown');
  });

  test('a window it cannot read makes "could not check" when no dialog is seen', () => {
    const unreadable = entry({kCGWindowLayer: 'eight'});
    expect(parseXcodeWindows(JSON.stringify([entry({}), unreadable]))).toEqual({
      reason:
        '1 of 2 windows in the list could not be read (first: kCGWindowLayer)',
      status: 'unknown',
    });
  });

  test('a window it cannot read does not hide a dialog it can', () => {
    const list = [
      ...(JSON.parse(WITH_DIALOG) as unknown[]),
      entry({kCGWindowBounds: null}),
    ];
    expect(parseXcodeWindows(JSON.stringify(list))).toEqual({
      dialogs: [THE_DIALOG],
      status: 'dialog',
    });
  });
});

describe('detectXcodeDialog', () => {
  test('runs the window-list script and reads its output', () => {
    const scripts: string[] = [];
    const reading = detectXcodeDialog((script) => {
      scripts.push(script);
      return {status: 'ok', stdout: `${WITH_DIALOG}\n`};
    });
    expect(scripts).toEqual([XCODE_WINDOWS_SCRIPT]);
    expect(reading.status).toBe('dialog');
  });

  test('a runner that fails is "could not check", with the reason', () => {
    const failed: JxaRun = {
      reason:
        'osascript reported: execution error: Error: the window server gave no window list (-2700)',
      status: 'failed',
    };
    expect(detectXcodeDialog(() => failed)).toEqual({
      reason:
        'the window list could not be read: osascript reported: execution error: Error: the window server gave no window list (-2700)',
      status: 'unknown',
    });
  });

  test('the script throws when there is no list, rather than print an empty one', () => {
    expect(XCODE_WINDOWS_SCRIPT).toContain(
      "if (!Array.isArray(list)) throw new Error('the window server gave no window list');",
    );
    expect(XCODE_WINDOWS_SCRIPT).toContain('kCGWindowListOptionAll');
    // It reads the window server only: nothing in it addresses Xcode.
    expect(XCODE_WINDOWS_SCRIPT).not.toContain('Application(');
  });
});

describe('the words', () => {
  test('a dialog is named by its title when readable, its size and its number', () => {
    expect(describeXcodeDialogs([THE_DIALOG])).toBe(
      'a dialog (a window with no readable title, 410x432, window number 2392)',
    );
    expect(
      describeXcodeDialogs([
        {...THE_DIALOG, title: 'Re-save?'},
        {...THE_DIALOG, windowNumber: 7},
      ]),
    ).toBe(
      '2 dialogs ("Re-save?", 410x432, window number 2392; a window with no readable title, 410x432, window number 7)',
    );
  });

  test('the picture clause names the file, or says it could not be saved', () => {
    expect(pictureClause({path: '/s/x.png', status: 'saved'})).toBe(
      'A picture of it: /s/x.png.',
    );
    expect(
      pictureClause({reason: 'screencapture wrote no file', status: 'failed'}),
    ).toBe('A picture of it could not be saved (screencapture wrote no file).');
  });

  test('the picture goes under XDG_STATE_HOME, or ~/.local/state, never ~/Library', () => {
    const at = new Date('2026-11-21T08:05:12.345Z');
    expect(dialogPicturePath(at, {HOME: '/h', XDG_STATE_HOME: '/xdg'})).toBe(
      '/xdg/justin-sdk/mac-build/xcode-dialog-2026-11-21T08-05-12-345Z.png',
    );
    expect(dialogPicturePath(at, {HOME: '/h'})).toBe(
      '/h/.local/state/justin-sdk/mac-build/xcode-dialog-2026-11-21T08-05-12-345Z.png',
    );
  });
});

describe('the picture asks for screen recording permission first, without a prompt', () => {
  const AT = new Date('2026-11-21T08:05:12.345Z');

  function capture(access: ScreenRecordingAccess) {
    const shots: [number, string][] = [];
    const deps: CaptureDeps = {
      access: () => access,
      at: AT,
      shoot: (windowNumber, file) => {
        shots.push([windowNumber, file]);
        return {path: file, status: 'saved'};
      },
    };
    return {picture: captureWindowPicture(2392, deps), shots};
  }

  test('granted: screencapture runs for that window, into the state dir', () => {
    const {picture, shots} = capture({status: 'granted'});
    expect(shots).toEqual([[2392, dialogPicturePath(AT)]]);
    expect(picture).toEqual({path: dialogPicturePath(AT), status: 'saved'});
  });

  test('denied: no screencapture, and the message says the terminal lacks the permission', () => {
    const {picture, shots} = capture({status: 'denied'});
    expect(shots).toEqual([]);
    expect(picture.status).toBe('skipped');
    expect(pictureClause(picture)).toBe(
      'No picture of it was taken, because this terminal does not have screen recording permission (System Settings › Privacy & Security › Screen & System Audio Recording).',
    );
  });

  test('could not check: no screencapture either, and it says why', () => {
    const {picture, shots} = capture({reason: 'boom', status: 'unknown'});
    expect(shots).toEqual([]);
    expect(pictureClause(picture)).toBe(
      'No picture of it was taken, because whether this terminal has screen recording permission could not be checked (boom).',
    );
  });

  test('the check reads true, false, or anything else as could not check', () => {
    const ok = (stdout: string) => () => ({status: 'ok', stdout}) as const;
    expect(screenRecordingAccess(ok('true\n'))).toEqual({status: 'granted'});
    expect(screenRecordingAccess(ok('false\n'))).toEqual({status: 'denied'});
    expect(screenRecordingAccess(ok(''))).toEqual({
      reason: 'the permission check printed ""',
      status: 'unknown',
    });
    expect(
      screenRecordingAccess(() => ({
        reason: 'osascript reported: x',
        status: 'failed',
      })),
    ).toEqual({reason: 'osascript reported: x', status: 'unknown'});
  });

  test('the script only preflights: it never requests, which would prompt', () => {
    expect(SCREEN_RECORDING_SCRIPT).toContain(
      "ObjC.bindFunction('CGPreflightScreenCaptureAccess', ['bool', []]);",
    );
    expect(SCREEN_RECORDING_SCRIPT).not.toContain(
      'CGRequestScreenCaptureAccess',
    );
  });
});

describe('checkForSteadyDialog (checks 1 and 2)', () => {
  const DIALOG: XcodeDialogReading = {dialogs: [THE_DIALOG], status: 'dialog'};
  const OTHER: XcodeDialogReading = {
    dialogs: [{...THE_DIALOG, windowNumber: 2500}],
    status: 'dialog',
  };
  const NONE: XcodeDialogReading = {status: 'none'};
  const UNKNOWN: XcodeDialogReading = {reason: 'boom', status: 'unknown'};

  function fake(readings: XcodeDialogReading[]) {
    const calls: string[] = [];
    const logs: string[] = [];
    const deps: XcodeDialogCheckDeps = {
      capture: () => {
        throw new Error('the check itself takes no picture');
      },
      detect: () => {
        calls.push('detect');
        const next = readings.shift();
        if (next == null) throw new Error('more readings than the test gave');
        return next;
      },
      log: (message) => {
        logs.push(message);
      },
      sleep: (seconds) => {
        calls.push(`sleep ${seconds}s`);
      },
    };
    return {calls, deps, logs};
  }

  test('the same window in two readings 3 s apart is a dialog', () => {
    const world = fake([DIALOG, DIALOG]);
    expect(checkForSteadyDialog(world.deps, 'before anything changes')).toEqual(
      {dialogs: [THE_DIALOG], status: 'dialog'},
    );
    expect(DIALOG_RECHECK_SECONDS).toBe(3);
    expect(world.calls).toEqual(['detect', 'sleep 3s', 'detect']);
    expect(world.logs).toEqual([
      'Dialog check before anything changes: Xcode is showing a dialog (a window with no readable title, 410x432, window number 2392), seen twice 3s apart.',
    ]);
  });

  test('none at the first reading: no second reading, and the log says none', () => {
    const world = fake([NONE]);
    expect(checkForSteadyDialog(world.deps, 'after the prebuild')).toEqual(
      NONE,
    );
    expect(world.calls).toEqual(['detect']);
    expect(world.logs).toEqual([
      'Dialog check after the prebuild: Xcode shows none.',
    ]);
  });

  test('could not check at the first reading: no second, and it is logged as such', () => {
    const world = fake([UNKNOWN]);
    expect(checkForSteadyDialog(world.deps, 'x')).toEqual(UNKNOWN);
    expect(world.calls).toEqual(['detect']);
    expect(world.logs).toEqual([
      'Dialog check x: could not check (boom), so the run goes on.',
    ]);
  });

  test('gone, or another window, at the second reading: the run goes on', () => {
    for (const second of [NONE, OTHER]) {
      const world = fake([DIALOG, second]);
      expect(checkForSteadyDialog(world.deps, 'x')).toEqual({
        status: 'passing',
      });
      expect(world.logs).toEqual([
        'Dialog check x: Xcode showed a dialog (a window with no readable title, 410x432, window number 2392), and it was gone 3s later, so the run goes on.',
      ]);
    }
  });

  test('could not check at the second reading: the run goes on, and the log says so', () => {
    const world = fake([DIALOG, UNKNOWN]);
    expect(checkForSteadyDialog(world.deps, 'x')).toEqual(UNKNOWN);
    expect(world.logs[0]).toEndWith(
      'and the second check 3s later could not be made (boom), so the run goes on.',
    );
  });
});
