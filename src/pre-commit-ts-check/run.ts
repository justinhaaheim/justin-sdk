/**
 * pre-commit-ts-check/run.ts — the IO half of the pre-commit type-check gate
 * (home-base-pp1vx.1.2): read the knob, list the staged paths, read and write
 * the last-green record, run the hook's own type-check command.
 *
 * The branch is at the top of runPreCommitTsCheck, per the feature-knobs rule:
 * with the knob off ("always", the default) the command runs exactly as the
 * hook ran it before, nothing is printed and nothing is written.
 */

import {spawnSync} from 'child_process';
import {mkdirSync, readFileSync, writeFileSync} from 'fs';
import {dirname, resolve} from 'path';

import {describeConfigOutcome, readProjectConfig} from '../sdk-config';
import {LAST_GREEN_STAMP_GIT_PATH} from './defaults';
import {
  decideTsCheck,
  decisionLine,
  FULL_CHECK_FAILED_LINE,
  type LastGreen,
  resolveGateKnob,
  type StagedPaths,
} from './gate';

export interface PreCommitTsCheckOptions {
  /** The hook's type-check command, as argv, e.g. ['npm', 'run', 'ts-check']. */
  command: readonly string[];
  /** Where the hook runs: the work tree's top level. */
  cwd: string;
  now?: () => Date;
  out?: (line: string) => void;
}

type GitResult = {error: string; ok: false} | {ok: true; stdout: string};

/**
 * `--no-optional-locks`: git holds index.lock while the hook runs. The child
 * inherits GIT_INDEX_FILE, which is how `git commit -a` and `git commit
 * <paths>` show this gate the temporary index they are about to commit.
 */
function git(cwd: string, args: readonly string[]): GitResult {
  const result = spawnSync('git', ['--no-optional-locks', ...args], {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error != null) return {error: result.error.message, ok: false};
  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    return {
      error: `git ${args.join(' ')} exited ${result.status ?? `on signal ${result.signal ?? 'unknown'}`}${stderr === '' ? '' : `: ${stderr}`}`,
      ok: false,
    };
  }
  return {ok: true, stdout: result.stdout};
}

/**
 * Every path the commit changes, both halves of a rename included
 * (`--no-renames`), so renaming a.ts to a.md still counts a.ts.
 */
export function listStagedPaths(cwd: string): StagedPaths {
  const result = git(cwd, [
    'diff',
    '--cached',
    '--name-only',
    '--no-renames',
    '--no-ext-diff',
    '-z',
  ]);
  if (!result.ok) return {error: result.error, kind: 'unknown'};
  return {
    kind: 'listed',
    paths: result.stdout.split('\0').filter((path) => path !== ''),
  };
}

function stampPath(cwd: string): {error: string} | {path: string} {
  const result = git(cwd, [
    'rev-parse',
    '--git-path',
    LAST_GREEN_STAMP_GIT_PATH,
  ]);
  if (!result.ok) return {error: result.error};
  return {path: resolve(cwd, result.stdout.trim())};
}

export function readLastGreen(cwd: string): LastGreen {
  const located = stampPath(cwd);
  if ('error' in located) return {error: located.error, kind: 'unreadable'};
  let raw: string;
  try {
    raw = readFileSync(located.path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {kind: 'none'};
    }
    return {error: (error as Error).message, kind: 'unreadable'};
  }
  try {
    const parsed = JSON.parse(raw) as {at?: unknown};
    const at = typeof parsed.at === 'string' ? new Date(parsed.at) : null;
    if (at == null || !Number.isFinite(at.getTime())) {
      return {
        error: `${located.path} has no valid "at" timestamp`,
        kind: 'unreadable',
      };
    }
    return {at, kind: 'recorded'};
  } catch (error) {
    return {
      error: `${located.path} is not JSON (${(error as Error).message})`,
      kind: 'unreadable',
    };
  }
}

/** Returns null on success, or why the record could not be written. */
function writeLastGreen(
  cwd: string,
  at: Date,
  command: readonly string[],
): string | null {
  const located = stampPath(cwd);
  if ('error' in located) return located.error;
  try {
    mkdirSync(dirname(located.path), {recursive: true});
    writeFileSync(
      located.path,
      `${JSON.stringify({at: at.toISOString(), command: command.join(' ')})}\n`,
    );
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

/** Run the type-check with inherited stdio. A signal or a failed start is never 0. */
function runCommand(
  command: readonly string[],
  cwd: string,
  out: (line: string) => void,
): number {
  const [program, ...args] = command;
  if (program == null) return 2;
  const result = spawnSync(program, args, {cwd, stdio: 'inherit'});
  if (result.error != null) {
    out(`ts-check: could not start ${program}: ${result.error.message}`);
    return 1;
  }
  if (result.status == null) {
    out(`ts-check: ${program} ended on signal ${result.signal ?? 'unknown'}`);
    return 1;
  }
  return result.status;
}

function readKnobConfig(cwd: string): unknown {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!top.ok) return `the repo root could not be found: ${top.error}`;
  const outcome = readProjectConfig(top.stdout.trim());
  if (outcome.status === 'absent') return null;
  if (outcome.status === 'ok') return outcome.config;
  return describeConfigOutcome(outcome);
}

/**
 * The gate. Returns the exit code for the hook: the type-check's own code when
 * it ran, 0 when it was skipped, 2 when no command was given.
 */
export function runPreCommitTsCheck(options: PreCommitTsCheckOptions): number {
  const out = options.out ?? ((line: string) => console.log(line));
  const now = options.now ?? (() => new Date());
  const {command, cwd} = options;
  if (command.length === 0) {
    out(
      'ts-check: no type-check command given. Usage: justin-sdk pre-commit-ts-check -- <command…>, e.g. -- npm run ts-check',
    );
    return 2;
  }

  const knob = resolveGateKnob(readKnobConfig(cwd));
  for (const problem of knob.problems) out(problem);

  // THE KNOB'S BRANCH (feature-knobs rule). Off: exactly the old hook line.
  if (knob.mode === 'always') return runCommand(command, cwd, out);

  const decision = decideTsCheck({
    everyHours: knob.everyHours,
    lastGreen: readLastGreen(cwd),
    mode: knob.mode,
    now: now(),
    staged: listStagedPaths(cwd),
  });
  const line = decisionLine(decision);
  if (line != null) out(line);
  if (!decision.run) return 0;

  const code = runCommand(command, cwd, out);
  if (code !== 0) {
    if (decision.reason === 'full-check-due') out(FULL_CHECK_FAILED_LINE);
    return code;
  }
  const writeError = writeLastGreen(cwd, now(), command);
  if (writeError != null) {
    out(
      `ts-check: passed, but the record of it could not be written (${writeError}); the next commit that would skip type-checks instead`,
    );
  }
  return 0;
}
