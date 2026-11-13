/**
 * `thread sessions <project>` (alias `thread latest`), home-base-c82t4.1: the
 * project resolver (home-base-c82t4 D2) and the listing (D1). Every fixture is
 * invented.
 *
 * NEGATIVE CONTROLS: each new behaviour was broken once on purpose, the test
 * named for it failed on its own assertion, and it passed again once restored.
 * The dispatch report of home-base-c82t4.1 lists each control.
 */

import type {PaneLookup} from '../src/thread/pane-join';
import type {KnownProject, KnownProjects} from '../src/thread/projects';
import type {InboxRead, InboxRow} from '../src/thread/session-inbox';
import type {SessionModel} from '../src/thread/session-model';
import type {SessionStatus} from '../src/thread/session-status';
import type {UntrackedSession} from '../src/thread/session-untracked';

import {afterEach, describe, expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {PLAIN_STYLE} from '../src/cli-style';
import {
  knownProjects,
  listDevRootRepos,
  resolutionErrorText,
  resolveProjects,
} from '../src/thread/projects';
import {shapeRows} from '../src/thread/session-inbox';
import {measured, unmeasured} from '../src/thread/session-model';
import {
  NO_REQUEST_RECORDED,
  untrackedCard,
  untrackedVerdict,
} from '../src/thread/session-untracked';
import {
  buildSessionList,
  classifyUntrackedFailure,
  listRow,
  renderSessionList,
  runThreadSessions,
  sessionListExit,
  sessionListJson,
  sessionsStyle,
} from '../src/thread/sessions-list';
import {projectDirSlug} from '../src/thread/transcript-messages';
import {captureWriteStdout} from './capture-stdout';

const NOW = new Date('2030-01-20T12:00:00.000Z');
const NO_PANES: PaneLookup = {ok: false, reason: 'not looked up in this test'};
const day = (d: number, hour = 9): string =>
  `2030-01-${String(d).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`;

const GARDEN: KnownProject = {folder: 'garden-tools', tag: 'GARDEN'};
const KNOWN: KnownProject[] = [
  {folder: 'alpha', tag: 'ALPHA'},
  GARDEN,
  {folder: 'zeta-notes', tag: 'ZETA'},
];

// ---------------------------------------------------------------------------
// Fixtures: invented sessions
// ---------------------------------------------------------------------------

function untracked(
  n: number,
  over: Partial<UntrackedSession> = {},
): UntrackedSession {
  return {
    checkout: '/dev/garden-tools',
    contextTokens: measured(40_000),
    dirt: null,
    firstMessage: `Sort the seed packets by season, batch ${n}`,
    firstMessageAt: day(n),
    git: {
      aheadOfDefault: measured(0),
      branch: measured('main'),
      defaultBranch: measured('main'),
      localDefaultBehind: measured(null),
      merged: measured('isDefault'),
      uncommitted: measured([]),
      unpushed: measured({count: 0, kind: 'counted', upstream: 'origin/main'}),
    },
    helpers: measured([]),
    lastActivityAt: measured(day(n)),
    lastMessage: null,
    lastReply: 'Sorted.',
    messagesFrom: 'messageLog',
    oldReport: measured(null),
    repo: 'garden-tools',
    repoResolvedBy: 'git',
    repoRoot: '/dev/garden-tools',
    repoTag: 'GARDEN',
    resume: `cd '/dev/garden-tools' && claude --resume u-${n}`,
    scannedLastAt: day(n),
    sessionId: `u-${n}`,
    testDataMarker: false,
    transcriptPath: `/projects/-dev-garden-tools/u-${n}.jsonl`,
    wrapUpAt: 150_000,
    ...over,
  };
}

function untrackedRow(s: UntrackedSession): InboxRow {
  const verdict = untrackedVerdict(s, NOW);
  const card = untrackedCard(s, verdict, NOW, NO_PANES);
  return {
    card,
    display: verdict.display,
    git: null,
    handoff: null,
    inputDraft: null,
    lastActivityAt: s.lastActivityAt.ok ? s.lastActivityAt.value : null,
    lastAssistantAt: null,
    loaded: null,
    repeats: null,
    repo: s.repo,
    section: 'notTracked',
    sessionBeadId: null,
    sessionId: s.sessionId,
    startedAt: s.firstMessageAt,
    title: card.title,
    tracked: false,
    unread: null,
    unreadable: null,
    untracked: {session: s, verdict},
  };
}

/**
 * A tracked, loaded session: only the card and the fields the listing reads.
 * Its transcript is filed under its checkout's slug unless `transcriptPath`
 * says otherwise (null = unknown); `logCwds` are its message log's cwds,
 * oldest first (none = no log).
 */
function trackedRow(input: {
  at: string | null;
  checkout: string | null;
  emoji: string;
  id: string;
  logCwds?: (string | null)[];
  marks?: InboxRow['card']['marks'];
  status: SessionStatus;
  statusText: string;
  title: string;
  transcriptPath?: string | null;
}): InboxRow {
  const transcriptPath =
    input.transcriptPath !== undefined
      ? input.transcriptPath
      : input.checkout == null
        ? null
        : `/projects/${projectDirSlug(input.checkout)}/${input.id}.jsonl`;
  const log =
    input.logCwds == null
      ? {kind: 'missing', path: `/m/${input.id}.jsonl`}
      : {
          failures: [],
          kind: 'read',
          lines: input.logCwds.map((cwd, n) => ({
            at: day(n + 1),
            cwd,
            event: 'UserPromptSubmit',
            role: 'user',
            text: 'invented',
          })),
          path: `/m/${input.id}.jsonl`,
        };
  const model = {
    git: {checkout: input.checkout},
    log,
    transcript: {path: transcriptPath},
  } as unknown as SessionModel;
  return {
    card: {
      action: {command: null, rule: 1, text: 'Answer it'},
      age: null,
      emoji: input.emoji,
      facts: [],
      marks: input.marks ?? {handoff: null, mayor: false},
      optional: null,
      pane: null,
      paneFact: {kind: 'unknown', reason: 'not looked up', recorded: null},
      repo: 'garden-tools',
      repoTag: 'GARDEN',
      resume: `claude --resume ${input.id}`,
      section: 'needsYou',
      sectionEmoji: '🛑',
      sectionTitle: 'Needs you',
      status: input.statusText,
      title: input.title,
      unsent: null,
      youAsked: {firstMessage: null, kind: 'noRequest'},
    },
    display: 'card',
    git: null,
    handoff: null,
    inputDraft: null,
    lastActivityAt: input.at,
    lastAssistantAt: null,
    loaded: {
      counts: {} as NonNullable<InboxRow['loaded']>['counts'],
      model,
      status: input.status,
    },
    repeats: null,
    repo: 'garden-tools',
    section: 'needsYou',
    sessionBeadId: `bead-${input.id}`,
    sessionId: input.id,
    startedAt: null,
    title: input.title,
    tracked: true,
    unread: null,
    unreadable: null,
    untracked: null,
  };
}

/** A tracked session the inbox could not load. */
function unloadedRow(id: string, at: string | null): InboxRow {
  return {
    ...trackedRow({
      at,
      checkout: null,
      emoji: '❔',
      id,
      status: {kind: 'unknown'} as SessionStatus,
      statusText: '❔ Unknown (this session could not be loaded)',
      title: '(could not load this session)',
    }),
    loaded: null,
    unreadable: 'its session bead is gone',
  };
}

function inboxRead(
  rows: InboxRow[],
  over: Partial<Pick<InboxRead, 'corrupt'>> & {
    failures?: string[];
    unplaced?: number;
  } = {},
): InboxRead {
  return {
    corrupt: over.corrupt ?? [],
    hiddenByAge: {},
    indexPath: '/state/sessions.jsonl',
    inputDrafts: {failures: [], kind: 'read', unchecked: [], unshown: []},
    missing: false,
    panes: NO_PANES,
    readMarks: {kind: 'read'},
    ...shapeRows(rows),
    sessionDirt: [],
    untracked: {
      devRoot: '/dev',
      failures: over.failures ?? [],
      oldReports: null,
      outsideRoot: {directories: 0, sessions: 0},
      unattributed: [],
      unplaced: over.unplaced ?? 0,
    },
  };
}

const WAITING = {kind: 'waiting', openP0: 2} as SessionStatus;

/** A fake readInbox result. */
function readOf(
  read: InboxRead,
): Promise<{kind: 'failed'; reason: string} | {kind: 'read'; read: InboxRead}> {
  return Promise.resolve({kind: 'read', read});
}

/** Words, not digits: the fold (F6) masks digits, so these never fold. */
const PLANTS = [
  '',
  'basil',
  'chives',
  'dill',
  'fennel',
  'lovage',
  'mint',
  'sage',
];

/** Seven distinct sessions, deliberately not in date order. */
function sevenRows(): InboxRow[] {
  return [3, 7, 1, 5, 2, 6, 4].map((n) =>
    untrackedRow(
      untracked(n, {firstMessage: `Repot the ${PLANTS[n] ?? 'x'} seedlings`}),
    ),
  );
}

const PLAIN_OPTIONS = {limit: 5, now: NOW, project: GARDEN, since: null};

// ---------------------------------------------------------------------------
// D2: the resolver
// ---------------------------------------------------------------------------

describe('resolveProjects (D2)', () => {
  test('a folder name, a tag, any case and brackets all name the same project', () => {
    for (const value of [
      'garden-tools',
      'GARDEN-TOOLS',
      'GARDEN',
      'garden',
      '[garden]',
      ' [Garden] ',
    ]) {
      expect(resolveProjects([value], KNOWN)).toEqual({
        kind: 'ok',
        projects: [GARDEN],
      });
    }
  });

  test('an unknown value is an error listing every known project, one per line, sorted', () => {
    const resolution = resolveProjects(['orchard'], KNOWN);
    expect(resolution).toEqual({kind: 'unknown', values: ['orchard']});
    if (resolution.kind !== 'unknown') throw new Error('expected unknown');
    const text = resolutionErrorText(resolution, {
      problems: [],
      projects: KNOWN,
    });
    expect(text.split('\n')).toEqual([
      'No project is named "orchard". The known projects (folder, then tag):',
      'alpha  [ALPHA]',
      'garden-tools  [GARDEN]',
      'zeta-notes  [ZETA]',
    ]);
  });

  test('an unknown value says when a source of known projects could not be read', () => {
    const resolution = resolveProjects(['orchard'], KNOWN);
    if (resolution.kind !== 'unknown') throw new Error('expected unknown');
    const text = resolutionErrorText(resolution, {
      problems: ['the dev root could not be listed (/dev: EACCES)'],
      projects: KNOWN,
    });
    expect(text).toContain(
      '⚠️ This list may be missing projects: the dev root could not be listed (/dev: EACCES).',
    );
  });

  test('a value two projects share is an error naming both', () => {
    const twins: KnownProject[] = [
      {folder: 'garden-tools', tag: 'GARDEN'},
      {folder: 'garden-web', tag: 'GARDEN'},
    ];
    const resolution = resolveProjects(['garden'], twins);
    expect(resolution).toEqual({
      kind: 'ambiguous',
      matches: twins,
      value: 'garden',
    });
    if (resolution.kind !== 'ambiguous') throw new Error('expected ambiguous');
    const text = resolutionErrorText(resolution, {
      problems: [],
      projects: twins,
    });
    expect(text).toContain('garden-tools  [GARDEN]');
    expect(text).toContain('garden-web  [GARDEN]');
  });
});

describe('knownProjects (D2)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, {force: true, recursive: true});
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'thread-sessions-'));
    dirs.push(dir);
    return dir;
  }

  test('dev-root folders holding .git, with their declared tag; plain folders are not projects', () => {
    const devRoot = tempDir();
    mkdirSync(join(devRoot, 'garden-tools', '.git'), {recursive: true});
    writeFileSync(
      join(devRoot, 'garden-tools', 'justin-sdk.config.json'),
      JSON.stringify({projectTag: 'GARDEN'}),
    );
    mkdirSync(join(devRoot, 'alpha', '.git'), {recursive: true});
    mkdirSync(join(devRoot, 'loose-notes'), {recursive: true});
    expect(listDevRootRepos(devRoot)).toEqual({
      kind: 'read',
      names: expect.arrayContaining(['alpha', 'garden-tools']) as string[],
    });
    const known = knownProjects({
      devRoot,
      env: {XDG_CONFIG_HOME: tempDir()},
      readIndex: () => ({kind: 'missing', path: '/state/sessions.jsonl'}),
    });
    expect(known).toEqual({
      problems: [],
      projects: [
        {folder: 'alpha', tag: 'ALPHA'},
        {folder: 'garden-tools', tag: 'GARDEN'},
      ],
    });
  });

  test('repo names from the sessions index and extra names are known too; an unreadable source is a problem', () => {
    const known = knownProjects({
      devRoot: '/nowhere',
      env: {},
      extraNames: ['orchard', 'alpha'],
      listDevRoot: () => ({kind: 'failed', reason: '/nowhere: ENOENT'}),
      readIndex: () => ({
        corrupt: [],
        kind: 'read',
        path: '/state/sessions.jsonl',
        sessions: [
          {
            newestAt: day(2),
            sessionId: 's-1',
            sightings: [
              {
                at: day(2),
                beadId: 'b-1',
                beadsDir: '/gone/alpha/.beads',
                branch: 'main',
                checkoutPath: '/gone/alpha',
                event: 'created',
                repo: 'alpha',
              },
            ] as never,
          },
        ],
      }),
    });
    expect(known.projects).toEqual([
      {folder: 'alpha', tag: 'ALPHA'},
      {folder: 'orchard', tag: 'ORCHARD'},
    ]);
    expect(known.problems).toEqual([
      'the dev root could not be listed (/nowhere: ENOENT)',
    ]);
  });
});

