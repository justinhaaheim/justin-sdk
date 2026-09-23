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

import type {ThreadFacts} from './facts';
import type {ThreadReportPayload} from './schema';

import {
  ASK_PRIORITY_BLOCKING,
  ASK_PRIORITY_DEFAULT,
  THREAD_SCHEMA_VERSION,
} from './schema';

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
  carriedOpenAsks: readonly {id: string; priority: number}[];
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
    // P0 IS THE NEW BLOCKING, and this key keeps its old name on purpose: the
    // board, the drain and anything else already reading `blockingAskCount`
    // means exactly "how many asks stop Justin's session", which is the count of
    // P0s (D15). Renaming it would have made every existing reader read
    // `undefined` — zero-shaped, in the reassuring direction.
    blockingAskCount:
      payload.asks.filter((ask) => ask.priority === ASK_PRIORITY_BLOCKING)
        .length +
      carriedOpenAsks.filter((ask) => ask.priority === ASK_PRIORITY_BLOCKING)
        .length,
    branch: facts.branch,
    carriedAskIds: carriedOpenAsks.map((ask) => ask.id),
    continuesFrom: payload.continuesFrom ?? null,
    cwd: facts.cwd,
    deviations: payload.deviations,
    dirty: facts.dirty,
    entrypoint: facts.entrypoint,
    // The three messages, VERBATIM AND UNCAPPED (home-base-k0b8n K4). They are
    // what makes a thread bead searchable and what `thread show` prints; the
    // renderers cap what they PRINT, nothing caps what is stored.
    firstUserMessage: facts.firstUserMessage,
    firstUserMessageAt: facts.firstUserMessageAt,
    goal: payload.goal,
    handoffPresent: payload.handoff != null && payload.handoff !== '',
    headSha: facts.headSha,
    instruction: payload.instruction,
    isWorktree: facts.isWorktree,
    lastAssistantMessage: facts.lastAssistantMessage,
    lastAssistantMessageAt: facts.lastAssistantMessageAt,
    lastUserMessage: facts.lastUserMessage,
    lastUserMessageAt: facts.lastUserMessageAt,
    mergeState: payload.workProduct.merged,
    // WHO LAST WROTE THE VERBATIM MESSAGES (k0b8n.3, K5). `thread backfill`
    // stamps 'backfill' when it fills in messages a bead never had; a real
    // report overwrites both the messages and this key, because `bd update
    // --metadata` MERGES and a stale 'backfill' here would keep claiming the
    // transcript scanner wrote what the report just rewrote.
    messagesSource: 'report',
    model: facts.model,
    nextStep: payload.nextStep,
    // The WHOLE thread's open asks after this report: the ones it just created
    // plus the ones it carried. Not "asks in this payload".
    openAskCount: createdIds.length + carriedOpenAsks.length,
    pr: payload.workProduct.pr,
    progressPercent: payload.progress.percent,
    repo: facts.repo,
    repoPath: facts.repoPath,
    reportCount,
    reportedAt: facts.reportedAt,
    // Copy-pasteable, and measured rather than composed by a reader: the cwd it
    // cds to is the one whose slug IS this transcript's project directory (K4).
    resumeCommand: facts.resumeCommand,
    schemaVersion: THREAD_SCHEMA_VERSION,
    sessionId: facts.sessionId,
    // WHAT MADE THIS BEAD (k0b8n.3, K5). Written on every report precisely so
    // that a bead `thread backfill` created is no longer a backfill bead once
    // its session reports: the board hides `backfill` rows, and the merge
    // semantics of `--metadata` mean an omitted key would leave the row hidden
    // forever.
    source: 'report',
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
    branch: facts.branch,
    carriedAskIds: [],
    continuesFrom: null,
    cwd: facts.cwd,
    deviations: [],
    dirty: facts.dirty,
    entrypoint: facts.entrypoint,
    // MEASURED even at session start, not null-because-early: the transcript
    // already exists when the SessionStart hook runs (D7 finds it by UUID), and
    // a session that dies without ever reporting is exactly the one whose first
    // message is the only record of what it was for.
    firstUserMessage: facts.firstUserMessage,
    firstUserMessageAt: facts.firstUserMessageAt,
    goal: null,
    handoffPresent: false,
    headSha: facts.headSha,
    instruction: null,
    isWorktree: facts.isWorktree,
    lastAssistantMessage: facts.lastAssistantMessage,
    lastAssistantMessageAt: facts.lastAssistantMessageAt,
    lastUserMessage: facts.lastUserMessage,
    lastUserMessageAt: facts.lastUserMessageAt,
    mergeState: null,
    /** See buildThreadMetadata: 'start' means the SessionStart hook read them. */
    messagesSource: 'start',
    model: facts.model,
    nextStep: null,
    openAskCount: 0,
    pr: null,
    progressPercent: null,
    repo: facts.repo,
    repoPath: facts.repoPath,
    reportCount: 0,
    reportedAt: null,
    resumeCommand: facts.resumeCommand,
    schemaVersion: THREAD_SCHEMA_VERSION,
    sessionId: facts.sessionId,
    /**
     * A REAL session made this bead, not the backfill (k0b8n.3, K5). It is not
     * 'report' — nothing has been reported yet — and it is not absent, because
     * `thread backfill` treats anything that is not 'backfill' as a bead whose
     * body belongs to the report path and may only have its messages filled in.
     */
    source: 'start',
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
  defaultAction: string;
  kind: string;
  optionCount: number;
  priority: number;
  /** Which report created this ask — read back by F4's "carried from report #N". */
  reportCount: number;
  reportedAt: string;
  sessionId: string;
  /**
   * The ask this one RESTATES and where it came from (D24), or null.
   *
   * The lineage is stored, not just the id, because the id alone stops meaning
   * anything the moment the old ask is closed: "th-eru.2, report #7" is what
   * lets a later reader say WHICH report Justin was asked this in, on a thread
   * that is not this one.
   */
  supersedes: {
    fromReport: number | null;
    fromThread: string | null;
    id: string;
  } | null;
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
    // BOTH KEYS, FOR ONE RELEASE (D15). `priority` is the truth; `blocking` is
    // written alongside it so an ask bead created by this build is still legible
    // to a reader that has not been updated — including an OLDER justin-sdk,
    // which another checkout on this machine may well be running. Readers here
    // all go through `readAskPriority`, which prefers `priority` and falls back.
    blocking: input.priority === ASK_PRIORITY_BLOCKING,
    createdAt: input.reportedAt,
    defaultAction: input.defaultAction,
    kind: input.kind,
    optionCount: input.optionCount,
    priority: input.priority,
    reportCount: input.reportCount,
    schemaVersion: THREAD_SCHEMA_VERSION,
    sessionId: input.sessionId,
    // Three keys rather than a nested object: bd's metadata filters match on
    // flat keys, so `supersedesAskId` is queryable and `supersedes.id` is not.
    // Explicit nulls, never absent — "this ask restates nothing" is a fact.
    supersedesAskId: input.supersedes?.id ?? null,
    supersedesFromReport: input.supersedes?.fromReport ?? null,
    supersedesFromThread: input.supersedes?.fromThread ?? null,
    threadId: input.threadId,
  };
}

