/**
 * `thread inbox --json`'s `flags` field (home-base-kwand.18, carried from
 * home-base-kwand.5; epic home-base-kwand D4): readInbox's post-pass gives
 * every row with a loaded session bead the union of its chain's `mark:` labels.
 * Real br in a $TMPDIR world, as the other readInbox tests (readInbox takes no
 * fake for beads): the star is the D4 label `mark:2b50`, written with br, so
 * this reads what thread star writes without running it.
 *
 * Two chains, each an older and a newer session linked ONLY by the newer one's
 * `continues:` label, so each direction of the chain walk is needed:
 *
 * - Chain 1, the OLDER session starred: the newer row has ⭐ only by following
 *   its own `continues:` label.
 * - Chain 2, the NEWER session starred: the older row has ⭐ only through the
 *   post-pass's map of which beads continue which (`continuingOf`).
 * - A lone session with no `mark:` label: an empty set, not null and not ⭐.
 *
 * NEGATIVE CONTROLS (run 2026-11-18, each restored after; recorded in
 * home-base-kwand.18's notes): see the notes for each break of the post-pass
 * and the assertion that failed on it.
 */

import type {Sandbox} from './sandbox';

import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import {mkdirSync, writeFileSync} from 'fs';
import {join} from 'path';

import {brUpdate, runBr} from '../src/beads/br';
import {ensureSessionBead} from '../src/thread/session-bead';
import {inboxJson, readInbox} from '../src/thread/session-inbox';
import {initRepo} from './git-fixtures';
import {needBr} from './pinned-br';
import {createSandbox} from './sandbox';

const NOW = new Date('2030-01-01T12:00:00.000Z');
const STAR_LABEL = 'mark:2b50';

function sid(n: number): string {
  return `f1a90000-1111-4222-8333-${String(n).padStart(12, '0')}`;
}

const CHAIN1_OLDER = sid(1);
const CHAIN1_NEWER = sid(2);
const CHAIN2_OLDER = sid(3);
const CHAIN2_NEWER = sid(4);
const LONE = sid(5);

/** The `flags` field as `thread inbox --json` prints it. */
interface FlagsJson {
  emoji: string[];
  labels: string[];
  problems: string[];
  undecodable: {label: string; reason: string}[];
}

const EMPTY: FlagsJson = {emoji: [], labels: [], problems: [], undecodable: []};
const STARRED: FlagsJson = {
  emoji: ['⭐'],
  labels: [STAR_LABEL],
  problems: [],
  undecodable: [],
};

let sb: Sandbox;
let repo: string;
let env: Record<string, string | undefined>;
const beadOf: Record<string, string> = {};

/** The session bead for `sessionId`, filed at `at`. */
function sessionBead(sessionId: string, at: string, title: string): string {
  const filed = ensureSessionBead({
    cwd: repo,
    env: {...env, CLAUDE_CODE_SESSION_ID: sessionId},
    firstPrompt: {at, text: title},
    now: new Date(at),
    sessionId,
  });
  if (filed.kind !== 'created') throw new Error(filed.detail);
  beadOf[sessionId] = filed.beadId;
  return filed.beadId;
}

function addLabels(beadId: string, labels: string[]): void {
  const written = brUpdate({cwd: repo}, beadId, {addLabels: labels});
  if (written.kind !== 'ok') throw new Error(`br update ${beadId} failed`);
}

