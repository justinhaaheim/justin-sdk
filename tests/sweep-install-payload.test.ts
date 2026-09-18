/**
 * The ENROLLMENT REFRESH payload — `sweep --component install` (dchjw.10 SWEEP
 * SEMANTICS, built in dchjw.15).
 *
 * The fixture is a fake enrolled repo in the state the real fleet is in: an
 * old-style config (`version`, `lastSynced`, a `componentConfig`
 * `critical-rules.modules` include-list), FEWER components listed than are
 * actually installed, retired `bunx` script spellings, and a stale SDK pin.
 * One `applySweepPayload` call then has to leave it: everything installed
 * listed, the dead keys gone, the pin bumped, the scripts in the D1 form, the
 * rules artifact regenerated — and NOTHING removed.
 *
 * WHAT IS REAL HERE, and what is stood in for. The payload, the adoption
 * detector, the config surgery, the package-manager pin write and the whole
 * `install` run are the shipping code. Two things are injected so the test is
 * hermetic: the pin is a local `file:` spec (a github tag would need the
 * network to resolve, exactly as in sweep-pin.test.ts) and the prompts source
 * is a local git fixture via JSDK_PROMPTS_DIR (as in rules-drift.test.ts).
 *
 * NEGATIVE CONTROL, and it is the point of the whole design: the same fixture
 * says, before anything is adopted, that a REMOVAL-ENABLED install would delete
 * the two unlisted components. That is what the no-remove rule is protecting,
 * measured rather than asserted.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {execFileSync} from 'child_process';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'fs';
import {join} from 'path';

import {planInstall} from '../src/install';
import {readJson} from '../src/setup-helpers';
import {
  applySweepPayload,
  runSweep,
  SWEEP_UPDATE_ARGS,
  sweepCommitMessage,
} from '../src/sweep';
import {
  adoptInstalledComponents,
  dropDeadConfigKeys,
  planInstallPayload,
  renderInstallPayloadPlan,
} from '../src/sweep-install';
import {createSandbox, type Sandbox} from './sandbox';

const SDK_PKG = '@justinhaaheim/justin-sdk';
const OLD_PIN = 'file:../sdk-old';
const NEW_PIN = 'file:../sdk-new';

const sandboxes: Sandbox[] = [];
function track(sb: Sandbox): Sandbox {
  sandboxes.push(sb);
  return sb;
}
const SAVED_PROMPTS = process.env.JSDK_PROMPTS_DIR;
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
  if (SAVED_PROMPTS == null) delete process.env.JSDK_PROMPTS_DIR;
  else process.env.JSDK_PROMPTS_DIR = SAVED_PROMPTS;
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {cwd, encoding: 'utf-8', stdio: 'pipe'});
}

function write(root: string, rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), {recursive: true});
  writeFileSync(full, content);
}

/** A prompts checkout as a real git repo, so the artifact header has a sha. */
function promptsFixture(sb: Sandbox): string {
  process.env.JSDK_PRIME_PRETTIER = '0';
  const dir = join(sb.path, 'prompts');
  mkdirSync(dir, {recursive: true});
  git(dir, ['init', '-q', '-b', 'main', '.']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  write(dir, 'src/rules/index.md', '@./alpha.md\n\n@./omega.md');
  write(dir, 'src/rules/alpha.md', '# Alpha\n\nALPHA_RULE');
  write(dir, 'src/rules/omega.md', '# Omega\n\nOMEGA_RULE');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'init']);
  process.env.JSDK_PROMPTS_DIR = dir;
  return dir;
}

