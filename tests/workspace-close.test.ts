/**
 * stopThenCloseWorkspace on its own (home-base-yukaf.14 F4): the one
 * SIGTERM-wait-close that `thread open --undo` and cmux-arrange-close share.
 * Every dependency is a fake: a process table read like `ps -p <pid>`, a
 * kill that records the signal, a close that records the cmux call, and a
 * clock that `sleep` advances. Nothing here signals a real process.
 */

import type {
  PidCommand,
  ProcessToStop,
  StopAndCloseDeps,
} from '../src/thread/workspace-close';

import {describe, expect, test} from 'bun:test';

import {
  STOP_POLL_MS,
  stopThenCloseWorkspace,
} from '../src/thread/workspace-close';

const CLAUDE_A = 'claude --resume aaaaaaaa-0000-4000-8000-000000000001';
const CLAUDE_B = 'claude --resume bbbbbbbb-0000-4000-8000-000000000002';

interface Fake {
  /** What `ps` answers for a pid on each read after its SIGTERM. */
  afterKill: Map<number, PidCommand>;
  deps: StopAndCloseDeps;
  /** Every call, in order: `ps <pid>`, `before`, `kill <pid>`, `close`. */
  events: string[];
}

/**
 * A world where each pid runs `table[pid]` until it is signalled, then reads
 * as `afterKill[pid]` (default: gone, so it exits at once).
 */
function fake(
  table: Record<number, string>,
  options: {
    afterKill?: Record<number, PidCommand>;
    beforeSignal?: string | null;
    closeFails?: string;
    exitTimeoutMs?: number;
    killFails?: number;
  } = {},
): Fake {
  const events: string[] = [];
  const signalled = new Set<number>();
  const afterKill = new Map<number, PidCommand>(
    Object.entries(options.afterKill ?? {}).map(([pid, answer]) => [
      Number(pid),
      answer,
    ]),
  );
  let clock = 0;
  const deps: StopAndCloseDeps = {
    beforeSignal:
      options.beforeSignal === undefined
        ? () => {
            events.push('before');
            return null;
          }
        : () => {
            events.push('before');
            return options.beforeSignal ?? null;
          },
    closeWorkspace: () => {
      events.push('close');
      return Promise.resolve(options.closeFails ?? null);
    },
    commandOf: (pid) => {
      events.push(`ps ${pid}`);
      if (signalled.has(pid)) {
        return Promise.resolve(afterKill.get(pid) ?? {kind: 'gone'});
      }
      const command = table[pid];
      return Promise.resolve(
        command == null ? {kind: 'gone'} : {command, kind: 'running'},
      );
    },
    exitTimeoutMs: options.exitTimeoutMs ?? 2000,
    kill: (pid) => {
      events.push(`kill ${pid}`);
      if (options.killFails === pid) return 'EPERM';
      signalled.add(pid);
      return null;
    },
    nowMs: () => clock,
    sleep: (ms) => {
      clock += ms;
      events.push(`sleep ${ms}`);
      return Promise.resolve();
    },
  };
  return {afterKill, deps, events};
}

const A: ProcessToStop = {command: CLAUDE_A, pid: 101};
const ONLY_A: ProcessToStop[] = [A];
const BOTH: ProcessToStop[] = [A, {command: CLAUDE_B, pid: 102}];

