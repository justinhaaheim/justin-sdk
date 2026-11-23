#!/usr/bin/env bun
/**
 * The justin-sdk suite in parallel workers, with a wall-clock watchdog
 * (home-base-ejsq2.4). Opt-in, for sessions: `sdk:publish` still runs the
 * suite serially (Justin's question home-base-mgexc.1).
 *
 * It runs `bun test --parallel=<N>` in this package under `caffeinate -i`,
 * after the busy check of scripts/test-timing.ts (another `bun test` on this
 * Mac refuses the run). Arguments after `--` go to bun test.
 *
 * THE WATCHDOG. Parallel runs have spun for hours: on 2026-11-13 a worker
 * burned 15 hours of CPU in a loop that bun's 5 s per-test limit never
 * stopped, because synchronous code never yields to it. When the run passes
 * `--limit` seconds this script:
 *  1. reads the current-test marker (tests/test-marker.ts, turned on for the
 *     run) and names the test each worker is in, and since when;
 *  2. runs `sample <pid> <seconds>` on each test process that is still
 *     alive, into the run's output directory;
 *  3. stops the whole process tree: every descendant of the run and every
 *     member of its process group is frozen with SIGSTOP (so none can start
 *     another), then killed with SIGKILL;
 *  4. checks that none is left, and exits 124.
 * A session that runs it therefore never waits longer than the limit plus
 * about the sample time.
 *
 * THE STALL CHECK (home-base-ejsq2.6, widened in ejsq2.8). The script also
 * polls the markers and stops the run the same way, with exit 125, as soon as
 * a live worker has written no marker record for `--stall` seconds in any
 * state (between tests, in a hook, loading a file, in the preload), or has
 * stayed inside one test that long (default 180, above every explicit timeout
 * in tests/ and every gap a green run leaves). Both spins seen on bun 1.4.2
 * were `Bun.spawnSync` looping beside an exited, unreaped child: bun issue
 * #34069, fixed by bun PR #44581 in bun 1.4.3; one was inside a test, one in
 * the preload between two files. The stop report lists each worker's
 * children, so a `Z` child shows that case.
 *
 * Output directory (default `$XDG_STATE_HOME/justin-sdk/test-parallel/<stamp>/`):
 * run.json, junit.xml, console.txt, markers/<pid>.jsonl, samples/<pid>.txt.
 */
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import {homedir, loadavg} from 'node:os';
import {join, relative, resolve} from 'node:path';
import yargs from 'yargs';
import {hideBin} from 'yargs/helpers';

import {
  BODY_COLUMN,
  fieldLines,
  outputStyle,
  pad,
  paint,
  sectionHeader,
} from '../src/cli-style';
import {type MarkerRecord, TEST_MARKER_ENV} from '../tests/test-marker';
import {otherTestRuns, parseJunit, readPs} from './test-timing';

/** This package: scripts/ → justin-sdk/. The suite runs here. */
const PACKAGE_ROOT = resolve(import.meta.dir, '..');

/**
 * Workers by default. Chosen by measurement (home-base-ejsq2.4's notes hold
 * the four- and eight-worker runs).
 */
export const DEFAULT_WORKERS = 4;
/**
 * The wall-clock limit by default: 10 minutes (home-base-ejsq2.6; it was 20).
 * Green four-worker runs took 304 s and 311 s at load 7 to 11 and eight
 * workers 260 s (2026-11-18); the slowest parallel run ever recorded took
 * 505 s, with 30 timeouts, before the speedups of home-base-ejsq2.1 to .3. A
 * run past 600 s is stuck, not slow. A spin inside a test is stopped sooner,
 * by the stall limit.
 */
export const DEFAULT_LIMIT_SECONDS = 600;
/**
 * The stall limit by default: 3 minutes without a marker record, or inside one
 * test (home-base-ejsq2.6; kept at 180 when ejsq2.8 widened the check, on
 * these numbers):
 *  - above every explicit timeout in tests/, test or hook (the longest is
 *    120 s: `bun scripts/test-stall-evidence.ts timeouts`), so bun ends a slow
 *    async test or hook itself before this fires;
 *  - 15 times the longest gap a worker left between two records, in any
 *    state, across 64,315 gaps of three full runs on 2026-11-20 and 21
 *    (`… gaps <run dir>`): 12.0 s inside a test, 9.0 s from a worker's last
 *    record to the run's end, 4.3 s loading a file and its beforeAll, 0.2 s
 *    for an afterAll and the next file's preload;
 *  - over twice the longest single file (73.7 s), which bounds how long a
 *    worker with no file left could wait for the others. bun ends such a
 *    worker: in run ejsq2.6-run1, three of the four were gone at the stop.
 * Only code bun cannot stop, synchronous code that never yields, stays past it.
 */