// ---------------------------------------------------------------------------
// D1: the listing
// ---------------------------------------------------------------------------

describe('buildSessionList: order, limit, folding (D1)', () => {
  test('newest first, five by default, and the footer names how many more and the flag', () => {
    const list = buildSessionList(inboxRead(sevenRows()), PLAIN_OPTIONS);
    expect(list.rows.map((row) => row.sessionId)).toEqual([
      'u-7',
      'u-6',
      'u-5',
      'u-4',
      'u-3',
      'u-2',
      'u-1',
    ]);
    expect(list.shown).toBe(5);
    const text = renderSessionList(list, PLAIN_STYLE, NOW);
    expect(text).toContain(
      'garden-tools [GARDEN]: 7 sessions, newest first (showing 5)',
    );
    expect(text.match(/Resume:/g)?.length).toBe(5);
    expect(text).toContain(
      '2 more sessions not shown: --limit 0 shows every one, --limit N the newest N.',
    );
  });

  test('--limit N shows N, and --limit 0 shows every row with no footer', () => {
    const read = inboxRead(sevenRows());
    expect(buildSessionList(read, {...PLAIN_OPTIONS, limit: 2}).shown).toBe(2);
    const all = buildSessionList(read, {...PLAIN_OPTIONS, limit: 0});
    expect(all.shown).toBe(7);
    const text = renderSessionList(all, PLAIN_STYLE, NOW);
    expect(text.match(/Resume:/g)?.length).toBe(7);
    expect(text).not.toContain('not shown');
  });

  test('a folded row says how many runs it stands for, and the header counts sessions from the rows', () => {
    // Three runs of one first message (digits masked) fold into one row.
    const repeated = [11, 12, 13].map((n) =>
      untrackedRow(untracked(n, {firstMessage: `Water the beds, run ${n}`})),
    );
    const single = untrackedRow(
      untracked(5, {firstMessage: 'Plan the orchard'}),
    );
    const list = buildSessionList(inboxRead([...repeated, single]), {
      ...PLAIN_OPTIONS,
      limit: 0,
    });
    expect(list.rows.map((row) => [row.sessionId, row.runs])).toEqual([
      ['u-13', 3],
      ['u-5', 1],
    ]);
    expect(list.sessions).toBe(4);
    const text = renderSessionList(list, PLAIN_STYLE, NOW);
    expect(text).toContain(
      '4 sessions in 2 rows, newest first (showing 2 rows)',
    );
    expect(text).toContain(
      'Runs:    3 sessions with the same first message, the oldest',
    );
  });

  test('test sessions are counted in one line, never listed', () => {
    const testRow = untrackedRow(
      untracked(9, {
        firstMessage:
          'Try it [TEST_DATA_DELETABLE 0a1b2c3d-1111-4222-8333-444455556666 ]',
        testDataMarker: true,
      }),
    );
    const list = buildSessionList(
      inboxRead([testRow, ...sevenRows()]),
      PLAIN_OPTIONS,
    );
    expect(list.rows.map((row) => row.sessionId)).not.toContain('u-9');
    expect(list.testSessions).toBe(1);
    expect(renderSessionList(list, PLAIN_STYLE, NOW)).toContain(
      '1 test session is left out',
    );
  });

  test('--since leaves out rows older than the window, keeps undated ones, and says what it left out', () => {
    const undated = untrackedRow(
      untracked(30, {
        firstMessage: 'An undated invented session',
        lastActivityAt: unmeasured('no record carries a time'),
      }),
    );
    const list = buildSessionList(inboxRead([...sevenRows(), undated]), {
      ...PLAIN_OPTIONS,
      since: {ms: 15 * 86_400_000, text: '15d', words: '15 days'},
    });
    // NOW is 2030-01-20T12:00Z, so the window starts 2030-01-05T12:00Z.
    expect(list.rows.map((row) => row.sessionId)).toEqual([
      'u-7',
      'u-6',
      'u-30',
    ]);
    expect(list.sinceLeftOut).toBe(5);
    const none = buildSessionList(inboxRead(sevenRows()), {
      ...PLAIN_OPTIONS,
      since: {ms: 3_600_000, text: '1h', words: '1 hour'},
    });
    expect(none.rows).toEqual([]);
    expect(renderSessionList(none, PLAIN_STYLE, NOW)).toContain(
      'No session of garden-tools [GARDEN] was active in the last 1 hour; 7 older ones are left out, and dropping --since shows them.',
    );
  });
});

