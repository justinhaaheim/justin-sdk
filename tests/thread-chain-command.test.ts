/**
 * home-base-lasun L3 and L5: `thread chain [member]` lists a chain's
 * sessions in order, and a chain name is a target for `thread show` and
 * `thread focus`.
 */

import type {
  ChainBead,
  ChainBeadLookup,
  ChainWalkReaders,
} from '../src/thread/chain-walk';
import type {MessageLogRead} from '../src/thread/message-log';

import {afterEach, describe, expect, test} from 'bun:test';
import {mkdtempSync, rmSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {
  chainListing,
  chainTargetOf,
  endingText,
  newestOfChainName,
  renderChainListing,
  runThreadChain,
} from '../src/thread/chain-command';
import {walkChain} from '../src/thread/chain-walk';
import {captureWriteStdout} from './capture-stdout';

function bead(
  id: string,
  links: {continuedBy?: string; continues?: string; extra?: string[]} = {},
  status = 'open',
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
      ...(links.extra ?? []),
    ],
    notes: null,
    status,
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

const logs: Record<string, MessageLogRead> = {
  'a-session': {
    failures: [],
    kind: 'read',
    lines: [
      {
        at: '2026-11-06T13:49:00.000Z',
        cwd: '/r',
        event: 'x',
        role: 'user',
        text: 'hi',
      },
      {
        at: '2026-11-06T15:00:00.000Z',
        cwd: '/r',
        event: 'x',
        role: 'assistant',
        text: 'ok',
      },
    ],
    path: '/logs/a-session.jsonl',
  },
  'c-session': {kind: 'missing', path: '/logs/c-session.jsonl'},
} as unknown as Record<string, MessageLogRead>;

const readLog = (sessionId: string): MessageLogRead =>
  logs[sessionId] ?? {kind: 'missing', path: `/logs/${sessionId}.jsonl`};

// a → b → c, c closed (done); b handed off by being followed.
const beads = [
  bead('a', {continuedBy: 'b', extra: ['handed-off']}),
  bead('b', {continuedBy: 'c', continues: 'a'}),
  bead('c', {continues: 'b'}, 'closed'),
];

describe('thread chain (home-base-lasun L3)', () => {
  test('lists every session oldest first with its dates, status and how it ended', () => {
    const walk = walkChain('b', readersOf(beads), {
      chainNameOfRoot: () => 'Scorpio',
    });
    if (walk.kind === 'failed') throw new Error(walk.reason);
    const entries = chainListing(walk, readLog);
    expect(entries.map((entry) => entry.member.name)).toEqual([
      '[Scorpio]',
      '[Scorpio-1]',
      '[Scorpio-2]',
    ]);
    expect(entries.map((entry) => endingText(entry.ending))).toEqual([
      'handed off at an unknown time (no dated "handed off" note line)',
      'handed off',
      'done',
    ]);
    expect(entries[0]?.startedAt).toBe('2026-11-06T13:49:00.000Z');
    expect(entries[0]?.lastActiveAt).toBe('2026-11-06T15:00:00.000Z');
    // A missing log is an unknown date with its reason, never a date.
    expect(entries[2]?.startedAt).toBeNull();
    expect(entries[2]?.logProblem).toBe(
      'no message log at /logs/c-session.jsonl',
    );
    const text = renderChainListing(walk, entries, {color: false, width: null});
    expect(text).toContain('⛓️ Chain Scorpio: 3 sessions, oldest first');
    expect(text).toContain(
      '[Scorpio-1] title of b (the session you named)\n      Session:      b-session\n      Bead:         b\n',
    );
    expect(text).toContain('      Ended:        done');
  });

  test('a chain read only in part says so above the list and exits 2', async () => {
    const readers = readersOf([bead('d', {continues: 'gone'})]);
    const out: string[] = [];
    const spy = captureWriteStdout((text) => out.push(text));
    let code: number;
    try {
      code = await runThreadChain({
        color: false,
        env: {},
        member: 'd',
        readLog,
        readers,
        width: null,
      });
    } finally {
      spy.mockRestore();
    }
    expect(code).toBe(2);
    const printed = out.join('');
    expect(printed).toContain(
      '⚠️ The chain is incomplete: d names continues:gone',
    );
    expect(printed).toContain('title of d (the session you named)');
  });
});

describe('a chain name as a target (home-base-lasun L5)', () => {
  let dir: null | string = null;
  afterEach(() => {
    if (dir != null) rmSync(dir, {force: true, recursive: true});
    dir = null;
  });
  const registry = (): Record<string, string> => {
    dir = mkdtempSync(join(tmpdir(), 'chain-target-'));
    writeFileSync(
      join(dir, 'chain-names.jsonl'),
      `${JSON.stringify({assignedAt: '2026-11-14T16:17:45.805Z', name: 'Scorpio', root: 'a'})}\n`,
    );
    return {JUSTIN_THREADS_STATE_DIR: dir};
  };

  test('a registered name resolves to its root, any case; anything else passes through', () => {
    const env = registry();
    expect(chainTargetOf('scorpio', env)).toEqual({
      kind: 'chain',
      name: 'Scorpio',
      root: 'a',
    });
    expect(chainTargetOf('home-base-yf73y', env)).toEqual({kind: 'notAName'});
    expect(chainTargetOf('Herb', env)).toEqual({kind: 'notAName'});
  });

  test('thread show gets the newest session of the named chain', () => {
    const env = registry();
    expect(
      newestOfChainName({
        cwd: '/',
        env,
        readers: readersOf(beads),
        value: 'Scorpio',
      }),
    ).toEqual({beadId: 'c', kind: 'newest', name: '[Scorpio-2]'});
    // A chain whose walk forward stops short is refused, never its last read session.
    const forked = [
      bead('a', {continuedBy: 'b'}),
      {
        ...bead('b', {continues: 'a'}),
        labels: ['sid:b', 'continues:a', 'continued-by:c', 'continued-by:e'],
      },
    ];
    const refused = newestOfChainName({
      cwd: '/',
      env,
      readers: readersOf(forked),
      value: 'Scorpio',
    });
    expect(refused.kind).toBe('failed');
  });
});
