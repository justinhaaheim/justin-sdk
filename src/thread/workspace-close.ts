/**
 * Stop a workspace's Claude processes with SIGTERM, wait for them to exit,
 * and only then close the workspace. ONE IMPLEMENTATION (home-base-yukaf.4):
 * `thread open --undo` (open-undo.ts) and scripts/cmux-arrange-close.ts both
 * call it; it is exported as `@justinhaaheim/justin-sdk/workspace-close`.
 *
 * WHY SIGTERM FIRST: closing a cmux pane keeps its PTY master open, so the
 * processes never get SIGHUP and stay resident (scripts/CLAUDE.md,
 * reap-orphaned-panes, measured 2026-09-05). SIGTERM, never -9, is what keeps
 * the session resumable with `claude --resume`.
 *
 * The order: re-identify every pid (it may have exited, or been reused),
 * run the caller's `beforeSignal` step (cmux-arrange appends its closed.jsonl
 * records there), SIGTERM each, poll every 250 ms until every one has exited
 * or the timeout passes, and only then close the workspace. A pid that cannot
 * be read while polling is NOT known to have exited (critical rule 7).
 */

import type {PinnedTab} from './cmux-session-file';

import {execFile} from 'node:child_process';

/** What a pid runs now (`ps -p <pid> -o command=`), gone, or unreadable. */
export type PidCommand =
  | {command: string; kind: 'running'}
  | {kind: 'failed'; reason: string}
  | {kind: 'gone'};

/** A process to stop: its pid and the command line it was seen running. */
export interface ProcessToStop {
  command: string;
  pid: number;
}

export interface StopAndCloseDeps {
  /**
   * Runs after every pid is re-identified and before the first SIGTERM;
   * returns why it failed (nothing is signalled then), or null.
   */
  beforeSignal?: () => string | null;
  /** Close the workspace: null when closed, else why not. */
  closeWorkspace: () => Promise<string | null>;
  commandOf: (pid: number) => Promise<PidCommand>;
  exitTimeoutMs: number;
  /** SIGTERM, never anything stronger: null when sent, else why not. */
  kill: (pid: number) => string | null;
  nowMs: () => number;
  sleep: (ms: number) => Promise<void>;
}

export type StopAndCloseStep =
  | 'before-signal'
  | 'close-workspace'
  | 'sigterm'
  | 'verify'
  | 'wait-exit';

export interface StopAndCloseFailure {
  reason: string;
  step: StopAndCloseStep;
}

/** stopThenCloseSurface's failure: the stop steps, then `close-surface`. */
export interface StopAndCloseSurfaceFailure {
  reason: string;
  /** stopProcesses never yields 'close-workspace'; its type just allows it. */
  step: StopAndCloseStep | 'close-surface';
}

export const STOP_POLL_MS = 250;

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** What stopProcesses needs: everything but the close. */
export type StopDeps = Omit<StopAndCloseDeps, 'closeWorkspace'> & {
  /** How a refusal ends: what is left as it was. Default "the workspace was left open". */
  leftAs?: string;
};

/**
 * The stop half on its own (home-base-yukaf.22: `thread archive --stop`
 * signals a session's Claude and never closes its workspace): re-identify
 * every pid, the caller's beforeSignal step, SIGTERM each, wait for each to
 * exit. Returns the failure, or null when every process exited.
 */
export async function stopProcesses(
  procs: readonly ProcessToStop[],
  deps: StopDeps,
): Promise<StopAndCloseFailure | null> {
  const leftAs = deps.leftAs ?? 'the workspace was left open';
  for (const proc of procs) {
    const now = await deps.commandOf(proc.pid);
    if (now.kind !== 'running' || now.command !== proc.command) {
      const what =
        now.kind === 'failed'
          ? `could not be read again (${now.reason})`
          : now.kind === 'gone'
            ? 'has exited since the gates read it'
            : `now runs something else (${cut(now.command, 60)})`;
      return {
        reason: `claude pid ${proc.pid} ${what}, so nothing was signalled and ${leftAs}`,
        step: 'verify',
      };
    }
  }
  const before = deps.beforeSignal?.() ?? null;
  if (before != null) {
    return {
      reason: `${before}; nothing was signalled and ${leftAs}`,
      step: 'before-signal',
    };
  }
  for (const proc of procs) {
    const failure = deps.kill(proc.pid);
    if (failure != null) {
      return {
        reason: `SIGTERM to pid ${proc.pid} failed (${failure}); ${leftAs}`,
        step: 'sigterm',
      };
    }
  }
  const deadline = deps.nowMs() + deps.exitTimeoutMs;
  let alive = [...procs];
  for (;;) {
    const still: ProcessToStop[] = [];
    for (const proc of alive) {
      const now = await deps.commandOf(proc.pid);
      // A zombie reports `(claude)`, not its command line: it has exited.
      // A pid that cannot be read is not known to have exited.
      if (
        now.kind === 'failed' ||
        (now.kind === 'running' && now.command === proc.command)
      ) {
        still.push(proc);
      }
    }
    alive = still;
    if (alive.length === 0 || deps.nowMs() >= deadline) break;
    await deps.sleep(STOP_POLL_MS);
  }
  if (alive.length > 0) {
    return {
      reason: `pid ${alive.map((proc) => proc.pid).join(', ')} still running ${Math.round(deps.exitTimeoutMs / 1000)} s after SIGTERM; ${leftAs} (no SIGKILL)`,
      step: 'wait-exit',
    };
  }
  return null;
}

