/**
 * The rendered report (home-base-p1uj D11).
 *
 * A SNAPSHOT plus a handful of named assertions. The snapshot is the baseline
 * for the whole document — any wording change shows up as a reviewable diff and
 * needs `bun test --update-snapshots` to accept, which is the point. The named
 * assertions below it pin the four properties D11 actually promises, so a
 * future edit cannot quietly undo one of them and re-bless the snapshot.
 */

import {describe, expect, test} from 'bun:test';

import {
  askKindTag,
  renderReport,
  renderThreadDescription,
} from '../src/thread/render';
import {validateThreadReport} from '../src/thread/schema';
import {examplePayload} from './thread-schema.test';

import type {ThreadFacts} from '../src/thread/facts';
import type {ThreadReportPayload} from '../src/thread/schema';

function facts(overrides: Partial<ThreadFacts> = {}): ThreadFacts {
  return {
    aheadBehind: {ahead: 3, behind: 0},
    autofillFailures: [],
    branch: 'thread-reports',
    cwd: '/Users/jhaa/Dev/home-base/projects/justin-sdk',
    dirty: true,
    entrypoint: 'cli',
    headSha: '8dc0fd1abc9912345678',
    isWorktree: false,
    lastUserMessage: 'go build dispatch 2',
    model: 'claude-opus-5',
    reportedAt: '2026-09-12T09:00:00.000Z',
    repo: 'justin-sdk',
    repoPath: '/Users/jhaa/Dev/home-base/projects/justin-sdk',
    sessionId: '5b9ad9b0-89c5-48ca-a5b2-8e6b9bdabf3d',
    startedAt: '2026-09-12T07:00:00.000Z',
    tokensAtStop: 243093,
    transcriptPath:
      '/Users/jhaa/.claude/projects/-Users-jhaa-Dev-home-base/5b9ad9b0.jsonl',
    worktreePath: null,
    ...overrides,
  };
}

function payload(): ThreadReportPayload {
  const result = validateThreadReport(examplePayload());
  if (result.status !== 'ok') throw new Error('fixture payload is invalid');
  return result.payload;
}

const ASK_IDS = ['jl-x7q.2', 'jl-x7q.3'];

describe('renderReport', () => {
  test('full report matches the committed baseline', () => {
    expect(
      renderReport({
        askIds: ASK_IDS,
        facts: facts(),
        payload: payload(),
        threadId: 'jl-x7q',
      }),
    ).toMatchSnapshot();
  });

  test('restates the last instruction at the top (D11.1)', () => {
    const out = renderReport({
      askIds: ASK_IDS,
      facts: facts(),
      payload: payload(),
      threadId: 'jl-x7q',
    });
    const instructionLine = out
      .split('\n')
      .findIndex((line) => line.startsWith('**You asked me to:**'));
    const didLine = out
      .split('\n')
      .findIndex((line) => line === '**What I did:**');
    expect(instructionLine).toBeGreaterThan(-1);
    expect(instructionLine).toBeLessThan(didLine);
  });

  test('restates each question before its answer (D11.2)', () => {
    const out = renderReport({
      askIds: ASK_IDS,
      facts: facts(),
      payload: payload(),
      threadId: 'jl-x7q',
    });
    expect(out).toContain(
      '1. Q: Is CLAUDE_CODE_SESSION_ID exported inside a subagent?',
    );
    expect(out).toContain('   A: Yes — measured 2026-09-12');
  });

  test('asks are ONE numbered sequence, blocking first, options lettered (D11.3)', () => {
    const out = renderReport({
      askIds: ASK_IDS,
      facts: facts(),
      payload: payload(),
      threadId: 'jl-x7q',
    });
    // The blocking ask is 1, the non-blocking one continues the SAME sequence
    // as 2 — it does not restart at 1 under its own heading.
    expect(out).toContain('  1. [Approve Y/n] Approve closing ask beads');
    expect(out).toContain('  2. [Pick a/b] Where should componentConfig');
    expect(out).toContain('     a. (Recommended) Keep closing');
    expect(out).toContain('     b. Delete — tidier list');
  });

  test('every ask carries its bead id inline (D11.4)', () => {
    const out = renderReport({
      askIds: ASK_IDS,
      facts: facts(),
      payload: payload(),
      threadId: 'jl-x7q',
    });
    expect(out).toContain('(jl-x7q.2)');
    expect(out).toContain('(jl-x7q.3)');
    expect(out).toContain('Answer: justin-sdk thread answer jl-x7q');
  });

  test('an ask whose bead was never created says so, never invents an id', () => {
    const out = renderReport({
      askIds: [null, null],
      facts: facts(),
      payload: payload(),
      threadId: null,
    });
    expect(out).toContain('(NOT RECORDED)');
    expect(out).toContain('this report was NOT recorded');
  });

  test('unmeasured facts render as UNKNOWN, never as a reassuring value', () => {
    const out = renderReport({
      askIds: ASK_IDS,
      facts: facts({
        aheadBehind: null,
        autofillFailures: ['aheadBehind: no upstream branch'],
        dirty: null,
        tokensAtStop: null,
      }),
      payload: payload(),
      threadId: 'jl-x7q',
    });
    expect(out).toContain('ahead/behind UNKNOWN');
    expect(out).toContain('dirty UNKNOWN');
    expect(out).toContain('**Tokens at stop:** UNKNOWN');
    // A zero would read as "clean, fully merged, nothing used" — the exact
    // conflation critical rule 6 exists to ban.
    expect(out).not.toContain('0 ahead / 0 behind');
    expect(out).toContain('**Facts I could not measure:**');
  });

  test('the bead description is the ten-second read (D10)', () => {
    const out = renderThreadDescription({facts: facts(), payload: payload()});
    expect(out).toContain('GOAL:');
    expect(out).toContain('YOU ASKED ME TO:');
    expect(out).toContain('STOPPED:');
    expect(out).toContain('PROGRESS: 70%');
  });
});

describe('askKindTag', () => {
  test('names the shape of the answer each ask wants', () => {
    const base = {
      blocking: false,
      context: 'c',
      default: 'd',
      options: [],
      text: 't',
    };
    expect(askKindTag({...base, kind: 'approve'})).toBe('[Approve Y/n]');
    expect(askKindTag({...base, kind: 'answer'})).toBe('[Answer]');
    expect(askKindTag({...base, kind: 'act'})).toBe('[Do]');
    expect(
      askKindTag({
        ...base,
        kind: 'pick',
        options: [
          {recommended: true, text: 'a'},
          {recommended: false, text: 'b'},
          {recommended: false, text: 'c'},
        ],
      }),
    ).toBe('[Pick a/b/c]');
  });
});
