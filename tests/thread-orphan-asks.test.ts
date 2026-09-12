/**
 * F1 (blocks-merge): a half-written report must not wedge every later retry.
 *
 * THE BUG. A payload with two asks. `createAsk` succeeds for the first, bd
 * locks on the second, the write returns bdFailed and the payload is spooled.
 * The first ask is now an OPEN bead that this very payload created — so D4
 * refuses every replay of it, forever: it cannot appear in `priorAsks`, because
 * it did not exist when the payload was written. The spool file never drains,
 * for exactly the failure D5 names as the accepted risk. And the obvious human
 * workaround — disposition it "carried" — makes the retry create a SECOND bead
 * for the same question.
 *
 * Driven against a real subprocess (tests/fake-bd.ts), not a stubbed adapter,
 * because what is under test is what bd LEAVES BEHIND when it dies mid-sequence.
 */

import {describe, expect, test} from 'bun:test';

import {bdContext} from '../src/thread/bd';
import {createFakeBd} from './fake-bd';
import {validateThreadReport} from '../src/thread/schema';
import {writeReportToBd} from '../src/thread/report';
import {examplePayload} from './thread-schema.test';

import type {ThreadFacts} from '../src/thread/facts';
import type {ThreadReportPayload} from '../src/thread/schema';

const SESSION = 'sess-orphan';

function facts(reportedAt: string): ThreadFacts {
  return {
    aheadBehind: {ahead: 0, behind: 0},
    autofillFailures: [],
    branch: 'thread-reports',
    cwd: '/tmp',
    dirty: false,
    entrypoint: 'cli',
    headSha: 'abc123',
    isWorktree: false,
    lastUserMessage: 'go',
    model: 'claude-opus-5',
    reportedAt,
    repo: 'justin-sdk',
    repoPath: '/tmp',
    sessionId: SESSION,
    startedAt: '2026-09-12T07:00:00.000Z',
    tokensAtStop: 1,
    transcriptPath: '/tmp/t.jsonl',
    worktreePath: null,
  };
}

/** A payload with TWO asks, so bd can fail between them. */
function twoAskPayload(): ThreadReportPayload {
  const raw = examplePayload();
  raw.asks = [
    {
      blocking: true,
      context: 'the first question',
      default: 'I take a.',
      kind: 'pick',
      options: [
        {recommended: true, text: 'a. do it'},
        {recommended: false, text: 'b. wait'},
      ],
      text: 'Ask one?',
    },
    {
      blocking: false,
      context: 'the second question',
      default: 'I leave it.',
      kind: 'approve',
      options: [],
      text: 'Ask two?',
    },
  ];
  raw.priorAsks = [];
  const validated = validateThreadReport(raw);
  if (validated.status !== 'ok') throw new Error('fixture payload is invalid');
  return validated.payload;
}

