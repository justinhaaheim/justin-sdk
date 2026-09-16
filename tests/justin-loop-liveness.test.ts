/**
 * The runner says it is alive while it waits, and the stop ladder narrates
 * itself as it climbs (home-base-a1go, design items 4 and 5).
 *
 * WHY BOTH ARE THE SAME BUG. On 2026-09-10 an e2e run printed its
 * `background <id>` line and then nothing for 717s. Bounding every child call
 * (dispatch 1a/1b) stops the runner from being STUCK; it does nothing about the
 * runner LOOKING stuck, and a human watching a silent terminal cannot tell the
 * two apart. Two channels fix that:
 *
 *   - `watchSession` writes one dim liveness line per LIVENESS_INTERVAL_MS of
 *     session time, naming the elapsed minutes, the poll count, the last row it
 *     actually read and whether `claude agents` can be read at all;
 *   - `stopAndVerify` writes each ladder note THE MOMENT it is made instead of
 *     handing the array back for the caller to print afterwards. With 60s
 *     per-call bounds a wedged daemon makes the full ladder (4 rungs ×
 *     STOP_VERIFY_POLLS polls) about half an hour long, and every second of it
 *     used to be silent.
 *
 * HOW: the fake clock advances by exactly the duration of each `sleep`, so
 * "61 seconds of watching" costs microseconds and nothing spawns a process.
 *
 * NEGATIVE CONTROLS, each run once and each reddening exactly one assertion
 * (recorded in home-base-a1go's notes):
 *   - liveness emitted every poll instead of every interval → the "30s of
 *     watching is silent" test failed on `0` received `3`;
 *   - the interval comparison flipped to `>` → the 60s test failed on exactly
 *     one line, received 0;
 *   - `lastSeen`/`everRead` collapsed so a never-read listing printed `no row`
 *     → the unreadable test failed on the `no row` assertion only;
 *   - the notes pushed without writing (the pre-a1go shape) → the streaming
 *     test failed on the first sleep snapshot, received '';
 *   - the post-hoc `for (const note of stop.notes)` print loop put back in
 *     `runJustinLoop` → the exactly-once test failed with 2 occurrences.
 */

import {afterEach, describe, expect, test} from 'bun:test';

