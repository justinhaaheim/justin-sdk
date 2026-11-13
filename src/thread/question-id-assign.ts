/**
 * Question ids, the reads and writes (home-base-1rxt0.4 D4; the rules are in
 * question-ids.ts, which does no I/O).
 *
 * - `thread ask` puts the next number of the session's chain on the question
 *   in the same br write that files it (nextQuestionIdLabel).
 * - `thread status` gives each open question that has none (questions filed
 *   before ids existed, or whose number could not be worked out then) its id,
 *   once, before the report is rendered (assignMissingQuestionIds).
 *
 * Both read the export beside the session's DB: the chain is walked over it
 * (falling back to br for a predecessor it does not hold), and the chain's
 * highest number is the highest among its labels. One br run on home-base's DB
 * takes about 270 ms and `br list` of every question 14 s (measured
 * 2026-11-12), while the export is read and indexed once.
 *
 * KNOWN LIMIT: a predecessor whose questions live in another DB is walked, but
 * its numbers are not read, so a number can repeat. So can two sessions of one
 * chain filing at the same moment. Both are caught where it matters: Part 1
 * never shows one id twice (questionIdsShown).
 *
 * Nothing here is a reassuring default (critical rule 7): when the chain or
 * its numbers cannot be read, no id is written and the reason is returned.
 */

import type {ChainBeadRead} from './handoff-chain';
import type {EnvLike} from './paths';

import {brUpdate, describeBrFailed, resolveRecordedBeadsDb} from '../beads/br';
import {inboxChainReaders} from './handoff-marks';
import {chainRootOf} from './handoff-number';
import {
  chainMaxNumber,
  type IdQuestion,
  planQuestionIds,
  questionIdLabelFor,
  questionIdOf,
} from './question-ids';
import {realHandoffNumberReaders} from './session-handoff';
import {readExportIndex} from './session-tree';

export type ChainNumbers =
  | {kind: 'failed'; reason: string}
  | {kind: 'read'; max: number; root: string};

/**
 * The first session bead of `session`'s chain, and the highest question
 * number that chain has used in the export beside `beadsDir`.
 */
export function readChainNumbers(input: {
  beadsDir: string;
  env: EnvLike;
  session: {id: string; labels: readonly string[]};
}): ChainNumbers {
  const {beadsDir, env, session} = input;
  const read = readExportIndex(beadsDir);
  if (read.kind === 'failed') {
    return {
      kind: 'failed',
      reason: `the beads export could not be read: ${read.path}: ${read.reason}`,
    };
  }
  const fromExport = inboxChainReaders({
    beads: new Map([[session.id, {labels: session.labels, title: ''}]]),
    env,
    exportIndexes: new Map([[beadsDir, read]]),
    logs: new Map(),
  });
  const fromBr = realHandoffNumberReaders({
    env,
    fallbackDbs: [`${beadsDir}/beads.db`],
  });
  const root = chainRootOf(session, {
    showBead: (beadId): ChainBeadRead => {
      const shown = fromExport.showBead(beadId);
      return shown.kind === 'notFound' ? fromBr.showBead(beadId) : shown;
    },
  });
  if (root.kind === 'unknown') {
    return {
      kind: 'failed',
      reason: `where this session's chain starts is unknown: ${root.reason}`,
    };
  }
  return {
    kind: 'read',
    max: chainMaxNumber(read.index.byLabel.keys(), root.root),
    root: root.root,
  };
}

export type NextQuestionId =
  | {kind: 'label'; label: string; number: number}
  | {kind: 'none'; reason: string};

/** `thread ask`: the id label for the question about to be filed. */
export function nextQuestionIdLabel(input: {
  beadsDir: string;
  env: EnvLike;
  session: {id: string; labels: readonly string[]};
}): NextQuestionId {
  const numbers = readChainNumbers(input);
  if (numbers.kind === 'failed') {
    return {kind: 'none', reason: numbers.reason};
  }
  const number = numbers.max + 1;
  const label = questionIdLabelFor(numbers.root, number);
  return label.ok
    ? {kind: 'label', label: label.label, number}
    : {kind: 'none', reason: label.reason};
}

export interface AssignedIds {
  /** Each question given an id, with the label written. */
  assigned: {id: string; label: string; number: number}[];
  /** Why some or all of them got none, each in words. */
  problems: string[];
}

/**
 * `thread status`: give each open question in `questions` that has no id its
 * number, in the stable order of planQuestionIds, and write it. Reads nothing
 * when every question has one.
 */
export function assignMissingQuestionIds(input: {
  beadsDir: string;
  env: EnvLike;
  questions: readonly (IdQuestion & {beadsDir: string})[];
  session: {id: string; labels: readonly string[]};
  /** br update; tests inject a failing one. */
  update?: typeof brUpdate;
}): AssignedIds {
  const missing = input.questions.filter(
    (question) => questionIdOf(question.labels).kind === 'none',
  );
  if (missing.length === 0) return {assigned: [], problems: []};
  const numbers = readChainNumbers(input);
  if (numbers.kind === 'failed') {
    return {
      assigned: [],
      problems: [
        `${missing.length === 1 ? '1 question has' : `${missing.length} questions have`} no id yet: ${numbers.reason}`,
      ],
    };
  }
  const update = input.update ?? brUpdate;
  const where = new Map(
    missing.map((question) => [question.id, question.beadsDir]),
  );
  const result: AssignedIds = {assigned: [], problems: []};
  for (const planned of planQuestionIds(missing, numbers.max)) {
    const label = questionIdLabelFor(numbers.root, planned.number);
    if (!label.ok) {
      result.problems.push(`${planned.id} has no id: ${label.reason}`);
      continue;
    }
    const beadsDir = where.get(planned.id) ?? input.beadsDir;
    const db = resolveRecordedBeadsDb(beadsDir);
    if (db.kind !== 'found') {
      result.problems.push(
        `${planned.id} has no id: its beads DB in ${beadsDir} could not be found${db.kind === 'failed' ? `: ${db.reason}` : ''}`,
      );
      continue;
    }
    const written = update({db: db.db, env: input.env}, planned.id, {
      addLabels: [label.label],
    });
    if (written.kind === 'failed') {
      result.problems.push(
        `${planned.id} has no id: br could not write it: ${describeBrFailed(written)}`,
      );
      continue;
    }
    result.assigned.push({
      id: planned.id,
      label: label.label,
      number: planned.number,
    });
  }
  return result;
}
