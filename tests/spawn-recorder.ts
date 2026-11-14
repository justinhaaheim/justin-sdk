/**
 * The test suite's subprocess recorder (home-base-ejsq2.1): where do the
 * justin-sdk tests spend their time, process by process?
 *
 * OFF BY DEFAULT. `tests/preload-test-env.ts` calls `installSpawnRecorderFromEnv`,
 * which does nothing unless `JUSTIN_SDK_TEST_SPAWN_LOG` names a jsonl file.
 * When it does, the variable is removed from `process.env` (so no test and no
 * child process sees it: the environment a test observes is the unset one)
 * and every subprocess the test process starts appends records to that file.
 * `scripts/test-timing.ts` reads the file beside bun's junit report.
 *
 * HOW IT SEES EVERY SPAWN. In Bun, node:child_process runs on `Bun.spawn` and
 * `Bun.spawnSync`, read off the global `Bun` object at call time (measured
 * 2026-11-14 on Bun 1.4.2: spawn, spawnSync, exec, execFile, execSync and
 * execFileSync each reached exactly one of the two; src/thread/inbox-timings.ts
 * measured the same on 2026-11-07). So wrapping those two properties covers
 * every form the suite uses, with no double count. Patching the
 * node:child_process exports instead does NOT reach a module that already did
 * `import {spawnSync} from 'child_process'` (measured the same day), which is
 * every caller here. `tests/spawn-recorder.test.ts` keeps both claims honest.
 * `Bun.$` is not wrapped: nothing in src/, tests/ or scripts/ uses it.
 *
 * WHAT IS NOT SEEN. Processes started by a child process (the SDK CLI run as
 * `bun src/cli.ts …` spawns br and git of its own) run without this preload.
 * Their time is inside the parent `bun` record's duration, not split out.
 *
 * THE CONTRACT (bead home-base-ejsq2.1):
 *  - The wrapped call gets the same arguments and `this`, and the caller gets
 *    the same return value or the same thrown error. Everything the recorder
 *    reads, it reads AFTER the real call returned: a getter on the options
 *    (tests/thread-inbox-timings.test.ts F3 has one that throws on its first
 *    read) sees the reads it would see unwrapped.
 *  - Recording never throws into the caller. A record that cannot be written
 *    is counted and reported once on fd 2.
 *  - Failure is not empty (critical rule 7): a spawn whose end was never seen
 *    has a `start` record and no `end` record, and the report says
 *    "unfinished"; it is never written as 0 ms.
 */
import {appendFileSync, writeSync} from 'node:fs';
import {basename, isAbsolute, join, relative, resolve} from 'node:path';

/** The variable that turns the recorder on: a jsonl path. */
export const SPAWN_LOG_ENV = 'JUSTIN_SDK_TEST_SPAWN_LOG';

/** Bumped when a record's shape changes; the report refuses others. */
export const SPAWN_LOG_VERSION = 2;

/** Arguments kept after argv[0]; the rest are counted in `argc` only. */
const KEPT_ARGS = 4;
/** Characters kept of each argument (an `sh -c` script can be long). */
const ARG_CHARS = 300;
/** Stack frames captured when looking for the test file. */
const STACK_FRAMES = 80;

/** This package's root: tests/ → justin-sdk/. Test files are named from it. */
const PACKAGE_ROOT = resolve(import.meta.dir, '..');

export type SpawnFunction = (...args: unknown[]) => unknown;

/** What the recorder wraps: the global `Bun`, or a stand-in in a unit test. */
export interface SpawnHost {
  spawn: SpawnFunction;
  spawnSync: SpawnFunction;
}

/**
 * How a spawn's test file was established: a test file on its stack, or
 * else the file bun test was running (`Bun.main`, which bun test sets to the
 * current test file, imports included; measured 2026-11-14 on Bun 1.4.2).
 * About 60% of the suite's spawns have no test frame on their stack (deep
 * async chains), so the running file is the common case.
 */
type FileFrom = 'running' | 'stack';

