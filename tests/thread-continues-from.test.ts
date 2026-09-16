/**
 * D21 — a continued arc carries the PREVIOUS session's open asks
 * (home-base-p1uj.16).
 *
 * THE BUG. A new Claude Code session that continues an arc gets a new thread
 * bead keyed on its own session id, so `listOpenAsks` for that session returns
 * nothing while the asks Justin is actually waiting on sit under the previous
 * session's thread. D4 therefore demanded nothing, and the closing loop in
 * `writeReportToBd` skipped any `priorAsks` id that was not one of the session's
 * own open asks — silently, with a `continue`. The asks evaporated at the exact
 * moment an arc changed hands, which is the cross-session loss this epic exists
 * to stop.
 *
 * Driven against a real subprocess (tests/fake-bd.ts) rather than a stubbed
 * adapter, because what is under test is what bd is LEFT holding: which bead is
 * closed, which one moved, and what the two threads say about each other.
 *
 * NEGATIVE CONTROL (run 2026-09-14). In `writeReportToBd`, the union
 *
 *     const openAskIds = [...ownOpenAskIds, ...continuedOpenAsks.map(…)]
 *
 * was reduced to `const openAskIds = ownOpenAskIds;` — the pre-fix behaviour.
 * Exactly the refusal test below failed:
 *
 *     ✗ REFUSES a report that ignores the continued thread's open asks
 *       error: expect(received).toBe(expected)  Expected: "refused"
 *                                               Received: "written"
 *
 * and the carried/closed test failed with it (`jl-a.1` left open, `jl-a.2` never
 * closed), while "a report that does NOT continue anything is unaffected" stayed
 * green — which is the right shape: only the union is being proved. Restoring it
 * returned all of them to green.
 */

import {describe, expect, test} from 'bun:test';

import {bdContext} from '../src/thread/bd';
import {createFakeBd, type FakeState} from './fake-bd';
import {validateThreadReport} from '../src/thread/schema';
import {writeReportToBd} from '../src/thread/report';
import {examplePayload} from './thread-schema.test';

import type {ThreadFacts} from '../src/thread/facts';
import type {ThreadPriorAsk, ThreadReportPayload} from '../src/thread/schema';

const OLD_THREAD = 'jl-a';
const OLD_ASK_ONE = 'jl-a.1';
const OLD_ASK_TWO = 'jl-a.2';
const SESSION = 'sess-new';

function facts(reportedAt = '2026-09-14T10:00:00.000Z'): ThreadFacts {
  return {
    aheadBehind: {ahead: 0, behind: 0},
    autofillFailures: [],
    branch: 'thread-v2',
    cwd: '/tmp',
    dirty: false,
    entrypoint: 'cli',
    headSha: 'abc123',
    isWorktree: false,
    lastUserMessage: 'keep going',
    model: 'claude-opus-5',
    reportedAt,
    repo: 'justin-sdk',
    repoPath: '/tmp',
    sessionId: SESSION,
    startedAt: '2026-09-14T09:00:00.000Z',
    tokensAtStop: 1,
    transcriptPath: '/tmp/t.jsonl',
    worktreePath: null,
  };
}

/**
 * Thread A: a PREVIOUS session's thread, reported seven times, with two asks
 * still open under it. Nothing here belongs to the reporting session.
 */
