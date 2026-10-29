/**
 * Workspace naming (home-base-j8q3e.5.1). Every cmux call here goes to a FAKE
 * runner, or to a fake `cmux` script on a private PATH: the suite may itself
 * run inside cmux, and Justin's workspace names cannot be recovered.
 */

import type {SpawnOutcome} from '../src/thread/capture';
import type {CmuxCall, CmuxRunner} from '../src/thread/cmux';
import type {
  WorkspaceNameRecord,
  WorkspaceSession,
} from '../src/thread/workspace-name';
import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, test} from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import {join} from 'path';

import {runBr} from '../src/beads/br';
import {workspaceNamesPath} from '../src/thread/archive';
import {
  applyCapture,
  captureRunRecord,
  runThreadCaptureHook,
} from '../src/thread/capture';
import {realCmuxRunner} from '../src/thread/cmux';
import {resolveThreadConfig} from '../src/thread/config';
import {
  describeRequestOutcome,
  describeTitleOutcome,
  fileRequest,
  renameSession,
} from '../src/thread/request';
import {ensureSessionBead} from '../src/thread/session-bead';
import {sessionDisplayName} from '../src/thread/session-name';
import {
  appendWorkspaceName,
  decideWorkspaceName,
  describeWorkspaceSync,
  readWorkspaceNames,
  restoreWorkspaceNames,
  syncWorkspaceName,
} from '../src/thread/workspace-name';
import {
  lookupWorkspaceSession,
  runThreadWorkspaceName,
} from '../src/thread/workspace-name-session';
import {createFakeBd} from './fake-bd';
import {initRepo} from './git-fixtures';
import {needBr} from './pinned-br';
import {createSandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

function sandbox(): Sandbox {
  const sb = createSandbox();
  sandboxes.push(sb);
  return sb;
}

const WS_A = 'AAAAAAAA-0000-4000-8000-00000000000A';
const WS_B = 'BBBBBBBB-0000-4000-8000-00000000000B';
const SURFACE = '5F5F5F5F-0000-4000-8000-000000000001';
const T = '[HOME-BASE] Fix the login bug';

function session(extra: Partial<WorkspaceSession> = {}): WorkspaceSession {
  return {
    beadId: 't-1',
    labels: ['session', `cmux-surface:${SURFACE}`],
    repo: 'home-base',
    repoTag: 'HOME-BASE',
    sessionId: '5e551011-aaaa-4bbb-8ccc-0123456789ab',
    title: 'Fix the login bug',
    ...extra,
  };
}

function record(extra: Partial<WorkspaceNameRecord>): WorkspaceNameRecord {
  return {
    at: '2026-10-16T00:00:00.000Z',
    beadId: 't-1',
    hisName: null,
    nameSet: T,
    replacedName: null,
    repo: 'home-base',
    sessionId: null,
    surfaceId: null,
    toolPart: T,
    workspaceId: WS_A,
    ...extra,
  };
}

interface FakeSpace {
  id: string;
  surfaces: string[];
  title: string | null;
}

const ok = (stdout: string): CmuxCall => ({kind: 'ok', stdout});

/** A fake cmux holding `spaces` in one window; renames change them. */
function fakeCmux(
  spaces: FakeSpace[],
  override?: (args: readonly string[]) => CmuxCall | null,
): {calls: string[][]; run: CmuxRunner; spaces: FakeSpace[]} {
  const calls: string[][] = [];
  const run: CmuxRunner = (args) => {
    calls.push([...args]);
    const forced = override?.(args) ?? null;
    if (forced != null) return Promise.resolve(forced);
    if (args.includes('tree')) {
      return Promise.resolve(
        ok(
          JSON.stringify({
            windows: [
              {
                id: 'W-1',
                ref: 'window:1',
                workspaces: spaces.map((space) => ({
                  id: space.id,
                  panes: [{surfaces: space.surfaces.map((id) => ({id}))}],
                })),
              },
            ],
          }),
        ),
      );
    }
    if (args[1] === 'workspace' && args[2] === 'list') {
      return Promise.resolve(
        ok(
          JSON.stringify({
            window_ref: 'window:1',
            workspaces: spaces.map((space) => ({
              custom_title: space.title,
              id: space.id,
            })),
          }),
        ),
      );
    }
    const target = spaces.find((space) => args.includes(space.id));
    if (args[0] === 'rename-workspace' && target != null) {
      target.title = (args[4] ?? '').trimEnd();
      return Promise.resolve(ok('OK'));
    }
    if (args.includes('clear-name') && target != null) {
      target.title = null;
      return Promise.resolve(ok('OK'));
    }
    return Promise.resolve({
      kind: 'failed',
      reason: `unexpected: ${args.join(' ')}`,
    });
  };
  return {calls, run, spaces};
}

function stateEnv(): Record<string, string | undefined> {
  const sb = sandbox();
  return {
    // A sync must never read these (D4): they name the CALLER's workspace.
    CMUX_SURFACE_ID: 'CALLER-SURFACE',
    CMUX_WORKSPACE_ID: WS_B,
    JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state'),
  };
}

function renames(calls: string[][]): string[][] {
  return calls.filter(
    (args) => args[0] === 'rename-workspace' || args.includes('clear-name'),
  );
}

function recordLines(env: Record<string, string | undefined>): string[] {
  const path = workspaceNamesPath(env);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '');
}

describe('D1 the name', () => {
  test('"[TAG] <title>", plain: the resolved tag as given (home-base-bomy5.7.1)', () => {
    expect(sessionDisplayName('HOME', 'Fix it ~now~')).toBe(
      '[HOME] Fix it ~now~',
    );
    expect(sessionDisplayName('HOME-BASE', 'x')).toBe('[HOME-BASE] x');
    expect(sessionDisplayName(null, 'x')).toBe('[UNKNOWN REPO] x');
  });
});

