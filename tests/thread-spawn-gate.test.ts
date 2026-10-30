/**
 * The spawn gate (epic home-base-mbnjv C4, home-base-mbnjv.2): `thread spawn`
 * runs the handoff gate when componentConfig.thread.handoff.successor is on
 * in the repo it runs in, refuses with exit 3, and records the refusal on
 * the caller's session bead. Off, it is unchanged. Real br; cmux and the gate
 * are injected fakes, except where a test says it runs the real readers (and
 * then no cmux socket exists, so nothing is reached).
 */

import type {CmuxCall} from '../src/thread/cmux';
import type {HandoffGateResult} from '../src/thread/handoff-gate';
import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, test} from 'bun:test';
import {mkdirSync, writeFileSync} from 'fs';
import {join} from 'path';

import {brShow, runBr} from '../src/beads/br';
import {writeGuardPass} from '../src/thread/guard-pass';
import {ensureSessionBead} from '../src/thread/session-bead';
import {spawnSession} from '../src/thread/spawn';
import {SPAWN_REFUSAL_INSTRUCTIONS, spawnGate} from '../src/thread/spawn-gate';
import {THREAD_GUARD_HOOK_COMMAND} from '../src/thread-hooks-setup';
import {initRepo} from './git-fixtures';
import {needBr} from './pinned-br';
import {createSandbox} from './sandbox';

const SID = '01d00000-1111-4222-8333-0000000000a1';
const SOCK = '/tmp/spawn-gate-test/cmux.sock';

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

interface World {
  beadId: string | null;
  env: Record<string, string | undefined>;
  repo: string;
  stateDir: string;
}

function world(input: {bead: boolean; successor: boolean | null}): World {
  needBr();
  const sb = createSandbox();
  sandboxes.push(sb);
  const xdg = join(sb.path, 'xdg');
  mkdirSync(join(xdg, 'justin-sdk'), {recursive: true});
  const thread: Record<string, unknown> = {enabled: true, sessionBeads: true};
  if (input.successor != null) {
    thread.handoff = {successor: input.successor};
  }
  writeFileSync(
    join(xdg, 'justin-sdk', 'config.json'),
    JSON.stringify({componentConfig: {thread}}),
  );
  const stateDir = join(sb.path, 'state');
  const env: Record<string, string | undefined> = {
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SESSION_ID: SID,
    CMUX_SOCKET_PATH: SOCK,
    HOME: join(sb.path, 'home'),
    JUSTIN_SDK_HEALTH_NOTICES: 'off',
    JUSTIN_THREADS_STATE_DIR: stateDir,
    JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(sb.path, 'projects'),
    XDG_CONFIG_HOME: xdg,
  };
  const repo = initRepo(sb, 'spawn-gate-repo', {'README.md': '# r\n'});
  const init = runBr(repo, ['init', '--prefix', 't', '-q']);
  if (!init.ok) throw new Error(`br init failed: ${init.reason ?? '?'}`);
  let beadId: string | null = null;
  if (input.bead) {
    const filed = ensureSessionBead({
      cwd: repo,
      env,
      firstPrompt: {at: '2030-01-01T09:00:00.000Z', text: 'start a thing'},
      now: new Date('2030-01-01T09:00:00.000Z'),
      sessionId: SID,
    });
    if (filed.kind !== 'created') throw new Error(filed.detail);
    beadId = filed.beadId;
  }
  return {beadId, env, repo, stateDir};
}

const REFUSED: HandoffGateResult = {
  detail: 'Justin turned handoffs off',
  kind: 'refused',
  message: 'unused here: it is worded for thread handoff',
  ranInSandbox: false,
  reason: 'killSwitch',
};

function fakeCmux() {
  const calls: string[][] = [];
  const run = (args: readonly string[]): Promise<CmuxCall> => {
    calls.push([...args]);
    const stdout = args[0] === 'ping' ? 'PONG\n' : 'OK workspace:9\n';
    return Promise.resolve({kind: 'ok', stdout});
  };
  return {calls, run};
}

const spawnOptions = (w: World) => ({
  cwd: w.repo,
  dir: w.repo,
  dryRun: false,
  env: w.env,
  kickoff: null,
  model: null,
  name: null,
  remoteControl: false,
});

