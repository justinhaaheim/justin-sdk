/**
 * thread-hooks-setup — installs the two thread hooks in a consuming project.
 *
 * Scaffolds exactly TWO entries in `.claude/settings.json`:
 *
 *  - `SessionStart` [startup|resume] → `thread start --hook`, which creates the
 *    session's thread bead before it has reported anything (home-base-p1uj.3).
 *  - `Stop` (no matcher) → `thread stop-check`, which refuses to let a session
 *    finish on a status report it cannot prove was recorded (home-base-p1uj.15).
 *
 * WHY THE STOP HOOK TAKES NO MATCHER: `Stop` has no matcher dimension — it fires
 * once per turn end, for main sessions and subagents alike, and the hook's own
 * first two tests (the `enforce` knob, then `agent_id`) are what narrow it. A
 * matcher string here would be silently ignored rather than helpfully restrictive.
 *
 * WHY `startup|resume` AND NOT THE OTHER TWO SOURCES. SessionStart fires with
 * source startup | resume | clear | compact. `clear` and `compact` keep the SAME
 * session id, so the command would find the existing bead and no-op — a bd
 * round-trip bought for nothing, at the worst possible moment (immediately after
 * a compaction, when the session is already paying to rebuild its context).
 *
 * WHAT THIS INSTALLER DELIBERATELY DOES NOT WRITE: a
 * `componentConfig.thread` block in justin-sdk.config.json. Both thread knobs
 * resolve DEFAULT ← user file ← project file, so seeding a project-level
 * `{enabled: false, startOnSessionStart: false}` would OUTRANK the user file —
 * Justin turns the feature on once, machine-wide, and every repo that ran this
 * installer would silently stay off, with the config that overrode him sitting
 * in a file he never edited. Installing the hook and choosing to arm it are two
 * decisions, and this one only installs. The hook is inert until both knobs are
 * true, so an accidental install costs one ~60ms process per session start and
 * says nothing.
 *
 * IN THE CORE PRESET since 2026-09-18 (epic home-base-dchjw D3, Justin's call).
 * It was withheld from every preset before that, because this hook writes to a
 * SHARED Dolt database (~/Dev/threads) on every session start and the cost of
 * installing it everywhere would be paid in lock contention by every other
 * session. What actually bounds that cost is the config, not the preset: the
 * hook is INERT unless BOTH componentConfig.thread.enabled and
 * .startOnSessionStart are true, and both default to false.
 *
 * Idempotent: re-running detects each existing hook by fingerprint and writes
 * nothing. The two are independent — a project that installed this before the
 * Stop hook existed gains only the Stop entry on a re-run.
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
import {sdkRun, sdkScript, upsertHookCommand} from './sdk-invocation';

/**
 * The SDK subcommand this hook runs. It — not any whole invocation — is what
 * identifies an already-installed hook in every spelling (dchjw.15 F1): a
 * hand-edited variant (a different bunx form, an absolute path to the CLI)
 * still counts as installed and is left alone rather than duplicated.
 */
const THREAD_START_SUBCOMMAND = 'thread start';

/** The command the hook runs. Matches the usage-check / time-check spelling. */
export const THREAD_START_HOOK_COMMAND = sdkRun(
  `${THREAD_START_SUBCOMMAND} --hook`,
);

/** The CURRENT spelling, for the component manifest's installed-evidence check. */
export const THREAD_START_HOOK_FINGERPRINT = sdkScript(THREAD_START_SUBCOMMAND);

/** The hook event this component registers. */
export const THREAD_HOOK_EVENT = 'SessionStart';

/** SessionStart sources this hook is wired to. See the file header. */
export const THREAD_HOOK_MATCHER = 'startup|resume';

/** The Stop hook's subcommand. Same rule as THREAD_START_SUBCOMMAND above. */
const THREAD_STOP_SUBCOMMAND = 'thread stop-check';

/** The command the Stop hook runs (home-base-p1uj.15). */
export const THREAD_STOP_HOOK_COMMAND = sdkRun(THREAD_STOP_SUBCOMMAND);

/** The CURRENT spelling, for the component manifest's installed-evidence check. */
export const THREAD_STOP_HOOK_FINGERPRINT = sdkScript(THREAD_STOP_SUBCOMMAND);

/** The second event. No matcher — see the file header. */
export const THREAD_STOP_HOOK_EVENT = 'Stop';

