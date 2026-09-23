/**
 * `thread board` — grouping, ordering and age (home-base-p1uj.2).
 *
 * Fixtures of `bd list --json` output, because the board's whole job is the
 * client-side join: two listings in, a grouped table out, with NO per-row bd
 * call. If the join is wrong the board silently under-reports what is waiting
 * for Justin, which is the failure direction that matters.
 *
 * `now` is injected everywhere so the age column is actually asserted rather
 * than asserted-around.
 */

import type {OutputStyle} from '../src/cli-style';
import type {BdIssue} from '../src/thread/bd';

import {describe, expect, test} from 'bun:test';

import {
  buildBoard,
  collectOpenAsks,
  continuedHiddenLine,
  formatAge,
  renderByRepo,
  renderOpenAsks,
  renderRecent,
  threadIdOfAsk,
} from '../src/thread/board';

const NOW = new Date('2026-09-12T12:00:00.000Z');

function thread(
  id: string,
  title: string,
  metadata: Record<string, unknown>,
): BdIssue {
  return {id, issue_type: 'thread', metadata, status: 'in_progress', title};
}

function ask(
  id: string,
  parent: string | null,
  metadata: Record<string, unknown>,
  title = 'an ask',
): BdIssue {
  return {
    id,
    issue_type: 'ask',
    metadata,
    parent,
    status: 'open',
    title,
  };
}

const THREADS: BdIssue[] = [
  thread('jl-a1', 'Thread reports read path', {
    branch: 'thread-reports',
    mergeState: 'unmerged',
    progressPercent: 70,
    repo: 'justin-sdk',
    reportedAt: '2026-09-12T10:00:00.000Z',
    stopReasonKind: 'needsYou',
  }),
  thread('jl-b2', 'Mail scan sender guide', {
    branch: 'main',
    mergeState: 'merged',
    progressPercent: 100,
    repo: 'home-base',
    reportedAt: '2026-09-10T12:00:00.000Z',
    stopReasonKind: 'completed',
  }),
  thread('jl-c3', 'Older justin-sdk work', {
    branch: 'main',
    progressPercent: 40,
    repo: 'justin-sdk',
    reportedAt: '2026-09-12T11:30:00.000Z',
    stopReasonKind: 'blocked',
  }),
];

const ASKS: BdIssue[] = [
  ask(
    'jl-a1.1',
    'jl-a1',
    {
      blocking: true,
      createdAt: '2026-09-12T10:00:00.000Z',
      threadId: 'jl-a1',
    },
    'Accept the subagent behaviour?',
  ),
  ask(
    'jl-a1.2',
    'jl-a1',
    {
      blocking: false,
      createdAt: '2026-09-12T10:00:00.000Z',
      threadId: 'jl-a1',
    },
    'Leave the knob on?',
  ),
  ask('jl-c3.1', 'jl-c3', {
    blocking: false,
    createdAt: '2026-09-12T11:30:00.000Z',
    threadId: 'jl-c3',
  }),
];

describe('formatAge', () => {
  test('renders minutes, hours and days', () => {
    expect(formatAge('2026-09-12T11:59:30.000Z', NOW)).toBe('just now');
    expect(formatAge('2026-09-12T11:30:00.000Z', NOW)).toBe('30m');
    expect(formatAge('2026-09-12T10:00:00.000Z', NOW)).toBe('2h');
    expect(formatAge('2026-09-09T12:00:00.000Z', NOW)).toBe('3d');
  });

  test('an absent or unparseable timestamp is UNKNOWN, never 0', () => {
    expect(formatAge(null, NOW)).toBe('age UNKNOWN');
    expect(formatAge('not a date', NOW)).toBe('age UNKNOWN');
  });
});

/**
 * A START-ONLY thread — `thread start` created the bead, the session has not
 * reported (p1uj.8, folded into p1uj.7 item A).
 *
 * The row used to read "age UNKNOWN ? --%", which claims to know nothing about
 * a session whose start time is sitting in `metadata.threadStartedAt`. Three of
 * these on a morning board is three rows Justin cannot rank.
 */
