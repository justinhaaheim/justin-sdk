/**
 * `thread open --restore-failed` (home-base-kwand.3 item 2). cmux is a fake
 * runner with a tiny model of windows, workspaces and tabs that records every
 * call; the sessions, the liveness reads and ps are injected. No test reaches
 * the real cmux, ps or inbox (decision D3 of epic home-base-kwand: no real
 * tab is created or closed by any test).
 */

import type {CmuxCall} from '../src/thread/cmux';
import type {LiveSession, LiveSessions} from '../src/thread/live-sessions';
import type {OpenCandidate, OpenOptions} from '../src/thread/open';
import type {
  FailedRestore,
  RestoreFailedDeps,
  RestoreFailedRecord,
  StateCounts,
} from '../src/thread/open-restore-failed';
import type {OldTabResumeState} from '../src/thread/restore-tab';
import type {BeforeRestartEntry} from '../src/thread/session-inbox';

import {afterEach, describe, expect, test} from 'bun:test';
import {existsSync, mkdtempSync, readdirSync, readFileSync, rmSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {PLAIN_STYLE} from '../src/cli-style';
import {BEFORE_RESTART_STATES} from '../src/thread/before-restart-state';
import {opensDir} from '../src/thread/open';
import {
  oldTabSessions,
  openRestoreFailed,
} from '../src/thread/open-restore-failed';
import {recordedWorkspaces, tabsNotClosed} from '../src/thread/open-undo';
import {NO_REOPEN_SIGNALS} from '../src/thread/reopen-order';
import {OLD_TAB_RESUME_STATES, restoreTabArgs} from '../src/thread/restore-tab';

const NOW = new Date('2026-11-18T12:00:00.000Z');
const HOUR = 60 * 60_000;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, {force: true, recursive: true});
});

function sid(n: number): string {
  return `0000000${n}`.slice(-8) + '-1111-4222-8333-000000000000';
}

/** Synthetic cmux uuids: hex only, the first letter says which kind. */
const WINDOW = 'b0000001-0000-4000-8000-000000000000';
const OLD_WS = 'c0000001-0000-4000-8000-000000000000';
const OTHER_WS = 'c0000002-0000-4000-8000-000000000000';
const GONE_WS = 'c0000009-0000-4000-8000-000000000000';
const FAILED_TAB = 'd0000001-0000-4000-8000-000000000000';
const OTHER_TAB = 'd0000002-0000-4000-8000-000000000000';
const FAILED_TAB_2 = 'd0000003-0000-4000-8000-000000000000';
/** kwand.14: a tab back as a plain shell, in OTHER_WS. */
const SHELL_TAB = 'd0000004-0000-4000-8000-000000000000';

function cand(n: number, over: Partial<OpenCandidate> = {}): OpenCandidate {
  return {
    checkout: '/dev/repo-a',
    lastActivityAt: new Date(NOW.getTime() - n * HOUR).toISOString(),
    marks: {handoff: null, mayor: false},
    reopen: NO_REOPEN_SIGNALS,
    repo: 'repo-a',
    repoTag: 'A',
    section: 'needsYou',
    sessionBeadId: `bead-${n}`,
    sessionId: sid(n),
    sessions: 1,
    title: `session ${n}`,
    tracked: true,
    ...over,
  };
}

function failed(
  n: number,
  workspaceId: string,
  over: Partial<OpenCandidate> | null = {},
  state: OldTabResumeState = 'restoreFailed',
): FailedRestore {
  return {
    candidate: over == null ? null : cand(n, over),
    sessionId: sid(n),
    state,
    tabId: n === 1 ? FAILED_TAB : FAILED_TAB_2,
    workspaceId,
  };
}

/** kwand.14: a session whose old tab is back as a plain shell, no error shown. */
function shell(
  n: number,
  workspaceId: string,
  over: Partial<OpenCandidate> | null = {},
): FailedRestore {
  return {...failed(n, workspaceId, over, 'shellInTab'), tabId: SHELL_TAB};
}

/** counts.byState with every count zero but those given. */
function byState(
  over: Partial<Record<OldTabResumeState, Partial<StateCounts>>> = {},
): Record<OldTabResumeState, StateCounts> {
  const zero = {newWorkspace: 0, oldWorkspace: 0, sessions: 0, skipped: 0};
  return {
    restoreFailed: {...zero, ...over.restoreFailed},
    shellInTab: {...zero, ...over.shellInTab},
  };
}