/**
 * An ask bead's priority, 0-4 (D15). The ONE reader; everything else goes
 * through it.
 *
 * `priority` first, then the v1 `blocking` boolean, then P3. The fallback order
 * is the migration: an ask bead written before this release carries only
 * `blocking`, and an ask bead written by a build that has neither carries
 * nothing at all. The last case resolves to P3 rather than P0 deliberately — an
 * unreadable priority must not manufacture urgency it cannot evidence, and P3's
 * meaning ("my default is fine") is the honest thing to say about an ask whose
 * urgency is unknown. It is surfaced, not silent: every renderer prints the
 * priority it used.
 */
export function readAskPriority(metadata: unknown): number {
  if (metadata == null || typeof metadata !== 'object') {
    return ASK_PRIORITY_DEFAULT;
  }
  const meta = metadata as {blocking?: unknown; priority?: unknown};
  if (
    typeof meta.priority === 'number' &&
    Number.isInteger(meta.priority) &&
    meta.priority >= 0 &&
    meta.priority <= 4
  ) {
    return meta.priority;
  }
  if (typeof meta.blocking === 'boolean') {
    return meta.blocking ? ASK_PRIORITY_BLOCKING : ASK_PRIORITY_DEFAULT;
  }
  return ASK_PRIORITY_DEFAULT;
}

/** Read `reportCount` back off an existing bead. Absent or odd means 0. */
export function readReportCount(metadata: unknown): number {
  if (metadata == null || typeof metadata !== 'object') return 0;
  const value = (metadata as {reportCount?: unknown}).reportCount;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}
