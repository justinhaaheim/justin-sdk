/**
 * `thread open` (home-base-yukaf.1): reopen every unfinished session of the
 * last N days as cmux workspaces, newest first, in one new window (the
 * default) or one new window per project (--per-project). Justin, 2026-10-17:
 * "open up sessions for any threads that are unfinished … within the last
 * seven days … sorted by recency … importantly to not open the windows that
 * are not unfinished".
 *
 * Decisions of epic home-base-yukaf it follows:
 *
 * - D-NAME: `thread open`; `--undo` and `--run` are the next dispatch and
 *   refuse with "not built yet" here. `thread reopen` is another command.
 * - D-UNFINISHED: a session reopens when the inbox puts it in unsentDraft
 *   (home-base-yukaf.4), needsYou, toLand, stoppedOpen or checkByHand
 *   (`--include` adds answered, handedOff,
 *   doneQuestions), it has a session bead, and live-sessions.ts finds no live
 *   process for it. A live Claude pane whose session cannot be read makes the
 *   run refuse unless --force-unplaced.
 * - D-CUTOFF: --days defaults to 7 (the inbox keeps its own 30).
 * - D-LAYOUT: one workspace per session named sessionDisplayName(repoTag,
 *   title), running `claude --resume <id>` with --cwd at the session's
 *   checkout; `reorder-workspaces` sets the final newest-first order; the new
 *   window's own default workspace is closed afterwards.
 * - D-RECORD: <threads state dir>/opens/<stamp>.json is written BEFORE the
 *   first cmux write (no record, no write) and rewritten after every cmux
 *   call with the window and workspace uuids, so --undo can close exactly
 *   what a run opened.
 * - D-NO-LIVE-RUNS: tests drive a fake cmux runner; against the live machine
 *   only --dry-run, which writes nothing.
 */

import type {Field, OutputStyle} from '../cli-style';
import type {CmuxCall, CmuxRunner, CmuxTree, CmuxTreeRead} from './cmux';
import type {
  LateLiveCheck,
  LiveSession,
  LiveSessions,
  UnplacedLive,
} from './live-sessions';
import type {RestoreDeps, RestoreRecord, RestoreTarget} from './open-restore';
import type {EnvLike} from './paths';
import type {InboxSection} from './session-card';
import type {InboxRow} from './session-inbox';

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';

import {
  BODY_COLUMN,
  fieldLabelWidth,
  fieldLines,
  HEADER_COLUMN,
  outputStyle,
  paint,
  sectionHeader,
  spacedList,
  stepColumn,
  wrapHanging,
} from '../cli-style';
import {writeStdout} from '../write-stdout';
import {parseInstant} from './answer-store';
import {readCmuxTree, realCmuxRunner, surfacesOfWorkspace} from './cmux';
import {resolveThreadConfig} from './config';
import {THREAD_DEFAULT_OPEN_SINCE} from './defaults';
import {
  readLiveSessions,
  realLateLiveCheck,
  realLiveSessionDeps,
} from './live-sessions';
import {
  type ColorFile,
  colorFilePath,
  projectColor,
  readColorFile,
  setColorArgs,
} from './open-colors';
import {
  matchesRepo,
  type OpenFilters,
  parseLimit,
  parseSince,
  repoValues,
  type SinceSource,
} from './open-filters';
import {
  planRestores,
  realRestoreDeps,
  renderRestore,
  restoreDrafts,
  restoreFailed,
} from './open-restore';
import {ageWords, tildeText} from './part-one';
import {threadsStateDir} from './paths';
import {liveSocketPath, socketSettingsJson, zshWord} from './respawn';
import {sectionInfo, selectWorkspaceCommand} from './session-card';
import {readInbox, rowCheckout} from './session-inbox';
import {sessionDisplayName} from './session-name';

/** D-CUTOFF. */
export const OPEN_DEFAULT_DAYS = 7;

/** D-UNFINISHED: the sections reopened by default, in the inbox's order. */
export const OPEN_DEFAULT_SECTIONS: readonly InboxSection[] = [
  // home-base-yukaf.4: a session with unsent text moves to this section from
  // whichever one it was in; without it here, a needsYou session that also
  // holds a draft would stop being reopened. Liveness still skips a session
  // whose pane is open.
  'unsentDraft',
  'needsYou',
  'toLand',
  'stoppedOpen',
  'checkByHand',
];

/** D-UNFINISHED: what `--include` may add. */
export const OPEN_INCLUDABLE_SECTIONS: readonly InboxSection[] = [
  'answered',
  'handedOff',
  'doneQuestions',
];

/** One session as `thread open` needs it, from an inbox row. */
export interface OpenCandidate {
  /** The checkout the session works in (absolute), or null when unknown. */
  checkout: string | null;
  lastActivityAt: string | null;
  repo: string | null;
  repoTag: string | null;
  section: InboxSection;
  sessionBeadId: string | null;
  sessionId: string;
  /** How many sessions the row stands for (a folded untracked line is several). */
  sessions: number;
  title: string;
  tracked: boolean;
}

/** An inbox row as a candidate: the checkout the session model measured. */
export function candidateOf(row: InboxRow): OpenCandidate {
  return {
    checkout: rowCheckout(row),
    lastActivityAt: row.lastActivityAt,
    repo: row.repo,
    repoTag: row.card.repoTag,
    section: row.section,
    sessionBeadId: row.sessionBeadId,
    sessionId: row.sessionId,
    sessions: row.repeats?.count ?? 1,
    title: row.title,
    tracked: row.tracked,
  };
}

export type CandidatesRead =
  | {candidates: OpenCandidate[]; kind: 'read'}
  | {kind: 'failed'; reason: string};

// ---------------------------------------------------------------------------
// The plan (pure)
// ---------------------------------------------------------------------------

/** A session the run opens (or, in a dry run, would open). */
export interface PlannedSession {
  checkout: string;
  /** The text `new-workspace --command` types into the new pane's zsh. */
  command: string;
  lastActivityAt: string | null;
  /** The workspace name: sessionDisplayName(repoTag, title). */
  name: string;
  repo: string | null;
  repoTag: string | null;
  section: InboxSection;
  sessionBeadId: string | null;
  sessionId: string;
  title: string;
}

export interface AlreadyOpen {
  /** `cmux select-workspace …` when its workspace is known, else null. */
  command: string | null;
  lastActivityAt: string | null;
  /**
   * yukaf.22 --include-open: why this live session is NOT moved into the new
   * window (no cmux workspace, a workspace shared with another session, …);
   * null without --include-open.
   */
  notMoved: string | null;
  pid: number | null;
  repo: string | null;
  repoTag: string | null;
  section: InboxSection;
  sessionId: string;
  source: string;
  title: string;
  workspaceId: string | null;
}

/**
 * yukaf.22 --include-open: a live session whose existing workspace is MOVED
 * into the new window. It is never resumed a second time (D-UNFINISHED).
 */
export interface MoveCandidate {
  /** Where the plan saw it: the window's uuid and ref, and its position there. */
  fromIndex: number;
  /** How many workspaces that window held when the plan read it. */
  fromWindowCount: number;
  fromWindowId: string;
  fromWindowRef: string;
  lastActivityAt: string | null;
  /**
   * G3 (home-base-yukaf.25): this run moves every workspace out of its
   * window, so cmux leaves a blank workspace there (scripts/CLAUDE.md).
   */
  leavesBlank: boolean;
  /** The workspace name it would have if opened: sessionDisplayName. */
  name: string;
  /**
   * G2 decision (2026-10-19): the workspace's other panes (shell splits,
   * previews), which move with it and come back on --undo.
   */
  otherPanes: number;
  pid: number | null;
  repo: string | null;
  repoTag: string | null;
  section: InboxSection;
  sessionId: string;
  title: string;
  workspaceId: string;
}

/** A workspace a run moved (or tried to), as the record keeps it for --undo. */
export interface MovedWorkspace {
  /** Why the move failed; null when it did not (or has not run yet). */
  failure: string | null;
  /** Its position in the window it came from (0 = top), for --undo. */
  fromIndex: number;
  /** How many workspaces that window held before the move. */
  fromWindowCount: number;
  fromWindowId: string;
  fromWindowRef: string;
  /** When cmux moved it; null when written just before the call, or failed. */
  movedAt: string | null;
  name: string;
  sessionId: string;
  /** The window this run made, which it was moved into. */
  toWindowId: string;
  workspaceId: string;
}

/** Where a workspace is in the cmux tree now, or null when no window holds it. */
export function locateWorkspace(
  tree: CmuxTree,
  workspaceId: string,
): {count: number; index: number; windowId: string; windowRef: string} | null {
  const want = workspaceId.toUpperCase();
  for (const window of tree.windows) {
    const index = window.workspaces.findIndex(
      (workspace) => workspace.id.toUpperCase() === want,
    );
    if (index !== -1) {
      return {
        count: window.workspaces.length,
        index,
        windowId: window.id,
        windowRef: window.ref,
      };
    }
  }
  return null;
}

/** G2: the reason a workspace that is this command's own stays put. */
export const OWN_PANE_REASON =
  "this command's own pane: thread open runs in this workspace (CMUX_WORKSPACE_ID), and moving it would move the terminal the command was typed in";

/**
 * Why a live session's workspace cannot be moved, or null when it can. The
 * workspace this command runs in stays put (G2, home-base-yukaf.25). A
 * workspace that holds another Claude session (named or not) stays put:
 * moving it would move that session too (bead out-of-scope fence). Other
 * panes (shell splits, previews) move with it: the workspace is the unit
 * Justin thinks in (conductor decision on G2 QUESTION 1, 2026-10-19).
 */
