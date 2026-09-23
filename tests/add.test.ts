/**
 * Tests for `justin-sdk add` — single components and the preset expansion
 * (minimal / core / all).
 *
 * The pure expansion tests (PRESETS / expandTarget / isPreset) run offline
 * and always. The end-to-end tests that actually install components are
 * gated on `canRunFullPipeline` (br + a tmp-dir-tolerant mise) exactly like
 * init.test.ts, because every preset includes beads. We deliberately e2e
 * `core` and `minimal` (which never touch the network) rather than `all`
 * (whose prompts-setup step fetches the prompts library).
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

import {
  ADD_TARGETS,
  COMPONENTS,
  expandTarget,
  isPreset,
  PRESET_NAMES,
  runAdd,
} from '../src/add';
import {corePreset} from '../src/component-registry';
import {sdkRemoteWithOwnTag} from './git-fixtures';
import {createProjectSandbox, type Sandbox} from './sandbox';

// ---------------------------------------------------------------------------
// Full-pipeline probe (mirrors init.test.ts)
// ---------------------------------------------------------------------------

let canRunFullPipeline = false;

beforeAll(() => {
  const trustPaths = new Set<string>();
  const baseTmp = tmpdir();
  trustPaths.add(baseTmp);
  try {
    trustPaths.add(realpathSync(baseTmp));
  } catch {
    // ignore
  }
  const existing = process.env.MISE_TRUSTED_CONFIG_PATHS;
  if (existing != null && existing !== '') trustPaths.add(existing);
  process.env.MISE_TRUSTED_CONFIG_PATHS = Array.from(trustPaths).join(':');

  try {
    execSync('br --version', {stdio: ['pipe', 'pipe', 'pipe']});
  } catch {
    return;
  }
  const probeDir = join(tmpdir(), `add-test-probe-${process.pid}`);
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

/** The local bare remote for THIS test, built once. See sdkRemoteWithOwnTag. */
let cachedRemote: string | null = null;

function sdkRemote(): string {
  cachedRemote ??= sdkRemoteWithOwnTag(track);
  return cachedRemote;
}

function initGitRepo(path: string): void {
  execSync('git init -q', {cwd: path});
  execSync('git config user.email "test@example.com"', {cwd: path});
  execSync('git config user.name "Test"', {cwd: path});
}

/** Map a short component name to the `-setup` name it registers in config. */
function toConfigName(short: string): string {
  return short === 'base-setup' ? 'base-setup' : `${short}-setup`;
}

function readComponents(projectRoot: string): string[] {
  const config = JSON.parse(
    readFileSync(join(projectRoot, 'justin-sdk.config.json'), 'utf-8'),
  ) as {components?: string[]};
  return config.components ?? [];
}

// ---------------------------------------------------------------------------
// Preset definitions (pure — always run)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// expandTarget / isPreset (pure — always run)
// ---------------------------------------------------------------------------

describe('add: expandTarget / isPreset', () => {
  test('core is the only preset; a component is not one', () => {
    expect(PRESET_NAMES).toEqual(['core']);
    expect(isPreset('core')).toBe(true);
    expect(isPreset('beads')).toBe(false);
    // The retired presets are not silently accepted as components either.
    expect(isPreset('all')).toBe(false);
    expect(isPreset('minimal')).toBe(false);
    expect(ADD_TARGETS).not.toContain('all');
    expect(ADD_TARGETS).not.toContain('minimal');
  });

  test('a single component expands to itself', () => {
    const sb = track(createProjectSandbox());
    expect(expandTarget('beads', sb.path)).toEqual(['beads']);
    expect(expandTarget('prettier', sb.path)).toEqual(['prettier']);
  });

  test('core expands to the computed core preset for THIS repo', () => {
    const sb = track(createProjectSandbox());
    expect(expandTarget('core', sb.path)).toEqual(corePreset(sb.path));
    expect(expandTarget('core', sb.path)).not.toContain('base-setup');
  });

  test('ADD_TARGETS contains every component and every preset', () => {
    for (const c of COMPONENTS) expect(ADD_TARGETS).toContain(c);
    for (const p of PRESET_NAMES) expect(ADD_TARGETS).toContain(p);
  });
});

// ---------------------------------------------------------------------------
// Single component dispatch (offline — no beads, no network)
// ---------------------------------------------------------------------------

describe('add: single component', () => {
  test('add prettier installs base-setup + prettier and registers both', async () => {
    const sb = track(createProjectSandbox());
    initGitRepo(sb.path);

    const exitCode = await runAdd(['prettier'], {
      commit: false,
      force: false,
      projectRoot: sb.path,
      sdkRepoUrl: sdkRemote(),
    });
    expect(exitCode).toBe(0);

    expect(existsSync(join(sb.path, '.prettierrc.json'))).toBe(true);
    const components = readComponents(sb.path);
    expect(components).toContain('prettier-setup');
    // base-setup is IMPLICIT and is deliberately not written (F11): it is not a
    // component anyone can choose or remove. `resolveComponents` puts it back.
    expect(components).not.toContain('base-setup');
  });
});

// ---------------------------------------------------------------------------
// Preset install e2e (gated on br + mise, like init.test.ts)
// ---------------------------------------------------------------------------

describe('add: preset install', () => {
  test('add core registers every component core expands to, and nothing else', async () => {
    if (!canRunFullPipeline) return;
    const sb = track(createProjectSandbox());
    initGitRepo(sb.path);

    const exitCode = await runAdd(['core'], {
      commit: false,
      force: false,
      projectRoot: sb.path,
      sdkRepoUrl: sdkRemote(),
    });
    expect(exitCode).toBe(0);

    const components = readComponents(sb.path);
    for (const expected of corePreset(sb.path).map(toConfigName)) {
      expect(components).toContain(expected);
    }
    // The retired components must never be registered again.
    for (const omitted of ['prompts-setup', 'claude-md-setup', 'base-setup']) {
      expect(components).not.toContain(omitted);
    }
  });
});
