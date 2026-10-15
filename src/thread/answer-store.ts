/**
 * Where Justin's answers live, and which are new (status report v4, epic
 * home-base-vzwbj.4 D1/D3; built by home-base-vzwbj.4.2).
 *
 * An answer is the question bead's CLOSE REASON, `answer: <his text>` (or
 * `answer: default taken — <default>`), written by `thread answer`. Never a
 * comment: critical rule 3.2 — comments are invisible to `br show` and
 * `br list`, which is how the old thread module's answers went unseen.
 *
 * "New" means NOT YET DELIVERED to Claude (home-base-vzwbj.4.9 R1): answered,
 * and not in the session's delivered marker (`answers-delivered/<session
 * id>.json`, a list of question ids written by the prompt-time line and by
 * `thread answers` once they have shown it). It used to mean "closed after the
 * last yield", which lost an answer Justin recorded while Claude was mid-turn:
 * the yield after it moved past the close time before anything showed it.
 *
 * Small and import-light on purpose — the prompt hook (session-line.ts) uses
 * it on every prompt.
 */

import type {EnvLike} from './paths';

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'fs';
import {dirname} from 'path';

import {answersDeliveredPath} from './archive';
import {ANSWER_PREFIX, ASK_LABEL, QUESTION_BEAD_TYPE} from './ask-format';
import {probeErrorMessage} from './paths';

/** Justin's answer, verbatim, or null when the close reason is not an answer. */
export function answerFrom(closeReason: string | null): string | null {
  if (closeReason == null) return null;
  if (!closeReason.startsWith(ANSWER_PREFIX)) return null;
  return closeReason.slice(ANSWER_PREFIX.length);
}

/**
 * An ISO-8601 instant as epoch ms, or null when it is not one. br writes
 * microseconds (`…18.229905Z`) and the message log milliseconds; the fraction
 * is cut to milliseconds first so the comparison never depends on how far a
 * runtime's Date.parse reads past three digits.
 */
export function parseInstant(text: string | null): number | null {
  if (text == null) return null;
  const normal = text.trim().replace(/(\.\d{3})\d+/, '$1');
  const ms = Date.parse(normal);
  return Number.isNaN(ms) ? null : ms;
}

/** The fields of a bead this module reads (a `BrIssue` or an export record). */
export interface AnswerableIssue {
  closeReason: string | null;
  closedAt: string | null;
  id: string;
  issueType: string | null;
  labels: readonly string[];
  status: string | null;
}

/**
 * The delivered marker (R1). `missing` is a measured "nothing shown yet";
 * `failed` is not, and every answer counts as new then (the cautious
 * direction is a repeat, never a loss).
 */
export type DeliveredAnswers =
  | {ids: ReadonlySet<string>; kind: 'read'; path: string}
  | {kind: 'failed'; path: string; reason: string}
  | {kind: 'missing'; path: string};

export function readDeliveredAnswers(
  sessionId: string,
  env: EnvLike,
): DeliveredAnswers {
  const path = answersDeliveredPath(sessionId, env);
  if (!existsSync(path)) return {kind: 'missing', path};
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return {
      kind: 'failed',
      path,
      reason: `could not read the delivered-answers marker ${path}: ${probeErrorMessage(error)}`,
    };
  }
  if (
    !Array.isArray(value) ||
    !value.every((entry): entry is string => typeof entry === 'string')
  ) {
    return {
      kind: 'failed',
      path,
      reason: `the delivered-answers marker ${path} is not a list of ids`,
    };
  }
  return {ids: new Set(value), kind: 'read', path};
}

/**
 * Add `ids` to the delivered marker (a union with what is there; write to a
 * temp file, then rename). A marker that could not be read is REPLACED by
 * these ids: its old ids are unknown, and losing them only repeats an answer.
 */
export function markAnswersDelivered(
  sessionId: string,
  ids: readonly string[],
  env: EnvLike,
): {kind: 'failed'; reason: string} | {kind: 'written'; path: string} {
  const path = answersDeliveredPath(sessionId, env);
  if (ids.length === 0) return {kind: 'written', path};
  const before = readDeliveredAnswers(sessionId, env);
  const all = new Set(before.kind === 'read' ? before.ids : []);
  for (const id of ids) all.add(id);
  try {
    mkdirSync(dirname(path), {recursive: true});
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify([...all].sort())}\n`);
    renameSync(temp, path);
  } catch (error) {
    return {
      kind: 'failed',
      reason: `could not write the delivered-answers marker ${path}: ${probeErrorMessage(error)}`,
    };
  }
  return {kind: 'written', path};
}

/** A question closed with an answer, whenever. */
export function isAnswered(issue: AnswerableIssue): boolean {
  return (
    issue.issueType === QUESTION_BEAD_TYPE &&
    issue.labels.includes(ASK_LABEL) &&
    issue.status === 'closed' &&
    answerFrom(issue.closeReason) != null
  );
}

/** Answered and not yet shown to Claude (R1). */
export function isUndelivered(
  issue: AnswerableIssue,
  delivered: DeliveredAnswers,
): boolean {
  if (!isAnswered(issue)) return false;
  return delivered.kind !== 'read' || !delivered.ids.has(issue.id);
}
