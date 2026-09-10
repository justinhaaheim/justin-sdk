/**
 * The doctor heartbeat (home-base-uxwc D8, bead home-base-uxwc.3).
 *
 * NOTHING HERE SPAWNS A REAL DOCTOR. Every orchestrator test injects a
 * `DoctorSpawner` and asserts on its CALL COUNT as much as on its output: "did
 * not spawn" is the property that keeps a heartbeat from turning every command
 * into a one-second command.
 *
 * Each test builds its own `env` object rather than reading `process.env`, so
 * the suite-wide `JUSTIN_SDK_HEALTH_NOTICES=off` that tests/sandbox.ts sets is
 * NOT in scope here — these tests need notices genuinely on, and a rig that
 * inherited the kill switch would pass for the wrong reason (there is a test
 * below that proves the rig is really enabled).
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {mkdirSync, writeFileSync} from 'fs';
import {dirname, join} from 'path';

import {
  decideDoctorHeartbeat,
  DOCTOR_COMMAND,
  DOCTOR_HEARTBEAT_TIMEOUT_MS,
  doctorHeartbeatRequest,
  emptyState,
  HEALTH_NOTICES_ENV_VAR,
  healthNoticesPaths,
  parseDoctorSummary,
  printNotice,
  readState,
  renderDoctorHeartbeat,
  runDoctorHeartbeat,
  silencedChildEnv,
  writeState,
  type DoctorRunRow,
  type DoctorSpawnOutcome,
  type DoctorSpawnRequest,
  type DoctorSpawner,
  type HealthNoticesState,
} from '../src/health-notices';
import {
  DEFAULT_HEALTH_NOTICES,
  type EnvLike,
  type ResolvedHealthNoticesConfig,
} from '../src/sdk-config';
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

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

interface Rig {
  env: EnvLike;
  paths: ReturnType<typeof healthNoticesPaths>;
  projectRoot: string;
  /** Everything the state file currently holds. Throws if it is not readable. */
  state: () => HealthNoticesState;
}

/**
 * A temp HOME (state + config) and a temp project. The project is ENROLLED by
 * default — a `justin-sdk.config.json` is what makes doctor applicable at all.
 */
function rig(
  options: {healthNotices?: Record<string, unknown>; enrolled?: boolean} = {},
): Rig {
  const home = newSandbox();
  const project = newSandbox();
  const env: EnvLike = {
    HOME: home.path,
    XDG_CONFIG_HOME: join(home.path, 'config'),
    XDG_STATE_HOME: join(home.path, 'state'),
  };

  if (options.enrolled !== false) {
    project.writeFile(
      'justin-sdk.config.json',
      JSON.stringify(
        {
          components: ['base-setup'],
          lastSynced: '2026-09-10',
          version: '0.26.0',
          ...(options.healthNotices == null
            ? {}
            : {healthNotices: options.healthNotices}),
        },
        null,
        2,
      ) + '\n',
    );
  }

  const paths = healthNoticesPaths(env);
  return {
    env,
    paths,
    projectRoot: project.path,
    state: () => {
      const outcome = readState(paths);
      if (outcome.status !== 'ok') {
        throw new Error(`state unreadable: ${outcome.reason}`);
      }
      return outcome.state;
    },
  };
}

const AT = (iso: string): Date => new Date(iso);

function config(
  overrides: Partial<ResolvedHealthNoticesConfig> = {},
): ResolvedHealthNoticesConfig {
  return {...DEFAULT_HEALTH_NOTICES, ...overrides};
}

/** A real ANSI colour sequence, built so this file carries no ESC byte. */
const SGR = (code: string): string => `${String.fromCharCode(27)}[${code}m`;

/**
 * A doctor that passed all 10 checks, in `--quiet`'s all-pass one-liner form —
 * COLOURED, because the real thing is and the parser has to strip it.
 */
const QUIET_ALL_PASS = `${SGR('32')}✓${SGR('0')} All 10 checks passed. ${SGR('2')}[35ms]${SGR('0')}\n`;

