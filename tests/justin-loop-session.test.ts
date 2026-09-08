/**
 * The justin-loop chain, driven end to end with injected deps
 * (home-base-1r6d.33.2 — the acceptance criteria for D2, D5, D6, D7, D8, D9).
 *
 * WHAT THIS FILE EXISTS TO PREVENT, in order of how badly it fails:
 *   1. A successor spawned onto a LIVE predecessor. That is the 2026-09-07
 *      pilot's worst failure (home-base-1r6d.31/.32): the timeout declared a
 *      crash, did not stop the session, and booted a second agent into the same
 *      worktree. Every spawn here is gated on the predecessor's row being
 *      CONFIRMED gone from `claude agents`, and a stop that cannot be confirmed
 *      stops the whole run.
 *   2. A successor booted from something that is not a valid handoff. Zero
 *      handoffs, unreadable handoffs, and two open handoffs must each stop the
 *      run rather than guess — and must each SAY what they found, because
 *      "we could not read it" reading as "you wrote none" is the silence-shaped
 *      failure critical rule 6 is about.
 *   3. A successor prompted with anything other than the bead's `next`.
 *
 * The whole world is faked: `claude --bg`, `claude agents --json`,
 * `claude stop`, `br`, the clock, the ledger and both output streams. Nothing
 * spawns a process and nothing writes to the real state directory.
 */

import {describe, expect, test} from 'bun:test';
import {existsSync, mkdtempSync, readdirSync, readFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {
  type Handoff,
  HANDOFF_LABEL,
  handoffJson,
} from '../src/justin-loop/handoff';
import {type BrRunner} from '../src/justin-loop/br';
import {
  type AgentRow,
  appendLedgerRow,
  DEFAULT_OPTIONS,
  decideAfterSession,
  deriveSlug,
  FALLBACK_SLUG,
  type HandoffScan,
  isVerifiedGone,
  type JustinLoopOptions,
  type LedgerRow,
  runJustinLoop,
  runsJsonlPath,
  type RunnerDeps,
  runSlug,
  runStamp,
  sessionLabel,
  sessionName,
  slugify,
  type StopDeps,
  stopAndVerify,
  type StopOutcome,
} from '../src/justin-loop/runner';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function handoff(over: Partial<Handoff> = {}): Handoff {
  return {
    arc: 'home-base-1r6d.33',
    branch: 'worktree-justin-loop-runner',
    contextTokens: 302_000,
    createdAt: '2026-09-08T04:00:00Z',
    disposition: 'continue',
    from: 'the-arc-1',
    next: 'Finish the parser, then run bun test and report the exact count.',
    openQuestions: [],
    schemaVersion: 1,
    state: 'The parser is half written and nothing is committed yet.',
    worktree: '/Users/jhaa/Dev/home-base',
    ...over,
  };
}

interface BeadSpec {
  id: string;
  notes?: string | null;
  title?: string;
  labels?: string[];
}

function listJson(beads: BeadSpec[]): string {
  return JSON.stringify({
    issues: beads.map((b) => ({
      id: b.id,
      labels: b.labels ?? [HANDOFF_LABEL],
      ...(b.notes === undefined ? {} : {notes: b.notes}),
      status: 'open',
      title: b.title ?? 'HANDOFF continue: an arc',
      updated_at: '2026-09-08T04:00:00Z',
    })),
    total: beads.length,
  });
}

/** A handoff bead written by session `from`. */
function beadFrom(id: string, over: Partial<Handoff> = {}): BeadSpec {
  return {id, notes: handoffJson(handoff(over)), title: `HANDOFF: ${id}`};
}

// ---------------------------------------------------------------------------
// The scripted world
// ---------------------------------------------------------------------------

/** What `claude stop` does to this session's row. */
type StopBehaviour =
  /** The measured normal case: the row leaves `claude agents` within a poll. */
  | 'clears'
  /** Nothing we do removes it. The kill-failed path. */
  | 'lingers'
  /** Survives everything and has no pid to signal. The no-pid path. */
  | 'lingers-pidless'
  /** Survives `claude stop` twice, then dies on a signal. */
  | 'clears-on-signal';

interface SessionScript {
  /** The row's `state` while the runner polls it. Default: ends immediately. */
  state?: string;
  /** Poll count before the state above flips to `done`. Default 0. */
  worksForPolls?: number;
  stop?: StopBehaviour;
  /** Never register a row at all — the session vanished before the first poll. */
  vanishes?: boolean;
}

interface LoopResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Every `claude --bg` argv, in order. */
  dispatches: string[][];
  stopCalls: string[];
  signals: Array<{pid: number; sig: string}>;
  ledger: LedgerRow[];
  /** br argv, in order. */
  brCalls: string[][];
}

const MAX_POLLS = 500;

/**
 * Run the whole loop against a scripted world.
 *
 * `scans` are the answers to `br list -l handoff --json`, IN CALL ORDER: the
 * first is the start-of-run scan, then one per session that ends normally. A
 * scan beyond the end of the list answers "no open handoff beads", which is the
 * honest default for a repo where nothing is waiting.
 */
