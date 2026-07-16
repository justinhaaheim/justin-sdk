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
  readDeployedStamp,
} from '../src/plugin/lib/rules-file';
import {createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
function track(sb: Sandbox): Sandbox {
  sandboxes.push(sb);
  return sb;
}
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
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

  test('deployedSourceSha returns the 12-char sha', () => {
    const stamp = readDeployedStamp(writeStamped('cc6573bb0834'));
    expect(deployedSourceSha(stamp)).toBe('cc6573bb0834');
    expect(deployedIsDirty(stamp)).toBe(false);
  });

  test('a dirty stamp is detected and its -dirty suffix stripped for the sha', () => {
    const stamp = readDeployedStamp(writeStamped('cc6573bb0834-dirty'));
    expect(deployedIsDirty(stamp)).toBe(true);
    expect(deployedSourceSha(stamp)).toBe('cc6573bb0834');
  });

  test("an 'unknown' commit yields a null source sha", () => {
    const stamp = readDeployedStamp(writeStamped('unknown'));
    expect(deployedSourceSha(stamp)).toBeNull();
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
