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
 *   ─── separator — the line `thread show` strips a pasted Part 1 through
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

import type {OutputStyle} from '../cli-style';
import type {ActionLine, OptionalLine} from './session-card';
import type {SessionCommits} from './session-commits';
import type {SessionModel} from './session-model';
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
import {parseInstant} from './answer-store';
import {ARCHIVED_PREFIX, DONE_PREFIX} from './ask-format';
import {renderAsks, sortAsks} from './ask-render';
import {cutOnWord} from './session-bead';
import {firstUserLine, newestLogAt, userLines} from './session-model';
import {sessionDisplayName} from './session-name';
import {isOpen, openQuestions, stageReached} from './session-status';

/** The legacy report's rule (render-markdown.ts RULE_STOP), kept identical. */
// Six, not 28 (Justin, 2026-10-24): a longer run fills the phone notification
// that shows the start of the report. Detection (isRuleLine) needs three.
export const PART_ONE_RULE = '🛑'.repeat(6);

/** The end of Part 1, and what `thread show` strips through. */
export const PART_ONE_SEPARATOR = '─'.repeat(28);

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
  /** "tested — next: built", or null when no stage label is on the ladder. */
  stage: string | null;
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

export interface PartOneView {
  /** Beads exports that could not be read, said above the requests. */
  beadProblems: string[];
  /** Repo / Branch / Worktree / Context / Uncommitted / Unpushed / Commits. */
  git: PartField[];
  /** Your first message, then Your last message when it differs (F10). */
  messages: MessageView[];
  /** "1 of 3 requests done", or why the count is unknown. */
  progress: string;
  /** The OPEN questions; `renderAsks` orders them, P0 first. */
  questions: TreeIssue[];
  requests: RequestView[];
  resume: PartField[];
  /** The Session field: `[REPO] title`. */
  session: PartField;
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
      return '🧯 Out of context';
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
  counts: StatusCounts;
  model: SessionModel;
  now: Date;
  /** The dashboard's "Optional" line (`optionalLine`), null when none. */
  optional: OptionalLine | null;
  status: SessionStatus;
  /** IANA zone for times; undefined = this machine's. Tests pin it. */
  timeZone?: string;
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

export function partOneView(input: PartOneInput): PartOneView {
  const {counts, model, status, timeZone} = input;
  const {beads, git, transcript} = model;

  // ---- Session / Your first message / Started / Last activity ----
  // An unreadable export is named once, under Requests; here it is pointed at.
  const title =
    beads.session != null
      ? beads.session.title
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

  // ---- Progress ----
  const done = `${counts.requestsDone} of ${plural(counts.requestsTotal, 'request', 'requests')} done`;
  // With an export unread, "no requests filed" would be a claim nobody
  // checked (rule 7): the count is unknown, not zero.
  const progress =
    beads.problems.length > 0
      ? counts.requestsTotal === 0
        ? 'Requests: unknown (the beads could not be read)'
        : `${done} (⚠️ some beads could not be read)`
      : counts.requestsTotal === 0
        ? 'No requests filed.'
        : done;

  // ---- Requests ----
  const ordered = sortAsks(openQuestions(model));
  const requests: RequestView[] = beads.requests.map((node) => {
    const blocking = blockingNumbers(node, ordered);
    const stage = stageReached(node.request.labels, model.stages);
    const open = isOpen(node.request);
    return {
      blockedOn:
        open && blocking.length > 0
          ? `blocked on ${blocking.length === 1 ? 'question' : 'questions'} ${blocking.join(', ')}`
          : null,
      children: node.children.map((child) => ({
        icon: isOpen(child) ? '🔲' : '✅',
        id: child.id,
        title: child.title,
      })),
      icon: !open ? '✅' : blocking.length > 0 ? '🛑' : '🔲',
      id: node.request.id,
      stage:
        stage == null
          ? null
          : stage.next == null
            ? `${stage.reached} (the last stage)`
            : `${stage.reached} — next: ${stage.next}`,
      title: node.request.title,
    };
  });

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

  gitFields.push(
    field(
      'Context',
      !transcript.contextTokens.ok
        ? unknownBecause(transcript.contextTokens.reason)
        : model.wrapUpAt != null
          ? `${tokensWords(transcript.contextTokens.value).replace(' tokens', '')} of ${tokensWords(model.wrapUpAt)}`
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
  return {
    beadProblems: beads.problems.map(tildeText),
    git: tilded(gitFields),
    messages: messages.map((message) => ({
      label: message.label,
      note: message.note == null ? null : tildeText(message.note),
      quote: message.quote,
    })),
    progress,
    questions: openQuestions(model),
    requests,
    resume: tilded(resume),
    session: field(
      'Session',
      tildeText(sessionDisplayName(model.repoTag, title)),
    ),
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
 * One request as a numbered markdown item: its line (title in bold, the
 * request being what Justin asked for), its stage, and its children. The
 * children are sibling list items: two empty lines apart (MARKDOWN_ITEM_GAP).
 */
function markdownRequest(request: RequestView, number: number): string {
  const marker = `${number}. `;
  const indent = pad(marker.length);
  const blocked = request.blockedOn == null ? '' : ` — ${request.blockedOn}`;
  return spacedList([
    `${marker}${request.icon} **${request.title}** (${request.id})${blocked}`,
    request.stage == null ? '' : `${indent}**Stage:** ${request.stage}`,
    markdownItems(
      request.children.map(
        (child) => `${indent}- ${child.icon} ${child.title} (${child.id})`,
      ),
    ),
  ]);
}

/** `## Progress`: the count, any unread export, then every request. */
function markdownProgress(view: PartOneView): string {
  return spacedList([
    `## ${PROGRESS_HEADING}`,
    `**${view.progress}**`,
    ...view.beadProblems.map(
      (problem) =>
        `⚠️ ${problem} — requests and questions there are not shown.`,
    ),
    markdownItems(
      view.requests.map((request, index) =>
        markdownRequest(request, index + 1),
      ),
    ),
  ]);
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

function renderMarkdown(view: PartOneView): string {
  const questions =
    view.questions.length === 0
      ? ''
      : spacedList([
          `## ${QUESTIONS_HEADING}`,
          renderAsks(view.questions, {
            itemGap: 2,
            style: {color: false, width: null},
          }),
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
  view.requests.forEach((request, index) => {
    const marker = `${index + 1}. `;
    const parts = [
      wrapHanging(
        `${paint(marker, ['bold'], color)}${request.icon} ${paint(request.title, ['bold'], color)} ${paint(`(${request.id})`, ['dim'], color)}${request.blockedOn == null ? '' : ` — ${paint(request.blockedOn, ['bold', 'red'], color)}`}`,
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
  const questions =
    view.questions.length === 0
      ? ''
      : spacedList([
          sectionHeader(QUESTIONS_HEADING, {color: style.color, emoji: '🙋'}),
          renderAsks(view.questions, {style}),
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
function isRuleLine(line: string): boolean {
  return /^(?:🛑){3,}$/u.test(line.trim());
}

/** A line that is only box-drawing dashes — three or more — is the separator. */
function isSeparatorLine(line: string): boolean {
  return /^─{3,}$/u.test(line.trim());
}

/**
 * Part 1's first field: `- **Session:**` (or `* **Session:**`, the marker
 * home-base-vzwbj.4.9 F4 may alternate to) or a bare `**Session:**`.
 */
function isSessionFieldLine(line: string): boolean {
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
  // R6: bounded — another 🛑 rule or a 🕉️ line ends the search unstripped.
  for (let at = first + 1; at < lines.length; at += 1) {
    const candidate = lines[at] ?? '';
    if (isSeparatorLine(candidate)) return at;
    if (isRuleLine(candidate) || candidate.includes('🕉')) return null;
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