async function runLoop(spec: {
  opts?: Partial<JustinLoopOptions>;
  scans?: Array<BeadSpec[] | 'unavailable'>;
  sessions?: SessionScript[];
}): Promise<LoopResult> {
  const rows = new Map<string, AgentRow>();
  const scriptOf = new Map<string, SessionScript>();
  const dispatches: string[][] = [];
  const stopCalls: string[] = [];
  const signals: Array<{pid: number; sig: string}> = [];
  const ledger: LedgerRow[] = [];
  const brCalls: string[][] = [];
  let stdout = '';
  let stderr = '';
  let clock = Date.UTC(2026, 8, 8, 11, 30, 0);
  let scanIndex = 0;
  let dispatched = 0;
  let polls = 0;
  const pollsFor = new Map<string, number>();

  const br: BrRunner = (_cwd, args) => {
    brCalls.push(args);
    if (args[0] !== 'list') return {ok: true, reason: null, stdout: '{"issues":[]}'};
    const answer = (spec.scans ?? [])[scanIndex++];
    if (answer === 'unavailable') {
      return {ok: false, reason: 'br exited 1: no beads workspace', stdout: ''};
    }
    return {ok: true, reason: null, stdout: listJson(answer ?? [])};
  };

  const deps: RunnerDeps = {
    appendLedgerRow: (_path, row) => {
      ledger.push(row);
      return {ok: true, reason: null};
    },
    br,
    dispatch: (_cwd, args) => {
      dispatches.push(args);
      dispatched++;
      const id = `sess-${dispatched}`;
      const script = (spec.sessions ?? [])[dispatched - 1] ?? {};
      scriptOf.set(id, script);
      pollsFor.set(id, 0);
      if (!(script.vanishes === true)) {
        rows.set(id, {
          id,
          name: args[args.indexOf('--name') + 1] ?? '',
          // MEASURED: a live row carries a pid; an ended one keeps it.
          pid: 4000 + dispatched,
          // A session with a working period starts `working`; otherwise it is
          // already `done` on the first poll, which is the common case here.
          state:
            script.state ??
            (script.worksForPolls != null ? 'working' : 'done'),
          status: 'idle',
          waitingFor: null,
        });
      }
      return `backgrounded · ${id} · ${args[args.indexOf('--name') + 1] ?? ''}\n`;
    },
    findAgent: (_cwd, id) => {
      polls++;
      if (polls > MAX_POLLS) {
        throw new Error(`runJustinLoop did not terminate within ${MAX_POLLS} polls`);
      }
      const row = rows.get(id);
      if (row == null) return null;
      const script = scriptOf.get(id) ?? {};
      const seen = (pollsFor.get(id) ?? 0) + 1;
      pollsFor.set(id, seen);
      // A session that "works for N polls" flips to done afterwards, so a
      // timeout test can hold it working forever with a large N.
      if (script.worksForPolls != null && seen > script.worksForPolls) {
        return {...row, state: 'done'};
      }
      return row;
    },
    gitHead: () => `head-${dispatched}`,
    notifyBlocked: () => {},
    now: () => clock,
    preflight: () => [],
    readUsage: () => null,
    signalPid: (pid, sig) => {
      signals.push({pid, sig: String(sig)});
      for (const [id, row] of rows) {
        if (row.pid === pid && scriptOf.get(id)?.stop === 'clears-on-signal') {
          rows.delete(id);
        }
      }
      return true;
    },
    sleep: async (ms) => {
      clock += ms;
    },
    stopSession: (_cwd, id) => {
      stopCalls.push(id);
      const behaviour = scriptOf.get(id)?.stop ?? 'clears';
      if (behaviour === 'clears') rows.delete(id);
      if (behaviour === 'lingers-pidless') {
        const row = rows.get(id);
        if (row != null) rows.set(id, {...row, pid: null});
      }
      return {detail: `stopped ${id}`, ok: true};
    },
    write: (text) => {
      stdout += text;
    },
    writeErr: (text) => {
      stderr += text;
    },
  };

  const exitCode = await runJustinLoop(
    '/repo',
    {maxSessions: 2, usageGate: false, ...spec.opts},
    deps,
  );
  return {brCalls, dispatches, exitCode, ledger, signals, stderr, stdout, stopCalls};
}

function argOf(args: string[], flag: string): string {
  const i = args.indexOf(flag);
  return i >= 0 ? (args[i + 1] ?? '') : '';
}

/** `claude --bg … <prompt>` — the prompt is the last positional. */
function promptOf(args: string[]): string {
  return args[args.length - 1] ?? '';
}

// ---------------------------------------------------------------------------
// AC1 — the disposition acted on after a session ends
// ---------------------------------------------------------------------------