function seedPreviousThread(): FakeState['issues'] {
  const askDescription = (text: string): string =>
    [
      `[Answer] ${text}`,
      '',
      'CONTEXT: it came up in the last session',
      '',
      'IF UNANSWERED: I leave it open.',
      '',
      'Answer by commenting on this bead: cd ~/Dev/threads && bun run bd comments add <this id> "your answer"',
      `Thread: ${OLD_THREAD}`,
    ].join('\n');
  return [
    {
      description: 'GOAL: the arc\nYOU ASKED ME TO: start it',
      id: OLD_THREAD,
      metadata: {
        askIds: [OLD_ASK_ONE, OLD_ASK_TWO],
        reportCount: 7,
        reportedAt: '2026-09-13T22:00:00.000Z',
        sessionId: 'sess-old',
      },
      notes: 'the old report',
      parent: null,
      status: 'in_progress',
      title: 'the session that started this arc',
      type: 'thread',
    },
    {
      description: askDescription('Paste the exact error text?'),
      id: OLD_ASK_ONE,
      metadata: {
        askIndex: 0,
        // The default the AUTO-CLOSE quotes back (D24). Its sibling below
        // deliberately has none, so both halves of the rule are exercised.
        defaultAction: 'I leave it open.',
        kind: 'answer',
        priority: 3,
        reportCount: 7,
        threadId: OLD_THREAD,
      },
      notes: '',
      parent: OLD_THREAD,
      status: 'open',
      title: 'Paste the exact error text?',
      type: 'ask',
    },
    {
      description: askDescription('Allowlist ~/Dev/threads for writes?'),
      id: OLD_ASK_TWO,
      metadata: {
        askIndex: 1,
        kind: 'act',
        priority: 1,
        reportCount: 7,
        threadId: OLD_THREAD,
      },
      notes: '',
      parent: OLD_THREAD,
      status: 'open',
      title: 'Allowlist ~/Dev/threads for writes?',
      type: 'ask',
    },
  ] as FakeState['issues'];
}

function payloadFor(options: {
  asks?: Record<string, unknown>[];
  continuesFrom?: string | null;
  priorAsks: ThreadPriorAsk[];
}): ThreadReportPayload {
  const raw = examplePayload();
  raw.continuesFrom = options.continuesFrom ?? null;
  raw.priorAsks = options.priorAsks;
  raw.asks = options.asks ?? [
    {
      context: 'the new session needs this',
      default: 'I take a.',
      kind: 'pick',
      options: [
        {recommended: true, text: 'a. do it'},
        {recommended: false, text: 'b. wait'},
      ],
      priority: 2,
      text: 'A brand-new question?',
    },
  ];
  const validated = validateThreadReport(raw);
  if (validated.status !== 'ok') throw new Error('fixture payload is invalid');
  return validated.payload;
}

function fixture(): {
  ctx: ReturnType<typeof bdContext>;
  fake: ReturnType<typeof createFakeBd>;
} {
  const fake = createFakeBd();
  const ctx = bdContext(fake.env);
  ctx.repoDir = fake.dir;
  const state = fake.read();
  state.issues = seedPreviousThread();
  fake.write(state);
  return {ctx, fake};
}

