/**
 * thread-hooks-setup — installs the thread hooks in a consuming project.
 *
 * Scaffolds exactly THREE entries in `.claude/settings.json`:
 *
 *  - `UserPromptSubmit` and `Stop` (no matcher) → `thread capture`, which logs
 *    every prompt and every Claude yield and keeps the thread bead's last
 *    messages current (home-base-k0b8n.9, K10). The session's FIRST captured
 *    prompt is also what CREATES its thread bead (home-base-39co9 D1), so a
 *    session that is opened and never prompted leaves no thread.
 *  - `Stop` (no matcher) → `thread stop-check`, which refuses to let a session
 *    finish on a status report it cannot prove was recorded (home-base-p1uj.15).
 *    Its own entry on Stop, beside capture's rather than inside it: the two
 *    have different knobs and different contracts (K10 anti-decision 1).
 *
 * THE RETIRED FOURTH ENTRY (home-base-39co9 D3, 2026-10-05). Until then this
 * also wrote `SessionStart` [startup|resume] → `thread start --hook`, which
 * created a thread bead for every session that was merely OPENED. Justin:
 * "Otherwise any session I open creates a thread, and there is no reason to do
 * this on session start". It is retired in three layers:
 *
 *   1. `thread start --hook` is INERT in the SDK itself, so a repo that still
 *      carries the entry stops creating threads with the pin bump alone.
 *   2. This installer no longer writes it.
 *   3. On re-apply it REMOVES the entry, but only when the command is
 *      byte-identical to what it used to write (`THREAD_START_HOOK_COMMAND`) —
 *      the identity rule `remove` follows (F7). Any other command that runs
 *      `thread start` is somebody's edit: it is reported as `left in place
 *      (modified)` and kept. Both lines print even in quiet mode, because a
 *      deletion nobody sees is the failure F7 exists to prevent.
 *
 * Layer 3 does not contradict "install NEVER removes" (dchjw.17 F1). That rule
 * is about whole COMPONENTS the config does not list, judged on generic
 * evidence. This is a listed component re-applying itself and taking back one
 * entry it can prove it wrote — the same migration base-setup already performs
 * on the retired setup-env SessionStart entry (`upsertSessionStartHook`).
 *
 * WHY THE STOP HOOK TAKES NO MATCHER: `Stop` has no matcher dimension — it fires
 * once per turn end, for main sessions and subagents alike, and the hook's own
 * first two tests (the `enforce` knob, then `agent_id`) are what narrow it. A
 * matcher string here would be silently ignored rather than helpfully restrictive.
 *
 * WHAT THIS INSTALLER DELIBERATELY DOES NOT WRITE: a
 * `componentConfig.thread` block in justin-sdk.config.json. The thread knobs
 * resolve DEFAULT ← user file ← project file, so seeding a project-level
 * `{enabled: false}` would OUTRANK the user file — Justin turns the feature on
 * once, machine-wide, and every repo that ran this installer would silently
 * stay off, with the config that overrode him sitting in a file he never
 * edited. Installing the hooks and choosing to arm them are two decisions, and
 * this one only installs. Every hook here is inert until
 * `componentConfig.thread.enabled` is true (stop-check also needs `.enforce`),
 * so an accidental install costs a short-lived process per prompt and per turn
 * end, and says nothing.
 *
 * IN THE CORE PRESET since 2026-09-18 (epic home-base-dchjw D3, Justin's call).
 * It was withheld from every preset before that, because the retired
 * SessionStart hook wrote to a SHARED Dolt database (~/Dev/threads) on every
 * session start. What actually bounds the cost is the config, not the preset:
 * `componentConfig.thread.enabled` defaults to false.
 *
 * Idempotent: re-running detects each existing hook by fingerprint and writes
 * nothing. The hooks are independent — a project that installed this before
 * the Stop hook existed gains only the Stop entry on a re-run.
 */

import {basename, resolve} from 'path';

import {runBaseSetup} from './base-setup';
import {
  invokesSdk,
  sdkRun,
  sdkScript,
  upsertHookCommand,
} from './sdk-invocation';
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

/**
 * The RETIRED hook's subcommand (home-base-39co9 D3). It — not any whole
 * invocation — is what recognises the retired entry in every spelling
 * (dchjw.15 F1), so a hand-edited variant is REPORTED rather than silently
 * skipped. Recognising is all it does: only `THREAD_START_HOOK_COMMAND`,
 * byte for byte, is ever removed.
 */
const THREAD_START_SUBCOMMAND = 'thread start';

/**
 * RETIRED (home-base-39co9 D3): the exact command this installer wrote under
 * SessionStart until 2026-10-05. It is no longer written. It is kept as the
 * IDENTITY that a re-apply here and `remove thread-hooks` delete on.
 */
export const THREAD_START_HOOK_COMMAND = sdkRun(
  `${THREAD_START_SUBCOMMAND} --hook`,
);

