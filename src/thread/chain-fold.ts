/**
 * Handoff chains, folded (home-base-kwand.9, gap G5 of epic home-base-kwand).
 * Justin, 2026-11-17: "How can I see all the threads that are incomplete in
 * any way? ie that have incomplete requests?"
 *
 * ONE implementation of chain folding, used by `thread inbox --unfinished`
 * and by the threads dashboard (src/threads-dash/state.ts, every grouping's
 * fold and its "unfinished" grouping). The rules came from the dashboard
 * (home-base-9uzxw.3 D-NEEDS-YOU, home-base-9uzxw.5 F6) and did not change in
 * the move:
 *
 * - A link is read from either half: `linkContinuation` writes
 *   `continues:<old>` on the new bead and `continued-by:<new>` on the old one,
 *   and either write can fail (`chainIndex`).
 * - A session is FOLDED (hidden, its newest session stands for it) only when
 *   every successor its `continued-by:` labels name is listed; a successor
 *   nobody can see never hides its predecessor (`foldVerdict`).
 *
 * Every function takes the rows through a mapper, as reopen-order.ts does, so
 * the SDK's `InboxRow` and the dashboard's zod `Session` give the same answer.
 *
 * Unknown stays unknown (critical rules section 7): requests or questions
 * that could not be read are null, never an empty list, and a chain they
 * touch says so (`requestsUnknown`, `openQuestions: null`).
 */

import type {ReopenKey, ReopenSignals, ReopenTier} from './reopen-order';

import {compareReopen, reopenTier} from './reopen-order';
import {
  CONTINUED_BY_LABEL_PREFIX,
  CONTINUES_LABEL_PREFIX,
} from './session-bead';
import {isOpen} from './session-status';

/** What a row says about its place in a chain: its session bead and that bead's labels. */
export interface ChainLinks {
  /** The session bead; null for an untracked session (it is in no chain). */
  beadId: string | null;
  /** The session bead's labels; null when they were not loaded. */
  labels: readonly string[] | null;
}

function labelValues(
  labels: readonly string[] | null,
  prefix: string,
): string[] {
  return (labels ?? [])
    .filter((label) => label.startsWith(prefix))
    .map((label) => label.slice(prefix.length));
}

/** The successors a session bead names (`continued-by:`). */
export function handedOffToOf(labels: readonly string[] | null): string[] {
  return labelValues(labels, CONTINUED_BY_LABEL_PREFIX);
}

/** The beads a session bead says it continues (`continues:`). */
export function continuesOf(labels: readonly string[] | null): string[] {
  return labelValues(labels, CONTINUES_LABEL_PREFIX);
}

/** The rows by bead, and each bead's predecessors. */
export interface ChainIndex<T> {
  byBead: Map<string, T>;
  /** Bead → the beads it continues, from either half of each link. */
  predecessors: Map<string, Set<string>>;
}

export function chainIndex<T>(
  items: readonly T[],
  linksOf: (item: T) => ChainLinks,
): ChainIndex<T> {
  const byBead = new Map<string, T>();
  const predecessors = new Map<string, Set<string>>();
  const link = (newer: string, older: string): void => {
    const set = predecessors.get(newer) ?? new Set<string>();
    set.add(older);
    predecessors.set(newer, set);
  };
  for (const item of items) {
    const {beadId, labels} = linksOf(item);
    if (beadId == null) continue;
    byBead.set(beadId, item);
    for (const older of continuesOf(labels)) link(beadId, older);
    for (const newer of handedOffToOf(labels)) link(newer, beadId);
  }
  return {byBead, predecessors};
}

/** What the fold does with one row. */
export type FoldVerdict =
  /** Every successor it names is listed: hidden, the newest session stands for it. */
  | {into: string[]; kind: 'folded'}
  /** No `continued-by:` label: shown as it is. */
  | {kind: 'head'}
  /** A successor it names is not listed: shown, and the row says so. */
  | {kind: 'successorMissing'; missing: string[]};

/**
 * D-NEEDS-YOU: each link is judged on its own, so a → b → c with all three
 * listed shows only c, and a → b with b missing keeps a. With several
 * successors the row is folded only when every one is listed.
 */
