/**
 * The `thread` bead's metadata document (home-base-p1uj D7, D9).
 *
 * camelCase keys throughout, because bd's `--metadata-field` filter accepts
 * `[a-zA-Z_][a-zA-Z0-9_.]*` and rejects hyphens — and `sessionId` is the key the
 * whole one-bead-per-session identity (D1) hangs off.
 *
 * EVERY KEY IS WRITTEN ON EVERY WRITE, nulls included. `bd update --metadata
 * @file.json` MERGES rather than replaces (measured 2026-09-12, bd 1.1.0 —
 * despite D9's "wholesale" wording), so a key omitted because this report could
 * not measure it would silently keep the PREVIOUS report's value. Sending the
 * full key set, with explicit nulls, is what makes the merge behave like the
 * replacement D9 intended. Nulls and empty arrays both persist and overwrite;
 * that was measured too.
 */

import {THREAD_SCHEMA_VERSION} from './schema';

import type {ThreadFacts} from './facts';
import type {ThreadReportPayload} from './schema';

export interface ThreadMetadataInput {
  askIds: (string | null)[];
  /**
   * Asks from EARLIER reports that are still open after this one — i.e. the
   * ones dispositioned `carried`. Required, because `openAskCount` is a claim
   * about the whole thread and not about this report: a report that creates no
   * asks while carrying a blocking one would otherwise record `openAskCount:
   * 0`, which the board would read as "nothing is waiting for Justin" (rule 6,
   * and in the reassuring direction).
   */
  carriedOpenAsks: readonly {blocking: boolean; id: string}[];
  facts: ThreadFacts;
  payload: ThreadReportPayload;
  reportCount: number;
}

export function buildThreadMetadata(
  input: ThreadMetadataInput,
): Record<string, unknown> {
  const {askIds, carriedOpenAsks, facts, payload, reportCount} = input;
  const createdIds = askIds.filter((id): id is string => id != null);
  return {
    aheadBehind: facts.aheadBehind,
    askIds: createdIds,
    autofillFailures: facts.autofillFailures,
    beadsTouched: payload.beadsTouched,
    blockingAskCount:
      payload.asks.filter((ask) => ask.blocking).length +
      carriedOpenAsks.filter((ask) => ask.blocking).length,
    carriedAskIds: carriedOpenAsks.map((ask) => ask.id),
    branch: facts.branch,
    continuesFrom: payload.continuesFrom ?? null,
    cwd: facts.cwd,
    dirty: facts.dirty,
    entrypoint: facts.entrypoint,
    goal: payload.goal,
    handoffPresent: payload.handoff != null && payload.handoff !== '',
    headSha: facts.headSha,
    instruction: payload.instruction,
    isWorktree: facts.isWorktree,
    lastUserMessage: facts.lastUserMessage,
    mergeState: payload.workProduct.merged,
    model: facts.model,
    // The WHOLE thread's open asks after this report: the ones it just created
    // plus the ones it carried. Not "asks in this payload".
    openAskCount: createdIds.length + carriedOpenAsks.length,
    pr: payload.workProduct.pr,
    progressPercent: payload.progress.percent,
    reportCount,
    reportedAt: facts.reportedAt,
    repo: facts.repo,
    repoPath: facts.repoPath,
    schemaVersion: THREAD_SCHEMA_VERSION,
    sessionId: facts.sessionId,
    startedAt: facts.startedAt,
    stopReasonDetail: payload.stopReason.detail,
    stopReasonKind: payload.stopReason.kind,
    tokensAtStop: facts.tokensAtStop,
    transcriptPath: facts.transcriptPath,
    workProductKind: payload.workProduct.kind,
    worktreePath: facts.worktreePath,
  };
}

export interface AskMetadataInput {
  askIndex: number;
  blocking: boolean;
  defaultAction: string;
  kind: string;
  optionCount: number;
  reportedAt: string;
  sessionId: string;
  threadId: string;
}

export function buildAskMetadata(
  input: AskMetadataInput,
): Record<string, unknown> {
  return {
    // null, never absent: `thread inbox` (p1uj.2) reads this to tell an
    // unanswered ask from one whose answer it failed to read.
    answeredAt: null,
    askIndex: input.askIndex,
    blocking: input.blocking,
    createdAt: input.reportedAt,
    defaultAction: input.defaultAction,
    kind: input.kind,
    optionCount: input.optionCount,
    schemaVersion: THREAD_SCHEMA_VERSION,
    sessionId: input.sessionId,
    threadId: input.threadId,
  };
}

/** Read `reportCount` back off an existing bead. Absent or odd means 0. */
export function readReportCount(metadata: unknown): number {
  if (metadata == null || typeof metadata !== 'object') return 0;
  const value = (metadata as {reportCount?: unknown}).reportCount;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}
