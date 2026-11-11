/**
 * The transcript cache (home-base-9uzxw.11): what the inbox derives from each
 * Claude Code transcript FILE, main or subagent, kept in memory for the life
 * of a process and on disk across processes, so a file whose size and
 * modification time have not changed is not read again.
 *
 * WHY. Every inbox load read every transcript of the window in full (commit
 * evidence, write evidence, the untracked scan) plus tail windows (context
 * size, last activity, helper tails): 4.4 s of an 8.5 s load in
 * readCommitEvidence alone (home-base-9ihcl.4), and a `thread dashboard --web`
 * server polled every 10 s read ~140 MiB/s from disk.
 *
 * THE CONTRACT (the bead's design field):
 *
 *  - One entry per FILE, keyed by its path, size, modification and status-change times (ns) and
 *    `TRANSCRIPT_CACHE_VERSION`. A session's answer is folded from its files'
 *    entries by the existing readers, and the subagent directory is listed on
 *    every load (never cached), so a new or grown subagent file is seen.
 *  - An entry holds facts that depend on the file's bytes alone. Whatever else
 *    a reader takes (the clock for a helper tail, the working directory for a
 *    relative written path, a scan's time window, a checkout's git state) is
 *    applied after the cache by the caller, never stored.
 *  - A file that only GREW is folded from its new bytes into the entry it
 *    had (home-base-9uzxw.16, transcript-fold.ts; knob
 *    `JUSTIN_THREADS_INCREMENTAL_READS=off`). Any other change, and any doubt
 *    about a growth, reads the file again in full, ONCE, and every fact is
 *    computed from those bytes by the same functions the uncached readers run (they
 *    take a byte source: transcript-messages.ts, usage-check.ts). The read is
 *    one descriptor: fstat, read exactly that many bytes, fstat again; an
 *    entry is kept only when both stats agree and the read was complete, so a
 *    file that grows mid-read is never cached under its new size.
 *  - Anything the cache cannot do (stat, open, read, decode, parse, a disk
 *    entry it cannot read or write, a directory it cannot create) makes the
 *    accessor return null, and the caller reads the file exactly as it did
 *    before the cache existed. So a failure of the cache is never a transcript
 *    read failure, never an empty transcript, and a transcript read that fails
 *    is never cached (critical rule 7): the uncached reader reports it.
 *  - Disk writes are atomic (a temporary file in the same directory, then a
 *    rename). An entry that does not parse, or whose header does not match,
 *    is ignored and rebuilt.
 *  - Knob: `JUSTIN_THREADS_TRANSCRIPT_CACHE=off` turns the whole cache off
 *    (memory and disk). Default on: the output is identical either way.
 *
 * Where: `$XDG_CACHE_HOME/justin-threads/transcripts/v<version>/`, else
 * `~/.cache/justin-threads/transcripts/v<version>/`. Never ~/Library (home-base
 * CLAUDE.md). A stale entry is overwritten in place when its file changes.
 * After an inbox load, `evictTranscriptCache` removes the entries whose
 * transcript is gone or older than the window (at most hourly), and
 * `dropUnusedTranscriptMemory` frees the in-memory entries the load did not
 * use (home-base-9uzxw.14).
 */

import type {CommitEvidence} from './session-commits';
import type {WriteEvidence} from './session-writes';
import type {TranscriptFold} from './transcript-fold';
import type {
  HelperTailFacts,
  HelperTailRead,
  LastRecordRead,
  TranscriptMessages,
} from './transcript-messages';

import {createHash, randomUUID} from 'crypto';
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import {homedir} from 'os';
import {basename, dirname, join} from 'path';

import {readStableBytes, stampOf} from './file-memo';
import {
  foldGrownTranscript,
  incrementalReadsEnabled,
  parseFoldRecord,
  transcriptFileReadOfBytes,
} from './transcript-fold';
import {helperTailFromFacts} from './transcript-messages';

