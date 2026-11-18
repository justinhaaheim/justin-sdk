/**
 * `thread inbox` — Justin's dashboard of every session he started (status
 * report v4, epic home-base-vzwbj.4 D5; the CARD and the ORDER are epic
 * home-base-j8q3e.1 D2–D5, built by home-base-j8q3e.1.1). With
 * componentConfig.thread.sessionBeads off, the legacy Claude-facing `thread
 * inbox` (inbox.ts) runs instead (v4 D6).
 *
 * SOURCES: every session in the sessions index. Each is loaded with
 * `loadSession` and its status derived LIVE (`deriveStatus`, 🏃 included: the
 * inbox is read while sessions run). THEN the window (`--days`, default 30)
 * applies to its activity — the newest line of its message log, else its
 * newest index sighting — EXCEPT that a 🛑 waiting or ❔ unknown session (or
 * one that could not be loaded) is never hidden by age (home-base-vzwbj.4.9
 * R5: a P0 left 31 days must not vanish). The one ❔ the window does hide is
 * the one that replaced ⚠️ Open work because the session's activity could not
 * be read (`activityUnread`, home-base-yd1co.2 D5): a deleted transcript must
 * not bring an old session back into view forever. What the window hid is
 * counted per status in one line, never dropped silently.
 *
 * AND EVERY OTHER SESSION (j8q3e.1 D6, home-base-j8q3e.1.2,
 * session-untracked.ts): each Claude Code session under ~/Dev in the window
 * that the index does not hold, found the way `repo-status repos` finds them,
 * under ❔ Not tracked — a full card when something is open or could not be
 * read, else one line. Those sessions are read while the tracked ones load, in
 * the same run cache.
 *
 * EACH SESSION IS A CARD (j8q3e.1 D2, session-card.ts): what Justin asked for,
 * where it is, the ONE thing he needs to do (D3), optional questions, how to
 * resume it. Its SECTION (D5) comes from the D3 rule that fired.
 *
 * THE ORDER (j8q3e.1 D5, Justin 2026-10-15: "more often than not I will be
 * needing a list of sessions from most recent to oldest"): by DEFAULT one
 * list of every session, newest last activity first, each card naming its
 * section; a SUMMARY at the top counts the sessions per section so "2 need
 * you" is seen before the list. `--by-status` prints the D5 sections in order,
 * `--by-repo` groups by repo; both newest first inside. Done and Archived are
 * shown only with --all, in every order. `--flat` (the old "no repo groups")
 * is kept as an alias of the default.
 *
 * EVERY CARD SAYS WHERE ITS PANE IS (home-base-j8q3e.7 D5-D8): the live
 * pid/tty join of pane-join.ts, and since home-base-j8q3e.17 the status line
 * confirmed by cmux's session file, run once per run (`lookupPanes`), and each
 * card prints its select-workspace command, "none found by the pid/tty join or
 * the status line", or "unknown (<reason>)" when a source could not check (a
 * tracked card then adds the pane recorded at session start, labelled as
 * recorded). The summary counts the open panes whose session has no request
 * record, and the live Claude panes neither source could place.
 *
 * NEVER DROPPED (rule 7): a session that cannot be loaded is a ❔ card under
 * "Check by hand", with what could not be read; index lines that do not parse
 * are counted and named at the end. Relative ages appear here (computed live)
 * and never in Part 1 (v4 design item 6c).
 */

import type {Field, OutputStyle} from '../cli-style';
import type {
  BeforeRestartFact,
  BeforeRestartRead,
  BeforeRestartReader,
  BeforeRestartState,
  UnplacedPaneHold,
} from './before-restart-state';
import type {ChainNamer} from './chain-names';
import type {HandoffStop} from './handoff-view';
import type {InputDraft} from './input-drafts';
import type {MessageLogRead} from './message-log';
import type {PaneLookup, UnplacedKind} from './pane-join';
import type {EnvLike} from './paths';
import type {
  CardGit,
  CardNeighbor,
  InboxSection,
  SessionCard,
  YouAsked,
} from './session-card';
import type {SessionSighting} from './session-index';
import type {SessionModel, UncommittedDirt} from './session-model';
import type {SessionStatus, StatusCounts} from './session-status';
import type {
  UnattributedDirt,
  UntrackedRead,
  UntrackedSession,
  UntrackedVerdict,
} from './session-untracked';

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
import {sdkRun} from '../sdk-invocation';
import {writeStdout} from '../write-stdout';
import {parseInstant} from './answer-store';
import {messageLogPath} from './archive';
import {
  BEFORE_RESTART_STATES,
  BEFORE_RESTART_WORDS,
  beforeRestartLine,
  realBeforeRestartReader,
  restartWhen,
} from './before-restart-state';
import {chainNamesKnob, registryChainNamer} from './chain-names';
import {resolveRepoTag, resolveThreadConfig} from './config';
import {dropUnusedFileMemo, fileMemoMark} from './file-memo';
import {inboxChainReaders, walkedSessionMarks} from './handoff-marks';
import {handoffStopOf} from './handoff-view';
import {
  filterIdleFor,
  idleForNote,
  type IdleForRead,
  idleMsAt,
  OLDER_SHOWN_GROUPS,
  olderHeading,
  type OlderShownReason,
  parseIdleFor,
} from './inbox-idle';
import {
  inboxJsonWithTimings,
  startTimings,
  timed,
  timedSession,
  timedStart,
  type TimingRecorder,
} from './inbox-timings';
import {listUnsentInputDrafts} from './input-drafts';
import {
  isSafeSessionId,
  readLastAssistantLineMemoized,
  readMessageLog,
} from './message-log';
import {lookupPanes as lookupLivePanes, realPaneSources} from './pane-join';
import {ageWords, requestStateText, tildeText} from './part-one';
import {pinnedFirst} from './pinned-projects';
import {readReadMarks, UNREAD_MARKER, unreadFor} from './read-marks';
import {
  type ChainLookup,
  type ChainSession,
  chainSessionOf,
  requestStatesOf,
} from './request-state';
import {CONTINUES_LABEL_PREFIX} from './session-bead';
import {
  buildCard,
  CARD_REQUESTS_SHOWN,
  cardGit,
  deriveAction,
  INBOX_SECTIONS,
  paneLineParts,
  sectionFor,
  sectionInfo,
  unreadableCard,
  withInputDraft,
} from './session-card';
import {type ChainFlags, chainFlagsOf} from './session-flags';
import {readSessionIndex} from './session-index';
import {
  createLoadCache,
  dirtOfGit,
  firstUserLine,
  lastAssistantLine,
  loadSession,
  measured,
  newestLogAt,
} from './session-model';
import {sessionDisplayName} from './session-name';
import {deriveStatus, statusCounts, statusFactsOf} from './session-status';
import {
  carriesTestDataMarker,
  defaultDevRoot,
  readUntracked,
  repeatKey,
  unattributedDirt,
  untrackedActivityAt,
  untrackedCard,
  untrackedLine,
  untrackedVerdict,
} from './session-untracked';
import {
  cachedTranscriptEnding,
  dropUnusedTranscriptMemory,
  evictTranscriptCache,
  transcriptCacheMark,
} from './transcript-cache';
import {
  ENDING_FACT_LABEL,
  endingLine,
  readTranscriptEnding,
  type SessionEnding,
  sessionEnding,
} from './transcript-ending';

export const INBOX_DEFAULT_DAYS = 30;

/** Why a card's pane is unknown when the caller ran no lookup (j8q3e.7 D6). */
export const PANES_NOT_LOOKED_UP = 'the pane lookup was not run';

/** Why there is no before-restart answer when the caller ran no reader (kwand.2). */
export const BEFORE_RESTART_NOT_READ =
  'the before-restart tab record was not read';

/** The card fact's label (kwand.2): one short line under "Where it is". */
export const BEFORE_RESTART_FACT_LABEL = 'Before the restart';

/** The card with its kwand.2 line: "🔁 was open before the 9:36pm restart: …". */
export function withBeforeRestart(
  card: SessionCard,
  fact: BeforeRestartFact,
  now: Date,
): SessionCard {
  return {
    ...card,
    facts: [
      ...card.facts,
      {label: BEFORE_RESTART_FACT_LABEL, value: beforeRestartLine(fact, now)},
    ],
  };
}

/** Why a row's ending is unknown before `rowEnding` ran (kwand.4). */
export const ENDING_NOT_READ = 'its transcript was not read';

/**
 * The card with its kwand.4 line, "✂️ cut off mid-turn at 6:39pm: …", for a
 * session cut off mid-turn only: a mark on every card would mark nothing
 * (home-base design principle: an alert must be rare enough to act on). The
 * JSON's `ending` carries every session's, replied and unknown too.
 */
export function withEnding(
  card: SessionCard,
  ending: SessionEnding,
  now: Date,
): SessionCard {
  if (ending.kind !== 'cutOff') return card;
  return {
    ...card,
    facts: [
      ...card.facts,
      {label: ENDING_FACT_LABEL, value: endingLine(ending, now)},
    ],
  };
}

/** The card's pane fact as liveness: a live pane holds a Claude process. */
function livenessOfPane(row: InboxRow): boolean | null {
  const pane = row.card.paneFact;
  return pane.kind === 'live' ? true : pane.kind === 'none' ? false : null;
}

/**
 * home-base-kwand.4: a row's ending. The transcript is the loaded model's (or
 * the untracked scan's); the cache gives its walk, else it is read here. Live
 * is the card's pane fact: a live pane holds a Claude process; unknown when
 * the lookup could not tell (D5: a separate fact, never hiding a cut-off).
 *
 * `live` (home-base-kwand.7): a caller that has proven by its own join that a
 * Claude process runs the session passes true, in place of the pane fact.
 */
export function rowEnding(
  row: InboxRow,
  now: Date,
  live: boolean | null = livenessOfPane(row),
): SessionEnding {
  let path: string | null = null;
  let lastRecordAt: string | null = null;
  if (row.loaded != null) {
    const {transcript} = row.loaded.model;
    path = transcript.path;
    if (path == null) {
      return {
        kind: 'unknown',
        reason: transcript.lastRecordAt.ok
          ? 'its transcript was not found'
          : `its transcript was not found: ${transcript.lastRecordAt.reason}`,
      };
    }
    lastRecordAt = transcript.lastRecordAt.ok
      ? transcript.lastRecordAt.value
      : null;
  } else if (row.untracked != null) {
    path = row.untracked.session.transcriptPath;
    const activity = row.untracked.session.lastActivityAt;
    lastRecordAt = activity.ok ? activity.value : null;
  } else {
    return {
      kind: 'unknown',
      reason: `the session could not be loaded${row.unreadable == null ? '' : `: ${row.unreadable}`}`,
    };
  }
  const ending = cachedTranscriptEnding(path) ?? readTranscriptEnding(path);
  return sessionEnding(ending, {lastRecordAt, live, now});
}

/** One session of the before set as `--before-restart` and the JSON list it. */
export interface BeforeRestartEntry {
  fact: BeforeRestartFact;
  /** The inbox row, or null when the inbox has none (not tracked and not found, or hidden). */
  row: InboxRow | null;
  sessionId: string;
}

/**
 * home-base-kwand.2: every session of the before set, grouped by the state
 * now in BEFORE_RESTART_STATES order, newest activity first inside each group
 * (sessions with no row, so no known activity, last). A session the inbox has
 * no row for is still listed: the record is the authority, not the window.
 */
