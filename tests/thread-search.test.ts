/**
 * `thread search` — finding the session a phrase was written in
 * (home-base-k0b8n.2, decision K8).
 *
 * Two layers, deliberately:
 *
 *  - PURE tests over `buildCorpus` / `searchCorpus` / the renderers, because
 *    every semantic the scope names (which field the snippet comes from, how
 *    rows are ordered, what `--limit` hides, what an archive-only row looks
 *    like) is a property of those functions and nothing else.
 *  - END-TO-END tests through `runThreadSearch` against the STATEFUL FAKE bd
 *    (tests/fake-bd.ts) and an archive under $TMPDIR, because the exit codes are
 *    the contract and only the whole command has them. Nothing here reads the
 *    real ~/Dev/threads or the real ~/.local/state/justin-threads.
 *
 * NEGATIVE CONTROLS are recorded on home-base-k0b8n.2's notes: each names the
 * line that was broken, the assertion that went red, and the restore.
 */

import type {BdIssue} from '../src/thread/bd';
import type {SearchResult, SearchRow} from '../src/thread/search';

import {afterEach, describe, expect, spyOn, test} from 'bun:test';
import {mkdirSync, mkdtempSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {
  buildCorpus,
  buildSnippet,
  compileQuery,
  countCorpus,
  incompleteLine,
  moreLine,
  noMatchesLine,
  readArchivedReports,
  renderSearchRow,
  runThreadSearch,
  searchCorpus,
  sessionActivityAt,
  SNIPPET_RADIUS,
  THREAD_SEARCH_FIELDS,
  withinWindow,
} from '../src/thread/search';
import {createFakeBd, type FakeBd} from './fake-bd';

const NOW = new Date('2026-09-19T12:00:00.000Z');
const DAY = 86_400_000;

const spies: {mockRestore: () => void}[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

function captureStdout(): string[] {
  const lines: string[] = [];
  spies.push(
    spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.join(' '));
    }),
  );
  return lines;
}

function captureStderr(): string[] {
  const lines: string[] = [];
  spies.push(
    spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      lines.push(args.join(' '));
    }),
  );
  return lines;
}

/** A thread bead as `bd list -t thread --all --json` hands it over. */
function thread(
  id: string,
  metadata: Record<string, unknown>,
  fields: Partial<BdIssue> = {},
): BdIssue {
  return {
    description: '',
    id,
    issue_type: 'thread',
    metadata,
    notes: '',
    status: 'open',
    title: `${id} title`,
    ...fields,
  };
}

/** The first row, or a thrown failure — never a silent `undefined` (rule 7). */
function firstRow(result: SearchResult): SearchRow {
  const row = result.rows[0];
  if (row == null) throw new Error('expected at least one matching row');
  return row;
}

/** The `--json` document, typed rather than walked as `any`. */
interface SearchJson {
  archivedReportSessionsSearched: number;
  archivedReportsSearched: number;
  complete: boolean;
  days: number | null;
  failures: string[];
  matched: number;
  query: string;
  regex: boolean;
  rows: SearchRow[];
  sessionsSearched: number;
  shown: number;
  threadsSearched: number;
}

function parseSearchJson(text: string): SearchJson {
  return JSON.parse(text) as SearchJson;
}

function pattern(query: string, regex = false): RegExp {
  const compiled = compileQuery(query, {regex});
  if (!compiled.ok)
    throw new Error(`pattern did not compile: ${compiled.error}`);
  return compiled.value;
}

// ---------------------------------------------------------------------------
// The archive on disk
// ---------------------------------------------------------------------------

interface Harness {
  archiveRoot: string;
  env: Record<string, string | undefined>;
  fake: FakeBd;
  root: string;
}

function harness(): Harness {
  const fake = createFakeBd();
  const root = mkdtempSync(join(tmpdir(), 'thread-search-'));
  const stateDir = join(root, 'state');
  const archiveRoot = join(stateDir, 'reports');
  mkdirSync(archiveRoot, {recursive: true});
  return {
    archiveRoot,
    env: {
      ...fake.env,
      JUSTIN_THREADS_REPO_DIR: fake.dir,
      JUSTIN_THREADS_STATE_DIR: stateDir,
    },
    fake,
    root,
  };
}

/** Put one archived report payload where the real archive writer would. */
function writeArchive(
  h: Harness,
  sessionId: string,
  reportedAt: string,
  document: Record<string, unknown>,
): string {
  const dir = join(h.archiveRoot, sessionId);
  mkdirSync(dir, {recursive: true});
  const path = join(dir, `${reportedAt.replace(/[:.]/g, '-')}.json`);
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
  return path;
}