describe('D2 the decision', () => {
  test('rule 1: no name -> T', () => {
    expect(
      decideWorkspaceName({current: null, records: [], toolPart: T}),
    ).toEqual({
      hisName: null,
      kind: 'rename',
      replacedName: null,
      rule: 'empty',
      target: T,
    });
  });

  test('rule 2 without hisName: the tool’s old name -> the new T', () => {
    const latest = record({nameSet: '[HOME-BASE] Old title'});
    expect(
      decideWorkspaceName({
        current: '[HOME-BASE] Old title',
        records: [latest],
        toolPart: T,
      }),
    ).toEqual({
      hisName: null,
      kind: 'rename',
      replacedName: null,
      rule: 'tools',
      target: T,
    });
  });

  test('rule 2 with hisName: his name rides along in parentheses', () => {
    const latest = record({
      hisName: 'home 10-05',
      nameSet: '[HOME-BASE] Old title (home 10-05)',
    });
    expect(
      decideWorkspaceName({
        current: latest.nameSet,
        records: [latest],
        toolPart: T,
      }),
    ).toEqual({
      hisName: 'home 10-05',
      kind: 'rename',
      replacedName: null,
      rule: 'tools',
      target: `${T} (home 10-05)`,
    });
  });

  test('rule 3: a ✳ name is generated, replaced and remembered', () => {
    expect(
      decideWorkspaceName({
        current: '✳ Email formatting normalization',
        records: [],
        toolPart: T,
      }),
    ).toEqual({
      hisName: null,
      kind: 'rename',
      replacedName: '✳ Email formatting normalization',
      rule: 'generated',
      target: T,
    });
  });

  test('rule 4: any other name is his and is kept, verbatim', () => {
    expect(
      decideWorkspaceName({current: 'home 10-05', records: [], toolPart: T}),
    ).toEqual({
      hisName: 'home 10-05',
      kind: 'rename',
      replacedName: null,
      rule: 'his',
      target: `${T} (home 10-05)`,
    });
    // He edited the tool's name since: the whole edited string is his.
    expect(
      decideWorkspaceName({
        current: `${T} plus mine`,
        records: [record({})],
        toolPart: T,
      }),
    ).toMatchObject({hisName: `${T} plus mine`, rule: 'his'});
  });

  test('C equals T with no record: one ownership line, no rename', () => {
    expect(decideWorkspaceName({current: T, records: [], toolPart: T})).toEqual(
      {kind: 'record', name: T, rule: 'matchesToolPart'},
    );
  });

  test('already correct: write nothing', () => {
    expect(
      decideWorkspaceName({current: T, records: [record({})], toolPart: T}),
    ).toEqual({kind: 'unchanged', name: T, rule: 'matchesToolPart'});
    const his = record({hisName: 'mine', nameSet: `${T} (mine)`});
    expect(
      decideWorkspaceName({current: his.nameSet, records: [his], toolPart: T}),
    ).toMatchObject({kind: 'unchanged'});
  });

  test('trailing whitespace is trimmed, as cmux stores it', () => {
    expect(
      decideWorkspaceName({current: null, records: [], toolPart: `${T}  `}),
    ).toMatchObject({target: T});
  });
});

