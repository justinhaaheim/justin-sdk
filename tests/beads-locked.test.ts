/**
 * A locked beads database, with real locks (home-base-p05kz.5.1). A locked
 * schema read is its own result and is tried again; every br call waits for the
 * lock. The thread handoff half is in thread-handoff-cmux-slow.test.ts.
 */
import type {ChildProcess} from 'node:child_process';

import {afterEach, describe, expect, test} from 'bun:test';
import {spawn, spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {
  BR_LOCK_TIMEOUT_MS,
  brCreate,
  brUpdate,
  readDbSchema,
  runBr,
  saysBeadsLocked,
} from '../src/beads/br';
import {needBr} from './pinned-br';

const dirs: string[] = [];
const holders: ChildProcess[] = [];

afterEach(() => {
  for (const holder of holders.splice(0)) holder.kill('SIGKILL');
  for (const dir of dirs.splice(0)) rmSync(dir, {force: true, recursive: true});
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'beads-locked-'));
  dirs.push(dir);
  return dir;
}

/** A rollback-journal database, where BEGIN EXCLUSIVE stops every reader. */
function plainDb(): string {
  const db = join(tempDir(), 'beads.db');
  const made = spawnSync(
    'sqlite3',
    [db, 'CREATE TABLE t(x); PRAGMA user_version = 7;'],
    {encoding: 'utf8'},
  );
  if (made.status !== 0) throw new Error(`sqlite3: ${made.stderr}`);
  return db;
}

/** Runs `statement`, keeps the transaction open for `holdSeconds`, then commits. */
function holdLock(db: string, statement: string, holdSeconds: number): void {
  const holder = spawn(
    'sh',
    [
      '-c',
      // The timeout: a probe holding the lock for a moment must not make this
      // BEGIN fail, or the lock is never held and the test waits for nothing.
      `(echo '.timeout 5000'; echo '${statement}'; sleep ${holdSeconds}; echo 'COMMIT;') | sqlite3 '${db}'`,
    ],
    {stdio: 'ignore'},
  );
  holders.push(holder);
}

function waitUntil(condition: () => boolean, what: string): void {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`never happened: ${what}`);
    Bun.sleepSync(20);
  }
}

const ONCE = {budgetMs: 0, waitMs: 50} as const;

describe('readDbSchema on a locked database', () => {
  test('a held database reads as locked, and as the schema once released', () => {
    const db = plainDb();
    expect(readDbSchema(db, ONCE)).toEqual({kind: 'read', schema: 7});
    holdLock(db, 'BEGIN EXCLUSIVE;', 1);
    waitUntil(() => readDbSchema(db, ONCE).kind === 'locked', 'the lock held');
    const locked = readDbSchema(db, ONCE);
    expect(locked.kind).toBe('locked');
    if (locked.kind === 'locked') {
      expect(saysBeadsLocked(locked.reason)).toBe(true);
    }
    waitUntil(
      () => readDbSchema(db, ONCE).kind === 'read',
      'the lock released',
    );
    expect(readDbSchema(db, ONCE)).toEqual({kind: 'read', schema: 7});
  });

  test('a lock released inside the budget is read, without the caller retrying', () => {
    const db = plainDb();
    holdLock(db, 'BEGIN EXCLUSIVE;', 1);
    waitUntil(() => readDbSchema(db, ONCE).kind === 'locked', 'the lock held');
    // Negative control: with no budget, the same wait reports the lock.
    expect(readDbSchema(db, ONCE).kind).toBe('locked');
    expect(readDbSchema(db, {budgetMs: 5000, pauseMs: 50, waitMs: 50})).toEqual(
      {kind: 'read', schema: 7},
    );
  });

  test('a budget that runs out while held is locked, never a schema', () => {
    const db = plainDb();
    holdLock(db, 'BEGIN EXCLUSIVE;', 3);
    waitUntil(() => readDbSchema(db, ONCE).kind === 'locked', 'the lock held');
    expect(
      readDbSchema(db, {budgetMs: 200, pauseMs: 50, waitMs: 50}).kind,
    ).toBe('locked');
  });

  test('a file that is not a database is failed, and it is not tried again', () => {
    const db = join(tempDir(), 'beads.db');
    writeFileSync(db, 'this is not a SQLite database, and it is long enough');
    const startedAt = Date.now();
    expect(
      readDbSchema(db, {budgetMs: 5000, pauseMs: 50, waitMs: 50}).kind,
    ).toBe('failed');
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });
});

describe('saysBeadsLocked', () => {
  test.each([
    'Error: database is locked',
    'Runtime error near line 1: database is locked (5)',
    'br exited 1: Error: Database error: database is busy',
    'SQLITE_BUSY',
    'br timed out after 60 s',
  ])('a lock: %s', (text) => {
    expect(saysBeadsLocked(text)).toBe(true);
  });

  test.each([
    'database disk image is malformed',
    'no such table: issues',
    'br could not run: spawnSync br ENOENT',
  ])('not a lock: %s', (text) => {
    expect(saysBeadsLocked(text)).toBe(false);
  });
});

describe('every br call waits for the lock', () => {
  test('every call carries the lock timeout', () => {
    const dir = tempDir();
    const log = join(dir, 'args.log');
    const shim = join(dir, 'br');
    writeFileSync(shim, `#!/bin/sh\necho "$*" >> '${log}'\n`, {mode: 0o755});
    const ran = runBr(dir, ['list'], {
      PATH: `${dir}:${process.env.PATH ?? ''}`,
    });
    expect(ran.ok).toBe(true);
    expect(readFileSync(log, 'utf8')).toContain(
      `--lock-timeout ${BR_LOCK_TIMEOUT_MS}`,
    );
  });

  test('a write made while another process holds the lock waits and lands', () => {
    needBr();
    const repo = tempDir();
    const git = spawnSync('git', ['init', '-q'], {cwd: repo});
    expect(git.status).toBe(0);
    expect(runBr(repo, ['init', '--prefix', 't', '-q']).ok).toBe(true);
    const created = brCreate(
      {cwd: repo},
      {title: 'locked write', type: 'task'},
    );
    if (created.kind !== 'ok') throw new Error(created.reason);
    const db = join(repo, '.beads', 'beads.db');
    const held = (): boolean =>
      spawnSync('sqlite3', [db, 'BEGIN IMMEDIATE; ROLLBACK;'], {
        encoding: 'utf8',
      }).status !== 0;

    holdLock(db, 'BEGIN IMMEDIATE;', 2);
    waitUntil(held, 'the write lock held');

    expect(
      brUpdate({cwd: repo}, created.id, {addLabels: ['waited']}).kind,
    ).toBe('ok');
  });
});
