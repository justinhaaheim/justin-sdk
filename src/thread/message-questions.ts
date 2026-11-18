/**
 * Claude's message in the status report, and the question ids it names
 * (home-base-88y8m D4 and D5, built by home-base-88y8m.2).
 *
 * Justin, 2026-11-15 (verbatim on home-base-88y8m): "BD131 - I don't see BD131
 * *anywhere* in the status report, so I can't see the full context on the
 * question you're asking." So every question id the message names resolves in
 * the report:
 *  - an open question of this session is in Questions for you already, or is
 *    kept there whole when `--changes` would leave it out (`ownOpen`);
 *  - any other question, in any session or repo, this session's answered or
 *    closed questions included, is shown whole under
 *    `## Other questions the message names`, with its session, its repo and its
 *    state (a `question` item);
 *  - an id that matches nothing, matches two questions, or could not be looked
 *    up gets one line saying which (a `note` item). Never dropped, and a failed
 *    read is never said as "no such question" (critical rule 7).
 *
 * The scanner accepts `Q<n>` and `BD<n>`, any case, as whole words: the display
 * prefix is Q since home-base-88y8m D6, and older messages say BD.
 *
 * READ-ONLY. The lookup is question-id-locate.ts's, which reads every beads
 * export the sessions index knows; it runs only for an id that is not one of
 * this session's open questions.
 */

import type {EnvLike} from './paths';
import type {LocatedQuestion, LocatedQuestionId} from './question-id-locate';
import type {TreeIssue} from './session-tree';

import {answerFrom} from './answer-store';
import {
  EXPORT_MAY_TRAIL,
  locatedWords,
  locateQuestionId,
} from './question-id-locate';
import {QUESTION_NUMBER_FLOOR, questionIdOf, shortIdText} from './question-ids';

/** D5: a question id as the message writes it, and its number. */
export interface NamedQuestionId {
  number: number;
  /** As written: `Q131`, `bd131`. */
  written: string;
}

/** `Q131` or `BD131`, any case, as a whole word. */
const NAMED_ID = /\b(?:q|bd)([1-9][0-9]*)\b/giu;

/**
 * D5: the question ids in `text`, each number once, in the order the text
 * first names them.
 */
export function questionIdsNamed(text: string): NamedQuestionId[] {
  const seen = new Set<number>();
  const named: NamedQuestionId[] = [];
  for (const match of text.matchAll(NAMED_ID)) {
    const digits = match[1];
    if (digits == null) continue;
    const number = Number(digits);
    if (!Number.isSafeInteger(number) || seen.has(number)) continue;
    seen.add(number);
    named.push({number, written: match[0]});
  }
  return named;
}

/** D5: a question's state, as the report says it. */
export type NamedQuestionState =
  | {answer: string; kind: 'answered'}
  | {kind: 'closed'; reason: string | null}
  | {kind: 'open'};

export function namedQuestionState(issue: TreeIssue): NamedQuestionState {
  if (issue.status !== 'closed') return {kind: 'open'};
  const answer = answerFrom(issue.closeReason);
  if (answer != null) return {answer, kind: 'answered'};
  const reason = issue.closeReason?.trim() ?? '';
  return {kind: 'closed', reason: reason === '' ? null : reason};
}

/** One entry of `## Other questions the message names`. */
export type MessageQuestionItem =
  | {
      issue: TreeIssue;
      kind: 'question';
      repo: string;
      /** The bead it was filed under (its session bead); null when none. */
      session: {id: string; title: string | null} | null;
      /** What its brackets hold: `Q131`. */
      shortId: string;
      state: NamedQuestionState;
    }
  | {kind: 'note'; text: string};

export interface MessageQuestions {
  /**
   * Everything the message names that is not an open question of this
   * session, in the order it names them.
   */
  items: MessageQuestionItem[];
  /** The open questions of this session the message names, by bead id. */
  ownOpen: ReadonlySet<string>;
}

/** The lookup, injectable for tests; question-id-locate.ts's by default. */
export type QuestionLocator = (input: {
  env: EnvLike;
  firstDirs?: readonly string[];
  number: number;
}) => LocatedQuestionId;

function questionItem(entry: LocatedQuestion): MessageQuestionItem {
  const short = questionIdOf(entry.issue.labels);
  return {
    issue: entry.issue,
    kind: 'question',
    repo: entry.repo,
    session: entry.parent,
    shortId: short.kind === 'one' ? shortIdText(short.number) : entry.id,
    state: namedQuestionState(entry.issue),
  };
}

/**
 * D5: resolve every id `text` names. `open` is this session's open questions
 * (the model's), `firstDirs` its beads dirs, read first by the lookup.
 */
export function resolveMessageQuestions(input: {
  env: EnvLike;
  firstDirs: readonly string[];
  locate?: QuestionLocator;
  open: readonly TreeIssue[];
  text: string;
}): MessageQuestions {
  const locate = input.locate ?? locateQuestionId;
  const ownByNumber = new Map<number, string[]>();
  for (const question of input.open) {
    const read = questionIdOf(question.labels);
    if (read.kind !== 'one') continue;
    ownByNumber.set(read.number, [
      ...(ownByNumber.get(read.number) ?? []),
      question.id,
    ]);
  }
  const ownOpen = new Set<string>();
  const items: MessageQuestionItem[] = [];
  for (const named of questionIdsNamed(input.text)) {
    const own = ownByNumber.get(named.number);
    if (own != null) {
      for (const id of own) ownOpen.add(id);
      continue;
    }
    // D2 (question-ids.ts): every question id is above the floor, so a lower
    // number is a list position or an old per-chain id, never looked up.
    if (named.number <= QUESTION_NUMBER_FLOOR) {
      items.push({
        kind: 'note',
        text: `${named.written} is not looked up: every question id is above ${QUESTION_NUMBER_FLOOR}, so it is a list number or an old per-chain id.`,
      });
      continue;
    }
    let located: LocatedQuestionId;
    try {
      located = locate({
        env: input.env,
        firstDirs: input.firstDirs,
        number: named.number,
      });
    } catch (error) {
      items.push({
        kind: 'note',
        text: `⚠️ ${named.written} could not be looked up: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    const machine = located.found.filter((entry) => entry.form === 'machine');
    const problems = located.problems.join('; ');
    const [only] = machine;
    if (only != null && machine.length === 1) {
      items.push(questionItem(only));
      if (located.problems.length > 0) {
        items.push({
          kind: 'note',
          text: `⚠️ ${named.written}: some beads could not be read, so it may also be the id of a question there: ${problems}`,
        });
      }
      continue;
    }
    if (machine.length > 1) {
      items.push({
        kind: 'note',
        text: `⚠️ ${named.written} is the id of ${machine.length} questions, so none is shown: ${machine.map(locatedWords).join('; ')}`,
      });
      continue;
    }
    items.push({
      kind: 'note',
      text:
        located.problems.length > 0
          ? `⚠️ ${named.written} could not be looked up: ${problems}`
          : // home-base-88y8m.8 R3: the relay's caveat, since the lookup
            // reads exports: a question filed moments ago may not be in one.
            `⚠️ ${named.written} matches no question in any repo this Mac's sessions index knows. ${EXPORT_MAY_TRAIL} It may have been filed just now.`,
    });
  }
  return {items, ownOpen};
}
