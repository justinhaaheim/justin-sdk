/**
 * COMPACT = MUST-SEE (home-base-p1uj.19, D23).
 *
 * Justin read the first v2 report on 2026-09-15 and said the shape was still
 * wrong — not too long by a section or two, wrong in its premise: "shift the
 * mental framework wholesale from the human is going to read all this lovely
 * text to the human will read the minimum bare essential text… and the human MAY
 * read some of the rest."
 *
 * So the compact report is no longer the full report minus two sections. It is
 * where you are, what you were asked, the P0/P1 asks in full, the mistakes in
 * full, and a pointer to everything else. These tests hold that line: what is in
 * it, what is NOT in it, that the numbering survives the cut, and that
 * `thread show`'s text-only compaction produces the same bytes.
 *
 * NEGATIVE CONTROLS are recorded beside the tests that have one.
 */

import {describe, expect, test} from 'bun:test';

import {
  buildReportModel,
  COMPACT_LAST_MESSAGE_CAP,
} from '../src/thread/report-model';
import {
  BEADS_TOUCHED_HEADING,
  compactStoredReport,
  DID_HEADING,
  MORE_LINE_PREFIX,
  MUST_SEE_HEADING,
  renderMarkdown,
  WORK_PRODUCT_HEADING,
} from '../src/thread/render-markdown';
import {validateThreadReport} from '../src/thread/schema';
import {examplePayload} from './thread-schema.test';

import type {ThreadFacts} from '../src/thread/facts';
import type {ThreadReportPayload} from '../src/thread/schema';

function facts(overrides: Partial<ThreadFacts> = {}): ThreadFacts {
  return {
    aheadBehind: {ahead: 3, behind: 0},
    autofillFailures: [],
    branch: 'thread-v3',
    cwd: '/Users/jhaa/Dev/home-base/projects/justin-sdk',
    dirty: false,
    entrypoint: 'cli',
    headSha: '8dc0fd1abc9912345678',
    isWorktree: false,
    lastUserMessage: 'go build the must-see report',
    model: 'claude-opus-5',
    reportedAt: '2026-09-15T09:00:00.000Z',
    repo: 'justin-sdk',
    repoPath: '/Users/jhaa/Dev/home-base/projects/justin-sdk',
    sessionId: '5b9ad9b0-89c5-48ca-a5b2-8e6b9bdabf3d',
    startedAt: '2026-09-15T07:00:00.000Z',
    tokensAtStop: 497_312,
    transcriptPath: '/Users/jhaa/.claude/projects/x/5b9ad9b0.jsonl',
    worktreePath: null,
    ...overrides,
  };
}

const ASK_IDS = ['th-x7q.2', 'th-x7q.3', 'th-x7q.4', 'th-x7q.5'];

/**
 * One ask of every interesting priority, and one deviation of every kind — so
 * both halves of every cut below have something on each side of them.
 */
function payload(): ThreadReportPayload {
  const raw = examplePayload();
  raw.did = Array.from({length: 9}, (_item, index) => `did item ${index + 1}`);
  raw.deviations = [
    {kind: 'mistake', text: 'I edited the live rule file instead of the draft'},
    {kind: 'judgmentCall', text: 'I put the knob in user config, not per-repo'},
    {kind: 'fyi', text: 'the fixture uses a fake bd, not a real one'},
  ];
  const asks = raw.asks as Record<string, unknown>[];
  // examplePayload ships a P0 and a P3; add a P1 and a P2 so the must-see cut
  // falls between P1 and P2 with a real ask on each side of it.
  asks.splice(1, 0, {
    context: 'the next session builds on whichever way this goes',
    default: 'I keep the compact report to P0 and P1.',
    kind: 'pick',
    options: [
      {recommended: true, text: 'a. P0+P1 — what stopped me and what is next'},
      {recommended: false, text: 'b. P0 only — strictly blocking'},
    ],
    priority: 1,
    text: 'Which priorities belong in the compact report?',
  });
  asks.splice(2, 0, {
    context: 'not urgent; it can wait for the week',
    default: 'I leave the emoji header on.',
    kind: 'approve',
    options: [],
    priority: 2,
    text: 'Keep the emoji header on by default?',
  });
  const result = validateThreadReport(raw);
  if (result.status !== 'ok') {
    throw new Error(`fixture payload is invalid:\n${result.issues.join('\n')}`);
  }
  return result.payload;
}

function render(
  full: boolean,
  overrides: Partial<ThreadFacts> = {},
  options: {payload?: ThreadReportPayload; threadId?: string | null} = {},
): string {
  return renderMarkdown(
    buildReportModel({
      askIds: ASK_IDS,
      facts: facts(overrides),
      full,
      payload: options.payload ?? payload(),
      threadId: options.threadId === undefined ? 'th-x7q' : options.threadId,
    }),
  );
}

/** `  3. (P3) · …` → 3. The numbering, as any reader would read it off. */
function askNumbers(report: string): number[] {
  return report
    .split('\n')
    .map((line) => /^ {2}(\d+)\. (?:🛑 P0|P1|P2|\(P3\)|\(P4\))/u.exec(line))
    .filter((match): match is RegExpExecArray => match != null)
    .map((match) => Number(match[1]));
}

