/**
 * usage-check-setup — installs the context-usage notice hook.
 *
 * Scaffolds three things in the consuming project:
 *   - a UserPromptSubmit hook in .claude/settings.json running
 *     `bunx @justinhaaheim/justin-sdk usage-check`
 *   - a PostToolBatch hook running the same command
 *   - a `componentConfig["usage-check"]` block in justin-sdk.config.json
 *     carrying the two switches (`enabled`, `wrapUpAt`) and deliberately NOT
 *     the setpoint ladder — see stepUsageCheckConfig
 *
 * WHY BOTH EVENTS (verified empirically in CC 2.1.238, home-base-1r6d.1):
 * UserPromptSubmit only fires when a human sends a message, and the sessions
 * that most need to know their context size are the autonomous ones, whose
 * turns run for hours without a single prompt. PostToolBatch fires once after
 * each batch of tool calls resolves, "before the next model request", which
 * covers exactly that gap. PostToolUse was rejected: it fires per-tool and runs
 * CONCURRENTLY for parallel calls, so copies would race and double-announce.
 *
 * OPT-IN ONLY, deliberately — same reasoning as time-check but more so, since
 * this fires after every tool batch as well as every prompt. It is excluded
 * from `init` and the `all` preset (see OPT_IN_ONLY in components.ts), and the
 * hook treats a missing config block as "disabled" so an accidental install is
 * inert rather than noisy.
 *
 * Idempotent: re-running detects the existing hooks and config block and only
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
import {
  formatTokens,
  SETPOINT_CEILING_TOKENS,
  SETPOINT_INTERVAL_TOKENS,
  USAGE_CHECK_CONFIG_KEY,
  USAGE_CHECK_DEFAULTS,
} from './usage-check';

/** The command the hooks run. Matches the time-check precedent. */
const HOOK_COMMAND = 'bunx @justinhaaheim/justin-sdk usage-check';

/** Substring identifying an already-installed hook, whatever its bunx spelling. */
const HOOK_FINGERPRINT = 'justin-sdk usage-check';

/** The hook events this component registers, in the order they are written. */
export const USAGE_CHECK_HOOK_EVENTS = [
  'UserPromptSubmit',
  'PostToolBatch',
] as const;

/**
 * Register the hook command under one event in .claude/settings.json.
 *
 * Hooks are ADDITIVE in Claude Code — several may be registered for the same
 * event and all of them run — so this appends rather than replacing, leaving
 * any existing hooks (a session logger, time-check, the prettier PostToolUse
 * hook) untouched. Returns true when the settings object was modified.
 */
export function addUsageCheckHook(
  settings: Record<string, unknown>,
  event: string,
): boolean {
  const hooks = ((settings.hooks as Record<string, unknown> | undefined) ??
    {}) as Record<string, unknown>;
  const registered = (hooks[event] as unknown[] | undefined) ?? [];

  if (JSON.stringify(registered).includes(HOOK_FINGERPRINT)) {
    return false;
  }

  registered.push({hooks: [{command: HOOK_COMMAND, type: 'command'}]});
  hooks[event] = registered;
  settings.hooks = hooks;
  return true;
}

export function stepUsageCheckHooks(projectRoot: string): boolean {
  const settingsDir = resolve(projectRoot, '.claude');
  const settingsPath = resolve(settingsDir, 'settings.json');
  ensureDir(settingsDir);

  const settings = (readJson(settingsPath) ?? {}) as Record<string, unknown>;
  const added: string[] = [];
  for (const event of USAGE_CHECK_HOOK_EVENTS) {
    if (addUsageCheckHook(settings, event)) {
      added.push(event);
    }
  }

  if (added.length === 0) {
    success('.claude/settings.json already has the usage-check hooks');
    return true;
  }

  writeJson(settingsPath, settings);
  success(`Updated .claude/settings.json (${added.join(' + ')} → usage-check)`);
  return true;
}

