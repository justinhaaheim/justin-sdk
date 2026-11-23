/**
 * `thread mark --mayor` (home-base-6n7my.2 D7): this session is a mayor session.
 * It adds `session-role:mayor` to this session's bead and runs the workspace name
 * follow-up, so cmux shows `[MAYOR]` at once. The number is never an argument and
 * neither is the session: it is always the session this runs in.
 *
 * `thread mark --conductor` (home-base-eq5oy C1) is the same command for
 * `session-role:conductor`, and shares every step here. Two differences:
 * - No workspace name follow-up: no session name shows a conductor mark
 *   (session-name.ts is unchanged, out of scope there), so it has nothing to
 *   show.
 * - With --hook it prints nothing and exits 0 on every path (runThreadMark).
 *   It runs from the conductor skill's Stop hook in every repo a conductor
 *   works in, so a failure must never show as a hook error. The hook runs again
 *   at every Stop, which is the retry.
 *
 * ONE ROLE (C4). A session never carries both roles, and the mayor wins: the
 * conductor mark on a mayor writes nothing and says so, and the mayor mark
 * removes a conductor label in its one write (sessionRoleLabelsAfter).
 *
 * IDEMPOTENT. A bead that already has the label gets no write. A hook retries at
 * every Stop, so with --hook it also skips the name follow-up: one br read.
 *
 * NO BEAD YET. A session's bead is filed in the background after its first prompt
 * (15.7 s in one measured run, pkg/justin-sdk/CLAUDE.md), so this can run first.
 * It then exits 1 and says so. It never claims success, and it stays exit 1 rather
 * than exit 2 because exit 2 from a Stop hook would stop the turn from ending.
 * (`--conductor --hook` exits 0 here too, and prints nothing: C1.)
 *
 * --hook reads the hook payload from stdin. A payload with `agent_id` came from a
 * subagent, whose environment equals its parent's (pkg/justin-sdk/CLAUDE.md), and
 * a subagent loading the skill must not mark its parent: nothing happens. The
 * session is the payload's `session_id` and never the environment, so a payload
 * that cannot be read marks nothing (critical rule 7).
 */

import type {EnvLike} from './paths';

import {readFileSync} from 'node:fs';

import {brUpdate, describeBrFailed, saysBeadsLocked} from '../beads/br';
import {
  CONDUCTOR_ROLE_LABEL,
  MAYOR_ROLE_LABEL,
  sessionRoleLabelsAfter,
} from './session-bead';
import {selectSession, sessionBeadsKnob} from './session-select';
import {workspaceNameFollowUp} from './workspace-name-session';

export type SessionRole = 'conductor' | 'mayor';

const ROLE_LABEL: Readonly<Record<SessionRole, string>> = {
  conductor: CONDUCTOR_ROLE_LABEL,
  mayor: MAYOR_ROLE_LABEL,
};

/** C4's one sentence, wherever the mayor wins. */
const MAYOR_WINS = 'a session never carries both roles, and the mayor wins';

export interface MarkMayorOptions {
  cwd?: string;
  env?: EnvLike;
  /** Sets the workspace name and the tab title. Soft: one line, or null. */
  followUp?: typeof workspaceNameFollowUp;
  /** `--hook`: the payload, read from stdin by the caller. */
  hookPayload?: null | string;
  /** The label's br write; a test counts these. */
  update?: typeof brUpdate;
}

export type MarkRoleOutcome =
  /** The bead already had the label, and no other role: nothing was written. */
  | {
      beadId: string;
      kind: 'already';
      role: SessionRole;
      workspaceNote: null | string;
    }
  /**
   * One br write. `added`: the role label, or nothing when it was there.
   * `removed`: the conductor label a mayor took off (C4).
   */
  | {
      added: string[];
      beadId: string;
      kind: 'marked';
      removed: string[];
      role: SessionRole;
      workspaceNote: null | string;
    }
  /** C4: the conductor mark, on a mayor session. Nothing was written. */
  | {beadId: string; kind: 'mayorWins'}
  /** `--hook` and the payload names a subagent: nothing was read or written. */
  | {agentId: string; kind: 'subagent'}
  /** The bead is not there yet, or not known: nothing was written. */
  | {kind: 'noBead'; reason: string}
  | {kind: 'failed'; reason: string};

