/**
 * home-base-kwand.2: each session's state now, from the before-restart record
 * joined with the live pane lookup. Every id, title and screen here is
 * SYNTHETIC; no screen text from Justin's machine is in this file.
 */

import type {CmuxRunner} from '../src/thread/cmux';
import type {LiveSurface, PaneLookup, Proc} from '../src/thread/pane-join';
import type {BeforeRestart} from '../src/thread/tab-record-command';

import {describe, expect, test} from 'bun:test';

import {
  beforeRestartLine,
  beforeRestartStates,
  showsFailedRestore,
} from '../src/thread/before-restart-state';

const RESTART = new Date(2031, 2, 10, 21, 36, 52).getTime();

interface TabSpec {
  carried?: boolean;
  id: string;
  sessionId: string | null;
}

function before(tabs: TabSpec[]): BeforeRestart {
  return {
    counts: {carriedTabs: 0, claudeTabs: 0, tabs: 0, windows: 1, workspaces: 1},
    ok: true,
    restart: {
      at: RESTART,
      boot: {ms: RESTART - 3 * 60 * 60 * 1000, ok: true},
      cmuxLaunch: {at: RESTART, how: 'process start', recordAt: RESTART - 2000},
      cmuxProcess: {ms: RESTART, ok: true},
      kind: 'cmux launch',
      notes: [],
    },
    source: {
      fileCreatedAt: RESTART - 2000,
      files: ['previous.json'],
      kind: 'launch record',
      recordedAt: RESTART + 60_000,
    },
    store: {
      dayFilesRead: 1,
      dayFilesSkipped: 0,
      dir: '/synthetic/store',
      failedRunsSinceSource: 0,
      unreadableLines: 0,
    },
    windows: [
      {
        index: 0,
        workspaces: [
          {
            currentDirectory: '/synthetic/project',
            tabs: tabs.map((tab) => ({
              agentKind: tab.sessionId == null ? null : 'claude',
              agentWorkingDirectory: null,
              autoResume: true,
              directory: '/synthetic/project',
              id: tab.id,
              lastKnownSeenAt: tab.sessionId == null ? null : RESTART - 2000,
              lastKnownSessionId: tab.sessionId,
              sessionId: tab.carried === true ? null : tab.sessionId,
              title: `title of ${tab.id}`,
              ttyName: null,
              type: 'terminal',
            })),
            title: 'Synthetic workspace',
            workspaceId: 'ws-1',
          },
        ],
      },
    ],
  };
}

function surface(id: string, tty: string, ref: string): LiveSurface {
  return {
    id,
    paneRef: `pane:${ref}`,
    ref: `surface:${ref}`,
    title: null,
    tty,
    type: 'terminal',
    workspaceId: 'ws-1',
    workspaceRef: 'workspace:1',
    workspaceTitle: null,
  };
}

function proc(pid: number, tty: string, exePath: string): Proc {
  return {
    command: exePath,
    etime: '01:00',
    exePath,
    name: exePath.split('/').pop() ?? exePath,
    pid,
    ppid: 1,
    tty,
  };
}

const CLAUDE = '/Users/synthetic/.local/bin/claude';
const ZSH = '/bin/zsh';
const FAILED_SCREEN =
  'Restoring Claude…\nERROR: overloaded retry_after_ms=250 pool_saturated\n\n%';
const SHELL_SCREEN = 'Last login: synthetic\n%';
const CLAUDE_SCREEN =
  '╭──────────╮\n│ ❯ hello │\n╰──────────╯\n⌗ other-session';

function lookup(over: {
  bySession?: Map<string, {surfaceId: string}>;
  live?: {procs: Proc[]; surfaces: LiveSurface[]} | null;
  unknown?: Map<string, string>;
}): PaneLookup {
  const bySession = new Map(
    [...(over.bySession ?? new Map<string, {surfaceId: string}>())].map(
      ([sid, pane]) => [
        sid,
        {
          source: 'hook-store' as const,
          surfaceId: pane.surfaceId,
          workspaceId: 'ws-1',
        },
      ],
    ),
  );
  return {
    bySession,
    ...(over.live === null
      ? {}
      : {live: over.live ?? {procs: [], surfaces: []}}),
    ok: true,
    statusLine: {
      failure: null,
      unknownSessions: over.unknown ?? new Map<string, string>(),
      unplaced: [],
    },
  };
}

