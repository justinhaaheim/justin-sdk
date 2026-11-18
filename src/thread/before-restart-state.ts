/**
 * home-base-kwand.2 (gap G2 of epic home-base-kwand): for every session that
 * was in a cmux tab before the last restart, what that tab and session are
 * now. Justin's question 2 (2026-11-17): "Where can I see all the threads that
 * were in open windows before the restart? Can I filter by ones that were
 * active vs idle?"
 *
 * THE BEFORE SET is home-base-kwand.1's selection (`beforeRestart` in
 * tab-record-command.ts): each tab's Claude session id, or the one carried
 * forward by tab id when cmux dropped it after a failed restore.
 *
 * THE STATE NOW joins it with the live view the inbox already reads once per
 * run (`lookupPanes` in pane-join.ts: the cmux tree, ps, the hook store and the
 * status line). No fourth join: the tab ids are cmux surface ids, stable across
 * a relaunch (epic D1). Decision D2, as measured on 2026-11-18 (counts in the
 * bead's notes):
 *  - runningAgain: the pane join places the session in a live pane now.
 *  - restoreFailed: its tab exists, no Claude process runs on its tty, and its
 *    screen shows cmux's own restore error (`ERROR: overloaded …
 *    pool_saturated`, cmux's ControlClientWorkerPool string). 22 tabs.
 *  - shellInTab: its tab exists, no Claude process runs on its tty, and its
 *    screen shows no such error. 11 tabs: "tab exists, no Claude" alone (33)
 *    was too broad for "restore failed" (D2's open question).
 *  - otherSession: its tab exists and runs a Claude process that is not this
 *    session (a /clear, or a new session in the same tab). 1 tab measured; 2
 *    more shared a tty with another tab, which the screen settles below.
 *  - notRestored: its tab is gone and the session does not run.
 *  - unknown: anything could not be read (the live tabs, a screen, a session
 *    the status line could not settle). Never shown as notRestored (critical
 *    rule 7): a failed read is not a gone tab.
 *
 * SCREENS are read only for tabs that exist and whose session does not run, in
 * memory, six at a time (33 screens in 150 ms, measured), and are never
 * stored, logged or printed: the classification keeps a boolean.
 *
 * UNMATCHED PANES (home-base-kwand.12). A live Claude pane the pane join could
 * not place may run a session whose tab is gone, so such a session is never
 * notRestored while a pane could hold it (critical rule 7). Which sessions a
 * pane could hold, from what is known about it (`paneHolds`):
 *  - its status line shows a session id and one Claude process runs on its
 *    tty: only that session (the status line's id is the live one; it matched
 *    argv on 55 of 55 panes, scripts/CLAUDE.md);
 *  - every Claude process on its tty is one the hook store's pid join tied to
 *    a session the lookup placed (`live.placedPids`): only those sessions,
 *    which run. Measured 2026-11-18: both unmatched panes were twins of a
 *    placed tab on the same tty (cmux's duplicate-tty restore), each with one
 *    Claude process the pid join had placed in the twin;
 *  - otherwise the sessions of the repo each other Claude process works in
 *    (the process's cwd, read with lsof), plus every id the pane names: its
 *    status line, cmux's session file, argv, a placed pid's session, and the
 *    before record for its tab. Claude Code 2.1.327 cannot switch a running
 *    process to a session of another directory: its /resume prints "This
 *    session is from a different directory. To resume, run: cd …" instead
 *    (read from the binary, 2026-11-18). The repo, not the checkout, because
 *    /resume may list the repo's own worktrees;
 *  - a cwd that cannot be read: any session (the guard before kwand.12).
 */

import type {CmuxRunner} from './cmux';
import type {
  LiveSurface,
  PaneLookup,
  Proc,
  ScreenRead,
  SourceRead,
  UnplacedKind,
  UnplacedPane,
} from './pane-join';
import type {EnvLike} from './paths';
import type {
  BeforeRestart,
  ClockReader,
  SourceKind,
} from './tab-record-command';

