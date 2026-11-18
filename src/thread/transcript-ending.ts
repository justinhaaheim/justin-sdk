/**
 * How a session's main transcript ENDS (home-base-kwand.4, gap G12 of epic
 * home-base-kwand, decision D5): stopped after a reply, or cut off mid-turn,
 * derived from the transcript alone. Nothing is written on start or stop.
 *
 * Justin (2026-11-17): "can we *derive* this info from the claude code
 * transcript? I imagine that if a claude code session gets abruptly stopped,
 * we could tell that after the fact because the session doesn't end in a
 * yield, right?"
 *
 * THE RULE. The transcript is walked line by line through a small state
 * (`EndingFold`), so the transcript cache computes it in the pass it already
 * makes and folds a grown file from its new lines (transcript-fold.ts):
 *
 *  - A STOP MARK ends a turn: a `system` record with subtype `turn_duration`
 *    or `stop_hook_summary` (`isStopMarker` in transcript-messages.ts has the
 *    measurements: neither mark is on every Stop).
 *  - ACTIVITY opens or continues a turn: a prompt (a user record with text of
 *    his, `substantiveUserText`), a `<task-notification>` user record (a
 *    finished background task wakes an idle session; measured 2026-11-18 over
 *    60 days of main transcripts: 1,819 of 2,063 such records were followed by
 *    a stop mark before the next user record, 11 by the end of the file), a
 *    tool result, "[Request interrupted by user…]", and every assistant record
 *    (a tool call, text, or thinking alone).
 *  - NOT ACTIVITY, skipped: `isMeta` and compact-summary user records, a user
 *    record with no text of his (a bare `/command`, local command output),
 *    attachments (a `claude --resume` appends them stamped with the resume
 *    time; a queued prompt is injected into the running turn, D-18B), every
 *    other `system` subtype (away_summary, bridge_status, local_command,
 *    compact_boundary, informational), `queue-operation`, `last-prompt` and
 *    every other record type, sidechain records, and lines that do not parse.
 *
 * The verdict, from the state at the end of the file:
 *
 *  - `replied`: no activity after the newest stop mark.
 *  - `cutOff`: activity after it, naming the newest activity (`inFlight`) and
 *    its time. An assistant reply with no stop mark after it counts too: a
 *    turn that finished has one, and "replied" is the reassuring verdict
 *    (critical rule 7).
 *  - `unknown`, with the reason: no conversation record at all; or a file with
 *    NEITHER stop mark (1,163 files on 2026-09-25, 755 of them `claude -p`)
 *    whose last activity is an assistant reply that does not say it ended the
 *    turn (`stop_reason` other than `end_turn`). In such a file only that
 *    unambiguous tail is `replied`; a tool call, a tool result, a prompt or an
 *    interrupt at its end is still `cutOff`, because no finished turn ends
 *    that way.
 *
 * LIVENESS IS A SEPARATE FACT (D5). `sessionEnding` adds it: a session whose
 * Claude process runs again after a cut-off turn is still cut off (the
 * sessions cmux auto-resumed after the 2026-11-17 restart sit idle that way),
 * unless its newest record is younger than `WORKING_NOW_WINDOW_MS`: then it is
 * working now.
 */

import {closeSync, fstatSync, openSync, readSync} from 'fs';

import {forEachBytesLine, substantiveUserText} from './transcript-messages';

/** What was in flight when a turn was cut off: the newest activity record. */
export type InFlightKind =
  | 'interrupt'
  | 'notification'
  | 'prompt'
  | 'reply'
  | 'thinking'
  | 'toolCall'
  | 'toolResult';

/** The walk's state between lines; the transcript cache keeps it (transcript-cache.ts). */
export interface EndingFold {
  /** At least one activity record was seen. */
  conversation: boolean;
  /** The newest stop mark's time; null when none, or it had none. */
  finishedAt: string | null;
  /** At least one stop mark was seen. */
  marks: boolean;
  /** The newest activity after the newest stop mark; null when none. */
  open: {
    at: string | null;
    /** An assistant reply whose `stop_reason` is `end_turn`. */
    endTurn: boolean;
    kind: InFlightKind;
  } | null;
}

/** How the transcript ends (the module doc). */
export type TranscriptEnding =
  | {at: string | null; inFlight: InFlightKind; kind: 'cutOff'}
  | {at: string | null; kind: 'replied'}
  | {kind: 'unknown'; reason: string};

export function newEndingFold(): EndingFold {
  return {conversation: false, finishedAt: null, marks: false, open: null};
}

interface EndingRecord {
  isCompactSummary?: unknown;
  isMeta?: unknown;
  isSidechain?: unknown;
  message?: {content?: unknown; stop_reason?: unknown};
  subtype?: unknown;
  timestamp?: unknown;
  toolUseResult?: unknown;
  type?: unknown;
}

