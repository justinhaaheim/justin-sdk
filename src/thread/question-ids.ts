/**
 * Question ids like `Q107` (home-base-1rxt0.4 D4, decided by question
 * home-base-sg9q9.9, option a; numbered machine-wide since home-base-4wfoz,
 * design D2 in home-base-l2ejg.3; shown with a Q since home-base-88y8m D6).
 * Justin, 2026-11-12 (verbatim on home-base-sg9q9.2): "if I answer what I
 * think is question 5 but you interpret it as question 6, there's basically no
 * way for us to even catch that … let's give each question a clear,
 * unambiguous ID also, and I'll just try to use the ID", and "`BD7` … It just
 * needs to be fairly simple to type on a phone keyboard." Then, 2026-11-15
 * (verbatim on home-base-88y8m): "let's change the question ID's from `BD###`
 * to `Q###` going forward." And (home-base CLAUDE.md, 2026-11-12): "An id he
 * types must not be confusable with another, and an ambiguous reply gets a
 * question back, never a guess."
 *
 * THE PREFIX (home-base-88y8m D6)
 * - Every id is shown as `Q<n>`. The number is the same machine-wide counter
 *   the `BD<n>` ids came from, so BD131 and Q131 are one question.
 * - What he types is read as `Q<n>` or `BD<n>`, any case (parseShortId).
 * - A `Q<n>` at or below QUESTION_NUMBER_FLOOR is never looked up: no id was
 *   ever shown with a Q that low, and "Q7" reads like the seventh question of
 *   a list, which is exactly the mix-up ids exist to prevent. Every caller
 *   answers it with listPositionRefusal, a question back.
 * - A `BD<n>` keeps what it did before D6, an old per-chain `BD7` included.
 *
 * THE RULES (D2)
 * - A question gets its number once, as a label `qid:<n>`, and the label is
 *   never rewritten. `<n>` comes from ONE counter for the whole machine
 *   (question-counter.ts), so no two questions in any repo or session share
 *   one, and a number is never reused.
 * - The first number is above 99 and above every number any repo's export
 *   holds, so a new id never equals an old per-chain one.
 * - The OLD form, `qid:<chain root>:<n>`, numbered per session chain, gave the
 *   same id to different questions in different sessions (home-base-4wfoz:
 *   BD1, BD4 and BD7 meant six questions across two chains). It is still read
 *   (an answer may name it as `BD<n>`, and the counter's seed counts it) but
 *   never shown, and never rewritten.
 * - Part 1 shows a question's id as `[Q<n>]` after the item number, for a
 *   `qid:<n>` label only. A question without one shows no brackets; its bead
 *   id ends its line, as on every question line.
 * - No report shows two questions with one id. Should two share a number
 *   anyway (the counter cannot be the cause, but a hand-added label can), the
 *   one filed later shows its bead id in the brackets instead, and a line under
 *   the questions says why (questionIdsShown).
 *
 * PURE: no filesystem and no br. question-counter.ts and question-id-assign.ts
 * read and write.
 */

import {parseInstant} from './answer-store';

/** The start of every label that holds a question's number. */
export const QUESTION_ID_LABEL_PREFIX = 'qid:';

/** What every report shows, and what Justin types: `Q107` (D6). */
export const SHORT_ID_PREFIX = 'Q';

/**
 * The prefix before D6 (home-base-88y8m): `BD107`. Still read wherever he
 * types an id, never shown.
 */
export const OLD_SHORT_ID_PREFIX = 'BD';

/**
 * D2: every number minted is above this, so the first new id is at least
 * Q100 and never equals an old per-chain id (the highest in any export was 23
 * on 2026-11-14). D6: a `Q<n>` at or below it could be a list position, so it
 * is refused with a question back (listPositionRefusal).
 */
export const QUESTION_NUMBER_FLOOR = 99;

/** The label for question number `number` (D2's form): `qid:107`. */
export function questionIdLabel(number: number): string {
  return `${QUESTION_ID_LABEL_PREFIX}${number}`;
}

/** `Q107`. */
export function shortIdText(number: number): string {
  return `${SHORT_ID_PREFIX}${number}`;
}

