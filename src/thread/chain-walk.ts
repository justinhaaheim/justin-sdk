/**
 * ONE walk of a handoff chain, from any member, both ways (home-base-z7o2m
 * D1). `thread messages` reads it; home-base-lasun moves the other chain
 * readers (thread show, focus, search grouping) onto it.
 *
 * WHAT A CHAIN IS. Handoff links only: a successor's session bead carries
 * `continues:<predecessor>` and the predecessor's `continued-by:<successor>`
 * (linkContinuation in session-handoff.ts writes both). `spawned-by:` /
 * `spawned:` links are NOT part of a chain (anti-decision: the quota group
 * follows them, a chain does not).
 *
 * THE WALK. Back from the start through `continues:` to the bead that has
 * none: the root. That is the same rule chainRootOf (handoff-number.ts)
 * follows, so the two name the same root and a chain name keyed by it cannot
 * split; a first session that began on a kickoff and never linked (F12) is
 * its own root here as there. Forward from the start through
 * `continued-by:`; a bead that has none is looked up the other way, as the
 * `continues:` target of some bead in any beads export the sessions index
 * names (a half-written link). Each step is chain-step.ts's stepBack or
 * stepForward, the same steps every other chain reader takes
 * (home-base-lasun.1 F1); this walk keeps only its own words.
 *
 * READS. Beads come from the beads exports (session-tree.ts readExportIndex,
 * memoized per file), not from two `br show` calls per bead: one parse per
 * export answers the whole chain. A bead no export holds (the export can lag
 * its database) is asked of br through locateSessionBead. The reverse search
 * reads the exports only, so a `continues:` label that is in a database and
 * not yet in its export is not found there: a known limit, and only for a
 * half-written link, since the successor is first read from its
 * predecessor's `continued-by:`.
 *
 * CRITICAL RULE 7. The result is complete, incomplete or failed. A bead that
 * cannot be read, two predecessors, two successors (a fork), a loop or a walk
 * past the limit makes the walk INCOMPLETE: the members it could read plus
 * every problem in words, never a silently shorter chain. A start that cannot
 * be read is FAILED.
 */

import type {BackStep, ContinuingLookup, ForwardStep} from './chain-step';
import type {HandoffNumber} from './handoff-number';
import type {ChainLinkState} from './handoff-view';
import type {EnvLike} from './paths';

import {existsSync} from 'fs';
import {dirname} from 'path';

import {findBeadsWorkspace} from '../beads/br';
import {chainNameOfLabels, chainNameText} from './chain-name';
import {chainNameInRegistry, readChainNames} from './chain-names';
import {stepBack, stepForward} from './chain-step';
import {CHAIN_WALK_LIMIT} from './handoff-chain';
import {handedOffAtOf} from './handoff-view';
import {CONTINUES_LABEL_PREFIX, SID_LABEL_PREFIX} from './session-bead';
import {locateSessionBead} from './session-handoff';
import {readSessionIndex, sessionBeadSighting} from './session-index';
import {
  type SessionMarks,
  sessionNameParts,
  stampedHandoffNumber,
} from './session-name';
import {newestRecord, readExportIndex} from './session-tree';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One session bead as the walk reads it. */
export interface ChainBead {
  /** The `.beads/` directory it was read from; null when br found it by a DB path only. */
  beadsDir: null | string;
  id: string;
  labels: readonly string[];
  notes: null | string;
  /**
   * The bead's status (`open`, `closed`, …); null or absent when the reader
   * could not say (home-base-lasun L3: `thread chain` prints it as unknown).
   */
  status?: null | string;
  title: string;
}

export type ChainBeadLookup =
  | {bead: ChainBead; kind: 'found'}
  | {kind: 'failed'; reason: string}
  | {kind: 'notFound'; reason: string};

/** What the walk reads; injected, so tests need no real state. */
export interface ChainWalkReaders {
  /** The beads that carry `continues:<beadId>`, searched near `beadsDir` and in every export the index names. */
  findContinuing: (beadId: string, beadsDir: null | string) => ContinuingLookup;
  readBead: (beadId: string) => ChainBeadLookup;
}

