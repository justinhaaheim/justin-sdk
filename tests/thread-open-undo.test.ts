/**
 * `thread open --undo` (home-base-yukaf.2). cmux is a fake runner holding a
 * tiny model of windows, workspaces and panes (each pane: a tty and a list of
 * screens, one per read); ps, `ps -p`, kill, the clock and transcript
 * activity are fakes too. Every outside effect is appended to one event log,
 * so the tests can assert ORDER (the record before the first SIGTERM, SIGTERM
 * before close-workspace). No test reaches the real cmux, ps or any process
 * (D-NO-LIVE-RUNS).
 */

import type {CloseLogLine} from '../src/thread/close';
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
import {joinLiveSessions} from '../src/thread/live-sessions';
import {opensDir, writeJsonFile} from '../src/thread/open';
import {gatePane, recordFileName, undoOpen} from '../src/thread/open-undo';
import {
  flattenTree,
  NO_BREAK_SPACE,
  parseProcessList,
  scrolledBoxText,
} from '../src/thread/pane-join';

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
    workspaces: {
      id: string;
      panes: Pane[];
      /**
       * cmux tree's `pinned` (home-base-kwand.20); absent means false, as
       * real cmux reports it; null leaves it out of the tree.
       */
      pinned?: boolean | null;
      ref: string;
    }[];
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
  /** home-base-kwand.11: cmux refuses close-surface with this message. */
  refuseCloseSurface?: string;
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
                ...(workspace.pinned === null
                  ? {}
                  : {pinned: workspace.pinned ?? false}),
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
          return {
            kind: 'failed',
            reason: `no surface ${target}`,
            timedOut: false,
          };
        const index = reads.get(pane.id) ?? 0;
        reads.set(pane.id, index + 1);
        if (args.includes('--scrollback')) {
          events.push(`read-screen ${target} --scrollback`);
        }
        const screen =
          pane.screens[Math.min(index, pane.screens.length - 1)] ?? null;
        return screen == null
          ? {
              kind: 'failed',
              reason: 'read-screen failed: surface not ready',
              timedOut: false,
            }
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
          return {
            kind: 'failed',
            reason: 'no such workspace or window',
            timedOut: false,
          };
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
        if (window == null)
          return {kind: 'failed', reason: 'no such window', timedOut: false};
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
      if (args[0] === 'close-surface') {
        const target = value(args, '--surface');
        events.push(
          `close-surface ${target} --workspace ${value(args, '--workspace')}`,
        );
        if (input.refuseCloseSurface != null) {
          return {
            kind: 'failed',
            reason: input.refuseCloseSurface,
            timedOut: false,
          };
        }
        for (const window of input.model.windows) {
          for (const workspace of window.workspaces) {
            workspace.panes = workspace.panes.filter(
              (pane) => pane.id !== target,
            );
          }
        }
        return {kind: 'ok', stdout: 'OK\n'};
      }
      return {
        kind: 'failed',
        reason: `the fake does not know ${args.join(' ')}`,
        timedOut: false,
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
  const ps = (): Promise<{kind: 'ok'; stdout: string}> =>
    Promise.resolve({kind: 'ok', stdout: psText()});
  // home-base-kwand.11: thread close --tab's live-session join, over the
  // same model (screens as the next read would see them, without reading).
  const readLive: UndoDeps['readLive'] = async () => {
    const tree = await run(['tree', '--json']);
    const raw =
      tree.kind === 'ok'
        ? (JSON.parse(tree.stdout) as Parameters<typeof flattenTree>[0])
        : {windows: []};
    return {
      kind: 'read' as const,
      ...joinLiveSessions({
        agents: [],
        procs: parseProcessList(psText()),
        screens: new Map(
          allPanes().map((pane) => {
            const text =
              pane.screens[
                Math.min(reads.get(pane.id) ?? 0, pane.screens.length - 1)
              ] ?? null;
            return [
              pane.ref,
              text == null
                ? {kind: 'unreadable' as const, reason: 'not ready'}
                : {kind: 'read' as const, text},
            ];
          }),
        ),
        store: {},
        surfaces: flattenTree(raw),
      }),
    };
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
    appendLog: (line) => {
      events.push(
        `log ${line.surfaceId ?? line.workspaceId} ${line.outcome.split(':')[0]}`,
      );
      return null;
    },
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
    readHookStore: () => ({ok: true, value: {}}),
    readLive,
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
      procs: [
        claudeProc(1),
        claudeProc(9),
        // home-base-kwand.20 item 4: the blank workspace's shell runs on its
        // tty, as on a live terminal; a tty with no process keeps it now.
        {
          command: 'login -pflq jhaa /bin/zsh',
          onTerm: 'exit',
          pid: 2050,
          tty: 'ttys050',
        },
        {command: '-zsh', onTerm: 'exit', pid: 2051, tty: 'ttys050'},
        ...(over.procs ?? []),
      ],
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

  test('home-base-kwand.20 item 4: a blank screen, or a tty with no process at all, keeps the blank workspace', async () => {
    const blankScreen = blankWorld({blank: {screens: ['']}});
    const one = await undoOpen(blankScreen.options, blankScreen.deps);
    expect(one.state?.blank[0]?.outcome).toBe('kept');
    expect(one.state?.blank[0]?.reason).toContain(
      'pane surface:50 shows a blank screen',
    );
    expect(closes(blankScreen)).not.toContain(
      `close-workspace ${wsId(50)} --window ${winId(2)}`,
    );
    const noProcess = blankWorld({blank: {tty: 'ttys059'}});
    const two = await undoOpen(noProcess.options, noProcess.deps);
    expect(two.state?.blank[0]?.outcome).toBe('kept');
    expect(two.state?.blank[0]?.reason).toContain(
      'no process at all runs on tty ttys059, which pane surface:50 reports',
    );
  });
});

