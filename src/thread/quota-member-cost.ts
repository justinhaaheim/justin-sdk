/**
 * For `thread quota` (home-base-ys9t7.8.1, item 4): each group member's
 * latest Claude Code cost figure, from the statusline store's session-cost
 * history (claude-usage-cost.ts), beside the quota's own estimate of the same
 * session (session-cost.ts: its transcript and subagent transcripts, priced
 * per request) and the gap.
 *
 * Read in `runThreadQuota`, never in `gatherQuotaReport`: the brake measures
 * through that and must not price every member's whole transcript again. The
 * figure is shown, never budgeted on (D1 of home-base-ys9t7.5).
 */
import type {EnvLike} from './paths';
import type {GroupSpend} from './quota-group';

import {
  latestCostBySession,
  readSessionCostHistory,
  type SessionCostLine,
} from '../claude-usage-cost';
import {storePaths} from '../claude-usage-live';
import {
  type CostRequest,
  estimateCost,
  readTranscriptRequests,
  subagentTranscriptPaths,
} from '../session-cost';
import {findTranscript} from './facts';

export type MemberClaudeCode =
  | {kind: 'known'; line: SessionCostLine}
  /** The history was read and holds no line for this session. */
  | {kind: 'none'}
  | {kind: 'unreadable'; reason: string};

export type MemberEstimate =
  | {files: number; kind: 'known'; usd: number}
  | {kind: 'unknown'; lowerBoundUsd: number | null; reason: string};

export interface MemberCost {
  beadId: string;
  claudeCode: MemberClaudeCode;
  estimate: MemberEstimate;
  /** The estimate minus Claude Code's figure; null unless both are known. */
  gapUsd: number | null;
  sessionId: string;
}

export interface MemberCosts {
  /** session-cost.jsonl, and whether it was there. */
  history: {kind: 'failed' | 'missing' | 'ok'; path: string};
  members: MemberCost[];
}

async function estimateFiles(
  files: readonly string[],
): Promise<MemberEstimate> {
  const requests = new Map<string, CostRequest>();
  for (const file of files) {
    try {
      await readTranscriptRequests(file, requests);
    } catch (error) {
      return {
        kind: 'unknown',
        lowerBoundUsd: null,
        reason: `${file} could not be read: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  const estimate = estimateCost(requests.values());
  if (estimate.usd == null) {
    return {
      kind: 'unknown',
      lowerBoundUsd: estimate.pricedUsd,
      reason: `${estimate.unpricedParts} part(s) used a model with no list price`,
    };
  }
  return {files: files.length, kind: 'known', usd: estimate.usd};
}

function filesOf(
  member: GroupSpend['members'][number],
  env: EnvLike,
): {files: string[]; kind: 'found'} | {kind: 'unknown'; reason: string} {
  if ('files' in member) return {files: member.files, kind: 'found'};
  const found = findTranscript(member.sessionId, env);
  if (found.status !== 'found') {
    return {
      kind: 'unknown',
      reason:
        found.status === 'failed'
          ? found.error
          : `no transcript under ${found.searched}`,
    };
  }
  try {
    return {
      files: [found.path, ...subagentTranscriptPaths(found.path)],
      kind: 'found',
    };
  } catch (error) {
    return {
      kind: 'unknown',
      reason: `its subagent transcripts could not be listed: ${String(error)}`,
    };
  }
}

/** Each member's Claude Code figure and the quota's estimate. Reads only. */
export async function gatherMemberCosts(input: {
  env: EnvLike;
  group: GroupSpend;
}): Promise<MemberCosts> {
  const {env, group} = input;
  const path = storePaths(env).costHistory;
  const read = readSessionCostHistory(path);
  const latest = read.kind === 'ok' ? latestCostBySession(read.lines) : null;
  const members: MemberCost[] = [];
  for (const member of group.members) {
    const line = latest?.get(member.sessionId) ?? null;
    const claudeCode: MemberClaudeCode =
      read.kind === 'failed'
        ? {kind: 'unreadable', reason: read.reason}
        : line == null
          ? {kind: 'none'}
          : {kind: 'known', line};
    const files = filesOf(member, env);
    const estimate: MemberEstimate =
      files.kind === 'found'
        ? await estimateFiles(files.files)
        : {kind: 'unknown', lowerBoundUsd: null, reason: files.reason};
    members.push({
      beadId: member.beadId,
      claudeCode,
      estimate,
      gapUsd:
        claudeCode.kind === 'known' && estimate.kind === 'known'
          ? estimate.usd - claudeCode.line.totalCostUsd
          : null,
      sessionId: member.sessionId,
    });
  }
  return {history: {kind: read.kind, path}, members};
}