export function foldVerdict(
  labels: readonly string[] | null,
  listed: ReadonlySet<string>,
): FoldVerdict {
  const successors = handedOffToOf(labels);
  if (successors.length === 0) return {kind: 'head'};
  const missing = successors.filter((bead) => !listed.has(bead));
  return missing.length === 0
    ? {into: successors, kind: 'folded'}
    : {kind: 'successorMissing', missing};
}

/** The sections of a session that is not an unfinished chain head. */
export const FINISHED_SECTIONS: ReadonlySet<string> = new Set([
  'archived',
  'done',
  'handedOff',
]);

/**
 * D3 of home-base-l2ejg.3 (the dashboard's rule, moved here unchanged): an
 * unfinished chain head. Its section is not done, archived or handed off, and
 * its bead carries no `continued-by:` label.
 */
export function isUnfinishedHeadOf(input: {
  labels: readonly string[] | null;
  section: string;
}): boolean {
  if (FINISHED_SECTIONS.has(input.section)) return false;
  return handedOffToOf(input.labels).length === 0;
}

/** One row of the fold, with the sessions folded into it. */
export interface ChainGroup<T> {
  /** The row the fold keeps: the chain's newest listed session. */
  head: T;
  /** The head first, then each session folded into it, nearest first. */
  members: T[];
  /** Beads the chain links to that are not listed (older than the window, say). */
  outside: string[];
}

/**
 * The fold's rows, each with the sessions it stands for. The groups are
 * exactly the rows `foldVerdict` keeps (every verdict but `folded`), in the
 * input order. A folded session joins the group whose head reaches it by
 * walking predecessors (either half of a link) through folded sessions only,
 * so a predecessor the fold keeps as a row of its own stays one. Each session
 * is in one group: the first head, in the input order, that reaches it.
 * `unplaced`: folded sessions no head reaches (a handoff loop), named so
 * nothing is dropped silently.
 */
export function chainGroups<T>(
  items: readonly T[],
  linksOf: (item: T) => ChainLinks,
): {groups: ChainGroup<T>[]; unplaced: T[]} {
  const index = chainIndex(items, linksOf);
  const listed = new Set(index.byBead.keys());
  const folded = (item: T): boolean =>
    foldVerdict(linksOf(item).labels, listed).kind === 'folded';
  const placed = new Set<T>();
  const groups: ChainGroup<T>[] = [];
  for (const head of items) {
    if (folded(head)) continue;
    placed.add(head);
    const members = [head];
    const outside: string[] = [];
    const start = linksOf(head).beadId;
    const seen = new Set<string>(start == null ? [] : [start]);
    const queue = [
      ...(start == null ? [] : (index.predecessors.get(start) ?? [])),
    ];
    for (let next = queue.shift(); next != null; next = queue.shift()) {
      if (seen.has(next)) continue;
      seen.add(next);
      const found = index.byBead.get(next);
      if (found == null) {
        outside.push(next);
        continue;
      }
      if (!folded(found) || placed.has(found)) continue;
      placed.add(found);
      members.push(found);
      queue.push(...(index.predecessors.get(next) ?? []));
    }
    groups.push({head, members, outside});
  }
  return {groups, unplaced: items.filter((item) => !placed.has(item))};
}

/** What the unfinished view reads of one session. */
export interface ChainSessionFacts extends ChainLinks {
  /** ISO; null when nothing dates it. */
  lastActivityAt: string | null;
  /** Its question beads, open and closed; null when they could not be read. */
  questions: readonly {id: string; status: string}[] | null;
  /** The kwand.6 signals of the session (`reopenSignals`). */
  reopen: ReopenSignals;
  /**
   * Its requests with their state (`closed`, `open`, `blocked`; id null when
   * the inbox printed none). Null when they could not be read; an untracked
   * session, which has no requests, is `[]`.
   */
  requests: readonly {id: string | null; state: string}[] | null;
  section: string;
}

/** One chain with an unfinished request, and its counts. */
export interface UnfinishedChain<T> extends ChainGroup<T> {
  counts: {
    /** Distinct open questions over the chain; null when a member's are unknown. */
    openQuestions: number | null;
    sessions: number;
    /** Distinct requests not closed over the chain (a carried request once). */
    unfinishedRequests: number;
  };
  /** The head's facts, which the order reads. */
  headFacts: ChainSessionFacts;
  /** Members whose requests could not be read (the count above is then a floor). */
  requestsUnknown: number;
}

