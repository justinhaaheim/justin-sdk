/**
 * `justin-sdk add thread-hooks` — the hook installer (home-base-p1uj.3, extended
 * with the Stop hook by home-base-p1uj.15).
 *
 * Two properties matter and both are about NOT doing things twice: exactly one
 * entry per event is appended however often the installer runs, and every hook
 * the repo already had survives it. With two events there is a third: the two
 * installs must be independent, so a repo that ran this before the Stop hook
 * existed gains the Stop entry and nothing else on a re-run.
 *
 * WHY THIS TESTS `addThreadStartHook` AND NOT THE WHOLE INSTALLER: Claude cannot
 * write any `.claude/settings.json` — the path is on the Bash sandbox's deny
 * list — so the end-to-end `runThreadHooksSetup` run against a scratch repo is
 * something Justin performs by hand (see home-base-p1uj.3). What can be proved
 * here is the function that decides what goes into the file, exercised over the
 * settings shapes a real repo has: empty, hooks-but-not-this-one, and already
 * installed.
 *
 * NEGATIVE CONTROL (run 2026-09-12, recorded on home-base-p1uj.3): the
 * fingerprint check `if (JSON.stringify(registered).includes(...)) return false`
 * was deleted. 4 pass / 3 fail — "a re-run changes NOTHING" (`Expected: false
 * Received: true`), "three runs still leave exactly one entry" (`Expected
 * length: 1 Received length: 3`) and "a hand-edited spelling counts as
 * installed" (`Expected: false Received: true`). Restored → 7/0.
 */

import {describe, expect, test} from 'bun:test';

import {
  addThreadStartHook,
  addThreadStopHook,
  THREAD_HOOK_EVENT,
  THREAD_HOOK_MATCHER,
  THREAD_START_HOOK_COMMAND,
  THREAD_STOP_HOOK_COMMAND,
  THREAD_STOP_HOOK_EVENT,
} from '../src/thread-hooks-setup';
import {COMPONENT_NAMES, DEPENDENCY_ORDER} from '../src/components';

function sessionStartEntries(settings: Record<string, unknown>): unknown[] {
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  return (hooks[THREAD_HOOK_EVENT] as unknown[] | undefined) ?? [];
}

function stopEntries(settings: Record<string, unknown>): unknown[] {
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  return (hooks[THREAD_STOP_HOOK_EVENT] as unknown[] | undefined) ?? [];
}

describe('addThreadStartHook', () => {
  test('appends exactly ONE SessionStart entry to empty settings', () => {
    const settings: Record<string, unknown> = {};
    expect(addThreadStartHook(settings)).toBe(true);

    const entries = sessionStartEntries(settings);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      hooks: [{command: THREAD_START_HOOK_COMMAND, type: 'command'}],
      matcher: THREAD_HOOK_MATCHER,
    });
  });

  test('the matcher is startup|resume — not clear or compact', () => {
    // clear and compact keep the SAME session id, so the command would find the
    // existing bead and no-op: a bd round trip bought for nothing, right after a
    // compaction, when the session is already paying to rebuild its context.
    expect(THREAD_HOOK_MATCHER).toBe('startup|resume');
  });

  test('a re-run changes NOTHING', () => {
    const settings: Record<string, unknown> = {};
    addThreadStartHook(settings);
    const before = JSON.stringify(settings);

    expect(addThreadStartHook(settings)).toBe(false);
    expect(JSON.stringify(settings)).toBe(before);
  });

  test('three runs still leave exactly one entry', () => {
    const settings: Record<string, unknown> = {};
    addThreadStartHook(settings);
    addThreadStartHook(settings);
    addThreadStartHook(settings);
    expect(sessionStartEntries(settings)).toHaveLength(1);
  });

  test('existing hooks survive — including another SessionStart hook', () => {
    const settings: Record<string, unknown> = {
      hooks: {
        PostToolUse: [
          {hooks: [{command: 'bun run lint:fix:file', type: 'command'}]},
        ],
        SessionStart: [
          {hooks: [{command: 'bun scripts/setup-env.ts', type: 'command'}]},
        ],
        UserPromptSubmit: [
          {
            hooks: [
              {
                command: 'bunx @justinhaaheim/justin-sdk usage-check',
                type: 'command',
              },
            ],
          },
        ],
      },
    };

    expect(addThreadStartHook(settings)).toBe(true);

    const entries = sessionStartEntries(settings);
    expect(entries).toHaveLength(2);
    expect(JSON.stringify(entries[0])).toContain('scripts/setup-env.ts');
    expect(JSON.stringify(entries[1])).toContain('thread start --hook');
    // Untouched events stay untouched.
    const hooks = settings.hooks as Record<string, unknown>;
    expect(JSON.stringify(hooks.PostToolUse)).toContain('lint:fix:file');
    expect(JSON.stringify(hooks.UserPromptSubmit)).toContain('usage-check');
  });

  test('a hand-edited spelling of the command counts as installed', () => {
    // The fingerprint is the command SUBSTRING, not the exact string, so a
    // local absolute-path invocation is recognised rather than duplicated.
    const settings: Record<string, unknown> = {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                command:
                  '/Users/jhaa/Dev/home-base/bin/justin-sdk thread start --hook',
                type: 'command',
              },
            ],
            matcher: 'startup',
          },
        ],
      },
    };
    expect(addThreadStartHook(settings)).toBe(false);
    expect(sessionStartEntries(settings)).toHaveLength(1);
  });
});

