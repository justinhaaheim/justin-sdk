/**
 * ONE FIXTURE, THREE MEDIA (home-base-p1uj.14, D14).
 *
 * The same report rendered as markdown, ansi and html, each with a snapshot, so
 * a change in any one of them is a reviewable diff rather than something that
 * turns up in Justin's terminal. The named assertions under the snapshots pin
 * the properties each medium exists FOR: the markdown must carry no escape
 * codes (Claude Code renders neither colour nor underline, so one would arrive
 * in Justin's message as literal text); the ansi must carry bold+underline field
 * names and colour by priority; the html must be escaped and must mark a P0.
 *
 * The last block is the one that matters most: NO SURFACE MAY LETTER AN ASK.
 * Asks are one numbered sequence and letters belong to options — Justin said the
 * collision was one of the things that made the old format unanswerable.
 */

import type {BdIssue} from '../src/thread/bd';
import type {ThreadFacts} from '../src/thread/facts';
import type {ReportModel} from '../src/thread/report-model';
import type {ThreadReportPayload} from '../src/thread/schema';

import {describe, expect, test} from 'bun:test';

import {askViewOf, orderAsks} from '../src/thread/answer';
import {renderAnswerPage} from '../src/thread/answer-page';
import {renderAnsi} from '../src/thread/render-ansi';
import {renderHtml} from '../src/thread/render-html';
import {renderMarkdown} from '../src/thread/render-markdown';
import {classifyReport} from '../src/thread/report-lines';
import {buildReportModel} from '../src/thread/report-model';
import {validateThreadReport} from '../src/thread/schema';
import {examplePayload} from './thread-schema.test';

const ESC = '\u001b[';
// cli-style emits one combined SGR sequence per styled piece (k0b8n.10).
const BOLD_UNDERLINE = `${ESC}1;4m`;
const BOLD_ACCENT = `${ESC}1;35m`;
const BOLD_RED = `${ESC}1;31m`;
const RED = `${ESC}31m`;
const DIM = `${ESC}2m`;
const RESET = `${ESC}0m`;

/** A line with its layout indentation removed, escapes kept. */
function unindented(line: string | undefined): string {
  return (line ?? '').trimStart();
}

const FACTS: ThreadFacts = {
  aheadBehind: {ahead: 2, behind: 0},
  autofillFailures: [],
  branch: 'thread-v2',
  cwd: '/Users/jhaa/Dev/home-base/projects/justin-sdk',
  dirty: false,
  entrypoint: 'cli',
  firstUserMessage: 'kick this off',
  firstUserMessageAt: null,
  headSha: '288f3912eed5d51ede9f',
  isWorktree: false,
  lastAssistantMessage: 'Done — here is the report.',
  lastAssistantMessageAt: null,
  lastUserMessage: 'build the format v2 dispatch',
  lastUserMessageAt: null,
  model: 'claude-opus-5',
  repo: 'home-base',
  repoPath: '/Users/jhaa/Dev/home-base',
  reportedAt: '2026-09-14T09:00:00.000Z',
  resumeCommand: "cd '/repo' && claude --resume session-1",
  sessionId: '0afafc56-cf96-47cd-85bb-92a5e6e56da6',
  startedAt: '2026-09-14T07:00:00.000Z',
  tokensAtStop: 497_312,
  transcriptPath: '/Users/jhaa/.claude/projects/x/0afafc56.jsonl',
  worktreePath: null,
};

const ASK_IDS = ['th-eru.1', 'th-eru.2'];

function payload(): ThreadReportPayload {
  const raw = examplePayload();
  // One deviation of each kind, so the snapshots show what a MISTAKE looks like
  // in each medium (D23) — it is the only one that reaches the compact report,
  // and "unmistakable" is a claim only a baseline can hold.
  raw.deviations = [
    {kind: 'mistake', text: 'I let the bin symlink point at a dirty branch'},
    ...(raw.deviations as unknown[]),
  ];
  const result = validateThreadReport(raw);
  if (result.status !== 'ok') throw new Error('fixture payload is invalid');
  return result.payload;
}