/**
 * home-base-kwand.13: the two refusals cmux gave `close-workspace` on
 * 2026-11-18 (cmux 0.65.2), told apart by cmux's own error code:
 * - `pinned`: "protected: Pinned workspaces can't be closed while pinned.
 *   Unpin the workspace first." The checks predict it from `cmux tree`'s
 *   `pinned`, so a run that sees it here lost a race.
 * - `running-process`: "confirmation_required: Workspace has a running
 *   process; retry with --force" (also "Surface has a running process").
 *   cmux keeps a per-tab shell state (prompt or running) that its shell
 *   integration reports from zsh's precmd/preexec hooks, and no read-only
 *   cmux command shows it, so it cannot be predicted. Nothing here ever
 *   passes --force (Justin's question Q191, which replaced Q181; its
 *   default is never).
 * Used for wording only: no decision is made from the text.
 */
export type CmuxCloseRefusal = 'pinned' | 'running-process';

export function cmuxCloseRefusal(text: string): CmuxCloseRefusal | null {
  if (/\bprotected: Pinned workspaces?\b/u.test(text)) return 'pinned';
  if (/\bconfirmation_required:.*running process/u.test(text)) {
    return 'running-process';
  }
  return null;
}

/**
 * home-base-kwand.13: how a kept reason for a pinned workspace starts, so a
 * caller (thread close --all-except, home-base-kwand.7) can count it.
 */
export const PINNED_REASON = 'pinned';

/**
 * home-base-kwand.20 item 1: why a whole-workspace close is kept for cmux's
 * pinned state, checked BEFORE any Claude is stopped; null only when cmux
 * said "not pinned". Every caller of stopThenCloseWorkspace (thread close,
 * thread open --undo, scripts/cmux-arrange-close.ts) asks it first, on a
 * fresh read: cmux refuses close-workspace on a pinned workspace (measured
 * 2026-11-18, kwand.13). Not knowing is not "unpinned" (critical rule 7):
 * null or undefined keeps.
 *
 * home-base-kwand.28: closing ONE tab of several (close-surface) no longer
 * asks this. cmux's close-surface has no pinned-workspace check (cmux
 * v0.65.2.2 TerminalController+ControlSurfaceContext2.swift, read
 * 2026-11-19); it refuses a pinned TAB instead (pinnedTabKeepWords).
 */
export function pinnedKeepWords(
  pinned: boolean | null | undefined,
): string | null {
  if (pinned === false) return null;
  return pinned === true
    ? `${PINNED_REASON}: cmux refuses to close a pinned workspace ("Pinned workspaces can't be closed while pinned"); unpin it in cmux to close it`
    : `${PINNED_REASON}?: cmux tree did not say whether it is pinned, and cmux refuses to close a pinned workspace`;
}

/**
 * home-base-kwand.28: why closing ONE tab (close-surface) is kept for a
 * pinned tab, before its Claude is stopped; null only when cmux's session
 * file says the tab is not pinned. cmux refuses a normal close of a pinned
 * tab (cmux v0.65.2.2 Workspace.swift, pinnedPanelIds), so stopping its
 * Claude first would leave the tab open with no Claude in it.
 */
export function pinnedTabKeepWords(tab: PinnedTab): string | null {
  switch (tab.kind) {
    case 'notPinned':
      return null;
    case 'pinned':
      return `${PINNED_REASON} tab: cmux refuses to close a pinned tab; unpin it in cmux`;
    case 'unknown':
      return `${PINNED_REASON}?: whether this tab is pinned is not known (${tab.reason}), and cmux refuses to close a pinned tab`;
  }
}

