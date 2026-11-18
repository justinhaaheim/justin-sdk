/**
 * home-base-lasun L1: `thread search` groups its hits by handoff chain, with
 * the one chain walk (chain-walk.ts) deciding which chain a session is in.
 */

import type {
  ChainBead,
  ChainBeadLookup,
  ChainWalkReaders,
} from '../src/thread/chain-walk';
import type {SearchRow, SessionBeadLookup} from '../src/thread/search';

import {describe, expect, test} from 'bun:test';

import {walkChain} from '../src/thread/chain-walk';
import {
  chainProblems,
  groupByChain,
  groupHeading,
  renderSearchGroup,
} from '../src/thread/search-chains';

function bead(
  id: string,
  links: {continuedBy?: string; continues?: string} = {},
): ChainBead {
  return {
    beadsDir: '/fake/.beads',
    id,
    labels: [
      `sid:${id}-session`,
      ...(links.continues == null ? [] : [`continues:${links.continues}`]),
      ...(links.continuedBy == null
        ? []
        : [`continued-by:${links.continuedBy}`]),
    ],
    notes: null,
    status: 'open',
    title: `title of ${id}`,
  };
}

function readersOf(beads: readonly ChainBead[]): ChainWalkReaders {
  const byId = new Map(beads.map((entry) => [entry.id, entry]));
  return {
    findContinuing: (beadId) => ({
      ids: beads
        .filter((entry) => entry.labels.includes(`continues:${beadId}`))
        .map((entry) => entry.id),
      kind: 'read',
    }),
    readBead: (beadId): ChainBeadLookup => {
      const found = byId.get(beadId);
      return found == null
        ? {kind: 'notFound', reason: `${beadId} is not in the fixture`}
        : {bead: found, kind: 'found'};
    },
  };
}

/** A matched row of session `<id>-session`, its session bead as given. */
function row(sessionId: string, sessionBead: SessionBeadLookup): SearchRow {
  const hit = {
    field: 'title',
    section: null,
    snippet: {after: '', before: '', match: 'Apple TV'},
    writtenAt: null,
  };
  return {
    activityAt: null,
    archivedReports: 0,
    chain: null,
    hit,
    hits: [hit],
    matchedFields: ['title'],
    placedRepo: null,
    repo: 'home-base',
    resumeCommand: `claude --resume ${sessionId}`,
    sessionBead,
    sessionId,
    threadId: null,
    title: `row ${sessionId}`,
  };
}

const found = (beadId: string): SessionBeadLookup => ({
  beadId,
  kind: 'found',
  title: `title of ${beadId}`,
});

// a → b → c is one chain (root a); x stands alone.
const chainBeads = [
  bead('a', {continuedBy: 'b'}),
  bead('b', {continuedBy: 'c', continues: 'a'}),
  bead('c', {continues: 'b'}),
  bead('x'),
];

describe('groupByChain (home-base-lasun L1)', () => {
  test('two sessions of one chain land in ONE block keyed by its root, with its newest session', () => {
    const readers = readersOf(chainBeads);
    const walked: string[] = [];
    const groups = groupByChain(
      [
        row('c-session', found('c')),
        row('x-session', found('x')),
        row('a-session', found('a')),
      ],
      {
        resumeOf: (sessionId) => `cd /repo && claude --resume ${sessionId}`,
        walkOf: (beadId) => {
          walked.push(beadId);
          return walkChain(beadId, readers, {
            chainNameOfRoot: (root) => (root === 'a' ? 'Scorpio' : null),
          });
        },
      },
    );
    expect(groups.map((group) => group.chain.key)).toEqual(['a', 'x']);
    const [scorpio, alone] = groups;
    expect(scorpio?.rows.map((entry) => entry.sessionId)).toEqual([
      'c-session',
      'a-session',
    ]);
    expect(scorpio?.chain.name).toBe('Scorpio');
    expect(scorpio?.chain.sessions).toBe(3);
    expect(scorpio?.chain.newest?.beadId).toBe('c');
    expect(scorpio?.chain.newest?.resumeCommand).toBe(
      'cd /repo && claude --resume c-session',
    );
    expect(alone?.rows.map((entry) => entry.sessionId)).toEqual(['x-session']);
    // Every row carries the chain it was placed in.
    expect(scorpio?.rows.every((entry) => entry.chain?.key === 'a')).toBe(true);
    // The chain of a and c was walked once: a member's walk is reused.
    expect(walked).toEqual(['c', 'x']);
    expect(chainProblems(groups)).toEqual([]);
    expect(scorpio == null ? null : groupHeading(scorpio)).toBe(
      'Chain Scorpio: 2 of 3 sessions matched',
    );
  });

  test('a session with no session bead is its own block, marked as having no chain', () => {
    const groups = groupByChain(
      [
        row('s1', {kind: 'none', reason: 'the index records none'}),
        row('s2', {kind: 'none', reason: 'the index records none'}),
      ],
      {resumeOf: () => null, walkOf: () => ({kind: 'failed', reason: 'never'})},
    );
    expect(groups.map((group) => group.chain.kind)).toEqual([
      'noChain',
      'noChain',
    ]);
    expect(groups[0]?.chain.noChainReason).toBe('the index records none');
    expect(chainProblems(groups)).toEqual([]);
  });

  test('a chain that cannot be read is an unknown block and a problem, never merged', () => {
    const readers = readersOf([bead('d', {continues: 'gone'})]);
    const groups = groupByChain(
      [
        row('d-session', found('d')),
        row('u-session', {kind: 'unknown', reason: 'the export is locked'}),
      ],
      {
        resumeOf: () => null,
        walkOf: (beadId) => walkChain(beadId, readers),
      },
    );
    expect(groups.map((group) => group.chain.kind)).toEqual([
      'unknown',
      'unknown',
    ]);
    expect(groups[0]?.chain.root).toBeNull();
    const problems = chainProblems(groups);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('gone could not be read');
    expect(problems[1]).toContain('the export is locked');
  });

  test('a block renders its heading, its newest session and its rows one step in', () => {
    const readers = readersOf(chainBeads);
    const [group] = groupByChain([row('b-session', found('b'))], {
      resumeOf: () => 'claude --resume c-session',
      walkOf: (beadId) => walkChain(beadId, readers),
    });
    if (group == null) throw new Error('no group');
    // A row renders its title at the header column, so one step in puts it
    // at the body column.
    const text = renderSearchGroup(group, () => '  ROW TITLE', {
      color: false,
      width: null,
    });
    expect(text.split('\n')).toEqual([
      '  ⛓️ Chain of a: 1 of 3 sessions matched',
      '      Newest:      [#2] title of c',
      '      Resume:      claude --resume c-session',
      '',
      '      ROW TITLE',
    ]);
  });
});