beforeAll(() => {
  needBr();
  sb = createSandbox();
  const xdg = join(sb.path, 'xdg');
  mkdirSync(join(xdg, 'justin-sdk'), {recursive: true});
  writeFileSync(
    join(xdg, 'justin-sdk', 'config.json'),
    JSON.stringify({
      componentConfig: {thread: {enabled: true, sessionBeads: true}},
    }),
  );
  env = {
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CMUX_SURFACE_ID: undefined,
    CMUX_WORKSPACE_ID: undefined,
    HOME: join(sb.path, 'home'),
    JUSTIN_SDK_HEALTH_NOTICES: 'off',
    JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state'),
    JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(sb.path, 'projects'),
    XDG_CONFIG_HOME: xdg,
  };
  repo = initRepo(sb, 'flags-repo', {'README.md': '# r\n'});
  const init = runBr(repo, ['init', '--prefix', 't', '-q']);
  if (!init.ok) throw new Error(`br init failed: ${init.reason ?? '?'}`);

  const c1Older = sessionBead(
    CHAIN1_OLDER,
    '2030-01-01T08:00:00.000Z',
    'Chain one, first session',
  );
  const c1Newer = sessionBead(
    CHAIN1_NEWER,
    '2030-01-01T09:00:00.000Z',
    'Chain one, second session',
  );
  const c2Older = sessionBead(
    CHAIN2_OLDER,
    '2030-01-01T10:00:00.000Z',
    'Chain two, first session',
  );
  const c2Newer = sessionBead(
    CHAIN2_NEWER,
    '2030-01-01T11:00:00.000Z',
    'Chain two, second session',
  );
  sessionBead(LONE, '2030-01-01T11:30:00.000Z', 'A lone session');

  // Each chain is linked by the newer bead's `continues:` label alone.
  addLabels(c1Older, [STAR_LABEL]);
  addLabels(c1Newer, [`continues:${c1Older}`]);
  addLabels(c2Newer, [`continues:${c2Older}`, STAR_LABEL]);
  // Five real br session beads; bun's 5 s hook default is too tight on a
  // busy machine (thread-session-inbox.test.ts measured 14 s for nine).
}, 120_000);

afterAll(() => {
  sb.cleanup();
});

/** Each session's `flags` field from one readInbox, through inboxJson. */
async function flagsBySession(): Promise<Map<string, FlagsJson | null>> {
  const inbox = await readInbox({
    cwd: repo,
    days: 30,
    env,
    now: NOW,
    repo: null,
  });
  if (inbox.kind !== 'read') throw new Error(inbox.reason);
  // Through JSON, as `thread inbox --json` prints it.
  const json = JSON.parse(JSON.stringify(inboxJson(inbox.read))) as {
    sessions: {flags: FlagsJson | null; sessionId: string}[];
  };
  return new Map(json.sessions.map((s) => [s.sessionId, s.flags]));
}

describe('thread inbox --json: flags (home-base-kwand.18)', () => {
  test('the setup holds: the star and the link are where the test says', () => {
    const labels = (id: string): string[] => {
      const shown = runBr(repo, ['show', beadOf[id] ?? '?', '--json']);
      if (!shown.ok) throw new Error(`br show failed: ${shown.reason ?? '?'}`);
      const [record] = JSON.parse(shown.stdout) as {labels?: string[]}[];
      return record?.labels ?? [];
    };
    expect(labels(CHAIN1_OLDER)).toContain(STAR_LABEL);
    expect(labels(CHAIN1_NEWER)).not.toContain(STAR_LABEL);
    expect(labels(CHAIN2_OLDER)).not.toContain(STAR_LABEL);
    expect(labels(CHAIN2_NEWER)).toContain(STAR_LABEL);
    // No older bead names its successor: only `continues:` links each chain.
    for (const id of [CHAIN1_OLDER, CHAIN2_OLDER]) {
      expect(labels(id).filter((l) => l.startsWith('continued-by:'))).toEqual(
        [],
      );
    }
  });

  test('every session of a starred chain carries ⭐; the lone session an empty set', async () => {
    const flags = await flagsBySession();
    expect({
      chain1Newer: flags.get(CHAIN1_NEWER),
      chain1Older: flags.get(CHAIN1_OLDER),
      chain2Newer: flags.get(CHAIN2_NEWER),
      chain2Older: flags.get(CHAIN2_OLDER),
      lone: flags.get(LONE),
    }).toEqual({
      // Its `continues:` label, followed to the starred older bead.
      chain1Newer: STARRED,
      // Its own label.
      chain1Older: STARRED,
      // Its own label.
      chain2Newer: STARRED,
      // No label of its own names the newer bead: only the beads that
      // continue it, which the post-pass maps from every loaded bead.
      chain2Older: STARRED,
      // A loaded session bead with no `mark:` label: checked, and none.
      lone: EMPTY,
    });
  });
});