describe('stopThenCloseWorkspace (F4)', () => {
  test('order: re-identify every pid, the before step, SIGTERM each, poll until gone, then close', async () => {
    const w = fake(
      {101: CLAUDE_A, 102: CLAUDE_B},
      // 102 takes one poll to exit: it still runs its command on the first.
      {afterKill: {102: {command: CLAUDE_B, kind: 'running'}}},
    );
    let polls = 0;
    const commandOf = w.deps.commandOf;
    w.deps.commandOf = async (pid) => {
      const answer = await commandOf(pid);
      if (pid === 102 && w.events.includes('kill 102')) {
        polls += 1;
        if (polls > 1) return {kind: 'gone'};
      }
      return answer;
    };
    expect(await stopThenCloseWorkspace(BOTH, w.deps)).toBeNull();
    expect(w.events).toEqual([
      'ps 101',
      'ps 102',
      'before',
      'kill 101',
      'kill 102',
      'ps 101',
      'ps 102',
      `sleep ${STOP_POLL_MS}`,
      'ps 102',
      'close',
    ]);
  });

  test('a zombie, which ps shows as (claude), counts as exited', async () => {
    const w = fake(
      {101: CLAUDE_A},
      {afterKill: {101: {command: '(claude)', kind: 'running'}}},
    );
    expect(await stopThenCloseWorkspace(ONLY_A, w.deps)).toBeNull();
    expect(w.events).toEqual([
      'ps 101',
      'before',
      'kill 101',
      'ps 101',
      'close',
    ]);
  });

  test('a pid ps cannot read after SIGTERM counts as running: the wait times out and nothing closes', async () => {
    const w = fake(
      {101: CLAUDE_A},
      {
        afterKill: {101: {kind: 'failed', reason: 'ps exited 1'}},
        exitTimeoutMs: 1000,
      },
    );
    const failure = await stopThenCloseWorkspace(ONLY_A, w.deps);
    expect(failure?.step).toBe('wait-exit');
    expect(failure?.reason).toContain(
      'pid 101 still running 1 s after SIGTERM',
    );
    expect(w.events).not.toContain('close');
  });

  test('a process that ignores SIGTERM: the wait times out, the workspace stays open, no second signal', async () => {
    const w = fake(
      {101: CLAUDE_A},
      {
        afterKill: {101: {command: CLAUDE_A, kind: 'running'}},
        exitTimeoutMs: 1000,
      },
    );
    const failure = await stopThenCloseWorkspace(ONLY_A, w.deps);
    expect(failure).toEqual({
      reason:
        'pid 101 still running 1 s after SIGTERM; the workspace was left open (no SIGKILL)',
      step: 'wait-exit',
    });
    expect(w.events.filter((event) => event.startsWith('kill'))).toEqual([
      'kill 101',
    ]);
    expect(w.events).not.toContain('close');
    // It polled until the deadline: 1000 ms in 250 ms steps.
    expect(w.events.filter((event) => event.startsWith('sleep'))).toHaveLength(
      1000 / STOP_POLL_MS,
    );
  });

  test('a pid that now runs something else, or is gone, or cannot be read: nothing is signalled', async () => {
    const changed = fake({101: 'vim notes.md', 102: CLAUDE_B});
    expect((await stopThenCloseWorkspace(BOTH, changed.deps))?.step).toBe(
      'verify',
    );
    expect(changed.events).toEqual(['ps 101']);

    const gone = fake({102: CLAUDE_B});
    expect((await stopThenCloseWorkspace(BOTH, gone.deps))?.reason).toContain(
      'has exited since the gates read it',
    );
    expect(gone.events.some((event) => event.startsWith('kill'))).toBe(false);
  });

  test('a failed before step or SIGTERM leaves the workspace open; a failed close says the session stays resumable', async () => {
    const before = fake(
      {101: CLAUDE_A},
      {beforeSignal: 'closed.jsonl unwritable'},
    );
    expect(await stopThenCloseWorkspace(ONLY_A, before.deps)).toEqual({
      reason:
        'closed.jsonl unwritable; nothing was signalled and the workspace was left open',
      step: 'before-signal',
    });
    expect(before.events).toEqual(['ps 101', 'before']);

    const kill = fake({101: CLAUDE_A, 102: CLAUDE_B}, {killFails: 102});
    expect((await stopThenCloseWorkspace(BOTH, kill.deps))?.step).toBe(
      'sigterm',
    );
    expect(kill.events).not.toContain('close');

    const close = fake({101: CLAUDE_A}, {closeFails: 'cmux: not found'});
    expect((await stopThenCloseWorkspace(ONLY_A, close.deps))?.reason).toBe(
      'close-workspace failed after Claude exited (the session stays resumable): cmux: not found',
    );
  });
});