import {
  type AgentRow,
  DEFAULT_OPTIONS,
  type BootContext,
  type JustinLoopOptions,
  LIVENESS_INTERVAL_MS,
  type RunnerDeps,
  runSession,
  stopAndVerify,
  type StopDeps,
} from '../src/justin-loop/runner';
import {beadFrom, runLoop} from './justin-loop-world';
import {createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

function agentRow(over: Partial<AgentRow> = {}): AgentRow {
  return {
    id: 'sim-1',
    name: '2026-09-08 04:30 the-arc-1',
    pid: 4242,
    sessionId: 'sim-1-34c4-435b-b21f-4289486061a0',
    state: 'working',
    status: 'idle',
    waitingFor: null,
    ...over,
  };
}

const WORKING = agentRow();
const DONE = agentRow({state: 'done', status: 'idle'});

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

interface Watched {
  stdout: string;
  /** Simulated seconds from dispatch to return. */
  elapsedSec: number;
  polls: number;
}

/**
 * Watch one session against a scripted `claude agents`, on a fake clock.
 *
 * `rowAt` is 1-based on the poll number; the sleep before each poll is the
 * loop's only consumer of time, so poll N happens at exactly `N × pollSec`.
 */
async function watch(spec: {
  pollSec: number;
  rowAt: (poll: number) => AgentRow | null | 'unreadable';
  maxPolls?: number;
}): Promise<Watched> {
  const sb = createSandbox();
  sandboxes.push(sb);

  const opts: JustinLoopOptions = {...DEFAULT_OPTIONS, pollSec: spec.pollSec};
  const boot: BootContext = {
    cwd: sb.path,
    label: 'the-arc-1',
    plan: {kind: 'fresh'},
  };
  const maxPolls = spec.maxPolls ?? 100;

  let clock = 1_000_000;
  const started = clock;
  let polls = 0;
  let stdout = '';

  const deps: RunnerDeps = {
    appendLedgerRow: () => ({ok: true, reason: null}),
    br: () => ({ok: true, reason: null, stdout: '{"issues":[]}'}),
    dispatch: async () => 'backgrounded · sim-1 · 2026-09-08 04:30 the-arc-1\n',
    findAgent: async () => {
      polls++;
      if (polls > maxPolls) {
        throw new Error(`watchSession did not terminate within ${maxPolls}`);
      }
      const row = spec.rowAt(polls);
      return row === 'unreadable'
        ? {ok: false, reason: 'claude agents --json exited 1'}
        : {ok: true, row};
    },
    gitHead: async () => ({ok: true, sha: 'abc123'}),
    notifyBlocked: () => {},
    now: () => clock,
    preflight: async () => [],
    readUsage: async () => null,
    signalPid: () => true,
    sleep: async (ms: number) => {
      clock += ms;
    },
    stopSession: async () => ({detail: 'stopped sim-1', ok: true}),
    write: (text: string) => {
      stdout += text;
    },
    writeErr: () => {},
  };

  await runSession(sb.path, opts, 1, boot, 'sim name', deps);
  return {elapsedSec: (clock - started) / 1000, polls, stdout};
}

describe('liveness: a quiet session never looks like a wedged runner', () => {
  test('30 seconds of watching prints NO liveness line', async () => {
    // Three polls at 10s each. Under the interval, so the runner has nothing
    // worth saying — a line per poll would be noise, and noise is what gets
    // ignored when it matters.
    const w = await watch({
      pollSec: 10,
      rowAt: (poll) => (poll <= 2 ? WORKING : DONE),
    });
    expect(w.polls).toBe(3);
    expect(w.elapsedSec).toBe(30);
    expect(occurrences(w.stdout, 'watching ')).toBe(0);
  });

  test('crossing 60 seconds prints EXACTLY ONE line, naming what it measured', async () => {
    // Polls at 20/40/60/80s: the third crosses the interval, the run ends
    // before the second interval is due.
    const w = await watch({
      pollSec: 20,
      rowAt: (poll) => (poll <= 3 ? WORKING : DONE),
    });
    expect(w.elapsedSec).toBe(80);
    expect(occurrences(w.stdout, 'watching ')).toBe(1);
    expect(w.stdout).toContain(
      'watching 1m · 3 polls · working/idle · agents ok',
    );
  });

  test('the interval is session time, not poll count', async () => {
    // The same 60s reached in twelve 5s polls prints the same single line —
    // the tick is driven by the clock, so `--poll-sec` cannot change how often
    // the runner speaks.
    const w = await watch({
      pollSec: 5,
      rowAt: (poll) => (poll <= 12 ? WORKING : DONE),
    });
    expect(LIVENESS_INTERVAL_MS).toBe(60_000);
    expect(occurrences(w.stdout, 'watching ')).toBe(1);
    expect(w.stdout).toContain('watching 1m · 12 polls ·');
  });

  test('an unreadable listing is reported as unreadable, with its streak and reason', async () => {
    // The case the line exists for: `claude agents` failing is exactly what a
    // wedge looks like from outside, and the streak is how close the session
    // is to being abandoned (AGENTS_FAILURE_LIMIT).
    const w = await watch({
      pollSec: 20,
      rowAt: (poll) => (poll <= 3 ? 'unreadable' : DONE),
    });
    expect(w.stdout).toContain(
      'watching 1m · 3 polls · no listing read yet · agents unreadable ×3: claude agents --json exited 1',
    );
    // UNKNOWN IS NOT ABSENT (critical rule 6): a listing that has never been
    // read must not print as "there is no row", which is a measurement.
    expect(w.stdout).not.toContain('no row');
  });

  test('an unreadable listing still reports the last row actually seen', async () => {
    // Polls: 1 WORKING, then 2-4 unreadable, then done. The tick at 60s (poll
    // 3) knows two different things — the last state we measured, and that we
    // cannot measure it right now — and says both.
    const w = await watch({
      pollSec: 20,
      rowAt: (poll) => (poll === 1 ? WORKING : poll <= 4 ? 'unreadable' : DONE),
    });
    expect(w.stdout).toContain(
      'watching 1m · 3 polls · working/idle · agents unreadable ×2: claude agents --json exited 1',
    );
  });

  test('a blocked session says what it is blocked on', async () => {
    const blocked = agentRow({
      state: 'blocked',
      status: null,
      waitingFor: 'Which approach do you want?',
    });
    const w = await watch({
      pollSec: 20,
      rowAt: (poll) => (poll <= 3 ? blocked : DONE),
    });
    expect(w.stdout).toContain(
      'watching 1m · 3 polls · blocked: Which approach do you want? · agents ok',
    );
  });
});

describe('the stop ladder narrates itself as it climbs', () => {
  test('a note reaches the writer BEFORE the ladder returns', async () => {
    // The streaming claim, made observable: `confirmGone` sleeps before every
    // poll, so a snapshot of the output taken inside the first sleep is a
    // snapshot from the MIDDLE of the ladder. Pre-a1go that snapshot was empty
    // and everything arrived at once, minutes later.
    let out = '';
    const duringSleep: string[] = [];
    let stopped = false;
    const live: AgentRow = agentRow({id: 'sess-1', state: 'done'});

    const deps: StopDeps = {
      findAgent: async () => ({ok: true, row: stopped ? null : live}),
      signalPid: () => true,
      sleep: async () => {
        duringSleep.push(out);
      },
      stopSession: async () => {
        stopped = true;
        return {detail: 'stopped sess-1', ok: true};
      },
      write: (text) => {
        out += text;
      },
    };

    const report = await stopAndVerify('/repo', 'sess-1', 0, deps);
    expect(report.outcome).toBe('stopped');
    expect(duringSleep.length).toBeGreaterThan(0);
    expect(duringSleep[0]).toContain('claude stop sess-1: stopped sess-1');

    // Every note, exactly once, and nothing in the output that is not a note.
    for (const note of report.notes) {
      expect(occurrences(out, note)).toBe(1);
    }
    expect(out.trimEnd().split('\n')).toHaveLength(report.notes.length);
  });

  test('an already-absent session still prints its one note', async () => {
    // The early return bypasses the ladder entirely; before the notes streamed,
    // this note was printed by the caller's loop, which is now gone.
    let out = '';
    const deps: StopDeps = {
      findAgent: async () => ({ok: true, row: null}),
      signalPid: () => true,
      sleep: async () => {},
      stopSession: async () => ({detail: 'unreachable', ok: true}),
      write: (text) => {
        out += text;
      },
    };
    const report = await stopAndVerify('/repo', 'sess-1', 0, deps);
    expect(report.outcome).toBe('already-gone');
    expect(report.notes).toHaveLength(1);
    expect(out).toContain('sess-1 was already absent from `claude agents`');
    expect(occurrences(out, 'was already absent')).toBe(1);
  });

  test('a whole run prints each ladder note exactly once', async () => {
    // End to end through the real `runJustinLoop`: the notes are written by the
    // ladder now, and the caller must NOT print the array again afterwards.
    const r = await runLoop({
      opts: {label: 'the-arc', maxSessions: 1},
      scans: [[], [beadFrom('hoff-1', {from: 'the-arc-1'})]],
    });
    expect(r.exitCode).toBe(0);
    expect(occurrences(r.stdout, 'claude stop sess-1: stopped sess-1')).toBe(1);
    expect(occurrences(r.stdout, 'verified gone: sess-1')).toBe(1);
  });
});
