/**
 * rules-enrollment.ts — the ONE answer to "is this repo enrolled in
 * critical-rules?", and the ONE detector for the retired `modules` key
 * (epic home-base-dchjw D2, constraint F2).
 *
 * It replaces `rules-selection.ts`, which answered a different question —
 * "which modules did this repo pick at enrolment?" — and used the ANSWER as the
 * enrolment test. That conflation is what let a repo be reported `not-enrolled`
 * simply because its config had no `modules` key, and it is why a module added
 * to the registry never reached an already-enrolled repo. There is no per-repo
 * module list any more: the registry and the predicates decide, at every
 * refresh. What is left is the enrolment question, and it has two independent
 * pieces of evidence (either is sufficient):
 *
 *   1. `critical-rules-setup` in the config's `components`, and
 *   2. the artifact file itself existing.
 *
 * (2) is not redundant. `components` is rewritten by hand and by installers, and
 * a repo carrying a committed `.claude/rules/justin-sdk/critical-rules.md` is
 * enrolled whatever its config says — reporting THAT repo `not-enrolled` would
 * silently stop checking a file that is actively loaded into every session.
 *
 * "ENROLLED BUT UNREADABLE" IS NOT "NOT ENROLLED" (F2, critical rule 6). An
 * unparseable justin-sdk.config.json is a FAILED measurement; only a config that
 * is genuinely absent, or present and genuinely without the component, is an
 * absence. The two are different facts and the caller must be able to tell them
 * apart, because one of them means "say nothing" and the other means "say you
 * could not check".
 *
 * It lives here rather than in `critical-rules-setup` because `rules-drift`
 * reaches it on the session-start path, and `critical-rules-setup` brings
 * console-writing helpers with it. The original reason was the plugin's import
 * closure (home-base-qjyj), retired with the plugin in dchjw.8.
 */

import {existsSync} from 'fs';
import {resolve} from 'path';

import {resolveComponents} from '../component-registry';
import {readJson} from '../local-fs';
import {projectRulesFilePath} from './rules-file';

/**
 * The name `critical-rules` registers in `justin-sdk.config.json#components`.
 *
 * Spelled out rather than imported from the component registry
 * (`configNameFor`). That was once forced by the plugin's import closure
 * (retired in dchjw.8) and is now just an unmerged constant; a test asserts the
 * two agree, so keep it in step by hand until something collapses them.
 */
export const CRITICAL_RULES_COMPONENT = 'critical-rules-setup';

/** Key under `componentConfig` in justin-sdk.config.json. */
export const CRITICAL_RULES_CONFIG_KEY = 'critical-rules';

/** The per-repo include-list that dchjw.3 retired. Detected, never honoured. */
export const RETIRED_MODULES_KEY = 'modules';

export type EnrollmentRead =
  | {evidence: 'components' | 'artifact'; ok: true}
  | {message: string; ok: false; status: 'not-enrolled' | 'failed'};

/** Is this repo enrolled in critical-rules? */
export function readEnrollment(projectRoot: string): EnrollmentRead {
  // The artifact first: it is a fact on disk that no config can contradict, and
  // it costs one stat.
  if (existsSync(projectRulesFilePath(projectRoot))) {
    return {evidence: 'artifact', ok: true};
  }

  const configPath = resolve(projectRoot, 'justin-sdk.config.json');
  const config = readJson(configPath);
  if (config == null) {
    // readJson returns null for BOTH "missing" and "unparseable", which are not
    // the same fact — re-read the existence to tell them apart (F2).
    return existsSync(configPath)
      ? {
          message: `justin-sdk.config.json at ${configPath} could not be parsed — whether this repo is enrolled in critical-rules is UNKNOWN, not "no"`,
          ok: false,
          status: 'failed',
        }
      : {
          message: `justin-sdk.config.json not found in ${projectRoot} — run \`add critical-rules\` to enroll`,
          ok: false,
          status: 'not-enrolled',
        };
  }

  // resolveComponents is THE reader of `components` (dchjw.5, F1). It is what
  // makes an ABSENT key mean the `core` preset — and critical-rules is IN core,
  // so a repo whose config simply does not list its components is enrolled,
  // which is exactly the shape `init` now writes. Reading absence as an empty
  // list, as this did, reported every one of those repos `not-enrolled`.
  const resolved = resolveComponents(config, projectRoot);
  if (!resolved.ok) {
    return {
      message: `${resolved.reason} (at ${configPath}) — whether this repo is enrolled in critical-rules is UNKNOWN, not "no"`,
      ok: false,
      status: 'failed',
    };
  }
  const listed = resolved.components.includes(CRITICAL_RULES_COMPONENT);
  return listed
    ? {evidence: 'components', ok: true}
    : {
        message: `"${CRITICAL_RULES_COMPONENT}" is not in justin-sdk.config.json#components and there is no rules artifact — run \`add critical-rules\` to enroll`,
        ok: false,
        status: 'not-enrolled',
      };
}

/**
 * Does this repo's config still carry the retired
 * `componentConfig["critical-rules"].modules` include-list?
 *
 * PURE, and deliberately so: doctor re-runs its checks after a fix, so a
 * once-per-process latch here would turn a still-present key into a green
 * re-check. The once-per-command dedupe lives at the command entry points, which
 * call `legacyModulesWarning` exactly once each.
 *
 * An unreadable config answers `false` — "there is no key here to warn about" is
 * the honest reading, and the enrolment read above is what reports the unreadable
 * config as a failure. This function is not the place that discovery happens.
 */
export function hasRetiredModulesKey(projectRoot: string): boolean {
  const config = readJson(resolve(projectRoot, 'justin-sdk.config.json'));
  if (config == null) return false;
  const componentConfig = config.componentConfig as
    | Record<string, unknown>
    | undefined;
  const block = componentConfig?.[CRITICAL_RULES_CONFIG_KEY];
  if (block == null || typeof block !== 'object' || Array.isArray(block)) {
    return false;
  }
  return (block as Record<string, unknown>)[RETIRED_MODULES_KEY] != null;
}

/**
 * The ONE wording of the retired-key warning, so the installer, doctor,
 * rules-update and rules-diff cannot say it four different ways.
 *
 * Returns null when there is nothing to say — callers print it or attach it as a
 * check message, and exactly one caller per command run does so.
 */
export function legacyModulesWarning(projectRoot: string): string | null {
  if (!hasRetiredModulesKey(projectRoot)) return null;
  return (
    `componentConfig["${CRITICAL_RULES_CONFIG_KEY}"].${RETIRED_MODULES_KEY} in justin-sdk.config.json is NO LONGER HONOURED and is being ignored — ` +
    `which rules a repo gets is decided by the prompts registry and the project-type predicates at every refresh, not by a list frozen at enrolment. ` +
    `Delete the "${RETIRED_MODULES_KEY}" key.`
  );
}