describe('home-base-kwand.20: pinned workspaces and unseen panes', () => {
  const shells = (n: number): Proc[] => [
    {
      command: 'login -pflq jhaa /bin/zsh',
      onTerm: 'exit',
      pid: 2000 + n * 10,
      tty: `ttys0${n}`,
    },
    {command: '-zsh', onTerm: 'exit', pid: 2001 + n * 10, tty: `ttys0${n}`},
  ];
  const pinnedWorld = (pinned: boolean | null): World => {
    const model = oneWindow([{n: 1, screens: [idleClaude(sid(1))]}]);
    const first = model.windows[0]?.workspaces[0];
    if (first == null) throw new Error('no workspace 1');
    first.pinned = pinned;
    return world({
      model,
      procs: [claudeProc(1)],
      record: [{sessions: [1], window: 1}],
    });
  };

  test('item 1: a pinned workspace is kept before any SIGTERM; an unreported pinned state keeps it too (rule 7)', async () => {
    for (const [pinned, starts] of [
      [true, 'pinned: cmux refuses to close a pinned workspace'],
      [null, 'pinned?: '],
    ] as const) {
      const w = pinnedWorld(pinned);
      const result = await undoOpen(w.options, w.deps);
      expect(kills(w)).toEqual([]);
      expect(closes(w)).toEqual([]);
      expect(result.state?.planned).toEqual([]);
      expect(result.state?.kept[0]?.reasons[0]).toStartWith(starts);
    }
  });

  test('item 1: pinned between the plan and its turn: the check right before SIGTERM keeps it, nothing signalled or closed', async () => {
    const w = pinnedWorld(false);
    const result = await undoOpen(w.options, {
      ...w.deps,
      writeRecord: (path, recordValue) => {
        const first = w.model.windows[0]?.workspaces[0];
        if (first != null) first.pinned = true;
        return w.deps.writeRecord?.(path, recordValue) ?? null;
      },
    });
    expect(result.state?.planned.map((entry) => entry.workspaceId)).toEqual([
      wsId(1),
    ]);
    expect(kills(w)).toEqual([]);
    expect(closes(w)).toEqual([]);
    expect(result.state?.kept[0]?.reasons[0]).toStartWith('pinned: ');
  });

  test('item 4: a pane whose tty runs no process at all is kept, never closed unsignalled', async () => {
    const w = world({
      model: oneWindow([{n: 1, screens: [IDLE_SHELL]}]),
      record: [{sessions: [1], window: 1}],
    });
    const result = await undoOpen(w.options, w.deps);
    expect(closes(w)).toEqual([]);
    expect(result.state?.kept[0]?.reason).toContain(
      'no process at all runs on tty ttys01, which pane surface:1 reports',
    );
  });

  test('item 4, at the re-check: the plan saw an idle prompt, the check right before closing sees a blank screen: kept, nothing closed', async () => {
    const w = world({
      model: oneWindow([{n: 1, screens: [IDLE_SHELL, '']}]),
      procs: shells(1),
      record: [{sessions: [1], window: 1}],
    });
    const result = await undoOpen(w.options, w.deps);
    expect(result.state?.planned.map((entry) => entry.workspaceId)).toEqual([
      wsId(1),
    ]);
    expect(closes(w)).toEqual([]);
    expect(result.state?.kept[0]?.reason).toContain(
      'pane surface:1 shows a blank screen',
    );
  });
});

// ---------------------------------------------------------------------------
// home-base-kwand.11: --close-tabs closes the tabs --restore-failed opened in
// old workspaces, through thread close --tab's pipeline. Old workspace 50
// holds the tab whose restore failed (surface 9, an idle shell showing cmux's
// error) and the tab the run opened (surface 5, session 5).
// ---------------------------------------------------------------------------

const RESTORE_FAILED_SHELL = [
  'Error: Session restore failed: no conversation found',
  '',
  ' jhaa  home-base  main',
  '❯',
].join('\n');