function unmovableReason(
  live: LiveSession,
  all: Extract<LiveSessions, {kind: 'read'}>,
  tree: CmuxTree | null,
  ownWorkspaceId: string | null,
): string | null {
  if (live.workspaceId == null) {
    return `it runs outside any cmux workspace${live.pid == null ? '' : ` (pid ${live.pid})`}: a background worker or a terminal cmux does not own, so there is no workspace to move`;
  }
  const want = live.workspaceId.toUpperCase();
  if (ownWorkspaceId?.toUpperCase() === want) {
    return OWN_PANE_REASON;
  }
  if (tree == null) return 'the cmux tree was not read';
  if (locateWorkspace(tree, live.workspaceId) == null) {
    return 'its workspace is not in the cmux tree now';
  }
  const sharers =
    [...all.bySessionId.values()].filter(
      (entry) => entry.workspaceId?.toUpperCase() === want,
    ).length +
    all.unplaced.filter((entry) => entry.workspaceId?.toUpperCase() === want)
      .length;
  if (sharers > 1) {
    return `its workspace holds ${sharers} Claude sessions; moving it would move the others too, so it stays where it is`;
  }
  return null;
}

/** G2 decision: how many panes besides its own a moved workspace takes along. */
function otherPanesOf(tree: CmuxTree | null, workspaceId: string): number {
  if (tree == null) return 0;
  const surfaces = surfacesOfWorkspace(tree, workspaceId)?.length ?? 0;
  return Math.max(0, surfaces - 1);
}

export interface SkippedSession {
  lastActivityAt: string | null;
  reason: string;
  repo: string | null;
  repoTag: string | null;
  section: InboxSection;
  sessionId: string;
  title: string;
}

/** A session the filters let through that --limit left out (yukaf.22). */
export interface OverLimitSession {
  /** What the run would have done with it: open it, or move its workspace. */
  action: 'move' | 'open';
  lastActivityAt: string | null;
  repo: string | null;
  repoTag: string | null;
  section: InboxSection;
  sessionId: string;
  title: string;
}

export interface OpenPlan {
  alreadyOpen: AlreadyOpen[];
  cannotTell: UnplacedLive[];
  hidden: {doneOrArchived: number; olderThanCutoff: number; otherRepo: number};
  /** Live sessions found, so a reader sees the liveness read ran. */
  liveSessionsFound: number;
  /** Newest first: what --limit cut, oldest of the shown ones last. */
  overLimit: OverLimitSession[];
  planned: PlannedSession[];
  skipped: SkippedSession[];
  /** --include-open: live sessions whose workspaces move into the new window. */
  toMove: MoveCandidate[];
  /** --repo values no session in the window belongs to. */
  unmatchedRepos: string[];
  untracked: {
    count: number;
    sessions: {
      lastActivityAt: string | null;
      repo: string | null;
      sessionId: string;
      title: string;
    }[];
  };
}

function activityMs(iso: string | null): number | null {
  return iso == null ? null : parseInstant(iso);
}

function byNewest<T extends {lastActivityAt: string | null}>(
  a: T,
  b: T,
): number {
  return (
    (activityMs(b.lastActivityAt) ?? -Infinity) -
    (activityMs(a.lastActivityAt) ?? -Infinity)
  );
}

/** `claude --resume <id>`, each word as zsh must receive it (respawn.ts rule). */
export function resumeCommand(sessionId: string): string {
  return ['claude', '--resume', sessionId].map(zshWord).join(' ');
}

/** Why a session whose section is not reopened was left alone. */
function sectionReason(section: InboxSection): string {
  const title = sectionInfo(section).title;
  if (section === 'working') {
    return `its section is ${title}: it is running right now`;
  }
  if (OPEN_INCLUDABLE_SECTIONS.includes(section)) {
    return `its section is ${title}, which is not reopened by default; --include ${section} adds it`;
  }
  return `its section is ${title}, which thread open never reopens`;
}

/**
 * D-UNFINISHED and D-CUTOFF over the candidates, newest first. In order: one
 * older than the window (or undated) only counted; one outside --repo only
 * counted; an untracked one only counted; a done or archived one only
 * counted; one outside the sections skipped with why; a live one listed as
 * already open; one whose checkout is unknown or gone skipped; the rest
 * planned. Last, --limit keeps the newest `limit` and lists the rest.
 */
export function planOpen(input: {
  candidates: readonly OpenCandidate[];
  checkoutExists: (path: string) => boolean;
  /** --include-open: move live sessions' workspaces (needs `tree`). */
  includeOpen?: boolean;
  /** --limit: at most this many planned; null = all. */
  limit?: number | null;
  live: Extract<LiveSessions, {kind: 'read'}>;
  now: Date;
  /** G2: the workspace this command runs in (CMUX_WORKSPACE_ID); never moved. */
  ownWorkspaceId?: string | null;
  /** --repo values; empty or absent = every repo. */
  repos?: readonly string[];
  sections: ReadonlySet<InboxSection>;
  /** The window, in milliseconds back from `now` (--since, --days, config). */
  sinceMs: number;
  /** The cmux tree, read for --include-open (where each workspace is now). */
  tree?: CmuxTree | null;
}): OpenPlan {
  const since = input.now.getTime() - input.sinceMs;
  const repos = input.repos ?? [];
  const plan: OpenPlan = {
    alreadyOpen: [],
    cannotTell: input.live.unplaced,
    hidden: {doneOrArchived: 0, olderThanCutoff: 0, otherRepo: 0},
    liveSessionsFound: input.live.bySessionId.size,
    overLimit: [],
    planned: [],
    skipped: [],
    toMove: [],
    unmatchedRepos: [],
    untracked: {count: 0, sessions: []},
  };
  const plannedIds = new Set<string>();
  const repoSeen = new Set<string>();
  for (const candidate of [...input.candidates].sort(byNewest)) {
    const ms = activityMs(candidate.lastActivityAt);
    // Undated is not proof of recent: it is never reopened, only counted.
    if (ms == null || ms < since) {
      plan.hidden.olderThanCutoff += candidate.sessions;
      continue;
    }
    if (!matchesRepo(candidate, repos)) {
      plan.hidden.otherRepo += candidate.sessions;
      continue;
    }
    for (const value of repos) {
      if (matchesRepo(candidate, [value])) repoSeen.add(value);
    }
    if (!candidate.tracked) {
      plan.untracked.count += candidate.sessions;
      plan.untracked.sessions.push({
        lastActivityAt: candidate.lastActivityAt,
        repo: candidate.repo,
        sessionId: candidate.sessionId,
        title: candidate.title,
      });
      continue;
    }
    if (candidate.section === 'done' || candidate.section === 'archived') {
      plan.hidden.doneOrArchived += 1;
      continue;
    }
    const base = {
      lastActivityAt: candidate.lastActivityAt,
      repo: candidate.repo,
      repoTag: candidate.repoTag,
      section: candidate.section,
      sessionId: candidate.sessionId,
      title: candidate.title,
    };
    if (!input.sections.has(candidate.section)) {
      plan.skipped.push({...base, reason: sectionReason(candidate.section)});
      continue;
    }
    const live = input.live.bySessionId.get(candidate.sessionId.toLowerCase());
    if (live != null) {
      // D-UNFINISHED unchanged: a live session is NEVER resumed again. With
      // --include-open its existing workspace is moved instead (yukaf.22).
      let notMoved: string | null = null;
      if (input.includeOpen === true) {
        const tree = input.tree ?? null;
        const key = candidate.sessionId.toLowerCase();
        notMoved = plannedIds.has(key)
          ? 'the inbox lists it twice; it is moved once, from its newest row'
          : unmovableReason(
              live,
              input.live,
              tree,
              input.ownWorkspaceId ?? null,
            );
        const at =
          notMoved == null && tree != null && live.workspaceId != null
            ? locateWorkspace(tree, live.workspaceId)
            : null;
        if (notMoved == null && at != null && live.workspaceId != null) {
          plannedIds.add(key);
          plan.toMove.push({
            ...base,
            fromIndex: at.index,
            fromWindowCount: at.count,
            fromWindowId: at.windowId,
            fromWindowRef: at.windowRef,
            leavesBlank: false,
            name: sessionDisplayName(
              candidate.repoTag,
              candidate.title,
            ).trimEnd(),
            otherPanes: otherPanesOf(tree, live.workspaceId),
            pid: live.pid,
            workspaceId: live.workspaceId,
          });
          continue;
        }
      }
      plan.alreadyOpen.push({
        ...base,
        command:
          live.workspaceId == null
            ? null
            : selectWorkspaceCommand(live.workspaceId),
        notMoved,
        pid: live.pid,
        source: live.source,
        workspaceId: live.workspaceId,
      });
      continue;
    }
    if (candidate.checkout == null) {
      plan.skipped.push({
        ...base,
        reason:
          'its checkout is unknown (the session could not be loaded), and claude --resume finds nothing from the wrong directory',
      });
      continue;
    }
    if (!input.checkoutExists(candidate.checkout)) {
      plan.skipped.push({
        ...base,
        reason: `its checkout ${tildeText(candidate.checkout)} no longer exists`,
      });
      continue;
    }
    // F21 (home-base-yukaf.14): one session is opened once, however many
    // rows name it. The newest row (sorted above) wins.
    const key = candidate.sessionId.toLowerCase();
    if (plannedIds.has(key)) {
      plan.skipped.push({
        ...base,
        reason:
          'the inbox lists it twice; it is opened once, from its newest row',
      });
      continue;
    }
    plannedIds.add(key);
    plan.planned.push({
      ...base,
      checkout: candidate.checkout,
      command: resumeCommand(candidate.sessionId),
      name: sessionDisplayName(candidate.repoTag, candidate.title).trimEnd(),
      sessionBeadId: candidate.sessionBeadId,
    });
  }
  plan.unmatchedRepos = repos.filter((value) => !repoSeen.has(value));
  // yukaf.22 --limit: the newest `limit` of what the window would show
  // (opened and moved together) stay; the rest are listed, newest first.
  const limit = input.limit ?? null;
  const shown = [
    ...plan.planned.map((entry) => ({action: 'open' as const, entry})),
    ...plan.toMove.map((entry) => ({action: 'move' as const, entry})),
  ].sort((a, b) => byNewest(a.entry, b.entry));
  if (limit != null && shown.length > limit) {
    const cut = new Set(
      shown.slice(limit).map((item) => item.entry.sessionId.toLowerCase()),
    );
    for (const item of shown.slice(limit)) {
      plan.overLimit.push({
        action: item.action,
        lastActivityAt: item.entry.lastActivityAt,
        repo: item.entry.repo,
        repoTag: item.entry.repoTag,
        section: item.entry.section,
        sessionId: item.entry.sessionId,
        title: item.entry.title,
      });
    }
    const keep = (entry: {sessionId: string}): boolean =>
      !cut.has(entry.sessionId.toLowerCase());
    plan.planned = plan.planned.filter(keep);
    plan.toMove = plan.toMove.filter(keep);
  }
  // G3 (home-base-yukaf.25): a window this run moves every workspace out of
  // keeps a blank workspace cmux makes (scripts/CLAUDE.md, measured).
  const movingOut = new Map<string, number>();
  for (const move of plan.toMove) {
    const key = move.fromWindowId.toUpperCase();
    movingOut.set(key, (movingOut.get(key) ?? 0) + 1);
  }
  for (const move of plan.toMove) {
    move.leavesBlank =
      movingOut.get(move.fromWindowId.toUpperCase()) === move.fromWindowCount;
  }
  return plan;
}