function liveRead(
  live: Record<string, Partial<LiveSession>> = {},
): LiveSessions {
  const bySessionId = new Map<string, LiveSession>();
  for (const [id, entry] of Object.entries(live)) {
    bySessionId.set(id, {
      pid: 7,
      source: 'ps',
      surfaceId: null,
      workspaceId: null,
      ...entry,
    });
  }
  return {
    bySessionId,
    kind: 'read',
    unplaced: [],
    workspacesBySessionId: new Map(),
  };
}

/** The cmux verbs that change something. */
const WRITES = new Set(['new-surface', 'new-workspace']);
/** The verbs no run may ever build (D2: the failed tab is left alone). */
const NEVER = [
  'send',
  'send-key',
  'close-surface',
  'close-workspace',
  'respawn-pane',
];

interface FakeWorkspace {
  id: string;
  ref: string;
  surfaces: string[];
}

function fakeCmux(
  stateDir: string,
  fail: Partial<Record<string, string>> = {},
) {
  const calls: string[][] = [];
  const recordSeenAtWrite: boolean[] = [];
  const workspaces: FakeWorkspace[] = [
    {id: OLD_WS, ref: 'workspace:1', surfaces: [FAILED_TAB, OTHER_TAB]},
    {id: OTHER_WS, ref: 'workspace:2', surfaces: [FAILED_TAB_2, SHELL_TAB]},
  ];
  let next = 0;
  const value = (args: readonly string[], flag: string): string =>
    args[args.indexOf(flag) + 1] ?? '';
  const respond = (args: readonly string[]): CmuxCall => {
    calls.push([...args]);
    const verb =
      args.find((arg) => !arg.startsWith('-') && arg !== 'both') ?? '';
    if (WRITES.has(verb)) {
      const dir = opensDir({JUSTIN_THREADS_STATE_DIR: stateDir});
      recordSeenAtWrite.push(
        existsSync(dir) &&
          readdirSync(dir).some((name) => name.endsWith('.json')),
      );
    }
    const failure = fail[verb];
    if (failure != null)
      return {kind: 'failed', reason: failure, timedOut: false};
    switch (verb) {
      case 'ping':
        return {kind: 'ok', stdout: 'PONG\n'};
      case 'tree':
        return {
          kind: 'ok',
          stdout: JSON.stringify({
            windows: [
              {
                id: WINDOW,
                ref: 'window:1',
                workspaces: workspaces.map((entry) => ({
                  id: entry.id,
                  panes: [{surfaces: entry.surfaces.map((id) => ({id}))}],
                  ref: entry.ref,
                })),
              },
            ],
          }),
        };
      case 'new-surface': {
        const target = workspaces.find(
          (entry) => entry.id === value(args, '--workspace'),
        );
        if (target == null) {
          return {kind: 'failed', reason: 'no such workspace', timedOut: false};
        }
        next += 1;
        target.surfaces.push(`e000000${next}-0000-4000-8000-000000000000`);
        return {
          kind: 'ok',
          stdout: `OK surface:${300 + next} pane:9 workspace:1\n`,
        };
      }
      case 'new-workspace': {
        next += 1;
        const ref = `workspace:${200 + next}`;
        workspaces.push({
          id: `f000000${next}-0000-4000-8000-000000000000`,
          ref,
          surfaces: [],
        });
        return {kind: 'ok', stdout: `OK ${ref}\n`};
      }
      default:
        return {
          kind: 'failed',
          reason: `the fake does not know ${verb}`,
          timedOut: false,
        };
    }
  };
  return {
    calls,
    recordSeenAtWrite,
    run: (args: readonly string[]) => Promise.resolve(respond(args)),
    workspaces,
    writes: () =>
      calls.filter((args) =>
        WRITES.has(args.find((arg) => !arg.startsWith('-')) ?? ''),
      ),
  };
}

