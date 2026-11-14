/**
 * The git the tests run: the binary the /usr/bin/git shim forwards to, called
 * directly (home-base-ejsq2.2).
 *
 * WHY. On macOS, /usr/bin/git is an xcrun shim: every call first asks xcrun
 * which developer directory is selected, then runs that directory's git. The
 * suite makes about 38,000 git calls, and the shim adds about 4 ms to each
 * (measured 2026-11-14: rev-parse 8.7 to 9.3 ms through the shim, 4.4 to 5.4 ms
 * direct; home-base-ejsq2.1). Calling the binary the shim would pick runs the
 * same git, so no test proves anything different.
 *
 * HOW. The preload calls `installGitPin()` once. It asks `xcrun --find git` for
 * the binary, checks that it reports the same `git --version` as the git on
 * PATH, and puts a NEW temporary directory holding only a `git` symlink to it
 * first on `process.env.PATH`. Not the binary's own directory: Xcode's
 * usr/bin also holds python3, pip3, make, gcc, ld and about 110 other tools,
 * and putting it first would change which of those the tests run.
 *
 * WHAT IT REACHES. Every node:child_process call (execFileSync, spawnSync,
 * exec, …) passes `process.env` to Bun when the caller gives no env, so it
 * sees the pinned PATH; so does a caller that builds its env from
 * `process.env`. A raw `Bun.spawn`/`Bun.spawnSync` with no `env` uses the
 * environment Bun started with and still runs the shim (measured 2026-11-14,
 * Bun 1.4.2). A test that sets its own PATH (`/usr/bin:/bin`, `/nowhere`, a
 * fake git first) gets exactly what it sets.
 *
 * WHAT DIFFERS. The shim adds four variables to git's own environment before
 * it runs git: SDKROOT, CPATH, LIBRARY_PATH and MANPATH (measured 2026-11-14
 * with `git -c alias.e=!env e`). A hook or `!` alias that git runs no longer
 * sees them. Nothing under src/ or tests/ reads any of the four.
 *
 * WHEN IT CANNOT PIN (no xcrun, as on Linux; xcrun fails; the git on PATH is
 * not the shim; the versions differ), it changes nothing and prints ONE line
 * saying why. The suite then runs the git on PATH, exactly as before.
 */
import {spawnSync} from 'node:child_process';
import {mkdtempSync, realpathSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {delimiter, join} from 'node:path';

/** The xcrun shim on macOS: the git this module exists to skip. */
export const GIT_SHIM = '/usr/bin/git';

export type GitPin =
  | {
      /** The temporary directory first on PATH; it holds only `git`. */
      dir: string;
      kind: 'pinned';
      /** The binary the symlink points at (`xcrun --find git`). */
      target: string;
      /** What both gits print for `--version`. */
      version: string;
    }
  | {kind: 'unpinned'; reason: string};

export type GitPinInputs = {
  /** Makes the directory the symlink goes in. */
  makeDir: () => string;
  /** The PATH the git on PATH is looked up on. */
  path: string;
  /** The shim's path; a git on PATH that is anything else is left alone. */
  shim: string;
  /** The command that answers `--find git`. */
  xcrun: string;
};

function defaultInputs(): GitPinInputs {
  return {
    makeDir: () => mkdtempSync(join(tmpdir(), 'justin-sdk-test-git-')),
    path: process.env.PATH ?? '',
    shim: GIT_SHIM,
    xcrun: 'xcrun',
  };
}

function firstLine(text: string | null | undefined): string {
  return (text ?? '').trim().split('\n')[0] ?? '';
}

/** `<git> --version`, or why it could not be read. */
function versionOf(
  git: string,
): {ok: false; reason: string} | {ok: true; version: string} {
  const probe = spawnSync(git, ['--version'], {encoding: 'utf-8'});
  if (probe.error != null) {
    return {ok: false, reason: `${git} --version: ${probe.error.message}`};
  }
  const version = (probe.stdout ?? '').trim();
  if (probe.status !== 0 || version === '') {
    return {
      ok: false,
      reason: `${git} --version exited ${probe.status ?? 'unknown'}: ${firstLine(probe.stderr)}`,
    };
  }
  return {ok: true, version};
}

/**
 * Decide the pin without changing anything but the new directory: which git
 * is on PATH, what xcrun says the shim runs, and whether both report the same
 * version. Every reason not to pin is a value, never a throw.
 */
export function resolveGitPin(inputs: GitPinInputs = defaultInputs()): GitPin {
  const onPath = Bun.which('git', {PATH: inputs.path});
  if (onPath == null) return {kind: 'unpinned', reason: 'no git on PATH'};
  if (onPath !== inputs.shim) {
    return {
      kind: 'unpinned',
      reason: `the git on PATH is ${onPath}, not the xcrun shim ${inputs.shim}, so there is no shim to skip`,
    };
  }
  const find = spawnSync(inputs.xcrun, ['--find', 'git'], {encoding: 'utf-8'});
  if (find.error != null) {
    return {
      kind: 'unpinned',
      reason: `${inputs.xcrun} could not run: ${find.error.message}`,
    };
  }
  const target = (find.stdout ?? '').trim();
  if (find.status !== 0 || target === '') {
    return {
      kind: 'unpinned',
      reason: `${inputs.xcrun} --find git exited ${find.status ?? 'unknown'}: ${firstLine(find.stderr)}`,
    };
  }
  let real: string;
  try {
    real = realpathSync(target);
  } catch (error) {
    return {
      kind: 'unpinned',
      reason: `${inputs.xcrun} --find git named ${target}, which does not resolve: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (real === realpathSync(inputs.shim)) {
    return {
      kind: 'unpinned',
      reason: `${inputs.xcrun} --find git named the shim itself (${target})`,
    };
  }
  const shimVersion = versionOf(inputs.shim);
  if (!shimVersion.ok) return {kind: 'unpinned', reason: shimVersion.reason};
  const targetVersion = versionOf(target);
  if (!targetVersion.ok)
    return {kind: 'unpinned', reason: targetVersion.reason};
  if (shimVersion.version !== targetVersion.version) {
    return {
      kind: 'unpinned',
      reason: `${target} reports ${JSON.stringify(targetVersion.version)}, but ${inputs.shim} reports ${JSON.stringify(shimVersion.version)}`,
    };
  }
  const dir = inputs.makeDir();
  symlinkSync(target, join(dir, 'git'));
  return {dir, kind: 'pinned', target, version: targetVersion.version};
}

/** The one line printed when the pin is not applied. */
export function unpinnedLine(reason: string): string {
  return `git NOT pinned for this test run (${reason}); the tests run the git on PATH, as before`;
}

/**
 * Put a pinned git's directory first on `env.PATH`, or print one line saying
 * why there is none and leave `env` alone.
 */
export function applyGitPin(
  pin: GitPin,
  env: Record<string, string | undefined> = process.env,
  warn: (line: string) => void = (line) => console.warn(line),
): void {
  if (pin.kind === 'unpinned') {
    warn(unpinnedLine(pin.reason));
    return;
  }
  const current = env.PATH ?? '';
  if (current.split(delimiter)[0] === pin.dir) return;
  env.PATH = current === '' ? pin.dir : `${pin.dir}${delimiter}${current}`;
}

let installed: GitPin | null = null;

/** The preload's entry point: resolve once, apply, and remember the result. */
export function installGitPin(): GitPin {
  if (installed != null) return installed;
  const pin = resolveGitPin();
  applyGitPin(pin);
  installed = pin;
  return pin;
}

/** What `installGitPin()` decided for this run; null before it ran. */
export function installedGitPin(): GitPin | null {
  return installed;
}
