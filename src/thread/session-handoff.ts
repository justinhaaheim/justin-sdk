/**
 * `thread handoff` and the continuation links (status report v4; built by
 * home-base-vzwbj.4.4 design item 2).
 *
 *   thread handoff [--note "<what the next session must know>"] [--to <uuid>]
 *       labels the session bead `handed-off` (epic D2 step 3: the session then
 *       derives 🤝 handed off), appends `- <stamp>: handed off — <note>` to its
 *       notes, and prints a HANDOFF BLOCK to paste into the new session: the
 *       title, every request with its status and stage, the open questions,
 *       the resume command, and the one command the new session runs first.
 *       With --to, when the successor already has a session bead, the two are
 *       linked at once (`continued-by:` here, `continues:` there).
 *
 *   thread request --continues <old session bead id>   (request.ts)
 *       run IN the new session: the whole pickup (handoff-pickup.ts). Its link
 *       labels its session bead `continues:<old>` and the old one
 *       `continued-by:<new>` — `linkContinuation` below.
 *
 * WHERE THE OLD BEAD IS: the sessions index names the DB that holds every
 * session bead (`created` sightings), so a predecessor in another checkout is
 * found without guessing; a bead the index does not know is looked up in the
 * new session's DB, then the current directory's. A lookup that FAILS stops
 * the link (a "not here" guess could label the wrong bead) — rule 7.
 */

import type {ChainNamer} from './chain-names';
import type {StepBead, StepRead} from './chain-step';
import type {ChainReaders} from './handoff-chain';
import type {EnvLike} from './paths';
import type {FoundSession} from './session-select';
import type {RequestNode} from './session-tree';

import {join} from 'node:path';

import {
  brShow,
  brUpdate,
  describeBrFailed,
  findBeadsWorkspace,
  resolveRecordedBeadsDb,
  saysBeadsLocked,
} from '../beads/br';
import {markdownItems} from '../cli-style';
import {sdkRun} from '../sdk-invocation';
import {oneLine} from './ask-format';
import {renderAsks} from './ask-render';
import {
  chainNameLabel,
  chainNameOfLabels,
  chainNameText,
  sameChainName,
} from './chain-name';
import {
  chainNamesKnob,
  readChainNames,
  registryChainNamer,
} from './chain-names';
import {backLinkOf, successorsOf} from './chain-step';
import {handoffDeferralMessage} from './handoff-gate';
import {walkedSessionMarks} from './handoff-marks';
import {
  chainRootOf,
  continuationLabels,
  continuationRoleLabels,
  type HandoffNumber,
  handoffNumberOf,
  mayorSuccessorSentence,
} from './handoff-number';
import {
  blockGetsReadMessagesLine,
  readMessagesLine,
} from './handoff-read-messages';
import {readMessageLog} from './message-log';
import {absoluteWhen, statusWords, tildeText} from './part-one';
import {notFoundButUnresolved} from './session-answer';
import {
  AUTO_TITLE_LABEL,
  CHAIN_NAME_LABEL_PREFIX,
  CONDUCTOR_ROLE_LABEL,
  CONTINUED_BY_LABEL_PREFIX,
  CONTINUES_LABEL_PREFIX,
  HANDED_OFF_LABEL,
  HANDOFF_NUMBER_LABEL_PREFIX,
  MAYOR_ROLE_LABEL,
  PICKUP_EXPECTED_LABEL,
} from './session-bead';
import {readSessionIndex, readSessionSightings} from './session-index';
import {appendNote} from './session-marks';
import {loadSession} from './session-model';
import {
  NO_MARKS,
  sessionDisplayName,
  stampedHandoffNumber,
} from './session-name';
import {selectSession, sessionBeadsKnob} from './session-select';
import {
  deriveStatus,
  isOpen,
  type LiveActivity,
  liveActivityOf,
  openQuestions,
  stageReached,
  statusFactsOf,
} from './session-status';

// ---------------------------------------------------------------------------
// Finding a session bead's DB
// ---------------------------------------------------------------------------

export type BeadLocation =
  | {
      /** br's created_at (home-base-1vcgs D1, D3); null when br gave none. */
      createdAt?: null | string;
      db: string;
      /** The id br show printed (home-base-9ihcl.4: focus reads it from here). */
      id: string;
      kind: 'found';
      labels: readonly string[];
      /** br show's notes, so a caller needs no second br show for them. */
      notes: string | null;
      title: string;
    }
  | {kind: 'failed'; reason: string}
  | {kind: 'notFound'; searched: string[]};

