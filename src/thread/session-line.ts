/**
 * The prompt-time context line (status report v4, epic home-base-vzwbj.4 D3;
 * built by home-base-vzwbj.4.1).
 *
 * When `componentConfig.thread.sessionBeads` is on, the capture hook's
 * SYNCHRONOUS UserPromptSubmit path injects ONE line into Claude's context on
 * every prompt, so the session's bead stays in Claude's head without a form:
 *
 *   [thread] session <bead id> "<title>" · requests: <n> open, <m> done · new work → bun run justin-sdk thread request "…"
 *
 * IT NEVER CALLS br. Measured 2026-10-11: one `br list` costs ~270 ms against
 * home-base's 11 MB beads DB (the binary itself, mise shim or not), against a
 * hook budget of ~60 ms. So the line is read from files: the sessions index
 * (which DB holds this session) and that DB's own `issues.jsonl` export, which
 * br rewrites after every write (verified for `--db` writes too). Scanning
 * home-base's 6.7 MB export for one label costs ~4 ms.
 *
 * The export can lag the DB when a writer passed `--no-auto-flush`; the line is
 * a reminder for Claude, never a decision input, so a stale count is a smaller
 * harm than a 300 ms prompt. An export that cannot be read is said
 * (`requests: unknown (…)`), never counted as zero (rule 7).
 *
 * DISPATCH 2 extends the line with Justin's answers: `composeSessionLine`
 * takes `extras`, so that is an added part, not a rewrite.
 */

import type {EnvLike} from './paths';

import {existsSync, readFileSync} from 'fs';
import {dirname, join} from 'path';

import {findBeadsDb} from '../beads/br';
import {sdkRun} from '../sdk-invocation';
import {
  answerFrom,
  isAnswered,
  isUndelivered,
  markAnswersDelivered,
  readDeliveredAnswers,
} from './answer-store';
import {probeErrorMessage} from './paths';
// Already in the hook's import graph: capture.ts imports session-bead itself.
import {REQUEST_LABEL, sidLabel} from './session-bead';
import {
  corruptSightingsNote,
  readSessionSightings,
  sessionBeadSighting,
} from './session-index';

export const SESSION_LINE_PREFIX = '[thread]';

/** What the hint tells Claude to run for new work. */
export const REQUEST_HINT = `new work → ${sdkRun('thread request "…"')}`;

export type RequestCounts =
  | {done: number; kind: 'counted'; open: number}
  | {kind: 'unknown'; reason: string};

/** One answer Claude has not been shown yet (R1), restated for Claude. */
export interface LineAnswer {
  answer: string;
  id: string;
  question: string;
}

/** Everything the line says, before it is spelled. */
export type SessionLineParts =
  | {
      /**
       * Answers Claude has not been shown yet (home-base-vzwbj.4.2; delivery,
       * not yield time, since 4.9 R1). Non-empty adds
       * ` · new answers from Justin: <n>` to the line and one bullet per
       * answer under it, so Claude acts on them without running a command.
       */
      answers?: LineAnswer[];
      /** A problem reading the answers (rule 7): said, never read as none. */
      answersProblem?: string | null;
      beadId: string;
      /** Parts later dispatches append (answers). Each is one ` · `-joined part. */
      extras?: string[];
      kind: 'session';
      requests: RequestCounts;
      /** null when the bead's record could not be found in the export. */
      title: string | null;
      titleProblem: string | null;
    }
  | {extras?: string[]; kind: 'notFiledYet'}
  | {kind: 'indexUnreadable'; reason: string};

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function describeCounts(counts: RequestCounts): string {
  if (counts.kind === 'unknown') return `unknown (${oneLine(counts.reason)})`;
  if (counts.open === 0 && counts.done === 0) return 'none yet';
  return `${counts.open} open, ${counts.done} done`;
}