export const DEFAULT_STALL_SECONDS = 180;
export const DEFAULT_SAMPLE_SECONDS = 5;

/** Exit codes. */
export const EXIT = {
  failed: 1,
  green: 0,
  interrupted: 130,
  refused: 3,
  stalled: 125,
  stopped: 124,
} as const;

// ---------------------------------------------------------------------------
// The process tree
// ---------------------------------------------------------------------------

export interface PsRow {
  args: string;
  pgid: number;
  pid: number;
  ppid: number;
  stat: string;
}

/** `ps -axo pid=,ppid=,pgid=,stat=,args=` output, one row per process. */
export function parsePsRows(text: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of text.split('\n')) {
    const fields = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/u.exec(line);
    if (fields == null) continue;
    rows.push({
      args: fields[5] ?? '',
      pgid: Number(fields[3]),
      pid: Number(fields[1]),
      ppid: Number(fields[2]),
      stat: fields[4] ?? '',
    });
  }
  return rows;
}

/**
 * `root` and every process below it by parent, plus every member of process
 * group `group` (a child whose parent died is reparented to launchd, but it
 * keeps its group). Never `exclude` (this script).
 */
export function processTree(
  rows: readonly PsRow[],
  root: number,
  group: number | null,
  exclude: number,
): number[] {
  const children = new Map<number, number[]>();
  for (const row of rows) {
    const list = children.get(row.ppid) ?? [];
    list.push(row.pid);
    children.set(row.ppid, list);
  }
  const found = new Set<number>();
  const queue = rows.some((row) => row.pid === root) ? [root] : [];
  for (const row of rows) {
    if (group != null && row.pgid === group) queue.push(row.pid);
  }
  while (queue.length > 0) {
    const pid = queue.shift();
    if (pid == null || found.has(pid) || pid === exclude) continue;
    found.add(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * Every process, by an ASYNC spawn (home-base-ejsq2.6): on bun 1.4.2 a
 * `Bun.spawnSync` can spin forever once an earlier pipe's finalizer runs
 * during the call (bun issue #34069), and the watchdog calls ps many times
 * right after its `sample` children with piped stderr have finished.
 */
async function readPsRows(): Promise<PsRow[] | null> {
  try {
    const ps = Bun.spawn(['ps', '-axo', 'pid=,ppid=,pgid=,stat=,args='], {
      stderr: 'ignore',
      stdout: 'pipe',
    });
    const [text, code] = await Promise.all([
      new Response(ps.stdout).text(),
      ps.exited,
    ]);
    return code === 0 ? parsePsRows(text) : null;
  } catch {
    // posix_spawn refused (the sandbox): unknown, never "no processes".
    return null;
  }
}

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch {
    // Gone already, or not ours: the final check below says which remain.
  }
}

export interface StopResult {
  /** Processes still alive (not zombies) after the kill; [] means checked and none. */
  leftovers: PsRow[] | null;
  /** Why the tree could not be read, when it could not. */
  problem: string | null;
  stopped: number[];
}

/**
 * Freeze the tree with SIGSTOP until a scan finds no new process (a frozen
 * process cannot start another), then SIGKILL all of it and its group, then
 * look again. `leftovers` null means the last look failed: not "none".
 */
export async function stopTree(
  root: number,
  group: number,
): Promise<StopResult> {
  const stopped = new Set<number>();
  let problem: null | string = null;
  for (let round = 0; round < 20; round += 1) {
    const rows = await readPsRows();
    if (rows == null) {
      problem = 'ps did not run, so the tree could not be listed';
      break;
    }
    const fresh = processTree(rows, root, group, process.pid).filter(
      (pid) => !stopped.has(pid),
    );
    if (fresh.length === 0) break;
    for (const pid of fresh) {
      signal(pid, 'SIGSTOP');
      stopped.add(pid);
    }
  }
  signal(-group, 'SIGKILL');
  for (const pid of stopped) signal(pid, 'SIGKILL');
  signal(root, 'SIGKILL');

  let leftovers: PsRow[] | null = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await Bun.sleep(250);
    const rows = await readPsRows();
    if (rows == null) {
      leftovers = null;
      continue;
    }
    leftovers = rows.filter(
      (row) =>
        (stopped.has(row.pid) || row.pgid === group) &&
        row.pid !== process.pid &&
        !row.stat.startsWith('Z'),
    );
    if (leftovers.length === 0) break;
  }
  return {leftovers, problem, stopped: [...stopped].sort((a, b) => a - b)};
}

// ---------------------------------------------------------------------------
// The markers
// ---------------------------------------------------------------------------

export interface ProcessState {
  /** The last record that says where it is; null when it wrote none. */
  last: MarkerRecord | null;
  /** The running test's name, when the last record is its start or body. */
  name: string | null;
  pid: number;
  /**
   * When the running test began: its `start` record (its beforeEach hooks
   * first), or its `body` when no start was seen. null outside a test. A
   * `body` record never moves it, so the stall clock counts the whole test.
   */
  testStartedAtMs: null | number;
  /** Bad lines: a record that did not parse is counted, never skipped quietly. */
  unreadable: number;
  where: 'between-tests' | 'in-test' | 'loading-file' | 'no-record';
}

/** A process that has written nothing yet. */
export function emptyProcessState(pid: number): ProcessState {
  return {
    last: null,
    name: null,
    pid,
    testStartedAtMs: null,
    unreadable: 0,
    where: 'no-record',
  };
}

/** The state after one more marker line (a line that does not parse is counted). */
export function foldMarkerLine(
  state: ProcessState,
  line: string,
): ProcessState {
  if (line.trim() === '') return state;
  let record: MarkerRecord;
  try {
    record = JSON.parse(line) as MarkerRecord;
  } catch {
    return {...state, unreadable: state.unreadable + 1};
  }
  switch (record.kind) {
    case 'start':
      return {
        ...state,
        last: record,
        name: null,
        testStartedAtMs: record.atMs,
        where: 'in-test',
      };
    case 'body':
      return {
        ...state,
        last: record,
        name: record.name,
        testStartedAtMs:
          state.where === 'in-test' && state.testStartedAtMs != null
            ? state.testStartedAtMs
            : record.atMs,
        where: 'in-test',
      };
    case 'file':
      return {
        ...state,
        last: record,
        name: null,
        testStartedAtMs: null,
        where: 'loading-file',
      };
    case 'end':
      return {
        ...state,
        last: record,
        name: null,
        testStartedAtMs: null,
        where: 'between-tests',
      };
  }
}

/** Where one test process is, from its marker lines. */
export function processState(pid: number, text: string): ProcessState {
  return text.split('\n').reduce(foldMarkerLine, emptyProcessState(pid));
}

/** Every process's state from a marker directory; null when it cannot be read. */
export function readMarkerDir(dir: string): ProcessState[] | null {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  return entries
    .filter((entry) => /^\d+\.jsonl$/u.test(entry))
    .map((entry) =>
      processState(
        Number(entry.replace('.jsonl', '')),
        readFileSync(join(dir, entry), 'utf8'),
      ),
    )
    .sort((a, b) => a.pid - b.pid);
}

/**
 * A reader that keeps each marker file's place, so a poll every few seconds
 * reads only what was appended since the last one. A line not yet ended by
 * its newline is kept for the next read, never parsed half-written. Returns
 * null when the directory cannot be listed.
 */
export function createMarkerReader(dir: string): () => ProcessState[] | null {
  const files = new Map<
    number,
    {offset: number; partial: Buffer; state: ProcessState}
  >();
  return () => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (!/^\d+\.jsonl$/u.test(entry)) continue;
      const pid = Number(entry.replace('.jsonl', ''));
      const file = files.get(pid) ?? {
        offset: 0,
        partial: Buffer.alloc(0),
        state: emptyProcessState(pid),
      };
      let fd: number | null = null;
      try {
        fd = openSync(join(dir, entry), 'r');
        const size = fstatSync(fd).size;
        if (size > file.offset) {
          const chunk = Buffer.alloc(size - file.offset);
          const got = readSync(fd, chunk, 0, chunk.length, file.offset);
          file.offset += got;
          const bytes = Buffer.concat([file.partial, chunk.subarray(0, got)]);
          const lastNewline = bytes.lastIndexOf(0x0a);
          const complete =
            lastNewline < 0 ? '' : bytes.toString('utf8', 0, lastNewline);
          file.partial = Buffer.from(bytes.subarray(lastNewline + 1));
          file.state = complete.split('\n').reduce(foldMarkerLine, file.state);
        }
      } catch {
        // Unreadable this time (a file mid-creation): its last state stands,
        // and the next poll tries again.
      } finally {
        if (fd != null) closeSync(fd);
      }
      files.set(pid, file);
    }
    return [...files.values()]
      .map((file) => file.state)
      .sort((a, b) => a.pid - b.pid);
  };
}

