/**
 * `thread archive --stop` / `thread done --stop` (home-base-yukaf.22 item 8,
 * home-base-yukaf.25 G4, G5, G8, G9, G10). Everything is a fake: the process
 * table, the hook store, the agents registry, the child spawner, the clock,
 * the SIGTERM. Nothing real is ever signalled.
 */

import type {AgentsRunner} from '../src/thread/live-sessions';
import type {Proc} from '../src/thread/pane-join';
import type {CloseSessionOutcome} from '../src/thread/session-marks';
import type {
  ScheduleStopDeps,
  StopLaterDeps,
  StopLaterPayload,
} from '../src/thread/session-stop';
import type {PidCommand} from '../src/thread/workspace-close';

import {afterEach, describe, expect, test} from 'bun:test';
import {mkdtempSync, rmSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {claudeAncestor} from '../src/thread/live-sessions';
import {parseProcessList} from '../src/thread/pane-join';
import {runSessionClose, stopAfterMark} from '../src/thread/session-marks';
import {
  describeStop,
  runStopLater,
  scheduleSessionStop,
  SELF_STOP_DELAY_SECONDS,
  STOP_DELAY_SECONDS,
} from '../src/thread/session-stop';
import {main, stopLaterPayloadSchema} from '../src/thread/stop-later';

const SID = 'abcdef01-1111-4222-8333-000000000001';
const OTHER = 'abcdef01-1111-4222-8333-000000000002';
const CLAUDE = '/Users/jhaa/.local/bin/claude';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, {force: true, recursive: true});
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'session-stop-'));
  dirs.push(dir);
  return dir;
}

interface FakeProc {
  command: string;
  pid: number;
  /** Default 1 (launchd). */
  ppid?: number;
}

