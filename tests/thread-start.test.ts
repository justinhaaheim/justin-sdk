/**
 * `thread start` — the hand-run half of the one-bead-per-session upsert
 * (home-base-p1uj.3, D1/D6/D30), and the INERT `--hook` form (home-base-39co9).
 *
 * Since 2026-10-05 a session's thread bead is created on its FIRST PROMPT by
 * `thread capture` (tests/thread-capture.test.ts), which reuses this module's
 * create path; nothing happens at SessionStart (epic home-base-39co9 D1, D3).
 * `startThread` is what a hand-run `thread start` does, gated on
 * componentConfig.thread.enabled alone — `startOnSessionStart` is deprecated
 * and gates nothing (D2). The 2026-10-05 negative controls are on
 * home-base-39co9.1's notes.
 *
 * Everything here runs against the STATEFUL FAKE bd (tests/fake-bd.ts), which is
 * a real workspace whose `bun run bd` is a script: `startThread` spawns a real
 * subprocess and parses real stdout, exactly as it does against Dolt. That
 * matters most for the last group, where a `thread report` has to find and
 * rewrite the bead a previous `thread start` created — the bug that would make
 * this feature worse than useless is a second thread bead per session, and only
 * a real create-then-find round trip can prove it does not happen.
 *
 * NEGATIVE CONTROLS (run 2026-09-12, recorded on home-base-p1uj.3; (a) is
 * SUPERSEDED — the two-knob gate it proved was removed by home-base-39co9 D2):
 *
 *  b) The subagent guard was neutered to `if (false)`. 26 pass / 1 fail —
 *     "skips a SUBAGENT" at the `expect(threads(h)).toHaveLength(0)` assertion,
 *     `Expected length: 0 Received length: 1`: the fake workspace had gained a
 *     thread bead belonging to the PARENT session. Restored → 27/0.
 *  c) The `findThreadBySession` call in step 6 was replaced with a hardcoded
 *     `{ok: true, value: null}`. 24 pass / 3 fail — "a second run is a NO-OP"
 *     and "a start AFTER a report is a no-op" both `Expected: "existing"
 *     Received: "created"`. Restored → 27/0. Note which test did NOT fail:
 *     "UPDATES the start-created bead" stayed green, because only ONE start
 *     runs in it — the idempotency it proves is `report`'s, not `start`'s.
 */

import type {ThreadFacts} from '../src/thread/facts';
import type {FakeBd} from './fake-bd';

import {afterEach, describe, expect, spyOn, test} from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {bdContext} from '../src/thread/bd';
import {writeReportToBd} from '../src/thread/report';
import {validateThreadReport} from '../src/thread/schema';
import {
  describeStartOutcome,
  runThreadStartHook,
  startExitCode,
  startThread,
  type ThreadStartOutcome,
} from '../src/thread/start';
import {createFakeBd} from './fake-bd';
import {examplePayload} from './thread-schema.test';

const SESSION = '7f3c1e20-aaaa-4bbb-8ccc-0123456789ab';

interface Harness {
  cwd: string;
  env: Record<string, string | undefined>;
  fake: FakeBd;
  stateDir: string;
}

/**
 * A fake bd workspace, an isolated XDG config home carrying the knobs, and a
 * project root with no justin-sdk.config.json — so the USER file is the only
 * layer that speaks, which is how Justin actually operates the knob.
 */
function harness(
  knobs: {
    enabled?: boolean;
    startOnSessionStart?: boolean;
  },
  exportFails = false,
): Harness {
  const fake = createFakeBd(0, null, exportFails);
  const root = mkdtempSync(join(tmpdir(), 'thread-start-'));
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
      JUSTIN_THREADS_REPO_DIR: fake.dir,
      JUSTIN_THREADS_STATE_DIR: stateDir,
      // A transcript that does not exist: the facts collector records the miss
      // in autofillFailures instead of scanning ~/.claude/projects for it.
      JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(root, 'no-transcripts'),
      XDG_CONFIG_HOME: xdg,
    },
    fake,
    stateDir,
  };
}

function threads(h: Harness) {
  return h.fake.read().issues.filter((issue) => issue.type === 'thread');
}

const spies: {mockRestore: () => void}[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

function captureStdout(): string[] {
  const lines: string[] = [];
  const spy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.join(' '));
  });
  spies.push(spy);
  return lines;
}

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
// The knobs
// ---------------------------------------------------------------------------

