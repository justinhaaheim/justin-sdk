#!/usr/bin/env bun
/**
 * Which tests one junit report has and another lacks, per file and per test
 * name (home-base-ejsq2.4). Made to compare a serial `bun test` with a
 * `bun test --parallel` run of the same commit. Reads two files; runs nothing.
 *
 *   bun scripts/junit-diff.ts <a.xml> <b.xml>
 */
import {readFileSync} from 'node:fs';

import {parseJunit} from './test-timing';

const USAGE = `junit-diff — the tests one junit report has and the other lacks, per file (home-base-ejsq2.4)

  bun scripts/junit-diff.ts [--names-only] <a.xml> <b.xml>

Counts each (file, test name) pair in both reports and prints every file whose counts differ, with the names that differ and by how many. With --names-only it ignores which file a test is listed under and compares the test names and their counts alone (home-base-ejsq2.6: a serial run lists an imported test file's tests under its first importer). Runs nothing.`;

/** The label every test gets under --names-only. */
const ANY_FILE = '(any file)';

/** `file` → `name` → how many times the report lists it. */
export function testCounts(
  tests: readonly {file: string; name: string}[],
): Map<string, Map<string, number>> {
  const byFile = new Map<string, Map<string, number>>();
  for (const {file, name} of tests) {
    const names = byFile.get(file) ?? new Map<string, number>();
    names.set(name, (names.get(name) ?? 0) + 1);
    byFile.set(file, names);
  }
  return byFile;
}

export interface FileDiff {
  a: number;
  b: number;
  file: string;
  names: {a: number; b: number; name: string}[];
}

/** Every file whose tests differ between `a` and `b`, by name and count. */
export function diffCounts(
  a: Map<string, Map<string, number>>,
  b: Map<string, Map<string, number>>,
): FileDiff[] {
  const files = [...new Set([...a.keys(), ...b.keys()])].sort();
  const diffs: FileDiff[] = [];
  for (const file of files) {
    const left = a.get(file) ?? new Map<string, number>();
    const right = b.get(file) ?? new Map<string, number>();
    const names = [...new Set([...left.keys(), ...right.keys()])]
      .sort()
      .map((name) => ({a: left.get(name) ?? 0, b: right.get(name) ?? 0, name}))
      .filter((entry) => entry.a !== entry.b);
    if (names.length === 0) continue;
    const sum = (map: Map<string, number>): number =>
      [...map.values()].reduce((total, count) => total + count, 0);
    diffs.push({a: sum(left), b: sum(right), file, names});
  }
  return diffs;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const namesOnly = args.includes('--names-only');
  const paths = args.filter((arg) => arg !== '--names-only');
  const [aPath, bPath] = paths;
  if (aPath == null || bPath == null || paths.length !== 2) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const a = await parseJunit(readFileSync(aPath, 'utf8'));
  const b = await parseJunit(readFileSync(bPath, 'utf8'));
  const keyed = (tests: readonly {file: string; name: string}[]) =>
    namesOnly ? tests.map(({name}) => ({file: ANY_FILE, name})) : tests;
  const diffs = diffCounts(
    testCounts(keyed(a.tests)),
    testCounts(keyed(b.tests)),
  );
  if (namesOnly) {
    process.stdout.write(
      '--names-only: compared by test name, ignoring the file\n',
    );
  }
  process.stdout.write(
    `a: ${a.testsTotal} tests in ${a.files.length} files (${aPath})\nb: ${b.testsTotal} tests in ${b.files.length} files (${bPath})\n\n${diffs.length} files differ\n\n`,
  );
  for (const diff of diffs) {
    process.stdout.write(
      `  ${diff.file}: a ${diff.a}, b ${diff.b} (${diff.b - diff.a >= 0 ? '+' : ''}${diff.b - diff.a})\n`,
    );
    for (const name of diff.names) {
      process.stdout.write(`      a ${name.a}  b ${name.b}  ${name.name}\n`);
    }
    process.stdout.write('\n');
  }
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main();
}
