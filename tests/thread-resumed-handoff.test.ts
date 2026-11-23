/**
 * home-base-1vcgs: a session resumed after its successor stopped, then handed
 * off again. The pure halves: D1's verdict, D2's check, D3's newest successor
 * through the shared forward step and the chain readers built on it, and D5's
 * refused successor as the start of a new chain. The br-backed halves are in
 * thread-handoff-pickup.test.ts.
 */

import type {ChainBead, ChainBeadLookup} from '../src/thread/chain-walk';
import type {
  ChainViewBead,
  ChainViewBeadRead,
} from '../src/thread/handoff-view';
import type {MessageLogRead} from '../src/thread/message-log';
import type {SuccessorActivityReader} from '../src/thread/session-handoff';
import type {StatusFacts} from '../src/thread/session-status';

import {describe, expect, test} from 'bun:test';

import {chainGroups} from '../src/thread/chain-fold';
import {stepForward} from '../src/thread/chain-step';
import {walkChain} from '../src/thread/chain-walk';
import {walkUnattendedChain} from '../src/thread/handoff-chain';
import {replacementVerdict} from '../src/thread/handoff-pickup';
import {readHandoffChain} from '../src/thread/handoff-view';
import {statusWords} from '../src/thread/part-one';
import {KICKOFF_OPENING} from '../src/thread/respawn';
import {checkNamedSuccessors} from '../src/thread/session-handoff';
import {deriveStatus, withNewestSuccessor} from '../src/thread/session-status';

const P = 't-p';
const S1 = 't-s1';
const S2 = 't-s2';

/** P names S1 then S2; S2 was created after S1. */
function beads(
  overrides: Partial<Record<string, null | string>> = {},
): Record<string, ChainViewBead> {
  const at = (id: string, value: string): null | string =>
    id in overrides ? (overrides[id] ?? null) : value;
  return {
    [P]: {
      createdAt: at(P, '2026-10-20T10:00:00Z'),
      id: P,
      labels: [`continued-by:${S1}`, `continued-by:${S2}`],
      notes: null,
      title: 'P',
    },
    [S1]: {
      createdAt: at(S1, '2026-10-24T10:00:00Z'),
      id: S1,
      labels: [`continues:${P}`],
      notes: null,
      title: 'S1',
    },
    [S2]: {
      createdAt: at(S2, '2026-11-08T04:33:00Z'),
      id: S2,
      labels: [`continues:${P}`],
      notes: null,
      title: 'S2',
    },
  };
}

function viewReader(
  table: Record<string, ChainViewBead>,
  missing: readonly string[] = [],
): (id: string) => ChainViewBeadRead {
  return (id) => {
    const bead = table[id];
    if (bead == null || missing.includes(id)) {
      return {kind: 'notFound', reason: `${id} not in the test table`};
    }
    return {bead, kind: 'found'};
  };
}

describe('D3: the newest of two successors, from the shared forward step', () => {
  test('stepForward follows the successor created last, whatever the label order', () => {
    const table = beads();
    const step = stepForward(
      table[P] ?? {id: P, labels: []},
      {limit: 10, seen: new Set([P]), taken: 0},
      {findContinuing: null, readBead: viewReader(table)},
    );
    expect(step).toMatchObject({id: S2, kind: 'next', link: 'complete'});
  });

  test('thread show (readHandoffChain) and walkChain give the same chain: P then S2', () => {
    const table = beads();
    const view = readHandoffChain(P, {showBead: viewReader(table)});
    if ('kind' in view) throw new Error(view.reason);
    expect(view.nodes.map((node) => node.beadId)).toEqual([P, S2]);
    expect(view.problems).toEqual([]);

    const chainTable: Record<string, ChainBead> = Object.fromEntries(
      Object.entries(table).map(([id, bead]) => [
        id,
        {...bead, beadsDir: null},
      ]),
    );
    const walked = walkChain(P, {
      findContinuing: () => ({ids: [], kind: 'read'}),
      readBead: (id): ChainBeadLookup => {
        const bead = chainTable[id];
        return bead == null
          ? {kind: 'notFound', reason: 'not in the test table'}
          : {bead, kind: 'found'};
      },
    });
    if (walked.kind === 'failed') throw new Error(walked.reason);
    expect(walked.members.map((member) => member.beadId)).toEqual([P, S2]);
    expect(walked.kind).toBe('complete');
  });

  test('a successor that cannot be read keeps the fork, named', () => {
    const table = beads();
    const step = stepForward(
      table[P] ?? {id: P, labels: []},
      {limit: 10, seen: new Set([P]), taken: 0},
      {findContinuing: null, readBead: viewReader(table, [S1])},
    );
    expect(step).toMatchObject({ids: [S1, S2], kind: 'twoSuccessors'});
    expect(step.kind === 'twoSuccessors' ? step.why : '').toContain(S1);
    const view = readHandoffChain(P, {showBead: viewReader(table, [S1])});
    if ('kind' in view) throw new Error(view.reason);
    expect(view.nodes.map((node) => node.beadId)).toEqual([P]);
    expect(view.problems.join('\n')).toContain('names 2 successors');
  });

  test('a missing creation time, or two equal ones, keeps the fork', () => {
    for (const table of [
      beads({[S1]: null}),
      beads({[S1]: 'not a time'}),
      beads({[S1]: '2026-11-08T04:33:00Z'}),
    ]) {
      const step = stepForward(
        table[P] ?? {id: P, labels: []},
        {limit: 10, seen: new Set([P]), taken: 0},
        {findContinuing: null, readBead: viewReader(table)},
      );
      expect(step.kind).toBe('twoSuccessors');
    }
  });
});

