/**
 * components-lifecycle.test.ts — the npm-shaped component model end to end
 * (epic home-base-dchjw D3, bead dchjw.5 Part B): variadic `add`, `remove`'s
 * identity rules, `install`'s two-way reconcile, and `list`.
 *
 * WHAT THIS FILE IS REALLY GUARDING. `remove` and `install` are the SDK's first
 * delete verbs. The whole safety argument is that deletion happens on BYTE
 * IDENTITY and never on a filename, so the tests that matter most here are the
 * PAIRS: the same component, the same file, deleted when pristine and kept when
 * a human touched it. A test that only proves "it deletes" would pass just as
 * happily on an `rm` that deletes everything.
 *
 * Every test runs against a temp sandbox. Nothing here may write into the SDK
 * checkout — see the `no leak` describe at the bottom, which asserts it.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {execSync} from 'child_process';
import {existsSync, readFileSync, writeFileSync} from 'fs';
import {join} from 'path';

import {expandTargets, runAdd} from '../src/add';
import {COMPONENT_MANIFESTS} from '../src/component-manifest';
import {corePreset} from '../src/component-registry';
import {runInit} from '../src/init';
import {planInstall, runInstall} from '../src/install';
import {buildComponentListing, renderComponentListing} from '../src/list';
import {removeComponent, runRemove} from '../src/remove';
import {TIME_CHECK_HOOK_COMMAND} from '../src/time-check-setup';
import {createProjectSandbox, createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];

function track(sandbox: Sandbox): Sandbox {
  sandboxes.push(sandbox);
  return sandbox;
}

afterEach(() => {
  cachedRemote = null;
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

function initGitRepo(path: string): void {
  execSync('git init -q', {cwd: path});
  execSync('git config user.email "test@example.com"', {cwd: path});
  execSync('git config user.name "Test"', {cwd: path});
}

/**
 * A bare git repo carrying the tag this SDK would pin to, so `stepDepsHasSdk`
 * runs its real `git ls-remote` verification hermetically. Copied in shape from
 * tests/sdk-invocation.test.ts.
 *
 * It gets its OWN sandbox: built inside the project sandbox it would leave two
 * untracked directories there, and init's preflight would refuse the dirty tree
 * — a failure that looks like the feature is broken and is not.
 */
function remoteWithOwnTag(): string {
  const host = track(createSandbox());
  const work = join(host.path, 'remote-work');
  execSync(`mkdir -p '${work}'`);
  execSync('git init -q -b main .', {cwd: work});
  execSync('git config user.email "test@example.com"', {cwd: work});
  execSync('git config user.name "Test"', {cwd: work});
  execSync("git commit -q --allow-empty -m 'init'", {cwd: work});
  const version = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf-8'),
  ) as {version: string};
  execSync(`git tag v${version.version}`, {cwd: work});
  const bare = join(host.path, 'remote.git');
  execSync(`git clone -q --bare '${work}' '${bare}'`, {cwd: host.path});
  return bare;
}

/**
 * The bare remote for THIS test, built once and reused.
 *
 * EVERY `add`/`install`/`init` in this file needs one (dchjw.17 F7). Each of
 * them chains base-setup, whose `stepDepsHasSdk` verifies the pin tag with a
 * real `git ls-remote` — so before this, every test in the file hit
 * github.com, once per component. That is a suite that fails on a plane, that
 * cannot be trusted offline, and whose "measured" exit codes were partly a
 * network's opinion. Memoized per test rather than per call because the fixture
 * is three git invocations and there are twenty call sites; `afterEach` drops
 * the memo with the sandbox it points at.
 */
let cachedRemote: string | null = null;

function sdkRemote(): string {
  cachedRemote ??= remoteWithOwnTag();
  return cachedRemote;
}

/**
 * Everything a command printed, `console.log` and `console.warn` both.
 *
 * `warn` is not optional here: every line that says what `install` is NOT
 * doing — the kept-components notice, each `would remove:` — goes to
 * console.warn, so a capture that took only console.log would assert on a
 * plan it could not see.
 */
