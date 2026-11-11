/**
 * Incremental transcript reads (home-base-9uzxw.16): a transcript that only
 * grew is folded from its new lines into the facts the transcript cache
 * already holds (transcript-cache.ts), instead of being read again whole.
 *
 * WHY. With the cache, a `thread dashboard --web` refresh still read every
 * transcript that grew since the last one in full: 6.9 MiB for one file in a
 * traced load (2026-11-10), and more with every live session. Transcripts are
 * append-only JSONL, so the new lines are all that changed.
 *
 * THE CONTRACT (the bead's design field, D1 to D4):
 *
 *  - D1. Output identical to a full read. On by default; the knob
 *    `JUSTIN_THREADS_INCREMENTAL_READS=off` turns the fold off, and every
 *    grown file is read whole as before. `JUSTIN_THREADS_TRANSCRIPT_CACHE=off`
 *    still turns the whole cache off.
 *  - D2. Doubt means a full read. A fold runs only when the file grew, the
 *    hash of its first `FOLD_PREFIX_BYTES` and of the `FOLD_SEAM_BYTES` before
 *    the cached end still match, the cached end is a line boundary, the fold
 *    record is this `TRANSCRIPT_FOLD_VERSION` and agrees with the facts beside
 *    it, and the file did not change while it was read (fstat before and
 *    after, one descriptor). Anything else returns null, and the cache reads
 *    the file whole. A failed read is never cached.
 *  - D3. A partial last line is never folded. A fold record is written only
 *    for a file that ends on a newline; an entry read mid-write holds the full
 *    read's facts and no fold record, so the next change reads the file whole
 *    and reads that line again with it.
 *  - D4. Every fact folds. Commit evidence, write evidence, the messages and
 *    the open background shells run the same per-line step as the full read
 *    (session-commits.ts, session-writes.ts, transcript-messages.ts). The last
 *    record and the context size are "the last line that qualifies", so the
 *    same tail walkers run over the new bytes alone and a hit there wins. The
 *    helper tail folds with `foldHelperTail`.
 *
 * WHAT IS KEPT. The fold record holds only what the facts cannot give back:
 * every Bash call's id and times (the facts list commit calls only), every
 * write's id and kind (the facts split paths from commands), the messages'
 * line counters, and a helper's handback ids and open shells. The rest is
 * rebuilt from the facts, so an entry grows by ids, not by a second copy of
 * every command.
 */

import type {CommitFold} from './session-commits';
import type {WriteFold} from './session-writes';
import type {TranscriptFileFacts} from './transcript-cache';
import type {HelperTailFacts, MessagesFold} from './transcript-messages';

import {createHash} from 'crypto';
import {closeSync, fstatSync, openSync, readSync} from 'fs';
import {basename, dirname} from 'path';

import {readTranscriptFactsFromBytes} from '../usage-check';
import {stampOf} from './file-memo';
import {
  commitFoldLine,
  finishCommitFold,
  newCommitFold,
} from './session-commits';
import {finishWriteFold, newWriteFold, writeFoldLine} from './session-writes';
import {
  finishMessagesFold,
  foldHelperTail,
  forEachBytesLine,
  handbackFoldLine,
  helperTailFactsOfBytes,
  lastRecordTimestampOfBytes,
  messagesFoldLine,
  newMessagesFold,
  openShellsFoldLine,
} from './transcript-messages';

/** The knob: this environment variable set to `off` turns incremental reads off. */
export const INCREMENTAL_READS_KNOB = 'JUSTIN_THREADS_INCREMENTAL_READS';

/**
 * The fold record's version. BUMP IT whenever what a fold record holds, or
 * how a fold rebuilds state from it, changes: a record of another version is
 * ignored and the file is read whole (D2).
 */
export const TRANSCRIPT_FOLD_VERSION = 1;

/** The start of the file whose hash must still match. */
export const FOLD_PREFIX_BYTES = 4096;
/** The bytes before the cached end whose hash must still match. */
export const FOLD_SEAM_BYTES = 4096;

/** What a cache entry keeps so its file can be folded when it grows. */
export interface TranscriptFold {
  /** Every Bash call in first-seen order: id, startedAt, isCommit, endedAt. Commit calls' commands are the facts'. */
  bash: [string, string | null, boolean, string | null][];
  /** A subagent file's handback tool ids and open shells (in order); null for a main file. */
  helper: {handback: string[]; shells: string[]} | null;
  /** The messages' line counters; null when the entry holds no messages. */
  messages: {
    lastIndex: number;
    lastMalformedIndex: number;
    malformed: number;
  } | null;
  /** sha256 of the file's first `FOLD_PREFIX_BYTES` (or all of it, when shorter). */
  prefixHash: string;
  /** sha256 of the `FOLD_SEAM_BYTES` before the entry's size (or all of it). */
  seamHash: string;
  version: number;
  /** Every write in first-seen order: id and kind (`b` a Bash command, `p` a path). Values are the facts'. */
  writes: [string, 'b' | 'p'][];
}

