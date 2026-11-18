/**
 * `thread messages` (home-base-z7o2m D2, D5, D6): every message Justin typed
 * in a session and in the sessions before it in its handoff chain, his words
 * only. Filter by words or a regex (the same semantics as `thread search`),
 * by date and by count; `--context <id>` prints one message with the log
 * lines around it, his and Claude's; `--annotate` adds what Claude did with
 * each message, from the transcript.
 *
 * THE WINDOW (home-base-6ujwi D1, D4). `--sessions <n>`: only the n sessions
 * of the chain that end at the start session (the current one, or the one
 * `--chain` names), oldest first. A chain with fewer says how many it has.
 * Without it, the sessions read are exactly as before.
 *
 * PRIVATE SESSIONS (home-base-6ujwi D3). Every session read is checked with
 * privacy.ts's sessionPrivacy, its working directories taken from its own
 * message log (every line records one). A private session's messages are
 * never printed, with or without `--sessions`, nor its text searched: the
 * output names it and counts the messages of his it left out. A check that
 * cannot decide counts as private, with its reason. It still counts as one of
 * the n sessions. `--context` refuses a message of a private session.
 *
 * Justin, 2026-11-15: "if there was an easy way for you to just sort of print
 * those, if there was an easy way for you to search or filter those, ... I
 * could say something like, I asked you a question about such and such in a
 * previous session. Can you answer that question for me?"
 *
 * EXIT CODES, the same contract as `thread search`: 0 printed messages, 1
 * measured none, 2 could not read (a chain or a log it could not read,
 * printed above the messages, or a bad flag). Messages are printed on the 2
 * path too. Messages left out as private are not "none": the output names
 * them, and with nothing else to print the exit is 1.
 */

import type {Field} from '../cli-style';
import type {ChainMember, ChainWalk, ChainWalkReaders} from './chain-walk';
import type {JustinMessage, SessionMessages} from './justin-messages';
import type {MessageLogRead} from './message-log';
import type {EnvLike} from './paths';
import type {Privacy} from './privacy';
import type {MessageActions} from './transcript-actions';

import {
  BODY_COLUMN,
  fieldLines,
  HEADER_COLUMN,
  highlight,
  pad,
  paint,
  sectionHeader,
  shouldStyle,
  terminalWidth,
  wrapHanging,
} from '../cli-style';
import {formatLocalDate, formatLocalTime} from '../date';
import {sdkRun} from '../sdk-invocation';
import {writeStdout} from '../write-stdout';
import {
  realChainWalkReaders,
  registryChainNames,
  resolveChainStart,
  sessionBeadOf,
  sessionIdsStartingWith,
  walkChain,
} from './chain-walk';
import {findTranscript} from './facts';
import {classifySessionLog, parseMessageId} from './justin-messages';
import {readMessageLog} from './message-log';
import {ownerOf, sessionPrivacy} from './privacy';
import {compileQuery, parseWrittenSince} from './search';
import {annotateFromTranscript, replyPreview} from './transcript-actions';

/** One step in from BODY_COLUMN (cli-style's uniform step). */
const TEXT_COLUMN = BODY_COLUMN + (BODY_COLUMN - HEADER_COLUMN);
const DETAIL = TEXT_COLUMN + (BODY_COLUMN - HEADER_COLUMN);

export const CONTEXT_BEFORE = 2;
export const CONTEXT_AFTER = 5;