/** What every spawn record says about the call, read after it returned. */
export interface SpawnFacts {
  /** The Bun function that started the process. */
  api: 'spawn' | 'spawnSync';
  /** The full argument count including argv[0]; null when argv was unreadable. */
  argc: number | null;
  /** Arguments after argv[0], at most KEPT_ARGS, each cut at ARG_CHARS. */
  args: string[];
  /** argv[0]'s file name; null when argv was unreadable. */
  cmd: string | null;
  /** The directory the process started in. */
  cwd: string | null;
  /** The test file, relative to the package root; null when none was found. */
  file: string | null;
  fileFrom: FileFrom | null;
  /** Per-process sequence number; pairs a `start` with its `end`. */
  id: number;
  mode: 'async' | 'sync';
  /** The test runner's pid (several with `bun test --parallel`). */
  pid: number;
  /** Why argv or the options could not be read, when they could not. */
  readError: string | null;
  /** argv[0] resolved on the PATH the process got; null when not found. */
  resolved: string | null;
  /**
   * The test file bun test was running when the spawn started. It differs
   * from `file` when work an earlier file left running (a timer, a callback)
   * started the process.
   */
  runningFile: string | null;
  /** When the call started, epoch ms (fractional). */
  startMs: number;
  /** The node:child_process function on the stack, when one started it. */
  via: string | null;
}

/** A synchronous spawn, or a spawn call that threw before a process existed. */
export interface CallRecord extends SpawnFacts {
  durationMs: number;
  error: string | null;
  exitCode: number | null;
  kind: 'call';
  outcome: 'returned' | 'threw';
}

/** An asynchronous spawn whose process started; its `end` follows. */
export interface StartRecord extends SpawnFacts {
  kind: 'start';
}

/** The end of an asynchronous spawn: `exited` settled. */
export interface EndRecord {
  durationMs: number;
  exitCode: number | null;
  id: number;
  kind: 'end';
  outcome: 'exit-rejected' | 'exited';
  pid: number;
}

/** One per test process, first: which process wrote the lines after it. */
export interface SessionRecord {
  bun: string;
  cwd: string;
  kind: 'session';
  pid: number;
  startMs: number;
  v: number;
}

export type SpawnLogRecord =
  | CallRecord
  | EndRecord
  | SessionRecord
  | StartRecord;

export type RecordSink = (record: SpawnLogRecord) => void;

/** The state one installed recorder keeps between calls. */
export interface RecorderState {
  nextId: number;
  sink: RecordSink;
}

function errorText(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object';
}

function epochMs(performanceNow: number): number {
  return performance.timeOrigin + performanceNow;
}

const TEST_FILE = /\.test\.[cm]?[jt]sx?$/u;

/** A test file's name relative to the package root; null when not a test file. */
function testFileName(path: string): string | null {
  if (!TEST_FILE.test(path)) return null;
  return isAbsolute(path) ? relative(PACKAGE_ROOT, path) : path;
}

/**
 * Where the stack says this spawn came from: the nearest test file, and the
 * node:child_process function the caller used (the outermost such frame:
 * `execFileSync` rather than the `spawnSync` it calls).
 */
function callSite(): {file: string | null; via: string | null} {
  const holder: {stack?: string} = {};
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = STACK_FRAMES;
  try {
    Error.captureStackTrace(holder);
  } finally {
    Error.stackTraceLimit = limit;
  }
  let file: string | null = null;
  let via: string | null = null;
  for (const line of (holder.stack ?? '').split('\n')) {
    const frame = /^\s*at (?:(.*?) \()?(.*?):\d+:\d+\)?$/u.exec(line);
    if (frame == null) continue;
    const name = frame[1] ?? null;
    const location = frame[2] ?? '';
    if (location === 'node:child_process') {
      via = name;
      continue;
    }
    file = testFileName(location);
    if (file != null) break;
  }
  return {file, via};
}

/** argv and the options object of a Bun.spawn / Bun.spawnSync call. */
function spawnShape(args: readonly unknown[]): {
  argv: unknown[] | null;
  options: Record<string, unknown> | null;
} {
  const first = args[0];
  if (Array.isArray(first)) {
    const second = args[1];
    return {argv: first, options: isRecord(second) ? second : null};
  }
  if (isRecord(first)) {
    const cmd = first.cmd;
    return {argv: Array.isArray(cmd) ? cmd : null, options: first};
  }
  return {argv: null, options: null};
}

