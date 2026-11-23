/**
 * The two steps every handoff-chain reader takes (home-base-lasun L4, fix
 * round home-base-lasun.1 F1): one step back through `continues:`, one step
 * forward through `continued-by:` or, when a bead has none, the reverse
 * search for a bead that carries `continues:<it>` (a half-written link).
 *
 * walkChain (chain-walk.ts) is built from these two steps, and so are
 * readHandoffChain (handoff-view.ts, thread show), thread focus's forward
 * walk (focus.ts), walkChainBack (handoff-number.ts: chainRootOf and
 * handoffNumberOf) and walkUnattendedChain (handoff-chain.ts, the handoff
 * gate). Each reader keeps its own words, its own refusal codes and its own
 * limit convention; what a link is, and the order in which a step checks for
 * a fork, a loop and the limit before it reads, are decided here only.
 * resolveQuotaGroup (quota-group.ts) is not a chain reader: it follows spawn
 * links too.
 *
 * WHY A FILE OF ITS OWN. chain-walk.ts imports handoff-view.ts,
 * handoff-chain.ts and session-handoff.ts (which imports handoff-number.ts),
 * and each of those now takes its steps from here. Putting the steps in
 * chain-walk.ts would make four import cycles; this file imports only the
 * label prefixes.
 *
 * THE ORDER OF ONE STEP. Back: no `continues:` is the root; two are a fork;
 * then a loop; then the limit; then the read. Forward: one `continued-by:` is
 * followed; two or more are each read, and the newest by creation is followed
 * (below); none asks the reverse search, where a failed search, two beads, or
 * none (the newest) end the step; then a loop; then the limit; then the read.
 *
 * TWO OR MORE SUCCESSORS (home-base-1vcgs D3). A session resumed after its
 * successor S1 stopped, then handed off again, names S1 and S2. The newest
 * successor is the one whose session bead was created last, and every chain
 * reader takes it from here. Any successor that cannot be read, a creation
 * time that is missing or unreadable, or two equal times keep the fork
 * (`twoSuccessors`, with `why`): rule 7, a guess is never the newest.
 *
 * THE LIMIT. `limit` is the most beads a walk takes in one direction, the
 * start not counted, and `taken` how many it has taken so far. A reader that
 * counts the start in its own limit (thread focus, walkUnattendedChain)
 * passes its limit minus 1.
 *
 * CRITICAL RULE 7. A read that fails or finds nothing, a failed reverse
 * search and every ambiguity is its own outcome, never the end of a chain.
 * The one exception is explicit: a reader with no reverse search
 * (`findContinuing: null`) gets `end` with `searched: false`, never a
 * measured none.
 */

import type {ChainLinkState} from './handoff-view';

import {
  CONTINUED_BY_LABEL_PREFIX,
  CONTINUES_LABEL_PREFIX,
} from './session-bead';

/** What a step needs of a bead; a reader's own bead type carries more. */
export interface StepBead {
  /**
   * When the bead was created (br's `created_at`), for D3's newest successor.
   * Absent or null when the reader cannot say: two successors then stay a fork.
   */
  createdAt?: null | string;
  id: string;
  labels: readonly string[];
}

/** One read of a bead, as every chain reader's own reader returns it. */
export type StepRead<B> =
  | {bead: B; kind: 'found'}
  | {kind: 'failed'; reason: string}
  | {kind: 'notFound'; reason: string};

/** The beads whose `continues:` names a bead: the reverse link search. */
export type ContinuingLookup =
  | {ids: string[]; kind: 'read'}
  | {kind: 'failed'; reason: string};

/** Where a walk is in one direction. */
export interface StepState {
  /** The most beads to take in this direction, the start not counted. */
  limit: number;
  /** Every bead the walk has read, the start included. A step adds the bead it takes. */
  seen: Set<string>;
  /** How many beads this direction has taken so far, the start not counted. */
  taken: number;
}

function labelsWith(labels: readonly string[], prefix: string): string[] {
  return labels
    .filter((label) => label.startsWith(prefix))
    .map((label) => label.slice(prefix.length));
}

