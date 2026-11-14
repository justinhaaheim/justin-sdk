/**
 * scripts/test-timing.ts (home-base-ejsq2.1): the junit and spawn-log readers,
 * the analysis, and the two contracts the bead names — `--help` does nothing
 * else, and a run without a spawn log says "no spawn log" rather than printing
 * zero shares (critical rule 7).
 */
import {describe, expect, test} from 'bun:test';
import {join} from 'node:path';

import {
  analyse,
  consoleCounts,
  otherTestRuns,
  parseJunit,
  parseSpawnLog,
  programOf,
  renderReport,
  subcommandOf,
  unionMs,
} from '../scripts/test-timing';
import {PLAIN_STYLE} from '../src/cli-style';

const JUNIT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="3" assertions="3" failures="1" skipped="0" time="2.5">
  <testsuite name="tests/a.test.ts" file="tests/a.test.ts" tests="2" assertions="2" failures="1" skipped="0" time="2.0" hostname="h">
    <testsuite name="a &amp; b" file="tests/a.test.ts" line="3" tests="2" assertions="2" failures="1" skipped="0" time="1.5" hostname="h">
      <testcase name="first &quot;one&quot;" classname="a &amp; b" time="1.0" file="tests/a.test.ts" line="4" assertions="1" />
      <testcase name="second" classname="a &amp; b" time="0.5" file="tests/a.test.ts" line="9" assertions="1">
        <failure type="AssertionError" />
      </testcase>
    </testsuite>
  </testsuite>
  <testsuite name="tests/b.test.ts" file="tests/b.test.ts" tests="1" assertions="1" failures="0" skipped="0" time="0.25" hostname="h">
    <testcase name="only" classname="" time="0.25" file="tests/b.test.ts" line="2" assertions="1" />
  </testsuite>
