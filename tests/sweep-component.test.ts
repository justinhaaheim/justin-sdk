/**
 * Tests for `sweep --component <name>` — the payload scope filter
 * (home-base-4qsc, t6a0.21 D2a/D11).
 *
 * THE CONTRACT UNDER TEST: a component-scoped sweep is PIN-NEUTRAL. Running it
 * must leave package.json and justin-sdk.config.json byte-identical, so fixing
 * a typo in a rules file cannot ship an SDK version upgrade to twelve repos.
 *
 * WHY THE PIN-NEUTRALITY TESTS ARE NOT VACUOUS — read before "simplifying"
 * them: skipping the pin step is NOT sufficient. Every component installer
 * chains runBaseSetup, which stamps `version`/`lastSynced` into
 * justin-sdk.config.json and adds the SDK pin to package.json when it is
 * missing. Each byte-identity test therefore has a SIBLING negative control in
 * this file that runs the same component WITHOUT the payload wrapper and
 * asserts the drift really happens. If a future refactor drops the neutrality
 * guard, the byte-identity test fails; if a refactor makes the drift
 * impossible, the negative control fails and these tests can be retired
 * together, deliberately.
 *
 * The whole per-repo pipeline is not run here (it hydrates with a real
 * `bun install` and gates on `bunx …/justin-sdk doctor` resolved from the
 * TARGET's pin, i.e. network + an installed SDK). The payload — the one step
 * `--component` changes — is exercised directly; enrollment, argv validation
 * and dry-run are exercised through runSweep against real git fixtures, all of
 * which return before any worktree is created.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'fs';
import {join} from 'path';

import {runBaseSetup} from '../src/base-setup';
import {runComponentByName} from '../src/components';
import {
  getSdkVersion,
  readJson,
  todayIsoDate,
  writeJson,
} from '../src/setup-helpers';
import {
  applySweepPayload,
  committedConfigComponents,
  holdPinAfterGates,
  isEnrolledIn,
  parseComponentOption,
  parseConfigComponents,
  planSweepPayload,
  readPinSnapshot,
  restorePinSnapshot,
  runSweep,
  SWEEP_BRANCH,
  SWEEP_WORKTREE_SEGMENTS,
  sweepCommitMessage,
} from '../src/sweep';
import {git, initRepo} from './git-fixtures';
import {createSandbox, type Sandbox} from './sandbox';

const SDK_PKG = '@justinhaaheim/justin-sdk';
/** Deliberately not a real tag: the tests must never resolve this anywhere. */
const OLD_PIN = 'github:justinhaaheim/justin-sdk#v0.0.1-fixture';
const OLD_VERSION = '0.0.1-fixture';
const OLD_SYNCED = '2000-01-01';

const sandboxes: Sandbox[] = [];
function track(sb: Sandbox): Sandbox {
  sandboxes.push(sb);
  return sb;
}
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

// ---------------------------------------------------------------------------
// Pure decisions
// ---------------------------------------------------------------------------

describe('parseComponentOption', () => {
  test('absent means the historical full payload', () => {
    expect(parseComponentOption(undefined)).toEqual({
      component: null,
      ok: true,
    });
  });

  test('accepts the short name', () => {
    expect(parseComponentOption('gitignore')).toEqual({
      component: 'gitignore',
      ok: true,
    });
  });

  test('accepts the -setup config name and normalizes it', () => {
    expect(parseComponentOption('gitignore-setup')).toEqual({
      component: 'gitignore',
      ok: true,
    });
  });

  test('an unknown name is an error naming the input and the valid names', () => {
    const result = parseComponentOption('no-such-component');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('no-such-component');
    expect(result.error).toContain('gitignore');
  });

  test('critical-rules validates — the component this flag exists for', () => {
    // `sweep --component critical-rules` IS the push channel of t6a0.21 D2a.
    // Dispatch A wrote this arm as an unknown-name case because the component
    // did not exist yet (home-base-we85 registered it).
    expect(parseComponentOption('critical-rules')).toEqual({
      component: 'critical-rules',
      ok: true,
    });
    expect(parseComponentOption('critical-rules-setup')).toEqual({
      component: 'critical-rules',
      ok: true,
    });
  });

  test('an empty string is an error, NOT a silent full sweep', () => {
    // The dangerous direction: `--component ''` falling through to the default
    // payload would ship a pin bump to the whole fleet.
    expect(parseComponentOption('').ok).toBe(false);
  });
});

