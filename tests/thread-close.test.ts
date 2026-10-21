/**
 * `thread close <workspace…>` (home-base-yukaf.31). cmux is a fake runner
 * holding a tiny model of windows, workspaces and panes (each pane: a tty and
 * a list of screens, one per read); ps, `ps -p`, kill, the clock, the hook
 * store, the live-session join and the transcript lookup are fakes too. Every
 * outside effect is appended to one event log, so the tests can assert ORDER
 * (the closes.jsonl line before the SIGTERM, SIGTERM before close-workspace).
 * No test reaches the real cmux, ps or any process (D-NO-LIVE-RUNS).
 */

import type {CloseDeps, CloseLogLine, CloseOptions} from '../src/thread/close';
import type {CmuxCall} from '../src/thread/cmux';
import type {HookStore, RawTree} from '../src/thread/pane-join';
import type {PidCommand} from '../src/thread/workspace-close';

import {afterEach, describe, expect, test} from 'bun:test';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {PLAIN_STYLE} from '../src/cli-style';
import {closesLogPath, closeWorkspaces} from '../src/thread/close';
import {inputDraftPath} from '../src/thread/input-drafts';
import {joinLiveSessions} from '../src/thread/live-sessions';
import {
  flattenTree,
  NO_BREAK_SPACE,
  parseProcessList,
} from '../src/thread/pane-join';

const CLAUDE = '/Users/jhaa/.local/bin/claude';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, {force: true, recursive: true});
});

/** A session id from a short number, uuid-shaped and lowercase. */
function sid(n: number): string {
  return `${`0000000${n}`.slice(-8)}-1111-4222-8333-000000000000`;
}

/** A workspace / window / surface uuid, uppercase as cmux prints them. */
function wsId(n: number): string {
  return `C${`000000${n}`.slice(-7)}-AAAA-4AAA-8AAA-AAAAAAAAAAAA`;
}
function winId(n: number): string {
  return `B${`000000${n}`.slice(-7)}-AAAA-4AAA-8AAA-AAAAAAAAAAAA`;
}
function surfId(n: number): string {
  return `E${`000000${n}`.slice(-7)}-AAAA-4AAA-8AAA-AAAAAAAAAAAA`;
}

const RULE = '─'.repeat(40);

/** An idle Claude screen: a finished turn, an empty box, the status line. */
function idleClaude(session: string): string {
  return [
    '⏺ Done: the tests pass.',
    '',
    '✻ Cooked for 3m 2s',
    '',
    RULE,
    `❯${NO_BREAK_SPACE}`,
    RULE,
    `  ◈ v2.1.302   ⌗ ${session}`,
  ].join('\n');
}

function draftClaude(session: string, typed: string): string {
  return idleClaude(session).replace(`❯${NO_BREAK_SPACE}`, `❯ ${typed}`);
}

function workingClaude(session: string): string {
  return [
    '⏺ Reading the file',
    '',
    '✢ Inferring… (2m 40s · ↓ 9.8k tokens)',
    '',
    RULE,
    `❯${NO_BREAK_SPACE}`,
    RULE,
    `  ◈ v2.1.302   ⌗ ${session}`,
  ].join('\n');
}

interface Pane {
  id: string;
  ref: string;
  /** One screen per read; the last one repeats. null = cmux cannot read it. */
  screens: (string | null)[];
  tty: string | null;
}

interface Workspace {
  id: string;
  panes: Pane[];
  ref: string;
  title: string;
}

interface Model {
  windows: {id: string; ref: string; workspaces: Workspace[]}[];
}

interface Proc {
  command: string;
  /** What happens on SIGTERM. */
  onTerm: 'exit' | 'ignore';
  pid: number;
  tty: string;
}

interface World {
  deps: Partial<CloseDeps>;
  events: string[];
  /** For each kill, in order: the closes.jsonl lines on disk at that moment. */
  logAtKill: CloseLogLine[][];
  logPath: string;
  model: Model;
  options: CloseOptions;
  stateDir: string;
}

function readLog(path: string): CloseLogLine[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as CloseLogLine);
}

/** A workspace (n) holding one pane per session given, in window `window`. */
function workspace(
  n: number,
  panes: {screens: (string | null)[]; surface: number; tty?: string | null}[],
): Workspace {
  return {
    id: wsId(n),
    panes: panes.map((pane) => ({
      id: surfId(pane.surface),
      ref: `surface:${pane.surface}`,
      screens: pane.screens,
      tty: pane.tty === undefined ? `ttys0${pane.surface}` : pane.tty,
    })),
    ref: `workspace:${n}`,
    title: `[A] title ${n}`,
  };
}

