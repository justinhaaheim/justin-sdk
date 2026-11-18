/**
 * What Claude did with each of Justin's messages, read from the session's
 * Claude Code transcript (home-base-z7o2m D6; replaces the prototype
 * scripts/prototype-annotate-messages.jq).
 *
 * For each of his messages: the distinct actions Claude took before his next
 * message (requests filed, questions asked, answers recorded, sessions started
 * or handed off, messages sent, beads created, closed and updated, commits,
 * files edited, subagents dispatched), a count of every other tool call, and
 * the first lines of Claude's reply to it, after any status block pasted at its
 * top (home-base-6ujwi D5).
 *
 * MATCHING. A transcript prompt (a user record's substantive text, or a
 * prompt queued mid-turn; transcript-messages.ts, the same text the message
 * log stores) is his message when its text, whitespace collapsed, equals the
 * next of his messages not yet matched, looking ahead so one unmatched message
 * does not stop the rest. Any other prompt (a task notification, a kickoff, a
 * harness notice) does not end his message's actions; it ends his reply.
 *
 * Tool calls are counted once per tool_use id (a streamed assistant message is
 * written as several records). Subagent transcripts are not read; sidechain
 * records are skipped. Edits to the scratchpad or a temp directory are left
 * out of the edits and counted with the other calls.
 */

import type {JustinMessage} from './justin-messages';

import {
  CLAUDE_MESSAGE_HEADING,
  isOmRuleLine,
  isRuleLine,
  PART_ONE_SECTION_RULE,
  pastedPartOneEnd,
} from './part-one';
import {
  assistantText,
  forEachTranscriptLine,
  queuedPromptText,
  substantiveUserText,
} from './transcript-messages';

/** About this many characters of Claude's reply are shown (D6). */
export const REPLY_CUT = 300;

export interface MessageActions {
  /** Distinct, in the order first taken. */
  actions: string[];
  otherCalls: number;
  /** Claude's reply to his message, whole; null when the turn left none. */
  reply: null | string;
}

export type TranscriptAnnotation =
  | {
      /** By message id; a message the transcript does not hold is absent. */
      byId: Map<string, MessageActions>;
      kind: 'read';
      /** Lines of the transcript that were not JSON (a partial last line excepted). */
      malformed: number;
    }
  | {kind: 'failed'; reason: string};

function oneLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

