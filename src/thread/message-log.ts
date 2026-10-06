/**
 * The per-session message log (home-base-k0b8n.9, K10 b/e/f).
 *
 * `<stateDir>/messages/<sessionId>.jsonl`: one JSON line per message —
 * `{role, at, text, event, cwd}` — for every prompt Justin sent and every final
 * message Claude yielded. Two writers, one format, and this module is the only
 * place the format is spelled:
 *
 *  - `thread capture` APPENDS one line per hook run (UserPromptSubmit, Stop).
 *  - `thread backfill` REWRITES the whole file from the transcript, which is
 *    authoritative, and keeps every live line whose text the transcript does
 *    not have (`carriedLiveLines`, home-base-k0b8n.18 D-18C).
 *
 * Readers — `thread search`, `thread show --messages`, the capture child — all
 * go through `readMessageLog`.
 *
 * IT IS AN INDEX, NOT AN ARCHIVE. The transcript is the source of truth and is
 * retained on this machine (cleanupPeriodDays 100000, measured 2026-09-23), so
 * this file lives in the state dir, is never committed and is never pushed
 * (K10 anti-decision 2). Losing it costs one backfill run.
 *
 * TEXT IS VERBATIM AND UNCAPPED. User text is noise-stripped exactly as K2
 * strips a transcript record; assistant text is trimmed exactly as K3's
 * `assistantText` trims one. Both writers apply the SAME rule, which is what
 * lets a live line and a backfilled line for the same message be equal.
 */

import type {WriteResult} from './archive';
import type {EnvLike} from './paths';
import type {TranscriptTurn, TranscriptTurns} from './transcript-messages';

import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import {dirname} from 'path';

import {messageLogPath} from './archive';
import {probeErrorMessage} from './paths';
import {extractTranscriptTurns, stripHarnessNoise} from './transcript-messages';

export type MessageRole = 'assistant' | 'user';

/** Which writer produced a line: a hook event, or the transcript via backfill. */
export type MessageEvent = 'backfill' | 'Stop' | 'UserPromptSubmit';

export interface MessageLine {
  /**
   * ISO-8601 UTC. For a live line, when the hook ran; for a backfilled one, the
   * transcript record's own timestamp. NULL only for a backfilled record that
   * carried no timestamp — never a time we made up (rule 7).
   */
  at: string | null;
  /** The session's working directory at that message, when known. */
  cwd: string | null;
  event: MessageEvent;
  role: MessageRole;
  text: string;
}

/**
 * How close two identical prompts must be to count as ONE (K10 b).
 *
 * A hook can fire twice for one prompt on resume; five seconds separates that
 * from Justin genuinely sending the same words twice ("continue", "yes").
 */
export const DUPLICATE_PROMPT_WINDOW_MS = 5_000;

/**
 * How much of a log's end the hook reads to dedupe (K10 b's <50 ms budget).
 *
 * Messages are uncapped, so the last line can be a 30 KB status report; 1 MiB
 * holds dozens of them. Past that the only thing lost is the 5-second prompt
 * dedupe for a prompt more than 1 MiB of messages ago — which cannot have been
 * within five seconds of anything anyway.
 */
export const TAIL_READ_BYTES = 1024 * 1024;

/**
 * A slash command with no arguments (`/copy`, `/loop-session`).
 *
 * K2 renders such an envelope as NOTHING in the transcript, so a backfilled log
 * never contains it; capturing it live would make the two logs of one session
 * disagree. With arguments it is Justin's brief (`/conductor <the brief>`) and
 * is kept verbatim, exactly as K2 keeps it.
 */
const BARE_SLASH_COMMAND = /^\/\S+$/;

/**
 * A prompt's text as K2 would store it. '' means "nothing of his".
 *
 * Lives HERE, beside the log format, rather than in capture.ts: the live hook
 * writes with it AND the backfill's carry rule compares with it
 * (`carriedLiveLines`, home-base-k0b8n.18 D-18C), so the two sides of that
 * comparison are one function.
 */
