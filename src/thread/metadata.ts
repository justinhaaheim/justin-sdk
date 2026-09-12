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

/**
 * The metadata for a thread bead created at SESSION START, before the session
 * has reported anything (home-base-p1uj.3).
 *
 * THE SAME KEY SET as `buildThreadMetadata`, with an explicit `null` everywhere
 * the answer is genuinely not known yet. That is the whole point: `bd update
 * --metadata` merges, so the first real report overwrites every one of these,
 * and a reader (`thread board`) can tell "this session has not reported" from
 * "this session reported nothing" — `reportCount: 0` and `reportedAt: null`
 * together say it out loud.
 *
 * `reportedAt: null` IS LOAD-BEARING, not cosmetic. `writeReportToBd` reads it
 * twice: the supersede guard compares it against the incoming report's stamp,
 * and the orphan-ask sweep uses it to recognise asks left by a half-written
 * previous attempt. A start bead has had neither, so a fabricated stamp here
 * would make the first real report either look superseded or hunt for orphans
 * among asks that cannot exist. Null makes both checks correctly skip.
 *
 * `askIds`, `carriedAskIds`, `openAskCount` and `blockingAskCount` are the
 * exception to the nulls, and they are MEASURED rather than assumed: a bead
 * that was created seconds ago has no children, so empty and zero are the true
 * values, not stand-ins for an unknown.
 */
export function buildStartMetadata(input: {
  facts: ThreadFacts;
  startedAt: string;
}): Record<string, unknown> {
  const {facts, startedAt} = input;
  return {
    aheadBehind: facts.aheadBehind,
    askIds: [],
    autofillFailures: facts.autofillFailures,
    beadsTouched: [],
    blockingAskCount: 0,
    carriedAskIds: [],
    branch: facts.branch,
    continuesFrom: null,
    cwd: facts.cwd,
    dirty: facts.dirty,
    entrypoint: facts.entrypoint,
    goal: null,
    handoffPresent: false,
    headSha: facts.headSha,
    instruction: null,
    isWorktree: facts.isWorktree,
    lastUserMessage: facts.lastUserMessage,
    mergeState: null,
    model: facts.model,
    openAskCount: 0,
    pr: null,
    progressPercent: null,
    reportCount: 0,
    reportedAt: null,
    repo: facts.repo,
    repoPath: facts.repoPath,
    schemaVersion: THREAD_SCHEMA_VERSION,
    sessionId: facts.sessionId,
    // When the SESSION began where that is readable from the transcript, and
    // otherwise when the hook ran. Distinguished in `startedAtSource` rather
    // than silently conflated: "the transcript says 09:04" and "I saw this
    // session for the first time at 09:04" are different claims.
    startedAt: facts.startedAt ?? startedAt,
    startedAtSource:
      facts.startedAt != null ? 'transcript' : 'sessionStartHook',
    stopReasonDetail: null,
    stopReasonKind: null,
    threadStartedAt: startedAt,
    tokensAtStop: facts.tokensAtStop,
    transcriptPath: facts.transcriptPath,
    workProductKind: null,
    worktreePath: facts.worktreePath,
  };
}

export interface AskMetadataInput {
  askIndex: number;
  blocking: boolean;
  defaultAction: string;
  kind: string;
  optionCount: number;
  /** Which report created this ask — read back by F4's "carried from report #N". */
  reportCount: number;
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
    reportCount: input.reportCount,
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