export function incrementalReadsEnabled(): boolean {
  return process.env[INCREMENTAL_READS_KNOB]?.trim().toLowerCase() !== 'off';
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** transcript-cache.ts `isSubagentTranscript`, here so the two modules do not import each other. */
function isSubagentPath(path: string): boolean {
  return (
    basename(dirname(path)) === 'subagents' &&
    basename(path).startsWith('agent-')
  );
}

// ---------------------------------------------------------------------------
// The states every fact folds through
// ---------------------------------------------------------------------------

interface FoldStates {
  commits: CommitFold;
  handback: Set<string> | null;
  messages: MessagesFold | null;
  shells: Set<string> | null;
  writes: WriteFold;
}

function recordOf(
  states: FoldStates,
  hashes: {prefixHash: string; seamHash: string},
): TranscriptFold {
  const {commits, handback, messages, shells, writes} = states;
  return {
    bash: [...commits.bashCalls].map(([id, call]) => [
      id,
      call.startedAt,
      call.isCommit,
      commits.results.get(id) ?? null,
    ]),
    helper:
      handback == null || shells == null
        ? null
        : {handback: [...handback], shells: [...shells]},
    messages:
      messages == null
        ? null
        : {
            lastIndex: messages.lastIndex,
            lastMalformedIndex: messages.lastMalformedIndex,
            malformed: messages.malformed,
          },
    prefixHash: hashes.prefixHash,
    seamHash: hashes.seamHash,
    version: TRANSCRIPT_FOLD_VERSION,
    writes: [...writes.byId].map(([id, entry]) => [
      id,
      entry.kind === 'bash' ? 'b' : 'p',
    ]),
  };
}

/** The hashes of a whole file's bytes. */
function hashesOf(bytes: Buffer): {prefixHash: string; seamHash: string} {
  const size = bytes.length;
  return {
    prefixHash: sha256(bytes.subarray(0, Math.min(FOLD_PREFIX_BYTES, size))),
    seamHash: sha256(bytes.subarray(Math.max(0, size - FOLD_SEAM_BYTES))),
  };
}

function endsOnLine(bytes: Buffer): boolean {
  return bytes.length === 0 || bytes[bytes.length - 1] === 0x0a;
}

/** A main file's context size, with the arguments measureTranscriptAt passes (session-model.ts). */
function contextTokensOfBytes(bytes: Buffer, path: string): number | null {
  return readTranscriptFactsFromBytes(bytes, {
    lowestSetpoint: Number.MAX_SAFE_INTEGER,
    scope: 'session',
    transcriptPath: path,
  }).contextTokens;
}

// ---------------------------------------------------------------------------
// A full read: every fact, and the fold record
// ---------------------------------------------------------------------------

/**
 * Every fact of one file's bytes, and its fold record (null when the file
 * does not end on a newline, D3). Throws only on a bug in a parser.
 */
export function transcriptFileReadOfBytes(
  bytes: Buffer,
  path: string,
  withMessages: boolean,
): {facts: TranscriptFileFacts; fold: TranscriptFold | null} {
  const text = bytes.toString('utf8');
  const subagent = isSubagentPath(path);
  const states: FoldStates = {
    commits: newCommitFold(),
    handback: subagent ? new Set() : null,
    messages: withMessages ? newMessagesFold(path) : null,
    shells: subagent ? new Set() : null,
    writes: newWriteFold(),
  };
  for (const line of text.split('\n')) {
    commitFoldLine(states.commits, line, path);
    writeFoldLine(states.writes, line);
    if (states.shells != null) openShellsFoldLine(states.shells, line);
    if (states.handback != null) handbackFoldLine(states.handback, line);
  }
  const messages = states.messages;
  if (messages != null) {
    forEachBytesLine(bytes, (line, index) => {
      messagesFoldLine(messages, line, index);
    });
  }
  let main: TranscriptFileFacts['main'] = null;
  if (!subagent) {
    const lastRecord = lastRecordTimestampOfBytes(bytes, path);
    if (lastRecord.kind === 'failed') {
      throw new Error(`unreachable: a read of bytes in memory failed`);
    }
    main = {contextTokens: contextTokensOfBytes(bytes, path), lastRecord};
  }
  const facts: TranscriptFileFacts = {
    commits: finishCommitFold(states.commits, path),
    helper: subagent ? helperTailFactsOfBytes(bytes, path) : null,
    main,
    messages: messages == null ? null : finishMessagesFold(messages),
    writes: finishWriteFold(states.writes, path),
  };
  return {
    facts,
    fold: endsOnLine(bytes) ? recordOf(states, hashesOf(bytes)) : null,
  };
}

// ---------------------------------------------------------------------------
// Rebuilding the states from an entry's facts and fold record
// ---------------------------------------------------------------------------

/** The states an entry describes, or null when its fold record and facts disagree (D2). */
function statesOf(
  facts: TranscriptFileFacts,
  fold: TranscriptFold,
  path: string,
): FoldStates | null {
  const commits = newCommitFold();
  const calls = facts.commits.calls;
  let callIndex = 0;
  for (const [id, startedAt, isCommit, endedAt] of fold.bash) {
    let command = '';
    if (isCommit) {
      const call = calls[callIndex];
      callIndex += 1;
      if (call?.startedAt !== startedAt || call.endedAt !== endedAt) {
        return null;
      }
      command = call.command;
    }
    commits.bashCalls.set(id, {command, isCommit, startedAt});
    commits.results.set(id, endedAt);
  }
  if (callIndex !== calls.length) return null;
  commits.confirmations = [...facts.commits.confirmations];
  commits.unparsedLines = facts.commits.unparsedLines;

  const writes = newWriteFold();
  const {commands, paths} = facts.writes;
  let pathIndex = 0;
  let commandIndex = 0;
  for (const [id, kind] of fold.writes) {
    if (kind === 'p') {
      const write = paths[pathIndex];
      pathIndex += 1;
      if (write == null) return null;
      writes.byId.set(id, {
        kind: 'path',
        value: write.path,
        writtenAt: write.writtenAt,
      });
    } else {
      const write = commands[commandIndex];
      commandIndex += 1;
      if (write == null) return null;
      writes.byId.set(id, {
        kind: 'bash',
        value: write.command,
        writtenAt: write.writtenAt,
      });
    }
  }
  if (pathIndex !== paths.length || commandIndex !== commands.length) {
    return null;
  }
  writes.unparsedLines = facts.writes.unparsedLines;

  let messages: MessagesFold | null = null;
  if (facts.messages != null) {
    if (fold.messages == null) return null;
    messages = {
      ...fold.messages,
      result: {
        ...facts.messages,
        failures: [],
        resumeCommand: null,
        resumeCwd: null,
        resumeCwdSource: null,
      },
    };
  }

  const subagent = isSubagentPath(path);
  if (subagent !== (fold.helper != null)) return null;
  return {
    commits,
    handback: fold.helper == null ? null : new Set(fold.helper.handback),
    messages,
    shells: fold.helper == null ? null : new Set(fold.helper.shells),
    writes,
  };
}

// ---------------------------------------------------------------------------
// Folding a grown file
// ---------------------------------------------------------------------------

/** What a fold read: the bytes it took from the file, for the stats. */
export interface FoldOutcome {
  facts: TranscriptFileFacts;
  fold: TranscriptFold | null;
  size: number;
  stamp: string;
}

function readAt(fd: number, start: number, length: number): Buffer | null {
  const buffer = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const got = readSync(fd, buffer, read, length - read, start + read);
    if (got === 0) break;
    read += got;
  }
  return read === length ? buffer : null;
}

