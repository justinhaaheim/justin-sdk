/**
 * `thread search` — find the session in which a phrase was written (K8).
 *
 * Justin, 2026-09-18: "It's currently astonishingly difficult to search through
 * my previous claude code conversations to find a specific one, even when I know
 * an entire phrase." This is the answer to that, and its whole design follows
 * from one observation of his: 98% of the text he wants is in something he typed
 * or in a status report Claude wrote back. Both of those are already on the
 * thread bead (k0b8n.1 put them there verbatim, k0b8n.3 backfilled every session
 * that never reported), so the corpus is a few hundred beads plus the report
 * archive — small enough that plain substring matching in process beats any
 * index, and honest enough that "N sessions searched" is a number we can say.
 *
 * THE CORPUS IS TWO READS, NEVER MORE.
 *
 *   1. ONE `bd list -t thread --all` (`listThreads(ctx, {includeClosed: true})`,
 *      the same read the board and the backfill use). Closed threads included:
 *      a finished session is exactly the one whose phrase Justin is trying to
 *      find again.
 *   2. Every `<state>/reports/<sessionId>/*.json` the archive holds. These cover
 *      the reports written BEFORE K4 existed, whose bead never carried the
 *      verbatim messages, and they are the only record of a session whose bead
 *      was lost.
 *
 * A report archive whose session has a thread is attributed to that thread's row
 * — one row per session, never two. One without gets its own row built from what
 * the JSON carries.
 *
 * RULE 7 IS THE POINT OF THE EXIT CODES. `0` matches, `1` a MEASURED none, `2`
 * could not search. A failed bd read, an unreadable archive and an invalid regex
 * are all `2`, because "I found nothing" and "I could not look" are different
 * facts and the reassuring one is the dangerous one: a search that silently
 * skipped half the corpus and printed "no matches" would send Justin off to
 * re-do work he had already done.
 *
 * ANTI-DECISIONS (K8): ripgrep straight over ~/.claude/projects — rejected, it
 * matches tool output and injected noise, has no session metadata and cannot say
 * how many sessions it looked at; an index or FTS table — rejected, the corpus is
 * a few hundred beads and the measured wall time is on home-base-k0b8n.2.
 */

import type {BdIssue} from './bd';
import type {MessageLine} from './message-log';
import type {EnvLike} from './paths';

import {readdirSync, readFileSync} from 'fs';
import {join} from 'path';

import {
  BODY_COLUMN,
  HEADER_COLUMN,
  pad,
  paint,
  shouldStyle,
  terminalWidth,
  wrapHanging,
} from '../cli-style';
import {formatLocalDate, formatLocalTime} from '../date';
import {messagesDir, reportsRootDir} from './archive';
import {bdContext, describeBdFailure, listThreads} from './bd';
import {formatAge} from './board';
import {readMessageLogAt} from './message-log';
import {probeErrorMessage} from './paths';

/** Rows printed before the `N more (--limit)` line. `0` means every row. */
export const DEFAULT_SEARCH_LIMIT = 20;

/** Characters of context kept on each side of the match (K8). */
export const SNIPPET_RADIUS = 80;

const MS_PER_DAY = 86_400_000;

/**
 * Which fields of a thread bead are searched, IN THE ORDER THEY ARE TRIED.
 *
 * The order decides which field the one snippet comes from when several match,
 * and it is not alphabetical on purpose: the title is what the row already
 * shows, then the three verbatim messages (what Justin actually typed and what
 * Claude actually answered — the 98% case), and only then the bead body, whose
 * `description` is mostly the boilerplate header every backfilled bead shares.
 */
export const THREAD_SEARCH_FIELDS = [
  'title',
  'firstUserMessage',
  'lastUserMessage',
  'lastAssistantMessage',
  'notes',
  'description',
] as const;

export type ThreadSearchField = (typeof THREAD_SEARCH_FIELDS)[number];

// ---------------------------------------------------------------------------
// The pattern
// ---------------------------------------------------------------------------

