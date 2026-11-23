/**
 * home-base-g22jt.7 item 5: Part 1's "🔎 Code review findings" section, from a
 * fixture review-gate ledger under a temporary XDG_DATA_HOME. Negative
 * controls: home-base `bun run test:review-gate:controls` (the g22jt.7 ones).
 */

import type {ReviewLine} from '../src/review-ledger';
import type {PartField, PartOneView} from '../src/thread/part-one';
import type {CodeReviewsLoad} from '../src/thread/review-findings';

import {afterAll, describe, expect, test} from 'bun:test';
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {PLAIN_STYLE} from '../src/cli-style';
import {LEDGER_SCHEMA} from '../src/review-ledger';
import {renderPartOne} from '../src/thread/part-one';
import {
  CODE_REVIEWS_HEADING,
  codeReviewsShown,
  loadCodeReviews,
  markdownCodeReviews,
  reviewMarks,
} from '../src/thread/review-findings';

const SESSION = 'aaaaaaaa-1111-2222-3333-444444444444';
const EARLIER = 'bbbbbbbb-1111-2222-3333-444444444444';
const OTHER = 'cccccccc-1111-2222-3333-444444444444';
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, {force: true, recursive: true});
});

function home(): {env: Record<string, string>; ledger: string} {
  const root = mkdtempSync(join(tmpdir(), 'review-findings-'));
  roots.push(root);
  const dir = join(root, 'data', 'review-gate');
  mkdirSync(dir, {recursive: true});
  return {
    env: {HOME: join(root, 'home'), XDG_DATA_HOME: join(root, 'data')},
    ledger: join(dir, 'reviews.jsonl'),
  };
}

function review(id: string, sessionId: string): ReviewLine {
  const cost = {
    method: null,
    reason: null,
    requests: 1,
    tokens: null,
    totalCostUsd: 0.66,
    usd: 0.6586,
  };
  return {
    baseSha: 'b',
    branch: 'smoke-planted',
    buildCost: {...cost, sessionId, since: null, usd: 3.5},
    commits: ['c1'],
    effort: 'medium',
    endedAt: '2026-11-21T09:30:00.000Z',
    error: null,
    findings: [
      {
        category: 'bug',
        failureScenario: 'page 3 of 3 clamps to 4',
        file: 'src/pager.ts',
        line: 13,
        reason: 'last + 1 is past the last page',
        reportedBy: ['bug-diff'],
        shortSummary: 'clampPage returns last + 1',
        summary: 'clampPage returns last + 1',
        verdict: 'CONFIRMED',
      },
      {
        category: 'claude-md',
        failureScenario: null,
        file: 'src/pager.ts',
        line: 19,
        reason: 'the rule says null, never an empty string',
        shortSummary: null,
        summary: "findUserUri returns '' for absent",
        verdict: 'CONFIRMED',
      },
    ],
    headSha: 'h',
    id,
    kind: 'review',
    modelAsked: 'sonnet',
    modelsSeen: ['claude-sonnet-5-5'],
    passes: 'two',
    patchIds: ['p1'],
    rejectedFindings: [
      {
        file: 'src/pager.ts',
        line: 3,
        reason: 'the input is always positive',
        summary: 'possible negative height',
      },
    ],
    repo: '/repo',
    reviewCost: cost,
    reviewSessionId: null,
    reviewer: {name: 'recipe', version: 'recipe 1'},
    schema: LEDGER_SCHEMA,
    startedAt: '2026-11-21T09:29:47.000Z',
    status: 'ok',
    transcripts: [],
  };
}

function outcome(reviewId: string, finding: number, note: string): object {
  return {
    action: 'fixed',
    at: '2026-11-21T10:00:00.000Z',
    bead: null,
    by: SESSION,
    commit: 'abcdef1234567890',
    finding,
    id: `o-${String(finding)}-${note}`,
    kind: 'outcome',
    note,
    real: 'yes',
    reviewId,
    schema: LEDGER_SCHEMA,
  };
}

function write(path: string, lines: readonly (object | string)[]): void {
  writeFileSync(
    path,
    lines
      .map((l) => (typeof l === 'string' ? l : JSON.stringify(l)))
      .join('\n')
      .concat('\n'),
  );
}

const when = (at: Date): string => at.toISOString();

function field(label: string, value: string): PartField {
  return {label, sub: [], value: [value]};
}

