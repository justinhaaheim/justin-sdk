/**
 * WHICH SDK a sweep gate measures (dchjw.15 F2).
 *
 * The sweep's doctor gates and its `update` step used to spawn `bun run
 * justin-sdk …` inside the swept worktree. `bun run` prefers
 * `node_modules/.bin`, but with nothing there it falls through to PATH — and
 * this machine carries a `justin-sdk` PATH shim pointing at the orchestrator's
 * own checkout (dchjw.11 removes it, AFTER the sweep). So a worktree whose
 * `bun install` half-failed got gated against the WRONG SDK and reported green.
 *
 * The first test below is the HAZARD, reproduced against a real `bun run` with
 * a fake shim on PATH — it is the negative control for the fix, and it fails
 * loudly if bun ever stops doing this (at which point the guard is belt and
 * braces rather than load-bearing, and this file should say so).
 * The rest assert the guard: resolve by path, refuse by name.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {spawnSync} from 'child_process';
import {chmodSync, mkdirSync, symlinkSync, writeFileSync} from 'fs';
import {join} from 'path';

import {
  resolveWorktreeSdkBin,
  runSweepUpdate,
  worktreeSdkArgv,
} from '../src/sweep';
import {createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
function track(sb: Sandbox): Sandbox {
  sandboxes.push(sb);
  return sb;
}
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

/** A repo with a package.json and NO node_modules — a half-failed hydration. */
function unhydratedRepo(sb: Sandbox): string {
  sb.writeFile('package.json', JSON.stringify({name: 'fixture'}, null, 2));
  return sb.path;
}

/** A dir holding an executable `justin-sdk` that announces itself and exits 0. */
function shimDir(sb: Sandbox): string {
  const dir = join(sb.path, 'fake-path-bin');
  mkdirSync(dir, {recursive: true});
  const shim = join(dir, 'justin-sdk');
  writeFileSync(shim, '#!/bin/sh\necho "THE SHIM RAN"\nexit 0\n');
  chmodSync(shim, 0o755);
  return dir;
}

describe('the hazard this guard exists for', () => {
  test('`bun run justin-sdk` in an unhydrated repo runs a PATH shim and exits 0', () => {
    const sb = track(createSandbox());
    const repo = unhydratedRepo(sb);
    const child = spawnSync('bun', ['run', 'justin-sdk', 'doctor'], {
      cwd: repo,
      encoding: 'utf-8',
      env: {...process.env, PATH: `${shimDir(sb)}:${process.env.PATH ?? ''}`},
    });
    // Green, and it never touched this repo's SDK — because this repo has none.
    expect(child.status).toBe(0);
    expect(`${child.stdout}${child.stderr}`).toContain('THE SHIM RAN');
  });
});

describe('resolveWorktreeSdkBin', () => {
  test('absent bin → refusal naming the exact path it looked for', () => {
    const sb = track(createSandbox());
    const repo = unhydratedRepo(sb);
    const resolved = resolveWorktreeSdkBin(repo);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error('unreachable');
    expect(resolved.detail).toContain(
      join(repo, 'node_modules', '.bin', 'justin-sdk'),
    );
    // The refusal must say WHY falling back is not an option, not merely that
    // something is missing: the next reader's instinct is to add a fallback.
    expect(resolved.detail).toContain('bun run justin-sdk');
  });

  test('a DANGLING .bin symlink is absent, not present', () => {
    const sb = track(createSandbox());
    const repo = unhydratedRepo(sb);
    mkdirSync(join(repo, 'node_modules', '.bin'), {recursive: true});
    symlinkSync(
      join(repo, 'node_modules', 'nothing-here', 'cli.ts'),
      join(repo, 'node_modules', '.bin', 'justin-sdk'),
    );
    expect(resolveWorktreeSdkBin(repo).ok).toBe(false);
  });

  test('present bin → the absolute path, and argv leads with it', () => {
    const sb = track(createSandbox());
    const repo = unhydratedRepo(sb);
    const bin = join(repo, 'node_modules', '.bin', 'justin-sdk');
    mkdirSync(join(repo, 'node_modules', '.bin'), {recursive: true});
    writeFileSync(bin, '#!/bin/sh\nexit 0\n');
    chmodSync(bin, 0o755);

    const resolved = resolveWorktreeSdkBin(repo);
    expect(resolved).toEqual({ok: true, path: bin});
    expect(worktreeSdkArgv(bin, ['doctor', '--fix'])).toEqual([
      bin,
      'doctor',
      '--fix',
    ]);
    // Never the spelling that can resolve elsewhere.
    expect(worktreeSdkArgv(bin, ['doctor'])[0]).not.toBe('bun');
  });
});

describe('the full payload refuses rather than gating against the shim', () => {
  test('runSweepUpdate on an unhydrated worktree fails, naming the missing bin', () => {
    const sb = track(createSandbox());
    const repo = unhydratedRepo(sb);
    const outcome = runSweepUpdate(repo);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.detail).toContain(
      join(repo, 'node_modules', '.bin', 'justin-sdk'),
    );
    expect(outcome.detail).toContain('worktree left for inspection');
  });
});