function keptArg(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value);
  return text.length > ARG_CHARS ? `${text.slice(0, ARG_CHARS)}…` : text;
}

/** argv[0] on the PATH the child got, the way the spawn resolved it. */
function resolveProgram(
  program: string,
  options: Record<string, unknown> | null,
  cwd: string,
): string | null {
  const env = options?.env;
  const path =
    isRecord(env) && typeof env.PATH === 'string' ? env.PATH : process.env.PATH;
  if (program.includes('/')) {
    return isAbsolute(program) ? program : join(cwd, program);
  }
  return Bun.which(program, {PATH: path ?? '', cwd});
}

/** Everything a record says about the call. Never throws. */
function describeCall(
  state: RecorderState,
  call: {
    api: SpawnFacts['api'];
    args: readonly unknown[];
    mode: SpawnFacts['mode'];
    startMs: number;
  },
): SpawnFacts {
  const facts: SpawnFacts = {
    api: call.api,
    argc: null,
    args: [],
    cmd: null,
    cwd: null,
    file: null,
    fileFrom: null,
    id: state.nextId,
    mode: call.mode,
    pid: process.pid,
    readError: null,
    resolved: null,
    runningFile: null,
    startMs: call.startMs,
    via: null,
  };
  state.nextId += 1;
  try {
    facts.runningFile = testFileName(Bun.main);
    const site = callSite();
    facts.via = site.via;
    if (site.file != null) {
      facts.file = site.file;
      facts.fileFrom = 'stack';
    } else if (facts.runningFile != null) {
      facts.file = facts.runningFile;
      facts.fileFrom = 'running';
    }
  } catch (error) {
    facts.readError = `stack: ${errorText(error)}`;
  }
  try {
    const {argv, options} = spawnShape(call.args);
    const cwdOption = options?.cwd;
    const cwd = typeof cwdOption === 'string' ? cwdOption : process.cwd();
    facts.cwd = cwd;
    if (argv == null) {
      facts.readError ??= 'argv: no command array in the arguments';
      return facts;
    }
    facts.argc = argv.length;
    const program = argv[0];
    facts.args = argv.slice(1, 1 + KEPT_ARGS).map(keptArg);
    if (typeof program === 'string' && program !== '') {
      facts.cmd = basename(program);
      facts.resolved = resolveProgram(program, options, cwd);
    } else {
      facts.readError ??= 'argv: argv[0] is not a string';
    }
  } catch (error) {
    facts.readError ??= `argv: ${errorText(error)}`;
  }
  return facts;
}

function exitCodeOf(result: unknown): number | null {
  if (!isRecord(result)) return null;
  const code = result.exitCode;
  return typeof code === 'number' ? code : null;
}

function safely(state: RecorderState, record: () => SpawnLogRecord): void {
  try {
    state.sink(record());
  } catch {
    // The sink reports its own failures; describing a call never throws.
    // Nothing here may reach the caller of the spawn.
  }
}

/** `Bun.spawnSync`, wrapped: one `call` record per call. */
export function wrapSpawnSync(
  original: SpawnFunction,
  state: RecorderState,
): SpawnFunction {
  return function recordedSpawnSync(this: unknown, ...args: unknown[]) {
    const started = performance.now();
    let result: unknown;
    try {
      result = original.apply(this, args);
    } catch (error) {
      const durationMs = performance.now() - started;
      safely(state, () => ({
        ...describeCall(state, {
          api: 'spawnSync',
          args,
          mode: 'sync',
          startMs: epochMs(started),
        }),
        durationMs,
        error: errorText(error),
        exitCode: null,
        kind: 'call',
        outcome: 'threw',
      }));
      throw error;
    }
    const durationMs = performance.now() - started;
    safely(state, () => ({
      ...describeCall(state, {
        api: 'spawnSync',
        args,
        mode: 'sync',
        startMs: epochMs(started),
      }),
      durationMs,
      error: null,
      exitCode: exitCodeOf(result),
      kind: 'call',
      outcome: 'returned',
    }));
    return result;
  };
}

