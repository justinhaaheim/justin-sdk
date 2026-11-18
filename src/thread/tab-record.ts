/**
 * The tab record (home-base-kwand.1, gap G1 of epic home-base-kwand): what was
 * open in cmux, recorded every hour from cmux's own saved session files, and
 * the answer to Justin's question 1 (2026-11-17): "Where can I see a list of
 * all the windows/sessions/workspaces that were open before the restart?"
 *
 * THE STORE, under `<threads state dir>/tab-records/` (never the pushed
 * threads repo: titles and directories of private sessions):
 *  - `hourly-YYYY-MM-DD.jsonl`, one per local day of recording, holding
 *    `hourly` (the live file, projected), `unchanged` (the live file equals the
 *    newest full record of the same day file: a small line pointing at it) and
 *    `failed` (the live file could not be read; the reason) lines. The first
 *    record of a day is always full, so an `unchanged` line never points into
 *    another file, and deleting a whole old day file can never orphan one.
 *  - `launches.jsonl`, the `launch` records: the layout cmux restored at a
 *    launch, from `-previous.json` and `session-history/`, one per launch
 *    (deduplicated by the file's createdAt; the two files of one launch share
 *    one record).
 * Every line is append-only jsonl. A torn or malformed line is skipped and
 * COUNTED, never silent, and the next append starts on a fresh line.
 *
 * CARRIED FORWARD (epic D1): the live file drops a tab's Claude session id
 * after a failed restore (75 at the 21:36 launch, 63 at 23:36), so a second
 * relaunch would erase what was there. Every recorded tab therefore also keeps
 * `lastKnownSessionId` and `lastKnownSeenAt` (the FILE createdAt it was last
 * seen in), carried by tab id from the newest earlier record (by file
 * createdAt), apart from `sessionId`, which is what this file says.
 *
 * TIME: every record keeps the file's createdAt (`fileCreatedAt`) and when it
 * was recorded (`recordedAt`). "Before the restart" is decided by
 * `fileCreatedAt` only (epic D1).
 *
 * PRUNING: day files older than RETENTION_DAYS go; launch records whose launch
 * is older go, except the newest launch record. A launch file older than the
 * window is never recorded, so pruning cannot make the next run re-record it.
 */

import type {
  ProjectedTab,
  ProjectedWindow,
  TabSet,
  TabSetRead,
} from './cmux-session-file';

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {join} from 'node:path';

import {
  historyFileEpochMs,
  LIVE_SESSION_FILE,
  PREVIOUS_SESSION_FILE,
  readTabSet,
  SESSION_HISTORY_DIR,
} from './cmux-session-file';

export const TAB_RECORD_DIR_NAME = 'tab-records';
export const LAUNCHES_FILE = 'launches.jsonl';
export const RETENTION_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_FILE_PATTERN = /^hourly-(\d{4})-(\d{2})-(\d{2})\.jsonl$/u;
/**
 * How far apart a launch record's createdAt and the cmux process start may be
 * and still be the same launch. Measured 2026-11-17: `-previous.json` createdAt
 * 21:36:50.6, process start 21:36:52 (ps prints whole seconds).
 */
export const LAUNCH_MATCH_MS = 2 * 60 * 1000;

/** A recorded tab: the projection plus what is carried forward. */
export interface StoredTab extends ProjectedTab {
  /** The file createdAt (ms) that id was last seen in. */
  lastKnownSeenAt: number | null;
  /** The newest Claude session id seen for this tab id, in this or an earlier file. */
  lastKnownSessionId: string | null;
}

export interface StoredWorkspace {
  currentDirectory: string | null;
  tabs: StoredTab[];
  title: string | null;
  workspaceId: string;
}

export interface StoredWindow {
  index: number;
  workspaces: StoredWorkspace[];
}

export interface TabCounts {
  /** Tabs whose own record has no session id but carry one forward. */
  carriedTabs: number;
  /** Tabs whose record has a Claude session id. */
  claudeTabs: number;
  tabs: number;
  windows: number;
  workspaces: number;
}

