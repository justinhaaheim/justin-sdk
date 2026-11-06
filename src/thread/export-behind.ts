/**
 * The session bead is in the database and not in the export (home-base-jm5kg.11.2).
 *
 * `thread status` reads the export, and session-tree.ts's header says why: that
 * stands. But the export can lag, and when it does its silence is not "the
 * session has no bead". On 2026-11-06 a successor picked up 9 requests at
 * 16:32:00Z while `thread status` printed "handoff pickup not done" and Unknown
 * until the export was rewritten at 16:35:26Z (critical rule 7). br writes the
 * database and exits 0, but does not rewrite an export holding conflict markers;
 * the `br sync --status` count grows until the markers are gone (measured
 * 2026-11-06, home-base-jm5kg.11.3).
 *
 * Only a session that the export cannot answer for pays for these br calls.
 */

import type {EnvLike} from './paths';
import type {Measured} from './session-model';

import {
  brExportLag,
  brShow,
  describeBrFailed,
  resolveRecordedBeadsDb,
} from '../beads/br';
import {readBeadsExport} from './session-tree';

const CONFLICT_MARKER = /^(?:<{7}|\|{7}|={7}|>{7})/mu;

export interface ExportBehind {
  beadId: string;
  /** Changes the export does not hold, or why they could not be counted. */
  changes: Measured<number>;
  /**
   * The export holds conflict markers, which br will not rewrite. Read from the
   * file: br 0.1.37's `sync --status` does not report them (measured 2026-11-06).
   * Null: the file could not be read.
   */
  conflictMarkers: boolean | null;
  /** The bead's labels in the database. */
  labels: string[];
  /** The bead's title in the database. */
  title: string;
}

/** The session bead's labels in the database. */
export type DbBeadRead =
  /** The database does not hold it either. */
  | {kind: 'absent'; reason: string}
  | {db: string; kind: 'read'; labels: string[]; title: string}
  | {kind: 'failed'; reason: string};

export function readBeadFromDb(input: {
  beadId: string;
  beadsDir: string;
  env: EnvLike;
}): DbBeadRead {
  const {beadId, beadsDir, env} = input;
  const found = resolveRecordedBeadsDb(beadsDir);
  if (found.kind !== 'found') {
    return {
      kind: 'failed',
      reason: `the beads DB of ${beadsDir} could not be found: ${found.reason}`,
    };
  }
  const shown = brShow({db: found.db, env}, beadId);
  if (shown.kind === 'notFound') {
    return {kind: 'absent', reason: `${beadId} is not in ${found.db}`};
  }
  if (shown.kind !== 'ok') {
    return {
      kind: 'failed',
      reason: `${beadId} could not be read from ${found.db}: ${describeBrFailed(shown)}`,
    };
  }
  // `br delete` keeps a tombstone that `br show` returns: the bead is gone, and
  // reading it as "the export is behind" would never clear.
  if (shown.issue.status === 'tombstone') {
    return {kind: 'absent', reason: `${beadId} was deleted from ${found.db}`};
  }
  return {
    db: found.db,
    kind: 'read',
    labels: shown.issue.labels,
    title: shown.issue.title,
  };
}

export type ExportBehindCheck =
  | {behind: ExportBehind; kind: 'behind'}
  | {kind: 'absent'}
  | {kind: 'failed'; reason: string};

/** Whether a session bead missing from the export is in the database. */
export function checkExportBehind(input: {
  beadId: string;
  beadsDir: string;
  env: EnvLike;
}): ExportBehindCheck {
  const read = readBeadFromDb(input);
  if (read.kind === 'absent') return {kind: 'absent'};
  if (read.kind === 'failed') return read;
  const lag = brExportLag({db: read.db, env: input.env});
  const exported = readBeadsExport(input.beadsDir);
  return {
    behind: {
      beadId: input.beadId,
      changes: lag.ok
        ? {ok: true, value: lag.lag.dirtyCount}
        : {ok: false, reason: describeBrFailed(lag.failed)},
      conflictMarkers:
        exported.kind === 'read' ? CONFLICT_MARKER.test(exported.text) : null,
      labels: read.labels,
      title: read.title,
    },
    kind: 'behind',
  };
}

/** The one sentence every surface prints. It names no command to run. */
export function exportBehindWords(behind: ExportBehind): string {
  const count = behind.changes.ok
    ? `${behind.changes.value} ${behind.changes.value === 1 ? 'change' : 'changes'} behind`
    : `behind (how many changes could not be read: ${behind.changes.reason})`;
  const next =
    behind.conflictMarkers === true
      ? 'br will not rewrite it while it holds merge conflict markers'
      : behind.conflictMarkers === false
        ? 'br rewrites it at the next bead write'
        : 'it catches up when br next rewrites it';
  return `the bead export is ${count} the database and does not hold this session's bead (${behind.beadId}) yet, so its requests cannot be shown; ${next}`;
}