function setup(
  sessions: FailedRestore[],
  over: Partial<OpenOptions> = {},
  depsOver: Partial<RestoreFailedDeps> = {},
  fail: Partial<Record<string, string>> = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'thread-open-restore-failed-'));
  dirs.push(dir);
  const stateDir = join(dir, 'state');
  const cmux = fakeCmux(stateDir, fail);
  const options: OpenOptions = {
    argv: ['--restore-failed'],
    days: null,
    dryRun: false,
    env: {
      CMUX_SOCKET_PATH: '/tmp/thread-open-test/cmux.sock',
      HOME: '/nonexistent',
      JUSTIN_THREADS_STATE_DIR: stateDir,
    },
    forceUnplaced: false,
    include: [],
    includeUntracked: false,
    json: false,
    now: NOW,
    perProject: false,
    restoreFailed: true,
    run: null,
    style: PLAIN_STYLE,
    undo: false,
    ...over,
  };
  const deps: Partial<RestoreFailedDeps> = {
    checkoutExists: (path) => !path.includes('gone'),
    lateLive: () => Promise.resolve({kind: 'notLive'}),
    pid: 4242,
    readFailedRestores: () => Promise.resolve({kind: 'read', sessions}),
    readLive: () => Promise.resolve(liveRead()),
    run: cmux.run,
    ...depsOver,
  };
  return {cmux, deps, options, stateDir};
}

function recordFiles(stateDir: string): string[] {
  const dir = opensDir({JUSTIN_THREADS_STATE_DIR: stateDir});
  return existsSync(dir)
    ? readdirSync(dir).filter((name) => name.endsWith('.json'))
    : [];
}

/**
 * No call builds a forbidden verb, or names a failed tab (D2). NEGATIVE
 * CONTROL run: the planner appending `--surface <failed tab>` to new-surface
 * -> the three tests that call this failed ("Expected to not contain" the
 * failed tab's id), and the argv checks with them.
 */
function expectFailedTabsUntouched(calls: readonly string[][]): void {
  for (const args of calls) {
    for (const verb of NEVER) expect(args).not.toContain(verb);
    expect(args).not.toContain(FAILED_TAB);
    expect(args).not.toContain(FAILED_TAB_2);
    expect(args).not.toContain(SHELL_TAB);
    expect(args).not.toContain('--surface');
    expect(args).not.toContain('--pane');
  }
}

const RESUME_1 = `cd /dev/repo-a && claude --resume ${sid(1)}`;

describe('thread open --restore-failed --dry-run', () => {
  // NEGATIVE CONTROL run: the dry-run early return removed (it fell through to
  // the record and the opens) -> this test failed: a record file was written
  // and new-surface / new-workspace were called.
  test('writes nothing and lists the plan', async () => {
    const s = setup([failed(1, OLD_WS), failed(2, GONE_WS)], {
      dryRun: true,
      json: true,
    });
    const result = await openRestoreFailed(s.options, s.deps);
    expect(result.exitCode).toBe(0);
    expect(recordFiles(s.stateDir)).toEqual([]);
    expect(existsSync(s.stateDir)).toBe(false);
    expect(s.cmux.writes()).toEqual([]);
    // Only reads: the ping and one tree.
    expect(
      s.cmux.calls.map((args) =>
        args.find((a) => !a.startsWith('-') && a !== 'both'),
      ),
    ).toEqual(['ping', 'tree']);
    const rec = JSON.parse(result.output) as RestoreFailedRecord;
    expect(rec.dryRun).toBe(true);
    expect(rec.tabs).toEqual([]);
    expect(rec.counts).toEqual({
      byState: byState({
        restoreFailed: {newWorkspace: 1, oldWorkspace: 1, sessions: 2},
      }),
      newWorkspace: 1,
      oldWorkspace: 1,
      skipped: {},
    });
    expect(rec.planned.map((entry) => [entry.sessionId, entry.target])).toEqual(
      [
        [sid(1), 'oldWorkspace'],
        [sid(2), 'newWorkspace'],
      ],
    );
    expect(rec.planned[0]?.args).toEqual([
      'new-surface',
      '--type',
      'terminal',
      '--workspace',
      OLD_WS,
      '--command',
      RESUME_1,
      '--focus',
      'false',
    ]);
    expect(rec.planned[1]?.args).toEqual([
      'new-workspace',
      '--name',
      '[A] session 2',
      '--cwd',
      '/dev/repo-a',
      '--command',
      `claude --resume ${sid(2)}`,
      '--focus',
      'false',
    ]);
  });

  test('the text plan names both groups and the failed tabs', async () => {
    const s = setup([failed(1, OLD_WS), failed(2, GONE_WS)], {dryRun: true});
    const result = await openRestoreFailed(s.options, s.deps);
    expect(result.output).toContain(
      'Would open as a new tab of its old workspace (1)',
    );
    expect(result.output).toContain(
      'Would open in a new workspace (its old one is gone) (1)',
    );
    expect(result.output).toContain(FAILED_TAB);
    expect(result.output).toContain(
      'Run it again without --dry-run to open them.',
    );
    expect(recordFiles(s.stateDir)).toEqual([]);
  });
});

