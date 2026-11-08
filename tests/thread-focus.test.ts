/**
 * `thread focus` (home-base-9uzxw.1, epic D-FOCUS): the decision core over
 * fake readers. No test reaches br, ps or cmux: a live focus would switch
 * Justin's screen, and the session guard refuses focus-panel anyway.
 */

import type {CmuxCall} from '../src/thread/cmux';
import type {
  ContinuingRead,
  FocusBeadRead,
  FocusReaders,
  FocusRefusal,
  FocusResult,
  PickupFailuresRead,
  SessionLookup,
} from '../src/thread/focus';
import type {PaneFact} from '../src/thread/session-card';

import {describe, expect, test} from 'bun:test';

import {
  FOCUS_EXIT,
  FOCUS_REFUSALS,
  focusJsonOf,
  focusText,
  handedOffSignOf,
  resolveFocus,
  runThreadFocus,
} from '../src/thread/focus';
import {CHAIN_WALK_LIMIT} from '../src/thread/handoff-chain';
import {captureWriteStdout} from './capture-stdout';

const SURFACE = '312CECAD-F1A2-4176-930A-AD7BBCFB18C0';
const WORKSPACE = '29A160E5-340C-4A1C-8082-4CFD9AB6B306';
const LIVE: PaneFact = {
  kind: 'live',
  surfaceId: SURFACE,
  workspaceId: WORKSPACE,
};
const sid = (n: number): string =>
  `aaaa1111-0000-4000-8000-${String(n).padStart(12, '0')}`;

interface FakeBead {
  labels: string[];
  notes?: string;
}

interface Fake {
  calls: {pane: string[]; run: (readonly string[])[]; show: string[]};
  readers: FocusReaders;
}

/** Fake readers over a map of beads; `continuing` reads the same map. */
function fake(
  beads: Record<string, FakeBead | 'failed'>,
  options: {
    checkouts?: Record<string, string>;
    continuing?: ContinuingRead;
    lookup?: Record<string, SessionLookup>;
    pane?: PaneFact;
    pickups?: PickupFailuresRead;
    run?: CmuxCall;
  } = {},
): Fake {
  const calls: Fake['calls'] = {pane: [], run: [], show: []};
  const showBead = (id: string): FocusBeadRead => {
    calls.show.push(id);
    const bead = beads[id];
    if (bead === 'failed') {
      return {kind: 'failed', reason: 'br exited 2: database is locked'};
    }
    if (bead == null) return {kind: 'notFound', reason: 'not in db'};
    return {
      bead: {
        db: 'db',
        id,
        labels: bead.labels,
        notes: bead.notes ?? null,
        title: `title of ${id}`,
      },
      kind: 'found',
    };
  };
  return {
    calls,
    readers: {
      checkoutOf: (sessionId) => options.checkouts?.[sessionId] ?? null,
      continuing: (head) =>
        options.continuing ?? {
          ids: Object.entries(beads)
            .filter(
              ([, bead]) =>
                bead !== 'failed' && bead.labels.includes(`continues:${head}`),
            )
            .map(([id]) => id),
          kind: 'read',
        },
      lookupSession: (sessionId) =>
        options.lookup?.[sessionId] ?? {kind: 'untracked'},
      pane: (sessionId) => {
        calls.pane.push(sessionId);
        return Promise.resolve(options.pane ?? LIVE);
      },
      pickupFailures: () => options.pickups ?? {failures: [], kind: 'read'},
      run: (args) => {
        calls.run.push(args);
        return Promise.resolve(options.run ?? {kind: 'ok', stdout: 'OK'});
      },
      showBead,
    },
  };
}

const dry = {dryRun: true};

function refusedReason(result: FocusResult): string {
  if (result.kind !== 'refused') {
    throw new Error(`expected a refusal, got ${result.kind}`);
  }
  return result.reason;
}

