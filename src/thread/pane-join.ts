/**
 * Which live cmux pane holds each Claude session (home-base-j8q3e.7 D5, D6).
 *
 * ONE IMPLEMENTATION. `attributeSessions` and its three input readers came
 * here from home-base's scripts/cmux-restore-state.ts, which now imports them
 * back through `@justinhaaheim/justin-sdk/pane-join` (the SDK cannot import
 * from scripts/, see the header of ./cmux.ts). cmux-capture, cmux-restart and
 * the inbox therefore join sessions to panes with the same code.
 *
 * THE JOIN: every session in cmux's hook store
 * (~/.cmuxterm/claude-hook-sessions.json, its `sessions` map) has the pid of
 * its claude process; `ps` gives that pid's tty; `cmux tree --all` gives the
 * surface on that tty. A pid that is gone has no tty, so the join is also the
 * liveness test: the hook store is accumulative and keeps sessions that ended.
 *
 * CRITICAL RULE 7. `lookupPanes` returns `{ok: false, reason}` when any of
 * the three sources cannot be read (no socket, the sandbox, ps refused, no
 * hook store). It never returns an empty map for that: an empty map means
 * "read, and no session is in a pane".
 *
 * Measured 2026-10-17: `cmux --json --id-format both tree --all` prints the
 * same refs and ttys as `cmux tree --all --json` (109 of 109 surfaces), plus
 * an `id` (uuid) on every surface. Workspaces carry `id` in both forms.
 *
 * THE SECOND SOURCE (home-base-j8q3e.17): a live Claude pane the hook-store
 * join cannot place (43 of 48 such panes on 2026-10-17 had no hook-store
 * entry at all) is placed by its own screen: Justin's status line shows
 * "⌗ <session uuid>", and cmux's session file must name the SAME session for
 * that surface (D1: two independent sources agree, or nothing is placed).
 * The result says which source placed each pane (D2). A screen or session
 * file that cannot be read makes the affected session unknown, never none
 * (D3, critical rule 7).
 */

import type {CmuxRunner} from './cmux';
import type {EnvLike} from './paths';

import {execFile} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

import {CMUX_TIMEOUT_MS, realCmuxRunner} from './cmux';

export type {CmuxCall, CmuxRunner} from './cmux';

// ---------------------------------------------------------------------------
// The three sources (only the fields the join reads)
// ---------------------------------------------------------------------------

export interface HookSession {
  agentLifecycle?: string | null;
  cwd?: string | null;
  isRestorable?: boolean | null;
  lastBody?: string | null;
  pid?: number | null;
  sessionId?: string | null;
  surfaceId?: string | null;
  transcriptPath?: string | null;
  workspaceId?: string | null;
}

export interface HookStore {
  /**
   * One entry per WORKSPACE, so a workspace running two Claude panes is
   * represented by whichever session cmux indexed last. Do not read this to
   * enumerate sessions — it silently collapses them. `sessions` is the full
   * record; this is only an index into it.
   */
  activeSessionsByWorkspace?: Record<string, {sessionId?: string | null}>;
  /** Keyed by sessionId. The authoritative list: one entry per session. */
  sessions?: Record<string, HookSession>;
}

export interface LiveSurface {
  /** The surface's uuid; present when the tree was read with `--id-format both`. */
  id?: string | null;
  paneRef: string;
  ref: string;
  title: string | null;
  tty: string | null;
  type: string;
  /** The uuid of the workspace that holds the surface now, when the tree has it. */
  workspaceId?: string | null;
  workspaceRef: string;
  workspaceTitle: string | null;
}

export interface Proc {
  command: string;
  etime: string;
  /** Executable path with arguments stripped — match on this, never `command`. */
  exePath: string;
  name: string;
  pid: number;
  ppid: number;
  tty: string;
}

/**
 * A Claude session joined to the surface it is running in.
 *
 * `alive` comes from whether the recorded pid is still a running claude
 * process (j8q3e.13 F7), NOT from the session's presence in the store: the
 * hook store is accumulative and keeps entries for sessions that ended and
 * workspaces that no longer exist, so "it is in the store" is not evidence
 * that anything is running.
 */
export interface AttributedSession {
  alive: boolean;
  cwd: string | null;
  pid: number | null;
  sessionId: string;
  /** null = the pid is dead, or alive but on no surface cmux knows about. */
  surfaceRef: string | null;
  transcriptPath: string | null;
  tty: string | null;
  workspaceId: string | null;
}

