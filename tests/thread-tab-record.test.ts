/**
 * home-base-kwand.1: the tab record and `thread tabs before-restart`.
 *
 * Every fixture here is SYNTHETIC: made-up titles, paths and ids in cmux's
 * shape (measured 2026-11-17, epic home-base-kwand D1). No real tab title,
 * directory or session id from Justin's machine is in this file.
 */

import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {
  LIVE_SESSION_FILE,
  PREVIOUS_SESSION_FILE,
  readTabSet,
  SESSION_HISTORY_DIR,
} from '../src/thread/cmux-session-file';
import {
  dayFileName,
  LAUNCHES_FILE,
  readJsonl,
  recordTabs,
  RETENTION_DAYS,
} from '../src/thread/tab-record';
import {
  beforeRestart,
  parseBootTime,
  parseCmuxStart,
  runThreadTabsRecord,
  type TimeRead,
} from '../src/thread/tab-record-command';

const PRIVATE = 'PRIVATE-NOTIFICATION-TEXT-7f3a';
const HOUR = 60 * 60 * 1000;

interface FixtureTab {
  id: string;
  sessionId?: string | null;
  title: string;
}

/** A cmux-shaped session file, with the private fields cmux writes too. */
function cmuxFile(
  createdAtMs: number,
  workspaces: {id: string; tabs: FixtureTab[]; title: string}[][],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    createdAt: createdAtMs / 1000,
    version: 1,
    windows: workspaces.map((window) => ({
      frame: {height: 1, width: 1, x: 0, y: 0},
      tabManager: {
        workspaces: window.map((ws) => ({
          currentDirectory: '/synthetic/project',
          customTitle: ws.title,
          logEntries: [{message: PRIVATE}],
          notifications: [{body: PRIVATE, title: PRIVATE}],
          panels: ws.tabs.map((tab) => ({
            directory: '/synthetic/project',
            gitBranch: {branch: 'main', isDirty: false},
            id: tab.id,
            listeningPorts: [],
            notifications: [{body: PRIVATE, subtitle: PRIVATE, title: PRIVATE}],
            stableSurfaceId: `stable-${tab.id}`,
            terminal: {
              agent:
                tab.sessionId === undefined
                  ? undefined
                  : {
                      kind: 'claude',
                      launchCommand: {environment: {SECRET: PRIVATE}},
                      sessionId: tab.sessionId,
                      workingDirectory: '/synthetic/project',
                    },
              resumeBinding: {
                autoResume: true,
                command: `claude --resume ${PRIVATE}`,
                environment: {SECRET: PRIVATE},
              },
              scrollback: PRIVATE,
            },
            title: tab.title,
            ttyName: `/dev/ttys0${tab.id.length}`,
            type: 'terminal',
          })),
          processTitle: 'zsh',
          stableId: `stable-${ws.id}`,
          statusEntries: [{text: PRIVATE}],
          workspaceId: ws.id,
        })),
      },
    })),
    ...overrides,
  };
}

const LAYOUT = [
  [
    {
      id: 'ws-alpha',
      tabs: [
        {id: 'tab-a1', sessionId: 'sess-aaaa-1111', title: 'Alpha build'},
        {id: 'tab-a2', title: 'plain shell'},
      ],
      title: 'Alpha',
    },
  ],
  [
    {
      id: 'ws-beta',
      tabs: [{id: 'tab-b1', sessionId: 'sess-bbbb-2222', title: 'Beta fix'}],
      title: 'Beta',
    },
  ],
];

/** LAYOUT after a failed restore: tab-a1 is there, its session id is gone. */
const LAYOUT_DEGRADED = [
  [
    {
      id: 'ws-alpha',
      tabs: [
        {id: 'tab-a1', title: 'zsh'},
        {id: 'tab-a2', title: 'plain shell'},
      ],
      title: 'Alpha',
    },
  ],
  [
    {
      id: 'ws-beta',
      tabs: [{id: 'tab-b1', sessionId: 'sess-bbbb-2222', title: 'Beta fix'}],
      title: 'Beta',
    },
  ],
];

let root: string;
let support: string;
let store: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tab-record-'));
  support = join(root, 'cmux');
  store = join(root, 'state', 'tab-records');
  mkdirSync(support, {recursive: true});
});

afterEach(() => {
  rmSync(root, {force: true, recursive: true});
});

