/**
 * The hermetic end-to-end sweep harness, shared by every test that runs the
 * WHOLE per-repo pipeline (moved out of sweep-ratchet.test.ts for 39co9.6, whose
 * tests need the same fixture plus a bare "origin").
 *
 * The two `file:` dependencies are what make it hermetic: the doctor gate and
 * `bunx prettier` both resolve the repo's own node_modules first, so the
 * fixture decides what the gates do without any network or installed SDK.
 */

import {expect} from 'bun:test';
import {chmodSync, mkdirSync, writeFileSync} from 'fs';
import {join} from 'path';

import {findSweepLeftoverNames} from '../src/sweep';
import {git, write} from './git-fixtures';
import {type Sandbox} from './sandbox';

export interface E2EOptions {
  /** A dependency bun cannot resolve, so hydration really fails. */
  breakHydration?: boolean;
  /** Exit code of the read-only `doctor` baseline. */
  doctorExit?: number;
  /** Exit code of the `doctor --fix` gate. */
  doctorFixExit?: number;
  /** A pre-commit hook that exits non-zero (health-logger-rn's shape). */
  hostilePreCommit?: boolean;
  /**
   * always-green      — signal passes before and after (the ordinary repo)
   * always-red        — signal fails before and after (userscripts-j's shape)
   * red-when-swept    — signal fails exactly once the payload's bytes land
   */
  signal?: 'always-green' | 'always-red' | 'red-when-swept';
}

/**
 * A committed repo the WHOLE sweep pipeline can run against, offline.
 *
 * The two `file:` dependencies are what make it hermetic: `bunx
 * @justinhaaheim/justin-sdk doctor` and `bunx prettier` both resolve the
 * repo's own node_modules first, so the fixture decides what the gates do
 * without any network or any installed SDK.
 */
export function e2eRepo(
  sb: Sandbox,
  name: string,
  options: E2EOptions = {},
): string {
  const doctorExit = options.doctorExit ?? 0;
  const doctorFixExit = options.doctorFixExit ?? doctorExit;

  const sdkDir = join(sb.path, `${name}-tools`, 'fake-sdk');
  mkdirSync(sdkDir, {recursive: true});
  writeFileSync(
    join(sdkDir, 'package.json'),
    JSON.stringify({
      bin: {'justin-sdk': './cli.js'},
      name: '@justinhaaheim/justin-sdk',
      version: '0.0.0-fixture',
    }) + '\n',
  );
  writeFileSync(
    join(sdkDir, 'cli.js'),
    [
      '#!/usr/bin/env node',
      'const args = process.argv.slice(2);',
      "console.log('fixture justin-sdk ' + args.join(' '));",
      `process.exit(args.includes('--fix') ? ${doctorFixExit} : ${doctorExit});`,
      '',
    ].join('\n'),
  );
  // WITHOUT the exec bit bunx cannot run the local bin and silently falls back
  // to the registry — measured: the doctor gate then reported npm's 404 as the
  // repo's doctor exit code, and `bunx prettier` fetched the real prettier.
  chmodSync(join(sdkDir, 'cli.js'), 0o755);

  const prettierDir = join(sb.path, `${name}-tools`, 'fake-prettier');
  mkdirSync(prettierDir, {recursive: true});
  writeFileSync(
    join(prettierDir, 'package.json'),
    JSON.stringify({
      bin: {prettier: './cli.js'},
      name: 'prettier',
      version: '0.0.0-fixture',
    }) + '\n',
  );
  writeFileSync(
    join(prettierDir, 'cli.js'),
    '#!/usr/bin/env node\nprocess.exit(0);\n',
  );
  chmodSync(join(prettierDir, 'cli.js'), 0o755);

  const root = join(sb.path, name);
  mkdirSync(root, {recursive: true});
  git(root, ['init', '-q', '-b', 'main', '.']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);
  const excludes = join(root, '.git', 'controlled-excludes');
  writeFileSync(excludes, '');
  git(root, ['config', 'core.excludesFile', excludes]);

  const dependencies: Record<string, string> = {
    '@justinhaaheim/justin-sdk': `file:${sdkDir}`,
    prettier: `file:${prettierDir}`,
  };
  if (options.breakHydration === true) {
    dependencies['fixture-missing-dep'] = `file:${join(sb.path, 'nowhere')}`;
  }
  write(
    root,
    'package.json',
    JSON.stringify(
      {
        devDependencies: dependencies,
        name,
        scripts: {signal: 'bun run scripts/fixture-signal.ts'},
        version: '0.0.1',
      },
      null,
      2,
    ) + '\n',
  );
  write(
    root,
    'justin-sdk.config.json',
    JSON.stringify(
      {
        components: ['base-setup', 'gitignore-setup'],
        lastSynced: '2000-01-01',
        version: '0.0.1-fixture',
      },
      null,
      2,
    ) + '\n',
  );
  // node_modules and the lockfile must not ride along in the sweep's commit.
  // The gitignore component only APPENDS its missing baseline entries, so these
  // survive the payload.
  write(root, '.gitignore', 'node_modules/\nbun.lock\n');

  // The repo's own signal, as a real script that inspects the tree: in
  // `red-when-swept` mode it goes red precisely when the payload's bytes land,
  // so the green→red case below is caused by the payload rather than staged.
  const body =
    options.signal === 'always-red'
      ? "console.log('fixture signal: pre-existing red'); process.exit(1);"
      : options.signal === 'red-when-swept'
        ? [
            "const ignore = readFileSync('.gitignore', 'utf-8');",
            "const swept = ignore.includes('justin-sdk baseline');",
            "console.log('fixture signal: payload applied = ' + swept);",
            'process.exit(swept ? 1 : 0);',
          ].join('\n')
        : "console.log('fixture signal: green'); process.exit(0);";
  write(
    root,
    'scripts/fixture-signal.ts',
    `import {readFileSync} from 'node:fs';\nvoid readFileSync;\n${body}\n`,
  );

  if (options.hostilePreCommit === true) {
    write(
      root,
      '.husky/pre-commit',
      '#!/bin/sh\necho "husky - pre-commit (ts-check) FAILED"\nexit 1\n',
    );
    chmodSync(join(root, '.husky', 'pre-commit'), 0o755);
    git(root, ['config', 'core.hooksPath', '.husky']);
  }

  git(root, ['add', '-A']);
  // --no-verify: the hostile pre-commit fixture would otherwise be unable to
  // make its own first commit.
  git(root, ['commit', '--no-verify', '-qm', 'init']);
  return root;
}

export async function captureLog<T>(
  fn: () => Promise<T>,
): Promise<{out: string; value: T}> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(' '));
  };
  try {
    const value = await fn();
    return {out: lines.join('\n'), value};
  } finally {
    console.log = original;
  }
}

/**
 * Nothing of ANY sweep run survives in `repo`: no sweep-named worktree,
 * registration, directory or branch — the legacy fixed name or a stamped one.
 */
export function expectNoSweepRemains(repo: string): void {
  expect(findSweepLeftoverNames(repo)).toEqual({names: [], ok: true});
}

/** The sweep-named leftovers in `repo` (throws when the scan cannot run). */
export function sweepRemains(repo: string): string[] {
  const scan = findSweepLeftoverNames(repo);
  if (!scan.ok) throw new Error(scan.reason);
  return scan.names;
}
