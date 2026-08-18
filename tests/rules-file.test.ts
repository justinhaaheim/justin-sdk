/**
 * Tests for the rules-file stamp contract — the writer (sync-rules) and the
 * reader (SessionStart hook drift check) must agree, so round-trip it.
 */

import {describe, test, expect, afterEach} from 'bun:test';
import {chmodSync, existsSync, writeFileSync} from 'fs';
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
    expect(prettierMarkdown('# H\n\n\nx\n\n')).toEqual({
      markdown: '# H\n\n\nx',
      status: 'disabled',
    });
  });
});

// ---------------------------------------------------------------------------
// A FAILED prettier is not a formatted one (home-base-t6a0.21.1, rule 5)
// ---------------------------------------------------------------------------

/** Write an executable stub at <sandbox>/prettier and return its path. */
function stubBinary(sb: Sandbox, script: string): string {
  const bin = join(sb.path, 'prettier');
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  return bin;
}

describe('prettierMarkdown failure reporting', () => {
  const INPUT = '# H\n\nbody\n';

  test('a binary that EXITS NON-ZERO is reported, never silently unformatted', () => {
    delete process.env.JSDK_PRIME_PRETTIER;
    const sb = track(createSandbox());
    const bin = stubBinary(
      sb,
      '#!/bin/sh\necho "boom: cannot find module prettier" >&2\nexit 2\n',
    );

    const result = prettierMarkdown(INPUT, {binary: bin, filePath: '/x/r.md'});
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('unreachable');
    // Names the binary AND the captured stderr — the two things a reader needs
    // to act. Without them the old bare `catch` said nothing at all.
    expect(result.reason).toContain(bin);
    expect(result.reason).toContain('boom: cannot find module prettier');
    expect(result.reason).toContain('exit 2');
    // The failed member carries no markdown at all — the type is the guard.
    expect('markdown' in result).toBe(false);
  });

  test('NEGATIVE CONTROL: the same call with a WORKING binary formats', () => {
    delete process.env.JSDK_PRIME_PRETTIER;
    const sb = track(createSandbox());
    // Reads stdin, emits it with a marker — proves the failing arm above fails
    // because of the exit status, not because the harness cannot run a stub.
    const bin = stubBinary(sb, '#!/bin/sh\ncat\necho "STUB_RAN"\n');

    const result = prettierMarkdown(INPUT, {binary: bin, filePath: '/x/r.md'});
    expect(result.status).toBe('formatted');
    if (result.status === 'failed') throw new Error('unreachable');
    expect(result.markdown).toBe('# H\n\nbody\nSTUB_RAN');
  });

  test('a MISSING binary is reported (ENOENT), not treated as "nothing to do"', () => {
    delete process.env.JSDK_PRIME_PRETTIER;
    const result = prettierMarkdown(INPUT, {
      binary: '/no/such/prettier',
      filePath: '/x/r.md',
    });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('unreachable');
    expect(result.reason).toContain('/no/such/prettier');
    expect(result.reason).toContain('ENOENT');
  });

  test('exit 0 with EMPTY output is a failure, not empty rules', () => {
    delete process.env.JSDK_PRIME_PRETTIER;
    const sb = track(createSandbox());
    // The shape a swallow-stdin shim (or a killed child) produces: success
    // status, nothing on stdout. Accepting it would hash the empty string and
    // deploy an empty rules artifact.
    const bin = stubBinary(sb, '#!/bin/sh\ncat > /dev/null\nexit 0\n');

    const result = prettierMarkdown(INPUT, {binary: bin, filePath: '/x/r.md'});
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('unreachable');
    expect(result.reason).toContain('EMPTY output');
  });

  test('the stub is handed the artifact path via --stdin-filepath, and no file is written there', () => {
    delete process.env.JSDK_PRIME_PRETTIER;
    const sb = track(createSandbox());
    // Echo the args back so the exact invocation is observable.
    const bin = stubBinary(sb, '#!/bin/sh\ncat > /dev/null\necho "ARGS: $*"\n');
    const artifact = join(sb.path, 'repo/.claude/rules/justin-sdk/rules.md');

    const result = prettierMarkdown(INPUT, {binary: bin, filePath: artifact});
    if (result.status === 'failed') throw new Error(result.reason);
    expect(result.markdown).toBe(`ARGS: --ignore-path /dev/null --stdin-filepath ${artifact}`);
    // The read-only callers depend on this: naming the path must not create it.
    expect(existsSync(artifact)).toBe(false);
  });
});