describe('planSweepPayload', () => {
  test('null → full', () => {
    expect(planSweepPayload(null)).toEqual({mode: 'full'});
  });

  test('a component → component mode', () => {
    expect(planSweepPayload('gitignore')).toEqual({
      component: 'gitignore',
      mode: 'component',
    });
  });
});

describe('sweepCommitMessage', () => {
  test('the full-sweep message is unchanged (regression pin)', () => {
    expect(sweepCommitMessage({mode: 'full'})).toBe(
      'chore: justin-sdk sweep — bump pin + re-apply components (automated, home-base-j2n7)',
    );
  });

  test('a component-scoped commit names the component and says the pin held', () => {
    const message = sweepCommitMessage({
      component: 'gitignore',
      mode: 'component',
    });
    expect(message).toContain('gitignore');
    expect(message).toContain('pin unchanged');
    expect(message).not.toContain('bump pin');
  });
});

describe('parseConfigComponents', () => {
  test('reads the components array', () => {
    expect(
      parseConfigComponents('{"components":["base-setup","beads-setup"]}'),
    ).toEqual({components: ['base-setup', 'beads-setup'], ok: true});
  });

  test('a config with no components key declares none (a real, readable state)', () => {
    expect(parseConfigComponents('{"version":"1.0.0"}')).toEqual({
      components: [],
      ok: true,
    });
  });

  test('unparseable content is NOT an empty list', () => {
    // Failure is not empty: a corrupt config must never read as "not enrolled".
    const result = parseConfigComponents('{ this is not json');
    expect(result.ok).toBe(false);
  });

  test('a non-array components field is an error, not a coerced empty list', () => {
    expect(parseConfigComponents('{"components":"beads-setup"}').ok).toBe(
      false,
    );
  });
});

describe('isEnrolledIn', () => {
  test('matches on the -setup config name', () => {
    expect(isEnrolledIn(['base-setup', 'gitignore-setup'], 'gitignore')).toBe(
      true,
    );
  });

  test('a repo without the component is not enrolled', () => {
    expect(isEnrolledIn(['base-setup', 'beads-setup'], 'gitignore')).toBe(
      false,
    );
  });
});

describe('committedConfigComponents', () => {
  test('reads the config as committed on the branch', () => {
    const sb = track(createSandbox());
    const repo = initRepo(sb, 'repo', {
      'justin-sdk.config.json':
        '{"components":["base-setup","gitignore-setup"]}',
    });
    expect(committedConfigComponents(repo, 'main')).toEqual({
      components: ['base-setup', 'gitignore-setup'],
      ok: true,
    });
  });

  test('an UNCOMMITTED config is a distinct failure, not "no components"', () => {
    const sb = track(createSandbox());
    const repo = initRepo(sb, 'repo', {'a.txt': 'a\n'});
    // Present in the working tree (so discovery would find the repo) but never
    // committed — the sweep branches from the commit, so this must not read as
    // an enrollment answer either way.
    writeJson(join(repo, 'justin-sdk.config.json'), {
      components: ['gitignore-setup'],
    });
    const result = committedConfigComponents(repo, 'main');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toContain('not committed');
  });
});

// ---------------------------------------------------------------------------
// Fixtures: an already-enrolled project, aged onto an older SDK pin
// ---------------------------------------------------------------------------

interface Project {
  root: string;
  pkgPath: string;
  cfgPath: string;
}