/** One session of a chain. */
export interface ChainMember {
  beadId: string;
  beadsDir: null | string;
  /** When it handed off (handedOffAtOf); null when it never did. */
  handedOffAt: null | string;
  /** Its place in the chain: 0 for the root. */
  handoffNumber: HandoffNumber;
  labels: readonly string[];
  /** The short mark: `[Scorpio-12]`, `[Scorpio]` for the root, `[#12]` with no chain name, `[#?]` unknown. */
  name: string;
  /** The bead's notes, as read (thread show reads its refusal line from them). */
  notes: null | string;
  /** The Claude session id from its one `sid:` label; null when it has none or several. */
  sessionId: null | string;
  /** Why `sessionId` is null; null when it is not. */
  sessionIdProblem: null | string;
  /** The bead's status; null when the reader could not say. */
  status: null | string;
  title: string;
}

interface ChainParts {
  /** The chain's name (`Scorpio II`), or null when it has none or it could not be read. */
  chainName: null | string;
  /** `links[i]` joins `members[i]` and `members[i + 1]` (handoff-view.ts's states). */
  links: ChainLinkState[];
  /** Oldest first. */
  members: ChainMember[];
  /** The index in `members` of the bead the walk started from. */
  startIndex: number;
}

export type ChainWalk =
  | ({kind: 'complete'; root: string} & ChainParts)
  | ({
      kind: 'incomplete';
      /** Each in words, naming the bead. */
      problems: string[];
      /** Null when the walk back did not reach the root. */
      root: null | string;
    } & ChainParts)
  | {kind: 'failed'; reason: string};

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

function labelsWith(labels: readonly string[], prefix: string): string[] {
  return labels
    .filter((label) => label.startsWith(prefix))
    .map((label) => label.slice(prefix.length));
}

function sessionIdOf(bead: ChainBead): {
  problem: null | string;
  sessionId: null | string;
} {
  const sids = labelsWith(bead.labels, SID_LABEL_PREFIX);
  const [only] = sids;
  if (only != null && sids.length === 1) {
    return {problem: null, sessionId: only};
  }
  return {
    problem:
      only == null
        ? `${bead.id} has no ${SID_LABEL_PREFIX} label, so its message log cannot be found`
        : `${bead.id} has ${sids.length} ${SID_LABEL_PREFIX} labels, so which message log is its own is unknown`,
    sessionId: null,
  };
}

/** `[Scorpio-12]`, through the one builder of session marks (session-name.ts). */
function memberName(chainName: null | string, number: HandoffNumber): string {
  const handoff: 'unknown' | number =
    number.kind === 'known' ? number.number : 'unknown';
  const marks: SessionMarks = {
    chain: chainName,
    // A root with a chain name shows the name alone, as everywhere else.
    handoff: chainName != null && handoff === 0 ? null : handoff,
    mayor: false,
  };
  return sessionNameParts(null, '', marks).after.trim();
}

/**
 * A member's number: its `handoff-number:` label, as the session's own name
 * shows it; else its place from the root when the walk back reached the root;
 * else unknown (rule 7: never 0).
 */
function numberOf(bead: ChainBead, place: null | number): HandoffNumber {
  const stamped = stampedHandoffNumber(bead.labels);
  if (stamped.kind === 'number') return {kind: 'known', number: stamped.number};
  if (stamped.kind === 'unreadable') {
    return {kind: 'unknown', reason: `${bead.id}: ${stamped.reason}`};
  }
  return place == null
    ? {
        kind: 'unknown',
        reason: `the walk back from ${bead.id} did not reach the first session`,
      }
    : {kind: 'known', number: place};
}

export interface ChainWalkOptions {
  /** The chain names, root to name; read from the registry when absent. */
  chainNameOfRoot?: (root: string) => null | string;
  limit?: number;
}

