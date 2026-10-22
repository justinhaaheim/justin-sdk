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
  matcherAccepts,
  selectHandlers,
} from '../src/hook-registry';
import {invokesSdk} from '../src/sdk-invocation';
import {
  THREAD_CAPTURE_HOOK_COMMAND,
  THREAD_CAPTURE_HOOK_EVENTS,
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

  test('no dispatcher command contains a handler subcommand', () => {
    for (const event of DISPATCHED_EVENTS) {
      const command = dispatchCommand(event);
      expect(invokesSdk(command)).toBe(true);
      for (const subcommand of HANDLER_SUBCOMMANDS) {
        expect(command.includes(subcommand)).toBe(false);
      }
    }
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
