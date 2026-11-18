#!/usr/bin/env bun
/**
 * home-base-kwand.4 (G12): how real sessions' transcripts end, as COUNTS and
 * 8-character session id prefixes only (no titles, paths or transcript text).
 *
 *   bun scripts/measure-transcript-endings.ts [--days 5] [--check <prefix>…] [--time <runs>]
 *
 * 1. Every main transcript under ~/.claude/projects changed in the last
 *    `--days`, through the classifier alone (readTranscriptEnding).
 * 2. `thread inbox --json --all`: the sessions whose last activity is inside
 *    the window, by the ending the inbox shows (with liveness, D5).
 * 3. `--check`: each given prefix's ending, in both.
 * 4. `--time N`: the wall time of N `thread inbox --json --all` runs.
 *
 * Read-only. Sandbox off: it reads ~/.claude/projects, and the inbox reads
 * ps and the cmux socket.
 */

import {spawnSync} from 'child_process';
import {readdirSync, statSync} from 'fs';
import {homedir} from 'os';
import {basename, join} from 'path';

import {readTranscriptEnding} from '../src/thread/transcript-ending';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(
    'measure-transcript-endings [--days 5] [--check <8-char prefix>…] [--time <runs>]: counts of how session transcripts end (home-base-kwand.4). Read-only; prints counts and id prefixes only.',
  );
  process.exit(0);
}
function option(name: string): string | null {
  const index = args.indexOf(name);
  return index === -1 ? null : (args[index + 1] ?? null);
}
const days = Number(option('--days') ?? '5');
const checks: string[] = [];
for (const [index, arg] of args.entries()) {
  if (arg === '--check' && args[index + 1] != null)
    checks.push(args[index + 1] ?? '');
}
const timeRuns = Number(option('--time') ?? '0');
const since = Date.now() - days * 86_400_000;
const sdkRoot = join(import.meta.dir, '..');

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}
function show(title: string, map: Map<string, number>): void {
  console.log(title);
  for (const [key, count] of [...map].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${count}  ${key}`);
  }
}
/** A reason with paths and ids taken out, so it can be counted and printed. */
function reasonShape(reason: string): string {
  return reason
    .replace(/\/[^\s:;,)]+/g, '<path>')
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<id>');
}

// 1. Every main transcript changed in the window.
const root = join(homedir(), '.claude', 'projects');
const files = new Map<string, string>();
for (const dir of readdirSync(root)) {
  let names: string[];
  try {
    names = readdirSync(join(root, dir));
  } catch {
    continue;
  }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const path = join(root, dir, name);
    try {
      if (statSync(path).mtimeMs >= since)
        files.set(basename(name, '.jsonl'), path);
    } catch {
      // Gone since the listing.
    }
  }
}
const raw = new Map<string, number>();
const rawReasons = new Map<string, number>();
const rawById = new Map<string, string>();
const repliedExamples: string[] = [];
for (const [id, path] of files) {
  const ending = readTranscriptEnding(path);
  const key =
    ending.kind === 'cutOff' ? `cutOff (${ending.inFlight})` : ending.kind;
  bump(raw, key);
  rawById.set(id, key);
  if (ending.kind === 'unknown') bump(rawReasons, reasonShape(ending.reason));
  if (ending.kind === 'replied' && repliedExamples.length < 3)
    repliedExamples.push(id.slice(0, 8));
}
console.log(
  `1. Main transcripts changed in the last ${days} days: ${files.size} (${new Date().toLocaleString()})`,
);
show('   by ending:', raw);
if (rawReasons.size > 0) show('   unknown, by reason:', rawReasons);
console.log(`   three that replied: ${repliedExamples.join(', ')}`);

// 2. The inbox.
const started = performance.now();
const run = spawnSync(
  'bun',
  ['run', 'justin-sdk', 'thread', 'inbox', '--json', '--all'],
  {
    cwd: sdkRoot,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  },
);
const firstMs = performance.now() - started;
if (run.status !== 0) {
  console.log(
    `2. thread inbox failed (exit ${run.status}): ${run.stderr.slice(0, 400)}`,
  );
  process.exit(1);
}
const inbox = JSON.parse(run.stdout) as {
  sessions: {
    ending?: {
      inFlight?: string;
      kind: string;
      live?: boolean | null;
      reason?: string;
    } | null;
    lastActivityAt: string | null;
    sessionId: string;
  }[];
};
const shown = new Map<string, number>();
const shownReasons = new Map<string, number>();
const shownById = new Map<string, string>();
let inWindow = 0;
for (const session of inbox.sessions) {
  const ending = session.ending;
  const key =
    ending == null
      ? 'absent'
      : ending.kind === 'cutOff'
        ? `cutOff (${ending.inFlight}; live ${String(ending.live)})`
        : ending.kind === 'workingNow'
          ? `workingNow (${ending.inFlight})`
          : ending.kind;
  shownById.set(session.sessionId, key);
  const ms =
    session.lastActivityAt == null ? NaN : Date.parse(session.lastActivityAt);
  if (Number.isNaN(ms) || ms < since) continue;
  inWindow += 1;
  bump(shown, key);
  if (ending?.kind === 'unknown' && ending.reason != null)
    bump(shownReasons, reasonShape(ending.reason));
}
console.log(
  `2. thread inbox --json --all: ${inbox.sessions.length} sessions, ${inWindow} active in the last ${days} days (${(firstMs / 1000).toFixed(2)} s)`,
);
show('   by ending:', shown);
if (shownReasons.size > 0) show('   unknown, by reason:', shownReasons);

// 3. Named sessions.
for (const prefix of checks) {
  const find = (map: Map<string, string>): string => {
    const found = [...map]
      .filter(([id]) => id.startsWith(prefix))
      .map(([, key]) => key);
    return found.length === 0 ? 'not found' : found.join(' | ');
  };
  console.log(
    `3. ${prefix}: classifier ${find(rawById)}; inbox ${find(shownById)}`,
  );
}

// 4. Timing.
for (let index = 0; index < timeRuns; index += 1) {
  const start = performance.now();
  const timed = spawnSync(
    'bun',
    ['run', 'justin-sdk', 'thread', 'inbox', '--json', '--all'],
    {
      cwd: sdkRoot,
      encoding: 'utf8',
      maxBuffer: 512 * 1024 * 1024,
    },
  );
  console.log(
    `4. run ${index + 1}: ${((performance.now() - start) / 1000).toFixed(2)} s (exit ${timed.status})`,
  );
}
