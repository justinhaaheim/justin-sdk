/**
 * Which message-log lines are Justin's own typed messages, and their ids
 * (home-base-z7o2m D3, D4). `thread messages` lists them; the handoff block
 * shows them at pickup behind componentConfig.thread.handoff.pickupMessages
 * (D7).
 *
 * WHICH LINES ARE HIS (D3). A user line is his when classifyUserLine
 * (handoff-chain.ts) says `typed` AND it is not:
 *  - a successor's opening prompt: the FIRST user line of a session whose bead
 *    carries `spawn-kickoff` or `continues:`, when it is a kickoff in a known
 *    form (KICKOFF_OPENING, or the mayor's "You continue session bead <id>."
 *    with or without a leading slash command). classifyUserLine marks only the
 *    first form; it is not changed here, because the handoff gate counts
 *    attendance with it (home-base-bwsuv is the gate's fix).
 *  - a harness notice: Claude Code's own "… which you asked to be notified
 *    about, is idle now … This is an automated notice from that session's
 *    harness — not a message from a person" line. It reaches the log as a
 *    typed prompt (3 of 15 user lines in mayor session f7a1dceb, 2026-11-14),
 *    and it says itself that no person wrote it. (A judgment call beyond D3,
 *    named in the dispatch report.)
 * Lines left out are counted, so the output can say how many.
 *
 * MESSAGE IDS (D4). `<first 8 characters of the session id>.<n>`, n counting
 * his messages in that session from 1 (`f7a1dceb.4`). The same on every run
 * while the log holds the same lines; `thread messages --context` resolves
 * one to its line in the log, and refuses an id it cannot resolve.
 */

import type {MessageLine} from './message-log';

import {classifyUserLine} from './handoff-chain';
import {KICKOFF_OPENING} from './respawn';
import {CONTINUES_LABEL_PREFIX, SPAWN_KICKOFF_LABEL} from './session-bead';

/** The mayor's hand-written successor opening, `/conductor You continue session bead X.` */
const MAYOR_KICKOFF = /^(?:\/\S+\s+)?You continue session bead \S+/u;

/** Claude Code's notice that a watched session went idle (see the header). */
const HARNESS_NOTICE =
  /This is an automated notice from (?:that|your own) session's harness\b[^\n]*not a message from a person/u;

export type LogLineKind =
  /** Claude's final reply. */
  | 'claude'
  /** Justin typed it. */
  | 'justin'
  /** A successor's opening prompt. */
  | 'kickoff'
  /** A machine sent it (classifyUserLine), or Claude Code's harness notice. */
  | 'machine';

/**
 * How the session's bead says it began. `spawnKickoff`: `thread spawn` typed
 * its first prompt (the label's own contract, session-bead.ts), so that line
 * is a kickoff whatever its words: a mayor's `/conductor Work on …`. With
 * only `continues:`, the first line is a kickoff when it is in a known form.
 */
export function kickoffLabelsOf(labels: readonly string[]): {
  continues: boolean;
  spawnKickoff: boolean;
} {
  return {
    continues: labels.some((label) => label.startsWith(CONTINUES_LABEL_PREFIX)),
    spawnKickoff: labels.includes(SPAWN_KICKOFF_LABEL),
  };
}

/** Who wrote one log line; `firstUser` marks the session's first user line. */
export function logLineKind(
  line: Pick<MessageLine, 'role' | 'text'>,
  input: {continues: boolean; firstUser: boolean; spawnKickoff: boolean},
): LogLineKind {
  if (line.role === 'assistant') return 'claude';
  const kind = classifyUserLine(line.text);
  if (kind === 'kickoff') return 'kickoff';
  if (kind === 'machine') return 'machine';
  const trimmed = line.text.trim();
  if (input.firstUser && input.spawnKickoff) return 'kickoff';
  if (
    input.firstUser &&
    input.continues &&
    (trimmed.startsWith(KICKOFF_OPENING) || MAYOR_KICKOFF.test(trimmed))
  ) {
    return 'kickoff';
  }
  if (HARNESS_NOTICE.test(trimmed)) return 'machine';
  return 'justin';
}

/** One message Justin typed. */
export interface JustinMessage {
  /** When it was said; null when the log line carries no time (a backfill without one). */
  at: null | string;
  /** `f7a1dceb.4` (D4). */
  id: string;
  /** Its index in the log's lines, for the context view. */
  logIndex: number;
  /** 1-based, among his messages in this session. */
  ordinal: number;
  sessionId: string;
  text: string;
}