export function normalizeTty(tty: string | null | undefined): string | null {
  if (tty == null) return null;
  const trimmed = tty.trim().replace(/^\/dev\//, '');
  return trimmed === '' || trimmed === '??' ? null : trimmed;
}

const CLAUDE_SUFFIX = '/.local/bin/claude';

/**
 * A claude process, by its executable path (moved here from
 * scripts/cmux-restore-state.ts for j8q3e.17 D1, which re-exports it). Match
 * the path, never `command`: claude runs as `…/claude --settings {…}`.
 */
export function isClaudeProc(proc: Proc): boolean {
  return proc.exePath.endsWith(CLAUDE_SUFFIX);
}

/**
 * Join every session in the hook store to the surface it runs in, via
 * pid -> tty -> surface. Pure.
 *
 * This is the join that makes more than one Claude session per workspace
 * representable. cmux already records them all — `sessions` carries a
 * workspaceId AND a surfaceId per session — so the fix is to read that map
 * rather than the one-per-workspace index beside it.
 *
 * Measured 2026-09-18 on 29 stored sessions: 28 had a live pid and all 28
 * joined to a surface.
 *
 * home-base-j8q3e.13 F7: a stored pid is alive only while a CLAUDE process
 * holds it. pids are reused: an ended session whose pid now belongs to a zsh
 * or a bun on another pane would otherwise be placed there, and that pane's
 * real Claude session would never be read from its status line. Measured
 * 2026-10-17: all 36 live stored pids were /Users/jhaa/.local/bin/claude.
 */
export function attributeSessions(
  store: HookStore,
  procs: Proc[],
  surfaces: LiveSurface[],
): AttributedSession[] {
  const ttyByPid = new Map(
    procs
      .filter((proc) => isClaudeProc(proc))
      .map((p) => [p.pid, normalizeTty(p.tty)]),
  );
  const surfaceByTty = new Map<string, LiveSurface>();
  for (const surface of surfaces) {
    const tty = normalizeTty(surface.tty);
    if (tty != null) surfaceByTty.set(tty, surface);
  }

  const out: AttributedSession[] = [];
  for (const [key, session] of Object.entries(store.sessions ?? {})) {
    const sessionId = session.sessionId ?? key;
    const pid = session.pid ?? null;
    const tty = pid == null ? null : (ttyByPid.get(pid) ?? null);
    const surface = tty == null ? null : (surfaceByTty.get(tty) ?? null);
    out.push({
      alive: tty != null,
      cwd: session.cwd ?? null,
      pid,
      sessionId,
      surfaceRef: surface?.ref ?? null,
      transcriptPath: session.transcriptPath ?? null,
      tty,
      workspaceId: session.workspaceId ?? null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parsing (pure)
// ---------------------------------------------------------------------------

/** The part of `cmux tree --all --json` the join reads. */
export interface RawTree {
  windows?: {
    ref: string;
    workspaces?: {
      id?: string | null;
      panes?: {
        ref: string;
        surfaces?: {
          id?: string | null;
          ref: string;
          title?: string | null;
          tty?: string | null;
          type?: string | null;
        }[];
      }[];
      ref: string;
      title?: string | null;
    }[];
  }[];
}

/** Every surface of the tree, with its tty and (when present) its uuids. */
export function flattenTree(tree: RawTree): LiveSurface[] {
  const out: LiveSurface[] = [];
  for (const window of tree.windows ?? []) {
    for (const workspace of window.workspaces ?? []) {
      for (const pane of workspace.panes ?? []) {
        for (const surface of pane.surfaces ?? []) {
          out.push({
            id: surface.id ?? null,
            paneRef: pane.ref,
            ref: surface.ref,
            title: surface.title ?? null,
            tty: surface.tty?.trim() === '' ? null : (surface.tty ?? null),
            type: surface.type ?? 'terminal',
            workspaceId: workspace.id ?? null,
            workspaceRef: workspace.ref,
            workspaceTitle: workspace.title ?? null,
          });
        }
      }
    }
  }
  return out;
}

/** `ps -Ao pid,ppid,tty,etime,command` output, one Proc per process line. */
export function parseProcessList(stdout: string): Proc[] {
  const procs: Proc[] = [];
  for (const line of stdout.split('\n').slice(1)) {
    const m = /^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line.trim());
    if (m == null) continue;
    const [, pid, ppid, tty, etime, command] = m;
    if (
      pid == null ||
      ppid == null ||
      tty == null ||
      etime == null ||
      command == null
    ) {
      continue;
    }
    const exePath = command.split(' ')[0] ?? command;
    procs.push({
      command,
      etime,
      exePath,
      name: exePath.split('/').pop() ?? command,
      pid: Number(pid),
      ppid: Number(ppid),
      tty,
    });
  }
  return procs;
}

// ---------------------------------------------------------------------------
// Readers: each returns the value or why it could not be read
// ---------------------------------------------------------------------------

export type SourceRead<T> = {ok: false; reason: string} | {ok: true; value: T};

function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split('\n')[0]?.trim() ?? text;
}

/** An error's message and code (`EPERM`), for a failure reason. */
function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as {code?: unknown}).code;
  const message = error.message === '' ? 'no message' : error.message;
  return typeof code === 'string' && !message.includes(code)
    ? `${code}: ${message}`
    : message;
}

/** cmux's hook store, under the user's home directory. */
export function defaultHookStorePath(home: string = homedir()): string {
  return join(home, '.cmuxterm', 'claude-hook-sessions.json');
}

/**
 * The hook store. A missing file is a failure, not an empty store: with no
 * store no session can be joined, and "no pane found" would then be a claim
 * nothing checked (critical rule 7).
 */
export function readHookStore(path: string): SourceRead<HookStore> {
  if (!existsSync(path)) {
    return {ok: false, reason: `no cmux hook store at ${path}`};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    return {
      ok: false,
      reason: `could not read the cmux hook store ${path}: ${firstLine(error)}`,
    };
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      reason: `the cmux hook store ${path} is not a JSON object`,
    };
  }
  return {ok: true, value: parsed as HookStore};
}

