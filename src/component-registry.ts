/**
 * component-registry.ts — WHICH components exist, what each one is called in
 * `justin-sdk.config.json`, when one applies to a repo, and the ONE place an
 * absent `components` key is expanded (epic home-base-dchjw D3, constraint F1).
 *
 * Deliberately a LEAF: node builtins plus `prime.ts` (the predicate registry)
 * and nothing else. The dispatch half — name → installer — lives in
 * `components.ts`, which imports every installer, and one of those installers
 * (critical-rules-setup) reaches `rules/rules-enrollment.ts`, which needs
 * `resolveComponents`. Putting the resolver next to the dispatch would close
 * that loop into an import cycle.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE: nothing reads `config.components`
 * directly. Before this, doctor read it as `config.components ?? []` and a repo
 * whose config had no `components` key ran ZERO checks and reported clean —
 * silence that meant "I did not look", printed as "nothing is wrong" (critical
 * rule 6). Absent now means the `core` preset, computed here.
 */

import {evaluateInclude, loadProjectContext} from './prime';

// ---------------------------------------------------------------------------
// Names and ordering
// ---------------------------------------------------------------------------

/**
 * Every component, in dependency order. base-setup is first (it is the
 * foundation every other installer self-applies), followed by the order presets
 * install in. This is THE canonical ordering — presets derive theirs from it
 * rather than re-listing.
 */
export const COMPONENT_NAMES = [
  'base-setup',
  'gitignore',
  'prettier',
  'tsconfig',
  'eslint',
  'husky',
  'gh-actions',
  'beads',
  'eas',
  'time-check',
  'usage-check',
  'thread-hooks',
  'critical-rules',
] as const;

export type ComponentName = (typeof COMPONENT_NAMES)[number];

/**
 * The component every other installer self-applies, so no preset ever lists it:
 * it is installed as a side effect of installing anything at all.
 */
export const IMPLICIT_COMPONENT: ComponentName = 'base-setup';

/**
 * Predicate names (from `prime.ts`'s registry — the SAME one the rules modules
 * use) that must ALL pass for a component to apply to a repo. A component absent
 * from this map applies everywhere.
 *
 * This replaces the hand-written exclusion list that kept SIX components out of
 * every preset — including `critical-rules`, which is the whole point of the
 * SDK, and `time-check` / `usage-check` / `thread-hooks`, which Justin wants in
 * the default install (2026-09-18). A component is now either applicable to this
 * repo or it is not; there is no third category of "applicable but withheld".
 */
export const COMPONENT_INCLUDE_IF: Partial<Record<ComponentName, string[]>> = {
  /**
   * `~/Dev/life` is a Dolt (`bd`) workspace on purpose, and beads-setup installs
   * beads_rust (`br`) — whose migration step deletes `.beads/` to re-init. The
   * first full-fleet `sweep --component install --dry-run` said
   * `life: adopt: beads-setup` (dchjw.19), so this gate is the SECOND of three
   * that now have to fail before that can happen: adoption requires SDK
   * provenance, `core` skips a component whose includeIf does not pass, and
   * `runBeadsSetup` refuses a Dolt workspace outright however it is reached.
   *
   * `isBeadsRust` is false for a repo with NO `.beads/` at all, so `core` no
   * longer scaffolds beads into a repo that has never had it — that is a
   * deliberate narrowing: `justin-sdk add beads` still works there, because
   * `install` applies an explicitly listed component whether or not its
   * includeIf passes.
   */
  beads: ['isBeadsRust'],
  eas: ['isExpo'],
};

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

/** The short name behind a `-setup` config name, or null if unknown. */
export function componentNameForConfigName(
  configName: string,
): ComponentName | null {
  return NAME_BY_CONFIG.get(configName) ?? null;
}

// ---------------------------------------------------------------------------
// Applicability
// ---------------------------------------------------------------------------

export interface ComponentApplicability {
  /** True when every predicate in `includeIf` passed (or there are none). */
  applicable: boolean;
  /** The predicate names gating it, in registry order. Empty = ungated. */
  includeIf: string[];
  name: ComponentName;
  /**
   * Predicate names this SDK does not know. Non-empty forces `applicable`
   * false: an unevaluatable gate is a failed measurement, and the reassuring
   * reading ("include it anyway") is the dangerous one.
   */
  unknownPredicates: string[];
}

/**
 * Every component with its applicability to one repo, in dependency order.
 * `list` (Part B) prints this; `corePreset` filters it.
 */
