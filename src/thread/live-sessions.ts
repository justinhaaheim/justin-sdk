/**
 * Which Claude sessions have a live process right now (home-base-yukaf.1,
 * decision D-UNFINISHED of epic home-base-yukaf). `thread open` reopens a
 * session only when NO source finds a live process for it: `claude --resume`
 * against a session that is already running has not been measured, so it is
 * never risked.
 *
 * THREE SOURCES, all built on pane-join.ts's readers (one implementation of
 * reading ps, the hook store and the cmux tree; scripts/cmux-arrange.ts and
 * scripts/cmux-restore-state.ts read the same things through it):
 *
 * - ps: a claude SESSION process (pane-join's `isClaudeProc`, minus the
 *   non-session subcommands such as `claude daemon` and `claude agents`)
 *   whose argv carries `--resume <id>`, `-r <id>` or `--session-id <id>`.
 *   Measured 2026-10-18: cmux starts most panes as `claude --session-id <id>`.
 * - hookStore: a session in the cmux hook store's `sessions` map (never
 *   `activeSessionsByWorkspace`, which collapses a workspace to one session)
 *   whose recorded pid is a live claude session process.
 * - screen: the `⌗ <uuid>` that Justin's status line shows below the input
 *   box of EVERY cmux surface with a claude session process on its tty. Every
 *   one is read, not only the ones the other sources missed: after a /clear
 *   the argv id is the old session, and the screen shows the new one.
 *
 * - agents (home-base-yukaf.14 F17): `claude agents --json`, the registry
 *   Claude Code itself keeps of active sessions, interactive and background.
 *   An entry counts only while its pid is a live claude process. This is the
 *   only source that sees a BACKGROUND session (`claude --bg`): its processes
 *   run as `claude bg-pty-host …` (the terminal host) and `claude bg-spare
 *   --bg-spare <sock>` (the session itself, once claimed) with a bare
 *   `claude` argv0, no session id on the command line, and a tty no cmux
 *   surface owns (measured 2026-10-18: the claimed worker held ttys082 and
 *   `claude agents --json` named its session by the bg-spare pid; the
 *   always-present unclaimed spare had no tty and no entry).
 *
 * A claude process is any process whose executable is named `claude`, at any
 * path (F17): `~/.local/bin/claude`, a bare `claude`, another install.
 *
 * Every id any source finds is live. That over-counts (the old id of a
 * cleared session reads as live too), which only ever keeps a session closed.
 *
 * UNPLACED: a claude session process none of the sources names a session
 * for, either in a cmux pane (its screen could not be read, was empty, or
 * showed no id), outside cmux, or a background worker holding a terminal
 * that the agents registry does not name. `thread open` refuses to open
 * anything while one exists, unless --force-unplaced: that process may hold
 * one of the sessions it would open. An unclaimed spare (a background worker
 * with no terminal and no registry entry) holds no session and is ignored.
 *
 * CRITICAL RULE 7. When ps, the hook store, the cmux tree or the agents
 * registry cannot be read, the result is `{kind: 'failed'}`, never an empty
 * map: an empty map means "read, and nothing is running".
 */

import type {CmuxRunner} from './cmux';
import type {
  HookStore,
  LiveSurface,
  Proc,
  ProcessRunner,
  ScreenRead,
} from './pane-join';
import type {EnvLike} from './paths';

import {execFile} from 'node:child_process';
import {homedir} from 'node:os';
import {z} from 'zod';

import {CMUX_TIMEOUT_MS, realCmuxRunner} from './cmux';
import {
  defaultHookStorePath,
  normalizeTty,
  paneFailureReason,
  readHookStore,
  readLiveSurfaces,
  readProcesses,
  readScreen,
  realProcessRunner,
  SCREEN_CONCURRENCY,
  statusLineIdOf,
} from './pane-join';

/** Which source found a session live (the first one, when several did). */
export type LiveSource = 'agents' | 'hookStore' | 'ps' | 'screen';

export interface LiveSession {
  pid: number | null;
  source: LiveSource;
  /** The cmux surface it runs in, when the tree places its tty; else null. */
  surfaceId: string | null;
  workspaceId: string | null;
}