describe('D4/D5 the sync, against a fake cmux', () => {
  test('knob off: zero cmux calls and no record read', async () => {
    const env = stateEnv();
    // A corrupt record would make any read fail; off must not get that far.
    mkdirSync(join(env.JUSTIN_THREADS_STATE_DIR ?? '', ''), {recursive: true});
    writeFileSync(workspaceNamesPath(env), 'not json\n');
    const cmux = fakeCmux([{id: WS_A, surfaces: [SURFACE], title: null}]);
    expect(
      await syncWorkspaceName({
        enabled: false,
        env,
        run: cmux.run,
        session: session(),
      }),
    ).toEqual({kind: 'off'});
    expect(cmux.calls).toEqual([]);
  });

  test('a session still carrying auto-title renames nothing', async () => {
    const env = stateEnv();
    const cmux = fakeCmux([{id: WS_A, surfaces: [SURFACE], title: null}]);
    const outcome = await syncWorkspaceName({
      enabled: true,
      env,
      run: cmux.run,
      session: session({
        labels: ['session', 'auto-title', `cmux-surface:${SURFACE}`],
      }),
    });
    expect(outcome.kind).toBe('notReady');
    expect(cmux.calls).toEqual([]);
    expect(recordLines(env)).toEqual([]);
  });

  test.each([
    [
      'spawn error',
      (): CmuxCall => ({kind: 'failed', reason: 'spawn cmux ENOENT'}),
    ],
    [
      'non-zero exit',
      (): CmuxCall => ({kind: 'failed', reason: 'cmux failed: socket refused'}),
    ],
    ['bad JSON', (): CmuxCall => ok('{not json')],
    [
      'timeout',
      (): CmuxCall => ({
        kind: 'failed',
        reason: 'cmux timed out after 4000 ms',
      }),
    ],
  ])('unreadable cmux (%s) renames nothing', async (_name, reply) => {
    for (const which of ['tree', 'list'] as const) {
      const env = stateEnv();
      const cmux = fakeCmux(
        [{id: WS_A, surfaces: [SURFACE], title: 'his name'}],
        (args) =>
          (which === 'tree' ? args.includes('tree') : args[2] === 'list')
            ? reply()
            : null,
      );
      const outcome = await syncWorkspaceName({
        enabled: true,
        env,
        run: cmux.run,
        session: session(),
      });
      expect(outcome.kind).toBe('failed');
      expect(renames(cmux.calls)).toEqual([]);
      expect(recordLines(env)).toEqual([]);
      expect(cmux.spaces[0]?.title).toBe('his name');
    }
  });

  test('workspace not found renames nothing', async () => {
    const env = stateEnv();
    const cmux = fakeCmux([{id: WS_B, surfaces: ['OTHER'], title: null}]);
    const outcome = await syncWorkspaceName({
      enabled: true,
      env,
      run: cmux.run,
      session: session(),
    });
    expect(outcome.kind).toBe('failed');
    expect(renames(cmux.calls)).toEqual([]);
    // --workspace naming a closed workspace: also nothing.
    const forced = await syncWorkspaceName({
      enabled: true,
      env,
      run: cmux.run,
      session: session(),
      workspaceId: WS_A,
    });
    expect(forced.kind).toBe('failed');
    expect(renames(cmux.calls)).toEqual([]);
  });

  test('a corrupt record line renames nothing', async () => {
    const env = stateEnv();
    mkdirSync(env.JUSTIN_THREADS_STATE_DIR ?? '', {recursive: true});
    writeFileSync(
      workspaceNamesPath(env),
      `${JSON.stringify(record({workspaceId: WS_B}))}\n{"half": \n`,
    );
    const cmux = fakeCmux([{id: WS_A, surfaces: [SURFACE], title: null}]);
    const outcome = await syncWorkspaceName({
      enabled: true,
      env,
      run: cmux.run,
      session: session(),
    });
    expect(outcome).toMatchObject({kind: 'failed'});
    expect(renames(cmux.calls)).toEqual([]);
  });

  test('the record line is appended BEFORE the rename call', async () => {
    const env = stateEnv();
    const seenAtRename: string[][] = [];
    const cmux = fakeCmux(
      [{id: WS_A, surfaces: [SURFACE], title: 'home 10-05'}],
      (args) => {
        if (args[0] === 'rename-workspace') seenAtRename.push(recordLines(env));
        return null;
      },
    );
    const outcome = await syncWorkspaceName({
      enabled: true,
      env,
      run: cmux.run,
      session: session(),
    });
    expect(outcome).toMatchObject({
      kind: 'renamed',
      readback: {kind: 'read', name: `${T} (home 10-05)`},
      to: `${T} (home 10-05)`,
    });
    expect(seenAtRename).toHaveLength(1);
    expect(seenAtRename[0]).toHaveLength(1);
    expect(JSON.parse(seenAtRename[0]?.[0] ?? '{}')).toMatchObject({
      hisName: 'home 10-05',
      nameSet: `${T} (home 10-05)`,
      workspaceId: WS_A,
    });
  });

  test('the workspace comes from the bead’s labels, never $CMUX_WORKSPACE_ID', async () => {
    const env = stateEnv(); // CMUX_WORKSPACE_ID = WS_B
    const cmux = fakeCmux([
      {id: WS_A, surfaces: [SURFACE], title: null},
      {id: WS_B, surfaces: ['CALLER-SURFACE'], title: 'the caller'},
    ]);
    await syncWorkspaceName({
      enabled: true,
      env,
      run: cmux.run,
      session: session(),
    });
    expect(renames(cmux.calls)).toEqual([
      ['rename-workspace', '--workspace', WS_A, '--', T],
    ]);
    expect(cmux.spaces[1]?.title).toBe('the caller');
    // Only a cmux-ws label, naming a workspace that is gone: nothing, and no
    // fallback to the environment's workspace.
    const gone = fakeCmux([
      {id: WS_B, surfaces: ['CALLER-SURFACE'], title: 'the caller'},
    ]);
    const outcome = await syncWorkspaceName({
      enabled: true,
      env,
      run: gone.run,
      session: session({labels: ['session', `cmux-ws:${WS_A}`]}),
    });
    expect(outcome.kind).toBe('failed');
    expect(renames(gone.calls)).toEqual([]);
  });

  test('a moved surface names the workspace holding it now', async () => {
    const env = stateEnv();
    const cmux = fakeCmux([
      {id: WS_A, surfaces: [], title: null},
      {id: WS_B, surfaces: [SURFACE], title: null},
    ]);
    await syncWorkspaceName({
      enabled: true,
      env,
      run: cmux.run,
      session: session({
        labels: ['session', `cmux-surface:${SURFACE}`, `cmux-ws:${WS_A}`],
      }),
    });
    expect(renames(cmux.calls)).toEqual([
      ['rename-workspace', '--workspace', WS_B, '--', T],
    ]);
  });

  test('a readback that lags the rename is polled, not called a mismatch', async () => {
    const env = stateEnv();
    let renamed = false;
    let staleReads = 0;
    const cmux = fakeCmux(
      [{id: WS_A, surfaces: [SURFACE], title: null}],
      (args) => {
        if (args[0] === 'rename-workspace') renamed = true;
        if (renamed && args[2] === 'list' && staleReads < 2) {
          staleReads += 1;
          return ok(
            JSON.stringify({workspaces: [{custom_title: null, id: WS_A}]}),
          );
        }
        return null;
      },
    );
    const outcome = await syncWorkspaceName({
      enabled: true,
      env,
      run: cmux.run,
      session: session(),
    });
    expect(staleReads).toBe(2);
    expect(outcome).toMatchObject({
      kind: 'renamed',
      readback: {kind: 'read', name: T},
    });
  });

  test('outside cmux (no labels): nothing, and no cmux call', async () => {
    const env = stateEnv();
    const cmux = fakeCmux([]);
    expect(
      await syncWorkspaceName({
        enabled: true,
        env,
        run: cmux.run,
        session: session({labels: ['session']}),
      }),
    ).toEqual({kind: 'outsideCmux'});
    expect(cmux.calls).toEqual([]);
  });

  test('two syncs in a row write at most once', async () => {
    const env = stateEnv();
    const cmux = fakeCmux([{id: WS_A, surfaces: [SURFACE], title: 'mine'}]);
    const input = {enabled: true, env, run: cmux.run, session: session()};
    expect((await syncWorkspaceName(input)).kind).toBe('renamed');
    expect((await syncWorkspaceName(input)).kind).toBe('unchanged');
    expect(renames(cmux.calls)).toHaveLength(1);
    expect(recordLines(env)).toHaveLength(1);
    // A later title change keeps his name (rule 2 carries hisName).
    await syncWorkspaceName({...input, session: session({title: 'New'})});
    expect(cmux.spaces[0]?.title).toBe('[HOME-BASE] New (mine)');
  });

  test('--dry-run reads cmux and writes nothing', async () => {
    const env = stateEnv();
    const cmux = fakeCmux([{id: WS_A, surfaces: [SURFACE], title: 'mine'}]);
    expect(
      await syncWorkspaceName({
        dryRun: true,
        enabled: true,
        env,
        run: cmux.run,
        session: session(),
      }),
    ).toMatchObject({kind: 'wouldRename', rule: 'his', to: `${T} (mine)`});
    expect(renames(cmux.calls)).toEqual([]);
    expect(recordLines(env)).toEqual([]);
  });
});

