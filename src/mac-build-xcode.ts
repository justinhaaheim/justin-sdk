/**
 * mac-build-xcode.ts — the AppleScript half of `justin-sdk mac-build` that
 * opens the workspace in Xcode and waits for it to load (home-base-0jeya.13, D1).
 *
 * WHY IT NEVER WAITS ON `open`. On 2026-11-19 the screenshot app's full build
 * compiled in 170 s and then failed after 496 s with "AppleEvent timed out.
 * (-1712)" at exactly the `open "<workspace>"` statement: Xcode did not answer
 * `open` within the 300 s Apple Event limit while it loaded the freshly
 * regenerated workspace. So `open` is now sent once, fire and forget, and the
 * load is watched from TypeScript with short polls. A poll that times out means
 * Xcode is busy, not that anything failed; it is counted and asked again, up to
 * a 15-minute ceiling. The time Xcode took is logged, because nobody yet knows
 * why it needed more than 300 s.
 *
 * `open` is sent at most once per run, and only when Xcode does not already
 * list the workspace: Xcode never answers an `open` for a workspace it already
 * has.
 *
 * Nothing here signs, so the screen-lock guard is mac-build.ts's job (it runs
 * the guard before calling this, and again before Xcode's build).
 *
 * A DIALOG STOPS THE WAIT (home-base-0jeya.13, D6, check 3). On 2026-11-21
 * every poll answered promptly, "loading", for the whole 15 minutes, while
 * Xcode showed a dialog (docs/mac-build-problems.md, problem 8). So after
 * every poll that does not end the wait (loading, absent, not running, and a
 * poll Xcode was too busy to answer), the window server's list is read too
 * (mac-build-xcode-dialog.ts): it answers whether or not Xcode does, so a
 * dialog that keeps Xcode from answering at all is seen as well. A dialog that
 * stays for DIALOG_STOPS_WAIT_SECONDS fails the wait with the dialog named.
 * `--no-dialog-check` turns this off (deps.dialog is null).
 */

import {execFileSync} from 'child_process';

import {
  describeXcodeDialogs,
  DIALOG_PROBLEM,
  pictureClause,
  type XcodeDialogDeps,
  type XcodeDialogWindow,
} from './mac-build-xcode-dialog';

/** Check 3's dependencies, and the command its failure names to skip it. */
export interface LoadWaitDialogCheck extends XcodeDialogDeps {
  /** The command that runs again with `--no-dialog-check`. */
  withoutCheckCommand: string;
}

/** How often to ask whether the workspace has loaded. */
export const WORKSPACE_POLL_SECONDS = 2;
/** Each poll's own Apple Event limit. A poll past it is "Xcode is busy". */
export const WORKSPACE_POLL_EVENT_TIMEOUT_SECONDS = 20;
/** The ceiling for the whole open-and-load wait. */
export const WORKSPACE_LOAD_CEILING_SECONDS = 15 * 60;
/**
 * After the open, how long "Xcode is not running" counts as "still starting".
 * AppleScript launches Xcode before it sends the open, so this is a margin, not
 * a measured launch time.
 */
export const XCODE_START_GRACE_SECONDS = 30;
/** How often to say that the wait is still going. */
const PROGRESS_EVERY_SECONDS = 60;
/**
 * How long one dialog may stay in Xcode, while the polls answer loading or
 * absent, before the wait stops (D6, check 3).
 */
export const DIALOG_STOPS_WAIT_SECONDS = 30;

/** One osascript run: its trimmed stdout, or its stderr (null when it gave none). */
export type OsascriptRun =
  | {status: 'failed'; stderr: string | null}
  | {status: 'ok'; stdout: string};

