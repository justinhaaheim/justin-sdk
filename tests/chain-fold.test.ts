/**
 * home-base-kwand.9 (G5): the one chain fold that `thread inbox --unfinished`
 * and the threads dashboard both call (src/thread/chain-fold.ts).
 */
import {describe, expect, test} from 'bun:test';

import {
  chainGroups,
  type ChainSessionFacts,
  unfinishedChains,
} from '../src/thread/chain-fold';
import {NO_REOPEN_SIGNALS} from '../src/thread/reopen-order';

type Facts = ChainSessionFacts & {name: string};

function session(
  name: string,
  overrides: Partial<ChainSessionFacts> = {},
): Facts {
  return {
    beadId: `bead-${name}`,
    labels: [],
    lastActivityAt: '2026-11-18T10:00:00.000Z',
    name,
    questions: [],
    reopen: NO_REOPEN_SIGNALS,
    requests: [],
    section: 'openWork',
    ...overrides,
  };
}

const facts = (item: Facts): ChainSessionFacts => item;
const names = (items: readonly Facts[]): string[] =>
  items.map((item) => item.name);

/**
 * a → b → c, both halves of each link written: a and b handed off, c is the
 * newest. a and b each still hold a request; c picked up b's (same id).
 */
function threeChain(): Facts[] {
  return [
    session('c', {
      labels: ['continues:bead-b'],
      lastActivityAt: '2026-11-18T12:00:00.000Z',
      questions: [
        {id: 'q-c1', status: 'open'},
        {id: 'q-b1', status: 'open'},
      ],
      requests: [
        {id: 'r-b1', state: 'open'},
        {id: 'r-c1', state: 'blocked'},
        {id: 'r-c2', state: 'closed'},
      ],
    }),
    session('b', {
      labels: ['continued-by:bead-c', 'continues:bead-a'],
      lastActivityAt: '2026-11-17T12:00:00.000Z',
      questions: [{id: 'q-b1', status: 'open'}],
      requests: [{id: 'r-b1', state: 'open'}],
      section: 'handedOff',
    }),
    session('a', {
      labels: ['continued-by:bead-b'],
      lastActivityAt: '2026-11-16T12:00:00.000Z',
      questions: [{id: 'q-a1', status: 'closed'}],
      requests: [
        {id: 'r-a1', state: 'open'},
        {id: 'r-a2', state: 'closed'},
      ],
      section: 'handedOff',
    }),
  ];
}

describe('chainGroups: the dashboard fold, with each row given its sessions', () => {
  test('a chain of three is one group, the newest first', () => {
    const {groups, unplaced} = chainGroups(threeChain(), facts);
    expect(groups.map((group) => names(group.members))).toEqual([
      ['c', 'b', 'a'],
    ]);
    expect(unplaced).toEqual([]);
  });

  test('a predecessor whose successor is not listed stays its own row', () => {
    const [c, b, a] = threeChain();
    if (c == null || b == null || a == null) throw new Error('fixture');
    const {groups} = chainGroups([b, a], facts);
    // b names bead-c, which is not listed: b is kept; a folds into it.
    expect(groups.map((group) => names(group.members))).toEqual([['b', 'a']]);
    expect(c.name).toBe('c');
  });

  test('a link to a bead that is not listed is named in outside', () => {
    const [c, b] = threeChain();
    if (c == null || b == null) throw new Error('fixture');
    const {groups} = chainGroups([c, b], facts);
    expect(groups[0]?.outside).toEqual(['bead-a']);
  });

  test('a handoff loop with no head is named in unplaced, never dropped', () => {
    const loop = [
      session('x', {labels: ['continued-by:bead-y']}),
      session('y', {labels: ['continued-by:bead-x']}),
    ];
    const {groups, unplaced} = chainGroups(loop, facts);
    expect(groups).toEqual([]);
    expect(names(unplaced)).toEqual(['x', 'y']);
  });
});

