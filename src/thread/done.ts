/**
 * `justin-sdk thread done` / `thread reopen` — Justin closes a thread
 * (home-base-p1uj D10).
 *
 * D10 leaves a thread `in_progress` for as long as the session is live and
 * makes closing a DELIBERATE act: auto-closing on `stopReason: completed` is a
 * knob that defaults off, in Justin's own words because "at a certain point I
 * just sort of decide I'm going to prioritize other things". This is that act.
 *
 * CLOSING A THREAD CLOSES ITS OPEN ASKS, because an ask outliving its thread is
 * a question about work nobody is doing any more — it would sit in `board
 * --open-asks` forever looking like something Justin still owes an answer to.
 * They are closed with their own reason so the ledger says WHY they stopped
 * mattering, rather than implying they were answered.
 *
 * THE ASKS ARE CLOSED FIRST. If the run dies midway, a closed thread with open
 * asks under it reads as a bug while an open thread with closed asks reads as a
 * thread mid-cleanup — and only the second is true. Order the writes so the
 * intermediate state is the honest one.
 *
 * REOPENING DOES NOT REOPEN THE ASKS. They were closed as "no longer relevant";
 * resurrecting them would put questions Justin already dismissed back in front
 * of him, and the next report can always ask again. Said out loud in the output
 * rather than left as a surprise.
 *
 * Exit 0 = closed · 1 = a bd write failed · 2 = no such thread.
 */

import {
  closeIssue,
  describeBdFailure,
  listOpenAsks,
  reopenIssue,
  type BdContext,
} from './bd';
import {contextFor, resolveThread, type ThreadRef} from './resolve';

export const DEFAULT_DONE_REASON = 'thread closed by Justin';

export interface DoneOptions extends ThreadRef {
  reason?: string | null;
}

export async function runThreadDone(
  options: DoneOptions = {},
): Promise<number> {
  const env = options.env ?? process.env;
  const ctx: BdContext = contextFor(env);

  const resolved = await resolveThread(ctx, options);
  if (!resolved.ok) {
    console.error(`thread done: ${resolved.message}`);
    return 2;
  }
  const thread = resolved.issue;
  const reason =
    options.reason != null && options.reason !== ''
      ? options.reason
      : DEFAULT_DONE_REASON;

  const asks = await listOpenAsks(ctx, thread.id);
  if (!asks.ok) {
    // Closing the thread while unable to see its asks would strand them.
    console.error(
      `thread done: could not read the asks on ${thread.id} — ${describeBdFailure(asks.failure)}. Nothing was closed.`,
    );
    return 1;
  }

  const closedAsks: string[] = [];
  for (const ask of asks.value) {
    const closed = await closeIssue(
      ctx,
      ask.id,
      `no longer relevant: ${reason}`,
    );
    if (!closed.ok) {
      console.error(
        `thread done: could not close ask ${ask.id} — ${describeBdFailure(closed.failure)}. The thread is still open.`,
      );
      return 1;
    }
    closedAsks.push(ask.id);
  }

  const closed = await closeIssue(ctx, thread.id, reason);
  if (!closed.ok) {
    console.error(
      `thread done: closed ${closedAsks.length} ask(s), but could NOT close the thread ${thread.id} — ${describeBdFailure(closed.failure)}`,
    );
    return 1;
  }

  console.log(`Closed thread ${thread.id} · ${thread.title ?? '(no title)'}`);
  console.log(`  reason: ${reason}`);
  console.log(
    `  asks closed: ${closedAsks.length === 0 ? 'none were open' : closedAsks.join(', ')}`,
  );
  return 0;
}

export async function runThreadReopen(
  options: DoneOptions = {},
): Promise<number> {
  const env = options.env ?? process.env;
  const ctx: BdContext = contextFor(env);

  const resolved = await resolveThread(ctx, options);
  if (!resolved.ok) {
    console.error(`thread reopen: ${resolved.message}`);
    return 2;
  }
  const thread = resolved.issue;
  const reason =
    options.reason != null && options.reason !== ''
      ? options.reason
      : 'reopened by Justin';

  const reopened = await reopenIssue(ctx, thread.id, reason);
  if (!reopened.ok) {
    console.error(
      `thread reopen: could not reopen ${thread.id} — ${describeBdFailure(reopened.failure)}`,
    );
    return 1;
  }

  console.log(`Reopened thread ${thread.id} · ${thread.title ?? '(no title)'}`);
  console.log(`  reason: ${reason}`);
  console.log(
    '  its asks stay CLOSED — they were closed as no longer relevant. The next report can ask again.',
  );
  return 0;
}