describe('thread open --restore-failed, a real run against the fake cmux', () => {
  // NEGATIVE CONTROLS run: (a) restoreTabArgs always passing --focus true ->
  // this test failed on the new-surface argv ('true' where 'false' was
  // expected); (b) the planner treating a present workspace as gone -> it
  // failed (new-workspace where new-surface was expected).
  test('opens a new tab in the old workspace with --focus false, and a new workspace where the old one is gone', async () => {
    const s = setup([failed(2, GONE_WS), failed(1, OLD_WS)], {json: true});
    const result = await openRestoreFailed(s.options, s.deps);
    expect(result.exitCode).toBe(0);
    const writes = s.cmux.writes();
    expect(writes).toEqual([
      [
        'new-surface',
        '--type',
        'terminal',
        '--workspace',
        OLD_WS,
        '--command',
        RESUME_1,
        '--focus',
        'false',
      ],
      [
        'new-workspace',
        '--name',
        '[A] session 2',
        '--cwd',
        '/dev/repo-a',
        '--command',
        `claude --resume ${sid(2)}`,
        '--focus',
        'false',
      ],
    ]);
    // D-RECORD: the record existed before every write.
    expect(s.cmux.recordSeenAtWrite).toEqual([true, true]);
    expectFailedTabsUntouched(s.cmux.calls);
    // The failed tab is still there, untouched, beside the new one.
    expect(s.cmux.workspaces[0]?.surfaces.slice(0, 2)).toEqual([
      FAILED_TAB,
      OTHER_TAB,
    ]);
    const files = recordFiles(s.stateDir);
    expect(files).toHaveLength(1);
    const onDisk = JSON.parse(
      readFileSync(
        join(opensDir({JUSTIN_THREADS_STATE_DIR: s.stateDir}), files[0] ?? ''),
        'utf8',
      ),
    ) as RestoreFailedRecord;
    expect(onDisk.windows).toEqual([]);
    expect(onDisk.finishedAt).not.toBeNull();
    expect(
      onDisk.tabs.map((tab) => [
        tab.target,
        tab.workspaceId,
        tab.surfaceId,
        tab.failure,
      ]),
    ).toEqual([
      ['oldWorkspace', OLD_WS, 'e0000001-0000-4000-8000-000000000000', null],
      ['newWorkspace', 'f0000002-0000-4000-8000-000000000000', null, null],
    ]);
    expect(onDisk.tabs.every((tab) => tab.openedAt != null)).toBe(true);
  });

  test('a session that runs again, or started meanwhile, is not opened', async () => {
    const s = setup(
      [failed(1, OLD_WS), failed(2, OTHER_WS)],
      {json: true},
      {
        lateLive: (id) =>
          Promise.resolve(
            id === sid(2) ? {kind: 'live', pid: 99} : {kind: 'notLive'},
          ),
        readLive: () => Promise.resolve(liveRead({[sid(1)]: {pid: 5}})),
      },
    );
    // NEGATIVE CONTROL run: the planner's live check removed -> this test
    // failed (session 1 was opened with new-surface).
    const result = await openRestoreFailed(s.options, s.deps);
    expect(result.exitCode).toBe(0);
    expect(s.cmux.writes()).toEqual([]);
    expect(result.record?.counts.skipped).toEqual({running: 1});
    expect(result.record?.lateLive.map((entry) => entry.sessionId)).toEqual([
      sid(2),
    ]);
  });

  test('the first open that fails stops the run, and the record names it', async () => {
    const s = setup(
      [failed(1, OLD_WS), failed(2, OTHER_WS)],
      {json: true},
      {},
      {'new-surface': 'Error: overloaded'},
    );
    const result = await openRestoreFailed(s.options, s.deps);
    expect(result.exitCode).toBe(1);
    expect(s.cmux.writes()).toHaveLength(1);
    expect(result.record?.tabs.map((tab) => tab.failure)).toEqual([
      'Error: overloaded',
    ]);
    expect(result.record?.failures[0]).toContain('nothing after it was opened');
    expectFailedTabsUntouched(s.cmux.calls);
  });
});

