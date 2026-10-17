/**
 * Fixtures for the worktree-salvage tests (epic home-base-us739).
 *
 * `buildDirtyWorktree` makes a real repo with a linked worktree carrying one of
 * every kind of change D2 names, because the behaviour under test IS git's:
 * what `status --porcelain=v2` reports, and what it leaves alone. Built on
 * git-fixtures.ts, so the host's global gitignore never leaks in.
 */

import type {CommandIo} from '../src/worktree-salvage/save';
import type {Sandbox} from './sandbox';

import {execFileSync} from 'child_process';
import {
  chmodSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import {join} from 'path';

import {PLAIN_STYLE} from '../src/cli-style';
import {addLinkedWorktree, git, initPrimary, write} from './git-fixtures';

/** The bytes of a small binary file, NULs and high bytes included. */
export const BINARY_BYTES = Buffer.from([0, 1, 2, 3, 0, 255, 254, 10, 13, 0]);

export interface DirtyWorktree {
  primary: string;
  worktree: string;
}

/** `git` that tolerates a non-zero exit (a conflicting merge exits 1). */
function gitAllowingFailure(cwd: string, args: string[]): void {
  try {
    execFileSync('git', args, {cwd, stdio: 'pipe'});
  } catch {
    // The conflict is the point.
  }
}

/**
 * A repo at `<sb>/primary` and a linked worktree at `<sb>/wt/feature` (branch
 * `feature`) holding, uncommitted:
 *
 *   mod.txt            modified                       `.M`
 *   exec.sh            modified, mode 0755            `.M`
 *   ren-dst.txt        renamed from ren-src.txt       `R.`
 *   del-staged.txt     deleted and staged             `D.`
 *   del-wt.txt         deleted in the worktree only   `.D`
 *   type.txt           now a symlink to mod.txt       `.T`
 *   added.txt          new and staged                 `A.`
 *   conflict.txt       a merge conflict               `UU`
 *   untracked.txt, deep/nested/u.bin (binary), dir with space/new file.txt,
 *   link-to-mod (an untracked symlink)                `??`
 *   nested/            an untracked repo of its own   `? nested/`
 *   touched.txt        mtime changed, content not: NOT in status, but a plain
 *                      `git status` would rewrite the index to refresh it,
 *                      which is what makes the D6 test's negative control bite
 *
 * and, ignored: tmp/ (a.txt, sub/b.txt, node_modules/q.js, inner-repo/ with its
 * own .git), x.log, node_modules/pkg/index.js.
 */
export function buildDirtyWorktree(sb: Sandbox): DirtyWorktree {
  const primary = initPrimary(sb, {
    '.gitignore': 'tmp/\n*.log\nnode_modules/\n',
    'conflict.txt': 'base\n',
    'del-staged.txt': 'deleted and staged\n',
    'del-wt.txt': 'deleted in the worktree\n',
    'dir with space/file one.txt': 'spaced\n',
    'exec.sh': '#!/bin/sh\necho one\n',
    'mod.txt': 'original\n',
    'ren-src.txt': 'rename me\n',
    'touched.txt': 'same content\n',
    'type.txt': 'becomes a symlink\n',
  });
  chmodSync(join(primary, 'exec.sh'), 0o755);
  git(primary, ['add', 'exec.sh']);
  git(primary, ['commit', '-qm', 'exec bit']);

  const worktree = addLinkedWorktree(
    primary,
    join(sb.path, 'wt', 'feature'),
    'feature',
  );
  write(worktree, 'conflict.txt', 'feature side\n');
  git(worktree, ['commit', '-qam', 'feature change']);
  write(primary, 'conflict.txt', 'main side\n');
  git(primary, ['commit', '-qam', 'main change']);
  gitAllowingFailure(worktree, ['merge', '-q', 'main']);

  write(worktree, 'mod.txt', 'modified\n');
  write(worktree, 'exec.sh', '#!/bin/sh\necho two\n');
  git(worktree, ['mv', 'ren-src.txt', 'ren-dst.txt']);
  git(worktree, ['rm', '-q', 'del-staged.txt']);
  rmSync(join(worktree, 'del-wt.txt'));
  rmSync(join(worktree, 'type.txt'));
  symlinkSync('mod.txt', join(worktree, 'type.txt'));
  write(worktree, 'added.txt', 'added\n');
  git(worktree, ['add', 'added.txt']);
  const later = new Date(Date.now() + 60_000);
  utimesSync(join(worktree, 'touched.txt'), later, later);

  write(worktree, 'untracked.txt', 'untracked\n');
  mkdirSync(join(worktree, 'deep/nested'), {recursive: true});
  writeFileSync(join(worktree, 'deep/nested/u.bin'), BINARY_BYTES);
  write(worktree, 'dir with space/new file.txt', 'new and spaced\n');
  symlinkSync('mod.txt', join(worktree, 'link-to-mod'));

  mkdirSync(join(worktree, 'nested'));
  git(join(worktree, 'nested'), ['init', '-q', '-b', 'main', '.']);
  write(worktree, 'nested/inside.txt', 'inside a nested repo\n');

  write(worktree, 'tmp/a.txt', 'a'.repeat(100));
  write(worktree, 'tmp/sub/b.txt', 'b'.repeat(50));
  write(worktree, 'tmp/node_modules/q.js', 'q'.repeat(30));
  mkdirSync(join(worktree, 'tmp/inner-repo'));
  git(join(worktree, 'tmp/inner-repo'), ['init', '-q', '-b', 'main', '.']);
  write(worktree, 'tmp/inner-repo/kept-out.txt', 'not entered\n');
  write(worktree, 'x.log', 'log line\n');
  write(worktree, 'node_modules/pkg/index.js', 'module.exports = 1;\n');
  return {primary, worktree};
}

/**
 * Add, on top of `buildDirtyWorktree`, the three ways a version can exist ONLY
 * in the index (D2's addition, home-base-us739.2). The fixture's `UU`
 * conflict.txt already contributes its three conflict stages.
 *
 *   dir with space/file one.txt  staged, then edited again          `MM`
 *   staged-then-deleted.bin      new binary, staged, then removed   `AD`
 *   touched.txt                  edited, staged, then removed       `MD`
 *
 * Returns each path with the text (or bytes) its index version holds.
 */
export function addIndexOnlyChanges(
  worktree: string,
): {bytes: Buffer; path: string}[] {
  const staged = Buffer.from('staged version, then edited again\n');
  write(worktree, 'dir with space/file one.txt', staged.toString());
  git(worktree, ['add', 'dir with space/file one.txt']);
  write(worktree, 'dir with space/file one.txt', 'edited after staging\n');

  writeFileSync(join(worktree, 'staged-then-deleted.bin'), BINARY_BYTES);
  git(worktree, ['add', 'staged-then-deleted.bin']);
  rmSync(join(worktree, 'staged-then-deleted.bin'));

  const touched = Buffer.from('staged edit, then the file was removed\n');
  writeFileSync(join(worktree, 'touched.txt'), touched);
  git(worktree, ['add', 'touched.txt']);
  rmSync(join(worktree, 'touched.txt'));
  return [
    {bytes: staged, path: 'dir with space/file one.txt'},
    {bytes: BINARY_BYTES, path: 'staged-then-deleted.bin'},
    {bytes: touched, path: 'touched.txt'},
  ];
}

/** The status a save must leave untouched, read without taking any lock. */
export function readOnlyStatus(cwd: string, extra: string[] = []): string {
  return execFileSync(
    'git',
    [
      '--no-optional-locks',
      'status',
      '--porcelain=v2',
      '-z',
      '--untracked-files=all',
      ...extra,
    ],
    {cwd, encoding: 'utf-8'},
  );
}

/** A CommandIo that captures what a command prints. */
export function captureIo(
  cwd: string,
  env: Record<string, string | undefined> = {},
): {err: string[]; io: CommandIo; out: string[]} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    err,
    io: {
      cwd,
      env: {HOME: cwd, XDG_CONFIG_HOME: join(cwd, 'no-config'), ...env},
      stderr: (text) => {
        err.push(text);
        return Promise.resolve();
      },
      stderrStyle: PLAIN_STYLE,
      stdout: (text) => {
        out.push(text);
        return Promise.resolve();
      },
      stdoutStyle: PLAIN_STYLE,
    },
    out,
  };
}
