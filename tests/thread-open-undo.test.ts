/**
 * `thread open --undo` (home-base-yukaf.2). cmux is a fake runner holding a
 * tiny model of windows, workspaces and panes (each pane: a tty and a list of
 * screens, one per read); ps, `ps -p`, kill, the clock and transcript
 * activity are fakes too. Every outside effect is appended to one event log,
 * so the tests can assert ORDER (the record before the first SIGTERM, SIGTERM
 * before close-workspace). No test reaches the real cmux, ps or any process
 * (D-NO-LIVE-RUNS).
 */

import type {CmuxCall} from '../src/thread/cmux';
import type {PidCommand, UndoDeps, UndoOptions} from '../src/thread/open-undo';
import type {ActivityTimes} from '../src/thread/transcript-activity';

import {afterEach, describe, expect, test} from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {PLAIN_STYLE} from '../src/cli-style';
import {inputDraftPath, inputDraftsDir} from '../src/thread/input-drafts';
import {opensDir, writeJsonFile} from '../src/thread/open';
import {gatePane, recordFileName, undoOpen} from '../src/thread/open-undo';
import {NO_BREAK_SPACE, scrolledBoxText} from '../src/thread/pane-join';

const RUN_AT = '2026-10-18T12:00:00.000Z';
const RUN_MS = Date.parse(RUN_AT);
const STAMP = '2026-10-18T12-00-00.000Z';
const CLAUDE = '/Users/jhaa/.local/bin/claude --resume';

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

const IDLE_SHELL = [
  'Last login: Sat Oct 18',
  '',
  ' jhaa  home-base  main',
  '❯',
].join('\n');

interface Pane {
  id: string;
  ref: string;
  /** One screen per read; the last one repeats. null = cmux cannot read it. */
  screens: (string | null)[];
  tty: string | null;
}

interface Model {
  windows: {
    id: string;
    ref: string;
    workspaces: {id: string; panes: Pane[]; ref: string}[];
  }[];
}

interface Proc {
  command: string;
  /** What happens on SIGTERM. */
  onTerm: 'exit' | 'ignore' | 'zombie';
  pid: number;
  tty: string;
}

interface World {
  deps: Partial<UndoDeps>;
  events: string[];
  model: Model;
  options: UndoOptions;
  procs: Map<number, Proc>;
  recordPath: string;
  /** For each kill, in order: the record's undo.startedAt on disk at that moment. */
  startedAtAtKill: (string | null)[];
  stateDir: string;
}

/** The record thread open writes (only what --undo reads, plus a stray field to keep). */
function writeRecord(
  stateDir: string,
  windows: {
    sessions: number[];
    window: number;
    workspaceIds?: (string | null)[];
  }[],
  extra: Record<string, unknown> = {},
): string {
  const record = {
    ...extra,
    argv: [],
    at: RUN_AT,
    planned: windows.flatMap((entry) =>
      entry.sessions.map((n) => ({
        name: `[A] session ${n}`,
        sessionId: sid(n),
        title: `session ${n}`,
      })),
    ),
    somethingUndoDoesNotRead: {kept: true},
    version: 1,
    windows: windows.map((entry) => ({
      defaultWorkspaceIds: [],
      strayClosed: [],
      windowId: winId(entry.window),
      workspaces: entry.sessions.map((n, index) => ({
        sessionId: sid(n),
        workspaceId:
          entry.workspaceIds == null
            ? wsId(n)
            : (entry.workspaceIds[index] ?? null),
        workspaceRef: `workspace:${n}`,
      })),
    })),
  };
  const dir = opensDir({JUSTIN_THREADS_STATE_DIR: stateDir});
  mkdirSync(dir, {recursive: true});
  const path = join(dir, `${STAMP}.json`);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

function startedAtOnDisk(path: string): string | null {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
    undo?: {startedAt?: string};
  };
  return parsed.undo?.startedAt ?? null;
}