export type MarkMayorOutcome = MarkRoleOutcome;

function nonEmptyText(value: unknown): null | string {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** The two fields --hook needs. Anything else is a reason, never a guess. */
function readHookPayload(
  raw: string,
):
  | {agentId: null | string; kind: 'read'; sessionId: null | string}
  | {kind: 'failed'; reason: string} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      kind: 'failed',
      reason: `the hook payload on stdin is not JSON: ${String(error)}`,
    };
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      kind: 'failed',
      reason: 'the hook payload on stdin is not an object',
    };
  }
  const record = parsed as Record<string, unknown>;
  return {
    agentId: nonEmptyText(record.agent_id),
    kind: 'read',
    sessionId: nonEmptyText(record.session_id),
  };
}

/** The whole command, for either role. Prints nothing and never exits. */
export async function markRole(
  role: SessionRole,
  options: MarkMayorOptions = {},
): Promise<MarkRoleOutcome> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const followUp = options.followUp ?? workspaceNameFollowUp;
  let sessionIdOption: null | string = null;
  if (options.hookPayload !== undefined) {
    const payload = readHookPayload(options.hookPayload ?? '');
    if (payload.kind === 'failed') {
      return {kind: 'failed', reason: payload.reason};
    }
    if (payload.agentId != null) {
      return {agentId: payload.agentId, kind: 'subagent'};
    }
    if (payload.sessionId == null) {
      return {
        kind: 'failed',
        reason: 'the hook payload on stdin has no session_id',
      };
    }
    sessionIdOption = payload.sessionId;
  }
  const knob = await sessionBeadsKnob(cwd, env);
  if (!knob.ok) return {kind: 'failed', reason: knob.reason};
  const selected = selectSession({env, selector: null, sessionIdOption});
  if (selected.kind === 'noSession') {
    return {kind: 'noBead', reason: selected.reason};
  }
  if (selected.kind === 'checkoutMissing') {
    return {
      kind: 'failed',
      reason: `this session's beads live in ${selected.checkoutPath}, which no longer exists`,
    };
  }
  if (selected.kind === 'failed') {
    return {kind: 'failed', reason: selected.reason};
  }
  const {session} = selected;
  const beadId = session.bead.id;
  const {labels} = session.bead;
  if (role === 'conductor' && labels.includes(MAYOR_ROLE_LABEL)) {
    return {beadId, kind: 'mayorWins'};
  }
  const change = sessionRoleLabelsAfter(labels, role);
  const already = change.add.length === 0 && change.remove.length === 0;
  if (!already) {
    const written = (options.update ?? brUpdate)(
      {db: session.db, env},
      beadId,
      {
        addLabels: change.add,
        ...(change.remove.length > 0 ? {removeLabels: change.remove} : {}),
      },
    );
    if (written.kind === 'failed') {
      return {
        kind: 'failed',
        reason: `${beadId} was NOT labelled ${ROLE_LABEL[role]}: ${describeBrFailed(written)}`,
      };
    }
  }
  // A hook repeats at every Stop, and the capture child syncs the names then.
  // C1: no name shows the conductor role, so there is nothing to sync for it.
  const workspaceNote =
    role === 'conductor' || (already && options.hookPayload !== undefined)
      ? null
      : await followUp({cwd, env, sessionId: session.sessionId});
  return already
    ? {beadId, kind: 'already', role, workspaceNote}
    : {
        added: change.add,
        beadId,
        kind: 'marked',
        removed: change.remove,
        role,
        workspaceNote,
      };
}