describe('AC1: an ended session with ONE valid continue-handoff boots a successor', () => {
  const CONTINUE_NEXT =
    'Rewrite parseFoo so it rejects a relative worktree, then run bun test.';

  async function chain(): Promise<LoopResult> {
    return runLoop({
      scans: [
        [], // start of run: nothing waiting
        [beadFrom('hoff-1', {from: 'the-arc-1', next: CONTINUE_NEXT})],
        [beadFrom('hoff-2', {disposition: 'done', from: 'the-arc-2'})],
      ],
      opts: {label: 'the-arc', maxSessions: 3},
    });
  }

  test('a second session is dispatched, and only after the first is gone', async () => {
    const r = await chain();
    expect(r.dispatches).toHaveLength(2);
    // The predecessor was stopped before the successor was dispatched.
    expect(r.stopCalls).toContain('sess-1');
  });

  test("the successor's PROMPT is the bead's `next`, verbatim (D6)", async () => {
    const r = await chain();
    expect(promptOf(r.dispatches[1])).toContain(CONTINUE_NEXT);
    // …and not the run's own ask, which belonged to session 1.
    expect(promptOf(r.dispatches[1])).not.toContain('/loop-session');
  });

  test("the successor's SYSTEM PROMPT is its own contract plus the pickup preamble naming the bead", async () => {
    const r = await chain();
    const systemPrompt = argOf(r.dispatches[1], '--append-system-prompt');
    // Its OWN label, not its predecessor's — this is what it stamps on --from.
    expect(systemPrompt).toContain('Your session label is `the-arc-2`');
    expect(systemPrompt).toContain('--from=the-arc-2');
    expect(systemPrompt).not.toContain('--from=the-arc-1');
    // The pickup preamble, naming the bead it must read and claim.
    expect(systemPrompt).toContain('PICK UP THE HANDOFF FIRST');
    expect(systemPrompt).toContain('br show hoff-1');
    expect(systemPrompt).toContain("br close hoff-1 --reason='picked up by the-arc-2'");
  });

  test('session 1 gets no pickup preamble — nothing was waiting for it', async () => {
    const r = await chain();
    expect(argOf(r.dispatches[0], '--append-system-prompt')).not.toContain(
      'PICK UP THE HANDOFF FIRST',
    );
    expect(argOf(r.dispatches[0], '--append-system-prompt')).toContain(
      'Your session label is `the-arc-1`',
    );
  });

  test('the ledger records the continue and names the bead', async () => {
    const r = await chain();
    expect(r.ledger[0].outcome).toBe('continue');
    expect(r.ledger[0].handoffBead).toBe('hoff-1');
    expect(r.ledger[0].label).toBe('the-arc-1');
    expect(r.ledger[0].contextTokens).toBe(302_000);
  });
});

describe('AC1: done and blocked stop the loop', () => {
  test('done stops at exit 0 and spawns nothing more', async () => {
    const r = await runLoop({
      opts: {label: 'the-arc'},
      scans: [[], [beadFrom('hoff-9', {disposition: 'done', from: 'the-arc-1'})]],
    });
    expect(r.exitCode).toBe(0);
    expect(r.dispatches).toHaveLength(1);
    expect(r.stdout).toContain('done');
    expect(r.ledger[0].outcome).toBe('done');
  });

  test('blocked stops at exit 2 and PRINTS the open questions', async () => {
    const r = await runLoop({
      opts: {label: 'the-arc'},
      scans: [
        [],
        [
          beadFrom('hoff-b', {
            disposition: 'blocked',
            from: 'the-arc-1',
            openQuestions: [
              'Should the runner delete remote branches automatically?',
              'Is 0.24.0 a breaking release?',
            ],
          }),
        ],
      ],
    });
    expect(r.exitCode).toBe(2);
    expect(r.dispatches).toHaveLength(1);
    expect(r.stdout).toContain(
      'Should the runner delete remote branches automatically?',
    );
    expect(r.stdout).toContain('Is 0.24.0 a breaking release?');
    expect(r.ledger[0].outcome).toBe('blocked');
  });

  test('a blocked handoff with no questions says so rather than printing nothing', async () => {
    // Silence must be a claim: "blocked, and here is nothing" would read as a
    // rendering bug rather than as a session that failed to say what it needs.
    const r = await runLoop({
      opts: {label: 'the-arc'},
      scans: [
        [],
        [beadFrom('hoff-b', {disposition: 'blocked', from: 'the-arc-1'})],
      ],
    });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain('listed no open questions');
  });
});