function world(input: {
  activity?: Record<string, ActivityTimes>;
  model: Model;
  options?: Partial<UndoOptions>;
  procs?: Proc[];
  record: {
    sessions: number[];
    window: number;
    workspaceIds?: (string | null)[];
  }[];
  /** More top-level record fields (yukaf.22: `moved`). */
  recordExtra?: Record<string, unknown>;
}): World {
  const root = mkdtempSync(join(tmpdir(), 'thread-open-undo-'));
  dirs.push(root);
  const stateDir = join(root, 'state');
  const recordPath = writeRecord(stateDir, input.record, input.recordExtra);
  const events: string[] = [];
  const startedAtAtKill: (string | null)[] = [];
  const procs = new Map(
    (input.procs ?? []).map((proc) => [proc.pid, {...proc}]),
  );
  const terminated = new Set<number>();
  const reads = new Map<string, number>();
  let clock = RUN_MS + 60 * 60_000;

  const allPanes = (): Pane[] =>
    input.model.windows.flatMap((window) =>
      window.workspaces.flatMap((workspace) => workspace.panes),
    );
  const value = (args: readonly string[], flag: string): string =>
    args[args.indexOf(flag) + 1] ?? '';

  const run = (args: readonly string[]): Promise<CmuxCall> => {
    const respond = (): CmuxCall => {
      if (args[0] === 'ping') return {kind: 'ok', stdout: 'PONG\n'};
      if (args.includes('tree')) {
        return {
          kind: 'ok',
          stdout: JSON.stringify({
            windows: input.model.windows.map((window) => ({
              id: window.id,
              ref: window.ref,
              workspaces: window.workspaces.map((workspace) => ({
                id: workspace.id,
                panes: workspace.panes.map((pane) => ({
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
                ref: workspace.ref,
                title: workspace.ref,
              })),
            })),
          }),
        };
      }
      if (args[0] === 'read-screen') {
        const target = value(args, '--surface');
        const pane = allPanes().find(
          (entry) => entry.ref === target || entry.id === target,
        );
        if (pane == null)
          return {kind: 'failed', reason: `no surface ${target}`};
        const index = reads.get(pane.id) ?? 0;
        reads.set(pane.id, index + 1);
        if (args.includes('--scrollback')) {
          events.push(`read-screen ${target} --scrollback`);
        }
        const screen =
          pane.screens[Math.min(index, pane.screens.length - 1)] ?? null;
        return screen == null
          ? {kind: 'failed', reason: 'read-screen failed: surface not ready'}
          : {kind: 'ok', stdout: screen};
      }
      if (args[0] === 'move-workspace-to-window') {
        const target = value(args, '--workspace');
        const to = value(args, '--window');
        events.push(`move ${target} --window ${to}`);
        const into = input.model.windows.find((window) => window.id === to);
        const from = input.model.windows.find((window) =>
          window.workspaces.some((workspace) => workspace.id === target),
        );
        const moving = from?.workspaces.find(
          (workspace) => workspace.id === target,
        );
        if (into == null || from == null || moving == null) {
          return {kind: 'failed', reason: 'no such workspace or window'};
        }
        from.workspaces = from.workspaces.filter((entry) => entry !== moving);
        // cmux puts a moved workspace where it likes: here, at the end.
        into.workspaces.push(moving);
        return {kind: 'ok', stdout: 'OK\n'};
      }
      if (args[0] === 'reorder-workspaces') {
        const order = value(args, '--order').split(',');
        const to = value(args, '--window');
        events.push(`reorder ${order.join(',')} --window ${to}`);
        const window = input.model.windows.find((entry) => entry.id === to);
        if (window == null) return {kind: 'failed', reason: 'no such window'};
        const listed = order
          .map((id) => window.workspaces.find((entry) => entry.id === id))
          .filter((entry) => entry != null);
        window.workspaces = [
          ...listed,
          ...window.workspaces.filter((entry) => !listed.includes(entry)),
        ];
        return {kind: 'ok', stdout: 'OK\n'};
      }
      if (args[0] === 'close-workspace') {
        events.push(
          `close-workspace ${value(args, '--workspace')} --window ${value(args, '--window')}`,
        );
        const target = value(args, '--workspace');
        for (const window of input.model.windows) {
          window.workspaces = window.workspaces.filter(
            (workspace) => workspace.id !== target,
          );
        }
        // cmux closes a window with its last workspace.
        input.model.windows = input.model.windows.filter(
          (window) => window.workspaces.length > 0,
        );
        return {kind: 'ok', stdout: 'OK\n'};
      }
      return {
        kind: 'failed',
        reason: `the fake does not know ${args.join(' ')}`,
      };
    };
    return Promise.resolve(respond());
  };

  const ps = (): Promise<{kind: 'ok'; stdout: string}> => {
    const lines = ['  PID  PPID TTY      ELAPSED COMMAND'];
    for (const proc of procs.values()) {
      if (terminated.has(proc.pid) && proc.onTerm !== 'ignore') continue;
      lines.push(`${proc.pid} 1 ${proc.tty} 01:00 ${proc.command}`);
    }
    return Promise.resolve({kind: 'ok', stdout: `${lines.join('\n')}\n`});
  };

  const commandOf = (pid: number): Promise<PidCommand> => {
    const proc = procs.get(pid);
    if (proc == null) return Promise.resolve({kind: 'gone'});
    if (terminated.has(pid)) {
      if (proc.onTerm === 'exit') return Promise.resolve({kind: 'gone'});
      if (proc.onTerm === 'zombie')
        return Promise.resolve({command: '(claude)', kind: 'running'});
    }
    return Promise.resolve({command: proc.command, kind: 'running'});
  };

  const deps: Partial<UndoDeps> = {
    commandOf,
    exitTimeoutMs: 15_000,
    kill: (pid) => {
      events.push(`kill ${pid}`);
      startedAtAtKill.push(startedAtOnDisk(recordPath));
      terminated.add(pid);
      return null;
    },
    nowMs: () => clock,
    ps,
    readActivity: (sessionId) =>
      Promise.resolve(
        input.activity?.[sessionId] ?? {
          kind: 'known',
          lastMs: RUN_MS - 60_000,
          startedMs: RUN_MS - 86_400_000,
        },
      ),
    run,
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
    windowGoneTimeoutMs: 5000,
    writeRecord: (path, recordValue) => {
      events.push('record');
      return writeJsonFile(path, recordValue, false);
    },
  };
  const options: UndoOptions = {
    dryRun: false,
    env: {
      CMUX_SOCKET_PATH: '/tmp/thread-open-undo-test/cmux.sock',
      HOME: '/nonexistent',
      JUSTIN_THREADS_STATE_DIR: stateDir,
    },
    json: false,
    run: null,
    style: PLAIN_STYLE,
    undo: true,
    ...input.options,
  };
  return {
    deps,
    events,
    model: input.model,
    options,
    procs,
    recordPath,
    startedAtAtKill,
    stateDir,
  };
}

/** One window (1) holding workspaces for the given sessions, one pane each. */
function oneWindow(
  panes: {n: number; screens: (string | null)[]; tty?: string | null}[],
): Model {
  return {
    windows: [
      {
        id: winId(1),
        ref: 'window:1',
        workspaces: panes.map((pane) => ({
          id: wsId(pane.n),
          panes: [
            {
              id: surfId(pane.n),
              ref: `surface:${pane.n}`,
              screens: pane.screens,
              tty: pane.tty === undefined ? `ttys0${pane.n}` : pane.tty,
            },
          ],
          ref: `workspace:${pane.n}`,
        })),
      },
    ],
  };
}

function claudeProc(n: number, onTerm: Proc['onTerm'] = 'exit'): Proc {
  return {
    command: `${CLAUDE} ${sid(n)}`,
    onTerm,
    pid: 1000 + n,
    tty: `ttys0${n}`,
  };
}

const kills = (w: World): string[] =>
  w.events.filter((event) => event.startsWith('kill'));
const closes = (w: World): string[] =>
  w.events.filter((event) => event.startsWith('close-workspace'));

describe('no record', () => {
  test('exits 1 with "nothing to undo" and makes no cmux call', async () => {
    const root = mkdtempSync(join(tmpdir(), 'thread-open-undo-'));
    dirs.push(root);
    const calls: string[][] = [];
    const result = await undoOpen(
      {
        dryRun: false,
        env: {JUSTIN_THREADS_STATE_DIR: join(root, 'state')},
        json: false,
        run: null,
        style: PLAIN_STYLE,
        undo: true,
      },
      {
        run: (args) => {
          calls.push([...args]);
          return Promise.resolve({kind: 'ok', stdout: ''});
        },
      },
    );
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('nothing to undo');
    expect(calls).toEqual([]);
  });

  test('--run: a malformed stamp refuses (2), an unknown one is nothing to undo (1), and --run without --undo refuses', async () => {
    const w = world({model: oneWindow([]), record: []});
    const bad = await undoOpen({...w.options, run: '../../etc'}, w.deps);
    expect(bad.exitCode).toBe(2);
    const unknown = await undoOpen(
      {...w.options, run: '2026-10-01T00-00-00.000Z'},
      w.deps,
    );
    expect(unknown.exitCode).toBe(1);
    expect(unknown.output).toContain('nothing to undo');
    const alone = await undoOpen(
      {...w.options, run: STAMP, undo: false},
      w.deps,
    );
    expect(alone.exitCode).toBe(2);
    expect(recordFileName('2026-10-18T12:00:00.000Z')).toBe(`${STAMP}.json`);
    expect(recordFileName(`${STAMP}.json`)).toBe(`${STAMP}.json`);
  });
});

describe('a draft taller than the screen (F6)', () => {
  // The visible tail of a long draft (scripts/__fixtures__/pane-backfill/
  // scrolled-draft.txt, copied into this package), plus Justin's ⌗ row.
  const fixture = readFileSync(
    join(import.meta.dir, 'fixtures', 'pane-screen-scrolled-draft.txt'),
    'utf8',
  ).trimEnd();
  const box = `${fixture}\n  ◈ v2.1.302   ⌗ ${sid(1)}`;
  const lines = box.split('\n');
  // The viewport lost the top rule and the ❯ line: the draft is taller.
  const viewport = lines.slice(2).join('\n');
  const history = ['⏺ Done: the tests pass.', '', '✻ Cooked for 3m 2s', ''];
  const scrollback = [...history, ...lines].join('\n');
  const typed = 'no new work and change no code. 1) List every separate thing';

  test('scrolledBoxText returns the scrollback when its box is the one on screen, else null', () => {
    expect(scrolledBoxText(viewport, scrollback)).toBe(scrollback);
    // The viewport already has a box: nothing to do.
    expect(scrolledBoxText(box, scrollback)).toBeNull();
    // No ⌗ row: not Justin's Claude pane as far as the screen says.
    expect(
      scrolledBoxText(lines.slice(2, -1).join('\n'), scrollback),
    ).toBeNull();
    // The screen changed between the reads: the viewport is not its tail.
    expect(
      scrolledBoxText(viewport, `${scrollback}\nsomething new`),
    ).toBeNull();
    // An old box in the history, a dialog on screen now: never that box.
    const dialog = [
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. No',
      `  ◈ v2.1.302   ⌗ ${sid(1)}`,
    ].join('\n');
    const oldBox = [RULE, `❯${NO_BREAK_SPACE}`, RULE].join('\n');
    expect(scrolledBoxText(dialog, `${oldBox}\n${dialog}`)).toBeNull();
  });

  test('undo reads the scrollback once, keeps the workspace, and stores the whole draft', async () => {
    const w = world({
      model: oneWindow([{n: 1, screens: [viewport, scrollback]}]),
      procs: [claudeProc(1)],
      record: [{sessions: [1], window: 1}],
    });
    const result = await undoOpen(w.options, w.deps);
    expect(result.exitCode).toBe(0);
    expect(kills(w)).toEqual([]);
    expect(closes(w)).toEqual([]);
    expect(
      w.events.filter((event) => event.startsWith('read-screen')),
    ).toHaveLength(1);
    expect(result.state?.kept[0]?.reason).toContain('unsent text');
    const env = {JUSTIN_THREADS_STATE_DIR: w.stateDir};
    const stored = JSON.parse(
      readFileSync(inputDraftPath(sid(1), env), 'utf8'),
    ) as {text: string};
    expect(stored.text.startsWith(typed)).toBe(true);
    expect(stored.text).toContain('its Part 1, plus one line per open request');
  });
});

describe('the three gates (D-UNDO-SAFETY)', () => {
  test('gate 1: unsent text keeps the workspace, is stored in input-drafts/<sid>.json, is printed in full, and nothing is signalled', async () => {
    const typed = 'please also check the second window';
    const w = world({
      model: oneWindow([{n: 1, screens: [draftClaude(sid(1), typed)]}]),
      procs: [claudeProc(1)],
      record: [{sessions: [1], window: 1}],
    });
    const result = await undoOpen(w.options, w.deps);
    expect(result.exitCode).toBe(0);
    expect(kills(w)).toEqual([]);
    expect(closes(w)).toEqual([]);
    expect(result.state?.kept[0]?.draft).toBe(typed);
    expect(result.state?.kept[0]?.reason).toContain('unsent text');
    const env = {JUSTIN_THREADS_STATE_DIR: w.stateDir};
    const stored = JSON.parse(
      readFileSync(inputDraftPath(sid(1), env), 'utf8'),
    ) as Record<string, unknown>;
    expect(stored).toMatchObject({
      clearedAt: null,
      source: 'undo',
      surfaceId: surfId(1),
      text: typed,
      workspaceId: wsId(1),
    });
    expect(result.output).toContain('✍️ Unsent text, kept open (1)');
    expect(result.output).toContain(typed);
  });

  test('gate 2: Claude working keeps the workspace', async () => {
    const w = world({
      model: oneWindow([{n: 1, screens: [workingClaude(sid(1))]}]),
      procs: [claudeProc(1)],
      record: [{sessions: [1], window: 1}],
    });
    const result = await undoOpen(w.options, w.deps);
    expect(kills(w)).toEqual([]);
    expect(closes(w)).toEqual([]);
    expect(result.state?.kept[0]?.reason).toContain('Claude is working');
    expect(result.state?.kept[0]?.reason).toContain('Inferring');
  });

  test('gate 3: activity newer than the record keeps it; activity that cannot be read keeps it too', async () => {
    const w = world({
      activity: {
        [sid(1)]: {
          kind: 'known',
          lastMs: RUN_MS + 5 * 60_000,
          startedMs: RUN_MS - 86_400_000,
        },
        [sid(2)]: {kind: 'unknown', reason: 'transcript file not found: x'},
      },
      model: oneWindow([
        {n: 1, screens: [idleClaude(sid(1))]},
        {n: 2, screens: [idleClaude(sid(2))]},
      ]),
      procs: [claudeProc(1), claudeProc(2)],
      record: [{sessions: [1, 2], window: 1}],
    });
    const result = await undoOpen(w.options, w.deps);
    expect(kills(w)).toEqual([]);
    expect(closes(w)).toEqual([]);
    expect(result.state?.kept.map((entry) => entry.sessionId)).toEqual([
      sid(1),
      sid(2),
    ]);
    expect(result.state?.kept[0]?.reason).toContain(
      'used after the run opened it',
    );
    expect(result.state?.kept[1]?.reason).toContain('could not be read');
  });

  test('an unreadable screen keeps the workspace (rule 7)', async () => {
    const w = world({
      model: oneWindow([{n: 1, screens: [null]}]),
      procs: [claudeProc(1)],
      record: [{sessions: [1], window: 1}],
    });
    const result = await undoOpen(w.options, w.deps);
    expect(kills(w)).toEqual([]);
    expect(closes(w)).toEqual([]);
    expect(result.state?.kept[0]?.reason).toContain('could not be read');
  });

  test('no input box with a claude process on the tty is kept: Claude is starting or showing a dialog', async () => {
    const dialog = [
      'Do you want to resume this session?',
      '❯ 1. Yes',
      '  2. No',
    ].join('\n');
    const w = world({
      model: oneWindow([{n: 1, screens: [dialog]}]),
      procs: [claudeProc(1)],
      record: [{sessions: [1], window: 1}],
    });
    const result = await undoOpen(w.options, w.deps);
    expect(kills(w)).toEqual([]);
    expect(closes(w)).toEqual([]);
    expect(result.state?.kept[0]?.reason).toContain(
      'starting or showing a dialog',
    );
  });

  test('a pane showing another session is kept: --undo closes only what the run opened', () => {
    const gate = gatePane({
      label: 'pane surface:1',
      procsOnTty: [],
      screen: {kind: 'read', text: idleClaude(sid(9))},
      sessionId: sid(1),
      tty: 'ttys01',
    });
    expect(gate.reasons.join(' ')).toContain(`shows session ${sid(9)}`);
  });
});

describe('closing', () => {
  test('a clean workspace: record (undo.startedAt) → SIGTERM → close-workspace, in that order; the emptied window is confirmed gone', async () => {
    const w = world({
      model: oneWindow([{n: 1, screens: [idleClaude(sid(1))]}]),
      procs: [claudeProc(1, 'zombie')],
      record: [{sessions: [1], window: 1}],
    });
    const result = await undoOpen(w.options, w.deps);
    expect(result.exitCode).toBe(0);
    expect(w.events).toEqual([
      'record',
      'kill 1001',
      `close-workspace ${wsId(1)} --window ${winId(1)}`,
      'record',
      'record',
    ]);
    expect(result.state?.closed.map((entry) => entry.sessionId)).toEqual([
      sid(1),
    ]);
    expect(result.state?.closed[0]?.pids).toEqual([1001]);
    expect(result.state?.windowsClosed).toEqual([winId(1)]);
    const onDisk = JSON.parse(readFileSync(w.recordPath, 'utf8')) as {
      somethingUndoDoesNotRead?: unknown;
      undo?: {closed?: unknown[]; finishedAt?: string | null};
    };
    expect(onDisk.undo?.closed).toHaveLength(1);
    expect(onDisk.undo?.finishedAt).not.toBeNull();
    // The rest of the record survives the rewrite.
    expect(onDisk.somethingUndoDoesNotRead).toEqual({kept: true});
  });

  test('the record on disk carries undo.startedAt at the moment of the first SIGTERM', async () => {
    const w = world({
      model: oneWindow([
        {n: 1, screens: [idleClaude(sid(1))]},
        {n: 2, screens: [idleClaude(sid(2))]},
      ]),
      procs: [claudeProc(1), claudeProc(2)],
      record: [{sessions: [1, 2], window: 1}],
    });
    const result = await undoOpen(w.options, w.deps);
    expect(result.exitCode).toBe(0);
    expect(w.startedAtAtKill).toHaveLength(2);
    expect(w.startedAtAtKill[0]).toBe(result.state?.startedAt ?? 'missing');
  });

  test('a record that cannot be rewritten first: nothing is signalled or closed, exit 1', async () => {
    const w = world({
      model: oneWindow([{n: 1, screens: [idleClaude(sid(1))]}]),
      procs: [claudeProc(1)],
      record: [{sessions: [1], window: 1}],
    });
    const result = await undoOpen(w.options, {
      ...w.deps,
      writeRecord: () => 'EACCES: permission denied',
    });
    expect(result.exitCode).toBe(1);
    expect(kills(w)).toEqual([]);
    expect(closes(w)).toEqual([]);
    expect(result.output).toContain('nothing was signalled or closed');
  });

  test('an idle shell with no claude process (Claude never started) closes without SIGTERM', async () => {
    const w = world({
      model: oneWindow([{n: 1, screens: [IDLE_SHELL]}]),
      procs: [
        {
          command: 'login -pflq jhaa /bin/zsh',
          onTerm: 'exit',
          pid: 2001,
          tty: 'ttys01',
        },
        {command: '-zsh', onTerm: 'exit', pid: 2002, tty: 'ttys01'},
      ],
      record: [{sessions: [1], window: 1}],
    });
    const result = await undoOpen(w.options, w.deps);
    expect(result.exitCode).toBe(0);
    expect(kills(w)).toEqual([]);
    expect(closes(w)).toHaveLength(1);
    expect(result.state?.closed.map((entry) => entry.pids)).toEqual([[]]);
  });

  // home-base-yukaf.14 F20, inverted from "a blank pane with no tty closes":
  // cmux returns an empty screen for a pane that has not drawn yet, so a
  // running Claude may be behind it.
  test('a blank pane whose tty is unknown is kept, never closed unsignalled', async () => {
    const w = world({
      model: oneWindow([{n: 2, screens: [''], tty: null}]),
      procs: [],
      record: [{sessions: [2], window: 1}],
    });
    const result = await undoOpen(w.options, w.deps);
    expect(kills(w)).toEqual([]);
    expect(closes(w)).toEqual([]);
    expect(result.state?.kept[0]?.reason).toContain('its tty is unknown');
  });

  // home-base-yukaf.14 F19: a /clear keeps the old --resume id on the command
  // line, so only the ⌗ line says which session the box holds.
  test('an input box with no session id line is kept and its claude is not signalled', async () => {
    const noIdLine = idleClaude(sid(1)).split('\n').slice(0, -1).join('\n');
    const w = world({
      model: oneWindow([{n: 1, screens: [noIdLine]}]),
      procs: [claudeProc(1)],
      record: [{sessions: [1], window: 1}],
    });
    const result = await undoOpen(w.options, w.deps);
    expect(kills(w)).toEqual([]);
    expect(closes(w)).toEqual([]);
    expect(result.state?.kept[0]?.reason).toContain(
      'cannot tell which session',
    );
  });

  test('an idle shell running something else is kept', async () => {
    const w = world({
      model: oneWindow([{n: 1, screens: [IDLE_SHELL]}]),
      procs: [
        {command: 'nvim notes.md', onTerm: 'exit', pid: 2003, tty: 'ttys01'},
      ],
      record: [{sessions: [1], window: 1}],
    });
    const result = await undoOpen(w.options, w.deps);
    expect(closes(w)).toEqual([]);
    expect(result.state?.kept[0]?.reason).toContain('is running nvim');
  });

  test('Claude on screen with no claude process to stop is kept, not closed unsignalled', async () => {
    const w = world({
      model: oneWindow([{n: 1, screens: [idleClaude(sid(1))]}]),
      procs: [],
      record: [{sessions: [1], window: 1}],
    });
    const result = await undoOpen(w.options, w.deps);
    expect(closes(w)).toEqual([]);
    expect(result.state?.kept[0]?.reason).toContain('cannot be stopped first');
  });

  test('a workspace no longer open is "already gone"; one whose uuid was never recorded is kept', async () => {
    const w = world({
      model: oneWindow([{n: 1, screens: [idleClaude(sid(1))]}]),
      procs: [claudeProc(1)],
      record: [
        {
          sessions: [1, 2, 3],
          window: 1,
          workspaceIds: [wsId(1), wsId(2), null],
        },
      ],
    });
    const result = await undoOpen(w.options, w.deps);
    expect(result.state?.gone.map((entry) => entry.sessionId)).toEqual([
      sid(2),
    ]);
    expect(result.state?.kept.map((entry) => entry.sessionId)).toEqual([
      sid(3),
    ]);
    expect(result.state?.kept[0]?.reason).toContain('never recorded');
    expect(result.state?.closed.map((entry) => entry.sessionId)).toEqual([
      sid(1),
    ]);
    expect(result.output).toContain('Already gone (1)');
  });

  test('the gates run again right before SIGTERM: text typed after the first pass keeps the workspace and is stored', async () => {
    const w = world({
      model: oneWindow([
        {
          n: 1,
          screens: [
            idleClaude(sid(1)),
            draftClaude(sid(1), 'wait, one more thing'),
          ],
        },
      ]),
      procs: [claudeProc(1)],
      record: [{sessions: [1], window: 1}],
    });
    const result = await undoOpen(w.options, w.deps);
    expect(kills(w)).toEqual([]);
    expect(closes(w)).toEqual([]);
    expect(result.state?.planned).toHaveLength(1);
    expect(result.state?.kept[0]?.draft).toBe('wait, one more thing');
    expect(
      existsSync(
        inputDraftPath(sid(1), {JUSTIN_THREADS_STATE_DIR: w.stateDir}),
      ),
    ).toBe(true);
  });

  test('a claude that ignores SIGTERM: waited on for 15 s, never SIGKILLed, workspace left open, exit 1', async () => {
    const w = world({
      model: oneWindow([{n: 1, screens: [idleClaude(sid(1))]}]),
      procs: [claudeProc(1, 'ignore')],
      record: [{sessions: [1], window: 1}],
    });
    const result = await undoOpen(w.options, w.deps);
    expect(result.exitCode).toBe(1);
    expect(kills(w)).toEqual(['kill 1001']);
    expect(closes(w)).toEqual([]);
    expect(result.state?.failed[0]?.step).toBe('wait-exit');
    expect(result.state?.failed[0]?.reason).toContain('no SIGKILL');
  });

  test('a pid that runs something else by the time of the signal is not signalled', async () => {
    const w = world({
      model: oneWindow([{n: 1, screens: [idleClaude(sid(1))]}]),
      procs: [claudeProc(1)],
      record: [{sessions: [1], window: 1}],
    });
    const base = w.deps.commandOf;
    let reads = 0;
    const result = await undoOpen(w.options, {
      ...w.deps,
      commandOf: async (pid) => {
        reads += 1;
        return reads === 1
          ? {command: 'some reused pid', kind: 'running'}
          : await (base?.(pid) ?? Promise.resolve({kind: 'gone'}));
      },
    });
    expect(kills(w)).toEqual([]);
    expect(closes(w)).toEqual([]);
    expect(result.state?.failed[0]?.step).toBe('verify');
  });

  test('a window that still holds a workspace the run did not open stays open and says why', async () => {
    const model = oneWindow([{n: 1, screens: [idleClaude(sid(1))]}]);
    model.windows[0]?.workspaces.push({
      id: wsId(77),
      panes: [
        {
          id: surfId(77),
          ref: 'surface:77',
          screens: [IDLE_SHELL],
          tty: 'ttys077',
        },
      ],
      ref: 'workspace:77',
    });
    const w = world({
      model,
      procs: [claudeProc(1)],
      record: [{sessions: [1], window: 1}],
    });
    const result = await undoOpen(w.options, w.deps);
    expect(closes(w)).toEqual([
      `close-workspace ${wsId(1)} --window ${winId(1)}`,
    ]);
    expect(result.state?.windowsLeft[0]?.reason).toContain('did not open');
  });

  test('a second undo of the same record keeps the first under previousUndos', async () => {
    const w = world({
      model: oneWindow([{n: 1, screens: [idleClaude(sid(1))]}]),
      procs: [claudeProc(1)],
      record: [{sessions: [1], window: 1}],
    });
    await undoOpen(w.options, w.deps);
    const second = await undoOpen(w.options, w.deps);
    expect(second.state?.gone.map((entry) => entry.sessionId)).toEqual([
      sid(1),
    ]);
    const onDisk = JSON.parse(readFileSync(w.recordPath, 'utf8')) as {
      previousUndos?: unknown[];
    };
    expect(onDisk.previousUndos).toHaveLength(1);
  });
});

describe('never signalling a process this run did not start', () => {
  test('a claude whose command line names another session (restarted by hand) is kept, not signalled', async () => {
    const w = world({
      model: oneWindow([{n: 1, screens: [idleClaude(sid(1))]}]),
      procs: [
        {
          command: '/Users/jhaa/.local/bin/claude',
          onTerm: 'exit',
          pid: 1001,
          tty: 'ttys01',
        },
      ],
      record: [{sessions: [1], window: 1}],
    });
    const result = await undoOpen(w.options, w.deps);
    expect(kills(w)).toEqual([]);
    expect(closes(w)).toEqual([]);
    expect(result.state?.kept[0]?.reason).toContain('not started by this run');
  });

  test('a tty that another pane also reports keeps the workspace (a dead surface can keep a reused tty)', async () => {
    const model = oneWindow([{n: 1, screens: [idleClaude(sid(1))]}]);
    model.windows.push({
      id: winId(9),
      ref: 'window:9',
      workspaces: [
        {
          id: wsId(90),
          panes: [
            {
              id: surfId(90),
              ref: 'surface:90',
              screens: [IDLE_SHELL],
              tty: 'ttys01',
            },
          ],
          ref: 'workspace:90',
        },
      ],
    });
    const w = world({
      model,
      procs: [claudeProc(1)],
      record: [{sessions: [1], window: 1}],
    });
    const result = await undoOpen(w.options, w.deps);
    expect(kills(w)).toEqual([]);
    expect(closes(w)).toEqual([]);
    expect(result.state?.kept[0]?.reason).toContain('other pane also report');
  });
});

describe('--dry-run', () => {
  test('runs every gate, closes nothing, signals nothing, rewrites no record and stores no draft', async () => {
    const w = world({
      model: oneWindow([
        {n: 1, screens: [idleClaude(sid(1))]},
        {n: 2, screens: [draftClaude(sid(2), 'unsent words')]},
      ]),
      options: {dryRun: true},
      procs: [claudeProc(1), claudeProc(2)],
      record: [{sessions: [1, 2], window: 1}],
    });
    const before = readFileSync(w.recordPath, 'utf8');
    const result = await undoOpen(w.options, w.deps);
    expect(result.exitCode).toBe(0);
    expect(w.events).toEqual([]);
    expect(readFileSync(w.recordPath, 'utf8')).toBe(before);
    expect(
      existsSync(inputDraftsDir({JUSTIN_THREADS_STATE_DIR: w.stateDir})),
    ).toBe(false);
    expect(result.state?.planned.map((entry) => entry.sessionId)).toEqual([
      sid(1),
    ]);
    expect(result.state?.kept[0]?.draft).toBe('unsent words');
    expect(result.output).toContain('Would close (1)');
    expect(result.output).toContain('not stored (dry run)');
  });
});

describe('--include-open runs: moved workspaces go back first (home-base-yukaf.22)', () => {
  /**
   * The run's window 1 holds what it opened (session 1) and what it moved
   * in (session 9, from window 2, where it was on top, above session 5).
   */
  function movedWorld(over: {options?: Partial<UndoOptions>} = {}): World {
    const pane = (n: number): Pane => ({
      id: surfId(n),
      ref: `surface:${n}`,
      screens: [idleClaude(sid(n))],
      tty: `ttys0${n}`,
    });
    return world({
      model: {
        windows: [
          {
            id: winId(1),
            ref: 'window:1',
            workspaces: [
              {id: wsId(9), panes: [pane(9)], ref: 'workspace:9'},
              {id: wsId(1), panes: [pane(1)], ref: 'workspace:1'},
            ],
          },
          {
            id: winId(2),
            ref: 'window:2',
            workspaces: [{id: wsId(5), panes: [pane(5)], ref: 'workspace:5'}],
          },
        ],
      },
      options: over.options,
      procs: [claudeProc(1), claudeProc(9), claudeProc(5)],
      record: [{sessions: [1], window: 1}],
      recordExtra: {
        moved: [
          {
            failure: null,
            fromIndex: 0,
            fromWindowCount: 2,
            fromWindowId: winId(2),
            fromWindowRef: 'window:2',
            movedAt: RUN_AT,
            name: '[A] session 9',
            sessionId: sid(9),
            toWindowId: winId(1),
            workspaceId: wsId(9),
          },
        ],
      },
    });
  }

  test('the moved workspace goes back to its window and position BEFORE anything is signalled or closed; it is never signalled', async () => {
    const w = movedWorld();
    const result = await undoOpen(w.options, w.deps);
    expect(result.exitCode).toBe(0);
    expect(w.events).toEqual([
      'record',
      `move ${wsId(9)} --window ${winId(2)}`,
      `reorder ${wsId(9)},${wsId(5)} --window ${winId(2)}`,
      'record',
      'kill 1001',
      `close-workspace ${wsId(1)} --window ${winId(1)}`,
      'record',
      'record',
    ]);
    // Back on top of window 2, still running (pid 1009 never signalled).
    expect(
      w.model.windows
        .find((entry) => entry.id === winId(2))
        ?.workspaces.map((entry) => entry.id),
    ).toEqual([wsId(9), wsId(5)]);
    expect(kills(w)).toEqual(['kill 1001']);
    expect(result.state?.movedBack).toEqual([
      {
        name: '[A] session 9',
        position: 'restored',
        sessionId: sid(9),
        windowId: winId(2),
        windowRef: 'window:2',
        workspaceId: wsId(9),
      },
    ]);
    expect(result.output).toContain('Moved back (1)');
    // The run's window emptied of ours, so it closed with its last workspace.
    expect(result.state?.windowsClosed).toEqual([winId(1)]);
  });

  test('--dry-run says what would move back and moves nothing', async () => {
    const w = movedWorld({options: {dryRun: true}});
    const result = await undoOpen(w.options, w.deps);
    expect(result.exitCode).toBe(0);
    expect(w.events).toEqual([]);
    expect(result.output).toContain('Would move back (1)');
    expect(result.state?.movedBack[0]?.position).toBe('would be restored');
  });

  test('a moved workspace that is no longer in the run window, or whose old window closed, is left where it is', async () => {
    const elsewhere = movedWorld();
    // Justin moved it to window 2 himself already: nothing to move back.
    const [first] = elsewhere.model.windows;
    const moved = first?.workspaces.shift();
    if (moved != null) elsewhere.model.windows[1]?.workspaces.push(moved);
    const one = await undoOpen(elsewhere.options, elsewhere.deps);
    expect(one.state?.movedBack).toEqual([]);
    expect(one.state?.notMovedBack[0]?.reason).toContain(
      'already in window:2, where it came from',
    );
    expect(elsewhere.events.some((event) => event.startsWith('move '))).toBe(
      false,
    );

    const orphan = movedWorld();
    orphan.model.windows = orphan.model.windows.filter(
      (window) => window.id !== winId(2),
    );
    const two = await undoOpen(orphan.options, orphan.deps);
    expect(two.state?.notMovedBack[0]?.reason).toContain(
      'the window it came from (window:2) is closed now',
    );
    expect(orphan.events.some((event) => event.startsWith('move '))).toBe(
      false,
    );
  });

  test('G10: a move whose cmux call failed but happened (movedAt null, failure set) is still moved back by --undo', async () => {
    const w = movedWorld();
    // The record as thread open leaves it when the call fails after the move.
    const raw = JSON.parse(readFileSync(w.recordPath, 'utf8')) as {
      moved: Record<string, unknown>[];
    };
    raw.moved = raw.moved.map((entry) => ({
      ...entry,
      failure: 'cmux move-workspace-to-window timed out after 4000 ms',
      movedAt: null,
    }));
    writeFileSync(w.recordPath, JSON.stringify(raw));
    const result = await undoOpen(w.options, w.deps);
    expect(result.exitCode).toBe(0);
    expect(w.events.slice(0, 3)).toEqual([
      'record',
      `move ${wsId(9)} --window ${winId(2)}`,
      `reorder ${wsId(9)},${wsId(5)} --window ${winId(2)}`,
    ]);
    expect(result.state?.movedBack.map((entry) => entry.workspaceId)).toEqual([
      wsId(9),
    ]);
    expect(kills(w)).toEqual(['kill 1001']);
  });
});

describe('G3: the blank workspace cmux leaves when a window loses its last workspace (home-base-yukaf.25)', () => {
  /**
   * Session 9's workspace was window 2's only one (fromWindowCount 1), so
   * cmux left a blank workspace (50) there; the run's window 1 holds 9 and
   * what it opened (session 1).
   */
  function blankWorld(
    over: {
      blank?: Partial<Pane>;
      extra?: boolean;
      options?: Partial<UndoOptions>;
      procs?: Proc[];
    } = {},
  ): World {
    const pane = (n: number): Pane => ({
      id: surfId(n),
      ref: `surface:${n}`,
      screens: [idleClaude(sid(n))],
      tty: `ttys0${n}`,
    });
    return world({
      model: {
        windows: [
          {
            id: winId(1),
            ref: 'window:1',
            workspaces: [
              {id: wsId(9), panes: [pane(9)], ref: 'workspace:9'},
              {id: wsId(1), panes: [pane(1)], ref: 'workspace:1'},
            ],
          },
          {
            id: winId(2),
            ref: 'window:2',
            workspaces: [
              {
                id: wsId(50),
                panes: [
                  {
                    id: surfId(50),
                    ref: 'surface:50',
                    screens: [IDLE_SHELL],
                    tty: 'ttys050',
                    ...over.blank,
                  },
                ],
                ref: 'workspace:50',
              },
              ...(over.extra === true
                ? [
                    {
                      id: wsId(51),
                      panes: [
                        {
                          id: surfId(51),
                          ref: 'surface:51',
                          screens: [IDLE_SHELL],
                          tty: 'ttys051',
                        },
                      ],
                      ref: 'workspace:51',
                    },
                  ]
                : []),
            ],
          },
        ],
      },
      options: over.options,
      procs: [claudeProc(1), claudeProc(9), ...(over.procs ?? [])],
      record: [{sessions: [1], window: 1}],
      recordExtra: {
        moved: [
          {
            failure: null,
            fromIndex: 0,
            fromWindowCount: 1,
            fromWindowId: winId(2),
            fromWindowRef: 'window:2',
            movedAt: RUN_AT,
            name: '[A] session 9',
            sessionId: sid(9),
            toWindowId: winId(1),
            workspaceId: wsId(9),
          },
        ],
      },
    });
  }

  const windowTwo = (w: World): string[] | undefined =>
    w.model.windows
      .find((entry) => entry.id === winId(2))
      ?.workspaces.map((entry) => entry.id);

  test('after the move back, the blank workspace holding only an idle shell is closed, before anything of the run is signalled', async () => {
    const w = blankWorld();
    const result = await undoOpen(w.options, w.deps);
    expect(result.exitCode).toBe(0);
    expect(w.events.slice(0, 6)).toEqual([
      'record',
      `move ${wsId(9)} --window ${winId(2)}`,
      `reorder ${wsId(9)},${wsId(50)} --window ${winId(2)}`,
      'record',
      `close-workspace ${wsId(50)} --window ${winId(2)}`,
      'record',
    ]);
    expect(windowTwo(w)).toEqual([wsId(9)]);
    expect(result.state?.blank).toEqual([
      {
        outcome: 'closed',
        reason: 'it held only an idle shell',
        windowId: winId(2),
        windowRef: 'window:2',
        workspaceId: wsId(50),
      },
    ]);
    expect(result.output).toContain('Closed the blank workspace in window:2');
  });

  test('a dry run says it would close it and writes nothing', async () => {
    const w = blankWorld({options: {dryRun: true}});
    const result = await undoOpen(w.options, w.deps);
    expect(result.exitCode).toBe(0);
    expect(w.events).toEqual([]);
    expect(result.state?.blank[0]?.outcome).toBe('wouldClose');
    expect(result.output).toContain(
      'Would close the blank workspace in window:2',
    );
  });

  test('the gate: something running on it, a screen that is not an idle shell, or a second other workspace each keep it, with why', async () => {
    const busy = blankWorld({
      procs: [
        {command: 'vim notes.md', onTerm: 'exit', pid: 3050, tty: 'ttys050'},
      ],
    });
    const one = await undoOpen(busy.options, busy.deps);
    expect(busy.events).not.toContain(
      `close-workspace ${wsId(50)} --window ${winId(2)}`,
    );
    expect(one.state?.blank[0]).toMatchObject({
      outcome: 'kept',
      workspaceId: wsId(50),
    });
    expect(one.state?.blank[0]?.reason).toContain('is running vim notes.md');

    const typed = blankWorld({blank: {screens: ['❯ rm -rf build']}});
    const two = await undoOpen(typed.options, typed.deps);
    expect(windowTwo(typed)).toContain(wsId(50));
    expect(two.state?.blank[0]?.reason).toContain('idle shell prompt');

    const crowded = blankWorld({extra: true});
    const three = await undoOpen(crowded.options, crowded.deps);
    expect(windowTwo(crowded)).toEqual([wsId(9), wsId(50), wsId(51)]);
    expect(three.state?.blank[0]?.reason).toBe(
      'it holds 2 other workspaces now, so which one cmux left blank cannot be told',
    );
    expect(three.output).toContain('Left the blank workspace in window:2');
  });

  test('a move back that did not happen leaves the blank workspace: it would be the last one, and closing it would close the window', async () => {
    const w = blankWorld();
    // Justin closed the moved workspace himself: nothing goes back.
    const [first] = w.model.windows;
    if (first != null) {
      first.workspaces = first.workspaces.filter(
        (entry) => entry.id !== wsId(9),
      );
    }
    const result = await undoOpen(w.options, w.deps);
    expect(windowTwo(w)).toEqual([wsId(50)]);
    expect(result.state?.blank[0]?.reason).toContain(
      'closing it would close the window',
    );
  });
});