describe('the knob (D6) — startOnSessionStart is deprecated (home-base-39co9 D2)', () => {
  test('both absent: disabled, and NOTHING is created', async () => {
    const h = harness({});
    const outcome = await startThread({
      autoCommit: false,
      cwd: h.cwd,
      env: h.env,
      sessionId: SESSION,
    });
    expect(outcome.kind).toBe('disabled');
    expect(threads(h)).toHaveLength(0);
    expect(h.fake.read().log).toEqual([]); // not even a read was spent
  });

  test('enabled on, startOnSessionStart false: a hand-run start CREATES — the deprecated key gates nothing', async () => {
    const h = harness({enabled: true, startOnSessionStart: false});
    const outcome = await startThread({
      autoCommit: false,
      cwd: h.cwd,
      env: h.env,
      sessionId: SESSION,
    });
    expect(outcome.kind).toBe('created');
    expect(threads(h)).toHaveLength(1);
  });

  test('startOnSessionStart on but enabled off: disabled, and the reason names enabled only', async () => {
    const h = harness({startOnSessionStart: true});
    const outcome = await startThread({
      autoCommit: false,
      cwd: h.cwd,
      env: h.env,
      sessionId: SESSION,
    });
    expect(outcome.kind).toBe('disabled');
    if (outcome.kind !== 'disabled') throw new Error('unreachable');
    expect(outcome.reason).toContain('componentConfig.thread.enabled');
    expect(outcome.reason).not.toContain('startOnSessionStart');
    expect(threads(h)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Creating, and creating exactly once
// ---------------------------------------------------------------------------

describe('enabled on (a hand-run start)', () => {
  test('creates ONE in_progress thread bead, titled and keyed for this session', async () => {
    const h = harness({enabled: true});
    const outcome = await startThread({
      autoCommit: false,
      cwd: h.cwd,
      env: h.env,
      sessionId: SESSION,
    });

    expect(outcome.kind).toBe('created');
    if (outcome.kind !== 'created') throw new Error('unreachable');
    expect(outcome.statusFailure).toBeNull();

    const all = threads(h);
    expect(all).toHaveLength(1);
    const bead = all[0]!;
    expect(bead.id).toBe(outcome.threadId);
    expect(bead.status).toBe('in_progress');
    expect(bead.title).toBe(
      `(untitled) project session ${SESSION.slice(0, 8)}`,
    );
    expect(bead.notes).toContain('NO REPORT YET');
    expect(bead.metadata?.sessionId).toBe(SESSION);
  });

  test('the metadata says "not reported yet" rather than "reported nothing"', async () => {
    // reportedAt: null is load-bearing, not cosmetic — writeReportToBd reads it
    // for both the supersede guard and the orphan-ask sweep, and a fabricated
    // stamp would make the session's first real report either look superseded
    // or hunt for orphans among asks that cannot exist.
    const h = harness({enabled: true});
    await startThread({
      autoCommit: false,
      cwd: h.cwd,
      env: h.env,
      sessionId: SESSION,
    });
    const meta = threads(h)[0]!.metadata ?? {};

    expect(meta.reportedAt).toBeNull();
    expect(meta.reportCount).toBe(0);
    expect(meta.stopReasonKind).toBeNull();
    expect(meta.progressPercent).toBeNull();
    expect(meta.goal).toBeNull();
    expect(meta.mergeState).toBeNull();
    // Measured, not unknown: a bead created seconds ago genuinely has no asks.
    expect(meta.askIds).toEqual([]);
    expect(meta.openAskCount).toBe(0);
    expect(meta.blockingAskCount).toBe(0);
  });

  test('a second run is a NO-OP that names the existing id', async () => {
    const h = harness({enabled: true});
    const first = await startThread({
      autoCommit: false,
      cwd: h.cwd,
      env: h.env,
      sessionId: SESSION,
    });
    if (first.kind !== 'created') throw new Error('unreachable');

    const second = await startThread({
      autoCommit: false,
      cwd: h.cwd,
      env: h.env,
      sessionId: SESSION,
    });
    expect(second.kind).toBe('existing');
    if (second.kind !== 'existing') throw new Error('unreachable');
    expect(second.threadId).toBe(first.threadId);
    expect(second.status).toBe('in_progress');
    expect(threads(h)).toHaveLength(1);
  });

  test('a DIFFERENT session gets its own bead', async () => {
    const h = harness({enabled: true});
    await startThread({
      autoCommit: false,
      cwd: h.cwd,
      env: h.env,
      sessionId: SESSION,
    });
    await startThread({
      autoCommit: false,
      cwd: h.cwd,
      env: h.env,
      sessionId: 'other-session-id',
    });
    expect(threads(h)).toHaveLength(2);
  });

  test('--title replaces the placeholder', async () => {
    const h = harness({enabled: true});
    const outcome = await startThread({
      autoCommit: false,
      cwd: h.cwd,
      env: h.env,
      sessionId: SESSION,
      title: 'Rewriting the drain lock',
    });
    if (outcome.kind !== 'created') throw new Error('unreachable');
    expect(threads(h)[0]!.title).toBe('Rewriting the drain lock');
  });
});

// ---------------------------------------------------------------------------
// Failure is not empty (rule 6)
// ---------------------------------------------------------------------------

describe('when it cannot do its job', () => {
  test('no session id: refuses, names why, creates nothing', async () => {
    const h = harness({enabled: true});
    const env = {...h.env, CLAUDE_CODE_SESSION_ID: undefined};
    const outcome = await startThread({
      autoCommit: false,
      cwd: h.cwd,
      env,
      sessionId: null,
    });
    expect(outcome.kind).toBe('noSessionId');
    expect(threads(h)).toHaveLength(0);
  });

  test('bd unreachable: bdFailed, and the failure is written down', async () => {
    const h = harness({enabled: true});
    // A directory that is not a beads workspace: `bun run bd` there fails with
    // `Script not found "bd"`, which the adapter classifies as `unreachable`.
    // It gets a `.beads` directory because since F9 the probe REFUSES to create
    // one — without it this exercises the missing-workspace path below instead.
    const empty = mkdtempSync(join(tmpdir(), 'not-life-'));
    mkdirSync(join(empty, '.beads'), {recursive: true});
    const env = {...h.env, JUSTIN_THREADS_REPO_DIR: empty};

    const outcome = await startThread({
      autoCommit: false,
      cwd: h.cwd,
      env,
      sessionId: SESSION,
    });
    expect(outcome.kind).toBe('bdFailed');
    if (outcome.kind !== 'bdFailed') throw new Error('unreachable');
    expect(outcome.failure.kind).toBe('unreachable');

    // The trace lands in start-failures/, NOT the spool the drain replays.
    expect(outcome.record?.ok).toBe(true);
    const dir = join(h.stateDir, 'start-failures');
    expect(readdirSync(dir).some((name) => name.startsWith(SESSION))).toBe(
      true,
    );
    expect(existsSync(join(h.stateDir, 'spool'))).toBe(false);
  });

  test('no life .beads directory: says so, and does NOT create one (F9)', async () => {
    const h = harness({enabled: true});
    const nowhere = join(mkdtempSync(join(tmpdir(), 'no-threads-')), 'threads');
    const env = {...h.env, JUSTIN_THREADS_REPO_DIR: nowhere};

    const outcome = await startThread({
      autoCommit: false,
      cwd: h.cwd,
      env,
      sessionId: SESSION,
    });
    expect(outcome.kind).toBe('threadsBeadsMissing');
    expect(describeStartOutcome(outcome)).toContain(
      'threads beads dir missing',
    );
    // The probe used to mkdir this into existence and then report it writable.
    expect(existsSync(nowhere)).toBe(false);
    expect(existsSync(join(nowhere, '.beads'))).toBe(false);
    expect(startExitCode(outcome)).toBe(0);
  });

  /**
   * Item B (p1uj.7): the headless/unattended guard is GONE.
   *
   * It skipped any session whose CLAUDE_CODE_SESSION_ATTENDED was set to
   * something other than "1" — a guard its own comment labelled conjecture,
   * against D30, which wants a row for EVERY session. An unattended run is if
   * anything the one most likely to stop where nobody notices.
   */
  test('an UNATTENDED session still gets a thread bead (D30, item B)', async () => {
    const h = harness({enabled: true});
    for (const attended of ['0', 'false', '']) {
      const env = {...h.env, CLAUDE_CODE_SESSION_ATTENDED: attended};
      const outcome = await startThread({
        autoCommit: false,
        cwd: h.cwd,
        env,
        sessionId: `${SESSION}-${attended}`,
      });
      expect(outcome.kind).toBe('created');
    }
    expect(threads(h)).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// The subagent guard
// ---------------------------------------------------------------------------

describe('the subagent guard', () => {
  test('skips a SUBAGENT: agentId present => nothing written, not even a read', async () => {
    // A hook payload's agent_id is the ONLY discriminant that exists — inside a
    // subagent's Bash, CLAUDE_CODE_SESSION_ID is the PARENT's. No caller passes
    // it since the SessionStart hook went inert (home-base-39co9 D3), but the
    // guard stays, so it is still proved.
    const h = harness({enabled: true});
    const outcome = await startThread({
      agentId: 'agent_01ABC',
      autoCommit: false,
      cwd: h.cwd,
      env: h.env,
      sessionId: SESSION,
    });
    expect(outcome.kind).toBe('skippedSubagent');
    expect(threads(h)).toHaveLength(0);
    expect(h.fake.read().log).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The hook is INERT (home-base-39co9.1, epic decisions D1 and D3)
// ---------------------------------------------------------------------------

describe('`thread start --hook` creates nothing (home-base-39co9 D1/D3)', () => {
  /**
   * The REAL CLI, fed a real SessionStart payload on stdin, exactly as the
   * SessionStart entry that existing repos still carry runs it. Both old knobs
   * are ON — the configuration that used to create a bead at every session
   * start — so a pass here means the knobs no longer matter, not that they
   * happened to be off.
   */
  test('a SessionStart payload with enabled AND startOnSessionStart true: no bead, no bd call, no output, exit 0', () => {
    const h = harness({enabled: true, startOnSessionStart: true});
    const cli = join(import.meta.dir, '..', 'src', 'cli.ts');
    for (const source of ['startup', 'resume']) {
      const result = Bun.spawnSync(
        [process.execPath, cli, 'thread', 'start', '--hook'],
        {
          env: {...h.env, JUSTIN_SDK_HEALTH_NOTICES: 'off'},
          stdin: Buffer.from(
            JSON.stringify({
              cwd: h.cwd,
              hook_event_name: 'SessionStart',
              session_id: SESSION,
              source,
              transcript_path: join(h.cwd, 'nope.jsonl'),
            }),
          ),
        },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toBe('');
      expect(result.stderr.toString()).toBe('');
    }
    expect(threads(h)).toHaveLength(0);
    // Not even a lookup: the hook must not spend a bd round trip at the top of
    // every session for a bead it will never create.
    expect(h.fake.read().log).toEqual([]);
  });

  test('in-process: runThreadStartHook returns 0 and says nothing, with the old knobs on', () => {
    const h = harness({enabled: true, startOnSessionStart: true});
    const out = captureStdout();
    const err = captureStderr();
    const saved = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = h.env.XDG_CONFIG_HOME;
    try {
      expect(runThreadStartHook()).toBe(0);
    } finally {
      if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = saved;
    }
    expect(out).toEqual([]);
    expect(err).toEqual([]);
    expect(h.fake.read().log).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The handoff to `thread report` — the whole point of D1
// ---------------------------------------------------------------------------

describe('a later `thread report` for the same session', () => {
  function reportFacts(): ThreadFacts {
    return {
      aheadBehind: {ahead: 1, behind: 0},
      autofillFailures: [],
      branch: 'thread-start',
      cwd: '/tmp',
      dirty: false,
      entrypoint: 'cli',
      firstUserMessage: 'kick this off',
      firstUserMessageAt: null,
      headSha: 'deadbee',
      isWorktree: false,
      lastAssistantMessage: 'Done — here is the report.',
      lastAssistantMessageAt: null,
      lastUserMessage: 'go',
      lastUserMessageAt: null,
      model: 'claude-opus-5',
      repo: 'justin-sdk',
      repoPath: '/tmp',
      reportedAt: '2026-09-12T12:00:00.000Z',
      resumeCommand: "cd '/repo' && claude --resume session-1",
      sessionId: SESSION,
      startedAt: '2026-09-12T11:00:00.000Z',
      tokensAtStop: 42,
      transcriptPath: '/tmp/t.jsonl',
      worktreePath: null,
    };
  }

  test('UPDATES the start-created bead instead of creating a second one', async () => {
    const h = harness({enabled: true});
    const started = await startThread({
      autoCommit: false,
      cwd: h.cwd,
      env: h.env,
      sessionId: SESSION,
    });
    if (started.kind !== 'created') throw new Error('unreachable');

    const raw = examplePayload();
    raw.priorAsks = [];
    raw.asks = [];
    raw.title = 'Thread start lands on the branch';
    const validated = validateThreadReport(raw);
    if (validated.status !== 'ok')
      throw new Error('fixture payload is invalid');

    const ctx = bdContext(h.env);
    ctx.repoDir = h.fake.dir;
    const result = await writeReportToBd({
      ctx,
      facts: reportFacts(),
      payload: validated.payload,
      sessionId: SESSION,
    });

    expect(result.status).toBe('written');
    if (result.status !== 'written') throw new Error('unreachable');
    expect(result.threadId).toBe(started.threadId);

    const all = threads(h);
    expect(all).toHaveLength(1); // NOT two
    const bead = all[0]!;
    expect(bead.id).toBe(started.threadId);
    expect(bead.title).toBe('Thread start lands on the branch');
    expect(bead.notes).not.toContain('NO REPORT YET');
    expect(bead.metadata?.reportCount).toBe(1);
    expect(bead.metadata?.reportedAt).toBe('2026-09-12T12:00:00.000Z');
    expect(bead.metadata?.sessionId).toBe(SESSION);
  });

  test('a start AFTER a report is a no-op on the reported bead', async () => {
    // Ordering is not guaranteed: a hand-run start can come after the
    // session reported. It must not overwrite a real report with
    // "(untitled) … no report yet".
    const h = harness({enabled: true});
    const raw = examplePayload();
    raw.priorAsks = [];
    raw.asks = [];
    raw.title = 'Already reported';
    const validated = validateThreadReport(raw);
    if (validated.status !== 'ok')
      throw new Error('fixture payload is invalid');

    const ctx = bdContext(h.env);
    ctx.repoDir = h.fake.dir;
    const reported = await writeReportToBd({
      ctx,
      facts: reportFacts(),
      payload: validated.payload,
      sessionId: SESSION,
    });
    if (reported.status !== 'written') throw new Error('unreachable');

    const outcome: ThreadStartOutcome = await startThread({
      autoCommit: false,
      cwd: h.cwd,
      env: h.env,
      sessionId: SESSION,
    });
    expect(outcome.kind).toBe('existing');

    const all = threads(h);
    expect(all).toHaveLength(1);
    expect(all[0]!.title).toBe('Already reported');
    expect(all[0]!.metadata?.reportCount).toBe(1);
  });
});

describe('a start whose write dies in auto-export (home-base-p1uj.10)', () => {
  test('the bead is CREATED and the unstaged export is flagged, not reported as a failure', async () => {
    const h = harness({enabled: true}, true);
    const outcome = await startThread({
      autoCommit: false,
      cwd: h.cwd,
      env: h.env,
      sessionId: SESSION,
    });
    // bd exited 1, after creating the bead. Calling that "bdFailed" would put a
    // session on nobody's board while its thread sat in Dolt.
    expect(outcome.kind).toBe('created');
    if (outcome.kind !== 'created') throw new Error('unreachable');
    expect(outcome.exportUnstaged).toBe(true);
    expect(threads(h)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The three verbatim messages (home-base-k0b8n K4)
// ---------------------------------------------------------------------------

/** The report-path facts, with the K4 fields filled in. */
function messageFacts(): ThreadFacts {
  return {
    aheadBehind: {ahead: 1, behind: 0},
    autofillFailures: [],
    branch: 'thread-start',
    cwd: '/tmp',
    dirty: false,
    entrypoint: 'cli',
    firstUserMessage: 'kick this off',
    firstUserMessageAt: '2026-09-12T11:00:00.000Z',
    headSha: 'deadbee',
    isWorktree: false,
    lastAssistantMessage: 'Done — here is the report.',
    lastAssistantMessageAt: '2026-09-12T11:30:00.000Z',
    lastUserMessage: 'go',
    lastUserMessageAt: '2026-09-12T11:31:00.000Z',
    model: 'claude-opus-5',
    repo: 'justin-sdk',
    repoPath: '/tmp',
    reportedAt: '2026-09-12T12:00:00.000Z',
    resumeCommand: "cd '/repo' && claude --resume session-1",
    sessionId: SESSION,
    startedAt: '2026-09-12T11:00:00.000Z',
    tokensAtStop: 42,
    transcriptPath: '/tmp/t.jsonl',
    worktreePath: null,
  };
}

describe('the K4 message fields land on the bead from BOTH writers', () => {
  /**
   * Point the harness at a transcripts root holding a real-shaped transcript
   * for this session, filed under the slug of the cwd it records — so the resume
   * command is built the way it is in the wild.
   */
  function seedTranscript(h: Harness, cwd: string): void {
    const root = join(h.stateDir, 'transcripts');
    const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
    mkdirSync(join(root, slug), {recursive: true});
    const records = [
      {
        cwd,
        entrypoint: 'cli',
        message: {
          content:
            '\n\n<pasted_content id="aa">\nbuild the thread messages\n</pasted_content id="aa">',
          role: 'user',
        },
        sessionId: SESSION,
        timestamp: '2026-09-12T11:00:00.000Z',
        type: 'user',
      },
      {
        cwd,
        message: {
          content: [
            {text: 'Here is what I built.', type: 'text'},
            {id: 'toolu_1', input: {}, name: 'Bash', type: 'tool_use'},
          ],
          model: 'claude-opus-5',
          role: 'assistant',
        },
        sessionId: SESSION,
        timestamp: '2026-09-12T11:30:00.000Z',
        type: 'assistant',
      },
      {
        cwd,
        message: {
          content: '<task-notification>a player finished</task-notification>',
          role: 'user',
        },
        sessionId: SESSION,
        timestamp: '2026-09-12T11:31:00.000Z',
        type: 'user',
      },
    ];
    writeFileSync(
      join(root, slug, `${SESSION}.jsonl`),
      `${records.map((r) => JSON.stringify(r)).join('\n')}\n`,
    );
    h.env.JUSTIN_THREADS_TRANSCRIPTS_ROOT = root;
  }

  test('`thread start` writes them, so a session that never reports is still findable', async () => {
    const h = harness({enabled: true});
    seedTranscript(h, h.cwd);
    const started = await startThread({
      autoCommit: false,
      cwd: h.cwd,
      env: h.env,
      sessionId: SESSION,
    });
    expect(started.kind).toBe('created');
    const bead = threads(h)[0]!;
    expect(bead.metadata?.firstUserMessage).toBe('build the thread messages');
    // Never the task notification that arrived after it.
    expect(bead.metadata?.lastUserMessage).toBe('build the thread messages');
    expect(bead.metadata?.lastAssistantMessage).toBe('Here is what I built.');
    expect(bead.metadata?.resumeCommand).toBe(
      `cd '${h.cwd}' && claude --resume ${SESSION}`,
    );
    expect(bead.metadata?.firstUserMessageAt).toBe('2026-09-12T11:00:00.000Z');
    expect(bead.metadata?.lastAssistantMessageAt).toBe(
      '2026-09-12T11:30:00.000Z',
    );
  });

  test('`thread report` writes them too, and UNCAPPED', async () => {
    const h = harness({enabled: true});
    const raw = examplePayload();
    raw.priorAsks = [];
    raw.asks = [];
    const validated = validateThreadReport(raw);
    if (validated.status !== 'ok')
      throw new Error('fixture payload is invalid');
    const ctx = bdContext(h.env);
    ctx.repoDir = h.fake.dir;
    // 4,000 characters — past the 1,500 the old facts collector truncated at,
    // which is what made a phrase late in a long brief unsearchable forever.
    const long = `${'z'.repeat(3990)} NEEDLE`;
    const result = await writeReportToBd({
      ctx,
      facts: {
        ...messageFacts(),
        firstUserMessage: long,
        lastAssistantMessage: 'the status report',
      },
      payload: validated.payload,
      sessionId: SESSION,
    });
    expect(result.status).toBe('written');
    const bead = threads(h)[0]!;
    expect(bead.metadata?.firstUserMessage).toHaveLength(long.length);
    expect(String(bead.metadata?.firstUserMessage)).toEndWith('NEEDLE');
    expect(bead.metadata?.lastAssistantMessage).toBe('the status report');
    expect(bead.metadata?.resumeCommand).toBe(
      "cd '/repo' && claude --resume session-1",
    );
  });
});
