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
 * `superseded` removes the file because replaying it would do HARM, not because
 * it succeeded (F6). D1 rewrites the thread bead in place, so an older payload
 * written over a newer one regresses the bead to a state Justin already moved
 * past. But its ASKS were never created and never will be — they belong to a
 * report the thread has overtaken — so the line says exactly that, with the
 * count, instead of claiming the report reached its destination. The payload
 * itself survives in the archive (`<stateDir>/reports/<sessionId>/`), which is
 * never pruned, so a discarded ask is recoverable by hand from there.
 *
 * A file we cannot PARSE is never removed either. "I do not understand this"
 * and "this has been handled" are different facts, and only one of them makes
 * deletion safe.
 */

import {readdirSync, readFileSync, renameSync, rmSync} from 'fs';
import {join} from 'path';

import {bdContext, type BdContext} from './bd';
import {describeBdFailure} from './bd';
import {spoolDir} from './archive';
import {validateThreadFacts, validateThreadReport} from './schema';
import {writeReportToBd, type BdWriteOutcome} from './report';

import type {ArchivedReport} from './archive';
import type {EnvLike} from './paths';

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
  /** Inflight files left by a drain that died; renamed back and replayed here. */
  reclaimed: number;
  /** Files another drain had already claimed. NOT ours to report on. */
  skippedConcurrent: number;
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

/**
 * THE DRAIN LOCK (F10), and it is one `rename(2)` rather than a lock file.
 *
 * Two `thread board` runs used to read the same listing and both apply every
 * file in it: the loser wrote a duplicate report, or got a refusal for asks the
 * winner had already closed, and then printed a 🚨 STILL SPOOLED line for a file
 * the winner had already removed. Renaming a file to `<name>.inflight-<pid>`
 * before touching it is atomic on every POSIX filesystem — exactly one of the
 * two renames can succeed, and the loser's ENOENT IS the lock being taken.
 *
 * The suffix deliberately does not end in `.json`, so an inflight file is
 * invisible to `spoolFiles` and cannot be picked up twice.
 *
 * A drain that DIES while holding a file would strand it under a name nothing
 * looks for — the spool losing a report silently, which is the failure this
 * whole subsystem exists to prevent. Hence the pid in the name and the reclaim
 * sweep: an inflight file whose owner is MEASURABLY gone is renamed back and
 * replayed. "I could not tell whether that process is alive" leaves it alone.
 */
const INFLIGHT_SUFFIX = '.inflight-';

function inflightName(name: string, pid: number): string {
  return `${name}${INFLIGHT_SUFFIX}${pid}`;
}

/** The pid an inflight file names, or null when this is not one. */
function pidOfInflight(name: string): number | null {
  const at = name.lastIndexOf(INFLIGHT_SUFFIX);
  if (at === -1) return null;
  const raw = name.slice(at + INFLIGHT_SUFFIX.length);
  if (!/^[0-9]+$/.test(raw)) return null;
  const pid = Number(raw);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/** true = running, false = MEASURED gone, null = could not tell (rule 6). */
function pidAlive(pid: number): boolean | null {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code =
      error != null && typeof error === 'object' && 'code' in error
        ? String((error as {code: unknown}).code)
        : '';
    if (code === 'ESRCH') return false;
    // EPERM means it exists and belongs to someone else.
    if (code === 'EPERM') return true;
    return null;
  }
}

/** Rename abandoned inflight files back so this run can replay them. */
function reclaimAbandoned(dir: string): number {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let reclaimed = 0;
  for (const name of names) {
    const pid = pidOfInflight(name);
    if (pid == null) continue;
    if (pid === process.pid) continue; // ours, this very run
    if (pidAlive(pid) !== false) continue; // alive, or unknowable — hands off
    const base = name.slice(0, name.lastIndexOf(INFLIGHT_SUFFIX));
    try {
      renameSync(join(dir, name), join(dir, base));
      reclaimed += 1;
    } catch {
      // Another drain reclaimed it first, or the rename failed; either way the
      // file is still there under one of the two names for the next run.
    }
  }
  return reclaimed;
}

type Claim =
  | {kind: 'claimed'; path: string}
  | {kind: 'taken'}
  | {kind: 'failed'; error: string};

