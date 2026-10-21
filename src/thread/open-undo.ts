/**
 * `thread open --undo` (home-base-yukaf.2): close exactly the workspaces one
 * `thread open` run opened, keeping any that hold unsent text, Claude
 * mid-turn, or activity since. Justin, 2026-10-17: "a way to track the windows
 * that we opened with that command so that we could also close them all …
 * critically important that the whatever tooling we have to close these
 * windows checks first to make sure that there's not … unsubmitted text in the
 * … text input box. And if there is that we either block the closing of these
 * tabs or we capture it in a way that's very robust".
 *
 * Decisions of epic home-base-yukaf it follows:
 *
 * - D-RECORD: the run is `<threads state dir>/opens/<stamp>.json`, the newest
 *   by default, `--run <stamp>` to pick one. Only workspace uuids in that
 *   record are ever closed; a uuid no longer in the live tree is "already
 *   gone". Nothing the record did not open is touched (the window's own
 *   default workspace included).
 * - D-UNDO-SAFETY: each present workspace passes every gate or is KEPT with
 *   the reason printed. All gates are read-only:
 *   1. every surface's screen is read and findInputBox finds an EMPTY box; a
 *      draft keeps the workspace and is written to the drafts store;
 *   2. no surface shows Claude working (workingIndicator, one implementation
 *      with pane-backfill);
 *   3. the session's last transcript activity (readActivity: user and
 *      assistant records only) is not newer than the record's `at`.
 *   An unreadable screen or an unknown activity keeps it (critical rule 7).
 *   More keep it: a screen showing a session id other than the one the run
 *   opened; Claude on screen with no claude process found on the pane's tty
 *   (it could not be stopped first); a claude process whose command line
 *   does not name the run's session (not started by this run); a tty that
 *   more than one pane reports (whose processes are whose cannot be told).
 *   A pane with NO input box, no claude process on its tty and only the shell
 *   on it, whose screen is blank or a bare shell prompt, is closable without
 *   SIGTERM: `--focus false` may leave a workspace's shell unstarted, or
 *   Claude never launched (yukaf.1 notes, UNVERIFIED). No input box with a
 *   claude process on the tty is kept ("Claude is starting or showing a
 *   dialog").
 * - Closing, per workspace, in this order: the gates run again right before
 *   (seconds after the first pass, not minutes); every claude pid on its
 *   panes is re-identified (`ps -p <pid> -o command=` equals what ps showed),
 *   sent SIGTERM (never -9) and polled every 250 ms for up to 15 s (a
 *   `(claude)` zombie has exited); only then `close-workspace`. The
 *   cmux-arrange-close pattern: a pane closed without SIGTERM keeps its PTY,
 *   and SIGTERM keeps the session resumable.
 * - The record is rewritten with `undo.startedAt` BEFORE the first SIGTERM,
 *   and refuses to signal anything when that write fails; then after every
 *   workspace. A previous undo of the same record moves to `previousUndos`.
 * - D-NO-LIVE-RUNS: tests drive fake cmux, ps, kill and activity; against the
 *   live machine only `--dry-run`, which writes nothing (not even a draft).
 */

import type {OutputStyle} from '../cli-style';
import type {CmuxRunner, CmuxTree} from './cmux';
import type {InputDraftWrite, WriteInputDraftInput} from './input-drafts';
import type {
  HookStore,
  LiveSurface,
  Proc,
  ProcessRunner,
  ScreenRead,
} from './pane-join';
import type {EnvLike} from './paths';
import type {ActivityTimes} from './transcript-activity';
import type {PidCommand} from './workspace-close';

import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';

import {
  BODY_COLUMN,
  DETAIL_COLUMN,
  fieldLabelWidth,
  fieldLines,
  HEADER_COLUMN,
  outputStyle,
  pad,
  paint,
  sectionHeader,
  spacedList,
  stepColumn,
  wrapHanging,
} from '../cli-style';
import {writeStdout} from '../write-stdout';
import {readCmuxTree, realCmuxRunner, surfacesOfWorkspace} from './cmux';
import {findTranscript} from './facts';
import {writeInputDraft} from './input-drafts';
import {argvSessionId, isSessionProc} from './live-sessions';
import {activityWords, locateWorkspace, opensDir, writeJsonFile} from './open';
import {
  findInputBox,
  isShellScaffolding,
  NO_BREAK_SPACE,
  normalizeTty,
  readLiveSurfaces,
  readProcesses,
  readScreenForBox,
  realProcessRunner,
  screenLines,
  screenSessionId,
  workingIndicator,
} from './pane-join';
import {tildeText} from './part-one';
import {liveSocketPath, socketSettingsJson} from './respawn';
import {readActivity} from './transcript-activity';
import {
  realPidCommand,
  realSigterm,
  stopThenCloseWorkspace,
} from './workspace-close';

/** How long a claude process gets to exit after SIGTERM (cmux-arrange-close's figure). */
export const UNDO_EXIT_TIMEOUT_MS = 15_000;

/** How long to wait for a window to disappear after its last workspace closed. */
export const UNDO_WINDOW_GONE_TIMEOUT_MS = 5000;

const POLL_MS = 250;

// ---------------------------------------------------------------------------
// The record, as --undo reads it (only what it needs; the rest is kept as is)
// ---------------------------------------------------------------------------

const recordSchema = z.looseObject({
  at: z.string(),
  // yukaf.22 --include-open: workspaces the run moved in, to move back.
  moved: z
    .array(
      z.looseObject({
        fromIndex: z.number().nullable().optional(),
        // G3: 1 means this move emptied its window, so cmux left a blank one.
        fromWindowCount: z.number().nullable().optional(),
        fromWindowId: z.string().nullable().optional(),
        fromWindowRef: z.string().nullable().optional(),
        movedAt: z.string().nullable().optional(),
        name: z.string().optional(),
        sessionId: z.string(),
        toWindowId: z.string().nullable().optional(),
        workspaceId: z.string(),
      }),
    )
    .optional(),
  planned: z
    .array(
      z.looseObject({
        name: z.string().optional(),
        sessionId: z.string(),
        title: z.string().optional(),
      }),
    )
    .optional(),
  previousUndos: z.array(z.unknown()).optional(),
  undo: z.unknown().optional(),
  windows: z.array(
    z.looseObject({
      windowId: z.string().nullable(),
      workspaces: z.array(
        z.looseObject({
          sessionId: z.string(),
          workspaceId: z.string().nullable(),
        }),
      ),
    }),
  ),
});

type ParsedRecord = z.infer<typeof recordSchema>;

/** One workspace the run opened, as the record names it. */
export interface RecordedWorkspace {
  /** The workspace name thread open gave it, or the session id. */
  name: string;
  sessionId: string;
  windowId: string | null;
  workspaceId: string | null;
}

// ---------------------------------------------------------------------------
// What the undo found and did (written to the record under `undo`)
// ---------------------------------------------------------------------------

export interface UndoDraft {
  /**
   * The session the text belongs to: the id its screen shows, else the
   * run's. Null only in a named close (`thread close`) whose box shows no id.
   */
  sessionId: string | null;
  /** Why it was not stored, when a real run could not store it. */
  storeFailure: string | null;
  /** Where the store holds it; null when not stored (dry run, or failed). */
  stored: string | null;
  surfaceId: string;
  text: string;
}

export interface UndoKept {
  /** Every unsent text found, joined by a blank line; null when none. */
  draft: string | null;
  drafts: UndoDraft[];
  name: string;
  /** Every reason, joined by "; ". */
  reason: string;
  reasons: string[];
  sessionId: string;
  workspaceId: string | null;
}

export interface UndoClosing {
  name: string;
  /** The claude pids to stop first; empty when no Claude process runs there. */
  pids: number[];
  sessionId: string;
  workspaceId: string;
}

export interface UndoClosed extends UndoClosing {
  closedAt: string;
}

export interface UndoGone {
  name: string;
  sessionId: string;
  workspaceId: string;
}

