/**
 * The spool drain (home-base-p1uj D5, dispatch home-base-p1uj.2).
 *
 * THE ONE INVARIANT: a spool file is removed only when its content has
 * definitely landed somewhere. Applied → removed. Superseded → removed (the
 * archive still has it). Anything else → LEFT EXACTLY WHERE IT WAS.
 *
 * The failing case is the one worth the test. Deleting a spool file after a
 * failed apply loses a report from the only place still tracking it, and loses
 * it during `thread board` — a command whose entire output is a reassuring
 * dashboard. Nothing would ever be red.
 *
 * The applier is INJECTED rather than mocked at the process boundary, because
 * what is under test is the drain's bookkeeping, not bd. A bd database is the
 * one thing a hermetic test cannot conjure; the live end-to-end run against
 * ~/Dev/life covers that half and is recorded on the bead.
 *
 * NEGATIVE CONTROL, run 2026-09-12: changing the `kept` branch to `rmSync` the
 * file anyway made exactly two tests fail — "a FAILED apply leaves the spool
 * file in place" and "a REFUSED apply leaves the spool file in place" — both at
 * `expect(existsSync(file)).toBe(true)` with `Expected: true  Received: false`.
 * The applied/superseded tests stayed green, which is the right shape: they
 * assert the opposite. Restoring the branch returned all of them to green.
 */

import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {drainSpool, renderDrain, type SpoolApplier} from '../src/thread/drain';
import {spoolDir} from '../src/thread/archive';
import {validateThreadReport} from '../src/thread/schema';
import {examplePayload} from './thread-schema.test';

import type {ArchivedReport} from '../src/thread/archive';
import type {BdContext} from '../src/thread/bd';
import type {ThreadFacts} from '../src/thread/facts';

let stateDir: string;
let env: Record<string, string | undefined>;

const CTX: BdContext = {env: {}, lifeDir: '/nowhere'};

function facts(reportedAt: string): ThreadFacts {
  return {
    aheadBehind: {ahead: 1, behind: 0},
    autofillFailures: [],
    branch: 'thread-reports',
    cwd: '/Users/jhaa/Dev/home-base/projects/justin-sdk',
    dirty: true,
    entrypoint: 'cli',
    headSha: 'c79a686abcdef0123456',
    isWorktree: false,
    lastUserMessage: 'build the read path',
    model: 'claude-opus-5',
    reportedAt,
    repo: 'justin-sdk',
    repoPath: '/Users/jhaa/Dev/home-base/projects/justin-sdk',
    sessionId: 'sess-1',
    startedAt: '2026-09-12T07:00:00.000Z',
    tokensAtStop: 1000,
    transcriptPath: '/tmp/transcript.jsonl',
    worktreePath: null,
  };
}

function spooled(reportedAt: string): ArchivedReport {
  const validation = validateThreadReport(examplePayload());
  if (validation.status !== 'ok') throw new Error('fixture payload is invalid');
  return {
    facts: facts(reportedAt),
    payload: validation.payload,
    reportedAt,
    schemaVersion: 1,
    sessionId: 'sess-1',
  };
}

/** Write one spool file and return its path. */
function writeSpool(name: string, body: unknown): string {
  const dir = spoolDir(env);
  mkdirSync(dir, {recursive: true});
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
  return path;
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'thread-drain-'));
  env = {JUSTIN_THREADS_STATE_DIR: stateDir};
});

afterEach(() => {
  rmSync(stateDir, {force: true, recursive: true});
});

const applied: SpoolApplier = async () => ({
  askIds: ['jl-a1.1'],
  closedAsks: [],
  rendered: 'REPORT',
  reportCount: 2,
  status: 'written',
  threadId: 'jl-a1',
});

const bdFailed: SpoolApplier = async () => ({
  failure: {
    command: 'bd update jl-a1',
    detail: 'database is locked',
    kind: 'locked',
  },
  rendered: 'REPORT',
  status: 'bdFailed',
});