/**
 * The restated text of the ask this report closes (F1, home-base-p1uj.18).
 *
 * In production report.ts builds this from the ask beads it already fetched.
 * Here it is pinned, so the snapshots show what a closed prior-ask line looks
 * like when the phrase IS available — the whole point of F1 is that the line
 * must never be a bare `jl-x7q.1`.
 */
const PRIOR_RESTATED = new Map([
  [
    'jl-x7q.1',
    '[Approve Y/n] Close ask beads when they are answered rather than deleting them?\n\nContext: the walk currently leaves them open.',
  ],
]);

function model(
  overrides: {
    emojiHeader?: boolean;
    full?: boolean;
    wrapUpAt?: number | null;
  } = {},
): ReportModel {
  return buildReportModel({
    askIds: ASK_IDS,
    facts: FACTS,
    payload: payload(),
    priorAskRestated: PRIOR_RESTATED,
    threadId: 'th-eru',
    ...overrides,
  });
}

const MARKDOWN = renderMarkdown(model());
const ANSI = renderAnsi(model(), {color: true});
const HTML = renderHtml(model());

// …and the same fixture in full. SIX baselines, not three (D23): compact and
// full are now different documents rather than the same one minus two sections,
// and a change to either has to be visible as a diff somebody approved.
const MARKDOWN_FULL = renderMarkdown(model({full: true}));
const ANSI_FULL = renderAnsi(model({full: true}), {color: true});
const HTML_FULL = renderHtml(model({full: true}));

