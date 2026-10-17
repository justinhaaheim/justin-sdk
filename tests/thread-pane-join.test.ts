/**
 * The pane join (home-base-j8q3e.7 D5, D6; AC 6): hook store -> pid -> tty ->
 * surface, against a fake cmux runner, a fake process list and a fake hook
 * store. Nothing here reaches the real cmux, ps or ~/.cmuxterm.
 *
 * NEGATIVE CONTROLS: recorded in home-base-j8q3e.7's notes.
 */

import type {
  CmuxRunner,
  PaneLookup,
  ProcessRunner,
} from '../src/thread/pane-join';
import type {Sandbox} from './sandbox';

import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import {readFileSync, rmSync} from 'fs';
import {join} from 'path';

import {
  attributeSessions,
  flattenTree,
  LIVE_TREE_ARGS,
  lookupPanes,
  paneFailureReason,
  parseProcessList,
  placeByStatusLine,
  unplacedClaudeSurfaces,
} from '../src/thread/pane-join';
import {paneFactOf, paneLineParts} from '../src/thread/session-card';
import {createSandbox} from './sandbox';

const LIVE = 'aaaaaaaa-0000-4000-8000-000000000001';
const GONE = 'aaaaaaaa-0000-4000-8000-000000000002';
const NO_SURFACE = 'aaaaaaaa-0000-4000-8000-000000000003';

const PS = [
  '  PID  PPID TTY      ELAPSED COMMAND',
  '  101     1 ttys001    01:00 /Users/x/.local/bin/claude --resume a',
  '  303     1 ttys009    02:00 /Users/x/.local/bin/claude',
  '  404     1 ??         00:10 /usr/sbin/somed',
].join('\n');

const TREE = {
  windows: [
    {
      ref: 'window:1',
      workspaces: [
        {
          id: 'WS-UUID-1',
          panes: [
            {
              ref: 'pane:1',
              surfaces: [
                {
                  id: 'SURF-UUID-1',
                  ref: 'surface:1',
                  title: 'claude',
                  tty: 'ttys001',
                  type: 'terminal',
                },
              ],
            },
          ],
          ref: 'workspace:1',
          title: 'alpha',
        },
      ],
    },
  ],
};

const STORE = {
  sessions: {
    [GONE]: {pid: 202, sessionId: GONE, workspaceId: 'WS-OLD'},
    [LIVE]: {pid: 101, sessionId: LIVE, workspaceId: 'WS-UUID-1'},
    [NO_SURFACE]: {pid: 303, sessionId: NO_SURFACE, workspaceId: 'WS-X'},
  },
};

let sb: Sandbox;
let storePath: string;
let sessionFilePath: string;

beforeAll(() => {
  sb = createSandbox();
  storePath = join(sb.path, 'claude-hook-sessions.json');
  sb.writeFile('claude-hook-sessions.json', JSON.stringify(STORE));
  sessionFilePath = join(sb.path, 'session-com.cmuxterm.app.json');
  sb.writeFile('session-com.cmuxterm.app.json', JSON.stringify({windows: []}));
});

afterAll(() => {
  sb.cleanup();
});

function fakeCmux(stdout: string): CmuxRunner & {calls: string[][]} {
  const calls: string[][] = [];
  const run = (args: readonly string[]) => {
    calls.push([...args]);
    return Promise.resolve({kind: 'ok' as const, stdout});
  };
  return Object.assign(run, {calls});
}

const okPs: ProcessRunner = () =>
  Promise.resolve({kind: 'ok', stdout: PS} as const);