const refused: SpoolApplier = async () => ({
  missing: ['jl-a1.7'],
  status: 'refused',
});

const superseded: SpoolApplier = async () => ({
  existingReportCount: 4,
  existingReportedAt: '2026-09-12T11:00:00.000Z',
  status: 'superseded',
  threadId: 'jl-a1',
});

describe('drainSpool', () => {
  test('an APPLIED report removes its spool file', async () => {
    const file = writeSpool(
      'sess-1-a.json',
      spooled('2026-09-12T10:00:00.000Z'),
    );
    const summary = await drainSpool({apply: applied, ctx: CTX, env});
    expect(summary?.applied).toBe(1);
    expect(summary?.kept).toBe(0);
    expect(existsSync(file)).toBe(false);
  });

  // THE NEGATIVE CONTROL'S TARGET. If this ever goes green-by-deletion the
  // report is gone and the dashboard says "applied 0" without blinking.
  test('a FAILED apply leaves the spool file in place', async () => {
    const file = writeSpool(
      'sess-1-b.json',
      spooled('2026-09-12T10:00:00.000Z'),
    );
    const summary = await drainSpool({apply: bdFailed, ctx: CTX, env});
    expect(summary?.applied).toBe(0);
    expect(summary?.kept).toBe(1);
    expect(existsSync(file)).toBe(true);
    expect(summary?.outcomes[0]?.detail).toContain('locked');
  });

  test('a REFUSED apply leaves the spool file in place and names the ask', async () => {
    const file = writeSpool(
      'sess-1-c.json',
      spooled('2026-09-12T10:00:00.000Z'),
    );
    const summary = await drainSpool({apply: refused, ctx: CTX, env});
    expect(summary?.kept).toBe(1);
    expect(existsSync(file)).toBe(true);
    expect(summary?.outcomes[0]?.detail).toContain('jl-a1.7');
  });

  test('a SUPERSEDED report removes its file — it reached bd, it was overtaken', async () => {
    const file = writeSpool(
      'sess-1-d.json',
      spooled('2026-09-12T09:00:00.000Z'),
    );
    const summary = await drainSpool({apply: superseded, ctx: CTX, env});
    expect(summary?.superseded).toBe(1);
    expect(summary?.kept).toBe(0);
    expect(existsSync(file)).toBe(false);
    expect(summary?.outcomes[0]?.detail).toContain('report #4');
    // F6: honest about what was LOST. The payload never reached bd, so its asks
    // were never created and never will be — saying it "reached its
    // destination" hid two questions Justin would never see.
    expect(summary?.outcomes[0]?.detail).toContain('NOT applied');
    expect(summary?.outcomes[0]?.detail).toContain('NEVER created');
    expect(summary?.outcomes[0]?.detail).not.toContain(
      'reached its destination',
    );
  });

  test('an unparseable file is KEPT and named — not understood is not handled', async () => {
    const dir = spoolDir(env);
    mkdirSync(dir, {recursive: true});
    const file = join(dir, 'sess-1-broken.json');
    writeFileSync(file, '{ this is not json');
    const summary = await drainSpool({apply: applied, ctx: CTX, env});
    expect(summary?.kept).toBe(1);
    expect(existsSync(file)).toBe(true);
    expect(summary?.outcomes[0]?.detail).toContain('not valid JSON');
  });

  test('a file whose payload no longer validates is kept, not written', async () => {
    const bad = spooled('2026-09-12T10:00:00.000Z') as unknown as Record<
      string,
      unknown
    >;
    (bad.payload as Record<string, unknown>).title = '';
    const file = writeSpool('sess-1-invalid.json', bad);
    const summary = await drainSpool({apply: applied, ctx: CTX, env});
    expect(summary?.kept).toBe(1);
    expect(existsSync(file)).toBe(true);
    expect(summary?.outcomes[0]?.detail).toContain('no longer validates');
  });

  test('an empty spool is MEASURED empty and prints nothing', async () => {
    const summary = await drainSpool({apply: applied, ctx: CTX, env});
    expect(summary).not.toBeNull();
    expect(summary?.outcomes).toEqual([]);
    expect(renderDrain(summary)).toEqual([]);
  });

  test('files are drained oldest-first within a session', async () => {
    writeSpool(
      'sess-1-2026-09-12T11.json',
      spooled('2026-09-12T11:00:00.000Z'),
    );
    writeSpool(
      'sess-1-2026-09-12T09.json',
      spooled('2026-09-12T09:00:00.000Z'),
    );
    const seen: string[] = [];
    const recording: SpoolApplier = async (report) => {
      seen.push(report.reportedAt);
      return applied(report, CTX);
    };
    await drainSpool({apply: recording, ctx: CTX, env});
    expect(seen).toEqual([
      '2026-09-12T09:00:00.000Z',
      '2026-09-12T11:00:00.000Z',
    ]);
    expect(readdirSync(spoolDir(env))).toEqual([]);
  });
});

