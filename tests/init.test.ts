/**
 * E2E tests for `justin-sdk init` — the greenfield scaffold orchestrator.
 *
 * All tests run with skipInstall + skipPromptsFetch + skipDoctor + noCommit
 * to keep them offline and fast. Tests that exercise the full component
 * pipeline are skipped if the beads-setup step can't run cleanly in a
 * fresh tmp dir (typically: `br` missing, or mise refuses to read an
 * untrusted mise.toml).
 */

import {afterEach, beforeAll, describe, expect, test} from 'bun:test';
import {execSync} from 'child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {kebabCase, runInit} from '../src/init';
import {resolveComponents} from '../src/component-registry';
import {sdkRemoteWithOwnTag} from './git-fixtures';
import {createSandbox, type Sandbox} from './sandbox';

/**
 * The beads installer runs `mise install` from inside the project's
 * sandbox dir, which writes a mise.toml. mise refuses to read untrusted
 * config files, and many CI/dev machines won't have temp directories
 * pre-trusted. So we detect not just "is br installed?" but "will mise
 * cooperate with a mise.toml in a tmp dir?" — if not, we skip the full
 * pipeline tests rather than fail on a pre-existing environmental issue.
 */
let canRunFullPipeline = false;

beforeAll(() => {
  // Pre-trust tmp-dir mise configs for the rest of the test run. Without
  // this, mise refuses to read mise.toml files written into sandbox dirs.
  // Tests that don't use beads aren't affected; tests that do use beads
  // need this. Inherited via process.env by every execSync/runInit call.
  //
  // On macOS, tmpdir() returns /tmp/... but mise canonicalizes via
  // realpath to /private/tmp/... — we need both in the trust list.
  const trustPaths = new Set<string>();
  const baseTmp = tmpdir();
  trustPaths.add(baseTmp);
  try {
    trustPaths.add(realpathSync(baseTmp));
  } catch {
    // ignore
  }
  const existing = process.env.MISE_TRUSTED_CONFIG_PATHS;
  if (existing) trustPaths.add(existing);
  process.env.MISE_TRUSTED_CONFIG_PATHS = Array.from(trustPaths).join(':');

  try {
    execSync('br --version', {stdio: ['pipe', 'pipe', 'pipe']});
  } catch {
    return;
  }
  // Probe: does mise tolerate a tmp-dir mise.toml end-to-end?
  const probeDir = join(tmpdir(), `init-test-probe-${process.pid}`);
  try {
    mkdirSync(probeDir, {recursive: true});
    writeFileSync(
      join(probeDir, 'mise.toml'),
      '[tools]\n"github:Dicklesworthstone/beads_rust" = { version = "0.1.37", exe = "br" }\n',
    );
    execSync('mise install --yes', {
      cwd: probeDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    canRunFullPipeline = true;
  } catch {
    canRunFullPipeline = false;
  } finally {
    try {
      execSync(`rm -rf '${probeDir}'`);
    } catch {
      // ignore
    }
  }
});

const sandboxes: Sandbox[] = [];

function track(sandbox: Sandbox): Sandbox {
  sandboxes.push(sandbox);
  return sandbox;
}

afterEach(() => {
  cachedRemote = null;
  while (sandboxes.length > 0) {
    const sb = sandboxes.pop();
    sb?.cleanup();
  }
});

/**
 * Standard offline options for every test.
 *
 * It was not actually offline until dchjw.17 F7: `skipPromptsFetch` covered the
 * prompts clone, but `stepDepsHasSdk` still verified the pin tag with a real
 * `git ls-remote` against github on every call. A FUNCTION rather than a const
 * because the bare-remote fixture is built per test, alongside the sandbox it
 * lives in.
 */
function offlineOptions() {
  return {
    noCommit: true,
    quiet: true,
    sdkRepoUrl: sdkRemote(),
    skipDoctor: true,
    skipInstall: true,
    skipPromptsFetch: true,
  };
}

/** The local bare remote for THIS test, built once. See sdkRemoteWithOwnTag. */
let cachedRemote: string | null = null;

function sdkRemote(): string {
  cachedRemote ??= sdkRemoteWithOwnTag(track);
  return cachedRemote;
}

/**
 * Initialize a real git repo in the sandbox so the dirty-tree preflight
 * check works.
 */
function initGitRepo(path: string): void {
  execSync('git init -q', {cwd: path});
  // Configure a fake committer so `git commit` in nested tests doesn't fail
  // on unconfigured user.email/user.name. Local-only — does not touch
  // global config.
  execSync('git config user.email "test@example.com"', {cwd: path});
  execSync('git config user.name "Test"', {cwd: path});
}

// ---------------------------------------------------------------------------
// kebabCase pure helper
// ---------------------------------------------------------------------------

describe('init: kebabCase', () => {
  test('lowercases', () => {
    expect(kebabCase('MyProject')).toBe('myproject');
  });

  test('replaces spaces with dashes', () => {
    expect(kebabCase('My Cool Project')).toBe('my-cool-project');
  });

  test('collapses consecutive separators', () => {
    expect(kebabCase('foo___bar  baz')).toBe('foo-bar-baz');
  });

  test('strips leading and trailing dashes', () => {
    expect(kebabCase('---foo-bar---')).toBe('foo-bar');
  });

  test('handles unicode / special chars', () => {
    expect(kebabCase('Foo!Bar@Baz')).toBe('foo-bar-baz');
  });
});

// ---------------------------------------------------------------------------
// Phase 1 preflight
// ---------------------------------------------------------------------------

describe('init: preflight', () => {
  test('exits 1 with clear error when .git is missing', async () => {
    const sb = track(createSandbox());
    // No .git/ in this sandbox.
    const exitCode = await runInit({
      ...offlineOptions(),
      projectRoot: sb.path,
    });
    expect(exitCode).toBe(1);
  });

  test('exits 1 when working tree is dirty without --allow-dirty', async () => {
    const sb = track(createSandbox());
    initGitRepo(sb.path);
    // Make the tree dirty.
    writeFileSync(join(sb.path, 'untracked.txt'), 'hello\n');

    const exitCode = await runInit({
      ...offlineOptions(),
      projectRoot: sb.path,
    });
    expect(exitCode).toBe(1);
  });

  test('proceeds when working tree is dirty WITH --allow-dirty', async () => {
    if (!canRunFullPipeline) {
      // Full pipeline requires br + mise to work in tmp dirs.
      return;
    }
    const sb = track(createSandbox());
    initGitRepo(sb.path);
    writeFileSync(join(sb.path, 'untracked.txt'), 'hello\n');

    const exitCode = await runInit({
      ...offlineOptions(),
      allowDirty: true,
      projectRoot: sb.path,
    });
    expect(exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 2 package.json scaffold
// ---------------------------------------------------------------------------

describe('init: package.json scaffold', () => {
  test('scaffolds minimal package.json in empty dir', async () => {
    if (!canRunFullPipeline) return;
    const sb = track(createSandbox());
    initGitRepo(sb.path);

    const exitCode = await runInit({
      ...offlineOptions(),
      projectRoot: sb.path,
    });
    expect(exitCode).toBe(0);

    const pkgPath = join(sb.path, 'package.json');
    expect(existsSync(pkgPath)).toBe(true);

    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
      name?: string;
      version?: string;
      type?: string;
      private?: boolean;
    };
    expect(pkg.type).toBe('module');
    expect(pkg.version).toBe('0.0.1');
    expect(pkg.private).toBe(true);
    // basename of the sandbox dir is something like 'justin-sdk-test-XXXX'
    // — should be a valid kebab-cased name.
    expect(pkg.name).toMatch(/^[a-z0-9-]+$/);
  });

  test('normalizes oddly-named directory to kebab-case', async () => {
    if (!canRunFullPipeline) return;
    const sb = track(createSandbox());
    const oddDir = join(sb.path, 'My Cool Project');
    mkdirSync(oddDir);
    initGitRepo(oddDir);

    const exitCode = await runInit({
      ...offlineOptions(),
      projectRoot: oddDir,
    });
    expect(exitCode).toBe(0);

    const pkg = JSON.parse(
      readFileSync(join(oddDir, 'package.json'), 'utf-8'),
    ) as {name?: string};
    expect(pkg.name).toBe('my-cool-project');
  });

  test('preserves existing package.json', async () => {
    if (!canRunFullPipeline) return;
    const sb = track(createSandbox());
    initGitRepo(sb.path);
    writeFileSync(
      join(sb.path, 'package.json'),
      JSON.stringify(
        {
          name: 'custom',
          version: '1.2.3',
          scripts: {foo: 'echo'},
        },
        null,
        2,
      ) + '\n',
    );
    // Commit so the tree is clean before init's preflight runs.
    execSync('git add -A', {cwd: sb.path});
    execSync(`git commit -q -m 'initial'`, {cwd: sb.path});

    const exitCode = await runInit({
      ...offlineOptions(),
      projectRoot: sb.path,
    });
    expect(exitCode).toBe(0);

    const pkg = JSON.parse(
      readFileSync(join(sb.path, 'package.json'), 'utf-8'),
    ) as {name?: string; scripts?: Record<string, string>};
    expect(pkg.name).toBe('custom');
    expect(pkg.scripts?.foo).toBe('echo');
  });
});

// ---------------------------------------------------------------------------
// Phase 3 component pipeline
// ---------------------------------------------------------------------------

describe('init: enrolment only, no components (D3)', () => {
  test('installs NO component files, and the config resolves to core', async () => {
    if (!canRunFullPipeline) {
      console.log(
        "  (skipped — br not installed or mise can't use tmp-dir mise.toml)",
      );
      return;
    }
    const sb = track(createSandbox());
    initGitRepo(sb.path);

    const exitCode = await runInit({
      ...offlineOptions(),
      projectRoot: sb.path,
    });
    expect(exitCode).toBe(0);

    // `init` is npm's `init`: the manifest, and nothing else. Scaffolding the
    // whole preset here is what made enrolling a repo install a dozen
    // components nobody asked for — including, until Part A, the retired
    // `prompts` one. `add core` is the command that installs.
    for (const artifact of [
      '.prettierrc.json',
      'tsconfig.json',
      'eslint.config.cjs',
      '.husky/pre-commit',
      '.github/workflows/signal.yml',
      'mise.toml',
    ]) {
      expect(existsSync(join(sb.path, artifact))).toBe(false);
    }

    // init writes NO `components` key on purpose (D3): absent means the core
    // preset, so a repo enrolled today keeps tracking core as the registry
    // grows rather than freezing today's list into a file nobody revisits.
    const config = JSON.parse(
      readFileSync(join(sb.path, 'justin-sdk.config.json'), 'utf-8'),
    ) as {components?: string[]};
    expect(config.components).toBeUndefined();
    const resolved = resolveComponents(config, sb.path);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.components).toContain('base-setup');
    expect(resolved.components).toContain('critical-rules-setup');
    // NOT beads-setup: this sandbox has no `.beads/`, and since dchjw.19 beads
    // is gated on `isBeadsRust`, so `core` no longer scaffolds a beads
    // workspace into a repo that has never had one. `add beads` still does.
    expect(resolved.components).not.toContain('beads-setup');
    // The retired components must never be scaffolded again.
    expect(resolved.components).not.toContain('prompts-setup');
    expect(resolved.components).not.toContain('claude-md-setup');
  });

  test('idempotent: second run returns 0 with no errors', async () => {
    if (!canRunFullPipeline) return;
    const sb = track(createSandbox());
    initGitRepo(sb.path);

    const first = await runInit({
      ...offlineOptions(),
      projectRoot: sb.path,
    });
    expect(first).toBe(0);

    // Commit so the next run sees a clean tree.
    execSync('git add -A', {cwd: sb.path});
    execSync(`git commit -q -m 'first scaffold'`, {cwd: sb.path});

    const second = await runInit({
      ...offlineOptions(),
      projectRoot: sb.path,
    });
    expect(second).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 6 commit behavior
// ---------------------------------------------------------------------------

describe('init: commit behavior', () => {
  test('noCommit: true skips the final commit', async () => {
    if (!canRunFullPipeline) return;
    const sb = track(createSandbox());
    initGitRepo(sb.path);

    const exitCode = await runInit({
      ...offlineOptions(),
      noCommit: true,
      projectRoot: sb.path,
    });
    expect(exitCode).toBe(0);

    // No commits should exist (git log exits non-zero on empty repo).
    const result = execSync('git rev-list --count HEAD 2>/dev/null || echo 0', {
      cwd: sb.path,
      encoding: 'utf-8',
    }).trim();
    expect(result).toBe('0');
  });
});