export interface UndoFailed {
  name: string;
  reason: string;
  sessionId: string;
  step: 'close-workspace' | 'record' | 'sigterm' | 'verify' | 'wait-exit';
  workspaceId: string;
}

/** A workspace the run moved in (--include-open), moved back (or would be). */
export interface UndoMovedBack {
  name: string;
  /** "restored", "would be restored", or why the old position was not. */
  position: string;
  sessionId: string;
  /** The window it came from and went back to. */
  windowId: string;
  windowRef: string | null;
  workspaceId: string;
}

/**
 * G3 (home-base-yukaf.25): the blank workspace cmux left in a window the run
 * moved every workspace out of, closed (or would be) or left, and why.
 */
export interface UndoBlank {
  /** closed · would close (dry run) · kept. */
  outcome: 'closed' | 'kept' | 'wouldClose';
  reason: string;
  windowId: string;
  windowRef: string | null;
  /** null when no single blank workspace could be told apart. */
  workspaceId: string | null;
}

export interface UndoState {
  /** G3: blank workspaces in the windows moved workspaces went back to. */
  blank: UndoBlank[];
  closed: UndoClosed[];
  dryRun: boolean;
  failed: UndoFailed[];
  /** Steps that failed outside any one workspace (record, tree reads). */
  failures: string[];
  finishedAt: string | null;
  gone: UndoGone[];
  kept: UndoKept[];
  /** yukaf.22: moved workspaces put back, BEFORE anything is closed. */
  movedBack: UndoMovedBack[];
  /** Moved workspaces left where they are, and why. */
  notMovedBack: {
    name: string;
    reason: string;
    sessionId: string;
    workspaceId: string;
  }[];
  /** What the gates let through on the first pass, in order. */
  planned: UndoClosing[];
  /** Written to the record before the first SIGTERM. */
  startedAt: string;
  /** Windows this undo emptied that cmux then closed. */
  windowsClosed: string[];
  /** Windows that are still open after this undo emptied them of ours, and why. */
  windowsLeft: {reason: string; windowId: string}[];
}

// ---------------------------------------------------------------------------
// The gates (pure, per pane)
// ---------------------------------------------------------------------------

