/**
 * The machine-wide question counter (home-base-4wfoz; design D2 in
 * home-base-l2ejg.3). Every `BD<n>` on this machine comes from here, so one
 * number never names two questions, in any repo or session.
 *
 * THE FILE: `<threads state dir>/question-ids/counter.json`, holding
 * `{"last": <the highest number handed out>, "updatedAt": "<ISO>"}`.
 *
 * THE RULE: the next number is
 *   max(the file's `last`, the highest `qid:` number in every known repo's
 *       export, open or closed questions alike, 99) + 1.
 * So the first new id is at least BD100, never equals an old per-chain id, and
 * a counter file that is missing (first run, or a lost state dir) is re-derived
 * the same way. "Every known repo export": the beads dirs the sessions index
 * knows, as `thread holders` walks them (holders.ts candidateDbs), plus the
 * caller's own. They are read as files; no br.
 *
 * THE LOCK: held only around reading and bumping the file, never across a br
 * call or an export read. It is the O_EXCL + pid pattern of the capture lock
 * (capture.ts tryCaptureLock) and the commit lock (commit.ts
 * acquireCommitLock): a holder that MEASURABLY died is stolen from, and so is a
 * lock older than STALE_LOCK_MS (the critical section takes milliseconds).
 * Unlike the capture lock it waits a little, because two `thread ask` calls at
 * once must both get a number.
 *
 * FAILURE IS NOT EMPTY (critical rule 7): when the index, an export or the
 * counter file cannot be read, or the file cannot be written, nothing is
 * handed out and the reason comes back in words. The caller then shows the
 * bead id. Nothing here throws.
 */

import type {EnvLike} from './paths';

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import {join} from 'path';

import {recordedBeadsJsonl} from '../beads/jsonl';
import {pidAlive} from './commit';
import {probeErrorMessage, threadsStateDir} from './paths';
import {
  maxQuestionNumber,
  QUESTION_ID_LABEL_PREFIX,
  QUESTION_NUMBER_FLOOR,
} from './question-ids';
import {readSessionIndex} from './session-index';

/** `<threads state dir>/question-ids`. */
export function questionIdsDir(env: EnvLike = process.env): string {
  return join(threadsStateDir(env), 'question-ids');
}

/** `<threads state dir>/question-ids/counter.json`. */
export function questionCounterPath(env: EnvLike = process.env): string {
  return join(questionIdsDir(env), 'counter.json');
}

function counterLockPath(env: EnvLike): string {
  return join(questionIdsDir(env), 'counter.lock');
}

function errorCode(error: unknown): null | string {
  return error != null && typeof error === 'object' && 'code' in error
    ? String((error as {code: unknown}).code)
    : null;
}

// ---- the exports -------------------------------------------------------------

export type KnownBeadsDirs =
  | {dirs: string[]; kind: 'read'}
  | {kind: 'failed'; reason: string};

/**
 * The beads dirs the sessions index knows, plus `extra`, without repeats. A
 * missing index knows none (a measured absence); an unreadable one fails.
 * Lines of the index that do not parse are skipped, as `thread holders` skips
 * them.
 */
export function knownBeadsDirs(
  env: EnvLike,
  extra: readonly string[] = [],
): KnownBeadsDirs {
  const dirs = new Set(extra);
  const index = readSessionIndex(env);
  if (index.kind === 'failed') {
    return {
      kind: 'failed',
      reason: `the sessions index ${index.path} could not be read: ${index.error}`,
    };
  }
  if (index.kind === 'read') {
    for (const session of index.sessions) {
      for (const sighting of session.sightings) dirs.add(sighting.beadsDir);
    }
  }
  return {dirs: [...dirs], kind: 'read'};
}

const LABEL_START = Buffer.from(`"${QUESTION_ID_LABEL_PREFIX}`);
const QUOTE = 0x22;
const BACKSLASH = 0x5c;

/**
 * Every `qid:` label in an export's bytes. A label is a whole JSON string, so
 * it starts at an unescaped quote; one inside a description (`\"qid:…\"`) is
 * skipped. Reading bytes rather than parsing each line keeps this at about 5 ms
 * for home-base's 12 MB export (measured 2026-11-14). What a description could
 * still add only raises the floor, which is the safe direction.
 */