/**
 * `Bun.spawn`, wrapped: a `start` record when the process started and an
 * `end` record when its `exited` promise settles. Both handlers on `exited`
 * only record, so they add no rejection of their own. One residual, accepted:
 * a handler marks `exited` as handled, so a rejected `exited` that a test
 * never awaited would no longer be an unhandled rejection. Bun resolves
 * `exited` with the exit code, signal deaths included; no rejection of it has
 * been seen.
 */
export function wrapSpawn(
  original: SpawnFunction,
  state: RecorderState,
): SpawnFunction {
  return function recordedSpawn(this: unknown, ...args: unknown[]) {
    const started = performance.now();
    let child: unknown;
    try {
      child = original.apply(this, args);
    } catch (error) {
      const durationMs = performance.now() - started;
      safely(state, () => ({
        ...describeCall(state, {
          api: 'spawn',
          args,
          mode: 'async',
          startMs: epochMs(started),
        }),
        durationMs,
        error: errorText(error),
        exitCode: null,
        kind: 'call',
        outcome: 'threw',
      }));
      throw error;
    }
    const facts = describeCall(state, {
      api: 'spawn',
      args,
      mode: 'async',
      startMs: epochMs(started),
    });
    safely(state, () => ({...facts, kind: 'start'}));
    try {
      const exited = isRecord(child) ? child.exited : null;
      if (exited instanceof Promise) {
        void exited.then(
          (code: unknown) => {
            safely(state, () => ({
              durationMs: performance.now() - started,
              exitCode: typeof code === 'number' ? code : null,
              id: facts.id,
              kind: 'end',
              outcome: 'exited',
              pid: process.pid,
            }));
          },
          () => {
            safely(state, () => ({
              durationMs: performance.now() - started,
              exitCode: null,
              id: facts.id,
              kind: 'end',
              outcome: 'exit-rejected',
              pid: process.pid,
            }));
          },
        );
      }
    } catch {
      // No `exited` to watch: the start record stands alone, and the report
      // counts it unfinished rather than inventing a duration.
    }
    return child;
  };
}

/** A fresh recorder state writing to `sink`. */
export function recorderState(sink: RecordSink): RecorderState {
  return {nextId: 1, sink};
}

/**
 * A sink appending one JSON line per record to `logPath`. A failed write is
 * counted, and the first one is reported on fd 2 directly (a test may be
 * capturing `console` or `process.stderr`, so neither is used).
 */
export function fileSink(logPath: string): RecordSink {
  let failures = 0;
  return (record) => {
    try {
      appendFileSync(logPath, `${JSON.stringify(record)}\n`);
    } catch (error) {
      failures += 1;
      if (failures === 1) {
        writeSync(
          2,
          `\nspawn recorder: could not append to ${logPath} (${errorText(error)}); this run's spawn log is incomplete\n`,
        );
      }
    }
  };
}

/** Wrap `host.spawn` and `host.spawnSync`; the returned function restores them. */
export function installSpawnRecorder(
  host: SpawnHost,
  sink: RecordSink,
): () => void {
  const originalSpawn = host.spawn;
  const originalSpawnSync = host.spawnSync;
  const state = recorderState(sink);
  host.spawn = wrapSpawn(originalSpawn, state);
  host.spawnSync = wrapSpawnSync(originalSpawnSync, state);
  return () => {
    host.spawn = originalSpawn;
    host.spawnSync = originalSpawnSync;
  };
}

/**
 * The preload's entry point. Unset or empty: returns null and does nothing
 * else. Set: removes the variable from the environment, checks the log file
 * can be appended to (a bad path fails the run here, loudly, not silently
 * later), writes the session record, wraps the global `Bun` and returns the
 * function that unwraps it.
 */
export function installSpawnRecorderFromEnv(
  env: Record<string, string | undefined> = process.env,
): (() => void) | null {
  const logPath = env[SPAWN_LOG_ENV];
  if (logPath == null || logPath === '') return null;
  delete env[SPAWN_LOG_ENV];
  appendFileSync(logPath, '');
  const sink = fileSink(logPath);
  sink({
    bun: Bun.version,
    cwd: process.cwd(),
    kind: 'session',
    pid: process.pid,
    startMs: Date.now(),
    v: SPAWN_LOG_VERSION,
  });
  return installSpawnRecorder(Bun as unknown as SpawnHost, sink);
}
