/**
 * Where `thread inbox`'s time goes (home-base-9uzxw.2, epic home-base-9uzxw
 * D-PERF): the wall time of each phase, and how many child processes each
 * phase started, by program. `thread inbox --json` prints the record as its
 * `timings` field; the threads dashboard logs it beside its own steps and
 * shows it on `p`.
 *
 * Spawns are counted by wrapping `Bun.spawn` and `Bun.spawnSync` while a
 * recorder is open. In Bun, node:child_process runs on those two (measured
 * 2026-11-07 on Bun 1.4.2: spawn, spawnSync, execFile and execFileSync all
 * reach them). The phase a spawn belongs to comes from AsyncLocalStorage, so
 * phases that run at the same time (the session loads, the untracked scan,
 * the pane lookup) each count their own. A probe spawn when the wrapper is
 * installed proves it sees node:child_process; when it does not, every count
 * is null and `spawnCounting` says why. A count is never a 0 that means "not
 * counted" (critical rule 7).
 */
import {AsyncLocalStorage} from 'node:async_hooks';
import {spawnSync} from 'node:child_process';
import {basename} from 'node:path';

/** Child processes started, by program name (`git`, `br`, `cmux`, `ps`). */
export type SpawnCounts = Record<string, number>;

export interface PhaseTiming {
  /** Wall time from the phase's start to its end (a promise's settling). */
  ms: number;
  name: string;
  /** Processes started while this phase ran; null when spawns were not counted. */
  spawns: SpawnCounts | null;
  /** When the phase started, in ms after the recorder started. */
  startMs: number;
}

/** One session's load inside the concurrent loads phase. */
export interface SessionLoadTiming {
  ms: number;
  sessionId: string;
  spawns: SpawnCounts | null;
}

/** How the spawn counts were taken, or why there are none. */
export type SpawnCounting =
  | {kind: 'counted'}
  | {kind: 'failed'; reason: string};

export interface InboxTimings {
  /**
   * How long the process had run when the recorder started: bun's start,
   * loading the CLI's modules and parsing the arguments.
   */
  bootMs: number;
  /** CPU this process used while recording (children not included). */
  cpu: {systemMs: number; userMs: number};
  /** In start order. Phases that overlap say so through `startMs` and `ms`. */
  phases: PhaseTiming[];
  /** How many session loads were timed. */
  sessionLoads: number;
  /** The five slowest session loads, slowest first. */
  slowestSessions: SessionLoadTiming[];
  spawnCounting: SpawnCounting;
  /** Every process started while recording, inside a phase or not. */
  spawns: SpawnCounts | null;
  /** From the recorder's start to `finish()`. */
  totalMs: number;
}

export interface TimingRecorder {
  /** The record. Call it once, when the work is done; it stops counting spawns. */
  finish: () => InboxTimings;
  /**
   * Run `run` as the phase `name`. A returned promise ends the phase when it
   * settles; a plain value ends it at once.
   */
  phase: <T>(name: string, run: () => T) => T;
  /** Run one session's load, for the slowest-five list. */
  session: <T>(sessionId: string, run: () => Promise<T>) => Promise<T>;
  /**
   * Open a phase around SYNCHRONOUS code without wrapping it in a function;
   * the returned function closes it. Spawns made while it is open and outside
   * any `phase` are counted to it. Only for code that does not await before
   * the close: no other code can run in between, so nothing is misattributed.
   */
  start: (name: string) => () => void;
}

/** How many of the slowest session loads the record names. */
export const SLOWEST_SESSIONS = 5;

/** Where a counted spawn is added: the open phases and session load around it. */
interface CountTarget {
  targets: SpawnCounts[];
}

const context = new AsyncLocalStorage<CountTarget>();

/** Every recorder now open; the wrapper counts only for these. */
const open = new Set<OpenRecorder>();

interface OpenRecorder {
  /**
   * Why counting a spawn failed while this recorder was open, or null. Once
   * set, the record's counts are all null and `spawnCounting` says why: a
   * count that missed a spawn is not a count (critical rule 7).
   */
  countError: string | null;
  syncTargets: SpawnCounts[] | null;
  total: SpawnCounts;
}

let installed: null | {
  counting: SpawnCounting;
  restore: () => void;
} = null;

function roundMs(ms: number): number {
  return Math.round(ms * 10) / 10;
}

function add(counts: SpawnCounts, program: string): void {
  counts[program] = (counts[program] ?? 0) + 1;
}

/**
 * The program a Bun.spawn / Bun.spawnSync call starts, by its file name; for
 * git, with its subcommand (`git rev-parse`), since git is most of them.
 */