</testsuites>
`;

function facts(id: number, extra: Record<string, unknown>): string {
  return JSON.stringify({
    api: 'spawnSync',
    argc: 1,
    args: [],
    cmd: 'br',
    cwd: '/tmp/x',
    file: 'tests/a.test.ts',
    fileFrom: 'stack',
    id,
    mode: 'sync',
    pid: 7,
    readError: null,
    resolved: '/Users/u/.local/share/mise/installs/br/bin/br',
    runningFile: 'tests/a.test.ts',
    startMs: 1000 + id * 100,
    via: 'execFileSync',
    ...extra,
  });
}

const LOG = [
  JSON.stringify({
    bun: '1.4.2',
    cwd: '/p',
    kind: 'session',
    pid: 7,
    startMs: 1,
    v: 2,
  }),
  facts(1, {
    args: ['list', '--json'],
    durationMs: 50,
    error: null,
    exitCode: 0,
    kind: 'call',
    outcome: 'returned',
  }),
  facts(2, {
    args: ['--db', '/x/beads.db', 'create'],
    durationMs: 150,
    error: null,
    exitCode: 0,
    kind: 'call',
    outcome: 'returned',
  }),
  facts(3, {
    api: 'spawn',
    args: ['-c', 'GIT_X=1 git status --short'],
    cmd: 'sh',
    kind: 'start',
    mode: 'async',
  }),
  JSON.stringify({
    durationMs: 30,
    exitCode: 0,
    id: 3,
    kind: 'end',
    outcome: 'exited',
    pid: 7,
  }),
  facts(4, {
    api: 'spawn',
    args: ['/p/src/cli.ts', 'thread', 'status'],
    cmd: 'bun',
    kind: 'start',
    mode: 'async',
  }),
  'not json',
].join('\n');

describe('reading the files', () => {
  test('junit: per-file time from the file suite, entities decoded, failures marked', async () => {
    const junit = await parseJunit(JUNIT);
    expect(junit.testsTotal).toBe(3);
    expect(junit.failures).toBe(1);
    expect(junit.totalSeconds).toBe(2.5);
    expect(junit.files).toEqual([
      {failures: 1, file: 'tests/a.test.ts', seconds: 2, tests: 2},
      {failures: 0, file: 'tests/b.test.ts', seconds: 0.25, tests: 1},
    ]);
    expect(junit.tests.map((t) => [t.name, t.failed])).toEqual([
      ['first "one"', false],
      ['second', true],
      ['only', false],
    ]);
  });

  test('spawn log: a start meets its end; a start with no end is unfinished, never 0 ms; a bad line is kept as malformed', () => {
    const log = parseSpawnLog(LOG);
    expect(log.processes).toBe(1);
    expect(log.malformed).toHaveLength(1);
    expect(log.malformed[0]?.line).toBe(7);
    const byId = log.spawns.map((s) => [s.cmd, s.outcome, s.durationMs]);
    expect(byId).toEqual([
      ['br', 'returned', 50],
      ['br', 'returned', 150],
      ['sh', 'exited', 30],
      ['bun', 'unfinished', null],
    ]);
  });

  test("bun test's own pass and fail lines", () => {
    expect(consoleCounts(' 6171 pass\n 0 fail\n')).toEqual({
      fail: 0,
      pass: 6171,
    });
    expect(consoleCounts('nothing here')).toBeNull();
  });
});

describe('classifying a spawn', () => {
  test('sh -c runs the first word of its script, after assignments', () => {
    expect(
      programOf({args: ['-c', 'GIT_X=1 git status --short'], cmd: 'sh'}),
    ).toEqual({
      program: 'git',
      rest: ['status', '--short'],
      shell: true,
    });
    expect(programOf({args: ['list'], cmd: 'br'}).program).toBe('br');
  });

  test('subcommands skip the global options that take a value', () => {
    expect(subcommandOf('br', ['--db', '/x/beads.db', 'create'])).toBe(
      'create',
    );
    expect(subcommandOf('git', ['-C', '/repo', 'rev-parse', 'HEAD'])).toBe(
      'rev-parse',
    );
    expect(subcommandOf('bun', ['/p/src/cli.ts', 'thread', 'status'])).toBe(
      'cli.ts thread status',
    );
    expect(subcommandOf('bun', ['install', '--frozen-lockfile'])).toBe(
      'install --frozen-lockfile',
    );
  });

  test('overlapping spans count once', () => {
    expect(
      unionMs([
        {durationMs: 100, startMs: 0},
        {durationMs: 50, startMs: 50},
        {durationMs: 10, startMs: 200},
      ]),
    ).toBe(110);
  });
});

describe('the report', () => {
  test('with a spawn log: shares by command, and the unfinished spawn is named, not zeroed', async () => {
    const analysis = analyse(await parseJunit(JUNIT), parseSpawnLog(LOG), 10);
    const br = analysis.spawns?.byGroup.find((row) => row.label === 'br');
    expect(br).toMatchObject({calls: 2, meanMs: 100, totalMs: 200});
    const bun = analysis.spawns?.byGroup.find((row) => row.label === 'bun');
    expect(bun).toMatchObject({
      calls: 1,
      meanMs: null,
      totalMs: 0,
      unmeasured: 1,
    });
    expect(analysis.files[0]).toMatchObject({
      brCalls: 2,
      file: 'tests/a.test.ts',
      spawns: 4,
    });
    const text = renderReport(
      analysis,
      {console: null, meta: null, source: 'test'},
      PLAIN_STYLE,
    );
    expect(text).toContain('1 async spawns never reported an end');
    expect(text).toContain('1 unfinished');
  });

  test('without a spawn log: "No spawn log", and no share is printed as zero', async () => {
    const analysis = analyse(await parseJunit(JUNIT), null, 10);
    expect(analysis.spawns).toBeNull();
    const text = renderReport(
      analysis,
      {console: null, meta: null, source: 'test'},
      PLAIN_STYLE,
    );
    expect(text).toContain(
      'No spawn log: time by command is unknown, not zero.',
    );
    expect(text).not.toMatch(/\b0\.0%/u);
    expect(text).not.toContain('Inside each command');
  });
});

describe('the busy check', () => {
  test('a ps that cannot see pid 1 could not check; one that can lists other bun test runs', () => {
    expect(otherTestRuns('  4242 00:01 bun test\n', 999)).toEqual({
      kind: 'failed',
      reason:
        'ps cannot see pid 1, so it cannot see other sessions (is the sandbox on?)',
    });
    expect(otherTestRuns(null, 999).kind).toBe('failed');
    const ps = [
      '    1 09:00 /sbin/launchd',
      ' 4242 00:01 /opt/homebrew/bin/bun test --parallel=4',
      ' 4343 00:01 bun run test:timing run',
      ' 4444 00:01 caffeinate -i bun test',
      ' 4545 00:01 /usr/local/bin/claude --name x take timings when no other `bun test` or bun test is running',
      '  999 00:01 bun test',
    ].join('\n');
    expect(otherTestRuns(ps, 999)).toEqual({
      kind: 'checked',
      runs: ['4242 00:01 /opt/homebrew/bin/bun test --parallel=4'],
    });
  });
});

test('--help prints the usage and runs nothing', () => {
  const run = Bun.spawnSync(
    [
      process.execPath,
      join(import.meta.dir, '..', 'scripts', 'test-timing.ts'),
      '--help',
    ],
    {
      env: {...process.env, NO_COLOR: '1'},
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );
  expect(run.exitCode).toBe(0);
  const out = run.stdout.toString();
  expect(out).toContain(
    'test-timing — where the justin-sdk test suite spends its time',
  );
  expect(out).toContain(
    'report: prints the report from files already written. Runs nothing.',
  );
  expect(out).not.toContain('running the suite');
});