/** Runs `ps -Ao pid,ppid,tty,etime,command`. Injected so tests fake it. */
export type ProcessRunner = () => Promise<
  {kind: 'failed'; reason: string} | {kind: 'ok'; stdout: string}
>;

export const PS_ARGS = ['-Ao', 'pid,ppid,tty,etime,command'] as const;

/** The real `ps`; a timeout so a hung ps cannot hang the inbox. */
export function realProcessRunner(
  timeoutMs: number = CMUX_TIMEOUT_MS,
): ProcessRunner {
  return () =>
    new Promise((resolve) => {
      try {
        // `ps -Ao ... -t <tty>` does NOT filter (-A overrides -t); dump once.
        execFile(
          'ps',
          [...PS_ARGS],
          {maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs},
          (error, stdout, stderr) => {
            if (error != null) {
              const detail = String(stderr).trim();
              resolve({
                kind: 'failed',
                reason: `ps ${PS_ARGS.join(' ')} failed: ${detail !== '' ? detail : error.message}`,
              });
              return;
            }
            resolve({kind: 'ok', stdout: String(stdout)});
          },
        );
      } catch (error) {
        // Measured 2026-10-17: inside the Claude Code sandbox the spawn
        // itself throws (EPERM) instead of calling back.
        resolve({
          kind: 'failed',
          reason: `ps ${PS_ARGS.join(' ')} could not start: ${errorText(error)}`,
        });
      }
    });
}

export async function readProcesses(
  run: ProcessRunner,
): Promise<SourceRead<Proc[]>> {
  let call: Awaited<ReturnType<ProcessRunner>>;
  try {
    call = await run();
  } catch (error) {
    return {ok: false, reason: `ps could not run: ${errorText(error)}`};
  }
  if (call.kind === 'failed') return {ok: false, reason: call.reason};
  return {ok: true, value: parseProcessList(call.stdout)};
}

/** The tree with surface uuids (`--id-format both`, measured above). */
export const LIVE_TREE_ARGS = [
  '--json',
  '--id-format',
  'both',
  'tree',
  '--all',
] as const;

/** Every live surface with its tty, through the injectable cmux runner. */
export async function readLiveSurfaces(
  run: CmuxRunner,
): Promise<SourceRead<LiveSurface[]>> {
  let call: Awaited<ReturnType<CmuxRunner>>;
  try {
    call = await run(LIVE_TREE_ARGS);
  } catch (error) {
    return {
      ok: false,
      reason: `cmux ${LIVE_TREE_ARGS.join(' ')} could not run: ${errorText(error)}`,
    };
  }
  if (call.kind === 'failed') return {ok: false, reason: call.reason};
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.stdout) as unknown;
  } catch (error) {
    return {
      ok: false,
      reason: `cmux ${LIVE_TREE_ARGS.join(' ')} printed text that is not JSON: ${firstLine(error)}`,
    };
  }
  if (
    parsed == null ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as {windows?: unknown}).windows)
  ) {
    return {
      ok: false,
      reason: `cmux ${LIVE_TREE_ARGS.join(' ')} printed JSON with no windows list`,
    };
  }
  return {ok: true, value: flattenTree(parsed as RawTree)};
}

// ---------------------------------------------------------------------------
// cmux's session file (moved here from scripts/cmux-restore-state.ts for
// j8q3e.17 D1; that module re-exports these)
// ---------------------------------------------------------------------------

export interface SessionResumeBinding {
  checkpointId?: string | null;
  command?: unknown;
  cwd?: string | null;
  kind?: string | null;
}

export interface SessionPanel {
  directory?: string | null;
  /** The surface's uuid: the live tree's surface `id` (97 of 97, 2026-10-17). */
  id: string;
  terminal?: {
    agent?: {
      kind?: string | null;
      sessionId?: string | null;
      workingDirectory?: string | null;
    } | null;
    resumeBinding?: SessionResumeBinding | null;
    wasAgentRunning?: boolean | null;
    workingDirectory?: string | null;
  } | null;
  title?: string | null;
  ttyName?: string | null;
  type?: string | null;
}

export interface SessionWorkspace {
  currentDirectory?: string | null;
  customTitle?: string | null;
  panels?: SessionPanel[];
  processTitle?: string | null;
  stableId?: string | null;
  workspaceId?: string | null;
}

export interface SessionFile {
  windows?: {
    tabManager?: {workspaces?: SessionWorkspace[]};
  }[];
}

