/**
 * The brake's cached decision per session (request home-base-ys9t7.5 D6;
 * dispatch 2 items 4 and 5): `<threads state dir>/quota-brake/<session>.json`.
 *
 * Its own file so `thread stop-check` can ask "is this session braked?"
 * without loading the brake's shell parser: it imports only node:fs, node:path
 * and paths.ts.
 */

import type {QuotaMode} from './defaults';
import type {Attendance} from './quota-group';

import {randomBytes} from 'node:crypto';
import {mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';

import {type EnvLike, threadsStateDir} from './paths';

// ---------------------------------------------------------------------------

export type BrakeStateKind = 'attendedUnknown' | 'braked' | 'clear';

export interface BrakeState {
  attendance: Attendance['kind'];
  /**
   * Set by the attended fast path (home-base-ys9t7.5.6): the decision holds
   * until then, the typed time plus attendedGraceMinutes, not for
   * recheckSeconds. Null: the recheckSeconds rule (and a file an older SDK
   * wrote, which lacks the field).
   */
  attendedUntilMs: number | null;
  computedAtMs: number;
  latestTypedAt: string | null;
  /** What the deny message names: the limits crossed, or why unknown. */
  limitText: string;
  /** The mode the decision was computed under; another mode recomputes. */
  mode: QuotaMode;
  sessionId: string;
  state: BrakeStateKind;
  /** The transcript and its size at the recompute: the reset check reads past it. */
  transcriptPath: string | null;
  transcriptSize: number | null;
  unattendedWeekPercent: number | null;
  verdict: string;
  version: 1;
}

export const BRAKE_STATE_DIR = 'quota-brake';

export function brakeStatePath(sessionId: string, env: EnvLike): string {
  return join(threadsStateDir(env), BRAKE_STATE_DIR, `${sessionId}.json`);
}

export type BrakeStateRead =
  | {kind: 'failed'; reason: string}
  | {kind: 'none'}
  | {kind: 'read'; state: BrakeState};

export function readBrakeState(
  sessionId: string,
  env: EnvLike = process.env,
): BrakeStateRead {
  const path = brakeStatePath(sessionId, env);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {kind: 'none'};
    }
    return {kind: 'failed', reason: `${path}: ${String(error)}`};
  }
  try {
    const parsed = JSON.parse(text) as Partial<BrakeState> | null;
    if (
      parsed?.version !== 1 ||
      typeof parsed.computedAtMs !== 'number' ||
      typeof parsed.state !== 'string' ||
      typeof parsed.mode !== 'string'
    ) {
      return {kind: 'failed', reason: `${path}: not a brake state`};
    }
    return {
      kind: 'read',
      state: {
        ...(parsed as BrakeState),
        attendedUntilMs:
          typeof parsed.attendedUntilMs === 'number'
            ? parsed.attendedUntilMs
            : null,
      },
    };
  } catch (error) {
    return {kind: 'failed', reason: `${path}: ${String(error)}`};
  }
}

/** Write by tmp + rename: a reader sees the old file or the new one, whole. */
export function writeBrakeState(state: BrakeState, env: EnvLike): void {
  const path = brakeStatePath(state.sessionId, env);
  mkdirSync(dirname(path), {recursive: true});
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state)}\n`);
  renameSync(tmp, path);
}

/**
 * Is this session braked right now, as far as its cached decision says
 * (enforce, and not clear)? Read by `thread stop-check` (item 5): a braked
 * session must be let stop, or it loops on denials. Any failure to read is
 * `false`: the Stop hook then decides as it always did.
 */
export function sessionBraked(sessionId: string, env: EnvLike): boolean {
  const read = readBrakeState(sessionId, env);
  return (
    read.kind === 'read' &&
    read.state.mode === 'enforce' &&
    read.state.state === 'braked'
  );
}