export function markMayor(
  options: MarkMayorOptions = {},
): Promise<MarkRoleOutcome> {
  return markRole('mayor', options);
}

export function markConductor(
  options: MarkMayorOptions = {},
): Promise<MarkRoleOutcome> {
  return markRole('conductor', options);
}

/** What the command prints, and its exit code: 0 the mark holds or a subagent, else 1. */
export function describeMarkMayor(outcome: MarkRoleOutcome): {
  exitCode: 0 | 1;
  lines: string[];
} {
  switch (outcome.kind) {
    case 'marked':
    case 'already': {
      const label = ROLE_LABEL[outcome.role];
      const first =
        outcome.kind === 'already'
          ? `session ${outcome.beadId} is already a ${outcome.role} session: nothing written`
          : outcome.added.length === 0
            ? `session ${outcome.beadId} is already a ${outcome.role} session: labelled ${label}`
            : `session ${outcome.beadId} is now a ${outcome.role} session: labelled ${label}`;
      const removed =
        outcome.kind === 'marked' && outcome.removed.length > 0
          ? [`  removed ${outcome.removed.join(', ')}: ${MAYOR_WINS}`]
          : [];
      return {
        exitCode: 0,
        lines: [
          first,
          ...removed,
          ...(outcome.workspaceNote == null
            ? []
            : [`  ${outcome.workspaceNote}`]),
        ],
      };
    }
    case 'mayorWins':
      return {
        exitCode: 0,
        lines: [
          `session ${outcome.beadId} is a mayor session, so ${CONDUCTOR_ROLE_LABEL} was NOT written: ${MAYOR_WINS}`,
        ],
      };
    case 'subagent':
      return {
        exitCode: 0,
        lines: [
          `thread mark: nothing done: the hook ran for subagent ${outcome.agentId}, and a subagent loading the skill must not mark its parent`,
        ],
      };
    case 'noBead':
      return {
        exitCode: 1,
        lines: [
          `thread mark: NOT marked: this session has no session bead yet: ${outcome.reason}. A session's bead is filed in the background after its first prompt, so run this again in a moment.`,
        ],
      };
    case 'failed':
      return {
        exitCode: 1,
        lines: [
          `thread mark: NOT marked: ${outcome.reason}${saysBeadsLocked(outcome.reason) ? '. The beads database was busy, so run this again in a moment' : ''}`,
        ],
      };
  }
}

function printed(result: {exitCode: 0 | 1; lines: string[]}): number {
  const write = result.exitCode === 0 ? console.log : console.error;
  for (const line of result.lines) write(line);
  return result.exitCode;
}

export async function runThreadMark(input: {
  conductor: boolean;
  hook: boolean;
  mayor: boolean;
}): Promise<number> {
  if (!input.mayor && !input.conductor) {
    console.error(
      'thread mark: refused: name the mark: --mayor or --conductor. Nothing was written.',
    );
    return 2;
  }
  let hookPayload: null | string | undefined;
  if (input.hook) {
    try {
      hookPayload = readFileSync(0, 'utf8');
    } catch {
      hookPayload = null;
    }
  }
  const options = hookPayload === undefined ? {} : {hookPayload};
  if (!input.mayor) {
    if (input.hook) {
      // C1: the conductor skill's Stop hook prints nothing and exits 0 on
      // every path, a throw included. The next Stop tries again.
      try {
        await markConductor(options);
      } catch {
        // Nothing: see above.
      }
      return 0;
    }
    return printed(describeMarkMayor(await markConductor(options)));
  }
  const result = describeMarkMayor(await markMayor(options));
  if (input.conductor && !input.hook) {
    // C4: both named, and the mayor wins.
    result.lines.push(
      `thread mark: --conductor ignored: ${CONDUCTOR_ROLE_LABEL} was NOT written: ${MAYOR_WINS}`,
    );
  }
  return printed(result);
}
