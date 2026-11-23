/**
 * The parallel runner's watchdog (scripts/test-parallel.ts) and the
 * current-test marker it reads (tests/test-marker.ts), home-base-ejsq2.4.
 *
 * What these tests hold them to:
 *  - Off, the marker's preload entry point changes nothing: it returns null,
 *    leaves the environment alone and never loads bun:test.
 *  - A wrapped test function runs with the same `this` and arguments,
 *    returns the very value and throws the very error the unwrapped one
 *    does, and has its `length` (bun reads it to spot a `done` callback).
 *  - On the real bun:test (a fixture suite in a child `bun test`), the
 *    records name each test with its describe path and `each` row, and
 *    every test still passes, `done` style included.
 *  - The watchdog reads "in a test" only from a start or body with no end
 *    after it, never an earlier test's name; a bad line is counted.
 *  - The process tree holds every descendant and every member of the run's
 *    process group, and never the watchdog itself.
 * The end-to-end proof that a spinning worker is stopped, named, sampled and
 * killed is `bun run test:parallel:negative-control`: it needs a watchdog
 * run of its own, so it is not part of this suite.
 */
import {afterAll, describe, expect, test} from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {
  createMarkerReader,
  describeProcess,
  describeStall,
  parsePsRows,
  processState,
  processTree,
  stallClockStartMs,
  stalledTests,
  stallPollMs,
} from '../scripts/test-parallel';
import {recordGaps} from '../scripts/test-stall-evidence';
import {
  installTestMarkerFromEnv,
  type MarkerHost,
  type MarkerRecord,
  TEST_MARKER_ENV,
  wrapTestFunction,
} from './test-marker';

const sandbox = mkdtempSync(join(tmpdir(), 'test-parallel-test-'));
afterAll(() => {
  rmSync(sandbox, {force: true, recursive: true});
});

describe('the marker, off', () => {
  test('unset or empty: returns null, the environment is untouched, and bun:test is never loaded', () => {
    let loads = 0;
    const load = (): MarkerHost => {
      loads += 1;
      throw new Error('must not load bun:test');
    };
    const env: Record<string, string | undefined> = {OTHER: 'x'};
    expect(installTestMarkerFromEnv(env, load)).toBeNull();
    expect(installTestMarkerFromEnv({[TEST_MARKER_ENV]: ''}, load)).toBeNull();
    expect(env).toEqual({OTHER: 'x'});
    expect(loads).toBe(0);
  });
});

describe('a wrapped test function is the test function', () => {
  test('same this and arguments, the very value returned, the hook first', () => {
    const order: string[] = [];
    const value = {the: 'value'};
    const self = {me: true};
    const seen: {args: unknown[]; self: unknown}[] = [];
    const fn = function (this: unknown, ...args: unknown[]): unknown {
      order.push('body');
      seen.push({args, self: this});
      return value;
    };
    const wrapped = wrapTestFunction(fn, (args) => {
      order.push(`hook ${JSON.stringify(args)}`);
    });
    expect(wrapped.call(self, 1, 'two')).toBe(value);
    expect(seen).toEqual([{args: [1, 'two'], self}]);
    expect(order).toEqual(['hook [1,"two"]', 'body']);
  });

  test('the very error thrown', () => {
    const error = new Error('mine');
    const wrapped = wrapTestFunction(
      () => {
        throw error;
      },
      () => undefined,
    );
    let caught: unknown = null;
    try {
      wrapped();
    } catch (thrown) {
      caught = thrown;
    }
    expect(caught).toBe(error);
  });

  test('the same length, so bun still tells a done callback from a promise', () => {
    const none = (): void => undefined;
    const one = (_done: unknown): void => undefined;
    const two = (_a: unknown, _b: unknown): void => undefined;
    expect(wrapTestFunction(none, () => undefined).length).toBe(0);
    expect(wrapTestFunction(one as never, () => undefined).length).toBe(1);
    expect(wrapTestFunction(two as never, () => undefined).length).toBe(2);
  });
});

const FIXTURE_TEST = `import {describe, expect, it, test} from 'bun:test';

describe('outer', () => {
  describe('inner', () => {
    it('nested', () => {
      expect(1).toBe(1);
    });
  });
});

test('done style', (done) => {
  setTimeout(() => {
    done();
  }, 5);
});

test.each([1, 2])('each %p', (n) => {
  expect(n).toBeGreaterThan(0);
});

test.skipIf(false)('skipIf false runs', () => {
  expect(true).toBe(true);
});

test('the variable is gone from the environment', () => {
  expect(process.env.${TEST_MARKER_ENV}).toBeUndefined();
});
`;

