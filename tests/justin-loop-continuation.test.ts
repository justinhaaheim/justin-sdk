/**
 * D18 — the successor is TOLD which session it continues (home-base-k0b8n.5).
 *
 * A justin-loop chain is a sequence of Claude Code sessions, and each one writes
 * its own thread bead. Until this bead nothing connected them: the successor had
 * no way to name its predecessor, so `thread report` could not set
 * `continuesFrom`, and the predecessor's open asks — the questions Justin has
 * not answered yet — were dropped at exactly the moment the arc changed hands.
 *
 * The runner is the only thing that knows both ids, so it hands the predecessor's
 * full claude session id to the successor TWO ways, which fail differently:
 *
 *   1. `JUSTIN_LOOP_PREDECESSOR_SESSION_ID` on the dispatch — automatic, arrives
 *      whether or not the session reads its preamble. MEASURED to propagate into
 *      a real `--bg` session on 2026-09-19, claude 2.1.278 (`bun run
 *      probe:bg-env`); see the dated comment at REAL_DEPS.dispatch.
 *   2. One line in the boot preamble — visible, and it survives a session that
 *      never runs `thread prepare` at all.
 *
 * THE FAILURE THIS FILE GUARDS is critical rule 7 in its reassuring direction:
 * an UNKNOWN predecessor must set NO variable rather than an empty one. The
 * thread tool reads a present variable as "there is a predecessor, go look it
 * up", so `''` would come back as "predecessor has no thread bead" — a
 * measurement about a predecessor that was never observed at all.
 */