describe('listRow: title, status and resume (D1)', () => {
  test('the title line carries the emoji and the marks, and Status drops the emoji', () => {
    const row = listRow(
      trackedRow({
        at: day(19),
        checkout: '/dev/garden-tools',
        emoji: '🛑',
        id: 't-1',
        marks: {handoff: 2, mayor: true},
        status: WAITING,
        statusText: '🛑 Waiting on you (2 blocking questions)',
        title: 'Prune the invented hedges',
      }),
    );
    expect(row.statusText).toBe('Waiting on you (2 blocking questions)');
    expect(row.statusKind).toBe('waiting');
    const text = renderSessionList(
      {
        complete: true,
        failures: [],
        project: GARDEN,
        rows: [row],
        sessions: 1,
        shown: 1,
        since: null,
        sinceLeftOut: 0,
        testSessions: 0,
        unplaced: 0,
      },
      PLAIN_STYLE,
      NOW,
    );
    expect(text).toContain('🛑 [MAYOR][#2] Prune the invented hedges');
    expect(text).toContain('Status:  Waiting on you (2 blocking questions)');
    expect(text).not.toContain('Status:  🛑');
    expect(text).toContain('Active:  27 hours ago (');
  });

  test('a title with no marks has no stray space or tag', () => {
    const row = listRow(
      trackedRow({
        at: day(19),
        checkout: '/dev/garden-tools',
        emoji: '✅',
        id: 't-2',
        status: {kind: 'done'} as SessionStatus,
        statusText: '✅ Done',
        title: 'Label the invented trays',
      }),
    );
    const text = renderSessionList(
      {
        complete: true,
        failures: [],
        project: GARDEN,
        rows: [row],
        sessions: 1,
        shown: 1,
        since: null,
        sinceLeftOut: 0,
        testSessions: 0,
        unplaced: 0,
      },
      PLAIN_STYLE,
      NOW,
    );
    expect(text).toContain('      ✅ Label the invented trays\n');
    expect(text).not.toContain('[GARDEN] Label');
  });

  test('an untracked row with nothing open reads "Not tracked" and the one-liner finding, never the card sentence', () => {
    const row = listRow(untrackedRow(untracked(4)));
    expect(row.statusText).toBe(`Not tracked; ${NO_REQUEST_RECORDED}`);
    expect(row.statusText).not.toContain('it has no session bead');
    expect(row.statusKind).toBe('notTracked');
  });

  test('an untracked row with work to land, or facts it could not read, says so briefly', () => {
    const toLand = listRow(
      untrackedRow(
        untracked(4, {
          git: {
            ...untracked(4).git,
            aheadOfDefault: measured(3),
            branch: measured('feature-x'),
            merged: measured('notMerged'),
          },
        }),
      ),
    );
    expect(toLand.statusText).toBe(
      'Not tracked; land it: merge feature-x into main (3 commits)',
    );
    const unread = listRow(
      untrackedRow(
        untracked(4, {
          git: {...untracked(4).git, merged: unmeasured('git timed out')},
        }),
      ),
    );
    expect(unread.statusText).toBe(
      'Not tracked; could not be read in full, so check it by hand',
    );
  });

  test('Resume cds to the checkout; an untracked row keeps its own cd; a quote is escaped', () => {
    expect(listRow(untrackedRow(untracked(4))).resume).toBe(
      "cd '/dev/garden-tools' && claude --resume u-4",
    );
    const tracked = listRow(
      trackedRow({
        at: day(19),
        checkout: "/dev/it's-here",
        emoji: '🛑',
        id: 't-3',
        status: WAITING,
        statusText: '🛑 Waiting on you (2 blocking questions)',
        title: 'Invented',
      }),
    );
    expect(tracked.resume).toBe(
      "cd '/dev/it'\\''s-here' && claude --resume t-3",
    );
    expect(tracked.resumeHasDirectory).toBe(true);
  });

  test('with no checkout known, Resume is the bare command and a dimmed note', () => {
    const row = listRow(unloadedRow('t-4', day(19)));
    expect(row.resume).toBe('claude --resume t-4');
    expect(row.resumeHasDirectory).toBe(false);
    const list = buildSessionList(inboxRead([unloadedRow('t-4', day(19))]), {
      ...PLAIN_OPTIONS,
    });
    expect(renderSessionList(list, PLAIN_STYLE, NOW)).toContain(
      "Resume:  claude --resume t-4  (checkout unknown: run it from the project's folder)",
    );
  });

  test('F2: Resume cds to the folder the transcript is filed under: the last cwd, then the checkout, then the first cwd', () => {
    const base = {
      at: day(19),
      emoji: '🛑',
      status: WAITING,
      statusText: '🛑 Waiting on you (2 blocking questions)',
      title: 'Invented',
    };
    const filedUnder = (dir: string, id: string): string =>
      `/projects/${projectDirSlug(dir)}/${id}.jsonl`;
    const worktree = '/dev/garden-tools/.claude/worktrees/w1';
    // Started in the repo, cd'd into a worktree; the transcript stayed with
    // the repo, which is also the first cwd. The checkout is the worktree.
    const stayed = listRow(
      trackedRow({
        ...base,
        checkout: worktree,
        id: 't-5',
        logCwds: ['/dev/garden-tools', null, worktree],
        transcriptPath: filedUnder('/dev/garden-tools', 't-5'),
      }),
    );
    expect(stayed.resume).toBe("cd '/dev/garden-tools' && claude --resume t-5");
    expect(stayed.resumeUnconfirmed).toBe(false);
    // The JSON `checkout` stays the row's checkout (rowCheckout).
    expect(stayed.checkout).toBe(worktree);
    // The slug is lossy (`.`, `_` and `-` are all `-`), so three different
    // folders can all match; the order decides. The last cwd comes first.
    const followed = listRow(
      trackedRow({
        ...base,
        checkout: '/dev/garden_tools',
        id: 't-6',
        logCwds: ['/dev/garden-tools', '/dev/garden.tools'],
        transcriptPath: filedUnder('/dev/garden-tools', 't-6'),
      }),
    );
    expect(followed.resume).toBe(
      "cd '/dev/garden.tools' && claude --resume t-6",
    );
    // Then the checkout, before the first cwd.
    const byCheckout = listRow(
      trackedRow({
        ...base,
        checkout: '/dev/garden_tools',
        id: 't-7',
        logCwds: ['/dev/garden-tools', '/dev/elsewhere'],
        transcriptPath: filedUnder('/dev/garden-tools', 't-7'),
      }),
    );
    expect(byCheckout.resume).toBe(
      "cd '/dev/garden_tools' && claude --resume t-7",
    );
  });

  test('F2: when no candidate matches, or the transcript path is unknown, Resume keeps the checkout and says it is unconfirmed', () => {
    const base = {
      at: day(19),
      checkout: '/dev/garden-tools',
      emoji: '🛑',
      status: WAITING,
      statusText: '🛑 Waiting on you (2 blocking questions)',
      title: 'Invented',
    };
    const elsewhere = listRow(
      trackedRow({
        ...base,
        id: 't-8',
        logCwds: ['/dev/garden-tools'],
        transcriptPath: '/projects/-dev-somewhere-else/t-8.jsonl',
      }),
    );
    const unknown = listRow(
      trackedRow({...base, id: 't-9', transcriptPath: null}),
    );
    for (const row of [elsewhere, unknown]) {
      expect(row.resume).toBe(
        `cd '/dev/garden-tools' && claude --resume ${row.sessionId}`,
      );
      expect(row.resumeHasDirectory).toBe(true);
      expect(row.resumeUnconfirmed).toBe(true);
    }
    const list = buildSessionList(
      inboxRead([trackedRow({...base, id: 't-9', transcriptPath: null})]),
      PLAIN_OPTIONS,
    );
    expect(renderSessionList(list, PLAIN_STYLE, NOW)).toContain(
      "Resume:  cd '/dev/garden-tools' && claude --resume t-9  (could not confirm that this folder holds the transcript)",
    );
    // A confirmed row carries no note.
    const confirmed = buildSessionList(
      inboxRead([trackedRow({...base, id: 't-10'})]),
      PLAIN_OPTIONS,
    );
    expect(renderSessionList(confirmed, PLAIN_STYLE, NOW)).not.toContain(
      'could not confirm',
    );
  });

  test('the Resume line is never wrapped, even on a narrow coloured terminal', () => {
    const list = buildSessionList(
      inboxRead([
        untrackedRow(
          untracked(4, {
            resume:
              "cd '/dev/garden-tools/.claude/worktrees/a-rather-long-worktree-name' && claude --resume u-4",
          }),
        ),
      ]),
      PLAIN_OPTIONS,
    );
    const text = renderSessionList(list, {color: true, width: 40}, NOW);
    const resumeLine = text
      .split('\n')
      .find((line) => line.includes('Resume:'));
    expect(resumeLine).toContain(
      "cd '/dev/garden-tools/.claude/worktrees/a-rather-long-worktree-name' && claude --resume u-4",
    );
  });
});

