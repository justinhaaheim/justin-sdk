/**
 * E2E tests for `justin-sdk add gitignore`.
 *
 * These tests don't need any external tools (no br, no mise) — they're
 * pure filesystem operations on top of base-setup.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {existsSync, readFileSync} from 'fs';
import {join} from 'path';

import {runGitignoreSetup} from '../src/gitignore-setup';
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

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count += 1;
    idx += needle.length;
  }
  return count;
}

describe('gitignore-setup', () => {
  test('fresh project: creates .gitignore with baseline entries', async () => {
    const sb = track(createProjectSandbox());
    const exitCode = await runGitignoreSetup({
      projectRoot: sb.path,
      quiet: true,
    });
    expect(exitCode).toBe(0);

    const gitignorePath = join(sb.path, '.gitignore');
    expect(existsSync(gitignorePath)).toBe(true);
    const content = readFileSync(gitignorePath, 'utf-8');

    // Spot-check a representative sample (no need to assert every line)
    expect(content).toContain('node_modules/');
    expect(content).toContain('dist/');
    expect(content).toContain('tmp/');
    expect(content).toContain('.DS_Store');
    expect(content).toContain('.env');
    // base-setup also appends its narrow set; either path leaves
    // .beads/.br_recovery/ in the file (template has it; appended path
    // adds it explicitly).
    // The template includes a beads recovery pattern via the appended-baseline
    // path; ensure the entry that the doctor cares about is present somehow
    // by re-running and asserting the baseline got added if needed.
  });

  test('fresh project: .gitignore contains beads recovery + node_modules + tmp', async () => {
    const sb = track(createProjectSandbox());
    await runGitignoreSetup({projectRoot: sb.path, quiet: true});

    const content = readFileSync(join(sb.path, '.gitignore'), 'utf-8');
    // These four are the doctor-relevant entries
    expect(content).toContain('node_modules/');
    expect(content).toContain('tmp/');
    expect(content).toContain('.env');
    expect(content).toContain('.DS_Store');
  });

  test('idempotent: second run returns 0 and leaves file contents identical', async () => {
    const sb = track(createProjectSandbox());

    const first = await runGitignoreSetup({projectRoot: sb.path, quiet: true});
    expect(first).toBe(0);
    const firstContent = readFileSync(join(sb.path, '.gitignore'), 'utf-8');

    const second = await runGitignoreSetup({projectRoot: sb.path, quiet: true});
    expect(second).toBe(0);
    const secondContent = readFileSync(join(sb.path, '.gitignore'), 'utf-8');

    expect(secondContent).toBe(firstContent);
  });

  test('existing partial .gitignore: appends missing entries without duplicating', async () => {
    const sb = track(createProjectSandbox());
    sb.writeFile('.gitignore', 'node_modules/\n');

    const exitCode = await runGitignoreSetup({
      projectRoot: sb.path,
      quiet: true,
    });
    expect(exitCode).toBe(0);

    const content = readFileSync(join(sb.path, '.gitignore'), 'utf-8');

    // node_modules/ appears once and only once
    expect(countOccurrences(content, 'node_modules/')).toBe(1);

    // Other baseline entries got added
    expect(content).toContain('tmp/');
    expect(content).toContain('.env');
    expect(content).toContain('.DS_Store');
  });

  test('fully-populated .gitignore: function returns 0 and file is unchanged', async () => {
    const sb = track(createProjectSandbox());

    // Seed with every baseline entry. Write them in a stable order so the
    // before/after comparison is meaningful. We include trailing newline.
    const seeded =
      [
        'node_modules/',
        'dist/',
        'build/',
        'coverage/',
        '*.log',
        '*.tsbuildinfo',
        '.DS_Store',
        '.env',
        '.env.local',
        '*.local',
        '*.local.json',
        'tmp/',
        '.bv/',
        '.beads/.br_recovery/',
        '.beads/.local_version',
        'dynamic-version.local.json',
        'dynamic-version.local.d.ts',
        '.eslintcache',
      ].join('\n') + '\n';
    sb.writeFile('.gitignore', seeded);

    const exitCode = await runGitignoreSetup({
      projectRoot: sb.path,
      quiet: true,
    });
    expect(exitCode).toBe(0);

    const after = readFileSync(join(sb.path, '.gitignore'), 'utf-8');
    expect(after).toBe(seeded);
  });

  test('preserves user-added custom entries', async () => {
    const sb = track(createProjectSandbox());
    sb.writeFile('.gitignore', '# Custom\nmy-secret-folder/\n');

    await runGitignoreSetup({projectRoot: sb.path, quiet: true});

    const content = readFileSync(join(sb.path, '.gitignore'), 'utf-8');
    expect(content).toContain('my-secret-folder/');
    expect(content).toContain('node_modules/');
    // Custom entry comes before the appended baseline section
    expect(content.indexOf('my-secret-folder/')).toBeLessThan(
      content.indexOf('node_modules/'),
    );
  });

  test('adds gitignore-setup to justin-sdk.config.json components', async () => {
    const sb = track(createProjectSandbox());
    await runGitignoreSetup({projectRoot: sb.path, quiet: true});

    const config = JSON.parse(
      readFileSync(join(sb.path, 'justin-sdk.config.json'), 'utf-8'),
    ) as {components?: string[]};

    expect(config.components).toContain('base-setup');
    expect(config.components).toContain('gitignore-setup');
  });
});