function writeLive(file: Record<string, unknown>): void {
  writeFileSync(join(support, LIVE_SESSION_FILE), JSON.stringify(file));
}

function writePrevious(file: Record<string, unknown>): void {
  writeFileSync(join(support, PREVIOUS_SESSION_FILE), JSON.stringify(file));
}

function writeHistory(file: Record<string, unknown>, epochMs: number): string {
  mkdirSync(join(support, SESSION_HISTORY_DIR), {recursive: true});
  const name = `session-com.cmuxterm.app-${epochMs}-w2-p3.json`;
  writeFileSync(join(support, SESSION_HISTORY_DIR, name), JSON.stringify(file));
  return name;
}

function record(now: number) {
  return recordTabs({now, storeDir: store, supportDir: support});
}

function storeText(): string {
  if (!existsSync(store)) return '';
  return readdirSync(store)
    .map((name) => readFileSync(join(store, name), 'utf8'))
    .join('');
}

const ok = (ms: number): TimeRead => ({ms, ok: true});
const no = (reason: string): TimeRead => ({ok: false, reason});

// A fixed local day, mid-afternoon, so day files do not straddle midnight.
const T0 = new Date(2031, 2, 10, 14, 0, 0).getTime();

describe('reading cmux session files (strict projection)', () => {
  test('an unknown version is a failure naming the file and the key, never an empty tab list', () => {
    writeLive(cmuxFile(T0, LAYOUT, {version: 2}));
    const read = readTabSet(join(support, LIVE_SESSION_FILE));
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.key).toBe('version');
    expect(read.file).toBe(join(support, LIVE_SESSION_FILE));
    expect(read.reason).toContain('version');
  });

  test('a missing required key names its path', () => {
    const file = cmuxFile(T0, LAYOUT);
    const windows = file.windows as {
      tabManager: {workspaces: Record<string, unknown>[]};
    }[];
    delete windows[1]?.tabManager.workspaces[0]?.workspaceId;
    writeLive(file);
    const read = readTabSet(join(support, LIVE_SESSION_FILE));
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.key).toBe('windows[1].tabManager.workspaces[0].workspaceId');
  });

  test('a recorder run on an unknown shape appends a failed line and exits 1, with no tab set', () => {
    writeLive(cmuxFile(T0, LAYOUT, {version: 2}));
    const result = record(T0 + HOUR);
    expect(result.exitCode).toBe(1);
    expect(result.live.kind).toBe('failed');
    const lines = readJsonl(join(store, dayFileName(T0 + HOUR))).records;
    expect(lines.map((line) => line.kind)).toEqual(['failed']);
  });

  test('only allow-listed fields reach a record (fixture tabs carry notification text)', () => {
    writeLive(cmuxFile(T0, LAYOUT));
    writePrevious(cmuxFile(T0 - HOUR, LAYOUT));
    expect(record(T0 + HOUR).exitCode).toBe(0);
    const text = storeText();
    expect(text).toContain('Alpha build');
    expect(text).not.toContain(PRIVATE);
    expect(text).not.toContain('stable-');
    const [full] = readJsonl(join(store, dayFileName(T0 + HOUR))).records;
    if (full?.kind !== 'hourly') throw new Error('expected an hourly record');
    const tab = full.windows[0]?.workspaces[0]?.tabs[0];
    expect(Object.keys(tab ?? {}).sort()).toEqual([
      'agentKind',
      'agentWorkingDirectory',
      'autoResume',
      'directory',
      'id',
      'lastKnownSeenAt',
      'lastKnownSessionId',
      'sessionId',
      'title',
      'ttyName',
      'type',
    ]);
    expect(Object.keys(full.windows[0]?.workspaces[0] ?? {}).sort()).toEqual([
      'currentDirectory',
      'tabs',
      'title',
      'workspaceId',
    ]);
  });
});