/**
 * The parser version. BUMP IT whenever any function this file calls to
 * compute a fact can return something different for the same bytes: every
 * entry written under the old number is then ignored. The golden-fixture test
 * (tests/thread-transcript-cache.test.ts) fails when an output changes and
 * this number does not, and `bun run test:transcript-cache:golden --update`
 * refuses to record a new output under an old number.
 */
export const TRANSCRIPT_CACHE_VERSION = 1;

/** The knob: this environment variable set to `off` turns the cache off. */
export const TRANSCRIPT_CACHE_KNOB = 'JUSTIN_THREADS_TRANSCRIPT_CACHE';

/** What one transcript file's bytes say, as the readers need it. */
export interface TranscriptFileFacts {
  /** Commit evidence (`commitEvidenceFromText`) for this file. */
  commits: Omit<CommitEvidence, 'files'>;
  /** A subagent file's tail (`readHelperTail` before the clock); null for a main file. */
  helper: HelperTailFacts | null;
  /** A main file's facts: context size and last conversation record; null for a subagent file. */
  main: {
    contextTokens: number | null;
    lastRecord: Exclude<LastRecordRead, {kind: 'failed'}>;
  } | null;
  /** `extractTranscriptMessages`; null when no caller has asked for it. */
  messages: TranscriptMessages | null;
  /** Write evidence with each path as the tool_use names it (not resolved). */
  writes: Omit<WriteEvidence, 'files'>;
}

interface CacheEntry {
  facts: TranscriptFileFacts;
  /** What a fold of this file's next growth needs (transcript-fold.ts); null: read it whole when it grows. */
  fold: TranscriptFold | null;
  path: string;
  size: number;
  /** `<mtimeNs>/<ctimeNs>`: a chmod changes ctime, so an unreadable file is never served from the cache. */
  stamp: string;
  version: number;
}

/** What the cache did, for the tests and the measurements. */
export interface TranscriptCacheStats {
  /** Entries found on disk and used. */
  diskHits: number;
  /** Disk reads, directory creations and writes that failed (each swallowed). */
  diskIoErrors: number;
  /** Entries written to disk. */
  diskWrites: number;
  /** Times the cache gave up and the caller read the file the old way. */
  fallbacks: number;
  /** Bytes read from transcripts by those reads. */
  fileReadBytes: number;
  /** Files read and parsed because no entry matched. */
  fileReads: number;
  /** Bytes the folds read (prefix, seam and new bytes). */
  foldReadBytes: number;
  /** Grown files folded from their new bytes (home-base-9uzxw.16). */
  foldReads: number;
  /** Folds that a check refused (D2): the file was then read whole. */
  foldRefusals: number;
  /** Entries found in memory and used. */
  memoryHits: number;
}

function emptyStats(): TranscriptCacheStats {
  return {
    diskHits: 0,
    diskIoErrors: 0,
    diskWrites: 0,
    fallbacks: 0,
    fileReadBytes: 0,
    fileReads: 0,
    foldReadBytes: 0,
    foldReads: 0,
    foldRefusals: 0,
    memoryHits: 0,
  };
}

const memory = new Map<string, CacheEntry>();
/** When each in-memory entry was last used, on `useClock` (home-base-9uzxw.14). */
const lastUse = new Map<string, number>();
let useClock = 0;
let stats = emptyStats();
/** Directories this process already created (or found), so mkdir runs once. */
const madeDirs = new Set<string>();

export function transcriptCacheStats(): TranscriptCacheStats {
  return {...stats};
}

/** Tests only: forget every in-memory entry and zero the counters. */
export function resetTranscriptCacheMemory(): void {
  memory.clear();
  lastUse.clear();
  madeDirs.clear();
  stats = emptyStats();
}

function markUsed(path: string): void {
  useClock += 1;
  lastUse.set(path, useClock);
}

/** The use clock now: entries used after this call are newer than it. */
export function transcriptCacheMark(): number {
  return useClock;
}

/** How many entries the in-memory cache holds now. */
export function transcriptCacheMemorySize(): number {
  return memory.size;
}