function cut(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** The first quoted value after `from` in `command`, or null. */
function quotedAfter(command: string, from: RegExp): null | string {
  const at = from.exec(command);
  if (at == null) return null;
  const rest = command.slice(at.index + at[0].length);
  const quoted = /(["'])((?:(?!\1).)+)\1/u.exec(rest);
  return quoted?.[2] ?? null;
}

function flagValue(command: string, flag: string): null | string {
  const match = new RegExp(`${flag}[ =](["']?)([^\\s"']+)\\1`, 'u').exec(
    command,
  );
  return match?.[2] ?? null;
}

const BR = String.raw`\bbr(?:\s+--db\s+\S+)?\s+`;

/** One Bash command as an action, or null for an ordinary call. */
function bashAction(raw: string): null | string {
  const command = oneLine(raw);
  // Reading a command's help does nothing.
  if (/\s--help\b/u.test(command)) return null;
  if (/\bthread request\b/u.test(command)) {
    const title = quotedAfter(command, /\bthread request\b/u);
    if (title != null) return `📝 filed request: ${cut(title, 100)}`;
    const bead = flagValue(command, '--bead');
    return bead == null
      ? '📝 filed a request'
      : `📝 filed request for bead ${bead}`;
  }
  if (/\bthread ask\b/u.test(command)) {
    const question = quotedAfter(command, /\bthread ask\b/u);
    return question == null
      ? '❓ asked Justin a question'
      : `❓ asked Justin: ${cut(question, 100)}`;
  }
  if (/\bthread answer\b/u.test(command)) {
    const id =
      flagValue(command, '--ask') ??
      /\bthread answer\s+([^\s"'-][^\s"']*)/u.exec(command)?.[1] ??
      null;
    return id == null
      ? '✅ recorded an answer (the command names no question id)'
      : `✅ recorded an answer on ${id}`;
  }
  if (/\bthread spawn\b/u.test(command)) {
    const named =
      quotedAfter(command, /--name\b/u) ??
      quotedAfter(command, /\bthread spawn\b/u);
    return named == null
      ? '🚀 started a session'
      : `🚀 started a session: ${cut(named, 100)}`;
  }
  if (/\bthread handoff\b/u.test(command)) return '🤝 handed off';
  if (/\bthread stage\b/u.test(command)) {
    const rest = /\bthread stage\s+(.*)$/u.exec(command)?.[1] ?? '';
    return `🪜 marked a stage: ${cut(rest, 80)}`;
  }
  if (/\bcmux send\b/u.test(command)) return '✉️ typed into another session';
  if (new RegExp(`${BR}create\\b`, 'u').test(command)) {
    const title = quotedAfter(command, new RegExp(`${BR}create\\b`, 'u'));
    return title == null
      ? '🆕 created a bead'
      : `🆕 created bead: ${cut(title, 100)}`;
  }
  const closed = new RegExp(`${BR}close\\s+([^\\s-][^\\s]*)`, 'u').exec(
    command,
  );
  if (closed != null) return `✔️ closed ${closed[1] ?? ''}`;
  const updated =
    new RegExp(`${BR}update\\s+([^\\s-][^\\s]*)`, 'u').exec(command) ??
    /br:set-field\s+([^\s-][^\s]*)/u.exec(command);
  if (updated != null) return `✏️ updated bead ${updated[1] ?? ''}`;
  if (/\bgit commit\b/u.test(command)) {
    // From the raw command: its first line is the subject.
    const message = quotedAfter(raw, /\s-m\b/u);
    return message == null
      ? '💾 committed'
      : `💾 committed: ${cut(message.split('\n')[0] ?? '', 80)}`;
  }
  return null;
}

/** A path under the scratchpad or a temp directory: noise for D6. */
function isScratchPath(path: string): boolean {
  const tmp = process.env.TMPDIR;
  return (
    path.includes('/scratchpad/') ||
    /^\/(?:private\/)?(?:tmp|var\/folders)\//u.test(path) ||
    (tmp != null && tmp !== '' && path.startsWith(tmp))
  );
}

/** One tool call as an action, or null when it is counted with the others. */
export function toolAction(name: string, input: unknown): null | string {
  const fields =
    input != null && typeof input === 'object'
      ? (input as Record<string, unknown>)
      : {};
  const text = (key: string): null | string => {
    const value = fields[key];
    return typeof value === 'string' && value !== '' ? value : null;
  };
  switch (name) {
    case 'Bash': {
      const command = text('command');
      return command == null ? null : bashAction(command);
    }
    case 'SendMessage': {
      const to = text('to') ?? 'a session';
      const message = text('message');
      return `✉️ messaged ${to}${message == null ? '' : `: ${cut(oneLine(message), 80)}`}`;
    }
    case 'Agent':
    case 'Task':
      return `🤖 dispatched a subagent: ${cut(text('description') ?? text('subagent_type') ?? '', 80)}`;
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
    case 'Write': {
      const path = text('file_path') ?? text('notebook_path');
      if (path == null || isScratchPath(path)) return null;
      return `📄 edited ${path.split('/').slice(-3).join('/')}`;
    }
    default:
      return null;
  }
}

interface RawRecord {
  isSidechain?: unknown;
  message?: {content?: unknown};
  subtype?: unknown;
  type?: unknown;
}

/**
 * The actions after each of `messages` in the transcript at `path`. Never
 * throws: a transcript that cannot be read is `failed`, with the reason.
 */
export function annotateFromTranscript(
  path: string,
  messages: readonly JustinMessage[],
): TranscriptAnnotation {
  const wanted = messages.map((message) => oneLine(message.text));
  const byId = new Map<string, MessageActions>();
  const seenTools = new Set<string>();
  let next = 0;
  let current: MessageActions | null = null;
  let replyOpen = false;
  let malformed = 0;
  let lastMalformed = -1;
  let lastIndex = -1;
  try {
    forEachTranscriptLine(path, (line, index) => {
      lastIndex = index;
      if (line.trim() === '') return;
      let record: RawRecord;
      try {
        record = JSON.parse(line) as RawRecord;
      } catch {
        malformed += 1;
        lastMalformed = index;
        return;
      }
      if (record.isSidechain === true) return;
      const parsed = record as Parameters<typeof substantiveUserText>[0];
      const prompt = substantiveUserText(parsed) ?? queuedPromptText(parsed);
      if (prompt != null) {
        const text = oneLine(prompt);
        const at = wanted.indexOf(text, next);
        const message = at >= 0 ? messages[at] : undefined;
        if (message != null) {
          current = {actions: [], otherCalls: 0, reply: null};
          byId.set(message.id, current);
          next = at + 1;
          replyOpen = true;
        } else {
          replyOpen = false;
        }
        return;
      }
      // The turn ended (a Stop mark, transcript-messages.ts): what follows
      // answers a notice or another prompt, not his message.
      if (
        record.type === 'system' &&
        (record.subtype === 'stop_hook_summary' ||
          record.subtype === 'turn_duration')
      ) {
        replyOpen = false;
        return;
      }
      if (record.type !== 'assistant' || current == null) return;
      const reply = assistantText(parsed);
      if (replyOpen && reply != null) current.reply = reply;
      const content = record.message?.content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (block == null || typeof block !== 'object') continue;
        const use = block as {
          id?: unknown;
          input?: unknown;
          name?: unknown;
          type?: unknown;
        };
        if (use.type !== 'tool_use' || typeof use.name !== 'string') continue;
        const id = typeof use.id === 'string' ? use.id : null;
        if (id != null) {
          if (seenTools.has(id)) continue;
          seenTools.add(id);
        }
        const action = toolAction(use.name, use.input);
        if (action == null) current.otherCalls += 1;
        else if (!current.actions.includes(action))
          current.actions.push(action);
      }
    });
  } catch (error) {
    return {
      kind: 'failed',
      reason: `${path} could not be read: ${String(error)}`,
    };
  }
  // A partial last line is a transcript still being written, not damage.
  const real =
    lastMalformed === lastIndex && malformed > 0 ? malformed - 1 : malformed;
  return {byId, kind: 'read', malformed: real};
}

/**
 * The end of a legacy report (the template before status report v4) that
 * starts at the 🛑 line `rule`: the next line made only of 🕉. Null when
 * another 🛑 line comes first or there is none: then nothing is taken out.
 */
function legacyReportEnd(
  lines: readonly string[],
  rule: number,
): null | number {
  for (let at = rule + 1; at < lines.length; at += 1) {
    const candidate = lines[at] ?? '';
    if (isOmRuleLine(candidate)) return at;
    if (isRuleLine(candidate)) return null;
  }
  return null;
}

/**
 * Claude's own words inside a pasted Part 1: its `## From Claude` section
 * (home-base-88y8m D4, `thread status --message`), up to the section rule
 * before the footer, which is the block's last `---`. None when the block has
 * no such section.
 */
function claudeMessageIn(block: readonly string[]): string[] {
  const heading = block.findIndex(
    (line) => line.trim() === `## ${CLAUDE_MESSAGE_HEADING}`,
  );
  if (heading < 0) return [];
  let end = block.length - 1;
  for (let at = block.length - 1; at > heading; at -= 1) {
    if ((block[at] ?? '').trim() === PART_ONE_SECTION_RULE) {
      end = at;
      break;
    }
  }
  return block.slice(heading + 1, end);
}

/**
 * Claude's reply with every pasted status block taken out (home-base-6ujwi
 * D5), keeping Claude's own words:
 *
 * - A Part 1, from its 🛑 line through its ♒ line (the `───` line before
 *   2026-11-12), bounded exactly as part-one's strip rule bounds it, is
 *   replaced by its `## From Claude` section, or by nothing.
 * - A legacy report, from its 🛑 line through its 🕉 line, is taken out.
 *
 * MEASURED 2026-11-18 over every assistant line of every message log: 804
 * replies began with a 🛑 line; 553 were a Part 1 (closed by ♒ or `───`), 244
 * a legacy report (closed by 🕉), and 7 legacy reports had no closing line and
 * are left as they are. In the mayor chain the final message is the block
 * alone, with Claude's words in its From Claude section, so dropping the
 * whole block would hide them. Null when nothing else is left. A handoff
 * summary (`🤝 **Handed off**`) is a real reply and is kept.
 */
export function replyWithoutStatusBlock(reply: string): null | string {
  const lines = reply.split('\n');
  const kept: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (isRuleLine(line)) {
      const partOne = pastedPartOneEnd(lines, index);
      if (partOne != null) {
        kept.push(...claudeMessageIn(lines.slice(index, partOne + 1)));
        index = partOne + 1;
        continue;
      }
      const legacy = legacyReportEnd(lines, index);
      if (legacy != null) {
        index = legacy + 1;
        continue;
      }
    }
    kept.push(line);
    index += 1;
  }
  const text = kept.join('\n').trim();
  return text === '' ? null : text;
}

export type ReplyPreview = {kind: 'blockOnly'} | {kind: 'text'; text: string};

/**
 * Claude's reply cut for the annotated view: one line, about REPLY_CUT
 * characters, after any pasted status block (D5); `blockOnly` when the reply
 * was nothing but the block.
 */
export function replyPreview(reply: string): ReplyPreview {
  const text = replyWithoutStatusBlock(reply);
  return text == null
    ? {kind: 'blockOnly'}
    : {kind: 'text', text: cut(oneLine(text), REPLY_CUT)};
}
