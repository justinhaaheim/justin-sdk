/**
 * The runner cannot be wedged by a child process that will not let go
 * (home-base-a1go).
 *
 * These are PROCESS-LEVEL tests: real executables, real pipes and the real
 * `runChild` — no injected fakes, because the bug being fixed lived entirely in
 * the seam between this process and a child's stdio. A scripted world could not
 * have shown it and cannot guard it.
 *
 * SCOPE TODAY: the helper itself. The runner's own calls (`listAgents`,
 * `stopSession`, the HEAD-sha read, the preflight `claude --version`) are NOT
 * routed through it yet — that is the rest of home-base-a1go, and until it lands
 * those calls are still synchronous and the two untimed ones are still
 * unbounded. Nothing below should be read as covering them.
 *
 * THE NEGATIVE CONTROL was run once, on the OLD synchronous path, before any of
 * this existed (recorded in home-base-a1go's notes): the same pipe-holder fake
 * through `spawnSync` with no timeout blocked for 120_015ms — the full life of
 * the grandchild — and reported `status: 0, error: null`, i.e. success. With a
 * 2000ms timeout it consumed the whole 2002ms rather than the ~1ms the child
 * actually took. Every bound asserted below is a bound that path did not have.
 */
import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import {chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {describeChildFailure, runChild} from '../src/justin-loop/child';

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
function fake(name: keyof typeof FAKES | string): string {
  return join(fakeDir, name, 'claude');
}

beforeAll(() => {
  fakeDir = mkdtempSync(join(tmpdir(), 'justin-loop-hang-'));
  for (const [name, lines] of Object.entries(FAKES)) {
    const dir = join(fakeDir, name);
    mkdirSync(dir, {recursive: true});
    const bin = join(dir, 'claude');
    writeFileSync(bin, `${lines.join('\n')}\n`);
    chmodSync(bin, 0o755);
  }
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
