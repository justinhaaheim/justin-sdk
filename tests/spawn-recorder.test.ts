/**
 * The subprocess recorder (tests/spawn-recorder.ts, home-base-ejsq2.1).
 *
 * What these tests hold it to:
 *  - A wrapped call returns the very value, and throws the very error, the
 *    unwrapped call does, and gets the same `this` and arguments.
 *  - It reads the call's options only after the real call returned, so a
 *    getter with side effects sees what it would see unwrapped.
 *  - Each call writes its record: one `call` for a sync spawn, a `start` and
 *    an `end` for an async one.
 *  - Every node:child_process form reaches exactly one of `Bun.spawn` and
 *    `Bun.spawnSync`, which is why wrapping those two covers the suite.
 *  - Unset, the preload's entry point changes nothing.
 */
import {afterAll, describe, expect, test} from 'bun:test';
import {
  exec,
  execFile,
  execFileSync,
  execSync,
  spawn,
  spawnSync,
} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {
  type CallRecord,
  installSpawnRecorder,
  installSpawnRecorderFromEnv,
  recorderState,
  SPAWN_LOG_ENV,
  type SpawnFunction,
  type SpawnHost,
  type SpawnLogRecord,
  type StartRecord,
  wrapSpawn,
  wrapSpawnSync,
} from './spawn-recorder';

const sandbox = mkdtempSync(join(tmpdir(), 'spawn-recorder-test-'));
afterAll(() => {
  rmSync(sandbox, {force: true, recursive: true});
});

const THIS_FILE = 'tests/spawn-recorder.test.ts';

/** The live Bun.spawnSync, typed as the recorder sees it. */
function bunSpawnSync(): SpawnFunction {
  return Bun.spawnSync as unknown as SpawnFunction;
}

/** The live Bun.spawn, typed as the recorder sees it. */
function bunSpawn(): SpawnFunction {
  return Bun.spawn as unknown as SpawnFunction;
}

function collector(): {
  records: SpawnLogRecord[];
  sink: (r: SpawnLogRecord) => void;
} {
  const records: SpawnLogRecord[] = [];
  return {records, sink: (record) => records.push(record)};
}

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