/** The DB holding session bead `beadId`: the index first, then `fallbackDbs`. */
export function locateSessionBead(
  beadId: string,
  env: EnvLike,
  fallbackDbs: readonly string[],
  /** Fallback DBs that could not be resolved, each with why (F3). */
  unresolvedFallbacks: readonly string[] = [],
): BeadLocation {
  const index = readSessionIndex(env);
  if (index.kind === 'failed') {
    return {
      kind: 'failed',
      reason: `the sessions index is unreadable: ${index.path}: ${index.error}`,
    };
  }
  const dbs: string[] = [];
  // home-base-dj5m9.1.6 F3: a DB that could not be resolved may hold the bead,
  // so "not found" is said only when every DB was searched.
  const unresolved: string[] = [...unresolvedFallbacks];
  if (index.kind === 'read') {
    for (const session of index.sessions) {
      for (const sighting of session.sightings) {
        if (sighting.event !== 'created' || sighting.beadId !== beadId)
          continue;
        const found = resolveRecordedBeadsDb(sighting.beadsDir);
        if (found.kind === 'found') dbs.push(found.db);
        if (found.kind === 'failed') {
          unresolved.push(`${sighting.beadsDir}: ${found.reason}`);
        }
      }
    }
  }
  for (const db of fallbackDbs) if (!dbs.includes(db)) dbs.push(db);
  for (const db of dbs) {
    const shown = brShow({db, env}, beadId);
    if (shown.kind === 'failed') {
      return {
        kind: 'failed',
        reason: `could not look up ${beadId} in ${db}: ${describeBrFailed(shown)}`,
      };
    }
    if (shown.kind === 'ok') {
      return {
        createdAt: shown.issue.createdAt,
        db,
        id: shown.issue.id,
        kind: 'found',
        labels: shown.issue.labels,
        notes: shown.issue.notes,
        title: shown.issue.title,
      };
    }
  }
  if (unresolved.length > 0) {
    return notFoundButUnresolved(beadId, dbs, unresolved);
  }
  return {kind: 'notFound', searched: dbs};
}

/**
 * home-base-1vcgs.1 F2: a session bead with its creation time, for
 * withNewestSuccessor (session-status.ts). Called only for a bead that names
 * two or more successors.
 */
export function realSuccessorBeadReader(input: {
  env: EnvLike;
  fallbackDbs: readonly string[];
}): (beadId: string) => StepRead<StepBead> {
  return (beadId) => {
    const located = locateSessionBead(beadId, input.env, input.fallbackDbs);
    if (located.kind === 'failed') {
      return {kind: 'failed', reason: located.reason};
    }
    if (located.kind === 'notFound') {
      return {
        kind: 'notFound',
        reason: `not found in ${located.searched.length > 0 ? located.searched.join(' or ') : 'any beads DB'}`,
      };
    }
    return {
      bead: {
        createdAt: located.createdAt ?? null,
        id: beadId,
        labels: located.labels,
      },
      kind: 'found',
    };
  };
}

// ---------------------------------------------------------------------------
// The handoff number (home-base-6n7my.2): the real readers and the self-heal
// ---------------------------------------------------------------------------

/** What handoffNumberOf reads for real: beads through locateSessionBead. */
export function realHandoffNumberReaders(input: {
  env: EnvLike;
  fallbackDbs: readonly string[];
}): ChainReaders {
  const {env, fallbackDbs} = input;
  return {
    readLog: (sessionId) => readMessageLog(sessionId, env),
    showBead: (beadId) => {
      const located = locateSessionBead(beadId, env, fallbackDbs);
      if (located.kind === 'failed') {
        return {kind: 'failed', reason: located.reason};
      }
      if (located.kind === 'notFound') {
        return {
          kind: 'notFound',
          reason: `not found in ${located.searched.length > 0 ? located.searched.join(' or ') : 'any beads DB'}`,
        };
      }
      return {kind: 'found', labels: located.labels, title: located.title};
    },
  };
}

export type HandoffNumberHeal =
  /** Nothing to do: no `continues:`, or it holds a number label already. */
  | {kind: 'current'}
  /** D3 could not establish it, so nothing was written and the name shows `[#?]`. */
  | {detail: string; kind: 'unknown'}
  | {detail: string; kind: 'failed'}
  /** `labels` are the bead's as they are now, for the name syncs that follow. */
  | {detail: string; kind: 'stamped'; labels: string[]; number: number};

/**
 * home-base-1vcgs D4: the number the new successor counts on from, the highest
 * of the predecessor's and of every successor the predecessor already names
 * (other than the new one), so a replacement successor never shows the same
 * [Name-N] as the one before it. Any number that cannot be read is unknown, so
 * the new bead gets no number label and shows [#?] (rule 7). The link
 * (linkContinuation) and the heal (F3, below) both count from it.
 */
export function highestNumberBefore(input: {
  newBeadId: string;
  old: {id: string; labels: readonly string[]};
  readers: ChainReaders;
}): HandoffNumber {
  const {old, readers} = input;
  let highest = handoffNumberOf(old, readers);
  for (const other of successorsOf(old.labels)) {
    if (highest.kind === 'unknown') return highest;
    if (other === input.newBeadId) continue;
    const read = readers.showBead(other);
    if (read.kind !== 'found') {
      return {
        kind: 'unknown',
        reason: `${old.id} is already continued by ${other}, which could not be read: ${read.reason}`,
      };
    }
    const theirs = handoffNumberOf({id: other, labels: read.labels}, readers);
    if (theirs.kind === 'unknown') return theirs;
    if (theirs.number > highest.number) {
      highest = {kind: 'known', number: theirs.number};
    }
  }
  return highest;
}

/**
 * home-base-1vcgs.1 F3: the number the heal stamps, by the link's own rule
 * (highestNumberBefore, home-base-1vcgs D4): 1 + the highest number among the
 * predecessor and every other successor it names. A replacement successor
 * healed later so never takes its predecessor's first successor's number. A
 * bead with no `continues:`, or two, keeps D3's walk, which says so. Never
 * throws, as handoffNumberOf does not: a reader that throws is unknown.
 */