function shellProc(pid: number, tty: string): Proc {
  return {command: '-zsh', onTerm: 'exit', pid, tty};
}

const TAB_RECORD = {
  name: '[A] session 5',
  openedAt: RUN_AT,
  sessionId: sid(5),
  surfaceId: surfId(5),
  target: 'oldWorkspace',
  workspaceId: wsId(50),
};

function tabWorld(
  input: {
    activity?: Record<string, ActivityTimes>;
    closeTabs?: boolean;
    dryRun?: boolean;
    /** The run's tab: its screens and tty (default: idle Claude of session 5). */
    newTab?: {screens?: (string | null)[]; tty?: string | null};
    /** Keep the tab whose restore failed (default true). */
    oldTab?: boolean;
    /** A third tab in the old workspace. */
    otherTab?: boolean;
    pinned?: boolean;
    procs?: Proc[];
    refuseCloseSurface?: string;
    tab?: Record<string, unknown>;
  } = {},
): World {
  const panes: Pane[] = [
    ...(input.oldTab === false
      ? []
      : [
          {
            id: surfId(9),
            ref: 'surface:9',
            screens: [RESTORE_FAILED_SHELL],
            tty: 'ttys09',
          },
        ]),
    {
      id: surfId(5),
      ref: 'surface:5',
      screens: input.newTab?.screens ?? [idleClaude(sid(5))],
      tty: input.newTab?.tty === undefined ? 'ttys05' : input.newTab.tty,
    },
    ...(input.otherTab === true
      ? [
          {
            id: surfId(7),
            ref: 'surface:7',
            screens: [IDLE_SHELL],
            tty: 'ttys07',
          },
        ]
      : []),
  ];
  return world({
    ...(input.activity == null ? {} : {activity: input.activity}),
    model: {
      windows: [
        {
          id: winId(2),
          ref: 'window:2',
          workspaces: [
            {
              id: wsId(50),
              panes,
              ...(input.pinned == null ? {} : {pinned: input.pinned}),
              ref: 'workspace:50',
            },
          ],
        },
      ],
    },
    options: {
      ...(input.closeTabs === false ? {} : {closeTabs: true}),
      dryRun: input.dryRun ?? false,
    },
    procs: input.procs ?? [
      shellProc(509, 'ttys09'),
      shellProc(505, 'ttys05'),
      claudeProc(5),
      shellProc(507, 'ttys07'),
    ],
    record: [],
    recordExtra: {tabs: [{...TAB_RECORD, ...input.tab}]},
    ...(input.refuseCloseSurface == null
      ? {}
      : {refuseCloseSurface: input.refuseCloseSurface}),
  });
}

/** Every cmux close call, of any kind. */
const anyClose = (w: World): string[] =>
  w.events.filter((event) => event.startsWith('close-'));

/**
 * The Run line prints the run's time in the process's local timezone, and bun
 * runs every test file in one process, where another file may set TZ. The pin
 * was captured in UTC; this is RUN_AT as the Run line prints it here,
 * computed independently of the code under test.
 */
const UTC_RUN_STAMP = '(2026-10-18 12:00)';
function localRunStamp(): string {
  const at = new Date(RUN_MS);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `(${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())})`;
}

/** Captured from the code before home-base-kwand.11 (HEAD fbabb12a), in UTC. */
const KNOB_OFF_OUTPUT =
  "  🧹 thread open --undo: close what one run of thread open opened\n\n      Mode:    closing\n      Run:     1 hour ago (2026-10-18 12:00)\n      Record:  <state>/opens/2026-10-18T12-00-00.000Z.json\n      Gates:   an empty input box (one showing only Claude Code's suggestion counts as empty), Claude not working, no activity since the run (else kept)\n\n  🧹 Closed (0)\n\n      Nothing.\n\n  🚧 Not closed: tabs opened in an old workspace (1)\n\n      [A] session 5\n          Session:    00000005-1111-4222-8333-000000000000\n          Workspace:  C0000050-AAAA-4AAA-8AAA-AAAAAAAAAAAA\n          Why:        it was opened as a new tab of its old workspace C0000050-AAAA-4AAA-8AAA-AAAAAAAAAAAA, and --undo closes only whole workspaces it opened (closing that one would close the other tabs there). Close the tab by hand (surface E0000005-AAAA-4AAA-8AAA-AAAAAAAAAAAA).\n\n  Closed 0, kept 0, 1 tab to close by hand, already gone 0.";
