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
 * with the SDK the project already has. The one exception is a bump that ran
 * and did not install what it pinned (D2): that returns `failure`, and update
 * stops.
 *
 * The tag lookup itself lives in sdk-latest.ts, shared with the health-notices
 * probe (home-base-uxwc D3) — one parse, one timeout, one set of failure
 * messages for both callers.
 */

import {spawnSync} from 'child_process';
import {existsSync, readFileSync} from 'fs';
import {resolve} from 'path';

import {
  compareSdkVersions,
  fetchLatestSdkTag,
  type LatestTagOutcome,
  parseSdkVersion,
} from './sdk-latest';
import {type ExecResult, fail, success, warn} from './setup-helpers';

const SDK_PKG = '@justinhaaheim/justin-sdk';
const SDK_REPO = 'justinhaaheim/justin-sdk';

export interface SelfUpdateResult {
  /**
   * Non-null when the bump ran and left the project in a state update must not
   * go on from: node_modules does not hold the tag it pinned (D2). The message
   * has already been printed. `justin-sdk update` exits 1 on it.
   */
  failure: string | null;
  /** Version we ended up with (same as previous if `updated: false`). */
  newVersion: string | null;
  /** Version pinned in the project's node_modules before this call. */
  previousVersion: string | null;
  /**
   * True iff the SDK was actually bumped. The caller (`justin-sdk update`) should
   * re-exec the freshly installed CLI so subsequent steps run against
   * the new code, not the stale process that started the update.
   */
  shouldReExec: boolean;
  updated: boolean;
}

/**
 * Test seams. Absent in production: the real `git ls-remote` and the real
 * `bun add` run. The suite injects both so it never reaches GitHub.
 */
export interface SelfUpdateDeps {
  fetchLatestTag?: () => LatestTagOutcome;
  runBump?: (argv: readonly string[], cwd: string) => ExecResult;
}

/**
 * The bump command, with the package NAME spelled out (home-base-ipx4a F2/F3).
 *
 * The old form, `bun add -d github:justinhaaheim/justin-sdk#<tag>`, has no
 * name. Measured on bun 1.4.2 in a fixture pinned at v0.54.0 and bumped to
 * v0.56.0: it wrote the new devDependencies line into bun.lock a SECOND time
 * (every later install warns `Duplicate key "@justinhaaheim/justin-sdk"`), left
 * the packages entry on the old commit, installed v0.54.0, and exited 0. This
 * form, in a fresh copy of the same fixture, replaced both lines in place,
 * installed v0.56.0, and a following `bun install` printed no warning. Writing
 * the pin and then running `bun install` gave a byte-identical bun.lock; this
 * is the one-command version of that.
 */
export function sdkBumpArgv(tag: string): string[] {
  return ['bun', 'add', '-d', `${SDK_PKG}@github:${SDK_REPO}#${tag}`];
}

function spawnBump(argv: readonly string[], cwd: string): ExecResult {
  const [command, ...args] = argv;
  if (command == null) {
    return {exitCode: 1, stderr: 'empty bump command', stdout: ''};
  }
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf-8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error != null) {
    return {exitCode: 1, stderr: result.error.message, stdout: ''};
  }
  return {
    exitCode: result.status ?? 1,
    stderr: result.stderr.trim(),
    stdout: result.stdout.trim(),
  };
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
export function selfUpdateSdk(
  projectRoot: string,
  deps: SelfUpdateDeps = {},
): Promise<SelfUpdateResult> {
  const previousVersion = readInstalledSdkVersion(projectRoot);
  if (previousVersion == null) {
    fail(
      `${SDK_PKG} is not installed in this project. ` +
        'Run `bun run justin-sdk add base-setup` to bootstrap, then re-run update.',
    );
    return Promise.resolve({
      failure: null,
      newVersion: null,
      previousVersion: null,
      shouldReExec: false,
      updated: false,
    });
  }

  const outcome = (deps.fetchLatestTag ?? fetchLatestSdkTag)();
  if (outcome.status === 'failed') {
    warn(
      `Could not query latest SDK tag (${outcome.error}). ` +
        `Continuing with installed ${previousVersion}.`,
    );
    return Promise.resolve({
      failure: null,
      newVersion: previousVersion,
      previousVersion,
      shouldReExec: false,
      updated: false,
    });
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
    return Promise.resolve({
      failure: null,
      newVersion: previousVersion,
      previousVersion,
      shouldReExec: false,
      updated: false,
    });
  }

  // Bump. `bun add -d` rewrites both package.json and the lockfile and
  // re-resolves into node_modules in one step.
  const bumpArgv = sdkBumpArgv(latest);
  const installResult = (deps.runBump ?? spawnBump)(bumpArgv, projectRoot);
  if (installResult.exitCode !== 0) {
    fail(
      `Failed to bump ${SDK_PKG} to ${latest} (exit ${installResult.exitCode}). ` +
        'Continuing with installed version.',
    );
    if (installResult.stderr.length > 0) warn(installResult.stderr);
    return Promise.resolve({
      failure: null,
      newVersion: previousVersion,
      previousVersion,
      shouldReExec: false,
      updated: false,
    });
  }

  // D2: bun's exit code is not the installed version (F3: nature-sounds and
  // shortcut-helpers both printed "Bumped … → vX" with the old SDK still in
  // node_modules). Read what is actually there, and say nothing about a bump
  // until it matches.
  const installedAfter = readInstalledSdkVersion(projectRoot);
  const installedAfterVersion =
    installedAfter == null ? null : parseSdkVersion(installedAfter);
  const matches =
    installedAfterVersion != null &&
    latestVersion != null &&
    compareSdkVersions(installedAfterVersion, latestVersion) === 0;
  if (!matches) {
    const found =
      installedAfter == null
        ? 'no readable version'
        : `version ${installedAfter}`;
    const failure =
      `\`${bumpArgv.join(' ')}\` exited 0, but node_modules/${SDK_PKG} holds ${found}, not ${latest} (it held ${previousVersion} before). ` +
      `package.json and bun.lock may already name ${latest}. Nothing was reconciled. ` +
      `Fix: run \`bun update ${SDK_PKG}\`, check that node_modules/${SDK_PKG}/package.json says ${latest}, then re-run update.`;
    fail(failure);
    return Promise.resolve({
      failure,
      newVersion: installedAfter,
      previousVersion,
      shouldReExec: false,
      updated: false,
    });
  }

  success(`Bumped ${SDK_PKG}: ${previousVersion} → ${latest}`);
  return Promise.resolve({
    failure: null,
    newVersion: latest,
    previousVersion,
    shouldReExec: true,
    updated: true,
  });
}
