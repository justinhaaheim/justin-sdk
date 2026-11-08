/**
 * Fixtures for `justin-sdk update`'s self-update tests (home-base-ipx4a).
 *
 * A consumer repo pinned one tag behind, and fake bumps that write exactly what
 * bun 1.4.2 writes. The lockfile lines are copied from real bun output in
 * throwaway fixtures (2026-11-08): `bun add -d @justinhaaheim/justin-sdk@github:
 * justinhaaheim/justin-sdk#<tag>` replaces the workspace pin line and the
 * packages entry in place, and nothing else. Only the tags, commits and hashes
 * are fake, so the suite never fetches anything.
 */

import type {ExecResult} from '../src/setup-helpers';

import {execFileSync} from 'child_process';
import {chmodSync, mkdirSync, readFileSync, writeFileSync} from 'fs';
import {dirname, join, resolve} from 'path';

export const SDK_PKG = '@justinhaaheim/justin-sdk';
export const OLD_TAG = 'v0.1.0';
export const NEW_TAG = 'v0.2.0';

const COMMITS: Record<string, string> = {
  [NEW_TAG]: 'bbbbbbb',
  [OLD_TAG]: 'aaaaaaa',
};

/** This checkout's SDK CLI: what a re-exec child runs in these fixtures. */
export const SDK_CLI = resolve(import.meta.dirname, '..', 'src', 'cli.ts');

export function pinSpec(tag: string): string {
  return `github:justinhaaheim/justin-sdk#${tag}`;
}

/** The workspace pin line, as bun writes it. */
export function lockPinLine(tag: string): string {
  return `        "${SDK_PKG}": "${pinSpec(tag)}",`;
}

/** The SDK's packages entry, as bun writes it. */
export function lockPackageLine(tag: string): string {
  const commit = COMMITS[tag] ?? 'ccccccc';
  return `    "${SDK_PKG}": ["${SDK_PKG}@github:justinhaaheim/justin-sdk#${commit}", { "dependencies": { "ignore": "^7.0.6", "yargs": "^18.0.0" }, "bin": { "justin-sdk": "./src/cli.ts", "repo-status": "./src/repo-status/repo-status.ts" } }, "justinhaaheim-justin-sdk-${commit}", "sha512-fake${commit}=="],`;
}

/** A real-shaped bun.lock pinned at `tag`, with two unrelated packages. */
export function lockfileText(
  tag: string,
  options: {extraPackageLines?: string[]; pinLines?: string[]} = {},
): string {
  const pinLines = options.pinLines ?? [lockPinLine(tag)];
  return [
    '{',
    '  "lockfileVersion": 2,',
    '  "configVersion": 1,',
    '  "workspaces": {',
    '    "": {',
    '      "name": "consumer-fixture",',
    '      "devDependencies": {',
    ...pinLines,
    '        "ignore": "^7.0.6",',
    '      },',
    '    },',
    '  },',
    '  "packages": {',
    lockPackageLine(tag),
    '',
    '    "ansi-regex": ["ansi-regex@6.5.0", "", {}, "sha512-fakeansi=="],',
    '',
    '    "ignore": ["ignore@7.0.14", "", {}, "sha512-fakeignore=="],',
    ...(options.extraPackageLines ?? []),
    '  }',
    '}',
    '',
  ].join('\n');
}

export function packageJsonObject(tag: string): Record<string, unknown> {
  return {
    devDependencies: {
      [SDK_PKG]: pinSpec(tag),
      ignore: '^7.0.6',
    },
    name: 'consumer-fixture',
    private: true,
    scripts: {build: 'echo build'},
  };
}

export function packageJsonText(tag: string): string {
  return JSON.stringify(packageJsonObject(tag), null, 2) + '\n';
}

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function writeAt(root: string, relPath: string, content: string): void {
  const full = join(root, relPath);
  mkdirSync(dirname(full), {recursive: true});
  writeFileSync(full, content);
}

/** Make node_modules claim `version` is the installed SDK. */
export function writeInstalledSdk(root: string, version: string): void {
  writeAt(
    root,
    `node_modules/${SDK_PKG}/package.json`,
    JSON.stringify({name: SDK_PKG, version}, null, 2) + '\n',
  );
}