/** cmux's session file, under the user's home directory. */
export function defaultSessionFilePath(home: string = homedir()): string {
  return join(
    home,
    'Library',
    'Application Support',
    'cmux',
    'session-com.cmuxterm.app.json',
  );
}

/** Every panel of the session file, with the workspace that holds it. */
export function sessionPanels(
  session: SessionFile,
): {panel: SessionPanel; workspace: SessionWorkspace}[] {
  const out: {panel: SessionPanel; workspace: SessionWorkspace}[] = [];
  for (const window of session.windows ?? []) {
    for (const workspace of window.tabManager?.workspaces ?? []) {
      for (const panel of workspace.panels ?? []) {
        out.push({panel, workspace});
      }
    }
  }
  return out;
}

/**
 * The session file. A missing file is a failure, as for the hook store:
 * without it no status-line id can be confirmed (critical rule 7).
 */
export function readSessionFile(path: string): SourceRead<SessionFile> {
  if (!existsSync(path)) {
    return {ok: false, reason: `no cmux session file at ${path}`};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    return {
      ok: false,
      reason: `could not read the cmux session file ${path}: ${firstLine(error)}`,
    };
  }
  if (
    parsed == null ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as {windows?: unknown}).windows)
  ) {
    return {
      ok: false,
      reason: `the cmux session file ${path} has no windows list`,
    };
  }
  return {ok: true, value: parsed as SessionFile};
}

// ---------------------------------------------------------------------------
// Reading a Claude screen (moved here from scripts/pane-backfill-classify.ts
// for j8q3e.17 D1, which re-exports these)
// ---------------------------------------------------------------------------

export interface InputBox {
  /** Line index of the bottom rule. */
  bottom: number;
  /** What is typed on the input line, no-break spaces stripped; '' = empty. */
  draft: string;
  /** Line index of the ❯ line. */
  prompt: number;
  /** Line index of the top rule. */
  top: number;
}

/**
 * U+00A0, which Claude Code prints after ❯ on an empty input line. Built from
 * its code point: the editing tools rewrite a backslash-u escape into the
 * invisible character itself, which lint then refuses.
 */
export const NO_BREAK_SPACE = String.fromCharCode(0x00a0);

const TOP_RULE = /^─{10,}/u;
const BOTTOM_RULE = /^─{10,}$/u;

export function screenLines(text: string): string[] {
  return text.split('\n').map((line) => line.replace(/\s+$/u, ''));
}

/**
 * Claude Code's input box: the LAST ❯ line whose line above is a rule, up to
 * the next pure rule. null when the screen has none: a zsh prompt (its ❯ has
 * no rule above it), a dialog or menu that replaced the box, or a screen cut
 * off before the bottom rule. The top rule can carry a label (a named
 * session: "──── 2026-10-08 09:00 daily-loop-1 ─"), so only the bottom rule
 * must be pure ─.
 */
export function findInputBox(lines: readonly string[]): InputBox | null {
  for (let prompt = lines.length - 1; prompt > 0; prompt -= 1) {
    const line = lines[prompt] ?? '';
    if (!line.startsWith('❯')) continue;
    if (!TOP_RULE.test(lines[prompt - 1] ?? '')) continue;
    for (let bottom = prompt + 1; bottom < lines.length; bottom += 1) {
      if (!BOTTOM_RULE.test(lines[bottom] ?? '')) continue;
      const typed = [line.slice(1), ...lines.slice(prompt + 1, bottom)]
        .join('\n')
        .replaceAll(NO_BREAK_SPACE, ' ')
        .trim();
      return {bottom, draft: typed, prompt, top: prompt - 1};
    }
    return null;
  }
  return null;
}

const SCREEN_SESSION_ID =
  /⌗\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/u;

/**
 * The session id Justin's status line shows below the input box
 * ("⌗ b7a11012-82a6-…"), or null when it shows none. Only below the box, so
 * an id quoted in the conversation above it does not count.
 */
export function screenSessionId(
  lines: readonly string[],
  box: InputBox,
): string | null {
  for (const line of lines.slice(box.bottom + 1)) {
    const id = SCREEN_SESSION_ID.exec(line)?.[1];
    if (id != null) return id;
  }
  return null;
}

/** The status line's session id on one screen's text, below an input box. */
export function statusLineIdOf(text: string): string | null {
  const lines = screenLines(text);
  const box = findInputBox(lines);
  return box == null ? null : screenSessionId(lines, box);
}

/** One screen read: its text, or why cmux could not read it. */
export type ScreenRead =
  | {kind: 'read'; text: string}
  | {kind: 'unreadable'; reason: string};

/** `cmux read-screen --surface <ref>`, through the injectable runner. */
export async function readScreen(
  run: CmuxRunner,
  ref: string,
): Promise<ScreenRead> {
  let call: Awaited<ReturnType<CmuxRunner>>;
  try {
    call = await run(['read-screen', '--surface', ref]);
  } catch (error) {
    return {
      kind: 'unreadable',
      reason: `cmux read-screen could not run: ${errorText(error)}`,
    };
  }
  if (call.kind === 'failed') return {kind: 'unreadable', reason: call.reason};
  return {kind: 'read', text: call.stdout};
}

