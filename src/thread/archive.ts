/**
 * The report archive and the failure spool (home-base-p1uj D5).
 *
 * Two jobs, both about never losing a report:
 *
 *  - ARCHIVE. Every validated payload is written to
 *    `<stateDir>/reports/<sessionId>/<timestamp>.json` BEFORE a single bd
 *    command runs. bd can be locked, sandboxed, or simply missing; the payload
 *    is the expensive artefact and it must survive all three.
 *  - SPOOL. When the bd write then fails, the same document is written to
 *    `<stateDir>/spool/<sessionId>-<timestamp>.json`, which is what `thread
 *    board` drains later. The archive alone is not enough: it records every
 *    report, so nothing in it says which ones never reached a bead.
 *
 * Both return a Result. A failed archive is a NAMED failure the caller prints —
 * never a silently skipped write, because the one thing worse than a report
 * that did not reach bd is a report that reached nothing at all and said so
 * nowhere.
 */

import {mkdirSync, writeFileSync} from 'fs';
import {join} from 'path';

import {probeErrorMessage, threadsStateDir} from './paths';

import type {EnvLike} from './paths';
import type {ThreadFacts} from './facts';
import type {ThreadReportPayload} from './schema';

/** What gets written to disk: the payload, the facts, and the provenance. */
export interface ArchivedReport {
  facts: ThreadFacts;
  payload: ThreadReportPayload;
  reportedAt: string;
  schemaVersion: number;
  sessionId: string;
  /** Set on a spooled copy: why bd did not take it. Absent in the archive. */
  spoolReason?: string;
}

export type WriteResult =
  {ok: true; path: string} | {ok: false; path: string; error: string};

/**
 * A filesystem-safe stamp. `:` is legal on APFS but is rendered as `/` by
 * Finder and is a path separator on other platforms, so ISO's colons and the
 * fractional dot become dashes. Sorts lexicographically, which is the only
 * ordering the drain path needs.
 */
export function fileStamp(iso: string): string {
  return iso.replace(/[:.]/g, '-');
}

function writeJson(path: string, dir: string, body: unknown): WriteResult {
  try {
    mkdirSync(dir, {recursive: true});
    writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
    return {ok: true, path};
  } catch (error) {
    return {error: probeErrorMessage(error), ok: false, path};
  }
}

export function reportsDir(
  sessionId: string,
  env: EnvLike = process.env,
): string {
  return join(threadsStateDir(env), 'reports', sessionId);
}

export function spoolDir(env: EnvLike = process.env): string {
  return join(threadsStateDir(env), 'spool');
}

/** Where `thread prepare` tells Claude to write its payload. */
export function draftPath(
  sessionId: string,
  env: EnvLike = process.env,
): string {
  return join(threadsStateDir(env), 'drafts', `${sessionId}.json`);
}

/** Write the archive copy. Call BEFORE any bd command. */
export function archiveReport(
  report: ArchivedReport,
  env: EnvLike = process.env,
): WriteResult {
  const dir = reportsDir(report.sessionId, env);
  return writeJson(
    join(dir, `${fileStamp(report.reportedAt)}.json`),
    dir,
    report,
  );
}

/** Write the spool copy, with the reason bd did not take it. */
export function spoolReport(
  report: ArchivedReport,
  reason: string,
  env: EnvLike = process.env,
): WriteResult {
  const dir = spoolDir(env);
  const name = `${report.sessionId}-${fileStamp(report.reportedAt)}.json`;
  return writeJson(join(dir, name), dir, {...report, spoolReason: reason});
}
