#!/usr/bin/env bun
/**
 * home-base-kwand.16: every live Claude process that no live cmux tab holds
 * (its tty is reported by no surface, or it has no tty), and what is known
 * about it. PRINTS COUNTS AND FLAGS ONLY: no argv text beyond the flags, no
 * path outside ~/Dev, no session id, title or screen text.
 *
 * Run with the Claude Code sandbox off, from inside cmux:
 * `bun scripts/measure-claude-outside-tabs.ts [--json] [--watch <seconds>]`.
 * `--watch` samples once a second for that long and reports every process
 * seen, once per pid (short-lived ones, such as the hourly `claude -p
 * /usage` chore, are missed by one sample).
 */

import {homedir} from 'node:os';

import {
  printsOnly,
  realCwdReader,
  resumesASession,
} from '../src/thread/before-restart-state';
import {CMUX_TIMEOUT_MS, realCmuxRunner} from '../src/thread/cmux';
import {
  argvSessionId,
  backgroundRole,
  isClaudeBinary,
  isSessionProc,
  readAgents,
  realAgentsRunner,
} from '../src/thread/live-sessions';
import {
  defaultHookStorePath,
  isClaudeProc,
  normalizeTty,
  readHookStore,
  readLiveSurfaces,
  readProcesses,
  realProcessRunner,
} from '../src/thread/pane-join';

const HELP = `measure-claude-outside-tabs: flags and counts for each live Claude process no live cmux tab holds. Read-only. Sandbox off, inside cmux.

  bun scripts/measure-claude-outside-tabs.ts [--json] [--watch <seconds>]

--watch samples once a second for that many seconds and reports each pid once.
`;

function tally(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort());
}

const KNOWN_SUBCOMMANDS = new Set([
  'agents',
  'auth',
  'bg-pty-host',
  'bg-spare',
  'config',
  'daemon',
  'doctor',
  'install',
  'mcp',
  'migrate-installer',
  'plugin',
  'setup-token',
  'update',
]);

/** The first argv word after the executable, kept only when it is a known word. */
function subcommand(exePath: string, command: string): string {
  const first = command.slice(exePath.length).trim().split(/\s+/u)[0] ?? '';
  if (first === '') return '(none)';
  if (first.startsWith('-')) return '(a flag)';
  return KNOWN_SUBCOMMANDS.has(first) ? first : '(another word)';
}

/** etime ([[dd-]hh:]mm:ss) as a coarse bucket. */
function ageBucket(etime: string): string {
  if (etime.includes('-')) return 'a day or more';
  return etime.split(':').length === 3 ? 'hours' : 'under an hour';
}

const PARENT_NAMES = new Set([
  'bash',
  'bun',
  'claude',
  'cmux',
  'launchd',
  'login',
  'node',
  'sh',
  'zsh',
]);

type Row = Record<string, boolean | string>;

/** One sample: each Claude process outside any live tab, by pid. */
async function sample(): Promise<
  | {claude: number; ok: true; rows: Map<number, Row>}
  | {ok: false; reason: string}