// ---------------------------------------------------------------------------
// The second source: the status line, confirmed by the session file (j8q3e.17)
// ---------------------------------------------------------------------------

/** D2: which source placed a pane. */
export type PaneSource = 'hook-store' | 'status-line';

/**
 * Every live surface with a claude process on its tty that the hook-store
 * join put no session in (a surface two stored sessions joined to counts as
 * placed: the hook store did join it). Pure.
 */
export function unplacedClaudeSurfaces(
  procs: readonly Proc[],
  surfaces: readonly LiveSurface[],
  attributed: readonly AttributedSession[],
): LiveSurface[] {
  const claudeTtys = new Set(
    procs
      .filter((proc) => isClaudeProc(proc))
      .map((proc) => normalizeTty(proc.tty))
      .filter((tty): tty is string => tty != null),
  );
  const placed = new Set(
    attributed
      .filter((session) => session.alive && session.surfaceRef != null)
      .map((session) => session.surfaceRef),
  );
  return surfaces.filter((surface) => {
    const tty = normalizeTty(surface.tty);
    return tty != null && claudeTtys.has(tty) && !placed.has(surface.ref);
  });
}

/** A pane the status line placed: its screen and the session file agree. */
export interface StatusLinePlacement {
  /** From the session file entry (D1): claude's working directory first. */
  cwd: string | null;
  /** The screen text the id was read from. */
  screen: string;
  sessionId: string;
  surface: LiveSurface;
}

/**
 * Why a live Claude pane was not placed by the status line:
 * - unreadableScreen: cmux could not read its screen (D3: unknown).
 * - unreadableSessionFile: the session file could not be read (D3: unknown).
 * - unconfirmedId: the screen shows an id the session file does not name for
 *   that surface (D3: none found by either source).
 * - noScreenId: the screen shows no "⌗ <uuid>" below an input box.
 * - conflict: its confirmed id is placed elsewhere, or shown on two panes.
 */
export type UnplacedKind =
  | 'conflict'
  | 'noScreenId'
  | 'unconfirmedId'
  | 'unreadableScreen'
  | 'unreadableSessionFile';

export interface UnplacedPane {
  detail: string;
  /** The session the session file names for this surface, when it names one. */
  fileSessionId: string | null;
  kind: UnplacedKind;
  /** The session the status line shows, when it was read and shows one. */
  screenSessionId: string | null;
  surface: LiveSurface;
}

/** What the status-line source found, beside the hook-store join. */
export interface StatusLineResult {
  /** Why the source could not run at all (the session file), or null. */
  failure: string | null;
  placed: StatusLinePlacement[];
  /**
   * Sessions the source could neither place nor rule out, with why (D3): the
   * session file names one for a pane whose screen could not be read, or two
   * panes confirm the same session. Their cards say unknown, never none.
   */
  unknownSessions: Map<string, string>;
  unplaced: UnplacedPane[];
}

function refLabel(surface: LiveSurface): string {
  return surface.ref;
}

/** The session file's entry for each surface uuid. */
function panelsBySurfaceId(
  file: SessionFile,
): Map<string, {panel: SessionPanel; workspace: SessionWorkspace}> {
  const out = new Map<
    string,
    {panel: SessionPanel; workspace: SessionWorkspace}
  >();
  for (const entry of sessionPanels(file)) out.set(entry.panel.id, entry);
  return out;
}

function panelCwd(entry: {
  panel: SessionPanel;
  workspace: SessionWorkspace;
}): string | null {
  const {panel, workspace} = entry;
  return (
    panel.terminal?.agent?.workingDirectory ??
    panel.directory ??
    panel.terminal?.workingDirectory ??
    workspace.currentDirectory ??
    null
  );
}

/**
 * D1, pure: place each pane by its screen's "⌗ <uuid>" when the session file
 * names the same session for that surface. The file is joined to a surface by
 * its uuid (`panel.id` == the tree's surface `id`), NOT by tty: measured
 * 2026-10-17, ttys are reused and the tty join named the wrong panel for 4 of
 * 123 surfaces (surface:187 among them), while the uuid join matched 97 of 97.
 *
 * `placedByHookStore` maps each session the hook-store join placed to its
 * surface ref: a status-line id already placed there is a conflict, and the
 * hook store's pid-proved pane stands.
 */
