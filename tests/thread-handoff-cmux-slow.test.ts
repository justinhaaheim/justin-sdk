/**
 * A slow cmux never ends a handoff chain (home-base-89c8h.1). A timeout is
 * retried, a timeout alone never makes a final refusal, a real refusal stays
 * final, and nothing that writes is ever retried.
 *
 * Real br and the real handOff() in $TMPDIR worlds. cmux and the clock are
 * fakes, except in the last block, which runs the real cmux binary against a
 * socket this test owns that accepts and never answers. Nothing reaches the
 * live cmux socket, and no tab or workspace is touched.
 */

import type {CmuxCall, CmuxRunner} from '../src/thread/cmux';
import type {
  HandoffGateReaders,
  HandoffGateResult,
} from '../src/thread/handoff-gate';
import type {HandoffGateRunner} from '../src/thread/handoff-successor';
import type {LiveSessionDeps} from '../src/thread/live-sessions';
import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'fs';
import {createServer, type Server, type Socket} from 'net';
import {tmpdir} from 'os';
import {join} from 'path';

import {brShow, runBr} from '../src/beads/br';
import {
  CMUX_CLI_TIMEOUT_ENV,
  CMUX_TIMEOUT_MS,
  gateCmuxRunner,
  readPaneOfSurface,
  realCmuxRunner,
} from '../src/thread/cmux';
import {cmuxCallIsReadOnly} from '../src/thread/cmux-read-only';
import {
  realChainReaders,
  walkUnattendedChain,
} from '../src/thread/handoff-chain';
import {
  gateCmuxReaders,
  HANDOFF_DEFERRAL_INSTRUCTIONS,
  HANDOFF_GATE_DEADLINE_MS,
  readLaunchRecord,
  runHandoffGate,
} from '../src/thread/handoff-gate';
import {threadHandoffCommand} from '../src/thread/handoff-successor';
import {ensureSessionBead} from '../src/thread/session-bead';
import {selectSession} from '../src/thread/session-select';
import {spawnGate} from '../src/thread/spawn-gate';
import {initRepo} from './git-fixtures';
import {needBr} from './pinned-br';
import {createSandbox} from './sandbox';

/** The session idle-claude.txt's status line shows. */
const SID = 'aa693548-b000-4b39-8cf4-90a380854827';
const WS = 'AAAA0000-1111-4222-8333-0000000000b2';
const SURF = 'CCCC0000-1111-4222-8333-0000000000c3';
const PANE = 'DDDD0000-1111-4222-8333-0000000000d4';
const NOW = new Date('2030-01-01T10:00:00.000Z');
const IDLE_SCREEN = readFileSync(
  join(import.meta.dir, 'fixtures/handoff-predecessor/idle-claude.txt'),
  'utf8',
);
const STARTED_SCREEN = readFileSync(
  join(import.meta.dir, 'fixtures/handoff-successor/claude-up-working.txt'),
  'utf8',
);
const PANE_TREE = JSON.stringify({
  windows: [
    {
      workspaces: [
        {
          id: WS,
          panes: [
            {
              id: PANE,
              ref: 'pane:285',
              surfaces: [{id: SURF, ref: 'surface:300'}],
            },
          ],
          ref: 'workspace:191',
        },
      ],
    },
  ],
});
const LIVE_TREE = JSON.stringify({windows: []});

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

interface World {
  beadId: string;
  env: Record<string, string | undefined>;
  repo: string;
  sandboxPath: string;
}