export interface ThreadMessagesOptions {
  /** `--after`: log lines after the message in `--context` (default 5). */
  after?: number;
  annotate?: boolean;
  /** `--before`: log lines before the message in `--context` (default 2). */
  before?: number;
  /** `--chain <name|bead|session>`; null: the current session's chain. */
  chain?: null | string;
  color?: boolean;
  /** `--context <id>`: one message and the lines around it. */
  context?: null | string;
  cwd?: string;
  env?: EnvLike;
  json?: boolean;
  /** Keep the newest n matches; null or 0 keeps all. */
  limit?: null | number;
  newestFirst?: boolean;
  now?: Date;
  /** Injected in tests; privacy.ts's sessionPrivacy otherwise (D3). */
  privacyOf?: PrivacyCheck;
  query?: null | string;
  /** Injected in tests; the real readers otherwise. */
  readers?: ChainWalkReaders;
  regex?: boolean;
  /**
   * `--sessions <n>` (D1): only the n sessions ending at the start session.
   * A positive whole number; anything else exits 2. Null: no window.
   */
  sessions?: null | number | string;
  /** Wrap width; `terminalWidth()` when absent, null never wraps. */
  width?: null | number;
  writtenSince?: null | string;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Whether a session is private (D3): privacy.ts's sessionPrivacy for its id
 * and its working directories. Injected in tests.
 */
export type PrivacyCheck = (
  sessionId: string,
  cwds: readonly string[],
) => Privacy;

export function realPrivacyCheck(env: EnvLike): PrivacyCheck {
  return (sessionId, cwds) => sessionPrivacy(ownerOf(sessionId, cwds), env);
}

export interface SessionRead {
  member: ChainMember;
  /** Null when the log could not be read: `problem` says why. */
  messages: null | SessionMessages;
  /**
   * The privacy verdict (D3); null when the log could not be read, so there
   * is nothing of his to print or withhold.
   */
  privacy: null | Privacy;
  problem: null | string;
}

export function isPrivateRead(session: SessionRead): boolean {
  return session.privacy?.kind === 'private';
}

/**
 * Every working directory a session's log records, in first-seen order. Each
 * line carries the cwd of the hook or transcript record that wrote it
 * (message-log.ts), the same directory capture.ts asks privacy.ts about.
 */
export function logCwds(lines: readonly {cwd: null | string}[]): string[] {
  const cwds: string[] = [];
  for (const line of lines) {
    if (line.cwd != null && line.cwd !== '' && !cwds.includes(line.cwd)) {
      cwds.push(line.cwd);
    }
  }
  return cwds;
}

/** One member's log, classified; a log that is missing or unreadable is a problem. */
export function readMemberMessages(
  member: ChainMember,
  readLog: (sessionId: string) => MessageLogRead,
  privacyOf: PrivacyCheck,
): SessionRead {
  if (member.sessionId == null) {
    return {
      member,
      messages: null,
      privacy: null,
      problem: member.sessionIdProblem ?? `${member.beadId} has no session id`,
    };
  }
  const log = readLog(member.sessionId);
  if (log.kind === 'missing') {
    return {
      member,
      messages: null,
      privacy: null,
      problem: `${member.name} ${member.beadId} has no message log at ${log.path}`,
    };
  }
  if (log.kind === 'failed') {
    return {
      member,
      messages: null,
      privacy: null,
      problem: `the message log of ${member.name} ${member.beadId} could not be read: ${log.path}: ${log.error}`,
    };
  }
  const messages = classifySessionLog({
    labels: member.labels,
    lines: log.lines,
    sessionId: member.sessionId,
  });
  // A malformed line could be one of his messages (rule 7).
  const [failure] = log.failures;
  return {
    member,
    messages,
    privacy: privacyOf(member.sessionId, logCwds(log.lines)),
    problem:
      failure == null
        ? null
        : `${failure}; any of them could be a message of his`,
  };
}

/** The `--sessions` window as read (D1, D4). */
export interface SessionsWindow {
  /** The n asked for. */
  asked: number;
  /** The start session the window ends at. */
  endsAt: string;
  /** How many sessions the window holds: fewer than `asked` when the chain is short. */
  held: number;
}

export interface ChainMessages {
  problems: string[];
  sessions: SessionRead[];
  walk: Exclude<ChainWalk, {kind: 'failed'}>;
  /** Null without `--sessions`. */
  window: null | SessionsWindow;
}

/**
 * The chain's members to read and their messages. `window` (D1): only the n
 * sessions ending at the start session. Otherwise `throughStart`: only the
 * start session and the ones before it (the default chain: this session and
 * every earlier one); else the whole chain.
 */
export function chainMessages(input: {
  privacyOf: PrivacyCheck;
  readLog: (sessionId: string) => MessageLogRead;
  throughStart: boolean;
  walk: Exclude<ChainWalk, {kind: 'failed'}>;
  window?: null | number;
}): ChainMessages {
  const {walk} = input;
  const asked = input.window ?? null;
  const end =
    input.throughStart || asked != null
      ? walk.startIndex + 1
      : walk.members.length;
  const begin = asked == null ? 0 : Math.max(0, end - asked);
  const members = walk.members.slice(begin, end);
  const sessions = members.map((member) =>
    readMemberMessages(member, input.readLog, input.privacyOf),
  );
  const problems = [
    ...(walk.kind === 'incomplete'
      ? walk.problems.map((problem) => `the chain: ${problem}`)
      : []),
    ...sessions.flatMap((session) =>
      session.problem == null ? [] : [session.problem],
    ),
  ];
  return {
    problems,
    sessions,
    walk,
    window:
      asked == null
        ? null
        : {
            asked,
            endsAt: walk.members[walk.startIndex]?.beadId ?? '?',
            held: members.length,
          },
  };
}

/**
 * `--sessions` as given: null when absent, else a positive whole number, or
 * the one-line reason it is not (exit 2).
 */
export function parseSessionsWindow(
  value: null | number | string | undefined,
): {kind: 'bad'; reason: string} | {kind: 'ok'; n: null | number} {
  if (value == null) return {kind: 'ok', n: null};
  const text = String(value).trim();
  if (/^[1-9][0-9]*$/u.test(text)) {
    const n = Number(text);
    if (Number.isSafeInteger(n)) return {kind: 'ok', n};
  }
  return {
    kind: 'bad',
    reason: `--sessions takes a positive whole number of sessions (such as 3), not ${JSON.stringify(text)}`,
  };
}

/** A private session in the sessions read, as printed (D3). */
export interface PrivateSession {
  beadId: string;
  /** False when its log has lines that could not be read: there may be more. */
  countComplete: boolean;
  /** His messages in it, none of them printed. */
  messages: number;
  name: string;
  reason: string;
  sessionId: null | string;
}

export function privateSessionsOf(
  sessions: readonly SessionRead[],
): PrivateSession[] {
  return sessions.flatMap((session) =>
    session.privacy?.kind === 'private'
      ? [
          {
            beadId: session.member.beadId,
            countComplete: session.problem == null,
            messages: session.messages?.messages.length ?? 0,
            name: session.member.name,
            reason: session.privacy.reason,
            sessionId: session.member.sessionId,
          },
        ]
      : [],
  );
}

/** One of his messages, with its session. */
export interface ListedMessage {
  member: ChainMember;
  message: JustinMessage;
}

export interface MessageCounts {
  kickoffs: number;
  machine: number;
  /** Those the query and --written-since kept, before --limit. */
  matched: number;
  /** Every message of his in the sessions read. */
  messages: number;
  /** Left out by --written-since because the log line has no time. */
  undated: number;
}

export function filterMessages(
  sessions: readonly SessionRead[],
  filters: {limit: null | number; pattern: null | RegExp; since: Date | null},
): {counts: MessageCounts; listed: ListedMessage[]} {
  const all: ListedMessage[] = sessions.flatMap((session) =>
    (session.messages?.messages ?? []).map((message) => ({
      member: session.member,
      message,
    })),
  );
  let undated = 0;
  const matched = all.filter(({message}) => {
    if (filters.pattern != null && !filters.pattern.test(message.text)) {
      return false;
    }
    if (filters.since == null) return true;
    const at = message.at == null ? NaN : Date.parse(message.at);
    if (Number.isNaN(at)) {
      undated += 1;
      return false;
    }
    return at >= filters.since.getTime();
  });
  const limit = filters.limit ?? 0;
  const listed = limit > 0 ? matched.slice(-limit) : matched;
  return {
    counts: {
      kickoffs: sessions.reduce((n, s) => n + (s.messages?.kickoffs ?? 0), 0),
      machine: sessions.reduce((n, s) => n + (s.messages?.machine ?? 0), 0),
      matched: matched.length,
      messages: all.length,
      undated,
    },
    listed,
  };
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

function whenText(at: null | string): string {
  if (at == null) return 'time unknown';
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return 'time unknown';
  return `${formatLocalDate(date)} ${formatLocalTime(date).slice(0, 5)}`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

interface Style {
  color: boolean;
  width: null | number;
}

/** His text, highlighted where the query matched. */
function bodyText(
  text: string,
  pattern: null | RegExp,
  color: boolean,
): string {
  const trimmed = text.trim();
  if (pattern == null) return trimmed;
  const global = new RegExp(
    pattern.source,
    pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
  );
  return trimmed.replace(global, (match) =>
    match === '' ? match : highlight(match, color),
  );
}

function problemLines(problems: readonly string[], style: Style): string[] {
  if (problems.length === 0) return [];
  return [
    '',
    wrapHanging(
      paint(
        `⚠️ INCOMPLETE — what is below is not every message he typed in this chain. ${plural(problems.length, 'part')} could not be read:`,
        ['bold'],
        style.color,
      ),
      {hang: BODY_COLUMN, indent: HEADER_COLUMN, width: style.width},
    ),
    ...problems.flatMap((problem) => [
      '',
      wrapHanging(`- ${problem}`, {
        hang: BODY_COLUMN + 2,
        indent: BODY_COLUMN,
        width: style.width,
      }),
    ]),
  ];
}

/** The reply line (D5): never the pasted status block. */
function replyLine(reply: null | string, style: Style): string {
  if (reply == null) {
    return `${pad(DETAIL)}${paint('no reply text in that turn', ['dim'], style.color)}`;
  }
  const preview = replyPreview(reply);
  if (preview.kind === 'blockOnly') {
    return `${pad(DETAIL)}${paint('only the status block, with no From Claude section in it and nothing after it', ['dim'], style.color)}`;
  }
  return wrapHanging(preview.text, {
    hang: DETAIL,
    indent: DETAIL,
    width: style.width,
  });
}

function annotationLines(
  annotation: MessageActions | null | undefined,
  style: Style,
): string[] {
  if (annotation === undefined) return [];
  if (annotation === null) {
    return [
      '',
      `${pad(TEXT_COLUMN)}${paint('Not found in the transcript.', ['dim'], style.color)}`,
    ];
  }
  const items = [
    ...annotation.actions,
    ...(annotation.otherCalls > 0
      ? [`and ${plural(annotation.otherCalls, 'other tool call')}`]
      : []),
  ];
  return [
    '',
    `${pad(TEXT_COLUMN)}${paint('Claude then:', ['bold'], style.color)}`,
    ...(items.length === 0
      ? [`${pad(DETAIL)}${paint('no tool calls', ['dim'], style.color)}`]
      : items.map((item) =>
          wrapHanging(`• ${item}`, {
            hang: DETAIL + 2,
            indent: DETAIL,
            width: style.width,
          }),
        )),
    '',
    `${pad(TEXT_COLUMN)}${paint('Reply:', ['bold'], style.color)}`,
    replyLine(annotation.reply, style),
  ];
}

/** The window field (D1, D4): how many sessions, ending where, and a short chain named. */
function windowText(found: ChainMessages): null | string {
  const {walk, window} = found;
  if (window == null) return null;
  const base = `${plural(window.held, 'session')}, ending at ${window.endsAt} (--sessions ${window.asked})`;
  if (window.held >= window.asked) return base;
  return walk.root == null
    ? `${base}: only ${window.held} could be read back from there; the chain is incomplete (below)`
    : `${base}: the chain has only ${plural(window.held, 'session')} up to there`;
}

/** The private sessions (D3): named, with how many of his messages each left out. */
function privateLines(
  privateSessions: readonly PrivateSession[],
  style: Style,
): string[] {
  if (privateSessions.length === 0) return [];
  return [
    '',
    wrapHanging(
      paint(
        `🔒 PRIVATE — the messages of ${privateSessions.length === 1 ? 'this session are' : 'these sessions are'} not printed:`,
        ['bold'],
        style.color,
      ),
      {hang: BODY_COLUMN, indent: HEADER_COLUMN, width: style.width},
    ),
    ...privateSessions.flatMap((session) => [
      '',
      wrapHanging(
        `- ${session.name} ${session.beadId}: ${plural(session.messages, 'message')} of his left out${session.countComplete ? '' : ', or more: its log has lines that could not be read'}. Why it counts as private: ${session.reason}.`,
        {hang: BODY_COLUMN + 2, indent: BODY_COLUMN, width: style.width},
      ),
    ]),
  ];
}

function renderList(input: {
  annotations: Map<string, MessageActions | null> | null;
  counts: MessageCounts;
  found: ChainMessages;
  listed: readonly ListedMessage[];
  newestFirst: boolean;
  pattern: null | RegExp;
  privateSessions: readonly PrivateSession[];
  query: null | string;
  sessionNotes: readonly string[];
  style: Style;
  writtenSince: Date | null;
}): string {
  const {counts, found, privateSessions, style} = input;
  const {walk} = found;
  const chainWords =
    walk.chainName == null
      ? `the chain of ${walk.members[walk.startIndex]?.beadId ?? '?'}`
      : `chain ${walk.chainName}`;
  const window = windowText(found);
  const privateMessages = privateSessions.reduce(
    (n, session) => n + session.messages,
    0,
  );
  const fields: Field[] = [
    {
      label: 'Chain',
      value: `${walk.chainName ?? 'no name'}, ${plural(walk.members.length, 'session')}${walk.root == null ? ', its first session unknown' : ` from ${walk.root}`}`,
    },
    ...(window == null ? [] : [{label: 'Window', value: window}]),
    {
      label: 'Read',
      value: `${plural(found.sessions.length, 'session')}, ${plural(counts.messages, 'message')} of his`,
    },
    ...(privateSessions.length === 0
      ? []
      : [
          {
            label: 'Private',
            value: `${plural(privateSessions.length, 'session')}, ${plural(privateMessages, 'message')} of his not printed (named below)`,
          },
        ]),
    {
      label: 'Left out',
      value: `${plural(counts.kickoffs, 'kickoff prompt')} and ${plural(counts.machine, 'machine-sent line')}`,
    },
    ...(input.query == null
      ? []
      : [
          {
            label: 'Matching',
            value: `${input.pattern == null ? input.query : `/${input.pattern.source}/i`}: ${plural(counts.matched, 'message')}`,
          },
        ]),
    ...(input.writtenSince == null
      ? []
      : [
          {
            label: 'Since',
            value: `${input.writtenSince.toISOString()}${counts.undated > 0 ? ` (${plural(counts.undated, 'undated message')} left out)` : ''}`,
          },
        ]),
    ...(input.listed.length < counts.matched
      ? [
          {
            label: 'Shown',
            value: `the newest ${input.listed.length} (--limit)`,
          },
        ]
      : []),
    {
      label: 'Order',
      value: input.newestFirst ? 'newest first' : 'oldest first',
    },
  ];
  const lines: string[] = [
    sectionHeader(
      `Justin's messages in ${chainWords}: his typed words only; Claude's replies are not shown`,
      {color: style.color, emoji: '💬'},
    ),
    '',
    fieldLines(fields, {
      color: style.color,
      indent: BODY_COLUMN,
      width: style.width,
    }),
    ...problemLines(found.problems, style),
    ...privateLines(privateSessions, style),
    ...input.sessionNotes.flatMap((note) => [
      '',
      wrapHanging(paint(note, ['dim'], style.color), {
        hang: BODY_COLUMN,
        indent: BODY_COLUMN,
        width: style.width,
      }),
    ]),
  ];
  const ordered = input.newestFirst
    ? [...input.listed].reverse()
    : input.listed;
  let lastSession: null | string = null;
  for (const {member, message} of ordered) {
    if (member.beadId !== lastSession) {
      lastSession = member.beadId;
      lines.push(
        '',
        '',
        wrapHanging(
          paint(`${member.name} ${member.title}`, ['bold'], style.color),
          {hang: BODY_COLUMN, indent: HEADER_COLUMN, width: style.width},
        ),
        `${pad(BODY_COLUMN)}${paint(`${member.beadId}, session ${member.sessionId ?? '?'}`, ['dim'], style.color)}`,
      );
    }
    lines.push(
      '',
      `${pad(BODY_COLUMN)}${paint(message.id, ['cyan'], style.color)}  ${paint(`(${whenText(message.at)})`, ['dim'], style.color)}`,
      wrapHanging(bodyText(message.text, input.pattern, style.color), {
        hang: TEXT_COLUMN,
        indent: TEXT_COLUMN,
        width: style.width,
      }),
      ...annotationLines(input.annotations?.get(message.id), style),
    );
  }
  if (ordered.length === 0) {
    const unfiltered = input.query == null && input.writtenSince == null;
    const none =
      privateMessages > 0
        ? unfiltered
          ? 'No message of his is printed: every one of them is in a private session, named above.'
          : 'No message of his matches outside the private sessions named above, whose messages were not searched.'
        : unfiltered
          ? 'He typed no messages in these sessions.'
          : 'No message of his matches.';
    lines.push('', `${pad(HEADER_COLUMN)}${none}`);
  } else {
    lines.push(
      '',
      wrapHanging(
        paint(
          `The replies around one: ${sdkRun('thread messages --context <id>')}`,
          ['dim'],
          style.color,
        ),
        {hang: BODY_COLUMN, indent: HEADER_COLUMN, width: style.width},
      ),
    );
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Annotations (D6)
// ---------------------------------------------------------------------------

function annotateSessions(
  sessions: readonly SessionRead[],
  env: EnvLike,
): {byId: Map<string, MessageActions | null>; notes: string[]} {
  const byId = new Map<string, MessageActions | null>();
  const notes: string[] = [];
  for (const session of sessions) {
    const messages = session.messages?.messages ?? [];
    const {sessionId} = session.member;
    if (messages.length === 0 || sessionId == null) continue;
    const found = findTranscript(sessionId, env);
    if (found.status !== 'found') {
      notes.push(
        found.status === 'failed'
          ? `${session.member.name}: its transcript could not be looked up (${found.error}), so its messages carry no annotations`
          : `${session.member.name}: no transcript for session ${sessionId} under ${found.searched}, so its messages carry no annotations`,
      );
      continue;
    }
    const annotated = annotateFromTranscript(found.path, messages);
    if (annotated.kind === 'failed') {
      notes.push(`${session.member.name}: ${annotated.reason}`);
      continue;
    }
    if (annotated.malformed > 0) {
      notes.push(
        `${session.member.name}: ${plural(annotated.malformed, 'line')} of its transcript were not JSON and were skipped, so its annotations may miss actions`,
      );
    }
    for (const message of messages) {
      byId.set(message.id, annotated.byId.get(message.id) ?? null);
    }
  }
  return {byId, notes};
}

// ---------------------------------------------------------------------------
// The context view (D5)
// ---------------------------------------------------------------------------

async function runContext(
  id: string,
  options: ThreadMessagesOptions,
  env: EnvLike,
  readers: ChainWalkReaders,
  style: Style,
): Promise<number> {
  const refuse = async (reason: string): Promise<number> => {
    const text = `thread messages --context ${id}: ${reason}`;
    if (options.json === true) {
      await writeStdout(
        `${JSON.stringify({error: text, ok: false}, null, 2)}\n`,
      );
    } else console.error(text);
    return 2;
  };
  const parsed = parseMessageId(id);
  if (parsed == null) {
    return await refuse(
      'not a message id: an id is the first 8 characters of a session id, a dot and a number, as `thread messages` prints them (f7a1dceb.4)',
    );
  }
  const sessions = sessionIdsStartingWith(parsed.prefix, env);
  if (sessions.kind === 'failed') return await refuse(sessions.reason);
  const [sessionId] = sessions.ids;
  if (sessionId == null) {
    return await refuse(
      `no session in the sessions index starts with ${parsed.prefix}`,
    );
  }
  if (sessions.ids.length > 1) {
    return await refuse(
      `${sessions.ids.length} sessions start with ${parsed.prefix} (${sessions.ids.join(', ')}), so the id does not name one`,
    );
  }
  // The bead's labels decide which first line is a kickoff, so the same
  // ordinals as the listing: a bead that cannot be read refuses.
  const bead = sessionBeadOf(sessionId, env);
  if (bead.kind === 'failed') return await refuse(bead.reason);
  let labels: readonly string[] = [];
  let title: null | string = null;
  if (bead.kind === 'found') {
    const read = readers.readBead(bead.beadId);
    if (read.kind !== 'found') {
      return await refuse(
        `the session bead ${bead.beadId} could not be read, so which lines are his is unknown: ${read.reason}`,
      );
    }
    labels = read.bead.labels;
    title = read.bead.title;
  }
  const log = readMessageLog(sessionId, env);
  if (log.kind === 'missing') {
    return await refuse(
      `session ${sessionId} has no message log at ${log.path}`,
    );
  }
  if (log.kind === 'failed') {
    return await refuse(`${log.path} could not be read: ${log.error}`);
  }
  if (log.failures.length > 0) {
    return await refuse(
      `${log.failures.join('; ')}: one of them could be a message of his, so the numbering is not certain`,
    );
  }
  // D3: a private session's words never print, here either.
  const privacy = (options.privacyOf ?? realPrivacyCheck(env))(
    sessionId,
    logCwds(log.lines),
  );
  if (privacy.kind === 'private') {
    return await refuse(
      `session ${sessionId} counts as private, so its messages are not printed. Why: ${privacy.reason}`,
    );
  }
  const classified = classifySessionLog({labels, lines: log.lines, sessionId});
  const message = classified.messages[parsed.ordinal - 1];
  if (message == null) {
    return await refuse(
      `session ${sessionId} holds ${plural(classified.messages.length, 'message')} of his, so there is no number ${parsed.ordinal}`,
    );
  }
  const before = Math.max(0, options.before ?? CONTEXT_BEFORE);
  const after = Math.max(0, options.after ?? CONTEXT_AFTER);
  const from = Math.max(0, message.logIndex - before);
  const to = Math.min(classified.lines.length - 1, message.logIndex + after);
  const shown = classified.lines.slice(from, to + 1);

  if (options.json === true) {
    await writeStdout(
      `${JSON.stringify(
        {
          id: message.id,
          lines: shown.map((line) => ({
            at: line.at,
            id: line.id,
            target: line.logIndex === message.logIndex,
            text: line.text,
            who: line.kind,
          })),
          ok: true,
          sessionBead: bead.kind === 'found' ? bead.beadId : null,
          sessionId,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  const who = {
    claude: 'Claude',
    justin: 'Justin',
    kickoff:
      "Kickoff (a successor or spawned session's opening prompt, not typed by Justin)",
    machine: 'Machine-sent (not typed by Justin)',
  } as const;
  const lines = [
    sectionHeader(`Context of ${message.id}: Justin's and Claude's messages`, {
      color: style.color,
      emoji: '💬',
    }),
    '',
    fieldLines(
      [
        {label: 'Session', value: sessionId},
        ...(bead.kind === 'found'
          ? [{label: 'Bead', value: `${bead.beadId} ${title ?? ''}`.trim()}]
          : []),
        {
          label: 'Shown',
          value: `${plural(message.logIndex - from, 'line')} before and ${plural(to - message.logIndex, 'line')} after (--before ${before}, --after ${after})`,
        },
      ],
      {color: style.color, indent: BODY_COLUMN, width: style.width},
    ),
  ];
  for (const line of shown) {
    const target = line.logIndex === message.logIndex;
    const label = `${target ? '▶ ' : ''}${who[line.kind]}${line.id == null ? '' : `  ${line.id}`}`;
    lines.push(
      '',
      `${pad(BODY_COLUMN)}${paint(label, target ? ['bold', 'cyan'] : ['bold'], style.color)}  ${paint(`(${whenText(line.at)})`, ['dim'], style.color)}`,
      wrapHanging(line.text.trim(), {
        hang: TEXT_COLUMN,
        indent: TEXT_COLUMN,
        width: style.width,
      }),
    );
  }
  await writeStdout(`${lines.join('\n')}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

export async function runThreadMessages(
  options: ThreadMessagesOptions,
): Promise<number> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const json = options.json === true;
  const color = options.color ?? (json ? false : shouldStyle());
  const width =
    options.width !== undefined
      ? options.width
      : options.color === undefined
        ? terminalWidth()
        : null;
  const style: Style = {color, width};
  const readers =
    options.readers ??
    realChainWalkReaders({cwd: options.cwd ?? process.cwd(), env});
  const fail = async (reason: string): Promise<number> => {
    const text = `thread messages: ${reason}`;
    if (json) {
      await writeStdout(
        `${JSON.stringify({error: text, ok: false}, null, 2)}\n`,
      );
    } else console.error(text);
    return 2;
  };

  if (options.context != null) {
    return await runContext(options.context, options, env, readers, style);
  }

  // Every flag is checked before any read, as `thread search` does.
  const query =
    options.query == null || options.query.trim() === '' ? null : options.query;
  let pattern: null | RegExp = null;
  if (query != null) {
    const compiled = compileQuery(query, {regex: options.regex});
    if (!compiled.ok) {
      return await fail(`invalid regex /${query}/ — ${compiled.error}`);
    }
    pattern = compiled.value;
  }
  let since: Date | null = null;
  if (options.writtenSince != null) {
    const parsed = parseWrittenSince(options.writtenSince, now);
    if (parsed.kind === 'bad') return await fail(parsed.reason);
    since = parsed.at;
  }
  const sessionsWindow = parseSessionsWindow(options.sessions);
  if (sessionsWindow.kind === 'bad') return await fail(sessionsWindow.reason);

  // ---- which chain ----
  let startBead: string;
  const ownChain = options.chain == null;
  if (options.chain != null) {
    const start = resolveChainStart({env, readers, value: options.chain});
    if (start.kind === 'failed') return await fail(start.reason);
    startBead = start.beadId;
  } else {
    const sessionId = env.CLAUDE_CODE_SESSION_ID?.trim() ?? '';
    if (sessionId === '') {
      return await fail(
        'no current session (CLAUDE_CODE_SESSION_ID is not set): name one with --chain <chain name, bead or session id>',
      );
    }
    const bead = sessionBeadOf(sessionId, env);
    if (bead.kind !== 'found') {
      return await fail(
        `this session's chain is unknown: ${bead.reason}. Name one with --chain.`,
      );
    }
    startBead = bead.beadId;
  }
  const walk = walkChain(startBead, readers, {
    chainNameOfRoot: registryChainNames(env),
  });
  if (walk.kind === 'failed') {
    return await fail(`the chain could not be read: ${walk.reason}`);
  }
  const found = chainMessages({
    privacyOf: options.privacyOf ?? realPrivacyCheck(env),
    readLog: (sessionId) => readMessageLog(sessionId, env),
    throughStart: ownChain,
    walk,
    window: sessionsWindow.n,
  });
  // D3: a private session's messages are neither searched, counted as his,
  // annotated nor printed; privateSessions names them instead.
  const publicSessions = found.sessions.filter(
    (session) => !isPrivateRead(session),
  );
  const privateSessions = privateSessionsOf(found.sessions);
  const {counts, listed} = filterMessages(publicSessions, {
    limit: options.limit ?? null,
    pattern,
    since,
  });
  const annotated =
    options.annotate === true ? annotateSessions(publicSessions, env) : null;
  const complete = found.problems.length === 0;

  if (json) {
    const ordered =
      options.newestFirst === true ? [...listed].reverse() : listed;
    await writeStdout(
      `${JSON.stringify(
        {
          chain: {
            kind: walk.kind,
            members: walk.members.map((member) => ({
              beadId: member.beadId,
              name: member.name,
              sessionId: member.sessionId,
              title: member.title,
            })),
            name: walk.chainName,
            root: walk.root,
          },
          complete,
          counts: {...counts, shown: listed.length},
          messages: ordered.map(({member, message}) => ({
            at: message.at,
            beadId: member.beadId,
            id: message.id,
            name: member.name,
            ...(annotated == null
              ? {}
              : {annotation: annotated.byId.get(message.id) ?? null}),
            sessionId: message.sessionId,
            text: message.text,
          })),
          notes: annotated?.notes ?? [],
          ok: true,
          private: privateSessions,
          problems: found.problems,
          sessionsRead: found.sessions.map((session) => session.member.beadId),
          window: found.window,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    await writeStdout(
      renderList({
        annotations: annotated?.byId ?? null,
        counts,
        found,
        listed,
        newestFirst: options.newestFirst === true,
        pattern,
        privateSessions,
        query,
        sessionNotes: annotated?.notes ?? [],
        style,
        writtenSince: since,
      }),
    );
  }
  if (!complete) return 2;
  return listed.length > 0 ? 0 : 1;
}
