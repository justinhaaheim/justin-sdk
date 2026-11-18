#!/usr/bin/env bun
/**
 * home-base-kwand.2 item 2 (epic home-base-kwand D2, OPEN until measured):
 * count each candidate rule for "its restore failed" on live data, for the
 * tabs that held a Claude session before the last restart.
 *
 * PRINTS COUNTS ONLY. Screens are read in memory to test patterns; no screen
 * text, title, path or session id is printed, stored or logged.
 *
 * Run with the Claude Code sandbox off, from inside cmux (the socket admits
 * only processes cmux started): `bun scripts/measure-restore-failed.ts`.
 */

import type {Proc} from '../src/thread/pane-join';

import {CMUX_TIMEOUT_MS, realCmuxRunner} from '../src/thread/cmux';
import {cmuxSupportDir} from '../src/thread/cmux-session-file';
import {
  idleShellScreen,
  isClaudeProc,
  isShellScaffolding,
  lookupPanes,
  normalizeTty,
  readLiveSurfaces,
  readProcesses,
  readScreen,
  realPaneSources,
  realProcessRunner,
  screenLines,
} from '../src/thread/pane-join';
import {threadsStateDir} from '../src/thread/paths';
import {tabRecordDir} from '../src/thread/tab-record';
import {
  beforeRestart,
  realBootClock,
  realCmuxClock,
} from '../src/thread/tab-record-command';

if (process.argv.includes('--help')) {
  process.stdout.write(
    'measure-restore-failed: counts each candidate "restore failed" rule on live data (counts only). Sandbox off, inside cmux.\n',
  );
  process.exit(0);
}

const env = process.env;
const started = Date.now();
const [boot, cmuxProcess] = await Promise.all([
  realBootClock(),
  realCmuxClock(),
]);
const before = beforeRestart({
  boot,
  cmuxProcess,
  now: Date.now(),
  storeDir: tabRecordDir(threadsStateDir(env)),
  supportDir: cmuxSupportDir(env),
});
if (!before.ok) {
  process.stdout.write(`before-restart failed: ${before.reason}\n`);
  process.exit(1);
}
const cmux = realCmuxRunner(CMUX_TIMEOUT_MS, env);
const [surfaces, procs, panes] = await Promise.all([
  readLiveSurfaces(cmux),
  readProcesses(realProcessRunner()),
  lookupPanes(realPaneSources(env)),
]);
if (!surfaces.ok || !procs.ok || !panes.ok) {
  process.stdout.write(
    `live read failed: tree ${surfaces.ok ? 'ok' : 'FAILED'}, ps ${procs.ok ? 'ok' : 'FAILED'}, panes ${panes.ok ? 'ok' : 'FAILED'}\n`,
  );
  process.exit(1);
}
const liveReadMs = Date.now() - started;

const surfaceById = new Map(
  surfaces.value.flatMap((s) => (s.id == null ? [] : [[s.id, s] as const])),
);
const procsByTty = new Map<string, Proc[]>();
for (const proc of procs.value) {
  const tty = normalizeTty(proc.tty);
  if (tty == null) continue;
  procsByTty.set(tty, [...(procsByTty.get(tty) ?? []), proc]);
}
const surfacesPerTty = new Map<string, number>();
for (const s of surfaces.value) {
  const tty = normalizeTty(s.tty);
  if (tty != null) surfacesPerTty.set(tty, (surfacesPerTty.get(tty) ?? 0) + 1);
}

const counts = new Map<string, number>();
const bump = (key: string): void => {
  counts.set(key, (counts.get(key) ?? 0) + 1);
};

const FAILURE_PATTERNS: Record<string, RegExp> = {
  'ERROR: overloaded': /ERROR:\s*overloaded/u,
  claudeResumeCmd: /claude\b.*--resume/u,
  overloaded: /overloaded/iu,
  'pool saturated': /pool saturated/iu,
  pool_saturated: /pool_saturated/u,
  statusLineHash: /⌗/u,
};

