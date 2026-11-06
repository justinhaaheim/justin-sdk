/**
 * Picking up a handoff, as ONE repeatable operation (home-base-npbse.1.1; P2, P4
 * and P6 in the design field of home-base-npbse.1).
 *
 * Until 2026-11-06 `thread request --continues <predecessor>` only linked two
 * sessions. The successor then showed "No requests filed", each open request
 * had to be adopted by hand, and the predecessor's unanswered questions
 * disappeared from view. Twice a successor took on too few requests.
 *
 * pickUpHandoff prints nothing and never exits. It does not take the per-session
 * lock either: `thread request --continues` takes it around this call
 * (request.ts), and the capture child (home-base-npbse.1.2) already holds it.
 * It runs, in order:
 *
 *   a. One successor per predecessor (P4): the link is made only when the
 *      predecessor has no `continued-by:` yet or already names this session.
 *      Otherwise it writes nothing except, once, `not-a-successor` and one note
 *      line on this session. That label is terminal.
 *   b. The link, with linkContinuation, when either half is missing.
 *   c. Every open request OF THE PREDECESSOR is adopted (request-writes.ts).
 *      "Of the predecessor" means readSessionTree, the query that decides what a
 *      session shows, and NOT the predecessor bead's children: most requests in
 *      a long chain were adopted from an earlier session and are not its
 *      children.
 *   d. Every unanswered question of the predecessor is carried over by adding
 *      this session's `sid:` label. A question is selected by `ask` + `sid:`
 *      (session-tree.ts, session-select.ts), which is why it vanished from a
 *      successor; the label is the whole fix and no selector changed. Its
 *      parent, its `to:` labels and its older `sid:` labels stay.
 *   e. The predecessor's title, when this session still has `auto-title`, then
 *      the workspace name and tab title. A failed name sync stays soft.
 *   f. `picked-up` on this session once a to d hold, and the line "picked up by
 *      <successor>: N requests, M questions carried over" on both beads. N and M
 *      count what the successor now holds, hand adoptions included.
 *
 * REPEATABLE. Every write is decided from the current state, so a run after a
 * failure finishes the rest, and a run that finds it all done writes nothing.
 * The predecessor's line is written before the successor's label, so `picked-up`
 * means both lines exist.
 *
 * A FAILURE IS NEVER A NORMAL VALUE (critical rule 7). A DB that cannot be read
 * may hold requests nobody can see, so a run that hit one carries what it can
 * see and returns `failed`, never `picked-up`.
 */

import type {EnvLike} from './paths';
import type {BeadLocation} from './session-handoff';
import type {TreeIssue} from './session-tree';

import {dirname} from 'node:path';

import {
  brShow,
  brUpdate,
  describeBrFailed,
  findBeadsWorkspace,
  resolveRecordedBeadsDb,
} from '../beads/br';
import {continuedByOf} from './handoff-view';
import {adoptBead, titleSetEdit} from './request-writes';
import {
  AUTO_TITLE_LABEL,
  CONTINUED_BY_LABEL_PREFIX,
  CONTINUES_LABEL_PREFIX,
  labelValue,
  NOT_A_SUCCESSOR_LABEL,
  PICKED_UP_LABEL,
  REQUEST_LABEL,
  SESSION_LABEL,
  SID_LABEL_PREFIX,
  sidLabel,
  sightingIn,
} from './session-bead';
import {linkContinuation, locateSessionBead} from './session-handoff';
import {
  appendSessionSighting,
  corruptSightingsNote,
  readSessionSightings,
  sessionBeadSighting,
} from './session-index';
import {appendNote} from './session-marks';
import {sessionIdForSelector} from './session-select';
import {isOpen} from './session-status';
import {readSessionTree} from './session-tree';
import {workspaceNameFollowUp} from './workspace-name-session';

export interface PickedItem {
  id: string;
  title: string;
}

export interface PickedItems {
  questions: PickedItem[];
  requests: PickedItem[];
}