const VIEW: PartOneView = {
  beadProblems: [],
  deltaProblem: null,
  git: [field('Repo', 'home-base'), field('Branch', 'worktree-review-gate')],
  messages: [{label: 'Your first message', note: null, quote: '"go"'}],
  progress: 'No requests filed.',
  questionIdNotes: [],
  questionIds: new Map(),
  questionShown: new Map(),
  questions: [],
  questionsNote: null,
  requests: [],
  resume: [field('Resume', 'claude --resume 0000')],
  session: field('Session', '[HOME] Review findings'),
  snapshot: {},
  state: [field('Status', '🏃 Working')],
  times: [field('Started', 'Sat 2026-11-21 9:00 am')],
};

function rendered(load: CodeReviewsLoad, found?: Record<string, string>) {
  const shown = codeReviewsShown(load, {
    baseline:
      found == null
        ? null
        : ({
            kind: 'found',
            snapshot: {at: '2026-11-21T10:00:00.000Z', items: found},
          } as never),
    when,
  });
  return {
    markdown: renderPartOne({...VIEW, codeReviews: shown.view}, PLAIN_STYLE),
    shown,
  };
}

describe('loadCodeReviews', () => {
  test('a missing ledger directory is no section; a ledger with no review of this session is none too', async () => {
    const h = home();
    rmSync(join(h.env.XDG_DATA_HOME ?? '', 'review-gate'), {recursive: true});
    expect(
      await loadCodeReviews({
        env: h.env,
        predecessors: null,
        sessionId: SESSION,
      }),
    ).toEqual({kind: 'none'});
    const h2 = home();
    write(h2.ledger, [review('r-other', OTHER)]);
    expect(
      await loadCodeReviews({
        env: h2.env,
        predecessors: null,
        sessionId: SESSION,
      }),
    ).toEqual({kind: 'none'});
  });

  test('a ledger that cannot be read at all, or a module that throws, is failed, never thrown', async () => {
    const h = home();
    mkdirSync(h.ledger); // reading a directory fails with EISDIR
    const isDir = await loadCodeReviews({
      env: h.env,
      predecessors: null,
      sessionId: SESSION,
    });
    expect(isDir.kind).toBe('failed');
    const h2 = home();
    write(h2.ledger, [review('r1', SESSION)]);
    chmodSync(h2.ledger, 0o000);
    const denied = await loadCodeReviews({
      env: h2.env,
      predecessors: null,
      sessionId: SESSION,
    });
    chmodSync(h2.ledger, 0o644);
    expect(denied.kind).toBe('failed');
    const crashed = await loadCodeReviews({
      env: h2.env,
      loadLedger: () => Promise.reject(new Error('boom')),
      predecessors: null,
      sessionId: SESSION,
    });
    expect(crashed).toEqual({kind: 'failed', reason: 'boom'});
  });
});

