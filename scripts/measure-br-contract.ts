#!/usr/bin/env bun
/**
 * measure-br-contract — the br behaviours src/beads/br.ts relies on, measured
 * against ONE br binary (home-base-dj5m9.1.4).
 *
 * br.ts cites each of these as measured on br 0.1.37. Moving the pin to another
 * br is then a diff of two runs of this script, not a re-derivation:
 *
 *   bun run measure:br-contract --br <0.1.37's br> --json > old.json
 *   bun run measure:br-contract --br <0.7.6's br> --json > new.json
 *
 * Each row names the br.ts helper that relies on it. The two older scripts
 * cover the rest: measure-br-export-clobber (a write over a pulled export) and
 * measure-br-import-only (the import runs no git).
 *
 * Everything runs in throwaway workspaces under the OS temp dir (`git init` +
 * `br init`), deleted at the end unless `--keep`. With `--old-br <path>`, one
 * more workspace is made by THAT br and then opened by the measured one: what
 * a newer br does with an older br's database.
 *
 *   bun run measure:br-contract [--br <path>] [--old-br <path>] [--keep] [--json]
 */

import {spawnSync} from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

const HELP = `measure-br-contract — the br behaviours src/beads/br.ts relies on, measured for one br

Usage: bun run measure:br-contract [--br <path>] [--old-br <path>] [--keep] [--json]

  --br <path>      the br binary to measure (default: the one home-base's mise.toml pins,
                   resolved with \`mise which br\` from the repo root)
  --old-br <path>  also make a workspace with this br, then open it with the measured one
  --keep           leave the temp workspaces in place and print their paths
  --json           print the results as JSON

Writes only inside throwaway workspaces under the OS temp dir.`;

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');

interface Args {
  br: string | null;
  json: boolean;
  keep: boolean;
  oldBr: string | null;
}

