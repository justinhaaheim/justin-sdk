/**
 * The br the real-br tests run: home-base's PINNED br, never whatever mise
 * happens to resolve from $TMPDIR (home-base-vzwbj.4.9 F11, bead
 * home-base-vzwbj.4.11).
 *
 * WHY. br is reached through the mise shim, which picks the version from the
 * CWD's mise config. Every real-br test builds its workspace under $TMPDIR,
 * where no mise.toml applies, so the shim falls back to mise's GLOBAL br
 * (0.5.12 on Justin's machine, measured 2026-10-11) instead of the 0.1.37 that
 * home-base pins — and the two differ on exactly the claim refusal of F1.
 *
 * HOW. On import, this module reads the pinned version from the repo root's
 * mise.toml, asks `mise which br` FROM THE REPO ROOT for that binary, checks
 * that it reports that version, and puts its directory FIRST on
 * `process.env.PATH`. The br adapter spawns every call with the live
 * `process.env` merged under the caller's env (`brSpawnEnv`, P2), and the tests'
 * worlds carry no PATH of their own, so every br the code under test spawns is
 * the pinned one. The directory holds only the `br` binary, so nothing else on
 * PATH changes.
 *
 * WHEN THE PIN CANNOT BE RESOLVED (no mise, not installed, wrong version), the
 * tests fall back to the br on PATH and `needBr()` prints a loud SKIPPED line
 * naming why, on every test — never a silent run against some other br.
 */
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {delimiter, dirname, join, resolve} from 'node:path';

import {brAvailable, brSpawnEnv} from '../src/beads/br';

/** home-base's root: tests/ → justin-sdk/ → pkg/ → root. */
export const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..');

export type PinnedBr =
  | {dir: string; kind: 'pinned'; path: string; version: string}
  | {kind: 'unresolved'; reason: string};

/** The version home-base's mise.toml pins for beads_rust, or why there is none. */
export function pinnedBrVersion(
  root: string = REPO_ROOT,
): {ok: false; reason: string} | {ok: true; version: string} {
  let text: string;
  try {
    text = readFileSync(join(root, 'mise.toml'), 'utf8');
  } catch (error) {
    return {
      ok: false,
      reason: `could not read ${join(root, 'mise.toml')}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const match = /beads_rust"\s*=\s*\{[^}]*\bversion\s*=\s*"([^"]+)"/.exec(text);
  const version = match?.[1];
  if (version == null) {
    return {
      ok: false,
      reason: `${join(root, 'mise.toml')} pins no beads_rust version`,
    };
  }
  return {ok: true, version};
}

function resolvePinnedBr(): PinnedBr {
  const expected = pinnedBrVersion();
  if (!expected.ok) return {kind: 'unresolved', reason: expected.reason};
  const which = spawnSync('mise', ['which', 'br'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env: brSpawnEnv(undefined),
  });
  if (which.error != null) {
    return {
      kind: 'unresolved',
      reason: `mise could not run: ${which.error.message}`,
    };
  }
  const path = (which.stdout ?? '').trim();
  if (which.status !== 0 || path === '') {
    return {
      kind: 'unresolved',
      reason: `mise which br (from ${REPO_ROOT}) exited ${which.status ?? 'unknown'}: ${(which.stderr ?? '').trim().split('\n')[0] ?? ''}`,
    };
  }
  const probe = spawnSync(path, ['--version'], {encoding: 'utf-8'});
  const said = (probe.stdout ?? '').trim();
  if (said !== `br ${expected.version}`) {
    return {
      kind: 'unresolved',
      reason: `${path} reports ${JSON.stringify(said)}, not the pinned br ${expected.version}`,
    };
  }
  return {dir: dirname(path), kind: 'pinned', path, version: expected.version};
}

export const PINNED_BR: PinnedBr = resolvePinnedBr();

/** The mise tool id home-base's mise.toml pins br under. */
const BR_MISE_TOOL = 'github:Dicklesworthstone/beads_rust';

export type InstalledBr =
  | {dir: string; kind: 'installed'; path: string; version: string}
  | {kind: 'unresolved'; reason: string};

/**
 * A br of one exact version, installed by mise, for the tests that must run
 * THAT version whatever home-base pins (home-base-dj5m9.1.1: br 0.7.6 shares
 * one DB across a repo's worktrees, 0.1.37 does not; home-base-dj5m9.1.4: the
 * suite passes with either pinned, so a test about 0.1.37 asks for 0.1.37
 * rather than assuming the pin is it). The pin itself stays the suite's
 * default; a test puts this directory first on PATH for its own run
 * (`underInstalledBr`).
 *
 * Asked with MISE_OFFLINE, so a version that is not installed is a measured
 * "unresolved", never a download. The binary must report the version asked
 * for, or it is unresolved too.
 */
export function installedBr(version: string): InstalledBr {
  const where = spawnSync('mise', ['where', `${BR_MISE_TOOL}@${version}`], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env: brSpawnEnv({MISE_OFFLINE: '1'}),
  });
  if (where.error != null) {
    return {
      kind: 'unresolved',
      reason: `mise could not run: ${where.error.message}`,
    };
  }
  const dir = (where.stdout ?? '').trim();
  if (where.status !== 0 || dir === '') {
    return {
      kind: 'unresolved',
      reason: `mise where ${BR_MISE_TOOL}@${version} exited ${where.status ?? 'unknown'}: ${(where.stderr ?? '').trim().split('\n')[0] ?? ''}`,
    };
  }
  const path = join(dir, 'br');
  const probe = spawnSync(path, ['--version'], {encoding: 'utf-8'});
  const said = (probe.stdout ?? '').trim();
  if (said !== `br ${version}`) {
    return {
      kind: 'unresolved',
      reason: `${path} reports ${JSON.stringify(said)}, not br ${version}`,
    };
  }
  return {dir, kind: 'installed', path, version};
}

/**
 * Run `fn` with `br`'s directory first on PATH, then put PATH back, also when
 * `fn` is async (home-base-dj5m9.1.4). The br adapter spawns with the live
 * `process.env` (`brSpawnEnv`), so every br the code under test runs is this
 * one. Throws when `br` is not installed: the caller skips the test then
 * (`test.skipIf`), and says so.
 */
export async function underInstalledBr<T>(
  br: InstalledBr,
  fn: () => Promise<T> | T,
): Promise<T> {
  if (br.kind !== 'installed') throw new Error(br.reason);
  const saved = process.env.PATH;
  process.env.PATH = `${br.dir}${delimiter}${saved ?? ''}`;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.PATH;
    else process.env.PATH = saved;
  }
}

if (PINNED_BR.kind === 'pinned') {
  const current = process.env.PATH ?? '';
  if (current.split(delimiter)[0] !== PINNED_BR.dir) {
    process.env.PATH =
      current === '' ? PINNED_BR.dir : `${PINNED_BR.dir}${delimiter}${current}`;
  }
}

const BR_INSTALLED = brAvailable();

/**
 * Call at the top of every test that needs the real br. THROWS — never skips —
 * when no br runs at all (acceptance criterion 7 of home-base-vzwbj.4.1), and
 * prints a loud SKIPPED line when the pinned br could not be put first.
 */
export function needBr(): void {
  if (!BR_INSTALLED) {
    throw new Error(
      'br is not installed (not on PATH): this test needs the real br binary and refuses to pass without it',
    );
  }
  if (PINNED_BR.kind === 'unresolved') {
    console.warn(
      `SKIPPED: pinned br not found (${PINNED_BR.reason}); this test runs the br on PATH instead, which may not be the version home-base pins`,
    );
  }
}