/** Escapes a string for use inside a RegExp. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SHORT_ID_SHAPE = new RegExp(
  `^(${escapeRegExp(SHORT_ID_PREFIX)}|${escapeRegExp(OLD_SHORT_ID_PREFIX)})([1-9][0-9]*)$`,
  'i',
);

/** What an id Justin typed reads as (parseShortId). */
export type ShortIdRead =
  /**
   * An id to look up: `Q<n>` above the floor, or `BD<n>` at any number. `text`
   * is what he typed, its prefix upper-cased (`Q131`, `BD131`, `BD7`), for
   * every reply that names it. `prefix` says which form: only a `BD<n>` can
   * name an old per-chain id.
   */
  | {kind: 'id'; number: number; prefix: 'BD' | 'Q'; text: string}
  /**
   * D6: a `Q<n>` at or below QUESTION_NUMBER_FLOOR. No id was ever shown that
   * low with a Q, so it could be a position in a list. Never a number to look
   * up: every caller replies with listPositionRefusal and records nothing.
   */
  | {kind: 'listPosition'; number: number; text: string};

/**
 * What Justin typed, read as a question id: `Q107`, `q107`, `BD107`, `bd107`
 * (D6). A `Q<n>` at or below the floor is `listPosition`, never a number.
 * Null for anything else, a bare `7` included: not an id, so the caller treats
 * it as a bead id or refuses it.
 */
export function parseShortId(text: string): ShortIdRead | null {
  const match = SHORT_ID_SHAPE.exec(text.trim());
  const typed = match?.[1];
  const digits = match?.[2];
  if (typed == null || digits == null) return null;
  const number = Number(digits);
  if (!Number.isSafeInteger(number)) return null;
  const prefix =
    typed.toUpperCase() === SHORT_ID_PREFIX
      ? SHORT_ID_PREFIX
      : OLD_SHORT_ID_PREFIX;
  const shown = `${prefix}${digits}`;
  if (prefix === SHORT_ID_PREFIX && number <= QUESTION_NUMBER_FLOOR) {
    return {kind: 'listPosition', number, text: shown};
  }
  return {kind: 'id', number, prefix, text: shown};
}

/**
 * D6: the reply to a `Q<n>` that could be a list position (`text` is what he
 * typed, `Q7`). It says why, records nothing, and asks which id he means:
 * never a guess (home-base CLAUDE.md, "an ambiguous reply gets a question
 * back").
 */
export function listPositionRefusal(text: string): string {
  return `${text} could be a position in a list, not a question id, so nothing was recorded. Every question id is Q followed by a number above ${QUESTION_NUMBER_FLOOR}. Which question did you mean? Answer with the id shown in brackets on its line in the report, for example ${shortIdText(131)}, or with its bead id.`;
}

/** One `qid:` label, read. */
export type ParsedQuestionIdLabel =
  /** The old per-chain form, `qid:<chain root>:<n>`: read, never shown. */
  | {form: 'chain'; number: number; root: string}
  /** D2's form, `qid:<n>`. */
  | {form: 'machine'; number: number}
  /** Starts with `qid:` and holds no number either form can read. */
  | {form: 'unreadable'};

/** br's label characters (session-bead.ts BR_LABEL_SHAPE, measured there). */
const BR_LABEL_CHARS = /^[A-Za-z0-9_:-]+$/;

/**
 * Reads one label in either form. Null when it is not a `qid:` label at all.
 * A chain root is written with each `.` as `:` (br refuses a `.` in a label),
 * so `qid:t-abc:2:7` is number 7 of the chain that begins at `t-abc.2`.
 */
export function parseQuestionIdLabel(
  label: string,
): ParsedQuestionIdLabel | null {
  if (!label.startsWith(QUESTION_ID_LABEL_PREFIX)) return null;
  const rest = label.slice(QUESTION_ID_LABEL_PREFIX.length);
  if (!BR_LABEL_CHARS.test(rest)) return {form: 'unreadable'};
  const machine = /^([1-9][0-9]*)$/.exec(rest);
  if (machine?.[1] != null) {
    const number = Number(machine[1]);
    return Number.isSafeInteger(number)
      ? {form: 'machine', number}
      : {form: 'unreadable'};
  }
  const chain = /^(.*[^:]):([1-9][0-9]*)$/.exec(rest);
  if (chain?.[1] != null && chain[2] != null) {
    const number = Number(chain[2]);
    return Number.isSafeInteger(number)
      ? {form: 'chain', number, root: chain[1]}
      : {form: 'unreadable'};
  }
  return {form: 'unreadable'};
}

