/**
 * The status line's file (status-file.ts, home-base-yukaf.6): its shape, the
 * atomic write, and a read that keeps absent, unreadable and read apart
 * (rule 7). End-to-end writes by the capture child and by done/archive are in
 * thread-session-beads.test.ts.
 */
import type {ThreadStatusFile} from '../src/thread/status-file';

import {afterEach, describe, expect, test} from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {threadsStateDir} from '../src/thread/paths';
import {statusAfterClose} from '../src/thread/session-status-file';
import {
  parseStatusFile,
  readStatusFile,
  resolveThreadsStateDir,
  statusFilePath,
  writeStatusFile,
} from '../src/thread/status-file';

const SESSION = '5e551011-aaaa-4bbb-8ccc-0123456789ab';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, {force: true, recursive: true});
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'thread-status-file-'));
  dirs.push(dir);
  return dir;
}

const STATUS: ThreadStatusFile = {
  archived: false,
  at: '2026-10-18T09:00:00.000Z',
  closedRequests: 3,
  done: false,
  openP0: 0,
  openRequests: 2,
  section: 'stoppedOpen',
  statusWord: 'openWork',
};

describe('status-file.ts', () => {
  test('write then read round-trips the documented shape, and no temp file remains', () => {
    const dir = scratch();
    const write = writeStatusFile(dir, SESSION, STATUS);
    expect(write).toEqual({
      kind: 'written',
      path: join(dir, 'status', `${SESSION}.json`),
    });
    expect(readdirSync(join(dir, 'status'))).toEqual([`${SESSION}.json`]);
    expect(
      Object.keys(
        JSON.parse(
          readFileSync(statusFilePath(dir, SESSION), 'utf8'),
        ) as object,
      ).sort(),
    ).toEqual([
      'archived',
      'at',
      'closedRequests',
      'done',
      'openP0',
      'openRequests',
      'section',
      'statusWord',
    ]);
    expect(readStatusFile(dir, SESSION)).toEqual({
      kind: 'read',
      path: statusFilePath(dir, SESSION),
      status: STATUS,
    });
  });

  test('a rewrite replaces the file in place', () => {
    const dir = scratch();
    writeStatusFile(dir, SESSION, STATUS);
    writeStatusFile(dir, SESSION, {...STATUS, archived: true});
    expect(readdirSync(join(dir, 'status'))).toEqual([`${SESSION}.json`]);
    const read = readStatusFile(dir, SESSION);
    expect(read.kind === 'read' && read.status.archived).toBe(true);
  });

  test('no file is absent; a bad file, a directory and a bad session id are unreadable', () => {
    const dir = scratch();
    expect(readStatusFile(dir, SESSION).kind).toBe('absent');

    mkdirSync(join(dir, 'status'), {recursive: true});
    writeFileSync(statusFilePath(dir, SESSION), '{not json');
    expect(readStatusFile(dir, SESSION)).toMatchObject({kind: 'unreadable'});

    const other = '0babe000-1111-4222-8333-444455556666';
    mkdirSync(statusFilePath(dir, other));
    expect(readStatusFile(dir, other)).toMatchObject({kind: 'unreadable'});

    expect(readStatusFile(dir, '../escape')).toMatchObject({
      error: 'not a session id',
      kind: 'unreadable',
    });
  });

  test('a failed write says why, leaves no temp file and never throws', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'status'), 'a file where the directory goes');
    const write = writeStatusFile(dir, SESSION, STATUS);
    expect(write.kind).toBe('failed');
    expect(readdirSync(dir)).toEqual(['status']);
    expect(writeStatusFile(dir, '../escape', STATUS).kind).toBe('failed');
  });

  test.each([
    ['a missing field', {...STATUS, section: undefined}],
    ['a negative count', {...STATUS, openP0: -1}],
    ['a fractional count', {...STATUS, openRequests: 1.5}],
    ['a string boolean', {...STATUS, archived: 'false'}],
    ['an `at` that is not a date', {...STATUS, at: 'yesterday'}],
  ])('parse refuses %s', (_name, value) => {
    expect(parseStatusFile(JSON.stringify(value)).ok).toBe(false);
  });

  test('the status line resolves the same state dir as paths.ts, with and without the override', () => {
    for (const env of [{}, {JUSTIN_THREADS_STATE_DIR: '/x/y'}]) {
      expect(resolveThreadsStateDir(env)).toBe(threadsStateDir(env));
    }
  });
});

describe('statusAfterClose', () => {
  const located = (id: string, status: string, priority: number | null = 2) =>
    ({db: '/db', issue: {id, priority, status}}) as never;

  test('counts what was closed, leaves out released requests and the session bead', () => {
    const status = statusAfterClose({
      closedIds: new Set(['s.1', 's.3']),
      mode: 'archive',
      now: new Date('2026-10-18T10:00:00.000Z'),
      questions: [located('s.3', 'open', 0), located('s.4', 'open', 0)],
      releasedIds: new Set(['e.9']),
      requests: [
        located('s', 'open'),
        located('s.1', 'in_progress'),
        located('s.2', 'closed'),
        located('e.9', 'open'),
        located('s.5', 'open'),
      ],
      sessionBeadId: 's',
    });
    expect(status).toEqual({
      archived: true,
      at: '2026-10-18T10:00:00.000Z',
      closedRequests: 2,
      done: false,
      openP0: 1,
      openRequests: 1,
      section: 'archived',
      statusWord: 'done',
    });
  });
});
