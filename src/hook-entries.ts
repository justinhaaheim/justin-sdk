/**
 * hook-entries — the settings.json side of hook dispatch (home-base-rtsx1.2).
 *
 * The ONE place that knows what dispatch mode looks like on disk, so every
 * installer and every reader asks here instead of growing its own idea of it.
 *
 * THE KNOB (feature-knobs rule): `hooks.dispatch` in a repo's
 * justin-sdk.config.json, DEFAULT TRUE (home-base-rtsx1.7, Justin 2026-10-24:
 * "fix the shit, then roll it out"). Absent means ON. `"hooks": {"dispatch":
 * false}` means OFF, and off is the per-handler behaviour byte for byte. A
 * config that is missing or cannot be read also means OFF: per-handler entries
 * work with every SDK version, so they are the cautious mode when the knob
 * cannot be read. Each installer branches at its call site: on →
 * `applyDispatchForComponent`, off → its own per-handler upsert plus
 * `removeDispatchEntriesForComponent`.
 *
 * BY IDENTITY, NEVER BY NAME (constraint F7, as `remove` does it). An entry is
 * written or taken back only when its command is EXACTLY the one the SDK writes:
 * a dispatcher entry is `dispatchCommand(event)`, a per-handler entry is
 * `handler.command`. Anything else that merely runs the same handler — an
 * absolute path, `… && my-own-thing` — is somebody's edit, so it is left in
 * place and reported, loudly, because with dispatch on it runs TWICE.
 *
 * TWO GENERATIONS OF DISPATCHER ENTRY (home-base-rtsx1.6). The SDK also wrote
 * `retiredDispatchCommand(event)`, which resolved the SDK from the session's
 * current directory. It is SDK-written, so it is matched exactly like the
 * current one: install rewrites it IN PLACE (appending would run every handler
 * twice), the dispatch-off path takes it back, and hasDispatchEntry accepts it.
 *
 * A LEAF apart from the registry and the invocation vocabulary, so the
 * dispatcher's hot path and the session-start path can use it without pulling
 * in an installer.
 */

import {existsSync, readFileSync} from 'fs';
import {join} from 'path';

import {
  dispatchCommand,
  DISPATCHED_EVENTS,
  type DispatchedEvent,
  dispatchMatcher,
  HOOK_HANDLERS,
  type HookHandler,
  isDispatchCommand,
  isDispatchedEvent,
  retiredDispatchCommand,
} from './hook-registry';
import {invokesSdk} from './sdk-invocation';

/**
 * What an absent `hooks.dispatch` means (home-base-rtsx1.7). The schema
 * printer (`justin-sdk config schema`) shows it as the key's default, so the
 * printed default and the behaviour cannot drift apart.
 */
export const HOOK_DISPATCH_DEFAULT = true;

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Is hook dispatch switched on in this repo's justin-sdk.config.json?
 *
 * DEFAULT TRUE (home-base-rtsx1.7): a config with no `hooks` key, a `hooks`
 * object with no `dispatch` key, and `dispatch: true` are ON. Everything else
 * is OFF, because per-handler entries work with every SDK version and so are
 * the cautious mode whenever the knob cannot be read: no config file, one that
 * does not parse, one that is not a JSON object, an explicit `dispatch: false`,
 * and a `hooks` or `dispatch` value of the wrong type (the schema would reject
 * it, so it is unreadable, not absent).
 */
export function hookDispatchEnabled(projectRoot: string): boolean {
  const path = join(projectRoot, 'justin-sdk.config.json');
  if (!existsSync(path)) return false;
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return false;
  }
  if (!isJsonObject(config)) return false;
  const hooks = config.hooks;
  if (hooks === undefined) return HOOK_DISPATCH_DEFAULT;
  if (!isJsonObject(hooks)) return false;
  const dispatch = hooks.dispatch;
  if (dispatch === undefined) return HOOK_DISPATCH_DEFAULT;
  return dispatch === true;
}

interface SettingsHook {
  [key: string]: unknown;
  command?: unknown;
}

interface SettingsEntry {
  [key: string]: unknown;
  hooks?: unknown;
  matcher?: unknown;
}

/** settings.hooks as a mutable record, created when absent. */
function hooksOf(settings: Record<string, unknown>): Record<string, unknown> {
  const existing = settings.hooks;
  if (
    existing != null &&
    typeof existing === 'object' &&
    !Array.isArray(existing)
  ) {
    return existing as Record<string, unknown>;
  }
  const created: Record<string, unknown> = {};
  settings.hooks = created;
  return created;
}

function entriesOf(
  settings: Record<string, unknown>,
  event: string,
): unknown[] {
  const value = (settings.hooks as Record<string, unknown> | undefined)?.[
    event
  ];
  return Array.isArray(value) ? value : [];
}

function commandsOf(entry: unknown): string[] {
  if (entry == null || typeof entry !== 'object') return [];
  const inner = (entry as SettingsEntry).hooks;
  if (!Array.isArray(inner)) return [];
  return inner
    .map((hook) => (hook as SettingsHook | null)?.command)
    .filter((command): command is string => typeof command === 'string');
}