const INTERRUPT = /^\s*\[Request interrupted by user/;
const TASK_NOTIFICATION = /<task-notification[\s>]/;

function timestampOf(record: EndingRecord): string | null {
  return typeof record.timestamp === 'string' && record.timestamp !== ''
    ? record.timestamp
    : null;
}

function blocksOf(content: unknown): Record<string, unknown>[] {
  if (!Array.isArray(content)) return [];
  return content.filter(
    (block): block is Record<string, unknown> =>
      block != null && typeof block === 'object',
  );
}

/** Every text a user record carries: its string, its text blocks, its tool results' text. */
function userTexts(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  const texts: string[] = [];
  for (const block of blocksOf(content)) {
    if (block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text);
    } else if (block.type === 'tool_result') {
      if (typeof block.content === 'string') texts.push(block.content);
      for (const inner of blocksOf(block.content)) {
        if (inner.type === 'text' && typeof inner.text === 'string') {
          texts.push(inner.text);
        }
      }
    }
  }
  return texts;
}

/** The activity a user record is, or null when it is none (the module doc). */
function userActivity(record: EndingRecord): InFlightKind | null {
  if (record.isMeta === true || record.isCompactSummary === true) return null;
  const content = record.message?.content;
  const texts = userTexts(content);
  // Before the tool result: an interrupt during a tool call is written as one.
  if (texts.some((text) => INTERRUPT.test(text))) return 'interrupt';
  if (
    record.toolUseResult != null ||
    blocksOf(content).some((block) => block.type === 'tool_result')
  ) {
    return 'toolResult';
  }
  if (texts.some((text) => TASK_NOTIFICATION.test(text))) {
    return 'notification';
  }
  return substantiveUserText(
    record as Parameters<typeof substantiveUserText>[0],
  ) == null
    ? null
    : 'prompt';
}

function assistantActivity(record: EndingRecord): InFlightKind {
  const content = record.message?.content;
  if (typeof content === 'string') return 'reply';
  const blocks = blocksOf(content);
  if (blocks.some((block) => block.type === 'tool_use')) return 'toolCall';
  if (blocks.some((block) => block.type === 'text')) return 'reply';
  return 'thinking';
}

/** One line of the transcript into `fold`. */
export function endingFoldLine(fold: EndingFold, line: string): void {
  if (line.trim() === '') return;
  let record: EndingRecord;
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed == null || typeof parsed !== 'object') return;
    record = parsed as EndingRecord;
  } catch {
    return;
  }
  if (record.isSidechain === true) return;
  if (record.type === 'system') {
    if (
      record.subtype === 'turn_duration' ||
      record.subtype === 'stop_hook_summary'
    ) {
      fold.marks = true;
      fold.open = null;
      fold.finishedAt = timestampOf(record) ?? fold.finishedAt;
    }
    return;
  }
  let kind: InFlightKind | null = null;
  if (record.type === 'user') kind = userActivity(record);
  else if (record.type === 'assistant') kind = assistantActivity(record);
  if (kind == null) return;
  fold.conversation = true;
  fold.open = {
    at: timestampOf(record),
    endTurn: kind === 'reply' && record.message?.stop_reason === 'end_turn',
    kind,
  };
}

/** The verdict of a walk that has seen the whole file (the module doc). */
export function endingOfFold(fold: EndingFold): TranscriptEnding {
  if (!fold.conversation) {
    return {
      kind: 'unknown',
      reason: 'the transcript holds no conversation record',
    };
  }
  const {open} = fold;
  if (open == null) return {at: fold.finishedAt, kind: 'replied'};
  if (!fold.marks && open.kind === 'reply') {
    return open.endTurn
      ? {at: open.at, kind: 'replied'}
      : {
          kind: 'unknown',
          reason:
            'the transcript has no end-of-turn marks, and its last reply does not say it ended the turn',
        };
  }
  return {at: open.at, inFlight: open.kind, kind: 'cutOff'};
}

/** The walk over a whole transcript's bytes. */
export function endingFoldOfBytes(bytes: Buffer): EndingFold {
  const fold = newEndingFold();
  forEachBytesLine(bytes, (line) => {
    endingFoldLine(fold, line);
  });
  return fold;
}

/**
 * The ending of the transcript at `path`, read here in full: the path when
 * the transcript cache cannot give it (`cachedTranscriptEnding`). A file that
 * cannot be read is `unknown` naming why, never a verdict.
 */