describe('thread focus: the walk', () => {
  test('no successor and a live pane: the focus-panel argv for its own pane', async () => {
    const {calls, readers} = fake({'hb-a': {labels: [`sid:${sid(1)}`]}});
    const result = await resolveFocus('hb-a', readers, dry);
    expect(result.kind).toBe('dryRun');
    expect(focusJsonOf(result).argv).toEqual([
      'cmux',
      'focus-panel',
      '--panel',
      SURFACE,
      '--workspace',
      WORKSPACE,
    ]);
    expect(calls.pane).toEqual([sid(1)]);
    // --dry-run sends nothing to cmux.
    expect(calls.run).toEqual([]);
  });

  test('without --dry-run it runs focus-panel and nothing else', async () => {
    const {calls, readers} = fake({'hb-a': {labels: [`sid:${sid(1)}`]}});
    const result = await resolveFocus('hb-a', readers, {dryRun: false});
    expect(result.kind).toBe('focused');
    expect(calls.run).toEqual([
      ['focus-panel', '--panel', SURFACE, '--workspace', WORKSPACE],
    ]);
  });

  test('a two-step chain A to B to C resolves to C', async () => {
    const {calls, readers} = fake({
      'hb-a': {labels: ['continued-by:hb-b', `sid:${sid(1)}`]},
      'hb-b': {
        labels: ['continues:hb-a', 'continued-by:hb-c', `sid:${sid(2)}`],
      },
      'hb-c': {labels: ['continues:hb-b', `sid:${sid(3)}`]},
    });
    const result = await resolveFocus('hb-a', readers, dry);
    expect(result.kind).toBe('dryRun');
    if (result.kind !== 'dryRun') return;
    expect(result.chain).toEqual(['hb-a', 'hb-b', 'hb-c']);
    expect(result.head.beadId).toBe('hb-c');
    expect(result.head.sessionId).toBe(sid(3));
    expect(calls.pane).toEqual([sid(3)]);
  });

  test('a session id is turned into its bead through the sessions index', async () => {
    const {readers} = fake(
      {
        'hb-a': {labels: ['continued-by:hb-b', `sid:${sid(1)}`]},
        'hb-b': {labels: ['continues:hb-a', `sid:${sid(2)}`]},
      },
      {lookup: {[sid(1)]: {beadId: 'hb-a', checkout: '/c', kind: 'tracked'}}},
    );
    const result = await resolveFocus(sid(1), readers, dry);
    expect(result.kind).toBe('dryRun');
    if (result.kind === 'dryRun') expect(result.head.beadId).toBe('hb-b');
  });

  test('a sessions index that cannot be read refuses', async () => {
    const {calls, readers} = fake(
      {},
      {lookup: {[sid(1)]: {kind: 'failed', reason: 'EACCES'}}},
    );
    const reason = refusedReason(await resolveFocus(sid(1), readers, dry));
    expect(reason).toContain(`session ${sid(1)}`);
    expect(reason).toContain('EACCES');
    expect(calls.pane).toEqual([]);
  });

  test('a successor bead that cannot be found refuses, names it, and never falls back to the old pane', async () => {
    const {calls, readers} = fake({
      'hb-a': {labels: ['continued-by:hb-gone', `sid:${sid(1)}`]},
    });
    const result = await resolveFocus('hb-a', readers, dry);
    const reason = refusedReason(result);
    expect(reason).toContain('hb-a names continued-by:hb-gone');
    expect(reason).toContain('hb-gone could not be found');
    expect(calls.pane).toEqual([]);
    expect(focusJsonOf(result).resume).toBeNull();
    expect(focusJsonOf(result).exitCode).toBe(3);
  });

  test('a successor bead that cannot be read refuses and names it', async () => {
    const {calls, readers} = fake({
      'hb-a': {labels: ['continued-by:hb-b', `sid:${sid(1)}`]},
      'hb-b': 'failed',
    });
    const reason = refusedReason(await resolveFocus('hb-a', readers, dry));
    expect(reason).toContain('hb-b could not be read');
    expect(reason).toContain('database is locked');
    expect(calls.pane).toEqual([]);
  });

  test('two continued-by: labels refuse', async () => {
    const {calls, readers} = fake({
      'hb-a': {
        labels: ['continued-by:hb-b', 'continued-by:hb-c', `sid:${sid(1)}`],
      },
      'hb-b': {labels: [`sid:${sid(2)}`]},
      'hb-c': {labels: [`sid:${sid(3)}`]},
    });
    const reason = refusedReason(await resolveFocus('hb-a', readers, dry));
    expect(reason).toContain('hb-a names 2 successors');
    expect(calls.pane).toEqual([]);
  });

  test('a loop refuses', async () => {
    const {calls, readers} = fake({
      'hb-a': {labels: ['continued-by:hb-b', `sid:${sid(1)}`]},
      'hb-b': {labels: ['continued-by:hb-a', `sid:${sid(2)}`]},
    });
    const reason = refusedReason(await resolveFocus('hb-a', readers, dry));
    expect(reason).toContain('loops back to hb-a');
    expect(calls.pane).toEqual([]);
  });

  test('a chain past CHAIN_WALK_LIMIT refuses', async () => {
    const beads: Record<string, FakeBead> = {};
    const total = CHAIN_WALK_LIMIT + 2;
    for (let n = 0; n < total; n += 1) {
      beads[`hb-${n}`] = {
        labels: [
          ...(n + 1 < total ? [`continued-by:hb-${n + 1}`] : []),
          `sid:${sid(n)}`,
        ],
      };
    }
    const {calls, readers} = fake(beads);
    const reason = refusedReason(await resolveFocus('hb-0', readers, dry));
    expect(reason).toContain(`longer than ${CHAIN_WALK_LIMIT} sessions`);
    expect(calls.pane).toEqual([]);
  });

  test('a half-written link (only continues:<head> exists) is followed, and said', async () => {
    const {readers} = fake({
      'hb-a': {labels: [`sid:${sid(1)}`]},
      'hb-b': {labels: ['continues:hb-a', `sid:${sid(2)}`]},
    });
    const result = await resolveFocus('hb-a', readers, dry);
    expect(result.kind).toBe('dryRun');
    if (result.kind !== 'dryRun') return;
    expect(result.head.beadId).toBe('hb-b');
    expect(result.notes.join('\n')).toContain('half-written link followed');
  });

  test('two beads that continue the head refuse', async () => {
    const {readers} = fake({
      'hb-a': {labels: [`sid:${sid(1)}`]},
      'hb-b': {labels: ['continues:hb-a', `sid:${sid(2)}`]},
      'hb-c': {labels: ['continues:hb-a', `sid:${sid(3)}`]},
    });
    const reason = refusedReason(await resolveFocus('hb-a', readers, dry));
    expect(reason).toContain('2 session beads say they continue hb-a');
  });

  test('a reverse query that fails refuses (never read as "no successor")', async () => {
    const {calls, readers} = fake(
      {'hb-a': {labels: [`sid:${sid(1)}`]}},
      {continuing: {kind: 'failed', reason: 'br exited 2'}},
    );
    const reason = refusedReason(await resolveFocus('hb-a', readers, dry));
    expect(reason).toContain(
      'could not check for a session that continues hb-a',
    );
    expect(calls.pane).toEqual([]);
  });
});

