/**
 * E2E tests for `justin-sdk add gh-actions`.
 *
 * Exercises the gh-actions-setup component, which installs a standard
 * GitHub Actions workflow that runs `bun run signal` on push/PR.
 *
 * No external tools needed — pure filesystem ops.
 */

import {describe, test, expect, afterEach} from 'bun:test';
import {existsSync, readFileSync} from 'fs';
import {join} from 'path';

import {runGhActionsSetup} from '../src/gh-actions-setup';
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

describe('gh-actions-setup', () => {
  test('fresh project: writes signal.yml and registers component', async () => {
    const sb = track(createProjectSandbox());

    const exitCode = await runGhActionsSetup({
      projectRoot: sb.path,
      quiet: true,
    });
    expect(exitCode).toBe(0);

    const workflowPath = join(sb.path, '.github/workflows/signal.yml');
    expect(existsSync(workflowPath)).toBe(true);

    const content = readFileSync(workflowPath, 'utf-8');
    expect(content).toContain('bun run signal');
    expect(content).toContain('bun-version: latest');

    const config = JSON.parse(
      readFileSync(join(sb.path, 'justin-sdk.config.json'), 'utf-8'),
    ) as {components?: string[]};
    expect(config.components).toContain('gh-actions-setup');
  });

  test('idempotent: second run leaves workflow content unchanged', async () => {
    const sb = track(createProjectSandbox());

    const first = await runGhActionsSetup({
      projectRoot: sb.path,
      quiet: true,
    });
    expect(first).toBe(0);

    const workflowPath = join(sb.path, '.github/workflows/signal.yml');
    const firstContent = readFileSync(workflowPath, 'utf-8');

    const second = await runGhActionsSetup({
      projectRoot: sb.path,
      quiet: true,
    });
    expect(second).toBe(0);

    const secondContent = readFileSync(workflowPath, 'utf-8');
    expect(secondContent).toBe(firstContent);
  });

  test('preserves an existing hand-modified signal.yml (no --force)', async () => {
    const sb = track(createProjectSandbox());
    const customWorkflow = 'name: custom\non: push\njobs: {}\n';
    sb.writeFile('.github/workflows/signal.yml', customWorkflow);

    const exitCode = await runGhActionsSetup({
      projectRoot: sb.path,
      quiet: true,
    });
    expect(exitCode).toBe(0);

    const content = readFileSync(
      join(sb.path, '.github/workflows/signal.yml'),
      'utf-8',
    );
    expect(content).toBe(customWorkflow);
  });

  test('--force overwrites a hand-modified signal.yml', async () => {
    const sb = track(createProjectSandbox());
    const customWorkflow = 'name: custom\non: push\njobs: {}\n';
    sb.writeFile('.github/workflows/signal.yml', customWorkflow);

    const exitCode = await runGhActionsSetup({
      projectRoot: sb.path,
      quiet: true,
      force: true,
    });
    expect(exitCode).toBe(0);

    const content = readFileSync(
      join(sb.path, '.github/workflows/signal.yml'),
      'utf-8',
    );
    expect(content).not.toBe(customWorkflow);
    expect(content).toContain('bun run signal');
    expect(content).toContain('oven-sh/setup-bun');
  });

  test('preserves unrelated workflow files in .github/workflows/', async () => {
    const sb = track(createProjectSandbox());
    const otherWorkflow =
      'name: Other\non: push\njobs:\n  other:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n';
    sb.writeFile('.github/workflows/other.yml', otherWorkflow);

    const exitCode = await runGhActionsSetup({
      projectRoot: sb.path,
      quiet: true,
    });
    expect(exitCode).toBe(0);

    // other.yml is untouched
    const preservedContent = readFileSync(
      join(sb.path, '.github/workflows/other.yml'),
      'utf-8',
    );
    expect(preservedContent).toBe(otherWorkflow);

    // signal.yml was installed alongside it
    const signalContent = readFileSync(
      join(sb.path, '.github/workflows/signal.yml'),
      'utf-8',
    );
    expect(signalContent).toContain('bun run signal');
  });
});