export interface Stall {
  name: string | null;
  pid: number;
  seconds: number;
  state: ProcessState;
  where: ProcessState['where'];
}

/**
 * When a worker's stall clock started (home-base-ejsq2.8). Inside a test: the
 * test's `start` record, so the test is timed whole, its beforeEach hooks
 * included, and its `body` record never moves the clock (as since ejsq2.6).
 * Anywhere else: its last record. null when it wrote no record: a worker
 * with no record has no clock.
 */
export function stallClockStartMs(state: ProcessState): null | number {
  if (state.where === 'in-test' && state.testStartedAtMs != null) {
    return state.testStartedAtMs;
  }
  return state.last?.atMs ?? null;
}

/**
 * THE STALL DECISION (home-base-ejsq2.6, widened in ejsq2.8). A test process
 * is stalled when it is alive and its stall clock (stallClockStartMs) has run
 * for at least `stallMs`: it wrote no marker record for that long in any
 * state (between tests, in an afterAll or the next file's preload, loading a
 * file or in its beforeAll), or it has been inside one test that long. Until
 * ejsq2.8 only the second counted, and on 2026-11-20 a worker that spun in
 * the preload between two files ran to the wall limit (run ejsq2.6-run1: 585 s
 * after its last record). Never a process with no record (no clock: the wall
 * limit still stands). Never a process `alive` does not hold: a worker that
 * died, or that bun ended when no file was left, leaves its last record
 * behind it. `alive` null means the tree could not be read, so nothing is
 * called stalled on that evidence (the wall limit still stands).
 */