/** Where a pickup stopped. `lock` comes only from a caller that takes the lock. */
export type PickUpStep =
  | 'adopt-requests'
  | 'carry-questions'
  | 'find-predecessor'
  | 'link'
  | 'lock'
  | 'mark-not-a-successor'
  | 'read-predecessor'
  | 'read-successor'
  | 'record'
  | 'title';

/** What this run did, and what the successor held already. */
export interface PickUpProgress {
  alreadyHeld: PickedItems;
  carried: PickedItems;
  /** The two sessions are linked; null when they are not (yet). */
  link: {oldBeadId: string; oldTitle: string} | null;
  /** `picked-up` is on the successor: a to d held and both lines are written. */
  pickedUpLabelled: boolean;
  renamedSession: {beadId: string; title: string} | null;
  /** The workspace-name follow-up: one soft line, or null. */
  workspaceNote: string | null;
}

export type PickUpOutcome =
  | {
      alreadyHeld: PickedItems;
      carried: PickedItems;
      kind: 'picked-up';
      newBeadId: string;
      oldBeadId: string;
      oldTitle: string;
      renamedSession: {beadId: string; title: string} | null;
      workspaceNote: string | null;
      /** False on a run that found it all done: no bead or index line changed. */
      wrote: boolean;
    }
  | {
      /** The other session, from the label; null when no record names it. */
      continuedBy: string | null;
      kind: 'not-a-successor';
      newBeadId: string;
      oldBeadId: string;
      reason: string;
      /** True on the one run that wrote the label and the note. */
      recordedNow: boolean;
    }
  | {
      done: PickUpProgress;
      kind: 'failed';
      reason: string;
      step: PickUpStep;
    };

export interface PickUpInput {
  cwd: string;
  env: EnvLike;
  now?: Date;
  predecessorBeadId: string;
  successor: {
    beadId: string;
    db: string;
    sessionId: string;
  };
}

/** What the pickup calls outside itself; tests and the capture child inject. */
export interface PickUpDeps {
  link: typeof linkContinuation;
  readTree: typeof readSessionTree;
  /** Sets the workspace name and tab title. Soft: one line, or null. */
  syncNames: (input: {
    cwd: string;
    env: EnvLike;
    sessionId: string;
  }) => Promise<string | null>;
  update: typeof brUpdate;
}

/** The note line that records a refusal; `continuedByInRecord` reads it back. */
function notLinkedRecord(oldBeadId: string, continuedBy: string): string {
  return `not linked: ${oldBeadId} is already continued by ${continuedBy}`;
}

const NOT_LINKED_RECORD = /not linked: \S+ is already continued by (\S+)/;

function continuedByInRecord(notes: string | null): string | null {
  return NOT_LINKED_RECORD.exec(notes ?? '')?.[1] ?? null;
}

function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The start of the record line, which marks it as already written. */
function recordMarker(newBeadId: string): string {
  return `picked up by ${newBeadId}:`;
}

function recordLine(
  newBeadId: string,
  requests: number,
  questions: number,
): string {
  return `${recordMarker(newBeadId)} ${counted(requests, 'request', 'requests')}, ${counted(questions, 'question', 'questions')} carried over`;
}

/** One `sid:` from the index, else from the bead's own labels; never a guess. */
function predecessorSessionId(
  old: Extract<BeadLocation, {kind: 'found'}>,
  oldBeadId: string,
  env: EnvLike,
): {id: string; ok: true} | {ok: false; reason: string} {
  if (!old.labels.includes(SESSION_LABEL)) {
    return {
      ok: false,
      reason: `${oldBeadId} is not a session bead: it has no "${SESSION_LABEL}" label. Give the bead the handoff block names.`,
    };
  }
  const indexed = sessionIdForSelector(oldBeadId, env);
  if (indexed.kind === 'failed') return {ok: false, reason: indexed.reason};
  if (indexed.kind === 'found') return {id: indexed.sessionId, ok: true};
  const fromLabel = labelValue(old.labels, SID_LABEL_PREFIX);
  if (fromLabel != null) return {id: fromLabel, ok: true};
  return {
    ok: false,
    reason: `${indexed.reason}, and ${oldBeadId} carries no ${SID_LABEL_PREFIX} label, so its requests cannot be found`,
  };
}

