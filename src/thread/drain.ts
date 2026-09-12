/**
 * Draining the spool (home-base-p1uj D5).
 *
 * When bd refuses a report, `thread report` still prints it, writes the payload
 * to `<stateDir>/spool/` and exits non-zero. This is the other half of that
 * promise: `thread board` drains the spool before it shows anything, so a
 * report that could not be recorded at the time is not lost, merely late.
 *
 * THE FILE IS REMOVED ONLY WHEN ITS CONTENT HAS DEFINITELY LANDED SOMEWHERE.
 * Three outcomes remove it — applied, superseded, and nothing else — and every
 * other outcome leaves it exactly where it was. That asymmetry is the whole
 * design: a spool file that is deleted after a failed apply is a report that
 * has vanished from the only place still tracking it, and it would vanish
 * quietly, during a command whose output is a reassuring dashboard.
 *
 * `superseded` removes the file because the report DID reach its destination —
 * it was simply overtaken. D1 rewrites the thread bead in place, so replaying
 * an older payload over a newer one would regress the bead. The payload still
 * exists in the archive (`<stateDir>/reports/<sessionId>/`), which is never
 * pruned, so nothing is destroyed by dropping the spool copy.
 *
 * A file we cannot PARSE is never removed either. "I do not understand this"
 * and "this has been handled" are different facts, and only one of them makes
 * deletion safe.
 */

import {readdirSync, readFileSync, rmSync} from 'fs';
import {join} from 'path';

import {bdContext, type BdContext} from './bd';
import {describeBdFailure} from './bd';
import {spoolDir} from './archive';
import {validateThreadReport} from './schema';
import {writeReportToBd, type BdWriteOutcome} from './report';

import type {ArchivedReport} from './archive';
import type {EnvLike} from './paths';
import type {ThreadFacts} from './facts';

export type SpoolOutcomeKind = 'applied' | 'superseded' | 'kept';

export interface SpoolOutcome {
  detail: string;
  file: string;
  kind: SpoolOutcomeKind;
}

export interface DrainSummary {
  applied: number;
  kept: number;
  outcomes: SpoolOutcome[];
  superseded: number;
}

/**
 * How one spooled report is replayed. Injectable so the drain's own contract —
 * remove on success, KEEP on failure — can be proven by a test without a bd
 * database, which is the one thing a test cannot conjure.
 */
export type SpoolApplier = (
  report: ArchivedReport,
  ctx: BdContext,
) => Promise<BdWriteOutcome>;

/** The real applier: the same write path a live report takes, plus the guard. */
export const applyViaBd: SpoolApplier = async (report, ctx) =>
  writeReportToBd({
    ctx,
    facts: report.facts,
    payload: report.payload,
    sessionId: report.sessionId,
    supersedeGuard: true,
  });

/** Files are named `<sessionId>-<stamp>.json`, so a name sort is oldest-first per session. */
function spoolFiles(dir: string): string[] | null {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .sort();
  } catch (error) {
    // A missing spool dir is a MEASURED empty spool: nothing has ever failed.
    // Any other error is not, and must not be reported as "nothing to do".
    if (
      error != null &&
      typeof error === 'object' &&
      'code' in error &&
      (error as {code: unknown}).code === 'ENOENT'
    ) {
      return [];
    }
    return null;
  }
}

/**
 * Read one spool file into a report, or say why not.
 *
 * The payload is re-validated rather than trusted: it was validated when it was
 * written, but by a possibly older schema, and applying an invalid payload
 * would write a malformed bead. An invalid file is KEPT and named, so a human
 * can see it rather than it silently disappearing.
 */
function readSpooled(
  path: string,
): {ok: true; report: ArchivedReport} | {ok: false; detail: string} {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    return {detail: `unreadable (${String(error)})`, ok: false};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {detail: `not valid JSON (${String(error)})`, ok: false};
  }
  const document = parsed as Partial<ArchivedReport>;
  if (
    document == null ||
    typeof document.sessionId !== 'string' ||
    document.sessionId === '' ||
    document.facts == null ||
    document.payload == null
  ) {
    return {detail: 'missing sessionId, facts or payload', ok: false};
  }
  const validation = validateThreadReport(document.payload);
  if (validation.status === 'invalid') {
    return {
      detail: `the spooled payload no longer validates: ${validation.issues.slice(0, 3).join('; ')}`,
      ok: false,
    };
  }
  return {
    ok: true,
    report: {
      facts: document.facts as ThreadFacts,
      payload: validation.payload,
      reportedAt:
        typeof document.reportedAt === 'string'
          ? document.reportedAt
          : (document.facts as ThreadFacts).reportedAt,
      schemaVersion:
        typeof document.schemaVersion === 'number' ? document.schemaVersion : 1,
      sessionId: document.sessionId,
    },
  };
}

export interface DrainOptions {
  apply?: SpoolApplier;
  ctx?: BdContext;
  env?: EnvLike;
}

export async function drainSpool(
  options: DrainOptions = {},
): Promise<DrainSummary | null> {
  const env = options.env ?? process.env;
  const ctx = options.ctx ?? bdContext(env);
  const apply = options.apply ?? applyViaBd;
  const dir = spoolDir(env);

  const files = spoolFiles(dir);
  if (files == null) return null; // could not even look — the caller says so
  const summary: DrainSummary = {
    applied: 0,
    kept: 0,
    outcomes: [],
    superseded: 0,
  };

  for (const name of files) {
    const path = join(dir, name);
    const read = readSpooled(path);
    if (!read.ok) {
      summary.kept += 1;
      summary.outcomes.push({detail: read.detail, file: name, kind: 'kept'});
      continue;
    }
    const outcome = await apply(read.report, ctx);
    if (outcome.status === 'written') {
      rmSync(path, {force: true});
      summary.applied += 1;
      summary.outcomes.push({
        detail: `→ ${outcome.threadId} (report #${outcome.reportCount})`,
        file: name,
        kind: 'applied',
      });
      continue;
    }
    if (outcome.status === 'superseded') {
      rmSync(path, {force: true});
      summary.superseded += 1;
      summary.outcomes.push({
        detail: `superseded by report #${outcome.existingReportCount} on ${outcome.threadId} (${outcome.existingReportedAt}); the archive still has it`,
        file: name,
        kind: 'superseded',
      });
      continue;
    }
    summary.kept += 1;
    summary.outcomes.push({
      detail:
        outcome.status === 'refused'
          ? `refused: open asks not dispositioned (${outcome.missing.join(', ')})`
          : describeBdFailure(outcome.failure),
      file: name,
      kind: 'kept',
    });
  }

  return summary;
}

/** The lines `thread board` prints. Empty when the spool was empty (D5). */
export function renderDrain(summary: DrainSummary | null): string[] {
  if (summary == null) {
    return [
      '⚠️ could not read the spool directory — spooled reports may be waiting.',
    ];
  }
  if (summary.outcomes.length === 0) return [];
  const lines = [
    `applied ${summary.applied} spooled report${summary.applied === 1 ? '' : 's'}` +
      (summary.superseded > 0 ? ` · ${summary.superseded} superseded` : '') +
      (summary.kept > 0 ? ` · ${summary.kept} STILL SPOOLED` : ''),
  ];
  for (const outcome of summary.outcomes) {
    if (outcome.kind === 'applied') continue;
    lines.push(
      `  ${outcome.kind === 'kept' ? '🚨' : '·'} ${outcome.file}: ${outcome.detail}`,
    );
  }
  return lines;
}
