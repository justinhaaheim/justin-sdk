/**
 * Which processes are using a worktree (home-base-rub4v.1.1, evidence item 5).
 *
 * ONE `lsof -n -P -w -F pcfn` lists every open file of every process, cwd
 * included (fd `cwd`), in about a second (measured 2026-10-29: 1,487
 * processes, 111,707 lines, exit 0, no stderr). A process is "inside" a
 * worktree when its cwd or any open file is the worktree or below it. The
 * 2026-10-29 inventory found long-lived Claude processes holding files under
 * `.claude/.cc-writes` in two worktrees whose cwd was elsewhere, which is why
 * open files count, not only cwds.
 *
 * FAILURE IS NOT "NO PROCESS" (critical rules §7). A non-zero exit, a parse
 * that finds no process, or a listing that does not include THIS process's own
 * cwd is a failed check, never an empty list: a listing that cannot see us
 * cannot be trusted to see anyone else.
 */

import type {Measured} from '../worktree-salvage/status';

import {execFileSync} from 'child_process';

/** One open file (or cwd) of one process, as lsof names it. */
export interface ProcessHandle {
  command: string;
  /** lsof's fd column: `cwd`, `txt`, a number with a mode letter, … */
  fd: string;
  path: string;
  pid: number;
  /** The parent pid (lsof's `R` field), when lsof gave one. */
  ppid?: number;
}

/** Reads every process's open files. Production is `readLsof`; tests inject one. */
export type ProcessReader = () => Measured<ProcessHandle[]>;

/** Parse `lsof -F pcfn` output: `p<pid>`, `c<command>`, then `f<fd>` / `n<name>` pairs. */
export function parseLsofFields(text: string): ProcessHandle[] {
  const handles: ProcessHandle[] = [];
  let pid: number | null = null;
  let ppid: number | null = null;
  let command = '';
  let fd = '';
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') {
      pid = /^\d+$/u.test(value) ? Number(value) : null;
      ppid = null;
      command = '';
      fd = '';
    } else if (tag === 'R') ppid = /^\d+$/u.test(value) ? Number(value) : null;
    else if (tag === 'c') command = value;
    else if (tag === 'f') fd = value;
    else if (tag === 'n' && pid != null) {
      handles.push({
        command,
        fd,
        path: value,
        pid,
        ...(ppid === null ? {} : {ppid}),
      });
    }
  }
  return handles;
}

/**
 * Null when the listing shows a process outside this process's own tree, or
 * why it cannot be trusted (home-base-pp1vx.1.1.5 F5). Measured 2026-11-21:
 * inside the Claude Code sandbox lsof lists only the sandboxed command's own
 * processes (zsh, bun, lsof: 3 of them, the parent included), and pid 1 is
 * never listed for a non-root user (outside the sandbox: 963 processes, no
 * pid 1). So seeing ourselves, or our parent, proves nothing. This walks up
 * from `selfPid` to the highest ancestor the listing holds and requires a
 * listed process that is not that ancestor or below it. A listing that holds
 * pid 1 (run as root) passes: no sandbox shows pid 1.
 *
 * At least MIN_FOREIGN_PROCESSES of them (home-base-pp1vx.1.1.9 R4): a daemon
 * the sandboxed command itself started and that reparented to pid 1 (git gc
 * --auto, git maintenance --detach after a merge, an fsmonitor daemon) is
 * outside the tree too, and one or two of those prove nothing. Outside the
 * sandbox a user session lists hundreds. This only adds refusals.
 */
export const MIN_FOREIGN_PROCESSES = 10;

export function foreignProcessCheck(
  handles: readonly ProcessHandle[],
  selfPid: number,
): string | null {
  const parent = new Map<number, number | undefined>();
  for (const h of handles) {
    if (!parent.has(h.pid) || h.ppid !== undefined) parent.set(h.pid, h.ppid);
  }
  if (parent.has(1)) return null;
  if (parent.get(selfPid) === undefined) {
    return `\`lsof\` gave no parent pid for this process (pid ${selfPid}), so it cannot tell this process's own tree from the rest`;
  }
  let top = selfPid;
  const seen = new Set<number>([selfPid]);
  for (;;) {
    const up = parent.get(top);
    if (up === undefined || !parent.has(up) || seen.has(up)) break;
    seen.add(up);
    top = up;
  }
  const inTree = (pid: number): boolean => {
    const path = new Set<number>();
    let cur: number | undefined = pid;
    while (cur !== undefined && !path.has(cur)) {
      if (cur === top) return true;
      path.add(cur);
      cur = parent.get(cur);
    }
    return false;
  };
  const foreign = [...parent.keys()].filter((pid) => !inTree(pid));
  return foreign.length >= MIN_FOREIGN_PROCESSES
    ? null
    : `\`lsof\` listed only this process's own tree (${parent.size - foreign.length} processes under pid ${top}) and ${foreign.length} other process(es), fewer than ${MIN_FOREIGN_PROCESSES}, as it does inside a sandbox, so its listing cannot be trusted to show other processes`;
}

/** The real reader. `selfPid`/`selfCwd` are the self-test (see the file comment). */
export function readLsof(
  selfPid: number = process.pid,
  selfCwd: string = process.cwd(),
): Measured<ProcessHandle[]> {
  let stdout: string;
  try {
    stdout = execFileSync('lsof', ['-n', '-P', '-w', '-F', 'pcfnR'], {
      encoding: 'utf-8',
      maxBuffer: 512 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {error: `\`lsof\` failed: ${message}`, ok: false};
  }
  const handles = parseLsofFields(stdout);
  if (handles.length === 0) {
    return {error: '`lsof` listed no open files at all', ok: false};
  }
  const seesSelf = handles.some(
    (handle) =>
      handle.pid === selfPid && handle.fd === 'cwd' && handle.path === selfCwd,
  );
  if (!seesSelf) {
    return {
      error: `\`lsof\` did not list this process's own cwd (pid ${selfPid}, ${selfCwd}), so its listing cannot be trusted to show other processes`,
      ok: false,
    };
  }
  const blind = foreignProcessCheck(handles, selfPid);
  if (blind !== null) return {error: blind, ok: false};
  return {ok: true, value: handles};
}

/** True when `path` is `root` or below it. */
export function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/** One line per process using `root`: `pid 123 (claude): cwd` or `…: open <path>`. */
export function processesInside(
  handles: readonly ProcessHandle[],
  root: string,
): string[] {
  const byPid = new Map<number, {command: string; uses: string[]}>();
  for (const handle of handles) {
    if (!isInside(handle.path, root)) continue;
    const entry = byPid.get(handle.pid) ?? {command: handle.command, uses: []};
    const relative =
      handle.path === root ? '.' : handle.path.slice(root.length + 1);
    entry.uses.push(handle.fd === 'cwd' ? 'cwd' : `open ${relative}`);
    byPid.set(handle.pid, entry);
  }
  return [...byPid.entries()]
    .sort(([a], [b]) => a - b)
    .map(([pid, entry]) => {
      const uses = [...new Set(entry.uses)].sort();
      const shown =
        uses.length > 3
          ? [...uses.slice(0, 3), `${uses.length - 3} more`]
          : uses;
      return `pid ${pid} (${entry.command}): ${shown.join(', ')}`;
    });
}