/** One window (1) holding one single-pane workspace per entry. */
function oneWindow(
  panes: {n: number; screens: (string | null)[]; tty?: string | null}[],
): Model {
  return {
    windows: [
      {
        id: winId(1),
        ref: 'window:1',
        workspaces: panes.map((pane) =>
          workspace(pane.n, [
            {
              screens: pane.screens,
              surface: pane.n,
              ...(pane.tty === undefined ? {} : {tty: pane.tty}),
            },
          ]),
        ),
      },
    ],
  };
}

/** `claude --session-id <sid(n)>` on ttys0<n>, the way cmux starts panes. */
function claudeProc(n: number, onTerm: Proc['onTerm'] = 'exit'): Proc {
  return {
    command: `${CLAUDE} --session-id ${sid(n)} --settings x`,
    onTerm,
    pid: 1000 + n,
    tty: `ttys0${n}`,
  };
}

function world(input: {
  env?: Record<string, string>;
  hookStore?: HookStore | null;
  model: Model;
  /** Sessions with no transcript (resume command unknown). */
  noTranscript?: string[];
  options?: Partial<CloseOptions>;
  procs?: Proc[];
}): World {
  const root = mkdtempSync(join(tmpdir(), 'thread-close-'));
  dirs.push(root);
  const stateDir = join(root, 'state');
  const env = {
    CMUX_SOCKET_PATH: '/tmp/thread-close-test/cmux.sock',
    HOME: '/nonexistent',
    JUSTIN_THREADS_STATE_DIR: stateDir,
    ...input.env,
  };
  const logPath = closesLogPath(env);
  const events: string[] = [];
  const logAtKill: CloseLogLine[][] = [];
  const procs = new Map(
    (input.procs ?? []).map((proc) => [proc.pid, {...proc}]),
  );
  const terminated = new Set<number>();
  const reads = new Map<string, number>();
  let clock = Date.parse('2026-10-20T12:00:00.000Z');

  const allPanes = (): Pane[] =>
    input.model.windows.flatMap((window) =>
      window.workspaces.flatMap((entry) => entry.panes),
    );
  const value = (args: readonly string[], flag: string): string =>
    args[args.indexOf(flag) + 1] ?? '';
  const rawTree = (): RawTree & {windows: {id: string}[]} => ({
    windows: input.model.windows.map((window) => ({
      id: window.id,
      ref: window.ref,
      workspaces: window.workspaces.map((entry) => ({
        id: entry.id,
        panes: entry.panes.map((pane) => ({
          ref: `pane:${pane.ref}`,
          surfaces: [
            {
              id: pane.id,
              ref: pane.ref,
              title: 'x',
              tty: pane.tty,
              type: 'terminal',
            },
          ],
        })),
        ref: entry.ref,
        title: entry.title,
      })),
    })),
  });
  const screenOf = (pane: Pane, peek: boolean): string | null => {
    const index = reads.get(pane.id) ?? 0;
    if (!peek) reads.set(pane.id, index + 1);
    return pane.screens[Math.min(index, pane.screens.length - 1)] ?? null;
  };

  const run = (args: readonly string[]): Promise<CmuxCall> => {
    const respond = (): CmuxCall => {
      if (args[0] === 'ping') {
        events.push('ping');
        return {kind: 'ok', stdout: 'PONG\n'};
      }
      if (args.includes('tree')) {
        return {kind: 'ok', stdout: JSON.stringify(rawTree())};
      }
      if (args[0] === 'read-screen') {
        const target = value(args, '--surface');
        const pane = allPanes().find(
          (entry) => entry.ref === target || entry.id === target,
        );
        if (pane == null) {
          return {kind: 'failed', reason: `no surface ${target}`};
        }
        const screen = screenOf(pane, false);
        return screen == null
          ? {kind: 'failed', reason: 'read-screen failed: surface not ready'}
          : {kind: 'ok', stdout: screen};
      }
      if (args[0] === 'close-workspace') {
        events.push(
          `close-workspace ${value(args, '--workspace')} --window ${value(args, '--window')}`,
        );
        const target = value(args, '--workspace');
        for (const window of input.model.windows) {
          window.workspaces = window.workspaces.filter(
            (entry) => entry.id !== target,
          );
        }
        // cmux closes a window with its last workspace.
        input.model.windows = input.model.windows.filter(
          (window) => window.workspaces.length > 0,
        );
        return {kind: 'ok', stdout: 'OK\n'};
      }
      events.push(`unexpected cmux ${args.join(' ')}`);
      return {
        kind: 'failed',
        reason: `the fake does not know ${args.join(' ')}`,
      };
    };
    return Promise.resolve(respond());
  };

  const psText = (): string => {
    const lines = ['  PID  PPID TTY      ELAPSED COMMAND'];
    for (const proc of procs.values()) {
      if (terminated.has(proc.pid) && proc.onTerm !== 'ignore') continue;
      lines.push(`${proc.pid} 1 ${proc.tty} 01:00 ${proc.command}`);
    }
    return `${lines.join('\n')}\n`;
  };

  const commandOf = (pid: number): Promise<PidCommand> => {
    const proc = procs.get(pid);
    if (proc == null) return Promise.resolve({kind: 'gone'});
    if (terminated.has(pid) && proc.onTerm === 'exit') {
      return Promise.resolve({kind: 'gone'});
    }
    return Promise.resolve({command: proc.command, kind: 'running'});
  };

  const hookStore = input.hookStore === undefined ? {} : input.hookStore;
  const deps: Partial<CloseDeps> = {
    appendLog: (line) => {
      events.push(`log ${line.workspaceId} ${line.outcome.split(':')[0]}`);
      // The real appender, into this test's state dir.
      mkdirSync(stateDir, {recursive: true});
      appendFileSync(logPath, `${JSON.stringify(line)}\n`);
      return null;
    },
    commandOf,
    exitTimeoutMs: 15_000,
    kill: (pid) => {
      events.push(`kill ${pid}`);
      logAtKill.push(readLog(logPath));
      terminated.add(pid);
      return null;
    },
    nowMs: () => clock,
    ps: () => Promise.resolve({kind: 'ok', stdout: psText()}),
    readHookStore: () =>
      hookStore == null
        ? {ok: false, reason: 'no cmux hook store at /nonexistent'}
        : {ok: true, value: hookStore},
    // The real join over this world's sources (no screens read: the join
    // needs them only for panes no other source names).
    readLive: () =>
      Promise.resolve({
        kind: 'read' as const,
        ...joinLiveSessions({
          agents: [],
          procs: parseProcessList(psText()),
          screens: new Map(
            allPanes().map((pane) => {
              const text = screenOf(pane, true);
              return [
                pane.ref,
                text == null
                  ? {kind: 'unreadable' as const, reason: 'not ready'}
                  : {kind: 'read' as const, text},
              ];
            }),
          ),
          store: hookStore ?? {},
          surfaces: flattenTree(rawTree()),
        }),
      }),
    resumeOf: (sessionId) =>
      (input.noTranscript ?? []).includes(sessionId)
        ? {kind: 'unknown', reason: `no transcript ${sessionId}.jsonl`}
        : {
            checkout: '/Users/x/Dev/repo-a',
            command: `cd '/Users/x/Dev/repo-a' && claude --resume ${sessionId}`,
            kind: 'found',
            repo: 'repo-a',
            warning: null,
          },
    run,
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
    windowGoneTimeoutMs: 5000,
  };
  const options: CloseOptions = {
    dryRun: false,
    env,
    json: false,
    sessions: [],
    style: PLAIN_STYLE,
    workspaces: [],
    ...input.options,
  };
  return {
    deps,
    events,
    logAtKill,
    logPath,
    model: input.model,
    options,
    stateDir,
  };
}