const KNOB_OFF_KEYS: string[] = [
  'blank',
  'closed',
  'dryRun',
  'failed',
  'failures',
  'finishedAt',
  'gone',
  'kept',
  'movedBack',
  'notClosed',
  'notMovedBack',
  'planned',
  'startedAt',
  'windowsClosed',
  'windowsLeft',
];
describe('home-base-kwand.11: --close-tabs closes the tabs --restore-failed opened in old workspaces', () => {
  test('a tab whose checks pass: record, closing line, SIGTERM, then close-surface naming its surface and workspace uuid; the tree shows it gone', async () => {
    const w = tabWorld({otherTab: true});
    const result = await undoOpen(w.options, w.deps);
    expect(w.events.filter((event) => !event.startsWith('read-'))).toEqual([
      'record',
      'record',
      `log ${surfId(5)} closing`,
      'kill 1005',
      `close-surface ${surfId(5)} --workspace ${wsId(50)}`,
      `log ${surfId(5)} closed`,
      'record',
      'record',
    ]);
    // The tab whose restore failed and the third tab are never named in a close.
    expect(anyClose(w)).toEqual([
      `close-surface ${surfId(5)} --workspace ${wsId(50)}`,
    ]);
    expect(
      w.model.windows[0]?.workspaces[0]?.panes.map((pane) => pane.id),
    ).toEqual([surfId(9), surfId(7)]);
    expect(
      result.state?.tabs?.closed.map((entry) => entry.tab?.surfaceId),
    ).toEqual([surfId(5)]);
    expect(result.state?.failures).toEqual([]);
    expect(result.state?.notClosed).toEqual([]);
    expect(result.output).toContain(
      'Closed tabs opened in an old workspace (1)',
    );
    expect(result.output).toContain(
      "cd '/Users/x/Dev/repo-a' && claude --resume",
    );
    expect(result.exitCode).toBe(0);
  });

  test('close-surface answers OK but the tab is still listed: failed at step verify, never "closed", in the output or the record; exit 1 (home-base-kwand.31 F4)', async () => {
    const w = tabWorld();
    const run = w.deps.run;
    if (run == null) throw new Error('no run');
    // cmux answers OK to close-surface and keeps the surface.
    w.deps.run = async (args) =>
      args[0] === 'close-surface'
        ? await Promise.resolve({kind: 'ok' as const, stdout: 'OK\n'})
        : await run(args);
    const result = await undoOpen(w.options, w.deps);
    expect(kills(w)).toEqual(['kill 1005']);
    expect(result.state?.tabs?.closed).toEqual([]);
    const failed = result.state?.tabs?.failed ?? [];
    expect(failed.map((entry) => entry.tab?.surfaceId)).toEqual([surfId(5)]);
    expect(failed[0]?.step).toBe('verify');
    expect(failed[0]?.claudeStopped).toBe(true);
    expect(failed[0]?.reason).toContain(
      `close-surface answered OK, but tab surface:5 (${surfId(5)}) is still open`,
    );
    expect(failed[0]).not.toHaveProperty('closedAt');
    expect(result.output).toContain('Tabs not closed: a step failed (1)');
    expect(result.output).toContain(
      'Closed tabs opened in an old workspace (0)',
    );
    const onDisk = JSON.parse(readFileSync(w.recordPath, 'utf8')) as {
      undo?: {tabs?: {closed?: unknown[]; failed?: unknown[]}};
    };
    expect(onDisk.undo?.tabs?.closed).toEqual([]);
    expect(onDisk.undo?.tabs?.failed).toHaveLength(1);
    expect(result.exitCode).toBe(1);
  });

  /** Every line the close log is asked to append, in order. */
  const captureLog = (w: World): CloseLogLine[] => {
    const lines: CloseLogLine[] = [];
    const append = w.deps.appendLog;
    if (append == null) throw new Error('no appendLog');
    w.deps.appendLog = (line) => {
      lines.push(line);
      return append(line);
    };
    return lines;
  };

  test('home-base-kwand.30 R1: that tab gets one more closes-log line, failed: verify, after its closed line', async () => {
    const w = tabWorld();
    const run = w.deps.run;
    if (run == null) throw new Error('no run');
    // cmux answers OK to close-surface and keeps the surface.
    w.deps.run = async (args) =>
      args[0] === 'close-surface'
        ? await Promise.resolve({kind: 'ok' as const, stdout: 'OK\n'})
        : await run(args);
    const lines = captureLog(w);
    const result = await undoOpen(w.options, w.deps);
    expect(result.exitCode).toBe(1);
    expect(
      lines
        .filter((line) => line.surfaceId === surfId(5))
        .map((line) => line.outcome),
    ).toEqual([
      'closing',
      'closed',
      `failed: verify: close-surface answered OK, but tab surface:5 (${surfId(5)}) is still open 5 s later`,
    ]);
  });

  test('home-base-kwand.30 R2: the tree cannot be read after the close: failed at step verify naming the unreadable tree, never closed, in the output or the record; exit 1', async () => {
    const w = tabWorld();
    const run = w.deps.run;
    if (run == null) throw new Error('no run');
    let closed = false;
    w.deps.run = async (args) => {
      if (args[0] === 'close-surface') closed = true;
      return closed && args.includes('tree')
        ? await Promise.resolve({
            kind: 'failed' as const,
            reason: 'Error: Command timed out',
            timedOut: true,
          })
        : await run(args);
    };
    const lines = captureLog(w);
    const result = await undoOpen(w.options, w.deps);
    expect(kills(w)).toEqual(['kill 1005']);
    expect(result.state?.tabs?.closed).toEqual([]);
    const failed = result.state?.tabs?.failed ?? [];
    expect(failed.map((entry) => entry.tab?.surfaceId)).toEqual([surfId(5)]);
    expect(failed[0]?.step).toBe('verify');
    expect(failed[0]?.claudeStopped).toBe(true);
    expect(failed[0]?.reason).toBe(
      `close-surface answered OK, but whether tab surface:5 (${surfId(5)}) is gone could not be checked within 5 s: the cmux tree could not be read (Error: Command timed out)`,
    );
    expect(result.state?.failures).toEqual([]);
    expect(result.output).toContain('Tabs not closed: a step failed (1)');
    expect(result.output).toContain(
      'Closed tabs opened in an old workspace (0)',
    );
    expect(lines.map((line) => line.outcome.split(':')[0])).toEqual([
      'closing',
      'closed',
      'failed',
    ]);
    const onDisk = JSON.parse(readFileSync(w.recordPath, 'utf8')) as {
      undo?: {tabs?: {closed?: unknown[]; failed?: unknown[]}};
    };
    expect(onDisk.undo?.tabs?.closed).toEqual([]);
    expect(onDisk.undo?.tabs?.failed).toHaveLength(1);
    expect(result.exitCode).toBe(1);
  });

  const keptCases: {
    name: string;
    setup: Parameters<typeof tabWorld>[0];
    why: string;
  }[] = [
    {
      name: 'unsent text',
      setup: {newTab: {screens: [draftClaude(sid(5), 'half a thought')]}},
      why: 'unsent text in the input box of pane surface:5',
    },
    {
      name: 'Claude working',
      setup: {newTab: {screens: [workingClaude(sid(5))]}},
      why: 'Claude is working in pane surface:5',
    },
    {
      name: 'activity since the run',
      setup: {
        activity: {
          [sid(5)]: {
            kind: 'known',
            lastMs: RUN_MS + 60_000,
            startedMs: RUN_MS - 86_400_000,
          },
        },
      },
      why: 'it was used after the run opened it',
    },
    {
      name: 'another session on its screen',
      setup: {newTab: {screens: [idleClaude(sid(6))]}},
      why: `surface:5 shows session ${sid(6)}, not ${sid(5)}`,
    },
    {
      name: 'a blank screen',
      setup: {newTab: {screens: ['']}},
      why: 'pane surface:5 shows a blank screen',
    },
    {
      name: 'no process on its tty',
      setup: {
        newTab: {screens: [IDLE_SHELL]},
        procs: [shellProc(509, 'ttys09')],
      },
      why: 'no process at all runs on tty ttys05, which pane surface:5 reports',
    },
    {
      name: 'a pinned workspace',
      setup: {pinned: true},
      why: 'pinned',
    },
  ];
  for (const each of keptCases) {
    test(`kept, with the reason: ${each.name}; nothing signalled or closed`, async () => {
      const w = tabWorld(each.setup);
      const result = await undoOpen(w.options, w.deps);
      expect(kills(w)).toEqual([]);
      expect(anyClose(w)).toEqual([]);
      const kept = result.state?.tabs?.kept ?? [];
      expect(kept.map((entry) => entry.surfaceId)).toEqual([surfId(5)]);
      expect(kept[0]?.reasons.join('\n')).toContain(each.why);
      expect(result.output).toContain('Tabs kept open (1)');
      expect(result.state?.notClosed).toEqual([]);
    });
  }

  test('the recorded tab is now its workspace only tab: kept and named for closing by hand, never closed with the workspace', async () => {
    const w = tabWorld({oldTab: false});
    const result = await undoOpen(w.options, w.deps);
    expect(kills(w)).toEqual([]);
    expect(anyClose(w)).toEqual([]);
    expect(result.state?.notClosed.map((entry) => entry.surfaceId)).toEqual([
      surfId(5),
    ]);
    expect(result.state?.notClosed[0]?.reason).toContain(
      `it is the only tab of its old workspace ${wsId(50)} now`,
    );
    expect(result.output).toContain(
      'Not closed: tabs opened in an old workspace (1)',
    );
    expect(result.exitCode).toBe(1);
  });

  test('a recorded tab with no surface uuid stays named for closing by hand, as without the flag', async () => {
    const w = tabWorld({tab: {surfaceId: null}});
    const result = await undoOpen(w.options, w.deps);
    expect(kills(w)).toEqual([]);
    expect(anyClose(w)).toEqual([]);
    expect(result.state?.notClosed.map((entry) => entry.sessionId)).toEqual([
      sid(5),
    ]);
    expect(result.state?.notClosed[0]?.reason).toContain(
      'its surface uuid was not recorded',
    );
    expect(result.exitCode).toBe(1);
  });

  test('cmux refuses close-surface after the stop: STOPPED with the resume command, never closed, exit 1', async () => {
    const w = tabWorld({refuseCloseSurface: 'Error: surface is pinned'});
    const result = await undoOpen(w.options, w.deps);
    expect(kills(w)).toEqual(['kill 1005']);
    expect(result.state?.tabs?.closed).toEqual([]);
    expect(result.state?.tabs?.failed[0]?.claudeStopped).toBe(true);
    expect(result.output).toContain(
      'STOPPED (pid 1005) before the close failed: the tab is still open with no Claude in it',
    );
    expect(result.output).toContain(
      `cd '/Users/x/Dev/repo-a' && claude --resume ${sid(5)}`,
    );
    expect(result.output).not.toContain(
      'Closed tabs opened in an old workspace (1)',
    );
    expect(result.exitCode).toBe(1);
  });

  test('--dry-run with --close-tabs: says what would close, signals nothing, writes nothing', async () => {
    const w = tabWorld({dryRun: true});
    const result = await undoOpen(w.options, w.deps);
    expect(w.events.filter((event) => !event.startsWith('read-'))).toEqual([]);
    expect(result.output).toContain(
      'Would close tabs opened in an old workspace (1)',
    );
    expect(result.exitCode).toBe(0);
  });

  test('knob off (no --close-tabs): output, JSON and exit code exactly as before', async () => {
    const w = tabWorld({closeTabs: false, otherTab: true});
    const result = await undoOpen(w.options, w.deps);
    expect(kills(w)).toEqual([]);
    expect(anyClose(w)).toEqual([]);
    expect(result.exitCode).toBe(1);
    // Only the Run line's stamp follows the timezone; the rest is byte-exact.
    expect(KNOB_OFF_OUTPUT).toContain(`Run:     1 hour ago ${UTC_RUN_STAMP}`);
    expect(result.output.replaceAll(w.stateDir, '<state>')).toBe(
      KNOB_OFF_OUTPUT.replace(UTC_RUN_STAMP, localRunStamp()),
    );
    const json = await undoOpen({...w.options, json: true}, w.deps);
    expect(json.exitCode).toBe(1);
    expect(
      Object.keys((JSON.parse(json.output) as {undo: object}).undo),
    ).toEqual(KNOB_OFF_KEYS);
  });
});

