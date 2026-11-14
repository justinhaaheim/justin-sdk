#!/usr/bin/env bun
/**
 * measure-schema-read — what the br schema guard's read does to a live beads
 * database, in-process against the `sqlite3 -readonly` child it replaced
 * (home-base-ejsq2.3, part A).
 *
 * WHAT. In one scratch git repo under the OS temp dir, with the br you name:
 *   1. br inits the repo and creates beads, so the DB has WAL frames.
 *   2. FILES: for each reader, on a fresh copy of `.beads/` (as br left it;
 *      with the -shm removed; with -wal and -shm removed), the size and hash of
 *      the DB, -wal and -shm before and after one read.
 *   3. A HELD WRITE: sqlite3 holds `BEGIN IMMEDIATE` on the live DB; each
 *      reader reads once, and its answer and time are printed.
 *   4. CONCURRENT WRITES: a shell loop runs `br update` N times on the live DB
 *      while each reader in turn reads as fast as it can, and once with no
 *      reader. Printed: each reader's answers and slowest read, and the
 *      writer's failures and total time.
 * Every bead title carries the test-data marker given by --marker. The scratch
 * repo is removed afterwards unless --keep. Nothing outside it is written.
 *
 *   bun run measure:schema-read --marker <uuid> [--br <path>] [--writes <n>] [--keep]
 */

import {spawn, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {readDbSchema} from '../src/beads/br';

const HELP = `measure-schema-read — the br schema guard's read, in-process against sqlite3 -readonly

Usage: bun run measure:schema-read --marker <uuid> [--br <path>] [--writes <n>] [--pace <ms>] [--keep]

  --marker <uuid>  the session's test-data UUID, put in every bead title
  --br <path>      the br that makes and writes the DB (default: br on PATH)
  --writes <n>     br updates in the concurrent-write round (default 40)
  --pace <ms>      the pause between two reads in that round (default 10)
  --keep           leave the scratch repo in place and print its path

Writes only inside one scratch git repo under the OS temp dir.`;

interface Args {
  br: string;
  keep: boolean;
  marker: string;
  paceMs: number;
  writes: number;
}

function parseArgs(argv: string[]): Args | null {
  let br = 'br';
  let marker: string | null = null;
  let writes = 40;
  let paceMs = 10;
  let keep = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--help' || arg === '-h') return null;
    if (arg === '--keep') keep = true;
    else if (arg === '--br' && next != null) {
      br = next;
      index += 1;
    } else if (arg === '--marker' && next != null) {
      marker = next;
      index += 1;
    } else if (arg === '--writes' && next != null) {
      writes = Number(next);
      index += 1;
    } else if (arg === '--pace' && next != null) {
      paceMs = Number(next);
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg ?? ''}`);
    }
  }
  if (marker == null) throw new Error('--marker <uuid> is required');
  if (!Number.isInteger(writes) || writes < 1) {
    throw new Error('--writes must be a positive whole number');
  }
  if (!Number.isInteger(paceMs) || paceMs < 0) {
    throw new Error('--pace must be a whole number of ms, 0 or more');
  }
  return {br, keep, marker, paceMs, writes};
}

type Reader = 'cli' | 'in-process';

/** The reader the guard used until 2026-11-14, classified the way it was. */
function cliRead(db: string, waitMs: number): string {
  const proc = spawnSync(
    'sqlite3',
    ['-readonly', '-cmd', `.timeout ${waitMs}`, db, 'PRAGMA user_version'],
    {encoding: 'utf-8'},
  );
  const out = (proc.stdout ?? '').trim();
  if (proc.status === 0 && /^\d+$/.test(out)) return `read ${out}`;
  return `failed: ${(proc.stderr ?? '').trim().split('\n')[0] ?? ''}`;
}

function inProcessRead(db: string, waitMs: number): string {
  const read = readDbSchema(db, {budgetMs: 0, waitMs});
  return read.kind === 'read'
    ? `read ${read.schema}`
    : `${read.kind}: ${read.reason}`;
}

function readOnce(reader: Reader, db: string, waitMs: number): string {
  return reader === 'cli' ? cliRead(db, waitMs) : inProcessRead(db, waitMs);
}

function run(command: string, args: string[], cwd: string): string {
  const proc = spawnSync(command, args, {cwd, encoding: 'utf-8'});
  if (proc.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited ${proc.status ?? 'null'}: ${proc.stderr}`,
    );
  }
  return proc.stdout;
}

