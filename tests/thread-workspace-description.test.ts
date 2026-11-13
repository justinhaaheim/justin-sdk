/**
 * The cmux workspace description and short labels (home-base-jm5kg.18). Real br
 * in throwaway repos; every state file under a temp JUSTIN_THREADS_STATE_DIR;
 * cmux, the hook store and ps are fakes.
 */

import type {CmuxCall, CmuxRunner} from '../src/thread/cmux';
import type {ChainRequestReaders} from '../src/thread/overarching';
import type {HookStore, Proc} from '../src/thread/pane-join';
import type {SessionModel} from '../src/thread/session-model';
import type {MarkItem, SessionStatus} from '../src/thread/session-status';
import type {TreeIssue} from '../src/thread/session-tree';
import type {DescriptionReaders} from '../src/thread/workspace-description';
import type {WorkspaceSession} from '../src/thread/workspace-name';
import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, test} from 'bun:test';
import {mkdirSync, writeFileSync} from 'fs';
import {join} from 'path';

import {brShow, runBr} from '../src/beads/br';
import {applyCapture, captureRunRecord} from '../src/thread/capture';
import {resolveThreadConfig} from '../src/thread/config';
import {descriptionItemsOf} from '../src/thread/overarching';
import {
  describeRequestOutcome,
  fileRequest,
  renameSession,
} from '../src/thread/request';
import {ensureSessionBead} from '../src/thread/session-bead';
import {markLine} from '../src/thread/session-report';
import {whatToMark} from '../src/thread/session-status';
import {
  checkShortText,
  CUT_TITLE_LIMIT,
  cutTitle,
  readShortLabel,
  shortLabelEdit,
  shortLabelOf,
  shortOrCutTitle,
} from '../src/thread/short-label';
import {
  isToolDescription,
  NO_TITLE_YET,
  renderDescription,
  sessionsOnSurfaces,
  syncWorkspaceDescription,
} from '../src/thread/workspace-description';
import {
  appendWorkspaceName,
  syncWorkspaceName,
} from '../src/thread/workspace-name';
import {
  lookupWorkspaceSession,
  syncDescriptionForCapture,
  withOverarchingShort,
  workspaceNameFollowUp,
} from '../src/thread/workspace-name-session';
import {initRepo} from './git-fixtures';
import {needBr} from './pinned-br';
import {createSandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

const SESSION = '0ae5c4ee-aaaa-4bbb-8ccc-0123456789ab';
const OTHER = '0ae5c4ee-2222-4bbb-8ccc-0123456789ab';
const WS = 'AAAAAAAA-0000-4000-8000-00000000000A';
const SURFACE = '5F5F5F5F-0000-4000-8000-000000000001';
const SURFACE_2 = '5F5F5F5F-0000-4000-8000-000000000002';
const SURFACE_ELSEWHERE = '5F5F5F5F-0000-4000-8000-000000000009';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function issue(
  id: string,
  title: string,
  extra: Partial<TreeIssue> = {},
): TreeIssue {
  return {
    acceptanceCriteria: null,
    beadsDir: '/x/.beads',
    closeReason: null,
    createdAt: `2026-10-30T10:00:0${id.slice(-1)}.000Z`,
    description: null,
    id,
    issueType: 'task',
    labels: ['request'],
    notes: null,
    parentIds: [],
    priority: 2,
    status: 'in_progress',
    title,
    updatedAt: null,
    ...extra,
  } as TreeIssue;
}

function proc(pid: number, name = 'claude'): Proc {
  return {
    command: name,
    etime: '1:00',
    exePath: `/bin/${name}`,
    name,
    pid,
    ppid: 1,
    tty: 'ttys001',
  };
}

const session = (
  beadId: string,
  title: string,
  surface = SURFACE,
  sessionId = SESSION,
): WorkspaceSession => ({
  beadId,
  labels: [`cmux-surface:${surface}`],
  repo: 'named',
  repoTag: 'NAMED',
  sessionId,
  title,
});

interface FakeCmux {
  calls: string[][];
  description: {value: null | string | undefined};
  run: CmuxRunner;
  writes: () => string[][];
}

const ok = (stdout: string): CmuxCall => ({kind: 'ok', stdout});

/** One workspace in one window. `description` undefined: this cmux has no key. */
function fakeCmux(
  input: {
    description?: null | string | undefined;
    failWrite?: boolean;
    surfaces?: string[];
    title?: string;
  } = {},
): FakeCmux {
  const description = {
    value: 'description' in input ? input.description : null,
  };
  const calls: string[][] = [];
  const run: CmuxRunner = (args) => {
    calls.push([...args]);
    if (args.includes('tree') && args.includes('--all')) {
      return Promise.resolve(
        ok(
          JSON.stringify({
            windows: [
              {
                id: 'W-1',
                ref: 'window:1',
                workspaces: [
                  {
                    id: WS,
                    panes: [
                      {
                        surfaces: (input.surfaces ?? [SURFACE]).map((id) => ({
                          id,
                        })),
                      },
                    ],
                  },
                ],
              },
            ],
          }),
        ),
      );
    }
    if (args.includes('tree')) {
      return Promise.resolve(
        ok(
          JSON.stringify({
            windows: [
              {
                workspaces: [
                  {
                    ...(description.value === undefined
                      ? {}
                      : {description: description.value}),
                    id: WS,
                    panes: [
                      {
                        surfaces: (input.surfaces ?? [SURFACE]).map((id) => ({
                          id,
                        })),
                      },
                    ],
                    title: input.title ?? '[NAMED] Head',
                  },
                ],
              },
            ],
          }),
        ),
      );
    }
    if (args[0] === 'workspace-action') {
      if (input.failWrite === true) {
        return Promise.resolve({
          kind: 'failed',
          reason: 'cmux said no',
          timedOut: false,
        });
      }
      const at = args.indexOf('--description');
      description.value =
        args[2] === 'clear-description' ? null : (args[at + 1] ?? null);
      return Promise.resolve(ok('OK'));
    }
    return Promise.resolve({
      kind: 'failed',
      reason: `unexpected: ${args.join(' ')}`,
      timedOut: false,
    });
  };
  return {
    calls,
    description,
    run,
    writes: () => calls.filter((call) => call[0] === 'workspace-action'),
  };
}

/** Readers over a map of session bead → its requests. */
function readers(input: {
  beads?: Record<string, {labels?: string[]; title: string}>;
  bySession?: Record<string, string>;
  chainFails?: string;
  hookStore?: HookStore;
  hookStoreFails?: string;
  procs?: Proc[];
  procsFail?: string;
  requests?: Record<string, TreeIssue[]>;
}): DescriptionReaders {
  const chain: ChainRequestReaders = {
    chainBeads: (start) => ({beads: [start], kind: 'read', selfIndex: 0}),
    requestsOf: (bead) =>
      input.chainFails != null
        ? {kind: 'failed', reason: input.chainFails}
        : {kind: 'read', requests: input.requests?.[bead.id] ?? []},
  };
  const beadOf = (id: string) => ({
    id,
    labels: input.beads?.[id]?.labels ?? [],
    title: input.beads?.[id]?.title ?? id,
  });
  return {
    chain,
    hookStore: () =>
      input.hookStoreFails != null
        ? {ok: false, reason: input.hookStoreFails}
        : {ok: true, value: input.hookStore ?? {sessions: {}}},
    processes: () =>
      Promise.resolve(
        input.procsFail != null
          ? {ok: false, reason: input.procsFail}
          : {ok: true, value: input.procs ?? []},
      ),
    session: (sessionId) => {
      const id = input.bySession?.[sessionId];
      return id == null ? {kind: 'none'} : {bead: beadOf(id), kind: 'found'};
    },
    showBead: (id) =>
      input.beads?.[id] == null
        ? {kind: 'notFound', reason: `no ${id}`}
        : {bead: beadOf(id), kind: 'found'},
  };
}

function stateEnv(): Record<string, string | undefined> {
  const sb = createSandbox();
  sandboxes.push(sb);
  return {JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state')};
}

interface World {
  db: string;
  env: Record<string, string | undefined>;
  repo: string;
  sessionBeadId: string;
}

function world(knobs: {description?: boolean} = {}): World {
  const sb = createSandbox();
  sandboxes.push(sb);
  const xdg = join(sb.path, 'xdg');
  mkdirSync(join(xdg, 'justin-sdk'), {recursive: true});
  writeFileSync(
    join(xdg, 'justin-sdk', 'config.json'),
    JSON.stringify({
      componentConfig: {
        thread: {
          enabled: true,
          nameWorkspaces: true,
          sessionBeads: true,
          titleSummary: true,
          workspaceDescription: knobs.description ?? false,
        },
      },
    }),
  );
  const env = {
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SESSION_ID: SESSION,
    CMUX_SURFACE_ID: SURFACE,
    CMUX_WORKSPACE_ID: WS,
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
    firstPrompt: {at: '2026-10-30T09:00:00.000Z', text: 'A simple question'},
    now: new Date('2026-10-30T09:00:01.000Z'),
    sessionId: SESSION,
  });
  if (filed.kind !== 'created') throw new Error(filed.kind);
  return {
    db: join(repo, '.beads', 'beads.db'),
    env,
    repo,
    sessionBeadId: filed.beadId,
  };
}

function noCmux(): CmuxRunner {
  return () =>
    Promise.resolve({kind: 'failed', reason: 'no cmux', timedOut: false});
}

async function request(
  w: World,
  title: string | null,
  extra: {
    bead?: string;
    continues?: string;
    overarching?: boolean;
    run?: CmuxRunner;
    short?: string;
  } = {},
) {
  return await fileRequest({
    bead: extra.bead ?? null,
    cmux: extra.run ?? noCmux(),
    continues: extra.continues ?? null,
    cwd: w.repo,
    doneWhen: null,
    env: w.env,
    here: false,
    overarching: extra.overarching === true,
    sessionId: null,
    short: extra.short ?? null,
    title,
  });
}

function filedId(outcome: Awaited<ReturnType<typeof fileRequest>>): string {
  if (outcome.kind !== 'filed') throw new Error(JSON.stringify(outcome));
  return outcome.id;
}

function labelsOf(w: World, id: string): string[] {
  const shown = brShow({db: w.db, env: {}}, id);
  if (shown.kind !== 'ok') throw new Error(`br show ${id}: ${shown.kind}`);
  return shown.issue.labels;
}

// ---------------------------------------------------------------------------
// Short labels
// ---------------------------------------------------------------------------

describe('short labels', () => {
  test.each([
    ['Fix login', 'Fix login'],
    ['  Fix   login  bug ', 'Fix login bug'],
    ['Spend quota blocks runaway usage', 'Spend quota blocks runaway usage'],
    ['Re-run v2: handoff', 'Re-run v2: handoff'],
  ])('accepts %j', (raw, text) => {
    expect(checkShortText(raw)).toEqual({ok: true, text});
  });

  test.each([
    ['one word', 'Refactor'],
    ['six words', 'one two three four five six'],
    ['an apostrophe', "Fix Justin's bug"],
    ['an underscore, which stands for a space', 'Fix login_bug now'],
    ['a dot', 'Bump v0.1 now'],
    ['an emoji', 'Fix 🔳 mark'],
    ['empty', ''],
    [
      'over the length',
      'abcdefghijklmnop abcdefghijklmnop abcdefghijklmnop abcdefghijklmnop',
    ],
  ])('refuses %s', (_why, raw) => {
    expect(checkShortText(raw).ok).toBe(false);
  });

  test('the label reads as it means, and round-trips', () => {
    expect(shortLabelOf('Fix login bug')).toBe('short:Fix_login_bug');
    expect(readShortLabel(['request', 'short:Fix_login_bug'])).toBe(
      'Fix login bug',
    );
    expect(readShortLabel(['request'])).toBeNull();
  });

  test('a new label replaces the old one in one edit', () => {
    expect(shortLabelEdit(['request', 'short:Old_one'], 'New one')).toEqual({
      addLabels: ['short:New_one'],
      removeLabels: ['short:Old_one'],
    });
    expect(shortLabelEdit(['short:Same_one'], 'Same one')).toEqual({
      addLabels: ['short:Same_one'],
      removeLabels: [],
    });
  });

  test('a title with no label is cut with "…", never inside an emoji', () => {
    expect(cutTitle('Short enough')).toBe('Short enough');
    const long = '🔳'.repeat(CUT_TITLE_LIMIT + 5);
    const cut = cutTitle(long);
    expect(Array.from(cut)).toHaveLength(CUT_TITLE_LIMIT);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut).not.toMatch(/[\uD800-\uDBFF]…$/u);
    expect(shortOrCutTitle({labels: [], title: 'Short enough'})).toBe(
      'Short enough',
    );
    expect(
      shortOrCutTitle({labels: ['short:Two_words'], title: 'Short enough'}),
    ).toBe('Two words');
  });
});