interface RecordBase {
  /** Session file names (basename) this record was read from. */
  files: string[];
  /** ms */
  recordedAt: number;
  schema: 1;
}

export interface FullRecord extends RecordBase {
  counts: TabCounts;
  fileCreatedAt: number;
  fileVersion: number;
  id: string;
  kind: 'hourly' | 'launch';
  windows: StoredWindow[];
}

export interface UnchangedRecord extends RecordBase {
  fileCreatedAt: number;
  fileVersion: number;
  kind: 'unchanged';
  /** The id of the full record in the same day file that this equals. */
  sameAs: string;
}

export interface FailedRecord extends RecordBase {
  key: string | null;
  kind: 'failed';
  reason: string;
}

export type TabRecord = FailedRecord | FullRecord | UnchangedRecord;

/** A recorded tab set resolved to its tabs, whatever line carried it. */
export interface ResolvedTabSet {
  counts: TabCounts;
  fileCreatedAt: number;
  files: string[];
  /** The line's kind: an `unchanged` line resolves to its full record's tabs. */
  kind: 'hourly' | 'launch' | 'live' | 'unchanged';
  /** null for a set read now and not recorded. */
  recordedAt: number | null;
  windows: StoredWindow[];
}

// ---------------------------------------------------------------------------
// Reading the store
// ---------------------------------------------------------------------------

export function tabRecordDir(stateDir: string): string {
  return join(stateDir, TAB_RECORD_DIR_NAME);
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** The local date of `ms` as YYYY-MM-DD. */
export function localDate(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function dayFileName(ms: number): string {
  return `hourly-${localDate(ms)}.jsonl`;
}

function isTabRecord(value: unknown): value is TabRecord {
  if (value == null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.schema !== 1 || typeof record.recordedAt !== 'number')
    return false;
  if (!Array.isArray(record.files)) return false;
  switch (record.kind) {
    case 'hourly':
    case 'launch':
      return (
        typeof record.id === 'string' &&
        typeof record.fileCreatedAt === 'number' &&
        Array.isArray(record.windows)
      );
    case 'unchanged':
      return (
        typeof record.sameAs === 'string' &&
        typeof record.fileCreatedAt === 'number'
      );
    case 'failed':
      return typeof record.reason === 'string';
    default:
      return false;
  }
}

/** One jsonl file: its records and how many lines could not be read. */
export interface JsonlRead {
  records: TabRecord[];
  /** Lines that were not a record (a torn last line, a damaged line). */
  unreadableLines: number;
}

/**
 * Read one jsonl file. A missing file is no records. A file that exists and
 * cannot be read THROWS: the caller turns that into a named failure, never an
 * empty store (critical rule 7).
 */
export function readJsonl(path: string): JsonlRead {
  if (!existsSync(path)) return {records: [], unreadableLines: 0};
  const text = readFileSync(path, 'utf8');
  const records: TabRecord[] = [];
  let unreadableLines = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      unreadableLines += 1;
      continue;
    }
    if (isTabRecord(parsed)) records.push(parsed);
    else unreadableLines += 1;
  }
  return {records, unreadableLines};
}

/** Append one record as one line, starting a fresh line after a torn one. */
export function appendRecord(path: string, record: TabRecord): void {
  let prefix = '';
  if (existsSync(path)) {
    const size = statSync(path).size;
    if (size > 0) {
      const text = readFileSync(path, 'utf8');
      if (!text.endsWith('\n')) prefix = '\n';
    }
  }
  appendFileSync(path, `${prefix}${JSON.stringify(record)}\n`);
}

/** The day files in the store, newest first. */
export function dayFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => DAY_FILE_PATTERN.test(name))
    .sort()
    .reverse();
}

// ---------------------------------------------------------------------------
// Building a record
// ---------------------------------------------------------------------------

