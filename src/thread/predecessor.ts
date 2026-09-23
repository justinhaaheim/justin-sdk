/**
 * Which thread does this session CONTINUE, when nobody typed an id?
 * (home-base-k0b8n.5, epic home-base-1r6d.33 D18.)
 *
 * `continuesFrom` takes a THREAD BEAD id, and a justin-loop successor has no way
 * to know one: what the runner can hand it is its predecessor's CLAUDE SESSION
 * id, on the dispatch environment. This module is the bridge — session id in,
 * thread bead id out — shared by `thread prepare` and `thread report` so the two
 * cannot disagree about what a missing predecessor means.
 *
 * THE THREE OUTCOMES ARE THREE FACTS (critical rule 7), and the whole point of
 * the file is that they never collapse into two:
 *
 *   found          the predecessor reported; link to its thread.
 *   notFound       bd was READ, and it holds no thread for that session — the
 *                  ordinary case where the predecessor never reported. Proceed
 *                  UNLINKED, saying so.
 *   lookupFailed   bd could not be read at all. Nothing was measured about the
 *                  predecessor. Proceed UNLINKED, saying so DIFFERENTLY.
 *
 * Neither miss is a refusal. `refusedContinuation` in `thread report` stays
 * reserved for an EXPLICIT `continuesFrom` naming a bad bead — there, a typo
 * would silently swallow the asks the feature exists to carry, so refusing is
 * right. Here the id was never typed by anyone, and refusing a status report
 * because a predecessor could not be looked up would throw away the report to
 * protect a link.
 */

import type {BdContext, BdIssue} from './bd';
import type {EnvLike} from './paths';
import type {ThreadReportPayload} from './schema';

import {
  PREDECESSOR_SESSION_ENV,
  predecessorSessionIdFromEnv,
} from '../justin-loop/predecessor-env';
import {describeBdFailure, findThreadBySession} from './bd';

export {PREDECESSOR_SESSION_ENV};

export type PredecessorLink =
  /** Nobody named a predecessor session — not the flag, not the environment. */
  | {kind: 'none'}
  | {issue: BdIssue; kind: 'found'; sessionId: string; threadId: string}
  | {kind: 'notFound'; line: string; sessionId: string}
  | {kind: 'lookupFailed'; line: string; sessionId: string};

/**
 * The predecessor SESSION id in force, or null.
 *
 * `--continues-from-session` wins over the environment, because a flag is
 * someone saying it on purpose and the variable is the runner saying it
 * automatically. Both are trimmed to null when empty: "" is not a session id.
 */
export function predecessorSessionId(
  explicit: string | null | undefined,
  env: EnvLike,
): string | null {
  if (explicit != null && explicit.trim() !== '') return explicit.trim();
  return predecessorSessionIdFromEnv(env);
}

/** The line a miss prints. Exported so both commands print the same words. */
export function notFoundLine(sessionId: string): string {
  return `predecessor session ${sessionId} has no thread bead — not linked (it never reported one)`;
}

/** The line an UNREADABLE lookup prints. Deliberately not the one above. */
export function lookupFailedLine(sessionId: string, detail: string): string {
  return `could not look up predecessor session ${sessionId} — ${detail} — not linked (this is a failed lookup, NOT a predecessor without a thread)`;
}

/**
 * Resolve the predecessor session id in force to its thread bead.
 *
 * Returns `none` when nothing named a predecessor, so a caller can tell "there
 * was nothing to do" from "there was something to do and it did not work" —
 * they print differently and only one of them is worth a line.
 */
export async function resolvePredecessor(options: {
  ctx: BdContext;
  env: EnvLike;
  explicit?: string | null;
}): Promise<PredecessorLink> {
  const sessionId = predecessorSessionId(options.explicit, options.env);
  if (sessionId == null) return {kind: 'none'};

  const found = await findThreadBySession(options.ctx, sessionId);
  if (!found.ok) {
    return {
      kind: 'lookupFailed',
      line: lookupFailedLine(sessionId, describeBdFailure(found.failure)),
      sessionId,
    };
  }
  const issue = found.value;
  if (issue == null) {
    return {kind: 'notFound', line: notFoundLine(sessionId), sessionId};
  }
  return {issue, kind: 'found', sessionId, threadId: issue.id};
}

/**
 * The thread bead id to link to, or null — with the one line to print about it.
 *
 * `explicitContinuesFrom` WINS over anything resolved here, and when it is
 * present nothing is looked up at all: a typed `--continues-from` is the
 * strongest statement there is, and resolving underneath it would spend a bd
 * call to produce a value that is thrown away.
 */
export function applyPredecessor(
  explicitContinuesFrom: string | null | undefined,
  link: PredecessorLink,
): {continuesFrom: string | null; note: string | null} {
  if (explicitContinuesFrom != null && explicitContinuesFrom.trim() !== '') {
    return {
      continuesFrom: explicitContinuesFrom.trim(),
      note:
        link.kind === 'none'
          ? null
          : `continuesFrom was given explicitly — the predecessor session (${link.sessionId}) was not used`,
    };
  }
  switch (link.kind) {
    case 'found':
      return {
        continuesFrom: link.threadId,
        note: `continuesFrom ${link.threadId}, resolved from predecessor session ${link.sessionId}`,
      };
    case 'notFound':
    case 'lookupFailed':
      return {continuesFrom: null, note: link.line};
    case 'none':
      return {continuesFrom: null, note: null};
  }
}

/**
 * The same resolution, for a payload being replayed from the SPOOL (F9).
 *
 * `thread report` resolves the predecessor from the flag or the environment, and
 * does it AFTER the archive — so a report that bd refused and that is drained
 * later has no environment left to read. The archived payload carries
 * `continuesFromSession` instead, stamped before any bd call, and this is where
 * that id finally becomes a link.
 *
 * THE ENVIRONMENT IS DELIBERATELY NOT CONSULTED HERE. A drain runs in whatever
 * session happens to be draining, and that session may have a predecessor of its
 * OWN: reading the ambient variable would link someone else's report to this
 * draining session's predecessor — a fabricated fact, and a quiet one. The
 * archived id or nothing.
 *
 * A payload that already carries `continuesFrom` is returned untouched: an
 * explicit link always wins, exactly as it does live.
 */
export async function linkArchivedPredecessor(
  payload: ThreadReportPayload,
  ctx: BdContext,
): Promise<{note: string | null; payload: ThreadReportPayload}> {
  const explicit = payload.continuesFrom;
  if (explicit != null && explicit.trim() !== '') {
    return {note: null, payload};
  }
  const sessionId = payload.continuesFromSession;
  if (sessionId == null || sessionId.trim() === '') {
    return {note: null, payload};
  }
  const link = await resolvePredecessor({
    ctx,
    // Empty on purpose — see above. `explicit` here is the ARCHIVED id, not a
    // flag anybody typed now.
    env: {},
    explicit: sessionId,
  });
  const applied = applyPredecessor(null, link);
  return applied.continuesFrom == null
    ? {note: applied.note, payload}
    : {
        note: applied.note,
        payload: {...payload, continuesFrom: applied.continuesFrom},
      };
}