/** Every character that means something to a RegExp, neutralised. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export type CompiledQuery =
  | {ok: true; value: RegExp}
  | {error: string; ok: false};

/**
 * The query as one case-insensitive RegExp.
 *
 * SUBSTRING MODE GOES THROUGH A REGEXP TOO, rather than
 * `toLowerCase().indexOf()`, and that is a correctness choice, not a shortcut:
 * `toLowerCase` is not length-preserving in Unicode ('İ' lowercases to two code
 * units), so an index measured on the lowercased copy can point at the wrong
 * character of the original — and the snippet would be cut in the wrong place
 * with the highlight over the wrong letters. The `i` flag matches without
 * rewriting the string, so every index is an index into the text we display.
 *
 * The words are joined by the CALLER into one phrase (K8): `thread search make
 * them searchable` looks for that phrase, not for three separate words.
 *
 * A SPACE IN A PLAIN QUERY MATCHES ANY RUN OF WHITESPACE (K8 as amended
 * 2026-09-19, k0b8n.7 F2). Justin's messages are dictated, so the stored text
 * carries hard newlines in places he never paused: searching `make them
 * searchable` for a message that reads `make them\nsearchable` found nothing,
 * which is the single most likely way a real search of his fails. Every run of
 * whitespace in the phrase therefore compiles to `\s+`. `--regex` is untouched —
 * there, whitespace is whatever the pattern says it is.
 */
export function compileQuery(
  query: string,
  options: {regex?: boolean} = {},
): CompiledQuery {
  // Escape FIRST, then loosen: escapeRegExp leaves whitespace alone (it is not
  // a metacharacter), so the runs that survive into the escaped source are
  // exactly the ones the user typed, and a backslash they typed is already
  // doubled and cannot swallow the `\s+` that replaces the space after it.
  const source =
    options.regex === true
      ? query
      : escapeRegExp(query).replace(/\s+/g, '\\s+');
  try {
    return {ok: true, value: new RegExp(source, 'i')};
  } catch (error) {
    return {error: probeErrorMessage(error), ok: false};
  }
}

// ---------------------------------------------------------------------------
// Snippets
// ---------------------------------------------------------------------------

export interface SearchSnippet {
  /** Up to SNIPPET_RADIUS characters after the match, with a leading '…' when cut. */
  after: string;
  /** Up to SNIPPET_RADIUS characters before the match, with a trailing '…' when cut. */
  before: string;
  /** The matched text itself, exactly as it appears in the field. */
  match: string;
}

/**
 * Whitespace collapsed to single spaces so a snippet is ONE line.
 *
 * Done per part (before / match / after) AFTER the slice, never before, so the
 * offsets the match was found at still address the characters we cut on.
 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ');
}

/** ±SNIPPET_RADIUS characters around one match, ready to print. */
export function buildSnippet(
  text: string,
  index: number,
  length: number,
): SearchSnippet {
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(text.length, index + length + SNIPPET_RADIUS);
  const before = oneLine(text.slice(start, index));
  const after = oneLine(text.slice(index + length, end));
  return {
    after: end < text.length ? `${after}…` : after,
    before: start > 0 ? `…${before}` : before,
    match: oneLine(text.slice(index, index + length)),
  };
}

function firstMatch(pattern: RegExp, text: string): SearchSnippet | null {
  // `exec` on a non-global RegExp always starts at 0 and never carries
  // lastIndex between calls, so one shared pattern is safe across every field.
  const found = pattern.exec(text);
  if (found == null) return null;
  return buildSnippet(text, found.index, found[0].length);
}

// ---------------------------------------------------------------------------
// The archive half of the corpus
// ---------------------------------------------------------------------------

export interface ArchivedReportFile {
  /** The parsed JSON. Every string value in it is searched, whatever its shape. */
  document: unknown;
  path: string;
  repo: string | null;
  reportedAt: string | null;
  resumeCommand: string | null;
  sessionId: string | null;
  title: string | null;
}

