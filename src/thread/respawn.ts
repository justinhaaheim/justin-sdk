/**
 * The shared helpers of the retired `thread respawn` (home-base-1r6d.34.5),
 * kept because `thread spawn`, `open`, `close`, the drafts scan, the handoff
 * gate and `thread handoff`'s successor launch import them.
 *
 * `thread respawn` itself is RETIRED (epic home-base-mbnjv C3, one door, D1):
 * starting a successor is `thread handoff` with
 * componentConfig.thread.handoff.successor on (handoff-successor.ts), and the
 * command only prints RESPAWN_RETIRED_LINES and exits 2. What it measured
 * still holds and is why these helpers exist:
 *
 * - `cmux new-workspace --command <text>` (and `new-surface --command`) TYPES
 *   the text into the new pane's zsh, so every word goes through zshWord.
 * - The kickoff points at the block file: a raw block was read as pasted data.
 * - Closing its own workspace as the last tool call kills a session before
 *   its Stop hook, and /exit is not queued: a delayed close uses a detached
 *   child (closeLater).
 */

import type {EnvLike} from './paths';

import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

import {SDK_HANDOFF_CALL, sdkRun} from '../sdk-invocation';
import {oneLine} from './ask-format';

/** What `thread respawn` prints now, to stderr, before it exits 2. */
export const RESPAWN_RETIRED_LINES = [
  `thread respawn: retired: it is now \`${SDK_HANDOFF_CALL}\`, run bare from the repository root, with componentConfig.thread.handoff.successor on, which hands this session off and starts its successor in a new tab of this workspace (epic home-base-mbnjv). Run \`${SDK_HANDOFF_CALL} --help\`.`,
  'Nothing was written and nothing was started.',
] as const;

/**
 * One word as zsh must receive it: bare when every character is safe and it
 * does not start with "=" (zsh's EQUALS expansion turns `=ls` into /bin/ls).
 */
export function zshWord(word: string): string {
  if (/^[\w@%+=:,./-]+$/u.test(word) && !word.startsWith('=')) return word;
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** The successor's first message: an instruction, never the raw block. */
/**
 * The kickoff's fixed opening: every successor's first user line starts with
 * it (handoff-chain.ts reads it, home-base-mbnjv.8 F12).
 */
export const KICKOFF_OPENING =
  'You are the successor of a handed-off Claude Code session.';

export function kickoffText(block: string, bead: string, extra: string | null) {
  const base = `${KICKOFF_OPENING} Read ${block}. First run the command under its pick-up section: ${sdkRun(`thread request --continues ${bead}`)}. Then continue the work the block describes, starting from its note.`;
  const more = oneLine(extra ?? '');
  return more === '' ? base : `${base} ${more}`;
}

export function socketSettingsJson(socket: string): string {
  const settings = {sandbox: {network: {allowUnixSockets: [socket]}}};
  return `${JSON.stringify(settings)}\n`;
}

/**
 * CMUX_SOCKET_PATH, else what cmux recorded in its last-socket-path file.
 * Exported for `thread open` (home-base-yukaf.1), which follows the same rule.
 */
export function liveSocketPath(
  env: EnvLike,
): {path: string} | {reason: string} {
  const fromEnv = env.CMUX_SOCKET_PATH ?? '';
  const home = env.HOME ?? homedir();
  const file = join(home, '.local/state/cmux/last-socket-path');
  try {
    const path = fromEnv !== '' ? fromEnv : readFileSync(file, 'utf8').trim();
    return path === '' ? {reason: `${file} is empty`} : {path};
  } catch (error) {
    return {reason: `${file} cannot be read: ${String(error)}`};
  }
}

/** `sh -c 'sleep N; exec cmux …'`, detached, stdio ignored, unref'd. */
export function closeLater(
  argv: readonly string[],
  seconds: number,
  env: EnvLike,
): string | null {
  const args = ['-c', 'sleep "$0"; exec "$@"', String(seconds), ...argv];
  const how = {detached: true, env, stdio: 'ignore'} as const;
  try {
    const child = spawn('/bin/sh', args, how);
    child.unref();
    return child.pid == null ? 'the close child has no pid' : null;
  } catch (error) {
    return String(error);
  }
}
