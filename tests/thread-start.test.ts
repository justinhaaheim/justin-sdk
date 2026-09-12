/**
 * `thread start` — the SessionStart half of the one-bead-per-session upsert
 * (home-base-p1uj.3, D1/D6/D30).
 *
 * Everything here runs against the STATEFUL FAKE bd (tests/fake-bd.ts), which is
 * a real workspace whose `bun run bd` is a script: `startThread` spawns a real
 * subprocess and parses real stdout, exactly as it does against Dolt. That
 * matters most for the last group, where a `thread report` has to find and
 * rewrite the bead a previous `thread start` created — the bug that would make
 * this feature worse than useless is a second thread bead per session, and only
 * a real create-then-find round trip can prove it does not happen.
 *
 * NEGATIVE CONTROLS (run 2026-09-12, recorded on home-base-p1uj.3):
 *
 *  a) The knob gate was weakened from `!config.enabled ||
 *     !config.startOnSessionStart` to `!config.enabled`. 26 pass / 1 fail —
 *     "enabled on, startOnSessionStart off" at `expect(outcome.kind).toBe(
 *     'disabled')`, `Expected: "disabled" Received: "created"`. Restored → 27/0.
 *  b) The subagent guard was neutered to `if (false)`. 26 pass / 1 fail —
 *     "skips a SUBAGENT" at the `expect(threads(h)).toHaveLength(0)` assertion,
 *     `Expected length: 0 Received length: 1`: the fake workspace had gained a
 *     thread bead belonging to the PARENT session. Restored → 27/0.
 *  c) The `findThreadBySession` call in step 6 was replaced with a hardcoded
 *     `{ok: true, value: null}`. 24 pass / 3 fail — "a second run is a NO-OP"
 *     and "a start AFTER a report is a no-op" both `Expected: "existing"
 *     Received: "created"`, and the resume test found 3 stdout lines where it
 *     expected 0. Restored → 27/0. Note which test did NOT fail: "UPDATES the
 *     start-created bead" stayed green, because only ONE start runs in it — the
 *     idempotency it proves is `report`'s, not `start`'s.
 */

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

import {createFakeBd} from './fake-bd';
import {
  describeStartOutcome,
  runThreadStartHook,
  startExitCode,
  startThread,
  type ThreadStartOutcome,
} from '../src/thread/start';
import {bdContext} from '../src/thread/bd';
import {examplePayload} from './thread-schema.test';
import {validateThreadReport} from '../src/thread/schema';
import {writeReportToBd} from '../src/thread/report';

