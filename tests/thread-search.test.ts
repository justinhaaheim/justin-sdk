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
import type {SearchHit, SearchResult, SearchRow} from '../src/thread/search';

import {afterEach, describe, expect, spyOn, test} from 'bun:test';
import {mkdirSync, mkdtempSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {formatLocalDate, formatLocalTime} from '../src/date';
import {
  buildCorpus,
  buildSnippet,
  compileQuery,
  countCorpus,
  dedupeHits,
  displayFieldName,
  hitLabel,
  incompleteLine,
  moreLine,
  noMatchesLine,
  parseWrittenSince,
  projectFolderOf,
  readArchivedReports,
  renderSearchRow,
  rowProject,
  runThreadSearch,
  searchCorpus,
  searchJson,
  searchSessions,
  SECTION_NAME_CUT,
  sectionOf,
  sessionActivityAt,
  sessionLocation,
  SNIPPET_RADIUS,
  THREAD_SEARCH_FIELDS,
  withinWindow,
  withSessionBeads,
} from '../src/thread/search';
import {captureWriteStdout} from './capture-stdout';
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
    captureWriteStdout((text) => {
      lines.push(text);
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
  noProjectSkipped: number;
  query: string;
  regex: boolean;
  repos: string[] | null;
  rows: SearchRow[];
  sessionsSearched: number;
  shown: number;
  threadsSearched: number;
  undatedOnlySkipped: number;
  writtenSince: string | null;
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
// No cut splits an emoji (home-base-c82t4.3, D5)
// ---------------------------------------------------------------------------

/** A character outside the BMP: two UTF-16 code units. */
const EMOJI = '\u{1F600}';

/**
 * Every lone surrogate in `text`. This is what made jq refuse
 * `thread search --json` on 2026-11-13: JSON.stringify escapes a lone half as
 * `\udXXX`, and jq rejects the document.
 */
function loneSurrogates(value: unknown): string[] {
  const text = JSON.stringify(value);
  return text.match(/\\ud[89a-f][0-9a-f]{2}/giu) ?? [];
}

describe('no cut splits an emoji (home-base-c82t4.3, D5)', () => {
  test('the cut BEFORE the match drops the half, never keeps it', () => {
    // NEEDLE at 82, so the before-cut lands at 2: between the halves at 1 and 2.
    const text = `x${EMOJI}${'a'.repeat(79)}NEEDLE`;
    expect(text.indexOf('NEEDLE') - SNIPPET_RADIUS).toBe(2);
    const snippet = buildSnippet(text, text.indexOf('NEEDLE'), 6);
    expect(loneSurrogates(snippet)).toEqual([]);
    expect(snippet.before).toBe(`…${'a'.repeat(79)}`);
    expect(snippet.match).toBe('NEEDLE');
  });

  test('the cut AFTER the match drops the half, never keeps it', () => {
    // The after-cut lands at 6 + 80 = 86: between the halves at 85 and 86.
    const text = `NEEDLE${'b'.repeat(79)}${EMOJI}tail`;
    expect(text.indexOf(EMOJI)).toBe(6 + SNIPPET_RADIUS - 1);
    const snippet = buildSnippet(text, 0, 6);
    expect(loneSurrogates(snippet)).toEqual([]);
    expect(snippet.after).toBe(`${'b'.repeat(79)}…`);
  });

  test('a --regex match that ends inside an emoji takes the whole emoji', () => {
    // `.` without the u flag matches ONE code unit: half the emoji.
    const corpus = buildCorpus(
      [thread('th-1', {lastUserMessage: `say NEEDLE${EMOJI} again`})],
      [],
    );
    const row = firstRow(searchCorpus(corpus, pattern('needle.', true)));
    expect(loneSurrogates(row.hits)).toEqual([]);
    expect(row.hit.snippet.match).toBe(`NEEDLE${EMOJI}`);
    expect(row.hit.snippet.after).toBe(' again');
  });

  test('the 100-character title of a message-log row drops the half', () => {
    // 98 characters, then the emoji at 98 and 99: the cut at 99 splits it.
    const firstLine = `${'c'.repeat(98)}${EMOJI}${'d'.repeat(10)}`;
    const [row] = buildCorpus(
      [],
      [],
      [
        {
          lines: [
            {
              at: '2026-09-18T10:00:00.000Z',
              cwd: null,
              event: 'UserPromptSubmit',
              role: 'user',
              text: firstLine,
            },
          ],
          path: '/m/s1.jsonl',
          sessionId: 's1',
        },
      ],
    );
    expect(row?.title).toBe(`${'c'.repeat(98)}…`);
    expect(loneSurrogates(row?.title)).toEqual([]);
  });

  test('a cut section heading drops the half', () => {
    // The cut keeps SECTION_NAME_CUT - 1 = 79 units: between the halves at 78 and 79.
    const heading = `${'e'.repeat(SECTION_NAME_CUT - 2)}${EMOJI}${'f'.repeat(10)}`;
    const text = `## ${heading}\nthe needle`;
    const section = sectionOf(text, text.indexOf('needle'));
    expect(section).toBe(`${'e'.repeat(SECTION_NAME_CUT - 2)}…`);
    expect(loneSurrogates(section)).toEqual([]);
  });

  test('a snippet that does not cut through an emoji keeps it whole', () => {
    const snippet = buildSnippet(`${EMOJI} NEEDLE ${EMOJI}`, 3, 6);
    expect(snippet.before).toBe(`${EMOJI} `);
    expect(snippet.after).toBe(` ${EMOJI}`);
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

/** `3d (2026-09-16 14:00)` as this machine's local clock writes it. */
function whenText(age: string, at: Date): string {
  return `${age} (${formatLocalDate(at)} ${formatLocalTime(at).slice(0, 5)})`;
}

describe('rendering', () => {
  test('D-SEARCH-STYLE: a bold title, then one labelled field per line', () => {
    const at = new Date(NOW.getTime() - 3 * DAY);
    const corpus = buildCorpus(
      [
        thread('th-1', {
          lastActivityAt: at.toISOString(),
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
    // The title alone at the header column; every field under it at the body
    // column with its value in one shared column; the snippet on its own line
    // in that value column, the match marked »…« because colour is off.
    expect(lines).toEqual([
      '  th-1 title',
      '      Repo:     home-base',
      `      When:     ${whenText('3d', at)}`,
      '      Session:  sess-1',
      '      Matched:  lastUserMessage',
      '      Match:',
      '                go build the »format v2« dispatch',
      "      Resume:   cd '/Users/jhaa/Dev/home-base' && claude --resume sess-1",
    ]);
  });

  test('the labels come in the documented order, Also in only when more matched', () => {
    const corpus = buildCorpus(
      [
        thread('th-1', {
          firstUserMessage: 'go build the format v2 dispatch',
          lastAssistantMessage: 'the format v2 renderers are built',
          sessionId: 'sess-1',
        }),
      ],
      [],
    );
    const row = firstRow(searchCorpus(corpus, pattern('format v2')));
    const labels = renderSearchRow(row, NOW, {color: false})
      .split('\n')
      .map((line) => /^ {6}([A-Z][a-z]+(?: in)?):/u.exec(line)?.[1])
      .filter((value): value is string => value != null);
    expect(labels).toEqual([
      'Repo',
      'When',
      'Session',
      'Matched',
      'Also in',
      'Match',
      'Resume',
    ]);
  });

  test('colour: title and labels bold, match black on yellow, resume command cyan, missing values dim', () => {
    const corpus = buildCorpus(
      [
        thread('th-1', {
          lastUserMessage: 'go build the format v2 dispatch',
          repo: 'home-base',
          resumeCommand: 'claude --resume sess-1',
        }),
      ],
      [],
    );
    const row = firstRow(searchCorpus(corpus, pattern('format v2')));
    const painted = renderSearchRow(row, NOW, {color: true});
    expect(painted).toStartWith('  \u001b[1mth-1 title\u001b[0m\n');
    expect(painted).toContain('\u001b[1mRepo:\u001b[0m');
    expect(painted).toContain('\u001b[1mMatch:\u001b[0m');
    expect(painted).toContain('\u001b[43;30mformat v2\u001b[0m');
    expect(painted).toContain('\u001b[36mclaude --resume sess-1\u001b[0m');
    expect(painted).toContain('\u001b[2mno session id\u001b[0m');
    // With colour on, the »…« marks are not added on top of the highlight.
    expect(painted).not.toContain('»');
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
    // The snippet wrapped, every line of it in the value column (16)…
    expect(lines[5]).toBe('      Match:');
    const snippet = lines.slice(6, -1);
    expect(snippet.length).toBeGreaterThan(1);
    for (const line of snippet) {
      expect(line).toMatch(/^ {16}\S/u);
      expect(Bun.stringWidth(line)).toBeLessThanOrEqual(70);
    }
    // …and the command is ONE line however wide, so it still pastes.
    expect(lines.at(-1)).toBe(`      Resume:   ${resume}`);
    // The control: piped, nothing wraps at all.
    expect(renderSearchRow(row, NOW, {color: false}).split('\n')).toHaveLength(
      8,
    );
  });

  test('the match is highlighted black on yellow with colour on, and marked »…« with colour off', () => {
    const corpus = buildCorpus(
      [thread('th-1', {lastUserMessage: 'go build the format v2 dispatch'})],
      [],
    );
    const row = firstRow(searchCorpus(corpus, pattern('format v2')));
    expect(renderSearchRow(row, NOW, {color: true})).toContain(
      'go build the \u001b[43;30mformat v2\u001b[0m dispatch',
    );
    const plain = renderSearchRow(row, NOW, {color: false});
    expect(plain).toContain('go build the »format v2« dispatch');
    expect(plain).not.toContain('\u001b[');
  });

  test('THE LINE COUNT: 8 to 11 lines a result, 8 for a one-line snippet', () => {
    const lineCount = (row: SearchRow, width: number | null): number =>
      renderSearchRow(row, NOW, {color: true, width}).split('\n').length;
    const one = firstRow(
      searchCorpus(
        buildCorpus(
          [
            thread('th-1', {
              lastUserMessage: 'go build the format v2 dispatch',
            }),
          ],
          [],
        ),
        pattern('format v2'),
      ),
    );
    expect(lineCount(one, null)).toBe(8);
    expect(lineCount(one, 120)).toBe(8);
    // The longest a row gets on a normal terminal: other fields matched (Also
    // in) and a full ±80-character snippet, which wraps.
    const long = `${'context words '.repeat(12)}format v2 ${'and more words '.repeat(12)}`;
    const full = firstRow(
      searchCorpus(
        buildCorpus(
          [
            thread(
              'th-2',
              {firstUserMessage: long, lastUserMessage: long},
              {notes: long},
            ),
          ],
          [],
        ),
        pattern('format v2'),
      ),
    );
    expect(lineCount(full, null)).toBe(9);
    for (const width of [80, 100, 120]) {
      const count = lineCount(full, width);
      expect(count).toBeGreaterThanOrEqual(8);
      expect(count).toBeLessThanOrEqual(11);
    }
  });

  test('NO line joins values with " · ", colour on or off, wrapped or not', () => {
    // The field names that carry a ` · ` in the data: a message-log line and an
    // archived report path. `--json` keeps them; the terminal must not.
    const corpus = buildCorpus(
      [
        thread('th-1', {
          lastActivityAt: NOW.toISOString(),
          repo: 'home-base',
          sessionId: 's1',
        }),
      ],
      [
        {
          document: archiveDoc('s1', '2026-09-14T01:00:00.000Z', {
            payload: {notes: 'needle again', stopReason: 'needle'},
          }),
          path: '/a/1.json',
          repo: null,
          reportedAt: '2026-09-14T01:00:00.000Z',
          resumeCommand: null,
          sessionId: 's1',
          title: null,
        },
      ],
      [
        {
          lines: [
            {
              at: '2026-09-18T10:00:00.000Z',
              cwd: null,
              event: 'UserPromptSubmit',
              role: 'user',
              text: 'a needle',
            },
          ],
          path: '/m/s1.jsonl',
          sessionId: 's1',
        },
      ],
    );
    const row = firstRow(searchCorpus(corpus, pattern('needle')));
    expect(row.hit.field).toMatch(/^you · /u);
    expect(row.matchedFields.some((f) => f.includes(' · payload.'))).toBe(true);
    for (const color of [false, true]) {
      for (const width of [null, 60, 120]) {
        for (const line of renderSearchRow(row, NOW, {color, width}).split(
          '\n',
        )) {
          expect(line).not.toContain(' · ');
        }
      }
    }
    expect(renderSearchRow(row, NOW, {color: false})).toContain(
      'Matched:  you (',
    );
  });

  test('displayFieldName undoes the · join for display only', () => {
    expect(displayFieldName('lastUserMessage')).toBe('lastUserMessage');
    expect(displayFieldName('you · 2026-09-23 14:05')).toBe(
      'you (2026-09-23 14:05)',
    );
    expect(
      displayFieldName(
        'archived report 2026-09-14T01:00:00.000Z · payload.stopReason',
      ),
    ).toBe('archived report 2026-09-14T01:00:00.000Z (payload.stopReason)');
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
    expect(lines[4]).toBe('      Matched:  firstUserMessage');
    expect(lines[5]).toBe(
      '      Also in:  +1 more field: lastAssistantMessage',
    );
    expect(lines[7]).toBe('                go build the »format v2« dispatch');
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
    // The two snippets are identical, and only the archived one is dated (the
    // fixture has no lastUserMessageAt), so it is the one shown
    // (home-base-c82t4.4 F5). Both fields are still named.
    expect(row.hit.field).toBe(
      'archived report 2026-09-14T01:00:00.000Z · payload.stopReason',
    );
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
      '      Also in:  +5 more fields: firstUserMessage, lastUserMessage, lastAssistantMessage, …',
    );
  });

  test('a row prints a snippet for the first three hits and counts the rest; --all-matches prints every one (home-base-7761p.2)', () => {
    const corpus = buildCorpus(
      [
        thread(
          'th-1',
          {
            firstUserMessage: 'first needle here',
            lastAssistantMessage: 'claude needle here',
            lastUserMessage: 'last needle here',
          },
          {description: 'desc needle', notes: 'notes needle', title: 'needle'},
        ),
      ],
      [],
    );
    const row = firstRow(searchCorpus(corpus, pattern('needle')));
    expect(row.hits).toHaveLength(6);
    expect(row.hits[0]).toEqual(row.hit);
    const plain = renderSearchRow(row, NOW, {color: false});
    expect(plain).toContain('      Match:');
    expect(plain).toContain('      Match (firstUserMessage):');
    expect(plain).toContain('first »needle« here');
    expect(plain).toContain('      Match (lastUserMessage):');
    expect(plain).not.toContain('Match (lastAssistantMessage):');
    expect(plain).toContain(
      '      and 3 more matches (--all-matches prints every one)',
    );
    const all = renderSearchRow(row, NOW, {allMatches: true, color: false});
    expect(all).toContain('Match (lastAssistantMessage):');
    expect(all).toContain('Match (notes):');
    expect(all).toContain('Match (description):');
    expect(all).not.toContain('more match');
    // One hit: no extra blocks and no count, so the eight-line shape holds.
    const one = firstRow(
      searchCorpus(
        buildCorpus([thread('th-2', {lastUserMessage: 'needle'})], []),
        pattern('needle'),
      ),
    );
    expect(renderSearchRow(one, NOW, {color: false})).not.toContain(
      'more match',
    );
  });

  test('what is missing SAYS it is missing rather than printing blank', () => {
    const corpus = buildCorpus(
      [thread('th-1', {lastUserMessage: 'needle'})],
      [],
    );
    const row = firstRow(searchCorpus(corpus, pattern('needle')));
    const rendered = renderSearchRow(row, NOW, {color: false});
    expect(rendered).toContain('Repo:     no repo recorded');
    expect(rendered).toContain('When:     no activity date recorded');
    expect(rendered).toContain('Session:  no session id');
    expect(rendered).toContain('Resume:   no resume command recorded');
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
    const printed = out.join('\n');
    expect(printed).toContain('  th-1 title\n      Repo:     home-base\n');
    expect(printed).toContain(`When:     ${whenText('just now', NOW)}`);
    expect(printed).toContain('Session:  sess-1');
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
    // At the header column, with a blank line before it (yukaf.5).
    expect(out.join('\n').split('\n').slice(-2)).toEqual([
      '',
      '  no matches in 2 sessions searched (1 threads, 1 archived report across 1 session, 0 message logs)',
    ]);
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

// ---------------------------------------------------------------------------
// searchSessions: the pipeline without the printing (home-base-yukaf.10)
// ---------------------------------------------------------------------------

describe('searchSessions', () => {
  test('returns exactly what --json prints, and prints nothing', async () => {
    const h = harness();
    seedThreads(h, [
      thread('th-1', {
        lastActivityAt: NOW.toISOString(),
        lastUserMessage: 'make the header darker',
        sessionId: 'sess-1',
      }),
      thread('th-2', {lastUserMessage: 'the sticky header overlaps'}),
      thread('th-3', {lastUserMessage: 'nothing to see'}),
    ]);
    const options = {env: h.env, limit: 0, now: NOW, query: 'header'};
    const out = captureStdout();
    const err = captureStderr();
    const found = await searchSessions(options);
    expect(out).toEqual([]);
    expect(err).toEqual([]);
    if (!found.ok) throw new Error(found.error);
    expect(found.complete).toBe(true);
    expect(found.result.rows.map((row) => row.threadId)).toEqual([
      'th-1',
      'th-2',
    ]);

    const code = await runThreadSearch({...options, color: false, json: true});
    expect(code).toBe(0);
    expect(JSON.parse(out.join('\n'))).toEqual(
      JSON.parse(JSON.stringify(searchJson(found, options))),
    );
  });

  test('a bad regex is ok: false with the engine message, nothing read', async () => {
    const h = harness();
    const found = await searchSessions({env: h.env, query: '(', regex: true});
    expect(found).toEqual({
      error: expect.stringContaining(
        'thread search: invalid regex /(/',
      ) as string,
      ok: false,
    });
    expect(h.fake.read().log).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// home-base-y1hg0.7: the session bead's title, and the section that matched
// ---------------------------------------------------------------------------

describe('the section a match sits in (home-base-y1hg0.7)', () => {
  const REPORT = [
    '**Session:** [HOME] Reopen every unfinished session',
    '',
    '## Progress',
    '',
    '12. ✅ **Scope and filter thread open like a dataview** (home-base-aasbl.24)',
    '',
    '## Questions for you',
    '',
    '1. 🟡 P1 · Run the first real thread open',
  ].join('\n');

  test('sectionOf: the nearest heading at or above the match', () => {
    expect(sectionOf(REPORT, REPORT.indexOf('Scope and filter'))).toBe(
      'Progress',
    );
    expect(sectionOf(REPORT, REPORT.indexOf('Run the first'))).toBe(
      'Questions for you',
    );
    // A match ON the heading line: that heading is its section.
    expect(sectionOf(REPORT, REPORT.indexOf('Questions for'))).toBe(
      'Questions for you',
    );
    // Above every heading: none.
    expect(sectionOf(REPORT, REPORT.indexOf('Reopen'))).toBeNull();
  });

  test('a bold-only label ending in a colon is a section; a bold sentence and a labelled value are not', () => {
    const legacy = [
      '**What I did:**',
      '- ✅ Built the renderer',
      '**13 of 18 requests done**',
      '- the request list',
      '**Session:** home-base',
      '- after a labelled value',
      '**Deviations**:',
      '- none',
    ].join('\n');
    expect(sectionOf(legacy, legacy.indexOf('Built the'))).toBe('What I did');
    expect(sectionOf(legacy, legacy.indexOf('the request list'))).toBe(
      'What I did',
    );
    expect(sectionOf(legacy, legacy.indexOf('after a labelled'))).toBe(
      'What I did',
    );
    expect(sectionOf(legacy, legacy.indexOf('none'))).toBe('Deviations');
  });

  test('a # inside a code fence is not a heading; markup is stripped; a long heading is cut', () => {
    const fenced = [
      '## Real **section** `x`',
      '```sh',
      '# not a heading',
      'echo match-here',
      '```',
    ].join('\n');
    expect(sectionOf(fenced, fenced.indexOf('match-here'))).toBe(
      'Real section x',
    );
    const long = `# ${'word '.repeat(40)}\nmatch`;
    const cut = sectionOf(long, long.indexOf('match'));
    expect(cut?.length).toBe(SECTION_NAME_CUT);
    expect(cut?.endsWith('…')).toBe(true);
  });

  test('the row carries the section of its FIRST matching field, and prints it under Matched', () => {
    const corpus = buildCorpus(
      [
        thread('th-1', {
          lastAssistantMessage: REPORT,
          lastUserMessage: 'please scope and filter thread open',
          sessionId: 'sess-1',
        }),
      ],
      [],
    );
    // The user message is tried before Claude's (THREAD_SEARCH_FIELDS) and
    // has no heading above the match.
    const fromUser = firstRow(searchCorpus(corpus, pattern('thread open')));
    expect(fromUser.hit.field).toBe('lastUserMessage');
    expect(fromUser.hit.section).toBeNull();
    expect(renderSearchRow(fromUser, NOW, {color: false})).not.toContain(
      'Section:',
    );

    const fromReport = firstRow(
      searchCorpus(corpus, pattern('Scope and filter thread open like')),
    );
    expect(fromReport.hit).toMatchObject({
      field: 'lastAssistantMessage',
      section: 'Progress',
    });
    const lines = renderSearchRow(fromReport, NOW, {color: false}).split('\n');
    expect(lines.slice(3, 6)).toEqual([
      '      Session:  sess-1',
      '      Matched:  lastAssistantMessage',
      '      Section:  Progress',
    ]);
  });
});

describe('the session bead titles the row (home-base-y1hg0.7)', () => {
  const SID = 'd87d078b-8484-4ba6-9f61-8be75ea0ecbc';
  const UNTITLED = '(untitled) home-base session d87d078b';
  const TITLE = 'Reopen every unfinished session in cmux with one command';

  /** A sessions index line, and (unless null) the beads export it names. */
  function seedSessionBead(
    h: Harness,
    options: {
      exportLines?: string[] | null;
      indexText?: string;
      sessionId?: string;
    } = {},
  ): string {
    const beadsDir = join(h.root, 'repo', '.beads');
    const sighting = {
      at: '2026-10-18T12:16:09.000Z',
      beadId: 'home-base-aasbl',
      beadsDir,
      branch: 'main',
      checkoutPath: join(h.root, 'repo'),
      event: 'created',
      repo: 'home-base',
      sessionId: options.sessionId ?? SID,
    };
    writeFileSync(
      join(h.root, 'state', 'sessions.jsonl'),
      options.indexText ?? `${JSON.stringify(sighting)}\n`,
    );
    const lines =
      options.exportLines === undefined
        ? [
            JSON.stringify({
              id: 'home-base-aasbl',
              issue_type: 'session',
              labels: ['session', `sid:${SID}`],
              status: 'in_progress',
              title: TITLE,
            }),
          ]
        : options.exportLines;
    if (lines != null) {
      mkdirSync(beadsDir, {recursive: true});
      writeFileSync(join(beadsDir, 'issues.jsonl'), `${lines.join('\n')}\n`);
    }
    return beadsDir;
  }

  function seedUntitled(h: Harness): void {
    seedThreads(h, [
      thread(
        'th-aasbl',
        {
          lastActivityAt: NOW.toISOString(),
          lastAssistantMessage: '12. ✅ **Scope and filter thread open**',
          repo: 'home-base',
          sessionId: SID,
        },
        {title: UNTITLED},
      ),
    ]);
  }

  async function onlyRow(h: Harness): Promise<SearchRow> {
    const found = await searchSessions({
      env: h.env,
      now: NOW,
      query: 'thread open',
    });
    if (!found.ok) throw new Error(found.error);
    return firstRow(found.result);
  }

  test('THE 2026-10-20 CASE: the row is titled by the session bead, never "(untitled)"', async () => {
    const h = harness();
    seedUntitled(h);
    seedSessionBead(h);
    const row = await onlyRow(h);
    expect(row.title).toBe(TITLE);
    expect(row.sessionBead).toEqual({
      beadId: 'home-base-aasbl',
      kind: 'found',
      title: TITLE,
    });
    const out = captureStdout();
    captureStderr();
    const code = await runThreadSearch({
      color: false,
      env: h.env,
      now: NOW,
      query: 'thread open',
    });
    expect(code).toBe(0);
    const printed = out.join('\n');
    expect(printed).toContain(`  ${TITLE}\n`);
    expect(printed).not.toContain('(untitled)');
    expect(printed).toContain(
      `      Session:  ${SID}\n      Bead:     home-base-aasbl\n      Matched:  lastAssistantMessage\n`,
    );
  });

  test('no sessions index on this machine: none, measured; the corpus title stays; no Bead line', async () => {
    const h = harness();
    seedUntitled(h);
    const row = await onlyRow(h);
    expect(row.title).toBe(UNTITLED);
    expect(row.sessionBead?.kind).toBe('none');
    expect(renderSearchRow(row, NOW, {color: false})).not.toContain('Bead:');
  });

  test('the index records no session bead for this session: none', async () => {
    const h = harness();
    seedUntitled(h);
    seedSessionBead(h, {sessionId: 'some-other-session'});
    const row = await onlyRow(h);
    expect(row.sessionBead).toEqual({
      kind: 'none',
      reason: 'the sessions index records no session bead for this session',
    });
    expect(row.title).toBe(UNTITLED);
  });

  test('the export the index names cannot be read: UNKNOWN on the Bead line, title unchanged', async () => {
    const h = harness();
    seedUntitled(h);
    const beadsDir = seedSessionBead(h, {exportLines: null});
    const row = await onlyRow(h);
    const path = join(beadsDir, 'issues.jsonl');
    expect(row.sessionBead).toEqual({
      kind: 'unknown',
      reason: `${path} does not exist`,
    });
    expect(row.title).toBe(UNTITLED);
    expect(renderSearchRow(row, NOW, {color: false})).toContain(
      `      Bead:     UNKNOWN — ${path} does not exist`,
    );
  });

  test('the index names a bead the export does not hold: UNKNOWN, never none', async () => {
    const h = harness();
    seedUntitled(h);
    const beadsDir = seedSessionBead(h, {
      exportLines: [
        JSON.stringify({
          id: 'home-base-other',
          issue_type: 'task',
          status: 'open',
          title: 'Something else',
        }),
      ],
    });
    const row = await onlyRow(h);
    expect(row.sessionBead).toEqual({
      kind: 'unknown',
      reason: `the sessions index names home-base-aasbl, but ${join(beadsDir, 'issues.jsonl')} does not hold it`,
    });
  });

  test('a corrupt index line naming the session: UNKNOWN, never none', async () => {
    const h = harness();
    seedUntitled(h);
    seedSessionBead(h, {indexText: `{"sessionId":"${SID}", half-written\n`});
    const row = await onlyRow(h);
    expect(row.sessionBead?.kind).toBe('unknown');
    expect(row.title).toBe(UNTITLED);
  });

  test('a row with no session id is a measured none; searchCorpus alone looks nothing up', () => {
    const row = firstRow(
      searchCorpus(
        buildCorpus([thread('th-x', {lastUserMessage: 'thread open'})], []),
        pattern('thread open'),
      ),
    );
    expect(row.sessionBead).toBeNull();
    const [looked] = withSessionBeads([row], {});
    expect(looked?.sessionBead).toEqual({
      kind: 'none',
      reason: 'this row has no session id',
    });
  });
});

// ---------------------------------------------------------------------------
// --repo and --written-since (home-base-c82t4.2, D3 and D4)
// ---------------------------------------------------------------------------

interface ProjectHarness {
  /** A dev root holding alpha/ and garden-tools/ (tag GARDEN), each with a .git. */
  devRoot: string;
  env: Record<string, string | undefined>;
  h: Harness;
}

function projectHarness(): ProjectHarness {
  const h = harness();
  const devRoot = join(h.root, 'Dev');
  mkdirSync(join(devRoot, 'alpha', '.git'), {recursive: true});
  mkdirSync(join(devRoot, 'garden-tools', '.git'), {recursive: true});
  writeFileSync(
    join(devRoot, 'garden-tools', 'justin-sdk.config.json'),
    JSON.stringify({projectTag: 'GARDEN'}),
  );
  const xdg = join(h.root, 'xdg');
  mkdirSync(xdg, {recursive: true});
  return {devRoot, env: {...h.env, XDG_CONFIG_HOME: xdg}, h};
}

/** A session's message log where the capture hook writes it. */
function writeLog(
  h: Harness,
  sessionId: string,
  lines: {at: string | null; cwd: string | null; text: string}[],
): void {
  const dir = join(h.root, 'state', 'messages');
  mkdirSync(dir, {recursive: true});
  writeFileSync(
    join(dir, `${sessionId}.jsonl`),
    `${lines.map((line) => JSON.stringify({...line, event: 'UserPromptSubmit', role: 'user'})).join('\n')}\n`,
  );
}

function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

describe('--repo (home-base-c82t4.2, D3)', () => {
  async function sessionsFor(
    p: ProjectHarness,
    repos: string[],
  ): Promise<(string | null)[]> {
    const found = await searchSessions({
      devRoot: p.devRoot,
      env: p.env,
      limit: 0,
      now: NOW,
      query: 'needle',
      repos,
    });
    if (!found.ok) throw new Error(found.error);
    return found.result.rows.map((row) => row.sessionId).sort();
  }

  test('keeps only that project: folder or tag, any case, brackets, repeated or comma-separated', async () => {
    const p = projectHarness();
    seedThreads(p.h, [
      thread('th-a', {repo: 'alpha', sessionId: 's-a'}, {title: 'a needle'}),
      thread(
        'th-g',
        {repo: 'garden-tools', sessionId: 's-g'},
        {title: 'g needle'},
      ),
      thread('th-o', {repo: 'orchard', sessionId: 's-o'}, {title: 'o needle'}),
    ]);
    expect(await sessionsFor(p, ['alpha'])).toEqual(['s-a']);
    expect(await sessionsFor(p, ['garden'])).toEqual(['s-g']);
    expect(await sessionsFor(p, ['[Garden]'])).toEqual(['s-g']);
    expect(await sessionsFor(p, ['ALPHA', 'garden'])).toEqual(['s-a', 's-g']);
    expect(await sessionsFor(p, ['alpha,garden-tools'])).toEqual([
      's-a',
      's-g',
    ]);
    // orchard is not under the dev root: the corpus's own repo names are known too.
    expect(await sessionsFor(p, ['Orchard'])).toEqual(['s-o']);
    expect(await sessionsFor(p, [])).toEqual(['s-a', 's-g', 's-o']);
  });

  test('an unknown value exits 2, prints no rows, and lists the known projects one per line', async () => {
    const p = projectHarness();
    seedThreads(p.h, [
      thread('th-a', {repo: 'alpha', sessionId: 's-a'}, {title: 'a needle'}),
    ]);
    const out = captureStdout();
    const err = captureStderr();
    const code = await runThreadSearch({
      color: false,
      devRoot: p.devRoot,
      env: p.env,
      now: NOW,
      query: 'needle',
      repos: ['alpha', 'nope'],
    });
    expect(code).toBe(2);
    expect(out.join('')).toBe('');
    const lines = err.join('\n').split('\n');
    expect(lines[0]).toBe(
      'thread search: No project is named "nope". The known projects (folder, then tag):',
    );
    expect(lines).toContain('alpha  [ALPHA]');
    expect(lines).toContain('garden-tools  [GARDEN]');
  });

  test('an unknown value under --json is the error object and exit 2; a blank value is refused too', async () => {
    const p = projectHarness();
    seedThreads(p.h, [
      thread('th-a', {repo: 'alpha', sessionId: 's-a'}, {title: 'a needle'}),
    ]);
    const out = captureStdout();
    const code = await runThreadSearch({
      devRoot: p.devRoot,
      env: p.env,
      json: true,
      now: NOW,
      query: 'needle',
      repos: ['nope'],
    });
    expect(code).toBe(2);
    expect(JSON.parse(out.join('')) as unknown).toMatchObject({ok: false});
    const blank = await searchSessions({
      devRoot: p.devRoot,
      env: p.env,
      now: NOW,
      query: 'needle',
      repos: [' , '],
    });
    expect(blank.ok).toBe(false);
  });

  test('sessionLocation: the bead first, then the NEWEST log line with a cwd, then the resume cd', () => {
    const log = (lines: {at: string; cwd: string | null}[]) => ({
      lines: lines.map((line) => ({
        ...line,
        event: 'UserPromptSubmit' as const,
        role: 'user' as const,
        text: 'hello',
      })),
      path: '/m/s1.jsonl',
      sessionId: 's1',
    });
    const resume = `cd '/dev/it'\\''s' && claude --resume s1`;
    const lines = [
      {at: ago(2 * DAY), cwd: '/dev/old'},
      {at: ago(DAY), cwd: '/dev/new'},
      {at: ago(DAY / 2), cwd: null},
    ];
    const [withBead] = buildCorpus(
      [
        thread('th-1', {
          cwd: '/dev/bead',
          resumeCommand: resume,
          sessionId: 's1',
        }),
      ],
      [],
      [log(lines)],
    );
    const [withLog] = buildCorpus(
      [thread('th-1', {resumeCommand: resume, sessionId: 's1'})],
      [],
      [log(lines)],
    );
    const [withResume] = buildCorpus(
      [thread('th-1', {resumeCommand: resume, sessionId: 's1'})],
      [],
    );
    const [withNothing] = buildCorpus([thread('th-1', {sessionId: 's1'})], []);
    if (withBead == null || withLog == null || withResume == null)
      throw new Error('expected rows');
    expect(sessionLocation(withBead)).toEqual({
      path: '/dev/bead',
      source: 'bead',
    });
    expect(sessionLocation(withLog)).toEqual({path: '/dev/new', source: 'log'});
    expect(sessionLocation(withResume)).toEqual({
      path: "/dev/it's",
      source: 'resume',
    });
    expect(
      withNothing == null ? 'no row' : sessionLocation(withNothing),
    ).toBeNull();
  });

  test('projectFolderOf: the folder directly under the dev root; a worktree belongs to the folder holding .claude', () => {
    expect(projectFolderOf('/u/Dev/alpha', '/u/Dev')).toBe('alpha');
    expect(
      projectFolderOf('/u/Dev/alpha/.claude/worktrees/fix-it/src', '/u/Dev/'),
    ).toBe('alpha');
    expect(projectFolderOf('/u/Dev', '/u/Dev')).toBeNull();
    expect(projectFolderOf('/u/Devices/alpha', '/u/Dev')).toBeNull();
    expect(projectFolderOf('/private/tmp/x', '/u/Dev')).toBeNull();
    expect(projectFolderOf('alpha/src', '/u/Dev')).toBeNull();
  });

  test('rowProject: a recorded repo, a placed one, outside the dev root, and a relative path that names no place', () => {
    const row = (metadata: Record<string, unknown>) => {
      const [only] = buildCorpus([thread('th-1', metadata)], []);
      if (only == null) throw new Error('expected a row');
      return only;
    };
    expect(
      rowProject(row({cwd: '/u/Dev/beta', repo: 'alpha'}), '/u/Dev'),
    ).toEqual({folder: 'alpha', kind: 'recorded'});
    expect(rowProject(row({cwd: '/u/Dev/beta/src'}), '/u/Dev')).toEqual({
      folder: 'beta',
      kind: 'placed',
      source: 'bead',
    });
    expect(rowProject(row({cwd: '/private/tmp/x'}), '/u/Dev')).toEqual({
      kind: 'outside',
      source: 'bead',
    });
    expect(rowProject(row({cwd: 'beta/src'}), '/u/Dev')).toEqual({
      kind: 'unknown',
    });
    expect(rowProject(row({}), '/u/Dev')).toEqual({kind: 'unknown'});
  });

  test('F3 (home-base-c82t4.4): a placed row carries placedRepo and its Repo line says where it came from; the others stay null', () => {
    const corpus = buildCorpus(
      [
        thread(
          'th-placed',
          {cwd: '/u/Dev/beta/.claude/worktrees/w', sessionId: 's-placed'},
          {title: 'needle placed'},
        ),
        thread(
          'th-recorded',
          {cwd: '/u/Dev/beta', repo: 'alpha', sessionId: 's-recorded'},
          {title: 'needle recorded'},
        ),
        thread(
          'th-outside',
          {cwd: '/private/tmp/x', sessionId: 's-outside'},
          {title: 'needle outside'},
        ),
        thread('th-none', {sessionId: 's-none'}, {title: 'needle nowhere'}),
      ],
      [],
    );
    const bySession = (devRoot: string | null): Map<string, SearchRow> =>
      new Map(
        searchCorpus(corpus, pattern('needle'), {devRoot, limit: 0}).rows.map(
          (row) => [row.sessionId ?? '', row],
        ),
      );
    const rows = bySession('/u/Dev');
    expect(
      [...rows.entries()].map(([id, row]) => [id, row.placedRepo]).sort(),
    ).toEqual([
      ['s-none', null],
      ['s-outside', null],
      ['s-placed', 'beta'],
      ['s-recorded', null],
    ]);
    const render = (id: string): string => {
      const row = rows.get(id);
      if (row == null) throw new Error(`expected a row for ${id}`);
      return renderSearchRow(row, NOW, {color: false});
    };
    expect(render('s-placed')).toContain('Repo:     beta (from where it ran)');
    expect(render('s-recorded')).toContain('Repo:     alpha\n');
    expect(render('s-outside')).toContain('Repo:     no repo recorded');
    expect(render('s-none')).toContain('Repo:     no repo recorded');
    // With no dev root nothing is placed.
    expect(bySession(null).get('s-placed')?.placedRepo).toBeNull();
  });

  test('F3: the --json row carries placedRepo, with --repo and without it', async () => {
    const p = projectHarness();
    const alpha = join(p.devRoot, 'alpha');
    seedThreads(p.h, [
      thread(
        'th-placed',
        {cwd: join(alpha, 'sub'), sessionId: 's-placed'},
        {title: 'needle placed'},
      ),
      thread(
        'th-recorded',
        {repo: 'alpha', sessionId: 's-recorded'},
        {title: 'needle recorded'},
      ),
    ]);
    for (const repos of [['alpha'], []]) {
      const out = captureStdout();
      const code = await runThreadSearch({
        devRoot: p.devRoot,
        env: p.env,
        json: true,
        limit: 0,
        now: NOW,
        query: 'needle',
        repos,
      });
      expect(code).toBe(0);
      const json = parseSearchJson(out.join(''));
      expect(
        json.rows.map((row) => [row.sessionId, row.placedRepo]).sort(),
      ).toEqual([
        ['s-placed', 'alpha'],
        ['s-recorded', null],
      ]);
      spies.splice(0).forEach((spy) => {
        spy.mockRestore();
      });
    }
  });

  test('a row with no repo is placed by where it ran; outside the dev root is left out quietly; no location at all is COUNTED', async () => {
    const p = projectHarness();
    const alpha = join(p.devRoot, 'alpha');
    seedThreads(p.h, [
      thread(
        'th-bead',
        {cwd: join(alpha, '.claude', 'worktrees', 'x'), sessionId: 's-bead'},
        {title: 'needle by bead'},
      ),
      thread('th-log', {sessionId: 's-log'}, {title: 'needle by log'}),
      thread(
        'th-resume',
        {
          resumeCommand: `cd '${alpha}' && claude --resume s-resume`,
          sessionId: 's-resume',
        },
        {title: 'needle by resume'},
      ),
      thread(
        'th-tmp',
        {cwd: '/private/tmp/scratch', sessionId: 's-tmp'},
        {title: 'needle in tmp'},
      ),
      thread('th-none', {sessionId: 's-none'}, {title: 'needle nowhere'}),
      thread(
        'th-garden',
        {cwd: join(p.devRoot, 'garden-tools'), sessionId: 's-garden'},
        {title: 'needle in the garden'},
      ),
    ]);
    writeLog(p.h, 's-log', [
      {at: ago(2 * DAY), cwd: '/elsewhere', text: 'hello'},
      {at: ago(DAY), cwd: join(alpha, 'sub'), text: 'hello'},
    ]);
    writeLog(p.h, 's-logonly', [
      {at: ago(DAY), cwd: alpha, text: 'a needle in a log only'},
    ]);

    expect(await sessionsFor(p, ['alpha'])).toEqual([
      's-bead',
      's-log',
      's-logonly',
      's-resume',
    ]);

    const out = captureStdout();
    const code = await runThreadSearch({
      devRoot: p.devRoot,
      env: p.env,
      json: true,
      limit: 0,
      now: NOW,
      query: 'needle',
      repos: ['alpha'],
    });
    expect(code).toBe(0);
    const json = parseSearchJson(out.join(''));
    expect(json.repos).toEqual(['alpha']);
    expect(json.noProjectSkipped).toBe(1);
    expect(json.sessionsSearched).toBe(4);

    out.length = 0;
    await runThreadSearch({
      color: false,
      devRoot: p.devRoot,
      env: p.env,
      limit: 0,
      now: NOW,
      query: 'needle',
      repos: ['alpha'],
    });
    expect(out.join('')).toContain(
      '1 session with no recorded project was not searched',
    );
    expect(out.join('')).not.toContain('needle in tmp');
  });

  test('the count is said on the zero-match line too, and nothing is said without --repo', async () => {
    const p = projectHarness();
    seedThreads(p.h, [
      thread('th-a', {repo: 'alpha', sessionId: 's-a'}, {title: 'a needle'}),
      thread('th-n1', {sessionId: 's-n1'}, {title: 'no place'}),
      thread('th-n2', {sessionId: 's-n2'}, {title: 'no place either'}),
    ]);
    const out = captureStdout();
    const code = await runThreadSearch({
      color: false,
      devRoot: p.devRoot,
      env: p.env,
      now: NOW,
      query: 'haystack',
      repos: ['alpha'],
    });
    expect(code).toBe(1);
    const text = out.join('');
    expect(text).toContain('no matches in 1 sessions searched');
    expect(text).toContain(
      '2 sessions with no recorded project were not searched',
    );

    out.length = 0;
    await runThreadSearch({
      devRoot: p.devRoot,
      env: p.env,
      json: true,
      now: NOW,
      query: 'needle',
    });
    const json = parseSearchJson(out.join(''));
    expect(json.repos).toBeNull();
    expect(json.noProjectSkipped).toBe(0);
    expect(json.sessionsSearched).toBe(3);
  });
});

describe('--written-since (home-base-c82t4.2, D4)', () => {
  const CUTOFF = NOW.getTime() - 3 * DAY;

  test('parseWrittenSince: 24h, 3d, 2w back from now; a date is local midnight; anything else is refused', () => {
    expect(parseWrittenSince('24h', NOW)).toEqual({
      at: new Date(NOW.getTime() - DAY),
      kind: 'ok',
    });
    expect(parseWrittenSince('2w', NOW)).toEqual({
      at: new Date(NOW.getTime() - 14 * DAY),
      kind: 'ok',
    });
    expect(parseWrittenSince('2026-09-17', NOW)).toEqual({
      at: new Date(2026, 8, 17),
      kind: 'ok',
    });
    for (const bad of [
      '7',
      '1.5d',
      '0d',
      '2026-02-30',
      '2026-9-17',
      'today',
      '',
    ]) {
      expect(parseWrittenSince(bad, NOW).kind).toBe('bad');
    }
  });

  test('a bare date is LOCAL midnight, not UTC midnight', () => {
    // bun test runs in UTC, where the two are the same instant; Denver is not.
    const saved = process.env.TZ;
    process.env.TZ = 'America/Denver';
    try {
      expect(parseWrittenSince('2026-09-17', NOW)).toEqual({
        at: new Date('2026-09-17T06:00:00.000Z'),
        kind: 'ok',
      });
    } finally {
      if (saved == null) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });

  test('each hit is dated by its own record: log line, bead message stamp, archived report', () => {
    const line = (sessionId: string, at: string) => ({
      lines: [
        {
          at,
          cwd: null,
          event: 'UserPromptSubmit' as const,
          role: 'user' as const,
          text: 'a needle',
        },
      ],
      path: `/m/${sessionId}.jsonl`,
      sessionId,
    });
    const corpus = buildCorpus(
      [
        thread('th-first', {
          firstUserMessage: 'a needle',
          firstUserMessageAt: ago(3_600_000),
          sessionId: 's-first',
        }),
        thread('th-first-old', {
          firstUserMessage: 'a needle',
          firstUserMessageAt: ago(10 * DAY),
          sessionId: 's-first-old',
        }),
        thread('th-notes', {sessionId: 's-notes'}, {notes: 'a needle'}),
        thread('th-mixed', {sessionId: 's-mixed'}, {notes: 'a needle'}),
      ],
      [
        {
          document: {payload: {title: 'a needle'}},
          path: '/a/1.json',
          repo: null,
          reportedAt: ago(DAY),
          resumeCommand: null,
          sessionId: 's-archive',
          title: null,
        },
      ],
      [
        line('s-log-new', ago(DAY)),
        line('s-log-old', ago(10 * DAY)),
        line('s-mixed', ago(10 * DAY)),
      ],
    );
    const result = searchCorpus(corpus, pattern('needle'), {
      limit: 0,
      writtenSince: CUTOFF,
    });
    expect(result.rows.map((row) => row.sessionId).sort()).toEqual([
      's-archive',
      's-first',
      's-log-new',
    ]);
    // Only s-notes is counted: it matched only in undated text. s-mixed also
    // matched in a log line older than the cutoff, so its words are dated
    // (D4: "a session whose only hits are undated"); the old log line and the
    // old bead message are measured misses too. None of those three counts.
    expect(result.undatedOnlySkipped).toBe(1);
    for (const row of result.rows) {
      expect(Date.parse(row.hit.writtenAt ?? '')).toBeGreaterThanOrEqual(
        CUTOFF,
      );
    }
    // Without the filter every one of them matches and nothing is counted.
    const all = searchCorpus(corpus, pattern('needle'), {limit: 0});
    expect(all.matched).toBe(7);
    expect(all.undatedOnlySkipped).toBe(0);
  });

  test('DATE BEFORE DEDUPE: an undated bead field and a dated log line hold the same words; the session is kept', () => {
    const words = 'fix the flaky upload';
    const corpus = buildCorpus(
      [thread('th-1', {sessionId: 's1'}, {title: words})],
      [],
      [
        {
          lines: [
            {
              at: ago(DAY),
              cwd: null,
              event: 'UserPromptSubmit',
              role: 'user',
              text: words,
            },
          ],
          path: '/m/s1.jsonl',
          sessionId: 's1',
        },
      ],
    );
    // Without the filter the two are ONE snippet, and it is the dated log
    // line's (home-base-c82t4.4 F5): the title is still a matched field.
    const plain = firstRow(searchCorpus(corpus, pattern('flaky upload')));
    expect(plain.hits).toHaveLength(1);
    expect(plain.hit.field).toMatch(/^you · /u);
    expect(plain.matchedFields[0]).toBe('title');
    const since = searchCorpus(corpus, pattern('flaky upload'), {
      writtenSince: CUTOFF,
    });
    expect(since.rows.map((row) => row.sessionId)).toEqual(['s1']);
    expect(since.undatedOnlySkipped).toBe(0);
    expect(firstRow(since).hit.field).toMatch(/^you · /u);
  });

  test('F5 (home-base-c82t4.4): the dedupe keeps the dated copy of a snippet, in the place the undated copy held', () => {
    const snippet = (match: string): SearchHit['snippet'] => ({
      after: ' here',
      before: 'the ',
      match,
    });
    const hits: SearchHit[] = [
      {
        field: 'title',
        section: null,
        snippet: snippet('needle'),
        writtenAt: null,
      },
      {
        field: 'notes',
        section: null,
        snippet: snippet('other needle'),
        writtenAt: null,
      },
      {
        field: 'you · 2026-09-18 10:00',
        section: null,
        snippet: snippet('needle'),
        writtenAt: '2026-09-18T10:00:00.000Z',
      },
      // A second dated copy does not replace the first dated one.
      {
        field: 'Claude · 2026-09-18 11:00',
        section: null,
        snippet: snippet('needle'),
        writtenAt: '2026-09-18T11:00:00.000Z',
      },
      // An undated copy never replaces anything.
      {
        field: 'description',
        section: null,
        snippet: snippet('other needle'),
        writtenAt: null,
      },
    ];
    const match = dedupeHits(hits);
    expect(match?.hits.map((hit) => hit.field)).toEqual([
      'you · 2026-09-18 10:00',
      'notes',
    ]);
    expect(match?.hit.writtenAt).toBe('2026-09-18T10:00:00.000Z');
    expect(match?.matchedFields).toEqual(hits.map((hit) => hit.field));
  });

  test('a bead message names when it was written in its label; the title and notes have no date', () => {
    const at = '2026-09-18T10:00:00.000Z';
    const local = `${formatLocalDate(new Date(at))} ${formatLocalTime(new Date(at)).slice(0, 5)}`;
    const row = firstRow(
      searchCorpus(
        buildCorpus(
          [
            thread(
              'th-1',
              {
                firstUserMessage: 'a needle',
                firstUserMessageAt: at,
                sessionId: 's1',
              },
              {notes: 'the needle again'},
            ),
          ],
          [],
        ),
        pattern('needle'),
      ),
    );
    expect(row.hit.writtenAt).toBe(at);
    expect(hitLabel(row.hit)).toBe(`firstUserMessage (${local})`);
    expect(row.hits[1]?.writtenAt).toBeNull();
    const text = renderSearchRow(row, NOW, {color: false});
    expect(text).toMatch(
      new RegExp(`Matched: +firstUserMessage \\(${local}\\)`, 'u'),
    );
    expect(text).toContain('Match (notes):');
  });

  test('end to end: the JSON carries the cutoff and the count, the text says it, a bad value exits 2', async () => {
    const h = harness();
    seedThreads(h, [
      thread('th-notes', {sessionId: 's-notes'}, {notes: 'a needle'}),
      thread('th-new', {sessionId: 's-new'}, {title: 'something else'}),
    ]);
    writeLog(h, 's-new', [{at: ago(DAY), cwd: null, text: 'a needle'}]);

    const out = captureStdout();
    expect(
      await runThreadSearch({
        env: h.env,
        json: true,
        now: NOW,
        query: 'needle',
        writtenSince: '3d',
      }),
    ).toBe(0);
    const json = parseSearchJson(out.join(''));
    expect(json.writtenSince).toBe(new Date(CUTOFF).toISOString());
    expect(json.undatedOnlySkipped).toBe(1);
    expect(json.rows.map((row) => row.sessionId)).toEqual(['s-new']);

    out.length = 0;
    await runThreadSearch({
      color: false,
      env: h.env,
      now: NOW,
      query: 'needle',
      writtenSince: '3d',
    });
    expect(out.join('')).toContain(
      '1 session matched only in undated text (the title, the notes or the bead body) and is not shown; drop --written-since to see it',
    );

    const err = captureStderr();
    expect(
      await runThreadSearch({
        env: h.env,
        now: NOW,
        query: 'needle',
        writtenSince: 'last week',
      }),
    ).toBe(2);
    expect(err.join('\n')).toContain(
      '--written-since takes 24h, 3d or 2w (a whole number above 0 and h, d or w) or a date as YYYY-MM-DD; not "last week"',
    );
  });
});

describe('thread search --help (home-base-c82t4.4 F4)', () => {
  test('EXIT names the two new exit-2 causes, and --repo and --written-since each have a paragraph', () => {
    const cli = join(import.meta.dir, '..', 'src', 'cli.ts');
    const help = Bun.spawnSync(
      [process.execPath, cli, 'thread', 'search', '--help'],
      {
        env: {...process.env, JUSTIN_SDK_HEALTH_NOTICES: 'off', NO_COLOR: '1'},
        stdin: 'ignore',
      },
    );
    expect(help.exitCode).toBe(0);
    // Compared with the whitespace folded: yargs may re-wrap the epilogue.
    const text = help.stdout.toString().replace(/\s+/gu, ' ');
    expect(text).toContain(
      'a --repo that names no known project (the known ones are listed) or two of them, or a --written-since that is not 24h, 3d, 2w or YYYY-MM-DD.',
    );
    expect(text).toContain(
      "--repo keeps one project's sessions: a folder name under ~/Dev or its project tag",
    );
    expect(text).toContain('COUNTED in a line under the rows: any of them');
    expect(text).toContain(
      '--written-since filters on when the matching WORDS were written',
    );
    expect(text).toContain(
      'Sessions that match only in undated text (the title, the notes, the bead body) are left out and COUNTED',
    );
  });
});
