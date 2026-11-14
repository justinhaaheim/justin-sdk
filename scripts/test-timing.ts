#!/usr/bin/env bun
/**
 * Where does the justin-sdk test suite spend its time? (home-base-ejsq2.1)
 *
 *   run      runs the whole suite (`bun test` in this package) with bun's junit
 *            reporter and the subprocess recorder (tests/spawn-recorder.ts),
 *            under `caffeinate -i`, after checking that no other `bun test` is
 *            running; then prints the report.
 *   report   reads a junit file and, if there is one, a spawn log, and prints
 *            the report. Runs nothing.
 *   costs    times single calls of br, git, bun and mise in fresh temp
 *            directories, which it removes. Runs no test.
 *
 * The report: the run's wall time, time by command (br, git, bun, mise, other)
 * with count, total, mean and share of the summed file time, what each command
 * was doing, the slowest files with their in-process / subprocess split, the
 * slowest tests, and what the spawn log could not see. With no spawn log it
 * says so instead of printing zero shares (critical rule 7).
 *
 * `run` writes only under its output directory (default
 * `$XDG_STATE_HOME/justin-sdk/test-timing/<stamp>/`): run.json, junit.xml,
 * spawns.jsonl, console.txt. The suite itself writes what it always writes.
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {homedir, loadavg, tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import yargs from 'yargs';
import {hideBin} from 'yargs/helpers';
import {z} from 'zod';

import {
  BODY_COLUMN,
  fieldLines,
  type OutputStyle,
  outputStyle,
  pad,
  padEndWidth,
  paint,
  sectionHeader,
  stepColumn,
} from '../src/cli-style';
import {SPAWN_LOG_ENV, SPAWN_LOG_VERSION} from '../tests/spawn-recorder';

/** This package: scripts/ → justin-sdk/. The suite runs here. */
const PACKAGE_ROOT = resolve(import.meta.dir, '..');
/** home-base's root, where mise.toml pins br. */
const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..');

const FILE_NAMES = {
  console: 'console.txt',
  junit: 'junit.xml',
  run: 'run.json',
  spawns: 'spawns.jsonl',
} as const;

// ---------------------------------------------------------------------------
// junit
// ---------------------------------------------------------------------------

export interface TestTiming {
  failed: boolean;
  file: string;
  name: string;
  seconds: number;
}

export interface FileTiming {
  failures: number;
  file: string;
  /** The file's junit time: its tests, its hooks (beforeAll included). */
  seconds: number;
  tests: number;
}

export interface JunitRun {
  failures: number;
  files: FileTiming[];
  skipped: number;
  tests: TestTiming[];
  testsTotal: number;
  /** `<testsuites time>`: the runner's own total, imports included. */
  totalSeconds: number | null;
}

function decodeEntities(text: string): string {
  return text.replace(
    /&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/gu,
    (_match, dec?: string, hex?: string, name?: string) => {
      if (dec != null) return String.fromCodePoint(Number(dec));
      if (hex != null) return String.fromCodePoint(Number.parseInt(hex, 16));
      const named: Record<string, string> = {
        amp: '&',
        apos: "'",
        gt: '>',
        lt: '<',
        quot: '"',
      };
      return named[name ?? ''] ?? _match;
    },
  );
}

/** A junit number attribute; null when absent or not a number. */
function numberAttr(value: string | null): number | null {
  if (value == null || !/^-?\d+(?:\.\d+)?(?:e[-+]?\d+)?$/iu.test(value)) {
    return null;
  }
  return Number(value);
}

/**
 * bun's junit report, read with Bun's built-in HTMLRewriter (no XML
 * dependency). A file's own `<testsuite>` is the one with no `line`
 * attribute; describe blocks nest inside it and carry one.
 */
export async function parseJunit(xml: string): Promise<JunitRun> {
  const files: FileTiming[] = [];
  const tests: TestTiming[] = [];
  let totalSeconds: number | null = null;
  let testsTotal = 0;
  let failures = 0;
  let skipped = 0;
  await new HTMLRewriter()
    .on('testsuites', {
      element(element) {
        totalSeconds = numberAttr(element.getAttribute('time'));
        testsTotal = numberAttr(element.getAttribute('tests')) ?? 0;
        failures = numberAttr(element.getAttribute('failures')) ?? 0;
        skipped = numberAttr(element.getAttribute('skipped')) ?? 0;
      },
    })
    .on('testsuite', {
      element(element) {
        if (element.getAttribute('line') != null) return;
        files.push({
          failures: numberAttr(element.getAttribute('failures')) ?? 0,
          file: decodeEntities(
            element.getAttribute('file') ?? element.getAttribute('name') ?? '',
          ),
          seconds: numberAttr(element.getAttribute('time')) ?? 0,
          tests: numberAttr(element.getAttribute('tests')) ?? 0,
        });
      },
    })
    .on('testcase', {
      element(element) {
        tests.push({
          failed: false,
          file: decodeEntities(element.getAttribute('file') ?? ''),
          name: decodeEntities(element.getAttribute('name') ?? ''),
          seconds: numberAttr(element.getAttribute('time')) ?? 0,
        });
      },
    })
    .on('failure', {
      element() {
        const last = tests.at(-1);
        if (last != null) last.failed = true;
      },
    })
    .transform(new Response(xml))
    .text();
  return {failures, files, skipped, tests, testsTotal, totalSeconds};
}

// ---------------------------------------------------------------------------
// The spawn log
// ---------------------------------------------------------------------------

const factsShape = {
  api: z.enum(['spawn', 'spawnSync']),
  argc: z.number().nullable(),
  args: z.array(z.string()),
  cmd: z.string().nullable(),
  cwd: z.string().nullable(),
  file: z.string().nullable(),
  fileFrom: z.enum(['running', 'stack']).nullable(),
  id: z.number(),
  mode: z.enum(['async', 'sync']),
  pid: z.number(),
  readError: z.string().nullable(),
  resolved: z.string().nullable(),
  runningFile: z.string().nullable(),
  startMs: z.number(),
  via: z.string().nullable(),
};

const LogLineSchema = z.discriminatedUnion('kind', [
  z.object({
    ...factsShape,
    durationMs: z.number(),
    error: z.string().nullable(),
    exitCode: z.number().nullable(),
    kind: z.literal('call'),
    outcome: z.enum(['returned', 'threw']),
  }),
  z.object({...factsShape, kind: z.literal('start')}),
  z.object({
    durationMs: z.number(),
    exitCode: z.number().nullable(),
    id: z.number(),
    kind: z.literal('end'),
    outcome: z.enum(['exit-rejected', 'exited']),
    pid: z.number(),
  }),
  z.object({
    bun: z.string(),
    cwd: z.string(),
    kind: z.literal('session'),
    pid: z.number(),
    startMs: z.number(),
    v: z.number(),
  }),
]);

