/**
 * `thread tabs record` and `thread tabs before-restart` (home-base-kwand.1).
 * The store and the record logic are in ./tab-record.ts; this module reads the
 * two clocks (boot, cmux launch), picks what was open before the restart, and
 * prints. It never talks to the cmux socket.
 */

import type {TabSet} from './cmux-session-file';
import type {ResolvedTabSet, StoredWindow} from './tab-record';

import {execFile} from 'node:child_process';
import {homedir} from 'node:os';

import {
  BODY_COLUMN,
  fieldLines,
  type OutputStyle,
  outputStyle,
  paint,
  sectionHeader,
  spacedList,
  stepColumn,
  wrapHanging,
} from '../cli-style';
import {writeStdout} from '../write-stdout';
import {
  cmuxSupportDir,
  LIVE_SESSION_FILE,
  readTabSet,
} from './cmux-session-file';
import {resolveThreadConfig} from './config';
import {type EnvLike, threadsStateDir} from './paths';
import {
  dayFiles,
  LAUNCH_MATCH_MS,
  loadStore,
  readLaunchFiles,
  readLaunchRecords,
  recordTabs,
  resolveFull,
  resolveTabSet,
  RETENTION_DAYS,
  stopOnceSetBefore,
  tabRecordDir,
} from './tab-record';

// ---------------------------------------------------------------------------
// The two clocks
// ---------------------------------------------------------------------------

/** A time read from the machine, or why it could not be read. */
export type TimeRead = {ms: number; ok: true} | {ok: false; reason: string};

/** Reads one clock. Injected so tests are hermetic. */
export type ClockReader = () => Promise<TimeRead>;