export function capturedUserText(prompt: string): string {
  const trimmed = prompt.trim();
  if (BARE_SLASH_COMMAND.test(trimmed)) return '';
  return stripHarnessNoise(prompt);
}

/**
 * A yield's text as K3's `assistantText` would store it: trimmed, and nothing
 * else. NOT noise-stripped — Claude quoting `<system-reminder>` in a reply is
 * Claude's words, and the backfill does not strip assistant text either, so
 * stripping here would make a live line differ from its backfilled twin.
 */
export function capturedAssistantText(text: string): string {
  return text.trim();
}

/** One line, keys in a fixed order so equal messages serialise identically. */
export function serializeMessageLine(line: MessageLine): string {
  return `${JSON.stringify({
    at: line.at,
    cwd: line.cwd,
    event: line.event,
    role: line.role,
    text: line.text,
  })}\n`;
}

/** Parse one line, or null when it is not a message line of ours. */
export function parseMessageLine(raw: string): MessageLine | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value == null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.role !== 'user' && record.role !== 'assistant') return null;
  if (typeof record.text !== 'string') return null;
  const event = record.event;
  if (event !== 'UserPromptSubmit' && event !== 'Stop' && event !== 'backfill')
    return null;
  return {
    at: typeof record.at === 'string' ? record.at : null,
    cwd: typeof record.cwd === 'string' ? record.cwd : null,
    event,
    role: record.role,
    text: record.text,
  };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * A whole log. THREE outcomes on purpose (rule 7): "this session has no log"
 * (ENOENT — capture never ran for it) is a measured answer, "I could not read
 * it" is not, and a log with a bad line in the middle is read with the bad line
 * NAMED rather than silently dropped.
 */
export type MessageLogRead =
  | {kind: 'missing'; path: string}
  | {error: string; kind: 'failed'; path: string}
  | {failures: string[]; kind: 'read'; lines: MessageLine[]; path: string};

function errorCode(error: unknown): string {
  return error != null && typeof error === 'object' && 'code' in error
    ? String((error as {code: unknown}).code)
    : '';
}

/** Split, parse, and name every malformed line except a partial LAST one. */
function parseLogText(
  text: string,
  path: string,
): {failures: string[]; lines: MessageLine[]} {
  const raw = text.split('\n');
  // A file ending in '\n' leaves one empty string at the end; anything else
  // after the last newline is a line still being appended.
  const endsClean = text.endsWith('\n') || text === '';
  const lines: MessageLine[] = [];
  let malformed = 0;
  raw.forEach((entry, index) => {
    if (entry.trim() === '') return;
    const parsed = parseMessageLine(entry);
    if (parsed != null) {
      lines.push(parsed);
      return;
    }
    // A partial last line is an append in flight, not damage.
    if (!endsClean && index === raw.length - 1) return;
    malformed += 1;
  });
  return {
    failures:
      malformed === 0
        ? []
        : [
            `${path}: ${malformed} line(s) are not message lines and were skipped`,
          ],
    lines,
  };
}

export function readMessageLogAt(path: string): MessageLogRead {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return {kind: 'missing', path};
    return {error: probeErrorMessage(error), kind: 'failed', path};
  }
  return {kind: 'read', path, ...parseLogText(text, path)};
}

export function readMessageLog(
  sessionId: string,
  env: EnvLike = process.env,
): MessageLogRead {
  return readMessageLogAt(messageLogPath(sessionId, env));
}

/**
 * A session id becomes a FILE NAME here, so it must be one (D-l). Claude Code's
 * are UUIDs; anything with a path separator or a leading dot is refused rather
 * than joined into a path under the state dir.
 */
const SESSION_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function isSafeSessionId(sessionId: string): boolean {
  return SESSION_ID_SHAPE.test(sessionId);
}

/** What the dedupe needs from the end of a log. */
export interface LogTail {
  /** The last line in the file, whatever its role. */
  lastLine: MessageLine | null;
  /** The newest user line within the tail read. */
  lastUser: MessageLine | null;
}