/** Spell the line. One line, always. */
export function composeSessionLine(parts: SessionLineParts): string {
  if (parts.kind === 'indexUnreadable') {
    return `${SESSION_LINE_PREFIX} session bead: unknown (sessions index unreadable: ${oneLine(parts.reason)}) · ${REQUEST_HINT}`;
  }
  const extras = parts.extras ?? [];
  if (parts.kind === 'notFiledYet') {
    return [
      `${SESSION_LINE_PREFIX} session bead: not filed yet (the capture hook files it in the background after this prompt)`,
      'requests: none yet',
      ...extras,
      REQUEST_HINT,
    ].join(' · ');
  }
  const title =
    parts.title != null
      ? `"${oneLine(parts.title)}"`
      : `(title unknown: ${oneLine(parts.titleProblem ?? 'not in the beads export')})`;
  const answers = parts.answers ?? [];
  const answerParts =
    answers.length > 0 ? [`new answers from Justin: ${answers.length}`] : [];
  if (parts.answersProblem != null) {
    answerParts.push(`answers: unknown (${oneLine(parts.answersProblem)})`);
  }
  return [
    `${SESSION_LINE_PREFIX} session ${parts.beadId} ${title}`,
    `requests: ${describeCounts(parts.requests)}`,
    ...answerParts,
    ...extras,
    REQUEST_HINT,
  ].join(' · ');
}

/**
 * The whole injected context: the one line, then — only when Justin answered
 * something Claude has not been shown yet — one bullet per answer, the question and
 * his answer verbatim (epic D3: "any answers Justin recorded since Claude last
 * yielded (verbatim, since they are actionable)").
 */
export function composeSessionContext(parts: SessionLineParts): string {
  const line = composeSessionLine(parts);
  const answers = parts.kind === 'session' ? (parts.answers ?? []) : [];
  if (answers.length === 0) return line;
  return [
    line,
    ...answers.map(
      (entry) =>
        `- ${oneLine(entry.question)} (${entry.id}) → Justin: ${entry.answer}`,
    ),
  ].join('\n');
}

/**
 * Is there a br workspace for `cwd`'s checkout? FILES ONLY (the hook cannot
 * afford a git subprocess per prompt): walk up to the first directory holding
 * `.git` (a directory, or a worktree's file) and look for `.beads/*.db` there.
 * The capture child uses `git rev-parse --show-toplevel`; in an ordinary
 * checkout or worktree the two agree. This only picks the wording of the
 * not-filed-yet line, never whether a bead is created.
 */