async function captureOutput<T>(
  fn: () => Promise<T>,
): Promise<{out: string; value: T}> {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const lines: string[] = [];
  const collect = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(' '));
  };
  console.log = collect;
  console.warn = collect;
  try {
    const value = await fn();
    return {out: lines.join('\n'), value};
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

function readConfig(root: string): {
  componentConfig?: Record<string, unknown>;
  components?: string[];
} {
  return JSON.parse(
    readFileSync(join(root, 'justin-sdk.config.json'), 'utf-8'),
  ) as {componentConfig?: Record<string, unknown>; components?: string[]};
}

function readScripts(root: string): Record<string, string> {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as {
    scripts?: Record<string, string>;
  };
  return pkg.scripts ?? {};
}

/** The bytes the component would write for one of its owned files. */
function pristineFor(
  component: keyof typeof COMPONENT_MANIFESTS,
  path: string,
) {
  const owned = COMPONENT_MANIFESTS[component].files.find(
    (file) => file.path === path,
  );
  if (owned == null) throw new Error(`${component} does not own ${path}`);
  return owned.pristine();
}

// ---------------------------------------------------------------------------
// AC 1 — init writes config + dep + scripts and NO component files
// ---------------------------------------------------------------------------

describe('init: enrols the repo and installs no components (AC 1)', () => {
  test('writes config, the SDK devDependency and the base scripts only', async () => {
    const sb = track(createSandbox());
    initGitRepo(sb.path);

    const exitCode = await runInit({
      noCommit: true,
      projectRoot: sb.path,
      quiet: true,
      sdkRepoUrl: sdkRemote(),
      skipDoctor: true,
      skipInstall: true,
    });
    expect(exitCode).toBe(0);

    // What init DOES write.
    expect(existsSync(join(sb.path, 'justin-sdk.config.json'))).toBe(true);
    const pkg = JSON.parse(
      readFileSync(join(sb.path, 'package.json'), 'utf-8'),
    ) as {devDependencies?: Record<string, string>};
    expect(pkg.devDependencies?.['@justinhaaheim/justin-sdk']).toContain(
      'github:justinhaaheim/justin-sdk#v',
    );
    const scripts = readScripts(sb.path);
    for (const key of ['doctor', 'signal', 'fix', 'setup-env']) {
      expect(scripts[key]).toBeDefined();
    }

    // What it must NOT write: any component's files.
    for (const artifact of [
      '.prettierrc.json',
      '.prettierignore',
      'tsconfig.json',
      'eslint.config.cjs',
      '.husky',
      '.github/workflows/signal.yml',
      'mise.toml',
      '.claude/rules/justin-sdk/critical-rules.md',
    ]) {
      expect(existsSync(join(sb.path, artifact))).toBe(false);
    }

    // No `components` key: absent means "track core" (D3).
    expect(readConfig(sb.path).components).toBeUndefined();
  });

  test('--components LISTS names without installing them', async () => {
    const sb = track(createSandbox());
    initGitRepo(sb.path);

    const exitCode = await runInit({
      components: ['gitignore', 'prettier'],
      noCommit: true,
      projectRoot: sb.path,
      quiet: true,
      sdkRepoUrl: sdkRemote(),
      skipDoctor: true,
      skipInstall: true,
    });
    expect(exitCode).toBe(0);
    expect(readConfig(sb.path).components).toEqual([
      'gitignore-setup',
      'prettier-setup',
    ]);
    expect(existsSync(join(sb.path, '.prettierrc.json'))).toBe(false);
  });

  test('--components refuses an unknown name rather than writing it', async () => {
    const sb = track(createSandbox());
    initGitRepo(sb.path);

    const exitCode = await runInit({
      components: ['gitignore', 'prompts'],
      noCommit: true,
      projectRoot: sb.path,
      quiet: true,
      sdkRepoUrl: sdkRemote(),
      skipDoctor: true,
      skipInstall: true,
    });
    expect(exitCode).toBe(1);
    expect(readConfig(sb.path).components).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC 2 / B1 — variadic add, then remove
// ---------------------------------------------------------------------------

describe('add is variadic (AC 2, B1)', () => {
  test('expandTargets dedupes and returns dependency order, not typed order', () => {
    const sb = track(createProjectSandbox());
    expect(expandTargets(['eslint', 'gitignore', 'eslint'], sb.path)).toEqual([
      'gitignore',
      'eslint',
    ]);
  });

  test('`core` expands inside a longer argument list', () => {
    const sb = track(createProjectSandbox());
    const expanded = expandTargets(['core', 'gitignore'], sb.path);
    expect(expanded).toEqual(corePreset(sb.path));
  });

  test('add gitignore prettier eslint installs three and registers three', async () => {
    const sb = track(createProjectSandbox());
    initGitRepo(sb.path);

    const exitCode = await runAdd(['gitignore', 'prettier', 'eslint'], {
      commit: false,
      force: false,
      projectRoot: sb.path,
      sdkRepoUrl: sdkRemote(),
    });
    expect(exitCode).toBe(0);

    expect(existsSync(join(sb.path, '.gitignore'))).toBe(true);
    expect(existsSync(join(sb.path, '.prettierrc.json'))).toBe(true);
    expect(existsSync(join(sb.path, 'eslint.config.cjs'))).toBe(true);
    expect(readConfig(sb.path).components).toEqual([
      'gitignore-setup',
      'prettier-setup',
      'eslint-setup',
    ]);
  });

  test('an unknown name is refused before anything is installed', async () => {
    const sb = track(createProjectSandbox());
    initGitRepo(sb.path);
    const exitCode = await runAdd(['gitignore', 'prompts'], {
      commit: false,
      force: false,
      projectRoot: sb.path,
      sdkRepoUrl: sdkRemote(),
    });
    expect(exitCode).toBe(1);
    expect(existsSync(join(sb.path, '.gitignore'))).toBe(false);
  });
});

describe('remove: pristine artifacts go, modified ones stay (AC 2, AC 10)', () => {
  test('remove prettier deletes its files, scripts and config entry', async () => {
    const sb = track(createProjectSandbox());
    initGitRepo(sb.path);
    await runAdd(['prettier'], {
      commit: false,
      force: false,
      projectRoot: sb.path,
      sdkRepoUrl: sdkRemote(),
    });
    expect(existsSync(join(sb.path, '.prettierrc.json'))).toBe(true);
    expect(readScripts(sb.path)['prettier:write']).toBe('prettier --write .');

    const report = removeComponent(sb.path, 'prettier');

    expect(existsSync(join(sb.path, '.prettierrc.json'))).toBe(false);
    expect(existsSync(join(sb.path, '.prettierignore'))).toBe(false);
    expect(readScripts(sb.path)['prettier:write']).toBeUndefined();
    expect(readScripts(sb.path)['fix-source:PRETTIER']).toBeUndefined();
    // …but `signal-source:PRETTIER` STAYS. base-setup seeds all three
    // signal-source scripts into every enrolled repo whether or not the
    // matching component is installed, so it was never prettier's to delete.
    expect(readScripts(sb.path)['signal-source:PRETTIER']).toBe(
      'prettier --check .',
    );
    expect(readConfig(sb.path).components).not.toContain('prettier-setup');
    expect(report.outcomes.map((o) => o.kind)).not.toContain('modified');
  });

  test('NEGATIVE CONTROL: a hand-modified .prettierrc.json survives, and says so', async () => {
    const sb = track(createProjectSandbox());
    initGitRepo(sb.path);
    await runAdd(['prettier'], {
      commit: false,
      force: false,
      projectRoot: sb.path,
      sdkRepoUrl: sdkRemote(),
    });
    const target = join(sb.path, '.prettierrc.json');
    writeFileSync(target, '{"semi": false, "mine": true}\n');

    const report = removeComponent(sb.path, 'prettier');

    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf-8')).toBe(
      '{"semi": false, "mine": true}\n',
    );
    expect(report.outcomes).toContainEqual({
      kind: 'modified',
      what: '.prettierrc.json',
    });
    // The untouched sibling still goes — removal is per-artifact, not all-or-nothing.
    expect(existsSync(join(sb.path, '.prettierignore'))).toBe(false);
  });

  test('a hand-edited script value is left in place, not deleted', async () => {
    const sb = track(createProjectSandbox());
    initGitRepo(sb.path);
    await runAdd(['prettier'], {
      commit: false,
      force: false,
      projectRoot: sb.path,
      sdkRepoUrl: sdkRemote(),
    });
    const pkgPath = join(sb.path, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
      scripts: Record<string, string>;
    };
    pkg.scripts['prettier:write'] = 'prettier --write src/';
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

    const report = removeComponent(sb.path, 'prettier');

    expect(readScripts(sb.path)['prettier:write']).toBe(
      'prettier --write src/',
    );
    expect(report.outcomes).toContainEqual({
      kind: 'modified',
      what: 'package.json scripts.prettier:write',
    });
  });

  test('AC 10: a hand-edited eslint.config.cjs survives remove eslint', async () => {
    const sb = track(createProjectSandbox());
    initGitRepo(sb.path);
    await runAdd(['eslint'], {
      commit: false,
      force: false,
      projectRoot: sb.path,
      sdkRepoUrl: sdkRemote(),
    });
    const target = join(sb.path, 'eslint.config.cjs');
    const mine = `${readFileSync(target, 'utf-8')}\n// my own rule\n`;
    writeFileSync(target, mine);

    const report = removeComponent(sb.path, 'eslint');

    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf-8')).toBe(mine);
    expect(report.outcomes).toContainEqual({
      kind: 'modified',
      what: 'eslint.config.cjs',
    });
  });

  test('AC 10 negative control: a PRISTINE eslint.config.cjs is deleted', async () => {
    const sb = track(createProjectSandbox());
    initGitRepo(sb.path);
    await runAdd(['eslint'], {
      commit: false,
      force: false,
      projectRoot: sb.path,
      sdkRepoUrl: sdkRemote(),
    });
    const target = join(sb.path, 'eslint.config.cjs');
    // Prove the file on disk really is what the component would write — the
    // premise the whole deletion rule rests on. A null pristine would mean the
    // template could not be read, which must never silently pass for "matches".
    const pristine = pristineFor('eslint', 'eslint.config.cjs');
    expect(pristine).not.toBeNull();
    expect(readFileSync(target, 'utf-8')).toBe(pristine!);

    const report = removeComponent(sb.path, 'eslint');

    expect(existsSync(target)).toBe(false);
    expect(report.outcomes).toContainEqual({
      kind: 'removed',
      what: 'eslint.config.cjs',
    });
  });

  test('base-setup cannot be removed', () => {
    const sb = track(createProjectSandbox({justinSdkConfig: {}}));
    expect(runRemove(['base-setup'], {projectRoot: sb.path, quiet: true})).toBe(
      1,
    );
    expect(existsSync(join(sb.path, 'justin-sdk.config.json'))).toBe(true);
  });

  test('an unknown component name is refused', () => {
    const sb = track(createProjectSandbox({justinSdkConfig: {}}));
    expect(runRemove(['prompts'], {projectRoot: sb.path, quiet: true})).toBe(1);
  });

  test('remove time-check takes its hook and its componentConfig block', async () => {
    const sb = track(createProjectSandbox());
    initGitRepo(sb.path);
    await runAdd(['time-check'], {
      commit: false,
      force: false,
      projectRoot: sb.path,
      sdkRepoUrl: sdkRemote(),
    });
    expect(readConfig(sb.path).componentConfig?.['time-check']).toBeDefined();
    const settingsPath = join(sb.path, '.claude', 'settings.json');
    expect(readFileSync(settingsPath, 'utf-8')).toContain(
      'justin-sdk time-check',
    );

    removeComponent(sb.path, 'time-check');

    expect(readFileSync(settingsPath, 'utf-8')).not.toContain(
      'justin-sdk time-check',
    );
    expect(readConfig(sb.path).componentConfig?.['time-check']).toBeUndefined();
  });

  test('AC F5: NEGATIVE CONTROL — a hook someone composed onto survives, and says modified', async () => {
    // Removal matched by SUBSTRING before dchjw.17 F5, so
    // `bun run justin-sdk time-check && my-own-thing` — one command, half of it
    // a person's — was deleted whole. A hook command is under the same identity
    // rule as a file's bytes: exactly ours, or it stays.
    const sb = track(createProjectSandbox());
    initGitRepo(sb.path);
    await runAdd(['time-check'], {
      commit: false,
      force: false,
      projectRoot: sb.path,
      sdkRepoUrl: sdkRemote(),
    });

    const settingsPath = join(sb.path, '.claude', 'settings.json');
    const composed = `${TIME_CHECK_HOOK_COMMAND} && my-own-thing`;
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
      hooks: {UserPromptSubmit: {hooks: {command: string}[]}[]};
    };
    settings.hooks.UserPromptSubmit = [
      {hooks: [{command: composed, type: 'command'}]},
    ] as never;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

    const report = removeComponent(sb.path, 'time-check');

    expect(readFileSync(settingsPath, 'utf-8')).toContain('my-own-thing');
    expect(
      report.outcomes.some(
        (outcome) =>
          outcome.kind === 'modified' && outcome.what.includes(composed),
      ),
    ).toBe(true);
    // No HOOK was removed. (The componentConfig block still goes — it is
    // pristine, and it is a different artifact under the same identity rule.)
    expect(
      report.outcomes.some(
        (outcome) =>
          outcome.kind === 'removed' && outcome.what.includes('settings.json'),
      ),
    ).toBe(false);
  });

  test('AC F5 positive control: the EXACT command the installer writes is removed', async () => {
    const sb = track(createProjectSandbox());
    initGitRepo(sb.path);
    await runAdd(['time-check'], {
      commit: false,
      force: false,
      projectRoot: sb.path,
      sdkRepoUrl: sdkRemote(),
    });
    const settingsPath = join(sb.path, '.claude', 'settings.json');
    expect(readFileSync(settingsPath, 'utf-8')).toContain(
      TIME_CHECK_HOOK_COMMAND,
    );

    const report = removeComponent(sb.path, 'time-check');

    expect(readFileSync(settingsPath, 'utf-8')).not.toContain(
      TIME_CHECK_HOOK_COMMAND,
    );
    expect(
      report.outcomes.some(
        (outcome) =>
          outcome.kind === 'removed' &&
          outcome.what.includes(TIME_CHECK_HOOK_COMMAND),
      ),
    ).toBe(true);
  });

  test('NEGATIVE CONTROL: a TUNED componentConfig block survives remove', async () => {
    const sb = track(createProjectSandbox());
    initGitRepo(sb.path);
    await runAdd(['time-check'], {
      commit: false,
      force: false,
      projectRoot: sb.path,
      sdkRepoUrl: sdkRemote(),
    });

    // The settings a person chose — a gapHours, an `enabled: false`, a
    // wrapUpAt — are theirs, and dropping a component must not take them.
    const configPath = join(sb.path, 'justin-sdk.config.json');
    const config = readConfig(sb.path) as Record<string, unknown>;
    (config.componentConfig as Record<string, unknown>)['time-check'] = {
      enabled: true,
      gapHours: 4,
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

    const report = removeComponent(sb.path, 'time-check');

    expect(
      (
        readConfig(sb.path).componentConfig?.['time-check'] as {
          gapHours?: number;
        }
      )?.gapHours,
    ).toBe(4);
    expect(report.outcomes).toContainEqual({
      kind: 'modified',
      what: 'justin-sdk.config.json componentConfig.time-check',
    });
    // The hook still goes: removal is per-artifact, not all-or-nothing.
    expect(
      readFileSync(join(sb.path, '.claude', 'settings.json'), 'utf-8'),
    ).not.toContain('justin-sdk time-check');
  });
});

// ---------------------------------------------------------------------------
// AC 3 — install reconciles BOTH directions
// ---------------------------------------------------------------------------

describe('install reconciles config → disk both ways (AC 3)', () => {
  test('a component added to the config is installed', async () => {
    const sb = track(createProjectSandbox());
    initGitRepo(sb.path);
    await runAdd(['gitignore'], {
      commit: false,
      force: false,
      projectRoot: sb.path,
      sdkRepoUrl: sdkRemote(),
    });
    expect(existsSync(join(sb.path, '.prettierrc.json'))).toBe(false);

    // Edit the config by hand, the way a person would.
    const configPath = join(sb.path, 'justin-sdk.config.json');
    const config = readConfig(sb.path);
    config.components = [...(config.components ?? []), 'prettier-setup'];
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

    const exitCode = await runInstall({
      projectRoot: sb.path,
      quiet: true,
      sdkRepoUrl: sdkRemote(),
    });
    expect(exitCode).toBe(0);
    expect(existsSync(join(sb.path, '.prettierrc.json'))).toBe(true);
  });

  test('AC F1: a component dropped from the config is KEPT, and install says what --prune would do', async () => {
    // THE REGRESSION THIS GUARDS. install used to remove here — and "installed"
    // is decided by evidence like a filename or a value-matched line, which is
    // not provenance. Measured on home-base's own committed config, that made a
    // plain `install` delete 13 .gitignore lines, .prettierrc.json, 7
    // .prettierignore lines and 9 package.json scripts (dchjw.17 F1).
    const sb = track(createProjectSandbox());
    initGitRepo(sb.path);
    await runAdd(['gitignore', 'prettier'], {
      commit: false,
      force: false,
      projectRoot: sb.path,
      sdkRepoUrl: sdkRemote(),
    });
    expect(existsSync(join(sb.path, '.prettierrc.json'))).toBe(true);

    const configPath = join(sb.path, 'justin-sdk.config.json');
    writeFileSync(
      configPath,
      JSON.stringify({components: ['gitignore-setup']}, null, 2) + '\n',
    );

    const {out, value} = await captureOutput(() =>
      runInstall({projectRoot: sb.path, sdkRepoUrl: sdkRemote()}),
    );
    expect(value).toBe(0);
    expect(existsSync(join(sb.path, '.prettierrc.json'))).toBe(true);
    expect(existsSync(join(sb.path, '.prettierignore'))).toBe(true);
    expect(existsSync(join(sb.path, '.gitignore'))).toBe(true);
    expect(out).toContain('install NEVER removes');
    expect(out).toContain('--prune --dry-run');
    expect(out).toContain('prettier');
  });

  test('POSITIVE CONTROL: --prune does remove it', async () => {
    const sb = track(createProjectSandbox());
    initGitRepo(sb.path);
    await runAdd(['gitignore', 'prettier'], {
      commit: false,
      force: false,
      projectRoot: sb.path,
      sdkRepoUrl: sdkRemote(),
    });
    writeFileSync(
      join(sb.path, 'justin-sdk.config.json'),
      JSON.stringify({components: ['gitignore-setup']}, null, 2) + '\n',
    );

    const exitCode = await runInstall({
      projectRoot: sb.path,
      prune: true,
      quiet: true,
      sdkRepoUrl: sdkRemote(),
    });
    expect(exitCode).toBe(0);
    expect(existsSync(join(sb.path, '.prettierrc.json'))).toBe(false);
    expect(existsSync(join(sb.path, '.gitignore'))).toBe(true);
  });

  test('AC F6: --prune --dry-run names every file, line, script, hook and key — and changes nothing', async () => {
    const sb = track(createProjectSandbox());
    initGitRepo(sb.path);
    await runAdd(['gitignore', 'prettier', 'time-check'], {
      commit: false,
      force: false,
      projectRoot: sb.path,
      sdkRepoUrl: sdkRemote(),
    });
    // Empty the LIST only — the componentConfig blocks the installers seeded
    // stay, because they are part of what --prune has to account for.
    const configPath = join(sb.path, 'justin-sdk.config.json');
    const config = readConfig(sb.path);
    writeFileSync(
      configPath,
      JSON.stringify({...config, components: []}, null, 2) + '\n',
    );

    const before = readFileSync(join(sb.path, '.prettierrc.json'), 'utf-8');
    const {out, value} = await captureOutput(() =>
      runInstall({
        dryRun: true,
        projectRoot: sb.path,
        prune: true,
        sdkRepoUrl: sdkRemote(),
      }),
    );
    expect(value).toBe(0);

    // Every KIND of artifact, named individually — never "would remove prettier".
    expect(out).toContain('would remove: .prettierrc.json');
    expect(out).toContain('would remove: .prettierignore');
    expect(out).toContain('would remove: package.json scripts.prettier:check');
    expect(out).toContain(
      'would remove: justin-sdk.config.json componentConfig.time-check',
    );
    expect(out).toContain(
      'would remove: .claude/settings.json UserPromptSubmit hook',
    );
    // And the .gitignore lines BY NAME — the reviewer's own measurement.
    for (const line of ['node_modules/', 'tmp/', '.DS_Store']) {
      expect(out).toContain(`would remove: .gitignore line '${line}'`);
    }

    // A dry-run is a read. Nothing moved.
    expect(readFileSync(join(sb.path, '.prettierrc.json'), 'utf-8')).toBe(
      before,
    );
    expect(existsSync(join(sb.path, '.prettierignore'))).toBe(true);
    expect(readFileSync(join(sb.path, '.gitignore'), 'utf-8')).toContain(
      'node_modules/',
    );
    expect(readScripts(sb.path)['prettier:check']).toBeDefined();
  });

  test('AC F7: what a human wrote BEFORE enrolment survives --prune', async () => {
    // The case no earlier test could reach: every fixture built its "installed"
    // state by running `add`, so nothing in the suite had a pre-existing human
    // line or script. Those are exactly what install was deleting in the fleet.
    const sb = track(createProjectSandbox());
    initGitRepo(sb.path);
    const gitignorePath = join(sb.path, '.gitignore');
    writeFileSync(gitignorePath, 'node_modules/\nmy-scratch-dir/\n*.bak\n');
    const pkgPath = join(sb.path, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
      scripts?: Record<string, string>;
    };
    pkg.scripts = {...(pkg.scripts ?? {}), 'prettier:check': 'echo mine'};
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

    await runAdd(['prettier'], {
      commit: false,
      force: false,
      projectRoot: sb.path,
      sdkRepoUrl: sdkRemote(),
    });
    writeFileSync(
      join(sb.path, 'justin-sdk.config.json'),
      JSON.stringify({components: []}, null, 2) + '\n',
    );

    const {out} = await captureOutput(() =>
      runInstall({projectRoot: sb.path, prune: true, sdkRepoUrl: sdkRemote()}),
    );

    // The human's own lines are untouched…
    const gitignore = readFileSync(gitignorePath, 'utf-8');
    expect(gitignore).toContain('my-scratch-dir/');
    expect(gitignore).toContain('*.bak');
    // …and so is the script whose VALUE they chose, though prettier claims the key.
    expect(readScripts(sb.path)['prettier:check']).toBe('echo mine');
    expect(out).toContain(
      'left in place (modified): package.json scripts.prettier:check',
    );
  });

  test('NEGATIVE CONTROL: reconcile does not delete a component the user customised', async () => {
    const sb = track(createProjectSandbox());
    initGitRepo(sb.path);
    await runAdd(['gitignore', 'eslint'], {
      commit: false,
      force: false,
      projectRoot: sb.path,
      sdkRepoUrl: sdkRemote(),
    });
    const target = join(sb.path, 'eslint.config.cjs');
    const mine = `${readFileSync(target, 'utf-8')}\n// mine\n`;
    writeFileSync(target, mine);

    writeFileSync(
      join(sb.path, 'justin-sdk.config.json'),
      JSON.stringify({components: ['gitignore-setup']}, null, 2) + '\n',
    );

    await runInstall({
      projectRoot: sb.path,
      quiet: true,
      sdkRepoUrl: sdkRemote(),
    });

    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf-8')).toBe(mine);
  });

  test('--dry-run changes nothing', async () => {
    const sb = track(createProjectSandbox());
    initGitRepo(sb.path);
    await runAdd(['gitignore', 'prettier'], {
      commit: false,
      force: false,
      projectRoot: sb.path,
      sdkRepoUrl: sdkRemote(),
    });
    writeFileSync(
      join(sb.path, 'justin-sdk.config.json'),
      JSON.stringify({components: ['gitignore-setup']}, null, 2) + '\n',
    );

    await runInstall({
      dryRun: true,
      projectRoot: sb.path,
      quiet: true,
      sdkRepoUrl: sdkRemote(),
    });
    expect(existsSync(join(sb.path, '.prettierrc.json'))).toBe(true);
  });

  test('a components key that is not an array is a FAILURE, not an empty plan', () => {
    const sb = track(createProjectSandbox());
    const plan = planInstall(sb.path, {components: 'prettier-setup'});
    expect('error' in plan).toBe(true);
  });

  test('an unknown name in components is reported, not silently dropped', () => {
    const sb = track(createProjectSandbox());
    const plan = planInstall(sb.path, {
      components: ['prettier-setup', 'prompts-setup'],
    });
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.unknown).toEqual(['prompts-setup']);
    expect(plan.apply).toContain('prettier');
  });
});

// ---------------------------------------------------------------------------
// The fleet: 13 repos still carrying configs an older SDK wrote
// ---------------------------------------------------------------------------

describe('install copes with a pre-Part-A config', () => {
  test('drops the retired stamps, warns once about `modules`, keeps the rest', async () => {
    const sb = track(
      createProjectSandbox({
        justinSdkConfig: {
          componentConfig: {
            'critical-rules': {modules: ['communication', 'code-style']},
            'time-check': {enabled: true, gapHours: 4},
          },
          components: ['base-setup', 'gitignore-setup', 'prompts-setup'],
          lastSynced: '2026-09-15',
          version: '0.30.0',
        },
      }),
    );
    initGitRepo(sb.path);

    const lines: string[] = [];
    const realWarn = console.warn;
    const realLog = console.log;
    console.warn = (...args: unknown[]) => lines.push(args.join(' '));
    console.log = (...args: unknown[]) => lines.push(args.join(' '));
    let exitCode: number;
    try {
      exitCode = await runInstall({
        projectRoot: sb.path,
        sdkRepoUrl: sdkRemote(),
      });
    } finally {
      console.warn = realWarn;
      console.log = realLog;
    }
    expect(exitCode).toBe(0);

    const output = lines.join('\n');
    // The two write-only stamps are gone, and base-setup said so.
    const config = JSON.parse(
      readFileSync(join(sb.path, 'justin-sdk.config.json'), 'utf-8'),
    ) as Record<string, unknown>;
    expect(config.version).toBeUndefined();
    expect(config.lastSynced).toBeUndefined();
    expect(output).toContain('retired "version" key');
    expect(output).toContain('retired "lastSynced" key');

    // The retired include-list gets ONE loud line and is otherwise untouched —
    // it is a human's list, and the sweep is what removes it.
    expect(output).toContain('modules is no longer honoured');
    expect(
      (config.componentConfig as Record<string, Record<string, unknown>>)[
        'critical-rules'
      ]?.modules,
    ).toBeDefined();

    // A component this SDK deleted is reported, not silently dropped.
    expect(output).toContain('prompts-setup');

    // Tuned settings survive a reconcile untouched.
    expect(
      (config.componentConfig as Record<string, Record<string, unknown>>)[
        'time-check'
      ]?.gapHours,
    ).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// AC 4 — list
// ---------------------------------------------------------------------------

describe('list reports installed / applicable / resolved separately (AC 4)', () => {
  test('eas is applicable only when expo is a dependency', () => {
    const plain = track(createProjectSandbox());
    const expo = track(
      createProjectSandbox({
        packageJson: {
          dependencies: {expo: '^52.0.0'},
          name: 'expo-app',
          version: '0.0.1',
        },
      }),
    );

    const plainEas = buildComponentListing(plain.path).rows.find(
      (row) => row.name === 'eas',
    );
    const expoEas = buildComponentListing(expo.path).rows.find(
      (row) => row.name === 'eas',
    );
    expect(plainEas?.applicable).toBe(false);
    expect(plainEas?.includeIf).toEqual(['isExpo']);
    expect(expoEas?.applicable).toBe(true);
  });

  test('every component carries a one-line purpose', () => {
    const sb = track(createProjectSandbox());
    for (const row of buildComponentListing(sb.path).rows) {
      expect(row.purpose.length).toBeGreaterThan(20);
    }
  });

  test('installed and resolved are independent columns', async () => {
    const sb = track(createProjectSandbox());
    initGitRepo(sb.path);
    await runAdd(['prettier'], {
      commit: false,
      force: false,
      projectRoot: sb.path,
      sdkRepoUrl: sdkRemote(),
    });
    writeFileSync(
      join(sb.path, 'justin-sdk.config.json'),
      JSON.stringify({components: ['eslint-setup']}, null, 2) + '\n',
    );

    const rows = buildComponentListing(sb.path).rows;
    const prettier = rows.find((row) => row.name === 'prettier');
    const eslint = rows.find((row) => row.name === 'eslint');
    expect(prettier?.installed).toBe(true);
    expect(prettier?.resolved).toBe(false);
    expect(eslint?.installed).toBe(false);
    expect(eslint?.resolved).toBe(true);
  });

  test('a version-manager `prebuild` script does NOT make a repo look like an Expo app', () => {
    // Found by running `list` against home-base itself: `prebuild` and
    // `eas-build-post-install` both run @justinhaaheim/version-manager, which
    // non-Expo repos use on its own — home-base has `prebuild` with the exact
    // value eas-setup writes. Reading that as "eas is installed" would have made
    // `install` delete a script the repo genuinely depends on.
    const sb = track(
      createProjectSandbox({
        packageJson: {
          name: 'not-an-expo-app',
          scripts: {prebuild: 'npx @justinhaaheim/version-manager'},
          version: '0.0.1',
        },
      }),
    );
    const eas = buildComponentListing(sb.path).rows.find(
      (row) => row.name === 'eas',
    );
    expect(eas?.installed).toBe(false);

    // And removal leaves it alone even on an exact value match.
    removeComponent(sb.path, 'eas');
    expect(readScripts(sb.path).prebuild).toBe(
      'npx @justinhaaheim/version-manager',
    );
  });

  test('an unreadable components key surfaces as a problem, not as "wants nothing"', () => {
    const sb = track(
      createProjectSandbox({justinSdkConfig: {components: 'prettier-setup'}}),
    );
    const listing = buildComponentListing(sb.path);
    expect(listing.problem).not.toBeNull();
    expect(listing.source).toBe('unreadable');
  });

  test('AC F9: an UNENROLLED repo shows nothing in config, not the core preset', () => {
    // It used to resolve `{}` for a missing config, so every core component
    // printed "in config: yes" for a repo that has never had one — an enrolment
    // the repo does not have, with the disk columns beside it reading as drift
    // from it (dchjw.17 F9).
    const sb = track(createSandbox());
    expect(existsSync(join(sb.path, 'justin-sdk.config.json'))).toBe(false);

    const listing = buildComponentListing(sb.path);
    expect(listing.source).toBe('not-enrolled');
    expect(listing.problem).toBeNull();
    expect(listing.rows.every((row) => !row.resolved)).toBe(true);
    expect(renderComponentListing(listing)).toContain('NOT ENROLLED');
  });

  test('POSITIVE CONTROL: an ENROLLED repo with no components key does track core', () => {
    const sb = track(createProjectSandbox({justinSdkConfig: {}}));
    const listing = buildComponentListing(sb.path);
    expect(listing.source).toBe('core');
    expect(listing.rows.some((row) => row.resolved)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B7 — nothing here may write into the SDK's own checkout
// ---------------------------------------------------------------------------

describe('no leak: the SDK checkout is never a component target', () => {
  test('the SDK directory has no justin-sdk.config.json after this suite runs', () => {
    // During Part A something ran `add gitignore` with cwd = the SDK itself and
    // wrote a config plus scripts into it. Nothing in the tests could do that —
    // every installer call here passes an explicit sandbox projectRoot — and
    // this asserts the outcome rather than trusting the review that found it.
    const sdkRoot = join(import.meta.dirname, '..');
    expect(existsSync(join(sdkRoot, 'justin-sdk.config.json'))).toBe(false);
  });
});