function run(
  file: string,
  args: readonly string[],
): Promise<{ok: false; reason: string} | {ok: true; stdout: string}> {
  return new Promise((resolve) => {
    try {
      execFile(
        file,
        [...args],
        {
          env: {...process.env, LC_ALL: 'C'},
          maxBuffer: 16 * 1024 * 1024,
          timeout: 10_000,
        },
        (error, stdout, stderr) => {
          if (error != null) {
            const detail = String(stderr).trim();
            resolve({
              ok: false,
              reason: `${file} ${args.join(' ')} failed: ${detail !== '' ? detail : error.message}`,
            });
            return;
          }
          resolve({ok: true, stdout: String(stdout)});
        },
      );
    } catch (error) {
      // Inside the Claude Code sandbox the spawn itself can throw (EPERM).
      resolve({
        ok: false,
        reason: `${file} could not start: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });
}

/** `{ sec = 1794970851, usec = 723419 } Tue Nov 17 …` → ms, or null. */
export function parseBootTime(text: string): number | null {
  const match = /sec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)/u.exec(text);
  if (match?.[1] == null || match[2] == null) return null;
  return Number(match[1]) * 1000 + Math.floor(Number(match[2]) / 1000);
}

/** The last macOS boot, from `sysctl -n kern.boottime`. */
export const realBootClock: ClockReader = async () => {
  const call = await run('sysctl', ['-n', 'kern.boottime']);
  if (!call.ok) return {ok: false, reason: call.reason};
  const ms = parseBootTime(call.stdout);
  return ms == null
    ? {
        ok: false,
        reason: `sysctl -n kern.boottime printed nothing this reader knows: ${call.stdout.trim()}`,
      }
    : {ms, ok: true};
};

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** The cmux app binary, as `ps -o comm` prints it. */
const CMUX_APP_SUFFIX = '/cmux.app/Contents/MacOS/cmux';

/**
 * The cmux app's start time from `ps -axo lstart=,comm=` (LC_ALL=C), local
 * time, whole seconds. Null with a reason unless exactly one app process runs.
 */
export function parseCmuxStart(text: string): TimeRead {
  const starts: number[] = [];
  for (const line of text.split('\n')) {
    const match =
      /^\s*\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s+(.+?)\s*$/u.exec(
        line,
      );
    if (match == null) continue;
    const [, month, day, hour, minute, second, year, comm] = match;
    if (comm?.endsWith(CMUX_APP_SUFFIX) !== true) continue;
    const monthIndex = MONTHS.indexOf(month ?? '');
    if (monthIndex < 0) continue;
    starts.push(
      new Date(
        Number(year),
        monthIndex,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
      ).getTime(),
    );
  }
  const [only] = starts;
  if (only == null) {
    return {ok: false, reason: 'no cmux app process is running'};
  }
  if (starts.length > 1) {
    return {
      ok: false,
      reason: `${starts.length} cmux app processes are running; which one is the launch cannot be told`,
    };
  }
  return {ms: only, ok: true};
}

/** The running cmux app's start time, from `ps`. */
export const realCmuxClock: ClockReader = async () => {
  const call = await run('ps', ['-axo', 'lstart=,comm=']);
  if (!call.ok) return {ok: false, reason: call.reason};
  return parseCmuxStart(call.stdout);
};

// ---------------------------------------------------------------------------
// Before the restart
// ---------------------------------------------------------------------------

export interface RestartFacts {
  /** The restart: the later of the boot and the cmux launch. */
  at: number;
  boot: TimeRead;
  /** The cmux launch this answer used, and how it is known. */
  cmuxLaunch: {
    at: number;
    how: 'launch record' | 'process start';
    recordAt: number | null;
  } | null;
  cmuxProcess: TimeRead;
  kind: 'boot' | 'cmux launch';
  /** Plain sentences about how the restart was decided. */
  notes: string[];
}

export type SourceKind =
  | 'earlier launch record'
  | 'launch record'
  | 'launch file (not yet recorded)'
  | 'hourly record'
  | 'live file';

/**
 * What the answer read of the store. Day files are read newest first and only
 * until the answer is settled (home-base-kwand.2 F-a), so the two counts cover
 * the files read: every failed run since the chosen tab set was saved is in
 * them, and an older failure is no part of this answer.
 */
export interface BeforeRestartStoreFacts {
  dayFilesRead: number;
  /** Older day files not read: the answer was settled without them. */
  dayFilesSkipped: number;
  dir: string;
  /** Recorder runs that failed after the chosen tab set was saved and before the restart. */
  failedRunsSinceSource: number;
  /** Unreadable lines in launches.jsonl and the day files read. */
  unreadableLines: number;
}

export type BeforeRestart =
  | {
      counts: ResolvedTabSet['counts'];
      ok: true;
      restart: RestartFacts;
      source: {
        fileCreatedAt: number;
        files: string[];
        kind: SourceKind;
        recordedAt: number | null;
      };
      store: BeforeRestartStoreFacts;
      windows: StoredWindow[];
    }
  | {
      ok: false;
      reason: string;
      restart: RestartFacts | null;
      store: BeforeRestartStoreFacts;
    };

/** A cmux launch known from launches.jsonl or from a launch file not yet recorded. */
interface KnownLaunch {
  fileCreatedAt: number;
  /** A launch file on disk, read now: resolved once the store is read. */
  pending: {name: string; tabSet: TabSet} | null;
  recorded: ResolvedTabSet | null;
}

/**
 * What was open before the restart (Justin's question 1). Reads the store and
 * cmux's files; writes nothing.
 */
export function beforeRestart(input: {
  boot: TimeRead;
  cmuxProcess: TimeRead;
  now: number;
  storeDir: string;
  supportDir: string;
}): BeforeRestart {
  const {boot, cmuxProcess, storeDir, supportDir} = input;
  // The restart is decided from launches.jsonl and cmux's launch files alone;
  // the day files are read afterwards, newest first, only until the answer is
  // settled (home-base-kwand.2 F-a).
  const launchRead = readLaunchRecords(storeDir);

  // Launch files on disk the recorder has not recorded yet (between a launch
  // and the next hourly tick): read now, in memory, never written.
  const recordedAt = new Set(launchRead.launches.map((r) => r.fileCreatedAt));
  const disk = readLaunchFiles(supportDir, {
    notBefore: input.now - RETENTION_DAYS * 24 * 60 * 60 * 1000,
    skipNames: new Set(launchRead.launches.flatMap((r) => r.files)),
  });
  const launches: KnownLaunch[] = launchRead.launches.map((record) => ({
    fileCreatedAt: record.fileCreatedAt,
    pending: null,
    recorded: resolveFull(record),
  }));
  for (const file of disk.files) {
    if (!file.read.ok) continue;
    const {tabSet} = file.read;
    if (recordedAt.has(tabSet.fileCreatedAt)) continue;
    if (launches.some((l) => l.fileCreatedAt === tabSet.fileCreatedAt)) {
      continue;
    }
    launches.push({
      fileCreatedAt: tabSet.fileCreatedAt,
      pending: {name: file.name, tabSet},
      recorded: null,
    });
  }
  launches.sort((a, b) => b.fileCreatedAt - a.fileCreatedAt);

  // The cmux launch: the running process's start, cross-checked with the
  // newest launch record; else the newest launch record alone.
  const notes: string[] = [];
  let cmuxLaunch: RestartFacts['cmuxLaunch'] = null;
  let thatLaunch: KnownLaunch | null = null;
  const newestLaunch = launches[0] ?? null;
  if (cmuxProcess.ok) {
    const match = launches.find(
      (l) => Math.abs(l.fileCreatedAt - cmuxProcess.ms) <= LAUNCH_MATCH_MS,
    );
    thatLaunch = match ?? null;
    cmuxLaunch = {
      at: cmuxProcess.ms,
      how: 'process start',
      recordAt: match?.fileCreatedAt ?? null,
    };
    notes.push(
      match != null
        ? "the running cmux process started then, and cmux's launch record of that launch agrees"
        : 'the running cmux process started then; no launch record of that launch was found, so the hourly records answer',
    );
  } else if (newestLaunch != null) {
    thatLaunch = newestLaunch;
    cmuxLaunch = {
      at: newestLaunch.fileCreatedAt,
      how: 'launch record',
      recordAt: newestLaunch.fileCreatedAt,
    };
    notes.push(
      `the cmux launch time is the newest launch record's; the running cmux process could not be read (${cmuxProcess.reason})`,
    );
  } else {
    notes.push(
      `no cmux launch is known: no launch record, and the running cmux process could not be read (${cmuxProcess.reason})`,
    );
  }
  if (!boot.ok) notes.push(`the boot time could not be read (${boot.reason})`);
  for (const name of disk.missing) {
    notes.push(`cmux's launch file ${name} is not there`);
  }
  for (const file of disk.files) {
    if (!file.read.ok) {
      notes.push(
        `cmux's launch file ${file.name} was not used: ${file.read.reason}`,
      );
    }
  }

  const candidates: {at: number; kind: RestartFacts['kind']}[] = [];
  if (boot.ok) candidates.push({at: boot.ms, kind: 'boot'});
  if (cmuxLaunch != null)
    candidates.push({at: cmuxLaunch.at, kind: 'cmux launch'});
  const latest = candidates.sort((a, b) => b.at - a.at)[0];
  if (latest == null) {
    return {
      ok: false,
      reason: `cannot tell when the last restart was: ${notes.join('; ')}`,
      restart: null,
      store: {
        dayFilesRead: 0,
        dayFilesSkipped: dayFiles(storeDir).length,
        dir: storeDir,
        failedRunsSinceSource: 0,
        unreadableLines: launchRead.unreadableLines,
      },
    };
  }
  const restart: RestartFacts = {
    at: latest.at,
    boot,
    cmuxLaunch,
    cmuxProcess,
    kind: latest.kind,
    notes,
  };

  // Every question below asks for the newest set saved before a time: before
  // the restart, or before the launch file of that launch (its prior). The
  // earlier of the two settles both.
  const usesLaunch = restart.kind === 'cmux launch' && thatLaunch != null;
  const pending = usesLaunch ? (thatLaunch?.pending ?? null) : null;
  const store = loadStore(
    storeDir,
    stopOnceSetBefore(
      Math.min(restart.at, pending?.tabSet.fileCreatedAt ?? restart.at),
    ),
    launchRead,
  );
  const {sets} = store;
  // `since` is when the chosen tab set was saved. With none (null), nothing
  // settled the stop condition, so every day file was read and every failed
  // run before the restart counts.
  const storeFacts = (since: number | null): BeforeRestartStoreFacts => ({
    dayFilesRead: store.days.length,
    dayFilesSkipped: store.dayFilesSkipped,
    dir: storeDir,
    failedRunsSinceSource: store.failures.filter(
      (f) =>
        (since == null || f.recordedAt >= since) && f.recordedAt < restart.at,
    ).length,
    unreadableLines: store.unreadableLines,
  });

  // The source, in the order the bead names (epic D1).
  let source: {kind: SourceKind; set: ResolvedTabSet} | null = null;
  if (usesLaunch && thatLaunch?.recorded != null) {
    source = {kind: 'launch record', set: thatLaunch.recorded};
  } else if (pending != null) {
    const prior =
      sets.find((set) => set.fileCreatedAt < pending.tabSet.fileCreatedAt) ??
      null;
    source = {
      kind: 'launch file (not yet recorded)',
      set: resolveTabSet(pending.tabSet, prior, {
        files: [pending.name],
        kind: 'launch',
        recordedAt: null,
      }),
    };
  }
  if (source == null) {
    // No launch record of the restart: the NEWEST candidate by file createdAt,
    // among the recorded sets (launch records of EARLIER launches count too)
    // and the live file, all saved before the restart (home-base-kwand.2 item
    // 0). After a boot the live file can hold cmux's last save before shutdown,
    // newer than the last hourly record, and it is the better evidence. On a
    // tie the recorded set wins: it is the same save, already in the store.
    const recorded = sets.find((set) => set.fileCreatedAt < restart.at) ?? null;
    const live = readTabSet(`${supportDir}/${LIVE_SESSION_FILE}`);
    if (!live.ok) {
      notes.push(`cmux's live session file was not used: ${live.reason}`);
    }
    const liveBefore =
      live.ok && live.tabSet.fileCreatedAt < restart.at ? live.tabSet : null;
    if (
      liveBefore != null &&
      (recorded == null || liveBefore.fileCreatedAt > recorded.fileCreatedAt)
    ) {
      const prior =
        sets.find((set) => set.fileCreatedAt <= liveBefore.fileCreatedAt) ??
        null;
      source = {
        kind: 'live file',
        set: resolveTabSet(liveBefore, prior, {
          files: [LIVE_SESSION_FILE],
          kind: 'live',
          recordedAt: null,
        }),
      };
    } else if (recorded != null) {
      source = {
        kind:
          recorded.kind === 'launch'
            ? 'earlier launch record'
            : 'hourly record',
        set: recorded,
      };
    }
  }
  if (source == null) {
    return {
      ok: false,
      reason:
        'nothing recorded before the restart: no launch record of it, no hourly record saved before it, and the live file was saved after it',
      restart,
      store: storeFacts(null),
    };
  }
  return {
    counts: source.set.counts,
    ok: true,
    restart,
    source: {
      fileCreatedAt: source.set.fileCreatedAt,
      files: source.set.files,
      kind: source.kind,
      recordedAt: source.set.recordedAt,
    },
    store: storeFacts(source.set.fileCreatedAt),
    windows: source.set.windows,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Local `YYYY-MM-DD HH:MM:SS`. */
export function localTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** "3 h 12 min ago", "2 d 4 h ago", "in the future" when the clock disagrees. */
export function age(ms: number, now: number): string {
  const minutes = Math.floor((now - ms) / 60_000);
  if (minutes < 0) return 'in the future';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${minutes % 60} min ago`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h ago`;
}

function tilde(path: string | null): string | null {
  if (path == null) return null;
  const home = homedir();
  return path === home || path.startsWith(`${home}/`)
    ? `~${path.slice(home.length)}`
    : path;
}

const SOURCE_WORDS: Record<SourceKind, string> = {
  'earlier launch record':
    'the launch record of an earlier cmux launch, the newest tab set recorded before the restart',
  'hourly record':
    'the newest hourly record of the tabs saved before the restart',
  'launch file (not yet recorded)':
    "cmux's own launch file: the layout cmux restored at that launch (read now; the hourly recorder has not recorded it yet)",
  'launch record':
    "cmux's launch record: the layout cmux restored at that launch",
  'live file':
    "cmux's live session file, saved before the restart (cmux has not saved since)",
};

export function renderBeforeRestart(
  result: BeforeRestart,
  style: OutputStyle,
  now: number,
  sessionsNow: SessionsNowRead = {ok: false, reason: 'not read'},
): string {
  const {color, width} = style;
  if (!result.ok) {
    const blocks = [
      sectionHeader('Open before the last restart', {color, emoji: '🔄'}),
      wrapHanging(paint(result.reason, ['red'], color), {
        hang: BODY_COLUMN,
        indent: BODY_COLUMN,
        width,
      }),
    ];
    if (result.restart != null) {
      blocks.push(
        fieldLines(
          [
            {
              label: 'restart',
              value: `${result.restart.kind}, ${localTime(result.restart.at)} (${age(result.restart.at, now)})`,
            },
            ...result.restart.notes.map((note) => ({
              label: 'note',
              value: note,
            })),
          ],
          {color, indent: BODY_COLUMN, width},
        ),
      );
    }
    return `${spacedList(blocks)}\n`;
  }
  const {counts, restart, source} = result;
  const header = fieldLines(
    [
      {
        label: 'restart',
        value: `${restart.kind === 'boot' ? 'Mac boot' : 'cmux launch'}, ${localTime(restart.at)} (${age(restart.at, now)})`,
      },
      {
        label: 'boot',
        value: restart.boot.ok ? localTime(restart.boot.ms) : 'unknown',
      },
      {
        label: 'cmux launch',
        value:
          restart.cmuxLaunch == null
            ? 'unknown'
            : `${localTime(restart.cmuxLaunch.at)} (from the ${restart.cmuxLaunch.how})`,
      },
      ...restart.notes.map((note) => ({label: 'how known', value: note})),
      {label: 'source', value: SOURCE_WORDS[source.kind]},
      {
        label: 'saved by cmux',
        value: `${localTime(source.fileCreatedAt)} (${age(source.fileCreatedAt, now)})`,
      },
      {label: 'windows', value: String(counts.windows)},
      {label: 'workspaces', value: String(counts.workspaces)},
      {label: 'tabs', value: String(counts.tabs)},
      {
        label: 'Claude tabs',
        value: `${counts.claudeTabs + counts.carriedTabs} (${counts.claudeTabs} in this record, ${counts.carriedTabs} carried forward from an earlier one)`,
      },
      // kwand.2: what those sessions are now, counted.
      {
        label: 'sessions now',
        value: sessionsNow.ok
          ? Object.entries(
              [...sessionsNow.bySession.values()].reduce<
                Record<string, number>
              >(
                (acc, entry) => ({
                  ...acc,
                  [entry.words]: (acc[entry.words] ?? 0) + 1,
                }),
                {},
              ),
            )
              .map(([words, n]) => `${n} ${words}`)
              .join('\n')
          : `unknown (${sessionsNow.reason})`,
      },
      ...(result.store.failedRunsSinceSource > 0
        ? [
            {
              label: 'failed runs',
              value: `${result.store.failedRunsSinceSource} recorder runs failed after that save and before the restart`,
            },
          ]
        : []),
      ...(result.store.unreadableLines > 0
        ? [
            {
              label: 'unreadable',
              value: `${result.store.unreadableLines} lines in the tab records read could not be read and were skipped`,
            },
          ]
        : []),
    ],
    {color, indent: BODY_COLUMN, width},
  );
  const blocks = [
    sectionHeader('Open before the last restart', {color, emoji: '🔄'}),
    header,
  ];
  for (const window of result.windows) {
    const tabCount = window.workspaces.reduce((n, ws) => n + ws.tabs.length, 0);
    blocks.push(
      sectionHeader(
        `Window ${window.index + 1} (${window.workspaces.length} workspaces, ${tabCount} tabs)`,
        {color, emoji: '🪟'},
      ),
    );
    for (const workspace of window.workspaces) {
      const lines = [
        wrapHanging(
          paint(workspace.title ?? '(untitled workspace)', ['bold'], color),
          {
            hang: stepColumn(1),
            indent: BODY_COLUMN,
            width,
          },
        ),
      ];
      const dir = tilde(workspace.currentDirectory);
      if (dir != null) {
        lines.push(
          fieldLines([{label: 'directory', value: dir}], {
            color,
            indent: stepColumn(1),
            width,
          }),
        );
      }
      const tabs = workspace.tabs.map((tab) => {
        const tabLines = [
          wrapHanging(tab.title ?? `(untitled ${tab.type} tab)`, {
            hang: stepColumn(2),
            indent: stepColumn(1),
            width,
          }),
        ];
        // kwand.2: the session's title and what it is now.
        const sessionId = tab.sessionId ?? tab.lastKnownSessionId;
        const sessionNow =
          sessionId != null && sessionsNow.ok
            ? (sessionsNow.bySession.get(sessionId) ?? null)
            : null;
        if (sessionNow != null) {
          tabLines.push(
            fieldLines(
              [
                ...(sessionNow.title == null
                  ? []
                  : [{label: 'title', value: sessionNow.title}]),
                {
                  label: 'now',
                  value:
                    sessionNow.state === 'unknown'
                      ? `${sessionNow.words} (${sessionNow.reason})`
                      : sessionNow.words,
                },
              ],
              {color, indent: stepColumn(2), width},
            ),
          );
        }
        if (tab.sessionId != null) {
          tabLines.push(
            fieldLines(
              [
                {
                  label: 'session',
                  value: paint(tab.sessionId, ['cyan'], color),
                },
              ],
              {
                color,
                indent: stepColumn(2),
                width,
              },
            ),
          );
        } else if (tab.lastKnownSessionId != null) {
          tabLines.push(
            fieldLines(
              [
                {
                  label: 'session',
                  value: `${paint(tab.lastKnownSessionId, ['cyan'], color)} ${paint(
                    `(carried forward: last seen in a file saved ${tab.lastKnownSeenAt == null ? 'at an unknown time' : localTime(tab.lastKnownSeenAt)})`,
                    ['yellow'],
                    color,
                  )}`,
                },
              ],
              {color, indent: stepColumn(2), width},
            ),
          );
        }
        return tabLines.join('\n');
      });
      blocks.push([lines.join('\n'), ...tabs].join('\n\n'));
    }
  }
  return `${spacedList(blocks)}\n`;
}

// ---------------------------------------------------------------------------
// The commands
// ---------------------------------------------------------------------------

export interface TabsCommandOptions {
  cwd?: string;
  env?: EnvLike;
  json: boolean;
  now?: number;
  print?: (text: string) => Promise<void>;
}

/** `thread tabs record`. Exit 0 recorded or off, 1 failed. */
export async function runThreadTabsRecord(
  options: TabsCommandOptions,
): Promise<number> {
  const env = options.env ?? process.env;
  const print = options.print ?? writeStdout;
  const now = options.now ?? Date.now();
  const config = resolveThreadConfig({cwd: options.cwd, env});
  if (!config.tabRecord) {
    const message = `thread tabs record: off (componentConfig.thread.tabRecord is false in the ${config.tabRecordSource} config); nothing written`;
    await print(
      options.json
        ? `${JSON.stringify({off: true, reason: message})}\n`
        : `${message}\n`,
    );
    return 0;
  }
  const storeDir = tabRecordDir(threadsStateDir(env));
  let result: ReturnType<typeof recordTabs>;
  try {
    result = recordTabs({now, storeDir, supportDir: cmuxSupportDir(env)});
  } catch (error) {
    const reason = `thread tabs record: could not write the tab records under ${storeDir}: ${error instanceof Error ? error.message : String(error)}`;
    await print(
      options.json ? `${JSON.stringify({ok: false, reason})}\n` : `${reason}\n`,
    );
    return 1;
  }
  if (options.json) {
    await print(`${JSON.stringify(result, null, 2)}\n`);
    return result.exitCode;
  }
  const {launches, live, pruned} = result;
  const liveText =
    live.kind === 'failed'
      ? `FAILED to read the live file: ${live.reason}`
      : `${live.kind === 'unchanged' ? 'unchanged since the last record' : 'recorded'}: ${live.counts.windows} windows, ${live.counts.workspaces} workspaces, ${live.counts.tabs} tabs, ${live.counts.claudeTabs} with a Claude session`;
  const launchParts = [
    `${launches.newlyRecorded.length} new`,
    `${launches.alreadyRecorded} already recorded`,
    ...(launches.unrecognised.length > 0
      ? [
          `${launches.unrecognised.length} not usable (${launches.unrecognised.map((n) => `${n.file}: ${n.reason}`).join('; ')})`,
        ]
      : []),
    ...(launches.missing.length > 0
      ? [`not there: ${launches.missing.join(', ')}`]
      : []),
  ];
  const extras = [
    ...(pruned.dayFiles + pruned.launchRecords > 0
      ? [
          `pruned ${pruned.dayFiles} day files and ${pruned.launchRecords} launch records`,
        ]
      : []),
    ...(result.unreadableLines > 0
      ? [`${result.unreadableLines} unreadable lines skipped`]
      : []),
  ];
  await print(
    `thread tabs record: live tabs ${liveText}; launches: ${launchParts.join(', ')}${extras.length > 0 ? `; ${extras.join('; ')}` : ''}\n`,
  );
  return result.exitCode;
}

/** home-base-kwand.2: a tab's session now, as the inbox tells it. */
export interface SessionNow {
  reason: string;
  state: string;
  /** The session's title in the inbox; null when it has no card there. */
  title: string | null;
  /** The state in words, with its emoji ("💥 restore failed"). */
  words: string;
}

/** The state now of every session in the before set, or why not. */
export type SessionsNowRead =
  | {bySession: Map<string, SessionNow>; ok: true}
  | {ok: false; reason: string};

/**
 * The real reader: the inbox, read the way `thread inbox --before-restart`
 * reads it, so both commands give the same states and counts. Imported on
 * use: the inbox imports this module.
 */
async function realSessionsNow(
  env: EnvLike,
  cwd: string,
): Promise<SessionsNowRead> {
  const inbox = await import('./session-inbox');
  const {BEFORE_RESTART_WORDS, realBeforeRestartReader} = await import(
    './before-restart-state'
  );
  const {lookupPanes, realPaneSources} = await import('./pane-join');
  const result = await inbox.readInbox({
    beforeRestart: realBeforeRestartReader(env),
    cwd,
    days: inbox.INBOX_DEFAULT_DAYS,
    env,
    keepBeforeRestart: true,
    lookupPanes: async () => await lookupPanes(realPaneSources(env)),
    now: new Date(),
    repo: null,
  });
  if (result.kind === 'failed') return {ok: false, reason: result.reason};
  const answer = result.read.beforeRestart;
  if (!answer.ok) return {ok: false, reason: answer.reason};
  const titles = new Map(
    result.read.rows.map((row) => [row.sessionId, row.title]),
  );
  const bySession = new Map<string, SessionNow>();
  for (const [sessionId, fact] of answer.facts) {
    const words = BEFORE_RESTART_WORDS[fact.state];
    bySession.set(sessionId, {
      reason: fact.reason,
      state: fact.state,
      title: titles.get(sessionId) ?? null,
      words: `${words.emoji} ${words.title}`,
    });
  }
  return {bySession, ok: true};
}

/** How many sessions are in each state now. */
export function stateCounts(
  bySession: ReadonlyMap<string, SessionNow>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of bySession.values()) {
    counts[entry.state] = (counts[entry.state] ?? 0) + 1;
  }
  return counts;
}

/** `thread tabs before-restart`. Exit 0 answered, 1 could not answer. */
export async function runThreadTabsBeforeRestart(
  options: TabsCommandOptions & {
    bootClock?: ClockReader;
    cmuxClock?: ClockReader;
    /** kwand.2: the state now of each session; default the inbox's. Null: not read. */
    sessionsNow?: (() => Promise<SessionsNowRead>) | null;
  },
): Promise<number> {
  const env = options.env ?? process.env;
  const print = options.print ?? writeStdout;
  const now = options.now ?? Date.now();
  const storeDir = tabRecordDir(threadsStateDir(env));
  const [boot, cmuxProcess] = await Promise.all([
    (options.bootClock ?? realBootClock)(),
    (options.cmuxClock ?? realCmuxClock)(),
  ]);
  let result: BeforeRestart;
  try {
    result = beforeRestart({
      boot,
      cmuxProcess,
      now,
      storeDir,
      supportDir: cmuxSupportDir(env),
    });
  } catch (error) {
    const reason = `thread tabs before-restart: could not read the tab records under ${storeDir}: ${error instanceof Error ? error.message : String(error)}`;
    await print(
      options.json ? `${JSON.stringify({ok: false, reason})}\n` : `${reason}\n`,
    );
    return 1;
  }
  // kwand.2: what each session is now, and its title, from the inbox.
  const readNow =
    options.sessionsNow === undefined
      ? async () => await realSessionsNow(env, options.cwd ?? process.cwd())
      : options.sessionsNow;
  const sessionsNow: SessionsNowRead =
    !result.ok || readNow == null
      ? {ok: false, reason: 'not read'}
      : await readNow().catch((error: unknown) => ({
          ok: false as const,
          reason: error instanceof Error ? error.message : String(error),
        }));
  await print(
    options.json
      ? `${JSON.stringify(
          {
            ...result,
            sessionsNow: sessionsNow.ok
              ? {
                  bySession: Object.fromEntries(sessionsNow.bySession),
                  counts: stateCounts(sessionsNow.bySession),
                  ok: true,
                }
              : sessionsNow,
          },
          null,
          2,
        )}\n`
      : renderBeforeRestart(result, outputStyle(), now, sessionsNow),
  );
  return result.ok ? 0 : 1;
}