import {describe, expect, test} from 'bun:test';
import {mkdtempSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {
  type BootContext,
  bootPreamble,
  crashBootPlan,
  dispatchEnv,
  type LedgerRow,
  PREDECESSOR_SESSION_ENV,
  readLedgerSessionId,
} from '../src/justin-loop/runner';
import {beadFrom, promptOf, runLoop, spawnCalls} from './justin-loop-world';

const PRED = '01998c54-3f3a-7b21-9d0e-2f5ab0c4e7d1';

function bootWith(
  predecessorSessionId: string | null,
  plan: BootContext['plan'],
): BootContext {
  return {
    cwd: '/Users/jhaa/Dev/home-base',
    label: 'the-arc-2',
    plan,
    predecessorSessionId,
  };
}

const HANDOFF_PLAN: BootContext['plan'] = {
  kind: 'handoff',
  match: {
    handoff: {
      arc: 'the arc',
      branch: 'worktree-the-arc',
      contextTokens: 301_000,
      createdAt: '2026-09-19T12:00:00.000Z',
      disposition: 'continue',
      from: 'the-arc-1',
      next: 'keep going',
      openQuestions: [],
      schemaVersion: 1,
      state: 'halfway',
      worktree: '/Users/jhaa/Dev/home-base/.claude/worktrees/the-arc',
    },
    row: {
      id: 'hoff-42',
      labels: ['handoff'],
      notes: null,
      status: 'open',
      title: 'HANDOFF continue: the arc',
      updatedAt: '2026-09-19T12:00:00.000Z',
    },
  },
};

describe('dispatchEnv (D18)', () => {
  test('a KNOWN predecessor is carried on the dispatch environment', () => {
    expect(dispatchEnv(bootWith(PRED, HANDOFF_PLAN))).toEqual({
      [PREDECESSOR_SESSION_ENV]: PRED,
    });
  });

  test('an UNKNOWN predecessor sets NOTHING — never an empty string', () => {
    const env = dispatchEnv(bootWith(null, HANDOFF_PLAN));
    expect(env).toEqual({});
    // Spelled out as well as compared: `{VAR: ''}` also satisfies `toEqual({})`
    // under no reading of it, but this is the exact substitution rule 7 forbids
    // and it deserves an assertion that names it.
    expect(Object.hasOwn(env, PREDECESSOR_SESSION_ENV)).toBe(false);
  });

  test('the variable name is the one the thread tool reads', () => {
    // One spelling, asserted literally, because producer and consumer live in
    // different directories and a rename in one is invisible to the other.
    expect(PREDECESSOR_SESSION_ENV).toBe('JUSTIN_LOOP_PREDECESSOR_SESSION_ID');
  });
});

describe('the boot preamble names the predecessor (D18)', () => {
  test('a pickup boot names the id and says the link is automatic', () => {
    const preamble = bootPreamble(bootWith(PRED, HANDOFF_PLAN)) ?? '';
    expect(preamble).toContain(PRED);
    expect(preamble.replace(/\s+/g, ' ')).toContain(
      `Your predecessor's session id is ${PRED}`,
    );
    expect(preamble).toContain(PREDECESSOR_SESSION_ENV);
    expect(preamble).toContain('thread prepare');
  });

  test('a pickup boot with no known predecessor says UNKNOWN out loud', () => {
    const preamble = bootPreamble(bootWith(null, HANDOFF_PLAN)) ?? '';
    expect(preamble.replace(/\s+/g, ' ')).toContain(
      "Your predecessor's session id is UNKNOWN",
    );
    // The absence must not be dressed up as a value, and it must not be silent.
    expect(preamble).not.toContain(`${PREDECESSOR_SESSION_ENV}=`);
    expect(preamble).not.toContain('session id is  ');
  });

  test('a reconstruct boot carries the same line, both ways round', () => {
    const plan = crashBootPlan(2, 'stopped after 45m (--timeout-min)');
    expect(bootPreamble(bootWith(PRED, plan)) ?? '').toContain(PRED);
    expect(
      (bootPreamble(bootWith(null, plan)) ?? '').replace(/\s+/g, ' '),
    ).toContain("Your predecessor's session id is UNKNOWN");
  });

  test('a FRESH boot still says nothing at all', () => {
    // The first session of a run has no predecessor and no preamble; D18 must
    // not turn `null` into a one-line preamble nobody asked for.
    expect(bootPreamble(bootWith(null, {kind: 'fresh'}))).toBeNull();
    expect(bootPreamble(bootWith(PRED, {kind: 'fresh'}))).toBeNull();
  });
});

describe('a chained run hands session 2 session 1’s id (D18)', () => {
  test('the successor dispatch carries the predecessor’s FULL session id', async () => {
    const r = await runLoop({
      opts: {label: 'the-arc', maxSessions: 2},
      scans: [[], [beadFrom('hoff-1', {from: 'the-arc-1'})], []],
    });
    const spawned = spawnCalls(r.dispatchCalls);
    expect(spawned.length).toBe(2);

    // Session 1 opens the chain: nothing precedes it, so nothing is set.
    expect(spawned[0]?.env).toEqual({});

    // Session 2 gets the id the world gave session 1's agents row — the FULL
    // one, not the 8-character `id`, because that is what a thread bead is
    // keyed on and what `--resume` needs.
    expect(spawned[1]?.env).toEqual({
      [PREDECESSOR_SESSION_ENV]: 'sess-1-full-uuid',
    });
    expect(spawned[1]?.env[PREDECESSOR_SESSION_ENV]).not.toBe('sess-1');

    // …and the visible half arrived too, in the prompt the session reads.
    expect(promptOf(spawned[1]?.args ?? [])).toContain('sess-1-full-uuid');
  });

  test('a predecessor whose session id was never seen sets no variable', async () => {
    // `noSessionId` is a row the runner could read but that carried no
    // sessionId. That is a FAILED measurement, and it must reach the successor
    // as "UNKNOWN", never as an empty predecessor id.
    const r = await runLoop({
      opts: {label: 'the-arc', maxSessions: 2},
      scans: [[], [beadFrom('hoff-1', {from: 'the-arc-1'})], []],
      sessions: [{noSessionId: true}],
    });
    const spawned = spawnCalls(r.dispatchCalls);
    expect(spawned.length).toBe(2);
    expect(spawned[1]?.env).toEqual({});
    expect(promptOf(spawned[1]?.args ?? []).replace(/\s+/g, ' ')).toContain(
      "Your predecessor's session id is UNKNOWN",
    );
  });

  test('NEGATIVE CONTROL: a run that starts FRESH looks nothing up', async () => {
    // The lookup below is for a run that BOOTS from a bead. A fresh run has no
    // predecessor to look up, and must not say a word about one.
    const r = await runLoop({
      ledgerSeed: [{fullSessionId: PRED, label: 'the-arc-1'}],
      opts: {label: 'the-arc', maxSessions: 1},
      scans: [[], [beadFrom('h', {disposition: 'done', from: 'the-arc-1'})]],
    });
    expect(spawnCalls(r.dispatchCalls)[0]?.env).toEqual({});
    expect(r.stdout).not.toContain('predecessor session');
  });

  test('a --resume demand carries no predecessor environment', async () => {
    // A demand wakes the SAME session (D10). Telling it that it continues
    // something would be telling it that it continues itself.
    const r = await runLoop({
      opts: {handoffRetries: 1, label: 'the-arc', maxSessions: 1},
      // No handoff bead after the session ends → the runner demands one.
      scans: [[], [], []],
    });
    const resumed = r.dispatchCalls.filter((call) =>
      call.args.includes('--resume'),
    );
    expect(resumed.length).toBeGreaterThan(0);
    for (const call of resumed) expect(call.env).toEqual({});
  });
});

/**
 * 33.12 — the link survives a `--pickup` RESTART, not just a chained successor.
 *
 * D18 works inside one run: the loop watched the predecessor, so it holds its
 * session id in memory. A run STARTED from a picked-up handoff bead — after
 * `--max-sessions` ran out, or after `handoff answer` flipped a blocked bead
 * (D16) — never watched anything, so its first session booted with the
 * predecessor UNKNOWN and the arc's threads stopped linking at exactly the
 * point Justin had to intervene.
 *
 * The bead's `from` is a ledger row's `label`, so the id is on disk. What is on
 * disk had to change first: the ledger recorded only `sessionId`, the
 * 8-character `claude agents` id, which is a TRUNCATION of the full one — and
 * `findThreadBySession` matches `sessionId=<id>` exactly, so handing the short
 * one to the successor would have produced a guaranteed miss reported as
 * "predecessor session X has no thread bead", a fact about a predecessor nobody
 * ever looked up. Schema 3 writes `fullSessionId` beside it; that is what this
 * reads.
 */
describe('readLedgerSessionId — the id comes back off disk (33.12)', () => {
  function ledger(lines: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'justin-loop-ledger-'));
    const path = join(dir, 'runs.jsonl');
    writeFileSync(path, lines.map((l) => `${l}\n`).join(''));
    return path;
  }

  function rowJson(over: Partial<LedgerRow>): string {
    return JSON.stringify({
      contextTokens: null,
      demands: 0,
      endedAt: '2026-09-19T12:00:00.000Z',
      fullSessionId: PRED,
      handoffBead: 'hoff-1',
      label: 'the-arc-1',
      n: 1,
      name: '2026-09-19 12:00 the-arc-1',
      outcome: 'continue',
      progressed: true,
      runId: '202609191200-the-arc',
      schemaVersion: 3,
      sessionId: PRED.slice(0, 8),
      startedAt: '2026-09-19T11:00:00.000Z',
      stopOutcome: 'stopped',
      ...over,
    });
  }

  test('the FULL id comes back, never the 8-character one beside it', () => {
    const read = readLedgerSessionId(ledger([rowJson({})]), 'the-arc-1');
    expect(read).toEqual({kind: 'found', sessionId: PRED});
    // Spelled out because the two differ by truncation, and the short one is a
    // legal string that would sail through any "is it set?" check.
    expect(read.kind === 'found' ? read.sessionId : '').not.toBe(
      PRED.slice(0, 8),
    );
  });

  test('the NEWEST row with that label wins', () => {
    const newer = '01998c54-0000-7b21-9d0e-2f5ab0c4e7d1';
    const path = ledger([
      rowJson({}),
      rowJson({label: 'other-arc-1'}),
      rowJson({fullSessionId: newer}),
    ]);
    expect(readLedgerSessionId(path, 'the-arc-1')).toEqual({
      kind: 'found',
      sessionId: newer,
    });
  });

  test('a ledger that cannot be read is UNREADABLE, and says why', () => {
    const read = readLedgerSessionId(
      join(mkdtempSync(join(tmpdir(), 'justin-loop-ledger-')), 'runs.jsonl'),
      'the-arc-1',
    );
    expect(read.kind).toBe('unreadable');
    expect(read.kind === 'unreadable' ? read.reason : '').toContain('ENOENT');
  });

  test('a ledger with no such label is NO-ROW, and says how far it looked', () => {
    const read = readLedgerSessionId(
      ledger([
        rowJson({label: 'other-arc-1'}),
        rowJson({label: 'other-arc-2'}),
      ]),
      'the-arc-1',
    );
    expect(read.kind).toBe('no-row');
    expect(read.kind === 'no-row' ? read.detail : '').toContain('2 rows');
  });

  test('a row whose session was never observed is NO-SESSION-ID, not no-row', () => {
    // The session ran; its `claude agents` row was never read. That is a FAILED
    // measurement about a real predecessor, not the absence of one.
    const read = readLedgerSessionId(
      ledger([rowJson({fullSessionId: null})]),
      'the-arc-1',
    );
    expect(read.kind).toBe('no-session-id');
    expect(read.kind === 'no-session-id' ? read.detail : '').toContain(
      'never read',
    );
  });

  test('a row written before schema 3 says THAT, not "never read"', () => {
    // Two different facts: nobody wrote the field down, versus the field was
    // written down as "not measured". Only the first is fixed by running again.
    const old = JSON.parse(rowJson({})) as Record<string, unknown>;
    delete old.fullSessionId;
    old.schemaVersion = 2;
    const read = readLedgerSessionId(
      ledger([JSON.stringify(old)]),
      'the-arc-1',
    );
    expect(read.kind).toBe('no-session-id');
    const detail = read.kind === 'no-session-id' ? read.detail : '';
    expect(detail).toContain('predates');
    expect(detail).toContain('schemaVersion 2');
  });

  test('the newest match does NOT fall through to an older row that has an id', () => {
    // Two runs can write the same label (that is 33.11's bug). An older row
    // with that label is a DIFFERENT session, and linking the successor's
    // thread to it would be a fabricated fact rather than a missing one.
    const read = readLedgerSessionId(
      ledger([rowJson({}), rowJson({fullSessionId: null})]),
      'the-arc-1',
    );
    expect(read.kind).toBe('no-session-id');
  });

  test('a torn or unparseable line is counted, never fatal and never a match', () => {
    const read = readLedgerSessionId(
      ledger(['{"label":"the-arc-1"', 'not json at all', '{"n":3}']),
      'the-arc-1',
    );
    expect(read.kind).toBe('no-row');
    expect(read.kind === 'no-row' ? read.detail : '').toContain(
      '3 of them could not be read',
    );
  });

  test('the read is BOUNDED to the tail, and the partial first line is dropped', () => {
    // `maxBytes` is a parameter so the bound can be proven cheaply instead of
    // by writing a quarter-megabyte fixture. The row the cut lands in must not
    // be parsed: a torn `{"label":"the-arc-1"…` could match on a field that
    // happened to survive.
    const path = ledger([
      rowJson({fullSessionId: '01998c54-1111-7b21-9d0e-2f5ab0c4e7d1'}),
      rowJson({}),
    ]);
    const whole = readLedgerSessionId(path, 'the-arc-1');
    expect(whole).toEqual({kind: 'found', sessionId: PRED});

    // A tail smaller than one row: nothing whole survives the cut, so there is
    // no match — and no crash, and no id invented out of half a row.
    const tail = readLedgerSessionId(path, 'the-arc-1', 40);
    expect(tail.kind).toBe('no-row');
    expect(tail.kind === 'no-row' ? tail.detail : '').toContain(
      'last 40 bytes',
    );
  });
});

