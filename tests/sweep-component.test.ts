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
import {readDeployedStamp} from '../src/plugin/lib/rules-file';
import {
  getSdkVersion,
  readJson,
  todayIsoDate,
  writeJson,
} from '../src/setup-helpers';
import {
  applySweepPayload,
  committedConfigComponents,
  componentContractPaths,
  holdPinAfterGates,
  isEnrolledIn,
  parseComponentOption,
  parseConfigComponents,
  partitionByComponentContract,
  planSweepPayload,
  readPinSnapshot,
  refreshUserLevelRules,
  restorePinSnapshot,
  runSweep,
  stageForCommit,
  SWEEP_BRANCH,
  SWEEP_WORKTREE_SEGMENTS,
  sweepCommitMessage,
} from '../src/sweep';
import {git, initRepo, write} from './git-fixtures';
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

  test('a repo whose config is not committed COULD NOT BE SWEPT — reason given, run fails', async () => {
    const sb = track(createSandbox());
    const repo = initRepo(sb, 'uncommitted', {'a.txt': 'a\n'});

    const {out, value} = await captureLog(() =>
      runSweep({component: 'gitignore', repos: [repo]}),
    );

    // ckc4 F4: "I could not read this repo's enrollment" is a repo the run
    // failed to sweep, not a benign skip. It used to exit 0 — a fleet silently
    // left out of sync.
    expect(value).toBe(1);
    expect(out).toContain('cannot read enrollment');
    expect(out).toContain('COULD NOT SWEEP: uncommitted');
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

// ---------------------------------------------------------------------------
// D17 — one command, both surfaces
// ---------------------------------------------------------------------------

/**
 * A rules edit has to land in the enrolled repos AND in this machine's
 * user-level rules file, which is still the only channel for the repos that are
 * not enrolled. The sweep does both, so there is no second command to forget.
 *
 * THE TWO THINGS THAT MUST HOLD, and both are about BLAST RADIUS:
 *  1. SCOPE. Only `--component critical-rules` may touch that file. A gitignore
 *     sweep or a full sweep writing to ~/.claude would be a side effect nobody
 *     asked for, so the no-op arms assert the file does not even come into
 *     existence — not merely that nothing was printed.
 *  2. ISOLATION, BOTH WAYS. The user-level surface and the repo surface fail
 *     independently. A broken prompts source must not turn green repos red, and
 *     a red repo must not stop the refresh — a failed repo is no reason to leave
 *     this machine on stale rules.
 *
 * $HOME is a sandbox throughout, so `rulesFilePath()` resolves inside the
 * fixture: these tests can never read or write Justin's real rules file. The
 * prompts fixture is deliberately NOT a git checkout, which skips sync-rules'
 * `bunx version-manager` call (network) and stamps the version 'unknown'.
 */
const SAVED_D17_ENV = {
  home: process.env.HOME,
  prettier: process.env.JSDK_PRIME_PRETTIER,
  promptsDir: process.env.JSDK_PROMPTS_DIR,
};

afterEach(() => {
  for (const [name, value] of [
    ['HOME', SAVED_D17_ENV.home],
    ['JSDK_PRIME_PRETTIER', SAVED_D17_ENV.prettier],
    ['JSDK_PROMPTS_DIR', SAVED_D17_ENV.promptsDir],
  ] as const) {
    if (value == null) delete process.env[name];
    else process.env[name] = value;
  }
});

/** A throwaway $HOME; returns where the user-level rules file would land. */
function sandboxHome(): string {
  const sb = track(createSandbox());
  process.env.HOME = sb.path;
  return join(sb.path, '.claude/rules/justin-sdk/critical-rules.md');
}

function userRulesPrompts(body = 'UNIVERSAL_RULE_V1'): string {
  process.env.JSDK_PRIME_PRETTIER = '0';
  const sb = track(createSandbox());
  sb.writeFile('src/rules/index.md', '@./alpha.md');
  sb.writeFile('src/rules/alpha.md', `# Alpha\n\n${body}`);
  process.env.JSDK_PROMPTS_DIR = sb.path;
  return sb.path;
}

const CRITICAL_RULES_PAYLOAD = planSweepPayload('critical-rules');

describe('refreshUserLevelRules (D17)', () => {
  test('a critical-rules component sweep writes the user-level file', () => {
    const file = sandboxHome();
    userRulesPrompts();
    expect(existsSync(file)).toBe(false);

    const outcome = refreshUserLevelRules(CRITICAL_RULES_PAYLOAD);
    expect(outcome?.status).toBe('refreshed');
    expect(readFileSync(file, 'utf-8')).toContain('UNIVERSAL_RULE_V1');
    expect(outcome?.detail).toContain(file);
  });

  test('SCOPE: no other payload touches the user-level file, at all', () => {
    for (const payload of [
      planSweepPayload(null), // the full sweep
      planSweepPayload('gitignore'),
      planSweepPayload('beads'),
    ]) {
      const file = sandboxHome();
      userRulesPrompts();
      // null, not a no-op outcome: there is no line to print either.
      expect(refreshUserLevelRules(payload)).toBeNull();
      // The sharper assertion — nothing was WRITTEN, not just nothing said.
      expect(existsSync(file)).toBe(false);
    }
  });

  test('an already-current file is reported as current, not as a refresh', () => {
    const file = sandboxHome();
    userRulesPrompts();
    expect(refreshUserLevelRules(CRITICAL_RULES_PAYLOAD)?.status).toBe(
      'refreshed',
    );
    const bytes = readFileSync(file, 'utf-8');

    const second = refreshUserLevelRules(CRITICAL_RULES_PAYLOAD);
    expect(second?.status).toBe('current');
    // "current" is a measurement of the bytes, not a claim about the exit code.
    expect(readFileSync(file, 'utf-8')).toBe(bytes);
  });

  test('a moved source is reported as refreshed, with both content hashes', () => {
    const file = sandboxHome();
    userRulesPrompts('UNIVERSAL_RULE_V1');
    refreshUserLevelRules(CRITICAL_RULES_PAYLOAD);
    const firstHash = readDeployedStamp(file)?.contentHash;

    userRulesPrompts('UNIVERSAL_RULE_V2');
    const outcome = refreshUserLevelRules(CRITICAL_RULES_PAYLOAD);
    expect(outcome?.status).toBe('refreshed');
    expect(readFileSync(file, 'utf-8')).toContain('UNIVERSAL_RULE_V2');
    expect(outcome?.detail).toContain(String(firstHash));
  });

  test('--dry-run says what it would do and writes nothing', () => {
    const file = sandboxHome();
    userRulesPrompts();

    const outcome = refreshUserLevelRules(CRITICAL_RULES_PAYLOAD, {
      dryRun: true,
    });
    expect(outcome?.status).toBe('dry-run');
    expect(outcome?.detail).toContain('would refresh');
    expect(existsSync(file)).toBe(false);
  });

  test('an unreadable prompts source is FAILED, and names the remedy', () => {
    const file = sandboxHome();
    // A prompts dir with no rules index at all: assemble cannot succeed.
    const sb = track(createSandbox());
    sb.writeFile('README.md', 'no rules here\n');
    process.env.JSDK_PROMPTS_DIR = sb.path;
    process.env.JSDK_PRIME_PRETTIER = '0';

    const outcome = refreshUserLevelRules(CRITICAL_RULES_PAYLOAD);
    expect(outcome?.status).toBe('failed');
    expect(outcome?.detail).toContain('NOT refreshed');
    expect(outcome?.detail).toContain('sync-rules');
    // Never a half-written file standing in for a real one.
    expect(existsSync(file)).toBe(false);
  });
});

describe('runSweep --component critical-rules · the user-level line (D17)', () => {
  test('the refresh gets its OWN summary line, distinct from every repo line', async () => {
    const file = sandboxHome();
    userRulesPrompts();
    const sb = track(createSandbox());
    // Not enrolled ⇒ skipped before any worktree work, which keeps this test
    // about the summary rather than about hydration.
    const repo = repoWithComponents(sb, 'other', ['base-setup']);

    const {out, value} = await captureLog(() =>
      runSweep({component: 'critical-rules', repos: [repo]}),
    );

    expect(value).toBe(0);
    const line = out
      .split('\n')
      .find((l) => l.includes('user-level rules')) as string;
    expect(line).toBeDefined();
    expect(line).toContain(file);
    // It is NOT attached to a repo: the repo has its own line, and that line
    // says only what happened to the repo.
    expect(line).not.toContain('other');
    expect(out).toContain('skipped — not enrolled in critical-rules');
    expect(readFileSync(file, 'utf-8')).toContain('UNIVERSAL_RULE_V1');
  });

  test('an unscoped sweep prints no user-level line and writes no user-level file', async () => {
    const file = sandboxHome();
    userRulesPrompts();
    const sb = track(createSandbox());
    const repo = repoWithComponents(sb, 'enrolled', ['base-setup']);

    const {out} = await captureLog(() =>
      runSweep({dryRun: true, repos: [repo]}),
    );

    expect(out).not.toContain('user-level rules');
    expect(existsSync(file)).toBe(false);
  });

  test('ISOLATION: a failed user-level refresh does not mark any repo failed', async () => {
    sandboxHome();
    const sb = track(createSandbox());
    sb.writeFile('broken-prompts/README.md', 'no rules index\n');
    process.env.JSDK_PROMPTS_DIR = join(sb.path, 'broken-prompts');
    process.env.JSDK_PRIME_PRETTIER = '0';
    const repo = repoWithComponents(sb, 'other', ['base-setup']);

    const {out, value} = await captureLog(() =>
      runSweep({component: 'critical-rules', repos: [repo]}),
    );

    // The run is red — a silent 0 here would be the failure-shaped-as-silence
    // this codebase forbids…
    expect(value).toBe(1);
    // …but attributed to the user-level surface, NOT to the repo.
    expect(out).toContain('user-level rules');
    expect(out).toContain('NOT refreshed');
    expect(out).toContain('skipped — not enrolled in critical-rules');
    expect(out).not.toContain('0 failed');
    expectUntouched(repo);
  });

  test('ISOLATION: repo trouble does not stop the user-level refresh', async () => {
    const file = sandboxHome();
    userRulesPrompts();
    const sb = track(createSandbox());
    // A repo whose enrollment cannot even be read — the worst repo-side outcome
    // reachable without hydration.
    const repo = initRepo(sb, 'uncommitted', {'a.txt': 'a\n'});

    const {out} = await captureLog(() =>
      runSweep({component: 'critical-rules', repos: [repo]}),
    );

    expect(out).toContain('cannot read enrollment');
    // Refreshed anyway: a repo that went sideways is no reason to leave THIS
    // machine's rules stale.
    expect(readFileSync(file, 'utf-8')).toContain('UNIVERSAL_RULE_V1');
    expect(out).toContain('user-level rules');
  });
});

// ---------------------------------------------------------------------------
// The component contract: a component sweep commits only what that component
// owns (home-base-926v)
// ---------------------------------------------------------------------------

/**
 * THE BUG THIS PINS. The sweep gates every worktree with
 * `bunx @justinhaaheim/justin-sdk doctor --fix`, and that resolves the TARGET
 * repo's pinned SDK — not the one running the sweep. On a repo still enrolled in
 * a component t6a0 retired, that fixer re-applies the scaffolding the migration
 * removed. Observed 2026-08-19 in the `life` and `userscripts-j` sweep
 * worktrees:
 *
 *   CLAUDE.md              + @docs/prompts/IMPORTANT_GUIDELINES_INLINED.md
 *   .claude/settings.json  + a setup-env SessionStart hook
 *   scripts/setup-env.ts   (recreated)
 *
 * `git add -A` would have committed all three under a message reading
 * "sweep critical-rules — re-apply that component only". Nothing was damaged
 * only because both repos' gates were red for unrelated reasons — luck that
 * expires the moment those reds are fixed.
 */
describe('component contract', () => {
  test('critical-rules owns the artifact, the selection and the settings file', () => {
    expect(componentContractPaths('critical-rules')).toEqual([
      '.claude/rules/justin-sdk/',
      '.claude/settings.json',
      'justin-sdk.config.json',
    ]);
  });

  test('a component with no declared contract keeps the historical add -A', () => {
    // Deliberate: a too-narrow list would DROP a real change and then report
    // "already current" — silent omission, the worse failure direction.
    expect(componentContractPaths('gitignore')).toBeNull();
    expect(
      partitionByComponentContract(
        {component: 'gitignore', mode: 'component'},
        ['CLAUDE.md', '.gitignore'],
      ),
    ).toEqual({inScope: ['CLAUDE.md', '.gitignore'], outOfScope: []});
  });

  test('the real doctor --fix churn is split from the rules payload', () => {
    expect(
      partitionByComponentContract(
        {component: 'critical-rules', mode: 'component'},
        [
          '.claude/rules/justin-sdk/critical-rules.md',
          '.claude/settings.json',
          'CLAUDE.md',
          'justin-sdk.config.json',
          'scripts/setup-env.ts',
        ],
      ),
    ).toEqual({
      inScope: [
        '.claude/rules/justin-sdk/critical-rules.md',
        '.claude/settings.json',
        'justin-sdk.config.json',
      ],
      outOfScope: ['CLAUDE.md', 'scripts/setup-env.ts'],
    });
  });

  test('a FULL sweep is untouched — it is supposed to re-apply everything', () => {
    expect(
      partitionByComponentContract({mode: 'full'}, [
        'CLAUDE.md',
        'package.json',
      ]),
    ).toEqual({inScope: ['CLAUDE.md', 'package.json'], outOfScope: []});
  });

  test('the prefix entry matches the directory, not a lookalike sibling', () => {
    expect(
      partitionByComponentContract(
        {component: 'critical-rules', mode: 'component'},
        [
          '.claude/rules/justin-sdk/critical-rules.md',
          '.claude/rules/justin-sdk-notes.md',
          '.claude/settings.local.json',
        ],
      ).outOfScope,
    ).toEqual([
      '.claude/rules/justin-sdk-notes.md',
      '.claude/settings.local.json',
    ]);
  });
});

describe('stageForCommit (real git index)', () => {
  /** A repo carrying the exact file set the observed churn produced. */
  function churnedRepo(sb: Sandbox): string {
    const repo = initRepo(sb, 'churned', {
      '.claude/rules/justin-sdk/critical-rules.md': 'OLD RULES\n',
      'CLAUDE.md': '# Project\n',
      'justin-sdk.config.json': '{}\n',
    });
    // The payload's own write…
    write(repo, '.claude/rules/justin-sdk/critical-rules.md', 'NEW RULES\n');
    // …and the two files `doctor --fix` rewrote behind its back.
    write(
      repo,
      'CLAUDE.md',
      '# Project\n\n@docs/prompts/IMPORTANT_GUIDELINES_INLINED.md\n',
    );
    write(repo, 'scripts/setup-env.ts', '// recreated by the fixer\n');
    return repo;
  }

  test('a component sweep stages the rules change and NOTHING else', () => {
    const sb = track(createSandbox());
    const repo = churnedRepo(sb);

    const result = stageForCommit(repo, {
      component: 'critical-rules',
      mode: 'component',
    });

    expect(result.staged).toEqual([
      '.claude/rules/justin-sdk/critical-rules.md',
    ]);
    expect(result.excluded).toEqual(['CLAUDE.md', 'scripts/setup-env.ts']);

    // Asserted against git itself, not the return value: this is the state the
    // commit would capture.
    expect(git(repo, ['diff', '--cached', '--name-only']).trim()).toBe(
      '.claude/rules/justin-sdk/critical-rules.md',
    );
    // Un-staged, NOT reverted — an operator inspecting a red run still sees it.
    expect(readFileSync(join(repo, 'CLAUDE.md'), 'utf-8')).toContain(
      'IMPORTANT_GUIDELINES_INLINED',
    );
  });

  test('NEGATIVE CONTROL: a FULL sweep of the same tree stages all of it', () => {
    // Same fixture, same function, only the payload differs — so the test above
    // cannot be passing because the fixture failed to produce the stray files.
    const sb = track(createSandbox());
    const repo = churnedRepo(sb);

    const result = stageForCommit(repo, {mode: 'full'});

    expect(result.excluded).toEqual([]);
    expect(result.staged).toEqual([
      '.claude/rules/justin-sdk/critical-rules.md',
      'CLAUDE.md',
      'scripts/setup-env.ts',
    ]);
  });

  test('the green path is unchanged: a clean rules sweep is still a 1-file commit', () => {
    // Regression-check against audio-journal-1's ad29363 shape.
    const sb = track(createSandbox());
    const repo = initRepo(sb, 'clean', {
      '.claude/rules/justin-sdk/critical-rules.md': 'OLD RULES\n',
      'justin-sdk.config.json': '{}\n',
    });
    write(repo, '.claude/rules/justin-sdk/critical-rules.md', 'NEW RULES\n');

    const result = stageForCommit(repo, {
      component: 'critical-rules',
      mode: 'component',
    });

    expect(result.staged).toEqual([
      '.claude/rules/justin-sdk/critical-rules.md',
    ]);
    expect(result.excluded).toEqual([]);
  });
});
