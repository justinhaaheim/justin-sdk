/**
 * PART 1 of a v4 status report (epic home-base-vzwbj.4 D4; built by
 * home-base-vzwbj.4.3): the generated half — where the session stands, read
 * from the session model — printed by `thread status` (for Claude to paste),
 * `thread show` (live, for Justin) and, in dispatch 4, `thread inbox`.
 *
 * Justin, 2026-10-11, verbatim on the epic: "Do NOT lay things out in long
 * rows like that. Put them in parallel structure. Make this easy to
 * read/scan." So every field is `**Label:** value` on its OWN line, a blank
 * line separates every group and every list item, and no line joins two
 * fields with ` · ` — the ONE sanctioned ` · ` is the ask renderer's badge
 * line (`1. 🟡 P2 · **question** (id)`), which this module reuses unchanged.
 *
 * ONE VIEW, TWO RENDERINGS: `partOneView` turns the model into labelled
 * fields and lists; `renderPartOne` prints them as markdown when the output is
 * not coloured (a pipe — how Claude runs `thread status`) or as ANSI through
 * cli-style.ts on a TTY. Nothing is computed in the renderers.
 *
 * The layout, in order (home-base-j8q3e.1.7.2, Justin's layout of
 * 2026-10-15 on home-base-j8q3e.1.7: "something LIKE this -- don't copy this
 * verbatim. make it look good, but please, for god's sake, give me more
 * vertical spacing"), each section after the first behind a `---` rule:
 *   🛑 rule (28 of them, the legacy report's rule)
 *   Session (the title, on its own)
 *   ---  Started / Last activity, then Status / You need to (deriveAction,
 *        the dashboard's line, so the two never disagree) / Optional
 *   ---  ## Progress: "N of M requests done", then the requests (numbered;
 *        ✅ 🔲, or 🛑 "blocked on question N"; stage; children)
 *   ---  Your first message / Your last message (when it is not the first,
 *        home-base-vzwbj.4.9 F10), each as a `>` quote
 *   ---  ## Questions for you (renderAsks of the open questions, P0 first)
 *   ---  Repo / Branch / Worktree / Context / Uncommitted (only when > 0 or
 *        unknown) / Unpushed (only when > 0 or not countable) / Commits this
 *        session, then Resume / Pane
 *   ♒ separator — the block's last line, and the line `thread show` strips a
 *        pasted Part 1 through (`───` before home-base-1rxt0.4 D1)
 *
 * In `thread status` only (home-base-1rxt0.4, report-delta.ts): 🆕 or 🔄 right
 * after the number of a request or question new or changed since the last
 * report, an unchanged P2 to P4 question on one line, and one line after the
 * questions naming those. Nothing is reordered.
 *
 * `thread status --changes` (home-base-88y8m D1): the same view and renderer,
 * except that Progress and Questions for you keep only the items new or
 * changed since the last report, each whole and under its full-report number,
 * then one italic count line for the rest, and the questions answered or
 * closed since. A new section between Questions for you and the footer goes in
 * the `sections` list of each renderer.
 *
 * SPACING IS MEASURED, NOT ASSUMED (home-base-j8q3e.1.7.1, Claude Code
 * 2.1.300, docs/reference/claude-code-markdown-rendering.md): Claude Code's
 * terminal DROPS one empty line between two list items and draws two as one
 * empty row. So every pair of sibling list items in the requests and the
 * questions is two empty lines apart (MARKDOWN_ITEM_GAP). Paragraphs,
 * headings, quotes and `---` rules keep one empty row from one empty line, so
 * blocks stay one apart (spacedList). A `---` is drawn as the text `---`.
 *
 * In markdown every field group is a TIGHT BULLET LIST (`- **Status:** …`,
 * no blank line inside a group, one between groups): consecutive non-blank
 * lines are ONE paragraph in CommonMark and a renderer may join them with
 * spaces, while a tight list is one line per item everywhere (item 5). The
 * groups alternate `-` and `*` (4.9 F4): two `-` lists one blank line apart
 * are ONE loose list in CommonMark, and a strict renderer loses the gap. A
 * field's warnings sit on sub-bullets under it, never on its line (4.9 F14).
 * On a TTY the groups are aligned label columns, man-page style (cli-style.ts),
 * in the same order, with a dim `╌` rule where markdown has `---` (never `─`:
 * that is the separator `thread show` strips through).
 *
 * Times are ABSOLUTE (`Tue 2030-01-01 9:00 am`), never "3 hours ago": a pasted
 * Part 1 is read days later, when relative words are false (item 6c).
 */

import type {OutputStyle, StyleName} from '../cli-style';
import type {JobHealthNotice} from '../job-health';
import type {VitalsNotice} from '../vitals';
import type {
  MessageQuestionItem,
  MessageQuestions,
  NamedQuestionState,
} from './message-questions';
import type {
  ItemMark,
  QuestionShown,
  ReportBaseline,
  ReportDelta,
  SnapshotItems,
} from './report-delta';
import type {RequestStateLine} from './request-state';
import type {ActionLine, OptionalLine} from './session-card';
import type {SessionCommits} from './session-commits';
import type {SessionModel} from './session-model';
import type {SessionMarks} from './session-name';
import type {SessionStatus, StatusCounts} from './session-status';
import type {RequestNode, TreeIssue} from './session-tree';

import {homedir} from 'os';

import {
  BODY_COLUMN,
  DETAIL_COLUMN,
  displayWidth,
  HEADER_COLUMN,
  markdownItems,
  pad,
  paint,
  sectionHeader,
  spacedList,
  wrapHanging,
} from '../cli-style';
import {JOB_HEALTH_DETAILS_COMMAND, jobHealthReportText} from '../job-health';
import {VITALS_DETAILS_COMMAND, vitalsReportText} from '../vitals';
import {parseInstant} from './answer-store';
import {ARCHIVED_PREFIX, DONE_PREFIX} from './ask-format';
import {renderAsks, sortAsks} from './ask-render';
import {exportBehindWords} from './export-behind';
import {questionIdOf, questionIdsShown, shortIdText} from './question-ids';
import {
  answeredSinceLine,
  baselineProblem,
  CHANGES_ALL_SHOWN_FIRST,
  compactQuestionsNote,
  markEmoji,
  markOf,
  questionFingerprint,
  questionKey,
  questionShown,
  questionsLeftSince,
  requestFingerprint,
  requestKey,
  unchangedCountLine,
} from './report-delta';
import {
  chainSessionOf,
  NO_CHAIN_LOOKUP,
  requestStatesOf,
} from './request-state';
import {cutOnWord} from './session-bead';
import {firstUserLine, newestLogAt, userLines} from './session-model';
import {sessionDisplayName, sessionMarksOf} from './session-name';
import {isOpen, openQuestions, stageReached} from './session-status';

/** The legacy report's rule (render-markdown.ts RULE_STOP), kept identical. */
// Six, not 28 (Justin, 2026-10-24): a longer run fills the phone notification
// that shows the start of the report. Detection (isRuleLine) needs three.
export const PART_ONE_RULE = '🛑'.repeat(6);

/**
 * The end of Part 1, and what `thread show` strips through. A line of ♒ since
 * home-base-1rxt0.4 D1 (Justin, 2026-11-12: "It'd be helpful if we just
 * distinguished that section more clearly -- say, with a few of these ♒?"):
 * Claude's own message starts right after it. Ten, like the 🛑 rule kept
 * short, so it fits one line on a phone. Blocks pasted before then end with
 * `─` × 28, which isSeparatorLine still reads.
 */
export const PART_ONE_SEPARATOR = '♒'.repeat(10);

/**
 * The rule between Part 1's sections in markdown. Claude Code draws every rule
 * as the text `---` (measured 2026-10-15), so a longer one gains nothing.
 */
export const PART_ONE_SECTION_RULE = '---';

/**
 * The same rule on a TTY: dim, and drawn with `╌` so it can never be read as
 * PART_ONE_SEPARATOR by the strip rule below.
 */
const ANSI_SECTION_RULE = '╌'.repeat(28);

/** "Your first message" is cut here (design item 6). */
export const FIRST_MESSAGE_CUT = 160;

/** A piece of a field's value: text, bold text, or a command to copy. */
export type Piece = string | {code: string} | {strong: string};

/**
 * A line indented UNDER a field (home-base-vzwbj.4.9 F14): a warning about the
 * field's value, and its own examples one level further in. Keeps a field's
 * line to its value, so a long list never becomes one paragraph.
 */
export interface PartSubItem {
  sub: PartSubItem[];
  text: Piece[];
}

export interface PartField {
  label: string;
  /** Lines under the field; [] for almost every field. */
  sub: PartSubItem[];
  value: Piece[];
}

export interface RequestChildView {
  icon: string;
  id: string;
  title: string;
}

