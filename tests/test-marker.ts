/**
 * The suite's current-test marker (home-base-ejsq2.4): which test is each
 * test process running right now? `scripts/test-parallel.ts` reads it when its
 * wall-clock watchdog fires, to name the test a stuck worker is in.
 *
 * OFF BY DEFAULT. `tests/preload-test-env.ts` calls `installTestMarkerFromEnv`,
 * which returns at once unless `JUSTIN_SDK_TEST_MARKER_DIR` names a directory.
 * Off, it reads nothing else, wraps nothing and registers no hook. When it is
 * set, the variable is removed from `process.env` (no test and no child sees
 * it, as with the spawn recorder), and each test process appends records to
 * `<dir>/<pid>.jsonl`:
 *   file   the preload ran for a test file (once per file under --parallel,
 *          which isolates every file; once per process in a serial run)
 *   start  a test's beforeEach hooks began (the preload's own hook runs first)
 *   body   the test's own function began, with its name
 *   end    its afterEach hooks ran
 * A process whose last record is `start` or `body` is inside that test. A
 * synchronous loop never returns to write the next record, which is the point.
 *
 * HOW IT KNOWS THE NAME. bun:test has no "current test" API (Bun 1.4.2: the
 * hooks get no arguments and `expect.getState` does not exist). Its exports
 * can be replaced, though: the preload's `require('bun:test')` is the module
 * object every test file then imports from (measured 2026-11-18, Bun 1.4.2,
 * serial and --parallel). So `test`, `it` and `describe` are wrapped in a
 * Proxy that wraps each test's function. The modifiers (`skip`, `each`,
 * `skipIf`, …) live on the native function's prototype and refuse any other
 * `this` (ERR_INVALID_THIS), so the Proxy calls them on the native function
 * and wraps what they return. A form the Proxy does not reach still gets
 * `start` and `end`, so its record names the file and says the name is not
 * known; it never carries an earlier test's name.
 *
 * THE CONTRACT: the wrapped function gets the same `this` and arguments,
 * returns what the test function returns, and has the same `length` (bun
 * reads it to tell a `done` callback from a promise). Writing a record never
 * throws into a test: a failed write is counted and reported once on fd 2.
 */
import {appendFileSync, mkdirSync, writeSync} from 'node:fs';
import {join} from 'node:path';

/** The variable that turns the marker on: a directory. */
export const TEST_MARKER_ENV = 'JUSTIN_SDK_TEST_MARKER_DIR';

/** Bumped when a record's shape changes. */
export const TEST_MARKER_VERSION = 1;

/** Characters kept of a test's name (a test.each row can be long). */
const NAME_CHARS = 300;

interface RecordBase {
  atMs: number;
  /** The test file bun test was running (`Bun.main`), absolute. */
  file: string;
  pid: number;
}

export type MarkerRecord =
  | (RecordBase & {kind: 'body'; name: string; seq: number})
  | (RecordBase & {kind: 'end'; seq: number})
  | (RecordBase & {kind: 'file'; v: number})
  | (RecordBase & {kind: 'start'; seq: number});

export type MarkerSink = (record: MarkerRecord) => void;

type AnyFunction = (...args: unknown[]) => unknown;

/** What the marker wraps: the bun:test module, or a stand-in in a unit test. */
export interface MarkerHost {
  afterEach: (fn: () => void) => unknown;
  beforeEach: (fn: () => void) => unknown;
  describe: unknown;
  it: unknown;
  test: unknown;
}

/** A sink appending one JSON line per record to `<dir>/<pid>.jsonl`. */
export function markerFileSink(dir: string, pid = process.pid): MarkerSink {
  const path = join(dir, `${pid}.jsonl`);
  let failures = 0;
  return (record) => {
    try {
      appendFileSync(path, `${JSON.stringify(record)}\n`);
    } catch (error) {
      failures += 1;
      if (failures === 1) {
        writeSync(
          2,
          `\ntest marker: could not append to ${path} (${error instanceof Error ? error.message : String(error)}); the watchdog may not name this process's test\n`,
        );
      }
    }
  };
}

function nameText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'function' && value.name !== '') return value.name;
  return String(value);
}

function cut(text: string): string {
  return text.length > NAME_CHARS ? `${text.slice(0, NAME_CHARS)}…` : text;
}

function rowText(args: readonly unknown[]): string {
  try {
    return JSON.stringify(args) ?? String(args);
  } catch {
    return String(args);
  }
}

/** A function with `fn`'s `length` that runs `around`. */
function withSameLength(
  fn: AnyFunction,
  around: (thisArg: unknown, args: unknown[]) => unknown,
): AnyFunction {
  const wrapped = function (this: unknown, ...args: unknown[]): unknown {
    return around(this, args);
  };
  Object.defineProperty(wrapped, 'length', {value: fn.length});
  return wrapped;
}

/**
 * A test function that calls `beforeBody(args)`, then `fn` with the same
 * `this` and arguments, and returns or throws what `fn` does. It has `fn`'s
 * `length`, which bun reads to tell a `done` callback from a promise.
 */
export function wrapTestFunction(
  fn: AnyFunction,
  beforeBody: (args: unknown[]) => void,
): AnyFunction {
  return withSameLength(fn, (thisArg, args) => {
    beforeBody(args);
    return Reflect.apply(fn, thisArg, args);
  });
}

/**
 * Wrap `host`'s test, it and describe, and register the start and end hooks.
 * Returns the function that puts the three back (the hooks stay registered;
 * bun has no way to remove one).
 */
