/**
 * Tests for sync-rules — regenerating the deployed universal rules file.
 *
 * Uses JSDK_PROMPTS_DIR to point assemble() at a non-git fixture (so no network
 * clone and version-manager is skipped -> version 'unknown'), and outFile to
 * write into a sandbox instead of ~/.claude.
 */

import {describe, test, expect, afterEach} from 'bun:test';
import {existsSync, readFileSync} from 'fs';
import {join} from 'path';

import {runSyncRules} from '../src/sync-rules';
import {createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
function track(sb: Sandbox): Sandbox {
  sandboxes.push(sb);
  return sb;
}
const savedPromptsDir = process.env.JSDK_PROMPTS_DIR;
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
  if (savedPromptsDir == null) delete process.env.JSDK_PROMPTS_DIR;
  else process.env.JSDK_PROMPTS_DIR = savedPromptsDir;
});

/** A prompts fixture (universal + one RN-gated module) used as the source. */
function promptsFixture(): string {
  const sb = track(createSandbox());
  sb.writeFile(
    'src/rules/index.md',
    ['@./universal-a.md', '@./rn-only.md'].join('\n\n'),
  );
  sb.writeFile('src/rules/universal-a.md', 'UNIVERSAL_A');
  sb.writeFile(
    'src/rules/rn-only.md',
    '---\nincludeIf: [isReactNative]\n---\n\nRN_ONLY',
  );
  process.env.JSDK_PROMPTS_DIR = sb.path;
  return sb.path;
}

function outFile(): string {
  const sb = track(createSandbox());
  return join(sb.path, '.claude/rules/justin-sdk/critical-rules.md');
}

describe('sync-rules', () => {
  test('writes the universal rules with a version/commit/content stamp', async () => {
    promptsFixture();
    const out = outFile();
    const rc = await runSyncRules({
      quiet: true,
      outFile: out,
      now: '2020-01-01',
    });
    expect(rc).toBe(0);
    expect(existsSync(out)).toBe(true);
    const content = readFileSync(out, 'utf-8');
    // universal content only (RN-gated module excluded from the file)
    expect(content).toContain('UNIVERSAL_A');
    expect(content).not.toContain('RN_ONLY');
    expect(content).toContain('# Critical Rules');
    // stamp present with a content hash (non-git fixture -> version unknown)
    expect(content.startsWith('<!-- justin-sdk rules')).toBe(true);
    expect(/content [0-9a-f]{12}/.test(content)).toBe(true);
    expect(content).toContain('do not edit');
  });

  test('is idempotent — unchanged content is not rewritten', async () => {
    promptsFixture();
    const out = outFile();
    await runSyncRules({
      quiet: true,
      outFile: out,
      now: '2020-01-01T00:00:00Z',
    });
    // second run with a DIFFERENT timestamp: if idempotent, the file keeps the
    // original timestamp (never rewritten).
    await runSyncRules({
      quiet: true,
      outFile: out,
      now: '2099-12-31T00:00:00Z',
    });
    const content = readFileSync(out, 'utf-8');
    expect(content).toContain('2020-01-01T00:00:00Z');
    expect(content).not.toContain('2099-12-31T00:00:00Z');
  });

  test('--force rewrites even when content is unchanged', async () => {
    promptsFixture();
    const out = outFile();
    await runSyncRules({
      quiet: true,
      outFile: out,
      now: '2020-01-01T00:00:00Z',
    });
    await runSyncRules({
      quiet: true,
      outFile: out,
      now: '2099-12-31T00:00:00Z',
      force: true,
    });
    const content = readFileSync(out, 'utf-8');
    expect(content).toContain('2099-12-31T00:00:00Z');
  });
});