/**
 * What the predecessor shows, from the query that decides it. Each entry of
 * `problems` is something that could not be read, so it may hide more.
 */
function predecessorWork(input: {
  env: EnvLike;
  oldBeadId: string;
  oldDb: string;
  readTree: typeof readSessionTree;
  sessionId: string;
}):
  | {kind: 'failed'; reason: string}
  | {
      kind: 'read';
      problems: string[];
      questions: TreeIssue[];
      requests: TreeIssue[];
    } {
  const read = readSessionSightings(input.sessionId, input.env);
  if (read.kind === 'failed') {
    return {
      kind: 'failed',
      reason: `the sessions index is unreadable: ${read.path}: ${read.error}`,
    };
  }
  const sightings = read.kind === 'read' ? read.sightings : [];
  const created = sessionBeadSighting(sightings);
  const beadsDirs = [
    created?.beadsDir ?? dirname(input.oldDb),
    ...sightings.map((entry) => entry.beadsDir),
  ];
  const tree = input.readTree({
    beadsDirs,
    sessionBeadId: input.oldBeadId,
    sessionId: input.sessionId,
  });
  const corruptNote = corruptSightingsNote(read);
  return {
    kind: 'read',
    problems: [
      ...tree.problems,
      ...(tree.sessionMissing != null ? [tree.sessionMissing] : []),
      ...(corruptNote != null ? [corruptNote] : []),
    ],
    questions: tree.questions.filter(isOpen),
    requests: tree.requests.map((node) => node.request).filter(isOpen),
  };
}

/**
 * Move each open bead over, keeping going past a failure so one bad bead does
 * not leave the rest behind. The index line comes first and is checked for held
 * beads too, so a line a failed run did not write is written by the next one.
 */
function carryAll(input: {
  env: EnvLike;
  isHeld: (issue: TreeIssue) => boolean;
  issues: readonly TreeIssue[];
  knownDirs: Set<string>;
  now: Date;
  sessionId: string;
  write: (issue: TreeIssue, db: string) => string | null;
}): {
  alreadyHeld: PickedItem[];
  carried: PickedItem[];
  failures: string[];
  wroteSighting: boolean;
} {
  const alreadyHeld: PickedItem[] = [];
  const carried: PickedItem[] = [];
  const failures: string[] = [];
  let wroteSighting = false;
  for (const issue of input.issues) {
    const item = {id: issue.id, title: issue.title};
    const place = resolveRecordedBeadsDb(issue.beadsDir);
    if (place.kind !== 'found') {
      failures.push(
        `${issue.id} (${issue.title}): its beads DB (${issue.beadsDir}) could not be found: ${place.reason}`,
      );
      continue;
    }
    if (!input.knownDirs.has(place.beadsDir)) {
      const recorded = appendSessionSighting(
        sightingIn(
          'adopted-in',
          issue.id,
          {beadsDir: place.beadsDir, root: dirname(place.beadsDir)},
          input.sessionId,
          input.now,
        ),
        input.env,
      );
      if (recorded.kind === 'failed') {
        failures.push(
          `${issue.id} (${issue.title}): the sessions index was NOT told about ${place.beadsDir}, so this session would not see it: ${recorded.error}`,
        );
        continue;
      }
      input.knownDirs.add(place.beadsDir);
      wroteSighting = true;
    }
    if (input.isHeld(issue)) {
      alreadyHeld.push(item);
      continue;
    }
    const failure = input.write(issue, place.db);
    if (failure != null) {
      failures.push(`${issue.id} (${issue.title}): ${failure}`);
      continue;
    }
    carried.push(item);
  }
  return {alreadyHeld, carried, failures, wroteSighting};
}