const candidates: {surfaceRef: string}[] = [];
let held = 0;
for (const window of before.windows) {
  for (const workspace of window.workspaces) {
    for (const tab of workspace.tabs) {
      const sessionId = tab.sessionId ?? tab.lastKnownSessionId;
      if (sessionId == null) continue;
      held += 1;
      if (tab.sessionId == null) bump('held: carried forward');
      const runningPane = panes.bySession.get(sessionId) ?? null;
      const running = runningPane != null;
      const unknownRunning = panes.statusLine.unknownSessions.has(sessionId);
      const live = surfaceById.get(tab.id) ?? null;
      if (running) {
        bump('A running again (session placed in a live pane)');
        bump(
          runningPane.surfaceId === tab.id
            ? 'A1 running again, in its own tab'
            : 'A2 running again, in another tab',
        );
        continue;
      }
      if (unknownRunning) bump('U session unknown to the pane join');
      if (live == null) {
        bump('B tab gone, session not running');
        continue;
      }
      bump('C tab exists, session not running');
      const tty = normalizeTty(live.tty);
      if (tty == null) {
        bump('C0 tab exists, no tty');
        continue;
      }
      const dup = (surfacesPerTty.get(tty) ?? 0) > 1;
      if (dup) bump('C-dupTty tab shares its tty');
      const onTty = procsByTty.get(tty) ?? [];
      const claude = onTty.some((p) => isClaudeProc(p));
      if (claude) {
        bump('C1 tab exists, holds a Claude process (another session)');
        if (dup) bump('C1-dupTty');
        continue;
      }
      bump('C2 tab exists, no Claude process in it');
      if (dup) bump('C2-dupTty');
      const onlyShell = onTty.every((p) => isShellScaffolding(p));
      bump(onlyShell ? 'C2a only shell processes' : 'C2b other processes');
      candidates.push({surfaceRef: live.ref});
    }
  }
}

// Screens of C2 tabs, six at a time, in memory only.
const screenStarted = Date.now();
const results: {features: string[]; read: boolean}[] = [];
let next = 0;
const worker = async (): Promise<void> => {
  while (next < candidates.length) {
    const item = candidates[next];
    next += 1;
    if (item == null) continue;
    const screen = await readScreen(cmux, item.surfaceRef);
    if (screen.kind !== 'read') {
      results.push({features: [], read: false});
      continue;
    }
    const lines = screenLines(screen.text);
    const features: string[] = [];
    if (idleShellScreen(lines)) features.push('idleShellScreen');
    for (const [name, pattern] of Object.entries(FAILURE_PATTERNS)) {
      if (pattern.test(screen.text)) features.push(name);
    }
    results.push({features, read: true});
  }
};
await Promise.all(Array.from({length: 6}, worker));
const screenMs = Date.now() - screenStarted;

const combos = new Map<string, number>();
for (const r of results) {
  if (!r.read) bump('S unreadable screen');
  for (const f of r.features) bump(`S feature: ${f}`);
  const joined = r.features.sort().join(' + ');
  const key = r.read ? (joined === '' ? '(none)' : joined) : 'unreadable';
  combos.set(key, (combos.get(key) ?? 0) + 1);
}

process.stdout.write(
  `restart: ${before.restart.kind} at ${new Date(before.restart.at).toISOString()}; source ${before.source.kind}; tabs that held a session: ${held}\n`,
);
process.stdout.write(
  `live reads ${liveReadMs} ms; ${candidates.length} screens read in ${screenMs} ms\n\n`,
);
for (const [key, value] of [...counts.entries()].sort()) {
  process.stdout.write(`${String(value).padStart(4)}  ${key}\n`);
}
process.stdout.write('\nscreen feature combinations (C2 tabs):\n');
for (const [key, value] of [...combos.entries()].sort((a, b) => b[1] - a[1])) {
  process.stdout.write(`${String(value).padStart(4)}  ${key}\n`);
}
