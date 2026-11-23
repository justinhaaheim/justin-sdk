/**
 * home-base-l2ejg.5 (D7 in the design field of home-base-l2ejg.3): each
 * request's state line, from fixtures. Pure: no br, no git, no clock but NOW.
 *
 * One test per state (Working; Stopped: why; Waiting on you; Carried by;
 * Done; Unknown), the handoff chain (carried, not carried, unreadable, a
 * loop, three links), the printer, and What to mark's unstaged item.
 */

import type {SessionCommits} from '../src/thread/session-commits';
import type {Measured, SessionModel} from '../src/thread/session-model';
import type {SessionStatus} from '../src/thread/session-status';
import type {RequestNode, TreeIssue} from '../src/thread/session-tree';

import {describe, expect, test} from 'bun:test';

import {renderAskDescription} from '../src/thread/ask-format';
import {THREAD_DEFAULT_STAGES} from '../src/thread/defaults';
import {requestStateText} from '../src/thread/part-one';
import {
  type ChainLookup,
  chainRequestState,
  type ChainSession,
  chainSessionOf,
  NO_CHAIN_LOOKUP,
  type RequestStateLine,
  requestStateLine,
  requestStatesOf,
} from '../src/thread/request-state';
import {markLine} from '../src/thread/session-report';
import {UNSTAGED_LISTED, whatToMark} from '../src/thread/session-status';

const NOW = new Date('2030-01-03T12:00:00.000Z');
const TWO_DAYS_AGO = '2030-01-01T12:00:00.000Z';
const TZ = 'America/Los_Angeles';
const HOME_BASE_LADDER = ['code-done', 'tested', 'approved'];

function issue(id: string, over: Partial<TreeIssue> = {}): TreeIssue {
  return {
    beadsDir: '/repo/.beads',
    closeReason: null,
    closedAt: null,
    createdAt: '2030-01-01T09:00:00.000Z',
    description: null,
    id,
    issueType: 'task',
    labels: [],
    notes: null,
    parentIds: [],
    priority: 2,
    status: 'open',
    title: id,
    updatedAt: TWO_DAYS_AGO,
    ...over,
  };
}

function question(
  id: string,
  priority: number,
  title: string,
  options: {defaultText?: string; qid?: number; to?: string} = {},
): TreeIssue {
  return issue(id, {
    description: renderAskDescription({
      context: [],
      default:
        options.defaultText == null
          ? {kind: 'none', why: 'the session stops here'}
          : {kind: 'text', text: options.defaultText},
      form: 'answer',
      header: null,
      options: [],
      recommended: null,
    }),
    labels: [
      'ask',
      ...(options.qid == null ? [] : [`qid:${options.qid}`]),
      ...(options.to == null ? [] : [`to:${options.to.replace('.', ':')}`]),
    ],
    priority,
    title,
  });
}

function node(request: TreeIssue, questions: TreeIssue[] = []): RequestNode {
  return {children: [], questions, request};
}

const OPEN_WORK: SessionStatus = {kind: 'openWork'};
const WORKING: SessionStatus = {
  helpers: 0,
  kind: 'working',
  lastRecordAt: '2030-01-03T11:59:00.000Z',
};

function line(
  request: RequestNode,
  status: SessionStatus,
  options: {ladder?: string[]; openQuestions?: TreeIssue[]} = {},
): RequestStateLine {
  return requestStateLine({
    carrier: null,
    holder: {openQuestions: options.openQuestions ?? [], status},
    ladder: options.ladder ?? HOME_BASE_LADDER,
    node: request,
  });
}

function text(state: RequestStateLine, absolute = false): string {
  return requestStateText(state, {absolute, now: NOW, timeZone: TZ});
}