export function componentApplicability(
  projectRoot: string,
): ComponentApplicability[] {
  const ctx = loadProjectContext(projectRoot);
  return COMPONENT_NAMES.map((name) => {
    const includeIf = COMPONENT_INCLUDE_IF[name] ?? [];
    if (includeIf.length === 0) {
      return {applicable: true, includeIf, name, unknownPredicates: []};
    }
    const {included, unknown} = evaluateInclude(includeIf, ctx);
    return {
      applicable: included,
      includeIf,
      name,
      unknownPredicates: unknown,
    };
  });
}

/**
 * The `core` preset for one repo: every applicable component except the
 * implicit base-setup. COMPUTED, never a hand-written list — that is what kept
 * the old `all` preset scaffolding the retired `prompts` component while
 * omitting `critical-rules`.
 */
export function corePreset(projectRoot: string): ComponentName[] {
  return componentApplicability(projectRoot)
    .filter((entry) => entry.applicable && entry.name !== IMPLICIT_COMPONENT)
    .map((entry) => entry.name);
}

/** The `core` preset as the `-setup` names a config would list. */
export function coreConfigNames(projectRoot: string): string[] {
  return corePreset(projectRoot).map(configNameFor);
}

// ---------------------------------------------------------------------------
// resolveComponents — the ONLY reader of `config.components`
// ---------------------------------------------------------------------------

/**
 * FOUR outcomes, not two (critical rule 6): "the config lists these", "the
 * config lists nothing so core applies", "the config is not an object" and "the
 * `components` key is there but is not a list of strings" are different facts,
 * and two of them are failures. A failure must never arrive at a caller looking
 * like an empty list — doctor would print "no checks registered" and exit 0.
 */
export type ResolvedComponents =
  | {components: string[]; ok: true; source: 'config' | 'core'}
  | {ok: false; reason: string};

/**
 * base-setup, first, then the rest — deduped.
 *
 * The resolved list answers "what does this repo HAVE", and the answer always
 * includes base-setup: every installer applies it, so an enrolled repo has it by
 * construction, and the config file that asks the question was written by it.
 * Leaving it out would switch off doctor's base checks (BUN, ENV_HYDRATION, the
 * SDK pin) for every repo that stopped listing it — the most valuable checks
 * there are, silently skipped.
 *
 * It is still kept OUT of what `add` WRITES: it is not a component anyone can
 * choose or remove, so listing it in every config in the fleet is noise.
 */
function withImplicit(configNames: readonly string[]): string[] {
  const implicit = configNameFor(IMPLICIT_COMPONENT);
  return [implicit, ...configNames.filter((name) => name !== implicit)];
}

/**
 * Expand a parsed `justin-sdk.config.json` to the `-setup` component names it
 * means. THE single reader of `config.components` in the SDK.
 *
 * An ABSENT (or null) `components` key means the `core` preset — Justin,
 * 2026-09-18: "in the absence of the explicit array it should have a default
 * that includes all the components that are not specific to a particular
 * project type". An EMPTY array is a different statement — "this repo has
 * deliberately opted out of every component" — and is honoured as written.
 *
 * Unknown names are NOT resolved away here: they are returned as given, so the
 * caller decides whether to warn (doctor, update) or to filter (install). A
 * config naming a component this SDK deleted — ynab-mcp-deluxe still lists the
 * two retired ones — must not vanish silently.
 */
export function resolveComponents(
  config: unknown,
  projectRoot: string,
): ResolvedComponents {
  if (config == null || typeof config !== 'object' || Array.isArray(config)) {
    return {
      ok: false,
      reason: 'justin-sdk.config.json did not parse to an object',
    };
  }
  const raw = (config as {components?: unknown}).components;
  if (raw == null) {
    return {
      components: withImplicit(coreConfigNames(projectRoot)),
      ok: true,
      source: 'core',
    };
  }
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      reason: 'justin-sdk.config.json "components" is not an array',
    };
  }
  if (!raw.every((entry): entry is string => typeof entry === 'string')) {
    return {
      ok: false,
      reason: 'justin-sdk.config.json "components" contains a non-string entry',
    };
  }
  return {components: withImplicit(raw), ok: true, source: 'config'};
}

/**
 * The names in `resolveComponents` that no longer name a component — a config
 * written by an older SDK, or by hand. Reported, never silently dropped.
 */
export function unknownComponentNames(
  configNames: readonly string[],
): string[] {
  return configNames.filter((name) => componentNameForConfigName(name) == null);
}
