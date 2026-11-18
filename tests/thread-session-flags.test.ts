/**
 * Justin's flags on a session: ⭐ and any other emoji, as `mark:<code points>`
 * labels (home-base-kwand.5, epic home-base-kwand D4).
 *
 * The encoding, the chain union and the command's chain rules run against
 * fakes; star and unstar against a real br (the pinned binary) in two repos,
 * so "the bead's other labels are untouched", "undo restores the set" and "a
 * bead in another repo's database is found" are br's answers, not a fake's.
 *
 * NEGATIVE CONTROLS (run 2026-11-18, recorded in home-base-kwand.5's notes):
 * see the notes for each break and the assertion that failed on it.
 */

import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, spyOn, test} from 'bun:test';
import {mkdirSync, writeFileSync} from 'fs';
import {join} from 'path';

import {brUpdate, runBr} from '../src/beads/br';
import {readMarksUndo} from '../src/thread/marks-undo';
import {ensureSessionBead} from '../src/thread/session-bead';
import {
  chainFlagsOf,
  decodeFlagLabel,
  describeFlagOutcome,
  encodeFlag,
  type FlagBeadRead,
  type FlagDeps,
  flagSession,
  flagsOfLabels,
  STAR,
  STAR_LABEL,
} from '../src/thread/session-flags';
import {unmarkSession} from '../src/thread/session-marks';
import {initRepo} from './git-fixtures';
import {needBr} from './pinned-br';
import {createSandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
const spies: {mockRestore: () => void}[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

function quiet(): void {
  for (const method of ['log', 'error'] as const) {
    spies.push(spyOn(console, method).mockImplementation(() => undefined));
  }
}

// ---------------------------------------------------------------------------
// Encoding (D4)
// ---------------------------------------------------------------------------

describe('encodeFlag / decodeFlagLabel', () => {
  test('⭐ and ⭐️ are one label, mark:2b50, and it decodes back to ⭐', () => {
    expect(encodeFlag('⭐')).toEqual({kind: 'ok', label: 'mark:2b50'});
    expect(encodeFlag('⭐️')).toEqual({kind: 'ok', label: 'mark:2b50'});
    expect(encodeFlag(STAR)).toEqual({kind: 'ok', label: STAR_LABEL});
    const read = decodeFlagLabel('mark:2b50');
    expect(read).toEqual({emoji: '⭐', kind: 'flag', label: 'mark:2b50'});
  });

  test('a multi-code-point emoji round-trips, its U+FE0F given back where needed', () => {
    const fire = '❤️‍🔥'; // 2764 FE0F 200D 1F525
    const encoded = encodeFlag(fire);
    expect(encoded).toEqual({kind: 'ok', label: 'mark:2764-200d-1f525'});
    const read = decodeFlagLabel('mark:2764-200d-1f525');
    expect(read.kind === 'flag' ? read.emoji : null).toBe(fire);

    const family = '👨‍👩‍👧';
    const label = encodeFlag(family);
    expect(label).toEqual({
      kind: 'ok',
      label: 'mark:1f468-200d-1f469-200d-1f467',
    });
    const back = decodeFlagLabel('mark:1f468-200d-1f469-200d-1f467');
    expect(back.kind === 'flag' ? back.emoji : null).toBe(family);

    expect(encodeFlag('1️⃣')).toEqual({kind: 'ok', label: 'mark:31-20e3'});
    const keycap = decodeFlagLabel('mark:31-20e3');
    expect(keycap.kind === 'flag' ? keycap.emoji : null).toBe('1️⃣');
    // ❤ alone (text style by default) gets U+FE0F back for display.
    const heart = decodeFlagLabel('mark:2764');
    expect(heart.kind === 'flag' ? heart.emoji : null).toBe('❤️');
  });

  test('a label that does not decode is ignored and reported, never thrown', () => {
    for (const label of [
      'mark:zz',
      'mark:02b50',
      'mark:2B50',
      'mark:78',
      'mark:d800',
      'mark:2b50-fe0f',
      'mark:',
    ]) {
      const read = decodeFlagLabel(label);
      expect({kind: read.kind, label}).toEqual({kind: 'undecodable', label});
    }
    const set = flagsOfLabels([
      'session',
      'mark:2b50',
      'mark:zz',
      'mark:02b50',
      'sid:x',
    ]);
    expect(set.emoji).toEqual(['⭐']);
    expect(set.labels).toEqual(['mark:2b50']);
    expect(set.undecodable.map((entry) => entry.label)).toEqual([
      'mark:02b50',
      'mark:zz',
    ]);
    expect(set.undecodable.every((entry) => entry.reason !== '')).toBe(true);
  });

  test('plain text and an emoji too long for a br label are refused', () => {
    expect(encodeFlag('x').kind).toBe('refused');
    expect(encodeFlag('⭐⭐').kind).toBe('refused');
    expect(encodeFlag('').kind).toBe('refused');
    // 👩🏽‍❤️‍💋‍👨🏿: nine code points, past br's 50-character label limit.
    expect(encodeFlag('👩🏽‍❤️‍💋‍👨🏿').kind).toBe('refused');
  });
});

// ---------------------------------------------------------------------------
// The chain union, as the inbox reads it
// ---------------------------------------------------------------------------

describe('chainFlagsOf', () => {
  const beads = new Map<string, string[]>([
    ['a', ['session', 'continued-by:b', 'mark:2b50', 'mark:zz']],
    ['b', ['session', 'continues:a', 'continued-by:c']],
    ['c', ['session', 'continues:b', 'mark:2764']],
  ]);
  const labelsOf = (id: string) => {
    const labels = beads.get(id);
    return labels == null
      ? {kind: 'unknown' as const, reason: 'not read'}
      : {kind: 'found' as const, labels};
  };

  test('every session of a chain shows the union of its flags', () => {
    for (const startId of ['a', 'b', 'c']) {
      const flags = chainFlagsOf({continuing: () => [], labelsOf, startId});
      // Sorted by label: mark:2764 before mark:2b50.
      expect({emoji: flags.emoji, startId}).toEqual({
        emoji: ['❤️', '⭐'],
        startId,
      });
      expect(flags.undecodable.map((entry) => entry.label)).toEqual([
        'mark:zz',
      ]);
      expect(flags.problems).toEqual([]);
    }
  });

  test('a half-written link is followed through the reverse search', () => {
    const half = new Map<string, string[]>([
      ['a', ['session', 'mark:2b50']],
      ['b', ['session', 'continues:a']],
    ]);
    const flags = chainFlagsOf({
      continuing: (id) => (id === 'a' ? ['b'] : []),
      labelsOf: (id) => {
        const labels = half.get(id);
        return labels == null
          ? {kind: 'unknown', reason: 'not read'}
          : {kind: 'found', labels};
      },
      startId: 'b',
    });
    expect(flags.emoji).toEqual(['⭐']);
  });

  test('a chain session that cannot be read is named, never left out silently', () => {
    const flags = chainFlagsOf({
      continuing: () => [],
      labelsOf: (id) =>
        id === 'a'
          ? {kind: 'unknown', reason: 'not in any export'}
          : labelsOf(id),
      startId: 'c',
    });
    expect(flags.emoji).toEqual(['❤️']);
    expect(flags.problems).toEqual(['a: not in any export']);
  });
});

// ---------------------------------------------------------------------------
// The command's chain rules, against fakes
// ---------------------------------------------------------------------------

interface Fake {
  deps: FlagDeps;
  labels: Map<string, string[]>;
  updates: string[];
}

function fake(input: {
  chain?: string[] | string;
  failLocate?: string;
  labels: Record<string, string[]>;
}): Fake {
  const labels = new Map(
    Object.entries(input.labels).map(([id, list]) => [id, [...list]]),
  );
  const updates: string[] = [];
  return {
    deps: {
      chainOf: () =>
        typeof input.chain === 'string'
          ? {kind: 'failed', reason: input.chain}
          : {
              kind: 'chain',
              members: (input.chain ?? [...labels.keys()]).map((beadId) => ({
                beadId,
                sessionId: `sid-${beadId}`,
              })),
            },
      locate: (beadId): FlagBeadRead => {
        if (beadId === input.failLocate) {
          return {kind: 'failed', reason: 'br is busy'};
        }
        const found = labels.get(beadId);
        return found == null
          ? {kind: 'failed', reason: 'not found'}
          : {db: `/db/${beadId}`, kind: 'found', labels: found, title: beadId};
      },
      update: (_db, beadId, change) => {
        updates.push(
          `${beadId} +${(change.addLabels ?? []).join(',')} -${(change.removeLabels ?? []).join(',')}`,
        );
        const list = labels.get(beadId) ?? [];
        labels.set(beadId, [
          ...list.filter(
            (label) => !(change.removeLabels ?? []).includes(label),
          ),
          ...(change.addLabels ?? []),
        ]);
        return {kind: 'ok'};
      },
    },
    labels,
    updates,
  };
}

function stateEnv(): Record<string, string | undefined> {
  const sb = createSandbox();
  sandboxes.push(sb);
  return {JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state')};
}

describe('flagSession: chains (D4)', () => {
  test('starring a chain stars its newest session only', () => {
    const env = stateEnv();
    const world = fake({
      labels: {a: ['session'], b: ['session'], c: ['session', 'other']},
    });
    const outcome = flagSession({
      deps: world.deps,
      emoji: '⭐️',
      env,
      op: 'add',
      ref: 'a',
    });
    expect(outcome.kind).toBe('changed');
    expect(world.updates).toEqual(['c +mark:2b50 -']);
    expect(world.labels.get('c')).toEqual(['session', 'other', 'mark:2b50']);
    expect(world.labels.get('a')).toEqual(['session']);
  });

  test('unstarring a chain clears every session that holds the star', () => {
    const env = stateEnv();
    const world = fake({
      labels: {
        a: ['session', 'mark:2b50', 'mark:2764'],
        b: ['session'],
        c: ['session', 'mark:2b50'],
      },
    });
    const outcome = flagSession({
      deps: world.deps,
      emoji: STAR,
      env,
      op: 'remove',
      ref: 'c',
    });
    expect(outcome.kind).toBe('changed');
    expect(world.updates).toEqual(['a + -mark:2b50', 'c + -mark:2b50']);
    expect(world.labels.get('a')).toEqual(['session', 'mark:2764']);
    expect(world.labels.get('c')).toEqual(['session']);
  });

  test('a flag already there, or already gone, writes nothing and records nothing', () => {
    const env = stateEnv();
    const world = fake({labels: {a: ['session', 'mark:2b50']}});
    const added = flagSession({
      deps: world.deps,
      emoji: STAR,
      env,
      op: 'add',
      ref: 'a',
    });
    expect(added.kind).toBe('unchanged');
    const gone = fake({labels: {a: ['session']}});
    expect(
      flagSession({deps: gone.deps, emoji: STAR, env, op: 'remove', ref: 'a'})
        .kind,
    ).toBe('unchanged');
    expect([...world.updates, ...gone.updates]).toEqual([]);
    const undo = readMarksUndo(env);
    expect(undo.kind === 'read' ? undo.records : null).toEqual([]);
  });

  test('a chain that cannot be read, or one session of it, writes nothing', () => {
    const env = stateEnv();
    const broken = fake({chain: 'two successors', labels: {a: ['session']}});
    const refused = flagSession({
      deps: broken.deps,
      emoji: STAR,
      env,
      op: 'add',
      ref: 'a',
    });
    expect(refused.kind).toBe('failed');
    const busy = fake({
      failLocate: 'b',
      labels: {a: ['session', 'mark:2b50'], b: ['session', 'mark:2b50']},
    });
    const partly = flagSession({
      deps: busy.deps,
      emoji: STAR,
      env,
      op: 'remove',
      ref: 'a',
    });
    expect(partly.kind).toBe('failed');
    expect([...broken.updates, ...busy.updates]).toEqual([]);
    const undo = readMarksUndo(env);
    expect(undo.kind === 'read' ? undo.records : null).toEqual([]);
  });

  test('a bead that is not a session bead is refused', () => {
    const env = stateEnv();
    const world = fake({labels: {a: ['request']}});
    const outcome = flagSession({
      deps: world.deps,
      emoji: STAR,
      env,
      op: 'add',
      ref: 'a',
    });
    expect(outcome.kind).toBe('failed');
    expect(world.updates).toEqual([]);
  });

  test('the undo record is written before the first br write, and printed', () => {
    const env = stateEnv();
    const world = fake({labels: {a: ['session']}});
    // The undo records there were at the FIRST br write.
    let recordsAtWrite: number | null = null;
    const update = world.deps.update;
    world.deps.update = (db, beadId, change) => {
      const read = readMarksUndo(env);
      recordsAtWrite ??= read.kind === 'read' ? read.records.length : -1;
      return update(db, beadId, change);
    };
    const outcome = flagSession({
      deps: world.deps,
      emoji: STAR,
      env,
      op: 'add',
      ref: 'a',
    });
    expect(recordsAtWrite as number | null).toBe(1);
    if (outcome.kind !== 'changed') throw new Error(outcome.kind);
    const printed = describeFlagOutcome('thread star', outcome);
    expect(printed.exitCode).toBe(0);
    expect(printed.lines.at(-1)).toBe(
      `Undo: thread unmark --mark ${outcome.undoId}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Real br, two repos
// ---------------------------------------------------------------------------

interface RealWorld {
  env: Record<string, string | undefined>;
  here: string;
  other: string;
}

function realWorld(): RealWorld {
  needBr();
  const sb = createSandbox();
  sandboxes.push(sb);
  const xdg = join(sb.path, 'xdg');
  mkdirSync(join(xdg, 'justin-sdk'), {recursive: true});
  writeFileSync(
    join(xdg, 'justin-sdk', 'config.json'),
    JSON.stringify({
      componentConfig: {thread: {enabled: true, sessionBeads: true}},
    }),
  );
  const env: Record<string, string | undefined> = {
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SESSION_ID: undefined,
    CMUX_SURFACE_ID: undefined,
    CMUX_WORKSPACE_ID: undefined,
    JUSTIN_SDK_HEALTH_NOTICES: 'off',
    JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state'),
    JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(sb.path, 'no-transcripts'),
    PATH: process.env.PATH,
    XDG_CONFIG_HOME: xdg,
  };
  const here = initRepo(sb, 'here', {'README.md': '# here\n'});
  const other = initRepo(sb, 'other', {'README.md': '# other\n'});
  for (const [repo, prefix] of [
    [here, 'h'],
    [other, 'o'],
  ] as const) {
    const init = runBr(repo, ['init', '--prefix', prefix, '-q']);
    if (!init.ok) throw new Error(`br init failed: ${init.reason ?? '?'}`);
  }
  return {env, here, other};
}

function sessionBead(w: RealWorld, sessionId: string, at: string): string {
  const bead = ensureSessionBead({
    cwd: w.other,
    env: w.env,
    firstPrompt: {at, text: 'Build the thing'},
    now: new Date(at),
    sessionId,
  });
  if (bead.kind !== 'created') throw new Error(JSON.stringify(bead));
  return bead.beadId;
}

function brLabels(repo: string, id: string): string[] {
  const out = runBr(repo, ['show', id, '--json']);
  if (!out.ok) throw new Error(`br show failed: ${out.reason ?? '?'}`);
  const [record] = JSON.parse(out.stdout) as {labels?: string[]}[];
  return [...(record?.labels ?? [])].sort();
}

const OLDER = '0f1a6000-aaaa-4bbb-8ccc-0123456789ab';
const NEWER = '0f1a6001-aaaa-4bbb-8ccc-0123456789ab';

describe('thread star / unstar against real br', () => {
  test('star then unstar, from another repo, leaves every other label as it was; undo puts each back', async () => {
    quiet();
    const w = realWorld();
    const beadId = sessionBead(w, OLDER, '2026-11-18T09:00:00.000Z');
    const before = brLabels(w.other, beadId);

    // Run from `here`: the bead lives in `other`'s database.
    const star = flagSession({
      cwd: w.here,
      emoji: '⭐️',
      env: w.env,
      op: 'add',
      ref: beadId,
    });
    if (star.kind !== 'changed') throw new Error(JSON.stringify(star));
    expect(brLabels(w.other, beadId)).toEqual([...before, 'mark:2b50'].sort());

    // Undo the star: the set is as before.
    const undoStar = await unmarkSession({
      env: w.env,
      mark: star.undoId,
      session: null,
    });
    expect(undoStar.kind).toBe('unmarked');
    expect(brLabels(w.other, beadId)).toEqual(before);

    // Star again, then unstar: other labels untouched.
    const again = flagSession({
      cwd: w.here,
      emoji: STAR,
      env: w.env,
      op: 'add',
      ref: OLDER.slice(0, 8),
    });
    expect(again.kind).toBe('changed');
    const unstar = flagSession({
      cwd: w.here,
      emoji: STAR,
      env: w.env,
      op: 'remove',
      ref: beadId,
    });
    if (unstar.kind !== 'changed') throw new Error(JSON.stringify(unstar));
    expect(brLabels(w.other, beadId)).toEqual(before);

    // Undo the unstar: the star is back.
    const undoUnstar = await unmarkSession({
      env: w.env,
      mark: unstar.undoId,
      session: null,
    });
    expect(undoUnstar.kind).toBe('unmarked');
    expect(brLabels(w.other, beadId)).toEqual([...before, 'mark:2b50'].sort());
  });

  test('a real two-session chain: star hits the newest, unstar clears both', () => {
    quiet();
    const w = realWorld();
    const older = sessionBead(w, OLDER, '2026-11-18T09:00:00.000Z');
    const newer = sessionBead(w, NEWER, '2026-11-18T10:00:00.000Z');
    expect(
      brUpdate({cwd: w.other}, older, {
        addLabels: [`continued-by:${newer}`, 'mark:2b50'],
      }).kind,
    ).toBe('ok');
    expect(
      brUpdate({cwd: w.other}, newer, {addLabels: [`continues:${older}`]}).kind,
    ).toBe('ok');

    const star = flagSession({
      cwd: w.here,
      emoji: '❤️',
      env: w.env,
      op: 'add',
      ref: older,
    });
    if (star.kind !== 'changed') throw new Error(JSON.stringify(star));
    expect(star.written.map((change) => change.id)).toEqual([newer]);
    expect(brLabels(w.other, newer)).toContain('mark:2764');
    expect(brLabels(w.other, older)).not.toContain('mark:2764');

    expect(
      brUpdate({cwd: w.other}, newer, {addLabels: ['mark:2b50']}).kind,
    ).toBe('ok');
    const unstar = flagSession({
      cwd: w.here,
      emoji: STAR,
      env: w.env,
      op: 'remove',
      ref: newer,
    });
    if (unstar.kind !== 'changed') throw new Error(JSON.stringify(unstar));
    expect(unstar.written.map((change) => change.id).sort()).toEqual(
      [older, newer].sort(),
    );
    expect(brLabels(w.other, older)).not.toContain('mark:2b50');
    expect(brLabels(w.other, newer)).not.toContain('mark:2b50');
    expect(brLabels(w.other, newer)).toContain('mark:2764');
  });
});
