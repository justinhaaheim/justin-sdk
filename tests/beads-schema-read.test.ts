/**
 * The br schema guard reads `PRAGMA user_version` in-process, through a
 * read-only bun:sqlite connection (home-base-ejsq2.3 part A). It replaced a
 * `sqlite3 -readonly` child, so every case that child told apart is a test
 * here, and each healthy and failed case is compared with what the child says
 * (`cliReference`, the old reader's rules, kept in this test only).
 *
 * The locked case is in beads-locked.test.ts, against real locks.
 *
 * NEGATIVE CONTROLS (run by hand, recorded on home-base-ejsq2.3): make
 * `readDbSchemaOnce`'s catch return `{kind: 'read', schema: 0}` and every
 * failure test here fails; drop its `schema < 0` check and the negative
 * version test fails.
 */
import {Database} from 'bun:sqlite';
import {afterEach, describe, expect, test} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {readDbSchema} from '../src/beads/br';

const dirs: string[] = [];
const open: Database[] = [];

afterEach(() => {
  for (const handle of open.splice(0)) handle.close();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, {force: true, recursive: true});
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'beads-schema-read-'));
  dirs.push(dir);
  return dir;
}

const ONCE = {budgetMs: 0, waitMs: 50} as const;

type Kind = 'failed' | 'locked' | 'read';

/**
 * What the reader before 2026-11-14 answered: `sqlite3 -readonly`, digits on
 * stdout and exit 0 or it is not a schema.
 */
function cliReference(db: string): {kind: Kind; schema?: number} {
  const proc = spawnSync(
    'sqlite3',
    ['-readonly', '-cmd', '.timeout 50', db, 'PRAGMA user_version'],
    {encoding: 'utf-8'},
  );
  if (proc.error != null) throw proc.error;
  const out = (proc.stdout ?? '').trim();
  if (proc.status !== 0 || !/^\d+$/.test(out)) {
    return {
      kind: /database is (?:locked|busy)/i.test(proc.stderr ?? '')
        ? 'locked'
        : 'failed',
    };
  }
  return {kind: 'read', schema: Number(out)};
}

function sqlite(db: string, sql: string): void {
  const made = spawnSync('sqlite3', [db, sql], {encoding: 'utf-8'});
  if (made.status !== 0) throw new Error(`sqlite3: ${made.stderr}`);
}

function hashOf(path: string): string {
  return existsSync(path)
    ? createHash('sha256').update(readFileSync(path)).digest('hex')
    : 'absent';
}

/** A copy of a database's files, -wal and -shm included. */
function copyDb(source: string): string {
  const copy = join(tempDir(), 'beads.db');
  for (const suffix of ['', '-wal', '-shm']) {
    copyFileSync(`${source}${suffix}`, `${copy}${suffix}`);
  }
  return copy;
}

/** A WAL database whose user_version is only in the -wal: copied while open. */
function walOnlyCopy(): {db: string; writer: Database} {
  const source = join(tempDir(), 'live.db');
  const writer = new Database(source, {create: true});
  open.push(writer);
  writer.run('PRAGMA journal_mode = WAL');
  writer.run('PRAGMA wal_autocheckpoint = 0');
  writer.run('CREATE TABLE t(x)');
  writer.run('PRAGMA user_version = 11');
  writer.run("INSERT INTO t VALUES ('in the wal')");
  return {db: copyDb(source), writer};
}

function filesOf(db: string): string[] {
  return ['', '-wal', '-shm'].map((suffix) => hashOf(`${db}${suffix}`));
}

function expectFailed(db: string): void {
  const read = readDbSchema(db, ONCE);
  expect(read.kind).toBe('failed');
  if (read.kind === 'failed') expect(read.reason).toContain(db);
  expect(cliReference(db).kind).toBe('failed');
}

