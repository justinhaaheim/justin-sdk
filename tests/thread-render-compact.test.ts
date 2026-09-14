/**
 * COMPACT BY DEFAULT, --full FOR EVERYTHING (home-base-p1uj.14, D18).
 *
 * Justin read reports #4-#7 on 2026-09-14 and said the format was too long and
 * the top block a wall of text. Compact is the answer: Work product and Beads
 * touched stay on the bead, What I did stops at six items, the echoed last
 * message stops at 600 characters. Nothing is lost — the thread bead's `notes`
 * always store the FULL markdown (D10) and `--full` prints it.
 *
 * The last test here is the load-bearing one. `thread show` cannot re-render (it
 * has text, not a payload), so it compacts the STORED report with a separate
 * function — and two ways of producing "the compact report" is exactly how the
 * two drift apart. They are pinned to each other byte for byte.
 */

import {describe, expect, test} from 'bun:test';

import {
  buildReportModel,
  COMPACT_DID_CAP,
  COMPACT_LAST_MESSAGE_CAP,
} from '../src/thread/report-model';
import {
  BEADS_TOUCHED_HEADING,
  COMPACT_FOOTER,
  compactStoredReport,
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
    branch: 'thread-v2',
    cwd: '/Users/jhaa/Dev/home-base/projects/justin-sdk',
    dirty: false,
    entrypoint: 'cli',
    headSha: '8dc0fd1abc9912345678',
    isWorktree: false,
    lastUserMessage: 'go build the format v2 dispatch',
    model: 'claude-opus-5',
    reportedAt: '2026-09-14T09:00:00.000Z',
    repo: 'justin-sdk',
    repoPath: '/Users/jhaa/Dev/home-base/projects/justin-sdk',
    sessionId: '5b9ad9b0-89c5-48ca-a5b2-8e6b9bdabf3d',
    startedAt: '2026-09-14T07:00:00.000Z',
    tokensAtStop: 497_312,
    transcriptPath: '/Users/jhaa/.claude/projects/x/5b9ad9b0.jsonl',
    worktreePath: null,
    ...overrides,
  };
}

/** Nine `did` items, so the six-item cap has something to hide. */
function payload(): ThreadReportPayload {
  const raw = examplePayload();
  raw.did = Array.from({length: 9}, (_item, index) => `did item ${index + 1}`);
  const result = validateThreadReport(raw);
  if (result.status !== 'ok') throw new Error('fixture payload is invalid');
  return result.payload;
}

function render(full: boolean, overrides: Partial<ThreadFacts> = {}): string {
  return renderMarkdown(
    buildReportModel({
      askIds: ['jl-x7q.2', 'jl-x7q.3'],
      facts: facts(overrides),
      full,
      payload: payload(),
      threadId: 'jl-x7q',
    }),
  );
}

describe('the compact report', () => {
  test('drops Work product and Beads touched; --full restores them', () => {
    const compact = render(false);
    const full = render(true);
    expect(compact).not.toContain(WORK_PRODUCT_HEADING);
    expect(compact).not.toContain(BEADS_TOUCHED_HEADING);
    expect(compact).toContain(COMPACT_FOOTER);
    expect(full).toContain(WORK_PRODUCT_HEADING);
    expect(full).toContain(BEADS_TOUCHED_HEADING);
    expect(full).not.toContain(COMPACT_FOOTER);
  });

  test('caps What I did at six ITEMS and SAYS how many it hid', () => {
    const compact = render(false);
    expect(compact).toContain(`- ✅ did item ${COMPACT_DID_CAP}`);
    expect(compact).not.toContain(`- ✅ did item ${COMPACT_DID_CAP + 1}`);
    // Never a silent truncation: "+3 more on the bead" is the difference
    // between a shorter report and a report that lost three things.
    expect(compact).toContain('- (+3 more on the bead)');
    expect(render(true)).toContain('- ✅ did item 9');
    expect(render(true)).not.toContain('more on the bead');
  });

  test('caps the echoed last message, and says it was cut', () => {
    const long = 'x'.repeat(900);
    const compact = render(false, {lastUserMessage: long});
    const full = render(true, {lastUserMessage: long});
    expect(compact).toContain(`${'x'.repeat(COMPACT_LAST_MESSAGE_CAP - 1)}…`);
    expect(full).toContain('x'.repeat(900));
  });

  test('the glance line carries all four badges', () => {
    const line = render(false).split('\n')[2] ?? '';
    expect(line).toContain('✅ Work completed');
    expect(line).toContain('🙋 needs your answers');
    expect(line).toContain('📈 70%');
    expect(line).toContain('🛑 1 P0 ask');
  });

  test('a report with no P0 says so rather than leaving the badge off', () => {
    const raw = examplePayload();
    (raw.asks as Record<string, unknown>[]).forEach((ask) => {
      ask.priority = 3;
    });
    const result = validateThreadReport(raw);
    if (result.status !== 'ok') throw new Error('unreachable');
    const text = renderMarkdown(
      buildReportModel({
        askIds: ['jl-x7q.2', 'jl-x7q.3'],
        facts: facts(),
        payload: result.payload,
        threadId: 'jl-x7q',
      }),
    );
    expect(text.split('\n')[2]).toContain('no P0 asks');
  });

  test('Deviations sits between Answers and Asks, and renders none when empty', () => {
    const text = render(false);
    expect(text.indexOf('**Deviations from what you asked for:**')).toBeGreaterThan(
      text.indexOf('**Answers to your questions:**'),
    );
    expect(text.indexOf('**Deviations from what you asked for:**')).toBeLessThan(
      text.indexOf('**Asks — everything I need from you:**'),
    );

    const raw = examplePayload();
    raw.deviations = [];
    const result = validateThreadReport(raw);
    if (result.status !== 'ok') throw new Error('unreachable');
    const empty = renderMarkdown(
      buildReportModel({
        askIds: ['jl-x7q.2', 'jl-x7q.3'],
        facts: facts(),
        payload: result.payload,
        threadId: 'jl-x7q',
      }),
    );
    // "none" is a CLAIM that the work matched the spec. An omitted section
    // would let a report simply not mention that it went somewhere else.
    expect(empty).toContain('**Deviations from what you asked for:**\n- none');
  });

  test('compacting the STORED report gives byte-for-byte the compact rendering', () => {
    // `thread show` has the stored text and no payload, so it compacts rather
    // than re-renders. This is the pin that stops the two definitions of
    // "compact" from drifting apart.
    expect(compactStoredReport(render(true))).toBe(render(false));
  });

  test('compacting is idempotent — showing a compact report twice is stable', () => {
    const compact = render(false);
    expect(compactStoredReport(compact)).toBe(compact);
  });
});
