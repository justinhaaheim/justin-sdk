/**
 * The unsent-drafts scan's health verdict (home-base-fmf1n D6), over a
 * temporary threads state dir: the run log, the capture log and the sessions
 * index are all fixtures. All times are UTC.
 */

import type {DraftsScanRun} from '../src/thread/drafts-scan-runs';

import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {appendFileSync, mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';

import {captureRunLogPath} from '../src/thread/archive';
import {draftsScanHealth} from '../src/thread/drafts-scan-health';
import {
  appendDraftsScanRun,
  draftsScanRunsPath,
} from '../src/thread/drafts-scan-runs';
import {appendSessionSighting} from '../src/thread/session-index';

const HOME_SESSION = 'aaaaaaaa-0000-4000-8000-00000000000a';
const OTHER_SESSION = 'aaaaaaaa-0000-4000-8000-00000000000b';

let dir = '';
let env: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'drafts-health-'));
  env = {HOME: dir, JUSTIN_THREADS_STATE_DIR: join(dir, 'state')};
  for (const [sessionId, repo] of [
    [HOME_SESSION, 'home-base'],
    [OTHER_SESSION, 'life'],
  ] as const) {
    expect(
      appendSessionSighting(
        {
          at: '2026-11-01T00:00:00.000Z',
          beadId: `${repo}-x`,
          beadsDir: `/r/${repo}/.beads`,
          branch: 'main',
          checkoutPath: `/r/${repo}`,
          event: 'created',
          repo,
          sessionId,
        },
        env,
      ).kind,
    ).toBe('appended');
  }
});

afterEach(() => {
  rmSync(dir, {force: true, recursive: true});
});

function run(over: Partial<DraftsScanRun> = {}): DraftsScanRun {
  return {
    counts: {
      claudePanes: 64,
      cleared: 0,
      failures: 0,
      found: 3,
      surfacesRead: 101,
      unplaced: 1,
      unreadable: 0,
    },
    endedAt: '2026-11-15T09:05:03.000Z',
    error: null,
    exitCode: 0,
    outcome: 'scanned',
    parentPidAtEnd: 1,
    pid: 100,
    startedAt: '2026-11-15T09:05:00.000Z',
    trigger: 'hook',
    ...over,
  };
}

/** A hook run that could not reach cmux. */
function failedRun(over: Partial<DraftsScanRun> = {}): DraftsScanRun {
  return run({
    counts: null,
    error: 'cmux cannot be reached',
    exitCode: 2,
    outcome: 'unreachable',
    ...over,
  });
}

function record(value: DraftsScanRun): void {
  expect(appendDraftsScanRun(value, env)).toBeNull();
}

/** One capture record per instant, for one session. */
function active(sessionId: string, ...instants: string[]): void {
  const path = captureRunLogPath(env);
  mkdirSync(dirname(path), {recursive: true});
  for (const at of instants) {
    appendFileSync(
      path,
      `${JSON.stringify({at, outcome: 'applied', sessionId})}\n`,
    );
  }
}

function verdict(now: string) {
  return draftsScanHealth({env, now: new Date(now), timeZone: 'UTC'});
}

