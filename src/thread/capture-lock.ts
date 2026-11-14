/**
 * Who holds a session's capture lock (home-base-ttztr).
 *
 * ONE rule for the lock's holder: `tryCaptureLock` (capture.ts) steals the lock
 * only when this says `gone`, and `thread request --continues` and `thread
 * status` read the same answer to decide whether an attempt is still running.
 * The lock file holds the holder's pid and nothing else; this reads it and
 * never writes it.
 */

import type {EnvLike} from './paths';

import {readFileSync} from 'fs';

import {captureLockPath} from './archive';
import {pidAlive} from './commit';

export type CaptureLockHolder =
  /** No lock file: nobody holds it. */
  | {kind: 'free'}
  /** A running process other than this one holds it. */
  | {kind: 'alive'; pid: number}
  /** Its holder is MEASURABLY gone: `tryCaptureLock` steals it. */
  | {kind: 'gone'; pid: number}
  /** This process holds it. */
  | {kind: 'self'}
  /** The file could not be read, holds no pid, or the pid could not be checked. */
  | {kind: 'unknown'; reason: string};

export function readCaptureLockHolder(
  sessionId: string,
  env: EnvLike,
): CaptureLockHolder {
  const path = captureLockPath(sessionId, env);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8').trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {kind: 'free'};
    }
    return {
      kind: 'unknown',
      reason: `${path} could not be read: ${String(error)}`,
    };
  }
  if (!/^[0-9]+$/.test(raw)) {
    return {kind: 'unknown', reason: `${path} does not hold a pid`};
  }
  const pid = Number(raw);
  if (pid === process.pid) return {kind: 'self'};
  const alive = pidAlive(pid);
  if (alive === false) return {kind: 'gone', pid};
  if (alive === true) return {kind: 'alive', pid};
  return {
    kind: 'unknown',
    reason: `whether process ${pid}, which holds ${path}, is running could not be checked`,
  };
}