// ---------------------------------------------------------------------------
// D1: incomplete reads and exit codes
// ---------------------------------------------------------------------------

describe('incomplete reads (D1, rule 7)', () => {
  const ANOMALY =
    "/projects/-dev-x/aaa.jsonl: the records say sessionId bbb-111 but the filename says aaa-222; keyed on the records' id";
  const STAT =
    'stat /projects/-dev-x/aaa.jsonl: EACCES: permission denied — read anyway rather than assumed old';

  test('anomaly notes about a file that was read are not read failures; everything else is', () => {
    expect(classifyUntrackedFailure(ANOMALY)).toBe('anomaly');
    expect(classifyUntrackedFailure(STAT)).toBe('anomaly');
    for (const failure of [
      'read /projects/-dev-x/aaa.jsonl: EACCES: permission denied',
      'readdir /projects: ENOENT — the scan saw NOTHING, so the counts below are not a measurement of this machine',
      'readdir /projects/-dev-x: EACCES — its sessions were NOT scanned',
      'something new nobody classified',
    ]) {
      expect(classifyUntrackedFailure(failure)).toBe('read');
    }
  });

  test('an anomaly note leaves the listing complete; a read failure makes it incomplete with one warning', () => {
    const fine = buildSessionList(
      inboxRead(sevenRows(), {failures: [ANOMALY]}),
      PLAIN_OPTIONS,
    );
    expect(fine.complete).toBe(true);
    expect(sessionListExit(fine)).toBe(0);
    const short = buildSessionList(
      inboxRead(sevenRows(), {
        failures: [ANOMALY, 'read /projects/-dev-x/aaa.jsonl: EIO'],
      }),
      PLAIN_OPTIONS,
    );
    expect(short.complete).toBe(false);
    expect(short.failures).toEqual(['read /projects/-dev-x/aaa.jsonl: EIO']);
    expect(sessionListExit(short)).toBe(2);
    const warnings = renderSessionList(short, PLAIN_STYLE, NOW)
      .split('\n')
      .filter((line) => line.includes('⚠️'));
    expect(warnings).toEqual([
      '  ⚠️ This list may be incomplete: 1 session or file could not be read, and any of them may belong to garden-tools. bun run justin-sdk thread inbox --json names them.',
    ]);
  });

  test('a corrupt index line or a session that could not load makes it incomplete', () => {
    const corrupt = buildSessionList(
      inboxRead(sevenRows(), {
        corrupt: [{lineNumber: 4, reason: 'not JSON'}],
      }),
      PLAIN_OPTIONS,
    );
    expect(corrupt.complete).toBe(false);
    const unloaded = buildSessionList(
      inboxRead([...sevenRows(), unloadedRow('t-9', day(10))]),
      PLAIN_OPTIONS,
    );
    expect(unloaded.failures).toEqual([
      'session t-9 could not be loaded: its session bead is gone',
    ]);
  });

  test('F1: untracked sessions with no working directory make it incomplete, are counted, and exit 2', () => {
    const list = buildSessionList(
      inboxRead(sevenRows(), {unplaced: 2}),
      PLAIN_OPTIONS,
    );
    expect(list.complete).toBe(false);
    expect(list.failures).toHaveLength(2);
    expect(list.failures[0]).toBe(
      'untracked session 1 of 2 could not be placed in a project: no record of its transcript names a working directory',
    );
    expect(sessionListExit(list)).toBe(2);
    const warning = (read: InboxRead): string[] =>
      renderSessionList(buildSessionList(read, PLAIN_OPTIONS), PLAIN_STYLE, NOW)
        .split('\n')
        .filter((line) => line.includes('⚠️'));
    expect(warning(inboxRead(sevenRows(), {unplaced: 2}))).toEqual([
      '  ⚠️ This list may be incomplete: 2 untracked sessions have no recorded working directory, and any of them may belong to garden-tools. bun run justin-sdk thread inbox --json counts them under untracked.unplaced.',
    ]);
    expect(
      warning(
        inboxRead(sevenRows(), {
          failures: ['read /p/x.jsonl: EIO'],
          unplaced: 1,
        }),
      ),
    ).toEqual([
      '  ⚠️ This list may be incomplete: 1 session or file could not be read and 1 untracked session has no recorded working directory, and any of them may belong to garden-tools. bun run justin-sdk thread inbox --json names the unreadable ones and counts the others under untracked.unplaced.',
    ]);
    // None unplaced: complete, and no warning.
    expect(warning(inboxRead(sevenRows(), {unplaced: 0}))).toEqual([]);
  });

  test('exit codes: 0 listed, 1 no sessions, 2 incomplete even with rows', () => {
    expect(
      sessionListExit(buildSessionList(inboxRead(sevenRows()), PLAIN_OPTIONS)),
    ).toBe(0);
    expect(
      sessionListExit(buildSessionList(inboxRead([]), PLAIN_OPTIONS)),
    ).toBe(1);
    expect(
      sessionListExit(
        buildSessionList(
          inboxRead([], {failures: ['read /p/x.jsonl: EIO']}),
          PLAIN_OPTIONS,
        ),
      ),
    ).toBe(2);
  });
});

