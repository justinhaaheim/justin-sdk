/**
 * Runner-side yield enforcement (home-base-1r6d.33.3, D10): a session that ends
 * without a valid handoff bead is RESUMED and told to write one, bounded.
 *
 * WHAT THIS FILE EXISTS TO PREVENT, in order of how badly it fails:
 *   1. A SUCCESSOR SPAWNED WHILE THE RUNNER IS CHASING A HANDOFF. The demand
 *      path is the one place where the runner is deliberately dispatching
 *      `claude --bg` at a session that has already run, so it is the easiest
 *      place to accidentally start a second agent on the same worktree — the
 *      2026-09-07 pilot's worst failure. Every test here counts SPAWNS
 *      separately from RESUMES.
 *   2. A DEMAND SENT WITH THE SHORT AGENTS ID. Measured 2026-09-08: `--resume`
 *      with the short id starts a COPY of the conversation under a new id, and a
 *      copy is a second live session. Only the full `sessionId` continues.
 *   3. A SESSION THAT NEVER HANDED OFF DISAPPEARING QUIETLY. After the last
 *      demand the run stops, the ledger says so, and a bug bead is filed — and
 *      when the bead itself cannot be filed, that is said out loud too.
 *
 * The whole world is faked (./justin-loop-world.ts): no processes, no beads
 * workspace, no real state directory.
 */

import {describe, expect, test} from 'bun:test';

import {
  DEFAULT_OPTIONS,
  handoffDemand,
  handoffFailureDescription,
  handoffFailureTitle,
  type InvalidHandoff,
  resumeArgs,
} from '../src/justin-loop/runner';
import {
  argOf,
  beadFrom,
  type LoopResult,
  promptOf,
  resumes,
  runLoop,
  spawns,
} from './justin-loop-world';

/** The `br create` argv of the failure bead, if one was filed. */
function created(r: LoopResult): string[] | null {
  return r.brCalls.find((a) => a[0] === 'create') ?? null;
}

// ---------------------------------------------------------------------------
// The resume argv — measured, and the one place a mistake forks a session
// ---------------------------------------------------------------------------

describe('resumeArgs: the argv that CONTINUES rather than copies', () => {
  test('is exactly --bg --resume <full id> <prompt>, and nothing else', () => {
    // MEASURED 2026-09-08 (claude v2.1.263): "background session 11205a3b keeps
    // its own saved options, so the flags you passed started a copy as
    // 0ea9def1." Any extra flag here — even the SAME --name — forks the session.
    expect(
      resumeArgs('11205a3b-34c4-435b-b21f-4289486061a0', 'write it'),
    ).toEqual([
      '--bg',
      '--resume',
      '11205a3b-34c4-435b-b21f-4289486061a0',
      'write it',
    ]);
  });

  test('carries none of the flags a spawn carries', () => {
    const args = resumeArgs('full-id', 'demand');
    for (const flag of [
      '--name',
      '--model',
      '--permission-mode',
      '--append-system-prompt',
    ]) {
      expect(args).not.toContain(flag);
    }
  });
});

// ---------------------------------------------------------------------------
// The demand text
// ---------------------------------------------------------------------------

describe('handoffDemand: what the session is actually told', () => {
  const BROKEN: InvalidHandoff[] = [
    {
      errors: ['notes are not JSON', 'missing `disposition`'],
      id: 'home-base-9q1',
      title: 'HANDOFF ???',
    },
    {
      errors: ['notes are empty'],
      id: 'home-base-9q2',
      title: 'HANDOFF continue: x',
    },
  ];

  test('names the helper command WITH this session label interpolated', () => {
    const text = handoffDemand({
      attempt: 1,
      attempts: 3,
      invalid: [],
      label: 'fix-hydration-2',
      reason: 'session fix-hydration-2 ended without creating a handoff bead',
      sub: 'no-handoff',
    });
    expect(text).toContain('justin-sdk justin-loop handoff');
    // The label, and the label already stamped onto --from: a session told only
    // "run the helper" has to guess its own identity, and a wrong `from` is
    // invisible to the runner's scan.
    expect(text).toContain('fix-hydration-2');
    expect(text).toContain('--from=fix-hydration-2');
    expect(text).toContain('--disposition=continue|done|blocked');
    expect(text).toContain('--next=');
    expect(text).toContain('demand 1 of 3');
  });

  test('says it is the runner speaking, not a person', () => {
    // The session is being woken mid-conversation by a message nobody typed.
    const text = handoffDemand({
      attempt: 2,
      attempts: 3,
      invalid: [],
      label: 'the-arc-1',
      reason: 'r',
      sub: 'no-handoff',
    });
    expect(text).toContain('justin-loop runner');
    expect(text).toContain('demand 2 of 3');
  });

  test('an invalid-handoff demand quotes EVERY bead id and its errors verbatim', () => {
    const text = handoffDemand({
      attempt: 1,
      attempts: 3,
      invalid: BROKEN,
      label: 'the-arc-1',
      reason: 'no readable handoff bead with from=the-arc-1',
      sub: 'invalid-handoff',
    });
    for (const bad of BROKEN) {
      expect(text).toContain(bad.id);
      for (const err of bad.errors) expect(text).toContain(err);
    }
    // …with the fix-or-close instruction, which is the only thing that lets the
    // session act on them (the .1 review note).
    expect(text).toContain('br update <id> --notes=');
    expect(text).toContain('br close <id> --reason=');
  });

  test('a no-handoff demand does not invent beads to fix', () => {
    const text = handoffDemand({
      attempt: 1,
      attempts: 3,
      invalid: [],
      label: 'the-arc-1',
      reason: 'r',
      sub: 'no-handoff',
    });
    expect(text).not.toContain('br close <id> --reason=');
    expect(text).not.toContain('could not be read');
  });
});

