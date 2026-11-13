/**
 * The job health file: its parser, its reader and the words every reader
 * shows (home-base-1rxt0.10, D1, D2, D4, D5). Rule 7 is the spine: nothing
 * unreadable, stale or missing may read as all clear.
 */
import {afterAll, describe, expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {
  choresStateDir,
  JOB_HEALTH_STALE_MS,
  jobHealthBadge,
  type JobHealthFile,
  jobHealthNotice,
  jobHealthPath,
  jobHealthReportText,
  type JobProblem,
  readJobHealth,
  writeJobHealth,
} from '../src/job-health';

const SCRATCH = mkdtempSync(join(tmpdir(), 'job-health-'));
afterAll(() => {
  rmSync(SCRATCH, {force: true, recursive: true});
});

const NOW = new Date('2026-11-13T02:00:00Z');
const LIFE: JobProblem = {
  id: 'life-daily-run',
  kind: 'failing',
  name: 'life daily run',
  reason: '13 failed',
  since: '2026-10-31T07:00:00.000Z',
};

function health(overrides: Partial<JobHealthFile> = {}): JobHealthFile {
  return {
    at: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
    checked: 10,
    problems: [LIFE],
    version: 1,
    ...overrides,
  };
}

/** A chores state dir holding the given files. */
function stateDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(SCRATCH, 'state-'));
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

function noticeFor(files: Record<string, string>) {
  return jobHealthNotice(
    readJobHealth({CHORES_STATE_DIR: stateDir(files)}),
    NOW,
  );
}

describe('paths', () => {
  test('CHORES_STATE_DIR, then XDG_STATE_HOME/chores, then ~/.local/state/chores', () => {
    expect(choresStateDir({CHORES_STATE_DIR: '/x'})).toBe('/x');
    expect(choresStateDir({XDG_STATE_HOME: '/s'})).toBe('/s/chores');
    expect(choresStateDir({CHORES_STATE_DIR: '  ', XDG_STATE_HOME: '/s'})).toBe(
      '/s/chores',
    );
    expect(jobHealthPath({CHORES_STATE_DIR: '/x'})).toBe('/x/health.json');
  });
});

describe('jobHealthNotice', () => {
  test('a fresh file with problems: broken', () => {
    const notice = noticeFor({'health.json': JSON.stringify(health())});
    expect(notice).toEqual({kind: 'broken', problems: [LIFE]});
  });

  test('a fresh file with no problems: nothing to show', () => {
    expect(
      noticeFor({'health.json': JSON.stringify(health({problems: []}))}),
    ).toBeNull();
  });

  test('negative control for the line above: checked 0 is unknown, not clean', () => {
    expect(
      noticeFor({
        'health.json': JSON.stringify(health({checked: 0, problems: []})),
      })?.kind,
    ).toBe('unknown');
  });

  test('stale: older than the threshold is "chores not running", even with no problems', () => {
    const old = new Date(NOW.getTime() - JOB_HEALTH_STALE_MS - 1).toISOString();
    expect(
      noticeFor({
        'health.json': JSON.stringify(health({at: old, problems: []})),
      })?.kind,
    ).toBe('not-running');
    const justFresh = new Date(
      NOW.getTime() - JOB_HEALTH_STALE_MS,
    ).toISOString();
    expect(
      noticeFor({
        'health.json': JSON.stringify(health({at: justFresh, problems: []})),
      }),
    ).toBeNull();
  });

  test('missing file where chores has run: "chores not running"', () => {
    expect(noticeFor({'runs.jsonl': '{}\n'})).toEqual({
      ageMs: null,
      kind: 'not-running',
      path: expect.stringContaining('health.json') as unknown as string,
    });
  });

  test('missing file where chores has never run: nothing (another Mac)', () => {
    expect(noticeFor({})).toBeNull();
  });

  test.each([
    ['not JSON', '{nope'],
    ['an array', '[]'],
    ['a wrong version', JSON.stringify({...health(), version: 2})],
    [
      'an unknown kind',
      JSON.stringify(health({problems: [{...LIFE, kind: 'sad' as 'failing'}]})),
    ],
    [
      'a bad since',
      JSON.stringify(health({problems: [{...LIFE, since: 'later'}]})),
    ],
    [
      'a missing name',
      JSON.stringify(health({problems: [{...LIFE, name: ''}]})),
    ],
  ])('an unreadable file (%s) is unknown', (_name, text) => {
    expect(noticeFor({'health.json': text})?.kind).toBe('unknown');
  });

  test('a directory where the file should be is unknown', () => {
    const dir = stateDir({});
    mkdirSync(join(dir, 'health.json'));
    expect(
      jobHealthNotice(readJobHealth({CHORES_STATE_DIR: dir}), NOW)?.kind,
    ).toBe('unknown');
  });
});

describe('words', () => {
  test('statusline badge: one problem names it with its age', () => {
    expect(jobHealthBadge({kind: 'broken', problems: [LIFE]}, NOW)).toBe(
      '⚠ life daily run failing 12d',
    );
  });

  test('statusline badge: several problems are counted', () => {
    expect(
      jobHealthBadge(
        {kind: 'broken', problems: [LIFE, {...LIFE, id: 'b', name: 'b'}]},
        NOW,
      ),
    ).toBe('⚠ 2 jobs broken');
  });

  test('statusline badge: not running and unknown', () => {
    expect(
      jobHealthBadge({ageMs: null, kind: 'not-running', path: '/p'}, NOW),
    ).toBe('⚠ chores not running');
    expect(jobHealthBadge({error: 'e', kind: 'unknown', path: '/p'}, NOW)).toBe(
      '⚠ job health unknown',
    );
  });

  test('report text: which jobs, since which local day', () => {
    expect(
      jobHealthReportText(
        {kind: 'broken', problems: [LIFE]},
        'America/Los_Angeles',
      ),
    ).toBe('⚠️ life daily run failing since 2026-10-31');
    expect(
      jobHealthReportText(
        {
          kind: 'broken',
          problems: [
            LIFE,
            {...LIFE, kind: 'never-run', name: 'x', since: null},
          ],
        },
        'America/Los_Angeles',
      ),
    ).toBe(
      '⚠️ 2 jobs broken: life daily run failing since 2026-10-31; x never run',
    );
    expect(
      jobHealthReportText({
        ageMs: 5 * 3_600_000,
        kind: 'not-running',
        path: '/p',
      }),
    ).toBe('⚠️ chores not running: its health file is 5 hours old');
  });
});

describe('writeJobHealth', () => {
  test('round-trips through the reader', () => {
    const dir = mkdtempSync(join(SCRATCH, 'write-'));
    const written = writeJobHealth(join(dir, 'health.json'), health());
    expect(written.kind).toBe('written');
    const read = readJobHealth({CHORES_STATE_DIR: dir});
    expect(read).toMatchObject({health: health(), kind: 'read'});
  });

  test('a write that cannot happen is a failed result, not a throw', () => {
    const dir = stateDir({blocker: 'a file, not a dir'});
    const written = writeJobHealth(
      join(dir, 'blocker', 'health.json'),
      health(),
    );
    expect(written.kind).toBe('failed');
  });
});
