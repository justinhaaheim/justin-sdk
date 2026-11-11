/**
 * `thread close <workspace…>` (home-base-yukaf.31): close NAMED cmux
 * workspaces with the same gates as `thread open --undo`, recording a resume
 * command for each first. Serves request home-base-aasbl.26, "Get my cmux down
 * to only the sessions with unfinished work, without losing anything".
 *
 * Justin, 2026-10-17: "critically important that the whatever tooling we have
 * to close these windows checks first to make sure that there's not …
 * unsubmitted text in the … text input box." And 2026-10-20: "the most
 * reliable way for me to not lose work that I started but that didn't get
 * finished is to leave these panes open as a reminder".
 *
 * ONE IMPLEMENTATION of each part (AC 4):
 * - The gates are open-undo.ts `gateSurfaces` / `gatePane`, in their named
 *   mode (`sessionId: null`): a workspace closes only when every pane has an
 *   empty input box (a draft is stored with source 'close' and KEEPS the
 *   workspace), no working indicator, a readable screen, a known tty no other
 *   pane reports, a `⌗ <id>` line, and a claude process whose command line or
 *   hook-store entry names that id; a pane with no Claude closes only when it
 *   shows an idle shell with nothing running. At most one Claude session and
 *   one Claude process per workspace. The F6 scrollback read for a draft
 *   taller than the screen is part of gateSurfaces.
 * - D-UNDO-SAFETY's third gate (activity newer than the run) does NOT apply:
 *   a named close has no run, so there is no time to compare with. The draft
 *   gate and the second pass of the gates right before each SIGTERM cover
 *   use since the first pass.
 * - The stop-then-close is workspace-close.ts `stopThenCloseWorkspace`:
 *   re-identify the pid, SIGTERM (never -9), poll 250 ms for up to 15 s,
 *   then `close-workspace`.
 *
 * THE LOG, `<threadsStateDir>/closes.jsonl`, append-only (cmux-arrange's
 * closed.jsonl pattern): before the first SIGTERM of the run, one `closing`
 * line per workspace that passed the gates, carrying its resume command;
 * after each workspace, one more line with its outcome (`closed`,
 * `kept: <reason>` when the second pass kept it, `failed: <reason>`). Lines
 * of one run share `runAt`; the last line per workspace is its outcome. If
 * the `closing` lines cannot be written, nothing is signalled or closed.
 *
 * REFUSED (exit 2, nothing touched): no target, a target that is not a
 * workspace uuid or `workspace:N`, a target that is this command's own
 * workspace (CMUX_WORKSPACE_ID), cmux, ps or the hook store unreadable, and a
 * `--session` that no live process holds, that runs outside cmux, or that
 * shows in more than one workspace. Exit 1 when a step failed. Exit 0 when
 * done, kept workspaces included: keeping one is a normal outcome.
 *
 * D-NO-LIVE-RUNS: tests drive fake cmux, ps, kill and transcripts; against
 * the live machine only `--dry-run`, which writes nothing (no log line, no
 * draft).
 *
 * `--tab` and `--handed-off` (home-base-v8z8d.2.1, D1 to D6 in that bead's
 * design): close only the tab (cmux surface) holding each session, so a
 * handed-off session can be closed while its successor runs in the same
 * workspace. closeTabs branches off after the shared reads (steps 1 to 3);
 * resolveTab and assessTab prove the one tab (D2), the close is
 * `close-surface` with both ids (D3), an only tab takes the whole-workspace
 * path (D4), and closePlanned is the ONE implementation of the record, the
 * re-check and SIGTERM-wait-close for both paths (D6). Without --tab nothing
 * here runs, and output and JSON are as before. `--tab` is refused (exit 2)
 * when CMUX_WORKSPACE_ID is set and CMUX_SURFACE_ID is not, and an only tab
 * in the command's own workspace is kept (home-base-hg6lz.4 R1).
 */

import type {OutputStyle} from '../cli-style';
import type {RepoResolution} from '../repo-status/sessions';
import type {CmuxRunner, CmuxTree} from './cmux';
import type {InputDraftWrite, WriteInputDraftInput} from './input-drafts';
import type {LiveSessions} from './live-sessions';
import type {
  GateSuggestion,
  HookStorePids,
  LiveView,
  UndoDraft,
} from './open-undo';
import type {HookStore, Proc, ProcessRunner, SourceRead} from './pane-join';
import type {EnvLike} from './paths';
import type {
  PidCommand,
  StopAndCloseFailure,
  StopAndCloseSurfaceFailure,
} from './workspace-close';

import {appendFileSync, mkdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename, dirname, join} from 'node:path';

import {brList, describeBrFailed} from '../beads/br';
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
import {resolveRepoRoot} from '../repo-status/sessions';
import {writeStdout} from '../write-stdout';
import {readCmuxTree, realCmuxRunner, surfacesOfWorkspace} from './cmux';
import {findTranscript} from './facts';
import {writeInputDraft} from './input-drafts';
import {
  argvSessionId,
  isSessionProc,
  readLiveSessions,
  realLiveSessionDeps,
} from './live-sessions';
import {locateWorkspace} from './open';
import {
  gateSurfaces,
  hookStorePids,
  readView,
  suggestionFields,
  UNDO_EXIT_TIMEOUT_MS,
  UNDO_WINDOW_GONE_TIMEOUT_MS,
} from './open-undo';
import {
  defaultHookStorePath,
  normalizeTty,
  readHookStore,
  readScreen,
  realProcessRunner,
  statusLineIdOf,
} from './pane-join';
import {tildeText} from './part-one';
import {threadsStateDir} from './paths';
import {liveSocketPath, socketSettingsJson} from './respawn';
import {
  CONTINUED_BY_LABEL_PREFIX,
  HANDED_OFF_LABEL,
  SESSION_LABEL,
  SID_LABEL_PREFIX,
} from './session-bead';
import {extractTranscriptMessages} from './transcript-messages';
import {
  realPidCommand,
  realSigterm,
  stopThenCloseSurface,
  stopThenCloseWorkspace,
} from './workspace-close';

const POLL_MS = 250;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const WORKSPACE_REF = /^workspace:\d+$/iu;

