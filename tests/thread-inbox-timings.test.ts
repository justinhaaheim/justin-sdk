/**
 * The inbox's load timing recorder (home-base-9uzxw.2, epic home-base-9uzxw
 * D-PERF): phase wall times, spawn counts per phase by program, the slowest
 * session loads, and the `timings` field spliced into the JSON. The last test
 * runs a real readInbox (real br and git, a $TMPDIR world) with a recorder.
 */

import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, test} from 'bun:test';
import {execFile, spawnSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {runBr} from '../src/beads/br';
import {
  inboxJsonWithTimings,
  SLOWEST_SESSIONS,
  spawnProgram,
  startTimings,
  timed,
  timedSession,
  timedStart,
  withTimingsField,
} from '../src/thread/inbox-timings';
import {ensureSessionBead} from '../src/thread/session-bead';
import {readInbox, runSessionInbox} from '../src/thread/session-inbox';
import {initRepo} from './git-fixtures';
import {needBr} from './pinned-br';
import {createSandbox} from './sandbox';

function execTrue(): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('true', (error) => {
      if (error == null) resolve();
      else reject(new Error(error.message));
    });
  });
}

describe('spawnProgram', () => {
  test('names the program, and git with its subcommand', () => {
    expect(spawnProgram([['/usr/bin/cmux', 'tree']])).toBe('cmux');
    expect(spawnProgram([{cmd: ['ps', '-axo', 'pid']}])).toBe('ps');
    expect(spawnProgram([['git', 'rev-parse', '--verify', 'x']])).toBe(
      'git rev-parse',
    );
    expect(
      spawnProgram([['git', '-C', '/repo', '-c', 'a=b', '--no-pager', 'log']]),
    ).toBe('git log');
    expect(spawnProgram([['git']])).toBe('git');
    expect(spawnProgram([42])).toBe('unknown');
  });
});