describe('AC1: zero, unreadable-only and two-open NEVER spawn', () => {
  test('ZERO handoffs: the run stops, says which label it looked for, spawns nothing', async () => {
    const r = await runLoop({opts: {label: 'the-arc'}, scans: [[], []]});
    expect(r.dispatches).toHaveLength(1);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain('ended without creating a handoff bead');
    expect(r.stdout).toContain('the-arc-1');
    expect(r.ledger[0].outcome).toBe('no-handoff');
    // The hook .3 takes over is named, so this is visibly unfinished, not silent.
    expect(r.stdout).toContain('home-base-1r6d.33.3');
  });

  test("another session's handoff is not this session's, and is counted", async () => {
    const r = await runLoop({
      opts: {label: 'the-arc'},
      scans: [[], [beadFrom('hoff-other', {from: 'some-other-run-7'})]],
    });
    expect(r.dispatches).toHaveLength(1);
    expect(r.exitCode).toBe(2);
    expect(r.ledger[0].outcome).toBe('no-handoff');
    expect(r.stdout).toContain('belong to other sessions');
  });

  test('UNREADABLE only: never spawns, and the errors are printed per bead', async () => {
    const r = await runLoop({
      opts: {label: 'the-arc'},
      scans: [
        [],
        [
          {id: 'hoff-broken', notes: 'see the epic', title: 'HANDOFF ???'},
          {id: 'hoff-noteless', notes: null, title: 'HANDOFF ???'},
        ],
      ],
    });
    expect(r.dispatches).toHaveLength(1);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain('hoff-broken');
    expect(r.stdout).toContain('hoff-noteless');
    expect(r.stdout).toContain('UNREADABLE');
    // Ledgered differently from "wrote nothing": one of these MIGHT be its
    // handoff, and that is a different problem to hand .3.
    expect(r.ledger[0].outcome).toBe('invalid-handoff');
    expect(r.stdout).toContain('may be this session');
  });

  test('TWO open handoffs with this from: stops, names both, spawns nothing', async () => {
    // The forked chain. Picking a winner here is how 1→2→4→8 starts.
    const r = await runLoop({
      opts: {label: 'the-arc'},
      scans: [
        [],
        [
          beadFrom('hoff-a', {from: 'the-arc-1'}),
          beadFrom('hoff-b', {from: 'the-arc-1'}),
        ],
      ],
    });
    expect(r.dispatches).toHaveLength(1);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain('hoff-a');
    expect(r.stdout).toContain('hoff-b');
    expect(r.ledger[0].outcome).toBe('multiple-handoffs');
    expect(r.stdout).toContain('forked');
  });

  test('br UNAVAILABLE never reads as "no handoff exists"', async () => {
    const r = await runLoop({opts: {label: 'the-arc'}, scans: [[], 'unavailable']});
    expect(r.dispatches).toHaveLength(1);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain('rather than guessing that none exist');
    expect(r.ledger[0].outcome).toBe('br-unavailable');
  });

  test('POSITIVE CONTROL: the same harness DOES spawn on a valid continue', async () => {
    // Without this, every "never spawns" test above would also pass if the
    // runner were incapable of spawning at all.
    const r = await runLoop({
      opts: {label: 'the-arc'},
      scans: [[], [beadFrom('hoff-ok', {from: 'the-arc-1'})]],
    });
    expect(r.dispatches).toHaveLength(2);
  });
});

describe('decideAfterSession — the pure decision (D5)', () => {
  function scan(beads: BeadSpec[]): HandoffScan {
    return {
      kind: 'ok',
      rows: beads.map((b) => ({
        id: b.id,
        labels: b.labels ?? [HANDOFF_LABEL],
        notes: b.notes ?? null,
        status: 'open',
        title: b.title ?? 't',
        updatedAt: null,
      })),
    };
  }

  test('identity is `from`, matched exactly', () => {
    const out = decideAfterSession(
      scan([beadFrom('h1', {from: 'the-arc-1'})]),
      'the-arc-1',
    );
    expect(out.kind).toBe('continue');
  });

  test('a from that merely STARTS WITH the label is not a match', () => {
    // `the-arc-1` and `the-arc-10` are different sessions of the same run.
    const out = decideAfterSession(
      scan([beadFrom('h1', {from: 'the-arc-10'})]),
      'the-arc-1',
    );
    expect(out.kind).toBe('enforce');
  });

  test('an unreadable bead never becomes the decision, but always the report', () => {
    const out = decideAfterSession(
      scan([
        {id: 'broken', notes: '{{{'},
        beadFrom('h1', {from: 'the-arc-1'}),
      ]),
      'the-arc-1',
    );
    expect(out.kind).toBe('continue');
    expect(out.kind === 'continue' ? out.invalid.map((i) => i.id) : []).toEqual([
      'broken',
    ]);
  });

  test('every disposition maps to its own outcome', () => {
    for (const [disposition, kind] of [
      ['continue', 'continue'],
      ['done', 'done'],
      ['blocked', 'blocked'],
    ] as const) {
      const out = decideAfterSession(
        scan([beadFrom('h1', {disposition, from: 'the-arc-1'})]),
        'the-arc-1',
      );
      expect(out.kind).toBe(kind);
    }
  });

  test('an unavailable scan is its own outcome, never "none"', () => {
    const out = decideAfterSession(
      {kind: 'unavailable', reason: 'br exited 1'},
      'the-arc-1',
    );
    expect(out.kind).toBe('br-unavailable');
  });
});

