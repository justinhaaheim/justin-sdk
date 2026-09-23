/**
 * The runner cannot be wedged by a child process that will not let go
 * (home-base-a1go).
 *
 * These are PROCESS-LEVEL tests: real executables, real pipes and the real
 * `runChild` — no injected fakes, because the bug being fixed lived entirely in
 * the seam between this process and a child's stdio. A scripted world could not
 * have shown it and cannot guard it.
 *
 * TWO LAYERS. The first describe drives `runChild` directly. The second drives
 * the RUNNER'S OWN functions — `listAgents`, `gitHead`, `preflight` — against
 * the same fakes, because "the helper is bounded" and "the runner uses the
 * helper" are different claims and only the second one is the bug.
 *
 * THE NEGATIVE CONTROL was run once, on the OLD synchronous path, before any of
 * this existed (recorded in home-base-a1go's notes): the same pipe-holder fake
 * through `spawnSync` with no timeout blocked for 120_015ms — the full life of
 * the grandchild — and reported `status: 0, error: null`, i.e. success. With a
 * 2000ms timeout it consumed the whole 2002ms rather than the ~1ms the child
 * actually took. Every bound asserted below is a bound that path did not have.
 *
 * THE SECOND LAYER WAS CONTROLLED THE SAME WAY, four times, by breaking the
 * runner and watching exactly one assertion redden each time:
 *   - `listAgents` put back on `spawnSync` with no timeout → the wedge test sat
 *     on the grandchild's pipe until bun's 5s per-test limit and failed on
 *     `ms < 2000` (received 5001), nothing else;
 *   - the failure derived from `status !== 0` instead of
 *     `describeChildFailure` → both timeout tests failed on the reason text
 *     ("claude agents --json exited" where the timeout should be named);
 *   - a timed-out HEAD read allowed through as a success → the git test failed
 *     on `ok === false`, returning `ok: true` carrying the half-line the fake
 *     had managed to print;
 *   - the preflight message put back to "claude CLI not found on PATH" → the
 *     version test failed on `toHaveLength(1)`, received 0.
 */
