/**
 * hook-entries-check — doctor's HOOK_ENTRIES check (home-base-rtsx1.3): do the
 * SDK hook entries in this repo's .claude/settings.json match what `install`
 * would write for its components and its hooks.dispatch mode?
 *
 * Justin, 2026-10-17: "I think it's fine to just report the discrepancy, but we
 * also need to have tooling that fixes this in bulk via a justin-sdk sweep of
 * some kind." So this REPORTS and never writes, and its fix names both repairs:
 * `install` for this repo and `sweep --component install` for every enrolled
 * repo (verified by dry run on ~/Dev/prompts, 2026-10-17: "install: would apply
 * 12 component(s)", thread-hooks among them, which adds its missing nudge).
 *
 * Useful in BOTH modes, and today: two enrolled repos pinned at v0.42.0 lack
 * the thread nudge entry and nothing said so.
 *
 * WHAT IT FINDS, per dispatched event:
 *  - RUNS TWICE (error): a handler that more than one entry would run — its own
 *    entry (exact or hand-edited) plus the dispatcher, or two of its own. This
 *    is the one failure that does visible damage every turn.
 *  - MISSING (warn): an entry `install` would write that is not there.
 *  - STALE (warn): an entry from the other mode (a handler with its own entry
 *    while dispatch is on, or run by the dispatcher while it is off), a
 *    dispatcher entry with the wrong matcher, or a dispatcher entry in the
 *    RETIRED spelling (home-base-rtsx1.6): it still runs the handlers, so alone
 *    it is a warning; beside the current entry it is a RUNS TWICE error.
 *  - EXTRA (warn): a dispatcher entry that runs no handler for this repo.
 *  - DEAD (error, dispatch mode only): the dispatcher entry itself does not run.
 *    Carried from home-base-nlho as a DRY RUN: `hook <Event> --dry-run` resolves
 *    the config and lists handlers, spawning none, so doctor — which runs at
 *    every session start — never records a fake message or fires a marker.
 *
 * UNKNOWN IS NOT CLEAN (critical rule 7): a settings.json or config that cannot
 * be read is `cannot-check`, never "no hooks".
 */

import {spawnSync} from 'child_process';
import {existsSync, readFileSync} from 'fs';
import {join} from 'path';

import {resolveComponents} from './component-registry';
import {
  allKnobsOff,
  describeHookKnob,
  type HandlersByKnob,
  hookDispatchEnabled,
} from './hook-entries';
import {
  dispatchCommand,
  DISPATCHED_EVENTS,
  type DispatchedEvent,
  dispatchMatcher,
  isDispatchCommand,
  retiredDispatchCommand,
} from './hook-registry';
import {invokesSdk, sdkRun, sdkRunArgv} from './sdk-invocation';

export type HookEntriesMode = 'dispatch' | 'per-handler';

export type HookEntriesReport =
  | {kind: 'cannot-check'; reason: string}
  | {
      dead: string[];
      doubleRuns: string[];
      extra: string[];
      kind: 'checked';
      /** How many SDK hook entries matched what install writes. */
      matched: number;
      missing: string[];
      mode: HookEntriesMode;
      stale: string[];
    };

/** What `hook <Event> --dry-run` did. Injectable so tests spawn nothing. */
export type DryRun = (
  event: DispatchedEvent,
  projectRoot: string,
) => {exitCode: number | null; stdout: string};

/**
 * The real dry run: the repo's own SDK, resolved as the hook entry resolves it.
 * The entry runs `bun run --cwd "${CLAUDE_PROJECT_DIR:-.}" justin-sdk`; with cwd
 * and CLAUDE_PROJECT_DIR both the project root, plain `bun run justin-sdk` here
 * resolves from the same directory (home-base-rtsx1.6).
 */
const realDryRun: DryRun = (event, projectRoot) => {
  const [bin, ...args] = sdkRunArgv(['hook', event, '--dry-run']);
  const result = spawnSync(bin ?? 'bun', args, {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: projectRoot,
      JUSTIN_SDK_HEALTH_NOTICES: 'off',
    },
    input: '',
    timeout: 20_000,
  });
  return {exitCode: result.status, stdout: result.stdout ?? ''};
};

