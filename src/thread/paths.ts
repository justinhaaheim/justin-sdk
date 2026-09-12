/**
 * Where the `thread` command group keeps its state, and whether it may write
 * there at all.
 *
 * THE SANDBOX CONTRACT (home-base-p1uj.1, design field — binding).
 *
 * Claude Code's Bash sandbox allows writes only inside the session's project
 * directory, `$TMPDIR`, `/tmp/claude` and a handful of `~/.claude` paths.
 * `thread` touches two things that are outside all of those from any session
 * that is not itself running in ~/Dev/life:
 *
 *   1. the archive/spool dir (`~/.local/state/justin-threads` by default), and
 *   2. `~/Dev/life/.beads`, where Dolt's LOCK file lives — denied even on READ.
 *
 * Neither is a bug to work around. The contract is: PROBE both paths cheaply
 * before doing anything that would trip a permission prompt, and when either is
 * denied say so in one line that names the fix. The shipped tool never asks to
 * be run with the sandbox disabled, and never spends a bd call it knows will
 * fail.
 *
 * Both roots are env-overridable. `JUSTIN_THREADS_STATE_DIR` exists so a
 * sandboxed session (or a test) can point the archive somewhere writable;
 * `JUSTIN_THREADS_LIFE_DIR` exists so the bd adapter can be pointed at a
 * different — or deliberately empty — workspace, which is how the
 * "bd unreachable" path is exercised for real.
 */

import {homedir} from 'os';
import {join} from 'path';
import {mkdirSync, rmSync, writeFileSync} from 'fs';

/** Environment as this module consumes it — `process.env` is assignable. */
export type EnvLike = Record<string, string | undefined>;

export const STATE_DIR_ENV_VAR = 'JUSTIN_THREADS_STATE_DIR';
export const LIFE_DIR_ENV_VAR = 'JUSTIN_THREADS_LIFE_DIR';

/** Default archive/spool root. Shown verbatim in the SANDBOX DENIED line. */
export const DEFAULT_STATE_DIR_DISPLAY = '~/.local/state/justin-threads';

/** Default bd workspace. Shown verbatim in the SANDBOX DENIED line. */
export const DEFAULT_LIFE_BEADS_DISPLAY = '~/Dev/life/.beads';

/** Archive + spool root for report payloads. */
export function threadsStateDir(env: EnvLike = process.env): string {
  const override = env[STATE_DIR_ENV_VAR];
  if (override != null && override !== '') return override;
  return join(homedir(), '.local', 'state', 'justin-threads');
}

/** The bd workspace that holds `thread` and `ask` beads (D2). */
export function lifeRepoDir(env: EnvLike = process.env): string {
  const override = env[LIFE_DIR_ENV_VAR];
  if (override != null && override !== '') return override;
  return join(homedir(), 'Dev', 'life');
}

/** The `.beads` directory inside the bd workspace — the path that is denied. */
export function lifeBeadsDir(env: EnvLike = process.env): string {
  return join(lifeRepoDir(env), '.beads');
}

/**
 * Result of one cheap write probe.
 *
 * `denied` is a DISTINCT member from `failed` on purpose (rule 6): "the sandbox
 * refused me" is an actionable, one-command fix, while "the disk is full" or
 * "the parent does not exist" is not, and collapsing them would print the wrong
 * remedy for the wrong problem.
 */
export type WriteProbe =
  | {kind: 'writable'; path: string}
  | {kind: 'denied'; path: string; error: string}
  | {kind: 'failed'; path: string; error: string};

/** True for the errnos the Claude Code sandbox raises when it refuses a write. */
function isDenial(error: unknown): boolean {
  const code =
    error != null && typeof error === 'object' && 'code' in error
      ? String((error as {code: unknown}).code)
      : '';
  if (code === 'EPERM' || code === 'EACCES' || code === 'EROFS') return true;
  const message = error instanceof Error ? error.message : String(error);
  return /operation not permitted|permission denied/i.test(message);
}

export function probeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Can we write inside `dir`? Creates the directory if needed, writes a uniquely
 * named probe file, and removes it again.
 *
 * Deliberately NOT `access(W_OK)`: the sandbox is a syscall filter, not a
 * permission bit, and `access` reports the bits. Only an actual write tells the
 * truth. The probe file name is prefixed with a dot and carries the pid so two
 * concurrent sessions cannot collide, and it is removed in a `finally` so a
 * crash between write and unlink still cleans up on the next run's `rmSync`.
 */
export function probeWritable(dir: string): WriteProbe {
  const probePath = join(dir, `.justin-threads-probe-${process.pid}`);
  try {
    mkdirSync(dir, {recursive: true});
  } catch (error) {
    return isDenial(error)
      ? {error: probeErrorMessage(error), kind: 'denied', path: dir}
      : {error: probeErrorMessage(error), kind: 'failed', path: dir};
  }
  try {
    writeFileSync(probePath, 'probe\n');
  } catch (error) {
    return isDenial(error)
      ? {error: probeErrorMessage(error), kind: 'denied', path: dir}
      : {error: probeErrorMessage(error), kind: 'failed', path: dir};
  } finally {
    try {
      rmSync(probePath, {force: true});
    } catch {
      // Leaving a 6-byte probe file behind is not worth failing a command over.
    }
  }
  return {kind: 'writable', path: dir};
}

/**
 * The ONE line printed when either path is denied (design field, verbatim).
 *
 * Exported as a constant, and asserted in the tests, because the rule that
 * drives this tool branches on the exact prefix `THREADS:` and a human reading
 * it needs the fix without a second lookup. Never reword it to suggest running
 * with the sandbox disabled — the shipped tool must not depend on that.
 */
export const SANDBOX_DENIED_LINE = `THREADS: SANDBOX DENIED - allowlist these paths for writes (via /sandbox in user settings): ${DEFAULT_LIFE_BEADS_DISPLAY} and ${DEFAULT_STATE_DIR_DISPLAY}`;