export function installTestMarker(
  host: MarkerHost,
  sink: MarkerSink,
  runningFile: () => string = () => Bun.main,
): () => void {
  const state = {current: null as null | {file: string; seq: number}, seq: 0};
  const describePath: string[] = [];
  const safely = (record: () => MarkerRecord): void => {
    try {
      sink(record());
    } catch {
      // The sink reports its own failures; nothing may reach a test.
    }
  };
  const base = (): RecordBase => ({
    atMs: Date.now(),
    file: runningFile(),
    pid: process.pid,
  });

  safely(() => ({...base(), kind: 'file', v: TEST_MARKER_VERSION}));
  host.beforeEach(() => {
    state.seq += 1;
    const record = {...base(), kind: 'start' as const, seq: state.seq};
    state.current = {file: record.file, seq: record.seq};
    safely(() => record);
  });
  host.afterEach(() => {
    const current = state.current;
    state.current = null;
    safely(() => ({...base(), kind: 'end', seq: current?.seq ?? state.seq}));
  });

  /** A test function that writes its `body` record, then runs. */
  const markedBody = (fn: AnyFunction, label: (args: unknown[]) => string) =>
    wrapTestFunction(fn, (args) => {
      safely(() => ({
        ...base(),
        kind: 'body',
        name: cut(label(args)),
        seq: state.current?.seq ?? state.seq,
      }));
    });

  /**
   * A describe function that sets the describe path while it registers. The
   * path is taken when the describe is REGISTERED: bun runs a nested
   * describe's function after the outer one has returned (measured
   * 2026-11-18, Bun 1.4.2), so a push and pop around the outer call alone
   * would lose it.
   */
  const markedDescribe = (fn: AnyFunction, path: readonly string[]) =>
    withSameLength(fn, (thisArg, args) => {
      const outer = describePath.splice(0, describePath.length, ...path);
      try {
        return Reflect.apply(fn, thisArg, args);
      } finally {
        describePath.splice(0, describePath.length, ...outer);
      }
    });

  const prefix = (): string =>
    describePath.length === 0 ? '' : `${describePath.join(' > ')} > `;

  /** The registration arguments with the function marked. */
  const markArgs = (
    kind: 'describe' | 'test',
    args: unknown[],
    row: boolean,
  ): unknown[] => {
    const [name, fn, ...rest] = args;
    if (typeof fn !== 'function') return args;
    const text = nameText(name);
    if (kind === 'describe') {
      const path = [...describePath, text];
      return [name, markedDescribe(fn as AnyFunction, path), ...rest];
    }
    const path = `${prefix()}${text}`;
    return [
      name,
      markedBody(fn as AnyFunction, (callArgs) =>
        row ? `${path} ${rowText(callArgs)}` : path,
      ),
      ...rest,
    ];
  };

  const scopeProtos = new Set<unknown>();
  for (const value of [host.test, host.it, host.describe]) {
    if (typeof value === 'function') {
      scopeProtos.add(Object.getPrototypeOf(value));
    }
  }
  const isScope = (value: unknown): value is AnyFunction =>
    typeof value === 'function' &&
    scopeProtos.has(Object.getPrototypeOf(value));

  /** A registration function (test.each(...)'s result): marks its function. */
  const proxifyRows = (fn: AnyFunction, kind: 'describe' | 'test') =>
    new Proxy(fn, {
      apply: (target, thisArg, args: unknown[]) =>
        Reflect.apply(target, thisArg, markArgs(kind, args, true)),
    });

  /** `row`: the scope came from `each`, so its calls get the row's values. */
  const proxify = (
    scope: AnyFunction,
    kind: 'describe' | 'test',
    row = false,
  ): AnyFunction =>
    new Proxy(scope, {
      apply: (target, thisArg, args: unknown[]) =>
        Reflect.apply(target, thisArg, markArgs(kind, args, row)),
      get: (target, key) => {
        // Getters (skip, only, todo, …) run on the native function, as do
        // methods (each, if, skipIf, …): they refuse any other `this`.
        const value: unknown = Reflect.get(target, key, target);
        if (isScope(value)) return proxify(value, kind, row);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]): unknown => {
          const result: unknown = Reflect.apply(
            value as AnyFunction,
            target,
            args,
          );
          if (isScope(result)) {
            return proxify(result, kind, row || key === 'each');
          }
          if (key === 'each' && typeof result === 'function') {
            return proxifyRows(result as AnyFunction, kind);
          }
          return result;
        };
      },
    });

  const originals = {describe: host.describe, it: host.it, test: host.test};
  if (isScope(host.test)) host.test = proxify(host.test, 'test');
  if (isScope(host.it)) host.it = proxify(host.it, 'test');
  if (isScope(host.describe))
    host.describe = proxify(host.describe, 'describe');
  return () => {
    host.describe = originals.describe;
    host.it = originals.it;
    host.test = originals.test;
  };
}

/**
 * The preload's entry point. Unset or empty: returns null and does nothing
 * else (no module is read, nothing is wrapped, no hook is registered). Set:
 * removes the variable from the environment, creates the directory, wraps
 * the bun:test module and returns the function that unwraps it.
 */
export function installTestMarkerFromEnv(
  env: Record<string, string | undefined> = process.env,
  loadHost: () => MarkerHost = () =>
    // The module object test files import from: replacing its properties
    // here is what they then see (an ES import of it cannot be reassigned).
    import.meta.require('bun:test') as MarkerHost,
): (() => void) | null {
  const dir = env[TEST_MARKER_ENV];
  if (dir == null || dir === '') return null;
  delete env[TEST_MARKER_ENV];
  mkdirSync(dir, {recursive: true});
  return installTestMarker(loadHost(), markerFileSink(dir));
}