interface Fixture {
  root: string;
  config: () => Record<string, unknown>;
  pkg: () => {
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
}

/**
 * The fleet's actual shape: 3 components listed, 5 installed (`time-check` and
 * `usage-check` are proven installed by their `componentConfig` blocks, which
 * is how an older SDK left them), dead keys present, `bunx` scripts, old pin.
 */
function enrolledRepo(sb: Sandbox): Fixture {
  for (const [dir, version] of [
    ['sdk-old', '0.0.1'],
    ['sdk-new', '0.0.2'],
  ] as const) {
    mkdirSync(join(sb.path, dir), {recursive: true});
    writeFileSync(
      join(sb.path, dir, 'package.json'),
      `${JSON.stringify({name: SDK_PKG, version}, null, 2)}\n`,
    );
  }

  const root = join(sb.path, 'repo');
  mkdirSync(root, {recursive: true});
  git(root, ['init', '-q', '-b', 'main', '.']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);

  write(root, 'CLAUDE.md', '# fixture\n');
  write(root, '.gitignore', 'node_modules\ntmp/\n');
  write(
    root,
    'package.json',
    `${JSON.stringify(
      {
        devDependencies: {[SDK_PKG]: OLD_PIN},
        name: 'fixture',
        scripts: {
          // The retired spellings a sweep is supposed to rewrite (D1).
          doctor: 'bunx @justinhaaheim/justin-sdk doctor',
          signal: 'bunx @justinhaaheim/justin-sdk signal --quiet',
        },
        version: '0.0.1',
      },
      null,
      2,
    )}\n`,
  );
  write(
    root,
    'justin-sdk.config.json',
    `${JSON.stringify(
      {
        components: [
          'gitignore-setup',
          'prettier-setup',
          'critical-rules-setup',
        ],
        componentConfig: {
          'critical-rules': {modules: ['alpha', 'omega']},
          'time-check': {gapHours: 4},
          'usage-check': {enabled: true},
        },
        lastSynced: '2000-01-01',
        version: '0.0.1-fixture',
      },
      null,
      2,
    )}\n`,
  );
  // Offline: a file: dependency never reaches a registry.
  execFileSync('bun', ['install'], {cwd: root, stdio: 'ignore'});
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'enrolled, old style']);

  return {
    config: () =>
      readJson(join(root, 'justin-sdk.config.json')) as Record<string, unknown>,
    pkg: () =>
      JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as {
        devDependencies?: Record<string, string>;
        scripts?: Record<string, string>;
      },
    root,
  };
}

const componentsOf = (config: Record<string, unknown>): string[] =>
  (config.components as string[] | undefined) ?? [];

// ---------------------------------------------------------------------------
// The pure decisions
// ---------------------------------------------------------------------------

describe('adoptInstalledComponents', () => {
  test('adopts what is installed and unlisted, and nothing else', () => {
    const sb = track(createSandbox());
    const fixture = enrolledRepo(sb);
    const result = adoptInstalledComponents(fixture.root, fixture.config());
    expect(result.adopted.sort()).toEqual([
      'time-check-setup',
      'usage-check-setup',
    ]);
    expect(componentsOf(result.config)).toHaveLength(5);
    // Additive: every previously listed name survives.
    for (const name of [
      'gitignore-setup',
      'prettier-setup',
      'critical-rules-setup',
    ]) {
      expect(componentsOf(result.config)).toContain(name);
    }
  });

  test('a second pass adopts nothing (it converges)', () => {
    const sb = track(createSandbox());
    const fixture = enrolledRepo(sb);
    const once = adoptInstalledComponents(fixture.root, fixture.config());
    expect(adoptInstalledComponents(fixture.root, once.config).adopted).toEqual(
      [],
    );
  });
});

describe('dropDeadConfigKeys', () => {
  test('drops the three, names them, and touches nothing else', () => {
    const before = {
      componentConfig: {
        'critical-rules': {modules: ['a']},
        'time-check': {gapHours: 4},
      },
      components: ['gitignore-setup'],
      lastSynced: '2000-01-01',
      version: '0.0.1',
    };
    const {config, dropped} = dropDeadConfigKeys(before);
    expect(dropped).toEqual([
      'version',
      'lastSynced',
      'componentConfig["critical-rules"].modules',
    ]);
    expect(config).toEqual({
      componentConfig: {'critical-rules': {}, 'time-check': {gapHours: 4}},
      components: ['gitignore-setup'],
    });
    // The input is not mutated — the caller may still need it (the dry-run
    // measures the BEFORE state against it).
    expect(before.version).toBe('0.0.1');
  });

  test('a config with none of them is returned unchanged', () => {
    const before = {components: ['gitignore-setup']};
    expect(dropDeadConfigKeys(before)).toEqual({config: before, dropped: []});
  });
});

