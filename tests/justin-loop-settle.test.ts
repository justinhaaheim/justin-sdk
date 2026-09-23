/**
 * `--handoff-settle-min`: the handoff bead as a SECOND ending signal
 * (home-base-0cfl, epic home-base-1r6d.33 D15).
 *
 * THE MEASURED DEFECT. 2026-09-12, claude 2.1.269, e2e scenario A, 1 of 7 runs:
 * a `--bg` session claimed its bead, wrote its `done` handoff 40s in and ended
 * its turn (`end_turn` in the transcript, stop hook run) — and its `claude
 * agents` row stayed `state: working, status: idle` for the eleven more minutes
 * until the harness's own bound killed the run. D8's ENDED (`done` or absent) is
 * therefore not guaranteed to arrive, and with the default `--timeout-min 0` the
 * runner waits on a session that finished its work. That is the leading
 * explanation of the 717s of silence seen on 2026-09-10.
 *
 * THE CONTRACT THESE TESTS PIN:
 *   - The knob is OFF by default, and off means NO scan is ever made. `br` is
 *     not consulted while a session is watched unless it is armed.
 *   - `isSessionEnded` is untouched. `done`/absent still ends a session the
 *     instant it is seen, and a session that ends normally never settles.
 *   - The scan rides the liveness tick, not the poll, and only while the row is
 *     `working` — a `done` row is already an ending and a `blocked` one is
 *     waiting for Justin, which is not a stall.
 *   - A scan that could not be MADE is not "no bead" (critical rule 6): the run
 *     keeps waiting and the liveness line names the reason.
 *   - Identity is the `from` field. Another session's bead settles nothing.
 *   - The ending takes the D7 timeout path exactly: stop and confirm gone FIRST,
 *     then read the beads, and no successor without a verified stop (D6).
 *   - The ledger names it `handoff-settled`, so a pilot can count how often the
 *     defect fired.
 */

import {describe, expect, test} from 'bun:test';

import {
  type AgentRow,
  type HandoffScan,
  scanForOwnHandoff,
} from '../src/justin-loop/runner';
import {
  beadFrom,
  listJson,
  runLoop,
  simulateSession,
  spawns,
} from './justin-loop-world';

// ---------------------------------------------------------------------------
// Rows, in the shapes D8 measured
// ---------------------------------------------------------------------------

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

/** THE DEFECT ITSELF: the turn is over, the row says otherwise, forever. */
const STUCK = agentRow({state: 'working', status: 'idle'});
const DONE = agentRow({state: 'done', status: 'idle'});
const BLOCKED = agentRow({
  state: 'blocked',
  status: null,
  waitingFor: 'Which approach do you want?',
});

/** A scan that found exactly the bead `the-arc-1` should have written. */
function ownBead(): HandoffScan {
  return {
    kind: 'ok',
    rows: JSON.parse(listJson([beadFrom('hoff-1')])).issues,
  };
}

const LIST = ['list', '-l', 'handoff', '--json'];

function listCalls(brCalls: string[][]): string[][] {
  return brCalls.filter((c) => c[0] === 'list');
}

// ---------------------------------------------------------------------------
// scanForOwnHandoff: the same acceptance test the ending path uses
// ---------------------------------------------------------------------------

