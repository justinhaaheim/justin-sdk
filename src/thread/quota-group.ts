/**
 * A quota GROUP and its unattended spend (request home-base-ys9t7.5, D2).
 *
 * THE GROUP is every session linked to the caller by handoff labels
 * (`continues:` / `continued-by:`) and spawn labels (`spawned-by:` /
 * `spawned:`, D8; read here, written from dispatch 2). The walk goes UP from
 * the caller's session bead along `continues:` and `spawned-by:` to the root,
 * then DOWN from the root along `continued-by:` and `spawned:` to every
 * member. The beads on the way up are members whatever the down-labels say.
 * Bounded by CHAIN_WALK_LIMIT, like the handoff chain walk.
 *
 * UNATTENDED SPEND is every request of every member (main transcript plus its
 * subagents, each request once across all of them) dated after the group's
 * latest line Justin TYPED, in any member (quota-read.ts says what typed
 * means). A typed line in one member resets the window for the whole group.
 * With no typed line anywhere, every request counts.
 *
 * CRITICAL RULE 7 (D10). Anything the measurement needs and cannot read makes
 * the WHOLE result `unknown` with the reason: a bead that cannot be shown, a
 * member with no `sid:` label or two, two parents, a loop on the way up, a
 * group over the limit, a transcript that cannot be found or read, a typed
 * line or a request with no timestamp, and a model with no list price (that
 * one keeps the priced part as a lower bound).
 */

import type {CostRequest} from '../session-cost';
import type {QuotaRateFamily} from './defaults';
import type {ChainBeadRead} from './handoff-chain';
import type {EnvLike} from './paths';
import type {SpendTotals} from './quota-spend';

import {estimateCost, subagentTranscriptPaths} from '../session-cost';
import {findTranscript} from './facts';
import {CHAIN_WALK_LIMIT, realChainReaders} from './handoff-chain';
import {latestTyped, readSpendTranscript} from './quota-read';
import {weekSpendOf} from './quota-spend';
import {
  CONTINUED_BY_LABEL_PREFIX,
  CONTINUES_LABEL_PREFIX,
  SID_LABEL_PREFIX,
  SPAWN_KICKOFF_LABEL,
  SPAWNED_BY_LABEL_PREFIX,
  SPAWNED_LABEL_PREFIX,
} from './session-bead';

// ---------------------------------------------------------------------------
// The group
// ---------------------------------------------------------------------------

export interface GroupMember {
  beadId: string;
  sessionId: string;
  /**
   * The bead carries SPAWN_KICKOFF_LABEL: its first prompt was typed by
   * `thread spawn`, so it is not read as Justin typing (D8, item 3).
   */
  spawnKickoff: boolean;
}

export type QuotaGroup =
  | {kind: 'resolved'; members: GroupMember[]; root: string}
  | {kind: 'unknown'; members: GroupMember[]; reason: string};

function labelsWith(labels: readonly string[], prefix: string): string[] {
  return labels
    .filter((label) => label.startsWith(prefix))
    .map((label) => label.slice(prefix.length));
}

/**
 * Resolve the group of `startBeadId`: members in walk order (the up path,
 * root last on it; then the rest, breadth first from the root).
 */