import {execFile} from 'node:child_process';

import {CMUX_TIMEOUT_MS, realCmuxRunner} from './cmux';
import {cmuxSupportDir} from './cmux-session-file';
import {primaryCheckoutOf} from './config';
import {argvSessionId} from './live-sessions';
import {
  idleShellScreen,
  isClaudeProc,
  normalizeTty,
  readScreen,
  SCREEN_CONCURRENCY,
  screenLines,
} from './pane-join';
import {threadsStateDir} from './paths';
import {tabRecordDir} from './tab-record';
import {
  beforeRestart,
  realBootClock,
  realCmuxClock,
} from './tab-record-command';

/**
 * D2's states, as measured (module comment), in the ONE order every list of
 * them uses: the text inbox, its JSON, `thread tabs before-restart` and the
 * dashboard's restart grouping (src/threads-dash imports this list;
 * home-base-kwand.3 item 0). The ones to act on first, running again last.
 * The type is derived from the list, so a state cannot be missing from it.
 */
export const BEFORE_RESTART_STATES = [
  'restoreFailed',
  'shellInTab',
  'notRestored',
  'otherSession',
  'unknown',
  'runningAgain',
] as const;

export type BeforeRestartState = (typeof BEFORE_RESTART_STATES)[number];

/** Each state in Justin's words, for a card line, a heading and the JSON. */
export const BEFORE_RESTART_WORDS: Record<
  BeforeRestartState,
  {emoji: string; title: string}
> = {
  notRestored: {emoji: '🚫', title: 'not restored'},
  otherSession: {emoji: '🔀', title: 'its tab runs another Claude session'},
  restoreFailed: {emoji: '💥', title: 'restore failed'},
  runningAgain: {emoji: '🏃', title: 'running again'},
  shellInTab: {
    emoji: '🐚',
    title: 'its tab is back with a shell, no Claude (no failed restore shown)',
  },
  unknown: {emoji: '❔', title: 'unknown'},
};

/** The tab a session was in before the restart. */
export interface BeforeRestartTab {
  /** True when the record carried the session id forward (cmux had dropped it). */
  carried: boolean;
  /** The cmux surface id (CMUX_SURFACE_ID). */
  id: string;
  title: string | null;
  /** 0-based, as cmux saved it. */
  windowIndex: number;
  workspaceId: string;
  workspaceTitle: string | null;
}

/** One session's fact: where it was, and what that is now. */
export interface BeforeRestartFact {
  /** Why this state, in words; for `unknown`, what could not be read. */
  reason: string;
  /** ISO: the restart (later of the Mac boot and the cmux launch). */
  restartAt: string;
  restartKind: 'boot' | 'cmux launch';
  /** Which record said what was open, and when cmux saved it (ISO). */
  source: {kind: SourceKind; savedAt: string};
  state: BeforeRestartState;
  tab: BeforeRestartTab;
}

/** The whole answer for one run, or why there is none. */
export type BeforeRestartRead =
  | {
      facts: Map<string, BeforeRestartFact>;
      ok: true;
      restartAt: string;
      restartKind: 'boot' | 'cmux launch';
      /** Screens read for this answer, and how long they took. */
      screens: {ms: number; read: number; unreadable: number};
      source: {kind: SourceKind; savedAt: string};
      /** Tabs in the before set that held a Claude session (sessions can repeat). */
      tabsWithSession: number;
      /**
       * kwand.12: each live Claude pane the pane join could not place, what it
       * could hold, and how many sessions of the before set it leaves unknown.
       */
      unplaced: UnplacedPaneHold[];
    }
  | {ok: false; reason: string};

/**
 * kwand.12: the sessions one unmatched live Claude pane could hold (module
 * comment). `anything` is the guard before kwand.12: every session.
 */
export type UnplacedHold =
  | {checkouts: string[]; kind: 'checkouts'; sessionIds: string[]}
  | {kind: 'anything'; reason: string}
  /** Every Claude process on its tty already runs one of these placed sessions. */
  | {kind: 'matched'; sessionIds: string[]}
  | {kind: 'session'; sessionId: string};

