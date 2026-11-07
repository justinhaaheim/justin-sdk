/**
 * `thread mark --mayor` (home-base-6n7my.2.2, D7 in the design field of
 * home-base-6n7my.2).
 *
 * Every test here passes its own env with its own session id. The suite may run
 * inside a Claude Code session, whose CLAUDE_CODE_SESSION_ID is a real session:
 * nothing here may reach it.
 */

import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, setDefaultTimeout, test} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';

import {brShow, brUpdate, findBeadsWorkspace, runBr} from '../src/beads/br';
import {
  describeMarkMayor,
  markMayor,
  type MarkMayorOutcome,
} from '../src/thread/mark-mayor';
import {ensureSessionBead, MAYOR_ROLE_LABEL} from '../src/thread/session-bead';
import {initRepo} from './git-fixtures';
import {needBr} from './pinned-br';
import {createSandbox} from './sandbox';

setDefaultTimeout(120_000);

const SESSION = '0a000000-1111-4222-8333-0000000000a1';
const NO_BEAD = '0f000000-1111-4222-8333-0000000000f1';
const CLI = resolve(import.meta.dirname, '../src/cli.ts');

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

interface World {
  beadId: string;
  db: string;
  env: Record<string, string | undefined>;
  repo: string;
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
  const env: Record<string, string | undefined> = {
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SESSION_ID: SESSION,
    HOME: join(sb.path, 'home'),
    JUSTIN_SDK_HEALTH_NOTICES: 'off',
    JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state'),
    JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(sb.path, 'projects'),
    PATH: process.env.PATH,
    XDG_CONFIG_HOME: xdg,
  };
  const repo = initRepo(sb, 'mark-repo', {'README.md': '# m\n'});
  const init = runBr(repo, ['init', '--prefix', 't', '-q']);
  if (!init.ok) throw new Error(`br init failed: ${init.reason ?? '?'}`);
  const space = findBeadsWorkspace(repo);
  if (space.kind !== 'found') throw new Error(space.reason);
  const filed = ensureSessionBead({
    cwd: repo,
    env,
    firstPrompt: {at: '2030-01-01T09:00:00.000Z', text: 'be the mayor'},
    now: new Date('2030-01-01T09:00:00.000Z'),
    sessionId: SESSION,
  });
  if (filed.kind !== 'created') throw new Error(filed.detail);
  return {beadId: filed.beadId, db: space.db, env, repo};
}

function bead(w: World): {labels: string[]; updatedAt: null | string} {
  const shown = brShow({db: w.db, env: w.env}, w.beadId);
  if (shown.kind !== 'ok') throw new Error('the bead could not be read');
  return {labels: shown.issue.labels, updatedAt: shown.issue.updatedAt};
}

function mayorLabels(w: World): string[] {
  return bead(w).labels.filter((label) => label === MAYOR_ROLE_LABEL);
}

function run(
  w: World,
  more: {env?: Record<string, string | undefined>; hookPayload?: string} = {},
): Promise<MarkMayorOutcome> {
  return markMayor({
    cwd: w.repo,
    env: more.env ?? w.env,
    followUp: () => Promise.resolve(null),
    ...(more.hookPayload !== undefined ? {hookPayload: more.hookPayload} : {}),
  });
}

describe('thread mark --mayor', () => {
  test('adds the label once, and says so', async () => {
    const w = world();
    expect(mayorLabels(w)).toEqual([]);
    const outcome = await run(w);
    expect(outcome).toEqual({
      beadId: w.beadId,
      kind: 'marked',
      workspaceNote: null,
    });
    expect(mayorLabels(w)).toEqual([MAYOR_ROLE_LABEL]);
    expect(describeMarkMayor(outcome)).toEqual({
      exitCode: 0,
      lines: [
        `session ${w.beadId} is now a mayor session: labelled ${MAYOR_ROLE_LABEL}`,
      ],
    });
  });

  test('a second run changes nothing, and makes no write', async () => {
    const w = world();
    let writes = 0;
    const update: typeof brUpdate = (...args) => {
      writes += 1;
      return brUpdate(...args);
    };
    const counted = {
      cwd: w.repo,
      env: w.env,
      followUp: () => Promise.resolve(null),
      update,
    };
    await markMayor(counted);
    expect(writes).toBe(1);
    const before = bead(w);
    const outcome = await markMayor(counted);
    expect(outcome.kind).toBe('already');
    expect(writes).toBe(1);
    expect(bead(w)).toEqual(before);
    expect(describeMarkMayor(outcome).lines[0]).toContain('nothing written');
  });

  test('runs the workspace name follow-up for this session, on both runs', async () => {
    const w = world();
    const seen: string[] = [];
    const followUp = (input: {sessionId: string}) => {
      seen.push(input.sessionId);
      return Promise.resolve('renamed workspace');
    };
    const first = await markMayor({cwd: w.repo, env: w.env, followUp});
    await markMayor({cwd: w.repo, env: w.env, followUp});
    expect(seen).toEqual([SESSION, SESSION]);
    expect(describeMarkMayor(first).lines[1]).toBe('  renamed workspace');
  });

  test('the follow-up reads the label: it sees the mark it must show', async () => {
    const w = world();
    let labels: string[] = [];
    await markMayor({
      cwd: w.repo,
      env: w.env,
      followUp: () => {
        labels = bead(w).labels;
        return Promise.resolve(null);
      },
    });
    expect(labels).toContain(MAYOR_ROLE_LABEL);
  });

  test('no session bead: exit 1, says why, and never claims success', async () => {
    const w = world();
    const outcome = await run(w, {
      env: {...w.env, CLAUDE_CODE_SESSION_ID: NO_BEAD},
    });
    expect(outcome.kind).toBe('noBead');
    const {exitCode, lines} = describeMarkMayor(outcome);
    expect(exitCode).toBe(1);
    expect(lines.join('\n')).toContain('NOT marked');
    expect(lines.join('\n')).toContain('no session bead yet');
    expect(lines.join('\n')).not.toContain('is now a mayor session');
    expect(mayorLabels(w)).toEqual([]);
  });

  test('no session id at all: exit 1, and nothing is marked', async () => {
    const w = world();
    const outcome = await run(w, {
      env: {...w.env, CLAUDE_CODE_SESSION_ID: undefined},
    });
    expect(describeMarkMayor(outcome).exitCode).toBe(1);
    expect(mayorLabels(w)).toEqual([]);
  });

  test('a br that cannot run is exit 1, not a success', async () => {
    const w = world();
    const failed = await run(w, {env: {...w.env, PATH: '/nowhere'}});
    expect(describeMarkMayor(failed).exitCode).toBe(1);
    expect(mayorLabels(w)).toEqual([]);
  });
});