describe('the state line, one state at a time', () => {
  test('Working: the holding session is working; next is the first stage when none is marked', () => {
    expect(text(line(node(issue('r-1')), WORKING))).toBe(
      'Working — next: code-done — since 2 days ago',
    );
  });

  test('Stopped: open work, no blocker; next is the stage after the one reached', () => {
    const request = issue('r-1', {labels: ['request', 'stage:code-done']});
    expect(text(line(node(request), OPEN_WORK))).toBe(
      'Stopped: open work, no blocker — next: tested — since 2 days ago',
    );
  });

  test('Stopped: the session waits on another request’s P0, named by its id', () => {
    const elsewhere = question('q-9', 0, 'Which bucket?', {
      qid: 120,
      to: 'r-2',
    });
    const state = line(
      node(issue('r-1')),
      {kind: 'waiting', openP0: 1},
      {openQuestions: [elsewhere]},
    );
    expect(state.kind).toBe('stopped');
    expect(text(state)).toBe(
      'Stopped: the session waits on your answer to Q120 — next: code-done — since 2 days ago',
    );
  });

  test('Stopped: out of context, handed off with no successor, archived by Justin', () => {
    const request = node(issue('r-1'));
    expect(
      line(request, {
        contextTokens: 410_000,
        kind: 'outOfContext',
        wrapUpAt: 400_000,
      }).state,
    ).toBe('Stopped: past wind-down notice');
    expect(line(request, {kind: 'handedOff', successor: null}).state).toBe(
      'Stopped: handed off',
    );
    expect(
      line(request, {kind: 'handedOff', notPickedUp: true, successor: null})
        .state,
    ).toBe('Stopped: handed off, not picked up');
    expect(
      line(request, {by: 'justin', kind: 'done', reason: 'archived: parked'})
        .state,
    ).toBe('Stopped: you archived the session');
  });

  test('Waiting on you: an open P0 linked to it wins over the session status, and names the question', () => {
    const p0 = question(
      'q-1',
      0,
      'Which S3 bucket should the runbook point at?',
      {
        qid: 101,
        to: 'r-1',
      },
    );
    const state = line(node(issue('r-1'), [p0]), WORKING);
    expect(state.kind).toBe('waiting');
    expect(text(state)).toBe(
      'Waiting on you: Q101 Which S3 bucket should the runbook point at? — next: your answer to Q101 — since 2 days ago',
    );
  });

  test('a question with no new-form id is named by its bead id', () => {
    const p0 = question('q-1', 0, 'Which bucket?', {to: 'r-1'});
    expect(line(node(issue('r-1'), [p0]), OPEN_WORK).state).toBe(
      'Waiting on you: q-1 Which bucket?',
    );
  });

  test('next: the default of an open P1 to P3 question linked to it, before the ladder', () => {
    const p3 = question('q-2', 3, 'Gzip the output?', {
      defaultText: 'I leave it uncompressed.',
      to: 'r-1',
    });
    const p2 = question('q-3', 2, 'Which format?', {
      defaultText: 'I write CSV.',
      to: 'r-1',
    });
    expect(line(node(issue('r-1'), [p3, p2]), OPEN_WORK).next).toBe(
      'going ahead with: I write CSV.',
    );
    // A closed question's default is not going ahead.
    const closed = {...p2, status: 'closed'};
    expect(line(node(issue('r-1'), [closed]), OPEN_WORK).next).toBe(
      'code-done',
    );
  });

  test('Done: a closed request short of the last landing stage says rule 7’s step', () => {
    const request = issue('r-1', {
      labels: ['request', 'stage:tested'],
      status: 'closed',
    });
    expect(text(line(node(request), OPEN_WORK))).toBe(
      'Done — next: Try it, then mark it approved — since 2 days ago',
    );
  });

  test('Done: landed (the last stage) or never staged, nothing next', () => {
    const landed = issue('r-1', {
      labels: ['request', 'stage:approved'],
      status: 'closed',
    });
    const unstaged = issue('r-2', {status: 'closed'});
    expect(line(node(landed), WORKING)).toMatchObject({
      kind: 'done',
      next: null,
      state: 'Done',
    });
    expect(line(node(unstaged), WORKING).next).toBeNull();
  });

  test('Unknown: an unknown or export-behind session is never Working or Stopped', () => {
    const state = line(node(issue('r-1')), {
      kind: 'unknown',
      reasons: ['the transcript could not be read'],
    });
    expect(state.kind).toBe('unknown');
    expect(state.state).toBe('Unknown: the transcript could not be read');
  });

  test('since unknown: a last change with no readable time is said, never guessed', () => {
    const request = issue('r-1', {updatedAt: null});
    expect(text(line(node(request), WORKING))).toBe(
      'Working — next: code-done — since unknown',
    );
    const garbled = issue('r-1', {updatedAt: 'last tuesday'});
    expect(line(node(garbled), WORKING).since).toBeNull();
  });

  test('the absolute form Part 1 prints, so a pasted block stays true', () => {
    expect(text(line(node(issue('r-1')), WORKING), true)).toBe(
      'Working — next: code-done — since Tue 2030-01-01 4:00 am',
    );
  });

  test('the default ladder: a closed request at `built` is told to send the link', () => {
    const request = issue('r-1', {
      labels: ['request', 'stage:built'],
      status: 'closed',
    });
    expect(
      line(node(request), OPEN_WORK, {ladder: [...THREAD_DEFAULT_STAGES]}).next,
    ).toBe('Land it: send the build link, then mark it link-sent');
  });
});

