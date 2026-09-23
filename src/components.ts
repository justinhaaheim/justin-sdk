/**
 * components.ts — the one place a component name becomes an installer call.
 *
 * The other half of the registry — which components exist, their order, their
 * `-setup` config names, their `includeIf` gates and `resolveComponents` — is in
 * `component-registry.ts`, which imports no installers and so can be reached
 * from inside them.
 *
 * Two commands consume this dispatch, each keyed on a different namespace:
 *   - `add`    (add.ts)    — short names the user types (beads, prettier, …)
 *   - `update` (update.ts) — `-setup` config names read back from
 *                            justin-sdk.config.json (beads-setup, …)
 */

import {runBaseSetup} from './base-setup';
import {runBeadsSetup} from './beads-setup';
import {
  type ComponentName,
  componentNameForConfigName,
} from './component-registry';
import {runCriticalRulesSetup} from './critical-rules-setup';
import {runEasSetup} from './eas-setup';
import {runEslintSetup} from './eslint-setup';
import {runGhActionsSetup} from './gh-actions-setup';
import {runGitignoreSetup} from './gitignore-setup';
import {runHuskySetup} from './husky-setup';
import {runPrettierSetup} from './prettier-setup';
import {runThreadHooksSetup} from './thread-hooks-setup';
import {runTimeCheckSetup} from './time-check-setup';
import {runTsconfigSetup} from './tsconfig-setup';
import {runUsageCheckSetup} from './usage-check-setup';

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export interface ComponentRunArgs {
  force: boolean;
  /** beads only: skip the git commit at the end (defaults to true). */
  noCommit?: boolean;
  projectRoot: string;
  quiet: boolean;
  /**
   * The remote `stepDepsHasSdk` verifies the pin tag against, forwarded to the
   * `base-setup` every installer chains.
   *
   * Absent in production: base-setup falls back to the real SDK_REPO_URL. It is
   * threaded because a TEST that omits it makes a real `git ls-remote` to
   * github — per component, per test — so the suite was neither hermetic nor
   * offline-safe (dchjw.17 F7).
   */
  sdkRepoUrl?: string;
  /**
   * beads only: `--yes`. Authorises deleting the `.beads.legacy-<ts>/`
   * directory migration moved aside, and only after its issues were imported
   * and counted back (home-base-dchjw.20). Defaults to false everywhere —
   * `install`, `update` and every sweep leave it unset, so the moved directory
   * survives every automated path.
   */
  yes?: boolean;
}

/** The {projectRoot, quiet, force} shape every installer accepts. */
function base(args: ComponentRunArgs) {
  return {
    force: args.force,
    projectRoot: args.projectRoot,
    quiet: args.quiet,
    ...(args.sdkRepoUrl == null ? {} : {sdkRepoUrl: args.sdkRepoUrl}),
  };
}

/**
 * Each entry is a thin adapter that forwards only the options its installer
 * understands (beads has no `force` and takes `noCommit`).
 *
 * Typed as Record<ComponentName, …> so adding a name to COMPONENT_NAMES
 * without a runner here is a compile error.
 */
const RUNNERS: Record<
  ComponentName,
  (args: ComponentRunArgs) => Promise<number>
> = {
  'base-setup': (a) => runBaseSetup(base(a)),
  beads: (a) =>
    runBeadsSetup({
      noCommit: a.noCommit ?? true,
      projectRoot: a.projectRoot,
      quiet: a.quiet,
      yes: a.yes ?? false,
      ...(a.sdkRepoUrl == null ? {} : {sdkRepoUrl: a.sdkRepoUrl}),
    }),
  'critical-rules': (a) => runCriticalRulesSetup(base(a)),
  eas: (a) => runEasSetup(base(a)),
  eslint: (a) => runEslintSetup(base(a)),
  'gh-actions': (a) => runGhActionsSetup(base(a)),
  gitignore: (a) => runGitignoreSetup(base(a)),
  husky: (a) => runHuskySetup(base(a)),
  prettier: (a) => runPrettierSetup(base(a)),
  'thread-hooks': (a) => runThreadHooksSetup(base(a)),
  'time-check': (a) => runTimeCheckSetup(base(a)),
  tsconfig: (a) => runTsconfigSetup(base(a)),
  'usage-check': (a) => runUsageCheckSetup(base(a)),
};

/** Run a component by its short name. */
export function runComponentByName(
  name: ComponentName,
  args: ComponentRunArgs,
): Promise<number> {
  return RUNNERS[name](args);
}

/**
 * Run a component by its justin-sdk.config.json name (`-setup` suffixed).
 * Returns null for an unknown name so callers can skip-with-warning rather
 * than crash on a hand-edited, renamed, or retired config entry.
 */
export function runComponentByConfigName(
  configName: string,
  args: ComponentRunArgs,
): Promise<number> | null {
  const name = componentNameForConfigName(configName);
  if (name == null) return null;
  return RUNNERS[name](args);
}
