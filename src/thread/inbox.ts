/**
 * `justin-sdk thread inbox` — what Justin said, for the next Claude turn
 * (home-base-p1uj D3, D4).
 *
 * The first thing a session runs when it comes back to a thread. It prints, for
 * every ask Justin has touched since the last report: the ask RESTATED IN FULL,
 * and his answer VERBATIM. Restating is the whole point — the same reason the
 * report restates a question before its answer (D11). An answer that arrives as
 * "b" against a question nobody can see is not information.
 *
 * IT MARKS NOTHING. Dispositioning open asks is `thread report`'s job and D4's
 * refusal is what enforces it; if `inbox` closed or stamped anything, the next
 * report would find fewer open asks than Justin actually answered and D4 would
 * pass while the answers went unmentioned. Read-only, on purpose.
 *
 * THREE STATES, NOT TWO. An ask is answered, deliberately skipped, or never
 * reached, and they mean different things to the next turn: an answer is an
 * instruction, a skip is explicit permission to take the stated default, and an
 * untouched ask is still waiting. Collapsing skip into "no answer" would throw
 * away the one thing Justin actually decided.
 *
 * Exit 0 = printed · 1 = a read failed (never a quiet empty inbox) · 2 = no thread.
 */

import {
  describeBdFailure,
  listOpenAsks,
  readComments,
  type BdComment,
  type BdContext,
  type BdIssue,
} from './bd';
import {contextFor, resolveThread, type ThreadRef} from './resolve';
import {SKIP_COMMENT} from './answer';

/** The footer `renderAskDescription` appends; noise once the ask is being read back. */
const ANSWER_FOOTER_MARKER = 'Answer by commenting on this bead:';

export type AskState = 'answered' | 'skipped' | 'unanswered';

export interface InboxAsk {
  answers: string[];
  blocking: boolean;
  defaultAction: string;
  id: string;
  kind: string;
  restated: string;
  state: AskState;
  title: string;
}

export interface InboxView {
  asks: InboxAsk[];
  note: string | null;
  threadId: string;
  threadTitle: string;
}

/** Drop the "answer by commenting" footer — it is instructions to Justin, not content. */
export function restateAsk(description: string): string {
  const cut = description.indexOf(ANSWER_FOOTER_MARKER);
  return (cut === -1 ? description : description.slice(0, cut)).trimEnd();
}

/** `ANSWER: foo` → `foo`. A hand-written comment is returned unchanged. */
export function stripAnswerPrefix(text: string): string {
  return text.startsWith('ANSWER: ') ? text.slice('ANSWER: '.length) : text;
}

/**
 * Which of the three states is this ask in?
 *
 * COMMENTS ARE THE SOURCE OF TRUTH for an answer, not the metadata stamp:
 * Justin can answer with `bd comments add` directly (the ask bead's own
 * description tells him to), and such an answer has no stamp. The stamp's job
 * is the one thing a comment cannot express on its own — that a skip was
 * DELIBERATE. A lone `skipped: use default` comment is honoured as a skip too,
 * so a stamp write that failed after its comment landed still reads correctly.
 */
export function askStateOf(
  metadata: Record<string, unknown>,
  comments: readonly BdComment[],
): AskState {
  const skippedAt = metadata.skippedAt;
  if (typeof skippedAt === 'string' && skippedAt !== '') return 'skipped';
  const texts = comments.map((comment) => (comment.text ?? '').trim());
  const meaningful = texts.filter((text) => text !== '');
  if (meaningful.length === 0) return 'unanswered';
  if (meaningful.every((text) => text === SKIP_COMMENT)) return 'skipped';
  return 'answered';
}

function metadataOf(issue: BdIssue): Record<string, unknown> {
  return (issue.metadata ?? {}) as Record<string, unknown>;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value !== '' ? value : fallback;
}

/** The thread's free-text note, newest last. `NOTE: ` prefixed comments only. */
export function noteFrom(comments: readonly BdComment[]): string | null {
  const notes = comments
    .map((comment) => (comment.text ?? '').trim())
    .filter((text) => text.startsWith('NOTE: '))
    .map((text) => text.slice('NOTE: '.length));
  return notes.length === 0 ? null : notes.join('\n\n');
}

/**
 * ONE ask, restated and then answered — the shape `inbox` and `prepare` share.
 *
 * Extracted so there is exactly one renderer for "here is the question, here is
 * what Justin said" (home-base-p1uj.2 follow-up). `prepare` used to print every
 * comment as `ANSWER (<time>): <text>`, which rendered a skip as
 * `ANSWER (...): skipped: use default` — a deliberate skip shown as an answer —
 * and a real answer as `ANSWER (...): ANSWER: a`. `prepare` is the D4 entry
 * point run before every report, so that was the surface it mattered on most.
 *
 * `unansweredNote` exists because the two callers want different things from an
 * untouched ask: `inbox` lists it separately under STILL WAITING, `prepare`
 * needs it inline with the nudge to disposition it.
 */
export function renderInboxAsk(
  ask: InboxAsk,
  heading: string,
  unansweredNote: string | null = null,
): string[] {
  const lines = [heading];
  for (const line of ask.restated.split('\n')) lines.push(`     ${line}`);
  if (ask.state === 'skipped') {
    lines.push(`     >>> SKIPPED — use your default: ${ask.defaultAction}`);
    return lines;
  }
  if (ask.state === 'unanswered') {
    if (unansweredNote != null) lines.push(unansweredNote);
    return lines;
  }
  for (const answer of ask.answers) {
    for (const [position, line] of answer.split('\n').entries()) {
      lines.push(`     >>> ${position === 0 ? 'HIS ANSWER: ' : ''}${line}`);
    }
  }
  return lines;
}