export function stalledTests(
  states: readonly ProcessState[],
  options: {alive: ReadonlySet<number> | null; nowMs: number; stallMs: number},
): Stall[] {
  if (options.alive == null) return [];
  const alive = options.alive;
  return states.flatMap((state) => {
    const clockMs = stallClockStartMs(state);
    if (clockMs == null) return [];
    if (options.nowMs - clockMs < options.stallMs) return [];
    if (!alive.has(state.pid)) return [];
    return [
      {
        name: state.name,
        pid: state.pid,
        seconds: (options.nowMs - clockMs) / 1000,
        state,
        where: state.where,
      },
    ];
  });
}

/** The report's line for one stalled worker. */
export function describeStall(stall: Stall): string {
  const seconds = stall.seconds.toFixed(0);
  switch (stall.where) {
    case 'in-test':
      return `stalled: pid ${stall.pid}, ${stall.name == null ? 'name not recorded' : `"${stall.name}"`}, ${seconds} s in that test`;
    case 'loading-file':
      return `stalled: pid ${stall.pid}, no marker record for ${seconds} s, loading a file or in its beforeAll`;
    case 'between-tests':
      return `stalled: pid ${stall.pid}, no marker record for ${seconds} s, after a test (afterEach, afterAll, or the next file's preload)`;
    case 'no-record':
      return `stalled: pid ${stall.pid}, no marker record for ${seconds} s`;
  }
}

/** How often the stall check polls: a quarter of the limit, 0.25 s to 5 s. */
export function stallPollMs(stallMs: number): number {
  return Math.min(5000, Math.max(250, Math.round(stallMs / 4)));
}

function ago(fromMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - fromMs) / 1000));
  return seconds < 120 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}

