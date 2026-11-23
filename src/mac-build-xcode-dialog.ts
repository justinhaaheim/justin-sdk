/**
 * mac-build-xcode-dialog.ts — notice a dialog Xcode is showing, without
 * accessibility access (home-base-0jeya.13, D6).
 *
 * WHY. Nothing mac-build asks Xcode shows whether Xcode has a dialog up. On
 * 2026-11-21 Xcode showed "The workspace file that was at
 * …/DevHealthLogger.xcworkspace has disappeared. Do you want to re-save the
 * container, or close it?" Xcode's read-only polls kept answering while it was
 * up: for the whole 15 minutes they said the newly opened workspace was still
 * loading. The `close` that came before it got no answer for 300 s
 * (docs/mac-build-problems.md, problem 8). Which Apple Events a dialog blocks
 * is not known, so nothing here claims it blocks all of them.
 *
 * HOW. The window server's list (CGWindowListCopyWindowInfo, read through
 * `osascript -l JavaScript`) gives every window's owner, layer, bounds and
 * whether it is on screen, with no permission at all; the title only with
 * screen recording, so the title is `string | null` here and nothing depends
 * on it. A dialog is a window owned by Xcode at layer 8 (the modal panel level)
 * that is on screen. Xcode keeps an OFF-screen layer-8 window that is not a
 * dialog (window 2391, 260x282, in the 2026-11-21 fixture), so on screen is
 * part of the test. This rests on one specimen; the negative control still
 * owed is a healthy build's log of what each check saw.
 *
 * Three outcomes, typed apart (critical rules, section 7): a dialog seen, none,
 * or could not check. "Could not check" never stops a run and never reads as
 * "none" in a message.
 *
 * Where mac-build uses it: before it uses Xcode and after it writes ios/
 * (mac-build.ts, prepareIos: checks 1 and 2), during the load wait
 * (mac-build-xcode.ts: check 3) and when a stop or close gets no answer
 * (mac-build.ts, failCloseStep: check 4). `--no-dialog-check` turns off the
 * three that can stop a run (1, 2 and 3), so a window wrongly taken for a
 * dialog never stops a run with no way past; check 4 only chooses the words
 * of a failure that happens anyway.
 *
 * THE PICTURE. Before `screencapture`, CGPreflightScreenCaptureAccess asks
 * whether this process may record the screen; the preflight never shows a
 * prompt. Without that permission no picture is taken, so a failing build
 * neither raises a macOS permission prompt nor saves a picture with no dialog
 * in it (measured 2026-11-21: true from cmux, false inside the Claude Code
 * sandbox).
 */

import {execFileSync} from 'child_process';
import {mkdirSync, statSync} from 'fs';
import {join} from 'path';
import {z} from 'zod';

import {xdgStateHome} from './health-notices';
import {sdkRun} from './sdk-invocation';

/**
 * The command that prints the known-problems list (D2). It is defined here,
 * the lowest of the mac-build modules that names it, because the dialog
 * messages below need it and mac-build.ts imports this module.
 */
export const MAC_BUILD_PROBLEMS_COMMAND = sdkRun('mac-build --problems');

/** The known-problems entry about dialogs in Xcode. */
export const DIALOG_PROBLEM = `problem 8 in \`${MAC_BUILD_PROBLEMS_COMMAND}\``;

/**
 * Why a dialog stops a run, in words that claim only what was seen: Xcode
 * answered some Apple Events and not others while one was up, and the
 * workspace never loaded behind it.
 */
export const DIALOG_WHY = `while Xcode shows a dialog it may not answer mac-build, and a workspace it is opening may not load (${DIALOG_PROBLEM})`;

/** The flag that turns off the checks that can stop a run (1, 2 and 3). */
export const NO_DIALOG_CHECK_FLAG = '--no-dialog-check';

/** The window server's layer for modal panels (kCGModalPanelWindowLevel). */
export const MODAL_PANEL_LAYER = 8;
/** How long between the two readings that checks 1 and 2 take. */
export const DIALOG_RECHECK_SECONDS = 3;
/** How long one window-list read may take before it counts as "could not check". */
const WINDOW_LIST_TIMEOUT_SECONDS = 15;
/** How long one picture may take. */
const CAPTURE_TIMEOUT_SECONDS = 15;

/**
 * Prints Xcode's windows from the window server's list as JSON. Reads only:
 * it sends Xcode nothing. A missing list throws, so osascript fails and the
 * reading is "could not check", never an empty list that reads as "none".
 */
export const XCODE_WINDOWS_SCRIPT = `
ObjC.import('CoreGraphics');
ObjC.import('Foundation');
const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, 0)));
if (!Array.isArray(list)) throw new Error('the window server gave no window list');
JSON.stringify(list.filter((w) => w.kCGWindowOwnerName === 'Xcode'));
`;