export interface RequestView {
  /** "blocked on question 1" when an open P0 hangs under it, else null. */
  blockedOn: string | null;
  children: RequestChildView[];
  icon: string;
  id: string;
  /** home-base-1rxt0.4 D2: new or changed since the last report, else null. */
  mark: ItemMark | null;
  /** "tested — next: built", or null when no stage label is on the ladder. */
  stage: string | null;
  /**
   * home-base-l2ejg.5 (D7): "Stopped: open work, no blocker — next: tested —
   * since Tue 2030-01-01 9:00 am" (`requestStateText`, absolute time).
   */
  stateLine: string;
  title: string;
}

/**
 * One of Justin's messages under its label. `quote` is his words (quoted and
 * cut), drawn as a `>` quote; null when `note` says why there are none — a note
 * is never drawn as a quote, because it is not his words.
 */
export interface MessageView {
  label: string;
  note: string | null;
  quote: string | null;
}

/**
 * home-base-88y8m D1: what `thread status --changes` adds to the view. With
 * it, the view's `requests` and `questions` hold only the items kept, each
 * rendered whole and under the number the full report gives it.
 */
export interface ChangesView {
  /** `first` baseline: why every item is shown; else null. */
  allShown: string | null;
  /** The questions that left the open list since the last report, or null. */
  answered: string | null;
  /** Each kept question's number in the full report, by question id. */
  questionNumbers: ReadonlyMap<string, number>;
  /** The count line for the questions left out, or null. */
  questionsUnchanged: string | null;
  /** Each kept request's number in the full report, by request id. */
  requestNumbers: ReadonlyMap<string, number>;
  /** The count line for the requests left out, or null. */
  requestsUnchanged: string | null;
}

/**
 * home-base-88y8m D4: Claude's message as `## From Claude` shows it. `text` is
 * verbatim; `problem` says why the stored one could not be read (then `text`
 * is null). `at` is when it was written, in words (`thread show` only).
 */
export interface ClaudeMessageView {
  at: string | null;
  problem: string | null;
  text: string | null;
}

/** What the caller hands Part 1 for D4: the message, or why there is none. */
export type ClaudeMessageInput =
  | {at: Date | null; text: string}
  | {problem: string};

/**
 * home-base-88y8m D5: `## Other questions the message names` (named so by
 * home-base-88y8m.3 F1: it holds this session's own answered or closed
 * questions too, and each item's bold line names its session and repo). Each
 * question keeps a number after the last of Questions for you, so no number is
 * shown twice.
 */
export interface OtherQuestionsView {
  /** The number of the first question here. */
  firstNumber: number;
  items: MessageQuestionItem[];
}

