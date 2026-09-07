/**
 * The attachable loop's blocked path (home-base-1r6d.26, D3 + D5).
 *
 * THE BUG THIS FIXES. A blocked background session is one asking Justin a
 * question. Until now the runner stopped it after `blockedWaitMin` minutes
 * (default 15) with a synthetic BLOCKED verdict, which ends the run at exit 2 —
 * so in the direct-ask workflow, where the person being asked is the person who
 * started the run, walking away for twenty minutes killed the session he was
 * coming back to answer. Worse, `--blocked-wait-min 720` did not actually buy 12
 * hours: the iteration's own 45-minute wall-clock timeout kept running while the
 * session sat blocked and reaped it first, reporting a CRASH.
 *
 * THE CONTRACT NOW:
 *   - `blockedWaitMin: null` (the default) waits indefinitely.
 *   - A number is an opt-in bound for an UNATTENDED run, and still produces the
 *     synthetic BLOCKED verdict carrying the question.
 *   - Time spent blocked never counts toward `timeoutMin`, either way.
 *   - The timeout still fires for a session that is genuinely running away —
 *     the last test here is the one that keeps the fix from being "the timeout
 *     was quietly disabled".
 *
 * HOW (D5): runIterationAttachable takes an optional `deps` bag, so the clock,
 * the sleep, the `claude agents` poll and the dispatch are all injectable. The
 * fake clock advances by exactly the sleep duration on every sleep, which is
 * the loop's only consumer of wall-clock time, so a simulated hour costs
 * microseconds. Nothing here spawns a process.
 */

import {afterEach, describe, expect, test} from 'bun:test';