const kills = (w: World): string[] =>
  w.events.filter((event) => event.startsWith('kill'));
const closes = (w: World): string[] =>
  w.events.filter((event) => event.startsWith('close-workspace'));
/** Everything that changes something: a log line, a signal, a close. */
const writes = (w: World): string[] =>
  w.events.filter(
    (event) =>
      event.startsWith('log') ||
      event.startsWith('kill') ||
      event.startsWith('close-workspace'),
  );

describe('a clean workspace', () => {
  test('the closing line is on disk, then SIGTERM, then close-workspace, then the outcome line; the resume command is printed', async () => {
    const w = world({
      model: oneWindow([
        {n: 1, screens: [idleClaude(sid(1))]},
        {n: 2, screens: [idleClaude(sid(2))]},
      ]),
      options: {workspaces: [wsId(1)]},
      procs: [claudeProc(1), claudeProc(2)],
    });
    const result = await closeWorkspaces(w.options, w.deps);
    expect(result.exitCode).toBe(0);
    expect(writes(w)).toEqual([
      `log ${wsId(1)} closing`,
      'kill 1001',
      `close-workspace ${wsId(1)} --window ${winId(1)}`,
      `log ${wsId(1)} closed`,
    ]);
    // The record BEFORE the SIGTERM: at the moment of the kill, the line
    // with the resume command is already on disk.
    expect(w.logAtKill).toEqual([
      [
        {
          at: expect.any(String) as unknown as string,
          checkout: '/Users/x/Dev/repo-a',
          outcome: 'closing',
          pid: 1001,
          repo: 'repo-a',
          resumeCommand: `cd '/Users/x/Dev/repo-a' && claude --resume ${sid(1)}`,
          runAt: '2026-10-20T12:00:00.000Z',
          sessionId: sid(1),
          title: '[A] title 1',
          windowId: winId(1),
          workspaceId: wsId(1),
        },
      ],
    ]);
    expect(readLog(w.logPath).map((line) => line.outcome)).toEqual([
      'closing',
      'closed',
    ]);
    expect(result.output).toContain('Closed (1)');
    expect(result.output).toContain(
      `Resume:     cd '/Users/x/Dev/repo-a' && claude --resume ${sid(1)}`,
    );
    expect(result.output).toContain('Title:      [A] title 1');
    expect(result.output).toContain('Repo:       repo-a');
    expect(result.output).toContain(`Session:    ${sid(1)}`);
    expect(result.output).toContain(
      'Window:     window:1 (B0000001-AAAA-4AAA-8AAA-AAAAAAAAAAAA); its window stays open with its other workspaces',
    );
    // The workspace not named is untouched.
    expect(w.model.windows[0]?.workspaces.map((entry) => entry.id)).toEqual([
      wsId(2),
    ]);
  });

  test("a window's last workspace: the output says the window closed with it", async () => {
    const w = world({
      model: oneWindow([{n: 1, screens: [idleClaude(sid(1))]}]),
      options: {workspaces: ['workspace:1']},
      procs: [claudeProc(1)],
    });
    const result = await closeWorkspaces(w.options, w.deps);
    expect(result.exitCode).toBe(0);
    expect(closes(w)).toEqual([
      `close-workspace ${wsId(1)} --window ${winId(1)}`,
    ]);
    expect(result.output).toContain(
      'its window closed with its last workspace',
    );
    expect(result.state?.closed[0]?.given).toEqual(['workspace:1']);
  });

  test('a bare claude (no id on its command line) is stopped when the hook store names the session its screen shows', async () => {
    const bare: Proc = {
      command: `${CLAUDE} --settings x`,
      onTerm: 'exit',
      pid: 1001,
      tty: 'ttys01',
    };
    const named = world({
      hookStore: {sessions: {[sid(1)]: {pid: 1001, sessionId: sid(1)}}},
      model: oneWindow([{n: 1, screens: [idleClaude(sid(1))]}]),
      options: {workspaces: [wsId(1)]},
      procs: [bare],
    });
    const result = await closeWorkspaces(named.options, named.deps);
    expect(result.exitCode).toBe(0);
    expect(kills(named)).toEqual(['kill 1001']);

    // Neither the command line nor the hook store names it: kept.
    const unnamed = world({
      hookStore: {sessions: {[sid(9)]: {pid: 1001, sessionId: sid(9)}}},
      model: oneWindow([{n: 1, screens: [idleClaude(sid(1))]}]),
      options: {workspaces: [wsId(1)]},
      procs: [bare],
    });
    const kept = await closeWorkspaces(unnamed.options, unnamed.deps);
    expect(kept.exitCode).toBe(0);
    expect(writes(unnamed)).toEqual([]);
    expect(kept.state?.kept[0]?.reasons.join(' ')).toContain(
      'names neither on its command line nor in the cmux hook store',
    );
  });
});

