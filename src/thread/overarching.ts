/**
 * The OVERARCHING REQUEST of a session and the sessions it continues
 * (home-base-jm5kg.5 / .6; the design field there holds D1–D6). Justin, on
 * home-base-jm5kg.2: "adding a new request not only adds something to the
 * list of things we're doing -- it can sometimes reframe the entire thrust of
 * the work", and "have the command that files a request also accept
 * --overarching or something, and have that be the way cc defines/updates
 * the description of the overall work we're doing."
 *
 * D1 STORAGE. Two labels on the request bead, written in one `br update`:
 * `overarching` (the mark, so `br list --label overarching` finds it) and
 * `overarching-set:<ISO time to the second>Z` (when it was marked or last
 * retitled, rounded UP like `title-set:`, so a request filed in the same
 * second before it never reads as filed after it). One per handoff chain:
 * marking a request unmarks every other request of the chain. A successor
 * SHARES its predecessor's overarching request: nothing is copied; the chain
 * is walked (readChainRequests) whenever it is needed.
 *
 * D2. The session title IS the overarching request's title. It is written
 * through: marking (and `thread title` while one exists) sets the session
 * bead's title too, so every reader of the session title (inbox, Part 1, the
 * workspace name, tab titles, a successor's inherited title) follows without
 * knowing about this module.
 *
 * D5 (trial, componentConfig.thread.workspaceNameItems): the workspace name
 * lists the chain's other requests after the title, ✅ done then 🔳 open.
 *
 * Rule 7: a chain or an export that cannot be read is a `failed` read, never
 * "no overarching request" and never "no other requests".
 */

import type {EnvLike} from './paths';
import type {NameItem} from './session-name';
import type {ExportRead, SessionTree, TreeIssue} from './session-tree';

import {parseInstant} from './answer-store';
import {readHandoffChain, realChainViewReaders} from './handoff-view';
import {
  CONTINUED_BY_LABEL_PREFIX,
  CONTINUES_LABEL_PREFIX,
  labelValue,
  SID_LABEL_PREFIX,
} from './session-bead';
import {readSessionSightings} from './session-index';
import {readBeadsExport, readSessionTree} from './session-tree';

export const OVERARCHING_LABEL = 'overarching';
export const OVERARCHING_SET_LABEL_PREFIX = 'overarching-set:';

/** The `overarching-set:` label for a mark at `now` (rounded up to the second). */
export function overarchingSetLabel(now: Date): string {
  const ceiled = new Date(Math.ceil(now.getTime() / 1000) * 1000);
  return `${OVERARCHING_SET_LABEL_PREFIX}${ceiled.toISOString().replace(/\.\d{3}Z$/, 'Z')}`;
}

/**
 * The label edit that marks a request overarching at `now`: the mark, the new
 * time, and every older time removed. A label equal to the new one is never
 * in both lists.
 */
export function overarchingMarkEdit(
  labels: readonly string[],
  now: Date,
): {addLabels: string[]; removeLabels: string[]} {
  const stamp = overarchingSetLabel(now);
  return {
    addLabels: [OVERARCHING_LABEL, stamp],
    removeLabels: labels.filter(
      (label) =>
        label.startsWith(OVERARCHING_SET_LABEL_PREFIX) && label !== stamp,
    ),
  };
}

/** The label edit that unmarks a request (the mark and every time). */
export function overarchingUnmarkEdit(labels: readonly string[]): {
  removeLabels: string[];
} {
  return {
    removeLabels: labels.filter(
      (label) =>
        label === OVERARCHING_LABEL ||
        label.startsWith(OVERARCHING_SET_LABEL_PREFIX),
    ),
  };
}

/**
 * When the request was marked or retitled: epoch ms, `none` (marked by hand,
 * with no time), or `unreadable`. The newest wins when a failed edit left two.
 */
export function overarchingSetAt(
  labels: readonly string[],
):
  | {at: number; kind: 'set'}
  | {kind: 'none'}
  | {kind: 'unreadable'; label: string} {
  let newest: number | null = null;
  for (const label of labels) {
    if (!label.startsWith(OVERARCHING_SET_LABEL_PREFIX)) continue;
    const at = Date.parse(label.slice(OVERARCHING_SET_LABEL_PREFIX.length));
    if (Number.isNaN(at)) return {kind: 'unreadable', label};
    if (newest == null || at > newest) newest = at;
  }
  return newest == null ? {kind: 'none'} : {at: newest, kind: 'set'};
}

export function isOverarching(issue: {labels: readonly string[]}): boolean {
  return issue.labels.includes(OVERARCHING_LABEL);
}

// ---------------------------------------------------------------------------
// The chain's requests
// ---------------------------------------------------------------------------