// ---------------------------------------------------------------------------
// AC2 — the demand loop, end to end
// ---------------------------------------------------------------------------

describe('AC2: an ended session with no handoff is resumed and told to write one', () => {
  /** Session 1 hands off nothing, then complies on the first demand. */
  async function compliesOnDemandOne(): Promise<LoopResult> {
    return runLoop({
      opts: {label: 'the-arc', maxSessions: 1},
      scans: [
        [], // start of run: nothing waiting
        [], // after session 1 ends: NO handoff
        [beadFrom('hoff-1', {from: 'the-arc-1'})], // after demand 1: there it is
      ],
    });
  }

  test('the demand is a RESUME of the same session, by its FULL session id', async () => {
    const r = await compliesOnDemandOne();
    const demands = resumes(r.dispatches);
    expect(demands).toHaveLength(1);
    // `sess-1-full-uuid`, not `sess-1`: the short id would start a copy.
    expect(demands[0][2]).toBe('sess-1-full-uuid');
    expect(demands[0][2]).not.toBe('sess-1');
  });

  test('the demand names the helper command and this session label', async () => {
    const r = await compliesOnDemandOne();
    const text = promptOf(resumes(r.dispatches)[0]);
    expect(text).toContain('justin-sdk justin-loop handoff');
    expect(text).toContain('--from=the-arc-1');
    expect(r.stdout).toContain('demand 1/3');
  });

  test('the demanded turn is stopped and VERIFIED before its beads are read', async () => {
    const r = await compliesOnDemandOne();
    // Once for the original turn, once for the demanded one.
    expect(r.stopCalls).toEqual(['sess-1', 'sess-1']);
    expect(r.stdout).toContain('verified gone');
  });

  test('after the handoff appears the runner proceeds normally: continue spawns', async () => {
    const r = await runLoop({
      opts: {label: 'the-arc', maxSessions: 2},
      scans: [
        [],
        [], // no handoff
        [beadFrom('hoff-1', {from: 'the-arc-1'})], // demand 1 works
        [beadFrom('hoff-2', {disposition: 'done', from: 'the-arc-2'})],
      ],
    });
    expect(resumes(r.dispatches)).toHaveLength(1);
    expect(spawns(r.dispatches)).toHaveLength(2);
    // The successor is prompted with the demanded bead's `next`, exactly as if
    // it had been written unprompted.
    expect(promptOf(spawns(r.dispatches)[1])).toContain('Finish the parser');
    expect(r.exitCode).toBe(0);
    expect(r.ledger[0].outcome).toBe('continue');
    expect(r.ledger[0].handoffBead).toBe('hoff-1');
    // The provenance survives: this handoff had to be asked for.
    expect(r.ledger[0].demands).toBe(1);
    expect(r.ledger[1].demands).toBe(0);
  });

  test('a demanded `done` stops the loop at 0 and spawns nothing', async () => {
    const r = await runLoop({
      opts: {label: 'the-arc', maxSessions: 2},
      scans: [
        [],
        [],
        [beadFrom('h', {disposition: 'done', from: 'the-arc-1'})],
      ],
    });
    expect(r.exitCode).toBe(0);
    expect(spawns(r.dispatches)).toHaveLength(1);
    expect(r.ledger[0].outcome).toBe('done');
    expect(r.ledger[0].demands).toBe(1);
  });

  test('a demanded `blocked` stops the loop at 2 and shows the question', async () => {
    const r = await runLoop({
      opts: {label: 'the-arc', maxSessions: 2},
      scans: [
        [],
        [],
        [
          beadFrom('h', {
            disposition: 'blocked',
            from: 'the-arc-1',
            openQuestions: ['Do you want the remote branch deleted?'],
          }),
        ],
      ],
    });
    expect(r.exitCode).toBe(2);
    expect(spawns(r.dispatches)).toHaveLength(1);
    expect(r.stdout).toContain('Do you want the remote branch deleted?');
    expect(r.ledger[0].outcome).toBe('blocked');
  });

  test('a second demand quotes the beads the FIRST demand failed to fix', async () => {
    const r = await runLoop({
      opts: {label: 'the-arc', maxSessions: 1},
      scans: [
        [],
        [{id: 'hoff-broken', notes: '{{{', title: 'HANDOFF ???'}],
        [{id: 'hoff-broken', notes: '{{{', title: 'HANDOFF ???'}],
        [beadFrom('hoff-ok', {from: 'the-arc-1'})],
      ],
    });
    const texts = resumes(r.dispatches).map(promptOf);
    expect(texts).toHaveLength(2);
    for (const text of texts) {
      expect(text).toContain('hoff-broken');
      expect(text).toContain('br close <id> --reason=');
    }
    expect(texts[1]).toContain('demand 2 of 3');
    expect(r.ledger[0].demands).toBe(2);
  });
});