function healedNumberOf(
  bead: {id: string; labels: readonly string[]},
  readers: ChainReaders,
): HandoffNumber {
  const back = backLinkOf(bead.labels);
  if (back.kind !== 'one') return handoffNumberOf(bead, readers);
  try {
    const predecessor = readers.showBead(back.id);
    if (predecessor.kind !== 'found') {
      return {
        kind: 'unknown',
        reason: `${bead.id} continues ${back.id}, which could not be read: ${predecessor.reason}`,
      };
    }
    const before = highestNumberBefore({
      newBeadId: bead.id,
      old: {id: back.id, labels: predecessor.labels},
      readers,
    });
    return before.kind === 'known'
      ? {kind: 'known', number: before.number + 1}
      : before;
  } catch (error) {
    return {
      kind: 'unknown',
      reason: `reading the chain threw: ${String(error)}`,
    };
  }
}

/**
 * D5, the self-heal: a session bead that continues another and has no number
 * label gets one when D3 can establish it. It reaches a session linked before
 * the label existed, on its next prompt. Never throws: the capture child calls
 * this, and a failure here must never stop a capture.
 */
export function healHandoffNumber(input: {
  beadId: string;
  /** Null when the caller does not know which DB holds the bead. */
  db: null | string;
  env: EnvLike;
  labels: readonly string[];
  readers?: ChainReaders;
}): HandoffNumberHeal {
  const {beadId, db, env, labels} = input;
  try {
    if (
      stampedHandoffNumber(labels).kind !== 'none' ||
      !labels.some((label) => label.startsWith(CONTINUES_LABEL_PREFIX))
    ) {
      return {kind: 'current'};
    }
    if (db == null) {
      return {
        detail: 'the beads DB of the session bead is not known',
        kind: 'failed',
      };
    }
    const number = healedNumberOf(
      {id: beadId, labels},
      input.readers ?? realHandoffNumberReaders({env, fallbackDbs: [db]}),
    );
    if (number.kind === 'unknown') {
      return {detail: number.reason, kind: 'unknown'};
    }
    const label = `${HANDOFF_NUMBER_LABEL_PREFIX}${number.number}`;
    const written = brUpdate({db, env}, beadId, {addLabels: [label]});
    if (written.kind === 'failed') {
      return {
        detail: `br update failed: ${describeBrFailed(written)}`,
        kind: 'failed',
      };
    }
    return {
      detail: `${beadId} labelled ${label}`,
      kind: 'stamped',
      labels: [...labels, label],
      number: number.number,
    };
  } catch (error) {
    return {detail: `threw: ${String(error)}`, kind: 'failed'};
  }
}

// ---------------------------------------------------------------------------
// The chain name (home-base-l2ejg.11): the capture's self-heal
// ---------------------------------------------------------------------------

export type ChainNameHeal =
  /** componentConfig.thread.chainNames is off: nothing read, nothing written. */
  | {kind: 'off'}
  /** The bead holds its chain's name already. */
  | {kind: 'current'}
  /** The chain's first session could not be found, so nothing was written. */
  | {detail: string; kind: 'unknown'}
  | {detail: string; kind: 'failed'}
  /** `labels` are the bead's as they are now, for the name syncs that follow. */
  | {detail: string; kind: 'named'; labels: string[]; name: string};

/**
 * D5 of home-base-l2ejg.3: the current session's bead gets its chain's name
 * when it has none. The name is the registry's for the chain's first session
 * (chainRootOf), handed out there when the chain has none yet, then written as
 * the bead's `chain:` label in one br write that also drops any other `chain:`
 * label. Most sessions need nothing: a first session names itself once, and a
 * successor is handed its predecessor's label by the link (continuationLabels).
 *
 * Re-resolved, as for no label: two different `chain:` labels (a session named
 * as its own chain before it linked, then given its predecessor's by the
 * link), and a successor whose one label the registry gave to the session
 * itself as a root (the same, where the predecessor had no name to pass on).
 *
 * Never throws: the capture child calls this on every prompt, and a failure
 * here must never stop a capture. It leaves the session unnamed and says why.
 */