export function placeByStatusLine(input: {
  candidates: readonly LiveSurface[];
  placedByHookStore: ReadonlyMap<string, string>;
  screens: ReadonlyMap<string, ScreenRead>;
  sessionFile: SourceRead<SessionFile> | null;
}): StatusLineResult {
  const result: StatusLineResult = {
    failure: null,
    placed: [],
    unknownSessions: new Map(),
    unplaced: [],
  };
  if (input.candidates.length === 0) return result;

  const shownOf = (surface: LiveSurface): string | null => {
    const screen = input.screens.get(surface.ref);
    if (screen?.kind !== 'read') return null;
    const lines = screenLines(screen.text);
    const box = findInputBox(lines);
    return box == null ? null : screenSessionId(lines, box);
  };

  const file: SourceRead<SessionFile> = input.sessionFile ?? {
    ok: false,
    reason: 'the cmux session file was not read',
  };
  if (!file.ok) {
    const {reason} = file;
    result.failure = reason;
    for (const surface of input.candidates) {
      result.unplaced.push({
        detail: `the status line cannot be confirmed: ${reason}`,
        fileSessionId: null,
        kind: 'unreadableSessionFile',
        screenSessionId: shownOf(surface),
        surface,
      });
    }
    return result;
  }

  const panels = panelsBySurfaceId(file.value);
  const tentative: StatusLinePlacement[] = [];
  const unknown = new Map<string, string>();
  for (const surface of input.candidates) {
    const entry = surface.id == null ? undefined : panels.get(surface.id);
    const fileId = entry?.panel.terminal?.agent?.sessionId ?? null;
    const read = input.screens.get(surface.ref) ?? {
      kind: 'unreadable' as const,
      reason: 'its screen was not read',
    };
    // An empty screen (a hibernated pane) is not a reading either.
    const screen: ScreenRead =
      read.kind === 'read' && read.text.trim() === ''
        ? {kind: 'unreadable', reason: 'cmux returned an empty screen'}
        : read;
    if (screen.kind === 'unreadable') {
      result.unplaced.push({
        detail: `cmux could not read the screen: ${screen.reason}`,
        fileSessionId: fileId,
        kind: 'unreadableScreen',
        screenSessionId: null,
        surface,
      });
      // The source could only ever place the file's session here (D1), so
      // that session, and only that one, is left unchecked.
      if (fileId != null) {
        unknown.set(
          fileId,
          `the screen of ${refLabel(surface)}, where cmux's session file puts it, could not be read`,
        );
      }
      continue;
    }
    const lines = screenLines(screen.text);
    const box = findInputBox(lines);
    const shown = box == null ? null : screenSessionId(lines, box);
    if (shown == null) {
      result.unplaced.push({
        detail:
          box == null
            ? 'no Claude input box on screen, so no status line to read'
            : 'the status line shows no "⌗ <session id>"',
        fileSessionId: fileId,
        kind: 'noScreenId',
        screenSessionId: null,
        surface,
      });
      continue;
    }
    if (fileId !== shown) {
      result.unplaced.push({
        detail:
          fileId == null
            ? `the status line shows ${shown}, and cmux's session file names no session for this surface`
            : `the status line shows ${shown}, but cmux's session file names ${fileId}`,
        fileSessionId: fileId,
        kind: 'unconfirmedId',
        screenSessionId: shown,
        surface,
      });
      continue;
    }
    tentative.push({
      cwd: entry == null ? null : panelCwd(entry),
      screen: screen.text,
      sessionId: shown,
      surface,
    });
  }

  const bySession = new Map<string, StatusLinePlacement[]>();
  for (const placement of tentative) {
    const list = bySession.get(placement.sessionId) ?? [];
    list.push(placement);
    bySession.set(placement.sessionId, list);
  }
  for (const [sessionId, placements] of bySession) {
    const hookRef = input.placedByHookStore.get(sessionId);
    const [only] = placements;
    if (hookRef == null && placements.length === 1 && only != null) {
      result.placed.push(only);
      continue;
    }
    const refs = placements.map((placement) => refLabel(placement.surface));
    for (const placement of placements) {
      result.unplaced.push({
        detail:
          hookRef != null
            ? `its status line and cmux's session file show ${sessionId}, which the pid/tty join already puts in ${hookRef}`
            : `${placements.length} panes show ${sessionId} on their status line (${refs.join(', ')}); which one holds it cannot be told`,
        fileSessionId: sessionId,
        kind: 'conflict',
        screenSessionId: sessionId,
        surface: placement.surface,
      });
    }
    if (hookRef == null) {
      unknown.set(
        sessionId,
        `${placements.length} panes show it on their status line (${refs.join(', ')})`,
      );
    }
  }

  // A session some source placed is not unknown: its pane is known.
  const placedIds = new Set([
    ...input.placedByHookStore.keys(),
    ...result.placed.map((placement) => placement.sessionId),
  ]);
  for (const [sessionId, why] of unknown) {
    if (!placedIds.has(sessionId)) result.unknownSessions.set(sessionId, why);
  }
  const byRef = (a: {surface: LiveSurface}, b: {surface: LiveSurface}) =>
    Number(a.surface.ref.split(':')[1]) - Number(b.surface.ref.split(':')[1]);
  result.placed.sort(byRef);
  result.unplaced.sort(byRef);
  return result;
}

/** How many screens the status-line source reads at once. */
export const SCREEN_CONCURRENCY = 6;

