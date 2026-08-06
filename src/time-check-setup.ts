/**
 * time-check-setup — installs the UserPromptSubmit time-check hook.
 *
 * Scaffolds two things in the consuming project:
 *   - a UserPromptSubmit hook in .claude/settings.json running
 *     `bunx justin-sdk time-check`
 *   - a `componentConfig["time-check"]` block in justin-sdk.config.json
 *     carrying the defaults
 *
 * OPT-IN ONLY, deliberately. Unlike every other component this hook fires on
 * EVERY prompt, so installing it fleet-wide "but disabled" would spend a
 * process spawn per prompt in every project to print nothing. It is therefore
 * excluded from `init` and the `all` preset (see OPT_IN_ONLY in components.ts),
 * and the hook treats a missing config block as "disabled" so an accidental
 * install is inert rather than noisy.
 *
 * Idempotent: re-running detects the existing hook and config block and only
 * writes when something actually needs to change.
 */

import {basename, resolve} from 'path';

import {runBaseSetup} from './base-setup';
import {
  ensureDir,
  fail,
  isQuiet,
  readJson,
  setQuiet,
  stepHeader,
  success,
  writeJson,
} from './setup-helpers';
import {TIME_CHECK_CONFIG_KEY, TIME_CHECK_DEFAULTS} from './time-check';

/** The command the hook runs. Matches the `bunx justin-sdk prime` precedent. */
const HOOK_COMMAND = 'bunx justin-sdk time-check';

/**
 * Add the UserPromptSubmit hook to .claude/settings.json.
 *
 * Hooks are ADDITIVE in Claude Code — several may be registered for the same
 * event and all of them run — so this appends rather than replacing, leaving
 * any existing UserPromptSubmit hooks (e.g. a session logger) untouched.
 */
export function stepTimeCheckHook(projectRoot: string): boolean {
  const settingsDir = resolve(projectRoot, '.claude');
  const settingsPath = resolve(settingsDir, 'settings.json');
  ensureDir(settingsDir);

  const settings = (readJson(settingsPath) ?? {}) as Record<string, unknown>;
  const hooks = ((settings.hooks as Record<string, unknown> | undefined) ??
    {}) as Record<string, unknown>;
  const userPromptSubmit =
    (hooks.UserPromptSubmit as unknown[] | undefined) ?? [];

  if (JSON.stringify(userPromptSubmit).includes('justin-sdk time-check')) {
    success('.claude/settings.json already has the time-check hook');
    return true;
  }

  userPromptSubmit.push({
    hooks: [{command: HOOK_COMMAND, type: 'command'}],
  });
  hooks.UserPromptSubmit = userPromptSubmit;
  settings.hooks = hooks;
  writeJson(settingsPath, settings);
  success('Updated .claude/settings.json (UserPromptSubmit → time-check)');
  return true;
}

/**
 * Seed `componentConfig["time-check"]` with the defaults.
 *
 * Only writes when the block is absent — a project that has tuned its
 * thresholds (or set `enabled: false`) must survive a re-run untouched.
 */
export function stepTimeCheckConfig(projectRoot: string): boolean {
  const configPath = resolve(projectRoot, 'justin-sdk.config.json');
  const config = readJson(configPath);
  if (config == null) {
    fail('justin-sdk.config.json missing — run base-setup first');
    return false;
  }

  const componentConfig = ((config.componentConfig as
    | Record<string, unknown>
    | undefined) ?? {}) as Record<string, unknown>;

  if (componentConfig[TIME_CHECK_CONFIG_KEY] != null) {
    success(
      `justin-sdk.config.json already configures ${TIME_CHECK_CONFIG_KEY}`,
    );
    return true;
  }

  componentConfig[TIME_CHECK_CONFIG_KEY] = {...TIME_CHECK_DEFAULTS};
  config.componentConfig = componentConfig;
  writeJson(configPath, config);
  success(
    `Added componentConfig.${TIME_CHECK_CONFIG_KEY} ` +
      `(gapHours: ${TIME_CHECK_DEFAULTS.gapHours}, ` +
      `notifyOnNewDayBoundaryHour: ${TIME_CHECK_DEFAULTS.notifyOnNewDayBoundaryHour})`,
  );
  return true;
}

export async function runTimeCheckSetup(args: {
  projectRoot: string;
  quiet: boolean;
  force?: boolean;
}): Promise<number> {
  const {projectRoot, quiet} = args;
  setQuiet(quiet);

  stepHeader('0. base-setup (foundation layer)');
  const baseExit = await runBaseSetup({
    extraComponents: ['time-check-setup'],
    projectRoot,
    quiet: true,
  });
  if (baseExit !== 0) {
    fail('base-setup failed — cannot proceed with time-check-setup');
    return baseExit;
  }
  // base-setup toggles quiet internally; restore our setting.
  setQuiet(quiet);
  success('base-setup ready');

  stepHeader('1. .claude/settings.json (UserPromptSubmit hook)');
  if (!stepTimeCheckHook(projectRoot)) return 1;

  stepHeader('2. justin-sdk.config.json (componentConfig)');
  if (!stepTimeCheckConfig(projectRoot)) return 1;

  if (!isQuiet()) {
    console.log(
      `\n\x1b[32m\x1b[1mtime-check-setup ready\x1b[0m in ${basename(projectRoot)}.\n` +
        `Tune it under componentConfig["${TIME_CHECK_CONFIG_KEY}"] in justin-sdk.config.json.\n`,
    );
  }

  return 0;
}