describe('--restore', () => {
  test('puts back his name, the ✳ name, or no name; leaves renamed-since alone', async () => {
    const env = stateEnv();
    const WS_C = 'CCCCCCCC-0000-4000-8000-00000000000C';
    const WS_D = 'DDDDDDDD-0000-4000-8000-00000000000D';
    const cmux = fakeCmux([
      {id: WS_A, surfaces: ['s-a'], title: 'his'},
      {id: WS_B, surfaces: ['s-b'], title: '✳ generated'},
      {id: WS_C, surfaces: ['s-c'], title: null},
      {id: WS_D, surfaces: ['s-d'], title: 'his D'},
    ]);
    for (const [id, surface] of [
      [WS_A, 's-a'],
      [WS_B, 's-b'],
      [WS_C, 's-c'],
      [WS_D, 's-d'],
    ] as const) {
      await syncWorkspaceName({
        enabled: true,
        env,
        run: cmux.run,
        session: session({labels: ['session', `cmux-surface:${surface}`]}),
        workspaceId: id,
      });
    }
    // He renames D after the tool did.
    const d = cmux.spaces[3];
    if (d != null) d.title = 'renamed by hand';
    const dry = await restoreWorkspaceNames({dryRun: true, env, run: cmux.run});
    expect(dry).toMatchObject({kind: 'done'});
    expect(cmux.spaces.map((space) => space.title)).toEqual([
      `${T} (his)`,
      T,
      T,
      'renamed by hand',
    ]);
    const done = await restoreWorkspaceNames({
      dryRun: false,
      env,
      run: cmux.run,
    });
    expect(done).toMatchObject({kind: 'done'});
    expect(cmux.spaces.map((space) => space.title)).toEqual([
      'his',
      '✳ generated',
      null,
      'renamed by hand',
    ]);
    if (done.kind === 'done') {
      expect(
        done.items.find((item) => item.workspaceId === WS_D),
      ).toMatchObject({kind: 'leftAlone'});
    }
  });
});

/**
 * A fake `cmux` script in a private directory; returns its path. Every runner
 * test passes a FAKE env object, never process.env: in a session inside cmux,
 * process.env names the real bundled CLI and socket (home-base-j8q3e.5.4).
 */
function fakeExecutable(name: string, script: string, mode = 0o755): string {
  const dir = join(sandbox().path, name);
  mkdirSync(dir, {recursive: true});
  const path = join(dir, 'cmux');
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, mode);
  return path;
}

/** A fake env whose PATH holds only a fake cmux (and /usr/bin:/bin for sleep). */
function pathEnv(script: string): Record<string, string | undefined> {
  const path = fakeExecutable('path-bin', script);
  return {PATH: `${join(path, '..')}:/usr/bin:/bin`};
}