// ---------------------------------------------------------------------------
// The plan, and the negative control
// ---------------------------------------------------------------------------

describe('planInstallPayload', () => {
  test('names the adoptions, the dead keys, and what no-remove is protecting', () => {
    const sb = track(createSandbox());
    const fixture = enrolledRepo(sb);
    const plan = planInstallPayload(fixture.root);
    if ('error' in plan) throw new Error(plan.error);

    expect(plan.adopted.sort()).toEqual([
      'time-check-setup',
      'usage-check-setup',
    ]);
    expect(plan.dropped).toEqual([
      'version',
      'lastSynced',
      'componentConfig["critical-rules"].modules',
    ]);
    expect(plan.protectedFromRemoval.sort()).toEqual([
      'time-check',
      'usage-check',
    ]);

    const rendered = renderInstallPayloadPlan(plan).join('\n');
    expect(rendered).toContain('adopt: time-check-setup, usage-check-setup');
    expect(rendered).toContain('delete: version, lastSynced');
    expect(rendered).toContain('remove: DISABLED');
    expect(rendered).toContain('time-check, usage-check');
  });

  test('AC F2: no sweep path asks install to remove anything', () => {
    // The DEFAULT sweep (no --component) runs `update` in the worktree, which
    // delegates to `install`. Two independent guards have to hold: install does
    // not remove unless told (proved in components-lifecycle), and the sweep
    // never tells it. This is the second — asserted on the literal argv the
    // fleet path runs, which is why it is a named constant (dchjw.17 F2).
    expect(SWEEP_UPDATE_ARGS).not.toContain('--prune');
    expect([...SWEEP_UPDATE_ARGS]).toEqual([
      'update',
      '--no-self-update',
      '--allow-dirty',
      '--quiet',
    ]);
  });

  test('NEGATIVE CONTROL: with --prune, those two would be deleted', () => {
    // The state of the repo TODAY, with no adoption in between: this is what
    // `install --prune` over the fleet would have taken out. (Plain `install`
    // removes nothing at all since dchjw.17 F1 — the adoption is what keeps the
    // names out of this list even then.)
    const sb = track(createSandbox());
    const fixture = enrolledRepo(sb);
    const asItStands = planInstall(fixture.root, fixture.config());
    if ('error' in asItStands) throw new Error(asItStands.error);
    expect(asItStands.unlisted.sort()).toEqual(['time-check', 'usage-check']);
  });
});

// ---------------------------------------------------------------------------
// The payload end to end
// ---------------------------------------------------------------------------