export function healChainName(input: {
  beadId: string;
  /** Null when the caller does not know which DB holds the bead. */
  db: null | string;
  /** componentConfig.thread.chainNames. */
  enabled: boolean;
  env: EnvLike;
  labels: readonly string[];
  /** Tests inject these; the real ones read the registry and br. */
  namer?: ChainNamer;
  readers?: Pick<ChainReaders, 'showBead'>;
}): ChainNameHeal {
  const {beadId, db, env, labels} = input;
  if (!input.enabled) return {kind: 'off'};
  try {
    const held = chainNameOfLabels(labels);
    const continues = labels.some((label) =>
      label.startsWith(CONTINUES_LABEL_PREFIX),
    );
    if (held.kind === 'one') {
      if (!continues) return {kind: 'current'};
      // A successor's one name is right unless the registry gave it to this
      // very bead as a chain's first session. A registry that cannot be read
      // cannot say so, and the label stays.
      const read = readChainNames(env);
      const ownRoot =
        read.kind === 'read' &&
        read.entries.some(
          (entry) =>
            entry.root === beadId && sameChainName(entry.name, held.name),
        );
      if (!ownRoot) return {kind: 'current'};
    }
    if (db == null) {
      return {
        detail: 'the beads DB of the session bead is not known',
        kind: 'failed',
      };
    }
    const root = continues
      ? chainRootOf(
          {id: beadId, labels},
          input.readers ?? realHandoffNumberReaders({env, fallbackDbs: [db]}),
        )
      : ({kind: 'known', root: beadId} as const);
    if (root.kind === 'unknown') {
      return {detail: root.reason, kind: 'unknown'};
    }
    const named = (input.namer ?? registryChainNamer(env)).nameFor(root.root);
    if (named.kind === 'failed') {
      return {detail: named.reason, kind: 'failed'};
    }
    const label = chainNameLabel(named.name);
    const others = labels.filter(
      (other) => other.startsWith(CHAIN_NAME_LABEL_PREFIX) && other !== label,
    );
    if (labels.includes(label) && others.length === 0) return {kind: 'current'};
    const written = brUpdate({db, env}, beadId, {
      addLabels: labels.includes(label) ? [] : [label],
      ...(others.length > 0 ? {removeLabels: others} : {}),
    });
    if (written.kind === 'failed') {
      return {
        detail: `br update failed: ${describeBrFailed(written)}`,
        kind: 'failed',
      };
    }
    return {
      detail: `${beadId} labelled ${label} (chain root ${root.root}, ${named.kind} in the registry)${others.length > 0 ? `; removed ${others.join(', ')}` : ''}`,
      kind: 'named',
      labels: [
        ...labels.filter((other) => !others.includes(other)),
        ...(labels.includes(label) ? [] : [label]),
      ],
      name: chainNameText(named.name),
    };
  } catch (error) {
    return {detail: `threw: ${String(error)}`, kind: 'failed'};
  }
}

// ---------------------------------------------------------------------------
// The link
// ---------------------------------------------------------------------------

export type LinkOutcome =
  | {
      kind: 'linked';
      newBeadId: string;
      oldBeadId: string;
      oldTitle: string;
      /**
       * home-base-mbnjv.12: the old bead still carries `auto-title` (its
       * title is its first message), so a successor is not titled after it.
       */
      oldTitleIsAuto: boolean;
    }
  | {kind: 'failed'; reason: string};

/**
 * Label the NEW session bead `continues:<old>` and the old one
 * `continued-by:<new>`. Both writes are attempted; a failure names which
 * label is missing, so nothing is half-linked silently.
 *
 * This is the one place that writes `continues:` (home-base-6n7my.2 D4): the
 * pickup, so auto pickup and `thread request --continues`, and `thread handoff
 * --to` all reach it. The handoff number and the mayor label go in that same
 * write, through continuationLabels, and so does the conductor label
 * (home-base-eq5oy C3).
 *
 * C4: a conductor link must know whether the successor is already a mayor.
 * The pickup passes the labels it just read; any other caller has them read
 * here, and only for a conductor link. A read that fails leaves them unknown
 * (continuationRoleLabels says what that does).
 */
export function linkContinuation(input: {
  cwd: string;
  env: EnvLike;
  newSession: {
    beadId: string;
    db: string;
    /** The successor's labels, when the caller has just read them. */
    labels?: readonly string[];
  };
  /** Tests inject these; the real ones read through locateSessionBead. */
  numberReaders?: ChainReaders;
  oldBeadId: string;
}): LinkOutcome {
  const {cwd, env, newSession, oldBeadId} = input;
  if (oldBeadId === newSession.beadId) {
    return {kind: 'failed', reason: `${oldBeadId} is this session's own bead`};
  }
  const fallbacks = [newSession.db];
  const space = findBeadsWorkspace(cwd);
  if (space.kind === 'found') fallbacks.push(space.db);
  const old = locateSessionBead(
    oldBeadId,
    env,
    fallbacks,
    space.kind === 'failed' ? [`${cwd}: ${space.reason}`] : [],
  );
  if (old.kind === 'failed') return old;
  if (old.kind === 'notFound') {
    return {
      kind: 'failed',
      reason: `${oldBeadId} was not found in ${old.searched.length > 0 ? old.searched.join(' or ') : 'any beads DB'}`,
    };
  }
  const failures: string[] = [];
  const numberReaders =
    input.numberReaders ??
    realHandoffNumberReaders({env, fallbackDbs: fallbacks});
  const oldNumber = highestNumberBefore({
    newBeadId: newSession.beadId,
    old: {id: oldBeadId, labels: old.labels},
    readers: numberReaders,
  });
  const conductorLink =
    old.labels.includes(CONDUCTOR_ROLE_LABEL) &&
    !old.labels.includes(MAYOR_ROLE_LABEL);
  let newLabels: null | readonly string[] = newSession.labels ?? null;
  if (newLabels == null && conductorLink) {
    const shown = brShow({db: newSession.db, env}, newSession.beadId);
    if (shown.kind === 'ok') newLabels = shown.issue.labels;
  }
  const roleRemovals = continuationRoleLabels(old.labels, newLabels).remove;
  const mine = brUpdate({db: newSession.db, env}, newSession.beadId, {
    addLabels: continuationLabels({
      newLabels,
      oldBeadId,
      oldLabels: old.labels,
      oldNumber,
    }),
    ...(roleRemovals.length > 0 ? {removeLabels: roleRemovals} : {}),
  });
  if (mine.kind === 'failed') {
    failures.push(
      `${newSession.beadId} was NOT labelled ${CONTINUES_LABEL_PREFIX}${oldBeadId}: ${describeBrFailed(mine)}`,
    );
  }
  const theirs = brUpdate({db: old.db, env}, oldBeadId, {
    addLabels: [`${CONTINUED_BY_LABEL_PREFIX}${newSession.beadId}`],
  });
  if (theirs.kind === 'failed') {
    failures.push(
      `${oldBeadId} was NOT labelled ${CONTINUED_BY_LABEL_PREFIX}${newSession.beadId}: ${describeBrFailed(theirs)}`,
    );
  }
  if (failures.length > 0) return {kind: 'failed', reason: failures.join('; ')};
  return {
    kind: 'linked',
    newBeadId: newSession.beadId,
    oldBeadId,
    oldTitle: old.title,
    oldTitleIsAuto: old.labels.includes(AUTO_TITLE_LABEL),
  };
}