/**
 * home-base-9uzxw.14: forget every in-memory entry no reader has used since
 * `mark`, so a long-lived process (the --web server) holds only what its last
 * load used. Returns how many were dropped. Disk entries are not touched.
 */
export function dropUnusedTranscriptMemory(mark: number): number {
  let dropped = 0;
  for (const path of memory.keys()) {
    if ((lastUse.get(path) ?? 0) <= mark) {
      memory.delete(path);
      lastUse.delete(path);
      dropped += 1;
    }
  }
  return dropped;
}

function cacheEnabled(): boolean {
  return process.env[TRANSCRIPT_CACHE_KNOB]?.trim().toLowerCase() !== 'off';
}

/** The directory this version's entries live in. */
export function transcriptCacheDir(
  env: Record<string, string | undefined> = process.env,
): string {
  const xdg = env.XDG_CACHE_HOME;
  const root = xdg != null && xdg !== '' ? xdg : join(homedir(), '.cache');
  return join(
    root,
    'justin-threads',
    'transcripts',
    `v${TRANSCRIPT_CACHE_VERSION}`,
  );
}

/** An entry's file name: the first 40 hex digits of sha256(path), then `.json`. */
function entryName(path: string): string {
  return `${createHash('sha256').update(path).digest('hex').slice(0, 40)}.json`;
}

function entryPath(path: string): string {
  return join(transcriptCacheDir(), entryName(path));
}

/** `<transcript dir>/<session id>/subagents/agent-*.jsonl` (pkg CLAUDE.md). */
export function isSubagentTranscript(path: string): boolean {
  return (
    basename(dirname(path)) === 'subagents' &&
    basename(path).startsWith('agent-')
  );
}

// ---------------------------------------------------------------------------
// Validating an entry read from disk
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isStringOrNull(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function validEvidence(value: unknown, listKeys: string[]): boolean {
  return (
    isObject(value) &&
    typeof value.unparsedLines === 'number' &&
    listKeys.every((key) => Array.isArray(value[key]))
  );
}

function validHelper(value: unknown): boolean {
  if (value === null) return true;
  if (!isObject(value)) return false;
  if (value.kind === 'none') return typeof value.reason === 'string';
  if (value.kind !== 'found' || !isStringOrNull(value.at)) return false;
  if (value.tail === 'textEnded') return Array.isArray(value.openShells);
  return (
    (value.tail === 'finished' || value.tail === 'inFlight') &&
    value.openShells === null
  );
}

function validMain(value: unknown): boolean {
  if (value === null) return true;
  if (!isObject(value)) return false;
  if (value.contextTokens !== null && typeof value.contextTokens !== 'number') {
    return false;
  }
  const last = value.lastRecord;
  if (!isObject(last)) return false;
  return last.kind === 'found'
    ? typeof last.at === 'string'
    : last.kind === 'none' && typeof last.reason === 'string';
}

function validMessages(value: unknown): boolean {
  return (
    value === null ||
    (isObject(value) &&
      Array.isArray(value.failures) &&
      typeof value.transcriptPath === 'string')
  );
}

/** The entry, or null when it is not one this version wrote for `path`. */
function parseEntry(text: string, path: string): CacheEntry | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(value)) return null;
  if (
    value.version !== TRANSCRIPT_CACHE_VERSION ||
    value.path !== path ||
    typeof value.size !== 'number' ||
    typeof value.stamp !== 'string'
  ) {
    return null;
  }
  const facts = value.facts;
  if (
    !isObject(facts) ||
    !validEvidence(facts.commits, ['calls', 'confirmations']) ||
    !validEvidence(facts.writes, ['commands', 'paths']) ||
    !validHelper(facts.helper) ||
    !validMain(facts.main) ||
    !validMessages(facts.messages)
  ) {
    return null;
  }
  // A main file's entry must hold main facts, a subagent's its helper tail.
  const subagent = isSubagentTranscript(path);
  if (subagent ? facts.helper === null : facts.main === null) return null;
  // An entry with no fold record, or one this version cannot use (an older
  // SDK writes none), is still good for an unchanged file; a grown one is then
  // read whole (home-base-9uzxw.16 D2).
  return {
    ...(value as unknown as CacheEntry),
    fold: parseFoldRecord(value.fold),
  };
}