describe('scanForOwnHandoff accepts exactly what decideAfterSession accepts', () => {
  test('a valid open handoff with from == label is SEEN, and names the bead', () => {
    expect(scanForOwnHandoff(ownBead(), 'the-arc-1')).toEqual({
      beadIds: ['hoff-1'],
      kind: 'seen',
    });
  });

  test("another session's bead is not this session's evidence", () => {
    // The whole chain shares one `handoff` label, so `from` is the only thing
    // separating this session's bead from its predecessor's.
    expect(scanForOwnHandoff(ownBead(), 'the-arc-2')).toEqual({kind: 'none'});
  });

  test('an UNREADABLE bead does not count as a handoff', () => {
    const scan: HandoffScan = {
      kind: 'ok',
      rows: JSON.parse(listJson([{id: 'hoff-x', notes: 'not json at all'}]))
        .issues,
    };
    expect(scanForOwnHandoff(scan, 'the-arc-1')).toEqual({kind: 'none'});
  });

  test('no beads at all is `none`, and a failed scan is `unavailable`', () => {
    // The distinction this type exists for: one of these is a measurement.
    expect(scanForOwnHandoff({kind: 'ok', rows: []}, 'the-arc-1')).toEqual({
      kind: 'none',
    });
    expect(
      scanForOwnHandoff(
        {kind: 'unavailable', reason: 'br exited 1'},
        'the-arc-1',
      ),
    ).toEqual({kind: 'unavailable', reason: 'br exited 1'});
  });

  test('two valid open beads from this label still count as handed off', () => {
    // The run will stop on `multiple-handoffs` either way — but it has to get
    // there, and waiting forever on the stuck row instead is the bug.
    const scan: HandoffScan = {
      kind: 'ok',
      rows: JSON.parse(listJson([beadFrom('hoff-1'), beadFrom('hoff-2')]))
        .issues,
    };
    // BOTH ids, not just the first (F5): the settle re-check asks whether the
    // bead it sighted is still open, and a one-id answer cannot tell "the same
    // bead is still there" from "a different one is".
    expect(scanForOwnHandoff(scan, 'the-arc-1')).toEqual({
      beadIds: ['hoff-1', 'hoff-2'],
      kind: 'seen',
    });
  });
});

// ---------------------------------------------------------------------------
// The knob is off by default (AC2)
// ---------------------------------------------------------------------------

