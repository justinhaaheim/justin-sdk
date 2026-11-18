/**
 * The reopen order (home-base-kwand.6, decision D6 of epic home-base-kwand):
 * starred first, then waiting on Justin, then cut off mid-turn, then the
 * rest, newest activity first inside each; and `thread open --limit` keeps
 * the top of it. Pure functions only: no cmux, ps or inbox.
 */
import type {LiveSessions} from '../src/thread/live-sessions';
import type {OpenCandidate} from '../src/thread/open';
import type {
  ReopenFacts,
  ReopenRowInput,
  ReopenSignals,
} from '../src/thread/reopen-order';

import {describe, expect, test} from 'bun:test';

import {planOpen, windowGroups} from '../src/thread/open';
import {
  compareReopen,
  NO_REOPEN_SIGNALS,
  reopenReason,
  reopenSignalsOfRow,
  reopenTier,
  sortForReopen,
} from '../src/thread/reopen-order';
import {STAR_LABEL} from '../src/thread/session-flags';
import {endingWhen} from '../src/thread/transcript-ending';

const NOW = new Date('2026-11-18T12:00:00.000Z');
const HOUR = 60 * 60_000;

function ago(hours: number): string {
  return new Date(NOW.getTime() - hours * HOUR).toISOString();
}

const STARRED: ReopenSignals = {...NO_REOPEN_SIGNALS, starred: true};
const WAITING: ReopenSignals = {...NO_REOPEN_SIGNALS, waiting: {questions: 2}};
const CUT_OFF: ReopenSignals = {...NO_REOPEN_SIGNALS, cutOff: {at: ago(30)}};

type Item = {facts: ReopenFacts; name: string};

function item(
  name: string,
  signals: ReopenSignals,
  hoursAgo: number | null,
): Item {
  return {
    facts: {
      ...signals,
      lastActivityAt: hoursAgo == null ? null : ago(hoursAgo),
    },
    name,
  };
}

function ordered(items: readonly Item[]): string[] {
  return sortForReopen(items, (entry) => ({
    lastActivityAt: entry.facts.lastActivityAt,
    tier: reopenTier(entry.facts),
  })).map((entry) => entry.name);
}

describe('each tier beats the next (D6)', () => {
  test('starred, then waiting on you, then cut off, then the rest, even when the lower tier is newer', () => {
    // Listed newest first, so an activity-only sort would keep this order.
    const items = [
      item('recent', NO_REOPEN_SIGNALS, 1),
      item('cut off', CUT_OFF, 2),
      item('waiting', WAITING, 3),
      item('starred', STARRED, 4),
    ];
    expect(ordered(items)).toEqual(['starred', 'waiting', 'cut off', 'recent']);
  });

  test('a session in two tiers sits in the higher one', () => {
    expect(
      reopenTier({
        cutOff: {at: null},
        lastActivityAt: null,
        starred: true,
        waiting: {questions: 1},
      }),
    ).toBe('starred');
    expect(
      reopenTier({
        cutOff: {at: null},
        lastActivityAt: null,
        starred: false,
        waiting: {questions: 1},
      }),
    ).toBe('waiting');
  });
});

describe('ties inside a tier go by newest activity', () => {
  test('newest first, and an unknown last activity last in its tier', () => {
    const items = [
      item('starred, undated', STARRED, null),
      item('starred, 5h', STARRED, 5),
      item('recent, 1h', NO_REOPEN_SIGNALS, 1),
      item('starred, 2h', STARRED, 2),
      item('recent, undated', NO_REOPEN_SIGNALS, null),
      item('recent, 3h', NO_REOPEN_SIGNALS, 3),
    ];
    expect(ordered(items)).toEqual([
      'starred, 2h',
      'starred, 5h',
      'starred, undated',
      'recent, 1h',
      'recent, 3h',
      'recent, undated',
    ]);
  });

  test('two equal keys compare equal (the sort keeps their order)', () => {
    const key = {lastActivityAt: ago(2), tier: 'cutOff' as const};
    expect(compareReopen(key, {...key})).toBe(0);
  });
});

describe('each row says why it is there', () => {
  test('the reason text of each tier', () => {
    const reason = (signals: ReopenSignals, hoursAgo: number | null) =>
      reopenReason(
        {
          ...signals,
          lastActivityAt: hoursAgo == null ? null : ago(hoursAgo),
        },
        NOW,
      );
    expect(reason(STARRED, 3)).toEqual({text: '⭐ starred', tier: 'starred'});
    expect(reason(WAITING, 3)).toEqual({
      text: '🙋 waiting on you: 2 questions',
      tier: 'waiting',
    });
    expect(
      reason({...NO_REOPEN_SIGNALS, waiting: {questions: 1}}, 3).text,
    ).toBe('🙋 waiting on you: 1 question');
    expect(
      reason({...NO_REOPEN_SIGNALS, waiting: {questions: null}}, 3).text,
    ).toBe('🙋 waiting on you');
    expect(reason(CUT_OFF, 3)).toEqual({
      text: `✂️ cut off mid-turn at ${endingWhen(ago(30), NOW)}`,
      tier: 'cutOff',
    });
    expect(reason({...NO_REOPEN_SIGNALS, cutOff: {at: null}}, 3).text).toBe(
      '✂️ cut off mid-turn',
    );
    expect(reason(NO_REOPEN_SIGNALS, 3)).toEqual({
      text: '🕒 last active 3 hours ago',
      tier: 'recent',
    });
    expect(reason(NO_REOPEN_SIGNALS, 72).text).toBe(
      '🕒 last active 3 days ago',
    );
    expect(reason(NO_REOPEN_SIGNALS, null).text).toBe(
      '🕒 last activity unknown',
    );
  });
});