// ---------------------------------------------------------------------------
// Disk
// ---------------------------------------------------------------------------

function readDiskEntry(path: string): CacheEntry | null {
  let text: string;
  try {
    text = readFileSync(entryPath(path), 'utf8');
  } catch (error) {
    // No entry yet is the normal case; anything else is a cache I/O error.
    if (!(isObject(error) && error.code === 'ENOENT')) stats.diskIoErrors += 1;
    return null;
  }
  return parseEntry(text, path);
}

function writeDiskEntry(entry: CacheEntry): void {
  const target = entryPath(entry.path);
  const dir = dirname(target);
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    if (!madeDirs.has(dir)) {
      mkdirSync(dir, {recursive: true});
      madeDirs.add(dir);
    }
    // This key order, with `path` after `facts` and `fold` and only size,
    // stamp and version after it, is what `entryPathFromTail` reads back for
    // eviction. An older SDK reading this entry ignores `fold`.
    writeFileSync(
      temp,
      JSON.stringify({
        facts: entry.facts,
        fold: entry.fold,
        path: entry.path,
        size: entry.size,
        stamp: entry.stamp,
        version: entry.version,
      }),
    );
    renameSync(temp, target);
    stats.diskWrites += 1;
  } catch {
    stats.diskIoErrors += 1;
    // Our own temporary file, if it was created; nothing else is touched.
    try {
      unlinkSync(temp);
    } catch {
      // It was never created, or cannot be removed; either way, carry on.
    }
  }
}

// ---------------------------------------------------------------------------
// Reading a transcript once and computing every fact
// ---------------------------------------------------------------------------

/**
 * Every fact of one file's bytes (transcript-fold.ts computes them, with the
 * fold record a later growth needs). Throws only on a bug in a parser.
 */
export function transcriptFileFactsOfBytes(
  bytes: Buffer,
  path: string,
  withMessages: boolean,
): TranscriptFileFacts {
  return transcriptFileReadOfBytes(bytes, path, withMessages).facts;
}

/**
 * One descriptor: fstat, read exactly that many bytes, fstat again
 * (file-memo.ts `readStableBytes`). Null when anything fails or the file
 * changed while it was read.
 */
function readAndCompute(
  path: string,
  withMessages: boolean,
): CacheEntry | null {
  const read = readStableBytes(path, (bytesRead) => {
    stats.fileReads += 1;
    stats.fileReadBytes += bytesRead;
  });
  if (read == null) return null;
  try {
    const {facts, fold} = transcriptFileReadOfBytes(
      read.bytes,
      path,
      withMessages,
    );
    return {
      facts,
      fold,
      path,
      size: read.size,
      stamp: read.stamp,
      version: TRANSCRIPT_CACHE_VERSION,
    };
  } catch {
    return null;
  }
}

/**
 * home-base-9uzxw.16: the entry to fold `path`'s growth from, or null. It must
 * carry a fold record, cover fewer bytes than the file has now, and hold
 * messages when the caller asks for them.
 */
function foldBase(
  entries: (CacheEntry | null | undefined)[],
  size: number,
  withMessages: boolean,
): (CacheEntry & {fold: TranscriptFold}) | null {
  let best: (CacheEntry & {fold: TranscriptFold}) | null = null;
  for (const entry of entries) {
    if (
      entry?.version !== TRANSCRIPT_CACHE_VERSION ||
      entry.fold == null ||
      entry.size >= size ||
      (withMessages && entry.facts.messages == null)
    ) {
      continue;
    }
    if (best == null || entry.size > best.size) {
      best = {...entry, fold: entry.fold};
    }
  }
  return best;
}

/** The entry `base` grows into, folded from the file's new bytes; null when the fold refuses (D2). */
function foldFrom(
  base: CacheEntry & {fold: TranscriptFold},
  path: string,
): CacheEntry | null {
  const outcome = foldGrownTranscript(base, (bytesRead) => {
    stats.foldReadBytes += bytesRead;
  });
  if (outcome == null) {
    stats.foldRefusals += 1;
    return null;
  }
  stats.foldReads += 1;
  return {...outcome, path, version: TRANSCRIPT_CACHE_VERSION};
}