export function readTranscriptEnding(path: string): TranscriptEnding {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (error) {
    return {
      kind: 'unknown',
      reason: `could not open ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  try {
    const size = fstatSync(fd).size;
    const bytes = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const got = readSync(fd, bytes, read, size - read, read);
      if (got === 0) break;
      read += got;
    }
    return endingOfFold(endingFoldOfBytes(bytes.subarray(0, read)));
  } catch (error) {
    return {
      kind: 'unknown',
      reason: `could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// With liveness (D5)
// ---------------------------------------------------------------------------

/**
 * A live session cut off mid-turn whose newest record (main transcript or a
 * subagent's) is younger than this is working now, not cut off.
 *
 * MEASURED 2026-11-18 over the 3,500 finished turns of the main transcripts
 * changed in the last 30 days (139,621 gaps between consecutive conversation
 * records inside a turn): the median turn's longest silence is 0.3 min, p90
 * 2.5 min; 108 turns (3.1%) had a silence of 10 minutes or more, 69 (2.0%) of
 * 15 or more. 15 minutes is longer than Bash's 10-minute cap, so one long
 * foreground command does not read as cut off, and matches the helper window
 * (session-status.ts `HELPER_WINDOW_MS`). The cost: a live session cut off
 * less than 15 minutes ago reads as working now until the window passes.
 */
export const WORKING_NOW_WINDOW_MS = 15 * 60_000;

/** How a session stopped, with liveness: what the inbox, the JSON and the dashboard show. */
export type SessionEnding =
  | {
      at: string | null;
      inFlight: InFlightKind;
      kind: 'cutOff';
      /** A Claude process runs this session now; null when that could not be checked. */
      live: boolean | null;
    }
  | {
      at: string | null;
      inFlight: InFlightKind;
      kind: 'workingNow';
      lastRecordAt: string;
    }
  | {at: string | null; kind: 'replied'}
  | {kind: 'unknown'; reason: string};

/**
 * D5: the transcript's ending with liveness beside it. `live` is whether a
 * Claude process runs the session now (the pane join; null when it could not
 * be checked), `lastRecordAt` its newest record, subagents included.
 */
export function sessionEnding(
  ending: TranscriptEnding,
  input: {lastRecordAt: string | null; live: boolean | null; now: Date},
): SessionEnding {
  if (ending.kind !== 'cutOff') return ending;
  const ms = input.lastRecordAt == null ? NaN : Date.parse(input.lastRecordAt);
  const age = input.now.getTime() - ms;
  const recent = !Number.isNaN(ms) && age >= 0 && age < WORKING_NOW_WINDOW_MS;
  if (recent && input.lastRecordAt != null) {
    if (input.live === true) {
      return {
        at: ending.at,
        inFlight: ending.inFlight,
        kind: 'workingNow',
        lastRecordAt: input.lastRecordAt,
      };
    }
    if (input.live == null) {
      // Recent, and nothing could say whether it runs: not a verdict either way.
      return {
        kind: 'unknown',
        reason: `its last turn has not finished, its newest record is under ${WORKING_NOW_WINDOW_MS / 60_000} minutes old, and whether a Claude process runs it could not be checked`,
      };
    }
  }
  return {...ending, live: input.live};
}

/** What was in flight, in words, after "cut off mid-turn at <time>: ". */
export const IN_FLIGHT_WORDS: Record<InFlightKind, string> = {
  interrupt: 'you interrupted it',
  notification: "a background task's notification had no reply",
  prompt: 'your message had no reply',
  reply: 'its reply had no end-of-turn mark',
  thinking: 'it was thinking',
  toolCall: 'a tool call had no result',
  toolResult: 'a tool result had no reply after it',
};

/** "6:39pm" today, else "Nov 16 6:39pm"; the ISO itself when it does not parse. */
export function endingWhen(iso: string, now: Date): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const hours = at.getHours();
  const minutes = String(at.getMinutes()).padStart(2, '0');
  const time = `${hours % 12 === 0 ? 12 : hours % 12}:${minutes}${hours < 12 ? 'am' : 'pm'}`;
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  if (sameDay) return time;
  return `${at.toLocaleString('en-US', {month: 'short'})} ${at.getDate()} ${time}`;
}

/** The mark a cut-off session carries (the card line, the dashboard heading). */
export const CUT_OFF_MARK = '✂️';

/** The card fact's label. */
export const ENDING_FACT_LABEL = 'Last turn';

/** The card's line, e.g. "✂️ cut off mid-turn at 6:39pm: a tool call had no result". */
export function endingLine(ending: SessionEnding, now: Date): string {
  const when = (at: string | null): string =>
    at == null ? '' : ` at ${endingWhen(at, now)}`;
  switch (ending.kind) {
    case 'cutOff': {
      const live =
        ending.live === true
          ? ' (its Claude process runs again, idle)'
          : ending.live == null
            ? ' (whether it runs now is unknown)'
            : '';
      return `${CUT_OFF_MARK} cut off mid-turn${when(ending.at)}: ${IN_FLIGHT_WORDS[ending.inFlight]}${live}`;
    }
    case 'workingNow':
      return `🏃 working now (its last turn has not finished; newest record${when(ending.lastRecordAt)})`;
    case 'replied':
      return `🏁 stopped after a reply${when(ending.at)}`;
    case 'unknown':
      return `❔ unknown: ${ending.reason}`;
  }
}