describe('the signals of an inbox row', () => {
  const row = (over: Partial<ReopenRowInput> = {}): ReopenRowInput => ({
    card: {unsent: null},
    ending: {at: ago(1), kind: 'replied'},
    flags: null,
    loaded: {counts: {blocking: 0}},
    section: 'stoppedOpen',
    ...over,
  });

  test('a plain row has none', () => {
    expect(reopenSignalsOfRow(row())).toEqual(NO_REOPEN_SIGNALS);
  });

  test('⭐ in the chain flags is starred; another flag is not', () => {
    const flags = (labels: string[]) => ({
      emoji: [],
      labels,
      problems: [],
      undecodable: [],
    });
    expect(
      reopenSignalsOfRow(row({flags: flags([STAR_LABEL])})).starred,
    ).toBeTrue();
    expect(
      reopenSignalsOfRow(row({flags: flags(['mark:2764'])})).starred,
    ).toBeFalse();
  });

  test('open blocking questions, or the Needs you section, is waiting on you', () => {
    expect(
      reopenSignalsOfRow(row({loaded: {counts: {blocking: 3}}})).waiting,
    ).toEqual({questions: 3});
    expect(reopenSignalsOfRow(row({section: 'needsYou'})).waiting).toEqual({
      questions: null,
    });
    // Unsent text moved it out of Needs you: still waiting on him.
    expect(
      reopenSignalsOfRow(
        row({card: {unsent: {beneath: 'needsYou'}}, section: 'unsentDraft'}),
      ).waiting,
    ).toEqual({questions: null});
    expect(
      reopenSignalsOfRow(
        row({card: {unsent: {beneath: 'toLand'}}, section: 'unsentDraft'}),
      ).waiting,
    ).toBeNull();
  });

  test('a cut-off ending is cut off, with its time; any other ending is not', () => {
    expect(
      reopenSignalsOfRow(
        row({
          ending: {
            at: ago(5),
            inFlight: 'toolCall',
            kind: 'cutOff',
            live: false,
          },
        }),
      ).cutOff,
    ).toEqual({at: ago(5)});
    expect(
      reopenSignalsOfRow(
        row({
          ending: {
            at: ago(5),
            inFlight: 'toolCall',
            kind: 'workingNow',
            lastRecordAt: ago(0),
          },
        }),
      ).cutOff,
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// thread open: --limit keeps the top of the order
// ---------------------------------------------------------------------------

const NO_LIVE: Extract<LiveSessions, {kind: 'read'}> = {
  bySessionId: new Map(),
  kind: 'read',
  namedProcesses: [],
  unplaced: [],
  workspacesBySessionId: new Map(),
};

function sid(n: number): string {
  return `0000000${n}`.slice(-8) + '-1111-4222-8333-000000000000';
}

function cand(
  n: number,
  reopen: ReopenSignals,
  hoursAgo: number,
): OpenCandidate {
  return {
    checkout: '/dev/repo-a',
    lastActivityAt: ago(hoursAgo),
    marks: {handoff: null, mayor: false},
    reopen,
    repo: 'repo-a',
    repoTag: 'A',
    section: 'stoppedOpen',
    sessionBeadId: `bead-${n}`,
    sessionId: sid(n),
    sessions: 1,
    title: `session ${n}`,
    tracked: true,
  };
}

/** Newest first, so an activity-only order is the reverse of the tiers. */
const CANDIDATES = [
  cand(1, NO_REOPEN_SIGNALS, 1),
  cand(2, CUT_OFF, 2),
  cand(3, WAITING, 3),
  cand(4, STARRED, 4),
  cand(5, NO_REOPEN_SIGNALS, 5),
];

function plan(limit: number | null) {
  return planOpen({
    candidates: CANDIDATES,
    checkoutExists: () => true,
    limit,
    live: NO_LIVE,
    now: NOW,
    sections: new Set(['stoppedOpen']),
    sinceMs: 7 * 24 * HOUR,
  });
}

describe('thread open follows the order', () => {
  test('the plan lists what opens in the reopen order, each with its reason', () => {
    const {planned} = plan(null);
    expect(planned.map((entry) => entry.title)).toEqual([
      'session 4',
      'session 3',
      'session 2',
      'session 1',
      'session 5',
    ]);
    expect(planned.map((entry) => entry.reopen.text)).toEqual([
      '⭐ starred',
      '🙋 waiting on you: 2 questions',
      `✂️ cut off mid-turn at ${endingWhen(ago(30), NOW)}`,
      '🕒 last active 1 hour ago',
      '🕒 last active 5 hours ago',
    ]);
  });

  test('--limit keeps the top of the order and lists the rest in order', () => {
    const limited = plan(2);
    expect(limited.planned.map((entry) => entry.title)).toEqual([
      'session 4',
      'session 3',
    ]);
    expect(limited.overLimit.map((entry) => entry.title)).toEqual([
      'session 2',
      'session 1',
      'session 5',
    ]);
    expect(limited.overLimit[0]?.reopen.tier).toBe('cutOff');
  });

  test('the window keeps the order, the first at the top', () => {
    const {planned} = plan(null);
    const [group] = windowGroups([...planned].reverse(), false);
    expect(group?.order).toEqual([sid(4), sid(3), sid(2), sid(1), sid(5)]);
  });
});