describe('a thread that has not reported yet (item A)', () => {
  const startOnly = thread('jl-s9', '(untitled) justin-sdk session 7f3c1e20', {
    branch: 'thread-followups',
    openAskCount: 0,
    progressPercent: null,
    repo: 'justin-sdk',
    reportCount: 0,
    reportedAt: null,
    startedAt: '2026-09-12T09:00:00.000Z',
    stopReasonKind: null,
    threadStartedAt: '2026-09-12T10:00:00.000Z',
  });

  test('its age comes from threadStartedAt, and says that is what it is', () => {
    const row = buildBoard([startOnly], [], NOW).rows[0]!;
    expect(row.age).toBe('started 2h');
    expect(row.reported).toBe(false);
    expect(row.reportedAt).toBeNull();
  });

  test('the row says "no report yet" instead of rendering unknowns', () => {
    const text = renderRecent(buildBoard([startOnly], [], NOW));
    expect(text).toContain('started 2h');
    expect(text).toContain('no report yet');
    expect(text).not.toContain('age UNKNOWN');
    expect(text).not.toContain('--%');
  });

  test('with NO start stamp either, it is honestly UNKNOWN', () => {
    const bare = thread('jl-s8', 'no stamps at all', {reportCount: 0});
    const row = buildBoard([bare], [], NOW).rows[0]!;
    expect(row.age).toBe('age UNKNOWN');
    expect(row.reported).toBe(false);
  });

  test('a REPORTED thread with a missing stamp stays a report, age unknown', () => {
    // Demoting it to "no report yet" would hide a real session's stop reason
    // behind a start-only row.
    const odd = thread('jl-s7', 'reported, stamp lost', {
      progressPercent: 40,
      reportCount: 2,
      reportedAt: null,
      stopReasonKind: 'blocked',
      threadStartedAt: '2026-09-12T10:00:00.000Z',
    });
    const row = buildBoard([odd], [], NOW).rows[0]!;
    expect(row.reported).toBe(true);
    expect(row.age).toBe('age UNKNOWN');
    expect(renderRecent(buildBoard([odd], [], NOW))).toContain('40%');
  });

  test('--recent sorts it by its START time, between two reported threads', () => {
    // 10:30 sits between jl-c3's report at 11:30 and jl-a1's at 10:00. Sorting
    // on reportedAt alone sent every start-only thread to the bottom, under
    // threads last touched days ago.
    const between = thread('jl-s6', 'started between the two', {
      repo: 'justin-sdk',
      reportCount: 0,
      reportedAt: null,
      threadStartedAt: '2026-09-12T10:30:00.000Z',
    });
    const text = renderRecent(buildBoard([...THREADS, between], ASKS, NOW));
    const order = [
      'Older justin-sdk work', // reported 11:30
      'started between the two', // started 10:30
      'Thread reports read path', // reported 10:00
      'Mail scan sender guide', // reported two days ago
    ].map((title) => text.indexOf(title));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  test('a thread with NEITHER stamp sorts last rather than first', () => {
    const bare = thread('jl-s5', 'no stamps at all', {reportCount: 0});
    const text = renderRecent(buildBoard([bare, ...THREADS], ASKS, NOW));
    expect(text.indexOf('no stamps at all')).toBeGreaterThan(
      text.indexOf('Mail scan sender guide'),
    );
  });

  test('a thread that HAS reported is untouched by any of this', () => {
    const row = buildBoard(THREADS, ASKS, NOW).rows.find(
      (entry) => entry.id === 'jl-a1',
    );
    expect(row?.age).toBe('2h');
    expect(row?.reported).toBe(true);
  });
});

describe('the ask → thread join', () => {
  test('prefers parent, falls back to metadata.threadId', () => {
    expect(threadIdOfAsk(ask('x.1', 'x', {threadId: 'other'}))).toBe('x');
    expect(threadIdOfAsk(ask('x.1', null, {threadId: 'other'}))).toBe('other');
    expect(threadIdOfAsk(ask('x.1', null, {}))).toBeNull();
  });

  test('counts open and blocking asks per thread', () => {
    const {rows} = buildBoard(THREADS, ASKS, NOW);
    const a1 = rows.find((row) => row.id === 'jl-a1');
    expect(a1?.openAsks).toBe(2);
    expect(a1?.blockingAsks).toBe(1);
    const b2 = rows.find((row) => row.id === 'jl-b2');
    expect(b2?.openAsks).toBe(0);
  });

  test('an ask whose thread is gone is kept as an ORPHAN, never dropped', () => {
    const {orphanAsks, rows} = buildBoard(
      THREADS,
      [...ASKS, ask('jl-zz.1', 'jl-zz', {blocking: true})],
      NOW,
    );
    expect(orphanAsks.map((entry) => entry.id)).toEqual(['jl-zz.1']);
    // and it is not silently attributed to some other thread
    expect(rows.reduce((sum, row) => sum + row.openAsks, 0)).toBe(3);
  });
});

/**
 * D21 — a thread another session took over is folded away, but never one that
 * still has an open ask.
 *
 * NEGATIVE CONTROL (run 2026-09-14): the filter in `buildBoard` was reduced to
 * `const rows = allRows;`. Exactly the first two tests below failed — "is hidden
 * from the default board" (the row list still held `jl-old`) and "says how many
 * it hid", which reported `Expected: "1 continued thread hidden (--all shows
 * them)" Received: null` — while "STAYS VISIBLE while an ask is still open" and
 * "--all shows it" stayed green, which is the right shape: only the hiding is
 * being proved. Restoring the filter returned all four to green.
 */
describe('a continued thread (D21)', () => {
  const continued = thread('jl-old', 'the session that handed over', {
    continuedBy: 'jl-new',
    repo: 'justin-sdk',
    reportedAt: '2026-09-12T11:30:00.000Z',
  });
  const successor = thread('jl-new', 'the session that took it on', {
    repo: 'justin-sdk',
    reportedAt: '2026-09-12T11:55:00.000Z',
  });

  test('is hidden from the default board, and its successor is not', () => {
    const data = buildBoard([continued, successor], [], NOW);
    expect(data.rows.map((row) => row.id)).toEqual(['jl-new']);
    expect(data.hiddenContinued).toBe(1);
  });

  test('says how many it hid, so fewer rows is never silent', () => {
    const data = buildBoard([continued, successor], [], NOW);
    expect(continuedHiddenLine(data.hiddenContinued)).toBe(
      '1 continued thread hidden (--all shows them)',
    );
    expect(continuedHiddenLine(0)).toBeNull();
  });

  test('STAYS VISIBLE while an ask is still open on it', () => {
    // The carry is what empties a continued thread; one that still holds an ask
    // is holding something Justin owes, and hiding it would be the reassuring
    // direction of exactly the loss this feature exists to stop.
    const data = buildBoard(
      [continued, successor],
      [ask('jl-old.4', 'jl-old', {priority: 1})],
      NOW,
    );
    expect(data.rows.map((row) => row.id)).toEqual(['jl-old', 'jl-new']);
    expect(data.hiddenContinued).toBe(0);
  });

  test('--all shows it', () => {
    const data = buildBoard([continued, successor], [], NOW, {
      includeContinued: true,
    });
    expect(data.rows.map((row) => row.id)).toEqual(['jl-old', 'jl-new']);
    expect(data.hiddenContinued).toBe(0);
  });
});

describe('views', () => {
  test('the default view groups by repo, newest thread first inside a group', () => {
    const text = renderByRepo(buildBoard(THREADS, ASKS, NOW), 'thread');
    expect(text).toContain('justin-sdk  (2 threads)');
    expect(text).toContain('home-base  (1 thread)');
    const sdk = text.indexOf('justin-sdk  (2 threads)');
    const older = text.indexOf('Older justin-sdk work');
    const readPath = text.indexOf('Thread reports read path');
    expect(older).toBeGreaterThan(sdk);
    expect(readPath).toBeGreaterThan(older); // 30m before 2h
  });

  test('a thread with no measurable repo gets its own group rather than vanishing', () => {
    const text = renderByRepo(
      buildBoard([thread('jl-d4', 'orphan', {reportedAt: null})], [], NOW),
      'thread',
    );
    expect(text).toContain('UNKNOWN repo');
    expect(text).toContain('orphan');
  });

  test('--recent is a flat list, newest report first, across repos', () => {
    const text = renderRecent(buildBoard(THREADS, ASKS, NOW));
    const positions = [
      'Older justin-sdk work',
      'Thread reports read path',
      'Mail scan sender guide',
    ].map((title) => text.indexOf(title));
    expect(positions[0]).toBeLessThan(positions[1]!);
    expect(positions[1]).toBeLessThan(positions[2]!);
  });

  test('--open-asks puts P0 first, then newest first', () => {
    const asks = collectOpenAsks(THREADS, ASKS);
    expect(asks.map((entry) => entry.id)).toEqual([
      'jl-a1.1', // P0
      'jl-c3.1', // 11:30
      'jl-a1.2', // 10:00
    ]);
    const text = renderOpenAsks(asks);
    expect(text).toContain('🛑 P0');
    expect(text).toContain('P3 · jl-c3.1');
    expect(text).toContain('justin-sdk');
    expect(text).toContain('Accept the subagent behaviour?');
  });

  test('an empty board says CHECKED rather than printing nothing', () => {
    expect(renderByRepo(buildBoard([], [], NOW), 'thread')).toContain(
      'checked, and there are none',
    );
    expect(renderOpenAsks([])).toContain('checked, and there are none');
  });
});

// ---------------------------------------------------------------------------
// K11 — the man-page layout (home-base-k0b8n.10). Justin: "I 100% need an empty
// line between every single list/bullet/ask item", headers near the edge,
// everything else indented, colour with meaning, wrapping only on a terminal.
// ---------------------------------------------------------------------------

const ESC = '\u001b[';
const COLOR: OutputStyle = {color: true, width: null};

/** The display column `needle` starts at on `line`. */
function columnOf(line: string, needle: string): number {
  const at = line.indexOf(needle);
  expect(at).toBeGreaterThanOrEqual(0);
  return Bun.stringWidth(line.slice(0, at));
}

describe('K11 layout (k0b8n.10)', () => {
  test('a blank line between every row and every repo group, and nothing stacked', () => {
    const text = renderByRepo(buildBoard(THREADS, ASKS, NOW), 'thread');
    const blocks = text.replace(/^\n+/u, '').split('\n\n');
    const headers = blocks.filter((block) => block.startsWith('  📦'));
    const rows = blocks.filter((block) => !block.startsWith('  📦'));
    expect(headers).toHaveLength(2);
    expect(rows).toHaveLength(3);
    // A row is exactly its headline and its id line — never two rows run
    // together, which is what the old board printed.
    for (const row of rows) expect(row.split('\n')).toHaveLength(2);
    expect(text).not.toMatch(/\n\n\n/u);
  });

  test('headers at column 2, rows at the body column, id and branch at the detail column', () => {
    const lines = renderByRepo(buildBoard(THREADS, ASKS, NOW), 'thread').split(
      '\n',
    );
    const header = lines.find((line) => line.includes('justin-sdk  ('));
    expect(header).toStartWith('  📦 justin-sdk');
    const headline = lines.find((line) =>
      line.includes('Thread reports read path'),
    );
    expect(headline).toMatch(/^ {6}\S/u);
    expect(lines).toContain('         jl-a1 · thread-reports');
  });

  test('plain style emits no escape byte; colour style paints what means something', () => {
    const data = buildBoard(THREADS, ASKS, NOW);
    expect(renderByRepo(data, 'thread')).not.toContain('\u001b');
    const painted = renderByRepo(data, 'thread', COLOR);
    expect(painted).toContain(`${ESC}1;35mjustin-sdk${ESC}0m`); // header: bold accent
    expect(painted).toContain(`${ESC}1;31m🛑 1/2 ask${ESC}0m`); // P0 count: bold red
    expect(painted).toContain(`${ESC}33mUNMERGED${ESC}0m`); // merge state: yellow
    expect(painted).toContain(`${ESC}2mjl-a1 · thread-reports${ESC}0m`); // ids: dim
  });

  test('every title in a view starts at the same DISPLAY column, emoji and all', () => {
    // Three kinds of row whose state columns differ in width, one of them an
    // emoji count that `padEnd` measured as two columns too narrow.
    const mixed: BdIssue[] = [
      ...THREADS,
      thread('jl-s1', 'a start-only thread', {
        repo: 'justin-sdk',
        reportCount: 0,
        threadStartedAt: '2026-09-12T11:00:00.000Z',
      }),
      thread('jl-f1', 'a backfilled session', {
        repo: 'justin-sdk',
        reportCount: 0,
        source: 'backfill',
        threadStartedAt: '2026-09-02T11:00:00.000Z',
      }),
    ];
    const lines = renderRecent(
      buildBoard(mixed, ASKS, NOW, {includeBackfilled: true}),
    ).split('\n');
    const titles = [
      'Thread reports read path',
      'Mail scan sender guide',
      'Older justin-sdk work',
      'a start-only thread',
      'a backfilled session',
    ];
    const columns = titles.map((title) =>
      columnOf(lines.find((line) => line.includes(title)) ?? '', title),
    );
    expect(new Set(columns).size).toBe(1);
  });

  test('on a terminal a long title hangs at the title column; piped it never wraps', () => {
    const long = `${'word '.repeat(60)}end`;
    const data = buildBoard(
      [
        thread('jl-w1', long, {
          progressPercent: 10,
          repo: 'justin-sdk',
          reportedAt: '2026-09-12T11:00:00.000Z',
          stopReasonKind: 'completed',
        }),
      ],
      [],
      NOW,
    );
    // Piped: the headline is ONE line, however long (critical rule 14).
    const piped = renderRecent(data).trim().split('\n');
    expect(piped).toHaveLength(2);
    // Terminal: the same row wraps, every continuation hangs at the column the
    // title started at, and no line is wider than the terminal.
    const wrapped = renderRecent(data, {color: false, width: 80})
      .split('\n')
      .filter((line) => line !== '');
    expect(wrapped.length).toBeGreaterThan(3);
    const titleColumn = columnOf(wrapped[0] ?? '', 'word');
    for (const line of wrapped.slice(1, -1)) {
      expect(line).toMatch(new RegExp(`^ {${titleColumn}}(word|end)`, 'u'));
    }
    expect(wrapped.at(-1)).toBe('         jl-w1');
    for (const line of wrapped) {
      expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
    }
  });

  test('--open-asks: a blank line between asks, the ask at the body column, its lines at the detail column', () => {
    const text = renderOpenAsks(collectOpenAsks(THREADS, ASKS));
    const blocks = text.trim().split('\n\n');
    // Three asks and the Answer line — each its own block.
    expect(blocks).toHaveLength(4);
    const first = text
      .split('\n\n')[0]
      ?.split('\n')
      .filter((l) => l !== '');
    expect(first?.[0]).toStartWith('      1. 🛑 P0 · jl-a1.1');
    expect(first?.[1]).toBe('         Accept the subagent behaviour?');
    expect(first?.[2]).toStartWith('         justin-sdk · ');
    expect(blocks.at(-1)).toStartWith('  Answer them: ');
    const painted = renderOpenAsks(collectOpenAsks(THREADS, ASKS), COLOR);
    expect(painted).toContain(`${ESC}1;31m🛑 P0${ESC}0m`);
    expect(painted).toContain(`${ESC}2m   P3${ESC}0m`);
    expect(painted).toContain(`${ESC}36mbun run justin-sdk thread answer`);
  });
});