describe('thread focus: a head whose handoff ran', () => {
  const checkouts = {[sid(1)]: '/Users/demo/Dev/home base'};
  const resume = `cd '/Users/demo/Dev/home base' && claude --resume ${sid(1)}`;

  test('handed off with no successor linked: refused, with the resume command', async () => {
    const {calls, readers} = fake(
      {'hb-a': {labels: ['handed-off', `sid:${sid(1)}`]}},
      {checkouts},
    );
    const result = await resolveFocus('hb-a', readers, dry);
    expect(refusedReason(result)).toContain(
      'hb-a handed off, successor not linked yet',
    );
    expect(focusJsonOf(result).resume).toBe(resume);
    expect(calls.pane).toEqual([]);
  });

  test('the handed-off note line alone counts too', async () => {
    const {readers} = fake({
      'hb-a': {
        labels: [`sid:${sid(1)}`],
        notes: '- 2026-11-07 14:00: handed off — next: the pull preflight',
      },
    });
    expect(refusedReason(await resolveFocus('hb-a', readers, dry))).toContain(
      'successor not linked yet',
    );
  });

  test('a refused handoff with no successor is refused', async () => {
    const {readers} = fake(
      {
        'hb-a': {
          labels: ['handoff-refused', `sid:${sid(1)}`],
          notes:
            '- 2026-11-07 14:00: handoff refused: too-many-sessions — 9 open',
        },
      },
      {checkouts},
    );
    const result = await resolveFocus('hb-a', readers, dry);
    expect(refusedReason(result)).toContain(
      "hb-a's handoff was refused (too-many-sessions): 9 open",
    );
    expect(focusJsonOf(result).resume).toBe(resume);
  });

  test("a successor's recorded pickup failure naming the head is refused", async () => {
    const {readers} = fake(
      {'hb-a': {labels: [`sid:${sid(1)}`]}},
      {
        pickups: {
          failures: [
            {
              predecessorBeadId: 'hb-a',
              reason: 'br update failed',
              sessionId: sid(9),
            },
          ],
          kind: 'read',
        },
      },
    );
    expect(refusedReason(await resolveFocus('hb-a', readers, dry))).toContain(
      `session ${sid(9)} tried to pick up hb-a's handoff and failed`,
    );
  });

  test('pickup records that cannot be read refuse', async () => {
    const {readers} = fake(
      {'hb-a': {labels: [`sid:${sid(1)}`]}},
      {pickups: {kind: 'failed', reason: 'x.json is not JSON'}},
    );
    expect(refusedReason(await resolveFocus('hb-a', readers, dry))).toContain(
      'x.json is not JSON',
    );
  });
});