export function renderInbox(view: InboxView): string {
  const lines: string[] = [];
  lines.push(`INBOX for ${view.threadId} · ${view.threadTitle}`);

  const touched = view.asks.filter((ask) => ask.state !== 'unanswered');
  const waiting = view.asks.filter((ask) => ask.state === 'unanswered');

  lines.push('');
  lines.push('WHAT JUSTIN DECIDED');
  if (touched.length === 0) {
    lines.push(
      '  (nothing — checked, and he has not answered or skipped anything since the last report)',
    );
  }
  for (const [index, ask] of touched.entries()) {
    lines.push('');
    lines.push(
      ...renderInboxAsk(
        ask,
        `  ${index + 1}. ${ask.id} · ${ask.blocking ? 'BLOCKING' : 'non-blocking'} · [${ask.kind}]`,
      ),
    );
  }

  lines.push('');
  lines.push('HIS NOTE');
  lines.push(
    view.note == null
      ? '  (none — checked, and he left none)'
      : view.note
          .split('\n')
          .map((line) => `  ${line}`)
          .join('\n'),
  );

  lines.push('');
  lines.push('STILL WAITING ON HIM');
  if (waiting.length === 0) {
    lines.push('  (none — checked, and there are none)');
  }
  for (const ask of waiting) {
    lines.push(
      `  ${ask.id} · ${ask.blocking ? 'BLOCKING' : 'non-blocking'} · ${ask.title}`,
    );
    lines.push(`      if he never answers: ${ask.defaultAction}`);
  }

  lines.push('');
  lines.push(
    'These are still OPEN asks: every one of them must appear in the next report’s priorAsks (D4).',
  );
  return lines.join('\n');
}

/**
 * Read every ask's comments and fold them into `InboxAsk`s.
 *
 * Shared by `inbox` and `prepare` (home-base-p1uj.2 follow-up) so the two
 * cannot disagree about what counts as an answer. `readFailed` is returned
 * rather than thrown or swallowed: an unreadable comment list is NOT an
 * unanswered ask, and the reassuring reading — "he said nothing, take your
 * default" — is the dangerous one.
 */
export async function collectInboxAsks(
  ctx: BdContext,
  openAsks: readonly BdIssue[],
): Promise<{asks: InboxAsk[]; readFailed: boolean}> {
  const asks: InboxAsk[] = [];
  let readFailed = false;
  for (const ask of openAsks) {
    const meta = metadataOf(ask);
    const base = {
      blocking: meta.blocking === true,
      defaultAction: stringOr(meta.defaultAction, 'UNKNOWN'),
      id: ask.id,
      kind: stringOr(meta.kind, 'UNKNOWN'),
      restated: restateAsk(ask.description ?? ''),
      title: ask.title ?? '',
    };
    const comments = await readComments(ctx, ask.id);
    if (!comments.ok) {
      readFailed = true;
      asks.push({
        ...base,
        answers: [
          `UNKNOWN — could not read the answers: ${describeBdFailure(comments.failure)}`,
        ],
        state: 'answered',
      });
      continue;
    }
    asks.push({
      ...base,
      answers: comments.value
        .map((comment) => stripAnswerPrefix((comment.text ?? '').trim()))
        .filter((text) => text !== '' && text !== SKIP_COMMENT),
      state: askStateOf(meta, comments.value),
    });
  }
  return {asks, readFailed};
}

/** The thread bead's free-text NOTE, or a named failure. Never a silent null. */
export async function readThreadNote(
  ctx: BdContext,
  threadId: string,
): Promise<{note: string | null; readFailed: boolean}> {
  const comments = await readComments(ctx, threadId);
  if (!comments.ok) {
    return {
      note: `UNKNOWN — could not read the thread's comments: ${describeBdFailure(comments.failure)}`,
      readFailed: true,
    };
  }
  return {note: noteFrom(comments.value), readFailed: false};
}

export interface InboxOptions extends ThreadRef {
  json?: boolean;
}

export async function runThreadInbox(
  options: InboxOptions = {},
): Promise<number> {
  const env = options.env ?? process.env;
  const ctx: BdContext = contextFor(env);

  const resolved = await resolveThread(ctx, options);
  if (!resolved.ok) {
    console.error(`thread inbox: ${resolved.message}`);
    return 2;
  }
  const thread = resolved.issue;

  const asks = await listOpenAsks(ctx, thread.id);
  if (!asks.ok) {
    console.error(
      `thread inbox: could not read the asks on ${thread.id} — ${describeBdFailure(asks.failure)}`,
    );
    return 1;
  }

  const collected = await collectInboxAsks(ctx, asks.value);
  const noteRead = await readThreadNote(ctx, thread.id);
  const readFailed = collected.readFailed || noteRead.readFailed;

  const view: InboxView = {
    asks: collected.asks,
    note: noteRead.note,
    threadId: thread.id,
    threadTitle: thread.title ?? '(no title)',
  };

  console.log(
    options.json === true ? JSON.stringify(view, null, 2) : renderInbox(view),
  );
  return readFailed ? 1 : 0;
}