/**
 * A project in the state every real sweep target is in: base-setup applied,
 * the target component already registered — so the ONLY thing a re-run would
 * move is the pin. `agePin: false` leaves the SDK devDep off package.json
 * entirely, which is the one code path that WRITES the pin there.
 */
async function enrolledProject(options?: {
  declarePin?: boolean;
}): Promise<Project> {
  const declarePin = options?.declarePin ?? true;
  const sb = track(createSandbox());
  const root = join(sb.path, 'repo');
  mkdirSync(root, {recursive: true});
  writeJson(join(root, 'package.json'), {name: 'fixture', version: '0.0.1'});

  const exitCode = await runBaseSetup({
    extraComponents: ['gitignore-setup'],
    projectRoot: root,
    quiet: true,
  });
  expect(exitCode).toBe(0);

  const cfgPath = join(root, 'justin-sdk.config.json');
  const pkgPath = join(root, 'package.json');

  // Age the recorded SDK state so a bump would be visible.
  const cfg = readJson(cfgPath) ?? {};
  cfg.version = OLD_VERSION;
  cfg.lastSynced = OLD_SYNCED;
  writeJson(cfgPath, cfg);

  const pkg = readJson(pkgPath) ?? {};
  const devDeps = (pkg.devDependencies as Record<string, string>) ?? {};
  if (declarePin) {
    devDeps[SDK_PKG] = OLD_PIN;
    pkg.devDependencies = devDeps;
  } else {
    delete devDeps[SDK_PKG];
    if (Object.keys(devDeps).length === 0) delete pkg.devDependencies;
    else pkg.devDependencies = devDeps;
  }
  writeJson(pkgPath, pkg);

  return {cfgPath, pkgPath, root};
}

// ---------------------------------------------------------------------------
// THE acceptance test: a component-scoped payload is pin-neutral
// ---------------------------------------------------------------------------

describe('applySweepPayload (component mode) — the pin-neutrality contract', () => {
  test('applies the component AND leaves package.json + justin-sdk.config.json byte-identical', async () => {
    const project = await enrolledProject();
    const pkgBefore = readFileSync(project.pkgPath, 'utf-8');
    const cfgBefore = readFileSync(project.cfgPath, 'utf-8');
    const gitignoreBefore = readFileSync(
      join(project.root, '.gitignore'),
      'utf-8',
    );

    const result = await applySweepPayload(project.root, {
      component: 'gitignore',
      mode: 'component',
    });

    expect(result.ok).toBe(true);

    // The component really ran — without this the byte-identity below would
    // also pass for a payload that did nothing at all.
    const gitignoreAfter = readFileSync(
      join(project.root, '.gitignore'),
      'utf-8',
    );
    expect(gitignoreAfter).not.toBe(gitignoreBefore);
    expect(gitignoreAfter).toContain('.claude/worktrees/');

    // …and the pin did not move. Byte-for-byte, both files.
    expect(readFileSync(project.pkgPath, 'utf-8')).toBe(pkgBefore);
    expect(readFileSync(project.cfgPath, 'utf-8')).toBe(cfgBefore);

    // Field-level too, so a failure says WHICH field drifted.
    expect((readJson(project.cfgPath) ?? {}).version).toBe(OLD_VERSION);
    expect((readJson(project.cfgPath) ?? {}).lastSynced).toBe(OLD_SYNCED);
    const devDeps = (readJson(project.pkgPath) ?? {}).devDependencies as Record<
      string,
      string
    >;
    expect(devDeps[SDK_PKG]).toBe(OLD_PIN);
  });

  test('NEGATIVE CONTROL: the same component run WITHOUT the payload wrapper DOES move the pin', async () => {
    // This is what `sweep --component` would silently do without the guard:
    // stamp the orchestrator's version into a repo still pinned to an older
    // SDK — a config that lies about which SDK the repo resolves.
    const project = await enrolledProject();

    const exitCode = await runComponentByName('gitignore', {
      force: false,
      noCommit: true,
      projectRoot: project.root,
      quiet: true,
    });
    expect(exitCode).toBe(0);

    const cfg = readJson(project.cfgPath) ?? {};
    expect(cfg.version).toBe(getSdkVersion());
    expect(cfg.version).not.toBe(OLD_VERSION);
    expect(cfg.lastSynced).toBe(todayIsoDate());
  });

  test('a component that would ADD the SDK pin to package.json has it taken back out', async () => {
    const project = await enrolledProject({declarePin: false});
    const pkgBefore = readFileSync(project.pkgPath, 'utf-8');
    // No dependency declaration at all — not even an empty container. (The
    // script aliases mention the package name, so assert on the field.)
    expect((readJson(project.pkgPath) ?? {}).devDependencies).toBeUndefined();
    expect((readJson(project.pkgPath) ?? {}).dependencies).toBeUndefined();

    const result = await applySweepPayload(project.root, {
      component: 'gitignore',
      mode: 'component',
    });
    expect(result.ok).toBe(true);

    // Byte-identical, i.e. no `devDependencies: {}` husk left behind either.
    expect(readFileSync(project.pkgPath, 'utf-8')).toBe(pkgBefore);
  });

  test('NEGATIVE CONTROL: unwrapped, that same run DOES write the pin into package.json', async () => {
    const project = await enrolledProject({declarePin: false});

    const exitCode = await runComponentByName('gitignore', {
      force: false,
      noCommit: true,
      projectRoot: project.root,
      quiet: true,
    });
    expect(exitCode).toBe(0);

    const devDeps = (readJson(project.pkgPath) ?? {}).devDependencies as Record<
      string,
      string
    >;
    expect(devDeps[SDK_PKG]).toContain('github:justinhaaheim/justin-sdk#v');
  });
});