describe('attributeSessions: pid -> tty -> surface (pure)', () => {
  test('a session whose pid runs on a surface tty gets that surface; a gone pid gets none', () => {
    const attributed = attributeSessions(
      STORE,
      parseProcessList(PS),
      flattenTree(TREE),
    );
    const of = (id: string) => attributed.find((s) => s.sessionId === id);
    expect(of(LIVE)).toMatchObject({
      alive: true,
      pid: 101,
      surfaceRef: 'surface:1',
      tty: 'ttys001',
    });
    expect(of(GONE)).toMatchObject({alive: false, surfaceRef: null, tty: null});
    // Alive, but on a tty no cmux surface has.
    expect(of(NO_SURFACE)).toMatchObject({alive: true, surfaceRef: null});
  });

  test('flattenTree keeps the surface and workspace uuids the --id-format both tree carries', () => {
    expect(flattenTree(TREE)).toEqual([
      {
        id: 'SURF-UUID-1',
        paneRef: 'pane:1',
        ref: 'surface:1',
        title: 'claude',
        tty: 'ttys001',
        type: 'terminal',
        workspaceId: 'WS-UUID-1',
        workspaceRef: 'workspace:1',
        workspaceTitle: 'alpha',
      },
    ]);
  });
});

describe('lookupPanes (D6): one map of live panes, or why there is none', () => {
  test('the live session maps to its surface and workspace uuids; the gone and the unplaced ones are absent', async () => {
    const cmux = fakeCmux(JSON.stringify(TREE));
    const lookup = await lookupPanes({
      cmux,
      hookStorePath: storePath,
      ps: okPs,
      sessionFilePath,
    });
    expect(lookup.ok).toBe(true);
    if (!lookup.ok) return;
    expect([...lookup.bySession.entries()]).toEqual([
      [
        LIVE,
        {
          source: 'hook-store',
          surfaceId: 'SURF-UUID-1',
          workspaceId: 'WS-UUID-1',
        },
      ],
    ]);
    // No Claude pane was left unplaced, so no screen was read.
    expect(cmux.calls).toEqual([[...LIVE_TREE_ARGS]]);
    expect(lookup.statusLine).toEqual({
      failure: null,
      unknownSessions: new Map(),
      unplaced: [],
    });
  });

  test('a cmux runner failure is {ok: false, reason}, never an empty map (rule 7)', async () => {
    const failing: CmuxRunner = () =>
      Promise.resolve({
        kind: 'failed',
        reason:
          'cmux --json --id-format failed: Error: Failed to connect to socket at /x/cmux.sock (Operation not permitted, errno 1)',
      });
    const lookup = await lookupPanes({
      cmux: failing,
      hookStorePath: storePath,
      ps: okPs,
      sessionFilePath,
    });
    expect(lookup).toEqual({
      ok: false,
      reason:
        'cmux tree refused: Operation not permitted, as inside the Claude Code sandbox',
    });
  });

  test('ps failing, a missing hook store, or JSON that is not a tree are failures too', async () => {
    const cmux = fakeCmux(JSON.stringify(TREE));
    const psFails: ProcessRunner = () =>
      Promise.resolve({kind: 'failed', reason: 'ps -Ao failed: boom'});
    expect(
      await lookupPanes({
        cmux,
        hookStorePath: storePath,
        ps: psFails,
        sessionFilePath,
      }),
    ).toEqual({ok: false, reason: 'ps: ps -Ao failed: boom'});
    const missing = join(sb.path, 'nope.json');
    expect(
      await lookupPanes({
        cmux,
        hookStorePath: missing,
        ps: okPs,
        sessionFilePath,
      }),
    ).toEqual({
      ok: false,
      reason: `hook store: no cmux hook store at ${missing}`,
    });
    const lookup = await lookupPanes({
      cmux: fakeCmux('{"no":"windows"}'),
      hookStorePath: storePath,
      ps: okPs,
      sessionFilePath,
    });
    expect(lookup.ok).toBe(false);
  });

  test('a joined surface the tree gave no uuid fails the lookup instead of reading as no pane', async () => {
    const plain = JSON.parse(JSON.stringify(TREE)) as typeof TREE;
    const surface = plain.windows[0]?.workspaces[0]?.panes[0]?.surfaces[0] as {
      id?: string;
    };
    delete surface.id;
    const lookup = await lookupPanes({
      cmux: fakeCmux(JSON.stringify(plain)),
      hookStorePath: storePath,
      ps: okPs,
      sessionFilePath,
    });
    expect(lookup).toEqual({
      ok: false,
      reason: 'cmux tree: no surface or workspace uuid for surface:1',
    });
  });

  test('a runner that throws (the sandbox refuses the ps spawn itself) is a failure, never a crash', async () => {
    const psThrows: ProcessRunner = () => {
      const error = new Error('spawn ps EPERM') as Error & {code: string};
      error.code = 'EPERM';
      return Promise.reject(error);
    };
    const cmuxThrows: CmuxRunner = () => Promise.reject(new Error('boom'));
    const lookup = await lookupPanes({
      cmux: cmuxThrows,
      hookStorePath: storePath,
      ps: psThrows,
      sessionFilePath,
    });
    expect(lookup).toEqual({
      ok: false,
      reason:
        'ps refused: Operation not permitted, as inside the Claude Code sandbox; cmux tree: cmux --json --id-format both tree --all could not run: boom',
    });
  });

  test('a failure reason is one line, cut to fit a card', () => {
    const reason = paneFailureReason('ps', `${'x'.repeat(400)}\nsecond line`);
    expect(reason.startsWith('ps: ')).toBe(true);
    expect(reason).not.toContain('second line');
    expect(reason.length).toBeLessThan(170);
  });
});

