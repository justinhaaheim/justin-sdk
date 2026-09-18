/**
 * sweep-install.ts — the ENROLLMENT REFRESH payload a fleet sweep applies to
 * each repo (`justin-sdk sweep --component install`, epic home-base-dchjw,
 * SWEEP SEMANTICS decided 2026-09-18 on dchjw.10).
 *
 * WHY THIS IS NOT JUST `install`. Running the reconciler over the fleet as-is
 * would DELETE things: `list` against home-base showed 7 components listed and
 * 12 actually installed, and every one of those 12 was installed deliberately
 * at some point. A config that lists fewer components than the repo has is a
 * record of the SDK's own history — components used to enrol themselves as a
 * side effect of running, and older SDKs never wrote some of them down at all —
 * not a decision to remove five things. So the sweep's rule is:
 *
 *   ADOPT, NEVER REMOVE. Installed-but-unlisted components are written INTO the
 *   config (so the repo's manifest finally describes its disk), and `install`
 *   then runs with removals DISABLED. A removal is a per-repo human decision,
 *   made by running `remove` in that repo, where the person can read what it
 *   says it will take out.
 *
 * The rest of the payload is bookkeeping the fleet needs once: the dead
 * `version` / `lastSynced` stamps and the retired
 * `componentConfig["critical-rules"].modules` include-list are deleted (D2/D3),
 * and the SDK pin is bumped to the release being swept. Running the two in the
 * SAME pass is deliberate — see dchjw.10: a repo with `modules` stripped but an
 * old pin reads as not-enrolled to its own rules-drift check, so the window
 * where that is true has to be one run, not one release.
 *
 * Everything here that decides is a pure function over a parsed config, so the
 * decisions can be asserted without standing up a worktree, a package manager
 * or the network. The writing half is `applyInstallPayloadConfig`.
 */

import {existsSync} from 'fs';
import {resolve} from 'path';

import {componentProvenanceEvidence} from './component-manifest';
import {
  componentApplicability,
  type ComponentName,
  COMPONENT_NAMES,
  configNameFor,
  resolveComponents,
} from './component-registry';
import {planInstall} from './install';
import {readJson, writeJson} from './setup-helpers';

/** The config file every enrolled repo carries. */
export const SDK_CONFIG_FILE = 'justin-sdk.config.json';

/**
 * Keys the SDK wrote and nothing ever read back (D3), plus the retired rules
 * include-list (D2). Each is deleted with one line of output naming it: a key
 * vanishing from a committed file with no output is exactly the silent edit a
 * fleet sweep must not make.
 */
export const DEAD_TOP_LEVEL_KEYS = ['version', 'lastSynced'] as const;
export const RETIRED_MODULES_PATH = 'componentConfig["critical-rules"].modules';

/** One component the sweep saw but deliberately did NOT write into the config. */
export interface NotAdopted {
  /** The `-setup` name, as the config would spell it. */
  configName: string;
  /** Why it was passed over — printed verbatim so the reason is auditable. */
  reason: string;
}

export interface AdoptionResult {
  /** The config object to write — a copy; the input is never mutated. */
  config: Record<string, unknown>;
  /** `-setup` names written into `components` that were not there before. */
  adopted: string[];
  /**
   * Looked installed, was not adopted, and why. NEVER an empty list standing in
   * for "I did not look" — every component is classified on every pass, and a
   * component with no evidence at all simply does not appear (critical rule 6).
   */
  notAdopted: NotAdopted[];
}

/**
 * Add every component this SDK can PROVE it installed here but that the config
 * does not list.
 *
 * ADOPTION REQUIRES PROVENANCE (dchjw.19). It used to require
 * `componentInstalledEvidence`, which answers "is something shaped like this
 * component on disk" — the right question for `install`, which only ever reports
 * what it finds, and the wrong one here, because adoption WRITES the name into a
 * repo's committed config and thereby signs that repo up for every future
 * install of it. The first full-fleet dry-run made the difference concrete:
 * `life: adopt: beads-setup`, where life is a Dolt workspace whose `.beads/`
 * directory beads-setup's migration step would have DELETED, and a Swift repo
 * reading as prettier + husky from two generic filenames. So:
 *
 *   - `componentProvenanceEvidence` decides, not `componentInstalledEvidence`.
 *   - A component whose `includeIf` does not pass in this repo is never adopted,
 *     whatever the evidence says — an inapplicable component is not a thing this
 *     repo has, it is a thing this repo must not get.
 *   - Weak evidence is REPORTED, not acted on, so a human can decide. Silence
 *     would make "I found something I could not verify" look like "there was
 *     nothing there".
 *
 * A config with NO `components` key means the `core` preset, and that stays
 * true: the key is only written when something installed falls OUTSIDE core,
 * because writing out a list that the default already covers would freeze this
 * repo's component set against a `core` that is computed per repo, at every
 * refresh. Nothing is ever removed from the list, including names this SDK does
 * not recognise (`install` reports those and ignores them).
 */
