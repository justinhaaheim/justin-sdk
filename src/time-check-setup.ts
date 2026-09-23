/**
 * time-check-setup — installs the UserPromptSubmit time-check hook.
 *
 * Scaffolds two things in the consuming project:
 *   - a UserPromptSubmit hook in .claude/settings.json running
 *     `bun run justin-sdk time-check`
 *   - a `componentConfig["time-check"]` block in justin-sdk.config.json
 *     carrying the defaults
 *
 * IN THE CORE PRESET since 2026-09-18 (epic home-base-dchjw D3, Justin's call).
 * It was withheld from every preset before that because this hook fires on
 * EVERY prompt, and installing it fleet-wide "but disabled" spends a process
 * spawn per prompt to print nothing. That cost is real and now accepted; the
 * hook still treats a missing config block as "disabled".
 *
 * Idempotent: re-running detects the existing hook and config block and only
 * writes when something actually needs to change.
 */

import {basename, resolve} from 'path';

import {runBaseSetup} from './base-setup';
import {sdkRun, sdkScript, upsertHookCommand} from './sdk-invocation';
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

/**
 * The SDK subcommand this hook runs. It — not any whole invocation — is what
 * identifies an already-installed hook in every spelling (dchjw.15 F1).
 */
const HOOK_SUBCOMMAND = 'time-check';

/**
 * The command the hook runs, in form D1(b). Hooks run under `sh`, not under
 * `bun run`, so the prefix has to be spelled out here.
 */
export const TIME_CHECK_HOOK_COMMAND = sdkRun(HOOK_SUBCOMMAND);
const HOOK_COMMAND = TIME_CHECK_HOOK_COMMAND;

/**
 * The CURRENT spelling of this hook, kept as one string for the component
 * manifest's installed-evidence check. An entry running this subcommand in any
 * spelling is recognised and rewritten in place — see `upsertHookCommand`.
 */
export const TIME_CHECK_HOOK_FINGERPRINT = sdkScript(HOOK_SUBCOMMAND);

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

  const settings = readJson(settingsPath) ?? {};
  const hooks = (settings.hooks as Record<string, unknown> | undefined) ?? {};
  const userPromptSubmit =
    (hooks.UserPromptSubmit as unknown[] | undefined) ?? [];

  const {changed, entries} = upsertHookCommand(
    userPromptSubmit,
    HOOK_SUBCOMMAND,
    HOOK_COMMAND,
    () => ({hooks: [{command: HOOK_COMMAND, type: 'command'}]}),
  );
  if (!changed) {
    success('.claude/settings.json already has the time-check hook');
    return true;
  }

  hooks.UserPromptSubmit = entries;
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

  const componentConfig =
    (config.componentConfig as Record<string, unknown> | undefined) ?? {};

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
  force?: boolean;
  projectRoot: string;
  quiet: boolean;
  /**
   * The remote the SDK pin tag is verified against, forwarded to base-setup.
   * Tests point it at a local bare repo so the install is hermetic; production
   * omits it and base-setup uses the real SDK_REPO_URL (dchjw.17 F7).
   */
  sdkRepoUrl?: string;
}): Promise<number> {
  const {projectRoot, quiet} = args;
  setQuiet(quiet);

  stepHeader('0. base-setup (foundation layer)');
  const baseExit = await runBaseSetup({
    projectRoot,
    quiet: true,
    // dchjw.17 F7: hermetic when a caller supplies a remote; the real
    // SDK_REPO_URL when nobody does.
    ...(args.sdkRepoUrl == null ? {} : {sdkRepoUrl: args.sdkRepoUrl}),
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