describe('a --pickup run recovers its predecessor from the ledger (33.12)', () => {
  /**
   * The run the blocked stop tells Justin to make: `--pickup --label the-arc`,
   * with `the-arc-1`'s bead waiting. 33.11 makes the session it boots
   * `the-arc-2`; this makes it the thread-successor of `the-arc-1`.
   */
  function pickupRun(
    over: Partial<Parameters<typeof runLoop>[0]> = {},
  ): Promise<Awaited<ReturnType<typeof runLoop>>> {
    return runLoop({
      opts: {label: 'the-arc', maxSessions: 1, pickup: true},
      scans: [
        [beadFrom('hoff-1', {from: 'the-arc-1'})],
        [beadFrom('hoff-2', {disposition: 'done', from: 'the-arc-2'})],
      ],
      ...over,
    });
  }

  test('the first dispatch carries the id the ledger holds for the bead’s `from`', async () => {
    const r = await pickupRun({
      ledgerSeed: [{fullSessionId: PRED, label: 'the-arc-1'}],
    });
    const spawned = spawnCalls(r.dispatchCalls);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.env).toEqual({[PREDECESSOR_SESSION_ENV]: PRED});
    // The visible half arrived too, in the prompt the session reads.
    expect(promptOf(spawned[0]?.args ?? [])).toContain(PRED);
    expect(r.stdout).toContain(`predecessor session ${PRED} recovered`);
  });

  test('an UNREADABLE ledger sets nothing, and names the failure', async () => {
    const r = await pickupRun({
      ledgerUnreadable: 'EACCES: permission denied, open runs.jsonl',
    });
    const spawned = spawnCalls(r.dispatchCalls);
    expect(spawned[0]?.env).toEqual({});
    expect(promptOf(spawned[0]?.args ?? []).replace(/\s+/g, ' ')).toContain(
      "Your predecessor's session id is UNKNOWN",
    );
    expect(r.stdout).toContain('predecessor session UNKNOWN');
    expect(r.stdout).toContain('EACCES');
  });

  test('a ledger with NO row for that label reads differently from an unreadable one', async () => {
    const r = await pickupRun({
      ledgerSeed: [{fullSessionId: PRED, label: 'another-arc-1'}],
    });
    expect(spawnCalls(r.dispatchCalls)[0]?.env).toEqual({});
    expect(r.stdout).toContain('no ledger row for `the-arc-1`');
    expect(r.stdout).not.toContain('EACCES');
  });

  test('a row whose session was never observed sets nothing either', async () => {
    const r = await pickupRun({
      ledgerSeed: [{fullSessionId: null, label: 'the-arc-1'}],
    });
    expect(spawnCalls(r.dispatchCalls)[0]?.env).toEqual({});
    expect(r.stdout).toContain('carries no fullSessionId');
  });

  test('the ledger row this run WRITES carries the id the next pickup needs', async () => {
    // The loop closing on itself: a `--pickup` run is only linkable because the
    // run before it wrote the full id down.
    const r = await pickupRun({
      ledgerSeed: [{fullSessionId: PRED, label: 'the-arc-1'}],
    });
    expect(r.ledger[0]?.label).toBe('the-arc-2');
    expect(r.ledger[0]?.fullSessionId).toBe('sess-1-full-uuid');
    expect(r.ledger[0]?.sessionId).toBe('sess-1');
  });
});
