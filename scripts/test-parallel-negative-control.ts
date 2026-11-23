#!/usr/bin/env bun
/**
 * The negative control for `bun run test:parallel`'s watchdog
 * (home-base-ejsq2.4, acceptance criterion 3; ejsq2.6, ejsq2.8). For each
 * scenario it builds a two-file fixture suite in a temp directory, one file
 * of which spins in a synchronous loop that bun's own limits cannot stop (in a
 * test, or in a beforeAll), runs the watchdog script on it with a short
 * limit, and checks what it promises:
 *  - it stops the run within the limit (plus the sample time and a margin);
 *  - it names the spinning test, or the file whose beforeAll spins;
 *  - it writes a `sample` of the stuck worker;
 *  - it leaves no process of the run alive;
 *  - it exits 125 (the stall check) or 124 (the wall limit).
 * The fixture uses the real preload (tests/preload-test-env.ts), so the
 * marker under test is the one the suite loads. Nothing is added to the real
 * suite. The temp directory is removed afterwards.
 *
 *   bun run test:parallel:negative-control [--keep]
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

import {EXIT} from './test-parallel';

const PACKAGE_ROOT = resolve(import.meta.dir, '..');
const SAMPLE_SECONDS = 2;
/** Startup, the sample, the kill and the final ps checks. */
const MARGIN_SECONDS = 15;
const SPIN_NAME = 'negative control > spins forever in synchronous code';
/** Tries after a refusal (another bun test running), and the wait before each. */
const REFUSED_RETRIES = 30;
const REFUSED_WAIT_MS = 10_000;

/** The spinning file's name in each fixture suite. */
const SPIN_FILE = 'spin.test.ts';

/**
 * The ways a spinning worker is stopped (home-base-ejsq2.6, ejsq2.8):
 *  stall  the stall check, a spin inside a test, long before a wall limit it
 *         never reaches;
 *  hook   the stall check, a spin in a beforeAll: the worker is between
 *         records, not inside a test (its last record is the file's), which
 *         only the wall limit stopped before ejsq2.8;
 *  limit  the wall limit, with the stall check off.
 * `spin` says where the fixture spins: in a test's body, or in a beforeAll.
 */
const SCENARIOS = {
  hook: {
    exit: EXIT.stalled,
    limitSeconds: 60,
    outcome: 'stopped-stalled',
    spin: 'hook',
    stallSeconds: 4,
    /** The stall limit plus one poll (a quarter of it, at least 0.25 s). */
    stopBySeconds: 5,
  },
  limit: {
    exit: EXIT.stopped,
    limitSeconds: 8,
    outcome: 'stopped-at-limit',
    spin: 'test',
    stallSeconds: 0,
    /** When the stop must have begun: the limit. */
    stopBySeconds: 8,
  },
  stall: {
    exit: EXIT.stalled,
    limitSeconds: 60,
    outcome: 'stopped-stalled',
    spin: 'test',
    stallSeconds: 4,
    /** The stall limit plus one poll (a quarter of it, at least 0.25 s). */
    stopBySeconds: 5,
  },
} as const;
type ScenarioName = keyof typeof SCENARIOS;

/** The spinning file: a synchronous loop in a test's body, or in a beforeAll. */
const SPIN_SOURCE = {
  hook: `import {beforeAll, describe, expect, test} from 'bun:test';\n\nbeforeAll(() => {\n  let n = 0;\n  for (;;) n += 1;\n});\n\ndescribe('negative control', () => {\n  test('never runs: the beforeAll before it spins', () => {\n    expect(true).toBe(true);\n  });\n});\n`,
  test: `import {describe, test} from 'bun:test';\n\ndescribe('negative control', () => {\n  test('spins forever in synchronous code', () => {\n    let n = 0;\n    for (;;) n += 1;\n  });\n});\n`,
} as const;

const USAGE = `test-parallel-negative-control — proves the test:parallel watchdog stops a spinning worker (home-base-ejsq2.4, home-base-ejsq2.6, home-base-ejsq2.8)

  bun run test:parallel:negative-control [--keep]

Builds a fixture suite in a temp directory that loops forever in synchronous code and runs scripts/test-parallel.ts on it three times: a test that spins, with --stall ${SCENARIOS.stall.stallSeconds} --limit ${SCENARIOS.stall.limitSeconds} (the stall check must stop it, exit ${EXIT.stalled}, well before the limit); a beforeAll that spins, with --stall ${SCENARIOS.hook.stallSeconds} --limit ${SCENARIOS.hook.limitSeconds} (the stall check must stop a worker that is between records, not in a test, exit ${EXIT.stalled}, well before the limit); and a test that spins with --stall 0 --limit ${SCENARIOS.limit.limitSeconds} (the wall limit must stop it, exit ${EXIT.stopped}). Each time it checks that the run was stopped in time, the test or file was named, a sample was written and no process was left. Needs the Claude Code sandbox off. --keep leaves the temp directory for inspection.`;