/** A fake cmux: screens by surface ref; records every call. */
function fakeCmux(screens: Record<string, string | null>): {
  calls: string[];
  run: CmuxRunner;
} {
  const calls: string[] = [];
  const run: CmuxRunner = (args) => {
    calls.push(args.join(' '));
    const ref = args[2] ?? '';
    const text = screens[ref];
    return Promise.resolve(
      text == null
        ? {
            kind: 'failed' as const,
            reason: 'synthetic: screen unreadable',
            timedOut: false,
          }
        : {kind: 'ok' as const, stdout: text},
    );
  };
  return {calls, run};
}

/** Every state now, one tab each. */
function everyState() {
  const tabs: TabSpec[] = [
    {id: 'T-running', sessionId: 's-running'},
    {id: 'T-failed', sessionId: 's-failed'},
    {id: 'T-shell', sessionId: 's-shell'},
    {id: 'T-other', sessionId: 's-other'},
    {id: 'T-gone', sessionId: 's-gone'},
    {id: 'T-unreadable', sessionId: 's-unreadable'},
    {id: 'T-plain', sessionId: null},
  ];
  const live = {
    procs: [
      proc(10, 'ttys001', CLAUDE),
      proc(11, 'ttys002', ZSH),
      proc(12, 'ttys003', ZSH),
      proc(13, 'ttys004', CLAUDE),
      proc(14, 'ttys006', ZSH),
    ],
    surfaces: [
      surface('T-running', 'ttys001', '1'),
      surface('T-failed', 'ttys002', '2'),
      surface('T-shell', 'ttys003', '3'),
      surface('T-other', 'ttys004', '4'),
      surface('T-unreadable', 'ttys006', '6'),
      surface('T-plain', 'ttys007', '7'),
    ],
  };
  const cmux = fakeCmux({
    'surface:2': FAILED_SCREEN,
    'surface:3': SHELL_SCREEN,
    'surface:4': CLAUDE_SCREEN,
    'surface:6': null,
  });
  return {
    before: before(tabs),
    cmux,
    panes: lookup({
      bySession: new Map([['s-running', {surfaceId: 'T-running'}]]),
      live,
    }),
  };
}