/**
 * Register one hook command under one event in a settings object.
 *
 * Hooks are ADDITIVE in Claude Code — several may be registered for one event
 * and all of them run — so this leaves every FOREIGN entry alone. Its own entry
 * it upserts: recognised by fingerprint, and its command string REWRITTEN when
 * it has changed spelling (D1), which is how a repo installed against an older
 * SDK moves forward instead of keeping the old form forever.
 *
 * Returns true when the object was modified, which is what makes a re-run with
 * nothing to change a no-op rather than a rewrite.
 */
function addHook(
  settings: Record<string, unknown>,
  spec: {
    command: string;
    event: string;
    matcher: string | null;
    subcommand: string;
  },
): boolean {
  const hooks = ((settings.hooks as Record<string, unknown> | undefined) ??
    {}) as Record<string, unknown>;
  const registered = (hooks[spec.event] as unknown[] | undefined) ?? [];

  const {changed, entries} = upsertHookCommand(
    registered,
    spec.subcommand,
    spec.command,
    () => {
      const entry: Record<string, unknown> = {
        hooks: [{command: spec.command, type: 'command'}],
      };
      if (spec.matcher != null) entry.matcher = spec.matcher;
      return entry;
    },
  );
  if (!changed) return false;

  hooks[spec.event] = entries;
  settings.hooks = hooks;
  return true;
}

export function addThreadStartHook(settings: Record<string, unknown>): boolean {
  return addHook(settings, {
    command: THREAD_START_HOOK_COMMAND,
    event: THREAD_HOOK_EVENT,
    matcher: THREAD_HOOK_MATCHER,
    subcommand: THREAD_START_SUBCOMMAND,
  });
}

export function addThreadStopHook(settings: Record<string, unknown>): boolean {
  return addHook(settings, {
    command: THREAD_STOP_HOOK_COMMAND,
    event: THREAD_STOP_HOOK_EVENT,
    matcher: null,
    subcommand: THREAD_STOP_SUBCOMMAND,
  });
}

export function stepThreadStartHook(projectRoot: string): boolean {
  const settingsDir = resolve(projectRoot, '.claude');
  const settingsPath = resolve(settingsDir, 'settings.json');
  ensureDir(settingsDir);

  const settings = (readJson(settingsPath) ?? {}) as Record<string, unknown>;
  const addedStart = addThreadStartHook(settings);
  const addedStop = addThreadStopHook(settings);

  if (!addedStart && !addedStop) {
    success('.claude/settings.json already has both thread hooks');
    return true;
  }

  writeJson(settingsPath, settings);
  if (addedStart) {
    success(
      `Updated .claude/settings.json (${THREAD_HOOK_EVENT} [${THREAD_HOOK_MATCHER}] → thread start)`,
    );
  }
  if (addedStop) {
    success(
      `Updated .claude/settings.json (${THREAD_STOP_HOOK_EVENT} → thread stop-check)`,
    );
  }
  return true;
}

export async function runThreadHooksSetup(args: {
  projectRoot: string;
  quiet: boolean;
  force?: boolean;
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
    fail('base-setup failed — cannot proceed with thread-hooks-setup');
    return baseExit;
  }
  // base-setup toggles quiet internally; restore our setting.
  setQuiet(quiet);
  success('base-setup ready');

  stepHeader(
    `1. .claude/settings.json (${THREAD_HOOK_EVENT}, ${THREAD_STOP_HOOK_EVENT})`,
  );
  if (!stepThreadStartHook(projectRoot)) return 1;

  if (!isQuiet()) {
    console.log(
      `\n\x1b[32m\x1b[1mthread-hooks-setup ready\x1b[0m in ${basename(projectRoot)}.\n` +
        'BOTH hooks are INERT until their knobs are true. Turn them on machine-wide\n' +
        'in ~/.config/justin-sdk/config.json:\n\n' +
        '  {"componentConfig": {"thread": {"enabled": true, "startOnSessionStart": true}}}\n\n' +
        'SessionStart (thread start) needs enabled AND startOnSessionStart.\n' +
        'Stop (thread stop-check) needs "enforce": true, and it is the one that can\n' +
        'refuse to let a session finish — arm it only once you have watched it pass.\n\n' +
        'No componentConfig block was written here on purpose: a project-level value\n' +
        'outranks the user file, so it would silently override those switches.\n',
    );
  }

  return 0;
}
