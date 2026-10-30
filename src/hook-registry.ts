/**
 * hook-registry — every hook handler the SDK installs, by event, in one table
 * (home-base-rtsx1.1).
 *
 * Two modes read it. In per-handler mode (today's default) `install` writes one
 * `.claude/settings.json` entry per handler. In dispatch mode (`hooks.dispatch`
 * in justin-sdk.config.json, home-base-rtsx1) it writes one entry per EVENT,
 * `dispatchCommand(event)`, and `hook-dispatch.ts` reads this table at runtime
 * to decide which handlers that entry runs.
 *
 * A LEAF on purpose: it imports nothing but `sdk-invocation.ts`. The dispatcher
 * runs on every prompt, every tool batch and every turn end, and the installers
 * that own these commands import `runBaseSetup` and with it most of the setup
 * code. `tests/hook-registry.test.ts` pins every `command` here to the constant
 * its installer writes, so the two cannot drift apart.
 *
 * SessionStart is deliberately absent: its single entry (`session-start`, with
 * the CLAUDE_CODE_REMOTE cloud branch) is written by base-setup in both modes.
 */

import {sdkRun, sdkRunAtProjectRoot} from './sdk-invocation';

/**
 * The events a dispatch-mode repo can carry a `hook <Event>` entry for.
 * PreToolUse joined for the session guard (home-base-mbnjv.5); its entry is
 * written only where the guard's knob is on (`knob` below).
 */
export const DISPATCHED_EVENTS = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolBatch',
  'Stop',
] as const;

export type DispatchedEvent = (typeof DISPATCHED_EVENTS)[number];

/** One event a handler runs on, with the matcher its settings entry carries. */
export interface HookHandlerEvent {
  event: DispatchedEvent;
  /**
   * Claude Code's matcher for the entry (a tool-name pattern on PostToolUse),
   * or null for events with no matcher dimension.
   */
  matcher: string | null;
}

export interface HookHandler {
  /** The SDK argv after `justin-sdk`, e.g. ['thread', 'capture']. */
  args: readonly string[];
  /** The exact command per-handler mode writes: `bun run justin-sdk <args>`. */
  command: string;
  /** The `-setup` config name of the component that installs it. */
  component: string;
  events: readonly HookHandlerEvent[];
  /** The name used in messages: the args joined, e.g. `thread capture`. */
  id: string;
  /**
   * A config switch that must be on in the repo before install writes this
   * handler's entry, or null when the component alone decides. Read by
   * `hook-knobs.ts`, never here: this file stays a leaf.
   */
  knob: HookHandlerKnob | null;
}

/**
 * The switches a handler can wait on. `thread.handoff.successor` is
 * componentConfig.thread.handoff.successor (epic home-base-mbnjv D10): the
 * session guard is written only where sessions may start successors.
 * `thread.quota.mode` is componentConfig.thread.quota.mode (request
 * home-base-ys9t7.5 D5): ON means any mode but `off`, so the brake is written
 * wherever it observes or enforces.
 */
export type HookHandlerKnob = 'thread.handoff.successor' | 'thread.quota.mode';

function handler(
  component: string,
  args: readonly string[],
  events: readonly HookHandlerEvent[],
  knob: HookHandlerKnob | null = null,
): HookHandler {
  const id = args.join(' ');
  return {args, command: sdkRun(id), component, events, id, knob};
}

const NO_MATCHER = null;

/**
 * Every handler, in the order its output appears in a merged dispatch. Within
 * an event this is also the order today's installers append their entries, so
 * a merged message reads in the familiar order.
 */
export const HOOK_HANDLERS: readonly HookHandler[] = [
  handler(
    'base-setup',
    ['repo-state', '--hook'],
    [{event: 'UserPromptSubmit', matcher: NO_MATCHER}],
  ),
  handler(
    'time-check-setup',
    ['time-check'],
    [{event: 'UserPromptSubmit', matcher: NO_MATCHER}],
  ),
  handler(
    'usage-check-setup',
    ['usage-check'],
    [
      {event: 'UserPromptSubmit', matcher: NO_MATCHER},
      {event: 'PostToolBatch', matcher: NO_MATCHER},
    ],
  ),
  handler(
    'thread-hooks-setup',
    ['thread', 'capture'],
    [
      {event: 'UserPromptSubmit', matcher: NO_MATCHER},
      {event: 'Stop', matcher: NO_MATCHER},
    ],
  ),
  handler(
    'thread-hooks-setup',
    ['thread', 'stop-check'],
    [{event: 'Stop', matcher: NO_MATCHER}],
  ),
  handler(
    'thread-hooks-setup',
    ['thread', 'nudge'],
    [{event: 'PostToolUse', matcher: 'Bash'}],
  ),
  // The session guard (home-base-mbnjv.5, epic C8): refuses raw cmux / claude
  // calls and a subagent's thread handoff. Only where successor is on.
  handler(
    'thread-hooks-setup',
    ['thread', 'guard'],
    [{event: 'PreToolUse', matcher: 'Bash'}],
    'thread.handoff.successor',
  ),
  // The spend quota's brake (home-base-ys9t7.5 D6): EVERY tool, so its null
  // matcher widens the PreToolUse dispatcher entry from Bash to every tool
  // (dispatchMatcher; install rewrites the entry in place). Only where
  // componentConfig.thread.quota.mode is not off.
  handler(
    'thread-hooks-setup',
    ['thread', 'brake'],
    [{event: 'PreToolUse', matcher: NO_MATCHER}],
    'thread.quota.mode',
  ),
];

