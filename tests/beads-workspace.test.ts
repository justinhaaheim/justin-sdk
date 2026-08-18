/**
 * home-base-o33r — the sweep must never rewrite a repo's .beads/config.yaml.
 *
 * The bug: `stepInitBeads` decided "does this project have a beads workspace?"
 * by `existsSync('.beads/beads.db')`. `*.db` is gitignored, so that file is
 * absent from EVERY worktree and every fresh clone — the guard read "no beads
 * workspace" when the true fact was "the database is not tracked". It then ran
 * `br init --prefix <basename(projectRoot)>` (= `sdk-sweep` in a sweep
 * worktree) and overwrote config.yaml from a template.
 *
 * Fixtures are REAL git repos with REAL linked worktrees, because the behavior
 * under test IS git behavior: which files git checks out into a worktree, and
 * what `--git-common-dir` answers there. Mocking either would test nothing.
 *
 * Tests that need `br` on PATH are gated on `hasBr` — the ones that matter most
 * (nothing is touched) never reach `br init` at all.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {execSync} from 'child_process';
import {existsSync, readFileSync} from 'fs';
import {join} from 'path';

import {
  detectBeadsWorkspace,
  deriveBeadsPrefix,
  mainCheckoutRoot,
  mergeBeadsSyncConfig,
  runBeadsSetup,
} from '../src/beads-setup';
import {kebabCase} from '../src/setup-helpers';
import {beadsConfigGuard} from '../src/sweep';
import {addLinkedWorktree, git, initRepo} from './git-fixtures';
import {createSandbox, type Sandbox} from './sandbox';

/**
 * Resolved at MODULE LOAD, not in beforeAll, so `test.skipIf` can use it — a
 * br-less machine must report these as SKIPPED, never as green (`if (!hasBr)
 * return` inside the body is the silence-shaped lie critical rule 5 forbids).
 */
const hasBr = ((): boolean => {
  try {
    execSync('br --version', {stdio: ['pipe', 'pipe', 'pipe']});
    return true;
  } catch {
    return false;
  }
})();

const sandboxes: Sandbox[] = [];

function track(sandbox: Sandbox): Sandbox {
  sandboxes.push(sandbox);
  return sandbox;
}

afterEach(() => {
  while (sandboxes.length > 0) {
    const sb = sandboxes.pop();
    sb?.cleanup();
  }
});

/**
 * A repo whose beads prefix is deliberately NOT its directory name — the
 * browser-automation-central shape (`bac` in a dir called
 * `browser-automation-central`). Any fix that re-derives the prefix from a
 * directory name writes a THIRD wrong value here, which is the point.
 */
const BAC_CONFIG = `# Beads Project Configuration
issue_prefix: bac
default_priority: 2
default_type: task

# Sync behavior
sync:
  auto_import: true
  auto_flush: true
`;

function makeBeadsRepo(
  sb: Sandbox,
  dirName: string,
  config: string = BAC_CONFIG,
): string {
  return initRepo(sb, dirName, {
    '.beads/.gitignore': '*.db\n*.db-shm\n*.db-wal\n.br_recovery/\n',
    '.beads/config.yaml': config,
    '.beads/issues.jsonl':
      JSON.stringify({id: 'bac-1', title: 'a real issue'}) + '\n',
    '.beads/metadata.json': JSON.stringify({
      database: 'beads.db',
      jsonl_export: 'issues.jsonl',
    }),
    'package.json': JSON.stringify({name: dirName, version: '0.0.1'}, null, 2),
  });
}

const configPathOf = (root: string): string =>
  join(root, '.beads', 'config.yaml');

// ---------------------------------------------------------------------------
// The tracked-artifact fact the whole bug rests on
// ---------------------------------------------------------------------------

