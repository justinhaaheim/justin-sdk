/**
 * vitals.ts (home-base-sg9q9.7, D3 and D4): the record's format, where it
 * lives, and what a mayor session's report shows for it.
 */
import {afterEach, describe, expect, test} from 'bun:test';
import {mkdtempSync, rmSync, writeFileSync} from 'fs';
import {homedir, tmpdir} from 'os';
import {join} from 'path';

import {
  parseVitalsRecord,
  readVitals,
  type VitalsCheck,
  vitalsNotice,
  type VitalsRecord,
  vitalsReportText,
  vitalsStateDir,
} from '../src/vitals';

const NOW = new Date('2026-11-13T17:57:00.000Z');
const HOUR = 60 * 60 * 1000;
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, {force: true, recursive: true});
});

function stateDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'vitals-sdk-'));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

const OK = (check: string, name: string): VitalsCheck => ({
  check,
  findings: [],
  name,
  status: 'ok',
  summary: 'fine',
});

function record(checks: VitalsCheck[], at: string = ago(HOUR)): VitalsRecord {
  return {at, checks, grades: {cpu: 'ok', memory: null}, version: 1};
}

const DISK_LOW: VitalsCheck = {
  check: 'disk',
  findings: [{key: 'disk:low', level: 'warning', summary: '22.0 GB free'}],
  name: 'disk',
  status: 'warning',
  summary: '22.0 GB free',
};
const JOBS_BROKEN: VitalsCheck = {
  check: 'jobs',
  findings: [{key: 'jobs:x', level: 'error', summary: 'x failing'}],
  name: 'jobs',
  status: 'error',
  summary: 'x failing',
};

function noticeFor(files: Record<string, string>) {
  return vitalsNotice(readVitals({VITALS_STATE_DIR: stateDir(files)}), NOW);
}

describe('where it lives', () => {
  test('VITALS_STATE_DIR, then XDG_STATE_HOME/vitals, then ~/.local/state/vitals', () => {
    expect(vitalsStateDir({VITALS_STATE_DIR: '/v'})).toBe('/v');
    expect(vitalsStateDir({XDG_STATE_HOME: '/s'})).toBe('/s/vitals');
    expect(vitalsStateDir({})).toBe(
      join(homedir(), '.local', 'state', 'vitals'),
    );
  });
});

describe('parseVitalsRecord', () => {
  test('a status that disagrees with its findings does not parse (an ok cannot hide a problem)', () => {
    const hidden = {...DISK_LOW, status: 'ok'};
    const parsed = parseVitalsRecord(record([hidden as VitalsCheck]));
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? '' : parsed.error).toContain('findings say warning');
  });

  test('a well-formed record parses back to itself', () => {
    const r = record([OK('cpu', 'CPU'), DISK_LOW]);
    expect(parseVitalsRecord(JSON.parse(JSON.stringify(r)))).toEqual({
      ok: true,
      record: r,
    });
  });
});

describe('vitalsNotice (D4)', () => {
  test('nothing when every check but jobs is ok: the Jobs line already shows jobs', () => {
    expect(
      noticeFor({
        'latest.json': JSON.stringify(
          record([JOBS_BROKEN, OK('disk', 'disk')]),
        ),
      }),
    ).toBeNull();
  });

  test('each non-ok check other than jobs', () => {
    const notice = noticeFor({
      'latest.json': JSON.stringify(
        record([JOBS_BROKEN, DISK_LOW, OK('cpu', 'CPU')]),
      ),
    });
    expect(notice?.kind).toBe('problems');
    expect(notice == null ? '' : vitalsReportText(notice)).toBe(
      '⚠️ disk: 22.0 GB free',
    );
  });

  test('a latest.json older than 3 hours is itself a problem, not hidden', () => {
    const notice = noticeFor({
      'latest.json': JSON.stringify(
        record([OK('disk', 'disk')], ago(3 * HOUR + 60_000)),
      ),
    });
    expect(notice?.kind).toBe('not-running');
    expect(notice == null ? '' : vitalsReportText(notice)).toBe(
      '⚠️ vitals not running: its latest result is 3 hours old',
    );
  });

  test('unreadable, or no checks at all, is unknown', () => {
    expect(noticeFor({'latest.json': '{nope'})?.kind).toBe('unknown');
    expect(noticeFor({'latest.json': JSON.stringify(record([]))})?.kind).toBe(
      'unknown',
    );
  });

  test('missing latest.json: nothing where vitals never ran, "not running" where runs.jsonl exists', () => {
    expect(noticeFor({})).toBeNull();
    expect(noticeFor({'runs.jsonl': '\n'})?.kind).toBe('not-running');
  });
});