// ---------------------------------------------------------------------------
// AC2 — verified stop before any spawn
// ---------------------------------------------------------------------------

describe('AC2: stopAndVerify (D6)', () => {
  interface StopWorld {
    report: Awaited<ReturnType<typeof stopAndVerify>>;
    stops: number;
    signals: string[];
    polls: number;
  }

  async function runStop(spec: {
    /** The row as seen on each poll; null = absent. */
    rowAt: (poll: number) => AgentRow | null;
    onStop?: () => void;
    onSignal?: (sig: string) => void;
  }): Promise<StopWorld> {
    let polls = 0;
    let stops = 0;
    const signals: string[] = [];
    const deps: StopDeps = {
      findAgent: () => spec.rowAt(polls++),
      signalPid: (_pid, sig) => {
        signals.push(String(sig));
        spec.onSignal?.(String(sig));
        return true;
      },
      sleep: async () => {},
      stopSession: () => {
        stops++;
        spec.onStop?.();
        return {detail: 'stopped', ok: true};
      },
    };
    const report = await stopAndVerify('/repo', 'sess-1', 0, deps);
    return {polls, report, signals, stops};
  }

  const live: AgentRow = {
    id: 'sess-1',
    name: 'n',
    pid: 4242,
    state: 'done',
    status: 'idle',
    waitingFor: null,
  };

  test('an absent row is ALREADY-GONE, and nothing is stopped or signalled', async () => {
    const w = await runStop({rowAt: () => null});
    expect(w.report.outcome).toBe('already-gone');
    expect(w.stops).toBe(0);
    expect(w.signals).toEqual([]);
  });

  test('`claude stop` clearing the row is STOPPED, on two consecutive absences', async () => {
    let cleared = false;
    const w = await runStop({
      onStop: () => {
        cleared = true;
      },
      rowAt: () => (cleared ? null : live),
    });
    expect(w.report.outcome).toBe('stopped');
    expect(w.stops).toBe(1);
    // No signals needed: `claude stop` is the measured mechanism.
    expect(w.signals).toEqual([]);
    expect(w.report.notes.join('\n')).toContain('verified gone');
  });

  test('ONE absent poll is not enough — a reappearing row resets the count', async () => {
    // MEASURED: after a SIGTERM the row briefly loses its pid and then comes
    // back under a new one. A single absent observation must not be believed.
    let poll = 0;
    const w = await runStop({
      rowAt: () => {
        poll++;
        // 1 = the initial presence check (there IS something to stop), then
        // absent, present, absent, absent — only the last pair counts.
        if (poll === 1 || poll === 3) return live;
        return null;
      },
    });
    expect(w.report.outcome).toBe('stopped');
    expect(w.report.notes.join('\n')).toContain('2 consecutive polls');
  });

  test('a row that survives everything is KILL-FAILED, and says what it saw', async () => {
    const w = await runStop({rowAt: () => live});
    expect(w.report.outcome).toBe('kill-failed');
    expect(isVerifiedGone(w.report.outcome)).toBe(false);
    // The full ladder was tried, in the measured order.
    expect(w.stops).toBe(2);
    expect(w.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(w.report.notes.join('\n')).toContain('STILL PRESENT');
    expect(w.report.notes.join('\n')).toContain('NOT verified gone');
  });

  test('`claude stop` LEADS the ladder — signals are the last resort', async () => {
    // Ordering is load-bearing: SIGTERM alone is MEASURED to make the daemon
    // respawn the session under a new pid, so signalling first would restart
    // the very session we are trying to stop.
    const w = await runStop({rowAt: () => live});
    const notes = w.report.notes.join('\n');
    expect(notes.indexOf('claude stop sess-1:')).toBeLessThan(
      notes.indexOf('SIGTERM'),
    );
    expect(notes).toContain('measured to RESPAWN');
  });

  test('a pidless survivor is NO-PID, distinct from kill-failed', async () => {
    const pidless = {...live, pid: null};
    const w = await runStop({rowAt: () => pidless});
    expect(w.report.outcome).toBe('no-pid');
    expect(isVerifiedGone(w.report.outcome)).toBe(false);
    // There was nothing to signal, and it said so rather than pretending.
    expect(w.signals).toEqual([]);
    expect(w.report.notes.join('\n')).toContain('no pid to signal');
  });

  test('a row that only dies on a signal still ends as STOPPED', async () => {
    let dead = false;
    const w = await runStop({
      onSignal: () => {
        dead = true;
      },
      rowAt: () => (dead ? null : live),
    });
    expect(w.report.outcome).toBe('stopped');
    expect(w.signals).toContain('SIGTERM');
  });

  test('only stopped and already-gone license a spawn', () => {
    const licensed: StopOutcome[] = ['stopped', 'already-gone'];
    const refused: StopOutcome[] = ['no-pid', 'kill-failed'];
    for (const o of licensed) expect(isVerifiedGone(o)).toBe(true);
    for (const o of refused) expect(isVerifiedGone(o)).toBe(false);
  });
});

describe('AC2: the loop refuses to spawn onto a live predecessor', () => {
  test('a valid continue-handoff does NOT spawn when the row will not clear', async () => {
    // The whole point. Session 1 wrote a perfectly good handoff; its row is
    // still in `claude agents`; the successor must not start.
    const r = await runLoop({
      opts: {label: 'the-arc'},
      scans: [[], [beadFrom('hoff-1', {from: 'the-arc-1'})]],
      sessions: [{stop: 'lingers'}],
    });
    expect(r.dispatches).toHaveLength(1);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain('REFUSING TO SPAWN');
    expect(r.stdout).toContain('still present in `claude agents`');
    expect(r.ledger[0].stopOutcome).toBe('kill-failed');
  });

  test('a pidless survivor also refuses the spawn', async () => {
    const r = await runLoop({
      opts: {label: 'the-arc'},
      scans: [[], [beadFrom('hoff-1', {from: 'the-arc-1'})]],
      sessions: [{stop: 'lingers-pidless'}],
    });
    expect(r.dispatches).toHaveLength(1);
    expect(r.exitCode).toBe(2);
    expect(r.ledger[0].stopOutcome).toBe('no-pid');
  });

  test('NEGATIVE CONTROL: the same script spawns once the stop works', async () => {
    const r = await runLoop({
      opts: {label: 'the-arc'},
      scans: [[], [beadFrom('hoff-1', {from: 'the-arc-1'})]],
      sessions: [{stop: 'clears'}],
    });
    expect(r.dispatches).toHaveLength(2);
    expect(r.ledger[0].stopOutcome).toBe('stopped');
  });

  test('the stop outcome is printed AND ledgered on every path', async () => {
    const r = await runLoop({
      opts: {label: 'the-arc'},
      scans: [[], [beadFrom('hoff-9', {disposition: 'done', from: 'the-arc-1'})]],
    });
    expect(r.stdout).toContain('verified gone');
    expect(r.stdout).toContain('stop=stopped');
    expect(r.ledger[0].stopOutcome).toBe('stopped');
  });

  test('a session that vanished on its own is already-gone, not a failure', async () => {
    const r = await runLoop({
      opts: {label: 'the-arc'},
      scans: [[], [beadFrom('hoff-1', {from: 'the-arc-1'})]],
      sessions: [{vanishes: true}],
    });
    expect(r.ledger[0].stopOutcome).toBe('already-gone');
    expect(r.dispatches).toHaveLength(2);
  });

  test('EVERY session is stopped, including the last one of the chain', async () => {
    // The graveyard fix: 17 sessions on this machine were left blocked and
    // listed, oldest 43 days, because nothing ever stopped them.
    const r = await runLoop({
      opts: {label: 'the-arc', maxSessions: 2},
      scans: [
        [],
        [beadFrom('hoff-1', {from: 'the-arc-1'})],
        [beadFrom('hoff-2', {disposition: 'done', from: 'the-arc-2'})],
      ],
    });
    expect(r.stopCalls).toEqual(['sess-1', 'sess-2']);
  });
});

// ---------------------------------------------------------------------------
// AC3 — the timeout
// ---------------------------------------------------------------------------

describe('AC3: --timeout-min', () => {
  test('the default is NONE, so a long session is never reaped', async () => {
    expect(DEFAULT_OPTIONS.timeoutMin).toBe(0);
    const r = await runLoop({
      opts: {label: 'the-arc', pollSec: 60},
      // Works for 300 simulated minutes, far past the old 45-minute default.
      scans: [[], [beadFrom('hoff-9', {disposition: 'done', from: 'the-arc-1'})]],
      sessions: [{worksForPolls: 300}],
    });
    expect(r.exitCode).toBe(0);
    expect(r.ledger[0].outcome).toBe('done');
  });

  test('a configured timeout stops the session, verifies it, and never spawns', async () => {
    const r = await runLoop({
      opts: {label: 'the-arc', pollSec: 60, timeoutMin: 5},
      // A valid continue-handoff IS present — and is deliberately NOT acted on.
      // A session stopped mid-flight did not choose to hand off (D7).
      scans: [[], [beadFrom('hoff-1', {from: 'the-arc-1'})]],
      sessions: [{worksForPolls: 10_000}],
    });
    expect(r.dispatches).toHaveLength(1);
    expect(r.stopCalls).toEqual(['sess-1']);
    expect(r.stdout).toContain('verified gone');
    expect(r.exitCode).toBe(2);
    expect(r.ledger[0].outcome).toBe('no-handoff');
    expect(r.stdout).toContain('--timeout-min');
  });

  test('NEGATIVE CONTROL: the same session under no timeout runs to its handoff', async () => {
    const r = await runLoop({
      opts: {label: 'the-arc', pollSec: 60, timeoutMin: 0},
      scans: [[], [beadFrom('hoff-1', {from: 'the-arc-1'})]],
      // Ends on its own, well past where the 5m timeout above fired.
      sessions: [{worksForPolls: 20}],
    });
    expect(r.dispatches).toHaveLength(2);
    expect(r.ledger[0].outcome).toBe('continue');
  });
});

// ---------------------------------------------------------------------------
// AC4 — identity: labels and names
// ---------------------------------------------------------------------------

describe('AC4: labels and session names (D3)', () => {
  test('a label is `<slug>-<n>` and contains nothing a shell would eat', () => {
    // The contract writes `--from=<label>` UNQUOTED, so a space or a `#` here
    // silently truncates the flag. This is why the `#<n>` name format was
    // retracted.
    const label = sessionLabel(runSlug({label: 'Fix the Parser!', prompt: 'x'}), 3);
    expect(label).toBe('fix-the-parser-3');
    expect(label).toMatch(/^[a-z0-9-]+$/);
  });

  test('--label wins over the ask', () => {
    expect(runSlug({label: 'my-arc', prompt: 'something else entirely'})).toBe(
      'my-arc',
    );
  });

  test('without --label the slug is derived from the ask, meaningfully', () => {
    expect(deriveSlug('Please can you fix the worktree hydration bug')).toBe(
      'fix-worktree-hydration-bug',
    );
    expect(deriveSlug('/loop-session')).toBe('loop-session');
  });

  test('the slug is NEVER empty, whatever it is handed', () => {
    // An empty slug would produce `--from=-1` in the contract and a nameless
    // row in `claude agents`.
    for (const input of ['', '   ', '!!!', '###', '– — ·']) {
      const slug = runSlug({label: input, prompt: input});
      expect(slug).not.toBe('');
      expect(slug).toMatch(/^[a-z0-9-]+$/);
    }
    expect(runSlug({label: '###', prompt: '!!!'})).toBe(FALLBACK_SLUG);
  });

  test('a garbage --label falls back to the ask rather than to nothing', () => {
    expect(runSlug({label: '###', prompt: 'fix the parser'})).toBe('fix-parser');
  });

  test('slugify never leaves a trailing dash, even when it truncates', () => {
    const long = slugify('a'.repeat(30) + ' ' + 'b'.repeat(30));
    expect(long.endsWith('-')).toBe(false);
    expect(long.length).toBeLessThanOrEqual(40);
  });

  test('the name is `<YYYY-MM-DD HH:mm> <label>`, and the label is a substring', () => {
    const stamp = runStamp(new Date(2026, 8, 8, 4, 5));
    expect(stamp).toBe('2026-09-08 04:05');
    const name = sessionName(stamp, 'the-arc-2');
    expect(name).toBe('2026-09-08 04:05 the-arc-2');
    expect(name).toContain('the-arc-2');
  });

  test('the whole chain shares ONE kickoff stamp, so it sorts together', async () => {
    const r = await runLoop({
      // Session 1 runs for 200 simulated minutes, so a name stamped per session
      // would land in a different minute and the chain would scatter in
      // `claude agents`.
      opts: {label: 'the-arc', maxSessions: 2, pollSec: 60},
      scans: [
        [],
        [beadFrom('hoff-1', {from: 'the-arc-1'})],
        [beadFrom('hoff-2', {disposition: 'done', from: 'the-arc-2'})],
      ],
      sessions: [{worksForPolls: 200}],
    });
    const names = r.dispatches.map((d) => argOf(d, '--name'));
    expect(names).toHaveLength(2);
    const stamp = names[0].slice(0, 16);
    expect(names[1].startsWith(stamp)).toBe(true);
    expect(names[0]).toBe(`${stamp} the-arc-1`);
    expect(names[1]).toBe(`${stamp} the-arc-2`);
  });

  test('the dispatched --name matches the ledger row', async () => {
    const r = await runLoop({
      opts: {label: 'the-arc'},
      scans: [[], [beadFrom('h', {disposition: 'done', from: 'the-arc-1'})]],
    });
    expect(r.ledger[0].name).toBe(argOf(r.dispatches[0], '--name'));
    expect(r.ledger[0].name).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} the-arc-1$/);
  });
});

