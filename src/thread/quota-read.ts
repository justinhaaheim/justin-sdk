/**
 * One streamed pass over a transcript for the spend quota (request
 * home-base-ys9t7.5, D2, D3): its priced requests, and the times of the lines
 * Justin typed.
 *
 * REQUESTS come from session-cost.ts's readTranscriptRequests, into a map the
 * caller shares across files, so a request recorded in two files (a main
 * transcript and its subagent's) counts once.
 *
 * TYPED LINES use the definitions every other reader of "what Justin said"
 * uses: substantiveUserText and queuedPromptText (transcript-messages.ts, the
 * same functions the message-log backfill writes with) give the human text of
 * a record, and classifyUserLine (handoff-chain.ts) says whether he typed it:
 * a handoff kickoff, a task notification, another session's message, a loop
 * tick or text another session sent with cmux is not typed. Subagent records
 * are sidechain records, so a subagent transcript contributes no typed line.
 */

import {closeSync, fstatSync, openSync, readSync} from 'node:fs';

import {type CostRequest, readTranscriptRequests} from '../session-cost';
import {classifyUserLine} from './handoff-chain';
import {
  queuedPromptText,
  queuedPromptTimestamp,
  substantiveUserText,
} from './transcript-messages';

export interface SpendTranscriptRead {
  /**
   * Epoch ms of every line Justin typed, in file order. NULL for a typed line
   * that carries no timestamp: the caller cannot place it, which is unknown,
   * never "before everything" (critical rule 7).
   */
  typedAtMs: (number | null)[];
  /**
   * Lines that looked like an assistant, user or queued record but were not
   * JSON. A live session's last line can be mid-append; it reads whole on the
   * next pass.
   */
  unparseableLines: number;
}

function timeOf(value: string | null): number | null {
  if (value == null) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Read one transcript: add its requests to `into` and return its typed lines.
 * Throws when the file cannot be opened or read (readTranscriptRequests).
 */
/**
 * Is one parsed transcript record a line Justin typed? `undefined`: not a
 * typed line. Otherwise its epoch ms, or null when it carries no timestamp.
 * One definition for the full read below and the brake's tail read.
 */
export function typedTimeOf(raw: unknown): number | null | undefined {
  const record = raw as Parameters<typeof substantiveUserText>[0];
  const user = substantiveUserText(record);
  if (user != null) {
    if (classifyUserLine(user) !== 'typed') return undefined;
    return timeOf(
      typeof record.timestamp === 'string' ? record.timestamp : null,
    );
  }
  const queued = queuedPromptText(record);
  if (queued != null && classifyUserLine(queued) === 'typed') {
    return timeOf(queuedPromptTimestamp(record));
  }
  return undefined;
}

/**
 * Is one parsed record a prompt of the main session: a top-level user record
 * that is not meta, not a tool result and not a subagent's? Whatever its
 * text, typed, machine or a bare `/command` that renders as nothing.
 */
function isPromptRecord(raw: unknown): boolean {
  if (raw == null || typeof raw !== 'object') return false;
  const record = raw as {
    isMeta?: unknown;
    isSidechain?: unknown;
    message?: {content?: unknown};
    toolUseResult?: unknown;
    type?: unknown;
  };
  if (record.type !== 'user') return false;
  if (record.isMeta === true || record.isSidechain === true) return false;
  if (record.toolUseResult != null) return false;
  const content = record.message?.content;
  if (Array.isArray(content)) {
    return !content.some(
      (block) =>
        block != null &&
        typeof block === 'object' &&
        (block as {type?: unknown}).type === 'tool_result',
    );
  }
  return typeof content === 'string';
}

/**
 * Read one transcript: add its requests to `into` and return its typed lines.
 * Throws when the file cannot be opened or read (readTranscriptRequests).
 *
 * `dropFirstPrompt` (D8, home-base-ys9t7.5.4 item 3): the session's first
 * prompt is the kickoff `thread spawn` typed, never Justin. It is skipped by
 * position, the first prompt record whatever its text, so a kickoff that does
 * not read as typed (a bare `/loop-session`) never costs Justin's own first
 * line instead.
 */
export async function readSpendTranscript(
  path: string,
  into: Map<string, CostRequest>,
  options: {dropFirstPrompt?: boolean} = {},
): Promise<SpendTranscriptRead> {
  const typedAtMs: (number | null)[] = [];
  let dropPending = options.dropFirstPrompt === true;
  const stats = await readTranscriptRequests(path, into, {
    alsoParse: ['"type":"user"', '"queued_command"'],
    onRecord: (raw) => {
      if (dropPending && isPromptRecord(raw)) {
        dropPending = false;
        return;
      }
      const at = typedTimeOf(raw);
      if (at !== undefined) typedAtMs.push(at);
    },
  });
  return {typedAtMs, unparseableLines: stats.unparseableLines};
}

/**
 * The brake's reset check (dispatch 2 item 4): did a typed line land in this
 * transcript after byte `offset`? Reads only the bytes appended since, so it
 * costs little on every braked call. `failed` says why it could not tell.
 */
export function typedLineSince(
  path: string,
  offset: number,
): {kind: 'failed'; reason: string} | {kind: 'none'} | {kind: 'typed'} {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    if (size <= offset) return {kind: 'none'};
    const buffer = Buffer.alloc(size - offset);
    readSync(fd, buffer, 0, buffer.length, offset);
    for (const line of buffer.toString('utf8').split('\n')) {
      if (!line.includes('"type":"user"') && !line.includes('"queued_command"'))
        continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // A line cut by the offset or mid-append.
      }
      if (typedTimeOf(parsed) !== undefined) return {kind: 'typed'};
    }
    return {kind: 'none'};
  } catch (error) {
    return {
      kind: 'failed',
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (fd != null) closeSync(fd);
  }
}