describe('thread focus: the pane and the sid label', () => {
  const checkouts = {[sid(1)]: '/Users/demo/Dev/app'};

  test('a pane that is none refuses and prints the resume command', async () => {
    const {calls, readers} = fake(
      {'hb-a': {labels: [`sid:${sid(1)}`]}},
      {checkouts, pane: {kind: 'none'}},
    );
    const result = await resolveFocus('hb-a', readers, {dryRun: false});
    expect(refusedReason(result)).toContain('is in no live cmux pane');
    expect(focusJsonOf(result).resume).toBe(
      `cd /Users/demo/Dev/app && claude --resume ${sid(1)}`,
    );
    expect(calls.run).toEqual([]);
  });

  test('a pane that is unknown refuses, and the recorded pane is NOT used', async () => {
    const {calls, readers} = fake(
      {
        'hb-a': {
          labels: [
            `sid:${sid(1)}`,
            'cmux-ws:STALE-WORKSPACE',
            'cmux-surface:STALE-SURFACE',
          ],
        },
      },
      {
        checkouts,
        pane: {
          kind: 'unknown',
          reason: 'ps refused: Operation not permitted',
          recorded: {surface: 'STALE-SURFACE', workspace: 'STALE-WORKSPACE'},
        },
      },
    );
    const result = await resolveFocus('hb-a', readers, {dryRun: false});
    const json = focusJsonOf(result);
    expect(refusedReason(result)).toContain('pane is unknown: ps refused');
    expect(json.argv).toBeNull();
    expect(json.resume).toBe(
      `cd /Users/demo/Dev/app && claude --resume ${sid(1)}`,
    );
    expect(JSON.stringify(json)).not.toContain('STALE-WORKSPACE');
    expect(calls.run).toEqual([]);
  });

  test('a head with no sid: label refuses', async () => {
    const {calls, readers} = fake({'hb-a': {labels: []}});
    expect(refusedReason(await resolveFocus('hb-a', readers, dry))).toContain(
      'hb-a has no sid: label',
    );
    expect(calls.pane).toEqual([]);
  });

  test('a head with two sid: labels refuses', async () => {
    const {calls, readers} = fake({
      'hb-a': {labels: [`sid:${sid(1)}`, `sid:${sid(2)}`]},
    });
    expect(refusedReason(await resolveFocus('hb-a', readers, dry))).toContain(
      'hb-a has 2 sid: labels',
    );
    expect(calls.pane).toEqual([]);
  });

  test('an untracked session with a live pane is focused, and says its links are not recorded', async () => {
    const {calls, readers} = fake({}, {lookup: {}});
    const result = await resolveFocus(sid(5), readers, {dryRun: false});
    expect(result.kind).toBe('focused');
    if (result.kind !== 'focused') return;
    expect(result.head.beadId).toBeNull();
    expect(result.notes.join('\n')).toContain(
      'its handoff links are not recorded',
    );
    expect(calls.show).toEqual([]);
    expect(calls.run).toEqual([
      ['focus-panel', '--panel', SURFACE, '--workspace', WORKSPACE],
    ]);
  });

  test('an untracked session with no live pane refuses', async () => {
    const {readers} = fake({}, {pane: {kind: 'none'}});
    expect(
      refusedReason(await resolveFocus(sid(5), readers, {dryRun: false})),
    ).toContain(`session ${sid(5)} is in no live cmux pane`);
  });

  test('the cmux call failing is exit 1', async () => {
    const {readers} = fake(
      {'hb-a': {labels: [`sid:${sid(1)}`]}},
      {run: {kind: 'failed', reason: 'no such panel', timedOut: false}},
    );
    const result = await resolveFocus('hb-a', readers, {dryRun: false});
    expect(result.kind).toBe('cmuxFailed');
    expect(FOCUS_EXIT[result.kind]).toBe(1);
    expect(focusText(result)).toContain('cmux focus-panel');
    expect(focusText(result)).toContain('no such panel');
  });

  test('a timed-out cmux call says the outcome is unknown', async () => {
    const {readers} = fake(
      {'hb-a': {labels: [`sid:${sid(1)}`]}},
      {run: {kind: 'failed', reason: 'Command timed out', timedOut: true}},
    );
    const result = await resolveFocus('hb-a', readers, {dryRun: false});
    expect(result.kind).toBe('cmuxFailed');
    if (result.kind === 'cmuxFailed') {
      expect(result.reason).toContain(
        'whether the tab came forward is unknown',
      );
    }
  });

  test('a target that is neither a session id nor a bead id is usage, exit 2', async () => {
    const {readers} = fake({});
    const result = await resolveFocus('not_an_id', readers, dry);
    expect(result.kind).toBe('usage');
    expect(FOCUS_EXIT.usage).toBe(2);
  });
});

