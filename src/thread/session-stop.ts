/**
 * `thread archive --stop` and `thread done --stop` (home-base-yukaf.22 item
 * 8, hardened by home-base-yukaf.25 G4, G5, G8, G9). Justin, 2026-10-19: "I'm
 * inclined to have it send the SIGTERM to the claude process as well."
 *
 * After the mark is written and printed, the session's live Claude process
 * is found and a DETACHED child sends it SIGTERM a few seconds later, so the
 * command's own output reaches the terminal (and the Claude turn that ran it)
 * first. The cmux workspace is never closed: the pane stays, and `claude
 * --resume <id>` brings the session back.
 *
 * WHICH PROCESS, in the safe direction only:
 *   - Another session's process: a claude session process whose command line
 *     NAMES this session (`--resume`, `-r` or `--session-id` with this id).
 *   - This session's own process (G8: the slash command runs inside the
 *     session it archives, and most sessions start as a bare `claude`, with
 *     no id on argv): when the session is CLAUDE_CODE_SESSION_ID, the first
 *     claude process up the parent chain from this command. It must be an
 *     interactive session process, not a background worker.
 *   - G4: either way, a pid that the cmux hook store or `claude agents
 *     --json` maps to a DIFFERENT session id is dropped (after /clear or
 *     /resume Y, `claude --resume X` holds Y while argv still names X), and
 *     reported with the command to stop it by hand.
 *   - A process only the hook store names, whose command line does not, is
 *     reported, never signalled.
 *   - The child re-checks right before the signal, through the shared helper
 *     (workspace-close.ts stopProcesses): the pid must still run exactly the
 *     command line seen here, so a pid reused in the delay is never hit.
 *   - SIGTERM only, never SIGKILL; the child appends `about-to-signal` BEFORE
 *     the signal (G9) and the outcome after it to `<threads state
 *     dir>/session-stops.jsonl`, since nobody watches the child's output.
 *
 * DELAY: 3 s for another session; 15 s for this session's own process (G8),
 * so the agent's one-line reply lands first.
 *
 * Rule 7: "no live process", "a process that is not signalled, and why",
 * "the hook store or the agents registry could not be read" (G5: a process
 * that does not name the session may still hold it, so nothing is stopped),
 * and "ps could not be read" are different outcomes, each said.
 *
 * UNVERIFIED (no live run is allowed in the push that built it): whether the
 * detached child survives the Bash tool that ran the command, and whether
 * the agent's last reply lands before the SIGTERM. The first real
 * /thread-archive measures it.
 */

import type {AgentsRunner} from './live-sessions';
import type {HookStore, Proc, ProcessRunner} from './pane-join';
import type {EnvLike} from './paths';
import type {ProcessToStop, StopDeps} from './workspace-close';

import {spawn} from 'node:child_process';
import {appendFileSync, mkdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  argvSessionId,
  claudeAncestor,
  isSessionProc,
  readAgents,
  realAgentsRunner,
} from './live-sessions';
import {
  defaultHookStorePath,
  readHookStore,
  readProcesses,
  realProcessRunner,
} from './pane-join';
import {threadsStateDir} from './paths';
import {zshWord} from './respawn';
import {realPidCommand, realSigterm, stopProcesses} from './workspace-close';

/** The delay before the SIGTERM to another session's process. */
export const STOP_DELAY_SECONDS = 3;

/** G8: the delay when the process is the one running this command. */
export const SELF_STOP_DELAY_SECONDS = 15;

/** How long the child waits for the process to exit, for its log line. */
export const STOP_EXIT_TIMEOUT_MS = 15_000;

/** The detached child's entry file (this package's own build, never a PATH lookup). */
export const STOP_LATER_PATH = fileURLToPath(
  new URL('./stop-later.ts', import.meta.url),
);

/** What the child is told: exactly which processes, as seen here. */
export interface StopLaterPayload {
  delayMs: number;
  logPath: string;
  procs: ProcessToStop[];
  /**
   * G8: the pid found up the parent chain of the command (this session's own
   * process), whose command line need not name the session; null otherwise.
   */
  selfPid: number | null;
  sessionId: string;
}

/** A claude process that holds (or may hold) the session but is not signalled. */
export interface NotStopped {
  command: string;
  pid: number;
  /** Why, in words, completing "pid N is not signalled: …". */
  reason: string;
}