/** A session bead as the chain walk needs it. */
export interface ChainBead {
  id: string;
  labels: readonly string[];
  title: string;
}

export type ChainBeadsRead =
  | {beads: ChainBead[]; kind: 'read'; selfIndex: number}
  | {kind: 'failed'; reason: string};

export type SessionRequestsRead =
  | {kind: 'failed'; reason: string}
  | {kind: 'read'; requests: TreeIssue[]};

export interface ChainRequestReaders {
  /** The chain through `start`, oldest first, each bead with its labels. */
  chainBeads: (start: ChainBead) => ChainBeadsRead;
  /** One session's requests, from its tree. */
  requestsOf: (bead: ChainBead) => SessionRequestsRead;
}

export interface ChainRequests {
  /** The index of the session the read started from. */
  selfIndex: number;
  /** Each session of the chain, oldest first, with its requests. */
  sessions: {bead: ChainBead; requests: TreeIssue[]}[];
}

export type ChainRequestsRead =
  | {kind: 'failed'; reason: string}
  | ({kind: 'read'} & ChainRequests);

/** True when a session bead carries either half of a handoff link. */
export function hasChainLink(labels: readonly string[]): boolean {
  return labels.some(
    (label) =>
      label.startsWith(CONTINUES_LABEL_PREFIX) ||
      label.startsWith(CONTINUED_BY_LABEL_PREFIX),
  );
}

/**
 * Every request of every session in the chain through `start`. Any session
 * whose requests cannot be read, or a chain walk that stopped early, fails
 * the whole read: a partial list would claim requests are absent.
 */
export function readChainRequests(
  start: ChainBead,
  readers: ChainRequestReaders,
): ChainRequestsRead {
  const chain = readers.chainBeads(start);
  if (chain.kind === 'failed') return chain;
  const sessions: ChainRequests['sessions'] = [];
  for (const bead of chain.beads) {
    const read = readers.requestsOf(bead);
    if (read.kind === 'failed') {
      return {
        kind: 'failed',
        reason: `the requests of session ${bead.id} could not be read: ${read.reason}`,
      };
    }
    sessions.push({bead, requests: read.requests});
  }
  return {kind: 'read', selfIndex: chain.selfIndex, sessions};
}

/** The requests of a session tree, or failed when an export was unreadable. */
export function requestsOfTree(tree: SessionTree): SessionRequestsRead {
  if (tree.problems.length > 0) {
    return {kind: 'failed', reason: tree.problems.join('; ')};
  }
  if (tree.session == null) {
    return {
      kind: 'failed',
      reason: tree.sessionMissing ?? 'the session bead was not found',
    };
  }
  return {kind: 'read', requests: tree.requests.map((node) => node.request)};
}

/**
 * The chain walk over `showBead` (handoff-view's readers), keeping every
 * bead's labels. A session with no handoff label is its own chain and costs
 * no read at all.
 */
export function chainBeadsVia(
  showBead: (
    beadId: string,
  ) =>
    | {bead: ChainBead; kind: 'found'}
    | {kind: 'failed'; reason: string}
    | {kind: 'notFound'; reason: string},
): (start: ChainBead) => ChainBeadsRead {
  return (start) => {
    if (!hasChainLink(start.labels)) {
      return {beads: [start], kind: 'read', selfIndex: 0};
    }
    const seen = new Map<string, ChainBead>([[start.id, start]]);
    const view = readHandoffChain(start.id, {
      showBead: (beadId) => {
        const known = seen.get(beadId);
        if (known != null) {
          return {bead: {...known, notes: null}, kind: 'found'};
        }
        const read = showBead(beadId);
        if (read.kind !== 'found') return read;
        seen.set(beadId, read.bead);
        return {bead: {...read.bead, notes: null}, kind: 'found'};
      },
    });
    if ('kind' in view) return view;
    if (view.problems.length > 0) {
      return {
        kind: 'failed',
        reason: `the handoff chain could not be read whole: ${view.problems.join('; ')}`,
      };
    }
    const beads: ChainBead[] = [];
    for (const node of view.nodes) {
      const bead = seen.get(node.beadId);
      if (bead == null) {
        return {kind: 'failed', reason: `${node.beadId} was not read`};
      }
      beads.push(bead);
    }
    return {beads, kind: 'read', selfIndex: view.selfIndex};
  };
}

/** Oldest first by created_at, then by id. */
export function byCreated(a: TreeIssue, b: TreeIssue): number {
  const at = parseInstant(a.createdAt);
  const bt = parseInstant(b.createdAt);
  if (at != null && bt != null && at !== bt) return at - bt;
  return a.id.localeCompare(b.id, 'en', {numeric: true});
}