describe('the state now of each session that was in a tab before the restart', () => {
  test('each state: running again, restore failed, shell in tab, other session, not restored, unknown', async () => {
    const {before: b, cmux, panes} = everyState();
    const read = await beforeRestartStates({before: b, cmux: cmux.run, panes});
    if (!read.ok) throw new Error(read.reason);
    const states = Object.fromEntries(
      [...read.facts].map(([sid, fact]) => [sid, fact.state]),
    );
    expect(states).toEqual({
      's-failed': 'restoreFailed',
      's-gone': 'notRestored',
      's-other': 'otherSession',
      's-running': 'runningAgain',
      's-shell': 'shellInTab',
      's-unreadable': 'unknown',
    });
    // A tab with no Claude session before the restart has no fact.
    expect(read.facts.size).toBe(6);
    expect(read.restartKind).toBe('cmux launch');
    expect(read.tabsWithSession).toBe(6);
  });

  test('screens are read only for tabs that exist and whose session does not run', async () => {
    const {before: b, cmux, panes} = everyState();
    await beforeRestartStates({before: b, cmux: cmux.run, panes});
    expect(cmux.calls.sort()).toEqual([
      'read-screen --surface surface:2',
      'read-screen --surface surface:3',
      'read-screen --surface surface:6',
    ]);
  });

  test('an unreadable live tab list gives unknown, never not restored', async () => {
    const {before: b, cmux} = everyState();
    const failed: PaneLookup = {ok: false, reason: 'cmux tree refused'};
    const read = await beforeRestartStates({
      before: b,
      cmux: cmux.run,
      panes: failed,
    });
    if (!read.ok) throw new Error(read.reason);
    const states = new Set([...read.facts.values()].map((fact) => fact.state));
    expect([...states]).toEqual(['unknown']);
    expect(read.facts.get('s-gone')?.reason).toContain('cmux tree refused');
    // A lookup that carries no live tab list is not "gone" either.
    const noLive = await beforeRestartStates({
      before: b,
      cmux: cmux.run,
      panes: lookup({live: null}),
    });
    if (!noLive.ok) throw new Error(noLive.reason);
    expect(noLive.facts.get('s-gone')?.state).toBe('unknown');
    expect(cmux.calls).toEqual([]);
  });

  test('a session the status line could not settle is unknown', async () => {
    const {before: b, cmux} = everyState();
    const read = await beforeRestartStates({
      before: b,
      cmux: cmux.run,
      panes: lookup({
        unknown: new Map([['s-gone', 'two sessions on one pane']]),
      }),
    });
    if (!read.ok) throw new Error(read.reason);
    expect(read.facts.get('s-gone')).toMatchObject({
      reason: 'two sessions on one pane',
      state: 'unknown',
    });
  });

  test('a carried-forward session id places a session', async () => {
    const b = before([{carried: true, id: 'T-failed', sessionId: 's-carried'}]);
    const read = await beforeRestartStates({
      before: b,
      cmux: fakeCmux({'surface:2': FAILED_SCREEN}).run,
      panes: lookup({
        live: {
          procs: [proc(11, 'ttys002', ZSH)],
          surfaces: [surface('T-failed', 'ttys002', '2')],
        },
      }),
    });
    if (!read.ok) throw new Error(read.reason);
    expect(read.facts.get('s-carried')).toMatchObject({
      state: 'restoreFailed',
      tab: {carried: true, id: 'T-failed', title: 'title of T-failed'},
    });
  });

  test('a tty two tabs share: a shell prompt is shell in tab, anything else unknown', async () => {
    const b = before([
      {id: 'T-a', sessionId: 's-a'},
      {id: 'T-b', sessionId: 's-b'},
    ]);
    const live = {
      procs: [proc(20, 'ttys009', CLAUDE)],
      surfaces: [
        surface('T-a', 'ttys009', 'a'),
        surface('T-b', 'ttys009', 'b'),
      ],
    };
    const read = await beforeRestartStates({
      before: b,
      cmux: fakeCmux({'surface:a': SHELL_SCREEN, 'surface:b': CLAUDE_SCREEN})
        .run,
      panes: lookup({live}),
    });
    if (!read.ok) throw new Error(read.reason);
    expect(read.facts.get('s-a')?.state).toBe('shellInTab');
    expect(read.facts.get('s-b')?.state).toBe('unknown');
  });

  test('a session running in another tab is running again, and says so', async () => {
    const b = before([{id: 'T-old', sessionId: 's-moved'}]);
    const read = await beforeRestartStates({
      before: b,
      cmux: fakeCmux({}).run,
      panes: lookup({
        bySession: new Map([['s-moved', {surfaceId: 'T-new'}]]),
        live: {procs: [], surfaces: []},
      }),
    });
    if (!read.ok) throw new Error(read.reason);
    const fact = read.facts.get('s-moved');
    if (fact == null) throw new Error('no fact');
    expect(fact.state).toBe('runningAgain');
    expect(beforeRestartLine(fact, new Date(RESTART + 60_000))).toBe(
      '🔁 was open before the 9:36pm restart: running again, in another tab',
    );
  });

  test('no before set is a named failure, never an empty map', async () => {
    const read = await beforeRestartStates({
      before: {
        ok: false,
        reason: 'nothing recorded before the restart',
        restart: null,
        store: {
          dayFilesRead: 0,
          dayFilesSkipped: 0,
          dir: '/x',
          failedRunsSinceSource: 0,
          unreadableLines: 0,
        },
      },
      cmux: fakeCmux({}).run,
      panes: lookup({}),
    });
    expect(read).toEqual({
      ok: false,
      reason: 'nothing recorded before the restart',
    });
  });

  test("cmux's restore error is recognised; a plain shell is not", () => {
    expect(showsFailedRestore(FAILED_SCREEN)).toBe(true);
    expect(showsFailedRestore(SHELL_SCREEN)).toBe(false);
    expect(showsFailedRestore(CLAUDE_SCREEN)).toBe(false);
  });

  test('the card line names the restart time and the state', async () => {
    const {before: b, cmux, panes} = everyState();
    const read = await beforeRestartStates({before: b, cmux: cmux.run, panes});
    if (!read.ok) throw new Error(read.reason);
    const fact = read.facts.get('s-failed');
    if (fact == null) throw new Error('no fact');
    expect(beforeRestartLine(fact, new Date(RESTART + 60_000))).toBe(
      '🔁 was open before the 9:36pm restart: restore failed',
    );
    const next = new Date(RESTART + 24 * 60 * 60 * 1000);
    expect(beforeRestartLine(fact, next)).toBe(
      '🔁 was open before the Mar 10, 9:36pm restart: restore failed',
    );
  });
});
