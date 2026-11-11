/**
 * The transcript cache (home-base-9uzxw.11), end to end through `readInbox`
 * over committed synthetic transcripts (tests/fixtures/transcript-cache/, each
 * carrying the session's test data marker): a tracked session with two
 * subagents (a commit, a write, a helper waiting on its shell, a helper that
 * handed back) and an untracked session with one helper in flight.
 *
 * The inbox JSON is compared WHOLE, every field included (contextTokens and
 * the activity times too, which threads:perf has to leave out), with the
 * cache off, cold, warm in memory and warm from disk only.
 *
 * NEGATIVE CONTROLS: recorded in home-base-9uzxw.11's notes.
 */

import type {Sandbox} from './sandbox';

import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import {execFileSync} from 'child_process';
import {createHash} from 'crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import {tmpdir} from 'os';
import {dirname, join} from 'path';
import {isDeepStrictEqual} from 'util';

import {runBr} from '../src/beads/br';
import {messageLogPath} from '../src/thread/archive';
import {
  FILE_MEMO_KNOB,
  fileMemoSize,
  fileMemoStats,
  resetFileMemo,
} from '../src/thread/file-memo';
import {
  readMessageLogAt,
  serializeMessageLine,
} from '../src/thread/message-log';
import {ensureSessionBead} from '../src/thread/session-bead';
import {inboxJson, readInbox} from '../src/thread/session-inbox';
import {
  evictTranscriptCache,
  lastTranscriptEviction,
  resetTranscriptCacheMemory,
  TRANSCRIPT_CACHE_KNOB,
  TRANSCRIPT_CACHE_VERSION,
  transcriptCacheDir,
  transcriptCacheMark,
  transcriptCacheMemorySize,
  transcriptCacheStats,
  transcriptFileFacts,
} from '../src/thread/transcript-cache';
import {INCREMENTAL_READS_KNOB} from '../src/thread/transcript-fold';
import {git, initRepo} from './git-fixtures';
import {needBr} from './pinned-br';
import {createSandbox} from './sandbox';
import {
  FIXTURE_FILES,
  fixturePath,
  fixtureText,
  GOLDEN_PATH,
  goldenFacts,
  TRACKED_SID,
  UNTRACKED_SID,
} from './transcript-cache-fixtures';

const NOW = new Date('2030-01-01T12:00:00.000Z');

let sb: Sandbox;
let env: Record<string, string | undefined>;
let devRoot: string;
let repo: string;
let sessionBeadId: string;
const savedEnv = {
  cache: process.env.XDG_CACHE_HOME,
  fileKnob: process.env[FILE_MEMO_KNOB],
  knob: process.env[TRANSCRIPT_CACHE_KNOB],
};
/** Distinct, increasing modification times for each write the tests make. */
let mtimeStep = 0;

function pathOf(name: string): string {
  const file = FIXTURE_FILES.find((entry) => entry.name === name);
  if (file == null) throw new Error(`no fixture ${name}`);
  return fixturePath(join(sb.path, 'projects'), repo, file);
}

function touch(path: string): void {
  mtimeStep += 1;
  const at = new Date(NOW.getTime() - 3_600_000 + mtimeStep * 1000);
  utimesSync(path, at, at);
}

