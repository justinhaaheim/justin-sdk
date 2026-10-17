/**
 * The session dashboard's fix round (home-base-j8q3e.1.10), dispatch 8:
 *
 *  - F4: a card carries no Unpushed line (it belongs to the checkout, and
 *    pushing is not part of landing, v4 D2).
 *  - F5: a session whose first message carries the test-data marker is never
 *    a card or a line, only counted (and listed in the JSON).
 *  - F6: one-liners with the same repo and first message (digits masked) fold
 *    into one line with a count, at the newest one's place.
 *  - F9: `thread inbox --by-status --by-repo` is refused.
 *
 * NEGATIVE CONTROLS: each was run once with the fix undone; the report of
 * dispatch 8 records which assertion failed.
 */

import type {InboxRead, InboxRow} from '../src/thread/session-inbox';
import type {Unpushed} from '../src/thread/session-model';
import type {UntrackedSession} from '../src/thread/session-untracked';

import {describe, expect, test} from 'bun:test';
import {join} from 'path';

import {PLAIN_STYLE} from '../src/cli-style';
import {gitFacts} from '../src/thread/session-card';
import {inboxJson, renderInbox, shapeRows} from '../src/thread/session-inbox';
import {measured, unmeasured} from '../src/thread/session-model';
import {
  carriesTestDataMarker,
  untrackedCard,
  untrackedVerdict,
} from '../src/thread/session-untracked';

const NOW = new Date('2030-01-10T12:00:00.000Z');
const day = (d: number): string =>
  `2030-01-${String(d).padStart(2, '0')}T09:00:00.000Z`;

const DAILY = (d: number): string =>
  `/daily-loop SCHEDULED RUN — unattended. Runner preflight OK — reproduce tmp/daily-loop/preflight-2030-01-${String(d).padStart(2, '0')}.md`;

function session(
  n: number,
  over: Partial<UntrackedSession> = {},
): UntrackedSession {
  return {
    checkout: '/dev/life',
    contextTokens: measured(40_000),
    firstMessage: DAILY(n),
    firstMessageAt: day(n),
    git: {
      aheadOfDefault: measured(0),
      branch: measured('main'),
      defaultBranch: measured('main'),
      merged: measured('isDefault'),
      uncommitted: measured([]),
      unpushed: measured<Unpushed>({
        count: 4,
        kind: 'counted',
        upstream: 'origin/main',
      }),
    },
    helpers: measured([]),
    lastActivityAt: measured(day(n)),
    lastMessage: null,
    lastReply: 'Ran the daily loop.',
    messagesFrom: 'messageLog',
    oldReport: measured(null),
    repo: 'life',
    repoResolvedBy: 'git',
    repoRoot: '/dev/life',
    repoTag: 'LIFE',
    resume: `claude --resume s-${n}`,
    scannedLastAt: day(n),
    sessionId: `s-${n}`,
    testDataMarker: false,
    transcriptPath: `/projects/-dev-life/s-${n}.jsonl`,
    wrapUpAt: 150_000,
    ...over,
  };
}

function row(s: UntrackedSession): InboxRow {
  const verdict = untrackedVerdict(s, NOW);
  const card = untrackedCard(s, verdict, NOW);
  return {
    card,
    display: verdict.display,
    git: null,
    lastActivityAt: s.lastActivityAt.ok ? s.lastActivityAt.value : null,
    loaded: null,
    repeats: null,
    repo: s.repo,
    section: 'notTracked',
    sessionBeadId: null,
    sessionId: s.sessionId,
    startedAt: s.firstMessageAt,
    title: card.title,
    tracked: false,
    unreadable: null,
    untracked: {session: s, verdict},
  };
}

function read(rows: InboxRow[]): InboxRead {
  return {
    corrupt: [],
    hiddenByAge: {},
    indexPath: '/state/sessions.jsonl',
    missing: false,
    ...shapeRows(rows),
    untracked: {
      devRoot: '/dev',
      failures: [],
      oldReports: null,
      outsideRoot: {directories: 0, sessions: 0},
      unplaced: 0,
    },
  };
}

function render(r: InboxRead): string {
  return renderInbox(r, {
    all: false,
    days: 30,
    now: NOW,
    order: 'recent',
    style: PLAIN_STYLE,
    timeZone: 'UTC',
  });
}

describe('F4: a card carries no Unpushed line', () => {
  test('unpushed commits on the checkout are not a card fact; uncommitted files still are', () => {
    const git = session(1, {
      git: {
        ...session(1).git,
        uncommitted: measured(['notes.md']),
      },
    }).git;
    expect(gitFacts(git)).toEqual([{label: 'Uncommitted', value: '1 file'}]);
  });

  test('an unpushed count that could not be taken is not a card fact either', () => {
    const git = {
      ...session(1).git,
      unpushed: unmeasured<Unpushed>('no upstream read'),
    };
    expect(gitFacts(git)).toEqual([]);
  });
});