// ---------------------------------------------------------------------------
// home-base-1vcgs D2: a successor this session already names
// ---------------------------------------------------------------------------

/** One successor's activity as D2 reads it; tests inject this. */
export type SuccessorActivityReader = (
  successorBeadId: string,
) => Promise<
  | {activity: LiveActivity; kind: 'read'; sessionId: string}
  | {kind: 'failed'; reason: string}
>;

/** The real reader: the successor's session model, through the inbox's facts. */
export function realSuccessorActivity(input: {
  cwd: string;
  env: EnvLike;
  now: Date;
}): SuccessorActivityReader {
  return async (successorBeadId) => {
    const loaded = await loadSession({
      cwd: input.cwd,
      env: input.env,
      selector: successorBeadId,
      sessionIdOption: null,
    });
    if (loaded.kind !== 'loaded') {
      return {
        kind: 'failed',
        reason: loaded.kind === 'unreadable' ? loaded.detail : loaded.reason,
      };
    }
    return {
      activity: liveActivityOf(statusFactsOf(loaded.model), input.now),
      kind: 'read',
      sessionId: loaded.model.sessionId,
    };
  };
}

export type NamedSuccessorsCheck =
  /** Every successor named is stopped; `earlier` lists them, oldest label first. */
  | {earlier: string[]; kind: 'clear'}
  /** One is working now, or its state could not be read: refuse, write nothing. */
  | {kind: 'refuse'; reason: string};

/**
 * D2: before `thread handoff` writes anything, read every successor this
 * session already names (`continued-by:`). One that is working now, or whose
 * state cannot be read, refuses the handoff: opening another successor then
 * makes two sessions work on one chain. Stopped, done, handed off and out of
 * context all pass, and the caller says the new successor becomes the newest.
 */
export async function checkNamedSuccessors(input: {
  beadId: string;
  labels: readonly string[];
  read: SuccessorActivityReader;
}): Promise<NamedSuccessorsCheck> {
  const named = successorsOf(input.labels);
  for (const successor of named) {
    const read = await input.read(successor);
    if (read.kind === 'failed') {
      return {
        kind: 'refuse',
        reason: `${successor} continues this session, and whether it is working now could not be read (${read.reason}). Nothing was written and no tab was opened. Look at it first: ${sdkRun(`thread show ${successor}`)}`,
      };
    }
    if (read.activity.kind === 'working') {
      return {
        kind: 'refuse',
        reason: `${successor} continues this session and is working now; continue there (claude --resume ${read.sessionId}), or wait until it stops. Nothing was written and no tab was opened.`,
      };
    }
    if (read.activity.kind === 'unknown') {
      return {
        kind: 'refuse',
        reason: `${successor} continues this session, and whether it is working now could not be read: ${read.activity.reasons.join('; ')}. Nothing was written and no tab was opened. Continue there (claude --resume ${read.sessionId}), or run this again once it has stopped.`,
      };
    }
  }
  return {earlier: named, kind: 'clear'};
}

/** D2's one line when the session was already continued; null when it was not. */
export function earlierSuccessorsLine(
  beadId: string,
  earlier: readonly string[],
): null | string {
  if (earlier.length === 0) return null;
  return `${beadId} was already continued by ${earlier.join(' and ')}, which ${earlier.length === 1 ? 'has' : 'have'} stopped; the new successor becomes the newest.`;
}

// ---------------------------------------------------------------------------
// thread handoff
// ---------------------------------------------------------------------------

export interface ThreadHandoffOptions {
  /**
   * home-base-1vcgs D2: false when the caller already ran checkNamedSuccessors
   * (handoffWithSuccessor runs it before the gate). Absent: checked here.
   */
  checkSuccessors?: boolean;
  cwd?: string;
  env?: EnvLike;
  note: string | null;
  now?: Date;
  /** D2's reader; tests inject it. Absent: realSuccessorActivity. */
  readSuccessorActivity?: SuccessorActivityReader;
  /** `--session`, else CLAUDE_CODE_SESSION_ID. */
  sessionId: string | null;
  timeZone?: string;
  /** `--to`: the successor's Claude session id. */
  to: string | null;
}

