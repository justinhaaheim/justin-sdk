/**
 * Tests for `justin-sdk worktree-setup` and `justin-sdk worktree-new`.
 *
 * Fixtures are real git repos in $TMPDIR — the behavior under test IS git
 * behavior (worktree admin files, `check-ignore`'s index awareness,
 * `--git-common-dir`), so mocking git would test nothing. The fixture builders
 * live in ./git-fixtures, shared with tests/worktree-hydration.test.ts.
 *
 * The stdout-purity tests spawn the real CLI as a subprocess. That is the only
 * way to prove the contract (stdout empty for worktree-setup, exactly one path
 * line for worktree-new) end-to-end, including yargs registration.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {spawnSync} from 'child_process';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'fs';
import {dirname, join, resolve} from 'path';

import {
  detectPackageManager,
  discoverHydrationScripts,
  planWorktreeIncludeCopies,
  resolvePrimaryCheckout,
  resolveTier,
  tierIncludes,
  worktreeNew,
  worktreeSetup,
  type StepReport,
} from '../src/worktree-setup';
import {addLinkedWorktree, git, initPrimary, write} from './git-fixtures';
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

// ---------------------------------------------------------------------------
// Tier flags
// ---------------------------------------------------------------------------

describe('resolveTier', () => {
  test('defaults to js when no flag is given', () => {
    expect(resolveTier({})).toEqual({tier: 'js'});
  });

  test.each(['lint', 'js', 'native'] as const)('honors --%s alone', (tier) => {
    expect(resolveTier({[tier]: true})).toEqual({tier});
  });

  test('false flags are not "given"', () => {
    expect(resolveTier({js: false, lint: false, native: false})).toEqual({
      tier: 'js',
    });
  });

  test('two tier flags is an error naming both', () => {
    const result = resolveTier({lint: true, native: true});
    expect(result).toHaveProperty('error');
    if (!('error' in result)) throw new Error('expected an error');
    expect(result.error).toContain('--lint');
    expect(result.error).toContain('--native');
    expect(result.error).toContain('mutually exclusive');
  });

  test('all three tier flags is an error', () => {
    expect(resolveTier({js: true, lint: true, native: true})).toHaveProperty(
      'error',
    );
  });
});

describe('tierIncludes (cumulative lint ⊂ js ⊂ native)', () => {
  test.each([
    ['lint', 'lint', true],
    ['lint', 'js', false],
    ['lint', 'native', false],
    ['js', 'lint', true],
    ['js', 'js', true],
    ['js', 'native', false],
    ['native', 'lint', true],
    ['native', 'js', true],
    ['native', 'native', true],
  ] as const)('--%s includes %s tier === %p', (selected, script, expected) => {
    expect(tierIncludes(selected, script)).toBe(expected);
  });
});

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
// worktree-source:<tier>:<LABEL> discovery
// ---------------------------------------------------------------------------

describe('discoverHydrationScripts', () => {
  test('preserves package.json declaration order, not label order', () => {
    const sb = track(createSandbox());
    sb.writeFile(
      'package.json',
      JSON.stringify({
        scripts: {
          'worktree-source:js:ZEBRA': 'true',
          build: 'true',
          'worktree-source:lint:ALPHA': 'true',
          'worktree-source:native:MIDDLE': 'true',
        },
      }),
    );
    expect(discoverHydrationScripts(sb.path).map((s) => s.label)).toEqual([
      'ZEBRA',
      'ALPHA',
      'MIDDLE',
    ]);
  });

  test('unrecognized tier segment is surfaced as tier: null, not dropped', () => {
    const sb = track(createSandbox());
    sb.writeFile(
      'package.json',
      JSON.stringify({scripts: {'worktree-source:web:THING': 'true'}}),
    );
    expect(discoverHydrationScripts(sb.path)).toEqual([
      {label: 'THING', name: 'worktree-source:web:THING', tier: null},
    ]);
  });

  test('malformed names (no label, no tier separator) are ignored', () => {
    const sb = track(createSandbox());
    sb.writeFile(
      'package.json',
      JSON.stringify({
        scripts: {
          'worktree-source:js': 'true',
          'worktree-source:js:': 'true',
          'worktree-source:': 'true',
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
    const result = worktreeSetup({target: linked});
    expect(result.exitCode).toBe(0);
    expect(result.primary).toBe(primary);
    expect(statuses(result.steps)).toEqual({
      RESOLVE: 'done',
      MISE: 'skipped',
      INSTALL: 'skipped',
      WORKTREEINCLUDE: 'skipped',
      HYDRATE: 'skipped',
    });
  });

  test('running in the primary checkout is allowed and reports the no-op', () => {
    const sb = track(createSandbox());
    const primary = initPrimary(sb, {
      '.gitignore': '.env.local\n',
      '.worktreeinclude': '.env.local\n',
    });
    write(primary, '.env.local', 'SIM=1\n');
    const result = worktreeSetup({target: primary});
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
    const result = worktreeSetup({target: join(sb.path, 'nope')});
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

    const result = worktreeSetup({target: linked});
    expect(result.exitCode).toBe(0);
    expect(statuses(result.steps).WORKTREEINCLUDE).toBe('done');
    expect(readFileSync(join(linked, '.env.local'), 'utf-8')).toBe('SIM=abc\n');
    expect(readFileSync(join(linked, 'gen/version.json'), 'utf-8')).toBe(
      '{"v":"1.2.3"}\n',
    );
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

    const first = worktreeSetup({target: linked});
    expect(first.exitCode).toBe(0);
    expect(statuses(first.steps).WORKTREEINCLUDE).toBe('done');

    const second = worktreeSetup({target: linked});
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
        scripts: {'worktree-source:lint:MARK': 'sh -c "echo ran > ran.txt"'},
      }),
    });
    write(primary, '.env.local', 'SIM=abc\n');
    const linked = addLinkedWorktree(
      primary,
      join(sb.path, 'wt'),
      'worktree-probe',
    );

    const result = worktreeSetup({dryRun: true, target: linked});
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(linked, '.env.local'))).toBe(false);
    expect(existsSync(join(linked, 'ran.txt'))).toBe(false);
    expect(existsSync(join(linked, 'node_modules'))).toBe(false);
    expect(detailFor(result.steps, 'INSTALL')).toContain('dry-run: would run');
    expect(detailFor(result.steps, 'WORKTREEINCLUDE')).toContain(
      'would copy 1',
    );
    expect(
      detailFor(result.steps, 'HYDRATE:worktree-source:lint:MARK'),
    ).toContain('dry-run: would run');
  });

  describe('tier gating (epic AC #2) and declaration order', () => {
    // ZEBRA is declared before ALPHA on purpose: a label-sorted runner (like
    // fix-source:) would invert them.
    const scripts = {
      'worktree-source:js:ZEBRA': "sh -c 'echo js >> order.log'",
      'worktree-source:lint:ALPHA': "sh -c 'echo lint >> order.log'",
      'worktree-source:native:OMEGA': "sh -c 'echo native >> order.log'",
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

    test('--lint runs only lint scripts (never js or native)', () => {
      const sb = track(createSandbox());
      const {linked} = fixture(sb);
      const result = worktreeSetup({target: linked, tier: 'lint'});
      expect(result.exitCode).toBe(0);
      expect(order(linked)).toEqual(['lint']);
      expect(statuses(result.steps)).toMatchObject({
        'HYDRATE:worktree-source:js:ZEBRA': 'skipped',
        'HYDRATE:worktree-source:lint:ALPHA': 'done',
        'HYDRATE:worktree-source:native:OMEGA': 'skipped',
      });
      expect(
        detailFor(result.steps, 'HYDRATE:worktree-source:native:OMEGA'),
      ).toContain('not included in --lint');
    });

    test('--js runs lint + js in declaration order, never native', () => {
      const sb = track(createSandbox());
      const {linked} = fixture(sb);
      const result = worktreeSetup({target: linked, tier: 'js'});
      expect(result.exitCode).toBe(0);
      expect(order(linked)).toEqual(['js', 'lint']);
    });

    test('the default tier is js', () => {
      const sb = track(createSandbox());
      const {linked} = fixture(sb);
      expect(worktreeSetup({target: linked}).exitCode).toBe(0);
      expect(order(linked)).toEqual(['js', 'lint']);
    });

    test('--native runs all three, still in declaration order', () => {
      const sb = track(createSandbox());
      const {linked} = fixture(sb);
      const result = worktreeSetup({target: linked, tier: 'native'});
      expect(result.exitCode).toBe(0);
      expect(order(linked)).toEqual(['js', 'lint', 'native']);
    });
  });

  test('a failing hydration script stops the run and later scripts do not run', () => {
    const sb = track(createSandbox());
    const primary = initPrimary(sb, {
      'package.json': JSON.stringify({
        name: 'p',
        scripts: {
          'worktree-source:lint:FIRST': "sh -c 'echo first >> order.log'",
          'worktree-source:lint:BOOM': 'false',
          'worktree-source:lint:NEVER': "sh -c 'echo never >> order.log'",
        },
      }),
    });
    const linked = addLinkedWorktree(
      primary,
      join(sb.path, 'wt'),
      'worktree-probe',
    );

    const result = worktreeSetup({target: linked, tier: 'lint'});
    expect(result.exitCode).toBe(1);
    expect(statuses(result.steps)['HYDRATE:worktree-source:lint:BOOM']).toBe(
      'failed',
    );
    expect(result.steps.some((s) => s.label.endsWith('NEVER'))).toBe(false);
    expect(readFileSync(join(linked, 'order.log'), 'utf-8')).toBe('first\n');
  });

  test('scripts with an unknown tier segment are skipped, not run', () => {
    const sb = track(createSandbox());
    const primary = initPrimary(sb, {
      'package.json': JSON.stringify({
        name: 'p',
        scripts: {'worktree-source:web:THING': "sh -c 'echo web > web.txt'"},
      }),
    });
    const linked = addLinkedWorktree(
      primary,
      join(sb.path, 'wt'),
      'worktree-probe',
    );
    const result = worktreeSetup({target: linked, tier: 'native'});
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(linked, 'web.txt'))).toBe(false);
    expect(
      detailFor(result.steps, 'HYDRATE:worktree-source:web:THING'),
    ).toContain('unknown tier');
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

  test('worktree-setup writes NOTHING to stdout, and its report to stderr', () => {
    const sb = track(createSandbox());
    const primary = initPrimary(sb, {
      '.gitignore': '.env.local\n',
      '.worktreeinclude': '.env.local\n',
      'package.json': JSON.stringify({
        name: 'p',
        scripts: {
          'worktree-source:lint:NOISY': "sh -c 'echo SCRIPT_STDOUT_NOISE'",
        },
      }),
    });
    write(primary, '.env.local', 'SIM=1\n');
    const linked = addLinkedWorktree(
      primary,
      join(sb.path, 'wt'),
      'worktree-probe',
    );

    const {status, stdout, stderr} = runCli(['worktree-setup'], linked);
    expect(status).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toContain('WORKTREEINCLUDE');
    // Even a project script's own stdout is redirected to stderr.
    expect(stderr).toContain('SCRIPT_STDOUT_NOISE');
  });

  test('worktree-new writes EXACTLY one stdout line: the absolute path', () => {
    const sb = track(createSandbox());
    const primary = initPrimary(sb, {
      '.gitignore': '.claude/\n.env.local\n',
      '.worktreeinclude': '.env.local\n',
      'package.json': JSON.stringify({
        name: 'p',
        scripts: {
          'worktree-source:lint:NOISY': "sh -c 'echo SCRIPT_STDOUT_NOISE'",
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

  test('mutually exclusive tier flags exit 1 with the error on stderr', () => {
    const sb = track(createSandbox());
    const primary = initPrimary(sb, {'a.txt': 'a\n'});
    const {status, stdout, stderr} = runCli(
      ['worktree-setup', '--lint', '--native'],
      primary,
    );
    expect(status).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('mutually exclusive');
  });
});