describe('thread focus: runThreadFocus', () => {
  test('--json prints one object and returns the exit code', async () => {
    const {readers} = fake({
      'hb-a': {labels: ['continued-by:hb-b', `sid:${sid(1)}`]},
      'hb-b': {labels: ['continues:hb-a', 'handed-off', `sid:${sid(2)}`]},
    });
    const printed: string[] = [];
    const capture = captureWriteStdout((text) => printed.push(text));
    let code: number;
    try {
      code = await runThreadFocus({
        dryRun: true,
        json: true,
        readers,
        target: 'hb-a',
      });
    } finally {
      capture.mockRestore();
    }
    expect(code).toBe(3);
    const json = JSON.parse(printed.join('\n')) as {
      chain: string[];
      exitCode: number;
      kind: string;
    };
    expect(json.kind).toBe('refused');
    expect(json.exitCode).toBe(3);
    expect(json.chain).toEqual(['hb-a', 'hb-b']);
  });
});

// home-base-9uzxw.5 F9: every refusal carries its own code in --json, so the
// dashboard decides from the code, never from the reason's words.
// NEGATIVE CONTROL (2026-11-07): with the pane `none` refusal given the code
// 'paneUnknown', the paneNone row failed (Expected "paneNone", Received
// "paneUnknown"); restored.
describe('thread focus: refusal codes (F9)', () => {
  const live = (labels: string[], notes?: string): FakeBead =>
    notes == null ? {labels} : {labels, notes};
  const chainBeads = (n: number): Record<string, FakeBead> => {
    const beads: Record<string, FakeBead> = {};
    for (let i = 0; i < n; i += 1) {
      beads[`hb-${i}`] = live([
        ...(i > 0 ? [`continues:hb-${i - 1}`] : []),
        ...(i < n - 1 ? [`continued-by:hb-${i + 1}`] : []),
        `sid:${sid(i + 1)}`,
      ]);
    }
    return beads;
  };
  const cases: [
    string,
    () => {readers: FocusReaders; target: string},
    FocusRefusal,
  ][] = [
    [
      'the sessions index cannot be read',
      () => ({
        readers: fake(
          {},
          {lookup: {[sid(1)]: {kind: 'failed', reason: 'EACCES'}}},
        ).readers,
        target: sid(1),
      }),
      'indexFailed',
    ],
    [
      'the target bead is not found',
      () => ({readers: fake({}).readers, target: 'hb-a'}),
      'beadNotFound',
    ],
    [
      'the target bead cannot be read',
      () => ({readers: fake({'hb-a': 'failed'}).readers, target: 'hb-a'}),
      'beadUnreadable',
    ],
    [
      'two continued-by: labels',
      () => ({
        readers: fake({
          'hb-a': live(['continued-by:hb-b', 'continued-by:hb-c']),
        }).readers,
        target: 'hb-a',
      }),
      'twoSuccessors',
    ],
    [
      'the reverse query fails',
      () => ({
        readers: fake(
          {'hb-a': live([`sid:${sid(1)}`])},
          {continuing: {kind: 'failed', reason: 'br exited 2'}},
        ).readers,
        target: 'hb-a',
      }),
      'reverseFailed',
    ],
    [
      'two beads continue the head',
      () => ({
        readers: fake({
          'hb-a': live([`sid:${sid(1)}`]),
          'hb-b': live(['continues:hb-a', `sid:${sid(2)}`]),
          'hb-c': live(['continues:hb-a', `sid:${sid(3)}`]),
        }).readers,
        target: 'hb-a',
      }),
      'reverseAmbiguous',
    ],
    [
      'a loop',
      () => ({
        readers: fake({
          'hb-a': live(['continued-by:hb-b', `sid:${sid(1)}`]),
          'hb-b': live(['continued-by:hb-a', `sid:${sid(2)}`]),
        }).readers,
        target: 'hb-a',
      }),
      'loop',
    ],
    [
      'a chain past the limit',
      () => ({
        readers: fake(chainBeads(CHAIN_WALK_LIMIT + 2)).readers,
        target: 'hb-0',
      }),
      'chainTooLong',
    ],
    [
      'a successor that is not found',
      () => ({
        readers: fake({'hb-a': live(['continued-by:hb-gone'])}).readers,
        target: 'hb-a',
      }),
      'successorMissing',
    ],
    [
      'a successor that cannot be read',
      () => ({
        readers: fake({
          'hb-a': live(['continued-by:hb-b']),
          'hb-b': 'failed',
        }).readers,
        target: 'hb-a',
      }),
      'successorUnreadable',
    ],
    [
      'handed off, no successor linked',
      () => ({
        readers: fake({'hb-a': live(['handed-off', `sid:${sid(1)}`])}).readers,
        target: 'hb-a',
      }),
      'handedOffUnlinked',
    ],
    [
      'a refused handoff',
      () => ({
        readers: fake({
          'hb-a': live(
            ['handoff-refused', `sid:${sid(1)}`],
            '- 2026-11-07 14:00: handoff refused: too-many-sessions — 9 open',
          ),
        }).readers,
        target: 'hb-a',
      }),
      'handoffStopped',
    ],
    [
      'pickup records cannot be read',
      () => ({
        readers: fake(
          {'hb-a': live([`sid:${sid(1)}`])},
          {pickups: {kind: 'failed', reason: 'x.json is not JSON'}},
        ).readers,
        target: 'hb-a',
      }),
      'pickupsUnreadable',
    ],
    [
      "a successor's pickup failed",
      () => ({
        readers: fake(
          {'hb-a': live([`sid:${sid(1)}`])},
          {
            pickups: {
              failures: [
                {predecessorBeadId: 'hb-a', reason: 'x', sessionId: sid(9)},
              ],
              kind: 'read',
            },
          },
        ).readers,
        target: 'hb-a',
      }),
      'pickupFailed',
    ],
    [
      'no sid: label',
      () => ({readers: fake({'hb-a': live([])}).readers, target: 'hb-a'}),
      'sidMissing',
    ],
    [
      'two sid: labels',
      () => ({
        readers: fake({'hb-a': live([`sid:${sid(1)}`, `sid:${sid(2)}`])})
          .readers,
        target: 'hb-a',
      }),
      'sidAmbiguous',
    ],
    [
      'the pane lookup throws',
      () => {
        const {readers} = fake({'hb-a': live([`sid:${sid(1)}`])});
        return {
          readers: {
            ...readers,
            pane: () => Promise.reject(new Error('lsof crashed')),
          },
          target: 'hb-a',
        };
      },
      'paneLookupFailed',
    ],
    [
      'no live pane',
      () => ({
        readers: fake({'hb-a': live([`sid:${sid(1)}`])}, {pane: {kind: 'none'}})
          .readers,
        target: 'hb-a',
      }),
      'paneNone',
    ],
    [
      'an unknown pane',
      () => ({
        readers: fake(
          {'hb-a': live([`sid:${sid(1)}`])},
          {pane: {kind: 'unknown', reason: 'ps refused', recorded: null}},
        ).readers,
        target: 'hb-a',
      }),
      'paneUnknown',
    ],
  ];

  test('the table covers every code once', () => {
    expect(cases.map(([, , code]) => code).sort()).toEqual(
      [...FOCUS_REFUSALS].sort(),
    );
  });

  for (const [name, setup, code] of cases) {
    test(`${name}: refusal ${code}`, async () => {
      const {readers, target} = setup();
      const json = focusJsonOf(await resolveFocus(target, readers, dry));
      expect(json.kind).toBe('refused');
      expect(json.refusal).toBe(code);
    });
  }

  test('anything but a refusal has refusal null', async () => {
    const {readers} = fake({'hb-a': live([`sid:${sid(1)}`])});
    expect(
      focusJsonOf(await resolveFocus('hb-a', readers, dry)).refusal,
    ).toBeNull();
    expect(
      focusJsonOf(await resolveFocus('not a target', readers, dry)).refusal,
    ).toBeNull();
  });
});

// home-base-9uzxw.5 F10: what the dashboard's y re-read refuses on.
describe('handedOffSignOf (F10)', () => {
  test('continued-by:, handed-off and the note line each count; nothing else does', () => {
    expect(
      handedOffSignOf({labels: ['continued-by:hb-b', 'sid:x'], notes: null}),
    ).toBe('continued-by:hb-b');
    expect(handedOffSignOf({labels: ['handed-off'], notes: null})).toBe(
      'handed-off',
    );
    expect(
      handedOffSignOf({
        labels: [],
        notes: '- 2026-11-07 14:00: handed off — next: the pull preflight',
      }),
    ).toBe('a "handed off" note');
    expect(
      handedOffSignOf({
        labels: ['continues:hb-a', 'sid:x'],
        notes: '- 2026-11-07: answered',
      }),
    ).toBeNull();
  });
});
