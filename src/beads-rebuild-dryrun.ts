/**
 * beads-rebuild-dryrun — pre-flight for migrating a beads workspace by DELETING `.beads/beads.db` and rebuilding it from `.beads/issues.jsonl`.
 *
 * WHAT IT DOES. It performs the whole destructive procedure on a throwaway COPY of `.beads/`, then diffs the rebuilt database against the original. The output is the exact, per-repo list of what that procedure would lose — measured, not predicted.
 *
 * WHY A DRY RUN RATHER THAN A CHECK. Nothing shipped with br 0.1.37 can answer "does the JSONL cover the DB?", and every candidate fails in the reassuring direction:
 *   - `br sync --status`              reports "In sync" from bookkeeping alone (dirty flags + a stored JSONL hash); when the bookkeeping is wrong, it lies.
 *   - `br doctor` / `sync.metadata`   is that same bookkeeping — the known false all-clear (home-base-bob8).
 *   - `br doctor` / `counts.db_vs_jsonl` compares only COUNTS, so equal-count / divergent-ID drift passes clean.
 *   - br 0.4.1's richer checks        cannot open a schema-4 database at all, so they are unavailable before the migration they would guard.
 * Modelling the exporter's rules instead just moves the guesswork into this script — an earlier static design was abandoned after it produced 1936 false positives on clean real state. Running the real thing on a copy removes the guesswork.
 *
 * DIRECTIONALITY. Content in the DB but not in the JSONL is DESTROYED by the rebuild (fatal). Content in the JSONL but not in the DB is RESTORED by it (informational).
 *
 * RULE 6. If the check cannot be performed it returns `cannotCheck` (2) and says so. It never reports "clean" because it failed to look. "No losses" here always means "compared, and found none". Every escape from this module runs through `cannotCheck()` or the catch-all in `runBeadsRebuildDryRun` — a `br` that cannot be spawned must never fall through to the exit-1 "content would be lost" verdict.
 *
 * SAFETY. The live `.beads/` is only ever READ. Every write happens inside a temp directory that is removed on the way out. The WAL and shared-memory files are copied along with the database, so committed-but-uncheckpointed transactions are included rather than silently ignored.
 */

import {Database} from 'bun:sqlite';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'fs';
import {tmpdir} from 'os';
import {join, resolve} from 'path';

/**
 * The load-bearing contract. `cannotCheck` exists so that "I measured, and there is loss" and "I could not measure" can never be confused for one another (critical rule 6).
 */
export const BEADS_REBUILD_DRYRUN_EXIT = {
  safe: 0,
  wouldLoseContent: 1,
  cannotCheck: 2,
} as const;

export interface BeadsRebuildDryRunOptions {
  /** The workspace to check. Default `.beads`, resolved against the cwd. */
  beadsDir?: string;
  /** The `br` to rebuild WITH — i.e. the one that will perform the real migration. Default `br` from PATH. */
  brBin?: string;
  /** Leave the temp working copy behind for inspection. The path is printed. */
  keep?: boolean;
  /**
   * TEST SEAM. Run after the working copy is staged and before the rebuild, so a test can inject an UNFORESEEN throw — one that is not a `cannotCheck` — and prove the catch-all in `runBeadsRebuildDryRun` turns it into exit 2. Without a seam that behavior is only ever provable by hand-editing the source, which protects nothing. Never set outside tests.
   */
  onStagedForTest?: () => void;
}

/** Files copied out of the live workspace. The WAL and -shm come too: a committed transaction can live entirely in the WAL, and copying the main file alone would silently drop it from BOTH sides of the comparison. */
const STAGED_FILES = [
  'beads.db',
  'beads.db-wal',
  'beads.db-shm',
  'issues.jsonl',
  'config.yaml',
  'metadata.json',
] as const;

const DB_SUFFIXES = ['', '-wal', '-shm'] as const;

/** Derived or surrogate values that differ between the two databases for reasons that are not data loss. Each was verified empirically before being listed here. */
const NOT_COMPARED = new Set([
  // Recomputed from the issue's content. The hash algorithm changed between schema 4 and schema 17, so it differs after ANY migration path, including an in-place one.
  'content_hash',
]);