/** The registry's name for the root; with no root, the start bead's `chain:` label. */
function nameOfChain(
  root: null | string,
  start: ChainBead,
  options: ChainWalkOptions,
): null | string {
  if (root != null) {
    const named = options.chainNameOfRoot?.(root);
    if (named !== undefined) return named;
  }
  const label = chainNameOfLabels(start.labels);
  return label.kind === 'one' ? chainNameText(label.name) : null;
}

/** A back step that stopped the walk, in this walk's words. */
function backProblem(
  step: Exclude<BackStep<ChainBead>, {kind: 'next' | 'root'}>,
  currentId: string,
  startId: string,
  limit: number,
): string {
  switch (step.kind) {
    case 'loop':
      return `the chain loops back to ${step.id}`;
    case 'tooLong':
      return `the chain is longer than ${limit} sessions before ${startId}; the walk stopped at ${currentId}`;
    case 'twoPredecessors':
      return `${currentId} names ${step.ids.length} predecessors (${step.ids.map((id) => `${CONTINUES_LABEL_PREFIX}${id}`).join(', ')}), so the sessions before it are not shown`;
    case 'unreadable':
      return `${currentId} names ${CONTINUES_LABEL_PREFIX}${step.id}, but ${step.id} could not be read: ${step.read.reason}`;
  }
}

/** A forward step that stopped the walk, in this walk's words. */
function forwardProblem(
  step: Exclude<ForwardStep<ChainBead>, {kind: 'end' | 'next'}>,
  currentId: string,
  startId: string,
  limit: number,
): string {
  switch (step.kind) {
    case 'loop':
      return `the chain loops back to ${step.id}`;
    case 'reverseFailed':
      return `could not check whether a session continues ${currentId} (it has no continued-by: label): ${step.reason}`;
    case 'tooLong':
      return `the chain is longer than ${limit} sessions after ${startId}; the walk stopped at ${currentId}`;
    case 'twoContinuing':
      return `${step.ids.length} sessions carry ${CONTINUES_LABEL_PREFIX}${currentId} (${step.ids.join(', ')}): the chain forks there, so the sessions after it are not shown`;
    case 'twoSuccessors':
      return `${currentId} names ${step.ids.length} successors (${step.ids.map((id) => `continued-by:${id}`).join(', ')}): the chain forks there, so the sessions after it are not shown`;
    case 'unreadable':
      return step.via === 'continues'
        ? `${step.id} carries ${CONTINUES_LABEL_PREFIX}${currentId}, but could not be read: ${step.read.reason}`
        : `${currentId} names continued-by:${step.id}, but ${step.id} could not be read: ${step.read.reason}`;
  }
}

