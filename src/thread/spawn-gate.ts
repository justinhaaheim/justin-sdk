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
 * The pacing hold (usage.paceHold, home-base-jm5kg.17) comes with the handoff
 * gate's usage check, so it reaches a spawn only where successor is on.
 *
 * The usage limits reach the gate as resolved, usage.onUnknown included
 * (home-base-kj353, Justin 2026-11-19): a spawn treats an unknown usage
 * reading exactly as a handoff does. With onUnknown allow, the default, an
 * unknown reading passes; the spawn's output says so and the caller's session
 * bead gets a note. A fresh reading over a ceiling still refuses, and so does
 * a stale one whose week was over its ceiling and has not reset.
 *
 * A refusal exits 3, opens nothing, and is recorded on the caller's session
 * bead when the caller has one. The gate's own `message` is worded for
 * `thread handoff` ("include the handoff block printed above"), so the text
 * here is built from the reason and the detail.
 *
 * Kept out of spawn.ts so that file's diff stays small (the mayor session
 * edits spawn.ts in the primary checkout).
 */

import type {
  HandoffGateReaders,
  HandoffGateResult,
  HandoffRefusalReason,
} from './handoff-gate';
import type {ResolvedHandoffConfig} from './handoff-knob';
import type {EnvLike} from './paths';

import {
  realHandoffGateReaders,
  recordRefusal,
  runHandoffGate,
  runQuotaCheck,
} from './handoff-gate';
import {appendSessionNote} from './handoff-predecessor';
import {readQuotaForGate} from './quota-gate';
import {appendQuotaLog} from './quota-log';
import {selectSession} from './session-select';

/** What a refused spawn tells the calling Claude, after its reason. */
export const SPAWN_REFUSAL_INSTRUCTIONS = [
  'No session was opened.',
  'This refusal is final: do not retry the spawn and do not work around it.',
  'Never start a session another way: no cmux command, no claude command.',
] as const;

/** What a deferred spawn tells the calling Claude (home-base-89c8h.1 D6). */
export const SPAWN_DEFERRAL_INSTRUCTIONS = [
  'Nothing was refused, and no session was opened.',
  'This command already waited for cmux. Run the same command again at once, up to 3 more times.',
  'If it still exits 4, say so in your final report and stop.',
  'Never start a session another way: no cmux command, no claude command.',
] as const;

export interface SpawnGateDeps {
  /** The note on the caller's bead when an unknown usage reading passed. */
  appendNote: typeof appendSessionNote;
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
  /**
   * The readers the real gate runs with: realHandoffGateReaders' spawn set (no
   * chain, no launch record). Tests pass fakes, so the limits the real gate
   * hands runHandoffGate are what they test (home-base-kj353).
   */
  readers: (input: {
    commandWords: readonly string[];
    cwd: string;
    env: EnvLike;
  }) => HandoffGateReaders;
  recordRefusal: typeof recordRefusal;
}

/**
 * An unknown usage reading the gate let through (usage.onUnknown allow,
 * home-base-kj353), and whether the caller's session bead got the note.
 */
export interface SpawnUsageUnknown {
  /** Why the reading is unknown: the gate's facts.usage.unknown. */
  detail: string;
  /** notNoted: why the note is not on the caller's bead. */
  noted: {beadId: string; kind: 'noted'} | {kind: 'notNoted'; reason: string};
}

/**
 * What the spawn gate decided. `go` always states usageUnknown, null or not,
 * so no pass can leave out an unknown reading without saying so: `thread
 * spawn` prints it on every outcome after the gate (home-base-kj353).
 */
export type SpawnGateOutcome =
  | {exitCode: 3 | 4; kind: 'stop'; lines: string[]}
  | {kind: 'go'; usageUnknown: SpawnUsageUnknown | null};

/** The bead note an unknown usage reading leaves (home-base-kj353). */
export function spawnUsageUnknownNote(detail: string): string {
  return `usage unknown at spawn; the usage check let the spawn go on because componentConfig.thread.handoff.usage.onUnknown is allow: ${detail}`;
}