function matches(
  entry: CacheEntry | null | undefined,
  size: number,
  stamp: string,
  withMessages: boolean,
): entry is CacheEntry {
  return (
    entry?.version === TRANSCRIPT_CACHE_VERSION &&
    entry.size === size &&
    entry.stamp === stamp &&
    (!withMessages || entry.facts.messages != null)
  );
}

/**
 * The cached entry's facts for `path` as it is now (NOT a copy), or null when
 * the cache cannot give them (off, or any failure).
 */
function factsOf(
  path: string,
  withMessages: boolean,
): TranscriptFileFacts | null {
  if (!cacheEnabled()) return null;
  try {
    const now = statSync(path, {bigint: true});
    const size = Number(now.size);
    const stamp = stampOf(now);
    const inMemory = memory.get(path);
    if (matches(inMemory, size, stamp, withMessages)) {
      stats.memoryHits += 1;
      markUsed(path);
      return inMemory.facts;
    }
    const incremental = incrementalReadsEnabled();
    // home-base-9uzxw.16: a file that grew since this process last read it is
    // folded from its new bytes, without reading its disk entry.
    const fromMemory = incremental
      ? foldBase([inMemory], size, withMessages)
      : null;
    const onDisk = fromMemory == null ? readDiskEntry(path) : null;
    if (matches(onDisk, size, stamp, withMessages)) {
      stats.diskHits += 1;
      memory.set(path, onDisk);
      markUsed(path);
      return onDisk.facts;
    }
    const base =
      fromMemory ??
      (incremental ? foldBase([inMemory, onDisk], size, withMessages) : null);
    const folded = base == null ? null : foldFrom(base, path);
    if (folded != null) {
      memory.set(path, folded);
      markUsed(path);
      writeDiskEntry(folded);
      return folded.facts;
    }
    const fresh = readAndCompute(path, withMessages);
    if (fresh == null) {
      stats.fallbacks += 1;
      return null;
    }
    memory.set(path, fresh);
    markUsed(path);
    writeDiskEntry(fresh);
    return fresh.facts;
  } catch {
    stats.fallbacks += 1;
    return null;
  }
}

/**
 * The facts of `path` as it is now, or null when the cache cannot give them
 * (off, or any failure): the caller then reads the file the old way. A copy,
 * so no caller can change a cached entry; the accessors below copy only the
 * part they return.
 */
export function transcriptFileFacts(
  path: string,
  options: {withMessages?: boolean} = {},
): TranscriptFileFacts | null {
  const facts = factsOf(path, options.withMessages === true);
  return facts == null ? null : structuredClone(facts);
}

// ---------------------------------------------------------------------------
// The accessors the readers call (each null = read it the old way)
// ---------------------------------------------------------------------------

function copy<T>(value: T | null | undefined): T | null {
  return value == null ? null : structuredClone(value);
}

export function cachedCommitEvidence(
  file: string,
): Omit<CommitEvidence, 'files'> | null {
  return copy(factsOf(file, false)?.commits);
}

/** Raw write evidence: `resolveWrittenPaths` turns it into the reader's answer. */
export function cachedRawWrites(
  file: string,
): Omit<WriteEvidence, 'files'> | null {
  return copy(factsOf(file, false)?.writes);
}

/** A main transcript's last conversation record (`readLastRecordTimestamp`, no sidechain). */
export function cachedLastRecordTimestamp(path: string): LastRecordRead | null {
  return copy(factsOf(path, false)?.main?.lastRecord);
}

/** A main transcript's context size, as measureTranscriptAt's `readTranscriptFacts` call gives it. */
export function cachedContextTokens(
  path: string,
): {contextTokens: number | null} | null {
  const main = factsOf(path, false)?.main;
  return main == null ? null : {contextTokens: main.contextTokens};
}