/** One window's share of the plan: what it opens, what it moves in, and the order. */
export interface WindowGroup {
  moves: MoveCandidate[];
  /** Every session id of the window, opened and moved, newest first. */
  order: string[];
  repo: string | null;
  sessions: PlannedSession[];
}

/**
 * D-LAYOUT: one window of every session, or one per repo by its newest
 * session. Moved workspaces (yukaf.22 --include-open) take their place in
 * the same newest-first order as the opened ones.
 */
export function windowGroups(
  planned: readonly PlannedSession[],
  perProject: boolean,
  moves: readonly MoveCandidate[] = [],
): WindowGroup[] {
  const items = [
    ...planned.map((entry) => ({entry, move: false})),
    ...moves.map((entry) => ({entry, move: true})),
  ].sort((a, b) => byNewest(a.entry, b.entry));
  const groups = new Map<string, WindowGroup>();
  for (const item of items) {
    const key = perProject ? (item.entry.repo ?? '') : '';
    const group = groups.get(key) ?? {
      moves: [],
      order: [],
      repo: perProject ? item.entry.repo : null,
      sessions: [],
    };
    group.order.push(item.entry.sessionId);
    if (item.move) {
      group.moves.push(item.entry as MoveCandidate);
    } else {
      group.sessions.push(item.entry as PlannedSession);
    }
    groups.set(key, group);
  }
  // Map insertion order follows each repo's newest session.
  return [...groups.values()];
}

// ---------------------------------------------------------------------------
// The record (D-RECORD)
// ---------------------------------------------------------------------------

export interface OpenedWorkspace {
  sessionId: string;
  /** The uuid; null when cmux's answer could not be matched to one. */
  workspaceId: string | null;
  workspaceRef: string | null;
}

export interface OpenWindow {
  /** The new window's own workspaces before ours were added (null: unread). */
  defaultWorkspaceIds: string[] | null;
  reordered: boolean;
  repo: string | null;
  /** The sessions planned for this window (opened and moved), newest first. */
  sessionIds: string[];
  /** Default workspaces this run closed. */
  strayClosed: string[];
  windowId: string | null;
  workspaces: OpenedWorkspace[];
}

/** yukaf.22 item 5: what the run did about project colours. */
export interface OpenColors {
  /** Workspaces whose set-color failed (never fatal). */
  failed: {name: string; reason: string; workspaceId: string}[];
  /** The colour file cmux-arrange reads. */
  file: string;
  /** Projects of this run with no colour in the file. */
  noColor: string[];
  /** Per session: the colour it gets (a dry run shows these). */
  planned: {color: string; name: string; sessionId: string}[];
  /** Why the file could not be used, when state is failed. */
  reason: string | null;
  /** Colours set, in order (after the record was written). */
  set: {color: string; name: string; sessionId: string; workspaceId: string}[];
  /** off: --no-color · absent: no file · failed: unreadable or invalid · read. */
  state: 'absent' | 'failed' | 'off' | 'read';
}

export interface OpenRecord extends OpenPlan {
  argv: string[];
  at: string;
  colors: OpenColors;
  /** Problems reading `openSince` from the config (the default was used). */
  configProblems: string[];
  /** The window in days (filters.sinceMs / 1 day), kept for older readers. */
  cutoffDays: number;
  dryRun: boolean;
  /** Every step that failed, in words; empty when none did. */
  failures: string[];
  /** yukaf.22: the filters this run used (since, repos, limit, include-open). */
  filters: OpenFilters;
  finishedAt: string | null;
  /**
   * F21: planned sessions a claude process started on between the plan and
   * their turn to open (another run, or Justin), so they were not opened.
   */
  lateLive: {name: string; pid: number; sessionId: string}[];
  layout: 'oneWindow' | 'perProject';
  /**
   * yukaf.22 --include-open: each workspace moved into a window this run
   * made, written BEFORE the move (movedAt null) and stamped after it, so
   * --undo can move it back to fromWindowId at fromIndex.
   */
  moved: MovedWorkspace[];
  /** Planned moves not made at run time (the workspace closed meanwhile, …). */
  notMoved: {name: string; reason: string; sessionId: string}[];
  /** Why the run opened nothing on purpose, or null. */
  refused: string | null;
  /**
   * home-base-yukaf.34: the unsent text typed back into the sessions this run
   * opened (open-restore.ts), each entry written before its one `cmux send`.
   * A dry run holds the plan ('wouldRestore').
   */
  restore: RestoreRecord;
  sections: InboxSection[];
  version: 1;
  windows: OpenWindow[];
}

/** `2026-10-18T12-34-56.789Z`: the ISO instant with no colon, for a file name. */
export function recordStamp(at: Date): string {
  return at.toISOString().replaceAll(':', '-');
}

export function opensDir(env: EnvLike): string {
  return join(threadsStateDir(env), 'opens');
}

/** Write or rewrite a record; null when written, else why not. */
export type RecordWriter = (
  path: string,
  record: OpenRecord,
  first: boolean,
) => string | null;

/**
 * The first write creates the file and refuses an existing one (`wx`); every
 * rewrite goes through a temporary file and a rename, so a crash mid-write
 * leaves the last good record, never half of one. Any JSON value: `--undo`
 * rewrites a record it parsed.
 */
export function writeJsonFile(
  path: string,
  value: unknown,
  first: boolean,
): string | null {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  try {
    if (first) {
      mkdirSync(join(path, '..'), {recursive: true});
      writeFileSync(path, text, {flag: 'wx'});
      return null;
    }
    // F22: a per-process name, so two writers never share a temporary file.
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, text);
    renameSync(temporary, path);
    return null;
  } catch (error) {
    return String(error);
  }
}

/** writeJsonFile for a thread open record. */
export function writeRecordFile(
  path: string,
  record: OpenRecord,
  first: boolean,
): string | null {
  return writeJsonFile(path, record, first);
}

// ---------------------------------------------------------------------------
// Applying the plan
// ---------------------------------------------------------------------------

const UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/iu;

/** `OK <payload>` → the payload; null for anything else. */
export function parseOk(stdout: string): string | null {
  return /^OK\s+(\S+)/u.exec(stdout.trim())?.[1] ?? null;
}

const windowListSchema = z.object({
  workspaces: z.array(z.object({id: z.string(), ref: z.string()})),
});

type WindowList =
  | {kind: 'read'; workspaces: {id: string; ref: string}[]}
  | {kind: 'unreadable'; reason: string};

/** One window's workspaces with their uuid and ref (measured 2026-10-18). */
async function listWindow(
  run: CmuxRunner,
  windowId: string,
): Promise<WindowList> {
  const args = ['--json', '--id-format', 'both', 'workspace', 'list'];
  const call = await run([...args, '--window', windowId]);
  if (call.kind === 'failed') return {kind: 'unreadable', reason: call.reason};
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.stdout) as unknown;
  } catch {
    return {
      kind: 'unreadable',
      reason: `cmux ${args.join(' ')} printed text that is not JSON`,
    };
  }
  const result = windowListSchema.safeParse(parsed);
  return result.success
    ? {kind: 'read', workspaces: result.data.workspaces}
    : {
        kind: 'unreadable',
        reason: `cmux ${args.join(' ')} printed JSON this code cannot read`,
      };
}

function callText(call: CmuxCall): string {
  return call.kind === 'failed'
    ? call.reason
    : `cmux printed ${JSON.stringify(call.stdout.trim())}`;
}

/**
 * The uuid of the workspace `new-workspace` just made: the payload itself when
 * it is one, else the window's entry with that ref, else the one id the
 * window gained. null when none of the three identifies it.
 */
async function resolveWorkspaceId(input: {
  known: ReadonlySet<string>;
  payload: string;
  run: CmuxRunner;
  windowId: string;
}): Promise<string | null> {
  if (UUID.test(input.payload)) return input.payload;
  const listed = await listWindow(input.run, input.windowId);
  if (listed.kind !== 'read') return null;
  const byRef = listed.workspaces.find((entry) => entry.ref === input.payload);
  if (byRef != null) return byRef.id;
  const gained = listed.workspaces.filter(
    (entry) => !input.known.has(entry.id.toUpperCase()),
  );
  return gained.length === 1 ? (gained[0]?.id ?? null) : null;
}

/**
 * D-LAYOUT for one window, saving the record after every cmux call. Returns
 * false at the first failure that must stop the run (a window or workspace
 * that could not be opened, or a record that could not be rewritten).
 */
/**
 * yukaf.22 item 5: which colour each session's workspace gets, from the
 * colour file read once before the run. No new picks are made.
 */
export function planColors(
  file: ColorFile | null,
  sessions: readonly {name: string; repo: string | null; sessionId: string}[],
): OpenColors {
  const colors: OpenColors = {
    failed: [],
    file: file?.path ?? '',
    noColor: [],
    planned: [],
    reason: null,
    set: [],
    state: file == null ? 'off' : file.kind,
  };
  if (file?.kind === 'failed') colors.reason = file.reason;
  // G1 (home-base-yukaf.25): no file still colours, from the built-in table.
  if (file == null || file.kind === 'failed') return colors;
  for (const session of sessions) {
    const color = projectColor(file, session.repo);
    if (color == null) {
      const repo = session.repo ?? 'a session with no repo';
      if (!colors.noColor.includes(repo)) colors.noColor.push(repo);
      continue;
    }
    colors.planned.push({
      color,
      name: session.name,
      sessionId: session.sessionId,
    });
  }
  return colors;
}