// ---------------------------------------------------------------------------
// j8q3e.17: the status line, confirmed by cmux's session file
// ---------------------------------------------------------------------------

/**
 * Real screens, bytes unchanged (the last lines of `cmux read-screen`):
 *   pane-screen-s187-1010.txt  surface:187, 2026-10-17 10:10 capture: the
 *     conductor's own session, "⌗ 17ded0a9-…" (its hook-store entry has no
 *     pid, so the pid/tty join cannot place it)
 *   pane-screen-s24-0655.txt   surface:24, 2026-10-17 06:55: "⌗ b7a11012-…"
 */
const FIXTURES = join(import.meta.dir, 'fixtures');
const SCREEN_187 = readFileSync(
  join(FIXTURES, 'pane-screen-s187-1010.txt'),
  'utf8',
);
const SCREEN_24 = readFileSync(
  join(FIXTURES, 'pane-screen-s24-0655.txt'),
  'utf8',
);
const CONDUCTOR = '17ded0a9-30bf-4d07-bb90-b34fabc8213d';
const PILOT = 'b7a11012-82a6-45ad-ae5d-a9e4c7c673e1';
const OTHER = 'cccccccc-0000-4000-8000-000000000009';

const PS_2 = [
  '  PID  PPID TTY      ELAPSED COMMAND',
  '  101     1 ttys001    01:00 /Users/x/.local/bin/claude --resume a',
  '  500     1 ttys103    09:00 /Users/x/.local/bin/claude --settings {}',
  '  600     1 ttys024    09:00 /Users/x/.local/bin/claude',
  '  700     1 ttys005    09:00 -zsh',
].join('\n');

function surfaceJson(n: number, tty: string) {
  return {
    id: `SURF-UUID-${n}`,
    ref: `surface:${n}`,
    title: 'Claude Code',
    tty,
    type: 'terminal',
  };
}

const TREE_2 = {
  windows: [
    {
      ref: 'window:1',
      workspaces: [
        {
          id: 'WS-UUID-1',
          panes: [
            {ref: 'pane:1', surfaces: [surfaceJson(1, 'ttys001')]},
            {ref: 'pane:2', surfaces: [surfaceJson(187, 'ttys103')]},
            {ref: 'pane:3', surfaces: [surfaceJson(24, 'ttys024')]},
            {ref: 'pane:4', surfaces: [surfaceJson(5, 'ttys005')]},
          ],
          ref: 'workspace:1',
          title: 'alpha',
        },
      ],
    },
  ],
};