/**
 * What a cmux refusal means, in plain words, or null for any other failure.
 * `scope` is what was being closed: a whole workspace or one tab.
 *
 * home-base-ruaep D2 (b): the running-process words say only what is known.
 * Why cmux counts the tab as running is not verified (a lost shell report is
 * inferred), and no remedy but closing it by hand in cmux has been tried, so
 * neither goes in tool output. --force is Justin's question Q191.
 */
export function cmuxCloseRefusalWords(
  text: string,
  scope: 'tab' | 'workspace',
): string | null {
  switch (cmuxCloseRefusal(text)) {
    case 'pinned':
      return 'cmux refuses to close a pinned workspace; unpin it in cmux first';
    case 'running-process':
      return scope === 'workspace'
        ? 'cmux counts a tab in this workspace as running a command, so it refused to close the workspace. thread close never overrides cmux: it never passes --force (question Q191 asks whether it should). Close the workspace in cmux by hand'
        : 'cmux counts this tab as running a command, so it refused to close it. thread close never overrides cmux: it never passes --force (question Q191 asks whether it should). Close the tab in cmux by hand';
    case null:
      return null;
  }
}

/** Stop, wait, close. Returns the failure, or null when the workspace closed. */
export async function stopThenCloseWorkspace(
  procs: readonly ProcessToStop[],
  deps: StopAndCloseDeps,
): Promise<StopAndCloseFailure | null> {
  const stopped = await stopProcesses(procs, deps);
  if (stopped != null) return stopped;
  const closed = await deps.closeWorkspace();
  if (closed == null) return null;
  const plain = cmuxCloseRefusalWords(closed, 'workspace');
  const because = `${closed}${plain == null ? '' : ` (${plain})`}`;
  // home-base-kwand.13 fix 3: a refusal after the stop leaves the workspace
  // open with its Claude stopped; say so, never as a quiet "failed".
  return {
    reason:
      procs.length === 0
        ? `close-workspace failed, and no Claude ran there, so nothing was stopped: ${because}`
        : `close-workspace failed AFTER Claude was stopped, so the workspace is still open with no Claude running in it; resume the session with its resume command: ${because}`,
    step: 'close-workspace',
  };
}

/**
 * Stop, wait, close ONE TAB (home-base-v8z8d.2.1, `thread close --tab`): the
 * same stop half, then the caller's close of that one cmux surface. The
 * workspace and its other tabs are never touched here.
 */
export async function stopThenCloseSurface(
  procs: readonly ProcessToStop[],
  deps: StopDeps & {
    /** Close the one surface: null when closed, else why not. */
    closeSurface: () => Promise<string | null>;
  },
): Promise<StopAndCloseSurfaceFailure | null> {
  const stopped = await stopProcesses(procs, {
    ...deps,
    leftAs: deps.leftAs ?? 'the tab was left open',
  });
  if (stopped != null) return stopped;
  const closed = await deps.closeSurface();
  if (closed == null) return null;
  const plain = cmuxCloseRefusalWords(closed, 'tab');
  const because = `${closed}${plain == null ? '' : ` (${plain})`}`;
  return {
    reason:
      procs.length === 0
        ? `close-surface failed, and no Claude ran there, so nothing was stopped: ${because}`
        : `close-surface failed AFTER Claude was stopped, so the tab is still open with no Claude running in it; resume the session with its resume command: ${because}`,
    step: 'close-surface',
  };
}

/** The real `ps -p <pid> -o command=`: running, gone, or unreadable (never guessed). */
export function realPidCommand(pid: number): Promise<PidCommand> {
  return new Promise((resolve) => {
    try {
      execFile(
        'ps',
        ['-p', String(pid), '-o', 'command='],
        {timeout: 4000},
        (error, stdout, stderr) => {
          const text = String(stdout).trim();
          if (error == null) {
            resolve(
              text === '' ? {kind: 'gone'} : {command: text, kind: 'running'},
            );
            return;
          }
          // ps exits 1 with no output when no such process exists.
          if ((error as {code?: unknown}).code === 1 && text === '') {
            resolve({kind: 'gone'});
            return;
          }
          const detail = String(stderr).trim();
          resolve({
            kind: 'failed',
            reason: `ps -p ${pid} failed: ${detail !== '' ? detail : error.message}`,
          });
        },
      );
    } catch (error) {
      resolve({
        kind: 'failed',
        reason: `ps -p ${pid} could not start: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });
}

/** The real SIGTERM (never anything stronger): null when sent, else why not. */
export function realSigterm(pid: number): string | null {
  try {
    process.kill(pid, 'SIGTERM');
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
