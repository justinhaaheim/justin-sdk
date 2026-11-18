/**
 * home-base-kwand.3 (gap G3 of epic home-base-kwand): the ONE builder of the
 * cmux command that reopens a session whose cmux restore failed as a NEW tab
 * of its old workspace. Two callers: the threads dashboard's `o`
 * (src/threads-dash/state.ts `newSurfaceCommand`, `focus: true`) and `thread
 * open --restore-failed` (open-restore-failed.ts, `focus: false`, so a bulk
 * run does not pull every tab to the front).
 *
 * Decision D2 of the epic: the failed tab is never typed into, sent to or
 * closed; the session comes back beside it. `new-surface --command` types the
 * text into the new tab's zsh (docs/reference/cmux.md, measured), which opens
 * in cmux's own directory, so the text carries the `cd <checkout> &&` itself.
 * This module imports nothing at run time, so the dashboard can load it
 * cheaply.
 */

import type {BeforeRestartState} from './before-restart-state';

/**
 * home-base-kwand.14: the before-restart states (before-restart-state.ts)
 * whose session gets this resume, in the one order every list uses. Both mean
 * its old tab is back and no Claude of its own runs in it:
 *  - restoreFailed: the tab shows cmux's restore error;
 *  - shellInTab: a plain shell with no error shown, or a shell prompt on a tty
 *    that another tab's Claude holds. The session itself is never the one
 *    running there: the pane join would place it, and the state would be
 *    runningAgain.
 * Every caller keeps the two apart in what it prints: they mean different
 * things to Justin.
 */
export const OLD_TAB_RESUME_STATES = [
  'restoreFailed',
  'shellInTab',
] as const satisfies readonly BeforeRestartState[];

export type OldTabResumeState = (typeof OLD_TAB_RESUME_STATES)[number];

/** True when a session in this before-restart state gets the old-workspace resume. */
export function isOldTabResumeState(
  state: string | null | undefined,
): state is OldTabResumeState {
  return (
    state != null &&
    (OLD_TAB_RESUME_STATES as readonly string[]).includes(state)
  );
}

/** A cmux uuid (workspace, surface), any case. */
export const CMUX_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * `new-surface --type terminal --workspace <uuid> --command <text> --focus
 * true|false`: the argv after `cmux`. Null when the workspace is not a uuid
 * (cmux's --workspace defaults to the CALLER's workspace, so it is never left
 * out or guessed) or the command is empty.
 */
export function restoreTabArgs(input: {
  command: string;
  focus: boolean;
  workspaceId: string;
}): string[] | null {
  if (!CMUX_UUID.test(input.workspaceId) || input.command.trim() === '') {
    return null;
  }
  return [
    'new-surface',
    '--type',
    'terminal',
    '--workspace',
    input.workspaceId,
    '--command',
    input.command,
    '--focus',
    input.focus ? 'true' : 'false',
  ];
}