describe('handoffSettleMin 0 — the default — makes no scan at all', () => {
  test('a session watched for 100 minutes consults `br` zero times', async () => {
    const sim = await simulateSession({
      // Armed and loaded: the bead IS there. Nothing may look at it.
      beadsAt: () => [beadFrom('hoff-1')],
      maxPolls: 120,
      // The default is not restated in `opts` on purpose: this asserts what a
      // run that says nothing about the knob does.
      rowAt: (poll) => (poll <= 100 ? STUCK : DONE),
    });

    expect(sim.run.ending.kind).toBe('ended');
    expect(sim.brCalls).toEqual([]);
    expect(sim.elapsedMin).toBeGreaterThan(100);
  });

  test('the whole run makes exactly the two bead reads it always made', async () => {
    // Start-of-run scan, and the one read after the session ends. A third would
    // mean the watch started scanning with the knob off.
    const res = await runLoop({
      opts: {label: 'the-arc', maxSessions: 1, pollSec: 60},
      scans: [[], [beadFrom('hoff-1')]],
      sessions: [{worksForPolls: 5}],
    });

    expect(listCalls(res.brCalls)).toEqual([LIST, LIST]);
    expect(res.ledger.map((r) => r.outcome)).toEqual(['continue']);
    expect(res.stdout).not.toContain('handoff-settled');
    expect(res.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Armed, on a session that ends normally (AC3)
// ---------------------------------------------------------------------------

describe('armed, a session that reaches done never settles', () => {
  test('a row that goes done ends the watch, and nothing is scanned after it', async () => {
    const sim = await simulateSession({
      beadsAt: () => [beadFrom('hoff-1')],
      opts: {handoffSettleMin: 3},
      // Stuck-looking for two ticks, then the row transitions like D8 says.
      rowAt: (poll) => (poll <= 2 ? STUCK : DONE),
    });

    expect(sim.run.ending.kind).toBe('ended');
    // Two working ticks = two scans; the `done` poll makes none, because the
    // ending is already decided by D8 at that point.
    expect(listCalls(sim.brCalls).length).toBe(2);
    expect(sim.polls).toBe(3);
  });

  test('a session that ends on its first poll is never scanned', async () => {
    const sim = await simulateSession({
      beadsAt: () => [beadFrom('hoff-1')],
      opts: {handoffSettleMin: 1},
      rowAt: () => DONE,
    });

    expect(sim.run.ending.kind).toBe('ended');
    expect(sim.brCalls).toEqual([]);
  });

  test('a BLOCKED session is not scanned and never settles', async () => {
    // Blocked means waiting for Justin (D3). It is not a stall, and settling it
    // would stop the session he is on his way to answer.
    const sim = await simulateSession({
      beadsAt: () => [beadFrom('hoff-1')],
      maxPolls: 60,
      opts: {blockedWaitMin: null, handoffSettleMin: 1},
      rowAt: (poll) => (poll <= 50 ? BLOCKED : DONE),
    });

    expect(sim.run.ending.kind).toBe('ended');
    expect(sim.brCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Armed, on the measured defect (AC4)
// ---------------------------------------------------------------------------

describe('armed, a stuck row with this session’s handoff bead settles', () => {
  test('the ending is handoff-settled, N minutes after the bead is first seen', async () => {
    const sim = await simulateSession({
      beadsAt: () => [beadFrom('hoff-1')],
      maxPolls: 20,
      opts: {handoffSettleMin: 3},
      // The defect: never anything but `working`.
      rowAt: () => STUCK,
    });

    expect(sim.run.ending).toEqual({
      afterMin: 3,
      beadId: 'hoff-1',
      kind: 'handoff-settled',
    });
    // First seen on tick 1, settled on tick 4: N minutes AFTER the sighting,
    // never on the sighting itself.
    expect(sim.elapsedMin).toBe(4);
    expect(listCalls(sim.brCalls).length).toBe(4);
  });

  test('the scan rides the liveness tick, not the poll', async () => {
    // 9 polls of 20s = 3 minutes = 3 ticks. A scan per poll would be 9 `br`
    // calls a minute in a real run.
    const sim = await simulateSession({
      beadsAt: () => [beadFrom('hoff-1')],
      maxPolls: 12,
      opts: {handoffSettleMin: 60, pollSec: 20},
      rowAt: (poll) => (poll <= 9 ? STUCK : DONE),
    });

    expect(sim.run.ending.kind).toBe('ended');
    expect(listCalls(sim.brCalls).length).toBe(3);
    expect(sim.polls).toBe(10);
  });

  test('the liveness line says the bead was seen and when it will settle', async () => {
    const sim = await simulateSession({
      beadsAt: () => [beadFrom('hoff-1')],
      maxPolls: 20,
      opts: {handoffSettleMin: 3},
      rowAt: () => STUCK,
    });

    expect(sim.stdout).toContain('hoff-1 seen 0m ago (settles at 3m)');
    expect(sim.stdout).toContain('hoff-1 seen 2m ago (settles at 3m)');
    // Still the a1go line, with the scan appended rather than replacing it.
    expect(sim.stdout).toContain('working/idle · agents ok · handoff hoff-1');
  });
});

// ---------------------------------------------------------------------------
// Armed, and the scan cannot be made, or the bead is somebody else's (AC5)
// ---------------------------------------------------------------------------

describe('armed, an unavailable scan is not a missing bead', () => {
  test('a `br` that never answers settles nothing, and says why every minute', async () => {
    const sim = await simulateSession({
      beadsAt: () => 'unavailable',
      maxPolls: 20,
      opts: {handoffSettleMin: 1},
      rowAt: (poll) => (poll <= 10 ? STUCK : DONE),
    });

    // The session ran to its own ending. `unavailable` bought no settle at all,
    // not even after ten minutes of it.
    expect(sim.run.ending.kind).toBe('ended');
    expect(sim.elapsedMin).toBe(11);
    expect(sim.stdout).toContain(
      'handoff scan unavailable: br exited 1: no beads workspace',
    );
    expect(sim.stdout).not.toContain('settles at');
  });

  test('a bead that appears after the scan recovers still settles', async () => {
    // The point of the previous test is that unavailable is UNKNOWN, not "no" —
    // so a scan that starts working must still be able to settle.
    const sim = await simulateSession({
      beadsAt: (call) => (call <= 2 ? 'unavailable' : [beadFrom('hoff-1')]),
      maxPolls: 20,
      opts: {handoffSettleMin: 1},
      rowAt: () => STUCK,
    });

    expect(sim.run.ending.kind).toBe('handoff-settled');
    // Two unreadable minutes, the sighting on minute 3, the settle on minute 4.
    expect(sim.elapsedMin).toBe(4);
  });

  test('a handoff bead from ANOTHER session settles nothing', async () => {
    const sim = await simulateSession({
      beadsAt: () => [beadFrom('hoff-1')],
      label: 'the-arc-2',
      maxPolls: 20,
      opts: {handoffSettleMin: 1},
      // The bead on offer says from=the-arc-1 (the fixture default).
      rowAt: (poll) => (poll <= 10 ? STUCK : DONE),
    });

    expect(sim.run.ending.kind).toBe('ended');
    expect(sim.stdout).not.toContain('settles at');
  });

  test('an unreadable bead settles nothing either', async () => {
    const sim = await simulateSession({
      beadsAt: () => [{id: 'hoff-x', notes: '{"schemaVersion":1}'}],
      maxPolls: 20,
      opts: {handoffSettleMin: 1},
      rowAt: (poll) => (poll <= 10 ? STUCK : DONE),
    });

    expect(sim.run.ending.kind).toBe('ended');
    expect(sim.stdout).not.toContain('settles at');
  });
});

// ---------------------------------------------------------------------------
// The sighting is re-checked at the moment it would settle (home-base-685h F5)
//
// The sighting stays sticky BETWEEN ticks — a flapping scan must not be able to
// postpone the settle forever, which is the stall D15 exists to end. What F5
// adds is one re-check at the instant it matters. Before it, a bead closed
// between the sighting and the deadline still settled: the ending named a bead
// that was no longer open, the post-stop read then found no valid handoff, and
// the run fell through to the DEMAND path — waking, with a resume, a session the
// stop ladder had just confirmed gone.
// ---------------------------------------------------------------------------

describe('a sighting whose bead is closed before the deadline is DROPPED (F5)', () => {
  test('the session keeps being watched, and ends on its own row', async () => {
    const sim = await simulateSession({
      // Tick 1 sights hoff-1; it is closed by tick 2, which is the deadline.
      beadsAt: (call) => (call === 1 ? [beadFrom('hoff-1')] : []),
      maxPolls: 20,
      opts: {handoffSettleMin: 1},
      rowAt: (poll) => (poll <= 5 ? STUCK : DONE),
    });

    expect(sim.run.ending.kind).toBe('ended');
    expect(sim.stdout).toContain(
      'handoff hoff-1 is no longer an open valid handoff — sighting DROPPED, still watching',
    );
    // Watched all the way to the row's own `done`, not stopped at the deadline.
    expect(sim.elapsedMin).toBe(6);
  });

  test('a REPLACEMENT bead written afterwards starts its own clock', async () => {
    // Dropping is not giving up. The session may close one handoff and write
    // another (the answer helper does exactly that); the new bead is a new
    // sighting with its own N minutes, not an inheritance of the old one's.
    const sim = await simulateSession({
      beadsAt: (call) =>
        call === 1
          ? [beadFrom('hoff-1')]
          : call === 2
            ? []
            : [beadFrom('hoff-2')],
      maxPolls: 20,
      opts: {handoffSettleMin: 1},
      rowAt: () => STUCK,
    });

    expect(sim.run.ending).toEqual({
      afterMin: 1,
      beadId: 'hoff-2',
      kind: 'handoff-settled',
    });
    // Sighted on 1, dropped on 2, re-sighted on 3, settled on 4 — never on 2,
    // which is what inheriting the first sighting's clock would have done.
    expect(sim.elapsedMin).toBe(4);
  });

  test('a scan that is UNAVAILABLE at the deadline keeps the sighting and settles', async () => {
    // "I could not look" is not "it is closed" (critical rule 6). The bead was
    // seen; nothing since has said otherwise.
    const sim = await simulateSession({
      beadsAt: (call) => (call === 1 ? [beadFrom('hoff-1')] : 'unavailable'),
      maxPolls: 20,
      opts: {handoffSettleMin: 1},
      rowAt: () => STUCK,
    });

    expect(sim.run.ending).toEqual({
      afterMin: 1,
      beadId: 'hoff-1',
      kind: 'handoff-settled',
    });
    expect(sim.stdout).not.toContain('DROPPED');
  });

  test('a bead still open at the deadline settles exactly as before', async () => {
    // The control for the three above: F5 must not have made the ordinary
    // settle conditional on anything new.
    const sim = await simulateSession({
      beadsAt: () => [beadFrom('hoff-1')],
      maxPolls: 20,
      opts: {handoffSettleMin: 1},
      rowAt: () => STUCK,
    });

    expect(sim.run.ending).toEqual({
      afterMin: 1,
      beadId: 'hoff-1',
      kind: 'handoff-settled',
    });
    expect(sim.stdout).not.toContain('DROPPED');
  });

  test('a SECOND bead appearing beside the sighted one still settles on the sighted one', async () => {
    // A forked chain (two open handoffs from one label) is a stop, not a
    // reason to keep waiting — F6, declined deliberately. The re-check must
    // not turn it into one: the sighted bead is still open, so it settles.
    const sim = await simulateSession({
      beadsAt: (call) =>
        call === 1
          ? [beadFrom('hoff-1')]
          : [beadFrom('hoff-1'), beadFrom('hoff-2')],
      maxPolls: 20,
      opts: {handoffSettleMin: 1},
      rowAt: () => STUCK,
    });

    expect(sim.run.ending).toEqual({
      afterMin: 1,
      beadId: 'hoff-1',
      kind: 'handoff-settled',
    });
    expect(sim.stdout).not.toContain('DROPPED');
  });
});

// ---------------------------------------------------------------------------
// The whole loop: the stop, the bead read, the successor, the ledger (AC4)
// ---------------------------------------------------------------------------

describe('a settled session takes the D7 timeout path exactly', () => {
  test('stopped and confirmed gone BEFORE the deciding bead read, then a successor', async () => {
    const res = await runLoop({
      opts: {
        handoffSettleMin: 1,
        label: 'the-arc',
        maxSessions: 2,
        pollSec: 60,
      },
      // 0: start-of-run · 1: tick 1 (sighting) · 2: tick 2 (settle) ·
      // 3: session 1's deciding read · 4: session 2's.
      scans: [
        [],
        [beadFrom('hoff-1')],
        [beadFrom('hoff-1')],
        [beadFrom('hoff-1')],
        [beadFrom('hoff-2', {disposition: 'done', from: 'the-arc-2'})],
      ],
      // Session 1 is the defect: `working` for longer than the run lasts.
      // Session 2 behaves, so the chain can finish.
      sessions: [{worksForPolls: 500}, {}],
    });

    // THE ORDER IS THE INVARIANT (D6): nothing reads the beads for a decision,
    // and nothing is dispatched, between the settle and a confirmed stop.
    expect(res.events).toEqual([
      'br:list', // start-of-run scan
      'dispatch:spawn', // session 1
      'br:list', // tick 1 — the bead is there
      'br:list', // tick 2 — one minute later, still `working` → settled
      'stop:sess-1', // stop FIRST
      'br:list', // …then read what it handed us
      'dispatch:spawn', // session 2, off a verified-gone predecessor
      'stop:sess-2',
      'br:list',
      'br:close', // the `done` bead (D14)
    ]);

    expect(res.ledger.map((r) => r.outcome)).toEqual([
      'handoff-settled',
      'done',
    ]);
    // The disposition is not lost — the row still names the bead it read.
    expect(res.ledger[0]?.handoffBead).toBe('hoff-1');
    expect(res.ledger[0]?.stopOutcome).toBe('stopped');
    expect(spawns(res.dispatches).length).toBe(2);
    expect(res.stdout).toContain('was still `working` 1m later');
    expect(res.exitCode).toBe(0);
  });

  test('a predecessor that will not die is not spawned past', async () => {
    // The negative control for the successor gate: same settle, same bead, but
    // the stop cannot be confirmed. Nothing may be dispatched (D6).
    const res = await runLoop({
      opts: {
        handoffSettleMin: 1,
        label: 'the-arc',
        maxSessions: 2,
        pollSec: 60,
      },
      scans: [
        [],
        [beadFrom('hoff-1')],
        [beadFrom('hoff-1')],
        [beadFrom('hoff-1')],
      ],
      sessions: [{stop: 'lingers-pidless', worksForPolls: 500}],
    });

    expect(spawns(res.dispatches).length).toBe(1);
    expect(res.stdout).toContain('REFUSING TO SPAWN');
    expect(res.ledger.map((r) => r.outcome)).toEqual(['handoff-settled']);
    expect(res.exitCode).toBe(2);
  });

  test('the banner says the knob is armed, and says nothing when it is not', async () => {
    const armed = await runLoop({
      opts: {dryRun: true, handoffSettleMin: 3},
    });
    expect(armed.stdout).toContain(
      'a session whose handoff bead is written but whose row never reaches done is settled after 3m',
    );

    const off = await runLoop({opts: {dryRun: true}});
    expect(off.stdout).not.toContain('--handoff-settle-min');
  });
});
