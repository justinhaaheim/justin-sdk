/**
 * `thread close --tab` and `--handed-off` (home-base-v8z8d.2.1). The same
 * kind of fake world as thread-close.test.ts (a tiny cmux model, fake ps,
 * kill, clock, hook store and transcripts), with workspaces that hold more
 * than one tab and a fake `close-surface`. Every outside effect is appended to
 * one event log, so the tests assert ORDER and what was NOT touched. No test
 * reaches the real cmux, ps, br or any process (D-NO-LIVE-RUNS).
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
import {
  closesLogPath,
  closeSurfaceArgs,
  closeWorkspaces,
  selectHandedOff,
} from '../src/thread/close';
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

function sid(n: number): string {
  return `${`0000000${n}`.slice(-8)}-1111-4222-8333-000000000000`;
}
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
  return idleClaude(session).replace(
    '✻ Cooked for 3m 2s',
    '✢ Inferring… (2m 40s · ↓ 9.8k tokens)',
  );
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
  onTerm: 'exit' | 'ignore';
  pid: number;
  tty: string;
}

/** A tab (pane n, surface n, tty ttys0n) showing `screens`. */
function tab(
  n: number,
  screens: (string | null)[],
  more: {id?: string; tty?: string | null} = {},
): Pane {
  return {
    id: more.id ?? surfId(n),
    ref: `surface:${n}`,
    screens,
    tty: more.tty === undefined ? `ttys0${n}` : more.tty,
  };
}

/** One window holding the given workspaces (number → tabs). */
function windowOf(workspaces: {n: number; tabs: Pane[]}[]): Model {
  return {
    windows: [
      {
        id: winId(1),
        ref: 'window:1',
        workspaces: workspaces.map((entry) => ({
          id: wsId(entry.n),
          panes: entry.tabs,
          ref: `workspace:${entry.n}`,
          title: `[A] title ${entry.n}`,
        })),
      },
    ],
  };
}

/** `claude --session-id <sid(n)>` on ttys0<n>, the way cmux starts panes. */
function claudeProc(n: number): Proc {
  return {
    command: `${CLAUDE} --session-id ${sid(n)} --settings x`,
    onTerm: 'exit',
    pid: 1000 + n,
    tty: `ttys0${n}`,
  };
}

/**
 * A successor started by a handoff: no session id on its command line, so
 * only the hook store names it (as a real handoff successor is).
 */
function successorProc(n: number): Proc {
  return {
    command: `${CLAUDE} --permission-mode auto --name x go`,
    onTerm: 'exit',
    pid: 1000 + n,
    tty: `ttys0${n}`,
  };
}

function hookStoreOf(entries: [string, number][]): HookStore {
  return {
    sessions: Object.fromEntries(
      entries.map(([session, pid]) => [session, {pid, sessionId: session}]),
    ),
  };
}

interface World {
  deps: Partial<CloseDeps>;
  events: string[];
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

function world(input: {
  env?: Record<string, string>;
  handedOff?: {id: string; labels: string[]; title: string}[];
  hookStore?: HookStore;
  model: Model;
  options?: Partial<CloseOptions>;
  procs: Proc[];
}): World {
  const root = mkdtempSync(join(tmpdir(), 'thread-close-tab-'));
  dirs.push(root);
  const stateDir = join(root, 'state');
  const env = {
    CMUX_SOCKET_PATH: '/tmp/thread-close-tab-test/cmux.sock',
    HOME: '/nonexistent',
    JUSTIN_THREADS_STATE_DIR: stateDir,
    ...input.env,
  };
  const logPath = closesLogPath(env);
  const events: string[] = [];
  const procs = new Map(input.procs.map((proc) => [proc.pid, {...proc}]));
  const terminated = new Set<number>();
  const reads = new Map<string, number>();
  let clock = Date.parse('2026-11-11T12:00:00.000Z');

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
    const index = reads.get(pane.ref) ?? 0;
    if (!peek) reads.set(pane.ref, index + 1);
    return pane.screens[Math.min(index, pane.screens.length - 1)] ?? null;
  };

