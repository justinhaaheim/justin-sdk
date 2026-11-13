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
 */

import type {EnvLike} from './paths';
import type {
  ReportBaseline,
  ReportSnapshot,
  SnapshotItems,
  SnapshotsRead,
  TurnEndRead,
} from './report-delta';

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
import {chooseBaseline} from './report-delta';

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
    const entry = (parsed ?? {}) as {at?: unknown; items?: unknown};
    if (
      typeof entry.at !== 'string' ||
      Number.isNaN(Date.parse(entry.at)) ||
      !isItems(entry.items)
    ) {
      malformed += 1;
      continue;
    }
    snapshots.push({at: entry.at, items: entry.items});
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
 * Append one snapshot, keeping the newest REPORT_SNAPSHOTS_KEPT. Rewrites
 * through a temporary file and a rename, so a reader never sees half a file.
 * NEVER THROWS: `thread status` still prints when this fails.
 */
export function saveReportSnapshot(args: {
  at: Date;
  env?: EnvLike;
  items: SnapshotItems;
  sessionId: string;
}): SnapshotSaveOutcome {
  const env = args.env ?? process.env;
  const path = reportSnapshotsPath(args.sessionId, env);
  const temp = `${path}.${process.pid}.tmp`;
  try {
    let raw = '';
    try {
      raw = readFileSync(path, 'utf8');
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    const next = [
      ...parseSnapshotsText(raw).snapshots,
      {at: args.at.toISOString(), items: args.items},
    ].slice(-REPORT_SNAPSHOTS_KEPT);
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(
      temp,
      next
        .map(
          (entry) => `${JSON.stringify({at: entry.at, items: entry.items})}\n`,
        )
        .join(''),
    );
    renameSync(temp, path);
    return {kind: 'saved', path};
  } catch (error) {
    try {
      rmSync(temp, {force: true});
    } catch {
      // The temp file is the smaller problem; the caller reports the real one.
    }
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
