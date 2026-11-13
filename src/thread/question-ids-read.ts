/**
 * The ids a session's report shows for its open questions, read the way the
 * report reads them (home-base-1rxt0.4 D4; moved out of session-answer.ts by
 * home-base-sg9q9.11 F4).
 *
 * Two commands must agree with the report, and both go through here:
 * - `thread answer --ask BD7` answers the open question the report shows as
 *   `BD7` (session-answer.ts resolveShortId).
 * - `thread ask` prints what the report will show for the question it just
 *   filed (ask.ts). It used to print the number it wrote, which on a shared
 *   number is the OLDER question's id in the report, so relaying it would
 *   have answered the wrong question.
 *
 * Nothing here guesses (critical rule 7): an export that cannot be read is
 * `unreadable`, never a report with fewer questions.
 */

import type {IdQuestion, QuestionIdsShown} from './question-ids';
import type {FoundSession} from './session-select';
import type {TreeIssue} from './session-tree';

import {sortAsks} from './ask-render';
import {questionIdsShown} from './question-ids';
import {isOpen} from './session-status';
import {readSessionTree} from './session-tree';

export type ShownQuestionIdsRead =
  | {kind: 'read'; open: TreeIssue[]; shown: QuestionIdsShown}
  | {kind: 'unreadable'; problems: string[]};

/**
 * The session's open questions, most urgent first, and the id the report
 * shows for each (questionIdsShown). `include` is a question just filed: it is
 * counted even when the export does not hold it yet, so a lagging export
 * cannot hide a shared number. `open` holds only what the export holds.
 */
export function readShownQuestionIds(input: {
  include?: IdQuestion | null;
  session: FoundSession;
}): ShownQuestionIdsRead {
  const {include, session} = input;
  // The questions the report reads, the same way (the export beside each DB
  // the sessions index names), so an id means what the report showed. A
  // `br list` of them took 17 s on home-base's DB (measured 2026-11-12).
  const tree = readSessionTree({
    beadsDirs: [
      ...new Set([
        session.beadsDir,
        ...session.sightings.map((entry) => entry.beadsDir),
      ]),
    ],
    sessionBeadId: session.bead.id,
    sessionId: session.sessionId,
  });
  if (tree.problems.length > 0) {
    return {kind: 'unreadable', problems: tree.problems};
  }
  const open = sortAsks(tree.questions.filter(isOpen));
  const counted: readonly IdQuestion[] =
    include == null || open.some((question) => question.id === include.id)
      ? open
      : [...open, include];
  return {kind: 'read', open, shown: questionIdsShown(counted)};
}
