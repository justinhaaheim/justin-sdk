/**
 * home-base-kwand.2: each session's state now, from the before-restart record
 * joined with the live pane lookup. Every id, title and screen here is
 * SYNTHETIC; no screen text from Justin's machine is in this file.
 */

import type {CwdReader} from '../src/thread/before-restart-state';
import type {CmuxRunner} from '../src/thread/cmux';
import type {AgentsRunner} from '../src/thread/live-sessions';
import type {
  LiveSurface,
  PaneLookup,
  Proc,
  ProcessRunner,
  UnplacedPane,
} from '../src/thread/pane-join';
import type {BeforeRestart} from '../src/thread/tab-record-command';

import {describe, expect, test} from 'bun:test';
import {join} from 'path';

import {
  beforeRestartLine,
  beforeRestartStates,
  parseLsofCwds,
  showsFailedRestore,
} from '../src/thread/before-restart-state';
import {lookupPanes} from '../src/thread/pane-join';
import {isOldTabResumeState} from '../src/thread/restore-tab';
import {createSandbox} from './sandbox';

const RESTART = new Date(2031, 2, 10, 21, 36, 52).getTime();

interface TabSpec {
  carried?: boolean;
  /** Claude's working directory before the restart; null: none recorded. */
  directory?: string | null;
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
            currentDirectory: null,
            tabs: tabs.map((tab) => ({
              agentKind: tab.sessionId == null ? null : 'claude',
              agentWorkingDirectory: tab.directory ?? null,
              autoResume: true,
              directory:
                tab.directory === undefined ? '/synthetic/project' : null,
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
  live?: {
    placedPids?: Map<number, string>;
    procs: Proc[];
    storedPids?: Map<number, string[]>;
    surfaces: LiveSurface[];
  } | null;
  unknown?: Map<string, string>;
  unplaced?: UnplacedPane[];
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
      unplaced: over.unplaced ?? [],
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

  // home-base-kwand.14 (conductor's decision): the shared-tty shell-in-tab
  // case gets the old-workspace resume only when the session itself is not
  // the one running on that tty. The pane join already says so: when the
  // Claude there runs THIS session it is placed, so runningAgain, never
  // resumed. When it runs the twin's own session, this session's
  // shell-prompt tab (an unmatched pane whose one Claude process the pid
  // join placed in the twin) is shellInTab, and gets the resume.
  // NEGATIVE CONTROL run 2026-11-18: firstPass skipping its runningAgain
  // branch for s-a -> this test failed (expected runningAgain, received
  // unknown: kwand.12's own-tab hold, the pid join's `matched` s-a, still
  // kept it from shellInTab, so it is not resumed either way).
  test('a tty two tabs share: the resume is offered only when the Claude there is not this session (kwand.14)', async () => {
    const b = before([
      {id: 'T-a', sessionId: 's-a'},
      {id: 'T-b', sessionId: 's-b'},
    ]);
    const twinA = surface('T-a', 'ttys009', 'a');
    const live = (placed: string) => ({
      placedPids: new Map([[20, placed]]),
      procs: [proc(20, 'ttys009', CLAUDE)],
      surfaces: [twinA, surface('T-b', 'ttys009', 'b')],
    });
    const shellTwin: UnplacedPane = {
      detail: 'synthetic: a shell prompt on a Claude tty',
      fileSessionId: null,
      kind: 'noScreenId',
      screenSessionId: null,
      surface: twinA,
    };
    const screens = {'surface:a': SHELL_SCREEN, 'surface:b': CLAUDE_SCREEN};
    // The Claude on the shared tty runs s-a itself: placed, so runningAgain.
    const itself = await beforeRestartStates({
      before: b,
      cmux: fakeCmux(screens).run,
      panes: lookup({
        bySession: new Map([['s-a', {surfaceId: 'T-b'}]]),
        live: live('s-a'),
        unplaced: [shellTwin],
      }),
    });
    if (!itself.ok) throw new Error(itself.reason);
    expect(itself.facts.get('s-a')?.state).toBe('runningAgain');
    expect(isOldTabResumeState(itself.facts.get('s-a')?.state)).toBe(false);
    // It runs the twin's session s-b: s-a's own tab is a shell prompt.
    const other = await beforeRestartStates({
      before: b,
      cmux: fakeCmux(screens).run,
      panes: lookup({
        bySession: new Map([['s-b', {surfaceId: 'T-b'}]]),
        live: live('s-b'),
        unplaced: [shellTwin],
      }),
    });
    if (!other.ok) throw new Error(other.reason);
    expect(other.facts.get('s-a')?.state).toBe('shellInTab');
    expect(isOldTabResumeState(other.facts.get('s-a')?.state)).toBe(true);
    expect(other.facts.get('s-b')?.state).toBe('runningAgain');
    expect(isOldTabResumeState(other.facts.get('s-b')?.state)).toBe(false);
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

  test('lsof cwd output parses to a pid map', () => {
    expect([
      ...parseLsofCwds('p50\nfcwd\nn/synthetic/dev/alpha\np51\nfcwd\nn/x y\n'),
    ]).toEqual([
      [50, '/synthetic/dev/alpha'],
      [51, '/x y'],
    ]);
    expect(parseLsofCwds('').size).toBe(0);
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

// ---------------------------------------------------------------------------
// home-base-kwand.12: a live Claude pane the join could not place makes only
// the sessions it could hold unknown. All paths and ids are synthetic.
// ---------------------------------------------------------------------------

const ALPHA = '/synthetic/dev/alpha';
const BETA = '/synthetic/dev/beta';
const ARGV_ID = '11111111-2222-4333-8444-555555555555';
const SHOWN_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

/** Five sessions whose tabs are gone, in two repos and none. */
function goneTabs(): TabSpec[] {
  return [
    {directory: ALPHA, id: 'T-alpha', sessionId: 's-alpha'},
    {directory: BETA, id: 'T-beta', sessionId: 's-beta'},
    {directory: null, id: 'T-nodir', sessionId: 's-nodir'},
    {directory: BETA, id: 'T-argv', sessionId: ARGV_ID},
    {directory: BETA, id: 'T-shown', sessionId: SHOWN_ID},
  ];
}

const UNMATCHED = surface('P-unmatched', 'ttys050', '50');

function claudeProc(pid: number, tty: string, args = ''): Proc {
  return {...proc(pid, tty, CLAUDE), command: `${CLAUDE}${args}`};
}

/** The live view with one unmatched pane; `procs` on its tty (default one Claude). */
function unmatchedLookup(over: {
  kind?: UnplacedPane['kind'];
  placedPids?: Map<number, string>;
  procs?: Proc[];
  screen?: string | null;
}): PaneLookup {
  const procs = over.procs ?? [
    claudeProc(50, 'ttys050', ` --resume ${ARGV_ID}`),
  ];
  return lookup({
    live: {
      ...(over.placedPids == null ? {} : {placedPids: over.placedPids}),
      procs,
      surfaces: [UNMATCHED],
    },
    unplaced: [
      {
        detail: 'synthetic',
        fileSessionId: null,
        kind: over.kind ?? 'noScreenId',
        screenSessionId: over.screen ?? null,
        surface: UNMATCHED,
      },
    ],
  });
}

/** A fake lsof: cwds by pid, every call recorded. */
function fakeCwds(byPid: Record<number, string> | {fail: string}): {
  calls: number[][];
  read: CwdReader;
} {
  const calls: number[][] = [];
  const read: CwdReader = (pids) => {
    calls.push([...pids]);
    if ('fail' in byPid) {
      return Promise.resolve({ok: false as const, reason: byPid.fail});
    }
    return Promise.resolve({
      ok: true as const,
      value: new Map(
        Object.entries(byPid).map(([pid, cwd]) => [Number(pid), cwd]),
      ),
    });
  };
  return {calls, read};
}

async function statesOf(input: {
  cwds?: CwdReader;
  panes: PaneLookup;
  tabs?: TabSpec[];
}): Promise<{
  read: Extract<Awaited<ReturnType<typeof beforeRestartStates>>, {ok: true}>;
  states: Record<string, string>;
}> {
  const read = await beforeRestartStates({
    before: before(input.tabs ?? goneTabs()),
    cmux: fakeCmux({}).run,
    ...(input.cwds == null ? {} : {cwds: input.cwds}),
    panes: input.panes,
  });
  if (!read.ok) throw new Error(read.reason);
  return {
    read,
    states: Object.fromEntries(
      [...read.facts].map(([sid, fact]) => [sid, fact.state]),
    ),
  };
}

describe('an unmatched live Claude pane makes only the sessions it could hold unknown (kwand.12)', () => {
  test('the text of a notRestored session names the unmatched panes that cannot hold it', async () => {
    const {read} = await statesOf({
      panes: unmatchedLookup({kind: 'unconfirmedId', screen: SHOWN_ID}),
    });
    expect(read.facts.get('s-beta')?.reason).toBe(
      'its tab is gone and it does not run (the one live Claude pane the tools could not match to a session cannot hold it)',
    );
  });

  test('its status line shows a session: only that session stays unknown, the rest are not restored, and lsof is not run', async () => {
    const cwds = fakeCwds({50: BETA});
    const {read, states} = await statesOf({
      cwds: cwds.read,
      panes: unmatchedLookup({kind: 'unconfirmedId', screen: SHOWN_ID}),
    });
    expect(states).toEqual({
      [ARGV_ID]: 'notRestored',
      [SHOWN_ID]: 'unknown',
      's-alpha': 'notRestored',
      's-beta': 'notRestored',
      's-nodir': 'notRestored',
    });
    expect(read.facts.get(SHOWN_ID)?.reason).toBe(
      'its tab is gone, and a live Claude pane the tools could not match to a session could hold it (surface:50 shows it on its status line), so it may run there',
    );
    expect(read.unplaced).toEqual([
      {
        hold: {kind: 'session', sessionId: SHOWN_ID},
        kind: 'unconfirmedId',
        sessionsUnknown: 1,
        surface: 'surface:50',
      },
    ]);
    expect(cwds.calls).toEqual([]);
  });

  test('no status line: its Claude process works in one repo, so sessions of that repo (a worktree too), with no recorded directory, or named by its argv stay unknown; another repo is not restored', async () => {
    const cwds = fakeCwds({50: `${ALPHA}/.claude/worktrees/w1`});
    const {read, states} = await statesOf({
      cwds: cwds.read,
      panes: unmatchedLookup({}),
    });
    expect(states).toEqual({
      [ARGV_ID]: 'unknown',
      [SHOWN_ID]: 'notRestored',
      's-alpha': 'unknown',
      's-beta': 'notRestored',
      's-nodir': 'unknown',
    });
    expect(read.facts.get('s-alpha')?.reason).toContain(
      `surface:50 runs Claude in ${ALPHA}`,
    );
    expect(read.unplaced[0]).toEqual({
      hold: {checkouts: [ALPHA], kind: 'checkouts', sessionIds: [ARGV_ID]},
      kind: 'noScreenId',
      sessionsUnknown: 3,
      surface: 'surface:50',
    });
    expect(cwds.calls).toEqual([[50]]);
  });

  test('a pane whose Claude process the pid join already placed (a twin on the same tty) holds no other session, and lsof is not run', async () => {
    const cwds = fakeCwds({50: ALPHA});
    const placed = '99999999-8888-4777-8666-555555555555';
    const {read, states} = await statesOf({
      cwds: cwds.read,
      panes: unmatchedLookup({placedPids: new Map([[50, placed]])}),
    });
    expect(states).toEqual({
      [ARGV_ID]: 'notRestored',
      [SHOWN_ID]: 'notRestored',
      's-alpha': 'notRestored',
      's-beta': 'notRestored',
      's-nodir': 'notRestored',
    });
    expect(read.unplaced[0]?.hold).toEqual({
      kind: 'matched',
      sessionIds: [placed],
    });
    expect(cwds.calls).toEqual([]);
    // A second Claude process on the tty that the join did not place is read.
    const mixed = fakeCwds({51: BETA});
    const second = await statesOf({
      cwds: mixed.read,
      panes: unmatchedLookup({
        placedPids: new Map([[50, placed]]),
        procs: [claudeProc(50, 'ttys050'), claudeProc(51, 'ttys050')],
      }),
    });
    expect(mixed.calls).toEqual([[51]]);
    expect(second.states).toMatchObject({
      's-alpha': 'notRestored',
      's-beta': 'unknown',
      's-nodir': 'unknown',
    });
  });

  test('a status line id with two Claude processes on the tty does not settle it: their working directories do', async () => {
    const {states} = await statesOf({
      cwds: fakeCwds({50: BETA, 51: BETA}).read,
      panes: unmatchedLookup({
        procs: [claudeProc(50, 'ttys050'), claudeProc(51, 'ttys050')],
        screen: SHOWN_ID,
      }),
    });
    expect(states).toMatchObject({
      [SHOWN_ID]: 'unknown',
      's-alpha': 'notRestored',
      's-beta': 'unknown',
      's-nodir': 'unknown',
    });
  });

  test('with nothing known about the pane, every gone-tab session is unknown (the guard before kwand.12)', async () => {
    const everyUnknown = {
      [ARGV_ID]: 'unknown',
      [SHOWN_ID]: 'unknown',
      's-alpha': 'unknown',
      's-beta': 'unknown',
      's-nodir': 'unknown',
    };
    // No cwd reader at all.
    const none = await statesOf({panes: unmatchedLookup({})});
    expect(none.states).toEqual(everyUnknown);
    expect(none.read.unplaced[0]?.hold).toEqual({
      kind: 'anything',
      reason: 'the working directory of its Claude process was not read',
    });
    // lsof failed.
    const failed = await statesOf({
      cwds: fakeCwds({fail: 'lsof refused'}).read,
      panes: unmatchedLookup({}),
    });
    expect(failed.states).toEqual(everyUnknown);
    expect(failed.read.facts.get('s-beta')?.reason).toContain('lsof refused');
    // lsof listed every process but this one (as inside the sandbox).
    const unlisted = await statesOf({
      cwds: fakeCwds({99: BETA}).read,
      panes: unmatchedLookup({}),
    });
    expect(unlisted.states).toEqual(everyUnknown);
    // No Claude process found on its tty.
    const noProc = await statesOf({
      cwds: fakeCwds({}).read,
      panes: unmatchedLookup({procs: []}),
    });
    expect(noProc.states).toEqual(everyUnknown);
  });

  test("a session whose own tab is an unmatched pane it could be in is unknown, not another session's tab", async () => {
    const own = surface('T-own', 'ttys060', '60');
    const ownLookup = (screen: string | null): PaneLookup =>
      lookup({
        live: {procs: [claudeProc(60, 'ttys060')], surfaces: [own]},
        unplaced: [
          {
            detail: 'synthetic',
            fileSessionId: null,
            kind: screen == null ? 'noScreenId' : 'unconfirmedId',
            screenSessionId: screen,
            surface: own,
          },
        ],
      });
    const tabs: TabSpec[] = [
      {directory: ALPHA, id: 'T-own', sessionId: 's-own'},
    ];
    const could = await statesOf({
      cwds: fakeCwds({60: ALPHA}).read,
      panes: ownLookup(null),
      tabs,
    });
    expect(could.states).toEqual({'s-own': 'unknown'});
    expect(could.read.unplaced[0]?.sessionsUnknown).toBe(1);
    // Its status line shows another session: that is another session's tab.
    const other = await statesOf({panes: ownLookup(SHOWN_ID), tabs});
    expect(other.states).toEqual({'s-own': 'otherSession'});
  });
});

// ---------------------------------------------------------------------------
// home-base-kwand.16: a Claude process outside any live tab (its tty no tab
// reports, or none). All pids, paths and ids are synthetic. Negative controls
// are recorded in home-base-kwand.16's notes.
// ---------------------------------------------------------------------------

/** A process whose argv0 is a bare `claude` (a background worker, a spawned -p). */
function bareClaude(pid: number, tty: string, args: string, ppid = 1): Proc {
  return {
    command: `claude ${args}`.trim(),
    etime: '01:00',
    exePath: 'claude',
    name: 'claude',
    pid,
    ppid,
    tty,
  };
}

/** The live view: one ordinary tab (ttys001) and `procs`, some on no tab's tty. */
function outsideLookup(
  procs: Proc[],
  storedPids?: Map<number, string[]>,
): PaneLookup {
  return lookup({
    live: {
      procs: [proc(1, 'ttys001', ZSH), ...procs],
      ...(storedPids == null ? {} : {storedPids}),
      surfaces: [surface('T-live', 'ttys001', '1')],
    },
  });
}

/** A fake `claude agents --json`: the entries, or a failure; calls counted. */
function fakeAgents(
  entries: {kind?: string; pid: number; sessionId?: string}[] | {fail: string},
): {calls: () => number; run: AgentsRunner} {
  let calls = 0;
  const run: AgentsRunner = () => {
    calls += 1;
    return Promise.resolve(
      'fail' in entries
        ? {kind: 'failed' as const, reason: entries.fail}
        : {kind: 'ok' as const, stdout: JSON.stringify(entries)},
    );
  };
  return {calls: () => calls, run};
}

async function outsideStates(input: {
  agents?: AgentsRunner;
  cwds?: CwdReader;
  panes: PaneLookup;
}) {
  const read = await beforeRestartStates({
    ...(input.agents == null ? {} : {agents: input.agents}),
    before: before(goneTabs()),
    cmux: fakeCmux({}).run,
    ...(input.cwds == null ? {} : {cwds: input.cwds}),
    panes: input.panes,
  });
  if (!read.ok) throw new Error(read.reason);
  const states: Record<string, string> = Object.fromEntries(
    [...read.facts].map(([sid, fact]) => [sid, fact.state]),
  );
  return {read, states};
}

const EVERY_GONE_NOT_RESTORED: Record<string, string> = {
  [ARGV_ID]: 'notRestored',
  [SHOWN_ID]: 'notRestored',
  's-alpha': 'notRestored',
  's-beta': 'notRestored',
  's-nodir': 'notRestored',
};

describe('a Claude process outside any live tab (kwand.16)', () => {
  test('one that names a session (argv, hook store or agents registry) makes it running again, outside any tab, and holds nothing else', async () => {
    const agents = fakeAgents([
      {kind: 'background', pid: 73, sessionId: SHOWN_ID},
    ]);
    const cwds = fakeCwds({});
    const {read, states} = await outsideStates({
      agents: agents.run,
      cwds: cwds.read,
      panes: outsideLookup(
        [
          // argv names it; no tty (a closed pane's process can lose it too).
          claudeProc(70, '??', ` --resume ${ARGV_ID}`),
          // cmux's hook store names its pid; on a tty no tab reports.
          claudeProc(71, 'ttys071'),
          // A background session: its host, and the worker the registry names.
          bareClaude(72, 'ttys073', 'bg-pty-host --synthetic'),
          bareClaude(73, 'ttys073', 'bg-spare --bg-spare /synthetic.sock', 72),
        ],
        new Map([[71, ['s-beta']]]),
      ),
    });
    expect(states).toEqual({
      [ARGV_ID]: 'runningAgain',
      [SHOWN_ID]: 'runningAgain',
      's-alpha': 'notRestored',
      's-beta': 'runningAgain',
      's-nodir': 'notRestored',
    });
    const argvFact = read.facts.get(ARGV_ID);
    expect(argvFact?.reason).toBe('it runs outside any cmux tab (pid 70)');
    if (argvFact == null) throw new Error('no fact');
    expect(beforeRestartLine(argvFact, new Date(RESTART + 60_000))).toBe(
      '🔁 was open before the 9:36pm restart: running again, outside any cmux tab',
    );
    expect(read.facts.get('s-alpha')?.reason).toBe(
      'its tab is gone and it does not run',
    );
    expect(read.outside).toEqual([
      {
        pid: 70,
        sessionsRunning: 1,
        sessionsUnknown: 0,
        tty: null,
        verdict: {kind: 'named', sessionIds: [ARGV_ID]},
      },
      {
        pid: 71,
        sessionsRunning: 1,
        sessionsUnknown: 0,
        tty: 'ttys071',
        verdict: {kind: 'named', sessionIds: ['s-beta']},
      },
      {
        pid: 72,
        sessionsRunning: 0,
        sessionsUnknown: 0,
        tty: 'ttys073',
        verdict: {
          kind: 'ignored',
          reason:
            'the terminal host of a background session (claude bg-pty-host); its worker is judged instead',
        },
      },
      {
        pid: 73,
        sessionsRunning: 1,
        sessionsUnknown: 0,
        tty: 'ttys073',
        verdict: {kind: 'named', sessionIds: [SHOWN_ID]},
      },
    ]);
    // The registry was read once (argv and the store left the worker
    // unnamed); no outside process needed its directory.
    expect(agents.calls()).toBe(1);
    expect(cwds.calls).toEqual([]);
  });

  test('one that names no session keeps the sessions of its repo unknown (a worktree too, and one with no recorded directory); a session in another repo still reads not restored', async () => {
    const cwds = fakeCwds({80: `${ALPHA}/.claude/worktrees/w1`});
    const {read, states} = await outsideStates({
      cwds: cwds.read,
      panes: outsideLookup([claudeProc(80, 'ttys080')]),
    });
    expect(states).toEqual({
      [ARGV_ID]: 'notRestored',
      [SHOWN_ID]: 'notRestored',
      's-alpha': 'unknown',
      's-beta': 'notRestored',
      's-nodir': 'unknown',
    });
    expect(read.facts.get('s-alpha')?.reason).toBe(
      `its tab is gone, and a Claude process outside any cmux tab that names no session could hold it (pid 80 runs Claude in ${ALPHA}), so it may run there`,
    );
    expect(read.facts.get('s-beta')?.reason).toBe(
      'its tab is gone and it does not run (the one Claude process outside any cmux tab that names no session cannot hold it)',
    );
    expect(read.outside).toEqual([
      {
        pid: 80,
        sessionsRunning: 0,
        sessionsUnknown: 2,
        tty: 'ttys080',
        verdict: {
          hold: {checkouts: [ALPHA], kind: 'checkouts', sessionIds: []},
          kind: 'held',
        },
      },
    ]);
    expect(cwds.calls).toEqual([[80]]);
  });

  test('its directory cannot be read: it could hold any session whose tab is gone', async () => {
    const everyUnknown = {
      [ARGV_ID]: 'unknown',
      [SHOWN_ID]: 'unknown',
      's-alpha': 'unknown',
      's-beta': 'unknown',
      's-nodir': 'unknown',
    };
    const failed = await outsideStates({
      cwds: fakeCwds({fail: 'lsof refused'}).read,
      panes: outsideLookup([claudeProc(80, '??')]),
    });
    expect(failed.states).toEqual(everyUnknown);
    expect(failed.read.facts.get('s-beta')?.reason).toContain('lsof refused');
    // No cwd reader at all, and lsof listing another pid only.
    expect(
      (await outsideStates({panes: outsideLookup([claudeProc(80, '??')])}))
        .states,
    ).toEqual(everyUnknown);
    expect(
      (
        await outsideStates({
          cwds: fakeCwds({99: BETA}).read,
          panes: outsideLookup([claudeProc(80, '??')]),
        })
      ).states,
    ).toEqual(everyUnknown);
  });

  test('with an unmatched pane too, lsof runs once for both, and each reason names the right one', async () => {
    const cwds = fakeCwds({50: BETA, 80: ALPHA});
    const panes = unmatchedLookup({});
    if (!panes.ok || panes.live == null) throw new Error('no live view');
    const {read, states} = await outsideStates({
      cwds: cwds.read,
      panes: {
        ...panes,
        live: {
          ...panes.live,
          procs: [...panes.live.procs, claudeProc(80, '??')],
        },
      },
    });
    expect(cwds.calls).toEqual([[50, 80]]);
    expect(states).toEqual({
      [ARGV_ID]: 'unknown',
      [SHOWN_ID]: 'unknown',
      's-alpha': 'unknown',
      's-beta': 'unknown',
      's-nodir': 'unknown',
    });
    expect(read.facts.get('s-nodir')?.reason).toBe(
      `its tab is gone, and a live Claude pane the tools could not match to a session and a Claude process outside any cmux tab that names no session could hold it (surface:50 runs Claude in ${BETA}; pid 80 runs Claude in ${ALPHA}), so it may run there`,
    );
    expect(read.unplaced[0]?.sessionsUnknown).toBe(4);
    expect(read.outside[0]?.sessionsUnknown).toBe(2);
  });

  test('`claude -p` naming no session holds none; with -c or --resume it may hold one', async () => {
    const agents = fakeAgents([]);
    const cwds = fakeCwds({90: BETA});
    const headless = await outsideStates({
      agents: agents.run,
      cwds: cwds.read,
      panes: outsideLookup([
        claudeProc(
          90,
          '??',
          ' -p /usage --output-format json --no-session-persistence',
        ),
      ]),
    });
    expect(headless.states).toEqual(EVERY_GONE_NOT_RESTORED);
    expect(headless.read.outside[0]?.verdict).toEqual({
      kind: 'ignored',
      reason:
        'claude -p with no session flag runs a new session, so it holds none from before the restart',
    });
    // Neither the registry nor lsof was needed.
    expect(agents.calls()).toBe(0);
    expect(cwds.calls).toEqual([]);
    // `-p -c` continues the newest session of its directory: held by its repo.
    const continued = await outsideStates({
      cwds: fakeCwds({90: BETA}).read,
      panes: outsideLookup([claudeProc(90, '??', ' -p -c "go on"')]),
    });
    expect(continued.states).toMatchObject({
      [ARGV_ID]: 'unknown',
      's-alpha': 'notRestored',
      's-beta': 'unknown',
    });
    // `--print --resume <id>` names it.
    const resumed = await outsideStates({
      panes: outsideLookup([
        claudeProc(90, '??', ` --print --resume ${ARGV_ID} "go on"`),
      ]),
    });
    expect(resumed.states).toEqual({
      ...EVERY_GONE_NOT_RESTORED,
      [ARGV_ID]: 'runningAgain',
    });
  });

  test("the daemon's unclaimed spare (no tty, not in the registry) and claude subcommands hold none", async () => {
    const spare = bareClaude(95, '??', 'bg-spare --bg-spare /synthetic.sock');
    const listed = fakeAgents([]);
    const cwds = fakeCwds({95: ALPHA});
    const {read, states} = await outsideStates({
      agents: listed.run,
      cwds: cwds.read,
      panes: outsideLookup([
        spare,
        claudeProc(96, '??', ' agents --json'),
        bareClaude(97, '??', 'daemon run --synthetic'),
      ]),
    });
    expect(states).toEqual(EVERY_GONE_NOT_RESTORED);
    expect(read.outside.map((entry) => entry.verdict.kind)).toEqual([
      'ignored',
      'ignored',
      'ignored',
    ]);
    expect(listed.calls()).toBe(1);
    expect(cwds.calls).toEqual([]);
    expect(read.agentsFailure).toBeNull();
    // The registry could not be read: the spare is held by its directory.
    const unreadable = await outsideStates({
      agents: fakeAgents({fail: 'synthetic: agents refused'}).run,
      cwds: fakeCwds({95: ALPHA}).read,
      panes: outsideLookup([spare]),
    });
    expect(unreadable.states).toMatchObject({
      's-alpha': 'unknown',
      's-beta': 'notRestored',
    });
    expect(unreadable.read.agentsFailure).toBe('synthetic: agents refused');
    // A worker holding a terminal the registry does not list may run a
    // session (live-sessions.ts): held by its directory.
    const claimed = await outsideStates({
      agents: fakeAgents([]).run,
      cwds: fakeCwds({95: ALPHA}).read,
      panes: outsideLookup([{...spare, tty: 'ttys095'}]),
    });
    expect(claimed.states).toMatchObject({
      's-alpha': 'unknown',
      's-beta': 'notRestored',
    });
  });

  test('a failed ps read keeps every session unknown, never not restored (critical rule 7)', async () => {
    const sb = createSandbox();
    try {
      sb.writeFile('hooks.json', JSON.stringify({sessions: {}}));
      sb.writeFile('session.json', JSON.stringify({windows: []}));
      const psFails: ProcessRunner = () =>
        Promise.resolve({kind: 'failed', reason: 'synthetic: ps refused'});
      const tree: CmuxRunner = () =>
        Promise.resolve({kind: 'ok', stdout: JSON.stringify({windows: []})});
      const panes = await lookupPanes({
        cmux: tree,
        hookStorePath: join(sb.path, 'hooks.json'),
        ps: psFails,
        sessionFilePath: join(sb.path, 'session.json'),
      });
      const {read, states} = await outsideStates({
        agents: fakeAgents([]).run,
        cwds: fakeCwds({}).read,
        panes,
      });
      expect(new Set(Object.values(states))).toEqual(new Set(['unknown']));
      expect(read.facts.get('s-alpha')?.reason).toContain(
        'synthetic: ps refused',
      );
      expect(read.outside).toEqual([]);
    } finally {
      sb.cleanup();
    }
  });
});
