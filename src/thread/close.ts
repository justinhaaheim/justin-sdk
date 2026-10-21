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
 */

import type {OutputStyle} from '../cli-style';
import type {RepoResolution} from '../repo-status/sessions';
import type {CmuxRunner, CmuxTree} from './cmux';
import type {InputDraftWrite, WriteInputDraftInput} from './input-drafts';
import type {LiveSessions} from './live-sessions';
import type {HookStorePids, LiveView, UndoDraft} from './open-undo';
import type {HookStore, Proc, ProcessRunner, SourceRead} from './pane-join';
import type {EnvLike} from './paths';
import type {PidCommand} from './workspace-close';

import {appendFileSync, mkdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename, dirname, join} from 'node:path';

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
import {readLiveSessions, realLiveSessionDeps} from './live-sessions';
import {locateWorkspace} from './open';
import {
  gateSurfaces,
  hookStorePids,
  readView,
  UNDO_EXIT_TIMEOUT_MS,
  UNDO_WINDOW_GONE_TIMEOUT_MS,
} from './open-undo';
import {
  defaultHookStorePath,
  readHookStore,
  realProcessRunner,
} from './pane-join';
import {tildeText} from './part-one';
import {threadsStateDir} from './paths';
import {liveSocketPath, socketSettingsJson} from './respawn';
import {extractTranscriptMessages} from './transcript-messages';
import {
  realPidCommand,
  realSigterm,
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
  title: string | null;
  windowId: string;
  workspaceId: string;
}

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
  startedAt: string;
}

export interface CloseOptions {
  dryRun: boolean;
  env?: EnvLike;
  json: boolean;
  /** `--session <id>`: each resolves to the one workspace that holds it. */
  sessions: readonly string[];
  style?: OutputStyle;
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

async function assess(
  target: Resolved,
  view: LiveView,
  hookPids: HookStorePids,
  deps: Pick<CloseDeps, 'resumeOf' | 'run'>,
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
  const gate = await gateSurfaces(surfaceIds, view, deps.run, null, hookPids);
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
  return entry.workspaceRef == null
    ? entry.workspaceId
    : `${entry.workspaceRef} (${entry.workspaceId})`;
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

/** The fields every record carries, in order (Title, Repo, Session, Resume, Window). */
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
  blocks.push(header('thread close: close named cmux workspaces', '🧹'));
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
            'an empty input box, Claude not working, a readable screen, a known tty, one Claude session and process that its ⌗ line names (else kept)',
        },
        {label: 'Log', value: tildeText(state.logPath)},
      ],
      {color: style.color, indent: BODY_COLUMN, width: style.width},
    ),
  );

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

  const keptWords = `kept ${state.kept.length}${withDraft.length > 0 ? ` (${withDraft.length} with unsent text)` : ''}`;
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

export async function closeWorkspaces(
  options: CloseOptions,
  deps: Partial<CloseDeps> = {},
): Promise<CloseResult> {
  const env = options.env ?? process.env;
  const style = options.style ?? outputStyle(process.stdout);

  // ---- 1. the arguments, before any cmux call ----
  if (options.workspaces.length === 0 && options.sessions.length === 0) {
    return refuse(
      'name at least one workspace (its uuid from `cmux tree --id-format both`, or workspace:N), or --session <id>',
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
  if (options.sessions.length > 0) {
    const live = await full.readLive();
    if (live.kind === 'failed') {
      return refuse(
        `--session needs to know which workspace holds each session, and the live sessions could not be read: ${live.reason}`,
      );
    }
    for (const sessionId of options.sessions) {
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
    startedAt,
  };
  const finish = (exitCode: 0 | 1): CloseResult => ({
    exitCode,
    output: options.json
      ? JSON.stringify({close: state}, null, 2)
      : renderClose(state, style),
    state,
  });
  const closable: Extract<Assessment, {kind: 'closable'}>[] = [];
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
      state.finishedAt = new Date(full.nowMs()).toISOString();
      return finish(1);
    }
  }

  // ---- 7. per workspace: the gates again, then SIGTERM, then close ----
  for (const [index, planned] of closable.entries()) {
    const target: Resolved = {
      given: planned.entry.given,
      workspaceId: planned.entry.workspaceId,
    };
    const again = await readView(full);
    const storeAgain = full.readHookStore();
    let assessment: Assessment;
    if (again.kind !== 'read' || !storeAgain.ok) {
      const unread = [
        ...(again.kind === 'read' ? [] : [again.reason]),
        ...(storeAgain.ok ? [] : [`the cmux hook store: ${storeAgain.reason}`]),
      ];
      assessment = {
        drafts: [],
        entry: planned.entry,
        kind: 'kept',
        reasons: [
          `what is open now could not be read again: ${unread.join('; ')}`,
        ],
      };
    } else {
      assessment = await assess(
        target,
        again.view,
        hookStorePids(storeAgain.value),
        full,
      );
    }
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
      notFound.push({
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
      // One implementation of SIGTERM-wait-close (workspace-close.ts).
      const failure = await stopThenCloseWorkspace(assessment.claude, {
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
      if (failure == null) {
        state.closed.push({
          ...entry,
          closedAt: new Date(full.nowMs()).toISOString(),
          windowNote: await windowNoteAfterClose(entry, full),
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