/**
 * F11 — `document.facts` used to be CAST, never validated.
 *
 * A facts object with no `reportedAt` reached the supersede guard, where
 * `"2026-…" > undefined` is false, so the guard concluded "not superseded" and
 * the payload was APPLIED: the one direction that overwrites newer state with
 * older, rendering `undefined` fields into the bead as it went.
 */
describe('the archived facts are validated, not cast (F11)', () => {
  test('facts with no reportedAt are KEPT, and never reach the applier', async () => {
    const bad = spooled('2026-09-12T10:00:00.000Z') as unknown as Record<
      string,
      unknown
    >;
    delete (bad.facts as Record<string, unknown>).reportedAt;
    delete bad.reportedAt;
    const file = writeSpool('sess-1-nofacts.json', bad);

    let reached = 0;
    const counting: SpoolApplier = async (report) => {
      reached += 1;
      return applied(report, CTX);
    };
    const summary = await drainSpool({apply: counting, ctx: CTX, env});

    expect(reached).toBe(0);
    expect(summary?.kept).toBe(1);
    expect(existsSync(file)).toBe(true);
    expect(summary?.outcomes[0]?.detail).toContain('facts no longer validate');
    expect(summary?.outcomes[0]?.detail).toContain('reportedAt');
  });

  test('a wrong-typed fact is kept too — unparseable is its own outcome', async () => {
    const bad = spooled('2026-09-12T10:00:00.000Z') as unknown as Record<
      string,
      unknown
    >;
    (bad.facts as Record<string, unknown>).tokensAtStop = 'lots';
    const file = writeSpool('sess-1-badfact.json', bad);
    const summary = await drainSpool({apply: applied, ctx: CTX, env});
    expect(summary?.kept).toBe(1);
    expect(existsSync(file)).toBe(true);
  });

  test('an UNKNOWN extra fact still replays — a newer build may have added it', async () => {
    const forward = spooled('2026-09-12T10:00:00.000Z') as unknown as Record<
      string,
      unknown
    >;
    (forward.facts as Record<string, unknown>).somethingNew = 'from v2';
    const file = writeSpool('sess-1-forward.json', forward);
    const summary = await drainSpool({apply: applied, ctx: CTX, env});
    expect(summary?.applied).toBe(1);
    expect(existsSync(file)).toBe(false);
  });
});

/**
 * F10 — two `thread board` runs used to read the same listing and both apply
 * every file in it. The loser wrote a duplicate report or got a refusal for
 * asks the winner had already closed, then printed a 🚨 STILL SPOOLED line for a
 * file that no longer existed. The lock is one atomic rename.
 */
