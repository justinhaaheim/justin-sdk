/**
 * Which cmux calls only read, in one place. The session guard
 * (session-guard.ts, home-base-mbnjv.5) allows these for a session's own Bash
 * calls, and the handoff gate's runner (cmux.ts gateCmuxRunner,
 * home-base-89c8h.1) retries only these, because a timed-out write may still
 * have happened and a retry would do it twice.
 *
 * A module of its own so the guard, which runs on every Bash call, does not
 * load cmux.ts and zod.
 */

/**
 * cmux subcommands that only READ: they print state and change nothing. The
 * test each one passes: it cannot start a process in, type into, move, close
 * or open any pane, tab, workspace or window.
 */
export const CMUX_READ_ONLY_SUBCOMMANDS = [
  'identify',
  'tree',
  'read-screen',
  'read-selection',
  'capture-pane',
  'current-window',
  'current-workspace',
  'ping',
  'version',
  'capabilities',
  'top',
  'memory',
  'surface-health',
  'sidebar-state',
  'browser-status',
  'help',
  'guide',
  'docs',
] as const;

/**
 * Every `list-*` subcommand is read-only too: list-windows, list-workspaces,
 * list-panes, list-pane-surfaces, list-panels, list-notifications,
 * list-status, list-log, list-buffers.
 */
export const CMUX_READ_ONLY_PREFIX = 'list-';

/** Options cmux accepts before the subcommand, each with whether it takes a value. */
export const CMUX_GLOBAL_OPTIONS: ReadonlyMap<string, boolean> = new Map([
  ['--id-format', true],
  ['--json', false],
  ['--password', true],
  ['--socket', true],
]);

/**
 * True only when this argv (the words after the binary) is a call this list
 * knows reads: a read-only subcommand after known global options, or
 * `workspace list`. An option this list does not know makes it false, so the
 * subcommand behind it is never guessed.
 */
export function cmuxCallIsReadOnly(args: readonly string[]): boolean {
  let at = 0;
  for (;;) {
    const word = args[at];
    if (word == null) return false;
    const takesValue = CMUX_GLOBAL_OPTIONS.get(word);
    if (takesValue == null) break;
    at += takesValue ? 2 : 1;
  }
  const sub = args[at] ?? '';
  if (sub.startsWith('-')) return false;
  if (sub === 'workspace') return args[at + 1] === 'list';
  return (
    (CMUX_READ_ONLY_SUBCOMMANDS as readonly string[]).includes(sub) ||
    sub.startsWith(CMUX_READ_ONLY_PREFIX)
  );
}