export function beforeRestartGroups(
  read: InboxRead,
): {entries: BeforeRestartEntry[]; state: BeforeRestartState}[] {
  if (!read.beforeRestart.ok) return [];
  const rowById = new Map(read.rows.map((row) => [row.sessionId, row]));
  // A folded line (F6) stands for several sessions: each finds its row.
  for (const row of read.rows) {
    for (const id of row.repeats?.sessionIds ?? []) {
      if (!rowById.has(id)) rowById.set(id, row);
    }
  }
  const entries: BeforeRestartEntry[] = [...read.beforeRestart.facts.entries()]
    .map(([sessionId, fact]) => ({
      fact,
      row: rowById.get(sessionId) ?? null,
      sessionId,
    }))
    // home-base-kwand.8: under --idle-for only sessions known to be idle are
    // listed; one with no row has no activity to date (rule 7), and one the
    // filter removed must not come back as "not in this inbox".
    .filter((entry) => read.idleFor == null || entry.row != null);
  const activity = (entry: BeforeRestartEntry): number =>
    parseInstant(entry.row?.lastActivityAt ?? '') ?? -Infinity;
  return BEFORE_RESTART_STATES.map((state) => ({
    entries: entries
      .filter((entry) => entry.fact.state === state)
      .sort((a, b) => activity(b) - activity(a)),
    state,
  })).filter((group) => group.entries.length > 0);
}

/** The JSON's top-level `beforeRestart` (kwand.2): the whole before set, grouped. */
export function beforeRestartJson(read: InboxRead) {
  const answer = read.beforeRestart;
  if (!answer.ok) return {ok: false as const, reason: answer.reason};
  const groups = beforeRestartGroups(read);
  return {
    counts: Object.fromEntries(
      groups.map((group) => [group.state, group.entries.length]),
    ) as Partial<Record<BeforeRestartState, number>>,
    ok: true as const,
    restartAt: answer.restartAt,
    restartKind: answer.restartKind,
    screens: answer.screens,
    sessions: groups.flatMap((group) =>
      group.entries.map((entry) => ({
        ...entry.fact,
        // Whether the inbox has a row for it; its title when it does.
        inInbox: entry.row != null,
        lastActivityAt: entry.row?.lastActivityAt ?? null,
        sessionId: entry.sessionId,
        title: entry.row?.title ?? null,
      })),
    ),
    sessionsTotal: answer.facts.size,
    source: answer.source,
    tabsWithSession: answer.tabsWithSession,
    // kwand.12: each live Claude pane the join could not place, what it could
    // hold, and how many of these sessions it leaves unknown.
    unplaced: answer.unplaced,
  };
}

/** kwand.12: one unmatched pane as the text inbox names it. */
function unplacedPaneWords(pane: UnplacedPaneHold): string {
  const unknown = `${pane.sessionsUnknown} ${pane.sessionsUnknown === 1 ? 'session' : 'sessions'} left unknown`;
  switch (pane.hold.kind) {
    case 'session':
      return `${pane.surface} shows session ${pane.hold.sessionId} on its status line, so it holds only that one (${unknown})`;
    case 'matched':
      return `${pane.surface}'s Claude process is one the tools already matched to running session ${pane.hold.sessionIds.join(' and ')}, so it holds no other session (${unknown})`;
    case 'checkouts':
      return `${pane.surface} runs Claude in ${pane.hold.checkouts.map((dir) => tildeText(dir)).join(' and ')}, so it could hold a session of that repo (${unknown})`;
    case 'anything':
      return `${pane.surface} could hold any session: ${tildeText(pane.hold.reason)} (${unknown})`;
  }
}

/** j8q3e.1 D5: newest first (the default), by D5 section, or by repo. */
export type InboxOrder = 'recent' | 'repo' | 'status';

export interface InboxRow {
  /**
   * home-base-kwand.2: the tab this session was in before the last restart and
   * what that is now; null for a session that was in no recorded tab (or when
   * the before set could not be read: `InboxRead.beforeRestart` says which).
   */
  beforeRestart: BeforeRestartFact | null;
  /** The card (j8q3e.1 D2): every field the printed inbox and the JSON show. */
  card: SessionCard;
  /**
   * D6 (home-base-j8q3e.1.2): an untracked session with nothing open found is
   * ONE line; every other session is a full card.
   */
  display: 'card' | 'line';
  /**
   * home-base-kwand.4 (G12, D5): how the session's last turn ended, from its
   * main transcript (transcript-ending.ts), with liveness beside it. Unknown,
   * with the reason, when it could not be told.
   */
  ending: SessionEnding;
  /**
   * home-base-kwand.5 (D4): Justin's flags (⭐ and any other emoji) on this
   * session's chain: the union over every session of the chain, with the
   * labels that do not decode and the sessions that could not be read. Null
   * when the session has no session bead loaded to carry them; absent only
   * from a row built outside readInbox.
   */
  flags?: ChainFlags | null;
  /** The git facts the card reads; null for a session that did not load. */
  git: CardGit | null;
  /**
   * home-base-89c8h.3: why its handoff stopped short, or null. Null on a row
   * with no session bead to read too: `unreadable` says which of those it is,
   * and an untracked session has no handoff records.
   */
  handoff: HandoffStop | null;
  /**
   * home-base-kwand.8 (G4): milliseconds from `lastActivityAt` to the read's
   * clock, or null when the last activity cannot be dated (never counted as
   * idle, critical rule 7). Absent only from a row built outside readInbox.
   */
  idleMs?: number | null;
  /**
   * D-DRAFTS (home-base-yukaf.4): the live unsent text the drafts store holds
   * for this session, or null when it holds none (or could not be read: then
   * `InboxRead.inputDrafts` says so).
   */
  inputDraft: InboxInputDraft | null;
  /** The newest activity known (ISO), or null when nothing dates it. */
  lastActivityAt: string | null;
  /**
   * D-READ-STATE (home-base-yukaf.9): the `at` of the newest assistant line in
   * the session's message log — Claude's last activity, which Justin's own
   * prompts do not bump. Null when the log has none or could not be read.
   */
  lastAssistantAt: string | null;
  /** Present when the session loaded; null for an unreadable row. */
  loaded: {
    counts: StatusCounts;
    model: SessionModel;
    status: SessionStatus;
  } | null;
  /**
   * home-base-kwand.8 (G4): why a row whose last activity is older than the
   * `--days` window is shown anyway; null when it is inside the window or
   * cannot be dated. Absent only from a row built outside readInbox.
   */
  olderShown?: OlderShownReason | null;
  /**
   * F6 (home-base-j8q3e.1.10): this one-liner stands for `count` sessions
   * whose repo and first message match (`repeatKey`); it is the newest of them
   * and `sessionIds` names every one, itself first. Null = not folded.
   */
  repeats: {
    count: number;
    oldestAt: string | null;
    sessionIds: string[];
  } | null;
  repo: string | null;
  section: InboxSection;
  sessionBeadId: string | null;
  sessionId: string;
  startedAt: string | null;
  title: string;
  /** False for a session with no session bead (D6, section Not tracked). */
  tracked: boolean;
  /**
   * D-READ-STATE: Claude has written since Justin's newest read mark, or he
   * never marked it, or his newest mark is unread (read-marks.ts). Null when
   * the marks could not be read or `lastAssistantAt` is null: never false
   * for "could not tell" (rule 7).
   */
  unread: boolean | null;
  /** What could not be read (a path and why), or null. */
  unreadable: string | null;
  /** D6's facts and verdict; null for a tracked session. */
  untracked: {session: UntrackedSession; verdict: UntrackedVerdict} | null;
}

/** A row's live draft, as the inbox and its JSON carry it. */
export type InboxInputDraft = Pick<
  InputDraft,
  'at' | 'sentMatch' | 'surfaceId' | 'text' | 'workspaceId'
>;

/**
 * How the drafts store was read for this inbox: the live drafts no listed
 * session carries (another repo, outside the window, a session the inbox
 * does not know), and the store files that could not be read; or why the
 * store could not be read at all (critical rule 7: never "no drafts").
 */
export type InboxDrafts =
  | {
      failures: string[];
      kind: 'read';
      /** Why a draft could not be checked against what was sent; it stays shown. */
      unchecked: string[];
      unshown: (InboxInputDraft & {sessionId: string})[];
    }
  | {kind: 'failed'; reason: string};

function newest(...values: (string | null | undefined)[]): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const value of values) {
    if (value == null) continue;
    const ms = parseInstant(value);
    if (ms != null && ms > bestMs) {
      best = value;
      bestMs = ms;
    }
  }
  return best;
}

/** "3 hours ago" for the card's heading; null when nothing dates it. */
function ageOf(iso: string | null, now: Date): string | null {
  if (iso == null) return null;
  const ms = parseInstant(iso);
  return ms == null ? null : ageWords(new Date(ms), now);
}

/** What in a loaded model could not be read, for the card. */
function unreadableOf(model: SessionModel): string | null {
  const parts: string[] = [];
  if (
    !model.git.branch.ok &&
    model.git.branch.reason.startsWith('checkout unreadable:')
  ) {
    parts.push(
      model.git.branch.reason.slice('checkout unreadable:'.length).trim(),
    );
  }
  parts.push(...model.beads.problems);
  if (model.beads.session == null && model.beads.sessionMissing != null) {
    parts.push(model.beads.sessionMissing);
  }
  return parts.length === 0 ? null : [...new Set(parts)].join('; ');
}

export interface InboxRead {
  /**
   * home-base-kwand.2: what was open before the last restart, per session, or
   * why it could not be told. The facts cover sessions with no row too.
   */
  beforeRestart: BeforeRestartRead;
  /** Index lines that could not be parsed: named, never dropped silently. */
  corrupt: {lineNumber: number; reason: string}[];
  /**
   * R5: sessions older than the window that it hid, counted by status kind
   * (waiting is never hidden, so never here; unknown only as the activityUnread
   * one, home-base-yd1co.2 D5 and `neverHiddenByAge`).
   */
  hiddenByAge: Partial<Record<SessionStatus['kind'], number>>;
  /**
   * home-base-kwand.8 (G4): `--idle-for`, what it left out and why; null or
   * absent when no idle filter was applied (filterIdleFor sets it).
   */
  idleFor?: IdleForRead | null;
  indexPath: string;
  /** D-DRAFTS: how the drafts store was read, and the drafts no row shows. */
  inputDrafts: InboxDrafts;
  /** No index file yet (nothing ever recorded) — a measured answer. */
  missing: boolean;
  /** j8q3e.7 D6: the run's live pane lookup, once, or why it failed. */
  panes: PaneLookup;
  /** D-READ-STATE: how Justin's read marks were read (every `unread` is null when not). */
  readMarks: {kind: 'failed'; reason: string} | {kind: 'read'};
  rows: InboxRow[];
  /**
   * home-base-j8q3e.16: every loaded session's dirt, test sessions included,
   * which the per-checkout note is built from (`unattributedOfListed`).
   */
  sessionDirt: SessionDirt[];
  /**
   * F5 (home-base-j8q3e.1.10): sessions whose first message carries the
   * test-data marker. Never a card or a line: counted in one note, and listed
   * here (and in the JSON) so none is dropped silently.
   */
  testSessions: {
    lastActivityAt: string | null;
    repo: string | null;
    sessionId: string;
  }[];
  /** D6: how the sessions with no session bead were found, and what was not. */
  untracked: Omit<UntrackedRead, 'sessions'>;
}

/** One session's part in the per-checkout note (home-base-j8q3e.16). */
export interface SessionDirt {
  dirt: UncommittedDirt;
  sessionId: string;
}

/** The session's dirt, tracked or not; null when its checkout's is unknown. */
export function sessionDirtOfRow(row: InboxRow): SessionDirt | null {
  const dirt =
    row.untracked != null
      ? row.untracked.session.dirt
      : row.loaded != null
        ? dirtOfGit(row.loaded.model.git)
        : null;
  return dirt == null ? null : {dirt, sessionId: row.sessionId};
}