/** Make the world's record write fail on its `n`th call (1-based). */
function failRecordWrite(w: World, n: number): void {
  const write = w.deps.writeRecord;
  if (write == null) throw new Error('no writeRecord');
  let calls = 0;
  w.deps.writeRecord = (path, value) => {
    calls += 1;
    return calls === n ? 'EACCES: permission denied' : write(path, value);
  };
}

/** Run `change` on the model when the close log gets its `closing` line: between the passes. */
function betweenPasses(w: World, change: (model: Model) => void): void {
  const log = w.deps.appendLog;
  if (log == null) throw new Error('no appendLog');
  w.deps.appendLog = (line) => {
    if (line.outcome === 'closing') change(w.model);
    return log(line);
  };
}

/** The old workspace 50 of a tab world. */
function workspace50(
  model: Model,
): Model['windows'][number]['workspaces'][number] {
  const found = model.windows
    .flatMap((window) => window.workspaces)
    .find((workspace) => workspace.id === wsId(50));
  if (found == null) throw new Error('no workspace 50');
  return found;
}

/**
 * home-base-kwand.31: a run that opened workspace 1, moved session 8's
 * workspace in from window 3 (its only one, so cmux left blank workspace 30
 * there), and opened two tabs (sessions 5 and 6) in old workspace 50. Its
 * record writes, in order: 1 before anything, 2 after the move back, 3 after
 * the blank workspace closes, 4 after workspace 1 closes, 5 before the first
 * tab's SIGTERM (beforeClose), 6 and 7 after each tab (afterEach), 8 last.
 */
