/**
 * home-base-mbnjv.3: the workspace name follows the handoff chain (D8, C7,
 * AC3), tab titles follow it (D8, AC4), and the chain view reads both halves
 * of every link (D9, C9). Fake cmux runners and fake bead readers only: no
 * test here reaches the real cmux or br.
 */

import type {CmuxCall} from '../src/thread/cmux';
import type {ChainViewBead} from '../src/thread/handoff-view';
import type {
  WorkspaceNameRecord,
  WorkspaceSession,
} from '../src/thread/workspace-name';
import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, test} from 'bun:test';
import {mkdirSync, writeFileSync} from 'fs';
import {join} from 'path';

import {
  chainLines,
  handedOffAtOf,
  handoffRefusalOf,
  readHandoffChain,
} from '../src/thread/handoff-view';
import {sessionDisplayName, sessionName} from '../src/thread/session-name';
import {
  describeTabTitle,
  handedOffTabTitle,
  syncTabTitle,
  tabTitlesPath,
} from '../src/thread/tab-title';
import {
  decideWorkspaceName,
  describeWorkspaceSync,
  readWorkspaceNames,
  syncWorkspaceName,
} from '../src/thread/workspace-name';
import {previewWorkspaceNames} from '../src/thread/workspace-name-preview';
import {createSandbox} from './sandbox';

const WS = 'AAAA0000-1111-4222-8333-0000000000b2';
const WIN = 'window:1';
const S_A = 'CCCC0000-1111-4222-8333-0000000000a1';
const S_B = 'CCCC0000-1111-4222-8333-0000000000b1';
const S_C = 'CCCC0000-1111-4222-8333-0000000000c1';
const NAME_A = '[HOME-BASE] migrate the db';
const NOW = new Date('2030-01-01T12:00:00.000Z');

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