/**
 * The facts of `path` as it is now, folded from the entry it had at `size`
 * bytes, or null when any check fails (D2): the caller then reads the file
 * whole. `onRead` sees the bytes this read took from the file.
 */
export function foldGrownTranscript(
  entry: {
    facts: TranscriptFileFacts;
    fold: TranscriptFold;
    path: string;
    size: number;
  },
  onRead: (bytesRead: number) => void = () => undefined,
): FoldOutcome | null {
  const {facts, fold, path} = entry;
  const oldSize = entry.size;
  if (fold.version !== TRANSCRIPT_FOLD_VERSION) return null;
  let fd: number | null = null;
  let prefix: Buffer | null;
  let tail: Buffer | null;
  let size: number;
  let stamp: string;
  const seamStart = Math.max(0, oldSize - FOLD_SEAM_BYTES);
  try {
    fd = openSync(path, 'r');
    const before = fstatSync(fd, {bigint: true});
    size = Number(before.size);
    if (size <= oldSize) return null;
    const prefixLength = Math.min(FOLD_PREFIX_BYTES, oldSize);
    prefix = readAt(fd, 0, prefixLength);
    tail = readAt(fd, seamStart, size - seamStart);
    onRead((prefix?.length ?? 0) + (tail?.length ?? 0));
    if (prefix == null || tail == null) return null;
    const after = fstatSync(fd, {bigint: true});
    if (after.size !== before.size || stampOf(after) !== stampOf(before)) {
      return null;
    }
    stamp = stampOf(before);
  } catch {
    return null;
  } finally {
    if (fd != null) {
      try {
        closeSync(fd);
      } catch {
        // Nothing depends on it.
      }
    }
  }

  // D2: the old bytes are still there, and the old end was a line boundary.
  const seam = tail.subarray(0, oldSize - seamStart);
  if (sha256(prefix) !== fold.prefixHash || sha256(seam) !== fold.seamHash) {
    return null;
  }
  if (!endsOnLine(seam)) return null;

  const states = statesOf(facts, fold, path);
  if (states == null) return null;
  const region = tail.subarray(oldSize - seamStart);

  try {
    for (const line of region.toString('utf8').split('\n')) {
      commitFoldLine(states.commits, line, path);
      writeFoldLine(states.writes, line);
    }
    const messages = states.messages;
    if (messages != null) {
      const first = messages.lastIndex + 1;
      forEachBytesLine(region, (line, index) => {
        messagesFoldLine(messages, line, first + index);
      });
    }
    let main: TranscriptFileFacts['main'] = null;
    if (facts.main != null) {
      // The last qualifying line of the file is the new region's when it has
      // one, else the old answer (the walkers return that line, D4).
      const lastRecord = lastRecordTimestampOfBytes(region, path);
      main = {
        contextTokens:
          contextTokensOfBytes(region, path) ?? facts.main.contextTokens,
        lastRecord:
          lastRecord.kind === 'found' ? lastRecord : facts.main.lastRecord,
      };
    }
    let helper: HelperTailFacts | null = null;
    if (facts.helper != null) {
      if (states.handback == null || states.shells == null) return null;
      helper = foldHelperTail({
        handback: states.handback,
        old: facts.helper,
        path,
        region,
        shells: states.shells,
      });
    }
    const folded: TranscriptFileFacts = {
      commits: finishCommitFold(states.commits, path),
      helper,
      main,
      messages: messages == null ? null : finishMessagesFold(messages),
      writes: finishWriteFold(states.writes, path),
    };
    // The hashes of the file as it is now, from bytes this read holds: the
    // prefix (when the old file was shorter than it, `tail` starts at 0) and
    // the seam before the new end (inside `tail`).
    let fresh: TranscriptFold | null = null;
    if (endsOnLine(region)) {
      const prefixHash =
        oldSize >= FOLD_PREFIX_BYTES
          ? fold.prefixHash
          : seamStart === 0
            ? sha256(tail.subarray(0, Math.min(FOLD_PREFIX_BYTES, size)))
            : null;
      if (prefixHash != null) {
        const newSeamStart = Math.max(0, size - FOLD_SEAM_BYTES);
        fresh = recordOf(states, {
          prefixHash,
          seamHash: sha256(tail.subarray(newSeamStart - seamStart)),
        });
      }
    }
    return {facts: folded, fold: fresh, size, stamp};
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Validating a fold record read from disk
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  );
}