/** Run an AppleScript fed on stdin (no shell quoting involved). Never throws. */
export function runOsascript(script: string): OsascriptRun {
  try {
    const stdout = execFileSync('osascript', ['-'], {
      encoding: 'utf8',
      input: script,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return {status: 'ok', stdout: stdout.trim()};
  } catch (error) {
    const stderr = (error as {stderr?: Buffer | string}).stderr
      ?.toString()
      .trim();
    return {
      status: 'failed',
      stderr: stderr != null && stderr !== '' ? stderr : null,
    };
  }
}

/**
 * Whether osascript failed because an Apple Event got no reply in time, as in
 * `683:757: execution error: Xcode got an error: AppleEvent timed out. (-1712)`.
 */
export function isAppleEventTimeout(stderr: string | null): boolean {
  return stderr?.includes('(-1712)') === true;
}

/** Quote a value for interpolation into an AppleScript string literal. */
export function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Asks whether Xcode lists the workspace and has loaded it. Prints `loaded`,
 * `loading`, `absent` or `not running`. It never launches Xcode: the running
 * test is answered without sending Xcode anything.
 *
 * The running test sits BEFORE the `tell` block, as `application "Xcode" is
 * not running`. Inside `tell application "Xcode"`, the form that tests `it`
 * is always true, whether Xcode runs or not (measured 2026-11-21), so every
 * poll answered "not running" and a build failed 31 s after the open while
 * Xcode was running (docs/mac-build-problems.md, problem 12).
 */
export function workspacePollScript(workspacePath: string): string {
  const quoted = appleScriptString(workspacePath);
  return `
if application "Xcode" is not running then return "not running"
with timeout of ${WORKSPACE_POLL_EVENT_TIMEOUT_SECONDS} seconds
tell application "Xcode"
    repeat with theDocument in workspace documents
        if (path of theDocument as string) is equal to ${quoted} then
            if loaded of theDocument is true then return "loaded"
            return "loading"
        end if
    end repeat
    return "absent"
end tell
end timeout
`;
}

/**
 * Brings Xcode forward (launching it if needed) and asks it to open the
 * workspace, without waiting for either reply.
 */
export function workspaceOpenScript(workspacePath: string): string {
  return `
tell application "Xcode"
    ignoring application responses
        activate
        open ${appleScriptString(workspacePath)}
    end ignoring
end tell
`;
}

export interface WorkspaceOpenDeps {
  /** The window server's list, for a dialog (check 3); null when `--no-dialog-check` turned it off. */
  dialog: LoadWaitDialogCheck | null;
  log: (message: string) => void;
  /** Milliseconds, like Date.now. */
  now: () => number;
  osascript: (script: string) => OsascriptRun;
  sleep: (seconds: number) => void;
}

export type WorkspaceOpenOutcome =
  | {
      busyPolls: number;
      openSent: boolean;
      polls: number;
      /** From the open when one was sent, otherwise from the first poll. */
      seconds: number;
      status: 'loaded';
    }
  | {reason: string; status: 'failed'};

function wholeSeconds(ms: number): number {
  return Math.round(ms / 1000);
}

function xcodeSaid(stderr: string | null): string {
  return stderr == null
    ? 'Xcode failed without reporting a reason.'
    : `Xcode reported: ${stderr}`;
}

/**
 * Check 3 (D6): one reading of the window server's list after every poll that
 * does not end the wait, whether Xcode answered it or was too busy to. Returns
 * the reason to stop the wait once the same window has been in every reading
 * for DIALOG_STOPS_WAIT_SECONDS, otherwise null.
 *
 * A reading of none starts the count over. A reading that could not be made
 * starts nothing over and stops nothing; it is logged once. Logs the first
 * reading and every change, not every reading.
 */
function dialogWatcher(
  workspacePath: string,
  check: LoadWaitDialogCheck,
  deps: WorkspaceOpenDeps,
): () => string | null {
  let since: number | null = null;
  let windows: XcodeDialogWindow[] = [];
  let firstReading = true;
  let unknownLogged = false;
  return () => {
    const reading = check.detect();
    const first = firstReading;
    firstReading = false;
    if (reading.status === 'unknown') {
      if (!unknownLogged) {
        unknownLogged = true;
        deps.log(
          `Dialog check while Xcode loads the workspace: could not check (${reading.reason}), so the wait goes on.`,
        );
      }
      return null;
    }
    if (reading.status === 'none') {
      if (first) {
        deps.log(
          'Dialog check while Xcode loads the workspace: Xcode shows none.',
        );
      } else if (since != null) {
        deps.log(
          'The window that looked like a dialog in Xcode has gone; still waiting for the workspace to load.',
        );
      }
      since = null;
      windows = [];
      return null;
    }
    const nowMs = deps.now();
    const same = reading.dialogs.filter((dialog) =>
      windows.some((earlier) => earlier.windowNumber === dialog.windowNumber),
    );
    if (since == null || same.length === 0) {
      since = nowMs;
      windows = reading.dialogs;
      deps.log(
        `Xcode is showing what looks like ${describeXcodeDialogs(windows)}; if it is still there in ${DIALOG_STOPS_WAIT_SECONDS}s, the wait stops.`,
      );
      return null;
    }
    windows = same;
    if (nowMs - since < DIALOG_STOPS_WAIT_SECONDS * 1000) return null;
    const [shown] = windows;
    const picture = shown == null ? null : check.capture(shown.windowNumber);
    return `Xcode has shown ${describeXcodeDialogs(windows)} for ${wholeSeconds(nowMs - since)}s while ${workspacePath} had not loaded (${DIALOG_PROBLEM}).${picture == null ? '' : ` ${pictureClause(picture)}`} Look at Xcode and answer the dialog as problem 8 says. If that window is not a dialog, \`${check.withoutCheckCommand}\` skips this check.`;
  };
}

/**
 * Open the workspace in Xcode if it is not listed, and wait until Xcode has
 * loaded it (D1). Polls every WORKSPACE_POLL_SECONDS; a poll that times out
 * (-1712) counts as busy; any other error fails at once. Fails after
 * WORKSPACE_LOAD_CEILING_SECONDS, saying how long Xcode had been loading.
 * Logs one line with the time it took once the workspace is loaded. A dialog
 * that stays DIALOG_STOPS_WAIT_SECONDS before the workspace loads fails the
 * wait at once, naming it (D6, check 3: dialogWatcher), unless deps.dialog is
 * null (`--no-dialog-check`).
 */
export function openWorkspaceAndWaitForLoad(
  workspacePath: string,
  deps: WorkspaceOpenDeps,
): WorkspaceOpenOutcome {
  const startedMs = deps.now();
  const deadlineMs = startedMs + WORKSPACE_LOAD_CEILING_SECONDS * 1000;
  const pollScript = workspacePollScript(workspacePath);
  let openSentMs: number | null = null;
  let listed = false;
  let polls = 0;
  let busyPolls = 0;
  let lastProgressMs = startedMs;
  const watchForDialog =
    deps.dialog == null
      ? null
      : dialogWatcher(workspacePath, deps.dialog, deps);
  if (watchForDialog == null) {
    deps.log(
      'Dialog check while Xcode loads the workspace: off (--no-dialog-check).',
    );
  }

  const checks = (): string =>
    `${busyPolls} of ${polls} checks found Xcode too busy to answer within ${WORKSPACE_POLL_EVENT_TIMEOUT_SECONDS}s`;

  for (;;) {
    const run = deps.osascript(pollScript);
    polls += 1;
    if (run.status === 'failed') {
      if (!isAppleEventTimeout(run.stderr)) {
        return {
          reason: `Could not ask Xcode whether it has ${workspacePath} open — ${xcodeSaid(run.stderr)}`,
          status: 'failed',
        };
      }
      busyPolls += 1;
    } else {
      const answer = run.stdout;
      if (answer === 'loaded') {
        const seconds = wholeSeconds(deps.now() - (openSentMs ?? startedMs));
        if (openSentMs != null) {
          deps.log(
            `Xcode opened and loaded the workspace in ${seconds}s (${checks()}).`,
          );
        } else if (polls === 1) {
          deps.log('The workspace was already open and loaded in Xcode.');
        } else {
          deps.log(
            `Xcode finished loading the workspace, which it already had open, in ${seconds}s (${checks()}).`,
          );
        }
        return {
          busyPolls,
          openSent: openSentMs != null,
          polls,
          seconds,
          status: 'loaded',
        };
      }
      if (answer === 'loading') {
        listed = true;
      } else if (answer === 'absent' || answer === 'not running') {
        if (openSentMs == null) {
          deps.log(
            `Opening the workspace in Xcode, and waiting for it to load (up to ${WORKSPACE_LOAD_CEILING_SECONDS / 60} minutes)…`,
          );
          const opened = deps.osascript(workspaceOpenScript(workspacePath));
          openSentMs = deps.now();
          if (opened.status === 'failed') {
            return {
              reason: `Could not ask Xcode to open ${workspacePath} — ${xcodeSaid(opened.stderr)}`,
              status: 'failed',
            };
          }
        } else if (
          answer === 'not running' &&
          deps.now() - openSentMs > XCODE_START_GRACE_SECONDS * 1000
        ) {
          return {
            reason: `Xcode was not running ${wholeSeconds(deps.now() - openSentMs)}s after it was asked to open ${workspacePath}: it quit, or crashed, while opening it.`,
            status: 'failed',
          };
        }
      } else {
        return {
          reason: `Xcode gave an answer this does not understand when asked whether it has ${workspacePath} open: "${answer}".`,
          status: 'failed',
        };
      }
    }

    // Every poll that reaches here did not end the wait: loading, absent, not
    // running, or too busy to answer. The window server answers either way.
    if (watchForDialog != null) {
      const dialogStop = watchForDialog();
      if (dialogStop != null) return {reason: dialogStop, status: 'failed'};
    }

    const nowMs = deps.now();
    if (nowMs >= deadlineMs) {
      const reason =
        openSentMs != null
          ? `Xcode had still not loaded ${workspacePath} ${wholeSeconds(nowMs - openSentMs)}s after it was asked to open it (the limit is ${WORKSPACE_LOAD_CEILING_SECONDS / 60} minutes; ${checks()}).`
          : listed
            ? `Xcode had ${workspacePath} open but had still not finished loading it after ${wholeSeconds(nowMs - startedMs)}s (the limit is ${WORKSPACE_LOAD_CEILING_SECONDS / 60} minutes; ${checks()}).`
            : `Xcode did not answer for ${wholeSeconds(nowMs - startedMs)}s (${checks()}), so the workspace was never opened.`;
      return {reason, status: 'failed'};
    }
    if (nowMs - lastProgressMs >= PROGRESS_EVERY_SECONDS * 1000) {
      lastProgressMs = nowMs;
      deps.log(
        `Still waiting for Xcode to load the workspace (${wholeSeconds(nowMs - (openSentMs ?? startedMs))}s so far; ${checks()}).`,
      );
    }
    deps.sleep(WORKSPACE_POLL_SECONDS);
  }
}

/**
 * The real dependencies: osascript, the clock, and a blocking sleep. `dialog`
 * is check 3, or null when `--no-dialog-check` turned it off.
 */
export function realWorkspaceOpenDeps(
  log: (message: string) => void,
  dialog: LoadWaitDialogCheck | null,
): WorkspaceOpenDeps {
  return {
    dialog,
    log,
    now: Date.now,
    osascript: runOsascript,
    sleep: (seconds) => {
      Bun.sleepSync(seconds * 1000);
    },
  };
}