/**
 * The end of a log, read backwards from EOF — never the whole file (K10 b).
 *
 * A missing file is an EMPTY tail, which is the truth: nothing is there to be a
 * duplicate of. Any other failure throws, and the caller decides (it appends
 * anyway: a duplicate line is a smaller harm than a lost message).
 */
export function readLogTail(
  path: string,
  maxBytes: number = TAIL_READ_BYTES,
): LogTail {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return {lastLine: null, lastUser: null};
    throw error;
  }
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const start = size - length;
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const bytes = readSync(fd, buffer, read, length - read, start + read);
      if (bytes === 0) break;
      read += bytes;
    }
    let text = buffer.toString('utf8', 0, read);
    // Started mid-file: the first fragment is a line cut in half. Drop it.
    if (start > 0) {
      const newline = text.indexOf('\n');
      text = newline === -1 ? '' : text.slice(newline + 1);
    }
    const lines = text.split('\n').filter((entry) => entry.trim() !== '');
    let lastLine: MessageLine | null = null;
    let lastUser: MessageLine | null = null;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const parsed = parseMessageLine(lines[index] ?? '');
      if (parsed == null) continue;
      lastLine ??= parsed;
      if (parsed.role === 'user') {
        lastUser = parsed;
        break;
      }
    }
    return {lastLine, lastUser};
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// The live append (K10 b)
// ---------------------------------------------------------------------------

export type AppendOutcome =
  | {kind: 'appended'; path: string; tailError: string | null}
  | {kind: 'duplicate'; path: string; reason: string}
  | {error: string; kind: 'failed'; path: string};

/**
 * Is `line` a repeat of what the log already ends with? (K10 b.)
 *
 * ASSISTANT: equal to the log's last line, and that line is an assistant line.
 * A user line in between means a new turn, and Claude saying "Done." twice in
 * two turns is two messages, not one.
 * USER: equal to the newest user line AND within DUPLICATE_PROMPT_WINDOW_MS of
 * it — a hook firing twice, not Justin typing "yes" again a minute later.
 */
export function duplicateReason(
  tail: LogTail,
  line: MessageLine,
): string | null {
  if (line.role === 'assistant') {
    const last = tail.lastLine;
    if (last?.role === 'assistant' && last.text === line.text)
      return "equal to the log's last line, an assistant line";
    return null;
  }
  const lastUser = tail.lastUser;
  if (lastUser?.text !== line.text) return null;
  const now = line.at == null ? Number.NaN : Date.parse(line.at);
  const then = lastUser.at == null ? Number.NaN : Date.parse(lastUser.at);
  if (!Number.isFinite(now) || !Number.isFinite(then)) return null;
  return Math.abs(now - then) <= DUPLICATE_PROMPT_WINDOW_MS
    ? `equal to the last user line, ${Math.abs(now - then)} ms earlier`
    : null;
}

/**
 * Append one line, synchronously, unless it duplicates the tail.
 *
 * `appendFileSync` opens with O_APPEND, so the kernel positions every write at
 * the end even if a backfill rename or another writer moved it. The two events
 * of one session never overlap (a Stop cannot fire while a prompt is being
 * submitted), so one session's log has one writer at a time.
 */
export function appendMessageLine(
  path: string,
  line: MessageLine,
): AppendOutcome {
  let tailError: string | null = null;
  let tail: LogTail = {lastLine: null, lastUser: null};
  try {
    tail = readLogTail(path);
  } catch (error) {
    // Could not read the tail: APPEND ANYWAY. A duplicate line costs one extra
    // search hit; a dropped message costs the thing this log exists for.
    tailError = probeErrorMessage(error);
  }
  const reason = tailError == null ? duplicateReason(tail, line) : null;
  if (reason != null) return {kind: 'duplicate', path, reason};
  try {
    mkdirSync(dirname(path), {recursive: true});
    appendFileSync(path, serializeMessageLine(line));
  } catch (error) {
    return {error: probeErrorMessage(error), kind: 'failed', path};
  }
  return {kind: 'appended', path, tailError};
}

// ---------------------------------------------------------------------------
// The backfill rewrite (K10 e)
// ---------------------------------------------------------------------------