export function qidLabelsIn(bytes: Buffer): string[] {
  const labels: string[] = [];
  let at = bytes.indexOf(LABEL_START);
  while (at !== -1) {
    const start = at + 1;
    const end = bytes.indexOf(QUOTE, start);
    if (end === -1) break;
    if (at === 0 || bytes[at - 1] !== BACKSLASH) {
      labels.push(bytes.toString('latin1', start, end));
    }
    at = bytes.indexOf(LABEL_START, end + 1);
  }
  return labels;
}

export type ExportsMax =
  | {kind: 'failed'; reason: string}
  | {kind: 'read'; max: number; paths: string[]};

/**
 * The highest `qid:` number, in either form, in the export of every dir in
 * `beadsDirs` (the export br writes for it: recordedBeadsJsonl). A dir with no
 * database br would use AND no export file holds nothing (a gone worktree:
 * measured absence, as holders.ts treats it). Any other failure fails the
 * whole read: a number the read missed could be handed out again.
 */
export function highestNumberInExports(
  beadsDirs: readonly string[],
): ExportsMax {
  const paths = new Map<string, boolean>();
  for (const dir of beadsDirs) {
    const located = recordedBeadsJsonl(dir);
    if (located.kind === 'failed') {
      return {kind: 'failed', reason: located.reason};
    }
    const absentIsEmpty = located.via === 'noDatabase';
    paths.set(located.path, (paths.get(located.path) ?? true) && absentIsEmpty);
  }
  let max = 0;
  const read: string[] = [];
  for (const [path, absentIsEmpty] of paths) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch (error) {
      if (absentIsEmpty && errorCode(error) === 'ENOENT') continue;
      return {
        kind: 'failed',
        reason: `the beads export ${path} could not be read: ${probeErrorMessage(error)}`,
      };
    }
    read.push(path);
    const found = maxQuestionNumber(qidLabelsIn(bytes));
    if (found > max) max = found;
  }
  return {kind: 'read', max, paths: read};
}

// ---- the lock ----------------------------------------------------------------

const LOCK_ATTEMPTS = 60;
const LOCK_SLEEP_MS = 50;
/** A lock older than this is stale whoever holds it (pid reuse, a hung run). */
const STALE_LOCK_MS = 60_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Whether the lock at `path` may be taken from its holder. */
function lockIsStale(path: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8').trim();
  } catch {
    return false;
  }
  if (/^[0-9]+$/.test(raw)) {
    const owner = Number(raw);
    if (owner !== process.pid && pidAlive(owner) === false) return true;
  }
  try {
    return Date.now() - statSync(path).mtimeMs > STALE_LOCK_MS;
  } catch {
    return false;
  }
}

type CounterLock = {kind: 'failed'; reason: string} | {kind: 'held'};

/** Take the counter's lock, waiting up to about 3 s. */
function takeCounterLock(env: EnvLike): CounterLock {
  const path = counterLockPath(env);
  try {
    mkdirSync(questionIdsDir(env), {recursive: true});
  } catch (error) {
    return {
      kind: 'failed',
      reason: `${questionIdsDir(env)} could not be created: ${probeErrorMessage(error)}`,
    };
  }
  let lastError: unknown = null;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      const fd = openSync(path, 'wx');
      try {
        writeFileSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      return {kind: 'held'};
    } catch (error) {
      lastError = error;
      if (errorCode(error) !== 'EEXIST') break;
      if (lockIsStale(path)) {
        try {
          rmSync(path, {force: true});
          continue;
        } catch {
          // Another waiter took it first; wait like everyone else.
        }
      }
      sleepSync(LOCK_SLEEP_MS);
    }
  }
  return {
    kind: 'failed',
    reason:
      errorCode(lastError) === 'EEXIST'
        ? `its lock ${path} stayed held for ${(LOCK_ATTEMPTS * LOCK_SLEEP_MS) / 1000} s`
        : `its lock ${path} could not be taken: ${probeErrorMessage(lastError)}`,
  };
}

function releaseCounterLock(env: EnvLike): void {
  try {
    rmSync(counterLockPath(env), {force: true});
  } catch {
    // A stranded lock is stolen once its holder is measurably gone, or stale.
  }
}

// ---- the file ----------------------------------------------------------------