describe('sessionListJson (D1)', () => {
  test('the record: project, measured session count, the shown rows, completeness', () => {
    const list = buildSessionList(inboxRead(sevenRows()), {
      ...PLAIN_OPTIONS,
      limit: 2,
    });
    const json = sessionListJson(list);
    expect(Object.keys(json).sort()).toEqual([
      'complete',
      'failures',
      'project',
      'rows',
      'sessions',
      'shown',
      'since',
      'testSessions',
      'totalRows',
    ]);
    expect(json.project).toEqual({folder: 'garden-tools', tag: 'GARDEN'});
    expect(json.sessions).toBe(7);
    expect(json.shown).toBe(2);
    expect(json.totalRows).toBe(7);
    expect(json.rows).toHaveLength(2);
    expect(Object.keys(json.rows[0] ?? {}).sort()).toEqual([
      'checkout',
      'emoji',
      'lastActivityAt',
      'marks',
      'repo',
      'repoTag',
      'resume',
      'runs',
      'sessionId',
      'statusKind',
      'statusText',
      'title',
      'tracked',
    ]);
    expect(json.rows[0]).toMatchObject({
      checkout: '/dev/garden-tools',
      lastActivityAt: day(7),
      resume: "cd '/dev/garden-tools' && claude --resume u-7",
      runs: 1,
      sessionId: 'u-7',
      statusKind: 'notTracked',
      tracked: false,
    });
  });
});