/** One window that looks like a dialog. */
export interface XcodeDialogWindow {
  height: number;
  /** null when the window server gave no title (no screen recording) or an empty one. */
  title: string | null;
  width: number;
  windowNumber: number;
}

/** One reading of the window server's list. `dialogs` is never empty. */
export type XcodeDialogReading =
  | {dialogs: XcodeDialogWindow[]; status: 'dialog'}
  | {reason: string; status: 'unknown'}
  | {status: 'none'};

/** One `osascript -l JavaScript` run: its stdout, or why it failed. */
export type JxaRun =
  | {reason: string; status: 'failed'}
  | {status: 'ok'; stdout: string};

/**
 * A picture of one window: where it was saved; why it was not taken (no
 * screen recording permission, or that could not be checked); or why taking
 * it failed.
 */
export type DialogPicture =
  | {path: string; status: 'saved'}
  | {reason: string; status: 'failed'}
  | {reason: string; status: 'skipped'};

/** Whether this process may record the screen (CGPreflightScreenCaptureAccess). */
export type ScreenRecordingAccess =
  | {reason: string; status: 'unknown'}
  | {status: 'denied'}
  | {status: 'granted'};

/**
 * Prints `true` or `false`: whether this process may record the screen. The
 * preflight never shows a prompt (CGRequestScreenCaptureAccess would). The
 * bridge metadata lacks the function (`$.CGPreflightScreenCaptureAccess is not
 * a function`, measured 2026-11-21), so it is bound by name.
 */
export const SCREEN_RECORDING_SCRIPT = `
ObjC.import('CoreGraphics');
ObjC.bindFunction('CGPreflightScreenCaptureAccess', ['bool', []]);
String($.CGPreflightScreenCaptureAccess());
`;

/** What the checks need from the world; tests pass fakes. */
export interface XcodeDialogDeps {
  /** Save a picture of one window (best effort). */
  capture: (windowNumber: number) => DialogPicture;
  /** One reading of the window server's list. */
  detect: () => XcodeDialogReading;
}

/** What checks 1 and 2 need besides: a log and a blocking sleep. */
export interface XcodeDialogCheckDeps extends XcodeDialogDeps {
  log: (message: string) => void;
  sleep: (seconds: number) => void;
}

function stderrOf(error: unknown): string | null {
  const stderr = (error as {stderr?: Buffer | string}).stderr
    ?.toString()
    .trim();
  return stderr != null && stderr !== '' ? stderr : null;
}

function timedOut(error: unknown): boolean {
  return (error as {code?: string}).code === 'ETIMEDOUT';
}

/** Run a JXA script fed on stdin. Never throws. */
export function runJxa(script: string): JxaRun {
  try {
    const stdout = execFileSync('osascript', ['-l', 'JavaScript', '-'], {
      encoding: 'utf8',
      input: script,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: WINDOW_LIST_TIMEOUT_SECONDS * 1000,
    });
    return {status: 'ok', stdout};
  } catch (error) {
    if (timedOut(error)) {
      return {
        reason: `osascript did not finish within ${WINDOW_LIST_TIMEOUT_SECONDS}s`,
        status: 'failed',
      };
    }
    const stderr = stderrOf(error);
    return {
      reason:
        stderr == null
          ? `osascript failed without reporting a reason (${error instanceof Error ? error.message : String(error)})`
          : `osascript reported: ${stderr}`,
      status: 'failed',
    };
  }
}

/** Ask once, through `run` (the real osascript by default). */
export function screenRecordingAccess(
  run: (script: string) => JxaRun = runJxa,
): ScreenRecordingAccess {
  const result = run(SCREEN_RECORDING_SCRIPT);
  if (result.status === 'failed') {
    return {reason: result.reason, status: 'unknown'};
  }
  const answer = result.stdout.trim();
  if (answer === 'true') return {status: 'granted'};
  if (answer === 'false') return {status: 'denied'};
  return {
    reason: `the permission check printed "${answer}"`,
    status: 'unknown',
  };
}

/** The fields of one window-list entry this reads; anything else is ignored. */
const windowSchema = z.object({
  kCGWindowBounds: z.object({Height: z.number(), Width: z.number()}),
  // Present, and true, only for a window on screen.
  kCGWindowIsOnscreen: z.boolean().optional(),
  kCGWindowLayer: z.number(),
  kCGWindowName: z.string().optional(),
  kCGWindowNumber: z.number(),
  kCGWindowOwnerName: z.string(),
});

/**
 * Read the script's output: the dialogs among Xcode's windows, none, or
 * could not check. A window that cannot be read does not hide a dialog seen in
 * another; with no dialog seen it makes the reading "could not check", since
 * the unread window could have been one.
 */
