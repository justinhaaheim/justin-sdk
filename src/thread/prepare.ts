/**
 * `justin-sdk thread prepare` — everything a session needs before it writes a
 * report, and nothing it has to remember (home-base-p1uj D4, D6).
 *
 * OUTPUT ORDER IS A CONTRACT. The FIRST line is always one of:
 *
 *   THREADS: DISABLED        the knob is off; the rule falls back to prose.
 *   THREADS: SANDBOX DENIED  a write probe was refused; the line names the fix.
 *   THREADS: ENABLED         go ahead.
 *
 * The rule that drives this tool branches on that line and on
 * command-not-found, so it must be first, cheap, and unconditional.
 *
 * ORDERING NOTE (an interpretation, recorded rather than assumed): the bead's
 * design says the sandbox probe runs FIRST. It runs first among the WORK — the
 * knob is still read before it. Probing (and printing SANDBOX DENIED) in a repo
 * that never turned the feature on would be noise about a feature nobody asked
 * for, and the knob read is a file read, not a write, so it cannot itself trip
 * a prompt. Disabled therefore short-circuits before the probe.
 *
 * ALWAYS EXITS 0. A preflight that can fail a session is a preflight nobody
 * runs.
 */

import {
  bdContext,
  checkThreadTypes,
  describeBdFailure,
  findThreadBySession,
  listOpenAsks,
  REGISTER_TYPES_COMMAND,
  showIssue,
} from './bd';
import {collectInboxAsks, readThreadNote, renderInboxAsk} from './inbox';
import {collectThreadFacts} from './facts';
import {draftPath} from './archive';
import {
  threadsBeadsDir,
  threadsBeadsMissingLine,
  probeWritable,
  SANDBOX_DENIED_LINE,
  threadsStateDir,
} from './paths';
import {PAYLOAD_PRIORITY_GUIDANCE, payloadSkeleton} from './schema';
import {priorityLabel} from './render';
import {readReportCount} from './metadata';
import {resolveThreadConfig} from './config';

import type {EnvLike} from './paths';

export interface PrepareOptions {
  /**
   * The thread this session CONTINUES (D21). Its open asks are listed under the
   * same MUST-disposition heading as the session's own, and `continuesFrom` is
   * prefilled in the printed skeleton — the two halves of making a handed-over
   * arc's asks impossible to lose.
   */
  continuesFrom?: string | null;
  cwd?: string;
  env?: EnvLike;
  sessionId?: string | null;
}

/** The one heading both ask listings appear under. */
const OPEN_ASKS_HEADING =
  'OPEN ASKS — every one of these MUST appear in priorAsks (D4)';

/**
 * One thread's open asks, rendered exactly as `thread inbox` renders them.
 *
 * Shared by the session's own thread and by a continued one (D21) so the two
 * cannot drift into showing Justin's answers differently depending on which
 * session is asking.
 */
async function openAsksSection(
  ctx: ReturnType<typeof bdContext>,
  threadId: string,
): Promise<string[]> {
  const out: string[] = [OPEN_ASKS_HEADING];
  const asks = await listOpenAsks(ctx, threadId);
  if (!asks.ok) {
    // NOT "(none open)". A failed read and an empty thread are opposite facts,
    // and this is the D4 entry point: "no asks" here is read as permission to
    // write a report that disposition nothing.
    out.push(`  UNKNOWN — ${describeBdFailure(asks.failure)}`);
    return out;
  }
  if (asks.value.length === 0) {
    out.push('  (none open)');
    return out;
  }
  // The SAME renderer `thread inbox` uses (home-base-p1uj.2 follow-up). This
  // used to print every comment as `ANSWER (<time>): <text>`, which showed a
  // deliberate skip as `ANSWER (...): skipped: use default` and a real answer as
  // `ANSWER (...): ANSWER: a`. A skip is permission to take a stated default,
  // not an answer, and this is the D4 entry point run before every report — the
  // worst surface on which to confuse the two.
  const collected = await collectInboxAsks(ctx, asks.value);
  for (const ask of collected.asks) {
    out.push(
      ...renderInboxAsk(
        ask,
        `  ${ask.id} · [${ask.kind}] ${priorityLabel(ask.priority)} · ${ask.title}`,
        '     (no answer yet — disposition it as carried or decided)',
      ),
    );
  }
  const noteRead = await readThreadNote(ctx, threadId);
  if (noteRead.note != null) {
    out.push('');
    out.push('NOTE FROM JUSTIN');
    for (const line of noteRead.note.split('\n')) out.push(`  ${line}`);
  }
  return out;
}

