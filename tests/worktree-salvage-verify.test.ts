/**
 * worktree-salvage `checkoutMatchesSave` (epic home-base-us739, fix round F2,
 * home-base-us739.6): the run-time re-check that a checkout still holds only
 * what its save holds. Every test saves the real fixture worktree, changes one
 * thing, and asserts the difference is named; the unchanged case is the
 * negative control for each.
 */

import type {Destination} from '../src/worktree-salvage/config';
import type {Manifest} from '../src/worktree-salvage/manifest';

import {afterEach, describe, expect, test} from 'bun:test';
import {execFileSync} from 'child_process';
import {
  appendFileSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import {join} from 'path';

import {saveCheckout} from '../src/worktree-salvage/save';
import {
  checkoutMatchesSave,
  MISMATCH_REASON_CAP,
} from '../src/worktree-salvage/verify';
import {createSandbox, type Sandbox} from './sandbox';
import {buildDirtyWorktree} from './worktree-salvage-fixtures';

const sandboxes: Sandbox[] = [];
function track(): Sandbox {
  const sb = createSandbox();
  sandboxes.push(sb);
  return sb;
}
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {cwd, encoding: 'utf-8', stdio: 'pipe'});
}

function flagDestination(dir: string): Destination {
  return {configFile: '/nonexistent/config.json', dir, source: 'flag'};
}

/** The fixture worktree, saved. */
function savedWorktree(): {manifest: Manifest; sb: Sandbox; worktree: string} {
  const sb = track();
  const {worktree} = buildDirtyWorktree(sb);
  const result = saveCheckout({
    checkout: worktree,
    destination: flagDestination(join(sb.path, 'out')),
    includeIgnored: false,
  });
  if (result.kind !== 'saved') throw new Error(`not saved: ${result.kind}`);
  return {manifest: result.manifest, sb, worktree};
}

function reasonsOf(manifest: Manifest, worktree: string): string[] {
  const verified = checkoutMatchesSave(manifest, worktree);
  if (!verified.ok) throw new Error(`could not verify: ${verified.error}`);
  return verified.value.matches ? [] : verified.value.reasons;
}

describe('checkoutMatchesSave (F2)', () => {
  test('negative control: the checkout as it was saved matches', () => {
    const {manifest, worktree} = savedWorktree();
    expect(checkoutMatchesSave(manifest, worktree)).toEqual({
      ok: true,
      value: {matches: true},
    });
  });

  test('a saved file appended to after the save is named', () => {
    const {manifest, worktree} = savedWorktree();
    appendFileSync(join(worktree, 'mod.txt'), 'written later\n');
    expect(reasonsOf(manifest, worktree)).toEqual([
      'mod.txt: its content changed since the save',
    ]);
  });

  test('a new untracked file is named', () => {
    const {manifest, worktree} = savedWorktree();
    writeFileSync(join(worktree, 'later.txt'), 'added after the save\n');
    expect(reasonsOf(manifest, worktree)).toEqual([
      'later.txt (??) is new since the save, so the save does not hold it',
    ]);
  });

  test('a saved file no longer changed is named', () => {
    const {manifest, worktree} = savedWorktree();
    writeFileSync(join(worktree, 'mod.txt'), 'original\n');
    expect(reasonsOf(manifest, worktree)).toEqual([
      'mod.txt (.M at the save) no longer shows as changed, so the checkout is not what was saved',
      'mod.txt: its content changed since the save',
    ]);
  });

  test('a symlink pointed elsewhere is named', () => {
    const {manifest, worktree} = savedWorktree();
    rmSync(join(worktree, 'type.txt'));
    symlinkSync('exec.sh', join(worktree, 'type.txt'));
    expect(reasonsOf(manifest, worktree)).toEqual([
      'type.txt: the symlink points elsewhere than when it was saved',
    ]);
  });

  test('a saved file now unreadable is a difference, never a match', () => {
    const {manifest, worktree} = savedWorktree();
    rmSync(join(worktree, 'untracked.txt'));
    mkdirSync(join(worktree, 'untracked.txt'));
    writeFileSync(join(worktree, 'untracked.txt', 'inside'), 'x');
    const reasons = reasonsOf(manifest, worktree);
    expect(
      reasons.some((reason) =>
        reason.startsWith(
          'untracked.txt: could not read it to compare it with the save',
        ),
      ),
    ).toBe(true);
  });

  test('HEAD moved, with the same tree, is named and nothing else', () => {
    const {manifest, worktree} = savedWorktree();
    const tree = git(worktree, ['rev-parse', `${manifest.head}^{tree}`]).trim();
    const commit = git(worktree, [
      'commit-tree',
      tree,
      '-p',
      manifest.head,
      '-m',
      'later',
    ]).trim();
    git(worktree, ['update-ref', 'refs/heads/feature', commit]);
    expect(reasonsOf(manifest, worktree)).toEqual([
      `HEAD moved since the save (${manifest.head.slice(0, 12)} → ${commit.slice(0, 12)})`,
    ]);
  });

  test(`more than ${MISMATCH_REASON_CAP} differences are capped, with the rest counted`, () => {
    const {manifest, worktree} = savedWorktree();
    for (let index = 0; index < MISMATCH_REASON_CAP + 5; index += 1) {
      writeFileSync(join(worktree, `later-${String(index)}.txt`), 'x');
    }
    const reasons = reasonsOf(manifest, worktree);
    expect(reasons).toHaveLength(MISMATCH_REASON_CAP + 1);
    expect(reasons[MISMATCH_REASON_CAP]).toBe('and 5 more differences');
  });

  test('a directory that is not a checkout cannot be verified: a failure, never a match', () => {
    const {manifest, sb} = savedWorktree();
    const elsewhere = join(sb.path, 'not-a-checkout');
    mkdirSync(elsewhere);
    const verified = checkoutMatchesSave(manifest, elsewhere);
    expect(verified.ok).toBe(false);
  });

  test('the save of another checkout does not match this one', () => {
    const {manifest, sb, worktree} = savedWorktree();
    const other = {...manifest, worktreePath: join(sb.path, 'primary')};
    expect(reasonsOf(other, worktree)).toEqual([
      `the save is of ${join(sb.path, 'primary')}, not of ${worktree}`,
    ]);
  });
});
