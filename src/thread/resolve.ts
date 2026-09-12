/**
 * Which thread bead did you mean? (home-base-p1uj.2)
 *
 * Three ways to say it, one resolver, so `show`, `answer`, `inbox` and `done`
 * cannot drift into disagreeing about what `--latest` means:
 *
 *   an explicit id   `thread answer jl-e9f4`
 *   --session <id>   the thread keyed on that session (D1)
 *   neither          this session's thread, from $CLAUDE_CODE_SESSION_ID
 *   --latest         the most recently REPORTED thread, whatever session it is
 *
 * `--latest` is for Justin at a terminal, who has just been handed a report and
 * wants to answer it without copying an id out of it.
 *
 * EVERY FAILURE IS A NAMED MESSAGE, never a null that a caller could read as
 * "there are none". "No thread bead exists for this session yet" and "bd could
 * not be reached" are opposite facts, and a resolver that returned null for
 * both would let `answer` say "nothing to answer" when the truth is "I could
 * not look".
 */

import {
  bdContext,
  describeBdFailure,
  findThreadBySession,
  listThreads,
  showIssue,
  type BdContext,
  type BdIssue,
} from './bd';
import {collectThreadFacts} from './facts';

import type {EnvLike} from './paths';

export interface ThreadRef {
  cwd?: string;
  env?: EnvLike;
  /** Most recently reported thread across all sessions. */
  latest?: boolean;
  sessionId?: string | null;
  threadId?: string | null;
}

export type ThreadResolution =
  | {ok: true; issue: BdIssue}
  | {ok: false; message: string};

/** `metadata.reportedAt` as a sortable string, or null when unreadable. */
export function reportedAtOf(issue: BdIssue): string | null {
  const meta = (issue.metadata ?? {}) as {reportedAt?: unknown};
  return typeof meta.reportedAt === 'string' && meta.reportedAt !== ''
    ? meta.reportedAt
    : null;
}

export async function resolveThread(
  ctx: BdContext,
  ref: ThreadRef,
): Promise<ThreadResolution> {
  if (ref.threadId != null && ref.threadId !== '') {
    const found = await showIssue(ctx, ref.threadId);
    if (!found.ok)
      return {message: describeBdFailure(found.failure), ok: false};
    if (found.value == null)
      return {message: `no bead ${ref.threadId}`, ok: false};
    return {issue: found.value, ok: true};
  }

  if (ref.latest === true) {
    const threads = await listThreads(ctx);
    if (!threads.ok) {
      return {message: describeBdFailure(threads.failure), ok: false};
    }
    // Threads with no readable reportedAt sort LAST rather than being dropped:
    // an unreadable timestamp is not evidence the thread is uninteresting.
    const sorted = [...threads.value].sort((a, b) =>
      (reportedAtOf(b) ?? '').localeCompare(reportedAtOf(a) ?? ''),
    );
    const newest = sorted[0];
    if (newest == null) {
      return {
        message: 'no open thread beads exist — nothing has been reported yet',
        ok: false,
      };
    }
    return {issue: newest, ok: true};
  }

  const facts = collectThreadFacts({
    cwd: ref.cwd,
    env: ref.env,
    sessionId: ref.sessionId,
  });
  if (facts.sessionId == null) {
    return {
      message:
        'no session id (CLAUDE_CODE_SESSION_ID unset and neither an id, --session nor --latest was given)',
      ok: false,
    };
  }
  const found = await findThreadBySession(ctx, facts.sessionId);
  if (!found.ok) return {message: describeBdFailure(found.failure), ok: false};
  if (found.value == null) {
    return {
      message: `no thread bead for session ${facts.sessionId} — nothing has been reported yet`,
      ok: false,
    };
  }
  return {issue: found.value, ok: true};
}

/** A `BdContext` for the current environment. Re-exported so callers need one import. */
export function contextFor(env: EnvLike | undefined): BdContext {
  return bdContext(env ?? process.env);
}
