/**
 * The one spelling of a session's name: "[MAYOR][TAG][#7] <title>"
 * (home-base-1rxt0.2 D1; the name is home-base-j8q3e.5 D1, the marks
 * home-base-6n7my.2 D1 and D2). Until 2026-11-12 it was spelled
 * "[MAYOR] [TAG] H7 <title>". sessionNameParts is the one builder and
 * parseSessionName the one parser, which reads both spellings (1rxt0.2 D2, D3):
 * no other code spells a mark. Plain text, no markdown escaping and no
 * truncation: callers that render markdown wrap it in tildeText themselves, and
 * the cmux workspace name uses it as it is.
 *
 * The marks go in front because a name is cut from the end. Without marks the
 * name is "[TAG] <title>", which is what every caller that passes none shows,
 * and which both spellings share.
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
 * `handoff`: a number shows `[#N]`, null shows nothing (a first session), and
 * 'unknown' shows `[#?]`: the session is known to continue another and its
 * number cannot be established. A broken chain must never look like a first
 * session (critical rules, section 7), so unknown is its own member and never 0
 * or null.
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

/** The mark of a mayor session, first in its name. */
export const MAYOR_MARK = '[MAYOR]';

/** The tag a name shows when the repo is unknown (repoTag null). */
const UNKNOWN_REPO_TAG = 'UNKNOWN REPO';

/**
 * 1rxt0.2 D4: a handoff number as the reader sees it, inside a name's bracket
 * and in prose ("#2 handed off to #3"): `#7`, or `#?` when it cannot be
 * established. The `handoff-number:` label on beads is not this: it stays a bare
 * number.
 */
export function handoffNumberText(handoff: 'unknown' | number): string {
  return `#${handoff === 'unknown' ? '?' : String(handoff)}`;
}

/**
 * A name in three parts, so the threads dashboard can colour the tag alone:
 * `before` is the mayor mark or '', `tag` is "[TAG]", and `after` is the number
 * bracket (or nothing), one space and the text. Joined, they are
 * sessionDisplayName.
 */
export interface SessionNameParts {
  after: string;
  before: string;
  tag: string;
}

/** 1rxt0.2 D2: the one builder of a session's marks. */
export function sessionNameParts(
  repoTag: string | null,
  text: string,
  marks: SessionMarks = NO_MARKS,
): SessionNameParts {
  const number =
    marks.handoff == null ? '' : `[${handoffNumberText(marks.handoff)}]`;
  return {
    after: `${number} ${text}`,
    before: marks.mayor ? MAYOR_MARK : '',
    tag: `[${repoTag ?? UNKNOWN_REPO_TAG}]`,
  };
}

export function sessionDisplayName(
  repoTag: string | null,
  text: string,
  marks: SessionMarks = NO_MARKS,
): string {
  const parts = sessionNameParts(repoTag, text, marks);
  return `${parts.before}${parts.tag}${parts.after}`;
}

/** What parseSessionName reads from a name. */
export interface ParsedSessionName {
  marks: SessionMarks;
  /** The tag without its brackets; null for "[UNKNOWN REPO]", as the builder takes it. */
  repoTag: string | null;
  /**
   * 'current' is "[MAYOR][TAG][#7] …"; 'old' is "[MAYOR] [TAG] H7 …", the
   * spelling until 2026-11-12. A name with no mark is spelled the same both
   * ways and reads 'current'.
   */
  spelling: 'current' | 'old';
  /**
   * Everything after the marks and one space: the title, plus any " (…)" the
   * workspace sync added after it (workspace-name.ts keeps Justin's own name
   * there).
   */
  text: string;
}

function regExpSource(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * A tag is what resolveRepoTag can give: a projectTag (A-Z, 0-9, "-") or a
 * folder name uppercased, so no space and no lowercase letter, or the unknown
 * tag. That keeps "[TEST_DATA_DELETABLE <uuid> ] …" and other bracketed text
 * Justin or a test types from reading as a tag.
 */
const TAG_SOURCE = String.raw`${regExpSource(UNKNOWN_REPO_TAG)}|[^\s\[\]\p{Ll}]+`;
const NUMBER_SOURCE = String.raw`[1-9]\d*|\?`;
const MAYOR_SOURCE = regExpSource(MAYOR_MARK);

/** "[MAYOR][TAG][#7] text": the builder's spelling. */
const CURRENT_SPELLING = new RegExp(
  String.raw`^(${MAYOR_SOURCE})?\[(${TAG_SOURCE})\](?:\[#(${NUMBER_SOURCE})\])?(?: (.*))?$`,
  'su',
);

/** "[MAYOR] [TAG] H7 text": the spelling before 2026-11-12 (D3). */
const OLD_SPELLING = new RegExp(
  String.raw`^(${MAYOR_SOURCE} )?\[(${TAG_SOURCE})\](?: H(${NUMBER_SOURCE})(?= |$))?(?: (.*))?$`,
  'su',
);

function parsedFrom(
  match: RegExpExecArray,
  spelling: ParsedSessionName['spelling'],
): ParsedSessionName {
  const [, mayor, tag, number, text] = match;
  return {
    marks: {
      handoff:
        number == null ? null : number === '?' ? 'unknown' : Number(number),
      mayor: mayor != null,
    },
    repoTag: tag == null || tag === UNKNOWN_REPO_TAG ? null : tag,
    spelling,
    text: text ?? '',
  };
}

/**
 * 1rxt0.2 D2, D3: the one parser of a session name, in either spelling. Null
 * when the name does not start with a tag. The old spelling wins only when it
 * finds a mark, so "[HOME] H7 x" reads as number 7, as the old builder meant it.
 * A title that itself starts "H7 " is read that way too; the old spelling was
 * just as ambiguous.
 */
export function parseSessionName(name: string): ParsedSessionName | null {
  const old = OLD_SPELLING.exec(name);
  if (old != null && (old[1] != null || old[3] != null)) {
    return parsedFrom(old, 'old');
  }
  const current = CURRENT_SPELLING.exec(name);
  return current == null ? null : parsedFrom(current, 'current');
}

/**
 * Whether a name carries a session mark in either spelling: the mayor mark or a
 * handoff number. A "[TAG] title" with no mark does not count: Justin types
 * those himself (home-base-fuxmk).
 */
export function carriesSessionMarks(name: string): boolean {
  const parsed = parseSessionName(name);
  return parsed != null && (parsed.marks.mayor || parsed.marks.handoff != null);
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
