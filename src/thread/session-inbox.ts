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
 * R5: a P0 left 31 days must not vanish). What the window hid is counted per
 * status in one line, never dropped silently.
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
import type {InputDraft} from './input-drafts';
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
import type {SessionModel} from './session-model';
import type {SessionStatus, StatusCounts} from './session-status';
import type {
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
import {resolveRepoTag, resolveThreadConfig} from './config';
import {listInputDrafts} from './input-drafts';
import {
  isSafeSessionId,
  readLastAssistantLine,
  readMessageLog,
} from './message-log';
import {lookupPanes as lookupLivePanes, realPaneSources} from './pane-join';
import {ageWords, tildeText} from './part-one';
import {pinnedFirst} from './pinned-projects';
import {readReadMarks, UNREAD_MARKER, unreadFor} from './read-marks';
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
import {readSessionIndex} from './session-index';
import {
  createLoadCache,
  firstUserLine,
  lastAssistantLine,
  loadSession,
  newestLogAt,
} from './session-model';
import {sessionDisplayName} from './session-name';
import {deriveStatus, statusCounts, statusFactsOf} from './session-status';
import {
  carriesTestDataMarker,
  defaultDevRoot,
  readUntracked,
  repeatKey,
  untrackedActivityAt,
  untrackedCard,
  untrackedLine,
  untrackedVerdict,
} from './session-untracked';

export const INBOX_DEFAULT_DAYS = 30;

/** Why a card's pane is unknown when the caller ran no lookup (j8q3e.7 D6). */
export const PANES_NOT_LOOKED_UP = 'the pane lookup was not run';

/** j8q3e.1 D5: newest first (the default), by D5 section, or by repo. */
export type InboxOrder = 'recent' | 'repo' | 'status';

export interface InboxRow {
  /** The card (j8q3e.1 D2): every field the printed inbox and the JSON show. */
  card: SessionCard;
  /**
   * D6 (home-base-j8q3e.1.2): an untracked session with nothing open found is
   * ONE line; every other session is a full card.
   */
  display: 'card' | 'line';
  /** The git facts the card reads; null for a session that did not load. */
  git: CardGit | null;
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
  /** Index lines that could not be parsed: named, never dropped silently. */
  corrupt: {lineNumber: number; reason: string}[];
  /**
   * R5: sessions older than the window that it hid, counted by status kind
   * (waiting and unknown are never hidden, so never here).
   */
  hiddenByAge: Partial<Record<SessionStatus['kind'], number>>;
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

function byNewest(a: InboxRow, b: InboxRow): number {
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
function sessionsIn(row: InboxRow): number {
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

/** Read every session in the window. `failed` only when the index is unreadable. */
export async function readInbox(input: {
  /** Sessions loaded at once; default INBOX_CONCURRENCY. 1 = one at a time. */
  concurrency?: number;
  cwd: string;
  days: number;
  /** D6: untracked sessions are listed only under this directory (~/Dev). */
  devRoot?: string;
  env: EnvLike;
  /**
   * j8q3e.7 D6: the live pane lookup, run once per inbox run. Omitted, no
   * lookup runs and every card says its pane is unknown — `thread inbox`
   * passes the real one; tests pass a fake; a hook (workspace naming) none.
   */
  lookupPanes?: () => Promise<PaneLookup>;
  now: Date;
  repo: string | null;
}): Promise<
  {kind: 'failed'; reason: string} | {kind: 'read'; read: InboxRead}
> {
  const {cwd, env, now} = input;
  const read = readSessionIndex(env);
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
      : input.lookupPanes();
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
  const draftList = listInputDrafts(env);
  const liveDrafts = new Map<string, InboxInputDraft>();
  if (draftList.kind === 'read') {
    for (const entry of draftList.drafts) {
      if (entry.draft.clearedAt != null) continue;
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

  // F7 (home-base-vzwbj.4.9): the sessions load CONCURRENTLY, `concurrency`
  // at a time, sharing one cache for this run only (each checkout's git facts
  // and each beads export, read once). The rows are then built in index
  // order, exactly as the one-at-a-time loop built them.
  const cache = createLoadCache();
  const pendingLoads = mapConcurrently(
    candidates,
    input.concurrency ?? INBOX_CONCURRENCY,
    async (candidate) =>
      await loadSession({
        cache,
        cwd,
        env,
        selector: null,
        sessionIdOption: candidate.indexed.sessionId,
      }),
  );
  // D6 (home-base-j8q3e.1.2): every OTHER session under the dev root. Started
  // after the tracked loads, so their git runs while the transcripts are
  // scanned; it shares their cache, so a shared checkout is measured once.
  // EVERY id in the index is excluded, whatever its sightings: the tracked
  // half lists it (as a card, a ❔ card, or in the hidden-by-age count), so
  // none appears twice.
  const pendingUntracked = readUntracked({
    cache,
    days: input.days,
    devRoot: input.devRoot ?? defaultDevRoot(),
    env,
    exclude: new Set(index.sessions.map((indexed) => indexed.sessionId)),
    now,
    repo: input.repo,
  });
  const [loads, untracked, panes] = await Promise.all([
    pendingLoads,
    pendingUntracked,
    pendingPanes,
  ]);
  // home-base-mbnjv.3 (D9): every session bead loaded in this run, so a card
  // names its predecessor and successor by title and sees a half-written link.
  const neighbors = new Map<string, CardNeighbor>();
  for (const loaded of loads) {
    const bead = loaded?.kind === 'loaded' ? loaded.model.beads.session : null;
    if (bead != null) {
      neighbors.set(bead.id, {labels: bead.labels, title: bead.title});
    }
  }
  for (const [position, candidate] of candidates.entries()) {
    const {activity, indexed, lastAssistantAt, old, sighting} = candidate;
    const loaded = loads[position];
    if (loaded == null) continue;
    if (loaded.kind !== 'loaded') {
      const detail =
        loaded.kind === 'unreadable' ? loaded.detail : loaded.reason;
      const title = '(could not load this session)';
      rows.push({
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
        git: null,
        inputDraft: null,
        lastActivityAt: activity,
        lastAssistantAt,
        loaded: null,
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
    const status = deriveStatus(facts, {asIfYielded: false, now});
    const lastRecord = model.transcript.lastRecordAt.ok
      ? model.transcript.lastRecordAt.value
      : null;
    const lastActivityAt = newest(lastRecord, activity);
    const lastActivityMs = parseInstant(lastActivityAt ?? '');
    if (
      old &&
      (lastActivityMs == null || lastActivityMs < since) &&
      status.kind !== 'waiting' &&
      status.kind !== 'unknown' &&
      !liveDrafts.has(model.sessionId)
    ) {
      hiddenByAge[status.kind] = (hiddenByAge[status.kind] ?? 0) + 1;
      continue;
    }
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
      '⚠️ title unknown (the session bead could not be read)';
    const unreadable = unreadableOf(model);
    rows.push({
      card: buildCard({
        action,
        age: ageOf(lastActivityAt, now),
        counts,
        model,
        neighbors,
        panes,
        section,
        status,
        title,
        unreadable,
      }),
      display: 'card',
      git: cardGit(model.git),
      inputDraft: null,
      lastActivityAt,
      lastAssistantAt,
      loaded: {counts, model, status},
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
      ? readLastAssistantLine(messageLogPath(session.sessionId, env))
      : null;
    rows.push({
      card,
      display: verdict.display,
      git: cardGit(session.git),
      inputDraft: null,
      lastActivityAt: untrackedActivityAt(session),
      lastAssistantAt: assistant?.kind === 'found' ? assistant.line.at : null,
      loaded: null,
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
      section: 'unsentDraft',
    };
  }
  const inputDrafts: InboxDrafts =
    draftList.kind === 'failed'
      ? draftList
      : {
          failures: draftList.failures,
          kind: 'read',
          unshown: [...liveDrafts.entries()]
            .filter(([sessionId]) => !shownDrafts.has(sessionId))
            .map(([sessionId, draft]) => ({...draft, sessionId})),
        };
  const untrackedRead: InboxRead['untracked'] = {
    devRoot: untracked.devRoot,
    failures: untracked.failures,
    oldReports: untracked.oldReports,
    outsideRoot: untracked.outsideRoot,
    unattributed: untracked.unattributed,
    unplaced: untracked.unplaced,
  };
  const shaped = shapeRows(rows);
  return {
    kind: 'read',
    read: {
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
      testSessions: shaped.testSessions,
      untracked: untrackedRead,
    },
  };
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
  // j8q3e.6 D3: a checkout's dirt that no untracked session's transcript
  // names, once. j8q3e.13 F4: the words claim only what was checked. A
  // session that ran `bun add`, `prettier --write .` or a code generator
  // dirtied files without naming them, so "no session wrote" could be false.
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
      `${tildeText(dirt.checkout)}: ${files} that no Not-tracked session's transcript names${named}${unchecked}.`,
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
 * D-READ-STATE (home-base-yukaf.9): an unread session's heading starts with
 * UNREAD_MARKER. Only `unread === true` gets it; null (could not tell) does
 * not, and the inbox says why once.
 */
function unreadLead(unread: boolean | null): string {
  return unread === true ? `${UNREAD_MARKER} ` : '';
}

function headingText(card: SessionCard, unread: boolean | null): string {
  return `${unreadLead(unread)}${card.emoji} ${tildeText(sessionDisplayName(card.repoTag, card.title))}`;
}

function markdownCard(
  card: SessionCard,
  showSection: boolean,
  unread: boolean | null,
): string {
  const lines: string[] = [];
  if (showSection) {
    lines.push(`- **Section:** ${card.sectionEmoji} ${card.sectionTitle}`);
  }
  const asked = youAskedLines(card.youAsked);
  if (card.youAsked.kind === 'requests') {
    lines.push('- **You asked:**', ...asked.map((line) => `  - ${line}`));
  } else {
    lines.push(`- **You asked:** ${asked.join(' ')}`);
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
  const pane = paneLineParts(card.paneFact);
  lines.push(
    `- **Pane:** ${pane.before}${pane.command == null ? '' : `\`${pane.command}\``}${pane.after}`,
  );
  return [
    `**${headingText(card, unread)}**${card.age == null ? '' : ` (${card.age})`}`,
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
    value: youAskedLines(card.youAsked).join('\n'),
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
  const pane = paneLineParts(card.paneFact);
  fields.push({
    label: 'Pane',
    value: `${pane.before}${pane.command == null ? '' : code(pane.command)}${pane.after}`,
  });
  const heading = `${paint(headingText(card, unread), ['bold'], color)}${card.age == null ? '' : `  ${paint(`(${card.age})`, ['dim'], color)}`}`;
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
function lineEntry(row: InboxRow, style: OutputStyle): string {
  const line = untrackedLine(
    row.card,
    row.untracked?.session.firstMessage ?? null,
    sessionsIn(row),
  );
  const lead = unreadLead(row.unread);
  if (!style.color) return lead === '' ? line : `**${lead.trim()}** ${line}`;
  const text = lead === '' ? line : `${paint(lead, ['bold'], true)}${line}`;
  return wrapHanging(text, {
    hang: BODY_COLUMN + 3,
    indent: BODY_COLUMN,
    width: style.width,
  });
}

/** A session as the inbox prints it: its full card, or D6's one line. */
function renderRow(
  row: InboxRow,
  showSection: boolean,
  style: OutputStyle,
): string {
  if (row.display === 'line') return lineEntry(row, style);
  return style.color
    ? ansiCard(row.card, showSection, style, row.unread)
    : markdownCard(row.card, showSection, row.unread);
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
  handedOff: '🤝 handed off',
  openWork: '⚠️ open work',
  outOfContext: '🧯 out of context',
  unknown: '❔ unknown',
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
  return `${plural(total, 'older session', 'older sessions')} hidden (no activity in the last ${plural(days, 'day', 'days')}; --days): ${parts}. Waiting and unknown sessions are never hidden by age.`;
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
  return notes;
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
  const title = `Inbox — sessions with activity in the last ${plural(options.days, 'day', 'days')}${all ? ', done and archived included' : ''}`;
  blocks.push(header(title, '📥', 1, style));
  if (read.missing) {
    blocks.push(
      `No session bead recorded yet: ${tildeText(read.indexPath)} does not exist (componentConfig.thread.sessionBeads has never filed a session bead on this machine), so every session below is Not tracked.`,
    );
  }
  const visible = read.rows
    .filter((row) => sectionVisible(row.section, all))
    .sort(byNewest);

  // j8q3e.1 D5: the summary first, one line per non-empty section.
  const summary = inboxSummary(visible, all);
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
      const rows = visible.filter((row) => row.section === section.key);
      if (rows.length === 0) continue;
      blocks.push(
        header(`${section.title} (${rows.length})`, section.emoji, 2, style),
      );
      for (const row of rows) blocks.push(renderRow(row, false, style));
    }
  } else if (order === 'repo') {
    const groups = new Map<string, InboxRow[]>();
    for (const row of visible) {
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
      for (const row of rows) blocks.push(renderRow(row, true, style));
    }
  } else if (visible.length > 0) {
    blocks.push(header('Sessions, newest first', '🕒', 2, style));
    for (const row of visible) blocks.push(renderRow(row, true, style));
  }

  const hidden = read.rows.length - visible.length;
  if (!read.missing && visible.length === 0) {
    blocks.push(
      read.rows.length === 0
        ? `No session had activity in the last ${plural(options.days, 'day', 'days')}.`
        : 'Nothing open.',
    );
  }
  const notes: string[] = [];
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
  notes.push(...untrackedNotes(read.untracked));
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
    corrupt: read.corrupt,
    hiddenByAge: read.hiddenByAge,
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
      card: row.card,
      // F24: where `claude --resume` must run; null when no checkout is known.
      checkout: rowCheckout(row),
      counts: row.loaded?.counts ?? null,
      // D6 (home-base-j8q3e.1.2): a full card or one line.
      display: row.display,
      git: row.git,
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
  cwd?: string;
  days: number;
  env?: EnvLike;
  json: boolean;
  /** Default: the real lookup (cmux, ps, the hook store). */
  lookupPanes?: () => Promise<PaneLookup>;
  now?: Date;
  order: InboxOrder;
  repo: string | null;
  style?: OutputStyle;
  timeZone?: string;
}

/** `thread inbox` (knob on): print, return the exit code. 1 = index unreadable. */
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
  const result = await readInbox({
    cwd,
    days,
    env,
    // j8q3e.7 D6: the live pane lookup, once per run (tests inject theirs).
    lookupPanes:
      options.lookupPanes ??
      (async () => await lookupLivePanes(realPaneSources(env))),
    now,
    repo: options.repo,
  });
  if (result.kind === 'failed') {
    console.error(`thread inbox: ${result.reason}`);
    return 1;
  }
  // D-PINS: the user file, then the project file, like every thread knob.
  const config = resolveThreadConfig({cwd, env});
  for (const problem of config.problems) {
    if (problem.includes('pinnedProjects')) {
      console.error(`thread inbox: ${problem}`);
    }
  }
  const pinnedProjects = config.pinnedProjects;
  if (options.json) {
    // F2 (home-base-j8q3e.1.9): wait for a pipe to take all of it before the
    // caller's process.exit.
    await writeStdout(
      `${JSON.stringify(inboxJson(result.read, {pinnedProjects}), null, 2)}\n`,
    );
    return 0;
  }
  await writeStdout(
    `${renderInbox(result.read, {
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
}