/** `--quiet` with something to report: the long form, with its `Ran` footer. */
const QUIET_ONE_FAIL =
  ` ${SGR('31')}✗${SGR('0')} PKG_SCRIPTS [0ms]\n` +
  '     Missing package.json scripts: doctor\n' +
  '\n' +
  ' 9 pass\n' +
  ' 1 fail\n' +
  'Ran 10 checks. [37ms]\n';

function spy(outcome: DoctorSpawnOutcome): {
  calls: DoctorSpawnRequest[];
  spawner: DoctorSpawner;
} {
  const calls: DoctorSpawnRequest[] = [];
  return {
    calls,
    spawner: async (request) => {
      calls.push(request);
      return outcome;
    },
  };
}

function passed(stdout = QUIET_ALL_PASS): DoctorSpawnOutcome {
  return {error: null, exitCode: 0, stderr: '', stdout};
}

/** Run `fn` with process.stderr captured, so printNotice's target is provable. */
async function captureStderr<T>(
  fn: () => Promise<T>,
): Promise<{result: T; stderr: string}> {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(
      typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(),
    );
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = await fn();
    return {result, stderr: chunks.join('')};
  } finally {
    process.stderr.write = original;
  }
}

// ---------------------------------------------------------------------------
// parseDoctorSummary
// ---------------------------------------------------------------------------

