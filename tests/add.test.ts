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
  PRESETS,
  runAdd,
} from '../src/add';
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
  if (existing) trustPaths.add(existing);
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
  while (sandboxes.length > 0) {
    const sb = sandboxes.pop();
    sb?.cleanup();
  }
});

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

describe('add: preset definitions', () => {
  test('exposes exactly the three presets', () => {
    expect(new Set(PRESET_NAMES)).toEqual(new Set(['minimal', 'core', 'all']));
  });

  test('minimal = base-setup + beads', () => {
    expect(PRESETS.minimal).toEqual(['base-setup', 'beads']);
  });

  test('core = code-quality + beads (no gh-actions/prompts/claude-md)', () => {
    expect(PRESETS.core).toEqual([
      'gitignore',
      'prettier',
      'tsconfig',
      'eslint',
      'husky',
      'beads',
    ]);
    for (const excluded of ['gh-actions', 'prompts', 'claude-md']) {
      expect(PRESETS.core).not.toContain(excluded);
    }
  });

  test('all = every component except the opt-in-only ones', () => {
    expect(new Set(PRESETS.all)).toEqual(
      new Set(
        COMPONENTS.filter(
          (c) => c !== 'base-setup' && c !== 'eas' && c !== 'time-check',
        ),
      ),
    );
    // base-setup is implicit (every installer self-applies it).
    expect(PRESETS.all).not.toContain('base-setup');
    // time-check's hook runs on every prompt — never install it implicitly.
    expect(PRESETS.all).not.toContain('time-check');
  });

  test('all order mirrors init.ts dependency order', () => {
    expect(PRESETS.all).toEqual([
      'gitignore',
      'prettier',
      'tsconfig',
      'eslint',
      'husky',
      'gh-actions',
      'prompts',
      'claude-md',
      'beads',
    ]);
  });

  test('core preserves the same relative order as all', () => {
    expect(PRESETS.all.filter((c) => PRESETS.core.includes(c))).toEqual(
      PRESETS.core,
    );
  });

  test('every preset component is a real component', () => {
    for (const list of Object.values(PRESETS)) {
      for (const name of list) {
        expect(COMPONENTS).toContain(name);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// expandTarget / isPreset (pure — always run)
// ---------------------------------------------------------------------------

describe('add: expandTarget / isPreset', () => {
  test('isPreset recognizes presets and rejects components', () => {
    expect(isPreset('core')).toBe(true);
    expect(isPreset('all')).toBe(true);
    expect(isPreset('minimal')).toBe(true);
    expect(isPreset('beads')).toBe(false);
    expect(isPreset('nope')).toBe(false);
  });

  test('a single component expands to itself', () => {
    expect(expandTarget('beads')).toEqual(['beads']);
    expect(expandTarget('prettier')).toEqual(['prettier']);
  });

  test('a preset expands to its component list', () => {
    expect(expandTarget('minimal')).toEqual(['base-setup', 'beads']);
    expect(expandTarget('all')).toEqual(PRESETS.all);
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

    const exitCode = await runAdd('prettier', {
      commit: false,
      force: false,
      projectRoot: sb.path,
    });
    expect(exitCode).toBe(0);

    expect(existsSync(join(sb.path, '.prettierrc.json'))).toBe(true);
    const components = readComponents(sb.path);
    expect(components).toContain('base-setup');
    expect(components).toContain('prettier-setup');
  });
});

// ---------------------------------------------------------------------------
// Preset install e2e (gated on br + mise, like init.test.ts)
// ---------------------------------------------------------------------------

describe('add: preset install', () => {
  test('add minimal registers base-setup + beads-setup', async () => {
    if (!canRunFullPipeline) return;
    const sb = track(createProjectSandbox());
    initGitRepo(sb.path);

    const exitCode = await runAdd('minimal', {
      commit: false,
      force: false,
      projectRoot: sb.path,
    });
    expect(exitCode).toBe(0);

    const components = readComponents(sb.path);
    expect(components).toContain('base-setup');
    expect(components).toContain('beads-setup');
  });

  test('add core registers the code-quality + beads set', async () => {
    if (!canRunFullPipeline) return;
    const sb = track(createProjectSandbox());
    initGitRepo(sb.path);

    const exitCode = await runAdd('core', {
      commit: false,
      force: false,
      projectRoot: sb.path,
    });
    expect(exitCode).toBe(0);

    const components = readComponents(sb.path);
    for (const expected of PRESETS.core.map(toConfigName)) {
      expect(components).toContain(expected);
    }
    expect(components).toContain('base-setup');
    // Things core deliberately omits must not be registered.
    for (const omitted of [
      'gh-actions-setup',
      'prompts-setup',
      'claude-md-setup',
    ]) {
      expect(components).not.toContain(omitted);
    }
  });
});
