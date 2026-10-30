/**
 * The spawn link (request home-base-ys9t7.5 D8, home-base-ys9t7.5.4 item 3),
 * end to end over a REAL br: the capture child of a session `thread spawn`
 * started (its environment carries JUSTIN_SDK_SPAWNED_BY_SESSION and
 * JUSTIN_SDK_SPAWN_KICKOFF) files its session bead with `spawned-by:<parent>`
 * and `spawn-kickoff`, writes `spawned:<child>` on the parent, and
 * quota-group.ts resolves the two into one group from either end. A child
 * whose parent has no bead is filed unlinked and is its own group.
 */

import type {ChainBeadRead} from '../src/thread/handoff-chain';
import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, test} from 'bun:test';
import {mkdirSync, writeFileSync} from 'fs';
import {join} from 'path';

import {brShow, runBr} from '../src/beads/br';
import {resolveQuotaGroup} from '../src/thread/quota-group';
import {
  ensureSessionBead,
  SPAWN_KICKOFF_LABEL,
} from '../src/thread/session-bead';
import {initRepo} from './git-fixtures';
import {needBr} from './pinned-br';
import {createSandbox} from './sandbox';

const PARENT = '5e551011-aaaa-4bbb-8ccc-0123456789ab';
const CHILD = '0babe000-1111-4222-8333-444455556666';

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

interface World {
  env: Record<string, string | undefined>;
  root: string;
}

function world(): World {
  const sb = createSandbox();
  sandboxes.push(sb);
  const root = initRepo(sb, 'repo', {'README.md': '# repo\n'});
  const init = runBr(root, ['init', '--prefix', 't', '-q']);
  if (!init.ok) throw new Error(`br init failed: ${init.reason ?? '?'}`);
  const xdg = join(sb.path, 'xdg');
  mkdirSync(join(xdg, 'justin-sdk'), {recursive: true});
  writeFileSync(
    join(xdg, 'justin-sdk', 'config.json'),
    JSON.stringify({
      componentConfig: {thread: {enabled: true, sessionBeads: true}},
    }),
  );
  return {
    env: {
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CMUX_SURFACE_ID: undefined,
      CMUX_WORKSPACE_ID: undefined,
      JUSTIN_SDK_HEALTH_NOTICES: 'off',
      JUSTIN_SDK_SPAWNED_BY_SESSION: undefined,
      JUSTIN_SDK_SPAWN_KICKOFF: undefined,
      JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state'),
      JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(sb.path, 'no-transcripts'),
      XDG_CONFIG_HOME: xdg,
    },
    root,
  };
}

/** File a session bead the way the capture child does. */
function file(w: World, sessionId: string, env: World['env']) {
  return ensureSessionBead({
    cwd: w.root,
    env,
    firstPrompt: {at: '2026-10-30T09:00:00.000Z', text: '/conductor go'},
    now: new Date('2026-10-30T09:00:01.000Z'),
    sessionId,
  });
}

/** quota-group.ts's bead reader, over the real DB. */
function showBead(w: World): (beadId: string) => ChainBeadRead {
  return (beadId) => {
    const shown = brShow({cwd: w.root}, beadId);
    if (shown.kind === 'ok') {
      return {kind: 'found', labels: shown.issue.labels};
    }
    return {
      kind: shown.kind === 'notFound' ? 'notFound' : 'failed',
      reason: 'not readable',
    };
  };
}

function labelsOf(w: World, beadId: string): readonly string[] {
  const shown = brShow({cwd: w.root}, beadId);
  if (shown.kind !== 'ok') throw new Error(`br show ${beadId} failed`);
  return shown.issue.labels;
}

describe('the spawn link, over a real br', () => {
  test("a spawned child is linked both ways and resolves into its parent's group from either end", () => {
    needBr();
    const w = world();
    const parent = file(w, PARENT, w.env);
    if (parent.kind !== 'created') throw new Error(parent.detail);
    const child = file(w, CHILD, {
      ...w.env,
      JUSTIN_SDK_SPAWNED_BY_SESSION: PARENT,
      JUSTIN_SDK_SPAWN_KICKOFF: '1',
    });
    if (child.kind !== 'created') throw new Error(child.detail);
    expect(child.detail).toContain(`spawned by ${parent.beadId}`);

    expect(labelsOf(w, child.beadId)).toContain(`spawned-by:${parent.beadId}`);
    expect(labelsOf(w, child.beadId)).toContain(SPAWN_KICKOFF_LABEL);
    expect(labelsOf(w, parent.beadId)).toContain(`spawned:${child.beadId}`);
    expect(labelsOf(w, parent.beadId)).not.toContain(SPAWN_KICKOFF_LABEL);

    for (const start of [parent.beadId, child.beadId]) {
      const group = resolveQuotaGroup(start, showBead(w));
      expect(group.kind).toBe('resolved');
      if (group.kind !== 'resolved') continue;
      expect(group.root).toBe(parent.beadId);
      expect(
        group.members
          .map((m) => `${m.sessionId}:${String(m.spawnKickoff)}`)
          .sort(),
      ).toEqual([`${CHILD}:true`, `${PARENT}:false`].sort());
    }
  });

  test('the missing link: a parent with no session bead leaves the child unlinked, its own group, kickoff still marked', () => {
    needBr();
    const w = world();
    const child = file(w, CHILD, {
      ...w.env,
      JUSTIN_SDK_SPAWNED_BY_SESSION: PARENT,
      JUSTIN_SDK_SPAWN_KICKOFF: '1',
    });
    if (child.kind !== 'created') throw new Error(child.detail);
    expect(child.detail).toContain(`not linked: the parent session ${PARENT}`);
    const labels = labelsOf(w, child.beadId);
    expect(labels.some((l) => l.startsWith('spawned-by:'))).toBe(false);
    expect(labels).toContain(SPAWN_KICKOFF_LABEL);

    const group = resolveQuotaGroup(child.beadId, showBead(w));
    expect(group.kind).toBe('resolved');
    expect(group.members).toEqual([
      {beadId: child.beadId, sessionId: CHILD, spawnKickoff: true},
    ]);
  });

  test('a session that was not spawned gets neither label', () => {
    needBr();
    const w = world();
    const made = file(w, PARENT, w.env);
    if (made.kind !== 'created') throw new Error(made.detail);
    const labels = labelsOf(w, made.beadId);
    expect(labels.some((l) => l.startsWith('spawned'))).toBe(false);
    expect(labels).not.toContain(SPAWN_KICKOFF_LABEL);
  });
});
