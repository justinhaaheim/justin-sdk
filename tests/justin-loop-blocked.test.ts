/**
 * How one justin-loop session's own run ends: blocked, timed out, or finished
 * (home-base-1r6d.26 D3, home-base-1r6d.33 D7/D8).
 *
 * THE BUG D3 FIXED. A blocked background session is one asking Justin a
 * question. The runner used to stop it after `blockedWaitMin` minutes (default
 * 15), which ends the run — so in the direct-ask workflow, where the person
 * being asked is the person who started the run, walking away for twenty minutes
 * killed the session he was coming back to answer. Worse,
 * `--blocked-wait-min 720` did not actually buy 12 hours: the session's own
 * 45-minute wall-clock timeout kept running while it sat blocked and reaped it
 * first.
 *
 * THE CONTRACT NOW:
 *   - `blockedWaitMin: null` (the default) waits indefinitely.
 *   - A number is an opt-in bound for an UNATTENDED run.
 *   - Time spent blocked never counts toward `timeoutMin`, either way.
 *   - `timeoutMin: 0` — the DEFAULT since D7 — means there is no wall-clock
 *     timeout at all. Sessions are bounded by the ~300k wrap-up notice.
 *   - A timeout that IS configured still fires for a session running away; the
 *     last tests here keep the fix from being "the timeout was quietly removed".
 *
 * ENDING DETECTION (D8, measured 2026-09-08 against claude v2.1.263): a session
 * has ended when its row is absent or reads `state: 'done'` — and NOTHING else.
 * In particular a row with no pid is NOT an ending: that is what a daemon
 * respawn looks like mid-flight, and the old `pid == null && state !== 'blocked'`
 * test read it as "finished".
 *
 * HOW: `runSession` takes the whole RunnerDeps bag, so the clock, the sleep, the
 * `claude agents` poll and the dispatch are all injectable. The fake clock
 * advances by exactly the sleep duration on every sleep, which is the loop's
 * only consumer of wall-clock time, so a simulated hour costs microseconds.
 * Nothing here spawns a process.
 */

import {afterEach, describe, expect, test} from 'bun:test';