describe('startTimings', () => {
  test('a sync phase, an async phase and a start/stop phase each get their wall time', async () => {
    const recorder = startTimings();
    const value = recorder.phase('sync', () => 7);
    const awaited = await recorder.phase(
      'async',
      async () => await Bun.sleep(30).then(() => 'slept'),
    );
    const stop = recorder.start('marked');
    Bun.sleepSync(20);
    stop();
    const timings = recorder.finish();
    expect(value).toBe(7);
    expect(awaited).toBe('slept');
    expect(timings.phases.map((phase) => phase.name)).toEqual([
      'sync',
      'async',
      'marked',
    ]);
    const ms = Object.fromEntries(timings.phases.map((p) => [p.name, p.ms]));
    expect(ms.async).toBeGreaterThanOrEqual(25);
    expect(ms.marked).toBeGreaterThanOrEqual(15);
    expect(timings.totalMs).toBeGreaterThanOrEqual(45);
    expect(timings.bootMs).toBeGreaterThan(0);
    expect(timings.spawnCounting).toEqual({kind: 'counted'});
  });

  test('each phase counts its own spawns, even when phases run at the same time', async () => {
    const recorder = startTimings();
    recorder.phase('one sync', () => {
      spawnSync('true');
    });
    await Promise.all([
      recorder.phase('two async', async () => {
        await Bun.sleep(5);
        await execTrue();
        await execTrue();
      }),
      recorder.phase('three async', async () => {
        await execTrue();
        await execTrue();
        await execTrue();
      }),
    ]);
    const stop = recorder.start('four marked');
    spawnSync('true');
    stop();
    spawnSync('true'); // outside every phase: in the total only
    const timings = recorder.finish();
    const spawns = Object.fromEntries(
      timings.phases.map((p) => [p.name, p.spawns]),
    );
    expect(spawns).toEqual({
      'four marked': {true: 1},
      'one sync': {true: 1},
      'three async': {true: 3},
      'two async': {true: 2},
    });
    expect(timings.spawns).toEqual({true: 8});
  });

  test('a session load counts to its phase and to itself; the slowest five are named, slowest first', async () => {
    const recorder = startTimings();
    const ids = ['s1', 's2', 's3', 's4', 's5', 's6', 's7'];
    await recorder.phase('loads', async () => {
      await Promise.all(
        ids.map(
          async (id, position) =>
            await recorder.session(id, async () => {
              await Bun.sleep(5 + position * 8);
              if (id === 's7') await execTrue();
            }),
        ),
      );
    });
    const timings = recorder.finish();
    expect(timings.sessionLoads).toBe(7);
    expect(timings.slowestSessions).toHaveLength(SLOWEST_SESSIONS);
    expect(timings.slowestSessions.map((s) => s.sessionId)).toEqual([
      's7',
      's6',
      's5',
      's4',
      's3',
    ]);
    expect(timings.slowestSessions[0]?.spawns).toEqual({true: 1});
    expect(timings.slowestSessions[1]?.spawns).toEqual({});
    expect(timings.phases[0]?.spawns).toEqual({true: 1});
  });

  test('a phase that throws still ends, and the error reaches the caller', async () => {
    const recorder = startTimings();
    expect(() =>
      recorder.phase('throws', () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    let caught: unknown = null;
    try {
      await recorder.phase('rejects', async () => {
        await Bun.sleep(10);
        throw new Error('later');
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const timings = recorder.finish();
    expect(timings.phases.map((p) => p.name)).toEqual(['throws', 'rejects']);
    expect(timings.phases[1]?.ms).toBeGreaterThanOrEqual(8);
  });

  test('finish puts Bun.spawn and Bun.spawnSync back, and nothing is counted after it', () => {
    const spawn = Bun.spawn;
    const spawnSyncBefore = Bun.spawnSync;
    const recorder = startTimings();
    expect(Bun.spawn).not.toBe(spawn);
    const timings = recorder.finish();
    expect(Bun.spawn).toBe(spawn);
    expect(Bun.spawnSync).toBe(spawnSyncBefore);
    spawnSync('true');
    expect(timings.spawns).toEqual({});
    expect(recorder.finish()).toBe(timings);
  });

  // Conductor finding F3. NEGATIVE CONTROL (run 2026-11-07): with the wrapper
  // calling countSpawn directly again, this test failed at the spawn itself
  // ("cmd unreadable for the counter" thrown out of Bun.spawnSync).
  test('F3: a counting step that throws never stops the spawn, and every count says failed', async () => {
    /** Options whose `cmd` throws on its first read: the counter's read. */
    const throwsOnFirstRead = (
      word: string,
    ): {cmd: string[]; stderr: 'pipe'; stdout: 'pipe'} => {
      let reads = 0;
      return {
        get cmd(): string[] {
          reads += 1;
          if (reads === 1) throw new Error('cmd unreadable for the counter');
          return ['echo', word];
        },
        stderr: 'pipe',
        stdout: 'pipe',
      };
    };
    const recorder = startTimings();
    const syncRun = recorder.phase('sync spawn', () =>
      Bun.spawnSync(throwsOnFirstRead('sync')),
    );
    const asyncOut = await recorder.phase(
      'async spawn',
      async () =>
        await recorder.session('s1', async () => {
          const child = Bun.spawn(throwsOnFirstRead('async'));
          await child.exited;
          return await new Response(child.stdout).text();
        }),
    );
    spawnSync('true'); // counted fine, but the record is no longer a count
    const timings = recorder.finish();
    // The spawns ran as if nothing wrapped them.
    expect(syncRun.exitCode).toBe(0);
    expect(syncRun.stdout.toString()).toBe('sync\n');
    expect(asyncOut).toBe('async\n');
    // And no count pretends to be one (critical rule 7): failed, with why.
    expect(timings.spawnCounting).toEqual({
      kind: 'failed',
      reason: 'counting a spawn threw: cmd unreadable for the counter',
    });
    expect(timings.spawns).toBeNull();
    expect(timings.phases.map((p) => [p.name, p.spawns])).toEqual([
      ['sync spawn', null],
      ['async spawn', null],
    ]);
    expect(timings.slowestSessions.map((s) => [s.sessionId, s.spawns])).toEqual(
      [['s1', null]],
    );
    // The next recorder starts clean: the failure belonged to that one.
    const next = startTimings();
    spawnSync('true');
    const clean = next.finish();
    expect(clean.spawnCounting).toEqual({kind: 'counted'});
    expect(clean.spawns).toEqual({true: 1});
  });

  test('with no recorder, timed, timedSession and timedStart only run the work', async () => {
    expect(timed(null, 'x', () => 3)).toBe(3);
    expect(await timedSession(undefined, 's', () => Promise.resolve(4))).toBe(
      4,
    );
    timedStart(null, 'y')();
  });

  // home-base-9ihcl.4: the event-loop lag is the evidence for "is something
  // synchronous holding up the parallel work". NEGATIVE CONTROL (2026-11-10):
  // with the probe never updating maxLagMs, this failed (Expected >= 100,
  // Received 0); restored, it passed.
  test('a thread blocked for 150 ms shows as event-loop lag', async () => {
    const recorder = startTimings();
    await Bun.sleep(30);
    Bun.sleepSync(150);
    await Bun.sleep(30);
    const timings = recorder.finish();
    expect(timings.eventLoop.intervalMs).toBe(20);
    expect(timings.eventLoop.samples).toBeGreaterThan(0);
    expect(timings.eventLoop.maxLagMs).toBeGreaterThanOrEqual(100);
    expect(timings.eventLoop.over100ms).toBeGreaterThanOrEqual(1);
    expect(timings.eventLoop.blockedMs).toBeGreaterThanOrEqual(100);
  });
});

describe('withTimingsField', () => {
  const timings = startTimings().finish();

  test('adds `timings` as the last field of a pretty-printed object', () => {
    const object = {a: 1, b: {c: [1, 2]}, sessions: []};
    const text = withTimingsField(JSON.stringify(object, null, 2), timings);
    expect(JSON.parse(text)).toEqual({...object, timings});
    expect(text).toBe(JSON.stringify({...object, timings}, null, 2));
  });

  test('an empty object, and text that is not a pretty object', () => {
    expect(JSON.parse(withTimingsField('{}', timings))).toEqual({timings});
    expect(() => withTimingsField('{"a":1}', timings)).toThrow(
      'pretty-printed',
    );
  });
});

const SID = 'aa693548-b000-4b39-8cf4-90a380854827';
const NOW = new Date('2030-01-01T10:00:00.000Z');

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

// home-base-9uzxw.5 F15. Negative control, run 2026-11-07: inboxJsonWithTimings
// calling withTimingsField with no catch failed the first test (it threw);
// session-inbox.ts with the finally removed failed the second (Bun.spawn was
// still the counting wrapper after the read threw).
describe('thread inbox --json never fails over its timings (F15)', () => {
  const timings = startTimings().finish();

  test('a JSON that does not end in "\\n}" is printed without timings, and the problem says so', () => {
    for (const json of [
      '{"a":1}',
      '[\n  1\n]',
      '{\n  "a": 1\n}\n// trailing',
    ]) {
      const printed = inboxJsonWithTimings(json, timings);
      expect(printed.text).toBe(json);
      expect(printed.problem).toBe(
        'the load timings were left out of the JSON: withTimingsField: expected a pretty-printed JSON object ending in "\\n}"',
      );
    }
    const object = {a: 1, sessions: []};
    const ok = inboxJsonWithTimings(JSON.stringify(object, null, 2), timings);
    expect(ok.problem).toBeNull();
    expect(JSON.parse(ok.text)).toEqual({...object, timings});
  });

  test('a read that throws still finishes the recorder: Bun.spawn is put back', async () => {
    const sb = createSandbox();
    sandboxes.push(sb);
    const before = Bun.spawn;
    let thrown: unknown = null;
    try {
      await runSessionInbox({
        all: true,
        cwd: sb.path,
        days: 30,
        env: {
          HOME: join(sb.path, 'home'),
          JUSTIN_SDK_HEALTH_NOTICES: 'off',
          JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state'),
          XDG_CONFIG_HOME: join(sb.path, 'xdg'),
        },
        json: true,
        lookupPanes: () => {
          throw new Error('pane lookup blew up');
        },
        now: NOW,
        order: 'status',
        repo: null,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown instanceof Error ? thrown.message : thrown).toBe(
      'pane lookup blew up',
    );
    expect(Bun.spawn).toBe(before);
  });
});

describe('readInbox with a recorder', () => {
  test('every phase is named, the session load is timed, and its git runs are counted', async () => {
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
      CLAUDE_CODE_SESSION_ID: SID,
      HOME: join(sb.path, 'home'),
      JUSTIN_SDK_HEALTH_NOTICES: 'off',
      JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state'),
      JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(sb.path, 'projects'),
      XDG_CONFIG_HOME: xdg,
    };
    const repo = initRepo(sb, 'timing-repo', {'README.md': '# r\n'});
    const init = runBr(repo, ['init', '--prefix', 't', '-q']);
    if (!init.ok) throw new Error(`br init failed: ${init.reason ?? '?'}`);
    const filed = ensureSessionBead({
      cwd: repo,
      env,
      firstPrompt: {at: '2030-01-01T09:00:00.000Z', text: 'time the load'},
      now: new Date('2030-01-01T09:00:00.000Z'),
      sessionId: SID,
    });
    if (filed.kind !== 'created') throw new Error(filed.detail);

    const recorder = startTimings();
    const inbox = await readInbox({
      cwd: repo,
      days: 30,
      devRoot: join(sb.path, 'dev'),
      env,
      lookupPanes: async () =>
        await Promise.resolve({ok: false, reason: 'not looked up in a test'}),
      now: NOW,
      repo: null,
      timings: recorder,
    });
    const timings = recorder.finish();
    expect(inbox.kind).toBe('read');
    expect(timings.phases.map((phase) => phase.name)).toEqual([
      'sessions index',
      'pane lookup',
      'drafts store',
      'message logs',
      'session loads',
      'untracked scan',
      'rows',
    ]);
    expect(timings.sessionLoads).toBe(1);
    expect(timings.slowestSessions.map((s) => s.sessionId)).toEqual([SID]);
    const loads = timings.phases.find((p) => p.name === 'session loads');
    const gitRuns = Object.entries(loads?.spawns ?? {})
      .filter(([program]) => program.startsWith('git'))
      .reduce((sum, [, count]) => sum + count, 0);
    // The checkout is measured with git: counted, never a silent 0.
    expect(gitRuns).toBeGreaterThan(0);
    expect(timings.slowestSessions[0]?.spawns).toEqual(loads?.spawns ?? null);
  });
});
