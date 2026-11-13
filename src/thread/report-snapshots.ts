/**
 * The local state behind shorter repeat reports (home-base-1rxt0.4 D6): one
 * snapshot per `thread status` run, and the end of Claude's previous turn
 * from the transcript. report-delta.ts decides from what this reads.
 *
 * Snapshots live in `<threads state dir>/report-snapshots/<session id>.jsonl`,
 * one JSON line per run, the newest REPORT_SNAPSHOTS_KEPT kept. Local state,
 * never beads (D6). Saved by every run of the session's own `thread status`,
 * whatever the trim guard knob says, because the markers need them too.
 *
 * Separate from the trim guard's status-blocks file on purpose: that one
 * holds rendered text, is written only with `trimGuard` on, and drops a run
 * whose block did not change, so it cannot say what the report at the end of
 * a turn contained.
 *
 * SHOWN (home-base-sg9q9.11 F1): each snapshot carries the digest of its
 * printed block, and the Stop hook marks `shownAt` on every snapshot whose
 * block is in the final assistant message (markReportsShown), whatever the
 * trim guard knob says. Only a shown snapshot can be the last report. Nothing
 * marked (the hook did not run, could not write, or the block was cut) leaves
 * the next report in full: the cautious direction.
 */

import type {EnvLike} from './paths';
import type {
  ReportBaseline,
  ReportSnapshot,
  SnapshotBlock,
  SnapshotItems,
  SnapshotsRead,
  TurnEndRead,
} from './report-delta';
import type {NormalizedText} from './trim-guard';

import {
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

import {reportSnapshotsPath} from './archive';
import {transcriptMarkOf} from './handoff-predecessor';
import {blockDigest, chooseBaseline} from './report-delta';
import {normalizeText} from './trim-guard';

/**
 * How many snapshots one session keeps. A turn runs `thread status` two or
 * three times, so this covers well over ten turns; only the newest one before
 * the previous turn's end is ever read.
 */
export const REPORT_SNAPSHOTS_KEPT = 40;

/** The first window read from the transcript's end; it grows fourfold. */
export const TURN_END_FIRST_WINDOW = 256 * 1024;

function errorCode(error: unknown): string {
  return error != null && typeof error === 'object' && 'code' in error
    ? String((error as {code: unknown}).code)
    : '';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isItems(value: unknown): value is SnapshotItems {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((entry) => typeof entry === 'string');
}

/** One optional field of a line: its value, or `ok: false` for a bad shape. */
type FieldRead<T> = {ok: false} | {ok: true; value: T | null};

/**
 * A snapshot's `block` field: absent (a snapshot saved before F1) is null; a
 * well-formed one is kept; anything else makes the line malformed.
 */
function blockField(value: unknown): FieldRead<SnapshotBlock> {
  if (value === undefined || value === null) return {ok: true, value: null};
  if (typeof value !== 'object' || Array.isArray(value)) return {ok: false};
  const {digest, lines} = value as {digest?: unknown; lines?: unknown};
  if (typeof digest !== 'string' || digest === '') return {ok: false};
  if (typeof lines !== 'number' || !Number.isInteger(lines) || lines < 1) {
    return {ok: false};
  }
  return {ok: true, value: {digest, lines}};
}

/** A snapshot's `shownAt`: absent is null; a readable time is kept. */
function shownAtField(value: unknown): FieldRead<string> {
  if (value === undefined || value === null) return {ok: true, value: null};
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    return {ok: false};
  }
  return {ok: true, value};
}

/** One snapshot as a line of the file, every field written. */
function snapshotLine(entry: ReportSnapshot): string {
  return `${JSON.stringify({
    at: entry.at,
    block: entry.block,
    items: entry.items,
    shownAt: entry.shownAt,
  })}\n`;
}

/** The well-formed snapshots in a file's text, and how many lines were not. */
function parseSnapshotsText(raw: string): {
  lines: number;
  malformed: number;
  snapshots: ReportSnapshot[];
} {
  const snapshots: ReportSnapshot[] = [];
  let lines = 0;
  let malformed = 0;
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    lines += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      malformed += 1;
      continue;
    }
    const entry = (parsed ?? {}) as {
      at?: unknown;
      block?: unknown;
      items?: unknown;
      shownAt?: unknown;
    };
    const block = blockField(entry.block);
    const shownAt = shownAtField(entry.shownAt);
    if (
      typeof entry.at !== 'string' ||
      Number.isNaN(Date.parse(entry.at)) ||
      !isItems(entry.items) ||
      !block.ok ||
      !shownAt.ok
    ) {
      malformed += 1;
      continue;
    }
    snapshots.push({
      at: entry.at,
      block: block.value,
      items: entry.items,
      shownAt: shownAt.value,
    });
  }
  return {lines, malformed, snapshots};
}

