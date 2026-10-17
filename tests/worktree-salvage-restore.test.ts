/**
 * worktree-salvage restore (epic home-base-us739, D7; dispatch 2,
 * home-base-us739.2, AC 1 and AC 2).
 *
 * Each test saves dispatch 1's fixture worktree (plus the index-only changes),
 * clones the fixture repo fresh at the save's base commit, and restores into
 * the clone. Everything lives in the test's own sandbox.
 */

import type {Destination} from '../src/worktree-salvage/config';
import type {Manifest} from '../src/worktree-salvage/manifest';

import {afterEach, describe, expect, test} from 'bun:test';
import {execFileSync} from 'child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import {join} from 'path';

import {FILES_DIR, MANIFEST_FILE} from '../src/worktree-salvage/manifest';
import {
  type RestoreResult,
  restoreSave,
  runRestoreCommand,
} from '../src/worktree-salvage/restore';
import {saveCheckout} from '../src/worktree-salvage/save';
import {git} from './git-fixtures';
import {createSandbox, type Sandbox} from './sandbox';
import {
  addIndexOnlyChanges,
  buildDirtyWorktree,
  captureIo,
} from './worktree-salvage-fixtures';

const sandboxes: Sandbox[] = [];
function track(): Sandbox {
  const sb = createSandbox();
  sandboxes.push(sb);
  return sb;
}
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

function flagDestination(dir: string): Destination {
  return {configFile: '/nonexistent/config.json', dir, source: 'flag'};
}

interface Saved {
  fresh: string;
  manifest: Manifest;
  primary: string;
  sb: Sandbox;
  stampDir: string;
  worktree: string;
}

/** Save the fixture worktree and clone the repo fresh at the save's base commit. */
function savedAndFresh(): Saved {
  const sb = track();
  const {primary, worktree} = buildDirtyWorktree(sb);
  addIndexOnlyChanges(worktree);
  const result = saveCheckout({
    checkout: worktree,
    destination: flagDestination(join(sb.path, 'out')),
    includeIgnored: false,
  });
  if (result.kind !== 'saved') throw new Error(`save failed: ${result.kind}`);
  const fresh = join(sb.path, 'fresh');
  git(sb.path, ['clone', '-q', primary, fresh]);
  // The clone must not see the host's global gitignore either (git-fixtures.ts).
  git(fresh, [
    'config',
    'core.excludesFile',
    git(primary, ['config', 'core.excludesFile']).trim(),
  ]);
  git(fresh, ['checkout', '-q', '--detach', result.manifest.head]);
  return {
    fresh,
    manifest: result.manifest,
    primary,
    sb,
    stampDir: result.stampDir,
    worktree,
  };
}

function expectRestored(
  result: RestoreResult,
): Extract<RestoreResult, {kind: 'restored'}> {
  if (result.kind !== 'restored') {
    throw new Error(
      `expected a restore, got ${result.kind}: ${result.reason} ${result.kind === 'refused' ? result.problems.join('; ') : ''}`,
    );
  }
  return result;
}

function expectRefused(
  result: RestoreResult,
): Extract<RestoreResult, {kind: 'refused'}> {
  if (result.kind !== 'refused') {
    throw new Error(`expected a refusal, got ${result.kind}`);
  }
  return result;
}

/**
 * The tree `git add -A` would make of this checkout's files, built in a
 * THROWAWAY index so neither checkout's real index is touched. Equal trees mean
 * every path, byte, mode and symlink matches. `nested/` is excluded: it is a
 * nested checkout, which a save records and never enters (D2).
 */
function worktreeTree(sb: Sandbox, cwd: string, name: string): string {
  const env = {...process.env, GIT_INDEX_FILE: join(sb.path, `${name}.index`)};
  const run = (args: string[]): string =>
    execFileSync('git', args, {cwd, encoding: 'utf-8', env});
  run(['read-tree', 'HEAD']);
  run(['add', '-A', '--', '.', ':(exclude)nested']);
  return run(['write-tree']).trim();
}

/** Bytes, or a symlink's target, of every path the manifest copied. */
function snapshot(root: string, manifest: Manifest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of manifest.entries.filter((e) => e.copied)) {
    const abs = join(root, entry.path);
    const stat = lstatSync(abs);
    out[entry.path] = stat.isSymbolicLink()
      ? `symlink:${readlinkSync(abs)}`
      : `${(stat.mode & 0o777).toString(8)}:${readFileSync(abs).toString('base64')}`;
  }
  return out;
}

const RECORDED_DELETIONS = [
  'del-staged.txt',
  'del-wt.txt',
  'ren-src.txt',
  'staged-then-deleted.bin',
  'touched.txt',
];