/** One log line with who wrote it, and its id when it is his. */
export interface ClassifiedLine {
  at: null | string;
  id: null | string;
  kind: LogLineKind;
  logIndex: number;
  text: string;
}

export interface SessionMessages {
  /** Successor openings left out. */
  kickoffs: number;
  /** Every line, in log order. */
  lines: ClassifiedLine[];
  /** Machine-sent user lines left out. */
  machine: number;
  /** His messages, in log order. */
  messages: JustinMessage[];
}

export const MESSAGE_ID_PREFIX_LENGTH = 8;

export function messageId(sessionId: string, ordinal: number): string {
  return `${sessionId.slice(0, MESSAGE_ID_PREFIX_LENGTH)}.${ordinal}`;
}

/** `f7a1dceb.4` as its parts, or null when it is not one. */
export function parseMessageId(
  id: string,
): null | {ordinal: number; prefix: string} {
  const match = /^([0-9A-Za-z_-]{8})\.([1-9]\d*)$/u.exec(id.trim());
  if (match?.[1] == null || match[2] == null) return null;
  return {ordinal: Number(match[2]), prefix: match[1]};
}

/** Every line of one session's log, classified, with his messages' ids. */
export function classifySessionLog(input: {
  /** The session bead's labels; [] when the session has no bead. */
  labels: readonly string[];
  lines: readonly Readonly<MessageLine>[];
  sessionId: string;
}): SessionMessages {
  const kickoff = kickoffLabelsOf(input.labels);
  const out: SessionMessages = {
    kickoffs: 0,
    lines: [],
    machine: 0,
    messages: [],
  };
  let seenUser = false;
  for (const [logIndex, line] of input.lines.entries()) {
    const kind = logLineKind(line, {
      ...kickoff,
      firstUser: line.role === 'user' && !seenUser,
    });
    if (line.role === 'user') seenUser = true;
    let id: null | string = null;
    if (kind === 'justin') {
      const ordinal = out.messages.length + 1;
      id = messageId(input.sessionId, ordinal);
      out.messages.push({
        at: line.at,
        id,
        logIndex,
        ordinal,
        sessionId: input.sessionId,
        text: line.text,
      });
    }
    if (kind === 'kickoff') out.kickoffs += 1;
    if (kind === 'machine') out.machine += 1;
    out.lines.push({at: line.at, id, kind, logIndex, text: line.text});
  }
  return out;
}

// ---------------------------------------------------------------------------
// D7: his messages in the handoff block
// ---------------------------------------------------------------------------

/** The most the handoff block's messages section may hold (D7). */
export const PICKUP_MESSAGES_CAP = 40_000;

/** `2026-11-14 19:36 UTC`, or `time unknown`. */
function stampText(at: null | string): string {
  if (at == null) return 'time unknown';
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return 'time unknown';
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * The handoff block's section of Justin's typed messages from the session
 * handing off (D7), newest kept when the cap cuts. `contextCommand` is the
 * full command to print one message's replies, with `<id>` in it.
 */
export function pickupMessagesSection(input: {
  cap?: number;
  contextCommand: string;
  messages: readonly JustinMessage[];
  /** Why the messages could not be read; the section then says so. */
  problem?: null | string;
}): string {
  const cap = input.cap ?? PICKUP_MESSAGES_CAP;
  const heading =
    "**Justin's messages in this session** — his words only, as he typed them; Claude's replies are not included:";
  const how = `- To see the replies around one: \`${input.contextCommand}\`.`;
  const warning =
    input.problem == null
      ? []
      : [`- ⚠️ Not all of them could be read: ${input.problem}`];
  if (input.messages.length === 0) {
    return input.problem == null
      ? [heading, '- He typed nothing in this session.'].join('\n\n')
      : [heading, ...warning, how].join('\n\n');
  }
  const items = input.messages.map((message) => {
    const body = message.text.trim().replace(/\n/gu, '\n   ');
    return `- \`${message.id}\` · ${stampText(message.at)}\n   ${body}`;
  });
  // Newest kept: walk back from the last until the cap.
  const kept: string[] = [];
  let size = 0;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index] ?? '';
    if (kept.length > 0 && size + item.length > cap) break;
    kept.unshift(item);
    size += item.length + 2;
  }
  const cut = items.length - kept.length;
  const cutLine =
    cut === 0
      ? []
      : [
          `- ⚠️ ${cut} earlier message${cut === 1 ? ' was' : 's were'} cut to keep this section under ${cap.toLocaleString('en-US')} characters.`,
        ];
  return [heading, ...warning, ...cutLine, kept.join('\n\n'), how].join('\n\n');
}
