/**
 * One automatic handoff pickup attempt, for the capture child (home-base-npbse.1.2
 * P3; handoff-auto-pickup.ts holds the marks and the wording).
 *
 * The child runs this under the per-session lock at every prompt and turn end
 * until the pickup holds. An unmarked session returns null here having read only
 * its own message log, so it does no br read. A session whose pickup holds does
 * one read of its own labels and no write.
 *
 * capture.ts imports this file only with the knob on, because merging this reaches
 * every open session's capture code on its next prompt (pkg/justin-sdk/CLAUDE.md).
 */

import type {
  AutoPickupInput,
  CapturePickupOutcome,
} from './handoff-auto-pickup';
import type {PickUpOutcome, PickUpStep} from './handoff-pickup';

import {
  clearPickupFailure,
  firstUserTextOf,
  successorMark,
  writePickupFailure,
} from './handoff-auto-pickup';
import {pickUpHandoff} from './handoff-pickup';
import {
  AUTO_TITLE_LABEL,
  NOT_A_SUCCESSOR_LABEL,
  PICKED_UP_LABEL,
} from './session-bead';
import {selectSession} from './session-select';

export interface AutoPickupDeps {
  pickUp: typeof pickUpHandoff;
}

/** One attempt. Null when the session carries no mark. */
export async function runAutoPickup(
  input: AutoPickupInput,
  deps: Partial<AutoPickupDeps> = {},
): Promise<CapturePickupOutcome | null> {
  const {cwd, env, now, sessionId} = input;
  const mark = successorMark({
    env,
    firstUserText: firstUserTextOf(sessionId, env),
  });
  if (mark == null) return null;
  const {predecessorBeadId} = mark;

  const failedWith = (
    step: PickUpStep | 'threw',
    reason: string,
  ): CapturePickupOutcome => {
    writePickupFailure(
      sessionId,
      {at: now.toISOString(), predecessorBeadId, reason, step},
      env,
    );
    return {kind: 'failed', reason, step};
  };

  try {
    const selection = selectSession({
      env,
      selector: null,
      sessionIdOption: sessionId,
    });
    if (selection.kind !== 'found') {
      return failedWith(
        'read-successor',
        selection.kind === 'checkoutMissing'
          ? `this session's beads live in ${selection.checkoutPath}, which no longer exists`
          : selection.reason,
      );
    }
    const {session} = selection;
    const {labels} = session.bead;
    if (labels.includes(NOT_A_SUCCESSOR_LABEL)) {
      clearPickupFailure(sessionId, env);
      return {kind: 'held', label: NOT_A_SUCCESSOR_LABEL};
    }
    // A failed title sets `picked-up` and returns failed at step `title`, so the
    // title is retried until `auto-title` is gone (review of npbse.1.1).
    if (
      labels.includes(PICKED_UP_LABEL) &&
      !labels.includes(AUTO_TITLE_LABEL)
    ) {
      clearPickupFailure(sessionId, env);
      return {kind: 'held', label: PICKED_UP_LABEL};
    }
    const outcome: PickUpOutcome = await (deps.pickUp ?? pickUpHandoff)(
      {
        cwd,
        env,
        now,
        predecessorBeadId,
        successor: {beadId: session.bead.id, db: session.db, sessionId},
      },
      // The capture child syncs the names itself right after this.
      {syncNames: () => Promise.resolve(null)},
    );
    switch (outcome.kind) {
      case 'picked-up':
        clearPickupFailure(sessionId, env);
        return {
          carriedQuestions:
            outcome.carried.questions.length +
            outcome.alreadyHeld.questions.length,
          carriedRequests:
            outcome.carried.requests.length +
            outcome.alreadyHeld.requests.length,
          kind: 'picked-up',
          predecessorBeadId,
          wrote: outcome.wrote,
        };
      case 'not-a-successor':
        clearPickupFailure(sessionId, env);
        return {
          kind: 'not-a-successor',
          predecessorBeadId,
          reason: outcome.reason,
        };
      case 'failed':
        // `picked-up` holds and only the title failed: nothing to nag about, and
        // the next pass retries the title. capture.jsonl still records it.
        if (outcome.done.pickedUpLabelled) {
          clearPickupFailure(sessionId, env);
          return {kind: 'failed', reason: outcome.reason, step: outcome.step};
        }
        return failedWith(outcome.step, outcome.reason);
    }
  } catch (error) {
    return failedWith('threw', String(error));
  }
}