const IDLE_PROMPT = /^(?:❯|\$|%|#|>|➜)$/u;

/** A blank screen, or one whose last line is a bare shell prompt with nothing typed. */
export function idleShellScreen(lines: readonly string[]): boolean {
  const shown = lines
    .map((line) => line.replaceAll(NO_BREAK_SPACE, ' ').trim())
    .filter((line) => line !== '');
  const last = shown.at(-1);
  return last == null || IDLE_PROMPT.test(last);
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** "2026-10-18 09:12:05", local time. */
function localStamp(ms: number): string {
  const at = new Date(ms);
  return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${pad2(at.getHours())}:${pad2(at.getMinutes())}:${pad2(at.getSeconds())}`;
}

function cut(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export interface PaneGate {
  /** Claude session processes on the pane's tty, to stop before closing. */
  claude: Proc[];
  /**
   * The input box's unsent text and the session it belongs to (the id its
   * screen shows, else the expected one), or null. The session is null only
   * in a named close whose box shows no `⌗` id: the text cannot be filed
   * under a session, and the pane is kept (F19).
   */
  draft: {sessionId: string | null; text: string} | null;
  /** Why the pane keeps its workspace open; empty = it may close. */
  reasons: string[];
  /** The session id the input box's status line shows, lowercased; null when none. */
  shown: string | null;
}

/**
 * The pids the cmux hook store records for each session (lowercased id →
 * pids). `thread close` passes it: a claude process counts as running the
 * session its screen shows when its command line OR the hook store names it
 * (a bare `claude`, or a /clear, leaves the command line silent or stale).
 */
export type HookStorePids = ReadonlyMap<string, ReadonlySet<number>>;

/** The hook store's `sessions` map as {@link HookStorePids}; entries with no pid are left out. */
export function hookStorePids(store: HookStore): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const [key, entry] of Object.entries(store.sessions ?? {})) {
    if (entry.pid == null) continue;
    const id = (entry.sessionId ?? key).toLowerCase();
    out.set(id, new Set([...(out.get(id) ?? []), entry.pid]));
  }
  return out;
}

/**
 * D-UNDO-SAFETY for one pane. `procsOnTty` is null when the pane's tty is not
 * known (then no process on it can be found, which is not the same as none).
 *
 * `sessionId` is the session the pane must hold: the one the run opened, for
 * `thread open --undo`. `null` is a NAMED close (`thread close`,
 * home-base-yukaf.31): there is no run, so the session the pane's own
 * `⌗ <id>` line shows is the one checked, and every other gate is the same.
 * `hookPids` (named close) lets the hook store name a process's session too;
 * without it only the command line can (`--undo`, unchanged).
 */
export function gatePane(input: {
  hookPids?: HookStorePids;
  label: string;
  procsOnTty: readonly Proc[] | null;
  screen: ScreenRead;
  sessionId: string | null;
  tty: string | null;
}): PaneGate {
  const {label} = input;
  if (input.screen.kind === 'unreadable') {
    return {
      claude: [],
      draft: null,
      reasons: [
        `the screen of ${label} could not be read: ${input.screen.reason}`,
      ],
      shown: null,
    };
  }
  const reasons: string[] = [];
  const lines = screenLines(input.screen.text);
  const claude = (input.procsOnTty ?? []).filter((proc) => isSessionProc(proc));
  const working = workingIndicator(lines);
  if (working != null) {
    reasons.push(`Claude is working in ${label}: "${cut(working, 70)}"`);
  }
  const box = findInputBox(lines);
  let draft: PaneGate['draft'] = null;
  if (box != null) {
    const shown = screenSessionId(lines, box);
    if (box.draft !== '') {
      draft = {sessionId: shown ?? input.sessionId, text: box.draft};
      reasons.push(`unsent text in the input box of ${label}`);
    }
    if (
      input.sessionId != null &&
      shown != null &&
      shown !== input.sessionId.toLowerCase()
    ) {
      reasons.push(
        `${label} shows session ${shown}, which is not the one this run opened`,
      );
    }
    // F19 (home-base-yukaf.14): a box with no readable `⌗ <id>` line could
    // hold any session. The argv check below cannot tell (a /clear keeps the
    // old --resume id), and the activity gate reads only the recorded
    // session, so a pane Justin switched sessions in would pass both.
    if (shown == null) {
      reasons.push(
        `cannot tell which session ${label} holds: its input box shows no "⌗ <session id>" line`,
      );
    }
    if (input.procsOnTty == null) {
      reasons.push(
        `Claude is on ${label} but its tty is unknown, so its process cannot be found and stopped first`,
      );
    } else if (claude.length === 0) {
      reasons.push(
        `Claude is on ${label} but no claude process runs on its tty ${input.tty ?? '?'}, so it cannot be stopped first`,
      );
    }
    // Only a process this run started is signalled: thread open ran
    // `claude --resume <id>`, and a /clear keeps that argv id. Anything else on
    // the tty (Claude restarted by hand, a reused tty) is not ours to stop.
    // A named close (sessionId null) checks the session the screen shows,
    // named by the command line or the hook store; with no shown id the pane
    // is already kept above.
    const want = input.sessionId?.toLowerCase() ?? shown;
    if (want != null) {
      const foreign = claude.filter(
        (proc) =>
          argvSessionId(proc.command) !== want &&
          input.hookPids?.get(want)?.has(proc.pid) !== true,
      );
      const [other] = foreign;
      if (other != null) {
        reasons.push(
          input.sessionId == null
            ? `the claude process on ${label} (pid ${other.pid}) names neither on its command line nor in the cmux hook store the session its screen shows (${want}), so which session it runs cannot be confirmed and it is not stopped`
            : `the claude process on ${label} (pid ${other.pid}) does not name session ${want} on its command line, so it was not started by this run and is not stopped`,
        );
      }
    }
    return {claude, draft, reasons, shown};
  }
  if (claude.length > 0) {
    reasons.push(
      `${label} shows no Claude input box but a claude process runs on its tty: Claude is starting or showing a dialog`,
    );
    return {claude, draft, reasons, shown: null};
  }
  // F20 (home-base-yukaf.14): an unknown tty always keeps the pane, a blank
  // screen included. cmux returns an empty screen for a pane that has not
  // drawn yet (live-sessions.ts noIdDetail), so blank is no evidence that no
  // Claude runs there; closing it without SIGTERM would leave that Claude's
  // PTY unplaced, and every later `thread open` would refuse.
  if (input.procsOnTty == null) {
    reasons.push(
      `${label} shows no Claude input box and its tty is unknown, so what runs there cannot be checked`,
    );
    return {claude, draft, reasons, shown: null};
  }
  const busy = input.procsOnTty.filter((proc) => !isShellScaffolding(proc));
  const [first] = busy;
  if (first != null) {
    reasons.push(`${label} is running ${cut(first.command, 70)}`);
    return {claude, draft, reasons, shown: null};
  }
  if (!idleShellScreen(lines)) {
    const last = lines.filter((line) => line.trim() !== '').at(-1) ?? '';
    reasons.push(
      `${label} shows neither a Claude input box nor an idle shell prompt (last line: "${cut(last, 60)}")`,
    );
  }
  return {claude, draft, reasons, shown: null};
}

// ---------------------------------------------------------------------------
// Assessing one workspace (read-only)
// ---------------------------------------------------------------------------

export type Assessment =
  | {
      claude: Proc[];
      entry: RecordedWorkspace;
      kind: 'closable';
      windowId: string;
      workspaceId: string;
    }
  | {entry: RecordedWorkspace; kind: 'gone'; workspaceId: string}
  | {
      drafts: GateDraft[];
      entry: RecordedWorkspace;
      kind: 'kept';
      reasons: string[];
    };

/** What one pass of the gates reads: the tree twice (windows; ttys), ps. */
export interface LiveView {
  procs: Proc[];
  surfaces: LiveSurface[];
  tree: CmuxTree;
}

function windowOf(tree: CmuxTree, workspaceId: string): string | null {
  const want = workspaceId.toUpperCase();
  const window = tree.windows.find((entry) =>
    entry.workspaces.some((workspace) => workspace.id.toUpperCase() === want),
  );
  return window?.id ?? null;
}

/** Unsent text a gate found, the pane it is in and its session (null: unknown). */
export interface GateDraft {
  sessionId: string | null;
  surfaceId: string;
  text: string;
}

export interface SurfacesGate {
  /** Claude session processes on the workspace's panes, to stop first. */
  claude: Proc[];
  drafts: GateDraft[];
  /** Why the workspace is kept; empty = it may close. */
  reasons: string[];
  /** Every distinct session id its panes' status lines show, lowercased. */
  sessions: string[];
}

/**
 * The per-pane gates of D-UNDO-SAFETY over every surface of one workspace
 * (screen, tty, processes, input box). ONE IMPLEMENTATION, shared by
 * assessWorkspace (`--undo`), the blank-workspace close of G3
 * (home-base-yukaf.25) and `thread close` (close.ts, home-base-yukaf.31).
 *
 * `sessionId` null is a named close (see gatePane). It adds one workspace
 * rule there: the workspace holds at most one Claude session and one Claude
 * process, since closing it stops everything on it and there is no run to
 * say which session was meant. `--undo` needs no such rule: every pane must
 * show the run's own session.
 */
export async function gateSurfaces(
  surfaceIds: readonly string[],
  view: LiveView,
  run: CmuxRunner,
  sessionId: string | null,
  hookPids?: HookStorePids,
): Promise<SurfacesGate> {
  const reasons: string[] = [];
  const drafts: GateDraft[] = [];
  const claude: Proc[] = [];
  const sessions: string[] = [];
  if (surfaceIds.length === 0) {
    reasons.push('cmux lists no pane in it, so nothing on it can be checked');
  }
  for (const surfaceId of surfaceIds) {
    const surface = view.surfaces.find(
      (candidate) => candidate.id?.toUpperCase() === surfaceId.toUpperCase(),
    );
    const tty = normalizeTty(surface?.tty);
    const label = `pane ${surface?.ref ?? surfaceId}`;
    // Dead and hibernated surfaces can keep reporting a tty a newer pane has
    // since been given (scripts/CLAUDE.md, cmux-arrange resolveTtys): a tty
    // two panes report cannot tell whose processes are whose.
    const sharers =
      tty == null
        ? 0
        : view.surfaces.filter(
            (candidate) => normalizeTty(candidate.tty) === tty,
          ).length;
    if (sharers > 1) {
      reasons.push(
        `${label} reports tty ${tty}, which ${sharers - 1} other pane${sharers === 2 ? '' : 's'} also report, so which processes are its own cannot be told`,
      );
    }
    const procsOnTty =
      tty == null
        ? null
        : view.procs.filter((proc) => normalizeTty(proc.tty) === tty);
    // F6: a draft taller than the screen is read back from the scrollback.
    const screen = await readScreenForBox(run, surface?.ref ?? surfaceId);
    const gate = gatePane({
      ...(hookPids == null ? {} : {hookPids}),
      label,
      procsOnTty,
      screen,
      sessionId,
      tty,
    });
    reasons.push(...gate.reasons);
    claude.push(...gate.claude);
    if (gate.draft != null) drafts.push({...gate.draft, surfaceId});
    if (gate.shown != null && !sessions.includes(gate.shown)) {
      sessions.push(gate.shown);
    }
  }
  if (sessionId == null) {
    if (sessions.length > 1) {
      reasons.push(
        `it holds ${sessions.length} Claude sessions (${sessions.join(', ')}), and closing it would stop all of them`,
      );
    }
    const pids = [...new Set(claude.map((proc) => proc.pid))];
    if (pids.length > 1) {
      reasons.push(
        `${pids.length} Claude processes run in it (pid ${pids.join(', ')}), and closing it would stop all of them`,
      );
    }
  }
  return {claude, drafts, reasons, sessions};
}

async function assessWorkspace(
  entry: RecordedWorkspace,
  view: LiveView,
  deps: Pick<UndoDeps, 'readActivity' | 'run'>,
  recordAtMs: number,
): Promise<Assessment> {
  const keep = (reasons: string[]): Assessment => ({
    drafts: [],
    entry,
    kind: 'kept',
    reasons,
  });
  if (entry.workspaceId == null) {
    return keep([
      "its workspace uuid was never recorded (cmux's answer could not be matched to one), so --undo cannot tell which workspace it is",
    ]);
  }
  const workspaceId = entry.workspaceId;
  const surfaceIds = surfacesOfWorkspace(view.tree, workspaceId);
  const windowId = windowOf(view.tree, workspaceId);
  if (surfaceIds == null || windowId == null) {
    return {entry, kind: 'gone', workspaceId};
  }
  const {claude, drafts, reasons} = await gateSurfaces(
    surfaceIds,
    view,
    deps.run,
    entry.sessionId,
  );
  const activity = await deps.readActivity(entry.sessionId);
  if (activity.kind === 'unknown') {
    reasons.push(
      `its last activity could not be read (${activity.reason}), so it may have been used since`,
    );
  } else if (activity.lastMs > recordAtMs) {
    reasons.push(
      `it was used after the run opened it: its last activity is ${localStamp(activity.lastMs)}, the run was at ${localStamp(recordAtMs)}`,
    );
  }
  if (reasons.length > 0) {
    return {drafts, entry, kind: 'kept', reasons};
  }
  return {claude, entry, kind: 'closable', windowId, workspaceId};
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

/** Lives in workspace-close.ts since home-base-yukaf.4; re-exported here. */
export type {PidCommand};

export interface UndoDeps {
  /** `ps -p <pid> -o command=`: what a pid runs now, gone, or unreadable. */
  commandOf: (pid: number) => Promise<PidCommand>;
  exitTimeoutMs: number;
  /** SIGTERM, never anything stronger: null when sent, else why not. */
  kill: (pid: number) => string | null;
  nowMs: () => number;
  ps: ProcessRunner;
  readActivity: (sessionId: string) => Promise<ActivityTimes>;
  run: CmuxRunner;
  sleep: (ms: number) => Promise<void>;
  windowGoneTimeoutMs: number;
  writeDraft: (input: WriteInputDraftInput) => InputDraftWrite;
  /** Rewrite the record (temp file + rename): null when written, else why not. */
  writeRecord: (path: string, value: unknown) => string | null;
}

export interface UndoOptions {
  dryRun: boolean;
  env?: EnvLike;
  json: boolean;
  /** `--run <stamp>`; null = the newest record. */
  run: string | null;
  style?: OutputStyle;
  /** False only when --run was given without --undo (refused). */
  undo: boolean;
}

/** 0 done (or dry run) · 1 nothing to undo, or a step failed · 2 refused, nothing done. */
export interface UndoResult {
  exitCode: 0 | 1 | 2;
  output: string;
  recordPath: string | null;
  state: UndoState | null;
}

// One implementation of the real `ps -p` and SIGTERM, in workspace-close.ts
// (moved there by home-base-yukaf.22 for `thread archive --stop`).
const realCommandOf = realPidCommand;
const realKill = realSigterm;

async function realActivity(
  sessionId: string,
  env: EnvLike,
): Promise<ActivityTimes> {
  const found = findTranscript(sessionId, env);
  if (found.status === 'found') return await readActivity(found.path);
  if (found.status === 'failed') {
    return {
      kind: 'unknown',
      reason: `the transcripts could not be searched: ${found.error}`,
    };
  }
  return {
    kind: 'unknown',
    reason: `no transcript ${sessionId}.jsonl under ${tildeText(found.searched)}`,
  };
}

/** `--run` as a record file name: the stamp, with or without `.json`, colons allowed. */
export function recordFileName(run: string): string | null {
  const stamp = run
    .trim()
    .replace(/\.json$/u, '')
    .replaceAll(':', '-');
  return /^\d{4}-\d{2}-\d{2}T[\d.-]+Z$/u.test(stamp) ? `${stamp}.json` : null;
}

type RecordPick =
  | {kind: 'failed'; reason: string}
  | {kind: 'none'; reason: string}
  | {kind: 'picked'; path: string; stamp: string};

function pickRecord(env: EnvLike, run: string | null): RecordPick {
  const dir = opensDir(env);
  if (run != null) {
    const name = recordFileName(run);
    if (name == null) {
      return {
        kind: 'failed',
        reason: `--run takes a record stamp such as 2026-10-18T12-34-56.789Z (the file name under ${tildeText(dir)}); not ${JSON.stringify(run)}`,
      };
    }
    const path = join(dir, name);
    return existsSync(path)
      ? {kind: 'picked', path, stamp: name.slice(0, -'.json'.length)}
      : {
          kind: 'none',
          reason: `no run ${name.slice(0, -'.json'.length)} is recorded in ${tildeText(dir)}`,
        };
  }
  if (!existsSync(dir)) {
    return {
      kind: 'none',
      reason: `no run of thread open is recorded (${tildeText(dir)} does not exist)`,
    };
  }
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    return {
      kind: 'failed',
      reason: `${tildeText(dir)} could not be listed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const records = names
    .filter((name) => name.endsWith('.json') && recordFileName(name) === name)
    .sort();
  const newest = records.at(-1);
  if (newest == null) {
    return {
      kind: 'none',
      reason: `no run of thread open is recorded in ${tildeText(dir)}`,
    };
  }
  return {
    kind: 'picked',
    path: join(dir, newest),
    stamp: newest.slice(0, -'.json'.length),
  };
}

type RecordRead =
  | {kind: 'failed'; reason: string}
  | {kind: 'read'; parsed: ParsedRecord; raw: Record<string, unknown>};

function readRecord(path: string): RecordRead {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    return {
      kind: 'failed',
      reason: `the record ${tildeText(path)} could not be read: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
    };
  }
  const parsed = recordSchema.safeParse(raw);
  if (!parsed.success || raw == null || typeof raw !== 'object') {
    return {
      kind: 'failed',
      reason: `the record ${tildeText(path)} is not a thread open record: ${parsed.error?.issues[0]?.message ?? 'not an object'}`,
    };
  }
  return {
    kind: 'read',
    parsed: parsed.data,
    raw: raw as Record<string, unknown>,
  };
}

/** Every workspace the record says the run opened, window by window, in order. */
export function recordedWorkspaces(record: ParsedRecord): RecordedWorkspace[] {
  const names = new Map(
    (record.planned ?? []).map((entry) => [
      entry.sessionId,
      entry.name ?? entry.title ?? entry.sessionId,
    ]),
  );
  return record.windows.flatMap((window) =>
    window.workspaces.map((workspace) => ({
      name: names.get(workspace.sessionId) ?? workspace.sessionId,
      sessionId: workspace.sessionId,
      windowId: window.windowId,
      workspaceId: workspace.workspaceId,
    })),
  );
}

export type ViewRead =
  | {kind: 'failed'; reason: string}
  | {kind: 'read'; view: LiveView};

/** One gate pass's reads (shared with close.ts): any source failing fails the whole read. */
export async function readView(
  deps: Pick<UndoDeps, 'ps' | 'run'>,
): Promise<ViewRead> {
  const [tree, surfaces, procs] = await Promise.all([
    readCmuxTree(deps.run),
    readLiveSurfaces(deps.run),
    readProcesses(deps.ps),
  ]);
  const failures: string[] = [];
  if (tree.kind !== 'read') failures.push(`the cmux tree: ${tree.reason}`);
  if (!surfaces.ok) failures.push(`the cmux panes: ${surfaces.reason}`);
  if (!procs.ok) failures.push(`ps: ${procs.reason}`);
  if (tree.kind !== 'read' || !surfaces.ok || !procs.ok) {
    return {kind: 'failed', reason: failures.join('; ')};
  }
  return {
    kind: 'read',
    view: {procs: procs.value, surfaces: surfaces.value, tree: tree.tree},
  };
}

function keptOf(
  assessment: Extract<Assessment, {kind: 'kept'}>,
  drafts: UndoDraft[],
): UndoKept {
  return {
    draft:
      drafts.length === 0
        ? null
        : drafts.map((entry) => entry.text).join('\n\n'),
    drafts,
    name: assessment.entry.name,
    reason: assessment.reasons.join('; '),
    reasons: assessment.reasons,
    sessionId: assessment.entry.sessionId,
    workspaceId: assessment.entry.workspaceId,
  };
}

/** Store every draft of a kept workspace (D-DRAFTS, source 'undo'); a dry run stores none. */
function storeDrafts(
  assessment: Extract<Assessment, {kind: 'kept'}>,
  deps: Pick<UndoDeps, 'nowMs' | 'writeDraft'>,
  dryRun: boolean,
): UndoDraft[] {
  return assessment.drafts.map((found) => {
    if (dryRun) {
      return {...found, storeFailure: null, stored: null};
    }
    // The run's session is always known here; the type allows null for a
    // named close (thread close), which files nothing under a guessed id.
    if (found.sessionId == null) {
      return {
        ...found,
        storeFailure: 'no session id is known for this text',
        stored: null,
      };
    }
    const written = deps.writeDraft({
      at: new Date(deps.nowMs()).toISOString(),
      sessionId: found.sessionId,
      source: 'undo',
      surfaceId: found.surfaceId,
      text: found.text,
      workspaceId: assessment.entry.workspaceId,
    });
    return written.kind === 'written'
      ? {...found, storeFailure: null, stored: written.path}
      : {...found, storeFailure: written.reason, stored: null};
  });
}

type RecordedMove = NonNullable<ParsedRecord['moved']>[number];

/** `ids` with `id` taken out and put back at `index` (clamped). */
function withAt(ids: readonly string[], id: string, index: number): string[] {
  const rest = ids.filter((entry) => entry.toUpperCase() !== id.toUpperCase());
  const at = Math.max(0, Math.min(index, rest.length));
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/**
 * yukaf.22: put every workspace the run moved in (--include-open) back in
 * the window it came from, at its old position when reorder-workspaces can
 * restore it. Runs BEFORE anything is closed. Moving never closes or signals
 * anything, so no gate applies; a workspace is moved back only while it is
 * still in the window this run made and its old window still exists. In a
 * dry run nothing is written. Returns false when the record could not be
 * rewritten (the undo then stops).
 */
async function moveBack(
  moves: readonly RecordedMove[],
  deps: Pick<UndoDeps, 'run'>,
  state: UndoState,
  dryRun: boolean,
  save: () => string | null,
): Promise<boolean> {
  if (moves.length === 0) return true;
  const tree = await readCmuxTree(deps.run);
  const notBack = (move: RecordedMove, reason: string): void => {
    state.notMovedBack.push({
      name: move.name ?? move.sessionId,
      reason,
      sessionId: move.sessionId,
      workspaceId: move.workspaceId,
    });
  };
  if (tree.kind !== 'read') {
    state.failures.push(
      `the cmux tree could not be read, so no moved workspace was moved back: ${tree.reason}`,
    );
    for (const move of moves) notBack(move, 'the cmux tree could not be read');
    return true;
  }
  for (const move of moves) {
    const at = locateWorkspace(tree.tree, move.workspaceId);
    const from = move.fromWindowId ?? null;
    const fromRef = move.fromWindowRef ?? from ?? 'its old window';
    if (at == null) {
      notBack(move, 'it is closed now, so there is nothing to move back');
      continue;
    }
    if (at.windowId.toUpperCase() === from?.toUpperCase()) {
      notBack(move, `it is already in ${fromRef}, where it came from`);
      continue;
    }
    if (at.windowId.toUpperCase() !== move.toWindowId?.toUpperCase()) {
      notBack(
        move,
        `it is no longer in the window this run made (it is in ${at.windowRef} now), so it is left where it is`,
      );
      continue;
    }
    const fromNow =
      from == null
        ? undefined
        : tree.tree.windows.find(
            (window) => window.id.toUpperCase() === from.toUpperCase(),
          );
    if (from == null || fromNow == null) {
      notBack(
        move,
        `the window it came from (${fromRef}) is closed now, so it stays in this run's window`,
      );
      continue;
    }
    const entry: UndoMovedBack = {
      name: move.name ?? move.sessionId,
      position: 'would be restored',
      sessionId: move.sessionId,
      windowId: from,
      windowRef: fromNow.ref,
      workspaceId: move.workspaceId,
    };
    if (move.fromIndex == null) {
      entry.position = 'not restored: the record has no position for it';
    }
    if (dryRun) {
      state.movedBack.push(entry);
      continue;
    }
    const call = await deps.run([
      'move-workspace-to-window',
      '--workspace',
      move.workspaceId,
      '--window',
      from,
    ]);
    if (call.kind === 'failed') {
      notBack(move, `moving it back failed: ${call.reason}`);
      state.failures.push(
        `moving "${entry.name}" back to ${fromRef} failed: ${call.reason}`,
      );
    } else {
      if (move.fromIndex != null) {
        // A move lands where cmux puts it; the old position is set
        // explicitly from a fresh read of that window (scripts/CLAUDE.md:
        // reorder-workspaces takes the full order, listed ones first).
        const after = await readCmuxTree(deps.run);
        const window =
          after.kind === 'read'
            ? after.tree.windows.find(
                (candidate) =>
                  candidate.id.toUpperCase() === from.toUpperCase(),
              )
            : undefined;
        if (window == null) {
          entry.position = `not restored: the window could not be read again${after.kind === 'read' ? '' : ` (${after.reason})`}`;
        } else {
          const order = withAt(
            window.workspaces.map((workspace) => workspace.id),
            move.workspaceId,
            move.fromIndex,
          );
          const reorder = await deps.run([
            'reorder-workspaces',
            '--order',
            order.join(','),
            '--window',
            from,
          ]);
          entry.position =
            reorder.kind === 'ok'
              ? 'restored'
              : `not restored: ${reorder.reason}`;
        }
      }
      state.movedBack.push(entry);
    }
    const rewrite = save();
    if (rewrite != null) {
      state.failures.push(
        `rewriting the record failed after moving workspaces back, so the undo stopped: ${rewrite}`,
      );
      return false;
    }
  }
  return true;
}

