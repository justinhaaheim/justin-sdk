/**
 * `thread spawn` (home-base-yukaf.7, decision D-SPAWN, route a of ask
 * aasbl.18): open a new cmux workspace in a chosen directory, running a fresh
 * `claude`, with Remote Control when asked. Justin runs it through the
 * `/spawn-session` skill from a session he reaches on his phone, so he can
 * start a new local session while he is away from the Mac.
 *
 * - It reuses respawn.ts's rules: the socket is CMUX_SOCKET_PATH or cmux's
 *   last-socket-path file, a `cmux ping` comes first, and an unreachable cmux
 *   is a refusal (exit 2) that prints the sandbox setting. `new-workspace
 *   --command` TYPES the command into the new pane's zsh, so every word goes
 *   through zshWord.
 * - The workspace is named sessionDisplayName(repoTag, title), the same
 *   "[TAG] title" the inbox and `thread open` use, with the tag from the
 *   resolver the inbox uses (resolveRepoTag).
 * - With --remote-control the same name goes to `claude --remote-control
 *   <name>`, so the Claude app lists the session under the name this command
 *   prints. Measured 2026-10-18 against code.claude.com/docs/en/remote-control:
 *   a name passed to --remote-control is the first source of the session's
 *   title, and without one Claude Code makes one up from the hostname.
 * - --dry-run prints the plan and touches no cmux. It writes nothing anywhere,
 *   and neither does a real run: cmux is its only side effect.
 * - The route b alternative, a persistent `claude remote-control` server, is
 *   home-base-pa2s and is not built here.
 */

import type {Field} from '../cli-style';
import type {CmuxRunner} from './cmux';
import type {EnvLike} from './paths';

import {readFileSync, statSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename, join, resolve} from 'node:path';

import {
  fieldLines,
  outputStyle,
  sectionHeader,
  stepColumn,
  wrapHanging,
} from '../cli-style';
import {oneLine} from './ask-format';
import {cmuxArgv, realCmuxRunner, resolveCmuxBinary} from './cmux';
import {primaryCheckoutOf, resolveRepoTag} from './config';
import {liveSocketPath, socketSettingsJson, zshWord} from './respawn';
import {SPAWN_KICKOFF_ENV, SPAWNED_BY_SESSION_ENV} from './session-bead';
import {sessionDisplayName} from './session-name';
import {sessionIdFrom} from './session-select';
import {spawnGate} from './spawn-gate';
import {describeNewWorkspaceRecord, recordNewWorkspace} from './workspace-name';

export interface SpawnOptions {
  /** Where a relative <dir> is resolved from (default: process.cwd()). */
  cwd?: string;
  /** The directory the new session starts in, as typed (`~` allowed). */
  dir: string | null;
  dryRun: boolean;
  env?: EnvLike;
  /**
   * The first prompt, handed to `claude` as its positional argument so the
   * session starts working with no keystroke (the respawn.ts pattern); null:
   * the session opens on an empty prompt.
   */
  kickoff: string | null;
  /** `claude --model`; null: claude's own default. */
  model: string | null;
  /** The title after "[TAG] "; null: "new session <dir basename>". */
  name: string | null;
  /** Start claude with --remote-control <workspace name>. */
  remoteControl: boolean;
}

export interface SpawnDeps {
  /** The handoff gate (home-base-mbnjv.2, C4): null = go on. */
  gate: typeof spawnGate;
  run: CmuxRunner;
}

/** Exit 0 opened (or a dry run) · 1 cmux did not open it · 2 refused · 3 refused by the handoff gate. */
export interface SpawnResult {
  exitCode: 0 | 1 | 2 | 3;
  lines: string[];
}

/** respawn.ts caps a workspace name at 80 characters; so does this. */
const NAME_LIMIT = 80;

function stop(exitCode: 1 | 2, text: string): SpawnResult {
  const verb = exitCode === 2 ? 'refused' : 'failed';
  return {exitCode, lines: [`thread spawn: ${verb}: ${text}`]};
}

/** `~` and `~/…` become the home directory; anything else is resolved from cwd. */
export function resolveSpawnDir(dir: string, cwd: string, env: EnvLike) {
  const home = env.HOME ?? homedir();
  if (dir === '~') return home;
  if (dir.startsWith('~/')) return join(home, dir.slice(2));
  return resolve(cwd, dir);
}

type DirCheck =
  | {kind: 'directory'}
  | {kind: 'missing'}
  | {kind: 'notDirectory'}
  | {kind: 'unreadable'; reason: string};

