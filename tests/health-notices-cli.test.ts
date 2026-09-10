/**
 * The health-notice middleware, driven through the REAL CLI (home-base-uxwc D7).
 *
 * What these tests protect is not the notice text — that is unit-tested — but
 * the three things that can only break at the seam:
 *
 *  1. the notice reaches STDERR and never stdout, so `worktree-new`'s single
 *     path line, `justin-loop handoff`'s bead id and `setup-env`'s empty stdout
 *     survive having notices switched on;
 *  2. the hook commands (`time-check`, `usage-check`, `prime`) are byte-for-byte
 *     unchanged with notices on, and never load zod;
 *  3. nothing here ever reaches the network.
 *
 * HERMETIC, TWO WAYS. The state file is PRE-SEEDED with a `lastCheck` stamped
 * NOW, so the 60-minute check interval blocks the fetch before it starts, and
 * every test asserts the stamp is still that value afterwards — a fetch would
 * have moved it. Belt and braces, the child also runs with
 * `GIT_ALLOW_PROTOCOL=file`, which makes git refuse an https remote outright
 * ("fatal: transport 'https' not allowed", measured), so even a regression in
 * the interval logic cannot reach the network from this suite. Local git — all
 * doctor uses — is unaffected.
 *
 * The seed is deliberately NOT a future timestamp: a `lastCheck` from the
 * future is treated as stale and re-measured, which is the right behaviour for
 * a skewed clock and the wrong basis for a test.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {spawnSync} from 'child_process';
import {chmodSync, mkdirSync, readFileSync, writeFileSync} from 'fs';
import {dirname, join, resolve} from 'path';

import {
  healthNoticesPaths,
  STATE_SCHEMA_VERSION,
  UPGRADE_COMMAND,
  type HealthNoticesState,
} from '../src/health-notices';
import {getSdkVersion} from '../src/setup-helpers';
import {createSandbox, type Sandbox} from './sandbox';

const SRC = resolve(import.meta.dirname, '..', 'src');
const CLI = join(SRC, 'cli.ts');

/** A version no tag will ever reach, so the bump is unambiguously major. */
const FAR_FUTURE = '99.0.0';

const sandboxes: Sandbox[] = [];

afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

function newSandbox(): Sandbox {
  const created = createSandbox();
  sandboxes.push(created);
  return created;
}

interface Rig {
  /** cwd for the child — a bare project with no justin-sdk.config.json. */
  projectRoot: string;
  /** The `lastCheck.at` written into the state file. */
  seededAt: string;
  stateFile: string;
  /** Env for a child that SHOULD emit notices. */
  on: Record<string, string>;
  /** The same, with the kill switch. */
  off: Record<string, string>;
}

/**
 * A temp $XDG_STATE_HOME whose state file already says "99.0.0 exists, checked
 * just now" — inside the 60-minute interval, so no fetch is due.
 */
function rig(): Rig {
  const home = newSandbox();
  const project = newSandbox();
  const stateHome = join(home.path, 'state');
  const configHome = join(home.path, 'config');
  const {dir, file} = healthNoticesPaths({XDG_STATE_HOME: stateHome});

  const seededAt = new Date().toISOString();
  const seeded: HealthNoticesState = {
    doctorRuns: {},
    lastCheck: {at: seededAt, error: null, latest: FAR_FUTURE, ok: true},
    lastKnownLatest: {at: seededAt, version: FAR_FUTURE},
    lastNotified: {},
    schemaVersion: STATE_SCHEMA_VERSION,
  };
  mkdirSync(dir, {recursive: true});
  writeFileSync(file, JSON.stringify(seeded, null, 2) + '\n');

  // Start from process.env (bun, PATH, mise) but DROP the suite-wide kill
  // switch tests/sandbox.ts sets, and neutralise the two env vars that would
  // otherwise switch notices off inside CI.
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'JUSTIN_SDK_HEALTH_NOTICES') continue;
    if (value != null) base[key] = value;
  }
  base.CI = '';
  base.CLAUDE_CODE_REMOTE = '';
  base.XDG_CONFIG_HOME = configHome;
  base.XDG_STATE_HOME = stateHome;
  // Hard stop on the network for every child in this file: git refuses an
  // https remote under this, while local git (all doctor uses) is unaffected.
  base.GIT_ALLOW_PROTOCOL = 'file';

  return {
    off: {...base, JUSTIN_SDK_HEALTH_NOTICES: 'off'},
    on: base,
    projectRoot: project.path,
    seededAt,
    stateFile: file,
  };
}

