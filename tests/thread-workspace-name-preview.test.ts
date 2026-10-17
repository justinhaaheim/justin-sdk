/**
 * The workspace-name preview (home-base-j8q3e.5.2). Every cmux call goes to a
 * FAKE runner: the suite may itself run inside cmux, and Justin's workspace
 * names cannot be recovered. The preview must never rename, clear or record.
 */

import type {CmuxCall, CmuxRunner} from '../src/thread/cmux';
import type {PreviewSession} from '../src/thread/workspace-name-preview';

import {describe, expect, test} from 'bun:test';
import {mkdtempSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {
  previewCounts,
  previewWorkspaceNames,
  renderWorkspaceNamePreview,
} from '../src/thread/workspace-name-preview';
import {runThreadWorkspaceName} from '../src/thread/workspace-name-session';

const WS_A = 'AAAAAAAA-0000-4000-8000-00000000000A';
const WS_B = 'BBBBBBBB-0000-4000-8000-00000000000B';

function env(
  stateDir = mkdtempSync(join(tmpdir(), 'ws-preview-')),
): Record<string, string | undefined> {
  return {
    // The preview must never read these: they name the CALLER's workspace.
    CMUX_SURFACE_ID: undefined,
    CMUX_WORKSPACE_ID: undefined,
    JUSTIN_THREADS_STATE_DIR: stateDir,
  };
}

const ok = (stdout: string): CmuxCall => ({kind: 'ok', stdout});

/**
 * One window holding `spaces`; anything but a read is refused and recorded.
 * `listed: false` leaves a workspace out of the window's list (the list can
 * lag the tree).
 */
function fakeCmux(
  spaces: {
    id: string;
    listed?: boolean;
    surfaces: string[];
    title: string | null;
  }[],
  fail: 'list' | 'tree' | null = null,
): {calls: string[][]; run: CmuxRunner} {
  const calls: string[][] = [];
  const run: CmuxRunner = (args) => {
    calls.push([...args]);
    if (args.includes('tree')) {
      if (fail === 'tree') {
        return Promise.resolve({
          kind: 'failed',
          reason: 'cmux tree failed: connect: Operation not permitted',
        });
      }
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
      if (fail === 'list') return Promise.resolve(ok('not json'));
      return Promise.resolve(
        ok(
          JSON.stringify({
            workspaces: spaces
              .filter((space) => space.listed !== false)
              .map((space) => ({custom_title: space.title, id: space.id})),
          }),
        ),
      );
    }
    return Promise.resolve({
      kind: 'failed',
      reason: `refused by the fake: ${args.join(' ')}`,
    });
  };
  return {calls, run};
}

function session(extra: Partial<PreviewSession>): PreviewSession {
  return {
    beadId: 'hb-1',
    labels: ['session', 'cmux-surface:S-1'],
    lastActivityAt: '2026-10-16T09:00:00.000Z',
    repo: 'home-base',
    repoTag: 'HOME-BASE',
    sessionId: '5e551011-aaaa-4bbb-8ccc-0123456789ab',
    title: 'Fix the login bug',
    ...extra,
  };
}

/** Only reads: `tree` and `workspace list`, never a write. */
function onlyReads(calls: string[][]): boolean {
  return calls.every(
    (args) =>
      args.includes('tree') || (args[1] === 'workspace' && args[2] === 'list'),
  );
}

describe('the preview over every open workspace', () => {
  test('two sessions in one workspace: the more recent names it', async () => {
    const cmux = fakeCmux([{id: WS_A, surfaces: ['S-1', 'S-2'], title: null}]);
    const outcome = await previewWorkspaceNames({
      env: env(),
      run: cmux.run,
      sessions: [
        session({
          beadId: 'hb-new',
          labels: ['session', 'cmux-surface:S-2'],
          lastActivityAt: '2026-10-16T10:00:00.000Z',
          title: 'New work',
        }),
        session({beadId: 'hb-old', title: 'Old work'}),
      ],
    });
    expect(outcome).toMatchObject({
      items: [
        {
          namer: {beadId: 'hb-new'},
          verdict: {kind: 'rename', rule: 'empty', to: '[HOME-BASE] New work'},
        },
      ],
      kind: 'read',
    });
    expect(onlyReads(cmux.calls)).toBe(true);
  });

  test('a session still carrying auto-title cannot name its workspace', async () => {
    const cmux = fakeCmux([{id: WS_A, surfaces: ['S-1'], title: 'his'}]);
    const outcome = await previewWorkspaceNames({
      env: env(),
      run: cmux.run,
      sessions: [
        session({labels: ['session', 'auto-title', 'cmux-surface:S-1']}),
      ],
    });
    expect(outcome).toMatchObject({
      items: [
        {
          namer: null,
          skipped: [{beadId: 'hb-1'}],
          verdict: {kind: 'unchanged'},
        },
      ],
      kind: 'read',
    });
  });

  test('a workspace with no session is listed, unchanged, with why', async () => {
    const cmux = fakeCmux([
      {id: WS_A, surfaces: ['S-1'], title: 'home 10-05'},
      {id: WS_B, surfaces: ['S-9'], title: '✳ Something'},
    ]);
    const outcome = await previewWorkspaceNames({
      env: env(),
      run: cmux.run,
      sessions: [session({})],
    });
    expect(outcome).toMatchObject({
      items: [
        {
          verdict: {
            hisName: 'home 10-05',
            kind: 'rename',
            rule: 'his',
            to: '[HOME-BASE] Fix the login bug (home 10-05)',
          },
          workspaceId: WS_A,
        },
        {
          current: '✳ Something',
          namer: null,
          verdict: {
            kind: 'unchanged',
            why: 'no session bead’s surface is in this workspace',
          },
          workspaceId: WS_B,
        },
      ],
      kind: 'read',
    });
    if (outcome.kind === 'read') {
      expect(previewCounts(outcome)).toEqual({
        generated: 0,
        his: 1,
        noSession: 1,
        rename: 1,
        total: 2,
        unchanged: 1,
        unreadable: 0,
      });
      const text = renderWorkspaceNamePreview(
        {...outcome, knobs: [], notes: []},
        {color: false, width: null},
      );
      expect(text).toContain('Could not read (0)');
      expect(text).toContain('Would be renamed (1)');
      expect(text).toContain('Unchanged (1)');
    }
  });

  test('a workspace its window list lacks is listed under Could not read; the rest stands', async () => {
    const cmux = fakeCmux([
      {id: WS_A, surfaces: ['S-1'], title: null},
      {id: WS_B, listed: false, surfaces: ['S-2'], title: null},
    ]);
    const outcome = await previewWorkspaceNames({
      env: env(),
      run: cmux.run,
      sessions: [
        session({}),
        session({beadId: 'hb-2', labels: ['session', 'cmux-surface:S-2']}),
      ],
    });
    expect(outcome).toMatchObject({
      items: [{verdict: {kind: 'rename'}, workspaceId: WS_A}],
      kind: 'read',
      unreadable: [{windowRef: 'window:1', workspaceId: WS_B}],
    });
    if (outcome.kind !== 'read') return;
    // WS_B's name was not read: it is not an item, so not "(no name)".
    expect(outcome.items).toHaveLength(1);
    expect(outcome.unreadable[0]?.reason).toContain('its name was not read');
    expect(previewCounts(outcome)).toMatchObject({total: 2, unreadable: 1});
    const text = renderWorkspaceNamePreview(
      {...outcome, knobs: [], notes: []},
      {color: false, width: null},
    );
    expect(text).toContain('Could not read (1)');
    expect(text).toContain(`${WS_B} (window:1)`);
    expect(onlyReads(cmux.calls)).toBe(true);
  });

  test('an unreadable record fails the whole preview with the reason', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-preview-'));
    writeFileSync(join(dir, 'workspace-names.jsonl'), '{"not a record"\n');
    const cmux = fakeCmux([{id: WS_A, surfaces: ['S-1'], title: 'his'}]);
    const outcome = await previewWorkspaceNames({
      env: env(dir),
      run: cmux.run,
      sessions: [session({})],
    });
    expect(outcome).toMatchObject({kind: 'failed'});
    if (outcome.kind === 'failed') {
      expect(outcome.reason).toContain('workspace-names.jsonl');
    }
  });

  test.each(['tree', 'list'] as const)(
    'an unreadable cmux (%s) fails the whole preview with the reason, never an empty list',
    async (fail) => {
      const cmux = fakeCmux([{id: WS_A, surfaces: ['S-1'], title: null}], fail);
      const outcome = await previewWorkspaceNames({
        env: env(),
        run: cmux.run,
        sessions: [session({})],
      });
      expect(outcome.kind).toBe('failed');
      if (outcome.kind === 'failed') {
        expect(outcome.reason).toContain(
          fail === 'tree' ? 'Operation not permitted' : 'cannot read',
        );
      }
    },
  );

  test('--all without --dry-run is refused, with no cmux call', async () => {
    const cmux = fakeCmux([{id: WS_A, surfaces: ['S-1'], title: null}]);
    const code = await runThreadWorkspaceName({
      all: true,
      cwd: tmpdir(),
      dryRun: false,
      env: env(),
      restore: false,
      run: cmux.run,
      session: null,
      workspace: null,
    });
    expect(code).toBe(2);
    expect(cmux.calls).toEqual([]);
  });
});