  const run = (args: readonly string[]): Promise<CmuxCall> => {
    const respond = (): CmuxCall => {
      if (args[0] === 'ping') return {kind: 'ok', stdout: 'PONG\n'};
      if (args.includes('tree')) {
        return {kind: 'ok', stdout: JSON.stringify(rawTree())};
      }
      if (args[0] === 'read-screen') {
        const target = value(args, '--surface');
        const pane = allPanes().find(
          (entry) => entry.ref === target || entry.id === target,
        );
        events.push(`read ${target}`);
        const screen = pane == null ? null : screenOf(pane, false);
        return screen == null
          ? {kind: 'failed', reason: 'surface not ready', timedOut: false}
          : {kind: 'ok', stdout: screen};
      }
      if (args[0] === 'close-workspace') {
        events.push(`close-workspace ${value(args, '--workspace')}`);
        const target = value(args, '--workspace');
        for (const window of input.model.windows) {
          window.workspaces = window.workspaces.filter(
            (entry) => entry.id !== target,
          );
        }
        input.model.windows = input.model.windows.filter(
          (window) => window.workspaces.length > 0,
        );
        return {kind: 'ok', stdout: 'OK\n'};
      }
      if (args[0] === 'close-surface') {
        events.push(`close-surface ${args.slice(1).join(' ')}`);
        const surface = value(args, '--surface');
        for (const window of input.model.windows) {
          for (const entry of window.workspaces) {
            entry.panes = entry.panes.filter((pane) => pane.id !== surface);
          }
        }
        return {kind: 'ok', stdout: 'OK\n'};
      }
      events.push(`unexpected cmux ${args.join(' ')}`);
      return {kind: 'failed', reason: 'unknown to the fake', timedOut: false};
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

  const hookStore = input.hookStore ?? {};
  const deps: Partial<CloseDeps> = {
    appendLog: (line) => {
      events.push(
        `log ${line.surfaceId ?? line.workspaceId} ${line.outcome.split(':')[0]}`,
      );
      mkdirSync(stateDir, {recursive: true});
      appendFileSync(logPath, `${JSON.stringify(line)}\n`);
      return null;
    },
    commandOf,
    exitTimeoutMs: 15_000,
    kill: (pid) => {
      events.push(`kill ${pid}`);
      terminated.add(pid);
      return null;
    },
    nowMs: () => clock,
    ps: () => Promise.resolve({kind: 'ok', stdout: psText()}),
    readHandedOff: () => ({beads: input.handedOff ?? [], kind: 'read'}),
    readHookStore: () => ({ok: true, value: hookStore}),
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
          store: hookStore,
          surfaces: flattenTree(rawTree()),
        }),
      }),
    resumeOf: (sessionId) => ({
      checkout: '/Users/x/Dev/repo-a',
      command: `cd '/Users/x/Dev/repo-a' && claude --resume ${sessionId}`,
      kind: 'found',
      repo: 'repo-a',
      warning: null,
    }),
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
    tab: true,
    workspaces: [],
    ...input.options,
  };
  return {deps, events, logPath, model: input.model, options, stateDir};
}

const kills = (w: World): string[] =>
  w.events.filter((event) => event.startsWith('kill'));
const closeCalls = (w: World): string[] =>
  w.events.filter((event) => event.startsWith('close-'));
const writes = (w: World): string[] =>
  w.events.filter(
    (event) =>
      event.startsWith('log') ||
      event.startsWith('kill') ||
      event.startsWith('close-'),
  );

/**
 * The common case (2026-11-11 mayor run): workspace 1 holds the handed-off
 * session sid(1) in tab 1 and its successor sid(2) in tab 2, started by the
 * handoff (only the hook store names it).
 */
function handoffPair(
  successorScreens: (string | null)[] = [idleClaude(sid(2))],
): {hookStore: HookStore; model: Model; procs: Proc[]} {
  return {
    hookStore: hookStoreOf([
      [sid(1), 1001],
      [sid(2), 1002],
    ]),
    model: windowOf([
      {n: 1, tabs: [tab(1, [idleClaude(sid(1))]), tab(2, successorScreens)]},
    ]),
    procs: [claudeProc(1), successorProc(2)],
  };
}

