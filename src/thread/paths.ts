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
import {mkdirSync, readdirSync, rmSync, statSync, writeFileSync} from 'fs';

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
 *
 * `missing` is the fourth member, and it exists because of F9 (p1uj.6): the
 * probe used to `mkdirSync` whatever it was handed, so on a machine with no
 * ~/Dev/life it CREATED ~/Dev/life/.beads and reported it writable — after
 * which every bd call failed with `Script not found "bd"`, and the beads
 * workspace was a directory this tool had fabricated. "There is no workspace
 * here" and "I can write to the workspace" are opposite facts.
 */
export type WriteProbe =
  | {kind: 'writable'; path: string}
  | {kind: 'missing'; path: string}
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

/** Every probe file this tool has ever written starts with this. */
const PROBE_PREFIX = '.justin-threads-probe-';

/**
 * Remove probe files left by runs that died between the write and the unlink.
 *
 * The old comment claimed a crashed probe was cleaned up "on the next run's
 * rmSync", which was false (F9): each run only ever removed its OWN pid-named
 * file, so a killed run left `.justin-threads-probe-<pid>` inside
 * ~/Dev/life/.beads — a directory whose own .gitignore does not cover it, so it
 * showed as untracked in the life repo forever. Sweeping the whole prefix is
 * what makes the claim true.
 *
 * Deleting a CONCURRENT probe's file is harmless and is not worth avoiding: by
 * the time a sweep can see it, that probe's `writeFileSync` has already
 * returned (which is the whole measurement), and its own cleanup is
 * `force: true`.
 */
function sweepStaleProbes(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    // Unreadable: the write probe below is what reports why, with the right
    // remedy attached. Nothing to say here.
    return;
  }
  for (const name of names) {
    if (!name.startsWith(PROBE_PREFIX)) continue;
    try {
      rmSync(join(dir, name), {force: true});
    } catch {
      // A probe file we cannot remove is a nuisance, not a reason to fail a
      // command that has not even started yet.
    }
  }
}

/**
 * Can we write inside `dir`? Writes a uniquely named probe file and removes it.
 *
 * Deliberately NOT `access(W_OK)`: the sandbox is a syscall filter, not a
 * permission bit, and `access` reports the bits. Only an actual write tells the
 * truth. The probe file name is prefixed with a dot and carries the pid so two
 * concurrent sessions cannot collide, and stale ones are swept at probe time.
 *
 * `create` IS THE CALLER'S DECISION AND HAS NO DEFAULT (F9). The state dir is
 * ours to create; `~/Dev/life/.beads` is bd's, and a tool that conjures it has
 * turned "you have no beads workspace" into "you have an empty one". A missing
 * no-create directory returns `missing`, which is distinct from `denied` — and
 * the distinction is measured with `statSync` rather than `existsSync`,
 * precisely because `existsSync` reports a READ the sandbox refused as "not
 * there".
 */
export function probeWritable(
  dir: string,
  options: {create: boolean},
): WriteProbe {
  if (options.create) {
    try {
      mkdirSync(dir, {recursive: true});
    } catch (error) {
      return isDenial(error)
        ? {error: probeErrorMessage(error), kind: 'denied', path: dir}
        : {error: probeErrorMessage(error), kind: 'failed', path: dir};
    }
  } else {
    try {
      if (!statSync(dir).isDirectory()) {
        return {error: 'not a directory', kind: 'failed', path: dir};
      }
    } catch (error) {
      if (isDenial(error)) {
        return {error: probeErrorMessage(error), kind: 'denied', path: dir};
      }
      const code =
        error != null && typeof error === 'object' && 'code' in error
          ? String((error as {code: unknown}).code)
          : '';
      return code === 'ENOENT'
        ? {kind: 'missing', path: dir}
        : {error: probeErrorMessage(error), kind: 'failed', path: dir};
    }
  }
  sweepStaleProbes(dir);
  const probePath = join(dir, `${PROBE_PREFIX}${process.pid}`);
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
      // Leaving a 6-byte probe file behind is not worth failing a command over;
      // the next run's sweep removes it.
    }
  }
  return {kind: 'writable', path: dir};
}

/** The line every command prints when the beads workspace is not there (F9). */
export function lifeBeadsMissingLine(path: string): string {
  return `THREADS: life beads dir missing - ${path} does not exist, so there is no beads workspace to read or write. Nothing was created.`;
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
