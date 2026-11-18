/**
 * home-base-iprgd: a child-process call settles as failed at its deadline even
 * when the child's exit is never reported, with its program named, and never
 * as empty output (critical rule 7).
 *
 * Two layers. The helper is driven with a fake child whose exit never comes,
 * which is what Bun issue #45483 does to execFile's callback. The real cmux
 * runner is driven with a fake cmux that ignores the runner's SIGTERM, so no
 * exit arrives by the deadline through the real execFile path either.
 *
 * NEGATIVE CONTROLS (run 2026-11-18 on Bun 1.4.2, each restored after):
 * - The deadline timer without its `settle(input.late())`: the four
 *   deadline tests here failed on `Received: "still waiting"`, and the cmux
 *   test failed on its reason (the SIGKILL still ended the fake cmux, so
 *   execFile reported "timed out after 200 ms" instead of the deadline).
 * - The SIGKILL without its `reportedExited` guard: the two "never sent
 *   kill" tests failed on `expect(signals).toEqual([])`, receiving
 *   ["SIGKILL"].
 * Measured once in a scratch test, the same day: after a real `true` child's
 * exit event, spawn and execFile children both read exitCode 0 and
 * signalCode null, and kill('SIGKILL') returned false; a sleep killed by
 * SIGTERM read exitCode null, signalCode "SIGTERM", and kill() returned
 * false.
 */
import {afterEach, describe, expect, test} from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {
  EXIT_GRACE_MS,
  noExitReason,
  settleByDeadline,
} from '../src/exit-deadline';
import {realCmuxRunner} from '../src/thread/cmux';

const STILL_WAITING = 'still waiting';

/** The call's outcome, or STILL_WAITING when it has not settled within `ms`. */
async function within<T>(
  call: Promise<T>,
  ms: number,
): Promise<T | typeof STILL_WAITING> {
  return await Promise.race([
    call,
    Bun.sleep(ms).then(() => STILL_WAITING as typeof STILL_WAITING),
  ]);
}

function fakeChild(
  reported: {exitCode?: number | null; signalCode?: string | null} = {},
): {
  child: {
    exitCode?: number | null;
    kill: (signal?: NodeJS.Signals | number) => boolean;
    signalCode?: string | null;
  };
  signals: (NodeJS.Signals | number | undefined)[];
} {
  const signals: (NodeJS.Signals | number | undefined)[] = [];
  return {
    child: {
      ...reported,
      kill: (signal) => {
        signals.push(signal);
        return true;
      },
    },
    signals,
  };
}

describe('settleByDeadline', () => {
  test('a call whose exit never comes settles failed at the deadline, and its child gets SIGKILL', async () => {
    const {child, signals} = fakeChild();
    const started = performance.now();
    const outcome = await within(
      settleByDeadline<string>({
        deadlineMs: 50,
        late: () => 'failed: no exit',
        start: () => child,
      }),
      3000,
    );
    expect(outcome).toBe('failed: no exit');
    expect(performance.now() - started).toBeGreaterThanOrEqual(45);
    expect(signals).toEqual(['SIGKILL']);
  });

  test('a child with exitCode and signalCode both null is sent SIGKILL at the deadline', async () => {
    const {child, signals} = fakeChild({exitCode: null, signalCode: null});
    const outcome = await within(
      settleByDeadline<string>({
        deadlineMs: 30,
        late: () => 'failed: no exit',
        start: () => child,
      }),
      3000,
    );
    expect(outcome).toBe('failed: no exit');
    expect(signals).toEqual(['SIGKILL']);
  });

  test('a child already reported exited (exitCode set) is never sent kill, and the call still settles failed', async () => {
    // Bun #45483: the child was reaped and its exit emitted before anyone
    // listened. Its pid may belong to another process by now.
    const {child, signals} = fakeChild({exitCode: 0, signalCode: null});
    const outcome = await within(
      settleByDeadline<string>({
        deadlineMs: 30,
        late: () => 'failed: no exit',
        start: () => child,
      }),
      3000,
    );
    expect(outcome).toBe('failed: no exit');
    expect(signals).toEqual([]);
  });

  test('a child already reported killed (signalCode set) is never sent kill, and the call still settles failed', async () => {
    const {child, signals} = fakeChild({exitCode: null, signalCode: 'SIGTERM'});
    const outcome = await within(
      settleByDeadline<string>({
        deadlineMs: 30,
        late: () => 'failed: no exit',
        start: () => child,
      }),
      3000,
    );
    expect(outcome).toBe('failed: no exit');
    expect(signals).toEqual([]);
  });

  test('a call that settles first keeps its outcome; nothing is killed and the deadline never fires', async () => {
    const {child, signals} = fakeChild();
    let lateCalls = 0;
    const outcome = await settleByDeadline<string>({
      deadlineMs: 150,
      late: () => {
        lateCalls += 1;
        return 'failed: no exit';
      },
      start: (settle) => {
        setTimeout(() => settle('ok'), 10);
        return child;
      },
    });
    expect(outcome).toBe('ok');
    await Bun.sleep(250);
    expect(lateCalls).toBe(0);
    expect(signals).toEqual([]);
  });

  test('an exit reported after the deadline is ignored', async () => {
    let settleLater: ((outcome: string) => void) | null = null;
    const outcome = await settleByDeadline<string>({
      deadlineMs: 30,
      late: () => 'failed: no exit',
      start: (settle) => {
        settleLater = settle;
        return null;
      },
    });
    expect(outcome).toBe('failed: no exit');
    expect(() => settleLater?.('ok')).not.toThrow();
  });

  test('a call that settles while starting (the spawn threw) keeps that outcome', async () => {
    const outcome = await settleByDeadline<string>({
      deadlineMs: 30,
      late: () => 'failed: no exit',
      start: (settle) => {
        settle('failed: could not start');
        return null;
      },
    });
    expect(outcome).toBe('failed: could not start');
  });

  test('no deadline: the call waits for its own outcome', async () => {
    let lateCalls = 0;
    const outcome = await settleByDeadline<string>({
      deadlineMs: null,
      late: () => {
        lateCalls += 1;
        return 'failed: no exit';
      },
      start: (settle) => {
        setTimeout(() => settle('ok'), 60);
        return null;
      },
    });
    expect(outcome).toBe('ok');
    expect(lateCalls).toBe(0);
  });

  test('a start that throws rejects, rather than waiting for a deadline', async () => {
    let rejected: unknown = null;
    try {
      await settleByDeadline<string>({
        deadlineMs: 5000,
        late: () => 'failed: no exit',
        start: () => {
          throw new Error('spawn EPERM');
        },
      });
    } catch (error) {
      rejected = error;
    }
    expect(rejected instanceof Error && rejected.message).toBe('spawn EPERM');
  });
});