describe('thread request --short', () => {
  test('on a new request, with --overarching too, and it prints the label', async () => {
    needBr();
    const w = world();
    const plain = await request(w, 'Fix the login bug in the header', {
      short: 'Fix login bug',
    });
    expect(labelsOf(w, filedId(plain))).toContain('short:Fix_login_bug');
    expect(describeRequestOutcome(plain).lines.join('\n')).toContain(
      'short label: Fix login bug',
    );
    const over = await request(w, 'Refine the handoff command', {
      overarching: true,
      short: 'Refine handoff command',
    });
    const labels = labelsOf(w, filedId(over));
    expect(labels).toContain('short:Refine_handoff_command');
    expect(labels).toContain('overarching');
  });

  test('--bead sets it on an existing request and replaces an old one', async () => {
    needBr();
    const w = world();
    const id = filedId(await request(w, 'An old request with a long title'));
    expect(labelsOf(w, id).some((l) => l.startsWith('short:'))).toBe(false);
    const adopted = await request(w, null, {bead: id, short: 'Old request'});
    expect(adopted).toMatchObject({kind: 'filed', short: 'Old request'});
    expect(labelsOf(w, id)).toContain('short:Old_request');
    await request(w, null, {bead: id, short: 'Newer request'});
    const labels = labelsOf(w, id).filter((l) => l.startsWith('short:'));
    expect(labels).toEqual(['short:Newer_request']);
  });

  test('a refused label files nothing', async () => {
    needBr();
    const w = world();
    const outcome = await request(w, 'A real title', {short: 'Refactor'});
    expect(outcome.kind).toBe('usage');
    expect(describeRequestOutcome(outcome).exitCode).toBe(2);
    const listed = runBr(w.repo, ['list', '--json', '-l', 'request']);
    expect(listed.ok ? listed.stdout : '').not.toContain('A real title');
  });

  test('with only --continues it is a usage error', async () => {
    needBr();
    const w = world();
    expect(
      await request(w, null, {continues: 't-1', short: 'Two words'}),
    ).toMatchObject({kind: 'usage'});
  });

  test('thread title drops the overarching label, which described the old title', async () => {
    needBr();
    const w = world();
    const id = filedId(
      await request(w, 'The old whole of the work', {
        overarching: true,
        short: 'Old whole',
      }),
    );
    const renamed = await renameSession({
      cmux: noCmux(),
      cwd: w.repo,
      env: w.env,
      sessionId: null,
      title: 'The new whole of the work',
    });
    expect(renamed).toMatchObject({kind: 'renamed'});
    expect(labelsOf(w, id).some((l) => l.startsWith('short:'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The text
// ---------------------------------------------------------------------------

describe('the description text', () => {
  test('the count line, then each block in the order given (Justin’s 2026-11-03 example lines)', () => {
    expect(
      renderDescription(
        [
          {done: true, label: 'Spend quota blocks runaway usage'},
          {done: false, label: 'Improve cmux workspace naming'},
        ],
        [
          {
            items: [
              {done: true, label: 'XYZ'},
              {done: false, label: 'ABC'},
            ],
            title: 'Fix zshrc issue',
          },
        ],
      ),
    ).toBe(
      [
        '📈 1/2 Completed',
        '✅ Spend quota blocks runaway usage',
        '🔳 Improve cmux workspace naming',
        '💬💬💬 [Session] Fix zshrc issue',
        '✅ XYZ',
        '🔳 ABC',
      ].join('\n'),
    );
  });

  test('Justin’s 2026-11-12 example: the count, then unfinished, then finished', () => {
    const own = descriptionItemsOf({
      headTitle: 'The whole session',
      requests: [
        issue('t-1', 'Item 1', {status: 'closed'}),
        issue('t-2', 'Item 2', {status: 'closed'}),
        issue('t-3', 'Item 3', {status: 'closed'}),
        issue('t-4', 'Item 4'),
        issue('t-5', 'Item 5'),
      ],
    });
    expect(renderDescription(own, [])).toBe(
      [
        '📈 3/5 Completed',
        '🔳 Item 4',
        '🔳 Item 5',
        '✅ Item 1',
        '✅ Item 2',
        '✅ Item 3',
      ].join('\n'),
    );
  });

  test('no count line when the namer has no requests listed, and none for another session', () => {
    expect(renderDescription([], [])).toBe('');
    expect(
      renderDescription(
        [],
        [{items: [{done: false, label: 'ABC'}], title: 'Fix zshrc issue'}],
      ),
    ).toBe(['💬💬💬 [Session] Fix zshrc issue', '🔳 ABC'].join('\n'));
  });

  test('open before done, oldest first; overarching, "not needed" and the head title are left out', () => {
    expect(
      descriptionItemsOf({
        headTitle: 'First request',
        requests: [
          issue('t-1', 'First request'),
          issue('t-2', 'Open, older', {
            labels: ['request', 'short:Open_older'],
          }),
          issue('t-3', 'Done, older', {status: 'closed'}),
          issue('t-4', 'A placeholder', {
            closeReason: 'not needed: the PDF export runs its own query',
            status: 'closed',
          }),
          issue('t-5', 'The whole of it', {
            labels: [
              'request',
              'overarching',
              'overarching-set:2026-10-30T10:00:05Z',
            ],
          }),
          issue('t-6', 'Open, newer'),
          issue('t-7', 'Done, newer', {status: 'closed'}),
        ],
      }),
    ).toEqual([
      {done: false, label: 'Open older'},
      {done: false, label: 'Open, newer'},
      {done: true, label: 'Done, older'},
      {done: true, label: 'Done, newer'},
    ]);
  });

  test('only text the tool writes counts as the tool’s', () => {
    expect(isToolDescription('✅ One\n🔳 Two\n💬💬💬 [Session] Three')).toBe(
      true,
    );
    expect(
      isToolDescription('This is workspace description.\nItem A\nItem B'),
    ).toBe(false);
    expect(isToolDescription('✅ One\nA line he added')).toBe(false);
    expect(isToolDescription('📈 1/2 Completed\n🔳 Two\n✅ One')).toBe(true);
    // Only the exact count line is the tool's: his own 📈 text stays his.
    expect(isToolDescription('📈 Sales are up\n✅ One')).toBe(false);
    expect(isToolDescription('📈 1/2 Completed today\n✅ One')).toBe(false);
  });
});

describe('sessionsOnSurfaces', () => {
  const store: HookStore = {
    sessions: {
      dead: {pid: 1, startedAt: 1, surfaceId: SURFACE, updatedAt: 9},
      elsewhere: {pid: 2, startedAt: 2, surfaceId: SURFACE_ELSEWHERE},
      newer: {pid: 3, startedAt: 30, surfaceId: SURFACE_2, updatedAt: 5},
      nosurface: {pid: 3, startedAt: 3},
      older: {pid: 4, startedAt: 40, surfaceId: SURFACE.toLowerCase()},
      preclear: {pid: 3, startedAt: 20, surfaceId: SURFACE_2, updatedAt: 4},
      reused: {pid: 5, startedAt: 5, surfaceId: SURFACE_ELSEWHERE},
    },
  };

  test('live sessions here, oldest first; after a /clear the one updated last', () => {
    expect(
      sessionsOnSurfaces(
        store,
        [proc(2), proc(3), proc(4), proc(5)],
        [SURFACE, SURFACE_2],
      ),
    ).toEqual([
      {sessionId: 'newer', startedAt: 30},
      {sessionId: 'older', startedAt: 40},
    ]);
  });

  test('a stored pid reused by another program is not a session', () => {
    expect(
      sessionsOnSurfaces(
        store,
        [proc(3, 'zsh'), proc(4, 'bun')],
        [SURFACE, SURFACE_2],
      ),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The sync
// ---------------------------------------------------------------------------

describe('syncWorkspaceDescription', () => {
  const twoItems = {
    requests: {
      't-s': [
        issue('t-1', 'Head'),
        issue('t-2', 'A long title for the done request', {status: 'closed'}),
        issue('t-3', 'Open thing', {labels: ['request', 'short:Open_thing']}),
      ],
    },
  };

  test('knob off: no cmux call and no read', async () => {
    const cmux = fakeCmux();
    const outcome = await syncWorkspaceDescription({
      enabled: false,
      env: {JUSTIN_THREADS_STATE_DIR: '/nonexistent/state'},
      readers: readers({hookStoreFails: 'must not be read'}),
      run: cmux.run,
      session: session('t-s', 'Head'),
      workspaceId: WS,
    });
    expect(outcome).toEqual({kind: 'off'});
    expect(cmux.calls).toEqual([]);
  });

  test('writes the text with the set-description action, by uuid, and reads it back', async () => {
    const cmux = fakeCmux();
    const outcome = await syncWorkspaceDescription({
      enabled: true,
      env: stateEnv(),
      readers: readers(twoItems),
      run: cmux.run,
      session: session('t-s', 'Head'),
      workspaceId: WS,
    });
    const text =
      '📈 1/2 Completed\n🔳 Open thing\n✅ A long title for the done request';
    expect(outcome).toMatchObject({
      kind: 'written',
      readback: {description: text, kind: 'read'},
      to: text,
    });
    expect(cmux.writes()).toEqual([
      [
        'workspace-action',
        '--action',
        'set-description',
        '--workspace',
        WS,
        '--description',
        text,
      ],
    ]);
  });

  test('written only when the text changed', async () => {
    const env = stateEnv();
    const cmux = fakeCmux();
    const input = {
      enabled: true,
      env,
      readers: readers(twoItems),
      run: cmux.run,
      session: session('t-s', 'Head'),
      workspaceId: WS,
    };
    await syncWorkspaceDescription(input);
    expect(cmux.writes()).toHaveLength(1);
    expect(await syncWorkspaceDescription(input)).toEqual({
      kind: 'unchanged',
      workspaceId: WS,
    });
    expect(cmux.writes()).toHaveLength(1);
  });

  test.each([
    [
      'a request read from a lagging export',
      {chainFails: 't-s is not in issues.jsonl'},
      't-s is not in issues.jsonl',
    ],
    ['the hook store', {hookStoreFails: 'no hook store'}, 'no hook store'],
    ['ps', {procsFail: 'ps failed'}, 'ps failed'],
  ])(
    'a failed read of %s leaves the old description, and says why',
    async (_what, reader, reason) => {
      const old = '🔳 What it said before';
      const cmux = fakeCmux({description: old});
      const outcome = await syncWorkspaceDescription({
        enabled: true,
        env: stateEnv(),
        readers: readers({...twoItems, ...reader}),
        run: cmux.run,
        session: session('t-s', 'Head'),
        workspaceId: WS,
      });
      expect(outcome).toMatchObject({kind: 'failed'});
      expect(outcome.kind === 'failed' ? outcome.reason : '').toContain(reason);
      expect(cmux.writes()).toEqual([]);
      expect(cmux.description.value).toBe(old);
    },
  );

  test('another session’s failed read leaves it too: a partial list would claim it is not there', async () => {
    const old = '🔳 What it said before';
    const cmux = fakeCmux({description: old, surfaces: [SURFACE, SURFACE_2]});
    const base = readers({
      ...twoItems,
      hookStore: {
        sessions: {[OTHER]: {pid: 7, sessionId: OTHER, surfaceId: SURFACE_2}},
      },
      procs: [proc(7)],
    });
    const outcome = await syncWorkspaceDescription({
      enabled: true,
      env: stateEnv(),
      readers: {
        ...base,
        session: () => ({kind: 'failed', reason: 'its bead could not be read'}),
      },
      run: cmux.run,
      session: session('t-s', 'Head', SURFACE, SESSION),
      workspaceId: WS,
    });
    expect(outcome).toMatchObject({kind: 'failed'});
    expect(cmux.description.value).toBe(old);
  });

  test('a failed write is a failure, and cmux keeps what it had', async () => {
    const old = '🔳 What it said before';
    const cmux = fakeCmux({description: old, failWrite: true});
    const outcome = await syncWorkspaceDescription({
      enabled: true,
      env: stateEnv(),
      readers: readers(twoItems),
      run: cmux.run,
      session: session('t-s', 'Head'),
      workspaceId: WS,
    });
    expect(outcome).toMatchObject({kind: 'failed'});
    expect(outcome.kind === 'failed' ? outcome.reason : '').toContain(
      'cmux said no',
    );
    expect(cmux.description.value).toBe(old);
  });

  test('a cmux that reports no description key is unreadable, never "none"', async () => {
    const cmux = fakeCmux({description: undefined});
    const outcome = await syncWorkspaceDescription({
      enabled: true,
      env: stateEnv(),
      readers: readers(twoItems),
      run: cmux.run,
      session: session('t-s', 'Head'),
      workspaceId: WS,
    });
    expect(outcome).toMatchObject({kind: 'failed'});
    expect(cmux.writes()).toEqual([]);
  });

  test('text the tool did not write is his, and is left alone', async () => {
    const his = 'This is workspace description.\nItem A\nItem B\nItem C';
    const cmux = fakeCmux({description: his});
    const outcome = await syncWorkspaceDescription({
      enabled: true,
      env: stateEnv(),
      readers: readers(twoItems),
      run: cmux.run,
      session: session('t-s', 'Head'),
      workspaceId: WS,
    });
    expect(outcome).toMatchObject({current: his, kind: 'leftAlone'});
    expect(cmux.writes()).toEqual([]);
    expect(cmux.description.value).toBe(his);
  });

  test('nothing to list: the tool’s old text is cleared; no description stays none', async () => {
    const cleared = fakeCmux({description: '🔳 Old item'});
    expect(
      await syncWorkspaceDescription({
        enabled: true,
        env: stateEnv(),
        readers: readers({}),
        run: cleared.run,
        session: session('t-s', 'Head'),
        workspaceId: WS,
      }),
    ).toMatchObject({kind: 'written', to: ''});
    expect(cleared.writes()[0]?.[2]).toBe('clear-description');
    expect(cleared.description.value).toBeNull();

    const none = fakeCmux();
    expect(
      await syncWorkspaceDescription({
        enabled: true,
        env: stateEnv(),
        readers: readers({}),
        run: none.run,
        session: session('t-s', 'Head'),
        workspaceId: WS,
      }),
    ).toMatchObject({kind: 'unchanged'});
    expect(none.writes()).toEqual([]);
  });

  test('a dry run writes nothing', async () => {
    const cmux = fakeCmux();
    const outcome = await syncWorkspaceDescription({
      dryRun: true,
      enabled: true,
      env: stateEnv(),
      readers: readers(twoItems),
      run: cmux.run,
      session: session('t-s', 'Head'),
      workspaceId: WS,
    });
    expect(outcome).toMatchObject({kind: 'wouldWrite'});
    expect(cmux.writes()).toEqual([]);
  });

  const twoSessions = {
    beads: {
      't-o': {
        labels: [`cmux-surface:${SURFACE_2}`],
        title: 'Fix the zshrc issue in the dotfiles repository, at last',
      },
      't-s': {labels: [`cmux-surface:${SURFACE}`], title: 'Head'},
    },
    bySession: {[OTHER]: 't-o', [SESSION]: 't-s'},
    hookStore: {
      sessions: {
        [OTHER]: {pid: 7, sessionId: OTHER, startedAt: 2, surfaceId: SURFACE_2},
        [SESSION]: {
          pid: 8,
          sessionId: SESSION,
          startedAt: 1,
          surfaceId: SURFACE,
        },
      },
    },
    procs: [proc(7), proc(8)],
    requests: {
      't-o': [
        issue('t-5', 'Fix the zshrc issue in the dotfiles repository, at last'),
        issue('t-6', 'XYZ item', {status: 'closed'}),
        issue('t-7', 'ABC item'),
      ],
      't-s': [issue('t-1', 'Head'), issue('t-2', 'Mine')],
    },
  };
  const blockForOther = [
    '💬💬💬 [Session] Fix the zshrc issue in the dotfiles rep…',
    '🔳 ABC item',
    '✅ XYZ item',
  ];

  test('another unlinked session gets its line and its own items', async () => {
    const cmux = fakeCmux({surfaces: [SURFACE, SURFACE_2]});
    const outcome = await syncWorkspaceDescription({
      enabled: true,
      env: stateEnv(),
      readers: readers(twoSessions),
      run: cmux.run,
      session: session('t-s', 'Head'),
      workspaceId: WS,
    });
    expect(outcome).toMatchObject({
      kind: 'written',
      to: ['📈 0/1 Completed', '🔳 Mine', ...blockForOther].join('\n'),
    });
  });

  test('the other session’s overarching short label titles its line', async () => {
    const cmux = fakeCmux({surfaces: [SURFACE, SURFACE_2]});
    const outcome = await syncWorkspaceDescription({
      enabled: true,
      env: stateEnv(),
      readers: readers({
        ...twoSessions,
        requests: {
          ...twoSessions.requests,
          't-o': [
            issue('t-5', 'Fix the zshrc issue', {
              labels: [
                'request',
                'overarching',
                'overarching-set:2026-10-30T10:00:05Z',
                'short:Fix_zshrc_issue',
              ],
            }),
          ],
        },
      }),
      run: cmux.run,
      session: session('t-s', 'Head'),
      workspaceId: WS,
    });
    expect(outcome).toMatchObject({
      to: '📈 0/1 Completed\n🔳 Mine\n💬💬💬 [Session] Fix zshrc issue',
    });
  });

  test('a live session with no bead shows as untitled, and a session of this chain is not listed', async () => {
    const chainMate = '0ae5c4ee-3333-4bbb-8ccc-0123456789ab';
    const stranger = '0ae5c4ee-4444-4bbb-8ccc-0123456789ab';
    const cmux = fakeCmux({surfaces: [SURFACE, SURFACE_2, SURFACE_ELSEWHERE]});
    const base = readers({
      ...twoSessions,
      bySession: {[SESSION]: 't-s', [chainMate]: 't-p'},
      hookStore: {
        sessions: {
          [chainMate]: {
            pid: 7,
            sessionId: chainMate,
            startedAt: 2,
            surfaceId: SURFACE_2,
          },
          [stranger]: {
            pid: 9,
            sessionId: stranger,
            startedAt: 3,
            surfaceId: SURFACE_ELSEWHERE,
          },
        },
      },
      procs: [proc(7), proc(9)],
    });
    const outcome = await syncWorkspaceDescription({
      enabled: true,
      env: stateEnv(),
      readers: {
        ...base,
        chain: {
          ...base.chain,
          chainBeads: (start) => ({
            beads:
              start.id === 't-s' || start.id === 't-p'
                ? [
                    {id: 't-p', labels: [], title: 'Pred'},
                    {id: 't-s', labels: [], title: 'Head'},
                  ]
                : [start],
            kind: 'read',
            selfIndex: 0,
          }),
        },
      },
      run: cmux.run,
      session: session('t-s', 'Head'),
      workspaceId: WS,
    });
    expect(outcome).toMatchObject({
      to: `📈 0/1 Completed\n🔳 Mine\n💬💬💬 [Session] ${NO_TITLE_YET}`,
    });
  });

  test('the namer’s items come first, so either session writes the same text', async () => {
    const env = stateEnv();
    // t-o named the workspace, and its surface is still here (sticky).
    appendWorkspaceName(
      {
        at: '2026-10-30T10:00:00.000Z',
        beadId: 't-o',
        hisName: null,
        nameSet: '[NAMED] Their head',
        replacedName: null,
        repo: 'named',
        sessionId: OTHER,
        setBy: null,
        surfaceId: SURFACE_2,
        toolPart: '[NAMED] Their head',
        workspaceId: WS,
      },
      env,
    );
    const shared = readers({
      ...twoSessions,
      beads: {
        't-o': {labels: [`cmux-surface:${SURFACE_2}`], title: 'Their head'},
        't-s': {labels: [`cmux-surface:${SURFACE}`], title: 'Head'},
      },
      requests: {
        't-o': [issue('t-5', 'Their head'), issue('t-6', 'Theirs')],
        't-s': [
          issue('t-1', 'Head', {
            labels: [
              'request',
              'overarching',
              'overarching-set:2026-10-30T10:00:05Z',
              'short:My_head',
            ],
          }),
          issue('t-2', 'Mine'),
        ],
      },
    });
    const fromSelf = fakeCmux({
      surfaces: [SURFACE, SURFACE_2],
      title: '[NAMED] Their head',
    });
    const asSelf = await syncWorkspaceDescription({
      enabled: true,
      env,
      readers: shared,
      run: fromSelf.run,
      session: session('t-s', 'Head'),
      workspaceId: WS,
    });
    const text =
      '📈 0/1 Completed\n🔳 Theirs\n💬💬💬 [Session] My head\n🔳 Mine';
    expect(asSelf).toMatchObject({to: text});

    const fromOwner = fakeCmux({
      surfaces: [SURFACE, SURFACE_2],
      title: '[NAMED] Their head',
    });
    const asOwner = await syncWorkspaceDescription({
      enabled: true,
      env,
      readers: shared,
      run: fromOwner.run,
      session: session('t-o', 'Their head', SURFACE_2, OTHER),
      workspaceId: WS,
    });
    expect(asOwner).toMatchObject({to: text});
  });

  test('an unreadable sticky owner leaves it', async () => {
    const env = stateEnv();
    appendWorkspaceName(
      {
        at: '2026-10-30T10:00:00.000Z',
        beadId: 't-gone',
        hisName: null,
        nameSet: '[NAMED] Head',
        replacedName: null,
        repo: 'named',
        sessionId: OTHER,
        setBy: null,
        surfaceId: SURFACE_2,
        toolPart: '[NAMED] Head',
        workspaceId: WS,
      },
      env,
    );
    const cmux = fakeCmux({surfaces: [SURFACE, SURFACE_2]});
    const outcome = await syncWorkspaceDescription({
      enabled: true,
      env,
      readers: readers(twoItems),
      run: cmux.run,
      session: session('t-s', 'Head'),
      workspaceId: WS,
    });
    expect(outcome).toMatchObject({kind: 'failed'});
    expect(cmux.writes()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The name
// ---------------------------------------------------------------------------

describe('the workspace name', () => {
  test('the knob is off by default', () => {
    needBr();
    const sb = createSandbox();
    sandboxes.push(sb);
    const config = resolveThreadConfig({
      cwd: sb.path,
      env: {XDG_CONFIG_HOME: join(sb.path, 'none')},
    });
    expect(config.workspaceDescription).toBe(false);
    expect(config.workspaceDescriptionSource).toBe('default');
  });

  test('knob off: "[TAG] <title>", however many requests or labels', async () => {
    needBr();
    const w = world({description: false});
    const cmux = fakeCmux();
    const names: (null | string)[] = [];
    const run: CmuxRunner = (args, limit) => {
      if (args[0] === 'rename-workspace') names.push(args[4] ?? null);
      if (args[0] === 'rename-tab') return Promise.resolve(ok('OK'));
      if (args[1] === 'workspace') {
        return Promise.resolve(
          ok(
            JSON.stringify({
              workspaces: [{custom_title: names.at(-1) ?? null, id: WS}],
            }),
          ),
        );
      }
      return cmux.run(args, limit);
    };
    await request(w, 'Refine the handoff command', {
      overarching: true,
      run,
      short: 'Refine handoff command',
    });
    await request(w, 'Improve notifications', {run, short: 'Improve notices'});
    await workspaceNameFollowUp({
      cwd: w.repo,
      env: w.env,
      run,
      sessionId: SESSION,
    });
    expect(names.at(-1)).toBe('[NAMED] Refine the handoff command');
    expect(cmux.writes()).toEqual([]);
  });

  test('knob off: the lookup is returned as it was', async () => {
    needBr();
    const w = world({description: false});
    const lookup = lookupWorkspaceSession({
      cwd: w.repo,
      env: w.env,
      session: SESSION,
    });
    expect(await withOverarchingShort(lookup, {cwd: w.repo, env: w.env})).toBe(
      lookup,
    );
  });

  test('knob on: the short label, else the title', async () => {
    needBr();
    const w = world({description: true});
    await request(w, 'Refine the handoff command', {overarching: true});
    const lookup = lookupWorkspaceSession({
      cwd: w.repo,
      env: w.env,
      session: SESSION,
    });
    const before = await withOverarchingShort(lookup, {
      cwd: w.repo,
      env: w.env,
    });
    expect(before).toMatchObject({
      session: {overarchingShort: {ok: true, value: null}},
    });
    const over = await request(w, null, {
      bead: filedId(
        await request(w, 'Refine the handoff command again', {
          overarching: true,
        }),
      ),
      short: 'Refine handoff command',
    });
    expect(over.kind).toBe('filed');
    const after = await withOverarchingShort(
      lookupWorkspaceSession({cwd: w.repo, env: w.env, session: SESSION}),
      {cwd: w.repo, env: w.env},
    );
    expect(after).toMatchObject({
      session: {
        overarchingShort: {ok: true, value: 'Refine handoff command'},
      },
    });
  });

  test('a chain that cannot be read names nothing, and says why', async () => {
    const cmux = fakeCmux({title: 'Kept'});
    const outcome = await syncWorkspaceName({
      enabled: true,
      env: {JUSTIN_THREADS_STATE_DIR: '/nonexistent/state'},
      run: cmux.run,
      session: {
        ...session('t-s', 'Head'),
        overarchingShort: {ok: false, reason: 'the export could not be read'},
      },
    });
    expect(outcome).toMatchObject({kind: 'failed'});
    expect(outcome.kind === 'failed' ? outcome.reason : '').toContain(
      'the export could not be read',
    );
    expect(cmux.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// What to mark
// ---------------------------------------------------------------------------

describe('What to mark asks for a short label', () => {
  const model = (requests: TreeIssue[]) =>
    ({
      beads: {
        problems: [],
        questions: [],
        requests: requests.map((entry) => ({
          children: [],
          questions: [],
          request: entry,
        })),
        session: issue('t-s', 'Head', {labels: ['session']}),
        sessionMissing: null,
      },
      git: {
        commits: {ok: true, value: {count: 0}},
        uncommitted: {ok: true, value: []},
      },
      log: {kind: 'read', lines: []},
    }) as unknown as SessionModel;
  const created = {
    ok: true,
    value: {found: [], missing: [], notCreatedThen: []},
  } as Parameters<typeof whatToMark>[2];
  const status = {kind: 'idle'} as unknown as SessionStatus;
  const shortItems = (items: MarkItem[]) =>
    items.filter((item) => item.kind === 'shortLabel');

  const requests = [
    issue('t-1', 'Open with no label'),
    issue('t-2', 'Open with a label', {labels: ['request', 'short:Has_label']}),
    issue('t-3', 'Closed with no label', {status: 'closed'}),
  ];

  test('knob on: only the open request with none', () => {
    const items = shortItems(
      whatToMark(model(requests), status, created, {shortLabels: true}),
    );
    expect(
      items.map((item) => item.kind === 'shortLabel' && item.request.id),
    ).toEqual(['t-1']);
    const view = markLine(items[0] as MarkItem);
    expect(view.code).toContain('thread request --bead t-1 --short');
    expect(view.text).toContain('Open with no label');
  });

  test('knob off: never', () => {
    expect(shortItems(whatToMark(model(requests), status, created))).toEqual(
      [],
    );
    expect(
      shortItems(
        whatToMark(model(requests), status, created, {shortLabels: false}),
      ),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The capture hook
// ---------------------------------------------------------------------------

describe('the capture hook', () => {
  /** A fake cmux that also serves the name sync's workspace list and renames. */
  function captureCmux(description: null | string): FakeCmux {
    const inner = fakeCmux({description});
    let title: null | string = null;
    const run: CmuxRunner = (args, limit) => {
      if (args[0] === 'rename-tab') {
        inner.calls.push([...args]);
        return Promise.resolve(ok('OK'));
      }
      if (args[0] === 'rename-workspace') {
        inner.calls.push([...args]);
        title = (args[4] ?? '').trimEnd();
        return Promise.resolve(ok('OK'));
      }
      if (args[1] === 'workspace' && args[2] === 'list') {
        return Promise.resolve(
          ok(JSON.stringify({workspaces: [{custom_title: title, id: WS}]})),
        );
      }
      return inner.run(args, limit);
    };
    return {...inner, run};
  }

  const hookReaders = (w: World): DescriptionReaders => ({
    ...readers({
      beads: {[w.sessionBeadId]: {title: 'Head'}},
      bySession: {[SESSION]: w.sessionBeadId},
      procs: [],
    }),
    chain: {
      chainBeads: (start) => ({beads: [start], kind: 'read', selfIndex: 0}),
      requestsOf: () => ({
        kind: 'read',
        requests: [
          issue('t-2', 'Mine', {labels: ['request', 'short:My_item']}),
        ],
      }),
    },
  });

  test('knob off: no description is written, and the record has no key', async () => {
    needBr();
    const w = world({description: false});
    const cmux = captureCmux(null);
    await request(w, 'Refine the handoff command', {run: cmux.run});
    const outcome = await applyCapture({
      autoCommit: false,
      cmux: cmux.run,
      cwd: w.repo,
      descriptionReaders: hookReaders(w),
      env: w.env,
      nameWorkspaces: true,
      sessionBeads: true,
      sessionId: SESSION,
    });
    expect(outcome.kind).toBe('ran');
    expect(
      outcome.kind === 'ran' ? outcome.workspaceDescription : 'not ran',
    ).toBeUndefined();
    expect(cmux.writes()).toEqual([]);
    expect(cmux.description.value).toBeNull();
    const record = captureRunRecord(SESSION, outcome, 1, new Date());
    expect(record).not.toHaveProperty('workspaceDescription');
  });

  test('knob on: it writes, and records the outcome under its own key', async () => {
    needBr();
    const w = world({description: true});
    const cmux = captureCmux(null);
    await request(w, 'Refine the handoff command', {run: cmux.run});
    const outcome = await applyCapture({
      autoCommit: false,
      cmux: cmux.run,
      cwd: w.repo,
      descriptionReaders: hookReaders(w),
      env: w.env,
      nameWorkspaces: true,
      sessionBeads: true,
      sessionId: SESSION,
    });
    expect(cmux.description.value).toBe('📈 0/1 Completed\n🔳 My item');
    const record = captureRunRecord(SESSION, outcome, 1, new Date());
    expect(record).toMatchObject({
      workspaceDescription: {kind: 'written'},
    });
  });

  test('knob on: a failed read is recorded, the capture still runs, and the old text stays', async () => {
    needBr();
    const w = world({description: true});
    const old = '🔳 What it said before';
    const cmux = captureCmux(old);
    await request(w, 'Refine the handoff command', {run: cmux.run});
    const reader = hookReaders(w);
    const outcome = await applyCapture({
      autoCommit: false,
      cmux: cmux.run,
      cwd: w.repo,
      descriptionReaders: {
        ...reader,
        chain: {
          ...reader.chain,
          requestsOf: () => ({
            kind: 'failed',
            reason: 't-s is not in issues.jsonl',
          }),
        },
      },
      env: w.env,
      nameWorkspaces: true,
      sessionBeads: true,
      sessionId: SESSION,
    });
    expect(outcome.kind).toBe('ran');
    expect(cmux.description.value).toBe(old);
    expect(cmux.writes()).toEqual([]);
    const record = captureRunRecord(SESSION, outcome, 1, new Date());
    expect(record).toMatchObject({workspaceDescription: {kind: 'failed'}});
    expect(JSON.stringify(record)).toContain('is not in issues.jsonl');
  });

  test('a thrown read is a recorded failure, never a lost capture', async () => {
    needBr();
    const w = world({description: true});
    const cmux = captureCmux(null);
    await request(w, 'Refine the handoff command', {run: cmux.run});
    const outcome = await applyCapture({
      autoCommit: false,
      cmux: cmux.run,
      cwd: w.repo,
      descriptionReaders: {
        ...hookReaders(w),
        hookStore: () => {
          throw new Error('kaboom');
        },
      },
      env: w.env,
      nameWorkspaces: true,
      sessionBeads: true,
      sessionId: SESSION,
    });
    expect(outcome.kind).toBe('ran');
    const record = captureRunRecord(SESSION, outcome, 1, new Date());
    expect(record).toMatchObject({workspaceDescription: {kind: 'failed'}});
    expect(JSON.stringify(record)).toContain('kaboom');
  });

  test('syncDescriptionForCapture: outside cmux and a name not ready do nothing', async () => {
    needBr();
    const w = world({description: true});
    const lookup = lookupWorkspaceSession({
      cwd: w.repo,
      env: w.env,
      session: SESSION,
    });
    const cmux = fakeCmux();
    expect(
      await syncDescriptionForCapture({
        cwd: w.repo,
        env: w.env,
        lookup,
        nameOutcome: {kind: 'outsideCmux'},
        run: cmux.run,
      }),
    ).toEqual({kind: 'outsideCmux'});
    expect(
      await syncDescriptionForCapture({
        cwd: w.repo,
        env: w.env,
        lookup,
        nameOutcome: {kind: 'notReady', reason: 'no title yet'},
        run: cmux.run,
      }),
    ).toEqual({kind: 'notReady', reason: 'no title yet'});
    expect(
      await syncDescriptionForCapture({
        cwd: w.repo,
        env: w.env,
        lookup,
        nameOutcome: {kind: 'failed', reason: 'tree read', workspaceId: null},
        run: cmux.run,
      }),
    ).toMatchObject({kind: 'failed'});
    expect(cmux.calls).toEqual([]);
  });
});