// ---------------------------------------------------------------------------
// AC5 — the ledger, and nothing under the repo's scratch directory
// ---------------------------------------------------------------------------

describe('AC5: the ledger lives outside the repo (D9)', () => {
  test('NOTHING in src/justin-loop references a repo-local scratch path', () => {
    // The verdict file and the old ledger both lived there. This is a source
    // grep rather than a behaviour test on purpose: the failure it guards
    // against is someone reintroducing a repo-local path in a new code path.
    const dir = join(import.meta.dirname, '..', 'src', 'justin-loop');
    const offenders: string[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.ts')) continue;
      if (readFileSync(join(dir, file), 'utf8').includes('tmp/')) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('runs.jsonl sits under the state dir, and the default is ~/.local/state', () => {
    expect(runsJsonlPath('/state')).toBe('/state/runs.jsonl');
    expect(runsJsonlPath(DEFAULT_OPTIONS.stateDir)).toContain(
      '.local/state/justin-sdk/justin-loop/runs.jsonl',
    );
  });

  test('a real run appends one JSON line per session, with every field', async () => {
    // The one test that writes to a real file — into a temp dir, never the real
    // state directory.
    const stateDir = mkdtempSync(join(tmpdir(), 'justin-loop-state-'));
    const rows = new Map<string, AgentRow>();
    let dispatched = 0;
    const deps: RunnerDeps = {
      // The REAL ledger writer, which is the point of this test.
      appendLedgerRow,
      br: (_cwd, args) =>
        args[0] === 'list'
          ? {
              ok: true,
              reason: null,
              stdout:
                dispatched === 0
                  ? listJson([])
                  : listJson([
                      beadFrom('hoff-z', {
                        disposition: 'done',
                        from: 'the-arc-1',
                      }),
                    ]),
            }
          : {ok: true, reason: null, stdout: ''},
      dispatch: (_cwd, args) => {
        dispatched++;
        rows.set('sess-1', {
          id: 'sess-1',
          name: args[args.indexOf('--name') + 1] ?? '',
          pid: 1,
          state: 'done',
          status: 'idle',
          waitingFor: null,
        });
        return 'backgrounded · sess-1 · n\n';
      },
      findAgent: (_cwd, id) => rows.get(id) ?? null,
      gitHead: () => 'abc',
      notifyBlocked: () => {},
      now: () => Date.UTC(2026, 8, 8, 11, 30),
      preflight: () => [],
      readUsage: () => null,
      signalPid: () => true,
      sleep: async () => {},
      stopSession: (_cwd, id) => {
        rows.delete(id);
        return {detail: 'stopped', ok: true};
      },
      write: () => {},
      writeErr: () => {},
    };
    const exitCode = await runJustinLoop(
      '/repo',
      {label: 'the-arc', maxSessions: 1, stateDir, usageGate: false},
      deps,
    );
    expect(exitCode).toBe(0);

    const path = runsJsonlPath(stateDir);
    expect(existsSync(path)).toBe(true);
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const row = JSON.parse(lines[0]) as LedgerRow;
    expect(row.schemaVersion).toBe(1);
    expect(row.n).toBe(1);
    expect(row.label).toBe('the-arc-1');
    expect(row.outcome).toBe('done');
    expect(row.handoffBead).toBe('hoff-z');
    expect(row.stopOutcome).toBe('stopped');
    expect(row.sessionId).toBe('sess-1');
    expect(row.runId).toContain('the-arc');
    expect(typeof row.startedAt).toBe('string');
    expect(typeof row.endedAt).toBe('string');
    expect(row.progressed).toBe(false);
  });

  test('a ledger write failure WARNS and does not kill the run', async () => {
    // Never fatal, and never silent: a run that quietly stopped ledgering looks
    // exactly like a run that never happened (critical rule 6).
    const rows = new Map<string, AgentRow>();
    let stdout = '';
    let stderr = '';
    let dispatched = 0;
    const deps: RunnerDeps = {
      appendLedgerRow: () => ({ok: false, reason: 'EACCES: permission denied'}),
      br: (_cwd, args) =>
        args[0] === 'list'
          ? {
              ok: true,
              reason: null,
              stdout:
                dispatched === 0
                  ? listJson([])
                  : listJson([
                      beadFrom('hoff-z', {
                        disposition: 'done',
                        from: 'the-arc-1',
                      }),
                    ]),
            }
          : {ok: true, reason: null, stdout: ''},
      dispatch: () => {
        dispatched++;
        rows.set('sess-1', {
          id: 'sess-1',
          name: 'n',
          pid: 1,
          state: 'done',
          status: 'idle',
          waitingFor: null,
        });
        return 'backgrounded · sess-1 · n\n';
      },
      findAgent: (_cwd, id) => rows.get(id) ?? null,
      gitHead: () => 'abc',
      notifyBlocked: () => {},
      now: () => Date.UTC(2026, 8, 8, 11, 30),
      preflight: () => [],
      readUsage: () => null,
      signalPid: () => true,
      sleep: async () => {},
      stopSession: (_cwd, id) => {
        rows.delete(id);
        return {detail: 'stopped', ok: true};
      },
      write: (t) => {
        stdout += t;
      },
      writeErr: (t) => {
        stderr += t;
      },
    };
    const exitCode = await runJustinLoop(
      '/repo',
      {label: 'the-arc', maxSessions: 1, usageGate: false},
      deps,
    );
    // The run reached its own conclusion…
    expect(exitCode).toBe(0);
    expect(stdout).toContain('done');
    // …and said, out loud, that the ledger did not get written.
    expect(stderr).toContain('could not append');
    expect(stderr).toContain('EACCES');
  });
});
