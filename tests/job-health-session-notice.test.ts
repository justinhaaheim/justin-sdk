/**
 * Broken recurring jobs at the start of a home-base session (home-base-9dcx9.2,
 * D1 to D5): the jobs section `composeRepoState` adds in a repo whose config
 * sets `componentConfig["job-health"].sessionNotice`, and nowhere else.
 *
 * Every chores state here is a throwaway directory passed as CHORES_STATE_DIR,
 * so nothing reads this Mac's real health file.
 *
 * NEGATIVE CONTROLS (run by hand, recorded on home-base-9dcx9.2): each block
 * below was run once with its feature removed and failed on its own assertion.
 */
import {afterAll, describe, expect, test} from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {
  composeJobHealthSection,
  composeRepoState,
  isMayorFirstPrompt,
  jobsNoticeRecordPath,
  type JobsNoticeRule,
} from '../src/first-prompt';
import {
  JOB_HEALTH_STALE_MS,
  type JobHealthFile,
  jobHealthSessionText,
  type JobProblem,
} from '../src/job-health';
import {renderConfigSchema} from '../src/sdk-config';
import {mayorSuccessorSentence} from '../src/thread/handoff-number';
import {MAYOR_SUCCESSOR_SENTENCE} from '../src/thread/mayor-sentence';
import {MAYOR_ROLE_LABEL} from '../src/thread/session-bead';
import {FIXTURE_IDENTITY, git, initFixtureRepo} from './git-fixtures';

const SCRATCH = mkdtempSync(join(tmpdir(), 'job-health-session-'));
afterAll(() => {
  rmSync(SCRATCH, {force: true, recursive: true});
});

const NOW = new Date('2026-11-14T18:00:00Z');
const TZ = 'UTC';
const HEADING = '# Recurring jobs on this Mac';
const INSTRUCTION =
  'In your first reply, tell Justin which jobs are broken, in a short list, and propose one next step for each. Do not start fixing them unless he asks.';
const WHEN =
  'Shown in every mayor session and in the first home-base session each day.';