import type {FakeBd} from './fake-bd';
import type {ThreadFacts} from '../src/thread/facts';

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
function harness(knobs: {
  enabled?: boolean;
  startOnSessionStart?: boolean;
}): Harness {
  const fake = createFakeBd(0);
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
      JUSTIN_THREADS_LIFE_DIR: fake.dir,
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

describe('the two knobs (D6 + p1uj.3)', () => {
  test('both absent: disabled, and NOTHING is created', async () => {
    const h = harness({});
    const outcome = await startThread({
      cwd: h.cwd,
      env: h.env,
      sessionId: SESSION,
    });
    expect(outcome.kind).toBe('disabled');
    expect(threads(h)).toHaveLength(0);
    expect(h.fake.read().log).toEqual([]); // not even a read was spent
  });

  test('enabled on, startOnSessionStart off: still disabled, and it says which', async () => {
    const h = harness({enabled: true});
    const outcome = await startThread({
      cwd: h.cwd,
      env: h.env,
      sessionId: SESSION,
    });
    expect(outcome.kind).toBe('disabled');
    if (outcome.kind !== 'disabled') throw new Error('unreachable');
    expect(outcome.reason).toContain('startOnSessionStart');
    expect(threads(h)).toHaveLength(0);
  });

  test('startOnSessionStart on but enabled off: disabled — BOTH are required', async () => {
    const h = harness({startOnSessionStart: true});
    const outcome = await startThread({
      cwd: h.cwd,
      env: h.env,
      sessionId: SESSION,
    });
    expect(outcome.kind).toBe('disabled');
    if (outcome.kind !== 'disabled') throw new Error('unreachable');
    expect(outcome.reason).toContain('enabled');
    expect(threads(h)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Creating, and creating exactly once
// ---------------------------------------------------------------------------

describe('both knobs on', () => {
  test('creates ONE in_progress thread bead, titled and keyed for this session', async () => {
    const h = harness({enabled: true, startOnSessionStart: true});
    const outcome = await startThread({
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
    const h = harness({enabled: true, startOnSessionStart: true});
    await startThread({cwd: h.cwd, env: h.env, sessionId: SESSION});
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
    const h = harness({enabled: true, startOnSessionStart: true});
    const first = await startThread({
      cwd: h.cwd,
      env: h.env,
      sessionId: SESSION,
    });
    if (first.kind !== 'created') throw new Error('unreachable');

    const second = await startThread({
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
    const h = harness({enabled: true, startOnSessionStart: true});
    await startThread({cwd: h.cwd, env: h.env, sessionId: SESSION});
    await startThread({cwd: h.cwd, env: h.env, sessionId: 'other-session-id'});
    expect(threads(h)).toHaveLength(2);
  });

  test('--title replaces the placeholder', async () => {
    const h = harness({enabled: true, startOnSessionStart: true});
    const outcome = await startThread({
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
    const h = harness({enabled: true, startOnSessionStart: true});
    const env = {...h.env, CLAUDE_CODE_SESSION_ID: undefined};
    const outcome = await startThread({cwd: h.cwd, env, sessionId: null});
    expect(outcome.kind).toBe('noSessionId');
    expect(threads(h)).toHaveLength(0);
  });

  test('bd unreachable: bdFailed, and the failure is written down', async () => {
    const h = harness({enabled: true, startOnSessionStart: true});
    // A directory that is not a beads workspace: `bun run bd` there fails with
    // `Script not found "bd"`, which the adapter classifies as `unreachable`.
    // It gets a `.beads` directory because since F9 the probe REFUSES to create
    // one — without it this exercises the missing-workspace path below instead.
    const empty = mkdtempSync(join(tmpdir(), 'not-life-'));
    mkdirSync(join(empty, '.beads'), {recursive: true});
    const env = {...h.env, JUSTIN_THREADS_LIFE_DIR: empty};

    const outcome = await startThread({cwd: h.cwd, env, sessionId: SESSION});
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
    const h = harness({enabled: true, startOnSessionStart: true});
    const nowhere = join(mkdtempSync(join(tmpdir(), 'no-life-')), 'life');
    const env = {...h.env, JUSTIN_THREADS_LIFE_DIR: nowhere};

    const outcome = await startThread({cwd: h.cwd, env, sessionId: SESSION});
    expect(outcome.kind).toBe('lifeBeadsMissing');
    expect(describeStartOutcome(outcome)).toContain('life beads dir missing');
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
    const h = harness({enabled: true, startOnSessionStart: true});
    for (const attended of ['0', 'false', '']) {
      const env = {...h.env, CLAUDE_CODE_SESSION_ATTENDED: attended};
      const outcome = await startThread({
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
// The hook
// ---------------------------------------------------------------------------

describe('the SessionStart hook (thread start --hook)', () => {
  /** Run the hook with a crafted payload and this harness's environment. */
  async function runHook(
    h: Harness,
    payload: Record<string, unknown>,
  ): Promise<number> {
    const saved = {...process.env};
    Object.assign(process.env, h.env);
    for (const [key, value] of Object.entries(h.env)) {
      if (value === undefined) delete process.env[key];
    }
    try {
      return await runThreadStartHook({stdin: JSON.stringify(payload)});
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  }

  test('skips a SUBAGENT: agent_id present ⇒ exit 0, nothing written, nothing said', async () => {
    // The hook payload's agent_id is the ONLY discriminant that exists — inside
    // a subagent's Bash, CLAUDE_CODE_SESSION_ID is the PARENT's. Without this
    // guard a dispatched player would create its conductor's thread bead.
    const h = harness({enabled: true, startOnSessionStart: true});
    const out = captureStdout();
    const err = captureStderr();

    const code = await runHook(h, {
      agent_id: 'agent_01ABC',
      agent_type: 'player',
      cwd: h.cwd,
      hook_event_name: 'SessionStart',
      session_id: SESSION,
      source: 'startup',
    });

    expect(code).toBe(0);
    expect(threads(h)).toHaveLength(0);
    expect(h.fake.read().log).toEqual([]);
    expect(out).toEqual([]);
    expect(err).toEqual([]);
  });

  test('prints NOTHING when the knobs are off, and still exits 0', async () => {
    const h = harness({});
    const out = captureStdout();
    const err = captureStderr();

    const code = await runHook(h, {
      cwd: h.cwd,
      hook_event_name: 'SessionStart',
      session_id: SESSION,
      source: 'startup',
    });

    expect(code).toBe(0);
    expect(out).toEqual([]);
    expect(err).toEqual([]);
    expect(threads(h)).toHaveLength(0);
  });

  test('prints ONE short line on stdout when it creates a bead', async () => {
    const h = harness({enabled: true, startOnSessionStart: true});
    const out = captureStdout();

    const code = await runHook(h, {
      cwd: h.cwd,
      hook_event_name: 'SessionStart',
      session_id: SESSION,
      source: 'startup',
      transcript_path: join(h.cwd, 'nope.jsonl'),
    });

    expect(code).toBe(0);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^thread started: \S+$/);
    expect(threads(h)).toHaveLength(1);
  });

  test('a resume says nothing on stdout — the bead already exists', async () => {
    const h = harness({enabled: true, startOnSessionStart: true});
    await runHook(h, {cwd: h.cwd, session_id: SESSION, source: 'startup'});
    const out = captureStdout();
    const err = captureStderr();

    const code = await runHook(h, {
      cwd: h.cwd,
      session_id: SESSION,
      source: 'resume',
    });

    expect(code).toBe(0);
    expect(out).toEqual([]); // stdout is model context; an id it already has is noise
    expect(err).toHaveLength(1);
    expect(err[0]).toContain('thread already started');
    expect(threads(h)).toHaveLength(1);
  });

  test('a malformed payload exits 0 in silence rather than taking the session down', async () => {
    const h = harness({enabled: true, startOnSessionStart: true});
    const out = captureStdout();
    const err = captureStderr();
    const saved = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = h.env.XDG_CONFIG_HOME;
    try {
      expect(await runThreadStartHook({stdin: '{not json'})).toBe(0);
    } finally {
      if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = saved;
    }
    expect(out).toEqual([]);
    expect(err).toEqual([]);
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
      headSha: 'deadbee',
      isWorktree: false,
      lastUserMessage: 'go',
      model: 'claude-opus-5',
      reportedAt: '2026-09-12T12:00:00.000Z',
      repo: 'justin-sdk',
      repoPath: '/tmp',
      sessionId: SESSION,
      startedAt: '2026-09-12T11:00:00.000Z',
      tokensAtStop: 42,
      transcriptPath: '/tmp/t.jsonl',
      worktreePath: null,
    };
  }

  test('UPDATES the start-created bead instead of creating a second one', async () => {
    const h = harness({enabled: true, startOnSessionStart: true});
    const started = await startThread({
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
    ctx.lifeDir = h.fake.dir;
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
    // Ordering is not guaranteed: a session that reported, then resumed, fires
    // SessionStart again. The start must not overwrite a real report with
    // "(untitled) … no report yet".
    const h = harness({enabled: true, startOnSessionStart: true});
    const raw = examplePayload();
    raw.priorAsks = [];
    raw.asks = [];
    raw.title = 'Already reported';
    const validated = validateThreadReport(raw);
    if (validated.status !== 'ok')
      throw new Error('fixture payload is invalid');

    const ctx = bdContext(h.env);
    ctx.lifeDir = h.fake.dir;
    const reported = await writeReportToBd({
      ctx,
      facts: reportFacts(),
      payload: validated.payload,
      sessionId: SESSION,
    });
    if (reported.status !== 'written') throw new Error('unreachable');

    const outcome: ThreadStartOutcome = await startThread({
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
