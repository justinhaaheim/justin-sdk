/**
 * add.ts — `justin-sdk add <target>` orchestrator.
 *
 * `target` is either a single component (base-setup, beads, prettier, …) or
 * a preset (minimal, core, all) that expands to an ordered list of
 * components.
 *
 * Component installers self-register their `-setup` name in
 * justin-sdk.config.json (via runBaseSetup's extraComponents), so presets
 * deliberately do NOT write config names themselves — they just call the
 * installers in dependency order and let each one register itself. That
 * keeps config consistent with the `-setup` names `update` reads back.
 *
 * Mirrors the one-module-per-command pattern (doctor.ts, init.ts, …) so
 * cli.ts stays thin. Failure semantics match init/update: components run
 * sequentially and the run aborts on the first non-zero exit.
 */

import {
  type ComponentName,
  COMPONENT_NAMES,
  DEPENDENCY_ORDER,
  runComponentByName,
} from './components';
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
 * Presets expand to an ordered list of components.
 *
 * `all` is the registry's DEPENDENCY_ORDER (every component except the
 * implicit base-setup, in dependency order — the same set `init` scaffolds).
 * `core` is the code-quality + beads baseline (the always-want set, minus
 * CI / prompts / claude-md). `minimal` is just base-setup + beads.
 */
export const PRESETS: Record<string, ComponentName[]> = {
  minimal: ['base-setup', 'beads'],
  core: ['gitignore', 'prettier', 'tsconfig', 'eslint', 'husky', 'beads'],
  all: [...DEPENDENCY_ORDER],
};

export const PRESET_NAMES = Object.keys(PRESETS);

/** All valid `add` targets: every component plus every preset. */
export const ADD_TARGETS: string[] = [...COMPONENTS, ...PRESET_NAMES];

export function isPreset(target: string): boolean {
  return Object.prototype.hasOwnProperty.call(PRESETS, target);
}

/**
 * Expand a target to the ordered list of components to install. A preset
 * expands to its component list; a single component expands to itself.
 */
export function expandTarget(target: string): ComponentName[] {
  if (isPreset(target)) return PRESETS[target];
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
}

/**
 * Run `add <target>`. Returns an exit code (0 = success).
 *
 * For a preset, installs each component sequentially in dependency order,
 * aborting on the first non-zero exit. Presets are always no-commit (you
 * inspect the diff and commit yourself). A single component runs verbose and
 * honors --commit for beads.
 */
export async function runAdd(
  target: string,
  opts: AddOptions,
): Promise<number> {
  if (isPreset(target)) {
    const components = expandTarget(target);
    setQuiet(false);
    stepHeader(
      `Installing preset '${target}' (${components.length} components)`,
    );
    for (const name of components) {
      // Installers flip the shared QUIET flag while they run; re-assert ours
      // each iteration so the per-component success line always prints.
      setQuiet(false);
      const exitCode = await runComponentByName(name, {
        force: opts.force,
        noCommit: true,
        projectRoot: opts.projectRoot,
        quiet: true,
      });
      setQuiet(false);
      if (exitCode !== 0) {
        fail(`Component "${name}" failed (exit ${exitCode}); aborting.`);
        return exitCode;
      }
      success(`add ${name} done`);
    }
    return 0;
  }

  // Single component: run verbose (the historical behavior), honoring
  // --commit for beads.
  return runComponentByName(target as ComponentName, {
    force: opts.force,
    noCommit: !opts.commit,
    projectRoot: opts.projectRoot,
    quiet: false,
  });
}