describe('a session that continues another session’s thread (D21)', () => {
  // D24 REPLACED THE REFUSAL WITH A CLOSE. v2 refused a payload that ignored the
  // continued thread's open asks; refusing is no longer necessary, because
  // ignoring them is now a decision with a defined meaning — Justin never
  // answered, so Claude went with the stated default, so the ask is done.
  test('AUTO-CLOSES the continued thread’s open asks the payload ignores', async () => {
    const {ctx, fake} = fixture();
    const outcome = await writeReportToBd({
      ctx,
      facts: facts(),
      payload: payloadFor({continuesFrom: OLD_THREAD, priorAsks: []}),
      sessionId: SESSION,
    });

    expect(outcome.status).toBe('written');
    if (outcome.status !== 'written') throw new Error('unreachable');
    const issue = (id: string) =>
      fake.read().issues.find((row) => row.id === id);

    // The ask that RECORDED a default closes quoting it back…
    expect(issue(OLD_ASK_ONE)?.status).toBe('closed');
    expect(issue(OLD_ASK_ONE)?.closeReason).toBe('decided: I leave it open.');
    // …and the one that recorded NONE closes as `expired`, not as `decided`.
    // "I took the default" on an ask with no default is a claim nobody made.
    expect(issue(OLD_ASK_TWO)?.status).toBe('closed');
    expect(issue(OLD_ASK_TWO)?.closeReason).toContain('expired:');
    expect(issue(OLD_ASK_TWO)?.closeReason).toContain(
      'no default was recorded',
    );
    expect(outcome.closedAsks).toEqual([OLD_ASK_ONE, OLD_ASK_TWO]);
  });

  test('NEGATIVE CONTROL: without continuesFrom the old thread is untouched', async () => {
    const {ctx, fake} = fixture();
    const outcome = await writeReportToBd({
      ctx,
      facts: facts(),
      payload: payloadFor({continuesFrom: null, priorAsks: []}),
      sessionId: SESSION,
    });
    // Proves the closes above come from the continuation and nothing else: the
    // fixture, the session and the payload are otherwise identical.
    expect(outcome.status).toBe('written');
    if (outcome.status !== 'written') throw new Error('unreachable');
    expect(outcome.closedAsks).toEqual([]);
    const open = fake
      .read()
      .issues.filter((row) => row.type === 'ask' && row.status === 'open');
    expect(open.map((row) => row.id)).toContain(OLD_ASK_ONE);
    expect(open.map((row) => row.id)).toContain(OLD_ASK_TWO);
  });

  test('closes what was answered, SUPERSEDES what is still live, and links both threads', async () => {
    const {ctx, fake} = fixture();
    const outcome = await writeReportToBd({
      ctx,
      facts: facts(),
      payload: payloadFor({
        asks: [
          {
            context: 'the build still fails and I still cannot see the error',
            default: 'I keep guessing from the exit code.',
            kind: 'answer',
            options: [],
            priority: 0,
            supersedes: OLD_ASK_ONE,
            text: 'Paste the exact error text — I asked last session too?',
          },
        ],
        continuesFrom: OLD_THREAD,
        priorAsks: [
          {
            detail: '"local-only for now" — his words',
            disposition: 'answered',
            id: OLD_ASK_TWO,
          },
        ],
      }),
      sessionId: SESSION,
    });

    expect(outcome.status).toBe('written');
    if (outcome.status !== 'written') throw new Error('unreachable');
    const newThreadId = outcome.threadId;
    const newAskId = outcome.askIds[0];
    if (newAskId == null) throw new Error('the restating ask was not created');
    const state = fake.read();
    const issue = (id: string) => state.issues.find((row) => row.id === id);

    // 1. The ANSWERED ask is closed ON THE OLD THREAD, with the reason.
    expect(issue(OLD_ASK_TWO)?.status).toBe('closed');
    expect(issue(OLD_ASK_TWO)?.closeReason).toBe(
      'answered: "local-only for now" — his words',
    );
    expect(outcome.closedAsks).toContain(OLD_ASK_TWO);

    // 2. The STILL-LIVE ask is CLOSED, not moved (D24 retracting D21). The
    //    question survives as a new bead under this thread; the old bead says
    //    where it went, so neither id dead-ends.
    expect(issue(OLD_ASK_ONE)?.status).toBe('closed');
    expect(issue(OLD_ASK_ONE)?.closeReason).toBe(
      `superseded: restated as ${newAskId}`,
    );
    expect(issue(OLD_ASK_ONE)?.parent).toBe(OLD_THREAD);

    // 3. The new ask carries the lineage, so a later reader can say WHICH
    //    report on WHICH thread Justin was first asked this.
    expect(issue(newAskId)?.parent).toBe(newThreadId);
    expect(issue(newAskId)?.metadata).toMatchObject({
      supersedesAskId: OLD_ASK_ONE,
      supersedesFromReport: 7,
      supersedesFromThread: OLD_THREAD,
    });

    // 4. And the report says it in words, never as a bare id.
    expect(outcome.rendered).toContain(
      `supersedes ${OLD_ASK_ONE} from ${OLD_THREAD} report #7`,
    );

    // 5. The two threads point at each other.
    expect(issue(OLD_THREAD)?.metadata?.continuedBy).toBe(newThreadId);
    expect(issue(newThreadId)?.metadata?.continuesFrom).toBe(OLD_THREAD);
    expect(issue(OLD_THREAD)?.description).toContain(
      `Continued by ${newThreadId}`,
    );

    // 6. One open ask on the new thread: the restated one. Nothing is carried.
    expect(issue(newThreadId)?.metadata?.openAskCount).toBe(1);
    expect(issue(newThreadId)?.metadata?.carriedAskIds).toEqual([]);
  });

  test('REFUSES a supersedes that names an ask this report cannot close', async () => {
    const {ctx, fake} = fixture();
    const outcome = await writeReportToBd({
      ctx,
      facts: facts(),
      payload: payloadFor({
        asks: [
          {
            context: 'ctx',
            default: 'I guess',
            kind: 'answer',
            options: [],
            priority: 1,
            supersedes: 'jl-a.99',
            text: 'restating something that does not exist?',
          },
        ],
        continuesFrom: OLD_THREAD,
        priorAsks: [],
      }),
      sessionId: SESSION,
    });

    // NOT ignored. An unclosable supersedes would print "supersedes jl-a.99,
    // now closed" under an ask while jl-a.99 stayed open — a report claiming in
    // writing to have handled a question it did not touch.
    expect(outcome.status).toBe('refusedSupersede');
    if (outcome.status !== 'refusedSupersede') throw new Error('unreachable');
    expect(outcome.problems.join('\n')).toContain('jl-a.99');
    // Nothing was written: the refusal happens before the first write.
    expect(
      fake.read().issues.filter((row) => row.type === 'thread'),
    ).toHaveLength(1);
  });

  test('a second report from the same session appends the link line ONCE', async () => {
    const {ctx, fake} = fixture();
    const first = await writeReportToBd({
      ctx,
      facts: facts('2026-09-14T10:00:00.000Z'),
      payload: payloadFor({continuesFrom: OLD_THREAD, priorAsks: []}),
      sessionId: SESSION,
    });
    expect(first.status).toBe('written');
    if (first.status !== 'written') throw new Error('unreachable');

    // Report #2 from the same session, naming the same predecessor. Its own ask
    // from report #1 is open and auto-closes; the predecessor's asks are already
    // closed, so there is nothing left to close there — and the link line must
    // still be appended exactly once.
    const second = await writeReportToBd({
      ctx,
      facts: facts('2026-09-14T11:00:00.000Z'),
      payload: payloadFor({continuesFrom: OLD_THREAD, priorAsks: []}),
      sessionId: SESSION,
    });
    expect(second.status).toBe('written');

    const description =
      fake.read().issues.find((row) => row.id === OLD_THREAD)?.description ??
      '';
    const line = `Continued by ${first.threadId}`;
    expect(description.split(line).length - 1).toBe(1);
  });

  test('REFUSES a continuesFrom that names no bead at all', async () => {
    const {ctx, fake} = fixture();
    const outcome = await writeReportToBd({
      ctx,
      facts: facts(),
      payload: payloadFor({continuesFrom: 'jl-nope', priorAsks: []}),
      sessionId: SESSION,
    });

    // NOT "that thread had no open asks". A typo'd predecessor is a payload
    // error, and treating it as an empty list would fabricate an all-clear over
    // the very asks this feature carries.
    expect(outcome.status).toBe('refusedContinuation');
    if (outcome.status !== 'refusedContinuation') {
      throw new Error('unreachable');
    }
    expect(outcome.continuesFrom).toBe('jl-nope');
    expect(outcome.detail).toContain('no bead with that id');
    // Nothing was written: the refusal happens before the first write.
    expect(
      fake.read().issues.filter((row) => row.type === 'thread'),
    ).toHaveLength(1);
  });

  test('REFUSES a continuesFrom that names an ASK instead of a thread', async () => {
    const {ctx} = fixture();
    const outcome = await writeReportToBd({
      ctx,
      facts: facts(),
      payload: payloadFor({continuesFrom: OLD_ASK_ONE, priorAsks: []}),
      sessionId: SESSION,
    });
    expect(outcome.status).toBe('refusedContinuation');
    if (outcome.status !== 'refusedContinuation') {
      throw new Error('unreachable');
    }
    expect(outcome.detail).toContain('is a ask, not a thread');
  });
});