describe('a wrapped call is the unwrapped call', () => {
  test('same this, same arguments, the very value returned, and a record', () => {
    const value = {any: 'object'};
    const seen: {args: unknown[]; self: unknown}[] = [];
    const original = function (this: unknown, ...args: unknown[]): unknown {
      seen.push({args, self: this});
      return value;
    };
    const {records, sink} = collector();
    const wrapped = wrapSpawnSync(original, recorderState(sink));
    const self = {host: true};
    const options = {cwd: sandbox};
    const argv = ['git', 'status', '--short'];

    expect(wrapped.call(self, argv, options)).toBe(value);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.self).toBe(self);
    expect(seen[0]?.args[0]).toBe(argv);
    expect(seen[0]?.args[1]).toBe(options);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      api: 'spawnSync',
      argc: 3,
      args: ['status', '--short'],
      cmd: 'git',
      cwd: sandbox,
      file: THIS_FILE,
      fileFrom: 'stack',
      kind: 'call',
      mode: 'sync',
      outcome: 'returned',
      runningFile: THIS_FILE,
    });
  });

  test('with no test frame on the stack, the spawn is credited to the file bun test is running', async () => {
    const {records, sink} = collector();
    const wrapped = wrapSpawnSync(() => ({exitCode: 0}), recorderState(sink));
    // A bound function run as a microtask: nothing from this file is on the
    // stack when the wrapper looks.
    await Promise.resolve().then(wrapped.bind(null, ['true']));
    expect(records[0]).toMatchObject({
      cmd: 'true',
      file: THIS_FILE,
      fileFrom: 'running',
      runningFile: THIS_FILE,
    });
  });

  test('the very error thrown, and a record that says it threw', () => {
    const failure = new Error('spawn failed on purpose');
    const original = (): unknown => {
      throw failure;
    };
    const {records, sink} = collector();
    const wrapped = wrapSpawnSync(original, recorderState(sink));

    expect(thrownBy(() => wrapped(['br', 'list']))).toBe(failure);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      cmd: 'br',
      error: 'Error: spawn failed on purpose',
      exitCode: null,
      kind: 'call',
      outcome: 'threw',
    });
  });

  test('a real Bun.spawnSync: same exit code, stdout and stderr; duration measured', () => {
    const {records, sink} = collector();
    const wrapped = wrapSpawnSync(bunSpawnSync(), recorderState(sink));
    const argv = ['sh', '-c', 'printf out; printf err >&2; exit 3'];

    const plain = Bun.spawnSync(argv, {cwd: sandbox});
    const recorded = wrapped(argv, {cwd: sandbox}) as typeof plain;

    expect(recorded.exitCode).toBe(plain.exitCode);
    expect(recorded.success).toBe(plain.success);
    expect(recorded.stdout.toString()).toBe(plain.stdout.toString());
    expect(recorded.stderr.toString()).toBe(plain.stderr.toString());
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record).toMatchObject({
      args: ['-c', 'printf out; printf err >&2; exit 3'],
      cmd: 'sh',
      exitCode: 3,
      outcome: 'returned',
    });
    if (record?.kind !== 'call') throw new Error('expected a call record');
    expect(record.durationMs).toBeGreaterThan(0);
    expect(record.resolved).toEndWith('/sh');
  });

  test('a real Bun.spawnSync of a missing program: the same error', () => {
    const {records, sink} = collector();
    const wrapped = wrapSpawnSync(bunSpawnSync(), recorderState(sink));
    const argv = [join(sandbox, 'no-such-program')];

    const plain = thrownBy(() => Bun.spawnSync(argv)) as NodeJS.ErrnoException;
    const recorded = thrownBy(() => wrapped(argv)) as NodeJS.ErrnoException;

    expect(recorded.constructor).toBe(plain.constructor);
    expect(recorded.message).toBe(plain.message);
    expect(recorded.code).toBe(plain.code);
    expect(records[0]).toMatchObject({kind: 'call', outcome: 'threw'});
  });

  test('a real Bun.spawn: the same exit code and output; a start, then an end', async () => {
    const {records, sink} = collector();
    const wrapped = wrapSpawn(bunSpawn(), recorderState(sink));
    const argv = ['sh', '-c', 'printf async-out; exit 4'];

    const plain = Bun.spawn(argv, {stdout: 'pipe'});
    const recorded = wrapped(argv, {stdout: 'pipe'}) as typeof plain;

    expect(await recorded.exited).toBe(await plain.exited);
    expect(await new Response(recorded.stdout).text()).toBe(
      await new Response(plain.stdout).text(),
    );
    // The end record is written by a handler on `exited`; let it run.
    await Bun.sleep(0);
    expect(records.map((record) => record.kind)).toEqual(['start', 'end']);
    const [start, end] = records;
    expect(start).toMatchObject({cmd: 'sh', file: THIS_FILE, mode: 'async'});
    expect(end).toMatchObject({exitCode: 4, outcome: 'exited'});
    if (start?.kind !== 'start' || end?.kind !== 'end') {
      throw new Error('expected a start record, then an end record');
    }
    expect(end.id).toBe(start.id);
    expect(end.durationMs).toBeGreaterThan(0);
  });

  test('a real Bun.spawn of a missing program: the same error, recorded as threw', () => {
    const {records, sink} = collector();
    const wrapped = wrapSpawn(bunSpawn(), recorderState(sink));
    const argv = [join(sandbox, 'no-such-program')];

    const plain = thrownBy(() => Bun.spawn(argv)) as NodeJS.ErrnoException;
    const recorded = thrownBy(() => wrapped(argv)) as NodeJS.ErrnoException;

    expect(recorded.message).toBe(plain.message);
    expect(recorded.code).toBe(plain.code);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: 'call',
      mode: 'async',
      outcome: 'threw',
    });
  });

  test('the options are read only after the real call (a getter that throws on its first read)', () => {
    const throwsOnFirstRead = (): {cmd: string[]} => {
      let reads = 0;
      return {
        get cmd(): string[] {
          reads += 1;
          if (reads === 1) throw new Error('first read');
          return ['true'];
        },
      };
    };
    const {records, sink} = collector();
    const wrapped = wrapSpawnSync(bunSpawnSync(), recorderState(sink));

    // Unwrapped, Bun's own read is the first one, so the spawn throws.
    const plain = thrownBy(() => Bun.spawnSync(throwsOnFirstRead()));
    const recorded = thrownBy(() => wrapped(throwsOnFirstRead()));
    expect((recorded as Error).message).toBe((plain as Error).message);
    expect(records[0]).toMatchObject({cmd: 'true', outcome: 'threw'});
  });
});