describe('AC2: after 3 failed demands the run stops, ledgers, and files a bead', () => {
  /** Nothing is ever written, however often the session is asked. */
  async function neverComplies(
    opts: Parameters<typeof runLoop>[0] = {},
  ): Promise<LoopResult> {
    return runLoop({
      opts: {label: 'the-arc', maxSessions: 2},
      // Every scan after the first answers "no open handoff beads".
      scans: [[]],
      ...opts,
    });
  }

  test('exactly --handoff-retries demands are sent, then the run stops at 2', async () => {
    const r = await neverComplies();
    expect(DEFAULT_OPTIONS.handoffRetries).toBe(3);
    expect(resumes(r.dispatches)).toHaveLength(3);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain('was told 3 time(s) to write a handoff bead');
  });

  test('NO SUCCESSOR IS SPAWNED on the demand path', async () => {
    const r = await neverComplies();
    // One spawn: the session itself. maxSessions is 2, so a runner that fell
    // through instead of stopping would spawn a second one here.
    expect(spawns(r.dispatches)).toHaveLength(1);
    // And every demand carries none of a spawn's flags.
    for (const d of resumes(r.dispatches)) {
      expect(argOf(d, '--append-system-prompt')).toBe('');
      expect(argOf(d, '--name')).toBe('');
    }
  });

  test('the ledger says no-handoff-after-demands, with the count', async () => {
    const r = await neverComplies();
    expect(r.ledger).toHaveLength(1);
    expect(r.ledger[0].outcome).toBe('no-handoff-after-demands');
    expect(r.ledger[0].demands).toBe(3);
    expect(r.ledger[0].handoffBead).toBeNull();
  });

  test('a bug bead is filed through br, naming the session and the demands', async () => {
    const r = await neverComplies();
    const create = created(r);
    expect(create).not.toBeNull();
    const args = create as string[];
    expect(args[1]).toBe(handoffFailureTitle('the-arc-1', 3));
    expect(args).toContain('bug');
    // NOT labelled `handoff`: a bug report about a missing handoff must never be
    // picked up by the next run's scan as though it were one.
    expect(args).not.toContain('--labels');
    expect(args.join(' ')).not.toContain('handoff\n');
    expect(r.stdout).toContain('filed fx-bug1');
  });

  test('a bead that CANNOT be filed is said out loud, and the run still exits 2', async () => {
    // Silence must be a claim: "we could not record this" is a different fact
    // from "this was recorded", and the run must not imply the second.
    const r = await neverComplies({brCreateFails: true});
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain('could not file the failure bead');
    expect(r.ledger[0].outcome).toBe('no-handoff-after-demands');
  });

  test('NEGATIVE CONTROL: --handoff-retries 0 demands nothing and says so', async () => {
    const r = await runLoop({
      opts: {handoffRetries: 0, label: 'the-arc', maxSessions: 2},
      scans: [[]],
    });
    expect(resumes(r.dispatches)).toHaveLength(0);
    expect(spawns(r.dispatches)).toHaveLength(1);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain('--handoff-retries=0');
    // A session nobody asked gets no bug bead filed against it…
    expect(created(r)).toBeNull();
    // …and the ledger says plainly which of the two failures this was.
    expect(r.ledger[0].outcome).toBe('no-handoff');
    expect(r.ledger[0].demands).toBe(0);
  });

  test('POSITIVE CONTROL: the same world DOES spawn when a handoff appears', async () => {
    // Without this, every "no successor" assertion above would also pass if the
    // runner were incapable of spawning at all.
    const r = await runLoop({
      opts: {label: 'the-arc', maxSessions: 2},
      scans: [[], [], [beadFrom('hoff-1', {from: 'the-arc-1'})]],
    });
    expect(spawns(r.dispatches)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// The demand that cannot be delivered — its own outcome, never a refusal
// ---------------------------------------------------------------------------

describe('a demand that cannot be DELIVERED is not a session that refused', () => {
  test('no full session id: the run stops, says why, and never uses the short id', async () => {
    const r = await runLoop({
      opts: {label: 'the-arc', maxSessions: 2},
      scans: [[]],
      // The row never published a sessionId, so there is nothing `--resume`
      // would continue rather than copy.
      sessions: [{noSessionId: true}],
    });
    expect(resumes(r.dispatches)).toHaveLength(0);
    expect(spawns(r.dispatches)).toHaveLength(1);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain('full session id was never seen');
    expect(r.stdout).toContain('would start a COPY');
    // A DIFFERENT ledger outcome from "asked three times and refused".
    expect(r.ledger[0].outcome).toBe('demand-undeliverable');
    expect(r.ledger[0].demands).toBe(0);
    // And no bug bead accusing a session that was never actually asked.
    expect(created(r)).toBeNull();
  });

  test('a predecessor that would not stop is never woken either', async () => {
    // D6 says an unverified stop licenses nothing. Waking a session that may
    // still be running is not measured behaviour, so it is refused like a spawn.
    const r = await runLoop({
      opts: {label: 'the-arc', maxSessions: 2},
      scans: [[]],
      sessions: [{stop: 'lingers'}],
    });
    expect(resumes(r.dispatches)).toHaveLength(0);
    expect(spawns(r.dispatches)).toHaveLength(1);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain('REFUSING TO DEMAND');
    expect(r.ledger[0].stopOutcome).toBe('kill-failed');
    expect(created(r)).toBeNull();
  });

  test('NEGATIVE CONTROL: the same script IS woken once the stop works', async () => {
    const r = await runLoop({
      opts: {label: 'the-arc', maxSessions: 2},
      scans: [[]],
      sessions: [{stop: 'clears'}],
    });
    expect(resumes(r.dispatches)).toHaveLength(3);
    expect(r.stdout).not.toContain('REFUSING TO DEMAND');
  });

  test('a demanded turn that blocks and is never answered stops the run', async () => {
    const r = await runLoop({
      opts: {
        blockedWaitMin: 5,
        label: 'the-arc',
        maxSessions: 2,
        pollSec: 60,
      },
      scans: [[]],
      sessions: [{demandTurns: [{state: 'blocked', worksForPolls: 10_000}]}],
    });
    expect(resumes(r.dispatches)).toHaveLength(1);
    expect(spawns(r.dispatches)).toHaveLength(1);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain('blocked while being asked for a handoff');
    expect(r.ledger[0].outcome).toBe('blocked');
  });
});

// ---------------------------------------------------------------------------
// The failure bead's own text
// ---------------------------------------------------------------------------

describe('the failure bead reads as a report, not a stack trace', () => {
  test('the title names the session and the number of demands', () => {
    expect(handoffFailureTitle('the-arc-1', 3)).toBe(
      'justin-loop: session the-arc-1 ended without a handoff after 3 demands',
    );
    // Singular, so the title never reads "after 1 demands".
    expect(handoffFailureTitle('the-arc-1', 1)).toEndWith('after 1 demand');
  });

  test('the description carries the worktree, the reason and every unreadable bead', () => {
    const text = handoffFailureDescription({
      cwd: '/Users/jhaa/Dev/home-base',
      demands: 3,
      invalid: [{errors: ['notes are empty'], id: 'home-base-9q2', title: 'H'}],
      label: 'the-arc-1',
      reason: 'no readable handoff bead with from=the-arc-1',
    });
    expect(text).toContain('/Users/jhaa/Dev/home-base');
    expect(text).toContain('the-arc-1');
    expect(text).toContain('home-base-9q2');
    expect(text).toContain('notes are empty');
    expect(text).toContain('Nothing was spawned');
  });
});