/** The two orders of the unfinished view. */
export const UNFINISHED_SORTS = ['importance', 'activity'] as const;
export type UnfinishedSort = (typeof UNFINISHED_SORTS)[number];

export interface UnfinishedChains<T> {
  chains: UnfinishedChain<T>[];
  /** Totals over `chains`. */
  totals: {
    chains: number;
    /** Null when any listed chain's questions are unknown. */
    openQuestions: number | null;
    /** Listed chains with a member whose requests could not be read. */
    requestsUnknownChains: number;
    sessions: number;
    unfinishedRequests: number;
  };
  /** Folded sessions in no chain (a handoff loop): see chainGroups. */
  unplaced: T[];
}

/** The key `compareReopen` reads for a chain under `sort`. */
export function unfinishedSortKey(
  facts: ChainSessionFacts,
  sort: UnfinishedSort,
): ReopenKey {
  const tier: ReopenTier =
    sort === 'importance'
      ? reopenTier({...facts.reopen, lastActivityAt: facts.lastActivityAt})
      : 'recent';
  return {lastActivityAt: facts.lastActivityAt, tier};
}

/** `chains` in `sort`'s order (a copy). */
export function sortUnfinishedChains<T>(
  chains: readonly UnfinishedChain<T>[],
  sort: UnfinishedSort,
): UnfinishedChain<T>[] {
  return [...chains].sort((a, b) =>
    compareReopen(
      unfinishedSortKey(a.headFacts, sort),
      unfinishedSortKey(b.headFacts, sort),
    ),
  );
}

/**
 * G5: every chain with an unfinished request, one per chain, in `sort`'s
 * order. A chain is listed when its head is an unfinished head
 * (`isUnfinishedHeadOf`) and a member has a request that is not closed, or a
 * member's requests could not be read (listed, not hidden: rule 7). What
 * counts as unfinished is the existing request state; nothing new is measured.
 */
export function unfinishedChains<T>(
  items: readonly T[],
  factsOf: (item: T) => ChainSessionFacts,
  sort: UnfinishedSort,
): UnfinishedChains<T> {
  const {groups, unplaced} = chainGroups(items, factsOf);
  const chains = groups.flatMap((group): UnfinishedChain<T>[] => {
    const headFacts = factsOf(group.head);
    if (!isUnfinishedHeadOf(headFacts)) return [];
    const facts = group.members.map(factsOf);
    const open = new Set<string>();
    let unnamed = 0;
    let requestsUnknown = 0;
    for (const member of facts) {
      if (member.requests == null) {
        requestsUnknown += 1;
        continue;
      }
      for (const request of member.requests) {
        if (request.state === 'closed') continue;
        if (request.id == null) unnamed += 1;
        else open.add(request.id);
      }
    }
    const unfinishedRequests = open.size + unnamed;
    if (unfinishedRequests === 0 && requestsUnknown === 0) return [];
    const questions = new Set<string>();
    let questionsKnown = true;
    for (const member of facts) {
      if (member.questions == null) {
        questionsKnown = false;
        continue;
      }
      for (const question of member.questions) {
        if (isOpen(question)) questions.add(question.id);
      }
    }
    return [
      {
        ...group,
        counts: {
          openQuestions: questionsKnown ? questions.size : null,
          sessions: group.members.length,
          unfinishedRequests,
        },
        headFacts,
        requestsUnknown,
      },
    ];
  });
  const sorted = sortUnfinishedChains(chains, sort);
  const sum = (pick: (chain: UnfinishedChain<T>) => number): number =>
    sorted.reduce((total, chain) => total + pick(chain), 0);
  return {
    chains: sorted,
    totals: {
      chains: sorted.length,
      openQuestions: sorted.some((chain) => chain.counts.openQuestions == null)
        ? null
        : sum((chain) => chain.counts.openQuestions ?? 0),
      requestsUnknownChains: sorted.filter((chain) => chain.requestsUnknown > 0)
        .length,
      sessions: sum((chain) => chain.counts.sessions),
      unfinishedRequests: sum((chain) => chain.counts.unfinishedRequests),
    },
    unplaced,
  };
}