/**
 * The tables this tool compares ROW BY ROW. Everything else in the database is compared by ROW COUNT ONLY, which cannot see equal-count/different-rows drift — the very weakness this tool's header criticises `br doctor` for.
 *
 * That trade-off is deliberate (see `report`): the remaining tables are derived caches (`blocked_issues_cache`, `dirty_issues`, `export_hashes`, `child_counters`), sync bookkeeping (`metadata`, `config`) and an append-only audit trail (`events`) — all of which the rebuild legitimately regenerates from scratch, so a row-level diff of them is pure noise that would train the reader to skip the report. What is NOT acceptable is letting a count-only comparison pass for a full one, so the report NAMES the count-only tables on every run, including the all-clear. A content table that this list does not know about therefore shows up by name rather than being silently waved through (critical rule 6 — silence must be a claim).
 */
const ROW_COMPARED_TABLES = [
  'issues',
  'comments',
  'dependencies',
  'labels',
] as const;

/** How many FATAL / INFO lines to print before eliding the rest. */
const REPORT_CAP = 40;

type Row = Record<string, unknown>;

type CannotCheckError = Error & {beadsRebuildDryRunCannotCheck: true};

/**
 * Abandon the check. Throws rather than exiting so the temp directory still gets cleaned up and so tests can drive the whole module in-process; `runBeadsRebuildDryRun` turns it back into exit code 2.
 */
function cannotCheck(message: string): never {
  const error = new Error(message) as CannotCheckError;
  error.beadsRebuildDryRunCannotCheck = true;
  throw error;
}

function isCannotCheck(value: unknown): value is CannotCheckError {
  return (
    value instanceof Error &&
    (value as Partial<CannotCheckError>).beadsRebuildDryRunCannotCheck === true
  );
}

/** Copy the live workspace into `work`, and a pristine second copy of the database aside as the "before" side of the diff. */
function stage(beadsDir: string, work: string, originalDb: string): void {
  try {
    mkdirSync(work, {recursive: true});
    for (const file of STAGED_FILES) {
      if (existsSync(join(beadsDir, file))) {
        copyFileSync(join(beadsDir, file), join(work, file));
      }
    }
    copyFileSync(join(work, 'beads.db'), originalDb);
    for (const suffix of ['-wal', '-shm'] as const) {
      if (existsSync(join(work, `beads.db${suffix}`))) {
        copyFileSync(join(work, `beads.db${suffix}`), `${originalDb}${suffix}`);
      }
    }
  } catch (error) {
    cannotCheck(`could not stage a copy of ${beadsDir}: ${String(error)}`);
  }
}

function hashFile(path: string): string {
  return Bun.hash(readFileSync(path)).toString();
}

/**
 * Delete the database and rebuild it from the JSONL — the real procedure, on the copy. Returns whatever `br` printed, for the report.
 */