/**
 * The record on both beads (step f). A bead's line is written when this run
 * carried something, or when it has none yet, so a run that finds it all done
 * writes nothing. The successor's write holds `picked-up` and its line together.
 */
function recordPickup(input: {
  carriedAny: boolean;
  env: EnvLike;
  labelled: boolean;
  line: string;
  newBeadId: string;
  newDb: string;
  now: Date;
  oldBeadId: string;
  oldDb: string;
  update: typeof brUpdate;
}): {kind: 'failed'; reason: string} | {kind: 'recorded'; wrote: boolean} {
  const {env, line, now, update} = input;
  const marker = recordMarker(input.newBeadId);
  let wrote = false;
  const oldShown = brShow({db: input.oldDb, env}, input.oldBeadId);
  if (oldShown.kind !== 'ok') {
    return {
      kind: 'failed',
      reason: `${input.oldBeadId} could not be read back to record the pickup: ${oldShown.kind === 'notFound' ? 'not found' : describeBrFailed(oldShown)}`,
    };
  }
  if (input.carriedAny || !(oldShown.issue.notes ?? '').includes(marker)) {
    const written = update({db: input.oldDb, env}, input.oldBeadId, {
      notes: appendNote(oldShown.issue.notes, line, now),
    });
    if (written.kind === 'failed') {
      return {
        kind: 'failed',
        reason: `${input.oldBeadId} did not get its record line: ${describeBrFailed(written)}`,
      };
    }
    wrote = true;
  }
  if (input.carriedAny || !input.labelled) {
    const newShown = brShow({db: input.newDb, env}, input.newBeadId);
    if (newShown.kind !== 'ok') {
      return {
        kind: 'failed',
        reason: `${input.newBeadId} could not be read back to record the pickup: ${newShown.kind === 'notFound' ? 'not found' : describeBrFailed(newShown)}`,
      };
    }
    const written = update({db: input.newDb, env}, input.newBeadId, {
      addLabels: input.labelled ? [] : [PICKED_UP_LABEL],
      notes: appendNote(newShown.issue.notes, line, now),
    });
    if (written.kind === 'failed') {
      return {
        kind: 'failed',
        reason: `${input.newBeadId} was NOT labelled ${PICKED_UP_LABEL}: ${describeBrFailed(written)}`,
      };
    }
    wrote = true;
  }
  return {kind: 'recorded', wrote};
}

