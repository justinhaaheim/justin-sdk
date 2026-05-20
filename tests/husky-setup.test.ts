/**
 * E2E tests for `justin-sdk add husky`.
 *
 * These tests exercise the husky component installer. They don't run
 * `bun add` or `bun run prepare` (the installer only edits package.json
 * and writes the hook file), so they're fully offline and fast.
 */

import {describe, test, expect, afterEach} from 'bun:test';
import {existsSync, readFileSync, statSync, writeFileSync, mkdirSync} from 'fs';
import {join, resolve} from 'path';

import {runHuskySetup} from '../src/husky-setup';
import {PINNED} from '../src/pinned-versions';
import {createProjectSandbox, type Sandbox} from './sandbox';

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

const TEMPLATE_PATH = resolve(
  import.meta.dirname,
  '..',
  'templates',
  'configs',
  '.husky',
  'pre-commit',
);

function readTemplate(): string {
  return readFileSync(TEMPLATE_PATH, 'utf-8');
}

function readPkg(sb: Sandbox): {
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  ['lint-staged']?: Record<string, string[]>;
} {
  return JSON.parse(readFileSync(join(sb.path, 'package.json'), 'utf-8')) as {
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
    ['lint-staged']?: Record<string, string[]>;
  };
}

describe('husky-setup', () => {
  test('fresh project: writes devDeps, prepare, lint-staged config, and executable .husky/pre-commit', async () => {
    const sb = track(createProjectSandbox());

    const exitCode = await runHuskySetup({
      projectRoot: sb.path,
      quiet: true,
    });
    expect(exitCode).toBe(0);

    const pkg = readPkg(sb);

    // devDependencies at PINNED versions
    expect(pkg.devDependencies?.husky).toBe(PINNED.husky);
    expect(pkg.devDependencies?.['lint-staged']).toBe(PINNED['lint-staged']);

    // prepare script set to "husky"
    expect(pkg.scripts?.prepare).toBe('husky');

    // lint-staged config present
    expect(pkg['lint-staged']).toBeDefined();
    expect(pkg['lint-staged']?.['*.{ts,tsx,js,jsx,cjs,mjs}']).toEqual([
      'bun run lint-base -- --fix',
      'prettier --write',
    ]);
    expect(pkg['lint-staged']?.['*.{json,md,yml,yaml}']).toEqual([
      'prettier --write',
    ]);

    // .husky/pre-commit exists with template content
    const hookPath = join(sb.path, '.husky', 'pre-commit');
    expect(existsSync(hookPath)).toBe(true);
    expect(readFileSync(hookPath, 'utf-8')).toBe(readTemplate());

    // .husky/pre-commit is executable
    const mode = statSync(hookPath).mode;
    expect(mode & 0o111).not.toBe(0);

    // justin-sdk.config.json has husky-setup in components
    const config = JSON.parse(
      readFileSync(join(sb.path, 'justin-sdk.config.json'), 'utf-8'),
    ) as {components?: string[]};
    expect(config.components).toContain('husky-setup');
    expect(config.components).toContain('base-setup');
  });

  test('fully idempotent: second run produces same files', async () => {
    const sb = track(createProjectSandbox());

    const first = await runHuskySetup({projectRoot: sb.path, quiet: true});
    expect(first).toBe(0);

    const firstPkg = readFileSync(join(sb.path, 'package.json'), 'utf-8');
    const firstHook = readFileSync(
      join(sb.path, '.husky', 'pre-commit'),
      'utf-8',
    );

    const second = await runHuskySetup({projectRoot: sb.path, quiet: true});
    expect(second).toBe(0);

    expect(readFileSync(join(sb.path, 'package.json'), 'utf-8')).toBe(firstPkg);
    expect(readFileSync(join(sb.path, '.husky', 'pre-commit'), 'utf-8')).toBe(
      firstHook,
    );

    // No duplicate husky-setup entries
    const config = JSON.parse(
      readFileSync(join(sb.path, 'justin-sdk.config.json'), 'utf-8'),
    ) as {components?: string[]};
    const huskySetupCount = (config.components ?? []).filter(
      (c) => c === 'husky-setup',
    ).length;
    expect(huskySetupCount).toBe(1);
  });

  test('preserves user-customized "prepare" script', async () => {
    const sb = track(
      createProjectSandbox({
        packageJson: {
          name: 'test-project',
          scripts: {prepare: 'echo custom'},
        },
      }),
    );

    const exitCode = await runHuskySetup({
      projectRoot: sb.path,
      quiet: true,
    });
    expect(exitCode).toBe(0);

    const pkg = readPkg(sb);
    // User's custom prepare script preserved
    expect(pkg.scripts?.prepare).toBe('echo custom');
  });

  test('preserves user-customized lint-staged config', async () => {
    const customLintStaged = {
      '*.ts': ['my-custom-linter'],
    };
    const sb = track(
      createProjectSandbox({
        packageJson: {
          name: 'test-project',
          ['lint-staged']: customLintStaged,
        },
      }),
    );

    const exitCode = await runHuskySetup({
      projectRoot: sb.path,
      quiet: true,
    });
    expect(exitCode).toBe(0);

    const pkg = readPkg(sb);
    expect(pkg['lint-staged']).toEqual(customLintStaged);
  });

  test('preserves existing .husky/pre-commit content (warns, returns 0)', async () => {
    const sb = track(createProjectSandbox());
    // Pre-create a custom hook
    const customHook = '#!/usr/bin/env sh\necho my custom hook\n';
    mkdirSync(join(sb.path, '.husky'), {recursive: true});
    writeFileSync(join(sb.path, '.husky', 'pre-commit'), customHook);

    const exitCode = await runHuskySetup({
      projectRoot: sb.path,
      quiet: true,
    });
    expect(exitCode).toBe(0);

    // Custom hook preserved
    expect(readFileSync(join(sb.path, '.husky', 'pre-commit'), 'utf-8')).toBe(
      customHook,
    );
  });

  test('--force overwrites a hand-modified .husky/pre-commit', async () => {
    const sb = track(createProjectSandbox());
    mkdirSync(join(sb.path, '.husky'), {recursive: true});
    writeFileSync(
      join(sb.path, '.husky', 'pre-commit'),
      '#!/usr/bin/env sh\necho old hook\n',
    );

    const exitCode = await runHuskySetup({
      projectRoot: sb.path,
      quiet: true,
      force: true,
    });
    expect(exitCode).toBe(0);

    const hookPath = join(sb.path, '.husky', 'pre-commit');
    expect(readFileSync(hookPath, 'utf-8')).toBe(readTemplate());
    // Executable bit set
    expect(statSync(hookPath).mode & 0o111).not.toBe(0);
  });

  test('preserves a sibling hook in .husky/ (e.g., commit-msg)', async () => {
    const sb = track(createProjectSandbox());
    mkdirSync(join(sb.path, '.husky'), {recursive: true});
    const commitMsgContent =
      '#!/usr/bin/env sh\nnpx --no -- commitlint --edit "$1"\n';
    writeFileSync(join(sb.path, '.husky', 'commit-msg'), commitMsgContent);

    const exitCode = await runHuskySetup({
      projectRoot: sb.path,
      quiet: true,
    });
    expect(exitCode).toBe(0);

    // commit-msg preserved
    expect(readFileSync(join(sb.path, '.husky', 'commit-msg'), 'utf-8')).toBe(
      commitMsgContent,
    );
    // pre-commit written
    expect(readFileSync(join(sb.path, '.husky', 'pre-commit'), 'utf-8')).toBe(
      readTemplate(),
    );
  });

  test('preserves other devDependencies', async () => {
    const sb = track(
      createProjectSandbox({
        packageJson: {
          name: 'test-project',
          devDependencies: {someOther: '1.0.0'},
        },
      }),
    );

    const exitCode = await runHuskySetup({
      projectRoot: sb.path,
      quiet: true,
    });
    expect(exitCode).toBe(0);

    const pkg = readPkg(sb);
    expect(pkg.devDependencies?.someOther).toBe('1.0.0');
    expect(pkg.devDependencies?.husky).toBe(PINNED.husky);
    expect(pkg.devDependencies?.['lint-staged']).toBe(PINNED['lint-staged']);
  });

  test('preserves other scripts and adds prepare', async () => {
    const sb = track(
      createProjectSandbox({
        packageJson: {
          name: 'test-project',
          scripts: {build: 'echo build'},
        },
      }),
    );

    const exitCode = await runHuskySetup({
      projectRoot: sb.path,
      quiet: true,
    });
    expect(exitCode).toBe(0);

    const pkg = readPkg(sb);
    expect(pkg.scripts?.build).toBe('echo build');
    expect(pkg.scripts?.prepare).toBe('husky');
  });

  test('warns but does not overwrite existing husky devDependency at a different version', async () => {
    const sb = track(
      createProjectSandbox({
        packageJson: {
          name: 'test-project',
          devDependencies: {husky: '8.0.0'},
        },
      }),
    );

    const exitCode = await runHuskySetup({
      projectRoot: sb.path,
      quiet: true,
    });
    expect(exitCode).toBe(0);

    const pkg = readPkg(sb);
    expect(pkg.devDependencies?.husky).toBe('8.0.0');
    // lint-staged still added at pinned
    expect(pkg.devDependencies?.['lint-staged']).toBe(PINNED['lint-staged']);
  });

  test('--force overwrites existing devDependency versions', async () => {
    const sb = track(
      createProjectSandbox({
        packageJson: {
          name: 'test-project',
          devDependencies: {husky: '8.0.0', 'lint-staged': '13.0.0'},
        },
      }),
    );

    const exitCode = await runHuskySetup({
      projectRoot: sb.path,
      quiet: true,
      force: true,
    });
    expect(exitCode).toBe(0);

    const pkg = readPkg(sb);
    expect(pkg.devDependencies?.husky).toBe(PINNED.husky);
    expect(pkg.devDependencies?.['lint-staged']).toBe(PINNED['lint-staged']);
  });
});
