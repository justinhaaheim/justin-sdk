/**
 * `thread capture` — every prompt and every Claude yield, at every turn, with
 * or without a status report (home-base-k0b8n.9, decision K10).
 *
 * The bead-writing half runs against the STATEFUL FAKE bd (tests/fake-bd.ts): a
 * real workspace whose `bun run bd` is a script, so `applyCapture` spawns real
 * subprocesses and parses real stdout, exactly as it does against Dolt. The
 * hook half runs `runThreadCaptureHook` in-process with the detached spawn
 * stubbed (a real detached child would outlive the test), plus two subprocess
 * runs of the real CLI for the exit-code contract.
 *
 * NEGATIVE CONTROLS: see home-base-k0b8n.9's notes, where each one is recorded
 * with the line broken and the assertion that went red.
 */

import type {ApplyRequest, SpawnOutcome} from '../src/thread/capture';
import type {MessageLine} from '../src/thread/message-log';
import type {FakeBd, FakeIssue} from './fake-bd';

import {afterEach, describe, expect, spyOn, test} from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {
  captureDirtyPath,
  captureLockPath,
  captureRunLogPath,
  captureSeedStampPath,
  messageLogPath,
  messagesDir,
} from '../src/thread/archive';
import {BACKFILL_SOURCE} from '../src/thread/backfill';
import {
  applyCapture,
  CAPTURE_MESSAGES_SOURCE,
  runThreadCaptureApply,
  runThreadCaptureHook,
} from '../src/thread/capture';
import {
  appendMessageLine,
  linesFromTurns,
  readMessageLog,
  syncMessageLogFromTranscript,
} from '../src/thread/message-log';
import {
  buildCorpus,
  compileQuery,
  readMessageLogs,
  searchCorpus,
} from '../src/thread/search';
import {renderMessagesBlock} from '../src/thread/show';
import {
  extractTranscriptMessages,
  extractTranscriptTurns,
  projectDirSlug,
} from '../src/thread/transcript-messages';
import {
  addThreadCaptureHooks,
  THREAD_CAPTURE_HOOK_COMMAND,
  THREAD_STOP_HOOK_COMMAND,
} from '../src/thread-hooks-setup';
import {createFakeBd} from './fake-bd';

const SESSION = '0c9f1a2b-3c4d-4e5f-8a9b-0123456789ab';

interface Harness {
  cwd: string;
  env: Record<string, string | undefined>;
  fake: FakeBd;
  root: string;
  spawned: ApplyRequest[];
  stateDir: string;
}

/**
 * A fake bd workspace, an isolated XDG config home carrying the knobs, and a
 * project directory with no justin-sdk.config.json — so the USER file is the
 * only layer that speaks. CLAUDE_CODE_ENTRYPOINT is pinned to `cli` (an
 * interactive session): the suite itself may run under `sdk-cli`.
 */
function harness(
  knobs: {capture?: boolean; enabled?: boolean} = {enabled: true},
): Harness {
  const fake = createFakeBd();
  const root = mkdtempSync(join(tmpdir(), 'thread-capture-'));
  const xdg = join(root, 'xdg');
  const stateDir = join(root, 'state');
  const cwd = join(root, 'project');
  mkdirSync(join(xdg, 'justin-sdk'), {recursive: true});
  mkdirSync(cwd, {recursive: true});
  writeFileSync(
    join(xdg, 'justin-sdk', 'config.json'),
    JSON.stringify({componentConfig: {thread: knobs}}),
  );
  return {
    cwd,
    env: {
      ...fake.env,
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      JUSTIN_THREADS_REPO_DIR: fake.dir,
      JUSTIN_THREADS_STATE_DIR: stateDir,
      // A transcript that does not exist: the start path's facts collector
      // records the miss instead of scanning ~/.claude/projects for it.
      JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(root, 'no-transcripts'),
      XDG_CONFIG_HOME: xdg,
    },
    fake,
    root,
    spawned: [],
    stateDir,
  };
}

function payload(
  h: Harness,
  event: string,
  text: string,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    cwd: h.cwd,
    hook_event_name: event,
    session_id: SESSION,
    transcript_path: join(h.root, 'no-transcripts', `${SESSION}.jsonl`),
    ...(event === 'UserPromptSubmit'
      ? {prompt: text}
      : {last_assistant_message: text}),
    ...extra,
  });
}

/** Run the hook with the detached spawn stubbed; the requests are recorded. */
function hook(h: Harness, stdin: string, now = new Date()) {
  return runThreadCaptureHook({
    env: h.env,
    now,
    spawnApply: (request): SpawnOutcome => {
      h.spawned.push(request);
      return {kind: 'spawned', pid: null};
    },
    stdin,
  });
}

function logLines(h: Harness): MessageLine[] {
  const read = readMessageLog(SESSION, h.env);
  if (read.kind !== 'read') throw new Error(`log not read: ${read.kind}`);
  return read.lines;
}

function threads(h: Harness): FakeIssue[] {
  return h.fake.read().issues.filter((issue) => issue.type === 'thread');
}

function onlyThread(h: Harness): FakeIssue {
  const all = threads(h);
  expect(all).toHaveLength(1);
  const [thread] = all;
  if (thread == null) throw new Error('no thread');
  return thread;
}

function seedThread(h: Harness, issue: Omit<FakeIssue, 'id' | 'type'>): void {
  const state = h.fake.read();
  state.issues.push({id: 'jl-t900', type: 'thread', ...issue});
  h.fake.write(state);
}

function line(
  role: MessageLine['role'],
  text: string,
  at: string,
): MessageLine {
  return {
    at,
    cwd: '/w',
    event: role === 'user' ? 'UserPromptSubmit' : 'Stop',
    role,
    text,
  };
}