export interface ArchiveReadResult {
  /** One line per thing that could not be read. Never silently empty. */
  failures: string[];
  files: ArchivedReportFile[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function errorCode(error: unknown): string {
  return error != null && typeof error === 'object' && 'code' in error
    ? String((error as {code: unknown}).code)
    : '';
}

function readArchivedFile(path: string): ArchivedReportFile | string {
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return `read ${path}: ${probeErrorMessage(error)}`;
  }
  const doc = asRecord(document) ?? {};
  const facts = asRecord(doc.facts) ?? {};
  const payload = asRecord(doc.payload) ?? {};
  return {
    document,
    path,
    repo: asText(facts.repo),
    reportedAt: asText(doc.reportedAt) ?? asText(facts.reportedAt),
    // Archives written before K4 have no resumeCommand at all — null, not a
    // command we invented from a cwd we did not measure.
    resumeCommand: asText(facts.resumeCommand),
    sessionId: asText(doc.sessionId) ?? asText(facts.sessionId),
    title: asText(payload.title),
  };
}

/**
 * Every archived report payload on disk.
 *
 * A MISSING ROOT IS AN ANSWER, NOT A FAILURE: the directory is created by the
 * first archive write, so ENOENT means "this machine has archived nothing" — the
 * same distinction `newestArchivedReportAt` draws. Anything else (a sandbox
 * denial, a file where the directory should be) is a named failure, because a
 * search that quietly skipped the archive would report a smaller corpus as if it
 * were the whole one.
 */
export function readArchivedReports(
  env: EnvLike = process.env,
): ArchiveReadResult {
  const root = reportsRootDir(env);
  const failures: string[] = [];
  const files: ArchivedReportFile[] = [];

  let sessions: string[];
  try {
    sessions = readdirSync(root);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return {failures, files};
    return {
      failures: [`readdir ${root}: ${probeErrorMessage(error)}`],
      files,
    };
  }

  for (const session of sessions.sort()) {
    const dir = join(root, session);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (error) {
      // A plain file beside the per-session directories is not a failure worth
      // shouting about — but anything else is, so ENOTDIR is the only pass.
      if (errorCode(error) !== 'ENOTDIR') {
        failures.push(`readdir ${dir}: ${probeErrorMessage(error)}`);
      }
      continue;
    }
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue;
      const read = readArchivedFile(join(dir, name));
      if (typeof read === 'string') failures.push(read);
      else files.push(read);
    }
  }
  return {failures, files};
}

/**
 * Every string inside a parsed archive, with the JSON path that holds it.
 *
 * Walked generically rather than against the payload schema on purpose: the
 * archive exists precisely because payloads written by older builds have fields
 * this build does not know about, and a hardcoded field list would make those
 * unsearchable — the opposite of why the archive is in the corpus at all.
 */
export function collectStrings(
  value: unknown,
  path: string,
  out: {path: string; text: string}[],
): void {
  if (typeof value === 'string') {
    if (value !== '') out.push({path, text: value});
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectStrings(item, `${path}[${index}]`, out);
    });
    return;
  }
  const record = asRecord(value);
  if (record == null) return;
  for (const [key, child] of Object.entries(record)) {
    collectStrings(child, path === '' ? key : `${path}.${key}`, out);
  }
}

// ---------------------------------------------------------------------------
// The message-log half of the corpus (K10 f)
// ---------------------------------------------------------------------------

export interface SessionMessageLog {
  lines: MessageLine[];
  path: string;
  sessionId: string;
}

export interface MessageLogsRead {
  /** One line per log (or log line) that could not be read. */
  failures: string[];
  logs: SessionMessageLog[];
}

/**
 * Every `<state>/messages/<sessionId>.jsonl` (K10 f) — every prompt and every
 * turn's final Claude message, which is what finds a phrase from the MIDDLE of
 * a session: the bead only carries the first and last of each.
 *
 * A MISSING DIRECTORY IS AN ANSWER (nothing has been captured or backfilled
 * yet); anything else unreadable is a named failure, as for the archive.
 */
export function readMessageLogs(env: EnvLike = process.env): MessageLogsRead {
  const root = messagesDir(env);
  const failures: string[] = [];
  const logs: SessionMessageLog[] = [];
  let names: string[];
  try {
    names = readdirSync(root);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return {failures, logs};
    return {failures: [`readdir ${root}: ${probeErrorMessage(error)}`], logs};
  }
  for (const name of names.sort()) {
    if (!name.endsWith('.jsonl')) continue;
    const read = readMessageLogAt(join(root, name));
    if (read.kind === 'failed') {
      failures.push(`read ${read.path}: ${read.error}`);
      continue;
    }
    if (read.kind === 'missing') continue; // removed between readdir and read
    failures.push(...read.failures);
    logs.push({
      lines: read.lines,
      path: read.path,
      sessionId: name.slice(0, -'.jsonl'.length),
    });
  }
  return {failures, logs};
}