export interface PartOneView {
  /** Beads exports that could not be read, said above the requests. */
  beadProblems: string[];
  /**
   * home-base-88y8m D1: set by `thread status --changes` only. Null or absent:
   * the full report, every item.
   */
  changes?: ChangesView | null;
  /** home-base-88y8m D4: `## From Claude`, or null when there is no message. */
  claudeMessage?: ClaudeMessageView | null;
  /**
   * home-base-1rxt0.4: why nothing is marked new or changed and every question
   * is in full, when the last report could not be established; else null.
   */
  deltaProblem: string | null;
  /** Repo / Branch / Worktree / Context / Uncommitted / Unpushed / Commits. */
  git: PartField[];
  /** Your first message, then Your last message when it differs (F10). */
  messages: MessageView[];
  /**
   * home-base-88y8m D5: the questions the message names that are not open
   * questions of this session; null when it names none.
   */
  otherQuestions?: OtherQuestionsView | null;
  /** "1 of 3 requests done", or why the count is unknown. */
  progress: string;
  /**
   * home-base-1rxt0.4 D4: lines under the questions: a question shown by its
   * bead id and why, and why ids could not be given. Empty when none.
   */
  questionIdNotes: string[];
  /**
   * home-base-1rxt0.4 D4: per question id, what its brackets hold (`Q107`, or
   * its bead id when its short id cannot be shown). No entry: no brackets.
   */
  questionIds: ReadonlyMap<string, string>;
  /** home-base-1rxt0.4: per question id, its marker and whether it is one line. */
  questionShown: ReadonlyMap<string, QuestionShown>;
  /** The OPEN questions; `renderAsks` orders them, P0 first. */
  questions: TreeIssue[];
  /** home-base-1rxt0.4 D3: the line after the questions, or null. */
  questionsNote: string | null;
  requests: RequestView[];
  resume: PartField[];
  /** The Session field: `[REPO] title`. */
  session: PartField;
  /**
   * home-base-1rxt0.4 D6: what this report shows, for `thread status` to save
   * as the snapshot the next turn compares with.
   */
  snapshot: SnapshotItems;
  /** Status / You need to / Optional. */
  state: PartField[];
  /** Started / Last activity. */
  times: PartField[];
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/**
 * `/Users/x/Dev/…` → `~/Dev/…` wherever a path appears in display text (a
 * reason, a worktree path). Display only: the model keeps absolute paths.
 */
export function tildeText(text: string): string {
  const home = homedir();
  if (home === '' || home === '/') return text;
  return text.split(`${home}/`).join('~/');
}

/** R2: which of "merged" and "clean" a 🔀 Done, not merged session lacks. */
function doneUnmergedMissing(
  status: Extract<SessionStatus, {kind: 'doneUnmerged'}>,
): string {
  const missing: string[] = [];
  if (status.notMerged) {
    missing.push('the branch is not merged into the default branch');
  }
  if (status.uncommitted > 0) {
    missing.push(
      `${status.uncommitted} uncommitted path${status.uncommitted === 1 ? '' : 's'}`,
    );
  }
  return missing.join(' and ');
}

/** The status as Justin reads it: one icon, plain words. */
export function statusWords(status: SessionStatus): string {
  switch (status.kind) {
    case 'waiting':
      return '🛑 Waiting on you';
    case 'working':
      return '🏃 Working';
    case 'handedOff':
      return status.successor == null
        ? '🤝 Handed off'
        : `🤝 Handed off to ${status.successor}`;
    case 'outOfContext':
      return '🧯 Past wind-down notice';
    case 'done':
      if (status.by === 'requests') return '✅ Done';
      if (status.reason?.startsWith(ARCHIVED_PREFIX) === true) {
        return `✅ Done — you archived it (${status.reason.slice(ARCHIVED_PREFIX.length)})`;
      }
      // R2: Justin's own mark wins over git; said as the close reason.
      return `✅ Done — ${status.reason ?? DONE_PREFIX}`;
    case 'doneUnmerged':
      return `🔀 Done, not merged — every request is closed, but ${doneUnmergedMissing(status)}`;
    case 'answered':
      return '💬 Answered';
    case 'exportBehind':
      return `⏳ Export behind — ${exportBehindWords(status.behind)}`;
    case 'unknown':
      return `❔ Unknown — ${status.reasons.join('; ')}`;
    case 'openWork':
      return '⚠️ Open work, no blocker';
  }
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The counts beside the status, e.g. "1 blocking question, 2 optional questions". */
export function countsWords(counts: StatusCounts): string | null {
  const parts: string[] = [];
  if (counts.blocking > 0) {
    parts.push(
      plural(counts.blocking, 'blocking question', 'blocking questions'),
    );
  }
  if (counts.optional > 0) {
    parts.push(
      plural(counts.optional, 'optional question', 'optional questions'),
    );
  }
  if (counts.fyi > 0) parts.push(`${counts.fyi} FYI`);
  return parts.length === 0 ? null : parts.join(', ');
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

interface ZonedParts {
  day: string;
  dayPeriod: string;
  hour: string;
  minute: string;
  month: string;
  weekday: string;
  year: string;
}

function zoned(date: Date, timeZone: string | undefined): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    hour: 'numeric',
    hour12: true,
    minute: '2-digit',
    month: 'numeric',
    timeZone,
    weekday: 'long',
    year: 'numeric',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '?';
  return {
    day: get('day'),
    dayPeriod: get('dayPeriod').toLowerCase(),
    hour: get('hour'),
    minute: get('minute'),
    month: get('month'),
    weekday: get('weekday'),
    year: get('year'),
  };
}

/** "3 hours ago", "just now", "2 days ago". */
export function ageWords(at: Date, now: Date): string {
  const seconds = Math.floor((now.getTime() - at.getTime()) / 1000);
  if (seconds < 0) return 'in the future';
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${plural(minutes, 'minute', 'minutes')} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${plural(hours, 'hour', 'hours')} ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

/** "Saturday 10/11, 9:00 am" — the year too when it is not this year. */
export function whenWords(
  at: Date,
  now: Date,
  timeZone: string | undefined,
): string {
  const then = zoned(at, timeZone);
  const today = zoned(now, timeZone);
  const date =
    then.year === today.year
      ? `${then.month}/${then.day}`
      : `${then.month}/${then.day}/${then.year}`;
  return `${then.weekday} ${date}, ${then.hour}:${then.minute} ${then.dayPeriod}`;
}

/**
 * "Tue 2030-01-01 9:00 am" — the absolute form Part 1 prints (design item 6c):
 * nothing in it goes false when the pasted copy is read a week later.
 */
export function absoluteWhen(at: Date, timeZone: string | undefined): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    hour: 'numeric',
    hour12: true,
    minute: '2-digit',
    month: '2-digit',
    timeZone,
    weekday: 'short',
    year: 'numeric',
  }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '?';
  return `${get('weekday')} ${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')} ${get('dayPeriod').toLowerCase()}`;
}

function dateOf(iso: string): Date | null {
  const ms = parseInstant(iso);
  return ms == null ? null : new Date(ms);
}

/**
 * home-base-l2ejg.5 (D7): a request's state line in words, the one printer
 * Part 1, the inbox, the dashboard and `threads --json` share: "Stopped: open
 * work, no blocker — next: tested — since 2 days ago". `absolute` gives the
 * time as Part 1 prints times (item 6c: a pasted block is read days later);
 * otherwise its age. A last change with no readable time is "since unknown".
 */
export function requestStateText(
  line: Pick<RequestStateLine, 'carriedBy' | 'next' | 'since' | 'state'>,
  options: {absolute?: boolean; now: Date; timeZone?: string},
): string {
  const parts = [
    line.carriedBy == null
      ? line.state
      : `Carried by ${line.carriedBy}: ${line.state}`,
  ];
  if (line.next != null) parts.push(`next: ${line.next}`);
  const at = line.since == null ? null : dateOf(line.since);
  parts.push(
    at == null
      ? 'since unknown'
      : options.absolute === true
        ? `since ${absoluteWhen(at, options.timeZone)}`
        : `since ${ageWords(at, options.now)}`,
  );
  return parts.join(' — ');
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export function tokensWords(tokens: number): string {
  return tokens < 1000
    ? `${tokens} tokens`
    : `${Math.round(tokens / 1000)}k tokens`;
}

function unknownBecause(reason: string): string {
  return `unknown (${reason})`;
}

function field(label: string, ...value: Piece[]): PartField {
  return {label, sub: [], value};
}

/** The one-line form of a message's first non-empty line, cut. */
export function firstLineOf(text: string, cut: number): string {
  const line =
    text
      .split('\n')
      .map((entry) => entry.trim())
      .find((entry) => entry !== '') ?? '';
  return cutOnWord(line.replace(/\s+/g, ' '), cut);
}

const CHECKOUT_UNREADABLE = 'checkout unreadable:';

export interface PartOneInput {
  /**
   * What Justin does now: `deriveAction` (session-card.ts, epic
   * home-base-j8q3e.1 D3), the dashboard's "You need to" line, derived by the
   * caller from the same model and status (home-base-j8q3e.1.7.2 item 3).
   */
  action: ActionLine;
  /**
   * home-base-88y8m D1, `thread status --changes`: Progress and Questions for
   * you keep only what is new or changed since the last report (`delta`), and
   * one line says how many others there are. Needs `delta`; without one it
   * changes nothing. Absent or false: the full report.
   */
  changesOnly?: boolean;
  counts: StatusCounts;
  /**
   * home-base-1rxt0.4: the last report and the compact switch, from `thread
   * status` only. Null or absent (`thread show`, the inbox): nothing marked,
   * every question in full.
   */
  delta?: ReportDelta | null;
  /**
   * home-base-1rxt0.10 D5: what the chores health file says about the
   * recurring jobs on this Mac (job-health.ts). Null or absent: nothing to
   * show, so no Jobs line. The caller passes it for a mayor session only
   * (R3, session-report.ts loadForReport).
   */
  jobs?: JobHealthNotice | null;
  /**
   * home-base-idnon: the Session line's marks, the number walked by the
   * caller (walkedSessionMarks); absent: from the bead's labels alone.
   */
  marks?: SessionMarks;
  /**
   * home-base-88y8m D4: Claude's message, shown as `## From Claude` after the
   * questions and before the footer. Null or absent: no such section.
   */
  message?: ClaudeMessageInput | null;
  /**
   * home-base-88y8m D5: what the message's question ids resolved to
   * (message-questions.ts). Its `ownOpen` questions are kept whole under
   * `--changes`; its items are `## Other questions the message names`.
   */
  messageQuestions?: MessageQuestions | null;
  model: SessionModel;
  now: Date;
  /** The dashboard's "Optional" line (`optionalLine`), null when none. */
  optional: OptionalLine | null;
  /**
   * home-base-1rxt0.4 D4: why some questions got no id in this run of
   * `thread status`; absent or empty when every one has one.
   */
  questionIdProblems?: readonly string[];
  /**
   * home-base-l2ejg.5: each request's state line by request id, computed by
   * the caller through the handoff chain (session-report.ts). Absent: from
   * this session alone, and a successor is said as not looked up.
   */
  requestStates?: ReadonlyMap<string, RequestStateLine>;
  status: SessionStatus;
  /** IANA zone for times; undefined = this machine's. Tests pin it. */
  timeZone?: string;
  /**
   * home-base-sg9q9.7 D4: what home-base `vitals` last recorded about this
   * Mac and its Claude Code setup (vitals.ts). Null or absent: nothing to
   * show, so no Vitals line. The caller passes it for a mayor session only.
   */
  vitals?: VitalsNotice | null;
}

/**
 * The "You need to" value: the action's words in bold, then its command. The
 * same words and command the dashboard card prints (session-inbox.ts).
 */
export function youNeedTo(action: ActionLine): Piece[] {
  return action.command == null
    ? [{strong: action.text}]
    : [{strong: action.text}, ' ', {code: action.command}];
}

/**
 * The question numbers (as `renderAsks` numbers them) of a request's open P0s.
 * `node.questions` holds both links (home-base-vzwbj.4.16 G1): the request's
 * `to:` label and, for old-shape questions, its parent-child edge.
 */
function blockingNumbers(
  node: RequestNode,
  ordered: readonly TreeIssue[],
): number[] {
  const mine = new Set(
    node.questions
      .filter((question) => isOpen(question) && question.priority === 0)
      .map((question) => question.id),
  );
  return ordered
    .map((question, index) => (mine.has(question.id) ? index + 1 : null))
    .filter((number): number is number => number != null);
}

function unpushedWords(git: SessionModel['git']): string | null {
  if (!git.unpushed.ok) return null;
  if (git.unpushed.value.kind === 'noUpstream') {
    // F5 (home-base-vzwbj.4.9): git measured only that no upstream is set —
    // not that the commits were never pushed anywhere.
    return 'no upstream branch is configured, so nothing shows these commits were pushed anywhere';
  }
  return git.unpushed.value.count > 0
    ? `${plural(git.unpushed.value.count, 'commit', 'commits')} (not on ${git.unpushed.value.upstream})`
    : null;
}

/** F14: how many unmatched commit commands Part 1 shows, and how wide. */
export const COMMIT_EXAMPLES_SHOWN = 3;
export const COMMIT_EXAMPLE_CUT = 60;

/**
 * The Commits field (F14, home-base-vzwbj.4.9): the line says only the count
 * (and "no request filed"); why the count is partial or a fallback goes on a
 * ⚠️ line UNDER it, with at most COMMIT_EXAMPLES_SHOWN of the commands that
 * matched nothing, each cut at COMMIT_EXAMPLE_CUT, then "and N more". Every
 * command stays in `thread inbox --json` (each session's
 * model.git.commits.value.unmatchedCalls; `thread show` has no --json).
 */
function commitsField(
  commits: SessionCommits,
  requestsTotal: number,
): PartField {
  const head = field(
    'Commits this session',
    `${commits.count}${requestsTotal === 0 && commits.count > 0 ? ' — no request filed' : ''}`,
  );
  if (commits.source === 'sinceFirstPrompt') {
    head.sub.push({
      sub: [],
      text: [
        `⚠️ counted on this branch since your first prompt, so other sessions' commits may be included: the transcript could not be read — ${commits.fallbackBecause}`,
      ],
    });
    return head;
  }
  const unmatched = commits.unmatchedCalls.length;
  const unresolved = commits.unresolved.length;
  if (unmatched === 0 && unresolved === 0) return head;
  const said: string[] = [];
  // R3: a commit command that matched no commit is work this count lacks.
  if (unmatched > 0) {
    said.push(
      `${plural(unmatched, 'commit command', 'commit commands')} matched no commit in this checkout (committed elsewhere, or failed)`,
    );
  }
  if (unresolved > 0) {
    said.push(
      `${plural(unresolved, 'confirmation line', 'confirmation lines')} ${unresolved === 1 ? 'belongs' : 'belong'} to another checkout`,
    );
  }
  const examples: PartSubItem[] = commits.unmatchedCalls
    .slice(0, COMMIT_EXAMPLES_SHOWN)
    .map((command) => ({
      sub: [],
      text: [
        {code: cutOnWord(command.replace(/\s+/g, ' '), COMMIT_EXAMPLE_CUT)},
      ],
    }));
  if (unmatched > COMMIT_EXAMPLES_SHOWN) {
    examples.push({
      sub: [],
      text: [`and ${unmatched - COMMIT_EXAMPLES_SHOWN} more`],
    });
  }
  head.sub.push({sub: examples, text: [`⚠️ ${said.join('; ')}`]});
  return head;
}

/**
 * home-base-88y8m D1: what `--changes` keeps, and the lines for the rest.
 * Against a FOUND last report: the requests and questions marked new or
 * changed, one count line per section, and the questions that left the open
 * list. Against `first` or `unknown`: every item and no count line, because
 * "unchanged" is a claim only a comparison can make (critical rule 7); `first`
 * says why everything is shown, `unknown` already has its deltaProblem line.
 *
 * home-base-88y8m.8 R1: a question a printed line names is never left out. A
 * kept request names its own questions (its "blocked on question N" and its
 * Now line, request-state.ts), and the header's You need to names an open P0
 * (deriveAction), so those are kept whole too, changed or not. Derived from
 * the data those lines are built from, never from the rendered text.
 */
function changesOf(input: {
  /**
   * home-base-88y8m D5: open questions of this session that Claude's message
   * names, kept whole whether or not they changed.
   */
  alsoKeep: ReadonlySet<string>;
  baseline: ReportBaseline;
  beads: SessionModel['beads'];
  /** The bead export is behind, so the questions shown are not all there are. */
  exportBehind: boolean;
  ordered: readonly TreeIssue[];
  /** R1: each request's open question ids (its RequestNode's), by request id. */
  requestQuestions: ReadonlyMap<string, readonly string[]>;
  requests: readonly RequestView[];
  shown: ReadonlyMap<string, QuestionShown>;
}): {
  keptQuestions: TreeIssue[];
  keptRequests: RequestView[];
  view: ChangesView;
} {
  const {baseline, ordered, requests, shown} = input;
  const compared = baseline.kind === 'found';
  const keptRequests = compared
    ? requests.filter((request) => request.mark != null)
    : [...requests];
  // R1: what the printed lines name, beside what the message names (D5).
  const named = new Set(input.alsoKeep);
  for (const request of keptRequests) {
    for (const id of input.requestQuestions.get(request.id) ?? []) {
      named.add(id);
    }
  }
  for (const question of ordered) {
    if (question.priority === 0) named.add(question.id);
  }
  const keptQuestions = compared
    ? ordered.filter(
        (question) =>
          shown.get(question.id)?.mark != null || named.has(question.id),
      )
    : [...ordered];
  const requestNumbers = new Map(
    requests.map((request, index) => [request.id, index + 1] as const),
  );
  const questionNumbers = new Map(
    ordered.map((question, index) => [question.id, index + 1] as const),
  );
  // An unreadable or lagging export drops questions from the model that are
  // still open: listing them as answered would be a reassuring claim nobody
  // checked (rule 7). Progress already says which beads could not be read.
  const readable = input.beads.problems.length === 0 && !input.exportBehind;
  const left = readable
    ? questionsLeftSince(
        baseline,
        new Set(ordered.map((question) => question.id)),
      )
    : [];
  const byId = new Map(
    input.beads.questions.map((question) => [question.id, question] as const),
  );
  const answered = answeredSinceLine(
    left.map((id) => {
      const question = byId.get(id);
      if (question == null) return {id, title: null};
      const short = questionIdOf(question.labels);
      return {
        id: short.kind === 'one' ? shortIdText(short.number) : id,
        title: question.title,
      };
    }),
  );
  return {
    keptQuestions,
    keptRequests,
    view: {
      allShown: baseline.kind === 'first' ? CHANGES_ALL_SHOWN_FIRST : null,
      answered,
      questionNumbers,
      questionsUnchanged: compared
        ? unchangedCountLine('question', keptQuestions.length, ordered.length)
        : null,
      requestNumbers,
      requestsUnchanged: compared
        ? unchangedCountLine('request', keptRequests.length, requests.length)
        : null,
    },
  };
}

export function partOneView(input: PartOneInput): PartOneView {
  const {counts, model, status, timeZone} = input;
  const {beads, git, transcript} = model;

  // ---- Session / Your first message / Started / Last activity ----
  // An unreadable export is named once, under Requests; here it is pointed at.
  const title =
    (beads.session ?? model.exportBehind) != null
      ? (beads.session?.title ?? model.exportBehind?.title ?? '')
      : beads.problems.length > 0
        ? '⚠️ title unknown (its beads could not be read; see Progress)'
        : `⚠️ title unknown (${beads.sessionMissing ?? 'the session bead was not found'})`;
  const first = firstUserLine(model.log);
  let started: string;
  if (model.startedAt.ok) {
    const at = dateOf(model.startedAt.value);
    started =
      at == null
        ? unknownBecause(
            `unreadable time ${JSON.stringify(model.startedAt.value)}`,
          )
        : absoluteWhen(at, timeZone);
  } else {
    started = unknownBecause(model.startedAt.reason);
  }
  let lastActivity: string;
  const lastRecord = transcript.lastRecordAt.ok
    ? dateOf(transcript.lastRecordAt.value)
    : null;
  const logNewest = newestLogAt(model.log);
  const logNewestDate = logNewest == null ? null : dateOf(logNewest);
  if (lastRecord != null) {
    lastActivity = absoluteWhen(lastRecord, timeZone);
  } else if (logNewestDate != null) {
    lastActivity = `${absoluteWhen(logNewestDate, timeZone)} (from the message log, because the transcript gave no time: ${transcript.lastRecordAt.ok ? 'unreadable timestamp' : transcript.lastRecordAt.reason})`;
  } else {
    lastActivity = unknownBecause(
      transcript.lastRecordAt.ok
        ? `unreadable timestamp ${JSON.stringify(transcript.lastRecordAt.value)}`
        : transcript.lastRecordAt.reason,
    );
  }
  const firstText =
    first.ok && first.value != null
      ? `"${firstLineOf(first.value.text, FIRST_MESSAGE_CUT)}"`
      : null;
  const messages: MessageView[] = [
    !first.ok
      ? {
          label: 'Your first message',
          note: unknownBecause(first.reason),
          quote: null,
        }
      : firstText == null
        ? {label: 'Your first message', note: '(none captured)', quote: null}
        : {label: 'Your first message', note: null, quote: firstText},
  ];
  // F10 (home-base-vzwbj.4.9): in a session that runs for days, the LATEST
  // instruction — the one this turn answers — is the one Justin needs to see.
  // Omitted when it is the first message (the same log line, or the same text
  // once cut, which would print the same quote twice).
  const users = userLines(model.log);
  const newest = users.ok ? users.value.at(-1) : undefined;
  if (newest != null && first.ok && first.value != null) {
    const lastText = `"${firstLineOf(newest.text, FIRST_MESSAGE_CUT)}"`;
    if (newest !== first.value && lastText !== firstText) {
      messages.push({label: 'Your last message', note: null, quote: lastText});
    }
  }
  const times = [
    field('Started', started),
    field('Last activity', lastActivity),
  ];

  // ---- Status / You need to / Optional ----
  const countText = countsWords(counts);
  const state: PartField[] = [
    field(
      'Status',
      `${statusWords(status)}${countText == null ? '' : ` (${countText})`}`,
    ),
    field('You need to', ...youNeedTo(input.action)),
  ];
  if (input.optional != null) {
    state.push(
      field('Optional', input.optional.text, ' ', {
        code: input.optional.command,
      }),
    );
  }
  // home-base-1rxt0.10 D5: one line, near the top, while a recurring job on
  // this Mac is broken or its health cannot be vouched for. Mayor sessions
  // only (R3): the caller passes `jobs` for nothing else.
  if (input.jobs != null) {
    state.push(
      field('Jobs', jobHealthReportText(input.jobs, timeZone), ' — details: ', {
        code: JOB_HEALTH_DETAILS_COMMAND,
      }),
    );
  }
  // home-base-sg9q9.7 D4: one line under Jobs while a vitals check other than
  // jobs is not ok, or the latest result is stale. Mayor sessions only.
  if (input.vitals != null) {
    state.push(
      field('Vitals', vitalsReportText(input.vitals), ' — details: ', {
        code: VITALS_DETAILS_COMMAND,
      }),
    );
  }

  // ---- Progress ----
  const done = `${counts.requestsDone} of ${plural(counts.requestsTotal, 'request', 'requests')} done`;
  // With an export unread, "no requests filed" would be a claim nobody
  // checked (rule 7): the count is unknown, not zero.
  const progress =
    model.exportBehind != null
      ? 'Requests: not shown yet (the bead export is behind)'
      : beads.problems.length > 0
        ? counts.requestsTotal === 0
          ? 'Requests: unknown (the beads could not be read)'
          : `${done} (⚠️ some beads could not be read)`
        : counts.requestsTotal === 0
          ? 'No requests filed.'
          : done;

  // ---- Requests ----
  // home-base-1rxt0.4: what this report shows goes in `snapshot`, keyed and
  // fingerprinted the way the next turn's report compares it (D6).
  const delta = input.delta ?? null;
  const snapshot: SnapshotItems = {};
  const ordered = sortAsks(openQuestions(model));
  // home-base-l2ejg.5: computed here only when the caller passed none, and
  // then without reading any successor (said as "not looked up").
  const requestStates =
    input.requestStates ??
    requestStatesOf({
      lookup: NO_CHAIN_LOOKUP,
      // No successor is looked up here, so no session name is printed and the
      // chainNames knob changes nothing; session-report.ts passes the real one.
      session: chainSessionOf(model, status, {chainNames: false}),
    });
  const requests: RequestView[] = beads.requests.map((node) => {
    const blocking = blockingNumbers(node, ordered);
    const stage = stageReached(node.request.labels, model.stages);
    const open = isOpen(node.request);
    const shape = {
      children: node.children.map((child) => ({
        icon: isOpen(child) ? '🔲' : '✅',
        id: child.id,
        title: child.title,
      })),
      icon: !open ? '✅' : blocking.length > 0 ? '🛑' : '🔲',
      stage:
        stage == null
          ? null
          : stage.next == null
            ? `${stage.reached} (the last stage)`
            : `${stage.reached} — next: ${stage.next}`,
      title: node.request.title,
    };
    const key = requestKey(node.request.id);
    const fingerprint = requestFingerprint(shape);
    snapshot[key] = fingerprint;
    // The state line is NOT in the fingerprint: its age moves every turn, and
    // a 🔄 on every request each turn would mark nothing.
    const stateLine = requestStates.get(node.request.id);
    return {
      ...shape,
      blockedOn:
        open && blocking.length > 0
          ? `blocked on ${blocking.length === 1 ? 'question' : 'questions'} ${blocking.join(', ')}`
          : null,
      id: node.request.id,
      mark: delta == null ? null : markOf(key, fingerprint, delta.baseline),
      stateLine: tildeText(
        stateLine == null
          ? 'Unknown: no state line was computed for this request'
          : requestStateText(stateLine, {
              absolute: true,
              now: input.now,
              timeZone,
            }),
      ),
    };
  });

  // ---- Questions (home-base-1rxt0.4 D2, D3) ----
  const shownById = new Map<string, QuestionShown>();
  ordered.forEach((question) => {
    snapshot[questionKey(question.id)] = questionFingerprint(question);
    shownById.set(question.id, questionShown(question, delta));
  });

  // ---- home-base-88y8m D1: `--changes` keeps only what changed ----
  // The snapshot above stays the FULL set: the next report compares with
  // every item this one stood for, not only the ones it printed.
  const changes =
    input.changesOnly === true && delta != null
      ? changesOf({
          alsoKeep: input.messageQuestions?.ownOpen ?? new Set(),
          baseline: delta.baseline,
          beads,
          exportBehind: model.exportBehind != null,
          ordered,
          requestQuestions: new Map(
            beads.requests.map(
              (node) =>
                [
                  node.request.id,
                  node.questions.filter(isOpen).map((question) => question.id),
                ] as const,
            ),
          ),
          requests,
          shown: shownById,
        })
      : null;
  const keptQuestionIds =
    changes == null
      ? null
      : new Set(changes.keptQuestions.map((question) => question.id));
  const compactNumbers: number[] = [];
  ordered.forEach((question, index) => {
    const shown = shownById.get(question.id);
    if (shown == null) return;
    if (keptQuestionIds != null) {
      // D1: a question --changes prints is printed whole, never one line.
      if (keptQuestionIds.has(question.id)) {
        shownById.set(question.id, {...shown, compact: false});
      }
      return;
    }
    if (shown.compact) compactNumbers.push(index + 1);
  });
  // home-base-1rxt0.4 D4: never one id twice in a report (questionIdsShown).
  const ids = questionIdsShown(ordered);
  const questionIdNotes = [
    ...ids.notes,
    ...(input.questionIdProblems ?? []).map(
      (problem) => `⚠️ Question ids: ${problem}`,
    ),
  ].map(tildeText);

  // ---- Repo / Branch / Worktree / Context / … ----
  const gitFields: PartField[] = [
    field(
      'Repo',
      model.repo ?? 'unknown (the sessions index and git could not name it)',
    ),
  ];
  const unreadable =
    !git.branch.ok && git.branch.reason.startsWith(CHECKOUT_UNREADABLE)
      ? git.branch.reason
      : null;
  const gitValue = (reason: string): string =>
    unreadable != null
      ? 'unknown (checkout unreadable)'
      : unknownBecause(reason);
  if (unreadable != null) {
    gitFields.push(
      field(
        'Checkout',
        `⚠️ ${unreadable.slice(CHECKOUT_UNREADABLE.length).trim()}`,
      ),
    );
  }

  let branch: string;
  if (!git.branch.ok) {
    branch = gitValue(git.branch.reason);
  } else {
    const name =
      git.branch.value === 'HEAD' ? 'detached HEAD' : git.branch.value;
    const target = git.defaultBranch.ok
      ? git.defaultBranch.value
      : 'the default branch';
    if (!git.merged.ok) {
      branch = `${name} (whether it is merged into ${target} is unknown: ${git.merged.reason})`;
    } else if (git.merged.value === 'isDefault') {
      branch = `${name} (this is ${target})`;
    } else if (git.merged.value === 'merged') {
      branch = `${name} (merged into ${target})`;
    } else if (git.merged.value === 'onRemoteDefault') {
      // home-base-p05kz.3 item 3: landed, and local main is only behind.
      const behind =
        git.localDefaultBehind.ok && git.localDefaultBehind.value != null
          ? `; local ${target} is ${plural(git.localDefaultBehind.value.count, 'commit', 'commits')} behind`
          : '';
      branch = `${name} (landed: all its commits are on origin/${target}${behind})`;
    } else {
      branch = `${name} (not merged into ${target})`;
    }
  }
  gitFields.push(field('Branch', branch));

  gitFields.push(
    field(
      'Worktree',
      !git.worktree.ok
        ? gitValue(git.worktree.reason)
        : git.worktree.value.kind === 'primary'
          ? 'primary checkout'
          : git.worktree.value.path,
    ),
  );

  // home-base-qlxlp: the wind-down threshold is not a capacity. "342k of
  // 400k tokens" read as 90% full, and sessions handed off before the notice.
  gitFields.push(
    field(
      'Context',
      !transcript.contextTokens.ok
        ? unknownBecause(transcript.contextTokens.reason)
        : model.wrapUpAt != null
          ? `${tokensWords(transcript.contextTokens.value)} used (wind-down notice at ${tokensWords(model.wrapUpAt).replace(' tokens', '')})`
          : tokensWords(transcript.contextTokens.value),
    ),
  );

  if (!git.uncommitted.ok) {
    gitFields.push(field('Uncommitted', gitValue(git.uncommitted.reason)));
  } else if (git.uncommitted.value.length > 0) {
    const paths = git.uncommitted.value;
    gitFields.push(
      field(
        'Uncommitted',
        paths.length <= 3
          ? paths.join(', ')
          : plural(paths.length, 'path', 'paths'),
      ),
    );
  }
  // home-base-p05kz.3 item 4: `Uncommitted` is what this session's transcript
  // names. A file it does not name may still be its own (`bun add`, a formatter,
  // a generator), so it is said here without being claimed, never left out.
  if (git.checkoutDirty.ok && git.uncommitted.ok) {
    const own = new Set(git.uncommitted.value);
    const others = git.checkoutDirty.value.filter((path) => !own.has(path));
    if (others.length > 0) {
      gitFields.push(
        field(
          'Also uncommitted in this checkout',
          `${others.length <= 3 ? others.join(', ') : plural(others.length, 'path', 'paths')}, not tied to this session`,
        ),
      );
    }
  }

  if (!git.unpushed.ok) {
    gitFields.push(field('Unpushed', gitValue(git.unpushed.reason)));
  } else {
    const words = unpushedWords(git);
    if (words != null) gitFields.push(field('Unpushed', words));
  }

  gitFields.push(
    git.commits.ok
      ? commitsField(git.commits.value, counts.requestsTotal)
      : field('Commits this session', gitValue(git.commits.reason)),
  );

  // ---- Resume / Pane ----
  const resume = [
    field('Resume', {code: `claude --resume ${model.sessionId}`}),
  ];
  if (model.cmux.workspace != null) {
    resume.push(
      field(
        'Pane',
        {code: `cmux select-workspace --workspace ${model.cmux.workspace}`},
        ...(model.cmux.surface != null
          ? [` (surface ${model.cmux.surface})`]
          : []),
      ),
    );
  } else if (model.cmux.surface != null) {
    // No workspace id: say which surface, but print no command — `cmux
    // --help` (checked 2026-10-11) has no command that focuses a surface.
    resume.push(
      field(
        'Pane',
        `cmux surface ${model.cmux.surface}`,
        ' (no workspace id recorded)',
      ),
    );
  }

  const tildePieces = (pieces: Piece[]): Piece[] =>
    pieces.map((piece) =>
      typeof piece === 'string'
        ? tildeText(piece)
        : 'strong' in piece
          ? {strong: tildeText(piece.strong)}
          : piece,
    );
  const tildeSub = (items: PartSubItem[]): PartSubItem[] =>
    items.map((item) => ({
      sub: tildeSub(item.sub),
      text: tildePieces(item.text),
    }));
  const tilded = (fields: PartField[]): PartField[] =>
    fields.map((entry) => ({
      label: entry.label,
      sub: tildeSub(entry.sub),
      value: tildePieces(entry.value),
    }));
  const problem = delta == null ? null : baselineProblem(delta.baseline);
  // home-base-88y8m D4: verbatim, so no tildeText; the time is thread show's.
  const claude = input.message ?? null;
  const claudeMessage: ClaudeMessageView | null =
    claude == null
      ? null
      : 'problem' in claude
        ? {at: null, problem: tildeText(claude.problem), text: null}
        : {
            at: claude.at == null ? null : absoluteWhen(claude.at, timeZone),
            problem: null,
            text: claude.text,
          };
  // home-base-88y8m D5: numbered after the last question of the full list.
  const otherItems = input.messageQuestions?.items ?? [];
  return {
    beadProblems: beads.problems.map(tildeText),
    changes: changes?.view ?? null,
    claudeMessage,
    deltaProblem: problem == null ? null : tildeText(problem),
    git: tilded(gitFields),
    messages: messages.map((message) => ({
      label: message.label,
      note: message.note == null ? null : tildeText(message.note),
      quote: message.quote,
    })),
    otherQuestions:
      otherItems.length === 0
        ? null
        : {firstNumber: ordered.length + 1, items: otherItems},
    progress,
    questionIdNotes,
    questionIds: new Map(
      [...ids.byId].map(([id, shown]) => [id, shown.text] as const),
    ),
    questionShown: shownById,
    questions: changes?.keptQuestions ?? openQuestions(model),
    questionsNote: compactQuestionsNote(compactNumbers),
    requests: changes?.keptRequests ?? requests,
    resume: tilded(resume),
    session: field(
      'Session',
      tildeText(
        sessionDisplayName(
          model.repoTag,
          title,
          input.marks ?? sessionMarksOf(model.beads.session?.labels ?? []),
        ),
      ),
    ),
    snapshot,
    state: tilded(state),
    times: tilded(times),
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function markdownValue(value: readonly Piece[]): string {
  return value
    .map((piece) =>
      typeof piece === 'string'
        ? piece
        : 'strong' in piece
          ? `**${piece.strong}**`
          : `\`${piece.code}\``,
    )
    .join('');
}

/** A field group's bullet marker (F4): groups alternate `-` and `*`. */
export type FieldMarker = '-' | '*';

/** Sub-items under a field, two spaces deeper per level, always `-`. */
function markdownSub(items: readonly PartSubItem[], depth: number): string[] {
  return items.flatMap((item) => [
    `${pad(2 * depth)}- ${markdownValue(item.text)}`,
    ...markdownSub(item.sub, depth + 1),
  ]);
}

/**
 * A field group as a TIGHT bullet list (design item 5): one `- **Label:** …`
 * per line, no blank line inside the group, so every CommonMark renderer
 * keeps one field per line. A field's sub-items (F14) nest under it.
 *
 * F4 (home-base-vzwbj.4.9): `marker` alternates between groups. Two `-` lists
 * separated by one blank line are ONE loose list in CommonMark, so a strict
 * renderer drew no gap between the groups; a different marker starts a new
 * list, and the blank line between them stays.
 */
function markdownFields(
  fields: readonly PartField[],
  marker: FieldMarker,
): string {
  return fields
    .flatMap((entry) => [
      `${marker} **${entry.label}:** ${markdownValue(entry.value)}`,
      ...markdownSub(entry.sub, 1),
    ])
    .join('\n');
}

/**
 * The field groups in render order, each given the marker its predecessor did
 * not have. Empty groups take no marker, so the alternation is over the groups
 * that print — two adjacent printed groups never share one.
 */
function alternatingMarkers(
  groups: readonly (readonly PartField[])[],
): FieldMarker[] {
  let next: FieldMarker = '-';
  return groups.map((group) => {
    const marker = next;
    if (group.length > 0) next = next === '-' ? '*' : '-';
    return marker;
  });
}

/** The Progress section's heading, and the Questions section's. */
export const PROGRESS_HEADING = 'Progress';
export const QUESTIONS_HEADING = 'Questions for you';

/**
 * home-base-1rxt0.4 D2: 🆕 or 🔄 and a space, right after an item's number,
 * so it is the first thing on the line; '' for neither.
 */
function markText(mark: ItemMark | null): string {
  return mark == null ? '' : `${markEmoji(mark)} `;
}

/**
 * One request as a numbered markdown item: its line (title in bold, the
 * request being what Justin asked for), its stage, and its children. The
 * children are sibling list items: two empty lines apart (MARKDOWN_ITEM_GAP).
 */
function markdownRequest(request: RequestView, number: number): string {
  const marker = `${number}. `;
  const indent = pad(marker.length);
  const blocked = request.blockedOn == null ? '' : ` — ${request.blockedOn}`;
  return spacedList([
    `${marker}${markText(request.mark)}${request.icon} **${request.title}** (${request.id})${blocked}`,
    request.stage == null ? '' : `${indent}**Stage:** ${request.stage}`,
    `${indent}**Now:** ${request.stateLine}`,
    markdownItems(
      request.children.map(
        (child) => `${indent}- ${child.icon} ${child.title} (${child.id})`,
      ),
    ),
  ]);
}

/**
 * home-base-88y8m D1: an item's number. Under `--changes`, the number the full
 * report gives it, so a kept item reads the same in both; else its place.
 */
function itemNumber(
  numbers: ReadonlyMap<string, number> | undefined,
  id: string,
  index: number,
): number {
  return numbers?.get(id) ?? index + 1;
}

/**
 * `## Progress`: the count, any unread export, then every request (under
 * `--changes`, home-base-88y8m D1: the kept ones, then the count line).
 */
function markdownProgress(view: PartOneView): string {
  const changes = view.changes ?? null;
  return spacedList([
    `## ${PROGRESS_HEADING}`,
    `**${view.progress}**`,
    ...view.beadProblems.map(
      (problem) =>
        `⚠️ ${problem} — requests and questions there are not shown.`,
    ),
    view.deltaProblem == null ? '' : `⚠️ ${view.deltaProblem}`,
    changes?.allShown == null ? '' : `*${changes.allShown}*`,
    markdownItems(
      view.requests.map((request, index) =>
        markdownRequest(
          request,
          itemNumber(changes?.requestNumbers, request.id, index),
        ),
      ),
    ),
    changes?.requestsUnchanged == null ? '' : `*${changes.requestsUnchanged}*`,
  ]);
}

/**
 * Whether Questions for you prints: any open question, or (D1, `--changes`)
 * a line about the ones left out or answered.
 */
function questionsSectionShows(view: PartOneView): boolean {
  return (
    view.questions.length > 0 ||
    view.changes?.questionsUnchanged != null ||
    view.changes?.answered != null
  );
}

/**
 * His messages, each label over a `>` quote (one empty line between: a quote
 * keeps an empty row around it). A note (unknown, none captured) is not his
 * words, so it is never quoted.
 */
function markdownMessages(messages: readonly MessageView[]): string {
  return spacedList(
    messages.map((message) =>
      spacedList([
        `**${message.label}:**`,
        message.quote == null
          ? `*${message.note ?? ''}*`
          : `> ${message.quote}`,
      ]),
    ),
  );
}

/** home-base-88y8m D5 and D4: the two sections after Questions for you. */
export const OTHER_QUESTIONS_HEADING = 'Other questions the message names';
export const CLAUDE_MESSAGE_HEADING = 'From Claude';

/** D5: a named question's state, in words. */
function stateWords(state: NamedQuestionState): string {
  switch (state.kind) {
    case 'open':
      return 'open';
    case 'answered':
      return 'answered';
    case 'closed':
      return state.reason == null
        ? 'closed, with no answer'
        : `closed, with no answer (${state.reason})`;
  }
}

/** D5: the line over a named question: its id, session, repo and state. */
function otherQuestionHead(
  item: Extract<MessageQuestionItem, {kind: 'question'}>,
): string {
  const from =
    item.session == null
      ? `in ${item.repo}`
      : `from the session "${item.session.title ?? item.session.id}" (${item.session.id}), in ${item.repo}`;
  return `${item.shortId}, ${from}: ${stateWords(item.state)}`;
}

/**
 * D5: each named question with the number it is shown under, counting on from
 * `firstNumber` (notes take none).
 */
function numberedOtherItems(
  view: OtherQuestionsView,
): {item: MessageQuestionItem; number: number}[] {
  let next = view.firstNumber;
  return view.items.map((item) => {
    if (item.kind === 'note') return {item, number: 0};
    const number = next;
    next += 1;
    return {item, number};
  });
}

/**
 * home-base-88y8m.3 F2: a named question that is not open (answered or
 * closed) prints no "If you don't answer" line, which would read as if it
 * still needed him. An open one keeps it.
 */
function settledIds(
  item: Extract<MessageQuestionItem, {kind: 'question'}>,
): ReadonlySet<string> {
  return item.state.kind === 'open' ? new Set() : new Set([item.issue.id]);
}

/** D5, markdown: `## Other questions the message names`, or '' for none. */
function markdownOtherQuestions(view: PartOneView): string {
  const other = view.otherQuestions ?? null;
  if (other == null) return '';
  return spacedList([
    `## ${OTHER_QUESTIONS_HEADING}`,
    ...numberedOtherItems(other).map(({item, number}) =>
      item.kind === 'note'
        ? `*${item.text}*`
        : spacedList([
            `**${tildeText(otherQuestionHead(item))}**`,
            renderAsks([item.issue], {
              ids: new Map([[item.issue.id, item.shortId]]),
              itemGap: 2,
              numbers: new Map([[item.issue.id, number]]),
              style: {color: false, width: null},
              withoutDefault: settledIds(item),
            }),
            item.state.kind === 'answered'
              ? spacedList([
                  '**Answer:**',
                  item.state.answer
                    .split('\n')
                    .map((line) => `> ${line}`)
                    .join('\n'),
                ])
              : '',
          ]),
    ),
  ]);
}

/**
 * D4, markdown: `## From Claude` with the message verbatim, or '' for none.
 * Its time is given only where it was stored (`thread show`).
 */
function markdownClaudeMessage(view: PartOneView): string {
  const message = view.claudeMessage ?? null;
  if (message == null) return '';
  return spacedList([
    `## ${CLAUDE_MESSAGE_HEADING}`,
    message.at == null ? '' : `*Written ${message.at}.*`,
    message.problem == null ? (message.text ?? '') : `⚠️ ${message.problem}`,
  ]);
}

function renderMarkdown(view: PartOneView): string {
  const changes = view.changes ?? null;
  const questions = !questionsSectionShows(view)
    ? ''
    : spacedList([
        `## ${QUESTIONS_HEADING}`,
        renderAsks(view.questions, {
          ids: view.questionIds,
          itemGap: 2,
          ...(changes == null ? {} : {numbers: changes.questionNumbers}),
          shown: view.questionShown,
          style: {color: false, width: null},
        }),
        changes?.questionsUnchanged == null
          ? ''
          : `*${changes.questionsUnchanged}*`,
        changes?.answered == null ? '' : `*${changes.answered}*`,
        view.questionsNote == null ? '' : `*${view.questionsNote}*`,
        ...view.questionIdNotes.map((note) => `*${note}*`),
      ]);
  const [timesMarker, stateMarker, gitMarker, resumeMarker] =
    alternatingMarkers([view.times, view.state, view.git, view.resume]);
  const sections = [
    `**${view.session.label}:** ${markdownValue(view.session.value)}`,
    spacedList([
      markdownFields(view.times, timesMarker ?? '-'),
      markdownFields(view.state, stateMarker ?? '*'),
    ]),
    markdownProgress(view),
    markdownMessages(view.messages),
    questions,
    markdownOtherQuestions(view),
    markdownClaudeMessage(view),
    spacedList([
      markdownFields(view.git, gitMarker ?? '-'),
      markdownFields(view.resume, resumeMarker ?? '*'),
    ]),
  ].filter((section) => section !== '');
  // The Session field stays the first line after the rule: the strip rule
  // (pastedPartOneEnd) recognises a pasted Part 1 by it.
  return spacedList([
    PART_ONE_RULE,
    sections.join(`\n\n${PART_ONE_SECTION_RULE}\n\n`),
    PART_ONE_SEPARATOR,
  ]);
}

function ansiValue(value: readonly Piece[], color: boolean): string {
  return value
    .map((piece) =>
      typeof piece === 'string'
        ? piece
        : 'strong' in piece
          ? paint(piece.strong, ['bold'], color)
          : paint(piece.code, ['cyan'], color),
    )
    .join('');
}

function ansiFields(
  fields: readonly PartField[],
  labelWidth: number,
  style: OutputStyle,
): string {
  // F14: a field's sub-items sit under its VALUE column, two deeper per level.
  const subLines = (items: readonly PartSubItem[], depth: number): string[] =>
    items.flatMap((item) => {
      const indent = BODY_COLUMN + labelWidth + 2 * (depth - 1);
      return [
        wrapHanging(
          `${paint('-', ['dim'], style.color)} ${ansiValue(item.text, style.color)}`,
          {hang: indent + 2, indent, width: style.width},
        ),
        ...subLines(item.sub, depth + 1),
      ];
    });
  return fields
    .flatMap((entry) => [
      wrapHanging(
        `${paint(`${entry.label}:`, ['bold'], style.color)}${pad(labelWidth - displayWidth(`${entry.label}:`))}${ansiValue(entry.value, style.color)}`,
        {
          hang: BODY_COLUMN + labelWidth,
          indent: BODY_COLUMN,
          width: style.width,
        },
      ),
      ...subLines(entry.sub, 1),
    ])
    .join('\n');
}

/** The Progress section on a TTY: header, count, unread exports, requests. */
function ansiProgress(view: PartOneView, style: OutputStyle): string {
  const {color, width} = style;
  const blocks: string[] = [
    sectionHeader(PROGRESS_HEADING, {color, emoji: '📈'}),
    wrapHanging(paint(view.progress, ['bold'], color), {
      hang: BODY_COLUMN,
      indent: BODY_COLUMN,
      width,
    }),
  ];
  for (const problem of view.beadProblems) {
    blocks.push(
      wrapHanging(
        `⚠️ ${problem} — requests and questions there are not shown.`,
        {hang: BODY_COLUMN + 3, indent: BODY_COLUMN, width},
      ),
    );
  }
  if (view.deltaProblem != null) {
    blocks.push(
      wrapHanging(`⚠️ ${view.deltaProblem}`, {
        hang: BODY_COLUMN + 3,
        indent: BODY_COLUMN,
        width,
      }),
    );
  }
  const changes = view.changes ?? null;
  const italic = (text: string): string =>
    wrapHanging(paint(text, ['italic'], color), {
      hang: BODY_COLUMN,
      indent: BODY_COLUMN,
      width,
    });
  if (changes?.allShown != null) blocks.push(italic(changes.allShown));
  view.requests.forEach((request, index) => {
    const marker = `${itemNumber(changes?.requestNumbers, request.id, index)}. `;
    const parts = [
      wrapHanging(
        `${paint(marker, ['bold'], color)}${markText(request.mark)}${request.icon} ${paint(request.title, ['bold'], color)} ${paint(`(${request.id})`, ['dim'], color)}${request.blockedOn == null ? '' : ` — ${paint(request.blockedOn, ['bold', 'red'], color)}`}`,
        {hang: BODY_COLUMN + marker.length, indent: BODY_COLUMN, width},
      ),
    ];
    if (request.stage != null) {
      parts.push(
        wrapHanging(`${paint('Stage:', ['bold'], color)} ${request.stage}`, {
          hang: DETAIL_COLUMN,
          indent: DETAIL_COLUMN,
          width,
        }),
      );
    }
    parts.push(
      wrapHanging(`${paint('Now:', ['bold'], color)} ${request.stateLine}`, {
        hang: DETAIL_COLUMN,
        indent: DETAIL_COLUMN,
        width,
      }),
    );
    for (const child of request.children) {
      parts.push(
        wrapHanging(
          `${paint('-', ['dim'], color)} ${child.icon} ${child.title} ${paint(`(${child.id})`, ['dim'], color)}`,
          {hang: DETAIL_COLUMN + 2, indent: DETAIL_COLUMN, width},
        ),
      );
    }
    blocks.push(parts.join('\n\n'));
  });
  if (changes?.requestsUnchanged != null) {
    blocks.push(italic(changes.requestsUnchanged));
  }
  return spacedList(blocks);
}

/** His messages on a TTY: a bold label, the quote under it behind a dim bar. */
function ansiMessages(
  messages: readonly MessageView[],
  style: OutputStyle,
): string {
  const {color, width} = style;
  return spacedList(
    messages.map((message) =>
      [
        wrapHanging(paint(`${message.label}:`, ['bold'], color), {
          hang: BODY_COLUMN,
          indent: BODY_COLUMN,
          width,
        }),
        wrapHanging(
          message.quote == null
            ? paint(message.note ?? '', ['italic'], color)
            : `${paint('▎', ['dim'], color)} ${paint(message.quote, ['italic'], color)}`,
          {hang: DETAIL_COLUMN + 2, indent: DETAIL_COLUMN, width},
        ),
      ].join('\n'),
    ),
  );
}

/** D5 on a TTY: the same section as markdownOtherQuestions, or ''. */
function ansiOtherQuestions(view: PartOneView, style: OutputStyle): string {
  const other = view.otherQuestions ?? null;
  if (other == null) return '';
  const {color, width} = style;
  const body = (text: string, styles: StyleName[]): string =>
    wrapHanging(paint(text, styles, color), {
      hang: BODY_COLUMN,
      indent: BODY_COLUMN,
      width,
    });
  return spacedList([
    sectionHeader(OTHER_QUESTIONS_HEADING, {color, emoji: '🔎'}),
    ...numberedOtherItems(other).map(({item, number}) =>
      item.kind === 'note'
        ? body(item.text, ['italic'])
        : spacedList([
            body(tildeText(otherQuestionHead(item)), ['bold']),
            renderAsks([item.issue], {
              ids: new Map([[item.issue.id, item.shortId]]),
              numbers: new Map([[item.issue.id, number]]),
              style,
              withoutDefault: settledIds(item),
            }),
            item.state.kind === 'answered'
              ? [
                  wrapHanging(paint('Answer:', ['bold'], color), {
                    hang: DETAIL_COLUMN,
                    indent: DETAIL_COLUMN,
                    width,
                  }),
                  ...item.state.answer
                    .split('\n')
                    .map((line) =>
                      wrapHanging(
                        `${paint('▎', ['dim'], color)} ${paint(line, ['italic'], color)}`,
                        {hang: DETAIL_COLUMN + 2, indent: DETAIL_COLUMN, width},
                      ),
                    ),
                ].join('\n')
              : '',
          ]),
    ),
  ]);
}

/**
 * D4 on a TTY: the message's lines as written, indented under the header and
 * never rewrapped (D4: no rewrapping), or ''.
 */
function ansiClaudeMessage(view: PartOneView, style: OutputStyle): string {
  const message = view.claudeMessage ?? null;
  if (message == null) return '';
  const {color} = style;
  const indented = (text: string): string =>
    text
      .split('\n')
      .map((line) => (line === '' ? '' : `${pad(BODY_COLUMN)}${line}`))
      .join('\n');
  return spacedList([
    sectionHeader(CLAUDE_MESSAGE_HEADING, {color, emoji: '💬'}),
    message.at == null
      ? ''
      : indented(paint(`Written ${message.at}.`, ['italic'], color)),
    indented(
      message.problem == null ? (message.text ?? '') : `⚠️ ${message.problem}`,
    ),
  ]);
}

function renderAnsi(view: PartOneView, style: OutputStyle): string {
  const all = [
    view.session,
    ...view.times,
    ...view.state,
    ...view.git,
    ...view.resume,
  ];
  const labelWidth = all.reduce(
    (widest, entry) => Math.max(widest, displayWidth(`${entry.label}:`) + 2),
    0,
  );
  const changes = view.changes ?? null;
  const questions = !questionsSectionShows(view)
    ? ''
    : spacedList([
        sectionHeader(QUESTIONS_HEADING, {color: style.color, emoji: '🙋'}),
        renderAsks(view.questions, {
          ids: view.questionIds,
          ...(changes == null ? {} : {numbers: changes.questionNumbers}),
          shown: view.questionShown,
          style,
        }),
        ...[
          changes?.questionsUnchanged ?? null,
          changes?.answered ?? null,
          view.questionsNote,
          ...view.questionIdNotes,
        ].map((note) =>
          note == null
            ? ''
            : wrapHanging(paint(note, ['italic'], style.color), {
                hang: BODY_COLUMN,
                indent: BODY_COLUMN,
                width: style.width,
              }),
        ),
      ]);
  const sections = [
    ansiFields([view.session], labelWidth, style),
    spacedList([
      ansiFields(view.times, labelWidth, style),
      ansiFields(view.state, labelWidth, style),
    ]),
    ansiProgress(view, style),
    ansiMessages(view.messages, style),
    questions,
    ansiOtherQuestions(view, style),
    ansiClaudeMessage(view, style),
    spacedList([
      ansiFields(view.git, labelWidth, style),
      ansiFields(view.resume, labelWidth, style),
    ]),
  ].filter((section) => section !== '');
  const rule = `${pad(HEADER_COLUMN)}${paint(ANSI_SECTION_RULE, ['dim'], style.color)}`;
  // The same order and the same sections as the markdown; one blank line is
  // one row on a terminal, so nothing here needs two.
  return spacedList([
    PART_ONE_RULE,
    sections.join(`\n\n${rule}\n\n`),
    PART_ONE_SEPARATOR,
  ]);
}

/** Part 1: markdown when uncoloured (a pipe), ANSI when coloured (a TTY). */
export function renderPartOne(view: PartOneView, style: OutputStyle): string {
  return style.color ? renderAnsi(view, style) : renderMarkdown(view);
}

// ---------------------------------------------------------------------------
// The strip rule (thread show)
// ---------------------------------------------------------------------------

/** A line that is only 🛑 — three or more — is the rule. */
export function isRuleLine(line: string): boolean {
  return /^(?:🛑){3,}$/u.test(line.trim());
}

/**
 * A line that is only ♒ — three or more, each with or without the emoji
 * variation selector — is the separator; so is one of only box-drawing
 * dashes, the separator before home-base-1rxt0.4 D1.
 */
export function isSeparatorLine(line: string): boolean {
  return /^(?:─{3,}|(?:♒️?){3,})$/u.test(line.trim());
}

/**
 * A line made only of 🕉 (each with or without the emoji variation selector,
 * spaces between allowed): the legacy report's closing rule
 * (render-markdown.ts RULE_OM), which ends the search for a pasted Part 1's
 * separator (R6). home-base-88y8m.3 F3: only such a line, never a sentence
 * that mentions 🕉, which used to end the search and so got Claude's message
 * refused by `thread status --message`.
 */
export function isOmRuleLine(line: string): boolean {
  return /^(?:🕉️?\s*)+$/u.test(line.trim());
}

/**
 * Part 1's first field: `- **Session:**` (or `* **Session:**`, the marker
 * home-base-vzwbj.4.9 F4 may alternate to) or a bare `**Session:**`.
 */
export function isSessionFieldLine(line: string): boolean {
  return /^(?:[-*] )?\*\*Session:\*\*/u.test(line.trim());
}

/** The end of a pasted Part 1 that starts at `rule`, or null when it is not one. */
function pastedPartOneEnd(
  lines: readonly string[],
  rule: number,
): number | null {
  // R6: only a real Part 1 — its first non-blank line is the Session field.
  let first = rule + 1;
  while (first < lines.length && (lines[first] ?? '').trim() === '') first += 1;
  if (!isSessionFieldLine(lines[first] ?? '')) return null;
  // R6: bounded — another 🛑 rule or a 🕉️ rule line ends the search
  // unstripped (F3: a line made of 🕉, not one that mentions it).
  for (let at = first + 1; at < lines.length; at += 1) {
    const candidate = lines[at] ?? '';
    if (isSeparatorLine(candidate)) return at;
    if (isRuleLine(candidate) || isOmRuleLine(candidate)) return null;
  }
  return null;
}

/**
 * home-base-88y8m D2: the first Part 1 block in `text`, from its 🛑 rule
 * through its ♒ separator, inclusive, with nothing before or after it; null
 * when `text` holds no such block. The same bounds as the strip rule below,
 * so it is only ever a real Part 1 (its first field is Session).
 */
export function partOneBlockOf(text: string): string | null {
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (!isRuleLine(lines[index] ?? '')) continue;
    const end = pastedPartOneEnd(lines, index);
    if (end != null) return lines.slice(index, end + 1).join('\n');
  }
  return null;
}

/**
 * `text` with every pasted Part 1 removed: from a line that is the 🛑 rule
 * through the next line that is the `───` separator, inclusive (D4: the stored
 * copy goes stale the moment it is pasted, so `thread show` regenerates it
 * live).
 *
 * BOUNDED (home-base-vzwbj.4.9 R6): a block is stripped only when the first
 * non-blank line after the rule is Part 1's Session field, and the search for
 * its separator stops at the next 🛑 rule or a 🕉️ line. Otherwise everything
 * is LEFT IN PLACE: a legacy report (🛑 rule … 🕉️, no separator) followed
 * later by any `───` line, or a lone line of 🛑 used for emphasis, used to
 * delete everything between them — Claude's own message included.
 */
export function stripPastedPartOne(text: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (isRuleLine(line)) {
      const end = pastedPartOneEnd(lines, index);
      if (end != null) {
        index = end + 1;
        continue;
      }
    }
    kept.push(line);
    index += 1;
  }
  return kept
    .join('\n')
    .replace(/^\s*\n/, '')
    .trim();
}
