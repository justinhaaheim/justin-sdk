/**
 * `justin-sdk thread show` — the read path for Justin and for the next session
 * (home-base-p1uj D10).
 *
 * The bead's `notes` field already IS the rendered report: that is D10's whole
 * point, so that `bd show` alone is a complete status report if this tool ever
 * breaks. `show` therefore prints the notes verbatim rather than re-deriving a
 * report from metadata — re-rendering would give a second, subtly different
 * report for the same bead, and there would then be no way to tell which one
 * Justin had read.
 *
 * What it ADDS is the half a stored report cannot have: the CURRENT state of
 * the asks, and Justin's answers on them, which arrive as bd comments after the
 * report was written.
 *
 * Exit 0 = printed · 1 = could not read (never silently empty).
 */

import {
  bdContext,
  describeBdFailure,
  findThreadBySession,
  listOpenAsks,
  readComments,
  showIssue,
  type BdContext,
  type BdIssue,
} from './bd';
import {collectThreadFacts} from './facts';

import type {EnvLike} from './paths';

export interface ShowOptions {
  cwd?: string;
  env?: EnvLike;
  /** Explicit thread bead id. Omit to look the current session's up. */
  threadId?: string | null;
  sessionId?: string | null;
}

async function resolveThread(
  ctx: BdContext,
  options: ShowOptions,
): Promise<{ok: true; issue: BdIssue} | {ok: false; message: string}> {
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

  const resolved = await resolveThread(ctx, options);
  if (!resolved.ok) {
    console.error(`thread show: ${resolved.message}`);
    return 1;
  }
  const thread = resolved.issue;
  const metadata = (thread.metadata ?? {}) as Record<string, unknown>;

  const out: string[] = [];
  out.push(
    `THREAD ${thread.id} · ${thread.title ?? '(no title)'} · ${thread.status ?? 'UNKNOWN'}`,
  );
  out.push(
    `  session ${String(metadata.sessionId ?? 'UNKNOWN')} · report #${String(metadata.reportCount ?? 'UNKNOWN')} · reported ${String(metadata.reportedAt ?? 'UNKNOWN')}`,
  );
  out.push('');
  out.push(
    thread.notes == null || thread.notes === ''
      ? '(this bead carries no rendered report — it may predate D10)'
      : thread.notes,
  );
  console.log(out.join('\n'));

  const asks = await listOpenAsks(ctx, thread.id);
  const tail: string[] = ['', 'OPEN ASKS RIGHT NOW'];
  if (!asks.ok) {
    tail.push(`  UNKNOWN — ${describeBdFailure(asks.failure)}`);
    console.log(tail.join('\n'));
    return 1;
  }
  if (asks.value.length === 0) {
    tail.push('  (none — checked, and there are none)');
  }
  let readFailed = false;
  for (const ask of asks.value) {
    const meta = (ask.metadata ?? {}) as Record<string, unknown>;
    tail.push(
      `  ${ask.id} · [${String(meta.kind ?? 'UNKNOWN')}] ${meta.blocking === true ? 'BLOCKING' : 'non-blocking'} · ${ask.title ?? ''}`,
    );
    const comments = await readComments(ctx, ask.id);
    if (!comments.ok) {
      readFailed = true;
      tail.push(
        `      answers UNKNOWN — ${describeBdFailure(comments.failure)}`,
      );
      continue;
    }
    if (comments.value.length === 0) {
      tail.push('      (no answer yet)');
      continue;
    }
    for (const comment of comments.value) {
      tail.push(
        `      ANSWER (${comment.created_at ?? 'unknown time'}): ${comment.text ?? ''}`,
      );
    }
  }
  console.log(tail.join('\n'));
  return readFailed ? 1 : 0;
}