function runCli(
  rigged: Rig,
  args: string[],
  env: Record<string, string>,
  stdin = '',
): {status: number | null; stderr: string; stdout: string} {
  const run = spawnSync(process.execPath, [CLI, ...args], {
    cwd: rigged.projectRoot,
    encoding: 'utf-8',
    env,
    input: stdin,
  });
  return {status: run.status, stderr: run.stderr, stdout: run.stdout};
}

function readSeeded(rigged: Rig): HealthNoticesState {
  return JSON.parse(
    readFileSync(rigged.stateFile, 'utf-8'),
  ) as HealthNoticesState;
}

function expectedNotice(): string {
  return `justin-sdk ${getSdkVersion()} → ${FAR_FUTURE} available (major)`;
}

describe('the notice on an eligible command', () => {
  test('goes to STDERR, leaves STDOUT byte-identical, and makes no network call', () => {
    const rigged = rig();
    // `config schema` is tier 4 (not SELECT, not NEVER) with deterministic
    // stdout and no side effects — the cheapest honest eligible command.
    const withNotices = runCli(rigged, ['config', 'schema'], rigged.on);
    const withoutNotices = runCli(rigged, ['config', 'schema'], rigged.off);

    expect(withNotices.stderr).toContain(expectedNotice());
    expect(withNotices.stderr).toContain(`  upgrade: ${UPGRADE_COMMAND}`);
    expect(withoutNotices.stderr).not.toContain('available (major)');

    // The contract that matters: the command's own output is untouched.
    expect(withNotices.stdout).toBe(withoutNotices.stdout);
    expect(withNotices.stdout).not.toContain('available (major)');
    expect(withNotices.status).toBe(withoutNotices.status);
    expect(withNotices.status).toBe(0);

    // The seeded check timestamp has not moved: no fetch was attempted.
    expect(readSeeded(rigged).lastCheck?.at).toBe(rigged.seededAt);
  });

  test('is exactly two lines', () => {
    const rigged = rig();
    const {stderr} = runCli(rigged, ['config', 'schema'], rigged.on);
    const lines = stderr.trimEnd().split('\n');
    expect(lines).toEqual([expectedNotice(), `  upgrade: ${UPGRADE_COMMAND}`]);
  });

  test('speaks once, then is throttled for the rest of the window', () => {
    const rigged = rig();
    const first = runCli(rigged, ['config', 'schema'], rigged.on);
    expect(first.stderr).toContain('available (major)');

    const second = runCli(rigged, ['config', 'schema'], rigged.on);
    expect(second.stderr).toBe('');
    expect(second.stdout).toBe(first.stdout);

    // The throttle is recorded per repo, keyed by the project root.
    const state = readSeeded(rigged);
    expect(state.lastNotified[rigged.projectRoot]?.major).toBeString();
    expect(state.lastCheck?.at).toBe(rigged.seededAt);
  });

  test('the kill switch prints nothing AND leaves the state file untouched', () => {
    const rigged = rig();
    const before = readFileSync(rigged.stateFile, 'utf-8');
    const {stderr, stdout} = runCli(rigged, ['config', 'schema'], rigged.off);
    expect(stderr).toBe('');
    expect(stdout.length).toBeGreaterThan(0);
    expect(readFileSync(rigged.stateFile, 'utf-8')).toBe(before);
  });
});

describe('the repo a notice is about (uxwc.5 F2)', () => {
  /**
   * An enrolled repo with two subdirectories, and a doctorRuns stamp already
   * fresh for it — the heartbeat must not spawn a real doctor from this suite,
   * and the throttle under test here is the NOTICE's.
   */
  function enrolledRepo(rigged: Rig): {root: string; subdirs: string[]} {
    const box = newSandbox();
    box.writeFile('.git', 'gitdir: elsewhere\n');
    box.writeFile(
      'justin-sdk.config.json',
      JSON.stringify({
        components: ['base-setup'],
        lastSynced: '2026-09-10',
        version: '0.26.0',
      }),
    );
    box.mkdir('src/deep');
    box.mkdir('scripts');

    const seeded = readSeeded(rigged);
    seeded.doctorRuns[box.path] = {
      at: new Date().toISOString(),
      error: null,
      errors: 0,
      exitCode: 0,
      passed: 10,
      warnings: 0,
    };
    writeFileSync(rigged.stateFile, JSON.stringify(seeded, null, 2) + '\n');

    return {
      root: box.path,
      subdirs: [join(box.path, 'src', 'deep'), join(box.path, 'scripts')],
    };
  }

  function runFrom(
    cwd: string,
    env: Record<string, string>,
  ): {stderr: string; stdout: string} {
    const child = spawnSync(process.execPath, [CLI, 'config', 'schema'], {
      cwd,
      encoding: 'utf-8',
      env,
      input: '',
    });
    return {stderr: child.stderr, stdout: child.stdout};
  }

  test('speaks ONCE per repo, not once per directory it is run from', () => {
    const rigged = rig();
    const {root, subdirs} = enrolledRepo(rigged);

    const first = runFrom(subdirs[0] as string, rigged.on);
    expect(first.stderr).toContain('available (major)');

    // A DIFFERENT subdirectory of the same repo, inside the throttle window.
    const second = runFrom(subdirs[1] as string, rigged.on);
    expect(second.stderr).toBe('');

    // And the stamp is keyed by the ROOT — one key, not one per directory.
    expect(Object.keys(readSeeded(rigged).lastNotified)).toEqual([root]);
  });
});

