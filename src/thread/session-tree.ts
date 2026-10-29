/**
 * A session's beads, as one tree (status report v4, epic home-base-vzwbj.4 D1;
 * built by home-base-vzwbj.4.3): the session bead, its requests, each
 * request's children, and every question — read from the `.beads/issues.jsonl`
 * EXPORT of every beads DB the sessions index names for the session: the
 * export br writes for that DB, located by `readBeadsExport` (which, for an
 * old worktree entry under a br that shares the primary's DB, is the
 * primary's file; home-base-dj5m9.1.2).
 *
 * WHY THE EXPORT AND NOT `br` (decided by home-base-vzwbj.4.3, measured on
 * home-base's real DB — the numbers are in that bead's notes). `br list --json`
 * carries no parent field, so the tree needs `br show` per request on top of a
 * `br list` per DB, and each br run costs ~270 ms against home-base's 11 MB DB
 * (dispatch 1's measurement). The export carries everything the tree needs —
 * labels, status, priority, description, close reason, AND each record's
 * `dependencies` with `type: parent-child` — so ONE file read per DB answers
 * the whole tree, which is also what the inbox (dispatch 4) needs for dozens of
 * sessions at once. br rewrites the export after every write (`sync.auto_flush:
 * true`, verified for `--db` writes by dispatch 1), so the export lags the DB
 * only behind a writer that passed `--no-auto-flush`, or a bead created
 * `--ephemeral` (never exported). That staleness is the accepted price; an
 * export that cannot be READ is a named problem, never an empty tree (rule 7).
 *
 * WHAT COUNTS AS WHAT
 *  - session bead: the record with the id the index names.
 *  - question: a record labelled `ask` + `sid:<id>` (open and closed).
 *  - request: a record labelled `request` + `sid:<id>`, OR a child of the
 *    session bead that is not a question (design item 1).
 *  - a request's children: records whose parent-child dependency names the
 *    request, one level down, that are not questions.
 *  - a request's questions (home-base-vzwbj.4.16 G1): questions carrying the
 *    request's `to:` label (`toLabel` — `thread ask` files every question
 *    under the SESSION bead and links the request by label), plus old-shape
 *    questions that are the request's parent-child children. They never
 *    decide "every child closed": only P0 blocks, and only through the
 *    status. They are shown once, under "Questions for you".
 *  - tombstones are skipped everywhere.
 *
 * ONE ID, TWO DBs. A worktree's export and its main checkout's share bead ids
 * (the JSONL is committed), so a session whose index names both can see one id
 * twice with diverged state. The record with the newer `updated_at` wins.
 */

import type {BrIssue} from '../beads/br';

import {readFileSync} from 'fs';
import {join} from 'path';

import {parseBrIssues} from '../beads/br';
import {BEADS_JSONL, recordedBeadsJsonl} from '../beads/jsonl';
import {parseInstant} from './answer-store';
import {ASK_LABEL} from './ask-format';
import {probeErrorMessage} from './paths';
import {REQUEST_LABEL, sidLabel, toLabel} from './session-bead';

/** A bead read from an export, with where it lives and who its parents are. */
export interface TreeIssue extends BrIssue {
  /** The `.beads/` directory whose export it came from. */
  beadsDir: string;
  /** Ids this bead is a parent-child CHILD of (normally one). */
  parentIds: string[];
}

export interface RequestNode {
  /** Its children that are not questions, oldest first. */
  children: TreeIssue[];
  /**
   * The questions (`ask`) for this request, open and closed: its `to:` label,
   * or (old shape) its parent-child children. An old-shape one is the one
   * whose `parentIds` holds the request's id.
   */
  questions: TreeIssue[];
  request: TreeIssue;
}

export interface SessionTree {
  /** Exports that could not be read or parsed, each named. */
  problems: string[];
  /** Every question of the session (`ask` + `sid:`), open and closed. */
  questions: TreeIssue[];
  requests: RequestNode[];
  /**
   * The session bead, or null when no export that COULD be read holds it —
   * `problems` then says why (an unreadable export), or it is absent there.
   */
  session: TreeIssue | null;
  /** Set when `session` is null and every export was read: it is not there. */
  sessionMissing: string | null;
}

export type ExportRead =
  | {kind: 'failed'; path: string; reason: string}
  | {kind: 'read'; path: string; text: string};

/**
 * The export br writes for the beads of `beadsDir`, whole. The file is the one
 * beside the DB br uses (`recordedBeadsJsonl`, home-base-dj5m9.1.2): for a
 * linked worktree whose br shares its primary checkout's DB (br 0.4.1 on),
 * the PRIMARY's export, not the worktree's own copy, which stays at the
 * branch's last commit. Under br before 0.4.1 it is `beadsDir`'s own, as
 * before. Not knowing which file it is is a failed read, never a guess.
 */