describe('restore: round trip (D7, AC 1)', () => {
  test('a save goes back into a fresh checkout byte for byte, and the tree equals the original worktree', () => {
    const {fresh, manifest, sb, stampDir, worktree} = savedAndFresh();
    expect(worktreeTree(sb, fresh, 'fresh-before')).not.toBe(
      worktreeTree(sb, worktree, 'original'),
    );

    const restored = expectRestored(
      restoreSave({
        applyDeletions: true,
        into: fresh,
        overwrite: false,
        stampDir,
      }),
    );

    expect(snapshot(fresh, manifest)).toEqual(snapshot(worktree, manifest));
    expect(worktreeTree(sb, fresh, 'fresh')).toBe(
      worktreeTree(sb, worktree, 'original'),
    );
    for (const path of RECORDED_DELETIONS)
      expect(existsSync(join(fresh, path))).toBe(false);

    // Every modified tracked file existed in its base version: replaced
    // because git still has it, without --overwrite.
    expect(restored.replaced.map((item) => item.why)).not.toContain(
      'overwrite',
    );
    expect(restored.replaced.map((item) => item.path).sort()).toEqual(
      [
        'conflict.txt',
        'dir with space/file one.txt',
        'exec.sh',
        'mod.txt',
        'type.txt',
      ].sort(),
    );
    expect(restored.deletedAlready).toEqual(['staged-then-deleted.bin']);
    expect(restored.headWarning).toBeNull();
    expect(restored.indexFiles).toBe(6);
  });

  test('without --apply-deletions, recorded deletions are listed and left in place', () => {
    const {fresh, stampDir} = savedAndFresh();
    const restored = expectRestored(
      restoreSave({
        applyDeletions: false,
        into: fresh,
        overwrite: false,
        stampDir,
      }),
    );
    expect([...restored.deletionsNotApplied].sort()).toEqual(
      RECORDED_DELETIONS,
    );
    expect(restored.deleted).toEqual([]);
    expect(readFileSync(join(fresh, 'del-wt.txt'), 'utf-8')).toBe(
      'deleted in the worktree\n',
    );
    expect(existsSync(join(fresh, 'ren-src.txt'))).toBe(true);
  });

  test('a second restore finds every file already holding the saved bytes', () => {
    const {fresh, stampDir} = savedAndFresh();
    const options = {
      applyDeletions: true,
      into: fresh,
      overwrite: false,
      stampDir,
    };
    expectRestored(restoreSave(options));
    const again = expectRestored(restoreSave(options));
    expect(again.written).toEqual([]);
    expect(again.replaced).toEqual([]);
    expect(again.unchanged.length).toBeGreaterThan(0);
  });

  test('a target at another commit restores, with a HEAD warning', () => {
    const {fresh, primary, stampDir} = savedAndFresh();
    git(fresh, [
      'checkout',
      '-q',
      '--detach',
      git(primary, ['rev-parse', 'main']).trim(),
    ]);
    const restored = expectRestored(
      restoreSave({
        applyDeletions: false,
        into: fresh,
        overwrite: false,
        stampDir,
      }),
    );
    expect(restored.headWarning).toContain('but the save was made against');
  });
});

