/**
 * home-base-gsqz — the sweep payload must not turn a green repo red by deleting
 * its last TypeScript file.
 *
 * base-setup retires `scripts/setup-env.ts`. Where that was the repo's ONLY
 * `.ts` (imessage-exporter, a Rust fork; userscripts-j), the tsconfig's include
 * then matches nothing and `tsc --noEmit` exits 1 with TS18003 — a red signal
 * gate the repo cannot recover from, created by the payload.
 *
 * The fix is a THIRD outcome, not a second: "no TypeScript to check" is
 * reported as NOT APPLICABLE with its own reason — never a pass (that would
 * also hide a genuinely broken `include`) and never a failure.
 *
 * `tsc` is invoked for real wherever it can be resolved: the discrimination
 * these tests turn on is tsc's actual TS18003 behavior, and a hand-written
 * fake of that string would be testing the fake.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {existsSync, readFileSync} from 'fs';
import {dirname, join, resolve} from 'path';

import {stepSetupEnvScript} from '../src/base-setup';
import {
  classifyTsCheckOutcome,
  findTypeScriptSources,
  TS_NO_INPUTS_CODE,
} from '../src/ts-inputs';
import {setQuiet} from '../src/setup-helpers';
import {createSandbox, type Sandbox} from './sandbox';

const SDK_ROOT = resolve(import.meta.dirname, '..');

/** The real tsc binary, hoisted into an ancestor node_modules. */
function findTsc(): string | null {
  let dir = SDK_ROOT;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'node_modules', '.bin', 'tsc');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const TSC = findTsc();

const sandboxes: Sandbox[] = [];
function track(sandbox: Sandbox): Sandbox {
  sandboxes.push(sandbox);
  return sandbox;
}
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