describe('the gates keep a workspace', () => {
  test('unsent text: kept, stored with source close, printed in full under the loud header, nothing signalled or logged', async () => {
    const typed = 'remember to rebase the branch first';
    const w = world({
      model: oneWindow([{n: 1, screens: [draftClaude(sid(1), typed)]}]),
      options: {workspaces: [wsId(1)]},
      procs: [claudeProc(1)],
    });
    const result = await closeWorkspaces(w.options, w.deps);
    expect(result.exitCode).toBe(0);
    expect(writes(w)).toEqual([]);
    const stored = JSON.parse(
      readFileSync(
        inputDraftPath(sid(1), {JUSTIN_THREADS_STATE_DIR: w.stateDir}),
        'utf8',
      ),
    ) as {source: string; text: string; workspaceId: string};
    expect(stored.source).toBe('close');
    expect(stored.text).toBe(typed);
    expect(stored.workspaceId).toBe(wsId(1));
    expect(result.output).toContain('✍️ Unsent text, kept open (1)');
    expect(result.output).toContain(typed);
    expect(result.output).toContain('kept 1 (1 with unsent text)');
  });

  test('Claude working: kept', async () => {
    const w = world({
      model: oneWindow([{n: 1, screens: [workingClaude(sid(1))]}]),
      options: {workspaces: [wsId(1)]},
      procs: [claudeProc(1)],
    });
    const result = await closeWorkspaces(w.options, w.deps);
    expect(writes(w)).toEqual([]);
    expect(result.state?.kept[0]?.reasons.join(' ')).toContain(
      'Claude is working',
    );
  });

  test('an unknown tty: kept, even with a blank screen', async () => {
    const w = world({
      model: oneWindow([
        {n: 1, screens: [idleClaude(sid(1))], tty: null},
        {n: 2, screens: [''], tty: null},
      ]),
      options: {workspaces: [wsId(1), wsId(2)]},
      procs: [claudeProc(1)],
    });
    const result = await closeWorkspaces(w.options, w.deps);
    expect(result.exitCode).toBe(0);
    expect(writes(w)).toEqual([]);
    expect(result.state?.kept.map((entry) => entry.reasons.join(' '))).toEqual([
      expect.stringContaining('its tty is unknown') as unknown as string,
      expect.stringContaining('its tty is unknown') as unknown as string,
    ]);
  });

  test('an unreadable screen: kept (rule 7)', async () => {
    const w = world({
      model: oneWindow([{n: 1, screens: [null]}]),
      options: {workspaces: [wsId(1)]},
      procs: [claudeProc(1)],
    });
    const result = await closeWorkspaces(w.options, w.deps);
    expect(writes(w)).toEqual([]);
    expect(result.state?.kept[0]?.reasons.join(' ')).toContain(
      'could not be read',
    );
  });

  test('a second Claude session in the workspace: kept, neither signalled', async () => {
    const w = world({
      model: {
        windows: [
          {
            id: winId(1),
            ref: 'window:1',
            workspaces: [
              workspace(1, [
                {screens: [idleClaude(sid(1))], surface: 1},
                {screens: [idleClaude(sid(2))], surface: 2},
              ]),
            ],
          },
        ],
      },
      options: {workspaces: [wsId(1)]},
      procs: [claudeProc(1), claudeProc(2)],
    });
    const result = await closeWorkspaces(w.options, w.deps);
    expect(result.exitCode).toBe(0);
    expect(writes(w)).toEqual([]);
    const why = result.state?.kept[0]?.reasons.join(' ') ?? '';
    expect(why).toContain('it holds 2 Claude sessions');
    expect(why).toContain('2 Claude processes run in it');
  });

  test('no transcript to build a resume command from: kept, the close could not be undone by hand', async () => {
    const w = world({
      model: oneWindow([{n: 1, screens: [idleClaude(sid(1))]}]),
      noTranscript: [sid(1)],
      options: {workspaces: [wsId(1)]},
      procs: [claudeProc(1)],
    });
    const result = await closeWorkspaces(w.options, w.deps);
    expect(writes(w)).toEqual([]);
    expect(result.state?.kept[0]?.reasons.join(' ')).toContain(
      'no resume command could be built',
    );
  });

  test('the gates run again before the SIGTERM: text typed after the first pass keeps it, and the log says kept', async () => {
    const typed = 'one more thing';
    const w = world({
      model: oneWindow([
        {n: 1, screens: [idleClaude(sid(1)), draftClaude(sid(1), typed)]},
      ]),
      options: {workspaces: [wsId(1)]},
      procs: [claudeProc(1)],
    });
    const result = await closeWorkspaces(w.options, w.deps);
    expect(result.exitCode).toBe(0);
    expect(kills(w)).toEqual([]);
    expect(closes(w)).toEqual([]);
    expect(readLog(w.logPath).map((line) => line.outcome)).toEqual([
      'closing',
      'kept: unsent text in the input box of pane surface:1',
    ]);
    expect(result.output).toContain(typed);
  });
});