/**
 * Colour the workspaces one built window OPENED. A workspace moved in with
 * --include-open keeps its colour (G7, home-base-yukaf.25): --undo moves it
 * back but cannot restore a colour. Runs only after the record exists; each
 * set-color is saved; a failure is reported and never stops the run.
 */
async function colorWindow(
  window: OpenWindow,
  rec: OpenRecord,
  run: CmuxRunner,
  save: () => boolean,
): Promise<boolean> {
  const usable = rec.colors.state === 'read' || rec.colors.state === 'absent';
  if (!usable || window.windowId == null) return true;
  const ours = window.workspaces.flatMap((entry) =>
    entry.workspaceId == null
      ? []
      : [{sessionId: entry.sessionId, workspaceId: entry.workspaceId}],
  );
  for (const workspace of ours) {
    const planned = rec.colors.planned.find(
      (entry) => entry.sessionId === workspace.sessionId,
    );
    if (planned == null) continue;
    const call = await run(setColorArgs(workspace.workspaceId, planned.color));
    if (call.kind === 'failed') {
      rec.colors.failed.push({
        name: planned.name,
        reason: call.reason,
        workspaceId: workspace.workspaceId,
      });
    } else {
      rec.colors.set.push({...planned, workspaceId: workspace.workspaceId});
    }
    if (!save()) return false;
  }
  return true;
}

/** The Colours lines of the plan or outcome: one per fact, never silent. */
function colorLines(colors: OpenColors, dryRun: boolean): string[] {
  const file = tildeText(colors.file);
  const lines: string[] = [];
  switch (colors.state) {
    case 'off':
      return ['Off (--no-color): no workspace is coloured.'];
    case 'absent':
      // G1 (home-base-yukaf.25): cmux-arrange's built-in table still applies.
      lines.push(`Using the built-in project colours (no ${file}).`);
      break;
    case 'failed':
      return [
        `Skipped: ${file} could not be used, so no workspace is coloured: ${colors.reason ?? 'unknown reason'}`,
      ];
    case 'read':
      break;
  }
  const source =
    colors.state === 'absent' ? 'the built-in project colours' : file;
  const made = dryRun ? colors.planned : colors.set;
  if (made.length > 0) {
    lines.push(
      `${dryRun ? 'Would colour' : 'Coloured'} ${made.length} workspace${made.length === 1 ? '' : 's'} from ${source}:`,
      ...made.map((entry) => `  - ${entry.name}: ${entry.color}`),
    );
  }
  for (const repo of colors.noColor) {
    lines.push(
      colors.state === 'absent'
        ? `${repo} has no built-in project colour, so its workspaces are not coloured.`
        : `${repo} has no colour in ${file} (overrides, assigned, or a built-in project colour it does not exclude), so its workspaces are not coloured.`,
    );
  }
  for (const failure of colors.failed) {
    lines.push(
      `Setting the colour of "${failure.name}" failed (the workspace is open, only uncoloured): ${failure.reason}`,
    );
  }
  return lines.length === 0 ? ['Nothing to colour.'] : lines;
}

/** yukaf.22 --include-open: what applyWindow needs to move workspaces in. */
interface MoveStep {
  moved: MovedWorkspace[];
  moves: readonly MoveCandidate[];
  notMoved: OpenRecord['notMoved'];
  nowIso: () => string;
  readTree: () => Promise<CmuxTreeRead>;
}

/**
 * Move each planned workspace into the new window. Where it is now is read
 * from a fresh tree first (the plan can be seconds old); the record entry is
 * written BEFORE the call and stamped after it. A failed move is a failure
 * of that one workspace only: moving never destroys anything, so the rest go
 * on. Returns false only when the record could not be rewritten.
 */
async function moveWorkspacesIn(
  windowId: string,
  step: MoveStep,
  run: CmuxRunner,
  failures: string[],
  save: () => boolean,
): Promise<boolean> {
  if (step.moves.length === 0) return true;
  const tree = await step.readTree();
  if (tree.kind !== 'read') {
    failures.push(
      `the cmux tree could not be read before moving, so nothing was moved: ${tree.reason}`,
    );
    for (const move of step.moves) {
      step.notMoved.push({
        name: move.name,
        reason: 'the cmux tree could not be read before the move',
        sessionId: move.sessionId,
      });
    }
    return save();
  }
  for (const move of step.moves) {
    const at = locateWorkspace(tree.tree, move.workspaceId);
    if (at == null) {
      step.notMoved.push({
        name: move.name,
        reason: 'its workspace closed after the plan was made',
        sessionId: move.sessionId,
      });
      if (!save()) return false;
      continue;
    }
    const entry: MovedWorkspace = {
      failure: null,
      fromIndex: at.index,
      fromWindowCount: at.count,
      fromWindowId: at.windowId,
      fromWindowRef: at.windowRef,
      movedAt: null,
      name: move.name,
      sessionId: move.sessionId,
      toWindowId: windowId,
      workspaceId: move.workspaceId,
    };
    // D-RECORD for moves: written before the call, so a run that dies right
    // after the move still lets --undo find it in this window.
    step.moved.push(entry);
    if (!save()) return false;
    const call = await run([
      'move-workspace-to-window',
      '--workspace',
      move.workspaceId,
      '--window',
      windowId,
    ]);
    if (call.kind === 'failed') {
      entry.failure = call.reason;
      // G10 (home-base-yukaf.25): a failed answer is no proof it did not
      // move (a timeout can follow the move), so where it is is not claimed.
      failures.push(
        `moving "${move.name}" into the new window failed (${call.reason}); if cmux moved it anyway, thread open --undo moves it back to ${at.windowRef}`,
      );
    } else {
      entry.movedAt = step.nowIso();
    }
    if (!save()) return false;
  }
  return true;
}