import {
  type AgentRow,
  type AttachableDeps,
  type BootContext,
  DEFAULT_OPTIONS,
  type IterationResult,
  type RalphOptions,
  runIterationAttachable,
  type Verdict,
} from '../src/ralph';
import {createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

const MINUTE = 60_000;

function agentRow(over: Partial<AgentRow> = {}): AgentRow {
  return {
    id: 'sim-1',
    name: 'ralph-1',
    pid: 4242,
    state: 'running',
    status: 'working',
    waitingFor: null,
    ...over,
  };
}

const WORKING = agentRow();
const BLOCKED = agentRow({
  state: 'blocked',
  status: 'waiting',
  waitingFor: 'Which approach do you want?',
});

const DONE_VERDICT: Verdict = {
  followUps: [],
  handoffBead: null,
  respawn: null,
  status: 'CONTINUE',
  summary: 'answered and finished',
};

interface Sim {
  result: IterationResult;
  /** Simulated minutes from dispatch to return. */
  elapsedMin: number;
  polls: number;
  stopCalls: number;
  onBlockedCalls: number;
  /** The argv the loop would have handed `claude --bg`. */
  args: string[];
}

/**
 * Run one attachable iteration against a scripted agent, on a fake clock.
 *
 * `rowAt`/`verdictAt` are 1-based on the poll number. `maxPolls` is a runaway
 * guard, not an assertion: a loop that never terminates throws here with the
 * count, rather than hanging the suite until bun's timeout kills it with no
 * explanation.
 */
async function simulate(spec: {
  opts?: Partial<RalphOptions>;
  rowAt: (poll: number) => AgentRow | null;
  verdictAt?: (poll: number) => Verdict | null;
  maxPolls?: number;
}): Promise<Sim> {
  const sb = createSandbox();
  sandboxes.push(sb);

  const opts: RalphOptions = {
    ...DEFAULT_OPTIONS,
    // One poll = one simulated minute, so every duration below reads in
    // minutes without arithmetic.
    pollSec: 60,
    verdictPath: 'tmp/verdict.json',
    ...spec.opts,
  };
  const boot: BootContext = {label: 'ralph-1', plan: {kind: 'fresh'}};
  const maxPolls = spec.maxPolls ?? 400;

  let clock = 1_000_000;
  const started = clock;
  let polls = 0;
  let stopCalls = 0;
  let onBlockedCalls = 0;
  let args: string[] = [];

  const deps: AttachableDeps = {
    dispatch: (_cwd, dispatchArgs) => {
      args = dispatchArgs;
      return 'backgrounded · sim-1 · ralph-1\n';
    },
    findAgent: () => {
      polls++;
      if (polls > maxPolls) {
        throw new Error(
          `runIterationAttachable did not terminate within ${maxPolls} polls`,
        );
      }
      return spec.rowAt(polls);
    },
    now: () => clock,
    // The verdict file is scripted, so nothing is ever read from disk; the
    // sandbox exists only because the loop unlinks a stale verdict up front.
    readVerdict: () => (spec.verdictAt != null ? spec.verdictAt(polls) : null),
    sleep: async (ms) => {
      clock += ms;
    },
    stopAgent: () => {
      stopCalls++;
    },
  };

  const result = await runIterationAttachable(
    sb.path,
    opts,
    1,
    boot,
    () => {
      onBlockedCalls++;
    },
    deps,
  );
  return {
    args,
    elapsedMin: (clock - started) / MINUTE,
    onBlockedCalls,
    polls,
    result,
    stopCalls,
  };
}

describe('blocked waits for Justin by default (D3)', () => {
  test('a session blocked past 15m AND past timeoutMin is never stopped', async () => {
    // 15m was the old default and 45m is the iteration timeout; this session
    // sits blocked through both and is answered at minute 100.
    const sim = await simulate({
      opts: {blockedWaitMin: null, timeoutMin: 45},
      rowAt: (poll) => (poll <= 100 ? BLOCKED : WORKING),
      verdictAt: (poll) => (poll > 100 ? DONE_VERDICT : null),
    });

    expect(sim.result.subtype).toBe('success');
    expect(sim.result.crashed).toBe(false);
    expect(sim.result.verdict).toEqual(DONE_VERDICT);
    // It really did outlive both thresholds rather than finishing early.
    expect(sim.elapsedMin).toBeGreaterThan(100);
    // And the human was told once, not once per poll.
    expect(sim.onBlockedCalls).toBe(1);
  });

  test('the question is asked again if the session blocks a SECOND time', async () => {
    // notified resets when the session starts moving, so two separate questions
    // produce two notifications — one unanswered question must not silence the
    // next one.
    const sim = await simulate({
      opts: {blockedWaitMin: null, timeoutMin: 45},
      rowAt: (poll) => {
        if (poll <= 5) return BLOCKED;
        if (poll <= 10) return WORKING;
        if (poll <= 15) return BLOCKED;
        return WORKING;
      },
      verdictAt: (poll) => (poll > 16 ? DONE_VERDICT : null),
    });
    expect(sim.onBlockedCalls).toBe(2);
    expect(sim.result.subtype).toBe('success');
  });

  test('the contract handed to the session says the wait is indefinite', async () => {
    const sim = await simulate({
      opts: {blockedWaitMin: null},
      rowAt: () => WORKING,
      verdictAt: (poll) => (poll > 1 ? DONE_VERDICT : null),
    });
    const systemPrompt = sim.args[sim.args.indexOf('--append-system-prompt') + 1];
    expect(systemPrompt).toContain('indefinitely');
    expect(systemPrompt).not.toContain('bounded time');
  });
});

describe('--blocked-wait-min is an opt-in bound (D3)', () => {
  test('a 1m bound still stops the session with the synthetic BLOCKED verdict', async () => {
    const sim = await simulate({
      opts: {blockedWaitMin: 1, timeoutMin: 45},
      // Blocked forever — only the bound can end this.
      rowAt: () => BLOCKED,
      maxPolls: 30,
    });

    expect(sim.result.subtype).toBe('blocked-timeout');
    expect(sim.result.verdict?.status).toBe('BLOCKED');
    expect(sim.result.verdict?.summary).toContain('Waited 1m');
    // The question itself travels in the summary, or the bead filed from it
    // says nothing useful.
    expect(sim.result.verdict?.summary).toContain(
      'Which approach do you want?',
    );
    // The runner is speaking, not the session: it has no handoff to offer and
    // no standing to ask for a respawn.
    expect(sim.result.verdict?.handoffBead).toBeNull();
    expect(sim.result.verdict?.respawn).toBeNull();
    // …and it actually stopped the session rather than leaving it stranded.
    expect(sim.stopCalls).toBe(1);
    expect(sim.elapsedMin).toBeLessThan(5);
  });

  test('a bound tells the session the number it will actually be held to', async () => {
    const sim = await simulate({
      opts: {blockedWaitMin: 720},
      rowAt: () => WORKING,
      verdictAt: (poll) => (poll > 1 ? DONE_VERDICT : null),
    });
    const systemPrompt = sim.args[sim.args.indexOf('--append-system-prompt') + 1];
    expect(systemPrompt).toContain('waits 720m');
    expect(systemPrompt).not.toContain('indefinitely');
  });
});

describe('blocked time does not count toward timeoutMin (D3)', () => {
  test('60 blocked minutes inside a 10-minute timeout is not a crash', async () => {
    // Without the exclusion the deadline lands at minute 10, mid-block, and the
    // iteration is reported as a `timeout` CRASH — which is how
    // `--blocked-wait-min 720` used to be a lie.
    const sim = await simulate({
      opts: {blockedWaitMin: null, timeoutMin: 10},
      rowAt: (poll) => {
        if (poll <= 3) return WORKING;
        if (poll <= 63) return BLOCKED; // 60 simulated minutes blocked
        return WORKING;
      },
      verdictAt: (poll) => (poll > 68 ? DONE_VERDICT : null),
    });

    expect(sim.result.subtype).toBe('success');
    expect(sim.result.crashed).toBe(false);
    expect(sim.elapsedMin).toBeGreaterThan(10);
  });

  test('the deadline is pushed out by the blocked stretch, not removed', async () => {
    // The session blocks for 60 minutes and then works forever. The timeout
    // must still fire — at 10 + 60 minutes of working time, not at 10.
    const sim = await simulate({
      opts: {blockedWaitMin: null, timeoutMin: 10},
      rowAt: (poll) => {
        if (poll <= 3) return WORKING;
        if (poll <= 63) return BLOCKED;
        return WORKING;
      },
      maxPolls: 200,
    });

    expect(sim.result.subtype).toBe('timeout');
    expect(sim.result.crashed).toBe(true);
    // 10m of budget + 60m blocked, and one poll to notice it is past.
    expect(sim.elapsedMin).toBeGreaterThan(65);
    expect(sim.elapsedMin).toBeLessThan(75);
    expect(sim.stopCalls).toBe(1);
  });

  test('a session that never blocks still times out on schedule', async () => {
    // The control that stops "blocked time is excluded" from degrading into
    // "the timeout was quietly disabled". A runaway iteration is exactly what
    // timeoutMin exists for.
    const sim = await simulate({
      opts: {blockedWaitMin: null, timeoutMin: 10},
      rowAt: () => WORKING,
      maxPolls: 60,
    });

    expect(sim.result.subtype).toBe('timeout');
    expect(sim.result.crashed).toBe(true);
    expect(sim.elapsedMin).toBeLessThan(13);
  });
});