> {
  const env = process.env;
  const store = readHookStore(defaultHookStorePath());
  const [procs, surfaces, agents] = await Promise.all([
    readProcesses(realProcessRunner()),
    readLiveSurfaces(realCmuxRunner(CMUX_TIMEOUT_MS, env)),
    readAgents(realAgentsRunner(env)),
  ]);
  if (!procs.ok || !surfaces.ok || !store.ok || !agents.ok) {
    return {
      ok: false,
      reason: `ps ${procs.ok ? 'ok' : procs.reason}; cmux tree ${surfaces.ok ? 'ok' : surfaces.reason}; hook store ${store.ok ? 'ok' : store.reason}; agents ${agents.ok ? 'ok' : agents.reason}`,
    };
  }
  const liveTtys = new Set(
    surfaces.value
      .map((surface) => normalizeTty(surface.tty))
      .filter((tty): tty is string => tty != null),
  );
  const byPid = new Map(procs.value.map((proc) => [proc.pid, proc]));
  const claude = procs.value.filter((proc) => isClaudeBinary(proc));
  const outside = claude.filter((proc) => {
    const tty = normalizeTty(proc.tty);
    return tty == null || !liveTtys.has(tty);
  });
  const storePids = new Set<number>();
  for (const session of Object.values(store.value.sessions ?? {})) {
    if (session.pid != null) storePids.add(session.pid);
  }
  const agentByPid = new Map(
    agents.entries.flatMap((entry) =>
      entry.pid == null ? [] : [[entry.pid, entry] as const],
    ),
  );
  const cwds =
    outside.length === 0
      ? {ok: true as const, value: new Map<number, string>()}
      : await realCwdReader()(outside.map((proc) => proc.pid));
  const dev = `${homedir()}/Dev/`;
  const rows = new Map<number, Row>();
  for (const proc of outside) {
    const parent = byPid.get(proc.ppid);
    const parentName = parent == null ? '(not in ps)' : parent.name;
    const cwd = cwds.ok ? (cwds.value.get(proc.pid) ?? null) : null;
    rows.set(proc.pid, {
      age: ageBucket(proc.etime),
      agentsNamesPid:
        agentByPid.get(proc.pid)?.sessionId != null ||
        agentByPid.get(proc.ppid)?.sessionId != null,
      argvNamesSession: argvSessionId(proc.command) != null,
      // Matched by pane-join's isClaudeProc (…/.local/bin/claude) too, not
      // only by the executable's name.
      byPath: isClaudeProc(proc),
      cwd: !cwds.ok
        ? 'unreadable'
        : cwd == null
          ? 'not listed'
          : cwd.startsWith(dev)
            ? 'under ~/Dev'
            : cwd === homedir()
              ? 'home'
              : 'elsewhere',
      hookStoreNamesPid: storePids.has(proc.pid),
      kind: backgroundRole(proc) ?? (isSessionProc(proc) ? 'session' : 'other'),
      parent: PARENT_NAMES.has(parentName) ? parentName : '(another name)',
      print: printsOnly(proc.command),
      resumeFlag: resumesASession(proc.command),
      subcommand: subcommand(proc.exePath, proc.command),
      tty: normalizeTty(proc.tty) == null ? 'none' : 'unreported',
    });
  }
  return {claude: claude.length, ok: true, rows};
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    process.stdout.write(HELP);
    return 0;
  }
  const json = args.includes('--json');
  const watchAt = args.indexOf('--watch');
  const watchSeconds =
    watchAt === -1 ? 0 : Number.parseInt(args[watchAt + 1] ?? '', 10);
  if (watchAt !== -1 && !(watchSeconds > 0)) {
    process.stderr.write('--watch needs a number of seconds\n');
    return 2;
  }
  const seen = new Map<number, {flags: Row; samples: number}>();
  const failures: string[] = [];
  let samples = 0;
  let maxClaude = 0;
  const until = Date.now() + watchSeconds * 1000;
  do {
    const started = Date.now();
    const read = await sample();
    samples += 1;
    if (!read.ok) {
      failures.push(read.reason);
    } else {
      maxClaude = Math.max(maxClaude, read.claude);
      for (const [pid, row] of read.rows) {
        const known = seen.get(pid);
        seen.set(pid, {
          flags: known?.flags ?? row,
          samples: (known?.samples ?? 0) + 1,
        });
      }
    }
    const wait = 1000 - (Date.now() - started);
    if (Date.now() < until && wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  } while (Date.now() < until);
  const rows = [...seen.values()].map((entry) => ({
    ...entry.flags,
    samples: entry.samples,
  }));
  const keys = [...seen.values()][0]?.flags;
  const report = {
    failedSamples: failures.length,
    firstFailure: failures[0] ?? null,
    maxClaudeProcesses: maxClaude,
    outsideAnyTab: rows.length,
    rows,
    samples,
    tallies: Object.fromEntries(
      Object.keys(keys ?? {}).map((key) => [
        key,
        tally([...seen.values()].map((entry) => String(entry.flags[key]))),
      ]),
    ),
  };
  process.stdout.write(
    `${json ? JSON.stringify(report) : JSON.stringify(report, null, 2)}\n`,
  );
  return 0;
}

process.exit(await main());
