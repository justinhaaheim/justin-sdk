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
 * A word with a non-ASCII character, spelled in pure ASCII: `$'...'`, with each
 * byte outside printable ASCII as \xHH (home-base-y0gdz). A non-ASCII character
 * typed in a launch line arrived damaged, measured 2026-11-06: an em dash was
 * stored as c3 a2 20 20. zsh rebuilds the exact bytes before the program runs.
 * `!` is escaped too, so no history expansion can apply to the typed line.
 */
function zshAsciiWord(word: string): string {
  let spelled = '';
  for (const byte of Buffer.from(word, 'utf8')) {
    if (byte === 0x5c) spelled += '\\\\';
    else if (byte === 0x27) spelled += "\\'";
    else if (byte >= 0x20 && byte < 0x7f && byte !== 0x21) {
      spelled += String.fromCharCode(byte);
    } else spelled += `\\x${byte.toString(16).padStart(2, '0')}`;
  }
  return `$'${spelled}'`;
}

/**
 * One word as zsh must receive it: bare when every character is safe and it
 * does not start with "=" (zsh's EQUALS expansion turns `=ls` into /bin/ls). A
 * word holding non-ASCII is spelled in pure ASCII; an ASCII word never is.
 */
export function zshWord(word: string): string {
  if (/^[\w@%+=:,./-]+$/u.test(word) && !word.startsWith('=')) return word;
  if (/[^\p{ASCII}]/u.test(word)) return zshAsciiWord(word);
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * home-base-8vywn: the most bytes a command TYPED into a new pane may hold.
 *
 * Measured 2026-11-03 by the mayor: a 1,088-byte `thread spawn` command
 * arrived in the new pane as exactly its first 1,024 bytes, quote unclosed,
 * so zsh never ran it and claude never started; a 517-byte one worked. 1,024
 * is macOS's terminal canonical-mode line limit (MAX_CANON), so the cut is
 * most likely the pty's line buffer while zsh is still starting up (inferred
 * from the exact match, not verified against cmux's source).
 *
 * 1,000, not 1,024: the longest command allowed is 999 bytes, 1,000 with the
 * Enter that ends the line, which leaves 24 bytes for anything cmux adds that
 * has not been measured. A command of 1,000 bytes or more is refused before
 * cmux is touched (typedCommandTooLong). Bytes, never characters: "é" is 2
 * bytes, "🎵" is 4, and an apostrophe costs 4 once zshWord quotes it.
 */
export const TYPED_COMMAND_BYTE_LIMIT = 1000;

/** The UTF-8 length of a command typed into a pane. */
export function typedCommandBytes(command: string): number {
  return Buffer.byteLength(command, 'utf8');
}

/**
 * null when `command` is short enough to type into a pane whole; otherwise
 * why it would be cut (home-base-8vywn). A cut command never runs, and a
 * caller that only checks cmux's answer would report it as opened.
 */
export function typedCommandTooLong(command: string): string | null {
  const bytes = typedCommandBytes(command);
  if (bytes < TYPED_COMMAND_BYTE_LIMIT) return null;
  return `the command typed into the new pane would be ${bytes} bytes, and a typed line must stay under ${TYPED_COMMAND_BYTE_LIMIT} bytes: macOS cuts it at 1,024, so the shell would never run it`;
}

/** The successor's first message: an instruction, never the raw block. */
/**
 * The kickoff's fixed opening: every successor's first user line starts with
 * it (handoff-chain.ts reads it, home-base-mbnjv.8 F12).
 */
export const KICKOFF_OPENING =
  'You are the successor of a handed-off Claude Code session.';

export function kickoffText(
  block: string,
  bead: string,
  extra: string | null,
  options: {autoPickup?: boolean} = {},
) {
  const command = sdkRun(`thread request --continues ${bead}`);
  // home-base-npbse.1.2 item 6: with the knob on the system runs the pickup, so
  // the successor only checks. Knob off: the words stay exactly as they were.
  const pickup =
    options.autoPickup === true
      ? `Check that ${sdkRun('thread status')} shows the requests carried over; if it says the pickup is not done, run: ${command}.`
      : `First run the command under its pick-up section: ${command}.`;
  // P6 (home-base-npbse.1.1): the scope sentence is here as well as in the
  // block, because a session once read the note as the whole scope.
  const base = `${KICKOFF_OPENING} Read ${block}. ${pickup} Every open request and question carries over to this session; the note is the order to take them in, not the whole scope. Then continue the work the block describes, starting from its note.`;
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