export function resolveQuotaGroup(
  startBeadId: string,
  showBead: (beadId: string) => ChainBeadRead,
  options: {limit?: number} = {},
): QuotaGroup {
  const limit = options.limit ?? CHAIN_WALK_LIMIT;
  const members: GroupMember[] = [];
  const memberIds = new Set<string>();
  const shown = new Map<string, readonly string[]>();
  const unknown = (reason: string): QuotaGroup => ({
    kind: 'unknown',
    members,
    reason,
  });

  /** Show a bead and add it as a member; a string is why it cannot be. */
  const admit = (beadId: string): readonly string[] | string => {
    const cached = shown.get(beadId);
    if (cached != null) return cached;
    const bead = showBead(beadId);
    if (bead.kind !== 'found') return `session bead ${beadId}: ${bead.reason}`;
    const sids = labelsWith(bead.labels, SID_LABEL_PREFIX);
    const [sessionId] = sids;
    if (sessionId == null || sids.length !== 1) {
      return sessionId == null
        ? `${beadId} has no ${SID_LABEL_PREFIX} label, so its transcript cannot be found`
        : `${beadId} has ${sids.length} ${SID_LABEL_PREFIX} labels, so which transcript is its own is unknown`;
    }
    shown.set(beadId, bead.labels);
    memberIds.add(beadId);
    members.push({
      beadId,
      sessionId,
      spawnKickoff: bead.labels.includes(SPAWN_KICKOFF_LABEL),
    });
    return bead.labels;
  };

  // UP: one parent at most, through either kind of link.
  let current = startBeadId;
  const upPath = new Set<string>();
  for (;;) {
    if (upPath.has(current)) {
      return unknown(`the group loops back to ${current} on the way up`);
    }
    if (upPath.size >= limit) {
      return unknown(
        `the group is deeper than ${limit} sessions; the walk stopped at ${current}`,
      );
    }
    upPath.add(current);
    const labels = admit(current);
    if (typeof labels === 'string') return unknown(labels);
    const parents = [CONTINUES_LABEL_PREFIX, SPAWNED_BY_LABEL_PREFIX].flatMap(
      (prefix) =>
        labelsWith(labels, prefix).map((id) => ({id, label: `${prefix}${id}`})),
    );
    if (parents.length > 1) {
      return unknown(
        `${current} names ${parents.length} parents (${parents.map((parent) => parent.label).join(', ')})`,
      );
    }
    const [parent] = parents;
    if (parent == null) break;
    current = parent.id;
  }
  const root = current;

  // DOWN: breadth first from the root, every successor and spawned child.
  const queue = [root];
  const discovered = new Set<string>([...memberIds, root]);
  // for-of over an array visits what is pushed while it runs.
  for (const beadId of queue) {
    const labels = admit(beadId);
    if (typeof labels === 'string') return unknown(labels);
    const children = [
      ...labelsWith(labels, CONTINUED_BY_LABEL_PREFIX),
      ...labelsWith(labels, SPAWNED_LABEL_PREFIX),
    ];
    for (const child of children) {
      if (queue.includes(child)) continue;
      if (!discovered.has(child)) {
        if (discovered.size >= limit) {
          return unknown(
            `the group has more than ${limit} sessions; the walk stopped at ${child}`,
          );
        }
        discovered.add(child);
      }
      queue.push(child);
    }
  }
  return {kind: 'resolved', members, root};
}

// ---------------------------------------------------------------------------
// Its unattended spend
// ---------------------------------------------------------------------------

export type TranscriptFind =
  | {kind: 'failed'; reason: string}
  | {kind: 'found'; path: string}
  | {kind: 'notFound'; reason: string};

/** The readers the measurement uses; injected so tests need no real state. */
export interface GroupSpendReaders {
  findTranscript: (sessionId: string) => TranscriptFind;
  showBead: (beadId: string) => ChainBeadRead;
}

export interface MemberSpendRead extends GroupMember {
  /** The main transcript, then its subagent transcripts. */
  files: string[];
  typedLines: number;
}

/**
 * The group's latest typed line as its own fact (dispatch 2 item 1), read
 * before any pricing, so an attended group is known as attended even when its
 * spend cannot be priced (D10).
 *
 *   - `complete`: every member was read; `latestTypedAtMs` null = no typed
 *     line anywhere.
 *   - `partial`: some lines were read and something was not (a member's
 *     transcript, a typed line with no timestamp). A typed line found within
 *     the grace still PROVES attendance (anything unread could only be later,
 *     which is still within it); it can never prove the group unattended.
 *   - `unknown`: nothing could be read (the group itself did not resolve).
 */
