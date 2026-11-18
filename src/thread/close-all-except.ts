/**
 * `thread close --all-except` (home-base-kwand.7, gap G10 of epic
 * home-base-kwand): close every cmux workspace except the ones that matter,
 * as a dry run unless `--apply` is given. Justin, 2026-11-17: "my goal … is
 * to be able to confidently and calmly close any and all terminal windows
 * whenever I want".
 *
 * This module holds the parts that are not the close itself: the keep rules
 * K2 (a) to (g) and K3 over each workspace's sessions, the reason kinds K6
 * counts by, the session facts read from the inbox (K9) and the plan's
 * counts. close.ts runs the targets through the ONE close pipeline (K1):
 * assess, the record, the second pass before each SIGTERM, then
 * stopThenCloseWorkspace.
 */

import type {CmuxTree} from './cmux';
import type {LiveSessions} from './live-sessions';
import type {GateReasonKind} from './open-undo';
import type {EnvLike} from './paths';
import type {ChainFlags} from './session-flags';
import type {InboxRead} from './session-inbox';
import type {SessionEnding} from './transcript-ending';

import {normalizeTty} from './pane-join';
import {ageWords} from './part-one';
import {readInbox, rowEnding} from './session-inbox';
import {WORKING_NOW_WINDOW_MS} from './transcript-ending';

// ---------------------------------------------------------------------------
// Reason kinds (K6)
// ---------------------------------------------------------------------------

/**
 * Why a workspace is kept. The K2 rules first, in K2's order, then `unknown`
 * (K3), then what `assess` keeps (K2 h). A kept workspace is counted once,
 * under the first of its kinds in this order.
 */
export type KeepKind =
  | 'changed'
  | 'keepFlag'
  | 'marked'
  | 'noResume'
  | 'notChecked'
  | 'own'
  | 'pinned'
  | 'recentlyActive'
  | 'unknown'
  | 'untracked'
  | GateReasonKind;

/** K6: the order a kept workspace's first reason is chosen by. */
export const KEEP_KIND_ORDER: readonly KeepKind[] = [
  'own',
  'marked',
  'working',
  'unsentText',
  'untracked',
  'recentlyActive',
  'keepFlag',
  'unknown',
  'pinned',
  'sharedTty',
  'unreadableScreen',
  'severalClaude',
  'noSessionLine',
  'noClaudeProcess',
  'unconfirmedProcess',
  'startingOrDialog',
  'ttyUnknown',
  'running',
  'notIdle',
  'noPane',
  'otherSession',
  'noResume',
  'changed',
  'notChecked',
];

/** How each kind is named in the counts. */
export const KEEP_KIND_WORDS: Record<KeepKind, string> = {
  changed: 'changed since the first check',
  keepFlag: 'named with --keep',
  marked: 'marked (⭐ or another mark)',
  noClaudeProcess: 'Claude on screen, no claude process on its tty',
  noPane: 'no pane listed',
  noResume: 'no resume command',
  noSessionLine: 'no ⌗ session line',
  notChecked: 'not checked',
  notIdle: 'not an idle shell',
  otherSession: 'another session shown',
  own: "this command's own workspace",
  pinned: 'pinned',
  recentlyActive: 'active within --keep-active',
  running: 'a program running',
  severalClaude: 'more than one Claude',
  sharedTty: 'shared tty',
  startingOrDialog: 'Claude starting or showing a dialog',
  ttyUnknown: 'tty unknown',
  unconfirmedProcess: 'claude process not confirmed',
  // home-base-kwand.27: the counts' word covers every cause below; a kept
  // workspace's "Kept as" line names its own cause (UNKNOWN_KEPT_AS).
  unknown:
    'unknown (a fact could not be read, or what runs in a tab cannot be seen)',
  unreadableScreen: 'unreadable screen',
  unsentText: 'unsent text',
  untracked: 'untracked session',
  working: 'Claude working now',
};

/**
 * home-base-kwand.27: why a workspace was kept as `unknown`. The JSON kind
 * stays `unknown` (K6 counts it once); the cause only picks the words of its
 * "Kept as" line, so a keep where nothing failed to read never says so.
 */
export type UnknownCause =
  | 'blankScreen'
  | 'noProcessTty'
  | 'unreadFact'
  | 'unseenClaude';

/** The "Kept as" words of a workspace kept as `unknown`, by cause. */
export const UNKNOWN_KEPT_AS: Record<UnknownCause, string> = {
  blankScreen:
    'unknown (a tab shows a blank screen, so what runs in it cannot be seen)',
  noProcessTty:
    'unknown (no process runs on the terminal a tab reports, so what runs in that tab cannot be seen)',
  unreadFact: 'unknown (a fact could not be read)',
  unseenClaude: 'unknown (a Claude process could be running here unseen)',
};

