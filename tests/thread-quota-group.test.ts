/**
 * A quota group and its unattended spend (request home-base-ys9t7.5 D2, built
 * by home-base-ys9t7.5.2): fake bead and transcript-path readers, as the
 * handoff chain tests use, over REAL transcript files in a sandbox, so the
 * streamed reader, the typed-line rule and the dedupe are the real ones.
 *
 * Every request is 1M opus output tokens: exactly 1 % of the week at
 * TEST_RATES, so a spend of N % means N requests were counted.
 */

import type {ChainBeadRead} from '../src/thread/handoff-chain';

import {afterEach, describe, expect, test} from 'bun:test';
import {join} from 'path';

import {
  attendanceOf,
  type GroupSpendReaders,
  measureGroupSpend,
  resolveQuotaGroup,
} from '../src/thread/quota-group';
import {
  assistant,
  jsonl,
  kickoff,
  TEST_RATES,
  toolResult,
  typed,
} from './quota-fixtures';
import {createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

const T0 = Date.parse('2030-01-01T09:00:00Z');
const MIN = 60_000;
const at = (minutes: number): number => T0 + minutes * MIN;

interface World {
  readers: GroupSpendReaders;
  /** Write session `sid`'s main transcript (or a subagent's, with `agent`). */
  write: (sid: string, lines: string[], agent?: string) => void;
}

function world(beads: Record<string, string[]>): World {
  const sb = createSandbox();
  sandboxes.push(sb);
  const dir = join(sb.path, 'projects', '-repo');
  return {
    readers: {
      findTranscript: (sessionId) =>
        sessionId === 'gone'
          ? {kind: 'notFound', reason: 'no gone.jsonl under /projects'}
          : {kind: 'found', path: join(dir, `${sessionId}.jsonl`)},
      showBead: (beadId): ChainBeadRead => {
        const labels = beads[beadId];
        return labels == null
          ? {kind: 'notFound', reason: 'not found in test.db'}
          : {kind: 'found', labels};
      },
    },
    write: (sid, lines, agent) => {
      sb.writeFile(
        agent == null
          ? `projects/-repo/${sid}.jsonl`
          : `projects/-repo/${sid}/subagents/agent-${agent}.jsonl`,
        jsonl(lines),
      );
    },
  };
}

/** A three-session handoff chain A → B → C. */
const CHAIN = {
  'b-a': ['session', 'sid:sa', 'continued-by:b-b'],
  'b-b': ['session', 'sid:sb', 'continues:b-a', 'continued-by:b-c'],
  'b-c': ['session', 'sid:sc', 'continues:b-b'],
};

async function measure(w: World, start: string) {
  return await measureGroupSpend(start, w.readers, {
    dollarsPerWeekPercent: TEST_RATES,
  });
}

describe('resolveQuotaGroup', () => {
  test('walks up to the root and down to every member, from any member', () => {
    const show = world(CHAIN).readers.showBead;
    for (const start of ['b-a', 'b-b', 'b-c']) {
      const group = resolveQuotaGroup(start, show);
      expect(group.kind).toBe('resolved');
      expect(group.members.map((m) => m.beadId).sort()).toEqual([
        'b-a',
        'b-b',
        'b-c',
      ]);
    }
  });

  test('two parents, a loop, a missing sid and the walk limit are unknown', () => {
    const cases: [Record<string, string[]>, string, string][] = [
      [
        {
          'b-x': ['sid:sx', 'continues:b-a', 'spawned-by:b-p'],
        },
        'b-x',
        'b-x names 2 parents (continues:b-a, spawned-by:b-p)',
      ],
      [
        {
          'b-1': ['sid:s1', 'continues:b-2'],
          'b-2': ['sid:s2', 'continues:b-1'],
        },
        'b-1',
        'the group loops back to b-1 on the way up',
      ],
      [{'b-1': ['session']}, 'b-1', 'b-1 has no sid: label'],
      [
        {
          'b-1': ['sid:s1', 'continued-by:b-2', 'continued-by:b-3'],
          'b-2': ['sid:s2'],
          'b-3': ['sid:s3'],
        },
        'b-1',
        'the group has more than 2 sessions; the walk stopped at b-3',
      ],
    ];
    for (const [beads, start, reason] of cases) {
      const group = resolveQuotaGroup(start, world(beads).readers.showBead, {
        limit: 2,
      });
      expect(group.kind).toBe('unknown');
      if (group.kind === 'unknown') expect(group.reason).toContain(reason);
    }
  });
});

describe('measureGroupSpend', () => {
  test('a 3-session handoff chain: every request after the last typed line, across all three', async () => {
    const w = world(CHAIN);
    w.write('sa', [
      assistant({atMs: at(-5), requestId: 'a0'}), // before he typed: not counted
      typed(at(0)),
      assistant({atMs: at(1), requestId: 'a1'}),
      toolResult(at(2)),
    ]);
    w.write('sb', [
      kickoff(at(10)),
      assistant({atMs: at(11), requestId: 'b1'}),
    ]);
    w.write('sc', [
      kickoff(at(20)),
      assistant({atMs: at(21), requestId: 'c1'}),
    ]);
    const spend = await measure(w, 'b-c');
    expect(spend.kind).toBe('known');
    if (spend.kind !== 'known') return;
    expect(spend.root).toBe('b-a');
    expect(spend.latestTypedAtMs).toBe(at(0));
    expect(spend.requests).toBe(3);
    expect(spend.firstUnattendedAtMs).toBe(at(1));
    expect(spend.spend.weekPercent).toBe(3);
    expect(spend.spend.byFamily.opus.usd).toBe(60);
  });

  test("a spawned child counts in its parent's group, from either end", async () => {
    const w = world({
      'b-k': ['sid:sk', 'spawned-by:b-p'],
      'b-p': ['sid:sp', 'spawned:b-k'],
    });
    w.write('sp', [typed(at(0)), assistant({atMs: at(1), requestId: 'p1'})]);
    w.write('sk', [kickoff(at(2)), assistant({atMs: at(3), requestId: 'k1'})]);
    for (const start of ['b-p', 'b-k']) {
      const spend = await measure(w, start);
      expect(spend.kind).toBe('known');
      if (spend.kind === 'known') expect(spend.spend.weekPercent).toBe(2);
    }
  });

  // D8, home-base-ys9t7.5.4 item 3: the kickoff `thread spawn` typed is not
  // Justin typing. The child's bead carries spawn-kickoff, and its first
  // prompt is dropped by position.
  const SPAWNED = {
    'b-k': ['sid:sk', 'spawned-by:b-p', 'spawn-kickoff'],
    'b-p': ['sid:sp', 'spawned:b-k'],
  };
  const slashKickoff = (atMs: number): string =>
    typed(atMs, '/conductor Work on x-1: run br show x-1 first.');

  test("a spawned child's kickoff is not typed: the group stays unattended from the parent's last line", async () => {
    for (const labelled of [true, false]) {
      const beads = labelled
        ? SPAWNED
        : {...SPAWNED, 'b-k': ['sid:sk', 'spawned-by:b-p']};
      const w = world(beads);
      w.write('sp', [typed(at(0)), assistant({atMs: at(1), requestId: 'p1'})]);
      w.write('sk', [
        slashKickoff(at(5)),
        assistant({atMs: at(6), requestId: 'k1'}),
        toolResult(at(7)),
        assistant({atMs: at(8), requestId: 'k2'}),
      ]);
      for (const start of ['b-p', 'b-k']) {
        const spend = await measure(w, start);
        expect(spend.kind).toBe('known');
        if (spend.kind !== 'known') continue;
        // Without the label the kickoff reads as typed: that is what the
        // label exists to stop (the control half of this test).
        expect(spend.latestTypedAtMs).toBe(labelled ? at(0) : at(5));
        expect(spend.requests).toBe(labelled ? 3 : 2);
      }
    }
  });

  test('in a spawned child, a line Justin types after the kickoff still counts', async () => {
    const w = world(SPAWNED);
    w.write('sp', [typed(at(0)), assistant({atMs: at(1), requestId: 'p1'})]);
    w.write('sk', [
      slashKickoff(at(5)),
      assistant({atMs: at(6), requestId: 'k1'}),
      typed(at(10), 'Justin, from his phone'),
      assistant({atMs: at(11), requestId: 'k2'}),
    ]);
    const spend = await measure(w, 'b-k');
    expect(spend.kind).toBe('known');
    if (spend.kind !== 'known') return;
    expect(spend.latestTypedAtMs).toBe(at(10));
    expect(spend.requests).toBe(1);
  });

  test("a kickoff that does not read as typed (a bare /loop-session) is still the one dropped, never Justin's first line", async () => {
    const w = world(SPAWNED);
    w.write('sp', [assistant({atMs: at(1), requestId: 'p1'})]);
    w.write('sk', [
      typed(at(5), '<command-name>/loop-session</command-name>'),
      assistant({atMs: at(6), requestId: 'k1'}),
      typed(at(10), 'Justin, from his phone'),
      assistant({atMs: at(11), requestId: 'k2'}),
    ]);
    const spend = await measure(w, 'b-k');
    expect(spend.kind).toBe('known');
    if (spend.kind === 'known') expect(spend.latestTypedAtMs).toBe(at(10));
  });

  test('the missing link: a kickoff child with no spawned-by is its own group, every request counted, never attended', async () => {
    const w = world({'b-k': ['sid:sk', 'spawn-kickoff']});
    w.write('sk', [
      slashKickoff(at(5)),
      assistant({atMs: at(6), requestId: 'k1'}),
      assistant({atMs: at(7), requestId: 'k2'}),
    ]);
    const spend = await measure(w, 'b-k');
    expect(spend.kind).toBe('known');
    if (spend.kind !== 'known') return;
    expect(spend.members.map((m) => m.beadId)).toEqual(['b-k']);
    expect(spend.latestTypedAtMs).toBeNull();
    expect(spend.requests).toBe(2);
    // One minute after its kickoff, well inside the grace: still unattended.
    expect(attendanceOf(spend.typed, at(6), 30).kind).toBe('unattended');
  });

  test('a typed line in the middle member resets the window for the whole group', async () => {
    const w = world(CHAIN);
    // A typed at 0 and is still working; B's own typed line at 15 is the newest.
    w.write('sa', [
      typed(at(0)),
      assistant({atMs: at(1), requestId: 'a1'}), // before 15: not counted
      assistant({atMs: at(30), requestId: 'a2'}), // after 15: counted
    ]);
    w.write('sb', [
      kickoff(at(10)),
      assistant({atMs: at(11), requestId: 'b1'}), // before 15: not counted
      typed(at(15), 'Justin steps in on B'),
      assistant({atMs: at(16), requestId: 'b2'}), // counted
    ]);
    w.write('sc', [
      kickoff(at(20)),
      assistant({atMs: at(21), requestId: 'c1'}),
    ]); // counted
    const spend = await measure(w, 'b-c');
    expect(spend.kind).toBe('known');
    if (spend.kind !== 'known') return;
    expect(spend.latestTypedAtMs).toBe(at(15));
    expect(spend.spend.weekPercent).toBe(3);
    expect(spend.firstUnattendedAtMs).toBe(at(16));
  });

  test('subagent requests are included, and a request in two files counts once', async () => {
    const w = world({'b-s': ['sid:ss']});
    w.write('ss', [
      typed(at(0)),
      assistant({atMs: at(1), requestId: 'm1'}),
      assistant({atMs: at(2), requestId: 'shared'}),
    ]);
    w.write(
      'ss',
      [
        typed(at(1), 'the brief the parent gave the subagent'),
        assistant({atMs: at(2), requestId: 'shared', sidechain: true}),
        assistant({atMs: at(3), requestId: 's1', sidechain: true}),
      ].map((line) =>
        line.replace('{"message"', '{"isSidechain":true,"message"'),
      ),
      'a1',
    );
    const spend = await measure(w, 'b-s');
    expect(spend.kind).toBe('known');
    if (spend.kind !== 'known') return;
    expect(spend.members[0]?.files).toHaveLength(2);
    // m1, shared (once), s1. The subagent's brief is a sidechain record, not typed.
    expect(spend.requests).toBe(3);
    expect(spend.latestTypedAtMs).toBe(at(0));
  });

  test('an unreadable member makes the whole group unknown', async () => {
    const missing = world({
      'b-a': ['sid:sa', 'continued-by:b-b'],
      'b-b': ['sid:gone', 'continues:b-a'],
    });
    missing.write('sa', [
      typed(at(0)),
      assistant({atMs: at(1), requestId: 'a1'}),
    ]);
    const spend = await measure(missing, 'b-a');
    expect(spend).toMatchObject({
      kind: 'unknown',
      lowerBound: null,
      reason:
        'the transcript of b-b (session gone): no gone.jsonl under /projects',
      // Item 1: the members that WERE read still give their typed lines, so
      // a recent one can prove the group attended.
      typed: {
        kind: 'partial',
        latestTypedAtMs: at(0),
        reason:
          'the transcript of b-b (session gone): no gone.jsonl under /projects',
      },
    });

    // A transcript the reader cannot open (here: no file at the path).
    const unopened = world(CHAIN);
    unopened.write('sa', [typed(at(0))]);
    unopened.write('sc', [kickoff(at(20))]);
    const result = await measure(unopened, 'b-c');
    expect(result.kind).toBe('unknown');
    if (result.kind === 'unknown') {
      expect(result.reason).toContain('sb.jsonl (b-b) could not be read');
    }
  });

  test('a request or a typed line with no timestamp is unknown, never "before"', async () => {
    const w = world({'b-s': ['sid:ss']});
    w.write('ss', [
      typed(at(0)),
      assistant({atMs: at(1), requestId: 'm1'}).replace(
        /"timestamp":"[^"]*",/,
        '',
      ),
    ]);
    const spend = await measure(w, 'b-s');
    expect(spend.kind).toBe('unknown');
    if (spend.kind === 'unknown') {
      expect(spend.reason).toContain(
        '1 request(s) in the group carry no timestamp',
      );
    }
  });
});