describe('Part 1 "Code review findings" section', () => {
  test('every finding is its own item with summary, place, verdict, reason and outcome; a rejected one reads "real: no (verifier)"', async () => {
    const h = home();
    write(h.ledger, [
      review('r1-0000-aaaa', SESSION),
      outcome('r1-0000-aaaa', 2, 'returns null now'),
    ]);
    const load = await loadCodeReviews({
      env: h.env,
      predecessors: null,
      sessionId: SESSION,
    });
    const {markdown, shown} = rendered(load);
    expect(markdown).toContain(`## 🔎 ${CODE_REVIEWS_HEADING}`);
    expect(markdown).toContain('**Review r1-0000- of smoke-planted**');
    expect(markdown).toContain('- **Model:** sonnet (seen: claude-sonnet-5-5)');
    expect(markdown).toContain(
      '- **Cost:** $0.66 for the review, $3.50 for the build',
    );
    expect(markdown).toContain('1. **clampPage returns last + 1**');
    expect(markdown).toContain('   - **Where:** src/pager.ts:13');
    expect(markdown).toContain('   - **Verdict:** CONFIRMED');
    expect(markdown).toContain(
      '   - **Reason:** last + 1 is past the last page',
    );
    expect(markdown).toContain('   - **Outcome:** none recorded');
    expect(markdown).toContain(
      '   - **Outcome:** real: yes, action: fixed: returns null now (commit abcdef123456)',
    );
    expect(markdown).toContain('3. **possible negative height**');
    expect(markdown).toContain('   - **Outcome:** real: no (verifier)');
    // The block's spacing: two empty lines between sibling findings.
    expect(markdown).toContain('   - **Outcome:** none recorded\n\n\n2. **');
    // What to mark: only the confirmed finding with no outcome.
    expect(reviewMarks(shown.view)).toEqual([
      {
        code: 'review-gate outcome r1-0000-aaaa 1 --real yes|no|unknown --action fixed|wont-fix|deferred|none --note "<what became of it>"',
        sub: [],
        text: 'Record what became of confirmed finding 1 of the review of smoke-planted (clampPage returns last + 1):',
      },
    ]);
  });

  test('a review shown before, unchanged, with every finding resolved collapses to one line; while one lacks an outcome it stays whole', async () => {
    const h = home();
    write(h.ledger, [
      review('r2-0000-bbbb', SESSION),
      outcome('r2-0000-bbbb', 1, 'clamped'),
      outcome('r2-0000-bbbb', 2, 'null now'),
    ]);
    const load = await loadCodeReviews({
      env: h.env,
      predecessors: null,
      sessionId: SESSION,
    });
    const first = rendered(load, {});
    // New since the last report: whole, marked 🆕.
    expect(first.markdown).toContain('**Review r2-0000- 🆕 of smoke-planted**');
    const again = rendered(load, first.shown.snapshot);
    expect(again.markdown).toContain(
      'Review r2-0000- of smoke-planted: every finding has an outcome. `review-gate show r2-0000-`',
    );
    expect(again.markdown).not.toContain('clampPage');
    expect(reviewMarks(again.shown.view)).toEqual([]);

    const h2 = home();
    write(h2.ledger, [review('r3-0000-cccc', SESSION)]);
    const open = await loadCodeReviews({
      env: h2.env,
      predecessors: null,
      sessionId: SESSION,
    });
    const seen = rendered(open, {});
    const unresolved = rendered(open, seen.shown.snapshot);
    expect(unresolved.markdown).toContain('1. **clampPage returns last + 1**');
  });

  test('an unreadable ledger line is reported in the section, never hidden', async () => {
    const h = home();
    write(h.ledger, [
      review('r4-0000-dddd', SESSION),
      '{"kind": "review", "trunc',
    ]);
    const load = await loadCodeReviews({
      env: h.env,
      predecessors: null,
      sessionId: SESSION,
    });
    const {markdown} = rendered(load);
    expect(markdown).toContain(
      'ledger line(s) could not be read and are not counted',
    );
    expect(markdown).toContain(`${h.ledger}:2:`);
    // A line naming this session that does not parse shows the section alone.
    const h2 = home();
    appendFileSync(
      h2.ledger,
      `{"buildCost": {"sessionId": "${SESSION}"}, "x\n`,
    );
    const only = await loadCodeReviews({
      env: h2.env,
      predecessors: null,
      sessionId: SESSION,
    });
    expect(only.kind).toBe('read');
    expect(rendered(only).markdown).toContain('could not be read');
  });

  test('a ledger that cannot be read prints ONE line in the section and leaves the rest of the block exactly as without the section', () => {
    const without = renderPartOne(VIEW, PLAIN_STYLE);
    const shown = codeReviewsShown(
      {kind: 'failed', reason: 'EACCES: permission denied'},
      {baseline: null, when},
    );
    const withFailure = renderPartOne(
      {...VIEW, codeReviews: shown.view},
      PLAIN_STYLE,
    );
    const section = markdownCodeReviews(shown.view);
    expect(section.split('\n').filter((l) => l !== '')).toEqual([
      `## 🔎 ${CODE_REVIEWS_HEADING}`,
      "*⚠️ The review-gate ledger could not be read, so any findings of this session's reviews are not shown: EACCES: permission denied*",
    ]);
    expect(withFailure.replace(`${section}\n\n---\n\n`, '')).toBe(without);
    expect(reviewMarks(shown.view)).toEqual([]);
    expect(shown.snapshot).toEqual({});
  });

  test('a successor shows its predecessors’ unresolved reviews and leaves out the resolved ones', async () => {
    const h = home();
    write(h.ledger, [
      review('r5-0000-eeee', EARLIER),
      review('r6-0000-ffff', EARLIER),
      outcome('r6-0000-ffff', 1, 'a'),
      outcome('r6-0000-ffff', 2, 'b'),
      review('r7-0000-gggg', OTHER),
    ]);
    let walked = 0;
    const load = await loadCodeReviews({
      env: h.env,
      predecessors: () => {
        walked += 1;
        return Promise.resolve({ids: [EARLIER], kind: 'ids'});
      },
      sessionId: SESSION,
    });
    expect(walked).toBe(1);
    const {markdown} = rendered(load);
    expect(markdown).toContain(
      '**Review r5-0000- of smoke-planted, from a session this one continues**',
    );
    expect(markdown).not.toContain('r6-0000-');
    expect(markdown).not.toContain('r7-0000-');
  });
});