function world(): World {
  needBr();
  const sb = createSandbox();
  sandboxes.push(sb);
  const xdg = join(sb.path, 'xdg');
  mkdirSync(join(xdg, 'justin-sdk'), {recursive: true});
  writeFileSync(
    join(xdg, 'justin-sdk', 'config.json'),
    JSON.stringify({
      componentConfig: {
        thread: {
          enabled: true,
          handoff: {successor: true},
          sessionBeads: true,
        },
      },
    }),
  );
  const env: Record<string, string | undefined> = {
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SESSION_ID: SID,
    CMUX_SOCKET_PATH: '/tmp/handoff-cmux-slow-test/cmux.sock',
    CMUX_SURFACE_ID: SURF,
    CMUX_WORKSPACE_ID: WS,
    HOME: join(sb.path, 'home'),
    JUSTIN_SDK_HEALTH_NOTICES: 'off',
    JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state'),
    JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(sb.path, 'projects'),
    XDG_CONFIG_HOME: xdg,
  };
  const repo = initRepo(sb, 'slow-repo', {'README.md': '# r\n'});
  const init = runBr(repo, ['init', '--prefix', 't', '-q']);
  if (!init.ok) throw new Error(`br init failed: ${init.reason ?? '?'}`);
  const filed = ensureSessionBead({
    cwd: repo,
    env,
    firstPrompt: {at: '2030-01-01T09:00:00.000Z', text: 'migrate the db'},
    now: new Date('2030-01-01T09:00:00.000Z'),
    sessionId: SID,
  });
  if (filed.kind !== 'created') throw new Error(filed.detail);
  return {beadId: filed.beadId, env, repo, sandboxPath: sb.path};
}

function beadOf(w: World) {
  const shown = brShow({cwd: w.repo}, w.beadId);
  if (shown.kind !== 'ok') throw new Error(`br show: ${shown.kind}`);
  return shown.issue;
}

/** Time passes only when a call burns its limit or something sleeps. */
function fakeClock() {
  let at = 1_000_000;
  const sleeps: number[] = [];
  return {
    advance: (ms: number) => {
      at += ms;
    },
    elapsed: () => at - 1_000_000,
    now: () => at,
    sleep: (ms: number) => {
      sleeps.push(ms);
      at += ms;
      return Promise.resolve();
    },
    sleeps,
  };
}
type Clock = ReturnType<typeof fakeClock>;

type Verb = 'liveTree' | 'newSurface' | 'paneTree' | 'ping' | 'readScreen';

function verbOf(args: readonly string[]): string {
  if (args.includes('--all')) return 'liveTree';
  if (args.includes('tree')) return 'paneTree';
  if (args[0] === 'new-surface') return 'newSurface';
  if (args[0] === 'read-screen') return 'readScreen';
  if (args[0] === 'ping') return 'ping';
  return args[0] ?? '';
}

/**
 * A fake cmux. Each verb answers normally unless `hang` says to burn the whole
 * limit and time out: every call, or the first N calls of that verb.
 */
function fakeCmux(
  clock: Clock,
  input: {
    fail?: Partial<Record<Verb, string>>;
    hang?: Partial<Record<Verb, number | 'always'>>;
  } = {},
) {
  const calls: string[] = [];
  const limits: number[] = [];
  const seen = new Map<string, number>();
  let screens = 0;
  const run: CmuxRunner = (args, limit) => {
    const verb = verbOf(args);
    calls.push(verb);
    if (limit != null) limits.push(limit.timeoutMs);
    const count = (seen.get(verb) ?? 0) + 1;
    seen.set(verb, count);
    const hang = input.hang?.[verb as Verb];
    if (hang === 'always' || (hang != null && count <= hang)) {
      clock.advance(limit?.timeoutMs ?? CMUX_TIMEOUT_MS);
      return Promise.resolve({
        kind: 'failed',
        reason: `cmux ${verb} timed out`,
        timedOut: true,
      });
    }
    const fail = input.fail?.[verb as Verb];
    if (fail != null) {
      return Promise.resolve({kind: 'failed', reason: fail, timedOut: false});
    }
    const answers: Record<string, string> = {
      liveTree: LIVE_TREE,
      newSurface: 'OK surface:306 pane:285 workspace:191\n',
      paneTree: PANE_TREE,
      ping: 'PONG',
      'rename-tab': 'OK\n',
    };
    if (verb === 'readScreen') {
      screens += 1;
      // The first screen is the caller's; later ones are the successor's tab.
      return Promise.resolve({
        kind: 'ok',
        stdout: screens === 1 ? IDLE_SCREEN : STARTED_SCREEN,
      });
    }
    return Promise.resolve({kind: 'ok', stdout: answers[verb] ?? 'OK\n'});
  };
  return {calls, limits, run};
}
type FakeCmux = ReturnType<typeof fakeCmux>;