function countTabs(windows: readonly StoredWindow[]): TabCounts {
  const counts: TabCounts = {
    carriedTabs: 0,
    claudeTabs: 0,
    tabs: 0,
    windows: windows.length,
    workspaces: 0,
  };
  for (const window of windows) {
    counts.workspaces += window.workspaces.length;
    for (const workspace of window.workspaces) {
      for (const tab of workspace.tabs) {
        counts.tabs += 1;
        if (tab.sessionId != null) counts.claudeTabs += 1;
        else if (tab.lastKnownSessionId != null) counts.carriedTabs += 1;
      }
    }
  }
  return counts;
}

/** The last-known session id of each tab id in a resolved set. */
function lastKnownByTab(
  prior: ResolvedTabSet | null,
): Map<string, {seenAt: number; sessionId: string}> {
  const out = new Map<string, {seenAt: number; sessionId: string}>();
  if (prior == null) return out;
  for (const window of prior.windows) {
    for (const workspace of window.workspaces) {
      for (const tab of workspace.tabs) {
        if (tab.lastKnownSessionId != null && tab.lastKnownSeenAt != null) {
          out.set(tab.id, {
            seenAt: tab.lastKnownSeenAt,
            sessionId: tab.lastKnownSessionId,
          });
        }
      }
    }
  }
  return out;
}

/**
 * The projection with each tab's last-known session id: its own when the file
 * has one, else the one `prior` carries for the same tab id.
 */
export function carryForward(
  tabSet: TabSet,
  prior: ResolvedTabSet | null,
): StoredWindow[] {
  const known = lastKnownByTab(prior);
  return tabSet.windows.map((window: ProjectedWindow) => ({
    index: window.index,
    workspaces: window.workspaces.map((workspace) => ({
      currentDirectory: workspace.currentDirectory,
      tabs: workspace.tabs.map((tab): StoredTab => {
        if (tab.sessionId != null) {
          return {
            ...tab,
            lastKnownSeenAt: tabSet.fileCreatedAt,
            lastKnownSessionId: tab.sessionId,
          };
        }
        const carried = known.get(tab.id);
        return {
          ...tab,
          lastKnownSeenAt: carried?.seenAt ?? null,
          lastKnownSessionId: carried?.sessionId ?? null,
        };
      }),
      title: workspace.title,
      workspaceId: workspace.workspaceId,
    })),
  }));
}

/** The projection without what is carried: what "identical" compares. */
function rawKey(
  windows: readonly StoredWindow[] | readonly ProjectedWindow[],
): string {
  return JSON.stringify(
    windows.map((window) => ({
      index: window.index,
      workspaces: window.workspaces.map((workspace) => ({
        currentDirectory: workspace.currentDirectory,
        tabs: workspace.tabs.map((tab) => ({
          agentKind: tab.agentKind,
          agentWorkingDirectory: tab.agentWorkingDirectory,
          autoResume: tab.autoResume,
          directory: tab.directory,
          id: tab.id,
          sessionId: tab.sessionId,
          title: tab.title,
          ttyName: tab.ttyName,
          type: tab.type,
        })),
        title: workspace.title,
        workspaceId: workspace.workspaceId,
      })),
    })),
  );
}

export function resolveFull(record: FullRecord): ResolvedTabSet {
  return {
    counts: record.counts,
    fileCreatedAt: record.fileCreatedAt,
    files: record.files,
    kind: record.kind,
    recordedAt: record.recordedAt,
    windows: record.windows,
  };
}

/**
 * An `unchanged` line as the tabs of the full record it names, seen again at
 * its own file createdAt. Null when that record is not in `sameFile`.
 */
function resolveUnchanged(
  record: UnchangedRecord,
  sameFile: readonly TabRecord[],
): ResolvedTabSet | null {
  const full = sameFile.find(
    (candidate): candidate is FullRecord =>
      candidate.kind !== 'failed' &&
      candidate.kind !== 'unchanged' &&
      candidate.id === record.sameAs,
  );
  if (full == null) return null;
  const windows = full.windows.map((window) => ({
    ...window,
    workspaces: window.workspaces.map((workspace) => ({
      ...workspace,
      tabs: workspace.tabs.map((tab) =>
        tab.sessionId == null
          ? tab
          : {...tab, lastKnownSeenAt: record.fileCreatedAt},
      ),
    })),
  }));
  return {
    counts: full.counts,
    fileCreatedAt: record.fileCreatedAt,
    files: record.files,
    kind: 'unchanged',
    recordedAt: record.recordedAt,
    windows,
  };
}