// ---------------------------------------------------------------------------
// Back, through continues:
// ---------------------------------------------------------------------------

/** What a bead's own labels say about its predecessor. */
export type BackLink =
  | {id: string; kind: 'one'}
  | {ids: string[]; kind: 'twoPredecessors'}
  | {kind: 'root'};

/**
 * The first half of the back step, from the labels alone. walkUnattendedChain
 * asks it before it reads a log, so a fork is found before attendance.
 */
export function backLinkOf(labels: readonly string[]): BackLink {
  const predecessors = labelsWith(labels, CONTINUES_LABEL_PREFIX);
  const [only] = predecessors;
  if (only == null) return {kind: 'root'};
  if (predecessors.length > 1) {
    return {ids: predecessors, kind: 'twoPredecessors'};
  }
  return {id: only, kind: 'one'};
}

export type BackStep<B> =
  /** The predecessor, read; `link` says whether it names `current` back. */
  | {bead: B; id: string; kind: 'next'; link: 'complete' | 'onlyContinues'}
  /** `current` carries no `continues:`: it is the chain's first session. */
  | {kind: 'root'}
  /** The predecessor was seen already. */
  | {id: string; kind: 'loop'}
  /** The walk has taken `limit` beads; `id` is the predecessor it did not read. */
  | {id: string; kind: 'tooLong'}
  | {ids: string[]; kind: 'twoPredecessors'}
  | {
      id: string;
      kind: 'unreadable';
      read: Exclude<StepRead<B>, {kind: 'found'}>;
    };

/** One step back from `current`. On `next`, the predecessor is added to `seen`. */
export function stepBack<B extends StepBead>(
  current: StepBead,
  state: StepState,
  readBead: (beadId: string) => StepRead<B>,
): BackStep<B> {
  const link = backLinkOf(current.labels);
  if (link.kind !== 'one') return link;
  const {id} = link;
  if (state.seen.has(id)) return {id, kind: 'loop'};
  if (state.taken >= state.limit) return {id, kind: 'tooLong'};
  const read = readBead(id);
  if (read.kind !== 'found') return {id, kind: 'unreadable', read};
  state.seen.add(id);
  return {
    bead: read.bead,
    id,
    kind: 'next',
    link: labelsWith(read.bead.labels, CONTINUED_BY_LABEL_PREFIX).includes(
      current.id,
    )
      ? 'complete'
      : 'onlyContinues',
  };
}

// ---------------------------------------------------------------------------
// Forward, through continued-by:, else the reverse search
// ---------------------------------------------------------------------------

/**
 * How the successor was found: `continuedBy` from `current`'s own
 * `continued-by:` label, `continues` from the reverse search (the successor
 * carries `continues:<current>` and `current` names no successor).
 */
export type ForwardVia = 'continuedBy' | 'continues';

export type ForwardStep<B> =
  /** No successor. `searched` is false only for a reader with no reverse search. */
  | {kind: 'end'; searched: boolean}
  | {
      bead: B;
      id: string;
      kind: 'next';
      link: ChainLinkState;
      via: ForwardVia;
    }
  | {id: string; kind: 'loop'; via: ForwardVia}
  /** The reverse search could not answer. */
  | {kind: 'reverseFailed'; reason: string}
  /** The walk has taken `limit` beads; `id` is the successor it did not read. */
  | {id: string; kind: 'tooLong'; via: ForwardVia}
  /** Two or more beads carry `continues:<current>`. */
  | {ids: string[]; kind: 'twoContinuing'}
  /**
   * `current` names two or more `continued-by:` successors and the newest
   * cannot be established (D3); `why` says which read or time failed.
   */
  | {ids: string[]; kind: 'twoSuccessors'; why: string}
  | {
      id: string;
      kind: 'unreadable';
      read: Exclude<StepRead<B>, {kind: 'found'}>;
      via: ForwardVia;
    };