// ---------------------------------------------------------------------------
// The handoff chain
// ---------------------------------------------------------------------------

function chainSession(
  name: string,
  status: SessionStatus,
  requests: RequestNode[],
  labels: string[] = [],
): ChainSession {
  return {
    labels,
    ladder: HOME_BASE_LADDER,
    name,
    openQuestions: [],
    requests,
    status,
  };
}

function lookupOf(sessions: Record<string, ChainSession>): ChainLookup {
  return (beadId) => {
    const found = sessions[beadId];
    return found == null
      ? {kind: 'unknown', reason: 'it is not in this inbox'}
      : {kind: 'found', session: found};
  };
}

describe('a request carried down a handoff chain', () => {
  const request = issue('r-1', {
    labels: ['request', 'sid:aaa', 'sid:bbb', 'stage:code-done'],
  });
  const predecessor = chainSession(
    '[HOME][Moe-1] Threads hub',
    {kind: 'handedOff', successor: 's-b'},
    [node(request)],
    ['continued-by:s-b'],
  );

  test('carried: the predecessor shows the successor’s state and name, never "handed off"', () => {
    const successor = chainSession('[HOME][Moe-2] Threads hub', WORKING, [
      node(request),
    ]);
    const state = chainRequestState({
      lookup: lookupOf({'s-b': successor}),
      node: node(request),
      session: predecessor,
    });
    expect(text(state)).toBe(
      'Carried by [HOME][Moe-2] Threads hub: Working — next: tested — since 2 days ago',
    );
    expect(state.state).not.toContain('handed off');
  });

  test('negative control: a successor that does not hold the request leaves it Stopped here', () => {
    const successor = chainSession('[HOME][Moe-2] Threads hub', WORKING, []);
    const state = chainRequestState({
      lookup: lookupOf({'s-b': successor}),
      node: node(request),
      session: predecessor,
    });
    expect(state.carriedBy).toBeNull();
    expect(state.state).toBe(
      'Stopped: handed off to [HOME][Moe-2] Threads hub, which does not hold this request',
    );
  });

  test('a successor that could not be read is Unknown, never Stopped or Working', () => {
    const state = chainRequestState({
      lookup: NO_CHAIN_LOOKUP,
      node: node(request),
      session: predecessor,
    });
    expect(state.kind).toBe('unknown');
    expect(state.state).toBe(
      'Unknown: handed off to s-b, which could not be read (the next session was not looked up)',
    );
  });

  test('three links: the line is the head’s, named by the head', () => {
    const middle = chainSession(
      '[HOME][Moe-2] Threads hub',
      {kind: 'handedOff', successor: 's-c'},
      [node(request)],
      ['continued-by:s-c'],
    );
    const p0 = question('q-1', 0, 'Ship it?', {qid: 130, to: 'r-1'});
    const head = chainSession(
      '[HOME][Moe-3] Threads hub',
      {kind: 'waiting', openP0: 1},
      [node(request, [p0])],
    );
    const state = chainRequestState({
      lookup: lookupOf({'s-b': middle, 's-c': head}),
      node: node(request),
      session: predecessor,
    });
    expect(text(state)).toBe(
      'Carried by [HOME][Moe-3] Threads hub: Waiting on you: Q130 Ship it? — next: your answer to Q130 — since 2 days ago',
    );
  });

  test('a loop in the chain is Unknown and ends', () => {
    const back = chainSession(
      '[HOME][Moe-2] Threads hub',
      {kind: 'handedOff', successor: 's-a'},
      [node(request)],
      ['continued-by:s-a'],
    );
    const start = {...predecessor, labels: ['continued-by:s-b']};
    const state = chainRequestState({
      lookup: lookupOf({'s-a': start, 's-b': back}),
      node: node(request),
      session: start,
    });
    expect(state.kind).toBe('unknown');
    expect(state.state).toContain('the handoff chain loops');
  });

  test('a closed request is Done where it is, whatever the successor', () => {
    const closed = {...request, status: 'closed'};
    const state = chainRequestState({
      lookup: NO_CHAIN_LOOKUP,
      node: node(closed),
      session: predecessor,
    });
    expect(state).toMatchObject({carriedBy: null, kind: 'done'});
  });

  // Conductor review F1: the successor is named as every other surface names
  // it, `[TAG][Moe-2]` with componentConfig.thread.chainNames on, and as
  // before (`[TAG][#2]`) with it off. The caller passes the knob.
  test('the successor is named with its chain name when the chainNames knob is on', () => {
    const successorModel = {
      beads: {
        questions: [],
        requests: [node(request)],
        session: issue('s-b', {
          labels: ['session', 'chain:Moe', 'handoff-number:2'],
          title: 'Threads hub',
        }),
      },
      exportBehind: null,
      repoTag: 'HOME',
      sessionId: 'bbb',
      stages: HOME_BASE_LADDER,
    } as unknown as SessionModel;
    const carriedBy = (chainNames: boolean): string | null =>
      chainRequestState({
        lookup: lookupOf({
          's-b': chainSessionOf(successorModel, WORKING, {chainNames}),
        }),
        node: node(request),
        session: predecessor,
      }).carriedBy;
    expect(carriedBy(true)).toBe('[HOME][Moe-2] Threads hub');
    expect(carriedBy(false)).toBe('[HOME][#2] Threads hub');
  });

  test('requestStatesOf never throws: odd data gives an Unknown line', () => {
    const odd = {
      ...node(request),
      request: {...request, labels: null},
    } as unknown as RequestNode;
    const states = requestStatesOf({
      lookup: NO_CHAIN_LOOKUP,
      session: chainSession('x', WORKING, [odd]),
    });
    expect(states.get('r-1')?.kind).toBe('unknown');
    expect(states.get('r-1')?.state).toStartWith(
      'Unknown: the state line could not be computed',
    );
  });
});

