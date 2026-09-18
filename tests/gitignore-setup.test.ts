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
  });

  test('fresh project: .gitignore contains beads recovery + node_modules + tmp', async () => {
    const sb = track(createProjectSandbox());
    await runGitignoreSetup({projectRoot: sb.path, quiet: true});

    const content = readFileSync(join(sb.path, '.gitignore'), 'utf-8');
    // These are the doctor-relevant entries
    expect(content).toContain('node_modules/');
    expect(content).toContain('tmp/');
    expect(content).toContain('.beads/.br_recovery/');
    expect(content).toContain('.DS_Store');
  });

  // home-base-dchjw.6 / epic D3: Justin's decision of 2026-09-18. The SDK does
  // not put `.env` or `.env.local` in anyone's .gitignore; local-only files are
  // covered by exactly three `*.local` patterns, each appearing once.
  test('fresh project: no .env lines, and the three local patterns appear exactly once', async () => {
    const sb = track(createProjectSandbox());
    await runGitignoreSetup({projectRoot: sb.path, quiet: true});

    const content = readFileSync(join(sb.path, '.gitignore'), 'utf-8');
    expect(content).not.toContain('.env');

    const lines = content.split('\n').map((line) => line.trim());
    expect(lines.filter((line) => line === '*.local').length).toBe(1);
    expect(lines.filter((line) => line === '*.local.json').length).toBe(1);
    expect(lines.filter((line) => line === '*.local.*').length).toBe(1);
  });

  test('an existing .env line is left alone (we stop adding it, we do not remove it)', async () => {
    const sb = track(createProjectSandbox());
    sb.writeFile('.gitignore', '.env\n.env.local\n');

    await runGitignoreSetup({projectRoot: sb.path, quiet: true});

    const lines = readFileSync(join(sb.path, '.gitignore'), 'utf-8')
      .split('\n')
      .map((line) => line.trim());
    expect(lines.filter((line) => line === '.env').length).toBe(1);
    expect(lines.filter((line) => line === '.env.local').length).toBe(1);
  });

  // The reported bug, in .gitignore form: a trailing-slash (or globstar)
  // variant of a baseline entry must be REWRITTEN to the baseline spelling,
  // not joined by a near-duplicate.
  test('a differently-spelled entry is rewritten in place, never duplicated', async () => {
    const sb = track(createProjectSandbox());
    sb.writeFile(
      '.gitignore',
      '# mine\nmy-secret-folder/\n.claude/worktrees\n**/coverage/\nnode_modules\n',
    );

    await runGitignoreSetup({projectRoot: sb.path, quiet: true});

    const content = readFileSync(join(sb.path, '.gitignore'), 'utf-8');
    const lines = content.split('\n').map((line) => line.trim());

    // Rewritten to the canonical spelling…
    expect(lines.filter((line) => line === '.claude/worktrees/').length).toBe(
      1,
    );
    expect(lines.filter((line) => line === 'coverage/').length).toBe(1);
    expect(lines.filter((line) => line === 'node_modules/').length).toBe(1);
    // …and the near-miss spellings are gone, not sitting next to them.
    expect(lines).not.toContain('.claude/worktrees');
    expect(lines).not.toContain('**/coverage/');
    expect(lines).not.toContain('node_modules');
    // Untouched user content survives.
    expect(lines).toContain('# mine');
    expect(lines).toContain('my-secret-folder/');
  });

  test('repeated spellings of one entry collapse to a single line', async () => {
    const sb = track(createProjectSandbox());
    sb.writeFile('.gitignore', '*.local\n*.local\n*.local/\ntmp/\n**/tmp/\n');

    await runGitignoreSetup({projectRoot: sb.path, quiet: true});

    const lines = readFileSync(join(sb.path, '.gitignore'), 'utf-8')
      .split('\n')
      .map((line) => line.trim());
    expect(lines.filter((line) => line === '*.local').length).toBe(1);
    expect(lines.filter((line) => line === 'tmp/').length).toBe(1);
    expect(lines.filter((line) => line === '**/tmp/').length).toBe(0);
  });

  test('negations and comments are never matched or rewritten', async () => {
    const sb = track(createProjectSandbox());
    sb.writeFile(
      '.gitignore',
      '# build outputs live here\n!build/keep-me.txt\nbuild/\n',
    );

    await runGitignoreSetup({projectRoot: sb.path, quiet: true});

    const lines = readFileSync(join(sb.path, '.gitignore'), 'utf-8')
      .split('\n')
      .map((line) => line.trim());
    expect(lines).toContain('!build/keep-me.txt');
    expect(lines).toContain('# build outputs live here');
    expect(lines.filter((line) => line === 'build/').length).toBe(1);
  });

  test('idempotent from a variant-spelled file: the rewrite happens once', async () => {
    const sb = track(createProjectSandbox());
    sb.writeFile('.gitignore', '.claude/worktrees\ncoverage\n');

    await runGitignoreSetup({projectRoot: sb.path, quiet: true});
    const firstContent = readFileSync(join(sb.path, '.gitignore'), 'utf-8');

    await runGitignoreSetup({projectRoot: sb.path, quiet: true});
    const secondContent = readFileSync(join(sb.path, '.gitignore'), 'utf-8');

    expect(secondContent).toBe(firstContent);
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
    expect(content).toContain('*.local.*');
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
        '*.local',
        '*.local.json',
        '*.local.*',
        'tmp/',
        '.bv/',
        '.beads/.br_recovery/',
        '.beads/.local_version',
        'dynamic-version.local.json',
        'dynamic-version.local.d.ts',
        '.eslintcache',
        '.claude/worktrees/',
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

  test('does NOT touch justin-sdk.config.json components (F11)', async () => {
    const sb = track(createProjectSandbox());
    await runGitignoreSetup({projectRoot: sb.path, quiet: true});

    const config = JSON.parse(
      readFileSync(join(sb.path, 'justin-sdk.config.json'), 'utf-8'),
    ) as {components?: string[]};

    // The INSTALLER no longer registers itself (constraint F11): only `add` and
    // `remove` write `components`.
    expect(config.components).toBeUndefined();
  });
});