type CounterRead =
  | {kind: 'failed'; reason: string}
  | {kind: 'missing'}
  | {kind: 'read'; last: number};

function readCounter(path: string): CounterRead {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return {kind: 'missing'};
    return {
      kind: 'failed',
      reason: `${path} could not be read: ${probeErrorMessage(error)}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      kind: 'failed',
      reason: `${path} is not JSON: ${probeErrorMessage(error)}`,
    };
  }
  const last =
    parsed != null && typeof parsed === 'object' && 'last' in parsed
      ? (parsed as {last: unknown}).last
      : undefined;
  if (typeof last !== 'number' || !Number.isSafeInteger(last) || last < 0) {
    return {
      kind: 'failed',
      reason: `${path} holds no "last" number`,
    };
  }
  return {kind: 'read', last};
}

/** Writes the file whole, through a rename, so a reader never sees half. */
function writeCounter(
  path: string,
  last: number,
  now: Date,
): {kind: 'failed'; reason: string} | {kind: 'written'} {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(
      temporary,
      `${JSON.stringify({last, updatedAt: now.toISOString()})}\n`,
    );
    renameSync(temporary, path);
    return {kind: 'written'};
  } catch (error) {
    try {
      rmSync(temporary, {force: true});
    } catch {
      // Left behind, it is ignored: only counter.json is read.
    }
    return {
      kind: 'failed',
      reason: `${path} could not be written: ${probeErrorMessage(error)}`,
    };
  }
}

// ---- reserving numbers ---------------------------------------------------------

export type ReservedNumbers =
  | {kind: 'failed'; reason: string}
  | {kind: 'reserved'; numbers: number[]};

export interface ReserveInput {
  /** Beads dirs to scan besides the sessions index's (the caller's own). */
  beadsDirs?: readonly string[];
  /** How many numbers: one for `thread ask`, one per question for status. */
  count: number;
  env: EnvLike;
  /**
   * TESTS ONLY: how long to hold the lock between reading and writing the
   * file, so a test can make a race wide enough to lose without the lock.
   */
  holdMs?: number;
  now?: Date;
}

/** reserveQuestionNumbers without its catch-all. */
function reserve(input: ReserveInput): ReservedNumbers {
  const {count, env} = input;
  if (!Number.isSafeInteger(count) || count < 0) {
    return {kind: 'failed', reason: `cannot reserve ${count} numbers`};
  }
  if (count === 0) return {kind: 'reserved', numbers: []};
  // The exports are read BEFORE the lock: the lock covers the file alone.
  const dirs = knownBeadsDirs(env, input.beadsDirs ?? []);
  if (dirs.kind === 'failed') return dirs;
  const exportsMax = highestNumberInExports(dirs.dirs);
  if (exportsMax.kind === 'failed') return exportsMax;

  const path = questionCounterPath(env);
  const lock = takeCounterLock(env);
  if (lock.kind === 'failed') {
    return {
      kind: 'failed',
      reason: `the question counter could not be locked: ${lock.reason}`,
    };
  }
  try {
    const counter = readCounter(path);
    if (counter.kind === 'failed') {
      return {
        kind: 'failed',
        reason: `the question counter could not be read: ${counter.reason}`,
      };
    }
    const first =
      Math.max(
        counter.kind === 'read' ? counter.last : 0,
        exportsMax.max,
        QUESTION_NUMBER_FLOOR,
      ) + 1;
    const last = first + count - 1;
    if (input.holdMs != null && input.holdMs > 0) sleepSync(input.holdMs);
    const written = writeCounter(path, last, input.now ?? new Date());
    if (written.kind === 'failed') {
      return {
        kind: 'failed',
        reason: `the question counter could not be bumped: ${written.reason}`,
      };
    }
    return {
      kind: 'reserved',
      numbers: Array.from({length: count}, (_, index) => first + index),
    };
  } finally {
    releaseCounterLock(env);
  }
}

/**
 * `count` numbers no one has had, in order, or why none could be handed out.
 * Never throws: an unexpected error is a failure with its message.
 */
export function reserveQuestionNumbers(input: ReserveInput): ReservedNumbers {
  try {
    return reserve(input);
  } catch (error) {
    return {
      kind: 'failed',
      reason: `the question counter threw: ${probeErrorMessage(error)}`,
    };
  }
}