function checkDir(path: string): DirCheck {
  try {
    return statSync(path).isDirectory()
      ? {kind: 'directory'}
      : {kind: 'notDirectory'};
  } catch (error) {
    const code = (error as {code?: unknown}).code;
    return code === 'ENOENT' || code === 'ENOTDIR'
      ? {kind: 'missing'}
      : {kind: 'unreadable', reason: String(error)};
  }
}

/**
 * F9 (home-base-yukaf.14): has Claude Code's folder-trust dialog been
 * accepted for `dir`? Claude Code records it in ~/.claude.json (or
 * $CLAUDE_CONFIG_DIR/.claude.json) as projects[<absolute dir>]
 * .hasTrustDialogAccepted (the mechanism home-base-pa2s recorded). Read only:
 * this never edits the file. Only the exact directory is looked up; whether
 * Claude Code also honours a trusted PARENT folder is not verified, so a
 * worktree or a sub-folder may warn when no prompt will show (noise, the
 * safe direction).
 */
export type TrustCheck =
  | {kind: 'notTrusted'; path: string}
  | {kind: 'trusted'}
  | {kind: 'unknown'; reason: string};

export function claudeJsonPath(env: EnvLike): string {
  const configDir = env.CLAUDE_CONFIG_DIR;
  return configDir != null && configDir !== ''
    ? join(configDir, '.claude.json')
    : join(env.HOME ?? homedir(), '.claude.json');
}

export function checkFolderTrust(dir: string, env: EnvLike): TrustCheck {
  const path = claudeJsonPath(env);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    const code = (error as {code?: unknown}).code;
    // No file at all: Claude Code has trusted nothing on this machine yet.
    if (code === 'ENOENT') return {kind: 'notTrusted', path};
    return {
      kind: 'unknown',
      reason: `${path} could not be read: ${String(error)}`,
    };
  }
  if (parsed == null || typeof parsed !== 'object') {
    return {kind: 'unknown', reason: `${path} is not a JSON object`};
  }
  const projects = (parsed as {projects?: unknown}).projects;
  if (projects != null && typeof projects !== 'object') {
    return {
      kind: 'unknown',
      reason: `${path} has a projects field that is not an object`,
    };
  }
  const entry = (projects as Record<string, unknown> | undefined)?.[dir];
  const accepted =
    entry != null && typeof entry === 'object'
      ? (entry as {hasTrustDialogAccepted?: unknown}).hasTrustDialogAccepted
      : undefined;
  return accepted === true ? {kind: 'trusted'} : {kind: 'notTrusted', path};
}

/** The warning `thread spawn` prints for a folder that is not trusted, or null. */
export function trustWarning(check: TrustCheck): string | null {
  if (check.kind === 'trusted') return null;
  if (check.kind === 'unknown') {
    return `⚠️ Could not check whether Claude Code trusts this folder (${check.reason}). If it does not, the new session shows a trust prompt you must answer on the Mac.`;
  }
  return `⚠️ This folder has not been trusted yet (${check.path} has no hasTrustDialogAccepted for it): the new session will show a trust prompt you must answer on the Mac, unless Claude Code trusts it through a parent folder.`;
}

/**
 * F8 (home-base-yukaf.14): the window the new workspace goes to. cmux's own
 * default (`new-workspace --help`, cmux 2026-10-18) is the CALLER's window.
 * CMUX_WINDOW_ID, when set, is passed as --window so the target is explicit;
 * measured 2026-10-18 inside a cmux pane, cmux sets CMUX_WORKSPACE_ID,
 * CMUX_SURFACE_ID, CMUX_PANEL_ID and CMUX_TAB_ID but NOT CMUX_WINDOW_ID, so
 * the usual case is cmux's default, and the output says which.
 */
export function spawnWindow(env: EnvLike): {
  args: string[];
  text: string;
} {
  const window = env.CMUX_WINDOW_ID?.trim() ?? '';
  if (window !== '') return {args: ['--window', window], text: window};
  const workspace = env.CMUX_WORKSPACE_ID?.trim() ?? '';
  return {
    args: [],
    text:
      workspace === ''
        ? "cmux's default (CMUX_WINDOW_ID is not set, and this does not run in a cmux pane)"
        : `cmux's default: the window of the workspace this runs in (${workspace}); CMUX_WINDOW_ID is not set`,
  };
}