/** The whole operation. See the header. Prints nothing and never exits. */
export async function pickUpHandoff(
  input: PickUpInput,
  deps: Partial<PickUpDeps> = {},
): Promise<PickUpOutcome> {
  const {cwd, env, predecessorBeadId: oldBeadId, successor} = input;
  const {beadId: newBeadId, db: newDb, sessionId} = successor;
  const now = input.now ?? new Date();
  const update = deps.update ?? brUpdate;
  const link = deps.link ?? linkContinuation;
  const readTree = deps.readTree ?? readSessionTree;
  const syncNames = deps.syncNames ?? workspaceNameFollowUp;

  const progress: PickUpProgress = {
    alreadyHeld: {questions: [], requests: []},
    carried: {questions: [], requests: []},
    link: null,
    pickedUpLabelled: false,
    renamedSession: null,
    workspaceNote: null,
  };
  const failed = (step: PickUpStep, reason: string): PickUpOutcome => ({
    done: progress,
    kind: 'failed',
    reason,
    step,
  });

  // ---- both beads, read now: an earlier run or the other caller may have moved
  if (oldBeadId === newBeadId) {
    return failed(
      'find-predecessor',
      `${oldBeadId} is this session's own bead`,
    );
  }
  const mine = brShow({db: newDb, env}, newBeadId);
  if (mine.kind !== 'ok') {
    return failed(
      'read-successor',
      `this session's bead ${newBeadId} could not be read: ${mine.kind === 'notFound' ? `it is not in ${newDb}` : describeBrFailed(mine)}`,
    );
  }
  const myLabels = mine.issue.labels;
  if (myLabels.includes(NOT_A_SUCCESSOR_LABEL)) {
    const continuedBy = continuedByInRecord(mine.issue.notes);
    return {
      continuedBy,
      kind: 'not-a-successor',
      newBeadId,
      oldBeadId,
      reason: `this session is already labelled ${NOT_A_SUCCESSOR_LABEL}, which is final${continuedBy != null ? `: its record names ${continuedBy} as the session that continues the predecessor` : ''}`,
      recordedNow: false,
    };
  }
  const fallbacks = [newDb];
  const space = findBeadsWorkspace(cwd);
  if (space.kind === 'found') fallbacks.push(space.db);
  const old = locateSessionBead(
    oldBeadId,
    env,
    fallbacks,
    space.kind === 'failed' ? [`${cwd}: ${space.reason}`] : [],
  );
  if (old.kind === 'failed') return failed('find-predecessor', old.reason);
  if (old.kind === 'notFound') {
    return failed(
      'find-predecessor',
      `${oldBeadId} was not found in ${old.searched.length > 0 ? old.searched.join(' or ') : 'any beads DB'}`,
    );
  }

  // ---- a. one successor per predecessor (P4) ----
  const successors = continuedByOf(old.labels);
  const namesMe = successors.includes(newBeadId);
  const [other] = successors.filter((id) => id !== newBeadId);
  if (other != null && !namesMe) {
    const written = update({db: newDb, env}, newBeadId, {
      addLabels: [NOT_A_SUCCESSOR_LABEL],
      notes: appendNote(
        mine.issue.notes,
        notLinkedRecord(oldBeadId, other),
        now,
      ),
    });
    if (written.kind === 'failed') {
      return failed(
        'mark-not-a-successor',
        `${oldBeadId} is already continued by ${other}, but this session could not be labelled ${NOT_A_SUCCESSOR_LABEL}: ${describeBrFailed(written)}`,
      );
    }
    return {
      continuedBy: other,
      kind: 'not-a-successor',
      newBeadId,
      oldBeadId,
      reason: `${oldBeadId} is already continued by ${other}`,
      recordedNow: true,
    };
  }
  const oldSession = predecessorSessionId(old, oldBeadId, env);
  if (!oldSession.ok) return failed('find-predecessor', oldSession.reason);

  // ---- b. the link ----
  let wrote = false;
  const linkedBefore =
    namesMe && myLabels.includes(`${CONTINUES_LABEL_PREFIX}${oldBeadId}`);
  if (!linkedBefore) {
    const linked = link({
      cwd,
      env,
      newSession: {beadId: newBeadId, db: newDb},
      oldBeadId,
    });
    if (linked.kind === 'failed') return failed('link', linked.reason);
    wrote = true;
  }
  progress.link = {oldBeadId, oldTitle: old.title};

  // ---- c, d. every open request and unanswered question ----
  const work = predecessorWork({
    env,
    oldBeadId,
    oldDb: old.db,
    readTree,
    sessionId: oldSession.id,
  });
  if (work.kind === 'failed') return failed('read-predecessor', work.reason);
  const known = readSessionSightings(sessionId, env);
  if (known.kind === 'failed') {
    return failed(
      'read-successor',
      `the sessions index is unreadable: ${known.path}: ${known.error}`,
    );
  }
  const knownDirs = new Set(
    known.kind === 'read' ? known.sightings.map((entry) => entry.beadsDir) : [],
  );
  const mySid = sidLabel(sessionId);
  const carrying = {env, knownDirs, now, sessionId};
  const requests = carryAll({
    ...carrying,
    isHeld: (issue) =>
      issue.labels.includes(REQUEST_LABEL) && issue.labels.includes(mySid),
    issues: work.requests,
    write: (issue, db) => {
      const adopted = adoptBead({
        db,
        env,
        id: issue.id,
        sessionId,
        status: issue.status,
        update,
      });
      return adopted.kind === 'failed' ? adopted.reason : null;
    },
  });
  const questions = carryAll({
    ...carrying,
    isHeld: (issue) => issue.labels.includes(mySid),
    issues: work.questions,
    write: (issue, db) => {
      const labelled = update({db, env}, issue.id, {addLabels: [mySid]});
      return labelled.kind === 'failed'
        ? `br update failed: ${describeBrFailed(labelled)}`
        : null;
    },
  });
  progress.carried = {
    questions: questions.carried,
    requests: requests.carried,
  };
  progress.alreadyHeld = {
    questions: questions.alreadyHeld,
    requests: requests.alreadyHeld,
  };
  wrote ||= requests.wroteSighting || questions.wroteSighting;
  const carriedAny =
    requests.carried.length > 0 || questions.carried.length > 0;
  wrote ||= carriedAny;

  // ---- e. the title and the names ----
  let titleFailure: string | null = null;
  const autoTitled = myLabels.includes(AUTO_TITLE_LABEL);
  if (autoTitled && !old.labels.includes(AUTO_TITLE_LABEL)) {
    const stamp = await titleSetEdit({
      cwd,
      env,
      labels: myLabels,
      now: input.now,
    });
    const renamed = update({db: newDb, env}, newBeadId, {
      addLabels: stamp.addLabels,
      removeLabels: [AUTO_TITLE_LABEL, ...stamp.removeLabels],
      title: old.title,
    });
    if (renamed.kind === 'failed') {
      titleFailure = `the session bead ${newBeadId} was NOT titled after ${oldBeadId}: ${describeBrFailed(renamed)}`;
    } else {
      progress.renamedSession = {beadId: newBeadId, title: old.title};
      wrote = true;
    }
  }
  if (!autoTitled || progress.renamedSession != null) {
    progress.workspaceNote = await syncNames({cwd, env, sessionId});
  }

  // ---- what stops `picked-up`: c or d did not all hold ----
  if (work.problems.length > 0) {
    return failed(
      'read-predecessor',
      `not everything of ${oldBeadId} could be read, so requests or questions may be missing here: ${work.problems.join('; ')}`,
    );
  }
  if (requests.failures.length > 0) {
    return failed(
      'adopt-requests',
      [...requests.failures, ...questions.failures].join('; '),
    );
  }
  if (questions.failures.length > 0) {
    return failed('carry-questions', questions.failures.join('; '));
  }

  // ---- f. the record ----
  const recorded = recordPickup({
    carriedAny,
    env,
    labelled: myLabels.includes(PICKED_UP_LABEL),
    line: recordLine(
      newBeadId,
      requests.carried.length + requests.alreadyHeld.length,
      questions.carried.length + questions.alreadyHeld.length,
    ),
    newBeadId,
    newDb,
    now,
    oldBeadId,
    oldDb: old.db,
    update,
  });
  if (recorded.kind === 'failed') return failed('record', recorded.reason);
  wrote ||= recorded.wrote;
  progress.pickedUpLabelled = true;

  if (titleFailure != null) return failed('title', titleFailure);
  return {
    alreadyHeld: progress.alreadyHeld,
    carried: progress.carried,
    kind: 'picked-up',
    newBeadId,
    oldBeadId,
    oldTitle: old.title,
    renamedSession: progress.renamedSession,
    workspaceNote: progress.workspaceNote,
    wrote,
  };
}