/** A tab set read now, with what it carries forward, as a resolved set. */
export function resolveTabSet(
  tabSet: TabSet,
  prior: ResolvedTabSet | null,
  meta: {
    files: string[];
    kind: ResolvedTabSet['kind'];
    recordedAt: number | null;
  },
): ResolvedTabSet {
  const windows = carryForward(tabSet, prior);
  return {
    counts: countTabs(windows),
    fileCreatedAt: tabSet.fileCreatedAt,
    files: meta.files,
    kind: meta.kind,
    recordedAt: meta.recordedAt,
    windows,
  };
}

// ---------------------------------------------------------------------------
// The store as a whole, loaded newest first
// ---------------------------------------------------------------------------

/** What the store holds, read for one command. */
export interface LoadedStore {
  /** Older day files left unread because the stop condition was met. */
  dayFilesSkipped: number;
  /** Day files read, newest first, with their records (for appending). */
  days: {name: string; records: TabRecord[]}[];
  /** Failed recorder runs in the files read, newest first. */
  failures: FailedRecord[];
  launches: FullRecord[];
  /** Every resolved hourly / unchanged / launch set, newest file createdAt first. */
  sets: ResolvedTabSet[];
  /**
   * Lines that were not records, and `unchanged` lines whose record is gone,
   * in the files read.
   */
  unreadableLines: number;
}

/** What a stop condition sees after each day file. */
export interface StoreProgress {
  /** Sets from the day files read so far (hourly and unchanged lines). */
  daySets: readonly ResolvedTabSet[];
  /** Sets from launches.jsonl, always read whole. */
  launchSets: readonly ResolvedTabSet[];
  /**
   * Local midnight starting the oldest day file read so far. Every line of an
   * unread (older) day file was recorded before it, so its file createdAt is
   * before it too: a file is saved before it is recorded.
   */
  oldestDayStart: number;
}

/** Local midnight starting the day a day file is named for, or null. */
export function dayFileStart(name: string): number | null {
  const match = DAY_FILE_PATTERN.exec(name);
  if (match?.[1] == null || match[2] == null || match[3] == null) return null;
  return new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  ).getTime();
}

/**
 * A stop condition for "the newest set whose file createdAt is before `ms`"
 * (home-base-kwand.2 F-a): once that set is known and saved on or after the
 * oldest day read, no older day file can hold a newer one, so stop. Every set
 * already carries its tabs' last-known session ids, so older files add
 * nothing to the answer.
 */
export function stopOnceSetBefore(
  ms: number,
): (progress: StoreProgress) => boolean {
  return ({daySets, launchSets, oldestDayStart}) => {
    let newest: number | null = null;
    for (const set of [...daySets, ...launchSets]) {
      if (
        set.fileCreatedAt < ms &&
        (newest == null || set.fileCreatedAt > newest)
      )
        newest = set.fileCreatedAt;
    }
    return newest != null && newest >= oldestDayStart;
  };
}

/** launches.jsonl alone: the launch records and how many lines were not one. */
export function readLaunchRecords(dir: string): {
  launches: FullRecord[];
  unreadableLines: number;
} {
  const read = readJsonl(join(dir, LAUNCHES_FILE));
  const launches = read.records.filter(
    (record): record is FullRecord => record.kind === 'launch',
  );
  return {
    launches,
    unreadableLines:
      read.unreadableLines + (read.records.length - launches.length),
  };
}

/**
 * Load the store, day files newest first. `stopWhen`, called after each day
 * file, says whether older day files are still needed; the launch file is
 * always read whole (it is small).
 */