describe('--tab: one tab closes, its sibling keeps running', () => {
  test('closing line, SIGTERM to the tab’s Claude only, close-surface with both ids, outcome line', async () => {
    const w = world({...handoffPair(), options: {sessions: [sid(1)]}});
    const result = await closeWorkspaces(w.options, w.deps);
    expect(result.exitCode).toBe(0);
    expect(writes(w)).toEqual([
      `log ${surfId(1)} closing`,
      'kill 1001',
      `close-surface --surface ${surfId(1)} --workspace ${wsId(1)}`,
      `log ${surfId(1)} closed`,
    ]);
    // The workspace and the successor's tab stay open.
    expect(w.model.windows[0]?.workspaces[0]?.panes.map((p) => p.ref)).toEqual([
      'surface:2',
    ]);
    const [closing] = readLog(w.logPath);
    expect(closing?.outcome).toBe('closing');
    expect(closing?.surfaceId).toBe(surfId(1));
    expect(closing?.resumeCommand).toBe(
      `cd '/Users/x/Dev/repo-a' && claude --resume ${sid(1)}`,
    );
    expect(result.output).toContain(
      'only this tab; the workspace stays open with its other tab',
    );
    expect(result.output).toContain('Closed 1, kept 0');
  });

  test('a sibling that is working and has unsent text is never gated, signalled or stored', async () => {
    const pair = handoffPair([
      draftClaude(sid(2), 'half a thought'),
      workingClaude(sid(2)),
    ]);
    const w = world({...pair, options: {sessions: [sid(1)]}});
    const result = await closeWorkspaces(w.options, w.deps);
    expect(result.exitCode).toBe(0);
    expect(kills(w)).toEqual(['kill 1001']);
    expect(closeCalls(w)).toEqual([
      `close-surface --surface ${surfId(1)} --workspace ${wsId(1)}`,
    ]);
    expect(result.state?.kept).toEqual([]);
    expect(existsSync(join(w.stateDir, 'input-drafts'))).toBe(false);
  });

  test('the dry run plans the tab and writes, signals and closes nothing', async () => {
    const w = world({
      ...handoffPair(),
      options: {dryRun: true, sessions: [sid(1)]},
    });
    const result = await closeWorkspaces(w.options, w.deps);
    expect(result.exitCode).toBe(0);
    expect(writes(w)).toEqual([]);
    expect(result.state?.planned.map((entry) => entry.tab?.surfaceId)).toEqual([
      surfId(1),
    ]);
    expect(result.output).toContain(`surface:1 (${surfId(1)}) in workspace:1`);
  });
});

describe('--tab: D2 keeps the tab', () => {
  test('the tab shows a different session than the one named (a /clear since)', async () => {
    // Tab 1's process was started for sid(1); its screen now shows sid(3),
    // and the hook store names that pid for sid(3) too, so every per-pane
    // check passes: only D2's "the tab shows the requested session" keeps it.
    const w = world({
      hookStore: hookStoreOf([
        [sid(3), 1001],
        [sid(2), 1002],
      ]),
      model: windowOf([
        {
          n: 1,
          tabs: [tab(1, [idleClaude(sid(3))]), tab(2, [idleClaude(sid(2))])],
        },
      ]),
      options: {sessions: [sid(1)]},
      procs: [claudeProc(1), successorProc(2)],
    });
    const result = await closeWorkspaces(w.options, w.deps);
    expect(result.exitCode).toBe(0);
    expect(writes(w)).toEqual([]);
    expect(result.state?.kept.map((entry) => entry.reasons)).toEqual([
      [`surface:1 shows session ${sid(3)}, not ${sid(1)}`],
    ]);
  });

  test('another tab of the workspace shows the same session: kept', async () => {
    const w = world({
      ...handoffPair([idleClaude(sid(1))]),
      options: {sessions: [sid(1)]},
    });
    const result = await closeWorkspaces(w.options, w.deps);
    expect(result.exitCode).toBe(0);
    expect(writes(w)).toEqual([]);
    expect(result.state?.kept.map((entry) => entry.reasons)).toEqual([
      [
        `the other tab surface:2 shows session ${sid(1)} too, so which tab holds it cannot be told`,
      ],
    ]);
  });

  test('two tabs report one terminal: kept, nothing signalled or closed', async () => {
    // Tab 3, a dead surface, still reports tab 1's tty.
    const w = world({
      hookStore: hookStoreOf([
        [sid(1), 1001],
        [sid(2), 1002],
      ]),
      model: windowOf([
        {
          n: 1,
          tabs: [
            tab(1, [idleClaude(sid(1))]),
            tab(2, [idleClaude(sid(2))]),
            tab(3, [''], {tty: 'ttys01'}),
          ],
        },
      ]),
      options: {sessions: [sid(1)]},
      procs: [claudeProc(1), successorProc(2)],
    });
    const result = await closeWorkspaces(w.options, w.deps);
    expect(result.exitCode).toBe(0);
    expect(writes(w)).toEqual([]);
    expect(result.state?.planned).toEqual([]);
    const reasons = (result.state?.unresolved ?? []).map((e) => e.reason);
    expect(reasons).toEqual([
      '2 tabs report its terminal ttys01 (surface:1, surface:3), so which tab holds it cannot be told',
    ]);
    expect(result.output).toContain('Kept: its one tab could not be told (1)');
  });

  test('an empty surface id is refused before anything: close-surface is never called', async () => {
    const pair = handoffPair();
    const first = pair.model.windows[0]?.workspaces[0]?.panes[0];
    if (first == null) throw new Error('no tab');
    first.id = '';
    const w = world({...pair, options: {sessions: [sid(1)]}});
    const result = await closeWorkspaces(w.options, w.deps);
    expect(result.exitCode).toBe(0);
    expect(writes(w)).toEqual([]);
    expect((result.state?.unresolved ?? []).map((e) => e.reason)).toEqual([
      `its tab's surface id "" is not a uuid, so close-surface could act on another tab`,
    ]);
  });

  test('D3: close-surface is built only with two uuids', () => {
    expect(closeSurfaceArgs(surfId(1), wsId(1))).toEqual({
      args: ['close-surface', '--surface', surfId(1), '--workspace', wsId(1)],
      kind: 'ok',
    });
    for (const [surface, workspace] of [
      [null, wsId(1)],
      ['', wsId(1)],
      [undefined, wsId(1)],
      ['surface:1', wsId(1)],
      [surfId(1), null],
      [surfId(1), ''],
    ] as const) {
      expect(closeSurfaceArgs(surface, workspace).kind).toBe('refused');
    }
  });

  test('the command’s own tab is kept, and the run goes on', async () => {
    const w = world({
      ...handoffPair(),
      env: {CMUX_SURFACE_ID: surfId(1)},
      options: {sessions: [sid(1)]},
    });
    const result = await closeWorkspaces(w.options, w.deps);
    expect(result.exitCode).toBe(0);
    expect(writes(w)).toEqual([]);
    expect((result.state?.unresolved ?? [])[0]?.reason).toContain(
      "this command's own tab",
    );
  });

  test('in its own workspace, the command closes a sibling tab as usual (home-base-hg6lz.4 R1)', async () => {
    // The handoff case: this command runs in the successor's tab 2 and closes
    // the predecessor's tab 1 of the same workspace.
    const w = world({
      ...handoffPair(),
      env: {CMUX_SURFACE_ID: surfId(2), CMUX_WORKSPACE_ID: wsId(1)},
      options: {sessions: [sid(1)]},
    });
    const result = await closeWorkspaces(w.options, w.deps);
    expect(result.exitCode).toBe(0);
    expect(closeCalls(w)).toEqual([
      `close-surface --surface ${surfId(1)} --workspace ${wsId(1)}`,
    ]);
  });
});