describe('noExitReason', () => {
  test('names what ran, the deadline and the kill', () => {
    expect(noExitReason('git status --porcelain', 35_000, 30_000)).toBe(
      'git status --porcelain gave no exit within 35 s (it was to be stopped at 30 s), so it counts as failed',
    );
    expect(noExitReason('bun cli.ts thread inbox', 300_000, null)).toBe(
      'bun cli.ts thread inbox gave no exit within 300 s, so it counts as failed',
    );
  });
});

describe('the real cmux runner, against a cmux that never exits', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, {force: true, recursive: true});
    }
  });

  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  test('settles failed and timed out at its kill plus the grace, naming cmux, and the child is killed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'exit-deadline-'));
    dirs.push(dir);
    const pidFile = join(dir, 'cmux.pid');
    const fake = join(dir, 'cmux');
    // Ignores the runner's SIGTERM, and `exec` keeps that for sleep, so no
    // exit is reported until the deadline's SIGKILL.
    writeFileSync(
      fake,
      `#!/bin/sh\necho $$ > ${JSON.stringify(pidFile)}\ntrap '' TERM\nexec sleep 60\n`,
    );
    chmodSync(fake, 0o755);
    const {CMUX_SOCKET_PATH: _socket, ...env} = process.env;
    const killAtMs = 200;
    const started = performance.now();
    const call = await within(
      realCmuxRunner(killAtMs, {...env, CMUX_CLAUDE_HOOK_CMUX_BIN: fake})([
        'ping',
      ]),
      killAtMs + EXIT_GRACE_MS + 8000,
    );
    expect(call).not.toBe(STILL_WAITING);
    if (call === STILL_WAITING) return;
    expect(call.kind).toBe('failed');
    expect(call.kind === 'failed' && call.timedOut).toBe(true);
    expect(call.kind === 'failed' && call.reason).toBe(
      noExitReason('cmux ping', killAtMs + EXIT_GRACE_MS, killAtMs),
    );
    expect(performance.now() - started).toBeGreaterThanOrEqual(
      killAtMs + EXIT_GRACE_MS - 50,
    );
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    const deadline = Date.now() + 3000;
    while (alive(pid) && Date.now() < deadline) await Bun.sleep(25);
    expect(alive(pid)).toBe(false);
  }, 30_000);

  test('control: a cmux that answers is unaffected by the deadline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'exit-deadline-'));
    dirs.push(dir);
    const fake = join(dir, 'cmux');
    writeFileSync(fake, '#!/bin/sh\necho PONG\n');
    chmodSync(fake, 0o755);
    const {CMUX_SOCKET_PATH: _socket, ...env} = process.env;
    const call = await realCmuxRunner(10_000, {
      ...env,
      CMUX_CLAUDE_HOOK_CMUX_BIN: fake,
    })(['ping']);
    expect(call).toEqual({kind: 'ok', stdout: 'PONG\n'});
  });
});