export function loadStore(
  dir: string,
  stopWhen: (progress: StoreProgress) => boolean = () => false,
  launchesRead: {
    launches: FullRecord[];
    unreadableLines: number;
  } = readLaunchRecords(dir),
): LoadedStore {
  const {launches} = launchesRead;
  let unreadableLines = launchesRead.unreadableLines;
  const launchSets: ResolvedTabSet[] = launches.map(resolveFull);
  const daySets: ResolvedTabSet[] = [];
  const failures: FailedRecord[] = [];
  const days: LoadedStore['days'] = [];
  const names = dayFiles(dir);
  let dayFilesSkipped = 0;
  for (const [index, name] of names.entries()) {
    const read = readJsonl(join(dir, name));
    unreadableLines += read.unreadableLines;
    days.push({name, records: read.records});
    for (const record of read.records) {
      if (record.kind === 'failed') failures.push(record);
      else if (record.kind === 'unchanged') {
        const resolved = resolveUnchanged(record, read.records);
        if (resolved == null) unreadableLines += 1;
        else daySets.push(resolved);
      } else if (record.kind === 'hourly') daySets.push(resolveFull(record));
      else unreadableLines += 1;
    }
    const oldestDayStart = dayFileStart(name);
    if (
      oldestDayStart != null &&
      stopWhen({daySets, launchSets, oldestDayStart})
    ) {
      dayFilesSkipped = names.length - index - 1;
      break;
    }
  }
  const sets = [...launchSets, ...daySets];
  const newestFirst = (
    a: {fileCreatedAt: number; recordedAt: number | null},
    b: {fileCreatedAt: number; recordedAt: number | null},
  ): number =>
    b.fileCreatedAt !== a.fileCreatedAt
      ? b.fileCreatedAt - a.fileCreatedAt
      : (b.recordedAt ?? 0) - (a.recordedAt ?? 0);
  sets.sort(newestFirst);
  failures.sort((a, b) => b.recordedAt - a.recordedAt);
  return {dayFilesSkipped, days, failures, launches, sets, unreadableLines};
}

/** The newest set whose file createdAt is at or before `ms`, or null. */
export function newestSetAtOrBefore(
  sets: readonly ResolvedTabSet[],
  ms: number,
): ResolvedTabSet | null {
  return sets.find((set) => set.fileCreatedAt <= ms) ?? null;
}

// ---------------------------------------------------------------------------
// Launch files
// ---------------------------------------------------------------------------

/** One launch file read and projected, or why not. */
export interface LaunchFileRead {
  name: string;
  read: TabSetRead;
}

/**
 * Read cmux's launch files: `-previous.json` and every session-history file
 * whose name is not in `skipNames` and whose launch is not before `notBefore`.
 * A missing file or directory is reported in `missing`, never a failure.
 */
export function readLaunchFiles(
  supportDir: string,
  options: {notBefore: number; skipNames: ReadonlySet<string>},
): {files: LaunchFileRead[]; missing: string[]; tooOld: number} {
  const files: LaunchFileRead[] = [];
  const missing: string[] = [];
  let tooOld = 0;
  const previous = join(supportDir, PREVIOUS_SESSION_FILE);
  if (existsSync(previous)) {
    files.push({name: PREVIOUS_SESSION_FILE, read: readTabSet(previous)});
  } else {
    missing.push(PREVIOUS_SESSION_FILE);
  }
  const historyDir = join(supportDir, SESSION_HISTORY_DIR);
  if (!existsSync(historyDir)) {
    missing.push(`${SESSION_HISTORY_DIR}/`);
  } else {
    for (const name of readdirSync(historyDir).sort()) {
      const epoch = historyFileEpochMs(name);
      if (epoch == null || options.skipNames.has(name)) continue;
      if (epoch < options.notBefore) {
        tooOld += 1;
        continue;
      }
      files.push({name, read: readTabSet(join(historyDir, name))});
    }
  }
  return {files, missing, tooOld};
}

/**
 * Delete day files older than RETENTION_DAYS (by the date in their name) and
 * launch records whose launch is older, never the newest launch record.
 */