/** Take one spool file, atomically. ENOENT means a concurrent drain won. */
function claimSpoolFile(dir: string, name: string): Claim {
  const from = join(dir, name);
  const to = join(dir, inflightName(name, process.pid));
  try {
    renameSync(from, to);
    return {kind: 'claimed', path: to};
  } catch (error) {
    const code =
      error != null && typeof error === 'object' && 'code' in error
        ? String((error as {code: unknown}).code)
        : '';
    if (code === 'ENOENT') return {kind: 'taken'};
    return {
      error: error instanceof Error ? error.message : String(error),
      kind: 'failed',
    };
  }
}

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
  // THE FACTS ARE VALIDATED TOO (F11), not cast. A facts object without a
  // string `reportedAt` used to reach the supersede guard, where
  // `"2026-…" > undefined` is false — so the guard said "not superseded" and the
  // stale payload was APPLIED over newer state, rendering `undefined` into the
  // bead. An unvalidatable facts document is a THIRD fact, distinct from both
  // "replay it" and "it has been overtaken", so the file is kept and named.
  const facts = validateThreadFacts(document.facts);
  if (facts.status === 'invalid') {
    return {
      detail: `the spooled facts no longer validate: ${facts.issues.slice(0, 3).join('; ')}`,
      ok: false,
    };
  }
  return {
    ok: true,
    report: {
      facts: facts.facts,
      payload: validation.payload,
      reportedAt:
        typeof document.reportedAt === 'string' && document.reportedAt !== ''
          ? document.reportedAt
          : facts.facts.reportedAt,
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

  const reclaimed = reclaimAbandoned(dir);
  const files = spoolFiles(dir);
  if (files == null) return null; // could not even look — the caller says so
  const summary: DrainSummary = {
    applied: 0,
    kept: 0,
    outcomes: [],
    reclaimed,
    skippedConcurrent: 0,
    superseded: 0,
  };

  /** Put a file back in the spool under its original name. */
  const release = (inflight: string, name: string): string | null => {
    try {
      renameSync(inflight, join(dir, name));
      return null;
    } catch (error) {
      // The file is still on disk under the inflight name, and the next drain
      // reclaims it once this process is gone — but say so rather than letting
      // a "kept" line imply it is sitting in the spool where it was.
      return error instanceof Error ? error.message : String(error);
    }
  };

  for (const name of files) {
    const claim = claimSpoolFile(dir, name);
    if (claim.kind === 'taken') {
      summary.skippedConcurrent += 1;
      continue;
    }
    if (claim.kind === 'failed') {
      summary.kept += 1;
      summary.outcomes.push({
        detail: `could not be claimed for the drain (${claim.error}) — NOT applied`,
        file: name,
        kind: 'kept',
      });
      continue;
    }
    const path = claim.path;
    const read = readSpooled(path);
    if (!read.ok) {
      const failedRelease = release(path, name);
      summary.kept += 1;
      summary.outcomes.push({
        detail:
          failedRelease == null
            ? read.detail
            : `${read.detail}; and it could not be put back (${failedRelease}) — it is now ${inflightName(name, process.pid)}`,
        file: name,
        kind: 'kept',
      });
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
        detail: (() => {
          const count = read.report.payload.asks.length;
          const asks =
            count === 0
              ? 'it asked for nothing'
              : `its ${count} ask${count === 1 ? '' : 's'} were NEVER created and will not be — they belong to a report the thread has overtaken`;
          return `superseded by report #${outcome.existingReportCount} on ${outcome.threadId} (${outcome.existingReportedAt}) — NOT applied; ${asks}. The payload is still in the archive.`;
        })(),
        file: name,
        kind: 'superseded',
      });
      continue;
    }
    const failedRelease = release(path, name);
    const detail =
      outcome.status === 'refused'
        ? `refused: open asks not dispositioned (${outcome.missing.join(', ')})`
        : describeBdFailure(outcome.failure);
    summary.kept += 1;
    summary.outcomes.push({
      detail:
        failedRelease == null
          ? detail
          : `${detail}; and it could not be put back (${failedRelease}) — it is now ${inflightName(name, process.pid)}`,
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
  if (summary.outcomes.length === 0 && summary.reclaimed === 0) return [];
  const lines = [
    `applied ${summary.applied} spooled report${summary.applied === 1 ? '' : 's'}` +
      (summary.superseded > 0 ? ` · ${summary.superseded} superseded` : '') +
      (summary.kept > 0 ? ` · ${summary.kept} STILL SPOOLED` : '') +
      (summary.reclaimed > 0
        ? ` · ${summary.reclaimed} reclaimed from an interrupted drain`
        : '') +
      (summary.skippedConcurrent > 0
        ? ` · ${summary.skippedConcurrent} left to another drain running now`
        : ''),
  ];
  for (const outcome of summary.outcomes) {
    if (outcome.kind === 'applied') continue;
    lines.push(
      `  ${outcome.kind === 'kept' ? '🚨' : '·'} ${outcome.file}: ${outcome.detail}`,
    );
  }
  return lines;
}
