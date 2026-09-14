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
  continuesFrom?: string | null;
  priorAsks: ThreadPriorAsk[];
}): ThreadReportPayload {
  const raw = examplePayload();
  raw.continuesFrom = options.continuesFrom ?? null;
  raw.priorAsks = options.priorAsks;
  raw.asks = [
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
  test('REFUSES a report that ignores the continued thread’s open asks', async () => {
    const {ctx} = fixture();
    const outcome = await writeReportToBd({
      ctx,
      facts: facts(),
      payload: payloadFor({continuesFrom: OLD_THREAD, priorAsks: []}),
      sessionId: SESSION,
    });

    expect(outcome.status).toBe('refused');
    if (outcome.status !== 'refused') throw new Error('unreachable');
    // BOTH ids, by name. A refusal that named one of them would let the other
    // evaporate exactly as before.
    expect(outcome.missing).toEqual([OLD_ASK_ONE, OLD_ASK_TWO]);
  });

  test('NEGATIVE CONTROL: the same payload WITHOUT continuesFrom is not refused', async () => {
    const {ctx} = fixture();
    const outcome = await writeReportToBd({
      ctx,
      facts: facts(),
      payload: payloadFor({continuesFrom: null, priorAsks: []}),
      sessionId: SESSION,
    });
    // Proves the refusal above comes from the continuation and nothing else:
    // the fixture, the session and the payload are otherwise identical.
    expect(outcome.status).toBe('written');
  });

  test('closes what was answered, MOVES what was carried, and links both threads', async () => {
    const {ctx, fake} = fixture();
    const outcome = await writeReportToBd({
      ctx,
      facts: facts(),
      payload: payloadFor({
        continuesFrom: OLD_THREAD,
        priorAsks: [
          {
            detail: '"local-only for now" — his words',
            disposition: 'answered',
            id: OLD_ASK_TWO,
          },
          {
            detail: 'still unanswered',
            disposition: 'carried',
            id: OLD_ASK_ONE,
          },
        ],
      }),
      sessionId: SESSION,
    });

    expect(outcome.status).toBe('written');
    if (outcome.status !== 'written') throw new Error('unreachable');
    const newThreadId = outcome.threadId;
    const state = fake.read();
    const issue = (id: string) => state.issues.find((row) => row.id === id);

    // 1. The ANSWERED ask is closed ON THE OLD THREAD, with the reason.
    expect(issue(OLD_ASK_TWO)?.status).toBe('closed');
    expect(issue(OLD_ASK_TWO)?.closeReason).toBe(
      'answered: "local-only for now" — his words',
    );
    expect(outcome.closedAsks).toContain(OLD_ASK_TWO);

    // 2. The CARRIED ask is open, re-parented, and still carries its own id —
    //    the id Justin already read in the previous report.
    expect(issue(OLD_ASK_ONE)?.status).toBe('open');
    expect(issue(OLD_ASK_ONE)?.parent).toBe(newThreadId);
    expect(issue(OLD_ASK_ONE)?.metadata).toMatchObject({
      askIndex: 0,
      reportCount: 7,
    });

    // 3. It renders in the NEW thread's one numbered sequence, labelled with
    //    the thread it came from — never as a bare id under "prior asks".
    expect(outcome.rendered).toContain(
      `carried from ${OLD_THREAD} report #7`,
    );
    expect(outcome.rendered).toContain(OLD_ASK_ONE);
    expect(outcome.rendered).toContain('Paste the exact error text?');

    // 4. The two threads point at each other.
    expect(issue(OLD_THREAD)?.metadata?.continuedBy).toBe(newThreadId);
    expect(issue(newThreadId)?.metadata?.continuesFrom).toBe(OLD_THREAD);
    expect(issue(OLD_THREAD)?.description).toContain(
      `Continued by ${newThreadId}`,
    );

    // 5. The new thread's own counts include what it inherited: a carried ask
    //    is still waiting on Justin, and a count that ignored it would be the
    //    reassuring direction.
    expect(issue(newThreadId)?.metadata?.openAskCount).toBe(2);
    expect(issue(newThreadId)?.metadata?.carriedAskIds).toEqual([OLD_ASK_ONE]);
  });

  test('a second report from the same session appends the link line ONCE', async () => {
    const {ctx, fake} = fixture();
    const carried = (): ThreadReportPayload =>
      payloadFor({
        continuesFrom: OLD_THREAD,
        priorAsks: [
          {detail: 'still open', disposition: 'carried', id: OLD_ASK_ONE},
          {detail: 'still open', disposition: 'carried', id: OLD_ASK_TWO},
        ],
      });

    const first = await writeReportToBd({
      ctx,
      facts: facts('2026-09-14T10:00:00.000Z'),
      payload: carried(),
      sessionId: SESSION,
    });
    expect(first.status).toBe('written');
    if (first.status !== 'written') throw new Error('unreachable');

    // Report #2 from the same session. Both carried asks now live on the NEW
    // thread, so they are its own open asks — and report #1's brand-new ask is
    // open too, so D4 wants all three dispositioned.
    const createdByFirst = first.askIds[0];
    if (createdByFirst == null) throw new Error('report #1 created no ask');
    const second = await writeReportToBd({
      ctx,
      facts: facts('2026-09-14T11:00:00.000Z'),
      payload: payloadFor({
        continuesFrom: OLD_THREAD,
        priorAsks: [
          {detail: 'still open', disposition: 'carried', id: OLD_ASK_ONE},
          {detail: 'still open', disposition: 'carried', id: OLD_ASK_TWO},
          {
            detail: 'I took a, as stated',
            disposition: 'decided',
            id: createdByFirst,
          },
        ],
      }),
      sessionId: SESSION,
    });
    expect(second.status).toBe('written');

    const description =
      fake.read().issues.find((row) => row.id === OLD_THREAD)?.description ?? '';
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
