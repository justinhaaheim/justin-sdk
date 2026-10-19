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

/** Stop, wait, close. Returns the failure, or null when the workspace closed. */
export async function stopThenCloseWorkspace(
  procs: readonly ProcessToStop[],
  deps: StopAndCloseDeps,
): Promise<StopAndCloseFailure | null> {
  const stopped = await stopProcesses(procs, deps);
  if (stopped != null) return stopped;
  const closed = await deps.closeWorkspace();
  return closed == null
    ? null
    : {
        reason: `close-workspace failed after Claude exited (the session stays resumable): ${closed}`,
        step: 'close-workspace',
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