export function parseXcodeWindows(stdout: string): XcodeDialogReading {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    return {
      reason: `the window list was not JSON (${error instanceof Error ? error.message : String(error)})`,
      status: 'unknown',
    };
  }
  if (!Array.isArray(parsed)) {
    return {reason: 'the window list was not a JSON list', status: 'unknown'};
  }
  const dialogs: XcodeDialogWindow[] = [];
  const unreadable: string[] = [];
  for (const entry of parsed) {
    const window = windowSchema.safeParse(entry);
    if (!window.success) {
      unreadable.push(
        window.error.issues[0]?.path.join('.') ?? 'unknown field',
      );
      continue;
    }
    const w = window.data;
    if (
      w.kCGWindowOwnerName === 'Xcode' &&
      w.kCGWindowLayer === MODAL_PANEL_LAYER &&
      w.kCGWindowIsOnscreen === true
    ) {
      dialogs.push({
        height: w.kCGWindowBounds.Height,
        title:
          w.kCGWindowName != null && w.kCGWindowName !== ''
            ? w.kCGWindowName
            : null,
        width: w.kCGWindowBounds.Width,
        windowNumber: w.kCGWindowNumber,
      });
    }
  }
  if (dialogs.length > 0) return {dialogs, status: 'dialog'};
  if (unreadable.length > 0) {
    return {
      reason: `${unreadable.length} of ${parsed.length} windows in the list could not be read (first: ${unreadable[0]})`,
      status: 'unknown',
    };
  }
  return {status: 'none'};
}

/** One reading of the window server's list, through `run` (the real osascript by default). */
export function detectXcodeDialog(
  run: (script: string) => JxaRun = runJxa,
): XcodeDialogReading {
  const result = run(XCODE_WINDOWS_SCRIPT);
  if (result.status === 'failed') {
    return {
      reason: `the window list could not be read: ${result.reason}`,
      status: 'unknown',
    };
  }
  return parseXcodeWindows(result.stdout.trim());
}

/** `$XDG_STATE_HOME/justin-sdk/mac-build` (default `~/.local/state/…`). */
export function macBuildStateDir(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(xdgStateHome(env), 'justin-sdk', 'mac-build');
}

/** `xcode-dialog-2026-11-21T08-05-12-345Z.png` in the state dir. */
export function dialogPicturePath(
  at: Date,
  env: Record<string, string | undefined> = process.env,
): string {
  const stamp = at.toISOString().replace(/[:.]/g, '-');
  return join(macBuildStateDir(env), `xcode-dialog-${stamp}.png`);
}

/** What taking a picture needs from the world; tests pass fakes. */
export interface CaptureDeps {
  /** Whether this process may record the screen. */
  access: () => ScreenRecordingAccess;
  at: Date;
  /** Run screencapture for one window into `file`. */
  shoot: (windowNumber: number, file: string) => DialogPicture;
}

/**
 * Save a picture of one window with `screencapture -x -o -l <n>` (no sound, no
 * shadow, that window only). Best effort: any failure is a reason, never a
 * throw. An exit 0 that left no file, or an empty one, is a failure too.
 */
export function shootWindow(windowNumber: number, file: string): DialogPicture {
  try {
    mkdirSync(macBuildStateDir(), {recursive: true});
  } catch (error) {
    return {
      reason: `could not create ${macBuildStateDir()}: ${error instanceof Error ? error.message : String(error)}`,
      status: 'failed',
    };
  }
  try {
    execFileSync(
      'screencapture',
      ['-x', '-o', '-l', String(windowNumber), file],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: CAPTURE_TIMEOUT_SECONDS * 1000,
      },
    );
  } catch (error) {
    if (timedOut(error)) {
      return {
        reason: `screencapture did not finish within ${CAPTURE_TIMEOUT_SECONDS}s`,
        status: 'failed',
      };
    }
    const stderr = stderrOf(error);
    return {
      reason:
        stderr == null
          ? `screencapture failed (${error instanceof Error ? error.message : String(error)})`
          : `screencapture reported: ${stderr}`,
      status: 'failed',
    };
  }
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return {reason: 'screencapture wrote no file', status: 'failed'};
  }
  if (size === 0) {
    return {reason: 'screencapture wrote an empty file', status: 'failed'};
  }
  return {path: file, status: 'saved'};
}

/**
 * Save a picture of one window, only when this process may record the screen
 * (checked first, without a prompt). Denied, or not known, is no picture and
 * one reason saying why, so the run never raises a permission prompt and
 * never saves a picture without the dialog in it. Best effort: never throws.
 */
