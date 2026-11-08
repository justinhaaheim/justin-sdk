/**
 * Tests for update's preflight classifier (home-base-ipx4a D1): when is the
 * only uncommitted change the SDK pin? Both sides of every rule are here, and
 * the lockfile shapes are the ones bun 1.4.2 actually wrote (see
 * update-fixtures.ts).
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {mkdirSync, writeFileSync} from 'fs';
import {join} from 'path';

import {
  parsePorcelainZ,
  readUpdateTreeState,
  sdkPinOnlyLockfileChange,
  sdkPinOnlyPackageJsonChange,
} from '../src/update-tree-state';
import {createSandbox, type Sandbox} from './sandbox';
import {
  git,
  initCommittedRepo,
  initConsumerRepo,
  lockfileText,
  lockPinLine,
  NEW_TAG,
  OLD_TAG,
  packageJsonObject,
  packageJsonText,
  pinSpec,
  SDK_PKG,
  writeBumpedPin,
  writeConsumerFiles,
} from './update-fixtures';

const sandboxes: Sandbox[] = [];

afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

function track(sb: Sandbox): Sandbox {
  sandboxes.push(sb);
  return sb;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

describe('parsePorcelainZ', () => {
  test('reads modified and untracked entries', () => {
    expect(parsePorcelainZ(' M package.json\0?? notes.txt\0')).toEqual([
      {code: ' M', path: 'package.json'},
      {code: '??', path: 'notes.txt'},
    ]);
  });

  test('empty output is an empty list, not an unknown', () => {
    expect(parsePorcelainZ('')).toEqual([]);
  });

  test('a rename consumes its source path field', () => {
    expect(parsePorcelainZ('R  new.txt\0old.txt\0 M bun.lock\0')).toEqual([
      {code: 'R ', path: 'new.txt'},
      {code: ' M', path: 'bun.lock'},
    ]);
  });

  test('output without the trailing NUL is unparseable, never clean', () => {
    expect(parsePorcelainZ(' M package.json')).toBeNull();
  });
});

describe('sdkPinOnlyPackageJsonChange', () => {
  test('ACCEPTS a change to the SDK pin and nothing else', () => {
    expect(
      sdkPinOnlyPackageJsonChange(
        packageJsonText(OLD_TAG),
        packageJsonText(NEW_TAG),
      ),
    ).toEqual({ok: true});
  });

  test('ACCEPTS devDependencies that bun sorted while writing the pin', () => {
    // Measured, bun 1.4.2: `bun add -d` sorted an unsorted devDependencies.
    const head = {
      devDependencies: {
        [SDK_PKG]: pinSpec(OLD_TAG),
        ignore: '^7.0.6',
        zod: '^4.6.1',
      },
      name: 'x',
    };
    const work = {
      devDependencies: {
        [SDK_PKG]: pinSpec(NEW_TAG),
        ignore: '^7.0.6',
        zod: '^4.6.1',
      },
      name: 'x',
    };
    expect(sdkPinOnlyPackageJsonChange(json(head), json(work))).toEqual({
      ok: true,
    });
  });

  test('REFUSES the pin plus an unrelated script edit', () => {
    const work = packageJsonObject(NEW_TAG);
    work.scripts = {build: 'echo build', test: 'echo test'};
    const verdict = sdkPinOnlyPackageJsonChange(
      packageJsonText(OLD_TAG),
      json(work),
    );
    expect(verdict).toEqual({
      ok: false,
      reason: 'package.json changes more than the SDK pin',
    });
  });

  test('REFUSES the pin plus another devDependency bump', () => {
    const work = packageJsonObject(NEW_TAG);
    work.devDependencies = {[SDK_PKG]: pinSpec(NEW_TAG), ignore: '^7.1.0'};
    expect(
      sdkPinOnlyPackageJsonChange(packageJsonText(OLD_TAG), json(work)).ok,
    ).toBe(false);
  });

  test('REFUSES a reorder outside devDependencies', () => {
    const head = packageJsonObject(OLD_TAG);
    const {name, ...rest} = packageJsonObject(NEW_TAG);
    const work = {...rest, name};
    expect(sdkPinOnlyPackageJsonChange(json(head), json(work)).ok).toBe(false);
  });

  test('REFUSES a pin that is not a version tag on the published repo', () => {
    // A local dev link is someone's work in progress, never a self-update.
    const work = packageJsonObject(NEW_TAG);
    work.devDependencies = {[SDK_PKG]: 'file:../justin-sdk', ignore: '^7.0.6'};
    const verdict = sdkPinOnlyPackageJsonChange(
      packageJsonText(OLD_TAG),
      json(work),
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.reason).toContain('file:../justin-sdk');
  });

  test('REFUSES a reformatted file whose pin did not change', () => {
    const head = packageJsonText(OLD_TAG);
    const work = JSON.stringify(packageJsonObject(OLD_TAG), null, 4) + '\n';
    expect(sdkPinOnlyPackageJsonChange(head, work)).toEqual({
      ok: false,
      reason:
        'package.json has uncommitted changes, and none of them is the SDK pin',
    });
  });

  test('REFUSES the SDK key written twice (JSON.parse would hide it)', () => {
    const work = packageJsonText(NEW_TAG).replace(
      `"${SDK_PKG}": "${pinSpec(NEW_TAG)}",`,
      `"${SDK_PKG}": "${pinSpec(NEW_TAG)}",\n    "${SDK_PKG}": "${pinSpec(NEW_TAG)}",`,
    );
    const verdict = sdkPinOnlyPackageJsonChange(packageJsonText(OLD_TAG), work);
    expect(verdict).toEqual({
      ok: false,
      reason: `package.json declares "${SDK_PKG}" 2 times, not once`,
    });
  });

  test('REFUSES the SDK moved from devDependencies to dependencies', () => {
    const work: Record<string, unknown> = {
      dependencies: {[SDK_PKG]: pinSpec(NEW_TAG)},
      devDependencies: {ignore: '^7.0.6'},
      name: 'consumer-fixture',
      private: true,
      scripts: {build: 'echo build'},
    };
    expect(
      sdkPinOnlyPackageJsonChange(packageJsonText(OLD_TAG), json(work)).ok,
    ).toBe(false);
  });

  test('REFUSES a working copy that does not parse', () => {
    expect(
      sdkPinOnlyPackageJsonChange(packageJsonText(OLD_TAG), '{ "name": ').ok,
    ).toBe(false);
  });
});

describe('sdkPinOnlyLockfileChange', () => {
  test('ACCEPTS the in-place rewrite of the pin line and packages entry', () => {
    expect(
      sdkPinOnlyLockfileChange(lockfileText(OLD_TAG), lockfileText(NEW_TAG)),
    ).toEqual({ok: true});
  });

  test("ACCEPTS a change to the SDK's own nested dependency entry", () => {
    // bun keys the SDK's private copy of a dependency `<sdk>/<dep>`.
    const nested = (version: string): string[] => [
      '',
      `    "${SDK_PKG}/zod": ["zod@${version}", "", {}, "sha512-fakezod${version}=="],`,
    ];
    expect(
      sdkPinOnlyLockfileChange(
        lockfileText(OLD_TAG, {extraPackageLines: nested('4.6.1')}),
        lockfileText(NEW_TAG, {extraPackageLines: nested('4.7.0')}),
      ),
    ).toEqual({ok: true});
  });

  test('REFUSES the duplicated pin line of F2 (bun 1.4.2, unnamed bun add)', () => {
    // The exact shape measured in a fixture: the new pin line twice.
    const work = lockfileText(OLD_TAG, {
      pinLines: [lockPinLine(NEW_TAG), lockPinLine(NEW_TAG)],
    });
    const verdict = sdkPinOnlyLockfileChange(lockfileText(OLD_TAG), work);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.reason).toContain('duplicate key');
  });

  test('REFUSES a new top-level package entry (a dependency the SDK added)', () => {
    // Measured v0.50.0 → v0.51.0: shell-quote arrived as its own entry.
    const work = lockfileText(NEW_TAG, {
      extraPackageLines: [
        '',
        '    "shell-quote": ["shell-quote@1.12.0", "", {}, "sha512-fakesq=="],',
      ],
    });
    expect(sdkPinOnlyLockfileChange(lockfileText(OLD_TAG), work)).toEqual({
      ok: false,
      reason: `bun.lock changes lines that are not keyed by ${SDK_PKG}`,
    });
  });

  test('REFUSES a line for a package whose name merely starts with the SDK name', () => {
    const extra = (version: string): string[] => [
      '',
      `    "${SDK_PKG}-other": ["${SDK_PKG}-other@${version}", "", {}, "sha512-x=="],`,
    ];
    expect(
      sdkPinOnlyLockfileChange(
        lockfileText(OLD_TAG, {extraPackageLines: extra('1.0.0')}),
        lockfileText(NEW_TAG, {extraPackageLines: extra('1.0.1')}),
      ).ok,
    ).toBe(false);
  });

  test('REFUSES an unrelated package bumped in the same lockfile', () => {
    const work = lockfileText(NEW_TAG).replace(
      '"ignore@7.0.14"',
      '"ignore@7.0.15"',
    );
    expect(sdkPinOnlyLockfileChange(lockfileText(OLD_TAG), work).ok).toBe(
      false,
    );
  });
});

describe('readUpdateTreeState (real git)', () => {
  function repo(): string {
    const sb = track(createSandbox());
    initConsumerRepo(sb.path);
    return sb.path;
  }

  test('a committed tree is clean', () => {
    expect(readUpdateTreeState(repo())).toEqual({kind: 'clean'});
  });

  test('the bump bun writes is sdk-pin-only, naming both files', () => {
    const root = repo();
    writeBumpedPin(root, NEW_TAG);
    expect(readUpdateTreeState(root)).toEqual({
      kind: 'sdk-pin-only',
      paths: ['bun.lock', 'package.json'],
    });
  });

  test('the bump with the change staged is still sdk-pin-only', () => {
    const root = repo();
    writeBumpedPin(root, NEW_TAG);
    git(root, ['add', 'package.json']);
    expect(readUpdateTreeState(root).kind).toBe('sdk-pin-only');
  });

  test('the bump plus an unrelated tracked edit is dirty, naming the file', () => {
    const root = repo();
    writeBumpedPin(root, NEW_TAG);
    writeFileSync(join(root, 'README.md'), '# edited\n');
    expect(readUpdateTreeState(root)).toEqual({
      detail: 'README.md has uncommitted changes (git status " M")',
      kind: 'dirty',
    });
  });

  test('the bump plus an untracked file is dirty', () => {
    const root = repo();
    writeBumpedPin(root, NEW_TAG);
    writeFileSync(join(root, 'scratch.txt'), 'wip\n');
    expect(readUpdateTreeState(root).kind).toBe('dirty');
  });

  test('a deleted bun.lock is dirty, not pin-only', () => {
    const root = repo();
    git(root, ['rm', '-q', 'bun.lock']);
    expect(readUpdateTreeState(root).kind).toBe('dirty');
  });

  test('a project in a subdirectory of its repo is read at its own paths', () => {
    // git status prints repo-root-relative paths whatever the cwd, so the
    // project's files appear as apps/consumer/package.json here.
    const sb = track(createSandbox());
    const top = sb.path;
    const project = join(top, 'apps', 'consumer');
    mkdirSync(project, {recursive: true});
    writeConsumerFiles(project);
    initCommittedRepo(top);
    writeBumpedPin(project, NEW_TAG);
    expect(readUpdateTreeState(project)).toEqual({
      kind: 'sdk-pin-only',
      paths: ['bun.lock', 'package.json'],
    });
    // And the same edit seen from the top is NOT the top's own pin.
    expect(readUpdateTreeState(top).kind).toBe('dirty');
  });

  test('outside any repo the state is unchecked, not clean', () => {
    const sb = track(createSandbox());
    const state = readUpdateTreeState(sb.path);
    expect(state.kind).toBe('unchecked');
  });
});
