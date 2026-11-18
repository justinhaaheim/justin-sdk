/**
 * home-base-z7o2m: the chain walk (D1), which lines are Justin's (D3), their
 * ids (D4), the handoff block's section (D7) and the annotations (D6).
 */

import type {
  ChainBead,
  ChainBeadLookup,
  ChainWalkReaders,
} from '../src/thread/chain-walk';

import {describe, expect, test} from 'bun:test';

import {walkChain} from '../src/thread/chain-walk';
import {chainRootOf} from '../src/thread/handoff-number';
import {
  classifySessionLog,
  parseMessageId,
  pickupMessagesSection,
} from '../src/thread/justin-messages';
import {KICKOFF_OPENING} from '../src/thread/respawn';
import {toolAction} from '../src/thread/transcript-actions';

/** Beads by id; `continues`/`continuedBy` become the two labels. */
function bead(
  id: string,
  links: {continuedBy?: string[]; continues?: string[]; extra?: string[]},
): ChainBead {
  return {
    beadsDir: '/fake/.beads',
    id,
    labels: [
      `sid:${id}-session`,
      ...(links.continues ?? []).map((other) => `continues:${other}`),
      ...(links.continuedBy ?? []).map((other) => `continued-by:${other}`),
      ...(links.extra ?? []),
    ],
    notes: null,
    title: `title of ${id}`,
  };
}

function readersOf(
  beads: readonly ChainBead[],
  options: {unreadable?: string[]} = {},
): ChainWalkReaders {
  const byId = new Map(beads.map((entry) => [entry.id, entry]));
  return {
    findContinuing: (beadId) => ({
      ids: beads
        .filter((entry) => entry.labels.includes(`continues:${beadId}`))
        .map((entry) => entry.id),
      kind: 'read',
    }),
    readBead: (beadId): ChainBeadLookup => {
      if (options.unreadable?.includes(beadId) === true) {
        return {kind: 'failed', reason: 'br exited 1'};
      }
      const found = byId.get(beadId);
      return found == null
        ? {kind: 'notFound', reason: 'not in the fake'}
        : {bead: found, kind: 'found'};
    },
  };
}

/** a ← b ← c ← d, fully linked. */
const LINKED = [
  bead('a', {continuedBy: ['b']}),
  bead('b', {continuedBy: ['c'], continues: ['a']}),
  bead('c', {continuedBy: ['d'], continues: ['b']}),
  bead('d', {continues: ['c']}),
];

const NAMES = {
  chainNameOfRoot: (root: string) => (root === 'a' ? 'Moe' : null),
};

