/**
 * The health-notices mechanism (home-base-uxwc D1, D4, D5, D7).
 *
 * EVERY test here injects a fake fetcher, a temp state dir and a fixed clock.
 * Nothing reaches the network, and the fetcher's CALL COUNT is the assertion
 * for most of the interesting behaviour: "did not fetch" is the property that
 * keeps an offline laptop from spending 5 seconds on every command.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {mkdirSync, readFileSync, writeFileSync} from 'fs';
import {join} from 'path';

import {
  bumpKindFromDiff,
  callsiteTier,
  checkSdkVersion,
  commandNameFromArgv,
  decideNotice,
  emptyState,
  healthNoticesPaths,
  isStateWritable,
  probeSdkVersion,
  readState,
  recordNotified,
  renderNotice,
  STATE_SCHEMA_VERSION,
  tierAllows,
  UPGRADE_COMMAND,
  writeState,
  xdgStateHome,
  type HealthNoticesState,
} from '../src/health-notices';
import {
  DEFAULT_HEALTH_NOTICES,
  type EnvLike,
  type PromptTier,
  type ResolvedHealthNoticesConfig,
} from '../src/sdk-config';
import type {LatestTagOutcome, SdkTagFetcher} from '../src/sdk-latest';
import {createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];

afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

function newSandbox(): Sandbox {
  const created = createSandbox();
  sandboxes.push(created);
  return created;
}

/** A state dir under a temp $XDG_STATE_HOME, plus the env that points at it. */
function stateEnv(): {
  env: EnvLike;
  paths: ReturnType<typeof healthNoticesPaths>;
} {
  const box = newSandbox();
  const env: EnvLike = {
    HOME: box.path,
    XDG_STATE_HOME: join(box.path, 'state'),
  };
  return {env, paths: healthNoticesPaths(env)};
}

function countingFetcher(outcome: LatestTagOutcome): {
  calls: {timeoutMs: number}[];
  fetcher: SdkTagFetcher;
} {
  const calls: {timeoutMs: number}[] = [];
  return {
    calls,
    fetcher: (options) => {
      calls.push(options);
      return outcome;
    },
  };
}

const OK_026: LatestTagOutcome = {
  status: 'ok',
  tag: 'v0.26.0',
  version: '0.26.0',
};

const AT = (iso: string): Date => new Date(iso);

