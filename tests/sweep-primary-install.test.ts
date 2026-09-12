/**
 * Tests for the POST-MERGE INSTALL in the primary — home-base-bgfl.
 *
 * THE BUG THIS GUARDS: the sweep installs only inside its own worktree, so a
 * merged repo kept running the SDK its node_modules already held. Measured
 * 2026-09-12 — apple-reminders-mcp's doctor said "0.27.0 → 0.28.1 available"
 * with the pin already at 0.28.1, and six primaries were still on a pre-0.27
 * SDK after two sweeps.
 *
 * WHY THE EFFECTFUL HALF RUNS A REAL `bun install --frozen-lockfile`. The two
 * facts worth testing are bun's, not mine: a frozen install of an up-to-date
 * lockfile succeeds without touching the network, and one whose package.json
 * has drifted FAILS instead of quietly rewriting the lockfile the sweep just
 * committed. A faked runner would assert my model of bun and pass while the
 * fleet silently re-locked. It is hermetic because the fixture's only
 * dependency is a local `file:` package — measured offline at ~5ms per install,
 * the same technique tests/sweep-ratchet.test.ts uses for hydration.
 *
 * NOT COVERED HERE, stated rather than implied: the arm where the install
 * leaves NEW dirty paths in the primary. Making a frozen install dirty a
 * tracked file is not reproducible on demand, so that branch is verified by
 * construction (a set difference over two porcelain reads) and by the live
 * fleet run on the bead.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {execFileSync} from 'child_process';
import {existsSync, mkdirSync, writeFileSync} from 'fs';
import {join} from 'path';

import {
  frozenInstallRecipe,
  installInPrimary,
  planPrimaryInstall,
  runSweep,
} from '../src/sweep';
import {initRepo} from './git-fixtures';
import {createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
function track(sb: Sandbox): Sandbox {
  sandboxes.push(sb);
  return sb;
}
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

// ---------------------------------------------------------------------------
// The pure decision (D2)
// ---------------------------------------------------------------------------

describe('planPrimaryInstall — the recipes', () => {
  test('bun gets a FROZEN install, not a plain one: the lockfile the sweep just committed is the payload', () => {
    expect(
      planPrimaryInstall({
        changedFiles: ['package.json', 'bun.lock'],
        dirtyPaths: [],
        packageManager: 'bun',
      }),
    ).toEqual({argv: ['bun', 'install', '--frozen-lockfile'], kind: 'run'});
  });

  test('npm gets `npm ci` — npm’s frozen form', () => {
    expect(
      planPrimaryInstall({
        changedFiles: ['package-lock.json'],
        dirtyPaths: [],
        packageManager: 'npm',
      }),
    ).toEqual({argv: ['npm', 'ci'], kind: 'run'});
  });

  test('yarn gets --frozen-lockfile', () => {
    expect(
      planPrimaryInstall({
        changedFiles: ['yarn.lock'],
        dirtyPaths: [],
        packageManager: 'yarn',
      }),
    ).toEqual({argv: ['yarn', 'install', '--frozen-lockfile'], kind: 'run'});
  });

  test('a package.json change alone is enough — the lockfile need not have moved', () => {
    expect(
      planPrimaryInstall({
        changedFiles: ['package.json'],
        dirtyPaths: [],
        packageManager: 'bun',
      }),
    ).toMatchObject({kind: 'run'});
  });

  test("bun.lockb (the fleet's older binary lockfile) triggers it too", () => {
    expect(
      planPrimaryInstall({
        changedFiles: ['bun.lockb'],
        dirtyPaths: [],
        packageManager: 'bun',
      }),
    ).toMatchObject({kind: 'run'});
  });
});

describe('planPrimaryInstall — the skips, each naming its reason', () => {
  test('a component-only sweep that touched neither manifest nor lockfile installs NOTHING', () => {
    const plan = planPrimaryInstall({
      changedFiles: [
        '.gitignore',
        '.claude/rules/justin-sdk/critical-rules.md',
      ],
      dirtyPaths: [],
      packageManager: 'bun',
    });
    expect(plan.kind).toBe('skip');
    expect(plan.kind === 'skip' && plan.reason).toContain(
      'the sweep changed none of package.json, bun.lock, bun.lockb',
    );
  });

  test("another manager's lockfile is not this manager's trigger", () => {
    expect(
      planPrimaryInstall({
        changedFiles: ['bun.lock'],
        dirtyPaths: [],
        packageManager: 'npm',
      }),
    ).toMatchObject({kind: 'skip'});
  });

  test('a locally dirty package.json in the primary defers the install, and says what to run later', () => {
    const plan = planPrimaryInstall({
      changedFiles: ['package.json'],
      dirtyPaths: ['package.json', 'src/other.ts'],
      packageManager: 'bun',
    });
    expect(plan.kind).toBe('skip');
    expect(plan.kind === 'skip' && plan.reason).toContain(
      'locally dirty in the primary: package.json',
    );
    expect(plan.kind === 'skip' && plan.reason).toContain(
      'bun install --frozen-lockfile',
    );
  });

  test('a locally dirty LOCKFILE defers it too', () => {
    const plan = planPrimaryInstall({
      changedFiles: ['package.json', 'bun.lock'],
      dirtyPaths: ['bun.lock'],
      packageManager: 'bun',
    });
    expect(plan.kind).toBe('skip');
    expect(plan.kind === 'skip' && plan.reason).toContain(
      'locally dirty in the primary: bun.lock',
    );
  });

  test('an undetectable package manager is a NAMED skip, never a silent one', () => {
    const plan = planPrimaryInstall({
      changedFiles: ['package.json'],
      dirtyPaths: [],
      packageManager: null,
    });
    expect(plan.kind).toBe('skip');
    expect(plan.kind === 'skip' && plan.reason).toBe(
      'no frozen install recipe for an undetectable package manager',
    );
  });

  test('frozenInstallRecipe has no recipe for a null manager', () => {
    expect(frozenInstallRecipe(null)).toBeNull();
    expect(frozenInstallRecipe('bun')).toEqual([
      'bun',
      'install',
      '--frozen-lockfile',
    ]);
  });
});

// ---------------------------------------------------------------------------
// The effectful half (D3/D4) — real repos, real bun, no network
// ---------------------------------------------------------------------------

/**
 * A committed repo with ONE local `file:` dependency, already installed, so it
 * holds a real bun.lock that matches its package.json.
 */