/** "[TAG] <name>" or "[TAG] new session <dir basename>", at most 80 characters. */
export function spawnWorkspaceName(
  dir: string,
  name: string | null,
  env: EnvLike,
): string {
  const repo = basename(primaryCheckoutOf(dir));
  const tag = resolveRepoTag({checkout: dir, env, repo});
  const title = name ?? `new session ${basename(dir)}`;
  const full = sessionDisplayName(tag, title);
  return full.length > NAME_LIMIT ? `${full.slice(0, NAME_LIMIT - 1)}…` : full;
}

/**
 * The text `new-workspace --command` types into the new pane's zsh.
 *
 * D8 (home-base-ys9t7.5.4 item 3): environment assignments come first, so
 * claude and its hooks carry them. SPAWNED_BY_SESSION_ENV names the session
 * that ran `thread spawn` (the child's capture links the two beads);
 * SPAWN_KICKOFF_ENV says the first prompt is the kickoff, typed by spawn and
 * not by Justin (the quota drops it). Neither is written when it does not
 * apply.
 */
export function spawnCommand(input: {
  kickoff: string | null;
  model: string | null;
  name: string;
  remoteControl: boolean;
  /** The session running `thread spawn`, or null outside one. */
  spawnedBySession?: string | null;
}): string {
  const assignments: string[] = [];
  if (input.spawnedBySession != null) {
    assignments.push(
      `${SPAWNED_BY_SESSION_ENV}=${zshWord(input.spawnedBySession)}`,
    );
  }
  if (input.kickoff != null) assignments.push(`${SPAWN_KICKOFF_ENV}=1`);
  const words = ['claude'];
  if (input.model != null) words.push('--model', input.model);
  if (input.remoteControl) words.push('--remote-control', input.name);
  // The prompt is claude's positional argument (`claude [options] [prompt]`),
  // so it goes last, after every flag.
  if (input.kickoff != null) words.push(input.kickoff);
  return [...assignments, ...words.map(zshWord)].join(' ');
}

/**
 * How to reach the session from the phone. Wording checked 2026-10-18 against
 * code.claude.com/docs/en/remote-control and /docs/en/mobile: "In the Claude
 * mobile app, tap Code in the navigation to reach the session list. Remote
 * Control sessions show a computer icon with a green status dot when online";
 * the phone is "a window into that local session, so your computer has to
 * stay on and the claude process has to keep running"; after a sleep "Claude
 * Code reconnects when the machine comes back online".
 */
export function connectLines(name: string): string[] {
  return [
    `Open the Claude app, tap Code, and pick "${name}" in the session list. A Remote Control session shows a computer icon with a green dot while it is online. claude.ai/code lists it too.`,
    'The session runs on this Mac; the phone is a window onto it. Keep the claude process in that workspace running: closing the workspace or quitting claude takes the session offline. If the Mac sleeps, it reconnects when the Mac wakes.',
  ];
}