export type TypedReading =
  | {kind: 'complete'; latestTypedAtMs: number | null}
  | {kind: 'partial'; latestTypedAtMs: number | null; reason: string}
  | {kind: 'unknown'; reason: string};

/**
 * Attended, unattended or unknown, from a TypedReading (pure). Unknown is
 * treated as unattended by every caller (the cautious side).
 */
export type Attendance =
  | {kind: 'attended'; latestTypedAtMs: number}
  | {kind: 'unattended'; latestTypedAtMs: number | null}
  | {kind: 'unknown'; reason: string};

export function attendanceOf(
  typed: TypedReading,
  nowMs: number,
  graceMinutes: number,
): Attendance {
  if (typed.kind === 'unknown') return {kind: 'unknown', reason: typed.reason};
  const latest = typed.latestTypedAtMs;
  if (latest != null && nowMs - latest < graceMinutes * 60_000) {
    return {kind: 'attended', latestTypedAtMs: latest};
  }
  if (typed.kind === 'partial') {
    return {
      kind: 'unknown',
      reason: `no typed line within ${graceMinutes} min was found, and ${typed.reason}`,
    };
  }
  return {kind: 'unattended', latestTypedAtMs: latest};
}

/** The latest of the dated typed times, or null for none. */
function latestDated(typedAtMs: readonly (number | null)[]): number | null {
  let latest: number | null = null;
  for (const at of typedAtMs) {
    if (at != null && (latest == null || at > latest)) latest = at;
  }
  return latest;
}

export type GroupSpend =
  | {
      /** Epoch ms of the earliest request counted, or null when none was. */
      firstUnattendedAtMs: number | null;
      kind: 'known';
      /** Epoch ms of the group's latest typed line, or null when it has none. */
      latestTypedAtMs: number | null;
      members: MemberSpendRead[];
      /** Requests counted (dated after the latest typed line). */
      requests: number;
      root: string;
      spend: SpendTotals;
      /** Always `complete` here; carried so every GroupSpend has one. */
      typed: TypedReading;
      unparseableLines: number;
    }
  | {
      kind: 'unknown';
      /** The priced part when only prices are missing; otherwise null. */
      lowerBound: SpendTotals | null;
      members: GroupMember[];
      reason: string;
      /** What was read of the typed lines before the measurement failed. */
      typed: TypedReading;
    };

/** Requests dated after `cutoffMs` (all of them when null), or why not. */
export function requestsAfter(
  requests: Iterable<CostRequest>,
  cutoffMs: number | null,
): {kind: 'ok'; requests: CostRequest[]} | {kind: 'undated'; undated: number} {
  const kept: CostRequest[] = [];
  let undated = 0;
  for (const request of requests) {
    if (request.atMs == null) {
      undated += 1;
      continue;
    }
    if (cutoffMs == null || request.atMs > cutoffMs) kept.push(request);
  }
  return undated > 0
    ? {kind: 'undated', undated}
    : {kind: 'ok', requests: kept};
}

/** The earliest request time, or null for none (no spread: lists are long). */
export function earliestOf(requests: readonly CostRequest[]): number | null {
  let earliest: number | null = null;
  for (const request of requests) {
    if (request.atMs == null) continue;
    if (earliest == null || request.atMs < earliest) earliest = request.atMs;
  }
  return earliest;
}