describe('readDbSchema reads in-process, case by case against sqlite3 -readonly', () => {
  test('a rollback-journal database: its version', () => {
    const db = join(tempDir(), 'beads.db');
    sqlite(db, 'CREATE TABLE t(x); PRAGMA user_version = 7;');
    expect(readDbSchema(db, ONCE)).toEqual({kind: 'read', schema: 7});
    expect(cliReference(db)).toEqual({kind: 'read', schema: 7});
  });

  test('a WAL database whose version is only in the -wal: read from the -wal, and its files end as the child leaves them', () => {
    const {db} = walOnlyCopy();
    const twin = copyDb(db);
    const before = filesOf(db);
    expect(filesOf(twin)).toEqual(before);
    expect(readDbSchema(db, ONCE)).toEqual({kind: 'read', schema: 11});
    expect(cliReference(twin)).toEqual({kind: 'read', schema: 11});
    // The DB and -wal bytes are untouched; the -shm (copied from a live
    // connection) is rewritten by both readers alike.
    expect(filesOf(db).slice(0, 2)).toEqual(before.slice(0, 2));
    expect(filesOf(db)).toEqual(filesOf(twin));
  });

  test('a WAL database another connection in this process holds open: read, and that connection writes on', () => {
    const {writer} = walOnlyCopy();
    const live = writer.filename;
    expect(readDbSchema(live, ONCE)).toEqual({kind: 'read', schema: 11});
    writer.run('PRAGMA user_version = 12');
    writer.run("INSERT INTO t VALUES ('after the read')");
    expect(readDbSchema(live, ONCE)).toEqual({kind: 'read', schema: 12});
    expect(cliReference(live)).toEqual({kind: 'read', schema: 12});
  });

  test('an empty file: version 0, as the child said', () => {
    const db = join(tempDir(), 'beads.db');
    writeFileSync(db, '');
    expect(readDbSchema(db, ONCE)).toEqual({kind: 'read', schema: 0});
    expect(cliReference(db)).toEqual({kind: 'read', schema: 0});
  });

  test('a negative version is failed, never a schema (the child printed digits only)', () => {
    const db = join(tempDir(), 'beads.db');
    sqlite(db, 'CREATE TABLE t(x); PRAGMA user_version = -5;');
    expectFailed(db);
  });

  test('a missing file is failed, and the read does not create it', () => {
    const db = join(tempDir(), 'beads.db');
    expectFailed(db);
    expect(existsSync(db)).toBe(false);
  });

  test('a file that is not a database is failed', () => {
    const db = join(tempDir(), 'beads.db');
    writeFileSync(db, 'this is not a SQLite database, and it is long enough');
    expectFailed(db);
  });

  test('a database cut short is failed (malformed)', () => {
    const source = join(tempDir(), 'whole.db');
    sqlite(
      source,
      'CREATE TABLE t(x); INSERT INTO t VALUES (randomblob(9000)); PRAGMA user_version = 5;',
    );
    const db = join(tempDir(), 'beads.db');
    writeFileSync(db, readFileSync(source).subarray(0, 100));
    expectFailed(db);
  });

  test('a directory is failed', () => {
    const db = join(tempDir(), 'beads.db');
    mkdirSync(db);
    expectFailed(db);
  });

  test.skipIf(process.getuid?.() === 0)(
    'a file this user cannot read is failed',
    () => {
      const db = join(tempDir(), 'beads.db');
      sqlite(db, 'CREATE TABLE t(x); PRAGMA user_version = 3;');
      chmodSync(db, 0o000);
      try {
        expectFailed(db);
      } finally {
        chmodSync(db, 0o644);
      }
    },
  );

  test('a WAL database with neither -wal nor -shm is failed (a read-only open cannot make them)', () => {
    const {db} = walOnlyCopy();
    rmSync(`${db}-wal`);
    rmSync(`${db}-shm`);
    expectFailed(db);
    expect(existsSync(`${db}-wal`)).toBe(false);
  });

  test('a WAL database without its -shm: read, and SQLite makes the -shm, as the child did', () => {
    const {db} = walOnlyCopy();
    rmSync(`${db}-shm`);
    expect(readDbSchema(db, ONCE)).toEqual({kind: 'read', schema: 11});
    expect(existsSync(`${db}-shm`)).toBe(true);
  });

  test('no child runs, so a PATH without sqlite3 changes nothing (the child failed there)', () => {
    const db = join(tempDir(), 'beads.db');
    sqlite(db, 'CREATE TABLE t(x); PRAGMA user_version = 7;');
    const path = process.env.PATH;
    process.env.PATH = '/nowhere';
    try {
      expect(readDbSchema(db, ONCE)).toEqual({kind: 'read', schema: 7});
    } finally {
      process.env.PATH = path;
    }
  });
});
