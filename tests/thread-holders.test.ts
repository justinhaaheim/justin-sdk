/**
 * `thread holders <bead>` (home-base-5uu56.2.3). Real br in a throwaway repo;
 * every state file under a temp JUSTIN_THREADS_STATE_DIR.
 */

import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, test} from 'bun:test';
import {mkdirSync, writeFileSync} from 'fs';
import {join} from 'path';

import {runBr} from '../src/beads/br';
import {describeHolders, findHolders} from '../src/thread/holders';
import {fileRequest} from '../src/thread/request';
import {ensureSessionBead} from '../src/thread/session-bead';
import {checkKickoffHolders} from '../src/thread/spawn-holders';
import {initRepo} from './git-fixtures';
import {needBr} from './pinned-br';
import {createSandbox} from './sandbox';

const SESSION = '401de125-aaaa-4bbb-8ccc-0123456789ab';
const OTHER = '401de125-2222-4bbb-8ccc-0123456789ab';

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

interface World {
  db: string;
  env: Record<string, string | undefined>;
  repo: string;
  sessionBeadId: string;
}

function world(): World {
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
  const env = {
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SESSION_ID: SESSION,
    CMUX_SURFACE_ID: undefined,
    CMUX_WORKSPACE_ID: undefined,
    JUSTIN_SDK_HEALTH_NOTICES: 'off',
    JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state'),
    JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(sb.path, 'no-transcripts'),
    XDG_CONFIG_HOME: xdg,
  };
  const repo = initRepo(sb, 'holders-repo', {'README.md': '# holders\n'});
  const init = runBr(repo, ['init', '--prefix', 't', '-q']);
  if (!init.ok) throw new Error(`br init failed: ${init.reason ?? '?'}`);
  const filed = ensureSessionBead({
    cwd: repo,
    env,
    firstPrompt: {at: '2026-11-08T09:00:00.000Z', text: 'Fix the throttling'},
    now: new Date('2026-11-08T09:00:01.000Z'),
    sessionId: SESSION,
  });
  if (filed.kind !== 'created') throw new Error(filed.kind);
  return {
    db: join(repo, '.beads', 'beads.db'),
    env,
    repo,
    sessionBeadId: filed.beadId,
  };
}

async function fileOne(w: World, title: string): Promise<string> {
  const outcome = await fileRequest({
    bead: null,
    cmux: () =>
      Promise.resolve({kind: 'failed', reason: 'no cmux', timedOut: false}),
    continues: null,
    cwd: w.repo,
    doneWhen: null,
    env: w.env,
    here: false,
    overarching: false,
    sessionId: null,
    title,
  });
  if (outcome.kind !== 'filed') throw new Error(JSON.stringify(outcome));
  return outcome.id;
}

describe('thread holders', () => {
  test('a request names the session that holds it, with its status and stages', async () => {
    const w = world();
    const id = await fileOne(w, 'Fix the Brave throttling');
    const staged = runBr(w.repo, [
      'update',
      id,
      '--add-label',
      'stage:code-done',
    ]);
    if (!staged.ok) throw new Error(staged.reason ?? 'br update failed');

    const outcome = await findHolders({
      beadId: id,
      cwd: w.repo,
      db: null,
      env: w.env,
    });
    expect(outcome).toMatchObject({
      bead: {id, isRequest: true, stages: ['code-done']},
      holders: [
        {
          problem: null,
          sessionBeadId: w.sessionBeadId,
          sessionId: SESSION,
          thisSession: true,
        },
      ],
      kind: 'found',
    });
    const {exitCode, lines} = describeHolders(outcome);
    expect(exitCode).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('Held by 1 session:');
    expect(text).toContain('← this session');
    expect(text).toContain(`resume:   claude --resume ${SESSION}`);

    // Run as another session: the same holder, no longer "this session".
    const asOther = await findHolders({
      beadId: id,
      cwd: w.repo,
      db: null,
      env: {...w.env, CLAUDE_CODE_SESSION_ID: OTHER},
    });
    expect(asOther).toMatchObject({holders: [{thisSession: false}]});
  });

  test('a bead with no sid: label is held by nobody, and says so', async () => {
    const w = world();
    const created = runBr(w.repo, ['create', 'Loose task', '--silent']);
    if (!created.ok) throw new Error(created.reason ?? 'br create failed');
    const id = created.stdout.trim();
    const outcome = await findHolders({
      beadId: id,
      cwd: w.repo,
      db: null,
      env: w.env,
    });
    expect(outcome).toMatchObject({holders: [], kind: 'found'});
    expect(describeHolders(outcome).lines.join('\n')).toContain(
      'No session holds it',
    );
  });

  test('an unknown bead is not found (exit 2), naming where it looked', async () => {
    const w = world();
    const outcome = await findHolders({
      beadId: 't-nope',
      cwd: w.repo,
      db: w.db,
      env: w.env,
    });
    expect(outcome).toEqual({kind: 'notFound', searched: [w.db]});
    expect(describeHolders(outcome).exitCode).toBe(2);
  });

  test('a DB that cannot be read is a failure, never "not found" (rule 7)', async () => {
    const w = world();
    const missing = join(w.repo, 'no-such', 'beads.db');
    const outcome = await findHolders({
      beadId: 't-nope',
      cwd: w.repo,
      db: missing,
      env: w.env,
    });
    expect(outcome.kind).toBe('failed');
    expect(describeHolders(outcome).exitCode).toBe(1);
  });
});

describe('checkKickoffHolders, the spawn gate’s check (home-base-5uu56.2.4)', () => {
  test('a kickoff naming a request another session holds is held; the caller’s own is clear', async () => {
    const w = world();
    const id = await fileOne(w, 'Fix the Brave throttling');
    const kickoff = `Build ${id} and its acceptance criteria. Also see t-nothere.`;

    const fromOther = await checkKickoffHolders({
      cwd: w.repo,
      dir: w.repo,
      env: {...w.env, CLAUDE_CODE_SESSION_ID: OTHER},
      kickoff,
    });
    expect(fromOther.kind).toBe('held');
    if (fromOther.kind === 'held') {
      expect(fromOther.lines.join('\n')).toContain(id);
    }

    // Control: the session that holds it may start one for its own work.
    const fromHolder = await checkKickoffHolders({
      cwd: w.repo,
      dir: w.repo,
      env: w.env,
      kickoff,
    });
    expect(fromHolder).toEqual({kind: 'clear'});
  });
});
