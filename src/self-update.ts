/**
 * self-update.ts — Bump the SDK pinned in a project's devDependencies to
 * the latest tag published on `github:justinhaaheim/justin-sdk`.
 *
 * Used by `justin-sdk update` as Step 1 of the sync loop. After this returns
 * `shouldReExec: true`, the caller is expected to re-exec the freshly
 * installed CLI so the rest of the update runs against the new code.
 *
 * Failure modes (gh missing, network blocked, sandbox) degrade gracefully:
 * a warning is logged and `{updated: false, shouldReExec: false}` is
 * returned, so `justin-sdk update` can still re-apply components with the SDK
 * the project already has.
 */

import {existsSync, readFileSync} from 'fs';
import {resolve} from 'path';

import {exec, fail, success, warn} from './setup-helpers';

import {SDK_PKG, SDK_REPO} from './package-identity';

export interface SelfUpdateResult {
  updated: boolean;
  /** Version pinned in the project's node_modules before this call. */
  previousVersion: string | null;
  /** Version we ended up with (same as previous if `updated: false`). */
  newVersion: string | null;
  /**
   * True iff the SDK was actually bumped. The caller (`justin-sdk update`) should
   * re-exec the freshly installed CLI so subsequent steps run against
   * the new code, not the stale process that started the update.
   */
  shouldReExec: boolean;
}

/**
 * Read the version field from the SDK installed in the project's
 * node_modules. Returns null if the SDK isn't installed yet — in which
 * case the project hasn't run `justin-sdk add base-setup` and `justin-sdk update` should
 * bail with a clear message before getting this far.
 */
function readInstalledSdkVersion(projectRoot: string): string | null {
  const pkgPath = resolve(projectRoot, 'node_modules', SDK_PKG, 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
      version?: string;
    };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Parse a tag/version into [major, minor, patch], tolerating an optional
 * leading "v" (so both `0.6.1` and `v0.6.0` parse). Returns null if the
 * string doesn't start with an X.Y.Z triple.
 */
export function parseSdkVersion(tag: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(tag.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Compare two parsed versions: >0 if a is newer, <0 if older, 0 if equal. */
function compareSdkVersions(
  a: [number, number, number],
  b: [number, number, number],
): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * Pick the highest-semver tag from a list of raw tag names, returning the
 * RAW name (the git ref we install against, so a `v`-prefixed tag keeps its
 * `v`). Unparseable names are ignored; returns null if none parse.
 *
 * We sort ourselves rather than trusting `gh api .../tags` to return the
 * newest first: that ordering isn't guaranteed to be semver-descending, and
 * a stray `v`-prefixed tag can lexically outsort the unprefixed ones.
 *
 * TIES PREFER THE `v`-PREFIXED SPELLING (home-base-j2n7.4 / v170.15): the
 * repo has carried BOTH `0.14.0` and `v0.14.0` pointing at DIFFERENT commits,
 * so a tie broken by input order made which TREE a fleet bump landed on
 * depend on gh's API ordering — silently. v-prefixed is the sweep-guard
 * convention; deterministic beats lucky.
 */
export function pickLatestTag(tagNames: string[]): string | null {
  let best: {name: string; version: [number, number, number]} | null = null;
  for (const name of tagNames) {
    const version = parseSdkVersion(name);
    if (version == null) continue;
    if (best == null || compareSdkVersions(version, best.version) > 0) {
      best = {name, version};
    } else if (
      compareSdkVersions(version, best.version) === 0 &&
      name.startsWith('v') &&
      !best.name.startsWith('v')
    ) {
      best = {name, version};
    }
  }
  return best?.name ?? null;
}

/**
 * Ask GitHub for all tags on the SDK repo and return the highest-semver one
 * (raw name). Returns null if gh is missing, the API call fails, or no tag
 * parses as a version.
 */
function queryLatestSdkTag(projectRoot: string): string | null {
  const result = exec(
    `gh api repos/${SDK_REPO}/tags --paginate --jq '.[].name'`,
    projectRoot,
  );
  if (result.exitCode !== 0) return null;
  const names = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return pickLatestTag(names);
}

/**
 * Bump the SDK pin in the project's devDependencies to the latest tag
 * (if behind). See SelfUpdateResult for the return shape's meaning.
 */
export async function selfUpdateSdk(
  projectRoot: string,
): Promise<SelfUpdateResult> {
  const previousVersion = readInstalledSdkVersion(projectRoot);
  if (previousVersion == null) {
    fail(
      `${SDK_PKG} is not installed in this project. ` +
        'Run `bunx @jhaa/justin-sdk add base-setup` to bootstrap, then re-run update.',
    );
    return {
      updated: false,
      previousVersion: null,
      newVersion: null,
      shouldReExec: false,
    };
  }

  const latest = queryLatestSdkTag(projectRoot);
  if (latest == null) {
    warn(
      'Could not query latest SDK tag (network/sandbox/missing gh). ' +
        `Continuing with installed ${previousVersion}.`,
    );
    return {
      updated: false,
      previousVersion,
      newVersion: previousVersion,
      shouldReExec: false,
    };
  }

  // Compare normalized versions so a "v"-prefixed tag (e.g. v0.6.0) doesn't
  // read as different from an unprefixed installed version (0.6.0), and so we
  // never "bump" to an older tag. Fall back to raw string equality if either
  // side doesn't parse.
  const latestVersion = parseSdkVersion(latest);
  const installedVersion = parseSdkVersion(previousVersion);
  const alreadyCurrent =
    latestVersion != null && installedVersion != null
      ? compareSdkVersions(latestVersion, installedVersion) <= 0
      : latest === previousVersion;
  if (alreadyCurrent) {
    success(`SDK already at latest tag (${latest})`);
    return {
      updated: false,
      previousVersion,
      newVersion: previousVersion,
      shouldReExec: false,
    };
  }

  // Bump. `bun add -d` rewrites both package.json and the lockfile and
  // re-resolves into node_modules in one step.
  const installCmd = `bun add -d github:${SDK_REPO}#${latest}`;
  const installResult = exec(installCmd, projectRoot);
  if (installResult.exitCode !== 0) {
    fail(
      `Failed to bump ${SDK_PKG} to ${latest} (exit ${installResult.exitCode}). ` +
        'Continuing with installed version.',
    );
    if (installResult.stderr.length > 0) warn(installResult.stderr);
    return {
      updated: false,
      previousVersion,
      newVersion: previousVersion,
      shouldReExec: false,
    };
  }

  success(`Bumped ${SDK_PKG}: ${previousVersion} → ${latest}`);
  return {
    updated: true,
    previousVersion,
    newVersion: latest,
    shouldReExec: true,
  };
}
