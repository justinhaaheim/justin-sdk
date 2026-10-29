/**
 * The chain walk (epic home-base-mbnjv D2, built by home-base-mbnjv.1 item 5):
 * real br session beads linked by `continues:` labels and real message logs
 * in a $TMPDIR state dir, walked through the real readers; the edge cases
 * (loops, two predecessors, no sid) through fake ones.
 */

import type {MessageLogRead} from '../src/thread/message-log';
import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, test} from 'bun:test';
import {mkdirSync, writeFileSync} from 'fs';
import {join} from 'path';

import {brUpdate, runBr} from '../src/beads/br';
import {
  type ChainBeadRead,
  realChainReaders,
  walkUnattendedChain,
} from '../src/thread/handoff-chain';
import {kickoffText} from '../src/thread/respawn';
import {ensureSessionBead} from '../src/thread/session-bead';
import {initRepo} from './git-fixtures';
import {needBr} from './pinned-br';
import {createSandbox} from './sandbox';

/** A real kickoff, as thread handoff types it (F12 reads its opening). */
const KICKOFF = kickoffText('/state/handoffs/x.md', 't-prev', null);

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

const SIDS = [
  '0c000000-1111-4222-8333-000000000001',
  '0c000000-1111-4222-8333-000000000002',
  '0c000000-1111-4222-8333-000000000003',
  '0c000000-1111-4222-8333-000000000004',
];

interface ChainWorld {
  /** Bead ids in chain order: [0] is the first session, [3] the caller. */
  beads: string[];
  cwd: string;
  db: string;
  env: Record<string, string | undefined>;
  messagesDir: string;
}

function logLine(role: 'assistant' | 'user', text: string): string {
  return JSON.stringify({
    at: '2030-01-01T09:00:00.000Z',
    cwd: '/repo',
    event: role === 'user' ? 'UserPromptSubmit' : 'Stop',
    role,
    text,
  });
}

/** A log holding the kickoff and its reply, plus `typed` more prompts. */
function writeLog(world: ChainWorld, index: number, typed: number): void {
  const lines = [
    logLine('user', index === 0 ? 'Justin starts the work' : KICKOFF),
    logLine('assistant', 'on it'),
  ];
  for (let i = 0; i < typed; i += 1) {
    lines.push(logLine('user', `Justin says ${i}`));
    lines.push(logLine('assistant', 'ok'));
  }
  writeFileSync(
    join(world.messagesDir, `${SIDS[index]}.jsonl`),
    `${lines.join('\n')}\n`,
  );
}

/** Four session beads, each `continues:` the one before it. */
function chainWorld(): ChainWorld {
  needBr();
  const sb = createSandbox();
  sandboxes.push(sb);
  const stateDir = join(sb.path, 'state');
  const env: Record<string, string | undefined> = {
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    HOME: join(sb.path, 'home'),
    JUSTIN_SDK_HEALTH_NOTICES: 'off',
    JUSTIN_THREADS_STATE_DIR: stateDir,
    JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(sb.path, 'projects'),
    XDG_CONFIG_HOME: join(sb.path, 'xdg'),
  };
  const cwd = initRepo(sb, 'chain-repo', {'README.md': '# r\n'});
  const init = runBr(cwd, ['init', '--prefix', 't', '-q']);
  if (!init.ok) throw new Error(`br init failed: ${init.reason ?? '?'}`);
  const db = join(cwd, '.beads', 'beads.db');
  const beads: string[] = [];
  for (const [index, sessionId] of SIDS.entries()) {
    const filed = ensureSessionBead({
      cwd,
      env,
      firstPrompt: {at: '2030-01-01T09:00:00.000Z', text: `session ${index}`},
      now: new Date('2030-01-01T09:00:00.000Z'),
      sessionId,
    });
    if (filed.kind !== 'created') throw new Error(filed.detail);
    const previous = beads.at(-1);
    if (previous != null) {
      const linked = brUpdate({db, env}, filed.beadId, {
        addLabels: [`continues:${previous}`],
      });
      if (linked.kind === 'failed') throw new Error(linked.reason);
    }
    beads.push(filed.beadId);
  }
  const messagesDir = join(stateDir, 'messages');
  mkdirSync(messagesDir, {recursive: true});
  return {beads, cwd, db, env, messagesDir};
}

function walk(world: ChainWorld) {
  const caller = world.beads[3];
  if (caller == null) throw new Error('no caller bead');
  return walkUnattendedChain(
    caller,
    realChainReaders({cwd: world.cwd, env: world.env}),
  );
}

