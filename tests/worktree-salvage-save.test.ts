/**
 * worktree-salvage save (epic home-base-us739, dispatch 1: D2, D3, D5, D6).
 *
 * Every test runs against a real repo and linked worktree built by
 * buildDirtyWorktree, and saves to a directory inside the test's own sandbox
 * (`--out`), so nothing outside $TMPDIR is ever touched.
 */

import type {Destination} from '../src/worktree-salvage/config';
import type {Manifest} from '../src/worktree-salvage/manifest';

import {afterEach, describe, expect, test} from 'bun:test';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from 'fs';
import {join} from 'path';

import {PLAIN_STYLE} from '../src/cli-style';
import {getSdkVersion} from '../src/sdk-identity';
import {
  FAILED_SUFFIX,
  FAILURE_FILE,
  MANIFEST_FILE,
  ManifestSchema,
  readManifest,
} from '../src/worktree-salvage/manifest';
import {
  formatBytes,
  renderSaveResult,
  runSaveCommand,
  saveCheckout,
  type SaveResult,
} from '../src/worktree-salvage/save';
import {git} from './git-fixtures';
import {createSandbox, type Sandbox} from './sandbox';
import {
  BINARY_BYTES,
  buildDirtyWorktree,
  captureIo,
  readOnlyStatus,
} from './worktree-salvage-fixtures';

const sandboxes: Sandbox[] = [];
const restoreModes: {mode: number; path: string}[] = [];

function track(): Sandbox {
  const sb = createSandbox();
  sandboxes.push(sb);
  return sb;
}