/** RETIRED: the retired entry's fingerprint, for the manifest's `retiredHooks`. */
export const THREAD_START_HOOK_FINGERPRINT = sdkScript(THREAD_START_SUBCOMMAND);

/** RETIRED: the event the retired entry lives under. */
export const THREAD_START_HOOK_EVENT = 'SessionStart';

/** The Stop hook's subcommand. Same identity rule as THREAD_START_SUBCOMMAND. */
const THREAD_STOP_SUBCOMMAND = 'thread stop-check';

/** The command the Stop hook runs (home-base-p1uj.15). */
export const THREAD_STOP_HOOK_COMMAND = sdkRun(THREAD_STOP_SUBCOMMAND);

/** The CURRENT spelling, for the component manifest's installed-evidence check. */
export const THREAD_STOP_HOOK_FINGERPRINT = sdkScript(THREAD_STOP_SUBCOMMAND);

/** The second event. No matcher — see the file header. */
export const THREAD_STOP_HOOK_EVENT = 'Stop';

/**
 * The capture subcommand (home-base-k0b8n.9, K10). ONE command on TWO events —
 * it reads `hook_event_name` from its payload — so the same identity rule finds
 * it under either event, and it never collides with `thread stop-check`, which
 * shares the Stop event but not the subcommand.
 */
const THREAD_CAPTURE_SUBCOMMAND = 'thread capture';

/** The command both capture hooks run. */
export const THREAD_CAPTURE_HOOK_COMMAND = sdkRun(THREAD_CAPTURE_SUBCOMMAND);

/** The CURRENT spelling, for the component manifest's installed-evidence check. */
export const THREAD_CAPTURE_HOOK_FINGERPRINT = sdkScript(
  THREAD_CAPTURE_SUBCOMMAND,
);

/**
 * The two events capture records. Neither takes a matcher: UserPromptSubmit and
 * Stop have no matcher dimension (see the Stop note in the file header).
 */
export const THREAD_CAPTURE_HOOK_EVENTS = ['UserPromptSubmit', 'Stop'] as const;

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
  const hooks = (settings.hooks as Record<string, unknown> | undefined) ?? {};
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

export function addThreadStopHook(settings: Record<string, unknown>): boolean {
  return addHook(settings, {
    command: THREAD_STOP_HOOK_COMMAND,
    event: THREAD_STOP_HOOK_EVENT,
    matcher: null,
    subcommand: THREAD_STOP_SUBCOMMAND,
  });
}

/**
 * Register `thread capture` on UserPromptSubmit AND Stop (K10). Returns the
 * events it changed, empty when both were already there in today's spelling.
 */
export function addThreadCaptureHooks(
  settings: Record<string, unknown>,
): string[] {
  const changed: string[] = [];
  for (const event of THREAD_CAPTURE_HOOK_EVENTS) {
    const added = addHook(settings, {
      command: THREAD_CAPTURE_HOOK_COMMAND,
      event,
      matcher: null,
      subcommand: THREAD_CAPTURE_SUBCOMMAND,
    });
    if (added) changed.push(event);
  }
  return changed;
}

/**
 * What re-applying did to one SessionStart command that runs `thread start`.
 * The same two verdicts, spelled the same way, as `remove` prints (remove.ts).
 */
export type RetiredStartHookOutcome =
  | {command: string; kind: 'modified'}
  | {command: string; kind: 'removed'};

/**
 * Take the RETIRED SessionStart `thread start --hook` entry back out
 * (home-base-39co9 D3), editing `settings` in place.
 *
 * BY IDENTITY, NEVER BY NAME (F7). A command byte-identical to
 * `THREAD_START_HOOK_COMMAND` is removed — the inner hook only, so a foreign
 * command bundled into the same entry survives in place, and an entry left
 * with no hooks is dropped. Any OTHER command that runs the SDK's `thread
 * start` (an absolute path, an older `bunx` spelling, `… && my-own-thing`) is
 * reported `modified` and left exactly where it is. Commands that are not this
 * hook at all are untouched and not mentioned.
 *
 * The event key is deleted when its array empties, and `hooks` when it does,
 * mirroring remove.ts, so the file does not keep an empty `SessionStart: []`.
 */
