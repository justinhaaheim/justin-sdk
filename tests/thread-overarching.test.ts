/**
 * The overarching request (home-base-jm5kg.5 D1–D4) and the workspace-name
 * items trial (home-base-jm5kg.6 D5). Real br in throwaway repos; every
 * state file under a temp JUSTIN_THREADS_STATE_DIR; cmux is a fake.
 */

import type {CmuxCall, CmuxRunner} from '../src/thread/cmux';
import type {SessionModel} from '../src/thread/session-model';
import type {MarkItem, SessionStatus} from '../src/thread/session-status';
import type {TreeIssue} from '../src/thread/session-tree';
import type {WorkspaceSession} from '../src/thread/workspace-name';
import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, test} from 'bun:test';
import {mkdirSync, writeFileSync} from 'fs';
import {join} from 'path';

import {brList, brShow, brUpdate, runBr} from '../src/beads/br';
import {resolveThreadConfig} from '../src/thread/config';
import {
  chainRequestList,
  nameItemsOf,
  OVERARCHING_LABEL,
  OVERARCHING_SET_LABEL_PREFIX,
  readChainRequests,
  realChainRequestReaders,
} from '../src/thread/overarching';
import {
  describeRequestOutcome,
  describeTitleOutcome,
  fileRequest,
  renameSession,
} from '../src/thread/request';
import {ensureSessionBead} from '../src/thread/session-bead';
import {
  itemsDisplayName,
  WORKSPACE_ITEMS_NAME_LIMIT,
} from '../src/thread/session-name';
import {markLine} from '../src/thread/session-report';
import {whatToMark} from '../src/thread/session-status';
import {syncWorkspaceName} from '../src/thread/workspace-name';
import {
  lookupWorkspaceSession,
  withNameItems,
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
const OLD_SESSION = '0ae5c4ee-1111-4bbb-8ccc-0123456789ab';
const OTHER_SESSION = '0ae5c4ee-2222-4bbb-8ccc-0123456789ab';
const WS = 'AAAAAAAA-0000-4000-8000-00000000000A';
const SURFACE = '5F5F5F5F-0000-4000-8000-000000000001';
const SURFACE_2 = '5F5F5F5F-0000-4000-8000-000000000002';

interface World {
  db: string;
  env: Record<string, string | undefined>;
  repo: string;
  sessionBeadId: string;
}

function world(knobs: {items?: boolean; titleSummary?: boolean} = {}): World {
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
          titleSummary: knobs.titleSummary ?? true,
          workspaceNameItems: knobs.items ?? false,
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

/** Another session bead in the same DB (a predecessor, or a second tab). */
function otherSession(
  w: World,
  sessionId: string,
  surface: string | null,
): string {
  const env = {...w.env, CMUX_SURFACE_ID: surface ?? undefined};
  const filed = ensureSessionBead({
    cwd: w.repo,
    env,
    firstPrompt: {at: '2026-10-30T08:00:00.000Z', text: 'Earlier work'},
    now: new Date('2026-10-30T08:00:01.000Z'),
    sessionId,
  });
  if (filed.kind !== 'created') throw new Error(filed.kind);
  return filed.beadId;
}

function noCmux(): CmuxRunner {
  return () => Promise.resolve({kind: 'failed', reason: 'no cmux'});
}

async function request(
  w: World,
  title: string | null,
  extra: {
    bead?: string;
    continues?: string;
    overarching?: boolean;
    run?: CmuxRunner;
    sessionId?: string;
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
    sessionId: extra.sessionId ?? null,
    title,
  });
}

function filedId(outcome: Awaited<ReturnType<typeof fileRequest>>): string {
  if (outcome.kind !== 'filed') throw new Error(JSON.stringify(outcome));
  return outcome.id;
}

function bead(w: World, id: string) {
  const shown = brShow({db: w.db, env: {}}, id);
  if (shown.kind !== 'ok') throw new Error(`br show ${id}: ${shown.kind}`);
  return shown.issue;
}

function marks(labels: readonly string[]): string[] {
  return labels.filter(
    (label) =>
      label === OVERARCHING_LABEL ||
      label.startsWith(OVERARCHING_SET_LABEL_PREFIX),
  );
}

/** Wait until the clock is past a request's overarching-set time. */
async function pastSet(w: World, id: string): Promise<void> {
  const label = bead(w, id).labels.find((entry) =>
    entry.startsWith(OVERARCHING_SET_LABEL_PREFIX),
  );
  if (label == null) throw new Error('no overarching-set label');
  const at = Date.parse(label.slice(OVERARCHING_SET_LABEL_PREFIX.length));
  while (Date.now() <= at + 20) await Bun.sleep(50);
}

// ---------------------------------------------------------------------------
// A fake cmux: one window; renames change the spaces
// ---------------------------------------------------------------------------

interface FakeSpace {
  id: string;
  surfaces: string[];
  title: string | null;
}

const ok = (stdout: string): CmuxCall => ({kind: 'ok', stdout});

function fakeCmux(spaces: FakeSpace[]): {
  calls: string[][];
  run: CmuxRunner;
  spaces: FakeSpace[];
} {
  const calls: string[][] = [];
  const run: CmuxRunner = (args) => {
    calls.push([...args]);
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
    if (args[0] === 'rename-tab') return Promise.resolve(ok('OK'));
    return Promise.resolve({
      kind: 'failed',
      reason: `unexpected: ${args.join(' ')}`,
    });
  };
  return {calls, run, spaces};
}

// ---------------------------------------------------------------------------
// D1: one overarching request per chain
// ---------------------------------------------------------------------------

describe('D1: --overarching marks one request per chain', () => {
  test('a new request: marked, timed, and the session takes its title', async () => {
    needBr();
    const w = world();
    const outcome = await request(w, 'Handoff command refinements', {
      overarching: true,
    });
    const id = filedId(outcome);
    expect(outcome).toMatchObject({
      followUpFailures: [],
      overarching: {id, unmarked: []},
    });
    const labels = marks(bead(w, id).labels);
    expect(labels).toHaveLength(2);
    expect(labels).toContain(OVERARCHING_LABEL);
    const session = bead(w, w.sessionBeadId);
    expect(session.title).toBe('Handoff command refinements');
    expect(session.labels).not.toContain('auto-title');
    const {exitCode, lines} = describeRequestOutcome(outcome);
    expect(exitCode).toBe(0);
    expect(lines.join('\n')).toContain('marked overarching');
  });

  test('a second --overarching unmarks the first; --bead marks an existing one back', async () => {
    needBr();
    const w = world();
    const first = filedId(
      await request(w, 'Answer a simple question', {overarching: true}),
    );
    const second = await request(w, 'Refactor the handoff tool', {
      overarching: true,
    });
    const secondId = filedId(second);
    expect(second).toMatchObject({overarching: {unmarked: [first]}});
    expect(marks(bead(w, first).labels)).toEqual([]);
    expect(marks(bead(w, secondId).labels)).toHaveLength(2);
    expect(bead(w, w.sessionBeadId).title).toBe('Refactor the handoff tool');

    const back = await request(w, null, {bead: first, overarching: true});
    expect(back).toMatchObject({
      followUpFailures: [],
      mode: 'adopted',
      overarching: {id: first, unmarked: [secondId]},
    });
    expect(marks(bead(w, secondId).labels)).toEqual([]);
    expect(bead(w, w.sessionBeadId).title).toBe('Answer a simple question');
  });

  test('a plain request never marks or unmarks anything', async () => {
    needBr();
    const w = world();
    const first = filedId(
      await request(w, 'The overall work', {overarching: true}),
    );
    const plain = await request(w, 'One more thing');
    expect(plain).toMatchObject({overarching: null});
    expect(marks(bead(w, first).labels)).toHaveLength(2);
    expect(bead(w, w.sessionBeadId).title).toBe('The overall work');
  });

  test('--overarching with only --continues is a usage error', async () => {
    needBr();
    const w = world();
    const outcome = await request(w, null, {
      continues: 't-zzz',
      overarching: true,
    });
    expect(outcome.kind).toBe('usage');
    expect(describeRequestOutcome(outcome).exitCode).toBe(2);
  });

  test('a successor shares its predecessor’s overarching request, and a new mark unmarks it', async () => {
    needBr();
    const w = world();
    const oldBead = otherSession(w, OLD_SESSION, null);
    const oldOver = filedId(
      await request(w, 'Handoff command refinements', {
        overarching: true,
        sessionId: OLD_SESSION,
      }),
    );
    // The successor links (link only): it inherits the title, copies nothing.
    const linked = await request(w, null, {continues: oldBead});
    expect(linked.kind).toBe('linked');
    expect(bead(w, w.sessionBeadId).title).toBe('Handoff command refinements');

    const session = bead(w, w.sessionBeadId);
    const chain = readChainRequests(
      {id: session.id, labels: session.labels, title: session.title},
      realChainRequestReaders({cwd: w.repo, env: w.env}),
    );
    expect(chain.kind).toBe('read');
    if (chain.kind !== 'read') return;
    expect(chain.sessions.map((entry) => entry.bead.id)).toEqual([
      oldBead,
      w.sessionBeadId,
    ]);
    const shared = chainRequestList(chain).filter((issue) =>
      issue.labels.includes(OVERARCHING_LABEL),
    );
    expect(shared.map((issue) => issue.id)).toEqual([oldOver]);

    const reframed = await request(w, 'Make handoffs trustworthy end to end', {
      overarching: true,
    });
    expect(reframed).toMatchObject({
      followUpFailures: [],
      overarching: {unmarked: [oldOver]},
    });
    expect(marks(bead(w, oldOver).labels)).toEqual([]);
    expect(bead(w, w.sessionBeadId).title).toBe(
      'Make handoffs trustworthy end to end',
    );
  });
});

// ---------------------------------------------------------------------------
// D2: the session title IS the overarching request's title
// ---------------------------------------------------------------------------

describe('D2: the session title follows the overarching request', () => {
  test('thread title retitles the overarching request too, and refreshes its time', async () => {
    needBr();
    const w = world();
    const id = filedId(
      await request(w, 'Handoff command refinements', {overarching: true}),
    );
    const before = marks(bead(w, id).labels).find((label) =>
      label.startsWith(OVERARCHING_SET_LABEL_PREFIX),
    );
    await pastSet(w, id);
    const outcome = await renameSession({
      cmux: noCmux(),
      cwd: w.repo,
      env: w.env,
      sessionId: null,
      title: 'Handoff command refinements and the spend quota',
    });
    expect(outcome).toMatchObject({
      kind: 'renamed',
      overarching: {id, kind: 'retitled'},
    });
    expect(describeTitleOutcome(outcome).exitCode).toBe(0);
    const over = bead(w, id);
    expect(over.title).toBe('Handoff command refinements and the spend quota');
    const after = marks(over.labels).find((label) =>
      label.startsWith(OVERARCHING_SET_LABEL_PREFIX),
    );
    expect(after).not.toBe(before);
    expect(bead(w, w.sessionBeadId).title).toBe(
      'Handoff command refinements and the spend quota',
    );
  });

  test('thread title with no overarching request renames the session only', async () => {
    needBr();
    const w = world();
    const id = filedId(await request(w, 'Just one request'));
    const outcome = await renameSession({
      cmux: noCmux(),
      cwd: w.repo,
      env: w.env,
      sessionId: null,
      title: 'A better name',
    });
    expect(outcome).toMatchObject({
      kind: 'renamed',
      overarching: {kind: 'none'},
    });
    expect(bead(w, id).title).toBe('Just one request');
  });

  test('the workspace is renamed after the overarching title', async () => {
    needBr();
    const w = world();
    const cmux = fakeCmux([{id: WS, surfaces: [SURFACE], title: null}]);
    await request(w, 'Handoff command refinements', {
      overarching: true,
      run: cmux.run,
    });
    expect(cmux.spaces[0]?.title).toBe('[NAMED] Handoff command refinements');
  });
});

// ---------------------------------------------------------------------------
// D3: thread status asks whether it still describes the whole of the work
// ---------------------------------------------------------------------------

const WORKING: SessionStatus = {
  helpers: 0,
  kind: 'working',
  lastRecordAt: '2026-10-30T00:00:00.000Z',
};
const NO_CREATED = {
  ok: true as const,
  value: {found: [], missing: [], notCreatedThen: []},
};

function treeIssue(w: World, issue: ReturnType<typeof bead>): TreeIssue {
  return {...issue, beadsDir: join(w.repo, '.beads'), parentIds: []};
}

/** What to mark for the world's session, with the chain read for real. */
function overarchingMarks(w: World): MarkItem[] {
  const all = brList(
    {db: w.db, env: {}},
    {all: true, labels: [`sid:${SESSION}`]},
  );
  if (all.kind !== 'ok') throw new Error('br list failed');
  const session = treeIssue(w, bead(w, w.sessionBeadId));
  const requests = all.issues
    .filter((issue) => issue.labels.includes('request'))
    .map((issue) => ({
      children: [],
      questions: [],
      request: treeIssue(w, issue),
    }));
  const model = {
    beads: {problems: [], questions: [], requests, session},
    git: {
      commits: {ok: false, reason: 'not read here'},
      uncommitted: {ok: false, reason: 'not read here'},
    },
    log: {kind: 'missing'},
  } as unknown as SessionModel;
  const chain = readChainRequests(
    {id: session.id, labels: session.labels, title: session.title},
    realChainRequestReaders({cwd: w.repo, env: w.env}),
  );
  const overarching =
    chain.kind === 'read'
      ? {
          ok: true as const,
          value: {
            chained: chain.sessions.length > 1,
            requests: chainRequestList(chain),
          },
        }
      : {ok: false as const, reason: chain.reason};
  return whatToMark(model, WORKING, NO_CREATED, {
    overarching,
    titleSummary: true,
  }).filter(
    (mark) => mark.kind === 'overarching' || mark.kind === 'titleSummary',
  );
}

describe('D3: the refresh prompt', () => {
  test('a request filed after the overarching one was set: asked, listing it; confirmed: not asked', async () => {
    needBr();
    const w = world();
    const over = filedId(
      await request(w, 'Answer a simple question', {overarching: true}),
    );
    await pastSet(w, over);
    await request(w, 'Refactor the handoff tool');
    const asked = overarchingMarks(w);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({kind: 'overarching', why: 'filedSince'});
    const item = asked[0] as Extract<MarkItem, {kind: 'overarching'}>;
    expect(item.since.map((issue) => issue.title)).toEqual([
      'Refactor the handoff tool',
    ]);
    const view = markLine(item);
    expect(view.text).toContain('"Refactor the handoff tool"');
    const commands = view.sub
      .flat()
      .flatMap((piece) =>
        typeof piece === 'object' && 'code' in piece ? [piece.code] : [],
      );
    expect(commands.join('\n')).toContain(
      `thread request --overarching --bead ${over}`,
    );
    expect(commands.join('\n')).toContain('thread title');
    expect(commands.join('\n')).toContain('thread request --overarching "…"');

    // Confirming it records the check, and the prompt goes away.
    await request(w, null, {bead: over, overarching: true});
    expect(overarchingMarks(w)).toEqual([]);
  });

  test('two requests and none marked: asked to mark one (instead of the summary prompt)', async () => {
    needBr();
    const w = world();
    await request(w, 'Answer a simple question');
    await request(w, 'Refactor the handoff tool');
    const asked = overarchingMarks(w);
    expect(asked).toMatchObject([{kind: 'overarching', why: 'none'}]);
    const [first] = asked;
    if (first == null) throw new Error('nothing asked');
    expect(markLine(first).text).toContain('2 requests');
  });

  test('one request and none marked: the old summary path, unchanged', async () => {
    needBr();
    const w = world();
    await request(w, 'Answer a simple question');
    expect(
      overarchingMarks(w).filter((mark) => mark.kind === 'overarching'),
    ).toEqual([]);
  });

  test('the session title edited apart from the request: asked to set it again', async () => {
    needBr();
    const w = world();
    const over = filedId(
      await request(w, 'Handoff command refinements', {overarching: true}),
    );
    const edited = brUpdate({db: w.db, env: {}}, over, {
      title: 'Handoff command refinements, renamed by hand',
    });
    expect(edited.kind).toBe('ok');
    expect(overarchingMarks(w)).toMatchObject([
      {kind: 'overarching', why: 'titleDiffers'},
    ]);
  });
});

// ---------------------------------------------------------------------------
// D4: two unlinked Claude tabs in one workspace
// ---------------------------------------------------------------------------

describe('D4: two unlinked sessions in one workspace (sticky owner)', () => {
  test('the first to name it keeps the workspace; each session keeps its own title', async () => {
    needBr();
    const w = world();
    const cmux = fakeCmux([
      {id: WS, surfaces: [SURFACE, SURFACE_2], title: null},
    ]);
    await request(w, 'Handoff command refinements', {
      overarching: true,
      run: cmux.run,
    });
    expect(cmux.spaces[0]?.title).toBe('[NAMED] Handoff command refinements');

    otherSession(w, OTHER_SESSION, SURFACE_2);
    const second = await request(w, 'Plan the garden', {
      overarching: true,
      run: cmux.run,
      sessionId: OTHER_SESSION,
    });
    expect(second).toMatchObject({followUpFailures: []});
    // The workspace stays with its first namer; the second session's own
    // title (its inbox entry, a successor tab) is its own overarching title.
    expect(cmux.spaces[0]?.title).toBe('[NAMED] Handoff command refinements');
    const lookup = lookupWorkspaceSession({
      cwd: w.repo,
      env: w.env,
      session: OTHER_SESSION,
    });
    expect(lookup).toMatchObject({session: {title: 'Plan the garden'}});
  });
});

// ---------------------------------------------------------------------------
// D5: the workspace name lists the requests (trial, behind a knob)
// ---------------------------------------------------------------------------

function fixture(
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

const JUSTIN_EXAMPLE =
  '[HOME] Handoff command refinements ✅ Spend quota blocks runaway usage 🔳 Improve cmux workspace naming 🔳 Improve notifications';

describe('D5: the items trial', () => {
  test('Justin’s example, exactly: done before open, the overarching request is the head', () => {
    const requests = [
      fixture('t-1', 'Improve cmux workspace naming'),
      fixture('t-2', 'Handoff command refinements', {
        labels: [
          'request',
          OVERARCHING_LABEL,
          'overarching-set:2026-10-30T10:00:05Z',
        ],
      }),
      fixture('t-3', 'Improve notifications'),
      fixture('t-4', 'Spend quota blocks runaway usage', {status: 'closed'}),
    ];
    const items = nameItemsOf({
      headTitle: 'Handoff command refinements',
      requests,
    });
    expect(itemsDisplayName('HOME', 'Handoff command refinements', items)).toBe(
      JUSTIN_EXAMPLE,
    );
  });

  test('oldest first within each; "not needed" and the head title are left out', () => {
    const items = nameItemsOf({
      headTitle: 'First request',
      requests: [
        fixture('t-1', 'First request'),
        fixture('t-2', 'Open, older'),
        fixture('t-3', 'Done, older', {status: 'closed'}),
        fixture('t-4', 'A placeholder', {
          closeReason: 'not needed: the PDF export runs its own query',
          status: 'closed',
        }),
        fixture('t-5', 'Open, newer'),
        fixture('t-6', 'Done, newer', {status: 'closed'}),
      ],
    });
    expect(items).toEqual([
      {done: true, title: 'Done, older'},
      {done: true, title: 'Done, newer'},
      {done: false, title: 'Open, older'},
      {done: false, title: 'Open, newer'},
    ]);
  });

  test('cut at the limit with "…", never inside an emoji', () => {
    const items = Array.from({length: 12}, (_, n) => ({
      done: false,
      title: `Open request number ${n}`,
    }));
    const name = itemsDisplayName('HOME', 'Head', items);
    expect(Array.from(name)).toHaveLength(WORKSPACE_ITEMS_NAME_LIMIT);
    expect(name.endsWith('…')).toBe(true);
    expect(name).not.toMatch(/[\uD800-\uDBFF]…$/u);
  });

  test('the knob is off by default', () => {
    needBr();
    const sb = createSandbox();
    sandboxes.push(sb);
    const config = resolveThreadConfig({
      cwd: sb.path,
      env: {XDG_CONFIG_HOME: join(sb.path, 'none')},
    });
    expect(config.workspaceNameItems).toBe(false);
    expect(config.workspaceNameItemsSource).toBe('default');
  });

  test('knob off: the plain name; knob on: the items name, from the real chain', async () => {
    needBr();
    const off = world({items: false});
    const offCmux = fakeCmux([{id: WS, surfaces: [SURFACE], title: null}]);
    await request(off, 'Handoff command refinements', {
      overarching: true,
      run: offCmux.run,
    });
    await request(off, 'Improve notifications', {run: offCmux.run});
    await workspaceNameFollowUp({
      cwd: off.repo,
      env: off.env,
      run: offCmux.run,
      sessionId: SESSION,
    });
    expect(offCmux.spaces[0]?.title).toBe(
      '[NAMED] Handoff command refinements',
    );

    const on = world({items: true});
    const onCmux = fakeCmux([{id: WS, surfaces: [SURFACE], title: null}]);
    await request(on, 'Handoff command refinements', {
      overarching: true,
      run: onCmux.run,
    });
    const quota = filedId(
      await request(on, 'Spend quota blocks runaway usage', {run: onCmux.run}),
    );
    await request(on, 'Improve notifications', {run: onCmux.run});
    expect(onCmux.spaces[0]?.title).toBe(
      '[NAMED] Handoff command refinements 🔳 Spend quota blocks runaway usage 🔳 Improve notifications',
    );
    const closed = runBr(on.repo, ['close', quota, '--reason', 'built']);
    expect(closed.ok).toBe(true);
    await workspaceNameFollowUp({
      cwd: on.repo,
      env: on.env,
      run: onCmux.run,
      sessionId: SESSION,
    });
    expect(onCmux.spaces[0]?.title).toBe(
      '[NAMED] Handoff command refinements ✅ Spend quota blocks runaway usage 🔳 Improve notifications',
    );
  });

  test('requests that cannot be read: nothing is renamed, and it says why', async () => {
    const session: WorkspaceSession = {
      beadId: 't-s',
      labels: [`cmux-surface:${SURFACE}`],
      nameItems: {ok: false, reason: 'the export could not be read'},
      repo: 'named',
      repoTag: 'NAMED',
      sessionId: SESSION,
      title: 'Handoff command refinements',
    };
    const cmux = fakeCmux([{id: WS, surfaces: [SURFACE], title: 'Kept'}]);
    const outcome = await syncWorkspaceName({
      enabled: true,
      env: {JUSTIN_THREADS_STATE_DIR: '/nonexistent/state'},
      run: cmux.run,
      session,
    });
    expect(outcome).toMatchObject({kind: 'failed'});
    expect(outcome.kind === 'failed' ? outcome.reason : '').toContain(
      'the export could not be read',
    );
    expect(cmux.calls).toEqual([]);
    expect(cmux.spaces[0]?.title).toBe('Kept');
  });

  test('withNameItems leaves the lookup alone with the knob off', async () => {
    needBr();
    const w = world({items: false});
    const lookup = lookupWorkspaceSession({
      cwd: w.repo,
      env: w.env,
      session: SESSION,
    });
    const named = await withNameItems(lookup, {cwd: w.repo, env: w.env});
    expect(named).toBe(lookup);
  });
});