describe('D1: whether a pickup is a newer handoff’s successor', () => {
  const others = [
    {createdAt: '2026-10-24T10:00:00Z', id: S1, kind: 'read' as const},
  ];

  test('the 2026-11-08 case: handed off again two weeks after S1 was created, accepted', () => {
    expect(
      replacementVerdict({
        others,
        predecessor: {
          id: P,
          labels: ['handed-off', `continued-by:${S1}`],
          notes: '- 2026-11-08 04:32: handed off — the note',
        },
      }),
    ).toEqual({kind: 'accept'});
  });

  test('the /clear case: no handoff since S1 was created, refused naming S1', () => {
    const created = new Date(2026, 10, 8, 4, 32, 40).toISOString();
    expect(
      replacementVerdict({
        others: [{createdAt: created, id: S1, kind: 'read'}],
        predecessor: {
          id: P,
          labels: ['handed-off', `continued-by:${S1}`],
          // The handoff S1 picked up, in the same minute S1 was created.
          notes: '- 2026-11-08 04:32: handed off',
        },
      }),
    ).toMatchObject({kind: 'refuse', other: S1});
  });

  test('no handed-off label at all: refused, as before', () => {
    expect(
      replacementVerdict({
        others,
        predecessor: {id: P, labels: [`continued-by:${S1}`], notes: null},
      }),
    ).toMatchObject({kind: 'refuse', other: S1});
  });

  test('a time that cannot be read is unknown, never a refusal', () => {
    const predecessor = {
      id: P,
      labels: ['handed-off', `continued-by:${S1}`],
      notes: '- 2026-11-08 04:32: handed off',
    };
    expect(
      replacementVerdict({
        others: [{id: S1, kind: 'unreadable', reason: 'br failed'}],
        predecessor,
      }).kind,
    ).toBe('unknown');
    expect(
      replacementVerdict({
        others: [{createdAt: null, id: S1, kind: 'read'}],
        predecessor,
      }).kind,
    ).toBe('unknown');
    expect(
      replacementVerdict({
        others,
        predecessor: {...predecessor, notes: 'no dated line'},
      }).kind,
    ).toBe('unknown');
  });
});

describe('D2: a successor this session already names', () => {
  const labels = [`continued-by:${S1}`];
  const reader =
    (
      answer: Awaited<ReturnType<SuccessorActivityReader>>,
    ): SuccessorActivityReader =>
    () =>
      Promise.resolve(answer);

  test('working now refuses, naming it and its resume command', async () => {
    const checked = await checkNamedSuccessors({
      beadId: P,
      labels,
      read: reader({
        activity: {kind: 'working', lastRecordAt: '2026-11-08T04:30:00Z'},
        kind: 'read',
        sessionId: 'sid-s1',
      }),
    });
    expect(checked.kind).toBe('refuse');
    const reason = checked.kind === 'refuse' ? checked.reason : '';
    expect(reason).toContain(`${S1} continues this session and is working now`);
    expect(reason).toContain('claude --resume sid-s1');
  });

  test('a state that cannot be read refuses the same way', async () => {
    for (const answer of [
      {kind: 'failed' as const, reason: 'the index is unreadable'},
      {
        activity: {kind: 'unknown' as const, reasons: ['no transcript']},
        kind: 'read' as const,
        sessionId: 'sid-s1',
      },
    ]) {
      const checked = await checkNamedSuccessors({
        beadId: P,
        labels,
        read: reader(answer),
      });
      expect(checked.kind).toBe('refuse');
      expect(checked.kind === 'refuse' ? checked.reason : '').toContain(
        'could not be read',
      );
    }
  });

  test('stopped passes and names it as earlier', async () => {
    expect(
      await checkNamedSuccessors({
        beadId: P,
        labels,
        read: reader({
          activity: {kind: 'stopped'},
          kind: 'read',
          sessionId: 'sid-s1',
        }),
      }),
    ).toEqual({earlier: [S1], kind: 'clear'});
  });
});

