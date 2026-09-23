/**
 * The USER-LEVEL SessionStart hook — the half of D6 that reaches UNENROLLED repos.
 *
 * Epic home-base-dchjw D6 retired the `prime` plugin, and the plugin was the
 * only thing that put the repo-state block in front of a session started in a
 * repo that has never heard of the SDK (the threads repo, a scratch clone,
 * ~/Downloads). Justin's requirement that the repo state reach EVERY repo is
 * preserved by one entry in `~/.claude/settings.json` calling
 * `justin-sdk-latest session-start --user-level`.
 *
 * THIS MODULE NEVER WRITES `~/.claude/settings.json`, and nothing in the SDK
 * may. It is Justin's own file, it is not a repo artifact, and a tool that
 * edits it is a tool reaching outside every project boundary it has. The
 * doctor check built on `checkUserLevelSessionStart` warns and prints the JSON;
 * pasting it in is a one-time human step (and dotfiles' job on a new machine).
 *
 * THE GUARD IS IN THE HOOK STRING, not just in the command (F4). Three cheap
 * shell tests run before anything is spawned:
 *   1. `[ -e "$CLAUDE_PROJECT_DIR/justin-sdk.config.json" ]` — an enrolled repo
 *      has its own project hook, which does strictly more. Short-circuiting
 *      here means an enrolled repo never pays a process spawn, let alone the
 *      `ls-remote` inside `justin-sdk-latest`.
 *   2. `! command -v justin-sdk-latest` — the bin lives in home-base, which a
 *      fresh machine may not have on PATH yet. A hook that errors every session
 *      on such a machine would be worse than no hook.
 *   3. only then, the command — which re-checks enrolment itself, because
 *      `CLAUDE_PROJECT_DIR` is not guaranteed to be set and `:-.` falls back to
 *      whatever cwd the hook happened to run in.
 * Each test SUCCEEDING means "do not run", so they are chained with `||`: the
 * whole line exits 0 in every one of those cases, which is what a SessionStart
 * hook must do.
 */

import {existsSync, readFileSync} from 'fs';
import {homedir} from 'os';
import {join} from 'path';

import {SDK_LATEST} from './sdk-invocation';

/** `~/.claude/settings.json` — Justin's user-level Claude Code settings. */
export function userSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json');
}

/** Display form, for messages. Never used to open anything. */
export const USER_SETTINGS_DISPLAY = '~/.claude/settings.json';

/** The one-line shell command the user-level SessionStart hook runs. See above. */
export const USER_LEVEL_HOOK_COMMAND = `[ -e "\${CLAUDE_PROJECT_DIR:-.}/justin-sdk.config.json" ] || ! command -v ${SDK_LATEST} >/dev/null || ${SDK_LATEST} session-start --user-level`;

/**
 * The exact JSON to merge into `~/.claude/settings.json`.
 *
 * Built by serialising the real structure rather than typed as a string
 * literal, so the command above cannot drift from the snippet advice prints.
 */
export const USER_LEVEL_HOOK_JSON = JSON.stringify(
  {
    hooks: {
      SessionStart: [
        {hooks: [{command: USER_LEVEL_HOOK_COMMAND, type: 'command'}]},
      ],
    },
  },
  null,
  2,
);

export type UserLevelHookStatus =
  /** The hook is there. */
  | 'installed'
  /** Settings read and parsed; no such hook in it. */
  | 'absent'
  /** The file exists but could not be read or parsed — NOT the same as absent. */
  | 'cannot-check';

export interface UserLevelHookResult {
  message: string;
  status: UserLevelHookStatus;
}

/** Does this command string invoke `session-start --user-level`, however spelled? */
function isUserLevelSessionStart(command: string): boolean {
  return command.includes('session-start') && command.includes('--user-level');
}

/** Every `command` string under `hooks.SessionStart`, defensively walked. */
function sessionStartCommands(settings: unknown): string[] {
  const hooks = (settings as {hooks?: unknown}).hooks;
  if (hooks == null || typeof hooks !== 'object') return [];
  const events = (hooks as {SessionStart?: unknown}).SessionStart;
  if (!Array.isArray(events)) return [];

  const commands: string[] = [];
  for (const entry of events) {
    const inner = (entry as {hooks?: unknown}).hooks;
    if (!Array.isArray(inner)) continue;
    for (const hook of inner) {
      const command = (hook as {command?: unknown}).command;
      if (typeof command === 'string') commands.push(command);
    }
  }
  return commands;
}

/**
 * Is the user-level SessionStart hook installed?
 *
 * READ-ONLY. A missing file is `absent` (a real, measured answer: there is no
 * hook), but a file that cannot be READ or PARSED is `cannot-check` and must
 * never be reported as `absent` — "I could not look" and "I looked and it is
 * not there" are different facts, and only one of them justifies telling Justin
 * to paste something in (rule 6).
 */
export function checkUserLevelSessionStart(): UserLevelHookResult {
  const path = userSettingsPath();
  if (!existsSync(path)) {
    return {
      message: `${USER_SETTINGS_DISPLAY} does not exist, so the user-level session-start hook is not installed`,
      status: 'absent',
    };
  }

  let settings: unknown;
  try {
    settings = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      message: `${USER_SETTINGS_DISPLAY} could not be read or parsed (${reason}) — whether the user-level session-start hook is installed is UNKNOWN, not "no"`,
      status: 'cannot-check',
    };
  }

  return sessionStartCommands(settings).some(isUserLevelSessionStart)
    ? {
        message: `${SDK_LATEST} session-start --user-level is registered in ${USER_SETTINGS_DISPLAY}`,
        status: 'installed',
      }
    : {
        message: `${USER_SETTINGS_DISPLAY} has no session-start --user-level hook, so UNENROLLED repos get no repo-state block at session start`,
        status: 'absent',
      };
}

/** The advice line for the doctor check: what to do, and where. */
export function userLevelHookAdvice(): string {
  return `Add this to ${USER_SETTINGS_DISPLAY} by hand (justin-sdk never writes it):\n${USER_LEVEL_HOOK_JSON}`;
}