describe('which sessions are skipped, by reason', () => {
  test('each reason is counted, and none of them opens', async () => {
    const s = setup(
      [
        failed(1, OLD_WS, null),
        failed(2, OLD_WS, {tracked: false}),
        failed(3, OLD_WS, {section: 'done'}),
        failed(4, OLD_WS, {section: 'handedOff'}),
        failed(5, OLD_WS, {checkout: null}),
        failed(6, OLD_WS, {checkout: '/dev/gone'}),
        failed(7, 'not-a-uuid'),
        failed(8, OLD_WS, {repo: 'repo-b', repoTag: 'B'}),
      ],
      {json: true, repos: ['repo-a']},
    );
    const result = await openRestoreFailed(s.options, s.deps);
    expect(result.exitCode).toBe(0);
    expect(s.cmux.writes()).toEqual([]);
    expect(result.record?.counts).toEqual({
      byState: byState({restoreFailed: {sessions: 8, skipped: 8}}),
      newWorkspace: 0,
      oldWorkspace: 0,
      skipped: {
        checkoutGone: 1,
        checkoutUnknown: 1,
        doneOrArchived: 1,
        handedOff: 1,
        noInboxRow: 1,
        otherRepo: 1,
        untracked: 1,
        workspaceUnknown: 1,
      },
    });
  });

  test('--limit keeps the newest and counts the rest', async () => {
    const s = setup([failed(2, OTHER_WS), failed(1, OLD_WS)], {
      dryRun: true,
      json: true,
      limit: 1,
    });
    const result = await openRestoreFailed(s.options, s.deps);
    expect(result.record?.planned.map((entry) => entry.sessionId)).toEqual([
      sid(1),
    ]);
    expect(result.record?.counts.skipped).toEqual({overLimit: 1});
  });
});

describe('refusals', () => {
  test.each([
    ['--since', {since: '3d'}],
    ['--days', {days: 3}],
    ['--include-open', {includeOpen: true}],
    ['--per-project', {perProject: true}],
    ['--include', {include: ['answered']}],
    ['--undo', {undo: true}],
    ['--list', {list: true}],
  ] as const)('%s is refused before cmux is reached', async (flag, over) => {
    const s = setup([failed(1, OLD_WS)], over);
    const result = await openRestoreFailed(s.options, s.deps);
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain(flag);
    expect(s.cmux.calls).toEqual([]);
  });

  // NEGATIVE CONTROL run: an unreadable tree read as an empty one -> this
  // test failed (exit 0, and session 1 planned into a new workspace).
  test('an unreadable cmux tree refuses: it is not "every workspace is gone"', async () => {
    const s = setup(
      [failed(1, OLD_WS)],
      {dryRun: true},
      {},
      {tree: 'Error: timed out'},
    );
    const result = await openRestoreFailed(s.options, s.deps);
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain(
      'whether each old workspace still exists is not known',
    );
    expect(s.cmux.writes()).toEqual([]);
  });

  test('a live Claude pane that cannot be placed refuses unless --force-unplaced', async () => {
    const unplaced: LiveSessions = {
      ...(liveRead() as Extract<LiveSessions, {kind: 'read'}>),
      unplaced: [
        {
          detail: 'no session id on screen',
          kind: 'pane',
          pid: null,
          surfaceId: OTHER_TAB,
          surfaceRef: 'surface:2',
          tty: null,
          workspaceId: OLD_WS,
        },
      ],
    };
    const refused = setup(
      [failed(1, OLD_WS)],
      {},
      {readLive: () => Promise.resolve(unplaced)},
    );
    const result = await openRestoreFailed(refused.options, refused.deps);
    expect(result.exitCode).toBe(2);
    expect(refused.cmux.writes()).toEqual([]);
    const forced = setup(
      [failed(1, OLD_WS)],
      {forceUnplaced: true},
      {readLive: () => Promise.resolve(unplaced)},
    );
    expect(
      (await openRestoreFailed(forced.options, forced.deps)).exitCode,
    ).toBe(0);
    expect(forced.cmux.writes()).toHaveLength(1);
  });
});

/** A restart grouping entry with no inbox row (oldTabSessions' input). */
function entryOf(
  sessionId: string,
  state: (typeof BEFORE_RESTART_STATES)[number],
): BeforeRestartEntry {
  return {
    fact: {
      reason: 'synthetic',
      restartAt: NOW.toISOString(),
      restartKind: 'cmux launch',
      source: {kind: 'launch record', savedAt: NOW.toISOString()},
      state,
      tab: {
        carried: false,
        id: `tab-${sessionId}`,
        title: null,
        windowIndex: 0,
        workspaceId: OTHER_WS,
        workspaceTitle: null,
      },
    },
    row: null,
    sessionId,
  };
}