function psText(procs: readonly FakeProc[]): string {
  const lines = ['  PID  PPID TTY      ELAPSED COMMAND'];
  for (const proc of procs) {
    lines.push(
      `${proc.pid} ${proc.ppid ?? 1} ttys00${proc.pid % 10} 01:00 ${proc.command}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/** `ps -Ao pid,ppid,tty,etime,command` output for these processes. */
function psOf(
  procs: readonly FakeProc[],
): () => Promise<{kind: 'ok'; stdout: string}> {
  return () => Promise.resolve({kind: 'ok', stdout: psText(procs)});
}

function hookStore(sessions: Record<string, {pid: number}>): string {
  const path = join(tempDir(), 'claude-hook-sessions.json');
  writeFileSync(
    path,
    JSON.stringify({
      sessions: Object.fromEntries(
        Object.entries(sessions).map(([id, entry]) => [
          id,
          {...entry, sessionId: id},
        ]),
      ),
    }),
  );
  return path;
}

/** `claude agents --json` answering these entries. */
function agentsOf(entries: {pid: number; sessionId: string}[]): AgentsRunner {
  return () =>
    Promise.resolve({
      kind: 'ok',
      stdout: JSON.stringify(
        entries.map((entry) => ({...entry, kind: 'interactive'})),
      ),
    });
}

function deps(
  over: Partial<ScheduleStopDeps> & {spawned?: StopLaterPayload[]} = {},
): ScheduleStopDeps {
  const spawned = over.spawned ?? [];
  return {
    agents: agentsOf([]),
    hookStorePath: hookStore({}),
    logPath: '/tmp/x/session-stops.jsonl',
    ps: psOf([]),
    // Outside any Claude session unless a test says otherwise.
    self: {pid: 9999, sessionId: null},
    spawnChild: (payload) => {
      spawned.push(payload);
      return null;
    },
    ...over,
  };
}

describe('finding the process (scheduleSessionStop)', () => {
  test('only a process whose command line names the session is a target; the child gets it with the delay; nothing is signalled here', async () => {
    const spawned: StopLaterPayload[] = [];
    const outcome = await scheduleSessionStop(
      SID,
      deps({
        hookStorePath: hookStore({[SID]: {pid: 101}}),
        ps: psOf([
          {command: `${CLAUDE} --resume ${SID}`, pid: 101},
          {command: `${CLAUDE} --resume ${OTHER}`, pid: 102},
          {command: `${CLAUDE} --settings {}`, pid: 103},
        ]),
        spawned,
      }),
    );
    expect(outcome).toEqual({
      delaySeconds: STOP_DELAY_SECONDS,
      kind: 'scheduled',
      notStopped: [],
      procs: [{command: `${CLAUDE} --resume ${SID}`, pid: 101}],
      self: false,
    });
    expect(spawned).toEqual([
      {
        delayMs: 3000,
        logPath: '/tmp/x/session-stops.jsonl',
        procs: [{command: `${CLAUDE} --resume ${SID}`, pid: 101}],
        selfPid: null,
        sessionId: SID,
      },
    ]);
    expect(describeStop(outcome, SID).lines[0]).toBe(
      `This session's Claude process stops in 3 s (pid 101); its pane stays, resume with claude --resume ${SID}`,
    );
  });

  test('a process the hook store names but whose command line does not: never a target, said with the manual command', async () => {
    const spawned: StopLaterPayload[] = [];
    const outcome = await scheduleSessionStop(
      SID,
      deps({
        hookStorePath: hookStore({[SID]: {pid: 103}}),
        ps: psOf([{command: `${CLAUDE} --settings {}`, pid: 103}]),
        spawned,
      }),
    );
    expect(outcome).toMatchObject({
      kind: 'notStopped',
      notStopped: [{pid: 103}],
    });
    expect(spawned).toEqual([]);
    const said = describeStop(outcome, SID);
    expect(said.exitCode).toBe(0);
    expect(said.lines[0]).toContain('not signalled');
    expect(said.lines[0]).toContain('kill -TERM 103');
  });

  test('no live process: said, exit 0; ps unreadable: a different line, exit 1; neither starts a child', async () => {
    const spawned: StopLaterPayload[] = [];
    const none = await scheduleSessionStop(
      SID,
      deps({
        ps: psOf([{command: `${CLAUDE} --resume ${OTHER}`, pid: 102}]),
        spawned,
      }),
    );
    expect(none).toEqual({kind: 'noProcess', selfNote: null});
    expect(describeStop(none, SID)).toMatchObject({exitCode: 0});
    expect(describeStop(none, SID).lines[0]).toContain(
      'No live Claude process holds this session',
    );
    const failed = await scheduleSessionStop(
      SID,
      deps({
        ps: () => Promise.resolve({kind: 'failed', reason: 'EPERM'}),
        spawned,
      }),
    );
    expect(failed.kind).toBe('failed');
    expect(describeStop(failed, SID).exitCode).toBe(1);
    expect(spawned).toEqual([]);
  });

  test('G4: a process whose argv names the session but that the hook store or claude agents maps to another session is dropped, said, never signalled', async () => {
    for (const where of ['hookStore', 'agents'] as const) {
      const spawned: StopLaterPayload[] = [];
      const outcome = await scheduleSessionStop(
        SID,
        deps({
          // Started as `--resume SID`, then /clear: it holds OTHER now.
          agents:
            where === 'agents'
              ? agentsOf([{pid: 101, sessionId: OTHER}])
              : agentsOf([]),
          hookStorePath: hookStore(
            where === 'hookStore' ? {[OTHER]: {pid: 101}} : {},
          ),
          ps: psOf([{command: `${CLAUDE} --resume ${SID}`, pid: 101}]),
          spawned,
        }),
      );
      expect(spawned).toEqual([]);
      expect(outcome.kind).toBe('notStopped');
      const said = describeStop(outcome, SID);
      expect(said.exitCode).toBe(0);
      expect(said.lines[0]).toContain(
        `Not stopped: pid 101: it is mapped to another session, ${OTHER} (${where === 'agents' ? 'claude agents --json' : 'the cmux hook store'})`,
      );
      expect(said.lines[0]).toContain('kill -TERM 101');
    }
  });

  test('G4: of two processes naming the session, only the one mapped to no other session is scheduled; the other is listed', async () => {
    const spawned: StopLaterPayload[] = [];
    const outcome = await scheduleSessionStop(
      SID,
      deps({
        hookStorePath: hookStore({[OTHER]: {pid: 102}, [SID]: {pid: 101}}),
        ps: psOf([
          {command: `${CLAUDE} --resume ${SID}`, pid: 101},
          {command: `${CLAUDE} -r ${SID}`, pid: 102},
        ]),
        spawned,
      }),
    );
    expect(spawned[0]?.procs.map((proc) => proc.pid)).toEqual([101]);
    const said = describeStop(outcome, SID);
    expect(said.lines[0]).toContain('stops in 3 s (pid 101)');
    expect(said.lines[1]).toContain('Not stopped: pid 102');
  });

  test('G5: an unreadable hook store or agents registry is its own outcome, exit 1, and nothing is stopped even for a named process', async () => {
    const spawned: StopLaterPayload[] = [];
    const named = psOf([{command: `${CLAUDE} --resume ${SID}`, pid: 101}]);
    const noStore = await scheduleSessionStop(
      SID,
      deps({hookStorePath: join(tempDir(), 'absent.json'), ps: named, spawned}),
    );
    expect(noStore.kind).toBe('unchecked');
    const said = describeStop(noStore, SID);
    expect(said.exitCode).toBe(1);
    expect(said.lines[0]).toContain('the cmux hook store could not be read');
    expect(said.lines[0]).toContain(
      'a process that does not name this session on its command line may still hold it',
    );
    expect(said.lines[0]).not.toContain('No live Claude process');
    const noAgents = await scheduleSessionStop(
      SID,
      deps({
        agents: () => Promise.resolve({kind: 'failed', reason: 'EPERM'}),
        ps: named,
        spawned,
      }),
    );
    expect(describeStop(noAgents, SID).exitCode).toBe(1);
    expect(describeStop(noAgents, SID).lines[0]).toContain(
      'claude agents --json could not be read (EPERM)',
    );
    expect(spawned).toEqual([]);
  });
});