describe('F1 (home-base-1vcgs.1): the fold puts a predecessor in its newest successor`s chain', () => {
  interface Row {
    beadId: string;
    createdAt: null | string;
    labels: string[];
  }
  /** S1 is listed first, so the old rule (first head in input order) picks it. */
  const rows = (s1At: null | string = '2026-10-24T10:00:00Z'): Row[] => [
    {beadId: S1, createdAt: s1At, labels: [`continues:${P}`]},
    {beadId: S2, createdAt: '2026-11-08T04:33:00Z', labels: [`continues:${P}`]},
    {
      beadId: P,
      createdAt: '2026-10-20T10:00:00Z',
      labels: [`continued-by:${S1}`, `continued-by:${S2}`],
    },
  ];
  const membersOf = (items: readonly Row[]): string[][] =>
    chainGroups(items, (row) => row).groups.map((group) =>
      group.members.map((member) => member.beadId),
    );

  test('S1 listed first: P still joins S2, the successor created last', () => {
    expect(membersOf(rows())).toEqual([[S1], [S2, P]]);
  });

  test('a creation time that is missing keeps the old order: P joins the first head', () => {
    expect(membersOf(rows(null))).toEqual([[S1, P], [S2]]);
  });
});

describe('F2 (home-base-1vcgs.1): the card names the newest successor', () => {
  const facts: StatusFacts = {
    activityUnmeasured: [],
    beadProblems: [],
    commits: {count: 0, kind: 'counted'},
    contextTokens: null,
    handedOff: true,
    helpersInFlight: [],
    lastMessageRole: 'assistant',
    lastRecordAt: null,
    merged: {ok: true, value: 'merged'},
    openP0: 0,
    requests: {closed: 0, total: 0},
    sessionCloseReason: null,
    // statusFactsOf's first label.
    successor: S1,
    uncommitted: {ok: true, value: 0},
    wrapUpAt: null,
  };
  const labels = [`continued-by:${S1}`, `continued-by:${S2}`];
  const words = (resolved: StatusFacts): string =>
    statusWords(
      deriveStatus(resolved, {asIfYielded: false, now: new Date(2030, 0, 1)}),
    );

  test('two successors: "Handed off to" names the one created last', () => {
    const resolved = withNewestSuccessor(facts, labels, viewReader(beads()));
    expect(resolved.successor).toBe(S2);
    expect(words(resolved)).toBe(`🤝 Handed off to ${S2}`);
  });

  test('a successor that cannot be read names none, never a guess', () => {
    const resolved = withNewestSuccessor(
      facts,
      labels,
      viewReader(beads(), [S2]),
    );
    expect(resolved.successor).toBeNull();
    expect(words(resolved)).toBe('🤝 Handed off');
  });

  test('one successor: unchanged, and nothing is read', () => {
    const reads: string[] = [];
    const resolved = withNewestSuccessor(
      facts,
      [`continued-by:${S1}`],
      (id) => {
        reads.push(id);
        return {kind: 'notFound', reason: 'not read'};
      },
    );
    expect(resolved).toBe(facts);
    expect(reads).toEqual([]);
  });
});

describe('D5: a refused successor starts a new chain for the gate', () => {
  function readers(labels: readonly string[]) {
    const log: MessageLogRead = {
      failures: [],
      kind: 'read',
      lines: [
        {
          at: '2026-11-08T04:33:00Z',
          cwd: '/x',
          event: 'UserPromptSubmit',
          role: 'user',
          text: `${KICKOFF_OPENING} …`,
        },
      ],
      path: '/x/log.jsonl',
    };
    return {
      readLog: () => log,
      showBead: () => ({kind: 'found' as const, labels}),
    };
  }

  test('labelled not-a-successor: counted as the first of its chain', () => {
    expect(
      walkUnattendedChain(S2, readers(['sid:sid-s2', 'not-a-successor'])),
    ).toMatchObject({kind: 'counted', unattendedHandoffs: 0});
  });

  test('without the label: still unknown (F12), so the reassuring direction stays closed', () => {
    expect(walkUnattendedChain(S2, readers(['sid:sid-s2']))).toMatchObject({
      kind: 'unknown',
    });
  });
});