/**
 * home-base-j8q3e.16: the per-checkout note, over tracked and untracked
 * sessions alike. Only a session in `listed` can claim a file, because only its
 * card can show that file. A file claimed only by a session this run hides
 * (done, archived, or a test session) stays in the note: real uncommitted work
 * must never vanish with a hidden card.
 */
export function unattributedOfListed(
  sources: readonly SessionDirt[],
  listed: ReadonlySet<string>,
): UnattributedDirt[] {
  return unattributedDirt(
    sources.map(({dirt, sessionId}) => ({
      dirt: listed.has(sessionId) ? dirt : {...dirt, own: measured([])},
    })),
  );
}

/** Newest activity first, undated last: the inbox's order (and `thread sessions`'). */
export function byNewest(a: InboxRow, b: InboxRow): number {
  const am = a.lastActivityAt == null ? null : parseInstant(a.lastActivityAt);
  const bm = b.lastActivityAt == null ? null : parseInstant(b.lastActivityAt);
  return (bm ?? -Infinity) - (am ?? -Infinity);
}

/** F5: a row whose session's whole first message carries the marker. */
function isTestSession(row: InboxRow): boolean {
  if (row.untracked != null) return row.untracked.session.testDataMarker;
  if (row.loaded == null) return false;
  const first = firstUserLine(row.loaded.model.log);
  return first.ok && carriesTestDataMarker(first.value?.text ?? null);
}

/**
 * F6 (home-base-j8q3e.1.10): one-liners with the same repo and first message
 * (`repeatKey`) become ONE line, at the newest one's place, carrying the
 * count. Only one-liners fold — a card is never hidden inside a count — and
 * the fold is over the whole list, not only neighbours: life's daily runs are
 * one a day, so other sessions sit between them (measured 2026-10-15). A line
 * whose session has a live cmux pane (j8q3e.7 D7) never folds: a folded line
 * cannot name each session's pane.
 */
export function foldRepeats(rows: readonly InboxRow[]): InboxRow[] {
  const groups = new Map<string, InboxRow[]>();
  for (const row of [...rows].sort(byNewest)) {
    if (row.display !== 'line' || row.untracked == null) continue;
    if (row.card.paneFact.kind === 'live') continue;
    const key = repeatKey(
      row.untracked.session.repo,
      row.untracked.session.firstMessage,
    );
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const folded = new Set<string>();
  const representative = new Map<string, InboxRow>();
  for (const members of groups.values()) {
    const [newestRow] = members;
    if (newestRow == null || members.length < 2) continue;
    representative.set(newestRow.sessionId, {
      ...newestRow,
      repeats: {
        count: members.length,
        oldestAt: members.at(-1)?.lastActivityAt ?? null,
        sessionIds: members.map((member) => member.sessionId),
      },
    });
    for (const member of members.slice(1)) folded.add(member.sessionId);
  }
  return rows
    .filter((row) => !folded.has(row.sessionId))
    .map((row) => representative.get(row.sessionId) ?? row);
}

/**
 * F5 then F6 (home-base-j8q3e.1.10): the test sessions taken out (counted and
 * listed, never a card or a line), then the repeated one-liners folded.
 */
export function shapeRows(
  rows: readonly InboxRow[],
): Pick<InboxRead, 'rows' | 'testSessions'> {
  return {
    rows: foldRepeats(rows.filter((row) => !isTestSession(row))),
    testSessions: rows.filter(isTestSession).map((row) => ({
      lastActivityAt: row.lastActivityAt,
      repo: row.repo,
      sessionId: row.sessionId,
    })),
  };
}

/** How many sessions a row stands for (a folded line, F6, is several). */
export function sessionsIn(row: InboxRow): number {
  return row.repeats?.count ?? 1;
}

/** How many sessions the inbox loads at once (F7: the bead's pool of 8). */
export const INBOX_CONCURRENCY = 8;

/**
 * `fn` over `items`, at most `limit` at a time; the results in the ITEMS'
 * order, whatever order they finish in.
 */
async function mapConcurrently<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const position = next;
      next += 1;
      const item = items[position] as T;
      results[position] = await fn(item);
    }
  };
  await Promise.all(
    Array.from({length: Math.max(1, Math.min(limit, items.length))}, worker),
  );
  return results;
}

/**
 * R5 (home-base-vzwbj.4.9): the statuses the `--days` window never hides — 🛑
 * waiting, ⏳ export behind, and ❔ unknown, except the ❔ that replaced ⚠️
 * Open work because the session's activity could not be read
 * (`activityUnread`, home-base-yd1co.2 D5), which is hidden by age exactly as
 * the ⚠️ was.
 */
export function neverHiddenByAge(status: SessionStatus): boolean {
  if (status.kind === 'waiting' || status.kind === 'exportBehind') return true;
  return status.kind === 'unknown' && status.activityUnread !== true;
}

/** One inbox load; `readInbox` (below) is the entry point. */
async function readInboxOnce(input: {
  /**
   * home-base-kwand.2: reads what was open before the last restart and joins
   * it with this run's pane lookup. Omitted or null: not read, and every row's
   * `beforeRestart` is null with the read saying why.
   */
  beforeRestart?: BeforeRestartReader | null;
  /**
   * home-base-l2ejg.11: names a chain whose session bead holds no `chain:`
   * label, from the registry, by its first session (registryChainNamer). It
   * writes no bead. Absent or null: only the labels name chains. Used only
   * where componentConfig.thread.chainNames is on in `cwd`.
   */
  chainNamer?: ChainNamer | null;
  /** Sessions loaded at once; default INBOX_CONCURRENCY. 1 = one at a time. */
  concurrency?: number;
  cwd: string;
  days: number;
  /** D6: untracked sessions are listed only under this directory (~/Dev). */
  devRoot?: string;
  env: EnvLike;
  /**
   * home-base-kwand.2: `--before-restart`. A session that was in a tab before
   * the restart is never hidden by age.
   */
  keepBeforeRestart?: boolean;
  /**
   * j8q3e.7 D6: the live pane lookup, run once per inbox run. Omitted, no
   * lookup runs and every card says its pane is unknown — `thread inbox`
   * passes the real one; tests pass a fake; a hook (workspace naming) none.
   */
  lookupPanes?: () => Promise<PaneLookup>;
  now: Date;
  repo: string | null;
  /** home-base-9uzxw.2 (D-PERF): times each phase and counts its spawns. */
  timings?: TimingRecorder | null;
}): Promise<
  {kind: 'failed'; reason: string} | {kind: 'read'; read: InboxRead}
