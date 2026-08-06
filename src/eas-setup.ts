/**
 * eas-setup.ts — scaffold the canonical EAS build / update / ship scripts into
 * a project's package.json, so they are uniform across projects instead of
 * copy-pasted and hand-maintained.
 *
 * The update/ship scripts delegate to the shared `bunx @justinhaaheim/justin-sdk eas-update`
 * CLI command (there is no per-project publish script to keep in sync).
 *
 * Load-bearing pairing: `build:eas:base` is the clean `eas build --platform ios`
 * (NO local `expo prebuild --clean`). That is only safe for a CNG project
 * (ios/ gitignored → EAS regenerates it in the cloud) whose EAS build runs
 * version-manager cloud-side via `eas-build-post-install`. So this component
 * also ensures `prebuild` + `eas-build-post-install` (both version-manager) —
 * the update scripts run `bun run prebuild`, and the build relies on the
 * post-install hook. If ios/ is committed (bare workflow), `build:eas:base`
 * would build stale native config — see the doctor follow-up.
 *
 * Idempotent, prettier-setup style: add-if-missing; if a script is present but
 * differs from canonical, warn and leave it unless `force` is set.
 *
 * Not part of `init` / the `all` preset (EAS is app-specific) — install it
 * explicitly with `bunx @justinhaaheim/justin-sdk add eas`. It self-registers `eas-setup` in
 * justin-sdk.config.json so `update` re-applies it.
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
 * The canonical EAS script set this component owns. Names here are SDK-owned:
 * project-specific build variants (e.g. build:development:jphone17) must live
 * under other names so `update --force` never clobbers them.
 */
const EAS_SCRIPTS: ReadonlyArray<{key: string; value: string}> = [
  {key: 'prebuild', value: 'npx @justinhaaheim/version-manager'},
  {key: 'eas-build-post-install', value: 'npx @justinhaaheim/version-manager'},
  {key: 'build:eas:base', value: 'eas build --platform ios'},
  {
    key: 'build:eas:development',
    value:
      'APP_VARIANT=development bun run build:eas:base -- --profile development',
  },
  {
    key: 'build:eas:preview',
    value: 'APP_VARIANT=preview bun run build:eas:base -- --profile preview',
  },
  {
    key: 'build:eas:production',
    value:
      'APP_VARIANT=production bun run build:eas:base -- --profile production',
  },
  {
    key: 'eas:update:development',
    value:
      'bun run prebuild && APP_VARIANT=development bunx @justinhaaheim/justin-sdk eas-update development',
  },
  {
    key: 'eas:update:preview',
    value:
      'bun run prebuild && APP_VARIANT=preview bunx @justinhaaheim/justin-sdk eas-update preview',
  },
  {
    key: 'ship:development',
    value:
      'APP_VARIANT=development eas build --platform ios --profile development --non-interactive --no-wait && bun run eas:update:development',
  },
  {
    key: 'ship:preview',
    value:
      'APP_VARIANT=preview eas build --platform ios --profile preview --non-interactive --no-wait && bun run eas:update:preview',
  },
];

/** Add the canonical EAS scripts to package.json (idempotent; --force normalizes drift). */
function stepEasScripts(projectRoot: string, force: boolean): boolean {
  const pkgPath = resolve(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) {
    fail('package.json not found — cannot add EAS scripts');
    return false;
  }

  const pkg = readJson(pkgPath);
  if (pkg == null) {
    fail('package.json is not valid JSON');
    return false;
  }

  const scripts = ((pkg.scripts as Record<string, string> | undefined) ??
    {}) as Record<string, string>;

  let changed = false;
  for (const {key, value} of EAS_SCRIPTS) {
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

export interface EasSetupOptions {
  projectRoot: string;
  quiet: boolean;
  force: boolean;
}

export async function runEasSetup(opts: EasSetupOptions): Promise<number> {
  const {projectRoot, quiet, force} = opts;
  setQuiet(quiet);
  stepHeader('eas-setup: canonical EAS build/update/ship scripts');

  // Foundation + self-registration. NOT forwarding `force`: --force normalizes
  // only the EAS scripts, never base-setup's files (e.g. scripts/setup-env.ts).
  const baseExit = await runBaseSetup({
    projectRoot,
    quiet: true,
    extraComponents: ['eas-setup'],
  });
  if (baseExit !== 0) {
    return baseExit;
  }

  return stepEasScripts(projectRoot, force) ? 0 : 1;
}