describe('walkUnattendedChain on real beads and logs', () => {
  test('four sessions, the second attended: 2 handoffs since Justin typed', () => {
    const world = chainWorld();
    // The first session's log is never needed: a chain's first session counts
    // as attended. The second has a prompt after its kickoff; the third and
    // the caller hold only their kickoffs.
    writeLog(world, 1, 1);
    writeLog(world, 2, 0);
    writeLog(world, 3, 0);
    const chain = walk(world);
    expect(chain).toEqual({
      kind: 'counted',
      links: [
        {
          attendance: 'unattended',
          beadId: world.beads[3] ?? '',
          continues: world.beads[2] ?? '',
          sessionId: SIDS[3] ?? '',
        },
        {
          attendance: 'unattended',
          beadId: world.beads[2] ?? '',
          continues: world.beads[1] ?? '',
          sessionId: SIDS[2] ?? '',
        },
        {
          attendance: 'typed',
          beadId: world.beads[1] ?? '',
          continues: world.beads[0] ?? '',
          sessionId: SIDS[1] ?? '',
        },
      ],
      unattendedHandoffs: 2,
    });
  });

  test('nobody typed after the first session: 3 handoffs, back to the first', () => {
    const world = chainWorld();
    // F12: the first session's log is read too (is its first line a kickoff?).
    writeLog(world, 0, 0);
    writeLog(world, 1, 0);
    writeLog(world, 2, 0);
    writeLog(world, 3, 0);
    const chain = walk(world);
    expect(chain.kind).toBe('counted');
    if (chain.kind !== 'counted') return;
    expect(chain.unattendedHandoffs).toBe(3);
    expect(chain.links.at(-1)).toMatchObject({
      attendance: 'first',
      beadId: world.beads[0],
      continues: null,
    });
  });

  test('the caller itself attended: 0, and only its own log is read', () => {
    const world = chainWorld();
    writeLog(world, 3, 2);
    // No logs for 0-2: reading one would make the walk unknown.
    const chain = walk(world);
    expect(chain).toMatchObject({kind: 'counted', unattendedHandoffs: 0});
  });

  test('an unreadable log makes the walk unknown, not 0', () => {
    const world = chainWorld();
    writeLog(world, 3, 0);
    // A directory where the third session's log should be: EISDIR on read.
    mkdirSync(join(world.messagesDir, `${SIDS[2]}.jsonl`));
    const chain = walk(world);
    expect(chain.kind).toBe('unknown');
    if (chain.kind !== 'unknown') return;
    expect(chain.reason).toContain(`the message log of ${world.beads[2]}`);
    expect(chain.reason).toContain('could not be read');
    expect(chain.links).toHaveLength(1);
  });

  test('a missing log makes the walk unknown, not 0', () => {
    const world = chainWorld();
    writeLog(world, 3, 0);
    writeLog(world, 2, 0);
    const chain = walk(world);
    expect(chain.kind).toBe('unknown');
    if (chain.kind === 'unknown') {
      expect(chain.reason).toContain('does not exist');
    }
  });

  test('a predecessor no DB holds makes the walk unknown', () => {
    const world = chainWorld();
    writeLog(world, 3, 0);
    const caller = world.beads[3] ?? '';
    const swapped = brUpdate({db: world.db, env: world.env}, caller, {
      addLabels: ['continues:t-gone'],
      removeLabels: [`continues:${world.beads[2] ?? ''}`],
    });
    if (swapped.kind === 'failed') throw new Error(swapped.reason);
    const chain = walk(world);
    expect(chain.kind).toBe('unknown');
    if (chain.kind === 'unknown') {
      expect(chain.reason).toContain('session bead t-gone');
    }
  });
});