/**
 * The session's requests as the handoff block counted them, for the short
 * handoff summary (home-base-9ihcl.6). `partial` is a floor, not a count: some
 * beads could not be read. `unknown` is never zero (rule 7).
 */
export type HandoffRequestCount =
  | {kind: 'counted'; open: number; total: number}
  | {kind: 'partial'; open: number; reason: string; total: number}
  | {kind: 'unknown'; reason: string};

export type HandoffOutcome =
  | {
      block: string;
      /** D2: the stopped successors this session already named; [] when none. */
      earlierSuccessors?: string[];
      /** Problems after the label was set; non-empty means exit 1. */
      followUpFailures: string[];
      kind: 'handedOff';
      /** Open and total requests, read with the block (home-base-9ihcl.6). */
      requests: HandoffRequestCount;
      /** What happened to --to: linked, waiting for the successor, or not asked. */
      successor:
        | {beadId: string; kind: 'linked'}
        | {kind: 'none'}
        | {kind: 'noBeadYet'; sessionId: string};
    }
  | {kind: 'failed'; reason: string}
  /** D2: refused before anything was written (exit 2). */
  | {kind: 'refused'; reason: string};

/** The successor's session bead id from the index, or null when it has none yet. */
function successorBead(
  sessionId: string,
  env: EnvLike,
):
  | {beadId: string; db: string; kind: 'found'}
  | {kind: 'failed'; reason: string}
  | {kind: 'none'} {
  const read = readSessionSightings(sessionId, env);
  if (read.kind === 'failed') {
    return {
      kind: 'failed',
      reason: `the sessions index is unreadable: ${read.path}: ${read.error}`,
    };
  }
  const created =
    read.kind === 'read'
      ? read.sightings.find((sighting) => sighting.event === 'created')
      : undefined;
  if (created == null) return {kind: 'none'};
  const found = resolveRecordedBeadsDb(created.beadsDir);
  if (found.kind !== 'found') {
    return {
      kind: 'failed',
      reason: `the successor's beads at ${created.beadsDir} cannot be read: ${found.reason}`,
    };
  }
  return {beadId: created.beadId, db: found.db, kind: 'found'};
}

/** Part 1's rules for its request count (part-one.ts), as a type. */
function requestCountOf(model: {
  beads: {problems: readonly string[]; requests: readonly RequestNode[]};
  exportBehind?: unknown;
}): HandoffRequestCount {
  if (model.exportBehind != null) {
    return {kind: 'unknown', reason: 'the bead export is behind'};
  }
  const {problems, requests} = model.beads;
  const total = requests.length;
  const open = requests.filter((node) => isOpen(node.request)).length;
  if (problems.length === 0) return {kind: 'counted', open, total};
  const reason = `some beads could not be read: ${problems.join('; ')}`;
  return total === 0
    ? {kind: 'unknown', reason}
    : {kind: 'partial', open, reason, total};
}

/**
 * home-base-z7o2m D7: the block's section of Justin's typed messages from the
 * session handing off. A log that cannot be read is said in the section,
 * never an empty list (rule 7).
 */
async function pickupSection(input: {
  env: EnvLike;
  labels: readonly string[];
  sessionId: string;
}): Promise<string> {
  const {classifySessionLog, pickupMessagesSection} = await import(
    './justin-messages'
  );
  const contextCommand = sdkRun('thread messages --context <id>');
  const log = readMessageLog(input.sessionId, input.env);
  if (log.kind !== 'read') {
    return pickupMessagesSection({
      contextCommand,
      messages: [],
      problem:
        log.kind === 'missing'
          ? `this session has no message log at ${log.path}`
          : `${log.path}: ${log.error}`,
    });
  }
  const classified = classifySessionLog({
    labels: input.labels,
    lines: log.lines,
    sessionId: input.sessionId,
  });
  return pickupMessagesSection({
    contextCommand,
    messages: classified.messages,
    problem:
      log.failures.length > 0
        ? `${log.failures.join('; ')}, and any of them could be one of his`
        : null,
  });
}

/** The block to paste into the new session (markdown: it is for pasting). */
export async function handoffBlock(input: {
  cwd: string;
  env: EnvLike;
  note: string | null;
  now: Date;
  /**
   * home-base-z7o2m D7: add Justin's typed messages from this session.
   * Absent: componentConfig.thread.handoff.pickupMessages (default false).
   */
  pickupMessages?: boolean;
  /**
   * home-base-6ujwi D6: a mayor's block tells its successor to read his last
   * 3 sessions' words. Absent: componentConfig.thread.handoff.readMessages
   * (default false).
   */
  readMessages?: boolean;
  sessionBeadId: string;
  sessionId: string;
  timeZone?: string;
}): Promise<
  | {ok: false; reason: string}
  | {ok: true; requests: HandoffRequestCount; text: string}