export function spawnProgram(args: readonly unknown[]): string {
  const first = args[0];
  const cmd: unknown = Array.isArray(first)
    ? first
    : first != null && typeof first === 'object' && 'cmd' in first
      ? (first as {cmd: unknown}).cmd
      : null;
  if (!Array.isArray(cmd)) return 'unknown';
  const [name, ...rest] = cmd as unknown[];
  if (typeof name !== 'string' || name === '') return 'unknown';
  const program = basename(name);
  if (program !== 'git') return program;
  // git's own options (`-C <dir>`, `-c k=v`) come before the subcommand.
  for (let at = 0; at < rest.length; at += 1) {
    const arg = rest[at];
    if (typeof arg !== 'string') break;
    if (arg === '-C' || arg === '-c') {
      at += 1;
      continue;
    }
    if (!arg.startsWith('-')) return `git ${arg}`;
  }
  return program;
}

function countSpawn(args: readonly unknown[]): void {
  if (open.size === 0) return;
  const program = spawnProgram(args);
  for (const recorder of open) add(recorder.total, program);
  // Inside a phase run through `phase`: its own targets. Otherwise the
  // synchronous phases open now, if any.
  const targets = context.getStore()?.targets ?? [
    ...[...open].flatMap((recorder) => recorder.syncTargets ?? []),
  ];
  for (const target of targets) add(target, program);
}

/**
 * Count a spawn, and never let counting change the spawn (conductor finding
 * F3): the wrapper runs this before the real Bun.spawn, so a throw here would
 * fail the spawn and break the inbox. A counting error marks every open
 * recorder's counts failed, with the reason; the spawn runs as if unwrapped.
 */
function countSpawnSafely(args: readonly unknown[]): void {
  try {
    countSpawn(args);
  } catch (error) {
    const reason = `counting a spawn threw: ${error instanceof Error ? error.message : String(error)}`;
    for (const recorder of open) recorder.countError ??= reason;
  }
}

const PROBE_PROGRAM = 'true';

/**
 * Wrap Bun.spawn and Bun.spawnSync, then prove a node:child_process spawn
 * reaches the wrapper. Kept installed while any recorder is open.
 */
