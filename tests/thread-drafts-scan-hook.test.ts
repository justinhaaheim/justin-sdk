/**
 * `thread drafts hook` (home-base-fmf1n D1 to D4): the hourly hook that
 * starts the unsent-drafts scan. Every test here runs against a temporary
 * threads state dir and a fake spawn: nothing starts a real scan or talks to
 * cmux.
 */

import type {DraftsHookDeps} from '../src/thread/drafts-scan-hook';
import type {DraftsScanRun} from '../src/thread/drafts-scan-runs';

import {afterEach, beforeEach, describe, expect, spyOn, test} from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {
  claimHour,
  CMUX_CAPABILITY_ENV_VAR,
  draftsScanHook,
  runThreadDraftsHook,
} from '../src/thread/drafts-scan-hook';
import {draftsScanClaimsDir, hourLabel} from '../src/thread/drafts-scan-runs';

let dir = '';
let env: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'drafts-hook-'));
  env = {
    // A placeholder: only the variable's presence is read, never its value.
    [CMUX_CAPABILITY_ENV_VAR]: 'test-placeholder',
    HOME: join(dir, 'home'),
    JUSTIN_THREADS_STATE_DIR: join(dir, 'state'),
    XDG_CONFIG_HOME: join(dir, 'xdg'),
  };
});

afterEach(() => {
  rmSync(dir, {force: true, recursive: true});
});

const NOW = new Date('2026-11-15T09:20:00.000Z');
const PAYLOAD = JSON.stringify({
  cwd: '/nowhere',
  hook_event_name: 'Stop',
  session_id: 'aaaaaaaa-0000-4000-8000-000000000001',
});

/** Fake deps that count every claim, spawn and record. */
function fakes(over: Partial<DraftsHookDeps> = {}) {
  const calls = {claims: 0, records: [] as DraftsScanRun[], spawns: 0};
  const deps: DraftsHookDeps = {
    claim: (label, claimEnv, now) => {
      calls.claims += 1;
      return claimHour(label, claimEnv, now);
    },
    knobOn: () => true,
    recordRun: (run) => {
      calls.records.push(run);
      return null;
    },
    spawnScan: () => {
      calls.spawns += 1;
      return {kind: 'spawned', pid: 4242};
    },
    ...over,
  };
  return {calls, deps};
}

async function hook(deps: DraftsHookDeps, hookEnv = env, now = NOW) {
  return await draftsScanHook({
    cwd: dir,
    deps,
    env: hookEnv,
    now,
    stdin: PAYLOAD,
    timeZone: 'UTC',
  });
}