function fileState(path: string): string {
  if (!existsSync(path)) return 'absent';
  const bytes = readFileSync(path);
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  return `${statSync(path).size} bytes ${hash}`;
}

function dbFiles(db: string): Record<string, string> {
  return {
    db: fileState(db),
    shm: fileState(`${db}-shm`),
    wal: fileState(`${db}-wal`),
  };
}

function copyBeads(from: string, to: string, drop: string[]): string {
  mkdirSync(to, {recursive: true});
  for (const name of readdirSync(from)) {
    if (!name.startsWith('beads.db')) continue;
    if (drop.some((suffix) => name === `beads.db${suffix}`)) continue;
    copyFileSync(join(from, name), join(to, name));
  }
  return join(to, 'beads.db');
}

function measureFiles(root: string, beads: string): void {
  console.log('\nFILES: one read on a fresh copy of .beads/');
  const variants: {drop: string[]; label: string}[] = [
    {drop: [], label: 'as br left it'},
    {drop: ['-shm'], label: 'without -shm'},
    {drop: ['-wal', '-shm'], label: 'without -wal and -shm'},
  ];
  for (const variant of variants) {
    for (const reader of ['cli', 'in-process'] as const) {
      const db = copyBeads(
        beads,
        join(
          root,
          `copy-${reader}-${variant.drop.length > 0 ? variant.drop.join('') : 'all'}`,
        ),
        variant.drop,
      );
      const before = dbFiles(db);
      const answer = readOnce(reader, db, 2000);
      const after = dbFiles(db);
      console.log(`  ${variant.label}, ${reader}: ${answer}`);
      for (const key of ['db', 'wal', 'shm'] as const) {
        const same = before[key] === after[key];
        console.log(
          `    ${key}: ${before[key]} -> ${same ? 'unchanged' : after[key]}`,
        );
      }
    }
  }
}

function timedRead(
  reader: Reader,
  db: string,
  waitMs: number,
): {answer: string; ms: number} {
  const startedAt = performance.now();
  const answer = readOnce(reader, db, waitMs);
  return {answer, ms: performance.now() - startedAt};
}

async function measureHeldWrite(db: string): Promise<void> {
  console.log('\nA HELD WRITE: sqlite3 holds BEGIN IMMEDIATE for 3 s');
  const holder = spawn(
    'sh',
    [
      '-c',
      `(echo '.timeout 5000'; echo 'BEGIN IMMEDIATE;'; sleep 3; echo 'COMMIT;') | sqlite3 '${db}'`,
    ],
    {stdio: 'ignore'},
  );
  await Bun.sleep(500);
  for (const reader of ['cli', 'in-process'] as const) {
    const read = timedRead(reader, db, 2000);
    console.log(`  ${reader}: ${read.answer} in ${read.ms.toFixed(1)} ms`);
  }
  await new Promise((resolveExit) => holder.on('exit', resolveExit));
}

interface ScratchRepo {
  db: string;
  id: string;
  repo: string;
}

/** A fresh git repo with a br database holding five beads. */
function makeRepo(args: Args, repo: string): ScratchRepo {
  mkdirSync(repo, {recursive: true});
  run('git', ['init', '-q'], repo);
  run(args.br, ['init', '--prefix', 'm', '-q'], repo);
  let id = '';
  for (let index = 0; index < 5; index += 1) {
    id = run(
      args.br,
      [
        'create',
        `schema read probe ${index} [TEST_DATA_DELETABLE ${args.marker} ]`,
        '--silent',
      ],
      repo,
    ).trim();
  }
  return {db: join(repo, '.beads', 'beads.db'), id, repo};
}

