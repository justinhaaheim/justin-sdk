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
      `  ${index + 1}. ${ask.id} · ${ask.blocking ? 'BLOCKING' : 'non-blocking'} · [${ask.kind}]`,
    );
    for (const line of ask.restated.split('\n')) lines.push(`     ${line}`);
    if (ask.state === 'skipped') {
      lines.push(`     >>> SKIPPED — use your default: ${ask.defaultAction}`);
    } else {
      for (const answer of ask.answers) {
        for (const [position, line] of answer.split('\n').entries()) {
          lines.push(`     >>> ${position === 0 ? 'HIS ANSWER: ' : ''}${line}`);
        }
      }
    }
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

  let readFailed = false;
  const inboxAsks: InboxAsk[] = [];
  for (const ask of asks.value) {
    const meta = metadataOf(ask);
    const comments = await readComments(ctx, ask.id);
    if (!comments.ok) {
      // An unreadable comment list is NOT an unanswered ask. Saying so out loud
      // is the whole of rule 6 here: the reassuring reading ("he said nothing,
      // take your default") is the dangerous one.
      readFailed = true;
      inboxAsks.push({
        answers: [
          `UNKNOWN — could not read the answers: ${describeBdFailure(comments.failure)}`,
        ],
        blocking: meta.blocking === true,
        defaultAction: stringOr(meta.defaultAction, 'UNKNOWN'),
        id: ask.id,
        kind: stringOr(meta.kind, 'UNKNOWN'),
        restated: restateAsk(ask.description ?? ''),
        state: 'answered',
        title: ask.title ?? '',
      });
      continue;
    }
    const state = askStateOf(meta, comments.value);
    inboxAsks.push({
      answers: comments.value
        .map((comment) => stripAnswerPrefix((comment.text ?? '').trim()))
        .filter((text) => text !== '' && text !== SKIP_COMMENT),
      blocking: meta.blocking === true,
      defaultAction: stringOr(meta.defaultAction, 'UNKNOWN'),
      id: ask.id,
      kind: stringOr(meta.kind, 'UNKNOWN'),
      restated: restateAsk(ask.description ?? ''),
      state,
      title: ask.title ?? '',
    });
  }

  const threadComments = await readComments(ctx, thread.id);
  let note: string | null = null;
  if (!threadComments.ok) {
    readFailed = true;
    note = `UNKNOWN — could not read the thread's comments: ${describeBdFailure(threadComments.failure)}`;
  } else {
    note = noteFrom(threadComments.value);
  }

  const view: InboxView = {
    asks: inboxAsks,
    note,
    threadId: thread.id,
    threadTitle: thread.title ?? '(no title)',
  };

  console.log(
    options.json === true ? JSON.stringify(view, null, 2) : renderInbox(view),
  );
  return readFailed ? 1 : 0;
}