function stateEnv(): Record<string, string | undefined> {
  const sb = createSandbox();
  sandboxes.push(sb);
  return {JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state')};
}

function recordOf(
  beadId: string,
  surfaceId: string,
  nameSet: string,
): WorkspaceNameRecord {
  return {
    at: '2030-01-01T09:00:00.000Z',
    beadId,
    hisName: null,
    nameSet,
    replacedName: null,
    repo: 'home-base',
    sessionId: null,
    surfaceId,
    toolPart: nameSet,
    workspaceId: WS,
  };
}

function writeNames(
  env: Record<string, string | undefined>,
  records: WorkspaceNameRecord[],
): void {
  const dir = env.JUSTIN_THREADS_STATE_DIR ?? '';
  mkdirSync(dir, {recursive: true});
  writeFileSync(
    join(dir, 'workspace-names.jsonl'),
    records.map((record) => `${JSON.stringify(record)}\n`).join(''),
  );
}

/** A fake cmux holding one workspace with the given surfaces and name. */
function fakeCmux(input: {name: string | null; surfaces: string[]}) {
  const calls: string[][] = [];
  let name = input.name;
  const tree = {
    windows: [
      {
        id: 'W1',
        ref: WIN,
        workspaces: [
          {
            id: WS,
            panes: [{surfaces: input.surfaces.map((id) => ({id}))}],
            ref: 'workspace:7',
            title: name ?? 'x',
          },
        ],
      },
    ],
  };
  const run = (args: readonly string[]): Promise<CmuxCall> => {
    calls.push([...args]);
    if (args.includes('tree')) {
      return Promise.resolve({kind: 'ok', stdout: JSON.stringify(tree)});
    }
    if (args.includes('workspace') && args.includes('list')) {
      return Promise.resolve({
        kind: 'ok',
        stdout: JSON.stringify({workspaces: [{custom_title: name, id: WS}]}),
      });
    }
    if (args[0] === 'rename-workspace') {
      name = args.at(-1) ?? null;
      return Promise.resolve({kind: 'ok', stdout: 'OK\n'});
    }
    if (args[0] === 'rename-tab') {
      return Promise.resolve({kind: 'ok', stdout: 'OK\n'});
    }
    return Promise.resolve({
      kind: 'failed',
      reason: `the fake cmux does not know ${args.join(' ')}`,
    });
  };
  return {calls, run};
}

function session(
  beadId: string,
  labels: string[],
  title = 'continue the migration',
): WorkspaceSession {
  return {
    beadId,
    labels,
    repo: 'home-base',
    repoTag: 'HOME-BASE',
    sessionId: null,
    title,
  };
}

// ---------------------------------------------------------------------------
// AC3: decideWorkspaceName
// ---------------------------------------------------------------------------

describe('decideWorkspaceName: the sticky owner yields to its own successor (C7)', () => {
  const records = [recordOf('t-a', S_A, NAME_A)];
  const toolPart = '[HOME-BASE] continue the migration';

  test('the owner handed off to the asker: the asker takes the name', () => {
    const decided = decideWorkspaceName({
      current: NAME_A,
      records,
      self: {beadId: 't-b', handedOffFrom: 't-a', surfaceIdsHere: [S_A, S_B]},
      toolPart,
    });
    expect(decided).toEqual({
      hisName: null,
      kind: 'rename',
      replacedName: null,
      rule: 'tools',
      target: toolPart,
    });
  });

  test('a stranger still meets the live owner: sticky, unchanged', () => {
    for (const handedOffFrom of [null, undefined, 't-somebody-else']) {
      const decided = decideWorkspaceName({
        current: NAME_A,
        records,
        self: {beadId: 't-c', handedOffFrom, surfaceIdsHere: [S_A, S_C]},
        toolPart,
      });
      expect(decided).toEqual({
        kind: 'unchanged',
        name: NAME_A,
        ownerBeadId: 't-a',
        rule: 'sticky',
      });
    }
  });
});

describe('syncWorkspaceName reads the owner and confirms both halves', () => {
  async function sync(input: {ownerLabels: string[]; selfLabels: string[]}) {
    const env = stateEnv();
    writeNames(env, [recordOf('t-a', S_A, NAME_A)]);
    const cmux = fakeCmux({name: NAME_A, surfaces: [S_A, S_B]});
    const reads: string[] = [];
    const outcome = await syncWorkspaceName({
      enabled: true,
      env,
      now: NOW,
      readLabels: (beadId) => {
        reads.push(beadId);
        return {kind: 'found', labels: input.ownerLabels};
      },
      run: cmux.run,
      session: session('t-b', input.selfLabels),
    });
    return {cmux, outcome, reads};
  }

  test('continues:t-a here and continued-by:t-b there: renamed to the successor', async () => {
    const {cmux, outcome, reads} = await sync({
      ownerLabels: ['session', 'continued-by:t-b', `cmux-surface:${S_A}`],
      selfLabels: ['session', 'continues:t-a', `cmux-surface:${S_B}`],
    });
    expect(reads).toEqual(['t-a']);
    expect(outcome).toMatchObject({
      from: NAME_A,
      kind: 'renamed',
      rule: 'tools',
      to: '[HOME-BASE] continue the migration',
    });
    expect(
      cmux.calls.filter((call) => call[0] === 'rename-workspace'),
    ).toHaveLength(1);
  });

  test('a half-written link (the owner lacks continued-by:) keeps the name', async () => {
    const {cmux, outcome} = await sync({
      ownerLabels: ['session', `cmux-surface:${S_A}`],
      selfLabels: ['session', 'continues:t-a', `cmux-surface:${S_B}`],
    });
    expect(outcome).toMatchObject({
      kind: 'unchanged',
      ownerBeadId: 't-a',
      rule: 'sticky',
    });
    expect(cmux.calls.some((call) => call[0] === 'rename-workspace')).toBe(
      false,
    );
  });

  test('mbnjv.12: the same title as the owner: no rename, but a line of its own carrying his name', async () => {
    const env = stateEnv();
    const shown = `${NAME_A} (his name)`;
    writeNames(env, [
      {...recordOf('t-a', S_A, shown), hisName: 'his name', toolPart: NAME_A},
    ]);
    for (const surfaces of [
      [S_A, S_B],
      // Then the owner's tab closes: t-b's own line holds, nothing new.
      [S_B],
    ]) {
      const cmux = fakeCmux({name: shown, surfaces});
      const outcome = await syncWorkspaceName({
        enabled: true,
        env,
        now: NOW,
        readLabels: () => ({kind: 'found', labels: ['continued-by:t-b']}),
        run: cmux.run,
        session: session(
          't-b',
          ['session', 'continues:t-a', `cmux-surface:${S_B}`],
          'migrate the db',
        ),
      });
      expect(cmux.calls.some((call) => call[0] === 'rename-workspace')).toBe(
        false,
      );
      if (surfaces.length === 2) {
        expect(outcome).toEqual({
          fromBeadId: 't-a',
          kind: 'recorded',
          name: shown,
          workspaceId: WS,
        });
      } else {
        // The second pass finds t-b's own line: idempotent, no new line.
        expect(outcome).toMatchObject({kind: 'unchanged', rule: 'tools'});
      }
    }
    const lines = readWorkspaceNames(env);
    expect(lines.kind === 'read' && lines.records.at(-1)).toMatchObject({
      beadId: 't-b',
      hisName: 'his name',
      nameSet: shown,
      surfaceId: S_B,
    });
    expect(lines.kind === 'read' && lines.records).toHaveLength(2);
  });

  test('mbnjv.12: a closed predecessor with the same title is taken over too; a half link is not', async () => {
    for (const ownerLabels of [['continued-by:t-b'], []]) {
      const env = stateEnv();
      writeNames(env, [recordOf('t-a', S_A, NAME_A)]);
      const cmux = fakeCmux({name: NAME_A, surfaces: [S_B]});
      const outcome = await syncWorkspaceName({
        enabled: true,
        env,
        now: NOW,
        readLabels: () => ({kind: 'found', labels: ownerLabels}),
        run: cmux.run,
        session: session(
          't-b',
          ['session', 'continues:t-a', `cmux-surface:${S_B}`],
          'migrate the db',
        ),
      });
      expect(outcome.kind).toBe(
        ownerLabels.length > 0 ? 'recorded' : 'unchanged',
      );
    }
  });

  test('home-base-mbnjv.8 F4: the owner cannot be read: the name stays, and the outcome says the read failed', async () => {
    // Before F4 these read as a plain sticky (the owner's tab still open, a
    // different title) and a plain unchanged (the owner's tab closed, the
    // same title, so the name is already right): neither said the owner was
    // never checked.
    for (const {surfaces, title} of [
      {surfaces: [S_A, S_B], title: 'continue the migration'},
      {surfaces: [S_B], title: 'migrate the db'},
    ]) {
      const env = stateEnv();
      writeNames(env, [recordOf('t-a', S_A, NAME_A)]);
      const cmux = fakeCmux({name: NAME_A, surfaces});
      const reads: string[] = [];
      const outcome = await syncWorkspaceName({
        enabled: true,
        env,
        now: NOW,
        readLabels: (beadId) => {
          reads.push(beadId);
          return {kind: 'failed', reason: 'br show t-a: database is locked'};
        },
        run: cmux.run,
        session: session(
          't-b',
          ['session', 'continues:t-a', `cmux-surface:${S_B}`],
          title,
        ),
      });
      expect(reads).toEqual(['t-a']);
      expect(outcome).toEqual({
        kind: 'failed',
        reason:
          "the name was left alone: this session continues t-a, which set it, but t-a's labels could not be read (br show t-a: database is locked), so the handoff could not be confirmed",
        workspaceId: WS,
      });
      expect(describeWorkspaceSync(outcome)).toContain(
        "t-a's labels could not be read",
      );
      // The cautious side: no rename and no takeover line.
      expect(cmux.calls.some((call) => call[0] === 'rename-workspace')).toBe(
        false,
      );
      const lines = readWorkspaceNames(env);
      expect(lines.kind === 'read' && lines.records).toHaveLength(1);
    }
  });

  test('a stranger (no continues: to the owner) never reads the owner', async () => {
    const {outcome, reads} = await sync({
      ownerLabels: ['session', 'continued-by:t-b'],
      selfLabels: ['session', `cmux-surface:${S_B}`],
    });
    expect(reads).toEqual([]);
    expect(outcome).toMatchObject({kind: 'unchanged', rule: 'sticky'});
  });
});

describe('the preview agrees with the sync', () => {
  const preview = async (bLabels: string[]) => {
    const env = stateEnv();
    writeNames(env, [recordOf('t-a', S_A, NAME_A)]);
    const cmux = fakeCmux({name: NAME_A, surfaces: [S_A, S_B]});
    const base = {
      repo: 'home-base',
      repoTag: 'HOME-BASE',
      sessionId: 's',
    };
    const result = await previewWorkspaceNames({
      env,
      run: cmux.run,
      sessions: [
        {
          ...base,
          beadId: 't-a',
          labels: ['session', 'continued-by:t-b', `cmux-surface:${S_A}`],
          lastActivityAt: '2030-01-01T09:00:00.000Z',
          title: 'migrate the db',
        },
        {
          ...base,
          beadId: 't-b',
          labels: bLabels,
          lastActivityAt: '2030-01-01T10:00:00.000Z',
          title: 'continue the migration',
        },
      ],
    });
    if (result.kind !== 'read') throw new Error(JSON.stringify(result));
    const item = result.items.find((entry) => entry.workspaceId === WS);
    if (item == null) throw new Error('no preview item for the workspace');
    return item;
  };

  test('both halves: the successor is the namer and the verdict renames', async () => {
    const item = await preview([
      'session',
      'continues:t-a',
      `cmux-surface:${S_B}`,
    ]);
    expect(item.namer?.beadId).toBe('t-b');
    expect(item.verdict).toMatchObject({
      kind: 'rename',
      to: '[HOME-BASE] continue the migration',
    });
  });

  test('a stranger beside the owner: kept by the owner (sticky)', async () => {
    const item = await preview(['session', `cmux-surface:${S_B}`]);
    expect(item.namer?.beadId).toBe('t-a');
    expect(item.verdict.kind).toBe('unchanged');
  });
});

// ---------------------------------------------------------------------------
// AC4: tab titles act only on the session's own surface
// ---------------------------------------------------------------------------

describe('syncTabTitle: a successor titles its own tab (D8)', () => {
  const successor = (extra: string[] = []) =>
    session('t-b', [
      'session',
      'continues:t-a',
      `cmux-surface:${S_B}`,
      ...extra,
    ]);

  test('renames exactly its own cmux-surface:, not CMUX_SURFACE_ID, then records it', async () => {
    const env = {...stateEnv(), CMUX_SURFACE_ID: S_A, CMUX_WORKSPACE_ID: WS};
    const cmux = fakeCmux({name: null, surfaces: [S_A, S_B, S_C]});
    const outcome = await syncTabTitle({
      enabled: true,
      env,
      now: NOW,
      run: cmux.run,
      session: successor(),
    });
    const title = sessionName('HOME-BASE', 'continue the migration');
    expect(outcome).toEqual({
      kind: 'renamed',
      recordFailed: null,
      surfaceId: S_B,
      title,
    });
    const renames = cmux.calls.filter((call) => call[0] === 'rename-tab');
    expect(renames).toEqual([
      ['rename-tab', '--workspace', WS, '--surface', S_B, '--', title],
    ]);
    // Idempotent: the record says the title is set, so no cmux call at all.
    const again = fakeCmux({name: null, surfaces: [S_A, S_B, S_C]});
    const second = await syncTabTitle({
      enabled: true,
      env,
      run: again.run,
      session: successor(),
    });
    expect(second.kind).toBe('unchanged');
    expect(again.calls).toEqual([]);
    expect(tabTitlesPath(env)).toContain('tab-titles.jsonl');
  });

  test('no rename without its own label, for a non-successor, a handed-off one, or the knob off', async () => {
    const env = {...stateEnv(), CMUX_SURFACE_ID: S_A};
    const cases: {enabled: boolean; session: WorkspaceSession}[] = [
      {
        enabled: true,
        session: session('t-b', ['session', 'continues:t-a']),
      },
      {
        enabled: true,
        session: session('t-b', ['session', `cmux-surface:${S_B}`]),
      },
      {enabled: true, session: successor(['handed-off'])},
      {enabled: true, session: successor(['auto-title'])},
      {enabled: false, session: successor()},
    ];
    for (const entry of cases) {
      const cmux = fakeCmux({name: null, surfaces: [S_A, S_B]});
      const outcome = await syncTabTitle({...entry, env, run: cmux.run});
      expect(['off', 'skipped']).toContain(outcome.kind);
      expect(cmux.calls).toEqual([]);
      expect(describeTabTitle(outcome)).toContain('tab title');
    }
  });

  test('the handed-off mark and the shared name', () => {
    expect(handedOffTabTitle(NAME_A)).toBe(`↪ handed off: ${NAME_A}`);
    expect(sessionName('HOME-BASE', 'x')).toBe(
      sessionDisplayName('HOME-BASE', 'x'),
    );
    expect(sessionName('HOME-BASE', 'y'.repeat(200))).toHaveLength(80);
  });
});

// ---------------------------------------------------------------------------
// D9: the chain view
// ---------------------------------------------------------------------------

function beadsOf(
  list: ChainViewBead[],
): (
  id: string,
) => ReturnType<Parameters<typeof readHandoffChain>[1]['showBead']> {
  const byId = new Map(list.map((bead) => [bead.id, bead]));
  return (id) => {
    const bead = byId.get(id);
    return bead == null
      ? {kind: 'notFound', reason: `no ${id}`}
      : {bead, kind: 'found'};
  };
}

const CHAIN: ChainViewBead[] = [
  {
    id: 't-a',
    labels: ['session', 'handed-off', 'continued-by:t-b'],
    notes: '- 2030-01-01 09:30: handed off — step 1 done',
    title: 'migrate the db',
  },
  {
    id: 't-b',
    labels: ['session', 'handed-off', 'continues:t-a', 'continued-by:t-c'],
    notes: '- 2030-01-01 10:30: handed off',
    title: 'continue the migration',
  },
  {
    id: 't-c',
    labels: ['session', 'continues:t-b'],
    notes: null,
    title: 'finish the migration',
  },
];

describe('readHandoffChain', () => {
  test('from any of the three, all three in order with the right self', () => {
    for (const [index, start] of ['t-a', 't-b', 't-c'].entries()) {
      const chain = readHandoffChain(start, {showBead: beadsOf(CHAIN)});
      if ('kind' in chain) throw new Error(chain.reason);
      expect(chain.nodes.map((node) => node.beadId)).toEqual([
        't-a',
        't-b',
        't-c',
      ]);
      expect(chain.selfIndex).toBe(index);
      expect(chain.links).toEqual(['complete', 'complete']);
      expect(chain.problems).toEqual([]);
    }
    const chain = readHandoffChain('t-b', {showBead: beadsOf(CHAIN)});
    if ('kind' in chain) throw new Error(chain.reason);
    expect(chain.nodes.map((node) => node.handedOffAt)).toEqual([
      '2030-01-01 09:30',
      '2030-01-01 10:30',
      null,
    ]);
  });

  test('a half-written link either way is printed as half-written', () => {
    const onlyContinues = CHAIN.map((bead) =>
      bead.id === 't-a' ? {...bead, labels: ['session', 'handed-off']} : bead,
    );
    const back = readHandoffChain('t-c', {showBead: beadsOf(onlyContinues)});
    if ('kind' in back) throw new Error(back.reason);
    expect(back.links).toEqual(['onlyContinues', 'complete']);
    const text = chainLines(back, {
      count: 2,
      kind: 'counted',
      newest: 't-c',
    }).join('\n');
    expect(text).toContain(
      '⚠️ half-written link: t-b has continues:t-a, but t-a has no continued-by:t-b',
    );

    const onlyContinued = CHAIN.map((bead) =>
      bead.id === 't-c' ? {...bead, labels: ['session']} : bead,
    );
    const forward = readHandoffChain('t-a', {
      showBead: beadsOf(onlyContinued),
    });
    if ('kind' in forward) throw new Error(forward.reason);
    expect(forward.links).toEqual(['complete', 'onlyContinued']);
  });

  test('an unreadable neighbour stops the walk and says so', () => {
    const missing = CHAIN.filter((bead) => bead.id !== 't-c');
    const chain = readHandoffChain('t-a', {showBead: beadsOf(missing)});
    if ('kind' in chain) throw new Error(chain.reason);
    expect(chain.nodes.map((node) => node.beadId)).toEqual(['t-a', 't-b']);
    expect(chain.problems).toEqual([
      't-b names continued-by:t-c, but t-c could not be read: no t-c',
    ]);
  });

  test('refusal and handed-off records', () => {
    expect(handoffRefusalOf(['session'], 'handoff refused: x — y')).toBeNull();
    expect(
      handoffRefusalOf(
        ['session', 'handoff-refused'],
        '- 2030-01-01 09:00: handoff refused: killSwitch — old\n- 2030-01-01 10:00: handoff refused: tooManyLiveSessions — 25 live',
      ),
    ).toBe('handoff refused: tooManyLiveSessions — 25 live');
    expect(handoffRefusalOf(['handoff-refused'], null)).toContain(
      'reason not recorded',
    );
    expect(
      handedOffAtOf(['handed-off'], '- 2030-01-01 09:00: other'),
    ).toContain('unknown time');
  });
});
