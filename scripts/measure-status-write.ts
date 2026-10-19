#!/usr/bin/env bun
/**
 * What does the status-line file write cost the capture child?
 * (home-base-yukaf.14 F10: `writeStatusForSession` runs loadSession — git
 * calls, the beads export, the transcript — once per capture in the detached
 * child; "if over 2 s, cache by transcript mtime".)
 *
 * It times the part the write adds, `loadSession` + `statusFromModel`, for
 * the newest sessions in this machine's real sessions index, the way the
 * child calls it (selector null, the session id named, cwd = the session's
 * checkout). READ ONLY: loadSession only reads (index, message log,
 * transcript, beads exports, git), and statusFromModel is pure; nothing is
 * written, so the status files and beads are untouched. Spends no tokens.
 *
 *   bun run measure:status-write [--sessions 8] [--runs 5] [--json]
 */

import {parseArgs} from 'node:util';

import {readSessionIndex} from '../src/thread/session-index';
import {loadSession} from '../src/thread/session-model';
import {statusFromModel} from '../src/thread/session-status-file';

const HELP = `measure-status-write — what the status-line file write costs the capture child

Usage: bun run measure:status-write [--sessions N] [--runs N] [--json]

  --sessions N  the N newest sessions in the sessions index (default 8)
  --runs N      timed runs per session after one warm-up (default 5)
  --json        print the numbers as JSON

Read only: loadSession + statusFromModel, the work writeStatusForSession adds
to each capture; no file is written. Run with the Claude Code sandbox off (git
and the state dir).`;

interface Row {
  checkout: string;
  /** The first call: in the first session, it carries the cold module loads. */
  firstMs: number;
  kind: string;
  maxMs: number;
  p50Ms: number;
  sessionId: string;
}

function percentile(values: readonly number[], share: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(share * sorted.length));
  return sorted[index] ?? Number.NaN;
}

async function main(): Promise<number> {
  const {values} = parseArgs({
    options: {
      help: {short: 'h', type: 'boolean'},
      json: {type: 'boolean'},
      runs: {type: 'string'},
      sessions: {type: 'string'},
    },
  });
  if (values.help === true) {
    console.log(HELP);
    return 0;
  }
  const sessions = Number(values.sessions ?? '8');
  const runs = Number(values.runs ?? '5');
  if (
    !Number.isInteger(sessions) ||
    sessions < 1 ||
    !Number.isInteger(runs) ||
    runs < 1
  ) {
    console.error(
      'measure-status-write: --sessions and --runs take a whole number of at least 1',
    );
    return 2;
  }
  const env = process.env;
  const index = readSessionIndex(env);
  if (index.kind !== 'read') {
    console.error(
      `measure-status-write: the sessions index is ${index.kind === 'missing' ? 'missing' : `unreadable (${index.error})`}: ${index.path}`,
    );
    return 1;
  }
  const rows: Row[] = [];
  for (const entry of index.sessions.slice(0, sessions)) {
    const checkout = entry.sightings[0]?.checkoutPath ?? process.cwd();
    const once = async (): Promise<{kind: string; ms: number}> => {
      const started = performance.now();
      const loaded = await loadSession({
        cwd: checkout,
        env,
        selector: null,
        sessionIdOption: entry.sessionId,
      });
      if (loaded.kind === 'loaded') statusFromModel(loaded.model, new Date());
      return {kind: loaded.kind, ms: performance.now() - started};
    };
    const first = await once(); // warm-up: module and file caches
    const times: number[] = [];
    let kind = '';
    for (let run = 0; run < runs; run += 1) {
      const result = await once();
      kind = result.kind;
      times.push(result.ms);
    }
    rows.push({
      checkout,
      firstMs: first.ms,
      kind,
      maxMs: Math.max(...times),
      p50Ms: percentile(times, 0.5),
      sessionId: entry.sessionId,
    });
  }
  if (values.json === true) {
    console.log(JSON.stringify({rows, runs}, null, 2));
    return 0;
  }
  for (const row of rows) {
    console.log(
      `${row.sessionId}  ${row.kind}\n    first ${row.firstMs.toFixed(0)} ms   p50 ${row.p50Ms.toFixed(0)} ms   max ${row.maxMs.toFixed(0)} ms   ${row.checkout}\n`,
    );
  }
  const all = rows.map((row) => row.maxMs);
  console.log(
    `worst session max: ${Math.max(...all).toFixed(0)} ms over ${rows.length} sessions, ${runs} runs each`,
  );
  return 0;
}

process.exit(await main());