async function applyWindow(
  window: OpenWindow,
  sessions: readonly PlannedSession[],
  run: CmuxRunner,
  failures: string[],
  save: () => boolean,
  beforeOpen: (session: PlannedSession) => Promise<'open' | 'skip' | 'stop'>,
  moveStep: MoveStep,
): Promise<boolean> {
  const opened = await run(['new-window']);
  const windowId = opened.kind === 'ok' ? parseOk(opened.stdout) : null;
  if (windowId == null) {
    failures.push(`opening a new window failed: ${callText(opened)}`);
    return false;
  }
  window.windowId = windowId;
  if (!save()) return false;

  // Snapshot the window's own default workspace BEFORE adding ours, so the one
  // closed later is identified by what was there (scripts/cmux-respawn.ts).
  const defaults = await listWindow(run, windowId);
  window.defaultWorkspaceIds =
    defaults.kind === 'read'
      ? defaults.workspaces.map((entry) => entry.id)
      : null;
  if (defaults.kind !== 'read') {
    failures.push(
      `reading the new window's default workspace failed, so it is left open: ${defaults.reason}`,
    );
  }
  if (!save()) return false;

  const known = new Set(
    (window.defaultWorkspaceIds ?? []).map((id) => id.toUpperCase()),
  );
  for (const session of sessions) {
    const go = await beforeOpen(session);
    if (go === 'stop') {
      save();
      return false;
    }
    if (go === 'skip') {
      if (!save()) return false;
      continue;
    }
    const made = await run([
      'new-workspace',
      '--name',
      session.name,
      '--cwd',
      session.checkout,
      '--command',
      session.command,
      '--window',
      windowId,
      '--focus',
      'false',
    ]);
    const payload = made.kind === 'ok' ? parseOk(made.stdout) : null;
    if (payload == null) {
      // F22 (home-base-yukaf.14): the call may have made a workspace anyway
      // (an answer this code cannot read, or a timeout after the work was
      // done). Whatever the window gained is recorded, so --undo sees it.
      const after = await listWindow(run, windowId);
      const gained =
        after.kind === 'read'
          ? after.workspaces.filter(
              (entry) => !known.has(entry.id.toUpperCase()),
            )
          : [];
      for (const entry of gained) {
        known.add(entry.id.toUpperCase());
        window.workspaces.push({
          sessionId: session.sessionId,
          workspaceId: entry.id,
          workspaceRef: entry.ref,
        });
      }
      failures.push(
        `opening "${session.name}" failed, and nothing after it was opened: ${callText(made)}${
          gained.length > 0
            ? ` (the window gained ${gained.map((entry) => entry.ref).join(', ')} anyway; it is in the record, so thread open --undo can close it)`
            : after.kind === 'read'
              ? ''
              : ` (the window could not be listed afterwards, so a workspace it may have made is not recorded: ${after.reason})`
        }`,
      );
      save();
      return false;
    }
    const workspaceId = await resolveWorkspaceId({
      known,
      payload,
      run,
      windowId,
    });
    if (workspaceId == null) {
      failures.push(
        `"${session.name}" opened as ${payload}, but its workspace uuid could not be read, so --undo will not close it`,
      );
    } else {
      known.add(workspaceId.toUpperCase());
    }
    window.workspaces.push({
      sessionId: session.sessionId,
      workspaceId,
      workspaceRef: UUID.test(payload) ? null : payload,
    });
    if (!save()) return false;
  }

  // yukaf.22 --include-open: the live sessions' own workspaces come in after
  // every new one exists, so the uuid-by-difference reading above never
  // mistakes a moved workspace for a new one.
  if (!(await moveWorkspacesIn(windowId, moveStep, run, failures, save))) {
    return false;
  }
  const movedHere = moveStep.moved.filter(
    (entry) => entry.toWindowId === windowId && entry.movedAt != null,
  );

  // Every session of this window became live meanwhile (F21), and nothing
  // was moved in: nothing of ours to order, and the default workspace is the
  // window's only one.
  if (window.workspaces.length === 0 && movedHere.length === 0) return true;

  // D-LAYOUT: the final order is set explicitly, newest first (opened and
  // moved together), so where new-workspace or a move inserts does not matter.
  const idOf = new Map<string, string>();
  for (const entry of window.workspaces) {
    const id = entry.workspaceId ?? entry.workspaceRef;
    if (id != null) idOf.set(entry.sessionId, id);
  }
  for (const entry of movedHere) idOf.set(entry.sessionId, entry.workspaceId);
  const order = window.sessionIds
    .map((sessionId) => idOf.get(sessionId))
    .filter((id): id is string => id != null);
  const reorder = await run([
    'reorder-workspaces',
    '--order',
    order.join(','),
    '--window',
    windowId,
  ]);
  window.reordered = reorder.kind === 'ok';
  if (reorder.kind === 'failed') {
    failures.push(`setting the newest-first order failed: ${reorder.reason}`);
  }
  if (!save()) return false;

  const strays = window.defaultWorkspaceIds;
  const [stray] = strays ?? [];
  if (strays?.length !== 1 || stray == null) {
    if (strays != null) {
      failures.push(
        `the new window had ${strays.length} default workspaces, not 1, so none was closed`,
      );
    }
    return true;
  }
  const now = await listWindow(run, windowId);
  const stillThere =
    now.kind === 'read' && now.workspaces.some((entry) => entry.id === stray);
  const ours = window.workspaces.some((entry) => entry.workspaceId === stray);
  if (!stillThere || ours) {
    if (now.kind !== 'read')
      failures.push(
        `the default workspace ${stray} was left open: ${now.reason}`,
      );
    return true;
  }
  const closed = await run([
    'close-workspace',
    '--workspace',
    stray,
    '--window',
    windowId,
  ]);
  if (closed.kind === 'ok') {
    window.strayClosed.push(stray);
  } else {
    failures.push(
      `closing the default workspace ${stray} failed: ${closed.reason}`,
    );
  }
  return save();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** "3 hours ago (2026-10-18 09:12)", local time; "unknown" when undated. */
export function activityWords(iso: string | null, now: Date): string {
  const ms = activityMs(iso);
  if (ms == null) return 'unknown';
  const at = new Date(ms);
  const stamp = `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
  return `${ageWords(at, now)} (${stamp})`;
}

function sectionWords(section: InboxSection): string {
  const info = sectionInfo(section);
  return `${info.emoji} ${info.title}`;
}

const RECORD_LABELS: readonly Field[] = [
  'Repo',
  'Section',
  'Last activity',
  'Checkout',
  'Workspace',
  'Pane',
  'Why',
].map((label) => ({label, value: ''}));

function recordBlock(
  title: string,
  fields: readonly Field[],
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
      labelWidth: fieldLabelWidth(RECORD_LABELS),
      width: style.width,
    }),
  ].join('\n');
}

function prose(text: string, style: OutputStyle, indent = BODY_COLUMN): string {
  return wrapHanging(text, {hang: indent, indent, width: style.width});
}

function where(
  entry: OpenWindow | null,
  group: number,
  groups: number,
  position: number,
): string {
  const window =
    groups === 1 ? 'the new window' : `new window ${group + 1} of ${groups}`;
  return `${window}, position ${position + 1}${entry?.repo == null ? '' : ` (${entry.repo})`}`;
}

const SINCE_SOURCE_WORDS: Readonly<Record<SinceSource, string>> = {
  config: 'componentConfig.thread.openSince',
  days: '--days',
  default:
    'the default; --since or componentConfig.thread.openSince changes it',
  since: '--since',
};

/** The plan or the outcome, in Justin's terminal style (one record per session). */
export function renderOpen(
  rec: OpenRecord,
  now: Date,
  style: OutputStyle,
  recordPath: string | null,
): string {
  const blocks: string[] = [];
  const header = (text: string, emoji: string): string =>
    sectionHeader(text, {color: style.color, emoji});
  const {filters} = rec;
  const days = filters.sinceWords;
  blocks.push(
    header(`thread open: unfinished sessions from the last ${days}`, '🪟'),
  );
  const layout =
    rec.layout === 'perProject'
      ? `one new cmux window per project (${plural(rec.windows.length, 'window', 'windows')})`
      : 'one new cmux window';
  blocks.push(
    fieldLines(
      [
        {
          label: 'Mode',
          value: rec.dryRun
            ? 'dry run: nothing opened, no record written'
            : 'opening',
        },
        // yukaf.22 item 7: every filter on its own labelled line, set or not.
        {
          label: 'Since',
          value: `${filters.since} (the last ${days}; ${SINCE_SOURCE_WORDS[filters.sinceSource]})`,
        },
        {
          label: 'Repo',
          value:
            filters.repos.length === 0
              ? 'every repo (--repo <name> narrows it)'
              : filters.repos.join(', '),
        },
        {
          label: 'Limit',
          value:
            filters.limit == null
              ? 'none (--limit <n> opens at most n)'
              : `at most ${plural(filters.limit, 'session', 'sessions')}, newest first`,
        },
        {
          label: 'Include open',
          value: filters.includeOpen
            ? 'on: sessions already open elsewhere are moved into the new window'
            : 'off (--include-open moves sessions already open elsewhere into the new window)',
        },
        {label: 'Layout', value: layout},
        // yukaf.34 item 2.
        {
          label: 'Restore',
          value: rec.restore.enabled
            ? 'on: unsent text stored for a session it opens is typed into the new input box, on one line, and never sent (--no-restore skips it)'
            : 'off (--no-restore): no stored draft is typed',
        },
        {label: 'Reopens', value: rec.sections.map(sectionWords).join('\n')},
        {
          label: 'Live sessions',
          value: `${rec.liveSessionsFound} found (ps, the cmux hook store, the status line of every Claude pane)`,
        },
        ...(recordPath == null
          ? []
          : [{label: 'Record', value: tildeText(recordPath)}]),
      ],
      {color: style.color, indent: BODY_COLUMN, width: style.width},
    ),
  );

  // Opened / Would open
  const groups = rec.windows;
  const openedTitle = rec.dryRun ? 'Would open' : 'Opened';
  const planned = new Map(rec.planned.map((entry) => [entry.sessionId, entry]));
  const openRecords: string[] = [];
  for (const [groupIndex, window] of groups.entries()) {
    for (const [position, sessionId] of window.sessionIds.entries()) {
      const session = planned.get(sessionId);
      if (session == null) continue;
      const made = window.workspaces.find(
        (entry) => entry.sessionId === sessionId,
      );
      if (!rec.dryRun && made == null) continue;
      const workspace = rec.dryRun
        ? `would open in ${where(window, groupIndex, groups.length, position)}`
        : `${made?.workspaceRef ?? 'opened'}${made?.workspaceId == null ? ' (uuid unknown)' : ` (${made.workspaceId})`}`;
      openRecords.push(
        recordBlock(
          sessionDisplayName(session.repoTag, session.title),
          [
            {label: 'Repo', value: session.repo ?? 'unknown'},
            {label: 'Section', value: sectionWords(session.section)},
            {
              label: 'Last activity',
              value: activityWords(session.lastActivityAt, now),
            },
            {label: 'Checkout', value: tildeText(session.checkout)},
            {label: 'Workspace', value: workspace},
          ],
          style,
        ),
      );
    }
  }
  blocks.push(
    header(`${openedTitle} (${openRecords.length})`, rec.dryRun ? '🔎' : '🚀'),
  );
  blocks.push(
    openRecords.length === 0
      ? prose('Nothing to open.', style)
      : spacedList(openRecords),
  );
  // yukaf.34 item 4: ✍️ Restored drafts, and ⚠️ Draft not restored.
  blocks.push(
    ...renderRestore(rec.restore, rec.dryRun, openRecords.length, style),
  );

  // yukaf.22 --include-open: the live sessions whose workspaces move in.
  if (filters.includeOpen) {
    const moveRecords: string[] = [];
    for (const [groupIndex, window] of groups.entries()) {
      for (const [position, sessionId] of window.sessionIds.entries()) {
        const move = rec.toMove.find((entry) => entry.sessionId === sessionId);
        if (move == null) continue;
        const made = rec.moved.find((entry) => entry.sessionId === sessionId);
        if (!rec.dryRun && made?.movedAt == null) continue;
        moveRecords.push(
          recordBlock(
            sessionDisplayName(move.repoTag, move.title),
            [
              {label: 'Repo', value: move.repo ?? 'unknown'},
              {label: 'Section', value: sectionWords(move.section)},
              {
                label: 'Last activity',
                value: activityWords(move.lastActivityAt, now),
              },
              {
                label: 'From',
                value: `${made?.fromWindowRef ?? move.fromWindowRef} (${made?.fromWindowId ?? move.fromWindowId}), position ${(made?.fromIndex ?? move.fromIndex) + 1}`,
              },
              {
                label: 'Workspace',
                value: rec.dryRun
                  ? `would move into ${where(window, groupIndex, groups.length, position)}; it keeps running, nothing is resumed`
                  : `${move.workspaceId}, moved into ${where(window, groupIndex, groups.length, position)}`,
              },
              ...(move.otherPanes > 0
                ? [
                    {
                      label: 'Panes',
                      value: `${rec.dryRun ? 'would be ' : ''}moved with its ${move.otherPanes} other ${move.otherPanes === 1 ? 'pane' : 'panes'} (shell splits or other non-Claude panes; --undo moves them back together)`,
                    },
                  ]
                : []),
              ...(move.leavesBlank
                ? [
                    {
                      label: 'Leaves',
                      value: `its window keeps a blank workspace: this run moves every workspace out of ${move.fromWindowRef}, and cmux leaves a blank one behind; --undo closes it again while it is still only an idle shell`,
                    },
                  ]
                : []),
            ],
            style,
          ),
        );
      }
    }
    blocks.push(
      header(
        `${rec.dryRun ? 'Would move' : 'Moved'} (${moveRecords.length})`,
        '🧲',
      ),
    );
    blocks.push(
      moveRecords.length === 0
        ? prose(
            'Nothing to move: no unfinished session is open elsewhere.',
            style,
          )
        : spacedList(moveRecords),
    );
    if (rec.notMoved.length > 0) {
      blocks.push(header(`Not moved (${rec.notMoved.length})`, '⏭️'));
      blocks.push(
        spacedList(
          rec.notMoved.map((entry) =>
            recordBlock(
              entry.name,
              [
                {label: 'Session', value: entry.sessionId},
                {label: 'Why', value: entry.reason},
              ],
              style,
            ),
          ),
        ),
      );
    }
  }

  // yukaf.22 item 5: one line per colour fact, set or skipped.
  if (rec.planned.length + rec.toMove.length > 0) {
    blocks.push(header('Colours', '🎨'));
    const lines = colorLines(rec.colors, rec.dryRun);
    // G7 (home-base-yukaf.25): said once, whenever something moves in.
    if (rec.toMove.length > 0 && rec.colors.state !== 'off') {
      lines.push(
        `Moved workspaces keep the colour they had: --undo moves them back but cannot restore a colour (${rec.toMove.length} ${rec.toMove.length === 1 ? 'workspace' : 'workspaces'}).`,
      );
    }
    blocks.push(lines.map((line) => prose(line, style)).join('\n'));
  }

  if (rec.overLimit.length > 0) {
    const total = rec.overLimit.length + (filters.limit ?? 0);
    blocks.push(
      header(`Not opened: over the limit (${rec.overLimit.length})`, '✂️'),
    );
    blocks.push(
      prose(
        `--limit ${filters.limit ?? '?'} kept the newest ${plural(filters.limit ?? 0, 'session', 'sessions')}. Pass --limit ${total} (or leave --limit off) to open these too.`,
        style,
      ),
    );
    blocks.push(
      spacedList(
        rec.overLimit.map((entry) =>
          recordBlock(
            sessionDisplayName(entry.repoTag, entry.title),
            [
              {label: 'Repo', value: entry.repo ?? 'unknown'},
              {label: 'Section', value: sectionWords(entry.section)},
              {
                label: 'Last activity',
                value: activityWords(entry.lastActivityAt, now),
              },
              {
                label: 'Workspace',
                value:
                  entry.action === 'move'
                    ? 'open elsewhere; it would have been moved in'
                    : 'it would have been opened',
              },
            ],
            style,
          ),
        ),
      ),
    );
  }

  if (rec.alreadyOpen.length > 0) {
    blocks.push(
      header(
        filters.includeOpen
          ? `Already open elsewhere, not moved (${rec.alreadyOpen.length})`
          : `Already open elsewhere (${rec.alreadyOpen.length}) — pass --include-open to move them into this window`,
        '✅',
      ),
    );
    blocks.push(
      spacedList(
        rec.alreadyOpen.map((entry) =>
          recordBlock(
            sessionDisplayName(entry.repoTag, entry.title),
            [
              {label: 'Repo', value: entry.repo ?? 'unknown'},
              {label: 'Section', value: sectionWords(entry.section)},
              {
                label: 'Last activity',
                value: activityWords(entry.lastActivityAt, now),
              },
              {
                label: 'Pane',
                value:
                  entry.command ??
                  `a live claude process${entry.pid == null ? '' : ` (pid ${entry.pid})`} outside any cmux pane`,
              },
              ...(entry.notMoved == null
                ? []
                : [{label: 'Why', value: `not moved: ${entry.notMoved}`}]),
            ],
            style,
          ),
        ),
      ),
    );
  }

  const {lateLive} = rec;
  if (lateLive.length > 0) {
    blocks.push(
      header(`Started elsewhere while this ran (${lateLive.length})`, '✅'),
    );
    blocks.push(
      prose(
        'A claude process started on these sessions after the plan was made (another thread open, or you), so they were not opened again.',
        style,
      ),
    );
    blocks.push(
      spacedList(
        lateLive.map((entry) =>
          recordBlock(
            entry.name,
            [
              {label: 'Session', value: entry.sessionId},
              {label: 'Process', value: `pid ${entry.pid}`},
            ],
            style,
          ),
        ),
      ),
    );
  }

  if (rec.skipped.length > 0) {
    blocks.push(header(`Skipped (${rec.skipped.length})`, '⏭️'));
    blocks.push(
      spacedList(
        rec.skipped.map((entry) =>
          recordBlock(
            sessionDisplayName(entry.repoTag, entry.title),
            [
              {label: 'Repo', value: entry.repo ?? 'unknown'},
              {label: 'Section', value: sectionWords(entry.section)},
              {
                label: 'Last activity',
                value: activityWords(entry.lastActivityAt, now),
              },
              {label: 'Why', value: entry.reason},
            ],
            style,
          ),
        ),
      ),
    );
  }

  if (rec.untracked.count > 0) {
    blocks.push(header(`Not opened: untracked (${rec.untracked.count})`, '❔'));
    blocks.push(
      prose(
        `${plural(rec.untracked.count, 'session', 'sessions')} from the last ${days} ${rec.untracked.count === 1 ? 'has' : 'have'} no session bead, so thread open does not reopen ${rec.untracked.count === 1 ? 'it' : 'them'}. Opening them (--include-untracked) is not built yet; --json lists them under untracked.`,
        style,
      ),
    );
  }

  blocks.push(header(`Cannot tell (${rec.cannotTell.length})`, '❓'));
  if (rec.cannotTell.length === 0) {
    blocks.push(
      prose(
        'None: every live Claude process showed which session it holds.',
        style,
      ),
    );
  } else {
    blocks.push(
      prose(
        `${plural(rec.cannotTell.length, 'live Claude process', 'live Claude processes')} could not be matched to a session, so ${rec.cannotTell.length === 1 ? 'it' : 'each'} may already hold one of the sessions above.`,
        style,
      ),
    );
    blocks.push(
      spacedList(
        rec.cannotTell.map((entry) =>
          recordBlock(
            entry.kind === 'pane'
              ? `Pane ${entry.surfaceRef ?? entry.surfaceId ?? '?'}`
              : entry.kind === 'background'
                ? `Background session process ${entry.pid ?? '?'}`
                : `Process ${entry.pid ?? '?'}`,
            [
              {
                label: 'Pane',
                value:
                  entry.workspaceId == null
                    ? `none${entry.tty == null ? '' : ` (tty ${entry.tty})`}`
                    : selectWorkspaceCommand(entry.workspaceId),
              },
              {label: 'Why', value: entry.detail},
            ],
            style,
          ),
        ),
      ),
    );
  }

  const notes: string[] = [];
  const {doneOrArchived, olderThanCutoff, otherRepo} = rec.hidden;
  if (olderThanCutoff > 0) {
    notes.push(
      `${plural(olderThanCutoff, 'older session was', 'older sessions were')} left out: no activity in the last ${days} (--since).`,
    );
  }
  if (otherRepo > 0) {
    notes.push(
      `${plural(otherRepo, 'session in another repo was', 'sessions in other repos were')} left out (--repo ${filters.repos.join(', ')}).`,
    );
  }
  for (const value of rec.unmatchedRepos) {
    notes.push(
      `--repo ${value}: no session from the last ${days} is in a repo with that folder name or project tag.`,
    );
  }
  for (const problem of rec.configProblems) notes.push(`⚠️ ${problem}`);
  if (doneOrArchived > 0) {
    notes.push(
      `${plural(doneOrArchived, 'done or archived session was', 'done or archived sessions were')} left out.`,
    );
  }
  if (rec.refused != null) notes.push(`⚠️ ${rec.refused}`);
  if (rec.failures.length > 0) {
    blocks.push(header(`Failed (${rec.failures.length})`, '🛑'));
    blocks.push(
      spacedList(rec.failures.map((text) => prose(`- ${text}`, style))),
    );
  }
  if (rec.dryRun && rec.planned.length > 0 && rec.refused == null) {
    notes.push('Run it again without --dry-run to open them.');
  }
  for (const note of notes) {
    blocks.push(
      wrapHanging(note, {
        hang: HEADER_COLUMN,
        indent: HEADER_COLUMN,
        width: style.width,
      }),
    );
  }
  return spacedList(blocks);
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

export interface OpenOptions {
  /** What was typed after `thread open`, for the record. */
  argv: string[];
  /** `--no-color` makes this false: no workspace is coloured (default true). */
  color?: boolean;
  cwd?: string;
  /** `--days N`, the alias of `--since Nd`; null when not given. */
  days: number | null;
  dryRun: boolean;
  env?: EnvLike;
  forceUnplaced: boolean;
  /** Raw `--include` values (comma lists allowed). */
  include: readonly string[];
  /** `--include-open`: move live sessions' workspaces into the new window. */
  includeOpen?: boolean;
  includeUntracked: boolean;
  json: boolean;
  /** `--limit`: open at most this many sessions, newest first. */
  limit?: number | null;
  /** `--list`: print the recorded runs instead (open-list.ts). */
  list?: boolean;
  now?: Date;
  perProject: boolean;
  /**
   * Raw `--repo` values (repeatable, comma lists allowed); absent when the
   * flag was not passed. Passed but naming no repo refuses (G6).
   */
  repos?: readonly string[];
  /**
   * yukaf.34: `--no-restore` makes this false: no stored draft is typed into
   * the sessions this run opens (default true).
   */
  restore?: boolean;
  /** Reserved for the --undo dispatch. */
  run: string | null;
  /** `--since 24h|3d|2w`; null when not given (then --days, then config). */
  since?: string | null;
  style?: OutputStyle;
  undo: boolean;
}

export interface OpenDeps {
  checkoutExists: (path: string) => boolean;
  /** `componentConfig.thread.openSince` and any problem reading it. */
  configSince: () => {
    problems: string[];
    since: string;
    source: 'config' | 'default';
  };
  /** F21: is a claude process holding this session NOW (ps argv)? */
  lateLive: LateLiveCheck;
  /** The process id written into the run lock (F21). */
  pid: number;
  readCandidates: () => Promise<CandidatesRead>;
  /** yukaf.22 item 5: cmux-arrange's colour file. */
  readColors: () => ColorFile;
  readLive: () => Promise<LiveSessions>;
  /** yukaf.22 --include-open: the cmux tree (where each workspace is). */
  readTree: () => Promise<CmuxTreeRead>;
  /**
   * yukaf.34: the draft restore's store, tree reads and clock; any left out
   * are the real ones. Its cmux calls always go through `run`.
   */
  restore: Partial<Omit<RestoreDeps, 'run'>>;
  run: CmuxRunner;
  writeRecord: RecordWriter;
}

/**
 * yukaf.34: the sessions this run OPENED, each with the one workspace it
 * made, in each window's newest-first order. A workspace moved in with
 * --include-open is not in a window's `workspaces`, so it is never a target.
 */
export function openedTargets(rec: OpenRecord): RestoreTarget[] {
  const planned = new Map(rec.planned.map((entry) => [entry.sessionId, entry]));
  const targets: RestoreTarget[] = [];
  for (const window of rec.windows) {
    for (const sessionId of window.sessionIds) {
      const session = planned.get(sessionId);
      const made = window.workspaces.filter(
        (entry) => entry.sessionId === sessionId,
      );
      const [first] = made;
      if (session == null || first == null) continue;
      targets.push({
        name: session.name,
        // F22: a failed new-workspace can record what the window gained, so
        // one session can hold two entries; neither is guessed at.
        problem:
          made.length > 1
            ? `the run recorded ${made.length} workspaces for this session (an open that failed part-way), so which one holds it cannot be told`
            : null,
        sessionId,
        workspaceId: made.length === 1 ? first.workspaceId : null,
        workspaceRef: first.workspaceRef,
      });
    }
  }
  return targets;
}

/** F21: a run lock older than this is left over from a run that died. */
export const OPEN_LOCK_STALE_MS = 10 * 60_000;

/** `opens/.lock`: held for a whole real run, so two runs never overlap. */
export function openLockPath(env: EnvLike): string {
  return join(opensDir(env), '.lock');
}

const lockSchema = z.object({at: z.string(), pid: z.number()});

/**
 * F21: take the run lock (`wx`, so exactly one run gets it). A lock whose
 * `at` is more than OPEN_LOCK_STALE_MS old is replaced; any other existing
 * lock, an unreadable one included, refuses the run.
 */
export function takeOpenLock(
  path: string,
  now: Date,
  pid: number,
):
  | {kind: 'failed'; reason: string}
  | {kind: 'held'; reason: string}
  | {kind: 'taken'} {
  const text = `${JSON.stringify({at: now.toISOString(), pid})}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(join(path, '..'), {recursive: true});
      writeFileSync(path, text, {flag: 'wx'});
      return {kind: 'taken'};
    } catch (error) {
      if ((error as {code?: unknown}).code !== 'EEXIST') {
        return {kind: 'failed', reason: String(error)};
      }
    }
    let held: z.infer<typeof lockSchema> | null = null;
    try {
      const parsed = lockSchema.safeParse(
        JSON.parse(readFileSync(path, 'utf8')) as unknown,
      );
      held = parsed.success ? parsed.data : null;
    } catch {
      held = null;
    }
    if (held == null) {
      return {
        kind: 'held',
        reason: `the run lock ${tildeText(path)} exists but cannot be read; if no thread open is running, delete it and run again`,
      };
    }
    const heldMs = Date.parse(held.at);
    const stale =
      Number.isFinite(heldMs) && now.getTime() - heldMs > OPEN_LOCK_STALE_MS;
    if (!stale) {
      return {
        kind: 'held',
        reason: `another thread open is running (pid ${held.pid}, since ${held.at}), and two runs at once would open the same sessions twice. Wait for it; if it died, delete ${tildeText(path)} (it is ignored after 10 minutes)`,
      };
    }
    try {
      rmSync(path, {force: true});
    } catch (error) {
      return {kind: 'failed', reason: String(error)};
    }
  }
  return {
    kind: 'held',
    reason: `the run lock ${tildeText(path)} was taken by another run while a stale one was replaced`,
  };
}