export function removeRetiredThreadStartHook(
  settings: Record<string, unknown>,
): RetiredStartHookOutcome[] {
  const hooks = settings.hooks;
  if (hooks == null || typeof hooks !== 'object' || Array.isArray(hooks)) {
    return [];
  }
  const byEvent = hooks as Record<string, unknown>;
  const entries = byEvent[THREAD_START_HOOK_EVENT];
  if (!Array.isArray(entries)) return [];

  const outcomes: RetiredStartHookOutcome[] = [];
  let removedAny = false;
  const nextEntries: unknown[] = [];
  for (const entry of entries) {
    const inner =
      entry != null && typeof entry === 'object'
        ? (entry as {hooks?: unknown}).hooks
        : undefined;
    if (!Array.isArray(inner)) {
      nextEntries.push(entry);
      continue;
    }
    const kept = inner.filter((hook) => {
      const command = (hook as {command?: unknown} | null)?.command;
      if (typeof command !== 'string') return true;
      if (command === THREAD_START_HOOK_COMMAND) {
        outcomes.push({command, kind: 'removed'});
        return false;
      }
      if (invokesSdk(command) && command.includes(THREAD_START_SUBCOMMAND)) {
        outcomes.push({command, kind: 'modified'});
      }
      return true;
    });
    if (kept.length === inner.length) {
      nextEntries.push(entry);
      continue;
    }
    removedAny = true;
    if (kept.length > 0) nextEntries.push({...(entry as object), hooks: kept});
  }

  if (removedAny) {
    if (nextEntries.length === 0) {
      delete byEvent[THREAD_START_HOOK_EVENT];
    } else {
      byEvent[THREAD_START_HOOK_EVENT] = nextEntries;
    }
    if (Object.keys(byEvent).length === 0) delete settings.hooks;
  }
  return outcomes;
}

/** One line per outcome, in remove.ts's wording, so both commands read alike. */
export function describeRetiredStartHookOutcome(
  outcome: RetiredStartHookOutcome,
): string {
  const what = `.claude/settings.json ${THREAD_START_HOOK_EVENT} hook (${outcome.command})`;
  return outcome.kind === 'removed'
    ? `removed: ${what} — retired; the thread bead is now created on the first prompt (home-base-39co9)`
    : `left in place (modified): ${what} — not the exact command the SDK wrote, so it is yours to delete; \`thread start --hook\` is inert either way`;
}

export function stepThreadHooks(projectRoot: string): boolean {
  const settingsDir = resolve(projectRoot, '.claude');
  const settingsPath = resolve(settingsDir, 'settings.json');
  ensureDir(settingsDir);

  const settings = readJson(settingsPath) ?? {};
  const retired = removeRetiredThreadStartHook(settings);
  const removedRetired = retired.some((outcome) => outcome.kind === 'removed');
  const addedStop = addThreadStopHook(settings);
  const addedCapture = addThreadCaptureHooks(settings);

  if (removedRetired || addedStop || addedCapture.length > 0) {
    writeJson(settingsPath, settings);
  }

  // NOT through success(): these print even in quiet mode, which is how every
  // installer runs under `install`, `update` and the sweep. A deletion is the
  // one thing an installer must never do silently.
  for (const outcome of retired) {
    console.log(`  ${describeRetiredStartHookOutcome(outcome)}`);
  }

  if (!removedRetired && !addedStop && addedCapture.length === 0) {
    success('.claude/settings.json already has every thread hook');
    return true;
  }
  if (addedStop) {
    success(
      `Updated .claude/settings.json (${THREAD_STOP_HOOK_EVENT} → thread stop-check)`,
    );
  }
  for (const event of addedCapture) {
    success(`Updated .claude/settings.json (${event} → thread capture)`);
  }
  return true;
}

export async function runThreadHooksSetup(args: {
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
    fail('base-setup failed — cannot proceed with thread-hooks-setup');
    return baseExit;
  }
  // base-setup toggles quiet internally; restore our setting.
  setQuiet(quiet);
  success('base-setup ready');

  stepHeader(
    `1. .claude/settings.json (${THREAD_CAPTURE_HOOK_EVENTS.join(', ')} capture, ${THREAD_STOP_HOOK_EVENT} stop-check; retired ${THREAD_START_HOOK_EVENT} entry)`,
  );
  if (!stepThreadHooks(projectRoot)) return 1;

  if (!isQuiet()) {
    console.log(
      `\n\x1b[32m\x1b[1mthread-hooks-setup ready\x1b[0m in ${basename(projectRoot)}.\n` +
        'The hooks are INERT until their knobs are true. Turn them on machine-wide\n' +
        'in ~/.config/justin-sdk/config.json:\n\n' +
        '  {"componentConfig": {"thread": {"enabled": true}}}\n\n' +
        'UserPromptSubmit + Stop (thread capture) need only "enabled": true — "capture"\n' +
        "defaults on; set it false in one repo to opt that repo out. The session's\n" +
        'thread bead is created on its FIRST PROMPT; nothing happens at SessionStart.\n' +
        'Stop (thread stop-check) needs "enforce": true, and it is the one that can\n' +
        'refuse to let a session finish — arm it only once you have watched it pass.\n' +
        '"startOnSessionStart" is DEPRECATED and does nothing; delete it if you have it.\n\n' +
        'No componentConfig block was written here on purpose: a project-level value\n' +
        'outranks the user file, so it would silently override those switches.\n',
    );
  }

  return 0;
}