/** The fold record, or null when `value` is not one this version wrote (the entry is then read whole when it grows). */
export function parseFoldRecord(value: unknown): TranscriptFold | null {
  if (!isObject(value) || value.version !== TRANSCRIPT_FOLD_VERSION) {
    return null;
  }
  const {bash, helper, messages, prefixHash, seamHash, writes} = value;
  if (typeof prefixHash !== 'string' || typeof seamHash !== 'string') {
    return null;
  }
  const bashOk =
    Array.isArray(bash) &&
    bash.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 4 &&
        typeof entry[0] === 'string' &&
        isStringOrNull(entry[1]) &&
        typeof entry[2] === 'boolean' &&
        isStringOrNull(entry[3]),
    );
  const writesOk =
    Array.isArray(writes) &&
    writes.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === 'string' &&
        (entry[1] === 'b' || entry[1] === 'p'),
    );
  const helperOk =
    helper === null ||
    (isObject(helper) &&
      isStringArray(helper.handback) &&
      isStringArray(helper.shells));
  const messagesOk =
    messages === null ||
    (isObject(messages) &&
      typeof messages.lastIndex === 'number' &&
      typeof messages.lastMalformedIndex === 'number' &&
      typeof messages.malformed === 'number');
  if (!bashOk || !writesOk || !helperOk || !messagesOk) return null;
  return value as unknown as TranscriptFold;
}