const stripAnsi = (text: string): string =>
  // eslint-disable-next-line no-control-regex
  text.replace(/\x1b\[[0-9;]*m/g, '');

/**
 * Collect everything a step writes to console.log / console.warn.
 *
 * `setQuiet(false)` first: QUIET is module-level state in setup-helpers, bun
 * runs every test FILE in one process, and any other file that ran a setup with
 * `quiet: true` leaves it latched on — which silently turned this assertion
 * into a no-op depending on file order.
 */
function captureOutput(fn: () => void): string {
  setQuiet(false);
  const lines: string[] = [];
  const collect =
    () =>
    (...args: unknown[]): void => {
      lines.push(args.map(String).join(' '));
    };
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = collect();
  console.warn = collect();
  try {
    fn();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
  return lines.join('\n');
}

/**
 * A repo with a tsconfig, a `signal-source:TS` script bound to the real tsc,
 * and whatever source files the case needs.
 */
function tsFixture(
  sb: Sandbox,
  options: {files?: Record<string, string>; include: string[]},
): string {
  sb.writeFile(
    'package.json',
    JSON.stringify(
      {
        name: 'ts-fixture',
        scripts: {'signal-source:TS': `${TSC ?? 'tsc'} --noEmit`},
        version: '0.0.1',
      },
      null,
      2,
    ) + '\n',
  );
  sb.writeFile(
    'tsconfig.json',
    JSON.stringify(
      {compilerOptions: {noEmit: true}, include: options.include},
      null,
      2,
    ) + '\n',
  );
  for (const [rel, content] of Object.entries(options.files ?? {})) {
    sb.writeFile(rel, content);
  }
  return sb.path;
}

/** Run the SDK's own `signal` in `cwd` and return its combined output. */
function runSignalCli(cwd: string): {output: string; exitCode: number} {
  const proc = Bun.spawnSync(
    ['bun', join(SDK_ROOT, 'src', 'cli.ts'), 'signal'],
    {
      cwd,
      env: process.env,
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );
  return {
    exitCode: proc.exitCode,
    output: stripAnsi(proc.stdout.toString() + proc.stderr.toString()),
  };
}

// ---------------------------------------------------------------------------
// findTypeScriptSources — the discriminator tsc's output cannot provide
// ---------------------------------------------------------------------------

describe('gsqz — findTypeScriptSources', () => {
  test('finds a .ts anywhere in the repo', () => {
    const sb = track(createSandbox());
    sb.writeFile('scripts/setup-env.ts', 'export {};\n');
    expect(findTypeScriptSources(sb.path, 5)).toEqual(['scripts/setup-env.ts']);
  });

  test('finds nothing in a repo with no TypeScript', () => {
    const sb = track(createSandbox());
    sb.writeFile('src/main.rs', 'fn main() {}\n');
    sb.writeFile('README.md', '# hi\n');
    expect(findTypeScriptSources(sb.path, 5)).toEqual([]);
  });

  test('ignores node_modules and dot-directories (a worktree is not this repo)', () => {
    const sb = track(createSandbox());
    sb.writeFile('node_modules/pkg/index.ts', 'export {};\n');
    sb.writeFile(
      '.claude/worktrees/sdk-sweep/scripts/setup-env.ts',
      'export {};\n',
    );
    expect(findTypeScriptSources(sb.path, 5)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC2 + AC3 — three states, asserted on the REPORTED OUTCOME
// ---------------------------------------------------------------------------

describe('gsqz — classifyTsCheckOutcome distinguishes all three states', () => {
  const TS18003 = `error ${TS_NO_INPUTS_CODE}: No inputs were found in config file '/x/tsconfig.json'. Specified 'include' paths were '["**/*.ts"]' and 'exclude' paths were '[]'.`;

  test('exit 0 is left alone (never reclassified)', () => {
    const sb = track(createSandbox());
    expect(
      classifyTsCheckOutcome({exitCode: 0, output: '', projectRoot: sb.path}),
    ).toBeNull();
  });

  test('AC2: TS18003 with no sources → not applicable, with a reason', () => {
    const sb = track(createSandbox());
    sb.writeFile('src/main.rs', 'fn main() {}\n');
    const verdict = classifyTsCheckOutcome({
      exitCode: 1,
      output: TS18003,
      projectRoot: sb.path,
    });
    expect(verdict).not.toBeNull();
    expect(verdict?.reason).toContain('no TypeScript sources');
    expect(verdict?.reason).toContain(TS_NO_INPUTS_CODE);
    // Explicitly NOT a pass: the shape carries only a reason — there is no
    // representation in which a classifier can report success.
    expect(Object.keys(verdict ?? {})).toEqual(['reason']);
  });

  test('AC3: TS18003 while .ts files DO exist → stays a failure', () => {
    const sb = track(createSandbox());
    sb.writeFile('lib/thing.ts', 'export const a = 1;\n');
    expect(
      classifyTsCheckOutcome({
        exitCode: 1,
        output: TS18003,
        projectRoot: sb.path,
      }),
    ).toBeNull();
  });

  test('a REAL type error is never reclassified, sources or not', () => {
    const sb = track(createSandbox());
    expect(
      classifyTsCheckOutcome({
        exitCode: 2,
        output:
          "src/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.",
        projectRoot: sb.path,
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// End to end through the real signal runner + real tsc
// ---------------------------------------------------------------------------

describe('gsqz — signal reports the three states end to end', () => {
  test.skipIf(TSC == null)(
    'AC2 e2e: a repo with no .ts at all → exit 0, reported as not applicable, NOT as a pass',
    () => {
      const sb = track(createSandbox());
      tsFixture(sb, {
        files: {'src/main.rs': 'fn main() {}\n'},
        include: ['**/*.ts', '**/*.tsx'],
      });

      const {exitCode, output} = runSignalCli(sb.path);

      expect(output).toContain(TS_NO_INPUTS_CODE);
      expect(output).toContain('not applicable');
      expect(output).toContain('no TypeScript sources');
      expect(output).toContain('1 not applicable');
      // The outcome, not merely the exit code: it must not be counted a pass.
      expect(output).not.toContain('1 pass');
      expect(output).not.toContain('All 1 checks passed');
      expect(exitCode).toBe(0);
    },
  );

  test.skipIf(TSC == null)(
    'AC3 e2e: sources exist but the include misses them → still RED',
    () => {
      const sb = track(createSandbox());
      tsFixture(sb, {
        files: {'lib/thing.ts': 'export const a: number = 1;\n'},
        include: ['src/**/*.ts'],
      });

      const {exitCode, output} = runSignalCli(sb.path);

      expect(output).toContain(TS_NO_INPUTS_CODE);
      expect(output).toContain('1 fail');
      expect(output).not.toContain('not applicable');
      expect(exitCode).toBe(1);
    },
  );

  test.skipIf(TSC == null)('a real type error is still RED', () => {
    const sb = track(createSandbox());
    tsFixture(sb, {
      files: {'src/bad.ts': 'export const a: number = "nope";\n'},
      include: ['**/*.ts'],
    });

    const {exitCode, output} = runSignalCli(sb.path);

    expect(output).toContain('TS2322');
    expect(output).toContain('1 fail');
    expect(exitCode).toBe(1);
  });

  test.skipIf(TSC == null)('a genuinely clean TS repo still passes', () => {
    const sb = track(createSandbox());
    tsFixture(sb, {
      files: {'src/good.ts': 'export const a: number = 1;\n'},
      include: ['**/*.ts'],
    });

    const {exitCode, output} = runSignalCli(sb.path);

    expect(output).toContain('1 pass');
    expect(output).not.toContain('not applicable');
    expect(exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC1 — the payload's own retirement step, on the imessage-exporter shape
// ---------------------------------------------------------------------------

describe('gsqz AC1 — retiring the last .ts leaves the gate green', () => {
  test.skipIf(TSC == null)(
    'setup-env.ts was the only .ts: it is deleted and signal still exits 0',
    () => {
      const sb = track(createSandbox());
      tsFixture(sb, {include: ['**/*.ts', '**/*.tsx']});
      // A type-clean stand-in for the retired file. NOT the real template:
      // that one imports SDK modules a bare fixture has no node_modules for, so
      // the "before" state could not be green and the test would prove nothing
      // about the deletion. Recognition of the real template is base-setup's
      // own tested behavior; what gsqz turns on is the CONSEQUENCE of the
      // deletion, so the file is removed with `force`.
      sb.writeFile('scripts/setup-env.ts', 'export const setupEnv = 1;\n');

      // Before: one .ts, and the gate is green.
      expect(findTypeScriptSources(sb.path, 5)).toEqual([
        'scripts/setup-env.ts',
      ]);
      expect(runSignalCli(sb.path).exitCode).toBe(0);

      expect(stepSetupEnvScript(sb.path, true)).toBe(true);
      expect(existsSync(join(sb.path, 'scripts', 'setup-env.ts'))).toBe(false);
      expect(findTypeScriptSources(sb.path, 5)).toEqual([]);

      // After: TS18003 is reported, the repo is NOT red.
      const after = runSignalCli(sb.path);
      expect(after.output).toContain(TS_NO_INPUTS_CODE);
      expect(after.output).toContain('not applicable');
      expect(after.exitCode).toBe(0);
    },
  );

  test.skipIf(TSC == null)(
    'NEGATIVE CONTROL: without the classifier that same fixture is red',
    () => {
      const sb = track(createSandbox());
      tsFixture(sb, {include: ['**/*.ts', '**/*.tsx']});
      // Run tsc directly — i.e. what the check did before the classifier
      // existed. This is the state imessage-exporter was left in.
      const proc = Bun.spawnSync([TSC ?? 'tsc', '--noEmit'], {
        cwd: sb.path,
        stderr: 'pipe',
        stdout: 'pipe',
      });
      expect(proc.exitCode).not.toBe(0);
      expect(proc.stdout.toString() + proc.stderr.toString()).toContain(
        TS_NO_INPUTS_CODE,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Fix shape 3 — the retirement says so out loud
// ---------------------------------------------------------------------------

describe('gsqz — base-setup announces removing the last .ts', () => {
  test('the warning names what happened', () => {
    const sb = track(createSandbox());
    // The real template, byte-identical — this test DOES exercise recognition.
    sb.writeFile(
      'scripts/setup-env.ts',
      readFileSync(
        join(SDK_ROOT, 'templates', 'scripts', 'setup-env.ts'),
        'utf-8',
      ),
    );

    const all = stripAnsi(captureOutput(() => stepSetupEnvScript(sb.path)));
    expect(all).toContain('Deleted scripts/setup-env.ts');
    expect(all).toContain('LAST TypeScript file');
    expect(all).toContain('home-base-gsqz');
  });

  test('and stays quiet when other .ts files remain', () => {
    const sb = track(createSandbox());
    sb.writeFile(
      'scripts/setup-env.ts',
      readFileSync(
        join(SDK_ROOT, 'templates', 'scripts', 'setup-env.ts'),
        'utf-8',
      ),
    );
    sb.writeFile('src/index.ts', 'export {};\n');

    const all = stripAnsi(captureOutput(() => stepSetupEnvScript(sb.path)));
    expect(all).not.toContain('LAST TypeScript file');
  });
});