// home-base-1vcgs.2: a session resumed after its successor stopped, then
// handed off again, names two successors. br sorts labels, so the first label
// is the smaller bead id: here the older session, which does not hold the
// request. The newer one does.
describe('a predecessor that names two successors (home-base-1vcgs.2)', () => {
  const request = issue('r-2', {labels: ['request', 'sid:aaa', 'sid:ccc']});
  const OLDER_AT = '2030-01-01T10:00:00.000Z';
  const NEWER_AT = '2030-01-02T10:00:00.000Z';
  const predecessor = (labels: string[]): ChainSession =>
    chainSession(
      '[HOME][Moe-1] Threads hub',
      {kind: 'handedOff', successor: 's-b'},
      [node(request)],
      labels,
    );
  const session = (
    name: string,
    createdAt: null | string,
    holds: boolean,
  ): ChainSession => ({
    ...chainSession(
      name,
      holds ? WORKING : OPEN_WORK,
      holds ? [node(request)] : [],
    ),
    createdAt,
  });
  const stateOf = (
    labels: string[],
    sessions: Record<string, ChainSession>,
  ): RequestStateLine =>
    chainRequestState({
      lookup: lookupOf(sessions),
      node: node(request),
      session: predecessor(labels),
    });
  const BOTH = ['continued-by:s-b', 'continued-by:s-c'];

  test('carried by the newer successor, though the first label names the older one', () => {
    const state = stateOf(BOTH, {
      's-b': session('[HOME][Moe-2] Threads hub', OLDER_AT, false),
      's-c': session('[HOME][Moe-3] Threads hub', NEWER_AT, true),
    });
    expect(state.carriedBy).toBe('[HOME][Moe-3] Threads hub');
    expect(text(state)).toBe(
      'Carried by [HOME][Moe-3] Threads hub: Working — next: code-done — since 2 days ago',
    );
  });

  test('the creation time decides, not the label order: a newer first label is followed', () => {
    const state = stateOf(BOTH, {
      's-b': session('[HOME][Moe-3] Threads hub', NEWER_AT, true),
      's-c': session('[HOME][Moe-2] Threads hub', OLDER_AT, false),
    });
    expect(state.carriedBy).toBe('[HOME][Moe-3] Threads hub');
  });

  test('an unknown newest keeps today’s words: the first label is followed', () => {
    const older = session('[HOME][Moe-2] Threads hub', OLDER_AT, false);
    const cases: Record<string, ChainSession>[] = [
      // A creation time that is missing.
      {'s-b': {...older, createdAt: null}, 's-c': session('n', NEWER_AT, true)},
      // Two equal times.
      {'s-b': older, 's-c': session('n', OLDER_AT, true)},
      // The newer one was not looked up.
      {'s-b': older},
    ];
    for (const sessions of cases) {
      const state = stateOf(BOTH, sessions);
      expect(state.carriedBy).toBeNull();
      expect(state.state).toBe(
        'Stopped: handed off to [HOME][Moe-2] Threads hub, which does not hold this request',
      );
    }
  });

  test('one successor: only that one is looked up', () => {
    const looked: string[] = [];
    const state = chainRequestState({
      lookup: (beadId) => {
        looked.push(beadId);
        return {
          kind: 'found',
          session: session('[HOME][Moe-2] Threads hub', null, true),
        };
      },
      node: node(request),
      session: predecessor(['continued-by:s-b']),
    });
    expect(state.carriedBy).toBe('[HOME][Moe-2] Threads hub');
    expect(looked).toEqual(['s-b']);
  });
});

