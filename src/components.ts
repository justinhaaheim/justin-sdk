/**
 * components.ts — the single source of truth for justin-sdk's components:
 * their canonical dependency order, the short ↔ config-name mapping, and the
 * one place that dispatches a component name to its installer.
 *
 * Three commands consume this registry, each keyed on a different namespace:
 *   - `add`    (add.ts)    — short names the user types (beads, prettier, …)
 *   - `init`   (init.ts)   — short names, iterated in DEPENDENCY_ORDER
 *   - `update` (update.ts) — `-setup` config names read back from
 *                            justin-sdk.config.json (beads-setup, …)
 *
 * Before this module those three each had their own copy of the
 * name→installer dispatch and ordering, which could silently drift. Now the
 * dispatch and order live here; the commands just supply args and a name.
 */

import {runBaseSetup} from './base-setup';
import {runBeadsSetup} from './beads-setup';
import {runClaudeMdSetup} from './claude-md-setup';
import {runEasSetup} from './eas-setup';
import {runEslintSetup} from './eslint-setup';
import {runGhActionsSetup} from './gh-actions-setup';
import {runGitignoreSetup} from './gitignore-setup';
import {runHuskySetup} from './husky-setup';
import {runPrettierSetup} from './prettier-setup';
import {runPromptsSetup} from './prompts-setup';
import {runTimeCheckSetup} from './time-check-setup';
import {runTsconfigSetup} from './tsconfig-setup';

// ---------------------------------------------------------------------------
// Names and ordering
// ---------------------------------------------------------------------------

/**
 * Every component, in dependency order. base-setup is first (it's the
 * foundation every other installer self-applies), followed by the order
 * `init` and the `all` preset install in. This is THE canonical ordering —
 * presets and init derive theirs from it rather than re-listing.
 */
export const COMPONENT_NAMES = [
  'base-setup',
  'gitignore',
  'prettier',
  'tsconfig',
  'eslint',
  'husky',
  'gh-actions',
  'prompts',
  'claude-md',
  'beads',
  'eas',
  'time-check',
] as const;

export type ComponentName = (typeof COMPONENT_NAMES)[number];

/**
 * Components that are only ever installed on explicit request (`add <name>`),
 * never by `init` or the `all` preset:
 *   - base-setup: the implicit foundation every installer self-applies.
 *   - eas: app-specific (Expo/RN); scaffolding it into a node CLI would be wrong.
 *   - time-check: its hook fires on EVERY prompt, so installing it everywhere
 *     "but disabled" would cost a process spawn per prompt in every project to
 *     print nothing. Opt in where the wall-clock actually matters.
 * A future app-only component (e.g. `detox`) joins this set.
 */
const OPT_IN_ONLY: ReadonlySet<ComponentName> = new Set([
  'base-setup',
  'eas',
  'time-check',
]);

/**
 * The components to install when scaffolding "everything" (init and the
 * `all` preset): the canonical order minus the opt-in-only components.
 */
export const DEPENDENCY_ORDER: ComponentName[] = COMPONENT_NAMES.filter(
  (name) => !OPT_IN_ONLY.has(name),
);

/**
 * Map a short component name to the name it registers in
 * justin-sdk.config.json. Every component except base-setup uses a `-setup`
 * suffix (base-setup is already suffix-shaped).
 */
export function configNameFor(name: ComponentName): string {
  return name === 'base-setup' ? 'base-setup' : `${name}-setup`;
}

const NAME_BY_CONFIG = new Map<string, ComponentName>(
  COMPONENT_NAMES.map((name) => [configNameFor(name), name]),
);

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export interface ComponentRunArgs {
  projectRoot: string;
  quiet: boolean;
  force: boolean;
  /** beads only: skip the git commit at the end (defaults to true). */
  noCommit?: boolean;
  /** prompts only: skip fetching the prompts library (defaults to false). */
  skipFetch?: boolean;
}

/** The {projectRoot, quiet, force} shape every installer accepts. */
function base(args: ComponentRunArgs) {
  return {projectRoot: args.projectRoot, quiet: args.quiet, force: args.force};
}

/**
 * The one place a component name becomes an installer call. Each entry is a
 * thin adapter that forwards only the options its installer understands
 * (beads has no `force` and takes `noCommit`; prompts takes `skipFetch`).
 *
 * Typed as Record<ComponentName, …> so adding a name to COMPONENT_NAMES
 * without a runner here is a compile error.
 */
const RUNNERS: Record<
  ComponentName,
  (args: ComponentRunArgs) => Promise<number>
> = {
  'base-setup': (a) => runBaseSetup(base(a)),
  gitignore: (a) => runGitignoreSetup(base(a)),
  prettier: (a) => runPrettierSetup(base(a)),
  tsconfig: (a) => runTsconfigSetup(base(a)),
  eslint: (a) => runEslintSetup(base(a)),
  husky: (a) => runHuskySetup(base(a)),
  'gh-actions': (a) => runGhActionsSetup(base(a)),
  prompts: (a) =>
    runPromptsSetup({...base(a), skipFetch: a.skipFetch ?? false}),
  'claude-md': (a) => runClaudeMdSetup(base(a)),
  beads: (a) =>
    runBeadsSetup({
      projectRoot: a.projectRoot,
      quiet: a.quiet,
      noCommit: a.noCommit ?? true,
    }),
  eas: (a) => runEasSetup(base(a)),
  'time-check': (a) => runTimeCheckSetup(base(a)),
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
 * than crash on a hand-edited or renamed config entry.
 */
export function runComponentByConfigName(
  configName: string,
  args: ComponentRunArgs,
): Promise<number> | null {
  const name = NAME_BY_CONFIG.get(configName);
  if (name == null) return null;
  return RUNNERS[name](args);
}