function rebuild(brBin: string, scratch: string, work: string): string {
  for (const suffix of DB_SUFFIXES) {
    rmSync(join(work, `beads.db${suffix}`), {force: true});
  }

  let proc: ReturnType<typeof Bun.spawnSync>;
  try {
    proc = Bun.spawnSync([brBin, 'sync', '--import-only'], {
      cwd: scratch,
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (error) {
    cannotCheck(`could not run \`${brBin}\`: ${String(error)}`);
  }

  // `?? ''` is not a swallowed failure: with `stdout`/`stderr` set to 'pipe' these are always present at runtime, the nullability is only in the generic signature, and this string is the report of what `br` PRINTED — never the measurement. The verdict rides on the exit code and the database below.
  const output =
    `${proc.stdout?.toString() ?? ''}${proc.stderr?.toString() ?? ''}`.trim();
  if (proc.exitCode !== 0) {
    cannotCheck(
      `\`${brBin} sync --import-only\` exited ${proc.exitCode}:\n${output}`,
    );
  }
  if (!existsSync(join(work, 'beads.db'))) {
    cannotCheck(
      `\`${brBin} sync --import-only\` reported success but produced no database:\n${output}`,
    );
  }
  return output;
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/;

/**
 * Collapse the representational differences between the two schemas — boolean and numeric spellings, and timestamp punctuation/precision — so that only genuine content differences survive the comparison.
 *
 * DECISION (home-base-97lo): `''` and `NULL` are kept DISTINCT here. They were previously both folded to `null`, which meant a field that is empty-string now and NULL after the rebuild compared EQUAL and was never reported — a tool whose entire job is not conflating states, conflating two states, and against the standing rule that `null` means absent while `''` is a different thing.
 *
 * The alternative — treating the change as loss — was rejected: an `''`↔`NULL` swap is a schema-spelling change, not content going missing, and reporting it as FATAL would block migrations that lose nothing (the false-positive failure that killed this tool's earlier static design). So `compare` gives it its own verdict: reported as a NOTE, never conflated, never fatal. Distinguished AND correctly classified, rather than distinguished OR quiet.
 */
function norm(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (value === '') return '';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') return String(value);
  const text = String(value);
  if (!TIMESTAMP.test(text)) return text;
  let stamp = text.replace(' ', 'T').replace('+00:00', 'Z');
  if (!stamp.endsWith('Z')) stamp += 'Z';
  const body = stamp.slice(0, -1);
  const dot = body.indexOf('.');
  if (dot === -1) return `${body}.0Z`;
  const frac = body.slice(dot + 1).replace(/0+$/, '');
  return `${body.slice(0, dot)}.${frac === '' ? '0' : frac}Z`;
}

/** Absent OR empty — the two states `norm` deliberately no longer conflates, grouped where "there is nothing here" is the question being asked. */
function isEmpty(value: string | null): boolean {
  return value === null || value === '';
}

/** Print an empty state as the state it actually is, so a NOTE about the pair is readable. */
function renderEmpty(value: string | null): string {
  return value === null ? 'NULL' : '""';
}

interface Side {
  cols: string[];
  issues: Map<string, Row>;
  comments: Map<string, Set<string>>;
  deps: Map<string, Set<string>>;
  labels: Map<string, Set<string>>;
  tables: Map<string, number>;
}

function openDatabase(path: string, label: string): Database {
  try {
    return new Database(path, {readonly: true});
  } catch (error) {
    cannotCheck(`could not open the ${label} database: ${String(error)}`);
  }
}

function addTo(
  map: Map<string, Set<string>>,
  key: string,
  value: string,
): void {
  const set = map.get(key) ?? new Set<string>();
  set.add(value);
  map.set(key, set);
}

function read(path: string, label: string): Side {
  const db = openDatabase(path, label);
  try {
    const cols = db
      .query<{name: string}, []>('pragma table_info(issues)')
      .all()
      .map((r) => r.name);
    const issues = new Map<string, Row>();
    for (const r of db.query<Row, []>('select * from issues').all()) {
      issues.set(String(r.id), r);
    }

    const comments = new Map<string, Set<string>>();
    const deps = new Map<string, Set<string>>();
    const labels = new Map<string, Set<string>>();

    // The integer comment id is a local autoincrement surrogate that is renumbered by every migration path, so comments are identified by their content instead.
    for (const r of db
      .query<Row, []>('select issue_id, author, text, created_at from comments')
      .all()) {
      addTo(
        comments,
        String(r.issue_id),
        // The body is NOT run through `norm`: it is free text, and normalising it would rewrite a comment that merely happens to start with something timestamp-shaped. `?? ''` was replaced by an explicit null because a NULL body and an empty body are different comments (critical rule 6).
        JSON.stringify([
          norm(r.author),
          r.text === undefined || r.text === null ? null : String(r.text),
          norm(r.created_at),
        ]),
      );
    }
    for (const r of db
      .query<Row, []>('select issue_id, depends_on_id, type from dependencies')
      .all()) {
      addTo(
        deps,
        String(r.issue_id),
        JSON.stringify([String(r.depends_on_id), String(r.type)]),
      );
    }
    for (const r of db
      .query<Row, []>('select issue_id, label from labels')
      .all()) {
      addTo(labels, String(r.issue_id), String(r.label));
    }

    const tables = new Map<string, number>();
    for (const t of db
      .query<{name: string}, []>(
        "select name from sqlite_master where type='table' and name not like 'sqlite_%'",
      )
      .all()) {
      tables.set(
        t.name,
        db.query<{n: number}, []>(`select count(*) as n from "${t.name}"`).get()
          ?.n ?? 0,
      );
    }
    db.close();
    return {cols, comments, deps, issues, labels, tables};
  } catch (error) {
    cannotCheck(`could not read the ${label} database: ${String(error)}`);
  }
}

interface Comparison {
  /** Content the rebuild would DESTROY. Non-empty means not safe. */
  fatal: string[];
  /** Content the rebuild would restore or add. Informational. */
  restored: string[];
  /** Table-level row-count changes — derived caches and audit trails. */
  notes: string[];
  /** Fields that are empty on BOTH sides but not in the same way (`''` vs `NULL`). Reported so the two states are never conflated; not loss, so never fatal. */
  emptyStates: string[];
  /** Every table present on either side that was compared by ROW COUNT ONLY, named so that the limit of the comparison is stated rather than assumed. */
  countOnlyTables: string[];
}

function compare(
  before: Side,
  after: Side,
  jsonlUnchanged: boolean,
): Comparison {
  const fatal: string[] = [];
  const restored: string[] = [];
  const notes: string[] = [];
  const emptyStates: string[] = [];

  if (!jsonlUnchanged) {
    fatal.push(
      'issues.jsonl was MODIFIED by the rebuild — this procedure is supposed to leave it untouched; investigate before trusting anything below',
    );
  }

  const droppedCols = before.cols.filter(
    (c) => !after.cols.includes(c) && !NOT_COMPARED.has(c),
  );
  for (const c of droppedCols) {
    fatal.push(
      `column issues.${c} exists in the original schema and NOT in the rebuilt one`,
    );
  }

  const dbOnly = [...before.issues.keys()]
    .filter((id) => !after.issues.has(id))
    .sort();
  const newOnly = [...after.issues.keys()]
    .filter((id) => !before.issues.has(id))
    .sort();
  for (const id of dbOnly) {
    fatal.push(
      `issue ${id} is in the current DB and would NOT survive the rebuild`,
    );
  }
  for (const id of newOnly) {
    restored.push(
      `issue ${id} is in the JSONL but not in the current DB — the rebuild would restore it`,
    );
  }

  const compareCols = before.cols.filter(
    (c) => after.cols.includes(c) && !NOT_COMPARED.has(c) && c !== 'id',
  );
  for (const [id, oldRow] of before.issues) {
    const newRow = after.issues.get(id);
    if (!newRow) continue;
    for (const c of compareCols) {
      const a = norm(oldRow[c]);
      const b = norm(newRow[c]);
      if (a === b) continue;
      if (isEmpty(a) && isEmpty(b)) {
        // Both sides are empty, in DIFFERENT ways. No content moves, so this is not loss — but it is a real difference and must not be silently equated (see `norm`).
        emptyStates.push(
          `issue ${id} field ${c}: ${renderEmpty(a)} now, ${renderEmpty(b)} after the rebuild — both empty, but NOT the same state`,
        );
      } else if (isEmpty(a)) {
        restored.push(
          `issue ${id} field ${c}: ${renderEmpty(a)} now, ${JSON.stringify(b)} after the rebuild (gained, not lost)`,
        );
      } else {
        fatal.push(
          `issue ${id} field ${c}: ${JSON.stringify(a)} now, ${JSON.stringify(b)} after the rebuild`,
        );
      }
    }
  }

  for (const kind of ['comments', 'deps', 'labels'] as const) {
    for (const [id, oldSet] of before[kind]) {
      const newSet = after[kind].get(id) ?? new Set<string>();
      for (const item of oldSet) {
        if (!newSet.has(item)) {
          fatal.push(
            `issue ${id}: a ${kind} entry would be LOST — ${item.slice(0, 100)}`,
          );
        }
      }
    }
    for (const [id, newSet] of after[kind]) {
      const oldSet = before[kind].get(id) ?? new Set<string>();
      for (const item of newSet) {
        if (!oldSet.has(item)) {
          restored.push(
            `issue ${id}: a ${kind} entry would be restored from the JSONL`,
          );
        }
      }
    }
  }

  for (const [t, n] of before.tables) {
    const m = after.tables.get(t);
    if (m === undefined) {
      notes.push(`table ${t} (${n} rows) does not exist in the rebuilt schema`);
    } else if (n !== m) {
      notes.push(`table ${t}: ${n} rows now, ${m} after the rebuild`);
    }
  }

  // Named, not counted: a table missing from ROW_COMPARED_TABLES is one this tool never looked inside, and the report has to say so on every run — equal counts are not equal rows.
  const rowCompared = new Set<string>(ROW_COMPARED_TABLES);
  const countOnlyTables = [
    ...new Set([...before.tables.keys(), ...after.tables.keys()]),
  ]
    .filter((t) => !rowCompared.has(t))
    .sort();

  return {countOnlyTables, emptyStates, fatal, notes, restored};
}

function report(args: {
  after: Side;
  beadsDir: string;
  before: Side;
  brBin: string;
  comparison: Comparison;
  importOutput: string;
  jsonlUnchanged: boolean;
}): number {
  const {after, beadsDir, before, brBin, comparison, importOutput} = args;
  const {countOnlyTables, emptyStates, fatal, notes, restored} = comparison;

  console.log(`beads dir     : ${beadsDir}`);
  console.log(`br binary     : ${brBin}`);
  console.log(
    `rebuild output: ${importOutput.replace(/\n/g, '\n                ')}`,
  );
  console.log(
    `issues        : ${before.issues.size} now -> ${after.issues.size} after the rebuild`,
  );
  console.log(
    `issues.jsonl  : ${args.jsonlUnchanged ? 'UNCHANGED by the rebuild' : 'CHANGED — see below'}`,
  );

  // Printed on EVERY run, all-clear included: the verdict below is only as wide as this line says it is, and a reader must never have to assume how far it looked.
  console.log(`compared row-by-row : ${ROW_COMPARED_TABLES.join(', ')}`);
  console.log(
    `compared by COUNT ONLY (equal counts do NOT prove equal rows): ${countOnlyTables.length === 0 ? 'none' : countOnlyTables.join(', ')}`,
  );

  if (emptyStates.length > 0) {
    console.log(
      `\nEMPTY-STATE CHANGES (${emptyStates.length}) — no content moves, but "" and NULL are different states and are not conflated here:`,
    );
    for (const m of emptyStates.slice(0, REPORT_CAP)) {
      console.log(`  NOTE  ${m}`);
    }
    if (emptyStates.length > REPORT_CAP) {
      console.log(`  ... and ${emptyStates.length - REPORT_CAP} more`);
    }
  }

  if (notes.length > 0) {
    console.log(
      '\nTABLE-LEVEL CHANGES (read these — derived caches are fine to lose, audit rows are a judgement call):',
    );
    for (const m of notes) console.log(`  NOTE  ${m}`);
  }
  if (restored.length > 0) {
    console.log(
      `\nGAINED OR RESTORED (${restored.length}) — the rebuild repairs these, it does not lose them:`,
    );
    for (const m of restored.slice(0, REPORT_CAP)) console.log(`  INFO  ${m}`);
    if (restored.length > REPORT_CAP) {
      console.log(`  ... and ${restored.length - REPORT_CAP} more`);
    }
  }

  if (fatal.length > 0) {
    console.log(`\nWOULD BE LOST (${fatal.length}):`);
    for (const m of fatal.slice(0, REPORT_CAP)) console.log(`  FATAL ${m}`);
    if (fatal.length > REPORT_CAP) {
      console.log(`  ... and ${fatal.length - REPORT_CAP} more`);
    }
    console.log('\nNOT SAFE to delete beads.db in this repo.');
    console.log(
      'Recover first: `br sync --flush-only` to push the DB-only content into the JSONL, commit it,',
    );
    console.log(
      'then re-run this dry run. Do NOT use `br sync --import-only --force` — on br 0.1.37 that',
    );
    console.log(
      'silently HARD-DELETES database rows the JSONL lacks, which is exactly the content at risk here.',
    );
    return BEADS_REBUILD_DRYRUN_EXIT.wouldLoseContent;
  }

  console.log(
    '\nCOMPARED the rebuilt database against the current one: no issue, field, comment,',
  );
  console.log(
    'dependency or label would be lost. Safe to delete beads.db and rebuild from the JSONL.',
  );
  console.log(
    'This all-clear covers the row-by-row tables named above; the count-only tables were',
  );
  console.log('checked for a change in size only.');
  return BEADS_REBUILD_DRYRUN_EXIT.safe;
}

/**
 * Rebuild a COPY of the workspace and report what the real rebuild would lose.
 *
 * Returns a `BEADS_REBUILD_DRYRUN_EXIT` code. Everything that is not a completed comparison — a missing file, an unspawnable `br`, an unreadable database, an unforeseen throw — returns `cannotCheck`, never `safe` and never `wouldLoseContent`.
 */
export function runBeadsRebuildDryRun(
  options: BeadsRebuildDryRunOptions = {},
): number {
  const beadsDir = resolve(options.beadsDir ?? '.beads');
  const brBin = options.brBin ?? 'br';
  const keep = options.keep ?? false;
  let scratch: string | null = null;

  try {
    const liveDb = join(beadsDir, 'beads.db');
    const liveJsonl = join(beadsDir, 'issues.jsonl');
    if (!existsSync(liveDb)) cannotCheck(`no database at ${liveDb}`);
    if (!existsSync(liveJsonl)) cannotCheck(`no JSONL at ${liveJsonl}`);

    scratch = mkdtempSync(join(tmpdir(), 'beads-dryrun-'));
    const work = join(scratch, '.beads');
    const originalDb = join(scratch, 'original.db');

    stage(beadsDir, work, originalDb);
    options.onStagedForTest?.();

    const jsonlBefore = hashFile(join(work, 'issues.jsonl'));
    const importOutput = rebuild(brBin, scratch, work);
    const jsonlAfter = hashFile(join(work, 'issues.jsonl'));

    const before = read(originalDb, 'original');
    const after = read(join(work, 'beads.db'), 'rebuilt');
    const jsonlUnchanged = jsonlBefore === jsonlAfter;

    return report({
      after,
      beadsDir,
      before,
      brBin,
      comparison: compare(before, after, jsonlUnchanged),
      importOutput,
      jsonlUnchanged,
    });
  } catch (error) {
    // Deliberate abandonment AND anything unforeseen land here together, on purpose: a check that fell over is exit 2 either way, and the alternative — an uncaught throw — surfaces as exit 1, which is this tool's word for "I measured, and there is loss".
    const message = isCannotCheck(error)
      ? error.message
      : `unexpected failure: ${String(error)}`;
    console.error(`\nbeads-rebuild-dryrun: CHECK COULD NOT RUN — ${message}`);
    console.error('This is NOT an all-clear. Do not delete beads.db.');
    return BEADS_REBUILD_DRYRUN_EXIT.cannotCheck;
  } finally {
    if (scratch != null && keep) {
      // A working copy nobody can find is not kept, it is leaked. Printed on every outcome, including the failures, because a failed run is exactly when someone wants to open it.
      console.log(`\nkept the working copy at ${scratch}`);
    }
    if (scratch != null && !keep) {
      try {
        rmSync(scratch, {recursive: true, force: true});
      } catch (error) {
        // A leftover temp directory is not a failed measurement, so it must not change the verdict — but it must not be silent either.
        console.error(
          `beads-rebuild-dryrun: could not remove ${scratch}: ${String(error)}`,
        );
      }
    }
  }
}