describe('restore: refusals (D7, AC 2)', () => {
  test('an existing untracked file is refused without --overwrite, and replaced with it', () => {
    const {fresh, stampDir} = savedAndFresh();
    writeFileSync(join(fresh, 'untracked.txt'), 'the target’s own work\n');
    const refusal = expectRefused(
      restoreSave({
        applyDeletions: false,
        into: fresh,
        overwrite: false,
        stampDir,
      }),
    );
    expect(refusal.problems).toEqual([
      'untracked.txt exists in the target and git does not track it',
    ]);
    // Nothing was written: a modified file of the save is still the base version.
    expect(readFileSync(join(fresh, 'mod.txt'), 'utf-8')).toBe('original\n');
    expect(readFileSync(join(fresh, 'untracked.txt'), 'utf-8')).toBe(
      'the target’s own work\n',
    );

    const restored = expectRestored(
      restoreSave({
        applyDeletions: false,
        into: fresh,
        overwrite: true,
        stampDir,
      }),
    );
    expect(restored.replaced).toContainEqual({
      path: 'untracked.txt',
      why: 'overwrite',
    });
    expect(readFileSync(join(fresh, 'untracked.txt'), 'utf-8')).toBe(
      'untracked\n',
    );
  });

  test('a tracked file with changes of its own in the target is refused without --overwrite', () => {
    const {fresh, stampDir} = savedAndFresh();
    writeFileSync(join(fresh, 'mod.txt'), 'edited in the target\n');
    const refusal = expectRefused(
      restoreSave({
        applyDeletions: false,
        into: fresh,
        overwrite: false,
        stampDir,
      }),
    );
    expect(refusal.problems).toEqual([
      'mod.txt has changes of its own in the target',
    ]);
    expect(readFileSync(join(fresh, 'mod.txt'), 'utf-8')).toBe(
      'edited in the target\n',
    );
  });

  test('--apply-deletions refuses to remove a file with changes of its own', () => {
    const {fresh, stampDir} = savedAndFresh();
    writeFileSync(join(fresh, 'del-wt.txt'), 'edited in the target\n');
    const refusal = expectRefused(
      restoreSave({
        applyDeletions: true,
        into: fresh,
        overwrite: false,
        stampDir,
      }),
    );
    expect(refusal.problems).toEqual([
      'del-wt.txt has changes of its own in the target',
    ]);
    expect(existsSync(join(fresh, 'del-wt.txt'))).toBe(true);
  });

  test('a stamp directory with no manifest is refused, and so is a .failed save', () => {
    const {fresh, stampDir} = savedAndFresh();
    renameSync(
      join(stampDir, MANIFEST_FILE),
      join(stampDir, 'moved-away.json'),
    );
    const refusal = expectRefused(
      restoreSave({
        applyDeletions: false,
        into: fresh,
        overwrite: false,
        stampDir,
      }),
    );
    expect(refusal.reason).toContain('is not a complete save');
    expect(readFileSync(join(fresh, 'mod.txt'), 'utf-8')).toBe('original\n');

    renameSync(
      join(stampDir, 'moved-away.json'),
      join(stampDir, MANIFEST_FILE),
    );
    const failedDir = `${stampDir}.failed`;
    renameSync(stampDir, failedDir);
    expect(
      expectRefused(
        restoreSave({
          applyDeletions: false,
          into: fresh,
          overwrite: false,
          stampDir: failedDir,
        }),
      ).reason,
    ).toContain('is a FAILED save');
  });

  test('a target that is not a git checkout is refused, and nothing is written there', () => {
    const {sb, stampDir} = savedAndFresh();
    const plain = join(sb.path, 'plain');
    mkdirSync(plain);
    const refusal = expectRefused(
      restoreSave({
        applyDeletions: false,
        into: plain,
        overwrite: false,
        stampDir,
      }),
    );
    expect(refusal.reason).toContain('is not a git checkout');
    expect(existsSync(join(plain, 'mod.txt'))).toBe(false);
  });

  test('an archive file whose sha256 no longer matches the manifest refuses the whole restore', () => {
    const {fresh, stampDir} = savedAndFresh();
    writeFileSync(join(stampDir, FILES_DIR, 'untracked.txt'), 'tampered\n');
    const refusal = expectRefused(
      restoreSave({
        applyDeletions: false,
        into: fresh,
        overwrite: false,
        stampDir,
      }),
    );
    expect(refusal.problems).toHaveLength(1);
    expect(refusal.problems[0]).toContain(
      `${FILES_DIR}/untracked.txt no longer matches the manifest`,
    );
    expect(existsSync(join(fresh, 'untracked.txt'))).toBe(false);
    expect(readFileSync(join(fresh, 'mod.txt'), 'utf-8')).toBe('original\n');
  });

  test('a symlinked directory in the target is never written through', () => {
    const {fresh, sb, stampDir} = savedAndFresh();
    const elsewhere = join(sb.path, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(fresh, 'deep'));
    const refusal = expectRefused(
      restoreSave({
        applyDeletions: false,
        into: fresh,
        overwrite: true,
        stampDir,
      }),
    );
    expect(refusal.problems[0]).toContain(
      'is a symlink, and restore never writes through one',
    );
    expect(existsSync(join(elsewhere, 'nested'))).toBe(false);
  });

  test('a written file that does not verify fails the restore and names what changed', () => {
    const {fresh, stampDir} = savedAndFresh();
    const result = restoreSave({
      applyDeletions: false,
      into: fresh,
      overwrite: false,
      seams: {
        afterWrite: ({dest, path}) => {
          if (path === 'mod.txt')
            writeFileSync(dest, 'corrupted after the write\n');
        },
      },
      stampDir,
    });
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.reason).toContain('mod.txt: sha256 of the restored file');
    expect(result.changed).not.toContain('mod.txt');
  });
});

describe('restore command', () => {
  test('exit 0 when restored, 1 when refused, with the reason on stderr', async () => {
    const {fresh, sb, stampDir} = savedAndFresh();
    const ok = captureIo(sb.path);
    expect(
      await runRestoreCommand(
        {applyDeletions: false, into: fresh, overwrite: false, stampDir},
        ok.io,
      ),
    ).toBe(0);
    expect(ok.out.join('')).toContain('NOT restored');
    expect(ok.out.join('')).toContain('recorded deletions NOT applied');

    const plain = join(sb.path, 'plain');
    mkdirSync(plain);
    const no = captureIo(sb.path);
    expect(
      await runRestoreCommand(
        {applyDeletions: false, into: plain, overwrite: false, stampDir},
        no.io,
      ),
    ).toBe(1);
    expect(no.err.join('')).toContain('REFUSED: nothing was written');
    expect(no.out).toEqual([]);
  });
});
