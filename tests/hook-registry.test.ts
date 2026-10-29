/**
 * hook-registry (home-base-rtsx1.1): the table the dispatcher reads must say
 * exactly what the per-handler installers write, and its dispatcher commands
 * must never be mistaken for a handler by the installers' loose matching.
 */

import {describe, expect, test} from 'bun:test';
import {readFileSync} from 'fs';
import {join} from 'path';

import {REPO_STATE_HOOK_COMMAND} from '../src/base-setup';
import {
  dispatchCommand,
  DISPATCHED_EVENTS,
  dispatchMatcher,
  HOOK_HANDLERS,
  isDispatchCommand,
  matcherAccepts,
  retiredDispatchCommand,
  selectHandlers,
} from '../src/hook-registry';
import {invokesSdk, isSdkEmittedCommand} from '../src/sdk-invocation';
import {
  THREAD_CAPTURE_HOOK_COMMAND,
  THREAD_CAPTURE_HOOK_EVENTS,
  THREAD_GUARD_HOOK_COMMAND,
  THREAD_GUARD_HOOK_EVENT,
  THREAD_GUARD_HOOK_MATCHER,
  THREAD_NUDGE_HOOK_COMMAND,
  THREAD_NUDGE_HOOK_EVENT,
  THREAD_NUDGE_HOOK_MATCHER,
  THREAD_STOP_HOOK_COMMAND,
  THREAD_STOP_HOOK_EVENT,
} from '../src/thread-hooks-setup';
import {TIME_CHECK_HOOK_COMMAND} from '../src/time-check-setup';
import {
  USAGE_CHECK_HOOK_COMMAND,
  USAGE_CHECK_HOOK_EVENTS,
} from '../src/usage-check-setup';

function byId(id: string) {
  const found = HOOK_HANDLERS.find((h) => h.id === id);
  if (found == null) throw new Error(`no handler ${id}`);
  return found;
}

function eventsOf(id: string): string[] {
  return byId(id).events.map((e) => e.event);
}

describe('the registry says what the installers write', () => {
  test('commands, byte for byte', () => {
    expect(byId('repo-state --hook').command).toBe(REPO_STATE_HOOK_COMMAND);
    expect(byId('time-check').command).toBe(TIME_CHECK_HOOK_COMMAND);
    expect(byId('usage-check').command).toBe(USAGE_CHECK_HOOK_COMMAND);
    expect(byId('thread capture').command).toBe(THREAD_CAPTURE_HOOK_COMMAND);
    expect(byId('thread stop-check').command).toBe(THREAD_STOP_HOOK_COMMAND);
    expect(byId('thread nudge').command).toBe(THREAD_NUDGE_HOOK_COMMAND);
    expect(byId('thread guard').command).toBe(THREAD_GUARD_HOOK_COMMAND);
  });

  test('events and matchers', () => {
    expect(eventsOf('repo-state --hook')).toEqual(['UserPromptSubmit']);
    expect(eventsOf('time-check')).toEqual(['UserPromptSubmit']);
    expect(eventsOf('usage-check')).toEqual([...USAGE_CHECK_HOOK_EVENTS]);
    expect(eventsOf('thread capture')).toEqual([...THREAD_CAPTURE_HOOK_EVENTS]);
    expect(eventsOf('thread stop-check')).toEqual([THREAD_STOP_HOOK_EVENT]);
    expect(byId('thread nudge').events).toEqual([
      {event: THREAD_NUDGE_HOOK_EVENT, matcher: THREAD_NUDGE_HOOK_MATCHER},
    ]);
    // The session guard (home-base-mbnjv.5): PreToolUse [Bash], knob-gated.
    expect(byId('thread guard').events).toEqual([
      {event: THREAD_GUARD_HOOK_EVENT, matcher: THREAD_GUARD_HOOK_MATCHER},
    ]);
    expect(byId('thread guard').knob).toBe('thread.handoff.successor');
    expect(
      HOOK_HANDLERS.filter((h) => h.knob != null).map((h) => h.id),
    ).toEqual(['thread guard']);
  });

  test('every handler is on a dispatched event', () => {
    for (const handler of HOOK_HANDLERS) {
      for (const {event} of handler.events) {
        expect(DISPATCHED_EVENTS as readonly string[]).toContain(event);
      }
    }
  });
});