export function adoptInstalledComponents(
  projectRoot: string,
  config: Record<string, unknown>,
): AdoptionResult {
  const resolved = resolveComponents(config, projectRoot);
  if (!resolved.ok) return {adopted: [], config, notAdopted: []};

  const applicability = new Map(
    componentApplicability(projectRoot).map((entry) => [entry.name, entry]),
  );
  const listed = new Set(resolved.components);
  const adopted: string[] = [];
  const notAdopted: NotAdopted[] = [];

  for (const name of COMPONENT_NAMES) {
    const configName = configNameFor(name);
    if (listed.has(configName)) continue;

    const evidence = componentProvenanceEvidence(projectRoot, name);
    if (evidence.kind === 'absent') continue;

    // The includeIf gate is checked FIRST and reported on its own terms: it is
    // categorical ("this can never apply here"), where weak evidence is merely
    // unproven, and conflating the two would hide the stronger statement.
    const gate = applicability.get(name);
    if (gate != null && !gate.applicable) {
      const predicates =
        gate.unknownPredicates.length > 0
          ? `unknown predicate(s) ${gate.unknownPredicates.join(', ')}`
          : gate.includeIf.join(', ');
      notAdopted.push({
        configName,
        reason: `does not apply to this repo (includeIf: ${predicates}); evidence was ${evidence.because}`,
      });
      continue;
    }

    if (evidence.kind === 'weak') {
      notAdopted.push({
        configName,
        reason: `evidence was ${evidence.because}`,
      });
      continue;
    }
    adopted.push(configName);
  }

  if (adopted.length === 0) return {adopted: [], config, notAdopted};

  // The existing list, or the resolved `core` expansion when the key was
  // absent — the adoption has to be additive to what the repo HAS, and what it
  // has when the key is absent is core.
  const existing = Array.isArray(config.components)
    ? (config.components as unknown[]).filter(
        (entry): entry is string => typeof entry === 'string',
      )
    : resolved.components.filter(
        (name) => name !== configNameFor('base-setup'),
      );

  return {
    adopted,
    config: {...config, components: [...existing, ...adopted]},
    notAdopted,
  };
}

export interface DeadKeyResult {
  config: Record<string, unknown>;
  /** Human-readable key paths that were removed. */
  dropped: string[];
}

/**
 * Delete the dead keys. Pure, and it never touches anything else in the file —
 * an empty `componentConfig["critical-rules"]` block is LEFT behind rather than
 * tidied away, because a block is a place a human may have put something and
 * this payload only removes what it can name.
 */
export function dropDeadConfigKeys(
  config: Record<string, unknown>,
): DeadKeyResult {
  const next = {...config};
  const dropped: string[] = [];

  for (const key of DEAD_TOP_LEVEL_KEYS) {
    if (key in next) {
      delete next[key];
      dropped.push(key);
    }
  }

  const componentConfig = next.componentConfig;
  if (componentConfig != null && typeof componentConfig === 'object') {
    const blocks = componentConfig as Record<string, unknown>;
    const rules = blocks['critical-rules'];
    if (
      rules != null &&
      typeof rules === 'object' &&
      'modules' in (rules as Record<string, unknown>)
    ) {
      const nextRules = {...(rules as Record<string, unknown>)};
      delete nextRules.modules;
      next.componentConfig = {...blocks, 'critical-rules': nextRules};
      dropped.push(RETIRED_MODULES_PATH);
    }
  }

  return {config: next, dropped};
}