describe('refusals and targets', () => {
  test("the command's own workspace refuses with exit 2 and makes no cmux call", async () => {
    const w = world({
      env: {CMUX_WORKSPACE_ID: wsId(1)},
      model: oneWindow([
        {n: 1, screens: [idleClaude(sid(1))]},
        {n: 2, screens: [idleClaude(sid(2))]},
      ]),
      options: {workspaces: [wsId(2), wsId(1).toLowerCase()]},
      procs: [claudeProc(1), claudeProc(2)],
    });
    const result = await closeWorkspaces(w.options, w.deps);
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain("this command's own workspace");
    expect(w.events).toEqual([]);
    expect(existsSync(w.logPath)).toBe(false);
  });

  test('a workspace:N ref or --session that resolves to the own workspace refuses too, after read-only calls only', async () => {
    for (const options of [
      {workspaces: ['workspace:1']},
      {sessions: [sid(1)]},
    ]) {
      const w = world({
        env: {CMUX_WORKSPACE_ID: wsId(1)},
        model: oneWindow([{n: 1, screens: [idleClaude(sid(1))]}]),
        options,
        procs: [claudeProc(1)],
      });
      const result = await closeWorkspaces(w.options, w.deps);
      expect(result.exitCode).toBe(2);
      expect(writes(w)).toEqual([]);
    }
  });

  test('an unknown workspace id is listed under Not found; the others still close', async () => {
    const w = world({
      model: oneWindow([{n: 1, screens: [idleClaude(sid(1))]}]),
      options: {workspaces: [wsId(77), wsId(1)]},
      procs: [claudeProc(1)],
    });
    const result = await closeWorkspaces(w.options, w.deps);
    expect(result.exitCode).toBe(0);
    expect(result.state?.notFound).toEqual([
      {given: [wsId(77)], reason: 'no open cmux workspace has it'},
    ]);
    expect(result.output).toContain('Not found (1)');
    expect(result.output).toContain(wsId(77));
    expect(kills(w)).toEqual(['kill 1001']);
  });

  test('a target that is neither a uuid nor workspace:N, or no target at all, refuses before any cmux call', async () => {
    for (const options of [
      {workspaces: ['surface:3']},
      {workspaces: []},
      {sessions: ['not-a-session']},
    ]) {
      const w = world({
        model: oneWindow([{n: 1, screens: [idleClaude(sid(1))]}]),
        options,
        procs: [claudeProc(1)],
      });
      const result = await closeWorkspaces(w.options, w.deps);
      expect(result.exitCode).toBe(2);
      expect(w.events).toEqual([]);
    }
  });

  test('cmux unreachable, or the hook store unreadable: exit 2, nothing touched', async () => {
    const w = world({
      model: oneWindow([{n: 1, screens: [idleClaude(sid(1))]}]),
      options: {workspaces: [wsId(1)]},
      procs: [claudeProc(1)],
    });
    const down = await closeWorkspaces(w.options, {
      ...w.deps,
      run: () => Promise.resolve({kind: 'failed', reason: 'no socket'}),
    });
    expect(down.exitCode).toBe(2);
    expect(down.output).toContain('cmux cannot be reached');

    const noStore = world({
      hookStore: null,
      model: oneWindow([{n: 1, screens: [idleClaude(sid(1))]}]),
      options: {workspaces: [wsId(1)]},
      procs: [claudeProc(1)],
    });
    const refused = await closeWorkspaces(noStore.options, noStore.deps);
    expect(refused.exitCode).toBe(2);
    expect(refused.output).toContain('hook store could not be read');
    expect(writes(noStore)).toEqual([]);
  });
});