describe('thread tabs record', () => {
  test('an unchanged tab set appends a small line pointing at the full record', () => {
    writeLive(cmuxFile(T0, LAYOUT));
    expect(record(T0 + HOUR).live.kind).toBe('hourly');
    writeLive(cmuxFile(T0 + HOUR + 5_000, LAYOUT));
    const second = record(T0 + 2 * HOUR);
    expect(second.live.kind).toBe('unchanged');
    const path = join(store, dayFileName(T0 + 2 * HOUR));
    const [full, unchanged] = readJsonl(path).records;
    if (full?.kind !== 'hourly' || unchanged?.kind !== 'unchanged') {
      throw new Error('expected hourly then unchanged');
    }
    expect(unchanged.sameAs).toBe(full.id);
    expect(unchanged.fileCreatedAt).toBe(T0 + HOUR + 5_000);
    const [fullLine, smallLine] = readFileSync(path, 'utf8').split('\n');
    expect((smallLine ?? '').length * 4).toBeLessThan((fullLine ?? '').length);
  });

  test('a changed tab set appends a full record', () => {
    writeLive(cmuxFile(T0, LAYOUT));
    record(T0 + HOUR);
    writeLive(cmuxFile(T0 + HOUR, LAYOUT_DEGRADED));
    expect(record(T0 + 2 * HOUR).live.kind).toBe('hourly');
  });

  test('a launch is recorded once, its two files in one record', () => {
    writeLive(cmuxFile(T0 + 10_000, LAYOUT));
    writePrevious(cmuxFile(T0, LAYOUT));
    const historyName = writeHistory(cmuxFile(T0, LAYOUT), T0 + 3_000);
    const first = record(T0 + HOUR);
    expect(first.launches.newlyRecorded).toHaveLength(1);
    expect(first.launches.newlyRecorded[0]?.files.sort()).toEqual(
      [PREVIOUS_SESSION_FILE, historyName].sort(),
    );
    const second = record(T0 + 2 * HOUR);
    expect(second.launches.newlyRecorded).toHaveLength(0);
    expect(second.launches.alreadyRecorded).toBe(1);
    expect(readJsonl(join(store, LAUNCHES_FILE)).records).toHaveLength(1);
  });

  test('a missing or unrecognised launch file is a named fallback, not a failure', () => {
    writeLive(cmuxFile(T0, LAYOUT));
    const none = record(T0 + HOUR);
    expect(none.exitCode).toBe(0);
    expect(none.launches.missing).toEqual([
      PREVIOUS_SESSION_FILE,
      `${SESSION_HISTORY_DIR}/`,
    ]);
    writePrevious(cmuxFile(T0, LAYOUT, {version: 9}));
    const odd = record(T0 + 2 * HOUR);
    expect(odd.exitCode).toBe(0);
    expect(odd.launches.unrecognised.map((n) => n.file)).toEqual([
      PREVIOUS_SESSION_FILE,
    ]);
  });

  test('a torn last line loses no earlier record, and the next append starts a new line', () => {
    writeLive(cmuxFile(T0, LAYOUT));
    record(T0 + HOUR);
    const path = join(store, dayFileName(T0 + HOUR));
    writeFileSync(path, `${readFileSync(path, 'utf8')}{"kind":"hourly","sch`);
    writeLive(cmuxFile(T0 + HOUR, LAYOUT_DEGRADED));
    const result = record(T0 + 2 * HOUR);
    expect(result.unreadableLines).toBe(1);
    const read = readJsonl(path);
    expect(read.records.map((r) => r.kind)).toEqual(['hourly', 'hourly']);
    expect(read.unreadableLines).toBe(1);
  });

  test('prunes day files and launches older than the retention, never the newest launch', () => {
    const old = T0 - (RETENTION_DAYS + 5) * 24 * HOUR;
    mkdirSync(store, {recursive: true});
    writeFileSync(join(store, dayFileName(old)), '{}\n');
    writeFileSync(
      join(store, LAUNCHES_FILE),
      `${JSON.stringify({counts: {}, fileCreatedAt: old, fileVersion: 1, files: ['x'], id: `launch-${old}`, kind: 'launch', recordedAt: old, schema: 1, windows: []})}\n`,
    );
    writeLive(cmuxFile(T0, LAYOUT));
    const kept = record(T0 + HOUR);
    expect(kept.pruned).toEqual({dayFiles: 1, launchRecords: 0});
    expect(readJsonl(join(store, LAUNCHES_FILE)).records).toHaveLength(1);
    writePrevious(cmuxFile(T0, LAYOUT));
    const second = record(T0 + 2 * HOUR);
    expect(second.pruned).toEqual({dayFiles: 0, launchRecords: 1});
    const launches = readJsonl(join(store, LAUNCHES_FILE)).records;
    expect(
      launches.map((r) => (r.kind === 'launch' ? r.fileCreatedAt : null)),
    ).toEqual([T0]);
  });
});

