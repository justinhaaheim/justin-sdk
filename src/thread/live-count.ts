/**
 * How many Claude Code sessions are live on this machine: the number the
 * handoff gate compares with componentConfig.thread.handoff.maxLiveSessions
 * (epic home-base-mbnjv D2, C1; built by home-base-mbnjv.1).
 *
 * Built on readLiveSessions() (live-sessions.ts), which joins ps, the cmux
 * hook store, each cmux pane's status-line session id and `claude agents
 * --json`. That module keys its answer by SESSION ID; this one counts SESSION
 * PROCESSES, because one process can show two ids (after a /clear the argv
 * names the old session and the screen the new one), and the cap is about
 * running processes, not ids:
 *
 *   - every distinct pid among the sessions found live, plus
 *   - every session found live with no pid (a status-line id on a tty two
 *     cmux surfaces report; which process it belongs to is unknown, so it is
 *     counted on its own, which can only over-count), plus
 *   - every unplaced claude session process (one no source could name a
 *     session for: it is still a live session).
 *
 * Over-counting only ever refuses a handoff sooner, which is the safe
 * direction for a cap.
 *
 * CRITICAL RULE 7: when readLiveSessions fails, the count is `failed`, never
 * 0. The gate refuses on it (liveSessionsUnknown).
 *
 * The measurement behind the default, and the decision about sessions only
 * the agents registry sees (background `claude --bg` sessions), are in
 * home-base-mbnjv.1's notes.
 */

import type {LiveSessions, LiveSource} from './live-sessions';

export interface LiveSessionCount {
  /** Sessions found live, by the first source that found each (per session id). */
  bySource: Record<LiveSource, number>;
  kind: 'counted';
  /** Session ids found live (what readLiveSessions keys by). */
  sessionIds: number;
  /** The number the cap compares: live session processes, see the header. */
  total: number;
  /** Unplaced claude session processes, by where they run. */
  unplaced: {background: number; pane: number; process: number};
}

export type LiveSessionCountRead =
  | LiveSessionCount
  | {kind: 'failed'; reason: string};

/** The count from one readLiveSessions() answer. Pure. */
export function countLiveSessions(live: LiveSessions): LiveSessionCountRead {
  if (live.kind === 'failed') return {kind: 'failed', reason: live.reason};
  const bySource: Record<LiveSource, number> = {
    agents: 0,
    hookStore: 0,
    ps: 0,
    screen: 0,
  };
  const pids = new Set<number>();
  let noPid = 0;
  for (const entry of live.bySessionId.values()) {
    bySource[entry.source] += 1;
    if (entry.pid == null) noPid += 1;
    else pids.add(entry.pid);
  }
  const unplaced = {background: 0, pane: 0, process: 0};
  for (const entry of live.unplaced) unplaced[entry.kind] += 1;
  return {
    bySource,
    kind: 'counted',
    sessionIds: live.bySessionId.size,
    total: pids.size + noPid + live.unplaced.length,
    unplaced,
  };
}

/** One line for a refusal or a report: the total and where it came from. */
export function describeLiveSessionCount(count: LiveSessionCount): string {
  const sources = (Object.keys(count.bySource) as LiveSource[])
    .filter((source) => count.bySource[source] > 0)
    .map((source) => `${source} ${count.bySource[source]}`);
  const unplaced =
    count.unplaced.background + count.unplaced.pane + count.unplaced.process;
  const parts = [
    `${count.sessionIds} session id${count.sessionIds === 1 ? '' : 's'} (${sources.length > 0 ? sources.join(', ') : 'none'})`,
    unplaced > 0 ? `${unplaced} unplaced` : null,
  ].filter((part): part is string => part != null);
  return `${count.total} live (${parts.join('; ')})`;
}