/**
 * The transcript's turns as log lines, in file order: the user message, then
 * every yield of that turn (one per Stop, home-base-k0b8n.18 D-18A).
 */
export function linesFromTurns(
  turns: readonly TranscriptTurn[],
): MessageLine[] {
  const lines: MessageLine[] = [];
  for (const turn of turns) {
    if (turn.user != null) {
      lines.push({
        at: turn.user.at,
        cwd: turn.user.cwd,
        event: 'backfill',
        role: 'user',
        text: turn.user.text,
      });
    }
    for (const yielded of turn.yields) {
      lines.push({
        at: yielded.at,
        cwd: yielded.cwd,
        event: 'backfill',
        role: 'assistant',
        text: yielded.text,
      });
    }
  }
  return lines;
}

/**
 * What makes two lines the SAME message, however each was written (D-18C):
 * the role, and the text normalized by the function the live hook writes with
 * (`capturedUserText` / `capturedAssistantText`), applied to BOTH sides.
 *
 * MEASURED 2026-09-25, read-only: all 109 distinct texts the live capture ever
 * recorded on a thread bead (105 `thread <id>: capture` commits in the threads
 * repo, 11 sessions), and every live line in the 4 message logs that still held
 * any (23 lines), are byte-for-byte equal to a transcript-derived line of the
 * same role. So the normalization changes nothing measured today; it is there so a
 * difference in trimming or harness-noise stripping between the two writers
 * can never turn one message into two lines.
 */
function sameMessageKey(line: MessageLine): string {
  const text =
    line.role === 'user'
      ? capturedUserText(line.text)
      : capturedAssistantText(line.text);
  return `${line.role}\u0000${text}`;
}

/**
 * Live lines to keep after a rewrite: every one whose message the transcript
 * does not have (home-base-k0b8n.18 D-18C).
 *
 * NEVER DROPPED FOR ITS TIMESTAMP ALONE. The old rule kept only live lines
 * stamped after the transcript's last record, on the theory that the
 * transcript already held everything older. It did not: a conductor's Stop
 * yields between two human messages, and every message Justin queued mid-turn,
 * were in the live log and nowhere in the transcript-derived lines, and one
 * rewrite erased them (15 of 19 yields on session 5a3c3420). Now the only
 * reason a live line goes is that the transcript has the same message
 * (`sameMessageKey`), in which case it appears once, as the transcript's line.
 *
 * SET, NOT COUNT: a live "yes" is dropped when the transcript has any "yes".
 * The transcript is authoritative and lags the live log by at most the turn in
 * flight, so a repeat it does not have yet reaches the log on the next rewrite;
 * counting copies instead would turn every hook that fired twice into a
 * permanent duplicate.
 */
export function carriedLiveLines(
  existing: readonly MessageLine[],
  fromTranscript: readonly MessageLine[],
): MessageLine[] {
  const known = new Set(fromTranscript.map(sameMessageKey));
  return existing.filter(
    (line) => line.event !== 'backfill' && !known.has(sameMessageKey(line)),
  );
}

