/**
 * E2E tests for `justin-sdk add prettier`.
 *
 * These tests exercise the prettier component installer. They don't run
 * `bun add` (the installer only edits package.json), so they're fully
 * offline and fast.
 */

import {describe, test, expect, afterEach} from 'bun:test';
import {existsSync, readFileSync} from 'fs';
import {join} from 'path';

import {PINNED} from '../src/pinned-versions';
import {runPrettierSetup} from '../src/prettier-setup';
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

describe('prettier-setup', () => {
  test('fresh project: writes all files, scripts, and config', async () => {
    const sb = track(createProjectSandbox());

    const exitCode = await runPrettierSetup({
      projectRoot: sb.path,
      quiet: true,
    });
    expect(exitCode).toBe(0);

    // .prettierrc.json + .prettierignore exist
    expect(existsSync(join(sb.path, '.prettierrc.json'))).toBe(true);
    expect(existsSync(join(sb.path, '.prettierignore'))).toBe(true);

    // prettier is in devDependencies at PINNED version
    const pkg = JSON.parse(
      readFileSync(join(sb.path, 'package.json'), 'utf-8'),
    ) as {
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    expect(pkg.devDependencies?.prettier).toBe(PINNED.prettier);

    // signal-source:PRETTIER script present
    expect(pkg.scripts?.['signal-source:PRETTIER']).toBe('prettier --check .');

    // justin-sdk.config.json has prettier-setup in components
    const config = JSON.parse(
      readFileSync(join(sb.path, 'justin-sdk.config.json'), 'utf-8'),
    ) as {components?: string[]};
    expect(config.components).toContain('prettier-setup');
    expect(config.components).toContain('base-setup');
  });

  test('fully idempotent: second run produces same files', async () => {
    const sb = track(createProjectSandbox());

    const first = await runPrettierSetup({projectRoot: sb.path, quiet: true});
    expect(first).toBe(0);

    const firstPkg = readFileSync(join(sb.path, 'package.json'), 'utf-8');
    const firstPrettierrc = readFileSync(
      join(sb.path, '.prettierrc.json'),
      'utf-8',
    );
    const firstPrettierignore = readFileSync(
      join(sb.path, '.prettierignore'),
      'utf-8',
    );

    const second = await runPrettierSetup({projectRoot: sb.path, quiet: true});
    expect(second).toBe(0);

    expect(readFileSync(join(sb.path, 'package.json'), 'utf-8')).toBe(firstPkg);
    expect(readFileSync(join(sb.path, '.prettierrc.json'), 'utf-8')).toBe(
      firstPrettierrc,
    );
    expect(readFileSync(join(sb.path, '.prettierignore'), 'utf-8')).toBe(
      firstPrettierignore,
    );

    // No duplicate prettier-setup entries
    const config = JSON.parse(
      readFileSync(join(sb.path, 'justin-sdk.config.json'), 'utf-8'),
    ) as {components?: string[]};
    const prettierSetupCount = (config.components ?? []).filter(
      (c) => c === 'prettier-setup',
    ).length;
    expect(prettierSetupCount).toBe(1);
  });

  test('preserves user-customized .prettierrc.json (does not overwrite)', async () => {
    const sb = track(createProjectSandbox());
    const customContent = JSON.stringify({singleQuote: false}, null, 2) + '\n';
    sb.writeFile('.prettierrc.json', customContent);

    const exitCode = await runPrettierSetup({
      projectRoot: sb.path,
      quiet: true,
    });
    // The user's file is preserved and a warn is tolerated; function still returns 0.
    expect(exitCode).toBe(0);
    expect(readFileSync(join(sb.path, '.prettierrc.json'), 'utf-8')).toBe(
      customContent,
    );
  });

  test('preserves user-customized .prettierignore but appends missing baseline entries', async () => {
    const sb = track(createProjectSandbox());
    // User has a custom .prettierignore with only a couple entries
    const customPartial = '# custom user header\nmy-custom-folder\nbuild\n';
    sb.writeFile('.prettierignore', customPartial);

    const exitCode = await runPrettierSetup({
      projectRoot: sb.path,
      quiet: true,
    });
    expect(exitCode).toBe(0);

    const content = readFileSync(join(sb.path, '.prettierignore'), 'utf-8');
    // User's original content preserved
    expect(content).toContain('# custom user header');
    expect(content).toContain('my-custom-folder');
    expect(content).toContain('build');
    // Missing baseline entries appended
    expect(content).toContain('node_modules');
    expect(content).toContain('dist');
    expect(content).toContain('coverage');
    expect(content).toContain('*.tsbuildinfo');
    expect(content).toContain('.beads');
    expect(content).toContain('tmp');
    expect(content).toContain('*.log');
  });

  test('appendIfMissing on .prettierignore is idempotent', async () => {
    const sb = track(createProjectSandbox());
    sb.writeFile('.prettierignore', '# minimal\nbuild\n');

    await runPrettierSetup({projectRoot: sb.path, quiet: true});
    const firstContent = readFileSync(
      join(sb.path, '.prettierignore'),
      'utf-8',
    );

    await runPrettierSetup({projectRoot: sb.path, quiet: true});
    const secondContent = readFileSync(
      join(sb.path, '.prettierignore'),
      'utf-8',
    );

    expect(secondContent).toBe(firstContent);
    // No duplicates of .beads
    const beadsMatches = secondContent.match(/^\.beads$/gm) ?? [];
    expect(beadsMatches.length).toBe(1);
  });

  test('preserves existing devDependencies when adding prettier', async () => {
    const sb = track(
      createProjectSandbox({
        packageJson: {
          name: 'test',
          devDependencies: {someOther: '1.0.0'},
        },
      }),
    );

    const exitCode = await runPrettierSetup({
      projectRoot: sb.path,
      quiet: true,
    });
    expect(exitCode).toBe(0);

    const pkg = JSON.parse(
      readFileSync(join(sb.path, 'package.json'), 'utf-8'),
    ) as {devDependencies?: Record<string, string>};
    expect(pkg.devDependencies?.someOther).toBe('1.0.0');
    expect(pkg.devDependencies?.prettier).toBe(PINNED.prettier);
  });

  test('preserves existing scripts and adds signal-source:PRETTIER', async () => {
    const sb = track(
      createProjectSandbox({
        packageJson: {
          name: 'test',
          scripts: {build: 'echo build'},
        },
      }),
    );

    const exitCode = await runPrettierSetup({
      projectRoot: sb.path,
      quiet: true,
    });
    expect(exitCode).toBe(0);

    const pkg = JSON.parse(
      readFileSync(join(sb.path, 'package.json'), 'utf-8'),
    ) as {scripts?: Record<string, string>};
    expect(pkg.scripts?.build).toBe('echo build');
    expect(pkg.scripts?.['signal-source:PRETTIER']).toBe('prettier --check .');
  });

  test('warns but does not overwrite existing prettier devDependency at a different version', async () => {
    const sb = track(
      createProjectSandbox({
        packageJson: {
          name: 'test',
          devDependencies: {prettier: '2.0.0'},
        },
      }),
    );

    const exitCode = await runPrettierSetup({
      projectRoot: sb.path,
      quiet: true,
    });
    expect(exitCode).toBe(0);

    const pkg = JSON.parse(
      readFileSync(join(sb.path, 'package.json'), 'utf-8'),
    ) as {devDependencies?: Record<string, string>};
    // Existing version preserved, not overwritten
    expect(pkg.devDependencies?.prettier).toBe('2.0.0');
  });

  test('--force overwrites existing prettier devDependency version', async () => {
    const sb = track(
      createProjectSandbox({
        packageJson: {
          name: 'test',
          devDependencies: {prettier: '2.0.0'},
        },
      }),
    );

    const exitCode = await runPrettierSetup({
      projectRoot: sb.path,
      quiet: true,
      force: true,
    });
    expect(exitCode).toBe(0);

    const pkg = JSON.parse(
      readFileSync(join(sb.path, 'package.json'), 'utf-8'),
    ) as {devDependencies?: Record<string, string>};
    expect(pkg.devDependencies?.prettier).toBe(PINNED.prettier);
  });
});
