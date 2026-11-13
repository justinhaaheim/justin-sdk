/**
 * Private sessions never reach the threads repo (home-base-bj5xm).
 *
 * Every test runs against the STATEFUL FAKE bd (tests/fake-bd.ts) in a scratch
 * workspace, with the threads state dir, the transcripts root and the user
 * config (XDG_CONFIG_HOME) all under $TMPDIR. Nothing here reads or writes the
 * real ~/Dev/threads, ~/.local/state/justin-threads or ~/.config.
 *
 * The proof that nothing reached the threads repo is the fake's own command
 * log: bd is the only way in, and every command the SDK issues lands there
 * before the fake acts on it. "No write" is asserted as "no write command in
 * the log", and each writer has a NEGATIVE CONTROL beside it: the same call for
 * a public session, which must write.
 *
 * The fixture text is generic on purpose: home-base is pushed to GitHub.
 */

import type {ArchivedReport} from '../src/thread/archive';
import type {ThreadFacts} from '../src/thread/facts';
import type {FakeBd, FakeIssue} from './fake-bd';

import {afterEach, describe, expect, spyOn, test} from 'bun:test';
import {existsSync, mkdirSync, mkdtempSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {bdWriter} from '../src/thread/answer';
import {messageLogPath, spoolReport} from '../src/thread/archive';
import {backfillThreads} from '../src/thread/backfill';
import {
  addComment,
  bdContext,
  closeAsk,
  closeIssue,
  createAsk,
  createThread,
  finalizeThread,
  isReadOnlyBdCommand,
  mergeMetadata,
  reopenIssue,
  reparentIssue,
  setIssueDescription,
  setThreadInProgress,
  updateThread,
  updateThreadBody,
  type WriteOwner,
} from '../src/thread/bd';
import {applyCapture, captureRunRecord} from '../src/thread/capture';
import {runThreadDone} from '../src/thread/done';
import {drainSpool} from '../src/thread/drain';
import {appendMessageLine, readMessageLog} from '../src/thread/message-log';
import {
  markSessionPrivate,
  ownerOf,
  ownerOfMetadata,
  pathInside,
  privateMarkPath,
  readPrivateRepos,
  runThreadPrivate,
  sessionPrivacy,
} from '../src/thread/privacy';
import {writeReportToBd} from '../src/thread/report';
import {
  THREAD_SCHEMA_VERSION,
  validateThreadReport,
} from '../src/thread/schema';
import {projectDirSlug} from '../src/thread/transcript-messages';
import {createFakeBd} from './fake-bd';
import {examplePayload} from './thread-schema.test';

const PRIVATE_SESSION = 'aaaaaaaa-1111-4111-8111-000000000001';
const PUBLIC_SESSION = 'bbbbbbbb-2222-4222-8222-000000000002';
const DAY = 86_400_000;

/** The bd subcommands that change something, as the fake logs them. */
const WRITE_PREFIXES = ['create', 'update', 'close', 'reopen', 'comments add'];

interface Harness {
  env: Record<string, string | undefined>;
  fake: FakeBd;
  home: string;
  /** The private repo, as listed in the user config. */
  life: string;
  /** A worktree inside it: private by path prefix. */
  lifeWorktree: string;
  /** `<home>/Dev/lifestyle`: shares the private repo's name as a PREFIX. */
  neighbour: string;
  projects: string;
  root: string;
  xdg: string;
}

/**
 * `config` is what the user config file holds: an object (written as JSON),
 * the string 'not-json' (written as is), or null for no file at all. Default:
 * the private repo listed by absolute path.
 */
function harness(
  config: null | Record<string, unknown> | 'not-json' | undefined = undefined,
): Harness {
  const fake = createFakeBd();
  const root = mkdtempSync(join(tmpdir(), 'thread-private-'));
  const home = join(root, 'home');
  const life = join(home, 'Dev', 'life');
  const lifeWorktree = join(life, '.claude', 'worktrees', 'some-branch');
  const neighbour = join(home, 'Dev', 'lifestyle');
  const projects = join(root, 'projects');
  const xdg = join(root, 'xdg');
  for (const dir of [
    lifeWorktree,
    neighbour,
    projects,
    join(xdg, 'justin-sdk'),
  ]) {
    mkdirSync(dir, {recursive: true});
  }
  const configPath = join(xdg, 'justin-sdk', 'config.json');
  const written =
    config === undefined
      ? {componentConfig: {thread: {autoCommit: false, privateRepos: [life]}}}
      : config;
  if (written === 'not-json') writeFileSync(configPath, '{ this is not json');
  else if (written != null) writeFileSync(configPath, JSON.stringify(written));
  return {
    env: {
      ...fake.env,
      JUSTIN_THREADS_REPO_DIR: fake.dir,
      JUSTIN_THREADS_STATE_DIR: join(root, 'state'),
      JUSTIN_THREADS_TRANSCRIPTS_ROOT: projects,
      XDG_CONFIG_HOME: xdg,
    },
    fake,
    home,
    life,
    lifeWorktree,
    neighbour,
    projects,
    root,
    xdg,
  };
}

function bdLog(h: Harness): string[] {
  return h.fake.read().log;
}

function writesIn(h: Harness): string[] {
  return bdLog(h).filter((line) =>
    WRITE_PREFIXES.some((prefix) => line.startsWith(prefix)),
  );
}

function seedIssues(h: Harness, issues: FakeIssue[]): void {
  const state = h.fake.read();
  state.issues = issues;
  state.log = [];
  h.fake.write(state);
}

const spies: {mockRestore: () => void}[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

function silence(): void {
  spies.push(spyOn(console, 'log').mockImplementation(() => undefined));
  spies.push(spyOn(console, 'error').mockImplementation(() => undefined));
}

// ---------------------------------------------------------------------------
// The decision (D1, D3)
// ---------------------------------------------------------------------------

describe('the privacy decision (D1, D3)', () => {
  test('a cwd inside a listed repo, or a worktree under it, is private; a prefix neighbour is not', () => {
    const h = harness();
    expect(sessionPrivacy(ownerOf(PRIVATE_SESSION, [h.life]), h.env).kind).toBe(
      'private',
    );
    const inWorktree = sessionPrivacy(
      ownerOf(PRIVATE_SESSION, [h.lifeWorktree]),
      h.env,
    );
    expect(inWorktree.kind).toBe('private');
    if (inWorktree.kind === 'private') {
      expect(inWorktree.reason).toContain('privateRepos');
    }
    // NEGATIVE CONTROL: `lifestyle` starts with `life` but is not inside it.
    expect(
      sessionPrivacy(ownerOf(PUBLIC_SESSION, [h.neighbour]), h.env).kind,
    ).toBe('public');
  });

  test('a checkout that no longer exists still matches by path', () => {
    const h = harness();
    const gone = join(h.life, '.claude', 'worktrees', 'deleted-long-ago');
    expect(existsSync(gone)).toBe(false);
    expect(sessionPrivacy(ownerOf(PRIVATE_SESSION, [gone]), h.env).kind).toBe(
      'private',
    );
  });

  test('~ in privateRepos expands against HOME', () => {
    const h = harness({
      componentConfig: {thread: {privateRepos: ['~/Dev/life']}},
    });
    const env = {...h.env, HOME: h.home};
    const read = readPrivateRepos(env);
    expect(read).toEqual({
      kind: 'read',
      path: join(h.xdg, 'justin-sdk', 'config.json'),
      repos: [h.life],
    });
    expect(
      sessionPrivacy(ownerOf(PRIVATE_SESSION, [h.lifeWorktree]), env).kind,
    ).toBe('private');
  });

  test('a missing user config means no repo is private', () => {
    const h = harness(null);
    expect(readPrivateRepos(h.env).kind).toBe('read');
    expect(
      sessionPrivacy(ownerOf(PUBLIC_SESSION, [h.lifeWorktree]), h.env).kind,
    ).toBe('public');
  });

  test('a user config that is not JSON makes EVERY session private, naming the file', () => {
    const h = harness('not-json');
    const verdict = sessionPrivacy(
      ownerOf(PUBLIC_SESSION, [h.neighbour]),
      h.env,
    );
    expect(verdict.kind).toBe('private');
    if (verdict.kind === 'private') {
      expect(verdict.reason).toContain(
        join(h.xdg, 'justin-sdk', 'config.json'),
      );
      expect(verdict.reason).toContain('not valid JSON');
    }
  });

  test('a privateRepos that breaks the schema makes every session private', () => {
    const h = harness({
      componentConfig: {thread: {privateRepos: '~/Dev/life'}},
    });
    const verdict = sessionPrivacy(
      ownerOf(PUBLIC_SESSION, [h.neighbour]),
      h.env,
    );
    expect(verdict.kind).toBe('private');
    if (verdict.kind === 'private') expect(verdict.reason).toContain('schema');
  });

  test('a relative privateRepos entry makes every session private', () => {
    const h = harness({
      componentConfig: {thread: {privateRepos: ['Dev/life']}},
    });
    const verdict = sessionPrivacy(
      ownerOf(PUBLIC_SESSION, [h.neighbour]),
      h.env,
    );
    expect(verdict.kind).toBe('private');
    if (verdict.kind === 'private')
      expect(verdict.reason).toContain('Dev/life');
  });

  test('no cwd, a relative cwd, or no session id cannot be told apart from private', () => {
    const h = harness();
    expect(sessionPrivacy(ownerOf(PUBLIC_SESSION, []), h.env).kind).toBe(
      'private',
    );
    expect(sessionPrivacy(ownerOf(PUBLIC_SESSION, [null]), h.env).kind).toBe(
      'private',
    );
    expect(
      sessionPrivacy(ownerOf(PUBLIC_SESSION, ['Dev/somewhere']), h.env).kind,
    ).toBe('private');
    expect(sessionPrivacy(ownerOf(null, [h.neighbour]), h.env).kind).toBe(
      'private',
    );
    // NEGATIVE CONTROL: the same public session WITH a cwd is public.
    expect(
      sessionPrivacy(ownerOf(PUBLIC_SESSION, [h.neighbour]), h.env).kind,
    ).toBe('public');
  });

  test('pathInside: case-insensitive, trailing slash tolerated, on a path boundary', () => {
    expect(pathInside('/Users/x/Dev/Life/sub', '/Users/x/Dev/life')).toBe(true);
    expect(pathInside('/Users/x/Dev/life', '/Users/x/Dev/life/')).toBe(true);
    expect(pathInside('/Users/x/Dev/lifestyle', '/Users/x/Dev/life')).toBe(
      false,
    );
    expect(pathInside('/Users/x/Dev', '/Users/x/Dev/life')).toBe(false);
  });

  test('ownerOfMetadata reads the session and every recorded directory', () => {
    expect(
      ownerOfMetadata({
        cwd: '/a',
        repoPath: '/b',
        sessionId: PUBLIC_SESSION,
        worktreePath: null,
      }),
    ).toEqual({cwds: ['/a', '/b'], sessionId: PUBLIC_SESSION});
    expect(ownerOfMetadata(undefined)).toEqual({cwds: [], sessionId: null});
  });
});

describe('thread private (D1, option a of home-base-sg9q9.4)', () => {
  test('marks the session in local state; private from then on; a second run is a no-op', () => {
    const h = harness();
    silence();
    const owner = ownerOf(PUBLIC_SESSION, [h.neighbour]);
    // NEGATIVE CONTROL first: unmarked, the session is public.
    expect(sessionPrivacy(owner, h.env).kind).toBe('public');

    expect(runThreadPrivate({env: h.env, sessionId: PUBLIC_SESSION})).toBe(0);
    expect(existsSync(privateMarkPath(PUBLIC_SESSION, h.env))).toBe(true);
    expect(privateMarkPath(PUBLIC_SESSION, h.env).startsWith(h.root)).toBe(
      true,
    );
    const verdict = sessionPrivacy(owner, h.env);
    expect(verdict.kind).toBe('private');
    if (verdict.kind === 'private') expect(verdict.reason).toContain('marked');

    expect(markSessionPrivate(PUBLIC_SESSION, h.env).kind).toBe('already');
    expect(runThreadPrivate({env: h.env, sessionId: PUBLIC_SESSION})).toBe(0);
  });

  test('takes the session from CLAUDE_CODE_SESSION_ID, and exits 2 with none', () => {
    const h = harness();
    silence();
    expect(
      runThreadPrivate({
        env: {...h.env, CLAUDE_CODE_SESSION_ID: PRIVATE_SESSION},
      }),
    ).toBe(0);
    expect(existsSync(privateMarkPath(PRIVATE_SESSION, h.env))).toBe(true);
    expect(
      runThreadPrivate({env: {...h.env, CLAUDE_CODE_SESSION_ID: ''}}),
    ).toBe(2);
  });

  test('--check changes nothing', () => {
    const h = harness();
    silence();
    expect(
      runThreadPrivate({
        check: true,
        cwd: h.neighbour,
        env: h.env,
        sessionId: PUBLIC_SESSION,
      }),
    ).toBe(0);
    expect(existsSync(privateMarkPath(PUBLIC_SESSION, h.env))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The shared write layer (D2)
// ---------------------------------------------------------------------------

/** Every write function the adapter exports, called once each. */
async function everyWrite(
  h: Harness,
  owner: WriteOwner,
  id: string,
): Promise<[string, {failure?: {kind: string}; ok: boolean}][]> {
  const ctx = bdContext(h.env);
  const fields = {
    description: 'a description',
    metadata: {sessionId: owner.sessionId},
    notes: 'some notes',
    title: 'a title',
  };
  return [
    ['createThread', await createThread(ctx, owner, fields)],
    ['updateThread', await updateThread(ctx, owner, id, fields)],
    ['updateThreadBody', await updateThreadBody(ctx, owner, id, fields)],
    ['finalizeThread', await finalizeThread(ctx, owner, id, 'notes', {})],
    ['setThreadInProgress', await setThreadInProgress(ctx, owner, id)],
    [
      'createAsk',
      await createAsk(ctx, owner, id, {
        description: 'an ask',
        metadata: {},
        priority: 3,
        title: 'a question',
      }),
    ],
    ['closeAsk', await closeAsk(ctx, owner, `${id}.1`, 'done')],
    ['addComment', await addComment(ctx, owner, id, 'an answer')],
    ['mergeMetadata', await mergeMetadata(ctx, owner, id, {k: 'v'})],
    ['setIssueDescription', await setIssueDescription(ctx, owner, id, 'd')],
    ['reparentIssue', await reparentIssue(ctx, owner, `${id}.1`, id)],
    ['closeIssue', await closeIssue(ctx, owner, id, 'done')],
    ['reopenIssue', await reopenIssue(ctx, owner, id, 'again')],
  ];
}

describe('the bd adapter refuses every write of a private session (D2)', () => {
  test('all thirteen write functions refuse, and bd is never run', async () => {
    const h = harness();
    seedIssues(h, [
      {id: 'jl-t9', metadata: {}, status: 'open', title: 't', type: 'thread'},
    ]);
    const results = await everyWrite(
      h,
      ownerOf(PRIVATE_SESSION, [h.lifeWorktree]),
      'jl-t9',
    );
    expect(results).toHaveLength(13);
    for (const [name, result] of results) {
      expect({name, ok: result.ok}).toEqual({name, ok: false});
      expect({kind: result.failure?.kind, name}).toEqual({
        kind: 'private',
        name,
      });
    }
    expect(bdLog(h)).toEqual([]);
  });

  test('NEGATIVE CONTROL: the same writes for a public session reach bd', async () => {
    const h = harness();
    seedIssues(h, [
      {id: 'jl-t9', metadata: {}, status: 'open', title: 't', type: 'thread'},
    ]);
    const results = await everyWrite(
      h,
      ownerOf(PUBLIC_SESSION, [h.neighbour]),
      'jl-t9',
    );
    for (const [name, result] of results) {
      expect({kind: result.failure?.kind ?? 'none', name}).not.toEqual({
        kind: 'private',
        name,
      });
    }
    // The fake does not implement `reopen` (it exits before saving its log),
    // so twelve of the thirteen are on record.
    expect(writesIn(h).length).toBeGreaterThanOrEqual(12);
  });

  test('a refusal names the subcommand only, never the text it carried', async () => {
    const h = harness();
    const result = await createThread(
      bdContext(h.env),
      ownerOf(PRIVATE_SESSION, [h.life]),
      {
        description: 'SECRET-DESCRIPTION',
        metadata: {},
        notes: 'SECRET-NOTES',
        title: 'SECRET-TITLE',
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.command).toBe('bd create');
    expect(JSON.stringify(result.failure)).not.toContain('SECRET');
  });

  test('reads are an allow-list: anything else counts as a write', () => {
    for (const read of [
      ['list', '-t', 'thread'],
      ['show', 'x'],
      ['types'],
      ['comments', 'x', '--json'],
    ]) {
      expect({args: read, read: isReadOnlyBdCommand(read)}).toEqual({
        args: read,
        read: true,
      });
    }
    for (const write of [
      ['create', 't'],
      ['update', 'x'],
      ['close', 'x'],
      ['reopen', 'x'],
      ['comments', 'add', 'x', 'y'],
      ['delete', 'x'],
      ['some-future-subcommand'],
      [],
    ]) {
      expect({args: write, read: isReadOnlyBdCommand(write)}).toEqual({
        args: write,
        read: false,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Each writer
// ---------------------------------------------------------------------------

function logLine(h: Harness, sessionId: string, cwd: string): void {
  const appended = appendMessageLine(messageLogPath(sessionId, h.env), {
    at: new Date('2026-11-13T10:00:00.000Z').toISOString(),
    cwd,
    event: 'UserPromptSubmit',
    role: 'user',
    text: 'an ordinary message',
  });
  if (appended.kind === 'failed') throw new Error(appended.error);
}

describe('thread capture', () => {
  test('a session in a private repo gets no thread bead; its message stays in the local log', async () => {
    const h = harness();
    logLine(h, PRIVATE_SESSION, h.lifeWorktree);
    const outcome = await applyCapture({
      autoCommit: false,
      cwd: h.lifeWorktree,
      env: h.env,
      sessionId: PRIVATE_SESSION,
    });
    if (outcome.kind !== 'ran') throw new Error(`deferred: ${outcome.kind}`);
    expect(outcome.last.kind).toBe('private');
    expect(outcome.commit).toBeNull();
    expect(bdLog(h)).toEqual([]);
    expect(h.fake.read().issues).toEqual([]);
    // D4: the message is kept, locally.
    const log = readMessageLog(PRIVATE_SESSION, h.env);
    expect(log.kind === 'read' ? log.lines.length : -1).toBe(1);
    // D3: the skip is logged with its reason in capture.jsonl's record.
    const record = captureRunRecord(PRIVATE_SESSION, outcome, 1, new Date());
    expect(record.outcome).toBe('private');
    expect(String(record.private)).toContain('privateRepos');
  });

  test('NEGATIVE CONTROL: a public session gets its thread bead', async () => {
    const h = harness();
    logLine(h, PUBLIC_SESSION, h.neighbour);
    const outcome = await applyCapture({
      autoCommit: false,
      cwd: h.neighbour,
      env: h.env,
      sessionId: PUBLIC_SESSION,
    });
    if (outcome.kind !== 'ran') throw new Error(`deferred: ${outcome.kind}`);
    expect(outcome.last.kind).toBe('applied');
    expect(h.fake.read().issues.map((i) => i.metadata?.sessionId)).toEqual([
      PUBLIC_SESSION,
    ]);
  });

  test('a session marked with `thread private` stops reaching bd, wherever it runs', async () => {
    const h = harness();
    logLine(h, PUBLIC_SESSION, h.neighbour);
    expect(markSessionPrivate(PUBLIC_SESSION, h.env).kind).toBe('marked');
    const outcome = await applyCapture({
      autoCommit: false,
      cwd: h.neighbour,
      env: h.env,
      sessionId: PUBLIC_SESSION,
    });
    if (outcome.kind !== 'ran') throw new Error(`deferred: ${outcome.kind}`);
    expect(outcome.last.kind).toBe('private');
    expect(bdLog(h)).toEqual([]);
  });
});

function userRecord(
  sessionId: string,
  cwd: string | null,
  text: string,
  at: Date,
): Record<string, unknown> {
  return {
    ...(cwd == null ? {} : {cwd}),
    gitBranch: 'main',
    message: {content: text, role: 'user'},
    sessionId,
    timestamp: at.toISOString(),
    type: 'user',
  };
}

function assistantRecord(
  sessionId: string,
  cwd: string | null,
  text: string,
  at: Date,
): Record<string, unknown> {
  return {
    ...(cwd == null ? {} : {cwd}),
    gitBranch: 'main',
    message: {
      content: [{text, type: 'text'}],
      model: 'claude-opus-5',
      role: 'assistant',
    },
    sessionId,
    timestamp: at.toISOString(),
    type: 'assistant',
  };
}

/** A two-message transcript where Claude Code files one. */
function writeTranscript(
  h: Harness,
  sessionId: string,
  cwd: string | null,
  now: Date,
): void {
  const dir = join(h.projects, projectDirSlug(cwd ?? '/unknown'));
  mkdirSync(dir, {recursive: true});
  const first = new Date(now.getTime() - DAY);
  writeFileSync(
    join(dir, `${sessionId}.jsonl`),
    `${[
      userRecord(sessionId, cwd, 'an ordinary request', first),
      assistantRecord(sessionId, cwd, 'an ordinary answer', first),
    ]
      .map((record) => JSON.stringify(record))
      .join('\n')}\n`,
  );
}

function threadSessions(h: Harness): unknown[] {
  return h.fake
    .read()
    .issues.filter((issue) => issue.type === 'thread')
    .map((issue) => issue.metadata?.sessionId);
}

describe('thread backfill', () => {
  const now = new Date('2026-11-13T12:00:00.000Z');

  test('a private session is left out; the public one is created; both message logs are kept locally', async () => {
    const h = harness();
    writeTranscript(h, PRIVATE_SESSION, h.lifeWorktree, now);
    writeTranscript(h, PUBLIC_SESSION, h.neighbour, now);
    const summary = await backfillThreads({days: 30, env: h.env, now});

    expect(summary.failures).toEqual([]);
    expect(summary.sessionsInWindow).toBe(2);
    expect(summary.created).toBe(1);
    expect(summary.skippedPrivate).toBe(1);
    expect(summary.privateSessions).toHaveLength(1);
    expect(summary.privateSessions[0]).toContain(PRIVATE_SESSION);
    expect(threadSessions(h)).toEqual([PUBLIC_SESSION]);
    expect(bdLog(h).join('\n')).not.toContain(PRIVATE_SESSION);
    expect(summary.messageLogs.written).toBe(2);
  });

  test('NEGATIVE CONTROL: with no private repo configured, both are created', async () => {
    const h = harness({componentConfig: {thread: {autoCommit: false}}});
    writeTranscript(h, PRIVATE_SESSION, h.lifeWorktree, now);
    writeTranscript(h, PUBLIC_SESSION, h.neighbour, now);
    const summary = await backfillThreads({days: 30, env: h.env, now});
    expect(summary.created).toBe(2);
    expect(summary.skippedPrivate).toBe(0);
  });

  test('an existing thread bead of a private session is left exactly as it was', async () => {
    const h = harness();
    const before: FakeIssue = {
      description: 'what was there before',
      id: 'jl-t5',
      metadata: {
        cwd: h.lifeWorktree,
        lastActivityAt: '2026-10-01T00:00:00.000Z',
        sessionId: PRIVATE_SESSION,
        source: 'report',
      },
      notes: 'old notes',
      status: 'in_progress',
      title: 'an old title',
      type: 'thread',
    };
    seedIssues(h, [before]);
    writeTranscript(h, PRIVATE_SESSION, h.lifeWorktree, now);
    const summary = await backfillThreads({days: 30, env: h.env, now});
    expect(summary.refreshed).toBe(0);
    expect(writesIn(h)).toEqual([]);
    expect(h.fake.read().issues).toEqual([before]);
  });

  test('a transcript with no cwd is treated as private', async () => {
    const h = harness();
    writeTranscript(h, PUBLIC_SESSION, null, now);
    const summary = await backfillThreads({days: 30, env: h.env, now});
    expect(summary.skippedPrivate).toBe(1);
    expect(summary.privateSessions[0]).toContain('unknown');
    expect(writesIn(h)).toEqual([]);
  });

  test('an unusable user config writes nothing and FAILS the run, loudly', async () => {
    const h = harness('not-json');
    writeTranscript(h, PUBLIC_SESSION, h.neighbour, now);
    const summary = await backfillThreads({days: 30, env: h.env, now});
    expect(summary.created).toBe(0);
    expect(summary.failures.join('\n')).toContain('PRIVACY');
    expect(writesIn(h)).toEqual([]);
  });

  test('a dry run counts the private skip too', async () => {
    const h = harness();
    writeTranscript(h, PRIVATE_SESSION, h.lifeWorktree, now);
    const summary = await backfillThreads({
      days: 30,
      dryRun: true,
      env: h.env,
      now,
    });
    expect(summary.skippedPrivate).toBe(1);
    expect(summary.created).toBe(0);
  });
});

function factsFor(sessionId: string, cwd: string, now: Date): ThreadFacts {
  return {
    aheadBehind: {ahead: 0, behind: 0},
    autofillFailures: [],
    branch: 'main',
    cwd,
    dirty: false,
    entrypoint: 'cli',
    firstUserMessage: 'the brief',
    firstUserMessageAt: null,
    headSha: 'deadbee',
    isWorktree: false,
    lastAssistantMessage: 'here is the report',
    lastAssistantMessageAt: null,
    lastUserMessage: 'go',
    lastUserMessageAt: null,
    model: 'claude-opus-5',
    repo: 'some-repo',
    repoPath: cwd,
    reportedAt: now.toISOString(),
    resumeCommand: null,
    sessionId,
    startedAt: new Date(now.getTime() - DAY).toISOString(),
    tokensAtStop: 1,
    transcriptPath: null,
    worktreePath: null,
  };
}

function validPayload(): ReturnType<typeof validateThreadReport> & {
  status: 'ok';
} {
  const raw = examplePayload();
  raw.asks = [];
  raw.priorAsks = [];
  const validated = validateThreadReport(raw);
  if (validated.status !== 'ok') {
    throw new Error('the example payload stopped validating');
  }
  return validated;
}

describe('thread report and the spool drain', () => {
  const now = new Date('2026-11-13T12:00:00.000Z');

  test('a private session’s report is rendered but nothing is read or written in bd', async () => {
    const h = harness();
    const outcome = await writeReportToBd({
      ctx: bdContext(h.env),
      facts: factsFor(PRIVATE_SESSION, h.lifeWorktree, now),
      payload: validPayload().payload,
      sessionId: PRIVATE_SESSION,
    });
    expect(outcome.status).toBe('private');
    if (outcome.status === 'private') {
      expect(outcome.rendered.length).toBeGreaterThan(0);
      expect(outcome.reason).toContain('privateRepos');
    }
    expect(bdLog(h)).toEqual([]);
  });

  test('NEGATIVE CONTROL: a public session’s report is written', async () => {
    const h = harness();
    const outcome = await writeReportToBd({
      ctx: bdContext(h.env),
      facts: factsFor(PUBLIC_SESSION, h.neighbour, now),
      payload: validPayload().payload,
      sessionId: PUBLIC_SESSION,
    });
    expect(outcome.status).toBe('written');
    expect(threadSessions(h)).toEqual([PUBLIC_SESSION]);
  });

  test('a spooled report of a private session leaves the spool and is never written', async () => {
    const h = harness();
    const report: ArchivedReport = {
      facts: factsFor(PRIVATE_SESSION, h.lifeWorktree, now),
      payload: validPayload().payload,
      reportedAt: now.toISOString(),
      schemaVersion: THREAD_SCHEMA_VERSION,
      sessionId: PRIVATE_SESSION,
    };
    const spooled = spoolReport(report, 'a test', h.env);
    expect(spooled.ok).toBe(true);
    const summary = await drainSpool({env: h.env});
    expect(summary?.private).toBe(1);
    expect(summary?.kept).toBe(0);
    expect(writesIn(h)).toEqual([]);
    // Drained once means drained: the next board does not retry it.
    const again = await drainSpool({env: h.env});
    expect(again?.outcomes ?? []).toEqual([]);
  });
});

describe('thread done and thread answer', () => {
  function threadOf(sessionId: string, cwd: string): FakeIssue {
    return {
      id: 'jl-t1',
      metadata: {cwd, sessionId},
      status: 'in_progress',
      title: 'a thread',
      type: 'thread',
    };
  }

  test('a private session’s thread is not closed through the threads repo', async () => {
    const h = harness();
    silence();
    seedIssues(h, [threadOf(PRIVATE_SESSION, h.lifeWorktree)]);
    const code = await runThreadDone({
      autoCommit: false,
      env: h.env,
      threadId: 'jl-t1',
    });
    expect(code).toBe(1);
    expect(writesIn(h)).toEqual([]);
    expect(h.fake.read().issues[0]?.status).toBe('in_progress');
  });

  test('NEGATIVE CONTROL: a public session’s thread closes', async () => {
    const h = harness();
    silence();
    seedIssues(h, [threadOf(PUBLIC_SESSION, h.neighbour)]);
    const code = await runThreadDone({
      autoCommit: false,
      env: h.env,
      threadId: 'jl-t1',
    });
    expect(code).toBe(0);
    expect(h.fake.read().issues[0]?.status).toBe('closed');
  });

  test('an answer on a private session’s thread is refused; on a public one it is written', async () => {
    const h = harness();
    seedIssues(h, [threadOf(PRIVATE_SESSION, h.lifeWorktree)]);
    const ctx = bdContext(h.env);
    const refused = await bdWriter(
      ctx,
      'jl-t1',
      ownerOfMetadata({cwd: h.lifeWorktree, sessionId: PRIVATE_SESSION}),
    ).note('an answer');
    expect(refused.ok).toBe(false);
    expect(writesIn(h)).toEqual([]);

    // NEGATIVE CONTROL.
    const written = await bdWriter(
      ctx,
      'jl-t1',
      ownerOfMetadata({cwd: h.neighbour, sessionId: PUBLIC_SESSION}),
    ).note('an answer');
    expect(written.ok).toBe(true);
    expect(writesIn(h)).toHaveLength(2);
  });
});