/** `you · 2026-09-23 14:05` / `Claude · …` — the field name a log hit prints. */
export function messageFieldName(line: MessageLine): string {
  const who = line.role === 'user' ? 'you' : 'Claude';
  if (line.at == null) return `${who} · time unknown`;
  const at = new Date(line.at);
  if (Number.isNaN(at.getTime())) return `${who} · time unknown`;
  return `${who} · ${formatLocalDate(at)} ${formatLocalTime(at).slice(0, 5)}`;
}

function newestLineAt(lines: readonly MessageLine[]): string | null {
  let newest: string | null = null;
  for (const line of lines) {
    if (line.at != null && (newest == null || line.at > newest))
      newest = line.at;
  }
  return newest;
}

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

/** One searchable session: its thread bead, its archived reports, its message log — any of them. */
export interface CorpusSession {
  /** Newest of lastActivityAt / reportedAt / startedAt. Null = the bead dates itself nowhere. */
  activityAt: string | null;
  archives: ArchivedReportFile[];
  /** The session's message log (K10 f), or null when it has none. */
  messageLog: SessionMessageLog | null;
  repo: string | null;
  resumeCommand: string | null;
  sessionId: string | null;
  thread: BdIssue | null;
  threadId: string | null;
  title: string;
}

function metaOf(issue: BdIssue): Record<string, unknown> {
  return issue.metadata ?? {};
}

/**
 * When this session was last alive, for the ordering (K8: last activity desc).
 *
 * `lastActivityAt` (what the transcript's last record says) first, then
 * `reportedAt`, then `startedAt` — newest wins among the ones that are there,
 * rather than first-non-null, so a bead that reported after its recorded
 * activity is not sorted by the older stamp.
 */
export function sessionActivityAt(
  meta: Record<string, unknown>,
): string | null {
  const stamps = [
    asText(meta.lastActivityAt),
    asText(meta.reportedAt),
    asText(meta.startedAt),
  ].filter((value): value is string => value != null);
  if (stamps.length === 0) return null;
  return stamps.sort().at(-1) ?? null;
}

function newestReportedAt(files: readonly ArchivedReportFile[]): string | null {
  const stamps = files
    .map((file) => file.reportedAt)
    .filter((value): value is string => value != null);
  if (stamps.length === 0) return null;
  return stamps.sort().at(-1) ?? null;
}

/**
 * Fold the two reads into one row per SESSION.
 *
 * Keyed on `metadata.sessionId`; a thread bead without one keys on its own bead
 * id, so it is still searched rather than colliding with every other session-less
 * bead under a shared empty key.
 */