/**
 * Does `settings` carry the exact dispatcher entry for this event, in either
 * generation? Both run the dispatched handlers, so session-start's arming and
 * component evidence must count both (home-base-rtsx1.6).
 */
export function hasDispatchEntry(
  settings: Record<string, unknown>,
  event: DispatchedEvent,
): boolean {
  return entriesOf(settings, event).some((entry) =>
    commandsOf(entry).some((command) => isDispatchCommand(event, command)),
  );
}

/** The events a component's handlers run on, in DISPATCHED_EVENTS order. */
export function eventsForComponent(
  component: string,
  handlers: readonly HookHandler[] = HOOK_HANDLERS,
): DispatchedEvent[] {
  const events = new Set<DispatchedEvent>();
  for (const handler of handlers) {
    if (handler.component !== component) continue;
    for (const {event} of handler.events) events.add(event);
  }
  return DISPATCHED_EVENTS.filter((event) => events.has(event));
}

/**
 * Remove every inner hook under `event` whose command satisfies `drop`,
 * dropping entries left empty and the event key when it empties. Returns the
 * commands removed.
 */
function removeCommands(
  settings: Record<string, unknown>,
  event: string,
  drop: (command: string) => boolean,
): string[] {
  const hooks = settings.hooks as Record<string, unknown> | undefined;
  const entries = hooks?.[event];
  if (hooks == null || !Array.isArray(entries)) return [];

  const removed: string[] = [];
  const next: unknown[] = [];
  for (const entry of entries) {
    const inner =
      entry != null && typeof entry === 'object'
        ? (entry as SettingsEntry).hooks
        : undefined;
    if (!Array.isArray(inner)) {
      next.push(entry);
      continue;
    }
    const kept = inner.filter((hook) => {
      const command = (hook as SettingsHook | null)?.command;
      if (typeof command === 'string' && drop(command)) {
        removed.push(command);
        return false;
      }
      return true;
    });
    if (kept.length === inner.length) next.push(entry);
    else if (kept.length > 0) next.push({...(entry as object), hooks: kept});
  }
  if (removed.length === 0) return [];
  if (next.length === 0) delete hooks[event];
  else hooks[event] = next;
  return removed;
}

/** What switching one component to (or keeping it in) dispatch mode did. */
export interface DispatchApplyOutcome {
  /** Events whose dispatcher entry was added, or its matcher corrected. */
  added: DispatchedEvent[];
  changed: boolean;
  /** Hand-edited per-handler entries left in place: they now run twice. */
  modified: {command: string; event: string}[];
  /**
   * Entries taken back: per-handler entries the dispatcher now runs, and a
   * retired-spelling dispatcher entry found BESIDE the current one.
   */
  removed: {command: string; event: string}[];
  /**
   * Events whose retired-spelling dispatcher entry was rewritten in place to
   * the current command, its matcher corrected if wrong (home-base-rtsx1.6).
   */
  rewritten: DispatchedEvent[];
}

/**
 * Turn the first retired-spelling dispatcher command under `event` into the
 * current one, IN PLACE: the entry keeps its position, its other keys and any
 * foreign hooks beside the command. Returns the rewritten entry (now in
 * `settings`), or null when there was no retired spelling to rewrite.
 */
function rewriteRetiredDispatchEntry(
  settings: Record<string, unknown>,
  event: DispatchedEvent,
): SettingsEntry | null {
  const retired = retiredDispatchCommand(event);
  const entries = entriesOf(settings, event);
  const index = entries.findIndex((entry) =>
    commandsOf(entry).includes(retired),
  );
  if (index < 0) return null;
  const old = entries[index] as SettingsEntry;
  const inner = Array.isArray(old.hooks) ? (old.hooks as unknown[]) : [];
  let replaced = false;
  const rewritten: SettingsEntry = {
    ...old,
    hooks: inner.map((hook) => {
      // Only the FIRST occurrence: a second copy of the retired command in the
      // same entry would become a second copy of the current one. The caller
      // takes any later copy back by exact match.
      if (replaced || (hook as SettingsHook | null)?.command !== retired) {
        return hook;
      }
      replaced = true;
      return {...(hook as SettingsHook), command: dispatchCommand(event)};
    }),
  };
  hooksOf(settings)[event] = entries.map((entry, i) =>
    i === index ? rewritten : entry,
  );
  return rewritten;
}

/**
 * Dispatch ON for one component: make sure each event its handlers use has the
 * dispatcher entry (with the right matcher), and take back each of its
 * per-handler entries by identity. Edits `settings` in place.
 *
 * A retired-spelling dispatcher entry (home-base-rtsx1.6) is rewritten in place
 * when the event has no current one, and taken back when it sits beside one,
 * so an event always ends with exactly one dispatcher entry.
 */
