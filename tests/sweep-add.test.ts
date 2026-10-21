/**
 * Tests for `justin-sdk sweep --add <component>` (home-base-yukaf.33).
 *
 * The four cases the bead names — adds where unlisted, skips where listed,
 * skips a pin too old, dry run makes no worktree — are END-TO-END runs of the
 * real orchestrator against offline fixture repos (sweep-e2e-fixtures.ts): the
 * fake SDK in each repo's node_modules is what the sweep runs by path, so
 * "whose `add` ran" and "what landed on main" are measured, not asserted about
 * a helper. The decisions underneath are pinned separately as pure tests.
 *
 * Run with the Claude Code sandbox OFF (pkg/justin-sdk/CLAUDE.md): the e2e
 * runs `bun install` in temp dirs.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {execFileSync} from 'child_process';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'fs';
import {join} from 'path';

import {
  beadsConfigGuard,
  holdPinAfterGates,
  readPinSnapshot,
  resolveSweepPayload,
  runSweep,
  sweepCommitMessage,
} from '../src/sweep';
import {
  addApplicabilitySkip,
  addEnrollmentVerdict,
  type CommandRunner,
  parseAddChoices,
  probeSdkOffers,
  SWEEP_ADD_INSTALL_ARGS,
  sweepAddArgs,
} from '../src/sweep-add';
import {git, write} from './git-fixtures';
import {createSandbox, type Sandbox} from './sandbox';
import {captureLog, e2eRepo, expectNoSweepRemains} from './sweep-e2e-fixtures';

const sandboxes: Sandbox[] = [];
function track(sb: Sandbox): Sandbox {
  sandboxes.push(sb);
  return sb;
}
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

/** Threads ON in the repo's own config, so thread-rules' includeIf passes whatever this machine's user config says. */
const THREADS_ON = {componentConfig: {thread: {enabled: true}}};

function mainSha(repo: string): string {
  return git(repo, ['rev-parse', 'refs/heads/main']).trim();
}

function committedConfig(repo: string): {components?: string[]} {
  return JSON.parse(git(repo, ['show', 'main:justin-sdk.config.json'])) as {
    components?: string[];
  };
}

/** Hydrate a fixture's PRIMARY the way the fleet's primaries are hydrated, so a dry run can probe its SDK. */
function hydratePrimary(repo: string): void {
  execFileSync('bun', ['install'], {cwd: repo, stdio: 'pipe'});
}

// ---------------------------------------------------------------------------
// Pure decisions
// ---------------------------------------------------------------------------

describe('parseAddChoices', () => {
  test('reads the quoted choices yargs prints, and nothing from the description', () => {
    const help = [
      'Positionals:',
      '  components  In THIS repo, core = gitignore, eas, critical-rules',
      '   [array] [required] [choices: "base-setup", "gitignore", "thread-hooks",',
      '                       "critical-rules", "core"] [default: []]',
    ].join('\n');
    expect(parseAddChoices(help)).toEqual([
      'base-setup',
      'gitignore',
      'thread-hooks',
      'critical-rules',
      'core',
    ]);
  });

  test('help with no choices list is null, never an empty list', () => {
    expect(parseAddChoices('fixture justin-sdk add --help')).toBeNull();
  });
});

describe('addEnrollmentVerdict', () => {
  test('an unreadable config is blocked, never "already enrolled" (rule 7)', () => {
    const verdict = addEnrollmentVerdict(
      {kind: 'unreadable', reason: 'justin-sdk.config.json is not valid JSON'},
      'thread-rules',
    );
    expect(verdict.kind).toBe('blocked');
    expect(verdict.kind === 'blocked' && verdict.detail).toContain(
      'not valid JSON',
    );
  });

  test('a config that lists the component is skipped as already enrolled', () => {
    const verdict = addEnrollmentVerdict(
      {
        components: ['base-setup', 'thread-rules-setup'],
        kind: 'enrolled',
        source: 'config',
      },
      'thread-rules',
    );
    expect(verdict).toEqual({
      detail: 'skipped — already enrolled in thread-rules',
      kind: 'skip',
    });
  });

  test('a config that does not list it proceeds', () => {
    expect(
      addEnrollmentVerdict(
        {components: ['base-setup'], kind: 'enrolled', source: 'config'},
        'thread-rules',
      ),
    ).toEqual({kind: 'proceed'});
  });

  test('a core-tracking config never proceeds, whether core includes it or not', () => {
    // `add` there would write `components: [X]` and stop it tracking core.
    const included = addEnrollmentVerdict(
      {
        components: ['base-setup', 'thread-rules-setup'],
        kind: 'enrolled',
        source: 'core',
      },
      'thread-rules',
    );
    const excluded = addEnrollmentVerdict(
      {components: ['base-setup'], kind: 'enrolled', source: 'core'},
      'thread-rules',
    );
    expect(included.kind).toBe('skip');
    expect(included.kind === 'skip' && included.detail).toContain(
      'already enrolled',
    );
    expect(excluded.kind).toBe('skip');
    expect(excluded.kind === 'skip' && excluded.detail).toContain(
      'explicit one-item list',
    );
  });
});