/** The successor `current`'s own labels name, before any read. */
export function successorsOf(labels: readonly string[]): string[] {
  return labelsWith(labels, CONTINUED_BY_LABEL_PREFIX);
}

/** D3: the newest of several successors, or why it cannot be established. */
export type NewestSuccessor<B> =
  | {bead: B; id: string; kind: 'newest'}
  | {kind: 'unknown'; why: string};

/**
 * D3, the one resolver: read every successor `ids` names and take the one
 * created last. Every successor must be read and carry a readable creation
 * time, and the newest time must be strictly the newest; otherwise unknown.
 */
export function newestSuccessor<B extends StepBead>(
  ids: readonly string[],
  readBead: (beadId: string) => StepRead<B>,
): NewestSuccessor<B> {
  let newest: {at: number; bead: B; id: string} | null = null;
  let tie = false;
  for (const id of ids) {
    const read = readBead(id);
    if (read.kind !== 'found') {
      return {kind: 'unknown', why: `${id} could not be read: ${read.reason}`};
    }
    const {createdAt} = read.bead;
    const at = createdAt == null ? Number.NaN : Date.parse(createdAt);
    if (Number.isNaN(at)) {
      return {
        kind: 'unknown',
        why: `${id} carries no readable creation time (${createdAt ?? 'none'})`,
      };
    }
    if (newest == null || at > newest.at) {
      newest = {at, bead: read.bead, id};
      tie = false;
    } else if (at === newest.at) {
      tie = true;
    }
  }
  if (newest == null) return {kind: 'unknown', why: 'no successor was named'};
  if (tie) {
    return {
      kind: 'unknown',
      why: `two of them were created at the same moment (${new Date(newest.at).toISOString()})`,
    };
  }
  return {bead: newest.bead, id: newest.id, kind: 'newest'};
}

/**
 * One step forward from `current`. `findContinuing` is the reverse search;
 * null only for a reader that has none (thread show's tests, overarching.ts),
 * which then gets `end` with `searched: false`. On `next`, the successor is
 * added to `seen`.
 */
export function stepForward<B extends StepBead, C extends StepBead>(
  current: C,
  state: StepState,
  readers: {
    findContinuing: ((current: C) => ContinuingLookup) | null;
    readBead: (beadId: string) => StepRead<B>;
  },
): ForwardStep<B> {
  const successors = successorsOf(current.labels);
  let id: string;
  let via: ForwardVia;
  const [named] = successors;
  if (successors.length > 1) {
    // D3: the newest by creation. Its read is reused below only for its id;
    // the loop and limit checks and the read that follows are as for one.
    const newest = newestSuccessor(successors, readers.readBead);
    if (newest.kind === 'unknown') {
      return {ids: successors, kind: 'twoSuccessors', why: newest.why};
    }
    id = newest.id;
    via = 'continuedBy';
  } else if (named != null) {
    id = named;
    via = 'continuedBy';
  } else {
    if (readers.findContinuing == null) return {kind: 'end', searched: false};
    const found = readers.findContinuing(current);
    if (found.kind === 'failed') {
      return {kind: 'reverseFailed', reason: found.reason};
    }
    const others = found.ids.filter((other) => other !== current.id);
    const [only] = others;
    if (others.length > 1) return {ids: others, kind: 'twoContinuing'};
    if (only == null) return {kind: 'end', searched: true};
    id = only;
    via = 'continues';
  }
  if (state.seen.has(id)) return {id, kind: 'loop', via};
  if (state.taken >= state.limit) return {id, kind: 'tooLong', via};
  const read = readers.readBead(id);
  if (read.kind !== 'found') return {id, kind: 'unreadable', read, via};
  state.seen.add(id);
  let link: ChainLinkState = 'onlyContinues';
  if (via === 'continuedBy') {
    link = labelsWith(read.bead.labels, CONTINUES_LABEL_PREFIX).includes(
      current.id,
    )
      ? 'complete'
      : 'onlyContinued';
  }
  return {bead: read.bead, id, kind: 'next', link, via};
}
