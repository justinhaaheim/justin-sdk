/**
 * home-base-kwand.8 (gap G4 of epic home-base-kwand): `thread inbox
 * --idle-for` and the "older, shown anyway" split, over rows built here.
 * The readInbox half (the band with --days, a real waiting session older
 * than the window) is in thread-session-inbox.test.ts.
 */
import type {PaneLookup} from '../src/thread/pane-join';
import type {InboxRead, InboxRow} from '../src/thread/session-inbox';
import type {Unpushed} from '../src/thread/session-model';
import type {UntrackedSession} from '../src/thread/session-untracked';

import {describe, expect, test} from 'bun:test';

import {PLAIN_STYLE} from '../src/cli-style';
import {filterIdleFor, parseIdleFor} from '../src/thread/inbox-idle';
import {
  inboxJson,
  renderInbox,
  runSessionInbox,
} from '../src/thread/session-inbox';
import {measured} from '../src/thread/session-model';
import {untrackedCard, untrackedVerdict} from '../src/thread/session-untracked';

const NOW = new Date('2030-01-10T12:00:00.000Z');
const HOUR = 60 * 60_000;
const NO_PANES: PaneLookup = {ok: false, reason: 'not looked up in this test'};

/** An untracked session, last active at `at` (null: undated). */
function row(
  id: string,
  at: string | null,
  over: Partial<InboxRow> = {},
): InboxRow {
  // The session's own facts need a date; only the row's activity is undated.
  const seen = at ?? '2030-01-01T00:00:00.000Z';
  const s: UntrackedSession = {
    checkout: '/dev/app',
    contextTokens: measured(40_000),
    dirt: null,
    firstMessage: `Work on ${id}`,
    firstMessageAt: seen,
    git: {
      aheadOfDefault: measured(0),
      branch: measured('main'),
      defaultBranch: measured('main'),
      localDefaultBehind: measured(null),
      merged: measured('isDefault'),
      uncommitted: measured(['a.ts']),
      unpushed: measured<Unpushed>({
        count: 0,
        kind: 'counted',
        upstream: 'origin/main',
      }),
    },
    helpers: measured([]),
    lastActivityAt: measured(seen),
    lastMessage: null,
    lastReply: 'Done.',
    messagesFrom: 'messageLog',
    oldReport: measured(null),
    repo: 'app',
    repoResolvedBy: 'git',
    repoRoot: '/dev/app',
    repoTag: 'APP',
    resume: `claude --resume ${id}`,
    scannedLastAt: seen,
    sessionId: id,
    testDataMarker: false,
    transcriptPath: `/projects/-dev-app/${id}.jsonl`,
    wrapUpAt: 150_000,
  };
  const verdict = untrackedVerdict(s, NOW);
  const card = untrackedCard(s, verdict, NOW, NO_PANES);
  return {
    beforeRestart: null,
    card,
    display: 'card',
    ending: {kind: 'unknown', reason: 'not read in this test'},
    git: null,
    handoff: null,
    inputDraft: null,
    lastActivityAt: at,
    lastAssistantAt: null,
    loaded: null,
    repeats: null,
    repo: 'app',
    section: 'notTracked',
    sessionBeadId: null,
    sessionId: id,
    startedAt: at,
    title: card.title,
    tracked: false,
    unread: null,
    unreadable: null,
    untracked: {session: s, verdict},
    ...over,
  };
}

function read(rows: InboxRow[]): InboxRead {
  return {
    beforeRestart: {ok: false, reason: 'not read in this test'},
    corrupt: [],
    hiddenByAge: {},
    indexPath: '/state/sessions.jsonl',
    inputDrafts: {failures: [], kind: 'read', unchecked: [], unshown: []},
    missing: false,
    panes: NO_PANES,
    readMarks: {kind: 'read'},
    rows,
    sessionDirt: [],
    testSessions: [],
    untracked: {
      devRoot: '/dev',
      failures: [],
      oldReports: null,
      outsideRoot: {directories: 0, sessions: 0},
      unattributed: [],
      unplaced: 0,
    },
  };
}

function render(r: InboxRead, order: 'recent' | 'repo' = 'recent'): string {
  return renderInbox(r, {
    all: false,
    days: 5,
    now: NOW,
    order,
    style: PLAIN_STYLE,
    timeZone: 'UTC',
  });
}