const spies: {mockRestore: () => void}[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

function captureStderr(): string[] {
  const lines: string[] = [];
  const spy = spyOn(console, 'error').mockImplementation(
    (...args: unknown[]) => {
      lines.push(args.join(' '));
    },
  );
  spies.push(spy);
  return lines;
}

// ---------------------------------------------------------------------------
// K10 a — the skip rules
// ---------------------------------------------------------------------------

describe('K10 a · every skip rule writes nothing and spawns nothing', () => {
  const cases: {
    env?: Record<string, string>;
    name: string;
    stdin: (h: Harness) => string;
    why: string;
  }[] = [
    {
      name: 'an event that is not UserPromptSubmit or Stop',
      stdin: (h) => payload(h, 'SessionStart', 'hello'),
      why: 'unsupportedEvent',
    },
    {
      name: 'a SUBAGENT (the payload carries agent_id)',
      stdin: (h) => payload(h, 'Stop', 'player done', {agent_id: 'a1b2'}),
      why: 'subagent',
    },
    {
      env: {CLAUDE_CODE_ENTRYPOINT: 'sdk-cli'},
      name: 'a claude -p session (CLAUDE_CODE_ENTRYPOINT=sdk-cli)',
      stdin: (h) => payload(h, 'UserPromptSubmit', 'summarise this'),
      why: 'nonInteractive',
    },
    {
      name: 'no session id',
      stdin: (h) => payload(h, 'Stop', 'done', {session_id: ''}),
      why: 'noSessionId',
    },
    {
      name: 'a session id that is not a safe file name',
      stdin: (h) => payload(h, 'Stop', 'done', {session_id: '../escape'}),
      why: 'badSessionId',
    },
    {
      name: 'a prompt that is only harness noise',
      stdin: (h) =>
        payload(
          h,
          'UserPromptSubmit',
          '<system-reminder>\nnot his words\n</system-reminder>',
        ),
      why: 'emptyText',
    },
    {
      name: 'a bare slash command (K2 renders it as nothing)',
      stdin: (h) => payload(h, 'UserPromptSubmit', '/copy'),
      why: 'emptyText',
    },
    {
      name: 'a whitespace-only yield',
      stdin: (h) => payload(h, 'Stop', '  \n  '),
      why: 'emptyText',
    },
  ];

  for (const entry of cases) {
    test(entry.name, () => {
      const h = harness();
      const result = runThreadCaptureHook({
        env: {...h.env, ...entry.env},
        spawnApply: (request) => {
          h.spawned.push(request);
          return {kind: 'spawned', pid: null};
        },
        stdin: entry.stdin(h),
      });
      expect(result.exitCode).toBe(0);
      expect(result.decision.kind).toBe('skip');
      if (result.decision.kind === 'skip') {
        expect(result.decision.why).toBe(entry.why as never);
      }
      expect(existsSync(messagesDir(h.env))).toBe(false);
      expect(h.spawned).toHaveLength(0);
    });
  }

  test('a slash command WITH arguments is his brief and is kept', () => {
    const h = harness();
    const result = hook(
      h,
      payload(h, 'UserPromptSubmit', '/conductor build the capture hook'),
    );
    expect(result.decision.kind).toBe('capture');
    expect(logLines(h).map((l) => l.text)).toEqual([
      '/conductor build the capture hook',
    ]);
  });
});

// ---------------------------------------------------------------------------
// The knob
// ---------------------------------------------------------------------------

describe('knob off = nothing written', () => {
  test('capture false (enabled true): no log, no child', () => {
    const h = harness({capture: false, enabled: true});
    const result = hook(h, payload(h, 'Stop', 'a real yield'));
    expect(result.exitCode).toBe(0);
    expect(result.decision).toMatchObject({kind: 'skip', why: 'knobOff'});
    expect(existsSync(h.stateDir)).toBe(false);
    expect(h.spawned).toHaveLength(0);
  });

  test('enabled false (capture at its default): no log, no child', () => {
    const h = harness({enabled: false});
    const result = hook(h, payload(h, 'UserPromptSubmit', 'a real prompt'));
    expect(result.decision).toMatchObject({kind: 'skip', why: 'knobOff'});
    expect(existsSync(h.stateDir)).toBe(false);
    expect(h.spawned).toHaveLength(0);
  });

  test('enabled true and capture unset: DEFAULT ON — the line is written', () => {
    const h = harness({enabled: true});
    const result = hook(h, payload(h, 'Stop', 'a real yield'));
    expect(result.decision.kind).toBe('capture');
    expect(logLines(h)).toHaveLength(1);
    expect(h.spawned).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// K10 b — the append and its dedupe
// ---------------------------------------------------------------------------

describe('K10 b · the synchronous append and the dedupe', () => {
  test('a prompt then a yield append two lines in the documented shape', () => {
    const h = harness();
    const t0 = new Date('2026-09-23T14:00:00.000Z');
    hook(
      h,
      payload(h, 'UserPromptSubmit', '<system-reminder>x</system-reminder>go'),
      t0,
    );
    hook(
      h,
      payload(h, 'Stop', '  Done.\n\nIt works.  '),
      new Date('2026-09-23T14:02:00.000Z'),
    );
    expect(logLines(h)).toEqual([
      {
        at: '2026-09-23T14:00:00.000Z',
        cwd: h.cwd,
        event: 'UserPromptSubmit',
        role: 'user',
        text: 'go',
      },
      {
        at: '2026-09-23T14:02:00.000Z',
        cwd: h.cwd,
        event: 'Stop',
        role: 'assistant',
        // Trimmed, not noise-stripped (D-c): it must equal its backfilled twin.
        text: 'Done.\n\nIt works.',
      },
    ]);
    // Each captured line starts one bead-update child with the session's facts.
    expect(h.spawned.map((r) => r.sessionId)).toEqual([SESSION, SESSION]);
    expect(h.spawned[0]?.cwd).toBe(h.cwd);
    // The hook hands its synchronous wall time to the child, which records it.
    expect(typeof h.spawned[0]?.hookElapsedMs).toBe('number');
  });

  test('the same yield twice in a row is ONE line (a hook firing twice)', () => {
    const h = harness();
    hook(h, payload(h, 'Stop', 'Done.'));
    const second = hook(h, payload(h, 'Stop', 'Done.'));
    expect(second.append?.kind).toBe('duplicate');
    expect(logLines(h)).toHaveLength(1);
    // A duplicate still starts the child: the log is right, the bead may not be.
    expect(h.spawned).toHaveLength(2);
  });

  test('the same yield in a NEW turn (a prompt between) is two messages', () => {
    const h = harness();
    hook(h, payload(h, 'Stop', 'Done.'));
    hook(h, payload(h, 'UserPromptSubmit', 'again'));
    hook(h, payload(h, 'Stop', 'Done.'));
    expect(logLines(h).map((l) => l.text)).toEqual(['Done.', 'again', 'Done.']);
  });

  test('the same prompt within 5 s is one line; 6 s later it is two', () => {
    const h = harness();
    hook(
      h,
      payload(h, 'UserPromptSubmit', 'yes'),
      new Date('2026-09-23T14:00:00.000Z'),
    );
    const dup = hook(
      h,
      payload(h, 'UserPromptSubmit', 'yes'),
      new Date('2026-09-23T14:00:04.000Z'),
    );
    expect(dup.append?.kind).toBe('duplicate');
    const again = hook(
      h,
      payload(h, 'UserPromptSubmit', 'yes'),
      new Date('2026-09-23T14:00:10.000Z'),
    );
    expect(again.append?.kind).toBe('appended');
    expect(logLines(h).map((l) => l.at)).toEqual([
      '2026-09-23T14:00:00.000Z',
      '2026-09-23T14:00:10.000Z',
    ]);
  });

  test('a message is stored UNCAPPED', () => {
    const h = harness();
    const long = `${'q'.repeat(40_000)} end`;
    hook(h, payload(h, 'Stop', long));
    expect(logLines(h)[0]?.text).toBe(long);
  });

  test('nothing is ever written to stdout (it would reach the model)', () => {
    const h = harness();
    const out: string[] = [];
    const spy = spyOn(console, 'log').mockImplementation(
      (...args: unknown[]) => {
        out.push(args.join(' '));
      },
    );
    spies.push(spy);
    hook(h, payload(h, 'UserPromptSubmit', 'hello'));
    runThreadCaptureHook({
      env: h.env,
      explain: true,
      spawnApply: () => ({kind: 'spawned', pid: null}),
      stdin: payload(h, 'Stop', 'bye'),
    });
    expect(out).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Exit 0 on every failure path
// ---------------------------------------------------------------------------

describe('exit 0 on every failure — a capture never blocks a turn', () => {
  test('malformed stdin', () => {
    const h = harness();
    for (const stdin of ['{not json', '[1, 2]', 'null', '"a string"']) {
      const result = hook(h, stdin);
      expect(result.exitCode).toBe(0);
      expect(result.decision).toMatchObject({
        kind: 'skip',
        why: 'unreadablePayload',
      });
    }
    expect(h.spawned).toHaveLength(0);
  });

  test('an unwritable state dir: the failure is said on stderr, no child', () => {
    const h = harness();
    const blocker = join(h.root, 'a-file');
    writeFileSync(blocker, 'not a directory');
    const stderr = captureStderr();
    const result = runThreadCaptureHook({
      env: {...h.env, JUSTIN_THREADS_STATE_DIR: join(blocker, 'state')},
      spawnApply: (request) => {
        h.spawned.push(request);
        return {kind: 'spawned', pid: null};
      },
      stdin: payload(h, 'Stop', 'a yield with nowhere to go'),
    });
    expect(result.exitCode).toBe(0);
    expect(result.append?.kind).toBe('failed');
    expect(stderr.join('\n')).toContain('message NOT logged');
    expect(h.spawned).toHaveLength(0);
  });

  test('a spawn that THROWS is caught', () => {
    const h = harness();
    const stderr = captureStderr();
    const result = runThreadCaptureHook({
      env: h.env,
      spawnApply: () => {
        throw new Error('EAGAIN: fork failed');
      },
      stdin: payload(h, 'Stop', 'logged before the spawn'),
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.join('\n')).toContain('EAGAIN: fork failed');
    // The log line landed before the spawn was attempted (the D5 property).
    expect(logLines(h).map((l) => l.text)).toEqual(['logged before the spawn']);
  });

  test('the child with bd MISSING resolves 0 and says why in capture.jsonl', async () => {
    const h = harness();
    hook(h, payload(h, 'Stop', 'a yield'));
    const env = {...h.env, JUSTIN_THREADS_REPO_DIR: join(h.root, 'no-repo')};
    expect(
      await runThreadCaptureApply({
        autoCommit: false,
        env,
        hookElapsedMs: 3.2,
        sessionId: SESSION,
      }),
    ).toBe(0);
    const records = readFileSync(captureRunLogPath(env), 'utf8')
      .trim()
      .split('\n')
      .map((raw) => JSON.parse(raw) as Record<string, unknown>);
    expect(records.at(-1)).toMatchObject({
      // The spawning hook's own timing survives here, the only place it can.
      hookElapsedMs: 3.2,
      outcome: 'bdFailed',
      sessionId: SESSION,
      stage: 'lookup',
    });
    // The lock was released: the next child is not locked out.
    expect(existsSync(captureLockPath(SESSION, env))).toBe(false);
  });

  test('the child with an unwritable state dir resolves 0', async () => {
    const h = harness();
    const blocker = join(h.root, 'a-file');
    writeFileSync(blocker, 'not a directory');
    expect(
      await runThreadCaptureApply({
        autoCommit: false,
        env: {...h.env, JUSTIN_THREADS_STATE_DIR: join(blocker, 'state')},
        sessionId: SESSION,
      }),
    ).toBe(0);
  });

  test('the REAL CLI exits 0 with an empty stdout on malformed stdin and on an unwritable state dir', () => {
    const h = harness();
    const blocker = join(h.root, 'a-file');
    writeFileSync(blocker, 'not a directory');
    const cli = join(import.meta.dir, '..', 'src', 'cli.ts');
    const runs = [
      {env: h.env, stdin: '{not json'},
      {
        env: {...h.env, JUSTIN_THREADS_STATE_DIR: join(blocker, 'state')},
        stdin: payload(h, 'Stop', 'nowhere to go'),
      },
    ];
    for (const run of runs) {
      const result = Bun.spawnSync(
        [process.execPath, cli, 'thread', 'capture'],
        {
          env: {...run.env, JUSTIN_SDK_HEALTH_NOTICES: 'off'},
          stdin: Buffer.from(run.stdin),
        },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toBe('');
    }
  });
});

test('the REAL CLI child (--apply --hook-ms) exits 0 and records the hook timing', () => {
  const h = harness();
  hook(h, payload(h, 'Stop', 'a yield'));
  const env = {
    ...h.env,
    JUSTIN_SDK_HEALTH_NOTICES: 'off',
    JUSTIN_THREADS_REPO_DIR: join(h.root, 'no-repo'),
  };
  const cli = join(import.meta.dir, '..', 'src', 'cli.ts');
  const result = Bun.spawnSync(
    [
      process.execPath,
      cli,
      'thread',
      'capture',
      '--apply',
      SESSION,
      '--hook-ms',
      '4.5',
    ],
    {env},
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe('');
  const last = readFileSync(captureRunLogPath(env), 'utf8')
    .trim()
    .split('\n')
    .at(-1);
  expect(JSON.parse(last ?? '{}')).toMatchObject({
    hookElapsedMs: 4.5,
    outcome: 'bdFailed',
  });
});

// ---------------------------------------------------------------------------
// K10 c — the detached child: create, adopt, ownership, convergence
// ---------------------------------------------------------------------------

describe('K10 c · the bead update', () => {
  test('no thread yet: it is CREATED through the start path, then carries the log', async () => {
    const h = harness();
    hook(
      h,
      payload(h, 'UserPromptSubmit', 'first prompt'),
      new Date('2026-09-23T14:00:00.000Z'),
    );
    hook(
      h,
      payload(h, 'Stop', 'first yield'),
      new Date('2026-09-23T14:01:00.000Z'),
    );
    const outcome = await applyCapture({
      autoCommit: false,
      cwd: h.cwd,
      env: h.env,
      sessionId: SESSION,
    });
    expect(outcome).toMatchObject({kind: 'ran', last: {created: true}});
    const thread = onlyThread(h);
    expect(thread.status).toBe('in_progress');
    // `thread start`'s own bead: its placeholder title and NO REPORT YET body.
    expect(thread.title).toContain('(untitled)');
    expect(thread.description).toContain('NO REPORT YET');
    expect(thread.metadata).toMatchObject({
      firstUserMessage: 'first prompt',
      lastActivityAt: '2026-09-23T14:01:00.000Z',
      lastAssistantMessage: 'first yield',
      lastAssistantMessageAt: '2026-09-23T14:01:00.000Z',
      lastUserMessage: 'first prompt',
      messageCount: 2,
      messagesSource: CAPTURE_MESSAGES_SOURCE,
      sessionId: SESSION,
    });

    // The next turn FINDS it — one bead per session, never a second.
    hook(
      h,
      payload(h, 'UserPromptSubmit', 'second prompt'),
      new Date('2026-09-23T14:05:00.000Z'),
    );
    const again = await applyCapture({
      autoCommit: false,
      cwd: h.cwd,
      env: h.env,
      sessionId: SESSION,
    });
    expect(again).toMatchObject({kind: 'ran', last: {created: false}});
    expect(onlyThread(h).metadata).toMatchObject({
      firstUserMessage: 'first prompt',
      lastUserMessage: 'second prompt',
      messageCount: 3,
    });
  });

  test('a backfill bead is ADOPTED: open → in_progress, its body untouched', async () => {
    const h = harness();
    seedThread(h, {
      description: 'BACKFILLED BODY',
      metadata: {
        firstUserMessage: 'from the transcript',
        sessionId: SESSION,
        source: BACKFILL_SOURCE,
      },
      notes: 'BACKFILLED NOTES',
      status: 'open',
      title: 'backfilled title',
    });
    hook(h, payload(h, 'Stop', 'a live yield'));
    const outcome = await applyCapture({
      autoCommit: false,
      env: h.env,
      sessionId: SESSION,
    });
    expect(outcome).toMatchObject({kind: 'ran', last: {adopted: true}});
    const thread = onlyThread(h);
    expect(thread.status).toBe('in_progress');
    expect(thread.title).toBe('backfilled title');
    expect(thread.description).toBe('BACKFILLED BODY');
    expect(thread.notes).toBe('BACKFILLED NOTES');
    expect(thread.metadata).toMatchObject({
      // firstUserMessage is the transcript's to say; the log started late.
      firstUserMessage: 'from the transcript',
      lastAssistantMessage: 'a live yield',
      source: BACKFILL_SOURCE,
    });
  });

  test('a REPORTED thread keeps its title, body, notes and status; only the message keys move', async () => {
    const h = harness();
    seedThread(h, {
      description: 'THE REPORTED DESCRIPTION',
      metadata: {
        lastAssistantMessage: 'the report yield',
        lastUserMessage: 'the report prompt',
        reportCount: 2,
        sessionId: SESSION,
      },
      notes: 'THE RENDERED REPORT',
      status: 'in_progress',
      title: 'the reported title',
    });
    // A log that holds ONLY Claude's line: capture was installed mid-session.
    hook(h, payload(h, 'Stop', 'the newest yield'));
    await applyCapture({autoCommit: false, env: h.env, sessionId: SESSION});
    const thread = onlyThread(h);
    expect(thread.title).toBe('the reported title');
    expect(thread.description).toBe('THE REPORTED DESCRIPTION');
    expect(thread.notes).toBe('THE RENDERED REPORT');
    expect(thread.status).toBe('in_progress');
    expect(thread.metadata).toMatchObject({
      lastAssistantMessage: 'the newest yield',
      // The log says nothing about his last prompt, so it is NOT overwritten.
      lastUserMessage: 'the report prompt',
      reportCount: 2,
    });
    // No status write was issued at all.
    expect(
      h.fake.read().log.filter((entry) => entry.includes('-s in_progress')),
    ).toEqual([]);
  });

  test('a CLOSED thread gets its messages refreshed and stays closed (D-f)', async () => {
    const h = harness();
    seedThread(h, {
      metadata: {sessionId: SESSION, source: BACKFILL_SOURCE},
      status: 'closed',
      title: 'done thread',
    });
    hook(h, payload(h, 'Stop', 'resumed and answered'));
    await applyCapture({autoCommit: false, env: h.env, sessionId: SESSION});
    const thread = onlyThread(h);
    expect(thread.status).toBe('closed');
    expect(thread.metadata?.lastAssistantMessage).toBe('resumed and answered');
  });

  test('an unchanged log writes nothing to bd', async () => {
    const h = harness();
    hook(h, payload(h, 'Stop', 'a yield'));
    await applyCapture({autoCommit: false, env: h.env, sessionId: SESSION});
    const before = h.fake.read().log.length;
    const outcome = await applyCapture({
      autoCommit: false,
      env: h.env,
      sessionId: SESSION,
    });
    expect(outcome).toMatchObject({kind: 'ran', last: {wrote: false}});
    // One lookup, and nothing after it.
    expect(h.fake.read().log.slice(before)).toHaveLength(1);
    expect(h.fake.read().log.at(-1)).toContain('list -t thread');
  });
});

describe('K10 c · two quick captures converge on the NEWEST message (lock + dirty stamp)', () => {
  test('a child that finds the lock held defers; the holder loops and lands the tail', async () => {
    const h = harness();
    hook(
      h,
      payload(h, 'UserPromptSubmit', 'turn one'),
      new Date('2026-09-23T14:00:00.000Z'),
    );
    hook(
      h,
      payload(h, 'Stop', 'yield one'),
      new Date('2026-09-23T14:01:00.000Z'),
    );

    // Child A takes the lock and reads the log SYNCHRONOUSLY, before its first
    // bd await — so this promise is already holding a view of "yield one".
    const first = applyCapture({
      autoCommit: false,
      cwd: h.cwd,
      env: h.env,
      sessionId: SESSION,
    });
    expect(existsSync(captureLockPath(SESSION, h.env))).toBe(true);

    // The next turn lands while A is mid-write…
    hook(
      h,
      payload(h, 'UserPromptSubmit', 'turn two'),
      new Date('2026-09-23T14:02:00.000Z'),
    );
    hook(
      h,
      payload(h, 'Stop', 'yield two'),
      new Date('2026-09-23T14:03:00.000Z'),
    );
    const bdCallsBefore = h.fake.read().log.length;

    // …and its child B finds the lock held: it marks the session dirty and
    // leaves WITHOUT touching bd (at most one writer per session).
    const second = await applyCapture({
      autoCommit: false,
      cwd: h.cwd,
      env: h.env,
      sessionId: SESSION,
    });
    expect(second).toEqual({kind: 'deferred'});

    const outcome = await first;
    // The bead carries the NEWEST turn, not the one A first read…
    expect(onlyThread(h).metadata).toMatchObject({
      lastAssistantMessage: 'yield two',
      lastUserMessage: 'turn two',
      messageCount: 4,
    });
    // …because A saw the stamp and ran a second pass over the new tail.
    expect(outcome).toMatchObject({kind: 'ran', passes: 2});
    expect(h.fake.read().log.length).toBeGreaterThan(bdCallsBefore);
    expect(existsSync(captureLockPath(SESSION, h.env))).toBe(false);
    expect(existsSync(captureDirtyPath(SESSION, h.env))).toBe(false);
  });

  test('a lock held by a LIVE other process defers and leaves the dirty stamp', async () => {
    const h = harness();
    hook(h, payload(h, 'Stop', 'a yield'));
    mkdirSync(join(h.stateDir, 'capture-locks'), {recursive: true});
    writeFileSync(captureLockPath(SESSION, h.env), String(process.ppid));
    const outcome = await applyCapture({
      autoCommit: false,
      env: h.env,
      sessionId: SESSION,
    });
    expect(outcome).toEqual({kind: 'deferred'});
    expect(existsSync(captureDirtyPath(SESSION, h.env))).toBe(true);
    expect(h.fake.read().log).toEqual([]);
  });

  test('a lock left by a DEAD process is stolen, and the tail lands', async () => {
    const h = harness();
    hook(h, payload(h, 'Stop', 'after a crash'));
    const dead = Bun.spawnSync(['true']).pid;
    mkdirSync(join(h.stateDir, 'capture-locks'), {recursive: true});
    writeFileSync(captureLockPath(SESSION, h.env), String(dead));
    const outcome = await applyCapture({
      autoCommit: false,
      env: h.env,
      sessionId: SESSION,
    });
    expect(outcome).toMatchObject({kind: 'ran'});
    expect(onlyThread(h).metadata?.lastAssistantMessage).toBe('after a crash');
    expect(existsSync(captureLockPath(SESSION, h.env))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// K10 e — extractTranscriptTurns on the conductor fixture
// ---------------------------------------------------------------------------

const FIXTURE = join(import.meta.dir, 'fixtures', 'conductor-session.jsonl');

describe('K10 e · extractTranscriptTurns', () => {
  test('the conductor fixture: two turns, the first yield, a thinking + tool_use-only tail that is NOT a yield', () => {
    const turns = extractTranscriptTurns(FIXTURE);
    expect(turns.failures).toEqual([]);
    expect(turns.entrypoint).toBe('cli');
    expect(turns.lastTimestamp).toBe('2026-09-19T11:28:09.846Z');
    expect(turns.turns).toHaveLength(2);
    const [one, two] = turns.turns;
    expect(one?.user?.text.startsWith('You are the /conductor.')).toBe(true);
    expect(one?.assistant?.text).toBe(
      "Dispatch 1 is running in the worktree.\n\nWaiting on the player's return before the next step.",
    );
    expect(two?.user?.text).toBe('go ahead and dispatch 2');
    // The turn ends in a thinking-only record and a tool_use-only record, and
    // nothing Claude SAID: no yield, rather than a tool call or a thought.
    expect(two?.assistant).toBeNull();
    // The sidechain prompt is Claude's words to a subagent, never a turn.
    const all = JSON.stringify(turns.turns);
    expect(all).not.toContain('A SUBAGENT PROMPT');
    expect(all).not.toContain('THINKING');
    expect(linesFromTurns(turns.turns).map((l) => l.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
  });

  test('the yield is the LAST text-bearing record of the turn, past a tool_use-only tail', () => {
    const h = harness();
    const path = join(h.root, 'turns.jsonl');
    const record = (
      type: 'assistant' | 'user',
      content: unknown,
      at: string,
    ): string =>
      JSON.stringify({
        cwd: '/w',
        message: {content, role: type},
        sessionId: SESSION,
        timestamp: at,
        type,
      });
    writeFileSync(
      path,
      [
        record('user', 'fix the bug', '2026-09-23T10:00:00.000Z'),
        record(
          'assistant',
          [{text: 'Let me look.', type: 'text'}],
          '2026-09-23T10:00:01.000Z',
        ),
        record(
          'assistant',
          [{id: 't1', input: {}, name: 'Bash', type: 'tool_use'}],
          '2026-09-23T10:00:02.000Z',
        ),
        record(
          'user',
          [{content: 'ok', tool_use_id: 't1', type: 'tool_result'}],
          '2026-09-23T10:00:03.000Z',
        ),
        record(
          'assistant',
          [{text: 'Fixed and tested.', type: 'text'}],
          '2026-09-23T10:00:04.000Z',
        ),
        record(
          'assistant',
          [{id: 't2', input: {}, name: 'Bash', type: 'tool_use'}],
          '2026-09-23T10:00:05.000Z',
        ),
        '',
      ].join('\n'),
    );
    const turns = extractTranscriptTurns(path).turns;
    expect(turns).toHaveLength(1);
    expect(turns[0]?.user?.text).toBe('fix the bug');
    expect(turns[0]?.assistant).toEqual({
      at: '2026-09-23T10:00:04.000Z',
      cwd: '/w',
      text: 'Fixed and tested.',
    });
  });
});

// ---------------------------------------------------------------------------
// K10 f — search reads the logs
// ---------------------------------------------------------------------------

describe('K10 f · search finds a phrase that exists ONLY in a middle message', () => {
  test('the log is searched; the bead alone would not find it', () => {
    const h = harness();
    const path = messageLogPath(SESSION, h.env);
    for (const entry of [
      line('user', 'first ask', '2026-09-23T10:00:00.000Z'),
      line(
        'assistant',
        'the zebra-quokka migration is done',
        '2026-09-23T10:05:00.000Z',
      ),
      line('user', 'last ask', '2026-09-23T10:10:00.000Z'),
      line('assistant', 'final answer', '2026-09-23T10:15:00.000Z'),
    ]) {
      expect(appendMessageLine(path, entry).kind).toBe('appended');
    }
    const thread = {
      id: 'jl-t1',
      metadata: {
        firstUserMessage: 'first ask',
        lastAssistantMessage: 'final answer',
        lastUserMessage: 'last ask',
        sessionId: SESSION,
      },
      status: 'in_progress',
      title: 'a session',
    };
    const compiled = compileQuery('zebra-quokka');
    if (!compiled.ok) throw new Error(compiled.error);

    const logs = readMessageLogs(h.env);
    expect(logs.failures).toEqual([]);
    const found = searchCorpus(
      buildCorpus([thread], [], logs.logs),
      compiled.value,
    );
    expect(found.matched).toBe(1);
    expect(found.rows[0]?.threadId).toBe('jl-t1');
    expect(found.rows[0]?.hit.field.startsWith('Claude · ')).toBe(true);

    // The same corpus WITHOUT the logs: the phrase is nowhere on the bead.
    expect(
      searchCorpus(buildCorpus([thread], []), compiled.value).matched,
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// K10 · the installer (scope item 7's code)
// ---------------------------------------------------------------------------

describe('the installer adds both capture hooks, idempotently', () => {
  test('both events, once each, beside the existing stop-check entry', () => {
    const settings: Record<string, unknown> = {
      hooks: {
        Stop: [{hooks: [{command: THREAD_STOP_HOOK_COMMAND, type: 'command'}]}],
      },
    };
    expect(addThreadCaptureHooks(settings)).toEqual([
      'UserPromptSubmit',
      'Stop',
    ]);
    const snapshot = JSON.stringify(settings);
    expect(addThreadCaptureHooks(settings)).toEqual([]);
    expect(JSON.stringify(settings)).toBe(snapshot);

    const hooks = settings.hooks as Record<
      string,
      {hooks: {command: string}[]}[]
    >;
    const commands = (event: string): string[] =>
      (hooks[event] ?? []).flatMap((entry) =>
        entry.hooks.map((x) => x.command),
      );
    expect(commands('UserPromptSubmit')).toEqual([THREAD_CAPTURE_HOOK_COMMAND]);
    expect(commands('Stop')).toEqual([
      THREAD_STOP_HOOK_COMMAND,
      THREAD_CAPTURE_HOOK_COMMAND,
    ]);
    expect(THREAD_CAPTURE_HOOK_COMMAND).toBe(
      'bun run justin-sdk thread capture',
    );
  });
});

// ---------------------------------------------------------------------------
// k0b8n.16 — the first capture seeds the log from the transcript
// k0b8n.15 — the first capture fills a missing resume command
// ---------------------------------------------------------------------------

type TranscriptRecordSpec = {
  at: string;
  role: 'assistant' | 'user';
  text: string;
};

const TRANSCRIPT_CWD = '/Users/x/Dev/repo';

function transcriptLine(spec: TranscriptRecordSpec): string {
  const message =
    spec.role === 'user'
      ? {content: spec.text, role: 'user'}
      : {content: [{text: spec.text, type: 'text'}], role: 'assistant'};
  return `${JSON.stringify({
    cwd: TRANSCRIPT_CWD,
    message,
    sessionId: SESSION,
    timestamp: spec.at,
    type: spec.role,
  })}\n`;
}

/**
 * A transcript filed where Claude Code files one: under the slug of its cwd,
 * so `buildResumeCommand` confirms the directory and records no failure.
 */
function writeTranscript(
  h: Harness,
  records: readonly TranscriptRecordSpec[],
): string {
  const dir = join(h.root, 'projects', projectDirSlug(TRANSCRIPT_CWD));
  mkdirSync(dir, {recursive: true});
  const path = join(dir, `${SESSION}.jsonl`);
  writeFileSync(path, records.map(transcriptLine).join(''));
  return path;
}

const MID_SESSION: TranscriptRecordSpec[] = [
  {at: '2026-09-23T10:00:00.000Z', role: 'user', text: 'the brief'},
  {at: '2026-09-23T10:01:00.000Z', role: 'assistant', text: 'yield one'},
  {at: '2026-09-23T10:10:00.000Z', role: 'user', text: 'second message'},
  {at: '2026-09-23T10:11:00.000Z', role: 'assistant', text: 'yield two'},
  // The newest turn: his message is on disk, its final yield is not yet (the
  // transcript lags the in-memory turn — stop-check.ts's header).
  {at: '2026-09-23T10:20:00.000Z', role: 'user', text: 'his newest message'},
];

/** A session whose log was started by capture mid-session, then one more Stop. */
async function midSessionCapture(h: Harness, transcript: string) {
  seedThread(h, {
    description: 'REPORTED',
    metadata: {
      lastUserMessage: 'the four-day-old brief',
      resumeCommand: "cd '/kept' && claude --resume kept",
      sessionId: SESSION,
    },
    status: 'in_progress',
    title: 'reported thread',
  });
  // The one line capture logged before this fix: a Stop, no user line.
  hook(
    h,
    payload(h, 'Stop', 'yield two', {transcript_path: transcript}),
    new Date('2026-09-23T10:11:30.000Z'),
  );
  hook(
    h,
    payload(h, 'Stop', 'the final yield', {transcript_path: transcript}),
    new Date('2026-09-23T10:25:00.000Z'),
  );
  return await applyCapture({
    autoCommit: false,
    env: h.env,
    sessionId: SESSION,
    transcriptPath: transcript,
  });
}

describe('k0b8n.16 · the first capture seeds a mid-session log from the transcript', () => {
  test('every earlier message and yield plus the live line; the bead gets his NEWEST real message', async () => {
    const h = harness();
    const transcript = writeTranscript(h, MID_SESSION);
    const outcome = await midSessionCapture(h, transcript);
    expect(outcome).toMatchObject({
      kind: 'ran',
      seed: {carried: 1, kind: 'seeded', messages: 6, rewrote: true},
    });
    expect(
      logLines(h).map((entry) => [entry.event, entry.role, entry.text]),
    ).toEqual([
      ['backfill', 'user', 'the brief'],
      ['backfill', 'assistant', 'yield one'],
      ['backfill', 'user', 'second message'],
      ['backfill', 'assistant', 'yield two'],
      ['backfill', 'user', 'his newest message'],
      ['Stop', 'assistant', 'the final yield'],
    ]);
    expect(onlyThread(h).metadata).toMatchObject({
      lastAssistantMessage: 'the final yield',
      lastUserMessage: 'his newest message',
      lastUserMessageAt: '2026-09-23T10:20:00.000Z',
      messageCount: 6,
    });
    expect(existsSync(captureSeedStampPath(SESSION, h.env))).toBe(true);
  });

  test('a second capture does NOT reseed', async () => {
    const h = harness();
    const transcript = writeTranscript(h, MID_SESSION);
    await midSessionCapture(h, transcript);
    // A message only the transcript has: a reseed would pull it in.
    writeTranscript(h, [
      ...MID_SESSION,
      {at: '2026-09-23T10:30:00.000Z', role: 'user', text: 'transcript only'},
    ]);
    const again = await applyCapture({
      autoCommit: false,
      env: h.env,
      sessionId: SESSION,
      transcriptPath: transcript,
    });
    expect(again).toMatchObject({kind: 'ran', seed: {kind: 'alreadySeeded'}});
    expect(logLines(h).map((entry) => entry.text)).not.toContain(
      'transcript only',
    );
    expect(logLines(h)).toHaveLength(6);
  });

  test('the backfill and a seeded log CONVERGE: no duplicate lines, then unchanged', async () => {
    const h = harness();
    const transcript = writeTranscript(h, MID_SESSION);
    await midSessionCapture(h, transcript);
    // The transcript catches up with the yield the Stop line already holds.
    writeTranscript(h, [
      ...MID_SESSION,
      {
        at: '2026-09-23T10:24:59.000Z',
        role: 'assistant',
        text: 'the final yield',
      },
    ]);
    const first = syncMessageLogFromTranscript({
      env: h.env,
      sessionId: SESSION,
      transcriptPath: transcript,
    });
    expect(first).toMatchObject({carried: 0, kind: 'written', messages: 6});
    const texts = logLines(h).map((entry) => `${entry.role}:${entry.text}`);
    expect(new Set(texts).size).toBe(texts.length);
    expect(texts.at(-1)).toBe('assistant:the final yield');
    expect(
      syncMessageLogFromTranscript({
        env: h.env,
        sessionId: SESSION,
        transcriptPath: transcript,
      }),
    ).toMatchObject({kind: 'unchanged'});
  });

  test('a seed that cannot read the transcript is NOT stamped, and the next capture seeds', async () => {
    const h = harness();
    const missing = join(h.root, 'projects', 'nowhere', `${SESSION}.jsonl`);
    hook(h, payload(h, 'Stop', 'a live yield', {transcript_path: missing}));
    const first = await applyCapture({
      autoCommit: false,
      env: h.env,
      sessionId: SESSION,
      transcriptPath: missing,
    });
    expect(first).toMatchObject({kind: 'ran', seed: {kind: 'failed'}});
    expect(existsSync(captureSeedStampPath(SESSION, h.env))).toBe(false);
    const transcript = writeTranscript(h, MID_SESSION);
    const second = await applyCapture({
      autoCommit: false,
      env: h.env,
      sessionId: SESSION,
      transcriptPath: transcript,
    });
    expect(second).toMatchObject({kind: 'ran', seed: {kind: 'seeded'}});
    expect(onlyThread(h).metadata?.lastUserMessage).toBe('his newest message');
  });
});

describe('k0b8n.15 · capture fills a missing resumeCommand, and never overwrites one', () => {
  test('a START-created thread gets the resume command the backfill would compute', async () => {
    const h = harness();
    const transcript = writeTranscript(h, MID_SESSION);
    seedThread(h, {
      metadata: {
        autofillFailures: [
          `transcript scan: ENOENT: no such file, stat '${transcript}'`,
        ],
        resumeCommand: null,
        sessionId: SESSION,
        source: 'start',
      },
      status: 'in_progress',
      title: '(untitled)',
    });
    hook(h, payload(h, 'Stop', 'a yield', {transcript_path: transcript}));
    await applyCapture({
      autoCommit: false,
      env: h.env,
      sessionId: SESSION,
      transcriptPath: transcript,
    });
    const expected = extractTranscriptMessages(transcript).resumeCommand;
    expect(expected).toBe(
      `cd '${TRANSCRIPT_CWD}' && claude --resume ${SESSION}`,
    );
    expect(onlyThread(h).metadata?.resumeCommand).toBe(expected);
  });

  test('a resume command a report or the backfill wrote is NEVER overwritten', async () => {
    const h = harness();
    const transcript = writeTranscript(h, MID_SESSION);
    await midSessionCapture(h, transcript);
    expect(onlyThread(h).metadata?.resumeCommand).toBe(
      "cd '/kept' && claude --resume kept",
    );
  });

  test('when it cannot be built, the reason is recorded and `thread show` prints it', async () => {
    const h = harness();
    const missing = join(h.root, 'projects', 'nowhere', `${SESSION}.jsonl`);
    seedThread(h, {
      metadata: {resumeCommand: null, sessionId: SESSION, source: 'start'},
      status: 'in_progress',
      title: '(untitled)',
    });
    hook(h, payload(h, 'Stop', 'a yield', {transcript_path: missing}));
    await applyCapture({
      autoCommit: false,
      env: h.env,
      sessionId: SESSION,
      transcriptPath: missing,
    });
    const meta = onlyThread(h).metadata ?? {};
    expect(meta.resumeCommand ?? null).toBeNull();
    const shown = renderMessagesBlock(meta, false).join('\n');
    const resume = shown.slice(shown.indexOf('Resume'));
    expect(resume).toContain('(not captured: read ');
    expect(resume).not.toContain('no reason recorded');
    // A second pass with the same failure is NOT a bd write per turn.
    const before = h.fake.read().log.length;
    await applyCapture({
      autoCommit: false,
      env: h.env,
      sessionId: SESSION,
      transcriptPath: missing,
    });
    expect(h.fake.read().log.slice(before)).toHaveLength(1);
  });
});
