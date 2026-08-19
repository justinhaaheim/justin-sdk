/**
 * rules-selection.ts — the ONE reader of a repo's recorded critical-rules
 * module selection (t6a0.21 D12).
 *
 * Enrollment records the RESULT of the project-type predicates in
 * `componentConfig["critical-rules"].modules`, and every consumer reads it back
 * through this function: the installer, `rules-update`, `rules-diff`, the
 * staleness checker, and the SessionStart hook. One reader means "is this repo
 * enrolled" cannot mean two different things in two places.
 *
 * It lives in the plugin lib rather than in `critical-rules-setup` because the
 * hook needs it and a published plugin package contains ONLY `src/plugin`
 * (home-base-qjyj — see local-fs.ts for the full mechanism). `critical-rules-setup`
 * re-exports it, so this is a move, never a fork (D14).
 */

import {existsSync} from 'fs';
import {resolve} from 'path';

import {readJson} from './local-fs';

/** Key under `componentConfig` in justin-sdk.config.json. */
export const CRITICAL_RULES_CONFIG_KEY = 'critical-rules';

export type SelectionRead =
  | {ok: true; modules: string[]}
  | {ok: false; status: 'not-enrolled' | 'failed'; message: string};

/**
 * Read the recorded module selection.
 *
 * Every failure is its own state — "no config file", "corrupt config", "no
 * selection recorded", "the list is not a list of names" and "the list is
 * empty" are five different facts and none of them may read as "assemble
 * nothing" (which would write an artifact stripped of every rule and report
 * success).
 */
export function readSelectedModules(projectRoot: string): SelectionRead {
  const configPath = resolve(projectRoot, 'justin-sdk.config.json');
  const config = readJson(configPath);
  if (config == null) {
    // readJson returns null for BOTH "missing" and "unparseable", which are not
    // the same fact — re-read the existence to tell them apart.
    return existsSync(configPath)
      ? {
          message: `justin-sdk.config.json at ${configPath} could not be parsed — refusing to guess the module selection`,
          ok: false,
          status: 'failed',
        }
      : {
          message: `justin-sdk.config.json not found in ${projectRoot} — run \`add critical-rules\` to enroll`,
          ok: false,
          status: 'not-enrolled',
        };
  }

  const componentConfig = config.componentConfig as
    | Record<string, unknown>
    | undefined;
  const block = componentConfig?.[CRITICAL_RULES_CONFIG_KEY];
  if (block == null) {
    return {
      message:
        `no componentConfig["${CRITICAL_RULES_CONFIG_KEY}"] in justin-sdk.config.json — ` +
        `this repo has no recorded module selection; run \`add critical-rules\` to enroll`,
      ok: false,
      status: 'not-enrolled',
    };
  }
  if (typeof block !== 'object' || Array.isArray(block)) {
    return {
      message: `componentConfig["${CRITICAL_RULES_CONFIG_KEY}"] must be an object with a "modules" array`,
      ok: false,
      status: 'failed',
    };
  }
  const raw = (block as Record<string, unknown>).modules;
  if (
    !Array.isArray(raw) ||
    raw.some((name) => typeof name !== 'string' || name.length === 0)
  ) {
    return {
      message: `componentConfig["${CRITICAL_RULES_CONFIG_KEY}"].modules must be an array of module names`,
      ok: false,
      status: 'failed',
    };
  }
  if (raw.length === 0) {
    return {
      message:
        `componentConfig["${CRITICAL_RULES_CONFIG_KEY}"].modules is empty — ` +
        `nothing to assemble. Add module names, or remove the component from "components".`,
      ok: false,
      status: 'failed',
    };
  }
  return {modules: raw as string[], ok: true};
}