/** A question's D2 id, read from its labels. */
export type QuestionIdRead =
  | {kind: 'bad'; reason: string}
  | {kind: 'none'}
  | {kind: 'one'; number: number};

/**
 * The question's D2 number (`qid:<n>`). Old per-chain labels are not read
 * here: a question that holds only one has no id, and `thread status` gives it
 * one. Two D2 labels, or a `qid:` label that holds no number, is `bad`, never
 * a guess at one of them (critical rule 7).
 */
export function questionIdOf(labels: readonly string[]): QuestionIdRead {
  const numbers = new Set<number>();
  const unreadable: string[] = [];
  for (const label of new Set(labels)) {
    const parsed = parseQuestionIdLabel(label);
    if (parsed == null || parsed.form === 'chain') continue;
    if (parsed.form === 'unreadable') unreadable.push(label);
    else numbers.add(parsed.number);
  }
  const [only] = unreadable;
  if (only != null) {
    return {kind: 'bad', reason: `its id label ${only} holds no number`};
  }
  const [number] = numbers;
  if (number == null) return {kind: 'none'};
  if (numbers.size > 1) {
    return {
      kind: 'bad',
      reason: `it carries ${numbers.size} id labels (${[...numbers].map(questionIdLabel).join(', ')})`,
    };
  }
  return {kind: 'one', number};
}

/**
 * The numbers a question's OLD per-chain labels give it (`qid:<root>:<n>`).
 * Only `thread answer` reads these: an id from a report printed before D2
 * still answers inside its own session when it names one question there.
 */
export function chainNumbersOf(labels: readonly string[]): number[] {
  const numbers = new Set<number>();
  for (const label of labels) {
    const parsed = parseQuestionIdLabel(label);
    if (parsed?.form === 'chain') numbers.add(parsed.number);
  }
  return [...numbers];
}

/**
 * The highest number any label holds, in either form (an export's labels:
 * open and closed questions alike). 0 when none does. The counter's seed
 * (question-counter.ts) starts above it.
 */
export function maxQuestionNumber(labels: Iterable<string>): number {
  let max = 0;
  for (const label of labels) {
    const parsed = parseQuestionIdLabel(label);
    if (parsed == null || parsed.form === 'unreadable') continue;
    if (parsed.number > max) max = parsed.number;
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
 * Which of the numbers `numbers` (reserved from the counter, in order) each
 * question that has none gets, in a stable order: most urgent first, then
 * oldest first. Questions beyond the numbers given get none.
 */
export function planQuestionIds(
  missing: readonly IdQuestion[],
  numbers: readonly number[],
): {id: string; number: number}[] {
  const rank = (priority: number | null): number => priority ?? 99;
  const planned: {id: string; number: number}[] = [];
  [...missing]
    .sort((a, b) => {
      const byRank = rank(a.priority) - rank(b.priority);
      return byRank !== 0 ? byRank : byCreated(a, b);
    })
    .forEach((question, index) => {
      const number = numbers[index];
      if (number != null) planned.push({id: question.id, number});
    });
  return planned;
}

/**
 * What the brackets on a question's line hold: its short id, or its bead id
 * when its short id cannot be shown (`why` says why). Absent from the map: the
 * question has no D2 id, and its line has no brackets.
 */
export type ShownId = {text: string; why: null} | {text: string; why: string};

export interface QuestionIdsShown {
  byId: ReadonlyMap<string, ShownId>;
  /** One line per question shown by its bead id, saying why. */
  notes: string[];
}

/**
 * The invariant: no two questions of one report show the same id. Of
 * questions that share a number, the oldest keeps it and each later one shows
 * its bead id, with a note. A question whose id cannot be read shows its bead
 * id too. Only D2 ids are shown (questionIdOf).
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