describe('a hanging network (uxwc.5 F7)', () => {
  test('the fetch is killed at 2s, not at sdk-latest 5s default', () => {
    // Hermetic: a `git` on PATH that never answers. Nothing reaches the
    // network, and the wall clock is the assertion — this timeout is paid in
    // front of a command Justin asked for, and doctor --quiet runs it from the
    // SessionStart hook.
    const rigged = rig();
    const bin = newSandbox();
    bin.writeFile('git', '#!/bin/sh\nsleep 30\n');
    chmodSync(join(bin.path, 'git'), 0o755);

    // A state file with a check STAMPED LONG AGO, so a fetch is due. (The rest
    // of this file seeds it as "just now" precisely to prevent one.)
    const stale = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const seeded = readSeeded(rigged);
    seeded.lastCheck = {at: stale, error: null, latest: FAR_FUTURE, ok: true};
    writeFileSync(rigged.stateFile, JSON.stringify(seeded, null, 2) + '\n');

    const started = Date.now();
    const {status} = runCli(rigged, ['config', 'schema'], {
      ...rigged.on,
      PATH: `${bin.path}:${rigged.on.PATH ?? ''}`,
    });
    const elapsed = Date.now() - started;

    expect(status).toBe(0);
    // The recorded failure names the timeout it was actually given...
    const after = readSeeded(rigged);
    expect(after.lastCheck?.ok).toBe(false);
    expect(after.lastCheck?.error).toContain('timed out after 2000ms');
    // ...and the command really did come back in about that long.
    expect(elapsed).toBeLessThan(4500);
    // The clock is stamped even though the check FAILED (invariant 3): one
    // doomed attempt per interval, not one per command.
    expect(after.lastCheck?.at).not.toBe(stale);
  }, 20000);
});

describe('commands that must never carry a notice', () => {
  // Each is run with notices fully ON. Any output difference from the killed
  // run is a bug — these are hooks and machine-read stdout.
  const cases: [string, string[], string][] = [
    ['time-check', ['time-check'], ''],
    ['usage-check', ['usage-check'], ''],
    ['prime --format hook', ['prime', '--format', 'hook'], ''],
  ];

  for (const [label, args, stdin] of cases) {
    test(`${label} is byte-identical with and without notices`, () => {
      const rigged = rig();
      const on = runCli(rigged, args, rigged.on, stdin);
      const off = runCli(rigged, args, rigged.off, stdin);
      expect(on.stdout).toBe(off.stdout);
      expect(on.stderr).toBe(off.stderr);
      expect(on.status).toBe(off.status);
      expect(on.stderr).not.toContain('available (major)');
      expect(readSeeded(rigged).lastCheck?.at).toBe(rigged.seededAt);
    });
  }

  test('a NEVER command records no notice at all, even a throttle stamp', () => {
    const rigged = rig();
    runCli(rigged, ['time-check'], rigged.on, '');
    expect(readSeeded(rigged).lastNotified).toEqual({});
  });
});

