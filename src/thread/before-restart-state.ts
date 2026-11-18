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
 *
 * CLAUDE PROCESSES OUTSIDE ANY TAB (home-base-kwand.16). cmux keeps a closed
 * pane's processes alive (scripts/CLAUDE.md, reap-orphaned-panes), and the
 * pane join sees a Claude process only through a live tab's tty. So every
 * process named `claude` (live-sessions.ts `isClaudeBinary`) whose tty no
 * live tab reports, or that has no tty, is judged from the same ps read, in
 * this order (`judgeOutside`):
 *  - `claude bg-pty-host`: the terminal host of a background session; holds
 *    none itself (its `bg-spare` worker is judged). A claude subcommand that
 *    is not a session (`daemon`, `agents`, `mcp` …, live-sessions.ts
 *    `isSessionProc`): holds none. Measured 2026-11-18: the measurement's own
 *    `claude agents --json` shows up here, with no tty.
 *  - it NAMES sessions: its argv (`--resume`, `-r`, `--session-id`), cmux's
 *    hook store (`live.storedPids`) or `claude agents --json` (its pid; a
 *    worker's host pid too) names them. Each one reads runningAgain, "it runs
 *    outside any cmux tab (pid N)", never notRestored, and the process holds
 *    no other session. Like live-sessions.ts, every id any source names counts
 *    (after a /clear the argv id is the old one): that only keeps a session
 *    from reading not restored.
 *  - `claude -p` / `--print` with no -r, -c, --resume, --continue or
 *    --session-id word: it runs a new session, so it holds none from before
 *    the restart. Measured 2026-11-18 (scripts/measure-claude-outside-tabs.ts
 *    --watch over 10:57): the hourly claude-usage-sample chore's `claude -p
 *    /usage` ran with no tty for about 4 s (chores runs.jsonl: 4 to 30 s at
 *    :57 each hour), named by no argv and no hook store entry, so without
 *    this rule an inbox run in that window would bring back kwand.12's coarse
 *    unknowns. The agents registry did list it, under its own new session.
 *  - a `bg-spare` worker with no tty that `claude agents --json` (read) does
 *    not list: the daemon's unclaimed spare, which holds none (live-sessions.ts
 *    header). With the registry unread or unreadable it is judged below.
 *  - anything else names no session, so it is held like an unmatched pane:
 *    the sessions of the repo its cwd is in (`couldHold`), any session when
 *    its cwd cannot be read. It keeps a session unknown only where its tab is
 *    gone, as an unmatched pane does.
 * `claude agents --json` is read only when a process is left unnamed by argv
 * and the hook store, and lsof once for the panes and processes together. A
 * failed ps read fails the pane lookup, so every session stays unknown
 * (critical rule 7).
 */

import type {CmuxRunner} from './cmux';
import type {AgentEntry, AgentsRunner} from './live-sessions';
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
import {
  argvSessionId,
  backgroundRole,
  isClaudeBinary,
  isSessionProc,
  readAgents,
  realAgentsRunner,
} from './live-sessions';
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

/** kwand.16: how a runningAgain reason begins when the session runs outside any tab. */
export const OUTSIDE_RUNNING = 'it runs outside any cmux tab';

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
      /**
       * kwand.16: why `claude agents --json` could not be read when a Claude
       * process outside any tab needed it (that process is then judged by
       * its cwd); null: read, or not needed.
       */
      agentsFailure: string | null;
      facts: Map<string, BeforeRestartFact>;
      ok: true;
      /** kwand.16: each Claude process outside any live tab, and what it means here. */
      outside: OutsideProcess[];
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

/** kwand.16: what one Claude process outside any live tab means (module comment). */
export type OutsideVerdict =
  /** It holds no session, and why. */
  | {kind: 'ignored'; reason: string}
  /** It names no session, so it could hold these (kwand.12's rules, by its cwd). */
  | {hold: UnplacedHold; kind: 'held'}
  /** argv, cmux's hook store or `claude agents --json` names what it runs (lowercased). */
  | {kind: 'named'; sessionIds: string[]};

/** kwand.16: one Claude process whose tty no live tab reports, or that has none. */
export interface OutsideProcess {
  pid: number;
  /** Sessions of the before set it runs (`named` only; else 0). */
  sessionsRunning: number;
  /** Sessions of the before set it leaves unknown (`held` only; else 0). */
  sessionsUnknown: number;
  /** Its tty, which no live tab reports; null: it has none. */
  tty: string | null;
  verdict: OutsideVerdict;
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
 * kwand.12, pure: the repo each of `procs` works in, from cwds already read;
 * or the `anything` hold that says why one could not be told (kwand.16 holds
 * an outside process by the same rule).
 */
function reposOf(
  procs: readonly Proc[],
  cwds: SourceRead<Map<number, string>> | null,
  primaryOf: (dir: string) => string,
): {checkouts: string[]; ok: true} | {hold: UnplacedHold; ok: false} {
  if (cwds == null) {
    return {
      hold: {
        kind: 'anything',
        reason: 'the working directory of its Claude process was not read',
      },
      ok: false,
    };
  }
  if (!cwds.ok) {
    return {
      hold: {
        kind: 'anything',
        reason: `the working directory of its Claude process could not be read: ${cwds.reason}`,
      },
      ok: false,
    };
  }
  const checkouts = new Set<string>();
  for (const proc of procs) {
    const cwd = cwds.value.get(proc.pid);
    if (cwd == null) {
      return {
        hold: {
          kind: 'anything',
          reason: `lsof did not list the working directory of its Claude process (pid ${proc.pid})`,
        },
        ok: false,
      };
    }
    checkouts.add(primaryOf(cwd));
  }
  return {checkouts: [...checkouts].sort(), ok: true};
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
    const repos = reposOf(procs, cwds, primaryOf);
    if (!repos.ok) return repos.hold;
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
      checkouts: repos.checkouts,
      kind: 'checkouts',
      sessionIds: [...ids].sort(),
    };
  });
}

// ---------------------------------------------------------------------------
// kwand.16: Claude processes outside any live tab (module comment)
// ---------------------------------------------------------------------------

/** Every process named `claude` whose tty no live tab reports, or that has none. Pure. */
function outsideProcs(live: {procs: Proc[]; surfaces: LiveSurface[]}): Proc[] {
  const tabTtys = new Set<string>();
  for (const surface of live.surfaces) {
    const tty = normalizeTty(surface.tty);
    if (tty != null) tabTtys.add(tty);
  }
  return live.procs.filter((proc) => {
    if (!isClaudeBinary(proc)) return false;
    const tty = normalizeTty(proc.tty);
    return tty == null || !tabTtys.has(tty);
  });
}

/** A command line's words, split on whitespace. Pure. */
function argvWords(command: string): string[] {
  return command.split(/\s+/u);
}

/** `claude -p` / `--print` (kwand.16). Pure. */
export function printsOnly(command: string): boolean {
  return argvWords(command).some((word) => word === '-p' || word === '--print');
}

/**
 * A flag that resumes or continues a session (-r, -c, --resume, --continue,
 * --session-id, with or without `=`): such a `claude -p` may hold an older
 * session. Pure.
 */
export function resumesASession(command: string): boolean {
  return argvWords(command).some((word) =>
    /^(?:-r|-c|--resume|--continue|--session-id)(?:=|$)/u.test(word),
  );
}

/** The registry read, or null when it was not read. */
type AgentsRead =
  | {entries: AgentEntry[]; ok: true}
  | {ok: false; reason: string}
  | null;

/** An entry of the registry for this process: its pid, or a worker's host (live-sessions.ts). */
function agentEntriesOf(proc: Proc, agents: AgentsRead): AgentEntry[] {
  if (agents?.ok !== true) return [];
  const worker = backgroundRole(proc) === 'worker';
  return agents.entries.filter(
    (entry) => entry.pid === proc.pid || (worker && entry.pid === proc.ppid),
  );
}

/** One outside process before its cwd is read: named, ignored, or unnamed (to hold). */
type OutsideStep =
  | {kind: 'unnamed'}
  | Extract<OutsideVerdict, {kind: 'ignored'} | {kind: 'named'}>;

/** kwand.16, pure: what one outside process is, in the module comment's order. */
function judgeOutside(
  proc: Proc,
  storedPids: ReadonlyMap<number, readonly string[]>,
  agents: AgentsRead,
): OutsideStep {
  const role = backgroundRole(proc);
  if (role === 'host') {
    return {
      kind: 'ignored',
      reason:
        'the terminal host of a background session (claude bg-pty-host); its worker is judged instead',
    };
  }
  if (role == null && !isSessionProc(proc)) {
    return {
      kind: 'ignored',
      reason:
        'a claude subcommand that is not a session (daemon, agents, mcp and the like)',
    };
  }
  const named = new Set<string>();
  const argv = argvSessionId(proc.command);
  if (argv != null) named.add(argv);
  for (const id of storedPids.get(proc.pid) ?? []) named.add(id.toLowerCase());
  for (const entry of agentEntriesOf(proc, agents)) {
    if (entry.sessionId != null) named.add(entry.sessionId);
  }
  if (named.size > 0) return {kind: 'named', sessionIds: [...named].sort()};
  if (printsOnly(proc.command) && !resumesASession(proc.command)) {
    return {
      kind: 'ignored',
      reason:
        'claude -p with no session flag runs a new session, so it holds none from before the restart',
    };
  }
  if (
    role === 'worker' &&
    normalizeTty(proc.tty) == null &&
    agents?.ok === true &&
    agentEntriesOf(proc, agents).length === 0
  ) {
    return {
      kind: 'ignored',
      reason:
        "the daemon's unclaimed background spare (no terminal, and claude agents --json does not list it)",
    };
  }
  return {kind: 'unnamed'};
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

/**
 * One thing that could hold a session whose tab is gone: an unmatched pane
 * (kwand.12) or a Claude process outside any tab that names no session
 * (kwand.16).
 */
interface Holder {
  hold: UnplacedHold;
  /** How a reason names it: the surface ref, or `pid <n>`. */
  label: string;
  /** The unmatched pane's surface ref; null for a process outside any tab. */
  surfaceRef: string | null;
}

/** kwand.16: one outside process, judged; `holder` indexes `Unmatched.holders` when held. */
interface OutsideJudged {
  holder: number | null;
  proc: Proc;
  verdict: OutsideVerdict;
}

/** The unmatched panes and outside processes with their holds, as `firstPass` reads them. */
interface Unmatched {
  /** kwand.16: why the agents registry could not be read when needed; else null. */
  agentsFailure: string | null;
  /** The panes' holders first, in `panes` order, then the held outside processes'. */
  holders: Holder[];
  /** kwand.16: every Claude process outside any live tab. */
  outside: OutsideJudged[];
  /** kwand.16: each session (lowercased) an outside process names, and those pids. */
  outsideNamed: Map<string, number[]>;
  panes: UnplacedPaneProcs[];
  primaryOf: (dir: string) => string;
}

/** The holders among `unmatched` that could hold this session, as indices. */
function holdersOf(
  unmatched: Unmatched,
  sessionId: string,
  directory: string | null,
): number[] {
  const primary = directory == null ? null : unmatched.primaryOf(directory);
  return unmatched.holders.flatMap((holder, index) =>
    couldHold(holder.hold, sessionId, primary) ? [index] : [],
  );
}

function holdersReason(unmatched: Unmatched, holders: number[]): string {
  const words = holders.map((index) => {
    const holder = unmatched.holders[index];
    return holder == null ? '?' : holdWords(holder.label, holder.hold);
  });
  return words.join('; ');
}

/** "a live Claude pane …", "2 Claude processes outside any cmux tab …", or both. */
function holdersNoun(panes: number, procs: number): string {
  const parts: string[] = [];
  if (panes > 0) {
    parts.push(
      `${panes === 1 ? 'a live Claude pane' : `${panes} live Claude panes`} the tools could not match to a session`,
    );
  }
  if (procs > 0) {
    parts.push(
      procs === 1
        ? 'a Claude process outside any cmux tab that names no session'
        : `${procs} Claude processes outside any cmux tab that name no session`,
    );
  }
  return parts.join(' and ');
}

/** Why none of the holders can hold a not-restored session, in brackets; '' with none. */
function noHolderWords(panes: number, procs: number): string {
  if (panes + procs === 0) return '';
  const paneWords = `live Claude ${panes === 1 ? 'pane' : 'panes'} the tools could not match to a session`;
  const procWords = `Claude ${procs === 1 ? 'process' : 'processes'} outside any cmux tab that ${procs === 1 ? 'names' : 'name'} no session`;
  if (procs === 0) {
    return panes === 1
      ? ` (the one ${paneWords} cannot hold it)`
      : ` (none of the ${panes} ${paneWords} can hold it)`;
  }
  if (panes === 0) {
    return procs === 1
      ? ` (the one ${procWords} cannot hold it)`
      : ` (none of the ${procs} ${procWords} can hold it)`;
  }
  return ` (none of the ${panes} ${paneWords} and the ${procs} ${procWords} can hold it)`;
}

type Verdict = {
  /** kwand.12: the holders (indices into `Unmatched.holders`) that leave it unknown. */
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
  // kwand.16: a Claude process outside any live tab names it, so it runs.
  const outsidePids = unmatched.outsideNamed.get(sessionId.toLowerCase());
  if (outsidePids != null) {
    return {
      reason: `${OUTSIDE_RUNNING} (${outsidePids.length === 1 ? 'pid' : 'pids'} ${outsidePids.join(', ')})`,
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
    // kwand.12: only the unmatched panes that could hold it keep it unknown;
    // kwand.16: and the outside processes that name no session.
    const holders = holdersOf(unmatched, sessionId, entry.directory);
    if (holders.length > 0) {
      const paneCount = holders.filter(
        (index) => unmatched.holders[index]?.surfaceRef != null,
      ).length;
      return {
        heldBy: holders,
        reason: `its tab is gone, and ${holdersNoun(paneCount, holders.length - paneCount)} could hold it (${holdersReason(unmatched, holders)}), so it may run there`,
        state: 'unknown',
      };
    }
    const panesCount = unmatched.panes.length;
    return {
      reason: `its tab is gone and it does not run${noHolderWords(panesCount, unmatched.holders.length - panesCount)}`,
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
  const ownPane = unmatched.holders.findIndex(
    (candidate) => candidate.surfaceRef === surface.ref,
  );
  const ownHold = unmatched.holders[ownPane]?.hold;
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
 * kwand.12: the unmatched panes and what each could hold; kwand.16: the
 * Claude processes outside any live tab, judged. lsof runs once, only for a
 * pane its status line does not settle and an outside process that names no
 * session; the agents registry only when argv and the hook store leave an
 * outside process unnamed. A failed lookup has neither.
 */
async function unmatchedHolders(
  tabs: readonly TabOfSession[],
  panes: PaneLookup,
  readers: {agents: AgentsRunner | null; cwds: CwdReader | null},
  primaryOf: (dir: string) => string,
): Promise<Unmatched> {
  if (!panes.ok) {
    return {
      agentsFailure: null,
      holders: [],
      outside: [],
      outsideNamed: new Map(),
      panes: [],
      primaryOf,
    };
  }
  const entries = unplacedWithProcs(
    panes.statusLine.unplaced,
    panes.live ?? null,
  );
  const placedPids = panes.live?.placedPids ?? new Map<number, string>();
  // kwand.16: the outside processes, judged without the registry first.
  const outsideList = panes.live == null ? [] : outsideProcs(panes.live);
  const storedPids =
    panes.live?.storedPids ?? new Map<number, readonly string[]>();
  let steps = outsideList.map((proc) => judgeOutside(proc, storedPids, null));
  let agentsFailure: string | null = null;
  if (readers.agents != null && steps.some((step) => step.kind === 'unnamed')) {
    const agents = await readAgents(readers.agents);
    if (!agents.ok) agentsFailure = agents.reason;
    steps = outsideList.map((proc) => judgeOutside(proc, storedPids, agents));
  }
  const unnamed = outsideList.filter(
    (_, index) => steps[index]?.kind === 'unnamed',
  );
  const pids = [
    ...new Set([
      ...entries.flatMap((entry) =>
        screenSettles(entry) == null
          ? unmatchedProcs(entry, placedPids).map((proc) => proc.pid)
          : [],
      ),
      ...unnamed.map((proc) => proc.pid),
    ]),
  ];
  const cwdReader = readers.cwds;
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
  const paneHoldList = paneHolds(
    entries,
    cwds,
    beforeIdsByTab,
    placedPids,
    primaryOf,
  );
  const holders: Holder[] = entries.map((entry, index) => ({
    hold: paneHoldList[index] ?? {kind: 'anything', reason: 'no hold computed'},
    label: entry.pane.surface.ref,
    surfaceRef: entry.pane.surface.ref,
  }));
  const outside = outsideList.map((proc, index): OutsideJudged => {
    const step = steps[index] ?? {kind: 'unnamed'};
    if (step.kind !== 'unnamed') return {holder: null, proc, verdict: step};
    const repos = reposOf([proc], cwds, primaryOf);
    const hold: UnplacedHold = repos.ok
      ? {checkouts: repos.checkouts, kind: 'checkouts', sessionIds: []}
      : repos.hold;
    holders.push({hold, label: `pid ${proc.pid}`, surfaceRef: null});
    return {holder: holders.length - 1, proc, verdict: {hold, kind: 'held'}};
  });
  const outsideNamed = new Map<string, number[]>();
  for (const entry of outside) {
    if (entry.verdict.kind !== 'named') continue;
    for (const id of entry.verdict.sessionIds) {
      outsideNamed.set(id, [...(outsideNamed.get(id) ?? []), entry.proc.pid]);
    }
  }
  return {
    agentsFailure,
    holders,
    outside,
    outsideNamed,
    panes: entries,
    primaryOf,
  };
}

/**
 * The fact for every session in the before set. Reads only the screens step 1
 * leaves open; writes nothing.
 */
export async function beforeRestartStates(input: {
  /**
   * kwand.16: `claude agents --json`, read only when a Claude process outside
   * any tab is left unnamed by argv and the hook store. Absent (a test's
   * default): not read, so such a process is held by its cwd.
   */
  agents?: AgentsRunner;
  before: BeforeRestart;
  cmux: CmuxRunner;
  /**
   * kwand.12: the cwd of each unmatched pane's Claude process (kwand.16: and
   * of each outside process that names no session). Absent (a test's
   * default): such a pane or process could hold any session, the guard
   * before.
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
  const unmatched = await unmatchedHolders(
    tabs,
    panes,
    {agents: input.agents ?? null, cwds: input.cwds ?? null},
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
  // Per holder (pane or outside process), the sessions it leaves unknown in
  // the final answer.
  const unknownPerHolder = unmatched.holders.map(() => 0);
  for (const [sessionId, fact] of facts) {
    if (fact.state !== 'unknown') continue;
    for (const index of heldBy.get(sessionId) ?? []) {
      unknownPerHolder[index] = (unknownPerHolder[index] ?? 0) + 1;
    }
  }
  const beforeIds = new Set([...facts.keys()].map((id) => id.toLowerCase()));
  return {
    agentsFailure: unmatched.agentsFailure,
    facts,
    ok: true,
    outside: unmatched.outside.map(({holder, proc, verdict}) => ({
      pid: proc.pid,
      sessionsRunning:
        verdict.kind === 'named'
          ? verdict.sessionIds.filter((id) => beforeIds.has(id)).length
          : 0,
      sessionsUnknown: holder == null ? 0 : (unknownPerHolder[holder] ?? 0),
      tty: normalizeTty(proc.tty),
      verdict,
    })),
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
      hold: unmatched.holders[index]?.hold ?? {
        kind: 'anything' as const,
        reason: 'no hold computed',
      },
      kind: entry.pane.kind,
      sessionsUnknown: unknownPerHolder[index] ?? 0,
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
      agents: realAgentsRunner(env),
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
        : fact.state === 'runningAgain' &&
            fact.reason.startsWith(OUTSIDE_RUNNING)
          ? 'running again, outside any cmux tab'
          : words.title;
  return `🔁 was open before the ${restartWhen(fact.restartAt, now)} restart: ${detail}`;
}
