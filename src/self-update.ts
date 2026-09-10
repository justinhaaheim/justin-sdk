/**
 * self-update.ts — Bump the SDK pinned in a project's devDependencies to
 * the latest tag published on `github:justinhaaheim/justin-sdk`.
 *
 * Used by `justin-sdk update` as Step 1 of the sync loop. After this returns
 * `shouldReExec: true`, the caller is expected to re-exec the freshly
 * installed CLI so the rest of the update runs against the new code.
 *
 * Failure modes (git missing, network blocked, sandbox) degrade gracefully:
 * a warning is logged NAMING WHAT FAILED and `{updated: false, shouldReExec:
 * false}` is returned, so `justin-sdk update` can still re-apply components
 * with the SDK the project already has.
 *
 * The tag lookup itself lives in sdk-latest.ts, shared with the health-notices
 * probe (home-base-uxwc D3) — one parse, one timeout, one set of failure
 * messages for both callers.
 */

import {existsSync, readFileSync} from 'fs';
import {resolve} from 'path';

import {
  compareSdkVersions,
  fetchLatestSdkTag,
  parseSdkVersion,
} from './sdk-latest';
import {exec, fail, success, warn} from './setup-helpers';

const SDK_PKG = '@justinhaaheim/justin-sdk';
const SDK_REPO = 'justinhaaheim/justin-sdk';

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
        'Run `bunx @justinhaaheim/justin-sdk add base-setup` to bootstrap, then re-run update.',
    );
    return {
      updated: false,
      previousVersion: null,
      newVersion: null,
      shouldReExec: false,
    };
  }

  const outcome = fetchLatestSdkTag();
  if (outcome.status === 'failed') {
    warn(
      `Could not query latest SDK tag (${outcome.error}). ` +
        `Continuing with installed ${previousVersion}.`,
    );
    return {
      updated: false,
      previousVersion,
      newVersion: previousVersion,
      shouldReExec: false,
    };
  }
  const latest = outcome.tag;

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
