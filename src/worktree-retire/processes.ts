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
}

/** Reads every process's open files. Production is `readLsof`; tests inject one. */
export type ProcessReader = () => Measured<ProcessHandle[]>;

/** Parse `lsof -F pcfn` output: `p<pid>`, `c<command>`, then `f<fd>` / `n<name>` pairs. */
export function parseLsofFields(text: string): ProcessHandle[] {
  const handles: ProcessHandle[] = [];
  let pid: number | null = null;
  let command = '';
  let fd = '';
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') {
      pid = /^\d+$/u.test(value) ? Number(value) : null;
      command = '';
      fd = '';
    } else if (tag === 'c') command = value;
    else if (tag === 'f') fd = value;
    else if (tag === 'n' && pid != null) {
      handles.push({command, fd, path: value, pid});
    }
  }
  return handles;
}

/** The real reader. `selfPid`/`selfCwd` are the self-test (see the file comment). */
export function readLsof(
  selfPid: number = process.pid,
  selfCwd: string = process.cwd(),
): Measured<ProcessHandle[]> {
  let stdout: string;
  try {
    stdout = execFileSync('lsof', ['-n', '-P', '-w', '-F', 'pcfn'], {
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