// ---------------------------------------------------------------------------
// Words: `thread request --continues` prints these
// ---------------------------------------------------------------------------

function itemLines(items: PickedItems): string[] {
  return [
    ...items.requests.map((item) => `  request ${item.id} · ${item.title}`),
    ...items.questions.map((item) => `  question ${item.id} · ${item.title}`),
  ].flatMap((line) => ['', line]);
}

function itemCount(items: PickedItems): string {
  return `${counted(items.requests.length, 'request', 'requests')}, ${counted(items.questions.length, 'question', 'questions')}`;
}

function hasItems(items: PickedItems): boolean {
  return items.requests.length > 0 || items.questions.length > 0;
}

/** What moved and what was already here, for a person. */
export function carriedLines(
  outcome:
    | {alreadyHeld: PickedItems; carried: PickedItems}
    | Extract<PickUpOutcome, {kind: 'failed'} | {kind: 'not-a-successor'}>,
): string[] {
  if ('kind' in outcome && outcome.kind === 'not-a-successor') return [];
  const done = 'done' in outcome ? outcome.done : outcome;
  const lines: string[] = [];
  if (hasItems(done.carried)) {
    lines.push(
      '',
      `Carried over to this session (${itemCount(done.carried)}):`,
      ...itemLines(done.carried),
    );
  }
  if (hasItems(done.alreadyHeld)) {
    lines.push(
      '',
      `Already here (${itemCount(done.alreadyHeld)}):`,
      ...itemLines(done.alreadyHeld),
    );
  }
  return lines;
}