/** A git repo at `root` with everything under it committed. */
export function initCommittedRepo(root: string): void {
  // The machine's global ignore must not decide what these tests commit.
  writeAt(root, '.git-test-excludes', '');
  git(root, ['init', '-q', '-b', 'main', '.']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['config', 'core.excludesFile', join(root, '.git-test-excludes')]);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'base']);
}

/** The consumer's files, without a git repo of their own. */
export function writeConsumerFiles(
  root: string,
  options: {components?: string[]; sdkBin?: boolean} = {},
): void {
  writeAt(root, 'package.json', packageJsonText(OLD_TAG));
  writeAt(root, 'bun.lock', lockfileText(OLD_TAG));
  writeAt(root, 'README.md', '# consumer fixture\n');
  writeAt(root, '.gitignore', 'node_modules/\n');
  writeAt(
    root,
    'justin-sdk.config.json',
    JSON.stringify({components: options.components ?? []}, null, 2) + '\n',
  );
  writeInstalledSdk(root, OLD_TAG.replace(/^v/, ''));
  if (options.sdkBin === true) {
    const bin = join(root, 'node_modules', '.bin', 'justin-sdk');
    writeAt(
      root,
      'node_modules/.bin/justin-sdk',
      `#!/bin/sh\nexec "${process.execPath}" "${SDK_CLI}" "$@"\n`,
    );
    chmodSync(bin, 0o755);
  }
}

/**
 * A committed consumer repo at `root`, pinned at OLD_TAG with OLD_TAG
 * installed, on a clean tree. node_modules is gitignored, as in every real
 * consumer. With `sdkBin`, node_modules/.bin/justin-sdk runs THIS checkout's
 * CLI, so a re-exec runs the code under test as the child.
 */
export function initConsumerRepo(
  root: string,
  options: {components?: string[]; sdkBin?: boolean} = {},
): void {
  writeConsumerFiles(root, options);
  initCommittedRepo(root);
}

/** The tree after a successful bump to `tag`: what bun 1.4.2 writes. */
export function writeBumpedPin(root: string, tag: string): void {
  writeFileSync(join(root, 'package.json'), packageJsonText(tag));
  writeFileSync(join(root, 'bun.lock'), lockfileText(tag));
}

/** A `runBump` that does what the named `bun add -d` does: pin, lock, install. */
export function fakeGoodBump(
  calls: (readonly string[])[] = [],
): (argv: readonly string[], cwd: string) => ExecResult {
  return (argv, cwd) => {
    calls.push(argv);
    writeBumpedPin(cwd, NEW_TAG);
    writeInstalledSdk(cwd, NEW_TAG.replace(/^v/, ''));
    return {exitCode: 0, stderr: '', stdout: ''};
  };
}

/**
 * A `runBump` that does what the OLD unnamed `bun add -d github:…` did on bun
 * 1.4.2 (F2 + F3): package.json names the new tag, bun.lock gets the pin line
 * TWICE with the packages entry left on the old commit, node_modules keeps the
 * old SDK, and the exit code is 0.
 */
export function fakeStaleBump(): (
  argv: readonly string[],
  cwd: string,
) => ExecResult {
  return (_argv, cwd) => {
    writeFileSync(join(cwd, 'package.json'), packageJsonText(NEW_TAG));
    const text = readFileSync(join(cwd, 'bun.lock'), 'utf-8').replace(
      lockPinLine(OLD_TAG),
      `${lockPinLine(NEW_TAG)}\n${lockPinLine(NEW_TAG)}`,
    );
    writeFileSync(join(cwd, 'bun.lock'), text);
    return {exitCode: 0, stderr: '', stdout: ''};
  };
}

export function fakeLatestTag(): () => {
  status: 'ok';
  tag: string;
  version: string;
} {
  return () => ({status: 'ok', tag: NEW_TAG, version: NEW_TAG.slice(1)});
}

/** Collect everything console.log / warn / error print while `fn` runs. */
export async function captureConsole<T>(
  fn: () => Promise<T>,
): Promise<{output: string; result: T}> {
  const chunks: string[] = [];
  const original = {
    error: console.error,
    log: console.log,
    warn: console.warn,
  };
  const record = (...args: unknown[]): void => {
    chunks.push(args.map(String).join(' '));
  };
  console.log = record;
  console.warn = record;
  console.error = record;
  try {
    const result = await fn();
    return {output: chunks.join('\n'), result};
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
}