describe('addThreadStopHook (home-base-p1uj.15)', () => {
  test('appends exactly ONE Stop entry, with NO matcher', () => {
    const settings: Record<string, unknown> = {};
    expect(addThreadStopHook(settings)).toBe(true);

    const entries = stopEntries(settings);
    expect(entries).toHaveLength(1);
    // Stop has no matcher dimension — one would be silently ignored rather than
    // helpfully restrictive, so the entry must not carry the key at all.
    expect(entries[0]).toEqual({
      hooks: [{command: THREAD_STOP_HOOK_COMMAND, type: 'command'}],
    });
    expect(entries[0]).not.toHaveProperty('matcher');
  });

  test('a re-run changes NOTHING', () => {
    const settings: Record<string, unknown> = {};
    expect(addThreadStopHook(settings)).toBe(true);
    expect(addThreadStopHook(settings)).toBe(false);
    expect(addThreadStopHook(settings)).toBe(false);
    expect(stopEntries(settings)).toHaveLength(1);
  });

  test('the two hooks are independent — a repo with only the old one gains only Stop', () => {
    // This is the upgrade path: every repo that ran `add thread-hooks` before
    // p1uj.15 already has the SessionStart entry and none of them has the Stop
    // one. Neither install may touch the other's event.
    const settings: Record<string, unknown> = {};
    addThreadStartHook(settings);
    expect(stopEntries(settings)).toHaveLength(0);

    expect(addThreadStopHook(settings)).toBe(true);
    expect(addThreadStartHook(settings)).toBe(false);
    expect(sessionStartEntries(settings)).toHaveLength(1);
    expect(stopEntries(settings)).toHaveLength(1);
  });

  test('an unrelated Stop hook the repo already had survives', () => {
    const other = {hooks: [{command: 'echo bye', type: 'command'}]};
    const settings: Record<string, unknown> = {hooks: {Stop: [other]}};
    expect(addThreadStopHook(settings)).toBe(true);

    const entries = stopEntries(settings);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual(other);
  });

  test('a hand-edited spelling of the command counts as installed', () => {
    const settings: Record<string, unknown> = {
      hooks: {
        Stop: [
          {
            hooks: [
              {
                command: '/Users/jhaa/Dev/home-base/bin/justin-sdk thread stop-check',
                type: 'command',
              },
            ],
          },
        ],
      },
    };
    expect(addThreadStopHook(settings)).toBe(false);
    expect(stopEntries(settings)).toHaveLength(1);
  });
});

describe('the component registry', () => {
  test('thread-hooks is registered and is OPT-IN ONLY', () => {
    // Its hook writes to a SHARED Dolt database on every session start, so
    // installing it via `init` or the `all` preset would have every repo paying
    // lock contention for a feature only some sessions use.
    expect(COMPONENT_NAMES).toContain('thread-hooks');
    expect(DEPENDENCY_ORDER).not.toContain('thread-hooks');
  });
});
