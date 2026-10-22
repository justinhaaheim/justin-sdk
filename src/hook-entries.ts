/**
 * hook-entries — the settings.json side of hook dispatch (home-base-rtsx1.2).
 *
 * The ONE place that knows what dispatch mode looks like on disk, so every
 * installer and every reader asks here instead of growing its own idea of it.
 *
 * THE KNOB (feature-knobs rule): `"hooks": {"dispatch": true}` in a repo's
 * justin-sdk.config.json. Absent, false, or a config that cannot be read means
 * OFF, and off is today's per-handler behaviour byte for byte. Each installer
 * branches at its call site: on → `applyDispatchForComponent`, off → its own
 * per-handler upsert plus `removeDispatchEntriesForComponent`.
 *
 * BY IDENTITY, NEVER BY NAME (constraint F7, as `remove` does it). An entry is
 * written or taken back only when its command is EXACTLY the one the SDK writes:
 * a dispatcher entry is `dispatchCommand(event)`, a per-handler entry is
 * `handler.command`. Anything else that merely runs the same handler — an
 * absolute path, `… && my-own-thing` — is somebody's edit, so it is left in
 * place and reported, loudly, because with dispatch on it runs TWICE.
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
} from './hook-registry';
import {invokesSdk} from './sdk-invocation';

/** Is hook dispatch switched on in this repo's justin-sdk.config.json? */
export function hookDispatchEnabled(projectRoot: string): boolean {
  const path = join(projectRoot, 'justin-sdk.config.json');
  if (!existsSync(path)) return false;
  try {
    const config = JSON.parse(readFileSync(path, 'utf8')) as {
      hooks?: {dispatch?: unknown};
    } | null;
    return config?.hooks?.dispatch === true;
  } catch {
    return false;
  }
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

/** Does `settings` carry the exact dispatcher entry for this event? */
export function hasDispatchEntry(
  settings: Record<string, unknown>,
  event: DispatchedEvent,
): boolean {
  const command = dispatchCommand(event);
  return entriesOf(settings, event).some((entry) =>
    commandsOf(entry).includes(command),
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
  /** Per-handler entries taken back because the dispatcher now runs them. */
  removed: {command: string; event: string}[];
}

/**
 * Dispatch ON for one component: make sure each event its handlers use has the
 * dispatcher entry (with the right matcher), and take back each of its
 * per-handler entries by identity. Edits `settings` in place.
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
  };

  for (const event of eventsForComponent(component, handlers)) {
    const command = dispatchCommand(event);
    const matcher = dispatchMatcher(event, handlers);
    const hooks = hooksOf(settings);
    const entries = entriesOf(settings, event);
    const existing = entries.find((entry) =>
      commandsOf(entry).includes(command),
    ) as SettingsEntry | undefined;
    if (existing == null) {
      const entry: SettingsEntry = {hooks: [{command, type: 'command'}]};
      if (matcher != null) entry.matcher = matcher;
      hooks[event] = [...entries, entry];
      outcome.added.push(event);
    } else if ((existing.matcher ?? null) !== matcher) {
      if (matcher == null) delete existing.matcher;
      else existing.matcher = matcher;
      outcome.added.push(event);
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
            command !== dispatchCommand(event) &&
            invokesSdk(command) &&
            command.includes(handler.id)
          ) {
            outcome.modified.push({command, event});
          }
        }
      }
    }
  }

  outcome.changed = outcome.added.length > 0 || outcome.removed.length > 0;
  return outcome;
}

/**
 * Dispatch OFF for one component: take back the dispatcher entries for the
 * events its handlers use (exact command only). The component's own
 * per-handler upsert then writes today's entries. Returns the events cleared.
 */
export function removeDispatchEntriesForComponent(
  settings: Record<string, unknown>,
  component: string,
  handlers: readonly HookHandler[] = HOOK_HANDLERS,
): DispatchedEvent[] {
  const cleared: DispatchedEvent[] = [];
  for (const event of eventsForComponent(component, handlers)) {
    const command = dispatchCommand(event);
    if (removeCommands(settings, event, (c) => c === command).length > 0) {
      cleared.push(event);
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
    ...outcome.removed.map(
      ({command, event}) =>
        `removed: .claude/settings.json ${event} hook (${command}) — the ${event} dispatcher entry runs it now`,
    ),
    ...outcome.modified.map(
      ({command, event}) =>
        `⚠️ left in place (modified): .claude/settings.json ${event} hook (${command}) — not the exact command the SDK wrote, so it is yours to delete; with hooks.dispatch on it RUNS TWICE until you do`,
    ),
  ];
}

export function describeClearedDispatchEntries(
  cleared: readonly DispatchedEvent[],
): string[] {
  return cleared.map(
    (event) =>
      `removed: .claude/settings.json ${event} hook (${dispatchCommand(event)}) — hooks.dispatch is off, so each handler gets its own entry again`,
  );
}