describe('walkUnattendedChain edge cases (fake readers)', () => {
  const LOG_KICKOFF_ONLY: MessageLogRead = {
    failures: [],
    kind: 'read',
    lines: [
      {
        at: null,
        cwd: null,
        event: 'UserPromptSubmit',
        role: 'user',
        text: KICKOFF,
      },
    ],
    path: '/fake.jsonl',
  };

  function readers(beads: Record<string, string[]>, log = LOG_KICKOFF_ONLY) {
    return {
      readLog: () => log,
      showBead: (id: string): ChainBeadRead => {
        const labels = beads[id];
        return labels == null
          ? {kind: 'notFound', reason: 'not in the fake'}
          : {kind: 'found', labels};
      },
    };
  }

  test('a loop is unknown', () => {
    const chain = walkUnattendedChain(
      'a',
      readers({
        a: ['sid:1', 'continues:b'],
        b: ['sid:2', 'continues:a'],
      }),
    );
    expect(chain).toMatchObject({kind: 'unknown'});
    if (chain.kind === 'unknown') expect(chain.reason).toContain('loops');
  });

  test('two continues: labels are unknown', () => {
    const chain = walkUnattendedChain(
      'a',
      readers({a: ['sid:1', 'continues:b', 'continues:c']}),
    );
    expect(chain.kind === 'unknown' && chain.reason).toContain(
      'names 2 predecessors',
    );
  });

  test('a successor with no sid: label is unknown', () => {
    const chain = walkUnattendedChain('a', readers({a: ['continues:b']}));
    expect(chain.kind === 'unknown' && chain.reason).toContain(
      'has no sid: label',
    );
  });

  test('malformed lines and no proof of attendance are unknown', () => {
    const chain = walkUnattendedChain(
      'a',
      readers(
        {a: ['sid:1', 'continues:b'], b: ['sid:2']},
        {...LOG_KICKOFF_ONLY, failures: ['line 3: not JSON']},
      ),
    );
    expect(chain.kind === 'unknown' && chain.reason).toContain(
      'unreadable lines',
    );
  });

  function logOf(...texts: string[]): MessageLogRead {
    return {
      failures: [],
      kind: 'read',
      lines: texts.map((text) => ({
        at: null,
        cwd: null,
        event: 'backfill' as const,
        role: 'user' as const,
        text,
      })),
      path: '/fake.jsonl',
    };
  }
  const TWO = {a: ['sid:1', 'continues:b'], b: ['sid:2']};

  // F1 (home-base-mbnjv.8), measured samples in the bead's notes.
  test.each([
    [
      'a background-task notification',
      '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>',
    ],
    [
      'a cross-session message',
      'Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/cc-socks/1.sock">Landed</cross-session-message>',
    ],
    [
      'a subagent hand-back',
      '<agent-message from="a1">[Subagent hand-back] The text below is the final report',
    ],
    [
      'a /loop tick',
      '# Autonomous loop tick (dynamic pacing)\n\nRun the autonomous check',
    ],
    [
      'a message another session typed with cmux send',
      '[home-base backfill, sent by home-base session 17ded0a9-30bf-4d07-bb90-b34fabc8213d; Justin approved this message] This session started before request tracking existed',
    ],
    ['an empty line (unclassifiable)', '  '],
  ])('F1: %s after the kickoff does not count as attended', (_kind, text) => {
    // a is the successor (kickoff, then the machine line); b, the first
    // session, began on Justin's own prompt.
    const chain = walkUnattendedChain('a', {
      ...readers(TWO),
      readLog: (sid) =>
        sid === '1' ? logOf(KICKOFF, text) : logOf('Justin starts'),
    });
    expect(chain).toMatchObject({kind: 'counted', unattendedHandoffs: 1});
    expect(chain.links[0]?.attendance).toBe('unattended');
  });

  test('F1: a line Justin typed still counts as attended, wherever it is', () => {
    const chain = walkUnattendedChain(
      'a',
      readers(
        TWO,
        logOf(
          KICKOFF,
          '<task-notification>x</task-notification>',
          'yes, go on',
        ),
      ),
    );
    expect(chain).toMatchObject({kind: 'counted', unattendedHandoffs: 0});
    expect(chain.links[0]?.attendance).toBe('typed');
  });

  test('F12: a session with no continues: whose first line is a kickoff makes the walk unknown', () => {
    const chain = walkUnattendedChain(
      'a',
      readers({a: ['sid:1', 'continues:b'], b: ['sid:2']}, logOf(KICKOFF)),
    );
    expect(chain.kind).toBe('unknown');
    if (chain.kind === 'unknown') {
      expect(chain.reason).toBe(
        'b has no continues: label but began on a handoff kickoff: a successor that never linked to its predecessor, so where its chain starts is unknown',
      );
    }
    const first = walkUnattendedChain(
      'b',
      readers({b: ['sid:2']}, logOf('Justin starts', KICKOFF)),
    );
    expect(first).toMatchObject({kind: 'counted', unattendedHandoffs: 0});
  });

  test('F12: the first session needs its sid and its log now', () => {
    const noSid = walkUnattendedChain('b', readers({b: []}, logOf('x')));
    expect(noSid.kind).toBe('unknown');
    const missing = walkUnattendedChain('b', {
      readLog: () => ({kind: 'missing', path: '/gone.jsonl'}),
      showBead: () => ({kind: 'found', labels: ['sid:2']}),
    });
    expect(missing.kind === 'unknown' && missing.reason).toContain(
      'does not exist',
    );
  });

  test('a chain longer than the limit is unknown', () => {
    const beads: Record<string, string[]> = {};
    for (let i = 0; i < 10; i += 1)
      beads[`b${i}`] = ['sid:x', `continues:b${i + 1}`];
    const chain = walkUnattendedChain('b0', readers(beads), {limit: 5});
    expect(chain.kind === 'unknown' && chain.reason).toContain(
      'longer than 5 sessions',
    );
  });
});