/** An `unknown` reason always carries its cause (kwand.27); no other does. */
export type KeepReason =
  | {cause: UnknownCause; kind: 'unknown'; text: string}
  | {kind: Exclude<KeepKind, 'unknown'>; text: string};

/** The cause of the first `unknown` reason, or null when there is none. */
export function firstUnknownCause(
  reasons: readonly KeepReason[],
): UnknownCause | null {
  for (const reason of reasons) {
    if (reason.kind === 'unknown') return reason.cause;
  }
  return null;
}

/** K6: the first kind of a kept workspace, in KEEP_KIND_ORDER. */
export function primaryKind(kinds: readonly KeepKind[]): KeepKind {
  let best: KeepKind = 'notChecked';
  let bestAt = Infinity;
  for (const kind of kinds) {
    const at = KEEP_KIND_ORDER.indexOf(kind);
    if (at !== -1 && at < bestAt) {
      best = kind;
      bestAt = at;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// --keep-active
// ---------------------------------------------------------------------------

export const KEEP_ACTIVE_DEFAULT = '24h';

/** `30m`, `24h`, `2d` (or `0`) as ms; null when it is none of those. */
export function parseKeepActive(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '0') return 0;
  const match = /^(\d+)(m|h|d)$/u.exec(trimmed);
  if (match == null) return null;
  const count = Number(match[1]);
  const unit =
    match[2] === 'm' ? 60_000 : match[2] === 'h' ? 3_600_000 : 86_400_000;
  return count * unit;
}

// ---------------------------------------------------------------------------
// Session facts (K9)
// ---------------------------------------------------------------------------

/** What the keep rules need to know about one session, from its inbox row. */
export interface SessionFacts {
  /**
   * How its last turn ended, with liveness true (the caller's live join
   * proved a Claude process runs it); null for a session that is not live,
   * where it is not needed.
   */
  ending: SessionEnding | null;
  /** D4: the chain's marks; null when no session bead was loaded to carry them. */
  flags: ChainFlags | null;
  lastActivityAt: string | null;
  sessionBeadId: string | null;
  sessionId: string;
  tracked: boolean;
  /** Why the row could not be loaded, or null. */
  unreadable: string | null;
}

export type SessionFactsRead =
  | {
      bySession: Map<string, SessionFacts>;
      kind: 'read';
      /** Why a session with no row may still be tracked, or null (a whole load). */
      partial: string | null;
      /** Sessions the inbox leaves out as test sessions. */
      testSessions: Set<string>;
    }
  | {kind: 'failed'; reason: string};

/**
 * K9: no age window, so a session idle for months still has its row. The
 * inbox hides by age only; Done and Archived rows are always in its read.
 */
export const NO_AGE_WINDOW_DAYS = 36_500;

/** The facts from an inbox read; `live` names the sessions to read an ending for. */
export function factsOfInbox(
  read: InboxRead,
  live: ReadonlySet<string>,
  now: Date,
): Extract<SessionFactsRead, {kind: 'read'}> {
  const bySession = new Map<string, SessionFacts>();
  for (const row of read.rows) {
    // F6: a folded line stands for several untracked sessions; each gets it.
    const ids = row.repeats?.sessionIds ?? [row.sessionId];
    for (const id of ids) {
      const key = id.toLowerCase();
      bySession.set(key, {
        ending:
          live.has(key) && id === row.sessionId
            ? rowEnding(row, now, true)
            : null,
        flags: row.flags ?? null,
        lastActivityAt:
          id === row.sessionId
            ? row.lastActivityAt
            : (row.repeats?.oldestAt ?? null),
        sessionBeadId: row.sessionBeadId,
        sessionId: key,
        tracked: row.tracked,
        unreadable: row.unreadable,
      });
    }
  }
  const partial = [
    ...(read.corrupt.length > 0
      ? [`${read.corrupt.length} lines of the sessions index could not be read`]
      : []),
    ...(read.untracked.failures.length > 0
      ? [`the untracked scan failed on ${read.untracked.failures.length} files`]
      : []),
  ];
  return {
    bySession,
    kind: 'read',
    partial: partial.length === 0 ? null : partial.join('; '),
    testSessions: new Set(
      read.testSessions.map((entry) => entry.sessionId.toLowerCase()),
    ),
  };
}

/** The real read: the inbox with no age window, every repo, no pane lookup. */
export async function realReadSessionFacts(input: {
  cwd: string;
  env: EnvLike;
  live: ReadonlySet<string>;
  now: Date;
}): Promise<SessionFactsRead> {
  const read = await readInbox({
    cwd: input.cwd,
    days: NO_AGE_WINDOW_DAYS,
    env: input.env,
    now: input.now,
    repo: null,
  });
  if (read.kind === 'failed') return read;
  return factsOfInbox(read.read, input.live, input.now);
}

// ---------------------------------------------------------------------------
// The keep rules (K2 a to g, K3)
// ---------------------------------------------------------------------------

function ms(iso: string | null): number | null {
  if (iso == null) return null;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? null : parsed;
}

/** K2 (b), (c), (e), (f) and K3 for one live session. */
export function sessionKeeps(
  sessionId: string,
  facts: Extract<SessionFactsRead, {kind: 'read'}>,
  input: {keepActiveMs: number; keepActiveText: string; now: Date},
): KeepReason[] {
  const key = sessionId.toLowerCase();
  const found = facts.bySession.get(key);
  if (found == null) {
    // K9: a missing row never lets a workspace close.
    if (facts.testSessions.has(key)) {
      return [
        {
          cause: 'unreadFact',
          kind: 'unknown',
          text: `unknown: session ${key} is a test session, which the inbox leaves out, so its marks and activity were not read`,
        },
      ];
    }
    if (facts.partial != null) {
      return [
        {
          cause: 'unreadFact',
          kind: 'unknown',
          text: `unknown: session ${key} has no inbox row, and the inbox load was partial (${facts.partial})`,
        },
      ];
    }
    return [
      {
        kind: 'untracked',
        text: `untracked: session ${key} has no session bead and no inbox row, so nothing would let you find it again`,
      },
    ];
  }
  const out: KeepReason[] = [];
  const nowMs = input.now.getTime();
  if (!found.tracked) {
    out.push({
      kind: 'untracked',
      text: `untracked: session ${key} has no session bead, so nothing would let you find it again`,
    });
  } else if (found.flags == null) {
    out.push({
      cause: 'unreadFact',
      kind: 'unknown',
      text: `unknown: the marks of session ${key} could not be read (${found.unreadable ?? 'its session bead was not loaded'})`,
    });
  } else {
    if (found.flags.labels.length > 0) {
      out.push({
        kind: 'marked',
        text: `marked: session ${key}'s chain carries ${found.flags.emoji.join(' ')}`,
      });
    }
    if (found.flags.undecodable.length > 0) {
      out.push({
        cause: 'unreadFact',
        kind: 'unknown',
        text: `unknown: session ${key}'s chain carries mark labels that do not decode (${found.flags.undecodable.map((entry) => entry.label).join(', ')})`,
      });
    }
    if (found.flags.problems.length > 0) {
      out.push({
        cause: 'unreadFact',
        kind: 'unknown',
        text: `unknown: the marks of part of session ${key}'s chain could not be read (${found.flags.problems.join('; ')})`,
      });
    }
  }
  const lastMs = ms(found.lastActivityAt);
  const ending = found.ending;
  if (ending?.kind === 'workingNow') {
    out.push({
      kind: 'working',
      text: `working: session ${key}'s last turn has not finished and its newest record is under ${WORKING_NOW_WINDOW_MS / 60_000} minutes old`,
    });
  } else if (
    (ending == null || ending.kind === 'unknown') &&
    (lastMs == null || nowMs - lastMs < WORKING_NOW_WINDOW_MS)
  ) {
    out.push({
      cause: 'unreadFact',
      kind: 'unknown',
      text: `unknown: whether session ${key} is working now could not be told (${ending == null ? 'its ending was not read' : ending.reason})`,
    });
  }
  if (lastMs == null) {
    out.push({
      cause: 'unreadFact',
      kind: 'unknown',
      text: `unknown: session ${key}'s last activity could not be dated, so whether it was active within --keep-active ${input.keepActiveText} cannot be told`,
    });
  } else if (nowMs - lastMs < input.keepActiveMs) {
    out.push({
      kind: 'recentlyActive',
      text: `active ${ageWords(new Date(lastMs), input.now)}: session ${key} was active within --keep-active ${input.keepActiveText}`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Claude processes placed in no workspace (home-base-kwand.21 F2)
// ---------------------------------------------------------------------------

/** One live Claude process the live join placed in no workspace. */
export interface UnplacedClaude {
  detail: string;
  /**
   * `unnamed`: in live.unplaced. `noWorkspace`: a session named for it, but
   * the process is on no tab (home-base-kwand.24 R2: judged per process, so a
   * second process of a session placed elsewhere counts too).
   */
  kind: 'noWorkspace' | 'unnamed';
  pid: number | null;
}

/**
 * F2: every live Claude process the join could not place in a workspace.
 * `thread open`'s reading of `live.unplaced` (every entry; it refuses while
 * one exists, live-sessions.ts header), plus every session a source named
 * but placed in no workspace: its process runs on a tty no single cmux tab
 * reports. A stale tty report can leave either one running behind a pane
 * whose own evidence is weak, so the caller keeps such panes while any
 * exists. The live read itself failing refuses the run (K3), so there is no
 * "could not say" case left to treat as unplaced here.
 *
 * home-base-kwand.24 R2: placement is judged per PROCESS. A named process the
 * join placed in no workspace is unplaced even when another process of the
 * same session is placed (a session resumed twice, one copy in a tab and one
 * on a terminal no tab reports). The per-session rule above stays, so this
 * only ever adds; a pid already listed is not listed twice.
 */
export function unplacedClaude(
  live: Extract<LiveSessions, {kind: 'read'}>,
): UnplacedClaude[] {
  const out: UnplacedClaude[] = live.unplaced.map((entry) => ({
    detail: entry.detail,
    kind: 'unnamed',
    pid: entry.pid,
  }));
  for (const [sessionId, found] of live.bySessionId) {
    const placed = live.workspacesBySessionId.get(sessionId) ?? [];
    if (found.workspaceId != null || placed.length > 0) continue;
    out.push({
      detail: `session ${sessionId} runs (found by ${found.source}) on a terminal no single cmux tab reports`,
      kind: 'noWorkspace',
      pid: found.pid,
    });
  }
  const placedPids = new Set(
    live.namedProcesses
      .filter((entry) => entry.workspaceId != null)
      .map((entry) => entry.pid),
  );
  const listed = new Set(out.map((entry) => entry.pid));
  for (const entry of live.namedProcesses) {
    if (placedPids.has(entry.pid) || listed.has(entry.pid)) continue;
    listed.add(entry.pid);
    out.push({
      detail: `pid ${entry.pid} runs session ${entry.sessionId} (found by ${entry.source}) on a terminal no single cmux tab reports, whether or not another process of that session is in a tab`,
      kind: 'noWorkspace',
      pid: entry.pid,
    });
  }
  return out;
}

/**
 * home-base-kwand.24 R1: each pane whose reported tty has no process at all
 * keeps its workspace as `unknown`, whether or not any Claude is unplaced. A
 * live terminal always holds at least a login and a shell, so the tty it
 * reports is stale and what runs in the pane cannot be checked; its screen
 * (blank or an idle prompt) does not close that gap.
 */
export function noProcessTtyKeep(panes: readonly string[]): KeepReason {
  return {
    cause: 'noProcessTty',
    kind: 'unknown',
    text: `unknown: ${panes.join('; ')}. A live terminal always runs at least a shell, so that tty is stale and what runs in the pane cannot be checked`,
  };
}

/**
 * home-base-kwand.27: each pane whose screen was read and is blank keeps its
 * workspace as `unknown`, whatever runs on its tty, whether or not any Claude
 * is unplaced and with or without --close-shared-tty. cmux returns an empty
 * screen for a pane that has not drawn yet (F20), and gatePane passes a blank
 * screen as an idle shell, so a pane whose tty report is stale could hide a
 * Claude that another stale report placed elsewhere.
 */
export function blankScreenKeep(panes: readonly string[]): KeepReason {
  return {
    cause: 'blankScreen',
    kind: 'unknown',
    text: `unknown: ${panes.join('; ')}. cmux shows a blank screen for a tab that has not drawn yet, so a blank screen does not show what runs in the tab`,
  };
}

/** F2: the `unknown` keep of a pane with weak evidence while any Claude is unplaced. */
export function unplacedKeep(
  unplaced: readonly UnplacedClaude[],
  weak: readonly string[],
): KeepReason {
  const pids = [
    ...new Set(unplaced.map((entry) => entry.pid ?? 'unknown')),
  ].join(', ');
  return {
    cause: 'unseenClaude',
    kind: 'unknown',
    text: `unknown: ${unplaced.length === 1 ? '1 live Claude process' : `${unplaced.length} live Claude processes`} could not be placed in any workspace (pid ${pids}), and ${weak.join('; ')}, so one of them could be running here unseen`,
  };
}

// ---------------------------------------------------------------------------
// --keep (K2 g)
// ---------------------------------------------------------------------------

/**
 * Each --keep value as the workspaces it keeps: a workspace uuid or
 * `workspace:N`, a live session id, or a session bead id. A value that
 * matches nothing refuses the run (exit 2): never silently ignored.
 */
export function resolveKeep(input: {
  facts: Extract<SessionFactsRead, {kind: 'read'}>;
  keep: readonly string[];
  live: Extract<LiveSessions, {kind: 'read'}>;
  tree: CmuxTree;
}):
  | {byWorkspace: Map<string, string[]>; kind: 'ok'}
  | {kind: 'refused'; reason: string} {
  const byWorkspace = new Map<string, string[]>();
  const add = (workspaceId: string, given: string): void => {
    const key = workspaceId.toUpperCase();
    byWorkspace.set(key, [...(byWorkspace.get(key) ?? []), given]);
  };
  const workspaces = input.tree.windows.flatMap((window) => window.workspaces);
  for (const given of input.keep) {
    const want = given.trim();
    const upper = want.toUpperCase();
    const lower = want.toLowerCase();
    let matched = false;
    for (const workspace of workspaces) {
      if (
        workspace.id.toUpperCase() === upper ||
        workspace.ref?.toUpperCase() === upper
      ) {
        add(workspace.id, given);
        matched = true;
      }
    }
    const sessionIds = new Set<string>();
    if (input.live.workspacesBySessionId.has(lower)) sessionIds.add(lower);
    for (const facts of input.facts.bySession.values()) {
      if (facts.sessionBeadId?.toLowerCase() === lower) {
        sessionIds.add(facts.sessionId);
      }
    }
    for (const sessionId of sessionIds) {
      for (const workspaceId of input.live.workspacesBySessionId.get(
        sessionId,
      ) ?? []) {
        add(workspaceId, given);
        matched = true;
      }
    }
    if (!matched) {
      return {
        kind: 'refused',
        reason: `--keep ${JSON.stringify(given)} matches nothing open: no workspace has that uuid or workspace:N ref, and no session open in a workspace has that session id or session bead id`,
      };
    }
  }
  return {byWorkspace, kind: 'ok'};
}

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------

/** Every workspace with a pane whose tty another pane (anywhere) also reports. */
export function sharedTtyWorkspaces(
  surfaces: readonly {tty: string | null; workspaceId?: string | null}[],
): Set<string> {
  const counts = new Map<string, number>();
  for (const surface of surfaces) {
    const tty = normalizeTty(surface.tty);
    if (tty != null) counts.set(tty, (counts.get(tty) ?? 0) + 1);
  }
  const out = new Set<string>();
  for (const surface of surfaces) {
    const tty = normalizeTty(surface.tty);
    if (
      tty != null &&
      (counts.get(tty) ?? 0) > 1 &&
      surface.workspaceId != null
    ) {
      out.add(surface.workspaceId.toUpperCase());
    }
  }
  return out;
}

/** cmux's saved session file at planning time: when it was written, how many workspaces. */
export type SessionFileFact =
  | {
      ageMs: number;
      createdAt: string;
      kind: 'read';
      path: string;
      workspaces: number;
    }
  | {kind: 'failed'; path: string; reason: string};

/** What `--all-except` adds to the state: the rules it ran with and the counts. */
export interface AllExceptInfo {
  /** home-base-kwand.21 F1: whether --close-shared-tty was given. */
  closeSharedTty: boolean;
  counts: {
    failed: number;
    kept: number;
    /** K6: kept workspaces by their first kind. */
    keptByKind: Partial<Record<KeepKind, number>>;
    /** Closed, or (dry run) would close. */
    wouldClose: number;
  };
  keep: string[];
  keepActive: string;
  /** cmux's live session file, which the tab record reads (D1). */
  sessionFile: SessionFileFact;
  /** K7: workspaces with a pane on a tty another pane reports, and how many the rule let through. */
  sharedTty: {
    /** Kept for a shared tty after the rule. */
    keptFor: number;
    /** Planned to close although a pane shares its tty (every process on it a shell). */
    passedByRule: number;
    workspaces: number;
  };
  /** The tab record --apply ran first; null in a dry run. */
  tabRecord: string | null;
  /** Workspaces in every cmux window when the plan was made. */
  treeWorkspaces: number;
  /** home-base-kwand.21 F2: live Claude processes placed in no workspace. */
  unplaced: {
    /** Workspaces kept as unknown for them (a pane with weak evidence). */
    keptFor: number;
    /** Sessions named by a source but placed in no workspace. */
    noWorkspace: number;
    pids: (number | null)[];
    /** live.unplaced: Claude processes no source named a session for. */
    unnamed: number;
  };
}