> {
  const {cwd, env, now} = input;
  const read = timed(input.timings, 'sessions index', () =>
    readSessionIndex(env),
  );
  if (read.kind === 'failed') {
    return {
      kind: 'failed',
      reason: `the sessions index is unreadable: ${read.path}: ${read.error}`,
    };
  }
  // Started first, so cmux and ps run while the sessions load.
  const pendingPanes: Promise<PaneLookup> =
    input.lookupPanes == null
      ? Promise.resolve({ok: false, reason: PANES_NOT_LOOKED_UP})
      : timed(input.timings, 'pane lookup', input.lookupPanes);
  // home-base-kwand.2: the before set is read now; its state joins the panes.
  const readBefore = input.beforeRestart;
  const pendingBefore: Promise<BeforeRestartRead> =
    readBefore == null
      ? Promise.resolve({ok: false, reason: BEFORE_RESTART_NOT_READ})
      : timed(
          input.timings,
          'before restart',
          async () => await readBefore(pendingPanes),
        );
  // No index yet is a measured answer (no session bead was ever filed): there
  // are no tracked sessions, and every session is listed as untracked (D6).
  const index =
    read.kind === 'missing'
      ? {corrupt: [], path: read.path, sessions: []}
      : read;
  // D3 rule 3: a successor is named by its session BEAD (`continued-by:`);
  // the index turns it into the session id its resume command needs.
  const sessionIdOfBead = new Map<string, string>();
  for (const indexed of index.sessions) {
    for (const sighting of indexed.sightings) {
      if (sighting.event === 'created') {
        sessionIdOfBead.set(sighting.beadId, indexed.sessionId);
      }
    }
  }
  // D-DRAFTS (home-base-yukaf.4): the live drafts, read once. A session with
  // one is never hidden by age: the text exists nowhere else.
  // home-base-p05kz.3 item 7: a draft all of whose text went out is not shown.
  const draftList = timed(input.timings, 'drafts store', () =>
    listUnsentInputDrafts(env),
  );
  const liveDrafts = new Map<string, InboxInputDraft>();
  if (draftList.kind === 'read') {
    for (const entry of draftList.drafts) {
      liveDrafts.set(entry.sessionId, {
        at: entry.draft.at,
        sentMatch: entry.draft.sentMatch,
        surfaceId: entry.draft.surfaceId,
        text: entry.draft.text,
        workspaceId: entry.draft.workspaceId,
      });
    }
  }
  const since = now.getTime() - input.days * 24 * 60 * 60_000;
  const wantRepo = input.repo?.trim().toLowerCase() ?? null;
  const rows: InboxRow[] = [];
  const hiddenByAge: Partial<Record<SessionStatus['kind'], number>> = {};
  const candidates: {
    activity: string | null;
    indexed: (typeof index.sessions)[number];
    lastAssistantAt: string | null;
    old: boolean;
    sighting: SessionSighting;
  }[] = [];
  const endLogs = timedStart(input.timings, 'message logs');
  for (const indexed of index.sessions) {
    const sighting =
      indexed.sightings.find((entry) => entry.event === 'created') ??
      indexed.sightings[0];
    if (sighting == null) continue;
    if (
      wantRepo != null &&
      (sighting.repo ?? '').toLowerCase() !== wantRepo &&
      sighting.checkoutPath.toLowerCase() !== wantRepo &&
      !indexed.sightings.some(
        (entry) => entry.checkoutPath.toLowerCase() === wantRepo,
      )
    ) {
      continue;
    }
    const log = readMessageLog(indexed.sessionId, env);
    const activity = newest(newestLogAt(log), indexed.newestAt);
    const activityMs = activity == null ? null : parseInstant(activity);
    // An undated session is never filtered out: unknown is not proof it is old.
    // R5: the age filter runs AFTER the status is derived (below), so it can
    // spare a waiting or unknown session.
    const old = activityMs != null && activityMs < since;
    const assistant = lastAssistantLine(log);
    candidates.push({
      activity,
      indexed,
      lastAssistantAt: assistant.ok ? (assistant.value?.at ?? null) : null,
      old,
      sighting,
    });
  }
  endLogs();

  // F7 (home-base-vzwbj.4.9): the sessions load CONCURRENTLY, `concurrency`
  // at a time, sharing one cache for this run only (each checkout's git facts
  // and each beads export, read once). The rows are then built in index
  // order, exactly as the one-at-a-time loop built them.
  const cache = createLoadCache();
  const pendingLoads = timed(input.timings, 'session loads', () =>
    mapConcurrently(
      candidates,
      input.concurrency ?? INBOX_CONCURRENCY,
      async (candidate) =>
        await timedSession(input.timings, candidate.indexed.sessionId, () =>
          loadSession({
            cache,
            cwd,
            env,
            selector: null,
            sessionIdOption: candidate.indexed.sessionId,
          }),
        ),
    ),
  );
  // D6 (home-base-j8q3e.1.2): every OTHER session under the dev root. Started
  // after the tracked loads, so their git runs while the transcripts are
  // scanned; it shares their cache, so a shared checkout is measured once.
  // EVERY id in the index is excluded, whatever its sightings: the tracked
  // half lists it (as a card, a ❔ card, or in the hidden-by-age count), so
  // none appears twice.
  const pendingUntracked = timed(input.timings, 'untracked scan', () =>
    readUntracked({
      cache,
      days: input.days,
      devRoot: input.devRoot ?? defaultDevRoot(),
      env,
      exclude: new Set(index.sessions.map((indexed) => indexed.sessionId)),
      now,
      repo: input.repo,
    }),
  );
  const [loads, untracked, panes, beforeRestart] = await Promise.all([
    pendingLoads,
    pendingUntracked,
    pendingPanes,
    pendingBefore,
  ]);
  const beforeFacts = beforeRestart.ok ? beforeRestart.facts : null;
  const endRows = timedStart(input.timings, 'rows');
  // home-base-mbnjv.3 (D9): every session bead loaded in this run, so a card
  // names its predecessor and successor by title and sees a half-written link.
  const neighbors = new Map<string, CardNeighbor>();
  // home-base-idnon: each loaded session's message log, for the walk below.
  const loadedLogs = new Map<string, MessageLogRead>();
  // home-base-l2ejg.5 (D7): every loaded session's status, derived once, and
  // each session bead as a chain link, so a request a successor carries
  // shows the successor's state on its predecessor's card.
  // home-base-l2ejg.11: the knob where the inbox runs, read once per run; the
  // chain links name their sessions with it too.
  const chainNames = chainNamesKnob(cwd, env);
  const statuses = new Map<string, SessionStatus>();
  const chainSessions = new Map<string, ChainSession>();
  for (const loaded of loads) {
    if (loaded?.kind !== 'loaded') continue;
    loadedLogs.set(loaded.model.sessionId, loaded.model.log);
    const status = deriveStatus(statusFactsOf(loaded.model), {
      asIfYielded: false,
      now,
    });
    statuses.set(loaded.model.sessionId, status);
    const bead = loaded.model.beads.session;
    if (bead != null) {
      neighbors.set(bead.id, {labels: bead.labels, title: bead.title});
      chainSessions.set(
        bead.id,
        chainSessionOf(loaded.model, status, {chainNames}),
      );
    }
  }
  const chainLookup: ChainLookup = (beadId) => {
    const found = chainSessions.get(beadId);
    return found == null
      ? {kind: 'unknown', reason: 'it is not in this inbox'}
      : {kind: 'found', session: found};
  };
  // home-base-idnon: a bead that continues another and has no number label
  // gets its number walked from what this run already read; nothing written.
  const chainReaders = inboxChainReaders({
    beads: neighbors,
    env,
    exportIndexes: cache.exportIndexes,
    logs: loadedLogs,
  });
  for (const [position, candidate] of candidates.entries()) {
    const {activity, indexed, lastAssistantAt, old, sighting} = candidate;
    const loaded = loads[position];
    if (loaded == null) continue;
    if (loaded.kind !== 'loaded') {
      const detail =
        loaded.kind === 'unreadable' ? loaded.detail : loaded.reason;
      const title = '(could not load this session)';
      rows.push({
        beforeRestart: null,
        card: unreadableCard({
          age: ageOf(activity, now),
          detail,
          panes,
          repo: sighting.repo,
          repoTag: resolveRepoTag({
            cache: cache.repoTags,
            checkout: sighting.checkoutPath,
            env,
            repo: sighting.repo,
          }),
          sessionId: indexed.sessionId,
          title,
        }),
        display: 'card',
        ending: {kind: 'unknown', reason: ENDING_NOT_READ},
        git: null,
        handoff: null,
        inputDraft: null,
        lastActivityAt: activity,
        lastAssistantAt,
        loaded: null,
        // kwand.8: a session that could not be loaded is never hidden by age.
        olderShown: old ? 'unreadable' : null,
        repeats: null,
        repo: sighting.repo,
        section: 'checkByHand',
        sessionBeadId: sighting.event === 'created' ? sighting.beadId : null,
        sessionId: indexed.sessionId,
        startedAt: null,
        title,
        tracked: true,
        unread: null,
        unreadable: detail,
        untracked: null,
      });
      continue;
    }
    const {model} = loaded;
    const facts = statusFactsOf(model);
    const status =
      statuses.get(model.sessionId) ??
      deriveStatus(facts, {asIfYielded: false, now});
    const lastRecord = model.transcript.lastRecordAt.ok
      ? model.transcript.lastRecordAt.value
      : null;
    const lastActivityAt = newest(lastRecord, activity);
    const lastActivityMs = parseInstant(lastActivityAt ?? '');
    const keptBeforeRestart =
      input.keepBeforeRestart === true &&
      beforeFacts?.has(model.sessionId) === true;
    if (
      old &&
      (lastActivityMs == null || lastActivityMs < since) &&
      !neverHiddenByAge(status) &&
      !liveDrafts.has(model.sessionId) &&
      !keptBeforeRestart
    ) {
      hiddenByAge[status.kind] = (hiddenByAge[status.kind] ?? 0) + 1;
      continue;
    }
    // home-base-kwand.8 (G4): older than the window and shown anyway: which
    // of the rules above kept it. The drafts pass below names a draft.
    const olderShown: OlderShownReason | null =
      lastActivityMs == null || lastActivityMs >= since
        ? null
        : status.kind === 'waiting' ||
            status.kind === 'exportBehind' ||
            (status.kind === 'unknown' && neverHiddenByAge(status))
          ? status.kind
          : keptBeforeRestart
            ? 'beforeRestart'
            : 'indexUndated';
    const counts = statusCounts(model);
    const action = deriveAction({
      model,
      status,
      successorSessionId:
        facts.successor == null
          ? null
          : (sessionIdOfBead.get(facts.successor) ?? null),
    });
    const section = sectionFor(action.rule, status, counts);
    const title =
      model.beads.session?.title ??
      model.exportBehind?.title ??
      '⚠️ title unknown (the session bead could not be read)';
    const unreadable = unreadableOf(model);
    rows.push({
      beforeRestart: null,
      card: buildCard({
        action,
        age: ageOf(lastActivityAt, now),
        counts,
        marks:
          model.beads.session == null
            ? null
            : walkedSessionMarks(model.beads.session, chainReaders, {
                chainNames,
                namer: chainNames ? (input.chainNamer ?? null) : null,
              }),
        model,
        neighbors,
        panes,
        requestStates: requestStatesOf({
          lookup: chainLookup,
          session: chainSessionOf(model, status, {chainNames}),
        }),
        section,
        status,
        title,
        unreadable,
      }),
      display: 'card',
      ending: {kind: 'unknown', reason: ENDING_NOT_READ},
      git: cardGit(model.git),
      handoff:
        model.beads.session == null
          ? null
          : handoffStopOf(
              model.beads.session.labels,
              model.beads.session.notes,
            ),
      inputDraft: null,
      lastActivityAt,
      lastAssistantAt,
      loaded: {counts, model, status},
      olderShown,
      repeats: null,
      repo: model.repo,
      section,
      sessionBeadId: model.sessionBeadId,
      sessionId: model.sessionId,
      startedAt: model.startedAt.ok ? model.startedAt.value : null,
      title,
      tracked: true,
      unread: null,
      unreadable,
      untracked: null,
    });
  }
  for (const session of untracked.sessions) {
    const verdict = untrackedVerdict(session, now);
    const card = untrackedCard(session, verdict, now, panes);
    // D-READ-STATE: an untracked session's log is read from its end only.
    const assistant = isSafeSessionId(session.sessionId)
      ? readLastAssistantLineMemoized(messageLogPath(session.sessionId, env))
      : null;
    // kwand.8: in the window by its file's write time, older by its records.
    const untrackedMs = parseInstant(untrackedActivityAt(session) ?? '');
    rows.push({
      beforeRestart: null,
      card,
      display: verdict.display,
      ending: {kind: 'unknown', reason: ENDING_NOT_READ},
      git: cardGit(session.git),
      handoff: null,
      inputDraft: null,
      lastActivityAt: untrackedActivityAt(session),
      lastAssistantAt: assistant?.kind === 'found' ? assistant.line.at : null,
      loaded: null,
      olderShown:
        untrackedMs != null && untrackedMs < since ? 'transcriptWritten' : null,
      repeats: null,
      repo: session.repo,
      section: 'notTracked',
      sessionBeadId: null,
      sessionId: session.sessionId,
      startedAt: session.firstMessageAt,
      title: card.title,
      tracked: false,
      unread: null,
      unreadable:
        verdict.unmeasured.length === 0 ? null : verdict.unmeasured.join('; '),
      untracked: {session, verdict},
    });
  }
  // D-READ-STATE (home-base-yukaf.9): Justin's read marks, read once.
  const marks = readReadMarks(env);
  for (const [position, row] of rows.entries()) {
    rows[position] = {
      ...row,
      unread: unreadFor(marks, row.sessionId, row.lastAssistantAt),
    };
  }
  // home-base-kwand.2: the tab each session was in before the restart, and
  // what that is now, as a field and as a line on the card.
  for (const [position, row] of rows.entries()) {
    const fact = beforeFacts?.get(row.sessionId) ?? null;
    if (fact == null) continue;
    rows[position] = {
      ...row,
      beforeRestart: fact,
      card: withBeforeRestart(row.card, fact, now),
    };
  }
  // home-base-kwand.5 (D4): Justin's flags, the union over each chain, from
  // the session beads this run loaded and, for a chain session it did not
  // load, the exports it read (no br call).
  const continuingOf = new Map<string, string[]>();
  for (const [id, bead] of neighbors) {
    for (const label of bead.labels) {
      if (!label.startsWith(CONTINUES_LABEL_PREFIX)) continue;
      const older = label.slice(CONTINUES_LABEL_PREFIX.length);
      continuingOf.set(older, [...(continuingOf.get(older) ?? []), id]);
    }
  }
  for (const [position, row] of rows.entries()) {
    const startId = row.sessionBeadId;
    if (startId == null || row.loaded?.model.beads.session == null) {
      rows[position] = {...row, flags: null};
      continue;
    }
    rows[position] = {
      ...row,
      flags: chainFlagsOf({
        continuing: (id) => continuingOf.get(id) ?? [],
        labelsOf: (id) => {
          const loaded = neighbors.get(id);
          if (loaded != null) return {kind: 'found', labels: loaded.labels};
          const shown = chainReaders.showBead(id);
          return shown.kind === 'found'
            ? {kind: 'found', labels: shown.labels}
            : {kind: 'unknown', reason: shown.reason};
        },
        startId,
      }),
    };
  }
  // home-base-kwand.4 (G12): how each session's last turn ended, from the
  // transcript cache's entry the load above already read (no second read), with
  // liveness from this run's pane lookup (D5), as a field and a card line.
  for (const [position, row] of rows.entries()) {
    const ending = rowEnding(row, now);
    rows[position] = {
      ...row,
      card: withEnding(row.card, ending, now),
      ending,
    };
  }
  // D-DRAFTS: a row with a live draft goes first, as a full card.
  const shownDrafts = new Set<string>();
  for (const [position, row] of rows.entries()) {
    const draft = liveDrafts.get(row.sessionId);
    if (draft == null) continue;
    shownDrafts.add(row.sessionId);
    rows[position] = {
      ...row,
      card: withInputDraft(row.card, draft),
      display: 'card',
      inputDraft: draft,
      // kwand.8: an older row with a draft is listed for the draft first.
      olderShown: row.olderShown == null ? null : 'unsentDraft',
      section: 'unsentDraft',
    };
  }
  // home-base-kwand.8 (G4): each row's idle time, from this read's clock.
  for (const [position, row] of rows.entries()) {
    rows[position] = {...row, idleMs: idleMsAt(row.lastActivityAt, now)};
  }
  const inputDrafts: InboxDrafts =
    draftList.kind === 'failed'
      ? draftList
      : {
          failures: draftList.failures,
          kind: 'read',
          unchecked: draftList.unchecked,
          unshown: [...liveDrafts.entries()]
            .filter(([sessionId]) => !shownDrafts.has(sessionId))
            .map(([sessionId, draft]) => ({...draft, sessionId})),
        };
  const sessionDirt = rows.flatMap((row) => sessionDirtOfRow(row) ?? []);
  const shaped = shapeRows(rows);
  const untrackedRead: InboxRead['untracked'] = {
    devRoot: untracked.devRoot,
    failures: untracked.failures,
    oldReports: untracked.oldReports,
    outsideRoot: untracked.outsideRoot,
    // The JSON lists every row, done and archived too, so all of them claim.
    unattributed: unattributedOfListed(
      sessionDirt,
      new Set(shaped.rows.map((row) => row.sessionId)),
    ),
    unplaced: untracked.unplaced,
  };
  endRows();
  return {
    kind: 'read',
    read: {
      beforeRestart,
      corrupt: index.corrupt.map((line) => ({
        lineNumber: line.lineNumber,
        reason: line.reason,
      })),
      hiddenByAge,
      indexPath: index.path,
      inputDrafts,
      missing: read.kind === 'missing',
      panes,
      readMarks:
        marks.kind === 'failed'
          ? {kind: 'failed', reason: marks.reason}
          : {kind: 'read'},
      rows: shaped.rows,
      sessionDirt,
      testSessions: shaped.testSessions,
      untracked: untrackedRead,
    },
  };
}