function stopsEarlyWorld(): World {
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
            {id: wsId(8), panes: [pane(8)], ref: 'workspace:8'},
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
                  id: surfId(9),
                  ref: 'surface:9',
                  screens: [RESTORE_FAILED_SHELL],
                  tty: 'ttys09',
                },
                pane(5),
                pane(6),
              ],
              ref: 'workspace:50',
            },
          ],
        },
        {
          id: winId(3),
          ref: 'window:3',
          workspaces: [
            {
              id: wsId(30),
              panes: [
                {
                  id: surfId(30),
                  ref: 'surface:30',
                  screens: [IDLE_SHELL],
                  tty: 'ttys030',
                },
              ],
              ref: 'workspace:30',
            },
          ],
        },
      ],
    },
    options: {closeTabs: true},
    procs: [
      claudeProc(1),
      claudeProc(8),
      shellProc(509, 'ttys09'),
      shellProc(505, 'ttys05'),
      claudeProc(5),
      shellProc(506, 'ttys06'),
      claudeProc(6),
      {
        command: 'login -pflq jhaa /bin/zsh',
        onTerm: 'exit',
        pid: 2030,
        tty: 'ttys030',
      },
      shellProc(2031, 'ttys030'),
    ],
    record: [{sessions: [1], window: 1}],
    recordExtra: {
      moved: [
        {
          failure: null,
          fromIndex: 0,
          fromWindowCount: 1,
          fromWindowId: winId(3),
          fromWindowRef: 'window:3',
          movedAt: RUN_AT,
          name: '[A] session 8',
          sessionId: sid(8),
          toWindowId: winId(1),
          workspaceId: wsId(8),
        },
      ],
      tabs: [
        TAB_RECORD,
        {
          ...TAB_RECORD,
          name: '[A] session 6',
          sessionId: sid(6),
          surfaceId: surfId(6),
        },
      ],
    },
  });
}