/**
 * G3 (home-base-yukaf.25): moving a window's last workspace out leaves a
 * blank workspace in it (scripts/CLAUDE.md, measured). After the moves back,
 * each such window should hold the moved-back workspace(s) and exactly one
 * other: that one is closed when every pane on it passes the same gates as
 * any close (gateSurfaces) and shows only an idle shell, with no Claude and
 * nothing else running. Anything else is left, with why. Its workspace
 * becomes the window's last only if no moved workspace came back, which is
 * refused: closing a window's last workspace closes the window.
 */
async function closeLeftBlank(
  moves: readonly RecordedMove[],
  deps: Pick<UndoDeps, 'ps' | 'run'>,
  state: UndoState,
  dryRun: boolean,
  save: () => string | null,
): Promise<boolean> {
  const emptied = new Map<string, string | null>();
  for (const move of moves) {
    if (move.fromWindowCount === 1 && move.fromWindowId != null) {
      emptied.set(move.fromWindowId, move.fromWindowRef ?? null);
    }
  }
  if (emptied.size === 0) return true;
  const read = await readView(deps);
  const ours = new Set(moves.map((move) => move.workspaceId.toUpperCase()));
  for (const [windowId, ref] of emptied) {
    const kept = (reason: string, workspaceId: string | null = null): void => {
      state.blank.push({
        outcome: 'kept',
        reason,
        windowId,
        windowRef: ref,
        workspaceId,
      });
    };
    if (read.kind !== 'read') {
      kept(`it could not be checked: ${read.reason}`);
      continue;
    }
    const window = read.view.tree.windows.find(
      (candidate) => candidate.id.toUpperCase() === windowId.toUpperCase(),
    );
    if (window == null) {
      kept('that window is closed now');
      continue;
    }
    const back = state.movedBack.filter(
      (entry) => entry.windowId.toUpperCase() === windowId.toUpperCase(),
    );
    const backHere = window.workspaces.filter((workspace) =>
      ours.has(workspace.id.toUpperCase()),
    );
    if (back.length === 0 || (!dryRun && backHere.length === 0)) {
      kept(
        'no moved workspace went back to it, so the blank workspace is its last one, and closing it would close the window',
      );
      continue;
    }
    const others = window.workspaces.filter(
      (workspace) => !ours.has(workspace.id.toUpperCase()),
    );
    const [blank] = others;
    if (blank == null || others.length !== 1) {
      kept(
        others.length === 0
          ? 'it holds no other workspace now'
          : `it holds ${others.length} other workspaces now, so which one cmux left blank cannot be told`,
      );
      continue;
    }
    const gate = await gateSurfaces(blank.surfaceIds, read.view, deps.run, '');
    if (gate.claude.length > 0) {
      gate.reasons.push('a Claude process runs on it');
    }
    if (gate.reasons.length > 0) {
      kept(
        `it is not only an idle shell any more: ${gate.reasons.join('; ')}`,
        blank.id,
      );
      continue;
    }
    if (dryRun) {
      state.blank.push({
        outcome: 'wouldClose',
        reason: 'it holds only an idle shell',
        windowId,
        windowRef: ref,
        workspaceId: blank.id,
      });
      continue;
    }
    const closed = await deps.run([
      'close-workspace',
      '--workspace',
      blank.id,
      '--window',
      windowId,
    ]);
    if (closed.kind === 'failed') {
      kept(`close-workspace failed: ${closed.reason}`, blank.id);
      state.failures.push(
        `closing the blank workspace in ${ref ?? windowId} failed: ${closed.reason}`,
      );
    } else {
      state.blank.push({
        outcome: 'closed',
        reason: 'it held only an idle shell',
        windowId,
        windowRef: ref,
        workspaceId: blank.id,
      });
    }
    const rewrite = save();
    if (rewrite != null) {
      state.failures.push(
        `rewriting the record failed after closing a blank workspace, so the undo stopped: ${rewrite}`,
      );
      return false;
    }
  }
  return true;
}

