#!/usr/bin/env bun
/**
 * The two numbers `bun run test:parallel`'s stall limit is chosen from
 * (home-base-ejsq2.6). Reads files; runs nothing.
 *
 *   timeouts            every explicit timeout in tests/: setDefaultTimeout(n),
 *                       a test's or hook's numeric or {timeout} argument, and
 *                       a named constant defined in the same file. An argument
 *                       it cannot read is listed as unresolved, never skipped.
 *   durations <dir>...  from the marker files of `test:parallel` runs
 *                       (<run dir>/markers/*.jsonl), the longest time a worker
 *                       spent inside one test: from the test's `start` record
 *                       to the next record that is not its `body`. That is the
 *                       interval the stall check measured until ejsq2.8.
 *   gaps <dir>...       from the same marker files, every interval in which a
 *                       worker wrote no record, labelled by the kinds of the
 *                       records on each side (`end→file` is afterAll plus the
 *                       next file's preload), plus each worker's head and tail
 *                       against run.json's start and end. That is the
 *                       interval the stall check measures since ejsq2.8.
 *
 *   bun scripts/test-stall-evidence.ts timeouts
 *   bun scripts/test-stall-evidence.ts durations <run dir>...
 *   bun scripts/test-stall-evidence.ts gaps <run dir>...
 */
import type {MarkerRecord} from '../tests/test-marker';

import {readdirSync, readFileSync} from 'node:fs';
import {join, relative, resolve} from 'node:path';
import ts from 'typescript';

const PACKAGE_ROOT = resolve(import.meta.dir, '..');

const TEST_NAMES = new Set(['it', 'test']);
const HOOK_NAMES = new Set([
  'afterAll',
  'afterEach',
  'beforeAll',
  'beforeEach',
]);

export interface TimeoutSite {
  file: string;
  line: number;
  /** null: the argument is there but is not a number this scan can read. */
  ms: null | number;
  text: string;
  what: string;
}

/** The base name of a call: `test`, `test.skipIf(x)`, `describe.each(r)` → test / describe. */
function calleeRoot(expression: ts.Expression): null | string {
  let node: ts.Expression = expression;
  for (;;) {
    if (ts.isIdentifier(node)) return node.text;
    if (ts.isPropertyAccessExpression(node)) node = node.expression;
    else if (ts.isCallExpression(node)) node = node.expression;
    else return null;
  }
}