export function pruneStore(
  storeDir: string,
  now: number,
): {dayFiles: number; launchRecords: number} {
  const cutoffDate = localDate(now - RETENTION_DAYS * DAY_MS);
  let removedDays = 0;
  for (const name of dayFiles(storeDir)) {
    const match = DAY_FILE_PATTERN.exec(name);
    if (match == null) continue;
    const date = `${match[1]}-${match[2]}-${match[3]}`;
    if (date < cutoffDate) {
      rmSync(join(storeDir, name));
      removedDays += 1;
    }
  }
  const launchesPath = join(storeDir, LAUNCHES_FILE);
  const read = readJsonl(launchesPath);
  const launches = read.records.filter(
    (record): record is FullRecord => record.kind === 'launch',
  );
  const newest = launches.reduce<FullRecord | null>(
    (best, record) =>
      best == null || record.fileCreatedAt > best.fileCreatedAt ? record : best,
    null,
  );
  const cutoff = now - RETENTION_DAYS * DAY_MS;
  const keep = read.records.filter(
    (record) =>
      record.kind !== 'launch' ||
      record === newest ||
      record.fileCreatedAt >= cutoff,
  );
  const removedLaunches = read.records.length - keep.length;
  if (removedLaunches > 0) {
    // Whole-file rename: a crash leaves the old file or the new one, never half.
    const temp = `${launchesPath}.${process.pid}.tmp`;
    writeFileSync(
      temp,
      keep.map((record) => `${JSON.stringify(record)}\n`).join(''),
    );
    renameSync(temp, launchesPath);
  }
  return {dayFiles: removedDays, launchRecords: removedLaunches};
}

// ---------------------------------------------------------------------------
// `thread tabs record`
// ---------------------------------------------------------------------------

/** One launch file the recorder could not use: a named fallback, not a failure. */
export interface LaunchFileNote {
  file: string;
  reason: string;
}

export type RecordOutcome =
  | {
      counts: TabCounts;
      fileCreatedAt: number;
      kind: 'hourly' | 'unchanged';
    }
  | {file: string; kind: 'failed'; reason: string};

export interface RecordResult {
  /** 0 the live file was recorded; 1 it could not be read (a failed line was appended). */
  exitCode: 0 | 1;
  launches: {
    alreadyRecorded: number;
    missing: string[];
    newlyRecorded: {
      counts: TabCounts;
      fileCreatedAt: number;
      files: string[];
    }[];
    tooOld: number;
    unrecognised: LaunchFileNote[];
  };
  live: RecordOutcome;
  pruned: {dayFiles: number; launchRecords: number};
  storeDir: string;
  unreadableLines: number;
}

/**
 * Record what is open now: the launch files not yet recorded, then the live
 * file, then prune. Writes only under `storeDir`. Throws only when the store
 * itself cannot be written or read (the caller names it; exit 1).
 */