describe('--session', () => {
  test('found: closes the one workspace that holds the session', async () => {
    const w = world({
      model: oneWindow([
        {n: 1, screens: [idleClaude(sid(1))]},
        {n: 2, screens: [idleClaude(sid(2))]},
      ]),
      options: {sessions: [sid(2)]},
      procs: [claudeProc(1), claudeProc(2)],
    });
    const result = await closeWorkspaces(w.options, w.deps);
    expect(result.exitCode).toBe(0);
    expect(writes(w)).toEqual([
      `log ${wsId(2)} closing`,
      'kill 1002',
      `close-workspace ${wsId(2)} --window ${winId(1)}`,
      `log ${wsId(2)} closed`,
    ]);
    expect(result.state?.closed[0]?.given).toEqual([`--session ${sid(2)}`]);
  });

  test('unknown: no live process holds it, exit 2, nothing touched', async () => {
    const w = world({
      model: oneWindow([{n: 1, screens: [idleClaude(sid(1))]}]),
      options: {sessions: [sid(5)], workspaces: [wsId(1)]},
      procs: [claudeProc(1)],
    });
    const result = await closeWorkspaces(w.options, w.deps);
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain(
      `--session ${sid(5)}: no live Claude process`,
    );
    expect(writes(w)).toEqual([]);
  });

  test('ambiguous: the session shows in two workspaces, exit 2, nothing touched', async () => {
    // The same session resumed twice, in workspaces 1 and 2.
    const twice: Proc = {...claudeProc(1), pid: 2001, tty: 'ttys02'};
    const w = world({
      model: oneWindow([
        {n: 1, screens: [idleClaude(sid(1))]},
        {n: 2, screens: [idleClaude(sid(1))]},
      ]),
      options: {sessions: [sid(1)]},
      procs: [claudeProc(1), twice],
    });
    const result = await closeWorkspaces(w.options, w.deps);
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('it shows in 2 workspaces');
    expect(result.output).toContain(wsId(1));
    expect(result.output).toContain(wsId(2));
    expect(writes(w)).toEqual([]);
  });
});

