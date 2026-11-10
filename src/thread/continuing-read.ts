/**
 * `thread focus`'s reverse-link check (focus.ts, step 3 of the walk): which
 * beads carry `continues:<head>` in one beads database (home-base-9ihcl.4.1,
 * item 2).
 *
 * WHY NOT ONLY br list. br 0.1.37's `br list --json --limit 0 --all -l
 * continues:<head>` took 13.7 s on home-base's database (2026-11-10), most of
 * the 15 s an `f` in the dashboard took. The export holds the same labels and
 * costs milliseconds (home-base's 11 MB: read 3 ms, sha256 4 ms, index 15 ms).
 *
 * WHEN THE EXPORT IS READ (DECIDED by the conductor, home-base-hg6lz,
 * 2026-11-10). The export can lag the database: conflict markers that land in
 * it between a link's freshness check and its write leave `continues:` in the
 * database only (item 1's proof, tests/thread-continues-export.test.ts). So
 * the export is used only when br confirms it is the database's state:
 *  1. read the export's bytes;
 *  2. THEN run `br sync --status --json` on that database (0.1 to 0.2 s);
 *  3. use the bytes only when their sha256 equals `jsonl_content_hash`,
 *     `dirty_count` is 0, and `jsonl_newer` and `db_newer` are both false.
 * Anything else falls back to the br list this replaced, including a failed
 * status call, an export that cannot be read and one that does not parse. The
 * fallback and its reason are a phase of `thread focus --json`'s timings.
 *
 * Why that is safe. `jsonl_content_hash` is STORED by br when it writes or
 * imports the export, not computed from the file (measured on br 0.1.37,
 * 2026-11-10), so equal bytes are the export br last wrote; `dirty_count` 0
 * says the database holds nothing that export lacks. The read comes FIRST: a
 * br write that flushes between the read and the status changes the stored
 * hash, and one that does not flush makes `dirty_count` non-zero, so neither
 * slips through. A write after the status is a write after the check, exactly
 * as with a br list run a moment earlier. br 0.1.37 rewrites the export by
 * rename, so a read never sees half a file.
 *
 * THE SAME ANSWER AS br list (measured on br 0.1.37, 2026-11-10; asserted by
 * tests/thread-continues-checked-export.test.ts):
 *  - Which beads: `--all` lists open, in-progress, deferred and closed beads
 *    and leaves out deleted ones (tombstones). The export index leaves out
 *    tombstones too (session-tree.ts indexExport).
 *  - Their order: br lists by priority (0 first), then the newest created
 *    first. The ids from the export are sorted the same way; a tie on both is
 *    broken by id, which was not measured.
 *  - Not the same: an `--ephemeral` bead is never exported, so one carrying
 *    `continues:` is found by br list only. Nothing in the SDK creates
 *    ephemeral beads; linkContinuation writes these labels on session beads.
 */

import type {BrIssue, BrSyncStatus, BrSyncStatusOutcome} from '../beads/br';
import type {TimingRecorder} from './inbox-timings';
import type {EnvLike} from './paths';

import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';

import {brList, brSyncStatus, describeBrFailed} from '../beads/br';
import {BEADS_JSONL} from '../beads/jsonl';
import {parseInstant} from './answer-store';
import {timed} from './inbox-timings';
import {probeErrorMessage} from './paths';
import {CONTINUES_LABEL_PREFIX} from './session-bead';
import {indexedRecordsMatching, indexExport} from './session-tree';

/** What the check reads; injected, so a test can put a write between the two. */
export interface ExportCheckDeps {
  /** The export's bytes; throws when they cannot be read. */
  readBytes: (path: string) => Buffer;
  /** `br sync --status --json` on the database `db`. */
  syncStatus: (db: string) => BrSyncStatusOutcome;
}

export function realExportCheckDeps(env: EnvLike): ExportCheckDeps {
  return {
    readBytes: (path) => readFileSync(path),
    syncStatus: (db) => brSyncStatus({db, env}),
  };
}

/**
 * The export br writes beside the database `db`. br can be told another file
 * name in `.beads/metadata.json`; that is not read here, and needs not be: a
 * file that is not the one br wrote fails the hash check and falls back.
 */
export function exportPathOf(db: string): string {
  return join(dirname(db), BEADS_JSONL);
}

export type ExportCheck =
  | {kind: 'current'; path: string; text: string}
  | {kind: 'notCurrent'; path: string; reason: string};

/**
 * Why an export whose bytes hash to `sha256` is not the database's state, by
 * `status`; empty when it is. Every condition that fails is named.
 */
export function notCurrentReasons(
  sha256: string,
  status: BrSyncStatus,
): string[] {
  const reasons: string[] = [];
  const stored = status.jsonlContentHash?.toLowerCase() ?? null;
  if (stored == null) {
    reasons.push('br stored no hash of the export');
  } else if (stored !== sha256) {
    reasons.push(
      `the export's sha256 ${sha256.slice(0, 12)} is not the ${stored.slice(0, 12)} br stored`,
    );
  }
  if (status.dirtyCount !== 0) {
    reasons.push(`dirty_count ${status.dirtyCount}`);
  }
  if (status.jsonlNewer) reasons.push('jsonl_newer');
  if (status.dbNewer) reasons.push('db_newer');
  return reasons;
}

