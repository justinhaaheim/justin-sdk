#!/usr/bin/env bun
/**
 * home-base-kwand.12: what each live Claude pane the pane join could not place
 * is, on live data. PRINTS COUNTS AND FLAGS ONLY: no title, screen text, path
 * or session id is printed, stored or logged.
 *
 * Run with the Claude Code sandbox off, from inside cmux:
 * `bun scripts/measure-unplaced-panes.ts`.
 */

import {
  attributeSessions,
  defaultHookStorePath,
  isClaudeProc,
  lookupPanes,
  normalizeTty,
  readHookStore,
  realPaneSources,
} from '../src/thread/pane-join';

if (process.argv.includes('--help')) {
  process.stdout.write(
    'measure-unplaced-panes: flags and counts for each live Claude pane the pane join could not place. Sandbox off, inside cmux.\n',
  );
  process.exit(0);
}

const panes = await lookupPanes(realPaneSources(process.env));
if (!panes.ok || panes.live == null) {
  process.stdout.write(
    `pane lookup failed: ${panes.ok ? 'no live view' : panes.reason}\n`,
  );
  process.exit(1);
}
const {procs, surfaces} = panes.live;
const store = readHookStore(defaultHookStorePath());
if (!store.ok) {
  process.stdout.write(`hook store unreadable: ${store.reason}\n`);
  process.exit(1);
}
const attributed = attributeSessions(store.value, procs, surfaces);
const placedSurfaceIds = new Set(
  [...panes.bySession.values()].map((pane) => pane.surfaceId),
);

process.stdout.write(
  `unplaced panes: ${panes.statusLine.unplaced.length}; placed sessions: ${panes.bySession.size}\n`,
);
// Claude processes on no live surface's tty (a closed pane cmux kept alive):
// the pane join cannot see them, so a session they run reads as not running.
const liveTtys = new Set(surfaces.map((s) => normalizeTty(s.tty)));
const offSurface = procs.filter((p) => {
  const tty = normalizeTty(p.tty);
  return isClaudeProc(p) && (tty == null || !liveTtys.has(tty));
});
const offSurfacePids = new Set(offSurface.map((p) => p.pid));
process.stdout.write(
  `Claude processes on no live tab's tty: ${offSurface.length} (with no tty: ${offSurface.filter((p) => normalizeTty(p.tty) == null).length}; hook-store sessions with those pids: ${attributed.filter((s) => s.pid != null && offSurfacePids.has(s.pid)).length})\n`,
);
for (const [index, pane] of panes.statusLine.unplaced.entries()) {
  const tty = normalizeTty(pane.surface.tty);
  const twins = surfaces.filter(
    (s) => s.ref !== pane.surface.ref && normalizeTty(s.tty) === tty,
  );
  const claude = procs.filter(
    (p) => isClaudeProc(p) && normalizeTty(p.tty) === tty,
  );
  const claudePids = new Set(claude.map((p) => p.pid));
  const storeSessionsOfPids = attributed.filter(
    (s) => s.pid != null && claudePids.has(s.pid),
  );
  const placedOfPids = storeSessionsOfPids.filter((s) =>
    panes.bySession.has(s.sessionId),
  );
  const lines = [
    `pane ${index + 1}: kind ${pane.kind}`,
    `  screen shows an id: ${pane.screenSessionId != null}`,
    `  session file names an id: ${pane.fileSessionId != null}`,
    `  surfaces sharing its tty: ${twins.length} (placed: ${twins.filter((s) => s.id != null && placedSurfaceIds.has(s.id)).length})`,
    `  Claude processes on its tty: ${claude.length} (with an argv session id: ${claude.filter((p) => /--resume|--session-id|\s-r\s/u.test(p.command)).length})`,
    `  hook-store sessions with those pids: ${storeSessionsOfPids.length} (placed in a live pane: ${placedOfPids.length})`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}