/** One unmatched pane: why the join could not place it, and what it could hold. */
export interface UnplacedPaneHold {
  hold: UnplacedHold;
  /** Why the pane join could not place it. */
  kind: UnplacedKind;
  /** Sessions of the before set this pane leaves unknown (a session can count for two panes). */
  sessionsUnknown: number;
  /** The cmux surface ref, e.g. `surface:106`. */
  surface: string;
}

/**
 * The working directory of each pid, or why none could be read. A pid missing
 * from the map is a process whose cwd lsof did not list: unknown, not "none".
 */
export type CwdReader = (
  pids: readonly number[],
) => Promise<SourceRead<Map<number, string>>>;

/** Parse `lsof -F pn` output: `p<pid>` then `n<path>`. Pure. */
export function parseLsofCwds(stdout: string): Map<number, string> {
  const out = new Map<number, string>();
  let pid: number | null = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) {
      const parsed = Number.parseInt(line.slice(1), 10);
      pid = Number.isFinite(parsed) ? parsed : null;
    } else if (line.startsWith('n') && pid != null && line.length > 1) {
      out.set(pid, line.slice(1));
    }
  }
  return out;
}

/**
 * The real reader: ONE `lsof -a -d cwd -p <pids> -F pn`. lsof exits 1 when a
 * pid is gone, so its listing is read whatever the exit code; an empty listing
 * with an error is a failure. Inside the Claude Code sandbox lsof lists no
 * other process, so every pane there reads as `anything` (never narrower).
 */