export type StopOutcome =
  | {kind: 'failed'; reason: string}
  | {kind: 'noProcess'; selfNote: string | null}
  | {kind: 'notStopped'; notStopped: NotStopped[]; selfNote: string | null}
  | {
      delaySeconds: number;
      kind: 'scheduled';
      /** Candidates that were dropped, each with why. */
      notStopped: NotStopped[];
      procs: ProcessToStop[];
      /** G8: the target is the process running this command. */
      self: boolean;
    }
  | {kind: 'unchecked'; reason: string};

export interface ScheduleStopDeps {
  agents: AgentsRunner;
  hookStorePath: string;
  logPath: string;
  ps: ProcessRunner;
  /**
   * G8: this command's pid and the session it runs in
   * (CLAUDE_CODE_SESSION_ID); sessionId null outside a Claude session.
   */
  self: {pid: number; sessionId: string | null};
  /** Start the detached child: null when started, else why not. */
  spawnChild: (payload: StopLaterPayload) => string | null;
}

export function stopLogPath(env: EnvLike): string {
  return join(threadsStateDir(env), 'session-stops.jsonl');
}

/** The real child: `bun stop-later.ts <payload json>`, detached, stdio ignored, unref'd. */
export function spawnStopLater(
  payload: StopLaterPayload,
  env: EnvLike,
): string | null {
  try {
    const child = spawn(
      process.execPath,
      [STOP_LATER_PATH, JSON.stringify(payload)],
      {detached: true, env, stdio: 'ignore'},
    );
    // An async spawn failure must not crash the command after the mark.
    child.on('error', () => undefined);
    child.unref();
    return child.pid == null ? 'the stop child has no pid' : null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function realScheduleStopDeps(env: EnvLike): ScheduleStopDeps {
  const home = env.HOME != null && env.HOME !== '' ? env.HOME : homedir();
  const own = env.CLAUDE_CODE_SESSION_ID?.trim() ?? '';
  return {
    agents: realAgentsRunner(env),
    hookStorePath: defaultHookStorePath(home),
    logPath: stopLogPath(env),
    ps: realProcessRunner(),
    self: {pid: process.pid, sessionId: own === '' ? null : own},
    spawnChild: (payload) => spawnStopLater(payload, env),
  };
}

/** Every session id each pid is mapped to, and by which source (G4). */
function sessionsByPid(
  store: HookStore,
  agents: readonly {pid: number | null; sessionId: string | null}[],
): Map<number, Map<string, Set<string>>> {
  const map = new Map<number, Map<string, Set<string>>>();
  const add = (pid: number, id: string, source: string): void => {
    const ids = map.get(pid) ?? new Map<string, Set<string>>();
    const sources = ids.get(id) ?? new Set<string>();
    sources.add(source);
    ids.set(id, sources);
    map.set(pid, ids);
  };
  for (const [key, entry] of Object.entries(store.sessions ?? {})) {
    if (entry.pid == null) continue;
    add(
      entry.pid,
      (entry.sessionId ?? key).toLowerCase(),
      'the cmux hook store',
    );
  }
  for (const entry of agents) {
    if (entry.pid == null || entry.sessionId == null) continue;
    add(entry.pid, entry.sessionId, 'claude agents --json');
  }
  return map;
}

/**
 * Find this session's Claude process and start the delayed, verified
 * SIGTERM. Nothing is signalled here.
 */
export async function scheduleSessionStop(
  sessionId: string,
  deps: ScheduleStopDeps,
): Promise<StopOutcome> {
  const want = sessionId.toLowerCase();
  const procs = await readProcesses(deps.ps);
  if (!procs.ok) {
    return {
      kind: 'failed',
      reason: `ps could not be read, so the Claude process was not found and nothing is stopped: ${procs.reason}`,
    };
  }
  // G4/G5: both maps of pid → session are needed to rule out a process that
  // holds another session now. Unreadable is never "maps to nothing".
  const store = readHookStore(deps.hookStorePath);
  const agents = await readAgents(deps.agents);
  const unread = [
    ...(store.ok
      ? []
      : [`the cmux hook store could not be read (${store.reason})`]),
    ...(agents.ok
      ? []
      : [`claude agents --json could not be read (${agents.reason})`]),
  ];
  if (!store.ok || !agents.ok) {
    return {
      kind: 'unchecked',
      reason: `${unread.join('; ')}: a process that does not name this session on its command line may still hold it, and no process could be checked for holding another session, so nothing is stopped`,
    };
  }
  const mapped = sessionsByPid(store.value, agents.entries);

  // The candidates: every session process naming the session on argv, and
  // (G8) this command's own Claude process when the session is this one.
  const candidates = new Map<number, {proc: Proc; self: boolean}>();
  for (const proc of procs.value) {
    if (isSessionProc(proc) && argvSessionId(proc.command) === want) {
      candidates.set(proc.pid, {proc, self: false});
    }
  }
  const notStopped: NotStopped[] = [];
  let selfNote: string | null = null;
  if (deps.self.sessionId?.toLowerCase() === want) {
    const found = claudeAncestor(procs.value, deps.self.pid);
    if (found.kind === 'none') {
      selfNote = `This command runs as session ${want}, but its own Claude process was not found: ${found.reason}.`;
    } else if (!isSessionProc(found.proc)) {
      notStopped.push({
        command: found.proc.command,
        pid: found.proc.pid,
        reason:
          'it is the Claude process running this command, but not an interactive session (a background worker or a claude subcommand), so it is not signalled',
      });
    } else {
      candidates.set(found.proc.pid, {proc: found.proc, self: true});
    }
  }

  const targets: {proc: Proc; self: boolean}[] = [];
  for (const candidate of candidates.values()) {
    const ids =
      mapped.get(candidate.proc.pid) ?? new Map<string, Set<string>>();
    const others = [...ids].filter(([id]) => id !== want);
    if (others.length > 0) {
      const named = others
        .map(([id, sources]) => `${id} (${[...sources].join(' and ')})`)
        .join(', ');
      notStopped.push({
        command: candidate.proc.command,
        pid: candidate.proc.pid,
        reason: `it is mapped to another session, ${named}, so after a /clear or /resume it may be running that session now, and it is not signalled`,
      });
      continue;
    }
    targets.push(candidate);
  }

  if (targets.length === 0) {
    if (notStopped.length > 0) {
      return {kind: 'notStopped', notStopped, selfNote};
    }
    // The hook store may know a pid for it; it is reported, never signalled.
    const pid = Object.entries(store.value.sessions ?? {}).find(
      ([key, entry]) =>
        key.toLowerCase() === want || entry.sessionId?.toLowerCase() === want,
    )?.[1].pid;
    const proc =
      pid == null
        ? undefined
        : procs.value.find(
            (entry) => entry.pid === pid && isSessionProc(entry),
          );
    return proc == null
      ? {kind: 'noProcess', selfNote}
      : {
          kind: 'notStopped',
          notStopped: [
            {
              command: proc.command,
              pid: proc.pid,
              reason:
                'the cmux hook store says it holds this session, but its command line does not name the session, so it is not signalled',
            },
          ],
          selfNote,
        };
  }

  const self = targets.some((target) => target.self);
  const delaySeconds = self ? SELF_STOP_DELAY_SECONDS : STOP_DELAY_SECONDS;
  const toStop = targets.map((target) => ({
    command: target.proc.command,
    pid: target.proc.pid,
  }));
  const payload: StopLaterPayload = {
    delayMs: delaySeconds * 1000,
    logPath: deps.logPath,
    procs: toStop,
    selfPid: targets.find((target) => target.self)?.proc.pid ?? null,
    sessionId: want,
  };
  const failure = deps.spawnChild(payload);
  if (failure != null) {
    return {
      kind: 'failed',
      reason: `the delayed stop could not be started, so nothing is stopped: ${failure}`,
    };
  }
  return {delaySeconds, kind: 'scheduled', notStopped, procs: toStop, self};
}

function pidWords(procs: readonly ProcessToStop[]): string {
  return procs.length === 1
    ? `pid ${procs[0]?.pid ?? '?'}`
    : `pids ${procs.map((proc) => proc.pid).join(', ')}`;
}

function notStoppedLines(entries: readonly NotStopped[]): string[] {
  return entries.map(
    (entry) =>
      `Not stopped: pid ${entry.pid}: ${entry.reason}. Stop it by hand if you are sure: kill -TERM ${entry.pid}`,
  );
}

/** The lines `--stop` prints after the mark; exit 1 only when it could not look or start. */
export function describeStop(
  outcome: StopOutcome,
  sessionId: string,
): {exitCode: 0 | 1; lines: string[]} {
  const resume = `claude --resume ${zshWord(sessionId)}`;
  switch (outcome.kind) {
    case 'scheduled':
      return {
        exitCode: 0,
        lines: [
          outcome.self
            ? `This session ends in about ${outcome.delaySeconds} seconds (${pidWords(outcome.procs)}, the Claude process running this command); its pane stays, resume with ${resume}`
            : `This session's Claude process stops in ${outcome.delaySeconds} s (${pidWords(outcome.procs)}); its pane stays, resume with ${resume}`,
          ...notStoppedLines(outcome.notStopped),
        ],
      };
    case 'noProcess':
      return {
        exitCode: 0,
        lines: [
          `No live Claude process holds this session, so nothing is stopped (resume it any time with ${resume}).`,
          ...(outcome.selfNote == null ? [] : [outcome.selfNote]),
        ],
      };
    case 'notStopped':
      return {
        exitCode: 0,
        lines: [
          ...notStoppedLines(outcome.notStopped),
          ...(outcome.selfNote == null ? [] : [outcome.selfNote]),
        ],
      };
    case 'unchecked':
      return {exitCode: 1, lines: [`⚠️ Not stopped: ${outcome.reason}.`]};
    case 'failed':
      return {exitCode: 1, lines: [`⚠️ Not stopped: ${outcome.reason}`]};
  }
}

// ---------------------------------------------------------------------------
// The detached child (stop-later.ts runs this)
// ---------------------------------------------------------------------------

export interface StopLaterDeps extends StopDeps {
  /** Append one JSON line to the stop log; never throws. */
  log: (line: Record<string, unknown>) => void;
}

/** The child's work: wait, re-check every target, log, SIGTERM, wait for exit, log. */
export async function runStopLater(
  payload: StopLaterPayload,
  deps: StopLaterDeps,
): Promise<'failed' | 'refused' | 'stopped'> {
  await deps.sleep(payload.delayMs);
  const want = payload.sessionId.toLowerCase();
  // Belt and braces: every target names the session on its command line,
  // except the one the parent found up its own parent chain (G8).
  const foreign = payload.procs.filter(
    (proc) =>
      proc.pid !== payload.selfPid && argvSessionId(proc.command) !== want,
  );
  if (foreign.length > 0) {
    deps.log({
      at: new Date(deps.nowMs()).toISOString(),
      outcome: 'refused',
      reason: `pid ${foreign.map((proc) => proc.pid).join(', ')} does not name session ${payload.sessionId} on its command line`,
      sessionId: payload.sessionId,
    });
    return 'refused';
  }
  const failure = await stopProcesses(payload.procs, {
    ...deps,
    // G9: written before the signal, so a child killed in the wait still
    // leaves a line saying the signal was about to go out.
    beforeSignal: () => {
      deps.log({
        at: new Date(deps.nowMs()).toISOString(),
        outcome: 'about-to-signal',
        pids: payload.procs.map((proc) => proc.pid),
        sessionId: payload.sessionId,
      });
      return null;
    },
    leftAs: 'the session was left running',
  });
  deps.log({
    at: new Date(deps.nowMs()).toISOString(),
    outcome: failure == null ? 'stopped' : 'failed',
    pids: payload.procs.map((proc) => proc.pid),
    reason: failure?.reason ?? null,
    sessionId: payload.sessionId,
    step: failure?.step ?? null,
  });
  if (failure == null) return 'stopped';
  return failure.step === 'verify' ? 'refused' : 'failed';
}

/** The real child dependencies. */
export function realStopLaterDeps(logPath: string): StopLaterDeps {
  return {
    commandOf: realPidCommand,
    exitTimeoutMs: STOP_EXIT_TIMEOUT_MS,
    kill: realSigterm,
    log: (line) => {
      try {
        mkdirSync(join(logPath, '..'), {recursive: true});
        appendFileSync(logPath, `${JSON.stringify(line)}\n`);
      } catch {
        // Nowhere left to say it: the child's stdio is ignored on purpose.
      }
    },
    nowMs: () => Date.now(),
    sleep: async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    },
  };
}