export function isDispatchedEvent(event: string): event is DispatchedEvent {
  return (DISPATCHED_EVENTS as readonly string[]).includes(event);
}

/**
 * The settings.json command a dispatch-mode repo runs for one event:
 * `bun run --cwd "${CLAUDE_PROJECT_DIR:-.}" justin-sdk hook <Event>`. It resolves
 * the SDK from the session's project root, not from whatever checkout the
 * session is working in (home-base-rtsx1.6; why in sdk-invocation.ts).
 *
 * This exact string is the entry's IDENTITY: install writes it, remove and
 * doctor find it by exact match.
 */
export function dispatchCommand(event: DispatchedEvent): string {
  return sdkRunAtProjectRoot(`hook ${event}`);
}

/**
 * The RETIRED dispatcher spelling, `bun run justin-sdk hook <Event>`
 * (home-base-rtsx1.6). It resolved the SDK from the session's current
 * directory, so in a checkout whose SDK predates `hook` every handler on the
 * event was lost.
 *
 * Still recognised everywhere the current spelling is: install rewrites it in
 * place, the installers' dispatch-off path takes it back, hasDispatchEntry
 * accepts it, and doctor names it stale. It contains no handler id, so nothing
 * else flags it — without this, install would append the new entry beside it
 * and every handler would run twice, silently.
 */
export function retiredDispatchCommand(event: DispatchedEvent): string {
  return sdkRun(`hook ${event}`);
}

/** Is `command` this event's dispatcher entry, in either spelling? */
export function isDispatchCommand(
  event: DispatchedEvent,
  command: string,
): boolean {
  return (
    command === dispatchCommand(event) ||
    command === retiredDispatchCommand(event)
  );
}

/**
 * The matcher a dispatch entry for this event carries: the handlers' matchers
 * joined with `|`, or null when none of them has one. Today that is `Bash` on
 * PostToolUse and null everywhere else.
 *
 * Returns null too when the handlers DISAGREE in kind (one with a matcher, one
 * without): the entry must then match every tool, and the dispatcher's own
 * per-handler matcher check (`handlerMatches`) does the narrowing.
 */
export function dispatchMatcher(
  event: DispatchedEvent,
  handlers: readonly HookHandler[] = HOOK_HANDLERS,
): string | null {
  const matchers = handlers.flatMap((h) =>
    h.events.filter((e) => e.event === event).map((e) => e.matcher),
  );
  if (matchers.length === 0 || matchers.includes(null)) return null;
  return [...new Set(matchers)].join('|');
}

/**
 * Does a Claude Code matcher accept this tool name? Matchers are anchored
 * regular expressions over the tool name ("Bash", "Edit|Write"). A null
 * matcher accepts everything. A missing tool name never satisfies a non-null
 * matcher: an unreadable payload must not widen a handler to every tool.
 */
export function matcherAccepts(
  matcher: string | null,
  toolName: string | null,
): boolean {
  if (matcher == null) return true;
  if (toolName == null) return false;
  try {
    return new RegExp(`^(?:${matcher})$`).test(toolName);
  } catch {
    return false;
  }
}

/**
 * The handlers one dispatch runs: registered for `event`, owned by a component
 * the repo has, and accepting the tool when the event has a matcher.
 */
export function selectHandlers(args: {
  components: readonly string[];
  event: DispatchedEvent;
  handlers?: readonly HookHandler[];
  toolName: string | null;
}): HookHandler[] {
  const handlers = args.handlers ?? HOOK_HANDLERS;
  return handlers.filter(
    (h) =>
      args.components.includes(h.component) &&
      h.events.some(
        (e) =>
          e.event === args.event && matcherAccepts(e.matcher, args.toolName),
      ),
  );
}