function runScenario(root: string, name: ScenarioName): boolean {
  const scenario = SCENARIOS[name];
  const fixture = join(root, `suite-${name}`);
  const out = join(root, `out-${name}`);
  mkdirSync(fixture);
  writeFileSync(
    join(fixture, 'bunfig.toml'),
    `[test]\npreload = [${JSON.stringify(join(PACKAGE_ROOT, 'tests', 'preload-test-env.ts'))}]\n`,
  );
  writeFileSync(
    join(fixture, 'quick.test.ts'),
    `import {expect, test} from 'bun:test';\n\ntest('a quick test that passes', () => {\n  expect(1 + 1).toBe(2);\n});\n`,
  );
  writeFileSync(join(fixture, SPIN_FILE), SPIN_SOURCE[scenario.spin]);

  const command = [
    process.execPath,
    join(PACKAGE_ROOT, 'scripts', 'test-parallel.ts'),
    '--cwd',
    fixture,
    '--out',
    out,
    '--workers',
    '2',
    '--limit',
    String(scenario.limitSeconds),
    '--stall',
    String(scenario.stallSeconds),
    '--sample-seconds',
    String(SAMPLE_SECONDS),
  ];
  // The watchdog refuses (exit 3, before it writes anything) while another
  // bun test runs on this Mac, and other sessions run single files every few
  // seconds. Wait and try again, so the scenario runs on a quiet Mac rather
  // than failing on a busy one (home-base-ejsq2.8).
  let started = performance.now();
  let result = Bun.spawnSync(command, {
    env: {...process.env, NO_COLOR: '1'},
    stderr: 'pipe',
    stdout: 'pipe',
  });
  for (
    let attempt = 1;
    result.exitCode === EXIT.refused && attempt <= REFUSED_RETRIES;
    attempt += 1
  ) {
    process.stdout.write(
      `scenario ${name}: refused (another bun test is running); try ${attempt} of ${REFUSED_RETRIES} in ${REFUSED_WAIT_MS / 1000} s\n`,
    );
    Bun.sleepSync(REFUSED_WAIT_MS);
    started = performance.now();
    result = Bun.spawnSync(command, {
      env: {...process.env, NO_COLOR: '1'},
      stderr: 'pipe',
      stdout: 'pipe',
    });
  }
  const seconds = (performance.now() - started) / 1000;
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();

  const runJsonPath = join(out, 'run.json');
  const runJson = existsSync(runJsonPath)
    ? (JSON.parse(readFileSync(runJsonPath, 'utf8')) as {
        leftovers: unknown[] | null;
        outcome: string;
        running: {
          name: null | string;
          pid: number;
          record: {file: string} | null;
          where: string;
        }[];
        samples: {pid: number; result: string}[];
        stalled?: {name: null | string; pid: number; where?: string}[];
      })
    : null;
  // A test spin is named by its test; a beforeAll spin has no test to name,
  // so it is found by its file and by where its last record left it.
  const spinner = runJson?.running.find((entry) =>
    scenario.spin === 'test'
      ? entry.name === SPIN_NAME
      : entry.where === 'loading-file' &&
        entry.record?.file.endsWith(`/${SPIN_FILE}`) === true,
  );
  const sample = runJson?.samples.find((entry) => entry.pid === spinner?.pid);
  const samplePath = sample?.result ?? '';
  const ps = Bun.spawnSync(['ps', '-axo', 'pid=,args='], {stdout: 'pipe'});
  const survivors =
    ps.exitCode === 0
      ? ps.stdout
          .toString()
          .split('\n')
          .filter((line) => line.includes(fixture))
      : null;

  const stallChecks: {ok: boolean; what: string; why: string}[] =
    scenario.stallSeconds > 0
      ? [
          {
            ok: seconds < scenario.limitSeconds,
            what: `stopped before the ${scenario.limitSeconds} s wall limit`,
            why: `it took ${seconds.toFixed(1)} s`,
          },
          scenario.spin === 'test'
            ? {
                ok:
                  runJson?.stalled?.some(
                    (entry) => entry.name === SPIN_NAME,
                  ) === true,
                what: `run.json names "${SPIN_NAME}" as the stalled test`,
                why: `stalled: ${JSON.stringify(runJson?.stalled ?? null)}`,
              }
            : {
                ok:
                  spinner != null &&
                  runJson?.stalled?.some(
                    (entry) =>
                      entry.pid === spinner.pid &&
                      entry.where === 'loading-file',
                  ) === true,
                what: `run.json names the worker in ${SPIN_FILE}'s beforeAll as stalled, loading that file`,
                why: `stalled: ${JSON.stringify(runJson?.stalled ?? null)}`,
              },
        ]
      : [];
  const named =
    scenario.spin === 'test'
      ? {
          ok: spinner != null && stdout.includes(SPIN_NAME),
          what: `named "${SPIN_NAME}" in run.json and on screen`,
        }
      : {
          // The path is printed whole: the record says /private/var/…, the
          // cwd /var/…, so it is not relative to the cwd.
          ok:
            spinner != null &&
            stdout.includes(`/${SPIN_FILE} or in its beforeAll`),
          what: `named ${SPIN_FILE}'s load or beforeAll in run.json and on screen`,
        };
  const checks: {ok: boolean; what: string; why: string}[] = [
    {
      ok: result.exitCode === scenario.exit,
      what: `exit code ${scenario.exit}`,
      why: `it exited ${result.exitCode}`,
    },
    {
      ok: seconds <= scenario.stopBySeconds + SAMPLE_SECONDS + MARGIN_SECONDS,
      what: `stopped within ${scenario.stopBySeconds} s + ${SAMPLE_SECONDS} s sample + ${MARGIN_SECONDS} s margin`,
      why: `it took ${seconds.toFixed(1)} s`,
    },
    ...stallChecks,
    {
      ok: runJson?.outcome === scenario.outcome,
      what: `run.json says ${scenario.outcome}`,
      why: `outcome: ${runJson?.outcome ?? 'no run.json'}`,
    },
    {
      ...named,
      why: `running: ${JSON.stringify(runJson?.running ?? null)}`,
    },
    {
      ok:
        samplePath !== '' &&
        existsSync(samplePath) &&
        statSync(samplePath).size > 0 &&
        readFileSync(samplePath, 'utf8').includes('Call graph'),
      what: 'a sample of the spinning worker, with a call graph',
      why: `sample: ${samplePath === '' ? 'none' : samplePath}`,
    },
    {
      ok:
        runJson != null &&
        Array.isArray(runJson.leftovers) &&
        runJson.leftovers.length === 0,
      what: 'the script found no process of the run alive after the kill',
      why: `leftovers: ${JSON.stringify(runJson?.leftovers ?? null)}`,
    },
    {
      ok: survivors?.length === 0,
      what: 'ps shows no process whose command names the fixture',
      why:
        survivors == null
          ? 'ps did not run'
          : `alive: ${survivors.map((line) => line.trim()).join('; ')}`,
    },
  ];

  process.stdout.write(`\n=== scenario: ${name}\n\n${stdout}\n`);
  if (stderr.trim() !== '') process.stdout.write(`stderr:\n${stderr}\n`);
  process.stdout.write(
    `\nnegative control, ${name} (${seconds.toFixed(1)} s):\n\n`,
  );
  for (const check of checks) {
    process.stdout.write(
      `  ${check.ok ? 'PASS' : 'FAIL'}  ${check.what}${check.ok ? '' : ` (${check.why})`}\n\n`,
    );
  }
  return checks.every((check) => check.ok);
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const keep = args.includes('--keep');
  const unknown = args.filter((arg) => arg !== '--keep');
  if (unknown.length > 0) {
    process.stderr.write(`Unknown arguments: ${unknown.join(' ')}\n${USAGE}\n`);
    return 2;
  }

  const root = mkdtempSync(join(tmpdir(), 'test-parallel-negative-control-'));
  const results = (['stall', 'hook', 'limit'] as const).map((name) =>
    runScenario(root, name),
  );
  if (keep) process.stdout.write(`kept: ${root}\n`);
  else rmSync(root, {force: true, recursive: true});
  return results.every(Boolean) ? 0 : 1;
}

process.exitCode = main();