// ---------------------------------------------------------------------------
// What to mark: open requests with no stage, in a session with commits
// ---------------------------------------------------------------------------

const NO_CREATED = {
  ok: true as const,
  value: {found: [], missing: [], notCreatedThen: []},
};

function commits(count: number): Measured<SessionCommits> {
  return {
    ok: true,
    value: {
      count,
      source: 'transcript',
      unmatchedCalls: [],
      unresolved: [],
    } as unknown as SessionCommits,
  };
}

function markModel(
  requests: TreeIssue[],
  sessionCommits: Measured<SessionCommits>,
): SessionModel {
  return {
    beads: {
      problems: [],
      questions: [],
      requests: requests.map((request) => node(request)),
      session: issue('s-1', {labels: ['session'], title: 'Session'}),
      sessionMissing: null,
    },
    exportBehind: null,
    git: {commits: sessionCommits, uncommitted: {ok: true, value: []}},
    log: {kind: 'missing'},
    stages: HOME_BASE_LADDER,
  } as unknown as SessionModel;
}

function unstagedTexts(model: SessionModel): string[] {
  return whatToMark(model, WORKING, NO_CREATED)
    .filter(
      (item) =>
        item.kind === 'unstaged' ||
        (item.kind === 'unchecked' && item.what.includes('no stage')),
    )
    .map((item) => {
      const view = markLine(item);
      return view.code == null ? view.text : `${view.text} ${view.code}`;
    });
}

describe('What to mark: open requests with no stage', () => {
  const staged = issue('r-0', {labels: ['request', 'stage:code-done']});
  const closed = issue('r-9', {status: 'closed'});

  test('one item per unstaged open request, with the stage command, in a session with commits', () => {
    const model = markModel(
      [staged, closed, issue('r-1', {title: 'Build the export'})],
      commits(2),
    );
    expect(unstagedTexts(model)).toEqual([
      'Request r-1 ("Build the export") has no stage, and this session made 2 commits. Mark the stage it reached (code-done, tested, approved): bun run justin-sdk thread stage r-1 <stage>',
    ]);
  });

  test(`up to ${UNSTAGED_LISTED} are listed one by one; more fold into ONE item`, () => {
    const three = ['r-1', 'r-2', 'r-3'].map((id) => issue(id));
    expect(unstagedTexts(markModel(three, commits(1)))).toHaveLength(3);
    const four = ['r-1', 'r-2', 'r-3', 'r-4'].map((id) => issue(id));
    expect(unstagedTexts(markModel(four, commits(1)))).toEqual([
      '4 open requests have no stage, and this session made 1 commit: r-1, r-2, r-3, r-4. Mark the stage each reached (code-done, tested, approved): bun run justin-sdk thread stage <request id> <stage>',
    ]);
  });

  test('no commits this session: nothing to mark (a question-only session is not nagged)', () => {
    expect(unstagedTexts(markModel([issue('r-1')], commits(0)))).toEqual([]);
  });

  test('commits that could not be counted are said, never read as none', () => {
    const model = markModel([issue('r-1')], {
      ok: false,
      reason: 'the transcript could not be read',
    });
    expect(unstagedTexts(model)).toEqual([
      '⚠️ Could not check whether the open requests with no stage need one (the commits of this session could not be counted): the transcript could not be read.',
    ]);
  });

  test('a model with no ladder lists nothing and does not throw', () => {
    const model = {
      ...markModel([issue('r-1')], commits(3)),
      stages: undefined,
    } as unknown as SessionModel;
    expect(unstagedTexts(model)).toEqual([]);
  });
});