/**
 * Each reader gets its own fresh repo and the same writes, so the rounds
 * differ only in the reader (a first version shared one repo and its labels,
 * and the failure counts then followed the repo's state, not the reader).
 */
async function measureConcurrentWrites(
  args: Args,
  root: string,
): Promise<void> {
  console.log(
    `\nCONCURRENT WRITES: ${args.writes} br updates while a reader reads, a fresh repo per reader`,
  );
  for (const reader of ['none', 'cli', 'in-process'] as const) {
    const {db, id, repo} = makeRepo(args, join(root, `writes-${reader}`));
    const errors = join(root, `writer-errors-${reader}.txt`);
    const script = `i=0; fails=0; while [ $i -lt ${args.writes} ]; do '${args.br}' update ${id} --notes w$i --no-auto-import --lock-timeout 20000 >/dev/null 2>>'${errors}' || fails=$((fails+1)); i=$((i+1)); done; echo $fails`;
    const startedAt = performance.now();
    const writer = spawn('sh', ['-c', script], {cwd: repo});
    let writerOut = '';
    writer.stdout.on('data', (chunk: Buffer) => {
      writerOut += chunk.toString();
    });
    let done = false;
    const exited = new Promise<void>((resolveExit) => {
      writer.on('exit', () => {
        done = true;
        resolveExit();
      });
    });
    const answers = new Map<string, number>();
    let slowest = 0;
    let reads = 0;
    while (!done) {
      if (reader !== 'none') {
        const read = timedRead(reader, db, 20_000);
        const key = read.answer.startsWith('read ')
          ? read.answer
          : read.answer.slice(0, 80);
        answers.set(key, (answers.get(key) ?? 0) + 1);
        slowest = Math.max(slowest, read.ms);
        reads += 1;
      }
      // The same pace for both readers, so their reads are counted alike.
      await Bun.sleep(args.paceMs);
    }
    await exited;
    const total = performance.now() - startedAt;
    console.log(
      `  reader ${reader}: writer ${(total / 1000).toFixed(2)} s, ${writerOut.trim()} of ${args.writes} writes failed`,
    );
    if (existsSync(errors)) {
      const said = new Map<string, number>();
      for (const line of readFileSync(errors, 'utf-8').split('\n')) {
        if (line.trim() === '') continue;
        const key = line.trim().slice(0, 160);
        said.set(key, (said.get(key) ?? 0) + 1);
      }
      for (const [line, count] of said) {
        console.log(`    br said (${count} x): ${line}`);
      }
    }
    if (reader !== 'none') {
      console.log(
        `    ${reads} reads, slowest ${slowest.toFixed(1)} ms: ${[...answers].map(([answer, count]) => `${count} x ${answer}`).join('; ')}`,
      );
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args == null) {
    console.log(HELP);
    return;
  }
  const root = mkdtempSync(join(tmpdir(), 'measure-schema-read-'));
  try {
    const {db, repo} = makeRepo(args, join(root, 'repo'));
    const beads = join(repo, '.beads');
    console.log(`br: ${run(args.br, ['--version'], repo).trim()}`);
    console.log(`sqlite3: ${run('sqlite3', ['--version'], repo).trim()}`);
    console.log(
      `journal mode: ${run('sqlite3', ['-readonly', db, 'PRAGMA journal_mode'], repo).trim()}`,
    );
    console.log(`live files after br: ${JSON.stringify(dbFiles(db))}`);
    measureFiles(root, beads);
    await measureHeldWrite(db);
    await measureConcurrentWrites(args, root);
  } finally {
    if (args.keep) console.log(`\nkept: ${root}`);
    else rmSync(root, {force: true, recursive: true});
  }
}

await main();
