/**
 * Files an inbox load reads whole, parsed once and kept in memory until they
 * change (home-base-9uzxw.12): each beads export's index, each session's
 * message log, and the sessions index.
 *
 * WHY. A `thread dashboard --web` server loads the inbox every 10 s while its
 * page is open. With transcript facts cached (transcript-cache.ts), each warm
 * load still read about 108 MiB (traced with `bun run threads:read-trace`,
 * 2026-11-10): 17 beads exports once each (80.6 MiB), the 61 KB sessions index
 * once per session (217 times, 13.3 MiB), and 258 message logs twice each
 * (13.3 MiB). Almost none of them change between two refreshes.
 *
 * THE CONTRACT, the transcript cache's own:
 *
 *  - An entry is keyed by the file's path, its size and its modification and
 *    status-change times in ns (`stampOf`), plus a variant naming anything else
 *    the parse depends on (an export's index depends on its `.beads/`
 *    directory as well as its bytes). A file whose key changed is read again.
 *  - The read is one descriptor: fstat, read exactly that many bytes, fstat
 *    again (`readStableBytes`); an entry is kept only when both stats agree, so
 *    a file rewritten mid-read is never cached under its new key.
 *  - Anything the memo cannot do (stat, open, read, parse) returns null, and
 *    the caller reads the file exactly as it did before, so a failed read is
 *    reported by the uncached reader and is never cached (critical rule 7).
 *  - Values are shared between callers. Callers treat them as read-only, the
 *    way the per-load cache already shared an export index between sessions;
 *    message-log values are frozen, so a caller that tried to change one would
 *    throw rather than change the next caller's answer.
 *  - Memory only, never disk: one process per CLI load gains nothing from it
 *    but the dedupe within a load, and a long-lived process (the --web server)
 *    is the case it is for. `dropUnusedFileMemo` frees what the last load did
 *    not use (home-base-9uzxw.14), so the memo holds one load's files at most.
 *  - Knob: `JUSTIN_THREADS_FILE_CACHE=off` turns it off. Default on: the
 *    output is identical either way (tests/thread-file-memo.test.ts).
 */

import {closeSync, fstatSync, openSync, readSync, statSync} from 'fs';

/** The knob: this environment variable set to `off` turns the memo off. */
export const FILE_MEMO_KNOB = 'JUSTIN_THREADS_FILE_CACHE';

/** The key's time half: modification and status-change times, in ns. */
export function stampOf(stat: {ctimeNs: bigint; mtimeNs: bigint}): string {
  return `${stat.mtimeNs.toString()}/${stat.ctimeNs.toString()}`;
}

/**
 * The whole file, read through one descriptor: fstat, read exactly that size,
 * fstat again. Null when anything fails, the read came up short, or the file
 * changed while it was read. `onRead` sees how many bytes were read whenever
 * the read loop ran (the transcript cache counts them).
 */
export function readStableBytes(
  path: string,
  onRead: (bytesRead: number) => void = () => undefined,
): {bytes: Buffer; size: number; stamp: string} | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const before = fstatSync(fd, {bigint: true});
    const size = Number(before.size);
    const bytes = Buffer.allocUnsafe(size);
    let read = 0;
    while (read < size) {
      const got = readSync(fd, bytes, read, size - read, read);
      if (got === 0) break;
      read += got;
    }
    onRead(read);
    if (read !== size) return null;
    const after = fstatSync(fd, {bigint: true});
    if (after.size !== before.size || stampOf(after) !== stampOf(before)) {
      return null;
    }
    return {bytes, size, stamp: stampOf(before)};
  } catch {
    return null;
  } finally {
    if (fd != null) {
      try {
        closeSync(fd);
      } catch {
        // Nothing to do: the bytes (or the fallback) do not depend on it.
      }
    }
  }
}

interface MemoEntry<T> {
  size: number;
  stamp: string;
  /** The use clock when a caller last got this entry. */
  usedAt: number;
  value: T;
}

/** What the memo did, for the tests and the measurements. */
export interface FileMemoStats {
  /** Times the memo gave up and the caller read the file the old way. */
  fallbacks: number;
  /** Entries found and used. */
  hits: number;
  /** Bytes read by those reads. */
  readBytes: number;
  /** Files read and parsed because no entry matched. */
  reads: number;
}

function emptyStats(): FileMemoStats {
  return {fallbacks: 0, hits: 0, readBytes: 0, reads: 0};
}

let stats = emptyStats();
/** Increases with every use, so a load can tell what it used. */
let useClock = 0;
const memos: Map<string, MemoEntry<unknown>>[] = [];

export function fileMemoStats(): FileMemoStats {
  return {...stats};
}

/** How many entries the memos hold now. */
export function fileMemoSize(): number {
  return memos.reduce((sum, memo) => sum + memo.size, 0);
}

/** Tests only: forget every entry and zero the counters. */
export function resetFileMemo(): void {
  for (const memo of memos) memo.clear();
  stats = emptyStats();
}

function memoEnabled(): boolean {
  return process.env[FILE_MEMO_KNOB]?.trim().toLowerCase() !== 'off';
}

/** The use clock now: entries used after this call are newer than it. */
export function fileMemoMark(): number {
  return useClock;
}

/** Forget every entry no caller has used since `mark`. Returns how many. */
export function dropUnusedFileMemo(mark: number): number {
  let dropped = 0;
  for (const memo of memos) {
    for (const [key, entry] of memo) {
      if (entry.usedAt <= mark) {
        memo.delete(key);
        dropped += 1;
      }
    }
  }
  return dropped;
}

export interface FileMemo<T> {
  /**
   * The parsed file as it is now, or null when the memo cannot give it (off,
   * or any failure): the caller then reads it the old way. `variant` names
   * whatever else `parse` depends on; it is part of the key.
   */
  read: (
    path: string,
    parse: (bytes: Buffer) => T,
    variant?: string,
  ) => T | null;
}

export function createFileMemo<T>(): FileMemo<T> {
  const entries = new Map<string, MemoEntry<T>>();
  memos.push(entries as Map<string, MemoEntry<unknown>>);
  return {
    read: (path, parse, variant = '') => {
      if (!memoEnabled()) return null;
      const key = `${variant}\u0000${path}`;
      try {
        const now = statSync(path, {bigint: true});
        const known = entries.get(key);
        if (known?.size === Number(now.size) && known.stamp === stampOf(now)) {
          stats.hits += 1;
          useClock += 1;
          known.usedAt = useClock;
          return known.value;
        }
        const read = readStableBytes(path, (bytesRead) => {
          stats.reads += 1;
          stats.readBytes += bytesRead;
        });
        if (read == null) {
          stats.fallbacks += 1;
          return null;
        }
        const value = parse(read.bytes);
        useClock += 1;
        entries.set(key, {
          size: read.size,
          stamp: read.stamp,
          usedAt: useClock,
          value,
        });
        return value;
      } catch {
        stats.fallbacks += 1;
        return null;
      }
    },
  };
}

/**
 * home-base-9uzxw.16: the text of small files read many times per inbox load
 * (each repo's justin-sdk.config.json and the user config: 918 reads per
 * load, traced 2026-11-11), kept until the file changes. A string cannot be
 * changed by a caller, so each caller still parses its own copy.
 */
const textMemo = createFileMemo<string>();

/** The file's text as `readFileSync(path, 'utf8')` gives it, or null when the memo cannot (the caller reads it the old way). */
export function readTextMemoized(path: string): string | null {
  return textMemo.read(path, (bytes) => bytes.toString('utf8'));
}