describe('the real runner: failure is a distinct member, with a timeout', () => {
  test('non-zero exit is failed, with stderr', async () => {
    const env = pathEnv('echo "socket refused" >&2; exit 3');
    const call = await realCmuxRunner(2000, env)(['tree']);
    expect(call).toMatchObject({kind: 'failed'});
    if (call.kind === 'failed') expect(call.reason).toContain('socket refused');
  });

  test('a hung cmux times out as failed', async () => {
    const env = pathEnv('sleep 5');
    const started = Date.now();
    const call = await realCmuxRunner(300, env)(['tree']);
    expect(call).toMatchObject({kind: 'failed'});
    if (call.kind === 'failed') expect(call.reason).toContain('timed out');
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe('j8q3e.5.4: the runner uses cmux’s bundled CLI and socket', () => {
  // Each fake prints which binary ran, CMUX_QUIET, and its argv.
  const hook = (): string =>
    fakeExecutable('hook', 'echo "hook $CMUX_QUIET $*"');
  const bundled = (): string =>
    fakeExecutable('bundled', 'echo "bundled $CMUX_QUIET $*"');
  const onPath = (): Record<string, string | undefined> =>
    pathEnv('echo "path $CMUX_QUIET $*"');

  async function stdout(
    env: Record<string, string | undefined>,
  ): Promise<string> {
    const call = await realCmuxRunner(2000, env)(['--json', 'tree', '--all']);
    return call.kind === 'ok' ? call.stdout.trim() : `FAILED ${call.reason}`;
  }

  test('$CMUX_CLAUDE_HOOK_CMUX_BIN first, over the bundled CLI and PATH', async () => {
    expect(
      await stdout({
        ...onPath(),
        CMUX_BUNDLED_CLI_PATH: bundled(),
        CMUX_CLAUDE_HOOK_CMUX_BIN: hook(),
      }),
    ).toBe('hook 1 --json tree --all');
  });

  test('$CMUX_BUNDLED_CLI_PATH when the hook bin is not an executable file', async () => {
    const notExecutable = fakeExecutable('noexec', 'echo hook', 0o644);
    for (const hookBin of [notExecutable, '/nonexistent/cmux', '']) {
      expect(
        await stdout({
          ...onPath(),
          CMUX_BUNDLED_CLI_PATH: bundled(),
          CMUX_CLAUDE_HOOK_CMUX_BIN: hookBin,
        }),
      ).toBe('bundled 1 --json tree --all');
    }
  });

  test('`cmux` on the env’s PATH when neither env path is usable', async () => {
    expect(
      await stdout({
        ...onPath(),
        CMUX_BUNDLED_CLI_PATH: '/nonexistent/cmux',
        CMUX_CLAUDE_HOOK_CMUX_BIN: fakeExecutable('noexec', 'echo hook', 0o644),
      }),
    ).toBe('path 1 --json tree --all');
  });

  test('--socket $CMUX_SOCKET_PATH goes ahead of every other argument', async () => {
    expect(
      await stdout({
        ...onPath(),
        CMUX_CLAUDE_HOOK_CMUX_BIN: hook(),
        CMUX_SOCKET_PATH: '/fake/state/cmux.sock',
      }),
    ).toBe('hook 1 --socket /fake/state/cmux.sock --json tree --all');
  });

  test('no --socket when CMUX_SOCKET_PATH is unset or empty', async () => {
    expect(await stdout({...onPath()})).toBe('path 1 --json tree --all');
    expect(await stdout({...onPath(), CMUX_SOCKET_PATH: ''})).toBe(
      'path 1 --json tree --all',
    );
  });
});

describe('bomy5.4.1: the first session to name a shared workspace keeps it', () => {
  const SURFACE_A = 'A0A0A0A0-0000-4000-8000-00000000000A';
  const SURFACE_B = 'B0B0B0B0-0000-4000-8000-00000000000B';
  const HIS = 'My notes';
  const T_A = '[HOME-BASE] Fix the login bug';
  const T_B = '[HOME-BASE] Write the docs';
  const sessionA = (title = 'Fix the login bug'): WorkspaceSession =>
    session({
      beadId: 'a-1',
      labels: ['session', `cmux-surface:${SURFACE_A}`],
      title,
    });
  const sessionB = (): WorkspaceSession =>
    session({
      beadId: 'b-1',
      labels: ['session', `cmux-surface:${SURFACE_B}`],
      title: 'Write the docs',
    });

  /** WS_A holds both surfaces and carries Justin's own name; A has synced. */
  async function namedByA() {
    const env = stateEnv();
    const cmux = fakeCmux([
      {id: WS_A, surfaces: [SURFACE_A, SURFACE_B], title: HIS},
      {id: WS_B, surfaces: [], title: null},
    ]);
    const first = await syncWorkspaceName({
      enabled: true,
      env,
      run: cmux.run,
      session: sessionA(),
    });
    expect(first).toMatchObject({kind: 'renamed', rule: 'his'});
    expect(cmux.spaces[0]?.title).toBe(`${T_A} (${HIS})`);
    return {cmux, env};
  }

  test('B leaves A’s name alone while A’s pane is here, and says whose it is', async () => {
    const {cmux, env} = await namedByA();
    const before = recordLines(env).length;
    const outcome = await syncWorkspaceName({
      enabled: true,
      env,
      run: cmux.run,
      session: sessionB(),
    });
    expect(outcome).toEqual({
      kind: 'unchanged',
      name: `${T_A} (${HIS})`,
      ownerBeadId: 'a-1',
      rule: 'sticky',
      workspaceId: WS_A,
    });
    expect(describeWorkspaceSync(outcome)).toContain(
      'named by session a-1, still open in this workspace',
    );
    expect(renames(cmux.calls)).toHaveLength(1); // A's rename only
    expect(recordLines(env)).toHaveLength(before);
    expect(cmux.spaces[0]?.title).toBe(`${T_A} (${HIS})`);
  });

  test('A’s own title change still renames it, and B still leaves it alone', async () => {
    const {cmux, env} = await namedByA();
    const renamed = await syncWorkspaceName({
      enabled: true,
      env,
      run: cmux.run,
      session: sessionA('Fix the signup bug'),
    });
    expect(renamed).toMatchObject({
      kind: 'renamed',
      rule: 'tools',
      to: `[HOME-BASE] Fix the signup bug (${HIS})`,
    });
    const b = await syncWorkspaceName({
      enabled: true,
      env,
      run: cmux.run,
      session: sessionB(),
    });
    expect(b).toMatchObject({ownerBeadId: 'a-1', rule: 'sticky'});
  });

  test('after A’s pane leaves, B takes over and keeps his name in parentheses', async () => {
    const {cmux, env} = await namedByA();
    // A's surface moves to the other workspace.
    const [wsA, wsB] = cmux.spaces;
    if (wsA == null || wsB == null) throw new Error('the fake lost a space');
    wsA.surfaces = [SURFACE_B];
    wsB.surfaces = [SURFACE_A];
    const outcome = await syncWorkspaceName({
      enabled: true,
      env,
      run: cmux.run,
      session: sessionB(),
    });
    expect(outcome).toMatchObject({
      kind: 'renamed',
      rule: 'tools',
      to: `${T_B} (${HIS})`,
      workspaceId: WS_A,
    });
    const lines = recordLines(env).map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );
    expect(lines.at(-1)).toMatchObject({
      beadId: 'b-1',
      hisName: HIS,
      nameSet: `${T_B} (${HIS})`,
      surfaceId: SURFACE_B,
    });
  });

  test('the decision: sticky only for another session whose surface is here', () => {
    const records = [
      record({beadId: 'a-1', nameSet: T_A, surfaceId: SURFACE_A}),
    ];
    const here = [SURFACE_A, SURFACE_B];
    expect(
      decideWorkspaceName({
        current: T_A,
        records,
        self: {beadId: 'b-1', surfaceIdsHere: here},
        toolPart: T_B,
      }),
    ).toEqual({
      kind: 'unchanged',
      name: T_A,
      ownerBeadId: 'a-1',
      rule: 'sticky',
    });
    expect(
      decideWorkspaceName({
        current: T_A,
        records,
        self: {beadId: 'b-1', surfaceIdsHere: [SURFACE_B]},
        toolPart: T_B,
      }),
    ).toMatchObject({kind: 'rename', rule: 'tools', target: T_B});
  });

  test('an old record line without surfaceId parses and makes no sticky claim', async () => {
    const env = stateEnv();
    const path = workspaceNamesPath(env);
    mkdirSync(join(path, '..'), {recursive: true});
    // The shape every line had before bomy5.4.1: no surfaceId field.
    writeFileSync(
      path,
      `${JSON.stringify({
        at: '2026-10-16T00:00:00.000Z',
        beadId: 'a-1',
        hisName: HIS,
        nameSet: `${T_A} (${HIS})`,
        replacedName: null,
        repo: 'home-base',
        sessionId: null,
        toolPart: T_A,
        workspaceId: WS_A,
      })}\n`,
    );
    const read = readWorkspaceNames(env);
    expect(read.kind).toBe('read');
    if (read.kind === 'read') expect(read.records[0]?.surfaceId).toBeNull();
    const cmux = fakeCmux([
      {id: WS_A, surfaces: [SURFACE_A, SURFACE_B], title: `${T_A} (${HIS})`},
    ]);
    const outcome = await syncWorkspaceName({
      enabled: true,
      env,
      run: cmux.run,
      session: sessionB(),
    });
    expect(outcome).toMatchObject({
      kind: 'renamed',
      rule: 'tools',
      to: `${T_B} (${HIS})`,
    });
  });
});

describe('D6 the knob', () => {
  test('nameWorkspaces defaults to false and is read from config', () => {
    const sb = sandbox();
    const xdg = join(sb.path, 'xdg');
    const cwd = join(sb.path, 'repo');
    mkdirSync(cwd, {recursive: true});
    const off = resolveThreadConfig({cwd, env: {XDG_CONFIG_HOME: xdg}});
    expect(off.nameWorkspaces).toBe(false);
    expect(off.nameWorkspacesSource).toBe('default');
    mkdirSync(join(xdg, 'justin-sdk'), {recursive: true});
    writeFileSync(
      join(xdg, 'justin-sdk', 'config.json'),
      JSON.stringify({componentConfig: {thread: {nameWorkspaces: true}}}),
    );
    expect(
      resolveThreadConfig({cwd, env: {XDG_CONFIG_HOME: xdg}}).nameWorkspaces,
    ).toBe(true);
  });
});

const SESSION = '5e551011-aaaa-4bbb-8ccc-0123456789ab';

/**
 * A real beads repo holding one session bead, with the knob as given.
 * `successor` also turns on handoff.successor, which with nameWorkspaces turns
 * on tab titles (home-base-mbnjv.3 item 5).
 */
function world(nameWorkspaces = true, successor = false) {
  const sb = sandbox();
  const xdg = join(sb.path, 'xdg');
  mkdirSync(join(xdg, 'justin-sdk'), {recursive: true});
  writeFileSync(
    join(xdg, 'justin-sdk', 'config.json'),
    JSON.stringify({
      componentConfig: {
        thread: {
          enabled: true,
          nameWorkspaces,
          sessionBeads: true,
          ...(successor ? {handoff: {successor: true}} : {}),
        },
      },
    }),
  );
  const env = {
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SESSION_ID: SESSION,
    CMUX_SURFACE_ID: SURFACE,
    CMUX_WORKSPACE_ID: WS_A,
    JUSTIN_SDK_HEALTH_NOTICES: 'off',
    JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state'),
    JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(sb.path, 'no-transcripts'),
    XDG_CONFIG_HOME: xdg,
  };
  const repo = initRepo(sb, 'named', {'README.md': '# named\n'});
  const init = runBr(repo, ['init', '--prefix', 't', '-q']);
  if (!init.ok) throw new Error(`br init failed: ${init.reason ?? '?'}`);
  const filed = ensureSessionBead({
    cwd: repo,
    env,
    firstPrompt: {at: '2026-10-16T09:00:00.000Z', text: 'Build the thing'},
    now: new Date('2026-10-16T09:00:01.000Z'),
    sessionId: SESSION,
  });
  if (filed.kind !== 'created') throw new Error(filed.kind);
  return {env, repo};
}

describe('D4 b: thread request / thread title with cmux unreadable', () => {
  const unreadable = fakeCmux([], () => ({
    kind: 'failed',
    reason: 'cmux failed: Operation not permitted',
  }));

  test('thread request: one soft line, exit code unchanged', async () => {
    needBr();
    const {env, repo} = world();
    const outcome = await fileRequest({
      bead: null,
      cmux: unreadable.run,
      cwd: repo,
      doneWhen: null,
      env,
      here: false,
      sessionId: null,
      title: 'The actual work',
    });
    expect(outcome).toMatchObject({followUpFailures: [], kind: 'filed'});
    const {exitCode, lines} = describeRequestOutcome(outcome);
    expect(exitCode).toBe(0);
    const soft = lines.filter((line) => line.includes('workspace name'));
    expect(soft).toEqual([
      '  workspace name not set: cmux failed: Operation not permitted; the next prompt will set it',
    ]);
  });

  test('thread title: one soft line, exit code unchanged', async () => {
    needBr();
    const {env, repo} = world();
    const outcome = await renameSession({
      cmux: unreadable.run,
      cwd: repo,
      env,
      sessionId: null,
      title: 'A real title',
    });
    const {exitCode, lines} = describeTitleOutcome(outcome);
    expect(exitCode).toBe(0);
    expect(
      lines.filter((line) => line.includes('workspace name')),
    ).toHaveLength(1);
  });
});

describe('j8q3e.5.3 F1: R is the newest record whose nameSet equals C', () => {
  // Sessions A and B share workspace WS_A and sync at once. B's line was
  // written first and A's last, but B's rename landed last: cmux shows B's
  // name, which is the OLDER line.
  const older = record({
    hisName: 'his name',
    nameSet: '[HOME-BASE] Session B (his name)',
    toolPart: '[HOME-BASE] Session B',
  });
  const newer = record({
    hisName: null,
    nameSet: '[HOME-BASE] Session A',
    toolPart: '[HOME-BASE] Session A',
  });

  test('the decision takes hisName from the matching older line (rule 2)', () => {
    expect(
      decideWorkspaceName({
        current: older.nameSet,
        records: [older, newer],
        toolPart: T,
      }),
    ).toEqual({
      hisName: 'his name',
      kind: 'rename',
      replacedName: null,
      rule: 'tools',
      target: `${T} (his name)`,
    });
  });

  test('--restore restores his name from the matching older line', async () => {
    const env = stateEnv();
    for (const line of [older, newer]) {
      expect(appendWorkspaceName(line, env)).toEqual({kind: 'ok'});
    }
    const cmux = fakeCmux([
      {id: WS_A, surfaces: ['s-a'], title: older.nameSet},
    ]);
    const done = await restoreWorkspaceNames({
      dryRun: false,
      env,
      run: cmux.run,
    });
    expect(done).toMatchObject({
      items: [{kind: 'restore', name: 'his name', result: 'done'}],
      kind: 'done',
    });
    expect(cmux.spaces[0]?.title).toBe('his name');
  });
});

describe('j8q3e.5.3 F2: C equal to T is always the tool’s (rule 0)', () => {
  const his = record({
    hisName: 'his',
    nameSet: '[HOME-BASE] Old title (his)',
    toolPart: '[HOME-BASE] Old title',
  });

  test('a record naming something else: no rename, one ownership line', () => {
    const decided = decideWorkspaceName({
      current: T,
      records: [his],
      toolPart: T,
    });
    expect(decided).toEqual({kind: 'record', name: T, rule: 'matchesToolPart'});
    expect(decided).not.toMatchObject({target: `${T} (${T})`});
  });

  test('a line already naming T: unchanged, and no further line', () => {
    expect(
      decideWorkspaceName({
        current: T,
        records: [record({}), his],
        toolPart: T,
      }),
    ).toEqual({kind: 'unchanged', name: T, rule: 'matchesToolPart'});
  });
});

describe('j8q3e.5.3 F3: the capture child names the workspace', () => {
  const unreadable = fakeCmux([], () => ({kind: 'failed', reason: 'no cmux'}));

  /**
   * A titled session bead in a real beads repo, one prompt in its message log,
   * and the ~/Dev/threads side routed to a fake bd.
   */
  async function captureWorld(successor = false) {
    const w = world(true, successor);
    const fake = createFakeBd();
    const env = {...fake.env, ...w.env, JUSTIN_THREADS_REPO_DIR: fake.dir};
    await renameSession({
      cmux: unreadable.run,
      cwd: w.repo,
      env,
      sessionId: null,
      title: 'A real title',
    });
    runThreadCaptureHook({
      env,
      now: new Date('2026-10-16T09:01:00.000Z'),
      spawnApply: (): SpawnOutcome => ({kind: 'spawned', pid: null}),
      stdin: JSON.stringify({
        cwd: w.repo,
        hook_event_name: 'UserPromptSubmit',
        prompt: 'Build the thing',
        session_id: SESSION,
        transcript_path: join(w.repo, 'no-transcript.jsonl'),
      }),
    });
    return {env, repo: w.repo};
  }

  function apply(
    w: {env: Record<string, string | undefined>; repo: string},
    run: CmuxRunner,
    nameWorkspaces: boolean,
  ) {
    return applyCapture({
      autoCommit: false,
      cmux: run,
      cwd: w.repo,
      env: w.env,
      nameWorkspaces,
      sessionBeads: true,
      sessionId: SESSION,
    });
  }

  test('knob on: the outcome and the run record carry workspaceName', async () => {
    needBr();
    const w = await captureWorld();
    const cmux = fakeCmux([{id: WS_A, surfaces: [SURFACE], title: null}]);
    const outcome = await apply(w, cmux.run, true);
    expect(outcome).toMatchObject({
      kind: 'ran',
      workspaceName: {kind: 'renamed', to: '[NAMED] A real title'},
    });
    expect(cmux.spaces[0]?.title).toBe('[NAMED] A real title');
    const line = captureRunRecord(SESSION, outcome, 5, new Date());
    expect(line.workspaceName).toMatchObject({kind: 'renamed'});
  });

  test('knob off: zero cmux calls, and no workspaceName in the run record', async () => {
    needBr();
    const w = await captureWorld();
    const cmux = fakeCmux([{id: WS_A, surfaces: [SURFACE], title: null}]);
    const outcome = await apply(w, cmux.run, false);
    expect(outcome).toMatchObject({kind: 'ran', workspaceName: null});
    expect(cmux.calls).toEqual([]);
    expect(
      captureRunRecord(SESSION, outcome, 5, new Date()),
    ).not.toHaveProperty('workspaceName');
  });

  test('home-base-mbnjv.8 F3: tab titles on too, one session lookup per capture run', async () => {
    needBr();
    const w = await captureWorld(true);
    const cmux = fakeCmux([{id: WS_A, surfaces: [SURFACE], title: null}]);
    const looked: string[] = [];
    const outcome = await applyCapture({
      autoCommit: false,
      cmux: cmux.run,
      cwd: w.repo,
      env: w.env,
      lookupSession: (input) => {
        looked.push(input.session);
        return lookupWorkspaceSession(input);
      },
      nameWorkspaces: true,
      sessionBeads: true,
      sessionId: SESSION,
    });
    // Both syncs ran on the one lookup: the workspace was named, and the tab
    // sync got past its knob and read the bead's labels (not a successor).
    expect(outcome).toMatchObject({
      kind: 'ran',
      tabTitle: {
        kind: 'skipped',
        reason: 'not a successor (no continues: label)',
      },
      workspaceName: {kind: 'renamed', to: '[NAMED] A real title'},
    });
    expect(looked).toEqual([SESSION]);
  });

  test('a throwing sync is recorded as failed and the capture still applies', async () => {
    needBr();
    const w = await captureWorld();
    const throwing: CmuxRunner = () => {
      throw new Error('cmux exploded');
    };
    const outcome = await apply(w, throwing, true);
    expect(outcome).toMatchObject({
      kind: 'ran',
      sessionBead: {kind: 'exists'},
      workspaceName: {kind: 'failed', reason: 'threw: cmux exploded'},
    });
    expect(captureRunRecord(SESSION, outcome, 5, new Date())).toMatchObject({
      workspaceName: {kind: 'failed'},
    });
  });
});

describe('j8q3e.5.3 F4: thread workspace-name against a fake cmux', () => {
  const unreadable = fakeCmux([], () => ({kind: 'failed', reason: 'no cmux'}));

  /** A titled session (no auto-title) whose surface is in WS_A. */
  async function titled(nameWorkspaces: boolean) {
    const w = world(nameWorkspaces);
    await renameSession({
      cmux: unreadable.run,
      cwd: w.repo,
      env: w.env,
      sessionId: null,
      title: 'A real title',
    });
    return w;
  }

  function cli(
    w: {env: Record<string, string | undefined>; repo: string},
    run: CmuxRunner,
    flags: {dryRun?: boolean; restore?: boolean} = {},
  ): Promise<number> {
    return runThreadWorkspaceName({
      cwd: w.repo,
      dryRun: flags.dryRun ?? false,
      env: w.env,
      restore: flags.restore ?? false,
      run,
      session: null,
      workspace: null,
    });
  }

  test('knob off without --dry-run: exit 1 and zero cmux calls', async () => {
    needBr();
    const w = await titled(false);
    const cmux = fakeCmux([{id: WS_A, surfaces: [SURFACE], title: null}]);
    expect(await cli(w, cmux.run)).toBe(1);
    expect(cmux.calls).toEqual([]);
  });

  test('--dry-run (knob off) reads cmux and makes no rename or clear-name call', async () => {
    needBr();
    const w = await titled(false);
    const cmux = fakeCmux([{id: WS_A, surfaces: [SURFACE], title: 'his'}]);
    expect(await cli(w, cmux.run, {dryRun: true})).toBe(0);
    expect(cmux.calls.length).toBeGreaterThan(0);
    expect(renames(cmux.calls)).toEqual([]);
    expect(cmux.spaces[0]?.title).toBe('his');
    expect(recordLines(w.env)).toEqual([]);
  });

  test('--restore --dry-run makes no rename or clear-name call', async () => {
    const env = stateEnv();
    appendWorkspaceName(record({hisName: 'his', nameSet: `${T} (his)`}), env);
    const cmux = fakeCmux([{id: WS_A, surfaces: ['s-a'], title: `${T} (his)`}]);
    const code = await cli({env, repo: sandbox().path}, cmux.run, {
      dryRun: true,
      restore: true,
    });
    expect(code).toBe(0);
    expect(renames(cmux.calls)).toEqual([]);
    expect(cmux.spaces[0]?.title).toBe(`${T} (his)`);
  });

  test('a readback that never matches exits 1', async () => {
    needBr();
    const w = await titled(true);
    // cmux accepts the rename but keeps the old name.
    const cmux = fakeCmux(
      [{id: WS_A, surfaces: [SURFACE], title: null}],
      (args) => (args[0] === 'rename-workspace' ? ok('OK') : null),
    );
    expect(await cli(w, cmux.run)).toBe(1);
    expect(renames(cmux.calls)).toHaveLength(1);
    expect(cmux.spaces[0]?.title).toBeNull();
  });
});

describe('home-base-bomy5.7.1: the short project tag', () => {
  test('a recorded "[HOME-BASE] X (his name)" is renamed to "[HOME] X (his name)" on the next sync', async () => {
    const env = stateEnv();
    const path = workspaceNamesPath(env);
    mkdirSync(join(path, '..'), {recursive: true});
    const old = `${T} (his name)`;
    writeFileSync(
      path,
      `${JSON.stringify(
        record({hisName: 'his name', nameSet: old, surfaceId: SURFACE}),
      )}\n`,
    );
    const cmux = fakeCmux([{id: WS_A, surfaces: [SURFACE], title: old}]);
    const outcome = await syncWorkspaceName({
      enabled: true,
      env,
      run: cmux.run,
      session: session({repoTag: 'HOME'}),
    });
    expect(outcome).toMatchObject({
      kind: 'renamed',
      rule: 'tools',
      to: '[HOME] Fix the login bug (his name)',
    });
    expect(renames(cmux.calls)).toEqual([
      [
        'rename-workspace',
        '--workspace',
        WS_A,
        '--',
        '[HOME] Fix the login bug (his name)',
      ],
    ]);
  });

  test("the session looked up for a sync carries its checkout's tag: declared, absent, invalid", () => {
    needBr();
    for (const [config, want] of [
      [{projectTag: 'NM'}, 'NM'],
      [null, 'NAMED'],
      [{projectTag: 'nm'}, 'NAMED'],
    ] as const) {
      const {env, repo} = world();
      if (config != null) {
        writeFileSync(
          join(repo, 'justin-sdk.config.json'),
          JSON.stringify(config),
        );
      }
      const lookup = lookupWorkspaceSession({cwd: repo, env, session: SESSION});
      if (lookup.kind !== 'found') throw new Error(lookup.reason);
      expect({config, tag: lookup.session.repoTag}).toEqual({
        config,
        tag: want,
      });
      expect(lookup.session.repo).toBe('named');
    }
  });
});
