/**
 * `justin-sdk thread show` — the read path for Justin and for the next session
 * (home-base-p1uj D10).
 *
 * The bead's `notes` field already IS the rendered report: that is D10's whole
 * point, so that `bd show` alone is a complete status report if this tool ever
 * breaks. `show` therefore prints the notes rather than re-deriving a report
 * from metadata — re-rendering would give a second, subtly different report
 * for the same bead, and there would then be no way to tell which one Justin
 * had read. (It does run them through `normalizeReportText` on the way out, so
 * a report stored before 2026-09-23 is spaced like a new one; that changes
 * blank lines, heading emojis and a duplicated option letter, never words.)
 *
 * What it ADDS is the half a stored report cannot have: the CURRENT state of
 * the asks, and Justin's answers on them, which arrive as bd comments after the
 * report was written — and the MESSAGES block.
 *
 * LAYOUT (home-base-k0b8n.10, K11): the man-page columns of src/cli-style.ts —
 * section headers at 2, text at 6, an ask's answers at 9 — with a blank line
 * between every item, in a terminal AND in a pipe. Colour and wrapping are the
 * terminal's alone.
 *
 * A BEAD WITH NO REPORT SAYS SO (home-base-k0b8n.14). A thread bead `thread
 * start` or `thread capture` made carries "NO REPORT YET." placeholder notes,
 * and the compact view used to run them through the report compactor, which
 * printed "nothing needs you — nothing went wrong, nothing is blocking" and
 * "NOT RECORDED — no thread bead" about a session that had reported nothing and
 * a bead that existed. Capture makes that the common case. Such a bead now
 * shows `no report yet` as its glance line, the placeholder notes as they are,
 * and the MESSAGES block as its body.
 *
 * Exit 0 = printed · 1 = could not read (never silently empty).
 */

import type {MessageLogRead} from './message-log';
import type {EnvLike} from './paths';

import {
  BODY_COLUMN,
  DETAIL_COLUMN,
  HEADER_COLUMN,
  paint,
  sectionHeader,
  shouldStyle,
  terminalWidth,
  wrapHanging,
} from '../cli-style';
import {
  type BdContext,
  bdContext,
  type BdIssue,
  describeBdFailure,
  findThreadBySession,
  listOpenAsks,
  readComments,
  showIssue,
} from './bd';
import {collectThreadFacts} from './facts';
import {isSafeSessionId, readMessageLog} from './message-log';
import {readAskPriority} from './metadata';
import {priorityLabel} from './render';
import {ansiFromReportText} from './render-ansi';
import {compactStoredReport} from './render-markdown';
import {isRenderedReport} from './report-lines';
import {messageFieldName} from './search';

/** The four MESSAGES rows, in the order Justin reads them (K4). */
const MESSAGE_FIELDS: {key: string; label: string}[] = [
  {key: 'firstUserMessage', label: 'First user message'},
  {key: 'lastUserMessage', label: 'Last user message'},
  {key: 'lastAssistantMessage', label: 'Last Claude response'},
  {key: 'resumeCommand', label: 'Resume'},
];

/** The glance line of a thread that has not reported (k0b8n.14). */
export const NO_REPORT_GLANCE = '⚡ ⏳ no report yet';

/** How `show` prints: colour from `shouldStyle`, width from `terminalWidth`. */
export interface ShowStyle {
  color: boolean;
  width: number | null;
}

const PLAIN: ShowStyle = {color: false, width: null};

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * Why a field is missing, in the words of whoever failed to measure it.
 *
 * `autofillFailures` is the extractor's own list, so the reason is the real one
 * ("no human-authored user record found in …") rather than a guess made here.
 * A missing field with NO recorded reason says so — "(not captured: no reason
 * recorded)" is an honest admission that something wrote a null without saying
 * why, and it is louder than a blank line (rule 7).
 */
function notCaptured(metadata: Record<string, unknown>, key: string): string {
  const failures = metadata.autofillFailures;
  if (Array.isArray(failures)) {
    for (const entry of failures) {
      if (typeof entry === 'string' && entry.startsWith(`${key}:`)) {
        return `(not captured: ${entry.slice(key.length + 1).trim()})`;
      }
    }
  }
  return '(not captured: no reason recorded)';
}

/** A bold label at the header column — one message's heading (K11 rule 2). */
function labelLine(label: string, color: boolean): string {
  return `${' '.repeat(HEADER_COLUMN)}${paint(label, ['bold'], color)}`;
}

