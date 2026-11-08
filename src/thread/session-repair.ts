/**
 * Repair a session whose session bead the capture hook failed to file
 * (home-base-4ay2j; home-base-irstv is its second case and closes with it).
 *
 * THE PROBLEM. The capture hook files a session's bead in a detached child
 * after the first prompt. When several sessions start at once that child can
 * fail: `database is busy` before the bead is filed (4ay2j, 2026-11-06), or a
 * `br create` that timed out after the bead WAS created but before the sessions
 * index line was written (irstv, 2026-10-24). Nothing retries until the next
 * prompt, and a session working on its own has no next prompt, so every
 * `thread` command refused for minutes.
 *
 * THE REPAIR is the capture child's own session-bead step (`ensureSessionBead`,
 * which asks the index, then the cwd's beads DB, and creates only on a measured
 * absence), run once, in-process, under the capture child's per-session lock
 * (D3). Only that step: the rest of `thread capture --apply` writes the
 * ~/Dev/threads store, names cmux workspaces and commits, and the next capture
 * does all of that once the bead is indexed.
 *
 * D1: it runs only when the index names no session bead AND the race window is
 * closed (the first prompt is older than SESSION_BEAD_RACE_WINDOW_MS).
 * D2: ONLY the entry points of `thread request`, `thread ask`, `thread stage`
 * and `thread status` call `repairMissingSessionBead`. Never `resolveSession`,
 * and nothing a hook runs: a change merged to main runs in every open home-base
 * session on its next tool call, and this must reach only a session that is
 * already broken. Each caller checks componentConfig.thread.sessionBeads
 * before calling.
 * D3: a lock another process holds is `deferred`, and nothing is written.
 * D4: a refusal names `repairCommand`, with this session's id and cwd filled in.
 * D5: a session with no message log (only `!` commands) gets no attempt.
 *
 * Only the session's OWN id is repaired (CLAUDE_CODE_SESSION_ID): the cwd is
 * where the bead is filed, and a `--session <other>` run's cwd is not that
 * session's.
 */

import type {EnvLike} from './paths';
import type {SessionBeadOutcome} from './session-bead';

import {sdkRun} from '../sdk-invocation';
import {readMessageLog} from './message-log';
import {probeErrorMessage} from './paths';
import {ensureSessionBead} from './session-bead';
import {readSessionSightings, sessionBeadSighting} from './session-index';

/**
 * F13 (home-base-vzwbj.4.9): P7's wait is for ONE race — the capture child
 * filing the session bead ~0.5 s after the first prompt. Only a first prompt
 * logged this recently can still be in that race. Moved here from request.ts
 * (home-base-4ay2j) so the repair and the request share one window.
 */
export const SESSION_BEAD_RACE_WINDOW_MS = 30_000;

/**
 * Whether a missing session bead may still be on its way: the session's first
 * user line in the message log is younger than SESSION_BEAD_RACE_WINDOW_MS.
 * Anything else — no log (capture never ran: the knob was off, say), an
 * unreadable log, an old first prompt — refuses at once, and says why.
 * `noLog` marks the case where no prompt was ever captured, which is also
 * what a session sees when it has only been sent `!` commands (they do not
 * run the capture hook; measured 2026-10-26, home-base-nro7d.1).
 */
export function raceStillOpen(
  sessionId: string,
  env: EnvLike,
  now: Date,
): {noLog: boolean; open: false; why: string} | {open: true} {
  const log = readMessageLog(sessionId, env);
  if (log.kind === 'missing') {
    return {
      noLog: true,
      open: false,
      why: 'this session has no message log, so the capture hook has not run for it',
    };
  }
  if (log.kind === 'failed') {
    return {
      noLog: false,
      open: false,
      why: `its message log could not be read (${log.error})`,
    };
  }
  const first = log.lines.find((line) => line.role === 'user');
  const at = first?.at == null ? Number.NaN : Date.parse(first.at);
  if (Number.isNaN(at)) {
    return {
      noLog: false,
      open: false,
      why: 'its message log has no dated first prompt',
    };
  }
  const age = now.getTime() - at;
  if (age >= 0 && age < SESSION_BEAD_RACE_WINDOW_MS) return {open: true};
  return {
    noLog: false,
    open: false,
    why: `the first prompt was logged ${Math.round(age / 1000)} s ago, so the capture hook has had its chance`,
  };
}

/** The four commands that may repair (D2), named in the line they print. */
export type RepairingCommand =
  | 'thread ask'
  | 'thread request'
  | 'thread stage'
  | 'thread status';

export type SessionBeadRepair =
  /** The index already names a session bead: nothing was missing. */
  | {kind: 'notMissing'}
  /**
   * No attempt. `raceOpen` (D1): the capture child may still be filing it.
   * `noLog` (D5): nothing was ever captured. `notOwnSession`: the command ran
   * for another session's id.
   */
  | {
      /** The repair command for a refusal, or null where it would not help. */
      command: string | null;
      kind: 'notAttempted';
      reason: 'noLog' | 'notOwnSession' | 'raceOpen';
      why: string;
    }
  /** Filed, or found in the DB and indexed: the index names it now. */
  | {
      beadId: string;
      detail: string;
      how: 'filed' | 'indexed';
      kind: 'repaired';
      /** The one loud line the command prints. */
      line: string;
    }
  /** D3: another process holds this session's capture lock; nothing written. */
  | {command: string; kind: 'deferred'; why: string}
  /** Tried, and the index still names no session bead (rule 7: said, by name). */
  | {command: string; kind: 'failed'; why: string};

