/**
 * The system does the handoff pickup by itself (home-base-npbse.1.2; P1, P3, P5
 * and P7 in the design field of home-base-npbse.1), behind
 * componentConfig.thread.handoff.autoPickup, default false.
 *
 * A session is a successor only when it is MARKED, by one of two routes (P1):
 *
 *   1. The launch: `thread handoff` and `thread spawn --continues` type
 *      JUSTIN_SDK_CONTINUES=<predecessor bead> before `claude`.
 *   2. The first user line, for a successor started by hand from a pasted block
 *      or from a mayor kickoff written before the variable existed. It counts
 *      ONLY when the line starts with the kickoff's own opening, or is the exact
 *      mayor form. A message that merely mentions `--continues <id>` or a bead id
 *      does not count: a session discussing the flag would otherwise take over
 *      another session's requests.
 *
 * A FAILURE IS NAMED (P5). The capture child (handoff-auto-pickup-run.ts) records
 * why the last attempt failed in a small file per session, so the prompt-time
 * [thread] line and `thread status` can say so without a br read. A retry writes
 * that file again and nothing else: the bead's notes do not grow.
 *
 * This file holds what the prompt-time line needs, and stays light on purpose:
 * the attempt itself lives in handoff-auto-pickup-run.ts, which the capture child
 * imports only with the knob on.
 */

import type {PickUpStep} from './handoff-pickup';
import type {EnvLike} from './paths';

import {mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';

import {sdkRun} from '../sdk-invocation';
import {readMessageLog} from './message-log';
import {threadsStateDir} from './paths';
import {KICKOFF_OPENING} from './respawn';
import {
  CONTINUES_ENV,
  NOT_A_SUCCESSOR_LABEL,
  PICKED_UP_LABEL,
} from './session-bead';

export interface SuccessorMark {
  predecessorBeadId: string;
  via: 'env' | 'first-line';
}

const MAYOR_FORM = /^\/conductor You continue session bead (\S+)\.(?:\s|$)/u;
const KICKOFF_COMMAND = /--continues\s+(\S*\w)/u;

/**
 * The predecessor a first user line names, or null. Only the kickoff's opening
 * or the exact mayor form, at the start of the line (the block's scope rule).
 */
export function predecessorInFirstLine(text: string): string | null {
  const line = text.trimStart();
  if (line.startsWith(KICKOFF_OPENING)) {
    return KICKOFF_COMMAND.exec(line)?.[1] ?? null;
  }
  return MAYOR_FORM.exec(line)?.[1] ?? null;
}

/** The launch variable first, then the first user line; null is not a successor. */
export function successorMark(input: {
  env: EnvLike;
  firstUserText: string | null;
}): SuccessorMark | null {
  const typed = input.env[CONTINUES_ENV]?.trim() ?? '';
  if (typed !== '') return {predecessorBeadId: typed, via: 'env'};
  if (input.firstUserText == null) return null;
  const named = predecessorInFirstLine(input.firstUserText);
  return named == null ? null : {predecessorBeadId: named, via: 'first-line'};
}

/** The session's own first user line, or null when the log holds none. */
export function firstUserTextOf(
  sessionId: string,
  env: EnvLike,
): string | null {
  const log = readMessageLog(sessionId, env);
  if (log.kind !== 'read') return null;
  return log.lines.find((line) => line.role === 'user')?.text ?? null;
}

// ---------------------------------------------------------------------------
// Why the last attempt failed
// ---------------------------------------------------------------------------

export interface PickupFailure {
  at: string;
  predecessorBeadId: string;
  reason: string;
  step: PickUpStep | 'threw';
}

function failurePath(sessionId: string, env: EnvLike): string {
  return join(threadsStateDir(env), 'handoff-pickup', `${sessionId}.json`);
}

export function writePickupFailure(
  sessionId: string,
  failure: PickupFailure,
  env: EnvLike,
): void {
  const path = failurePath(sessionId, env);
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, `${JSON.stringify(failure)}\n`);
}

export function clearPickupFailure(sessionId: string, env: EnvLike): void {
  rmSync(failurePath(sessionId, env), {force: true});
}

/** The last failure; null when none is recorded. A file that cannot be parsed says so. */
export function readPickupFailure(
  sessionId: string,
  env: EnvLike,
): null | PickupFailure | {reason: string; unreadable: true} {
  const path = failurePath(sessionId, env);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return {
      reason: `${path} could not be read: ${String(error)}`,
      unreadable: true,
    };
  }
  try {
    return JSON.parse(text) as PickupFailure;
  } catch (error) {
    return {reason: `${path} is not JSON: ${String(error)}`, unreadable: true};
  }
}

// ---------------------------------------------------------------------------
// What one attempt did
// ---------------------------------------------------------------------------

/** The `pickup` field of a capture.jsonl record. */
export type CapturePickupOutcome =
  /** Marked and already settled: one label read and nothing else. */
  | {kind: 'held'; label: typeof NOT_A_SUCCESSOR_LABEL | typeof PICKED_UP_LABEL}
  | {
      carriedQuestions: number;
      carriedRequests: number;
      kind: 'picked-up';
      predecessorBeadId: string;
      wrote: boolean;
    }
  | {kind: 'failed'; reason: string; step: PickUpStep | 'threw'}
  | {kind: 'not-a-successor'; predecessorBeadId: string; reason: string};

export interface AutoPickupInput {
  cwd: string;
  env: EnvLike;
  now: Date;
  sessionId: string;
}

// ---------------------------------------------------------------------------
// Saying it is not done
// ---------------------------------------------------------------------------

export interface PickupNotDone {
  /** The command that retries it now. */
  command: string;
  reason: string;
}

/** The fixed wording, without the command. */
export function pickupNotDoneWords(reason: string): string {
  return `handoff pickup not done: ${reason}; it retries at the next prompt or turn end; to retry now:`;
}

/** The whole sentence: the [thread] line prints this. */
export function pickupNotDoneText(notice: PickupNotDone): string {
  return `${pickupNotDoneWords(notice.reason)} ${notice.command}`;
}

/**
 * What to say until `picked-up` holds; null when nothing is owed: knob off, not
 * marked, already picked up, or `not-a-successor`, which gets no nagging.
 *
 * `ownSession`: whether `env` is this session's own. It decides whether the
 * launch variable counts, because `thread status --session <other>` runs in the
 * caller's environment.
 */
export function pickupNotDone(input: {
  autoPickup: boolean;
  env: EnvLike;
  labels: readonly string[];
  ownSession: boolean;
  sessionId: string;
}): null | PickupNotDone {
  const {autoPickup, env, labels, ownSession, sessionId} = input;
  if (!autoPickup) return null;
  if (labels.includes(PICKED_UP_LABEL)) return null;
  if (labels.includes(NOT_A_SUCCESSOR_LABEL)) return null;
  const failure = readPickupFailure(sessionId, env);
  const mark = successorMark({
    env: ownSession ? env : {},
    firstUserText: firstUserTextOf(sessionId, env),
  });
  const recorded =
    failure != null && !('unreadable' in failure) ? failure : null;
  const predecessor = recorded?.predecessorBeadId ?? mark?.predecessorBeadId;
  if (predecessor == null) return null;
  return {
    command: sdkRun(`thread request --continues ${predecessor}`),
    reason: failure?.reason ?? 'the first attempt has not finished',
  };
}