export function buildCorpus(
  threads: readonly BdIssue[],
  archives: readonly ArchivedReportFile[],
  logs: readonly SessionMessageLog[] = [],
): CorpusSession[] {
  const bySession = new Map<string, CorpusSession>();
  const order: CorpusSession[] = [];

  for (const thread of threads) {
    const meta = metaOf(thread);
    const sessionId = asText(meta.sessionId);
    const session: CorpusSession = {
      activityAt: sessionActivityAt(meta),
      archives: [],
      messageLog: null,
      repo: asText(meta.repo),
      resumeCommand: asText(meta.resumeCommand),
      sessionId,
      thread,
      threadId: thread.id,
      title: asText(thread.title) ?? '(untitled)',
    };
    order.push(session);
    // A DUPLICATE sessionId keeps the first bead as the row's identity and the
    // second stays its own row: two beads for one session is a data problem the
    // backfill reports (D1), and hiding one of them here would make it invisible.
    if (sessionId != null && !bySession.has(sessionId)) {
      bySession.set(sessionId, session);
    }
  }

  const archiveOnly = new Map<string, ArchivedReportFile[]>();
  for (const file of archives) {
    const sessionId = file.sessionId;
    const existing = sessionId == null ? undefined : bySession.get(sessionId);
    if (existing != null) {
      existing.archives.push(file);
      continue;
    }
    const key = sessionId ?? `path:${file.path}`;
    const bucket = archiveOnly.get(key);
    if (bucket == null) archiveOnly.set(key, [file]);
    else bucket.push(file);
  }

  for (const [key, files] of archiveOnly) {
    const newest = [...files].sort((a, b) =>
      (a.reportedAt ?? '') < (b.reportedAt ?? '') ? 1 : -1,
    );
    const head = newest[0];
    const row: CorpusSession = {
      activityAt: newestReportedAt(files),
      archives: newest,
      messageLog: null,
      repo: head?.repo ?? null,
      resumeCommand: head?.resumeCommand ?? null,
      sessionId: key.startsWith('path:') ? null : key,
      thread: null,
      threadId: null,
      title: head?.title ?? '(archived report, no thread bead)',
    };
    order.push(row);
    if (row.sessionId != null) bySession.set(row.sessionId, row);
  }

  // THE MESSAGE LOGS (K10 f): attached to the session's row when it has one;
  // otherwise their own row, titled by the first thing Justin said, so a
  // session whose bead was lost is still findable. A log is newer than the bead
  // more often than not (capture writes it first), so it can move the row's
  // activity forward — never back.
  for (const log of logs) {
    const newest = newestLineAt(log.lines);
    const existing = bySession.get(log.sessionId);
    if (existing != null) {
      existing.messageLog = log;
      if (
        newest != null &&
        (existing.activityAt == null || newest > existing.activityAt)
      ) {
        existing.activityAt = newest;
      }
      continue;
    }
    const firstUser = log.lines.find((line) => line.role === 'user');
    const firstLine =
      firstUser?.text
        .split('\n')
        .map((candidate) => candidate.trim())
        .find((candidate) => candidate !== '') ?? null;
    const row: CorpusSession = {
      activityAt: newest,
      archives: [],
      messageLog: log,
      repo: null,
      resumeCommand: null,
      sessionId: log.sessionId,
      thread: null,
      threadId: null,
      title:
        firstLine == null
          ? '(message log, no thread bead)'
          : firstLine.length <= 100
            ? firstLine
            : `${firstLine.slice(0, 99)}…`,
    };
    order.push(row);
    bySession.set(log.sessionId, row);
  }

  // Newest archive first within a thread's row too, so the snippet comes from
  // the most recent report rather than whichever file sorted first by name.
  for (const session of order) {
    session.archives.sort((a, b) =>
      (a.reportedAt ?? '') < (b.reportedAt ?? '') ? 1 : -1,
    );
  }
  return order;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export interface SearchHit {
  /** Which field matched: a bead field name, or `archived report <stamp> · <json path>`. */
  field: string;
  snippet: SearchSnippet;
}

/** What one session matched: the first field (with its snippet) and every other one. */
export interface SessionMatch {
  hit: SearchHit;
  /**
   * EVERY field that matched, first included, in the order they were tried.
   *
   * K8 prints one snippet per session, which used to leave "the phrase is also
   * in the report" invisible (k0b8n.7 F4): a hit in `title` alone and a hit in
   * `title` plus `lastAssistantMessage` rendered identically, so the row could
   * not tell you that the session had answered the thing you asked.
   */
  matchedFields: string[];
}

/** Names of the other fields, for the ' (+N more fields: …)' suffix. */
export const MATCHED_FIELDS_NAMED = 3;

export interface SearchRow {
  activityAt: string | null;
  /** How many archived report files this session has. 0 is a measured zero. */
  archivedReports: number;
  hit: SearchHit;
  /** Every field of this session that matched, the one in `hit` first (F4). */
  matchedFields: string[];
  repo: string | null;
  resumeCommand: string | null;
  sessionId: string | null;
  threadId: string | null;
  title: string;
}

function threadFieldText(
  thread: BdIssue,
  field: ThreadSearchField,
): string | null {
  const meta = metaOf(thread);
  switch (field) {
    case 'title':
      return asText(thread.title);
    case 'description':
      return asText(thread.description);
    case 'notes':
      return asText(thread.notes);
    case 'firstUserMessage':
    case 'lastAssistantMessage':
    case 'lastUserMessage':
      return asText(meta[field]);
  }
}

/**
 * Every field of this session that matches, in THREAD_SEARCH_FIELDS order.
 *
 * The FIRST one carries the snippet the row prints; the rest are named. The
 * scan no longer stops at the first hit (F4) — it is the only way the row can
 * say that the phrase is also in the report — and the cost is bounded: the
 * corpus is a few hundred beads and a few dozen archived JSONs, against a bd
 * read that is 70–100% of the wall time (measured on home-base-k0b8n.2).
 */
export function matchSession(
  session: CorpusSession,
  pattern: RegExp,
): SessionMatch | null {
  let hit: SearchHit | null = null;
  const matchedFields: string[] = [];
  const take = (field: string, snippet: SearchSnippet): void => {
    matchedFields.push(field);
    hit ??= {field, snippet};
  };

  if (session.thread != null) {
    for (const field of THREAD_SEARCH_FIELDS) {
      const text = threadFieldText(session.thread, field);
      if (text == null) continue;
      const snippet = firstMatch(pattern, text);
      if (snippet != null) take(field, snippet);
    }
  }
  // Every logged message (K10 f): after the bead's own fields, which already
  // hold the first and last of them, and before the archive.
  for (const line of session.messageLog?.lines ?? []) {
    const snippet = firstMatch(pattern, line.text);
    if (snippet != null) take(messageFieldName(line), snippet);
  }
  for (const file of session.archives) {
    const strings: {path: string; text: string}[] = [];
    collectStrings(file.document, '', strings);
    for (const entry of strings) {
      const snippet = firstMatch(pattern, entry.text);
      if (snippet == null) continue;
      const stamp = file.reportedAt ?? 'undated';
      take(`archived report ${stamp} · ${entry.path}`, snippet);
    }
  }
  return hit == null ? null : {hit, matchedFields};
}

export interface SearchCounts {
  /** Sessions that have at least one archived report. NEVER derived from the count above. */
  archivedReportSessions: number;
  /** Archived report FILES. 48 of these live under 26 session directories here. */
  archivedReports: number;
  /** Sessions with a message log (K10 f). */
  messageLogs: number;
  sessions: number;
  threads: number;
}

/**
 * The four numbers the zero-match line says out loud.
 *
 * `archivedReports` AND `archivedReportSessions` ARE MEASURED SEPARATELY
 * (k0b8n.7 F3), one by summing files and one by counting the rows that have
 * any, because a session reports as often as it likes: on this machine 48 files
 * sit under 26 sessions, and printing only the file count invited reading it as
 * a number of conversations. Neither is computed from the other — a ratio we
 * assumed would be a fact we made up.
 */
export function countCorpus(corpus: readonly CorpusSession[]): SearchCounts {
  return {
    archivedReportSessions: corpus.filter(
      (session) => session.archives.length > 0,
    ).length,
    archivedReports: corpus.reduce(
      (total, session) => total + session.archives.length,
      0,
    ),
    messageLogs: corpus.filter((session) => session.messageLog != null).length,
    sessions: corpus.length,
    threads: corpus.filter((session) => session.thread != null).length,
  };
}

/**
 * Keep only what is inside the window.
 *
 * A SESSION THAT DATES ITSELF NOWHERE IS KEPT. An unknown date is not evidence
 * that it is old, and dropping it would hide a real match behind a filter the
 * user believes only removes old things — the reassuring-direction mistake rule
 * 7 is about. `--help` says so out loud.
 */
export function withinWindow(
  corpus: readonly CorpusSession[],
  days: number | null,
  now: Date,
): CorpusSession[] {
  if (days == null || !Number.isFinite(days) || days <= 0) return [...corpus];
  const cutoff = now.getTime() - days * MS_PER_DAY;
  return corpus.filter((session) => {
    if (session.activityAt == null) return true;
    const at = Date.parse(session.activityAt);
    if (Number.isNaN(at)) return true;
    return at >= cutoff;
  });
}

export interface SearchResult {
  /** Every session that matched, before `--limit` cut the list. */
  matched: number;
  rows: SearchRow[];
}

/** Pure: the corpus, a pattern and a limit in; the rows to print out. */
export function searchCorpus(
  corpus: readonly CorpusSession[],
  pattern: RegExp,
  options: {limit?: number} = {},
): SearchResult {
  const hits: SearchRow[] = [];
  for (const session of corpus) {
    const match = matchSession(session, pattern);
    if (match == null) continue;
    hits.push({
      activityAt: session.activityAt,
      archivedReports: session.archives.length,
      hit: match.hit,
      matchedFields: match.matchedFields,
      repo: session.repo,
      resumeCommand: session.resumeCommand,
      sessionId: session.sessionId,
      threadId: session.threadId,
      title: session.title,
    });
  }
  // Newest first. An undated row sorts LAST rather than first: it is the one we
  // know least about, and putting it above a dated match would be a claim.
  hits.sort((a, b) => {
    const left = a.activityAt ?? '';
    const right = b.activityAt ?? '';
    if (left === right) return 0;
    if (left === '') return 1;
    if (right === '') return -1;
    return left < right ? 1 : -1;
  });
  const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
  return {
    matched: hits.length,
    rows: limit > 0 ? hits.slice(0, limit) : hits,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * The line a MEASURED zero prints (K8). Never printed when anything failed.
 *
 * The archive is counted BOTH WAYS (F3): files, and the sessions they belong
 * to. `48 archived reports` alone reads as 48 conversations when it is 26.
 */
export function noMatchesLine(counts: SearchCounts): string {
  const reports = `${counts.archivedReports} archived report${counts.archivedReports === 1 ? '' : 's'}`;
  const across = `across ${counts.archivedReportSessions} session${counts.archivedReportSessions === 1 ? '' : 's'}`;
  const logs = `${counts.messageLogs} message log${counts.messageLogs === 1 ? '' : 's'}`;
  return `no matches in ${counts.sessions} sessions searched (${counts.threads} threads, ${reports} ${across}, ${logs})`;
}

/** The `N more (--limit)` line, or null when nothing was cut. */
export function moreLine(result: SearchResult): string | null {
  const hidden = result.matched - result.rows.length;
  if (hidden <= 0) return null;
  return `${hidden} more (--limit)`;
}

/**
 * ' (+N more fields: a, b)', or '' when only one field matched (F4).
 *
 * N is the TRUE number of other fields; at most MATCHED_FIELDS_NAMED of them
 * are spelled out, with a '…' when the list was cut — a row whose phrase is in
 * twenty JSON paths of an archived report should say twenty, not print twenty.
 */
export function moreFieldsSuffix(matchedFields: readonly string[]): string {
  const others = matchedFields.slice(1);
  if (others.length === 0) return '';
  const named = others.slice(0, MATCHED_FIELDS_NAMED);
  const cut = others.length > named.length ? ', …' : '';
  return ` (+${others.length} more field${others.length === 1 ? '' : 's'}: ${named.join(', ')}${cut})`;
}

/**
 * One row, man-page style (K11 rules 2–4): the header at the header column in
 * bold with the session id dim; under it at the body column the snippet (the
 * field name dim, the match bold) and the resume command in cyan. The header
 * and snippet hang-wrap on a terminal; the resume command NEVER wraps, because
 * a command broken across lines no longer pastes as one.
 */
export function renderSearchRow(
  row: SearchRow,
  now: Date,
  options: {color?: boolean; width?: number | null} = {},
): string {
  const color = options.color === true;
  const width = options.width ?? null;
  const heading = [
    row.repo ?? '(repo unknown)',
    formatAge(row.activityAt, now),
    oneLine(row.title),
  ].join(' · ');
  const header = `${paint(heading, ['bold'], color)} · ${paint(row.sessionId ?? '(no session id)', ['dim'], color)}`;
  const {after, before, match} = row.hit.snippet;
  const snippet = `${paint(`${row.hit.field}:`, ['dim'], color)} ${before}${paint(match, ['bold'], color)}${after}${paint(moreFieldsSuffix(row.matchedFields), ['dim'], color)}`;
  const resume =
    row.resumeCommand == null
      ? '(no resume command recorded)'
      : paint(row.resumeCommand, ['cyan'], color);
  return [
    wrapHanging(header, {hang: BODY_COLUMN, indent: HEADER_COLUMN, width}),
    wrapHanging(snippet, {hang: BODY_COLUMN, indent: BODY_COLUMN, width}),
    `${pad(BODY_COLUMN)}${resume}`,
  ].join('\n');
}

/** The banner that stops an incomplete search from reading like a complete one. */
export function incompleteLine(failures: readonly string[]): string {
  return `thread search: INCOMPLETE — ${failures.length} part${failures.length === 1 ? '' : 's'} of the corpus could not be read, so what is above is NOT the whole answer`;
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

export interface SearchOptions {
  color?: boolean;
  days?: number | null;
  env?: EnvLike;
  json?: boolean;
  limit?: number;
  now?: Date;
  query: string;
  regex?: boolean;
  /** Wrap width; `terminalWidth()` when absent, null never wraps. */
  width?: number | null;
}

/**
 * `justin-sdk thread search <query…>`.
 *
 * Exit 0 matches, 1 a measured none, 2 could not search. Matches are printed
 * even on the 2 path — finding something and then discovering the corpus was
 * incomplete is still finding something, and throwing it away would help nobody.
 */
export async function runThreadSearch(options: SearchOptions): Promise<number> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const json = options.json === true;
  const color = options.color ?? (json ? false : shouldStyle());

  const compiled = compileQuery(options.query, {regex: options.regex});
  if (!compiled.ok) {
    // Before any read: nothing was searched, and the message is the engine's own
    // so the user can see which character it choked on.
    const line = `thread search: invalid regex /${options.query}/ — ${compiled.error}`;
    if (json) console.log(JSON.stringify({error: line, ok: false}, null, 2));
    else console.error(line);
    return 2;
  }

  const ctx = bdContext(env);
  const threads = await listThreads(ctx, {includeClosed: true});
  if (!threads.ok) {
    const line = `thread search: could not read the thread beads — ${describeBdFailure(threads.failure)}`;
    if (json) console.log(JSON.stringify({error: line, ok: false}, null, 2));
    else console.error(line);
    return 2;
  }

  const archive = readArchivedReports(env);
  const logs = readMessageLogs(env);
  // A log that could not be read makes the search INCOMPLETE exactly as an
  // unreadable archive does (rule 7): exit 2, never a calm "no matches".
  const corpusFailures = [...archive.failures, ...logs.failures];
  const corpus = withinWindow(
    buildCorpus(threads.value, archive.files, logs.logs),
    options.days ?? null,
    now,
  );
  const counts = countCorpus(corpus);
  const result = searchCorpus(corpus, compiled.value, {limit: options.limit});
  const complete = corpusFailures.length === 0;

  if (json) {
    console.log(
      JSON.stringify(
        {
          // BOTH archive numbers (F3): files, and the sessions they sit under.
          archivedReportSessionsSearched: counts.archivedReportSessions,
          archivedReportsSearched: counts.archivedReports,
          complete,
          days: options.days ?? null,
          failures: corpusFailures,
          matched: result.matched,
          messageLogsSearched: counts.messageLogs,
          query: options.query,
          regex: options.regex === true,
          rows: result.rows,
          sessionsSearched: counts.sessions,
          shown: result.rows.length,
          threadsSearched: counts.threads,
        },
        null,
        2,
      ),
    );
    for (const failure of corpusFailures) console.error(`  ⚠️ ${failure}`);
    if (!complete) return 2;
    return result.rows.length > 0 ? 0 : 1;
  }

  // A blank line before every row (K11 rule 1), and before the footnote.
  // A caller that pins the colour (every test; the CLI never does) gets an
  // unwrapped render unless it pins a width too, so a suite run from a real
  // terminal renders exactly what CI does.
  const width =
    options.width !== undefined
      ? options.width
      : options.color === undefined
        ? terminalWidth()
        : null;
  for (const row of result.rows) {
    console.log('');
    console.log(renderSearchRow(row, now, {color, width}));
  }
  const more = moreLine(result);
  if (more != null) {
    console.log('');
    console.log(`${pad(HEADER_COLUMN)}${paint(more, ['dim'], color)}`);
  }

  if (!complete) {
    // NOT the no-matches line, whatever `matched` says: that line CLAIMS the
    // whole corpus was read, and here it was not.
    console.error(incompleteLine(corpusFailures));
    for (const failure of corpusFailures) console.error(`  ⚠️ ${failure}`);
    return 2;
  }
  if (result.matched === 0) {
    console.log(noMatchesLine(counts));
    return 1;
  }
  return 0;
}