/** The real case: the conductor's hook-store entry has surface ids, no pid. */
const STORE_2 = {
  sessions: {
    [CONDUCTOR]: {
      cwd: '/Users/x/Dev/home-base',
      sessionId: CONDUCTOR,
      surfaceId: 'SURF-UUID-187',
      workspaceId: 'WS-UUID-1',
    },
    [LIVE]: {pid: 101, sessionId: LIVE, workspaceId: 'WS-UUID-1'},
  },
};

/** A session file naming `ids[n]` for surface n (by its uuid, D1). */
function sessionFileJson(ids: Record<number, string | null>) {
  return {
    windows: [
      {
        tabManager: {
          workspaces: [
            {
              panels: Object.entries(ids).map(([n, sessionId]) => ({
                directory: '/Users/x',
                id: `SURF-UUID-${n}`,
                // A tty the tree no longer has: the join is by uuid, not tty.
                terminal: {
                  agent: {
                    kind: 'claude',
                    sessionId,
                    workingDirectory: `/Users/x/Dev/repo-${n}`,
                  },
                },
                ttyName: 'ttys999',
              })),
              workspaceId: 'WS-UUID-1',
            },
          ],
        },
      },
    ],
  };
}

/** A fake cmux: the tree, and each surface's screen (or a failure). */
function fakeCmux2(
  screens: Record<string, string | null>,
): CmuxRunner & {calls: string[][]} {
  const calls: string[][] = [];
  const run = (args: readonly string[]) => {
    calls.push([...args]);
    if (args[0] === 'read-screen') {
      const text = screens[args[2] ?? ''] ?? null;
      return Promise.resolve(
        text == null
          ? {
              kind: 'failed' as const,
              reason:
                'cmux read-screen --surface failed: internal_error: Failed to read terminal text',
            }
          : {kind: 'ok' as const, stdout: text},
      );
    }
    return Promise.resolve({
      kind: 'ok' as const,
      stdout: JSON.stringify(TREE_2),
    });
  };
  return Object.assign(run, {calls});
}

const okPs2: ProcessRunner = () =>
  Promise.resolve({kind: 'ok', stdout: PS_2} as const);

async function lookup2(input: {
  file: Record<number, string | null> | null;
  screens: Record<string, string | null>;
}): Promise<Extract<PaneLookup, {ok: true}>> {
  const store = join(sb.path, 'store-2.json');
  sb.writeFile('store-2.json', JSON.stringify(STORE_2));
  const file = join(sb.path, 'session-2.json');
  if (input.file == null) {
    rmSync(file, {force: true});
  } else {
    sb.writeFile('session-2.json', JSON.stringify(sessionFileJson(input.file)));
  }
  const result = await lookupPanes({
    cmux: fakeCmux2(input.screens),
    hookStorePath: store,
    ps: okPs2,
    sessionFilePath: file,
  });
  if (!result.ok) throw new Error(`lookup failed: ${result.reason}`);
  return result;
}

const BOTH_SCREENS = {'surface:187': SCREEN_187, 'surface:24': SCREEN_24};