/**
 * Verbatim text at the body column, one physical line per line of the text,
 * each wrapped with a hang on a terminal. An empty line inside the text stays
 * empty: indenting it would only add trailing whitespace.
 */
function bodyLines(
  text: string,
  style: ShowStyle,
  styles: Parameters<typeof paint>[1] = [],
): string[] {
  return text.split('\n').map((line) =>
    line === ''
      ? ''
      : wrapHanging(paint(line, styles, style.color), {
          hang: BODY_COLUMN,
          indent: BODY_COLUMN,
          width: style.width,
        }),
  );
}

/**
 * The session's message log as a bead points at it (K10 f).
 *
 * `noSession` is its own outcome, not a missing log: a bead that records no
 * usable session id cannot say whether a log exists, and "there is no log" would
 * be a claim nobody measured (rule 7).
 */
export type SessionLogRead =
  | MessageLogRead
  | {detail: string; kind: 'noSession'};

export function readSessionLog(
  metadata: Record<string, unknown>,
  env: EnvLike = process.env,
): SessionLogRead {
  const sessionId = metadata.sessionId;
  if (typeof sessionId !== 'string' || sessionId === '') {
    return {detail: 'this bead records no sessionId', kind: 'noSession'};
  }
  if (!isSafeSessionId(sessionId)) {
    return {
      detail: `this bead's sessionId ${JSON.stringify(sessionId)} is not a safe file name`,
      kind: 'noSession',
    };
  }
  return readMessageLog(sessionId, env);
}

/**
 * The `N messages captured` line of the MESSAGES block (K10 f), at the body
 * column.
 *
 * Four outcomes, four sentences: a count, a MEASURED absence (the file does not
 * exist — capture never ran and no backfill has written it), a read failure
 * (UNKNOWN plus the error), and a bead with no session to look up.
 */
export function capturedCountLines(
  threadId: string,
  read: SessionLogRead,
): string[] {
  const at = ' '.repeat(BODY_COLUMN);
  switch (read.kind) {
    case 'read': {
      const noun = read.lines.length === 1 ? 'message' : 'messages';
      const lines = [
        `${at}${read.lines.length} ${noun} captured (thread show ${threadId} --messages)`,
      ];
      for (const failure of read.failures) {
        lines.push(`${' '.repeat(DETAIL_COLUMN)}${failure}`);
      }
      return lines;
    }
    case 'missing':
      return [
        `${at}no messages captured — there is no message log at ${read.path}`,
      ];
    case 'failed':
      return [
        `${at}messages captured: UNKNOWN — could not read ${read.path} (${read.error})`,
      ];
    case 'noSession':
      return [`${at}messages captured: UNKNOWN — ${read.detail}`];
  }
}

/**
 * The whole log, for `thread show --messages` (K10 f): the speaker and local
 * time in bold at the header column, the text under it at the body column, a
 * blank line between messages. Verbatim and uncapped, like the MESSAGES block.
 */
export function renderMessageLog(
  read: SessionLogRead,
  color: boolean,
  width: number | null = null,
): string[] {
  const at = ' '.repeat(BODY_COLUMN);
  switch (read.kind) {
    case 'missing':
      return [
        `${at}(no message log at ${read.path} — capture never ran for this session, and no backfill has written one)`,
      ];
    case 'failed':
      return [`${at}UNKNOWN — could not read ${read.path} (${read.error})`];
    case 'noSession':
      return [`${at}UNKNOWN — ${read.detail}`];
    case 'read':
      break;
  }
  const style: ShowStyle = {color, width};
  const out: string[] = [];
  if (read.lines.length === 0) {
    out.push(`${at}(the log at ${read.path} holds no messages)`);
  }
  read.lines.forEach((line, index) => {
    if (index > 0) out.push('');
    out.push(labelLine(messageFieldName(line), color), '');
    out.push(...bodyLines(line.text, style));
  });
  for (const failure of read.failures) out.push('', `${at}${failure}`);
  return out;
}

/**
 * The MESSAGES block (home-base-k0b8n K4).
 *
 * VERBATIM regardless of `--full`, and that is the requirement, not an
 * oversight: Justin's ask was the text itself, and a 20 KB status report on a
 * terminal is fine. The compaction `--full` toggles applies to the stored
 * REPORT above, which is a different thing.
 *
 * Each message is a bold label at the header column with its text at the body
 * column, a blank line between everything (K11). The resume command is cyan:
 * it is the thing to run.
 *
 * `log`, when given, adds the K10 f line saying how many messages the
 * session's log holds and how to print them.
 */