describe('G8: the session this command runs in (CLAUDE_CODE_SESSION_ID)', () => {
  /** claude (bare, no id) → zsh → bun: this command is pid 700. */
  const chain = (claude = 'claude'): FakeProc[] => [
    {command: claude, pid: 500, ppid: 400},
    {
      command: '/bin/zsh -c bun run justin-sdk thread archive',
      pid: 600,
      ppid: 500,
    },
    {
      command: '/Users/jhaa/.bun/bin/bun justin-sdk thread archive',
      pid: 700,
      ppid: 600,
    },
    {command: '/usr/bin/login -pf jhaa', pid: 400, ppid: 1},
  ];

  test('a bare `claude` up the parent chain is the target, 15 s later, and the line says this session ends in about 15 seconds', async () => {
    const spawned: StopLaterPayload[] = [];
    const outcome = await scheduleSessionStop(
      SID,
      deps({
        ps: psOf(chain()),
        self: {pid: 700, sessionId: SID.toUpperCase()},
        spawned,
      }),
    );
    expect(outcome).toMatchObject({
      delaySeconds: SELF_STOP_DELAY_SECONDS,
      kind: 'scheduled',
      procs: [{command: 'claude', pid: 500}],
      self: true,
    });
    expect(spawned[0]).toMatchObject({delayMs: 15_000, selfPid: 500});
    expect(describeStop(outcome, SID).lines[0]).toBe(
      `This session ends in about 15 seconds (pid 500, the Claude process running this command); its pane stays, resume with claude --resume ${SID}`,
    );
  });

  test('the walk stops at the first claude binary, and the hook store or agents mapping that pid to another session still refuses', async () => {
    const spawned: StopLaterPayload[] = [];
    const outcome = await scheduleSessionStop(
      SID,
      deps({
        hookStorePath: hookStore({[OTHER]: {pid: 500}}),
        ps: psOf(chain()),
        self: {pid: 700, sessionId: SID},
        spawned,
      }),
    );
    expect(spawned).toEqual([]);
    expect(describeStop(outcome, SID).lines[0]).toContain(
      `Not stopped: pid 500: it is mapped to another session, ${OTHER}`,
    );
  });

  test('a background worker above the command is not signalled; no claude above it is said; another session never walks the chain', async () => {
    const bg = await scheduleSessionStop(
      SID,
      deps({
        ps: psOf(chain(`${CLAUDE} bg-spare --bg-spare /tmp/s.sock`)),
        self: {pid: 700, sessionId: SID},
      }),
    );
    expect(describeStop(bg, SID).lines[0]).toContain(
      'not an interactive session',
    );

    const noClaude = await scheduleSessionStop(
      SID,
      deps({
        ps: psOf(chain('/bin/zsh -l')),
        self: {pid: 700, sessionId: SID},
      }),
    );
    expect(noClaude).toEqual({
      kind: 'noProcess',
      selfNote: `This command runs as session ${SID}, but its own Claude process was not found: no claude process is a parent of this command.`,
    });

    // Archiving ANOTHER session from inside this one: the bare claude above
    // is this session's, never a target, and the named one gets 3 s.
    const spawned: StopLaterPayload[] = [];
    const other = await scheduleSessionStop(
      OTHER,
      deps({
        ps: psOf([
          ...chain(),
          {command: `${CLAUDE} --resume ${OTHER}`, pid: 800},
        ]),
        self: {pid: 700, sessionId: SID},
        spawned,
      }),
    );
    expect(other).toMatchObject({delaySeconds: 3, self: false});
    expect(spawned[0]?.procs.map((proc) => proc.pid)).toEqual([800]);
  });

  test('claudeAncestor: a missing parent and a parent loop end the walk with why, never with a guess', () => {
    const procs = (rows: FakeProc[]): Proc[] => parseProcessList(psText(rows));
    expect(
      claudeAncestor(procs([{command: 'bun', pid: 700, ppid: 600}]), 700),
    ).toEqual({
      kind: 'none',
      reason: 'pid 600, a parent of this command, is not in ps',
    });
    expect(
      claudeAncestor(
        procs([
          {command: 'bun', pid: 700, ppid: 600},
          {command: 'zsh', pid: 600, ppid: 700},
        ]),
        700,
      ),
    ).toEqual({kind: 'none', reason: 'ps shows a parent loop at pid 700'});
    expect(claudeAncestor(procs([]), 700).kind).toBe('none');
  });
});