function usage(weekPct: number): HandoffGateReaders['usage'] {
  const window = (pct: number) => ({
    pct,
    resetsAt: null,
    resetsAtError: null,
    resetsText: null,
  });
  return () => ({
    kind: 'ok',
    lastLineUnreadable: false,
    path: '/fake/samples.jsonl',
    samples: [
      {
        ok: true,
        raw: 'panel',
        sampledAt: new Date(NOW.getTime() - 60_000).toISOString(),
        schema: 1,
        session: window(10),
        week: window(weekPct),
        weekByModel: {},
      },
    ],
    unreadable: [],
  });
}

function fakeLiveSources(
  w: World,
  input: {ps?: LiveSessionDeps['ps']} = {},
): (cmux: CmuxRunner) => LiveSessionDeps {
  const hookStorePath = join(w.sandboxPath, 'hook-store.json');
  writeFileSync(hookStorePath, JSON.stringify({sessions: {}}));
  return (cmux) => ({
    agents: () => Promise.resolve({kind: 'ok', stdout: '[]'}),
    cmux,
    hookStorePath,
    ps:
      input.ps ??
      (() =>
        Promise.resolve({
          kind: 'ok',
          stdout: 'PID PPID TTY ELAPSED COMMAND\n',
        })),
  });
}

/** The real gate over fake readers, with the real gate cmux readers. */
function gateOver(
  w: World,
  clock: Clock,
  cmux: FakeCmux,
  more: {
    readers?: Partial<HandoffGateReaders>;
    sources?: (run: CmuxRunner) => LiveSessionDeps;
  } = {},
): HandoffGateRunner {
  return (input) =>
    runHandoffGate({
      env: input.env,
      limits: input.limits,
      now: input.now,
      readers: {
        chain: null,
        guard: () => ({kind: 'registered', where: []}),
        guardPass: () => ({kind: 'valid', path: '/fake/pass'}),
        killSwitch: () => ({kind: 'off', path: '/fake/off'}),
        launchRecord: null,
        usage: usage(10),
        ...gateCmuxReaders({
          deadlineAtMs: input.cmuxDeadlineAtMs,
          env: input.env,
          liveSources: more.sources ?? fakeLiveSources(w),
          now: clock.now,
          run: cmux.run,
          sleep: clock.sleep,
        }),
        ...more.readers,
      },
    });
}

async function handoff(
  w: World,
  clock: Clock,
  cmux: FakeCmux,
  gate: HandoffGateRunner,
  more: {dryRun?: boolean} = {},
) {
  return await threadHandoffCommand(
    {
      cwd: w.repo,
      dryRun: more.dryRun ?? false,
      env: w.env,
      model: null,
      note: 'pick up at step 3',
      now: NOW,
      sessionId: null,
      to: null,
    },
    {
      clock: clock.now,
      gate,
      run: cmux.run,
      sleep: clock.sleep,
      successorPollMs: 500,
      successorTimeoutMs: 2000,
    },
  );
}

const textOf = (result: {lines: string[]}) => result.lines.join('\n');
const count = (calls: readonly string[], verb: Verb) =>
  calls.filter((call) => call === verb).length;

// ---------------------------------------------------------------------------

