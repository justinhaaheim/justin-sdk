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
 * - The workspace is named sessionName(repoTag, title), the same "[TAG] title"
 *   the inbox and `thread open` use, cut to 80 characters, with the tag from the
 *   resolver the inbox uses (resolveRepoTag). With --continues the name also
 *   carries that session's marks plus one handoff (home-base-6n7my.2 D9).
 * - The same name always goes to `claude --name <name>`, and with
 *   --remote-control to `claude --remote-control <name>`, so the Claude app
 *   lists the session under the name this command prints. Measured 2026-10-18 against code.claude.com/docs/en/remote-control:
 *   a name passed to --remote-control is the first source of the session's
 *   title, and without one Claude Code makes one up from the hostname.
 * - The kickoff is never typed (home-base-8vywn). A typed line is cut at
 *   1,024 bytes, and a 1,088-byte spawn command arrived cut, never ran, and
 *   was still reported as opened. The kickoff goes to a file under XDG state,
 *   <XDG_STATE_HOME>/justin-sdk/spawn-kickoffs/<stamp>-<random>.md, which is
 *   kept as the record of what the session was asked; the typed command reads
 *   it back as claude's prompt with `"$(command cat -- <path>)"`. A command
 *   that would still reach TYPED_COMMAND_BYTE_LIMIT (a long --model, say) is
 *   refused with exit 2 before cmux is touched, --dry-run included.
 * - "Opened" means claude was seen running (home-base-edf4y). On 2026-11-02 a
 *   cut command left the tab at a zsh prompt while spawn said "Opened". After
 *   cmux confirms the workspace and its name is recorded, the new tab is
 *   looked up (readSoleSurfaceOfWorkspace: new-workspace names no tab, and a
 *   read-screen without --surface reads the CALLER's tab) and read with the
 *   handoff successor's screen check, waitForSuccessor, with its limits
 *   (about 20 s). Claude Code's input box is exit 0. A dialog (folder trust,
 *   say) is exit 1 at once, reported with the screen and never answered. No
 *   input box in time, or no tab to read, is exit 1 with the last screen or
 *   why it could not be read. Exit 1 then has two meanings, told apart by
 *   their first line: "cmux did not confirm a new workspace" (nothing is
 *   known to be open) and "a workspace WAS opened" (it names the workspace and
 *   says not to run spawn again, since that opens a second session).
 *   Unverified until a live run: whether read-screen reads a workspace opened
 *   with --focus false and never selected.
 * - --dry-run prints the plan, the kickoff file's path and the typed command's
 *   length, writes nothing and touches no cmux. A real run writes the kickoff
 *   file only after cmux answered its ping. A sandboxed first try fails on the
 *   ping and is retried with the sandbox off (the mayor's routine); written
 *   earlier, the file would fail first, because Justin's sandbox settings
 *   (2026-11-03) allow no writes to ~/.local/state/justin-sdk, and that
 *   refusal is not one the mayor retries.
 * - The route b alternative, a persistent `claude remote-control` server, is
 *   home-base-pa2s and is not built here.
 * - Access (home-base-11ya7.9): it refuses with exit 2, before anything else
 *   and with --dry-run too, unless componentConfig.thread.spawn.allowed is on
 *   in the repo it runs in. Only home-base turns it on, for the mayor.
 */

import type {Field} from '../cli-style';
import type {CmuxRunner} from './cmux';
import type {ChainReaders} from './handoff-chain';
import type {EnvLike} from './paths';
import type {SessionMarks} from './session-name';

import {randomBytes} from 'node:crypto';
import {mkdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';

import {findBeadsWorkspace} from '../beads/br';
import {
  fieldLines,
  outputStyle,
  sectionHeader,
  stepColumn,
  wrapHanging,
} from '../cli-style';
import {xdgStateHome} from '../health-notices';
import {oneLine} from './ask-format';
import {
  cmuxArgv,
  readSoleSurfaceOfWorkspace,
  realCmuxRunner,
  resolveCmuxBinary,
} from './cmux';
import {primaryCheckoutOf, resolveRepoTag, resolveThreadConfig} from './config';
import {handoffNumberOf, successorMarks} from './handoff-number';
import {
  quoteScreen,
  SUCCESSOR_POLL_MS,
  SUCCESSOR_TIMEOUT_MS,
  waitForSuccessor,
} from './handoff-successor';
import {
  liveSocketPath,
  socketSettingsJson,
  TYPED_COMMAND_BYTE_LIMIT,
  typedCommandBytes,
  typedCommandTooLong,
  zshWord,
} from './respawn';
import {
  CONTINUES_ENV,
  SPAWN_KICKOFF_ENV,
  SPAWNED_BY_SESSION_ENV,
} from './session-bead';
import {realHandoffNumberReaders} from './session-handoff';
import {NO_MARKS, sessionName} from './session-name';
import {sessionIdFrom} from './session-select';
import {spawnGate} from './spawn-gate';
import {describeNewWorkspaceRecord, recordNewWorkspace} from './workspace-name';

export interface SpawnOptions {
  /**
   * `--continues <bead>` (home-base-npbse.1.2): the session this one continues,
   * typed as JUSTIN_SDK_CONTINUES. The new session's own repo decides, through
   * its autoPickup knob, whether anything reads it.
   */
  continues?: string | null;
  /** Where a relative <dir> is resolved from (default: process.cwd()). */
  cwd?: string;
  /** The directory the new session starts in, as typed (`~` allowed). */
  dir: string | null;
  dryRun: boolean;
  env?: EnvLike;
  /**
   * The first prompt, handed to `claude` as its positional argument so the
   * session starts working with no keystroke (the respawn.ts pattern). It is
   * written to the kickoff file and read back by the typed command, never
   * typed itself (home-base-8vywn). null: the session opens on an empty
   * prompt.
   */
  kickoff: string | null;
  /** `claude --model`; null: claude's own default. */
  model: string | null;
  /** The title after the tag and any marks; null: "new session <dir basename>". */
  name: string | null;
  /** The kickoff file's timestamp (default: now). */
  now?: Date;
  /** Start claude with --remote-control <workspace name>. */
  remoteControl: boolean;
}

export interface SpawnDeps {
  /** The screen check's clock, in ms (home-base-edf4y D1, as the handoff's). */
  clock: () => number;
  /** The handoff gate (home-base-mbnjv.2, C4): null = go on. */
  gate: typeof spawnGate;
  /** What --continues reads for its marks; the real ones read through br. */
  numberReaders: ChainReaders;
  run: CmuxRunner;
  /**
   * The screen check's limits: the handoff's SUCCESSOR_POLL_MS and
   * SUCCESSOR_TIMEOUT_MS unless injected (tests shorten them).
   */
  screenPollMs: number;
  screenTimeoutMs: number;
  sleep: (ms: number) => Promise<void>;
}

/**
 * Exit 0 opened and claude seen running in it (or a dry run) · 1 cmux did not
 * confirm a workspace, or one opened and claude was not seen running in it ·
 * 2 refused · 3 refused by the handoff gate · 4 deferred: cmux too slow to
 * decide.
 */
export interface SpawnResult {
  exitCode: 0 | 1 | 2 | 3 | 4;
  lines: string[];
}

function stop(exitCode: 1 | 2, text: string): SpawnResult {
  const verb = exitCode === 2 ? 'refused' : 'failed';
  return {exitCode, lines: [`thread spawn: ${verb}: ${text}`]};
}

/**
 * What the second kind of exit 1 tells the caller (home-base-edf4y D3): a
 * workspace exists, so a second run opens a second session.
 */
export const SPAWN_NOT_CONFIRMED_INSTRUCTIONS = [
  'Do not run thread spawn again: that opens a second session.',
  'Look at the workspace named above: it is still open in cmux, so Justin can find it there and close it or answer what it shows.',
] as const;

/** The screen check's outcome: the handoff's, or no tab to read. */
type NewTabScreen =
  | Awaited<ReturnType<typeof waitForSuccessor>>
  | {kind: 'noTab'; reason: string};

/**
 * home-base-edf4y D1: read the new workspace's one tab with the handoff
 * successor's own screen check (waitForSuccessor, D7 of epic home-base-mbnjv),
 * with its limits. Read-only: it sends no key and types nothing. The tab is
 * looked up once; a failed lookup is reported as no tab, never retried into a
 * guess. The read uses the workspace uuid and the tab's ref, the form the
 * handoff reads its successor with (or the tab's uuid when the tree carries no
 * ref, the form the handoff gate reads its caller with).
 */
async function readNewTab(input: {
  clock: () => number;
  pollMs: number;
  run: CmuxRunner;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  workspace: string;
}): Promise<{screen: NewTabScreen; tab: string | null}> {
  const found = await readSoleSurfaceOfWorkspace(input.run, input.workspace);
  if (found.kind !== 'found') {
    return {screen: {kind: 'noTab', reason: found.reason}, tab: null};
  }
  const tab = found.surfaceRef ?? found.surfaceId;
  const screen = await waitForSuccessor({
    clock: input.clock,
    pollMs: input.pollMs,
    run: input.run,
    sleep: input.sleep,
    surfaceRef: tab,
    timeoutMs: input.timeoutMs,
    workspaceId: found.workspaceId,
  });
  return {screen, tab};
}

/**
 * home-base-edf4y D2 and D3: the exit 1 for a workspace that opened while
 * claude was not seen running in it. In order: the workspace WAS opened (its
 * id and name), claude was not seen running in it and why, the screen, then
 * SPAWN_NOT_CONFIRMED_INSTRUCTIONS. It never begins with "Opened", and its
 * first line tells it apart from "cmux did not confirm a new workspace".
 */
function notConfirmed(input: {
  name: string;
  ref: string;
  screen: Exclude<NewTabScreen, {kind: 'started'}>;
  workspaceId: string | null;
}): SpawnResult {
  const {screen} = input;
  const id =
    input.workspaceId == null
      ? input.ref
      : `${input.ref} (${input.workspaceId})`;
  const lines = [
    `thread spawn: failed: a workspace WAS opened: ${id} "${input.name}".`,
  ];
  let shown: string[] = [];
  if (screen.kind === 'dialog') {
    lines.push(
      `Claude was not seen running in it: the new tab is waiting on ${screen.label}. Nothing was answered and no key was sent: Justin answers it on the Mac.`,
    );
    shown = ['The screen:', '', ...quoteScreen(screen.text)];
  } else if (screen.kind === 'timedOut') {
    const seconds = Math.round(screen.waitedMs / 1000);
    lines.push(
      `Claude was not seen running in it within ${seconds} s: ${screen.why}.`,
    );
    if (screen.last.kind === 'read') {
      shown = ['The last screen:', '', ...quoteScreen(screen.last.text)];
    }
  } else {
    lines.push(
      `Claude was not seen running in it: its tab could not be found to read its screen: ${screen.reason}.`,
    );
  }
  if (shown.length > 0) lines.push('', ...shown);
  lines.push('', ...SPAWN_NOT_CONFIRMED_INSTRUCTIONS);
  return {exitCode: 1, lines};
}

/** What a spawn refused for want of the knob tells the calling Claude. */
export const SPAWN_NOT_ALLOWED_INSTRUCTIONS = [
  'Only the home-base mayor starts sessions in other projects. Here, file the work as a bead and tell Justin in your report.',
  'This refusal is final: do not retry from another directory, and do not start a session another way.',
] as const;

/**
 * home-base-11ya7.9: null when componentConfig.thread.spawn.allowed is on in
 * the repo `cwd` is in; otherwise the exit-2 refusal. It is read the way the
 * spawn gate reads its knob (resolveThreadConfig, so the nearest
 * justin-sdk.config.json above cwd), so one repo's config decides both. Any
 * config problem is printed with it: a file that fails validation contributes
 * nothing, and the knob must not read as off with nothing saying why.
 */
export function spawnNotAllowed(cwd: string, env: EnvLike): SpawnResult | null {
  const config = resolveThreadConfig({cwd, env});
  if (config.spawn.allowed) return null;
  const source = config.spawn.allowedSource;
  const state =
    source === 'default'
      ? 'is not set (default false)'
      : `is false in the ${source} config`;
  const lines = [
    `thread spawn: refused: componentConfig.thread.spawn.allowed ${state} for ${config.projectRoot}. Nothing was opened.`,
    '',
    ...SPAWN_NOT_ALLOWED_INSTRUCTIONS,
  ];
  if (config.problems.length > 0) {
    lines.push('', 'Config problems:');
    for (const problem of config.problems) lines.push(`- ${problem}`);
  }
  return {exitCode: 2, lines};
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

/**
 * "[TAG] <name>" or "[TAG] new session <dir basename>", at most 80 characters.
 * With `marks` (home-base-6n7my.2 D9, for --continues) the marks go around the
 * tag, the same as every other launch name.
 */
export function spawnWorkspaceName(
  dir: string,
  name: string | null,
  env: EnvLike,
  marks: SessionMarks = NO_MARKS,
): string {
  const repo = basename(primaryCheckoutOf(dir));
  const tag = resolveRepoTag({checkout: dir, env, repo});
  return sessionName(tag, name ?? `new session ${basename(dir)}`, marks);
}

/**
 * The marks of a session started with `--continues <bead>`: that bead's number
 * plus 1, and its mayor label (home-base-6n7my.2 D9). A bead that cannot be read
 * gives `H?`: this session is known to continue another, so it must not read as
 * a first session.
 */
export function spawnMarks(input: {
  continues: null | string;
  cwd: string;
  dir: string;
  env: EnvLike;
  readers?: ChainReaders;
}): SessionMarks {
  const {continues, env} = input;
  if (continues == null) return NO_MARKS;
  const fallbackDbs = [input.dir, input.cwd].flatMap((from) => {
    const space = findBeadsWorkspace(from);
    return space.kind === 'found' ? [space.db] : [];
  });
  const readers = input.readers ?? realHandoffNumberReaders({env, fallbackDbs});
  const read = readers.showBead(continues);
  if (read.kind !== 'found') return {handoff: 'unknown', mayor: false};
  const {labels} = read;
  return successorMarks(
    labels,
    handoffNumberOf({id: continues, labels}, readers),
  );
}

/**
 * home-base-8vywn: where a spawn's kickoff is written,
 * <XDG_STATE_HOME or ~/.local/state>/justin-sdk/spawn-kickoffs/<stamp>-<suffix>.md,
 * the stamp in UTC (20261103T210405Z). The file is kept: it records what the
 * new session was asked, and nothing deletes it.
 */
export function spawnKickoffPath(
  env: EnvLike,
  now: Date,
  suffix: string,
): string {
  const stamp = now
    .toISOString()
    .replace(/\.\d+Z$/u, 'Z')
    .replaceAll(/[-:]/gu, '');
  const name = `${stamp}-${suffix}.md`;
  return join(xdgStateHome(env), 'justin-sdk', 'spawn-kickoffs', name);
}

/**
 * The typed word that becomes claude's prompt: the kickoff file's bytes, read
 * by the new pane's shell (home-base-8vywn). Inside double quotes the result
 * is one word, with no splitting, globbing or further expansion. `command`
 * skips any alias or function named cat (a cat aliased to bat would be read
 * instead). Command substitution drops trailing newlines; the kickoff is
 * trimmed before it is written, so it has none to lose.
 */
export function kickoffFileWord(path: string): string {
  return `"$(command cat -- ${zshWord(path)})"`;
}

/**
 * Write the kickoff file: null when written, else why not. `wx`: an existing
 * file is never overwritten, since each one is a record.
 */
export function writeKickoffFile(path: string, kickoff: string): string | null {
  try {
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(path, kickoff, {encoding: 'utf8', flag: 'wx'});
    return null;
  } catch (error) {
    return String(error);
  }
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
 *
 * home-base-8vywn: the kickoff itself is never typed. With `kickoffFile` set,
 * claude's prompt is that file's text, read back by kickoffFileWord, so the
 * typed line stays short however long the kickoff is.
 */
export function spawnCommand(input: {
  /** `--continues <bead>`: typed as JUSTIN_SDK_CONTINUES (home-base-npbse.1.2). */
  continues?: string | null;
  /** The file holding the first prompt; null: no kickoff. */
  kickoffFile: string | null;
  model: string | null;
  name: string;
  remoteControl: boolean;
  /** The session running `thread spawn`, or null outside one. */
  spawnedBySession?: string | null;
}): string {
  const assignments: string[] = [];
  if (input.continues != null) {
    assignments.push(`${CONTINUES_ENV}=${zshWord(input.continues)}`);
  }
  if (input.spawnedBySession != null) {
    assignments.push(
      `${SPAWNED_BY_SESSION_ENV}=${zshWord(input.spawnedBySession)}`,
    );
  }
  if (input.kickoffFile != null) assignments.push(`${SPAWN_KICKOFF_ENV}=1`);
  const words = ['claude'];
  if (input.model != null) words.push('--model', input.model);
  if (input.remoteControl) words.push('--remote-control', input.name);
  // home-base-6n7my.2 D9: always, so the title carries the marks with or without
  // Remote Control, the same as a handoff's successor.
  words.push('--name', input.name);
  const typed = [...assignments, ...words.map(zshWord)];
  // The prompt is claude's positional argument (`claude [options] [prompt]`),
  // so it goes last, after every flag.
  if (input.kickoffFile != null) typed.push(kickoffFileWord(input.kickoffFile));
  return typed.join(' ');
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

  // ---- 0. access (home-base-11ya7.9): first, so a dry run refuses too ----
  const notAllowed = spawnNotAllowed(cwd, env);
  if (notAllowed != null) return notAllowed;

  // ---- 1. refusals: nothing reaches cmux before these pass ----
  const typed = options.dir == null ? '' : options.dir.trim();
  if (typed === '') return stop(2, 'name the directory to start in');
  const name = options.name == null ? null : oneLine(options.name);
  if (name === '') return stop(2, '--name needs at least one word');
  const model = options.model == null ? null : options.model.trim();
  if (model === '') return stop(2, '--model needs a model name');
  const kickoff = options.kickoff == null ? null : options.kickoff.trim();
  if (kickoff === '') return stop(2, '--kickoff needs the text of a prompt');
  // home-base-8vywn: no program argument can carry a NUL byte, so claude
  // would receive the kickoff cut short at the first one.
  if (kickoff?.includes('\0') === true) {
    return stop(2, '--kickoff holds a NUL byte, which claude cannot receive');
  }
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
  const workspaceName = spawnWorkspaceName(
    dir,
    name,
    env,
    spawnMarks({
      continues: options.continues ?? null,
      cwd,
      dir,
      env,
      ...(deps.numberReaders != null ? {readers: deps.numberReaders} : {}),
    }),
  );
  const {remoteControl} = options;
  // D8: the session running this, so the child links to it (item 3).
  const parent = sessionIdFrom(null, env);
  const spawnedBySession = parent.ok ? parent.id : null;
  // home-base-8vywn: the kickoff goes to a file, never into the typed line.
  const kickoffPlan =
    kickoff == null
      ? null
      : {
          path: spawnKickoffPath(
            env,
            options.now ?? new Date(),
            randomBytes(4).toString('hex'),
          ),
          text: kickoff,
        };
  const command = spawnCommand({
    continues: options.continues ?? null,
    kickoffFile: kickoffPlan?.path ?? null,
    model,
    name: workspaceName,
    remoteControl,
    spawnedBySession,
  });
  // A command this long would arrive cut and never run, while cmux still
  // answers OK: refused here, before cmux and before any write, dry run too.
  const tooLong = typedCommandTooLong(command);
  if (tooLong != null) {
    return stop(
      2,
      `${tooLong}. Shorten --model or --name, or XDG_STATE_HOME (the kickoff file's directory); the kickoff's own length does not count, because it is not typed. Nothing was written or opened.`,
    );
  }
  const window = spawnWindow(env);
  const spawnArgs = ['new-workspace', '--name', workspaceName];
  spawnArgs.push('--cwd', dir, '--command', command, '--focus', 'false');
  spawnArgs.push(...window.args);
  const fields: Field[] = [
    {label: 'Workspace', value: workspaceName},
    {label: 'Directory', value: dir},
    {label: 'Command', value: command},
    {
      label: 'Command size',
      value: `${typedCommandBytes(command)} bytes typed (${TYPED_COMMAND_BYTE_LIMIT} or more is refused)`,
    },
    {label: 'Window', value: window.text},
  ];
  if (kickoffPlan != null) {
    fields.push({
      label: 'Kickoff file',
      value: options.dryRun
        ? `${kickoffPlan.path} (not written: dry run)`
        : kickoffPlan.path,
    });
    fields.push({label: 'Kickoff', value: kickoffPlan.text});
  }
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

  // ---- 2b. the kickoff file (home-base-8vywn): only now, after the ping,
  // so a sandboxed first try still fails on the ping (see the header) ----
  if (kickoffPlan != null) {
    const failed = writeKickoffFile(kickoffPlan.path, kickoffPlan.text);
    if (failed != null) {
      return stop(
        2,
        `the kickoff file ${kickoffPlan.path} could not be written, so the session would start without its kickoff: ${failed}. Nothing was opened.`,
      );
    }
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

  // ---- 4. the screen check (home-base-edf4y D1, D2): "Opened" only once
  // claude's input box is seen. After the name record, so a failure can name
  // the workspace. The uuid when the record found it, else cmux's ref. ----
  const workspaceId =
    recorded.kind === 'recorded' ? recorded.workspaceId : null;
  const {screen, tab} = await readNewTab({
    clock: deps.clock ?? Date.now,
    pollMs: deps.screenPollMs ?? SUCCESSOR_POLL_MS,
    run,
    sleep:
      deps.sleep ??
      ((ms) =>
        new Promise((done) => {
          setTimeout(done, ms);
        })),
    timeoutMs: deps.screenTimeoutMs ?? SUCCESSOR_TIMEOUT_MS,
    workspace: workspaceId ?? ref,
  });
  if (screen.kind !== 'started') {
    return notConfirmed({name: workspaceName, ref, screen, workspaceId});
  }
  fields.push({
    label: 'Claude',
    value: `running: its input box was seen in the new tab (${tab ?? 'unknown tab'})`,
  });
  return {exitCode: 0, lines: render('Opened a new session', '🌱')};
}

export async function runThreadSpawn(options: SpawnOptions) {
  const {exitCode, lines} = await spawnSession(options);
  const write = exitCode === 0 ? console.log : console.error;
  for (const line of lines) write(line);
  return exitCode;
}