/** Fake child deps: a process table, a clock, a recorded SIGTERM and log. */
function childWorld(table: Map<number, string>): {
  closes: number;
  deps: StopLaterDeps & {closeWorkspace: () => Promise<null>};
  events: string[];
  logs: Record<string, unknown>[];
} {
  const events: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const terminated = new Set<number>();
  let clock = 0;
  const world = {
    closes: 0,
    deps: {
      // Present only to prove nothing ever calls it.
      closeWorkspace: () => {
        world.closes += 1;
        return Promise.resolve(null);
      },
      commandOf: (pid: number): Promise<PidCommand> => {
        events.push(`ps ${pid}`);
        const command = table.get(pid);
        if (command == null || terminated.has(pid)) {
          return Promise.resolve({kind: 'gone'});
        }
        return Promise.resolve({command, kind: 'running'});
      },
      exitTimeoutMs: 15_000,
      kill: (pid: number) => {
        events.push(`SIGTERM ${pid}`);
        terminated.add(pid);
        return null;
      },
      log: (line: Record<string, unknown>) => {
        events.push(`log ${String(line.outcome)}`);
        logs.push(line);
      },
      nowMs: () => clock,
      sleep: (ms: number) => {
        events.push(`sleep ${ms}`);
        clock += ms;
        return Promise.resolve();
      },
    },
    events,
    logs,
  };
  return world;
}