export function readBeadsExport(beadsDir: string): ExportRead {
  const located = recordedBeadsJsonl(beadsDir);
  if (located.kind === 'failed') {
    return {
      kind: 'failed',
      path: join(beadsDir, BEADS_JSONL),
      reason: located.reason,
    };
  }
  const {path} = located;
  try {
    return {kind: 'read', path, text: readFileSync(path, 'utf8')};
  } catch (error) {
    const code =
      error != null && typeof error === 'object' && 'code' in error
        ? String((error as {code: unknown}).code)
        : null;
    return {
      kind: 'failed',
      path,
      // Still a FAILURE (the tree is unknown, not empty) — said in fewer words.
      reason:
        code === 'ENOENT'
          ? `${path} does not exist`
          : `could not read ${path}: ${probeErrorMessage(error)}`,
    };
  }
}

/** The parent ids in a record's `dependencies` (type parent-child). */
function parentIdsOf(record: Record<string, unknown>, id: string): string[] {
  const deps = record.dependencies;
  if (!Array.isArray(deps)) return [];
  const parents: string[] = [];
  for (const dep of deps) {
    if (dep == null || typeof dep !== 'object') continue;
    const value = dep as Record<string, unknown>;
    if (value.type !== 'parent-child') continue;
    if (value.issue_id !== undefined && value.issue_id !== id) continue;
    if (typeof value.depends_on_id === 'string') {
      parents.push(value.depends_on_id);
    }
  }
  return parents;
}

/** Parse one export line into a TreeIssue, or say why it is not one. */
export function parseExportLine(
  raw: string,
  beadsDir: string,
): {issue: TreeIssue; ok: true} | {ok: false; reason: string} {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return {ok: false, reason: `not JSON: ${probeErrorMessage(error)}`};
  }
  const parsed = parseBrIssues([value]);
  if (!parsed.ok) return {ok: false, reason: parsed.reason};
  const [issue] = parsed.issues;
  if (issue == null) return {ok: false, reason: 'no record'};
  return {
    issue: {
      ...issue,
      beadsDir,
      parentIds: parentIdsOf(value as Record<string, unknown>, issue.id),
    },
    ok: true,
  };
}

/** What looking one id up in one export found. */
export type ExportRecordLookup =
  | {issue: TreeIssue; kind: 'found'}
  | {kind: 'absent'}
  | {kind: 'deleted'}
  | {kind: 'failed'; reason: string};

/**
 * The record with id `id` in one export's text, without splitting the whole
 * file (home-base's export is ~8 MB): `"id":"<id>"` appears only on that
 * record's own line, because dependencies name their ends `issue_id` and
 * `depends_on_id` (the same fact session-created.ts's JSON_ID relies on). A
 * line holding the needle that does not parse is a failure, never "absent":
 * it could be the very record (rule 7).
 */
export function exportRecordById(
  text: string,
  id: string,
  beadsDir: string,
  path: string,
): ExportRecordLookup {
  const needle = `"id":${JSON.stringify(id)}`;
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at === -1) return {kind: 'absent'};
    const start = text.lastIndexOf('\n', at) + 1;
    const newline = text.indexOf('\n', at);
    const end = newline === -1 ? text.length : newline;
    const parsed = parseExportLine(text.slice(start, end), beadsDir);
    if (!parsed.ok) {
      return {
        kind: 'failed',
        reason: `a line of ${path} naming ${id} is not a bead record (${parsed.reason})`,
      };
    }
    if (parsed.issue.id === id) {
      return parsed.issue.status === 'tombstone'
        ? {kind: 'deleted'}
        : {issue: parsed.issue, kind: 'found'};
    }
    from = end;
  }
}

/**
 * Every record of `text` whose line contains one of `needles`, parsed. A line
 * that contains a needle but does not parse is a FAILURE, not a skip: it could
 * be the very bead being looked for.
 */
export function recordsMatching(
  text: string,
  needles: readonly string[],
  beadsDir: string,
  path: string,
): {issues: TreeIssue[]; ok: true} | {ok: false; reason: string} {
  const issues: TreeIssue[] = [];
  if (needles.length === 0) return {issues, ok: true};
  if (!needles.some((needle) => text.includes(needle))) {
    return {issues, ok: true};
  }
  const lines = text.split('\n');
  for (const [index, raw] of lines.entries()) {
    if (raw.trim() === '') continue;
    if (!needles.some((needle) => raw.includes(needle))) continue;
    const parsed = parseExportLine(raw, beadsDir);
    if (!parsed.ok) {
      return {
        ok: false,
        reason: `line ${index + 1} of ${path} is not a bead record (${parsed.reason})`,
      };
    }
    if (parsed.issue.status === 'tombstone') continue;
    issues.push(parsed.issue);
  }
  return {issues, ok: true};
}

function isQuestion(issue: TreeIssue): boolean {
  return issue.labels.includes(ASK_LABEL);
}

/** Oldest first by created_at, then by id, so the order is stable. */
function byCreated(a: TreeIssue, b: TreeIssue): number {
  const at = parseInstant(a.createdAt);
  const bt = parseInstant(b.createdAt);
  if (at != null && bt != null && at !== bt) return at - bt;
  return a.id.localeCompare(b.id, 'en', {numeric: true});
}

/** Keep the newer of two records with one id (see the header). */
function newer(a: TreeIssue, b: TreeIssue): TreeIssue {
  const at = parseInstant(a.updatedAt);
  const bt = parseInstant(b.updatedAt);
  if (at == null) return b;
  if (bt == null) return a;
  return bt > at ? b : a;
}