/** The ⚠️ Usage value `thread spawn` prints, worded like the handoff's. */
export function spawnUsageUnknownValue(usage: SpawnUsageUnknown): string {
  const noted =
    usage.noted.kind === 'noted' ? '' : ` (not noted: ${usage.noted.reason})`;
  return `⚠️ unknown; the usage check let the spawn go on (usage.onUnknown is allow): ${usage.detail}${noted}`;
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

const realSpawnGateReaders: SpawnGateDeps['readers'] = ({
  commandWords,
  cwd,
  env,
}) => realHandoffGateReaders({commandWords, cwd, env, sessionBeadId: null});

function realSpawnGate(
  input: Parameters<SpawnGateDeps['gate']>[0],
  readers: SpawnGateDeps['readers'],
): Promise<HandoffGateResult> {
  return runHandoffGate({
    env: input.env,
    // home-base-kj353: the limits as resolved, so usage.onUnknown governs a
    // spawn exactly as it governs a handoff (Justin, 2026-11-19).
    limits: input.limits,
    now: input.now,
    readers: readers({
      // F14: the CLI's own words, the half of the guard pass it must match.
      commandWords: input.commandWords ?? process.argv.slice(2),
      cwd: input.cwd,
      env: input.env,
    }),
    requireCmuxPane: false,
  });
}

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

/** Why the calling session has no session bead to write on. */
function noSessionBead(
  selected: Exclude<ReturnType<typeof selectSession>, {kind: 'found'}>,
): string {
  return selected.kind === 'checkoutMissing'
    ? `its checkout ${selected.checkoutPath} is gone`
    : selected.reason;
}

/**
 * home-base-kj353: note an unknown usage reading that passed on the caller's
 * session bead (CLAUDE_CODE_SESSION_ID), as a handoff notes its own. The new
 * session's bead does not exist yet, so nothing is written there.
 */
function noteUsageUnknown(input: {
  appendNote: typeof appendSessionNote;
  detail: string;
  env: EnvLike;
  now: Date;
}): SpawnUsageUnknown {
  const {detail, env, now} = input;
  const selected = selectSession({env, selector: null, sessionIdOption: null});
  if (selected.kind !== 'found') {
    return {
      detail,
      noted: {
        kind: 'notNoted',
        reason: `the calling session has no session bead (${noSessionBead(selected)})`,
      },
    };
  }
  const {session} = selected;
  const written = input.appendNote({
    beadId: session.bead.id,
    db: session.db,
    env,
    now,
    text: spawnUsageUnknownNote(detail),
  });
  return {
    detail,
    noted:
      written.kind === 'recorded'
        ? {beadId: session.bead.id, kind: 'noted'}
        : // appendSessionNote's reasons name the bead already.
          {kind: 'notNoted', reason: written.reason},
  };
}

/**
 * `go`: the knob is off, or the gate passed, and the spawn goes on; with an
 * unknown usage reading that passed, usageUnknown says why and whether the
 * caller's bead got the note. `stop`: the exit-3 or exit-4 result `thread
 * spawn` returns as it is.
 *
 * A deferral writes nothing on the caller's bead: the handoff-deferred label
 * is about the caller's own handoff, and a spawn that later passes would not
 * remove it.
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
): Promise<SpawnGateOutcome> {
  const {cwd, env} = input;
  // Behind an await import: config pulls in zod (command.ts's header).
  const {resolveThreadConfig} = await import('./config');
  const limits = resolveThreadConfig({cwd, env}).handoff;
  const now = input.now ?? new Date();
  let result: HandoffGateResult;
  if (!limits.successor) {
    // Successor off: no handoff gate, but the spend quota still gates a
    // spawn wherever its mode is not off (home-base-ys9t7.5 D7). It reads no
    // usage, so it never carries an unknown reading.
    const quota = await (deps.quotaCheck ?? realQuotaCheck)({cwd, env, now});
    if (quota == null) return {kind: 'go', usageUnknown: null};
    result = quota;
  } else {
    const gate =
      deps.gate ??
      ((gateInput: Parameters<SpawnGateDeps['gate']>[0]) =>
        realSpawnGate(gateInput, deps.readers ?? realSpawnGateReaders));
    result = await gate({
      ...(input.commandWords == null ? {} : {commandWords: input.commandWords}),
      cwd,
      env,
      limits,
      now,
    });
  }
  if (result.kind === 'pass') {
    const {usage} = result.facts;
    if (!('unknown' in usage)) return {kind: 'go', usageUnknown: null};
    return {
      kind: 'go',
      usageUnknown: noteUsageUnknown({
        appendNote: deps.appendNote ?? appendSessionNote,
        detail: usage.unknown,
        env,
        now,
      }),
    };
  }
  if (result.kind === 'deferred') {
    return {
      exitCode: 4,
      kind: 'stop',
      lines: [
        `thread spawn: deferred by the handoff gate: ${result.reason}: ${result.detail}`,
        '',
        ...SPAWN_DEFERRAL_INSTRUCTIONS,
      ],
    };
  }

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
    recorded = `Not recorded: the calling session has no session bead to record it on (${noSessionBead(selected)}).`;
  }
  return {
    exitCode: 3,
    kind: 'stop',
    lines: spawnRefusalLines(result.reason, result.detail, recorded),
  };
}