/** `fn` over `items`, at most `limit` at a time, results in the items' order. */
async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next; index < items.length; index = next) {
      next += 1;
      const item = items[index] as T;
      results[index] = await fn(item);
    }
  };
  await Promise.all(
    Array.from({length: Math.min(limit, items.length)}, worker),
  );
  return results;
}

/**
 * D1: the status-line source over live sources already read. It reads the
 * screen of every live Claude pane the hook-store join did not place, and
 * the session file only when there is such a pane.
 */
export async function readStatusLineSource(input: {
  attributed: readonly AttributedSession[];
  cmux: CmuxRunner;
  procs: readonly Proc[];
  sessionFilePath: string;
  surfaces: readonly LiveSurface[];
}): Promise<StatusLineResult> {
  const candidates = unplacedClaudeSurfaces(
    input.procs,
    input.surfaces,
    input.attributed,
  );
  const placedByHookStore = new Map<string, string>();
  for (const session of input.attributed) {
    if (session.alive && session.surfaceRef != null) {
      placedByHookStore.set(session.sessionId, session.surfaceRef);
    }
  }
  if (candidates.length === 0) {
    return placeByStatusLine({
      candidates,
      placedByHookStore,
      screens: new Map(),
      sessionFile: null,
    });
  }
  const sessionFile = readSessionFile(input.sessionFilePath);
  const reads = await mapLimited(
    candidates,
    SCREEN_CONCURRENCY,
    async (surface) => await readScreen(input.cmux, surface.ref),
  );
  const screens = new Map<string, ScreenRead>();
  for (const [index, surface] of candidates.entries()) {
    const read = reads[index];
    if (read != null) screens.set(surface.ref, read);
  }
  return placeByStatusLine({
    candidates,
    placedByHookStore,
    screens,
    sessionFile,
  });
}

// ---------------------------------------------------------------------------
// The inbox's lookup (D6)
// ---------------------------------------------------------------------------

/** The live pane that holds a session: its surface and that surface's workspace. */
export interface LivePane {
  /** j8q3e.17 D2: which source placed it. */
  source: PaneSource;
  surfaceId: string;
  workspaceId: string;
}

/**
 * D6: every session the join puts in a live pane, keyed by session id; or why
 * the panes could not be looked up. Never an empty map for a failure.
 * `statusLine` (j8q3e.17) says what the second source could not place, so a
 * card reads "unknown" rather than "none" where it could not check.
 */
export type PaneLookup =
  | {
      bySession: Map<string, LivePane>;
      ok: true;
      statusLine: Pick<
        StatusLineResult,
        'failure' | 'unknownSessions' | 'unplaced'
      >;
    }
  | {ok: false; reason: string};

/** What `lookupPanes` reads; every source is injectable for tests. */
export interface PaneSources {
  cmux: CmuxRunner;
  hookStorePath: string;
  ps: ProcessRunner;
  /** cmux's session file (j8q3e.17 D1). */
  sessionFilePath: string;
}

/** The real sources: cmux through ./cmux's runner (its timeout), ps, the hook store, the session file. */
export function realPaneSources(env: EnvLike): PaneSources {
  const home = env.HOME;
  const homeDir = home != null && home !== '' ? home : homedir();
  return {
    cmux: realCmuxRunner(CMUX_TIMEOUT_MS, env),
    hookStorePath: defaultHookStorePath(homeDir),
    ps: realProcessRunner(),
    sessionFilePath: defaultSessionFilePath(homeDir),
  };
}

/**
 * j8q3e.13 F8: how an unknown reason for a pane two stored sessions share
 * begins. Such a reason is the whole of the card's "unknown (…)": the
 * pid/tty join did find the pane, so the card must not say it found none.
 */
export const SHARED_PANE_REASON = 'two sessions on one pane';

/** How long a reason may run on a card's Pane line before it is cut. */
const REASON_CUT = 160;

/**
 * One source's failure, as the card's "Pane: unknown (<reason>)" says it:
 * the first line, cut, and the sandbox named when the error is EPERM (the
 * Claude Code sandbox refuses both ps and the cmux socket that way).
 */
export function paneFailureReason(source: string, reason: string): string {
  const first = reason.split('\n')[0]?.trim() ?? reason;
  const cut =
    first.length > REASON_CUT ? `${first.slice(0, REASON_CUT - 1)}…` : first;
  // Printed on every card, so the sandbox case is the cause alone.
  const sandboxed = /operation not permitted|EPERM/i.test(reason);
  return sandboxed
    ? `${source} refused: Operation not permitted, as inside the Claude Code sandbox`
    : `${source}: ${cut}`;
}

/**
 * D6, once per inbox run: the three sources read concurrently, then joined.
 * A session counts as in a pane when its pid is alive AND its tty is a
 * surface's AND the tree gave that surface and its workspace a uuid; or
 * (j8q3e.17) when that pane's status line and cmux's session file agree on
 * it. A pane the pid/tty join puts two or more sessions in (j8q3e.13 F8)
 * keeps only the one its status line shows; when it shows none of them, all
 * of them are unknown ("two sessions on one pane"), never all live. Any of
 * the three base sources that cannot be read makes the whole
 * lookup `{ok: false}`, with every failed source named; a screen or the
 * session file that cannot be read is carried in `statusLine`.
 */