/** A claude session process that no source could name a session for. */
export interface UnplacedLive {
  /** Why no session id could be read for it. */
  detail: string;
  /**
   * `pane`: on a cmux surface. `process`: on no surface cmux knows.
   * `background`: a `claude --bg` worker holding a terminal (F17).
   */
  kind: 'background' | 'pane' | 'process';
  pid: number | null;
  surfaceId: string | null;
  surfaceRef: string | null;
  tty: string | null;
  workspaceId: string | null;
}

export type LiveSessions =
  | {
      bySessionId: Map<string, LiveSession>;
      kind: 'read';
      unplaced: UnplacedLive[];
      /** Every workspace uuid any source placed each session in (see the join). */
      workspacesBySessionId: Map<string, string[]>;
    }
  | {kind: 'failed'; reason: string};

/**
 * `claude <subcommand>` processes that are not an interactive session
 * (measured 2026-10-18: `claude daemon run …` with no tty, `claude agents
 * --cwd .` in a pane). Anything else, a prompt included, is a session.
 */
const NON_SESSION_SUBCOMMANDS = new Set([
  'agents',
  'auth',
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

/**
 * A process whose executable is named `claude`, at any path (F17). pane-join's
 * `isClaudeProc` matches only `…/.local/bin/claude`, which misses a bare
 * `claude` argv0 (every background worker) and other installs. The match is
 * on the executable's own name, exactly: the desktop app's `Claude` and
 * `Claude Helper` are not Claude Code.
 */
export function isClaudeBinary(proc: Proc): boolean {
  return proc.name === 'claude';
}

/**
 * home-base-yukaf.25 G8: the first claude process up the parent chain from
 * `pid` (not `pid` itself), in one ps snapshot: the Claude Code process whose
 * Bash tool ran this command. `none` names where the walk stopped: `pid` or
 * an ancestor missing from the snapshot, a loop, or the chain reaching
 * launchd with no claude process on it.
 */
export function claudeAncestor(
  procs: readonly Proc[],
  pid: number,
): {kind: 'found'; proc: Proc} | {kind: 'none'; reason: string} {
  const byPid = new Map(procs.map((proc) => [proc.pid, proc]));
  const start = byPid.get(pid);
  if (start == null) {
    return {kind: 'none', reason: `this command (pid ${pid}) is not in ps`};
  }
  const seen = new Set<number>([pid]);
  let next = start.ppid;
  while (next > 1) {
    if (seen.has(next)) {
      return {kind: 'none', reason: `ps shows a parent loop at pid ${next}`};
    }
    seen.add(next);
    const proc = byPid.get(next);
    if (proc == null) {
      return {
        kind: 'none',
        reason: `pid ${next}, a parent of this command, is not in ps`,
      };
    }
    if (isClaudeBinary(proc)) return {kind: 'found', proc};
    next = proc.ppid;
  }
  return {
    kind: 'none',
    reason: 'no claude process is a parent of this command',
  };
}

/** The first word after the executable: `bg-spare`, `daemon`, `--settings`, … */
function subcommandOf(proc: Proc): string {
  const rest = proc.command.slice(proc.exePath.length).trim();
  return rest.split(/\s+/u)[0] ?? '';
}

/**
 * The two processes of a background session (`claude --bg`), measured
 * 2026-10-18: `claude bg-pty-host …` hosts the terminal; its child `claude
 * bg-spare --bg-spare <sock>` is the session once the daemon claims it.
 */
export function backgroundRole(proc: Proc): 'host' | 'worker' | null {
  if (!isClaudeBinary(proc)) return null;
  const first = subcommandOf(proc);
  if (first === 'bg-pty-host') return 'host';
  if (first === 'bg-spare') return 'worker';
  return null;
}

/**
 * A claude process that is an interactive session: not daemon, agents, …,
 * and not a background worker, which joinLiveSessions places through the
 * agents registry instead.
 */
export function isSessionProc(proc: Proc): boolean {
  if (!isClaudeBinary(proc)) return false;
  if (backgroundRole(proc) != null) return false;
  return !NON_SESSION_SUBCOMMANDS.has(subcommandOf(proc));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** One active session as `claude agents --json` lists it. */
export interface AgentEntry {
  /** `interactive` or `background` (measured); null when absent. */
  kind: string | null;
  pid: number | null;
  /** Lowercased; null when absent or not a uuid. */
  sessionId: string | null;
}

const AGENTS_JSON = z.array(
  z.looseObject({
    kind: z.string().nullish(),
    pid: z.number().int().nullish(),
    sessionId: z.string().nullish(),
  }),
);

/** `claude agents --json` stdout → its entries, or why it could not be parsed. */
export function parseAgentsJson(
  stdout: string,
): {entries: AgentEntry[]; ok: true} | {ok: false; reason: string} {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout) as unknown;
  } catch (error) {
    return {
      ok: false,
      reason: `claude agents --json printed something that is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const parsed = AGENTS_JSON.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `claude agents --json printed JSON of an unknown shape: ${parsed.error.issues[0]?.message ?? 'no detail'}`,
    };
  }
  return {
    entries: parsed.data.map((entry) => ({
      kind: entry.kind ?? null,
      pid: entry.pid ?? null,
      sessionId:
        entry.sessionId != null && UUID.test(entry.sessionId)
          ? entry.sessionId.toLowerCase()
          : null,
    })),
    ok: true,
  };
}

/** Runs `claude agents --json`. Injected so tests fake it. */
export type AgentsRunner = () => Promise<
  {kind: 'failed'; reason: string} | {kind: 'ok'; stdout: string}
>;

export const AGENTS_ARGS = ['agents', '--json'] as const;

/** The real `claude agents --json` (measured 2026-10-18: 0.2 s, 101 entries). */
export function realAgentsRunner(
  env: EnvLike,
  timeoutMs: number = CMUX_TIMEOUT_MS,
): AgentsRunner {
  return () =>
    new Promise((resolve) => {
      try {
        execFile(
          'claude',
          [...AGENTS_ARGS],
          {
            env: env as NodeJS.ProcessEnv,
            maxBuffer: 32 * 1024 * 1024,
            timeout: timeoutMs,
          },
          (error, stdout, stderr) => {
            if (error != null) {
              const detail = String(stderr).trim();
              resolve({
                kind: 'failed',
                reason: `claude ${AGENTS_ARGS.join(' ')} failed: ${detail !== '' ? detail.split('\n')[0] : error.message}`,
              });
              return;
            }
            resolve({kind: 'ok', stdout: String(stdout)});
          },
        );
      } catch (error) {
        resolve({
          kind: 'failed',
          reason: `claude ${AGENTS_ARGS.join(' ')} could not start: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    });
}

/** Read the agents registry: its entries, or why it could not be read. */
export async function readAgents(
  run: AgentsRunner,
): Promise<{entries: AgentEntry[]; ok: true} | {ok: false; reason: string}> {
  let call: Awaited<ReturnType<AgentsRunner>>;
  try {
    call = await run();
  } catch (error) {
    return {
      ok: false,
      reason: `claude agents --json could not run: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (call.kind === 'failed') return {ok: false, reason: call.reason};
  return parseAgentsJson(call.stdout);
}

const ARGV_SESSION_ID =
  /(?:^|\s)(?:--resume|-r|--session-id)(?:=|\s+)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=\s|$)/iu;

/** The session id on a claude command line (`--resume`, `-r`, `--session-id`), lowercased. */
export function argvSessionId(command: string): string | null {
  return ARGV_SESSION_ID.exec(command)?.[1]?.toLowerCase() ?? null;
}

/**
 * Whether a claude process names `sessionId` on its command line right now:
 * the cheap re-check `thread open` runs right before each new workspace
 * (home-base-yukaf.14 F21), so a session another run (or Justin) resumed
 * after the plan was made is not opened twice.
 */
export type LateLiveCheck = (
  sessionId: string,
) => Promise<
  | {kind: 'failed'; reason: string}
  | {kind: 'live'; pid: number}
  | {kind: 'notLive'}
>;

/** The real re-check: one `ps` per call. */
export function realLateLiveCheck(
  ps: ProcessRunner = realProcessRunner(),
): LateLiveCheck {
  return async (sessionId) => {
    const procs = await readProcesses(ps);
    if (!procs.ok) return {kind: 'failed', reason: procs.reason};
    const want = sessionId.toLowerCase();
    const proc = procs.value.find(
      (entry) => isSessionProc(entry) && argvSessionId(entry.command) === want,
    );
    return proc == null ? {kind: 'notLive'} : {kind: 'live', pid: proc.pid};
  };
}

/** Why a screen gave no session id, in words for the "Cannot tell" list. */
function noIdDetail(screen: ScreenRead | undefined): string {
  if (screen == null) return 'its screen was not read';
  if (screen.kind === 'unreadable') {
    return `its screen could not be read: ${paneFailureReason('cmux read-screen', screen.reason)}`;
  }
  if (screen.text.trim() === '') {
    return 'cmux returned an empty screen (a pane that has not drawn yet)';
  }
  return 'its screen shows no "⌗ <session id>" below a Claude input box';
}

/**
 * The join, pure: every session id the sources find live, and every claude
 * session process none of them names. `screens` is keyed by surface ref and
 * holds a read for each surface with a session process on its tty.
 *
 * `agents` is the `claude agents --json` registry, or null when it was not
 * read (drafts-scan's pane fallback, which needs only ps and the hook store).
 * With null, every background worker holding a terminal is unplaced: nothing
 * could say which session it runs.
 */
export function joinLiveSessions(input: {
  agents: readonly AgentEntry[] | null;
  procs: readonly Proc[];
  screens: ReadonlyMap<string, ScreenRead>;
  store: HookStore;
  surfaces: readonly LiveSurface[];
}): {
  bySessionId: Map<string, LiveSession>;
  unplaced: UnplacedLive[];
  /**
   * home-base-yukaf.31: every distinct workspace uuid (uppercase) a source
   * placed each session in. bySessionId keeps the first placement only, so a
   * session seen in two workspaces (resumed twice, or an argv id one pane
   * shares with another pane's screen) is told apart here: `thread close
   * --session` refuses it rather than pick one.
   */
  workspacesBySessionId: Map<string, string[]>;
} {
  const sessionProcs = input.procs.filter((proc) => isSessionProc(proc));
  const procByPid = new Map(sessionProcs.map((proc) => [proc.pid, proc]));
  const claudeByPid = new Map(
    input.procs
      .filter((proc) => isClaudeBinary(proc))
      .map((proc) => [proc.pid, proc]),
  );
  // F22 (home-base-yukaf.14): a tty two surfaces report (a dead or
  // hibernated surface keeps reporting a tty a newer pane has since been
  // given) belongs to neither: its processes are placed on no surface, so no
  // caller files a session or a draft under the wrong pane.
  const surfacesByTty = new Map<string, LiveSurface[]>();
  for (const surface of input.surfaces) {
    const tty = normalizeTty(surface.tty);
    if (tty == null) continue;
    surfacesByTty.set(tty, [...(surfacesByTty.get(tty) ?? []), surface]);
  }
  const sharedTtys = new Set(
    [...surfacesByTty.entries()]
      .filter(([, list]) => list.length > 1)
      .map(([tty]) => tty),
  );
  const surfaceOf = (proc: Proc): LiveSurface | null => {
    const tty = normalizeTty(proc.tty);
    if (tty == null || sharedTtys.has(tty)) return null;
    return surfacesByTty.get(tty)?.[0] ?? null;
  };

  const bySessionId = new Map<string, LiveSession>();
  const workspacesBySessionId = new Map<string, string[]>();
  const pidsNamed = new Set<number>();
  const add = (sessionId: string, found: LiveSession): void => {
    const key = sessionId.toLowerCase();
    if (found.workspaceId != null) {
      const seen = workspacesBySessionId.get(key) ?? [];
      const workspace = found.workspaceId.toUpperCase();
      if (!seen.includes(workspace)) {
        workspacesBySessionId.set(key, [...seen, workspace]);
      }
    }
    const known = bySessionId.get(key);
    if (known == null) {
      bySessionId.set(key, found);
      return;
    }
    // The first source stays; a later one only fills what it lacked.
    bySessionId.set(key, {
      pid: known.pid ?? found.pid,
      source: known.source,
      surfaceId: known.surfaceId ?? found.surfaceId,
      workspaceId: known.workspaceId ?? found.workspaceId,
    });
  };

  for (const proc of sessionProcs) {
    const id = argvSessionId(proc.command);
    if (id == null) continue;
    const surface = surfaceOf(proc);
    pidsNamed.add(proc.pid);
    add(id, {
      pid: proc.pid,
      source: 'ps',
      surfaceId: surface?.id ?? null,
      workspaceId: surface?.workspaceId ?? null,
    });
  }

  for (const [key, stored] of Object.entries(input.store.sessions ?? {})) {
    const pid = stored.pid ?? null;
    const proc = pid == null ? undefined : procByPid.get(pid);
    // The store is accumulative: only a pid a claude session still holds counts.
    if (proc == null) continue;
    const surface = surfaceOf(proc);
    pidsNamed.add(proc.pid);
    add(stored.sessionId ?? key, {
      pid: proc.pid,
      source: 'hookStore',
      surfaceId: surface?.id ?? null,
      workspaceId: surface?.workspaceId ?? null,
    });
  }

  // The agents registry: an entry counts only while a claude process holds
  // its pid (like the hook store, an entry outliving its process is no
  // evidence). A background worker's entry names the bg-spare pid (measured);
  // the host pid is matched too, below.
  const agentByPid = new Map<number, AgentEntry>();
  for (const entry of input.agents ?? []) {
    if (entry.pid == null) continue;
    agentByPid.set(entry.pid, entry);
    const proc = claudeByPid.get(entry.pid);
    if (proc == null || entry.sessionId == null) continue;
    const surface = surfaceOf(proc);
    pidsNamed.add(proc.pid);
    add(entry.sessionId, {
      pid: proc.pid,
      source: 'agents',
      surfaceId: surface?.id ?? null,
      workspaceId: surface?.workspaceId ?? null,
    });
  }

  const unplaced: UnplacedLive[] = [];

  // Background workers (F17). Named by the registry (its pid or its host's)
  // → live, above. Else: one holding a terminal may be running a session
  // nothing names, so it is unplaced; one with no terminal and no entry is
  // the daemon's unclaimed spare and holds no session.
  for (const proc of claudeByPid.values()) {
    if (backgroundRole(proc) !== 'worker') continue;
    if (pidsNamed.has(proc.pid) || pidsNamed.has(proc.ppid)) continue;
    const tty = normalizeTty(proc.tty);
    const entry = agentByPid.get(proc.pid) ?? agentByPid.get(proc.ppid);
    let detail: string | null = null;
    if (input.agents == null) {
      if (tty != null) {
        detail =
          'a background Claude worker (claude --bg) holding a terminal; the agents registry was not read, so its session is unknown';
      }
    } else if (entry != null) {
      detail =
        'a background Claude worker (claude --bg) that claude agents --json lists with no session id';
    } else if (tty != null) {
      detail =
        'a background Claude worker (claude --bg) holding a terminal that claude agents --json does not list, so it may be running a session';
    }
    if (detail == null) continue;
    unplaced.push({
      detail,
      kind: 'background',
      pid: proc.pid,
      surfaceId: null,
      surfaceRef: null,
      tty,
      workspaceId: null,
    });
  }

  const procsBySurface = new Map<string, Proc[]>();
  for (const proc of sessionProcs) {
    const surface = surfaceOf(proc);
    if (surface == null) {
      const tty = normalizeTty(proc.tty);
      const shared = tty != null && sharedTtys.has(tty);
      if (!pidsNamed.has(proc.pid)) {
        unplaced.push({
          detail: shared
            ? `a claude process on tty ${tty}, which ${surfacesByTty.get(tty)?.length ?? 2} cmux surfaces report, so which pane holds it is unknown (F22)`
            : 'a claude process on no cmux surface, with no session id on its command line or in the hook store',
          kind: shared ? 'pane' : 'process',
          pid: proc.pid,
          surfaceId: null,
          surfaceRef: null,
          tty,
          workspaceId: null,
        });
      }
      continue;
    }
    procsBySurface.set(surface.ref, [
      ...(procsBySurface.get(surface.ref) ?? []),
      proc,
    ]);
  }
  for (const surface of input.surfaces) {
    const procs = procsBySurface.get(surface.ref);
    if (procs == null) continue;
    const screen = input.screens.get(surface.ref);
    const shown =
      screen?.kind === 'read' && screen.text.trim() !== ''
        ? statusLineIdOf(screen.text)
        : null;
    if (shown != null) {
      add(shown, {
        pid: procs[0]?.pid ?? null,
        source: 'screen',
        surfaceId: surface.id ?? null,
        workspaceId: surface.workspaceId ?? null,
      });
      continue;
    }
    if (procs.some((proc) => pidsNamed.has(proc.pid))) continue;
    unplaced.push({
      detail: noIdDetail(screen),
      kind: 'pane',
      pid: procs[0]?.pid ?? null,
      surfaceId: surface.id ?? null,
      surfaceRef: surface.ref,
      tty: normalizeTty(surface.tty),
      workspaceId: surface.workspaceId ?? null,
    });
  }
  // A shared tty's screens still count for liveness (an id shown there is
  // kept live, which only ever keeps a session closed), with no pid: which
  // surface the process belongs to is unknown.
  const sessionTtys = new Set(
    sessionProcs
      .map((proc) => normalizeTty(proc.tty))
      .filter((tty): tty is string => tty != null),
  );
  for (const tty of sharedTtys) {
    if (!sessionTtys.has(tty)) continue;
    for (const surface of surfacesByTty.get(tty) ?? []) {
      const screen = input.screens.get(surface.ref);
      const shown =
        screen?.kind === 'read' && screen.text.trim() !== ''
          ? statusLineIdOf(screen.text)
          : null;
      if (shown == null) continue;
      add(shown, {
        pid: null,
        source: 'screen',
        surfaceId: surface.id ?? null,
        workspaceId: surface.workspaceId ?? null,
      });
    }
  }
  return {bySessionId, unplaced, workspacesBySessionId};
}

/** What `readLiveSessions` reads; every source is injectable for tests. */
export interface LiveSessionDeps {
  agents: AgentsRunner;
  cmux: CmuxRunner;
  hookStorePath: string;
  ps: ProcessRunner;
}

/** The real sources: cmux through ./cmux's runner, ps, the hook store, `claude agents --json`. */
export function realLiveSessionDeps(env: EnvLike): LiveSessionDeps {
  const home = env.HOME;
  return {
    agents: realAgentsRunner(env),
    cmux: realCmuxRunner(CMUX_TIMEOUT_MS, env),
    hookStorePath: defaultHookStorePath(
      home != null && home !== '' ? home : homedir(),
    ),
    ps: realProcessRunner(),
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
 * Read the sources, then join them. ps, the hook store, the cmux tree or the
 * agents registry unreadable → `failed`, naming every source that failed. A
 * single screen that cannot be read is not a failure: its pane is unplaced,
 * unless another source named its session.
 */
export async function readLiveSessions(
  deps: LiveSessionDeps,
): Promise<LiveSessions> {
  const store = readHookStore(deps.hookStorePath);
  const [procs, surfaces, agents] = await Promise.all([
    readProcesses(deps.ps),
    readLiveSurfaces(deps.cmux),
    readAgents(deps.agents),
  ]);
  const failures: string[] = [];
  if (!store.ok) failures.push(paneFailureReason('hook store', store.reason));
  if (!procs.ok) failures.push(paneFailureReason('ps', procs.reason));
  if (!surfaces.ok) {
    failures.push(paneFailureReason('cmux tree', surfaces.reason));
  }
  if (!agents.ok) {
    failures.push(paneFailureReason('claude agents --json', agents.reason));
  }
  if (!store.ok || !procs.ok || !surfaces.ok || !agents.ok) {
    return {kind: 'failed', reason: failures.join('; ')};
  }
  const sessionTtys = new Set(
    procs.value
      .filter((proc) => isSessionProc(proc))
      .map((proc) => normalizeTty(proc.tty))
      .filter((tty): tty is string => tty != null),
  );
  const claudeSurfaces = surfaces.value.filter((surface) => {
    const tty = normalizeTty(surface.tty);
    return tty != null && sessionTtys.has(tty);
  });
  const reads = await mapLimited(
    claudeSurfaces,
    SCREEN_CONCURRENCY,
    async (surface) => await readScreen(deps.cmux, surface.ref),
  );
  const screens = new Map<string, ScreenRead>();
  for (const [index, surface] of claudeSurfaces.entries()) {
    const read = reads[index];
    if (read != null) screens.set(surface.ref, read);
  }
  return {
    kind: 'read',
    ...joinLiveSessions({
      agents: agents.entries,
      procs: procs.value,
      screens,
      store: store.value,
      surfaces: surfaces.value,
    }),
  };
}