/**
 * Seed `componentConfig["usage-check"]` with the two switches Justin operates,
 * and nothing else.
 *
 * WHAT IS OMITTED AND WHY: `setpoints` and `reArmDropFraction` are deliberately
 * NOT written. A materialized copy freezes today's defaults into every repo at
 * install time, so changing the default ladder later would silently reach none
 * of them — and the ladder is exactly the thing that has already changed once
 * (D7). Leaving them absent makes the SDK's default the live value everywhere,
 * and a project that wants its own rungs still writes them out longhand; the
 * hook reads an absent key as "use the default", never as "disabled".
 *
 * WHAT IS WRITTEN AND WHY: `enabled` and `wrapUpAt` are the knobs, so they are
 * spelled out even when they equal the defaults — `wrapUpAt: null` is how a
 * reader discovers that the wrap-up directive exists, is off, and is turned on
 * by putting a number there (D8). Both track USAGE_CHECK_DEFAULTS rather than
 * repeating literals, so there is still one source for the values.
 *
 * Only writes when the block is absent — a project that has tuned its
 * setpoints (or set `enabled: false`) must survive a re-run untouched.
 */
export function stepUsageCheckConfig(projectRoot: string): boolean {
  const configPath = resolve(projectRoot, 'justin-sdk.config.json');
  const config = readJson(configPath);
  if (config == null) {
    fail('justin-sdk.config.json missing — run base-setup first');
    return false;
  }

  const componentConfig = ((config.componentConfig as
    | Record<string, unknown>
    | undefined) ?? {}) as Record<string, unknown>;

  if (componentConfig[USAGE_CHECK_CONFIG_KEY] != null) {
    success(
      `justin-sdk.config.json already configures ${USAGE_CHECK_CONFIG_KEY}`,
    );
    return true;
  }

  componentConfig[USAGE_CHECK_CONFIG_KEY] = {
    enabled: USAGE_CHECK_DEFAULTS.enabled,
    wrapUpAt: USAGE_CHECK_DEFAULTS.wrapUpAt,
  };
  config.componentConfig = componentConfig;
  writeJson(configPath, config);

  const wrapUpSummary =
    USAGE_CHECK_DEFAULTS.wrapUpAt == null
      ? 'wrapUpAt: null — the wrap-up directive is OFF; set a token count to opt in'
      : `wrapUpAt: ${USAGE_CHECK_DEFAULTS.wrapUpAt}`;
  success(`Added componentConfig.${USAGE_CHECK_CONFIG_KEY} (${wrapUpSummary})`);
  success(
    'Setpoints left unset, so this project tracks the SDK default: one ' +
      `notice every ${formatTokens(SETPOINT_INTERVAL_TOKENS)} tokens up to ` +
      formatTokens(SETPOINT_CEILING_TOKENS),
  );
  return true;
}

export async function runUsageCheckSetup(args: {
  projectRoot: string;
  quiet: boolean;
  force?: boolean;
}): Promise<number> {
  const {projectRoot, quiet} = args;
  setQuiet(quiet);

  stepHeader('0. base-setup (foundation layer)');
  const baseExit = await runBaseSetup({
    extraComponents: ['usage-check-setup'],
    projectRoot,
    quiet: true,
  });
  if (baseExit !== 0) {
    fail('base-setup failed — cannot proceed with usage-check-setup');
    return baseExit;
  }
  // base-setup toggles quiet internally; restore our setting.
  setQuiet(quiet);
  success('base-setup ready');

  stepHeader('1. .claude/settings.json (UserPromptSubmit + PostToolBatch)');
  if (!stepUsageCheckHooks(projectRoot)) return 1;

  stepHeader('2. justin-sdk.config.json (componentConfig)');
  if (!stepUsageCheckConfig(projectRoot)) return 1;

  if (!isQuiet()) {
    console.log(
      `\n\x1b[32m\x1b[1musage-check-setup ready\x1b[0m in ${basename(projectRoot)}.\n` +
        `Tune it under componentConfig["${USAGE_CHECK_CONFIG_KEY}"] in justin-sdk.config.json.\n` +
        `It reports the SESSION'S OWN context consumption — not subscription quota.\n`,
    );
  }

  return 0;
}