describe('unfinishedChains (G5)', () => {
  // AC 1: a chain of three sessions is one row with summed counts.
  // NEGATIVE CONTROL run 2026-11-18: counting every open request per member
  // (no dedupe by id) made unfinishedRequests 4 and this test failed.
  test('a chain of three sessions is one row with summed counts', () => {
    const result = unfinishedChains(threeChain(), facts, 'activity');
    expect(result.chains).toHaveLength(1);
    const [chain] = result.chains;
    expect(chain?.head.name).toBe('c');
    expect(names(chain?.members ?? [])).toEqual(['c', 'b', 'a']);
    // r-b1 (held by b and picked up by c) once, r-c1 (blocked), r-a1.
    expect(chain?.counts).toEqual({
      openQuestions: 2,
      sessions: 3,
      unfinishedRequests: 3,
    });
    expect(result.totals).toEqual({
      chains: 1,
      openQuestions: 2,
      requestsUnknownChains: 0,
      sessions: 3,
      unfinishedRequests: 3,
    });
  });

  // AC 1: a chain with no unfinished request is absent.
  // NEGATIVE CONTROL run 2026-11-18: dropping the `unfinishedRequests === 0`
  // check listed "done-reqs" and this test failed.
  test('a chain with no unfinished request is absent', () => {
    const items = [
      ...threeChain(),
      session('done-reqs', {
        requests: [{id: 'r-d1', state: 'closed'}],
      }),
      session('no-requests', {requests: []}),
      session('untracked', {beadId: null, labels: null, requests: []}),
      session('marked-done', {
        requests: [{id: 'r-m1', state: 'open'}],
        section: 'done',
      }),
    ];
    const result = unfinishedChains(items, facts, 'activity');
    expect(result.chains.map((chain) => chain.head.name)).toEqual(['c']);
  });

  test('a chain whose requests could not be read is listed and says so', () => {
    const result = unfinishedChains(
      [session('unread', {questions: null, requests: null})],
      facts,
      'activity',
    );
    expect(result.chains).toHaveLength(1);
    expect(result.chains[0]?.requestsUnknown).toBe(1);
    expect(result.chains[0]?.counts.openQuestions).toBeNull();
    expect(result.totals.requestsUnknownChains).toBe(1);
    expect(result.totals.openQuestions).toBeNull();
  });

  // AC 1: both sort orders.
  // NEGATIVE CONTROL run 2026-11-18: unfinishedSortKey returning the reopen
  // tier for `activity` too put "starred-old" first under activity and this
  // test failed; returning 'recent' for `importance` put "newest" first
  // under importance and it failed again.
  test('importance is the reopen order; activity is newest first', () => {
    const open = [{id: 'r', state: 'open'}];
    const items = [
      session('newest', {
        lastActivityAt: '2026-11-18T12:00:00.000Z',
        requests: [{id: 'r-n', state: 'open'}],
      }),
      session('cut-off', {
        lastActivityAt: '2026-11-17T12:00:00.000Z',
        reopen: {...NO_REOPEN_SIGNALS, cutOff: {at: null}},
        requests: [{id: 'r-c', state: 'open'}],
      }),
      session('undated', {lastActivityAt: null, requests: open}),
      session('starred-old', {
        lastActivityAt: '2026-11-01T12:00:00.000Z',
        reopen: {...NO_REOPEN_SIGNALS, starred: true},
        requests: [{id: 'r-s', state: 'open'}],
      }),
      session('waiting', {
        lastActivityAt: '2026-11-10T12:00:00.000Z',
        reopen: {...NO_REOPEN_SIGNALS, waiting: {questions: 1}},
        requests: [{id: 'r-w', state: 'open'}],
      }),
    ];
    const heads = (sort: 'activity' | 'importance'): string[] =>
      unfinishedChains(items, facts, sort).chains.map(
        (chain) => chain.head.name,
      );
    expect(heads('importance')).toEqual([
      'starred-old',
      'waiting',
      'cut-off',
      'newest',
      'undated',
    ]);
    expect(heads('activity')).toEqual([
      'newest',
      'cut-off',
      'waiting',
      'starred-old',
      'undated',
    ]);
  });

  // home-base-kwand.19: the reopen order's to-land tier reaches this sort too.
  // NEGATIVE CONTROL run 2026-11-18: REOPEN_TIERS with toLand below cutOff
  // put "cut-off" before "to-land" and this test failed.
  test('importance puts a chain whose head is to land below the blockers and above cut off', () => {
    const items = [
      session('cut-off', {
        lastActivityAt: '2026-11-18T12:00:00.000Z',
        reopen: {...NO_REOPEN_SIGNALS, cutOff: {at: null}},
        requests: [{id: 'r-c', state: 'open'}],
      }),
      session('to-land', {
        lastActivityAt: '2026-11-17T12:00:00.000Z',
        reopen: {
          ...NO_REOPEN_SIGNALS,
          toLand: {landable: true, questions: 0},
        },
        requests: [{id: 'r-l', state: 'open'}],
      }),
      session('waiting', {
        lastActivityAt: '2026-11-01T12:00:00.000Z',
        reopen: {...NO_REOPEN_SIGNALS, waiting: {questions: 1}},
        requests: [{id: 'r-w', state: 'open'}],
      }),
    ];
    expect(
      unfinishedChains(items, facts, 'importance').chains.map(
        (chain) => chain.head.name,
      ),
    ).toEqual(['waiting', 'to-land', 'cut-off']);
  });
});