export async function spawnSession(
  options: SpawnOptions,
  deps: Partial<SpawnDeps> = {},
): Promise<SpawnResult> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  // ---- 1. refusals: nothing reaches cmux before these pass ----
  const typed = options.dir == null ? '' : options.dir.trim();
  if (typed === '') return stop(2, 'name the directory to start in');
  const name = options.name == null ? null : oneLine(options.name);
  if (name === '') return stop(2, '--name needs at least one word');
  const model = options.model == null ? null : options.model.trim();
  if (model === '') return stop(2, '--model needs a model name');
  const kickoff = options.kickoff == null ? null : options.kickoff.trim();
  if (kickoff === '') return stop(2, '--kickoff needs the text of a prompt');
  const dir = resolveSpawnDir(typed, cwd, env);
  const checked = checkDir(dir);
  if (checked.kind === 'missing') return stop(2, `${dir} does not exist`);
  if (checked.kind === 'notDirectory') {
    return stop(2, `${dir} is not a directory`);
  }
  if (checked.kind === 'unreadable') {
    return stop(2, `${dir} cannot be read: ${checked.reason}`);
  }

  // ---- the plan: every argument, before cmux is touched ----
  const workspaceName = spawnWorkspaceName(dir, name, env);
  const {remoteControl} = options;
  // D8: the session running this, so the child links to it (item 3).
  const parent = sessionIdFrom(null, env);
  const spawnedBySession = parent.ok ? parent.id : null;
  const command = spawnCommand({
    kickoff,
    model,
    name: workspaceName,
    remoteControl,
    spawnedBySession,
  });
  const window = spawnWindow(env);
  const spawnArgs = ['new-workspace', '--name', workspaceName];
  spawnArgs.push('--cwd', dir, '--command', command, '--focus', 'false');
  spawnArgs.push(...window.args);
  const fields: Field[] = [
    {label: 'Workspace', value: workspaceName},
    {label: 'Directory', value: dir},
    {label: 'Command', value: command},
    {label: 'Window', value: window.text},
  ];
  if (kickoff != null) fields.push({label: 'Kickoff', value: kickoff});
  const warning = trustWarning(checkFolderTrust(dir, env));
  const style = outputStyle();
  const indent = stepColumn(0);
  const render = (title: string, emoji: string): string[] => {
    const lines = [
      sectionHeader(title, {color: style.color, emoji}),
      '',
      fieldLines(fields, {...style, indent}),
    ];
    if (warning != null) {
      lines.push(
        '',
        wrapHanging(warning, {hang: indent, indent, width: style.width}),
      );
    }
    if (!remoteControl) return lines;
    const connect = {color: style.color, emoji: '📱'};
    lines.push('', sectionHeader('Connect from your phone', connect), '');
    for (const text of connectLines(workspaceName)) {
      lines.push(wrapHanging(text, {hang: indent, indent, width: style.width}));
      lines.push('');
    }
    lines.pop();
    return lines;
  };
  const socket = liveSocketPath(env);

  if (options.dryRun) {
    const found = 'path' in socket;
    const dryEnv = found ? {CMUX_SOCKET_PATH: socket.path} : {};
    const binary = resolveCmuxBinary(env).path;
    const argv = [binary, ...cmuxArgv(dryEnv, spawnArgs)];
    fields.push({
      label: 'cmux socket',
      value: found
        ? socket.path
        : `not found (${socket.reason}), so a real run would refuse`,
    });
    fields.push({label: 'cmux argv', value: JSON.stringify(argv)});
    return {exitCode: 0, lines: render('Dry run: nothing opened', '🔎')};
  }

  // ---- 1b. the handoff gate, knob on only (home-base-mbnjv.2, C4) ----
  const refused = await (deps.gate ?? spawnGate)({cwd, env});
  if (refused != null) return refused;

  // ---- 2. cmux: the socket, then a ping (respawn.ts rules) ----
  if ('reason' in socket) {
    return stop(
      2,
      `cmux cannot be found: no CMUX_SOCKET_PATH, and ${socket.reason}`,
    );
  }
  const cmuxEnv = {...env, CMUX_QUIET: '1', CMUX_SOCKET_PATH: socket.path};
  const run = deps.run ?? realCmuxRunner(undefined, cmuxEnv);
  const ping = await run(['ping']);
  if (ping.kind === 'failed') {
    const allow = socketSettingsJson(socket.path).trim();
    const hint = `If this session is sandboxed, the sandbox blocks the cmux socket: add ${allow} to your Claude Code user settings, or retry with the sandbox disabled.`;
    return stop(2, `cmux cannot be reached: ${ping.reason}\n${hint}`);
  }

  // ---- 3. the workspace ----
  const made = await run(spawnArgs);
  const stdout = made.kind === 'ok' ? made.stdout.trim() : '';
  const ref = /^OK\s+(\S+)/u.exec(stdout)?.[1] ?? null;
  if (ref == null) {
    const cmux =
      made.kind === 'failed'
        ? made.reason
        : `cmux printed ${JSON.stringify(stdout)}`;
    return stop(1, `cmux did not confirm a new workspace: ${cmux}`);
  }
  fields.splice(1, 0, {label: 'Workspace id', value: ref});
  // home-base-ys9t7.9.1 B3: the name is the tool's, so the new session's
  // first naming sync replaces it instead of keeping it as Justin's.
  const recorded = await recordNewWorkspace({
    beadId: null,
    env,
    name: workspaceName,
    payload: ref,
    repo: basename(primaryCheckoutOf(dir)),
    run,
    sessionId: null,
    setBy: 'spawn',
  });
  fields.push({
    label: 'Name record',
    value: describeNewWorkspaceRecord(recorded),
  });
  return {exitCode: 0, lines: render('Opened a new session', '🌱')};
}

export async function runThreadSpawn(options: SpawnOptions) {
  const {exitCode, lines} = await spawnSession(options);
  const write = exitCode === 0 ? console.log : console.error;
  for (const line of lines) write(line);
  return exitCode;
}