describe('dispatcher entries', () => {
  /**
   * The installers find "their" hook by invokesSdk + the handler subcommand as
   * a SUBSTRING (upsertHookCommand), and rewrite any `bun run justin-sdk …`
   * match. A dispatcher command containing one of these would be taken for
   * that handler and rewritten into it (home-base-rtsx1.2 finding 1).
   */
  const HANDLER_SUBCOMMANDS = [
    'time-check',
    'usage-check',
    'thread capture',
    'thread stop-check',
    'thread nudge',
    'repo-state',
    'thread start',
    'setup-env',
    'session-start',
  ];

  test('no dispatcher command contains a handler subcommand, in either spelling', () => {
    for (const event of DISPATCHED_EVENTS) {
      for (const command of [
        dispatchCommand(event),
        retiredDispatchCommand(event),
      ]) {
        expect(invokesSdk(command)).toBe(true);
        for (const subcommand of HANDLER_SUBCOMMANDS) {
          expect(command.includes(subcommand)).toBe(false);
        }
      }
    }
  });

  /**
   * home-base-rtsx1.6: the entry resolves the SDK from the session's project
   * root, so a session working in a checkout whose SDK predates `hook` still
   * runs this one. The exact string is the entry's identity everywhere.
   */
  test('the dispatcher entry is pinned to the project root, and SDK-emitted', () => {
    for (const event of DISPATCHED_EVENTS) {
      expect(dispatchCommand(event)).toBe(
        `bun run --cwd "\${CLAUDE_PROJECT_DIR:-.}" justin-sdk hook ${event}`,
      );
      expect(isSdkEmittedCommand(dispatchCommand(event))).toBe(true);
      expect(retiredDispatchCommand(event)).toBe(
        `bun run justin-sdk hook ${event}`,
      );
      expect(isDispatchCommand(event, dispatchCommand(event))).toBe(true);
      expect(isDispatchCommand(event, retiredDispatchCommand(event))).toBe(
        true,
      );
      expect(
        isDispatchCommand(event, `${dispatchCommand(event)} && echo mine`),
      ).toBe(false);
    }
    expect(isDispatchCommand('Stop', dispatchCommand('UserPromptSubmit'))).toBe(
      false,
    );
  });

  test('matchers: Bash on PostToolUse, none elsewhere', () => {
    expect(dispatchMatcher('PostToolUse')).toBe('Bash');
    expect(dispatchMatcher('UserPromptSubmit')).toBeNull();
    expect(dispatchMatcher('PostToolBatch')).toBeNull();
    expect(dispatchMatcher('Stop')).toBeNull();
  });

  test('a handler without a matcher widens the entry to every tool', () => {
    const handlers = [
      ...HOOK_HANDLERS,
      {
        ...byId('time-check'),
        events: [{event: 'PostToolUse' as const, matcher: null}],
      },
    ];
    expect(dispatchMatcher('PostToolUse', handlers)).toBeNull();
  });
});

describe('matcherAccepts', () => {
  test('anchored, alternation, null, and a missing tool', () => {
    expect(matcherAccepts('Bash', 'Bash')).toBe(true);
    expect(matcherAccepts('Bash', 'BashOutput')).toBe(false);
    expect(matcherAccepts('Edit|Write', 'Write')).toBe(true);
    expect(matcherAccepts(null, 'Anything')).toBe(true);
    expect(matcherAccepts(null, null)).toBe(true);
    expect(matcherAccepts('Bash', null)).toBe(false);
    expect(matcherAccepts('(', 'Bash')).toBe(false);
  });
});

describe('selectHandlers', () => {
  test('filters by component, event and tool', () => {
    const ids = (
      components: string[],
      event: (typeof DISPATCHED_EVENTS)[number],
      toolName: string | null = null,
    ) => selectHandlers({components, event, toolName}).map((h) => h.id);

    expect(ids(['base-setup'], 'UserPromptSubmit')).toEqual([
      'repo-state --hook',
    ]);
    expect(ids(['base-setup', 'thread-hooks-setup'], 'Stop')).toEqual([
      'thread capture',
      'thread stop-check',
    ]);
    expect(ids(['thread-hooks-setup'], 'PostToolUse', 'Bash')).toEqual([
      'thread nudge',
    ]);
    expect(ids(['thread-hooks-setup'], 'PostToolUse', 'Edit')).toEqual([]);
  });
});

test('hook-registry stays a leaf: it imports only sdk-invocation', () => {
  const source = readFileSync(
    join(import.meta.dir, '..', 'src', 'hook-registry.ts'),
    'utf8',
  );
  const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map(
    (match) => match[1],
  );
  expect(imports).toEqual(['./sdk-invocation']);
});