function install(): SpawnCounting {
  if (installed != null) return installed.counting;
  const bun = Bun as unknown as Record<string, unknown>;
  const originalSpawn = bun.spawn as (...args: unknown[]) => unknown;
  const originalSpawnSync = bun.spawnSync as (...args: unknown[]) => unknown;
  let probed = 0;
  let probing = false;
  const wrap =
    (original: (...args: unknown[]) => unknown) =>
    (...args: unknown[]): unknown => {
      if (probing) probed += 1;
      else countSpawnSafely(args);
      return original.apply(Bun, args);
    };
  const restore = (): void => {
    bun.spawn = originalSpawn;
    bun.spawnSync = originalSpawnSync;
  };
  let counting: SpawnCounting;
  try {
    bun.spawn = wrap(originalSpawn);
    bun.spawnSync = wrap(originalSpawnSync);
    probing = true;
    try {
      spawnSync(PROBE_PROGRAM, [], {stdio: 'ignore'});
    } catch {
      // Whether the probe program ran does not matter: the count does.
    } finally {
      probing = false;
    }
    counting =
      probed === 1
        ? {kind: 'counted'}
        : {
            kind: 'failed',
            reason: `a node:child_process spawnSync reached Bun.spawnSync ${probed} times, not once (Bun ${Bun.version}), so this Bun's spawns cannot be counted this way`,
          };
  } catch (error) {
    counting = {
      kind: 'failed',
      reason: `could not wrap Bun.spawn: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (counting.kind === 'failed') restore();
  installed = {counting, restore};
  return counting;
}

function uninstall(): void {
  if (open.size > 0 || installed == null) return;
  installed.restore();
  installed = null;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value != null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as {then?: unknown}).then === 'function'
  );
}

/** Start recording now. */
export function startTimings(): TimingRecorder {
  const bootMs = roundMs(performance.now());
  const started = performance.now();
  const cpuStart = process.cpuUsage();
  const counting = install();
  const counted = counting.kind === 'counted';
  const self: OpenRecorder = {countError: null, syncTargets: null, total: {}};
  open.add(self);
  const phases: PhaseTiming[] = [];
  const sessions: SessionLoadTiming[] = [];
  const elapsed = (): number => performance.now() - started;
  let finished: InboxTimings | null = null;

  const begin = (name: string): {end: () => void; entry: PhaseTiming} => {
    const entry: PhaseTiming = {
      ms: 0,
      name,
      spawns: counted ? {} : null,
      startMs: roundMs(elapsed()),
    };
    phases.push(entry);
    const at = performance.now();
    return {
      end: () => {
        entry.ms = roundMs(performance.now() - at);
      },
      entry,
    };
  };

  /** Run `run` with `extra` added to the count targets around it. */
  const within = <T>(extra: SpawnCounts | null, run: () => T): T => {
    const outer = context.getStore()?.targets ?? self.syncTargets ?? [];
    return context.run(
      {targets: extra == null ? outer : [...outer, extra]},
      run,
    );
  };

  const settle = <T>(result: T, end: () => void): T => {
    if (!isPromiseLike(result)) {
      end();
      return result;
    }
    return Promise.resolve(result).then(
      (value) => {
        end();
        return value;
      },
      (error: unknown) => {
        end();
        throw error;
      },
    ) as T;
  };

  return {
    finish: () => {
      if (finished != null) return finished;
      open.delete(self);
      uninstall();
      const cpu = process.cpuUsage(cpuStart);
      // F3: a counting error after the probe means some spawn may be missing
      // from every count, so none of them is a count any more.
      const failure: SpawnCounting | null =
        self.countError == null
          ? null
          : {kind: 'failed', reason: self.countError};
      const slowest = [...sessions]
        .sort((a, b) => b.ms - a.ms)
        .slice(0, SLOWEST_SESSIONS)
        .map((entry) => (failure == null ? entry : {...entry, spawns: null}));
      finished = {
        bootMs,
        cpu: {
          systemMs: roundMs(cpu.system / 1000),
          userMs: roundMs(cpu.user / 1000),
        },
        phases:
          failure == null
            ? phases
            : phases.map((entry) => ({...entry, spawns: null})),
        sessionLoads: sessions.length,
        slowestSessions: slowest,
        spawnCounting: failure ?? counting,
        spawns: counted && failure == null ? self.total : null,
        totalMs: roundMs(elapsed()),
      };
      return finished;
    },
    phase: <T>(name: string, run: () => T): T => {
      const {end, entry} = begin(name);
      let result: T;
      try {
        result = within(entry.spawns, run);
      } catch (error) {
        end();
        throw error;
      }
      return settle(result, end);
    },
    session: async <T>(sessionId: string, run: () => Promise<T>) => {
      const entry: SessionLoadTiming = {
        ms: 0,
        sessionId,
        spawns: counted ? {} : null,
      };
      sessions.push(entry);
      const at = performance.now();
      try {
        return await within(entry.spawns, run);
      } finally {
        entry.ms = roundMs(performance.now() - at);
      }
    },
    start: (name: string) => {
      const {end, entry} = begin(name);
      const before = self.syncTargets;
      self.syncTargets =
        entry.spawns == null ? before : [...(before ?? []), entry.spawns];
      return () => {
        self.syncTargets = before;
        end();
      };
    },
  };
}

/** `recorder.phase`, or just `run()` when nothing is being recorded. */
export function timed<T>(
  recorder: TimingRecorder | null | undefined,
  name: string,
  run: () => T,
): T {
  return recorder == null ? run() : recorder.phase(name, run);
}

/** `recorder.session`, or just `run()` when nothing is being recorded. */
export async function timedSession<T>(
  recorder: TimingRecorder | null | undefined,
  sessionId: string,
  run: () => Promise<T>,
): Promise<T> {
  return recorder == null
    ? await run()
    : await recorder.session(sessionId, run);
}

/** `recorder.start`, or a no-op close when nothing is being recorded. */
export function timedStart(
  recorder: TimingRecorder | null | undefined,
  name: string,
): () => void {
  return recorder == null ? () => undefined : recorder.start(name);
}

/**
 * `json` (a pretty-printed, 2-space JSON object) with a `timings` field
 * added last. Splicing the text saves serialising the whole inbox a second
 * time just to add a field measured after the first.
 */
export function withTimingsField(json: string, timings: InboxTimings): string {
  const field = JSON.stringify(timings, null, 2).replaceAll('\n', '\n  ');
  const trimmed = json.trimEnd();
  if (trimmed === '{}') return `{\n  "timings": ${field}\n}`;
  if (!trimmed.endsWith('\n}')) {
    throw new Error(
      'withTimingsField: expected a pretty-printed JSON object ending in "\\n}"',
    );
  }
  return `${trimmed.slice(0, -2)},\n  "timings": ${field}\n}`;
}

/**
 * home-base-9uzxw.5 F15: what `thread inbox --json` prints. The timings are
 * spliced in when they can be; when the splice fails, the inbox is printed as
 * it is, without them, and `problem` says so for stderr. A performance field
 * never costs the inbox.
 */
export function inboxJsonWithTimings(
  json: string,
  timings: InboxTimings,
): {problem: string | null; text: string} {
  try {
    return {problem: null, text: withTimingsField(json, timings)};
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      problem: `the load timings were left out of the JSON: ${reason}`,
      text: json,
    };
  }
}