describe('coverage: every node:child_process form reaches Bun.spawn or Bun.spawnSync once', () => {
  test('sync and async forms, each recorded once, each with the form that started it', async () => {
    const {records, sink} = collector();
    const restore = installSpawnRecorder(Bun as unknown as SpawnHost, sink);
    try {
      spawnSync('true');
      execSync('true');
      execFileSync('true');
      await new Promise((done) => spawn('true').on('close', done));
      await new Promise((done) => exec('true', done));
      await new Promise((done) => execFile('true', done));
    } finally {
      restore();
    }
    await Bun.sleep(0);
    const begun = records.filter(
      (record): record is CallRecord | StartRecord =>
        record.kind === 'call' || record.kind === 'start',
    );
    expect(begun.map((record) => [record.kind, record.api])).toEqual([
      ['call', 'spawnSync'],
      ['call', 'spawnSync'],
      ['call', 'spawnSync'],
      ['start', 'spawn'],
      ['start', 'spawn'],
      ['start', 'spawn'],
    ]);
    // execSync and exec go through a shell; the rest start `true` itself.
    expect(begun.map((record) => record.cmd)).toEqual([
      'true',
      'sh',
      'true',
      'true',
      'sh',
      'true',
    ]);
    expect(begun.map((record) => record.via)).toEqual([
      'spawnSync',
      'execSync',
      'execFileSync',
      'spawn',
      'execFile',
      'execFile',
    ]);
  });
});

describe('the preload entry point', () => {
  test('unset: returns null, and neither the environment nor Bun changes', () => {
    const env: Record<string, string | undefined> = {OTHER: 'x'};
    const spawnBefore = Bun.spawn;
    const spawnSyncBefore = Bun.spawnSync;

    expect(installSpawnRecorderFromEnv(env)).toBeNull();
    expect(installSpawnRecorderFromEnv({[SPAWN_LOG_ENV]: ''})).toBeNull();
    expect(env).toEqual({OTHER: 'x'});
    expect(Bun.spawn).toBe(spawnBefore);
    expect(Bun.spawnSync).toBe(spawnSyncBefore);
  });

  test('set: the variable leaves the environment, a session record is written, and the restore puts Bun back', () => {
    const logPath = join(sandbox, 'spawns.jsonl');
    const env: Record<string, string | undefined> = {[SPAWN_LOG_ENV]: logPath};
    const spawnBefore = Bun.spawn;
    const spawnSyncBefore = Bun.spawnSync;

    const restore = installSpawnRecorderFromEnv(env);
    try {
      expect(restore).not.toBeNull();
      expect(env).toEqual({});
      expect(Bun.spawnSync).not.toBe(spawnSyncBefore);
      Bun.spawnSync(['true']);
    } finally {
      restore?.();
    }
    expect(Bun.spawn).toBe(spawnBefore);
    expect(Bun.spawnSync).toBe(spawnSyncBefore);

    const lines = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as SpawnLogRecord);
    expect(lines.map((line) => line.kind)).toEqual(['session', 'call']);
    expect(lines[1]).toMatchObject({cmd: 'true', file: THIS_FILE});
  });
});