describe('--dry-run', () => {
  test('runs every gate, signals nothing, closes nothing, writes no log line and stores no draft', async () => {
    const w = world({
      model: oneWindow([
        {n: 1, screens: [idleClaude(sid(1))]},
        {n: 2, screens: [draftClaude(sid(2), 'half a thought')]},
      ]),
      options: {dryRun: true, workspaces: [wsId(1), wsId(2), wsId(9)]},
      procs: [claudeProc(1), claudeProc(2)],
    });
    const result = await closeWorkspaces(w.options, w.deps);
    expect(result.exitCode).toBe(0);
    expect(writes(w)).toEqual([]);
    expect(existsSync(w.logPath)).toBe(false);
    expect(
      existsSync(
        inputDraftPath(sid(2), {JUSTIN_THREADS_STATE_DIR: w.stateDir}),
      ),
    ).toBe(false);
    expect(existsSync(w.stateDir)).toBe(false);
    expect(result.output).toContain('Would close (1)');
    expect(result.output).toContain(
      'would be stopped with SIGTERM first (pid 1001)',
    );
    expect(result.output).toContain('not stored (dry run)');
    expect(result.output).toContain('half a thought');
    expect(result.output).toContain('Not found (1)');
    expect(result.output).toContain(
      'Would close 1, kept 1 (1 with unsent text), not found 1.',
    );
  });
});

describe('failures', () => {
  test('the closing line cannot be written: nothing is signalled or closed, exit 1', async () => {
    const w = world({
      model: oneWindow([{n: 1, screens: [idleClaude(sid(1))]}]),
      options: {workspaces: [wsId(1)]},
      procs: [claudeProc(1)],
    });
    const result = await closeWorkspaces(w.options, {
      ...w.deps,
      appendLog: () => 'EACCES: permission denied',
    });
    expect(result.exitCode).toBe(1);
    expect(kills(w)).toEqual([]);
    expect(closes(w)).toEqual([]);
    expect(result.state?.kept[0]?.reasons).toEqual([
      'the close log could not be written first',
    ]);
  });

  test('a claude that ignores SIGTERM: waited on for 15 s, never SIGKILLed, the workspace stays open, failed in the log, exit 1', async () => {
    const w = world({
      model: oneWindow([{n: 1, screens: [idleClaude(sid(1))]}]),
      options: {workspaces: [wsId(1)]},
      procs: [claudeProc(1, 'ignore')],
    });
    const result = await closeWorkspaces(w.options, w.deps);
    expect(result.exitCode).toBe(1);
    expect(kills(w)).toEqual(['kill 1001']);
    expect(closes(w)).toEqual([]);
    expect(readLog(w.logPath).at(-1)?.outcome).toStartWith('failed: wait-exit');
  });
});
