/**
 * The reopen order (home-base-kwand.6, decision D6 of epic home-base-kwand):
 * starred first, then waiting on Justin (blockers), then waiting on him to
 * land (home-base-kwand.19: To land, or an open P1 to P3 question), then cut
 * off mid-turn, then the rest, newest activity first inside each; and
 * `thread open --limit` keeps the top of it. Pure functions only: no cmux,
 * ps or inbox.
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
/** home-base-kwand.19: in To land, no question open. */
const TO_LAND: ReopenSignals = {
  ...NO_REOPEN_SIGNALS,
  toLand: {landable: true, questions: 0},
};
/** home-base-kwand.19: not in To land, one open P1 to P3 question. */
const QUESTION: ReopenSignals = {
  ...NO_REOPEN_SIGNALS,
  toLand: {landable: false, questions: 1},
};

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

/** An inbox row with no signal, `over` applied. */
function row(over: Partial<ReopenRowInput> = {}): ReopenRowInput {
  return {
    card: {unsent: null},
    ending: {at: ago(1), kind: 'replied'},
    flags: null,
    loaded: {counts: {blocking: 0, optional: 0}},
    section: 'stoppedOpen',
    ...over,
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
        toLand: null,
        waiting: {questions: 1},
      }),
    ).toBe('starred');
    expect(
      reopenTier({
        cutOff: {at: null},
        lastActivityAt: null,
        starred: false,
        toLand: {landable: true, questions: 1},
        waiting: {questions: 1},
      }),
    ).toBe('waiting');
    expect(
      reopenTier({
        cutOff: {at: null},
        lastActivityAt: null,
        starred: false,
        toLand: {landable: true, questions: 0},
        waiting: null,
      }),
    ).toBe('toLand');
  });
});

