/**
 * E2E tests for `justin-sdk add prompts`.
 *
 * All tests pass `skipFetch: true` to avoid hitting the network (the
 * external `bunx git+...justinhaaheim/prompts` call). The non-skipFetch
 * code path is exercised in real-world use via the CLI.
 */

import {describe, test, expect, afterEach} from 'bun:test';
import {existsSync, readFileSync} from 'fs';
import {join} from 'path';

import {runPromptsSetup} from '../src/prompts-setup';
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

const EXPECTED_COMMAND =
  'bunx git+https://github.com/justinhaaheim/prompts --target-dir docs/prompts --md';

describe('prompts-setup', () => {
  test('fresh project: adds script, registers component, does not auto-create docs/prompts/', async () => {
    const sb = track(createProjectSandbox());
    const exitCode = await runPromptsSetup({
      projectRoot: sb.path,
      quiet: true,
      skipFetch: true,
    });
    expect(exitCode).toBe(0);

    // package.json has install-my-prompts script with the right command
    const pkg = JSON.parse(
      readFileSync(join(sb.path, 'package.json'), 'utf-8'),
    ) as {scripts?: Record<string, string>};
    expect(pkg.scripts?.['install-my-prompts']).toBe(EXPECTED_COMMAND);

    // justin-sdk.config.json has prompts-setup in components
    const config = JSON.parse(
      readFileSync(join(sb.path, 'justin-sdk.config.json'), 'utf-8'),
    ) as {components?: string[]};
    expect(config.components).toContain('prompts-setup');
    expect(config.components).toContain('base-setup');

    // docs/prompts/ is NOT auto-created (skipFetch means we don't fetch)
    expect(existsSync(join(sb.path, 'docs/prompts'))).toBe(false);
  });

  test('idempotent: second run returns 0 with no spurious writes', async () => {
    const sb = track(createProjectSandbox());

    const first = await runPromptsSetup({
      projectRoot: sb.path,
      quiet: true,
      skipFetch: true,
    });
    expect(first).toBe(0);

    const pkgAfterFirst = readFileSync(join(sb.path, 'package.json'), 'utf-8');
    const configAfterFirst = readFileSync(
      join(sb.path, 'justin-sdk.config.json'),
      'utf-8',
    );

    const second = await runPromptsSetup({
      projectRoot: sb.path,
      quiet: true,
      skipFetch: true,
    });
    expect(second).toBe(0);

    // package.json unchanged
    expect(readFileSync(join(sb.path, 'package.json'), 'utf-8')).toBe(
      pkgAfterFirst,
    );

    // justin-sdk.config.json: only lastSynced is allowed to differ (it
    // gets updated to today on every run). Verify components hasn't grown
    // duplicates.
    const config = JSON.parse(configAfterFirst) as {components?: string[]};
    const promptsSetupCount = (config.components ?? []).filter(
      (c) => c === 'prompts-setup',
    ).length;
    expect(promptsSetupCount).toBe(1);
    const baseSetupCount = (config.components ?? []).filter(
      (c) => c === 'base-setup',
    ).length;
    expect(baseSetupCount).toBe(1);
  });

  test('preserves a customized install-my-prompts script', async () => {
    const customCommand = 'bunx git+https://github.com/me/my-fork --md';
    const sb = track(
      createProjectSandbox({
        packageJson: {
          name: 'test',
          scripts: {
            'install-my-prompts': customCommand,
          },
        },
      }),
    );

    const exitCode = await runPromptsSetup({
      projectRoot: sb.path,
      quiet: true,
      skipFetch: true,
    });
    expect(exitCode).toBe(0);

    const pkg = JSON.parse(
      readFileSync(join(sb.path, 'package.json'), 'utf-8'),
    ) as {scripts?: Record<string, string>};
    expect(pkg.scripts?.['install-my-prompts']).toBe(customCommand);
  });

  test('preserves other scripts in package.json', async () => {
    const sb = track(
      createProjectSandbox({
        packageJson: {
          name: 'test',
          scripts: {
            build: 'tsc',
            test: 'bun test',
            'my-custom-script': 'echo hi',
          },
        },
      }),
    );

    const exitCode = await runPromptsSetup({
      projectRoot: sb.path,
      quiet: true,
      skipFetch: true,
    });
    expect(exitCode).toBe(0);

    const pkg = JSON.parse(
      readFileSync(join(sb.path, 'package.json'), 'utf-8'),
    ) as {scripts?: Record<string, string>};

    expect(pkg.scripts?.build).toBe('tsc');
    expect(pkg.scripts?.test).toBe('bun test');
    expect(pkg.scripts?.['my-custom-script']).toBe('echo hi');
    expect(pkg.scripts?.['install-my-prompts']).toBe(EXPECTED_COMMAND);
  });

  test('does not clobber an existing docs/prompts/IMPORTANT_GUIDELINES_INLINED.md', async () => {
    const sb = track(createProjectSandbox());
    const userContent = '# My custom guidelines\n\nDo not clobber.\n';
    sb.writeFile('docs/prompts/IMPORTANT_GUIDELINES_INLINED.md', userContent);

    const exitCode = await runPromptsSetup({
      projectRoot: sb.path,
      quiet: true,
      skipFetch: true,
    });
    expect(exitCode).toBe(0);

    const onDisk = readFileSync(
      join(sb.path, 'docs/prompts/IMPORTANT_GUIDELINES_INLINED.md'),
      'utf-8',
    );
    expect(onDisk).toBe(userContent);
  });
});