describe('thread tabs before-restart', () => {
  const BOOT = T0;
  const LAUNCH = T0 + 2 * HOUR;

  function answer(boot: TimeRead, cmux: TimeRead, now = LAUNCH + HOUR) {
    return beforeRestart({
      boot,
      cmuxProcess: cmux,
      now,
      storeDir: store,
      supportDir: support,
    });
  }

  test('picks the launch record of the launch that is the restart', () => {
    // Before the boot: an hourly record. Then cmux relaunches after the boot.
    writeLive(cmuxFile(BOOT - HOUR, LAYOUT_DEGRADED));
    record(BOOT - 30 * 60 * 1000);
    writePrevious(cmuxFile(LAUNCH - 1_500, LAYOUT));
    writeLive(cmuxFile(LAUNCH + 10 * 60 * 1000, LAYOUT_DEGRADED));
    record(LAUNCH + 20 * 60 * 1000);
    const result = answer(ok(BOOT), ok(LAUNCH));
    if (!result.ok) throw new Error(result.reason);
    expect(result.restart.kind).toBe('cmux launch');
    expect(result.restart.at).toBe(LAUNCH);
    expect(result.source.kind).toBe('launch record');
    expect(result.source.fileCreatedAt).toBe(LAUNCH - 1_500);
    expect(result.counts).toMatchObject({
      claudeTabs: 2,
      tabs: 3,
      windows: 2,
      workspaces: 2,
    });
  });

  test('without a launch record, the newest record by FILE createdAt before the restart, though written after it', () => {
    // A file saved 20 min before the boot, recorded 57 min AFTER the boot.
    writeLive(cmuxFile(BOOT - 20 * 60 * 1000, LAYOUT));
    record(BOOT + 57 * 60 * 1000);
    // A file saved after the boot: never "before".
    writeLive(cmuxFile(BOOT + 90 * 60 * 1000, LAYOUT_DEGRADED));
    record(BOOT + 117 * 60 * 1000);
    const result = answer(ok(BOOT), no('ps refused'), BOOT + 2 * HOUR);
    if (!result.ok) throw new Error(result.reason);
    expect(result.restart.kind).toBe('boot');
    expect(result.source.kind).toBe('hourly record');
    expect(result.source.fileCreatedAt).toBe(BOOT - 20 * 60 * 1000);
    expect(result.counts.claudeTabs).toBe(2);
  });

  test('with no launch file at all, the hourly records alone answer a cmux relaunch', () => {
    writeLive(cmuxFile(LAUNCH - HOUR, LAYOUT));
    record(LAUNCH - 50 * 60 * 1000);
    writeLive(cmuxFile(LAUNCH + 5 * 60 * 1000, LAYOUT_DEGRADED));
    record(LAUNCH + 10 * 60 * 1000);
    const result = answer(ok(BOOT), ok(LAUNCH));
    if (!result.ok) throw new Error(result.reason);
    expect(result.restart.kind).toBe('cmux launch');
    expect(result.source.kind).toBe('hourly record');
    expect(result.source.fileCreatedAt).toBe(LAUNCH - HOUR);
  });

  test('with nothing recorded, the live file when cmux saved it before the restart', () => {
    writeLive(cmuxFile(BOOT - HOUR, LAYOUT));
    const result = answer(
      ok(BOOT),
      no('no cmux app process is running'),
      BOOT + HOUR,
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.source.kind).toBe('live file');
    expect(existsSync(store)).toBe(false);
  });

  test('the order is launch record, then recorded set, then live file', () => {
    writeLive(cmuxFile(LAUNCH - 40 * 60 * 1000, LAYOUT));
    record(LAUNCH - 30 * 60 * 1000);
    writePrevious(cmuxFile(LAUNCH, LAYOUT));
    writeLive(cmuxFile(LAUNCH - 35 * 60 * 1000, LAYOUT));
    record(LAUNCH + 5 * 60 * 1000);
    expect(
      answer(ok(BOOT), ok(LAUNCH)).ok && answer(ok(BOOT), ok(LAUNCH)),
    ).toMatchObject({
      source: {kind: 'launch record'},
    });
    rmSync(join(store, LAUNCHES_FILE));
    rmSync(join(support, PREVIOUS_SESSION_FILE));
    expect(answer(ok(BOOT), ok(LAUNCH))).toMatchObject({
      source: {kind: 'hourly record'},
    });
    rmSync(store, {force: true, recursive: true});
    expect(answer(ok(BOOT), ok(LAUNCH))).toMatchObject({
      source: {kind: 'live file'},
    });
  });

  test('without a launch record, the live file wins when cmux saved it after the newest record and before the restart (kwand.2 item 0)', () => {
    // The last hourly record: a file saved 2 h before the boot.
    writeLive(cmuxFile(BOOT - 2 * HOUR, LAYOUT_DEGRADED));
    record(BOOT - 2 * HOUR + 60_000);
    // cmux's final save before shutdown, never recorded: the better evidence.
    writeLive(cmuxFile(BOOT - 10 * 60 * 1000, LAYOUT));
    const result = answer(ok(BOOT), no('ps refused'), BOOT + 30 * 60 * 1000);
    if (!result.ok) throw new Error(result.reason);
    expect(result.restart.kind).toBe('boot');
    expect(result.source.kind).toBe('live file');
    expect(result.source.fileCreatedAt).toBe(BOOT - 10 * 60 * 1000);
    expect(result.counts.claudeTabs).toBe(2);
    // A record of that same save afterwards: the tie goes to the record.
    record(BOOT + 40 * 60 * 1000);
    const again = answer(ok(BOOT), no('ps refused'), BOOT + HOUR);
    if (!again.ok) throw new Error(again.reason);
    expect(again.source.kind).toBe('hourly record');
    expect(again.source.fileCreatedAt).toBe(BOOT - 10 * 60 * 1000);
  });

  test('a launch file not yet recorded still answers, read in memory and not written', () => {
    writePrevious(cmuxFile(LAUNCH - 1_000, LAYOUT));
    const result = answer(ok(BOOT), ok(LAUNCH));
    if (!result.ok) throw new Error(result.reason);
    expect(result.source.kind).toBe('launch file (not yet recorded)');
    expect(existsSync(store)).toBe(false);
  });

  test('two launches in a row: the second file lost session ids, the first launch carries them forward', () => {
    const FIRST = BOOT + HOUR;
    const SECOND = BOOT + 5 * HOUR;
    writePrevious(cmuxFile(FIRST, LAYOUT));
    writeLive(cmuxFile(FIRST + HOUR, LAYOUT_DEGRADED));
    record(FIRST + 2 * HOUR);
    writePrevious(cmuxFile(SECOND, LAYOUT_DEGRADED));
    writeLive(cmuxFile(SECOND + 60_000, LAYOUT_DEGRADED));
    record(SECOND + HOUR);
    const result = answer(ok(BOOT), ok(SECOND), SECOND + 2 * HOUR);
    if (!result.ok) throw new Error(result.reason);
    expect(result.source.kind).toBe('launch record');
    expect(result.source.fileCreatedAt).toBe(SECOND);
    const tab = result.windows[0]?.workspaces[0]?.tabs[0];
    expect(tab?.sessionId).toBeNull();
    expect(tab?.lastKnownSessionId).toBe('sess-aaaa-1111');
    expect(tab?.lastKnownSeenAt).toBe(FIRST);
    expect(result.counts).toMatchObject({carriedTabs: 1, claudeTabs: 1});
  });

  describe('reads only the day files the answer needs (home-base-kwand.2 F-a)', () => {
    const DAY = 24 * HOUR;

    /** One record a day for 60 days, the newest at T0; returns each day's save time. */
    function sixtyDays(): number[] {
      const saves: number[] = [];
      for (let back = 59; back >= 0; back -= 1) {
        const saved = T0 - back * DAY - 60_000;
        writeLive(cmuxFile(saved, back % 2 === 0 ? LAYOUT : LAYOUT_DEGRADED));
        record(T0 - back * DAY);
        saves.push(saved);
      }
      return saves;
    }

    /** Make every day file older than `keepFrom`'s day unreadable: reading one throws. */
    function lockOlderThan(keepFrom: number): number {
      const keep = dayFileName(keepFrom);
      let locked = 0;
      for (const name of readdirSync(store)) {
        if (name.startsWith('hourly-') && name < keep) {
          chmodSync(join(store, name), 0o000);
          locked += 1;
        }
      }
      return locked;
    }

    test('a store of 60 day files and a restart today: one file is read', () => {
      sixtyDays();
      expect(
        readdirSync(store).filter((n) => n.startsWith('hourly-')),
      ).toHaveLength(60);
      expect(lockOlderThan(T0)).toBe(59);
      const result = answer(ok(T0 + HOUR), no('ps refused'), T0 + 2 * HOUR);
      if (!result.ok) throw new Error(result.reason);
      expect(result.source.kind).toBe('hourly record');
      expect(result.source.fileCreatedAt).toBe(T0 - 60_000);
      expect(result.store).toMatchObject({
        dayFilesRead: 1,
        dayFilesSkipped: 59,
      });
    });

    test('a restart ten days back: it reads back to that day and no further', () => {
      sixtyDays();
      const restart = T0 - 10 * DAY + 30 * 60 * 1000;
      expect(lockOlderThan(T0 - 10 * DAY)).toBe(49);
      const result = answer(ok(restart), no('ps refused'), T0 + HOUR);
      if (!result.ok) throw new Error(result.reason);
      expect(result.source.fileCreatedAt).toBe(T0 - 10 * DAY - 60_000);
      expect(result.store).toMatchObject({
        dayFilesRead: 11,
        dayFilesSkipped: 49,
      });
    });

    test("a day's first record of an older save does not stop it: the day before holds a newer one", () => {
      const midnight = new Date(2031, 2, 10).getTime();
      // Yesterday 23:30 recorded a save of 23:20.
      writeLive(cmuxFile(midnight - 40 * 60 * 1000, LAYOUT));
      record(midnight - 30 * 60 * 1000);
      // Today 00:30 recorded a save of yesterday 22:00 (a clock set back).
      writeLive(cmuxFile(midnight - 2 * HOUR, LAYOUT_DEGRADED));
      record(midnight + 30 * 60 * 1000);
      const result = answer(
        ok(midnight + HOUR),
        no('ps refused'),
        midnight + 2 * HOUR,
      );
      if (!result.ok) throw new Error(result.reason);
      expect(result.source.fileCreatedAt).toBe(midnight - 40 * 60 * 1000);
      expect(result.store.dayFilesRead).toBe(2);
    });
  });

  test('when neither clock can be read it says so, never an answer', () => {
    writeLive(cmuxFile(BOOT - HOUR, LAYOUT));
    const result = answer(no('sysctl refused'), no('ps refused'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('cannot tell when the last restart was');
  });
});

describe('the clocks', () => {
  test('parses kern.boottime', () => {
    expect(
      parseBootTime(
        '{ sec = 1794970851, usec = 723419 } Tue Nov 17 19:00:51 2026',
      ),
    ).toBe(1794970851723);
    expect(parseBootTime('garbage')).toBeNull();
  });

  test('parses the cmux app start, ignoring the CLI and helper binaries', () => {
    const text = [
      'Tue Nov 17 23:30:02 2026     /Applications/cmux.app/Contents/Resources/bin/cmux',
      'Tue Nov 17 21:36:52 2026     /Applications/cmux.app/Contents/MacOS/cmux',
      'Tue Nov 17 21:37:01 2026     /Users/x/Library/Application Support/cmux/cmux-cua/helper/cmux Computer Use.app/Contents/MacOS/cmux-cua',
    ].join('\n');
    expect(parseCmuxStart(text)).toEqual({
      ms: new Date(2026, 10, 17, 21, 36, 52).getTime(),
      ok: true,
    });
    expect(parseCmuxStart('').ok).toBe(false);
  });
});

describe('the off switch (componentConfig.thread.tabRecord)', () => {
  test('false writes nothing and exits 0; true records', async () => {
    const project = join(root, 'project');
    mkdirSync(project, {recursive: true});
    const env = {
      JUSTIN_THREADS_CMUX_SUPPORT_DIR: support,
      JUSTIN_THREADS_STATE_DIR: join(root, 'state'),
      XDG_CONFIG_HOME: join(root, 'xdg'),
    };
    writeLive(cmuxFile(T0, LAYOUT));
    const printed: string[] = [];
    const run = async (value: boolean) => {
      writeFileSync(
        join(project, 'justin-sdk.config.json'),
        JSON.stringify({componentConfig: {thread: {tabRecord: value}}}),
      );
      return await runThreadTabsRecord({
        cwd: project,
        env,
        json: false,
        now: T0 + HOUR,
        print: (text) => {
          printed.push(text);
          return Promise.resolve();
        },
      });
    };
    expect(await run(false)).toBe(0);
    expect(printed.join('')).toContain('off');
    expect(existsSync(store)).toBe(false);
    expect(await run(true)).toBe(0);
    expect(existsSync(join(store, dayFileName(T0 + HOUR)))).toBe(true);
  });
});