// home-base-kwand.19 (Justin's Q188, option c by default): a second waiting
// tier, below the blockers and above cut off. Each item is listed newest
// first, so an activity-only sort would keep the input order.
//
// NEGATIVE CONTROLS run 2026-11-18, each failing only the tests named:
// - the To land section ignored (`landable` always false in reopenSignals):
//   "a To land session…" and the row-signal test below;
// - P1 to P3 questions ignored (`optional` read as 0 in reopenSignals):
//   "a session with only a P2 question…" and the row-signal test;
// - REOPEN_TIERS with toLand above waiting: "a session with only a P2
//   question…", "the blockers tier…" and the thread open to-land test;
// - REOPEN_TIERS with toLand below cutOff: "a To land session…", "a session
//   with only a P2 question…" and the thread open to-land test (and the
//   chain-fold importance test);
// - the to-land reason saying "🙋 waiting on you": the reason test and the
//   thread open to-land test.
describe('the to-land tier (home-base-kwand.19)', () => {
  test('a To land session ranks above a cut-off one and a recent one, though they are newer', () => {
    const items = [
      item('recent', NO_REOPEN_SIGNALS, 1),
      item('cut off', CUT_OFF, 2),
      item('to land', reopenSignalsOfRow(row({section: 'toLand'})), 50),
    ];
    expect(ordered(items)).toEqual(['to land', 'cut off', 'recent']);
  });

  test('a session with only a P2 question ranks above cut off and below a P0 one', () => {
    // The P2 question counts in StatusCounts.optional (P1 to P3).
    const p2Only = reopenSignalsOfRow(
      row({loaded: {counts: {blocking: 0, optional: 1}}}),
    );
    const p0 = reopenSignalsOfRow(
      row({loaded: {counts: {blocking: 1, optional: 0}}}),
    );
    const items = [
      item('cut off', CUT_OFF, 1),
      item('P2 only', p2Only, 2),
      item('P0', p0, 3),
    ];
    expect(ordered(items)).toEqual(['P0', 'P2 only', 'cut off']);
  });

  test('the blockers tier stays above the to-land tier, even when it is older', () => {
    const items = [
      item('to land', TO_LAND, 1),
      item('question', QUESTION, 2),
      item('needs you', reopenSignalsOfRow(row({section: 'needsYou'})), 90),
      item('P0', WAITING, 100),
    ];
    expect(ordered(items)).toEqual(['needs you', 'P0', 'to land', 'question']);
  });

  test("each row's reason words name its tier", () => {
    const reason = (signals: ReopenSignals) =>
      reopenReason({...signals, lastActivityAt: ago(3)}, NOW);
    expect(reason({...NO_REOPEN_SIGNALS, waiting: {questions: 1}})).toEqual({
      text: '🙋 waiting on you: 1 P0 question',
      tier: 'waiting',
    });
    expect(reason(TO_LAND)).toEqual({
      text: '🛬 ready for you to land',
      tier: 'toLand',
    });
    // To land and a question: the landable work is named.
    expect(
      reason({...NO_REOPEN_SIGNALS, toLand: {landable: true, questions: 2}}),
    ).toEqual({text: '🛬 ready for you to land', tier: 'toLand'});
    expect(reason(QUESTION)).toEqual({
      text: '❓ 1 open question for you',
      tier: 'toLand',
    });
    expect(
      reason({...NO_REOPEN_SIGNALS, toLand: {landable: false, questions: 3}})
        .text,
    ).toBe('❓ 3 open questions for you');
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
    // home-base-kwand.19: the blockers name P0, so the two waiting tiers read
    // differently.
    expect(reason(WAITING, 3)).toEqual({
      text: '🙋 waiting on you: 2 P0 questions',
      tier: 'waiting',
    });
    expect(
      reason({...NO_REOPEN_SIGNALS, waiting: {questions: 1}}, 3).text,
    ).toBe('🙋 waiting on you: 1 P0 question');
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
      reopenSignalsOfRow(row({loaded: {counts: {blocking: 3, optional: 0}}}))
        .waiting,
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

  // home-base-kwand.19: the to-land tier's two signals.
  test('the To land section, or an open P1 to P3 question, is waiting on you to land', () => {
    expect(reopenSignalsOfRow(row({section: 'toLand'})).toLand).toEqual({
      landable: true,
      questions: 0,
    });
    // Unsent text moved it out of To land: still to land, as for Needs you.
    expect(
      reopenSignalsOfRow(
        row({card: {unsent: {beneath: 'toLand'}}, section: 'unsentDraft'}),
      ).toLand,
    ).toEqual({landable: true, questions: 0});
    expect(
      reopenSignalsOfRow(row({loaded: {counts: {blocking: 0, optional: 2}}}))
        .toLand,
    ).toEqual({landable: false, questions: 2});
    // In To land with the questions unread: still to land, the count unknown.
    expect(
      reopenSignalsOfRow(row({loaded: null, section: 'toLand'})).toLand,
    ).toEqual({landable: true, questions: null});
    // Neither: not to land. Unread questions are not taken as open ones.
    expect(reopenSignalsOfRow(row()).toLand).toBeNull();
    expect(reopenSignalsOfRow(row({loaded: null})).toLand).toBeNull();
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
      '🙋 waiting on you: 2 P0 questions',
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

  // home-base-kwand.19: the to-land tier, between waiting and cut off.
  test('to-land sessions open after the blockers and before cut off, and --limit keeps them first', () => {
    const candidates = [
      cand(1, NO_REOPEN_SIGNALS, 1),
      cand(2, CUT_OFF, 2),
      cand(6, QUESTION, 3),
      cand(7, TO_LAND, 4),
      cand(3, WAITING, 5),
    ];
    const run = (limit: number | null) =>
      planOpen({
        candidates,
        checkoutExists: () => true,
        limit,
        live: NO_LIVE,
        now: NOW,
        sections: new Set(['stoppedOpen']),
        sinceMs: 7 * 24 * HOUR,
      });
    expect(run(null).planned.map((entry) => entry.reopen.text)).toEqual([
      '🙋 waiting on you: 2 P0 questions',
      '❓ 1 open question for you',
      '🛬 ready for you to land',
      `✂️ cut off mid-turn at ${endingWhen(ago(30), NOW)}`,
      '🕒 last active 1 hour ago',
    ]);
    const limited = run(3);
    expect(limited.planned.map((entry) => entry.title)).toEqual([
      'session 3',
      'session 6',
      'session 7',
    ]);
    expect(limited.overLimit.map((entry) => entry.reopen.tier)).toEqual([
      'cutOff',
      'recent',
    ]);
  });
});