const tabKills = (w: World): string[] =>
  kills(w).filter((event) => event === 'kill 1005' || event === 'kill 1006');
const surfaceCloses = (w: World): string[] =>
  w.events.filter((event) => event.startsWith('close-surface'));

describe('home-base-kwand.31: --close-tabs reports every recorded tab when the undo stops early or a tab changes between passes', () => {
  test('control: with every record write working, both tabs close and the undo exits 0', async () => {
    const w = stopsEarlyWorld();
    const result = await undoOpen(w.options, w.deps);
    expect(w.events.filter((event) => event === 'record')).toHaveLength(8);
    expect(surfaceCloses(w)).toEqual([
      `close-surface ${surfId(5)} --workspace ${wsId(50)}`,
      `close-surface ${surfId(6)} --workspace ${wsId(50)}`,
    ]);
    expect(result.state?.failures).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  const stops: {at: number; path: string; words: string}[] = [
    {
      at: 1,
      path: 'the first record write',
      words:
        'could not be rewritten before stopping anything, so nothing was signalled or closed',
    },
    {
      at: 2,
      path: 'the move back',
      words:
        'rewriting the record failed after moving workspaces back, so the undo stopped',
    },
    {
      at: 3,
      path: 'the blank workspace close',
      words:
        'rewriting the record failed after closing a blank workspace, so the undo stopped',
    },
    {
      at: 4,
      path: 'the workspace loop',
      words: '.json failed, so the undo stopped',
    },
  ];
  for (const stop of stops) {
    test(`F1: the undo stops at ${stop.path}: both recorded tabs are listed as kept, not attempted; none signalled or closed; exit 1`, async () => {
      const w = stopsEarlyWorld();
      failRecordWrite(w, stop.at);
      const result = await undoOpen(w.options, w.deps);
      expect(result.state?.failures.join('\n')).toContain(stop.words);
      expect(tabKills(w)).toEqual([]);
      expect(surfaceCloses(w)).toEqual([]);
      const kept = result.state?.tabs?.kept ?? [];
      expect(kept.map((entry) => entry.surfaceId)).toEqual([
        surfId(5),
        surfId(6),
      ]);
      for (const entry of kept) {
        expect(entry.reasons).toEqual([
          'not attempted: the undo stopped before the tabs',
        ]);
      }
      expect(result.output).toContain('Tabs kept open (2)');
      expect(result.output).toContain(
        'not attempted: the undo stopped before the tabs',
      );
      expect(result.exitCode).toBe(1);
    });
  }

  test("F5 (d), beforeClose: the record write before the first tab's SIGTERM fails: no tab signalled or closed, both kept, exit 1", async () => {
    const w = stopsEarlyWorld();
    failRecordWrite(w, 5);
    const result = await undoOpen(w.options, w.deps);
    expect(result.state?.failures.join('\n')).toContain(
      "could not be rewritten before stopping any tab's Claude, so no tab was signalled or closed",
    );
    expect(tabKills(w)).toEqual([]);
    expect(surfaceCloses(w)).toEqual([]);
    const kept = result.state?.tabs?.kept ?? [];
    expect(kept.map((entry) => entry.surfaceId)).toEqual([
      surfId(5),
      surfId(6),
    ]);
    expect(kept[0]?.reasons).toEqual(['the record could not be written first']);
    expect(result.exitCode).toBe(1);
  });

  test('F5 (d), afterEach: the record write after the first tab fails: the run stops, the second tab is not signalled or closed and is kept, exit 1', async () => {
    const w = stopsEarlyWorld();
    failRecordWrite(w, 6);
    const result = await undoOpen(w.options, w.deps);
    expect(result.state?.failures.join('\n')).toContain(
      'failed after closing a tab, so the undo stopped',
    );
    expect(tabKills(w)).toEqual(['kill 1005']);
    expect(surfaceCloses(w)).toEqual([
      `close-surface ${surfId(5)} --workspace ${wsId(50)}`,
    ]);
    expect(
      result.state?.tabs?.closed.map((entry) => entry.tab?.surfaceId),
    ).toEqual([surfId(5)]);
    const kept = result.state?.tabs?.kept ?? [];
    expect(kept.map((entry) => entry.surfaceId)).toEqual([surfId(6)]);
    expect(kept[0]?.reasons).toEqual([
      'not attempted: the run stopped when its record could not be rewritten',
    ]);
    expect(result.exitCode).toBe(1);
  });

  test('F5 (a): text typed into the tab between the first check and its turn keeps it, stored, nothing signalled or closed', async () => {
    const w = tabWorld({
      newTab: {
        screens: [idleClaude(sid(5)), draftClaude(sid(5), 'one more thing')],
      },
      otherTab: true,
    });
    const result = await undoOpen(w.options, w.deps);
    // The first pass planned it; the check right before its turn kept it.
    expect(w.events.filter((event) => event.startsWith('log'))).toEqual([
      `log ${surfId(5)} closing`,
      `log ${surfId(5)} kept`,
    ]);
    expect(kills(w)).toEqual([]);
    expect(anyClose(w)).toEqual([]);
    const kept = result.state?.tabs?.kept ?? [];
    expect(kept.map((entry) => entry.surfaceId)).toEqual([surfId(5)]);
    expect(kept[0]?.reasons.join('\n')).toContain(
      'unsent text in the input box of pane surface:5',
    );
    expect(kept[0]?.drafts.map((entry) => entry.text)).toEqual([
      'one more thing',
    ]);
    expect(kept[0]?.drafts[0]?.stored).not.toBeNull();
    expect(result.output).toContain('one more thing');
    expect(result.exitCode).toBe(0);
  });

  test('F2 / F5 (b): a tab that closes between the first check and its turn is listed under already gone, exit 0', async () => {
    const w = tabWorld({otherTab: true});
    betweenPasses(w, (model) => {
      const home = workspace50(model);
      home.panes = home.panes.filter((pane) => pane.id !== surfId(5));
    });
    const result = await undoOpen(w.options, w.deps);
    expect(kills(w)).toEqual([]);
    expect(anyClose(w)).toEqual([]);
    expect(result.state?.tabs?.gone.map((entry) => entry.surfaceId)).toEqual([
      surfId(5),
    ]);
    expect(result.state?.tabs?.kept).toEqual([]);
    expect(result.state?.tabs?.closed).toEqual([]);
    expect(result.output).toContain('Tabs already gone (1)');
    expect(result.exitCode).toBe(0);
  });

  test('F3: a tab that becomes its workspace only tab between the passes is named for closing by hand, listed there only, exit 1 as in the first pass', async () => {
    const w = tabWorld();
    betweenPasses(w, (model) => {
      const home = workspace50(model);
      home.panes = home.panes.filter((pane) => pane.id !== surfId(9));
    });
    const result = await undoOpen(w.options, w.deps);
    expect(kills(w)).toEqual([]);
    expect(anyClose(w)).toEqual([]);
    expect(result.state?.notClosed.map((entry) => entry.surfaceId)).toEqual([
      surfId(5),
    ]);
    expect(result.state?.notClosed[0]?.reason).toContain(
      `it is the only tab of its old workspace ${wsId(50)} now`,
    );
    expect(result.state?.tabs?.kept).toEqual([]);
    expect(result.output).toContain(
      'Not closed: tabs opened in an old workspace (1)',
    );
    expect(result.output).not.toContain('Tabs kept open');
    expect(result.exitCode).toBe(1);
  });

  test('F5 (c): a tab moved to another workspace between the passes is kept with why, never signalled or closed', async () => {
    const w = tabWorld({otherTab: true});
    betweenPasses(w, (model) => {
      const home = workspace50(model);
      const moving = home.panes.find((pane) => pane.id === surfId(5));
      if (moving == null) throw new Error('no tab 5');
      home.panes = home.panes.filter((pane) => pane !== moving);
      model.windows[0]?.workspaces.push({
        id: wsId(60),
        panes: [moving],
        ref: 'workspace:60',
      });
    });
    const result = await undoOpen(w.options, w.deps);
    expect(kills(w)).toEqual([]);
    expect(anyClose(w)).toEqual([]);
    const kept = result.state?.tabs?.kept ?? [];
    expect(kept.map((entry) => entry.surfaceId)).toEqual([surfId(5)]);
    expect(kept[0]?.reasons.join('\n')).toContain(
      `is in workspace ${wsId(60)} now, not in ${wsId(50)}`,
    );
    expect(result.state?.notClosed).toEqual([]);
    expect(result.exitCode).toBe(0);
  });
});
