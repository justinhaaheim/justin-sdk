/**
 * Tests for the rules-file stamp contract — the writer (sync-rules) and the
 * reader (SessionStart hook drift check) must agree, so round-trip it.
 */

import {describe, test, expect, afterEach} from 'bun:test';
import {writeFileSync} from 'fs';
import {join} from 'path';

import {
  buildStamp,
  deployedIsDirty,
  deployedSourceSha,
  prettierEnabled,
  prettierMarkdown,
  readDeployedStamp,
} from '../src/plugin/lib/rules-file';
import {createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
function track(sb: Sandbox): Sandbox {
  sandboxes.push(sb);
  return sb;
}
const savedPrettier = process.env.JSDK_PRIME_PRETTIER;
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
  if (savedPrettier == null) delete process.env.JSDK_PRIME_PRETTIER;
  else process.env.JSDK_PRIME_PRETTIER = savedPrettier;
});

function writeStamped(commit: string): string {
  const sb = track(createSandbox());
  const file = join(sb.path, 'critical-rules.md');
  const stamp = buildStamp({
    version: '0.4.14',
    commit,
    contentHash: '84bf3e47bf75',
    generated: '2026-07-16T00:00:00Z',
  });
  writeFileSync(file, `${stamp}\n\n# Critical Rules\n\nbody\n`);
  return file;
}

describe('rules-file stamp round-trip', () => {
  test('buildStamp -> readDeployedStamp preserves version/commit/content', () => {
    const stamp = readDeployedStamp(writeStamped('cc6573bb0834'));
    expect(stamp).not.toBeNull();
    expect(stamp?.version).toBe('0.4.14');
    expect(stamp?.commit).toBe('cc6573bb0834');
    expect(stamp?.contentHash).toBe('84bf3e47bf75');
  });

  test('deployedSourceSha returns the 12-char sha, stripping -dirty', () => {
    expect(
      deployedSourceSha(readDeployedStamp(writeStamped('cc6573bb0834'))),
    ).toBe('cc6573bb0834');
    expect(
      deployedSourceSha(readDeployedStamp(writeStamped('cc6573bb0834-dirty'))),
    ).toBe('cc6573bb0834');
    expect(
      deployedSourceSha(readDeployedStamp(writeStamped('unknown'))),
    ).toBeNull();
  });

  test('a clean stamp is not flagged dirty; a -dirty stamp is', () => {
    expect(
      deployedIsDirty(readDeployedStamp(writeStamped('cc6573bb0834'))),
    ).toBe(false);
    expect(
      deployedIsDirty(readDeployedStamp(writeStamped('cc6573bb0834-dirty'))),
    ).toBe(true);
  });

  test('readDeployedStamp returns null for a missing file', () => {
    expect(readDeployedStamp('/no/such/file/critical-rules.md')).toBeNull();
  });

  test('readDeployedStamp returns null for an unstamped file', () => {
    const sb = track(createSandbox());
    const file = join(sb.path, 'x.md');
    writeFileSync(file, '# no stamp here\n');
    expect(readDeployedStamp(file)).toBeNull();
  });
});

describe('prettier toggle', () => {
  test('prettierEnabled defaults to true; env var disables it', () => {
    delete process.env.JSDK_PRIME_PRETTIER;
    expect(prettierEnabled()).toBe(true);
    for (const off of ['0', 'false', 'off', 'no', 'OFF']) {
      process.env.JSDK_PRIME_PRETTIER = off;
      expect(prettierEnabled()).toBe(false);
    }
    process.env.JSDK_PRIME_PRETTIER = '1';
    expect(prettierEnabled()).toBe(true);
  });

  test('prettierMarkdown is a trim-only no-op when disabled (no bunx call)', () => {
    process.env.JSDK_PRIME_PRETTIER = '0';
    expect(prettierMarkdown('# H\n\n\nx\n\n')).toBe('# H\n\n\nx');
  });
});
