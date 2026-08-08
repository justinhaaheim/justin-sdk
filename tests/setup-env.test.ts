/**
 * Tests for `justin-sdk setup-env` (the hydration engine) and
 * `justin-sdk worktree-new`.
 *
 * Fixtures are real git repos in $TMPDIR — the behavior under test IS git
 * behavior (worktree admin files, `check-ignore`'s index awareness,
 * `--git-common-dir`), so mocking git would test nothing. The fixture builders
 * live in ./git-fixtures, shared with tests/worktree-hydration.test.ts.
 *
 * The stdout-purity tests spawn the real CLI as a subprocess. That is the only
 * way to prove the contract (stdout empty for setup-env, exactly one path
 * line for worktree-new) end-to-end, including yargs registration.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {spawnSync} from 'child_process';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'fs';
import {dirname, join, resolve} from 'path';

import {
  detectPackageManager,
  discoverHydrationScripts,
  formatMiseFailureDetail,
  parseSubmoduleStatus,
  planWorktreeIncludeCopies,
  probeSubmodules,
  resolvePrimaryCheckout,
  setupEnv,
  WORKTREE_INCLUDE_FILE,
  type StepReport,
} from '../src/setup-env';
import {worktreeNew} from '../src/worktree-new';
import {
  addLinkedWorktree,
  addSubmodule,
  git,
  initPrimary,
  initRepo,
  withFileSubmodulesAllowed,
  write,
} from './git-fixtures';
import {createSandbox, type Sandbox} from './sandbox';

const CLI = resolve(import.meta.dirname, '..', 'src', 'cli.ts');

const sandboxes: Sandbox[] = [];

function track(sb: Sandbox): Sandbox {
  sandboxes.push(sb);
  return sb;
}

afterEach(() => {
  while (sandboxes.length > 0) {
    const sb = sandboxes.pop();
    if (sb == null) continue;
    // Linked worktrees hold admin files in the primary's .git; the whole tree
    // goes away together, so a plain recursive remove is enough.
    sb.cleanup();
  }
});

function statuses(steps: StepReport[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of steps) out[s.label] = s.status;
  return out;
}

function detailFor(steps: StepReport[], label: string): string {
  return steps.find((s) => s.label === label)?.detail ?? '';
}

/**
 * Capture what the module writes to stderr via its own `report()`. Needed for
 * the F3 advisory lines, which are deliberately NOT StepReports (there is no
 * 'warn' StepStatus, and inventing one would change the done/skipped/failed
 * summary counts). Child-process output goes straight to fd 2 and so is not
 * captured here — only our own report lines are, which is exactly the scope.
 */