function repoWithLockfile(sb: Sandbox, name: string): string {
  const repo = initRepo(sb, name, {
    '.gitignore': 'node_modules/\n',
    'dep/package.json': '{"name":"fixture-dep","version":"1.0.0"}\n',
    'package.json':
      JSON.stringify(
        {
          dependencies: {'fixture-dep': 'file:./dep'},
          name,
          version: '0.0.1',
        },
        null,
        2,
      ) + '\n',
  });
  // stderr piped, not inherited: bun's "Saved lockfile" is fixture setup noise,
  // and it would otherwise print into the middle of the suite's output.
  execFileSync('bun', ['install'], {
    cwd: repo,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  execFileSync('git', ['add', '-A'], {cwd: repo});
  execFileSync('git', ['commit', '-qm', 'lockfile'], {cwd: repo});
  return repo;
}

describe('installInPrimary — what actually happens in the primary', () => {
  test('a manifest-changing sweep really installs, and says so in one clause', () => {
    const sb = track(createSandbox());
    const repo = repoWithLockfile(sb, 'installs');

    const result = installInPrimary(repo, ['package.json', 'bun.lock']);

    expect(result.ok).toBe(true);
    expect(result.note).toBe(', primary installed');
    expect(existsSync(join(repo, 'node_modules', 'fixture-dep'))).toBe(true);
    // Nothing new is dirty: node_modules is gitignored, and a FROZEN install
    // cannot have rewritten the lockfile.
    expect(
      execFileSync('git', ['status', '--porcelain'], {
        cwd: repo,
        encoding: 'utf-8',
      }),
    ).toBe('');
  });

  test('a component-only sweep skips, and the clause says why', () => {
    const sb = track(createSandbox());
    const repo = repoWithLockfile(sb, 'skips');

    const result = installInPrimary(repo, ['.gitignore']);

    expect(result.ok).toBe(true);
    expect(result.note).toContain(', primary install skipped: ');
    expect(result.note).toContain('node_modules is still valid');
  });

  test('a lockfile the manifest has outgrown FAILS loudly instead of re-locking', () => {
    const sb = track(createSandbox());
    const repo = repoWithLockfile(sb, 'drifted');
    // A second dependency the committed lockfile has never seen. `--frozen-lockfile`
    // must refuse it rather than rewrite the lockfile the sweep just committed.
    mkdirSync(join(repo, 'dep2'), {recursive: true});
    writeFileSync(
      join(repo, 'dep2', 'package.json'),
      '{"name":"fixture-dep2","version":"1.0.0"}\n',
    );
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify(
        {
          dependencies: {
            'fixture-dep': 'file:./dep',
            'fixture-dep2': 'file:./dep2',
          },
          name: 'drifted',
          version: '0.0.1',
        },
        null,
        2,
      ) + '\n',
    );
    execFileSync('git', ['add', '-A'], {cwd: repo});
    execFileSync('git', ['commit', '-qm', 'drift'], {cwd: repo});

    const result = installInPrimary(repo, ['package.json']);

    expect(result.ok).toBe(false);
    expect(result.note).toContain('PRIMARY INSTALL FAILED');
    expect(result.note).toContain('still executes the OLD SDK');
    expect(result.note).toContain('bun install --frozen-lockfile');
    // The evidence reaches the operator, not just an exit code.
    expect(result.output).toContain('lockfile is frozen');
    // And the lockfile the sweep committed is untouched.
    expect(
      execFileSync('git', ['status', '--porcelain', 'bun.lock'], {
        cwd: repo,
        encoding: 'utf-8',
      }),
    ).toBe('');
  });
});

// ---------------------------------------------------------------------------
// The dry run (D5)
// ---------------------------------------------------------------------------

async function captureLog<T>(
  fn: () => Promise<T>,
): Promise<{value: T; out: string}> {
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

describe('the dry run says the install would follow', () => {
  test('a bun repo plans the frozen install, with the condition it depends on', async () => {
    const sb = track(createSandbox());
    const repo = repoWithLockfile(sb, 'planned');

    const {out} = await captureLog(() =>
      runSweep({dryRun: true, repos: [repo]}),
    );

    expect(out).toContain(
      'would then `bun install --frozen-lockfile` in the primary, if package.json or the lockfile change',
    );
  });

  test('a repo with nothing to install says THAT, rather than saying nothing', async () => {
    const sb = track(createSandbox());
    const repo = initRepo(sb, 'no-manifest', {'README.md': '# no manifest\n'});

    const {out} = await captureLog(() =>
      runSweep({dryRun: true, repos: [repo]}),
    );

    expect(out).toContain('would NOT install in the primary');
    expect(out).toContain('no lockfile and no package.json');
  });
});