export function realCwdReader(timeoutMs: number = CMUX_TIMEOUT_MS): CwdReader {
  return (pids) =>
    new Promise((resolve) => {
      const args = ['-a', '-w', '-d', 'cwd', '-p', pids.join(','), '-F', 'pn'];
      try {
        execFile(
          'lsof',
          args,
          {timeout: timeoutMs},
          (error, stdout, stderr) => {
            const listed = parseLsofCwds(String(stdout));
            if (error != null && listed.size === 0) {
              const detail = String(stderr).trim().split('\n')[0] ?? '';
              resolve({
                ok: false,
                reason: `lsof ${args.join(' ')} failed: ${detail !== '' ? detail : error.message}`,
              });
              return;
            }
            resolve({ok: true, value: listed});
          },
        );
      } catch (error) {
        resolve({
          ok: false,
          reason: `lsof could not start: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    });
}

/** cmux's own restore error on a tab's screen (measured, module comment). */
const FAILED_RESTORE = /pool_saturated|ERROR:\s*overloaded/u;

/** True when the screen shows cmux's failed restore. Pure. */
export function showsFailedRestore(text: string): boolean {
  return FAILED_RESTORE.test(text);
}

/** When precedence matters (one session in two tabs): the most telling first. */
const PRECEDENCE: readonly BeforeRestartState[] = [
  'runningAgain',
  'restoreFailed',
  'shellInTab',
  'otherSession',
  'unknown',
  'notRestored',
];

interface TabOfSession {
  /** Where the session worked before the restart (Claude's own cwd first); null: not recorded. */
  directory: string | null;
  sessionId: string;
  tab: BeforeRestartTab;
}

function tabsOfSessions(before: Extract<BeforeRestart, {ok: true}>): {
  tabs: TabOfSession[];
} {
  const tabs: TabOfSession[] = [];
  for (const window of before.windows) {
    for (const workspace of window.workspaces) {
      for (const tab of workspace.tabs) {
        const sessionId = tab.sessionId ?? tab.lastKnownSessionId;
        if (sessionId == null) continue;
        tabs.push({
          directory:
            tab.agentWorkingDirectory ??
            tab.directory ??
            workspace.currentDirectory,
          sessionId,
          tab: {
            carried: tab.sessionId == null,
            id: tab.id,
            title: tab.title,
            windowIndex: window.index,
            workspaceId: workspace.workspaceId,
            workspaceTitle: workspace.title,
          },
        });
      }
    }
  }
  return {tabs};
}

/** The live tab view the classification reads, from one pane lookup. */
interface LiveTabs {
  claudeTtys: Set<string>;
  surfaceById: Map<string, LiveSurface>;
  surfacesPerTty: Map<string, number>;
}

function liveTabsOf(live: {procs: Proc[]; surfaces: LiveSurface[]}): LiveTabs {
  const surfaceById = new Map<string, LiveSurface>();
  const surfacesPerTty = new Map<string, number>();
  for (const surface of live.surfaces) {
    if (surface.id != null) surfaceById.set(surface.id, surface);
    const tty = normalizeTty(surface.tty);
    if (tty != null)
      surfacesPerTty.set(tty, (surfacesPerTty.get(tty) ?? 0) + 1);
  }
  const claudeTtys = new Set<string>();
  for (const proc of live.procs) {
    const tty = normalizeTty(proc.tty);
    if (tty != null && isClaudeProc(proc)) claudeTtys.add(tty);
  }
  return {claudeTtys, surfaceById, surfacesPerTty};
}

/** An unmatched pane joined to its Claude processes (kwand.12). */
interface UnplacedPaneProcs {
  pane: UnplacedPane;
  procs: Proc[];
}

function unplacedWithProcs(
  unplaced: readonly UnplacedPane[],
  live: {procs: Proc[]} | null,
): UnplacedPaneProcs[] {
  return unplaced.map((pane) => {
    const tty = normalizeTty(pane.surface.tty);
    const procs =
      tty == null || live == null
        ? []
        : live.procs.filter(
            (proc) => isClaudeProc(proc) && normalizeTty(proc.tty) === tty,
          );
    return {pane, procs};
  });
}

/** The Claude processes on a pane's tty that the pid join did not place (kwand.12). */
function unmatchedProcs(
  entry: UnplacedPaneProcs,
  placedPids: ReadonlyMap<number, string>,
): Proc[] {
  return entry.procs.filter((proc) => !placedPids.has(proc.pid));
}

/** Whether a pane's status line settles what it holds: an id, one Claude process. */
function screenSettles(entry: UnplacedPaneProcs): string | null {
  const shown = entry.pane.screenSessionId;
  return shown != null && entry.procs.length <= 1 ? shown : null;
}

/**
 * kwand.12, pure but for `cwds` already read: what each unmatched pane could
 * hold (module comment). `beforeIdsByTab` gives the before record's session
 * for a tab id, so a pane in a tab that held a session names it.
 */
function paneHolds(
  entries: readonly UnplacedPaneProcs[],
  cwds: SourceRead<Map<number, string>> | null,
  beforeIdsByTab: ReadonlyMap<string, readonly string[]>,
  placedPids: ReadonlyMap<number, string>,
  primaryOf: (dir: string) => string,
): UnplacedHold[] {
  return entries.map((entry): UnplacedHold => {
    const shown = screenSettles(entry);
    if (shown != null) return {kind: 'session', sessionId: shown};
    const {pane} = entry;
    if (entry.procs.length === 0) {
      return {
        kind: 'anything',
        reason: 'no Claude process was found on its tty',
      };
    }
    const matchedIds = entry.procs.flatMap((proc) => {
      const id = placedPids.get(proc.pid);
      return id == null ? [] : [id.toLowerCase()];
    });
    const procs = unmatchedProcs(entry, placedPids);
    if (procs.length === 0) {
      return {kind: 'matched', sessionIds: [...new Set(matchedIds)].sort()};
    }
    if (cwds == null) {
      return {
        kind: 'anything',
        reason: 'the working directory of its Claude process was not read',
      };
    }
    if (!cwds.ok) {
      return {
        kind: 'anything',
        reason: `the working directory of its Claude process could not be read: ${cwds.reason}`,
      };
    }
    const checkouts = new Set<string>();
    for (const proc of procs) {
      const cwd = cwds.value.get(proc.pid);
      if (cwd == null) {
        return {
          kind: 'anything',
          reason: `lsof did not list the working directory of its Claude process (pid ${proc.pid})`,
        };
      }
      checkouts.add(primaryOf(cwd));
    }
    const ids = new Set<string>(matchedIds);
    for (const id of [
      pane.screenSessionId,
      pane.fileSessionId,
      ...procs.map((proc) => argvSessionId(proc.command)),
      ...(pane.surface.id == null
        ? []
        : (beforeIdsByTab.get(pane.surface.id) ?? [])),
    ]) {
      if (id != null) ids.add(id.toLowerCase());
    }
    return {
      checkouts: [...checkouts].sort(),
      kind: 'checkouts',
      sessionIds: [...ids].sort(),
    };
  });
}

/** `a` is `b` or a directory above it. Pure. */
function isAtOrAbove(a: string, b: string): boolean {
  const base = a.endsWith('/') ? a : `${a}/`;
  return a === b || b.startsWith(base);
}

/**
 * Whether a pane that could hold `hold` could hold this session (kwand.12).
 * A session whose directory was not recorded could be in any checkout.
 */
function couldHold(
  hold: UnplacedHold,
  sessionId: string,
  sessionPrimary: string | null,
): boolean {
  switch (hold.kind) {
    case 'anything':
      return true;
    case 'session':
      return hold.sessionId === sessionId.toLowerCase();
    case 'matched':
      return hold.sessionIds.includes(sessionId.toLowerCase());
    case 'checkouts':
      return (
        hold.sessionIds.includes(sessionId.toLowerCase()) ||
        sessionPrimary == null ||
        hold.checkouts.some(
          (checkout) =>
            isAtOrAbove(checkout, sessionPrimary) ||
            isAtOrAbove(sessionPrimary, checkout),
        )
      );
  }
}

/** One pane, as a session's reason names it. */
function holdWords(surface: string, hold: UnplacedHold): string {
  switch (hold.kind) {
    case 'anything':
      return `${surface}: nothing rules it out (${hold.reason})`;
    case 'session':
      return `${surface} shows it on its status line`;
    case 'matched':
      return `${surface}'s Claude process runs it`;
    case 'checkouts':
      return `${surface} runs Claude in ${hold.checkouts.join(' and ')}`;
  }
}

/** The unmatched panes with their holds, as `firstPass` reads them. */
interface Unmatched {
  holds: UnplacedHold[];
  panes: UnplacedPaneProcs[];
  primaryOf: (dir: string) => string;
}

/** The panes among `unmatched` that could hold this session, as indices. */
function holdersOf(
  unmatched: Unmatched,
  sessionId: string,
  directory: string | null,
): number[] {
  const primary = directory == null ? null : unmatched.primaryOf(directory);
  return unmatched.holds.flatMap((hold, index) =>
    couldHold(hold, sessionId, primary) ? [index] : [],
  );
}

function holdersReason(unmatched: Unmatched, holders: number[]): string {
  const words = holders.map((index) =>
    holdWords(
      unmatched.panes[index]?.pane.surface.ref ?? '?',
      unmatched.holds[index] ?? {kind: 'anything', reason: '?'},
    ),
  );
  return words.join('; ');
}

type Verdict = {
  /** kwand.12: the unmatched panes (indices) that leave it unknown. */
  heldBy?: number[];
  reason: string;
  state: BeforeRestartState;
};

/**
 * Step 1, pure: the verdict that needs no screen, or the surface whose screen
 * decides. `panes` failed or carries no live view: unknown, never notRestored.
 */
function firstPass(
  entry: TabOfSession,
  panes: PaneLookup,
  live: LiveTabs | null,
  unmatched: Unmatched,
): {claudeOnTty: boolean; screen: LiveSurface; shared: boolean} | Verdict {
  const {sessionId, tab} = entry;
  if (!panes.ok) {
    return {
      reason: `the live tabs could not be read: ${panes.reason}`,
      state: 'unknown',
    };
  }
  const pane = panes.bySession.get(sessionId);
  if (pane != null) {
    return {
      reason:
        pane.surfaceId === tab.id
          ? 'it runs in its own tab again'
          : 'it runs again, in another tab',
      state: 'runningAgain',
    };
  }
  const unsettled = panes.statusLine.unknownSessions.get(sessionId);
  if (unsettled != null) return {reason: unsettled, state: 'unknown'};
  if (live == null) {
    return {
      reason: 'the live tab list was not read with the pane lookup',
      state: 'unknown',
    };
  }
  const surface = live.surfaceById.get(tab.id);
  if (surface == null) {
    // kwand.12: only the unmatched panes that could hold it keep it unknown.
    const holders = holdersOf(unmatched, sessionId, entry.directory);
    if (holders.length > 0) {
      const count = holders.length;
      return {
        heldBy: holders,
        reason: `its tab is gone, and ${count === 1 ? 'a live Claude pane' : `${count} live Claude panes`} the tools could not match to a session could hold it (${holdersReason(unmatched, holders)}), so it may run there`,
        state: 'unknown',
      };
    }
    const others = unmatched.panes.length;
    return {
      reason:
        others === 0
          ? 'its tab is gone and it does not run'
          : `its tab is gone and it does not run (${others === 1 ? 'the one live Claude pane the tools could not match to a session cannot' : `none of the ${others} live Claude panes the tools could not match to a session can`} hold it)`,
      state: 'notRestored',
    };
  }
  const tty = normalizeTty(surface.tty);
  if (tty == null) {
    return {
      reason:
        'its tab is back but has no tty, so whether Claude runs in it cannot be told',
      state: 'unknown',
    };
  }
  const claudeOnTty = live.claudeTtys.has(tty);
  const shared = (live.surfacesPerTty.get(tty) ?? 0) > 1;
  // kwand.12: its own tab is an unmatched Claude pane that could hold it, so
  // "another session" would be a guess.
  const ownPane = unmatched.panes.findIndex(
    (candidate) => candidate.pane.surface.ref === surface.ref,
  );
  const ownHold = unmatched.holds[ownPane];
  if (
    ownHold != null &&
    couldHold(
      ownHold,
      sessionId,
      entry.directory == null ? null : unmatched.primaryOf(entry.directory),
    )
  ) {
    return {
      heldBy: [ownPane],
      reason: `its tab is back and runs a Claude process the tools could not match to a session (${holdWords(surface.ref, ownHold)}), so it may be this one`,
      state: 'unknown',
    };
  }
  if (claudeOnTty && !shared) {
    return {
      reason:
        'its tab is back and runs a Claude process that is not this session',
      state: 'otherSession',
    };
  }
  return {claudeOnTty, screen: surface, shared};
}

/** Step 2, pure: the verdict from the screen (read in memory only). */
function secondPass(
  first: {claudeOnTty: boolean; shared: boolean},
  screen: ScreenRead | undefined,
): Verdict {
  if (screen?.kind !== 'read') {
    return {
      reason: `its tab is back and its screen could not be read${screen == null ? '' : `: ${screen.reason}`}`,
      state: 'unknown',
    };
  }
  if (showsFailedRestore(screen.text)) {
    return {
      reason: "its tab is back with a shell showing cmux's restore error",
      state: 'restoreFailed',
    };
  }
  if (!first.claudeOnTty) {
    return {
      reason:
        'its tab is back with no Claude process, and shows no cmux restore error',
      state: 'shellInTab',
    };
  }
  // A tty two tabs share (cmux's restore can do that, epic G10) with Claude on
  // it: the screen says whose it is.
  if (idleShellScreen(screenLines(screen.text))) {
    return {
      reason:
        'its tab is back at a shell prompt; the Claude process on its tty belongs to another tab that shares the tty',
      state: 'shellInTab',
    };
  }
  return {
    reason:
      'its tab shares a tty with another tab, a Claude process runs on that tty, and its screen is not a shell prompt',
    state: 'unknown',
  };
}

/** `fn` over `items`, at most `limit` at a time, results in the items' order. */
async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next; index < items.length; index = next) {
      next += 1;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(
    Array.from({length: Math.min(limit, items.length)}, worker),
  );
  return results;
}

/**
 * kwand.12: the unmatched panes and what each could hold. lsof runs only when
 * a pane's status line does not settle it; a failed lookup has no panes.
 */
async function unmatchedPanes(
  tabs: readonly TabOfSession[],
  panes: PaneLookup,
  cwdReader: CwdReader | null,
  primaryOf: (dir: string) => string,
): Promise<Unmatched> {
  if (!panes.ok) return {holds: [], panes: [], primaryOf};
  const entries = unplacedWithProcs(
    panes.statusLine.unplaced,
    panes.live ?? null,
  );
  const placedPids = panes.live?.placedPids ?? new Map<number, string>();
  const pids = [
    ...new Set(
      entries.flatMap((entry) =>
        screenSettles(entry) == null
          ? unmatchedProcs(entry, placedPids).map((proc) => proc.pid)
          : [],
      ),
    ),
  ];
  let cwds: SourceRead<Map<number, string>> | null = null;
  if (pids.length > 0 && cwdReader != null) {
    try {
      cwds = await cwdReader(pids);
    } catch (error) {
      cwds = {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
  const beforeIdsByTab = new Map<string, string[]>();
  for (const entry of tabs) {
    beforeIdsByTab.set(entry.tab.id, [
      ...(beforeIdsByTab.get(entry.tab.id) ?? []),
      entry.sessionId,
    ]);
  }
  return {
    holds: paneHolds(entries, cwds, beforeIdsByTab, placedPids, primaryOf),
    panes: entries,
    primaryOf,
  };
}

/**
 * The fact for every session in the before set. Reads only the screens step 1
 * leaves open; writes nothing.
 */
export async function beforeRestartStates(input: {
  before: BeforeRestart;
  cmux: CmuxRunner;
  /**
   * kwand.12: the cwd of each unmatched pane's Claude process. Absent (a
   * test's default): such a pane could hold any session, the guard before.
   */
  cwds?: CwdReader;
  now?: () => number;
  panes: PaneLookup;
  /** A checkout's repo; default `primaryCheckoutOf` (no git spawned). */
  primaryOf?: (dir: string) => string;
}): Promise<BeforeRestartRead> {
  const {before, panes} = input;
  if (!before.ok) return {ok: false, reason: before.reason};
  const clock = input.now ?? Date.now;
  const {tabs} = tabsOfSessions(before);
  const live = panes.ok && panes.live != null ? liveTabsOf(panes.live) : null;
  const unmatched = await unmatchedPanes(
    tabs,
    panes,
    input.cwds ?? null,
    input.primaryOf ?? primaryCheckoutOf,
  );
  const firsts = tabs.map((entry) => firstPass(entry, panes, live, unmatched));
  const toRead = [
    ...new Set(
      firsts.flatMap((first) => ('screen' in first ? [first.screen.ref] : [])),
    ),
  ];
  const started = clock();
  const reads = await mapLimited(
    toRead,
    SCREEN_CONCURRENCY,
    async (ref) => [ref, await readScreen(input.cmux, ref)] as const,
  );
  const screens = new Map<string, ScreenRead>(reads);
  const ms = clock() - started;
  const restartAt = new Date(before.restart.at).toISOString();
  const source = {
    kind: before.source.kind,
    savedAt: new Date(before.source.fileCreatedAt).toISOString(),
  };
  const facts = new Map<string, BeforeRestartFact>();
  const heldBy = new Map<string, number[]>();
  for (const [position, entry] of tabs.entries()) {
    const first = firsts[position];
    if (first == null) continue;
    const verdict: Verdict =
      'screen' in first
        ? secondPass(first, screens.get(first.screen.ref))
        : first;
    const fact: BeforeRestartFact = {
      reason: verdict.reason,
      restartAt,
      restartKind: before.restart.kind,
      source,
      state: verdict.state,
      tab: entry.tab,
    };
    const existing = facts.get(entry.sessionId);
    if (
      existing == null ||
      PRECEDENCE.indexOf(fact.state) < PRECEDENCE.indexOf(existing.state)
    ) {
      facts.set(entry.sessionId, fact);
      heldBy.set(entry.sessionId, verdict.heldBy ?? []);
    }
  }
  // Per pane, the sessions it leaves unknown in the final answer.
  const unknownPerPane = unmatched.panes.map(() => 0);
  for (const [sessionId, fact] of facts) {
    if (fact.state !== 'unknown') continue;
    for (const index of heldBy.get(sessionId) ?? []) {
      unknownPerPane[index] = (unknownPerPane[index] ?? 0) + 1;
    }
  }
  return {
    facts,
    ok: true,
    restartAt,
    restartKind: before.restart.kind,
    screens: {
      ms,
      read: toRead.length,
      unreadable: [...screens.values()].filter((s) => s.kind !== 'read').length,
    },
    source,
    tabsWithSession: tabs.length,
    unplaced: unmatched.panes.map((entry, index) => ({
      hold: unmatched.holds[index] ?? {
        kind: 'anything' as const,
        reason: 'no hold computed',
      },
      kind: entry.pane.kind,
      sessionsUnknown: unknownPerPane[index] ?? 0,
      surface: entry.pane.surface.ref,
    })),
  };
}

/** What the inbox calls: the before set read now, then the states once panes are in. */
export type BeforeRestartReader = (
  panes: Promise<PaneLookup>,
) => Promise<BeforeRestartRead>;

/** The real reader: the two clocks, the tab record and cmux's files, then screens. */
export function realBeforeRestartReader(
  env: EnvLike,
  clocks: {boot?: ClockReader; cmux?: ClockReader} = {},
): BeforeRestartReader {
  return async (panes) => {
    const [boot, cmuxProcess] = await Promise.all([
      (clocks.boot ?? realBootClock)(),
      (clocks.cmux ?? realCmuxClock)(),
    ]);
    let before: BeforeRestart;
    try {
      before = beforeRestart({
        boot,
        cmuxProcess,
        now: Date.now(),
        storeDir: tabRecordDir(threadsStateDir(env)),
        supportDir: cmuxSupportDir(env),
      });
    } catch (error) {
      return {
        ok: false,
        reason: `the tab records could not be read: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return await beforeRestartStates({
      before,
      cmux: realCmuxRunner(CMUX_TIMEOUT_MS, env),
      cwds: realCwdReader(),
      panes: await panes,
    });
  };
}

/** "9:36pm", or "Nov 17, 9:36pm" when it is not `now`'s local day. */
export function restartWhen(iso: string, now: Date): string {
  const at = new Date(iso);
  const hours = at.getHours();
  const minutes = String(at.getMinutes()).padStart(2, '0');
  const time = `${hours % 12 === 0 ? 12 : hours % 12}:${minutes}${hours < 12 ? 'am' : 'pm'}`;
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  if (sameDay) return time;
  const month = at.toLocaleString('en-US', {month: 'short'});
  return `${month} ${at.getDate()}, ${time}`;
}

/** The card's line: "🔁 was open before the 9:36pm restart: restore failed". */
export function beforeRestartLine(fact: BeforeRestartFact, now: Date): string {
  const words = BEFORE_RESTART_WORDS[fact.state];
  const detail =
    fact.state === 'unknown'
      ? `unknown (${fact.reason})`
      : fact.state === 'runningAgain' && fact.reason.includes('another tab')
        ? 'running again, in another tab'
        : words.title;
  return `🔁 was open before the ${restartWhen(fact.restartAt, now)} restart: ${detail}`;
}