interface Entry {
  commands: string[];
  matcher: string | null;
}

function entriesFor(settings: Record<string, unknown>, event: string): Entry[] {
  const hooks = settings.hooks as Record<string, unknown> | undefined;
  const value = hooks?.[event];
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): Entry[] => {
    if (entry == null || typeof entry !== 'object') return [];
    const {hooks: inner, matcher} = entry as {
      hooks?: unknown;
      matcher?: unknown;
    };
    if (!Array.isArray(inner)) return [];
    return [
      {
        commands: inner
          .map((hook) => (hook as {command?: unknown} | null)?.command)
          .filter((c): c is string => typeof c === 'string'),
        matcher: typeof matcher === 'string' ? matcher : null,
      },
    ];
  });
}

export function checkSdkHookEntries(
  projectRoot: string,
  options: {
    /**
     * Which knobs are on here: hook-knobs.ts handlersByKnob, which the caller
     * loads with `await import` (it reaches zod). Absent: every knob off.
     */
    byKnob?: HandlersByKnob;
    dryRun?: DryRun;
  } = {},
): HookEntriesReport {
  const settingsPath = join(projectRoot, '.claude', 'settings.json');
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(settingsPath, 'utf8'));
      if (
        parsed == null ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed)
      ) {
        return {
          kind: 'cannot-check',
          reason: `${settingsPath} is not a JSON object`,
        };
      }
      settings = parsed as Record<string, unknown>;
    } catch (error) {
      return {
        kind: 'cannot-check',
        reason: `could not read ${settingsPath} (${error instanceof Error ? error.message : String(error)})`,
      };
    }
  }

  const configPath = join(projectRoot, 'justin-sdk.config.json');
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    return {
      kind: 'cannot-check',
      reason: `could not read ${configPath} (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  const resolved = resolveComponents(config, projectRoot);
  if (!resolved.ok) return {kind: 'cannot-check', reason: resolved.reason};

  const mode: HookEntriesMode = hookDispatchEnabled(projectRoot)
    ? 'dispatch'
    : 'per-handler';
  // A handler whose knob is off here (hook-knobs.ts, home-base-mbnjv.5) is
  // expected NOWHERE: install writes no entry for it and takes back its own.
  const byKnob = options.byKnob ?? allKnobsOff();
  const handlers = byKnob.enabled.filter((h) =>
    resolved.components.includes(h.component),
  );
  const knobOff = byKnob.disabled.filter((h) =>
    resolved.components.includes(h.component),
  );

  const report = {
    dead: [] as string[],
    doubleRuns: [] as string[],
    extra: [] as string[],
    kind: 'checked' as const,
    matched: 0,
    missing: [] as string[],
    mode,
    stale: [] as string[],
  };
  const presentDispatchers: DispatchedEvent[] = [];

  for (const event of DISPATCHED_EVENTS) {
    const entries = entriesFor(settings, event);
    const dispatcher = dispatchCommand(event);
    const retired = retiredDispatchCommand(event);
    const dispatcherEntry = entries.find((e) =>
      e.commands.includes(dispatcher),
    );
    // Every dispatcher command under this event, in either spelling, once per
    // occurrence: each one runs every dispatched handler (home-base-rtsx1.6).
    const dispatcherRuns = entries.flatMap((e) =>
      e.commands.filter((c) => isDispatchCommand(event, c)),
    );
    const needed = handlers.filter((h) =>
      h.events.some((e) => e.event === event),
    );

    if (dispatcherRuns.includes(retired)) {
      report.stale.push(
        `${event}: stale dispatcher entry \`${retired}\` (runs the SDK of whatever checkout the session is in, and loses every hook in an older one): run \`${sdkRun('install')}\``,
      );
    }

    if (dispatcherRuns.length > 0) presentDispatchers.push(event);
    const offHere = knobOff.filter((h) =>
      h.events.some((e) => e.event === event),
    );
    for (const handler of offHere) {
      for (const own of entries.flatMap((e) =>
        e.commands.filter((c) => c === handler.command),
      )) {
        report.extra.push(
          `${event}: \`${own}\` is installed, but ${describeHookKnob(handler.knob)} is off here`,
        );
      }
    }
    if (dispatcherRuns.length > 0 && needed.length === 0) {
      report.extra.push(
        offHere.length > 0
          ? `${event}: \`${dispatcherRuns[0] ?? dispatcher}\` runs only ${offHere.map((h) => h.id).join(', ')}, and ${offHere.map((h) => describeHookKnob(h.knob)).join(', ')} is off here`
          : `${event}: \`${dispatcherRuns[0] ?? dispatcher}\` runs no handler for this repo's components`,
      );
    } else if (dispatcherEntry != null) {
      if (mode === 'dispatch') {
        const want = dispatchMatcher(event);
        if (dispatcherEntry.matcher !== want) {
          report.stale.push(
            `${event}: the dispatcher entry's matcher is ${dispatcherEntry.matcher ?? 'none'}; install writes ${want ?? 'none'}`,
          );
        } else {
          report.matched += 1;
        }
      }
    } else if (
      mode === 'dispatch' &&
      needed.length > 0 &&
      // A retired-spelling entry is not missing: it is reported stale above.
      dispatcherRuns.length === 0
    ) {
      report.missing.push(`${event}: \`${dispatcher}\``);
    }

    for (const handler of needed) {
      const own = entries.flatMap((e) =>
        e.commands.filter(
          (c) =>
            c === handler.command ||
            (!isDispatchCommand(event, c) &&
              invokesSdk(c) &&
              c.includes(handler.id)),
        ),
      );
      const runs = own.length + dispatcherRuns.length;
      if (runs > 1) {
        report.doubleRuns.push(
          `${event}: ${handler.id} runs ${runs} times (${[
            ...own,
            ...dispatcherRuns,
          ]
            .map((c) => `\`${c}\``)
            .join(', ')})`,
        );
        continue;
      }
      if (runs === 0) {
        if (mode === 'per-handler') {
          report.missing.push(`${event}: \`${handler.command}\``);
        }
        continue;
      }
      if (mode === 'dispatch' && own.length === 1) {
        report.stale.push(
          `${event}: ${handler.id} has its own entry (\`${own[0]}\`); with hooks.dispatch on, \`${dispatcher}\` should run it`,
        );
      } else if (mode === 'per-handler' && dispatcherRuns.length > 0) {
        report.stale.push(
          `${event}: ${handler.id} runs from \`${dispatcherRuns[0] ?? dispatcher}\` although hooks.dispatch is off`,
        );
      } else if (mode === 'per-handler' && own[0] === handler.command) {
        report.matched += 1;
      }
      // Otherwise a hand-edited spelling in per-handler mode: it runs once, so
      // there is nothing to repair, but it is not what install writes either,
      // so it is not counted as matched.
    }
  }

  // DEAD: does the dispatcher entry run at all? One dry run proves the path
  // from settings.json through `bun run justin-sdk` to the dispatcher; the
  // plan it prints is the same code every event uses.
  const probe = presentDispatchers[0];
  if (mode === 'dispatch' && probe != null) {
    const result = (options.dryRun ?? realDryRun)(probe, projectRoot);
    let ok = false;
    let reason = `exit ${result.exitCode ?? 'none'}`;
    try {
      const body = JSON.parse(result.stdout) as {
        ok?: unknown;
        reason?: unknown;
      };
      ok = result.exitCode === 0 && body.ok === true;
      if (typeof body.reason === 'string') reason = body.reason;
    } catch {
      reason = `${reason}, and its output is not JSON`;
    }
    if (!ok) {
      report.dead.push(
        `\`${dispatchCommand(probe)} --dry-run\` failed (${reason}), so no dispatched handler runs here`,
      );
    }
  }

  return report;
}

/** The repairs, named for this repo and for the fleet (Justin, 2026-10-17). */
export const HOOK_ENTRIES_FIX =
  'Run `bun run justin-sdk install` here, or `bun run justin-sdk sweep --component install` to repair every enrolled repo. A hand-edited entry that runs twice is yours to delete: install never removes what it did not write.';
