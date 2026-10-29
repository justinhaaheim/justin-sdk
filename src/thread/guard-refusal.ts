/**
 * The record of a subagent's refused thread command (home-base-mbnjv.5, epic
 * C8). Its own module so the gate (handoff-gate.ts) and the guard's
 * registration check do not import each other.
 */

import type {EnvLike} from './paths';

import {recordRefusal} from './handoff-gate';
import {selectSession} from './session-select';

/**
 * Record a subagent's refused `thread handoff|spawn|respawn` on the PARENT's
 * session bead (the payload's session_id is the parent's): label
 * handoff-refused, note "handoff refused: subagent — …". Returns the line the
 * denial prints.
 */
export function recordSubagentRefusal(input: {
  agentId: string;
  agentType: string | null;
  command: string;
  env: EnvLike;
  now: Date;
  sessionId: string | null;
}): string {
  const selected = selectSession({
    env: input.env,
    selector: null,
    sessionIdOption: input.sessionId,
  });
  if (selected.kind !== 'found') {
    const why =
      selected.kind === 'checkoutMissing'
        ? `its checkout ${selected.checkoutPath} is gone`
        : selected.reason;
    return `Not recorded: the session that dispatched this subagent has no session bead to record it on (${why}).`;
  }
  const {session} = selected;
  const written = recordRefusal({
    beadId: session.bead.id,
    db: session.db,
    detail: `a subagent (${input.agentType ?? 'agent'} ${input.agentId}) ran \`${input.command}\`; the guard refused it`,
    env: input.env,
    now: input.now,
    reason: 'subagent',
  });
  return written.kind === 'recorded'
    ? `Recorded on ${session.bead.id}: ${written.line}`
    : `⚠️ ${written.reason}`;
}