describe('the drain lock (F10)', () => {
  test('two concurrent drains apply each file EXACTLY once', async () => {
    for (const name of ['sess-1-x.json', 'sess-1-y.json', 'sess-1-z.json']) {
      writeSpool(name, spooled('2026-09-12T10:00:00.000Z'));
    }
    const seen: string[] = [];
    // Yields between the claim and the apply, which is precisely the window the
    // old code left open — both drains had listed all three files by then.
    const slow: SpoolApplier = async (report) => {
      await new Promise((done) => setTimeout(done, 5));
      seen.push(report.reportedAt);
      return applied(report, CTX);
    };
    const [a, b] = await Promise.all([
      drainSpool({apply: slow, ctx: CTX, env}),
      drainSpool({apply: slow, ctx: CTX, env}),
    ]);

    expect(seen).toHaveLength(3); // not 6
    expect((a?.applied ?? 0) + (b?.applied ?? 0)).toBe(3);
    expect((a?.kept ?? 0) + (b?.kept ?? 0)).toBe(0);
    expect(
      (a?.skippedConcurrent ?? 0) + (b?.skippedConcurrent ?? 0),
    ).toBeGreaterThan(0);
    expect(readdirSync(spoolDir(env))).toEqual([]);
  });

  test('a kept file goes back under its ORIGINAL name, ready for the next drain', async () => {
    writeSpool('sess-1-keep.json', spooled('2026-09-12T10:00:00.000Z'));
    const first = await drainSpool({apply: bdFailed, ctx: CTX, env});
    expect(first?.kept).toBe(1);
    expect(readdirSync(spoolDir(env))).toEqual(['sess-1-keep.json']);

    // And the next drain, with bd back, applies it.
    const second = await drainSpool({apply: applied, ctx: CTX, env});
    expect(second?.applied).toBe(1);
    expect(readdirSync(spoolDir(env))).toEqual([]);
  });

  test('a file stranded by a DEAD drain is reclaimed and replayed', async () => {
    // 999999 is above macOS's pid ceiling, so `process.kill(pid, 0)` reports
    // ESRCH — a MEASURED "that process is gone", not a guess.
    writeSpool(
      'sess-1-dead.json.inflight-999999',
      spooled('2026-09-12T10:00:00.000Z'),
    );
    const summary = await drainSpool({apply: applied, ctx: CTX, env});
    expect(summary?.reclaimed).toBe(1);
    expect(summary?.applied).toBe(1);
    expect(readdirSync(spoolDir(env))).toEqual([]);
    expect(renderDrain(summary).join('\n')).toContain('reclaimed');
  });

  test('a file held by a LIVE drain is left alone', async () => {
    const held = writeSpool(
      `sess-1-live.json.inflight-${process.pid}`,
      spooled('2026-09-12T10:00:00.000Z'),
    );
    const summary = await drainSpool({apply: applied, ctx: CTX, env});
    expect(summary?.reclaimed).toBe(0);
    expect(summary?.applied).toBe(0);
    expect(existsSync(held)).toBe(true);
  });

  test('an inflight file is invisible to the listing — it cannot be applied twice', async () => {
    writeSpool(
      'sess-1-busy.json.inflight-1',
      spooled('2026-09-12T10:00:00.000Z'),
    );
    let reached = 0;
    const counting: SpoolApplier = async (report) => {
      reached += 1;
      return applied(report, CTX);
    };
    await drainSpool({apply: counting, ctx: CTX, env});
    // pid 1 (launchd) is alive, so it is neither reclaimed nor drained.
    expect(reached).toBe(0);
  });
});

describe('renderDrain', () => {
  test('a kept file is loud; an applied one is a count', async () => {
    writeSpool('sess-1-e.json', spooled('2026-09-12T10:00:00.000Z'));
    const summary = await drainSpool({apply: bdFailed, ctx: CTX, env});
    const lines = renderDrain(summary);
    expect(lines[0]).toContain('STILL SPOOLED');
    expect(lines.join('\n')).toContain('🚨');
  });

  test('an unreadable spool DIRECTORY is a warning, not silence', () => {
    expect(renderDrain(null)[0]).toContain(
      'could not read the spool directory',
    );
  });
});
