/**
 * thread-hooks-setup — installs the SessionStart hook that creates a session's
 * thread bead before it has reported anything (home-base-p1uj.3).
 *
 * Scaffolds exactly ONE thing in the consuming project: a `SessionStart` hook in
 * `.claude/settings.json`, matched to `startup|resume`, running
 * `bunx @justinhaaheim/justin-sdk thread start --hook`.
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
 * OPT-IN ONLY — same reasoning as usage-check, plus one of its own: this hook
 * writes to a SHARED Dolt database (~/Dev/life) on every session start, so the
 * cost of installing it everywhere is paid in lock contention by every other
 * session, not just by this repo. Excluded from `init` and the `all` preset (see
 * OPT_IN_ONLY in components.ts).
 *
 * Idempotent: re-running detects the existing hook by fingerprint and writes
 * nothing.
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

/** The command the hook runs. Matches the usage-check / time-check spelling. */
export const THREAD_START_HOOK_COMMAND =
  'bunx @justinhaaheim/justin-sdk thread start --hook';

/**
 * Substring identifying an already-installed hook, whatever its bunx spelling.
 *
 * Matched against the serialised event array, so a hand-edited variant (a
 * different bunx form, an absolute path to the CLI) still counts as installed
 * and is left alone rather than duplicated.
 */
export const THREAD_START_HOOK_FINGERPRINT = 'justin-sdk thread start';

/** The hook event this component registers. */
export const THREAD_HOOK_EVENT = 'SessionStart';

/** SessionStart sources this hook is wired to. See the file header. */
export const THREAD_HOOK_MATCHER = 'startup|resume';

/**
 * Register the hook command under SessionStart in a settings object.
 *
 * Hooks are ADDITIVE in Claude Code — several may be registered for one event
 * and all of them run — so this appends and leaves every existing entry alone.
 * Returns true when the object was modified, which is what makes a re-run a
 * no-op rather than a rewrite.
 */
export function addThreadStartHook(settings: Record<string, unknown>): boolean {
  const hooks = ((settings.hooks as Record<string, unknown> | undefined) ??
    {}) as Record<string, unknown>;
  const registered = (hooks[THREAD_HOOK_EVENT] as unknown[] | undefined) ?? [];

  if (JSON.stringify(registered).includes(THREAD_START_HOOK_FINGERPRINT)) {
    return false;
  }

  registered.push({
    hooks: [{command: THREAD_START_HOOK_COMMAND, type: 'command'}],
    matcher: THREAD_HOOK_MATCHER,
  });
  hooks[THREAD_HOOK_EVENT] = registered;
  settings.hooks = hooks;
  return true;
}

export function stepThreadStartHook(projectRoot: string): boolean {
  const settingsDir = resolve(projectRoot, '.claude');
  const settingsPath = resolve(settingsDir, 'settings.json');
  ensureDir(settingsDir);

  const settings = (readJson(settingsPath) ?? {}) as Record<string, unknown>;
  if (!addThreadStartHook(settings)) {
    success('.claude/settings.json already has the thread start hook');
    return true;
  }

  writeJson(settingsPath, settings);
  success(
    `Updated .claude/settings.json (${THREAD_HOOK_EVENT} [${THREAD_HOOK_MATCHER}] → thread start)`,
  );
  return true;
}

export async function runThreadHooksSetup(args: {
  projectRoot: string;
  quiet: boolean;
  force?: boolean;
}): Promise<number> {
  const {projectRoot, quiet} = args;
  setQuiet(quiet);

  stepHeader('0. base-setup (foundation layer)');
  const baseExit = await runBaseSetup({
    extraComponents: ['thread-hooks-setup'],
    projectRoot,
    quiet: true,
  });
  if (baseExit !== 0) {
    fail('base-setup failed — cannot proceed with thread-hooks-setup');
    return baseExit;
  }
  // base-setup toggles quiet internally; restore our setting.
  setQuiet(quiet);
  success('base-setup ready');

  stepHeader(`1. .claude/settings.json (${THREAD_HOOK_EVENT})`);
  if (!stepThreadStartHook(projectRoot)) return 1;

  if (!isQuiet()) {
    console.log(
      `\n\x1b[32m\x1b[1mthread-hooks-setup ready\x1b[0m in ${basename(projectRoot)}.\n` +
        'The hook is INERT until BOTH knobs are true. Turn them on machine-wide in\n' +
        '~/.config/justin-sdk/config.json:\n\n' +
        '  {"componentConfig": {"thread": {"enabled": true, "startOnSessionStart": true}}}\n\n' +
        'No componentConfig block was written here on purpose: a project-level value\n' +
        'outranks the user file, so it would silently override that switch.\n',
    );
  }

  return 0;
}