describe('draftsScanHealth (D6)', () => {
  test('ok after a scanned run, saying when it ran', () => {
    record(run());
    expect(verdict('2026-11-15T09:30:00.000Z')).toEqual({
      detail:
        'last scan 2026-11-15 09:05 (started by the hourly hook), 64 Claude panes',
      kind: 'ok',
    });
  });

  // home-base-fmf1n.1: one failed hook run is tolerated, two in a row are not.
  test('failed when two hook runs in a row were not scanned, since the first of them', () => {
    record(run({startedAt: '2026-11-15T07:05:00.000Z'}));
    record(failedRun({startedAt: '2026-11-15T08:05:00.000Z'}));
    record(failedRun());
    const result = verdict('2026-11-15T09:30:00.000Z');
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.reason).toBe(
      '2 drafts scans in a row failed, and only one is tolerated; the last, 2026-11-15 09:05 (started by the hourly hook), ended unreachable: cmux cannot be reached',
    );
    // Since the first of the failures in a row, not the newest one.
    expect(result.since?.toISOString()).toBe('2026-11-15T08:05:00.000Z');
  });

  test('ok after one failed hook run that followed a scanned one, naming the failure', () => {
    record(run({startedAt: '2026-11-15T08:05:00.000Z'}));
    record(failedRun({error: 'cmux tree: timed out after 30000 ms'}));
    expect(verdict('2026-11-15T09:30:00.000Z')).toEqual({
      detail:
        'one failed scan is tolerated, and the next one decides; the last, 2026-11-15 09:05 (started by the hourly hook), ended unreachable: cmux tree: timed out after 30000 ms',
      kind: 'ok',
    });
  });

  test('ok after one failed hook run with no hook run before it', () => {
    record(failedRun());
    const result = verdict('2026-11-15T09:30:00.000Z');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.detail).toBe(
      'one failed scan is tolerated, and the next one decides; the last, 2026-11-15 09:05 (started by the hourly hook), ended unreachable: cmux cannot be reached',
    );
  });

  test('failed when one failed hook run is followed by two whole active hours with no hook run', () => {
    record(run({startedAt: '2026-11-15T07:05:00.000Z'}));
    record(failedRun({startedAt: '2026-11-15T08:05:00.000Z'}));
    active(
      HOME_SESSION,
      '2026-11-15T09:10:00.000Z',
      '2026-11-15T10:10:00.000Z',
    );
    const result = verdict('2026-11-15T11:30:00.000Z');
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.reason).toBe(
      'home-base sessions were active in the hours from 2026-11-15 09:00, 2026-11-15 10:00, but no drafts scan ran since 2026-11-15 08:05 (started by the hourly hook), which ended unreachable: cmux cannot be reached',
    );
    expect(result.since?.toISOString()).toBe('2026-11-15T09:10:00.000Z');
  });

  test('failed when home-base sessions were active in two whole hours after the last run, and no run followed', () => {
    record(run());
    active(
      HOME_SESSION,
      '2026-11-15T10:10:00.000Z',
      '2026-11-15T11:40:00.000Z',
    );
    const result = verdict('2026-11-15T12:30:00.000Z');
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.reason).toBe(
      'home-base sessions were active in the hours from 2026-11-15 10:00, 2026-11-15 11:00, but no drafts scan ran since 2026-11-15 09:05 (started by the hourly hook)',
    );
    expect(result.since?.toISOString()).toBe('2026-11-15T10:10:00.000Z');
  });

  test('ok for idle time: no activity at all, however long since the last run', () => {
    record(run());
    expect(verdict('2026-11-18T12:30:00.000Z').kind).toBe('ok');
  });

  test('ok when only one whole hour was active, or only other repos, or only the hour still running', () => {
    record(run());
    // One active hour after the run: tolerated.
    active(
      HOME_SESSION,
      '2026-11-15T10:10:00.000Z',
      '2026-11-15T10:50:00.000Z',
    );
    // Another repo's sessions do not run this hook.
    active(
      OTHER_SESSION,
      '2026-11-15T11:10:00.000Z',
      '2026-11-15T12:10:00.000Z',
    );
    // The hour that is still running does not count yet.
    active(HOME_SESSION, '2026-11-15T13:05:00.000Z');
    // Activity in the run's own hour does not count either.
    active(HOME_SESSION, '2026-11-15T09:40:00.000Z');
    expect(verdict('2026-11-15T13:30:00.000Z').kind).toBe('ok');
  });

  test('no run log yet: failed when two whole hours of the last 48 were active, ok when idle', () => {
    expect(verdict('2026-11-15T12:30:00.000Z')).toEqual({
      detail:
        'the hourly hook has started no drafts scan yet, and no home-base session was active in two whole hours of the last 48',
      kind: 'ok',
    });
    active(
      HOME_SESSION,
      '2026-11-15T10:10:00.000Z',
      '2026-11-15T11:10:00.000Z',
    );
    const result = verdict('2026-11-15T12:30:00.000Z');
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.reason).toContain(
      'but the hourly hook has started no drafts scan (none recorded in',
    );
  });

  // Fix round F1: scans typed by hand (and the dashboard's) never move the
  // verdict, in either direction.
  test('a scanned hook run followed by a failed manual run reads ok', () => {
    record(run());
    record(
      run({
        counts: null,
        error: 'the sandbox blocks the cmux socket',
        exitCode: 2,
        outcome: 'unreachable',
        startedAt: '2026-11-15T09:20:00.000Z',
        trigger: 'manual',
      }),
    );
    expect(verdict('2026-11-15T09:30:00.000Z')).toEqual({
      detail:
        'last scan 2026-11-15 09:05 (started by the hourly hook), 64 Claude panes',
      kind: 'ok',
    });
  });

  test('two failed hook runs followed by a scanned manual run read failed', () => {
    record(failedRun({startedAt: '2026-11-15T08:05:00.000Z'}));
    record(failedRun());
    record(run({startedAt: '2026-11-15T09:20:00.000Z', trigger: 'manual'}));
    const result = verdict('2026-11-15T09:30:00.000Z');
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.reason).toContain(
      'ended unreachable: cmux cannot be reached',
    );
  });

  // home-base-fmf1n.1: a failed manual run is not a second failure in a row,
  // before the failed hook run or after it.
  test('failed manual runs around one failed hook run still read ok', () => {
    record(run({startedAt: '2026-11-15T07:05:00.000Z'}));
    record(
      failedRun({
        error: 'the sandbox blocks the cmux socket',
        startedAt: '2026-11-15T07:30:00.000Z',
        trigger: 'manual',
      }),
    );
    record(failedRun({startedAt: '2026-11-15T08:05:00.000Z'}));
    record(
      failedRun({
        error: 'the sandbox blocks the cmux socket',
        startedAt: '2026-11-15T08:20:00.000Z',
        trigger: 'manual',
      }),
    );
    expect(verdict('2026-11-15T08:30:00.000Z')).toEqual({
      detail:
        'one failed scan is tolerated, and the next one decides; the last, 2026-11-15 08:05 (started by the hourly hook), ended unreachable: cmux cannot be reached',
      kind: 'ok',
    });
  });

  test('only manual runs, and two whole active hours, reads failed', () => {
    record(run({trigger: 'manual'}));
    record(run({startedAt: '2026-11-15T11:20:00.000Z', trigger: 'manual'}));
    active(
      HOME_SESSION,
      '2026-11-15T10:10:00.000Z',
      '2026-11-15T11:10:00.000Z',
    );
    const result = verdict('2026-11-15T12:30:00.000Z');
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.reason).toContain(
      'the hourly hook has started no drafts scan',
    );
  });

  test('unknown when the run log cannot be read', () => {
    record(run());
    appendFileSync(draftsScanRunsPath(env), '{"torn":\n');
    const result = verdict('2026-11-15T09:30:00.000Z');
    expect(result.kind).toBe('unknown');
    if (result.kind !== 'unknown') return;
    expect(result.reason).toContain('line 2: not JSON');
  });

  test('unknown when the run log is not a file', () => {
    mkdirSync(draftsScanRunsPath(env), {recursive: true});
    expect(verdict('2026-11-15T09:30:00.000Z').kind).toBe('unknown');
  });

  test('unknown when activity exists but the sessions index cannot place it', () => {
    record(run());
    active(
      HOME_SESSION,
      '2026-11-15T10:10:00.000Z',
      '2026-11-15T11:10:00.000Z',
    );
    rmSync(join(dir, 'state', 'sessions.jsonl'));
    expect(verdict('2026-11-15T12:30:00.000Z').kind).toBe('unknown');
  });
});