/** One line per live test process: what it is doing, and since when. */
export function describeProcess(
  state: ProcessState,
  options: {cwd: string; nowMs: number},
): string {
  const last = state.last;
  if (last == null) return 'wrote no marker record';
  const inside = relative(options.cwd, last.file);
  const file = inside.startsWith('..') ? last.file : inside;
  const since = ago(last.atMs, options.nowMs);
  const bad =
    state.unreadable > 0
      ? ` (${state.unreadable} marker lines unreadable)`
      : '';
  switch (state.where) {
    case 'in-test':
      return state.name == null
        ? `in test #${last.kind === 'start' ? last.seq : '?'} of ${file}, name not recorded (its beforeEach hooks, or a form the marker does not wrap), for ${since}${bad}`
        : `in "${state.name}" (${file}) for ${since}${bad}`;
    case 'loading-file':
      return `loading ${file} or in its beforeAll, for ${since}${bad}`;
    case 'between-tests':
      return `after a test of ${file} (afterEach, afterAll, or the next file), for ${since}${bad}`;
    case 'no-record':
      return 'wrote no marker record';
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** Why a run was stopped before bun test exited. */
type StopReason = 'limit' | 'signal' | 'stall';

interface RunOptions {
  cwd: string;
  extra: string[];
  limitSeconds: number;
  out: string | null;
  sampleSeconds: number;
  skipBusyCheck: boolean;
  /** Seconds without a record, or inside one test, before the run is stopped; 0 turns the check off. */
  stallSeconds: number;
  workers: number;
}

function stateDir(): string {
  const base = process.env.XDG_STATE_HOME;
  return join(
    base == null || base === '' ? join(homedir(), '.local', 'state') : base,
    'justin-sdk',
    'test-parallel',
  );
}

/** HEAD, by an async spawn for the reason readPsRows gives; null when git fails. */
async function gitHead(cwd: string): Promise<null | string> {
  try {
    const git = Bun.spawn(['git', 'rev-parse', 'HEAD'], {
      cwd,
      stderr: 'ignore',
      stdout: 'pipe',
    });
    const [text, code] = await Promise.all([
      new Response(git.stdout).text(),
      git.exited,
    ]);
    return code === 0 ? text.trim() : null;
  } catch {
    return null;
  }
}

function write(text: string): void {
  process.stdout.write(`${text}\n`);
}

/** The bun test summary lines of the console output, for the report. */
function summaryLines(consoleText: string): string[] {
  return consoleText
    .split('\n')
    .filter(
      (line) =>
        /^\s*\d+ (pass|fail|skip|todo|error|errors)$/u.test(line) ||
        /^Ran \d+ tests? across \d+ files?/u.test(line) ||
        line.startsWith('(fail) '),
    )
    .slice(0, 60);
}

async function sampleProcess(
  pid: number,
  seconds: number,
  file: string,
): Promise<string> {
  try {
    const child = Bun.spawn(
      ['sample', String(pid), String(seconds), '-file', file],
      {stderr: 'pipe', stdout: 'ignore'},
    );
    const code = await child.exited;
    if (code === 0 && existsSync(file)) return file;
    const stderr = (await new Response(child.stderr).text()).trim();
    return `sample exited ${code}: ${stderr === '' ? 'no output' : stderr}`;
  } catch (error) {
    return `sample could not start: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function run(options: RunOptions): Promise<number> {
  const style = outputStyle();
  const busy = otherTestRuns(readPs(), process.pid);
  if (busy.kind === 'failed' && !options.skipBusyCheck) {
    process.stderr.write(
      `test-parallel: could not check for other bun test runs: ${busy.reason}\nRun it with the sandbox off, or pass --skip-busy-check.\n`,
    );
    return EXIT.refused;
  }
  if (
    busy.kind === 'checked' &&
    busy.runs.length > 0 &&
    !options.skipBusyCheck
  ) {
    process.stderr.write(
      `test-parallel: another bun test is running; suites on one Mac slow each other into timeouts:\n${busy.runs.map((line) => `  ${line}`).join('\n')}\nWait for it, or pass --skip-busy-check.\n`,
    );
    return EXIT.refused;
  }
  const otherRuns =
    busy.kind === 'failed'
      ? `NOT CHECKED (${busy.reason})`
      : busy.runs.length > 0
        ? `${busy.runs.length} RUNNING (run anyway)`
        : 'none (checked with ps)';

  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const dir = resolve(options.out ?? join(stateDir(), stamp));
  const markerDir = join(dir, 'markers');
  const sampleDir = join(dir, 'samples');
  mkdirSync(markerDir, {recursive: true});
  const junitPath = join(dir, 'junit.xml');
  const consolePath = join(dir, 'console.txt');

  const caffeinate = Bun.which('caffeinate');
  const command = [
    ...(caffeinate == null ? [] : [caffeinate, '-i']),
    process.execPath,
    'test',
    `--parallel=${options.workers}`,
    '--reporter=junit',
    `--reporter-outfile=${junitPath}`,
    ...options.extra,
  ];
  const env: Record<string, string | undefined> = {
    ...process.env,
    [TEST_MARKER_ENV]: markerDir,
  };

  write(
    `test-parallel: ${options.workers} workers in ${options.cwd}\n  limit: ${options.limitSeconds} s\n  stall: ${options.stallSeconds === 0 ? 'off' : `${options.stallSeconds} s without a marker record, or in one test`}\n  output: ${dir}\n  ${caffeinate == null ? 'WITHOUT caffeinate (not found): the Mac may sleep' : 'under caffeinate -i'}`,
  );
  const loadAverageStart = loadavg();
  const startedAt = new Date();
  const started = performance.now();
  const consoleFd = openSync(consolePath, 'w');
  // Its own process group, so a child whose parent died (and was reparented
  // to launchd) is still found and stopped by the group.
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    detached: true,
    env,
    stderr: consoleFd,
    stdin: 'ignore',
    stdout: consoleFd,
  });

  let interrupted: NodeJS.Signals | null = null;
  let stalls: Stall[] = [];
  let wake: (reason: StopReason) => void = () => undefined;
  const stop = new Promise<StopReason>((resolveStop) => {
    wake = resolveStop;
  });
  const timer = setTimeout(() => {
    wake('limit');
  }, options.limitSeconds * 1000);
  // THE STALL CHECK (home-base-ejsq2.6, ejsq2.8): poll the markers; when a
  // live worker has written no record, or stayed in one test, for --stall
  // seconds, stop the run as the wall limit does. ps runs only when the
  // markers name a candidate.
  const stallMs = options.stallSeconds * 1000;
  const readMarkers = createMarkerReader(markerDir);
  let stallProblem: null | string = null;
  let polling = false;
  const pollOnce = async (): Promise<void> => {
    const states = readMarkers();
    if (states == null) return;
    const nowMs = Date.now();
    const everyone = new Set(states.map((state) => state.pid));
    if (stalledTests(states, {alive: everyone, nowMs, stallMs}).length === 0) {
      return;
    }
    const rows = await readPsRows();
    if (rows == null) {
      if (stallProblem == null) {
        stallProblem =
          'ps failed, so a stuck worker was left to the wall limit';
        write(`test-parallel: stall check: ${stallProblem}`);
      }
      return;
    }
    const found = stalledTests(states, {
      alive: new Set(processTree(rows, child.pid, child.pid, process.pid)),
      nowMs,
      stallMs,
    });
    if (found.length > 0) {
      stalls = found;
      wake('stall');
    }
  };
  const poll =
    stallMs === 0
      ? null
      : setInterval(() => {
          // One poll at a time: a slow ps never stacks a second one on top.
          if (polling) return;
          polling = true;
          void pollOnce().finally(() => {
            polling = false;
          });
        }, stallPollMs(stallMs));
  const onSignal = (name: NodeJS.Signals): void => {
    interrupted = name;
    wake('signal');
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const outcome = await Promise.race([
    child.exited.then(() => 'exited' as const),
    stop,
  ]);
  clearTimeout(timer);
  if (poll != null) clearInterval(poll);
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);

  if (outcome !== 'exited') {
    const nowMs = Date.now();
    const states = readMarkerDir(markerDir);
    const rows = await readPsRows();
    const tree =
      rows == null
        ? null
        : processTree(rows, child.pid, child.pid, process.pid);
    const alive = new Set(tree ?? []);
    const testProcesses = (states ?? []).filter((state) =>
      alive.has(state.pid),
    );
    // Each live test process's own children, with their ps state: a `Z` is a
    // child that exited and was never reaped (bun issue #34069, the spin).
    const childrenOf = (
      pid: number,
    ): {args: string; pid: number; stat: string}[] =>
      (rows ?? [])
        .filter((row) => row.ppid === pid)
        .map((row) => ({args: row.args, pid: row.pid, stat: row.stat}));
    mkdirSync(sampleDir, {recursive: true});
    const samples =
      outcome !== 'signal'
        ? await Promise.all(
            testProcesses.map(async (state) => ({
              pid: state.pid,
              result: await sampleProcess(
                state.pid,
                options.sampleSeconds,
                join(sampleDir, `${state.pid}.txt`),
              ),
            })),
          )
        : [];
    const stopResult = await stopTree(child.pid, child.pid);
    await Promise.race([child.exited, Bun.sleep(5000)]);
    closeSync(consoleFd);
    const wallSeconds = (performance.now() - started) / 1000;

    const lines: string[] = [];
    lines.push('');
    lines.push(
      sectionHeader(
        outcome === 'limit'
          ? `Stopped: the run passed its ${options.limitSeconds} s limit`
          : outcome === 'stall'
            ? `Stopped: a worker wrote no marker record, or stayed in one test, for more than ${options.stallSeconds} s`
            : `Stopped: this script got ${interrupted ?? 'a signal'}`,
        {color: style.color, emoji: '🛑'},
      ),
    );
    lines.push('');
    for (const stall of stalls) {
      lines.push(`${pad(BODY_COLUMN)}${describeStall(stall)}`);
      lines.push('');
    }
    if (states == null) {
      lines.push(
        `${pad(BODY_COLUMN)}The marker directory could not be read (${markerDir}): which test each worker was in is unknown.`,
      );
    } else if (testProcesses.length === 0) {
      lines.push(
        `${pad(BODY_COLUMN)}No test process was alive when the run was stopped${tree == null ? ' (ps failed, so this is unknown)' : ''}.`,
      );
    }
    for (const state of testProcesses) {
      const sample = samples.find((entry) => entry.pid === state.pid);
      const children = childrenOf(state.pid);
      lines.push(
        fieldLines(
          [
            {
              label: `pid ${state.pid}`,
              value: describeProcess(state, {cwd: options.cwd, nowMs}),
            },
            ...(sample == null
              ? []
              : [{label: 'sample', value: sample.result}]),
            {
              label: 'children',
              value:
                rows == null
                  ? 'unknown (ps failed)'
                  : children.length === 0
                    ? 'none'
                    : children
                        .map((row) => `${row.pid} ${row.stat} ${row.args}`)
                        .join('; '),
            },
          ],
          {color: style.color, indent: BODY_COLUMN, width: style.width},
        ),
      );
      lines.push('');
    }
    const leftovers = stopResult.leftovers;
    lines.push(
      fieldLines(
        [
          {
            label: 'stopped',
            value: `${stopResult.stopped.length} processes (SIGSTOP, then SIGKILL)`,
          },
          {
            label: 'left alive',
            value:
              leftovers == null
                ? `UNKNOWN: ${stopResult.problem ?? 'ps failed after the kill'}`
                : leftovers.length === 0
                  ? 'none (checked with ps)'
                  : leftovers.map((row) => `${row.pid} ${row.args}`).join('; '),
          },
          {label: 'wall', value: `${wallSeconds.toFixed(1)} s`},
          {label: 'output', value: dir},
        ],
        {color: style.color, indent: BODY_COLUMN, width: style.width},
      ),
    );
    write(lines.join('\n'));
    writeFileSync(
      join(dir, 'run.json'),
      `${JSON.stringify(
        {
          command,
          commit: await gitHead(options.cwd),
          cwd: options.cwd,
          endedAt: new Date().toISOString(),
          leftovers,
          limitSeconds: options.limitSeconds,
          loadAverageEnd: loadavg(),
          loadAverageStart,
          otherTestRuns: otherRuns,
          outcome:
            outcome === 'limit'
              ? 'stopped-at-limit'
              : outcome === 'stall'
                ? 'stopped-stalled'
                : 'interrupted',
          running: testProcesses.map((state) => ({
            children: rows == null ? null : childrenOf(state.pid),
            name: state.name,
            pid: state.pid,
            record: state.last,
            testStartedAtMs: state.testStartedAtMs,
            where: state.where,
          })),
          samples,
          stallCheckProblem: stallProblem,
          stallSeconds: options.stallSeconds,
          stalled: stalls.map((stall) => ({
            name: stall.name,
            pid: stall.pid,
            seconds: stall.seconds,
            where: stall.where,
          })),
          startedAt: startedAt.toISOString(),
          stopped: stopResult.stopped,
          wallSeconds,
          workers: options.workers,
        },
        null,
        2,
      )}\n`,
    );
    return outcome === 'limit'
      ? EXIT.stopped
      : outcome === 'stall'
        ? EXIT.stalled
        : EXIT.interrupted;
  }

  const exitCode = await child.exited;
  closeSync(consoleFd);
  const usage = child.resourceUsage();
  const wallSeconds = (performance.now() - started) / 1000;
  const loadAverageEnd = loadavg();
  const junit = existsSync(junitPath)
    ? await parseJunit(readFileSync(junitPath, 'utf8'))
    : null;
  const consoleText = readFileSync(consolePath, 'utf8');
  const cpuUser = usage == null ? null : Number(usage.cpuTime.user) / 1e6;
  const cpuSystem = usage == null ? null : Number(usage.cpuTime.system) / 1e6;
  const meta = {
    command,
    commit: await gitHead(options.cwd),
    cpuSystemSeconds: cpuSystem,
    cpuUserSeconds: cpuUser,
    cwd: options.cwd,
    endedAt: new Date().toISOString(),
    exitCode,
    junit:
      junit == null
        ? null
        : {
            failures: junit.failures,
            files: junit.files.length,
            skipped: junit.skipped,
            tests: junit.testsTotal,
          },
    limitSeconds: options.limitSeconds,
    loadAverageEnd,
    loadAverageStart,
    otherTestRuns: otherRuns,
    outcome: exitCode === 0 ? 'green' : 'failed',
    stallCheckProblem: stallProblem,
    stallSeconds: options.stallSeconds,
    startedAt: startedAt.toISOString(),
    wallSeconds,
    workers: options.workers,
  };
  writeFileSync(join(dir, 'run.json'), `${JSON.stringify(meta, null, 2)}\n`);

  const load = (values: number[]): string =>
    values.map((value) => value.toFixed(1)).join(' ');
  write('');
  write(
    sectionHeader(exitCode === 0 ? 'Green' : `bun test exited ${exitCode}`, {
      color: style.color,
      emoji: exitCode === 0 ? '✅' : '❌',
    }),
  );
  write('');
  write(
    fieldLines(
      [
        {label: 'wall', value: `${wallSeconds.toFixed(1)} s`},
        {
          label: 'cpu',
          value:
            cpuUser == null || cpuSystem == null
              ? 'unknown (no resource usage)'
              : `${cpuUser.toFixed(1)} s user + ${cpuSystem.toFixed(1)} s sys`,
        },
        {
          label: 'load',
          value: `${load(loadAverageStart)} → ${load(loadAverageEnd)}`,
        },
        {
          label: 'tests',
          value:
            junit == null
              ? 'unknown (no junit file)'
              : `${junit.testsTotal} in ${junit.files.length} files, ${junit.failures} failed, ${junit.skipped} skipped`,
        },
        {label: 'output', value: dir},
      ],
      {color: style.color, indent: BODY_COLUMN, width: style.width},
    ),
  );
  const summary = summaryLines(consoleText);
  if (summary.length > 0) {
    write('');
    write(
      summary.map((line) => `${pad(BODY_COLUMN)}${line.trim()}`).join('\n'),
    );
  }
  if (exitCode !== 0) {
    write('');
    write(
      `${pad(BODY_COLUMN)}${paint('The full output:', ['bold'], style.color)} ${consolePath}`,
    );
  }
  return exitCode === 0 ? EXIT.green : EXIT.failed;
}

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

const USAGE = `test-parallel — the justin-sdk suite in parallel workers, with a wall-clock watchdog (home-base-ejsq2.4)

  bun run test:parallel [--workers N] [--limit SECONDS] [--stall SECONDS] [--out DIR] [-- <bun test args>]

Runs bun test --parallel=N in pkg/justin-sdk under caffeinate -i, with the junit reporter and the current-test marker on. It refuses while another bun test runs on this Mac, and it needs the Claude Code sandbox off (ps and the suite both do).

When a worker has written no marker record, or stayed inside one test, for --stall seconds (default ${DEFAULT_STALL_SECONDS}, above every explicit timeout in tests/ and every gap a green run leaves), or the run passes --limit (default ${DEFAULT_LIMIT_SECONDS}), it names the test each worker is in and that worker's child processes, samples each live test process (sample <pid> <seconds>), stops the whole process tree and exits ${EXIT.stalled} or ${EXIT.stopped}. On bun 1.4.2 the stall is bun issue #34069 (Bun.spawnSync spins beside an unreaped child, fixed in bun 1.4.3); bun run test:parallel:symbolize names the frames of a sample.

Exit codes: ${EXIT.green} green; ${EXIT.failed} bun test failed; ${EXIT.refused} refused (another bun test, or ps could not check); ${EXIT.stalled} stopped by the stall check; ${EXIT.stopped} stopped at the limit; ${EXIT.interrupted} interrupted.

The serial run sdk:publish uses is unchanged: bun test.`;

async function main(): Promise<number> {
  let code = EXIT.green as number;
  await yargs(hideBin(process.argv))
    .scriptName('test-parallel')
    .usage(USAGE)
    .wrap(null)
    .parserConfiguration({'populate--': true})
    .option('workers', {
      default: DEFAULT_WORKERS,
      describe: 'Worker processes (bun test --parallel=N)',
      type: 'number',
    })
    .option('limit', {
      default: DEFAULT_LIMIT_SECONDS,
      describe: 'Wall-clock limit in seconds; past it the run is stopped',
      type: 'number',
    })
    .option('stall', {
      default: DEFAULT_STALL_SECONDS,
      describe:
        'Seconds a worker may go without a marker record, or stay inside one test, before the run is stopped; 0 turns the check off',
      type: 'number',
    })
    .option('sample-seconds', {
      default: DEFAULT_SAMPLE_SECONDS,
      describe: 'Seconds of `sample` per live test process when stopped',
      type: 'number',
    })
    .option('out', {
      describe:
        'Output directory (default: $XDG_STATE_HOME/justin-sdk/test-parallel/<stamp>)',
      type: 'string',
    })
    .option('cwd', {
      describe:
        'Run bun test in another directory (the negative control uses a fixture suite)',
      type: 'string',
    })
    .option('skip-busy-check', {
      default: false,
      describe: 'Run even when another bun test is running or ps cannot tell',
      type: 'boolean',
    })
    .check((args) => {
      if (!Number.isInteger(args.workers) || args.workers < 1) {
        throw new Error('--workers must be a whole number of at least 1');
      }
      if (!(args.limit > 0)) throw new Error('--limit must be above 0');
      if (!(args.stall >= 0)) {
        throw new Error('--stall must be 0 (off) or more');
      }
      if (!(Number(args['sample-seconds']) > 0)) {
        throw new Error('--sample-seconds must be above 0');
      }
      return true;
    })
    .strict()
    .help()
    .parseAsync()
    .then(async (args) => {
      const passthrough: unknown = args['--'];
      code = await run({
        cwd: resolve(args.cwd ?? PACKAGE_ROOT),
        extra: Array.isArray(passthrough) ? passthrough.map(String) : [],
        limitSeconds: args.limit,
        out: args.out ?? null,
        sampleSeconds: args.sampleSeconds,
        skipBusyCheck: args.skipBusyCheck,
        stallSeconds: args.stall,
        workers: args.workers,
      });
    });
  return code;
}

if (import.meta.main) {
  process.exitCode = await main();
}
