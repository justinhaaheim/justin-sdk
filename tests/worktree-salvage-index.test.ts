/**
 * worktree-salvage save: versions that exist ONLY in the index (epic
 * home-base-us739, D2's addition; dispatch 2, home-base-us739.2, AC 6).
 *
 * A file staged and then edited again (`MM`), staged and then removed (`AD`,
 * `MD`), and each stage of a conflict (`UU`) has a version git holds only in
 * the index. Once the worktree is removed that blob is unreachable, so the
 * save writes it to `index/`. Every test runs on a real fixture repo and saves
 * inside the test's own sandbox.
 */

import type {Destination} from '../src/worktree-salvage/config';

import {afterEach, describe, expect, test} from 'bun:test';
import {execFileSync} from 'child_process';
import {existsSync, readFileSync} from 'fs';
import {join} from 'path';

import {
  FAILED_SUFFIX,
  INDEX_DIR,
  MANIFEST_FILE,
  ManifestSchema,
} from '../src/worktree-salvage/manifest';
import {saveCheckout, type SaveResult} from '../src/worktree-salvage/save';
import {createSandbox, type Sandbox} from './sandbox';
import {
  addIndexOnlyChanges,
  buildDirtyWorktree,
  readOnlyStatus,
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

function expectSaved(result: SaveResult): Extract<SaveResult, {kind: 'saved'}> {
  if (result.kind !== 'saved') {
    throw new Error(
      `expected a save, got ${result.kind}: ${result.kind === 'failed' ? result.reason : ''}`,
    );
  }
  return result;
}

/** `git cat-file blob`, as bytes, for the independent comparison. */
function catFile(cwd: string, oid: string): Buffer {
  return execFileSync('git', ['cat-file', 'blob', oid], {cwd});
}

describe('save: index-only versions (D2 addition, AC 6)', () => {
  test('writes the MM, AD and MD index versions and every UU stage under index/, byte-equal to git cat-file', () => {
    const sb = track();
    const {worktree} = buildDirtyWorktree(sb);
    const expected = addIndexOnlyChanges(worktree);
    const out = join(sb.path, 'out');
    const saved = expectSaved(
      saveCheckout({
        checkout: worktree,
        destination: flagDestination(out),
        includeIgnored: false,
      }),
    );
    const {indexEntries} = saved.manifest;

    // Exactly these, and nothing whose index version is also on disk or in
    // HEAD (added.txt `A.`, mod.txt `.M`, ren-dst.txt `R.`).
    expect(
      indexEntries.map((entry) => ({file: entry.file, stage: entry.stage})),
    ).toEqual([
      {file: 'dir with space/file one.txt', stage: null},
      {file: 'staged-then-deleted.bin', stage: null},
      {file: 'touched.txt', stage: null},
      {file: 'conflict.txt.stage1', stage: 1},
      {file: 'conflict.txt.stage2', stage: 2},
      {file: 'conflict.txt.stage3', stage: 3},
    ]);

    for (const entry of indexEntries) {
      const written = readFileSync(join(saved.stampDir, INDEX_DIR, entry.file));
      expect(written.equals(catFile(worktree, entry.indexBlob))).toBe(true);
      expect(written.length).toBe(entry.bytes);
    }

    // Independent of git: the bytes are what the fixture staged.
    for (const {bytes, path} of expected) {
      const written = readFileSync(join(saved.stampDir, INDEX_DIR, path));
      expect(written.equals(bytes)).toBe(true);
    }
    const stages = ['base\n', 'feature side\n', 'main side\n'];
    stages.forEach((text, index) => {
      expect(
        readFileSync(
          join(saved.stampDir, INDEX_DIR, `conflict.txt.stage${index + 1}`),
          'utf-8',
        ),
      ).toBe(text);
    });

    // The manifest on disk carries them too, and parses.
    const onDisk = ManifestSchema.parse(
      JSON.parse(readFileSync(join(saved.stampDir, MANIFEST_FILE), 'utf-8')),
    );
    expect(onDisk.indexEntries).toEqual(indexEntries);
  });

  test('a save with index copies still leaves the source untouched (D6)', () => {
    const sb = track();
    const {worktree} = buildDirtyWorktree(sb);
    addIndexOnlyChanges(worktree);
    const statusBefore = readOnlyStatus(worktree);
    const indexPath = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-path', 'index'],
      {cwd: worktree, encoding: 'utf-8'},
    ).trim();
    const indexBefore = readFileSync(indexPath);
    expectSaved(
      saveCheckout({
        checkout: worktree,
        destination: flagDestination(join(sb.path, 'out')),
        includeIgnored: false,
      }),
    );
    expect(readFileSync(indexPath).equals(indexBefore)).toBe(true);
    expect(readOnlyStatus(worktree)).toBe(statusBefore);
  });

  test('a failed index read fails the save, keeps <stamp>.failed and writes no manifest', () => {
    const sb = track();
    const {worktree} = buildDirtyWorktree(sb);
    addIndexOnlyChanges(worktree);
    const out = join(sb.path, 'out');
    const result = saveCheckout({
      checkout: worktree,
      destination: flagDestination(out),
      includeIgnored: false,
      seams: {
        readIndexBlob: () => ({
          error: 'fatal: bad object 0123 (injected)',
          ok: false,
        }),
      },
    });
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.reason).toContain('could not read the index version of');
    expect(result.reason).toContain('(injected)');
    expect(result.failedDir?.endsWith(FAILED_SUFFIX)).toBe(true);
    expect(existsSync(result.failedDir ?? '/nonexistent')).toBe(true);
    expect(existsSync(join(result.failedDir ?? '', MANIFEST_FILE))).toBe(false);
  });

  test('an index read whose length differs from git cat-file -s fails the save', () => {
    const sb = track();
    const {worktree} = buildDirtyWorktree(sb);
    addIndexOnlyChanges(worktree);
    const result = saveCheckout({
      checkout: worktree,
      destination: flagDestination(join(sb.path, 'out')),
      includeIgnored: false,
      seams: {readIndexBlob: () => ({ok: true, value: Buffer.from('short')})},
    });
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.reason).toContain('but git cat-file -s said');
    expect(result.failedDir?.endsWith(FAILED_SUFFIX)).toBe(true);
  });

  test('a manifest written before indexEntries existed still reads, as an empty list', () => {
    const sb = track();
    const {worktree} = buildDirtyWorktree(sb);
    const saved = expectSaved(
      saveCheckout({
        checkout: worktree,
        destination: flagDestination(join(sb.path, 'out')),
        includeIgnored: false,
      }),
    );
    const {indexEntries: _dropped, ...older} = saved.manifest;
    const parsed = ManifestSchema.parse(older);
    expect(parsed.indexEntries).toEqual([]);
  });
});