describe('F5: test sessions are counted, never listed', () => {
  test('the marker needs a real UUID, anywhere in the whole first message', () => {
    const uuid = 'de4c04d9-d5ed-479d-96ce-d0a1b2c3d4e5';
    expect(
      carriesTestDataMarker(`TOY TEST [TEST_DATA_DELETABLE ${uuid} ] go`),
    ).toBe(true);
    expect(carriesTestDataMarker(`[TEST_DATA_DELETABLE ${uuid}]`)).toBe(true);
    expect(
      carriesTestDataMarker(`Run the probe.\n\n[TEST_DATA_DELETABLE ${uuid} ]`),
    ).toBe(true);
    expect(
      carriesTestDataMarker('Find notes with [TEST_DATA_DELETABLE <uuid> ]'),
    ).toBe(false);
    expect(carriesTestDataMarker(null)).toBe(false);
  });

  test('a marked line and a marked card leave the rows; the note counts them and the JSON lists them', () => {
    const r = read([
      row(session(9, {firstMessage: 'Plan my week', testDataMarker: false})),
      row(session(8, {firstMessage: 'TOY TEST one', testDataMarker: true})),
      row(
        session(7, {
          firstMessage: 'TOY TEST two',
          git: {...session(7).git, uncommitted: measured(['x.ts'])},
          testDataMarker: true,
        }),
      ),
    ]);
    expect(r.rows.map((entry) => entry.sessionId)).toEqual(['s-9']);
    expect(r.testSessions.map((entry) => entry.sessionId)).toEqual([
      's-8',
      's-7',
    ]);
    const text = render(r);
    expect(text).not.toContain('TOY TEST');
    expect(text).toContain(
      '2 test sessions hidden: their first message carries the [TEST_DATA_DELETABLE …] marker. --json lists them under testSessions.',
    );
    expect(
      (inboxJson(r) as {testSessions: {sessionId: string}[]}).testSessions,
    ).toHaveLength(2);
  });
});

describe('F6: repeated one-liners fold into one line', () => {
  const rows = (): InboxRow[] => [
    row(session(9)),
    row(session(8, {firstMessage: 'What does the importer do?'})),
    row(session(7)),
    // Same message, but something is open: a card, never folded.
    row(
      session(6, {
        git: {...session(6).git, uncommitted: measured(['draft.md'])},
      }),
    ),
    row(session(5)),
    // Different words: its own line.
    row(
      session(4, {
        firstMessage:
          '/daily-loop SCHEDULED RUN — unattended. RUNNER PREFLIGHT WARNED — read it first',
      }),
    ),
    // Same message in another repo: its own line.
    row(session(3, {repo: 'home-base', repoTag: 'HOME-BASE'})),
  ];

  test('the newest of each group stands for all of it, across sessions between them', () => {
    const r = read(rows());
    expect(r.rows.map((entry) => entry.sessionId)).toEqual([
      's-9',
      's-8',
      's-6',
      's-4',
      's-3',
    ]);
    expect(r.rows[0]?.repeats).toEqual({
      count: 3,
      oldestAt: day(5),
      sessionIds: ['s-9', 's-7', 's-5'],
    });
    expect(r.rows.slice(1).map((entry) => entry.repeats)).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  test('the printed line carries the count and the newest age; the summary counts sessions, not lines', () => {
    const text = render(read(rows()));
    const folded = text
      .split('\n')
      .filter((line) => line.startsWith('❔ [LIFE] /daily-loop'));
    expect(folded).toHaveLength(2);
    expect(folded[0]).toMatch(
      / \(× 3, newest 27 hours ago\) · nothing open found$/,
    );
    expect(text).toContain(
      '- **❔ Not tracked:** 7 (1 with something open or unreadable, 6 with nothing open found)',
    );
    const json = inboxJson(read(rows())) as {
      sessions: {repeats: unknown; untracked: {line: string | null}}[];
    };
    expect(json.sessions[0]?.untracked.line).toMatch(/\(× 3, newest /);
  });
});

describe('F9: --by-status and --by-repo cannot be combined', () => {
  test('the CLI refuses the pair and names both options', () => {
    const cli = join(import.meta.dir, '..', 'src', 'cli.ts');
    const result = Bun.spawnSync(
      ['bun', cli, 'thread', 'inbox', '--by-status', '--by-repo'],
      {
        env: {...process.env, JUSTIN_SDK_HEALTH_NOTICES: 'off'},
        stderr: 'pipe',
        stdout: 'pipe',
      },
    );
    const stderr = result.stderr.toString();
    expect(result.exitCode).not.toBe(0);
    expect(stderr).toContain('mutually exclusive');
    expect(stderr).toContain('by-status');
    expect(stderr).toContain('by-repo');
  });
});