export async function lookupPanes(sources: PaneSources): Promise<PaneLookup> {
  const store = readHookStore(sources.hookStorePath);
  const [procs, surfaces] = await Promise.all([
    readProcesses(sources.ps),
    readLiveSurfaces(sources.cmux),
  ]);
  const failures: string[] = [];
  if (!store.ok) failures.push(paneFailureReason('hook store', store.reason));
  if (!procs.ok) failures.push(paneFailureReason('ps', procs.reason));
  if (!surfaces.ok) {
    failures.push(paneFailureReason('cmux tree', surfaces.reason));
  }
  if (!store.ok || !procs.ok || !surfaces.ok) {
    return {ok: false, reason: failures.join('; ')};
  }
  const byRef = new Map(
    surfaces.value.map((surface) => [surface.ref, surface]),
  );
  const bySession = new Map<string, LivePane>();
  const noUuid: string[] = [];
  const attributed = attributeSessions(
    store.value,
    procs.value,
    surfaces.value,
  );
  // j8q3e.13 F8: the sessions the hook store joins to each surface. After a
  // /clear one claude process holds two stored sessions, so both would land on
  // its pane: two cards would show it and the open-panes count would count it
  // twice. Such a pane keeps only the session its status line shows.
  const sessionsByRef = new Map<string, AttributedSession[]>();
  for (const session of attributed) {
    if (!session.alive || session.surfaceRef == null) continue;
    const list = sessionsByRef.get(session.surfaceRef) ?? [];
    list.push(session);
    sessionsByRef.set(session.surfaceRef, list);
  }
  const sharedUnknown = new Map<string, string>();
  for (const [ref, sessions] of sessionsByRef) {
    const surface = byRef.get(ref);
    const surfaceId = surface?.id ?? null;
    const workspaceId = surface?.workspaceId ?? null;
    // A joined surface the tree gave no uuid cannot be printed as a command;
    // dropping it would read as "no pane", so the lookup fails instead.
    if (surfaceId == null || workspaceId == null) {
      noUuid.push(ref);
      continue;
    }
    const pane: LivePane = {source: 'hook-store', surfaceId, workspaceId};
    const [only] = sessions;
    if (sessions.length === 1 && only != null) {
      bySession.set(only.sessionId, pane);
      continue;
    }
    const screen = await readScreen(sources.cmux, ref);
    const shown = screen.kind === 'read' ? statusLineIdOf(screen.text) : null;
    const chosen = sessions.find((session) => session.sessionId === shown);
    if (chosen != null) {
      bySession.set(chosen.sessionId, pane);
      continue;
    }
    const ids = sessions.map((session) => session.sessionId).join(', ');
    const why =
      screen.kind === 'unreadable'
        ? `its screen could not be read (${screen.reason})`
        : shown == null
          ? 'its status line shows no session id'
          : `its status line shows ${shown}`;
    for (const session of sessions) {
      sharedUnknown.set(
        session.sessionId,
        `${SHARED_PANE_REASON}: the pid/tty join puts ${ids} in ${ref}, and ${why}`,
      );
    }
  }
  // j8q3e.17 D1: the panes the hook store left, placed by their status line.
  // A candidate with no uuid could not be matched to the session file, so it
  // fails the lookup the same way.
  for (const surface of unplacedClaudeSurfaces(
    procs.value,
    surfaces.value,
    attributed,
  )) {
    if (surface.id == null || surface.workspaceId == null) {
      noUuid.push(surface.ref);
    }
  }
  if (noUuid.length > 0) {
    return {
      ok: false,
      reason: `cmux tree: no surface or workspace uuid for ${[...new Set(noUuid)].join(', ')}`,
    };
  }
  const statusLine = await readStatusLineSource({
    attributed,
    cmux: sources.cmux,
    procs: procs.value,
    sessionFilePath: sources.sessionFilePath,
    surfaces: surfaces.value,
  });
  for (const placement of statusLine.placed) {
    const {id, workspaceId} = placement.surface;
    if (id == null || workspaceId == null) continue; // checked above
    bySession.set(placement.sessionId, {
      source: 'status-line',
      surfaceId: id,
      workspaceId,
    });
  }
  // F8: a session left unknown on a shared pane stays unknown unless the
  // status line placed it elsewhere.
  const unknownSessions = new Map(statusLine.unknownSessions);
  for (const [sessionId, why] of sharedUnknown) {
    if (!bySession.has(sessionId)) unknownSessions.set(sessionId, why);
  }
  return {
    bySession,
    ok: true,
    statusLine: {
      failure:
        statusLine.failure == null
          ? null
          : paneFailureReason('cmux session file', statusLine.failure),
      unknownSessions,
      unplaced: statusLine.unplaced,
    },
  };
}
