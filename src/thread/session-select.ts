/**
 * Which session a v4 thread command acts on, and the beads that belong to it
 * (status report v4, epic home-base-vzwbj.4 D1; home-base-vzwbj.4.2).
 *
 * Claude's commands (`thread request`, `thread ask`, `thread answers`) run
 * inside the session, so CLAUDE_CODE_SESSION_ID names it. Justin's commands
 * (`thread answer`, `note`, `done`, `archive`) may run from any terminal, so
 * they also take a SELECTOR: the session bead's id or the Claude session id,
 * looked up in the sessions index (never guessed from the cwd).
 *
 * `sessionIdFrom` and `sessionBeadsKnob` were private to request.ts
 * (home-base-vzwbj.4.1) and moved here unchanged so every command shares them.
 */

import type {BrIssue} from '../beads/br';
import type {EnvLike} from './paths';
import type {SessionResolution} from './session-bead';

import {brList, describeBrFailed, findBeadsDb} from '../beads/br';
import {isSafeSessionId} from './message-log';
import {resolveSession, sidLabel} from './session-bead';
import {readSessionIndex} from './session-index';

export type FoundSession = Extract<SessionResolution, {kind: 'found'}>;

export function sessionIdFrom(
  explicit: string | null,
  env: EnvLike,
): {id: string; ok: true} | {ok: false; reason: string} {
  const id =
    explicit != null && explicit !== ''
      ? explicit
      : (env.CLAUDE_CODE_SESSION_ID ?? '');
  if (id === '') {
    return {
      ok: false,
      reason:
        'no session id: CLAUDE_CODE_SESSION_ID is not set and --session was not passed',
    };
  }
  if (!isSafeSessionId(id)) {
    return {
      ok: false,
      reason: `session id ${JSON.stringify(id)} is not a valid id`,
    };
  }
  return {id, ok: true};
}

export async function sessionBeadsKnob(
  cwd: string,
  env: EnvLike,
): Promise<{ok: false; reason: string} | {ok: true}> {
  // Behind an await import: config pulls in zod, and nothing heavy loads at
  // the top of a thread module (command.ts's header).
  const {resolveThreadConfig} = await import('./config');
  const config = resolveThreadConfig({cwd, env});
  if (config.sessionBeads) return {ok: true};
  return {
    ok: false,
    reason: `SESSION BEADS: DISABLED — componentConfig.thread.sessionBeads is not true (resolved from: ${config.sessionBeadsSource}), so no session bead exists to file under.`,
  };
}

export type SessionSelection =
  | {checkoutPath: string; kind: 'checkoutMissing'}
  | {kind: 'failed'; reason: string}
  | {kind: 'found'; session: FoundSession}
  | {kind: 'noSession'; reason: string};

function fromResolution(resolution: SessionResolution): SessionSelection {
  switch (resolution.kind) {
    case 'found':
      return {kind: 'found', session: resolution};
    case 'checkoutMissing':
      return {checkoutPath: resolution.checkoutPath, kind: 'checkoutMissing'};
    case 'failed':
      return {kind: 'failed', reason: resolution.reason};
    case 'none':
      return {kind: 'noSession', reason: resolution.reason};
  }
}

/**
 * The Claude session id a SELECTOR names — a session bead id or a Claude
 * session id — through the sessions index alone (no br call). Split out of
 * `selectSession` by home-base-vzwbj.4.3 so `thread show` / `thread status`
 * can resolve a session without the `br show` that `resolveSession` costs.
 */
export function sessionIdForSelector(
  selector: string,
  env: EnvLike,
):
  | {kind: 'failed'; reason: string}
  | {kind: 'found'; sessionId: string}
  | {kind: 'unknown'; reason: string} {
  const index = readSessionIndex(env);
  if (index.kind === 'failed') {
    return {
      kind: 'failed',
      reason: `the sessions index is unreadable: ${index.path}: ${index.error}`,
    };
  }
  const sessions = index.kind === 'read' ? index.sessions : [];
  const byBead = sessions.find((entry) =>
    entry.sightings.some(
      (sighting) =>
        sighting.event === 'created' && sighting.beadId === selector,
    ),
  );
  const bySession = sessions.find((entry) => entry.sessionId === selector);
  const sessionId = byBead?.sessionId ?? bySession?.sessionId ?? null;
  if (sessionId == null) {
    return {
      kind: 'unknown',
      reason: `${selector} is neither a session bead nor a session id that the sessions index (${index.path}) knows`,
    };
  }
  return {kind: 'found', sessionId};
}

/**
 * The session a command acts on. `selector` (a session bead id or a Claude
 * session id) wins; otherwise `--session`, else CLAUDE_CODE_SESSION_ID.
 */
export function selectSession(input: {
  env: EnvLike;
  selector: string | null;
  sessionIdOption: string | null;
}): SessionSelection {
  const {env} = input;
  const selector = input.selector?.trim() ?? '';
  if (selector === '') {
    const session = sessionIdFrom(input.sessionIdOption, env);
    if (!session.ok) return {kind: 'noSession', reason: session.reason};
    return fromResolution(resolveSession({env, sessionId: session.id}));
  }
  const looked = sessionIdForSelector(selector, env);
  if (looked.kind === 'failed') return {kind: 'failed', reason: looked.reason};
  if (looked.kind === 'unknown') {
    return {kind: 'noSession', reason: looked.reason};
  }
  return fromResolution(resolveSession({env, sessionId: looked.sessionId}));
}

/** A bead and the beads DB it was read from. */
export interface LocatedIssue {
  db: string;
  issue: BrIssue;
}

/**
 * Every bead of this session carrying `label` (plus `sid:<id>`), read from
 * EVERY beads DB the index names for the session (D1: reads union them), the
 * session's own DB first. A DB that cannot be read is a PROBLEM, named — never
 * an empty contribution (rule 7).
 */
export function sessionBeadsLabelled(
  session: FoundSession,
  filters: {all: boolean; label: string; types?: string[]},
  env?: EnvLike,
): {issues: LocatedIssue[]; problems: string[]} {
  const dbs: string[] = [session.db];
  const problems: string[] = [];
  for (const sighting of session.sightings) {
    const found = findBeadsDb(sighting.beadsDir);
    if (found.kind !== 'found') {
      problems.push(`could not read ${sighting.beadsDir}: ${found.reason}`);
      continue;
    }
    if (!dbs.includes(found.db)) dbs.push(found.db);
  }
  const issues: LocatedIssue[] = [];
  const seen = new Set<string>();
  for (const db of dbs) {
    const listed = brList(
      {db, env},
      {
        all: filters.all,
        labels: [filters.label, sidLabel(session.sessionId)],
        ...(filters.types != null ? {types: filters.types} : {}),
      },
    );
    if (listed.kind === 'failed') {
      problems.push(`could not read ${db}: ${describeBrFailed(listed)}`);
      continue;
    }
    for (const issue of listed.issues) {
      if (seen.has(`${db}\u0000${issue.id}`)) continue;
      seen.add(`${db}\u0000${issue.id}`);
      issues.push({db, issue});
    }
  }
  return {issues, problems: [...new Set(problems)]};
}