/** Remove the run lock, only when it is still this run's own. */
function releaseOpenLock(path: string, pid: number): void {
  try {
    const parsed = lockSchema.safeParse(
      JSON.parse(readFileSync(path, 'utf8')) as unknown,
    );
    if (parsed.success && parsed.data.pid === pid) rmSync(path, {force: true});
  } catch {
    // Already gone, or replaced: either way it is not ours to remove.
  }
}

/** Exit 0 opened (or nothing to open, or a dry run) · 1 a step failed · 2 refused, nothing written. */
export interface OpenResult {
  exitCode: 0 | 1 | 2;
  output: string;
  record: OpenRecord | null;
  recordPath: string | null;
}

function refuse(text: string): OpenResult {
  return {
    exitCode: 2,
    output: `thread open: refused: ${text}`,
    record: null,
    recordPath: null,
  };
}

/** `--include` values → the sections they add; an unknown one is a usage error. */
export function includedSections(
  raw: readonly string[],
): {sections: InboxSection[]} | {unknown: string[]} {
  const values = raw
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter((value) => value !== '');
  const unknown = values.filter(
    (value) => !OPEN_INCLUDABLE_SECTIONS.includes(value as InboxSection),
  );
  if (unknown.length > 0) return {unknown};
  return {sections: values as InboxSection[]};
}