describe('readPinSnapshot / restorePinSnapshot', () => {
  test('a restore reports exactly which pin fields it had to hold', async () => {
    const project = await enrolledProject();
    const before = readPinSnapshot(project.root);

    const cfg = readJson(project.cfgPath) ?? {};
    cfg.version = '9.9.9';
    writeJson(project.cfgPath, cfg);

    const restored = restorePinSnapshot(project.root, before);
    expect(restored).toEqual(['justin-sdk.config.json:version']);
    expect((readJson(project.cfgPath) ?? {}).version).toBe(OLD_VERSION);
  });

  test('nothing drifted → nothing restored, and the files are not rewritten', async () => {
    const project = await enrolledProject();
    const before = readPinSnapshot(project.root);
    const cfgBytes = readFileSync(project.cfgPath, 'utf-8');

    expect(restorePinSnapshot(project.root, before)).toEqual([]);
    expect(readFileSync(project.cfgPath, 'utf-8')).toBe(cfgBytes);
  });
});

// ---------------------------------------------------------------------------
// runSweep: argv validation, enrollment, dry-run — all before any repo is touched
// ---------------------------------------------------------------------------

async function captureLog<T>(
  fn: () => Promise<T>,
): Promise<{value: T; out: string}> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(' '));
  };
  try {
    const value = await fn();
    return {out: lines.join('\n'), value};
  } finally {
    console.log = original;
  }
}

/** No sweep worktree, no sweep branch, no working-tree change. */
function expectUntouched(repo: string): void {
  expect(existsSync(join(repo, ...SWEEP_WORKTREE_SEGMENTS))).toBe(false);
  expect(git(repo, ['branch', '--list', SWEEP_BRANCH]).trim()).toBe('');
  expect(git(repo, ['status', '--porcelain']).trim()).toBe('');
}

function repoWithComponents(
  sb: Sandbox,
  name: string,
  components: string[],
): string {
  return initRepo(sb, name, {
    'justin-sdk.config.json': JSON.stringify({components}, null, 2) + '\n',
    'package.json': JSON.stringify({name, version: '0.0.1'}, null, 2) + '\n',
  });
}