/** Read the export of `db`, then ask br whether it is the database's state. */
export function checkExport(db: string, deps: ExportCheckDeps): ExportCheck {
  const path = exportPathOf(db);
  let bytes: Buffer;
  try {
    bytes = deps.readBytes(path);
  } catch (error) {
    return {
      kind: 'notCurrent',
      path,
      reason: `the export could not be read: ${probeErrorMessage(error)}`,
    };
  }
  // AFTER the read, never before: see the header.
  const status = deps.syncStatus(db);
  if (!status.ok) {
    return {
      kind: 'notCurrent',
      path,
      reason: `br sync --status failed: ${describeBrFailed(status.failed)}`,
    };
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const reasons = notCurrentReasons(sha256, status.status);
  if (reasons.length > 0) {
    return {kind: 'notCurrent', path, reason: reasons.join(', ')};
  }
  return {kind: 'current', path, text: bytes.toString('utf8')};
}

/**
 * br list's order, as measured on br 0.1.37: priority ascending, then the
 * newest created first. A bead without a priority or a creation time sorts
 * after one with it; a tie is broken by id (unmeasured).
 */
export function brListOrder(a: BrIssue, b: BrIssue): number {
  if (a.priority !== b.priority) {
    if (a.priority == null) return 1;
    if (b.priority == null) return -1;
    return a.priority - b.priority;
  }
  const aAt = parseInstant(a.createdAt);
  const bAt = parseInstant(b.createdAt);
  if (aAt !== bAt) {
    if (aAt == null) return 1;
    if (bAt == null) return -1;
    return bAt - aAt;
  }
  // Equal to the millisecond: the full text (br writes microseconds).
  if (
    a.createdAt != null &&
    b.createdAt != null &&
    a.createdAt !== b.createdAt
  ) {
    return a.createdAt < b.createdAt ? 1 : -1;
  }
  return a.id.localeCompare(b.id, 'en', {numeric: true});
}

/**
 * The beads of a current export that carry `continues:<headBeadId>`, in br
 * list's order; or why the export could not answer (a line naming the label
 * that does not parse: it could be the very bead).
 */
export function continuingInExport(input: {
  db: string;
  headBeadId: string;
  path: string;
  text: string;
}): {ids: string[]; ok: true} | {ok: false; reason: string} {
  const label = `${CONTINUES_LABEL_PREFIX}${input.headBeadId}`;
  const built = indexExport(
    {kind: 'read', path: input.path, text: input.text},
    dirname(input.db),
  );
  if (built.kind === 'failed') return {ok: false, reason: built.reason};
  const found = indexedRecordsMatching(
    built.index,
    [JSON.stringify(label)],
    built.index.byLabel.get(label) ?? [],
  );
  if (!found.ok) {
    return {ok: false, reason: `the export did not parse: ${found.reason}`};
  }
  return {
    ids: [...found.issues].sort(brListOrder).map((issue) => issue.id),
    ok: true,
  };
}

/** Where an answer came from. */
export type ContinuingSource =
  | {fallback: string; kind: 'brList'}
  | {kind: 'export'; path: string};

export type ContinuingInDb =
  | {ids: string[]; kind: 'read'; source: ContinuingSource}
  | {kind: 'failed'; reason: string};

/** A reason as one short line, for a phase name. */
function oneLine(reason: string): string {
  const first = reason.split('\n')[0] ?? '';
  return first.length > 200 ? `${first.slice(0, 199)}…` : first;
}

/**
 * The beads labelled `continues:<headBeadId>` in the database `db`: from the
 * export when br confirms it, else from br list. A failed br list is a
 * failure, never "none" (critical rule 7). With `timings`, the check is the
 * phase `export check <db>`, and the answer the phase `reverse links from the
 * export <path>` or `reverse links from br list, export not used (<why>)
 * <db>`, so `thread focus --json` says which was used and why.
 */
export function continuingInDb(input: {
  db: string;
  deps?: ExportCheckDeps;
  env: EnvLike;
  headBeadId: string;
  timings?: TimingRecorder | null;
}): ContinuingInDb {
  const {db, env, headBeadId, timings} = input;
  const deps = input.deps ?? realExportCheckDeps(env);
  const check = timed(timings, `export check ${db}`, () =>
    checkExport(db, deps),
  );
  let fallback: string;
  if (check.kind === 'current') {
    const found = timed(
      timings,
      `reverse links from the export ${check.path}`,
      () =>
        continuingInExport({
          db,
          headBeadId,
          path: check.path,
          text: check.text,
        }),
    );
    if (found.ok) {
      return {
        ids: found.ids,
        kind: 'read',
        source: {kind: 'export', path: check.path},
      };
    }
    fallback = found.reason;
  } else {
    fallback = check.reason;
  }
  const listed = timed(
    timings,
    `reverse links from br list, export not used (${oneLine(fallback)}) ${db}`,
    () =>
      brList(
        {db, env},
        {all: true, labels: [`${CONTINUES_LABEL_PREFIX}${headBeadId}`]},
      ),
  );
  if (listed.kind === 'failed') {
    return {kind: 'failed', reason: describeBrFailed(listed)};
  }
  return {
    ids: listed.issues.map((issue) => issue.id),
    kind: 'read',
    source: {fallback, kind: 'brList'},
  };
}