import {
  type AgentRow,
  AGENTS_FAILURE_LIMIT,
  type BootContext,
  DEFAULT_OPTIONS,
  isSessionEnded,
  type JustinLoopOptions,
  type RunnerDeps,
  runSession,
  type SessionRun,
} from '../src/justin-loop/runner';
import {createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

const MINUTE = 60_000;

function agentRow(over: Partial<AgentRow> = {}): AgentRow {
  return {
    id: 'sim-1',
    name: '2026-09-08 04:30 the-arc-1',
    pid: 4242,
    state: 'working',
    status: 'idle',
    waitingFor: null,
    ...over,
  };
}

/** MEASURED shapes (D8). */
const WORKING = agentRow();
const BUSY = agentRow({status: 'busy'});
const DONE = agentRow({state: 'done', status: 'idle'});
/** Mid-respawn: present, no pid, still `working`. NOT an ending. */
const RESPAWNING = agentRow({pid: null, status: null});
const BLOCKED = agentRow({
  state: 'blocked',
  status: null,
  waitingFor: 'Which approach do you want?',
});

interface Sim {
  run: SessionRun;
  /** Simulated minutes from dispatch to return. */
  elapsedMin: number;
  polls: number;
  onBlockedCalls: number;
  /** The argv the loop handed `claude --bg`. */
  args: string[];
}

/**
 * Run one session against a scripted agent, on a fake clock.
 *
 * `rowAt` is 1-based on the poll number. `maxPolls` is a runaway guard, not an
 * assertion: a loop that never terminates throws here with the count, rather
 * than hanging the suite until bun's timeout kills it with no explanation.
 */
async function simulate(spec: {
  opts?: Partial<JustinLoopOptions>;
  /** `'unreadable'` = `claude agents --json` failed on that poll. */
  rowAt: (poll: number) => AgentRow | null | 'unreadable';
  maxPolls?: number;
}): Promise<Sim> {
  const sb = createSandbox();
  sandboxes.push(sb);

  const opts: JustinLoopOptions = {
    ...DEFAULT_OPTIONS,
    // One poll = one simulated minute, so every duration below reads in minutes
    // without arithmetic.
    pollSec: 60,
    ...spec.opts,
  };
  const boot: BootContext = {label: 'the-arc-1', plan: {kind: 'fresh'}};
  const maxPolls = spec.maxPolls ?? 400;

  let clock = 1_000_000;
  const started = clock;
  let polls = 0;
  let onBlockedCalls = 0;
  let args: string[] = [];

  const deps: RunnerDeps = {
    appendLedgerRow: () => ({ok: true, reason: null}),
    br: () => ({ok: true, reason: null, stdout: '{"issues":[]}'}),
    dispatch: (_cwd: string, dispatchArgs: string[]) => {
      args = dispatchArgs;
      return 'backgrounded · sim-1 · 2026-09-08 04:30 the-arc-1\n';
    },
    findAgent: () => {
      polls++;
      if (polls > maxPolls) {
        throw new Error(`runSession did not terminate within ${maxPolls} polls`);
      }
      const row = spec.rowAt(polls);
      return row === 'unreadable'
        ? {ok: false, reason: 'claude agents --json exited 1'}
        : {ok: true, row};
    },
    gitHead: () => 'abc123',
    notifyBlocked: () => {
      onBlockedCalls++;
    },
    now: () => clock,
    preflight: () => [],
    readUsage: () => null,
    signalPid: () => true,
    sleep: async (ms: number) => {
      clock += ms;
    },
    stopSession: () => ({detail: 'stopped sim-1', ok: true}),
    write: () => {},
    writeErr: () => {},
  };

  const run = await runSession(sb.path, opts, 1, boot, 'sim name', deps);
  return {
    args,
    elapsedMin: (clock - started) / MINUTE,
    onBlockedCalls,
    polls,
    run,
  };
}

describe('isSessionEnded — the measured end signal (D8)', () => {
  test('`done` is the ending, and the pid it still carries does not matter', () => {
    // MEASURED: an ended --bg session sits in `claude agents` as state='done'
    // WITH a live pid, indefinitely (three rows from 2026-08 were still listed).
    expect(isSessionEnded(DONE)).toBe(true);
    expect(DONE.pid).not.toBeNull();
  });

  test('a working session has not ended, busy or idle', () => {
    expect(isSessionEnded(WORKING)).toBe(false);
    expect(isSessionEnded(BUSY)).toBe(false);
  });

  test('a blocked session has not ended — it is waiting for Justin', () => {
    expect(isSessionEnded(BLOCKED)).toBe(false);
  });

  test('A PIDLESS ROW IS NOT AN ENDING — that is a respawn in progress', () => {
    // The regression this whole predicate was rewritten for. MEASURED: after a
    // SIGTERM the row read {state:'working'} with NO pid for ~15s and then came
    // back under a new pid, still working. The old
    // `pid == null && state !== 'blocked'` test called that FINISHED — a false
    // "the session is done" pointing straight at spawning a successor onto a
    // live predecessor (critical rule 6).
    expect(isSessionEnded(RESPAWNING)).toBe(false);
  });

  test('an unrecognised state is not an ending', () => {
    // Guessing "ended" on a state we do not understand is the reassuring guess.
    expect(isSessionEnded(agentRow({state: 'quiescing'}))).toBe(false);
    expect(isSessionEnded(agentRow({state: null}))).toBe(false);
  });
});

describe('blocked waits for Justin by default (D3)', () => {
  test('a session blocked past 15m AND past timeoutMin is never stopped', async () => {
    // 15m was the old default and 45m the old session timeout; this session sits
    // blocked through both and is answered at minute 100.
    const sim = await simulate({
      opts: {blockedWaitMin: null, timeoutMin: 45},
      rowAt: (poll) => (poll <= 100 ? BLOCKED : DONE),
    });

    expect(sim.run.ending.kind).toBe('ended');
    // It really did outlive both thresholds rather than finishing early.
    expect(sim.elapsedMin).toBeGreaterThan(100);
    // And the human was told once, not once per poll.
    expect(sim.onBlockedCalls).toBe(1);
  });

  test('the question is asked again if the session blocks a SECOND time', async () => {
    // `notified` resets when the session starts moving, so two separate
    // questions produce two notifications — one unanswered question must not
    // silence the next one.
    const sim = await simulate({
      opts: {blockedWaitMin: null, timeoutMin: 45},
      rowAt: (poll) => {
        if (poll <= 5) return BLOCKED;
        if (poll <= 10) return WORKING;
        if (poll <= 15) return BLOCKED;
        if (poll <= 16) return WORKING;
        return DONE;
      },
    });
    expect(sim.onBlockedCalls).toBe(2);
    expect(sim.run.ending.kind).toBe('ended');
  });

  test('the contract handed to the session says the wait is indefinite', async () => {
    const sim = await simulate({
      opts: {blockedWaitMin: null},
      rowAt: () => DONE,
    });
    const systemPrompt =
      sim.args[sim.args.indexOf('--append-system-prompt') + 1];
    expect(systemPrompt).toContain('indefinitely');
    expect(systemPrompt).not.toContain('bounded time');
  });
});

describe('--blocked-wait-min is an opt-in bound (D3)', () => {
  test('a 1m bound ends the session as blocked-timeout, carrying the question', async () => {
    const sim = await simulate({
      opts: {blockedWaitMin: 1, timeoutMin: 45},
      // Blocked forever — only the bound can end this.
      rowAt: () => BLOCKED,
      maxPolls: 30,
    });

    expect(sim.run.ending.kind).toBe('blocked-timeout');
    // The question itself travels with the ending, or the report says nothing
    // useful about why the run stopped.
    expect(
      sim.run.ending.kind === 'blocked-timeout' ? sim.run.ending.waitingFor : null,
    ).toBe('Which approach do you want?');
    expect(sim.elapsedMin).toBeLessThan(5);
  });

  test('a bound tells the session the number it will actually be held to', async () => {
    const sim = await simulate({
      opts: {blockedWaitMin: 720},
      rowAt: () => DONE,
    });
    const systemPrompt =
      sim.args[sim.args.indexOf('--append-system-prompt') + 1];
    expect(systemPrompt).toContain('waits 720m');
    expect(systemPrompt).not.toContain('indefinitely');
  });
});

describe('no wall-clock timeout by default (D7)', () => {
  test('timeoutMin 0 lets a long session run to its own ending', async () => {
    // The default. 500 simulated minutes of work, far past the old 45-minute
    // timeout, and nothing reaps it — the wrap-up notice does that job now.
    const sim = await simulate({
      opts: {timeoutMin: 0},
      rowAt: (poll) => (poll <= 500 ? WORKING : DONE),
      maxPolls: 600,
    });
    expect(sim.run.ending.kind).toBe('ended');
    expect(sim.elapsedMin).toBeGreaterThan(500);
  });

  test('timeoutMin 0 never fires on a session that blocks forever either', async () => {
    const sim = await simulate({
      opts: {blockedWaitMin: null, timeoutMin: 0},
      rowAt: (poll) => (poll <= 300 ? BLOCKED : DONE),
      maxPolls: 400,
    });
    expect(sim.run.ending.kind).toBe('ended');
  });
});

describe('blocked time does not count toward timeoutMin (D3)', () => {
  test('60 blocked minutes inside a 10-minute timeout is not a timeout', async () => {
    // Without the exclusion the deadline lands at minute 10, mid-block, and the
    // session is reaped — which is how `--blocked-wait-min 720` used to be a lie.
    const sim = await simulate({
      opts: {blockedWaitMin: null, timeoutMin: 10},
      rowAt: (poll) => {
        if (poll <= 3) return WORKING;
        if (poll <= 63) return BLOCKED; // 60 simulated minutes blocked
        if (poll <= 68) return WORKING;
        return DONE;
      },
    });

    expect(sim.run.ending.kind).toBe('ended');
    expect(sim.elapsedMin).toBeGreaterThan(10);
  });

  test('the deadline is pushed out by the blocked stretch, not removed', async () => {
    // The session blocks for 60 minutes and then works forever. The timeout must
    // still fire — at 10 + 60 minutes of working time, not at 10.
    const sim = await simulate({
      opts: {blockedWaitMin: null, timeoutMin: 10},
      rowAt: (poll) => {
        if (poll <= 3) return WORKING;
        if (poll <= 63) return BLOCKED;
        return WORKING;
      },
      maxPolls: 200,
    });

    expect(sim.run.ending.kind).toBe('timeout');
    // 10m of budget + 60m blocked, and one poll to notice it is past.
    expect(sim.elapsedMin).toBeGreaterThan(65);
    expect(sim.elapsedMin).toBeLessThan(75);
  });

  test('a session that never blocks still times out on schedule', async () => {
    // The control that stops "blocked time is excluded" from degrading into
    // "the timeout was quietly disabled". A runaway session is exactly what an
    // opt-in timeoutMin exists for.
    const sim = await simulate({
      opts: {blockedWaitMin: null, timeoutMin: 10},
      rowAt: () => WORKING,
      maxPolls: 60,
    });

    expect(sim.run.ending.kind).toBe('timeout');
    expect(sim.elapsedMin).toBeLessThan(13);
  });

  test('a respawning (pidless) session does not end the poll loop early', async () => {
    // The false-positive regression, end to end: 30 polls of the measured
    // respawn shape must not be read as an ending.
    const sim = await simulate({
      opts: {timeoutMin: 0},
      rowAt: (poll) => (poll <= 30 ? RESPAWNING : DONE),
      maxPolls: 60,
    });
    expect(sim.run.ending.kind).toBe('ended');
    expect(sim.polls).toBeGreaterThan(30);
  });
});

describe('an unreadable `claude agents` is neither an ending nor a continuation', () => {
  test('a few failed polls are ridden out, and the session still ends normally', () => {
    // Transient: the daemon hiccups, we keep waiting, and the answer arrives.
    return simulate({
      opts: {timeoutMin: 0},
      rowAt: (poll) => {
        if (poll <= 3) return 'unreadable';
        if (poll <= 6) return WORKING;
        return DONE;
      },
    }).then((sim) => {
      expect(sim.run.ending.kind).toBe('ended');
    });
  });

  test('the failure streak RESETS on a successful read', async () => {
    // 4 failures, a good read, then 4 more — under the limit of 5 either side,
    // so this must NOT abandon the session.
    const sim = await simulate({
      opts: {timeoutMin: 0},
      rowAt: (poll) => {
        if (poll <= 4) return 'unreadable';
        if (poll === 5) return WORKING;
        if (poll <= 9) return 'unreadable';
        return DONE;
      },
    });
    expect(sim.run.ending.kind).toBe('ended');
  });

  test('but a dead daemon is abandoned rather than polled forever', async () => {
    // With --timeout-min 0 (the default) there is no clock to save us, so an
    // unbounded "keep waiting" on an unreadable listing would hang the run
    // silently. AGENTS_FAILURE_LIMIT consecutive failures end the session with
    // its own distinct ending, naming what failed.
    const sim = await simulate({
      opts: {timeoutMin: 0},
      rowAt: () => 'unreadable',
      maxPolls: 40,
    });
    expect(sim.run.ending.kind).toBe('agents-unreadable');
    expect(
      sim.run.ending.kind === 'agents-unreadable' ? sim.run.ending.failures : 0,
    ).toBe(AGENTS_FAILURE_LIMIT);
    expect(
      sim.run.ending.kind === 'agents-unreadable' ? sim.run.ending.reason : '',
    ).toContain('claude agents');
  });

  test('an unreadable listing is never mistaken for the session ending', async () => {
    // The whole point: `[]` used to come back from a failed listing, so a
    // failure looked exactly like "the row is gone" — which is "the session
    // finished" here and "safe to spawn" in stopAndVerify.
    const sim = await simulate({
      opts: {timeoutMin: 0},
      rowAt: (poll) => (poll <= 2 ? 'unreadable' : DONE),
    });
    expect(sim.run.ending.kind).toBe('ended');
    // It kept polling past the failures rather than returning on the first one.
    expect(sim.polls).toBeGreaterThan(2);
  });
});

describe('dispatch', () => {
  test('an absent row is an ending too — there is nothing left to wait for', async () => {
    const sim = await simulate({rowAt: () => null});
    expect(sim.run.ending.kind).toBe('ended');
    expect(sim.run.id).toBe('sim-1');
  });

  test('a banner with no id is dispatch-failed, never a running session', async () => {
    const sb = createSandbox();
    sandboxes.push(sb);
    const deps: RunnerDeps = {
      appendLedgerRow: () => ({ok: true, reason: null}),
      br: () => ({ok: true, reason: null, stdout: '{"issues":[]}'}),
      dispatch: () => 'error: could not start\n',
      findAgent: (): never => {
        throw new Error('must not poll for a session that never started');
      },
      gitHead: () => null,
      notifyBlocked: () => {},
      now: () => 1_000_000,
      preflight: () => [],
      readUsage: () => null,
      signalPid: () => true,
      sleep: async () => {},
      stopSession: () => ({detail: 'x', ok: true}),
      write: () => {},
      writeErr: () => {},
    };
    const run = await runSession(
      sb.path,
      DEFAULT_OPTIONS,
      1,
      {label: 'the-arc-1', plan: {kind: 'fresh'}},
      'sim name',
      deps,
    );
    expect(run.ending.kind).toBe('dispatch-failed');
    expect(run.id).toBeNull();
  });
});