describe('a report interrupted between its two asks', () => {
  test('the retry SUCCEEDS: the orphan is closed and the asks are recreated', async () => {
    const fake = createFakeBd(2); // fail the 2nd `create -t ask`
    const ctx = bdContext(fake.env);
    ctx.lifeDir = fake.dir;
    const payload = twoAskPayload();

    // --- attempt 1: dies after the first ask ---
    const first = await writeReportToBd({
      ctx,
      facts: facts('2026-09-12T10:00:00.000Z'),
      payload,
      sessionId: SESSION,
    });
    expect(first.status).toBe('bdFailed');

    const afterFirst = fake.read();
    const orphans = afterFirst.issues.filter(
      (issue) => issue.type === 'ask' && issue.status === 'open',
    );
    expect(orphans).toHaveLength(1); // the orphan exists — this is the premise
    const orphanId = orphans[0]!.id;

    // --- attempt 2: the same payload, replayed (what the drain does) ---
    const state = fake.read();
    state.failAskCreateAt = 0; // bd has recovered
    state.askCreates = 0;
    fake.write(state);

    const second = await writeReportToBd({
      ctx,
      facts: facts('2026-09-12T10:05:00.000Z'),
      payload,
      sessionId: SESSION,
    });

    // THE FINDING: this used to be {status: 'refused', missing: [orphanId]}.
    expect(second.status).toBe('written');

    const afterSecond = fake.read();
    const orphan = afterSecond.issues.find((issue) => issue.id === orphanId);
    expect(orphan?.status).toBe('closed');
    expect(orphan?.closeReason).toContain('incomplete report attempt');

    // Exactly two open asks: the payload's two, recreated once — not three.
    const open = afterSecond.issues.filter(
      (issue) => issue.type === 'ask' && issue.status === 'open',
    );
    expect(open).toHaveLength(2);
    expect(open.map((issue) => issue.title)).toEqual(['Ask one?', 'Ask two?']);
  });

  test('an ask from a COMPLETED earlier report is never mistaken for an orphan', async () => {
    // The guard keys on two stamps together (createdAt === the thread's last
    // reportedAt AND absent from metadata.askIds). A properly finalised report
    // records its ask ids, so its asks must survive the next report untouched —
    // otherwise the fix would silently close real questions Justin owes answers
    // on, which is far worse than the bug it replaces.
    const fake = createFakeBd(0);
    const ctx = bdContext(fake.env);
    ctx.lifeDir = fake.dir;

    const first = await writeReportToBd({
      ctx,
      facts: facts('2026-09-12T10:00:00.000Z'),
      payload: twoAskPayload(),
      sessionId: SESSION,
    });
    expect(first.status).toBe('written');
    if (first.status !== 'written') throw new Error('unreachable');
    const liveAskIds = first.askIds.filter((id): id is string => id != null);
    expect(liveAskIds).toHaveLength(2);

    // Report 2 carries both, as D4 requires.
    const carrying = twoAskPayload();
    carrying.asks = [];
    carrying.priorAsks = liveAskIds.map((id) => ({
      detail: 'still waiting on Justin',
      disposition: 'carried' as const,
      id,
    }));
    const second = await writeReportToBd({
      ctx,
      facts: facts('2026-09-12T10:05:00.000Z'),
      payload: carrying,
      sessionId: SESSION,
    });
    expect(second.status).toBe('written');

    const open = fake
      .read()
      .issues.filter(
        (issue) => issue.type === 'ask' && issue.status === 'open',
      );
    expect(open.map((issue) => issue.id).sort()).toEqual(
      [...liveAskIds].sort(),
    );
  });

  test('the carried asks reach the rendered report IN FULL (F4)', async () => {
    const fake = createFakeBd(0);
    const ctx = bdContext(fake.env);
    ctx.lifeDir = fake.dir;

    const first = await writeReportToBd({
      ctx,
      facts: facts('2026-09-12T10:00:00.000Z'),
      payload: twoAskPayload(),
      sessionId: SESSION,
    });
    if (first.status !== 'written') throw new Error('unreachable');
    const liveAskIds = first.askIds.filter((id): id is string => id != null);

    const carrying = twoAskPayload();
    carrying.asks = [];
    carrying.priorAsks = liveAskIds.map((id) => ({
      detail: 'still waiting',
      disposition: 'carried' as const,
      id,
    }));
    const second = await writeReportToBd({
      ctx,
      facts: facts('2026-09-12T10:05:00.000Z'),
      payload: carrying,
      sessionId: SESSION,
    });
    if (second.status !== 'written') throw new Error('unreachable');

    const asksSection = second.rendered.slice(
      second.rendered.indexOf('**Asks — everything I need from you:**'),
      second.rendered.indexOf('**Prior asks'),
    );
    expect(asksSection).not.toContain('you are not blocking anything');
    expect(asksSection).toContain('Ask one?');
    expect(asksSection).toContain('a. do it');
    expect(asksSection).toContain('IF UNANSWERED: I take a.');
    expect(asksSection).toContain('(carried from report #1)');
  });

  test('the PROVISIONAL write on an existing thread never says "no thread bead"', async () => {
    const fake = createFakeBd(0);
    const ctx = bdContext(fake.env);
    ctx.lifeDir = fake.dir;

    await writeReportToBd({
      ctx,
      facts: facts('2026-09-12T10:00:00.000Z'),
      payload: twoAskPayload(),
      sessionId: SESSION,
    });

    // Report 2 fails on its first ask, so the bead is left carrying whatever
    // the PROVISIONAL write put there. That text must still describe the thread
    // it is on — D10 promises `bd show` alone is a complete status report.
    const state = fake.read();
    state.failAskCreateAt = 1;
    state.askCreates = 0;
    fake.write(state);

    const open = fake
      .read()
      .issues.filter((i) => i.type === 'ask' && i.status === 'open');
    const retry = twoAskPayload();
    retry.priorAsks = open.map((issue) => ({
      detail: 'still waiting',
      disposition: 'carried' as const,
      id: issue.id,
    }));
    const second = await writeReportToBd({
      ctx,
      facts: facts('2026-09-12T10:05:00.000Z'),
      payload: retry,
      sessionId: SESSION,
    });
    expect(second.status).toBe('bdFailed');

    const thread = fake.read().issues.find((issue) => issue.type === 'thread');
    expect(thread?.notes).not.toContain('no thread bead');
    expect(thread?.notes).toContain(`justin-sdk thread answer ${thread?.id}`);
    expect(thread?.notes).toContain('(ask ids pending)');
  });
});