describe('applySweepPayload({mode: install})', () => {
  test('adopts, deletes, pins, installs — and removes nothing', async () => {
    const sb = track(createSandbox());
    promptsFixture(sb);
    const fixture = enrolledRepo(sb);

    const outcome = await applySweepPayload(
      fixture.root,
      {mode: 'install'},
      {pin: NEW_PIN},
    );
    if (!outcome.ok) throw new Error(outcome.detail);

    const config = fixture.config();
    // 1. Everything installed is listed — five, not three.
    expect(componentsOf(config)).toHaveLength(5);
    expect(componentsOf(config)).toContain('time-check-setup');
    expect(componentsOf(config)).toContain('usage-check-setup');

    // 2. The dead keys are gone.
    expect('version' in config).toBe(false);
    expect('lastSynced' in config).toBe(false);
    const blocks = config.componentConfig as Record<
      string,
      Record<string, unknown>
    >;
    expect('modules' in (blocks['critical-rules'] ?? {})).toBe(false);
    // ...and a TUNED block is not collateral damage.
    expect(blocks['time-check']?.gapHours).toBe(4);

    // 3. The pin moved, exactly once.
    expect(fixture.pkg().devDependencies?.[SDK_PKG]).toBe(NEW_PIN);

    // 4. The retired script spellings were rewritten to the D1 form.
    expect(fixture.pkg().scripts?.doctor).toBe('justin-sdk doctor');
    expect(JSON.stringify(fixture.pkg().scripts)).not.toContain('bunx');

    // 5. The rules artifact was regenerated from the registry, with its header.
    const artifact = join(
      fixture.root,
      '.claude',
      'rules',
      'justin-sdk',
      'critical-rules.md',
    );
    expect(existsSync(artifact)).toBe(true);
    const text = readFileSync(artifact, 'utf-8');
    expect(text).toContain('prompts ');
    expect(text).toContain('ALPHA_RULE');

    // 6. Nothing was removed: the two adopted components still have their
    //    evidence, and the payload says so out loud.
    expect(blocks['usage-check']).toBeDefined();
    expect(outcome.note).toContain('adopted time-check-setup');
    expect(outcome.note).toContain('removals disabled');
  }, 60_000);

  test('a second run over the same repo changes the config not at all', async () => {
    const sb = track(createSandbox());
    promptsFixture(sb);
    const fixture = enrolledRepo(sb);

    await applySweepPayload(fixture.root, {mode: 'install'}, {pin: NEW_PIN});
    const afterFirst = readFileSync(
      join(fixture.root, 'justin-sdk.config.json'),
      'utf-8',
    );
    const outcome = await applySweepPayload(
      fixture.root,
      {mode: 'install'},
      {pin: NEW_PIN},
    );
    expect(outcome.ok).toBe(true);
    expect(
      readFileSync(join(fixture.root, 'justin-sdk.config.json'), 'utf-8'),
    ).toBe(afterFirst);
  }, 60_000);

  test('a repo that is not enrolled fails loudly rather than enrolling it', async () => {
    const sb = track(createSandbox());
    const root = join(sb.path, 'bare-repo');
    mkdirSync(root, {recursive: true});
    write(root, 'package.json', '{"name":"not-enrolled"}\n');

    const outcome = await applySweepPayload(
      root,
      {mode: 'install'},
      {
        pin: NEW_PIN,
      },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.detail).toContain('not enrolled');
  });
});

describe('runSweep --dry-run --component install', () => {
  async function captureLog<T>(fn: () => Promise<T>): Promise<string> {
    const original = console.log;
    let out = '';
    console.log = (...args: unknown[]) => {
      out += `${args.join(' ')}\n`;
    };
    try {
      await fn();
    } finally {
      console.log = original;
    }
    return out;
  }

  test('prints the per-repo plan and writes nothing', async () => {
    const sb = track(createSandbox());
    const fixture = enrolledRepo(sb);
    const configBefore = readFileSync(
      join(fixture.root, 'justin-sdk.config.json'),
      'utf-8',
    );
    const pkgBefore = readFileSync(join(fixture.root, 'package.json'), 'utf-8');

    const out = await captureLog(() =>
      runSweep({component: 'install', dryRun: true, repos: [fixture.root]}),
    );
    const plain = out.replace(/\x1b\[[0-9;]*m/g, '');

    expect(plain).toContain('would refresh enrollment off main');
    expect(plain).toContain('adopt: time-check-setup, usage-check-setup');
    expect(plain).toContain('delete: version, lastSynced');
    expect(plain).toContain('remove: DISABLED');

    // Writes nothing. Asserted on the bytes, not on the word "dry-run".
    expect(
      readFileSync(join(fixture.root, 'justin-sdk.config.json'), 'utf-8'),
    ).toBe(configBefore);
    expect(readFileSync(join(fixture.root, 'package.json'), 'utf-8')).toBe(
      pkgBefore,
    );
  }, 30_000);

  test('an unknown --component still refuses the whole run, mentioning install', async () => {
    const out = await captureLog(() =>
      runSweep({component: 'no-such-thing', dryRun: true, repos: []}),
    );
    expect(out).toContain('unknown component');
    expect(out).toContain('"install"');
  });
});

describe('the commit message names the payload', () => {
  test('install mode is not mistaken for the full sweep', () => {
    expect(sweepCommitMessage({mode: 'install'})).toContain('sweep install');
    expect(sweepCommitMessage({mode: 'install'})).toContain('no removals');
  });
});