describe('gateCmuxRunner (D3)', () => {
  const OK: CmuxCall = {kind: 'ok', stdout: 'PONG'};
  const TIMED_OUT: CmuxCall = {kind: 'failed', reason: 't', timedOut: true};

  function scripted(clock: Clock, answers: CmuxCall[]) {
    const limits: (number | null)[] = [];
    const calls: string[][] = [];
    const run: CmuxRunner = (args, limit) => {
      calls.push([...args]);
      limits.push(limit?.timeoutMs ?? null);
      const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
      if (answer?.kind === 'failed' && answer.timedOut) {
        clock.advance(limit?.timeoutMs ?? 0);
      }
      return Promise.resolve(answer ?? OK);
    };
    return {calls, limits, run};
  }

  test('a timed-out read waits 5 s and runs again', async () => {
    const clock = fakeClock();
    const fake = scripted(clock, [TIMED_OUT, OK]);
    const call = await gateCmuxRunner(fake.run, {
      deadlineAtMs: clock.now() + 60_000,
      now: clock.now,
      retry: true,
      sleep: clock.sleep,
    })(['ping']);
    expect(call).toEqual(OK);
    expect(fake.calls).toEqual([['ping'], ['ping']]);
    expect(clock.sleeps).toEqual([5000]);
  });

  test('each attempt gets the smaller of 30 s and the time left', async () => {
    const clock = fakeClock();
    const fake = scripted(clock, [TIMED_OUT]);
    const call = await gateCmuxRunner(fake.run, {
      deadlineAtMs: clock.now() + 60_000,
      now: clock.now,
      retry: true,
      sleep: clock.sleep,
    })(['ping']);
    expect(call.kind === 'failed' && call.timedOut).toBe(true);
    expect(fake.limits).toEqual([30_000, 25_000]);
    expect(clock.elapsed()).toBeLessThanOrEqual(60_000);
  });

  test('past the deadline it runs nothing and answers timed out', async () => {
    const clock = fakeClock();
    const fake = scripted(clock, [OK]);
    const call = await gateCmuxRunner(fake.run, {
      deadlineAtMs: clock.now(),
      now: clock.now,
      retry: true,
      sleep: clock.sleep,
    })(['ping']);
    expect(fake.calls).toEqual([]);
    expect(call.kind === 'failed' && call.timedOut).toBe(true);
  });

  test('a failure that is not a timeout returns at once', async () => {
    const clock = fakeClock();
    const failed: CmuxCall = {kind: 'failed', reason: 'no', timedOut: false};
    const fake = scripted(clock, [failed, OK]);
    const call = await gateCmuxRunner(fake.run, {
      deadlineAtMs: clock.now() + 60_000,
      now: clock.now,
      retry: true,
      sleep: clock.sleep,
    })(['ping']);
    expect(call).toEqual(failed);
    expect(fake.calls).toHaveLength(1);
  });

  test('retry false: a timed-out read is not retried', async () => {
    const clock = fakeClock();
    const fake = scripted(clock, [TIMED_OUT, OK]);
    await gateCmuxRunner(fake.run, {
      deadlineAtMs: clock.now() + 60_000,
      now: clock.now,
      retry: false,
      sleep: clock.sleep,
    })(['ping']);
    expect(fake.calls).toHaveLength(1);
  });

  // AC 6, at the runner: a timed-out write may have happened.
  test('a timed-out new-surface runs exactly once, even with retry on', async () => {
    const clock = fakeClock();
    const fake = scripted(clock, [TIMED_OUT, OK]);
    const call = await gateCmuxRunner(fake.run, {
      deadlineAtMs: clock.now() + 60_000,
      now: clock.now,
      retry: true,
      sleep: clock.sleep,
    })(['new-surface', '--workspace', WS]);
    expect(call).toEqual(TIMED_OUT);
    expect(fake.calls).toHaveLength(1);
    expect(clock.sleeps).toEqual([]);
  });

  test('the allow-list: reads pass, writes and unknown shapes do not', () => {
    expect(cmuxCallIsReadOnly(['ping'])).toBe(true);
    expect(cmuxCallIsReadOnly(['read-screen', '--surface', 's'])).toBe(true);
    expect(cmuxCallIsReadOnly(['identify'])).toBe(true);
    expect(
      cmuxCallIsReadOnly(['--json', '--id-format', 'both', 'tree', '--all']),
    ).toBe(true);
    expect(
      cmuxCallIsReadOnly(['--json', 'workspace', 'list', '--window', 'w']),
    ).toBe(true);
    expect(cmuxCallIsReadOnly(['new-surface', '--workspace', WS])).toBe(false);
    expect(cmuxCallIsReadOnly(['send', 'tree'])).toBe(false);
    expect(cmuxCallIsReadOnly(['rename-tab', '--', 'ping'])).toBe(false);
    expect(cmuxCallIsReadOnly(['workspace', 'close'])).toBe(false);
    expect(cmuxCallIsReadOnly(['--unknown', 'ping'])).toBe(false);
    expect(cmuxCallIsReadOnly(['--socket'])).toBe(false);
    expect(cmuxCallIsReadOnly([])).toBe(false);
  });
});

