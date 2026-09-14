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

import {askKindTag, renderThreadDescription} from '../src/thread/render';
import {
  buildReportModel,
  type BuildReportModelOptions,
} from '../src/thread/report-model';
import {renderMarkdown} from '../src/thread/render-markdown';
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

/**
 * The FULL markdown rendering, which is what these assertions are about: the
 * full form is what the thread bead stores (D10) and what `--full` prints, so it
 * is the document whose shape D11 promises. The compact form has its own tests.
 */
function render(options: BuildReportModelOptions): string {
  return renderMarkdown(buildReportModel({full: true, ...options}));
}

describe('renderMarkdown', () => {
  test('full report matches the committed baseline', () => {
    expect(
      render({
        askIds: ASK_IDS,
        facts: facts(),
        payload: payload(),
        threadId: 'jl-x7q',
      }),
    ).toMatchSnapshot();
  });

  test('restates the last instruction at the top (D11.1)', () => {
    const out = render({
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
    const out = render({
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

  test('asks are ONE numbered sequence, P0 first, options lettered (D11.3)', () => {
    const out = render({
      askIds: ASK_IDS,
      facts: facts(),
      payload: payload(),
      threadId: 'jl-x7q',
    });
    // The P0 ask is 1, the P3 one continues the SAME sequence as 2 — it does
    // not restart at 1 under a heading of its own (D15: the marker IS the
    // grouping, and the numbers run straight through).
    expect(out).toContain('  1. 🛑 P0 · [Approve Y/n] Approve closing ask beads');
    expect(out).toContain('  2. (P3) · [Pick a/b] Where should componentConfig');
    expect(out).toContain('     a. (Recommended) Keep closing');
    expect(out).toContain('     b. Delete — tidier list');
  });

  test('every ask carries its bead id inline (D11.4)', () => {
    const out = render({
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
    const out = render({
      askIds: [null, null],
      facts: facts(),
      payload: payload(),
      threadId: null,
    });
    expect(out).toContain('(NOT RECORDED)');
    expect(out).toContain('this report was NOT recorded');
  });

  test('unmeasured facts render as UNKNOWN, never as a reassuring value', () => {
    const out = render({
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
    // The emoji header shows the value without a title; the UNKNOWN sentence
    // is the same either way, and it is a SENTENCE rather than a dash so it
    // cannot be skimmed as "nothing used".
    expect(out).toContain('🔢 UNKNOWN (see autofill failures)');
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
      priority: 3 as const,
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

/**
 * F4: a CARRIED ask — the thing Justin still owes an answer on — must appear in
 * the numbered Asks section IN FULL.
 *
 * It used to render as `- jl-x7q.1 — carried: <detail>` under "Prior asks": a
 * bare bead id with no question, no form control, no options and no default.
 * The worst case is report 2 carrying a blocking pick and creating no new asks,
 * where the report read "Asks — everything I need from you: - (nothing — you
 * are not blocking anything)" while a blocking question sat unanswered four
 * lines below. That is the exact loss this epic was written to stop, and it
 * broke status-report-format.md twice over ("asks are ONE numbered sequence"
 * and "never a bare id").
 */
describe('carried asks (F4)', () => {
  const carried = [
    {
      askIndex: 0,
      priority: 0,
      fromReport: 1,
      id: 'jl-x7q.1',
      restated: `[Pick a/b] Which default board view do you want?

CONTEXT: you have not been here for hours; this is the dashboard's landing view.

OPTIONS:
  a. (Recommended) Group by repo
  b. Flat by recency

IF UNANSWERED: I keep by-repo as the default.`,
    },
  ];

  test('a report that carries a blocking ask and creates none still shows it', () => {
    const bare = payload();
    bare.asks = [];
    const text = render({
      askIds: [],
      carried,
      facts: facts(),
      payload: bare,
      threadId: 'jl-x7q',
    });
    const asksSection = text.slice(
      text.indexOf('**Asks — everything I need from you:**'),
      text.indexOf('**Prior asks'),
    );
    expect(asksSection).not.toContain('you are not blocking anything');
    // No group headings any more (D15): the P0 marker IS the grouping, and the
    // numbers run straight through every priority.
    expect(asksSection).not.toContain('- Blocking:');
    expect(asksSection).toContain(
      '1. 🛑 P0 · (carried from report #1) (jl-x7q.1)',
    );
    // In FULL: the question, the form control, both options, and the default.
    expect(asksSection).toContain('[Pick a/b] Which default board view');
    expect(asksSection).toContain('a. (Recommended) Group by repo');
    expect(asksSection).toContain(
      'IF UNANSWERED: I keep by-repo as the default.',
    );
  });

  test('carried asks are numbered ahead of new ones in the same sequence', () => {
    const withNew = payload();
    const text = render({
      askIds: ['jl-x7q.4'],
      carried,
      facts: facts(),
      payload: withNew,
      threadId: 'jl-x7q',
    });
    expect(text).toContain('1. 🛑 P0 · (carried from report #1) (jl-x7q.1)');
    expect(text).toContain('2.');
    expect(text.indexOf('jl-x7q.1')).toBeLessThan(text.indexOf('jl-x7q.4'));
  });

  test('a bead with no recorded report number says so rather than inventing one', () => {
    const text = render({
      askIds: [],
      carried: [{...carried[0]!, askIndex: null, fromReport: null}],
      facts: facts(),
      payload: (() => {
        const p = payload();
        p.asks = [];
        return p;
      })(),
      threadId: 'jl-x7q',
    });
    expect(text).toContain('(carried from an earlier report)');
  });

  test('nextSteps render as MINE, merged with what remains (F5, D18)', () => {
    const p = payload();
    p.nextSteps = ['Merge the branch once the review clears'];
    const text = render({
      askIds: ['jl-x7q.4'],
      facts: facts(),
      payload: p,
      threadId: 'jl-x7q',
    });
    // ONE list, titled as Claude's own (D18). Justin said next steps and
    // remaining work were the same thing split across two headings he had to
    // reconcile himself; nextSteps leads because it is the immediate move.
    expect(text).toContain('**What happens next (mine):**');
    expect(text).toContain('➡️ Merge the branch once the review clears');
    expect(text.indexOf('Merge the branch')).toBeLessThan(
      text.indexOf('the read path'),
    );
    // Anything JUSTIN must do is an ask, and stays out of this list entirely.
    expect(
      text.slice(
        text.indexOf('**What happens next (mine):**'),
        text.indexOf('**What I did:**'),
      ),
    ).not.toContain('Approve closing ask beads');
  });

  test('the provisional label replaces "(NOT RECORDED)" when ids are merely pending', () => {
    const text = render({
      askIds: [null],
      facts: facts(),
      missingAskIdLabel: '(ask ids pending)',
      payload: payload(),
      threadId: 'jl-x7q',
    });
    expect(text).toContain('(ask ids pending)');
    expect(text).not.toContain('(NOT RECORDED)');
    // and the footer names the real bead, not "no thread bead"
    expect(text).toContain('justin-sdk thread answer jl-x7q');
  });
});
