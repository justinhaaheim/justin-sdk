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
 * spawns a process and nothing writes to the real state directory. That world
 * lives in ./justin-loop-world.ts, shared with justin-loop-enforce.test.ts.
 */

import {describe, expect, test} from 'bun:test';
import {existsSync, mkdtempSync, readdirSync, readFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {HANDOFF_LABEL} from '../src/justin-loop/handoff';
import {
  type AgentRow,
  appendLedgerRow,
  decideAfterSession,
  DEFAULT_OPTIONS,
  deriveSlug,
  FALLBACK_SLUG,
  type HandoffScan,
  isVerifiedGone,
  type JustinLoopOptions,
  type LedgerRow,
  runJustinLoop,
  type RunnerDeps,
  runsJsonlPath,
  runSlug,
  runStamp,
  sessionLabel,
  sessionName,
  slugify,
  stopAndVerify,
  type StopDeps,
  type StopOutcome,
} from '../src/justin-loop/runner';
import {
  argOf,
  at,
  beadFrom,
  type BeadSpec,
  ledgerReaderNeverCalled,
  listJson,
  type LoopResult,
  promptOf,
  resumes,
  runLoop,
  spawns,
} from './justin-loop-world';

// ---------------------------------------------------------------------------
// AC1 — the disposition acted on after a session ends
// ---------------------------------------------------------------------------

describe('AC1: an ended session with ONE valid continue-handoff boots a successor', () => {
  const CONTINUE_NEXT =
    'Rewrite parseFoo so it rejects a relative worktree, then run bun test.';

  async function chain(): Promise<LoopResult> {
    return await runLoop({
      opts: {label: 'the-arc', maxSessions: 3},
      scans: [
        [], // start of run: nothing waiting
        [beadFrom('hoff-1', {from: 'the-arc-1', next: CONTINUE_NEXT})],
        [beadFrom('hoff-2', {disposition: 'done', from: 'the-arc-2'})],
      ],
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
    expect(promptOf(at(r.dispatches, 1))).toContain(CONTINUE_NEXT);
    // …and not the run's own ask, which belonged to session 1.
    expect(promptOf(at(r.dispatches, 1))).not.toContain('/loop-session');
  });

  test("the successor's SYSTEM PROMPT is its own contract plus the pickup preamble naming the bead", async () => {
    const r = await chain();
    const systemPrompt = argOf(at(r.dispatches, 1), '--append-system-prompt');
    // Its OWN label, not its predecessor's — this is what it stamps on --from.
    expect(systemPrompt).toContain('Your session label is `the-arc-2`');
    expect(systemPrompt).toContain('--from=the-arc-2');
    expect(systemPrompt).not.toContain('--from=the-arc-1');
    // The pickup preamble, naming the bead it must read and claim.
    expect(systemPrompt).toContain('PICK UP THE HANDOFF FIRST');
    expect(systemPrompt).toContain('br show hoff-1');
    expect(systemPrompt).toContain(
      "br close hoff-1 --reason='picked up by the-arc-2'",
    );
  });

  test('session 1 gets no pickup preamble — nothing was waiting for it', async () => {
    const r = await chain();
    expect(argOf(at(r.dispatches, 0), '--append-system-prompt')).not.toContain(
      'PICK UP THE HANDOFF FIRST',
    );
    expect(argOf(at(r.dispatches, 0), '--append-system-prompt')).toContain(
      'Your session label is `the-arc-1`',
    );
  });

  test('the ledger records the continue and names the bead', async () => {
    const r = await chain();
    expect(r.ledger[0]?.outcome).toBe('continue');
    expect(r.ledger[0]?.handoffBead).toBe('hoff-1');
    expect(r.ledger[0]?.label).toBe('the-arc-1');
    expect(r.ledger[0]?.contextTokens).toBe(302_000);
  });
});

describe('AC1: done and blocked stop the loop', () => {
  test('done stops at exit 0 and spawns nothing more', async () => {
    const r = await runLoop({
      opts: {label: 'the-arc'},
      scans: [
        [],
        [beadFrom('hoff-9', {disposition: 'done', from: 'the-arc-1'})],
      ],
    });
    expect(r.exitCode).toBe(0);
    expect(r.dispatches).toHaveLength(1);
    expect(r.stdout).toContain('done');
    expect(r.ledger[0]?.outcome).toBe('done');
  });

  // D14 (home-base-r4fs): a `done` bead has no successor, so nobody else would
  // ever close it. Before D14 every finished chain left exactly one OPEN handoff
  // bead behind, in every repo a loop had ever finished in.
  test('done CLOSES the handoff bead through br, with a reason naming the run (D14)', async () => {
    const r = await runLoop({
      opts: {label: 'the-arc'},
      scans: [
        [],
        [beadFrom('hoff-9', {disposition: 'done', from: 'the-arc-1'})],
      ],
    });
    const closes = r.brCalls.filter((c) => c[0] === 'close');
    expect(closes).toHaveLength(1);
    // The runId is read off the ledger rather than hardcoded: it is built from
    // the LOCAL-time stamp, so spelling it out would make this test pass or fail
    // by timezone.
    expect(closes[0]).toEqual([
      'close',
      'hoff-9',
      `--reason=chain complete, read by justin-loop run ${r.ledger[0]?.runId}`,
    ]);
    expect(r.ledger[0]?.runId).toContain('the-arc');
    expect(r.stdout).toContain('closed hoff-9');
    expect(r.exitCode).toBe(0);
  });

  test('a br close that FAILS is printed on stderr WITH br’s reason, and the run still exits 0 (D14)', async () => {
    const r = await runLoop({
      brCloseFails: true,
      opts: {label: 'the-arc'},
      scans: [
        [],
        [beadFrom('hoff-9', {disposition: 'done', from: 'the-arc-1'})],
      ],
    });
    // The arc finished. Only the hygiene failed, so the verdict is unchanged…
    expect(r.exitCode).toBe(0);
    // …and the failure is a fact on stderr, never a silent skip.
    expect(r.stderr).toContain('hoff-9 could NOT be closed');
    expect(r.stderr).toContain('br exited 1: no issue with id hoff-9');
    expect(r.stderr).toContain('STILL OPEN');
    expect(r.stdout).not.toContain('closed hoff-9');
  });

  test('a br close failure shows ALL of br’s stderr, not just its first line (F4)', async () => {
    // home-base-685h F4. `reason` is one line by design, and this print used to
    // be `reason` alone — so a `br close` that failed with a usage block or a
    // Dolt error showed the heading and threw away the lines that said what to
    // do about it. The scripted failure here has three lines; all three land.
    const r = await runLoop({
      brCloseFails: true,
      opts: {label: 'the-arc'},
      scans: [
        [],
        [beadFrom('hoff-9', {disposition: 'done', from: 'the-arc-1'})],
      ],
    });
    expect(r.stderr).toContain('did you mean hoff-8?');
    expect(r.stderr).toContain('run `br list` to see what is open');
    // Still exit 0: F4 widens the print, it does not change the verdict.
    expect(r.exitCode).toBe(0);
  });

  test('blocked closes NOTHING and says the bead stays open on purpose (D14)', async () => {
    const r = await runLoop({
      opts: {label: 'the-arc'},
      scans: [
        [],
        [beadFrom('hoff-b', {disposition: 'blocked', from: 'the-arc-1'})],
      ],
    });
    expect(r.brCalls.filter((c) => c[0] === 'close')).toHaveLength(0);
    expect(r.stdout).toContain(
      'handoff hoff-b stays open — it is the question waiting for you',
    );
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
    expect(r.ledger[0]?.outcome).toBe('blocked');
  });

  test('blocked prints the ANSWER command and the rerun command (D16)', async () => {
    // home-base-1r6d.33.7. The run stops here with a question on the screen,
    // and this is the moment Justin is looking at it — so both halves of the
    // resume are printed with the real ids already filled in, rather than left
    // for him to reconstruct from a helper he has never run.
    const r = await runLoop({
      opts: {label: 'pilot2'},
      scans: [
        [],
        [beadFrom('hoff-b', {disposition: 'blocked', from: 'pilot2-1'})],
      ],
    });
    expect(r.stdout).toContain(
      "answer with: bun run justin-sdk justin-loop handoff answer hoff-b --answer '<your answer>'",
    );
    // The SLUG, not the label: `pilot2-1` is session 1 of the `pilot2` run.
    expect(r.stdout).toContain(
      'then re-run: bun run justin-sdk justin-loop --pickup --label pilot2\n',
    );
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
  // These pin the SCAN verdict, so they run with `--handoff-retries 0`: the
  // demand loop (home-base-1r6d.33.3) has its own describe below, and mixing the
  // two would make it unclear which mechanism a red test was accusing.
  const NO_DEMANDS: Partial<JustinLoopOptions> = {
    handoffRetries: 0,
    label: 'the-arc',
  };

  test('ZERO handoffs: the run stops, says which label it looked for, spawns nothing', async () => {
    const r = await runLoop({opts: NO_DEMANDS, scans: [[], []]});
    expect(spawns(r.dispatches)).toHaveLength(1);
    expect(resumes(r.dispatches)).toHaveLength(0);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain('ended without creating a handoff bead');
    expect(r.stdout).toContain('the-arc-1');
    expect(r.ledger[0]?.outcome).toBe('no-handoff');
    // Silence must be a claim: the run says WHY nothing was demanded.
    expect(r.stdout).toContain('--handoff-retries=0');
  });

  test("another session's handoff is not this session's, and is counted", async () => {
    const r = await runLoop({
      opts: NO_DEMANDS,
      scans: [[], [beadFrom('hoff-other', {from: 'some-other-run-7'})]],
    });
    expect(spawns(r.dispatches)).toHaveLength(1);
    expect(r.exitCode).toBe(2);
    expect(r.ledger[0]?.outcome).toBe('no-handoff');
    expect(r.stdout).toContain('belong to other sessions');
  });

  test('UNREADABLE only: never spawns, and the errors are printed per bead', async () => {
    const r = await runLoop({
      opts: NO_DEMANDS,
      scans: [
        [],
        [
          {id: 'hoff-broken', notes: 'see the epic', title: 'HANDOFF ???'},
          {id: 'hoff-noteless', notes: null, title: 'HANDOFF ???'},
        ],
      ],
    });
    expect(spawns(r.dispatches)).toHaveLength(1);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain('hoff-broken');
    expect(r.stdout).toContain('hoff-noteless');
    expect(r.stdout).toContain('UNREADABLE');
    // Ledgered differently from "wrote nothing": one of these MIGHT be its
    // handoff, and that is a different problem to demand a fix for.
    expect(r.ledger[0]?.outcome).toBe('invalid-handoff');
    expect(r.stdout).toContain('may be this session');
  });

  test('TWO open handoffs with this from: stops, names both, spawns nothing', async () => {
    // The forked chain. Picking a winner here is how 1→2→4→8 starts.
    const r = await runLoop({
      opts: NO_DEMANDS,
      scans: [
        [],
        [
          beadFrom('hoff-a', {from: 'the-arc-1'}),
          beadFrom('hoff-b', {from: 'the-arc-1'}),
        ],
      ],
    });
    expect(spawns(r.dispatches)).toHaveLength(1);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain('hoff-a');
    expect(r.stdout).toContain('hoff-b');
    expect(r.ledger[0]?.outcome).toBe('multiple-handoffs');
    expect(r.stdout).toContain('forked');
  });

  test('br UNAVAILABLE never reads as "no handoff exists"', async () => {
    const r = await runLoop({opts: NO_DEMANDS, scans: [[], 'unavailable']});
    expect(spawns(r.dispatches)).toHaveLength(1);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain('rather than guessing that none exist');
    expect(r.ledger[0]?.outcome).toBe('br-unavailable');
  });

  test('POSITIVE CONTROL: the same harness DOES spawn on a valid continue', async () => {
    // Without this, every "never spawns" test above would also pass if the
    // runner were incapable of spawning at all.
    const r = await runLoop({
      opts: NO_DEMANDS,
      scans: [[], [beadFrom('hoff-ok', {from: 'the-arc-1'})]],
    });
    expect(spawns(r.dispatches)).toHaveLength(2);
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
      scan([{id: 'broken', notes: '{{{'}, beadFrom('h1', {from: 'the-arc-1'})]),
      'the-arc-1',
    );
    expect(out.kind).toBe('continue');
    expect(out.kind === 'continue' ? out.invalid.map((i) => i.id) : []).toEqual(
      ['broken'],
    );
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
    polls: number;
    report: Awaited<ReturnType<typeof stopAndVerify>>;
    signals: string[];
    stops: number;
  }

  async function runStop(spec: {
    /**
     * Rows the listing SKIPPED on each poll (F7, 33.13). A readable listing
     * that threw rows away is not a full reading of `claude agents`, and one of
     * the rows it threw away could be the session being watched.
     */
    malformedAt?: (poll: number) => number;
    onSignal?: (sig: string) => void;
    onStop?: () => void;
    /**
     * The row as seen on each poll: null = absent, `'unreadable'` = the
     * `claude agents --json` call itself failed.
     */
    rowAt: (poll: number) => AgentRow | null | 'unreadable';
  }): Promise<StopWorld> {
    let polls = 0;
    let stops = 0;
    const signals: string[] = [];
    const deps: StopDeps = {
      findAgent: () => {
        const poll = polls++;
        const row = spec.rowAt(poll);
        return Promise.resolve(
          row === 'unreadable'
            ? {ok: false, reason: 'claude agents --json exited 1'}
            : {malformed: spec.malformedAt?.(poll) ?? 0, ok: true, row},
        );
      },
      signalPid: (_pid, sig) => {
        signals.push(String(sig));
        spec.onSignal?.(String(sig));
        return true;
      },
      sleep: () => Promise.resolve(),
      stopSession: () => {
        stops++;
        spec.onStop?.();
        return Promise.resolve({detail: 'stopped', ok: true});
      },
      // These tests assert on the REPORT; that the same notes also stream out
      // through this writer as they are made is asserted in
      // tests/justin-loop-liveness.test.ts.
      write: () => {
        /* stdout is not asserted in this test */
      },
    };
    const report = await stopAndVerify('/repo', 'sess-1', 0, deps);
    return {polls, report, signals, stops};
  }

  const live: AgentRow = {
    id: 'sess-1',
    name: 'n',
    pid: 4242,
    sessionId: 'sess-1-full-uuid',
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
    const refused: StopOutcome[] = ['no-pid', 'kill-failed', 'unverified'];
    for (const o of licensed) expect(isVerifiedGone(o)).toBe(true);
    for (const o of refused) expect(isVerifiedGone(o)).toBe(false);
  });

  /**
   * An unreadable `claude agents --json` is the most dangerous input this
   * function takes, because the shape of the failure IS the shape of success:
   * "no row for that id". `listAgents` used to return `[]` on a timeout, a
   * non-zero exit or unparseable output, so two failed polls in a row were
   * indistinguishable from two confirmed absences — and confirmed absence is
   * exactly what licenses spawning a successor. That is critical rule 6's
   * cardinal case: the substitution moves the verdict toward "safe".
   */
  describe('an unreadable listing is UNKNOWN, never absence', () => {
    test('NEGATIVE CONTROL: two failed polls after the stop do NOT reach `stopped`', () => {
      return runStop({rowAt: () => 'unreadable'}).then((w) => {
        expect(w.report.outcome).toBe('unverified');
        expect(isVerifiedGone(w.report.outcome)).toBe(false);
        expect(w.report.notes.join('\n')).toContain('NOT counted as absent');
        expect(w.report.notes.join('\n')).toContain('UNVERIFIED');
      });
    });

    test('POSITIVE CONTROL: the same polls, genuinely absent, DO reach `stopped`', async () => {
      // Without this the test above would also pass if stopAndVerify could
      // never confirm anything.
      let cleared = false;
      const w = await runStop({
        onStop: () => {
          cleared = true;
        },
        rowAt: () => (cleared ? null : live),
      });
      expect(w.report.outcome).toBe('stopped');
    });

    test('a failed poll RESETS the absence streak rather than counting', async () => {
      // absent, unreadable, absent, absent → only the final pair is proof.
      let poll = 0;
      const w = await runStop({
        rowAt: () => {
          poll++;
          if (poll === 1) return live; // the initial presence check
          if (poll === 3) return 'unreadable';
          return null;
        },
      });
      expect(w.report.outcome).toBe('stopped');
      expect(w.report.notes.join('\n')).toContain('NOT counted as absent');
    });

    test('an unreadable INITIAL check never shortcuts to already-gone', async () => {
      // `already-gone` licenses a spawn on the strength of one lookup, so it
      // must require a lookup that actually succeeded.
      let poll = 0;
      const w = await runStop({
        rowAt: () => {
          poll++;
          return poll === 1 ? 'unreadable' : null;
        },
      });
      expect(w.report.outcome).not.toBe('already-gone');
      expect(w.report.outcome).toBe('stopped');
      // It stopped the session rather than assuming there was nothing to stop.
      expect(w.stops).toBeGreaterThan(0);
      expect(w.report.notes.join('\n')).toContain('NOT assuming it is gone');
    });
  });

  /**
   * 33.13 — a listing that SKIPPED rows is not a full reading of `claude
   * agents`, so an id missing from it is not absent.
   *
   * `listAgents` skips rows with no usable `id` and counts them (F7);
   * `findAgent` matches by id, so a skipped row can never match the session
   * being watched. The lookup then says "absent" for a listing in which one of
   * the rows it threw away might BE that session — and two absences license
   * spawning a successor into the predecessor's worktree (D6). Same shape as
   * the unreadable case above, one layer in: the call succeeded, the READING
   * did not.
   */
  describe('a listing with malformed rows is UNKNOWN, never absence (33.13)', () => {
    test('NEGATIVE CONTROL: absent + malformed never reaches `stopped`', async () => {
      let cleared = false;
      const w = await runStop({
        malformedAt: () => 1,
        onStop: () => {
          cleared = true;
        },
        rowAt: () => (cleared ? null : live),
      });
      expect(w.report.outcome).toBe('unverified');
      expect(isVerifiedGone(w.report.outcome)).toBe(false);
      expect(w.report.notes.join('\n')).toContain('NOT counted as absent');
      // The note says WHY, naming the id that one of those rows could be.
      expect(w.report.notes.join('\n')).toContain('could BE sess-1');
      expect(w.report.notes.join('\n')).toContain('UNVERIFIED');
    });

    test('POSITIVE CONTROL: the same polls with a clean listing DO reach `stopped`', async () => {
      // Without this, the test above would also pass if the ladder could never
      // confirm anything at all.
      let cleared = false;
      const w = await runStop({
        malformedAt: () => 0,
        onStop: () => {
          cleared = true;
        },
        rowAt: () => (cleared ? null : live),
      });
      expect(w.report.outcome).toBe('stopped');
      expect(w.report.notes.join('\n')).not.toContain('could BE sess-1');
    });

    test('a malformed poll RESETS the streak rather than counting', async () => {
      // absent+malformed, absent, absent → only the final clean pair is proof.
      let poll = 0;
      const w = await runStop({
        malformedAt: () => (poll === 3 ? 2 : 0),
        rowAt: () => {
          poll++;
          return poll === 1 ? live : null;
        },
      });
      expect(w.report.outcome).toBe('stopped');
      expect(w.report.notes.join('\n')).toContain('skipped 2 rows with no id');
    });

    test('a malformed INITIAL check never shortcuts to already-gone', async () => {
      // The one-lookup answer, which is the cheapest path to a spawn.
      const w = await runStop({
        malformedAt: (poll) => (poll === 0 ? 1 : 0),
        rowAt: () => null,
      });
      expect(w.report.outcome).not.toBe('already-gone');
      expect(w.stops).toBeGreaterThan(0);
      expect(w.report.notes.join('\n')).toContain('proceeding with the stop');
    });

    test('a PRESENT row is still proof of presence, malformed or not', async () => {
      // The guard only ever weakens an ABSENCE. Rows it could not read say
      // nothing about the row it COULD read, and a present row is present.
      const w = await runStop({malformedAt: () => 3, rowAt: () => live});
      expect(w.report.outcome).toBe('kill-failed');
      expect(w.report.notes.join('\n')).toContain('STILL PRESENT');
    });
  });
});

describe('AC2: the loop refuses to spawn when it cannot see `claude agents`', () => {
  test('an unreadable listing during verification blocks the successor', async () => {
    // A perfectly good continue-handoff, and a listing that cannot be read. The
    // predecessor might be running; the successor must not start.
    const r = await runLoop({
      // Poll 1 is the session poll (sees `done`); everything after is the stop
      // verification, which must stay unreadable.
      agentsReadable: (poll) => poll <= 1,
      opts: {label: 'the-arc'},
      scans: [[], [beadFrom('hoff-1', {from: 'the-arc-1'})]],
    });
    expect(r.dispatches).toHaveLength(1);
    expect(r.exitCode).toBe(2);
    expect(r.ledger[0]?.stopOutcome).toBe('unverified');
    expect(r.stdout).toContain('REFUSING TO SPAWN');
  });

  test('a listing that SKIPPED rows also blocks the successor (33.13)', async () => {
    // The listing is readable — `claude agents --json` answered — but it threw
    // rows away, and `findAgent` matches by id, so one of the rows it threw
    // away could be the predecessor. Absence in that listing is not absence.
    const r = await runLoop({
      // Poll 1 is the session poll (sees `done`); everything after it is the
      // stop verification, and every one of those listings skipped a row.
      malformedAt: (poll) => (poll > 1 ? 1 : 0),
      opts: {label: 'the-arc'},
      scans: [[], [beadFrom('hoff-1', {from: 'the-arc-1'})]],
    });
    expect(spawns(r.dispatches)).toHaveLength(1);
    expect(r.exitCode).toBe(2);
    expect(r.ledger[0]?.stopOutcome).toBe('unverified');
    expect(r.stdout).toContain('REFUSING TO SPAWN');
    expect(r.stdout).toContain('could BE sess-1');
    // The handoff bead was perfectly good: it is the STOP that was not proven,
    // and the bead stays open for the next run.
    expect(r.ledger[0]?.outcome).toBe('continue');
  });

  test('NEGATIVE CONTROL: the same run with a clean listing DOES spawn', async () => {
    const r = await runLoop({
      malformedAt: () => 0,
      opts: {label: 'the-arc'},
      scans: [[], [beadFrom('hoff-1', {from: 'the-arc-1'})], []],
    });
    expect(spawns(r.dispatches)).toHaveLength(2);
    expect(r.ledger[0]?.stopOutcome).toBe('stopped');
    expect(r.stdout).not.toContain('REFUSING TO SPAWN');
  });

  test('losing sight of a session mid-run stops the run, naming what failed', async () => {
    const r = await runLoop({
      agentsReadable: () => false,
      opts: {label: 'the-arc', maxSessions: 2},
      scans: [[], [beadFrom('hoff-1', {from: 'the-arc-1'})]],
      sessions: [{worksForPolls: 10_000}],
    });
    expect(r.dispatches).toHaveLength(1);
    expect(r.exitCode).toBe(2);
    expect(r.ledger[0]?.outcome).toBe('agents-unreadable');
    expect(r.stdout).toContain('lost sight of session the-arc-1');
    expect(r.stdout).toContain('claude agents --json');
    // The beads were never consulted: a session we stopped watching may still
    // be writing them.
    expect(r.brCalls.filter((c) => c[0] === 'list')).toHaveLength(1);
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
    expect(r.ledger[0]?.stopOutcome).toBe('kill-failed');
  });

  test('a pidless survivor also refuses the spawn', async () => {
    const r = await runLoop({
      opts: {label: 'the-arc'},
      scans: [[], [beadFrom('hoff-1', {from: 'the-arc-1'})]],
      sessions: [{stop: 'lingers-pidless'}],
    });
    expect(r.dispatches).toHaveLength(1);
    expect(r.exitCode).toBe(2);
    expect(r.ledger[0]?.stopOutcome).toBe('no-pid');
  });

  test('hitting --max-sessions with a continue-handoff SAYS the bead is still open', async () => {
    // A bound is not a finish. "reached --max-sessions" on its own reads as the
    // arc being over, while an open bead sits there waiting for the next run.
    const r = await runLoop({
      opts: {label: 'the-arc', maxSessions: 1},
      scans: [[], [beadFrom('hoff-1', {from: 'the-arc-1'})]],
    });
    expect(r.dispatches).toHaveLength(1);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('reached --max-sessions');
    expect(r.stdout).toContain('hoff-1 is still OPEN');
    expect(r.stdout).toContain('arc is NOT finished');
  });

  test('a chain that ends on `done` does NOT claim an open bead', async () => {
    const r = await runLoop({
      opts: {label: 'the-arc', maxSessions: 1},
      scans: [[], [beadFrom('h', {disposition: 'done', from: 'the-arc-1'})]],
    });
    expect(r.stdout).not.toContain('still OPEN');
  });

  test('NEGATIVE CONTROL: the same script spawns once the stop works', async () => {
    const r = await runLoop({
      opts: {label: 'the-arc'},
      scans: [[], [beadFrom('hoff-1', {from: 'the-arc-1'})]],
      sessions: [{stop: 'clears'}],
    });
    expect(spawns(r.dispatches)).toHaveLength(2);
    expect(r.ledger[0]?.stopOutcome).toBe('stopped');
  });

  test('the stop outcome is printed AND ledgered on every path', async () => {
    const r = await runLoop({
      opts: {label: 'the-arc'},
      scans: [
        [],
        [beadFrom('hoff-9', {disposition: 'done', from: 'the-arc-1'})],
      ],
    });
    expect(r.stdout).toContain('verified gone');
    expect(r.stdout).toContain('stop=stopped');
    expect(r.ledger[0]?.stopOutcome).toBe('stopped');
  });

  test('a session that vanished on its own is already-gone, not a failure', async () => {
    const r = await runLoop({
      opts: {label: 'the-arc'},
      scans: [[], [beadFrom('hoff-1', {from: 'the-arc-1'})]],
      sessions: [{vanishes: true}],
    });
    expect(r.ledger[0]?.stopOutcome).toBe('already-gone');
    expect(spawns(r.dispatches)).toHaveLength(2);
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
      scans: [
        [],
        [beadFrom('hoff-9', {disposition: 'done', from: 'the-arc-1'})],
      ],
      sessions: [{worksForPolls: 300}],
    });
    expect(r.exitCode).toBe(0);
    expect(r.ledger[0]?.outcome).toBe('done');
  });

  test('a configured timeout stops the session and CONFIRMS it is gone first', async () => {
    const r = await runLoop({
      opts: {handoffRetries: 0, label: 'the-arc', pollSec: 60, timeoutMin: 5},
      // Nothing was handed off, so the timeout ending is also a no-handoff one.
      scans: [[], []],
      sessions: [{worksForPolls: 10_000}],
    });
    expect(spawns(r.dispatches)).toHaveLength(1);
    expect(r.stopCalls).toEqual(['sess-1']);
    expect(r.stdout).toContain('verified gone');
    expect(r.exitCode).toBe(2);
    expect(r.ledger[0]?.outcome).toBe('no-handoff');
    expect(r.stdout).toContain('--timeout-min');
  });

  /**
   * AC4 (home-base-1r6d.33.3): the .2 runner DISCARDED the beads on a timeout
   * (its deviation V-f), so a session that handed off and then hung had its
   * committed handoff thrown away and the arc re-run. D7 says the timeout is
   * about the clock, not about the bead: stop, confirm gone, THEN read.
   */
  test('a timeout reads the beads after the stop and HONOURS a valid handoff', async () => {
    const r = await runLoop({
      opts: {label: 'the-arc', pollSec: 60, timeoutMin: 5},
      // The session wrote a valid continue-handoff and THEN hung.
      scans: [
        [],
        [beadFrom('hoff-1', {from: 'the-arc-1'})],
        [beadFrom('hoff-2', {disposition: 'done', from: 'the-arc-2'})],
      ],
      sessions: [{worksForPolls: 10_000}],
    });
    // The stop happens BEFORE the read, and the successor only after both.
    expect(r.stopCalls[0]).toBe('sess-1');
    expect(r.stdout).toContain('verified gone');
    expect(r.stdout).toContain('reading its handoff beads anyway');
    expect(r.ledger[0]?.outcome).toBe('continue');
    expect(r.ledger[0]?.handoffBead).toBe('hoff-1');
    expect(spawns(r.dispatches)).toHaveLength(2);
    expect(r.exitCode).toBe(0);
    // The load-bearing pair. Under V-f the timeout took the no-handoff path, so
    // the bead was only ever found by DEMANDING it back out of a session that
    // had already written it — the same successor, one wasted turn later. These
    // two say the bead was honoured directly.
    expect(resumes(r.dispatches)).toHaveLength(0);
    expect(r.ledger[0]?.demands).toBe(0);
  });

  test('NEGATIVE CONTROL: the discarded-beads behaviour would ledger no-handoff', async () => {
    // The same world with NO handoff bead present is the only shape that may
    // ledger `no-handoff` after a timeout. If the runner regressed to V-f, the
    // test above would produce this row for a repo that HAS a valid handoff.
    const r = await runLoop({
      opts: {handoffRetries: 0, label: 'the-arc', pollSec: 60, timeoutMin: 5},
      scans: [[], []],
      sessions: [{worksForPolls: 10_000}],
    });
    expect(r.ledger[0]?.outcome).toBe('no-handoff');
    expect(r.ledger[0]?.handoffBead).toBeNull();
    expect(spawns(r.dispatches)).toHaveLength(1);
  });

  test('NEGATIVE CONTROL: the same session under no timeout runs to its handoff', async () => {
    const r = await runLoop({
      opts: {label: 'the-arc', pollSec: 60, timeoutMin: 0},
      scans: [[], [beadFrom('hoff-1', {from: 'the-arc-1'})]],
      // Ends on its own, well past where the 5m timeout above fired.
      sessions: [{worksForPolls: 20}],
    });
    expect(spawns(r.dispatches)).toHaveLength(2);
    expect(r.ledger[0]?.outcome).toBe('continue');
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
    const label = sessionLabel(
      runSlug({label: 'Fix the Parser!', prompt: 'x'}),
      3,
    );
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
    expect(runSlug({label: '###', prompt: 'fix the parser'})).toBe(
      'fix-parser',
    );
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
    const stamp = at(names, 0).slice(0, 16);
    expect(at(names, 1).startsWith(stamp)).toBe(true);
    expect(names[0]).toBe(`${stamp} the-arc-1`);
    expect(names[1]).toBe(`${stamp} the-arc-2`);
  });

  test('the dispatched --name matches the ledger row', async () => {
    const r = await runLoop({
      opts: {label: 'the-arc'},
      scans: [[], [beadFrom('h', {disposition: 'done', from: 'the-arc-1'})]],
    });
    expect(r.ledger[0]?.name).toBe(argOf(at(r.dispatches, 0), '--name'));
    expect(r.ledger[0]?.name).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} the-arc-1$/,
    );
  });

  /**
   * 33.11 — the numbering survives a `--pickup` restart.
   *
   * `justin-loop --pickup --label pilot2` is the command the blocked stop prints
   * (D16) and the one a chain that ran out of `--max-sessions` is resumed with.
   * It used to name its next session `pilot2-1`, whatever the arc had already
   * done. The unit cases are in tests/justin-loop-boot.test.ts; these drive the
   * whole loop, because the number has to reach three separate places — the
   * `--name`, the ledger row and the banner — and a change that moved only one
   * of them would leave the others quietly disagreeing.
   */
  describe('a resumed chain keeps counting (33.11)', () => {
    test('a pickup of pilot2-2’s bead names the successor pilot2-3', async () => {
      const r = await runLoop({
        opts: {label: 'pilot2', maxSessions: 1, pickup: true},
        scans: [
          // Waiting when the run starts: what pilot2-2 left behind.
          [beadFrom('hoff-2', {from: 'pilot2-2'})],
          // What the session this run boots writes when it ends.
          [beadFrom('hoff-3', {disposition: 'done', from: 'pilot2-3'})],
        ],
      });
      expect(argOf(at(r.dispatches, 0), '--name')).toMatch(/ pilot2-3$/);
      expect(r.ledger[0]?.label).toBe('pilot2-3');
      expect(r.ledger[0]?.n).toBe(3);
      expect(r.stdout).toContain('labels=pilot2-3…pilot2-3');
      expect(r.stdout).toContain('numbering continues from pilot2-2');
      // The RUN's own position is still 1 of 1 — the arc's number and this
      // run's position are different facts and both are printed.
      expect(r.stdout).toContain('#1/1');
    });

    test('NEGATIVE CONTROL: a run with nothing waiting still starts at 1', async () => {
      const r = await runLoop({
        opts: {label: 'pilot2', maxSessions: 1, pickup: true},
        scans: [[], [beadFrom('h', {disposition: 'done', from: 'pilot2-1'})]],
      });
      expect(r.ledger[0]?.label).toBe('pilot2-1');
      expect(r.stdout).toContain('labels=pilot2-1…pilot2-1');
      expect(r.stdout).not.toContain('numbering continues from');
    });

    test('another arc’s handoff does NOT move this run’s numbering', async () => {
      // A cross-arc pickup is legal — one arc per run, newest wins — but the
      // number belongs to `other-arc`, and spending it here would claim
      // sessions `pilot2` never ran.
      const r = await runLoop({
        opts: {label: 'pilot2', maxSessions: 1, pickup: true},
        scans: [
          [beadFrom('hoff-x', {from: 'other-arc-7'})],
          [beadFrom('h', {disposition: 'done', from: 'pilot2-1'})],
        ],
      });
      expect(r.ledger[0]?.label).toBe('pilot2-1');
      expect(r.stdout).not.toContain('numbering continues from');
    });

    test('the chain then continues from there: pilot2-3, pilot2-4', async () => {
      const r = await runLoop({
        opts: {label: 'pilot2', maxSessions: 2, pickup: true},
        scans: [
          [beadFrom('hoff-2', {from: 'pilot2-2'})],
          [beadFrom('hoff-3', {from: 'pilot2-3'})],
          [beadFrom('hoff-4', {disposition: 'done', from: 'pilot2-4'})],
        ],
      });
      expect(r.ledger.map((row) => row.label)).toEqual([
        'pilot2-3',
        'pilot2-4',
      ]);
      expect(r.ledger.map((row) => row.n)).toEqual([3, 4]);
      expect(r.stdout).toContain('labels=pilot2-3…pilot2-4');
    });
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
              stderr: null,
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
          : {ok: true, reason: null, stderr: null, stdout: ''},
      dispatch: (_cwd, args) => {
        dispatched++;
        rows.set('sess-1', {
          id: 'sess-1',
          name: args[args.indexOf('--name') + 1] ?? '',
          pid: 1,
          sessionId: 'sess-1-full-uuid',
          state: 'done',
          status: 'idle',
          waitingFor: null,
        });
        return Promise.resolve('backgrounded · sess-1 · n\n');
      },
      findAgent: (_cwd, id) =>
        Promise.resolve({malformed: 0, ok: true, row: rows.get(id) ?? null}),
      gitHead: () => Promise.resolve({ok: true, sha: 'abc'}),
      notifyBlocked: () => {
        /* nothing is notified in the fake world */
      },
      now: () => Date.UTC(2026, 8, 8, 11, 30),
      preflight: () => Promise.resolve([]),
      readLedgerSessionId: ledgerReaderNeverCalled,
      readUsage: () =>
        Promise.resolve({kind: 'failed', reason: 'no /usage in this fixture'}),
      signalPid: () => true,
      sleep: () => Promise.resolve(),
      stopSession: (_cwd, id) => {
        rows.delete(id);
        return Promise.resolve({detail: 'stopped', ok: true});
      },
      write: () => {
        /* stdout is not asserted in this test */
      },
      writeErr: () => {
        /* stderr is not asserted in this test */
      },
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
    const row = JSON.parse(at(lines, 0)) as LedgerRow;
    // 2 since home-base-1r6d.33.3 added `demands`, 3 since 33.12 added
    // `fullSessionId`.
    expect(row.schemaVersion).toBe(3);
    expect(row.demands).toBe(0);
    expect(row.n).toBe(1);
    expect(row.label).toBe('the-arc-1');
    expect(row.outcome).toBe('done');
    expect(row.handoffBead).toBe('hoff-z');
    expect(row.stopOutcome).toBe('stopped');
    // BOTH ids, and they are not the same string (33.12): `sessionId` is the
    // 8-character `claude agents` id and `fullSessionId` is the one a thread
    // bead is keyed on. A later `--pickup` run reads the second one; reading
    // the first would send `thread prepare` looking up a session that does not
    // exist and reporting the miss as a fact about the predecessor.
    expect(row.sessionId).toBe('sess-1');
    expect(row.fullSessionId).toBe('sess-1-full-uuid');
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
              stderr: null,
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
          : {ok: true, reason: null, stderr: null, stdout: ''},
      dispatch: () => {
        dispatched++;
        rows.set('sess-1', {
          id: 'sess-1',
          name: 'n',
          pid: 1,
          sessionId: 'sess-1-full-uuid',
          state: 'done',
          status: 'idle',
          waitingFor: null,
        });
        return Promise.resolve('backgrounded · sess-1 · n\n');
      },
      findAgent: (_cwd, id) =>
        Promise.resolve({malformed: 0, ok: true, row: rows.get(id) ?? null}),
      gitHead: () => Promise.resolve({ok: true, sha: 'abc'}),
      notifyBlocked: () => {
        /* nothing is notified in the fake world */
      },
      now: () => Date.UTC(2026, 8, 8, 11, 30),
      preflight: () => Promise.resolve([]),
      readLedgerSessionId: ledgerReaderNeverCalled,
      readUsage: () =>
        Promise.resolve({kind: 'failed', reason: 'no /usage in this fixture'}),
      signalPid: () => true,
      sleep: () => Promise.resolve(),
      stopSession: (_cwd, id) => {
        rows.delete(id);
        return Promise.resolve({detail: 'stopped', ok: true});
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

  test('a HEAD read that FAILED is reported as unreadable, never as "no commit"', async () => {
    // home-base-a1go. `gitHead` used to return null on failure, and the only
    // caller compared two reads: two failures compare EQUAL, so an unreadable
    // repo was reported as a session that committed nothing — a measurement
    // nobody took, feeding both the dashboard and the no-progress circuit
    // breaker (critical rule 6).
    const rows = new Map<string, AgentRow>();
    const ledger: LedgerRow[] = [];
    let stdout = '';
    let stderr = '';
    let dispatched = 0;
    const deps: RunnerDeps = {
      appendLedgerRow: (_path, row) => {
        ledger.push(row);
        return {ok: true, reason: null};
      },
      br: (_cwd, args) =>
        args[0] === 'list'
          ? {
              ok: true,
              reason: null,
              stderr: null,
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
          : {ok: true, reason: null, stderr: null, stdout: ''},
      dispatch: () => {
        dispatched++;
        rows.set('sess-1', {
          id: 'sess-1',
          name: 'n',
          pid: 1,
          sessionId: 'sess-1-full-uuid',
          state: 'done',
          status: 'idle',
          waitingFor: null,
        });
        return Promise.resolve('backgrounded · sess-1 · n\n');
      },
      findAgent: (_cwd, id) =>
        Promise.resolve({malformed: 0, ok: true, row: rows.get(id) ?? null}),
      gitHead: () =>
        Promise.resolve({
          ok: false,
          reason:
            'git rev-parse HEAD did not finish within 10000ms and was SIGKILLed',
        }),
      notifyBlocked: () => {
        /* nothing is notified in the fake world */
      },
      now: () => Date.UTC(2026, 8, 8, 11, 30),
      preflight: () => Promise.resolve([]),
      readLedgerSessionId: ledgerReaderNeverCalled,
      readUsage: () =>
        Promise.resolve({kind: 'failed', reason: 'no /usage in this fixture'}),
      signalPid: () => true,
      sleep: () => Promise.resolve(),
      stopSession: (_cwd, id) => {
        rows.delete(id);
        return Promise.resolve({detail: 'stopped', ok: true});
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
    expect(exitCode).toBe(0);
    // The session line says UNKNOWN, and specifically claims neither verdict.
    // (Matched with the surrounding separators, since the handoff bead's own
    // text contains the word "committed".)
    expect(stdout).toContain('· HEAD unreadable ·');
    expect(stdout).not.toContain('· no commit');
    expect(stdout).not.toContain('· committed');
    // The reason reaches stderr rather than being swallowed…
    expect(stderr).toContain('could not read HEAD');
    expect(stderr).toContain('SIGKILLed');
    // …and the ledger records "not measured", not `false`.
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.progressed).toBeNull();
  });

  test('the circuit breaker SAYS when the streak was unreadable, not just "no commit"', async () => {
    // An unreadable HEAD counts toward the no-progress streak on purpose —
    // unknown must never reset a breaker. But the abort reason is what Justin
    // reads, and "2 sessions with no commit" is a claim about two measurements
    // that were never taken. The reason names the doubt instead.
    const r = await runLoop({
      gitHeadFails: true,
      opts: {label: 'the-arc', maxSessions: 3, noProgressAbort: 2},
      scans: [
        [],
        [beadFrom('hoff-1', {from: 'the-arc-1'})],
        [beadFrom('hoff-2', {from: 'the-arc-2'})],
      ],
    });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain(
      '2 sessions with no commit or an unreadable HEAD — circuit breaker',
    );
  });

  test('a streak with no unreadable read keeps the plain wording', async () => {
    // The other half: when every HEAD WAS read and simply did not move, the
    // reason must not hedge. `gitHead` here returns one fixed sha, so the
    // comparison is a real measurement that says "nothing was committed".
    const r = await runLoop({
      gitHeadStuck: true,
      opts: {label: 'the-arc', maxSessions: 3, noProgressAbort: 2},
      scans: [
        [],
        [beadFrom('hoff-1', {from: 'the-arc-1'})],
        [beadFrom('hoff-2', {from: 'the-arc-2'})],
      ],
    });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain('2 sessions with no commit — circuit breaker');
  });
});