describe('o33r — worktrees carry the config but never the database', () => {
  test('a linked worktree has .beads/config.yaml and NO beads.db', () => {
    const sb = track(createSandbox());
    const primary = makeBeadsRepo(sb, 'browser-automation-central');
    const wt = addLinkedWorktree(
      primary,
      join(primary, '.claude', 'worktrees', 'sdk-sweep'),
      'worktree-sdk-sweep',
    );

    expect(existsSync(join(wt, '.beads', 'config.yaml'))).toBe(true);
    expect(existsSync(join(wt, '.beads', 'issues.jsonl'))).toBe(true);
    // The premise of the bug: this is false, and it does NOT mean "no beads".
    expect(existsSync(join(wt, '.beads', 'beads.db'))).toBe(false);
  });

  test('detectBeadsWorkspace calls that state tracked-not-hydrated, not none', () => {
    const sb = track(createSandbox());
    const primary = makeBeadsRepo(sb, 'browser-automation-central');
    const wt = addLinkedWorktree(
      primary,
      join(primary, '.claude', 'worktrees', 'sdk-sweep'),
      'worktree-sdk-sweep',
    );

    const state = detectBeadsWorkspace(wt);
    expect(state.kind).toBe('tracked-not-hydrated');
  });

  test('a directory with no .beads/ at all is still "none"', () => {
    const sb = track(createSandbox());
    const repo = initRepo(sb, 'fresh-project', {'package.json': '{}\n'});
    expect(detectBeadsWorkspace(repo).kind).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// AC1 + AC2 — config.yaml comes out byte-identical
// ---------------------------------------------------------------------------

describe('o33r AC1/AC2 — beads-setup leaves a committed config untouched', () => {
  test.skipIf(!hasBr)(
    'AC1: primary checkout, prefix != dirname, no db → byte-identical',
    async () => {
      const sb = track(createSandbox());
      const repo = makeBeadsRepo(sb, 'browser-automation-central');
      const before = readFileSync(configPathOf(repo), 'utf-8');

      const exitCode = await runBeadsSetup({
        noCommit: true,
        projectRoot: repo,
        quiet: true,
      });

      expect(exitCode).toBe(0);
      const after = readFileSync(configPathOf(repo), 'utf-8');
      expect(after).toBe(before);
      expect(after).toContain('issue_prefix: bac');
      expect(after).not.toContain('browser-automation-central');
    },
  );

  test.skipIf(!hasBr)(
    'AC2: inside a .claude/worktrees/sdk-sweep worktree → byte-identical',
    async () => {
      const sb = track(createSandbox());
      const primary = makeBeadsRepo(sb, 'browser-automation-central');
      const wt = addLinkedWorktree(
        primary,
        join(primary, '.claude', 'worktrees', 'sdk-sweep'),
        'worktree-sdk-sweep',
      );
      const before = readFileSync(configPathOf(wt), 'utf-8');

      const exitCode = await runBeadsSetup({
        noCommit: true,
        projectRoot: wt,
        quiet: true,
      });

      expect(exitCode).toBe(0);
      const after = readFileSync(configPathOf(wt), 'utf-8');
      expect(after).toBe(before);
      // The exact corruption that shipped to five repos.
      expect(after).toContain('issue_prefix: bac');
      expect(after).not.toContain('sdk-sweep');
      // And the collateral: .beads/ was not deleted and rebuilt.
      expect(readFileSync(join(wt, '.beads', '.gitignore'), 'utf-8')).toContain(
        '.br_recovery/',
      );
      expect(existsSync(join(wt, '.beads', 'issues.jsonl'))).toBe(true);
    },
  );

  test.skipIf(!hasBr)(
    'AC2b: the worktree is left with no git-visible change at all',
    async () => {
      const sb = track(createSandbox());
      const primary = makeBeadsRepo(sb, 'browser-automation-central');
      const wt = addLinkedWorktree(
        primary,
        join(primary, '.claude', 'worktrees', 'sdk-sweep'),
        'worktree-sdk-sweep',
      );

      await runBeadsSetup({noCommit: true, projectRoot: wt, quiet: true});

      const porcelain = git(wt, ['status', '--porcelain', '--', '.beads']);
      expect(porcelain.trim()).toBe('');
    },
  );
});

// ---------------------------------------------------------------------------
// AC3 — a genuinely uninitialized project still initializes, from the REPO root
// ---------------------------------------------------------------------------

describe('o33r AC3 — identity comes from the main checkout, not the checkout dir', () => {
  test('mainCheckoutRoot resolves the primary from inside a worktree', () => {
    const sb = track(createSandbox());
    const primary = initRepo(sb, 'my-real-repo', {'package.json': '{}\n'});
    const wt = addLinkedWorktree(
      primary,
      join(primary, '.claude', 'worktrees', 'sdk-sweep'),
      'worktree-sdk-sweep',
    );

    expect(mainCheckoutRoot(wt)).toBe(primary);
    expect(mainCheckoutRoot(primary)).toBe(primary);
  });

  test('deriveBeadsPrefix in a worktree yields the REPO name (negative control: basename would not)', () => {
    const sb = track(createSandbox());
    const primary = initRepo(sb, 'my-real-repo', {'package.json': '{}\n'});
    const wt = addLinkedWorktree(
      primary,
      join(primary, '.claude', 'worktrees', 'sdk-sweep'),
      'worktree-sdk-sweep',
    );

    const derived = deriveBeadsPrefix(wt);
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;
    expect(derived.prefix).toBe('my-real-repo');
    // NEGATIVE CONTROL, in-line: the old derivation is computed here and shown
    // to differ. If these two were ever equal this test would be vacuous.
    expect(wt.split('/').pop()).toBe('sdk-sweep');
    expect(derived.prefix).not.toBe(wt.split('/').pop());
  });

  test.skipIf(!hasBr)(
    'AC3: uninitialized worktree initializes with the repo prefix, not sdk-sweep',
    async () => {
      const sb = track(createSandbox());
      const primary = initRepo(sb, 'my-real-repo', {
        'package.json': JSON.stringify({name: 'my-real-repo'}, null, 2),
      });
      const wt = addLinkedWorktree(
        primary,
        join(primary, '.claude', 'worktrees', 'sdk-sweep'),
        'worktree-sdk-sweep',
      );

      const exitCode = await runBeadsSetup({
        noCommit: true,
        projectRoot: wt,
        quiet: true,
      });

      expect(exitCode).toBe(0);
      const config = readFileSync(configPathOf(wt), 'utf-8');
      expect(config).toContain('issue_prefix: my-real-repo');
      expect(config).not.toContain('issue_prefix: sdk-sweep');
      // And the sync keys still got configured on the genuinely-new workspace.
      expect(config).toContain('auto_import: true');
      expect(config).toContain('auto_flush: true');
    },
  );

  test('a non-git directory keeps using its own basename (measured, not a guess)', () => {
    const sb = track(createSandbox());
    const derived = deriveBeadsPrefix(sb.path);
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;
    expect(derived.prefix).toBe(kebabCase(sb.path.split('/').pop() ?? ''));
  });
});

// ---------------------------------------------------------------------------
// Targeted config merge (fix shape 3)
// ---------------------------------------------------------------------------

describe('o33r — mergeBeadsSyncConfig is a merge, never a template render', () => {
  test('preserves issue_prefix and every unrelated key', () => {
    const original = `# Beads Project Configuration
issue_prefix: voice-recorder
default_priority: 1
default_type: bug
some_local_key: kept
`;
    const merged = mergeBeadsSyncConfig(original);
    expect(merged).toContain('issue_prefix: voice-recorder');
    expect(merged).toContain('default_priority: 1');
    expect(merged).toContain('default_type: bug');
    expect(merged).toContain('some_local_key: kept');
    expect(merged).toContain('auto_import: true');
    expect(merged).toContain('auto_flush: true');
  });

  test('idempotent: a config that already has both keys is unchanged', () => {
    expect(mergeBeadsSyncConfig(BAC_CONFIG)).toBe(BAC_CONFIG);
  });

  test('fills in only the missing key inside an existing sync block', () => {
    const original = `issue_prefix: bac
sync:
  auto_flush: true
`;
    const merged = mergeBeadsSyncConfig(original);
    expect(merged).toBe(`issue_prefix: bac
sync:
  auto_flush: true
  auto_import: true
`);
  });

  test('flips an explicitly-disabled key rather than duplicating it', () => {
    const original = `issue_prefix: bac
sync:
  auto_import: false
  auto_flush: false
`;
    const merged = mergeBeadsSyncConfig(original);
    expect(merged).toContain('auto_import: true');
    expect(merged).toContain('auto_flush: true');
    expect(merged).not.toContain('false');
    expect(merged.match(/auto_import/g)?.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AC5 defence in depth — the sweep guard
// ---------------------------------------------------------------------------

describe('o33r AC5 — a full sweep touching .beads/config.yaml is a hard stop', () => {
  test('full mode + config.yaml in the staged set → not ok', () => {
    const result = beadsConfigGuard({mode: 'full'}, [
      'package.json',
      '.beads/config.yaml',
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.offenders).toEqual(['.beads/config.yaml']);
    expect(result.reason).toContain('home-base-o33r');
  });

  test('full mode without it → ok (the guard is not blanket-refusing)', () => {
    expect(
      beadsConfigGuard({mode: 'full'}, [
        'package.json',
        '.beads/issues.jsonl',
        'bun.lock',
      ]).ok,
    ).toBe(true);
  });

  test('nested workspace member config.yaml is caught too', () => {
    expect(
      beadsConfigGuard({mode: 'full'}, ['packages/api/.beads/config.yaml']).ok,
    ).toBe(false);
  });

  test('component mode is deliberately exempt', () => {
    expect(
      beadsConfigGuard({component: 'beads', mode: 'component'}, [
        '.beads/config.yaml',
      ]).ok,
    ).toBe(true);
  });
});