/** A subagent transcript's `readHelperTail`, at `options.now` (default the real clock). */
export function cachedHelperTail(
  path: string,
  options: {now?: Date} = {},
): HelperTailRead | null {
  const helper = copy(factsOf(path, false)?.helper);
  return helper == null ? null : helperTailFromFacts(helper, options);
}

/** `extractTranscriptMessages`, from the cache when it can; else the extractor itself (which throws as before). */
export function cachedTranscriptMessages(
  path: string,
  extract: (path: string) => TranscriptMessages,
): TranscriptMessages {
  return copy(factsOf(path, true)?.messages) ?? extract(path);
}

// ---------------------------------------------------------------------------
// Eviction (home-base-9uzxw.14)
// ---------------------------------------------------------------------------

/**
 * The only files eviction ever removes: an entry's name. Anything else in the
 * cache's directories (a temporary file, a marker, something a person put
 * there) is left alone.
 */
const ENTRY_NAME = /^[0-9a-f]{40}\.json$/;
/** A version directory under `<cache root>/justin-threads/transcripts/`. */
const VERSION_DIR = /^v(\d+)$/;
/** Its name does not match ENTRY_NAME, so eviction never removes it. */
const EVICTION_MARKER = '.last-eviction';
/** Eviction runs at most this often per cache directory. */
export const TRANSCRIPT_CACHE_EVICT_INTERVAL_MS = 60 * 60_000;
/** An entry's last bytes, as `writeDiskEntry` orders its keys. */
const ENTRY_TAIL =
  /"path":("(?:[^"\\]|\\.)*"),"size":\d+,"stamp":"[^"\\]*","version":\d+\}$/;
const TAIL_BYTES = 8192;

export function isEntryName(name: string): boolean {
  return ENTRY_NAME.test(name);
}

/** The transcript path an entry file names, from its last bytes; null when that cannot be read. */
function entryPathFromTail(file: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const bytes = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const got = readSync(
        fd,
        bytes,
        read,
        length - read,
        size - length + read,
      );
      if (got === 0) break;
      read += got;
    }
    const match = ENTRY_TAIL.exec(bytes.subarray(0, read).toString('utf8'));
    if (match?.[1] == null) return null;
    const path: unknown = JSON.parse(match[1]);
    return typeof path === 'string' ? path : null;
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
}

function errorCodeOf(error: unknown): string | null {
  return isObject(error) && typeof error.code === 'string' ? error.code : null;
}

/** What one eviction pass did. Every failure is counted, none is thrown. */
export interface TranscriptCacheEviction {
  /** Entries whose transcript was in use, exists in the window, or could not be checked. */
  kept: number;
  kind: 'failed' | 'ran' | 'skipped';
  /** Entries of an older cache version removed (their directory too, once empty). */
  olderVersionRemoved: number;
  /** Why it was skipped or failed; null when it ran. */
  reason: string | null;
  /** Removals that failed (a read-only directory, say): the entry stays. */
  removeFailures: number;
  /** Entries removed: their transcript is gone, or older than the window and unused. */
  removed: number;
  /** Entry files whose transcript path could not be read: kept. */
  unreadable: number;
}

let lastEviction: TranscriptCacheEviction | null = null;

/** What the last `evictTranscriptCache` call in this process did; null before the first. */
export function lastTranscriptEviction(): TranscriptCacheEviction | null {
  return lastEviction == null ? null : {...lastEviction};
}

function evictionResult(
  kind: TranscriptCacheEviction['kind'],
  reason: string | null,
): TranscriptCacheEviction {
  return {
    kept: 0,
    kind,
    olderVersionRemoved: 0,
    reason,
    removeFailures: 0,
    removed: 0,
    unreadable: 0,
  };
}

interface EvictionInput {
  intervalMs?: number;
  /** The load's clock: the window starts `windowDays` before it. */
  now: Date;
  /** Entries used after this mark (`transcriptCacheMark`) are in use. */
  usedSince: number;
  windowDays: number;
}

