/**
 * Question ids like `BD7` (home-base-1rxt0.4 D4, decided by question
 * home-base-sg9q9.9, option a). Justin, 2026-11-12 (verbatim on
 * home-base-sg9q9.2): "if I answer what I think is question 5 but you
 * interpret it as question 6, there's basically no way for us to even catch
 * that … let's give each question a clear, unambiguous ID also, and I'll just
 * try to use the ID", and "`BD7` … It just needs to be fairly simple to type on
 * a phone keyboard."
 *
 * THE RULES
 * - A question gets its number once, as a label `qid:<chain root>:<n>`, and
 *   the label is never rewritten. `<chain root>` is the first session bead of
 *   its session chain (the sessions linked by `continues:` labels), so every
 *   session of one chain numbers from the same place, and a question carried
 *   over in a handoff keeps its id.
 * - `<n>` is one more than the highest number any question of the chain holds,
 *   open or closed, so an id is never reused.
 * - Part 1 shows it as `[BD<n>]` after the item number. The list keeps its
 *   priority numbering.
 * - No report shows two questions with one id. Two can share a number when
 *   they come from different chains (a request adopted with `thread request
 *   --bead`) or when two sessions of one chain filed at once. Then the one
 *   filed later shows its bead id in the brackets instead, and a line under the
 *   questions says why (questionIdsShown).
 *
 * PURE: no filesystem and no br. question-id-assign.ts reads and writes.
 */

import {parseInstant} from './answer-store';
import {BR_LABEL_MAX} from './session-bead';

/** The label that holds a question's number: `qid:<chain root>:<n>`. */
export const QUESTION_ID_LABEL_PREFIX = 'qid:';

/** What Justin types: `BD7`. */
export const SHORT_ID_PREFIX = 'BD';

/** br's label characters (session-bead.ts BR_LABEL_SHAPE, measured there). */
const BR_LABEL_SHAPE = /^[A-Za-z0-9_:-]+$/;

/**
 * The start of every id label of the chain that begins at `root`. br refuses a
 * `.` in a label, so each `.` of the id is written `:`, as `toLabel` does.
 */
export function chainLabelPrefix(root: string): string {
  return `${QUESTION_ID_LABEL_PREFIX}${root.replaceAll('.', ':')}:`;
}

/** The label for question number `number` of the chain that begins at `root`. */
export function questionIdLabelFor(
  root: string,
  number: number,
): {label: string; ok: true} | {ok: false; reason: string} {
  const label = `${chainLabelPrefix(root)}${number}`;
  if (label.length > BR_LABEL_MAX) {
    return {
      ok: false,
      reason: `its label ${label} is ${label.length} characters; br allows ${BR_LABEL_MAX}`,
    };
  }
  if (!BR_LABEL_SHAPE.test(label)) {
    return {
      ok: false,
      reason: `its label ${label} holds a character br refuses in a label`,
    };
  }
  return {label, ok: true};
}

/** `BD7`. */
export function shortIdText(number: number): string {
  return `${SHORT_ID_PREFIX}${number}`;
}

/**
 * The number in what Justin typed: `BD7`, `bd7` or `Bd7`. Null for anything
 * else, including a bare `7` or `Q7`: those are list numbers, and the rules
 * say Claude asks back rather than guess.
 */
export function parseShortId(text: string): number | null {
  const match = /^bd([1-9][0-9]*)$/i.exec(text.trim());
  if (match?.[1] == null) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) ? number : null;
}

/** A question's id, read from its labels. */
export type QuestionIdRead =
  | {kind: 'bad'; reason: string}
  | {kind: 'none'}
  | {kind: 'one'; number: number};

/**
 * The question's number. Two id labels, or one whose number cannot be read,
 * is `bad`, never a guess at one of them (critical rule 7).
 */