describe('runSweep --component', () => {
  test('an unknown component fails the whole run before any repo is touched', async () => {
    const sb = track(createSandbox());
    const repo = repoWithComponents(sb, 'enrolled', [
      'base-setup',
      'gitignore-setup',
    ]);

    const {out, value} = await captureLog(() =>
      runSweep({component: 'no-such-component', repos: [repo]}),
    );

    expect(value).toBe(1);
    expect(out).toContain('unknown component "no-such-component"');
    expect(out).toContain('nothing was swept');
    // Loud AND inert: the repo was never even enumerated.
    expect(out).not.toContain('enrolled');
    expectUntouched(repo);
  });

  test('a repo not enrolled in the component is skipped explicitly, and stays untouched', async () => {
    const sb = track(createSandbox());
    const repo = repoWithComponents(sb, 'other', ['base-setup', 'beads-setup']);

    const {out, value} = await captureLog(() =>
      runSweep({component: 'gitignore', repos: [repo]}),
    );

    // A skip is a normal outcome, not a failure.
    expect(value).toBe(0);
    expect(out).toContain('skipped — not enrolled in gitignore');
    expectUntouched(repo);
  });

  test('a repo whose config is not committed is skipped with the reason, never assumed', async () => {
    const sb = track(createSandbox());
    const repo = initRepo(sb, 'uncommitted', {'a.txt': 'a\n'});

    const {out, value} = await captureLog(() =>
      runSweep({component: 'gitignore', repos: [repo]}),
    );

    expect(value).toBe(0);
    expect(out).toContain('cannot read enrollment');
    expect(existsSync(join(repo, ...SWEEP_WORKTREE_SEGMENTS))).toBe(false);
    expect(git(repo, ['branch', '--list', SWEEP_BRANCH]).trim()).toBe('');
  });

  test('--dry-run with --component reports the scoped plan per repo and changes nothing', async () => {
    const sb = track(createSandbox());
    const enrolled = repoWithComponents(sb, 'enrolled', [
      'base-setup',
      'gitignore-setup',
    ]);
    const other = repoWithComponents(sb, 'other', ['base-setup']);

    const {out, value} = await captureLog(() =>
      runSweep({
        component: 'gitignore',
        dryRun: true,
        repos: [enrolled, other],
      }),
    );

    expect(value).toBe(0);
    expect(out).toContain('component: gitignore (SDK pin NOT bumped)');
    expect(out).toContain('would apply gitignore off main (pin untouched)');
    expect(out).toContain('skipped — not enrolled in gitignore');
    expectUntouched(enrolled);
    expectUntouched(other);
  });

  test('an unscoped --dry-run still reports the full sweep, with no component scoping', async () => {
    const sb = track(createSandbox());
    const repo = repoWithComponents(sb, 'enrolled', ['base-setup']);

    const {out, value} = await captureLog(() =>
      runSweep({dryRun: true, repos: [repo]}),
    );

    expect(value).toBe(0);
    expect(out).toContain('would sweep off main');
    expect(out).not.toContain('pin NOT bumped');
    expectUntouched(repo);
  });
});

// ---------------------------------------------------------------------------
// The post-gate pin assertion (home-base-r47v F2)
// ---------------------------------------------------------------------------

/**
 * Make an existing fixture project a committed git repo, so the assertion can be
 * about what the sweep's `git add -A` + commit would actually CONTAIN rather than
 * only about bytes on disk.
 */
function commitProject(root: string): void {
  git(root, ['init', '-q', '-b', 'main', '.']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);
  const excludes = join(root, '.git', 'controlled-excludes');
  writeFileSync(excludes, '');
  git(root, ['config', 'core.excludesFile', excludes]);
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'init']);
}

/** What the sweep's commit would carry, as git itself sees it. */
function stagedPaths(root: string): string {
  git(root, ['add', '-A']);
  return git(root, ['diff', '--cached', '--name-only']);
}