/** A fixture suite using this package's preload, run in a child bun test. */
function runFixture(markerDir: string | null): {
  exitCode: number | null;
  output: string;
} {
  const fixture = mkdtempSync(join(sandbox, 'suite-'));
  writeFileSync(
    join(fixture, 'bunfig.toml'),
    `[test]\npreload = [${JSON.stringify(join(import.meta.dir, 'preload-test-env.ts'))}]\n`,
  );
  writeFileSync(join(fixture, 'fixture.test.ts'), FIXTURE_TEST);
  const env: Record<string, string | undefined> = {...process.env};
  if (markerDir == null) delete env[TEST_MARKER_ENV];
  else env[TEST_MARKER_ENV] = markerDir;
  const result = Bun.spawnSync([process.execPath, 'test'], {
    cwd: fixture,
    env,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  return {
    exitCode: result.exitCode,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
}

describe('on the real bun:test', () => {
  test('the records name each test, with its describe path and each row, and every test passes', () => {
    const markerDir = join(sandbox, 'markers');
    const {exitCode, output} = runFixture(markerDir);
    expect(output).toContain(' 0 fail');
    expect(exitCode).toBe(0);
    const files = readdirSync(markerDir);
    expect(files).toHaveLength(1);
    const records = readFileSync(join(markerDir, files[0] ?? ''), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as MarkerRecord);
    const names = records.flatMap((record) =>
      record.kind === 'body' ? [record.name] : [],
    );
    expect(names).toEqual([
      'outer > inner > nested',
      'done style',
      'each %p [1]',
      'each %p [2]',
      'skipIf false runs',
      'the variable is gone from the environment',
    ]);
    expect(records.filter((record) => record.kind === 'start')).toHaveLength(6);
    expect(records.filter((record) => record.kind === 'end')).toHaveLength(6);
  });

  test('off: the same suite passes and no marker is written', () => {
    const markerDir = join(sandbox, 'never');
    const {exitCode, output} = runFixture(null);
    expect(output).toContain(' 0 fail');
    expect(exitCode).toBe(0);
    expect(existsSync(markerDir)).toBe(false);
  });
});

describe('reading the marker', () => {
  const base = {atMs: 1000, file: '/repo/tests/a.test.ts', pid: 7};
  const lines = (records: object[]): string =>
    records.map((record) => JSON.stringify(record)).join('\n');

  test('a body with no end: in that test, by name', () => {
    const state = processState(
      7,
      lines([
        {...base, kind: 'file', v: 1},
        {...base, kind: 'start', seq: 1},
        {...base, kind: 'body', name: 'outer > first', seq: 1},
        {...base, kind: 'end', seq: 1},
        {...base, kind: 'start', seq: 2},
        {...base, kind: 'body', name: 'outer > spins', seq: 2},
      ]),
    );
    expect(state.where).toBe('in-test');
    expect(state.name).toBe('outer > spins');
    expect(describeProcess(state, {cwd: '/repo', nowMs: 61_000})).toBe(
      'in "outer > spins" (tests/a.test.ts) for 60 s',
    );
  });

  test("a start with no body after it: in a test whose name is not known, never the previous test's name", () => {
    const state = processState(
      7,
      lines([
        {...base, kind: 'start', seq: 1},
        {...base, kind: 'body', name: 'first', seq: 1},
        {...base, kind: 'end', seq: 1},
        {...base, kind: 'start', seq: 2},
      ]),
    );
    expect(state.where).toBe('in-test');
    expect(state.name).toBeNull();
    expect(describeProcess(state, {cwd: '/repo', nowMs: 1000})).toContain(
      'in test #2 of tests/a.test.ts, name not recorded',
    );
  });

  test('an end last: between tests; a bad line is counted', () => {
    const state = processState(
      7,
      `${lines([{...base, kind: 'start', seq: 1}])}\nnot json\n${lines([{...base, kind: 'end', seq: 1}])}\n`,
    );
    expect(state.where).toBe('between-tests');
    expect(state.name).toBeNull();
    expect(state.unreadable).toBe(1);
  });

  test('a file record last: loading that file', () => {
    expect(processState(7, lines([{...base, kind: 'file', v: 1}])).where).toBe(
      'loading-file',
    );
  });

  test('no records: says so', () => {
    expect(processState(7, '').where).toBe('no-record');
  });
});

describe('the stall decision (home-base-ejsq2.6, ejsq2.8)', () => {
  const at = (atMs: number, rest: object): string =>
    JSON.stringify({atMs, file: '/repo/tests/a.test.ts', pid: 0, ...rest});
  /** A process whose test started at `startMs` and whose body began at `bodyMs`. */
  const inTest = (pid: number, startMs: number, bodyMs: number) =>
    processState(
      pid,
      [
        at(0, {kind: 'file', v: 1}),
        at(startMs, {kind: 'start', seq: 1}),
        at(bodyMs, {kind: 'body', name: `test of ${pid}`, seq: 1}),
      ].join('\n'),
    );
  const STALL_MS = 180_000;

  test('a live worker inside one test for the stall limit is stalled, timed from its start record, not its body', () => {
    // Started at 1 s, body at 100 s (slow beforeEach): at 181 s it has been in
    // the test 180 s, though its body began only 81 s ago.
    const state = inTest(11, 1000, 100_000);
    expect(state.testStartedAtMs).toBe(1000);
    const stalls = stalledTests([state], {
      alive: new Set([11]),
      nowMs: 181_000,
      stallMs: STALL_MS,
    });
    expect(
      stalls.map((stall) => [stall.pid, stall.name, stall.seconds]),
    ).toEqual([[11, 'test of 11', 180]]);
  });

  test('a millisecond under the limit: not stalled', () => {
    expect(
      stalledTests([inTest(11, 1000, 1000)], {
        alive: new Set([11]),
        nowMs: 180_999,
        stallMs: STALL_MS,
      }),
    ).toEqual([]);
  });

  /** A worker whose last record is the end of a test, at `endMs`. */
  const between = (pid: number, endMs: number) =>
    processState(
      pid,
      [at(0, {kind: 'start', seq: 1}), at(endMs, {kind: 'end', seq: 1})].join(
        '\n',
      ),
    );
  /** A worker whose last record is a file's, at `fileMs` (its load or beforeAll). */
  const loading = (pid: number, fileMs: number) =>
    processState(pid, at(fileMs, {kind: 'file', v: 1}));

  test('a live worker with no marker record for the limit is stalled in any state, timed from its last record (ejsq2.8)', () => {
    // Between tests since 1 s (an afterAll, or the next file's preload, spins)
    // and loading a file since 2 s (its beforeAll spins): at 181 s and 182 s
    // each has written nothing for 180 s.
    const stalls = stalledTests([between(12, 1000), loading(13, 2000)], {
      alive: new Set([12, 13]),
      nowMs: 182_000,
      stallMs: STALL_MS,
    });
    expect(
      stalls.map((stall) => [stall.pid, stall.where, stall.seconds]),
    ).toEqual([
      [12, 'between-tests', 181],
      [13, 'loading-file', 180],
    ]);
    expect(stalls.map(describeStall)).toEqual([
      "stalled: pid 12, no marker record for 181 s, after a test (afterEach, afterAll, or the next file's preload)",
      'stalled: pid 13, no marker record for 180 s, loading a file or in its beforeAll',
    ]);
  });

  test('idle under the limit, in any state: not stalled', () => {
    expect(
      stalledTests(
        [between(12, 1000), loading(13, 1000), inTest(11, 1000, 1000)],
        {
          alive: new Set([11, 12, 13]),
          nowMs: 180_999,
          stallMs: STALL_MS,
        },
      ),
    ).toEqual([]);
  });

  test('no record: no clock, so never stalled, however long (the wall limit still stands)', () => {
    const silent = processState(14, '');
    expect(silent.where).toBe('no-record');
    expect(stallClockStartMs(silent)).toBeNull();
    expect(
      stalledTests([silent], {
        alive: new Set([14]),
        nowMs: 10 * STALL_MS,
        stallMs: STALL_MS,
      }),
    ).toEqual([]);
  });

  test('a worker that is not alive (it died, or bun ended it with no file left) is not stalled, in any state', () => {
    expect(
      stalledTests([inTest(15, 0, 0), between(16, 0), loading(17, 0)], {
        alive: new Set([99]),
        nowMs: 10 * STALL_MS,
        stallMs: STALL_MS,
      }),
    ).toEqual([]);
  });

  test('the tree could not be read: nothing is called stalled (the wall limit still stands)', () => {
    expect(
      stalledTests([inTest(16, 0, 0)], {
        alive: null,
        nowMs: 10 * STALL_MS,
        stallMs: STALL_MS,
      }),
    ).toEqual([]);
  });

  test('a new test resets the clock; an end clears the test clock and restarts the clock from itself', () => {
    const state = processState(
      17,
      [
        at(0, {kind: 'start', seq: 1}),
        at(5, {kind: 'end', seq: 1}),
        at(200_000, {kind: 'start', seq: 2}),
      ].join('\n'),
    );
    expect(state.testStartedAtMs).toBe(200_000);
    expect(stallClockStartMs(state)).toBe(200_000);
    const ended = processState(
      17,
      [at(0, {kind: 'start', seq: 1}), at(5, {kind: 'end', seq: 1})].join('\n'),
    );
    expect(ended.testStartedAtMs).toBeNull();
    expect(stallClockStartMs(ended)).toBe(5);
  });

  test('the evidence behind the default: every gap between records, labelled, with the head and tail against the run', () => {
    const text = [
      at(1000, {kind: 'file', v: 1}),
      at(1500, {kind: 'start', seq: 1}),
      at(1600, {kind: 'body', name: 't', seq: 1}),
      at(4600, {kind: 'end', seq: 1}),
      'not json',
    ].join('\n');
    const result = recordGaps(text, {endedAtMs: 10_000, startedAtMs: 900});
    expect(result.unreadable).toBe(1);
    expect(result.gaps.map((gap) => [gap.kind, gap.ms])).toEqual([
      ['run start→file', 100],
      ['file→start', 500],
      ['start→body', 100],
      ['body→end', 3000],
      ['end→run end', 5400],
    ]);
    // Without the run's times there is no head and no tail, never a made-up one.
    expect(recordGaps(text).gaps.map((gap) => gap.kind)).toEqual([
      'file→start',
      'start→body',
      'body→end',
    ]);
  });

  test('the poll is a quarter of the limit, between 0.25 s and 5 s', () => {
    expect([stallPollMs(180_000), stallPollMs(4000), stallPollMs(100)]).toEqual(
      [5000, 1000, 250],
    );
  });
});

describe('the incremental marker reader', () => {
  test('reads only what was appended, and never a half-written line', () => {
    const dir = mkdtempSync(join(sandbox, 'reader-'));
    const path = join(dir, '42.jsonl');
    const line = (rest: object): string =>
      `${JSON.stringify({atMs: 1, file: '/repo/tests/a.test.ts', pid: 42, ...rest})}\n`;
    const read = createMarkerReader(dir);
    expect(read()).toEqual([]);
    writeFileSync(path, line({kind: 'file', v: 1}));
    expect(read()?.[0]?.where).toBe('loading-file');
    const start = line({kind: 'start', seq: 1});
    // Half of the start line: the state must not move yet, and nothing is unreadable.
    writeFileSync(path, `${line({kind: 'file', v: 1})}${start.slice(0, 20)}`);
    expect(read()?.[0]).toMatchObject({unreadable: 0, where: 'loading-file'});
    writeFileSync(
      path,
      `${line({kind: 'file', v: 1})}${start}${line({kind: 'body', name: 'é wide name', seq: 1})}`,
    );
    expect(read()?.[0]).toMatchObject({
      name: 'é wide name',
      testStartedAtMs: 1,
      unreadable: 0,
      where: 'in-test',
    });
    expect(createMarkerReader(join(dir, 'missing'))()).toBeNull();
  });
});

describe('the process tree', () => {
  const ps = [
    '    1     0     1 Ss   /sbin/launchd',
    '  100     1   100 S    bun scripts/test-parallel.ts',
    '  200   100   200 S    caffeinate -i bun test --parallel=4',
    '  201   200   200 S    bun test --parallel=4',
    '  202   201   200 R    bun test --test-worker',
    '  203   202   200 S    br create x',
    '  204     1   200 S    orphan reparented, same group',
    '  205   202   205 S    a child that set its own session',
    '  300     1   300 S    unrelated',
  ].join('\n');

  test('ps rows parse, with the state column', () => {
    const rows = parsePsRows(ps);
    expect(rows).toHaveLength(9);
    expect(rows[4]).toEqual({
      args: 'bun test --test-worker',
      pgid: 200,
      pid: 202,
      ppid: 201,
      stat: 'R',
    });
  });

  test('every descendant and every group member, never an unrelated process', () => {
    expect(processTree(parsePsRows(ps), 200, 200, 100)).toEqual([
      200, 201, 202, 203, 204, 205,
    ]);
  });

  test('the watchdog itself is never in the tree', () => {
    expect(processTree(parsePsRows(ps), 100, 100, 100)).toEqual([]);
  });
});
