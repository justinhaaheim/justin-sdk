/**
 * `thread open` (home-base-yukaf.1). cmux is a fake runner that keeps a tiny
 * model of windows and workspaces and records every call; the inbox rows and
 * the liveness read are injected. No test reaches the real cmux, ps or the
 * hook store (D-NO-LIVE-RUNS).
 */

import type {CmuxCall} from '../src/thread/cmux';
import type {
  LiveSession,
  LiveSessions,
  UnplacedLive,
} from '../src/thread/live-sessions';
import type {
  OpenCandidate,
  OpenDeps,
  OpenOptions,
  OpenRecord,
} from '../src/thread/open';
import type {LiveSurface, Proc} from '../src/thread/pane-join';
import type {InboxSection} from '../src/thread/session-card';

import {afterEach, describe, expect, test} from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {PLAIN_STYLE} from '../src/cli-style';
import {resolveThreadConfig} from '../src/thread/config';
import {
  argvSessionId,
  isSessionProc,
  joinLiveSessions,
  readLiveSessions,
} from '../src/thread/live-sessions';
import {
  openLockPath,
  opensDir,
  openSessions,
  OWN_PANE_REASON,
  resumeCommand,
  writeJsonFile,
} from '../src/thread/open';
import {DEFAULT_PROJECT_COLORS} from '../src/thread/open-colors';
import {parseSince} from '../src/thread/open-filters';
import {readRuns, renderRuns} from '../src/thread/open-list';

const NOW = new Date('2026-10-18T12:00:00.000Z');
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, {force: true, recursive: true});
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'thread-open-'));
  dirs.push(dir);
  return dir;
}

/** A session id from a short number, uuid-shaped. */
function sid(n: number): string {
  return `0000000${n}`.slice(-8) + '-1111-4222-8333-000000000000';
}

function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