afterEach(() => {
  while (restoreModes.length > 0) {
    const item = restoreModes.pop();
    if (item != null) chmodSync(item.path, item.mode);
  }
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

function flagDestination(dir: string): Destination {
  return {configFile: '/nonexistent/config.json', dir, source: 'flag'};
}

function expectSaved(result: SaveResult): Extract<SaveResult, {kind: 'saved'}> {
  if (result.kind !== 'saved') {
    throw new Error(
      `expected a save, got ${result.kind}: ${result.kind === 'failed' ? result.reason : ''}`,
    );
  }
  return result;
}

function expectFailed(
  result: SaveResult,
): Extract<SaveResult, {kind: 'failed'}> {
  if (result.kind !== 'failed') {
    throw new Error(`expected a failure, got ${result.kind}`);
  }
  return result;
}

function entryByPath(manifest: Manifest, path: string) {
  const entry = manifest.entries.find((candidate) => candidate.path === path);
  if (entry == null) throw new Error(`no manifest entry for ${path}`);
  return entry;
}

/** Every stamp directory name under `<out>/primary/feature`. */
function stampDirs(out: string): string[] {
  const parent = join(out, 'primary', 'feature');
  return existsSync(parent) ? readdirSync(parent).sort() : [];
}

describe('save: what is copied and recorded (D2, D3, AC 1)', () => {
  test('copies every changed and untracked file, records deletions, writes the patch and the manifest', () => {
    const sb = track();
    const {primary, worktree} = buildDirtyWorktree(sb);
    const out = join(sb.path, 'out');
    const saved = expectSaved(
      saveCheckout({
        checkout: worktree,
        destination: flagDestination(out),
        includeIgnored: false,
      }),
    );
    const {manifest, stampDir} = saved;

    // Layout: <outDir>/<repo>/<worktree>/<stamp>/
    expect(stampDir.startsWith(join(out, 'primary', 'feature'))).toBe(true);
    expect(manifest.stamp).toBe(stampDir.slice(stampDir.lastIndexOf('/') + 1));

    // The manifest on disk is the one returned, and it validates.
    const onDisk = readManifest(stampDir);
    if (!onDisk.ok) throw new Error(onDisk.error);
    expect(onDisk.value).toEqual(manifest);
    expect(ManifestSchema.safeParse(manifest).success).toBe(true);

    const copiedPaths = manifest.entries
      .filter((entry) => entry.copied)
      .map((entry) => entry.path)
      .sort();
    expect(copiedPaths).toEqual([
      'added.txt',
      'conflict.txt',
      'deep/nested/u.bin',
      'dir with space/new file.txt',
      'exec.sh',
      'link-to-mod',
      'mod.txt',
      'ren-dst.txt',
      'type.txt',
      'untracked.txt',
    ]);

    // Kinds and status letters, one per D2 category.
    const kinds = Object.fromEntries(
      manifest.entries.map((entry) => [entry.path, [entry.kind, entry.status]]),
    );
    expect(kinds).toEqual({
      'added.txt': ['added', 'A.'],
      'conflict.txt': ['unmerged', 'UU'],
      'deep/nested/u.bin': ['untracked', '??'],
      'del-staged.txt': ['deleted', 'D.'],
      'del-wt.txt': ['deleted', '.D'],
      'dir with space/new file.txt': ['untracked', '??'],
      'exec.sh': ['modified', '.M'],
      'link-to-mod': ['untracked', '??'],
      'mod.txt': ['modified', '.M'],
      'ren-dst.txt': ['renamed', 'R.'],
      'type.txt': ['type-changed', '.T'],
      'untracked.txt': ['untracked', '??'],
    });
    expect(entryByPath(manifest, 'ren-dst.txt').origPath).toBe('ren-src.txt');

    // Copied bytes are the source's bytes; sha256 and size recorded.
    for (const entry of manifest.entries.filter(
      (candidate) => candidate.copied && candidate.symlinkTarget == null,
    )) {
      const source = readFileSync(join(worktree, entry.path));
      const copy = readFileSync(join(stampDir, 'files', entry.path));
      expect(copy.equals(source)).toBe(true);
      expect(entry.bytes).toBe(source.length);
      expect(entry.sha256).toBe(
        new Bun.CryptoHasher('sha256').update(source).digest('hex'),
      );
    }
    expect(
      readFileSync(join(stampDir, 'files', 'deep/nested/u.bin')).equals(
        BINARY_BYTES,
      ),
    ).toBe(true);

    // Symlinks are copied as symlinks, never followed.
    for (const link of ['link-to-mod', 'type.txt']) {
      const copy = join(stampDir, 'files', link);
      expect(lstatSync(copy).isSymbolicLink()).toBe(true);
      expect(readlinkSync(copy)).toBe('mod.txt');
      expect(entryByPath(manifest, link).symlinkTarget).toBe('mod.txt');
    }

    // Mode preserved.
    expect(statSync(join(stampDir, 'files', 'exec.sh')).mode & 0o777).toBe(
      0o755,
    );
    expect(entryByPath(manifest, 'exec.sh').mode).toBe('0755');

    // Deletions: recorded with HEAD's blob, not copied.
    for (const deleted of ['del-staged.txt', 'del-wt.txt']) {
      const entry = entryByPath(manifest, deleted);
      expect(entry.copied).toBe(false);
      expect(entry.bytes).toBeNull();
      expect(entry.headBlob).toBe(
        git(worktree, ['rev-parse', `HEAD:${deleted}`]).trim(),
      );
      expect(existsSync(join(stampDir, 'files', deleted))).toBe(false);
    }

    // The patch is `git diff HEAD`.
    const patch = readFileSync(join(stampDir, 'changes.patch'), 'utf-8');
    expect(patch).toContain('+modified');
    expect(patch).toContain('del-wt.txt');
    expect(manifest.patch.bytes).toBe(Buffer.byteLength(patch, 'utf-8'));

    // D3, field for field.
    expect(manifest.tool).toBe('worktree-salvage');
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.repoRoot).toBe(primary);
    expect(manifest.repoName).toBe('primary');
    expect(manifest.worktreePath).toBe(worktree);
    expect(manifest.worktreeName).toBe('feature');
    expect(manifest.branch).toBe('feature');
    expect(manifest.head).toBe(git(worktree, ['rev-parse', 'HEAD']).trim());
    expect(manifest.upstream).toEqual({ok: true, value: null});
    expect(manifest.sdkVersion).toBe(getSdkVersion());
    expect(manifest.destination).toEqual({
      configFile: '/nonexistent/config.json',
      dir: out,
      source: 'flag',
    });
    const commits = manifest.commitsNotOnDefault;
    if (!commits.ok) throw new Error(commits.error);
    expect(commits.value.defaultBranch).toBe('main');
    expect(commits.value.total).toBe(1);
    expect(commits.value.commits.map((commit) => commit.subject)).toEqual([
      'feature change',
    ]);
    expect(manifest.totals).toEqual({
      bytes: manifest.entries.reduce(
        (sum, entry) => sum + (entry.bytes ?? 0),
        0,
      ),
      deletions: 2,
      files: 10,
    });

    // Nested checkouts: recorded, not entered.
    expect(manifest.nestedCheckouts).toEqual([
      {
        foundIn: 'status',
        kind: 'nested-repository',
        path: 'nested',
        submoduleState: null,
      },
      {
        foundIn: 'ignored',
        kind: 'nested-repository',
        path: 'tmp/inner-repo',
        submoduleState: null,
      },
    ]);
    expect(existsSync(join(stampDir, 'files', 'nested'))).toBe(false);

    // manifest.json is written last: nothing in the save is newer than it.
    const manifestTime = statSync(join(stampDir, MANIFEST_FILE), {
      bigint: true,
    }).mtimeNs;
    const patchTime = statSync(join(stampDir, 'changes.patch'), {
      bigint: true,
    }).mtimeNs;
    expect(manifestTime >= patchTime).toBe(true);
  });

  test('a clean checkout has nothing to save and writes nothing', () => {
    const sb = track();
    const {primary} = buildDirtyWorktree(sb);
    const out = join(sb.path, 'out');
    // The primary is clean apart from nothing at all.
    const result = saveCheckout({
      checkout: primary,
      destination: flagDestination(out),
      includeIgnored: false,
    });
    expect(result.kind).toBe('nothing-to-save');
    expect(existsSync(out)).toBe(false);
  });
});

describe('save: ignored paths are listed, never silent (D2, AC 2)', () => {
  test('without --ignored: listed with file counts and bytes, not copied', () => {
    const sb = track();
    const {worktree} = buildDirtyWorktree(sb);
    const out = join(sb.path, 'out');
    const {manifest, stampDir} = expectSaved(
      saveCheckout({
        checkout: worktree,
        destination: flagDestination(out),
        includeIgnored: false,
      }),
    );
    expect(manifest.ignored.copied).toBe(false);
    expect(manifest.ignored.paths).toEqual([
      // tmp/ excludes tmp/node_modules (skipped) and tmp/inner-repo (nested).
      {
        path: 'tmp/',
        saved: false,
        size: {ok: true, value: {bytes: 150, files: 2}},
      },
      {
        path: 'x.log',
        saved: false,
        size: {ok: true, value: {bytes: 9, files: 1}},
      },
    ]);
    expect(manifest.ignored.skipped).toEqual([
      {
        path: 'node_modules/',
        reason: 'node_modules',
        size: {ok: true, value: {bytes: 20, files: 1}},
      },
      {
        path: 'tmp/node_modules/',
        reason: 'node_modules',
        size: {ok: true, value: {bytes: 30, files: 1}},
      },
    ]);
    expect(existsSync(join(stampDir, 'files', 'tmp'))).toBe(false);
    expect(existsSync(join(stampDir, 'files', 'x.log'))).toBe(false);

    const printed = renderSaveResult(
      expectSaved(
        saveCheckout({
          checkout: worktree,
          destination: flagDestination(out),
          includeIgnored: false,
        }),
      ),
      PLAIN_STYLE,
    );
    expect(printed).toContain('Not saved');
    expect(printed).toContain(
      'tmp/\n          150 bytes, 2 files: ignored by git; --ignored copies it',
    );
    expect(printed).toContain(
      'node_modules/\n          20 bytes, 1 file: node_modules is never copied, even with --ignored',
    );
    expect(printed).toContain(
      'nested/\n          a nested checkout: not entered',
    );
  });

  test('with --ignored: ignored files are copied, node_modules and nested checkouts still are not, and the skip is printed', () => {
    const sb = track();
    const {worktree} = buildDirtyWorktree(sb);
    const out = join(sb.path, 'out');
    const result = expectSaved(
      saveCheckout({
        checkout: worktree,
        destination: flagDestination(out),
        includeIgnored: true,
      }),
    );
    const {manifest, stampDir} = result;
    expect(manifest.ignored.copied).toBe(true);
    for (const path of ['tmp/a.txt', 'tmp/sub/b.txt', 'x.log']) {
      expect(readFileSync(join(stampDir, 'files', path), 'utf-8')).toBe(
        readFileSync(join(worktree, path), 'utf-8'),
      );
      expect(entryByPath(manifest, path).kind).toBe('ignored');
      expect(entryByPath(manifest, path).status).toBe('!!');
    }
    for (const path of ['node_modules', 'tmp/node_modules', 'tmp/inner-repo']) {
      expect(existsSync(join(stampDir, 'files', path))).toBe(false);
    }
    const printed = renderSaveResult(result, PLAIN_STYLE);
    expect(printed).not.toContain('--ignored copies it');
    expect(printed).toContain(
      'tmp/node_modules/\n          30 bytes, 1 file: node_modules is never copied, even with --ignored',
    );
  });

  test('an ignored directory that cannot be read is UNKNOWN, never 0; --ignored refuses it', () => {
    const sb = track();
    const {worktree} = buildDirtyWorktree(sb);
    const locked = join(worktree, 'tmp', 'sub');
    restoreModes.push({mode: 0o755, path: locked});
    chmodSync(locked, 0o000);
    const out = join(sb.path, 'out');

    const listed = expectSaved(
      saveCheckout({
        checkout: worktree,
        destination: flagDestination(out),
        includeIgnored: false,
      }),
    );
    const tmp = listed.manifest.ignored.paths.find(
      (path) => path.path === 'tmp/',
    );
    expect(tmp?.size.ok).toBe(false);
    expect(renderSaveResult(listed, PLAIN_STYLE)).toContain('size UNKNOWN');

    const refused = expectFailed(
      saveCheckout({
        checkout: worktree,
        destination: flagDestination(join(sb.path, 'out2')),
        includeIgnored: true,
      }),
    );
    expect(refused.reason).toContain('--ignored cannot save tmp/');
    expect(existsSync(join(sb.path, 'out2'))).toBe(false);
  });
});

describe('save: the printout (AC 3)', () => {
  test('sizes read the way Finder counts them', () => {
    expect(formatBytes(0)).toBe('0 bytes');
    expect(formatBytes(1)).toBe('1 byte');
    expect(formatBytes(999)).toBe('999 bytes');
    expect(formatBytes(1_234_567)).toBe('1.2 MB');
    expect(formatBytes(674_000_000)).toBe('674 MB');
  });

  test('names the destination and its source, the file count, bytes, branch and base commit', async () => {
    const sb = track();
    const {worktree} = buildDirtyWorktree(sb);
    const out = join(sb.path, 'out');
    const capture = captureIo(sb.path);
    const code = await runSaveCommand(
      {checkout: worktree, includeIgnored: false, out},
      capture.io,
    );
    expect(code).toBe(0);
    const printed = capture.out.join('');
    const head = git(worktree, ['rev-parse', 'HEAD']).trim();
    expect(printed).toContain(`destination:  ${out}`);
    expect(printed).toContain('from:         --out, for this run only');
    expect(printed).toContain('files:        10 files copied');
    expect(printed).toContain('deletions:    2 deletions recorded');
    expect(printed).toMatch(/bytes:\s+\d+ bytes\n/u);
    expect(printed).toContain('branch:       feature');
    expect(printed).toContain(`base commit:  ${head.slice(0, 12)}`);
  });

  test('the fallback destination is marked NOT BACKED UP', async () => {
    const sb = track();
    const {worktree} = buildDirtyWorktree(sb);
    const capture = captureIo(sb.path, {
      XDG_CONFIG_HOME: join(sb.path, 'config-home'),
      XDG_DATA_HOME: join(sb.path, 'data-home'),
    });
    const code = await runSaveCommand(
      {checkout: worktree, includeIgnored: false, out: null},
      capture.io,
    );
    expect(code).toBe(0);
    const printed = capture.out.join('');
    expect(printed).toContain(
      `destination:  ${join(sb.path, 'data-home', 'worktree-salvage')}`,
    );
    expect(printed).toContain(
      `from:         fallback, NOT BACKED UP: no config at ${join(sb.path, 'config-home', 'worktree-salvage', 'config.json')}`,
    );
  });
});

describe('save: a partial save never reports success (D5, AC 4)', () => {
  test('a status change between the two reads fails the save and leaves <stamp>.failed with no manifest', async () => {
    const sb = track();
    const {worktree} = buildDirtyWorktree(sb);
    const out = join(sb.path, 'out');
    const capture = captureIo(sb.path);
    const code = await runSaveCommand(
      {
        checkout: worktree,
        includeIgnored: false,
        out,
        seams: {
          beforeSecondRead: () => {
            writeFileSync(join(worktree, 'appeared.txt'), 'new\n');
          },
        },
      },
      capture.io,
    );
    expect(code).toBe(1);
    expect(capture.out.join('')).toBe('');
    const printed = capture.err.join('');
    expect(printed).toContain('FAILED: nothing was saved');
    expect(printed).toContain('the worktree changed during the save');
    const dirs = stampDirs(out);
    expect(dirs).toHaveLength(1);
    expect(dirs[0]?.endsWith(FAILED_SUFFIX)).toBe(true);
    const failedDir = join(out, 'primary', 'feature', dirs[0] ?? '');
    expect(existsSync(join(failedDir, MANIFEST_FILE))).toBe(false);
    expect(readFileSync(join(failedDir, FAILURE_FILE), 'utf-8')).toContain(
      'the worktree changed during the save',
    );
  });

  test('a copy whose sha256 does not match its source fails, naming the file', () => {
    const sb = track();
    const {worktree} = buildDirtyWorktree(sb);
    const out = join(sb.path, 'out');
    const failed = expectFailed(
      saveCheckout({
        checkout: worktree,
        destination: flagDestination(out),
        includeIgnored: false,
        seams: {
          afterCopy: (copy) => {
            if (copy.path === 'mod.txt') writeFileSync(copy.dest, 'tampered\n');
          },
        },
      }),
    );
    expect(failed.reason).toContain('mod.txt: sha256 of the copy');
    expect(failed.failedDir?.endsWith(FAILED_SUFFIX)).toBe(true);
    expect(existsSync(join(failed.failedDir ?? '', MANIFEST_FILE))).toBe(false);
  });

  test('an already-modified file that changes again during the save fails it, though its status line does not change', () => {
    const sb = track();
    const {worktree} = buildDirtyWorktree(sb);
    const out = join(sb.path, 'out');
    let statusBefore = '';
    let statusAfter = '';
    const failed = expectFailed(
      saveCheckout({
        checkout: worktree,
        destination: flagDestination(out),
        includeIgnored: false,
        seams: {
          beforeSecondRead: () => {
            statusBefore = readOnlyStatus(worktree);
            appendFileSync(join(worktree, 'mod.txt'), 'more\n');
            statusAfter = readOnlyStatus(worktree);
          },
        },
      }),
    );
    // The status comparison alone cannot see this change...
    expect(statusAfter).toBe(statusBefore);
    // ...so the third hash must.
    expect(failed.reason).toContain('mod.txt changed during the save');
    expect(failed.failedDir?.endsWith(FAILED_SUFFIX)).toBe(true);
  });

  test('a source file that cannot be read fails the save, naming the file', () => {
    const sb = track();
    const {worktree} = buildDirtyWorktree(sb);
    const unreadable = join(worktree, 'untracked.txt');
    restoreModes.push({mode: 0o644, path: unreadable});
    chmodSync(unreadable, 0o000);
    const out = join(sb.path, 'out');
    const failed = expectFailed(
      saveCheckout({
        checkout: worktree,
        destination: flagDestination(out),
        includeIgnored: false,
      }),
    );
    expect(failed.reason).toContain('untracked.txt');
    expect(failed.failedDir?.endsWith(FAILED_SUFFIX)).toBe(true);
    expect(existsSync(join(failed.failedDir ?? '', MANIFEST_FILE))).toBe(false);
  });

  test('not enough free space at the destination fails before anything is written', () => {
    const sb = track();
    const {worktree} = buildDirtyWorktree(sb);
    const out = join(sb.path, 'out');
    const failed = expectFailed(
      saveCheckout({
        checkout: worktree,
        destination: flagDestination(out),
        includeIgnored: false,
        seams: {freeBytes: () => 10},
      }),
    );
    expect(failed.reason).toContain('not enough free space');
    expect(failed.failedDir).toBeNull();
    expect(existsSync(out)).toBe(false);
  });

  test('free space that cannot be measured is not treated as enough', () => {
    const sb = track();
    const {worktree} = buildDirtyWorktree(sb);
    const out = join(sb.path, 'out');
    const failed = expectFailed(
      saveCheckout({
        checkout: worktree,
        destination: flagDestination(out),
        includeIgnored: false,
        seams: {freeBytes: () => null},
      }),
    );
    expect(failed.reason).toContain('could not measure the free space');
    expect(existsSync(out)).toBe(false);
  });

  test('a path that is not a git checkout is refused, and nothing is written', async () => {
    const sb = track();
    const out = join(sb.path, 'out');
    sb.mkdir('plain');
    const capture = captureIo(sb.path);
    const code = await runSaveCommand(
      {checkout: join(sb.path, 'plain'), includeIgnored: false, out},
      capture.io,
    );
    expect(code).toBe(1);
    expect(capture.err.join('')).toContain('is not inside a git checkout');
    expect(existsSync(out)).toBe(false);
  });
});

describe('save: the source is never written (D6, AC 5)', () => {
  test('the index mtime and the full porcelain output are identical before and after a save', () => {
    const sb = track();
    const {worktree} = buildDirtyWorktree(sb);
    const indexPath = git(worktree, [
      'rev-parse',
      '--path-format=absolute',
      '--git-path',
      'index',
    ]).trim();
    const indexBefore = statSync(indexPath, {bigint: true});
    const statusBefore = readOnlyStatus(worktree);
    const ignoredBefore = readOnlyStatus(worktree, ['--ignored=matching']);

    expectSaved(
      saveCheckout({
        checkout: worktree,
        destination: flagDestination(join(sb.path, 'out')),
        includeIgnored: true,
      }),
    );

    const indexAfter = statSync(indexPath, {bigint: true});
    expect(indexAfter.mtimeNs).toBe(indexBefore.mtimeNs);
    expect(indexAfter.ino).toBe(indexBefore.ino);
    expect(readOnlyStatus(worktree)).toBe(statusBefore);
    expect(readOnlyStatus(worktree, ['--ignored=matching'])).toBe(
      ignoredBefore,
    );
  });
});