describe('lookupPanes, second source (j8q3e.17 AC1): the status line and the session file must agree', () => {
  test('a pane the hook store cannot place is placed when its "⌗ <uuid>" and the session file agree; the source says status-line', async () => {
    const lookup = await lookup2({
      file: {187: CONDUCTOR, 24: PILOT},
      screens: BOTH_SCREENS,
    });
    expect(lookup.bySession.get(CONDUCTOR)).toEqual({
      source: 'status-line',
      surfaceId: 'SURF-UUID-187',
      workspaceId: 'WS-UUID-1',
    });
    expect(lookup.bySession.get(PILOT)?.source).toBe('status-line');
    // The hook-store pane stands, and the shell pane is not a Claude pane.
    expect(lookup.bySession.get(LIVE)?.source).toBe('hook-store');
    expect(lookup.statusLine.unplaced).toEqual([]);
    expect(paneFactOf(lookup, CONDUCTOR, null)).toEqual({
      kind: 'live',
      surfaceId: 'SURF-UUID-187',
      workspaceId: 'WS-UUID-1',
    });
  });

  test('NEGATIVE: screen and session file disagree -> not placed, listed as unconfirmed, and its card reads none found by either source', async () => {
    const lookup = await lookup2({
      file: {187: OTHER, 24: PILOT},
      screens: BOTH_SCREENS,
    });
    expect(lookup.bySession.has(CONDUCTOR)).toBe(false);
    expect(lookup.bySession.has(OTHER)).toBe(false);
    expect(
      lookup.statusLine.unplaced.map((pane) => [pane.surface.ref, pane.kind]),
    ).toEqual([['surface:187', 'unconfirmedId']]);
    expect(lookup.statusLine.unplaced[0]?.detail).toBe(
      `the status line shows ${CONDUCTOR}, but cmux's session file names ${OTHER}`,
    );
    expect(paneLineParts(paneFactOf(lookup, CONDUCTOR, null)).before).toBe(
      'none found by the pid/tty join or the status line',
    );
  });

  test('the session file alone is not enough: no screen id -> not placed', async () => {
    const noId = SCREEN_187.replace(`⌗ ${CONDUCTOR}`, '');
    const lookup = await lookup2({
      file: {187: CONDUCTOR, 24: PILOT},
      screens: {'surface:187': noId, 'surface:24': SCREEN_24},
    });
    expect(lookup.bySession.has(CONDUCTOR)).toBe(false);
    expect(lookup.statusLine.unplaced.map((pane) => pane.kind)).toEqual([
      'noScreenId',
    ]);
  });
});

describe('lookupPanes, second source (j8q3e.17 AC2): a read failure is unknown, never none', () => {
  test('a screen that cannot be read leaves the session the file names there unknown (<reason>)', async () => {
    const lookup = await lookup2({
      file: {187: CONDUCTOR, 24: PILOT},
      screens: {'surface:187': null, 'surface:24': SCREEN_24},
    });
    expect(lookup.statusLine.unplaced.map((pane) => pane.kind)).toEqual([
      'unreadableScreen',
    ]);
    const fact = paneFactOf(lookup, CONDUCTOR, null);
    expect(fact).toEqual({
      kind: 'unknown',
      reason:
        "the pid/tty join found none, and the status line could not be checked: the screen of surface:187, where cmux's session file puts it, could not be read",
      recorded: null,
    });
    expect(paneLineParts(fact).before).not.toContain('none found');
    // The other pane was read and placed.
    expect(lookup.bySession.get(PILOT)?.source).toBe('status-line');
  });

  test('an empty screen counts as unreadable', async () => {
    const lookup = await lookup2({
      file: {187: CONDUCTOR, 24: PILOT},
      screens: {'surface:187': '  \n', 'surface:24': SCREEN_24},
    });
    expect(lookup.statusLine.unplaced[0]?.kind).toBe('unreadableScreen');
    expect(paneFactOf(lookup, CONDUCTOR, null).kind).toBe('unknown');
  });

  test('a session file that cannot be read makes every session neither source placed unknown; the hook-store panes stand', async () => {
    const lookup = await lookup2({file: null, screens: BOTH_SCREENS});
    expect(lookup.statusLine.failure).toContain('no cmux session file at');
    expect(lookup.statusLine.unplaced.map((pane) => pane.kind)).toEqual([
      'unreadableSessionFile',
      'unreadableSessionFile',
    ]);
    for (const id of [CONDUCTOR, PILOT, OTHER]) {
      const fact = paneFactOf(lookup, id, {surface: 'SF-R', workspace: 'WS-R'});
      expect(fact.kind).toBe('unknown');
      expect(paneLineParts(fact).before).not.toContain('none found');
    }
    expect(paneFactOf(lookup, LIVE, null).kind).toBe('live');
  });
});

