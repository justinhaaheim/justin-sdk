/**
 * E2E tests for `justin-sdk add base-setup`.
 *
 * These tests exercise the foundation layer installer. They don't need
 * any external tools (no br, no mise) — just filesystem operations.
 */

import {describe, test, expect, afterEach} from 'bun:test';
import {existsSync, readFileSync} from 'fs';
import {join} from 'path';

import {runBaseSetup} from '../src/base-setup';
import {createProjectSandbox, createSandbox, type Sandbox} from './sandbox';

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

describe('base-setup', () => {
  test('creates justin-sdk.config.json with sensible defaults', async () => {
    const sb = track(createProjectSandbox());
    const exitCode = await runBaseSetup({
      projectRoot: sb.path,
      quiet: true,
    });
    expect(exitCode).toBe(0);

    expect(existsSync(join(sb.path, 'justin-sdk.config.json'))).toBe(true);
    const config = JSON.parse(
      readFileSync(join(sb.path, 'justin-sdk.config.json'), 'utf-8'),
    ) as {
      version?: string;
      components?: string[];
      lastSynced?: string;
    };
    expect(config.version).toBeDefined();
    expect(config.components).toContain('base-setup');
    expect(config.lastSynced).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('extraComponents are added to justin-sdk.config.json', async () => {
    const sb = track(createProjectSandbox());
    await runBaseSetup({
      projectRoot: sb.path,
      quiet: true,
      extraComponents: ['beads-setup'],
    });

    const config = JSON.parse(
      readFileSync(join(sb.path, 'justin-sdk.config.json'), 'utf-8'),
    ) as {components?: string[]};
    expect(config.components).toContain('base-setup');
    expect(config.components).toContain('beads-setup');
  });

  test('preserves existing justin-sdk.config.json fields', async () => {
    const sb = track(
      createProjectSandbox({
        justinSdkConfig: {
          version: '0.2.0',
          components: ['base-setup', 'custom-thing'],
          lastSynced: '2020-01-01',
          customField: 'preserved',
        },
      }),
    );

    await runBaseSetup({projectRoot: sb.path, quiet: true});

    const config = JSON.parse(
      readFileSync(join(sb.path, 'justin-sdk.config.json'), 'utf-8'),
    ) as {
      version?: string;
      components?: string[];
      customField?: string;
      lastSynced?: string;
    };
    expect(config.components).toContain('base-setup');
    expect(config.components).toContain('custom-thing');
    expect(config.customField).toBe('preserved');
    // version is left alone (user marker)
    expect(config.version).toBe('0.2.0');
    // lastSynced is updated
    expect(config.lastSynced).not.toBe('2020-01-01');
  });

  test('adds required scripts to package.json', async () => {
    const sb = track(createProjectSandbox());
    await runBaseSetup({projectRoot: sb.path, quiet: true});

    const pkg = JSON.parse(
      readFileSync(join(sb.path, 'package.json'), 'utf-8'),
    ) as {scripts?: Record<string, string>};

    expect(pkg.scripts?.signal).toContain('bunx justin-sdk');
    expect(pkg.scripts?.doctor).toContain('bunx justin-sdk');
    expect(pkg.scripts?.['setup-env']).toContain('scripts/setup-env.ts');
  });

  test('overwrites stale SDK scripts that point at node_modules path', async () => {
    const sb = track(
      createProjectSandbox({
        packageJson: {
          name: 'test',
          scripts: {
            signal:
              'bun node_modules/@justinhaaheim/justin-sdk/src/cli.ts signal --quiet',
            doctor: 'bun node_modules/@justinhaaheim/justin-sdk/src/cli.ts doctor',
          },
        },
      }),
    );
    await runBaseSetup({projectRoot: sb.path, quiet: true});

    const pkg = JSON.parse(
      readFileSync(join(sb.path, 'package.json'), 'utf-8'),
    ) as {scripts?: Record<string, string>};
    expect(pkg.scripts?.signal).toBe('bunx justin-sdk signal --quiet');
    expect(pkg.scripts?.doctor).toBe('bunx justin-sdk doctor');
  });

  test('preserves existing signal-source:* scripts (does not clobber)', async () => {
    const sb = track(
      createProjectSandbox({
        packageJson: {
          name: 'test',
          scripts: {
            'signal-source:OXLINT': 'oxlint --deny-warnings',
            'signal-source:TS': 'tsc --noEmit --strict',
          },
        },
      }),
    );
    await runBaseSetup({projectRoot: sb.path, quiet: true});

    const pkg = JSON.parse(
      readFileSync(join(sb.path, 'package.json'), 'utf-8'),
    ) as {scripts?: Record<string, string>};
    // Existing signal-source entries preserved
    expect(pkg.scripts?.['signal-source:OXLINT']).toBe('oxlint --deny-warnings');
    expect(pkg.scripts?.['signal-source:TS']).toBe('tsc --noEmit --strict');
    // Defaults NOT added (because some signal-source entries existed)
    expect(pkg.scripts?.['signal-source:LINT']).toBeUndefined();
  });

  test('copies scripts/setup-env.ts from template', async () => {
    const sb = track(createProjectSandbox());
    await runBaseSetup({projectRoot: sb.path, quiet: true});

    expect(existsSync(join(sb.path, 'scripts/setup-env.ts'))).toBe(true);
    const content = readFileSync(join(sb.path, 'scripts/setup-env.ts'), 'utf-8');
    expect(content).toContain('setup-env');
  });

  test('does NOT overwrite existing setup-env.ts', async () => {
    const sb = track(createProjectSandbox());
    sb.writeFile('scripts/setup-env.ts', '// custom setup\n');

    await runBaseSetup({projectRoot: sb.path, quiet: true});

    const content = readFileSync(join(sb.path, 'scripts/setup-env.ts'), 'utf-8');
    expect(content).toBe('// custom setup\n');
  });

  test('adds tmp/ and dynamic-version.local.* to .gitignore', async () => {
    const sb = track(createProjectSandbox());
    await runBaseSetup({projectRoot: sb.path, quiet: true});

    const gitignore = readFileSync(join(sb.path, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('tmp/');
    expect(gitignore).toContain('dynamic-version.local');
  });

  test('preserves existing .gitignore entries', async () => {
    const sb = track(createProjectSandbox());
    sb.writeFile('.gitignore', '# existing\nnode_modules\ndist/\n');

    await runBaseSetup({projectRoot: sb.path, quiet: true});

    const gitignore = readFileSync(join(sb.path, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('node_modules');
    expect(gitignore).toContain('dist/');
    expect(gitignore).toContain('tmp/');
  });

  test('creates .claude/settings.json with sandbox scaffolding and SessionStart hook', async () => {
    const sb = track(createProjectSandbox());
    await runBaseSetup({projectRoot: sb.path, quiet: true});

    const settings = JSON.parse(
      readFileSync(join(sb.path, '.claude/settings.json'), 'utf-8'),
    ) as {
      sandbox?: {excludedCommands?: unknown};
      hooks?: {SessionStart?: unknown[]};
    };
    expect(Array.isArray(settings.sandbox?.excludedCommands)).toBe(true);
    expect(Array.isArray(settings.hooks?.SessionStart)).toBe(true);

    // SessionStart hook should reference setup-env.ts
    const serialized = JSON.stringify(settings.hooks?.SessionStart);
    expect(serialized).toContain('scripts/setup-env.ts');
  });

  test('preserves existing .claude/settings.json contents', async () => {
    const sb = track(createProjectSandbox());
    sb.writeFile(
      '.claude/settings.json',
      JSON.stringify({
        permissions: {allow: ['Bash(ls:*)']},
        sandbox: {excludedCommands: ['gh']},
      }),
    );

    await runBaseSetup({projectRoot: sb.path, quiet: true});

    const settings = JSON.parse(
      readFileSync(join(sb.path, '.claude/settings.json'), 'utf-8'),
    ) as {
      permissions?: {allow?: string[]};
      sandbox?: {excludedCommands?: string[]};
      hooks?: {SessionStart?: unknown};
    };
    expect(settings.permissions?.allow).toContain('Bash(ls:*)');
    expect(settings.sandbox?.excludedCommands).toContain('gh');
    expect(settings.hooks?.SessionStart).toBeDefined();
  });

  test('fully idempotent: second run produces same result', async () => {
    const sb = track(createProjectSandbox());

    const first = await runBaseSetup({projectRoot: sb.path, quiet: true});
    const second = await runBaseSetup({projectRoot: sb.path, quiet: true});

    expect(first).toBe(0);
    expect(second).toBe(0);

    // Verify config hasn't grown duplicates
    const config = JSON.parse(
      readFileSync(join(sb.path, 'justin-sdk.config.json'), 'utf-8'),
    ) as {components?: string[]};
    const baseSetupCount = (config.components ?? []).filter(
      (c) => c === 'base-setup',
    ).length;
    expect(baseSetupCount).toBe(1);

    // .gitignore has no duplicate tmp/ entries
    const gitignore = readFileSync(join(sb.path, '.gitignore'), 'utf-8');
    const tmpMatches = gitignore.match(/^tmp\/$/gm) ?? [];
    expect(tmpMatches.length).toBe(1);
  });

  test('fails clearly if package.json does not exist', async () => {
    const sb = track(createSandbox());
    // No package.json in this sandbox
    const exitCode = await runBaseSetup({projectRoot: sb.path, quiet: true});
    expect(exitCode).toBe(1);
  });
});