describe('thread handoff when cmux is slow', () => {
  test('AC 1: ping times out on every attempt: deferred, exit 4, handoff-deferred and not handoff-refused', async () => {
    const w = world();
    const clock = fakeClock();
    const cmux = fakeCmux(clock, {hang: {ping: 'always'}});
    const result = await handoff(w, clock, cmux, gateOver(w, clock, cmux));
    expect(result.exitCode).toBe(4);
    const text = textOf(result);
    expect(text).toContain('handoff deferred: cmuxSlow');
    for (const line of HANDOFF_DEFERRAL_INSTRUCTIONS) {
      expect(text).toContain(line);
    }
    expect(text).toContain('🤝 **HANDOFF**');
    const bead = beadOf(w);
    expect(bead.labels).toContain('handoff-deferred');
    expect(bead.labels).toContain('handed-off');
    expect(bead.labels).not.toContain('handoff-refused');
    expect(bead.notes ?? '').toContain('handoff deferred: cmuxSlow — ');
    expect(cmux.calls).not.toContain('newSurface');
  });

  test('AC 2: ping times out once, then answers: the gate goes on and passes', async () => {
    const w = world();
    const clock = fakeClock();
    const cmux = fakeCmux(clock, {hang: {ping: 1}});
    const result = await handoff(w, clock, cmux, gateOver(w, clock, cmux));
    expect(result.exitCode).toBe(0);
    expect(count(cmux.calls, 'ping')).toBe(2);
    expect(count(cmux.calls, 'newSurface')).toBe(1);
    expect(beadOf(w).labels).not.toContain('handoff-deferred');
  });

  test('AC 3: kill switch on and cmux slow: killSwitch, exit 3, zero cmux calls', async () => {
    const w = world();
    const clock = fakeClock();
    const cmux = fakeCmux(clock, {hang: {ping: 'always'}});
    const result = await handoff(
      w,
      clock,
      cmux,
      gateOver(w, clock, cmux, {
        readers: {
          killSwitch: () => ({
            kind: 'on',
            path: '/k',
            reason: 'Justin says no',
          }),
        },
      }),
    );
    expect(result.exitCode).toBe(3);
    expect(textOf(result)).toContain('handoff refused: killSwitch');
    expect(cmux.calls).toEqual([]);
  });

  test('AC 4: usage high and cmux fast: usageHigh, exit 3, no retry', async () => {
    const w = world();
    const clock = fakeClock();
    const cmux = fakeCmux(clock);
    const result = await handoff(
      w,
      clock,
      cmux,
      gateOver(w, clock, cmux, {readers: {usage: usage(99)}}),
    );
    expect(result.exitCode).toBe(3);
    expect(textOf(result)).toContain('handoff refused: usageHigh');
    expect(cmux.calls).toEqual(['ping', 'readScreen']);
    expect(clock.sleeps).toEqual([]);
  });

  test('AC 5: usage high after one ping timeout: usageHigh, exit 3', async () => {
    const w = world();
    const clock = fakeClock();
    const cmux = fakeCmux(clock, {hang: {ping: 1}});
    const result = await handoff(
      w,
      clock,
      cmux,
      gateOver(w, clock, cmux, {readers: {usage: usage(99)}}),
    );
    expect(result.exitCode).toBe(3);
    expect(textOf(result)).toContain('handoff refused: usageHigh');
    expect(count(cmux.calls, 'ping')).toBe(2);
    expect(beadOf(w).labels).toContain('handoff-refused');
    expect(beadOf(w).labels).not.toContain('handoff-deferred');
  });

  test('AC 6: a timed-out new-surface: the runner was called exactly once, exit 1', async () => {
    const w = world();
    const clock = fakeClock();
    const cmux = fakeCmux(clock, {hang: {newSurface: 'always'}});
    const result = await handoff(w, clock, cmux, gateOver(w, clock, cmux));
    expect(result.exitCode).toBe(1);
    expect(count(cmux.calls, 'newSurface')).toBe(1);
  });

  test('AC 7: a failed ping that is not a timeout: cmuxUnreachable, exit 3, one call', async () => {
    const w = world();
    const clock = fakeClock();
    const cmux = fakeCmux(clock, {fail: {ping: 'connection refused'}});
    const result = await handoff(w, clock, cmux, gateOver(w, clock, cmux));
    expect(result.exitCode).toBe(3);
    expect(textOf(result)).toContain('handoff refused: cmuxUnreachable');
    expect(cmux.calls).toEqual(['ping']);
    expect(beadOf(w).labels).not.toContain('handoff-deferred');
  });

  test('AC 8: a run after a deferral is not refused by its own writes, and a pass removes handoff-deferred', async () => {
    const w = world();
    const selected = selectSession({
      env: w.env,
      selector: null,
      sessionIdOption: null,
    });
    if (selected.kind !== 'found') throw new Error(selected.kind);
    const {db} = selected.session;
    const realChain = realChainReaders({cwd: w.repo, env: w.env});
    const realWrites: Partial<HandoffGateReaders> = {
      chain: () =>
        walkUnattendedChain(w.beadId, {
          readLog: () => ({
            failures: [],
            kind: 'read',
            lines: [],
            path: '/fake/log.jsonl',
          }),
          showBead: realChain.showBead,
        }),
      launchRecord: () => readLaunchRecord({beadId: w.beadId, db, env: w.env}),
    };
    const chainBefore = await realWrites.chain?.();

    const clock = fakeClock();
    const slow = fakeCmux(clock, {hang: {ping: 'always'}});
    const first = await handoff(
      w,
      clock,
      slow,
      gateOver(w, clock, slow, {readers: realWrites}),
    );
    expect(first.exitCode).toBe(4);
    expect(beadOf(w).labels).toContain('handoff-deferred');
    expect(beadOf(w).labels).toContain('handed-off');

    // The handed-off label from the first run does not count against the chain.
    expect(await realWrites.chain?.()).toEqual(chainBefore);

    const fast = fakeCmux(clock);
    const second = await handoff(
      w,
      clock,
      fast,
      gateOver(w, clock, fast, {readers: realWrites}),
    );
    expect(textOf(second)).not.toContain('alreadyHandedOff');
    expect(second.exitCode).toBe(0);
    const bead = beadOf(w);
    expect(bead.labels).not.toContain('handoff-deferred');
    expect(bead.labels).toContain('successor-started');
    expect(count(fast.calls, 'newSurface')).toBe(1);
  });

  test('D7: the pane lookup timing out at the deadline defers, rather than exit 2', async () => {
    const w = world();
    const clock = fakeClock();
    const cmux = fakeCmux(clock, {hang: {paneTree: 'always'}});
    const result = await handoff(w, clock, cmux, gateOver(w, clock, cmux));
    expect(result.exitCode).toBe(4);
    expect(textOf(result)).toContain('handoff deferred: cmuxSlow');
    expect(beadOf(w).labels).toContain('handoff-deferred');
    expect(count(cmux.calls, 'paneTree')).toBeGreaterThan(1);
    expect(cmux.calls).not.toContain('newSurface');
    expect(clock.elapsed()).toBeLessThanOrEqual(HANDOFF_GATE_DEADLINE_MS);
  });

  test('D7: the pane lookup failing another way stays exit 2, nothing written', async () => {
    const w = world();
    const clock = fakeClock();
    const cmux = fakeCmux(clock, {fail: {paneTree: 'no such workspace'}});
    const result = await handoff(w, clock, cmux, gateOver(w, clock, cmux));
    expect(result.exitCode).toBe(2);
    expect(beadOf(w).labels).not.toContain('handoff-deferred');
    expect(beadOf(w).labels).not.toContain('handed-off');
  });

  test('the dry run says it would defer, writes nothing and exits 0', async () => {
    const w = world();
    const clock = fakeClock();
    const cmux = fakeCmux(clock, {hang: {ping: 'always'}});
    const result = await handoff(w, clock, cmux, gateOver(w, clock, cmux), {
      dryRun: true,
    });
    expect(result.exitCode).toBe(0);
    expect(textOf(result)).toContain('would defer: cmuxSlow');
    expect(beadOf(w).labels).not.toContain('handoff-deferred');
    expect(beadOf(w).labels).not.toContain('handed-off');
  });
});

