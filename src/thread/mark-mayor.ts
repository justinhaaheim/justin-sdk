/**
 * `thread mark --mayor` (home-base-6n7my.2 D7): this session is a mayor session.
 * It adds `session-role:mayor` to this session's bead and runs the workspace name
 * follow-up, so cmux shows `[MAYOR]` at once. The number is never an argument and
 * neither is the session: it is always the session this runs in.
 *
 * IDEMPOTENT. A bead that already has the label gets no write. A hook retries at
 * every Stop, so with --hook it also skips the name follow-up: one br read.
 *
 * NO BEAD YET. A session's bead is filed in the background after its first prompt
 * (15.7 s in one measured run, pkg/justin-sdk/CLAUDE.md), so this can run first.
 * It then exits 1 and says so. It never claims success, and it stays exit 1 rather
 * than exit 2 because exit 2 from a Stop hook would stop the turn from ending.
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
import {MAYOR_ROLE_LABEL} from './session-bead';
import {selectSession, sessionBeadsKnob} from './session-select';
import {workspaceNameFollowUp} from './workspace-name-session';

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

export type MarkMayorOutcome =
  /** The bead already had the label: nothing was written. */
  | {beadId: string; kind: 'already'; workspaceNote: null | string}
  | {beadId: string; kind: 'marked'; workspaceNote: null | string}
  /** `--hook` and the payload names a subagent: nothing was read or written. */
  | {agentId: string; kind: 'subagent'}
  /** The bead is not there yet, or not known: nothing was written. */
  | {kind: 'noBead'; reason: string}
  | {kind: 'failed'; reason: string};

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

/** The whole command. Prints nothing and never exits. */
export async function markMayor(
  options: MarkMayorOptions = {},
): Promise<MarkMayorOutcome> {
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
  const already = session.bead.labels.includes(MAYOR_ROLE_LABEL);
  if (!already) {
    const written = (options.update ?? brUpdate)(
      {db: session.db, env},
      beadId,
      {
        addLabels: [MAYOR_ROLE_LABEL],
      },
    );
    if (written.kind === 'failed') {
      return {
        kind: 'failed',
        reason: `${beadId} was NOT labelled ${MAYOR_ROLE_LABEL}: ${describeBrFailed(written)}`,
      };
    }
  }
  // A hook repeats at every Stop, and the capture child syncs the names then.
  const workspaceNote =
    already && options.hookPayload !== undefined
      ? null
      : await followUp({cwd, env, sessionId: session.sessionId});
  return {beadId, kind: already ? 'already' : 'marked', workspaceNote};
}

/** What the command prints, and its exit code: 0 the mark holds or a subagent, else 1. */
export function describeMarkMayor(outcome: MarkMayorOutcome): {
  exitCode: 0 | 1;
  lines: string[];
} {
  switch (outcome.kind) {
    case 'marked':
    case 'already': {
      const first =
        outcome.kind === 'marked'
          ? `session ${outcome.beadId} is now a mayor session: labelled ${MAYOR_ROLE_LABEL}`
          : `session ${outcome.beadId} is already a mayor session: nothing written`;
      return {
        exitCode: 0,
        lines:
          outcome.workspaceNote == null
            ? [first]
            : [first, `  ${outcome.workspaceNote}`],
      };
    }
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

export async function runThreadMark(input: {
  hook: boolean;
  mayor: boolean;
}): Promise<number> {
  if (!input.mayor) {
    console.error(
      'thread mark: refused: name the mark. --mayor is the only one. Nothing was written.',
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
  const {exitCode, lines} = describeMarkMayor(
    await markMayor(hookPayload === undefined ? {} : {hookPayload}),
  );
  const write = exitCode === 0 ? console.log : console.error;
  for (const line of lines) write(line);
  return exitCode;
}
