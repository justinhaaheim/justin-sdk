/**
 * `thread board` — grouping, ordering and age (home-base-p1uj.2).
 *
 * Fixtures of `bd list --json` output, because the board's whole job is the
 * client-side join: two listings in, a grouped table out, with NO per-row bd
 * call. If the join is wrong the board silently under-reports what is waiting
 * for Justin, which is the failure direction that matters.
 *
 * `now` is injected everywhere so the age column is actually asserted rather
 * than asserted-around.
 */

import {describe, expect, test} from 'bun:test';

import {
  buildBoard,
  collectOpenAsks,
  formatAge,
  renderByRepo,
  renderOpenAsks,
  renderRecent,
  threadIdOfAsk,
} from '../src/thread/board';

import type {BdIssue} from '../src/thread/bd';

const NOW = new Date('2026-09-12T12:00:00.000Z');

function thread(
  id: string,
  title: string,
  metadata: Record<string, unknown>,
): BdIssue {
  return {id, issue_type: 'thread', metadata, status: 'in_progress', title};
}

function ask(
  id: string,
  parent: string | null,
  metadata: Record<string, unknown>,
  title = 'an ask',
): BdIssue {
  return {
    id,
    issue_type: 'ask',
    metadata,
    parent,
    status: 'open',
    title,
  };
}

const THREADS: BdIssue[] = [
  thread('jl-a1', 'Thread reports read path', {
    branch: 'thread-reports',
    mergeState: 'unmerged',
    progressPercent: 70,
    reportedAt: '2026-09-12T10:00:00.000Z',
    repo: 'justin-sdk',
    stopReasonKind: 'needsYou',
  }),
  thread('jl-b2', 'Mail scan sender guide', {
    branch: 'main',
    mergeState: 'merged',
    progressPercent: 100,
    reportedAt: '2026-09-10T12:00:00.000Z',
    repo: 'home-base',
    stopReasonKind: 'completed',
  }),
  thread('jl-c3', 'Older justin-sdk work', {
    branch: 'main',
    progressPercent: 40,
    reportedAt: '2026-09-12T11:30:00.000Z',
    repo: 'justin-sdk',
    stopReasonKind: 'blocked',
  }),
];

const ASKS: BdIssue[] = [
  ask(
    'jl-a1.1',
    'jl-a1',
    {
      blocking: true,
      createdAt: '2026-09-12T10:00:00.000Z',
      threadId: 'jl-a1',
    },
    'Accept the subagent behaviour?',
  ),
  ask(
    'jl-a1.2',
    'jl-a1',
    {
      blocking: false,
      createdAt: '2026-09-12T10:00:00.000Z',
      threadId: 'jl-a1',
    },
    'Leave the knob on?',
  ),
  ask('jl-c3.1', 'jl-c3', {
    blocking: false,
    createdAt: '2026-09-12T11:30:00.000Z',
    threadId: 'jl-c3',
  }),
];

describe('formatAge', () => {
  test('renders minutes, hours and days', () => {
    expect(formatAge('2026-09-12T11:59:30.000Z', NOW)).toBe('just now');
    expect(formatAge('2026-09-12T11:30:00.000Z', NOW)).toBe('30m');
    expect(formatAge('2026-09-12T10:00:00.000Z', NOW)).toBe('2h');
    expect(formatAge('2026-09-09T12:00:00.000Z', NOW)).toBe('3d');
  });

  test('an absent or unparseable timestamp is UNKNOWN, never 0', () => {
    expect(formatAge(null, NOW)).toBe('age UNKNOWN');
    expect(formatAge('not a date', NOW)).toBe('age UNKNOWN');
  });
});

describe('the ask → thread join', () => {
  test('prefers parent, falls back to metadata.threadId', () => {
    expect(threadIdOfAsk(ask('x.1', 'x', {threadId: 'other'}))).toBe('x');
    expect(threadIdOfAsk(ask('x.1', null, {threadId: 'other'}))).toBe('other');
    expect(threadIdOfAsk(ask('x.1', null, {}))).toBeNull();
  });

  test('counts open and blocking asks per thread', () => {
    const {rows} = buildBoard(THREADS, ASKS, NOW);
    const a1 = rows.find((row) => row.id === 'jl-a1');
    expect(a1?.openAsks).toBe(2);
    expect(a1?.blockingAsks).toBe(1);
    const b2 = rows.find((row) => row.id === 'jl-b2');
    expect(b2?.openAsks).toBe(0);
  });

  test('an ask whose thread is gone is kept as an ORPHAN, never dropped', () => {
    const {orphanAsks, rows} = buildBoard(
      THREADS,
      [...ASKS, ask('jl-zz.1', 'jl-zz', {blocking: true})],
      NOW,
    );
    expect(orphanAsks.map((entry) => entry.id)).toEqual(['jl-zz.1']);
    // and it is not silently attributed to some other thread
    expect(rows.reduce((sum, row) => sum + row.openAsks, 0)).toBe(3);
  });
});

describe('views', () => {
  test('the default view groups by repo, newest thread first inside a group', () => {
    const text = renderByRepo(buildBoard(THREADS, ASKS, NOW), 'thread');
    expect(text).toContain('justin-sdk  (2 threads)');
    expect(text).toContain('home-base  (1 thread)');
    const sdk = text.indexOf('justin-sdk  (2 threads)');
    const older = text.indexOf('Older justin-sdk work');
    const readPath = text.indexOf('Thread reports read path');
    expect(older).toBeGreaterThan(sdk);
    expect(readPath).toBeGreaterThan(older); // 30m before 2h
  });

  test('a thread with no measurable repo gets its own group rather than vanishing', () => {
    const text = renderByRepo(
      buildBoard([thread('jl-d4', 'orphan', {reportedAt: null})], [], NOW),
      'thread',
    );
    expect(text).toContain('UNKNOWN repo');
    expect(text).toContain('orphan');
  });

  test('--recent is a flat list, newest report first, across repos', () => {
    const text = renderRecent(buildBoard(THREADS, ASKS, NOW));
    const positions = [
      'Older justin-sdk work',
      'Thread reports read path',
      'Mail scan sender guide',
    ].map((title) => text.indexOf(title));
    expect(positions[0]).toBeLessThan(positions[1]!);
    expect(positions[1]).toBeLessThan(positions[2]!);
  });

  test('--open-asks puts blocking first, then newest first', () => {
    const asks = collectOpenAsks(THREADS, ASKS);
    expect(asks.map((entry) => entry.id)).toEqual([
      'jl-a1.1', // blocking
      'jl-c3.1', // 11:30
      'jl-a1.2', // 10:00
    ]);
    const text = renderOpenAsks(asks);
    expect(text).toContain('🛑 BLOCKING');
    expect(text).toContain('justin-sdk');
    expect(text).toContain('Accept the subagent behaviour?');
  });

  test('an empty board says CHECKED rather than printing nothing', () => {
    expect(renderByRepo(buildBoard([], [], NOW), 'thread')).toContain(
      'checked, and there are none',
    );
    expect(renderOpenAsks([])).toContain('checked, and there are none');
  });
});