describe('the compact report is the MUST-SEE report', () => {
  test('carries the glance, the where block and three fields — and nothing else above MUST-SEE', () => {
    const compact = render(false);
    expect(compact).toContain('**Thread:**');
    expect(compact).toContain('**You asked me to:**');
    expect(compact).toContain('**Your last message, verbatim:**');
    expect(compact).toContain(MUST_SEE_HEADING);
    // Everything that is not must-see is gone — not shortened, gone.
    for (const heading of [
      DID_HEADING,
      '**What I learned:**',
      '**Answers to your questions:**',
      '**Deviations from what you asked for:**',
      '**Prior asks — closed by this report:**',
      WORK_PRODUCT_HEADING,
      BEADS_TOUCHED_HEADING,
      '**What happens next (mine):**',
    ]) {
      expect(compact).not.toContain(heading);
    }
  });

  test('NEGATIVE CONTROL: --full still carries every one of them', () => {
    const full = render(true);
    for (const heading of [
      DID_HEADING,
      '**What I learned:**',
      '**Answers to your questions:**',
      '**Deviations from what you asked for:**',
      '**Prior asks — closed by this report:**',
      WORK_PRODUCT_HEADING,
      BEADS_TOUCHED_HEADING,
      '**What happens next (mine):**',
    ]) {
      expect(full).toContain(heading);
    }
    expect(full).not.toContain(MUST_SEE_HEADING);
  });

  test('keeps P0 and P1 asks IN FULL and drops P2-P4 into the count', () => {
    const compact = render(false);
    // P0, in full: the question, its context, its options, its default.
    expect(compact).toContain('Approve closing ask beads rather than deleting');
    expect(compact).toContain('Context: The adapter closes asks instead');
    expect(compact).toContain("If you don't answer: I keep closing");
    // P1, in full.
    expect(compact).toContain('Which priorities belong in the compact report?');
    expect(compact).toContain('a. (Recommended) a. P0+P1');
    // P2 and P3: not a word of them.
    expect(compact).not.toContain('Keep the emoji header on by default?');
    expect(compact).not.toContain(
      'Where should componentConfig.thread.enabled live?',
    );
    expect(compact).toContain(`${MORE_LINE_PREFIX}2 more asks (P2-P4)`);
  });

  test('keeps MISTAKES in full and drops the other kinds into the count', () => {
    const compact = render(false);
    expect(compact).toContain(
      '⚠️ MISTAKE — I edited the live rule file instead of the draft',
    );
    expect(compact).not.toContain('I put the knob in user config');
    expect(compact).not.toContain('the fixture uses a fake bd');
    expect(compact).toContain('2 more deviations');
  });

  test('the pointer line names the command that shows everything', () => {
    expect(render(false)).toContain(
      'everything: bun run justin-sdk thread show th-x7q --full',
    );
  });

  test('a report that reached no bead says so instead of printing a broken command', () => {
    const compact = render(false, {}, {threadId: null});
    // Rule 6 at the pointer: "run this to see the rest" would be a command that
    // cannot work, on the one report whose rest was never recorded anywhere.
    expect(compact).toContain('everything: NOT RECORDED — no thread bead');
  });

  test('the compact ask numbers are a PREFIX of the full ones', () => {
    const compactNumbers = askNumbers(render(false));
    const fullNumbers = askNumbers(render(true));
    expect(compactNumbers).toEqual([1, 2]);
    expect(fullNumbers).toEqual([1, 2, 3, 4]);
    // ONE SEQUENCE ACROSS BOTH RENDERINGS. "1 yes, 2 b" typed against the
    // compact report has to land on the same asks as against the full one, so
    // the compact numbering is the full numbering truncated — never renumbered.
    expect(fullNumbers.slice(0, compactNumbers.length)).toEqual(compactNumbers);
  });

  test('a report with nothing must-see says so out loud', () => {
    const raw = examplePayload();
    (raw.asks as Record<string, unknown>[]).forEach((ask) => {
      ask.priority = 3;
    });
    raw.deviations = [{kind: 'fyi', text: 'nothing went wrong'}];
    const result = validateThreadReport(raw);
    if (result.status !== 'ok') throw new Error('unreachable');
    const compact = renderMarkdown(
      buildReportModel({
        askIds: ['th-x7q.2', 'th-x7q.3'],
        facts: facts(),
        payload: result.payload,
        threadId: 'th-x7q',
      }),
    );
    // An EMPTY must-see block would read as a rendering bug. Saying it is the
    // difference between "nothing needs you" and "something is broken".
    expect(compact).toContain('- (nothing needs you');
    expect(compact).toContain(`${MORE_LINE_PREFIX}2 more asks (P2-P4)`);
  });

  test('caps the echoed last message at 300, and says it was cut', () => {
    const long = 'x'.repeat(900);
    const compact = render(false, {lastUserMessage: long});
    expect(compact).toContain(`${'x'.repeat(COMPACT_LAST_MESSAGE_CAP - 1)}…`);
    expect(render(true, {lastUserMessage: long})).toContain('x'.repeat(900));
  });

  test('the glance line carries all four badges', () => {
    const line = render(false).split('\n')[2] ?? '';
    expect(line).toContain('✅ Work completed');
    expect(line).toContain('🙋 needs your answers');
    expect(line).toContain('📈 70%');
    expect(line).toContain('🛑 1 P0 ask');
  });

  test('compacting the STORED report gives byte-for-byte the compact rendering', () => {
    // `thread show` has the bead's stored notes and no payload, so it compacts
    // text rather than re-rendering. This is the pin that stops "compact" from
    // meaning two different things on two surfaces.
    expect(compactStoredReport(render(true))).toBe(render(false));
  });

  test('compacting is idempotent — showing a compact report twice is stable', () => {
    const compact = render(false);
    // Not merely cosmetic: a second pass that recounted would find no P2-P4 asks
    // left and print "no other asks" over a report that has two.
    expect(compactStoredReport(compact)).toBe(compact);
  });
});