describe('the whole gate stops at the 60 s deadline (AC 9, fake clock)', () => {
  async function run(
    w: World,
    hang: Partial<Record<Verb, 'always'>>,
  ): Promise<{clock: Clock; cmux: FakeCmux; result: HandoffGateResult}> {
    const clock = fakeClock();
    const cmux = fakeCmux(clock, {hang});
    const result = await gateOver(
      w,
      clock,
      cmux,
    )({
      cmuxDeadlineAtMs: clock.now() + HANDOFF_GATE_DEADLINE_MS,
      cwd: w.repo,
      env: w.env,
      limits: {
        maxLiveSessions: 20,
        maxUnattendedHandoffs: 3,
        usage: {
          maxSampleAgeMinutes: 150,
          maxSessionPercent: 85,
          maxWeekPercent: 90,
        },
      } as never,
      now: NOW,
      session: {} as never,
    });
    return {clock, cmux, result};
  }

  test('every call hangs', async () => {
    const w = world();
    const {clock, result} = await run(w, {
      liveTree: 'always',
      ping: 'always',
      readScreen: 'always',
    });
    expect(result.kind).toBe('deferred');
    expect(clock.elapsed()).toBeLessThanOrEqual(HANDOFF_GATE_DEADLINE_MS);
  });

  test('only the caller screen hangs', async () => {
    const w = world();
    const {clock, cmux, result} = await run(w, {readScreen: 'always'});
    expect(result.kind).toBe('deferred');
    expect(count(cmux.calls, 'readScreen')).toBeGreaterThan(1);
    expect(clock.elapsed()).toBeLessThanOrEqual(HANDOFF_GATE_DEADLINE_MS);
  });

  test('only the live-session tree hangs: deferred, and it is not retried', async () => {
    const w = world();
    const {clock, cmux, result} = await run(w, {liveTree: 'always'});
    expect(result.kind).toBe('deferred');
    expect(count(cmux.calls, 'liveTree')).toBe(1);
    expect(clock.sleeps).toEqual([]);
    expect(clock.elapsed()).toBeLessThanOrEqual(HANDOFF_GATE_DEADLINE_MS);
  });

  test('a timed-out tree beside a real failure stays a refusal', async () => {
    const w = world();
    const clock = fakeClock();
    const cmux = fakeCmux(clock, {hang: {liveTree: 'always'}});
    const result = await gateOver(w, clock, cmux, {
      sources: fakeLiveSources(w, {
        ps: () => Promise.resolve({kind: 'failed', reason: 'ps failed'}),
      }),
    })({
      cmuxDeadlineAtMs: clock.now() + HANDOFF_GATE_DEADLINE_MS,
      cwd: w.repo,
      env: w.env,
      limits: {
        maxLiveSessions: 20,
        maxUnattendedHandoffs: 3,
        usage: {
          maxSampleAgeMinutes: 150,
          maxSessionPercent: 85,
          maxWeekPercent: 90,
        },
      } as never,
      now: NOW,
      session: {} as never,
    });
    expect(result.kind === 'refused' && result.reason).toBe(
      'liveSessionsUnknown',
    );
  });
});

