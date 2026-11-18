/**
 * What Claude did with each of Justin's messages, read from the session's
 * Claude Code transcript (home-base-z7o2m D6; replaces the prototype
 * scripts/prototype-annotate-messages.jq).
 *
 * For each of his messages: the distinct actions Claude took before his next
 * message (requests filed, questions asked, answers recorded, sessions started
 * or handed off, messages sent, beads created, closed and updated, commits,
 * files edited, subagents dispatched), a count of every other tool call, and
 * the first lines of Claude's reply to it.
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

/** Claude's reply cut for the annotated view: one line, about REPLY_CUT characters. */
export function replyPreview(reply: string): string {
  return cut(oneLine(reply), REPLY_CUT);
}