function walk(
  startBeadId: string,
  readers: ChainWalkReaders,
  options: ChainWalkOptions,
): ChainWalk {
  const limit = options.limit ?? CHAIN_WALK_LIMIT;
  const start = readers.readBead(startBeadId);
  if (start.kind !== 'found') {
    return {kind: 'failed', reason: `${startBeadId}: ${start.reason}`};
  }
  const seen = new Set<string>([start.bead.id]);
  const problems: string[] = [];

  // ---- back, through continues: only (chainRootOf's rule) ----
  // The steps are chain-step.ts's (home-base-lasun.1 F1); the words are this
  // walk's own.
  const before: ChainBead[] = [];
  const backLinks: ChainLinkState[] = [];
  let rootReached = false;
  for (let current = start.bead; ; ) {
    const step = stepBack(
      current,
      {limit, seen, taken: before.length},
      readers.readBead,
    );
    if (step.kind === 'root') {
      rootReached = true;
      break;
    }
    if (step.kind === 'next') {
      backLinks.push(step.link);
      before.push(step.bead);
      current = step.bead;
      continue;
    }
    problems.push(backProblem(step, current.id, start.bead.id, limit));
    break;
  }

  // ---- forward, through continued-by:, else the reverse search ----
  const after: ChainBead[] = [];
  const forwardLinks: ChainLinkState[] = [];
  for (let current = start.bead; ; ) {
    const step = stepForward(
      current,
      {limit, seen, taken: after.length},
      {
        findContinuing: (bead) =>
          readers.findContinuing(bead.id, bead.beadsDir),
        readBead: readers.readBead,
      },
    );
    if (step.kind === 'end') break;
    if (step.kind === 'next') {
      forwardLinks.push(step.link);
      after.push(step.bead);
      current = step.bead;
      continue;
    }
    problems.push(forwardProblem(step, current.id, start.bead.id, limit));
    break;
  }

  // ---- the members ----
  const beads = [...[...before].reverse(), start.bead, ...after];
  const root = rootReached ? (beads[0]?.id ?? null) : null;
  const chainName = nameOfChain(root, start.bead, options);
  const members = beads.map((bead, index): ChainMember => {
    const number = numberOf(bead, rootReached ? index : null);
    const sid = sessionIdOf(bead);
    return {
      beadId: bead.id,
      beadsDir: bead.beadsDir,
      handedOffAt: handedOffAtOf(bead.labels, bead.notes),
      handoffNumber: number,
      labels: bead.labels,
      name: memberName(chainName, number),
      notes: bead.notes,
      sessionId: sid.sessionId,
      sessionIdProblem: sid.problem,
      status: bead.status ?? null,
      title: bead.title,
    };
  });
  const parts: ChainParts = {
    chainName,
    links: [...[...backLinks].reverse(), ...forwardLinks],
    members,
    startIndex: before.length,
  };
  if (problems.length === 0 && root != null) {
    return {kind: 'complete', root, ...parts};
  }
  return {kind: 'incomplete', problems, root, ...parts};
}

/**
 * The whole chain through `startBeadId`, oldest first. Never throws: a reader
 * that throws is a problem, never a lost link.
 */