type LogLine = z.infer<typeof LogLineSchema>;
type Facts = Extract<LogLine, {kind: 'start'}>;

/** One subprocess, its start and end merged. */
export interface Spawn {
  api: Facts['api'];
  args: string[];
  cmd: string | null;
  cwd: string | null;
  /** null: the end was never seen (unfinished), never a 0. */
  durationMs: number | null;
  exitCode: number | null;
  file: string | null;
  fileFrom: Facts['fileFrom'];
  mode: Facts['mode'];
  outcome: 'exit-rejected' | 'exited' | 'returned' | 'threw' | 'unfinished';
  readError: string | null;
  resolved: string | null;
  runningFile: string | null;
  startMs: number;
  via: string | null;
}

export interface SpawnLog {
  /** Lines that were not a valid record, with why; never dropped silently. */
  malformed: {line: number; reason: string}[];
  processes: number;
  spawns: Spawn[];
  /** Session records whose version this reader does not know. */
  unknownVersions: number[];
}

export function parseSpawnLog(text: string): SpawnLog {
  const malformed: SpawnLog['malformed'] = [];
  const unknownVersions: number[] = [];
  const pids = new Set<number>();
  const starts = new Map<string, Facts>();
  const ends = new Map<string, Extract<LogLine, {kind: 'end'}>>();
  const spawns: Spawn[] = [];
  const lines = text.split('\n');
  for (const [index, raw] of lines.entries()) {
    if (raw.trim() === '') continue;
    let parsed: LogLine;
    try {
      const result = LogLineSchema.safeParse(JSON.parse(raw));
      if (!result.success) {
        malformed.push({line: index + 1, reason: result.error.message});
        continue;
      }
      parsed = result.data;
    } catch (error) {
      malformed.push({
        line: index + 1,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    pids.add(parsed.pid);
    if (parsed.kind === 'session') {
      if (parsed.v !== SPAWN_LOG_VERSION) unknownVersions.push(parsed.v);
    } else if (parsed.kind === 'start') {
      starts.set(`${parsed.pid}:${parsed.id}`, parsed);
    } else if (parsed.kind === 'end') {
      ends.set(`${parsed.pid}:${parsed.id}`, parsed);
    } else {
      spawns.push({...parsed});
    }
  }
  for (const [key, start] of starts) {
    const end = ends.get(key);
    spawns.push({
      ...start,
      durationMs: end?.durationMs ?? null,
      exitCode: end?.exitCode ?? null,
      outcome: end?.outcome ?? 'unfinished',
    });
  }
  spawns.sort((a, b) => a.startMs - b.startMs);
  return {malformed, processes: pids.size, spawns, unknownVersions};
}

// ---------------------------------------------------------------------------
// Classifying a spawn
// ---------------------------------------------------------------------------

export type CommandGroup = 'br' | 'bun' | 'git' | 'mise' | 'other';
export const GROUPS: readonly CommandGroup[] = [
  'br',
  'git',
  'bun',
  'mise',
  'other',
];

const SHELLS = new Set(['bash', 'dash', 'sh', 'zsh']);

/**
 * The program a spawn really ran: argv[0], or for `sh -c '<script>'` the
 * script's first word (after `VAR=value` assignments and an `exec`).
 * Best-effort: a script that starts with `cd x &&` is labelled `cd`.
 */
export function programOf(spawn: Pick<Spawn, 'args' | 'cmd'>): {
  program: string;
  rest: string[];
  shell: boolean;
} {
  const cmd = spawn.cmd ?? '(unreadable)';
  const script = spawn.args[1];
  if (SHELLS.has(cmd) && spawn.args[0] === '-c' && script != null) {
    const words = script.trim().split(/\s+/u);
    let at = 0;
    while (at < words.length && /^[A-Za-z_]\w*=/u.test(words[at] ?? '')) {
      at += 1;
    }
    if (words[at] === 'exec') at += 1;
    const first = (words[at] ?? '').replace(/^['"]|['"]$/gu, '');
    return {
      program: first === '' ? cmd : basename(first),
      rest: words.slice(at + 1),
      shell: true,
    };
  }
  return {program: cmd, rest: spawn.args, shell: false};
}

export function groupOf(program: string): CommandGroup {
  if (program === 'br') return 'br';
  if (program === 'git') return 'git';
  if (program === 'bun' || program === 'bunx') return 'bun';
  if (program === 'mise') return 'mise';
  return 'other';
}

/** The first word that is not an option; `valueFlags` take the next word. */
function firstWord(
  words: readonly string[],
  valueFlags: ReadonlySet<string>,
): string | null {
  for (let at = 0; at < words.length; at += 1) {
    const word = words[at] ?? '';
    if (valueFlags.has(word)) {
      at += 1;
      continue;
    }
    if (!word.startsWith('-')) return word;
  }
  return null;
}

const BR_VALUE_FLAGS = new Set(['--actor', '--db']);
const GIT_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree']);

/** What a spawn of `program` was doing: its subcommand, or what bun ran. */
export function subcommandOf(program: string, rest: readonly string[]): string {
  if (program === 'br') return firstWord(rest, BR_VALUE_FLAGS) ?? '(none)';
  if (program === 'git') return firstWord(rest, GIT_VALUE_FLAGS) ?? '(none)';
  if (program === 'bun' || program === 'bunx') {
    const first = rest[0] ?? '(none)';
    if (/\.[cm]?[jt]sx?$/u.test(first)) {
      const words = rest
        .slice(1)
        .filter((word) => !word.startsWith('-'))
        .slice(0, 2);
      return [basename(first), ...words].join(' ');
    }
    const head = rest.slice(0, 2).join(' ');
    return head === '' ? '(none)' : head;
  }
  return program;
}

/** Where argv[0] was found: the mise install, a mise shim, a temp fixture, or its directory. */
export function locationOf(resolved: string | null): string {
  if (resolved == null) return 'not found on PATH';
  if (resolved.includes('/mise/installs/')) return 'mise install (direct)';
  if (resolved.includes('/mise/shims/')) return 'mise shim';
  const temp = [
    tmpdir(),
    '/tmp/',
    '/private/tmp/',
    '/var/folders/',
    '/private/var/folders/',
  ];
  if (temp.some((prefix) => resolved.startsWith(prefix))) {
    return 'a temp directory (a test fixture)';
  }
  return dirname(resolved);
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export interface Row {
  calls: number;
  label: string;
  /** Mean of the measured durations; null when none was measured. */
  meanMs: number | null;
  totalMs: number;
  /** Spawns with no measured duration (unfinished). Not in totalMs. */
  unmeasured: number;
}

export interface FileRow {
  brCalls: number;
  file: string;
  /** file time − subprocess union; null when the spawn log was absent. */
  inProcessSeconds: number | null;
  seconds: number;
  spawns: number | null;
  subprocessSeconds: number | null;
  subprocessUnionSeconds: number | null;
  tests: number;
}

export interface SpawnAnalysis {
  async: number;
  byGroup: Row[];
  inside: {group: CommandGroup; location: Row[]; subcommand: Row[]}[];
  /** Spawns whose stack named a test file other than the one running. */
  leaked: number;
  malformed: SpawnLog['malformed'];
  noFile: number;
  processes: number;
  readErrors: number;
  /** Spawns credited to the running file because no test frame was on the stack. */
  running: number;
  shell: number;
  sumMs: number;
  sync: number;
  threw: number;
  total: number;
  unfinished: number;
  unionMs: number;
  unknownVersions: number[];
}

export interface Analysis {
  files: FileRow[];
  junit: {
    failures: number;
    fileSeconds: number;
    files: number;
    skipped: number;
    testSeconds: number;
    tests: number;
    totalSeconds: number | null;
  };
  slowestTests: TestTiming[];
  /** null: no spawn log was given. Never a set of zeros. */
  spawns: SpawnAnalysis | null;
  /** Rows each ranking prints. `files` holds every file, for --json. */
  top: number;
}

/** Total time covered by possibly overlapping [start, start + duration] spans. */
export function unionMs(
  spans: readonly {durationMs: number; startMs: number}[],
): number {
  const sorted = [...spans].sort((a, b) => a.startMs - b.startMs);
  let covered = 0;
  let openStart: number | null = null;
  let openEnd = 0;
  for (const span of sorted) {
    const end = span.startMs + span.durationMs;
    if (openStart == null || span.startMs > openEnd) {
      if (openStart != null) covered += openEnd - openStart;
      openStart = span.startMs;
      openEnd = end;
    } else if (end > openEnd) {
      openEnd = end;
    }
  }
  if (openStart != null) covered += openEnd - openStart;
  return covered;
}

function measured(spawn: Spawn): spawn is Spawn & {durationMs: number} {
  return spawn.durationMs != null;
}

function rowsBy(
  spawns: readonly Spawn[],
  label: (spawn: Spawn) => string,
): Row[] {
  const rows = new Map<string, Row>();
  for (const spawn of spawns) {
    const key = label(spawn);
    const row = rows.get(key) ?? {
      calls: 0,
      label: key,
      meanMs: null,
      totalMs: 0,
      unmeasured: 0,
    };
    row.calls += 1;
    if (spawn.durationMs == null) row.unmeasured += 1;
    else row.totalMs += spawn.durationMs;
    rows.set(key, row);
  }
  for (const row of rows.values()) {
    const timed = row.calls - row.unmeasured;
    row.meanMs = timed === 0 ? null : row.totalMs / timed;
  }
  return [...rows.values()].sort((a, b) => b.totalMs - a.totalMs);
}

export function analyse(
  junit: JunitRun,
  log: SpawnLog | null,
  top: number,
): Analysis {
  const fileSeconds = junit.files.reduce((sum, file) => sum + file.seconds, 0);
  const testSeconds = junit.tests.reduce((sum, test) => sum + test.seconds, 0);
  const byFile = new Map<string, Spawn[]>();
  for (const spawn of log?.spawns ?? []) {
    const key = spawn.file ?? '(no test file)';
    const list = byFile.get(key) ?? [];
    list.push(spawn);
    byFile.set(key, list);
  }
  const files: FileRow[] = junit.files
    .map((file) => {
      if (log == null) {
        return {
          brCalls: 0,
          file: file.file,
          inProcessSeconds: null,
          seconds: file.seconds,
          spawns: null,
          subprocessSeconds: null,
          subprocessUnionSeconds: null,
          tests: file.tests,
        };
      }
      const own = byFile.get(file.file) ?? [];
      const timed = own.filter(measured);
      const union = unionMs(timed) / 1000;
      return {
        brCalls: own.filter((spawn) => programOf(spawn).program === 'br')
          .length,
        file: file.file,
        inProcessSeconds: file.seconds - union,
        seconds: file.seconds,
        spawns: own.length,
        subprocessSeconds:
          timed.reduce((sum, s) => sum + s.durationMs, 0) / 1000,
        subprocessUnionSeconds: union,
        tests: file.tests,
      };
    })
    .sort((a, b) => b.seconds - a.seconds);

  let spawns: SpawnAnalysis | null = null;
  if (log != null) {
    const all = log.spawns;
    const timed = all.filter(measured);
    const groupOfSpawn = (spawn: Spawn): CommandGroup =>
      groupOf(programOf(spawn).program);
    spawns = {
      async: all.filter((s) => s.mode === 'async').length,
      byGroup: GROUPS.map(
        (group) =>
          rowsBy(
            all.filter((s) => groupOfSpawn(s) === group),
            () => group,
          )[0] ?? {
            calls: 0,
            label: group,
            meanMs: null,
            totalMs: 0,
            unmeasured: 0,
          },
      ),
      inside: GROUPS.map((group) => {
        const own = all.filter((s) => groupOfSpawn(s) === group);
        return {
          group,
          location: rowsBy(own, (s) => locationOf(s.resolved)).slice(0, top),
          subcommand: rowsBy(own, (s) => {
            const {program, rest, shell} = programOf(s);
            const what =
              group === 'other' ? program : subcommandOf(program, rest);
            return shell ? `${what} (via sh -c)` : what;
          }).slice(0, top),
        };
      }),
      leaked: all.filter(
        (s) =>
          s.fileFrom === 'stack' &&
          s.runningFile != null &&
          s.runningFile !== s.file,
      ).length,
      malformed: log.malformed,
      noFile: all.filter((s) => s.file == null).length,
      processes: log.processes,
      readErrors: all.filter((s) => s.readError != null).length,
      running: all.filter((s) => s.fileFrom === 'running').length,
      shell: all.filter((s) => programOf(s).shell).length,
      sumMs: timed.reduce((sum, s) => sum + s.durationMs, 0),
      sync: all.filter((s) => s.mode === 'sync').length,
      threw: all.filter((s) => s.outcome === 'threw').length,
      total: all.length,
      unfinished: all.filter((s) => s.outcome === 'unfinished').length,
      unionMs: unionMs(timed),
      unknownVersions: log.unknownVersions,
    };
  }

  return {
    files,
    junit: {
      failures: junit.failures,
      fileSeconds,
      files: junit.files.length,
      skipped: junit.skipped,
      testSeconds,
      tests: junit.testsTotal,
      totalSeconds: junit.totalSeconds,
    },
    slowestTests: [...junit.tests]
      .sort((a, b) => b.seconds - a.seconds)
      .slice(0, top),
    spawns,
    top,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** What `run` records about itself, beside the junit file. */
const RunMetaSchema = z.object({
  bun: z.string(),
  caffeinate: z.boolean(),
  command: z.array(z.string()),
  commit: z.string().nullable(),
  commitError: z.string().nullable(),
  cpuSystemSeconds: z.number().nullable(),
  cpuUserSeconds: z.number().nullable(),
  dirtyPaths: z.number().nullable(),
  endedAt: z.string(),
  exitCode: z.number().nullable(),
  loadAverageEnd: z.array(z.number()),
  loadAverageStart: z.array(z.number()),
  otherTestRuns: z.string(),
  recorder: z.boolean(),
  startedAt: z.string(),
  wallSeconds: z.number(),
});
export type RunMeta = z.infer<typeof RunMetaSchema>;

/** `bun test`'s own summary lines, from its console output. */
export function consoleCounts(
  text: string,
): {fail: number; pass: number} | null {
  const pass = /^\s*(\d+) pass$/mu.exec(text)?.[1];
  const fail = /^\s*(\d+) fail$/mu.exec(text)?.[1];
  if (pass == null || fail == null) return null;
  return {fail: Number(fail), pass: Number(pass)};
}

function seconds(value: number): string {
  return `${value.toFixed(1)} s`;
}

function percent(part: number, whole: number): string {
  return whole > 0 ? `${((100 * part) / whole).toFixed(1)}%` : 'n/a';
}

function minutes(value: number): string {
  const whole = Math.round(value);
  return `${Math.floor(whole / 60)} min ${whole % 60} s`;
}

/**
 * Rows of columns: numbers right-aligned, the LAST column left-aligned and
 * never padded, so a long name cannot push the numbers out of line.
 */
function table(
  header: readonly string[],
  rows: readonly (readonly string[])[],
  style: OutputStyle,
  indent = BODY_COLUMN,
): string {
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => (row[column] ?? '').length)),
  );
  // A column of numbers (or n/a) is right-aligned; any other column, left.
  const numeric = header.map((_title, column) =>
    rows.every((row) =>
      /^(?:-?[\d.]+(?: s|%)?|n\/a|below 0|)$/u.test(row[column] ?? ''),
    ),
  );
  const line = (cells: readonly string[]): string =>
    pad(indent) +
    cells
      .map((cell, column) => {
        if (column === cells.length - 1) return cell;
        const width = widths[column] ?? 0;
        return numeric[column] === true
          ? cell.padStart(width)
          : padEndWidth(cell, width);
      })
      .join('   ');
  const headerLine = paint(line(header), ['dim'], style.color);
  return [headerLine, ...rows.map(line)].join('\n');
}

function rowCells(row: Row, wholeMs: number): string[] {
  return [
    row.label,
    String(row.calls),
    (row.totalMs / 1000).toFixed(1),
    row.meanMs == null ? 'n/a' : row.meanMs.toFixed(1),
    percent(row.totalMs, wholeMs),
    row.unmeasured === 0 ? '' : `${row.unmeasured} unfinished`,
  ];
}

const ROW_HEADER = ['', 'calls', 'total s', 'mean ms', 'share', ''];

export function renderReport(
  analysis: Analysis,
  context: {
    console: {fail: number; pass: number} | null;
    meta: RunMeta | null;
    source: string;
  },
  style: OutputStyle,
): string {
  const {junit, spawns} = analysis;
  const wholeMs = junit.fileSeconds * 1000;
  const sections: string[] = [];
  const fieldOptions = {
    color: style.color,
    indent: BODY_COLUMN,
    width: style.width,
  };

  const meta = context.meta;
  const runFields = [
    {label: 'read from', value: context.source},
    ...(meta == null
      ? [
          {
            label: 'run facts',
            value:
              'none (no run.json: only the junit file and spawn log were read)',
          },
        ]
      : [
          {
            label: 'commit',
            value:
              meta.commit == null
                ? `unknown (${meta.commitError ?? 'not recorded'})`
                : `${meta.commit}${meta.dirtyPaths == null ? ' (dirty state unknown)' : meta.dirtyPaths === 0 ? ' (clean)' : ` (${meta.dirtyPaths} changed paths)`}`,
          },
          {label: 'started', value: meta.startedAt},
          {
            label: 'wall',
            value: `${seconds(meta.wallSeconds)} (${minutes(meta.wallSeconds)})`,
          },
          {
            label: 'CPU',
            value:
              meta.cpuUserSeconds == null || meta.cpuSystemSeconds == null
                ? 'unknown'
                : `${seconds(meta.cpuUserSeconds)} user, ${seconds(meta.cpuSystemSeconds)} system`,
          },
          {
            label: 'load average',
            value: `${meta.loadAverageStart.map((n) => n.toFixed(1)).join(' ')} at the start, ${meta.loadAverageEnd.map((n) => n.toFixed(1)).join(' ')} at the end`,
          },
          {
            label: 'exit code',
            value: meta.exitCode == null ? 'unknown' : String(meta.exitCode),
          },
          {label: 'recorder', value: meta.recorder ? 'on' : 'off'},
          {
            label: 'caffeinate',
            value: meta.caffeinate ? 'yes' : 'NO (the Mac could sleep)',
          },
          {label: 'other test runs', value: meta.otherTestRuns},
        ]),
    {
      label: 'tests',
      value: `${junit.tests} in ${junit.files} files; ${junit.failures} failed, ${junit.skipped} skipped (junit)${context.console == null ? '' : `; bun printed ${context.console.pass} pass, ${context.console.fail} fail`}`,
    },
    {
      label: 'junit time',
      value: `${seconds(junit.fileSeconds)} summed over files (hooks included); ${seconds(junit.testSeconds)} over tests; ${junit.totalSeconds == null ? 'runner total unknown' : `${seconds(junit.totalSeconds)} runner total (imports included)`}`,
    },
  ];
  sections.push(
    [
      sectionHeader('Test timing', {color: style.color, emoji: '⏱️'}),
      '',
      fieldLines(runFields, fieldOptions),
    ].join('\n'),
  );

  if (spawns == null) {
    sections.push(
      [
        sectionHeader('Time by command', {color: style.color, emoji: '🧮'}),
        '',
        `${pad(BODY_COLUMN)}No spawn log: time by command is unknown, not zero.`,
        `${pad(BODY_COLUMN)}Run with the recorder (\`test-timing run\`) to measure it.`,
      ].join('\n'),
    );
  } else {
    const all: Row = {
      calls: spawns.total,
      label: 'all',
      meanMs:
        spawns.total - spawns.unfinished === 0
          ? null
          : spawns.sumMs / (spawns.total - spawns.unfinished),
      totalMs: spawns.sumMs,
      unmeasured: spawns.unfinished,
    };
    const inProcessMs = wholeMs - spawns.unionMs;
    sections.push(
      [
        sectionHeader('Time by command', {color: style.color, emoji: '🧮'}),
        '',
        `${pad(BODY_COLUMN)}Share is of the summed file time, ${seconds(junit.fileSeconds)}. Async spawns can overlap, so the`,
        `${pad(BODY_COLUMN)}totals can add up to more than the time they covered: that is the union below.`,
        '',
        table(
          ROW_HEADER,
          [
            ...spawns.byGroup.map((row) => rowCells(row, wholeMs)),
            rowCells(all, wholeMs),
          ],
          style,
        ),
        '',
        fieldLines(
          [
            {
              label: 'subprocess union',
              value: `${seconds(spawns.unionMs / 1000)} (${percent(spawns.unionMs, wholeMs)}): the time at least one subprocess was running`,
            },
            {
              label: 'not in a subprocess',
              value: `${seconds(inProcessMs / 1000)} (${percent(inProcessMs, wholeMs)}): file time minus that union`,
            },
          ],
          fieldOptions,
        ),
      ].join('\n'),
    );

    const inside = spawns.inside
      .filter((entry) => entry.subcommand.length > 0)
      .map((entry) =>
        [
          `${pad(BODY_COLUMN)}${paint(`${entry.group}, by what it ran`, ['bold'], style.color)}`,
          '',
          table(
            ROW_HEADER,
            entry.subcommand.map((row) => rowCells(row, wholeMs)),
            style,
            stepColumn(1),
          ),
          '',
          `${pad(BODY_COLUMN)}${paint(`${entry.group}, by where it was found`, ['bold'], style.color)}`,
          '',
          table(
            ROW_HEADER,
            entry.location.map((row) => rowCells(row, wholeMs)),
            style,
            stepColumn(1),
          ),
        ].join('\n'),
      );
    sections.push(
      [
        sectionHeader('Inside each command', {color: style.color, emoji: '🔍'}),
        '',
        inside.join('\n\n'),
      ].join('\n'),
    );
  }

  const fileRows = analysis.files.map((file) => [
    seconds(file.seconds),
    String(file.tests),
    file.spawns == null ? 'n/a' : String(file.spawns),
    file.subprocessUnionSeconds == null
      ? 'n/a'
      : seconds(file.subprocessUnionSeconds),
    file.inProcessSeconds == null
      ? 'n/a'
      : file.inProcessSeconds < 0
        ? 'below 0'
        : seconds(file.inProcessSeconds),
    file.spawns == null || file.tests === 0
      ? 'n/a'
      : (file.brCalls / file.tests).toFixed(1),
    file.file,
  ]);
  sections.push(
    [
      sectionHeader('Slowest files', {color: style.color, emoji: '📁'}),
      '',
      `${pad(BODY_COLUMN)}subprocess = the union of the file's spawns; in-process = file time minus it.`,
      `${pad(BODY_COLUMN)}"below 0" means spawns ran outside the file's junit time (at import).`,
      '',
      table(
        [
          'file time',
          'tests',
          'spawns',
          'subprocess',
          'in-process',
          'br/test',
          'file',
        ],
        fileRows.slice(0, analysis.top),
        style,
      ),
    ].join('\n'),
  );

  sections.push(
    [
      sectionHeader('Slowest tests', {color: style.color, emoji: '🐢'}),
      '',
      table(
        ['time', 'file', 'test'],
        analysis.slowestTests.map((test) => [
          seconds(test.seconds),
          test.file,
          `${test.failed ? '[FAILED] ' : ''}${test.name}`,
        ]),
        style,
      ),
    ].join('\n'),
  );

  if (spawns != null) {
    sections.push(
      [
        sectionHeader('What the spawn log could not see', {
          color: style.color,
          emoji: '🩺',
        }),
        '',
        fieldLines(
          [
            {
              label: 'spawns',
              value: `${spawns.total} (${spawns.sync} sync, ${spawns.async} async, ${spawns.shell} through sh -c) from ${spawns.processes} test process(es)`,
            },
            {
              label: 'unfinished',
              value: `${spawns.unfinished} async spawns never reported an end; they are in no total`,
            },
            {
              label: 'threw',
              value: `${spawns.threw} spawn calls threw before a process ran (timed, included)`,
            },
            {
              label: 'no test file',
              value: `${spawns.noFile} spawns with no test file on the stack and none running`,
            },
            {
              label: 'running file',
              value: `${spawns.running} spawns credited to the file bun test was running (no test frame on the stack)`,
            },
            {
              label: 'leaked',
              value: `${spawns.leaked} spawns started by an earlier file's leftover work, while a later file ran`,
            },
            {
              label: 'unreadable',
              value: `${spawns.readErrors} spawns whose command or stack could not be read`,
            },
            {
              label: 'bad log lines',
              value:
                spawns.malformed.length === 0
                  ? 'none'
                  : `${spawns.malformed.length} (first: line ${spawns.malformed[0]?.line ?? '?'}: ${spawns.malformed[0]?.reason ?? ''})`,
            },
            {
              label: 'log versions',
              value:
                spawns.unknownVersions.length === 0
                  ? `all ${SPAWN_LOG_VERSION}`
                  : `UNKNOWN: ${spawns.unknownVersions.join(', ')}`,
            },
            {
              label: 'not seen at all',
              value:
                'processes started by a child process (the SDK CLI run as `bun src/cli.ts`): their time is inside that bun spawn',
            },
          ],
          fieldOptions,
        ),
      ].join('\n'),
    );
  }

  return `\n${sections.join('\n\n\n')}\n`;
}

// ---------------------------------------------------------------------------
// Reading a run from disk
// ---------------------------------------------------------------------------

export interface ReportInput {
  consoleText: string | null;
  junitPath: string;
  meta: RunMeta | null;
  spawnLogPath: string | null;
}

function readInput(options: {
  dir?: string;
  junit?: string;
  spawnLog?: string;
}): ReportInput {
  if (options.dir != null) {
    const dir = resolve(options.dir);
    const metaPath = join(dir, FILE_NAMES.run);
    const consolePath = join(dir, FILE_NAMES.console);
    const spawnPath = join(dir, FILE_NAMES.spawns);
    return {
      consoleText: existsSync(consolePath)
        ? readFileSync(consolePath, 'utf8')
        : null,
      junitPath: join(dir, FILE_NAMES.junit),
      meta: existsSync(metaPath)
        ? RunMetaSchema.parse(JSON.parse(readFileSync(metaPath, 'utf8')))
        : null,
      spawnLogPath: existsSync(spawnPath) ? spawnPath : null,
    };
  }
  if (options.junit == null)
    throw new Error('give --dir, or --junit (and optionally --spawn-log)');
  return {
    consoleText: null,
    junitPath: resolve(options.junit),
    meta: null,
    spawnLogPath: options.spawnLog == null ? null : resolve(options.spawnLog),
  };
}

async function report(
  input: ReportInput,
  top: number,
  json: boolean,
): Promise<number> {
  if (!existsSync(input.junitPath)) {
    process.stderr.write(`test-timing: no junit file at ${input.junitPath}\n`);
    return 2;
  }
  if (input.spawnLogPath != null && !existsSync(input.spawnLogPath)) {
    process.stderr.write(
      `test-timing: no spawn log at ${input.spawnLogPath}\n`,
    );
    return 2;
  }
  const junit = await parseJunit(readFileSync(input.junitPath, 'utf8'));
  const log =
    input.spawnLogPath == null
      ? null
      : parseSpawnLog(readFileSync(input.spawnLogPath, 'utf8'));
  const analysis = analyse(junit, log, top);
  const consoleFacts =
    input.consoleText == null ? null : consoleCounts(input.consoleText);
  if (json) {
    process.stdout.write(
      `${JSON.stringify({analysis, console: consoleFacts, meta: input.meta}, null, 2)}\n`,
    );
    return 0;
  }
  const source =
    input.spawnLogPath == null
      ? `${input.junitPath} (no spawn log)`
      : `${input.junitPath}\n${input.spawnLogPath}`;
  process.stdout.write(
    renderReport(
      analysis,
      {console: consoleFacts, meta: input.meta, source},
      outputStyle(),
    ),
  );
  return 0;
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

/**
 * Other `bun test` processes on this machine, or why that could not be
 * checked. A ps that cannot see pid 1 (the Claude Code sandbox) cannot see
 * other sessions either, so it is "could not check", never "none".
 */
export function otherTestRuns(
  psOutput: string | null,
  ownPid: number,
): {kind: 'checked'; runs: string[]} | {kind: 'failed'; reason: string} {
  if (psOutput == null) return {kind: 'failed', reason: 'ps did not run'};
  const lines = psOutput.split('\n').filter((line) => line.trim() !== '');
  const pids = lines.map((line) => Number(line.trim().split(/\s+/u)[0]));
  if (!pids.includes(1)) {
    return {
      kind: 'failed',
      reason:
        'ps cannot see pid 1, so it cannot see other sessions (is the sandbox on?)',
    };
  }
  const runs = lines.filter((line) => {
    // `pid etime args`. Only the process's own command counts: a bun binary
    // whose first argument is `test`. Wrappers (caffeinate, time, a shell)
    // have their bun child listed on its own line, and a command line that
    // merely mentions `bun test` (a Claude prompt) is not a test run.
    const fields = /^\s*(\d+)\s+\S+\s+(.*)$/u.exec(line);
    if (fields == null || Number(fields[1]) === ownPid) return false;
    return /^(?:\S*\/)?bun\s+test(?:\s|$)/u.test(fields[2] ?? '');
  });
  return {kind: 'checked', runs: runs.map((line) => line.trim())};
}

/** `ps` of every process, or null when ps itself failed (the sandbox denies it). */
function readPs(): string | null {
  try {
    const ps = Bun.spawnSync(['ps', '-axo', 'pid=,etime=,args='], {
      stderr: 'pipe',
      stdout: 'pipe',
    });
    return ps.exitCode === 0 ? ps.stdout.toString() : null;
  } catch {
    // posix_spawn refused (EPERM under the sandbox): not checked, not "none".
    return null;
  }
}

function gitLine(
  args: string[],
): {error: string; ok: false} | {ok: true; text: string} {
  const git = Bun.spawnSync(['git', ...args], {
    cwd: PACKAGE_ROOT,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (git.exitCode !== 0) {
    return {
      error: `git ${args.join(' ')} exited ${git.exitCode ?? 'by signal'}: ${git.stderr.toString().trim()}`,
      ok: false,
    };
  }
  return {ok: true, text: git.stdout.toString()};
}

function stateDir(): string {
  const base = process.env.XDG_STATE_HOME;
  return join(
    base == null || base === '' ? join(homedir(), '.local', 'state') : base,
    'justin-sdk',
    'test-timing',
  );
}

async function run(options: {
  extra: string[];
  json: boolean;
  out: string | null;
  recorder: boolean;
  skipBusyCheck: boolean;
  top: number;
}): Promise<number> {
  const busy = otherTestRuns(readPs(), process.pid);
  let otherRuns: string;
  if (busy.kind === 'failed') {
    if (!options.skipBusyCheck) {
      process.stderr.write(
        `test-timing: could not check for other bun test runs: ${busy.reason}\nRun it with the sandbox off, or pass --skip-busy-check to time anyway (the report will say so).\n`,
      );
      return 3;
    }
    otherRuns = `NOT CHECKED (${busy.reason})`;
  } else if (busy.runs.length > 0) {
    if (!options.skipBusyCheck) {
      process.stderr.write(
        `test-timing: another bun test is running; concurrent suites slow each other:\n${busy.runs.map((line) => `  ${line}`).join('\n')}\nWait for it, or pass --skip-busy-check.\n`,
      );
      return 3;
    }
    otherRuns = `${busy.runs.length} RUNNING (timed anyway)`;
  } else {
    otherRuns = 'none (checked with ps)';
  }

  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const dir = resolve(options.out ?? join(stateDir(), stamp));
  mkdirSync(dir, {recursive: true});
  const junitPath = join(dir, FILE_NAMES.junit);
  const spawnPath = join(dir, FILE_NAMES.spawns);
  const consolePath = join(dir, FILE_NAMES.console);

  const head = gitLine(['rev-parse', 'HEAD']);
  const status = gitLine(['status', '--porcelain']);
  const caffeinate = Bun.which('caffeinate');
  const command = [
    ...(caffeinate == null ? [] : [caffeinate, '-i']),
    process.execPath,
    'test',
    '--reporter=junit',
    `--reporter-outfile=${junitPath}`,
    ...options.extra,
  ];
  const env: Record<string, string | undefined> = {...process.env};
  if (options.recorder) env[SPAWN_LOG_ENV] = spawnPath;
  else delete env[SPAWN_LOG_ENV];

  process.stdout.write(
    `test-timing: running the suite in ${PACKAGE_ROOT}\n  output: ${dir}\n  ${caffeinate == null ? 'WITHOUT caffeinate (not found): the Mac may sleep' : 'under caffeinate -i'}\n`,
  );
  const loadAverageStart = loadavg();
  const startedAt = new Date();
  const started = performance.now();
  const consoleFd = openSync(consolePath, 'w');
  let exitCode: number | null;
  let usage:
    | {cpuTime: {system: bigint | number; user: bigint | number}}
    | undefined;
  try {
    const child = Bun.spawn(command, {
      cwd: PACKAGE_ROOT,
      env,
      stderr: consoleFd,
      stdin: 'ignore',
      stdout: consoleFd,
    });
    exitCode = await child.exited;
    usage = child.resourceUsage();
  } finally {
    closeSync(consoleFd);
  }
  const wallSeconds = (performance.now() - started) / 1000;
  const meta: RunMeta = {
    bun: Bun.version,
    caffeinate: caffeinate != null,
    command,
    commit: head.ok ? head.text.trim() : null,
    commitError: head.ok ? null : head.error,
    cpuSystemSeconds: usage == null ? null : Number(usage.cpuTime.system) / 1e6,
    cpuUserSeconds: usage == null ? null : Number(usage.cpuTime.user) / 1e6,
    dirtyPaths: status.ok
      ? status.text.split('\n').filter((line) => line.trim() !== '').length
      : null,
    endedAt: new Date().toISOString(),
    exitCode,
    loadAverageEnd: loadavg(),
    loadAverageStart,
    otherTestRuns: otherRuns,
    recorder: options.recorder,
    startedAt: startedAt.toISOString(),
    wallSeconds,
  };
  writeFileSync(
    join(dir, FILE_NAMES.run),
    `${JSON.stringify(meta, null, 2)}\n`,
  );

  const code = await report(readInput({dir}), options.top, options.json);
  if (exitCode !== 0) {
    process.stderr.write(
      `\ntest-timing: the suite exited ${exitCode ?? 'by signal'}: these are the timings of a run that was not green. Its output: ${consolePath}\n`,
    );
    return 1;
  }
  return code;
}

// ---------------------------------------------------------------------------
// costs
// ---------------------------------------------------------------------------

interface CostRow {
  label: string;
  ms: number[];
  program: string;
}

function timeOnce(
  argv: string[],
  cwd: string,
  env?: Record<string, string | undefined>,
): number {
  const started = performance.now();
  const result = Bun.spawnSync(argv, {
    cwd,
    env: env ?? process.env,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const ms = performance.now() - started;
  if (result.exitCode !== 0) {
    throw new Error(
      `${argv.join(' ')} (in ${cwd}) exited ${result.exitCode ?? 'by signal'}: ${result.stderr.toString().trim()}`,
    );
  }
  return ms;
}

function must(argv: string[], cwd: string): string {
  const result = Bun.spawnSync(argv, {cwd, stderr: 'pipe', stdout: 'pipe'});
  if (result.exitCode !== 0) {
    throw new Error(
      `${argv.join(' ')} exited ${result.exitCode ?? 'by signal'}: ${result.stderr.toString().trim()}`,
    );
  }
  return result.stdout.toString().trim();
}

function stats(values: readonly number[]): {
  max: number;
  mean: number;
  median: number;
  min: number;
} {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? (sorted[middle] ?? 0)
      : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  return {
    max: sorted.at(-1) ?? 0,
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    median,
    min: sorted[0] ?? 0,
  };
}

function costs(times: number, json: boolean): number {
  const scratch = mkdtempSync(join(tmpdir(), 'test-timing-costs-'));
  const rows: CostRow[] = [];
  const measure = (
    label: string,
    program: string,
    once: (round: number) => number,
  ): void => {
    const ms: number[] = [];
    for (let round = 0; round < times; round += 1) ms.push(once(round));
    rows.push({label, ms, program});
  };
  try {
    const pinned = must(['mise', 'which', 'br'], REPO_ROOT);
    const pathBr = Bun.which('br', {cwd: REPO_ROOT}) ?? 'br';
    const git = Bun.which('git') ?? 'git';
    const mise = Bun.which('mise') ?? 'mise';
    const bun = process.execPath;

    const freshRepo = (name: string): string => {
      const dir = join(scratch, name);
      mkdirSync(dir, {recursive: true});
      must([git, 'init', '-q'], dir);
      return dir;
    };

    measure('br --version (pinned binary, direct)', pinned, () =>
      timeOnce([pinned, '--version'], scratch),
    );
    measure('br --version (PATH, from home-base)', pathBr, () =>
      timeOnce([pathBr, '--version'], REPO_ROOT),
    );
    measure('br init (fresh git repo)', pinned, (round) =>
      timeOnce(
        [pinned, 'init', '--prefix', 't', '-q'],
        freshRepo(`init-${round}`),
      ),
    );
    measure('br create (first, fresh workspace)', pinned, (round) => {
      const dir = freshRepo(`first-${round}`);
      must([pinned, 'init', '--prefix', 't', '-q'], dir);
      return timeOnce(
        [pinned, 'create', '--title=timing probe', '--type=task'],
        dir,
      );
    });
    const workspace = freshRepo('workspace');
    must([pinned, 'init', '--prefix', 't', '-q'], workspace);
    measure('br create (later, same workspace)', pinned, () =>
      timeOnce(
        [pinned, 'create', '--title=timing probe', '--type=task'],
        workspace,
      ),
    );
    measure('br list --json (same workspace)', pinned, () =>
      timeOnce([pinned, 'list', '--json'], workspace),
    );
    measure('git --version', git, () => timeOnce([git, '--version'], scratch));
    measure('git init -q (fresh dir)', git, (round) => {
      const dir = join(scratch, `git-${round}`);
      mkdirSync(dir);
      return timeOnce([git, 'init', '-q'], dir);
    });
    const repo = freshRepo('git-repo');
    must(
      [
        git,
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.invalid',
        'commit',
        '--allow-empty',
        '-q',
        '-m',
        'first',
      ],
      repo,
    );
    measure('git commit --allow-empty', git, () =>
      timeOnce(
        [
          git,
          '-c',
          'user.name=t',
          '-c',
          'user.email=t@example.invalid',
          'commit',
          '--allow-empty',
          '-q',
          '-m',
          'probe',
        ],
        repo,
      ),
    );
    measure('git rev-parse HEAD', git, () =>
      timeOnce([git, 'rev-parse', 'HEAD'], repo),
    );
    measure('git status --porcelain', git, () =>
      timeOnce([git, 'status', '--porcelain'], repo),
    );
    measure("bun -e ''", bun, () => timeOnce([bun, '-e', ''], scratch));
    measure('bun src/cli.ts --help', bun, () =>
      timeOnce([bun, join(PACKAGE_ROOT, 'src', 'cli.ts'), '--help'], scratch, {
        ...process.env,
        JUSTIN_SDK_HEALTH_NOTICES: 'off',
      }),
    );
    measure('mise --version', mise, () =>
      timeOnce([mise, '--version'], scratch),
    );
    measure('mise which br (from home-base)', mise, () =>
      timeOnce([mise, 'which', 'br'], REPO_ROOT),
    );
  } finally {
    rmSync(scratch, {force: true, recursive: true});
  }

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        rows.map((row) => ({...row, ...stats(row.ms)})),
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  const style = outputStyle();
  const body = table(
    ['median ms', 'mean ms', 'min ms', 'max ms', 'call'],
    rows.map((row) => {
      const s = stats(row.ms);
      return [
        s.median.toFixed(1),
        s.mean.toFixed(1),
        s.min.toFixed(1),
        s.max.toFixed(1),
        row.label,
      ];
    }),
    style,
  );
  const programs = fieldLines(
    [...new Map(rows.map((row) => [row.program, row])).keys()].map(
      (program, index) => ({label: `program ${index + 1}`, value: program}),
    ),
    {color: style.color, indent: BODY_COLUMN, width: style.width},
  );
  process.stdout.write(
    `\n${sectionHeader(`Single-call costs (${times} runs each)`, {color: style.color, emoji: '⏲️'})}\n\n${body}\n\n${programs}\n`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

const USAGE = `test-timing — where the justin-sdk test suite spends its time (home-base-ejsq2.1)

  bun run test:timing run [--out <dir>] [--no-recorder] [-- <bun test args>]
  bun run test:timing report --dir <run dir>
  bun run test:timing report --junit <file> [--spawn-log <file>]
  bun run test:timing costs [--times N]

run: runs the whole suite with bun's junit reporter and the subprocess recorder, under caffeinate -i, after checking that no other bun test is running. It needs the Claude Code sandbox off (ps and the suite both do) and takes about 20 minutes serially. It writes run.json, junit.xml, spawns.jsonl and console.txt to its output directory, then prints the report.

report: prints the report from files already written. Runs nothing.

costs: times single br, git, bun and mise calls in temp directories it removes. Runs no test.`;

async function main(): Promise<number> {
  let code = 0;
  await yargs(hideBin(process.argv))
    .scriptName('test-timing')
    .usage(USAGE)
    // The terminal wraps; yargs's own 80-column wrap would break the usage
    // paragraphs mid-sentence (critical rule 14).
    .wrap(null)
    .parserConfiguration({'populate--': true})
    .command(
      'run',
      'Run the suite with the recorder and print the report',
      (y) =>
        y
          .option('out', {
            describe:
              'Output directory (default: $XDG_STATE_HOME/justin-sdk/test-timing/<stamp>)',
            type: 'string',
          })
          .option('recorder', {
            default: true,
            describe:
              'Record subprocesses (--no-recorder for a junit-only run)',
            type: 'boolean',
          })
          .option('skip-busy-check', {
            default: false,
            describe:
              'Time even when another bun test is running or ps cannot tell',
            type: 'boolean',
          })
          .option('top', {
            default: 15,
            describe: 'Rows per ranking',
            type: 'number',
          })
          .option('json', {
            default: false,
            describe: 'Print the analysis as JSON',
            type: 'boolean',
          }),
      async (args) => {
        // `populate--` puts everything after `--` here, for `bun test`.
        const passthrough: unknown = args['--'];
        const extra = Array.isArray(passthrough) ? passthrough.map(String) : [];
        code = await run({
          extra,
          json: args.json,
          out: args.out ?? null,
          recorder: args.recorder,
          skipBusyCheck: args.skipBusyCheck,
          top: args.top,
        });
      },
    )
    .command(
      'report',
      'Print the report from a run directory, or a junit file and a spawn log',
      (y) =>
        y
          .option('dir', {describe: 'A directory `run` wrote', type: 'string'})
          .option('junit', {
            describe: 'A junit file from bun test --reporter=junit',
            type: 'string',
          })
          .option('spawn-log', {
            describe: 'The spawn log (jsonl) of the same run',
            type: 'string',
          })
          .option('top', {
            default: 15,
            describe: 'Rows per ranking',
            type: 'number',
          })
          .option('json', {
            default: false,
            describe: 'Print the analysis as JSON',
            type: 'boolean',
          }),
      async (args) => {
        code = await report(
          readInput({
            dir: args.dir,
            junit: args.junit,
            spawnLog: args.spawnLog,
          }),
          args.top,
          args.json,
        );
      },
    )
    .command(
      'costs',
      'Time single br, git, bun and mise calls',
      (y) =>
        y
          .option('times', {
            default: 10,
            describe: 'Runs of each call',
            type: 'number',
          })
          .option('json', {
            default: false,
            describe: 'Print the timings as JSON',
            type: 'boolean',
          }),
      (args) => {
        code = costs(args.times, args.json);
      },
    )
    .demandCommand(1, 'Name a command: run, report or costs.')
    .strict()
    .help()
    .parseAsync();
  return code;
}

if (import.meta.main) {
  process.exitCode = await main();
}