describe('doctor SDK_VERSION', () => {
  // Built from a char code so the file carries no literal control character.
  const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

  function doctorOutput(rigged: Rig, env: Record<string, string>): string {
    const box = newSandbox();
    box.writeFile('CLAUDE.md', '# test\n');
    box.writeFile(
      'package.json',
      JSON.stringify({
        name: 'p',
        scripts: {doctor: 'true', 'setup-env': 'true', signal: 'true'},
      }),
    );
    box.writeFile(
      'justin-sdk.config.json',
      JSON.stringify({
        components: ['base-setup'],
        lastSynced: '2026-09-10',
        version: '0.26.0',
      }),
    );
    const run = spawnSync(process.execPath, [CLI, 'doctor'], {
      cwd: box.path,
      encoding: 'utf-8',
      env,
    });
    return `${run.stdout}${run.stderr}`.replace(ANSI, '');
  }

  test('reports a newer version as a WARNING that does not fail the run', () => {
    const rigged = rig();
    const output = doctorOutput(rigged, rigged.on);
    expect(output).toContain('⚠ SDK_VERSION');
    expect(output).toContain(`→ ${FAR_FUTURE} available (major)`);
    expect(output).toContain(UPGRADE_COMMAND);
  });

  test('`doctor --fix --yes` NEVER runs an upgrade for it (D6)', () => {
    // The real hazard: remote SessionStart runs `doctor --fix --yes`, and --yes
    // bypasses requiresApproval. A fixCommand here would rewrite package.json
    // and bun.lock in every cloud session in the fleet. The check carries fix
    // TEXT only, so --fix must leave it exactly as warn-with-advice.
    const rigged = rig();
    const box = newSandbox();
    box.writeFile('CLAUDE.md', '# test\n');
    box.writeFile(
      'package.json',
      JSON.stringify({
        name: 'p',
        scripts: {doctor: 'true', 'setup-env': 'true', signal: 'true'},
      }),
    );
    box.writeFile(
      'justin-sdk.config.json',
      JSON.stringify({
        components: ['base-setup'],
        lastSynced: '2026-09-10',
        version: '0.26.0',
      }),
    );
    const before = readFileSync(join(box.path, 'package.json'), 'utf-8');

    const run = spawnSync(process.execPath, [CLI, 'doctor', '--fix', '--yes'], {
      cwd: box.path,
      encoding: 'utf-8',
      env: rigged.on,
    });
    const output = `${run.stdout}${run.stderr}`.replace(ANSI, '');

    expect(output).toContain('SDK_VERSION');
    // No attempt was made to run the upgrade, and nothing was rewritten.
    expect(output).not.toContain(`$ ${UPGRADE_COMMAND}`);
    expect(readFileSync(join(box.path, 'package.json'), 'utf-8')).toBe(before);
    // And the run did not fetch: the seeded stamp is untouched.
    expect(readSeeded(rigged).lastCheck?.at).toBe(rigged.seededAt);
  });

  test('with notices off it says "not checked" — never that the SDK is current', () => {
    const rigged = rig();
    const output = doctorOutput(rigged, rigged.off);
    expect(output).not.toContain('⚠ SDK_VERSION');
    expect(output).not.toContain('is the latest tag');
  });
});

// ---------------------------------------------------------------------------
// Hot path: what the CLI loads before it knows which command it is running
// ---------------------------------------------------------------------------

/**
 * Static (non-`await import`) module graph from an entry file.
 *
 * `import type` is skipped: TypeScript erases it, so it costs nothing at
 * runtime. Dynamic `await import(...)` is skipped by construction — the regex
 * only matches statement-position imports — which is exactly the distinction
 * under test.
 */
function staticImportGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const bare = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop();
    if (file == null || seen.has(file)) continue;
    seen.add(file);

    let source: string;
    try {
      source = readFileSync(file, 'utf-8');
    } catch {
      continue;
    }

    const pattern =
      /(?:^|\n)\s*(?:import|export)\s+(type\s+)?(?:[^;'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;
    for (const match of source.matchAll(pattern)) {
      if (match[1] != null) continue; // `import type` — erased
      const specifier = match[2];
      if (specifier == null) continue;
      if (!specifier.startsWith('.')) {
        bare.add(specifier.split('/')[0] ?? specifier);
        continue;
      }
      const base = resolve(dirname(file), specifier);
      queue.push(base.endsWith('.ts') ? base : `${base}.ts`);
    }
  }
  return bare;
}