describe('bomy5.4.1: the preview names the session that keeps the name', () => {
  const OLD = '[HOME-BASE] Old work';
  function namedByOld(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ws-preview-'));
    writeFileSync(
      join(dir, 'workspace-names.jsonl'),
      `${JSON.stringify({
        at: '2026-10-16T08:00:00.000Z',
        beadId: 'hb-old',
        hisName: null,
        nameSet: OLD,
        replacedName: null,
        repo: 'home-base',
        sessionId: null,
        surfaceId: 'S-1',
        toolPart: OLD,
        workspaceId: WS_A,
      })}\n`,
    );
    return dir;
  }
  const sessions = [
    session({
      beadId: 'hb-new',
      labels: ['session', 'cmux-surface:S-2'],
      lastActivityAt: '2026-10-16T10:00:00.000Z',
      title: 'New work',
    }),
    session({beadId: 'hb-old', title: 'Old work'}),
  ];

  test('the owner’s pane is here: it is the namer, kept by it', async () => {
    const cmux = fakeCmux([{id: WS_A, surfaces: ['S-1', 'S-2'], title: OLD}]);
    const outcome = await previewWorkspaceNames({
      env: env(namedByOld()),
      run: cmux.run,
      sessions,
    });
    expect(outcome).toMatchObject({
      items: [{namer: {beadId: 'hb-old'}, verdict: {kind: 'unchanged'}}],
      kind: 'read',
    });
    if (outcome.kind === 'read') {
      const verdict = outcome.items[0]?.verdict;
      expect(verdict?.kind === 'unchanged' ? verdict.why : '').toContain(
        'kept by hb-old, still open here',
      );
    }
    expect(onlyReads(cmux.calls)).toBe(true);
  });

  test('the owner’s pane has left: the newest session takes it (rule 2)', async () => {
    const cmux = fakeCmux([{id: WS_A, surfaces: ['S-2'], title: OLD}]);
    const outcome = await previewWorkspaceNames({
      env: env(namedByOld()),
      run: cmux.run,
      sessions,
    });
    expect(outcome).toMatchObject({
      items: [
        {
          namer: {beadId: 'hb-new'},
          verdict: {kind: 'rename', rule: 'tools', to: '[HOME-BASE] New work'},
        },
      ],
      kind: 'read',
    });
  });
});