function filter24h(r: InboxRead): InboxRead {
  const parsed = parseIdleFor('24h');
  if (parsed.kind !== 'ok') throw new Error(parsed.reason);
  return filterIdleFor(r, parsed, NOW);
}

const at = (msBeforeNow: number): string =>
  new Date(NOW.getTime() - msBeforeNow).toISOString();

describe('thread inbox --idle-for (home-base-kwand.8, G4)', () => {
  test('exactly 24h idle is included; 1 ms less is left out as active', () => {
    const r = filter24h(
      read([
        row('exactly-24h', at(24 * HOUR)),
        row('just-under', at(24 * HOUR - 1)),
        row('two-days', at(48 * HOUR)),
      ]),
    );
    expect(r.rows.map((entry) => entry.sessionId)).toEqual([
      'exactly-24h',
      'two-days',
    ]);
    expect(r.idleFor?.active).toEqual(['just-under']);
    expect(r.idleFor?.undated).toEqual([]);
    const text = render(r);
    expect(text).toContain(
      '# 📥 Inbox — sessions with activity in the last 5 days, idle for at least 24 hours',
    );
    expect(text).toContain(
      '--idle-for 24h left out 1 active in the last 24 hours.',
    );
  });

  test('a session whose last activity cannot be dated is never counted as idle: left out, and named in the text and the JSON', () => {
    const r = filter24h(
      read([
        row('undated', null),
        // A row whose idle time is already known to be unknown.
        row('unparseable', 'not a date', {idleMs: null}),
        row('old', at(72 * HOUR)),
      ]),
    );
    expect(r.rows.map((entry) => entry.sessionId)).toEqual(['old']);
    expect(r.idleFor?.undated.map((entry) => entry.sessionId)).toEqual([
      'undated',
      'unparseable',
    ]);
    expect(render(r)).toContain(
      '--idle-for 24h left out 2 whose last activity could not be dated, so they are not counted as idle (undated, unparseable).',
    );
    const json = inboxJson(r);
    expect(json.idleFor).toMatchObject({
      leftOutActive: 0,
      leftOutUndated: [{sessionId: 'undated'}, {sessionId: 'unparseable'}],
      text: '24h',
      words: '24 hours',
    });
    expect(json.sessions.map((entry) => entry.sessionId)).toEqual(['old']);
  });

  test('a bad value is refused with exit 2 before anything is read, naming --idle-for', async () => {
    const bad = parseIdleFor('soon');
    expect(bad.kind).toBe('bad');
    if (bad.kind === 'bad') expect(bad.reason).toStartWith('--idle-for takes');
    // No env, no index: a run that read anything would fail differently.
    const code = await runSessionInbox({
      all: false,
      days: 30,
      env: {},
      idleFor: 'soon',
      json: false,
      order: 'recent',
      repo: null,
    });
    expect(code).toBe(2);
  });
});

describe('the --days window: older cards shown anyway sit under their own heading (home-base-kwand.8 item 4)', () => {
  test('by repo: the cards active within the window first, then "Older than 5 days, waiting on you (1)", then the unsent one', () => {
    const r = read([
      row('fresh', at(2 * HOUR)),
      row('old-waiting', at(30 * 24 * HOUR), {olderShown: 'waiting'}),
      row('old-draft', at(20 * 24 * HOUR), {olderShown: 'unsentDraft'}),
    ]);
    const text = render(r, 'repo');
    const repoHeading = text.indexOf('## 📁 app (1)');
    const waiting = text.indexOf('## 🛑 Older than 5 days, waiting on you (1)');
    const draft = text.indexOf(
      '## ✍️ Older than 5 days, unsent text in the input box (1)',
    );
    expect(repoHeading).toBeGreaterThan(-1);
    expect(waiting).toBeGreaterThan(repoHeading);
    expect(draft).toBeGreaterThan(waiting);
    // Each card once (its resume line), under its own heading.
    expect(text.split('claude --resume old-waiting').length - 1).toBe(1);
    expect(text.indexOf('claude --resume old-waiting')).toBeGreaterThan(
      waiting,
    );
    expect(text.indexOf('claude --resume fresh')).toBeLessThan(waiting);
    expect(text).toContain(
      '- **🕰️ Older than 5 days, shown anyway:** 2 (1 waiting on you, 1 unsent text in the input box), listed last',
    );
  });
});
