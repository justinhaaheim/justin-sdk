/**
 * The bead writes `thread request --bead` shares with the handoff pickup
 * (home-base-npbse.1.1): adopting a bead as this session's request, and the
 * `title-set:` stamp that goes with a new session title. Split out of
 * request.ts so handoff-pickup.ts can reuse them while request.ts calls the
 * pickup, without an import cycle between the two.
 */

import type {EnvLike} from './paths';

import {brUpdate, describeBrFailed} from '../beads/br';
import {REQUEST_LABEL, sidLabel, titleSetLabelEdit} from './session-bead';

/**
 * home-base-ys9t7.9.1: the `title-set:` label edit that goes into the SAME
 * `br update` as a new session title, so `thread status` knows exactly which
 * requests were filed after it. Nothing when componentConfig.thread.
 * titleSummary is off (the old behaviour, exactly). `now` is read at the
 * rename, after any request was filed, unless a test injects one.
 */
export async function titleSetEdit(input: {
  cwd: string;
  env: EnvLike;
  labels: readonly string[];
  now: Date | undefined;
}): Promise<{addLabels: string[]; removeLabels: string[]}> {
  const {resolveThreadConfig} = await import('./config');
  if (!resolveThreadConfig({cwd: input.cwd, env: input.env}).titleSummary) {
    return {addLabels: [], removeLabels: []};
  }
  return titleSetLabelEdit(input.labels, input.now ?? new Date());
}

/**
 * What adopting did to the bead's status (home-base-vzwbj.4.9 F1). `already`:
 * it was in_progress, so no status change was sent. `left`: br refused the
 * claim (`cannot claim blocked issue`), so only the labels were added. `kept`:
 * the caller asked for the status to stay (a closed request being marked
 * overarching, home-base-b4t8w), so only the labels were added.
 */
export type AdoptedStatus =
  | {from: string; kind: 'set'}
  | {kind: 'already'}
  | {kind: 'kept'; status: string}
  | {blockers: string; kind: 'left'; status: string};

const CLAIM_REFUSAL = /cannot claim blocked issue:?\s*([^\n]*)/;

/**
 * The blockers br names when it refuses `--status=in_progress`, or null when
 * the failure is something else. Measured 2026-10-11: br 0.1.37 refuses a bead
 * with OPEN CHILDREN ("Validation failed: claim: cannot claim blocked issue:
 * u-86g.1", exit 4) and br 0.5.12 one with an open `blocks` dependency, with
 * the same words; both refusals are atomic (the labels in the same call are
 * not written either).
 */
export function claimRefusalBlockers(failureText: string): string | null {
  const match = CLAIM_REFUSAL.exec(failureText);
  if (match == null) return null;
  const blockers = (match[1] ?? '').trim();
  return blockers === '' ? 'unnamed' : blockers;
}

/**
 * Adopt bead `id` as a request of `sessionId`: add `request` + `sid:`, keep its
 * other `sid:` labels and its parent, and set it in_progress unless it already
 * is.
 *
 * F1 (home-base-vzwbj.4.9): the status change is sent only when the bead is not
 * already in_progress, and a claim br refuses (a bead it counts as blocked: br
 * 0.1.37 counts open children; br 0.7.6 does not and claims it, measured
 * 2026-10-26) still adopts, labels only.
 *
 * `keepStatus` adopts with labels only and never sends a status change.
 */
export function adoptBead(input: {
  db: string;
  env: EnvLike;
  id: string;
  /** Leave the status as it is (home-base-b4t8w). */
  keepStatus?: boolean;
  sessionId: string;
  /** The bead's status as last read. */
  status: string;
  /** The write; tests make one bead's write fail. */
  update?: typeof brUpdate;
}):
  | {adoptedStatus: AdoptedStatus; kind: 'adopted'}
  | {kind: 'failed'; reason: string} {
  const {db, env, id, status} = input;
  const update = input.update ?? brUpdate;
  const labels = [REQUEST_LABEL, sidLabel(input.sessionId)];
  const labelOnly = (): ReturnType<typeof brUpdate> =>
    update({db, env}, id, {addLabels: labels});
  let adopted: ReturnType<typeof brUpdate>;
  let adoptedStatus: AdoptedStatus;
  if (status === 'in_progress') {
    adopted = labelOnly();
    adoptedStatus = {kind: 'already'};
  } else if (input.keepStatus === true) {
    adopted = labelOnly();
    adoptedStatus = {kind: 'kept', status};
  } else {
    adopted = update({db, env}, id, {
      addLabels: labels,
      status: 'in_progress',
    });
    adoptedStatus = {from: status, kind: 'set'};
    const blockers =
      adopted.kind === 'failed'
        ? claimRefusalBlockers(describeBrFailed(adopted))
        : null;
    if (blockers != null) {
      adopted = labelOnly();
      adoptedStatus = {blockers, kind: 'left', status};
    }
  }
  if (adopted.kind === 'failed') {
    return {
      kind: 'failed',
      reason: `br update failed, ${id} was NOT adopted: ${describeBrFailed(adopted)}`,
    };
  }
  return {adoptedStatus, kind: 'adopted'};
}