describe('the hot path (D2)', () => {
  test('without CMUX_SOCKET_CAPABILITY: no claim and no spawn', async () => {
    const {calls, deps} = fakes();
    const {[CMUX_CAPABILITY_ENV_VAR]: _unused, ...outside} = env;
    expect(await hook(deps, outside)).toEqual({kind: 'notInCmux'});
    expect(await hook(deps, {...env, [CMUX_CAPABILITY_ENV_VAR]: ''})).toEqual({
      kind: 'notInCmux',
    });
    expect(calls).toEqual({claims: 0, records: [], spawns: 0});
    expect(existsSync(draftsScanClaimsDir(env))).toBe(false);
  });

  test('the first hook of an hour claims it and spawns; every later one that hour does not', async () => {
    const {calls, deps} = fakes();
    expect(await hook(deps)).toEqual({
      kind: 'spawned',
      label: '2026-11-15T09',
      pid: 4242,
    });
    const later = new Date('2026-11-15T09:59:59.000Z');
    expect(await hook(deps, env, later)).toEqual({
      kind: 'alreadyClaimed',
      label: '2026-11-15T09',
    });
    expect(await hook(deps)).toEqual({
      kind: 'alreadyClaimed',
      label: '2026-11-15T09',
    });
    expect(calls.spawns).toBe(1);
    expect(readdirSync(draftsScanClaimsDir(env))).toEqual([
      '2026-11-15T09.claim',
    ]);
    // The next wall-clock hour is a new claim.
    expect(
      (await hook(deps, env, new Date('2026-11-15T10:00:00.000Z'))).kind,
    ).toBe('spawned');
    expect(calls.spawns).toBe(2);
    // A skip writes no run record (D5).
    expect(calls.records).toEqual([]);
  });

  test('knob off does nothing: no claim, no spawn, whatever else holds', async () => {
    const {calls, deps} = fakes({knobOn: () => false});
    expect(await hook(deps)).toEqual({kind: 'knobOff'});
    expect(calls).toEqual({claims: 0, records: [], spawns: 0});
    expect(existsSync(draftsScanClaimsDir(env))).toBe(false);
  });

  test('the real knob reads componentConfig.thread.draftsScanHook at the project root', async () => {
    const project = join(dir, 'project');
    mkdirSync(project, {recursive: true});
    const withKnob = (value: boolean | null): void => {
      writeFileSync(
        join(project, 'justin-sdk.config.json'),
        JSON.stringify({
          componentConfig: {
            thread: value == null ? {} : {draftsScanHook: value},
          },
        }),
      );
    };
    const {knobOn: _real, ...rest} = fakes().deps;
    const run = async () =>
      (
        await draftsScanHook({
          cwd: dir,
          deps: rest,
          env: {...env, CLAUDE_PROJECT_DIR: project},
          now: NOW,
          stdin: PAYLOAD,
          timeZone: 'UTC',
        })
      ).kind;
    withKnob(null);
    expect(await run()).toBe('knobOff');
    withKnob(false);
    expect(await run()).toBe('knobOff');
    withKnob(true);
    expect(await run()).toBe('spawned');
  });

  test('a throw anywhere is a decision, never a rejection', async () => {
    const boom = (): never => {
      throw new Error('boom');
    };
    for (const over of [
      {knobOn: boom},
      {claim: boom},
      {spawnScan: boom},
    ] as Partial<DraftsHookDeps>[]) {
      const {deps} = fakes(over);
      expect(await hook(deps)).toEqual({error: 'boom', kind: 'threw'});
    }
  });

  test('the CLI exits 0 and prints nothing, even when the handler throws', async () => {
    const written: string[] = [];
    const out = spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    const err = spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    const log = spyOn(console, 'log').mockImplementation((...args) => {
      written.push(args.join(' '));
    });
    const error = spyOn(console, 'error').mockImplementation((...args) => {
      written.push(args.join(' '));
    });
    try {
      const {deps} = fakes({
        knobOn: () => {
          throw new Error('boom');
        },
      });
      expect(await runThreadDraftsHook({deps, env, stdin: PAYLOAD})).toBe(0);
      const ok = fakes();
      expect(
        await runThreadDraftsHook({deps: ok.deps, env, stdin: 'not json'}),
      ).toBe(0);
      expect(ok.calls.spawns).toBe(1);
    } finally {
      out.mockRestore();
      err.mockRestore();
      log.mockRestore();
      error.mockRestore();
    }
    expect(written).toEqual([]);
  });

  test('a claim whose scan could not start records a failed run (D5)', async () => {
    const {calls, deps} = fakes({
      spawnScan: () => ({error: 'spawn ENOENT', kind: 'failed'}),
    });
    const decision = await hook(deps);
    expect(decision.kind).toBe('spawnFailed');
    expect(calls.records).toHaveLength(1);
    expect(calls.records[0]).toMatchObject({
      counts: null,
      outcome: 'failed',
      trigger: 'hook',
    });
    expect(calls.records[0]?.error).toContain('spawn ENOENT');
  });
});

describe('the claim (D3)', () => {
  test('hour labels are wall-clock hours in the given zone', () => {
    expect(hourLabel(NOW, 'UTC')).toBe('2026-11-15T09');
    expect(hourLabel(NOW, 'America/Los_Angeles')).toBe('2026-11-15T01');
  });

  test('a claim older than two days is pruned by the next claim; a newer one stays', () => {
    const claims = draftsScanClaimsDir(env);
    mkdirSync(claims, {recursive: true});
    const old = join(claims, '2026-11-12T08.claim');
    const recent = join(claims, '2026-11-14T08.claim');
    writeFileSync(old, '{}\n');
    writeFileSync(recent, '{}\n');
    const threeDaysAgo = new Date(NOW.getTime() - 3 * 24 * 3_600_000);
    utimesSync(old, threeDaysAgo, threeDaysAgo);
    const oneDayAgo = new Date(NOW.getTime() - 24 * 3_600_000);
    utimesSync(recent, oneDayAgo, oneDayAgo);
    expect(claimHour('2026-11-15T09', env, NOW).kind).toBe('claimed');
    expect(readdirSync(claims).sort()).toEqual([
      '2026-11-14T08.claim',
      '2026-11-15T09.claim',
    ]);
  });
});
