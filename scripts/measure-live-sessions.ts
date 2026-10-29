#!/usr/bin/env bun
/**
 * How many Claude Code sessions does the handoff gate's live count see on this
 * machine right now, and from which sources? (home-base-mbnjv.1 item 4: the
 * default of componentConfig.thread.handoff.maxLiveSessions is set from this
 * measurement, and so is the decision whether sessions seen only in
 * `claude agents --json`, the background ones, count.)
 *
 * READ ONLY: ps, the cmux tree and read-screen, the cmux hook store and
 * `claude agents --json`. Writes nothing, spends no tokens. cmux and ps need
 * the Claude Code sandbox OFF.
 *
 *   bun run measure:live-sessions [--json]
 */

import {countLiveSessions} from '../src/thread/live-count';
import {
  backgroundRole,
  readLiveSessions,
  realAgentsRunner,
  realLiveSessionDeps,
} from '../src/thread/live-sessions';
import {readProcesses, realProcessRunner} from '../src/thread/pane-join';

const HELP = `measure-live-sessions — what the handoff gate's live-session count sees right now

  bun run measure:live-sessions [--json]

Reads ps, the cmux tree and screens, the cmux hook store and
\`claude agents --json\`. Writes nothing and spends no tokens. Run it with the
Claude Code sandbox off: cmux's socket and ps are refused inside it.`;

/** A registry field as a short word: strings as they are, else JSON, else "none". */
function text(value: unknown): string {
  if (value == null) return 'none';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function tally(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return 0;
  }
  const json = args.includes('--json');
  const env = process.env;

  const started = Date.now();
  const live = await readLiveSessions(realLiveSessionDeps(env));
  const elapsedMs = Date.now() - started;
  if (live.kind === 'failed') {
    console.error(`readLiveSessions failed: ${live.reason}`);
    return 1;
  }
  const procs = await readProcesses(realProcessRunner());
  if (!procs.ok) {
    console.error(`ps failed: ${procs.reason}`);
    return 1;
  }
  const byPid = new Map(procs.value.map((proc) => [proc.pid, proc]));
  const agentsCall = await realAgentsRunner(env)();
  const agentsRaw: Record<string, unknown>[] =
    agentsCall.kind === 'ok'
      ? (JSON.parse(agentsCall.stdout) as Record<string, unknown>[])
      : [];

  const rows = [...live.bySessionId.entries()].map(([sessionId, entry]) => {
    const proc = entry.pid == null ? undefined : byPid.get(entry.pid);
    const role = proc == null ? null : backgroundRole(proc);
    return {
      background: role != null,
      pid: entry.pid,
      sessionId,
      source: entry.source,
      surfaceId: entry.surfaceId,
    };
  });
  const pids = rows
    .map((row) => row.pid)
    .filter((pid): pid is number => pid != null);
  const report = {
    agentsRegistry: {
      byKind: tally(agentsRaw.map((entry) => text(entry.kind))),
      // Whether a claude process holds the entry's pid right now: the join
      // counts an entry only then.
      byKindAndPidLive: tally(
        agentsRaw.map((entry) => {
          const proc =
            typeof entry.pid === 'number' ? byPid.get(entry.pid) : undefined;
          const held = proc?.name === 'claude' ? 'pidLive' : 'pidGone';
          return `${text(entry.kind)}/${held}`;
        }),
      ),
      // Background rows carry `state` (blocked, working, done), interactive
      // ones `status` (idle, busy), as measured 2026-10-29.
      byKindAndState: tally(
        agentsRaw.map(
          (entry) => `${text(entry.kind)}/${text(entry.state ?? entry.status)}`,
        ),
      ),
      entries: agentsRaw.length,
      fields: [...new Set(agentsRaw.flatMap((entry) => Object.keys(entry)))],
    },
    count: countLiveSessions(live),
    elapsedMs,
    rows: {
      background: rows.filter((row) => row.background).length,
      bySource: tally(rows.map((row) => row.source)),
      distinctPids: new Set(pids).size,
      inACmuxSurface: rows.filter((row) => row.surfaceId != null).length,
      noPid: rows.filter((row) => row.pid == null).length,
      sessionIds: rows.length,
    },
    unplaced: {
      byKind: tally(live.unplaced.map((entry) => entry.kind)),
      total: live.unplaced.length,
    },
  };
  console.log(json ? JSON.stringify(report) : JSON.stringify(report, null, 2));
  return 0;
}

process.exit(await main());
