/**
 * `thread done` / `thread reopen` (home-base-p1uj.2 follow-up).
 *
 * What is worth proving here is the ORDER and the ABORT, neither of which a
 * live run can show without destroying real beads:
 *
 *  - asks are closed BEFORE the thread, so a run that dies midway leaves an
 *    OPEN thread with closed asks (a thread mid-cleanup, which is true) rather
 *    than a CLOSED thread with open asks under it (which reads as a bug and
 *    leaves those asks stranded in `board --open-asks` forever);
 *  - a failed ask close ABORTS — the thread stays open — because closing the
 *    thread anyway would strand exactly the ask that could not be closed;
 *  - `reopen` touches the thread and NOTHING else.
 */

import {describe, expect, test} from 'bun:test';

import {
  DEFAULT_DONE_REASON,
  runThreadDone,
  runThreadReopen,
  type DoneDeps,
} from '../src/thread/done';

import type {BdIssue, BdResult} from '../src/thread/bd';

const THREAD: BdIssue = {
  id: 'jl-a1',
  issue_type: 'thread',
  status: 'in_progress',
  title: 'a thread',
};

function ask(id: string): BdIssue {
  return {id, issue_type: 'ask', parent: 'jl-a1', status: 'open', title: id};
}

interface Recorder {
  calls: string[];
  deps: DoneDeps;
}

/** Deps that record every call in order. `failOn` makes one close fail. */
function recorder(options: {asks?: BdIssue[]; failOn?: string} = {}): Recorder {
  const calls: string[] = [];
  const asks = options.asks ?? [ask('jl-a1.1'), ask('jl-a1.2')];
  return {
    calls,
    deps: {
      async closeIssue(_ctx, id, reason): Promise<BdResult<true>> {
        calls.push(`close:${id}:${reason}`);
        if (options.failOn === id) {
          return {
            failure: {
              command: `bd close ${id}`,
              detail: 'database is locked',
              kind: 'locked',
            },
            ok: false,
          };
        }
        return {ok: true, value: true};
      },
      async listOpenAsks(): Promise<BdResult<BdIssue[]>> {
        calls.push('listOpenAsks');
        return {ok: true, value: asks};
      },
      async reopenIssue(_ctx, id, reason): Promise<BdResult<true>> {
        calls.push(`reopen:${id}:${reason}`);
        return {ok: true, value: true};
      },
      async resolveThread() {
        calls.push('resolveThread');
        return {issue: THREAD, ok: true as const};
      },
    },
  };
}

describe('thread done', () => {
  test('closes every open ask AND the thread, asks first', async () => {
    const {calls, deps} = recorder();
    const code = await runThreadDone({deps, threadId: 'jl-a1'});
    expect(code).toBe(0);
    const closes = calls.filter((call) => call.startsWith('close:'));
    expect(closes).toHaveLength(3);
    // The thread is LAST. This is the assertion the ordering exists for.
    expect(closes[2]!.startsWith('close:jl-a1:')).toBe(true);
    expect(closes[0]!.startsWith('close:jl-a1.1:')).toBe(true);
    expect(closes[1]!.startsWith('close:jl-a1.2:')).toBe(true);
  });

  test('an ask is closed as "no longer relevant", never as answered', async () => {
    const {calls, deps} = recorder();
    await runThreadDone({deps, reason: 'moving on', threadId: 'jl-a1'});
    expect(calls).toContain('close:jl-a1.1:no longer relevant: moving on');
    expect(calls).toContain('close:jl-a1:moving on');
  });

  test('the default reason is used when none is given', async () => {
    const {calls, deps} = recorder();
    await runThreadDone({deps, threadId: 'jl-a1'});
    expect(calls).toContain(`close:jl-a1:${DEFAULT_DONE_REASON}`);
  });

  test('a FAILED ask close aborts — the thread is never closed', async () => {
    const {calls, deps} = recorder({failOn: 'jl-a1.2'});
    const code = await runThreadDone({deps, threadId: 'jl-a1'});
    expect(code).toBe(1);
    // jl-a1.1 was closed, jl-a1.2 failed, and the THREAD was never attempted.
    expect(
      calls.some((call) => call === 'close:jl-a1:thread closed by Justin'),
    ).toBe(false);
    expect(calls.filter((call) => call.startsWith('close:'))).toHaveLength(2);
  });

  test('a thread with no open asks still closes, and says so', async () => {
    const {calls, deps} = recorder({asks: []});
    const code = await runThreadDone({deps, threadId: 'jl-a1'});
    expect(code).toBe(0);
    expect(calls.filter((call) => call.startsWith('close:'))).toHaveLength(1);
  });

  test('an unreadable ask list aborts rather than stranding them', async () => {
    const {calls, deps} = recorder();
    deps.listOpenAsks = async () => ({
      failure: {
        command: 'bd list',
        detail: 'bd is unreachable',
        kind: 'unreachable',
      },
      ok: false,
    });
    const code = await runThreadDone({deps, threadId: 'jl-a1'});
    expect(code).toBe(1);
    expect(calls.filter((call) => call.startsWith('close:'))).toHaveLength(0);
  });

  test('an unresolvable thread is exit 2, and nothing is closed', async () => {
    const {calls, deps} = recorder();
    deps.resolveThread = async () => ({message: 'no bead jl-zz', ok: false});
    expect(await runThreadDone({deps, threadId: 'jl-zz'})).toBe(2);
    expect(calls.filter((call) => call.startsWith('close:'))).toHaveLength(0);
  });
});

describe('thread reopen', () => {
  test('reopens the THREAD ONLY — the asks stay closed', async () => {
    const {calls, deps} = recorder();
    const code = await runThreadReopen({
      deps,
      reason: 'more to do',
      threadId: 'jl-a1',
    });
    expect(code).toBe(0);
    expect(calls).toContain('reopen:jl-a1:more to do');
    // Nothing else was reopened, listed or closed.
    expect(calls.filter((call) => call.startsWith('reopen:'))).toHaveLength(1);
    expect(calls).not.toContain('listOpenAsks');
    expect(calls.filter((call) => call.startsWith('close:'))).toHaveLength(0);
  });

  test('a failed reopen is exit 1, never a quiet success', async () => {
    const {deps} = recorder();
    deps.reopenIssue = async () => ({
      failure: {command: 'bd reopen', detail: 'locked', kind: 'locked'},
      ok: false,
    });
    expect(await runThreadReopen({deps, threadId: 'jl-a1'})).toBe(1);
  });
});