const DAY_MS = 24 * 60 * 60_000;

/** The real `openSince` knob (config.ts), read only when no flag sets the window. */
function realConfigSince(
  cwd: string,
  env: EnvLike,
): ReturnType<OpenDeps['configSince']> {
  const config = resolveThreadConfig({cwd, env});
  return {
    // Only the openSince problem matters here; the others are not this run's.
    problems: config.problems.filter((problem) =>
      problem.includes('openSince'),
    ),
    since: config.openSince,
    source: config.openSinceSource === 'default' ? 'default' : 'config',
  };
}

/**
 * yukaf.22 item 2: the window, from --since, else --days (its alias), else
 * the openSince knob. Both flags at once, or a value parseSince refuses, is a
 * usage error (exit 2).
 */
function resolveWindow(
  options: OpenOptions,
  deps: Partial<OpenDeps>,
  cwd: string,
  env: EnvLike,
):
  | {
      problems: string[];
      since: string;
      sinceMs: number;
      source: SinceSource;
      words: string;
    }
  | {refusal: string} {
  const sinceFlag = options.since ?? null;
  if (sinceFlag != null && options.days != null) {
    return {
      refusal: 'pass --since or --days, not both (--days N is --since Nd)',
    };
  }
  if (sinceFlag != null) {
    const parsed = parseSince(sinceFlag);
    if (parsed.kind === 'bad') return {refusal: parsed.reason};
    return {
      problems: [],
      since: parsed.text,
      sinceMs: parsed.ms,
      source: 'since',
      words: parsed.words,
    };
  }
  if (options.days != null) {
    if (!Number.isFinite(options.days) || options.days <= 0) {
      return {refusal: '--days takes a number of days greater than 0'};
    }
    return {
      problems: [],
      since: `${options.days}d`,
      sinceMs: options.days * DAY_MS,
      source: 'days',
      words: plural(options.days, 'day', 'days'),
    };
  }
  const config = (deps.configSince ?? (() => realConfigSince(cwd, env)))();
  const parsed = parseSince(config.since);
  // config.ts refuses a bad value already; the default is the fallback here
  // too, so a knob that cannot be parsed never means "no window".
  const used =
    parsed.kind === 'ok' ? parsed : parseSince(THREAD_DEFAULT_OPEN_SINCE);
  if (used.kind !== 'ok') {
    return {refusal: `the default window ${THREAD_DEFAULT_OPEN_SINCE} is bad`};
  }
  return {
    problems: config.problems,
    since: used.text,
    sinceMs: used.ms,
    source: parsed.kind === 'ok' ? config.source : 'default',
    words: used.words,
  };
}

/** The real inbox, read in-process with no pane lookup (live-sessions.ts does liveness). */
async function realCandidates(
  cwd: string,
  env: EnvLike,
  days: number,
  now: Date,
): Promise<CandidatesRead> {
  const read = await readInbox({cwd, days, env, now, repo: null});
  if (read.kind === 'failed') return read;
  return {candidates: read.read.rows.map(candidateOf), kind: 'read'};
}

