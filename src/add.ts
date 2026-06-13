/**
 * add.ts — `j add <target>` orchestrator.
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

import {runBaseSetup} from './base-setup';
import {runBeadsSetup} from './beads-setup';
import {runClaudeMdSetup} from './claude-md-setup';
import {runEslintSetup} from './eslint-setup';
import {runGhActionsSetup} from './gh-actions-setup';
import {runGitignoreSetup} from './gitignore-setup';
import {runHuskySetup} from './husky-setup';
import {runPrettierSetup} from './prettier-setup';
import {runPromptsSetup} from './prompts-setup';
import {fail, setQuiet, stepHeader, success} from './setup-helpers';
import {runTsconfigSetup} from './tsconfig-setup';

// ---------------------------------------------------------------------------
// Components and presets
// ---------------------------------------------------------------------------

/**
 * Every component the `add` command can install, by short name (the value
 * the user types). Order here is not significant — preset ordering is
 * defined separately in PRESETS.
 */
export const COMPONENTS = [
  'base-setup',
  'beads',
  'claude-md',
  'eslint',
  'gh-actions',
  'gitignore',
  'husky',
  'prettier',
  'prompts',
  'tsconfig',
] as const;

export type ComponentName = (typeof COMPONENTS)[number];

/**
 * Presets expand to an ordered list of components.
 *
 * The `all` order mirrors init.ts's dependency order exactly (base-setup is
 * implicit — every installer calls runBaseSetup itself, so it doesn't need
 * to appear in the list). `core` is the code-quality + beads baseline (the
 * always-want set, minus CI / prompts / claude-md). `minimal` is just
 * base-setup + beads.
 */
export const PRESETS: Record<string, ComponentName[]> = {
  minimal: ['base-setup', 'beads'],
  core: ['gitignore', 'prettier', 'tsconfig', 'eslint', 'husky', 'beads'],
  all: [
    'gitignore',
    'prettier',
    'tsconfig',
    'eslint',
    'husky',
    'gh-actions',
    'prompts',
    'claude-md',
    'beads',
  ],
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

interface OneComponentOptions {
  projectRoot: string;
  force: boolean;
  quiet: boolean;
  /** Only consulted by the beads installer (the only one with a commit step). */
  noCommit: boolean;
}

/**
 * Run a single component installer by short name. Returns its exit code and
 * does NOT call process.exit, so it can be looped over for presets. Beads is
 * the only installer with a commit step (noCommit) and takes no `force`; the
 * rest take {projectRoot, quiet, force}.
 */
export async function runOneComponent(
  name: ComponentName,
  opts: OneComponentOptions,
): Promise<number> {
  const base = {
    projectRoot: opts.projectRoot,
    quiet: opts.quiet,
    force: opts.force,
  };
  switch (name) {
    case 'base-setup':
      return runBaseSetup(base);
    case 'beads':
      return runBeadsSetup({
        noCommit: opts.noCommit,
        projectRoot: opts.projectRoot,
        quiet: opts.quiet,
      });
    case 'claude-md':
      return runClaudeMdSetup(base);
    case 'eslint':
      return runEslintSetup(base);
    case 'gh-actions':
      return runGhActionsSetup(base);
    case 'gitignore':
      return runGitignoreSetup(base);
    case 'husky':
      return runHuskySetup(base);
    case 'prettier':
      return runPrettierSetup(base);
    case 'prompts':
      return runPromptsSetup(base);
    case 'tsconfig':
      return runTsconfigSetup(base);
    default:
      fail(`Unknown component "${name as string}".`);
      return 1;
  }
}

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
      const exitCode = await runOneComponent(name, {
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
  return runOneComponent(target as ComponentName, {
    force: opts.force,
    noCommit: !opts.commit,
    projectRoot: opts.projectRoot,
    quiet: false,
  });
}
