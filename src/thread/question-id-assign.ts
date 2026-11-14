/**
 * Question ids, the reads and writes (home-base-1rxt0.4 D4, numbered
 * machine-wide by home-base-4wfoz D2; the rules are in question-ids.ts, which
 * does no I/O, and the counter in question-counter.ts).
 *
 * - `thread ask` puts a new number on the question in the same br write that
 *   files it (nextQuestionIdLabel).
 * - `thread status` gives each open question of the session that has no D2 id
 *   (filed before D2, even when it holds an old per-chain id, or whose number
 *   could not be handed out then) its id, once, before the report is rendered
 *   (assignMissingQuestionIds).
 *
 * Nothing here is a reassuring default (critical rule 7): when the counter
 * cannot hand out numbers, no id is written and the reason is returned. The
 * question then shows its bead id. Nothing here throws: both run on the hot
 * path of `thread ask` and `thread status`.
 */

import type {EnvLike} from './paths';

import {brUpdate, describeBrFailed, resolveRecordedBeadsDb} from '../beads/br';
import {probeErrorMessage} from './paths';
import {reserveQuestionNumbers} from './question-counter';
import {
  type IdQuestion,
  planQuestionIds,
  questionIdLabel,
  questionIdOf,
} from './question-ids';

export type NextQuestionId =
  | {kind: 'label'; label: string; number: number}
  | {kind: 'none'; reason: string};

/** `thread ask`: the id label for the question about to be filed. */
export function nextQuestionIdLabel(input: {
  beadsDir: string;
  env: EnvLike;
  /** The counter; tests inject a failing one. */
  reserve?: typeof reserveQuestionNumbers;
}): NextQuestionId {
  const reserve = input.reserve ?? reserveQuestionNumbers;
  let reserved: ReturnType<typeof reserveQuestionNumbers>;
  try {
    reserved = reserve({beadsDirs: [input.beadsDir], count: 1, env: input.env});
  } catch (error) {
    return {
      kind: 'none',
      reason: `the question counter threw: ${probeErrorMessage(error)}`,
    };
  }
  if (reserved.kind === 'failed') {
    return {kind: 'none', reason: reserved.reason};
  }
  const [number] = reserved.numbers;
  if (number == null) {
    return {kind: 'none', reason: 'the question counter handed out no number'};
  }
  return {kind: 'label', label: questionIdLabel(number), number};
}

export interface AssignedIds {
  /** Each question given an id, with the label written. */
  assigned: {id: string; label: string; number: number}[];
  /** Why some or all of them got none, each in words. */
  problems: string[];
}

export interface AssignInput {
  beadsDir: string;
  env: EnvLike;
  questions: readonly (IdQuestion & {beadsDir: string})[];
  /** The counter; tests inject a failing one. */
  reserve?: typeof reserveQuestionNumbers;
  /** br update; tests inject a failing one. */
  update?: typeof brUpdate;
}

/** assignMissingQuestionIds without its catch-all. */
function assign(input: AssignInput): AssignedIds {
  const missing = input.questions.filter(
    (question) => questionIdOf(question.labels).kind === 'none',
  );
  if (missing.length === 0) return {assigned: [], problems: []};
  const reserve = input.reserve ?? reserveQuestionNumbers;
  const reserved = reserve({
    beadsDirs: [
      ...new Set([input.beadsDir, ...missing.map((q) => q.beadsDir)]),
    ],
    count: missing.length,
    env: input.env,
  });
  if (reserved.kind === 'failed') {
    return {
      assigned: [],
      problems: [
        `${missing.length === 1 ? '1 question has' : `${missing.length} questions have`} no id yet, so ${missing.length === 1 ? 'it is' : 'they are'} shown by bead id: ${reserved.reason}`,
      ],
    };
  }
  const update = input.update ?? brUpdate;
  const where = new Map(
    missing.map((question) => [question.id, question.beadsDir]),
  );
  const result: AssignedIds = {assigned: [], problems: []};
  // One line per distinct reason, naming every question it stopped: the same
  // br failure for four questions is one problem, said once.
  const failedBy = new Map<string, string[]>();
  const fail = (id: string, reason: string): void => {
    failedBy.set(reason, [...(failedBy.get(reason) ?? []), id]);
  };
  // A number whose write fails is not handed out again: the counter never
  // goes back, so it is simply unused.
  for (const planned of planQuestionIds(missing, reserved.numbers)) {
    const label = questionIdLabel(planned.number);
    const beadsDir = where.get(planned.id) ?? input.beadsDir;
    const db = resolveRecordedBeadsDb(beadsDir);
    if (db.kind !== 'found') {
      fail(
        planned.id,
        `its beads DB in ${beadsDir} could not be found${db.kind === 'failed' ? `: ${db.reason}` : ''}`,
      );
      continue;
    }
    const written = update({db: db.db, env: input.env}, planned.id, {
      addLabels: [label],
    });
    if (written.kind === 'failed') {
      fail(
        planned.id,
        `br could not write the id label: ${describeBrFailed(written)}`,
      );
      continue;
    }
    result.assigned.push({id: planned.id, label, number: planned.number});
  }
  for (const [reason, ids] of failedBy) {
    result.problems.push(
      `${ids.join(', ')} ${ids.length === 1 ? 'has' : 'have'} no id, so ${ids.length === 1 ? 'it is' : 'they are'} shown by bead id: ${reason}`,
    );
  }
  return result;
}

/**
 * `thread status`: give each open question in `questions` that has no D2 id
 * its number, in the stable order of planQuestionIds, and write it. Touches
 * nothing when every question has one. Never throws.
 */
export function assignMissingQuestionIds(input: AssignInput): AssignedIds {
  try {
    return assign(input);
  } catch (error) {
    return {
      assigned: [],
      problems: [
        `question ids could not be given: ${probeErrorMessage(error)}`,
      ],
    };
  }
}