/**
 * Reproduce the drift the DOCTOR GATE can reintroduce. doctor --fix's fixCommands
 * are `bunx @justinhaaheim/justin-sdk add <component>`, i.e. exactly this
 * installer, and stepJustinSdkConfig inside it is what stamps version/lastSynced.
 * Running the real gate is out of reach in a test (it hydrates with a real `bun
 * install` and resolves the SDK from the TARGET's pin), so the drift is
 * manufactured by the same code the gate would invoke — and each arm asserts the
 * drift really happened before asserting it was undone.
 */
async function driftLikeTheDoctorGate(root: string): Promise<void> {
  const exitCode = await runComponentByName('gitignore', {
    force: false,
    noCommit: true,
    projectRoot: root,
    quiet: true,
  });
  expect(exitCode).toBe(0);
}

describe('holdPinAfterGates — drift the GATES reintroduce', () => {
  test('a doctor-shaped drift after the payload is undone: the commit is pin-neutral', async () => {
    const project = await enrolledProject();
    commitProject(project.root);
    const payload = planSweepPayload('gitignore');

    expect((await applySweepPayload(project.root, payload)).ok).toBe(true);
    // The snapshot the sweep takes: after the payload, before the gates.
    const beforeGates = readPinSnapshot(project.root);
    const pkgBefore = readFileSync(project.pkgPath, 'utf-8');
    const cfgBefore = readFileSync(project.cfgPath, 'utf-8');

    await driftLikeTheDoctorGate(project.root);
    // The arm cannot pass vacuously: prove the gate's drift is real first.
    expect((readJson(project.cfgPath) ?? {}).version).toBe(getSdkVersion());
    expect((readJson(project.cfgPath) ?? {}).lastSynced).toBe(todayIsoDate());

    const held = holdPinAfterGates(project.root, payload, beforeGates);

    expect(held).toContain('justin-sdk.config.json:version');
    expect(held).toContain('justin-sdk.config.json:lastSynced');
    expect(readFileSync(project.pkgPath, 'utf-8')).toBe(pkgBefore);
    expect(readFileSync(project.cfgPath, 'utf-8')).toBe(cfgBefore);
    // And the thing that actually matters — what the commit would carry.
    const staged = stagedPaths(project.root);
    expect(staged).not.toContain('justin-sdk.config.json');
    expect(staged).not.toContain('package.json');
  });

  test('NEGATIVE CONTROL: without the post-gate hold, that drift lands in the commit', async () => {
    const project = await enrolledProject();
    commitProject(project.root);
    const payload = planSweepPayload('gitignore');
    expect((await applySweepPayload(project.root, payload)).ok).toBe(true);

    await driftLikeTheDoctorGate(project.root);

    // No holdPinAfterGates call — this is the pre-F2 sweep, and the pin moves
    // inside the commit of a run whose contract says it cannot.
    const staged = stagedPaths(project.root);
    expect(staged).toContain('justin-sdk.config.json');
    expect((readJson(project.cfgPath) ?? {}).version).toBe(getSdkVersion());
  });

  test('a FULL sweep is never touched: there, moving the pin IS the payload', async () => {
    const project = await enrolledProject();
    const beforeGates = readPinSnapshot(project.root);

    // Whatever the full payload's pin step wrote must survive the gates.
    const cfg = readJson(project.cfgPath) ?? {};
    cfg.version = '9.9.9';
    writeJson(project.cfgPath, cfg);

    expect(
      holdPinAfterGates(project.root, planSweepPayload(null), beforeGates),
    ).toEqual([]);
    expect((readJson(project.cfgPath) ?? {}).version).toBe('9.9.9');
  });

  test('no snapshot means no restore — never a guess at what the pin was', async () => {
    const project = await enrolledProject();
    const cfg = readJson(project.cfgPath) ?? {};
    cfg.version = '9.9.9';
    writeJson(project.cfgPath, cfg);

    expect(
      holdPinAfterGates(project.root, planSweepPayload('gitignore'), null),
    ).toEqual([]);
    expect((readJson(project.cfgPath) ?? {}).version).toBe('9.9.9');
  });
});