describe('the detached child (runStopLater)', () => {
  const payload: StopLaterPayload = {
    delayMs: 3000,
    logPath: '/unused',
    procs: [{command: `${CLAUDE} --resume ${SID}`, pid: 101}],
    selfPid: null,
    sessionId: SID,
  };

  test('G9: waits first, re-checks the pid, logs about-to-signal BEFORE the SIGTERM, then the outcome; never closes a workspace', async () => {
    const w = childWorld(new Map([[101, `${CLAUDE} --resume ${SID}`]]));
    expect(await runStopLater(payload, w.deps)).toBe('stopped');
    expect(w.events).toEqual([
      'sleep 3000',
      'ps 101',
      'log about-to-signal',
      'SIGTERM 101',
      'ps 101',
      'log stopped',
    ]);
    expect(w.logs[0]).toMatchObject({
      outcome: 'about-to-signal',
      pids: [101],
      sessionId: SID,
    });
    expect(w.logs[1]).toMatchObject({
      outcome: 'stopped',
      pids: [101],
      sessionId: SID,
    });
    expect(w.closes).toBe(0);
  });

  test('a pid that runs something else by the time of the signal is not signalled, and no about-to-signal is logged', async () => {
    const w = childWorld(new Map([[101, `${CLAUDE} --resume ${OTHER}`]]));
    expect(await runStopLater(payload, w.deps)).toBe('refused');
    expect(w.events.some((event) => event.startsWith('SIGTERM'))).toBe(false);
    expect(w.logs).toHaveLength(1);
    expect(w.logs[0]).toMatchObject({outcome: 'failed', step: 'verify'});
    expect(String(w.logs[0]?.reason)).toContain('the session was left running');
  });

  test('a payload whose command line does not name the session is refused before any check, unless it is the selfPid the parent found up its chain (G8)', async () => {
    const w = childWorld(new Map([[103, `${CLAUDE} --settings {}`]]));
    const foreign: StopLaterPayload = {
      ...payload,
      procs: [{command: `${CLAUDE} --settings {}`, pid: 103}],
    };
    expect(await runStopLater(foreign, w.deps)).toBe('refused');
    expect(w.events).toEqual(['sleep 3000', 'log refused']);

    const self = childWorld(new Map([[103, `${CLAUDE} --settings {}`]]));
    expect(
      await runStopLater(
        {...foreign, delayMs: 15_000, selfPid: 103},
        self.deps,
      ),
    ).toBe('stopped');
    expect(self.events.slice(0, 4)).toEqual([
      'sleep 15000',
      'ps 103',
      'log about-to-signal',
      'SIGTERM 103',
    ]);
  });
});

describe('G10: the payload schema the child reads', () => {
  test('every payload scheduleSessionStop builds (another session, and this one) is accepted by stop-later.ts', async () => {
    const spawned: StopLaterPayload[] = [];
    await scheduleSessionStop(
      SID,
      deps({
        ps: psOf([{command: `${CLAUDE} --resume ${SID}`, pid: 101}]),
        spawned,
      }),
    );
    await scheduleSessionStop(
      SID,
      deps({
        ps: psOf([
          {command: 'claude', pid: 500, ppid: 1},
          {command: 'bun', pid: 700, ppid: 500},
        ]),
        self: {pid: 700, sessionId: SID},
        spawned,
      }),
    );
    expect(spawned).toHaveLength(2);
    for (const payload of spawned) {
      // Through JSON, as the real spawn passes it.
      const parsed = stopLaterPayloadSchema.safeParse(
        JSON.parse(JSON.stringify(payload)),
      );
      expect(parsed.success).toBe(true);
      // Lossless: zod drops unknown keys, so a field the schema forgot
      // (selfPid) would vanish here and the child would refuse the stop.
      expect(parsed.data).toEqual(payload);
    }
  });

  test('a payload that is not what the parent sends is refused (exit 2), and --help does nothing else (exit 0)', async () => {
    const good = {
      delayMs: 3000,
      logPath: '/x/log',
      procs: [{command: 'claude --resume x', pid: 1}],
      selfPid: null,
      sessionId: SID,
    };
    for (const bad of [
      {...good, delayMs: 61_000},
      {...good, procs: []},
      {...good, procs: [{command: 'claude', pid: 0}]},
      {...good, selfPid: undefined},
      {...good, sessionId: ''},
    ]) {
      expect(stopLaterPayloadSchema.safeParse(bad).success).toBe(false);
    }
    expect(stopLaterPayloadSchema.safeParse(good).success).toBe(true);
    // main() is only ever given input that cannot reach the real ps and
    // SIGTERM: a payload-shaped argument would run the real child.
    expect(await main(['{}'])).toBe(2);
    expect(await main(['not json'])).toBe(2);
    expect(await main([])).toBe(2);
    expect(await main(['--help'])).toBe(0);
  });
});