describe('--tab: D4, the only tab in its workspace', () => {
  test('closes the whole workspace with close-workspace, and says so', async () => {
    const w = world({
      hookStore: hookStoreOf([[sid(1), 1001]]),
      model: windowOf([
        {n: 1, tabs: [tab(1, [idleClaude(sid(1))])]},
        {n: 5, tabs: [tab(5, ['% '])]},
      ]),
      options: {sessions: [sid(1)]},
      procs: [claudeProc(1)],
    });
    const result = await closeWorkspaces(w.options, w.deps);
    expect(result.exitCode).toBe(0);
    expect(writes(w)).toEqual([
      `log ${surfId(1)} closing`,
      'kill 1001',
      `close-workspace ${wsId(1)}`,
      `log ${surfId(1)} closed`,
    ]);
    expect(result.output).toContain(
      'the only tab in its workspace, so the whole workspace closes with it (D4)',
    );
  });

  test('an only tab in the command’s own workspace is kept, even when CMUX_SURFACE_ID names another tab (home-base-hg6lz.4 R1)', async () => {
    // A stale or wrong CMUX_SURFACE_ID passes resolveTab's own-tab check, so
    // only the own-workspace check stands between D4 and close-workspace of
    // the terminal this runs in. Lower case: the comparison ignores case.
    const w = world({
      env: {
        CMUX_SURFACE_ID: surfId(9),
        CMUX_WORKSPACE_ID: wsId(1).toLowerCase(),
      },
      hookStore: hookStoreOf([[sid(1), 1001]]),
      model: windowOf([
        {n: 1, tabs: [tab(1, [idleClaude(sid(1))])]},
        {n: 5, tabs: [tab(5, ['% '])]},
      ]),
      options: {sessions: [sid(1)]},
      procs: [claudeProc(1)],
    });
    const result = await closeWorkspaces(w.options, w.deps);
    expect(result.exitCode).toBe(0);
    expect(writes(w)).toEqual([]);
    expect(result.state?.planned).toEqual([]);
    expect(result.state?.kept.map((entry) => entry.sessionId)).toEqual([
      sid(1),
    ]);
    expect(result.state?.kept[0]?.reasons).toEqual([
      `it is the only tab of this command's own workspace (CMUX_WORKSPACE_ID ${wsId(1)}): closing it would close the terminal this runs in`,
    ]);
  });
});