describe('resolveSweepPayload', () => {
  test('--add names the component, normalizing a -setup name', () => {
    expect(resolveSweepPayload({add: 'thread-rules-setup'})).toEqual({
      ok: true,
      payload: {component: 'thread-rules', mode: 'add'},
    });
  });

  test('--add with --component refuses: one payload per run', () => {
    const parsed = resolveSweepPayload({
      add: 'thread-rules',
      component: 'install',
    });
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toContain('one payload per run');
  });

  test('an unknown --add name refuses', () => {
    const parsed = resolveSweepPayload({add: 'thread-rulez'});
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toContain('unknown component');
  });

  test('without --add, --component is parsed exactly as before', () => {
    expect(resolveSweepPayload({component: 'install'})).toEqual({
      ok: true,
      payload: {mode: 'install'},
    });
    expect(resolveSweepPayload({})).toEqual({
      ok: true,
      payload: {mode: 'full'},
    });
  });
});

describe('the add payload argv and its neighbours', () => {
  test('`add` runs with no --commit, --force or --yes; `install` with no --prune', () => {
    expect(sweepAddArgs('thread-rules')).toEqual(['add', 'thread-rules']);
    expect([...SWEEP_ADD_INSTALL_ARGS]).toEqual(['install']);
  });

  test('the commit message names the component and says the pin held', () => {
    const message = sweepCommitMessage({
      component: 'thread-rules',
      mode: 'add',
    });
    expect(message).toContain('sweep --add thread-rules');
    expect(message).toContain('SDK pin unchanged');
  });

  test('the beads-config guard holds for --add, except --add beads', () => {
    const changed = ['.beads/config.yaml'];
    expect(
      beadsConfigGuard({component: 'thread-rules', mode: 'add'}, changed).ok,
    ).toBe(false);
    expect(
      beadsConfigGuard({component: 'beads', mode: 'add'}, changed).ok,
    ).toBe(true);
  });

  test('the post-gate pin hold applies to --add (it is pin-neutral)', () => {
    const sb = track(createSandbox());
    const pkg = {devDependencies: {'@justinhaaheim/justin-sdk': 'file:a'}};
    write(sb.path, 'package.json', JSON.stringify(pkg, null, 2) + '\n');
    const before = readPinSnapshot(sb.path);
    write(
      sb.path,
      'package.json',
      JSON.stringify(
        {devDependencies: {'@justinhaaheim/justin-sdk': 'file:b'}},
        null,
        2,
      ) + '\n',
    );
    expect(
      holdPinAfterGates(
        sb.path,
        {component: 'thread-rules', mode: 'add'},
        before,
      ),
    ).toEqual(['package.json:devDependencies.@justinhaaheim/justin-sdk']);
    expect(readFileSync(join(sb.path, 'package.json'), 'utf-8')).toContain(
      'file:a',
    );
  });
});