/** Every timeout argument in one file's source. */
export function timeoutSites(file: string, source: string): TimeoutSite[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const constants = new Map<string, null | number>();
  const numberOf = (node: ts.Expression | undefined): null | number => {
    if (node == null) return null;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (ts.isIdentifier(node)) return constants.get(node.text) ?? null;
    if (ts.isParenthesizedExpression(node)) return numberOf(node.expression);
    if (ts.isAsExpression(node)) return numberOf(node.expression);
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.AsteriskToken ||
        node.operatorToken.kind === ts.SyntaxKind.PlusToken)
    ) {
      const left = numberOf(node.left);
      const right = numberOf(node.right);
      if (left == null || right == null) return null;
      return node.operatorToken.kind === ts.SyntaxKind.PlusToken
        ? left + right
        : left * right;
    }
    return null;
  };
  // Top-level `const NAME = <number>` first, so a use before it still resolves.
  const collect = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer != null &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      const value = numberOf(node.initializer);
      if (value != null) constants.set(node.name.text, value);
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);

  const sites: TimeoutSite[] = [];
  const add = (node: ts.Node, what: string, argument: ts.Expression): void => {
    let ms: null | number;
    if (ts.isObjectLiteralExpression(argument)) {
      const property = argument.properties.find(
        (entry): entry is ts.PropertyAssignment =>
          ts.isPropertyAssignment(entry) &&
          entry.name.getText(sf) === 'timeout',
      );
      if (property == null) return;
      ms = numberOf(property.initializer);
    } else {
      ms = numberOf(argument);
    }
    sites.push({
      file,
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      ms,
      text: argument.getText(sf).slice(0, 60),
      what,
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const root = calleeRoot(node.expression);
      const args = node.arguments;
      if (root === 'setDefaultTimeout' && args[0] != null) {
        add(node, 'setDefaultTimeout', args[0]);
      } else if (
        root != null &&
        TEST_NAMES.has(root) &&
        args.length >= 3 &&
        args[2] != null
      ) {
        add(node, root, args[2]);
      } else if (
        root != null &&
        HOOK_NAMES.has(root) &&
        args.length >= 2 &&
        args[1] != null
      ) {
        add(node, root, args[1]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

function listTs(dir: string): string[] {
  return readdirSync(dir, {recursive: true, withFileTypes: true})
    .filter((entry) => entry.isFile() && /\.tsx?$/u.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

export interface InTestSpan {
  file: string;
  ms: number;
  name: null | string;
  pid: number;
}

/**
 * Each test's in-test interval from one process's marker lines: from its
 * `start` to the next record that is not its `body`. A test still open at the
 * end of the file is counted in `open`, not given a made-up length.
 */
export function inTestSpans(text: string): {
  open: number;
  spans: InTestSpan[];
  unreadable: number;
} {
  const spans: InTestSpan[] = [];
  let unreadable = 0;
  let current: {
    atMs: number;
    file: string;
    name: null | string;
    pid: number;
    seq: number;
  } | null = null;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let record: MarkerRecord;
    try {
      record = JSON.parse(line) as MarkerRecord;
    } catch {
      unreadable += 1;
      continue;
    }
    if (record.kind === 'body' && record.seq === current?.seq) {
      current.name = record.name;
      continue;
    }
    if (current != null) {
      spans.push({
        file: current.file,
        ms: record.atMs - current.atMs,
        name: current.name,
        pid: current.pid,
      });
      current = null;
    }
    if (record.kind === 'start') {
      current = {
        atMs: record.atMs,
        file: record.file,
        name: null,
        pid: record.pid,
        seq: record.seq,
      };
    }
  }
  return {open: current == null ? 0 : 1, spans, unreadable};
}

export interface RecordGap {
  /** The test file the later record names. */
  file: string;
  /** `<earlier kind>→<later kind>`, or `run start→<kind>` / `<kind>→run end`. */
  kind: string;
  ms: number;
  pid: number;
}

/**
 * Every interval in which one worker wrote no marker record
 * (home-base-ejsq2.8): between each pair of consecutive records, labelled by
 * their kinds, plus the head (run start to its first record) and the tail (its
 * last record to the run's end) when the run's times are given. That is the
 * interval the widened stall check measures, in every state.
 */
export function recordGaps(
  text: string,
  run: {endedAtMs: null | number; startedAtMs: null | number} = {
    endedAtMs: null,
    startedAtMs: null,
  },
): {gaps: RecordGap[]; unreadable: number} {
  const gaps: RecordGap[] = [];
  let unreadable = 0;
  let previous: MarkerRecord | null = null;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let record: MarkerRecord;
    try {
      record = JSON.parse(line) as MarkerRecord;
    } catch {
      unreadable += 1;
      continue;
    }
    if (previous == null) {
      if (run.startedAtMs != null) {
        gaps.push({
          file: record.file,
          kind: `run start→${record.kind}`,
          ms: record.atMs - run.startedAtMs,
          pid: record.pid,
        });
      }
    } else {
      gaps.push({
        file: record.file,
        kind: `${previous.kind}→${record.kind}`,
        ms: record.atMs - previous.atMs,
        pid: record.pid,
      });
    }
    previous = record;
  }
  if (previous != null && run.endedAtMs != null) {
    gaps.push({
      file: previous.file,
      kind: `${previous.kind}→run end`,
      ms: run.endedAtMs - previous.atMs,
      pid: previous.pid,
    });
  }
  return {gaps, unreadable};
}

/** A run's start and end from its run.json; null for a time it does not hold. */
function runTimes(runDir: string): {
  endedAtMs: null | number;
  startedAtMs: null | number;
} {
  try {
    const meta = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')) as {
      endedAt?: unknown;
      startedAt?: unknown;
    };
    const time = (value: unknown): null | number => {
      if (typeof value !== 'string') return null;
      const ms = Date.parse(value);
      return Number.isNaN(ms) ? null : ms;
    };
    return {endedAtMs: time(meta.endedAt), startedAtMs: time(meta.startedAt)};
  } catch {
    return {endedAtMs: null, startedAtMs: null};
  }
}

function main(): number {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'timeouts') {
    const testsDir = join(PACKAGE_ROOT, 'tests');
    const sites = listTs(testsDir).flatMap((file) =>
      timeoutSites(relative(PACKAGE_ROOT, file), readFileSync(file, 'utf8')),
    );
    const known = sites
      .filter((site) => site.ms != null)
      .sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0));
    const unresolved = sites.filter((site) => site.ms == null);
    process.stdout.write(
      `${sites.length} explicit timeouts in ${testsDir}; ${unresolved.length} unresolved\n\n`,
    );
    for (const site of known.slice(0, 15)) {
      process.stdout.write(
        `  ${String(site.ms).padStart(7)} ms  ${site.what}  ${site.file}:${site.line}  (${site.text})\n`,
      );
    }
    for (const site of unresolved) {
      process.stdout.write(
        `  UNRESOLVED  ${site.what}  ${site.file}:${site.line}  (${site.text})\n`,
      );
    }
    return 0;
  }
  if (command === 'durations' && rest.length > 0) {
    const all: InTestSpan[] = [];
    let open = 0;
    let unreadable = 0;
    for (const runDir of rest) {
      const markerDir = join(runDir, 'markers');
      for (const entry of readdirSync(markerDir).filter((name) =>
        name.endsWith('.jsonl'),
      )) {
        const result = inTestSpans(
          readFileSync(join(markerDir, entry), 'utf8'),
        );
        all.push(...result.spans);
        open += result.open;
        unreadable += result.unreadable;
      }
    }
    all.sort((a, b) => b.ms - a.ms);
    process.stdout.write(
      `${all.length} tests in ${rest.length} runs; ${open} still open at the end of a marker file; ${unreadable} unreadable lines\n\n`,
    );
    for (const span of all.slice(0, 15)) {
      process.stdout.write(
        `  ${(span.ms / 1000).toFixed(1).padStart(7)} s  ${relative(PACKAGE_ROOT, span.file)}  ${span.name ?? '(name not recorded)'}\n`,
      );
    }
    return 0;
  }
  if (command === 'gaps' && rest.length > 0) {
    const all: RecordGap[] = [];
    let unreadable = 0;
    let missingTimes = 0;
    for (const runDir of rest) {
      const times = runTimes(runDir);
      if (times.startedAtMs == null || times.endedAtMs == null) {
        missingTimes += 1;
      }
      const markerDir = join(runDir, 'markers');
      for (const entry of readdirSync(markerDir).filter((name) =>
        name.endsWith('.jsonl'),
      )) {
        const result = recordGaps(
          readFileSync(join(markerDir, entry), 'utf8'),
          times,
        );
        all.push(...result.gaps);
        unreadable += result.unreadable;
      }
    }
    all.sort((a, b) => b.ms - a.ms);
    process.stdout.write(
      `${all.length} gaps in ${rest.length} runs; ${unreadable} unreadable lines; ${missingTimes} runs without a start or end time in run.json (their head or tail gaps are not counted)\n\nlongest per kind:\n`,
    );
    const longest = new Map<string, RecordGap>();
    for (const gap of all) {
      if (!longest.has(gap.kind)) longest.set(gap.kind, gap);
    }
    for (const gap of [...longest.values()]) {
      process.stdout.write(
        `  ${(gap.ms / 1000).toFixed(1).padStart(7)} s  ${gap.kind.padEnd(22)}  ${relative(PACKAGE_ROOT, gap.file)}\n`,
      );
    }
    process.stdout.write('\nlongest overall:\n');
    for (const gap of all.slice(0, 15)) {
      process.stdout.write(
        `  ${(gap.ms / 1000).toFixed(1).padStart(7)} s  ${gap.kind.padEnd(22)}  pid ${gap.pid}  ${relative(PACKAGE_ROOT, gap.file)}\n`,
      );
    }
    return 0;
  }
  process.stdout.write(
    'test-stall-evidence (home-base-ejsq2.6, ejsq2.8): the numbers the test:parallel stall limit is chosen from\n\n  bun scripts/test-stall-evidence.ts timeouts\n  bun scripts/test-stall-evidence.ts durations <test:parallel run dir>...\n  bun scripts/test-stall-evidence.ts gaps <test:parallel run dir>...\n',
  );
  return command == null || command === '--help' || command === '-h' ? 0 : 2;
}

if (import.meta.main) {
  process.exitCode = main();
}