function refuse(text: string): UndoResult {
  return {
    exitCode: 2,
    output: `thread open --undo: refused: ${text}`,
    recordPath: null,
    state: null,
  };
}

/**
 * Stop a closable workspace's Claude processes and close it. Returns the
 * failure, or null when it closed.
 */
async function closeWorkspace(
  closing: Extract<Assessment, {kind: 'closable'}>,
  deps: UndoDeps,
): Promise<{reason: string; step: UndoFailed['step']} | null> {
  // One implementation of SIGTERM-wait-close (home-base-yukaf.4), shared
  // with scripts/cmux-arrange-close.ts.
  const failure = await stopThenCloseWorkspace(closing.claude, {
    closeWorkspace: async () => {
      const closed = await deps.run([
        'close-workspace',
        '--workspace',
        closing.workspaceId,
        '--window',
        closing.windowId,
      ]);
      return closed.kind === 'failed' ? closed.reason : null;
    },
    commandOf: deps.commandOf,
    exitTimeoutMs: deps.exitTimeoutMs,
    kill: deps.kill,
    nowMs: deps.nowMs,
    sleep: deps.sleep,
  });
  if (failure == null) return null;
  // No beforeSignal step is passed, so 'before-signal' cannot occur here.
  return {
    reason: failure.reason,
    step: failure.step === 'before-signal' ? 'verify' : failure.step,
  };
}