export function captureWindowPicture(
  windowNumber: number,
  deps: CaptureDeps = {
    access: () => screenRecordingAccess(),
    at: new Date(),
    shoot: shootWindow,
  },
): DialogPicture {
  const access = deps.access();
  if (access.status === 'denied') {
    return {
      reason:
        'this terminal does not have screen recording permission (System Settings › Privacy & Security › Screen & System Audio Recording)',
      status: 'skipped',
    };
  }
  if (access.status === 'unknown') {
    return {
      reason: `whether this terminal has screen recording permission could not be checked (${access.reason})`,
      status: 'skipped',
    };
  }
  return deps.shoot(windowNumber, dialogPicturePath(deps.at));
}

/** The real dependencies: the window server's list and screencapture. */
export function realXcodeDialogDeps(): XcodeDialogDeps {
  return {
    capture: (windowNumber) => captureWindowPicture(windowNumber),
    detect: () => detectXcodeDialog(),
  };
}

/** The real dependencies of checks 1 and 2. */
export function realXcodeDialogCheckDeps(
  log: (message: string) => void,
): XcodeDialogCheckDeps {
  return {
    ...realXcodeDialogDeps(),
    log,
    sleep: (seconds) => {
      Bun.sleepSync(seconds * 1000);
    },
  };
}

/** `"Title", 410x432` or `a window with no readable title, 410x432`, with its number. */
export function describeXcodeDialog(dialog: XcodeDialogWindow): string {
  const size = `${dialog.width}x${dialog.height}, window number ${dialog.windowNumber}`;
  return dialog.title == null
    ? `a window with no readable title, ${size}`
    : `"${dialog.title}", ${size}`;
}

/** `a dialog (…)`, or `2 dialogs (…; …)`. */
export function describeXcodeDialogs(dialogs: XcodeDialogWindow[]): string {
  const each = dialogs.map(describeXcodeDialog).join('; ');
  return dialogs.length === 1
    ? `a dialog (${each})`
    : `${dialogs.length} dialogs (${each})`;
}

/** One clause naming the picture, or saying why there is none. */
export function pictureClause(picture: DialogPicture): string {
  switch (picture.status) {
    case 'saved':
      return `A picture of it: ${picture.path}.`;
    case 'skipped':
      return `No picture of it was taken, because ${picture.reason}.`;
    case 'failed':
      return `A picture of it could not be saved (${picture.reason}).`;
  }
}

/** What two readings DIALOG_RECHECK_SECONDS apart came to (checks 1 and 2). */
export type SteadyDialogCheck =
  /** The same window was in both readings. */
  | {dialogs: XcodeDialogWindow[]; status: 'dialog'}
  /** Seen in the first reading, and not the same one in the second. */
  | {status: 'passing'}
  | {reason: string; status: 'unknown'}
  | {status: 'none'};

/**
 * Checks 1 and 2: read the list; if it shows a dialog, read it again
 * DIALOG_RECHECK_SECONDS later. Only a window that is in both readings counts,
 * so a panel that flashes past does not stop a run. Logs one line with what it
 * saw, `when` saying where in the run this is ("before anything in ios/
 * changes"), so a healthy build's log records every reading.
 */
export function checkForSteadyDialog(
  deps: XcodeDialogCheckDeps,
  when: string,
): SteadyDialogCheck {
  const prefix = `Dialog check ${when}:`;
  const first = deps.detect();
  if (first.status === 'none') {
    deps.log(`${prefix} Xcode shows none.`);
    return first;
  }
  if (first.status === 'unknown') {
    deps.log(
      `${prefix} could not check (${first.reason}), so the run goes on.`,
    );
    return first;
  }
  deps.sleep(DIALOG_RECHECK_SECONDS);
  const second = deps.detect();
  if (second.status === 'unknown') {
    deps.log(
      `${prefix} Xcode showed ${describeXcodeDialogs(first.dialogs)}, and the second check ${DIALOG_RECHECK_SECONDS}s later could not be made (${second.reason}), so the run goes on.`,
    );
    return second;
  }
  const steady =
    second.status === 'dialog'
      ? second.dialogs.filter((dialog) =>
          first.dialogs.some(
            (earlier) => earlier.windowNumber === dialog.windowNumber,
          ),
        )
      : [];
  if (steady.length === 0) {
    deps.log(
      `${prefix} Xcode showed ${describeXcodeDialogs(first.dialogs)}, and it was gone ${DIALOG_RECHECK_SECONDS}s later, so the run goes on.`,
    );
    return {status: 'passing'};
  }
  deps.log(
    `${prefix} Xcode is showing ${describeXcodeDialogs(steady)}, seen twice ${DIALOG_RECHECK_SECONDS}s apart.`,
  );
  return {dialogs: steady, status: 'dialog'};
}
