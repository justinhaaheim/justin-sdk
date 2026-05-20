/**
 * E2E tests for `justin-sdk add eslint`.
 *
 * These tests exercise the eslint component installer. They don't run
 * `bun add` (the installer only edits package.json), so they're fully
 * offline and fast.
 */

import {describe, test, expect, afterEach} from 'bun:test';
import {existsSync, readFileSync} from 'fs';
import {join} from 'path';

import {runEslintSetup} from '../src/eslint-setup';
import {PINNED, PINNED_GITHUB} from '../src/pinned-versions';
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

describe('eslint-setup', () => {
  test('fresh project: writes all files, scripts, and config', async () => {
    const sb = track(createProjectSandbox());

    const exitCode = await runEslintSetup({
      projectRoot: sb.path,
      quiet: true,
    });
    expect(exitCode).toBe(0);

    // eslint.config.cjs exists
    expect(existsSync(join(sb.path, 'eslint.config.cjs'))).toBe(true);

    const pkg = JSON.parse(
      readFileSync(join(sb.path, 'package.json'), 'utf-8'),
    ) as {
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };

    // devDependencies at PINNED versions
    expect(pkg.devDependencies?.eslint).toBe(PINNED.eslint);
    expect(pkg.devDependencies?.typescript).toBe(PINNED.typescript);
    expect(pkg.devDependencies?.['eslint-config-jha-react-node']).toBe(
      PINNED_GITHUB['eslint-config-jha-react-node'],
    );

    // signal-source:LINT script present
    expect(pkg.scripts?.['signal-source:LINT']).toBe(
      'eslint --report-unused-disable-directives --max-warnings 0 .',
    );

    // convenience lint scripts present
    expect(pkg.scripts?.['lint-base']).toBe(
      'eslint --report-unused-disable-directives --max-warnings 0',
    );
    expect(pkg.scripts?.['lint']).toBe('bun run lint-base -- .');
    expect(pkg.scripts?.['lint:fix']).toBe('bun run lint-base -- --fix .');
    expect(pkg.scripts?.['lint:fix:file']).toBe('bun run lint-base -- --fix');

    // justin-sdk.config.json has eslint-setup in components
    const config = JSON.parse(
      readFileSync(join(sb.path, 'justin-sdk.config.json'), 'utf-8'),
    ) as {components?: string[]};
    expect(config.components).toContain('eslint-setup');
    expect(config.components).toContain('base-setup');
  });

  test('fully idempotent: second run produces same files', async () => {
    const sb = track(createProjectSandbox());

    const first = await runEslintSetup({projectRoot: sb.path, quiet: true});
    expect(first).toBe(0);

    const firstPkg = readFileSync(join(sb.path, 'package.json'), 'utf-8');
    const firstEslintConfig = readFileSync(
      join(sb.path, 'eslint.config.cjs'),
      'utf-8',
    );

    const second = await runEslintSetup({projectRoot: sb.path, quiet: true});
    expect(second).toBe(0);

    expect(readFileSync(join(sb.path, 'package.json'), 'utf-8')).toBe(firstPkg);
    expect(readFileSync(join(sb.path, 'eslint.config.cjs'), 'utf-8')).toBe(
      firstEslintConfig,
    );

    // No duplicate eslint-setup entries
    const config = JSON.parse(
      readFileSync(join(sb.path, 'justin-sdk.config.json'), 'utf-8'),
    ) as {components?: string[]};
    const eslintSetupCount = (config.components ?? []).filter(
      (c) => c === 'eslint-setup',
    ).length;
    expect(eslintSetupCount).toBe(1);
  });

  test('preserves user-customized eslint.config.cjs (does not overwrite)', async () => {
    const sb = track(createProjectSandbox());
    const customContent = "// my custom eslint config\nmodule.exports = [];\n";
    sb.writeFile('eslint.config.cjs', customContent);

    const exitCode = await runEslintSetup({
      projectRoot: sb.path,
      quiet: true,
    });
    // The user's file is preserved and a warn is tolerated; function still returns 0.
    expect(exitCode).toBe(0);
    expect(readFileSync(join(sb.path, 'eslint.config.cjs'), 'utf-8')).toBe(
      customContent,
    );
  });

  test('--force overwrites a hand-modified eslint.config.cjs', async () => {
    const sb = track(createProjectSandbox());
    const customContent = "// my custom eslint config\nmodule.exports = [];\n";
    sb.writeFile('eslint.config.cjs', customContent);

    const exitCode = await runEslintSetup({
      projectRoot: sb.path,
      quiet: true,
      force: true,
    });
    expect(exitCode).toBe(0);

    const after = readFileSync(join(sb.path, 'eslint.config.cjs'), 'utf-8');
    expect(after).not.toBe(customContent);
    // Now matches the SDK template.
    expect(after).toContain('eslint-config-jha-react-node');
  });

  test('preserves existing devDependencies when adding eslint', async () => {
    const sb = track(
      createProjectSandbox({
        packageJson: {
          name: 'test',
          devDependencies: {someOther: '1.0.0'},
        },
      }),
    );

    const exitCode = await runEslintSetup({
      projectRoot: sb.path,
      quiet: true,
    });
    expect(exitCode).toBe(0);

    const pkg = JSON.parse(
      readFileSync(join(sb.path, 'package.json'), 'utf-8'),
    ) as {devDependencies?: Record<string, string>};
    expect(pkg.devDependencies?.someOther).toBe('1.0.0');
    expect(pkg.devDependencies?.eslint).toBe(PINNED.eslint);
    expect(pkg.devDependencies?.typescript).toBe(PINNED.typescript);
    expect(pkg.devDependencies?.['eslint-config-jha-react-node']).toBe(
      PINNED_GITHUB['eslint-config-jha-react-node'],
    );
  });

  test('preserves existing scripts and adds signal-source:LINT', async () => {
    const sb = track(
      createProjectSandbox({
        packageJson: {
          name: 'test',
          scripts: {build: 'echo build'},
        },
      }),
    );

    const exitCode = await runEslintSetup({
      projectRoot: sb.path,
      quiet: true,
    });
    expect(exitCode).toBe(0);

    const pkg = JSON.parse(
      readFileSync(join(sb.path, 'package.json'), 'utf-8'),
    ) as {scripts?: Record<string, string>};
    expect(pkg.scripts?.build).toBe('echo build');
    expect(pkg.scripts?.['signal-source:LINT']).toBe(
      'eslint --report-unused-disable-directives --max-warnings 0 .',
    );
  });

  test('preserves a user-customized lint script', async () => {
    const sb = track(
      createProjectSandbox({
        packageJson: {
          name: 'test',
          scripts: {lint: 'echo custom'},
        },
      }),
    );

    const exitCode = await runEslintSetup({
      projectRoot: sb.path,
      quiet: true,
    });
    expect(exitCode).toBe(0);

    const pkg = JSON.parse(
      readFileSync(join(sb.path, 'package.json'), 'utf-8'),
    ) as {scripts?: Record<string, string>};
    // User's lint script preserved untouched.
    expect(pkg.scripts?.['lint']).toBe('echo custom');
    // But the other convenience scripts were still added.
    expect(pkg.scripts?.['lint-base']).toBe(
      'eslint --report-unused-disable-directives --max-warnings 0',
    );
    expect(pkg.scripts?.['lint:fix']).toBe('bun run lint-base -- --fix .');
    expect(pkg.scripts?.['lint:fix:file']).toBe('bun run lint-base -- --fix');
  });

  test('does NOT install @typescript-eslint/parser or @typescript-eslint/eslint-plugin', async () => {
    const sb = track(createProjectSandbox());

    const exitCode = await runEslintSetup({
      projectRoot: sb.path,
      quiet: true,
    });
    expect(exitCode).toBe(0);

    const pkg = JSON.parse(
      readFileSync(join(sb.path, 'package.json'), 'utf-8'),
    ) as {devDependencies?: Record<string, string>};

    // These come transitively via eslint-config-jha-react-node and must
    // NOT be installed directly by eslint-setup.
    expect(pkg.devDependencies?.['@typescript-eslint/parser']).toBeUndefined();
    expect(
      pkg.devDependencies?.['@typescript-eslint/eslint-plugin'],
    ).toBeUndefined();
  });
});