/** Runs the preflight and prints it. Always resolves 0. */
export async function runThreadPrepare(
  options: PrepareOptions = {},
): Promise<number> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const out: string[] = [];

  const config = resolveThreadConfig({cwd, env});
  if (!config.enabled) {
    out.push('THREADS: DISABLED');
    out.push(
      `  componentConfig.thread.enabled is not true (resolved from: ${config.source}).`,
    );
    out.push(
      `  Turn it on for every repo: set componentConfig.thread.enabled = true in ~/.config/justin-sdk/config.json`,
    );
    for (const problem of config.problems) out.push(`  ⚠️ ${problem}`);
    console.log(out.join('\n'));
    return 0;
  }

  // The two paths the Claude Code sandbox denies from any session outside
  // the threads repo. Probed BEFORE any bd command, so a denied session never spends
  // a subprocess (or a permission prompt) on a call that cannot succeed.
  // The state dir is OURS to create; the beads dir is bd's (F9) — probing it
  // with `create` would fabricate a beads workspace on a machine that has none.
  const stateProbe = probeWritable(threadsStateDir(env), {create: true});
  const beadsProbe = probeWritable(threadsBeadsDir(env), {create: false});
  if (stateProbe.kind === 'denied' || beadsProbe.kind === 'denied') {
    console.log(SANDBOX_DENIED_LINE);
    return 0;
  }
  if (beadsProbe.kind === 'missing') {
    console.log(threadsBeadsMissingLine(beadsProbe.path));
    return 0;
  }

  out.push('THREADS: ENABLED');
  for (const problem of config.problems) out.push(`  ⚠️ config: ${problem}`);
  if (stateProbe.kind === 'failed') {
    out.push(
      `  ⚠️ state dir not writable: ${stateProbe.path} (${stateProbe.error})`,
    );
  }
  if (beadsProbe.kind === 'failed') {
    out.push(
      `  ⚠️ beads dir not writable: ${beadsProbe.path} (${beadsProbe.error})`,
    );
  }

  const ctx = bdContext(env);
  const types = await checkThreadTypes(ctx);
  if (!types.ok) {
    out.push(`  ⚠️ bd could not be read: ${describeBdFailure(types.failure)}`);
  } else if (types.value.missing.length > 0) {
    out.push(
      `  ⚠️ bd is missing the custom type(s) ${types.value.missing.join(', ')}. Fix:`,
    );
    out.push(`     ${REGISTER_TYPES_COMMAND}`);
  }

  const facts = collectThreadFacts({cwd, env, sessionId: options.sessionId});
  const sessionId = facts.sessionId;

  out.push('');
  out.push('THIS SESSION’S THREAD');
  if (sessionId == null) {
    out.push('  UNKNOWN — no session id, so the thread cannot be looked up.');
  } else {
    const existing = await findThreadBySession(ctx, sessionId);
    if (!existing.ok) {
      out.push(`  UNKNOWN — ${describeBdFailure(existing.failure)}`);
    } else if (existing.value == null) {
      out.push('  none yet — this report will create it.');
    } else {
      const thread = existing.value;
      out.push(
        `  ${thread.id} · ${thread.title ?? '(no title)'} · report #${readReportCount(thread.metadata) + 1} · status ${thread.status ?? 'UNKNOWN'}`,
      );
      out.push('');
      out.push(...(await openAsksSection(ctx, thread.id)));
    }
  }

  // --- the thread this session CONTINUES (D21) -----------------------------
  //
  // A session that picks up someone else's arc has a brand-new thread bead and
  // therefore no open asks of its own, while the asks Justin is actually waiting
  // on sit under the PREVIOUS session's thread. Listing them here is what makes
  // them dispositionable: `thread report` refuses a payload that leaves any of
  // them out, and it can only refuse over asks the session was shown.
  const continuesFrom =
    options.continuesFrom == null || options.continuesFrom.trim() === ''
      ? null
      : options.continuesFrom.trim();
  if (continuesFrom != null) {
    out.push('');
    out.push(`THREAD THIS SESSION CONTINUES — ${continuesFrom}`);
    const continued = await showIssue(ctx, continuesFrom);
    if (!continued.ok) {
      out.push(`  UNKNOWN — ${describeBdFailure(continued.failure)}`);
    } else if (continued.value == null) {
      out.push(
        '  NOT FOUND — no bead with that id. Check it with: justin-sdk thread board --recent',
      );
    } else {
      const thread = continued.value;
      out.push(
        `  ${thread.title ?? '(no title)'} · report #${readReportCount(thread.metadata)} · status ${thread.status ?? 'UNKNOWN'}`,
      );
      out.push('');
      out.push(...(await openAsksSection(ctx, continuesFrom)));
      out.push('');
      out.push(
        `  These are carried by "continuesFrom": "${continuesFrom}" in the payload below. Disposition each one — the ones you mark`,
      );
      out.push(
        `  carried move onto this session's thread; the rest are closed on ${continuesFrom} with your reason.`,
      );
    }
  }

  out.push('');
  out.push('FACTS I WILL ATTACH (you do not type any of these)');
  out.push(`  sessionId       ${facts.sessionId ?? 'UNKNOWN'}`);
  out.push(`  transcriptPath  ${facts.transcriptPath ?? 'UNKNOWN'}`);
  out.push(
    `  repo / branch   ${facts.repo ?? 'UNKNOWN'} / ${facts.branch ?? 'UNKNOWN'}`,
  );
  out.push(
    `  worktree        ${facts.isWorktree == null ? 'UNKNOWN' : facts.isWorktree ? (facts.worktreePath ?? 'yes') : 'primary checkout'}`,
  );
  out.push(`  headSha         ${facts.headSha ?? 'UNKNOWN'}`);
  out.push(
    `  dirty           ${facts.dirty == null ? 'UNKNOWN' : String(facts.dirty)}`,
  );
  out.push(
    `  aheadBehind     ${facts.aheadBehind == null ? 'UNKNOWN' : `${facts.aheadBehind.ahead} ahead / ${facts.aheadBehind.behind} behind`}`,
  );
  out.push(`  tokensAtStop    ${facts.tokensAtStop ?? 'UNKNOWN'}`);
  out.push(`  model           ${facts.model ?? 'UNKNOWN'}`);
  out.push(`  startedAt       ${facts.startedAt ?? 'UNKNOWN'}`);
  out.push(
    `  lastUserMessage ${facts.lastUserMessage == null ? 'UNKNOWN' : `${facts.lastUserMessage.slice(0, 120)}${facts.lastUserMessage.length > 120 ? '…' : ''}`}`,
  );
  for (const failure of facts.autofillFailures) out.push(`  ⚠️ ${failure}`);

  out.push('');
  out.push('WRITE YOUR PAYLOAD, THEN REPORT');
  out.push(
    `  1. Write this JSON (filled in) to ${sessionId == null ? '<a path>' : draftPath(sessionId, env)}`,
  );
  out.push('  2. Run: justin-sdk thread report --file <that path>');
  out.push('');
  out.push(payloadSkeleton({continuesFrom}));
  out.push('');
  for (const line of PAYLOAD_PRIORITY_GUIDANCE) out.push(line);

  console.log(out.join('\n'));
  return 0;
}