export function questionIdOf(labels: readonly string[]): QuestionIdRead {
  const found = [
    ...new Set(
      labels.filter((label) => label.startsWith(QUESTION_ID_LABEL_PREFIX)),
    ),
  ];
  const [only] = found;
  if (only == null) return {kind: 'none'};
  if (found.length > 1) {
    return {
      kind: 'bad',
      reason: `it carries ${found.length} id labels (${found.join(', ')})`,
    };
  }
  const match = /:([1-9][0-9]*)$/.exec(only);
  const number = match?.[1] == null ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(number)) {
    return {kind: 'bad', reason: `its id label ${only} holds no number`};
  }
  return {kind: 'one', number};
}

/**
 * The highest number the chain that begins at `root` has used, among every
 * label given (an export's labels: open and closed questions alike). 0 when
 * it has used none.
 */
export function chainMaxNumber(labels: Iterable<string>, root: string): number {
  const prefix = chainLabelPrefix(root);
  let max = 0;
  for (const label of labels) {
    if (!label.startsWith(prefix)) continue;
    const rest = label.slice(prefix.length);
    if (!/^[1-9][0-9]*$/.test(rest)) continue;
    const number = Number(rest);
    if (Number.isSafeInteger(number) && number > max) max = number;
  }
  return max;
}

/** The fields of a question these rules read. `TreeIssue` and `BrIssue` fit. */
export interface IdQuestion {
  createdAt: string | null;
  id: string;
  labels: readonly string[];
  priority: number | null;
}

/** Oldest first; by id when the times cannot order them. */
function byCreated(a: IdQuestion, b: IdQuestion): number {
  const at = parseInstant(a.createdAt);
  const bt = parseInstant(b.createdAt);
  if (at != null && bt != null && at !== bt) return at - bt;
  if (at != null && bt == null) return -1;
  if (at == null && bt != null) return 1;
  return a.id.localeCompare(b.id, 'en', {numeric: true});
}

/**
 * D4: the numbers for questions that have none, after `after` (the chain's
 * highest), in a stable order: most urgent first, then oldest first. The same
 * questions and the same `after` always give the same numbers.
 */
export function planQuestionIds(
  missing: readonly IdQuestion[],
  after: number,
): {id: string; number: number}[] {
  const rank = (priority: number | null): number => priority ?? 99;
  return [...missing]
    .sort((a, b) => {
      const byRank = rank(a.priority) - rank(b.priority);
      return byRank !== 0 ? byRank : byCreated(a, b);
    })
    .map((question, index) => ({id: question.id, number: after + index + 1}));
}

/**
 * What the brackets on a question's line hold: its short id, or its bead id
 * when its short id cannot be shown (`why` says why). Absent from the map: the
 * question has no id yet, and its line has no brackets.
 */
export type ShownId = {text: string; why: null} | {text: string; why: string};

export interface QuestionIdsShown {
  byId: ReadonlyMap<string, ShownId>;
  /** One line per question shown by its bead id, saying why. */
  notes: string[];
}

/**
 * D4's invariant: no two questions of one report show the same id. Of
 * questions that share a number, the oldest keeps it and each later one shows
 * its bead id, with a note. A question whose id cannot be read shows its bead
 * id too.
 */
export function questionIdsShown(
  questions: readonly IdQuestion[],
): QuestionIdsShown {
  const byId = new Map<string, ShownId>();
  const notes: string[] = [];
  const byNumber = new Map<number, IdQuestion[]>();
  for (const question of questions) {
    const read = questionIdOf(question.labels);
    if (read.kind === 'none') continue;
    if (read.kind === 'bad') {
      const why = `its id cannot be read: ${read.reason}`;
      byId.set(question.id, {text: question.id, why});
      notes.push(`${question.id} is shown by its bead id because ${why}.`);
      continue;
    }
    const list = byNumber.get(read.number) ?? [];
    list.push(question);
    byNumber.set(read.number, list);
  }
  for (const [number, list] of byNumber) {
    const [keeper, ...later] = [...list].sort(byCreated);
    if (keeper == null) continue;
    const text = shortIdText(number);
    byId.set(keeper.id, {text, why: null});
    for (const question of later) {
      const why = `${text} is also the id of ${keeper.id}, filed earlier`;
      byId.set(question.id, {text: question.id, why});
      notes.push(
        `${question.id} is shown by its bead id because ${why}. Answer it by its bead id.`,
      );
    }
  }
  return {byId, notes};
}