describe('thread mark --mayor --hook', () => {
  const OTHER = '0b000000-1111-4222-8333-0000000000b1';

  test('a payload with agent_id writes nothing, and exits 0', async () => {
    const w = world();
    const before = bead(w);
    const outcome = await run(w, {
      hookPayload: JSON.stringify({agent_id: 'a123', session_id: SESSION}),
    });
    expect(outcome).toEqual({agentId: 'a123', kind: 'subagent'});
    expect(bead(w)).toEqual(before);
    expect(describeMarkMayor(outcome).exitCode).toBe(0);
  });

  test('a payload with no agent_id marks the session it names', async () => {
    const w = world();
    const outcome = await run(w, {
      hookPayload: JSON.stringify({session_id: SESSION}),
    });
    expect(outcome.kind).toBe('marked');
    expect(mayorLabels(w)).toEqual([MAYOR_ROLE_LABEL]);
  });

  test('a repeat from a hook skips the name follow-up, as it runs at every Stop', async () => {
    const w = world();
    let calls = 0;
    const followUp = () => {
      calls += 1;
      return Promise.resolve(null);
    };
    const hookPayload = JSON.stringify({session_id: SESSION});
    await markMayor({cwd: w.repo, env: w.env, followUp, hookPayload});
    expect(calls).toBe(1);
    const again = await markMayor({
      cwd: w.repo,
      env: w.env,
      followUp,
      hookPayload,
    });
    expect(again.kind).toBe('already');
    expect(calls).toBe(1);
  });

  test('the session comes from the payload, never the environment', async () => {
    const w = world();
    const outcome = await run(w, {
      env: {...w.env, CLAUDE_CODE_SESSION_ID: OTHER},
      hookPayload: JSON.stringify({session_id: SESSION}),
    });
    expect(outcome.kind).toBe('marked');
    expect(mayorLabels(w)).toEqual([MAYOR_ROLE_LABEL]);
  });

  test.each([
    ['not JSON', 'not json'],
    ['empty', ''],
    ['an array', '[]'],
    ['no session_id', '{}'],
    ['a blank agent_id and no session_id', '{"agent_id":"  "}'],
  ])(
    'a payload that is %s marks nothing, even with a session in the environment',
    async (_name, hookPayload) => {
      const w = world();
      const outcome = await run(w, {hookPayload});
      expect(describeMarkMayor(outcome).exitCode).toBe(1);
      expect(mayorLabels(w)).toEqual([]);
    },
  );
});

describe('thread mark on the command line', () => {
  function cli(w: World, args: string[], input = '') {
    return spawnSync('bun', [CLI, 'thread', 'mark', ...args], {
      cwd: w.repo,
      encoding: 'utf8',
      env: w.env as NodeJS.ProcessEnv,
      input,
    });
  }

  test('--help does nothing else', () => {
    const w = world();
    const help = cli(w, ['--mayor', '--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('--mayor');
    expect(mayorLabels(w)).toEqual([]);
  });

  test('with no mark named it refuses, with exit 2, and writes nothing', () => {
    const w = world();
    const bare = cli(w, []);
    expect(bare.status).toBe(2);
    expect(bare.stderr).toContain('--mayor is the only one');
    expect(mayorLabels(w)).toEqual([]);
  });

  test('--mayor marks, and a second run exits 0', () => {
    const w = world();
    const first = cli(w, ['--mayor']);
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('is now a mayor session');
    expect(mayorLabels(w)).toEqual([MAYOR_ROLE_LABEL]);
    const second = cli(w, ['--mayor']);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('already a mayor session');
  });

  test('--hook reads stdin: a subagent writes nothing', () => {
    const w = world();
    const hooked = cli(
      w,
      ['--mayor', '--hook'],
      JSON.stringify({agent_id: 'a1', session_id: SESSION}),
    );
    expect(hooked.status).toBe(0);
    expect(mayorLabels(w)).toEqual([]);
  });

  test('--hook with no bead exits 1, not 2, so a Stop hook cannot block the turn', () => {
    const w = world();
    const hooked = cli(
      w,
      ['--mayor', '--hook'],
      JSON.stringify({session_id: NO_BEAD}),
    );
    expect(hooked.status).toBe(1);
    expect(hooked.stderr).toContain('no session bead yet');
  });
});
