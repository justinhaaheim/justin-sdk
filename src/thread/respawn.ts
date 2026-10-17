/**
 * `thread respawn` (home-base-1r6d.34.5): hand this session off and start its
 * successor in a new cmux workspace, with no human keystroke (alternative A
 * of epic home-base-1r6d.34, measured in home-base-1r6d.34.1):
 *
 * - `cmux new-workspace --command <text>` TYPES the text into the new pane's
 *   zsh, so every word goes through zshWord. Without --command nothing starts.
 * - The kickoff points at the block file: a raw block was read as pasted data.
 * - Closing its own workspace as the last tool call kills a session before
 *   its Stop hook, and /exit is not queued: --close-after uses a detached child.
 */

import type {Field} from '../cli-style';
import type {CmuxRunner} from './cmux';
import type {EnvLike} from './paths';

import {spawn} from 'node:child_process';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

import {fieldLines, outputStyle, sectionHeader, stepColumn} from '../cli-style';
import {sdkRun} from '../sdk-invocation';
import {oneLine} from './ask-format';
import {cmuxArgv, realCmuxRunner, resolveCmuxBinary} from './cmux';
import {threadsStateDir} from './paths';
import {handOff} from './session-handoff';
import {sessionDisplayName} from './session-name';
import {selectSession, sessionBeadsKnob} from './session-select';

export interface RespawnOptions {
  /** Seconds until this session's own workspace closes; 0 = never (default). */
  closeAfter: number;
  cwd?: string;
  dryRun: boolean;
  env?: EnvLike;
  kickoff: string | null;
  model: string | null;
  note: string | null;
  sessionId: string | null;
  successorSocket: boolean;
}

export interface RespawnDeps {
  /** Starts the delayed close, returns at once: null when started, else why not. */
  closeLater: typeof closeLater;
  handOff: typeof handOff;
  run: CmuxRunner;
}

/** Exit 0 the successor started · 1 a step failed · 2 refused, nothing written. */
interface RespawnResult {
  exitCode: 0 | 1 | 2;
  lines: string[];
}

function stop(exitCode: 1 | 2, text: string): RespawnResult {
  const verb = exitCode === 2 ? 'refused' : 'failed';
  return {exitCode, lines: [`thread respawn: ${verb}: ${text}`]};
}

/**
 * One word as zsh must receive it: bare when every character is safe and it
 * does not start with "=" (zsh's EQUALS expansion turns `=ls` into /bin/ls).
 */