export function walkChain(
  startBeadId: string,
  readers: ChainWalkReaders,
  options: ChainWalkOptions = {},
): ChainWalk {
  try {
    return walk(startBeadId, readers, options);
  } catch (error) {
    return {
      kind: 'failed',
      reason: `reading the chain of ${startBeadId} threw: ${String(error)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Which chain: a name, a bead or a session
// ---------------------------------------------------------------------------

export type ChainStart =
  | {beadId: string; kind: 'found'}
  | {kind: 'failed'; reason: string};

/**
 * The session bead the sessions index records for a Claude session id. `none`
 * is measured: the index was read and records no bead for it.
 */
export function sessionBeadOf(
  sessionId: string,
  env: EnvLike,
): ChainStart | {kind: 'none'; reason: string} {
  const index = readSessionIndex(env);
  if (index.kind === 'missing') {
    return {
      kind: 'failed',
      reason: `there is no sessions index at ${index.path}, so session ${sessionId} has no session bead on record`,
    };
  }
  if (index.kind === 'failed') {
    return {
      kind: 'failed',
      reason: `the sessions index ${index.path} could not be read: ${index.error}`,
    };
  }
  const session = index.sessions.find((entry) => entry.sessionId === sessionId);
  const created = sessionBeadSighting(session?.sightings ?? []);
  if (created == null) {
    // A corrupt line naming the session could be its `created` line.
    return index.corrupt.some((line) => line.text.includes(sessionId))
      ? {
          kind: 'failed',
          reason: `the sessions index ${index.path} has a corrupt line for session ${sessionId}`,
        }
      : {
          kind: 'none',
          reason: `the sessions index records no session bead for session ${sessionId}`,
        };
  }
  return {beadId: created.beadId, kind: 'found'};
}

/** Every session id in the index that starts with `prefix`. */
export function sessionIdsStartingWith(
  prefix: string,
  env: EnvLike,
): {ids: string[]; kind: 'read'} | {kind: 'failed'; reason: string} {
  const index = readSessionIndex(env);
  if (index.kind === 'missing') return {ids: [], kind: 'read'};
  if (index.kind === 'failed') {
    return {
      kind: 'failed',
      reason: `the sessions index ${index.path} could not be read: ${index.error}`,
    };
  }
  return {
    ids: index.sessions
      .map((session) => session.sessionId)
      .filter((id) => id.startsWith(prefix)),
    kind: 'read',
  };
}

const SESSION_PREFIX = /^[0-9a-f]{8}(?:-[0-9a-f-]*)?$/u;

/**
 * The bead a `--chain` value names: a chain name (`Scorpio II`, any case,
 * `_` for the space), a bead id, or a Claude session id (whole, or its first
 * 8 or more characters when only one session starts with them). Anything else,
 * or a prefix two sessions share, is refused with the reason: never a guess.
 */
export function resolveChainStart(input: {
  env: EnvLike;
  readers: Pick<ChainWalkReaders, 'readBead'>;
  value: string;
}): ChainStart {
  const value = input.value.trim();
  if (value === '') return {kind: 'failed', reason: 'an empty --chain value'};

  // A chain name: letters, then an optional Roman numeral (`scorpio_ii`).
  if (/^[a-z]+(?:[ _]+[ivxlcdm]+)?$/iu.test(value)) {
    const spelled = value.replace(/[ _]+/gu, ' ').toLowerCase();
    const registry = readChainNames(input.env);
    if (registry.kind === 'failed') {
      return {kind: 'failed', reason: registry.reason};
    }
    const entry = registry.entries.find(
      (candidate) => chainNameText(candidate.name).toLowerCase() === spelled,
    );
    if (entry != null) return {beadId: entry.root, kind: 'found'};
  }

  if (SESSION_PREFIX.test(value)) {
    const found = sessionIdsStartingWith(value, input.env);
    if (found.kind === 'failed') return found;
    if (found.ids.length > 1) {
      return {
        kind: 'failed',
        reason: `${found.ids.length} sessions start with ${value} (${found.ids.join(', ')}): give more of the id`,
      };
    }
    const [sessionId] = found.ids;
    if (sessionId != null) {
      const bead = sessionBeadOf(sessionId, input.env);
      return bead.kind === 'none'
        ? {kind: 'failed', reason: bead.reason}
        : bead;
    }
  }

  const bead = input.readers.readBead(value);
  if (bead.kind === 'found') return {beadId: bead.bead.id, kind: 'found'};
  if (bead.kind === 'failed') {
    return {
      kind: 'failed',
      reason: `${value} is not a chain name or a session id, and reading it as a bead failed: ${bead.reason}`,
    };
  }
  return {
    kind: 'failed',
    reason: `${value} is not a chain name in the registry, a session id in the sessions index, or a session bead (${bead.reason})`,
  };
}

// ---------------------------------------------------------------------------
// The real readers
// ---------------------------------------------------------------------------

type SessionIndexRead = ReturnType<typeof readSessionIndex>;

/** Every `.beads/` directory the sessions index names, in first-seen order. */
function indexedBeadsDirs(index: SessionIndexRead): string[] {
  if (index.kind !== 'read') return [];
  const dirs: string[] = [];
  for (const session of index.sessions) {
    for (const sighting of session.sightings) {
      if (!dirs.includes(sighting.beadsDir)) dirs.push(sighting.beadsDir);
    }
  }
  return dirs;
}

/** The `.beads/` directories the index records `beadId` as created in. */
function createdDirsOf(beadId: string, index: SessionIndexRead): string[] {
  if (index.kind !== 'read') return [];
  const dirs: string[] = [];
  for (const session of index.sessions) {
    for (const sighting of session.sightings) {
      if (sighting.event !== 'created' || sighting.beadId !== beadId) continue;
      if (!dirs.includes(sighting.beadsDir)) dirs.push(sighting.beadsDir);
    }
  }
  return dirs;
}

/**
 * The real readers: beads from the exports the sessions index names, then
 * `cwd`'s beads workspace; a bead no export holds is asked of br.
 *
 * ONE MOMENT PER INSTANCE (home-base-lasun L6). The sessions index and each
 * export are read once per readers instance, so `thread search` can walk a
 * chain for every row it groups without parsing the index again per bead.
 * Make a new instance for a new moment; never keep one across runs.
 */
export function realChainWalkReaders(input: {
  cwd: string;
  env: EnvLike;
}): ChainWalkReaders {
  const {env} = input;
  const fallbackDirs: string[] = [];
  const fallbackDbs: string[] = [];
  const space = findBeadsWorkspace(input.cwd);
  if (space.kind === 'found') {
    fallbackDbs.push(space.db);
    fallbackDirs.push(dirname(space.db));
  }
  let index: null | SessionIndexRead = null;
  const sessionIndex = (): SessionIndexRead => {
    index ??= readSessionIndex(env);
    return index;
  };
  const exports = new Map<string, ReturnType<typeof readExportIndex>>();
  const exportOf = (dir: string): ReturnType<typeof readExportIndex> => {
    const known = exports.get(dir);
    if (known != null) return known;
    const read = readExportIndex(dir);
    exports.set(dir, read);
    return read;
  };
  const existing = new Map<string, boolean>();
  const dirExists = (dir: string): boolean => {
    const known = existing.get(dir);
    if (known != null) return known;
    const exists = existsSync(dir);
    existing.set(dir, exists);
    return exists;
  };

  const readBead = (beadId: string): ChainBeadLookup => {
    const dirs = [...createdDirsOf(beadId, sessionIndex())];
    for (const dir of fallbackDirs) if (!dirs.includes(dir)) dirs.push(dir);
    for (const dir of dirs) {
      const read = exportOf(dir);
      // An unreadable export is not an answer: br below is asked instead.
      if (read.kind !== 'read') continue;
      const newest = newestRecord(
        (read.index.byId.get(beadId) ?? []).map((record) => record.issue),
      );
      if (newest == null) continue;
      const {issue} = newest;
      return {
        bead: {
          beadsDir: dir,
          id: issue.id,
          labels: issue.labels,
          notes: issue.notes,
          status: issue.status,
          title: issue.title,
        },
        kind: 'found',
      };
    }
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
    return {
      bead: {
        beadsDir: dirname(located.db),
        id: located.id,
        labels: located.labels,
        notes: located.notes,
        title: located.title,
      },
      kind: 'found',
    };
  };

  const findContinuing = (
    beadId: string,
    beadsDir: null | string,
  ): ContinuingLookup => {
    const dirs = beadsDir == null ? [] : [beadsDir];
    for (const dir of [...fallbackDirs, ...indexedBeadsDirs(sessionIndex())]) {
      if (!dirs.includes(dir)) dirs.push(dir);
    }
    const label = `${CONTINUES_LABEL_PREFIX}${beadId}`;
    const ids: string[] = [];
    for (const dir of dirs) {
      // A directory that no longer exists holds no bead: a worktree removed
      // since the index recorded it. That is a measured absence.
      if (!dirExists(dir)) continue;
      const read = exportOf(dir);
      if (read.kind === 'failed') {
        return {kind: 'failed', reason: `${read.path}: ${read.reason}`};
      }
      const broken = read.index.unparsed.find((line) =>
        line.raw.includes(label),
      );
      if (broken != null) {
        return {
          kind: 'failed',
          reason: `line ${broken.lineNumber} of ${read.index.path} names ${label} but is not a bead record (${broken.reason})`,
        };
      }
      for (const record of read.index.byLabel.get(label) ?? []) {
        if (!ids.includes(record.issue.id)) ids.push(record.issue.id);
      }
    }
    return {ids, kind: 'read'};
  };

  return {findContinuing, readBead};
}

/** The registry, read once, as `chainNameOfRoot`; null names for a failed read. */
export function registryChainNames(
  env: EnvLike,
): (root: string) => null | string {
  const registry = readChainNames(env);
  return (root) => {
    if (registry.kind !== 'read') return null;
    const name = chainNameInRegistry(registry.entries, root);
    return name == null ? null : chainNameText(name);
  };
}