/**
 * This session's snapshots, oldest first. No file, or a file with no lines, is
 * `none`. An unreadable file, or one with lines and none parseable, is
 * `unknown`: never read as "no earlier report" (critical rule 7).
 */
export function readReportSnapshots(
  sessionId: string,
  env: EnvLike = process.env,
): SnapshotsRead {
  const path = reportSnapshotsPath(sessionId, env);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return {kind: 'none'};
    return {kind: 'unknown', reason: `read ${path}: ${errorText(error)}`};
  }
  const {lines, snapshots} = parseSnapshotsText(raw);
  if (lines === 0) return {kind: 'none'};
  if (snapshots.length === 0) {
    return {
      kind: 'unknown',
      reason: `${path}: none of its ${lines} line(s) could be parsed`,
    };
  }
  return {kind: 'found', snapshots};
}

export type SnapshotSaveOutcome =
  | {error: string; kind: 'failed'; path: string}
  | {kind: 'saved'; path: string};

/**
 * F1: the block of a printed Part 1, as a snapshot holds it. `text` is what
 * the trim guard saves: renderPartOne in the plain style. Null when the text
 * holds no block start at its first line, so such a snapshot can never count
 * as shown.
 */
export function snapshotBlockOf(text: string): SnapshotBlock | null {
  const normalized = normalizeText(text);
  if (normalized.starts[0] !== 0 || normalized.lines.length === 0) return null;
  return {
    digest: blockDigest(normalized.lines),
    lines: normalized.lines.length,
  };
}

/**
 * F1: does the reply hold this block, as a consecutive run of its normalized
 * lines beginning at one of its block starts? The trim guard's blockIsInReply,
 * compared by digest.
 */
export function blockShownIn(
  block: SnapshotBlock,
  reply: NormalizedText,
): boolean {
  return reply.starts.some(
    (start) =>
      start + block.lines <= reply.lines.length &&
      blockDigest(reply.lines.slice(start, start + block.lines)) ===
        block.digest,
  );
}

/** Rewrite the file through a temporary file and a rename. Throws. */
function writeSnapshots(
  path: string,
  entries: readonly ReportSnapshot[],
): void {
  const temp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(temp, entries.map(snapshotLine).join(''));
    renameSync(temp, path);
  } catch (error) {
    try {
      rmSync(temp, {force: true});
    } catch {
      // The temp file is the smaller problem; the caller reports the real one.
    }
    throw error;
  }
}

/**
 * Append one snapshot, keeping the newest REPORT_SNAPSHOTS_KEPT and every
 * field of the ones kept (a `shownAt` survives the next save). Rewrites
 * through a temporary file and a rename, so a reader never sees half a file.
 * NEVER THROWS: `thread status` still prints when this fails.
 */