/** Resolve `startBeadId`'s group and measure what it spent unattended. */
export async function measureGroupSpend(
  startBeadId: string,
  readers: GroupSpendReaders,
  options: {
    dollarsPerWeekPercent: Readonly<Record<QuotaRateFamily, number>>;
    limit?: number;
  },
): Promise<GroupSpend> {
  const group = resolveQuotaGroup(startBeadId, readers.showBead, {
    limit: options.limit,
  });
  if (group.kind === 'unknown') {
    return {
      kind: 'unknown',
      lowerBound: null,
      members: group.members,
      reason: group.reason,
      typed: {
        kind: 'unknown',
        reason: `the group did not resolve: ${group.reason}`,
      },
    };
  }

  // Every member is read even after one fails: the typed lines that WERE
  // read can still prove the group attended (item 1, TypedReading).
  const requests = new Map<string, CostRequest>();
  const typed: (number | null)[] = [];
  const reads: MemberSpendRead[] = [];
  let unparseableLines = 0;
  let failure: string | null = null;
  for (const member of group.members) {
    const found = readers.findTranscript(member.sessionId);
    if (found.kind !== 'found') {
      failure ??= `the transcript of ${member.beadId} (session ${member.sessionId}): ${found.reason}`;
      continue;
    }
    let files: string[];
    try {
      files = [found.path, ...subagentTranscriptPaths(found.path)];
    } catch (error) {
      failure ??= `the subagent transcripts of ${member.beadId} could not be listed: ${String(error)}`;
      files = [found.path];
    }
    let typedLines = 0;
    for (const file of files) {
      try {
        // Only the main transcript holds the kickoff; subagents get none.
        const read = await readSpendTranscript(file, requests, {
          dropFirstPrompt: member.spawnKickoff && file === found.path,
        });
        typed.push(...read.typedAtMs);
        typedLines += read.typedAtMs.length;
        unparseableLines += read.unparseableLines;
      } catch (error) {
        failure ??= `${file} (${member.beadId}) could not be read: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    reads.push({...member, files, typedLines});
  }

  const latest = latestTyped(typed);
  if (failure == null && latest.kind === 'undated') {
    failure =
      'a line Justin typed in the group carries no timestamp, so where its unattended work starts is unknown';
  }
  if (failure != null) {
    return {
      kind: 'unknown',
      lowerBound: null,
      members: group.members,
      reason: failure,
      typed: {
        kind: 'partial',
        latestTypedAtMs: latestDated(typed),
        reason: failure,
      },
    };
  }
  const latestTypedAtMs = latest.kind === 'at' ? latest.atMs : null;
  const typedReading: TypedReading = {kind: 'complete', latestTypedAtMs};
  const unknown = (reason: string): GroupSpend => ({
    kind: 'unknown',
    lowerBound: null,
    members: group.members,
    reason,
    typed: typedReading,
  });
  const counted = requestsAfter(requests.values(), latestTypedAtMs);
  if (counted.kind === 'undated') {
    return unknown(
      `${counted.undated} request(s) in the group carry no timestamp, so whether they came after Justin's latest typed line is unknown`,
    );
  }
  const spend = weekSpendOf(
    estimateCost(counted.requests),
    options.dollarsPerWeekPercent,
  );
  if (spend.kind === 'unknown') {
    return {
      kind: 'unknown',
      lowerBound: spend.lowerBound,
      members: group.members,
      reason: spend.reason,
      typed: typedReading,
    };
  }
  return {
    firstUnattendedAtMs: earliestOf(counted.requests),
    kind: 'known',
    latestTypedAtMs,
    members: reads,
    requests: counted.requests.length,
    root: group.root,
    spend: {
      byFamily: spend.byFamily,
      usd: spend.usd,
      weekPercent: spend.weekPercent,
    },
    typed: typedReading,
    unparseableLines,
  };
}

/**
 * The real readers: beads through the handoff chain walk's reader (the
 * sessions index first, so a member in another checkout's DB is found, then
 * `cwd`'s DB), transcripts by session id anywhere under the transcripts root.
 */
export function realGroupSpendReaders(input: {
  cwd: string;
  env: EnvLike;
  fallbackDbs?: readonly string[];
}): GroupSpendReaders {
  const {showBead} = realChainReaders(input);
  return {
    findTranscript: (sessionId) => {
      const found = findTranscript(sessionId, input.env);
      if (found.status === 'found') return {kind: 'found', path: found.path};
      if (found.status === 'failed')
        return {kind: 'failed', reason: found.error};
      return {
        kind: 'notFound',
        reason: `no ${sessionId}.jsonl under ${found.searched}`,
      };
    },
    showBead,
  };
}
