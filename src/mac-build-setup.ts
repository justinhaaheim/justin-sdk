/**
 * mac-build-setup.ts — scaffold the canonical Mac ("Designed for iPad") build
 * scripts into a project's package.json (home-base-0jeya.1). Every script
 * delegates to the shared `justin-sdk mac-build` command, so there is no
 * per-project build script to keep in sync.
 *
 * WHAT IT DOES NOT WRITE: the `componentConfig["mac-build"]` block. Which variant
 * goes on the Mac, and its scheme and bundle id, are decisions about the app that
 * no installer can make; `justin-sdk mac-build` names exactly what is missing
 * when the block is absent (mac-build-config.ts).
 *
 * Gated by `hasMacBuildConfig`, so it is never part of `core` for a repo that
 * has not configured a Mac build — `justin-sdk add mac-build` installs it
 * explicitly anywhere.
 *
 * Idempotent, eas-setup style: add-if-missing; if a script is present but
 * differs from canonical, warn and leave it unless `force` is set.
 */
import {existsSync} from 'fs';
import {resolve} from 'path';

import {runBaseSetup} from './base-setup';
import {
  fail,
  readJson,
  setQuiet,
  stepHeader,
  success,
  warn,
  writeJson,
} from './setup-helpers';

/**
 * The canonical script set this component owns. `build:mac:fast` and `mac` are
 * the same command on purpose: audio-journal-1 and nature-sounds both carry both
 * names, and muscle memory is the point of a uniform surface.
 */
export const MAC_BUILD_SCRIPTS: readonly {key: string; value: string}[] = [
  {key: 'build:mac', value: 'justin-sdk mac-build'},
  {key: 'build:mac:fast', value: 'justin-sdk mac-build --skip-prebuild'},
  {key: 'build:mac:no-launch', value: 'justin-sdk mac-build --no-launch'},
  {key: 'mac', value: 'justin-sdk mac-build --skip-prebuild'},
  {key: 'mac:install', value: 'justin-sdk mac-build --install-only'},
];

/** Add the canonical Mac build scripts to package.json (idempotent; --force normalizes drift). */
function stepMacBuildScripts(projectRoot: string, force: boolean): boolean {
  const pkgPath = resolve(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) {
    fail('package.json not found — cannot add the Mac build scripts');
    return false;
  }

  const pkg = readJson(pkgPath);
  if (pkg == null) {
    fail('package.json is not valid JSON');
    return false;
  }

  const scripts = (pkg.scripts as Record<string, string> | undefined) ?? {};

  let changed = false;
  for (const {key, value} of MAC_BUILD_SCRIPTS) {
    const existing = scripts[key];
    if (existing == null) {
      scripts[key] = value;
      changed = true;
      success(`Added ${key}`);
    } else if (existing === value) {
      success(`${key} already canonical`);
    } else if (force) {
      scripts[key] = value;
      changed = true;
      success(`Overwrote ${key} (--force)`);
    } else {
      warn(
        `${key} differs from canonical — leaving as-is (re-run with --force to normalize).\n      have: ${existing}\n      want: ${value}`,
      );
    }
  }

  if (changed) {
    pkg.scripts = scripts;
    writeJson(pkgPath, pkg);
  }
  return true;
}

export interface MacBuildSetupOptions {
  force: boolean;
  projectRoot: string;
  quiet: boolean;
  /**
   * The remote the SDK pin tag is verified against, forwarded to base-setup.
   * Tests point it at a local bare repo so the install is hermetic; production
   * omits it and base-setup uses the real SDK_REPO_URL (dchjw.17 F7).
   */
  sdkRepoUrl?: string;
}

export async function runMacBuildSetup(
  opts: MacBuildSetupOptions,
): Promise<number> {
  const {projectRoot, quiet, force} = opts;
  setQuiet(quiet);
  stepHeader('mac-build-setup: Mac (Designed for iPad) build scripts');

  // Foundation + self-registration. NOT forwarding `force`: --force normalizes
  // only the Mac build scripts, never base-setup's files.
  const baseExit = await runBaseSetup({
    projectRoot,
    quiet: true,
    ...(opts.sdkRepoUrl == null ? {} : {sdkRepoUrl: opts.sdkRepoUrl}),
  });
  if (baseExit !== 0) {
    return baseExit;
  }

  return stepMacBuildScripts(projectRoot, force) ? 0 : 1;
}