function config(
  overrides: Partial<ResolvedHealthNoticesConfig> = {},
): ResolvedHealthNoticesConfig {
  return {...DEFAULT_HEALTH_NOTICES, ...overrides};
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

describe('xdgStateHome', () => {
  test('prefers XDG_STATE_HOME', () => {
    expect(xdgStateHome({XDG_STATE_HOME: '/x/state', HOME: '/home/j'})).toBe(
      '/x/state',
    );
  });

  test('falls back to $HOME/.local/state — the justin-loop ledger location', () => {
    expect(xdgStateHome({HOME: '/home/j'})).toBe('/home/j/.local/state');
  });

  test('an EMPTY HOME does not resolve the state file into the current repo', () => {
    // The bug this guards: `resolve('', '.local', 'state')` is CWD-relative, so
    // an unset HOME would drop health-notices.json inside whatever checkout the
    // command ran in. It must land under the real home directory instead.
    const resolved = xdgStateHome({HOME: ''});
    expect(resolved.startsWith(process.cwd())).toBe(false);
    expect(resolved.endsWith('/.local/state')).toBe(true);
  });

  test('the file sits under justin-sdk/, beside the justin-loop ledger', () => {
    const paths = healthNoticesPaths({XDG_STATE_HOME: '/x/state'});
    expect(paths.file).toBe('/x/state/justin-sdk/health-notices.json');
    expect(paths.dir).toBe('/x/state/justin-sdk');
  });
});

// ---------------------------------------------------------------------------
// State file (D4)
// ---------------------------------------------------------------------------

describe('readState', () => {
  test('a missing file is absent, and says WHY it is absent', () => {
    const {paths} = stateEnv();
    const outcome = readState(paths);
    expect(outcome.status).toBe('absent');
    if (outcome.status !== 'absent') throw new Error('unreachable');
    expect(outcome.reason).toBe('no-file');
  });

  test('unparseable bytes read as absent/invalid-json, never as an empty state', () => {
    const {paths} = stateEnv();
    mkdirSync(paths.dir, {recursive: true});
    writeFileSync(paths.file, '{not json');
    const outcome = readState(paths);
    expect(outcome.status).toBe('absent');
    if (outcome.status !== 'absent') throw new Error('unreachable');
    expect(outcome.reason).toBe('invalid-json');
    expect(outcome.detail).not.toBeNull();
  });

  test('a file written by a NEWER SDK reads as absent, naming the schema version', () => {
    const {paths} = stateEnv();
    mkdirSync(paths.dir, {recursive: true});
    writeFileSync(paths.file, JSON.stringify({schemaVersion: 99, whatever: 1}));
    const outcome = readState(paths);
    expect(outcome.status).toBe('absent');
    if (outcome.status !== 'absent') throw new Error('unreachable');
    expect(outcome.reason).toBe('unknown-schema-version');
    expect(outcome.detail).toContain('99');
  });

  test('a right-version file with a wrong-typed field reads as absent, not half-trusted', () => {
    const {paths} = stateEnv();
    mkdirSync(paths.dir, {recursive: true});
    writeFileSync(
      paths.file,
      JSON.stringify({
        doctorRuns: {},
        lastCheck: {at: 5, error: null, latest: null, ok: true},
        lastKnownLatest: null,
        lastNotified: {},
        schemaVersion: STATE_SCHEMA_VERSION,
      }),
    );
    const outcome = readState(paths);
    expect(outcome.status).toBe('absent');
    if (outcome.status !== 'absent') throw new Error('unreachable');
    expect(outcome.reason).toBe('unknown-shape');
  });

  test('a directory where the file should be reads as unreadable, not as no-file', () => {
    const {paths} = stateEnv();
    mkdirSync(paths.file, {recursive: true});
    const outcome = readState(paths);
    expect(outcome.status).toBe('absent');
    if (outcome.status !== 'absent') throw new Error('unreachable');
    expect(outcome.reason).toBe('unreadable');
  });
});

describe('writeState', () => {
  test('round-trips a full state', () => {
    const {paths} = stateEnv();
    const state: HealthNoticesState = {
      doctorRuns: {'/repo': {at: 'T1', errors: 0, passed: 18, warnings: 1}},
      lastCheck: {at: 'T2', error: null, latest: '0.26.0', ok: true},
      lastKnownLatest: {at: 'T2', version: '0.26.0'},
      lastNotified: {'/repo': {minor: 'T3'}},
      schemaVersion: STATE_SCHEMA_VERSION,
    };
    expect(writeState(paths, state)).toBe(true);
    const outcome = readState(paths);
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') throw new Error('unreachable');
    expect(outcome.state).toEqual(state);
  });

  test('leaves no .tmp file behind', () => {
    const {paths} = stateEnv();
    writeState(paths, emptyState());
    expect(readState(paths).status).toBe('ok');
    const {readdirSync} = require('fs') as typeof import('fs');
    expect(readdirSync(paths.dir).filter((n) => n.endsWith('.tmp'))).toEqual(
      [],
    );
  });

  test('returns FALSE (never throws) when the directory cannot be made', () => {
    const box = newSandbox();
    // A regular file where the state directory needs to be: mkdir fails ENOTDIR.
    writeFileSync(join(box.path, 'justin-sdk'), 'not a directory');
    const paths = healthNoticesPaths({XDG_STATE_HOME: box.path});
    expect(writeState(paths, emptyState())).toBe(false);
  });
});

describe('isStateWritable', () => {
  test('true for a directory it can create and write in', () => {
    const {paths} = stateEnv();
    expect(isStateWritable(paths)).toBe(true);
  });

  test('false when the directory cannot be created, and leaves no probe file', () => {
    const box = newSandbox();
    writeFileSync(join(box.path, 'justin-sdk'), 'not a directory');
    const paths = healthNoticesPaths({XDG_STATE_HOME: box.path});
    expect(isStateWritable(paths)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The check (D3, D5)
// ---------------------------------------------------------------------------

describe('bumpKindFromDiff', () => {
  test('prerelease kinds collapse onto their base kind (D2)', () => {
    expect(bumpKindFromDiff('premajor')).toBe('major');
    expect(bumpKindFromDiff('preminor')).toBe('minor');
    expect(bumpKindFromDiff('prepatch')).toBe('patch');
    expect(bumpKindFromDiff('prerelease')).toBe('patch');
  });

  test('plain kinds pass through, and null stays null', () => {
    expect(bumpKindFromDiff('major')).toBe('major');
    expect(bumpKindFromDiff('minor')).toBe('minor');
    expect(bumpKindFromDiff('patch')).toBe('patch');
    expect(bumpKindFromDiff(null)).toBeNull();
    expect(bumpKindFromDiff('something-else')).toBeNull();
  });
});

describe('checkSdkVersion', () => {
  test('a first check fetches, and records both the attempt and the answer', async () => {
    const {calls, fetcher} = countingFetcher(OK_026);
    const {result, state} = await checkSdkVersion({
      config: config(),
      current: '0.24.0',
      fetcher,
      now: AT('2026-09-10T12:00:00.000Z'),
      state: emptyState(),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.timeoutMs).toBe(5000);
    expect(result.latest).toBe('0.26.0');
    expect(result.kind).toBe('minor');
    expect(result.error).toBeNull();
    expect(state.lastCheck).toEqual({
      at: '2026-09-10T12:00:00.000Z',
      error: null,
      latest: '0.26.0',
      ok: true,
    });
    expect(state.lastKnownLatest).toEqual({
      at: '2026-09-10T12:00:00.000Z',
      version: '0.26.0',
    });
  });

  test('a second check INSIDE checkIntervalMinutes does not fetch at all', async () => {
    const {calls, fetcher} = countingFetcher(OK_026);
    const first = await checkSdkVersion({
      config: config(),
      current: '0.24.0',
      fetcher,
      now: AT('2026-09-10T12:00:00.000Z'),
      state: emptyState(),
    });
    const second = await checkSdkVersion({
      config: config(),
      current: '0.24.0',
      fetcher,
      // Default checkIntervalMinutes is 60.
      now: AT('2026-09-10T12:59:00.000Z'),
      state: first.state,
    });

    expect(calls).toHaveLength(1);
    expect(second.result.latest).toBe('0.26.0');
    expect(second.state).toBe(first.state);
  });

  test('a check PAST the interval fetches again', async () => {
    const {calls, fetcher} = countingFetcher(OK_026);
    const first = await checkSdkVersion({
      config: config(),
      current: '0.24.0',
      fetcher,
      now: AT('2026-09-10T12:00:00.000Z'),
      state: emptyState(),
    });
    await checkSdkVersion({
      config: config(),
      current: '0.24.0',
      fetcher,
      now: AT('2026-09-10T13:01:00.000Z'),
      state: first.state,
    });
    expect(calls).toHaveLength(2);
  });

  test('a FAILED fetch is stored as a failure and stamps the clock, so it is not retried inside the interval (D5)', async () => {
    const {calls, fetcher} = countingFetcher({
      error: 'git ls-remote timed out after 5000ms',
      status: 'failed',
    });
    const first = await checkSdkVersion({
      config: config(),
      current: '0.24.0',
      fetcher,
      now: AT('2026-09-10T12:00:00.000Z'),
      state: emptyState(),
    });

    expect(first.state.lastCheck).toEqual({
      at: '2026-09-10T12:00:00.000Z',
      error: 'git ls-remote timed out after 5000ms',
      latest: null,
      ok: false,
    });
    expect(first.result.error).toBe('git ls-remote timed out after 5000ms');
    // The failure is NOT reported as "nothing newer".
    expect(first.result.latest).toBeNull();
    expect(first.result.kind).toBeNull();

    await checkSdkVersion({
      config: config(),
      current: '0.24.0',
      fetcher,
      now: AT('2026-09-10T12:30:00.000Z'),
      state: first.state,
    });
    expect(calls).toHaveLength(1);
  });

  test('a failure does not erase what was last successfully learned', async () => {
    const good = await checkSdkVersion({
      config: config(),
      current: '0.24.0',
      fetcher: countingFetcher(OK_026).fetcher,
      now: AT('2026-09-10T12:00:00.000Z'),
      state: emptyState(),
    });
    const bad = await checkSdkVersion({
      config: config(),
      current: '0.24.0',
      fetcher: countingFetcher({error: 'offline', status: 'failed'}).fetcher,
      now: AT('2026-09-10T14:00:00.000Z'),
      state: good.state,
    });

    expect(bad.state.lastKnownLatest).toEqual({
      at: '2026-09-10T12:00:00.000Z',
      version: '0.26.0',
    });
    // Still knows a minor bump exists, AND still reports that the last attempt
    // failed — two facts, both kept.
    expect(bad.result.latest).toBe('0.26.0');
    expect(bad.result.kind).toBe('minor');
    expect(bad.result.latestMeasuredAt).toBe('2026-09-10T12:00:00.000Z');
    expect(bad.result.error).toBe('offline');
  });

  test('classifies the bump kind, and reports "not newer" only when it measured one', async () => {
    const cases: [string, string, string | null][] = [
      ['0.26.0', '1.0.0', 'major'],
      ['0.24.0', '0.26.0', 'minor'],
      ['0.26.0', '0.26.1', 'patch'],
      ['0.26.0', '0.26.0', null],
      ['0.27.0', '0.26.0', null],
    ];
    for (const [current, latest, expected] of cases) {
      const {result} = await checkSdkVersion({
        config: config(),
        current,
        fetcher: countingFetcher({
          status: 'ok',
          tag: `v${latest}`,
          version: latest,
        }).fetcher,
        now: AT('2026-09-10T12:00:00.000Z'),
        state: emptyState(),
      });
      expect([current, latest, result.kind]).toEqual([
        current,
        latest,
        expected,
      ]);
    }
  });

  test('an unparseable running version yields kind null rather than a guess', async () => {
    const {result} = await checkSdkVersion({
      config: config(),
      current: 'not-a-version',
      fetcher: countingFetcher(OK_026).fetcher,
      now: AT('2026-09-10T12:00:00.000Z'),
      state: emptyState(),
    });
    expect(result.latest).toBe('0.26.0');
    expect(result.kind).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// probeSdkVersion — the I/O wrapper (D4)
// ---------------------------------------------------------------------------

describe('probeSdkVersion', () => {
  test('an UNWRITABLE state dir means NO fetch is attempted (D4)', async () => {
    const box = newSandbox();
    writeFileSync(join(box.path, 'justin-sdk'), 'not a directory');
    const project = newSandbox();
    const {calls, fetcher} = countingFetcher(OK_026);

    const probe = await probeSdkVersion({
      env: {
        HOME: box.path,
        XDG_CONFIG_HOME: box.path,
        XDG_STATE_HOME: box.path,
      },
      fetcher,
      now: AT('2026-09-10T12:00:00.000Z'),
      projectRoot: project.path,
    });

    expect(calls).toHaveLength(0);
    expect(probe.status).toBe('skipped');
    if (probe.status !== 'skipped') throw new Error('unreachable');
    expect(probe.reason).toBe('state-unwritable');
  });

  test('the kill switch means NO fetch is attempted and NO state file is written', async () => {
    const {env, paths} = stateEnv();
    const project = newSandbox();
    const {calls, fetcher} = countingFetcher(OK_026);

    const probe = await probeSdkVersion({
      env: {...env, JUSTIN_SDK_HEALTH_NOTICES: 'off'},
      fetcher,
      now: AT('2026-09-10T12:00:00.000Z'),
      projectRoot: project.path,
    });

    expect(calls).toHaveLength(0);
    expect(probe.status).toBe('skipped');
    if (probe.status !== 'skipped') throw new Error('unreachable');
    expect(probe.reason).toBe('disabled');
    expect(readState(paths).status).toBe('absent');
  });

  test('CI switches it off just as hard as the kill switch', async () => {
    const {env} = stateEnv();
    const project = newSandbox();
    const {calls, fetcher} = countingFetcher(OK_026);
    const probe = await probeSdkVersion({
      env: {...env, CI: 'true'},
      fetcher,
      now: AT('2026-09-10T12:00:00.000Z'),
      projectRoot: project.path,
    });
    expect(calls).toHaveLength(0);
    expect(probe.status).toBe('skipped');
  });

  test('persists what it fetched, so the next probe reads it back without fetching', async () => {
    const {env, paths} = stateEnv();
    const project = newSandbox();
    const {calls, fetcher} = countingFetcher(OK_026);

    await probeSdkVersion({
      env,
      fetcher,
      now: AT('2026-09-10T12:00:00.000Z'),
      projectRoot: project.path,
    });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(readFileSync(paths.file, 'utf-8'))).toMatchObject({
      lastCheck: {latest: '0.26.0', ok: true},
      schemaVersion: STATE_SCHEMA_VERSION,
    });

    await probeSdkVersion({
      env,
      fetcher,
      now: AT('2026-09-10T12:10:00.000Z'),
      projectRoot: project.path,
    });
    expect(calls).toHaveLength(1);
  });

  test('a project config can switch notices off for one repo (review addition A)', async () => {
    const {env} = stateEnv();
    const project = newSandbox();
    project.writeFile(
      'justin-sdk.config.json',
      JSON.stringify({
        components: ['base-setup'],
        healthNotices: {enabled: false},
        lastSynced: '2026-09-10',
        version: '0.26.0',
      }),
    );
    const {calls, fetcher} = countingFetcher(OK_026);
    const probe = await probeSdkVersion({
      env: {...env, XDG_CONFIG_HOME: join(env.HOME ?? '', 'config')},
      fetcher,
      now: AT('2026-09-10T12:00:00.000Z'),
      projectRoot: project.path,
    });
    expect(calls).toHaveLength(0);
    expect(probe.status).toBe('skipped');
  });
});

// ---------------------------------------------------------------------------
// The notice (D1, D7)
// ---------------------------------------------------------------------------

describe('renderNotice', () => {
  test('is exactly the two lines of D7', () => {
    expect(renderNotice('0.24.0', '0.26.0', 'minor')).toEqual([
      'justin-sdk 0.24.0 → 0.26.0 available (minor)',
      `  upgrade: ${UPGRADE_COMMAND}`,
    ]);
    expect(UPGRADE_COMMAND).toBe('bunx @justinhaaheim/justin-sdk update');
  });
});

describe('tierAllows', () => {
  test('a notice speaks at its own tier and every quieter one', () => {
    expect(tierAllows(2, 3)).toBe(true);
    expect(tierAllows(3, 3)).toBe(true);
    expect(tierAllows(4, 3)).toBe(false);
  });

  test('promptTier 1 is below every callsite, so it never speaks', () => {
    for (const callsite of [2, 3, 4] as PromptTier[]) {
      expect(tierAllows(callsite, 1)).toBe(false);
    }
  });
});

describe('decideNotice', () => {
  const result = {
    checkedAt: '2026-09-10T12:00:00.000Z',
    current: '0.24.0',
    error: null,
    kind: 'minor' as const,
    latest: '0.26.0',
    latestMeasuredAt: '2026-09-10T12:00:00.000Z',
  };
  const now = AT('2026-09-10T12:00:00.000Z');

  function decide(overrides: {
    cfg?: ResolvedHealthNoticesConfig;
    kind?: 'major' | 'minor' | 'patch';
    state?: HealthNoticesState;
    tier: PromptTier | null;
  }) {
    return decideNotice({
      config: overrides.cfg ?? config(),
      now,
      projectRoot: '/repo',
      result: {...result, kind: overrides.kind ?? 'minor'},
      state: overrides.state ?? emptyState(),
      tier: overrides.tier,
    });
  }

  test('the DEFAULT tier matrix: which kinds speak at which callsites (D1/D2)', () => {
    // Defaults are major 4, minor 3, patch 2.
    const matrix: [PromptTier, 'major' | 'minor' | 'patch', boolean][] = [
      [2, 'major', true],
      [2, 'minor', true],
      [2, 'patch', true],
      [3, 'major', true],
      [3, 'minor', true],
      [3, 'patch', false],
      [4, 'major', true],
      [4, 'minor', false],
      [4, 'patch', false],
    ];
    for (const [tier, kind, speaks] of matrix) {
      const outcome = decide({kind, tier});
      expect([tier, kind, outcome.status === 'notify']).toEqual([
        tier,
        kind,
        speaks,
      ]);
      if (!speaks) {
        expect(outcome).toEqual({reason: 'tier', status: 'silent'});
      }
    }
  });

  test('promptTier 1 silences a kind everywhere, doctor included', () => {
    const cfg = config({
      sdkVersion: {
        ...DEFAULT_HEALTH_NOTICES.sdkVersion,
        minor: {promptTier: 1, throttleMinutes: 60},
      },
    });
    for (const tier of [2, 3, 4] as PromptTier[]) {
      expect(decide({cfg, tier})).toEqual({reason: 'tier', status: 'silent'});
    }
  });

  test('a NEVER command (tier null) is silent whatever the config says', () => {
    expect(decide({tier: null})).toEqual({
      reason: 'not-eligible',
      status: 'silent',
    });
  });

  test('disabled beats everything', () => {
    expect(decide({cfg: config({enabled: false}), tier: 2})).toEqual({
      reason: 'disabled',
      status: 'silent',
    });
  });

  test('nothing newer is silent, and says so distinctly from "not allowed"', () => {
    const outcome = decideNotice({
      config: config(),
      now,
      projectRoot: '/repo',
      result: {...result, kind: null, latest: '0.24.0'},
      state: emptyState(),
      tier: 3,
    });
    expect(outcome).toEqual({reason: 'nothing-newer', status: 'silent'});
  });

  test('spoken once, then throttled for the configured window, then spoken again', () => {
    const first = decide({tier: 3});
    expect(first.status).toBe('notify');
    if (first.status !== 'notify') throw new Error('unreachable');

    const after = recordNotified(emptyState(), '/repo', 'minor', now);
    expect(
      decideNotice({
        config: config(),
        now: AT('2026-09-10T12:59:00.000Z'),
        projectRoot: '/repo',
        result,
        state: after,
        tier: 3,
      }),
    ).toEqual({reason: 'throttled', status: 'silent'});

    // Default minor throttle is 60 minutes.
    expect(
      decideNotice({
        config: config(),
        now: AT('2026-09-10T13:01:00.000Z'),
        projectRoot: '/repo',
        result,
        state: after,
        tier: 3,
      }).status,
    ).toBe('notify');
  });

  test('the throttle is PER REPO — a different project root still hears it', () => {
    const after = recordNotified(emptyState(), '/other-repo', 'minor', now);
    expect(decide({state: after, tier: 3}).status).toBe('notify');
  });

  test('the throttle is PER KIND — a major bump is not silenced by a minor one', () => {
    const after = recordNotified(emptyState(), '/repo', 'minor', now);
    expect(decide({kind: 'major', state: after, tier: 4}).status).toBe(
      'notify',
    );
  });

  test('throttleMinutes 0 never throttles', () => {
    const cfg = config({
      sdkVersion: {
        ...DEFAULT_HEALTH_NOTICES.sdkVersion,
        minor: {promptTier: 3, throttleMinutes: 0},
      },
    });
    const after = recordNotified(emptyState(), '/repo', 'minor', now);
    expect(decide({cfg, state: after, tier: 3}).status).toBe('notify');
  });

  test('an unreadable lastNotified timestamp stays quiet rather than notifying forever', () => {
    const state = emptyState();
    state.lastNotified['/repo'] = {minor: 'not a date'};
    expect(decide({state, tier: 3})).toEqual({
      reason: 'throttled',
      status: 'silent',
    });
  });
});

// ---------------------------------------------------------------------------
// Command classification (D1)
// ---------------------------------------------------------------------------

describe('callsiteTier', () => {
  test('doctor is tier 2', () => {
    expect(callsiteTier('doctor')).toBe(2);
  });

  test('the SELECT list is tier 3', () => {
    for (const name of ['signal', 'fix', 'add', 'worktree-new', 'rules-diff']) {
      expect([name, callsiteTier(name)]).toEqual([name, 3]);
    }
  });

  test('the NEVER list carries no notice at all', () => {
    for (const name of [
      'time-check',
      'usage-check',
      'prime',
      'update',
      'sweep',
      'skill',
      'justin-loop handoff',
    ]) {
      expect([name, callsiteTier(name)]).toEqual([name, null]);
    }
  });

  test('everything else is tier 4', () => {
    for (const name of ['config', 'repo-status', 'eas-update', 'justin-loop']) {
      expect([name, callsiteTier(name)]).toEqual([name, 4]);
    }
  });

  test('no command name at all is not a callsite', () => {
    expect(callsiteTier(null)).toBeNull();
  });

  test('aliases are classified as the command they alias', () => {
    expect(callsiteTier('worktree-setup')).toBe(callsiteTier('setup-env'));
    expect(callsiteTier('agent')).toBe(callsiteTier('skill'));
    expect(callsiteTier('agent')).toBeNull();
  });
});

describe('commandNameFromArgv', () => {
  test('reads the first command word', () => {
    expect(commandNameFromArgv(['signal'])).toBe('signal');
    expect(commandNameFromArgv(['config', 'schema'])).toBe('config');
  });

  test('no words means no command', () => {
    expect(commandNameFromArgv([])).toBeNull();
  });

  test('justin-loop handoff is ONE classification key, subcommands included', () => {
    expect(commandNameFromArgv(['justin-loop', 'handoff'])).toBe(
      'justin-loop handoff',
    );
    expect(commandNameFromArgv(['justin-loop', 'handoff', 'validate'])).toBe(
      'justin-loop handoff',
    );
    // …and the runner itself is not.
    expect(commandNameFromArgv(['justin-loop'])).toBe('justin-loop');
  });

  test('the stdout-contract commands all end up silent', () => {
    expect(
      callsiteTier(commandNameFromArgv(['justin-loop', 'handoff'])),
    ).toBeNull();
    expect(callsiteTier(commandNameFromArgv(['time-check']))).toBeNull();
  });

  test('an alias is canonicalised before classification', () => {
    expect(commandNameFromArgv(['worktree-setup'])).toBe('setup-env');
  });
});