describe('plain output (D1)', () => {
  test('piped and NO_COLOR output is plain: no ANSI codes and no wrapping', () => {
    expect(sessionsStyle({isTTY: false}, {})).toEqual(PLAIN_STYLE);
    expect(sessionsStyle({columns: 40, isTTY: true}, {NO_COLOR: '1'})).toEqual(
      PLAIN_STYLE,
    );
    const long = untrackedRow(
      untracked(4, {
        firstMessage: `An invented title ${'that goes on '.repeat(12)}`,
      }),
    );
    const text = renderSessionList(
      buildSessionList(inboxRead([long]), PLAIN_OPTIONS),
      sessionsStyle({columns: 40, isTTY: true}, {NO_COLOR: '1'}),
      NOW,
    );
    expect(text).not.toContain('\u001b[');
    expect(text.split('\n').some((line) => line.length > 120)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

describe('runThreadSessions', () => {
  const known = (): KnownProjects => ({problems: [], projects: KNOWN});

  async function run(
    over: Partial<Parameters<typeof runThreadSessions>[0]>,
  ): Promise<{code: number; err: string; out: string}> {
    let out = '';
    const errors: string[] = [];
    const capture = captureWriteStdout((text) => {
      out += text;
    });
    const realError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    };
    try {
      const code = await runThreadSessions({
        json: false,
        known,
        limit: 5,
        now: NOW,
        project: 'garden',
        readInbox: () => readOf(inboxRead(sevenRows())),
        since: null,
        style: PLAIN_STYLE,
        ...over,
      });
      return {code, err: errors.join('\n'), out};
    } finally {
      capture.mockRestore();
      console.error = realError;
    }
  }

  test('a tag in any case reads the inbox for the resolved folder, with no age window and no pane lookup', async () => {
    const calls: unknown[] = [];
    const result = await run({
      project: '[Garden]',
      readInbox: (input) => {
        calls.push(input);
        return readOf(inboxRead(sevenRows()));
      },
    });
    expect(result.code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({days: 36_500, repo: 'garden-tools'});
    expect(calls[0]).not.toHaveProperty('lookupPanes');
    expect(result.out).toContain('garden-tools [GARDEN]: 7 sessions');
  });

  test('an unknown project exits 2 and lists the known projects; the inbox is never read', async () => {
    let read = false;
    const result = await run({
      project: 'orchard',
      readInbox: () => {
        read = true;
        return readOf(inboxRead([]));
      },
    });
    expect(result.code).toBe(2);
    expect(read).toBe(false);
    expect(result.err).toContain('garden-tools  [GARDEN]');
    expect(result.out).toBe('');
  });

  test('a known project with no sessions exits 1 and says so', async () => {
    const result = await run({
      readInbox: () => readOf(inboxRead([])),
    });
    expect(result.code).toBe(1);
    expect(result.out).toContain(
      'No sessions found for garden-tools [GARDEN].',
    );
  });

  test('an unreadable sessions index, a bad --limit and a bad --since exit 2', async () => {
    expect(
      (
        await run({
          readInbox: () =>
            Promise.resolve({kind: 'failed', reason: 'index unreadable'}),
        })
      ).code,
    ).toBe(2);
    expect((await run({limit: -1})).code).toBe(2);
    expect((await run({limit: 1.5})).code).toBe(2);
    expect((await run({since: '3x'})).code).toBe(2);
  });

  test('--json prints the record and keeps the exit code', async () => {
    const result = await run({
      json: true,
      readInbox: () =>
        readOf(inboxRead(sevenRows(), {failures: ['read /p/x.jsonl: EIO']})),
    });
    expect(result.code).toBe(2);
    const json = JSON.parse(result.out) as {complete: boolean; shown: number};
    expect(json.complete).toBe(false);
    expect(json.shown).toBe(5);
  });
});