export function recordTabs(input: {
  now: number;
  storeDir: string;
  supportDir: string;
}): RecordResult {
  const {now, storeDir, supportDir} = input;
  mkdirSync(storeDir, {recursive: true});
  const cutoff = now - RETENTION_DAYS * DAY_MS;
  // Today's file decides `unchanged`; one earlier set is enough to carry from.
  const today = dayFileName(now);
  const store = loadStore(storeDir, ({daySets}) => daySets.length > 0);
  const sets = [...store.sets];

  // 1. Launch files, oldest launch first, one record per createdAt.
  const recordedNames = new Set(store.launches.flatMap((r) => r.files));
  const recordedCreatedAt = new Set(store.launches.map((r) => r.fileCreatedAt));
  const launchFiles = readLaunchFiles(supportDir, {
    notBefore: cutoff,
    skipNames: recordedNames,
  });
  const unrecognised: LaunchFileNote[] = [];
  const byCreatedAt = new Map<number, {names: string[]; tabSet: TabSet}>();
  for (const {name, read} of launchFiles.files) {
    if (!read.ok) {
      unrecognised.push({file: name, reason: read.reason});
      continue;
    }
    const entry = byCreatedAt.get(read.tabSet.fileCreatedAt);
    if (entry == null) {
      byCreatedAt.set(read.tabSet.fileCreatedAt, {
        names: [name],
        tabSet: read.tabSet,
      });
    } else entry.names.push(name);
  }
  let alreadyRecorded = 0;
  const newlyRecorded: RecordResult['launches']['newlyRecorded'] = [];
  for (const createdAt of [...byCreatedAt.keys()].sort((a, b) => a - b)) {
    const entry = byCreatedAt.get(createdAt);
    if (entry == null) continue;
    if (recordedCreatedAt.has(createdAt)) {
      alreadyRecorded += 1;
      continue;
    }
    if (createdAt < cutoff) continue;
    const prior = sets.find((set) => set.fileCreatedAt < createdAt) ?? null;
    const windows = carryForward(entry.tabSet, prior);
    const record: FullRecord = {
      counts: countTabs(windows),
      fileCreatedAt: createdAt,
      fileVersion: entry.tabSet.fileVersion,
      files: entry.names,
      id: `launch-${createdAt}`,
      kind: 'launch',
      recordedAt: now,
      schema: 1,
      windows,
    };
    appendRecord(join(storeDir, LAUNCHES_FILE), record);
    store.launches.push(record);
    sets.push(resolveFull(record));
    sets.sort((a, b) => b.fileCreatedAt - a.fileCreatedAt);
    newlyRecorded.push({
      counts: record.counts,
      fileCreatedAt: createdAt,
      files: entry.names,
    });
  }

  // 2. The live file.
  const todayPath = join(storeDir, today);
  const live = readTabSet(join(supportDir, LIVE_SESSION_FILE));
  let outcome: RecordOutcome;
  if (!live.ok) {
    appendRecord(todayPath, {
      files: [LIVE_SESSION_FILE],
      key: live.key,
      kind: 'failed',
      reason: live.reason,
      recordedAt: now,
      schema: 1,
    });
    outcome = {file: live.file, kind: 'failed', reason: live.reason};
  } else {
    const todayRecords =
      store.days.find((day) => day.name === today)?.records ?? [];
    const newestFull = [...todayRecords]
      .reverse()
      .find((record): record is FullRecord => record.kind === 'hourly');
    if (
      newestFull?.fileVersion === live.tabSet.fileVersion &&
      rawKey(newestFull.windows) === rawKey(live.tabSet.windows)
    ) {
      appendRecord(todayPath, {
        fileCreatedAt: live.tabSet.fileCreatedAt,
        fileVersion: live.tabSet.fileVersion,
        files: [LIVE_SESSION_FILE],
        kind: 'unchanged',
        recordedAt: now,
        sameAs: newestFull.id,
        schema: 1,
      });
      outcome = {
        counts: newestFull.counts,
        fileCreatedAt: live.tabSet.fileCreatedAt,
        kind: 'unchanged',
      };
    } else {
      const prior = newestSetAtOrBefore(sets, live.tabSet.fileCreatedAt);
      const windows = carryForward(live.tabSet, prior);
      const record: FullRecord = {
        counts: countTabs(windows),
        fileCreatedAt: live.tabSet.fileCreatedAt,
        fileVersion: live.tabSet.fileVersion,
        files: [LIVE_SESSION_FILE],
        id: `hourly-${now}`,
        kind: 'hourly',
        recordedAt: now,
        schema: 1,
        windows,
      };
      appendRecord(todayPath, record);
      outcome = {
        counts: record.counts,
        fileCreatedAt: record.fileCreatedAt,
        kind: 'hourly',
      };
    }
  }

  // 3. Prune.
  const pruned = pruneStore(storeDir, now);
  return {
    exitCode: outcome.kind === 'failed' ? 1 : 0,
    launches: {
      alreadyRecorded,
      missing: launchFiles.missing,
      newlyRecorded,
      tooOld: launchFiles.tooOld,
      unrecognised,
    },
    live: outcome,
    pruned,
    storeDir,
    unreadableLines: store.unreadableLines,
  };
}