/** One eviction pass; `evictTranscriptCache` (below) is the entry point. */
function evictOnce(input: EvictionInput): TranscriptCacheEviction {
  if (!cacheEnabled()) return evictionResult('skipped', 'the cache is off');
  const dir = transcriptCacheDir();
  try {
    try {
      statSync(dir);
    } catch {
      return evictionResult('skipped', `no cache directory at ${dir}`);
    }
    const marker = join(dir, EVICTION_MARKER);
    const interval = input.intervalMs ?? TRANSCRIPT_CACHE_EVICT_INTERVAL_MS;
    // An interval of 0 always runs: the marker's mtime has sub-millisecond
    // precision and Date.now() does not, so two passes in one millisecond
    // would otherwise read as "the last one is in the future".
    if (interval > 0) {
      try {
        const last = statSync(marker).mtimeMs;
        if (Date.now() - last < interval) {
          return evictionResult('skipped', 'an eviction ran recently');
        }
      } catch {
        // No marker yet: this is the first pass.
      }
    }
    try {
      writeFileSync(marker, `${new Date().toISOString()}\n`);
    } catch (error) {
      // A directory we cannot write is one we could not remove from either.
      return evictionResult(
        'skipped',
        `cannot write ${marker}: ${errorCodeOf(error) ?? String(error)}`,
      );
    }

    const result = evictionResult('ran', null);
    const inUse = new Set<string>();
    for (const [path, used] of lastUse) {
      if (used > input.usedSince) inUse.add(path);
    }
    const windowStart = input.now.getTime() - input.windowDays * 86_400_000;
    const remove = (file: string): boolean => {
      try {
        unlinkSync(file);
        return true;
      } catch {
        result.removeFailures += 1;
        return false;
      }
    };

    for (const name of readdirSync(dir)) {
      if (!isEntryName(name)) continue;
      const file = join(dir, name);
      const path = entryPathFromTail(file);
      if (path == null || entryName(path) !== name) {
        result.unreadable += 1;
        continue;
      }
      if (inUse.has(path)) {
        result.kept += 1;
        continue;
      }
      let gone = false;
      let old = false;
      try {
        old = statSync(path).mtimeMs < windowStart;
      } catch (error) {
        gone = errorCodeOf(error) === 'ENOENT';
      }
      if (!gone && !old) {
        result.kept += 1;
        continue;
      }
      if (remove(file)) result.removed += 1;
    }

    const root = dirname(dir);
    for (const name of readdirSync(root)) {
      const version = VERSION_DIR.exec(name)?.[1];
      if (version == null || Number(version) >= TRANSCRIPT_CACHE_VERSION) {
        continue;
      }
      const older = join(root, name);
      try {
        for (const entry of readdirSync(older)) {
          if (isEntryName(entry) && remove(join(older, entry))) {
            result.olderVersionRemoved += 1;
          }
        }
        // Not recursive: a directory still holding anything else stays.
        rmdirSync(older);
      } catch {
        // Not a directory, not listable, not empty or not removable: it stays.
      }
    }
    return result;
  } catch (error) {
    return evictionResult(
      'failed',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * home-base-9uzxw.14: remove the disk entries whose transcript no longer
 * exists, or was last modified before the window and was not used since
 * `usedSince`. Only files named like an entry (ENTRY_NAME), listed from this
 * version's own directory (`transcriptCacheDir()`), are ever removed, and only
 * when the file's own path field hashes to its name. An older version's
 * directory loses its entry files the same way and is removed only once empty
 * (rmdir, never recursive). A newer version's directory is never touched: an
 * older SDK running beside a newer one must not empty the newer one's cache.
 *
 * Runs at most once per `intervalMs` per cache directory (a marker file's
 * modification time), because the --web server loads every 10 s and a pass
 * reads the end of every entry. A failure to remove is counted and ignored:
 * a stale entry costs disk, never correctness, because entries are keyed by
 * size and stamp.
 */
export function evictTranscriptCache(
  input: EvictionInput,
): TranscriptCacheEviction {
  lastEviction = evictOnce(input);
  return {...lastEviction};
}