function parseArgs(argv: string[]): Args | null {
  const args: Args = {br: null, json: false, keep: false, oldBr: null};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--help' || arg === '-h') return null;
    if (arg === '--json') args.json = true;
    else if (arg === '--keep') args.keep = true;
    else if (arg === '--br' && next != null) {
      args.br = next;
      index += 1;
    } else if (arg === '--old-br' && next != null) {
      args.oldBr = next;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg ?? ''}`);
    }
  }
  return args;
}

interface RunResult {
  status: number | null;
  stderr: string;
  stdout: string;
}

function run(command: string, args: string[], cwd: string): RunResult {
  const proc = spawnSync(command, args, {cwd, encoding: 'utf-8'});
  if (proc.error != null) {
    throw new Error(`${command} could not run: ${proc.error.message}`);
  }
  return {
    status: proc.status,
    stderr: (proc.stderr ?? '').trim(),
    stdout: (proc.stdout ?? '').trim(),
  };
}

function must(result: RunResult, what: string): RunResult {
  if (result.status !== 0) {
    throw new Error(
      `${what} exited ${result.status ?? '?'}: ${result.stderr !== '' ? result.stderr : result.stdout}`,
    );
  }
  return result;
}

function pinnedBr(): string {
  const which = run('mise', ['which', 'br'], REPO_ROOT);
  if (which.status !== 0 || which.stdout === '') {
    throw new Error(
      `mise which br (from ${REPO_ROOT}) failed: ${which.stderr !== '' ? which.stderr : `exit ${which.status ?? '?'}`}; pass --br <path>`,
    );
  }
  return which.stdout;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** At most `max` characters of `text`, on one line, quoted. */
function clip(text: string, max = 240): string {
  const flat = text.replace(/\s*\n\s*/g, ' ⏎ ');
  return JSON.stringify(
    flat.length > max ? `${flat.slice(0, max)}…(${flat.length} chars)` : flat,
  );
}

function described(result: RunResult): string {
  return `exit ${result.status ?? 'killed'}; stdout ${clip(result.stdout)}; stderr ${clip(result.stderr)}`;
}

function lastLine(text: string): string {
  return text.split('\n').pop()?.trim() ?? '';
}

/** JSON from the first `{` or `[` on: a mise warning can precede br's output. */
function parseJson(text: string): unknown {
  const starts = [text.indexOf('{'), text.indexOf('[')].filter(
    (index) => index !== -1,
  );
  if (starts.length === 0) return undefined;
  try {
    return JSON.parse(text.slice(Math.min(...starts))) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function shapeOf(value: unknown): string {
  if (value === undefined) return 'not JSON';
  if (Array.isArray(value)) return `array of ${value.length}`;
  if (isRecord(value))
    return `object {${Object.keys(value).sort().join(', ')}}`;
  return typeof value;
}

/** The single record `br show --json` printed (an array of one, or a bare object). */
function shownRecord(value: unknown): Record<string, unknown> | null {
  const record: unknown = Array.isArray(value) ? value[0] : value;
  return isRecord(record) ? record : null;
}

export interface Measurement {
  id: string;
  observed: string;
  /** The br.ts code that depends on the answer. */
  reliedOnBy: string;
}

interface Measurer {
  add: (id: string, reliedOnBy: string, observed: string) => void;
  results: Measurement[];
}

function measurer(): Measurer {
  const results: Measurement[] = [];
  return {
    add: (id, reliedOnBy, observed) => {
      results.push({id, observed, reliedOnBy});
    },
    results,
  };
}

function newWorkspace(
  br: string,
  label: string,
  prefix: string,
  made: string[],
): string {
  const dir = realpathSync(
    mkdtempSync(join(tmpdir(), `br-contract-${label}-`)),
  );
  made.push(dir);
  must(run('git', ['init', '-q'], dir), 'git init');
  must(run(br, ['init', '--prefix', prefix, '-q'], dir), 'br init');
  return dir;
}

/** Every SDK call carries `--no-auto-import`; so does every call here. */
function brIn(br: string, cwd: string, args: string[]): RunResult {
  return run(br, [...args, '--no-auto-import'], cwd);
}

function createBead(
  br: string,
  cwd: string,
  title: string,
  extra: string[] = [],
): string {
  const result = must(
    brIn(br, cwd, ['create', `--title=${title}`, ...extra, '--silent']),
    `br create ${title}`,
  );
  return lastLine(result.stdout);
}

function syncStatus(br: string, cwd: string): string {
  const result = brIn(br, cwd, ['sync', '--status', '--json']);
  const parsed = parseJson(result.stdout);
  if (!isRecord(parsed)) return `not JSON: ${described(result)}`;
  return `jsonl_newer=${String(parsed.jsonl_newer)} db_newer=${String(parsed.db_newer)}`;
}

function showTitle(br: string, cwd: string, id: string): string {
  const result = brIn(br, cwd, ['show', id, '--json']);
  if (result.status !== 0) return `absent (${described(result)})`;
  const record = shownRecord(parseJson(result.stdout));
  return record == null ? 'unparseable' : JSON.stringify(record.title);
}

function mtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** Rewrite one issue's line of the export, as a `git pull` would. */
function rewriteExportLine(
  exportPath: string,
  id: string,
  change: Record<string, unknown>,
  append: Record<string, unknown> | null,
): void {
  const lines = readFileSync(exportPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');
  let original: Record<string, unknown> | null = null;
  const rewritten = lines.map((line) => {
    const record = JSON.parse(line) as Record<string, unknown>;
    if (record.id !== id) return line;
    original = record;
    return JSON.stringify({...record, ...change});
  });
  if (original == null) throw new Error(`${id} is not in ${exportPath}`);
  if (append != null) {
    rewritten.push(JSON.stringify({...(original as object), ...append}));
  }
  writeFileSync(exportPath, `${rewritten.join('\n')}\n`);
}

function measureShapes(br: string, m: Measurer, made: string[]): void {
  const ws = newWorkspace(br, 'shapes', 'm', made);

  m.add(
    'no-auto-import accepted',
    'spawnBr (every call)',
    described(brIn(br, ws, ['list', '--json', '--limit', '0'])),
  );

  const parentRun = brIn(br, ws, [
    'create',
    '--title=Parent',
    '--type=epic',
    '--silent',
  ]);
  m.add(
    'create --silent prints only the id',
    'brCreate',
    `exit ${parentRun.status ?? 'killed'}; stdout ${clip(parentRun.stdout)}`,
  );
  const parent = lastLine(parentRun.stdout);
  const child = createBead(br, ws, 'Child', [`--parent=${parent}`]);
  const grandchild = createBead(br, ws, 'Grandchild', [`--parent=${child}`]);

  const list = brIn(br, ws, ['list', '--json', '--limit', '0']);
  const listed = parseJson(list.stdout);
  const issues = isRecord(listed) ? listed.issues : undefined;
  const first: unknown = Array.isArray(issues) ? issues[0] : undefined;
  m.add(
    'list --json shape',
    'brList',
    `exit ${list.status ?? 'killed'}; top level ${shapeOf(listed)}; issues ${shapeOf(issues)}; an issue ${shapeOf(first)}`,
  );

  const show = brIn(br, ws, ['show', parent, '--json']);
  const shown = parseJson(show.stdout);
  const record = shownRecord(shown);
  m.add(
    'show --json shape',
    'brShow / parseIssue',
    `exit ${show.status ?? 'killed'}; top level ${shapeOf(shown)}; record ${shapeOf(record)}`,
  );
  m.add(
    'labels key when a bead has none',
    'parseIssue',
    record == null
      ? 'no record'
      : 'labels' in record
        ? `present: ${JSON.stringify(record.labels)}`
        : 'omitted',
  );
  const dependents = record?.dependents;
  m.add(
    'dependents of a parent',
    'brChildren',
    Array.isArray(dependents)
      ? dependents
          .map((entry) =>
            isRecord(entry)
              ? `{${Object.keys(entry).sort().join(', ')}} dependency_type=${JSON.stringify(entry.dependency_type)}`
              : JSON.stringify(entry),
          )
          .join(' ; ')
      : `not a list: ${JSON.stringify(dependents)}`,
  );

  must(
    brIn(br, ws, ['update', parent, '--add-label=req']),
    'br update --add-label',
  );
  const labelled = shownRecord(
    parseJson(brIn(br, ws, ['show', parent, '--json']).stdout),
  );
  m.add(
    'labels key when a bead has one',
    'parseIssue',
    labelled == null ? 'no record' : JSON.stringify(labelled.labels),
  );

  m.add(
    'show <missing> --json',
    'isNotFound / brJsonError',
    described(brIn(br, ws, ['show', 'm-nope', '--json'])),
  );
  m.add(
    'show <missing> (text)',
    'isNotFound',
    described(brIn(br, ws, ['show', 'm-nope'])),
  );

  m.add(
    'create with a title that starts with a dash, positional',
    'brCreate (--flag=value)',
    described(brIn(br, ws, ['create', '-x fix', '--silent'])),
  );
  m.add(
    'create --title=-x fix',
    'brCreate (--flag=value)',
    described(brIn(br, ws, ['create', '--title=-x fix', '--silent'])),
  );

  m.add(
    'close a parent with an open child, one id',
    'brClose',
    described(brIn(br, ws, ['close', child, '--reason=measure'])),
  );
  // br.ts: moving a bead straight to one of its own ANCESTORS (its
  // grandparent here) was refused as a cycle; remove the parent first.
  m.add(
    'update --parent= to its own grandparent',
    'BrUpdateInput.parent',
    described(brIn(br, ws, ['update', grandchild, `--parent=${parent}`])),
  );
  const removed = brIn(br, ws, ['update', grandchild, '--parent=']);
  const childAfter = shownRecord(
    parseJson(brIn(br, ws, ['show', child, '--json']).stdout),
  );
  const childDependents = childAfter?.dependents;
  m.add(
    'update --parent= (empty) removes the parent',
    'BrUpdateInput.parent',
    `${described(removed)}; the old parent's dependents now ${Array.isArray(childDependents) ? childDependents.length : JSON.stringify(childDependents)}`,
  );

  // The old-shape question migration (scripts/migrate-ask-parents.ts) moves a
  // dot-notation child (`<request>.1`) to another parent, then expects a plain
  // close of the request to work.
  const request = createBead(br, ws, 'Request');
  const question = createBead(br, ws, 'Question', [`--parent=${request}`]);
  must(
    brIn(br, ws, ['update', question, '--parent=']),
    'br update --parent= (question)',
  );
  must(
    brIn(br, ws, ['update', question, `--parent=${parent}`]),
    'br update --parent=<other> (question)',
  );
  m.add(
    'close a bead whose open dot-notation child was moved to another parent',
    'migrate-ask-parents (plain close afterwards)',
    `child ${question}; ${described(brIn(br, ws, ['close', request, '--reason=measure']))}`,
  );

  m.add(
    'label add <id> <word>',
    '(no br label helper)',
    described(brIn(br, ws, ['label', 'add', parent, 'request'])),
  );
  m.add(
    'label add <id> <word> <word>',
    '(no br label helper)',
    described(brIn(br, ws, ['label', 'add', parent, 'session', 'request'])),
  );

  const elsewhere = realpathSync(
    mkdtempSync(join(tmpdir(), 'br-contract-elsewhere-')),
  );
  made.push(elsewhere);
  const viaDb = brIn(br, elsewhere, [
    '--db',
    join(ws, '.beads', 'beads.db'),
    'list',
    '--json',
    '--limit',
    '0',
  ]);
  const viaDbIssues = parseJson(viaDb.stdout);
  m.add(
    '--db from an unrelated cwd',
    'callBr {db}',
    `exit ${viaDb.status ?? 'killed'}; issues ${shapeOf(isRecord(viaDbIssues) ? viaDbIssues.issues : undefined)}`,
  );
  const missingDb = join(elsewhere, 'missing.db');
  const viaMissing = brIn(br, elsewhere, ['--db', missingDb, 'list', '--json']);
  m.add(
    '--db naming a missing file in a plain directory',
    'callBr {db} (refuses before spawning)',
    `${described(viaMissing)}; file exists afterwards: ${existsSync(missingDb)}`,
  );
  const missingInBeads = join(ws, '.beads', 'missing.db');
  const viaMissingInBeads = brIn(br, elsewhere, [
    '--db',
    missingInBeads,
    'list',
    '--json',
  ]);
  m.add(
    '--db naming a missing file inside a .beads directory',
    'callBr {db} (refuses before spawning)',
    `${described(viaMissingInBeads)}; file exists afterwards: ${existsSync(missingInBeads)}`,
  );
  rmSync(missingInBeads, {force: true});
  rmSync(`${missingInBeads}-wal`, {force: true});
  rmSync(`${missingInBeads}-shm`, {force: true});

  const beads = join(ws, '.beads');
  const exportPath = join(beads, 'issues.jsonl');
  must(
    brIn(br, ws, ['update', parent, '--title=Parent, again']),
    'br update --title',
  );
  const times = {
    db: mtimeMs(join(beads, 'beads.db')),
    export: mtimeMs(exportPath),
    wal: mtimeMs(join(beads, 'beads.db-wal')),
  };
  const known = Object.entries(times).filter(
    (entry): entry is [string, number] => entry[1] != null,
  );
  const oldest = known.sort((a, b) => a[1] - b[1])[0]?.[0] ?? 'none';
  m.add(
    'file mtimes right after a write',
    'exportAheadOfDb (mtimes are not usable)',
    `oldest: ${oldest}; db ${times.db ?? 'absent'}, wal ${times.wal ?? 'absent'}, export ${times.export ?? 'absent'}`,
  );
  m.add(
    'sync --status --json after normal writes',
    'readSyncFreshness',
    syncStatus(br, ws),
  );
  const later = new Date(Date.now() + 5000);
  utimesSync(exportPath, later, later);
  m.add(
    'sync --status after a bare touch of the export',
    'readSyncFreshness',
    syncStatus(br, ws),
  );
}

function measureFreshInit(br: string, m: Measurer, made: string[]): void {
  const ws = newWorkspace(br, 'fresh', 'f', made);
  const exportPath = join(ws, '.beads', 'issues.jsonl');
  const status = brIn(br, ws, ['sync', '--status', '--json']);
  const parsed = parseJson(status.stdout);
  m.add(
    'sync --status --json right after br init',
    'exportAheadOfDb / exportHoldsNoIssues',
    `${isRecord(parsed) ? `jsonl_newer=${String(parsed.jsonl_newer)} db_newer=${String(parsed.db_newer)}` : described(status)}; export ${existsSync(exportPath) ? `${readFileSync(exportPath, 'utf8').length} bytes` : 'absent'}`,
  );
}

/** Only the export changed since they agreed: what `exportAheadOfDb` imports. */
function measurePulledOnly(br: string, m: Measurer, made: string[]): void {
  const ws = newWorkspace(br, 'pulled', 'p', made);
  const exportPath = join(ws, '.beads', 'issues.jsonl');
  const id = createBead(br, ws, 'Original title');
  sleepSync(1100);
  const now = new Date().toISOString();
  rewriteExportLine(
    exportPath,
    id,
    {title: 'EDITED BY PULL', updated_at: now},
    {created_at: now, id: 'p-pulled', title: 'ADDED BY PULL', updated_at: now},
  );
  const before = syncStatus(br, ws);
  m.add(
    'show --json of an id only the pulled export holds',
    'isNotFound',
    described(brIn(br, ws, ['show', 'p-pulled', '--json'])),
  );
  m.add(
    'show --json of an id nobody holds, while the export is ahead',
    'isNotFound',
    described(brIn(br, ws, ['show', 'p-nope', '--json'])),
  );
  const imported = brIn(br, ws, ['sync', '--import-only']);
  m.add(
    'import when only the export is ahead',
    'exportAheadOfDb (the import)',
    `before: ${before}; import ${described(imported)}; title ${showTitle(br, ws, id)}; pulled bead ${showTitle(br, ws, 'p-pulled')}; after: ${syncStatus(br, ws)}`,
  );
}

/**
 * The export holds a DIFFERENT issue under an id the DB already has (another
 * `created_at`): what two checkouts with their own DBs produce when each
 * makes the same next child id. br 0.7.0 made this an import error.
 */
function measureIdCollision(br: string, m: Measurer, made: string[]): void {
  const ws = newWorkspace(br, 'collision', 'c', made);
  const exportPath = join(ws, '.beads', 'issues.jsonl');
  const id = createBead(br, ws, 'Made here');
  sleepSync(1100);
  const now = new Date().toISOString();
  rewriteExportLine(
    exportPath,
    id,
    {created_at: now, title: 'MADE ELSEWHERE', updated_at: now},
    null,
  );
  const before = syncStatus(br, ws);
  const imported = brIn(br, ws, ['sync', '--import-only']);
  m.add(
    'import when the export holds another issue under a local id',
    'exportAheadOfDb (the import)',
    `before: ${before}; import ${described(imported)}; title now ${showTitle(br, ws, id)}; after: ${syncStatus(br, ws)}`,
  );
}

/**
 * Both sides changed since they agreed: an unexported DB edit
 * (`--no-auto-flush`) and a pulled edit to the same issue, in each order.
 */
function measureBothAhead(br: string, m: Measurer, made: string[]): void {
  for (const order of ['db-then-pull', 'pull-then-db'] as const) {
    const ws = newWorkspace(br, `both-${order}`, 'b', made);
    const exportPath = join(ws, '.beads', 'issues.jsonl');
    const id = createBead(br, ws, 'Original title');
    sleepSync(1100);
    const localEdit = (): void => {
      must(
        brIn(br, ws, [
          'update',
          id,
          '--title=EDITED IN THE DB',
          '--no-auto-flush',
        ]),
        'br update --no-auto-flush',
      );
    };
    const pull = (): void => {
      rewriteExportLine(
        exportPath,
        id,
        {title: 'EDITED BY PULL', updated_at: new Date().toISOString()},
        null,
      );
    };
    if (order === 'db-then-pull') {
      localEdit();
      sleepSync(1100);
      pull();
    } else {
      pull();
      sleepSync(1100);
      localEdit();
    }
    const before = syncStatus(br, ws);
    const imported = brIn(br, ws, ['sync', '--import-only']);
    m.add(
      `import when both changed (${order === 'db-then-pull' ? 'the pull is newer' : 'the DB edit is newer'})`,
      'exportAheadOfDb (both-ahead refusal)',
      `before: ${before}; import ${described(imported)}; title now ${showTitle(br, ws, id)}; after: ${syncStatus(br, ws)}`,
    );
  }
}

/** A workspace an OLDER br made, opened by the measured one. */
function measureOldDb(
  br: string,
  oldBr: string,
  m: Measurer,
  made: string[],
): void {
  const ws = newWorkspace(oldBr, 'old-db', 'o', made);
  createBead(oldBr, ws, 'Made by the older br');
  const wal = join(ws, '.beads', 'beads.db-wal');
  const walBytes = existsSync(wal) ? statSync(wal).size : null;
  const oldVersion = run(oldBr, ['--version'], ws).stdout;
  m.add(
    `list --json on a ${oldVersion} DB (WAL ${walBytes == null ? 'absent' : `${walBytes} bytes`})`,
    'callBr / failedFrom',
    described(brIn(br, ws, ['list', '--json', '--limit', '0'])),
  );
  m.add(
    `sync --import-only on a ${oldVersion} DB`,
    'exportAheadOfDb (the import)',
    described(brIn(br, ws, ['sync', '--import-only'])),
  );
}

function main(): number {
  let args: Args | null;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(HELP);
    return 2;
  }
  if (args == null) {
    console.log(HELP);
    return 0;
  }
  const br = args.br ?? pinnedBr();
  const version = run(br, ['--version'], tmpdir()).stdout;
  const m = measurer();
  const made: string[] = [];
  try {
    measureShapes(br, m, made);
    measureFreshInit(br, m, made);
    measurePulledOnly(br, m, made);
    measureIdCollision(br, m, made);
    measureBothAhead(br, m, made);
    if (args.oldBr != null) measureOldDb(br, args.oldBr, m, made);
  } finally {
    if (!args.keep) {
      for (const dir of made) rmSync(dir, {force: true, recursive: true});
    }
  }
  if (args.json) {
    console.log(
      JSON.stringify(
        {br, results: m.results, version, workspaces: args.keep ? made : []},
        null,
        2,
      ),
    );
    return 0;
  }
  console.log(`br: ${br} (${version})`);
  for (const result of m.results) {
    console.log('');
    console.log(`  ${result.id}`);
    console.log(`    relied on by:  ${result.reliedOnBy}`);
    console.log(`    observed:      ${result.observed}`);
  }
  if (args.keep) {
    console.log('');
    console.log('  workspaces:');
    for (const dir of made) console.log(`    ${dir}`);
  }
  return 0;
}

process.exit(main());