> {
  const configured =
    input.pickupMessages == null || input.readMessages == null
      ? (await import('./config')).resolveThreadConfig({
          cwd: input.cwd,
          env: input.env,
        }).handoff
      : null;
  const pickupMessages =
    input.pickupMessages ?? configured?.pickupMessages ?? false;
  const readMessages = input.readMessages ?? configured?.readMessages ?? false;
  const loaded = await loadSession({
    cwd: input.cwd,
    env: input.env,
    selector: null,
    sessionIdOption: input.sessionId,
  });
  if (loaded.kind !== 'loaded') {
    return {
      ok: false,
      reason: `the handoff block could not be built: ${loaded.kind === 'unreadable' ? loaded.detail : loaded.reason}`,
    };
  }
  const {model} = loaded;
  const status = deriveStatus(statusFactsOf(model), {
    asIfYielded: true,
    now: input.now,
  });
  const title = model.beads.session?.title ?? '(title unknown)';
  // home-base-idnon: the marks, the number walked when no label holds it.
  const bead = model.beads.session;
  const marks =
    bead == null
      ? NO_MARKS
      : walkedSessionMarks(
          bead,
          realHandoffNumberReaders({
            env: input.env,
            fallbackDbs: [join(bead.beadsDir, 'beads.db')],
          }),
          // home-base-l2ejg.11: the chain's name, as Part 1 shows it.
          chainNamesKnob(input.cwd, input.env)
            ? {
                chainNames: true,
                namer: registryChainNamer(input.env, {assign: false}),
              }
            : {},
        );
  const fields = [
    `- **Session:** ${sessionDisplayName(model.repoTag, title, marks)} (${input.sessionBeadId})`,
    `- **Status:** ${statusWords(status)}`,
    `- **Handed off:** ${absoluteWhen(input.now, input.timeZone)}`,
    ...(input.note == null ? [] : [`- **Note:** ${input.note}`]),
  ].join('\n');

  const requests = model.beads.requests.map((node, index) => {
    const marker = `${index + 1}. `;
    const stage = stageReached(node.request.labels, model.stages);
    const open = node.children.filter(isOpen).length;
    const lines = [
      `${marker}${isOpen(node.request) ? '🔲' : '✅'} ${node.request.title} (${node.request.id})`,
    ];
    lines.push(
      `${' '.repeat(marker.length)}**Stage:** ${stage == null ? 'none marked' : stage.next == null ? `${stage.reached} (the last stage)` : `${stage.reached} — next: ${stage.next}`}`,
    );
    if (node.children.length > 0) {
      lines.push(
        `${' '.repeat(marker.length)}**Children:** ${open} of ${node.children.length} still open`,
      );
    }
    return lines.join('\n\n');
  });
  const problems = model.beads.problems.map(
    (problem) => `⚠️ ${problem} — requests and questions there are not shown.`,
  );
  const questions = openQuestions(model);
  // home-base-6n7my.2 D8: for a session started by hand from this block.
  const mayorLine = mayorSuccessorSentence(model.beads.session?.labels ?? []);
  // home-base-6ujwi D6, home-base-eq5oy C2: off, or neither a mayor nor a
  // conductor, nothing is added.
  const readLine = blockGetsReadMessagesLine(
    readMessages,
    model.beads.session?.labels ?? [],
  )
    ? readMessagesLine(input.sessionBeadId)
    : null;
  // home-base-z7o2m D7: off, nothing is added, so the block is as before.
  const messagesSection = pickupMessages
    ? await pickupSection({
        env: input.env,
        labels: model.beads.session?.labels ?? [],
        sessionId: input.sessionId,
      })
    : null;
  const blocks = [
    // As a message: a `!` command does not run the capture hook, so the new
    // session would have no bead to link (home-base-nro7d.1).
    '🤝 **HANDOFF** — paste this into the new session as a message, not as a `!` command',
    fields,
    ...problems,
    // Two empty lines between sibling requests and questions: Claude pastes
    // this, and Claude Code drops one (home-base-j8q3e.1.10 F7).
    requests.length === 0
      ? '**Requests:** none filed'
      : ['**Requests:**', markdownItems(requests)].join('\n\n'),
    questions.length === 0
      ? '**Open questions:** none'
      : [
          '**Open questions:**',
          renderAsks(questions, {
            itemGap: 2,
            style: {color: false, width: null},
          }),
        ].join('\n\n'),
    ...(messagesSection == null ? [] : [messagesSection]),
    [
      '**To pick it up:**',
      // Justin's wording (2026-10-26): addressed to the Claude reading it.
      `- Run \`${sdkRun(`thread request --continues ${input.sessionBeadId}`)}\` to receive the handoff from a previous session.`,
      ...(mayorLine == null ? [] : [`- ${mayorLine}`]),
      ...(readLine == null ? [] : [`- ${readLine}`]),
      // P6 (home-base-npbse.1.1): a session once took the note as the whole
      // scope and adopted 2 of its 10 open requests.
      '- Every open request and question above carries over to the new session. The note is the order to take them in, not the whole scope.',
      `- To read the old session: \`claude --resume ${input.sessionId}\` or \`${sdkRun(`thread show ${input.sessionBeadId}`)}\``,
    ].join('\n'),
  ];
  return {
    ok: true,
    requests: requestCountOf(model),
    text: tildeText(blocks.join('\n\n')),
  };
}