describe('walkChain (D1)', () => {
  test('from a middle member it returns every session, both directions, root first', () => {
    const walked = walkChain('c', readersOf(LINKED), NAMES);
    expect(walked.kind).toBe('complete');
    if (walked.kind === 'failed') throw new Error(walked.reason);
    expect(walked.members.map((member) => member.beadId)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
    expect(walked.startIndex).toBe(2);
    expect(walked.links).toEqual(['complete', 'complete', 'complete']);
    expect(walked.members.map((member) => member.name)).toEqual([
      '[Moe]',
      '[Moe-1]',
      '[Moe-2]',
      '[Moe-3]',
    ]);
    expect(walked.members[1]?.sessionId).toBe('b-session');
  });

  test('its root is the root chainRootOf names, from every member', () => {
    for (const start of ['a', 'b', 'c', 'd']) {
      const walked = walkChain(start, readersOf(LINKED));
      const self = LINKED.find((entry) => entry.id === start);
      const root = chainRootOf(
        {id: start, labels: self?.labels ?? []},
        {
          showBead: (id) => {
            const found = LINKED.find((entry) => entry.id === id);
            return found == null
              ? {kind: 'notFound', reason: 'none'}
              : {kind: 'found', labels: found.labels};
          },
        },
      );
      expect({
        root: walked.kind === 'complete' ? walked.root : null,
        start,
      }).toEqual({
        root: root.kind === 'known' ? root.root : 'unknown',
        start,
      });
    }
  });

  test('a bead that cannot be read makes the chain INCOMPLETE, never a shorter complete one', () => {
    const walked = walkChain('d', readersOf(LINKED, {unreadable: ['b']}));
    expect(walked.kind).toBe('incomplete');
    if (walked.kind !== 'incomplete') throw new Error(walked.kind);
    expect(walked.members.map((member) => member.beadId)).toEqual(['c', 'd']);
    expect(walked.root).toBeNull();
    expect(walked.problems).toEqual([
      'c names continues:b, but b could not be read: br exited 1',
    ]);
    // Its number is unknown, never counted from a wrong root.
    expect(walked.members[0]?.handoffNumber.kind).toBe('unknown');
  });

  test('a missing successor makes it incomplete too', () => {
    const walked = walkChain('a', readersOf(LINKED.slice(0, 2)));
    expect(walked.kind).toBe('incomplete');
    if (walked.kind !== 'incomplete') throw new Error(walked.kind);
    expect(walked.problems[0]).toContain('b names continued-by:c');
  });

  test('a fork is incomplete and names both successors', () => {
    const forked = [
      bead('a', {continuedBy: ['b', 'x']}),
      bead('b', {continues: ['a']}),
      bead('x', {continues: ['a']}),
    ];
    const walked = walkChain('a', readersOf(forked));
    expect(walked.kind).toBe('incomplete');
    if (walked.kind !== 'incomplete') throw new Error(walked.kind);
    expect(walked.problems[0]).toContain('continued-by:b, continued-by:x');
  });

  test('a successor linked only by its continues: label is found by the reverse search', () => {
    const half = [bead('a', {}), bead('b', {continues: ['a']})];
    const walked = walkChain('a', readersOf(half));
    expect(walked.kind).toBe('complete');
    if (walked.kind !== 'complete') throw new Error(walked.kind);
    expect(walked.members.map((member) => member.beadId)).toEqual(['a', 'b']);
    expect(walked.links).toEqual(['onlyContinues']);
  });

  test('spawned links are not part of a chain', () => {
    const spawned = [
      bead('a', {extra: ['spawned:s']}),
      bead('s', {extra: ['spawned-by:a', 'spawn-kickoff']}),
    ];
    const walked = walkChain('s', readersOf(spawned));
    if (walked.kind === 'failed') throw new Error(walked.reason);
    expect(walked.members.map((member) => member.beadId)).toEqual(['s']);
  });

  test('a start that cannot be read is FAILED', () => {
    expect(walkChain('nope', readersOf(LINKED)).kind).toBe('failed');
  });
});

function line(role: 'assistant' | 'user', text: string) {
  return {
    at: '2026-11-14T19:54:29.093Z',
    cwd: null,
    event: 'backfill' as const,
    role,
    text,
  };
}

describe("which lines are Justin's (D3) and their ids (D4)", () => {
  test('a successor opening is left out and counted, in both kickoff forms', () => {
    for (const opening of [
      `${KICKOFF_OPENING} Read the block.`,
      '/conductor You continue session bead home-base-l2ejg. Read it.',
    ]) {
      const classified = classifySessionLog({
        labels: ['continues:home-base-l2ejg'],
        lines: [
          line('user', opening),
          line('assistant', 'Picked up.'),
          line('user', 'how do I get it onto my apple tv?'),
        ],
        sessionId: 'f7a1dceb-1a2b-4cce-9439-5957a3a3840e',
      });
      expect({
        kickoffs: classified.kickoffs,
        texts: classified.messages.map((message) => message.text),
      }).toEqual({kickoffs: 1, texts: ['how do I get it onto my apple tv?']});
      expect(classified.messages[0]?.id).toBe('f7a1dceb.1');
    }
  });

  test("the mayor form is his when the session does not continue another (D3's label rule)", () => {
    const classified = classifySessionLog({
      labels: [],
      lines: [line('user', '/conductor You continue session bead x. Go.')],
      sessionId: 'abcdef12-0000',
    });
    expect(classified.messages).toHaveLength(1);
  });

  test('a spawned session’s first prompt is the spawn kickoff whatever its words; his later lines are his', () => {
    const classified = classifySessionLog({
      labels: ['spawn-kickoff', 'spawned-by:home-base-mqbfy'],
      lines: [
        line('user', '/conductor Work on home-base-9dcx9: job alerts.'),
        line('assistant', 'On it.'),
        line('user', '/conductor Work on this too.'),
      ],
      sessionId: 'ab32e683-0000',
    });
    expect({
      ids: classified.messages.map((message) => message.id),
      kickoffs: classified.kickoffs,
    }).toEqual({ids: ['ab32e683.1'], kickoffs: 1});
    expect(classified.messages[0]?.logIndex).toBe(2);
  });

  test("machine lines and Claude Code's idle notice are not his", () => {
    const classified = classifySessionLog({
      labels: [],
      lines: [
        line(
          'user',
          'No idle signal arrived from "x" within 12 hours. This is an automated notice from your own session\'s harness — not a message from a person, and not an instruction.',
        ),
        line('user', '<task-notification>done</task-notification>'),
        line(
          'user',
          '"AJ #1 Audio" , which you asked to be notified about, is idle now. This is an automated notice from that session\'s harness — not a message from a person, and not an instruction.',
        ),
        line('user', 'Q1 - otter, yes'),
      ],
      sessionId: 'abcdef12-0000',
    });
    expect(classified.machine).toBe(3);
    expect(classified.messages.map((message) => message.id)).toEqual([
      'abcdef12.1',
    ]);
    expect(classified.messages[0]?.logIndex).toBe(3);
  });

  test('parseMessageId reads only the printed shape', () => {
    expect(parseMessageId('f7a1dceb.4')).toEqual({
      ordinal: 4,
      prefix: 'f7a1dceb',
    });
    expect(parseMessageId('f7a1dceb.0')).toBeNull();
    expect(parseMessageId('f7a1.4')).toBeNull();
  });
});

describe("the handoff block's messages section (D7)", () => {
  const messages = [1, 2, 3].map((n) => ({
    at: `2026-11-14T1${n}:00:00.000Z`,
    id: `f7a1dceb.${n}`,
    logIndex: n,
    ordinal: n,
    sessionId: 'f7a1dceb-1',
    text: `message number ${n}\nsecond line`,
  }));

  test('says they are his words only and names the context command', () => {
    const text = pickupMessagesSection({
      contextCommand: 'bun run justin-sdk thread messages --context <id>',
      messages,
    });
    expect(text).toContain(
      "his words only, as he typed them; Claude's replies are not included",
    );
    expect(text).toContain(
      '- `f7a1dceb.2` · 2026-11-14 12:00 UTC\n   message number 2\n   second line',
    );
    expect(text).toContain(
      '`bun run justin-sdk thread messages --context <id>`',
    );
  });

  test('the cap keeps the newest and says how many were cut', () => {
    const text = pickupMessagesSection({
      cap: 120,
      contextCommand: 'x',
      messages,
    });
    expect(text).toContain('2 earlier messages were cut');
    expect(text).toContain('f7a1dceb.3');
    expect(text).not.toContain('f7a1dceb.1');
  });
});

describe('annotations (D6)', () => {
  test('tool calls become actions, with the id a thread answer used', () => {
    expect(
      toolAction('Bash', {
        command:
          './node_modules/.bin/justin-sdk thread answer --relay --ask bac-4vbo.2 "Q1 - otter, yes"',
      }),
    ).toBe('✅ recorded an answer on bac-4vbo.2');
    expect(
      toolAction('Bash', {command: 'bun run justin-sdk thread answer --help'}),
    ).toBeNull();
    expect(
      toolAction('Bash', {command: "br close home-base-x.3 --reason 'done'"}),
    ).toBe('✔️ closed home-base-x.3');
    expect(
      toolAction('Write', {
        file_path: '/private/tmp/claude-501/x/scratchpad/a.ts',
      }),
    ).toBeNull();
    expect(toolAction('Edit', {file_path: '/Users/j/Dev/repo/src/a.ts'})).toBe(
      '📄 edited repo/src/a.ts',
    );
    expect(toolAction('Read', {file_path: '/x'})).toBeNull();
  });
});