/** Bytes per backward read of the tail reader. */
const TAIL_CHUNK_BYTES = 64 * 1024;

/** The byte offset of the first prompt record (isPromptRecord), or null. */
function firstPromptOffset(
  fd: number,
  size: number,
  chunkBytes: number,
): number | null {
  let lineStart = 0;
  let pending = Buffer.alloc(0);
  for (let at = 0; at < size; at += chunkBytes) {
    const chunk = Buffer.alloc(Math.min(chunkBytes, size - at));
    readSync(fd, chunk, 0, chunk.length, at);
    let buffer = Buffer.concat([pending, chunk]);
    let newline = buffer.indexOf(0x0a);
    while (newline !== -1) {
      const line = buffer.subarray(0, newline).toString('utf8');
      if (line.includes('"type":"user"')) {
        try {
          if (isPromptRecord(JSON.parse(line))) return lineStart;
        } catch {
          // Not a whole record: never the first prompt.
        }
      }
      lineStart += newline + 1;
      buffer = buffer.subarray(newline + 1);
      newline = buffer.indexOf(0x0a);
    }
    pending = buffer;
  }
  return null;
}

export type TypedTail =
  | {kind: 'failed'; reason: string}
  | {
      /** Bytes read back from the end (the head read for dropFirstPrompt aside). */
      bytesRead: number;
      kind: 'read';
      /**
       * The newest DATED typed line met reading back from the end, or null
       * when the read stopped before meeting one: at the start of the file, or
       * at a user record dated before `sinceMs` (records are appended in time
       * order, so a typed line before it in the file is older still).
       */
      latestTypedAtMs: number | null;
    };

/**
 * The attended fast path's read (home-base-ys9t7.5.6, D6): the session's
 * latest typed line, read BACK from the end of its transcript in chunks, so
 * an attended session pays for the minutes since Justin typed, not for the
 * whole file. The same definitions as the full read: typedTimeOf
 * (classifyUserLine), an undated typed line skipped as readSpendTranscript's
 * caller skips it, and `dropFirstPrompt` dropping the first prompt record by
 * position (found by reading forward from the start until it appears).
 *
 * It can prove that Justin typed after `sinceMs`. It never proves that he did
 * not: a null says only that this read met no typed line, and every caller
 * treats that as "not proven attended".
 */
export function readTypedTail(
  path: string,
  options: {chunkBytes?: number; dropFirstPrompt: boolean; sinceMs: number},
): TypedTail {
  const chunkBytes = options.chunkBytes ?? TAIL_CHUNK_BYTES;
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const skipOffset = options.dropFirstPrompt
      ? firstPromptOffset(fd, size, chunkBytes)
      : null;
    // `later` holds the bytes from the start of the chunk read last through
    // its first newline: the end of a line whose start is further back.
    let later = Buffer.alloc(0);
    let end = size;
    while (end > 0) {
      const start = Math.max(0, end - chunkBytes);
      const chunk = Buffer.alloc(end - start);
      readSync(fd, chunk, 0, chunk.length, start);
      const buffer = Buffer.concat([chunk, later]);
      // Every line that starts inside this buffer after a newline is whole;
      // the first one is whole only at the start of the file.
      const firstNewline = buffer.indexOf(0x0a);
      const wholeFrom = start === 0 ? 0 : firstNewline + 1;
      let lineEnd = buffer.length;
      for (;;) {
        const newline =
          lineEnd === 0 ? -1 : buffer.lastIndexOf(0x0a, lineEnd - 1);
        const lineStart = newline + 1;
        if (start !== 0 && (firstNewline === -1 || lineStart < wholeFrom)) {
          break;
        }
        const line = buffer.subarray(lineStart, lineEnd).toString('utf8');
        if (
          start + lineStart !== skipOffset &&
          (line.includes('"type":"user"') || line.includes('"queued_command"'))
        ) {
          let parsed: unknown = undefined;
          try {
            parsed = JSON.parse(line);
          } catch {
            // A line mid-append (the last one of a live session).
          }
          if (parsed != null && typeof parsed === 'object') {
            const typedAt = typedTimeOf(parsed);
            if (typedAt != null) {
              return {
                bytesRead: size - start,
                kind: 'read',
                latestTypedAtMs: typedAt,
              };
            }
            if (typedAt === undefined) {
              const stamp = (parsed as {timestamp?: unknown}).timestamp;
              const at = timeOf(typeof stamp === 'string' ? stamp : null);
              if (at != null && at < options.sinceMs) {
                return {
                  bytesRead: size - start,
                  kind: 'read',
                  latestTypedAtMs: null,
                };
              }
            }
          }
        }
        if (newline === -1) break;
        lineEnd = newline;
      }
      // Carry the line that started before this chunk: all of the buffer
      // when it holds no newline (one line longer than a chunk).
      later =
        start === 0
          ? Buffer.alloc(0)
          : firstNewline === -1
            ? buffer
            : buffer.subarray(0, wholeFrom);
      end = start;
    }
    return {bytesRead: size, kind: 'read', latestTypedAtMs: null};
  } catch (error) {
    return {
      kind: 'failed',
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (fd != null) closeSync(fd);
  }
}

/**
 * The latest typed time: `none` when there is no typed line, `undated` when
 * any typed line has no timestamp (the cut-off cannot be placed).
 */
export function latestTyped(
  typedAtMs: readonly (number | null)[],
): {kind: 'none'} | {kind: 'undated'} | {atMs: number; kind: 'at'} {
  if (typedAtMs.some((at) => at == null)) return {kind: 'undated'};
  const dated = typedAtMs.filter((at): at is number => at != null);
  if (dated.length === 0) return {kind: 'none'};
  return {atMs: Math.max(...dated), kind: 'at'};
}