function addTo(map: Map<string, TreeIssue>, issue: TreeIssue): void {
  const existing = map.get(issue.id);
  map.set(issue.id, existing == null ? issue : newer(existing, issue));
}

/**
 * The session's tree from the exports of `beadsDirs` (the session bead's own
 * DB first, then every other DB the index names).
 */
export function readSessionTree(input: {
  beadsDirs: readonly string[];
  /**
   * How an export is read; default `readBeadsExport`. The inbox passes a
   * reader that reads each export once per run (home-base-vzwbj.4.9 F7).
   */
  readExport?: (beadsDir: string) => ExportRead;
  sessionBeadId: string;
  sessionId: string;
}): SessionTree {
  const {sessionBeadId, sessionId} = input;
  const readExport = input.readExport ?? readBeadsExport;
  const label = sidLabel(sessionId);
  const problems: string[] = [];
  const texts: {beadsDir: string; path: string; text: string}[] = [];
  for (const beadsDir of [...new Set(input.beadsDirs)]) {
    const read = readExport(beadsDir);
    if (read.kind === 'failed') {
      problems.push(read.reason);
      continue;
    }
    texts.push({beadsDir, path: read.path, text: read.text});
  }

  // Pass 1: everything carrying the session's label, and the session bead.
  const labelled = new Map<string, TreeIssue>();
  const quoted = (id: string): string => JSON.stringify(id);
  for (const source of texts) {
    const found = recordsMatching(
      source.text,
      [quoted(label), `"id":${quoted(sessionBeadId)}`],
      source.beadsDir,
      source.path,
    );
    if (!found.ok) {
      problems.push(found.reason);
      continue;
    }
    for (const issue of found.issues) {
      // The substring is a prefilter; the LABEL (or the id) decides.
      if (issue.id === sessionBeadId || issue.labels.includes(label)) {
        addTo(labelled, issue);
      }
    }
  }
  const session = labelled.get(sessionBeadId) ?? null;
  const requests = new Map<string, TreeIssue>();
  const questions = new Map<string, TreeIssue>();
  for (const issue of labelled.values()) {
    if (issue.id === sessionBeadId) continue;
    if (isQuestion(issue)) addTo(questions, issue);
    else if (issue.labels.includes(REQUEST_LABEL)) addTo(requests, issue);
  }

  // Pass 2: children of the session bead that are not questions are requests.
  // Pass 3: children of every request. One scan each, prefiltered on the ids.
  const childrenOf = (
    parentIds: readonly string[],
  ): {issues: TreeIssue[]; problems: string[]} => {
    const parents = new Set(parentIds);
    const issues = new Map<string, TreeIssue>();
    const childProblems: string[] = [];
    for (const source of texts) {
      const found = recordsMatching(
        source.text,
        parentIds.map(quoted),
        source.beadsDir,
        source.path,
      );
      if (!found.ok) {
        childProblems.push(found.reason);
        continue;
      }
      for (const issue of found.issues) {
        if (issue.parentIds.some((parent) => parents.has(parent))) {
          addTo(issues, issue);
        }
      }
    }
    return {issues: [...issues.values()], problems: childProblems};
  };

  const sessionChildren = childrenOf([sessionBeadId]);
  problems.push(...sessionChildren.problems);
  for (const child of sessionChildren.issues) {
    if (isQuestion(child)) addTo(questions, child);
    else addTo(requests, child);
  }

  const requestChildren = childrenOf([...requests.keys()]);
  problems.push(...requestChildren.problems);

  // An `ask` under a request (the OLD shape) is that session's question even
  // when it lacks the sid label (filed with plain br): it is listed once, with
  // the rest.
  for (const issue of requestChildren.issues) {
    if (isQuestion(issue)) addTo(questions, issue);
  }

  const nodes: RequestNode[] = [...requests.values()]
    .sort(byCreated)
    .map((request) => {
      const under = requestChildren.issues.filter((issue) =>
        issue.parentIds.includes(request.id),
      );
      // home-base-vzwbj.4.16 G1: a question is this request's when it carries
      // the request's `to:` label (the shape `thread ask` files), OR when it
      // is the request's parent-child child (the old shape, still in exports).
      const link = toLabel(request.id);
      const linked = new Map<string, TreeIssue>();
      for (const question of questions.values()) {
        if (
          question.labels.includes(link) ||
          question.parentIds.includes(request.id)
        ) {
          addTo(linked, question);
        }
      }
      return {
        children: under.filter((issue) => !isQuestion(issue)).sort(byCreated),
        questions: [...linked.values()].sort(byCreated),
        request,
      };
    });

  const uniqueProblems = [...new Set(problems)];
  return {
    problems: uniqueProblems,
    questions: [...questions.values()].sort(byCreated),
    requests: nodes,
    session,
    sessionMissing:
      session == null && uniqueProblems.length === 0
        ? `${sessionBeadId} is not in ${texts.map((source) => source.path).join(' or ')}`
        : null,
  };
}
