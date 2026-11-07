/**
 * The one spelling of a session's name: "[MAYOR] [TAG] H1 <title>"
 * (home-base-j8q3e.5 D1; the marks are home-base-6n7my.2 D1 and D2). Plain text,
 * no markdown escaping and no truncation: callers that render markdown wrap it
 * in tildeText themselves, and the cmux workspace name uses it as it is.
 *
 * The marks go in front because a name is cut from the end. Without marks the
 * name is "[TAG] <title>", which is what every caller that passes none shows.
 *
 * `repoTag` is the RESOLVED tag (home-base-bomy5.7.1): the repo's declared
 * `projectTag`, else its folder name uppercased — `resolveRepoTag` in
 * config.ts decides it, from the session's own checkout, and the session model
 * and the inbox card carry it as `repoTag`. Never pass a plain repo name here.
 * Null means the repo itself is unknown. `text` is the title, or, for the
 * untracked one-liner, his first message.
 */

import {
  CONTINUES_LABEL_PREFIX,
  HANDOFF_NUMBER_LABEL_PREFIX,
  MAYOR_ROLE_LABEL,
} from './session-bead';

/**
 * What a name shows in front of the title.
 *
 * `handoff`: a number shows `H<N>`, null shows nothing (a first session), and
 * 'unknown' shows `H?`: the session is known to continue another and its number
 * cannot be established. A broken chain must never look like a first session
 * (critical rules, section 7), so unknown is its own member and never 0 or null.
 */
export interface SessionMarks {
  handoff: 'unknown' | number | null;
  mayor: boolean;
}

export const NO_MARKS: SessionMarks = {handoff: null, mayor: false};

/** What a bead's `handoff-number:` labels say, from the labels alone. */
export type StampedHandoffNumber =
  | {kind: 'none'}
  | {kind: 'number'; number: number}
  /** More than one label, or one that is not a whole number from 1. */
  | {kind: 'unreadable'; reason: string};

export function stampedHandoffNumber(
  labels: readonly string[],
): StampedHandoffNumber {
  const stamps = labels.filter((label) =>
    label.startsWith(HANDOFF_NUMBER_LABEL_PREFIX),
  );
  const [only] = stamps;
  if (only == null) return {kind: 'none'};
  if (stamps.length > 1) {
    return {
      kind: 'unreadable',
      reason: `the bead has ${stamps.length} ${HANDOFF_NUMBER_LABEL_PREFIX} labels (${stamps.join(', ')})`,
    };
  }
  const text = only.slice(HANDOFF_NUMBER_LABEL_PREFIX.length);
  // Number('') is 0, so the shape is checked before the value (rule 7).
  if (!/^[1-9]\d*$/u.test(text)) {
    return {kind: 'unreadable', reason: `the label ${only} is not a number`};
  }
  return {kind: 'number', number: Number(text)};
}

/**
 * D2: the marks, from labels alone. Title code never walks a chain: a number
 * label gives its number, `continues:` with none gives unknown, neither gives no
 * mark.
 */
export function sessionMarksOf(labels: readonly string[]): SessionMarks {
  const mayor = labels.includes(MAYOR_ROLE_LABEL);
  const stamped = stampedHandoffNumber(labels);
  if (stamped.kind === 'number') return {handoff: stamped.number, mayor};
  if (stamped.kind === 'unreadable') return {handoff: 'unknown', mayor};
  const continues = labels.some((label) =>
    label.startsWith(CONTINUES_LABEL_PREFIX),
  );
  return {handoff: continues ? 'unknown' : null, mayor};
}

export function sessionDisplayName(
  repoTag: string | null,
  text: string,
  marks: SessionMarks = NO_MARKS,
): string {
  const mayor = marks.mayor ? '[MAYOR] ' : '';
  const handoff =
    marks.handoff == null
      ? ''
      : `H${marks.handoff === 'unknown' ? '?' : marks.handoff} `;
  return `${mayor}[${repoTag ?? 'UNKNOWN REPO'}] ${handoff}${text}`;
}

/** A session name used as a tab title or a Claude Code session name is cut here. */
export const SESSION_NAME_LIMIT = 80;

/**
 * What ends a cut name (home-base-pz6gc): plain ASCII. `…` arrived corrupted in
 * Claude Code's session list and `custom-title` records on 2026-11-06, which
 * also stopped SendMessage reaching those sessions. Which layer corrupts it is
 * inferred, not measured: the name is typed into a pane.
 */
const NAME_CUT_MARK = '...';

/**
 * home-base-mbnjv.3 item 6: the name a successor's --name, --remote-control
 * name and tab title use, sessionDisplayName cut to SESSION_NAME_LIMIT
 * characters. Same `repoTag` contract as sessionDisplayName. The workspace name
 * is the uncut sessionDisplayName (it was before this), so a title past the
 * limit is cut in the tab and whole in the workspace.
 *
 * Characters are code points, so a cut name is exactly SESSION_NAME_LIMIT long
 * and the cut never leaves half a surrogate pair. A `…` already in the title
 * goes too, for the reason above.
 */
export function sessionName(
  repoTag: string | null,
  text: string,
  marks: SessionMarks = NO_MARKS,
): string {
  const full = sessionDisplayName(repoTag, text, marks)
    .trimEnd()
    .replaceAll('…', NAME_CUT_MARK);
  const characters = Array.from(full);
  return characters.length > SESSION_NAME_LIMIT
    ? `${characters.slice(0, SESSION_NAME_LIMIT - NAME_CUT_MARK.length).join('')}${NAME_CUT_MARK}`
    : full;
}