/** After this undo emptied a window of ours: did cmux close it? */
async function verifyWindows(
  windowIds: readonly string[],
  closedIds: ReadonlySet<string>,
  deps: UndoDeps,
  state: UndoState,
): Promise<void> {
  if (windowIds.length === 0) return;
  const deadline = deps.nowMs() + deps.windowGoneTimeoutMs;
  let tree = await readCmuxTree(deps.run);
  for (;;) {
    const open =
      tree.kind === 'read'
        ? windowIds.filter(
            (id) =>
              tree.kind === 'read' &&
              tree.tree.windows.some(
                (window) => window.id.toUpperCase() === id.toUpperCase(),
              ),
          )
        : windowIds;
    if (tree.kind === 'read' && open.length === 0) break;
    if (deps.nowMs() >= deadline) break;
    await deps.sleep(POLL_MS);
    tree = await readCmuxTree(deps.run);
  }
  if (tree.kind !== 'read') {
    state.failures.push(
      `whether the emptied windows closed could not be checked: ${tree.reason}`,
    );
    for (const windowId of windowIds) {
      state.windowsLeft.push({
        reason: 'the cmux tree could not be read to check',
        windowId,
      });
    }
    return;
  }
  for (const window of tree.tree.windows) {
    for (const workspace of window.workspaces) {
      if (closedIds.has(workspace.id.toUpperCase())) {
        state.failures.push(
          `close-workspace answered OK, but workspace ${workspace.id} is still open`,
        );
      }
    }
  }
  for (const windowId of windowIds) {
    const live = tree.tree.windows.find(
      (window) => window.id.toUpperCase() === windowId.toUpperCase(),
    );
    if (live == null) {
      state.windowsClosed.push(windowId);
      continue;
    }
    const others = live.workspaces.filter(
      (workspace) => !closedIds.has(workspace.id.toUpperCase()),
    ).length;
    state.windowsLeft.push({
      reason:
        others > 0
          ? `it holds ${others} workspace${others === 1 ? '' : 's'} this run did not open, left alone`
          : `cmux still lists it ${Math.round(deps.windowGoneTimeoutMs / 1000)} s after its last workspace closed`,
      windowId,
    });
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const LABELS = ['Session', 'Workspace', 'Claude', 'Stored', 'Why'].map(
  (label) => ({
    label,
    value: '',
  }),
);

function block(
  title: string,
  fields: {label: string; value: string}[],
  style: OutputStyle,
): string {
  return [
    wrapHanging(paint(title, ['bold'], style.color), {
      hang: BODY_COLUMN + 4,
      indent: BODY_COLUMN,
      width: style.width,
    }),
    fieldLines(fields, {
      color: style.color,
      indent: stepColumn(1),
      labelWidth: fieldLabelWidth(LABELS),
      width: style.width,
    }),
  ].join('\n');
}

/** The draft exactly as typed, every line indented, never wrapped. */
function verbatim(text: string): string {
  return text
    .split('\n')
    .map((line) => `${pad(DETAIL_COLUMN + 2)}${line}`)
    .join('\n');
}

function claudeWords(pids: readonly number[], done: boolean): string {
  if (pids.length === 0) {
    return 'no Claude process was running there, so none was stopped';
  }
  return `${done ? 'stopped' : 'would be stopped'} with SIGTERM first (pid ${pids.join(', ')})`;
}

export function renderUndo(
  state: UndoState,
  input: {now: Date; recordAt: string; recordPath: string; style: OutputStyle},
): string {
  const {style} = input;
  const header = (text: string, emoji: string): string =>
    sectionHeader(text, {color: style.color, emoji});
  const prose = (text: string): string =>
    wrapHanging(text, {
      hang: BODY_COLUMN,
      indent: BODY_COLUMN,
      width: style.width,
    });
  const blocks: string[] = [];
  blocks.push(
    header(
      'thread open --undo: close what one run of thread open opened',
      '🧹',
    ),
  );
  blocks.push(
    fieldLines(
      [
        {
          label: 'Mode',
          value: state.dryRun
            ? 'dry run: nothing closed, nothing signalled, nothing written'
            : 'closing',
        },
        {label: 'Run', value: activityWords(input.recordAt, input.now)},
        {label: 'Record', value: tildeText(input.recordPath)},
        {
          label: 'Gates',
          value:
            'an empty input box, Claude not working, no activity since the run (else kept)',
        },
      ],
      {color: style.color, indent: BODY_COLUMN, width: style.width},
    ),
  );

  // yukaf.22: first, because it happens first (before anything closes).
  if (state.movedBack.length > 0) {
    blocks.push(
      header(
        `${state.dryRun ? 'Would move back' : 'Moved back'} (${state.movedBack.length})`,
        '🧲',
      ),
    );
    blocks.push(
      spacedList(
        state.movedBack.map((entry) =>
          block(
            entry.name,
            [
              {label: 'Session', value: entry.sessionId},
              {label: 'Workspace', value: entry.workspaceId},
              {
                label: 'Why',
                value: `back to ${entry.windowRef ?? entry.windowId} (${entry.windowId}), where it was before thread open moved it; position ${entry.position}. It keeps running.`,
              },
            ],
            style,
          ),
        ),
      ),
    );
  }
  if (state.blank.length > 0) {
    blocks.push(
      header(`Blank workspaces left by a move (${state.blank.length})`, '🫙'),
    );
    blocks.push(
      spacedList(
        state.blank.map((entry) =>
          block(
            entry.outcome === 'closed'
              ? `Closed the blank workspace in ${entry.windowRef ?? entry.windowId}`
              : entry.outcome === 'wouldClose'
                ? `Would close the blank workspace in ${entry.windowRef ?? entry.windowId}`
                : `Left the blank workspace in ${entry.windowRef ?? entry.windowId}`,
            [
              {label: 'Window', value: entry.windowId},
              {label: 'Workspace', value: entry.workspaceId ?? 'not known'},
              {
                label: 'Why',
                value: `cmux made it when thread open moved the window's last workspace out; ${entry.reason}`,
              },
            ],
            style,
          ),
        ),
      ),
    );
  }
  if (state.notMovedBack.length > 0) {
    blocks.push(header(`Not moved back (${state.notMovedBack.length})`, '⏭️'));
    blocks.push(
      spacedList(
        state.notMovedBack.map((entry) =>
          block(
            entry.name,
            [
              {label: 'Session', value: entry.sessionId},
              {label: 'Workspace', value: entry.workspaceId},
              {label: 'Why', value: entry.reason},
            ],
            style,
          ),
        ),
      ),
    );
  }

  const withDraft = state.kept.filter((entry) => entry.drafts.length > 0);
  const keptOnly = state.kept.filter((entry) => entry.drafts.length === 0);
  if (withDraft.length > 0) {
    blocks.push(
      // The loud header: red as well as bold, and first after the summary.
      `${pad(HEADER_COLUMN)}✍️ ${paint(`Unsent text, kept open (${withDraft.length})`, ['bold', 'red'], style.color)}`,
    );
    blocks.push(
      spacedList(
        withDraft.map((entry) =>
          [
            block(
              entry.name,
              [
                {label: 'Session', value: entry.sessionId},
                {label: 'Workspace', value: entry.workspaceId ?? 'unknown'},
                ...entry.drafts.map((found) => ({
                  label: 'Stored',
                  value:
                    found.stored != null
                      ? tildeText(found.stored)
                      : found.storeFailure != null
                        ? `NOT STORED: ${found.storeFailure} (it is still in the open pane)`
                        : 'not stored (dry run)',
                })),
                {label: 'Why', value: entry.reasons.join('\n')},
              ],
              style,
            ),
            ...entry.drafts.map((found) => verbatim(found.text)),
          ].join('\n\n'),
        ),
      ),
    );
  }

  const closedTitle = state.dryRun ? 'Would close' : 'Closed';
  const closedEntries = state.dryRun ? state.planned : state.closed;
  blocks.push(
    header(
      `${closedTitle} (${closedEntries.length})`,
      state.dryRun ? '🔎' : '🧹',
    ),
  );
  blocks.push(
    closedEntries.length === 0
      ? prose('Nothing.')
      : spacedList(
          closedEntries.map((entry) =>
            block(
              entry.name,
              [
                {label: 'Session', value: entry.sessionId},
                {label: 'Workspace', value: entry.workspaceId},
                {
                  label: 'Claude',
                  value: claudeWords(entry.pids, !state.dryRun),
                },
              ],
              style,
            ),
          ),
        ),
  );

  if (keptOnly.length > 0) {
    blocks.push(header(`Kept (${keptOnly.length})`, '🛡️'));
    blocks.push(
      spacedList(
        keptOnly.map((entry) =>
          block(
            entry.name,
            [
              {label: 'Session', value: entry.sessionId},
              {label: 'Workspace', value: entry.workspaceId ?? 'unknown'},
              {label: 'Why', value: entry.reasons.join('\n')},
            ],
            style,
          ),
        ),
      ),
    );
  }

  if (state.gone.length > 0) {
    blocks.push(header(`Already gone (${state.gone.length})`, '👻'));
    blocks.push(
      spacedList(
        state.gone.map((entry) =>
          block(
            entry.name,
            [
              {label: 'Session', value: entry.sessionId},
              {
                label: 'Workspace',
                value: `${entry.workspaceId} (no longer open)`,
              },
            ],
            style,
          ),
        ),
      ),
    );
  }

  const failures = [
    ...state.failed.map((entry) => `${entry.name}: ${entry.reason}`),
    ...state.failures,
  ];
  if (failures.length > 0) {
    blocks.push(header(`Failed (${failures.length})`, '🛑'));
    blocks.push(spacedList(failures.map((text) => prose(`- ${text}`))));
  }

  if (state.windowsClosed.length > 0 || state.windowsLeft.length > 0) {
    blocks.push(header('Windows', '🪟'));
    blocks.push(
      spacedList([
        ...state.windowsClosed.map((id) =>
          prose(`${id}: closed with its last workspace.`),
        ),
        ...state.windowsLeft.map((entry) =>
          prose(`${entry.windowId}: still open, ${entry.reason}.`),
        ),
      ]),
    );
  }

  const keptWords = `kept ${state.kept.length}${withDraft.length > 0 ? ` (${withDraft.length} with unsent text)` : ''}`;
  const summary = state.dryRun
    ? `Would close ${state.planned.length}, ${keptWords}, already gone ${state.gone.length}. Run it again without --dry-run to close them.`
    : `Closed ${state.closed.length}, ${keptWords}, already gone ${state.gone.length}${state.failed.length > 0 ? `, failed ${state.failed.length}` : ''}.`;
  blocks.push(
    wrapHanging(paint(summary, ['bold'], style.color), {
      hang: HEADER_COLUMN,
      indent: HEADER_COLUMN,
      width: style.width,
    }),
  );
  return spacedList(blocks);
}

export async function undoOpen(
  options: UndoOptions,
  deps: Partial<UndoDeps> = {},
): Promise<UndoResult> {
  const env = options.env ?? process.env;
  const style = options.style ?? outputStyle(process.stdout);
  if (!options.undo) {
    return refuse('--run names the run to undo, so it only goes with --undo');
  }

  // ---- 1. the record: no cmux is needed to say there is nothing to undo ----
  const pick = pickRecord(env, options.run);
  if (pick.kind === 'failed') return refuse(pick.reason);
  if (pick.kind === 'none') {
    return {
      exitCode: 1,
      output: `thread open --undo: nothing to undo: ${pick.reason}.`,
      recordPath: null,
      state: null,
    };
  }
  const read = readRecord(pick.path);
  if (read.kind === 'failed') {
    return {
      exitCode: 1,
      output: `thread open --undo: ${read.reason}`,
      recordPath: pick.path,
      state: null,
    };
  }
  const recordAtMs = Date.parse(read.parsed.at);
  if (Number.isNaN(recordAtMs)) {
    return {
      exitCode: 1,
      output: `thread open --undo: the record ${tildeText(pick.path)} has no readable "at", so activity since the run cannot be judged`,
      recordPath: pick.path,
      state: null,
    };
  }
  const entries = recordedWorkspaces(read.parsed);

  // ---- 2. cmux: the socket, then a ping (respawn.ts rules) ----
  const socket = liveSocketPath(env);
  if ('reason' in socket) {
    return refuse(
      `cmux cannot be found: no CMUX_SOCKET_PATH, and ${socket.reason}`,
    );
  }
  const cmuxEnv = {...env, CMUX_QUIET: '1', CMUX_SOCKET_PATH: socket.path};
  const full: UndoDeps = {
    commandOf: deps.commandOf ?? realCommandOf,
    exitTimeoutMs: deps.exitTimeoutMs ?? UNDO_EXIT_TIMEOUT_MS,
    kill: deps.kill ?? realKill,
    nowMs: deps.nowMs ?? (() => Date.now()),
    ps: deps.ps ?? realProcessRunner(),
    readActivity:
      deps.readActivity ??
      (async (sessionId) => await realActivity(sessionId, env)),
    run: deps.run ?? realCmuxRunner(undefined, cmuxEnv),
    sleep:
      deps.sleep ??
      (async (ms) => {
        await new Promise((resolve) => setTimeout(resolve, ms));
      }),
    windowGoneTimeoutMs:
      deps.windowGoneTimeoutMs ?? UNDO_WINDOW_GONE_TIMEOUT_MS,
    writeDraft: deps.writeDraft ?? ((input) => writeInputDraft(input, env)),
    writeRecord:
      deps.writeRecord ?? ((path, value) => writeJsonFile(path, value, false)),
  };
  const ping = await full.run(['ping']);
  if (ping.kind === 'failed') {
    const allow = socketSettingsJson(socket.path).trim();
    return refuse(
      `cmux cannot be reached: ${ping.reason}\nIf this session is sandboxed, the sandbox blocks the cmux socket and ps: add ${allow} to your Claude Code user settings, or retry with the sandbox disabled.`,
    );
  }

  // ---- 3. the gates, read-only, for every workspace the run opened ----
  const first = await readView(full);
  if (first.kind === 'failed') {
    return refuse(
      `what is open now could not be read, so nothing is closed: ${first.reason}`,
    );
  }
  const startedAt = new Date(full.nowMs()).toISOString();
  const state: UndoState = {
    blank: [],
    closed: [],
    dryRun: options.dryRun,
    failed: [],
    failures: [],
    finishedAt: null,
    gone: [],
    kept: [],
    movedBack: [],
    notMovedBack: [],
    planned: [],
    startedAt,
    windowsClosed: [],
    windowsLeft: [],
  };
  const moves = read.parsed.moved ?? [];
  const closable: Extract<Assessment, {kind: 'closable'}>[] = [];
  for (const entry of entries) {
    const assessment = await assessWorkspace(
      entry,
      first.view,
      full,
      recordAtMs,
    );
    if (assessment.kind === 'gone') {
      state.gone.push({
        name: entry.name,
        sessionId: entry.sessionId,
        workspaceId: assessment.workspaceId,
      });
    } else if (assessment.kind === 'kept') {
      // D-DRAFTS: the text is stored the moment it is seen (not in a dry run).
      state.kept.push(
        keptOf(assessment, storeDrafts(assessment, full, options.dryRun)),
      );
    } else {
      closable.push(assessment);
      state.planned.push({
        name: entry.name,
        pids: assessment.claude.map((proc) => proc.pid),
        sessionId: entry.sessionId,
        workspaceId: assessment.workspaceId,
      });
    }
  }

  const finish = (exitCode: 0 | 1): UndoResult => ({
    exitCode,
    output: options.json
      ? JSON.stringify(
          {record: pick.path, stamp: pick.stamp, undo: state},
          null,
          2,
        )
      : renderUndo(state, {
          now: new Date(full.nowMs()),
          recordAt: read.parsed.at,
          recordPath: pick.path,
          style,
        }),
    recordPath: pick.path,
    state,
  });
  if (options.dryRun) {
    // yukaf.22: what would move back, read-only.
    await moveBack(moves, full, state, true, () => null);
    await closeLeftBlank(moves, full, state, true, () => null);
    return finish(0);
  }

  // ---- 4. the record, BEFORE the first SIGTERM: no record, no signal ----
  const previous = [
    ...(read.parsed.previousUndos ?? []),
    ...(read.parsed.undo == null ? [] : [read.parsed.undo]),
  ];
  const save = (): string | null =>
    full.writeRecord(pick.path, {
      ...read.raw,
      previousUndos: previous,
      undo: state,
    });
  const firstWrite = save();
  if (firstWrite != null) {
    state.failures.push(
      `the record ${tildeText(pick.path)} could not be rewritten before stopping anything, so nothing was signalled or closed: ${firstWrite}`,
    );
    for (const closing of closable) {
      state.kept.push({
        draft: null,
        drafts: [],
        name: closing.entry.name,
        reason: 'the record could not be written first',
        reasons: ['the record could not be written first'],
        sessionId: closing.entry.sessionId,
        workspaceId: closing.workspaceId,
      });
    }
    state.planned = [];
    state.finishedAt = new Date(full.nowMs()).toISOString();
    return finish(1);
  }

  // ---- 4b. yukaf.22: moved workspaces go back BEFORE anything closes ----
  if (!(await moveBack(moves, full, state, false, save))) {
    state.finishedAt = new Date(full.nowMs()).toISOString();
    return finish(1);
  }
  // G3: the blank workspace cmux left where a window's last one moved out.
  if (!(await closeLeftBlank(moves, full, state, false, save))) {
    state.finishedAt = new Date(full.nowMs()).toISOString();
    return finish(1);
  }
  // A window this run only moved workspaces into keeps a blank workspace
  // cmux makes when the last one moves out (scripts/CLAUDE.md, measured).
  for (const window of read.parsed.windows) {
    const id = window.windowId;
    if (id == null || window.workspaces.length > 0) continue;
    const backFromHere = moves.filter(
      (move) => move.toWindowId?.toUpperCase() === id.toUpperCase(),
    );
    const allBack = backFromHere.every((move) =>
      state.movedBack.some(
        (back) =>
          back.workspaceId.toUpperCase() === move.workspaceId.toUpperCase(),
      ),
    );
    if (backFromHere.length > 0 && allBack) {
      state.windowsLeft.push({
        reason: `this run only moved workspaces into it, and cmux leaves a blank workspace in a window whose last workspace moves out; close it with cmux close-window --window ${id}`,
        windowId: id,
      });
    }
  }

  // ---- 5. per workspace: the gates again, then SIGTERM, then close ----
  const closedIds = new Set<string>();
  const emptied = new Set<string>();
  let recordFailed = false;
  for (const planned of closable) {
    const again = await readView(full);
    const assessment =
      again.kind === 'read'
        ? await assessWorkspace(planned.entry, again.view, full, recordAtMs)
        : ({
            drafts: [],
            entry: planned.entry,
            kind: 'kept',
            reasons: [
              `what is open now could not be read again: ${again.reason}`,
            ],
          } satisfies Assessment);
    if (assessment.kind === 'gone') {
      state.gone.push({
        name: planned.entry.name,
        sessionId: planned.entry.sessionId,
        workspaceId: assessment.workspaceId,
      });
    } else if (assessment.kind === 'kept') {
      state.kept.push(keptOf(assessment, storeDrafts(assessment, full, false)));
    } else {
      const failure = await closeWorkspace(assessment, full);
      if (failure == null) {
        closedIds.add(assessment.workspaceId.toUpperCase());
        if (planned.entry.windowId != null) emptied.add(planned.entry.windowId);
        state.closed.push({
          closedAt: new Date(full.nowMs()).toISOString(),
          name: planned.entry.name,
          pids: assessment.claude.map((proc) => proc.pid),
          sessionId: planned.entry.sessionId,
          workspaceId: assessment.workspaceId,
        });
      } else {
        state.failed.push({
          name: planned.entry.name,
          reason: failure.reason,
          sessionId: planned.entry.sessionId,
          step: failure.step,
          workspaceId: assessment.workspaceId,
        });
      }
    }
    const rewrite = save();
    if (rewrite != null) {
      recordFailed = true;
      state.failures.push(
        `rewriting the record ${tildeText(pick.path)} failed, so the undo stopped: ${rewrite}`,
      );
      break;
    }
  }

  // ---- 6. a window closes with its last workspace: confirm it did ----
  const stillOurs = new Set(
    [...state.kept, ...state.failed]
      .map((entry) => entry.workspaceId?.toUpperCase())
      .filter((id): id is string => id != null),
  );
  const windowsToCheck = [...emptied].filter((windowId) =>
    entries.every(
      (entry) =>
        entry.windowId !== windowId ||
        entry.workspaceId == null ||
        !stillOurs.has(entry.workspaceId.toUpperCase()),
    ),
  );
  if (!recordFailed) {
    await verifyWindows(windowsToCheck, closedIds, full, state);
  }
  state.finishedAt = new Date(full.nowMs()).toISOString();
  if (!recordFailed && save() != null) {
    state.failures.push(
      `the final rewrite of the record ${tildeText(pick.path)} failed`,
    );
  }
  return finish(
    state.failures.length === 0 && state.failed.length === 0 ? 0 : 1,
  );
}

export async function runThreadUndo(options: UndoOptions): Promise<number> {
  const result = await undoOpen(options);
  if (result.exitCode === 2) {
    console.error(result.output);
    return result.exitCode;
  }
  await writeStdout(`${result.output}\n`);
  return result.exitCode;
}