export interface InstallPayloadPlan {
  /** `-setup` names this payload would write into `components`. */
  adopted: string[];
  /** Components that looked installed but were left for a human to decide. */
  notAdopted: NotAdopted[];
  /** Dead key paths this payload would delete. */
  dropped: string[];
  /** Components `install` will (re-)apply afterwards. */
  apply: ComponentName[];
  /**
   * What a REMOVAL-ENABLED install would delete from this repo AS IT STANDS
   * TODAY — i.e. measured against the config BEFORE adoption, which is the only
   * measurement that says anything. (After adoption the list is empty by
   * construction: that is the adoption working, and a dry-run that printed the
   * empty list would be reporting the protection as though it were the risk.)
   */
  protectedFromRemoval: ComponentName[];
}

/** What this payload would do to one repo, computed without writing. */
export function planInstallPayload(
  projectRoot: string,
): InstallPayloadPlan | {error: string} {
  const configPath = resolve(projectRoot, SDK_CONFIG_FILE);
  if (!existsSync(configPath)) {
    return {error: `${SDK_CONFIG_FILE} not found — this repo is not enrolled`};
  }
  const config = readJson(configPath);
  if (config == null) {
    return {error: `${SDK_CONFIG_FILE} is not valid JSON`};
  }

  const adoption = adoptInstalledComponents(
    projectRoot,
    config as Record<string, unknown>,
  );
  const dead = dropDeadConfigKeys(adoption.config);

  // What will be APPLIED is decided by the config as this payload will LEAVE it
  // (otherwise every adopted component would read as one to be removed).
  const plan = planInstall(projectRoot, dead.config);
  if ('error' in plan) return plan;

  // What is being PROTECTED is decided by the config as it stands today — the
  // repo's current answer to "installed but not listed".
  const today = planInstall(projectRoot, config);

  return {
    adopted: adoption.adopted,
    apply: plan.apply,
    dropped: dead.dropped,
    notAdopted: adoption.notAdopted,
    protectedFromRemoval: 'error' in today ? [] : today.unlisted,
  };
}

export interface ConfigRewriteResult {
  adopted: string[];
  dropped: string[];
  /** Looked installed, left alone — the caller prints these. */
  notAdopted: NotAdopted[];
  /** True when justin-sdk.config.json was written. */
  changed: boolean;
}

/**
 * Apply the config half of the payload to a worktree: adopt, then delete. The
 * file is written only when something changed, so a second sweep over an
 * already-swept repo produces no diff at all.
 */
export function applyInstallPayloadConfig(
  projectRoot: string,
): ConfigRewriteResult | {error: string} {
  const configPath = resolve(projectRoot, SDK_CONFIG_FILE);
  if (!existsSync(configPath)) {
    return {error: `${SDK_CONFIG_FILE} not found — this repo is not enrolled`};
  }
  const config = readJson(configPath);
  if (config == null) return {error: `${SDK_CONFIG_FILE} is not valid JSON`};

  const adoption = adoptInstalledComponents(
    projectRoot,
    config as Record<string, unknown>,
  );
  const dead = dropDeadConfigKeys(adoption.config);
  const changed = adoption.adopted.length > 0 || dead.dropped.length > 0;
  if (changed) writeJson(configPath, dead.config);

  return {
    adopted: adoption.adopted,
    changed,
    dropped: dead.dropped,
    notAdopted: adoption.notAdopted,
  };
}

/**
 * The line a human has to read and act on: something here looks like a
 * component, and the SDK will not touch it on a guess.
 *
 * Exported because the dry-run renderer and the live payload both print it, and
 * a second spelling would be a second contract.
 */
export function noProvenanceLine(entry: NotAdopted): string {
  return `looks installed but not adopted (no SDK provenance): ${entry.configName} — ${entry.reason}`;
}

/** One line per fact, for the dry-run plan and the run log. */
export function renderInstallPayloadPlan(
  plan: InstallPayloadPlan,
): readonly string[] {
  const lines: string[] = [];
  lines.push(
    plan.adopted.length === 0
      ? 'adopt: nothing — the config already lists everything this SDK can prove it installed'
      : `adopt: ${plan.adopted.join(', ')}`,
  );
  for (const entry of plan.notAdopted) lines.push(noProvenanceLine(entry));
  lines.push(
    plan.dropped.length === 0
      ? 'delete: no dead keys'
      : `delete: ${plan.dropped.join(', ')}`,
  );
  lines.push(`install: would apply ${plan.apply.length} component(s)`);
  lines.push(
    plan.protectedFromRemoval.length === 0
      ? 'remove: nothing would be removed even with removals enabled'
      : `remove: DISABLED — ${plan.protectedFromRemoval.join(', ')} would be removed by a removal-enabled install and are being kept`,
  );
  return lines;
}