export function renderMessagesBlock(
  metadata: Record<string, unknown>,
  color: boolean,
  log: {read: SessionLogRead; threadId: string} | null = null,
  width: number | null = null,
): string[] {
  const style: ShowStyle = {color, width};
  const lines = ['', sectionHeader('MESSAGES', {color, emoji: '📨'})];
  for (const {key, label} of MESSAGE_FIELDS) {
    lines.push('', labelLine(label, color), '');
    const value = asText(metadata[key]);
    if (value == null) {
      lines.push(...bodyLines(notCaptured(metadata, key), style));
      continue;
    }
    lines.push(
      ...bodyLines(value, style, key === 'resumeCommand' ? ['cyan'] : []),
    );
  }
  if (log != null) {
    lines.push('', ...capturedCountLines(log.threadId, log.read));
  }
  return lines;
}

/** The two lines that say which thread this is. */
export function renderShowHeader(
  thread: BdIssue,
  style: ShowStyle = PLAIN,
): string[] {
  const metadata = thread.metadata ?? {};
  return [
    wrapHanging(
      paint(
        `THREAD ${thread.id} · ${thread.title ?? '(no title)'} · ${thread.status ?? 'UNKNOWN'}`,
        ['bold'],
        style.color,
      ),
      {hang: 7, indent: 0, width: style.width},
    ),
    '',
    `${' '.repeat(HEADER_COLUMN)}${paint(
      `session ${String(metadata.sessionId ?? 'UNKNOWN')} · report #${String(metadata.reportCount ?? 'UNKNOWN')} · reported ${String(metadata.reportedAt ?? 'UNKNOWN')}`,
      ['dim'],
      style.color,
    )}`,
  ];
}

/**
 * The stored notes, as `show` prints them.
 *
 * A rendered report is compacted unless `full`, then styled for the terminal
 * (or left as markdown in a pipe). ANYTHING ELSE — a start placeholder, notes
 * nobody rendered — is not a report and is never styled as one (k0b8n.14): it
 * is printed as it is, under the body indent, identically with and without
 * `--full`, beneath a glance line that says only what was measured:
 *
 *  - `reportCount` 0 → `no report yet` (the bead itself says none was made);
 *  - `reportCount` > 0 → the notes are not the report the bead says exists;
 *  - `reportCount` absent → the count is UNKNOWN, and so is whether one exists.
 */
export function renderStoredNotes(
  notes: string | null | undefined,
  options: ShowStyle & {full: boolean; reportCount: number | null},
): string {
  if (notes == null || notes.trim() === '') {
    return `${' '.repeat(BODY_COLUMN)}(this bead carries no rendered report — it may predate D10)`;
  }
  if (isRenderedReport(notes)) {
    return ansiFromReportText(
      options.full ? notes : compactStoredReport(notes),
      {color: options.color, width: options.width},
    );
  }
  const glance =
    options.reportCount === 0
      ? NO_REPORT_GLANCE
      : options.reportCount == null
        ? '⚡ ❓ report count UNKNOWN — these notes are not a rendered report'
        : `⚡ ❓ this bead records ${options.reportCount} report${options.reportCount === 1 ? '' : 's'}, but its notes are not a rendered report`;
  return [
    paint(glance, ['bold'], options.color),
    '',
    ...bodyLines(notes, options, ['dim']),
  ].join('\n');
}

/** `metadata.reportCount` as recorded — null when absent, never a guessed 0. */
function recordedReportCount(metadata: Record<string, unknown>): number | null {
  const value = metadata.reportCount;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export interface ShowOptions {
  cwd?: string;
  env?: EnvLike;
  /**
   * Print the stored report as it is (D18). The default compacts it — the same
   * two sections dropped and the same What-I-did cap `thread report` applies.
   */
  full?: boolean;
  /**
   * Print the session's whole message log instead of the report (K10 f). The
   * header lines stay, so the output still says which thread it is.
   */
  messages?: boolean;
  sessionId?: string | null;
  /** Explicit thread bead id. Omit to look the current session's up. */
  threadId?: string | null;
}

async function resolveThread(
  ctx: BdContext,
  options: ShowOptions,
): Promise<{issue: BdIssue; ok: true} | {message: string; ok: false}> {
  if (options.threadId != null && options.threadId !== '') {
    const found = await showIssue(ctx, options.threadId);
    if (!found.ok)
      return {message: describeBdFailure(found.failure), ok: false};
    if (found.value == null) {
      return {message: `no bead ${options.threadId}`, ok: false};
    }
    return {issue: found.value, ok: true};
  }
  const facts = collectThreadFacts({
    cwd: options.cwd,
    env: options.env,
    sessionId: options.sessionId,
  });
  if (facts.sessionId == null) {
    return {
      message:
        'no session id (CLAUDE_CODE_SESSION_ID unset and neither an id nor --session was given)',
      ok: false,
    };
  }
  const found = await findThreadBySession(ctx, facts.sessionId);
  if (!found.ok) return {message: describeBdFailure(found.failure), ok: false};
  if (found.value == null) {
    return {
      message: `no thread bead for session ${facts.sessionId} — nothing has been reported yet`,
      ok: false,
    };
  }
  return {issue: found.value, ok: true};
}

export async function runThreadShow(
  options: ShowOptions = {},
): Promise<number> {
  const env = options.env ?? process.env;
  const ctx = bdContext(env);
  const style: ShowStyle = {color: shouldStyle(), width: terminalWidth()};

  const resolved = await resolveThread(ctx, options);
  if (!resolved.ok) {
    console.error(`thread show: ${resolved.message}`);
    return 1;
  }
  const thread = resolved.issue;
  const metadata = thread.metadata ?? {};

  const out: string[] = [...renderShowHeader(thread, style), ''];
  const log = readSessionLog(metadata, env);
  if (options.messages === true) {
    out.push(sectionHeader('MESSAGE LOG', {color: style.color, emoji: '📜'}));
    out.push('');
    out.push(...renderMessageLog(log, style.color, style.width));
    console.log(out.join('\n'));
    // A missing log is a measured answer; one we could not read is not.
    return log.kind === 'failed' || log.kind === 'noSession' ? 1 : 0;
  }
  // The stored notes are ALWAYS the full rendering (D10): the bead has to be a
  // complete status report on its own. Compacting happens here, on the way out,
  // so `--full` costs nothing and the record is never the compact one.
  out.push(
    renderStoredNotes(thread.notes, {
      ...style,
      full: options.full === true,
      reportCount: recordedReportCount(metadata),
    }),
  );
  out.push(
    ...renderMessagesBlock(
      metadata,
      style.color,
      {read: log, threadId: thread.id},
      style.width,
    ),
  );
  console.log(out.join('\n'));

  const asks = await listOpenAsks(ctx, thread.id);
  const at = ' '.repeat(BODY_COLUMN);
  const under = ' '.repeat(DETAIL_COLUMN);
  const tail: string[] = [
    '',
    sectionHeader('OPEN ASKS RIGHT NOW', {color: style.color, emoji: '🙋'}),
  ];
  if (!asks.ok) {
    tail.push('', `${at}UNKNOWN — ${describeBdFailure(asks.failure)}`);
    console.log(tail.join('\n'));
    return 1;
  }
  if (asks.value.length === 0) {
    tail.push('', `${at}(none — checked, and there are none)`);
  }
  let readFailed = false;
  for (const ask of asks.value) {
    const meta = ask.metadata ?? {};
    tail.push(
      '',
      wrapHanging(
        `${paint(ask.id, ['dim'], style.color)} · [${String(meta.kind ?? 'UNKNOWN')}] ${priorityLabel(readAskPriority(meta))} · ${ask.title ?? ''}`,
        {hang: DETAIL_COLUMN, indent: BODY_COLUMN, width: style.width},
      ),
    );
    const comments = await readComments(ctx, ask.id);
    if (!comments.ok) {
      readFailed = true;
      tail.push(
        '',
        `${under}answers UNKNOWN — ${describeBdFailure(comments.failure)}`,
      );
      continue;
    }
    if (comments.value.length === 0) {
      tail.push(
        '',
        `${under}${paint('(no answer yet)', ['dim'], style.color)}`,
      );
      continue;
    }
    for (const comment of comments.value) {
      tail.push(
        '',
        wrapHanging(
          `${paint(`ANSWER (${comment.created_at ?? 'unknown time'}):`, ['bold'], style.color)} ${comment.text ?? ''}`,
          {hang: DETAIL_COLUMN + 2, indent: DETAIL_COLUMN, width: style.width},
        ),
      );
    }
  }
  console.log(tail.join('\n'));
  return readFailed ? 1 : 0;
}
