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
 */

import type {CmuxRunner} from './cmux';
import type {LiveSurface, PaneLookup, Proc, ScreenRead} from './pane-join';
import type {EnvLike} from './paths';
import type {
  BeforeRestart,
  ClockReader,
  SourceKind,
} from './tab-record-command';

import {CMUX_TIMEOUT_MS, realCmuxRunner} from './cmux';
import {cmuxSupportDir} from './cmux-session-file';
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
    }
  | {ok: false; reason: string};

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

type Verdict = {reason: string; state: BeforeRestartState};

/**
 * Step 1, pure: the verdict that needs no screen, or the surface whose screen
 * decides. `panes` failed or carries no live view: unknown, never notRestored.
 */
function firstPass(
  sessionId: string,
  tab: BeforeRestartTab,
  panes: PaneLookup,
  live: LiveTabs | null,
): {claudeOnTty: boolean; screen: LiveSurface; shared: boolean} | Verdict {
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
    const unplaced = panes.statusLine.unplaced.length;
    if (unplaced > 0) {
      return {
        reason: `its tab is gone, and ${unplaced} live Claude ${unplaced === 1 ? 'pane' : 'panes'} could not be placed, so it may run in one`,
        state: 'unknown',
      };
    }
    return {
      reason: 'its tab is gone and it does not run',
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
 * The fact for every session in the before set. Reads only the screens step 1
 * leaves open; writes nothing.
 */
export async function beforeRestartStates(input: {
  before: BeforeRestart;
  cmux: CmuxRunner;
  now?: () => number;
  panes: PaneLookup;
}): Promise<BeforeRestartRead> {
  const {before, panes} = input;
  if (!before.ok) return {ok: false, reason: before.reason};
  const clock = input.now ?? Date.now;
  const {tabs} = tabsOfSessions(before);
  const live = panes.ok && panes.live != null ? liveTabsOf(panes.live) : null;
  const firsts = tabs.map((entry) =>
    firstPass(entry.sessionId, entry.tab, panes, live),
  );
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
  for (const [position, entry] of tabs.entries()) {
    const first = firsts[position];
    if (first == null) continue;
    const verdict =
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