/**
 * The lines `--continues` prints. Exit 0 done or nothing to do, 1 a step failed,
 * 2 not-a-successor.
 */
export function describePickUp(
  outcome: PickUpOutcome,
  retryCommand: string,
): {exitCode: 0 | 1 | 2; lines: string[]} {
  switch (outcome.kind) {
    case 'picked-up': {
      const {newBeadId, oldBeadId, oldTitle} = outcome;
      const lines = outcome.wrote
        ? [
            `session ${newBeadId} continues ${oldBeadId} ("${oldTitle}")`,
            `  labels: ${CONTINUES_LABEL_PREFIX}${oldBeadId} here, ${CONTINUED_BY_LABEL_PREFIX}${newBeadId} there`,
          ]
        : [
            `Nothing to do: session ${newBeadId} has already picked up ${oldBeadId} ("${oldTitle}"). Nothing was written.`,
          ];
      lines.push(...carriedLines(outcome));
      if (
        outcome.wrote &&
        !hasItems(outcome.carried) &&
        !hasItems(outcome.alreadyHeld)
      ) {
        lines.push('', `${oldBeadId} had no open requests or questions.`);
      }
      if (outcome.renamedSession != null) {
        lines.push(
          '',
          `session ${outcome.renamedSession.beadId} titled after it: "${outcome.renamedSession.title}"`,
        );
      }
      if (outcome.workspaceNote != null) {
        lines.push(`  ${outcome.workspaceNote}`);
      }
      return {exitCode: 0, lines};
    }
    case 'not-a-successor':
      return {
        exitCode: 2,
        lines: [
          `thread request: this session is not the successor of ${outcome.oldBeadId}: ${outcome.reason}.`,
          `  No link was made and nothing was carried over. ${outcome.recordedNow ? `This session is now labelled ${NOT_A_SUCCESSOR_LABEL}, which is final.` : 'Nothing more was written.'}`,
        ],
      };
    case 'failed': {
      const {done} = outcome;
      const lines = [
        `thread request: the handoff pickup stopped at step "${outcome.step}": ${outcome.reason}`,
      ];
      if (done.link != null) {
        lines.push(
          '',
          `The two sessions are linked: this one continues ${done.link.oldBeadId} ("${done.link.oldTitle}").`,
        );
      }
      lines.push(...carriedLines(done));
      if (done.renamedSession != null) {
        lines.push(
          '',
          `session ${done.renamedSession.beadId} titled after it: "${done.renamedSession.title}"`,
        );
      }
      if (done.workspaceNote != null) {
        lines.push(`  ${done.workspaceNote}`);
      }
      lines.push(
        '',
        `Nothing done so far is lost. Running the same command again finishes it: ${retryCommand}`,
      );
      return {exitCode: 1, lines};
    }
  }
}