const LIFE: JobProblem = {
  id: 'life-daily-run',
  kind: 'failing',
  name: 'life daily run',
  reason: '13 failed',
  since: '2026-10-31T07:00:00.000Z',
};
const DRAFTS: JobProblem = {
  id: 'thread-drafts-scan',
  kind: 'overdue',
  name: 'unsent-drafts scan',
  reason: 'no success since 2026-11-12',
  since: null,
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
function stateDir(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(SCRATCH, 'state-'));
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

function sectionFor(files: Record<string, string>): string {
  return composeJobHealthSection({
    env: {CHORES_STATE_DIR: stateDir(files)},
    now: NOW,
    timeZone: TZ,
  });
}

const BROKEN_STATE = {'health.json': JSON.stringify(health())};

describe('the words (D4)', () => {
  test('broken: a heading with the count, one line per job, the details command, the instruction', () => {
    expect(
      jobHealthSessionText({kind: 'broken', problems: [LIFE, DRAFTS]}, TZ),
    ).toBe(
      [
        `${HEADING}: 2 broken`,
        '',
        '- **life daily run** (`life-daily-run`): failing since 2026-10-31. 13 failed',
        '- **unsent-drafts scan** (`thread-drafts-scan`): not running. no success since 2026-11-12',
        '',
        'Details: run `chores`.',
        '',
        WHEN,
        '',
        INSTRUCTION,
      ].join('\n'),
    );
  });

  test('not running and unknown: the heading says so, the body is the status report line', () => {
    expect(
      jobHealthSessionText({ageMs: null, kind: 'not-running', path: '/x'}, TZ),
    ).toBe(
      [
        `${HEADING}: chores not running`,
        '',
        '⚠️ chores not running: it has run on this Mac, but it has written no health file',
        '',
        'Details: run `chores`.',
        '',
        WHEN,
        '',
        INSTRUCTION,
      ].join('\n'),
    );
    expect(
      jobHealthSessionText({error: 'not JSON', kind: 'unknown', path: '/x'}),
    ).toBe(
      [
        `${HEADING}: health unknown`,
        '',
        '⚠️ job health unknown: not JSON',
        '',
        'Details: run `chores`.',
        '',
        WHEN,
        '',
        INSTRUCTION,
      ].join('\n'),
    );
  });
});

describe('composeJobHealthSection: every kind shows, and only a claim of "fine" is silent', () => {
  test('broken jobs: the section names each one', () => {
    expect(sectionFor(BROKEN_STATE)).toBe(
      jobHealthSessionText({kind: 'broken', problems: [LIFE]}, TZ),
    );
  });

  test('a fresh file with no problems: nothing', () => {
    expect(
      sectionFor({'health.json': JSON.stringify(health({problems: []}))}),
    ).toBe('');
  });

  test('chores has never run here (no health file, no run log): nothing', () => {
    expect(sectionFor({})).toBe('');
  });

  test('a stale health file: a "chores not running" section', () => {
    const stale = health({
      at: new Date(NOW.getTime() - JOB_HEALTH_STALE_MS - 60_000).toISOString(),
    });
    expect(sectionFor({'health.json': JSON.stringify(stale)})).toStartWith(
      `${HEADING}: chores not running\n\n⚠️ chores not running: its health file is 2 hours old`,
    );
  });

  test('an unreadable health file: a "health unknown" section', () => {
    expect(sectionFor({'health.json': '{nope'})).toStartWith(
      `${HEADING}: health unknown\n\n⚠️ job health unknown: not JSON`,
    );
  });

  test('a throw inside the section is an unknown section naming the error, never nothing (D5)', () => {
    const section = composeJobHealthSection({
      now: NOW,
      read: () => {
        throw new Error('disk on fire');
      },
    });
    expect(section).toStartWith(
      `${HEADING}: health unknown\n\n⚠️ job health unknown: composing this notice failed (disk on fire)`,
    );
    expect(section).toEndWith(INSTRUCTION);
  });
});

/** A committed git repo carrying `config` as its justin-sdk.config.json. */
function repoWith(config: unknown): string {
  const root = mkdtempSync(join(SCRATCH, 'repo-'));
  const excludes = join(root, '.git', 'controlled-excludes');
  initFixtureRepo(root, {excludesFile: excludes, identity: FIXTURE_IDENTITY});
  writeFileSync(excludes, '');
  if (config !== undefined) {
    writeFileSync(
      join(root, 'justin-sdk.config.json'),
      `${JSON.stringify(config, null, 2)}\n`,
    );
  }
  writeFileSync(join(root, 'README.md'), 'x\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'init']);
  return root;
}

const OPTED_IN = {componentConfig: {'job-health': {sessionNotice: true}}};

function composeIn(repo: string): string {
  return composeRepoState(repo, {
    // A throwaway XDG_STATE_HOME too, so no rule can reach this Mac's real
    // notice record (home-base-lv87w.2).
    env: {
      CHORES_STATE_DIR: stateDir(BROKEN_STATE),
      XDG_STATE_HOME: mkdtempSync(join(SCRATCH, 'xdg-')),
    },
    now: NOW,
    timeZone: TZ,
  });
}

describe('composeRepoState: only a repo that opted in gets the section (D1, D2)', () => {
  test('on a branch: the repo-state block, then the jobs section', () => {
    const repo = repoWith(OPTED_IN);
    git(repo, ['checkout', '-qb', 'feature-x']);
    writeFileSync(join(repo, 'x.txt'), 'x\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'x']);
    git(repo, ['checkout', '-q', 'main']);

    const text = composeIn(repo);
    const repoAt = text.indexOf('# Current repo state');
    const jobsAt = text.indexOf(`${HEADING}: 1 broken`);
    expect(repoAt).toBe(0);
    expect(jobsAt).toBeGreaterThan(repoAt);
    expect(text).toEndWith(
      jobHealthSessionText({kind: 'broken', problems: [LIFE]}, TZ),
    );
  });

  test('a detached HEAD (no repo-state block) still gets the jobs section', () => {
    const repo = repoWith(OPTED_IN);
    git(repo, ['checkout', '-q', '--detach']);
    expect(composeIn(repo)).toBe(
      jobHealthSessionText({kind: 'broken', problems: [LIFE]}, TZ),
    );
  });

  test('without the key, with it false, or with no config: no section, even while jobs are broken', () => {
    for (const config of [
      {componentConfig: {husky: {}}},
      {componentConfig: {'job-health': {sessionNotice: false}}},
      undefined,
    ]) {
      const repo = repoWith(config);
      git(repo, ['checkout', '-q', '--detach']);
      expect(composeIn(repo)).toBe('');
    }
  });

  test('a config that is not JSON, or a key of the wrong type: no section', () => {
    const notJson = repoWith(undefined);
    writeFileSync(join(notJson, 'justin-sdk.config.json'), '{nope');
    const wrongType = repoWith({
      componentConfig: {'job-health': {sessionNotice: 'true'}},
    });
    for (const repo of [notJson, wrongType]) {
      git(repo, ['checkout', '-q', '--detach']);
      expect(composeIn(repo)).toBe('');
    }
  });
});

// ---------------------------------------------------------------------------
// home-base-lv87w.2: every mayor session, and once a day in other sessions
// ---------------------------------------------------------------------------

const SECTION = jobHealthSessionText({kind: 'broken', problems: [LIFE]}, TZ);
const TODAY = '2026-11-14'; // NOW in UTC

/** An `$XDG_STATE_HOME`, holding `record` as the notice record when given. */
function xdgState(record?: string): string {
  const dir = mkdtempSync(join(SCRATCH, 'xdg-state-'));
  if (record !== undefined) {
    mkdirSync(join(dir, 'justin-sdk'), {recursive: true});
    writeFileSync(jobsNoticeRecordPath({XDG_STATE_HOME: dir}), record);
  }
  return dir;
}

/** The day the record holds, or null when there is no record file. */
function recordedDay(xdg: string): null | string {
  const path = jobsNoticeRecordPath({XDG_STATE_HOME: xdg});
  if (!existsSync(path)) return null;
  return (JSON.parse(readFileSync(path, 'utf-8')) as {day: string}).day;
}

const dayRecord = (day: string): string =>
  `${JSON.stringify({at: '2026-01-01T00:00:00.000Z', day})}\n`;

let detachedRepo: null | string = null;
/** One opted-in repo on a detached HEAD, so the output is the jobs section alone. */
function sharedRepo(): string {
  if (detachedRepo == null) {
    detachedRepo = repoWith(OPTED_IN);
    git(detachedRepo, ['checkout', '-q', '--detach']);
  }
  return detachedRepo;
}

function composeUnder(
  rule: JobsNoticeRule,
  xdg: string,
  options: {
    files?: Record<string, string>;
    now?: Date;
    timeZone?: string;
  } = {},
): string {
  return composeRepoState(sharedRepo(), {
    env: {
      CHORES_STATE_DIR: stateDir(options.files ?? BROKEN_STATE),
      XDG_STATE_HOME: xdg,
    },
    jobsNotice: rule,
    now: options.now ?? NOW,
    timeZone: options.timeZone ?? TZ,
  });
}

describe('how often the section shows (home-base-lv87w.2)', () => {
  test('daily: the first session of the day shows it and records the day; the next one shows nothing', () => {
    const xdg = xdgState();
    expect(composeUnder('daily', xdg)).toBe(SECTION);
    expect(recordedDay(xdg)).toBe(TODAY);
    expect(composeUnder('daily', xdg)).toBe('');
  });

  test('mayor: shows even when today is recorded, and records today', () => {
    const recorded = xdgState(dayRecord(TODAY));
    expect(composeUnder('mayor', recorded)).toBe(SECTION);
    expect(recordedDay(recorded)).toBe(TODAY);

    const fresh = xdgState();
    expect(composeUnder('mayor', fresh)).toBe(SECTION);
    expect(recordedDay(fresh)).toBe(TODAY);
    // A mayor showing it uses up the day for everyone else.
    expect(composeUnder('daily', fresh)).toBe('');
  });

  test('a record from yesterday counts as not shown: it shows, and the record moves to today', () => {
    const xdg = xdgState(dayRecord('2026-11-13'));
    expect(composeUnder('daily', xdg)).toBe(SECTION);
    expect(recordedDay(xdg)).toBe(TODAY);
  });

  test('an unreadable record counts as not shown (D3): not JSON, or no day in it', () => {
    for (const record of ['{nope', `${JSON.stringify({day: 5})}\n`, '[]']) {
      const xdg = xdgState(record);
      expect(composeUnder('daily', xdg)).toBe(SECTION);
      expect(recordedDay(xdg)).toBe(TODAY);
    }
  });

  test('nothing broken: nothing shown and nothing recorded, under every rule', () => {
    const clean = {'health.json': JSON.stringify(health({problems: []}))};
    for (const rule of ['daily', 'mayor', 'always'] as const) {
      const xdg = xdgState();
      expect(composeUnder(rule, xdg, {files: clean})).toBe('');
      expect(recordedDay(xdg)).toBeNull();
    }
  });

  test('always (the `repo-state` command): shows even when today is recorded, and never writes the record (D4)', () => {
    const recorded = xdgState(dayRecord(TODAY));
    expect(composeUnder('always', recorded)).toBe(SECTION);
    const fresh = xdgState();
    expect(composeUnder('always', fresh)).toBe(SECTION);
    expect(composeUnder('always', fresh)).toBe(SECTION);
    expect(recordedDay(fresh)).toBeNull();
  });

  test('the default rule is always: shows and records nothing', () => {
    const xdg = xdgState(dayRecord(TODAY));
    const text = composeRepoState(sharedRepo(), {
      env: {CHORES_STATE_DIR: stateDir(BROKEN_STATE), XDG_STATE_HOME: xdg},
      now: NOW,
      timeZone: TZ,
    });
    expect(text).toBe(SECTION);
  });

  test('the day is the local calendar day (D2)', () => {
    // 03:00 UTC on the 15th is still the 14th in Los Angeles.
    const lateEvening = new Date('2026-11-15T03:00:00Z');
    const files = {
      'health.json': JSON.stringify(
        health({
          at: new Date(lateEvening.getTime() - 5 * 60_000).toISOString(),
        }),
      ),
    };
    const la = 'America/Los_Angeles';
    const sameLocalDay = xdgState(dayRecord('2026-11-14'));
    expect(
      composeUnder('daily', sameLocalDay, {
        files,
        now: lateEvening,
        timeZone: la,
      }),
    ).toBe('');
    const utc = xdgState(dayRecord('2026-11-14'));
    expect(
      composeUnder('daily', utc, {files, now: lateEvening, timeZone: 'UTC'}),
    ).toStartWith(`${HEADING}: 1 broken`);
    expect(recordedDay(utc)).toBe('2026-11-15');
  });

  test('a record that cannot be written leaves the section shown, says so, and the next session shows it again (D3)', () => {
    // XDG_STATE_HOME is a FILE, so its justin-sdk directory cannot be made.
    const blocker = join(mkdtempSync(join(SCRATCH, 'blocked-')), 'not-a-dir');
    writeFileSync(blocker, 'x\n');
    for (let session = 0; session < 2; session++) {
      const text = composeUnder('daily', blocker);
      expect(text).toStartWith(SECTION);
      expect(text).toContain(
        '⚠️ Could not record that this notice was shown today (could not write ',
      );
      expect(text).toEndWith('so the next home-base session shows it again.');
    }
  });
});

describe('isMayorFirstPrompt (home-base-lv87w.2 D1)', () => {
  test('a typed /mayor, alone or with arguments, is a mayor session', () => {
    for (const prompt of [
      '/mayor',
      '/mayor brain dump about the vitals job',
      '  /mayor\n\nhere is my list',
      '/mayor\tx',
    ]) {
      expect(isMayorFirstPrompt(prompt)).toBe(true);
    }
  });

  test("a mayor successor's kickoff, which carries the sentence handoff-number.ts writes, is a mayor session", () => {
    // The leaf constant IS the sentence the successor is given: not retyped.
    expect(mayorSuccessorSentence([MAYOR_ROLE_LABEL])).toBe(
      MAYOR_SUCCESSOR_SENTENCE,
    );
    expect(
      isMayorFirstPrompt(
        `You continue session bead home-base-abc. ${MAYOR_SUCCESSOR_SENTENCE} Then read the handoff.`,
      ),
    ).toBe(true);
  });

  test('anything else is not', () => {
    for (const prompt of [
      'hello',
      '/mayors',
      '/mayor-intake',
      '/conductor go',
      'please run /mayor',
      '',
      undefined,
      null,
      42,
    ]) {
      expect(isMayorFirstPrompt(prompt)).toBe(false);
    }
  });
});

describe('the knob (D2)', () => {
  test('`config schema` lists componentConfig.job-health.sessionNotice, default false', () => {
    const line = renderConfigSchema({
      env: {XDG_CONFIG_HOME: join(SCRATCH, 'no-user-config')},
      projectRoot: SCRATCH,
    })
      .split('\n')
      .find((each) =>
        /^\s*componentConfig\.job-health\.sessionNotice\s/.test(each),
      );
    expect(line).toBeDefined();
    expect(line).toContain('boolean');
    expect(line).toContain('default false');
  });
});