describe('addApplicabilitySkip', () => {
  test('thread-rules is skipped where the repo turns threads off', () => {
    const sb = track(createSandbox());
    write(
      sb.path,
      'justin-sdk.config.json',
      JSON.stringify({componentConfig: {thread: {enabled: false}}}) + '\n',
    );
    expect(addApplicabilitySkip(sb.path, 'thread-rules')).toBe(
      'skipped — thread-rules does not apply here (includeIf: isThreadEnabled)',
    );
  });

  test('thread-rules applies where the repo turns threads on', () => {
    const sb = track(createSandbox());
    write(sb.path, 'justin-sdk.config.json', JSON.stringify(THREADS_ON) + '\n');
    expect(addApplicabilitySkip(sb.path, 'thread-rules')).toBeNull();
  });

  test('an ungated component always applies', () => {
    const sb = track(createSandbox());
    expect(addApplicabilitySkip(sb.path, 'time-check')).toBeNull();
  });
});

describe('probeSdkOffers — three answers, never two', () => {
  /** A root whose `.bin/justin-sdk` exists (never executed: the runner is injected) at `version`. */
  function sdkRoot(sb: Sandbox, version: string | null): string {
    mkdirSync(join(sb.path, 'node_modules', '.bin'), {recursive: true});
    writeFileSync(join(sb.path, 'node_modules', '.bin', 'justin-sdk'), '');
    if (version != null) {
      const pkgDir = join(
        sb.path,
        'node_modules',
        '@justinhaaheim',
        'justin-sdk',
      );
      mkdirSync(pkgDir, {recursive: true});
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({version}));
    }
    return sb.path;
  }

  const answers =
    (output: string, exitCode = 0): CommandRunner =>
    () => ({error: null, exitCode, output});

  test('choices include it → offers, with the installed version', () => {
    const sb = track(createSandbox());
    expect(
      probeSdkOffers(
        sdkRoot(sb, '0.47.0'),
        'thread-rules',
        answers('[choices: "gitignore", "thread-rules", "core"]'),
      ),
    ).toEqual({kind: 'offers', version: '0.47.0'});
  });

  test('choices without it → pin too old, in the brief’s words', () => {
    const sb = track(createSandbox());
    expect(
      probeSdkOffers(
        sdkRoot(sb, '0.46.0'),
        'thread-rules',
        answers('[choices: "gitignore", "thread-hooks", "core"]'),
      ),
    ).toEqual({
      detail:
        "pin too old: 0.46.0; run the install sweep first (this repo's own SDK does not offer thread-rules)",
      kind: 'too-old',
    });
  });

  test('help that lists no choices is UNKNOWN, not too old (rule 7)', () => {
    const sb = track(createSandbox());
    const offer = probeSdkOffers(
      sdkRoot(sb, '0.46.0'),
      'thread-rules',
      answers('fixture justin-sdk add --help'),
    );
    expect(offer.kind).toBe('unknown');
    expect(offer.kind === 'unknown' && offer.detail).toContain(
      'lists no choices',
    );
  });

  test('a failing help is UNKNOWN, not too old', () => {
    const sb = track(createSandbox());
    const offer = probeSdkOffers(
      sdkRoot(sb, '0.46.0'),
      'thread-rules',
      answers('[choices: "gitignore"]', 1),
    );
    expect(offer.kind).toBe('unknown');
  });

  test('no SDK bin at all is UNKNOWN, and nothing is spawned', () => {
    const sb = track(createSandbox());
    let spawned = false;
    const offer = probeSdkOffers(sb.path, 'thread-rules', () => {
      spawned = true;
      return {error: null, exitCode: 0, output: '[choices: "thread-rules"]'};
    });
    expect(offer.kind).toBe('unknown');
    expect(spawned).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// End to end — the four cases the bead names, plus the guards around them
// ---------------------------------------------------------------------------

describe('runSweep --add (end to end, offline)', () => {
  test('ADDS WHERE UNLISTED: the repo’s own SDK runs add then install, the result lands on main, the pin does not move', async () => {
    const sb = track(createSandbox());
    const repo = e2eRepo(sb, 'adds', {
      config: THREADS_ON,
      sdkOffers: ['gitignore', 'thread-rules'],
    });
    const before = mainSha(repo);
    const pkgBefore = git(repo, ['show', 'main:package.json']);

    const {out, value} = await captureLog(() =>
      runSweep({
        add: 'thread-rules',
        logDir: join(sb.path, 'logs'),
        repos: [repo],
      }),
    );

    expect(value).toBe(0);
    // The worktree's OWN bin, by path, in this order.
    const addAt = out.search(
      /\.claude\/worktrees\/sdk-sweep-[^/]+\/node_modules\/\.bin\/justin-sdk add thread-rules/,
    );
    const installAt = out.search(
      /\.claude\/worktrees\/sdk-sweep-[^/]+\/node_modules\/\.bin\/justin-sdk install/,
    );
    expect(addAt).toBeGreaterThan(-1);
    expect(installAt).toBeGreaterThan(addAt);
    expect(out).toContain('added thread-rules');

    expect(mainSha(repo)).not.toBe(before);
    expect(committedConfig(repo).components).toContain('thread-rules-setup');
    expect(
      git(repo, ['show', 'main:.claude/rules/justin-sdk/thread-rules.md']),
    ).toBe('fixture thread-rules\n');
    expect(git(repo, ['log', '-1', '--format=%s', 'main'])).toContain(
      'sweep --add thread-rules',
    );
    expect(git(repo, ['show', 'main:package.json'])).toBe(pkgBefore);
    expectNoSweepRemains(repo);
  });

  test('SKIPS WHERE LISTED: already enrolled, no worktree, no SDK spawned, main untouched', async () => {
    const sb = track(createSandbox());
    const repo = e2eRepo(sb, 'listed', {
      config: {
        ...THREADS_ON,
        components: ['base-setup', 'gitignore-setup', 'thread-rules-setup'],
      },
      sdkOffers: ['thread-rules'],
    });
    const before = mainSha(repo);

    const {out, value} = await captureLog(() =>
      runSweep({
        add: 'thread-rules',
        logDir: join(sb.path, 'logs'),
        repos: [repo],
      }),
    );

    expect(value).toBe(0);
    expect(out).toContain('skipped — already enrolled in thread-rules');
    expect(out).not.toContain('justin-sdk add');
    expect(out).not.toContain('worktree add');
    expect(mainSha(repo)).toBe(before);
    expectNoSweepRemains(repo);
  });

  test('SKIPS A PIN TOO OLD: its own SDK does not offer the component — skipped, not failed, add never run', async () => {
    const sb = track(createSandbox());
    const repo = e2eRepo(sb, 'old-pin', {
      config: THREADS_ON,
      sdkOffers: ['gitignore', 'thread-hooks'],
    });
    const before = mainSha(repo);

    const {out, value} = await captureLog(() =>
      runSweep({
        add: 'thread-rules',
        logDir: join(sb.path, 'logs'),
        repos: [repo],
      }),
    );

    expect(value).toBe(0);
    expect(out).toContain(
      'pin too old: 0.0.0-fixture; run the install sweep first',
    );
    expect(out).toContain('justin-sdk add --help');
    expect(out).not.toContain('justin-sdk add thread-rules');
    expect(out).toContain('1 skipped by --add thread-rules');
    expect(mainSha(repo)).toBe(before);
    expectNoSweepRemains(repo);
  });

  test('DRY RUN MAKES NO WORKTREE: one plan line per repo, nothing created, no log, add never run', async () => {
    const sb = track(createSandbox());
    const adds = e2eRepo(sb, 'dry-adds', {
      config: THREADS_ON,
      sdkOffers: ['thread-rules'],
    });
    const listed = e2eRepo(sb, 'dry-listed', {
      config: {
        ...THREADS_ON,
        components: ['base-setup', 'thread-rules-setup'],
      },
      sdkOffers: ['thread-rules'],
    });
    const old = e2eRepo(sb, 'dry-old', {
      config: THREADS_ON,
      sdkOffers: ['gitignore'],
    });
    // Left UNHYDRATED: the dry run cannot see its SDK, and must say so.
    const unhydrated = e2eRepo(sb, 'dry-unhydrated', {
      config: THREADS_ON,
      sdkOffers: ['thread-rules'],
    });
    for (const repo of [adds, listed, old]) hydratePrimary(repo);
    const repos = [adds, listed, old, unhydrated];
    const before = repos.map(mainSha);
    const logDir = join(sb.path, 'logs');

    const {out, value} = await captureLog(() =>
      runSweep({add: 'thread-rules', dryRun: true, logDir, repos}),
    );

    // The guard this test is named for first: nothing created, nothing run.
    expect(out).not.toContain('worktree add');
    expect(out).not.toContain('justin-sdk add thread-rules');
    expect(out).not.toContain('justin-sdk install');
    for (const repo of repos) expectNoSweepRemains(repo);
    expect(repos.map(mainSha)).toEqual(before);
    expect(existsSync(logDir)).toBe(false);

    // Then the plan: one line per repo.
    expect(value).toBe(0);
    expect(out).toContain(
      "would add thread-rules off main with the repo's own SDK 0.0.0-fixture, then install (removals disabled; pin untouched)",
    );
    expect(out).toContain('skipped — already enrolled in thread-rules');
    expect(out).toContain(
      'pin too old: 0.0.0-fixture; run the install sweep first',
    );
    expect(out).toContain('COULD NOT CHECK from the primary');
  });

  test('COULD NOT CHECK in the worktree is a red step, never a skip and never an add', async () => {
    const sb = track(createSandbox());
    // The historical fake answers `add --help` with no choices list.
    const repo = e2eRepo(sb, 'no-choices', {config: THREADS_ON});
    const before = mainSha(repo);

    const {out, value} = await captureLog(() =>
      runSweep({
        add: 'thread-rules',
        logDir: join(sb.path, 'logs'),
        repos: [repo],
      }),
    );

    expect(value).toBe(1);
    expect(out).toContain('lists no choices');
    expect(out).not.toContain('justin-sdk add thread-rules');
    expect(mainSha(repo)).toBe(before);
    expectNoSweepRemains(repo);
  });

  test('a repo where the component does not apply is skipped, and its worktree removed', async () => {
    const sb = track(createSandbox());
    const repo = e2eRepo(sb, 'threads-off', {
      config: {componentConfig: {thread: {enabled: false}}},
      sdkOffers: ['thread-rules'],
    });
    const before = mainSha(repo);

    const {out, value} = await captureLog(() =>
      runSweep({
        add: 'thread-rules',
        logDir: join(sb.path, 'logs'),
        repos: [repo],
      }),
    );

    expect(value).toBe(0);
    expect(out).toContain(
      'skipped — thread-rules does not apply here (includeIf: isThreadEnabled)',
    );
    expect(out).not.toContain('justin-sdk add thread-rules');
    expect(mainSha(repo)).toBe(before);
    expectNoSweepRemains(repo);
  });

  test('an `add` that exits 0 without registering the component fails the repo', async () => {
    const sb = track(createSandbox());
    const repo = e2eRepo(sb, 'forgets', {
      addBehaviour: 'no-config-write',
      config: THREADS_ON,
      sdkOffers: ['thread-rules'],
    });
    const before = mainSha(repo);

    const {out, value} = await captureLog(() =>
      runSweep({
        add: 'thread-rules',
        logDir: join(sb.path, 'logs'),
        repos: [repo],
      }),
    );

    expect(value).toBe(1);
    expect(out).toContain('does not list thread-rules-setup');
    expect(mainSha(repo)).toBe(before);
    expectNoSweepRemains(repo);
  });

  test('an `add` that commits on its own fails the repo: the sweep commits once', async () => {
    const sb = track(createSandbox());
    const repo = e2eRepo(sb, 'self-commit', {
      addBehaviour: 'commits',
      config: THREADS_ON,
      sdkOffers: ['thread-rules'],
    });
    const before = mainSha(repo);

    const {out, value} = await captureLog(() =>
      runSweep({
        add: 'thread-rules',
        logDir: join(sb.path, 'logs'),
        repos: [repo],
      }),
    );

    expect(value).toBe(1);
    expect(out).toContain('made a commit of its own');
    expect(mainSha(repo)).toBe(before);
    expectNoSweepRemains(repo);
  });

  test('--add with --component refuses the run before any repo is touched', async () => {
    const sb = track(createSandbox());
    const repo = e2eRepo(sb, 'both', {config: THREADS_ON});
    const {out, value} = await captureLog(() =>
      runSweep({
        add: 'thread-rules',
        component: 'thread-rules',
        logDir: join(sb.path, 'logs'),
        repos: [repo],
      }),
    );
    expect(value).toBe(1);
    expect(out).toContain('one payload per run');
    expect(out).not.toContain('▸ both');
  });
});
