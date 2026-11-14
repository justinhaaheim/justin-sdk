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

import {chainNameOfLabels, chainNameText, parseChainName} from './chain-name';
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
  /**
   * home-base-l2ejg.11: the chain's name in its text spelling (`Moe`,
   * `Moe II`; chain-name.ts). Absent or null: no name, and the number shows
   * as `[#N]`, as before chain names. Set: the name and the number share one
   * bracket, `[Moe-7]`, `[Moe-?]`, or `[Moe]` for a first session. Only a
   * caller that knows componentConfig.thread.chainNames is on sets it.
   */
  chain?: null | string;
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

/** What a caller knows when it reads marks from labels. */
export interface SessionMarksOptions {
  /**
   * componentConfig.thread.chainNames (home-base-l2ejg.11). Absent or false:
   * the `chain:` label is not read, so the marks are as before chain names.
   */
  chainNames?: boolean;
}

/**
 * D2: the marks, from labels alone. Title code never walks a chain: a number
 * label gives its number, `continues:` with none gives unknown, neither gives no
 * mark. With chainNames on, one readable `chain:` label gives the chain's name;
 * two different ones give none until the capture's self-heal settles them.
 */
export function sessionMarksOf(
  labels: readonly string[],
  options: SessionMarksOptions = {},
): SessionMarks {
  const mayor = labels.includes(MAYOR_ROLE_LABEL);
  const named = options.chainNames === true ? chainNameOfLabels(labels) : null;
  const chain = named?.kind === 'one' ? chainNameText(named.name) : null;
  const withChain = (marks: SessionMarks): SessionMarks =>
    chain == null ? marks : {...marks, chain};
  const stamped = stampedHandoffNumber(labels);
  if (stamped.kind === 'number') {
    return withChain({handoff: stamped.number, mayor});
  }
  if (stamped.kind === 'unreadable') {
    return withChain({handoff: 'unknown', mayor});
  }
  const continues = labels.some((label) =>
    label.startsWith(CONTINUES_LABEL_PREFIX),
  );
  return withChain({handoff: continues ? 'unknown' : null, mayor});
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

/**
 * The bracket after the tag: `[#7]` (no chain name), `[Moe-7]`, `[Moe-?]`, or
 * `[Moe]` for a chain's first session (home-base-l2ejg.11: name and number in
 * one mark, after Justin's own example `[MAYOR][HOME][babysitter-10]`).
 */
function numberBracket(marks: SessionMarks): string {
  const {chain, handoff} = marks;
  if (chain == null || chain === '') {
    return handoff == null ? '' : `[${handoffNumberText(handoff)}]`;
  }
  if (handoff == null) return `[${chain}]`;
  return `[${chain}-${handoff === 'unknown' ? '?' : String(handoff)}]`;
}

/** 1rxt0.2 D2: the one builder of a session's marks. */
export function sessionNameParts(
  repoTag: string | null,
  text: string,
  marks: SessionMarks = NO_MARKS,
): SessionNameParts {
  const number = numberBracket(marks);
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
/**
 * A chain name's shape (chain-name.ts): it holds lower-case letters, so it can
 * never read as a tag. Only a pool name counts; parseSessionName checks that.
 */
const CHAIN_SOURCE = String.raw`[A-Z][a-z]+(?: [IVXLCDM]+)?`;

/**
 * "[MAYOR][TAG][#7] text" or "[MAYOR][TAG][Moe-7] text": the builder's
 * spellings, before and since chain names (home-base-l2ejg.11).
 */
const CURRENT_SPELLING = new RegExp(
  String.raw`^(${MAYOR_SOURCE})?\[(${TAG_SOURCE})\](?:\[#(${NUMBER_SOURCE})\]|\[(${CHAIN_SOURCE})(?:-(${NUMBER_SOURCE}))?\])?(?: (.*))?$`,
  'su',
);

/** "[MAYOR] [TAG] H7 text": the spelling before 2026-11-12 (D3). */
const OLD_SPELLING = new RegExp(
  String.raw`^(${MAYOR_SOURCE} )?\[(${TAG_SOURCE})\](?: H(${NUMBER_SOURCE})(?= |$))?(?: (.*))?$`,
  'su',
);

function parsedFrom(
  parts: {
    chain?: string | undefined;
    mayor: string | undefined;
    number: string | undefined;
    tag: string | undefined;
    text: string | undefined;
  },
  spelling: ParsedSessionName['spelling'],
): ParsedSessionName {
  const {chain, mayor, number, tag, text} = parts;
  const marks: SessionMarks = {
    handoff:
      number == null ? null : number === '?' ? 'unknown' : Number(number),
    mayor: mayor != null,
  };
  return {
    marks: chain == null ? marks : {...marks, chain},
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
    const [, mayor, tag, number, text] = old;
    return parsedFrom({mayor, number, tag, text}, 'old');
  }
  const current = CURRENT_SPELLING.exec(name);
  if (current == null) return null;
  const [, mayor, tag, hashNumber, chain, chainNumber, text] = current;
  // home-base-l2ejg.11: a bracket shaped like a name is the tool's only when it
  // is a pool name, so "[HOME][Notes] x" stays what it was before: not a name.
  if (chain != null && parseChainName(chain) == null) return null;
  return parsedFrom(
    {chain, mayor, number: hashNumber ?? chainNumber, tag, text},
    'current',
  );
}

/**
 * Whether a name carries a session mark in any spelling: the mayor mark, a
 * handoff number or a chain name. A "[TAG] title" with no mark does not count:
 * Justin types those himself (home-base-fuxmk).
 */
export function carriesSessionMarks(name: string): boolean {
  const parsed = parseSessionName(name);
  return (
    parsed != null &&
    (parsed.marks.mayor ||
      parsed.marks.handoff != null ||
      parsed.marks.chain != null)
  );
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