/**
 * Read every session in the window. `failed` only when the index is unreadable.
 *
 * home-base-9uzxw.14: after a load that read, the in-memory caches drop what
 * it did not use (so a long-lived --web server holds one load's files, not
 * every file it ever read), and the transcript cache's disk entries whose
 * transcript is gone, or older than the window and unused, are removed (at
 * most hourly; never after a load filtered to one repo, which uses only part
 * of the cache). The window is at least the default one, so a shorter
 * `--days` never evicts what the default dashboard reads. Neither changes
 * any answer: a dropped entry is read again when next asked for.
 */
export async function readInbox(
  input: Parameters<typeof readInboxOnce>[0],
): ReturnType<typeof readInboxOnce> {
  const fileMark = fileMemoMark();
  const transcriptMark = transcriptCacheMark();
  const result = await readInboxOnce(input);
  if (result.kind === 'read') {
    dropUnusedFileMemo(fileMark);
    dropUnusedTranscriptMemory(transcriptMark);
    if (input.repo == null) {
      evictTranscriptCache({
        now: input.now,
        usedSince: transcriptMark,
        windowDays: Math.max(input.days, INBOX_DEFAULT_DAYS),
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The checkout a session ran in: the loaded model's, else the untracked
 * session's; null when neither is known. `claude --resume` finds a session
 * only from its own directory (D-LAYOUT), so every opener needs this
 * (home-base-yukaf.14 F24): thread open, the TUI's `o`, the web page's Open.
 */
export function rowCheckout(row: InboxRow): string | null {
  return (
    row.loaded?.model.git.checkout ?? row.untracked?.session.checkout ?? null
  );
}

/** A section shows unless it is Done or Archived and --all is off. */
function sectionVisible(key: InboxSection, all: boolean): boolean {
  return all || !sectionInfo(key).onlyWithAll;
}

/**
 * The summary's entries: one per non-empty visible section, D5 order. `lines`
 * counts D6's one-line entries (only Not tracked has any), so the summary can
 * say how many untracked sessions had something open or unread.
 */
export function inboxSummary(
  rows: readonly InboxRow[],
  all: boolean,
): {
  /** ✍️ only (F1): how many of its sessions are also waiting on you (🛑). */
  alsoWaiting: number;
  count: number;
  emoji: string;
  key: InboxSection;
  lines: number;
  title: string;
}[] {
  return INBOX_SECTIONS.filter((section) => all || !section.onlyWithAll)
    .map((section) => {
      // F1: a session with unsent text counts under ✍️ AND under the
      // section it is in without the draft, so a P0 never leaves the 🛑 count.
      const mine = rows.filter(
        (row) =>
          row.section === section.key ||
          (section.key !== 'unsentDraft' &&
            row.card.unsent?.beneath === section.key),
      );
      // Sessions, not rows: a folded line (F6) counts every session in it.
      const count = (list: readonly InboxRow[]): number =>
        list.reduce((sum, row) => sum + sessionsIn(row), 0);
      return {
        alsoWaiting:
          section.key === 'unsentDraft'
            ? count(
                mine.filter((row) => row.card.unsent?.beneath === 'needsYou'),
              )
            : 0,
        count: count(mine),
        emoji: section.emoji,
        key: section.key,
        lines: count(mine.filter((row) => row.display === 'line')),
        title: section.title,
      };
    })
    .filter((entry) => entry.count > 0);
}

/**
 * A summary entry's value: the count, and for Not tracked what it holds
 * (j8q3e.7 D4: a one-liner is "no request recorded", never "nothing open").
 */
function summaryValue(entry: {
  alsoWaiting: number;
  count: number;
  lines: number;
}): string {
  if (entry.alsoWaiting > 0) {
    return `${entry.count} (${entry.alsoWaiting} also waiting on you)`;
  }
  if (entry.lines === 0) return String(entry.count);
  const cards = entry.count - entry.lines;
  return `${entry.count} (${cards} with something open or unreadable, ${entry.lines} with no request recorded)`;
}

/** j8q3e.7 D8's label: the panes Justin cannot yet close safely. */
export const OPEN_PANES_LABEL = 'Open panes with no request record';

/**
 * j8q3e.7 D8: how many untracked sessions (no request record) a live cmux
 * pane holds — a count, or why it is unknown.
 */
export function openPanesWithoutRequest(
  rows: readonly InboxRow[],
  panes: PaneLookup,
): {count: number; ok: true} | {ok: false; reason: string} {
  if (!panes.ok) return {ok: false, reason: panes.reason};
  return {
    count: rows.filter(
      (row) => !row.tracked && row.card.paneFact.kind === 'live',
    ).length,
    ok: true,
  };
}

/** j8q3e.17 D3's label: live Claude panes whose session no source could name. */
export const UNPLACED_PANES_LABEL = 'Claude panes no source could place';

const UNPLACED_WORDS: Record<UnplacedKind, string> = {
  conflict: 'with an id another pane already holds',
  noScreenId: 'with no session id on screen',
  unconfirmedId: "with an id cmux's session file does not confirm",
  unreadableScreen: 'whose screen could not be read',
  unreadableSessionFile: "unchecked: cmux's session file could not be read",
};

/**
 * j8q3e.17 D3: how many live Claude panes neither the pid/tty join nor the
 * status line placed, by why; null when the lookup failed (the open-panes
 * line already says unknown) or every Claude pane was placed.
 */
export function unplacedPanesValue(panes: PaneLookup): string | null {
  if (!panes.ok || panes.statusLine.unplaced.length === 0) return null;
  const byKind = new Map<UnplacedKind, number>();
  for (const pane of panes.statusLine.unplaced) {
    byKind.set(pane.kind, (byKind.get(pane.kind) ?? 0) + 1);
  }
  const parts = [...byKind.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => `${count} ${UNPLACED_WORDS[kind]}`);
  const failure =
    panes.statusLine.failure == null
      ? ''
      : ` (${tildeText(panes.statusLine.failure)})`;
  return `${panes.statusLine.unplaced.length}: ${parts.join(', ')}${failure}`;
}

/**
 * D6's notes (home-base-j8q3e.1.2): what the untracked half could not read or
 * left out, counted and named — never dropped silently (critical rule 7).
 */
export function untrackedNotes(notes: InboxRead['untracked']): string[] {
  const lines: string[] = [];
  // j8q3e.6 D3: a checkout's dirt that no listed session's transcript names,
  // once. j8q3e.13 F4: the words claim only what was checked. A session that
  // ran `bun add`, `prettier --write .` or a code generator dirtied files
  // without naming them, so "no session wrote" could be false.
  for (const dirt of notes.unattributed) {
    const files = plural(
      dirt.paths.length,
      'uncommitted file',
      'uncommitted files',
    );
    const named =
      dirt.paths.length <= 3
        ? ` (${dirt.paths.map(tildeText).join(', ')})`
        : '';
    const unchecked =
      dirt.unchecked > 0
        ? `; ${plural(dirt.unchecked, 'session', 'sessions')} there could not be checked`
        : '';
    lines.push(
      `${tildeText(dirt.checkout)}: ${files} that no listed session's transcript names${named}${unchecked}.`,
    );
  }
  const {outsideRoot} = notes;
  if (outsideRoot.sessions > 0) {
    lines.push(
      `${plural(outsideRoot.sessions, 'session', 'sessions')} in ${plural(outsideRoot.directories, 'directory', 'directories')} outside ${tildeText(notes.devRoot)} ${outsideRoot.sessions === 1 ? 'is' : 'are'} not listed (usually test probes in temporary directories).`,
    );
  }
  if (notes.unplaced > 0) {
    lines.push(
      `⚠️ ${plural(notes.unplaced, 'session', 'sessions')} ${notes.unplaced === 1 ? 'is' : 'are'} not listed: no record of ${notes.unplaced === 1 ? 'its' : 'their'} transcript names a working directory, so ${notes.unplaced === 1 ? 'its' : 'their'} repo is unknown.`,
    );
  }
  if (notes.failures.length > 0) {
    lines.push(
      [
        `⚠️ ${plural(notes.failures.length, 'transcript or directory', 'transcripts or directories')} could not be read, so ${notes.failures.length === 1 ? 'its sessions are' : 'their sessions are'} not listed:`,
        ...notes.failures.map((failure) => `- ${tildeText(failure)}`),
      ].join('\n'),
    );
  }
  const old = notes.oldReports;
  if (old?.kind === 'failed') {
    lines.push(
      `⚠️ The old reports could not be read (${tildeText(old.reason)}), so every session not tracked is a card that says to check it by hand.`,
    );
  } else if (old?.kind === 'read' && old.corrupt.length > 0) {
    lines.push(
      `⚠️ ${plural(old.corrupt.length, 'line', 'lines')} of ${tildeText(old.path)} could not be parsed (line ${old.corrupt.join(', ')}), so the open questions on ${old.corrupt.length === 1 ? 'it are' : 'them are'} not counted.`,
    );
  }
  return lines;
}

/** "(stage: tested, next: built)" — D2's words for a request's stage. */
function stageWords(request: {
  nextStage: string | null;
  stage: string | null;
}): string {
  if (request.stage == null) return '';
  return request.nextStage == null
    ? ` (stage: ${request.stage}, the last stage)`
    : ` (stage: ${request.stage}, next: ${request.nextStage})`;
}

/** D2 "You asked": each line of its value, the requests capped at five. */
function youAskedLines(asked: YouAsked): string[] {
  switch (asked.kind) {
    case 'requests': {
      const lines = asked.requests
        .slice(0, CARD_REQUESTS_SHOWN)
        .map(
          (request) => `${request.icon} ${request.title}${stageWords(request)}`,
        );
      const more = asked.requests.length - CARD_REQUESTS_SHOWN;
      if (more > 0) lines.push(`and ${more} more`);
      return lines;
    }
    case 'noRequest':
      return [
        asked.firstMessage == null
          ? '(no request filed, and no message of yours was captured)'
          : `(no request filed) "${asked.firstMessage}"`,
      ];
    case 'unknown':
      return [
        `⚠️ unknown (${asked.reason})${asked.firstMessage == null ? '' : `; your first message: "${asked.firstMessage}"`}`,
      ];
    case 'untracked':
      return [
        asked.firstMessage == null
          ? '(no message of yours was captured)'
          : `your first message: "${tildeText(asked.firstMessage)}"`,
      ];
  }
}

/**
 * D2 "You asked": each line of its value, the requests capped at five. Under
 * each request, its state line (home-base-l2ejg.5, D7) when the card has one.
 */
function youAskedRows(
  asked: YouAsked,
  now: Date,
): {line: string; state: string | null}[] {
  if (asked.kind !== 'requests') {
    return youAskedLines(asked).map((line) => ({line, state: null}));
  }
  const rows = asked.requests.slice(0, CARD_REQUESTS_SHOWN).map((request) => ({
    line: `${request.icon} ${request.title}${stageWords(request)}`,
    state:
      request.stateLine == null
        ? null
        : tildeText(requestStateText(request.stateLine, {now})),
  }));
  const more = asked.requests.length - CARD_REQUESTS_SHOWN;
  if (more > 0) rows.push({line: `and ${more} more`, state: null});
  return rows;
}

/**
 * D-READ-STATE (home-base-yukaf.9): an unread session's heading starts with
 * UNREAD_MARKER. Only `unread === true` gets it; null (could not tell) does
 * not, and the inbox says why once.
 */
function unreadLead(unread: boolean | null): string {
  return unread === true ? `${UNREAD_MARKER} ` : '';
}

/** home-base-kwand.5: Justin's flags before the title, `⭐ `, or ''. */
export function flagsLead(flags: ChainFlags | null | undefined): string {
  return flags == null || flags.emoji.length === 0
    ? ''
    : `${flags.emoji.join('')} `;
}

function headingText(
  card: SessionCard,
  unread: boolean | null,
  flags: ChainFlags | null | undefined,
): string {
  return `${unreadLead(unread)}${card.emoji} ${flagsLead(flags)}${tildeText(sessionDisplayName(card.repoTag, card.title, card.marks))}`;
}

function markdownCard(
  card: SessionCard,
  showSection: boolean,
  unread: boolean | null,
  paneSummaryReason: string | null,
  now: Date,
  flags: ChainFlags | null | undefined,
): string {
  const lines: string[] = [];
  if (showSection) {
    lines.push(`- **Section:** ${card.sectionEmoji} ${card.sectionTitle}`);
  }
  if (card.youAsked.kind === 'requests') {
    lines.push(
      '- **You asked:**',
      ...youAskedRows(card.youAsked, now).flatMap((row) => [
        `  - ${row.line}`,
        ...(row.state == null ? [] : [`    - **Now:** ${row.state}`]),
      ]),
    );
  } else {
    lines.push(`- **You asked:** ${youAskedLines(card.youAsked).join(' ')}`);
  }
  lines.push(
    `- **Where it is:** ${card.status}`,
    // A draft's text can run to several lines: they stay inside the item.
    ...card.facts.map(
      (fact) =>
        `  - **${fact.label}:** ${fact.value.replaceAll('\n', '\n    ')}`,
    ),
  );
  lines.push(
    `- **You need to:** **${card.action.text}**${card.action.command == null ? '' : ` \`${card.action.command}\``}`,
  );
  // F1: unsent text is a second line; the session's own action stays first.
  if (card.unsent != null) {
    lines.push(
      `  - **${card.unsent.text}**${card.unsent.command == null ? '' : ` \`${card.unsent.command}\``}`,
    );
  }
  if (card.optional != null) {
    lines.push(
      `- **Optional:** ${card.optional.text} \`${card.optional.command}\``,
    );
  }
  lines.push(`- **Resume:** \`${card.resume}\``);
  // j8q3e.7 D7: every card says where its pane is, or why that is unknown.
  const pane = paneLineParts(card.paneFact, paneSummaryReason);
  lines.push(
    `- **Pane:** ${pane.before}${pane.command == null ? '' : `\`${pane.command}\``}${pane.after}`,
  );
  return [
    `**${headingText(card, unread, flags)}**${card.age == null ? '' : ` (${card.age})`}`,
    lines.join('\n'),
  ].join('\n\n');
}

/** The labels a card can carry, so every card's values share one column. */
const CARD_LABELS: readonly Field[] = [
  'Section',
  'You asked',
  'Where it is',
  'You need to',
  'Optional',
  'Resume',
  'Pane',
].map((label) => ({label, value: ''}));

function ansiCard(
  card: SessionCard,
  showSection: boolean,
  style: OutputStyle,
  unread: boolean | null,
  paneSummaryReason: string | null,
  now: Date,
  flags: ChainFlags | null | undefined,
): string {
  const {color, width} = style;
  const code = (text: string): string => paint(text, ['cyan'], color);
  const fields: Field[] = [];
  if (showSection) {
    fields.push({
      label: 'Section',
      value: `${card.sectionEmoji} ${card.sectionTitle}`,
    });
  }
  fields.push({
    label: 'You asked',
    value: youAskedRows(card.youAsked, now)
      .flatMap((row) => [
        row.line,
        ...(row.state == null
          ? []
          : [`   ${paint('Now:', ['bold'], color)} ${row.state}`]),
      ])
      .join('\n'),
  });
  fields.push({
    label: 'Where it is',
    value: [
      card.status,
      ...card.facts.map(
        (fact) => `${paint(`${fact.label}:`, ['bold'], color)} ${fact.value}`,
      ),
    ].join('\n'),
  });
  fields.push({
    label: 'You need to',
    value: [
      `${paint(card.action.text, ['bold'], color)}${card.action.command == null ? '' : ` ${code(card.action.command)}`}`,
      // F1: unsent text is a second line; the session's own action stays first.
      ...(card.unsent == null
        ? []
        : [
            `${paint(card.unsent.text, ['bold'], color)}${card.unsent.command == null ? '' : ` ${code(card.unsent.command)}`}`,
          ]),
    ].join('\n'),
  });
  if (card.optional != null) {
    fields.push({
      label: 'Optional',
      value: `${card.optional.text} ${code(card.optional.command)}`,
    });
  }
  fields.push({label: 'Resume', value: code(card.resume)});
  const pane = paneLineParts(card.paneFact, paneSummaryReason);
  fields.push({
    label: 'Pane',
    value: `${pane.before}${pane.command == null ? '' : code(pane.command)}${pane.after}`,
  });
  const heading = `${paint(headingText(card, unread, flags), ['bold'], color)}${card.age == null ? '' : `  ${paint(`(${card.age})`, ['dim'], color)}`}`;
  return [
    wrapHanging(heading, {hang: BODY_COLUMN + 3, indent: BODY_COLUMN, width}),
    fieldLines(fields, {
      color,
      indent: stepColumn(1),
      labelWidth: fieldLabelWidth(CARD_LABELS),
      width,
    }),
  ].join('\n');
}

/** D6's one-line entry, on a TTY at the cards' heading indent. */
function lineEntry(row: InboxRow, style: OutputStyle, now: Date): string {
  const line = untrackedLine(
    row.card,
    row.untracked?.session.firstMessage ?? null,
    sessionsIn(row),
  );
  const lead = unreadLead(row.unread);
  // kwand.2: the before-restart line goes under the one-liner, on its own line;
  // kwand.4: so does a cut-off mark (a one-liner shows no other ending).
  const under = [
    row.beforeRestart == null
      ? null
      : beforeRestartLine(row.beforeRestart, now),
    row.ending.kind === 'cutOff' ? endingLine(row.ending, now) : null,
  ].filter((value): value is string => value != null);
  if (!style.color) {
    const text = lead === '' ? line : `**${lead.trim()}** ${line}`;
    return [text, ...under.map((value) => `  ${value}`)].join('\n');
  }
  const text = lead === '' ? line : `${paint(lead, ['bold'], true)}${line}`;
  const wrap = (value: string, indent: number): string =>
    wrapHanging(value, {hang: indent + 3, indent, width: style.width});
  return [
    wrap(text, BODY_COLUMN),
    ...under.map((value) => wrap(value, BODY_COLUMN + 3)),
  ].join('\n');
}

/** A session as the inbox prints it: its full card, or D6's one line. */
function renderRow(
  row: InboxRow,
  showSection: boolean,
  style: OutputStyle,
  paneSummaryReason: string | null,
  now: Date,
): string {
  if (row.display === 'line') return lineEntry(row, style, now);
  return style.color
    ? ansiCard(
        row.card,
        showSection,
        style,
        row.unread,
        paneSummaryReason,
        now,
        row.flags,
      )
    : markdownCard(
        row.card,
        showSection,
        row.unread,
        paneSummaryReason,
        now,
        row.flags,
      );
}

function header(
  text: string,
  emoji: string | null,
  level: 1 | 2,
  style: OutputStyle,
): string {
  if (style.color) return sectionHeader(text, {color: true, emoji});
  return `${level === 1 ? '#' : '##'} ${emoji == null ? '' : `${emoji} `}${text}`;
}

/** How a hidden status is counted in the R5 line. */
const HIDDEN_STATUS_WORDS: Record<SessionStatus['kind'], string> = {
  answered: '💬 answered',
  done: '✅ done or archived',
  doneUnmerged: '🔀 done, not merged',
  exportBehind: '⏳ export behind',
  handedOff: '🤝 handed off',
  openWork: '⚠️ open work',
  outOfContext: '🧯 past wind-down notice',
  // Only a ❔ whose activity could not be read is ever hidden by age (D5).
  unknown: '❔ unknown (activity unreadable)',
  waiting: '🛑 waiting on you',
  working: '🏃 working',
};

/**
 * R5 (home-base-vzwbj.4.9): one line counting what the window hid, by status,
 * or null when it hid nothing.
 */
export function hiddenByAgeLine(
  hidden: InboxRead['hiddenByAge'],
  days: number,
): string | null {
  const entries = (
    Object.entries(hidden) as [SessionStatus['kind'], number][]
  ).filter(([, count]) => count > 0);
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  if (total === 0) return null;
  const parts = entries
    .map(([kind, count]) => `${count} ${HIDDEN_STATUS_WORDS[kind]}`)
    .join(', ');
  return `${plural(total, 'older session', 'older sessions')} hidden (no activity in the last ${plural(days, 'day', 'days')}; --days): ${parts}. Waiting sessions are never hidden by age, and unknown ones only when their activity could not be read.`;
}

/**
 * D-DRAFTS (home-base-yukaf.4): the drafts no card shows, and a store that
 * could not be read, each said once (critical rule 7: never "no drafts").
 */
export function inputDraftNotes(drafts: InboxDrafts): string[] {
  if (drafts.kind === 'failed') {
    return [
      `⚠️ Unsent input-box text could not be checked: ${tildeText(drafts.reason)}`,
    ];
  }
  const notes: string[] = [];
  if (drafts.unshown.length > 0) {
    notes.push(
      `✍️ ${plural(drafts.unshown.length, 'session has', 'sessions have')} unsent input-box text but no card in this view (${drafts.unshown.map((entry) => entry.sessionId).join(', ')}); ${sdkRun('thread drafts')} shows ${drafts.unshown.length === 1 ? 'it' : 'them'}.`,
    );
  }
  if (drafts.failures.length > 0) {
    notes.push(
      `⚠️ ${plural(drafts.failures.length, 'draft file', 'draft files')} could not be read: ${drafts.failures.map(tildeText).join('; ')}`,
    );
  }
  if (drafts.unchecked.length > 0) {
    notes.push(
      `⚠️ ${plural(drafts.unchecked.length, 'draft', 'drafts')} could not be checked against what was sent, so ${drafts.unchecked.length === 1 ? 'it stays' : 'they stay'} listed as unsent: ${drafts.unchecked.map(tildeText).join('; ')}`,
    );
  }
  return notes;
}

/**
 * home-base-kwand.8 (G4): the rows older than the window and shown anyway,
 * one group per reason in OLDER_SHOWN_GROUPS order, newest first inside each
 * (the order `rows` came in). Empty groups are left out.
 */
export function olderShownGroups(rows: readonly InboxRow[]): {
  emoji: string;
  reason: OlderShownReason;
  rows: InboxRow[];
}[] {
  return OLDER_SHOWN_GROUPS.map((group) => ({
    emoji: group.emoji,
    reason: group.reason,
    rows: rows.filter((row) => row.olderShown === group.reason),
  })).filter((group) => group.rows.length > 0);
}

/** The summary's older line: "35 (34 waiting on you, 1 unsent text …)", or null. */
function olderSummaryValue(
  groups: ReturnType<typeof olderShownGroups>,
): string | null {
  const count = (rows: readonly InboxRow[]): number =>
    rows.reduce((sum, row) => sum + sessionsIn(row), 0);
  const total = groups.reduce((sum, group) => sum + count(group.rows), 0);
  if (total === 0) return null;
  const parts = groups.map(
    (group) =>
      `${count(group.rows)} ${OLDER_SHOWN_GROUPS.find((entry) => entry.reason === group.reason)?.words ?? group.reason}`,
  );
  return `${total} (${parts.join(', ')}), listed last`;
}

export interface RenderInboxOptions {
  all: boolean;
  days: number;
  now: Date;
  order: InboxOrder;
  /** D-PINS: `--by-repo` lists these repos first, in this order. Default none. */
  pinnedProjects?: readonly string[];
  style: OutputStyle;
  timeZone?: string;
}

export function renderInbox(
  read: InboxRead,
  options: RenderInboxOptions,
): string {
  const {all, order, style} = options;
  const blocks: string[] = [];
  const idleFor = read.idleFor ?? null;
  const title = `Inbox — sessions with activity in the last ${plural(options.days, 'day', 'days')}${idleFor == null ? '' : `, idle for at least ${idleFor.words}`}${all ? ', done and archived included' : ''}`;
  blocks.push(header(title, '📥', 1, style));
  if (read.missing) {
    blocks.push(
      `No session bead recorded yet: ${tildeText(read.indexPath)} does not exist (componentConfig.thread.sessionBeads has never filed a session bead on this machine), so every session below is Not tracked.`,
    );
  }
  const visible = read.rows
    .filter((row) => sectionVisible(row.section, all))
    .sort(byNewest);
  // home-base-kwand.8 (G4): the cards active within the window first, in the
  // chosen order; then the older ones shown anyway, under their own headings.
  const within = visible.filter((row) => row.olderShown == null);
  const olderGroups = olderShownGroups(visible);

  // j8q3e.1 D5: the summary first, one line per non-empty section.
  const summary = inboxSummary(visible, all);
  // p05kz.3 item 5: a failed lookup is said once, in the summary's open-panes
  // line, and each card points there. Null when the summary prints no such
  // line, so "see the summary" is never a dangling pointer.
  const paneSummaryReason =
    summary.length > 0 && !read.panes.ok ? read.panes.reason : null;
  if (summary.length > 0) {
    blocks.push(header('Summary', '📊', 2, style));
    const fields = summary.map((entry) => ({
      label: `${entry.emoji} ${entry.title}`,
      value: summaryValue(entry),
    }));
    // j8q3e.7 D8: the panes he cannot yet close safely.
    const openPanes = openPanesWithoutRequest(visible, read.panes);
    fields.push({
      label: `🪟 ${OPEN_PANES_LABEL}`,
      value: openPanes.ok
        ? String(openPanes.count)
        : `unknown (${tildeText(openPanes.reason)})`,
    });
    // j8q3e.17 D3: panes whose session no source could name, said once.
    const unplaced = unplacedPanesValue(read.panes);
    if (unplaced != null) {
      fields.push({label: `🪟 ${UNPLACED_PANES_LABEL}`, value: unplaced});
    }
    // home-base-kwand.8 (G4): the cards older than the window, said up front.
    const olderValue = olderSummaryValue(olderGroups);
    if (olderValue != null) {
      fields.push({
        label: `🕰️ Older than ${plural(options.days, 'day', 'days')}, shown anyway`,
        value: olderValue,
      });
    }
    blocks.push(
      style.color
        ? fieldLines(fields, {
            color: true,
            indent: BODY_COLUMN,
            width: style.width,
          })
        : fields
            .map((entry) => `- **${entry.label}:** ${entry.value}`)
            .join('\n'),
    );
  }

  if (order === 'status') {
    for (const section of INBOX_SECTIONS) {
      const rows = within.filter((row) => row.section === section.key);
      if (rows.length === 0) continue;
      blocks.push(
        header(`${section.title} (${rows.length})`, section.emoji, 2, style),
      );
      for (const row of rows) {
        blocks.push(
          renderRow(row, false, style, paneSummaryReason, options.now),
        );
      }
    }
  } else if (order === 'repo') {
    const groups = new Map<string, InboxRow[]>();
    for (const row of within) {
      const key = row.repo ?? 'unknown repo';
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    // Map insertion order follows each group's newest session; D-PINS moves
    // the pinned repos to the front, in config order.
    for (const repo of pinnedFirst(
      [...groups.keys()],
      options.pinnedProjects ?? [],
    )) {
      const rows = groups.get(repo) ?? [];
      blocks.push(header(`${repo} (${rows.length})`, '📁', 2, style));
      for (const row of rows) {
        blocks.push(
          renderRow(row, true, style, paneSummaryReason, options.now),
        );
      }
    }
  } else if (within.length > 0) {
    blocks.push(header('Sessions, newest first', '🕒', 2, style));
    for (const row of within) {
      blocks.push(renderRow(row, true, style, paneSummaryReason, options.now));
    }
  }
  // home-base-kwand.8 (G4): after the cards active within the window.
  for (const group of olderGroups) {
    blocks.push(
      header(
        `${olderHeading(group.reason, options.days)} (${group.rows.length})`,
        group.emoji,
        2,
        style,
      ),
    );
    for (const row of group.rows) {
      blocks.push(
        renderRow(
          row,
          order !== 'status',
          style,
          paneSummaryReason,
          options.now,
        ),
      );
    }
  }

  const hidden = read.rows.length - visible.length;
  if (!read.missing && visible.length === 0) {
    blocks.push(
      read.rows.length === 0
        ? idleFor == null
          ? `No session had activity in the last ${plural(options.days, 'day', 'days')}.`
          : `No session listed: none in this window has been idle for at least ${idleFor.words}.`
        : 'Nothing open.',
    );
  }
  const notes: string[] = [];
  // home-base-kwand.8 (G4): what --idle-for left out, and why (rule 7).
  const idleNote = idleFor == null ? null : idleForNote(idleFor);
  if (idleNote != null) notes.push(idleNote);
  if (hidden > 0) {
    notes.push(
      `${plural(hidden, 'session is', 'sessions are')} done or archived and hidden; --all shows ${hidden === 1 ? 'it' : 'them'}.`,
    );
  }
  const hiddenLine = hiddenByAgeLine(read.hiddenByAge, options.days);
  if (hiddenLine != null) notes.push(hiddenLine);
  const tests = read.testSessions.length;
  if (tests > 0) {
    notes.push(
      `${plural(tests, 'test session', 'test sessions')} hidden: ${tests === 1 ? 'its' : 'their'} first message carries the [TEST_DATA_DELETABLE …] marker. --json lists ${tests === 1 ? 'it' : 'them'} under testSessions.`,
    );
  }
  notes.push(
    ...untrackedNotes({
      ...read.untracked,
      unattributed: unattributedOfListed(
        read.sessionDirt,
        new Set(visible.map((row) => row.sessionId)),
      ),
    }),
  );
  notes.push(...inputDraftNotes(read.inputDrafts));
  // D-READ-STATE: no ● anywhere is then "could not tell", and says so once.
  if (read.readMarks.kind === 'failed') {
    notes.push(
      `⚠️ Read / unread could not be checked, so no session is marked ${UNREAD_MARKER}: ${tildeText(read.readMarks.reason)}`,
    );
  }
  if (read.corrupt.length > 0) {
    notes.push(
      [
        `⚠️ ${plural(read.corrupt.length, 'line', 'lines')} of ${tildeText(read.indexPath)} could not be read, so ${read.corrupt.length === 1 ? 'its session is' : 'their sessions are'} not listed:`,
        ...read.corrupt.map(
          (line) => `- line ${line.lineNumber}: ${line.reason}`,
        ),
      ].join('\n'),
    );
  }
  for (const note of notes) {
    blocks.push(
      style.color
        ? wrapHanging(note, {
            hang: HEADER_COLUMN,
            indent: HEADER_COLUMN,
            width: style.width,
          })
        : note,
    );
  }
  return spacedList(blocks);
}

/**
 * `thread inbox --before-restart` (home-base-kwand.2): only the sessions that
 * were in a tab before the last restart, grouped by the state now with counts,
 * newest activity first inside each group. A session with no inbox row is a
 * short line naming its tab, never dropped.
 */
export function renderBeforeRestartInbox(
  read: InboxRead,
  options: Pick<RenderInboxOptions, 'now' | 'style'>,
): string {
  const {now, style} = options;
  const blocks: string[] = [
    header('Sessions open before the last restart', '🔁', 1, style),
  ];
  const answer = read.beforeRestart;
  if (!answer.ok) {
    blocks.push(`Unknown: ${tildeText(answer.reason)}`);
    return spacedList(blocks);
  }
  const groups = beforeRestartGroups(read);
  const fields: Field[] = [
    {
      label: 'restart',
      value: `${answer.restartKind === 'boot' ? 'Mac boot' : 'cmux launch'} at ${restartWhen(answer.restartAt, now)} (${ageOf(answer.restartAt, now) ?? 'unknown age'})`,
    },
    {
      label: 'source',
      value: `${answer.source.kind}, saved by cmux at ${restartWhen(answer.source.savedAt, now)}`,
    },
    {
      label: 'sessions',
      value: `${answer.facts.size} (in ${answer.tabsWithSession} tabs)`,
    },
    // home-base-kwand.8: how many the idle filter leaves out of that set.
    ...(read.idleFor == null
      ? []
      : [
          {
            label: `idle for at least ${read.idleFor.words}`,
            value: `${groups.reduce((sum, group) => sum + group.entries.length, 0)} listed; the rest were active more recently, or have no known activity (never counted as idle)`,
          },
        ]),
    ...groups.map((group) => ({
      label: `${BEFORE_RESTART_WORDS[group.state].emoji} ${BEFORE_RESTART_WORDS[group.state].title}`,
      value: String(group.entries.length),
    })),
    // kwand.12: why sessions whose tab is gone can still be unknown.
    ...answer.unplaced.map((pane) => ({
      label: 'unmatched Claude pane',
      value: unplacedPaneWords(pane),
    })),
  ];
  blocks.push(
    style.color
      ? fieldLines(fields, {
          color: true,
          indent: BODY_COLUMN,
          width: style.width,
        })
      : fields
          .map((entry) => `- **${entry.label}:** ${entry.value}`)
          .join('\n'),
  );
  const paneSummaryReason = read.panes.ok ? null : read.panes.reason;
  for (const group of groups) {
    const words = BEFORE_RESTART_WORDS[group.state];
    blocks.push(
      header(`${words.title} (${group.entries.length})`, words.emoji, 2, style),
    );
    for (const entry of group.entries) {
      if (entry.row != null) {
        blocks.push(renderRow(entry.row, true, style, paneSummaryReason, now));
        continue;
      }
      const tab = entry.fact.tab;
      const line = `${tab.title ?? '(untitled tab)'} — not in this inbox (session ${entry.sessionId}${tab.workspaceTitle == null ? '' : `, workspace ${tab.workspaceTitle}`})`;
      const reason = `${beforeRestartLine(entry.fact, now)}${entry.fact.state === 'unknown' ? '' : ` (${entry.fact.reason})`}`;
      blocks.push(
        style.color
          ? `${wrapHanging(line, {hang: BODY_COLUMN + 3, indent: BODY_COLUMN, width: style.width})}\n${wrapHanging(reason, {hang: BODY_COLUMN + 6, indent: BODY_COLUMN + 3, width: style.width})}`
          : `${line}\n  ${reason}`,
      );
    }
  }
  return spacedList(blocks);
}

/** The old reports as JSON: how they were read, and how many sessions have one. */
function oldReportsJson(old: InboxRead['untracked']['oldReports']): unknown {
  if (old == null) return null;
  if (old.kind !== 'read') return old;
  return {
    corrupt: old.corrupt,
    kind: old.kind,
    path: old.path,
    sessions: old.bySession.size,
  };
}

/**
 * The JSON form (j8q3e.1 D1: the TUI reads it, so it carries every card
 * field): per session the card — requests with stage and next stage under
 * `card.youAsked`, the action line with its D3 rule, the section — plus the
 * git facts, the counts, the status and the model with the message log
 * summarised. `summary` is the summary block's entries (Done and Archived
 * included, since a reader of the JSON filters for itself).
 *
 * Its return type is inferred and exported as `InboxJson` (F11,
 * home-base-j8q3e.1.10): the threads TUI checks its parser against it, so a
 * new card shape here fails that check instead of the TUI refusing to load.
 */
export function inboxJson(
  read: InboxRead,
  options: {pinnedProjects?: readonly string[]} = {},
) {
  const sorted = [...read.rows].sort(byNewest);
  return {
    // home-base-kwand.2: every session of the before set, grouped by the state
    // now, those with no row in this inbox included; or why it is unknown.
    beforeRestart: beforeRestartJson(read),
    corrupt: read.corrupt,
    hiddenByAge: read.hiddenByAge,
    // home-base-kwand.8 (G4): `--idle-for` and what it left out (active
    // sessions counted, undated ones named); null when it was not given.
    idleFor:
      read.idleFor == null
        ? null
        : {
            leftOutActive: read.idleFor.active.length,
            leftOutUndated: read.idleFor.undated,
            ms: read.idleFor.ms,
            text: read.idleFor.text,
            words: read.idleFor.words,
          },
    indexPath: read.indexPath,
    // D-DRAFTS: how the drafts store was read, and the drafts no row carries.
    inputDrafts: read.inputDrafts,
    missing: read.missing,
    // j8q3e.7 D6/D8: how the panes were looked up (the Map would print as
    // `{}`, which reads as "no panes"), and the D8 count.
    openPanesWithoutRequest: openPanesWithoutRequest(sorted, read.panes),
    // j8q3e.17 D2/D3: how many each source placed, and the Claude panes
    // neither placed, each with why.
    panes: read.panes.ok
      ? {
          ok: true,
          sessions: read.panes.bySession.size,
          statusLineFailure: read.panes.statusLine.failure,
          statusLineSessions: [...read.panes.bySession.values()].filter(
            (pane) => pane.source === 'status-line',
          ).length,
          unplaced: read.panes.statusLine.unplaced.map((pane) => ({
            detail: pane.detail,
            kind: pane.kind,
            surface: pane.surface.ref,
            surfaceId: pane.surface.id ?? null,
          })),
        }
      : {ok: false, reason: read.panes.reason},
    // D-PINS (home-base-yukaf.9): the repos a by-repo view lists first.
    pinnedProjects: [...(options.pinnedProjects ?? [])],
    // D-READ-STATE: how the read marks were read; every `unread` is null when not.
    readMarks: read.readMarks,
    sessions: sorted.map((row) => ({
      action: row.card.action,
      // home-base-kwand.2: the tab it was in before the restart, and what that
      // is now; null when it was in no recorded tab.
      beforeRestart: row.beforeRestart,
      card: row.card,
      // F24: where `claude --resume` must run; null when no checkout is known.
      checkout: rowCheckout(row),
      counts: row.loaded?.counts ?? null,
      // D6 (home-base-j8q3e.1.2): a full card or one line.
      display: row.display,
      // home-base-kwand.4: how its last turn ended (replied, cutOff with
      // inFlight and live, workingNow, or unknown with the reason).
      ending: row.ending,
      // home-base-kwand.5 (D4): Justin's flags, NOT `card.marks` (that is the
      // chain name, handoff number and mayor role). `emoji` is the union over
      // the session's chain (⭐ for a starred one), `labels` the `mark:` labels
      // it came from, `undecodable` the `mark:` labels ignored with why, and
      // `problems` the chain sessions whose flags could not be read. Null: no
      // session bead was loaded to carry flags.
      flags: row.flags ?? null,
      git: row.git,
      // home-base-89c8h.3: a refused or deferred handoff with no successor yet.
      handoff: row.handoff,
      // home-base-kwand.8 (G4): ms from lastActivityAt to the read's clock;
      // null when the last activity cannot be dated (never idle, rule 7).
      idleMs: row.idleMs ?? null,
      // D-DRAFTS: the live unsent text for this session, or null.
      inputDraft: row.inputDraft,
      lastActivityAt: row.lastActivityAt,
      // D-READ-STATE: Claude's last activity, what `thread read --seen` takes.
      lastAssistantAt: row.lastAssistantAt,
      // The message log's text can run to megabytes across dozens of
      // sessions; `thread show <id>` prints it. Here: its kind and size.
      model:
        row.loaded == null
          ? null
          : {
              ...row.loaded.model,
              log:
                row.loaded.model.log.kind === 'read'
                  ? {kind: 'read', lines: row.loaded.model.log.lines.length}
                  : row.loaded.model.log,
            },
      // home-base-kwand.8 (G4): why a row older than the --days window is
      // shown anyway (waiting, unsentDraft, beforeRestart, exportBehind,
      // unknown, unreadable, indexUndated, transcriptWritten); null inside it.
      olderShown: row.olderShown ?? null,
      // F6: a folded one-liner names every session it stands for.
      repeats: row.repeats,
      repo: row.repo,
      resume: row.card.resume,
      section: row.section,
      sessionBeadId: row.sessionBeadId,
      sessionId: row.sessionId,
      startedAt: row.startedAt,
      status: row.loaded?.status ?? null,
      title: row.title,
      tracked: row.tracked,
      // D-READ-STATE: true / false, or null when it could not be told.
      unread: row.unread,
      unreadable: row.unreadable,
      // D6: the facts an untracked session was read from, and the verdict
      // (its evidence of open work, and what could not be measured).
      untracked:
        row.untracked == null
          ? null
          : {
              ...row.untracked.session,
              evidence: row.untracked.verdict.evidence,
              line:
                row.display === 'line'
                  ? untrackedLine(
                      row.card,
                      row.untracked.session.firstMessage,
                      sessionsIn(row),
                    )
                  : null,
              unmeasured: row.untracked.verdict.unmeasured,
            },
    })),
    summary: inboxSummary(sorted, true),
    // F5: the test sessions the printed inbox only counts.
    testSessions: read.testSessions,
    // The old reports' Map would print as `{}`, which reads as "no reports";
    // the JSON carries how they were read and how many there are instead.
    untracked: {
      ...read.untracked,
      oldReports: oldReportsJson(read.untracked.oldReports),
    },
  };
}

/** The record `thread inbox --json` prints (before JSON serialisation). */
export type InboxJson = ReturnType<typeof inboxJson>;

export interface ThreadInboxOptions {
  all: boolean;
  /**
   * home-base-kwand.2: `--before-restart`, only the sessions that were in a
   * tab before the last restart, grouped by the state now.
   */
  beforeRestart?: boolean;
  /** Default: the real reader (clocks, tab record, cmux's files, screens). */
  beforeRestartReader?: BeforeRestartReader | null;
  /**
   * home-base-l2ejg.11: the namer for chains with no label. Absent: the
   * registry's. Null: none (tests pin it, so their names are not random).
   */
  chainNamer?: ChainNamer | null;
  cwd?: string;
  days: number;
  env?: EnvLike;
  /**
   * home-base-kwand.8 (G4): `--idle-for` as typed (`24h`, `3d`, `2w`): only
   * sessions whose last activity is at least that old. Null or absent: none.
   */
  idleFor?: string | null;
  json: boolean;
  /** Default: the real lookup (cmux, ps, the hook store). */
  lookupPanes?: () => Promise<PaneLookup>;
  now?: Date;
  order: InboxOrder;
  repo: string | null;
  style?: OutputStyle;
  timeZone?: string;
}

/**
 * `thread inbox` (knob on): print, return the exit code. 1 = index
 * unreadable, 2 = a bad `--idle-for` (nothing read).
 */
export async function runSessionInbox(
  options: ThreadInboxOptions,
): Promise<number> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? new Date();
  const days =
    Number.isFinite(options.days) && options.days > 0
      ? options.days
      : INBOX_DEFAULT_DAYS;
  // home-base-kwand.8 (G4): refused before anything is read.
  const idleFor =
    options.idleFor == null ? null : parseIdleFor(options.idleFor);
  if (idleFor?.kind === 'bad') {
    console.error(`thread inbox: ${idleFor.reason}`);
    return 2;
  }
  // home-base-9uzxw.2 (D-PERF): the JSON carries where its time went.
  const timings = options.json ? startTimings() : null;
  // home-base-9uzxw.5 F15: finish() also puts Bun.spawn back, so it runs
  // whatever throws (finish is idempotent).
  try {
    const result = await readInbox({
      // home-base-kwand.2: what was open before the restart. Real only with
      // the real pane lookup, so a test that fakes the panes never reads this
      // machine's cmux files; tests inject their own reader.
      beforeRestart:
        options.beforeRestartReader !== undefined
          ? options.beforeRestartReader
          : options.lookupPanes == null
            ? realBeforeRestartReader(env)
            : null,
      // home-base-l2ejg.11: chains with no label are named from the registry.
      chainNamer:
        options.chainNamer === undefined
          ? registryChainNamer(env)
          : options.chainNamer,
      cwd,
      days,
      env,
      keepBeforeRestart: options.beforeRestart === true,
      // j8q3e.7 D6: the live pane lookup, once per run (tests inject theirs).
      lookupPanes:
        options.lookupPanes ??
        (async () => await lookupLivePanes(realPaneSources(env))),
      now,
      repo: options.repo,
      timings,
    });
    if (result.kind === 'failed') {
      console.error(`thread inbox: ${result.reason}`);
      return 1;
    }
    const read =
      idleFor == null ? result.read : filterIdleFor(result.read, idleFor, now);
    // D-PINS: the user file, then the project file, like every thread knob.
    const config = timed(timings, 'config', () =>
      resolveThreadConfig({cwd, env}),
    );
    for (const problem of config.problems) {
      if (problem.includes('pinnedProjects')) {
        console.error(`thread inbox: ${problem}`);
      }
    }
    const pinnedProjects = config.pinnedProjects;
    if (options.json) {
      // F2 (home-base-j8q3e.1.9): wait for a pipe to take all of it before the
      // caller's process.exit.
      const text = timed(timings, 'json build', () =>
        JSON.stringify(inboxJson(read, {pinnedProjects}), null, 2),
      );
      const printed =
        timings == null
          ? {problem: null, text}
          : inboxJsonWithTimings(text, timings.finish());
      if (printed.problem != null) {
        console.error(`thread inbox: ${printed.problem}`);
      }
      await writeStdout(`${printed.text}\n`);
      return 0;
    }
    if (options.beforeRestart === true) {
      await writeStdout(
        `${renderBeforeRestartInbox(read, {
          now,
          style: options.style ?? outputStyle(process.stdout),
        })}\n`,
      );
      return 0;
    }
    await writeStdout(
      `${renderInbox(read, {
        all: options.all,
        days,
        now,
        order: options.order,
        pinnedProjects,
        style: options.style ?? outputStyle(process.stdout),
        timeZone: options.timeZone,
      })}\n`,
    );
    return 0;
  } finally {
    timings?.finish();
  }
}