describe('after the mark (stopAfterMark, runSessionClose)', () => {
  const closed = (
    over: Partial<Extract<CloseSessionOutcome, {kind: 'closed'}>> = {},
  ): CloseSessionOutcome => ({
    alreadyClosed: false,
    closed: [],
    failures: [],
    kind: 'closed',
    leftOpen: [],
    leftOpenProblems: [],
    mode: 'archive',
    reason: 'archived: x',
    released: [],
    session: {id: 'hb-1', title: 't'},
    sessionClosed: true,
    sessionId: SID,
    statusFile: null,
    undoId: null,
    ...over,
  });

  test('a mark that did not happen, or left the session bead open, stops nothing', async () => {
    const spawned: StopLaterPayload[] = [];
    const stop = deps({
      ps: psOf([{command: `${CLAUDE} --resume ${SID}`, pid: 101}]),
      spawned,
    });
    const failed = await stopAfterMark({kind: 'failed', reason: 'no db'}, stop);
    expect(failed.lines[0]).toContain('Not stopped: the mark was not made');
    const open = await stopAfterMark(closed({sessionClosed: false}), stop);
    expect(open.lines[0]).toContain('session bead is still open');
    expect(spawned).toEqual([]);
    const done = await stopAfterMark(closed(), stop);
    expect(done.exitCode).toBe(0);
    expect(done.lines[0]).toContain('stops in 3 s (pid 101)');
    expect(spawned).toHaveLength(1);
  });

  /** runSessionClose with a fake mark, fake stop sources and captured lines. */
  async function run(input: {
    mark: CloseSessionOutcome;
    stop: boolean;
    stopDeps?: Partial<ScheduleStopDeps>;
  }): Promise<{
    code: number;
    lines: {line: string; stream: string}[];
    spawned: StopLaterPayload[];
  }> {
    const spawned: StopLaterPayload[] = [];
    const lines: {line: string; stream: string}[] = [];
    const code = await runSessionClose(
      'archive',
      {reason: 'x', selector: null, sessionId: SID, stop: input.stop},
      {
        close: () => Promise.resolve(input.mark),
        stop: deps({
          ps: psOf([{command: `${CLAUDE} --resume ${SID}`, pid: 101}]),
          spawned,
          ...input.stopDeps,
        }),
        write: (line, stream) => {
          lines.push({line, stream});
        },
      },
    );
    return {code, lines, spawned};
  }

  test('G10 wiring: without --stop nothing is looked at; with it the stop lines follow the mark lines and the stop decides the exit code', async () => {
    const off = await run({mark: closed(), stop: false});
    expect(off.code).toBe(0);
    expect(off.spawned).toEqual([]);
    expect(off.lines.some((entry) => entry.line.includes('stops in'))).toBe(
      false,
    );

    const on = await run({mark: closed(), stop: true});
    expect(on.code).toBe(0);
    expect(on.spawned).toHaveLength(1);
    const stopAt = on.lines.findIndex((entry) =>
      entry.line.includes('stops in 3 s'),
    );
    expect(stopAt).toBeGreaterThan(0);
    expect(on.lines[stopAt - 1]?.line).toBe('');

    const unchecked = await run({
      mark: closed(),
      stop: true,
      stopDeps: {hookStorePath: join(tempDir(), 'absent.json')},
    });
    expect(unchecked.code).toBe(1);
    expect(unchecked.lines.at(-1)).toMatchObject({stream: 'err'});
    expect(unchecked.spawned).toEqual([]);
  });

  test('G10 exit merge: a failed mark keeps its own exit code and stops nothing, a partial mark keeps exit 1 even when the stop is scheduled', async () => {
    const failed = await run({
      mark: {kind: 'failed', reason: 'no db'},
      stop: true,
    });
    expect(failed.code).toBe(1);
    expect(failed.spawned).toEqual([]);
    expect(failed.lines.at(-1)?.line).toContain(
      'Not stopped: the mark was not made',
    );

    const partial = await run({
      mark: closed({failures: ['br close hb-1.2 failed']}),
      stop: true,
    });
    expect(partial.code).toBe(1);
    expect(partial.spawned).toHaveLength(1);
  });
});
