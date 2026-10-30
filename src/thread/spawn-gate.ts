/**
 * The spawn gate (epic home-base-mbnjv C4; built by home-base-mbnjv.2):
 * `thread spawn` runs the handoff gate's kill switch, cmux, usage and
 * live-session checks before it opens a workspace, when
 * componentConfig.thread.handoff.successor is on in the repo it runs in (its
 * cwd). It skips the chain count (a spawn starts no chain) and the cmux-pane
 * check (it opens a workspace of its own, D5).
 *
 * The spend quota (home-base-ys9t7.5 D7) runs inside the handoff gate, and
 * ON ITS OWN where successor is off: a spawn starts a session that spends.
 *
 * A refusal exits 3, opens nothing, and is recorded on the caller's session
 * bead when the caller has one. The gate's own `message` is worded for
 * `thread handoff` ("include the handoff block printed above"), so the text
 * here is built from the reason and the detail.
 *
 * Kept out of spawn.ts so that file's diff stays one call (the mayor session
 * edits spawn.ts in the primary checkout).
 */

import type {HandoffGateResult, HandoffRefusalReason} from './handoff-gate';
import type {ResolvedHandoffConfig} from './handoff-knob';
import type {EnvLike} from './paths';

import {
  realHandoffGateReaders,
  recordRefusal,
  runHandoffGate,
  runQuotaCheck,
} from './handoff-gate';
import {readQuotaForGate} from './quota-gate';
import {appendQuotaLog} from './quota-log';
import {selectSession} from './session-select';

/** What a refused spawn tells the calling Claude, after its reason. */
export const SPAWN_REFUSAL_INSTRUCTIONS = [
  'No session was opened.',
  'This refusal is final: do not retry the spawn and do not work around it.',
  'Never start a session another way: no cmux command, no claude command.',
] as const;

export interface SpawnGateDeps {
  gate: (input: {
    /** F14: the words the guard pass must match; default process.argv.slice(2). */
    commandWords?: readonly string[];
    cwd: string;
    env: EnvLike;
    limits: ResolvedHandoffConfig;
    now: Date;
  }) => Promise<HandoffGateResult>;
  /**
   * The spend quota alone (handoff-gate.ts runQuotaCheck), for a repo whose
   * successor knob is off: the quota still gates a spawn there (D7).
   */
  quotaCheck: (input: {
    cwd: string;
    env: EnvLike;
    now: Date;
  }) => ReturnType<typeof runQuotaCheck>;
  recordRefusal: typeof recordRefusal;
}

const realQuotaCheck: SpawnGateDeps['quotaCheck'] = ({cwd, env, now}) =>
  runQuotaCheck(
    {
      quota: () =>
        readQuotaForGate({cwd, env, nowMs: now.getTime(), purpose: 'spawn'}),
      quotaLog: (line) => {
        const written = appendQuotaLog(line, env);
        return written.kind === 'failed' ? written.reason : null;
      },
    },
    now,
  );

const realSpawnGate: SpawnGateDeps['gate'] = (input) =>
  runHandoffGate({
    env: input.env,
    limits: input.limits,
    now: input.now,
    readers: realHandoffGateReaders({
      // F14: the CLI's own words, the half of the guard pass it must match.
      commandWords: input.commandWords ?? process.argv.slice(2),
      cwd: input.cwd,
      env: input.env,
      sessionBeadId: null,
    }),
    requireCmuxPane: false,
  });

/** The lines a refused spawn prints. */
export function spawnRefusalLines(
  reason: HandoffRefusalReason,
  detail: string,
  recorded: string,
): string[] {
  return [
    `thread spawn: refused by the handoff gate: ${reason}: ${detail}`,
    '',
    ...SPAWN_REFUSAL_INSTRUCTIONS,
    '',
    recorded,
  ];
}

/**
 * null: the knob is off, or the gate passed, and the spawn goes on. Otherwise
 * the exit-3 result `thread spawn` returns as it is.
 */
export async function spawnGate(
  input: {
    /** F14: tests name the call; the CLI leaves it to process.argv. */
    commandWords?: readonly string[];
    cwd: string;
    env: EnvLike;
    now?: Date;
  },
  deps: Partial<SpawnGateDeps> = {},
): Promise<{exitCode: 3; lines: string[]} | null> {
  const {cwd, env} = input;
  // Behind an await import: config pulls in zod (command.ts's header).
  const {resolveThreadConfig} = await import('./config');
  const limits = resolveThreadConfig({cwd, env}).handoff;
  const now = input.now ?? new Date();
  let result: HandoffGateResult;
  if (!limits.successor) {
    // Successor off: no handoff gate, but the spend quota still gates a
    // spawn wherever its mode is not off (home-base-ys9t7.5 D7).
    const quota = await (deps.quotaCheck ?? realQuotaCheck)({cwd, env, now});
    if (quota == null) return null;
    result = quota;
  } else {
    result = await (deps.gate ?? realSpawnGate)({
      ...(input.commandWords == null ? {} : {commandWords: input.commandWords}),
      cwd,
      env,
      limits,
      now,
    });
  }
  if (result.kind === 'pass') return null;

  // The caller's session bead, when it has one: CLAUDE_CODE_SESSION_ID.
  const selected = selectSession({env, selector: null, sessionIdOption: null});
  let recorded: string;
  if (selected.kind === 'found') {
    const {session} = selected;
    const written = (deps.recordRefusal ?? recordRefusal)({
      beadId: session.bead.id,
      db: session.db,
      detail: `thread spawn: ${result.detail}`,
      env,
      now,
      reason: result.reason,
    });
    recorded =
      written.kind === 'recorded'
        ? `Recorded on ${session.bead.id}: ${written.line}`
        : `⚠️ ${written.reason}`;
  } else {
    recorded = `Not recorded: the calling session has no session bead to record it on (${selected.kind === 'checkoutMissing' ? `its checkout ${selected.checkoutPath} is gone` : selected.reason}).`;
  }
  return {
    exitCode: 3,
    lines: spawnRefusalLines(result.reason, result.detail, recorded),
  };
}