describe('one fixture, three media', () => {
  test('markdown baseline — compact', () => {
    expect(MARKDOWN).toMatchSnapshot();
  });

  test('markdown baseline — full', () => {
    expect(MARKDOWN_FULL).toMatchSnapshot();
  });

  test('ansi baseline — compact', () => {
    expect(ANSI).toMatchSnapshot();
  });

  test('ansi baseline — full', () => {
    expect(ANSI_FULL).toMatchSnapshot();
  });

  test('html baseline — compact', () => {
    expect(HTML).toMatchSnapshot();
  });

  test('html baseline — full', () => {
    expect(HTML_FULL).toMatchSnapshot();
  });

  test('a MISTAKE is unmistakable in every medium (D23)', () => {
    const text = 'I let the bin symlink point at a dirty branch';
    // Markdown: the marker the compactor keys on, in the compact report.
    expect(MARKDOWN).toContain(`- ⚠️ MISTAKE — ${text}`);
    // ANSI: the same weight as a P0 ask — bold red, not a dim bullet.
    const mistakeLine = ANSI.split('\n').find((line) => line.includes(text));
    expect(unindented(mistakeLine).startsWith(BOLD_RED)).toBe(true);
    // HTML: its own class, so the answer page can make it loud.
    expect(HTML).toContain('<p class="mistake">');
    // And the quieter kinds do NOT reach the compact report at all.
    expect(MARKDOWN).not.toContain('Judgment call');
    expect(MARKDOWN_FULL).toContain('⚖️ Judgment call — ');
  });

  test('the pointer line is dim in ansi and classed in html', () => {
    const pointer = ANSI.split('\n').find((line) => line.includes('📎 '));
    expect(unindented(pointer).startsWith(DIM)).toBe(true);
    expect(HTML).toContain('<p class="pointer">');
  });

  test('markdown has NO escape codes and a blank line between every line of the header', () => {
    expect(MARKDOWN.includes(ESC)).toBe(false);
    const lines = MARKDOWN.split('\n');
    // rule · blank · glance · blank · where · blank · tree · blank · thread… (K11 rule 1)
    expect(lines[1]).toBe('');
    expect(lines[2]?.startsWith('⚡ ')).toBe(true);
    expect(lines[3]).toBe('');
    expect(lines[4]?.startsWith('📦 ')).toBe(true);
    expect(lines[5]).toBe('');
    expect(lines[6]?.startsWith('🌲 ')).toBe(true);
    expect(lines[7]).toBe('');
    expect(lines[8]?.startsWith('**Thread:**')).toBe(true);
  });

  test('ansi bolds and UNDERLINES field names; headings are bold accent with their emoji', () => {
    expect(ANSI).toContain(`${BOLD_UNDERLINE}Thread:${RESET} `);
    expect(ANSI_FULL).toContain(`  ${BOLD_ACCENT}✅ What I did${RESET}`);
  });

  test('ansi colours a P0 bold red and dims a P3, detail lines included', () => {
    // FULL, because a P3 no longer reaches the compact report at all — which is
    // itself the point of D23, and is asserted in thread-render-compact.
    const lines = ANSI_FULL.split('\n');
    const p0Index = lines.findIndex((line) => line.includes('🛑 P0 · ['));
    expect(p0Index).toBeGreaterThan(-1);
    expect(unindented(lines[p0Index]).startsWith(BOLD_RED)).toBe(true);
    // A detail line inherits its ask's COLOUR — the context under a P0 must not
    // come out unstyled because a blank line (K11 rule 1) now separates it from
    // the ask. It is red, not bold red: bold is the ask line's own.
    expect(lines[p0Index + 1]).toBe('');
    expect(
      unindented(lines[p0Index + 2]).startsWith(`${ESC}31;1mContext:`),
    ).toBe(true);
    expect(lines[p0Index + 2]).toContain(`${RED} The adapter`);
    const p3Index = lines.findIndex((line) => line.includes('(P3) · ['));
    expect(unindented(lines[p3Index]).startsWith(DIM)).toBe(true);
    expect(unindented(lines[p3Index + 2]).startsWith(DIM)).toBe(true);
  });

  test('ansi with color:false is the markdown, byte for byte', () => {
    // The form Claude would paste. If styling ever leaked past the flag, this
    // is where it shows up rather than in Justin's message.
    expect(renderAnsi(model(), {color: false})).toBe(MARKDOWN);
  });

  test('html escapes everything and marks the P0 with a class', () => {
    expect(HTML).toContain('<p class="ask p0">');
    expect(HTML_FULL).toContain('<p class="ask p3">');
    expect(HTML_FULL).toContain('<h3>✅ What I did</h3>');
    expect(HTML.includes(ESC)).toBe(false);

    const raw = examplePayload();
    raw.title = '<script>alert("x")</script>';
    const parsed = validateThreadReport(raw);
    if (parsed.status !== 'ok') throw new Error('unreachable');
    const escaped = renderHtml(
      buildReportModel({
        askIds: ASK_IDS,
        facts: FACTS,
        payload: parsed.payload,
        threadId: 'th-eru',
      }),
    );
    expect(escaped).not.toContain('<script>');
    expect(escaped).toContain('&lt;script&gt;');
  });

  test('every line of the rendering is RECOGNISED, not silently passed through', () => {
    // The ansi and html renderers style what the classifier understands. A line
    // shape it does not know would render unstyled and nothing would say so —
    // so the unknown bucket is asserted empty rather than assumed empty.
    const unknown = classifyReport(MARKDOWN).filter(
      (line) => line.kind === 'text',
    );
    expect(unknown.map((line) => line.text)).toEqual([]);
  });
});

describe('the emoji header knob and the wrap-up threshold (D19)', () => {
  test('emojiHeader true is emoji-prefixed values; false is titled fields', () => {
    expect(MARKDOWN).toContain(
      '📦 home-base · 🌿 thread-v2 · 🌳 primary checkout',
    );
    const titled = renderMarkdown(model({emojiHeader: false}));
    expect(titled).toContain('**Repo:** home-base · **Branch:** thread-v2');
    expect(titled).toContain('**Tokens at stop:** 497,312 tokens of context');
    expect(titled).not.toContain('📦 home-base');
  });

  test('tokens render as "497k / 470k" when a wrapUpAt is configured', () => {
    expect(MARKDOWN).toContain('🔢 497k');
    expect(MARKDOWN).not.toContain('497k /');
    expect(renderMarkdown(model({wrapUpAt: 470_000}))).toContain(
      '🔢 497k / 470k',
    );
  });

  test('no wrapUpAt prints ONE number, never a fabricated budget', () => {
    // null means "no threshold is configured", which is the common case:
    // usage-check is off in most repos and wrapUpAt defaults to null even where
    // it is on. `497k / 0k` would read as a budget that has been blown.
    const none = renderMarkdown(model({wrapUpAt: null}));
    expect(none).toContain('🔢 497k');
    expect(none).not.toContain('/ 0k');
  });
});