export function beadsWorkspaceNear(cwd: string): boolean {
  let dir = cwd;
  for (;;) {
    if (existsSync(join(dir, '.git'))) {
      return findBeadsDb(join(dir, '.beads')).kind === 'found';
    }
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

interface ExportedIssue {
  /** `close_reason` — an answer is `answer: <text>`. */
  closeReason: string | null;
  /** `closed_at` (home-base-vzwbj.4.2: answers since the last yield). */
  closedAt: string | null;
  id: string;
  issueType: string | null;
  labels: string[];
  status: string | null;
  title: string | null;
}

/**
 * The records in one `.beads/issues.jsonl` that carry `sid:<sessionId>`.
 * Only lines containing the label text are parsed. A line that mentions the
 * label but does not parse is a failure, not a skip.
 */
export function readExportedSessionIssues(
  beadsDir: string,
  sessionId: string,
): {issues: ExportedIssue[]; ok: true} | {ok: false; reason: string} {
  const path = join(beadsDir, 'issues.jsonl');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return {
      ok: false,
      reason: `could not read ${path}: ${probeErrorMessage(error)}`,
    };
  }
  const label = sidLabel(sessionId);
  const needle = JSON.stringify(label);
  const issues: ExportedIssue[] = [];
  if (!text.includes(needle)) return {issues, ok: true};
  for (const raw of text.split('\n')) {
    if (!raw.includes(needle)) continue;
    let record: unknown;
    try {
      record = JSON.parse(raw);
    } catch (error) {
      return {
        ok: false,
        reason: `a line of ${path} carrying ${needle} is not JSON: ${probeErrorMessage(error)}`,
      };
    }
    if (record == null || typeof record !== 'object') {
      return {
        ok: false,
        reason: `a line of ${path} carrying ${needle} is not an object`,
      };
    }
    const value = record as Record<string, unknown>;
    if (typeof value.id !== 'string') {
      return {
        ok: false,
        reason: `a line of ${path} carrying ${needle} has no id`,
      };
    }
    const labels = Array.isArray(value.labels)
      ? value.labels.filter(
          (entry): entry is string => typeof entry === 'string',
        )
      : [];
    // The substring scan is a prefilter; the LABEL decides. Text that merely
    // contains the label (a description quoting it) is not this session's.
    if (!labels.includes(label)) continue;
    issues.push({
      closeReason:
        typeof value.close_reason === 'string' ? value.close_reason : null,
      closedAt: typeof value.closed_at === 'string' ? value.closed_at : null,
      id: value.id,
      issueType: typeof value.issue_type === 'string' ? value.issue_type : null,
      labels,
      status: typeof value.status === 'string' ? value.status : null,
      title: typeof value.title === 'string' ? value.title : null,
    });
  }
  return {issues, ok: true};
}

/**
 * The line's facts for `sessionId`, or null when there is nothing to say: no
 * session bead is recorded AND the cwd's checkout has no br workspace (so none
 * will be filed).
 */
export function sessionLineParts(input: {
  cwd: string | null;
  env: EnvLike;
  sessionId: string;
}): SessionLineParts | null {
  const read = readSessionSightings(input.sessionId, input.env);
  if (read.kind === 'failed') {
    return {kind: 'indexUnreadable', reason: `${read.path}: ${read.error}`};
  }
  const sightings = read.kind === 'read' ? read.sightings : [];
  const sessionSighting = sessionBeadSighting(sightings);
  // R9 (home-base-vzwbj.4.9): a corrupt index line that mentions this session
  // (a half-written `created` line) is said, never read as "not filed yet".
  const corruptNote = corruptSightingsNote(read);
  const corruptParts = corruptNote != null ? [`⚠️ ${corruptNote}`] : [];
  if (sessionSighting == null) {
    if (
      corruptNote == null &&
      (input.cwd == null || !beadsWorkspaceNear(input.cwd))
    ) {
      return null;
    }
    return {extras: corruptParts, kind: 'notFiledYet'};
  }

  // Union every DB the index names for this session (requests adopted with
  // `thread request --bead` can live in a second checkout's DB).
  const byId = new Map<string, ExportedIssue>();
  const problems: string[] = [];
  const dirs = [...new Set(sightings.map((entry) => entry.beadsDir))];
  for (const dir of dirs) {
    const exported = readExportedSessionIssues(dir, input.sessionId);
    if (!exported.ok) {
      problems.push(exported.reason);
      continue;
    }
    for (const issue of exported.issues) byId.set(issue.id, issue);
  }

  const bead = byId.get(sessionSighting.beadId) ?? null;
  const requests = [...byId.values()].filter(
    (issue) =>
      issue.labels.includes(REQUEST_LABEL) && issue.status !== 'tombstone',
  );
  const done = requests.filter((issue) => issue.status === 'closed').length;

  // Answers Claude has not been shown yet (R1): closed questions whose close
  // reason is an answer and whose id is not in the delivered marker. Only read
  // when the session has an answered question at all, so the common prompt
  // pays nothing.
  const answeredEver = [...byId.values()].filter(isAnswered);
  let answers: LineAnswer[] = [];
  let answersProblem: string | null = null;
  if (answeredEver.length > 0) {
    const delivered = readDeliveredAnswers(input.sessionId, input.env);
    if (delivered.kind === 'failed') {
      answersProblem = `${delivered.reason}; every answer is listed`;
    }
    answers = answeredEver
      .filter((issue) => isUndelivered(issue, delivered))
      .map((issue) => ({
        answer: answerFrom(issue.closeReason) ?? '',
        id: issue.id,
        question: issue.title ?? '(question title unknown)',
      }));
  }
  if (problems.length > 0) {
    answersProblem = 'beads export unreadable';
  }
  return {
    answers,
    answersProblem,
    beadId: sessionSighting.beadId,
    extras: corruptParts,
    kind: 'session',
    requests:
      problems.length > 0
        ? {kind: 'unknown', reason: problems.join('; ')}
        : {done, kind: 'counted', open: requests.length - done},
    title: bead?.title ?? null,
    titleProblem:
      bead == null
        ? problems.length > 0
          ? 'beads export unreadable'
          : `${sessionSighting.beadId} is not in ${join(sessionSighting.beadsDir, 'issues.jsonl')} yet`
        : null,
  };
}

/** The line itself, or null when there is nothing to say. */
export function sessionContextLine(input: {
  cwd: string | null;
  env: EnvLike;
  sessionId: string;
}): string | null {
  const parts = sessionLineParts(input);
  if (parts == null) return null;
  const context = composeSessionContext(parts);
  // R1: the answers in this context are now delivered to Claude. A marker that
  // cannot be written only means they show again on the next prompt.
  const shown = parts.kind === 'session' ? (parts.answers ?? []) : [];
  if (shown.length > 0) {
    markAnswersDelivered(
      input.sessionId,
      shown.map((entry) => entry.id),
      input.env,
    );
  }
  return context;
}