/** A line's `at` as epoch ms, or null when it has none or it does not parse. */
function lineMs(line: MessageLine): number | null {
  if (line.at == null) return null;
  const ms = Date.parse(line.at);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The rewritten log: the transcript's lines in FILE order, with each carried
 * live line placed before the first transcript line stamped later than it
 * (D-18C: "merged into the output in `at` order").
 *
 * The transcript's own order is never changed, even where its stamps are not
 * monotonic — a queued prompt sits where Claude Code injected it but carries
 * the moment Justin sent it, which can be before the text above it. A carried
 * line with no usable `at` goes last rather than being dropped (rule 7: "no
 * timestamp" is not "not a message").
 */
export function mergeCarriedLines(
  fromTranscript: readonly MessageLine[],
  carried: readonly MessageLine[],
): MessageLine[] {
  const timed = carried
    .map((line) => ({line, ms: lineMs(line)}))
    .filter(
      (entry): entry is {line: MessageLine; ms: number} => entry.ms != null,
    )
    // Array.prototype.sort is stable, so equal stamps keep their log order.
    .sort((a, b) => a.ms - b.ms);
  const untimed = carried.filter((line) => lineMs(line) == null);
  const out: MessageLine[] = [];
  let next = 0;
  for (const line of fromTranscript) {
    const ms = lineMs(line);
    if (ms != null) {
      for (let entry = timed[next]; entry != null && entry.ms < ms; ) {
        out.push(entry.line);
        next += 1;
        entry = timed[next];
      }
    }
    out.push(line);
  }
  for (const entry of timed.slice(next)) out.push(entry.line);
  out.push(...untimed);
  return out;
}

/** Temp file + rename, so a reader never sees half a rewrite. */
function writeAtomically(path: string, content: string): WriteResult {
  const temp = `${path}.tmp-${process.pid}`;
  try {
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(temp, content);
    renameSync(temp, path);
    return {ok: true, path};
  } catch (error) {
    try {
      rmSync(temp, {force: true});
    } catch {
      // A stray temp file is named by its pid; nothing reads it.
    }
    return {error: probeErrorMessage(error), ok: false, path};
  }
}

export type LogSyncOutcome =
  | {
      carried: number;
      kind: 'unchanged' | 'written';
      messages: number;
      path: string;
    }
  | {error: string; kind: 'failed'; path: string};

/**
 * Rewrite one session's log from its transcript (K10 e), atomically.
 *
 * Written to a sibling temp file and RENAMED over the log, so a reader never
 * sees half a rewrite. A log that already says exactly this is left alone —
 * an hourly job that rewrote two hundred identical files would make every
 * mtime a lie. `dryRun` measures everything and writes nothing.
 */
export function syncMessageLogFromTurns(input: {
  dryRun?: boolean;
  env?: EnvLike;
  extracted: TranscriptTurns;
  sessionId: string;
}): LogSyncOutcome {
  const env = input.env ?? process.env;
  const path = messageLogPath(input.sessionId, env);
  const fromTranscript = linesFromTurns(input.extracted.turns);
  const existing = readMessageLogAt(path);
  if (existing.kind === 'failed') {
    // Rewriting a log we could not read would throw away live lines we cannot
    // see. Leave it; the next run tries again.
    return {error: existing.error, kind: 'failed', path};
  }
  const carried = carriedLiveLines(
    existing.kind === 'read' ? existing.lines : [],
    fromTranscript,
  );
  const lines = mergeCarriedLines(fromTranscript, carried);
  const content = lines.map(serializeMessageLine).join('');
  let current: string | null = null;
  if (existing.kind === 'read') {
    try {
      current = readFileSync(path, 'utf8');
    } catch {
      current = null;
    }
  }
  if (current === content) {
    return {
      carried: carried.length,
      kind: 'unchanged',
      messages: lines.length,
      path,
    };
  }
  if (input.dryRun === true) {
    return {
      carried: carried.length,
      kind: 'written',
      messages: lines.length,
      path,
    };
  }
  const written = writeAtomically(path, content);
  if (!written.ok) return {error: written.error, kind: 'failed', path};
  return {
    carried: carried.length,
    kind: 'written',
    messages: lines.length,
    path,
  };
}

/**
 * `syncMessageLogFromTurns` plus the transcript read — the backfill's entry
 * point. The capture child's seed calls the one above with turns it already
 * extracted, because the same pass also builds the resume command
 * (home-base-k0b8n.15/.16). There is ONE rewrite.
 */
export function syncMessageLogFromTranscript(input: {
  dryRun?: boolean;
  env?: EnvLike;
  sessionId: string;
  transcriptPath: string;
}): LogSyncOutcome {
  const env = input.env ?? process.env;
  let extracted: TranscriptTurns;
  try {
    extracted = extractTranscriptTurns(input.transcriptPath);
  } catch (error) {
    return {
      error: `read ${input.transcriptPath}: ${probeErrorMessage(error)}`,
      kind: 'failed',
      path: messageLogPath(input.sessionId, env),
    };
  }
  return syncMessageLogFromTurns({
    dryRun: input.dryRun,
    env,
    extracted,
    sessionId: input.sessionId,
  });
}