/** Every request of the chain once (one id may sit in two DBs), oldest first. */
export function chainRequestList(chain: ChainRequests): TreeIssue[] {
  const byId = new Map<string, TreeIssue>();
  for (const session of chain.sessions) {
    for (const request of session.requests) {
      if (!byId.has(request.id)) byId.set(request.id, request);
    }
  }
  return [...byId.values()].sort(byCreated);
}

export interface OverarchingPick {
  /** Other requests still marked (an unmark that failed): newest wins. */
  duplicates: TreeIssue[];
  /** The marked request whose `overarching-set:` time is newest, or null. */
  overarching: TreeIssue | null;
}

/** D1: the chain's overarching request; the newest mark wins. */
export function pickOverarching(
  requests: readonly TreeIssue[],
): OverarchingPick {
  const marked = requests.filter(isOverarching);
  const timeOf = (issue: TreeIssue): number => {
    const set = overarchingSetAt(issue.labels);
    return set.kind === 'set' ? set.at : Number.NEGATIVE_INFINITY;
  };
  const sorted = [...marked].sort((a, b) => {
    const at = timeOf(a);
    const bt = timeOf(b);
    if (at !== bt) return bt > at ? 1 : -1;
    return byCreated(b, a);
  });
  const [overarching = null, ...duplicates] = sorted;
  return {duplicates, overarching};
}

// ---------------------------------------------------------------------------
// D5: the workspace name with its items (trial)
// ---------------------------------------------------------------------------

function isClosed(issue: {status: string}): boolean {
  return issue.status === 'closed' || issue.status === 'tombstone';
}

/** A request closed as not needed was never done: it is left out. */
function closedNotNeeded(issue: TreeIssue): boolean {
  return (
    issue.status === 'closed' &&
    (issue.closeReason ?? '').trim().toLowerCase().startsWith('not needed')
  );
}

/**
 * D5: the items after the title. Every request of the chain except the
 * overarching one, any whose title is the head title itself (the first
 * request names a session with none marked), and any closed "not needed";
 * done before open, oldest first within each.
 */
export function nameItemsOf(input: {
  headTitle: string;
  requests: readonly TreeIssue[];
}): NameItem[] {
  const {overarching} = pickOverarching(input.requests);
  const head = input.headTitle.trim();
  const listed = input.requests
    .filter(
      (request) =>
        request.id !== overarching?.id &&
        request.title.trim() !== head &&
        request.status !== 'tombstone' &&
        !closedNotNeeded(request),
    )
    .sort(byCreated);
  const done = listed.filter(isClosed);
  const open = listed.filter((request) => !isClosed(request));
  return [
    ...done.map((request) => ({done: true, title: request.title})),
    ...open.map((request) => ({done: false, title: request.title})),
  ];
}

// ---------------------------------------------------------------------------
// The real readers
// ---------------------------------------------------------------------------

/**
 * The chain through the sessions index and br (handoff-view's readers), and
 * each session's requests from the beads exports the index names for it, each
 * export read once per call. `known` short-cuts sessions whose requests the
 * caller already read (thread status passes its own model's).
 */
export function realChainRequestReaders(input: {
  cwd: string;
  env: EnvLike;
  known?: ReadonlyMap<string, readonly TreeIssue[]>;
}): ChainRequestReaders {
  const {env} = input;
  const viewReaders = realChainViewReaders({cwd: input.cwd, env});
  const exports = new Map<string, ExportRead>();
  const readExport = (dir: string): ExportRead => {
    const cached = exports.get(dir);
    if (cached != null) return cached;
    const read = readBeadsExport(dir);
    exports.set(dir, read);
    return read;
  };
  return {
    chainBeads: chainBeadsVia((beadId) => viewReaders.showBead(beadId)),
    requestsOf: (bead) => {
      const known = input.known?.get(bead.id);
      if (known != null) return {kind: 'read', requests: [...known]};
      const sessionId = labelValue(bead.labels, SID_LABEL_PREFIX);
      if (sessionId == null) {
        return {
          kind: 'failed',
          reason: `${bead.id} has no ${SID_LABEL_PREFIX} label, so its requests cannot be found`,
        };
      }
      const sightings = readSessionSightings(sessionId, env);
      if (sightings.kind === 'failed') {
        return {
          kind: 'failed',
          reason: `the sessions index is unreadable: ${sightings.path}: ${sightings.error}`,
        };
      }
      const dirs =
        sightings.kind === 'read'
          ? sightings.sightings.map((entry) => entry.beadsDir)
          : [];
      if (dirs.length === 0) {
        return {
          kind: 'failed',
          reason: `the sessions index names no beads DB for session ${sessionId}`,
        };
      }
      return requestsOfTree(
        readSessionTree({
          beadsDirs: dirs,
          readExport,
          sessionBeadId: bead.id,
          sessionId,
        }),
      );
    },
  };
}