function archiveDoc(
  sessionId: string,
  reportedAt: string,
  overrides: {
    facts?: Record<string, unknown>;
    payload?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  return {
    facts: {
      repo: 'home-base',
      reportedAt,
      sessionId,
      ...overrides.facts,
    },
    payload: {
      schemaVersion: 2,
      stopReason: 'the gates are green',
      title: 'a reported session',
      ...overrides.payload,
    },
    reportedAt,
    schemaVersion: 2,
    sessionId,
  };
}

function seedThreads(h: Harness, issues: BdIssue[]): void {
  const state = h.fake.read();
  h.fake.write({
    ...state,
    issues: issues.map((issue) => ({
      description: issue.description ?? '',
      id: issue.id,
      metadata: issue.metadata ?? {},
      notes: issue.notes ?? '',
      parent: null,
      status: issue.status ?? 'open',
      title: issue.title ?? '',
      type: 'thread',
    })),
  });
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

describe('the query', () => {
  test('a multi-word query is ONE phrase, not three terms', () => {
    const corpus = buildCorpus(
      [
        thread('th-1', {
          lastUserMessage: 'make threads reliably capture every session',
        }),
        thread('th-2', {lastUserMessage: 'make them reliably searchable'}),
      ],
      [],
    );
    const result = searchCorpus(corpus, pattern('make threads reliably'));
    expect(result.matched).toBe(1);
    expect(result.rows[0]?.threadId).toBe('th-1');
  });

  test('a regex metacharacter in a SUBSTRING query is a literal', () => {
    const corpus = buildCorpus(
      [
        thread('th-literal', {
          lastUserMessage: 'the bead is home-base-k0b8n.2',
        }),
        thread('th-wild', {lastUserMessage: 'home-base-k0b8nX2 is not it'}),
      ],
      [],
    );
    const result = searchCorpus(corpus, pattern('k0b8n.2'));
    expect(result.rows.map((row) => row.threadId)).toEqual(['th-literal']);
  });

  test('--regex treats the same query as a pattern', () => {
    const corpus = buildCorpus(
      [
        thread('th-literal', {
          lastUserMessage: 'the bead is home-base-k0b8n.2',
        }),
        thread('th-wild', {lastUserMessage: 'home-base-k0b8nX2 is not it'}),
      ],
      [],
    );
    const result = searchCorpus(corpus, pattern('k0b8n.2', true));
    expect(result.rows.map((row) => row.threadId).sort()).toEqual([
      'th-literal',
      'th-wild',
    ]);
  });

  test('matching is case-insensitive in BOTH modes', () => {
    const corpus = buildCorpus(
      [thread('th-1', {lastUserMessage: 'Astonishingly Difficult To Search'})],
      [],
    );
    expect(
      searchCorpus(corpus, pattern('astonishingly DIFFICULT')).matched,
    ).toBe(1);
    expect(searchCorpus(corpus, pattern('ASTONISH\\w+', true)).matched).toBe(1);
  });

  test('an invalid regex is a named failure, never an empty result', () => {
    const compiled = compileQuery('[unclosed', {regex: true});
    expect(compiled.ok).toBe(false);
    if (compiled.ok) throw new Error('unreachable');
    expect(compiled.error).toMatch(/Invalid regular expression/);
  });

  test('the same characters are NOT a failure in substring mode', () => {
    const compiled = compileQuery('[unclosed');
    expect(compiled.ok).toBe(true);
  });

  test('THE F2 ACCEPTANCE: a space in the phrase matches a NEWLINE in the message', () => {
    // Exactly the shape a dictated message has: the hard break lands where he
    // paused speaking, not where the phrase he remembers typing ends.
    const corpus = buildCorpus(
      [
        thread('th-s2t', {
          lastUserMessage:
            'the arc is to make threads reliably capture every session and make\nthem searchable',
        }),
      ],
      [],
    );
    const result = searchCorpus(corpus, pattern('make them searchable'));
    expect(result.matched).toBe(1);
    expect(firstRow(result).threadId).toBe('th-s2t');
  });

  test('any run of whitespace matches any other: two spaces, a tab, a CRLF', () => {
    const corpus = buildCorpus(
      [
        thread('th-spaces', {lastUserMessage: 'make  them searchable'}),
        thread('th-tab', {lastUserMessage: 'make\tthem searchable'}),
        thread('th-crlf', {lastUserMessage: 'make them\r\nsearchable'}),
      ],
      [],
    );
    expect(
      searchCorpus(corpus, pattern('make them searchable'))
        .rows.map((row) => row.threadId)
        .sort(),
    ).toEqual(['th-crlf', 'th-spaces', 'th-tab']);
  });

  test('loosening whitespace does NOT loosen anything else: a metacharacter is still literal', () => {
    const corpus = buildCorpus(
      [
        thread('th-literal', {lastUserMessage: 'is that what?  I wondered'}),
        thread('th-wild', {lastUserMessage: 'is that whatX I wondered'}),
      ],
      [],
    );
    expect(
      searchCorpus(corpus, pattern('what? I wondered')).rows.map(
        (row) => row.threadId,
      ),
    ).toEqual(['th-literal']);
  });

  test('a space is NOT allowed to match nothing: the words still have to be separated', () => {
    // `\s+`, never `\s*` — otherwise "make them" would match "makethem" and a
    // phrase search would quietly become a concatenation search.
    const corpus = buildCorpus(
      [thread('th-joined', {lastUserMessage: 'makethem searchable'})],
      [],
    );
    expect(searchCorpus(corpus, pattern('make them searchable')).matched).toBe(
      0,
    );
  });

  test('--regex is UNTOUCHED: there a space is whatever the pattern says', () => {
    const corpus = buildCorpus(
      [thread('th-newline', {lastUserMessage: 'make them\nsearchable'})],
      [],
    );
    // The plain phrase finds it; the same phrase as a regex, where a literal
    // space means a literal space, does not.
    expect(searchCorpus(corpus, pattern('make them searchable')).matched).toBe(
      1,
    );
    expect(
      searchCorpus(corpus, pattern('make them searchable', true)).matched,
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Snippets and field attribution
// ---------------------------------------------------------------------------

describe('the snippet', () => {
  test('keeps ±80 characters and marks each side it cut', () => {
    const text = `${'a'.repeat(200)}NEEDLE${'b'.repeat(200)}`;
    const snippet = buildSnippet(text, 200, 6);
    expect(snippet.match).toBe('NEEDLE');
    expect(snippet.before).toBe(`…${'a'.repeat(SNIPPET_RADIUS)}`);
    expect(snippet.after).toBe(`${'b'.repeat(SNIPPET_RADIUS)}…`);
  });

  test('does not claim it cut text it did not', () => {
    const snippet = buildSnippet('left NEEDLE right', 5, 6);
    expect(snippet.before).toBe('left ');
    expect(snippet.after).toBe(' right');
  });

  test('is one line: newlines in the stored message become spaces', () => {
    const snippet = buildSnippet('one\ntwo NEEDLE three\n\nfour', 8, 6);
    expect(snippet.before).toBe('one two ');
    expect(snippet.after).toBe(' three four');
  });

  test('names the FIELD it came from, and prefers the messages over the body', () => {
    const corpus = buildCorpus(
      [
        thread(
          'th-1',
          {lastUserMessage: 'go build the search command'},
          {notes: 'go build the search command, said the report'},
        ),
      ],
      [],
    );
    const result = searchCorpus(corpus, pattern('go build the search'));
    expect(result.rows[0]?.hit.field).toBe('lastUserMessage');
  });

  test('falls through the field order to notes when no message matches', () => {
    const corpus = buildCorpus(
      [
        thread(
          'th-1',
          {},
          {notes: 'the renderers are built and the gates are green'},
        ),
      ],
      [],
    );
    const result = searchCorpus(corpus, pattern('gates are green'));
    expect(result.rows[0]?.hit.field).toBe('notes');
  });

  test('the field order is the documented one', () => {
    expect([...THREAD_SEARCH_FIELDS]).toEqual([
      'title',
      'firstUserMessage',
      'lastUserMessage',
      'lastAssistantMessage',
      'notes',
      'description',
    ]);
  });
});

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

describe('the corpus', () => {
  test('an archived report whose session HAS a thread is that thread’s row', () => {
    const corpus = buildCorpus(
      [thread('th-1', {repo: 'home-base', sessionId: 'sess-1'})],
      [
        {
          document: archiveDoc('sess-1', '2026-09-14T01:00:00.000Z', {
            payload: {stopReason: 'the waveform never rendered'},
          }),
          path: '/archive/sess-1/a.json',
          repo: 'home-base',
          reportedAt: '2026-09-14T01:00:00.000Z',
          resumeCommand: null,
          sessionId: 'sess-1',
          title: 'a reported session',
        },
      ],
    );
    expect(corpus).toHaveLength(1);
    const result = searchCorpus(corpus, pattern('waveform never rendered'));
    expect(result.matched).toBe(1);
    expect(result.rows[0]?.threadId).toBe('th-1');
    expect(result.rows[0]?.hit.field).toBe(
      'archived report 2026-09-14T01:00:00.000Z · payload.stopReason',
    );
  });

  test('an archived report with NO thread bead gets its own row', () => {
    const corpus = buildCorpus(
      [],
      [
        {
          document: archiveDoc('lost-1', '2026-09-14T01:00:00.000Z'),
          path: '/archive/lost-1/a.json',
          repo: 'home-base',
          reportedAt: '2026-09-14T01:00:00.000Z',
          resumeCommand: null,
          sessionId: 'lost-1',
          title: 'a reported session',
        },
      ],
    );
    const result = searchCorpus(corpus, pattern('gates are green'));
    expect(result.rows[0]?.threadId).toBe(null);
    expect(result.rows[0]?.sessionId).toBe('lost-1');
    expect(result.rows[0]?.title).toBe('a reported session');
    expect(result.rows[0]?.repo).toBe('home-base');
  });

  test('counts say what was searched: sessions, threads, archived reports', () => {
    const corpus = buildCorpus(
      [
        thread('th-1', {sessionId: 'sess-1'}),
        thread('th-2', {sessionId: 'sess-2'}),
      ],
      [
        {
          document: archiveDoc('sess-1', '2026-09-14T01:00:00.000Z'),
          path: '/a/1.json',
          repo: null,
          reportedAt: '2026-09-14T01:00:00.000Z',
          resumeCommand: null,
          sessionId: 'sess-1',
          title: null,
        },
        {
          document: archiveDoc('lost-1', '2026-09-13T01:00:00.000Z'),
          path: '/a/2.json',
          repo: null,
          reportedAt: '2026-09-13T01:00:00.000Z',
          resumeCommand: null,
          sessionId: 'lost-1',
          title: null,
        },
      ],
    );
    expect(countCorpus(corpus)).toEqual({
      archivedReportSessions: 2,
      archivedReports: 2,
      messageLogs: 0,
      sessions: 3,
      threads: 2,
    });
  });

  test('THE F3 ACCEPTANCE: two reports under ONE session are 2 reports across 1 session', () => {
    const corpus = buildCorpus(
      [thread('th-1', {sessionId: 'sess-1'})],
      [
        {
          document: archiveDoc('sess-1', '2026-09-14T01:00:00.000Z'),
          path: '/a/1.json',
          repo: null,
          reportedAt: '2026-09-14T01:00:00.000Z',
          resumeCommand: null,
          sessionId: 'sess-1',
          title: null,
        },
        {
          document: archiveDoc('sess-1', '2026-09-14T02:00:00.000Z'),
          path: '/a/2.json',
          repo: null,
          reportedAt: '2026-09-14T02:00:00.000Z',
          resumeCommand: null,
          sessionId: 'sess-1',
          title: null,
        },
      ],
    );
    const counts = countCorpus(corpus);
    // A session reports as often as it likes: the two numbers are different
    // facts, and the file count alone reads as a number of conversations.
    expect(counts.archivedReports).toBe(2);
    expect(counts.archivedReportSessions).toBe(1);
    expect(noMatchesLine(counts)).toContain(
      '2 archived reports across 1 session',
    );
  });

  test('a CLOSED thread is still searched — the finished session is the point', () => {
    const corpus = buildCorpus(
      [
        thread(
          'th-closed',
          {lastUserMessage: 'ship the nature sounds release'},
          {status: 'closed'},
        ),
      ],
      [],
    );
    expect(searchCorpus(corpus, pattern('nature sounds')).matched).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Ordering, the window, the limit
// ---------------------------------------------------------------------------

describe('ordering and limits', () => {
  test('last activity decides the order, newest first', () => {
    const corpus = buildCorpus(
      [
        thread('th-old', {
          lastActivityAt: '2026-09-01T00:00:00.000Z',
          lastUserMessage: 'needle',
        }),
        thread('th-new', {
          lastActivityAt: '2026-09-18T00:00:00.000Z',
          lastUserMessage: 'needle',
        }),
        thread('th-mid', {
          lastActivityAt: '2026-09-10T00:00:00.000Z',
          lastUserMessage: 'needle',
        }),
      ],
      [],
    );
    const result = searchCorpus(corpus, pattern('needle'));
    expect(result.rows.map((row) => row.threadId)).toEqual([
      'th-new',
      'th-mid',
      'th-old',
    ]);
  });

  test('reportedAt and startedAt are the fallbacks, newest of the three wins', () => {
    expect(
      sessionActivityAt({
        reportedAt: '2026-09-18T00:00:00.000Z',
        startedAt: '2026-09-01T00:00:00.000Z',
      }),
    ).toBe('2026-09-18T00:00:00.000Z');
    expect(sessionActivityAt({startedAt: '2026-09-01T00:00:00.000Z'})).toBe(
      '2026-09-01T00:00:00.000Z',
    );
    expect(sessionActivityAt({})).toBe(null);
  });

  test('an UNDATED row sorts last rather than pretending to be newest', () => {
    const corpus = buildCorpus(
      [
        thread('th-undated', {lastUserMessage: 'needle'}),
        thread('th-dated', {
          lastActivityAt: '2026-09-01T00:00:00.000Z',
          lastUserMessage: 'needle',
        }),
      ],
      [],
    );
    expect(
      searchCorpus(corpus, pattern('needle')).rows.map((row) => row.threadId),
    ).toEqual(['th-dated', 'th-undated']);
  });

  test('--limit cuts the list and the count says how many it hid', () => {
    const corpus = buildCorpus(
      [0, 1, 2, 3, 4].map((index) =>
        thread(`th-${index}`, {
          lastActivityAt: `2026-09-1${index}T00:00:00.000Z`,
          lastUserMessage: 'needle',
        }),
      ),
      [],
    );
    const result = searchCorpus(corpus, pattern('needle'), {limit: 2});
    expect(result.matched).toBe(5);
    expect(result.rows).toHaveLength(2);
    expect(moreLine(result)).toBe('3 more (--limit)');
  });

  test('--limit 0 prints everything and says nothing about more', () => {
    const corpus = buildCorpus(
      [0, 1, 2].map((index) =>
        thread(`th-${index}`, {lastUserMessage: 'needle'}),
      ),
      [],
    );
    const result = searchCorpus(corpus, pattern('needle'), {limit: 0});
    expect(result.rows).toHaveLength(3);
    expect(moreLine(result)).toBe(null);
  });

  test('--days drops what is outside the window', () => {
    const corpus = buildCorpus(
      [
        thread('th-recent', {
          lastActivityAt: new Date(NOW.getTime() - 2 * DAY).toISOString(),
        }),
        thread('th-ancient', {
          lastActivityAt: new Date(NOW.getTime() - 40 * DAY).toISOString(),
        }),
      ],
      [],
    );
    expect(withinWindow(corpus, 30, NOW).map((s) => s.threadId)).toEqual([
      'th-recent',
    ]);
  });

  test('--days NEVER drops a session that dates itself nowhere', () => {
    const corpus = buildCorpus([thread('th-undated', {})], []);
    expect(withinWindow(corpus, 1, NOW).map((s) => s.threadId)).toEqual([
      'th-undated',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe('rendering', () => {
  test('a row is the header, the named snippet and the resume command', () => {
    const corpus = buildCorpus(
      [
        thread('th-1', {
          lastActivityAt: new Date(NOW.getTime() - 3 * DAY).toISOString(),
          lastUserMessage: 'go build the format v2 dispatch',
          repo: 'home-base',
          resumeCommand:
            "cd '/Users/jhaa/Dev/home-base' && claude --resume sess-1",
          sessionId: 'sess-1',
        }),
      ],
      [],
    );
    const result = searchCorpus(corpus, pattern('format v2'));
    const lines = renderSearchRow(firstRow(result), NOW, {color: false}).split(
      '\n',
    );
    // K11 (k0b8n.10): the header at column 2, the snippet and the resume
    // command under it at the body column.
    expect(lines[0]).toBe('  home-base · 3d · th-1 title · sess-1');
    expect(lines[1]).toBe(
      '      lastUserMessage: go build the format v2 dispatch',
    );
    expect(lines[2]).toBe(
      "      cd '/Users/jhaa/Dev/home-base' && claude --resume sess-1",
    );
  });

  test('K11 colour: header bold, session id and field name dim, resume command cyan', () => {
    const corpus = buildCorpus(
      [
        thread('th-1', {
          lastUserMessage: 'go build the format v2 dispatch',
          repo: 'home-base',
          resumeCommand: 'claude --resume sess-1',
          sessionId: 'sess-1',
        }),
      ],
      [],
    );
    const row = firstRow(searchCorpus(corpus, pattern('format v2')));
    const painted = renderSearchRow(row, NOW, {color: true});
    expect(painted).toContain('\u001b[2msess-1\u001b[0m');
    expect(painted).toContain('\u001b[2mlastUserMessage:\u001b[0m');
    expect(painted).toContain('\u001b[36mclaude --resume sess-1\u001b[0m');
    expect(painted).toStartWith('  \u001b[1m');
  });

  test('on a terminal the snippet hangs at the body column; the resume command never wraps', () => {
    const resume = `cd '/Users/jhaa/Dev/${'deep/'.repeat(30)}repo' && claude --resume sess-1`;
    const corpus = buildCorpus(
      [
        thread('th-1', {
          lastUserMessage: `${'context words '.repeat(12)}format v2 ${'and more words '.repeat(12)}`,
          resumeCommand: resume,
          sessionId: 'sess-1',
        }),
      ],
      [],
    );
    const row = firstRow(searchCorpus(corpus, pattern('format v2')));
    const lines = renderSearchRow(row, NOW, {color: false, width: 70}).split(
      '\n',
    );
    // The snippet wrapped, each continuation at the body column…
    const snippet = lines.slice(1, -1);
    expect(snippet.length).toBeGreaterThan(1);
    for (const line of snippet) {
      expect(line).toMatch(/^ {6}\S/u);
      expect(Bun.stringWidth(line)).toBeLessThanOrEqual(70);
    }
    // …and the command is ONE line however wide, so it still pastes.
    expect(lines.at(-1)).toBe(`      ${resume}`);
    // The control: piped, nothing wraps at all.
    expect(renderSearchRow(row, NOW, {color: false}).split('\n')).toHaveLength(
      3,
    );
  });

  test('the match is bold with color on, and plain with color off', () => {
    const corpus = buildCorpus(
      [thread('th-1', {lastUserMessage: 'go build the format v2 dispatch'})],
      [],
    );
    const row = firstRow(searchCorpus(corpus, pattern('format v2')));
    expect(renderSearchRow(row, NOW, {color: true})).toContain(
      '\u001b[1mformat v2\u001b[0m',
    );
    expect(renderSearchRow(row, NOW, {color: false})).not.toContain('\u001b[');
  });

  test('THE F4 ACCEPTANCE: the snippet is the first field, and the OTHERS are named', () => {
    const corpus = buildCorpus(
      [
        thread('th-1', {
          firstUserMessage: 'go build the format v2 dispatch',
          lastAssistantMessage:
            'The format v2 renderers are built and the gates are green.',
          sessionId: 'sess-1',
        }),
      ],
      [],
    );
    const row = firstRow(searchCorpus(corpus, pattern('format v2')));
    expect(row.matchedFields).toEqual([
      'firstUserMessage',
      'lastAssistantMessage',
    ]);
    const lines = renderSearchRow(row, NOW, {color: false}).split('\n');
    // The snippet still comes from the FIRST field in THREAD_SEARCH_FIELDS
    // order; what changes is that the row no longer hides the second one.
    expect(lines[1]).toBe(
      '      firstUserMessage: go build the format v2 dispatch (+1 more field: lastAssistantMessage)',
    );
  });

  test('a SINGLE-field match prints no suffix at all', () => {
    const corpus = buildCorpus(
      [thread('th-1', {firstUserMessage: 'go build the format v2 dispatch'})],
      [],
    );
    const row = firstRow(searchCorpus(corpus, pattern('format v2')));
    expect(row.matchedFields).toEqual(['firstUserMessage']);
    expect(renderSearchRow(row, NOW, {color: false})).not.toContain(
      'more field',
    );
  });

  test('a match in an ARCHIVED report is named as another field of the same row', () => {
    const corpus = buildCorpus(
      [
        thread('th-1', {
          lastUserMessage: 'the gates are green',
          sessionId: 's1',
        }),
      ],
      [
        {
          document: archiveDoc('s1', '2026-09-14T01:00:00.000Z'),
          path: '/a/1.json',
          repo: null,
          reportedAt: '2026-09-14T01:00:00.000Z',
          resumeCommand: null,
          sessionId: 's1',
          title: null,
        },
      ],
    );
    // 'the gates are green' is both what he said and what the archived
    // payload's stopReason says — one row, two fields, and now it says so.
    const row = firstRow(searchCorpus(corpus, pattern('gates are green')));
    expect(row.hit.field).toBe('lastUserMessage');
    expect(row.matchedFields).toEqual([
      'lastUserMessage',
      'archived report 2026-09-14T01:00:00.000Z · payload.stopReason',
    ]);
  });

  test('the suffix NAMES at most three and still counts them all', () => {
    const corpus = buildCorpus(
      [
        thread(
          'th-1',
          {
            firstUserMessage: 'needle',
            lastAssistantMessage: 'needle',
            lastUserMessage: 'needle',
          },
          {description: 'needle', notes: 'needle', title: 'needle'},
        ),
      ],
      [],
    );
    const row = firstRow(searchCorpus(corpus, pattern('needle')));
    expect(row.matchedFields).toHaveLength(6);
    expect(renderSearchRow(row, NOW, {color: false})).toContain(
      '(+5 more fields: firstUserMessage, lastUserMessage, lastAssistantMessage, …)',
    );
  });

  test('what is missing SAYS it is missing rather than printing blank', () => {
    const corpus = buildCorpus(
      [thread('th-1', {lastUserMessage: 'needle'})],
      [],
    );
    const row = firstRow(searchCorpus(corpus, pattern('needle')));
    const rendered = renderSearchRow(row, NOW, {color: false});
    expect(rendered).toContain('(repo unknown)');
    expect(rendered).toContain('(no session id)');
    expect(rendered).toContain('(no resume command recorded)');
  });

  test('the zero-match line names how much was searched', () => {
    // The real shape of this machine's corpus: 48 report FILES under 26
    // sessions. Both numbers are said, so neither can be read as the other.
    expect(
      noMatchesLine({
        archivedReportSessions: 26,
        archivedReports: 48,
        messageLogs: 90,
        sessions: 141,
        threads: 137,
      }),
    ).toBe(
      'no matches in 141 sessions searched (137 threads, 48 archived reports across 26 sessions, 90 message logs)',
    );
  });

  test('the zero-match line is grammatical at ONE of each, too', () => {
    expect(
      noMatchesLine({
        archivedReportSessions: 1,
        archivedReports: 1,
        messageLogs: 1,
        sessions: 1,
        threads: 1,
      }),
    ).toContain('1 archived report across 1 session, 1 message log)');
  });
});

// ---------------------------------------------------------------------------
// The archive reader
// ---------------------------------------------------------------------------

describe('reading the archive', () => {
  test('a missing archive root is a measured NONE, not a failure', () => {
    const root = mkdtempSync(join(tmpdir(), 'thread-search-empty-'));
    const read = readArchivedReports({
      JUSTIN_THREADS_STATE_DIR: join(root, 'never-written'),
    });
    expect(read.files).toEqual([]);
    expect(read.failures).toEqual([]);
  });

  test('every report of every session is read, newest first per session', () => {
    const h = harness();
    writeArchive(h, 'sess-1', '2026-09-14T01:00:00.000Z', {
      ...archiveDoc('sess-1', '2026-09-14T01:00:00.000Z'),
    });
    writeArchive(h, 'sess-1', '2026-09-15T01:00:00.000Z', {
      ...archiveDoc('sess-1', '2026-09-15T01:00:00.000Z'),
    });
    const read = readArchivedReports(h.env);
    expect(read.failures).toEqual([]);
    expect(read.files).toHaveLength(2);
    const corpus = buildCorpus([], read.files);
    expect(corpus[0]?.archives[0]?.reportedAt).toBe('2026-09-15T01:00:00.000Z');
  });

  test('an unparseable archive is a NAMED failure, never a silently smaller corpus', () => {
    const h = harness();
    const dir = join(h.archiveRoot, 'sess-broken');
    mkdirSync(dir, {recursive: true});
    writeFileSync(join(dir, '2026-09-14T01-00-00-000Z.json'), '{not json');
    const read = readArchivedReports(h.env);
    expect(read.files).toEqual([]);
    expect(read.failures).toHaveLength(1);
    expect(read.failures[0]).toContain('sess-broken');
  });

  test('the incomplete banner refuses to let a partial answer read as whole', () => {
    expect(incompleteLine(['readdir x: EPERM'])).toContain('INCOMPLETE');
    expect(incompleteLine(['a', 'b'])).toContain('2 parts');
  });
});

// ---------------------------------------------------------------------------
// The command: exit codes and JSON
// ---------------------------------------------------------------------------

describe('runThreadSearch', () => {
  test('the bd read asks for CLOSED threads too, end to end', async () => {
    const h = harness();
    seedThreads(h, [
      thread(
        'th-closed',
        {lastUserMessage: 'ship the nature sounds release'},
        {status: 'closed'},
      ),
    ]);
    const out = captureStdout();
    captureStderr();
    const code = await runThreadSearch({
      color: false,
      env: h.env,
      json: true,
      now: NOW,
      query: 'nature sounds',
    });
    expect(code).toBe(0);
    expect(parseSearchJson(out.join('\n')).matched).toBe(1);
    // The flag itself, not only its effect: without `--all` the fake bd (like
    // the real one) filters closed rows out server-side and the corpus silently
    // shrinks to the sessions Justin has not finished — the ones he is least
    // likely to be hunting for.
    expect(h.fake.read().log.at(-1)).toContain('--all');
  });

  test('a match prints the row and exits 0', async () => {
    const h = harness();
    seedThreads(h, [
      thread('th-1', {
        lastActivityAt: NOW.toISOString(),
        lastUserMessage: 'make threads reliably capture every session',
        repo: 'home-base',
        resumeCommand:
          "cd '/Users/jhaa/Dev/home-base' && claude --resume sess-1",
        sessionId: 'sess-1',
      }),
    ]);
    const out = captureStdout();
    captureStderr();
    const code = await runThreadSearch({
      color: false,
      env: h.env,
      now: NOW,
      query: 'reliably capture every session',
    });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain(
      'home-base · just now · th-1 title · sess-1',
    );
    expect(out.join('\n')).toContain('claude --resume sess-1');
  });

  test('NO match prints the counted line and exits 1', async () => {
    const h = harness();
    seedThreads(h, [
      thread('th-1', {lastUserMessage: 'something else entirely'}),
    ]);
    writeArchive(
      h,
      'sess-9',
      '2026-09-14T01:00:00.000Z',
      archiveDoc('sess-9', '2026-09-14T01:00:00.000Z'),
    );
    const out = captureStdout();
    captureStderr();
    const code = await runThreadSearch({
      color: false,
      env: h.env,
      now: NOW,
      query: 'zzz-nothing-here-zzz',
    });
    expect(code).toBe(1);
    expect(out).toContain(
      'no matches in 2 sessions searched (1 threads, 1 archived report across 1 session, 0 message logs)',
    );
  });

  test('an invalid regex exits 2 before reading anything', async () => {
    const h = harness();
    seedThreads(h, [thread('th-1', {lastUserMessage: 'anything'})]);
    captureStdout();
    const err = captureStderr();
    const code = await runThreadSearch({
      color: false,
      env: h.env,
      now: NOW,
      query: '[unclosed',
      regex: true,
    });
    expect(code).toBe(2);
    expect(err.join('\n')).toContain('invalid regex');
    // Nothing was read, so nothing was logged as a bd command.
    expect(h.fake.read().log).toEqual([]);
  });

  test('a bd read failure exits 2 and NEVER prints the no-matches line', async () => {
    const h = harness();
    const out = captureStdout();
    const err = captureStderr();
    const code = await runThreadSearch({
      color: false,
      // A directory with no beads workspace at all.
      env: {...h.env, JUSTIN_THREADS_REPO_DIR: join(h.root, 'not-a-workspace')},
      now: NOW,
      query: 'anything',
    });
    expect(code).toBe(2);
    expect(err.join('\n')).toContain('could not read the thread beads');
    expect(out.join('\n')).not.toContain('no matches in');
  });

  test('an unreadable archive exits 2 and says the answer is not whole', async () => {
    const h = harness();
    seedThreads(h, [
      thread('th-1', {lastUserMessage: 'needle in the message'}),
    ]);
    const dir = join(h.archiveRoot, 'sess-broken');
    mkdirSync(dir, {recursive: true});
    writeFileSync(join(dir, '2026-09-14T01-00-00-000Z.json'), '{not json');
    const out = captureStdout();
    const err = captureStderr();
    const code = await runThreadSearch({
      color: false,
      env: h.env,
      now: NOW,
      query: 'needle in the message',
    });
    expect(code).toBe(2);
    // The match is still printed — finding something and then learning the
    // corpus was incomplete is still finding something.
    expect(out.join('\n')).toContain('needle in the message');
    expect(err.join('\n')).toContain('INCOMPLETE');
    expect(out.join('\n')).not.toContain('no matches in');
  });

  test('--json carries the rows, the counts and the failures', async () => {
    const h = harness();
    seedThreads(h, [
      thread('th-1', {
        lastActivityAt: NOW.toISOString(),
        lastUserMessage: 'go build the search command',
        repo: 'home-base',
        resumeCommand:
          "cd '/Users/jhaa/Dev/home-base' && claude --resume sess-1",
        sessionId: 'sess-1',
      }),
    ]);
    writeArchive(
      h,
      'lost-1',
      '2026-09-14T01:00:00.000Z',
      archiveDoc('lost-1', '2026-09-14T01:00:00.000Z'),
    );
    const out = captureStdout();
    captureStderr();
    const code = await runThreadSearch({
      env: h.env,
      json: true,
      now: NOW,
      query: 'build the search',
    });
    expect(code).toBe(0);
    const doc = parseSearchJson(out.join('\n'));
    expect(doc.archivedReportsSearched).toBe(1);
    // F3: a tool gets both numbers too, not just the terminal.
    expect(doc.archivedReportSessionsSearched).toBe(1);
    expect(doc.complete).toBe(true);
    expect(doc.failures).toEqual([]);
    expect(doc.matched).toBe(1);
    expect(doc.query).toBe('build the search');
    expect(doc.sessionsSearched).toBe(2);
    expect(doc.shown).toBe(1);
    expect(doc.threadsSearched).toBe(1);
    expect(doc.rows[0]?.hit.field).toBe('lastUserMessage');
    // F4: the row carries every field that matched, not just the printed one.
    expect(doc.rows[0]?.matchedFields).toEqual(['lastUserMessage']);
    expect(doc.rows[0]?.hit.snippet.match).toBe('build the search');
    expect(doc.rows[0]?.sessionId).toBe('sess-1');
    expect(doc.rows[0]?.threadId).toBe('th-1');
    // Never ansi: the JSON is for tooling.
    expect(out.join('\n')).not.toContain('\u001b[');
  });

  test('--json is under the SAME rule: incomplete is exit 2, not a clean 0', async () => {
    const h = harness();
    seedThreads(h, [
      thread('th-1', {lastUserMessage: 'needle in the message'}),
    ]);
    const dir = join(h.archiveRoot, 'sess-broken');
    mkdirSync(dir, {recursive: true});
    writeFileSync(join(dir, '2026-09-14T01-00-00-000Z.json'), '{not json');
    const out = captureStdout();
    captureStderr();
    const code = await runThreadSearch({
      env: h.env,
      json: true,
      now: NOW,
      query: 'needle in the message',
    });
    // The match IS there and the document reports it — and the exit code still
    // says the corpus was not whole, because a tool reading this must not treat
    // a partial answer as a complete one.
    expect(code).toBe(2);
    const doc = parseSearchJson(out.join('\n'));
    expect(doc.matched).toBe(1);
    expect(doc.complete).toBe(false);
    expect(doc.failures).toHaveLength(1);
  });

  test('--days narrows what is searched, and the count says so', async () => {
    const h = harness();
    seedThreads(h, [
      thread('th-recent', {
        lastActivityAt: new Date(NOW.getTime() - 2 * DAY).toISOString(),
        lastUserMessage: 'needle',
      }),
      thread('th-ancient', {
        lastActivityAt: new Date(NOW.getTime() - 60 * DAY).toISOString(),
        lastUserMessage: 'needle',
      }),
    ]);
    const out = captureStdout();
    captureStderr();
    const code = await runThreadSearch({
      color: false,
      days: 30,
      env: h.env,
      json: true,
      now: NOW,
      query: 'needle',
    });
    expect(code).toBe(0);
    const doc = parseSearchJson(out.join('\n'));
    expect(doc.sessionsSearched).toBe(1);
    expect(doc.matched).toBe(1);
    expect(doc.rows[0]?.threadId).toBe('th-recent');
  });
});
