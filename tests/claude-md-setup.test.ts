/**
 * E2E tests for `justin-sdk add claude-md`.
 *
 * Pure filesystem operations — no external tools needed.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {existsSync, readFileSync} from 'fs';
import {basename, join} from 'path';

import {runClaudeMdSetup} from '../src/claude-md-setup';
import {createProjectSandbox, type Sandbox} from './sandbox';

const PROMPTS_REF = '@docs/prompts/IMPORTANT_GUIDELINES_INLINED.md';

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

describe('claude-md-setup', () => {
  test('fresh project: writes templated CLAUDE.md and registers component', async () => {
    const sb = track(createProjectSandbox());

    const exitCode = await runClaudeMdSetup({
      projectRoot: sb.path,
      quiet: true,
    });
    expect(exitCode).toBe(0);

    const claudeMdPath = join(sb.path, 'CLAUDE.md');
    expect(existsSync(claudeMdPath)).toBe(true);

    const content = readFileSync(claudeMdPath, 'utf-8');
    // Project name substituted (sandbox dir basename)
    const projectName = basename(sb.path);
    expect(content).toContain(projectName);
    // No leftover placeholder
    expect(content).not.toContain('{{PROJECT_NAME}}');
    // Prompts reference present (from the template itself)
    expect(content).toContain(PROMPTS_REF);

    // justin-sdk.config.json includes claude-md-setup
    const config = JSON.parse(
      readFileSync(join(sb.path, 'justin-sdk.config.json'), 'utf-8'),
    ) as {components?: string[]};
    expect(config.components).toContain('base-setup');
    expect(config.components).toContain('claude-md-setup');
  });

  test('fully idempotent on fresh project: second run produces no diff', async () => {
    const sb = track(createProjectSandbox());

    const first = await runClaudeMdSetup({projectRoot: sb.path, quiet: true});
    expect(first).toBe(0);
    const firstContent = readFileSync(join(sb.path, 'CLAUDE.md'), 'utf-8');
    const firstConfig = readFileSync(
      join(sb.path, 'justin-sdk.config.json'),
      'utf-8',
    );

    const second = await runClaudeMdSetup({projectRoot: sb.path, quiet: true});
    expect(second).toBe(0);

    expect(readFileSync(join(sb.path, 'CLAUDE.md'), 'utf-8')).toBe(
      firstContent,
    );
    expect(readFileSync(join(sb.path, 'justin-sdk.config.json'), 'utf-8')).toBe(
      firstConfig,
    );

    // No duplicate claude-md-setup entries
    const config = JSON.parse(firstConfig) as {components?: string[]};
    const count = (config.components ?? []).filter(
      (c) => c === 'claude-md-setup',
    ).length;
    expect(count).toBe(1);
  });

  test('existing custom CLAUDE.md: preserves original content, appends prompts ref once', async () => {
    const sb = track(createProjectSandbox());
    const customContent = '# My Project\n\nSome content.\n';
    sb.writeFile('CLAUDE.md', customContent);

    const exitCode = await runClaudeMdSetup({
      projectRoot: sb.path,
      quiet: true,
    });
    expect(exitCode).toBe(0);

    const content = readFileSync(join(sb.path, 'CLAUDE.md'), 'utf-8');
    // Original verbatim at the beginning
    expect(content.startsWith(customContent)).toBe(true);
    // Prompts reference now present, exactly once
    expect(countOccurrences(content, PROMPTS_REF)).toBe(1);
  });

  test('idempotent on existing custom CLAUDE.md: prompts ref appended only once across runs', async () => {
    const sb = track(createProjectSandbox());
    const customContent = '# My Project\n\nSome content.\n';
    sb.writeFile('CLAUDE.md', customContent);

    await runClaudeMdSetup({projectRoot: sb.path, quiet: true});
    const firstContent = readFileSync(join(sb.path, 'CLAUDE.md'), 'utf-8');

    await runClaudeMdSetup({projectRoot: sb.path, quiet: true});
    const secondContent = readFileSync(join(sb.path, 'CLAUDE.md'), 'utf-8');

    expect(secondContent).toBe(firstContent);
    expect(countOccurrences(secondContent, PROMPTS_REF)).toBe(1);
  });

  test('CLAUDE.md that already references the prompts file: unchanged', async () => {
    const sb = track(createProjectSandbox());
    const customContent = `# Existing Project\n\nSee ${PROMPTS_REF} for details.\n`;
    sb.writeFile('CLAUDE.md', customContent);

    const exitCode = await runClaudeMdSetup({
      projectRoot: sb.path,
      quiet: true,
    });
    expect(exitCode).toBe(0);

    const content = readFileSync(join(sb.path, 'CLAUDE.md'), 'utf-8');
    // File is unchanged (no duplicate appended)
    expect(content).toBe(customContent);
    expect(countOccurrences(content, PROMPTS_REF)).toBe(1);
  });

  test('force=true does NOT clobber existing CLAUDE.md', async () => {
    const sb = track(createProjectSandbox());
    const customContent = '# Preserve Me\n\nImportant hand-written notes.\n';
    sb.writeFile('CLAUDE.md', customContent);

    const exitCode = await runClaudeMdSetup({
      projectRoot: sb.path,
      quiet: true,
      force: true,
    });
    expect(exitCode).toBe(0);

    const content = readFileSync(join(sb.path, 'CLAUDE.md'), 'utf-8');
    // Original content preserved verbatim at the start
    expect(content.startsWith(customContent)).toBe(true);
    expect(content).toContain('# Preserve Me');
    expect(content).toContain('Important hand-written notes.');
    // Prompts reference appended exactly once
    expect(countOccurrences(content, PROMPTS_REF)).toBe(1);
  });
});