describe('parseDoctorSummary', () => {
  test('reads the all-pass one-liner, colours and all', () => {
    expect(parseDoctorSummary(QUIET_ALL_PASS)).toEqual({
      errors: 0,
      passed: 10,
      warnings: 0,
    });
  });

  test('reads the long form and its per-severity lines', () => {
    expect(parseDoctorSummary(QUIET_ONE_FAIL)).toEqual({
      errors: 1,
      passed: 9,
      warnings: 0,
    });
  });

  test('a missing line under the Ran footer is a MEASURED zero', () => {
    // printSummary omits ` N warn` only when N is 0, and it writes the footer
    // last — so footer-present + line-absent really does mean zero.
    const withWarn = ' 9 pass\n 1 warn\nRan 10 checks. [3ms]\n';
    expect(parseDoctorSummary(withWarn)).toEqual({
      errors: 0,
      passed: 9,
      warnings: 1,
    });
  });

  test('output with NEITHER anchor is all null — never 0/0/0', () => {
    // The case that matters: a child killed mid-run. Its partial output can
    // contain ` 9 pass` and still be missing the footer, and reporting that as
    // "9 passed, nothing failed" would file a killed run as a clean one.
    expect(parseDoctorSummary(' 9 pass\n')).toEqual({
      errors: null,
      passed: null,
      warnings: null,
    });
    expect(parseDoctorSummary('')).toEqual({
      errors: null,
      passed: null,
      warnings: null,
    });
    expect(parseDoctorSummary('bun: command not found\n')).toEqual({
      errors: null,
      passed: null,
      warnings: null,
    });
  });

  test('"checks passed" in the one-liner is not mistaken for a pass COUNT line', () => {
    // `/(\d+) pass/` unanchored would read "All 10 checks passed." twice over.
    expect(parseDoctorSummary(QUIET_ALL_PASS).passed).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// renderDoctorHeartbeat
// ---------------------------------------------------------------------------

const NO_COUNTS = {errors: null, passed: null, warnings: null};

describe('renderDoctorHeartbeat', () => {
  test('says NOTHING on a clean run by default', () => {
    expect(
      renderDoctorHeartbeat({
        counts: {errors: 0, passed: 10, warnings: 0},
        outcome: passed(),
        projectRoot: '/repo',
        showOnPass: false,
      }),
    ).toEqual([]);
  });

  test('showOnPass prints exactly one line, with both counts', () => {
    expect(
      renderDoctorHeartbeat({
        counts: {errors: 0, passed: 18, warnings: 1},
        outcome: passed(),
        projectRoot: '/repo',
        showOnPass: true,
      }),
    ).toEqual(['✅ justin-sdk doctor: 18 pass, 1 warn']);
  });

  test('showOnPass with counts it could not read says so, not "0 pass"', () => {
    expect(
      renderDoctorHeartbeat({
        counts: NO_COUNTS,
        outcome: passed('nothing recognisable\n'),
        projectRoot: '/repo',
        showOnPass: true,
      }),
    ).toEqual(['✅ justin-sdk doctor: summary unparsed']);
  });

  test('a non-zero exit prints the child output VERBATIM, whatever showOnPass says', () => {
    const lines = renderDoctorHeartbeat({
      counts: {errors: 1, passed: 9, warnings: 0},
      outcome: {
        error: null,
        exitCode: 1,
        stderr: 'a stderr line\n',
        stdout: QUIET_ONE_FAIL,
      },
      projectRoot: '/repo',
      showOnPass: false,
    });
    expect(lines[0]).toBe(
      'justin-sdk doctor (heartbeat) found errors in /repo:',
    );
    expect(lines).toContain('     Missing package.json scripts: doctor');
    expect(lines).toContain('a stderr line');
    expect(lines.at(-1)).toBe(`  full run: ${DOCTOR_COMMAND}`);
  });

  test('a failed spawn prints one line naming the reason', () => {
    expect(
      renderDoctorHeartbeat({
        counts: NO_COUNTS,
        outcome: {
          error: 'spawnSync bun ETIMEDOUT',
          exitCode: null,
          stderr: '',
          stdout: '',
        },
        projectRoot: '/repo',
        showOnPass: true,
      }),
    ).toEqual([
      'justin-sdk doctor heartbeat could not run: spawnSync bun ETIMEDOUT',
    ]);
  });

  test('an outcome with no error AND no exit code is still a failure', () => {
    // The shape must be unrepresentable in practice, but if it ever arrives it
    // is reported as "could not run", never rendered as a pass.
    expect(
      renderDoctorHeartbeat({
        counts: NO_COUNTS,
        outcome: {error: null, exitCode: null, stderr: '', stdout: ''},
        projectRoot: '/repo',
        showOnPass: false,
      })[0],
    ).toContain('could not run');
  });
});

// ---------------------------------------------------------------------------
// decideDoctorHeartbeat — the pure gate
// ---------------------------------------------------------------------------

describe('decideDoctorHeartbeat', () => {
  const base = {
    now: AT('2026-09-10T12:00:00.000Z'),
    projectRoot: '/repo',
    state: emptyState(),
  };

  test('runs for an eligible command with nothing recorded', () => {
    expect(
      decideDoctorHeartbeat({...base, commandName: 'signal', config: config()}),
    ).toEqual({status: 'run'});
  });

  test('DOCTOR ITSELF never triggers a heartbeat', () => {
    expect(
      decideDoctorHeartbeat({...base, commandName: 'doctor', config: config()}),
    ).toEqual({reason: 'is-doctor', status: 'skip'});
  });

  test('a NEVER command is not eligible', () => {
    expect(
      decideDoctorHeartbeat({
        ...base,
        commandName: 'time-check',
        config: config(),
      }),
    ).toEqual({reason: 'not-eligible', status: 'skip'});
  });

  test('the master switch wins over everything', () => {
    expect(
      decideDoctorHeartbeat({
        ...base,
        commandName: 'signal',
        config: config({enabled: false}),
      }),
    ).toEqual({reason: 'disabled', status: 'skip'});
  });

  test('a tier-2 promptTier silences every callsite but doctor — i.e. all of them', () => {
    // signal is tier 3; doctor's own tier 2 is excluded by name above. So
    // `doctor.promptTier: 2` switches the heartbeat off entirely, and 1 more so.
    for (const promptTier of [1, 2] as const) {
      expect(
        decideDoctorHeartbeat({
          ...base,
          commandName: 'signal',
          config: config({doctor: {...config().doctor, promptTier}}),
        }),
      ).toEqual({reason: 'tier', status: 'skip'});
    }
  });

  test('tier 4 reaches a command that is neither SELECT nor NEVER', () => {
    expect(
      decideDoctorHeartbeat({
        ...base,
        commandName: 'repo-status',
        config: config({doctor: {...config().doctor, promptTier: 3}}),
      }),
    ).toEqual({reason: 'tier', status: 'skip'});
    expect(
      decideDoctorHeartbeat({
        ...base,
        commandName: 'repo-status',
        config: config({doctor: {...config().doctor, promptTier: 4}}),
      }),
    ).toEqual({status: 'run'});
  });

  function withRun(at: string): HealthNoticesState {
    return {
      ...emptyState(),
      doctorRuns: {
        '/repo': {
          at,
          error: null,
          errors: 0,
          exitCode: 0,
          passed: 10,
          warnings: 0,
        },
      },
    };
  }

  test('throttles inside the interval and runs again after it', () => {
    const inside = decideDoctorHeartbeat({
      ...base,
      commandName: 'signal',
      config: config(),
      state: withRun('2026-09-10T11:30:00.000Z'), // 30m < 60m
    });
    expect(inside).toEqual({reason: 'throttled', status: 'skip'});

    const outside = decideDoctorHeartbeat({
      ...base,
      commandName: 'signal',
      config: config(),
      state: withRun('2026-09-10T10:30:00.000Z'), // 90m > 60m
    });
    expect(outside).toEqual({status: 'run'});
  });

  test('the throttle is PER REPO', () => {
    expect(
      decideDoctorHeartbeat({
        ...base,
        commandName: 'signal',
        config: config(),
        projectRoot: '/other-repo',
        state: withRun('2026-09-10T11:59:00.000Z'),
      }),
    ).toEqual({status: 'run'});
  });

  test('an UNREADABLE or FUTURE stamp runs rather than going quiet forever', () => {
    // Same self-healing rule as the notice throttle: only a run rewrites this
    // stamp, so treating one we cannot read as "already ran" would silence the
    // repo permanently and invisibly.
    for (const at of ['not-a-date', '2099-01-01T00:00:00.000Z']) {
      expect(
        decideDoctorHeartbeat({
          ...base,
          commandName: 'signal',
          config: config(),
          state: withRun(at),
        }),
      ).toEqual({status: 'run'});
    }
  });
});

// ---------------------------------------------------------------------------
// doctorHeartbeatRequest — what the child is actually asked to be
// ---------------------------------------------------------------------------

describe('doctorHeartbeatRequest', () => {
  test('is the RUNNING SDK, in the project root, with the kill switch set', () => {
    const request = doctorHeartbeatRequest({
      cwd: '/repo',
      env: {PATH: '/usr/bin'},
      timeoutMs: 1234,
    });
    expect(request.command).toBe(process.execPath);
    expect(request.args.at(0)).toEndWith('/src/cli.ts');
    expect(request.args.slice(1)).toEqual(['doctor', '--quiet']);
    expect(request.cwd).toBe('/repo');
    expect(request.timeoutMs).toBe(1234);
    // Without this the child would start a heartbeat of its own.
    expect(request.env[HEALTH_NOTICES_ENV_VAR]).toBe('off');
    expect(request.env.PATH).toBe('/usr/bin');
  });

  test('silencedChildEnv overrides an inherited ON value', () => {
    expect(silencedChildEnv({JUSTIN_SDK_HEALTH_NOTICES: 'on'})).toEqual({
      JUSTIN_SDK_HEALTH_NOTICES: 'off',
    });
  });
});

// ---------------------------------------------------------------------------
// runDoctorHeartbeat — the orchestrator, with an injected spawner
// ---------------------------------------------------------------------------

describe('runDoctorHeartbeat', () => {
  test('runs once, prints nothing on a clean run, and records the counts', async () => {
    const rigged = rig();
    const {calls, spawner} = spy(passed());

    const {result, stderr} = await captureStderr(() =>
      runDoctorHeartbeat({
        commandName: 'signal',
        env: rigged.env,
        projectRoot: rigged.projectRoot,
        spawner,
      }),
    );

    expect(result.status).toBe('ran');
    expect(stderr).toBe('');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cwd).toBe(rigged.projectRoot);
    expect(calls[0]?.timeoutMs).toBe(DOCTOR_HEARTBEAT_TIMEOUT_MS);

    const row = rigged.state().doctorRuns[rigged.projectRoot];
    expect(row).toEqual({
      at: expect.any(String) as unknown as string,
      error: null,
      errors: 0,
      exitCode: 0,
      passed: 10,
      warnings: 0,
    } satisfies DoctorRunRow);
  });

  test('the SECOND run inside the interval spawns nothing', async () => {
    const rigged = rig();
    const {calls, spawner} = spy(passed());
    const options = {
      commandName: 'signal',
      env: rigged.env,
      projectRoot: rigged.projectRoot,
      spawner,
    };

    expect((await runDoctorHeartbeat(options)).status).toBe('ran');
    const first = rigged.state().doctorRuns[rigged.projectRoot]?.at;

    const second = await runDoctorHeartbeat(options);
    expect(second).toEqual({reason: 'throttled', status: 'skipped'});
    expect(calls).toHaveLength(1);
    expect(rigged.state().doctorRuns[rigged.projectRoot]?.at).toBe(first);
  });

  test('showOnPass puts ONE line on stderr, and nothing on stdout', async () => {
    const rigged = rig({healthNotices: {doctor: {showOnPass: true}}});
    const {spawner} = spy(passed());

    const {stderr} = await captureStderr(() =>
      runDoctorHeartbeat({
        commandName: 'signal',
        env: rigged.env,
        projectRoot: rigged.projectRoot,
        spawner,
      }),
    );
    expect(stderr).toBe('✅ justin-sdk doctor: 10 pass, 0 warn\n');
  });

  test('a non-zero exit reaches STDERR with the failing check in it', async () => {
    const rigged = rig();
    const {spawner} = spy({
      error: null,
      exitCode: 1,
      stderr: '',
      stdout: QUIET_ONE_FAIL,
    });

    const {result, stderr} = await captureStderr(() =>
      runDoctorHeartbeat({
        commandName: 'signal',
        env: rigged.env,
        projectRoot: rigged.projectRoot,
        spawner,
      }),
    );

    expect(stderr).toContain('found errors in');
    expect(stderr).toContain('Missing package.json scripts: doctor');
    expect(stderr).toContain(`full run: ${DOCTOR_COMMAND}`);
    expect(result.status).toBe('ran');
    if (result.status !== 'ran') throw new Error('unreachable');
    expect(result.row.exitCode).toBe(1);
    expect(result.row.errors).toBe(1);
    expect(result.row.passed).toBe(9);
  });

  test('a PARSE MISS records null counts, never zeroes', async () => {
    const rigged = rig();
    const {spawner} = spy(passed('doctor said something new\n'));

    const result = await runDoctorHeartbeat({
      commandName: 'signal',
      env: rigged.env,
      projectRoot: rigged.projectRoot,
      spawner,
    });

    expect(result.status).toBe('ran');
    if (result.status !== 'ran') throw new Error('unreachable');
    expect(result.row).toMatchObject({
      error: null,
      errors: null,
      exitCode: 0,
      passed: null,
      warnings: null,
    });
    // And it survives the round trip through the state file.
    expect(rigged.state().doctorRuns[rigged.projectRoot]?.passed).toBeNull();
  });

  test('a TIMED-OUT child records a failure — its partial output is not parsed', async () => {
    const rigged = rig();
    // Deliberately partial output that CONTAINS a pass count. A parser that
    // ran on it would file a killed doctor as "9 passed, nothing failed".
    const {spawner} = spy({
      error: 'spawnSync bun ETIMEDOUT',
      exitCode: null,
      stderr: '',
      stdout: ' 9 pass\nRan 10 checks. [37ms]\n',
    });

    const {result, stderr} = await captureStderr(() =>
      runDoctorHeartbeat({
        commandName: 'signal',
        env: rigged.env,
        projectRoot: rigged.projectRoot,
        spawner,
      }),
    );

    expect(stderr).toBe(
      'justin-sdk doctor heartbeat could not run: spawnSync bun ETIMEDOUT\n',
    );
    if (result.status !== 'ran') throw new Error('unreachable');
    expect(result.row).toMatchObject({
      error: 'spawnSync bun ETIMEDOUT',
      errors: null,
      exitCode: null,
      passed: null,
      warnings: null,
    });
  });

  test('a failed run IS recorded, so it is not retried on the next command', async () => {
    const rigged = rig();
    const {calls, spawner} = spy({
      error: 'Executable not found in $PATH',
      exitCode: null,
      stderr: '',
      stdout: '',
    });
    const options = {
      commandName: 'signal',
      env: rigged.env,
      projectRoot: rigged.projectRoot,
      spawner,
    };

    await captureStderr(() => runDoctorHeartbeat(options));
    const second = await captureStderr(() => runDoctorHeartbeat(options));

    expect(second.result).toEqual({reason: 'throttled', status: 'skipped'});
    expect(second.stderr).toBe('');
    expect(calls).toHaveLength(1);
  });

  test('a spawner that THROWS becomes a recorded failure, not an exception', async () => {
    const rigged = rig();
    const spawner: DoctorSpawner = async () => {
      throw new Error('the seam blew up');
    };

    const {result, stderr} = await captureStderr(() =>
      runDoctorHeartbeat({
        commandName: 'signal',
        env: rigged.env,
        projectRoot: rigged.projectRoot,
        spawner,
      }),
    );

    expect(stderr).toContain('could not run: the seam blew up');
    if (result.status !== 'ran') throw new Error('unreachable');
    expect(result.row.error).toBe('the seam blew up');
    expect(result.row.exitCode).toBeNull();
  });

  test('an outcome with no error AND no exit code records a REASON, not a null', async () => {
    // Unreachable from the real spawner, but the type permits it, and a row
    // reading {error: null, exitCode: null} would be silently ambiguous.
    const rigged = rig();
    const {spawner} = spy({
      error: null,
      exitCode: null,
      stderr: '',
      stdout: QUIET_ALL_PASS,
    });

    const {result} = await captureStderr(() =>
      runDoctorHeartbeat({
        commandName: 'signal',
        env: rigged.env,
        projectRoot: rigged.projectRoot,
        spawner,
      }),
    );

    if (result.status !== 'ran') throw new Error('unreachable');
    expect(result.row.error).toBe('the child produced no exit code');
    expect(result.row.passed).toBeNull();
  });

  test('DOCTOR ITSELF spawns nothing, through the real orchestrator', async () => {
    const rigged = rig();
    const {calls, spawner} = spy(passed());

    const result = await runDoctorHeartbeat({
      commandName: 'doctor',
      env: rigged.env,
      projectRoot: rigged.projectRoot,
      spawner,
    });

    expect(result).toEqual({reason: 'is-doctor', status: 'skipped'});
    expect(calls).toHaveLength(0);
  });

  test('a hook command spawns nothing and writes no state file at all', async () => {
    const rigged = rig();
    const {calls, spawner} = spy(passed());

    const result = await runDoctorHeartbeat({
      commandName: 'time-check',
      env: rigged.env,
      projectRoot: rigged.projectRoot,
      spawner,
    });

    expect(result).toEqual({reason: 'not-eligible', status: 'skipped'});
    expect(calls).toHaveLength(0);
    expect(readState(rigged.paths).status).toBe('absent');
  });

  test('a project with NO justin-sdk.config.json is skipped silently', async () => {
    const rigged = rig({enrolled: false});
    const {calls, spawner} = spy(passed());

    const {result, stderr} = await captureStderr(() =>
      runDoctorHeartbeat({
        commandName: 'signal',
        env: rigged.env,
        projectRoot: rigged.projectRoot,
        spawner,
      }),
    );

    expect(result).toEqual({reason: 'not-enrolled', status: 'skipped'});
    expect(calls).toHaveLength(0);
    expect(stderr).toBe('');
  });

  test('a config that is not JSON is skipped — doctor would only throw on it', async () => {
    const rigged = rig({enrolled: false});
    writeFileSync(
      join(rigged.projectRoot, 'justin-sdk.config.json'),
      '{ not json',
    );
    const {calls, spawner} = spy(passed());

    const result = await runDoctorHeartbeat({
      commandName: 'signal',
      env: rigged.env,
      projectRoot: rigged.projectRoot,
      spawner,
    });

    expect(result).toEqual({reason: 'not-enrolled', status: 'skipped'});
    expect(calls).toHaveLength(0);
  });

  test('a schema-violating config still gets a heartbeat', async () => {
    // Loose validation is the point (D9): an unknown or wrong-typed key must
    // not stop doctor from being run — it is doctor that reports it.
    const rigged = rig({healthNotices: {doctor: {intervalMinutes: 'soon'}}});
    const {calls, spawner} = spy(passed());

    const result = await runDoctorHeartbeat({
      commandName: 'signal',
      env: rigged.env,
      projectRoot: rigged.projectRoot,
      spawner,
    });

    expect(result.status).toBe('ran');
    expect(calls).toHaveLength(1);
  });

  test('an unwritable state dir spawns NOTHING (D4)', async () => {
    const rigged = rig();
    // A regular file where the state directory has to be: mkdir fails ENOTDIR.
    mkdirSync(dirname(rigged.paths.dir), {recursive: true});
    writeFileSync(rigged.paths.dir, 'not a directory');
    const {calls, spawner} = spy(passed());

    const result = await runDoctorHeartbeat({
      commandName: 'signal',
      env: rigged.env,
      projectRoot: rigged.projectRoot,
      spawner,
    });

    expect(result).toEqual({reason: 'state-unwritable', status: 'skipped'});
    expect(calls).toHaveLength(0);
  });

  test('the kill switch in the env stops it before anything is spawned', async () => {
    const rigged = rig();
    const {calls, spawner} = spy(passed());

    const result = await runDoctorHeartbeat({
      commandName: 'signal',
      env: {...rigged.env, [HEALTH_NOTICES_ENV_VAR]: 'off'},
      projectRoot: rigged.projectRoot,
      spawner,
    });

    expect(result).toEqual({reason: 'disabled', status: 'skipped'});
    expect(calls).toHaveLength(0);
  });

  test('the rig itself really is enabled — otherwise every test above is vacuous', async () => {
    const rigged = rig();
    const {calls, spawner} = spy(passed());
    await runDoctorHeartbeat({
      commandName: 'signal',
      env: rigged.env,
      projectRoot: rigged.projectRoot,
      spawner,
    });
    expect(calls).toHaveLength(1);
    expect(rigged.env[HEALTH_NOTICES_ENV_VAR]).toBeUndefined();
  });

  test('it does not clobber a throttle stamp the version notice just wrote', async () => {
    // The concrete hazard: both probes run in the same middleware, and the
    // heartbeat writes second. Holding a state snapshot from before the
    // notice's write would erase lastNotified and un-throttle every notice.
    const rigged = rig();
    const seeded: HealthNoticesState = {
      ...emptyState(),
      lastNotified: {[rigged.projectRoot]: {minor: '2026-09-10T11:00:00.000Z'}},
    };
    expect(writeState(rigged.paths, seeded)).toBe(true);

    const {spawner} = spy(passed());
    await runDoctorHeartbeat({
      commandName: 'signal',
      env: rigged.env,
      projectRoot: rigged.projectRoot,
      spawner,
    });

    const after = rigged.state();
    expect(after.lastNotified[rigged.projectRoot]?.minor).toBe(
      '2026-09-10T11:00:00.000Z',
    );
    expect(after.doctorRuns[rigged.projectRoot]?.passed).toBe(10);
  });

  test('printNotice is the writer, so a heartbeat can never reach stdout', async () => {
    // Guard for the one invariant a unit test can state directly: the module
    // has exactly one writer, and it is stderr.
    const onStdout: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => {
      onStdout.push('STDOUT');
      return true;
    }) as typeof process.stdout.write;
    let captured = '';
    try {
      captured = (
        await captureStderr(async () => {
          printNotice(['a line']);
        })
      ).stderr;
    } finally {
      process.stdout.write = original;
    }
    expect(onStdout).toEqual([]);
    expect(captured).toBe('a line\n');
  });
});
