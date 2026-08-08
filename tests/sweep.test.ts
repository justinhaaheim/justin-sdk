/**
 * Tests for the sweep's pure decision helpers + discovery. The full pipeline
 * is exercised live (the sweep's first real runs ARE its e2e — the ratchet
 * contract says failures get fixed in the SDK, so the live run is load-bearing
 * verification by design).
 */

import {describe, expect, test} from 'bun:test';
import {mkdirSync, writeFileSync} from 'fs';
import {join} from 'path';

import {
  defaultBranchOf,
  discoverSweepRepos,
  mergeSafety,
  parsePorcelainPaths,
} from '../src/sweep';
import {git, initRepo} from './git-fixtures';
import {createSandbox} from './sandbox';

describe('discoverSweepRepos', () => {
  test('finds direct children with justin-sdk.config.json, sorted; ignores everything else', () => {
    const sb = createSandbox();
    for (const name of ['b-enrolled', 'a-enrolled']) {
      mkdirSync(join(sb.path, name));
      writeFileSync(join(sb.path, name, 'justin-sdk.config.json'), '{}');
    }
    mkdirSync(join(sb.path, 'not-enrolled'));
    writeFileSync(join(sb.path, 'a-file'), 'not a dir');

    expect(discoverSweepRepos(sb.path)).toEqual([
      join(sb.path, 'a-enrolled'),
      join(sb.path, 'b-enrolled'),
    ]);
    sb.cleanup();
  });

  test('a missing root discovers nothing', () => {
    expect(discoverSweepRepos('/nonexistent/nowhere')).toEqual([]);
  });
});

describe('defaultBranchOf', () => {
  test('falls back to the local main branch when origin/HEAD is unset', () => {
    const sb = createSandbox();
    const repo = initRepo(sb, 'repo', {'a.txt': 'a\n'});
    expect(defaultBranchOf(repo)).toBe('main');
    sb.cleanup();
  });

  test('a repo with neither origin/HEAD nor main/master yields null', () => {
    const sb = createSandbox();
    const repo = initRepo(sb, 'repo', {'a.txt': 'a\n'});
    git(repo, ['branch', '-m', 'main', 'trunk']);
    expect(defaultBranchOf(repo)).toBeNull();
    sb.cleanup();
  });
});

describe('mergeSafety', () => {
  test('OK when primary is on the default branch and no overlap with dirty files', () => {
    expect(
      mergeSafety('main', 'main', ['src/wip.ts'], ['package.json']),
    ).toEqual({ok: true, reason: ''});
  });

  test('refuses when the primary is on another branch, naming it', () => {
    const result = mergeSafety('feature-x', 'main', [], ['package.json']);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('feature-x');
  });

  test('refuses on a detached HEAD', () => {
    const result = mergeSafety(null, 'main', [], ['package.json']);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('detached');
  });

  test('refuses when a sweep-changed file is dirty in the primary, naming the file', () => {
    const result = mergeSafety(
      'main',
      'main',
      ['package.json', 'src/wip.ts'],
      ['package.json', 'bun.lock'],
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('package.json');
    expect(result.reason).not.toContain('bun.lock');
  });
});

describe('parsePorcelainPaths', () => {
  test('plain modified/untracked entries', () => {
    expect(parsePorcelainPaths(' M a.ts\n?? b/c.json\n')).toEqual([
      'a.ts',
      'b/c.json',
    ]);
  });

  test('rename entries contribute BOTH sides', () => {
    expect(parsePorcelainPaths('R  old.ts -> new.ts\n')).toEqual([
      'old.ts',
      'new.ts',
    ]);
  });

  test('empty status → no paths', () => {
    expect(parsePorcelainPaths('')).toEqual([]);
  });
});