/** A path as one shell word: bare when it is plain, single-quoted otherwise. */
function shellWord(value: string): string {
  return /^[\w./@%+=:,-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** D4: the hand-run repair, with this session's id and cwd filled in. */
export function repairCommand(sessionId: string, cwd: string): string {
  return sdkRun(`thread capture --apply ${sessionId} --cwd ${shellWord(cwd)}`);
}

/**
 * The sentence a refusal adds for a repair that did not leave the session
 * with a bead, or null when it adds nothing (D5's no-log refusal stays as it
 * is: running the repair cannot help a session nothing was captured for).
 */
export function repairRefusalNote(repair: SessionBeadRepair): string | null {
  switch (repair.kind) {
    case 'deferred':
      return `This command tried to file it and was deferred: ${repair.why}. Run this command again in a moment, or run the repair yourself: ${repair.command}`;
    case 'failed':
      return `This command tried to file it and could not: ${repair.why}. Once that is fixed, run the repair yourself: ${repair.command}`;
    case 'notAttempted':
      return repair.command == null
        ? null
        : `If it still refuses after that, run the repair yourself: ${repair.command}`;
    case 'notMissing':
    case 'repaired':
      return null;
  }
}

function repairedLine(
  by: RepairingCommand,
  outcome: Extract<SessionBeadOutcome, {kind: 'created' | 'exists'}>,
): string {
  return outcome.kind === 'created'
    ? `⚠️ ${by}: the capture hook had not filed this session's bead, so this command filed it: ${outcome.beadId} (${outcome.detail}).`
    : `⚠️ ${by}: the sessions index named no bead for this session, so this command found it and indexed it: ${outcome.beadId} (${outcome.detail}).`;
}

/**
 * File or re-index this session's bead when the capture hook failed to (D1–D5
 * above). Prints nothing; the caller prints `line` on `repaired`, and names a
 * `deferred` or `failed` repair in its refusal (`repairRefusalNote`).
 *
 * Call it only from the four command entry points (D2), after the caller has
 * checked componentConfig.thread.sessionBeads.
 */
export async function repairMissingSessionBead(input: {
  by: RepairingCommand;
  cwd: string;
  env: EnvLike;
  now: Date;
  sessionId: string;
}): Promise<SessionBeadRepair> {
  const {by, cwd, env, now, sessionId} = input;
  const command = repairCommand(sessionId, cwd);

  // The index is the precondition and the proof: every caller's own lookup
  // reads it first. Unreadable is "could not tell", never "missing".
  const before = readSessionSightings(sessionId, env);
  if (before.kind === 'failed') {
    return {
      command,
      kind: 'failed',
      why: `the sessions index is unreadable (${before.path}: ${before.error}), so whether this session has a bead could not be told`,
    };
  }
  if (before.kind === 'read' && sessionBeadSighting(before.sightings) != null) {
    return {kind: 'notMissing'};
  }
  if (env.CLAUDE_CODE_SESSION_ID !== sessionId) {
    return {
      command: null,
      kind: 'notAttempted',
      reason: 'notOwnSession',
      why: `${sessionId} is not this session (CLAUDE_CODE_SESSION_ID), so its bead is not filed from here`,
    };
  }
  const race = raceStillOpen(sessionId, env, now);
  if (race.open) {
    return {
      command,
      kind: 'notAttempted',
      reason: 'raceOpen',
      why: `the first prompt was logged under ${SESSION_BEAD_RACE_WINDOW_MS / 1000} s ago, so the capture hook may still be filing it`,
    };
  }
  if (race.noLog) {
    return {
      command: null,
      kind: 'notAttempted',
      reason: 'noLog',
      why: race.why,
    };
  }

  // capture.ts is heavy and this path is rare: imported only here.
  const {releaseCaptureLock, summarizeLog, tryCaptureLock} = await import(
    './capture'
  );
  if (!tryCaptureLock(sessionId, env)) {
    return {
      command,
      kind: 'deferred',
      why: "another process (most likely the capture hook's child) holds this session's capture lock, so nothing was written",
    };
  }
  let outcome: SessionBeadOutcome;
  try {
    const log = readMessageLog(sessionId, env);
    const firstUser =
      log.kind === 'read' ? summarizeLog(log.lines).firstUser : null;
    outcome = ensureSessionBead({
      cwd,
      env,
      firstPrompt:
        firstUser != null ? {at: firstUser.at, text: firstUser.text} : null,
      now,
      sessionId,
    });
  } catch (error) {
    outcome = {detail: `threw: ${probeErrorMessage(error)}`, kind: 'failed'};
  } finally {
    releaseCaptureLock(sessionId, env);
  }
  if (outcome.kind === 'failed') {
    return {command, kind: 'failed', why: outcome.detail};
  }
  if (outcome.kind === 'noWorkspace') {
    return {
      command,
      kind: 'failed',
      why: `${cwd} has no beads workspace to file it in (${outcome.detail})`,
    };
  }
  const after = readSessionSightings(sessionId, env);
  const indexed =
    after.kind === 'read' ? sessionBeadSighting(after.sightings) : null;
  if (indexed == null) {
    return {
      command,
      kind: 'failed',
      why: `${outcome.beadId} was ${outcome.kind === 'created' ? 'filed' : 'found'}, but the sessions index still names no session bead (${outcome.detail})`,
    };
  }
  return {
    beadId: outcome.beadId,
    detail: outcome.detail,
    how: outcome.kind === 'created' ? 'filed' : 'indexed',
    kind: 'repaired',
    line: repairedLine(by, outcome),
  };
}