export function zshWord(word: string): string {
  if (/^[\w@%+=:,./-]+$/u.test(word) && !word.startsWith('=')) return word;
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** The successor's first message: an instruction, never the raw block. */
export function kickoffText(block: string, bead: string, extra: string | null) {
  const base = `You are the successor of a handed-off Claude Code session. Read ${block}. First run the command under its pick-up section: ${sdkRun(`thread request --continues ${bead}`)}. Then continue the work the block describes, starting from its note.`;
  const more = oneLine(extra ?? '');
  return more === '' ? base : `${base} ${more}`;
}

export function socketSettingsJson(socket: string): string {
  const settings = {sandbox: {network: {allowUnixSockets: [socket]}}};
  return `${JSON.stringify(settings)}\n`;
}

/** CMUX_SOCKET_PATH, else what cmux recorded in its last-socket-path file. */
function liveSocketPath(env: EnvLike): {path: string} | {reason: string} {
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

export async function respawn(
  options: RespawnOptions,
  deps: Partial<RespawnDeps> = {},
): Promise<RespawnResult> {
  const {closeAfter, model, note} = options;
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  // ---- 1. refusals: nothing is written before these pass ----
  const workspace = env.CMUX_WORKSPACE_ID ?? '';
  if (workspace === '')
    return stop(2, 'not in a cmux pane (no CMUX_WORKSPACE_ID)');
  const socket = liveSocketPath(env);
  if ('reason' in socket) {
    return stop(2, `not in a cmux pane: no CMUX_SOCKET_PATH, ${socket.reason}`);
  }
  if (!Number.isInteger(closeAfter) || closeAfter < 0) {
    return stop(2, '--close-after takes a whole number of seconds, 0 or more');
  }
  const knob = await sessionBeadsKnob(cwd, env);
  if (!knob.ok) return stop(2, knob.reason);
  const sessionIdOption = options.sessionId;
  const selected = selectSession({env, selector: null, sessionIdOption});
  if (selected.kind === 'checkoutMissing') {
    return stop(2, `this session's checkout ${selected.checkoutPath} is gone`);
  }
  if (selected.kind !== 'found') return stop(2, selected.reason);
  const {session} = selected;
  const cmuxEnv = {...env, CMUX_QUIET: '1', CMUX_SOCKET_PATH: socket.path};
  const run = deps.run ?? realCmuxRunner(undefined, cmuxEnv);
  const ping = await run(['ping']);
  if (ping.kind === 'failed') {
    const allow = socketSettingsJson(socket.path).trim();
    const hint = `If this session is sandboxed, the sandbox blocks the cmux socket: add ${allow} to your Claude Code user settings, or retry with the sandbox disabled.`;
    return stop(2, `cmux cannot be reached: ${ping.reason}\n${hint}`);
  }

  // ---- the plan: every path and argument, before anything is written ----
  const dir = join(threadsStateDir(env), 'handoffs');
  const {sessionId} = session;
  const blockPath = join(dir, `${sessionId}.md`);
  const settingsFile = join(dir, 'cmux-sandbox-settings.json');
  const settingsPath = options.successorSocket ? settingsFile : null;
  const kickoff = kickoffText(blockPath, session.bead.id, options.kickoff);
  const words = ['claude'];
  if (model != null) words.push('--model', model);
  if (settingsPath != null) words.push('--settings', settingsPath);
  const command = [...words, kickoff].map(zshWord).join(' ');
  const repo = session.sightings.find((seen) => seen.repo != null)?.repo;
  const fullName = sessionDisplayName(repo ?? null, session.bead.title);
  const name = fullName.length > 80 ? `${fullName.slice(0, 79)}…` : fullName;
  const spawnArgs = ['new-workspace', '--name', name];
  spawnArgs.push('--cwd', session.checkoutPath, '--command', command);
  const binary = resolveCmuxBinary(cmuxEnv).path;
  const closeArgs = ['close-workspace', '--workspace', workspace];
  const closeArgv = [binary, ...cmuxArgv(cmuxEnv, closeArgs)];
  const closing = closeAfter > 0 ? `${workspace} in ${closeAfter} s` : 'none';
  const fields: Field[] = [
    {label: 'Block file', value: blockPath},
    {label: 'Settings file', value: settingsPath ?? 'none'},
    {label: 'Close', value: closing},
  ];
  const style = outputStyle();
  const report = (title: string, emoji: string) => [
    sectionHeader(title, {color: style.color, emoji}),
    '',
    fieldLines(fields, {...style, indent: stepColumn(0)}),
  ];

  if (options.dryRun) {
    const argv = JSON.stringify([binary, ...cmuxArgv(cmuxEnv, spawnArgs)]);
    const close = closeAfter > 0 ? JSON.stringify(closeArgv) : 'none';
    fields.push({label: 'Session bead', value: session.bead.id});
    fields.push({label: 'cmux argv', value: argv});
    fields.push({label: 'Kickoff', value: kickoff});
    fields.push({label: 'Close argv', value: close});
    const lines = report('Dry run: nothing written or spawned', '🔎');
    return {exitCode: 0, lines};
  }

  // ---- 2. the handoff: label handed-off, append the note, build the block ----
  const hand = deps.handOff ?? handOff;
  const handed = await hand({cwd, env, note, sessionId, to: null});
  if (handed.kind === 'failed') return stop(1, `the handoff: ${handed.reason}`);
  if (handed.block === '' || handed.followUpFailures.length > 0) {
    const why = handed.followUpFailures.join('; ');
    return stop(1, `the session WAS marked handed off, but: ${why}`);
  }

  // ---- 3, 4. the block file, and the socket settings when asked ----
  try {
    mkdirSync(dir, {recursive: true});
    writeFileSync(blockPath, `${handed.block}\n`);
    if (settingsPath != null) {
      writeFileSync(settingsPath, socketSettingsJson(socket.path));
    }
  } catch (error) {
    const why = `writing ${blockPath} (the session WAS handed off): ${String(error)}`;
    return stop(1, why);
  }

  // ---- 5. the successor ----
  const spawned = await run(spawnArgs);
  const stdout = spawned.kind === 'ok' ? spawned.stdout.trim() : '';
  const ref = /^OK\s+(\S+)/u.exec(stdout)?.[1] ?? null;
  if (ref == null) {
    const cmux =
      spawned.kind === 'failed'
        ? spawned.reason
        : `cmux printed ${JSON.stringify(stdout)}`;
    const why = `starting the successor (the session WAS handed off; the block is in ${blockPath}): ${cmux}`;
    return stop(1, why);
  }
  fields.push({label: 'Successor', value: `${ref} "${name}"`});

  // ---- 7. the delayed close ----
  const close = deps.closeLater ?? closeLater;
  const notStarted =
    closeAfter > 0 ? close(closeArgv, closeAfter, cmuxEnv) : null;
  if (notStarted != null) {
    const why = `scheduling the close (the successor DID start, as ${ref}; close this workspace by hand): ${notStarted}`;
    return stop(1, why);
  }
  const next = 'Next: write your last message and end the turn.';
  return {exitCode: 0, lines: [...report('Successor started', '🤝'), '', next]};
}

export async function runThreadRespawn(options: RespawnOptions) {
  const {exitCode, lines} = await respawn(options);
  const write = exitCode === 0 ? console.log : console.error;
  for (const line of lines) write(line);
  return exitCode;
}
