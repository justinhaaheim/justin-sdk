/**
 * What the `.husky/pre-commit` type-check block DOES when git runs it
 * (home-base-lzvh D2), one branch per test.
 *
 * The block runs exactly as husky runs a hook: `sh -e <hook>`, with cwd = the
 * repo root (git's rule for hooks). `bun` is a stub first on PATH, so each test
 * controls what `justin-sdk --help` lists and what the type-check exits with,
 * and reads back every command the block ran. Real commits in real repos are in
 * the bead's measurement record; this file pins the four branches of D2.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {spawnSync} from 'child_process';
import {chmodSync, existsSync, readFileSync, writeFileSync} from 'fs';
import {dirname, join} from 'path';

import {readPreCommitTsCheckBlock} from '../src/husky-setup';
import {createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];

afterEach(() => {
  while (sandboxes.length > 0) {
    sandboxes.pop()?.cleanup();
  }
});

/**
 * Logs its arguments, answers `--help`, and for the type-check prints
 * $STUB_TSC_OUTPUT on stderr (as tsc via `bun run` does) and exits as told.
 */
const STUB_BUN = `#!/bin/sh
printf '%s\\n' "$*" >> "$STUB_LOG"
case "$*" in
  "run justin-sdk --help") printf '%s\\n' "$STUB_HELP"; exit 0 ;;
  *signal-source:TS*)
    if [ -n "$STUB_TSC_OUTPUT" ]; then printf '%s\\n' "$STUB_TSC_OUTPUT" >&2; fi
    exit "$STUB_TSC_EXIT" ;;
esac
exit 0
`;

/** tsc's own wording, as `tsc --noEmit` prints it with no inputs. */
const TS18003_OUTPUT =
  "$ tsc --noEmit\nerror TS18003: No inputs were found in config file '/repo/tsconfig.json'. Specified 'include' paths were '[\"**/*.ts\"]' and 'exclude' paths were '[]'.";
const TS2322_OUTPUT =
  "$ tsc --noEmit\nsrc/a.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.";

/**
 * The environment a hook's children see, minus any GIT_* variables of the git
 * running THIS test (a test run from inside a hook would otherwise point every
 * git call below at the outer repo).
 */
function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {...process.env};
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  return {...env, ...extra};
}

const HELP_WITH_COMMAND =
  'justin-sdk <command>\n  justin-sdk pre-commit-ts-check  Type-check before a commit';
const HELP_WITHOUT_COMMAND = 'justin-sdk <command>\n  justin-sdk doctor';

interface RepoShape {
  /**
   * The git repo around the hook: none at all, one whose index holds no
   * TypeScript file, or one with a staged `src/a.ts`. Default: no TS files.
   */
  git?: 'absent' | 'no-ts-files' | 'ts-files';
  /** package.json scripts; null writes no package.json at all. */
  scripts: Record<string, string> | null;
  tsconfig: boolean;
}

interface HookRun {
  /** Every `bun` command line the block ran, in order. */
  bunCalls: string[];
  status: number | null;
  stderr: string;
  stdout: string;
}

