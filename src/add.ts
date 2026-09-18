/**
 * add.ts — `justin-sdk add <target>` orchestrator.
 *
 * `target` is either a single component (base-setup, beads, prettier, …) or the
 * `core` preset, which expands to every component applicable to THIS repo
 * (epic home-base-dchjw D3).
 *
 * The old `all` and `minimal` presets are gone. `all` meant "core plus the
 * opt-in extras" and was computed from a list that excluded six components —
 * including critical-rules — so `add all` scaffolded the retired `prompts`
 * component and skipped the rules artifact. There is now one preset: core is
 * everything that applies, and a repo that wants less lists what it wants.
 *
 * Config registration is EXPLICIT here (constraint F11): the installers used to
 * push their own `-setup` name into `justin-sdk.config.json#components` as a
 * side effect of running, which meant `update` (which re-runs every listed
 * component) could never remove anything and a component could enrol itself
 * without anyone asking. `add` writes the names; nothing else does.
 */

import {addComponentsToConfig} from './base-setup';
import {
  type ComponentName,
  COMPONENT_NAMES,
  configNameFor,
  corePreset,
} from './component-registry';
import {runComponentByName} from './components';
import {fail, setQuiet, stepHeader, success} from './setup-helpers';

// ---------------------------------------------------------------------------
// Components and presets
// ---------------------------------------------------------------------------

/**
 * Every component the `add` command can install, by short name. Re-exported
 * from the component registry (the single source of truth) for the CLI's
 * `choices` list and for tests.
 */
export const COMPONENTS = COMPONENT_NAMES;
export type {ComponentName};

/**
 * The one preset. Its expansion depends on the repo (eas is included only in an
 * Expo app), so it is a FUNCTION of the project root, never a constant.
 */
export const PRESET_NAMES = ['core'];

/** All valid `add` targets: every component plus every preset. */
export const ADD_TARGETS: string[] = [...COMPONENTS, ...PRESET_NAMES];

export function isPreset(target: string): boolean {
  return PRESET_NAMES.includes(target);
}

/**
 * What `core` means IN THIS REPO, spelled out for `--help`.
 *
 * Computed with the predicates actually evaluated against the cwd, never a
 * typed list (D3): the old help text named a preset whose real expansion had
 * drifted six components away from what it claimed, and nobody could see that
 * from the help. Safe under `--help` because every predicate is a read.
 */
export function corePresetHelpText(projectRoot: string): string {
  const expansion = corePreset(projectRoot);
  if (expansion.length === 0) {
    return 'core expands to nothing in this repo (no component’s includeIf passes here).';
  }
  return `In THIS repo, core = ${expansion.join(', ')} (${expansion.length} components; base-setup is implicit and never listed).`;
}

/**
 * Expand a target to the ordered list of components to install. `core` expands
 * to the applicable components of THIS repo; a single component expands to
 * itself.
 */
export function expandTarget(
  target: string,
  projectRoot: string,
): ComponentName[] {
  if (isPreset(target)) return corePreset(projectRoot);
  return [target as ComponentName];
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export interface AddOptions {
  projectRoot: string;
  /** Force-overwrite hand-modified files (passed to each installer). */
  force: boolean;
  /**
   * Single-component `add beads`: commit at the end (noCommit = !commit).
   * Presets are always no-commit and ignore this flag.
   */
  commit: boolean;
  /**
   * The remote the SDK pin tag is verified against, forwarded to base-setup.
   * Tests point it at a local bare repo so an `add` is hermetic; production
   * omits it and base-setup uses the real SDK_REPO_URL (dchjw.17 F7).
   */
  sdkRepoUrl?: string;
}

/**
 * Expand a whole `add a b core` argument list to the ordered, deduped set of
 * components to install. Presets expand in place; the result is always in
 * COMPONENT_NAMES (dependency) order, not the order they were typed, because
 * the installers assume it.
 */
export function expandTargets(
  targets: readonly string[],
  projectRoot: string,
): ComponentName[] {
  const wanted = new Set<ComponentName>();
  for (const target of targets) {
    for (const name of expandTarget(target, projectRoot)) wanted.add(name);
  }
  return COMPONENT_NAMES.filter((name) => wanted.has(name));
}

/**
 * Run `add <component…>`. Returns an exit code (0 = success).
 *
 * VARIADIC (D3): `add gitignore prettier eslint` is one call, so the config is
 * written once and the components install in dependency order regardless of the
 * order they were typed. Aborts on the first non-zero exit.
 *
 * `--commit` is honoured only for a single component (it exists for `add beads`,
 * which can commit its scaffold); several components are always no-commit — you
 * inspect the diff and commit yourself.
 */
export async function runAdd(
  targets: readonly string[],
  opts: AddOptions,
): Promise<number> {
  if (targets.length === 0) {
    fail('add needs at least one component name, or the preset `core`.');
    return 1;
  }

  for (const target of targets) {
    if (!ADD_TARGETS.includes(target)) {
      fail(
        `Unknown component "${target}". Run \`justin-sdk list\` to see every component, or \`add core\` for everything that applies here.`,
      );
      return 1;
    }
  }

  const components = expandTargets(targets, opts.projectRoot);
  // A lone explicit component keeps the historical verbose, commit-capable
  // behaviour; anything that expands to more than one runs quiet per component
  // with a success line each.
  const single = components.length === 1 && !targets.some(isPreset);

  setQuiet(false);
  if (!single) {
    stepHeader(
      `Installing ${components.length} component(s): ${components.join(', ')}`,
    );
  }

  for (const name of components) {
    // Installers flip the shared QUIET flag while they run; re-assert ours
    // each iteration so the per-component success line always prints.
    setQuiet(false);
    const exitCode = await runComponentByName(name, {
      force: opts.force,
      noCommit: single ? !opts.commit : true,
      projectRoot: opts.projectRoot,
      quiet: !single,
      ...(opts.sdkRepoUrl == null ? {} : {sdkRepoUrl: opts.sdkRepoUrl}),
    });
    setQuiet(false);
    if (exitCode !== 0) {
      fail(`Component "${name}" failed (exit ${exitCode}); aborting.`);
      return exitCode;
    }
    if (!single) success(`add ${name} done`);
  }

  registerInstalled(opts.projectRoot, components);
  return 0;
}

/**
 * Record what was just installed in `justin-sdk.config.json#components`.
 *
 * THE SEAM Part B builds on: `remove` is the mirror of this call, and `install`
 * reconciles against exactly the list these two maintain. Nothing else in the
 * SDK writes `components`.
 */
function registerInstalled(
  projectRoot: string,
  components: readonly ComponentName[],
): void {
  const added = addComponentsToConfig(
    projectRoot,
    components.map(configNameFor),
  );
  if (added.length > 0) {
    success(`justin-sdk.config.json components += ${added.join(', ')}`);
  }
}