function commitAt(iso: string, message: string): string {
  writeFileSync(join(repo, `${message}.txt`), `${message}\n`);
  git(repo, ['add', '-A', '--', `${message}.txt`]);
  execFileSync('git', ['commit', '-qm', message], {
    cwd: repo,
    env: {...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso},
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return git(repo, ['rev-parse', '--short=7', 'HEAD']).trim();
}

/** The cache on, in a fresh (or the given) cache home, memory and counters cleared. */
function cacheOn(home?: string): string {
  const dir = home ?? mkdtempSync(join(tmpdir(), 'transcript-cache-test-'));
  process.env.XDG_CACHE_HOME = dir;
  delete process.env[TRANSCRIPT_CACHE_KNOB];
  delete process.env[FILE_MEMO_KNOB];
  resetTranscriptCacheMemory();
  resetFileMemo();
  return dir;
}

async function load(): Promise<string> {
  const result = await readInbox({
    cwd: repo,
    days: 30,
    devRoot,
    env,
    now: NOW,
    repo: null,
  });
  if (result.kind !== 'read') throw new Error(result.reason);
  return JSON.stringify(inboxJson(result.read));
}

/**
 * The inbox with the caches OFF (the transcript cache and the file memo): the
 * ground truth every cached load must equal.
 */
async function loadOff(): Promise<string> {
  const knob = process.env[TRANSCRIPT_CACHE_KNOB];
  const fileKnob = process.env[FILE_MEMO_KNOB];
  process.env[TRANSCRIPT_CACHE_KNOB] = 'off';
  process.env[FILE_MEMO_KNOB] = 'off';
  try {
    return await load();
  } finally {
    if (knob == null) delete process.env[TRANSCRIPT_CACHE_KNOB];
    else process.env[TRANSCRIPT_CACHE_KNOB] = knob;
    if (fileKnob == null) delete process.env[FILE_MEMO_KNOB];
    else process.env[FILE_MEMO_KNOB] = fileKnob;
  }
}

/**
 * home-base-9uzxw.16: the same load with incremental reads off, in a fresh
 * "process" (memory cleared): every grown transcript is read whole.
 */
async function loadIncrementalOff(): Promise<string> {
  const knob = process.env[INCREMENTAL_READS_KNOB];
  process.env[INCREMENTAL_READS_KNOB] = 'off';
  resetTranscriptCacheMemory();
  try {
    return await load();
  } finally {
    if (knob == null) delete process.env[INCREMENTAL_READS_KNOB];
    else process.env[INCREMENTAL_READS_KNOB] = knob;
  }
}

function record(value: object): string {
  return `${JSON.stringify(value)}\n`;
}

beforeAll(() => {
  needBr();
  sb = createSandbox();
  devRoot = join(sb.path, 'Dev');
  const xdg = join(sb.path, 'xdg');
  mkdirSync(join(xdg, 'justin-sdk'), {recursive: true});
  writeFileSync(
    join(xdg, 'justin-sdk', 'config.json'),
    JSON.stringify({
      componentConfig: {thread: {enabled: true, sessionBeads: true}},
    }),
  );
  env = {
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    JUSTIN_SDK_HEALTH_NOTICES: 'off',
    JUSTIN_THREADS_REPO_DIR: join(sb.path, 'threads'),
    JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state'),
    JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(sb.path, 'projects'),
    XDG_CONFIG_HOME: xdg,
  };
  repo = initRepo(sb, 'Dev/notes', {
    '.gitignore': '.claude/worktrees/\n',
    'README.md': '# notes\n',
  });
  const init = runBr(repo, ['init', '--prefix', 'tc', '-q']);
  if (!init.ok) throw new Error(`br init: ${init.reason ?? '?'}`);
  const sha = commitAt('2030-01-01T09:10:00Z', 'notes');
  // Uncommitted, and written by the tracked session: its write evidence is read.
  writeFileSync(join(repo, 'notes.md'), 'draft\n');
  for (const file of FIXTURE_FILES) {
    const path = fixturePath(join(sb.path, 'projects'), repo, file);
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(path, fixtureText(file.name, {cwd: repo, sha}));
    touch(path);
  }
  const filed = ensureSessionBead({
    cwd: repo,
    env: {...env, CLAUDE_CODE_SESSION_ID: TRACKED_SID},
    firstPrompt: {
      at: '2030-01-01T09:00:00.000Z',
      text: 'Build the release notes',
    },
    now: new Date('2030-01-01T09:00:00.000Z'),
    sessionId: TRACKED_SID,
  });
  if (filed.kind !== 'created') throw new Error(filed.detail);
  sessionBeadId = filed.beadId;
});

afterAll(() => {
  for (const name of FIXTURE_FILES.map((file) => file.name)) {
    try {
      chmodSync(pathOf(name), 0o644);
    } catch {
      // Already readable, or gone with the sandbox.
    }
  }
  sb.cleanup();
  if (savedEnv.cache == null) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = savedEnv.cache;
  if (savedEnv.knob == null) delete process.env[TRANSCRIPT_CACHE_KNOB];
  else process.env[TRANSCRIPT_CACHE_KNOB] = savedEnv.knob;
  if (savedEnv.fileKnob == null) delete process.env[FILE_MEMO_KNOB];
  else process.env[FILE_MEMO_KNOB] = savedEnv.fileKnob;
});

describe('the inbox JSON is identical with the cache off, cold, warm and warm from disk', () => {
  test('every field included, and the cached loads read no transcript once warm', async () => {
    const off = await loadOff();
    // The fields the cache feeds are really in the JSON (not all null): both
    // sessions, both context sizes, the tracked session's last activity, and
    // the untracked session's first message.
    expect(off).toContain(TRACKED_SID);
    expect(off).toContain(UNTRACKED_SID);
    expect(off).toContain('3012');
    expect(off).toContain('4020');
    expect(off).toContain('2030-01-01T09:20:00.000Z');
    expect(off).toContain('What does the importer do?');

    cacheOn();
    const cold = await load();
    const afterCold = transcriptCacheStats();
    expect(afterCold.fileReads).toBeGreaterThanOrEqual(FIXTURE_FILES.length);
    expect(afterCold.diskWrites).toBeGreaterThanOrEqual(FIXTURE_FILES.length);
    expect(afterCold.fallbacks).toBe(0);

    const warm = await load();
    const afterWarm = transcriptCacheStats();
    expect(afterWarm.fileReads).toBe(afterCold.fileReads);
    expect(afterWarm.memoryHits).toBeGreaterThan(afterCold.memoryHits);

    // A new process: nothing in memory, every entry from disk.
    resetTranscriptCacheMemory();
    const fromDisk = await load();
    const afterDisk = transcriptCacheStats();
    expect(afterDisk.fileReads).toBe(0);
    expect(afterDisk.diskHits).toBeGreaterThanOrEqual(FIXTURE_FILES.length);

    expect(cold).toBe(off);
    expect(warm).toBe(off);
    expect(fromDisk).toBe(off);
  });

  test(`${TRANSCRIPT_CACHE_KNOB}=off neither reads nor writes the cache`, async () => {
    const home = cacheOn();
    await loadOff();
    expect(transcriptCacheStats()).toEqual({
      diskHits: 0,
      diskIoErrors: 0,
      diskWrites: 0,
      fallbacks: 0,
      fileReadBytes: 0,
      fileReads: 0,
      foldReadBytes: 0,
      foldReads: 0,
      foldRefusals: 0,
      memoryHits: 0,
    });
    expect(() => readdirSync(join(home, 'justin-threads'))).toThrow();
  });
});

describe('a transcript that grows between loads shows on the next load', () => {
  test('main transcript, then a subagent transcript: each cached load equals the uncached one after the append', async () => {
    cacheOn();
    const before = await load();

    // 1. The main transcript gets a newer reply with a bigger context.
    const main = pathOf('tracked.jsonl');
    appendFileSync(
      main,
      record({
        cwd: repo,
        message: {
          content: [{text: 'Added the changelog.', type: 'text'}],
          role: 'assistant',
          usage: {
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 7000,
            input_tokens: 15,
          },
        },
        sessionId: TRACKED_SID,
        timestamp: '2030-01-01T09:50:00.000Z',
        type: 'assistant',
      }),
    );
    touch(main);
    const statsBeforeMain = transcriptCacheStats();
    const afterMain = await load();
    // home-base-9uzxw.16: the grown file was folded from its new line, not
    // read again whole.
    const statsAfterMain = transcriptCacheStats();
    expect(statsAfterMain.foldReads).toBeGreaterThan(statsBeforeMain.foldReads);
    expect(statsAfterMain.fileReads).toBe(statsBeforeMain.fileReads);
    expect(afterMain).not.toBe(before);
    expect(afterMain).toContain('7015');
    expect(afterMain).toBe(await loadOff());
    expect(afterMain).toBe(await loadIncrementalOff());

    // 2. A subagent commits: a new commit call and its result, newest record.
    const sha = commitAt('2030-01-01T09:56:00Z', 'second');
    const agent = pathOf('tracked.agent-p2.jsonl');
    appendFileSync(
      agent,
      record({
        cwd: repo,
        isSidechain: true,
        message: {
          content: [
            {
              id: 'toolu_c2',
              input: {command: "git commit -qm 'second'"},
              name: 'Bash',
              type: 'tool_use',
            },
          ],
          role: 'assistant',
        },
        sessionId: TRACKED_SID,
        timestamp: '2030-01-01T09:55:59.000Z',
        type: 'assistant',
      }) +
        record({
          cwd: repo,
          isSidechain: true,
          message: {
            content: [
              {
                content: `[main ${sha}] second`,
                tool_use_id: 'toolu_c2',
                type: 'tool_result',
              },
            ],
            role: 'user',
          },
          sessionId: TRACKED_SID,
          timestamp: '2030-01-01T09:56:01.000Z',
          type: 'user',
        }),
    );
    touch(agent);
    const statsBeforeAgent = transcriptCacheStats();
    const afterAgent = await load();
    const statsAfterAgent = transcriptCacheStats();
    expect(statsAfterAgent.foldReads).toBeGreaterThan(
      statsBeforeAgent.foldReads,
    );
    expect(statsAfterAgent.fileReads).toBe(statsBeforeAgent.fileReads);
    expect(afterAgent).not.toBe(afterMain);
    expect(afterAgent).toContain('2030-01-01T09:56:01.000Z');
    expect(afterAgent).toBe(await loadOff());
    expect(afterAgent).toBe(await loadIncrementalOff());
  });
});

describe('failures: the cache is never a reason for a different answer (critical rule 7)', () => {
  test('an unreadable transcript is reported as the uncached reader reports it, never cached, and read again once readable', async () => {
    cacheOn();
    await load();
    const agent = pathOf('tracked.agent-p1.jsonl');
    chmodSync(agent, 0o000);
    try {
      const cached = await load();
      expect(cached).toContain('could not');
      expect(cached).toBe(await loadOff());
    } finally {
      chmodSync(agent, 0o644);
    }
    const again = await load();
    expect(again).not.toContain(`could not read ${agent}`);
    expect(again).toBe(await loadOff());
  });

  test('a cache home that is a file (no directory can be made) gives the same output and does not throw', async () => {
    const notADir = join(sb.path, 'cache-home-is-a-file');
    writeFileSync(notADir, 'not a directory\n');
    cacheOn(notADir);
    const cached = await load();
    const stats = transcriptCacheStats();
    expect(stats.diskWrites).toBe(0);
    expect(stats.diskIoErrors).toBeGreaterThan(0);
    expect(cached).toBe(await loadOff());
  });

  test('a cache directory that cannot be written gives the same output and does not throw', async () => {
    const home = cacheOn();
    const dir = transcriptCacheDir();
    mkdirSync(dir, {recursive: true});
    chmodSync(dir, 0o555);
    try {
      const cached = await load();
      const stats = transcriptCacheStats();
      expect(stats.diskWrites).toBe(0);
      expect(stats.diskIoErrors).toBeGreaterThan(0);
      expect(cached).toBe(await loadOff());
    } finally {
      chmodSync(dir, 0o755);
    }
    expect(home).not.toBe('');
  });

  test('a corrupt entry on disk is ignored and rebuilt', async () => {
    const home = cacheOn();
    await load();
    const dir = transcriptCacheDir();
    const entries = readdirSync(dir).filter((name) => name.endsWith('.json'));
    expect(entries.length).toBeGreaterThanOrEqual(FIXTURE_FILES.length);
    for (const name of entries) writeFileSync(join(dir, name), '{not json');
    cacheOn(home);
    const cached = await load();
    const stats = transcriptCacheStats();
    expect(stats.diskHits).toBe(0);
    expect(stats.diskWrites).toBeGreaterThanOrEqual(FIXTURE_FILES.length);
    expect(cached).toBe(await loadOff());
    for (const name of entries) {
      expect(() => {
        JSON.parse(readFileSync(join(dir, name), 'utf8'));
      }).not.toThrow();
    }
  });
});

describe('the golden fixture pins the parser version', () => {
  test('every cached parser gives the recorded output, under this TRANSCRIPT_CACHE_VERSION', () => {
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as {
      facts: unknown;
      version: number;
    };
    const facts = goldenFacts();
    const verdict = isDeepStrictEqual(facts, golden.facts)
      ? 'same output'
      : `a cached parser's output changed: bump TRANSCRIPT_CACHE_VERSION in src/thread/transcript-cache.ts, then run bun scripts/transcript-cache-golden.ts --update`;
    expect(verdict).toBe('same output');
    expect(golden.version).toBe(TRANSCRIPT_CACHE_VERSION);
    expect(facts).toEqual(golden.facts as typeof facts);
  });
});

// ---------------------------------------------------------------------------
// home-base-9uzxw.12 and home-base-9uzxw.14
// ---------------------------------------------------------------------------

const MARKER = '[TEST_DATA_DELETABLE 9b0eb49b-f4dd-43f5-93e5-f6e6f3de4ef9 ]';

function entryNameOf(path: string): string {
  return `${createHash('sha256').update(path).digest('hex').slice(0, 40)}.json`;
}

/** A transcript cache entry naming `path`, laid out as the cache writes one. */
function writeEntryFor(dir: string, path: string, name?: string): string {
  mkdirSync(dir, {recursive: true});
  const file = join(dir, name ?? entryNameOf(path));
  writeFileSync(
    file,
    JSON.stringify({
      facts: {marker: MARKER},
      path,
      size: 1,
      stamp: '1/1',
      version: TRANSCRIPT_CACHE_VERSION,
    }),
  );
  return file;
}

/** A transcript outside the inbox's directories, last modified `daysAgo` before NOW. */
function looseTranscript(name: string, daysAgo: number): string {
  const path = join(sb.path, 'loose', `${name}.jsonl`);
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, record({marker: MARKER, type: 'summary'}));
  const at = new Date(NOW.getTime() - daysAgo * 86_400_000);
  utimesSync(path, at, at);
  return path;
}

/**
 * A prompt in the tracked session's message log. No test data marker here: the
 * inbox moves a session whose messages carry it out of the list (to
 * `testSessions`), which would hide the very changes these tests look for. The
 * log lives in the test's temporary state directory.
 */
function appendTrackedLog(at: string, text: string): void {
  const path = messageLogPath(TRACKED_SID, env);
  mkdirSync(dirname(path), {recursive: true});
  appendFileSync(
    path,
    serializeMessageLine({
      at,
      cwd: repo,
      event: 'UserPromptSubmit',
      role: 'user',
      text,
    }),
  );
  touch(path);
}

describe('the file memo: beads exports, message logs and the sessions index (home-base-9uzxw.12)', () => {
  test('the inbox JSON is identical with the memo off, cold and warm, and a warm load reads none of those files', async () => {
    appendTrackedLog('2030-01-01T09:00:00.000Z', 'Build the release notes');
    const off = await loadOff();
    cacheOn();
    const cold = await load();
    const afterCold = fileMemoStats();
    // The export, the message log and the sessions index, at least. (A file
    // that does not exist, such as the old reports' export here, is a
    // fallback each time: never cached.)
    expect(afterCold.reads).toBeGreaterThanOrEqual(3);
    const warm = await load();
    const afterWarm = fileMemoStats();
    expect(afterWarm.reads).toBe(afterCold.reads);
    expect(afterWarm.hits).toBeGreaterThan(afterCold.hits);
    expect(cold).toBe(off);
    expect(warm).toBe(off);
  });

  test('a changed beads export shows on the next load', async () => {
    cacheOn();
    const before = await load();
    expect(before).not.toContain('Renamed release notes');
    const renamed = runBr(repo, [
      'update',
      sessionBeadId,
      '--title',
      `Renamed release notes ${MARKER}`,
    ]);
    if (!renamed.ok) throw new Error(`br update: ${renamed.reason ?? '?'}`);
    const after = await load();
    expect(after).not.toBe(before);
    expect(after).toContain('Renamed release notes');
    expect(after).toBe(await loadOff());
  });

  test('a message log that grows shows on the next load', async () => {
    cacheOn();
    const before = await load();
    appendTrackedLog('2030-01-01T11:45:00.000Z', 'Add a changelog too');
    const after = await load();
    expect(after).not.toBe(before);
    expect(after).toBe(await loadOff());
  });

  test('a rewrite of the same size is read again, a missing file is never cached, and a shared value cannot be changed', () => {
    cacheOn();
    const path = join(sb.path, 'loose', 'memo-probe.jsonl');
    mkdirSync(dirname(path), {recursive: true});
    const line = (text: string) =>
      serializeMessageLine({
        at: '2030-01-01T10:00:00.000Z',
        cwd: null,
        event: 'UserPromptSubmit',
        role: 'user',
        text: `${text} ${MARKER}`,
      });
    writeFileSync(path, line('alpha'));
    touch(path);
    const first = readMessageLogAt(path);
    if (first.kind !== 'read') throw new Error(first.kind);
    expect(first.lines[0]?.text).toStartWith('alpha');
    // The types are read-only now (home-base-hg6lz.4 F1), so the attempts go
    // through Reflect, which reports a refused write as false instead of
    // throwing: one new line, one changed field.
    expect(
      Reflect.set(first.lines, first.lines.length, {
        at: null,
        cwd: null,
        event: 'backfill',
        role: 'user',
        text: 'changed',
      }),
    ).toBe(false);
    expect(Reflect.set(first.lines[0] ?? {}, 'text', 'changed')).toBe(false);
    expect(first.lines).toHaveLength(1);
    expect(first.lines[0]?.text).toStartWith('alpha');
    writeFileSync(path, line('bravo'));
    touch(path);
    const second = readMessageLogAt(path);
    if (second.kind !== 'read') throw new Error(second.kind);
    expect(second.lines[0]?.text).toStartWith('bravo');
    rmSync(path);
    expect(readMessageLogAt(path).kind).toBe('missing');
    expect(readMessageLogAt(path).kind).toBe('missing');
    expect(fileMemoStats().fallbacks).toBe(2);
  });

  test('after a load, both caches hold only what it used (home-base-9uzxw.14)', async () => {
    cacheOn();
    await load();
    const transcripts = transcriptCacheMemorySize();
    const files = fileMemoSize();
    expect(transcripts).toBeGreaterThanOrEqual(FIXTURE_FILES.length);
    // A transcript and a log the inbox never asks for.
    const extraLog = join(sb.path, 'loose', 'extra-log.jsonl');
    writeFileSync(
      extraLog,
      serializeMessageLine({
        at: '2030-01-01T10:00:00.000Z',
        cwd: null,
        event: 'UserPromptSubmit',
        role: 'user',
        text: MARKER,
      }),
    );
    expect(readMessageLogAt(extraLog).kind).toBe('read');
    expect(transcriptFileFacts(looseTranscript('extra', 1))).not.toBeNull();
    expect(transcriptCacheMemorySize()).toBe(transcripts + 1);
    expect(fileMemoSize()).toBe(files + 1);
    await load();
    expect(transcriptCacheMemorySize()).toBe(transcripts);
    expect(fileMemoSize()).toBe(files);
  });
});

describe('eviction of disk entries (home-base-9uzxw.14)', () => {
  test('after a load, entries for a deleted transcript and an old unused one are gone; entries in use, in-window entries and every other file stay', async () => {
    cacheOn();
    await load();
    const dir = transcriptCacheDir();
    const root = dirname(dir);
    const inUse = FIXTURE_FILES.map((file) =>
      join(dir, entryNameOf(pathOf(file.name))),
    );
    for (const file of inUse) expect(existsSync(file)).toBe(true);
    // The first load ran a pass; this test needs another.
    rmSync(join(dir, '.last-eviction'));

    const gonePath = join(sb.path, 'loose', 'never-existed.jsonl');
    const goneEntry = writeEntryFor(dir, gonePath);
    const oldTranscript = looseTranscript('old', 60);
    const oldEntry = writeEntryFor(dir, oldTranscript);
    const recentEntry = writeEntryFor(dir, looseTranscript('recent', 1));
    // Not entries by name: left alone whatever they hold.
    const notes = join(dir, 'notes.txt');
    writeFileSync(notes, MARKER);
    const strayCopy = writeEntryFor(dir, gonePath, 'stray-copy.json');
    const tempFile = writeEntryFor(
      dir,
      gonePath,
      `${entryNameOf(gonePath)}.123.abc.tmp`,
    );
    // An older version: its entries go, anything else stays, and so does the
    // directory; an older one holding only entries goes whole.
    const older = join(root, 'v0');
    const olderEntry = writeEntryFor(older, gonePath);
    const olderKeep = join(older, 'keep.txt');
    writeFileSync(olderKeep, MARKER);
    const olderOnlyEntries = join(root, 'v00');
    writeEntryFor(olderOnlyEntries, gonePath);
    // A newer version is never touched.
    const newerEntry = writeEntryFor(
      join(root, `v${TRANSCRIPT_CACHE_VERSION + 1}`),
      gonePath,
    );

    const out = await load();
    const eviction = lastTranscriptEviction();
    expect(eviction).toMatchObject({
      kind: 'ran',
      olderVersionRemoved: 2,
      removeFailures: 0,
      removed: 2,
    });
    expect(existsSync(goneEntry)).toBe(false);
    expect(existsSync(oldEntry)).toBe(false);
    // Eviction removes the cache entry only, never the transcript it describes
    // (home-base-hg6lz.4 F2).
    expect(existsSync(oldTranscript)).toBe(true);
    expect(existsSync(olderEntry)).toBe(false);
    expect(existsSync(olderOnlyEntries)).toBe(false);
    expect(existsSync(recentEntry)).toBe(true);
    for (const file of inUse) expect(existsSync(file)).toBe(true);
    for (const file of [notes, strayCopy, tempFile, olderKeep, newerEntry]) {
      expect(existsSync(file)).toBe(true);
    }
    expect(out).toBe(await loadOff());
  });

  test('an old transcript the last load used keeps its entry; unused since, it goes', () => {
    cacheOn();
    const oldPath = looseTranscript('old-but-used', 60);
    const mark = transcriptCacheMark();
    expect(transcriptFileFacts(oldPath)).not.toBeNull();
    const entry = join(transcriptCacheDir(), entryNameOf(oldPath));
    expect(existsSync(entry)).toBe(true);
    expect(
      evictTranscriptCache({
        intervalMs: 0,
        now: NOW,
        usedSince: mark,
        windowDays: 30,
      }),
    ).toMatchObject({kept: 1, kind: 'ran', removed: 0});
    expect(existsSync(entry)).toBe(true);
    expect(
      evictTranscriptCache({
        intervalMs: 0,
        now: NOW,
        usedSince: transcriptCacheMark(),
        windowDays: 30,
      }),
    ).toMatchObject({kind: 'ran', removed: 1});
    expect(existsSync(entry)).toBe(false);
  });

  test('a pass runs at most once per interval', () => {
    cacheOn();
    transcriptFileFacts(looseTranscript('interval', 1));
    const first = evictTranscriptCache({
      now: NOW,
      usedSince: 0,
      windowDays: 30,
    });
    expect(first.kind).toBe('ran');
    const second = evictTranscriptCache({
      now: NOW,
      usedSince: 0,
      windowDays: 30,
    });
    expect(second).toMatchObject({
      kind: 'skipped',
      reason: 'an eviction ran recently',
    });
  });

  test('a removal that fails (read-only directories) changes no output and does not throw', async () => {
    cacheOn();
    const off = await loadOff();
    await load();
    const dir = transcriptCacheDir();
    rmSync(join(dir, '.last-eviction'));
    const older = join(dirname(dir), 'v0');
    const olderEntry = writeEntryFor(
      older,
      join(sb.path, 'loose', 'never-existed.jsonl'),
    );
    chmodSync(older, 0o555);
    try {
      const out = await load();
      expect(lastTranscriptEviction()).toMatchObject({
        kind: 'ran',
        removeFailures: 1,
      });
      expect(existsSync(olderEntry)).toBe(true);
      expect(out).toBe(off);
      // The cache's own directory read-only: the pass cannot record itself,
      // so it does not run; the load is unchanged.
      rmSync(join(dir, '.last-eviction'));
      chmodSync(dir, 0o555);
      const outReadOnly = await load();
      expect(lastTranscriptEviction()?.kind).toBe('skipped');
      expect(outReadOnly).toBe(off);
    } finally {
      chmodSync(older, 0o755);
      chmodSync(dir, 0o755);
    }
  });
});
