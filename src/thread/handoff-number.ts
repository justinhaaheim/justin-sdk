/**
 * Which handoff in its chain a session is (home-base-6n7my.2 D3, D4, D8). The
 * tool works the number out from labels and the chain, and nothing takes it as
 * an argument: asking Claude for it is the failure Justin named.
 *
 * THE NUMBER RULE (D3), for one session bead:
 *
 * - It has a `handoff-number:` label: that number.
 * - It has no `continues:`: 0, a first session. The exception is a session that
 *   began on a handoff kickoff and never linked (F12 in handoff-chain.ts), which
 *   is unknown. A first session's log is read to tell the two apart, so a log
 *   that cannot be read is unknown too.
 * - It has one `continues:`: the predecessor's number plus 1.
 *
 * Two predecessors, a loop, a bead that cannot be read or a walk past the limit
 * is unknown. It never reads as a first session (critical rules, section 7).
 *
 * The walk goes back through `continues:` only. A problem further forward, such
 * as two `continued-by:` labels, says nothing about this number. So this does
 * not use readHandoffChain, whose forward walk adds to `problems`, nor
 * walkUnattendedChain, which stops at the newest attended session.
 *
 * The real readers and the self-heal (D5) are in session-handoff.ts, next to
 * linkContinuation, which this file must not import.
 */

import type {ChainReaders} from './handoff-chain';
import type {SessionMarks} from './session-name';

import {KICKOFF_OPENING} from './respawn';
import {
  CONTINUES_LABEL_PREFIX,
  HANDOFF_NUMBER_LABEL_PREFIX,
  MAYOR_ROLE_LABEL,
  SID_LABEL_PREFIX,
} from './session-bead';
import {stampedHandoffNumber} from './session-name';

export type HandoffNumber =
  | {kind: 'known'; number: number}
  | {kind: 'unknown'; reason: string};

/** The same size as CHAIN_WALK_LIMIT, which handoff-chain.ts owns. */
const NUMBER_WALK_LIMIT = 50;

function labelsWith(labels: readonly string[], prefix: string): string[] {
  return labels
    .filter((label) => label.startsWith(prefix))
    .map((label) => label.slice(prefix.length));
}

function unknown(reason: string): HandoffNumber {
  return {kind: 'unknown', reason};
}

/** A bead with no `continues:`: first, unless it began on a kickoff (F12). */
function firstSessionNumber(
  bead: {id: string; labels: readonly string[]},
  readers: ChainReaders,
): HandoffNumber {
  const sids = labelsWith(bead.labels, SID_LABEL_PREFIX);
  const [sessionId] = sids;
  if (sessionId == null || sids.length > 1) {
    return unknown(
      `${bead.id} has ${sids.length} ${SID_LABEL_PREFIX} labels, so which message log is its own is unknown`,
    );
  }
  const log = readers.readLog(sessionId);
  if (log.kind === 'missing') {
    return unknown(`the message log of ${bead.id} does not exist: ${log.path}`);
  }
  if (log.kind === 'failed') {
    return unknown(
      `the message log of ${bead.id} could not be read: ${log.path}: ${log.error}`,
    );
  }
  const first = log.lines.find((line) => line.role === 'user');
  if (first?.text.trim().startsWith(KICKOFF_OPENING) === true) {
    return unknown(
      `${bead.id} has no ${CONTINUES_LABEL_PREFIX} label but began on a handoff kickoff, so where its chain starts is unknown`,
    );
  }
  // A malformed line could be the first prompt, and that could be the kickoff.
  if (log.failures.length > 0) {
    return unknown(
      `the message log of ${bead.id} has unreadable lines, so how it began is unknown: ${log.failures[0] ?? ''}`,
    );
  }
  if (first == null) {
    return unknown(`the message log of ${bead.id} holds no user line`);
  }
  return {kind: 'known', number: 0};
}

function walkBack(
  start: {id: string; labels: readonly string[]},
  readers: ChainReaders,
  limit: number,
): HandoffNumber {
  const seen = new Set<string>();
  let current = start;
  for (let steps = 0; ; steps += 1) {
    seen.add(current.id);
    const stamped = stampedHandoffNumber(current.labels);
    if (stamped.kind === 'number') {
      return {kind: 'known', number: stamped.number + steps};
    }
    if (stamped.kind === 'unreadable') {
      return unknown(`${current.id}: ${stamped.reason}`);
    }
    const predecessors = labelsWith(current.labels, CONTINUES_LABEL_PREFIX);
    const [predecessor] = predecessors;
    if (predecessor == null) {
      const first = firstSessionNumber(current, readers);
      return first.kind === 'known'
        ? {kind: 'known', number: first.number + steps}
        : first;
    }
    if (predecessors.length > 1) {
      return unknown(
        `${current.id} names ${predecessors.length} predecessors (${predecessors.join(', ')})`,
      );
    }
    if (seen.has(predecessor)) {
      return unknown(`the chain loops back to ${predecessor}`);
    }
    if (steps >= limit) {
      return unknown(
        `the chain is longer than ${limit} sessions; the walk stopped at ${current.id}`,
      );
    }
    const read = readers.showBead(predecessor);
    if (read.kind !== 'found') {
      return unknown(
        `${current.id} continues ${predecessor}, which could not be read: ${read.reason}`,
      );
    }
    current = {id: predecessor, labels: read.labels};
  }
}

/** D3. Never throws: a reader that throws is unknown, never a lost link. */
export function handoffNumberOf(
  start: {id: string; labels: readonly string[]},
  readers: ChainReaders,
  options: {limit?: number} = {},
): HandoffNumber {
  try {
    return walkBack(start, readers, options.limit ?? NUMBER_WALK_LIMIT);
  } catch (error) {
    return unknown(`reading the chain threw: ${String(error)}`);
  }
}

/**
 * D9: the marks of a session that continues this one: its number plus 1, `H?`
 * when its own number is unknown, and the mayor mark when it has one.
 */
export function successorMarks(
  predecessorLabels: readonly string[],
  predecessorNumber: HandoffNumber,
): SessionMarks {
  return {
    handoff:
      predecessorNumber.kind === 'known'
        ? predecessorNumber.number + 1
        : 'unknown',
    mayor: predecessorLabels.includes(MAYOR_ROLE_LABEL),
  };
}

/**
 * D4: every label a link puts on the new session bead, so they land in one br
 * write. No number label when the number is unknown, so the reader shows `H?`.
 * If the new bead already holds a different number, the two labels read as `H?`
 * rather than one being trusted.
 */
export function continuationLabels(input: {
  oldBeadId: string;
  oldLabels: readonly string[];
  oldNumber: HandoffNumber;
}): string[] {
  const {oldNumber} = input;
  return [
    `${CONTINUES_LABEL_PREFIX}${input.oldBeadId}`,
    ...(oldNumber.kind === 'known'
      ? [`${HANDOFF_NUMBER_LABEL_PREFIX}${oldNumber.number + 1}`]
      : []),
    ...(input.oldLabels.includes(MAYOR_ROLE_LABEL) ? [MAYOR_ROLE_LABEL] : []),
  ];
}

/**
 * D8: what a mayor session tells its successor, in the kickoff and in the
 * handoff block; null for any other session. It is a sentence and never `/mayor`:
 * the kickoff must keep starting with KICKOFF_OPENING, which
 * handoff-chain.ts and handoff-auto-pickup.ts detect.
 */
export function mayorSuccessorSentence(
  labels: readonly string[],
): null | string {
  return labels.includes(MAYOR_ROLE_LABEL)
    ? 'This session continues a mayor session, so load the mayor skill with the Skill tool.'
    : null;
}