describe('placeByStatusLine: conflicts (pure)', () => {
  const surface = (n: number) =>
    flattenTree(TREE_2).find((s) => s.ref === `surface:${n}`);
  const s187 = surface(187);
  const s24 = surface(24);
  if (s187 == null || s24 == null) throw new Error('fixture tree');

  test('two panes that both confirm one session place neither, and that session is unknown', () => {
    const file = sessionFileJson({187: CONDUCTOR, 24: CONDUCTOR});
    const result = placeByStatusLine({
      candidates: [s187, s24],
      placedByHookStore: new Map(),
      screens: new Map([
        ['surface:187', {kind: 'read', text: SCREEN_187}],
        [
          'surface:24',
          {kind: 'read', text: SCREEN_24.replace(PILOT, CONDUCTOR)},
        ],
      ]),
      sessionFile: {ok: true, value: file},
    });
    expect(result.placed).toEqual([]);
    expect(result.unplaced.map((pane) => pane.kind)).toEqual([
      'conflict',
      'conflict',
    ]);
    expect(result.unknownSessions.get(CONDUCTOR)).toBe(
      '2 panes show it on their status line (surface:187, surface:24)',
    );
  });

  test('a status-line id the pid/tty join already placed elsewhere is a conflict; the pid-proved pane stands', () => {
    const result = placeByStatusLine({
      candidates: [s187],
      placedByHookStore: new Map([[CONDUCTOR, 'surface:1']]),
      screens: new Map([['surface:187', {kind: 'read', text: SCREEN_187}]]),
      sessionFile: {ok: true, value: sessionFileJson({187: CONDUCTOR})},
    });
    expect(result.placed).toEqual([]);
    expect(result.unplaced[0]?.kind).toBe('conflict');
    expect(result.unknownSessions.size).toBe(0);
  });

  test('a placement carries the cwd from the session file (claude working directory first)', () => {
    const result = placeByStatusLine({
      candidates: [s187],
      placedByHookStore: new Map(),
      screens: new Map([['surface:187', {kind: 'read', text: SCREEN_187}]]),
      sessionFile: {ok: true, value: sessionFileJson({187: CONDUCTOR})},
    });
    expect(result.placed.map((p) => [p.sessionId, p.cwd])).toEqual([
      [CONDUCTOR, '/Users/x/Dev/repo-187'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// home-base-j8q3e.13 F7, F8 (the review's fix round)
// ---------------------------------------------------------------------------

/** lookupPanes over TREE_2 with this store, ps text, session file and screens. */
async function lookupWith(input: {
  file: Record<number, string | null>;
  name: string;
  ps: string;
  screens: Record<string, string | null>;
  store: object;
}): Promise<Extract<PaneLookup, {ok: true}>> {
  sb.writeFile(`${input.name}-store.json`, JSON.stringify(input.store));
  sb.writeFile(
    `${input.name}-session.json`,
    JSON.stringify(sessionFileJson(input.file)),
  );
  const result = await lookupPanes({
    cmux: fakeCmux2(input.screens),
    hookStorePath: join(sb.path, `${input.name}-store.json`),
    ps: () => Promise.resolve({kind: 'ok', stdout: input.ps} as const),
    sessionFilePath: join(sb.path, `${input.name}-session.json`),
  });
  if (!result.ok) throw new Error(`lookup failed: ${result.reason}`);
  return result;
}

const ENDED = 'eeeeeeee-0000-4000-8000-00000000000e';

describe('j8q3e.13 F7: a stored pid counts only while a claude process holds it', () => {
  // Surface 5's tty runs a zsh (pid 700, the ended session's old pid, reused)
  // and, under it, the pane's real claude (pid 701), whose session the
  // status line shows.
  const PS_REUSED = `${PS_2}\n  701   700 ttys005    09:00 /Users/x/.local/bin/claude`;
  const STORE_REUSED = {
    sessions: {[ENDED]: {pid: 700, sessionId: ENDED, workspaceId: 'WS-OLD'}},
  };

  test('pure: a stored pid now held by zsh is not alive, and its surface is left for the status line', () => {
    const procs = parseProcessList(PS_REUSED);
    const surfaces = flattenTree(TREE_2);
    const attributed = attributeSessions(STORE_REUSED, procs, surfaces);
    expect(attributed.map((s) => [s.sessionId, s.alive, s.surfaceRef])).toEqual(
      [[ENDED, false, null]],
    );
    expect(
      unplacedClaudeSurfaces(procs, surfaces, attributed).map((s) => s.ref),
    ).toContain('surface:5');
  });

  test('lookupPanes: the ended session is not placed; the pane real session is, by its status line', async () => {
    const lookup = await lookupWith({
      file: {5: PILOT},
      name: 'f7',
      ps: PS_REUSED,
      screens: {'surface:5': SCREEN_24},
      store: STORE_REUSED,
    });
    expect(lookup.bySession.has(ENDED)).toBe(false);
    expect(lookup.bySession.get(PILOT)).toEqual({
      source: 'status-line',
      surfaceId: 'SURF-UUID-5',
      workspaceId: 'WS-UUID-1',
    });
  });
});

describe('j8q3e.13 F8: two stored sessions on one pid (after /clear)', () => {
  // Both sessions name pid 101, the claude on surface:1.
  const STORE_SHARED = {
    sessions: {
      [OTHER]: {pid: 101, sessionId: OTHER, workspaceId: 'WS-UUID-1'},
      [PILOT]: {pid: 101, sessionId: PILOT, workspaceId: 'WS-UUID-1'},
    },
  };

  test('the screen ⌗ id picks one: only that session is placed, and the other is not unknown', async () => {
    const lookup = await lookupWith({
      file: {},
      name: 'f8a',
      ps: PS_2,
      screens: {'surface:1': SCREEN_24},
      store: STORE_SHARED,
    });
    expect([...lookup.bySession.keys()]).toEqual([PILOT]);
    expect(lookup.bySession.get(PILOT)).toEqual({
      source: 'hook-store',
      surfaceId: 'SURF-UUID-1',
      workspaceId: 'WS-UUID-1',
    });
    expect(lookup.statusLine.unknownSessions.has(OTHER)).toBe(false);
    expect(paneFactOf(lookup, OTHER, null)).toEqual({kind: 'none'});
  });

  test('a screen that names neither, or cannot be read: neither is in bySession, both are unknown ("two sessions on one pane")', async () => {
    for (const [name, screen] of [
      ['f8b', SCREEN_187],
      ['f8c', null],
    ] as const) {
      const lookup = await lookupWith({
        file: {},
        name,
        ps: PS_2,
        screens: {'surface:1': screen},
        store: STORE_SHARED,
      });
      expect(lookup.bySession.has(PILOT)).toBe(false);
      expect(lookup.bySession.has(OTHER)).toBe(false);
      for (const id of [PILOT, OTHER]) {
        expect(lookup.statusLine.unknownSessions.get(id)).toContain(
          'two sessions on one pane',
        );
        const fact = paneFactOf(lookup, id, null);
        expect(fact.kind).toBe('unknown');
        // The card says what the join found, never that it found none.
        const reason = fact.kind === 'unknown' ? fact.reason : '';
        expect(reason).toStartWith(
          `two sessions on one pane: the pid/tty join puts ${OTHER}, ${PILOT} in surface:1, and `,
        );
        expect(reason).not.toContain('found none');
      }
    }
  });
});