// home-base-kwand.14: a session whose old tab is back as a plain shell with
// no cmux error shown gets the same resume, and the output keeps the two
// states apart.
describe('thread open --restore-failed, shell in tab (kwand.14)', () => {
  const RESUME_3 = `cd /dev/repo-a && claude --resume ${sid(3)}`;

  // NEGATIVE CONTROLS run 2026-11-18: (a) the planner treating a shell-in-tab
  // session's workspace as always present -> this test failed (oldWorkspace
  // where newWorkspace was expected for the gone one); (b) the dry-run early
  // return removed -> it failed, with the two dry-run tests above.
  test('--dry-run plans a new tab in its old workspace, falls back to a new workspace when it is gone, writes nothing, and counts each state apart', async () => {
    const s = setup(
      [failed(1, OLD_WS), shell(3, OTHER_WS), shell(4, GONE_WS)],
      {dryRun: true, json: true},
    );
    const result = await openRestoreFailed(s.options, s.deps);
    expect(result.exitCode).toBe(0);
    expect(recordFiles(s.stateDir)).toEqual([]);
    expect(existsSync(s.stateDir)).toBe(false);
    expect(s.cmux.writes()).toEqual([]);
    const rec = JSON.parse(result.output) as RestoreFailedRecord;
    expect(
      rec.planned.map((entry) => [entry.sessionId, entry.state, entry.target]),
    ).toEqual([
      [sid(1), 'restoreFailed', 'oldWorkspace'],
      [sid(3), 'shellInTab', 'oldWorkspace'],
      [sid(4), 'shellInTab', 'newWorkspace'],
    ]);
    expect(rec.planned[1]?.args).toEqual([
      'new-surface',
      '--type',
      'terminal',
      '--workspace',
      OTHER_WS,
      '--command',
      RESUME_3,
      '--focus',
      'false',
    ]);
    expect(rec.planned[1]?.failedTabId).toBe(SHELL_TAB);
    expect(rec.planned[2]?.args.slice(0, 2)).toEqual([
      'new-workspace',
      '--name',
    ]);
    expect(rec.planned[2]?.args).toContain(`claude --resume ${sid(4)}`);
    expect(rec.counts).toEqual({
      byState: byState({
        restoreFailed: {oldWorkspace: 1, sessions: 1},
        shellInTab: {newWorkspace: 1, oldWorkspace: 1, sessions: 2},
      }),
      newWorkspace: 1,
      oldWorkspace: 2,
      skipped: {},
    });
  });

  test('the text names each state on its own line and on each old tab', async () => {
    const s = setup([failed(1, OLD_WS), shell(3, OTHER_WS)], {dryRun: true});
    const result = await openRestoreFailed(s.options, s.deps);
    expect(result.output).toContain(
      'sessions whose old tab came back without Claude',
    );
    expect(result.output).toMatch(
      /Restore failed: +💥 1 session \(restore failed: it shows cmux's restore error\); would open 1, skipped 0/u,
    );
    expect(result.output).toMatch(
      /Shell in tab: +🐚 1 session \(back as a plain shell, no Claude, no cmux error shown\); would open 1, skipped 0/u,
    );
    expect(result.output).toContain(
      `💥 ${FAILED_TAB}: restore failed: it shows cmux's restore error`,
    );
    expect(result.output).toContain(
      `🐚 ${SHELL_TAB}: back as a plain shell, no Claude, no cmux error shown`,
    );
  });

  // NEGATIVE CONTROL run 2026-11-18: the planner's live check applied to
  // restoreFailed only -> the running shell-in-tab session was opened too and
  // this test failed.
  test('a real run opens the shell-in-tab session beside its old tab, never touches that tab, and skips one that runs again', async () => {
    const s = setup(
      [shell(3, OTHER_WS), shell(5, OTHER_WS)],
      {json: true},
      {readLive: () => Promise.resolve(liveRead({[sid(5)]: {pid: 9}}))},
    );
    const result = await openRestoreFailed(s.options, s.deps);
    expect(result.exitCode).toBe(0);
    // NEGATIVE CONTROL run 2026-11-18: the planner appending `--surface <shell
    // tab>` to a shell-in-tab session's new-surface -> this line failed
    // ("Expected to not contain" the shell tab's id).
    expectFailedTabsUntouched(s.cmux.calls);
    expect(s.cmux.writes()).toEqual([
      [
        'new-surface',
        '--type',
        'terminal',
        '--workspace',
        OTHER_WS,
        '--command',
        RESUME_3,
        '--focus',
        'false',
      ],
    ]);
    expect(s.cmux.recordSeenAtWrite).toEqual([true]);
    expect(s.cmux.workspaces[1]?.surfaces.slice(0, 2)).toEqual([
      FAILED_TAB_2,
      SHELL_TAB,
    ]);
    expect(
      result.record?.tabs.map((tab) => [tab.sessionId, tab.state, tab.target]),
    ).toEqual([[sid(3), 'shellInTab', 'oldWorkspace']]);
    expect(result.record?.skipped.map((entry) => entry.state)).toEqual([
      'shellInTab',
    ]);
    expect(result.record?.counts.byState.shellInTab).toEqual({
      newWorkspace: 0,
      oldWorkspace: 1,
      sessions: 2,
      skipped: 1,
    });
  });

  // NEGATIVE CONTROL run 2026-11-18: oldTabSessions also taking `unknown`
  // -> this test failed (the unknown session was selected).
  test('only restore failed and shell in tab are selected from the restart grouping; every other state is left out', () => {
    expect([...OLD_TAB_RESUME_STATES]).toEqual(['restoreFailed', 'shellInTab']);
    const groups = BEFORE_RESTART_STATES.map((state, index) => ({
      entries: [entryOf(sid(10 + index), state)],
      state,
    }));
    const picked = oldTabSessions(groups);
    expect(picked.map((entry) => [entry.sessionId, entry.state])).toEqual([
      [sid(10), 'restoreFailed'],
      [sid(11), 'shellInTab'],
    ]);
    expect(picked[1]).toMatchObject({
      candidate: null,
      tabId: `tab-${sid(11)}`,
      workspaceId: OTHER_WS,
    });
  });
});

describe('the one new-surface builder (restore-tab.ts)', () => {
  test('refuses a workspace that is not a uuid, or an empty command', () => {
    expect(
      restoreTabArgs({command: 'x', focus: false, workspaceId: 'workspace:1'}),
    ).toBeNull();
    expect(
      restoreTabArgs({command: ' ', focus: false, workspaceId: OLD_WS}),
    ).toBeNull();
    expect(
      restoreTabArgs({command: 'x', focus: true, workspaceId: OLD_WS})?.at(-1),
    ).toBe('true');
  });
});

describe('thread open --undo of a --restore-failed run', () => {
  // NEGATIVE CONTROLS run: (a) recordedWorkspaces without the tabs part ->
  // this test failed (the fallback workspace was not closable); (b)
  // tabsNotClosed returning [] -> it failed (the old-workspace tab was not
  // named).
  test('closes the fallback workspace through the usual gates and names the tab for closing by hand', async () => {
    const s = setup([failed(1, OLD_WS), failed(2, GONE_WS)], {json: true});
    const result = await openRestoreFailed(s.options, s.deps);
    expect(result.exitCode).toBe(0);
    const files = recordFiles(s.stateDir);
    const record = JSON.parse(
      readFileSync(
        join(opensDir({JUSTIN_THREADS_STATE_DIR: s.stateDir}), files[0] ?? ''),
        'utf8',
      ),
    ) as Parameters<typeof recordedWorkspaces>[0];
    expect(recordedWorkspaces(record)).toEqual([
      {
        name: '[A] session 2',
        sessionId: sid(2),
        windowId: null,
        workspaceId: 'f0000002-0000-4000-8000-000000000000',
      },
    ]);
    const notClosed = tabsNotClosed(record);
    expect(
      notClosed.map((entry) => [
        entry.sessionId,
        entry.workspaceId,
        entry.surfaceId,
      ]),
    ).toEqual([[sid(1), OLD_WS, 'e0000001-0000-4000-8000-000000000000']]);
    expect(notClosed[0]?.reason).toContain('Close the tab by hand');
    // The old workspace itself is never in the closable list.
    expect(
      recordedWorkspaces(record).map((entry) => entry.workspaceId),
    ).not.toContain(OLD_WS);
  });
});