describe('--handed-off (D5)', () => {
  const beads = [
    {
      id: 'r-old',
      labels: ['session', 'handed-off', 'continued-by:r-new', `sid:${sid(1)}`],
      title: 'the old session',
    },
    {
      id: 'r-orphan',
      labels: ['session', 'handed-off', `sid:${sid(2)}`],
      title: 'handed off, never picked up',
    },
    {
      id: 'r-gone',
      labels: ['session', 'handed-off', 'continued-by:r-x', `sid:${sid(9)}`],
      title: 'its Claude has exited',
    },
  ];

  test('selects only live sessions whose bead has handed-off AND continued-by:', () => {
    const live = new Set([sid(1), sid(2)]);
    const picked = selectHandedOff(beads, (id) => live.has(id));
    expect(picked.selected).toEqual([
      {
        beadId: 'r-old',
        sessionId: sid(1),
        successor: 'r-new',
        title: 'the old session',
      },
    ]);
    expect(picked.skipped).toEqual([
      {
        beadId: 'r-orphan',
        reason: 'no successor picked it up (no continued-by: label)',
        title: 'handed off, never picked up',
      },
      {
        beadId: 'r-gone',
        reason: 'no live Claude process holds its session',
        title: 'its Claude has exited',
      },
    ]);
  });

  test('--handed-off --tab --dry-run prints the selection and plans only the selected tab', async () => {
    // sid(2) is the orphan here: live, handed off, no continued-by:.
    const w = world({
      ...handoffPair(),
      handedOff: beads,
      options: {dryRun: true, handedOff: true},
    });
    const result = await closeWorkspaces(w.options, w.deps);
    expect(result.exitCode).toBe(0);
    expect(writes(w)).toEqual([]);
    expect(result.state?.selection?.selected.map((p) => p.beadId)).toEqual([
      'r-old',
    ]);
    expect(result.state?.planned.map((entry) => entry.sessionId)).toEqual([
      sid(1),
    ]);
    expect(result.output).toContain('Selected by --handed-off (1)');
    expect(result.output).toContain(`--session ${sid(1)}`);
    expect(result.output).toContain('r-old');
    expect(result.output).toContain('the old session');
    expect(result.output).toContain('r-new');
    expect(result.output).toContain(
      '1 handed-off bead: no successor picked it up',
    );
  });
});

describe('--tab refusals', () => {
  test('--tab with a workspace is refused, nothing touched', async () => {
    const w = world({
      ...handoffPair(),
      options: {sessions: [sid(1)], workspaces: [wsId(1)]},
    });
    const result = await closeWorkspaces(w.options, w.deps);
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('--tab closes the one tab');
    expect(w.events).toEqual([]);
  });

  test('--tab inside a cmux workspace without CMUX_SURFACE_ID is refused, and no cmux command runs (home-base-hg6lz.4 R1)', async () => {
    // The bead's scenario: run in the target's own pane, the workspace's only
    // tab, where D4 would otherwise close-workspace the caller's workspace.
    const surfaceEnvs: Record<string, string>[] = [{}, {CMUX_SURFACE_ID: ''}];
    for (const surfaceEnv of surfaceEnvs) {
      const w = world({
        env: {CMUX_WORKSPACE_ID: wsId(1), ...surfaceEnv},
        hookStore: hookStoreOf([[sid(1), 1001]]),
        model: windowOf([{n: 1, tabs: [tab(1, [idleClaude(sid(1))])]}]),
        options: {sessions: [sid(1)]},
        procs: [claudeProc(1)],
      });
      const calls: string[] = [];
      const run = w.deps.run;
      const result = await closeWorkspaces(w.options, {
        ...w.deps,
        run: async (args) => {
          calls.push(args.join(' '));
          if (run == null) throw new Error('the fake has no cmux runner');
          return await run(args);
        },
      });
      expect(result.exitCode).toBe(2);
      expect(result.output).toContain('CMUX_SURFACE_ID is not set');
      expect(calls).toEqual([]);
      expect(w.events).toEqual([]);
    }
  });
});