describe('thread spawn and the handoff gate', () => {
  test('knob off: the gate is never consulted and spawn opens as before', async () => {
    const w = world({bead: true, successor: null});
    const gate = () => {
      throw new Error('the gate must not run with the knob off');
    };
    expect(await spawnGate({cwd: w.repo, env: w.env}, {gate})).toBeNull();
    const cmux = fakeCmux();
    const result = await spawnSession(spawnOptions(w), {run: cmux.run});
    expect(result.exitCode).toBe(0);
    expect(cmux.calls.map((args) => args[0])).toEqual([
      'ping',
      'new-workspace',
      // home-base-ys9t7.9.1 B3: the tree read that finds workspace:9's uuid.
      '--json',
    ]);
  });

  test('knob on, gate refuses: exit 3, nothing opened, recorded on the caller’s bead', async () => {
    const w = world({bead: true, successor: true});
    const cmux = fakeCmux();
    const gate = (cwd: string, env: typeof w.env) =>
      spawnGate({cwd, env}, {gate: () => Promise.resolve(REFUSED)});
    const result = await spawnSession(spawnOptions(w), {
      gate: (input) => gate(input.cwd, input.env),
      run: cmux.run,
    });
    expect(result.exitCode).toBe(3);
    expect(cmux.calls).toEqual([]);
    expect(result.lines.slice(0, 5)).toEqual([
      'thread spawn: refused by the handoff gate: killSwitch: Justin turned handoffs off',
      '',
      ...SPAWN_REFUSAL_INSTRUCTIONS,
    ]);
    expect(result.lines.at(-1)).toBe(
      `Recorded on ${w.beadId}: handoff refused: killSwitch — thread spawn: Justin turned handoffs off`,
    );
    const shown = brShow({cwd: w.repo}, w.beadId ?? '');
    if (shown.kind !== 'ok') throw new Error(shown.kind);
    expect(shown.issue.labels).toContain('handoff-refused');
    expect(shown.issue.notes).toContain(
      'handoff refused: killSwitch — thread spawn: Justin turned handoffs off',
    );
  });

  test('knob on, gate refuses, the caller has no session bead: exit 3, says it was not recorded', async () => {
    const w = world({bead: false, successor: true});
    const result = await spawnGate(
      {cwd: w.repo, env: w.env},
      {gate: () => Promise.resolve(REFUSED)},
    );
    expect(result?.exitCode).toBe(3);
    expect(result?.lines.at(-1)).toStartWith(
      'Not recorded: the calling session has no session bead',
    );
  });

  test('knob on, gate passes: spawn goes on', async () => {
    const w = world({bead: true, successor: true});
    const pass: HandoffGateResult = {
      facts: {
        chain: {kind: 'skipped'},
        liveSessions: {
          bySource: {agents: 0, hookStore: 0, ps: 1, screen: 0},
          kind: 'counted',
          sessionIds: 1,
          total: 1,
          unplaced: {background: 0, pane: 0, process: 0},
        },
        surfaceId: null,
        usage: {
          ageMinutes: 5,
          sampledAt: '2030-01-01T09:55:00.000Z',
          sessionPercent: 1,
          weekPercent: 1,
        },
        workspaceId: null,
      },
      kind: 'pass',
    };
    expect(
      await spawnGate(
        {cwd: w.repo, env: w.env},
        {gate: () => Promise.resolve(pass)},
      ),
    ).toBeNull();
  });

  test('the real spawn gate does not require a cmux pane: it gets past that check', async () => {
    const w = world({bead: true, successor: true});
    // No pane, and no cmux socket anywhere: the pane check is skipped, so the
    // first refusal is cmux being unreachable, and no cmux is ever run. The
    // session guard is registered (home-base-mbnjv.5), so that check passes.
    mkdirSync(join(w.repo, '.claude'), {recursive: true});
    writeFileSync(
      join(w.repo, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {hooks: [{command: THREAD_GUARD_HOOK_COMMAND}], matcher: 'Bash'},
          ],
        },
      }),
    );
    const env = {...w.env, CMUX_SOCKET_PATH: undefined};
    // F14 (home-base-mbnjv.8): the guard's one-time pass for this call, as
    // the guard writes it when it allows `thread spawn`.
    const words = ['./node_modules/.bin/justin-sdk', 'thread', 'spawn'];
    writeGuardPass({
      env,
      now: new Date(),
      sessionId: SID,
      words,
    });
    const result = await spawnGate({
      commandWords: words.slice(1),
      cwd: w.repo,
      env,
    });
    expect(result?.exitCode).toBe(3);
    expect(result?.lines[0]).toStartWith(
      'thread spawn: refused by the handoff gate: cmuxUnreachable:',
    );
  });
});

// runHandoffGate's requireCmuxPane itself is tested in
// thread-handoff-gate.test.ts, beside the gate's other checks.