function captureStderr<T>(fn: () => T): {result: T; stderr: string} {
  const original = process.stderr.write;
  let captured = '';
  process.stderr.write = ((chunk: unknown): boolean => {
    captured += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return {result: fn(), stderr: captured};
  } finally {
    process.stderr.write = original;
  }
}

// ---------------------------------------------------------------------------
// Package manager detection
// ---------------------------------------------------------------------------

describe('detectPackageManager', () => {
  test.each([
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
    ['package-lock.json', 'npm'],
    ['yarn.lock', 'yarn'],
  ] as const)('%s → %s', (lockfile, expected) => {
    const sb = track(createSandbox());
    sb.writeFile(lockfile, '');
    expect(detectPackageManager(sb.path).packageManager).toBe(expected);
  });

  test('bun wins when several lockfiles are present', () => {
    const sb = track(createSandbox());
    sb.writeFile('yarn.lock', '');
    sb.writeFile('package-lock.json', '');
    sb.writeFile('bun.lock', '');
    expect(detectPackageManager(sb.path).packageManager).toBe('bun');
  });

  test('package.json with no lockfile defaults to bun, and says so', () => {
    const sb = track(createSandbox());
    sb.writeFile('package.json', '{}');
    const detection = detectPackageManager(sb.path);
    expect(detection.packageManager).toBe('bun');
    expect(detection.reason).toContain('no lockfile');
  });

  test('no lockfile and no package.json → nothing to install', () => {
    const sb = track(createSandbox());
    expect(detectPackageManager(sb.path)).toEqual({
      packageManager: null,
      reason: 'no lockfile and no package.json',
    });
  });
});

// ---------------------------------------------------------------------------
// setup-env:<LABEL> discovery
// ---------------------------------------------------------------------------

describe('discoverHydrationScripts', () => {
  test('preserves package.json declaration order, not label order', () => {
    const sb = track(createSandbox());
    sb.writeFile(
      'package.json',
      JSON.stringify({
        scripts: {
          'setup-env:ZEBRA': 'true',
          build: 'true',
          'setup-env:ALPHA': 'true',
          'setup-env:MIDDLE': 'true',
        },
      }),
    );
    expect(discoverHydrationScripts(sb.path).map((s) => s.label)).toEqual([
      'ZEBRA',
      'ALPHA',
      'MIDDLE',
    ]);
  });

  test('the bare setup-env alias (no colon) is NOT discovered — running it would recurse', () => {
    const sb = track(createSandbox());
    sb.writeFile(
      'package.json',
      JSON.stringify({
        scripts: {
          'setup-env': 'bunx @justinhaaheim/justin-sdk setup-env',
          'setup-env:REAL': 'true',
        },
      }),
    );
    expect(discoverHydrationScripts(sb.path)).toEqual([
      {label: 'REAL', legacy: false, name: 'setup-env:REAL'},
    ]);
  });

  test('a v170 worktree-source: script is surfaced as legacy, not dropped', () => {
    const sb = track(createSandbox());
    sb.writeFile(
      'package.json',
      JSON.stringify({
        scripts: {
          'worktree-source:lint:VERSION': 'true',
          'worktree-source:web:THING': 'true',
        },
      }),
    );
    expect(discoverHydrationScripts(sb.path)).toEqual([
      {label: 'VERSION', legacy: true, name: 'worktree-source:lint:VERSION'},
      {label: 'THING', legacy: true, name: 'worktree-source:web:THING'},
    ]);
  });

  test('empty labels are ignored', () => {
    const sb = track(createSandbox());
    sb.writeFile(
      'package.json',
      JSON.stringify({
        scripts: {
          'setup-env:': 'true',
        },
      }),
    );
    expect(discoverHydrationScripts(sb.path)).toEqual([]);
  });

  test('no package.json → no scripts', () => {
    const sb = track(createSandbox());
    expect(discoverHydrationScripts(sb.path)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Primary checkout resolution (epic AC #9)
// ---------------------------------------------------------------------------

describe('resolvePrimaryCheckout', () => {
  test('non-git directory → null', () => {
    const sb = track(createSandbox());
    expect(resolvePrimaryCheckout(sb.path)).toBeNull();
  });

  test('the primary checkout resolves to itself', () => {
    const sb = track(createSandbox());
    const primary = initPrimary(sb, {'a.txt': 'a\n'});
    expect(resolvePrimaryCheckout(primary)).toBe(primary);
  });

  test('from a linked worktree it resolves via git, NOT parent-dir math', () => {
    const sb = track(createSandbox());
    const primary = initPrimary(sb, {'a.txt': 'a\n'});
    // Deliberately nowhere near the primary: parent-dir or cwd arithmetic would
    // yield `<sandbox>/elsewhere/deep`, which is not a checkout at all.
    const linked = addLinkedWorktree(
      primary,
      join(sb.path, 'elsewhere', 'deep', 'wt'),
      'worktree-probe',
    );
    expect(resolvePrimaryCheckout(linked)).toBe(primary);
    expect(resolvePrimaryCheckout(linked)).not.toBe(dirname(linked));
  });

  test('from a subdirectory of a linked worktree it still resolves', () => {
    const sb = track(createSandbox());
    const primary = initPrimary(sb, {'nested/a.txt': 'a\n'});
    const linked = addLinkedWorktree(
      primary,
      join(sb.path, 'elsewhere', 'wt'),
      'worktree-probe',
    );
    expect(resolvePrimaryCheckout(join(linked, 'nested'))).toBe(primary);
  });
});

// ---------------------------------------------------------------------------
// .worktreeinclude (D4)
// ---------------------------------------------------------------------------

describe('planWorktreeIncludeCopies', () => {
  test('no .worktreeinclude is fine — nothing planned', () => {
    const sb = track(createSandbox());
    const primary = initPrimary(sb, {'.gitignore': '.env.local\n'});
    const target = join(sb.path, 'target');
    mkdirSync(target);
    const plan = planWorktreeIncludeCopies(primary, target);
    expect(plan.hasManifest).toBe(false);
    expect(plan.entries).toEqual([]);
  });

  test('plans a copy for a gitignored file that matches', () => {
    const sb = track(createSandbox());
    const primary = initPrimary(sb, {
      '.gitignore': '.env.local\n',
      '.worktreeinclude': '.env.local\n',
    });
    write(primary, '.env.local', 'SIM=1\n');
    const target = join(sb.path, 'target');
    mkdirSync(target);
    expect(planWorktreeIncludeCopies(primary, target).entries).toEqual([
      {action: 'copy', relPath: '.env.local'},
    ]);
  });

  test('a file already in the target is skipped, never clobbered', () => {
    const sb = track(createSandbox());
    const primary = initPrimary(sb, {
      '.gitignore': '.env.local\n',
      '.worktreeinclude': '.env.local\n',
    });
    write(primary, '.env.local', 'FROM_PRIMARY\n');
    const target = join(sb.path, 'target');
    mkdirSync(target);
    write(target, '.env.local', 'LOCAL_EDIT\n');
    expect(planWorktreeIncludeCopies(primary, target).entries).toEqual([
      {action: 'skip-exists', relPath: '.env.local'},
    ]);
  });

  test('a TRACKED file matching the manifest is never a copy candidate', () => {
    const sb = track(createSandbox());
    // config.json is force-added, so it is TRACKED *and* matched by the
    // `*.json` ignore pattern. Only an index-aware `git check-ignore` (i.e.
    // WITHOUT --no-index) rejects it — this is the assertion that pins that
    // flag choice, and it mirrors Claude Code's rule that tracked files are
    // never duplicated into a worktree.
    const primary = initPrimary(
      sb,
      {
        '.gitignore': '*.json\nignored.txt\n',
        '.worktreeinclude': 'config.json\nignored.txt\n',
        'config.json': '{"tracked":true}\n',
      },
      {forceAdd: ['config.json']},
    );
    write(primary, 'ignored.txt', 'ignored\n');
    const target = join(sb.path, 'target');
    mkdirSync(target);
    // Sanity-check the fixture itself: config.json really is tracked, and the
    // matcher really does match it — so the only thing excluding it is git.
    expect(git(primary, ['ls-files', '--', 'config.json']).trim()).toBe(
      'config.json',
    );
    expect(
      planWorktreeIncludeCopies(primary, target).entries.map((e) => e.relPath),
    ).toEqual(['ignored.txt']);
  });

  test('a gitignored file that does NOT match the manifest is not copied', () => {
    const sb = track(createSandbox());
    const primary = initPrimary(sb, {
      '.gitignore': '.env.local\nscratch.log\n',
      '.worktreeinclude': '.env.local\n',
    });
    write(primary, '.env.local', 'SIM=1\n');
    write(primary, 'scratch.log', 'noise\n');
    const target = join(sb.path, 'target');
    mkdirSync(target);
    expect(
      planWorktreeIncludeCopies(primary, target).entries.map((e) => e.relPath),
    ).toEqual(['.env.local']);
  });

  test('finds a literal match nested inside a wholly-ignored directory', () => {
    const sb = track(createSandbox());
    // `git ls-files --directory` collapses ios/ to one entry and we do not
    // descend into it, so this file is only reachable via the literal-pattern
    // candidate path.
    const primary = initPrimary(sb, {
      '.gitignore': 'ios/\n',
      '.worktreeinclude': 'ios/.xcode.env.local\n',
    });
    write(primary, 'ios/.xcode.env.local', 'export NODE_BINARY=node\n');
    write(primary, 'ios/Podfile', 'noise\n');
    const target = join(sb.path, 'target');
    mkdirSync(target);
    expect(planWorktreeIncludeCopies(primary, target).entries).toEqual([
      {action: 'copy', relPath: 'ios/.xcode.env.local'},
    ]);
  });

  test('a `./`-prefixed manifest line does not crash (and matches nothing, like git)', () => {
    const sb = track(createSandbox());
    // Two separate facts here, both verified:
    //  1. `ignore`'s matcher THROWS a RangeError on a './'-prefixed path, so
    //     without normalizing the CANDIDATE this line takes the command down.
    //  2. git itself does NOT match `foo` with the pattern `./foo` (verified
    //     directly: `git check-ignore` exits 1 and `git status` still shows the
    //     file as untracked). So the correct outcome is "no crash, no match" —
    //     normalizing must not invent a match the manifest didn't express.
    const primary = initPrimary(sb, {
      '.gitignore': '.env.local\n',
      '.worktreeinclude': './.env.local\n',
    });
    write(primary, '.env.local', 'SIM=1\n');
    const target = join(sb.path, 'target');
    mkdirSync(target);
    expect(() => planWorktreeIncludeCopies(primary, target)).not.toThrow();
    expect(planWorktreeIncludeCopies(primary, target).entries).toEqual([]);
  });

  test('a manifest line escaping the repo is rejected, not thrown on', () => {
    const sb = track(createSandbox());
    const primary = initPrimary(sb, {
      '.gitignore': '.env.local\n',
      '.worktreeinclude': '../outside.txt\n/etc/hosts\n..\n\n',
    });
    // A real file at the escaping path, so it is only excluded by the guard.
    write(sb.path, 'outside.txt', 'nope\n');
    const target = join(sb.path, 'target');
    mkdirSync(target);
    expect(() => planWorktreeIncludeCopies(primary, target)).not.toThrow();
    expect(planWorktreeIncludeCopies(primary, target).entries).toEqual([]);
    expect(existsSync(join(sb.path, 'outside.txt'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // F3: per-pattern accounting for lines that contributed nothing
  // -------------------------------------------------------------------------

  test('reports a directory-naming line and a no-match glob as unmatched', () => {
    const sb = track(createSandbox());
    const primary = initPrimary(sb, {
      '.gitignore': 'ios/\n.env.local\n',
      // `ios/` can NEVER match: this step copies files, not trees, and
      // `ls-files --directory` collapses the whole tree to one skipped entry.
      // `*.nothing` is a well-formed glob that simply matches no file.
      '.worktreeinclude': 'ios/\n*.nothing\n.env.local\n',
    });
    write(primary, '.env.local', 'SIM=1\n');
    write(primary, 'ios/Podfile', 'noise\n');
    const target = join(sb.path, 'target');
    mkdirSync(target);

    const plan = planWorktreeIncludeCopies(primary, target);
    expect(plan.entries).toEqual([{action: 'copy', relPath: '.env.local'}]);
    // The line that DID contribute is not listed; the two that did not, are.
    expect(plan.unmatchedPatterns).toEqual(['ios/', '*.nothing']);
  });

  test('comment and negation lines are never reported as unmatched', () => {
    const sb = track(createSandbox());
    const primary = initPrimary(sb, {
      '.gitignore': '*.local\n',
      '.worktreeinclude': '# a comment\n\n*.local\n!secret.local\n',
    });
    write(primary, 'keep.local', 'keep\n');
    write(primary, 'secret.local', 'nope\n');
    const target = join(sb.path, 'target');
    mkdirSync(target);
    expect(
      planWorktreeIncludeCopies(primary, target).unmatchedPatterns,
    ).toEqual([]);
  });

  test('a pattern that only matches a TRACKED file is reported as unmatched', () => {
    const sb = track(createSandbox());
    // The subtle real-world case: the line looks right, the file exists, but a
    // tracked file is never copied — so the pattern delivers nothing and the
    // report has to say so.
    const primary = initPrimary(
      sb,
      {
        '.gitignore': '*.json\n',
        '.worktreeinclude': 'config.json\n',
        'config.json': '{"tracked":true}\n',
      },
      {forceAdd: ['config.json']},
    );
    const target = join(sb.path, 'target');
    mkdirSync(target);
    const plan = planWorktreeIncludeCopies(primary, target);
    expect(plan.entries).toEqual([]);
    expect(plan.unmatchedPatterns).toEqual(['config.json']);
  });

  test('a pattern jointly matching a copied file gets credit (no false warn)', () => {
    const sb = track(createSandbox());
    // `ios/` names the directory AND matches ios/.xcode.env.local, which the
    // literal line makes reachable. Both lines contributed, so neither warns —
    // this is what keeps the warning from crying wolf on real RN manifests.
    const primary = initPrimary(sb, {
      '.gitignore': 'ios/\n',
      '.worktreeinclude': 'ios/\nios/.xcode.env.local\n',
    });
    write(primary, 'ios/.xcode.env.local', 'export NODE_BINARY=node\n');
    const target = join(sb.path, 'target');
    mkdirSync(target);
    const plan = planWorktreeIncludeCopies(primary, target);
    expect(plan.entries).toEqual([
      {action: 'copy', relPath: 'ios/.xcode.env.local'},
    ]);
    expect(plan.unmatchedPatterns).toEqual([]);
  });

  test('manifest negation (!) is honored by the ignore parser', () => {
    const sb = track(createSandbox());
    const primary = initPrimary(sb, {
      '.gitignore': '*.local\n',
      '.worktreeinclude': '*.local\n!secret.local\n',
    });
    write(primary, 'keep.local', 'keep\n');
    write(primary, 'secret.local', 'nope\n');
    const target = join(sb.path, 'target');
    mkdirSync(target);
    expect(
      planWorktreeIncludeCopies(primary, target).entries.map((e) => e.relPath),
    ).toEqual(['keep.local']);
  });
});

// ---------------------------------------------------------------------------
// F4: the MISE failure detail
// ---------------------------------------------------------------------------

describe('formatMiseFailureDetail', () => {
  /**
   * Tested through the extracted formatter rather than a live failure: making
   * the real `mise trust` fail means either breaking the user's mise state or
   * removing mise from PATH, and this SDK's rule is that a detector/step must
   * never mutate machine state to be testable. What IS worth pinning is that the
   * sandbox cause survives — the whole point of F4 is that "exited 1" alone sent
   * the reader to debug mise instead of the sandbox.
   */
  test('names the exit code, the trusted-configs write, and the sandbox', () => {
    const detail = formatMiseFailureDetail(1, null);
    expect(detail).toContain('mise trust exited 1');
    expect(detail).toContain('~/.local/state/mise/trusted-configs');
    expect(detail).toContain('re-run outside the sandbox');
  });

  test('includes the spawn error when there is one', () => {
    expect(formatMiseFailureDetail(1, 'spawn mise ENOENT')).toContain(
      '(spawn mise ENOENT)',
    );
  });
});

// ---------------------------------------------------------------------------
// worktreeSetup
// ---------------------------------------------------------------------------

describe('worktreeSetup', () => {
  test('a project with no config runs the universal steps and succeeds', () => {
    const sb = track(createSandbox());
    const primary = initPrimary(sb, {'a.txt': 'a\n'});
    const linked = addLinkedWorktree(
      primary,
      join(sb.path, 'wt'),
      'worktree-probe',
    );
    const result = setupEnv({target: linked});
    expect(result.exitCode).toBe(0);
    expect(result.primary).toBe(primary);
    expect(statuses(result.steps)).toEqual({
      RESOLVE: 'done',
      MISE: 'skipped',
      SUBMODULES: 'skipped',
      INSTALL: 'skipped',
      WORKTREEINCLUDE: 'skipped',
      HYDRATE: 'skipped',
    });
    // AC2: the overwhelming majority of repos have no submodules, and they must
    // see a reason rather than a bare new line in the report.
    expect(detailFor(result.steps, 'SUBMODULES')).toBe('no .gitmodules');
  });

  test('running in the primary checkout is allowed and reports the no-op', () => {
    const sb = track(createSandbox());
    const primary = initPrimary(sb, {
      '.gitignore': '.env.local\n',
      '.worktreeinclude': '.env.local\n',
    });
    write(primary, '.env.local', 'SIM=1\n');
    const result = setupEnv({target: primary});
    expect(result.exitCode).toBe(0);
    expect(statuses(result.steps).WORKTREEINCLUDE).toBe('skipped');
    expect(detailFor(result.steps, 'WORKTREEINCLUDE')).toContain(
      'target is the primary checkout',
    );
    expect(detailFor(result.steps, 'RESOLVE')).toContain(
      'target IS the primary checkout',
    );
  });

  test('a non-existent target fails at RESOLVE with exit 1', () => {
    const sb = track(createSandbox());
    const result = setupEnv({target: join(sb.path, 'nope')});
    expect(result.exitCode).toBe(1);
    expect(result.steps).toHaveLength(1);
    expect(statuses(result.steps).RESOLVE).toBe('failed');
  });

  test('copies .worktreeinclude files into the worktree', () => {
    const sb = track(createSandbox());
    const primary = initPrimary(sb, {
      '.gitignore': '.env.local\ngen/\n',
      '.worktreeinclude': '.env.local\ngen/version.json\n',
    });
    write(primary, '.env.local', 'SIM=abc\n');
    write(primary, 'gen/version.json', '{"v":"1.2.3"}\n');
    const linked = addLinkedWorktree(
      primary,
      join(sb.path, 'wt'),
      'worktree-probe',
    );

    const result = setupEnv({target: linked});
    expect(result.exitCode).toBe(0);
    expect(statuses(result.steps).WORKTREEINCLUDE).toBe('done');
    expect(readFileSync(join(linked, '.env.local'), 'utf-8')).toBe('SIM=abc\n');
    expect(readFileSync(join(linked, 'gen/version.json'), 'utf-8')).toBe(
      '{"v":"1.2.3"}\n',
    );
  });

  /**
   * F3, end to end: the unmatched lines must actually reach the human, and must
   * NOT turn a working hydration into a failure. The directory-naming case gets
   * the actionable hint ("list files") because that is the one a real RN
   * manifest hits.
   */
  test('warns on stderr for each unmatched manifest line, exit still 0', () => {
    const sb = track(createSandbox());
    const primary = initPrimary(sb, {
      '.gitignore': 'ios/\n.env.local\n',
      '.worktreeinclude': 'ios/\n*.nothing\n.env.local\n',
    });
    write(primary, '.env.local', 'SIM=1\n');
    write(primary, 'ios/Podfile', 'noise\n');
    const linked = addLinkedWorktree(
      primary,
      join(sb.path, 'wt'),
      'worktree-probe',
    );

    const {result, stderr} = captureStderr(() => setupEnv({target: linked}));

    expect(result.exitCode).toBe(0);
    expect(statuses(result.steps).WORKTREEINCLUDE).toBe('done');
    expect(stderr).toContain(
      `${WORKTREE_INCLUDE_FILE} pattern 'ios/' matched no copyable files`,
    );
    expect(stderr).toContain('directories are not copied — list files');
    expect(stderr).toContain(
      `${WORKTREE_INCLUDE_FILE} pattern '*.nothing' matched no copyable files`,
    );
    // The line that worked is not maligned, and the copy still happened.
    expect(stderr).not.toContain(`pattern '.env.local'`);
    expect(readFileSync(join(linked, '.env.local'), 'utf-8')).toBe('SIM=1\n');
  });

  test('is idempotent: a second run succeeds and reports the files as present', () => {
    const sb = track(createSandbox());
    const primary = initPrimary(sb, {
      '.gitignore': '.env.local\n',
      '.worktreeinclude': '.env.local\n',
    });
    write(primary, '.env.local', 'SIM=abc\n');
    const linked = addLinkedWorktree(
      primary,
      join(sb.path, 'wt'),
      'worktree-probe',
    );

    const first = setupEnv({target: linked});
    expect(first.exitCode).toBe(0);
    expect(statuses(first.steps).WORKTREEINCLUDE).toBe('done');

    const second = setupEnv({target: linked});
    expect(second.exitCode).toBe(0);
    expect(statuses(second.steps).WORKTREEINCLUDE).toBe('skipped');
    expect(detailFor(second.steps, 'WORKTREEINCLUDE')).toContain(
      '1 already present',
    );
    // The local file was not clobbered by the second run.
    expect(readFileSync(join(linked, '.env.local'), 'utf-8')).toBe('SIM=abc\n');
  });

  test('--dry-run changes nothing but reports the full plan', () => {
    const sb = track(createSandbox());
    const primary = initPrimary(sb, {
      '.gitignore': '.env.local\n',
      '.worktreeinclude': '.env.local\n',
      'package.json': JSON.stringify({
        name: 'p',
        scripts: {'setup-env:MARK': 'sh -c "echo ran > ran.txt"'},
      }),
    });
    write(primary, '.env.local', 'SIM=abc\n');
    const linked = addLinkedWorktree(
      primary,
      join(sb.path, 'wt'),
      'worktree-probe',
    );

    const result = setupEnv({dryRun: true, target: linked});
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(linked, '.env.local'))).toBe(false);
    expect(existsSync(join(linked, 'ran.txt'))).toBe(false);
    expect(existsSync(join(linked, 'node_modules'))).toBe(false);
    expect(detailFor(result.steps, 'INSTALL')).toContain('dry-run: would run');
    expect(detailFor(result.steps, 'WORKTREEINCLUDE')).toContain(
      'would copy 1',
    );
    expect(detailFor(result.steps, 'HYDRATE:setup-env:MARK')).toContain(
      'dry-run: would run',
    );
  });

  describe('declaration order and legacy skip', () => {
    // ZEBRA is declared before ALPHA on purpose: a label-sorted runner (like
    // fix-source:) would invert them.
    const scripts = {
      'setup-env:ZEBRA': "sh -c 'echo zebra >> order.log'",
      'setup-env:ALPHA': "sh -c 'echo alpha >> order.log'",
      'worktree-source:native:LEGACY': "sh -c 'echo legacy >> order.log'",
    };

    function fixture(sb: Sandbox): {linked: string; primary: string} {
      const primary = initPrimary(sb, {
        'package.json': JSON.stringify({name: 'p', scripts}, null, 2),
      });
      const linked = addLinkedWorktree(
        primary,
        join(sb.path, 'wt'),
        'worktree-probe',
      );
      return {linked, primary};
    }

    function order(linked: string): string[] {
      const logPath = join(linked, 'order.log');
      if (!existsSync(logPath)) return [];
      return readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean);
    }

    test('runs setup-env: scripts in declaration order; legacy worktree-source: is skipped with a rename hint, NOT run', () => {
      const sb = track(createSandbox());
      const {linked} = fixture(sb);
      const result = setupEnv({target: linked});
      expect(result.exitCode).toBe(0);
      // legacy never executed — order.log has only the flat scripts, declared order
      expect(order(linked)).toEqual(['zebra', 'alpha']);
      expect(statuses(result.steps)).toMatchObject({
        'HYDRATE:setup-env:ZEBRA': 'done',
        'HYDRATE:setup-env:ALPHA': 'done',
        'HYDRATE:worktree-source:native:LEGACY': 'skipped',
      });
      expect(
        detailFor(result.steps, 'HYDRATE:worktree-source:native:LEGACY'),
      ).toContain('rename to setup-env:LEGACY');
    });
  });

  test('a failing hydration script stops the run and later scripts do not run', () => {
    const sb = track(createSandbox());
    const primary = initPrimary(sb, {
      'package.json': JSON.stringify({
        name: 'p',
        scripts: {
          'setup-env:FIRST': "sh -c 'echo first >> order.log'",
          'setup-env:BOOM': 'false',
          'setup-env:NEVER': "sh -c 'echo never >> order.log'",
        },
      }),
    });
    const linked = addLinkedWorktree(
      primary,
      join(sb.path, 'wt'),
      'worktree-probe',
    );

    const result = setupEnv({target: linked});
    expect(result.exitCode).toBe(1);
    expect(statuses(result.steps)['HYDRATE:setup-env:BOOM']).toBe('failed');
    expect(result.steps.some((s) => s.label.endsWith('NEVER'))).toBe(false);
    expect(readFileSync(join(linked, 'order.log'), 'utf-8')).toBe('first\n');
  });
});

// ---------------------------------------------------------------------------
// The SUBMODULES step (home-base-v170.7)
// ---------------------------------------------------------------------------

describe('parseSubmoduleStatus', () => {
  const SHA_A = 'a'.repeat(40);
  const SHA_B = 'b'.repeat(40);

  test('a leading `-` is the only "not initialized" signal', () => {
    // Verbatim shapes from git 2.x: the describe suffix is present for an
    // initialized submodule and absent for an uninitialized one.
    expect(
      parseSubmoduleStatus(
        [
          ` ${SHA_A} projects/ready (heads/main)`,
          `-${SHA_B} projects/empty`,
        ].join('\n'),
      ),
    ).toEqual({
      all: ['projects/ready', 'projects/empty'],
      uninitialized: ['projects/empty'],
    });
  });

  test('`+` and `U` mean initialized — this step initializes, it never reconciles', () => {
    expect(
      parseSubmoduleStatus(
        [
          `+${SHA_A} projects/moved (heads/other)`,
          `U${SHA_B} projects/conflicted`,
        ].join('\n'),
      ),
    ).toEqual({
      all: ['projects/moved', 'projects/conflicted'],
      uninitialized: [],
    });
  });

  test('paths containing spaces survive, and sha256 ids parse', () => {
    expect(
      parseSubmoduleStatus(
        [
          `-${'c'.repeat(64)} projects/my sdk`,
          ` ${SHA_A} projects/my sdk/nested (heads/main)`,
        ].join('\n'),
      ),
    ).toEqual({
      all: ['projects/my sdk', 'projects/my sdk/nested'],
      uninitialized: ['projects/my sdk'],
    });
  });

  test('empty output and unparseable noise yield nothing, never a throw', () => {
    expect(parseSubmoduleStatus('')).toEqual({all: [], uninitialized: []});
    expect(parseSubmoduleStatus('\n\n')).toEqual({all: [], uninitialized: []});
    expect(parseSubmoduleStatus('fatal: whatever')).toEqual({
      all: [],
      uninitialized: [],
    });
  });
});

describe('probeSubmodules', () => {
  test('no .gitmodules short-circuits to `none` (no subprocess, AC2)', () => {
    const sb = track(createSandbox());
    const primary = initPrimary(sb, {'a.txt': 'a\n'});
    expect(probeSubmodules(primary)).toEqual({kind: 'none'});
  });

  test('a .gitmodules with no matching index entry reports zero submodules', () => {
    const sb = track(createSandbox());
    const primary = initPrimary(sb, {
      '.gitmodules': '[submodule "ghost"]\n\tpath = ghost\n\turl = ./nope\n',
    });
    expect(probeSubmodules(primary)).toEqual({
      kind: 'known',
      status: {all: [], uninitialized: []},
    });
  });
});

/**
 * The regression fixture for home-base-v170.7, over REAL git: a repo whose bun
 * workspace member IS a submodule, plus a nested submodule one level deeper so
 * `--init --recursive` (AC6) is observable rather than asserted.
 *
 * `bun install` really runs here. That is the point — the bug was that install
 * DIED on the empty submodule directory, and only a real install can prove it
 * does not any more.
 */
describe('SUBMODULES over a real submodule-backed workspace', () => {
  function fixture(sb: Sandbox): {linked: string; primary: string} {
    // Deliberately NOT a JS package: it must not become a bun workspace member.
    const nested = initRepo(sb, 'nested-source', {'note.txt': 'nested\n'});
    const sub = initRepo(sb, 'sub-source', {
      'package.json': `${JSON.stringify({name: 'sub', version: '1.0.0'}, null, 2)}\n`,
    });
    addSubmodule(sub, nested, 'nested');

    const primary = initPrimary(sb, {
      '.gitignore': 'node_modules/\n',
      'package.json': `${JSON.stringify(
        {name: 'root', private: true, workspaces: ['projects/sub']},
        null,
        2,
      )}\n`,
    });
    addSubmodule(primary, sub, 'projects/sub');
    const linked = addLinkedWorktree(
      primary,
      join(sb.path, 'wt'),
      'worktree-probe',
    );
    return {linked, primary};
  }

  /**
   * Proves the fixture reproduces the ORIGINAL bug, so the tests below are not
   * vacuous: without submodule init, the install fails naming the WORKSPACE —
   * the misleading error the epic exists to kill. This is the permanent form of
   * the AC4 negative control.
   */
  test('the fixture reproduces the bug: bare `bun install` fails on the workspace', () => {
    const sb = track(createSandbox());
    const {linked} = fixture(sb);
    expect(existsSync(join(linked, 'projects', 'sub', 'package.json'))).toBe(
      false,
    );

    const install = spawnSync('bun', ['install'], {
      cwd: linked,
      encoding: 'utf-8',
    });
    expect(install.status).not.toBe(0);
    expect(`${install.stdout}${install.stderr}`).toContain(
      'Workspace not found',
    );
  });

  /**
   * REGRESSION, found by this suite: the probe originally read the status
   * through the trimming git helper, which deleted the leading SPACE that IS an
   * initialized submodule's status — silently losing the FIRST submodule listed.
   * The primary checkout is the ideal witness: `git submodule add` populates the
   * top-level submodule but does NOT recurse, so the initialized one comes first
   * and the uninitialized one second.
   */
  test('probeSubmodules keeps the leading-space status of the first submodule', () => {
    const sb = track(createSandbox());
    const {primary} = fixture(sb);
    expect(probeSubmodules(primary)).toEqual({
      kind: 'known',
      status: {
        all: ['projects/sub', 'projects/sub/nested'],
        uninitialized: ['projects/sub/nested'],
      },
    });
  });

  test('AC1/AC6: one invocation hydrates the tree, recursively, exit 0', () => {
    const sb = track(createSandbox());
    const {linked} = fixture(sb);

    const result = withFileSubmodulesAllowed(() => setupEnv({target: linked}));

    expect(result.exitCode).toBe(0);
    expect(statuses(result.steps).SUBMODULES).toBe('done');
    expect(statuses(result.steps).INSTALL).toBe('done');
    // AC2: ordered before install — the whole reason the step exists.
    expect(result.steps.map((s) => s.label).slice(0, 4)).toEqual([
      'RESOLVE',
      'MISE',
      'SUBMODULES',
      'INSTALL',
    ]);
    expect(detailFor(result.steps, 'SUBMODULES')).toContain(
      'git submodule update --init --recursive',
    );
    expect(detailFor(result.steps, 'SUBMODULES')).toContain(
      'uninitialized: 1 submodule (projects/sub)',
    );
    // The workspace member is populated, and so is ITS submodule (--recursive).
    expect(
      readFileSync(join(linked, 'projects', 'sub', 'package.json'), 'utf-8'),
    ).toContain('"name": "sub"');
    expect(
      readFileSync(
        join(linked, 'projects', 'sub', 'nested', 'note.txt'),
        'utf-8',
      ),
    ).toBe('nested\n');
    // And the install that used to die actually produced node_modules.
    expect(existsSync(join(linked, 'node_modules'))).toBe(true);
  });

  test('AC3: a second run reports skipped/already initialized, not done', () => {
    const sb = track(createSandbox());
    const {linked} = fixture(sb);

    expect(
      withFileSubmodulesAllowed(() => setupEnv({target: linked})).exitCode,
    ).toBe(0);

    const second = withFileSubmodulesAllowed(() => setupEnv({target: linked}));
    expect(second.exitCode).toBe(0);
    expect(statuses(second.steps).SUBMODULES).toBe('skipped');
    // Both levels counted, which is only true if the probe is recursive too.
    expect(detailFor(second.steps, 'SUBMODULES')).toBe(
      'already initialized — 2 submodules (projects/sub, projects/sub/nested)',
    );
  });

  test('--dry-run reports the would-run and initializes nothing', () => {
    const sb = track(createSandbox());
    const {linked} = fixture(sb);

    const result = withFileSubmodulesAllowed(() =>
      setupEnv({dryRun: true, target: linked}),
    );

    expect(result.exitCode).toBe(0);
    expect(statuses(result.steps).SUBMODULES).toBe('skipped');
    expect(detailFor(result.steps, 'SUBMODULES')).toContain(
      'dry-run: would run `git submodule update --init --recursive`',
    );
    expect(existsSync(join(linked, 'projects', 'sub', 'package.json'))).toBe(
      false,
    );
    expect(existsSync(join(linked, 'node_modules'))).toBe(false);
  });

  test('a failing submodule init stops the run before install (never a misleading workspace error)', () => {
    const sb = track(createSandbox());
    const {linked} = fixture(sb);

    // No GIT_ALLOW_PROTOCOL here: git refuses the file transport, so the clone
    // fails — a real init failure, not a simulated one.
    const result = setupEnv({target: linked});

    expect(result.exitCode).toBe(1);
    expect(statuses(result.steps).SUBMODULES).toBe('failed');
    expect(detailFor(result.steps, 'SUBMODULES')).toContain(
      'git submodule update --init --recursive exited',
    );
    expect(result.steps.some((s) => s.label === 'INSTALL')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// worktreeNew
// ---------------------------------------------------------------------------

describe('worktreeNew', () => {
  test('creates .claude/worktrees/<slug> on branch worktree-<slug> (D2)', () => {
    const sb = track(createSandbox());
    const primary = initPrimary(sb, {'.gitignore': '.claude/\n'});
    const result = worktreeNew({cwd: primary, noSetup: true, slug: 'my-slug'});
    expect(result.exitCode).toBe(0);
    expect(result.branch).toBe('worktree-my-slug');
    expect(result.path).toBe(join(primary, '.claude', 'worktrees', 'my-slug'));
    expect(existsSync(join(primary, '.claude/worktrees/my-slug/.git'))).toBe(
      true,
    );
    expect(git(primary, ['branch', '--list', 'worktree-my-slug'])).toContain(
      'worktree-my-slug',
    );
  });

  test('falls back to HEAD when origin/HEAD is not resolvable locally', () => {
    const sb = track(createSandbox());
    const primary = initPrimary(sb, {'.gitignore': '.claude/\n'});
    expect(worktreeNew({cwd: primary, noSetup: true, slug: 'x'}).baseRef).toBe(
      'HEAD',
    );
  });

  test('--no-setup creates the worktree without hydrating', () => {
    const sb = track(createSandbox());
    const primary = initPrimary(sb, {
      '.gitignore': '.claude/\n.env.local\n',
      '.worktreeinclude': '.env.local\n',
    });
    write(primary, '.env.local', 'SIM=1\n');
    const result = worktreeNew({cwd: primary, noSetup: true, slug: 'bare'});
    expect(result.exitCode).toBe(0);
    expect(result.setup).toBeNull();
    expect(existsSync(join(primary, '.claude/worktrees/bare/.env.local'))).toBe(
      false,
    );
  });

  test('hydrates by default', () => {
    const sb = track(createSandbox());
    const primary = initPrimary(sb, {
      '.gitignore': '.claude/\n.env.local\n',
      '.worktreeinclude': '.env.local\n',
    });
    write(primary, '.env.local', 'SIM=1\n');
    const result = worktreeNew({cwd: primary, slug: 'hydrated'});
    expect(result.exitCode).toBe(0);
    expect(result.setup?.exitCode).toBe(0);
    expect(
      readFileSync(
        join(primary, '.claude/worktrees/hydrated/.env.local'),
        'utf-8',
      ),
    ).toBe('SIM=1\n');
  });

  test.each(['has/slash', 'has space', '', 'bad$char', '..\\..\\etc'])(
    'refuses the invalid slug %p',
    (slug) => {
      const sb = track(createSandbox());
      const primary = initPrimary(sb, {'.gitignore': '.claude/\n'});
      const result = worktreeNew({cwd: primary, noSetup: true, slug});
      expect(result.exitCode).toBe(1);
      expect(result.path).toBeNull();
      expect(git(primary, ['branch', '--list'])).not.toContain('worktree-');
    },
  );

  /**
   * F2. `.` and `..` PASS SLUG_PATTERN, because `.` is in its character class.
   * `..` is the dangerous one: `join(primary, '.claude', 'worktrees', '..')`
   * collapses to `<primary>/.claude`, so in a repo with no `.claude` yet the
   * existsSync guard waves it through and `git worktree add` is aimed at the
   * `.claude` directory itself. Refname rules happen to reject `worktree-..`
   * today, so this is a guard against a self-defusing bug — which is exactly the
   * kind that stops self-defusing after an unrelated change.
   */
  test.each(['.', '..', '...'])(
    'refuses the pure-dot slug %p and creates nothing',
    (slug) => {
      const sb = track(createSandbox());
      const primary = initPrimary(sb, {'.gitignore': '.claude/\n'});
      const result = worktreeNew({cwd: primary, noSetup: true, slug});
      expect(result.exitCode).toBe(1);
      expect(result.path).toBeNull();
      // THE load-bearing assertion. exitCode 1 alone proves nothing here: git's
      // refname rules reject `worktree-.` anyway, so removing the guard still
      // yields exit 1. `baseRef` is only ever populated once we have decided to
      // create — a null baseRef proves the slug was refused BEFORE any git work
      // was attempted at the collapsed path.
      expect(result.baseRef).toBeNull();
      // And nothing was created anywhere along that collapsed path.
      expect(existsSync(join(primary, '.claude'))).toBe(false);
      expect(git(primary, ['branch', '--list'])).not.toContain('worktree-');
      expect(git(primary, ['worktree', 'list'])).not.toContain('.claude');
    },
  );

  test('refuses when the worktree directory already exists', () => {
    const sb = track(createSandbox());
    const primary = initPrimary(sb, {'.gitignore': '.claude/\n'});
    mkdirSync(join(primary, '.claude', 'worktrees', 'taken'), {
      recursive: true,
    });
    const result = worktreeNew({cwd: primary, noSetup: true, slug: 'taken'});
    expect(result.exitCode).toBe(1);
    expect(result.path).toBeNull();
    expect(git(primary, ['branch', '--list'])).not.toContain('worktree-taken');
  });

  test('refuses when the branch exists but the directory does not', () => {
    const sb = track(createSandbox());
    const primary = initPrimary(sb, {'.gitignore': '.claude/\n'});
    git(primary, ['branch', 'worktree-orphan']);
    const result = worktreeNew({cwd: primary, noSetup: true, slug: 'orphan'});
    expect(result.exitCode).toBe(1);
    expect(result.path).toBeNull();
    expect(existsSync(join(primary, '.claude/worktrees/orphan'))).toBe(false);
  });

  test('refuses outside a git repository', () => {
    const sb = track(createSandbox());
    expect(worktreeNew({cwd: sb.path, noSetup: true, slug: 'x'}).exitCode).toBe(
      1,
    );
  });

  test('places the worktree under the PRIMARY checkout, not the invoking worktree', () => {
    const sb = track(createSandbox());
    const primary = initPrimary(sb, {'.gitignore': '.claude/\n'});
    const linked = addLinkedWorktree(
      primary,
      join(sb.path, 'elsewhere', 'wt'),
      'worktree-probe',
    );
    const result = worktreeNew({cwd: linked, noSetup: true, slug: 'nested'});
    expect(result.exitCode).toBe(0);
    expect(result.path).toBe(join(primary, '.claude', 'worktrees', 'nested'));
    expect(existsSync(join(linked, '.claude', 'worktrees', 'nested'))).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// stdout purity, proven against the real CLI (D1)
// ---------------------------------------------------------------------------

describe('CLI stdout purity', () => {
  function runCli(
    args: string[],
    cwd: string,
  ): {status: number | null; stderr: string; stdout: string} {
    const result = spawnSync('bun', [CLI, ...args], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
      status: result.status,
      stderr: result.stderr ?? '',
      stdout: result.stdout ?? '',
    };
  }

  test('setup-env writes NOTHING to stdout, and its report to stderr', () => {
    const sb = track(createSandbox());
    const primary = initPrimary(sb, {
      '.gitignore': '.env.local\n',
      '.worktreeinclude': '.env.local\n',
      'package.json': JSON.stringify({
        name: 'p',
        scripts: {
          'setup-env:NOISY': "sh -c 'echo SCRIPT_STDOUT_NOISE'",
        },
      }),
    });
    write(primary, '.env.local', 'SIM=1\n');
    const linked = addLinkedWorktree(
      primary,
      join(sb.path, 'wt'),
      'worktree-probe',
    );

    const {status, stdout, stderr} = runCli(['setup-env'], linked);
    expect(status).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toContain('WORKTREEINCLUDE');
    // Even a project script's own stdout is redirected to stderr.
    expect(stderr).toContain('SCRIPT_STDOUT_NOISE');
  });

  test('the deprecated worktree-setup command name still works (alias)', () => {
    const sb = track(createSandbox());
    const primary = initPrimary(sb, {'a.txt': 'a\n'});
    const {status, stdout} = runCli(['worktree-setup'], primary);
    expect(status).toBe(0);
    expect(stdout).toBe('');
  });

  test('worktree-new writes EXACTLY one stdout line: the absolute path', () => {
    const sb = track(createSandbox());
    const primary = initPrimary(sb, {
      '.gitignore': '.claude/\n.env.local\n',
      '.worktreeinclude': '.env.local\n',
      'package.json': JSON.stringify({
        name: 'p',
        scripts: {
          'setup-env:NOISY': "sh -c 'echo SCRIPT_STDOUT_NOISE'",
        },
      }),
    });
    write(primary, '.env.local', 'SIM=1\n');

    const {status, stdout, stderr} = runCli(
      ['worktree-new', 'cli-slug'],
      primary,
    );
    expect(status).toBe(0);
    expect(stdout).toBe(
      `${join(primary, '.claude', 'worktrees', 'cli-slug')}\n`,
    );
    expect(stdout.trimEnd().split('\n')).toHaveLength(1);
    expect(stderr).toContain('worktree-new');
    expect(stderr).toContain('SCRIPT_STDOUT_NOISE');
  });

  /** F2's other half of the AC: the refusal must not put anything on stdout. */
  test.each(['.', '..'])(
    'a pure-dot slug %p exits 1 with EMPTY stdout',
    (slug) => {
      const sb = track(createSandbox());
      const primary = initPrimary(sb, {'.gitignore': '.claude/\n'});
      const {status, stdout, stderr} = runCli(['worktree-new', slug], primary);
      expect(status).toBe(1);
      expect(stdout).toBe('');
      expect(stderr).toContain('only dots');
      expect(existsSync(join(primary, '.claude'))).toBe(false);
    },
  );

  test('deprecated tier flags are accepted as no-ops with a warning (old preambles must not break)', () => {
    const sb = track(createSandbox());
    const primary = initPrimary(sb, {'a.txt': 'a\n'});
    const {status, stdout, stderr} = runCli(
      ['setup-env', '--lint', '--native'],
      primary,
    );
    expect(status).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toContain('ignored');
    expect(stderr).toContain('tier system was removed');
  });
});