export function saveReportSnapshot(args: {
  at: Date;
  /** F1: the printed block (snapshotBlockOf); null when there was none. */
  block: SnapshotBlock | null;
  env?: EnvLike;
  items: SnapshotItems;
  sessionId: string;
}): SnapshotSaveOutcome {
  const env = args.env ?? process.env;
  const path = reportSnapshotsPath(args.sessionId, env);
  try {
    let raw = '';
    try {
      raw = readFileSync(path, 'utf8');
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    const next = [
      ...parseSnapshotsText(raw).snapshots,
      {
        at: args.at.toISOString(),
        block: args.block,
        items: args.items,
        shownAt: null,
      },
    ].slice(-REPORT_SNAPSHOTS_KEPT);
    writeSnapshots(path, next);
    return {kind: 'saved', path};
  } catch (error) {
    return {error: errorText(error), kind: 'failed', path};
  }
}

export type MarkShownOutcome =
  /** The reply holds no block start: nothing was read. */
  | {kind: 'noBlock'}
  /** The file is missing or holds no snapshot whose block the reply holds. */
  | {kind: 'noMatch'}
  | {error: string; kind: 'failed'; path: string}
  /** `at` of each snapshot newly marked shown. */
  | {kind: 'marked'; marked: string[]; path: string};

/**
 * F1, at Stop: mark `shownAt` on every snapshot whose block is in `reply`, the
 * payload's `last_assistant_message` (what Justin was shown). The cheap case,
 * a reply with no block, reads nothing. NEVER THROWS: a failure marks nothing,
 * and the next report is in full.
 */
export function markReportsShown(args: {
  env?: EnvLike;
  now: Date;
  reply: string;
  sessionId: string;
}): MarkShownOutcome {
  const reply = normalizeText(args.reply);
  if (reply.starts.length === 0) return {kind: 'noBlock'};
  const env = args.env ?? process.env;
  const path = reportSnapshotsPath(args.sessionId, env);
  try {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return {kind: 'noMatch'};
      throw error;
    }
    // A malformed line is dropped by the rewrite, as saveReportSnapshot does.
    const {snapshots} = parseSnapshotsText(raw);
    const marked: string[] = [];
    const next = snapshots.map((snapshot) => {
      if (
        snapshot.shownAt != null ||
        snapshot.block == null ||
        !blockShownIn(snapshot.block, reply)
      ) {
        return snapshot;
      }
      marked.push(snapshot.at);
      return {...snapshot, shownAt: args.now.toISOString()};
    });
    if (marked.length === 0) return {kind: 'noMatch'};
    writeSnapshots(path, next);
    return {kind: 'marked', marked, path};
  } catch (error) {
    return {error: errorText(error), kind: 'failed', path};
  }
}

/**
 * The time of the transcript's newest `turn_duration` record: the end of
 * Claude's previous turn (pkg CLAUDE.md, Gotchas: never the message log's
 * `event: "Stop"`, which is rewritten as `backfill`; a Stop a hook blocked
 * writes only `stop_hook_summary`, so it is not a turn end). Read from the
 * end in a window that grows fourfold until a record is found or the whole
 * file was read, so a long current turn cannot hide the previous turn's end.
 * The record's shape is transcriptMarkOf's, so a subagent's record never
 * counts.
 */
export function readNewestTurnEnd(
  path: string,
  firstWindow: number = TURN_END_FIRST_WINDOW,
): TurnEndRead {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (error) {
    return {
      kind: 'failed',
      reason: `${path} could not be opened: ${errorText(error)}`,
    };
  }
  try {
    const size = fstatSync(fd).size;
    let window = Math.min(size, Math.max(1, firstWindow));
    for (;;) {
      const buffer = Buffer.alloc(window);
      let read = 0;
      while (read < window) {
        const got = readSync(
          fd,
          buffer,
          read,
          window - read,
          size - window + read,
        );
        if (got === 0) break;
        read += got;
      }
      if (read < window) {
        return {
          kind: 'failed',
          reason: `${path} gave ${read} of ${window} bytes (it shrank while being read)`,
        };
      }
      const lines = buffer.toString('utf8').split('\n');
      // A window that starts mid-file starts mid-line; the last piece is ''
      // after a final newline, or a line Claude Code is still writing.
      if (window < size) lines.shift();
      lines.pop();
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index] ?? '';
        if (!line.includes('turn_duration')) continue;
        let record: unknown;
        try {
          record = JSON.parse(line) as unknown;
        } catch {
          continue;
        }
        const mark = transcriptMarkOf(record);
        if (mark?.kind !== 'turnEnd') continue;
        if (mark.at == null) {
          return {
            kind: 'failed',
            reason: `the newest turn_duration record in ${path} has no timestamp`,
          };
        }
        return {at: mark.at, kind: 'found'};
      }
      if (window >= size) return {kind: 'none'};
      window = Math.min(size, window * 4);
    }
  } catch (error) {
    return {
      kind: 'failed',
      reason: `${path} could not be read: ${errorText(error)}`,
    };
  } finally {
    closeSync(fd);
  }
}

/** D6: the last report for `thread status` in this session. */
export function reportBaselineFor(input: {
  env: EnvLike;
  sessionId: string;
  /** The transcript's path, or why it is not known. */
  transcript: {ok: true; path: string} | {ok: false; reason: string};
}): ReportBaseline {
  return chooseBaseline(readReportSnapshots(input.sessionId, input.env), () =>
    input.transcript.ok
      ? readNewestTurnEnd(input.transcript.path)
      : {kind: 'failed', reason: input.transcript.reason},
  );
}