export async function handOff(
  options: ThreadHandoffOptions,
): Promise<HandoffOutcome> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? new Date();
  const knob = await sessionBeadsKnob(cwd, env);
  if (!knob.ok) return {kind: 'failed', reason: knob.reason};
  const selection = selectSession({
    env,
    selector: null,
    sessionIdOption: options.sessionId,
  });
  if (selection.kind === 'checkoutMissing') {
    return {
      kind: 'failed',
      reason: `this session's beads live in ${selection.checkoutPath}, which no longer exists (or no longer holds a beads database)`,
    };
  }
  if (selection.kind !== 'found') {
    return {kind: 'failed', reason: selection.reason};
  }
  const {session} = selection as {session: FoundSession};
  const note =
    options.note == null || oneLine(options.note) === ''
      ? null
      : oneLine(options.note);

  // ---- home-base-1vcgs D2: a successor already named, read first ----
  let earlierSuccessors: string[] = [];
  if (options.checkSuccessors !== false) {
    const checked = await checkNamedSuccessors({
      beadId: session.bead.id,
      labels: session.bead.labels,
      read:
        options.readSuccessorActivity ?? realSuccessorActivity({cwd, env, now}),
    });
    if (checked.kind === 'refuse') {
      return {kind: 'refused', reason: checked.reason};
    }
    earlierSuccessors = checked.earlier;
  }

  // ---- the label and the note: one write ----
  // home-base-npbse.1.2 item 5: what the inbox's "not picked up" waits on.
  const {resolveThreadConfig} = await import('./config');
  const {autoPickup} = resolveThreadConfig({
    cwd: session.checkoutPath ?? undefined,
    env,
  }).handoff;
  const written = brUpdate({db: session.db, env}, session.bead.id, {
    addLabels: [
      HANDED_OFF_LABEL,
      ...(autoPickup ? [PICKUP_EXPECTED_LABEL] : []),
    ],
    notes: appendNote(
      session.bead.notes,
      note == null ? 'handed off' : `handed off — ${note}`,
      now,
    ),
  });
  if (written.kind === 'failed') {
    return {
      kind: 'failed',
      reason: `the session was NOT marked handed off: ${describeBrFailed(written)}`,
    };
  }

  // ---- --to: link now when the successor already has a bead ----
  const followUpFailures: string[] = [];
  let successor: Extract<HandoffOutcome, {kind: 'handedOff'}>['successor'] = {
    kind: 'none',
  };
  if (options.to != null && options.to.trim() !== '') {
    const next = successorBead(options.to.trim(), env);
    if (next.kind === 'failed') {
      followUpFailures.push(next.reason);
    } else if (next.kind === 'none') {
      successor = {kind: 'noBeadYet', sessionId: options.to.trim()};
    } else {
      const linked = linkContinuation({
        cwd,
        env,
        newSession: {beadId: next.beadId, db: next.db},
        oldBeadId: session.bead.id,
      });
      if (linked.kind === 'failed') followUpFailures.push(linked.reason);
      else successor = {beadId: next.beadId, kind: 'linked'};
    }
  }

  // ---- the block, from the session model read AFTER the label ----
  const block = await handoffBlock({
    cwd,
    env,
    note,
    now,
    sessionBeadId: session.bead.id,
    sessionId: session.sessionId,
    timeZone: options.timeZone,
  });
  if (!block.ok) followUpFailures.push(block.reason);
  return {
    block: block.ok ? block.text : '',
    earlierSuccessors,
    followUpFailures,
    kind: 'handedOff',
    requests: block.ok
      ? block.requests
      : {kind: 'unknown', reason: block.reason},
    successor,
  };
}

export function describeHandoffOutcome(outcome: HandoffOutcome): {
  exitCode: 0 | 1 | 2 | 4;
  lines: string[];
} {
  if (outcome.kind === 'refused') {
    return {exitCode: 2, lines: [`thread handoff: refused: ${outcome.reason}`]};
  }
  if (outcome.kind === 'failed') {
    return saysBeadsLocked(outcome.reason)
      ? {
          exitCode: 4,
          lines: [handoffDeferralMessage('beadsLocked', outcome.reason)],
        }
      : {exitCode: 1, lines: [`thread handoff: ${outcome.reason}`]};
  }
  const lines: string[] = [];
  if (outcome.block !== '') lines.push(outcome.block, '');
  const earlier = earlierSuccessorsLine(
    'This session',
    outcome.earlierSuccessors ?? [],
  );
  if (earlier != null) lines.push(earlier);
  switch (outcome.successor.kind) {
    case 'linked':
      lines.push(
        `Linked: the successor's session bead is ${outcome.successor.beadId}.`,
      );
      break;
    case 'noBeadYet':
      lines.push(
        `The successor ${outcome.successor.sessionId} has no session bead yet: it links itself when it runs the first command above.`,
      );
      break;
    case 'none':
      break;
  }
  if (outcome.followUpFailures.length > 0) {
    lines.push(
      '⚠️ The session WAS marked handed off. But:',
      ...outcome.followUpFailures.map((failure) => `  - ${failure}`),
    );
    const locked = outcome.followUpFailures.find((failure) =>
      saysBeadsLocked(failure),
    );
    if (locked != null) {
      lines.push('', handoffDeferralMessage('beadsLocked', locked));
      return {exitCode: 4, lines};
    }
    return {exitCode: 1, lines};
  }
  return {exitCode: 0, lines};
}

// The CLI reaches handOff() through handoff-successor.ts's
// runThreadHandoffCommand (home-base-mbnjv.2), which, with
// componentConfig.thread.handoff.successor off, prints
// describeHandoffOutcome(await handOff(options)) exactly as this file's
// runThreadHandoff did.