export function applyDispatchForComponent(
  settings: Record<string, unknown>,
  component: string,
  handlers: readonly HookHandler[] = HOOK_HANDLERS,
): DispatchApplyOutcome {
  const outcome: DispatchApplyOutcome = {
    added: [],
    changed: false,
    modified: [],
    removed: [],
    rewritten: [],
  };

  for (const event of eventsForComponent(component, handlers)) {
    const command = dispatchCommand(event);
    const matcher = dispatchMatcher(event, handlers);
    const hooks = hooksOf(settings);
    const entries = entriesOf(settings, event);
    let existing = entries.find((entry) =>
      commandsOf(entry).includes(command),
    ) as SettingsEntry | undefined;
    let rewritten = false;
    if (existing == null) {
      const replaced = rewriteRetiredDispatchEntry(settings, event);
      if (replaced != null) {
        existing = replaced;
        rewritten = true;
        outcome.rewritten.push(event);
      }
    }
    if (existing == null) {
      const entry: SettingsEntry = {hooks: [{command, type: 'command'}]};
      if (matcher != null) entry.matcher = matcher;
      hooks[event] = [...entries, entry];
      outcome.added.push(event);
    } else if ((existing.matcher ?? null) !== matcher) {
      if (matcher == null) delete existing.matcher;
      else existing.matcher = matcher;
      // A rewrite already reports this event; the matcher is part of it.
      if (!rewritten) outcome.added.push(event);
    }
    // Whatever retired spelling is still here sits BESIDE the current entry
    // and runs every handler a second time.
    const retired = retiredDispatchCommand(event);
    for (const removed of removeCommands(
      settings,
      event,
      (c) => c === retired,
    )) {
      outcome.removed.push({command: removed, event});
    }
  }

  for (const handler of handlers) {
    if (handler.component !== component) continue;
    for (const {event} of handler.events) {
      for (const removed of removeCommands(
        settings,
        event,
        (c) => c === handler.command,
      )) {
        outcome.removed.push({command: removed, event});
      }
      for (const entry of entriesOf(settings, event)) {
        for (const command of commandsOf(entry)) {
          if (
            !isDispatchCommand(event, command) &&
            invokesSdk(command) &&
            command.includes(handler.id)
          ) {
            outcome.modified.push({command, event});
          }
        }
      }
    }
  }

  outcome.changed =
    outcome.added.length > 0 ||
    outcome.removed.length > 0 ||
    outcome.rewritten.length > 0;
  return outcome;
}

/** One dispatcher entry the dispatch-off path took back, as it was spelled. */
export interface ClearedDispatchEntry {
  command: string;
  event: DispatchedEvent;
}

/**
 * Dispatch OFF for one component: take back the dispatcher entries for the
 * events its handlers use — either generation, exact command only. The
 * component's own per-handler upsert then writes today's entries. Returns each
 * command taken back, so the report names the spelling that was there.
 */
export function removeDispatchEntriesForComponent(
  settings: Record<string, unknown>,
  component: string,
  handlers: readonly HookHandler[] = HOOK_HANDLERS,
): ClearedDispatchEntry[] {
  const cleared: ClearedDispatchEntry[] = [];
  for (const event of eventsForComponent(component, handlers)) {
    for (const command of removeCommands(settings, event, (c) =>
      isDispatchCommand(event, c),
    )) {
      cleared.push({command, event});
    }
  }
  return cleared;
}

/**
 * One line per thing that happened, in remove.ts's wording. Printed even in
 * quiet mode by the callers: a deletion nobody sees is what F7 forbids.
 */
export function describeDispatchOutcome(
  outcome: DispatchApplyOutcome,
): string[] {
  return [
    ...outcome.added.map(
      (event) =>
        `added: .claude/settings.json ${event} hook (${dispatchCommand(event)}) — hooks.dispatch is on`,
    ),
    ...outcome.rewritten.map(
      (event) =>
        `rewritten: .claude/settings.json ${event} hook (${retiredDispatchCommand(event)} → ${dispatchCommand(event)}) — the old spelling ran the SDK of whatever checkout the session was in, and lost every hook in one older than the dispatcher`,
    ),
    ...outcome.removed.map(({command, event}) =>
      isDispatchedEvent(event) && command === retiredDispatchCommand(event)
        ? `removed: .claude/settings.json ${event} hook (${command}) — a retired spelling of the dispatcher entry, beside the current one: every handler on it ran twice`
        : `removed: .claude/settings.json ${event} hook (${command}) — the ${event} dispatcher entry runs it now`,
    ),
    ...outcome.modified.map(
      ({command, event}) =>
        `⚠️ left in place (modified): .claude/settings.json ${event} hook (${command}) — not the exact command the SDK wrote, so it is yours to delete; with hooks.dispatch on it RUNS TWICE until you do`,
    ),
  ];
}

export function describeClearedDispatchEntries(
  cleared: readonly ClearedDispatchEntry[],
): string[] {
  return cleared.map(
    ({command, event}) =>
      `removed: .claude/settings.json ${event} hook (${command}) — hooks.dispatch is off, so each handler gets its own entry again`,
  );
}