/**
 * THE FIVE-SURFACE NUMBERING TEST.
 *
 * Asks are ONE numbered sequence; only options are lettered. Justin named the
 * collision — questions lettered a/b while their options were also lettered
 * a/b — as one of the things that made the old format unanswerable, so this
 * asserts it on every surface that can print an ask.
 */
describe('no surface letters an ask', () => {
  /** `a. [Answer] …` — a lettered ask, which must not exist anywhere. */
  const LETTERED_ASK = /^\s*[a-z][.)]\s+\[(?:Approve|Pick|Answer|Do)/u;

  function askBead(id: string, index: number, priority: number): BdIssue {
    return {
      description: `[Answer] carried question ${index}`,
      id,
      metadata: {
        askIndex: index,
        createdAt: '2026-09-14T08:00:00.000Z',
        defaultAction: 'I take my default',
        kind: 'answer',
        optionCount: 0,
        priority,
        reportCount: 1,
        threadId: 'th-eru',
      },
      status: 'open',
      title: `carried question ${index}`,
    } as unknown as BdIssue;
  }

  const beads = [askBead('th-eru.9', 0, 0), askBead('th-eru.8', 1, 3)];

  test('markdown, ansi, html, the classic walk and the browser page all NUMBER them', () => {
    const ordered = orderAsks(beads.map(askViewOf));
    const page = renderAnswerPage({
      asks: ordered.map((ask, index) => ({
        defaultAction: ask.defaultAction,
        description: ask.description,
        draft: null,
        id: ask.id,
        kind: ask.kind,
        number: index + 1,
        optionCount: ask.optionCount,
        priority: ask.priority,
        reportCount: ask.reportCount,
        title: ask.title,
      })),
      noteDraft: null,
      noteId: '__note__',
      problems: [],
      report: MARKDOWN,
      threadId: 'th-eru',
      threadTitle: 'a thread',
      token: 'token',
    });
    // The classic walk's own header line, built exactly as `runAnswerWalk`
    // builds it (answer.ts) — the numbering is what is under test, not the
    // prompting loop.
    const walk = ordered
      .map((ask, index) => `── ${index + 1}/${ordered.length} · ${ask.id} ──`)
      .join('\n');

    for (const [surface, text] of [
      ['markdown', MARKDOWN],
      ['ansi', ANSI],
      ['html', HTML],
      ['classic walk', walk],
      ['browser page', page],
    ] as const) {
      const lettered = text
        .split('\n')
        .map((line) => Bun.stripANSI(line).replace(/<[^>]*>/gu, ''))
        .filter((line) => LETTERED_ASK.test(line));
      expect([surface, lettered]).toEqual([surface, []]);
    }

    // …and the numbers really are there, so an empty "no letters" result cannot
    // be an empty document passing by default.
    expect(MARKDOWN).toContain('  1. 🛑 P0 · [Approve Y/n]');
    expect(Bun.stripANSI(ANSI)).toContain('      1. 🛑 P0 · [Approve Y/n]');
    expect(HTML).toContain('<strong>1.</strong>');
    expect(walk).toContain('1/2 · th-eru.9');
    expect(page).toContain('th-eru.9');

    // The OPTIONS, by contrast, are lettered — so the filter above is looking
    // at a document that really does contain lettered lines.
    expect(MARKDOWN).toContain('     - a. (Recommended) Keep closing');
  });
});