export async function openSessions(
  options: OpenOptions,
  deps: Partial<OpenDeps> = {},
): Promise<OpenResult> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? new Date();
  const style = options.style ?? outputStyle(process.stdout);

  // ---- 1. refusals: nothing is read or written before these pass ----
  // --undo (and --run) are undoOpen in ./open-undo (home-base-yukaf.2);
  // runThreadOpen routes them there, so this function only ever opens.
  if (options.undo || options.run != null) {
    return refuse(
      'openSessions only opens: thread open --undo (and --run) runs undoOpen in open-undo.ts.',
    );
  }
  if (options.includeUntracked) {
    return refuse(
      '--include-untracked is not built yet: untracked sessions are only counted in this version (home-base-yukaf.1).',
    );
  }
  const span = resolveWindow(options, deps, cwd, env);
  if ('refusal' in span) return refuse(span.refusal);
  const limit = parseLimit(options.limit ?? null);
  if (limit.kind === 'bad') return refuse(limit.reason);
  const repos = repoValues(options.repos ?? []);
  // G6 (home-base-yukaf.25): `--repo ''`, `--repo ,` or `--repo " "` would
  // otherwise mean every repo, and with --include-open move every workspace.
  if (options.repos != null && repos.length === 0) {
    return refuse(
      `--repo was passed but names no repo (${options.repos.length === 0 ? 'no value' : options.repos.map((value) => JSON.stringify(value)).join(', ')}); give a repo folder name or project tag, or leave --repo off for every repo.`,
    );
  }
  const filters: OpenFilters = {
    includeOpen: options.includeOpen === true,
    limit: limit.limit,
    repos,
    since: span.since,
    sinceMs: span.sinceMs,
    sinceSource: span.source,
    sinceWords: span.words,
  };
  const include = includedSections(options.include);
  if ('unknown' in include) {
    return refuse(
      `--include takes ${OPEN_INCLUDABLE_SECTIONS.join(', ')} (comma-separated); not: ${include.unknown.join(', ')}`,
    );
  }
  const sections = [
    ...OPEN_DEFAULT_SECTIONS,
    ...include.sections.filter(
      (section) => !OPEN_DEFAULT_SECTIONS.includes(section),
    ),
  ];

  // ---- 2. cmux: the socket, then a ping (respawn.ts rules) ----
  const socket = liveSocketPath(env);
  if ('reason' in socket) {
    return refuse(
      `cmux cannot be found: no CMUX_SOCKET_PATH, and ${socket.reason}`,
    );
  }
  const cmuxEnv = {...env, CMUX_QUIET: '1', CMUX_SOCKET_PATH: socket.path};
  const run = deps.run ?? realCmuxRunner(undefined, cmuxEnv);
  const ping = await run(['ping']);
  if (ping.kind === 'failed') {
    const allow = socketSettingsJson(socket.path).trim();
    return refuse(
      `cmux cannot be reached: ${ping.reason}\nIf this session is sandboxed, the sandbox blocks the cmux socket: add ${allow} to your Claude Code user settings, or retry with the sandbox disabled.`,
    );
  }

  // ---- F21: one real run at a time, held from before liveness is read ----
  const lockPath = openLockPath(env);
  const pid = deps.pid ?? process.pid;
  if (!options.dryRun) {
    const lock = takeOpenLock(lockPath, now, pid);
    if (lock.kind !== 'taken') {
      return refuse(
        lock.kind === 'held'
          ? lock.reason
          : `the run lock ${tildeText(lockPath)} could not be written, so nothing is opened: ${lock.reason}`,
      );
    }
  }
  try {
    // ---- 3. the sessions, and which of them are live ----
    const candidates = await (
      deps.readCandidates ??
      (async () =>
        await realCandidates(
          cwd,
          env,
          // The inbox counts whole days; planOpen applies the exact window.
          Math.max(1, Math.ceil(filters.sinceMs / DAY_MS)),
          now,
        ))
    )();
    if (candidates.kind === 'failed')
      return refuse(`the inbox could not be read: ${candidates.reason}`);
    const live = await (
      deps.readLive ??
      (async () => await readLiveSessions(realLiveSessionDeps(cmuxEnv)))
    )();
    if (live.kind === 'failed') {
      return refuse(
        `which sessions are running could not be read, so nothing is opened (a running session must never be resumed twice): ${live.reason}`,
      );
    }
    // yukaf.22 --include-open: where each live session's workspace is. An
    // unreadable tree refuses: a move needs its source to be known.
    const readTree = deps.readTree ?? (async () => await readCmuxTree(run));
    let tree: CmuxTree | null = null;
    if (filters.includeOpen) {
      const read = await readTree();
      if (read.kind !== 'read') {
        return refuse(
          `--include-open needs the cmux tree (which window holds each open session), and it could not be read: ${read.reason}`,
        );
      }
      tree = read.tree;
    }
    const plan = planOpen({
      candidates: candidates.candidates,
      checkoutExists: deps.checkoutExists ?? existsSync,
      includeOpen: filters.includeOpen,
      limit: filters.limit,
      live,
      now,
      // G2: cmux sets it in every pane (measured 2026-10-18, spawn.ts).
      ownWorkspaceId:
        env.CMUX_WORKSPACE_ID == null || env.CMUX_WORKSPACE_ID.trim() === ''
          ? null
          : env.CMUX_WORKSPACE_ID.trim(),
      repos: filters.repos,
      sections: new Set(sections),
      sinceMs: filters.sinceMs,
      tree,
    });
    const groups = windowGroups(plan.planned, options.perProject, plan.toMove);
    // yukaf.22 item 5: read once, before anything is written; set later.
    const colorFile =
      options.color === false
        ? null
        : (deps.readColors ?? (() => readColorFile(colorFilePath(env))))();
    const rec: OpenRecord = {
      ...plan,
      argv: options.argv,
      at: now.toISOString(),
      // G7: only what this run opens; moved workspaces keep their colour.
      colors: planColors(colorFile, plan.planned),
      configProblems: span.problems,
      cutoffDays: filters.sinceMs / DAY_MS,
      dryRun: options.dryRun,
      failures: [],
      filters,
      finishedAt: null,
      lateLive: [],
      layout: options.perProject ? 'perProject' : 'oneWindow',
      moved: [],
      notMoved: [],
      planned: groups.flatMap((group) => group.sessions),
      refused: null,
      restore: {enabled: options.restore !== false, entries: []},
      sections,
      toMove: groups.flatMap((group) => group.moves),
      version: 1,
      windows: groups.map((group) => ({
        defaultWorkspaceIds: null,
        reordered: false,
        repo: group.repo,
        sessionIds: group.order,
        strayClosed: [],
        windowId: null,
        workspaces: [],
      })),
    };
    if (
      plan.cannotTell.length > 0 &&
      plan.planned.length > 0 &&
      !options.forceUnplaced
    ) {
      rec.refused = `${plural(plan.cannotTell.length, 'live Claude process', 'live Claude processes')} (under Cannot tell) could not be matched to a session, so a ${options.dryRun ? 'real run would open' : 'run opens'} nothing: one of them may already hold a session above. Look at ${plan.cannotTell.length === 1 ? 'it' : 'them'}, then pass --force-unplaced to open anyway.`;
    }
    const finish = (exitCode: 0 | 1 | 2, path: string | null): OpenResult => ({
      exitCode,
      output: options.json
        ? JSON.stringify(rec, null, 2)
        : renderOpen(rec, now, style, path),
      record: rec,
      recordPath: path,
    });
    // yukaf.34: the restore's reads and writes; cmux only through `run`.
    const restoreDeps: RestoreDeps = {
      ...realRestoreDeps(run, env),
      ...deps.restore,
      run,
    };
    if (options.dryRun || plan.planned.length + plan.toMove.length === 0) {
      // yukaf.34 item 2: a dry run says which drafts a real run would type
      // (read-only: the store and one tree read), and types nothing.
      if (options.dryRun && rec.restore.enabled && rec.refused == null) {
        rec.restore.entries = await planRestores(
          rec.planned.map((session) => ({
            name: session.name,
            problem: null,
            sessionId: session.sessionId,
            workspaceId: null,
            workspaceRef: null,
          })),
          restoreDeps,
        );
      }
      return finish(0, null);
    }
    if (rec.refused != null) return finish(2, null);

    // ---- 4. D-RECORD: no record, no cmux write ----
    const write = deps.writeRecord ?? writeRecordFile;
    const path = join(opensDir(env), `${recordStamp(now)}.json`);
    const firstFailure = write(path, rec, true);
    if (firstFailure != null) {
      rec.failures.push(
        `the record ${tildeText(path)} could not be written, so nothing was opened: ${firstFailure}`,
      );
      return finish(1, null);
    }
    let saveFailed = false;
    const save = (): boolean => {
      const failure = write(path, rec, false);
      if (failure != null && !saveFailed) {
        saveFailed = true;
        rec.failures.push(
          `rewriting the record ${tildeText(path)} failed, so the run stopped (what it opened so far is listed above; close it by hand): ${failure}`,
        );
      }
      return failure == null;
    };

    // F21: right before each new workspace, ps is read again; a session a
    // claude process started on since the plan is not opened. ps unreadable
    // stops the run: "not live" is never assumed.
    const lateLive = deps.lateLive ?? realLateLiveCheck();
    const beforeOpen = async (
      session: PlannedSession,
    ): Promise<'open' | 'skip' | 'stop'> => {
      const check = await lateLive(session.sessionId);
      if (check.kind === 'notLive') return 'open';
      if (check.kind === 'live') {
        rec.lateLive.push({
          name: session.name,
          pid: check.pid,
          sessionId: session.sessionId,
        });
        return 'skip';
      }
      rec.failures.push(
        `ps could not be read again before opening "${session.name}", so it and everything after it was not opened (a running session must never be resumed twice): ${check.reason}`,
      );
      return 'stop';
    };

    // ---- 5. D-LAYOUT ----
    for (const [index, group] of groups.entries()) {
      const window = rec.windows[index];
      if (window == null) continue;
      const ok = await applyWindow(
        window,
        group.sessions,
        run,
        rec.failures,
        save,
        beforeOpen,
        {
          moved: rec.moved,
          moves: group.moves,
          notMoved: rec.notMoved,
          nowIso: () => new Date().toISOString(),
          readTree,
        },
      );
      if (!ok) break;
      // yukaf.22 item 5: colour what this built window holds of ours.
      if (!(await colorWindow(window, rec, run, save))) break;
    }

    // ---- 6. yukaf.34: type each opened session's unsent text back, unsent ----
    // Last, so every new pane has had the whole run to start. Never when the
    // record can no longer be rewritten (D-RECORD: no record, no write).
    if (rec.restore.enabled && !saveFailed) {
      await restoreDrafts(openedTargets(rec), rec.restore, restoreDeps, save);
    }
    rec.finishedAt = new Date().toISOString();
    save();
    return finish(
      rec.failures.length === 0 && !restoreFailed(rec.restore) ? 0 : 1,
      path,
    );
  } finally {
    if (!options.dryRun) releaseOpenLock(lockPath, pid);
  }
}

export async function runThreadOpen(options: OpenOptions): Promise<number> {
  // yukaf.22 item 6: --list reads the records only (no cmux, no ps).
  if (options.list === true) {
    if (options.undo || options.run != null) {
      console.error(
        'thread open: refused: --list only lists the runs; to undo one, run thread open --undo --run <stamp> on its own',
      );
      return 2;
    }
    const {runThreadOpenList} = await import('./open-list');
    return await runThreadOpenList({json: options.json});
  }
  if (options.undo || options.run != null) {
    // A dynamic import: open-undo imports this module, never the other way.
    const {runThreadUndo} = await import('./open-undo');
    return await runThreadUndo({
      dryRun: options.dryRun,
      json: options.json,
      run: options.run,
      undo: options.undo,
    });
  }
  const result = await openSessions(options);
  if (result.exitCode === 2 && result.record == null) {
    console.error(result.output);
    return result.exitCode;
  }
  await writeStdout(`${result.output}\n`);
  return result.exitCode;
}