function runBlock(
  shape: RepoShape,
  stub: {help: string; tscExit: number; tscOutput?: string},
): HookRun {
  const sb = createSandbox();
  sandboxes.push(sb);
  const git = shape.git ?? 'no-ts-files';
  if (git !== 'absent') {
    const init = spawnSync('git', ['init', '-q'], {
      cwd: sb.path,
      env: cleanEnv({}),
    });
    if (init.status !== 0) throw new Error('git init failed');
  }
  if (git === 'ts-files') {
    sb.writeFile('src/a.ts', 'export const a = 1;\n');
    const add = spawnSync('git', ['add', 'src/a.ts'], {
      cwd: sb.path,
      env: cleanEnv({}),
    });
    if (add.status !== 0) throw new Error('git add failed');
  }
  if (shape.tsconfig) sb.writeFile('tsconfig.json', '{}\n');
  if (shape.scripts != null) {
    sb.writeFile(
      'package.json',
      `${JSON.stringify({name: 'probe', scripts: shape.scripts}, null, 2)}\n`,
    );
  }
  const block = readPreCommitTsCheckBlock();
  if (block == null) throw new Error('the block template could not be read');
  sb.writeFile('.husky/pre-commit', block);
  sb.writeFile('stub-bin/bun', STUB_BUN);
  chmodSync(join(sb.path, 'stub-bin', 'bun'), 0o755);
  const log = join(sb.path, 'bun-calls.log');
  writeFileSync(log, '');

  const result = spawnSync('sh', ['-e', '.husky/pre-commit'], {
    cwd: sb.path,
    encoding: 'utf-8',
    env: cleanEnv({
      // No repo above the sandbox may answer for the 'absent' case.
      GIT_CEILING_DIRECTORIES: dirname(sb.path),
      PATH: `${join(sb.path, 'stub-bin')}:${process.env.PATH ?? ''}`,
      STUB_HELP: stub.help,
      STUB_LOG: log,
      STUB_TSC_EXIT: String(stub.tscExit),
      STUB_TSC_OUTPUT: stub.tscOutput ?? '',
    }),
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf-8') : '';
  return {
    bunCalls: calls.split('\n').filter((line) => line !== ''),
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

const WITH_SCRIPT = {'signal-source:TS': 'tsc --noEmit'};

describe('the .husky/pre-commit type-check block', () => {
  test('D2.1: no tsconfig.json → runs nothing and prints nothing', () => {
    const run = runBlock(
      {scripts: WITH_SCRIPT, tsconfig: false},
      {help: HELP_WITH_COMMAND, tscExit: 2},
    );
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe('');
    expect(run.bunCalls).toEqual([]);
  });

  test('D2.2: tsconfig.json but no signal-source:TS script → one line saying why, and the commit goes on', () => {
    const run = runBlock(
      {scripts: {'signal-source:LINT': 'eslint .'}, tsconfig: true},
      {help: HELP_WITH_COMMAND, tscExit: 2},
    );
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(
      '[pre-commit] Type check skipped: package.json has no "signal-source:TS" script.\n',
    );
    expect(run.bunCalls).toEqual([]);
  });

  test('D2.3: an SDK with pre-commit-ts-check runs the type-check through it', () => {
    const run = runBlock(
      {scripts: WITH_SCRIPT, tsconfig: true},
      {help: HELP_WITH_COMMAND, tscExit: 0},
    );
    expect(run.status).toBe(0);
    expect(run.bunCalls).toEqual([
      'run justin-sdk --help',
      'run justin-sdk pre-commit-ts-check -- bun run signal-source:TS',
    ]);
  });

  test('D2.4: an SDK without the command runs signal-source:TS directly', () => {
    const run = runBlock(
      {scripts: WITH_SCRIPT, tsconfig: true},
      {help: HELP_WITHOUT_COMMAND, tscExit: 0},
    );
    expect(run.status).toBe(0);
    expect(run.bunCalls).toEqual([
      'run justin-sdk --help',
      'run signal-source:TS',
    ]);
  });

  test('a failing type-check refuses the commit, through either path', () => {
    for (const help of [HELP_WITH_COMMAND, HELP_WITHOUT_COMMAND]) {
      const run = runBlock(
        {scripts: WITH_SCRIPT, tsconfig: true},
        {help, tscExit: 2},
      );
      expect(run.status).not.toBe(0);
    }
  });

  const NO_TS_SKIP =
    '[pre-commit] Type check skipped: this repo has no TypeScript files (TS18003), so there is nothing to type-check.';
  const INCLUDE_BROKEN =
    "[pre-commit] Type check failed: tsconfig.json's include matches none of this repo's TypeScript files (TS18003).";

  function lines(text: string, wanted: string): number {
    return text.split('\n').filter((line) => line === wanted).length;
  }

  test('D2.5: TS18003 with no TypeScript file in git → one line, and the commit goes on (either path)', () => {
    for (const help of [HELP_WITH_COMMAND, HELP_WITHOUT_COMMAND]) {
      const run = runBlock(
        {git: 'no-ts-files', scripts: WITH_SCRIPT, tsconfig: true},
        {help, tscExit: 2, tscOutput: TS18003_OUTPUT},
      );
      expect(run.status).toBe(0);
      expect(lines(run.stdout, NO_TS_SKIP)).toBe(1);
      // The check's own output is still shown.
      expect(run.stdout).toContain('error TS18003');
    }
  });

  test('D2.5: TS18003 with a TypeScript file staged → refused, saying the include is broken', () => {
    const run = runBlock(
      {git: 'ts-files', scripts: WITH_SCRIPT, tsconfig: true},
      {help: HELP_WITH_COMMAND, tscExit: 2, tscOutput: TS18003_OUTPUT},
    );
    expect(run.status).toBe(1);
    expect(lines(run.stdout, INCLUDE_BROKEN)).toBe(1);
    expect(lines(run.stdout, NO_TS_SKIP)).toBe(0);
  });

  test('D2.5: TS18003 where git cannot list files → refused, never read as "no files"', () => {
    const run = runBlock(
      {git: 'absent', scripts: WITH_SCRIPT, tsconfig: true},
      {help: HELP_WITH_COMMAND, tscExit: 2, tscOutput: TS18003_OUTPUT},
    );
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('git ls-files could not list');
    expect(lines(run.stdout, NO_TS_SKIP)).toBe(0);
  });

  test('a failure without TS18003 refuses, even in a repo with no TypeScript file', () => {
    for (const tscOutput of [TS2322_OUTPUT, 'Segmentation fault: 11']) {
      const run = runBlock(
        {git: 'no-ts-files', scripts: WITH_SCRIPT, tsconfig: true},
        {help: HELP_WITH_COMMAND, tscExit: 2, tscOutput},
      );
      expect(run.status).toBe(1);
      expect(run.stdout).toContain(tscOutput.split('\n').at(-1) ?? '');
      expect(lines(run.stdout, NO_TS_SKIP)).toBe(0);
    }
  });

  test('a failing type-check refuses the commit without errexit too', () => {
    // A hook copied into .git/hooks, or run by a tool other than husky, has no
    // `sh -e`; the block's own `|| exit 1` must still stop it.
    const sb = createSandbox();
    sandboxes.push(sb);
    sb.writeFile('tsconfig.json', '{}\n');
    sb.writeFile(
      'package.json',
      `${JSON.stringify({name: 'probe', scripts: WITH_SCRIPT})}\n`,
    );
    const block = readPreCommitTsCheckBlock();
    if (block == null) throw new Error('the block template could not be read');
    sb.writeFile('.husky/pre-commit', `${block}\necho "lint-staged ran"\n`);
    sb.writeFile('stub-bin/bun', STUB_BUN);
    chmodSync(join(sb.path, 'stub-bin', 'bun'), 0o755);
    const log = join(sb.path, 'bun-calls.log');
    writeFileSync(log, '');
    const result = spawnSync('sh', ['.husky/pre-commit'], {
      cwd: sb.path,
      encoding: 'utf-8',
      env: {
        ...process.env,
        PATH: `${join(sb.path, 'stub-bin')}:${process.env.PATH ?? ''}`,
        STUB_HELP: HELP_WITH_COMMAND,
        STUB_LOG: log,
        STUB_TSC_EXIT: '2',
      },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain('lint-staged ran');
  });
});