function cand(n: number, over: Partial<OpenCandidate> = {}): OpenCandidate {
  return {
    checkout: '/dev/repo-a',
    lastActivityAt: ago(n * HOUR),
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

function liveRead(
  live: Record<string, Partial<LiveSession>> = {},
  unplaced: UnplacedLive[] = [],
): LiveSessions {
  const bySessionId = new Map<string, LiveSession>();
  for (const [id, entry] of Object.entries(live)) {
    bySessionId.set(id, {
      pid: 1,
      source: 'ps',
      surfaceId: null,
      workspaceId: null,
      ...entry,
    });
  }
  return {bySessionId, kind: 'read', unplaced};
}

/** The cmux commands that change something; everything else only reads. */
const WRITES = new Set([
  'close-workspace',
  'move-workspace-to-window',
  'new-window',
  'new-workspace',
  'reorder-workspaces',
  'workspace-action',
]);

function commandOf(args: readonly string[]): string {
  return args.find((arg) => !arg.startsWith('-') && arg !== 'both') ?? '';
}

interface FakeCmux {
  calls: string[][];
  /** For each move, the record's `moved` on disk at that moment (yukaf.22). */
  movedOnDiskAtMove: unknown[];
  /** For each write, in order: whether the record file existed at that moment. */
  recordSeenAtWrite: boolean[];
  run: (args: readonly string[]) => Promise<CmuxCall>;
  windows: Map<string, FakeWorkspace[]>;
  writes: () => string[][];
}

/** A workspace in the fake tree; `surfaces` are its surface uuids (none by default). */
interface FakeWorkspace {
  id: string;
  ref: string;
  surfaces?: string[];
}

function fakeCmux(
  stateDir: string,
  fail: Partial<Record<string, string>> = {},
): FakeCmux {
  const calls: string[][] = [];
  const windows = new Map<string, FakeWorkspace[]>();
  const recordSeenAtWrite: boolean[] = [];
  const movedOnDiskAtMove: unknown[] = [];
  const recordOnDisk = (): Record<string, unknown> | null => {
    const dir = opensDir({JUSTIN_THREADS_STATE_DIR: stateDir});
    if (!existsSync(dir)) return null;
    const name = readdirSync(dir)
      .filter((entry) => entry.endsWith('.json'))
      .sort()
      .at(-1);
    return name == null
      ? null
      : (JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<
          string,
          unknown
        >);
  };
  let next = 0;
  const uuid = (prefix: string): string => {
    next += 1;
    // One hex letter, then 7 digits: uuid-shaped, and the letter says which kind.
    return `${prefix}${`000000${next}`.slice(-7)}-AAAA-4AAA-8AAA-AAAAAAAAAAAA`;
  };
  const value = (args: readonly string[], flag: string): string =>
    args[args.indexOf(flag) + 1] ?? '';
  const respond = (args: readonly string[]): CmuxCall => {
    calls.push([...args]);
    const command = commandOf(args);
    if (WRITES.has(command)) {
      const dir = opensDir({JUSTIN_THREADS_STATE_DIR: stateDir});
      recordSeenAtWrite.push(
        existsSync(dir) &&
          readdirSync(dir).some((name) => name.endsWith('.json')),
      );
    }
    const failure = fail[command];
    if (failure != null) return {kind: 'failed', reason: failure};
    switch (command) {
      case 'ping':
        return {kind: 'ok', stdout: 'PONG\n'};
      case 'new-window': {
        const id = uuid('B');
        windows.set(id, [{id: uuid('D'), ref: `workspace:${100 + next}`}]);
        return {kind: 'ok', stdout: `OK ${id}\n`};
      }
      case 'workspace': {
        const list = windows.get(value(args, '--window')) ?? [];
        return {kind: 'ok', stdout: JSON.stringify({workspaces: list})};
      }
      case 'new-workspace': {
        const list = windows.get(value(args, '--window'));
        if (list == null) return {kind: 'failed', reason: 'no such window'};
        const id = uuid('C');
        const ref = `workspace:${200 + next}`;
        list.push({id, ref});
        return {kind: 'ok', stdout: `OK ${ref}\n`};
      }
      case 'reorder-workspaces':
        return {kind: 'ok', stdout: 'OK\n'};
      case 'tree':
        return {
          kind: 'ok',
          stdout: JSON.stringify({
            windows: [...windows.entries()].map(([id, list]) => ({
              id,
              ref: `window:${id.slice(0, 2)}`,
              workspaces: list.map((entry) => ({
                id: entry.id,
                panes: [
                  {
                    surfaces: (entry.surfaces ?? []).map((surface) => ({
                      id: surface,
                    })),
                  },
                ],
              })),
            })),
          }),
        };
      case 'move-workspace-to-window': {
        movedOnDiskAtMove.push(recordOnDisk()?.moved ?? null);
        const target = windows.get(value(args, '--window'));
        const id = value(args, '--workspace');
        const from = [...windows.values()].find((list) =>
          list.some((entry) => entry.id === id),
        );
        const entry = from?.find((item) => item.id === id);
        if (target == null || from == null || entry == null) {
          return {kind: 'failed', reason: 'no such workspace or window'};
        }
        from.splice(from.indexOf(entry), 1);
        target.push(entry);
        return {kind: 'ok', stdout: 'OK\n'};
      }
      case 'workspace-action':
        return {
          kind: 'ok',
          stdout: `OK color=${value(args, '--color')}\n`,
        };
      case 'close-workspace': {
        const list = windows.get(value(args, '--window')) ?? [];
        const target = value(args, '--workspace');
        windows.set(
          value(args, '--window'),
          list.filter((entry) => entry.id !== target),
        );
        return {kind: 'ok', stdout: 'OK\n'};
      }
      default:
        return {kind: 'failed', reason: `the fake does not know ${command}`};
    }
  };
  const run = (args: readonly string[]): Promise<CmuxCall> =>
    Promise.resolve(respond(args));
  return {
    calls,
    movedOnDiskAtMove,
    recordSeenAtWrite,
    run,
    windows,
    writes: () => calls.filter((args) => WRITES.has(commandOf(args))),
  };
}

interface Setup {
  cmux: FakeCmux;
  deps: Partial<OpenDeps>;
  options: OpenOptions;
  stateDir: string;
}

function setup(
  candidates: OpenCandidate[],
  over: Partial<OpenOptions> = {},
  live: LiveSessions = liveRead(),
): Setup {
  const stateDir = join(tempDir(), 'state');
  const cmux = fakeCmux(stateDir);
  const options: OpenOptions = {
    argv: [],
    // yukaf.22: no flag sets the window, so configSince (below, "7d") does.
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
    run: null,
    style: PLAIN_STYLE,
    undo: false,
    ...over,
  };
  const deps: Partial<OpenDeps> = {
    checkoutExists: (path) => !path.includes('gone'),
    // Never the real config files here.
    configSince: () => ({problems: [], since: '7d', source: 'default'}),
    // F21's re-check before each new workspace: never the real ps here.
    lateLive: () => Promise.resolve({kind: 'notLive'}),
    pid: 4242,
    readCandidates: () => Promise.resolve({candidates, kind: 'read'}),
    readLive: () => Promise.resolve(live),
    run: cmux.run,
  };
  return {cmux, deps, options, stateDir};
}

function planned(rec: OpenRecord | null): string[] {
  return (rec?.planned ?? []).map((entry) => entry.sessionId);
}

const ALL_SECTIONS: InboxSection[] = [
  'needsYou',
  'toLand',
  'stoppedOpen',
  'checkByHand',
  'answered',
  'handedOff',
  'doneQuestions',
  'working',
  'done',
  'archived',
];

describe('which sessions reopen (D-UNFINISHED)', () => {
  const candidates = ALL_SECTIONS.map((section, index) =>
    cand(index + 1, {section}),
  );

  test('the default set is needsYou, toLand, stoppedOpen and checkByHand', async () => {
    const s = setup(candidates, {dryRun: true});
    const result = await openSessions(s.options, s.deps);
    expect(result.exitCode).toBe(0);
    expect(planned(result.record)).toEqual([sid(1), sid(2), sid(3), sid(4)]);
    expect(result.record?.skipped.map((entry) => entry.section)).toEqual([
      'answered',
      'handedOff',
      'doneQuestions',
      'working',
    ]);
    expect(result.record?.hidden.doneOrArchived).toBe(2);
    expect(result.record?.skipped[0]?.reason).toContain(
      '--include answered adds it',
    );
  });

  test('--include adds answered and handedOff, comma-separated, and nothing else', async () => {
    const s = setup(candidates, {
      dryRun: true,
      include: ['answered,handedOff'],
    });
    const result = await openSessions(s.options, s.deps);
    expect(planned(result.record)).toEqual([
      sid(1),
      sid(2),
      sid(3),
      sid(4),
      sid(5),
      sid(6),
    ]);
    expect(result.record?.skipped.map((entry) => entry.section)).toEqual([
      'doneQuestions',
      'working',
    ]);
  });

  test('an unknown --include value refuses with exit 2 before cmux is touched', async () => {
    const s = setup(candidates, {include: ['working']});
    const result = await openSessions(s.options, s.deps);
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('not: working');
    expect(s.cmux.calls).toEqual([]);
  });

  test('untracked sessions are only counted; a missing checkout is skipped', async () => {
    const s = setup(
      [
        cand(1, {checkout: '/dev/gone'}),
        cand(2, {sessions: 3, tracked: false}),
        cand(3),
      ],
      {dryRun: true},
    );
    const result = await openSessions(s.options, s.deps);
    expect(planned(result.record)).toEqual([sid(3)]);
    expect(result.record?.untracked.count).toBe(3);
    expect(result.record?.skipped[0]?.reason).toContain('no longer exists');
  });

  test('--include-untracked refuses as not built yet, touching nothing', async () => {
    const s = setup([cand(1)], {includeUntracked: true});
    const result = await openSessions(s.options, s.deps);
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('not built yet');
    expect(s.cmux.calls).toEqual([]);
  });

  test('openSessions never undoes: --undo and --run belong to undoOpen (yukaf.2), touching nothing', async () => {
    for (const over of [{undo: true}, {run: 'x'}]) {
      const s = setup([cand(1)], over);
      const result = await openSessions(s.options, s.deps);
      expect(result.exitCode).toBe(2);
      expect(result.output).toContain('undoOpen');
      expect(s.cmux.calls).toEqual([]);
    }
  });
});

describe('the cutoff (D-CUTOFF)', () => {
  const candidates = [
    cand(1, {lastActivityAt: ago(6 * DAY)}),
    cand(2, {lastActivityAt: ago(8 * DAY)}),
    cand(3, {lastActivityAt: null}),
  ];

  test('7 days by default: an older or undated session is counted, not opened', async () => {
    const s = setup(candidates, {dryRun: true});
    const result = await openSessions(s.options, s.deps);
    expect(planned(result.record)).toEqual([sid(1)]);
    expect(result.record?.hidden.olderThanCutoff).toBe(2);
  });

  test('--days 10 takes the 8-day-old session in; the undated one never', async () => {
    const s = setup(candidates, {days: 10, dryRun: true});
    const result = await openSessions(s.options, s.deps);
    expect(planned(result.record)).toEqual([sid(1), sid(2)]);
    expect(result.record?.hidden.olderThanCutoff).toBe(1);
  });
});

describe('liveness', () => {
  test('a live session is skipped and listed as already open with its pane command', async () => {
    const s = setup(
      [cand(1), cand(2)],
      {dryRun: true},
      liveRead({[sid(1)]: {source: 'screen', workspaceId: 'WS-1'}}),
    );
    const result = await openSessions(s.options, s.deps);
    expect(planned(result.record)).toEqual([sid(2)]);
    expect(result.record?.alreadyOpen).toHaveLength(1);
    expect(result.record?.alreadyOpen[0]?.command).toBe(
      'cmux select-workspace --workspace WS-1',
    );
    // yukaf.22 item 4 renamed the section and names the flag that moves them.
    expect(result.output).toContain(
      'Already open elsewhere (1) — pass --include-open to move them into this window',
    );
  });

  test('a failed liveness read exits 2 and makes zero cmux writes and no record', async () => {
    const s = setup([cand(1)], {}, {kind: 'failed', reason: 'ps refused'});
    const result = await openSessions(s.options, s.deps);
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('ps refused');
    expect(s.cmux.writes()).toEqual([]);
    // The run lock (F21) creates opens/ and is removed again; no record is in it.
    const dir = opensDir({JUSTIN_THREADS_STATE_DIR: s.stateDir});
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });

  test('an unplaced Claude pane refuses with exit 2 and zero writes; --force-unplaced opens', async () => {
    const pane: UnplacedLive = {
      detail: 'its screen shows no "⌗ <session id>"',
      kind: 'pane',
      pid: 9,
      surfaceId: 'S-9',
      surfaceRef: 'surface:9',
      tty: 'ttys009',
      workspaceId: 'WS-9',
    };
    const refused = setup([cand(1)], {}, liveRead({}, [pane]));
    const first = await openSessions(refused.options, refused.deps);
    expect(first.exitCode).toBe(2);
    expect(first.record?.refused).toContain('--force-unplaced');
    expect(first.output).toContain('Cannot tell (1)');
    expect(refused.cmux.writes()).toEqual([]);

    const forced = setup(
      [cand(1)],
      {forceUnplaced: true},
      liveRead({}, [pane]),
    );
    const second = await openSessions(forced.options, forced.deps);
    expect(second.exitCode).toBe(0);
    expect(forced.cmux.writes().length).toBeGreaterThan(0);
  });
});

describe('the record (D-RECORD)', () => {
  // NEGATIVE CONTROL (2026-10-18, recorded on home-base-yukaf.1): moving the
  // first record write in openSessions to after the window loop made this test
  // fail on `expect(cmux.recordSeenAtWrite[0]).toBe(true)` (received false);
  // restored, it passes.
  test('the record file exists before the first cmux write, and ends with every uuid', async () => {
    const s = setup([cand(2), cand(1)]);
    const result = await openSessions(s.options, s.deps);
    // The order first: it is what this test is for.
    expect(s.cmux.recordSeenAtWrite.length).toBeGreaterThan(0);
    expect(s.cmux.recordSeenAtWrite[0]).toBe(true);
    expect(s.cmux.recordSeenAtWrite.every(Boolean)).toBe(true);
    expect(result.exitCode).toBe(0);
    const path = result.recordPath ?? '';
    const saved = JSON.parse(readFileSync(path, 'utf8')) as OpenRecord;
    expect(saved.planned.map((entry) => entry.sessionId)).toEqual([
      sid(1),
      sid(2),
    ]);
    const [window] = saved.windows;
    expect(window?.windowId).toMatch(/^B/u);
    expect(window?.workspaces.map((entry) => entry.sessionId)).toEqual([
      sid(1),
      sid(2),
    ]);
    expect(window?.workspaces.every((entry) => entry.workspaceId != null)).toBe(
      true,
    );
    expect(window?.strayClosed).toEqual(
      window?.defaultWorkspaceIds ?? ['missing'],
    );
    expect(saved.finishedAt).not.toBeNull();
  });

  test('a record that cannot be written stops the run before any cmux write (exit 1)', async () => {
    const s = setup([cand(1)]);
    const result = await openSessions(s.options, {
      ...s.deps,
      writeRecord: () => 'EACCES',
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('could not be written');
    expect(s.cmux.writes()).toEqual([]);
  });

  test('a record that cannot be rewritten stops the run after the first write', async () => {
    const s = setup([cand(1), cand(2)]);
    let writes = 0;
    const writeRecord = (): string | null => {
      writes += 1;
      return writes === 1 ? null : 'disk full';
    };
    const result = await openSessions(s.options, {...s.deps, writeRecord});
    expect(result.exitCode).toBe(1);
    expect(s.cmux.writes().map(commandOf)).toEqual(['new-window']);
  });
});

describe('the layout (D-LAYOUT)', () => {
  const candidates = [
    cand(3, {checkout: '/dev/repo-a', repo: 'repo-a'}),
    cand(1, {checkout: '/dev/repo-b', repo: 'repo-b', repoTag: 'B'}),
    cand(2, {checkout: '/dev/repo-a', repo: 'repo-a'}),
    cand(4, {checkout: '/dev/repo-b', repo: 'repo-b', repoTag: 'B'}),
  ];

  test('--per-project: one window per repo, the repo with the newest session first', async () => {
    const s = setup(candidates, {perProject: true});
    const result = await openSessions(s.options, s.deps);
    expect(result.exitCode).toBe(0);
    expect(result.record?.windows.map((window) => window.repo)).toEqual([
      'repo-b',
      'repo-a',
    ]);
    expect(result.record?.windows.map((window) => window.sessionIds)).toEqual([
      [sid(1), sid(4)],
      [sid(2), sid(3)],
    ]);
    expect(
      s.cmux.writes().filter((args) => commandOf(args) === 'new-window'),
    ).toHaveLength(2);
    const made = s.cmux
      .writes()
      .filter((args) => commandOf(args) === 'new-workspace');
    expect(made.map((args) => args[args.indexOf('--cwd') + 1])).toEqual([
      '/dev/repo-b',
      '/dev/repo-b',
      '/dev/repo-a',
      '/dev/repo-a',
    ]);
    expect(made[0]).toContain('--focus');
    expect(made[0]?.[made[0].indexOf('--name') + 1]).toBe('[B] session 1');
    expect(made[0]?.[made[0].indexOf('--command') + 1]).toBe(
      resumeCommand(sid(1)),
    );
  });

  test('the default is one window, newest first, and reorder-workspaces gets the uuids newest first', async () => {
    const s = setup(candidates);
    const result = await openSessions(s.options, s.deps);
    expect(result.exitCode).toBe(0);
    expect(result.record?.windows).toHaveLength(1);
    const window = result.record?.windows[0];
    expect(window?.sessionIds).toEqual([sid(1), sid(2), sid(3), sid(4)]);
    const reorder =
      s.cmux
        .writes()
        .find((args) => commandOf(args) === 'reorder-workspaces') ?? [];
    const order = reorder[reorder.indexOf('--order') + 1]?.split(',');
    expect(order).toEqual(
      window?.workspaces.map((entry) => entry.workspaceId ?? 'missing'),
    );
    expect(order?.every((id) => id.startsWith('C'))).toBe(true);
    expect(reorder[reorder.indexOf('--window') + 1]).toBe(
      window?.windowId ?? 'missing',
    );
    // The stray default workspace goes last, and only that one.
    const closes = s.cmux
      .writes()
      .filter((args) => commandOf(args) === 'close-workspace');
    expect(closes).toHaveLength(1);
    expect(closes[0]?.[closes[0].indexOf('--workspace') + 1]).toBe(
      window?.defaultWorkspaceIds?.[0] ?? 'missing',
    );
    expect(s.cmux.writes().map(commandOf).at(-1)).toBe('close-workspace');
  });

  test('a failed new-workspace stops the run: nothing after it is opened, exit 1', async () => {
    const stateDir = join(tempDir(), 'state');
    const cmux = fakeCmux(stateDir, {'new-workspace': 'boom'});
    const s = setup(candidates);
    const result = await openSessions(
      {
        ...s.options,
        env: {...s.options.env, JUSTIN_THREADS_STATE_DIR: stateDir},
      },
      {...s.deps, run: cmux.run},
    );
    expect(result.exitCode).toBe(1);
    expect(cmux.writes().map(commandOf)).toEqual([
      'new-window',
      'new-workspace',
    ]);
    expect(result.output).toContain('nothing after it was opened');
  });
});

describe('overlapping runs (home-base-yukaf.14 F21)', () => {
  const MINUTE = 60_000;
  const writeLock = (s: Setup, at: Date, pid = 999): string => {
    const path = openLockPath({JUSTIN_THREADS_STATE_DIR: s.stateDir});
    mkdirSync(opensDir({JUSTIN_THREADS_STATE_DIR: s.stateDir}), {
      recursive: true,
    });
    writeFileSync(path, JSON.stringify({at: at.toISOString(), pid}));
    return path;
  };

  test('a run lock held by another run refuses with exit 2 and no cmux write; the lock is left alone', async () => {
    const s = setup([cand(1)]);
    const path = writeLock(s, new Date(NOW.getTime() - 2 * MINUTE));
    const result = await openSessions(s.options, s.deps);
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('another thread open is running (pid 999');
    expect(s.cmux.writes()).toEqual([]);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({pid: 999});
  });

  test('a lock older than 10 minutes is replaced; the run opens and removes its own lock', async () => {
    const s = setup([cand(1)]);
    const path = writeLock(s, new Date(NOW.getTime() - 11 * MINUTE));
    const result = await openSessions(s.options, s.deps);
    expect(result.exitCode).toBe(0);
    expect(planned(result.record)).toEqual([sid(1)]);
    expect(existsSync(path)).toBe(false);
  });

  test('the lock exists while the run writes to cmux, and a dry run takes none', async () => {
    const s = setup([cand(1)]);
    const path = openLockPath({JUSTIN_THREADS_STATE_DIR: s.stateDir});
    let heldDuringWrite: unknown = null;
    const run = s.deps.run;
    if (run == null) throw new Error('no runner');
    s.deps.run = async (args) => {
      if (commandOf(args) === 'new-workspace' && heldDuringWrite == null) {
        heldDuringWrite = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      }
      return await run(args);
    };
    expect((await openSessions(s.options, s.deps)).exitCode).toBe(0);
    expect(heldDuringWrite).toMatchObject({pid: 4242});
    const dry = setup([cand(1)], {dryRun: true});
    const held = writeLock(dry, NOW);
    expect((await openSessions(dry.options, dry.deps)).exitCode).toBe(0);
    expect(existsSync(held)).toBe(true);
  });

  test('a session the inbox lists twice is planned once', async () => {
    const s = setup([cand(1), cand(1, {lastActivityAt: ago(5 * HOUR)})]);
    const result = await openSessions(s.options, s.deps);
    expect(planned(result.record)).toEqual([sid(1)]);
    expect(
      s.cmux.writes().filter((args) => commandOf(args) === 'new-workspace'),
    ).toHaveLength(1);
    expect(result.record?.skipped[0]?.reason).toContain('lists it twice');
  });

  test('a session that became live after the plan is not opened; ps unreadable stops the run', async () => {
    const s = setup([cand(1), cand(2), cand(3)]);
    s.deps.lateLive = (id) =>
      Promise.resolve(
        id === sid(2) ? {kind: 'live', pid: 77} : {kind: 'notLive'},
      );
    const result = await openSessions(s.options, s.deps);
    expect(result.exitCode).toBe(0);
    const opened = s.cmux
      .writes()
      .filter((args) => commandOf(args) === 'new-workspace')
      .map((args) => args[args.indexOf('--command') + 1]);
    expect(opened).toEqual([resumeCommand(sid(1)), resumeCommand(sid(3))]);
    expect(result.record?.lateLive).toEqual([
      {name: expect.any(String) as string, pid: 77, sessionId: sid(2)},
    ]);
    expect(result.output).toContain('Started elsewhere while this ran (1)');

    const failing = setup([cand(1), cand(2)]);
    failing.deps.lateLive = (id) =>
      Promise.resolve(
        id === sid(2) ? {kind: 'failed', reason: 'EPERM'} : {kind: 'notLive'},
      );
    const stopped = await openSessions(failing.options, failing.deps);
    expect(stopped.exitCode).toBe(1);
    expect(
      failing.cmux
        .writes()
        .filter((args) => commandOf(args) === 'new-workspace'),
    ).toHaveLength(1);
    expect(stopped.record?.failures.join('\n')).toContain(
      'ps could not be read again',
    );
  });
});

describe('small hardening (home-base-yukaf.14 F22)', () => {
  test('a new-workspace answer that cannot be read still records the workspace the window gained, so --undo can close it', async () => {
    const s = setup([cand(1), cand(2)]);
    const run = s.deps.run;
    if (run == null) throw new Error('no runner');
    s.deps.run = async (args) => {
      const result = await run(args);
      return commandOf(args) === 'new-workspace' && result.kind === 'ok'
        ? {kind: 'ok', stdout: 'Created.\n'}
        : result;
    };
    const result = await openSessions(s.options, s.deps);
    expect(result.exitCode).toBe(1);
    const [window] = result.record?.windows ?? [];
    expect(window?.workspaces).toHaveLength(1);
    expect(window?.workspaces[0]?.sessionId).toBe(sid(1));
    expect(window?.workspaces[0]?.workspaceId).toMatch(/^C\d{7}-/u);
    expect(result.record?.failures[0]).toContain('gained');
    const onDisk = JSON.parse(
      readFileSync(result.recordPath ?? '', 'utf8'),
    ) as OpenRecord;
    expect(onDisk.windows[0]?.workspaces).toHaveLength(1);
  });

  test('a record rewrite uses a per-process temporary name, so another writer’s leftover cannot block it', () => {
    const dir = tempDir();
    const path = join(dir, 'rec.json');
    expect(writeJsonFile(path, {n: 1}, true)).toBeNull();
    // What the old fixed name would have collided with.
    mkdirSync(`${path}.tmp`);
    expect(writeJsonFile(path, {n: 2}, false)).toBeNull();
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({n: 2});
  });
});

describe('--dry-run', () => {
  test('makes no cmux write and writes no record, and prints the plan in house style', async () => {
    const s = setup([cand(1), cand(2, {section: 'working'})], {dryRun: true});
    const result = await openSessions(s.options, s.deps);
    expect(result.exitCode).toBe(0);
    expect(s.cmux.writes()).toEqual([]);
    expect(s.cmux.calls.map(commandOf)).toEqual(['ping']);
    expect(existsSync(opensDir({JUSTIN_THREADS_STATE_DIR: s.stateDir}))).toBe(
      false,
    );
    expect(result.recordPath).toBeNull();
    expect(result.output).toContain('Would open (1)');
    expect(result.output).toContain('Skipped (1)');
    expect(result.output).toContain('Cannot tell (0)');
    expect(result.output).toContain(
      'Workspace:      would open in the new window, position 1',
    );
    expect(result.output).not.toContain(' · ');
  });

  test('--json prints the record', async () => {
    const s = setup([cand(1)], {dryRun: true, json: true});
    const result = await openSessions(s.options, s.deps);
    const parsed = JSON.parse(result.output) as OpenRecord;
    expect(parsed.dryRun).toBe(true);
    expect(parsed.planned[0]?.command).toBe(`claude --resume ${sid(1)}`);
  });
});

describe('live-sessions.ts', () => {
  const claude = '/Users/x/.local/bin/claude';
  const proc = (pid: number, tty: string, args: string): Proc => ({
    command: `${claude} ${args}`.trim(),
    etime: '1:00',
    exePath: claude,
    name: 'claude',
    pid,
    ppid: 1,
    tty,
  });
  const surface = (n: number, tty: string): LiveSurface => ({
    id: `S-${n}`,
    paneRef: `pane:${n}`,
    ref: `surface:${n}`,
    title: null,
    tty,
    type: 'terminal',
    workspaceId: `WS-${n}`,
    workspaceRef: `workspace:${n}`,
    workspaceTitle: null,
  });
  const screenWith = (id: string): string =>
    ['hello', '─'.repeat(20), '❯ ', '─'.repeat(20), `  ⌗ ${id}`].join('\n');

  test('argv ids, live hook-store pids and status-line ids are live; a pane with none is unplaced', () => {
    const joined = joinLiveSessions({
      agents: [],
      procs: [
        proc(1, 'ttys001', `--session-id ${sid(1).toUpperCase()} --settings x`),
        proc(2, 'ttys002', '--settings x'),
        proc(3, 'ttys003', '--settings x'),
        proc(4, 'ttys004', '--settings x'),
        proc(5, 'ttys005', 'agents --cwd .'),
        proc(6, '??', '-p hello'),
      ],
      screens: new Map([
        ['surface:3', {kind: 'read', text: screenWith(sid(3))}],
        ['surface:4', {kind: 'unreadable', reason: 'timed out'}],
      ]),
      store: {sessions: {[sid(2)]: {pid: 2}, [sid(7)]: {pid: 77}}},
      surfaces: [
        surface(1, 'ttys001'),
        surface(2, 'ttys002'),
        surface(3, 'ttys003'),
        surface(4, 'ttys004'),
        surface(5, 'ttys005'),
      ],
    });
    expect([...joined.bySessionId.keys()].sort()).toEqual([
      sid(1),
      sid(2),
      sid(3),
    ]);
    expect(joined.bySessionId.get(sid(1))).toEqual({
      pid: 1,
      source: 'ps',
      surfaceId: 'S-1',
      workspaceId: 'WS-1',
    });
    expect(joined.bySessionId.get(sid(3))?.source).toBe('screen');
    // pid 77 is gone, so the stored sid(7) is not live; `claude agents` is no session.
    expect(
      joined.unplaced.map((entry) => [
        entry.kind,
        entry.surfaceRef ?? entry.pid,
      ]),
    ).toEqual([
      ['process', 6],
      ['pane', 'surface:4'],
    ]);
    expect(joined.unplaced[1]?.detail).toContain('could not be read');
  });

  // home-base-yukaf.14 F22.
  test('a tty two surfaces report places its process on neither: unplaced, or live with no surface', () => {
    const joined = joinLiveSessions({
      agents: [],
      procs: [
        proc(1, 'ttys009', '--settings x'),
        proc(2, 'ttys010', `--resume ${sid(2)}`),
      ],
      screens: new Map(),
      store: {sessions: {}},
      surfaces: [
        surface(1, 'ttys009'),
        surface(2, 'ttys009'),
        surface(3, 'ttys010'),
        surface(4, 'ttys010'),
      ],
    });
    expect(joined.unplaced.map((entry) => [entry.kind, entry.pid])).toEqual([
      ['pane', 1],
    ]);
    expect(joined.unplaced[0]?.detail).toContain('2 cmux surfaces report');
    expect(joined.bySessionId.get(sid(2))).toEqual({
      pid: 2,
      source: 'ps',
      surfaceId: null,
      workspaceId: null,
    });
  });

  test('argvSessionId reads --resume, -r and --session-id; isSessionProc drops daemon and agents', () => {
    expect(argvSessionId(`claude --resume=${sid(1)}`)).toBe(sid(1));
    expect(argvSessionId(`claude -r ${sid(2)} --x`)).toBe(sid(2));
    expect(argvSessionId('claude --settings x')).toBeNull();
    expect(isSessionProc(proc(1, 'ttys001', 'daemon run --json-path x'))).toBe(
      false,
    );
    expect(isSessionProc(proc(1, 'ttys001', '/conductor go'))).toBe(true);
  });

  const agentsOk =
    (entries: unknown[] = []) =>
    () =>
      Promise.resolve({kind: 'ok' as const, stdout: JSON.stringify(entries)});

  test('an unreadable hook store, ps or tree fails the whole read (never an empty map)', async () => {
    const dir = tempDir();
    const store = join(dir, 'store.json');
    writeFileSync(store, JSON.stringify({sessions: {}}));
    const tree = (): Promise<CmuxCall> =>
      Promise.resolve({kind: 'ok', stdout: JSON.stringify({windows: []})});
    const ps = () =>
      Promise.resolve({
        kind: 'ok' as const,
        stdout: 'PID PPID TT ELAPSED COMMAND\n',
      });
    const agents = agentsOk();
    const ok = await readLiveSessions({
      agents,
      cmux: tree,
      hookStorePath: store,
      ps,
    });
    expect(ok.kind).toBe('read');
    const noStore = await readLiveSessions({
      agents,
      cmux: tree,
      hookStorePath: join(dir, 'none.json'),
      ps,
    });
    expect(noStore.kind).toBe('failed');
    const noPs = await readLiveSessions({
      agents,
      cmux: tree,
      hookStorePath: store,
      ps: () => Promise.resolve({kind: 'failed', reason: 'EPERM'}),
    });
    expect(noPs.kind).toBe('failed');
    const noTree = await readLiveSessions({
      agents,
      cmux: () => Promise.resolve({kind: 'failed', reason: 'no socket'}),
      hookStorePath: store,
      ps,
    });
    expect(noTree.kind).toBe('failed');
  });

  describe('background sessions (claude --bg, home-base-yukaf.14 F17)', () => {
    // The process lines measured 2026-10-18 (ps -Ao pid,ppid,tty,etime,command),
    // sockets shortened: a claimed worker under an orphaned host, holding
    // ttys082, and the daemon's unclaimed spare with no terminal.
    const PS_LINES = [
      'PID PPID TT ELAPSED COMMAND',
      '19327 1 ?? 01-20:15:07 /Users/x/.local/bin/claude daemon run --json-path /Users/x/.claude/daemon.json',
      '27168 1 ?? 08-21:10:35 claude bg-pty-host --bg-pty-host /tmp/cc/spare/df.pty.sock 200 50 -- /Users/x/.local/share/claude/versions/2.1.296 --bg-spare /tmp/cc/spare/df.claim.sock',
      '27202 27168 ttys082 08-21:10:35 claude bg-spare --bg-spare /tmp/cc/spare/df.claim.sock',
      '57709 19327 ?? 01:20:16 claude bg-pty-host --bg-pty-host /tmp/cc/spare/a5.pty.sock 200 50 -- /Users/x/.local/share/claude/versions/2.1.302 --bg-spare /tmp/cc/spare/a5.claim.sock',
      '57718 57709 ?? 01:20:16 claude bg-spare --bg-spare /tmp/cc/spare/a5.claim.sock',
      '700 1 ?? 1:00 /Applications/Claude.app/Contents/MacOS/Claude',
    ];
    const psOf = (lines: string[]) => () =>
      Promise.resolve({kind: 'ok' as const, stdout: `${lines.join('\n')}\n`});
    const emptyTree = (): Promise<CmuxCall> =>
      Promise.resolve({kind: 'ok', stdout: JSON.stringify({windows: []})});
    const storeFile = (): string => {
      const path = join(tempDir(), 'store.json');
      writeFileSync(path, JSON.stringify({sessions: {}}));
      return path;
    };
    // `claude agents --json` as measured: background entries with pid null are
    // not running; the claimed worker is listed by its bg-spare pid.
    const AGENTS = [
      {kind: 'background', pid: null, sessionId: sid(8), state: 'blocked'},
      {kind: 'background', pid: 27202, sessionId: sid(1), state: 'done'},
      {kind: 'interactive', pid: 4641, sessionId: sid(9), status: 'idle'},
    ];

    test('a background worker the registry names holds its session: thread open skips it as live, and the unclaimed spare is ignored', async () => {
      const live = await readLiveSessions({
        agents: agentsOk(AGENTS),
        cmux: emptyTree,
        hookStorePath: storeFile(),
        ps: psOf(PS_LINES),
      });
      expect(live.kind).toBe('read');
      if (live.kind !== 'read') return;
      expect(live.bySessionId.get(sid(1))).toEqual({
        pid: 27202,
        source: 'agents',
        surfaceId: null,
        workspaceId: null,
      });
      // pid null (sid 8) and a pid no claude holds (sid 9) are not live.
      expect([...live.bySessionId.keys()]).toEqual([sid(1)]);
      // The unclaimed spare 57718, the hosts, the daemon and the desktop app: nothing unplaced.
      expect(live.unplaced).toEqual([]);

      const s = setup([cand(1), cand(2)], {}, live);
      const result = await openSessions(s.options, s.deps);
      expect(result.exitCode).toBe(0);
      expect(planned(result.record)).toEqual([sid(2)]);
      expect(
        result.record?.alreadyOpen.map((entry) => entry.sessionId),
      ).toEqual([sid(1)]);
    });

    test('a worker holding a terminal that the registry does not list is unplaced, so thread open refuses', async () => {
      const live = await readLiveSessions({
        agents: agentsOk([]),
        cmux: emptyTree,
        hookStorePath: storeFile(),
        ps: psOf(PS_LINES),
      });
      expect(live.kind).toBe('read');
      if (live.kind !== 'read') return;
      expect(live.unplaced.map((entry) => [entry.kind, entry.pid])).toEqual([
        ['background', 27202],
      ]);
      expect(live.unplaced[0]?.tty).toBe('ttys082');
      const s = setup([cand(1)], {}, live);
      const result = await openSessions(s.options, s.deps);
      expect(result.exitCode).toBe(2);
      expect(s.cmux.writes()).toEqual([]);
      expect(result.output).toContain('Background session process 27202');
    });

    test('an unreadable or malformed agents registry fails the read, so thread open exits 2 and writes nothing', async () => {
      for (const agents of [
        () => Promise.resolve({kind: 'failed' as const, reason: 'ENOENT'}),
        () => Promise.resolve({kind: 'ok' as const, stdout: 'not json'}),
        () =>
          Promise.resolve({kind: 'ok' as const, stdout: '{"sessions": []}'}),
      ]) {
        const live = await readLiveSessions({
          agents,
          cmux: emptyTree,
          hookStorePath: storeFile(),
          ps: psOf(PS_LINES),
        });
        expect(live.kind).toBe('failed');
        if (live.kind === 'failed') {
          expect(live.reason).toContain('claude agents --json');
        }
        const s = setup([cand(1)], {}, live);
        const result = await openSessions(s.options, s.deps);
        expect(result.exitCode).toBe(2);
        expect(s.cmux.writes()).toEqual([]);
      }
    });

    test('a claude process at any path, a bare argv0 included, is a session process; bg workers and the desktop app are not', () => {
      const procs = PS_LINES.slice(1).map((line) => {
        const [pid, ppid, tty, etime, ...rest] = line.split(' ');
        const command = rest.join(' ');
        const exePath = command.split(' ')[0] ?? '';
        return {
          command,
          etime: etime ?? '',
          exePath,
          name: exePath.split('/').pop() ?? '',
          pid: Number(pid),
          ppid: Number(ppid),
          tty: tty ?? '',
        };
      });
      expect(procs.filter((p) => isSessionProc(p)).map((p) => p.pid)).toEqual(
        [],
      );
      const bare: Proc = {
        command: `claude --resume ${sid(3)}`,
        etime: '1:00',
        exePath: 'claude',
        name: 'claude',
        pid: 5,
        ppid: 1,
        tty: 'ttys005',
      };
      expect(isSessionProc(bare)).toBe(true);
      const elsewhere = {
        ...bare,
        command: '/opt/homebrew/bin/claude --settings x',
        exePath: '/opt/homebrew/bin/claude',
      };
      expect(isSessionProc(elsewhere)).toBe(true);
      // A bare-argv0 session with its id on the command line is live via ps.
      const joined = joinLiveSessions({
        agents: [],
        procs: [bare],
        screens: new Map(),
        store: {sessions: {}},
        surfaces: [],
      });
      expect(joined.bySessionId.get(sid(3))?.source).toBe('ps');
    });
  });
});

describe('filters (home-base-yukaf.22)', () => {
  test('parseSince takes h, d and w, and refuses every other shape', () => {
    expect(parseSince('24h')).toMatchObject({
      kind: 'ok',
      ms: 24 * HOUR,
      words: '24 hours',
    });
    expect(parseSince('3d')).toMatchObject({kind: 'ok', ms: 3 * DAY});
    expect(parseSince(' 2W ')).toMatchObject({
      kind: 'ok',
      ms: 14 * DAY,
      text: '2w',
    });
    expect(parseSince('1d')).toMatchObject({words: '1 day'});
    for (const bad of ['7', '2m', '0d', '-1d', '1.5d', 'd', '', 'week']) {
      expect(parseSince(bad).kind).toBe('bad');
    }
  });

  test('--since 24h keeps a 20-hour-old session and leaves out a 30-hour-old one', async () => {
    const s = setup(
      [
        cand(20, {lastActivityAt: ago(20 * HOUR)}),
        cand(30, {lastActivityAt: ago(30 * HOUR)}),
      ],
      {dryRun: true, since: '24h'},
    );
    const result = await openSessions(s.options, s.deps);
    expect(result.exitCode).toBe(0);
    expect(planned(result.record)).toEqual([sid(20)]);
    expect(result.record?.hidden.olderThanCutoff).toBe(1);
    expect(result.record?.filters).toMatchObject({
      since: '24h',
      sinceSource: 'since',
    });
  });

  test('a bad --since, or --since with --days, refuses with exit 2 before cmux is touched', async () => {
    const cases: Partial<OpenOptions>[] = [
      {since: '3x'},
      {since: '1.5d'},
      {days: 3, since: '3d'},
    ];
    for (const over of cases) {
      const s = setup([cand(1)], over);
      const result = await openSessions(s.options, s.deps);
      expect(result.exitCode).toBe(2);
      expect(result.output).toContain('--since');
      expect(s.cmux.calls).toEqual([]);
    }
  });

  test('with no flag the window comes from componentConfig.thread.openSince', async () => {
    const s = setup(
      [
        cand(1, {lastActivityAt: ago(2 * DAY)}),
        cand(2, {lastActivityAt: ago(10 * DAY)}),
      ],
      {dryRun: true},
    );
    s.deps.configSince = () => ({problems: [], since: '2w', source: 'config'});
    const result = await openSessions(s.options, s.deps);
    expect(planned(result.record)).toEqual([sid(1), sid(2)]);
    expect(result.record?.filters).toMatchObject({
      since: '2w',
      sinceSource: 'config',
    });
    expect(result.output).toContain(
      '2w (the last 2 weeks; componentConfig.thread.openSince)',
    );
  });

  test('the config knob: default 7d, a user value read, a bad value named and ignored', () => {
    const home = tempDir();
    const configHome = join(home, 'config');
    mkdirSync(join(configHome, 'justin-sdk'), {recursive: true});
    const project = join(home, 'project');
    mkdirSync(project, {recursive: true});
    const env = {HOME: home, XDG_CONFIG_HOME: configHome};
    expect(resolveThreadConfig({cwd: project, env}).openSince).toBe('7d');
    const write = (value: unknown): void => {
      writeFileSync(
        join(configHome, 'justin-sdk', 'config.json'),
        JSON.stringify({componentConfig: {thread: {openSince: value}}}),
      );
    };
    write('24h');
    const read = resolveThreadConfig({cwd: project, env});
    expect(read.openSince).toBe('24h');
    expect(read.openSinceSource).toBe('user');
    write('a fortnight');
    const bad = resolveThreadConfig({cwd: project, env});
    expect(bad.openSince).toBe('7d');
    expect(bad.problems.join('\n')).toContain(
      'componentConfig.thread.openSince in the user config is "a fortnight"',
    );
  });

  test('--repo keeps sessions whose folder name or tag matches, any case; the rest are counted', async () => {
    const s = setup(
      [
        cand(1, {repo: 'home-base', repoTag: 'HB'}),
        cand(2, {repo: 'audio-journal-1', repoTag: 'AJ'}),
        cand(3, {repo: 'life', repoTag: 'LIFE'}),
      ],
      {dryRun: true, repos: ['Home-Base', '[aj]', 'nowhere']},
    );
    const result = await openSessions(s.options, s.deps);
    expect(planned(result.record)).toEqual([sid(1), sid(2)]);
    expect(result.record?.hidden.otherRepo).toBe(1);
    expect(result.record?.unmatchedRepos).toEqual(['nowhere']);
    expect(result.output).toContain(
      '--repo nowhere: no session from the last 7 days is in a repo',
    );
    const byTag = setup([cand(1, {repo: 'home-base', repoTag: 'HB'})], {
      dryRun: true,
      repos: ['hb'],
    });
    expect(
      planned((await openSessions(byTag.options, byTag.deps)).record),
    ).toEqual([sid(1)]);
  });

  test('--repo with --per-project: one window per kept repo', async () => {
    const s = setup(
      [
        cand(1, {repo: 'a', repoTag: null}),
        cand(2, {repo: 'b', repoTag: null}),
        cand(3, {repo: 'c', repoTag: null}),
        cand(4, {repo: 'a', repoTag: null}),
      ],
      {dryRun: true, perProject: true, repos: ['a,b']},
    );
    const result = await openSessions(s.options, s.deps);
    expect(result.record?.windows.map((window) => window.repo)).toEqual([
      'a',
      'b',
    ]);
    expect(result.record?.windows[0]?.sessionIds).toEqual([sid(1), sid(4)]);
  });

  test('--limit 2 opens the two newest; the rest are listed as over the limit', async () => {
    const s = setup([cand(3), cand(1), cand(4), cand(2)], {limit: 2});
    const result = await openSessions(s.options, s.deps);
    expect(result.exitCode).toBe(0);
    expect(planned(result.record)).toEqual([sid(1), sid(2)]);
    expect(result.record?.overLimit.map((entry) => entry.sessionId)).toEqual([
      sid(3),
      sid(4),
    ]);
    expect(
      s.cmux.writes().filter((args) => commandOf(args) === 'new-workspace'),
    ).toHaveLength(2);
    expect(result.output).toContain('Not opened: over the limit (2)');
    expect(result.output).toContain('Pass --limit 4 (or leave --limit off)');
  });

  test('--limit refuses anything but a whole number above 0', async () => {
    for (const limit of [0, -1, 1.5]) {
      const s = setup([cand(1)], {limit});
      const result = await openSessions(s.options, s.deps);
      expect(result.exitCode).toBe(2);
      expect(result.output).toContain('--limit takes a whole number');
    }
  });

  test("G6: --repo passed but naming no repo ('', ',', ' ', or no value) refuses with exit 2 before cmux is touched, --include-open too", async () => {
    for (const repos of [[''], [','], [' '], [], [' , ', '']]) {
      const s = setup([cand(1), cand(2)], {includeOpen: true, repos});
      const result = await openSessions(s.options, s.deps);
      expect(result.exitCode).toBe(2);
      expect(result.output).toContain('--repo was passed but names no repo');
      expect(result.record).toBeNull();
      expect(s.cmux.calls).toEqual([]);
    }
    // Not passed at all still means every repo.
    const all = setup([cand(1)], {dryRun: true});
    expect((await openSessions(all.options, all.deps)).exitCode).toBe(0);
  });

  test('the header names all four filters, one labelled line each, set or not', async () => {
    const plain = setup([cand(1)], {dryRun: true});
    const output = (await openSessions(plain.options, plain.deps)).output;
    for (const line of [
      /^ +Since: +7d \(the last 7 days; the default/mu,
      /^ +Repo: +every repo/mu,
      /^ +Limit: +none/mu,
      /^ +Include open: +off/mu,
    ]) {
      expect(output).toMatch(line);
    }
    const set = setup([cand(1, {repo: 'home-base'})], {
      dryRun: true,
      limit: 3,
      repos: ['home-base'],
      since: '24h',
    });
    const setOutput = (await openSessions(set.options, set.deps)).output;
    expect(setOutput).toMatch(
      /^ +Since: +24h \(the last 24 hours; --since\)$/mu,
    );
    expect(setOutput).toMatch(/^ +Repo: +home-base$/mu);
    expect(setOutput).toMatch(/^ +Limit: +at most 3 sessions, newest first$/mu);
  });
});

describe('--include-open (home-base-yukaf.22 item 4)', () => {
  /** A window Justin already has: workspace LIVE (session 1) and another. */
  const OLD_WINDOW = 'E0000001-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
  const LIVE_WS = 'F0000001-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
  const OTHER_WS = 'F0000002-AAAA-4AAA-8AAA-AAAAAAAAAAAA';

  function withOldWindow(s: Setup): void {
    s.cmux.windows.set(OLD_WINDOW, [
      {id: OTHER_WS, ref: 'workspace:1'},
      {id: LIVE_WS, ref: 'workspace:2'},
    ]);
  }

  const resumed = (s: Setup): string[] =>
    s.cmux
      .writes()
      .filter((args) => commandOf(args) === 'new-workspace')
      .map((args) => args[args.indexOf('--command') + 1] ?? '');

  test('a live session is never resumed a second time, with or without --include-open', async () => {
    for (const includeOpen of [false, true]) {
      const s = setup(
        [cand(1), cand(2)],
        {includeOpen},
        liveRead({[sid(1)]: {source: 'screen', workspaceId: LIVE_WS}}),
      );
      withOldWindow(s);
      const result = await openSessions(s.options, s.deps);
      expect(result.exitCode).toBe(0);
      // The one new workspace resumes session 2; nothing ever resumes 1.
      expect(resumed(s)).toEqual([resumeCommand(sid(2))]);
      expect(resumed(s).some((command) => command.includes(sid(1)))).toBe(
        false,
      );
      const moves = s.cmux
        .writes()
        .filter((args) => commandOf(args) === 'move-workspace-to-window');
      expect(moves.length).toBe(includeOpen ? 1 : 0);
    }
  });

  test('the moved workspace is recorded before the move, stamped after, and ordered newest first', async () => {
    const s = setup(
      [cand(1), cand(2)],
      {includeOpen: true},
      liveRead({[sid(1)]: {pid: 77, source: 'screen', workspaceId: LIVE_WS}}),
    );
    withOldWindow(s);
    const result = await openSessions(s.options, s.deps);
    const windowId = result.record?.windows[0]?.windowId ?? '';
    expect(result.record?.moved).toEqual([
      {
        failure: null,
        fromIndex: 1,
        fromWindowCount: 2,
        fromWindowId: OLD_WINDOW,
        fromWindowRef: 'window:E0',
        movedAt: expect.any(String) as string,
        name: '[A] session 1',
        sessionId: sid(1),
        toWindowId: windowId,
        workspaceId: LIVE_WS,
      },
    ]);
    // On disk at the moment of the move: the entry, not yet stamped.
    expect(s.cmux.movedOnDiskAtMove).toEqual([
      [expect.objectContaining({movedAt: null, workspaceId: LIVE_WS})],
    ]);
    const reorder = s.cmux
      .writes()
      .find((args) => commandOf(args) === 'reorder-workspaces');
    const opened = result.record?.windows[0]?.workspaces[0]?.workspaceId;
    // Session 1 is newer than 2, so the moved workspace is on top.
    expect(reorder?.[reorder.indexOf('--order') + 1]).toBe(
      `${LIVE_WS},${opened}`,
    );
    expect(s.cmux.windows.get(windowId)?.map((entry) => entry.id)).toContain(
      LIVE_WS,
    );
    expect(result.output).toContain('Moved (1)');
  });

  test('without --include-open the section names the flag; with it, a dry run lists "Would move" with the source window', async () => {
    const live = liveRead({[sid(1)]: {source: 'screen', workspaceId: LIVE_WS}});
    const off = setup([cand(1), cand(2)], {dryRun: true}, live);
    withOldWindow(off);
    const offOut = (await openSessions(off.options, off.deps)).output;
    expect(offOut).toContain(
      'Already open elsewhere (1) — pass --include-open to move them into this window',
    );
    expect(offOut).toContain(`cmux select-workspace --workspace ${LIVE_WS}`);
    const on = setup(
      [cand(1), cand(2)],
      {dryRun: true, includeOpen: true},
      live,
    );
    withOldWindow(on);
    const result = await openSessions(on.options, on.deps);
    expect(result.output).toContain('Would move (1)');
    expect(result.output).toMatch(
      new RegExp(`From: +window:E0 \\(${OLD_WINDOW}\\), position 2`, 'u'),
    );
    expect(on.cmux.writes()).toEqual([]);
  });

  test('no workspace, or a workspace shared with another session: listed, never moved, never resumed', async () => {
    const s = setup(
      [cand(1), cand(2), cand(3)],
      {includeOpen: true},
      liveRead({
        [sid(1)]: {pid: 9, source: 'agents', workspaceId: null},
        [sid(2)]: {source: 'screen', workspaceId: LIVE_WS},
        [sid(3)]: {source: 'screen', workspaceId: LIVE_WS},
      }),
    );
    withOldWindow(s);
    const result = await openSessions(s.options, s.deps);
    expect(result.exitCode).toBe(0);
    expect(s.cmux.writes()).toEqual([]);
    const why = result.record?.alreadyOpen.map((entry) => entry.notMoved);
    expect(why?.[0]).toContain('outside any cmux workspace (pid 9)');
    expect(why?.[1]).toContain('holds 2 Claude sessions');
    expect(why?.[2]).toContain('holds 2 Claude sessions');
    expect(result.output).toContain('Already open elsewhere, not moved (3)');
  });

  test('an unreadable cmux tree refuses --include-open with exit 2, nothing written', async () => {
    const s = setup([cand(1)], {includeOpen: true});
    s.deps.readTree = () =>
      Promise.resolve({kind: 'unreadable', reason: 'socket closed'});
    const result = await openSessions(s.options, s.deps);
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('--include-open needs the cmux tree');
    expect(s.cmux.writes()).toEqual([]);
  });

  test('--limit counts moved sessions too', async () => {
    const s = setup(
      [cand(1), cand(2), cand(3)],
      {dryRun: true, includeOpen: true, limit: 2},
      liveRead({[sid(1)]: {source: 'screen', workspaceId: LIVE_WS}}),
    );
    withOldWindow(s);
    const result = await openSessions(s.options, s.deps);
    expect(result.record?.toMove.map((entry) => entry.sessionId)).toEqual([
      sid(1),
    ]);
    expect(planned(result.record)).toEqual([sid(2)]);
    expect(result.record?.overLimit.map((entry) => entry.sessionId)).toEqual([
      sid(3),
    ]);
  });

  test('G10: a move-workspace-to-window that fails after cmux moved it keeps the record entry (failure set, movedAt null) for --undo, and claims nothing about where it is', async () => {
    const s = setup(
      [cand(1), cand(2)],
      {includeOpen: true},
      liveRead({[sid(1)]: {source: 'screen', workspaceId: LIVE_WS}}),
    );
    withOldWindow(s);
    // The move happens, then cmux answers with a timeout.
    s.deps.run = async (args) => {
      const call = await s.cmux.run(args);
      return commandOf(args) === 'move-workspace-to-window'
        ? {kind: 'failed', reason: 'timed out after 4000 ms'}
        : call;
    };
    const result = await openSessions(s.options, s.deps);
    expect(result.exitCode).toBe(1);
    const windowId = result.record?.windows[0]?.windowId ?? '';
    expect(s.cmux.windows.get(windowId)?.map((entry) => entry.id)).toContain(
      LIVE_WS,
    );
    expect(result.record?.moved).toEqual([
      expect.objectContaining({
        failure: 'timed out after 4000 ms',
        fromWindowId: OLD_WINDOW,
        movedAt: null,
        toWindowId: windowId,
        workspaceId: LIVE_WS,
      }),
    ]);
    expect(result.output).toContain(
      'if cmux moved it anyway, thread open --undo moves it back to window:E0',
    );
    expect(result.output).not.toContain('so it stays in');
  });

  test("G2: the workspace this command runs in (CMUX_WORKSPACE_ID) is never moved, and is listed as this command's own pane", async () => {
    const s = setup(
      [cand(1), cand(2)],
      {includeOpen: true},
      liveRead({[sid(1)]: {source: 'screen', workspaceId: LIVE_WS}}),
    );
    withOldWindow(s);
    // Any case: cmux prints uuids in capitals, the env may not.
    s.options.env = {
      ...s.options.env,
      CMUX_WORKSPACE_ID: LIVE_WS.toLowerCase(),
    };
    const result = await openSessions(s.options, s.deps);
    expect(result.exitCode).toBe(0);
    const moves = s.cmux
      .writes()
      .filter((args) => commandOf(args) === 'move-workspace-to-window');
    expect(moves).toEqual([]);
    expect(result.record?.toMove).toEqual([]);
    expect(result.record?.alreadyOpen[0]?.notMoved).toBe(OWN_PANE_REASON);
    expect(result.output).toContain("not moved: this command's own pane");
    // Never resumed either (D-UNFINISHED).
    expect(resumed(s)).toEqual([resumeCommand(sid(2))]);
  });

  test('G2 decision: a workspace whose other panes are shell splits MOVES with them, said as "moved with its N other panes"; another Claude session still refuses', async () => {
    const s = setup(
      [cand(1), cand(2)],
      {dryRun: true, includeOpen: true},
      liveRead({[sid(1)]: {source: 'screen', workspaceId: LIVE_WS}}),
    );
    s.cmux.windows.set(OLD_WINDOW, [
      {id: OTHER_WS, ref: 'workspace:1'},
      {id: LIVE_WS, ref: 'workspace:2', surfaces: ['S1', 'S2', 'S3']},
    ]);
    const result = await openSessions(s.options, s.deps);
    expect(result.record?.toMove).toEqual([
      expect.objectContaining({otherPanes: 2, workspaceId: LIVE_WS}),
    ]);
    expect(result.record?.alreadyOpen).toEqual([]);
    expect(result.output).toContain('Would move (1)');
    expect(result.output).toContain('moved with its 2 other panes');

    // A second Claude session in the same workspace is still a refusal.
    const shared = setup(
      [cand(1), cand(2)],
      {dryRun: true, includeOpen: true},
      liveRead({
        [sid(1)]: {source: 'screen', workspaceId: LIVE_WS},
        [sid(9)]: {source: 'screen', workspaceId: LIVE_WS},
      }),
    );
    shared.cmux.windows.set(OLD_WINDOW, [
      {id: LIVE_WS, ref: 'workspace:2', surfaces: ['S1', 'S2']},
    ]);
    const refused = await openSessions(shared.options, shared.deps);
    expect(refused.record?.toMove).toEqual([]);
    expect(refused.record?.alreadyOpen[0]?.notMoved).toContain(
      'holds 2 Claude sessions',
    );
  });

  test("G3: moving a window's last workspace out says its window keeps a blank workspace; a window that keeps others says nothing", async () => {
    const SOLO_WINDOW = 'E0000002-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
    const SOLO_WS = 'F0000003-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
    const s = setup(
      [cand(1), cand(2), cand(3)],
      {dryRun: true, includeOpen: true},
      liveRead({
        [sid(1)]: {source: 'screen', workspaceId: LIVE_WS},
        [sid(2)]: {source: 'screen', workspaceId: SOLO_WS},
      }),
    );
    withOldWindow(s);
    s.cmux.windows.set(SOLO_WINDOW, [{id: SOLO_WS, ref: 'workspace:3'}]);
    const result = await openSessions(s.options, s.deps);
    const byId = new Map(
      (result.record?.toMove ?? []).map((move) => [move.sessionId, move]),
    );
    expect(byId.get(sid(1))).toMatchObject({
      fromWindowCount: 2,
      leavesBlank: false,
    });
    expect(byId.get(sid(2))).toMatchObject({
      fromWindowCount: 1,
      leavesBlank: true,
    });
    const blankLines = result.output
      .split('\n')
      .filter((line) => line.includes('its window keeps a blank workspace'));
    expect(blankLines).toHaveLength(1);
    expect(blankLines[0]).toContain('window:E0');
  });
});

describe('project colours (home-base-yukaf.22 item 5)', () => {
  /** A colours.json fixture in a temp XDG_CONFIG_HOME; null writes none. */
  function withColors(s: Setup, content: string | null): void {
    const configHome = join(tempDir(), 'config');
    if (content != null) {
      mkdirSync(join(configHome, 'cmux-arrange'), {recursive: true});
      writeFileSync(join(configHome, 'cmux-arrange', 'colors.json'), content);
    }
    s.options.env = {...s.options.env, XDG_CONFIG_HOME: configHome};
  }

  const colorCalls = (s: Setup): string[][] =>
    s.cmux.writes().filter((args) => commandOf(args) === 'workspace-action');

  const sessions = (): OpenCandidate[] => [
    cand(1, {repo: 'repo-a'}),
    cand(2, {repo: 'repo-b'}),
    cand(3, {repo: 'repo-c'}),
  ];

  test('overrides, then assigned, set after the record exists; a project with no colour says so in one line', async () => {
    const s = setup(sessions());
    withColors(
      s,
      JSON.stringify({
        assigned: {'repo-a': 'Red', 'repo-b': 'navy'},
        exclude: ['Olive'],
        overrides: {'repo-a': 'Teal'},
      }),
    );
    const result = await openSessions(s.options, s.deps);
    expect(result.exitCode).toBe(0);
    const opened = result.record?.windows[0]?.workspaces ?? [];
    expect(colorCalls(s)).toEqual([
      [
        'workspace-action',
        '--action',
        'set-color',
        '--workspace',
        opened[0]?.workspaceId ?? '',
        '--color',
        'Teal',
      ],
      [
        'workspace-action',
        '--action',
        'set-color',
        '--workspace',
        opened[1]?.workspaceId ?? '',
        '--color',
        'Navy',
      ],
    ]);
    // Colour comes after the window is built, so after the record exists.
    const writes = s.cmux.writes().map(commandOf);
    const firstColor = writes.indexOf('workspace-action');
    expect(
      writes.slice(firstColor).every((c) => c === 'workspace-action'),
    ).toBe(true);
    expect(s.cmux.recordSeenAtWrite.every(Boolean)).toBe(true);
    expect(result.record?.colors.noColor).toEqual(['repo-c']);
    expect(result.output).toContain('repo-c has no colour in');
  });

  test('no colour file (G1): the built-in project colours, home-base navy; a project without one says so; the run succeeds', async () => {
    const s = setup([cand(1, {repo: 'home-base'}), cand(2, {repo: 'repo-x'})]);
    withColors(s, null);
    const result = await openSessions(s.options, s.deps);
    expect(result.exitCode).toBe(0);
    const opened = result.record?.windows[0]?.workspaces ?? [];
    expect(colorCalls(s)).toEqual([
      [
        'workspace-action',
        '--action',
        'set-color',
        '--workspace',
        opened[0]?.workspaceId ?? '',
        '--color',
        'Navy',
      ],
    ]);
    expect(result.record?.colors.state).toBe('absent');
    expect(result.output).toMatch(
      /Using the built-in project colours \(no .*colors\.json\)\./u,
    );
    expect(result.output).toContain(
      'Coloured 1 workspace from the built-in project colours:',
    );
    expect(result.output).toContain(
      'repo-x has no built-in project colour, so its workspaces are not coloured.',
    );
  });

  test('G1: overrides and assigned beat the built-in colour; exclude drops a built-in colour; one table with cmux-arrange', async () => {
    const s = setup([
      cand(1, {repo: 'home-base'}),
      cand(2, {repo: 'prompts'}),
      cand(3, {repo: 'life'}),
    ]);
    withColors(
      s,
      JSON.stringify({
        assigned: {prompts: 'Rose'},
        // Green is life's built-in colour, given as its hex.
        exclude: ['#196F3D'],
        overrides: {'home-base': 'Teal'},
      }),
    );
    const result = await openSessions(s.options, s.deps);
    expect(result.exitCode).toBe(0);
    expect(colorCalls(s).map((args) => args.at(-1))).toEqual(['Teal', 'Rose']);
    expect(result.record?.colors.noColor).toEqual(['life']);
    // scripts/cmux-arrange-colors.test.ts checks that cmux-arrange reads this same table.
    expect(DEFAULT_PROJECT_COLORS['home-base']).toBe('Navy');
  });

  test('G7: a workspace moved in with --include-open is never recoloured, and the run says so in one line', async () => {
    const OLD_WINDOW = 'E0000001-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
    const LIVE_WS = 'F0000001-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
    const s = setup(
      [cand(1, {repo: 'home-base'}), cand(2, {repo: 'home-base'})],
      {includeOpen: true},
      liveRead({[sid(1)]: {source: 'screen', workspaceId: LIVE_WS}}),
    );
    s.cmux.windows.set(OLD_WINDOW, [
      {id: 'F0000002-AAAA-4AAA-8AAA-AAAAAAAAAAAA', ref: 'workspace:1'},
      {id: LIVE_WS, ref: 'workspace:2'},
    ]);
    withColors(s, null);
    const result = await openSessions(s.options, s.deps);
    expect(result.exitCode).toBe(0);
    expect(result.record?.moved.map((entry) => entry.workspaceId)).toEqual([
      LIVE_WS,
    ]);
    const coloured = colorCalls(s).map(
      (args) => args[args.indexOf('--workspace') + 1],
    );
    expect(coloured).toEqual([
      result.record?.windows[0]?.workspaces[0]?.workspaceId ?? 'none opened',
    ]);
    expect(coloured).not.toContain(LIVE_WS);
    expect(result.output).toContain(
      'Moved workspaces keep the colour they had: --undo moves them back but cannot restore a colour (1 workspace).',
    );
  });

  test('an invalid colour file is a different line from an absent one, and the run still succeeds', async () => {
    const s = setup(sessions());
    withColors(s, JSON.stringify({overrides: {'repo-a': 'Ultraviolet'}}));
    const result = await openSessions(s.options, s.deps);
    expect(result.exitCode).toBe(0);
    expect(colorCalls(s)).toEqual([]);
    expect(result.record?.colors.state).toBe('failed');
    expect(result.output).toContain('could not be used');
    expect(result.output).toContain('overrides.repo-a: "Ultraviolet"');
  });

  test('--no-color colours nothing; a failed set-color is reported and never fatal', async () => {
    const off = setup(sessions(), {color: false});
    withColors(off, JSON.stringify({overrides: {'repo-a': 'Teal'}}));
    const offResult = await openSessions(off.options, off.deps);
    expect(colorCalls(off)).toEqual([]);
    expect(offResult.output).toContain('Off (--no-color)');

    const s = setup(sessions());
    s.deps.run = fakeCmux(s.stateDir, {
      'workspace-action': 'invalid_params',
    }).run;
    withColors(s, JSON.stringify({overrides: {'repo-a': 'Teal'}}));
    const result = await openSessions(s.options, s.deps);
    expect(result.exitCode).toBe(0);
    expect(result.record?.colors.failed[0]?.reason).toBe('invalid_params');
    expect(result.output).toContain(
      'Setting the colour of "[A] session 1" failed',
    );
  });

  test('--list (item 6): every recorded run, newest first, with its filters, counts, undo state and command; a bad record is listed, not skipped', async () => {
    const s = setup([cand(1, {repo: 'home-base'}), cand(2)], {
      argv: ['--repo', 'home-base'],
      repos: ['home-base'],
      since: '3d',
    });
    const first = await openSessions(s.options, s.deps);
    expect(first.exitCode).toBe(0);
    const env = {JUSTIN_THREADS_STATE_DIR: s.stateDir};
    const dir = opensDir(env);
    // An older run, already undone, and a record that is not JSON.
    writeFileSync(
      join(dir, '2026-10-01T09-00-00.000Z.json'),
      JSON.stringify({
        at: '2026-10-01T09:00:00.000Z',
        cutoffDays: 7,
        undo: {
          closed: [{}, {}],
          finishedAt: '2026-10-01T10:00:00.000Z',
          kept: [{}],
          startedAt: '2026-10-01T09:59:00.000Z',
        },
        windows: [{workspaces: [{workspaceId: 'X'}, {workspaceId: 'Y'}]}],
      }),
    );
    writeFileSync(join(dir, '2026-09-01T09-00-00.000Z.json'), '{not json');
    const read = readRuns(env, NOW);
    expect(read.kind).toBe('read');
    if (read.kind !== 'read') return;
    expect(read.runs.map((run) => run.stamp)).toEqual([
      '2026-10-18T12-00-00.000Z',
      '2026-10-01T09-00-00.000Z',
      '2026-09-01T09-00-00.000Z',
    ]);
    expect(read.runs[0]).toMatchObject({moved: 0, opened: 1, windows: 1});
    expect(read.runs[0]?.undo).toContain('no');
    expect(read.runs[1]?.undo).toContain('yes');
    expect(read.runs[1]?.undo).toContain('closed 2, kept 1');
    expect(read.runs[2]?.readFailure).not.toBeNull();
    const text = renderRuns(read, NOW, PLAIN_STYLE);
    expect(text).toContain('thread open runs (3)');
    expect(text).toMatch(/^ +Since: +3d \(the last 3 days\)$/mu);
    expect(text).toMatch(/^ +Repo: +home-base$/mu);
    expect(text).toContain('thread open --undo --run 2026-10-18T12-00-00.000Z');
    expect(text).toContain('7 days (recorded before the other filters were)');
    expect(text).toContain('could not be read');
    expect(text).not.toContain(' · ');
    // No run at all is its own answer, naming the directory.
    const none = readRuns(
      {JUSTIN_THREADS_STATE_DIR: join(tempDir(), 'x')},
      NOW,
    );
    expect(none.kind).toBe('none');
    expect(renderRuns(none, NOW, PLAIN_STYLE)).toContain(
      'No run of thread open is recorded',
    );
  });

  test('a dry run says what it would colour and sets nothing', async () => {
    const s = setup(sessions(), {dryRun: true});
    withColors(s, JSON.stringify({overrides: {'repo-b': 'Purple'}}));
    const result = await openSessions(s.options, s.deps);
    expect(s.cmux.writes()).toEqual([]);
    expect(result.output).toContain('Would colour 1 workspace from');
    expect(result.output).toContain('[A] session 2: Purple');
  });
});