import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import {chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {describeChildFailure, runChild} from '../src/justin-loop/child';
import {
  CLAUDE_BIN_ENV,
  gitHead,
  listAgents,
  preflight,
} from '../src/justin-loop/runner';

/**
 * The three shapes a child can take when it will not let go, as real files.
 *
 * `sleep` is deliberately short (20s): long enough that any of these outlasting
 * its bound is unambiguous, short enough that a stray grandchild is gone before
 * anyone notices. Every `claude` call the runner makes is a subcommand, so the
 * fakes ignore their argv and behave the same for `agents --json`, `stop` and
 * `--version` alike.
 */
const FAKES: Record<string, string[]> = {
  /**
   * Exits AT ONCE, leaving a grandchild holding the inherited stdout. This is
   * the measured wedge: `spawnSync` waits for the PIPE, so it sat here for the
   * grandchild's whole life. `runChild` must answer in about the exit grace.
   */
  'exits-leaving-pipe-holder': [
    '#!/bin/sh',
    'echo "[]"',
    'sleep 20 &',
    'exit 0',
  ],
  /**
   * Never exits AND leaves a grandchild holding stdout — the worst case, and
   * the one that proves the timeout answers without waiting on the pipe: even
   * after the direct child is SIGKILLed, the write end is still open.
   */
  'hangs-holding-pipe': ['#!/bin/sh', 'echo "["', 'sleep 20 &', 'sleep 20'],
  /** Never exits. The plain hang. */
  'never-exits': ['#!/bin/sh', 'echo "["', 'sleep 20'],
  /** Exits non-zero with a message on stderr, like a refusing `claude`. */
  refuses: ['#!/bin/sh', 'echo "nope" >&2', 'exit 3'],
};

let fakeDir: string;

/** The absolute path of one fake, named as `claude` inside its own directory. */
function fake(name: keyof typeof FAKES): string {
  return join(fakeDir, name, 'claude');
}

/**
 * A directory holding a `git` that never exits, for prepending to PATH.
 *
 * The HEAD-sha read is the one call here that does NOT go through
 * `resolveClaudeBin`, so PATH is its injection point — and PATH is enough
 * precisely because `runChild` passes `process.env` to `spawn`, which resolves
 * a bare name against the PATH it is handed.
 */
let fakeGitDir: string;

beforeAll(() => {
  fakeDir = mkdtempSync(join(tmpdir(), 'justin-loop-hang-'));
  for (const [name, lines] of Object.entries(FAKES)) {
    const dir = join(fakeDir, name);
    mkdirSync(dir, {recursive: true});
    const bin = join(dir, 'claude');
    writeFileSync(bin, `${lines.join('\n')}\n`);
    chmodSync(bin, 0o755);
  }
  fakeGitDir = join(fakeDir, 'fake-git');
  mkdirSync(fakeGitDir, {recursive: true});
  const git = join(fakeGitDir, 'git');
  writeFileSync(git, `${(FAKES['never-exits'] ?? []).join('\n')}\n`);
  chmodSync(git, 0o755);
});

afterAll(() => {
  rmSync(fakeDir, {force: true, recursive: true});
});

async function timed<T>(body: () => Promise<T>): Promise<{ms: number; v: T}> {
  const at = Date.now();
  const v = await body();
  return {ms: Date.now() - at, v};
}

describe('runChild: a child that will not let go cannot hold the runner', () => {
  test('a child that exits leaving a grandchild on the pipe answers at once', async () => {
    // THE REGRESSION TEST for the measured wedge. The old path returned after
    // 120_015ms here; anything under a second is a different mechanism
    // entirely. The timeout is 10s and is NOT what rescues this — the point is
    // that it is never reached.
    const {ms, v} = await timed(() =>
      runChild(fake('exits-leaving-pipe-holder'), ['agents', '--json'], {
        timeoutMs: 10_000,
      }),
    );
    expect(v.timedOut).toBe(false);
    expect(v.status).toBe(0);
    expect(v.stdout.trim()).toBe('[]');
    expect(describeChildFailure('claude agents --json', v)).toBeNull();
    expect(ms).toBeLessThan(2_000);
  });

  test('a child that hangs AND holds the pipe is killed and reported, on time', async () => {
    // The worst case: SIGKILLing the child does not close the pipe, because the
    // grandchild still has it. Answering must not depend on that pipe at all.
    const {ms, v} = await timed(() =>
      runChild(fake('hangs-holding-pipe'), ['agents', '--json'], {
        timeoutMs: 1_000,
      }),
    );
    expect(v.timedOut).toBe(true);
    expect(describeChildFailure('claude agents --json', v)).toBe(
      'claude agents --json did not finish within 1000ms and was SIGKILLed',
    );
    expect(ms).toBeGreaterThanOrEqual(1_000);
    expect(ms).toBeLessThan(3_000);
  });

  test('a child that never exits is killed and reported, on time', async () => {
    const {ms, v} = await timed(() =>
      runChild(fake('never-exits'), ['agents', '--json'], {timeoutMs: 1_000}),
    );
    expect(v.timedOut).toBe(true);
    expect(v.status).toBeNull();
    expect(describeChildFailure('claude agents --json', v)).toContain(
      'was SIGKILLed',
    );
    expect(ms).toBeLessThan(3_000);
  });

  test('a binary that is not there is an ERROR, not an empty result', async () => {
    const v = await runChild(join(fakeDir, 'no-such-binary'), [], {
      timeoutMs: 1_000,
    });
    expect(v.error).not.toBeNull();
    expect(v.timedOut).toBe(false);
    expect(describeChildFailure('claude agents --json', v)).toContain(
      'could not run',
    );
  });

  test('a non-zero exit keeps its stderr and its code', async () => {
    const v = await runChild(fake('refuses'), ['stop', 'abc'], {
      timeoutMs: 5_000,
    });
    expect(v.status).toBe(3);
    expect(v.stderr.trim()).toBe('nope');
    expect(v.timedOut).toBe(false);
    expect(describeChildFailure('claude stop', v)).toBe('claude stop exited 3');
  });

  test('output past the buffer is TRUNCATED, not quietly short', async () => {
    // A child that outruns `maxBufferBytes` is the fourth failure mode
    // `describeChildFailure` orders, and the only one whose result still looks
    // like a success: status 0, no timeout, and stdout that parses. Left
    // unnamed it is critical rule 6 exactly — half a listing read as the whole
    // listing, so a session that is still there reads as gone.
    const v = await runChild(
      '/bin/sh',
      ['-c', 'printf "%s" "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; exit 0'],
      {maxBufferBytes: 8, timeoutMs: 5_000},
    );
    expect(v.status).toBe(0);
    expect(v.timedOut).toBe(false);
    expect(v.truncated).toBe(true);
    expect(v.stdout).toHaveLength(8);
    expect(describeChildFailure('claude agents --json', v)).toBe(
      'claude agents --json produced more output than the buffer allows, so what came back is incomplete',
    );
  });

  test('output written just before the exit is not clipped', async () => {
    // The grace period exists for exactly this, and nothing else. Without it,
    // answering on `exit` would race the last write.
    const v = await runChild('/bin/sh', ['-c', 'printf "hello"; exit 0'], {
      timeoutMs: 5_000,
    });
    expect(v.stdout).toBe('hello');
    expect(describeChildFailure('sh', v)).toBeNull();
  });
});

/**
 * The RUNNER'S OWN calls, against the same fakes.
 *
 * The layer above proves the helper is bounded. These prove the runner actually
 * goes through it — the distinction that matters, because the wedge was never in
 * a helper: it was in `listAgents` calling `spawnSync` directly. Every call here
 * is the real exported function, spawning a real process.
 *
 * Injection differs by call, and that difference IS the design:
 *   - the `claude` calls resolve their binary through `resolveClaudeBin()`, so
 *     `JUSTIN_LOOP_CLAUDE_BIN` points them at a fake;
 *   - the HEAD read spawns a bare `git`, so PATH points it at a fake.
 */
describe('the runner routes its own child calls through runChild', () => {
  const SLACK_MS = 2_000;

  /** Point every `claude` the runner spawns at one fake, then put it back. */
  async function withClaude<T>(
    bin: string,
    body: () => Promise<T>,
  ): Promise<T> {
    const original = process.env[CLAUDE_BIN_ENV];
    process.env[CLAUDE_BIN_ENV] = bin;
    try {
      return await body();
    } finally {
      if (original == null) delete process.env[CLAUDE_BIN_ENV];
      else process.env[CLAUDE_BIN_ENV] = original;
    }
  }

  /** Put the never-exiting `git` first on PATH, then put PATH back. */
  async function withFakeGit<T>(body: () => Promise<T>): Promise<T> {
    const original = process.env.PATH;
    process.env.PATH = `${fakeGitDir}:${original ?? ''}`;
    try {
      return await body();
    } finally {
      process.env.PATH = original;
    }
  }

  test('listAgents SUCCEEDS against a claude that leaves a grandchild on the pipe', async () => {
    // THE REGRESSION TEST (home-base-a1go). This is the measured wedge, driven
    // through the real `listAgents`: the fake prints its JSON, backgrounds a
    // 20s sleep holding the inherited stdout, and exits 0 at once. The old
    // `spawnSync` sat on the pipe for the grandchild's whole life — 120_015ms
    // when it was measured with a 120s sleep — and the 60s timeout would have
    // turned that into a FAILED poll five times over, which is
    // `agents-unreadable` and the end of the run.
    const {ms, v} = await timed(() =>
      withClaude(fake('exits-leaving-pipe-holder'), () =>
        listAgents(import.meta.dirname, 10_000),
      ),
    );
    expect(v.ok).toBe(true);
    expect(v.ok ? v.rows : null).toEqual([]);
    expect(ms).toBeLessThan(SLACK_MS);
  });

  test('listAgents against a claude that never exits names the timeout and the kill', async () => {
    const {ms, v} = await timed(() =>
      withClaude(fake('never-exits'), () =>
        listAgents(import.meta.dirname, 1_000),
      ),
    );
    expect(v.ok).toBe(false);
    expect(v.ok ? '' : v.reason).toContain('did not finish within 1000ms');
    expect(v.ok ? '' : v.reason).toContain('SIGKILL');
    expect(ms).toBeLessThan(1_000 + SLACK_MS);
  });

  test('listAgents against a claude that hangs AND holds the pipe still answers', async () => {
    // The worst case: the SIGKILL does not close the pipe, because the
    // grandchild has it. Half a JSON document is on that pipe, and a failure
    // that returned it as rows would be worse than one that hung.
    const {ms, v} = await timed(() =>
      withClaude(fake('hangs-holding-pipe'), () =>
        listAgents(import.meta.dirname, 1_000),
      ),
    );
    expect(v.ok).toBe(false);
    expect(v.ok ? '' : v.reason).toContain('did not finish within 1000ms');
    expect(ms).toBeLessThan(1_000 + SLACK_MS);
  });

  test('the HEAD read against a git that never exits is a REASON, not a null', async () => {
    // The positional suspect for the 717s silence: this read runs the instant a
    // session ends, and before home-base-a1go it had no timeout at all.
    const {ms, v} = await timed(() =>
      withFakeGit(() => gitHead(import.meta.dirname, 1_000)),
    );
    expect(v.ok).toBe(false);
    expect(v.ok ? '' : v.reason).toContain('git rev-parse HEAD');
    expect(v.ok ? '' : v.reason).toContain('did not finish within 1000ms');
    expect(v.ok ? '' : v.reason).toContain('SIGKILL');
    expect(ms).toBeLessThan(1_000 + SLACK_MS);
  });

  test('a claude that never answers --version is a TIMEOUT, not "not found"', async () => {
    // Preflight's version probe was the other unbounded call. A CLI that is
    // installed but wedged must not be reported as a CLI that is missing —
    // "not found on PATH" sends you looking for the wrong thing, and it is the
    // reassuring direction: it reads like a setup mistake rather than a machine
    // in a bad state.
    const {ms, v} = await timed(() =>
      withClaude(fake('never-exits'), () =>
        preflight(import.meta.dirname, 1_000),
      ),
    );
    const timeouts = v.filter((p) =>
      p.message.includes('did not finish within 1000ms'),
    );
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]?.fatal).toBe(true);
    expect(timeouts[0]?.message).toContain('SIGKILL');
    expect(v.some((p) => p.message.includes('not found'))).toBe(false);
    // …and the git repo it was pointed at read fine, so nothing here is a
    // failure of the directory.
    expect(v.some((p) => p.message.includes('could not read HEAD'))).toBe(
      false,
    );
    expect(ms).toBeLessThan(1_000 + SLACK_MS);
  });
});