/** `<threadsStateDir>/closes.jsonl`: one line per workspace and step. */
export function closesLogPath(env: EnvLike): string {
  return join(threadsStateDir(env), 'closes.jsonl');
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One line of closes.jsonl. */
export interface CloseLogLine {
  /** When this line was written. */
  at: string;
  /** The directory the resume command cds to; null when no session ran there. */
  checkout: string | null;
  /** `closing` · `closed` · `kept: <reason>` · `failed: <reason>`. */
  outcome: string;
  /** The Claude process stopped first; null when none ran there. */
  pid: number | null;
  repo: string | null;
  /** `cd '<checkout>' && claude --resume <id>`; null when no session ran there. */
  resumeCommand: string | null;
  /** When this run of thread close started: groups the lines of one run. */
  runAt: string;
  sessionId: string | null;
  /** `--tab` only (home-base-v8z8d.2.1): the tab closed; absent otherwise. */
  surfaceId?: string;
  title: string | null;
  windowId: string;
  workspaceId: string;
}

/**
 * `--tab` (home-base-v8z8d.2.1): the one tab a session runs in. Absent on a
 * whole-workspace entry, so that output and JSON stay as they were.
 */
export interface CloseTab {
  /** D4: it is its workspace's only tab, so the whole workspace closes. */
  onlyTab: boolean;
  /** How many other tabs the workspace holds; they stay open. */
  siblings: number;
  surfaceId: string;
  surfaceRef: string | null;
}

/** `--handed-off` (D5): one session it selected. */
export interface HandedOffPick {
  beadId: string;
  sessionId: string;
  /** The `continued-by:` bead(s): the session that picked it up. */
  successor: string;
  title: string;
}

/** `--handed-off` (D5): what it selected, and each handed-off bead it did not, with why. */
export interface HandedOffSelection {
  selected: HandedOffPick[];
  skipped: {beadId: string; reason: string; title: string}[];
}

/** The handed-off session beads (`session` + `handed-off` labels), or why they could not be read. */
export type HandedOffRead =
  | {beads: {id: string; labels: string[]; title: string}[]; kind: 'read'}
  | {kind: 'failed'; reason: string};

/** Where a session resumes from, read from its transcript, or why not. */
export type ResumeLookup =
  | {
      checkout: string;
      command: string;
      kind: 'found';
      repo: string | null;
      /** Set when the transcript's directory could not be confirmed. */
      warning: string | null;
    }
  | {kind: 'unknown'; reason: string};

/** One workspace: what it is, and how to resume what ran there. */
export interface CloseEntry {
  checkout: string | null;
  /** How it was named on the command line (uuid, workspace:N, --session id). */
  given: string[];
  pid: number | null;
  repo: string | null;
  resumeCommand: string | null;
  /** Why there is no resume command, or what is unsure about it; null when nothing. */
  resumeNote: string | null;
  sessionId: string | null;
  /**
   * home-base-yukaf.36 D3: panes whose input box showed only Claude Code's
   * prompt suggestion. Check 1 passed them as empty; the output names each.
   */
  suggestions: GateSuggestion[];
  /** `--tab` only: the session's tab. Absent on a whole-workspace entry. */
  tab?: CloseTab;
  title: string | null;
  /** Whether closing it closes its window too (it is the window's last workspace). */
  windowAlone: boolean;
  windowId: string;
  windowRef: string;
  workspaceId: string;
  workspaceRef: string | null;
}

export interface CloseKept extends CloseEntry {
  drafts: UndoDraft[];
  reasons: string[];
}

export interface CloseClosed extends CloseEntry {
  closedAt: string;
  /** What happened to its window, in words. */
  windowNote: string;
}

export interface CloseFailed extends CloseEntry {
  reason: string;
  step: string;
}

export interface CloseNotFound {
  given: string[];
  reason: string;
}

export interface CloseState {
  closed: CloseClosed[];
  dryRun: boolean;
  failed: CloseFailed[];
  /** Steps that failed outside any one workspace (the log, a draft store). */
  failures: string[];
  finishedAt: string | null;
  kept: CloseKept[];
  logPath: string;
  notFound: CloseNotFound[];
  /** What passed the first pass of the gates, in order. */
  planned: CloseEntry[];
  /** `--handed-off` only (D5): what it selected. */
  selection?: HandedOffSelection;
  startedAt: string;
  /** `--tab` only: the run closes tabs, not workspaces. */
  tabMode?: true;
  /**
   * `--tab` only (D2): sessions kept because their one tab could not be
   * proven (a shared terminal, two processes, more than one workspace, …).
   */
  unresolved?: CloseNotFound[];
}

export interface CloseOptions {
  dryRun: boolean;
  env?: EnvLike;
  /**
   * `--handed-off` (home-base-v8z8d.2.1 D5): add every live session whose
   * session bead has `handed-off` and `continued-by:`, as if each were named
   * with --session.
   */
  handedOff?: boolean;
  json: boolean;
  /** `--session <id>`: each resolves to the one workspace that holds it. */
  sessions: readonly string[];
  style?: OutputStyle;
  /**
   * `--tab` (home-base-v8z8d.2.1 D1): close only the tab holding each session,
   * with close-surface, and leave its workspace and other tabs open.
   */
  tab?: boolean;
  /** Workspace uuids or `workspace:N` refs. */
  workspaces: readonly string[];
}

export interface CloseDeps {
  /** Append one line to closes.jsonl: null when written, else why not. */
  appendLog: (line: CloseLogLine) => string | null;
  commandOf: (pid: number) => Promise<PidCommand>;
  exitTimeoutMs: number;
  /** SIGTERM, never anything stronger: null when sent, else why not. */
  kill: (pid: number) => string | null;
  nowMs: () => number;
  ps: ProcessRunner;
  /** `--handed-off` only: the handed-off session beads of this repo. */
  readHandedOff: () => HandedOffRead;
  readHookStore: () => SourceRead<HookStore>;
  /** The live sessions (readLiveSessions), read only when --session is given. */
  readLive: () => Promise<LiveSessions>;
  resumeOf: (sessionId: string) => ResumeLookup;
  run: CmuxRunner;
  sleep: (ms: number) => Promise<void>;
  windowGoneTimeoutMs: number;
  writeDraft: (input: WriteInputDraftInput) => InputDraftWrite;
}

/** 0 done (kept included) or dry run · 1 a step failed · 2 refused, nothing touched. */
export interface CloseResult {
  exitCode: 0 | 1 | 2;
  output: string;
  state: CloseState | null;
}

// ---------------------------------------------------------------------------
// The real dependencies
// ---------------------------------------------------------------------------

/** The transcript's own resume command (buildResumeCommand, K4) and its repo. */
function realResumeOf(
  sessionId: string,
  env: EnvLike,
  cache: Map<string, RepoResolution>,
): ResumeLookup {
  const found = findTranscript(sessionId, env);
  if (found.status === 'failed') {
    return {
      kind: 'unknown',
      reason: `the transcripts could not be searched: ${found.error}`,
    };
  }
  if (found.status === 'not-found') {
    return {
      kind: 'unknown',
      reason: `no transcript ${sessionId}.jsonl under ${tildeText(found.searched)}`,
    };
  }
  let messages: ReturnType<typeof extractTranscriptMessages>;
  try {
    messages = extractTranscriptMessages(found.path);
  } catch (error) {
    return {
      kind: 'unknown',
      reason: `its transcript ${tildeText(found.path)} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const note =
    messages.failures.find((failure) => failure.startsWith('resumeCommand')) ??
    null;
  if (messages.resumeCommand == null || messages.resumeCwd == null) {
    return {
      kind: 'unknown',
      reason:
        note ??
        `no record of ${tildeText(found.path)} names a working directory`,
    };
  }
  const root = resolveRepoRoot(messages.resumeCwd, cache).root;
  return {
    checkout: messages.resumeCwd,
    command: messages.resumeCommand,
    kind: 'found',
    repo: root == null ? null : basename(root),
    warning: note,
  };
}

function realAppendLog(path: string): (line: CloseLogLine) => string | null {
  return (line) => {
    try {
      mkdirSync(dirname(path), {recursive: true});
      appendFileSync(path, `${JSON.stringify(line)}\n`);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
}

/**
 * D5: the session beads of the repo this runs in that carry `handed-off`,
 * closed ones included (a closed bead's Claude may still run). A failed read
 * is a failure, never "none" (critical rule 7).
 */
function realReadHandedOff(cwd: string, env: EnvLike): HandedOffRead {
  const listed = brList(
    {cwd, env},
    {all: true, labels: [SESSION_LABEL, HANDED_OFF_LABEL]},
  );
  if (listed.kind === 'failed') {
    return {kind: 'failed', reason: describeBrFailed(listed)};
  }
  return {
    beads: listed.issues.map((issue) => ({
      id: issue.id,
      labels: issue.labels,
      title: issue.title,
    })),
    kind: 'read',
  };
}

/**
 * D5: a handed-off bead is selected only when a successor picked it up
 * (`continued-by:`), it names exactly one session (`sid:`), and a live Claude
 * process holds that session. Everything else is listed as skipped, with why.
 */
export function selectHandedOff(
  beads: readonly {id: string; labels: readonly string[]; title: string}[],
  isLive: (sessionId: string) => boolean,
): HandedOffSelection {
  const selected: HandedOffPick[] = [];
  const skipped: HandedOffSelection['skipped'] = [];
  for (const bead of beads) {
    if (!bead.labels.includes(HANDED_OFF_LABEL)) continue;
    const skip = (reason: string): void => {
      skipped.push({beadId: bead.id, reason, title: bead.title});
    };
    const successors = bead.labels
      .filter((label) => label.startsWith(CONTINUED_BY_LABEL_PREFIX))
      .map((label) => label.slice(CONTINUED_BY_LABEL_PREFIX.length));
    if (successors.length === 0) {
      skip('no successor picked it up (no continued-by: label)');
      continue;
    }
    const sids = bead.labels
      .filter((label) => label.startsWith(SID_LABEL_PREFIX))
      .map((label) => label.slice(SID_LABEL_PREFIX.length).toLowerCase());
    const [only] = sids;
    if (only == null || sids.length > 1) {
      skip(`it names ${sids.length} sessions (sid: labels), not one`);
      continue;
    }
    if (!isLive(only)) {
      skip('no live Claude process holds its session');
      continue;
    }
    if (selected.some((pick) => pick.sessionId === only)) continue;
    selected.push({
      beadId: bead.id,
      sessionId: only,
      successor: successors.join(', '),
      title: bead.title,
    });
  }
  return {selected, skipped};
}

// ---------------------------------------------------------------------------
// Resolving the targets
// ---------------------------------------------------------------------------

interface Resolved {
  given: string[];
  workspaceId: string;
}

function refuse(text: string): CloseResult {
  return {
    exitCode: 2,
    output: `thread close: refused, nothing was closed: ${text}`,
    state: null,
  };
}

/** The workspace a uuid or `workspace:N` names in the tree, or null. */
function findInTree(tree: CmuxTree, given: string): string | null {
  const want = given.toUpperCase();
  for (const window of tree.windows) {
    for (const workspace of window.workspaces) {
      if (
        workspace.id.toUpperCase() === want ||
        workspace.ref?.toUpperCase() === want
      ) {
        return workspace.id;
      }
    }
  }
  return null;
}

/** A --session id → its one workspace, or why that cannot be told. */
function sessionWorkspace(
  live: Extract<LiveSessions, {kind: 'read'}>,
  sessionId: string,
): {kind: 'found'; workspaceId: string} | {kind: 'refused'; reason: string} {
  const key = sessionId.toLowerCase();
  const found = live.bySessionId.get(key);
  if (found == null) {
    return {
      kind: 'refused',
      reason: `--session ${sessionId}: no live Claude process for that session was found (ps, the cmux hook store, the panes' ⌗ lines and claude agents --json were read)`,
    };
  }
  const workspaces = live.workspacesBySessionId.get(key) ?? [];
  const [only] = workspaces;
  if (only == null) {
    return {
      kind: 'refused',
      reason: `--session ${sessionId}: it runs outside any cmux workspace${found.pid == null ? '' : ` (pid ${found.pid})`}, so there is no workspace to close`,
    };
  }
  if (workspaces.length > 1) {
    return {
      kind: 'refused',
      reason: `--session ${sessionId}: it shows in ${workspaces.length} workspaces (${workspaces.join(', ')}), so which one to close cannot be told; name the workspace instead`,
    };
  }
  return {kind: 'found', workspaceId: only};
}

// ---------------------------------------------------------------------------
// Assessing one workspace (read-only)
// ---------------------------------------------------------------------------

type Assessment =
  | {
      claude: Proc[];
      entry: CloseEntry;
      kind: 'closable';
      sessions: string[];
    }
  | {
      drafts: {sessionId: string | null; surfaceId: string; text: string}[];
      entry: CloseEntry;
      kind: 'kept';
      reasons: string[];
    }
  | {kind: 'notFound'; reason: string};

/**
 * `onlySurface` (`--tab`, home-base-v8z8d.2.1 D2): gate that one surface and
 * no other; null (every caller without --tab) gates every surface, as before.
 */
async function assess(
  target: Resolved,
  view: LiveView,
  hookPids: HookStorePids,
  deps: Pick<CloseDeps, 'resumeOf' | 'run'>,
  onlySurface: string | null = null,
): Promise<Assessment> {
  const at = locateWorkspace(view.tree, target.workspaceId);
  const surfaceIds = surfacesOfWorkspace(view.tree, target.workspaceId);
  const workspace = view.tree.windows
    .flatMap((window) => window.workspaces)
    .find(
      (entry) => entry.id.toUpperCase() === target.workspaceId.toUpperCase(),
    );
  if (at == null || surfaceIds == null || workspace == null) {
    return {kind: 'notFound', reason: 'it is not open in cmux now'};
  }
  // One implementation of the gates: open-undo.ts, in its named mode.
  const gate = await gateSurfaces(
    onlySurface == null ? surfaceIds : [onlySurface],
    view,
    deps.run,
    null,
    hookPids,
  );
  const [sessionId] = gate.sessions.length === 1 ? gate.sessions : [];
  const reasons = [...gate.reasons];
  let resume: ResumeLookup | null = null;
  if (sessionId != null) {
    resume = deps.resumeOf(sessionId);
    if (resume.kind === 'unknown') {
      reasons.push(
        `no resume command could be built for session ${sessionId} (${resume.reason}), so closing it could not be undone by hand`,
      );
    }
  }
  const pids = [...new Set(gate.claude.map((proc) => proc.pid))];
  const entry: CloseEntry = {
    checkout: resume?.kind === 'found' ? resume.checkout : null,
    given: target.given,
    pid: pids.length === 1 ? (pids[0] ?? null) : null,
    repo: resume?.kind === 'found' ? resume.repo : null,
    resumeCommand: resume?.kind === 'found' ? resume.command : null,
    resumeNote:
      resume == null
        ? null
        : resume.kind === 'found'
          ? resume.warning
          : resume.reason,
    sessionId: sessionId ?? null,
    suggestions: gate.suggestions,
    title: workspace.title,
    windowAlone: at.count === 1,
    windowId: at.windowId,
    windowRef: at.windowRef,
    workspaceId: workspace.id,
    workspaceRef: workspace.ref,
  };
  if (reasons.length > 0) {
    return {drafts: gate.drafts, entry, kind: 'kept', reasons};
  }
  return {
    claude: gate.claude,
    entry,
    kind: 'closable',
    sessions: gate.sessions,
  };
}

/** Store every draft of a kept workspace (D-DRAFTS, source 'close'); a dry run stores none. */
function storeDrafts(
  assessment: Extract<Assessment, {kind: 'kept'}>,
  deps: Pick<CloseDeps, 'nowMs' | 'writeDraft'>,
  dryRun: boolean,
  failures: string[],
): UndoDraft[] {
  return assessment.drafts.map((found) => {
    if (dryRun) return {...found, storeFailure: null, stored: null};
    if (found.sessionId == null) {
      // F19: no ⌗ line, so no session to file it under; it stays on screen.
      return {
        ...found,
        storeFailure:
          'its input box shows no "⌗ <session id>" line, so there is no session to file it under',
        stored: null,
      };
    }
    const written = deps.writeDraft({
      at: new Date(deps.nowMs()).toISOString(),
      sessionId: found.sessionId,
      source: 'close',
      surfaceId: found.surfaceId,
      text: found.text,
      workspaceId: assessment.entry.workspaceId,
    });
    if (written.kind === 'written') {
      return {...found, storeFailure: null, stored: written.path};
    }
    failures.push(
      `the unsent text in ${assessment.entry.workspaceRef ?? assessment.entry.workspaceId} could not be stored: ${written.reason} (it is still in the open pane)`,
    );
    return {...found, storeFailure: written.reason, stored: null};
  });
}

function keptOf(
  assessment: Extract<Assessment, {kind: 'kept'}>,
  drafts: UndoDraft[],
): CloseKept {
  return {...assessment.entry, drafts, reasons: assessment.reasons};
}

function logLine(
  entry: CloseEntry,
  outcome: string,
  runAt: string,
  nowMs: number,
): CloseLogLine {
  return {
    at: new Date(nowMs).toISOString(),
    checkout: entry.checkout,
    outcome,
    pid: entry.pid,
    repo: entry.repo,
    resumeCommand: entry.resumeCommand,
    runAt,
    sessionId: entry.sessionId,
    // --tab only (D6): which tab; a whole-workspace line is unchanged.
    ...(entry.tab == null ? {} : {surfaceId: entry.tab.surfaceId}),
    title: entry.title,
    windowId: entry.windowId,
    workspaceId: entry.workspaceId,
  };
}

/** After closing a window's last workspace: did cmux close the window? */
async function windowNoteAfterClose(
  entry: CloseEntry,
  deps: Pick<CloseDeps, 'nowMs' | 'run' | 'sleep' | 'windowGoneTimeoutMs'>,
): Promise<string> {
  if (!entry.windowAlone) {
    return 'its window stays open with its other workspaces';
  }
  const deadline = deps.nowMs() + deps.windowGoneTimeoutMs;
  for (;;) {
    const tree = await readCmuxTree(deps.run);
    if (tree.kind !== 'read') {
      return `it was its window's last workspace; whether the window closed could not be checked: ${tree.reason}`;
    }
    const open = tree.tree.windows.some(
      (window) => window.id.toUpperCase() === entry.windowId.toUpperCase(),
    );
    if (!open) return 'its window closed with its last workspace';
    if (deps.nowMs() >= deadline) {
      return `it was its window's last workspace, but cmux still lists the window ${Math.round(deps.windowGoneTimeoutMs / 1000)} s later`;
    }
    await deps.sleep(POLL_MS);
  }
}

// ---------------------------------------------------------------------------
// --tab (home-base-v8z8d.2.1): one tab, not its workspace
// ---------------------------------------------------------------------------

/** A session's one tab, as D2 proved it from one read of ps, the hook store and cmux. */
interface TabTarget {
  given: string[];
  /** The one claude process that names the session. */
  pid: number;
  sessionId: string;
  surfaceId: string;
  surfaceRef: string;
  workspaceId: string;
}

/**
 * D3: the close-surface call with both ids explicit, or why it cannot be
 * made. cmux's own `--surface` is optional (cmux 0.64.x), so a missing or
 * malformed id must never reach it: cmux would act on some default tab.
 */
export function closeSurfaceArgs(
  surfaceId: string | null | undefined,
  workspaceId: string | null | undefined,
): {args: string[]; kind: 'ok'} | {kind: 'refused'; reason: string} {
  if (surfaceId == null || !UUID.test(surfaceId)) {
    return {
      kind: 'refused',
      reason: `its tab's surface id ${JSON.stringify(surfaceId ?? null)} is not a uuid, so close-surface could act on another tab`,
    };
  }
  if (workspaceId == null || !UUID.test(workspaceId)) {
    return {
      kind: 'refused',
      reason: `its workspace id ${JSON.stringify(workspaceId ?? null)} is not a uuid, so close-surface could act on another workspace`,
    };
  }
  return {
    args: ['close-surface', '--surface', surfaceId, '--workspace', workspaceId],
    kind: 'ok',
  };
}

type TabResolution =
  | {kind: 'notLive'; reason: string}
  | {kind: 'tab'; target: TabTarget}
  | {kind: 'unresolved'; reason: string};

/**
 * D2, the identity half: the one tab that holds `sessionId`, or why it
 * cannot be told. Exactly one live workspace, exactly one claude process
 * naming the session (command line or hook store), and that process's
 * terminal on exactly one tab, in that workspace. The bead's cmux-surface
 * label is never read: it is a pointer, not proof. The screen half (the tab's
 * own ⌗ line, and no other tab showing it) is assessTab's.
 */
function resolveTab(
  sessionId: string,
  given: string[],
  view: LiveView,
  hookPids: HookStorePids,
  live: Extract<LiveSessions, {kind: 'read'}>,
  ownSurface: string | null,
): TabResolution {
  const key = sessionId.toLowerCase();
  const unresolved = (reason: string): TabResolution => ({
    kind: 'unresolved',
    reason,
  });
  if (!live.bySessionId.has(key)) {
    return {
      kind: 'notLive',
      reason:
        "no live Claude process for that session was found (ps, the cmux hook store, the panes' ⌗ lines and claude agents --json were read)",
    };
  }
  const workspaces = live.workspacesBySessionId.get(key) ?? [];
  const [workspaceId] = workspaces;
  if (workspaceId == null) {
    return unresolved(
      'it runs outside any cmux workspace, so there is no tab to close',
    );
  }
  if (workspaces.length > 1) {
    return unresolved(
      `it shows in ${workspaces.length} workspaces (${workspaces.join(', ')}), so which tab holds it cannot be told`,
    );
  }
  const naming = [
    ...new Map(
      view.procs
        .filter(
          (proc) =>
            isSessionProc(proc) &&
            (argvSessionId(proc.command) === key ||
              hookPids.get(key)?.has(proc.pid) === true),
        )
        .map((proc) => [proc.pid, proc]),
    ).values(),
  ];
  const [proc] = naming;
  if (proc == null) {
    return unresolved(
      'no claude process names it on its command line or in the cmux hook store, so which process to stop cannot be told',
    );
  }
  if (naming.length > 1) {
    return unresolved(
      `${naming.length} claude processes name it (pid ${naming.map((each) => each.pid).join(', ')}), so which one to stop cannot be told`,
    );
  }
  const tty = normalizeTty(proc.tty);
  if (tty == null) {
    return unresolved(
      `its claude process (pid ${proc.pid}) has no known terminal, so its tab cannot be found`,
    );
  }
  const onTty = view.surfaces.filter(
    (surface) => normalizeTty(surface.tty) === tty,
  );
  const [surface] = onTty;
  if (surface == null) {
    return unresolved(
      `no cmux tab reports its terminal ${tty} (pid ${proc.pid})`,
    );
  }
  if (onTty.length > 1) {
    return unresolved(
      `${onTty.length} tabs report its terminal ${tty} (${onTty.map((each) => each.ref).join(', ')}), so which tab holds it cannot be told`,
    );
  }
  if ((surface.workspaceId ?? '').toUpperCase() !== workspaceId.toUpperCase()) {
    return unresolved(
      `its terminal ${tty} is on ${surface.ref} in workspace ${surface.workspaceId ?? 'unknown'}, not in ${workspaceId}, where it was seen`,
    );
  }
  const surfaceId = surface.id ?? null;
  const ids = closeSurfaceArgs(surfaceId, workspaceId);
  if (surfaceId == null || ids.kind === 'refused') {
    return unresolved(
      ids.kind === 'refused' ? ids.reason : 'its tab has no surface id',
    );
  }
  const placed = live.bySessionId.get(key)?.surfaceId ?? null;
  if (placed != null && placed.toUpperCase() !== surfaceId.toUpperCase()) {
    return unresolved(
      `the live sessions place it on tab ${placed}, but its process's terminal is on ${surface.ref}`,
    );
  }
  if (ownSurface != null && surfaceId.toUpperCase() === ownSurface) {
    return unresolved(
      "it is this command's own tab (CMUX_SURFACE_ID): closing it would stop this command",
    );
  }
  return {
    kind: 'tab',
    target: {
      given,
      pid: proc.pid,
      sessionId: key,
      surfaceId,
      surfaceRef: surface.ref,
      workspaceId,
    },
  };
}

/**
 * D2, the screen half, and D4. The tab's own pane gets every per-pane check
 * (nothing typed, Claude not working, a readable screen, a terminal no other
 * pane reports, a ⌗ line its process names); its ⌗ line must show the
 * requested session, and its claude process must be the one that names it.
 * The workspace's other tabs are only read, to prove none shows the session
 * too; they are never gated, signalled or closed. When it is the workspace's
 * only tab (D4), today's whole-workspace checks run instead, and closing it
 * closes the workspace, so an only tab in this command's own workspace
 * (`ownWorkspace`, CMUX_WORKSPACE_ID upper-cased) is kept, as the
 * whole-workspace path refuses that workspace (home-base-hg6lz.4 R1).
 */
async function assessTab(
  target: TabTarget,
  view: LiveView,
  hookPids: HookStorePids,
  deps: Pick<CloseDeps, 'resumeOf' | 'run'>,
  ownWorkspace: string | null,
): Promise<Assessment> {
  const surfaceIds = surfacesOfWorkspace(view.tree, target.workspaceId);
  if (surfaceIds == null) {
    return {kind: 'notFound', reason: 'its workspace is not open in cmux now'};
  }
  const same = (id: string): boolean =>
    id.toUpperCase() === target.surfaceId.toUpperCase();
  if (!surfaceIds.some(same)) {
    return {
      kind: 'notFound',
      reason: `its tab ${target.surfaceRef} is not open in cmux now`,
    };
  }
  const onlyTab = surfaceIds.length === 1;
  const base = await assess(
    {given: target.given, workspaceId: target.workspaceId},
    view,
    hookPids,
    deps,
    onlyTab ? null : target.surfaceId,
  );
  if (base.kind === 'notFound') return base;
  const reasons = base.kind === 'kept' ? [...base.reasons] : [];
  if (
    onlyTab &&
    ownWorkspace != null &&
    target.workspaceId.toUpperCase() === ownWorkspace
  ) {
    reasons.push(
      `it is the only tab of this command's own workspace (CMUX_WORKSPACE_ID ${ownWorkspace}): closing it would close the terminal this runs in`,
    );
  }
  const shown = base.entry.sessionId;
  if (shown != null && shown.toLowerCase() !== target.sessionId) {
    reasons.push(
      `${target.surfaceRef} shows session ${shown}, not ${target.sessionId}`,
    );
  }
  const pids =
    base.kind === 'closable'
      ? [...new Set(base.claude.map((proc) => proc.pid))]
      : base.entry.pid == null
        ? []
        : [base.entry.pid];
  if (pids.some((pid) => pid !== target.pid)) {
    reasons.push(
      `the claude process on ${target.surfaceRef} is pid ${pids.join(', ')}, not pid ${target.pid}, the one that names session ${target.sessionId}`,
    );
  }
  if (!onlyTab) {
    for (const other of surfaceIds.filter((id) => !same(id))) {
      const surface = view.surfaces.find(
        (candidate) => candidate.id?.toUpperCase() === other.toUpperCase(),
      );
      const ref = surface?.ref ?? other;
      const screen = await readScreen(deps.run, ref);
      if (screen.kind === 'unreadable') {
        reasons.push(
          `the screen of the other tab ${ref} could not be read (${screen.reason}), so that it does not show session ${target.sessionId} too cannot be proven`,
        );
      } else if (
        statusLineIdOf(screen.text)?.toLowerCase() === target.sessionId
      ) {
        reasons.push(
          `the other tab ${ref} shows session ${target.sessionId} too, so which tab holds it cannot be told`,
        );
      }
    }
  }
  const entry: CloseEntry = {
    ...base.entry,
    tab: {
      onlyTab,
      siblings: surfaceIds.length - 1,
      surfaceId: target.surfaceId,
      surfaceRef: target.surfaceRef,
    },
  };
  if (base.kind === 'kept' || reasons.length > 0) {
    return {
      drafts: base.kind === 'kept' ? base.drafts : [],
      entry,
      kind: 'kept',
      reasons,
    };
  }
  return {...base, entry};
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const LABELS = [
  'Title',
  'Repo',
  'Session',
  'Resume',
  'Window',
  'Workspace',
  'Claude',
  'Input box',
  'Stored',
  'Why',
].map((label) => ({label, value: ''}));

function block(
  heading: string,
  fields: {label: string; value: string}[],
  style: OutputStyle,
): string {
  return [
    wrapHanging(paint(heading, ['bold'], style.color), {
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

function headingOf(entry: CloseEntry): string {
  const workspace =
    entry.workspaceRef == null
      ? entry.workspaceId
      : `${entry.workspaceRef} (${entry.workspaceId})`;
  if (entry.tab == null) return workspace;
  return `${entry.tab.surfaceRef ?? 'tab'} (${entry.tab.surfaceId}) in ${workspace}`;
}

/** `--tab` only: what closing the tab does to its workspace. */
function tabWords(tab: CloseTab): string {
  if (tab.onlyTab) {
    return 'the only tab in its workspace, so the whole workspace closes with it (D4)';
  }
  return tab.siblings === 1
    ? 'only this tab; the workspace stays open with its other tab, which is not signalled'
    : `only this tab; the workspace stays open with its other ${tab.siblings} tabs, which are not signalled`;
}

function resumeWords(entry: CloseEntry): string {
  if (entry.resumeCommand != null) {
    return entry.resumeNote == null
      ? entry.resumeCommand
      : `${entry.resumeCommand}\n(unsure: ${entry.resumeNote})`;
  }
  if (entry.sessionId == null) return 'none: no Claude session runs there';
  return `unknown: ${entry.resumeNote ?? 'no resume command could be built'}`;
}

function sessionWords(entry: CloseEntry): string {
  if (entry.sessionId != null) return entry.sessionId;
  return entry.pid == null ? 'none' : 'cannot tell';
}

/**
 * The fields every record carries, in order (Title, Repo, Session, Resume,
 * Window), then "Input box" when a pane showed Claude Code's suggestion
 * (yukaf.36 D3).
 */
function baseFields(
  entry: CloseEntry,
  windowExtra: string | null,
): {label: string; value: string}[] {
  return [
    {label: 'Title', value: entry.title ?? '(untitled)'},
    {label: 'Repo', value: entry.repo ?? 'unknown'},
    {label: 'Session', value: sessionWords(entry)},
    {label: 'Resume', value: resumeWords(entry)},
    {
      label: 'Window',
      value: `${entry.windowRef} (${entry.windowId})${windowExtra == null ? '' : `; ${windowExtra}`}`,
    },
    ...(entry.tab == null ? [] : [{label: 'Tab', value: tabWords(entry.tab)}]),
    ...suggestionFields(entry.suggestions),
  ];
}

function claudeWords(pid: number | null, done: boolean): string {
  if (pid == null) {
    return 'no Claude process runs there, so none is stopped';
  }
  return `${done ? 'stopped' : 'would be stopped'} with SIGTERM first (pid ${pid})`;
}

export function renderClose(state: CloseState, style: OutputStyle): string {
  const header = (text: string, emoji: string): string =>
    sectionHeader(text, {color: style.color, emoji});
  const prose = (text: string): string =>
    wrapHanging(text, {
      hang: BODY_COLUMN,
      indent: BODY_COLUMN,
      width: style.width,
    });
  const blocks: string[] = [];
  const tabMode = state.tabMode === true;
  blocks.push(
    header(
      tabMode
        ? 'thread close --tab: close the tabs of named Claude sessions'
        : 'thread close: close named cmux workspaces',
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
        {
          label: 'Gates',
          value:
            "an empty input box (one showing only Claude Code's suggestion counts as empty), Claude not working, a readable screen, a known tty, one Claude session and process that its ⌗ line names (else kept)",
        },
        ...(tabMode
          ? [
              {
                label: 'Tab',
                value:
                  "one workspace, one claude process naming the session, its terminal on that one tab and on no other, the tab's ⌗ line showing that session, and no other tab showing it (else kept); only that tab's pane is gated, signalled and closed",
              },
            ]
          : []),
        {label: 'Log', value: tildeText(state.logPath)},
      ],
      {color: style.color, indent: BODY_COLUMN, width: style.width},
    ),
  );

  if (state.selection != null) {
    const {selected, skipped} = state.selection;
    blocks.push(header(`Selected by --handed-off (${selected.length})`, '🤝'));
    blocks.push(
      selected.length === 0
        ? prose('Nothing.')
        : spacedList(
            selected.map((pick) =>
              block(
                `--session ${pick.sessionId}`,
                [
                  {label: 'Title', value: pick.title},
                  {label: 'Bead', value: pick.beadId},
                  {label: 'Successor', value: pick.successor},
                ],
                style,
              ),
            ),
          ),
    );
    if (skipped.length > 0) {
      const counts = new Map<string, number>();
      for (const entry of skipped) {
        counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1);
      }
      blocks.push(
        prose(
          `Not selected: ${[...counts.entries()].map(([reason, count]) => `${count} handed-off ${count === 1 ? 'bead' : 'beads'}: ${reason}`).join('; ')}.`,
        ),
      );
    }
  }

  const withDraft = state.kept.filter((entry) => entry.drafts.length > 0);
  const keptOnly = state.kept.filter((entry) => entry.drafts.length === 0);
  if (withDraft.length > 0) {
    blocks.push(
      // The loud header, as --undo prints it: red as well as bold.
      `${pad(HEADER_COLUMN)}✍️ ${paint(`Unsent text, kept open (${withDraft.length})`, ['bold', 'red'], style.color)}`,
    );
    blocks.push(
      spacedList(
        withDraft.map((entry) =>
          [
            block(
              headingOf(entry),
              [
                ...baseFields(entry, null),
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

  if (state.dryRun) {
    blocks.push(header(`Would close (${state.planned.length})`, '🔎'));
    blocks.push(
      state.planned.length === 0
        ? prose('Nothing.')
        : spacedList(
            state.planned.map((entry) =>
              block(
                headingOf(entry),
                [
                  ...baseFields(
                    entry,
                    entry.windowAlone
                      ? 'its last workspace, so the window would close with it'
                      : null,
                  ),
                  {label: 'Claude', value: claudeWords(entry.pid, false)},
                ],
                style,
              ),
            ),
          ),
    );
  } else {
    blocks.push(header(`Closed (${state.closed.length})`, '🧹'));
    blocks.push(
      state.closed.length === 0
        ? prose('Nothing.')
        : spacedList(
            state.closed.map((entry) =>
              block(
                headingOf(entry),
                [
                  ...baseFields(entry, entry.windowNote),
                  {label: 'Claude', value: claudeWords(entry.pid, true)},
                ],
                style,
              ),
            ),
          ),
    );
  }

  if (keptOnly.length > 0) {
    blocks.push(header(`Kept (${keptOnly.length})`, '🛡️'));
    blocks.push(
      spacedList(
        keptOnly.map((entry) =>
          block(
            headingOf(entry),
            [
              ...baseFields(entry, null),
              {label: 'Why', value: entry.reasons.join('\n')},
            ],
            style,
          ),
        ),
      ),
    );
  }

  const unresolved = state.unresolved ?? [];
  if (unresolved.length > 0) {
    blocks.push(
      header(
        `Kept: its one tab could not be told (${unresolved.length})`,
        '🛡️',
      ),
    );
    blocks.push(
      spacedList(
        unresolved.map((entry) =>
          block(
            entry.given.join(', '),
            [{label: 'Why', value: entry.reason}],
            style,
          ),
        ),
      ),
    );
  }

  if (state.notFound.length > 0) {
    blocks.push(header(`Not found (${state.notFound.length})`, '👻'));
    blocks.push(
      spacedList(
        state.notFound.map((entry) =>
          block(
            entry.given.join(', '),
            [{label: 'Why', value: entry.reason}],
            style,
          ),
        ),
      ),
    );
  }

  if (state.failed.length > 0 || state.failures.length > 0) {
    blocks.push(
      header(`Failed (${state.failed.length + state.failures.length})`, '🛑'),
    );
    blocks.push(
      spacedList([
        ...state.failed.map((entry) =>
          block(
            headingOf(entry),
            [
              ...baseFields(entry, null),
              {label: 'Why', value: `${entry.step}: ${entry.reason}`},
            ],
            style,
          ),
        ),
        ...state.failures.map((text) => prose(`- ${text}`)),
      ]),
    );
  }

  const keptWords = `kept ${state.kept.length + unresolved.length}${withDraft.length > 0 ? ` (${withDraft.length} with unsent text)` : ''}`;
  const summary = state.dryRun
    ? `Would close ${state.planned.length}, ${keptWords}, not found ${state.notFound.length}. Run it again without --dry-run to close them.`
    : `Closed ${state.closed.length}, ${keptWords}, not found ${state.notFound.length}${state.failed.length > 0 ? `, failed ${state.failed.length}` : ''}.`;
  blocks.push(
    wrapHanging(paint(summary, ['bold'], style.color), {
      hang: HEADER_COLUMN,
      indent: HEADER_COLUMN,
      width: style.width,
    }),
  );
  return spacedList(blocks);
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

function orNone(text: string): string {
  return text === '' ? 'none' : text;
}

function ownPaneRefusal(workspaceId: string, given: string): CloseResult {
  return refuse(
    `${given} is this command's own workspace (CMUX_WORKSPACE_ID ${workspaceId}): closing it would close the terminal this runs in`,
  );
}

type Closable = Extract<Assessment, {kind: 'closable'}>;

/** The second pass's "kept" when the view or the hook store cannot be read again. */
function unreadAgain(
  planned: Closable,
  again: Awaited<ReturnType<typeof readView>>,
  storeAgain: SourceRead<HookStore>,
): Assessment {
  const unread = [
    ...(again.kind === 'read' ? [] : [again.reason]),
    ...(storeAgain.ok ? [] : [`the cmux hook store: ${storeAgain.reason}`]),
  ];
  return {
    drafts: [],
    entry: planned.entry,
    kind: 'kept',
    reasons: [`what is open now could not be read again: ${unread.join('; ')}`],
  };
}

/**
 * Steps 6 and 7, ONE IMPLEMENTATION for whole workspaces and for `--tab`
 * (home-base-v8z8d.2.1 D6): one `closing` line per target before the first
 * SIGTERM (none written, nothing signalled); then per target, right before
 * its turn, `reassess` checks it again and it is kept unless the same
 * session and the same Claude process are seen; `stopAndClose` stops and
 * closes it; one outcome line follows. Mutates `state`.
 */
async function closePlanned(input: {
  closable: Closable[];
  full: CloseDeps;
  logPath: string;
  reassess: (planned: Closable) => Promise<Assessment>;
  startedAt: string;
  state: CloseState;
  stopAndClose: (
    assessment: Closable,
  ) => Promise<StopAndCloseFailure | StopAndCloseSurfaceFailure | null>;
  windowNote: (entry: CloseEntry) => Promise<string>;
}): Promise<void> {
  const {closable, full, logPath, startedAt, state} = input;

  // ---- 6. the log, BEFORE the first SIGTERM: no log line, no signal ----
  for (const planned of closable) {
    const wrote = full.appendLog(
      logLine(planned.entry, 'closing', startedAt, full.nowMs()),
    );
    if (wrote != null) {
      state.failures.push(
        `${tildeText(logPath)} could not be written before stopping anything, so nothing was signalled or closed: ${wrote}`,
      );
      for (const entry of closable) {
        state.kept.push({
          ...entry.entry,
          drafts: [],
          reasons: ['the close log could not be written first'],
        });
      }
      state.planned = [];
      return;
    }
  }

  // ---- 7. per target: the gates again, then SIGTERM, then close ----
  for (const [index, planned] of closable.entries()) {
    let assessment = await input.reassess(planned);
    if (assessment.kind === 'closable') {
      // The second pass must see what the first one did: the same session
      // and the same Claude process (the log line already names them).
      const pidsThen = planned.claude.map((proc) => proc.pid).join(',');
      const pidsNow = assessment.claude.map((proc) => proc.pid).join(',');
      if (
        assessment.sessions.join(',') !== planned.sessions.join(',') ||
        pidsNow !== pidsThen
      ) {
        assessment = {
          drafts: [],
          entry: planned.entry,
          kind: 'kept',
          reasons: [
            `it changed since it was first checked (session ${orNone(planned.sessions.join(', '))} → ${orNone(assessment.sessions.join(', '))}; Claude pid ${orNone(pidsThen)} → ${orNone(pidsNow)})`,
          ],
        };
      }
    }
    let outcome: string;
    if (assessment.kind === 'notFound') {
      state.notFound.push({
        given: planned.entry.given,
        reason: `it closed between the first check and its turn (${assessment.reason})`,
      });
      outcome = `kept: ${assessment.reason}`;
    } else if (assessment.kind === 'kept') {
      const kept = keptOf(
        assessment,
        storeDrafts(assessment, full, false, state.failures),
      );
      state.kept.push(kept);
      outcome = `kept: ${kept.reasons.join('; ')}`;
    } else {
      const entry = assessment.entry;
      const failure = await input.stopAndClose(assessment);
      if (failure == null) {
        state.closed.push({
          ...entry,
          closedAt: new Date(full.nowMs()).toISOString(),
          windowNote: await input.windowNote(entry),
        });
        outcome = 'closed';
      } else {
        state.failed.push({
          ...entry,
          reason: failure.reason,
          step: failure.step,
        });
        outcome = `failed: ${failure.step}: ${failure.reason}`;
      }
    }
    const wrote = full.appendLog(
      logLine(planned.entry, outcome, startedAt, full.nowMs()),
    );
    if (wrote != null) {
      state.failures.push(
        `${tildeText(logPath)} could not be appended after ${headingOf(planned.entry)}, so the run stopped: ${wrote}`,
      );
      for (const rest of closable.slice(index + 1)) {
        state.kept.push({
          ...rest.entry,
          drafts: [],
          reasons: ['not attempted: the run stopped when the close log failed'],
        });
      }
      break;
    }
  }
}

/**
 * `--tab` (home-base-v8z8d.2.1): close the one tab of each session. D2 proves
 * the tab, assessTab gates it, closePlanned keeps the record and the order,
 * and the close is `close-surface --surface <uuid> --workspace <uuid>` (D3),
 * or today's `close-workspace` when it is the workspace's only tab (D4).
 * Never `close-workspace` for a tab that has siblings.
 */
async function closeTabs(input: {
  dryRun: boolean;
  first: LiveView;
  full: CloseDeps;
  hookPids: HookStorePids;
  json: boolean;
  live: Extract<LiveSessions, {kind: 'read'}>;
  logPath: string;
  ownSurface: string | null;
  ownWorkspace: string | null;
  selection: HandedOffSelection | null;
  sessions: readonly string[];
  style: OutputStyle;
}): Promise<CloseResult> {
  // The command's own tab is kept by resolveTab, which reads CMUX_SURFACE_ID;
  // closeWorkspaces refuses --tab when CMUX_WORKSPACE_ID is set without it.
  // assessTab also keeps an only tab of the own workspace, so a D4 close of
  // that workspace needs neither guard to hold (home-base-hg6lz.4 R1).
  const {full, live, ownSurface, ownWorkspace} = input;
  const startedAt = new Date(full.nowMs()).toISOString();
  const unresolved: CloseNotFound[] = [];
  const state: CloseState = {
    closed: [],
    dryRun: input.dryRun,
    failed: [],
    failures: [],
    finishedAt: null,
    kept: [],
    logPath: input.logPath,
    notFound: [],
    planned: [],
    ...(input.selection == null ? {} : {selection: input.selection}),
    startedAt,
    tabMode: true,
    unresolved,
  };
  const finish = (exitCode: 0 | 1): CloseResult => ({
    exitCode,
    output: input.json
      ? JSON.stringify({close: state}, null, 2)
      : renderClose(state, input.style),
    state,
  });

  const targets: TabTarget[] = [];
  for (const sessionId of input.sessions) {
    const given = [`--session ${sessionId}`];
    const found = resolveTab(
      sessionId,
      given,
      input.first,
      input.hookPids,
      live,
      ownSurface,
    );
    if (found.kind === 'notLive') {
      state.notFound.push({given, reason: found.reason});
    } else if (found.kind === 'unresolved') {
      unresolved.push({given, reason: found.reason});
    } else if (
      !targets.some((known) => known.sessionId === found.target.sessionId)
    ) {
      targets.push(found.target);
    }
  }

  const closable: Closable[] = [];
  for (const target of targets) {
    const assessment = await assessTab(
      target,
      input.first,
      input.hookPids,
      full,
      ownWorkspace,
    );
    if (assessment.kind === 'notFound') {
      state.notFound.push({given: target.given, reason: assessment.reason});
    } else if (assessment.kind === 'kept') {
      state.kept.push(
        keptOf(
          assessment,
          storeDrafts(assessment, full, input.dryRun, state.failures),
        ),
      );
    } else {
      closable.push(assessment);
      state.planned.push(assessment.entry);
    }
  }
  if (input.dryRun) return finish(0);

  const targetOf = (entry: CloseEntry): TabTarget | null =>
    targets.find((target) => target.surfaceId === entry.tab?.surfaceId) ?? null;

  await closePlanned({
    closable,
    full,
    logPath: input.logPath,
    reassess: async (planned) => {
      const target = targetOf(planned.entry);
      if (target == null) {
        return {
          drafts: [],
          entry: planned.entry,
          kind: 'kept',
          reasons: ['its tab target was lost between the passes'],
        };
      }
      const again = await readView(full);
      const storeAgain = full.readHookStore();
      if (again.kind !== 'read' || !storeAgain.ok) {
        return unreadAgain(planned, again, storeAgain);
      }
      const pids = hookStorePids(storeAgain.value);
      // D2 again, on what is open now: the same tab, the same process.
      const now = resolveTab(
        target.sessionId,
        target.given,
        again.view,
        pids,
        live,
        ownSurface,
      );
      if (now.kind !== 'tab') {
        return {
          drafts: [],
          entry: planned.entry,
          kind: 'kept',
          reasons: [now.reason],
        };
      }
      if (
        now.target.surfaceId !== target.surfaceId ||
        now.target.pid !== target.pid
      ) {
        return {
          drafts: [],
          entry: planned.entry,
          kind: 'kept',
          reasons: [
            `it changed since it was first checked (tab ${target.surfaceRef} → ${now.target.surfaceRef}; Claude pid ${target.pid} → ${now.target.pid})`,
          ],
        };
      }
      const assessment = await assessTab(
        now.target,
        again.view,
        pids,
        full,
        ownWorkspace,
      );
      // D3, once more right before any signal: both ids explicit.
      if (
        assessment.kind === 'closable' &&
        assessment.entry.tab?.onlyTab !== true
      ) {
        const ids = closeSurfaceArgs(
          assessment.entry.tab?.surfaceId,
          assessment.entry.workspaceId,
        );
        if (ids.kind === 'refused') {
          return {
            drafts: [],
            entry: assessment.entry,
            kind: 'kept',
            reasons: [ids.reason],
          };
        }
      }
      return assessment;
    },
    startedAt,
    state,
    stopAndClose: async (assessment) => {
      const entry = assessment.entry;
      const stop = {
        commandOf: full.commandOf,
        exitTimeoutMs: full.exitTimeoutMs,
        kill: full.kill,
        nowMs: full.nowMs,
        sleep: full.sleep,
      };
      if (entry.tab?.onlyTab === true) {
        // D4: the only tab, so today's whole-workspace close.
        return await stopThenCloseWorkspace(assessment.claude, {
          ...stop,
          closeWorkspace: async () => {
            const closed = await full.run([
              'close-workspace',
              '--workspace',
              entry.workspaceId,
              '--window',
              entry.windowId,
            ]);
            return closed.kind === 'failed' ? closed.reason : null;
          },
        });
      }
      const ids = closeSurfaceArgs(entry.tab?.surfaceId, entry.workspaceId);
      if (ids.kind === 'refused') {
        // Unreachable after reassess; never signal without a close to follow.
        return {reason: ids.reason, step: 'verify'};
      }
      return await stopThenCloseSurface(assessment.claude, {
        ...stop,
        closeSurface: async () => {
          const closed = await full.run(ids.args);
          return closed.kind === 'failed' ? closed.reason : null;
        },
      });
    },
    windowNote: async (entry) =>
      entry.tab?.onlyTab === true
        ? await windowNoteAfterClose(entry, full)
        : 'its workspace stays open with its other tabs',
  });
  state.finishedAt = new Date(full.nowMs()).toISOString();
  return finish(
    state.failures.length === 0 && state.failed.length === 0 ? 0 : 1,
  );
}

export async function closeWorkspaces(
  options: CloseOptions,
  deps: Partial<CloseDeps> = {},
): Promise<CloseResult> {
  const env = options.env ?? process.env;
  const style = options.style ?? outputStyle(process.stdout);

  // ---- 1. the arguments, before any cmux call ----
  const handedOff = options.handedOff === true;
  if (
    options.workspaces.length === 0 &&
    options.sessions.length === 0 &&
    !handedOff
  ) {
    return refuse(
      'name at least one workspace (its uuid from `cmux tree --id-format both`, or workspace:N), or --session <id>',
    );
  }
  // D1: --tab closes the tab of a session, so it takes sessions only.
  if (options.tab === true && options.workspaces.length > 0) {
    return refuse(
      '--tab closes the one tab of each --session (or --handed-off session); it does not take workspaces. Drop --tab to close whole workspaces',
    );
  }
  for (const given of options.workspaces) {
    if (!UUID.test(given) && !WORKSPACE_REF.test(given)) {
      return refuse(
        `${JSON.stringify(given)} is neither a workspace uuid nor a workspace:N ref`,
      );
    }
  }
  for (const given of options.sessions) {
    if (!UUID.test(given)) {
      return refuse(
        `--session takes a Claude session id (a uuid); not ${JSON.stringify(given)}`,
      );
    }
  }
  const own = env.CMUX_WORKSPACE_ID;
  const ownId = own != null && own !== '' ? own.toUpperCase() : null;
  for (const given of options.workspaces) {
    if (ownId != null && given.toUpperCase() === ownId) {
      return ownPaneRefusal(ownId, given);
    }
  }
  // home-base-hg6lz.4 R1: --tab tells its own tab apart by CMUX_SURFACE_ID.
  // Inside a cmux workspace without it, that guard is blind, so refuse.
  const ownSurfaceId = env.CMUX_SURFACE_ID;
  if (
    options.tab === true &&
    ownId != null &&
    (ownSurfaceId == null || ownSurfaceId === '')
  ) {
    return refuse(
      `--tab runs in cmux workspace ${ownId} (CMUX_WORKSPACE_ID), but CMUX_SURFACE_ID is not set, so this command's own tab cannot be told apart from the tab it would close. Run it from a cmux tab that sets CMUX_SURFACE_ID`,
    );
  }

  // ---- 2. cmux: the socket, then a ping (respawn.ts rules) ----
  const socket = liveSocketPath(env);
  if ('reason' in socket) {
    return refuse(
      `cmux cannot be found: no CMUX_SOCKET_PATH, and ${socket.reason}`,
    );
  }
  const cmuxEnv = {...env, CMUX_QUIET: '1', CMUX_SOCKET_PATH: socket.path};
  const home = env.HOME != null && env.HOME !== '' ? env.HOME : homedir();
  const repoCache = new Map<string, RepoResolution>();
  const logPath = closesLogPath(env);
  const full: CloseDeps = {
    appendLog: deps.appendLog ?? realAppendLog(logPath),
    commandOf: deps.commandOf ?? realPidCommand,
    exitTimeoutMs: deps.exitTimeoutMs ?? UNDO_EXIT_TIMEOUT_MS,
    kill: deps.kill ?? realSigterm,
    nowMs: deps.nowMs ?? (() => Date.now()),
    ps: deps.ps ?? realProcessRunner(),
    readHandedOff:
      deps.readHandedOff ?? (() => realReadHandedOff(process.cwd(), env)),
    readHookStore:
      deps.readHookStore ?? (() => readHookStore(defaultHookStorePath(home))),
    readLive:
      deps.readLive ??
      (async () => await readLiveSessions(realLiveSessionDeps(cmuxEnv))),
    resumeOf:
      deps.resumeOf ?? ((sessionId) => realResumeOf(sessionId, env, repoCache)),
    run: deps.run ?? realCmuxRunner(undefined, cmuxEnv),
    sleep:
      deps.sleep ??
      (async (ms) => {
        await new Promise((resolve) => setTimeout(resolve, ms));
      }),
    windowGoneTimeoutMs:
      deps.windowGoneTimeoutMs ?? UNDO_WINDOW_GONE_TIMEOUT_MS,
    writeDraft: deps.writeDraft ?? ((input) => writeInputDraft(input, env)),
  };
  const ping = await full.run(['ping']);
  if (ping.kind === 'failed') {
    const allow = socketSettingsJson(socket.path).trim();
    return refuse(
      `cmux cannot be reached: ${ping.reason}\nIf this session is sandboxed, the sandbox blocks the cmux socket and ps: add ${allow} to your Claude Code user settings, or retry with the sandbox disabled.`,
    );
  }

  // ---- 3. what is open now, read-only ----
  const first = await readView(full);
  if (first.kind === 'failed') {
    return refuse(`what is open now could not be read: ${first.reason}`);
  }
  const store = full.readHookStore();
  if (!store.ok) {
    return refuse(
      `the cmux hook store could not be read, so no Claude process can be matched to its session: ${store.reason}`,
    );
  }

  // The live sessions, read at most once, and only when a session is named.
  let liveRead: LiveSessions | null = null;
  const readLiveOnce = async (): Promise<LiveSessions> => {
    liveRead ??= await full.readLive();
    return liveRead;
  };

  // ---- 3b. --handed-off (D5): its sessions join the --session list ----
  const sessions = [...options.sessions];
  let selection: HandedOffSelection | null = null;
  if (handedOff) {
    const live = await readLiveOnce();
    if (live.kind === 'failed') {
      return refuse(
        `--handed-off selects only sessions a live Claude process holds, and the live sessions could not be read: ${live.reason}`,
      );
    }
    const beads = full.readHandedOff();
    if (beads.kind === 'failed') {
      return refuse(
        `--handed-off could not read the handed-off session beads: ${beads.reason}`,
      );
    }
    selection = selectHandedOff(beads.beads, (sessionId) =>
      live.bySessionId.has(sessionId),
    );
    for (const pick of selection.selected) {
      if (!sessions.some((given) => given.toLowerCase() === pick.sessionId)) {
        sessions.push(pick.sessionId);
      }
    }
  }

  // ---- 3c. --tab (home-base-v8z8d.2.1): its own path from here on ----
  if (options.tab === true) {
    const live = await readLiveOnce();
    if (live.kind === 'failed') {
      return refuse(
        `--tab needs to know which tab holds each session, and the live sessions could not be read: ${live.reason}`,
      );
    }
    return await closeTabs({
      dryRun: options.dryRun,
      first: first.view,
      full,
      hookPids: hookStorePids(store.value),
      json: options.json,
      live,
      logPath,
      ownSurface:
        ownSurfaceId != null && ownSurfaceId !== ''
          ? ownSurfaceId.toUpperCase()
          : null,
      ownWorkspace: ownId,
      selection,
      sessions,
      style,
    });
  }

  // ---- 4. resolve every target to a workspace uuid ----
  const resolved: Resolved[] = [];
  const notFound: CloseNotFound[] = [];
  const addTarget = (workspaceId: string, given: string): void => {
    const known = resolved.find(
      (entry) => entry.workspaceId.toUpperCase() === workspaceId.toUpperCase(),
    );
    if (known == null) resolved.push({given: [given], workspaceId});
    else known.given.push(given);
  };
  for (const given of options.workspaces) {
    const id = findInTree(first.view.tree, given);
    if (id == null) {
      notFound.push({given: [given], reason: 'no open cmux workspace has it'});
    } else {
      addTarget(id, given);
    }
  }
  if (sessions.length > 0) {
    const live = await readLiveOnce();
    if (live.kind === 'failed') {
      return refuse(
        `--session needs to know which workspace holds each session, and the live sessions could not be read: ${live.reason}`,
      );
    }
    for (const sessionId of sessions) {
      const found = sessionWorkspace(live, sessionId);
      if (found.kind === 'refused') return refuse(found.reason);
      const id = findInTree(first.view.tree, found.workspaceId);
      if (id == null) {
        notFound.push({
          given: [`--session ${sessionId}`],
          reason: `its workspace ${found.workspaceId} is not in the cmux tree now`,
        });
      } else {
        addTarget(id, `--session ${sessionId}`);
      }
    }
  }
  for (const target of resolved) {
    if (ownId != null && target.workspaceId.toUpperCase() === ownId) {
      return ownPaneRefusal(ownId, target.given.join(', '));
    }
  }

  // ---- 5. the gates, read-only, for every target ----
  const startedAt = new Date(full.nowMs()).toISOString();
  const state: CloseState = {
    closed: [],
    dryRun: options.dryRun,
    failed: [],
    failures: [],
    finishedAt: null,
    kept: [],
    logPath,
    notFound,
    planned: [],
    ...(selection == null ? {} : {selection}),
    startedAt,
  };
  const finish = (exitCode: 0 | 1): CloseResult => ({
    exitCode,
    output: options.json
      ? JSON.stringify({close: state}, null, 2)
      : renderClose(state, style),
    state,
  });
  const closable: Closable[] = [];
  const hookPids = hookStorePids(store.value);
  for (const target of resolved) {
    const assessment = await assess(target, first.view, hookPids, full);
    if (assessment.kind === 'notFound') {
      notFound.push({given: target.given, reason: assessment.reason});
    } else if (assessment.kind === 'kept') {
      // D-DRAFTS: the text is stored the moment it is seen (not in a dry run).
      state.kept.push(
        keptOf(
          assessment,
          storeDrafts(assessment, full, options.dryRun, state.failures),
        ),
      );
    } else {
      closable.push(assessment);
      state.planned.push(assessment.entry);
    }
  }
  if (options.dryRun) return finish(0);

  // ---- 6 and 7: the log first, then per workspace the gates again, SIGTERM, close ----
  await closePlanned({
    closable,
    full,
    logPath,
    reassess: async (planned) => {
      const target: Resolved = {
        given: planned.entry.given,
        workspaceId: planned.entry.workspaceId,
      };
      const again = await readView(full);
      const storeAgain = full.readHookStore();
      if (again.kind !== 'read' || !storeAgain.ok) {
        return unreadAgain(planned, again, storeAgain);
      }
      return await assess(
        target,
        again.view,
        hookStorePids(storeAgain.value),
        full,
      );
    },
    startedAt,
    state,
    stopAndClose: async (assessment) => {
      const entry = assessment.entry;
      // One implementation of SIGTERM-wait-close (workspace-close.ts).
      return await stopThenCloseWorkspace(assessment.claude, {
        closeWorkspace: async () => {
          const closed = await full.run([
            'close-workspace',
            '--workspace',
            entry.workspaceId,
            '--window',
            entry.windowId,
          ]);
          return closed.kind === 'failed' ? closed.reason : null;
        },
        commandOf: full.commandOf,
        exitTimeoutMs: full.exitTimeoutMs,
        kill: full.kill,
        nowMs: full.nowMs,
        sleep: full.sleep,
      });
    },
    windowNote: async (entry) => await windowNoteAfterClose(entry, full),
  });
  state.finishedAt = new Date(full.nowMs()).toISOString();
  return finish(
    state.failures.length === 0 && state.failed.length === 0 ? 0 : 1,
  );
}

export async function runThreadClose(options: CloseOptions): Promise<number> {
  const result = await closeWorkspaces(options);
  if (result.exitCode === 2) {
    console.error(result.output);
    return result.exitCode;
  }
  await writeStdout(`${result.output}\n`);
  return result.exitCode;
}