describe('the CLI hot path', () => {
  test('zod is NOT statically reachable from cli.ts (review addition C)', () => {
    // cli.ts is the entry for the time-check and usage-check hooks, which run
    // on every prompt Justin types. zod costs 12-13ms to import against a
    // 40-50ms startup, so sdk-config (and health-notices, and doctor's two
    // config checks) must all be reached by `await import` only.
    const bare = staticImportGraph(CLI);
    expect([...bare].sort()).not.toContain('zod');
  });

  test('the graph walker actually walks (it is not silently empty)', () => {
    // Without this, the assertion above passes for the wrong reason the moment
    // the regex stops matching anything.
    const bare = staticImportGraph(CLI);
    expect(bare.has('yargs')).toBe(true);
    expect(bare.size).toBeGreaterThan(2);
  });

  test('sdk-config DOES import zod statically — so the check above is meaningful', () => {
    expect([...staticImportGraph(join(SRC, 'sdk-config.ts'))]).toContain('zod');
  });

  test('a hook command exits 0 with empty stdout on empty stdin, notices on', () => {
    const rigged = rig();
    const {status, stdout} = runCli(rigged, ['time-check'], rigged.on, '');
    expect(status).toBe(0);
    expect(stdout).toBe('');
  });
});

// ---------------------------------------------------------------------------
// The doctor heartbeat at the CLI seam (home-base-uxwc D8)
// ---------------------------------------------------------------------------

/**
 * DELIBERATELY HERMETIC, and therefore deliberately partial. Nothing in the
 * suite may spawn a real `doctor` child, so what is asserted here is the half
 * of the seam that can be proved without one: an eligible command in a real
 * enrolled repo, running the real middleware, leaves a fresh heartbeat stamp
 * exactly as it found it and says nothing.
 *
 * The other half — that the middleware DOES spawn doctor when one is due — is
 * covered by `runDoctorHeartbeat`'s own tests with an injected spawner
 * (tests/health-notices-doctor.test.ts) and was measured by hand against the
 * real CLI; see home-base-uxwc.3's notes for that run.
 */
describe('the doctor heartbeat at the CLI seam', () => {
  /**
   * A scratch repo `signal` runs cleanly in — enrolled (doctor has something to
   * check) or not, which is the one difference the heartbeat's enrollment gate
   * turns on.
   */
  function scratchProject(options: {enrolled: boolean}): string {
    const box = newSandbox();
    box.writeFile('CLAUDE.md', '# test\n');
    box.writeFile(
      'package.json',
      JSON.stringify({
        name: 'p',
        scripts: {
          doctor: 'true',
          'setup-env': 'true',
          signal: 'true',
          'signal-source:TRUE': 'true',
        },
      }),
    );
    if (options.enrolled) {
      box.writeFile(
        'justin-sdk.config.json',
        JSON.stringify({
          components: ['base-setup'],
          lastSynced: '2026-09-10',
          version: '0.26.0',
        }),
      );
    }
    return box.path;
  }

  function runIn(
    cwd: string,
    args: string[],
    env: Record<string, string>,
  ): {status: number | null; stderr: string; stdout: string} {
    const run = spawnSync(process.execPath, [CLI, ...args], {
      cwd,
      encoding: 'utf-8',
      env,
      input: '',
    });
    return {status: run.status, stderr: run.stderr, stdout: run.stdout};
  }

  test('a fresh stamp means no doctor is spawned and nothing extra is said', () => {
    const rigged = rig();
    const projectRoot = scratchProject({enrolled: true});
    const at = new Date().toISOString();

    const seeded = readSeeded(rigged);
    seeded.doctorRuns[projectRoot] = {
      at,
      error: null,
      errors: 0,
      exitCode: 0,
      passed: 10,
      warnings: 0,
    };
    writeFileSync(rigged.stateFile, JSON.stringify(seeded, null, 2) + '\n');

    const {status, stderr} = runIn(projectRoot, ['signal'], rigged.on);

    expect(status).toBe(0);
    // The version notice still fires, which is what proves notices are ON here
    // and the run is not silent for some unrelated reason.
    expect(stderr).toContain('available (major)');
    expect(stderr).not.toContain('justin-sdk doctor');
    // Untouched, to the field: a spawn would have rewritten `at`.
    expect(readSeeded(rigged).doctorRuns[projectRoot]).toEqual({
      at,
      error: null,
      errors: 0,
      exitCode: 0,
      passed: 10,
      warnings: 0,
    });
  });

  test('a repo with no justin-sdk.config.json records no heartbeat at all', () => {
    // `signal` deliberately — it is tier 3, so the tier gate lets it through
    // and the ENROLLMENT gate is the only thing that can stop the heartbeat.
    // (A tier-4 command would skip earlier and prove nothing.)
    const rigged = rig();
    const projectRoot = scratchProject({enrolled: false});

    const {status, stderr} = runIn(projectRoot, ['signal'], rigged.on);

    expect(status).toBe(0);
    expect(stderr).toContain('available (major)');
    expect(stderr).not.toContain('justin-sdk doctor');
    expect(readSeeded(rigged).doctorRuns).toEqual({});
  });
});