describe('thread spawn when cmux is slow', () => {
  test('deferred: exit 4, nothing recorded on the caller, and it tells the caller to run it again', async () => {
    const w = world();
    const recorded: unknown[] = [];
    const result = await spawnGate(
      {commandWords: [], cwd: w.repo, env: w.env, now: NOW},
      {
        gate: () =>
          Promise.resolve({
            detail: 'cmux did not answer',
            kind: 'deferred',
            message: 'm',
            reason: 'cmuxSlow',
          }),
        recordRefusal: (input) => {
          recorded.push(input);
          return {kind: 'recorded', line: 'x'};
        },
      },
    );
    expect(result?.exitCode).toBe(4);
    expect(result?.lines.join('\n')).toContain('Run the same command again');
    expect(recorded).toEqual([]);
  });
});

// The real cmux binary, against a socket this test owns. Skipped where no cmux
// is installed. Needs the Bash sandbox off, like the rest of this suite.
describe.skipIf(Bun.which('cmux') == null)(
  'the real cmux CLI against a socket that never answers (AC 10)',
  () => {
    const dirs: string[] = [];
    const servers: Server[] = [];
    const clients: Socket[] = [];
    afterEach(() => {
      for (const client of clients.splice(0)) client.destroy();
      for (const server of servers.splice(0)) server.close();
      for (const dir of dirs.splice(0))
        rmSync(dir, {force: true, recursive: true});
    });

    /** Short path: a unix socket path has a 104-byte limit on macOS. */
    async function silentSocket(): Promise<string> {
      const dir = mkdtempSync(join(tmpdir(), 'cx-'));
      dirs.push(dir);
      const path = join(dir, 's.sock');
      const server = createServer((client) => {
        clients.push(client);
      });
      servers.push(server);
      await new Promise<void>((resolve) => {
        server.listen(path, resolve);
      });
      return path;
    }

    test('the CLI gives up on its own short limit: timedOut true', async () => {
      const path = await silentSocket();
      const call = await realCmuxRunner(30_000, {
        ...process.env,
        [CMUX_CLI_TIMEOUT_ENV]: '1',
        CMUX_SOCKET_PATH: path,
      })(['ping']);
      expect(call.kind).toBe('failed');
      expect(call.kind === 'failed' && call.timedOut).toBe(true);
      expect(call.kind === 'failed' && call.reason).toContain(
        "timed out at the cmux CLI's own limit",
      );
    });

    test('our kill fires first by default: timedOut true', async () => {
      const path = await silentSocket();
      const {[CMUX_CLI_TIMEOUT_ENV]: _unset, ...env} = process.env;
      const call = await realCmuxRunner(1000, {
        ...env,
        CMUX_SOCKET_PATH: path,
      })(['ping']);
      expect(call.kind === 'failed' && call.timedOut).toBe(true);
      expect(call.kind === 'failed' && call.reason).toContain(
        'timed out after 1000 ms',
      );
    });

    test('a socket with nothing listening is not a timeout', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cx-'));
      dirs.push(dir);
      const call = await realCmuxRunner(10_000, {
        ...process.env,
        CMUX_SOCKET_PATH: join(dir, 'gone.sock'),
      })(['ping']);
      expect(call.kind === 'failed' && call.timedOut).toBe(false);
    });

    test('thread handoff through the real runner defers rather than refuses', async () => {
      const w = world();
      const path = await silentSocket();
      const real = realCmuxRunner(undefined, {
        ...process.env,
        [CMUX_CLI_TIMEOUT_ENV]: '1',
        CMUX_SOCKET_PATH: path,
      });
      const gate: HandoffGateRunner = (input) =>
        runHandoffGate({
          env: input.env,
          limits: input.limits,
          now: input.now,
          readers: {
            chain: null,
            guard: () => ({kind: 'registered', where: []}),
            guardPass: () => ({kind: 'valid', path: '/fake/pass'}),
            killSwitch: () => ({kind: 'off', path: '/fake/off'}),
            launchRecord: null,
            usage: usage(10),
            ...gateCmuxReaders({
              backoffMs: [100, 100],
              deadlineAtMs: Date.now() + 2500,
              env: input.env,
              liveSources: fakeLiveSources(w),
              now: () => Date.now(),
              run: real,
              sleep: (ms) => Bun.sleep(ms),
            }),
          },
        });
      const options = {
        cwd: w.repo,
        env: w.env,
        model: null,
        note: 'pick up at step 3',
        now: NOW,
        sessionId: null,
        to: null,
      };
      const deps = {
        clock: () => Date.now(),
        gate,
        run: real,
        sleep: (ms: number) => Bun.sleep(ms),
      };
      const dry = await threadHandoffCommand({...options, dryRun: true}, deps);
      expect(dry.exitCode).toBe(0);
      expect(textOf(dry)).toContain('would defer: cmuxSlow');
      const wet = await threadHandoffCommand({...options, dryRun: false}, deps);
      if (process.env.SHOW_HANDOFF_OUTPUT != null) {
        console.log(textOf(dry));
        console.log(`exit ${wet.exitCode}\n${textOf(wet)}`);
      }
      expect(wet.exitCode).toBe(4);
      expect(textOf(wet)).toContain('handoff deferred: cmuxSlow');
      expect(textOf(wet)).not.toContain('handoff refused');
      expect(beadOf(w).labels).toContain('handoff-deferred');
      expect(beadOf(w).labels).not.toContain('handoff-refused');
    }, 60_000);
  },
);

describe('readPaneOfSurface carries the timeout', () => {
  test('a timed-out tree is unreadable and timedOut; bad JSON is not timedOut', async () => {
    const timedOut = await readPaneOfSurface(
      () => Promise.resolve({kind: 'failed', reason: 't', timedOut: true}),
      WS,
      SURF,
    );
    expect(timedOut).toEqual({kind: 'unreadable', reason: 't', timedOut: true});
    const bad = await readPaneOfSurface(
      () => Promise.resolve({kind: 'ok', stdout: 'not json'}),
      WS,
      SURF,
    );
    expect(bad.kind === 'unreadable' && bad.timedOut).toBe(false);
  });
});
