/**
 * A deadline that settles a child-process call even when the child's exit is
 * never reported (home-base-iprgd).
 *
 * Every async runner `thread inbox` uses already had a kill timer: execFile's
 * `timeout`, or a setTimeout that calls `kill`. A kill timer ends a child that
 * is still running, and the runner then settles on the exit that child
 * reports. It does nothing when the exit itself is never reported: the child
 * is already gone, so the callback that would settle the call never runs, and
 * whoever awaits it waits forever.
 *
 * That is not hypothetical. Bun issue #45483 (open on 2026-11-18; Bun 1.3.14
 * to 1.4.4, macOS) measured `'exit'` and `'close'` emitted while `spawn()` is
 * still on the stack, before any listener is attached, inside `bun test` under
 * load; execFile's callback is then never called. home-base-5frxo measured the
 * same on this machine's Bun 1.4.2: 2 in 7000 execFile calls of `true` never
 * called back. Both reporters of #45483 saw none in a plain `bun` process, so
 * this deadline is a backstop for the CLI, not a fix for a measured hang there.
 *
 * `settleByDeadline` is the second half of the deadline a runner already has:
 * `EXIT_GRACE_MS` after its kill was due, a call that has still not settled
 * settles as failed, with its program named by the caller (critical rule 7:
 * never as empty output). Its child is sent SIGKILL first, but only when the
 * child has not been reported exited (conductor review, 2026-11-18).
 */

/**
 * How long after its kill was due a call may still settle on its own. A killed
 * child reports its exit at once; 5 s is the margin the cmux runner already
 * gives the CLI's own limit (cmux.ts, D2).
 */
export const EXIT_GRACE_MS = 5_000;

/**
 * What `settleByDeadline` may signal when the deadline passes. A ChildProcess
 * fits: `exitCode` and `signalCode` are both null until its exit is reported.
 */
export interface DeadlineChild {
  /** Non-null once the child's exit was reported with a code. */
  exitCode?: number | null;
  kill: (signal?: NodeJS.Signals | number) => boolean | void;
  /** Non-null once the child's exit was reported with a signal. */
  signalCode?: null | string;
}

/**
 * Has the child been reported exited, as far as its own object knows? Then
 * its pid may already be reaped and reused by an unrelated process, which is
 * exactly Bun #45483's case, so no signal may be sent to it.
 */
function reportedExited(child: DeadlineChild): boolean {
  return child.exitCode != null || child.signalCode != null;
}

export interface SettleByDeadlineInput<T> {
  /**
   * Ms after the start at which a call that has not settled is given up.
   * Null: no deadline, the call settles only when `start` says so.
   */
  deadlineMs: number | null;
  /** The failed outcome when the deadline passes. */
  late: () => T;
  /**
   * Start the child and call `settle` with its outcome from its exit, close
   * or error callback, or at once when it could not start. Returns the child,
   * or null when none started. Calls after the first are ignored.
   */
  start: (settle: (outcome: T) => void) => DeadlineChild | null | undefined;
}

/**
 * Run `start`, and settle with `late()` if it has not settled by `deadlineMs`.
 * The timer is cleared the moment the call settles, and it is NOT unref'd:
 * when the exit is lost, it is the one thing that still keeps the process
 * alive long enough to report the failure, rather than ending with the call
 * unsettled and nothing printed.
 */
export function settleByDeadline<T>(
  input: SettleByDeadlineInput<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let child: DeadlineChild | null = null;
    const settle = (outcome: T): void => {
      if (settled) return;
      settled = true;
      if (timer != null) clearTimeout(timer);
      resolve(outcome);
    };
    if (input.deadlineMs != null) {
      timer = setTimeout(() => {
        if (settled) return;
        // SIGKILL only a child not reported exited: a reaped pid can belong
        // to another process by now, and a kill must never reach one.
        if (child != null && !reportedExited(child)) {
          try {
            child.kill('SIGKILL');
          } catch {
            // Already gone; the call is given up either way.
          }
        }
        settle(input.late());
      }, input.deadlineMs);
    }
    try {
      child = input.start(settle) ?? null;
    } catch (error) {
      if (timer != null) clearTimeout(timer);
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function seconds(ms: number): string {
  return String(Math.round(ms / 100) / 10);
}

/**
 * The failure text for a call the deadline gave up: `<what> gave no exit
 * within 35 s (it was to be stopped at 30 s)`. `what` names the program and
 * its arguments, as the runner's other failures do.
 */
export function noExitReason(
  what: string,
  deadlineMs: number,
  killAtMs: number | null,
): string {
  const kill =
    killAtMs == null ? '' : ` (it was to be stopped at ${seconds(killAtMs)} s)`;
  return `${what} gave no exit within ${seconds(deadlineMs)} s${kill}, so it counts as failed`;
}
