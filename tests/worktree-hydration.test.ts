/**
 * Tests for unhydrated-worktree detection and its two consumers.
 *
 * Fixtures are real git repos (see ./git-fixtures): the whole question is a git
 * topology question, and the one thing that MUST NOT regress — a primary
 * checkout behaving exactly as before — is only meaningful against real git.
 *
 * The signal tests prove "the checks did / did not run" with a SENTINEL FILE
 * that a `signal-source:` script touches. Note the sentinel path is absolute
 * because check-runner runs check commands with `cwd: process.cwd()`, not the
 * project root. The worktree fixture's check also EXITS NON-ZERO, standing in
 * for the phantom failure the preflight exists to suppress: if the preflight
 * ever stops firing, the exit code stays 1 but the sentinel appears and the
 * banner disappears — so the tests fail for the right reason rather than
 * silently passing.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'fs';
import {join} from 'path';

import {makeWorktreeHydrationChecks} from '../src/doctor';
import {runSignal} from '../src/signal';
import {
  BLOCKING_PROBLEM_KINDS,
  describeMissing,
  detectWorktreeHydration,
  formatAdvisoryWorktreeWarning,
  formatUnhydratedWorktreeBanner,
  hasBlockingProblem,
  hydrationFixCommand,
  isBlockingProblem,
  isLinkedWorktree,
  miseTrustStatus,
  parseMiseTrustStatus,
  WORKTREE_SETUP_BUNX,
  type HydrationProblem,
  type HydrationProblemKind,
  type WorktreeHydrationStatus,
} from '../src/worktree-hydration';
import {addLinkedWorktree, git, initPrimary} from './git-fixtures';
import {createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];

function track(sb: Sandbox): Sandbox {
  sandboxes.push(sb);
  return sb;
}

afterEach(() => {
  while (sandboxes.length > 0) {
    sandboxes.pop()?.cleanup();
  }
});

/** mise is optional on a dev machine; the trust signal is skipped without it. */
function miseAvailable(): boolean {
  try {
    const probe = Bun.spawnSync(['mise', '--version'], {
      stderr: 'pipe',
      stdout: 'pipe',
    });
    return probe.exitCode === 0;
  } catch {
    return false;
  }
}

const MISE = miseAvailable();

/**
 * Run `fn` with `key` deleted from the environment, restoring it afterwards.
 * tests/sandbox.ts sets MISE_TRUSTED_CONFIG_PATHS to the whole tmp base at
 * module load (so `br` works in sandboxes), which would make every fixture
 * mise.toml TRUSTED — removing it is what makes the untrusted case reachable.
 */
function withoutEnv<T>(key: string, fn: () => T): T {
  const previous = process.env[key];
  delete process.env[key];
  try {
    return fn();
  } finally {
    if (previous !== undefined) process.env[key] = previous;
  }
}

/**
 * Capture everything written to stderr while `fn` runs. runSignal writes the
 * banner straight to process.stderr, so this is the only way to assert on it.
 */
async function captureStderr<T>(
  fn: () => Promise<T>,
): Promise<{result: T; stderr: string}> {
  const original = process.stderr.write;
  let captured = '';
  process.stderr.write = ((chunk: unknown): boolean => {
    captured += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = await fn();
    return {result, stderr: captured};
  } finally {
    process.stderr.write = original;
  }
}

interface FixtureOptions {
  /** Extra top-level files, committed unless .gitignore excludes them. */
  files?: Record<string, string>;
  gitignore?: string;
  packageJson?: Record<string, unknown>;
  worktreeinclude?: string;
}

/** A committed repo with a package.json that declares a dependency. */
function makePrimary(sb: Sandbox, options: FixtureOptions = {}): string {
  const files: Record<string, string> = {
    '.gitignore':
      options.gitignore ?? 'node_modules/\n.env.local\n.claude/worktrees/\n',
    'package.json':
      JSON.stringify(
        options.packageJson ?? {
          devDependencies: {'left-pad': '1.3.0'},
          name: 'fixture',
        },
        null,
        2,
      ) + '\n',
    ...options.files,
  };
  if (options.worktreeinclude != null) {
    files['.worktreeinclude'] = options.worktreeinclude;
  }
  return initPrimary(sb, files);
}

function packageJsonWithCheck(
  sentinel: string,
  extra: Record<string, unknown> = {},
  exitCode = 0,
): Record<string, unknown> {
  return {
    devDependencies: {'left-pad': '1.3.0'},
    name: 'fixture',
    scripts: {
      'signal-source:SENTINEL': `touch ${JSON.stringify(sentinel)}; exit ${exitCode}`,
    },
    ...extra,
  };
}

function kinds(status: WorktreeHydrationStatus): string[] {
  return status.problems.map((problem) => problem.kind);
}

/** A problem of the given kind; only `kind` participates in the F6/F7 rules. */
function makeProblem(kind: HydrationProblemKind): HydrationProblem {
  return {detail: `${kind} detail`, kind, label: kind};
}

// ---------------------------------------------------------------------------
// The linked-worktree predicate — the gate everything else hangs off
// ---------------------------------------------------------------------------

describe('isLinkedWorktree', () => {
  test('a primary checkout is not a linked worktree', () => {
    const sb = track(createSandbox());
    const primary = makePrimary(sb);
    expect(isLinkedWorktree(primary)).toBe(false);
  });

  test('a linked worktree is', () => {
    const sb = track(createSandbox());
    const primary = makePrimary(sb);
    const wt = addLinkedWorktree(
      primary,
      join(primary, '.claude', 'worktrees', 'w1'),
      'worktree-w1',
    );
    expect(isLinkedWorktree(wt)).toBe(true);
  });

  /**
   * NEGATIVE CONTROL for the no-subprocess fast path. `.git` being a FILE does
   * NOT imply "linked worktree": a --separate-git-dir (or submodule) MAIN
   * checkout has one too, and this SDK itself is that case. If the predicate
   * ever degrades to "is .git a file?", this is the test that catches it.
   */
  test('a main checkout with a detached git dir (.git is a FILE) is not', () => {
    const sb = track(createSandbox());
    const work = join(sb.path, 'work');
    const gitDir = join(sb.path, 'detached-gitdir');
    mkdirSync(work, {recursive: true});
    git(sb.path, ['init', '-q', `--separate-git-dir=${gitDir}`, work]);
    expect(existsSync(join(work, '.git'))).toBe(true);
    expect(isLinkedWorktree(work)).toBe(false);
  });

  test('a directory outside any git repo is not', () => {
    const sb = track(createSandbox());
    expect(isLinkedWorktree(sb.path)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Primary checkout: ZERO behavior change (regression-critical)
// ---------------------------------------------------------------------------

describe('primary checkout', () => {
  test('detection is inert even when node_modules is missing', () => {
    const sb = track(createSandbox());
    const primary = makePrimary(sb);
    expect(existsSync(join(primary, 'node_modules'))).toBe(false);

    const status = detectWorktreeHydration(primary);
    expect(status.isLinkedWorktree).toBe(false);
    expect(status.problems).toEqual([]);
  });

  test('the doctor check is ABSENT (not merely passing)', () => {
    const sb = track(createSandbox());
    expect(makeWorktreeHydrationChecks(makePrimary(sb))).toEqual([]);
  });

  test('signal still discovers and runs its checks', async () => {
    const sb = track(createSandbox());
    const sentinel = join(sb.path, 'primary-checks-ran');
    const primary = makePrimary(sb, {
      packageJson: packageJsonWithCheck(sentinel),
    });

    const {result, stderr} = await captureStderr(() =>
      runSignal(primary, {quiet: true}),
    );

    expect(result).toBe(0);
    expect(existsSync(sentinel)).toBe(true);
    expect(stderr).not.toContain('UNHYDRATED');
  });

  test('a non-git project root is likewise inert', async () => {
    const sb = track(createSandbox());
    const sentinel = join(sb.path, 'non-git-checks-ran');
    writeFileSync(
      join(sb.path, 'package.json'),
      JSON.stringify(packageJsonWithCheck(sentinel)),
    );

    const {result} = await captureStderr(() =>
      runSignal(sb.path, {quiet: true}),
    );

    expect(result).toBe(0);
    expect(existsSync(sentinel)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Linked worktree, missing node_modules
// ---------------------------------------------------------------------------

describe('linked worktree missing node_modules', () => {
  function setup(
    sb: Sandbox,
    options: {sentinel?: string; worktreeSetupScript?: boolean} = {},
  ): string {
    const extra =
      options.worktreeSetupScript === true
        ? {
            scripts: {
              'signal-source:SENTINEL': `touch ${JSON.stringify(options.sentinel ?? join(sb.path, 'unused'))}; exit 3`,
              'worktree:setup': 'bunx justin-sdk worktree-setup',
            },
          }
        : {};
    const primary = makePrimary(sb, {
      packageJson: packageJsonWithCheck(
        options.sentinel ?? join(sb.path, 'unused'),
        extra,
        3,
      ),
    });
    return addLinkedWorktree(
      primary,
      join(primary, '.claude', 'worktrees', 'w1'),
      'worktree-w1',
    );
  }

  test('is detected, and nothing else is reported', () => {
    const sb = track(createSandbox());
    const status = detectWorktreeHydration(setup(sb));
    expect(status.isLinkedWorktree).toBe(true);
    expect(kinds(status)).toEqual(['node-modules']);
    expect(status.problems[0]?.label).toBe('node_modules');
  });

  test('signal short-circuits: exit 1, banner, and the checks NEVER run', async () => {
    const sb = track(createSandbox());
    const sentinel = join(sb.path, 'worktree-checks-ran');
    const wt = setup(sb, {sentinel});

    const {result, stderr} = await captureStderr(() =>
      runSignal(wt, {quiet: true}),
    );

    expect(result).toBe(1);
    // The load-bearing assertion: discovery never happened, so the phantom
    // failure the fixture would have produced was never relayed.
    expect(existsSync(sentinel)).toBe(false);
    expect(stderr).toContain('UNHYDRATED');
    expect(stderr).toContain('PHANTOM');
    expect(stderr).toContain('node_modules');
    expect(stderr).toContain(WORKTREE_SETUP_BUNX);
  });

  test('doctor reports an error naming the bunx fix (no worktree:setup script)', () => {
    const sb = track(createSandbox());
    const nodes = makeWorktreeHydrationChecks(setup(sb));
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.check.label).toBe('WORKTREE_HYDRATION');
    // severity omitted === 'error' (check-runner's default).
    expect(nodes[0]?.check.severity).toBeUndefined();

    const result = nodes[0]?.check.fn?.() as {
      fix?: string;
      message?: string;
      pass: boolean;
    };
    expect(result.pass).toBe(false);
    expect(result.fix).toBe(`Run: ${WORKTREE_SETUP_BUNX}`);
    expect(result.message).toContain('node_modules');
    expect(result.message).toContain('PHANTOM');
  });

  /**
   * F6 — DELIBERATE CONTRACT CHANGE. This test previously asserted the OPPOSITE
   * (`Run: bun run worktree:setup`), i.e. that a declared alias always wins.
   * That is precisely the hazardous state: node_modules is missing in this
   * fixture, so the fleet alias form `bunx justin-sdk worktree-setup` cannot
   * resolve the SDK locally and bunx would fetch the BARE npm name — not this
   * package. Ruled on home-base-v170.5 (F6): the node-modules problem forces the
   * explicit github form. The rewrite is the finding, not test-fudging.
   */
  test('doctor forces the bunx-github form even when the alias exists (F6)', () => {
    const sb = track(createSandbox());
    const wt = setup(sb, {worktreeSetupScript: true});
    // Fixture sanity: the alias really IS declared, in the exact fleet form —
    // so what follows is about the rule, not about a missing script.
    const pkg = JSON.parse(
      readFileSync(join(wt, 'package.json'), 'utf-8'),
    ) as {scripts: Record<string, string>};
    expect(pkg.scripts['worktree:setup']).toBe('bunx justin-sdk worktree-setup');

    const result = makeWorktreeHydrationChecks(wt)[0]?.check.fn?.() as {
      fix?: string;
      pass: boolean;
    };
    expect(result.pass).toBe(false);
    expect(result.fix).toBe(`Run: ${WORKTREE_SETUP_BUNX}`);
  });

  test('a package.json with no dependencies is not a hydration problem', () => {
    const sb = track(createSandbox());
    const primary = makePrimary(sb, {packageJson: {name: 'no-deps'}});
    const wt = addLinkedWorktree(
      primary,
      join(primary, '.claude', 'worktrees', 'w1'),
      'worktree-w1',
    );
    expect(kinds(detectWorktreeHydration(wt))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Linked worktree, fully hydrated
// ---------------------------------------------------------------------------

describe('fully hydrated linked worktree', () => {
  function setup(sb: Sandbox, sentinel: string): string {
    const primary = makePrimary(sb, {
      packageJson: packageJsonWithCheck(sentinel),
    });
    const wt = addLinkedWorktree(
      primary,
      join(primary, '.claude', 'worktrees', 'w1'),
      'worktree-w1',
    );
    mkdirSync(join(wt, 'node_modules'), {recursive: true});
    return wt;
  }

  test('reports no problems', () => {
    const sb = track(createSandbox());
    const status = detectWorktreeHydration(
      setup(sb, join(sb.path, 'unused')),
    );
    expect(status.isLinkedWorktree).toBe(true);
    expect(status.problems).toEqual([]);
  });

  test('the doctor check is PRESENT and passing (positive confirmation)', () => {
    const sb = track(createSandbox());
    const nodes = makeWorktreeHydrationChecks(setup(sb, join(sb.path, 'x')));
    expect(nodes).toHaveLength(1);
    const result = nodes[0]?.check.fn?.() as {message?: string; pass: boolean};
    expect(result.pass).toBe(true);
    expect(result.message).toContain('hydrated');
  });

  test('signal runs its checks normally', async () => {
    const sb = track(createSandbox());
    const sentinel = join(sb.path, 'hydrated-checks-ran');
    const wt = setup(sb, sentinel);

    const {result, stderr} = await captureStderr(() =>
      runSignal(wt, {quiet: true}),
    );

    expect(result).toBe(0);
    expect(existsSync(sentinel)).toBe(true);
    expect(stderr).not.toContain('UNHYDRATED');
  });
});

// ---------------------------------------------------------------------------
// .worktreeinclude (D4)
// ---------------------------------------------------------------------------

describe('.worktreeinclude missing files', () => {
  function setup(
    sb: Sandbox,
    options: {sentinel?: string} = {},
  ): {primary: string; wt: string} {
    const primary = makePrimary(sb, {
      files: {'.env.local': 'SECRET=1\n'},
      // A sentinel-touching check only when a test needs to prove whether the
      // checks ran; the hydration problems are identical either way.
      packageJson:
        options.sentinel == null
          ? undefined
          : packageJsonWithCheck(options.sentinel),
      worktreeinclude: '.env.local\n',
    });
    // Sanity: the fixture only means anything if .env.local is untracked and
    // gitignored in the primary.
    expect(git(primary, ['ls-files', '--', '.env.local'])).toBe('');
    const wt = addLinkedWorktree(
      primary,
      join(primary, '.claude', 'worktrees', 'w1'),
      'worktree-w1',
    );
    mkdirSync(join(wt, 'node_modules'), {recursive: true});
    return {primary, wt};
  }

  test('a manifest file present in primary but absent here is a problem', () => {
    const sb = track(createSandbox());
    const {wt} = setup(sb);
    const status = detectWorktreeHydration(wt);
    expect(kinds(status)).toEqual(['worktreeinclude']);
    expect(status.problems[0]?.label).toBe('.env.local');
    expect(status.problems[0]?.detail).toContain('.worktreeinclude');
  });

  /**
   * F6's other half, end to end: with node_modules INTACT the alias can actually
   * resolve the SDK, so it is the right thing to print — faster, no network. The
   * two F6 tests differ only in whether node_modules exists.
   */
  test('with node_modules intact, the project alias IS preferred (F6)', () => {
    const sb = track(createSandbox());
    const primary = makePrimary(sb, {
      files: {'.env.local': 'SECRET=1\n'},
      packageJson: {
        devDependencies: {'left-pad': '1.3.0'},
        name: 'fixture',
        scripts: {'worktree:setup': 'bunx justin-sdk worktree-setup'},
      },
      worktreeinclude: '.env.local\n',
    });
    const wt = addLinkedWorktree(
      primary,
      join(primary, '.claude', 'worktrees', 'w1'),
      'worktree-w1',
    );
    mkdirSync(join(wt, 'node_modules'), {recursive: true});

    const status = detectWorktreeHydration(wt);
    expect(kinds(status)).toEqual(['worktreeinclude']);
    expect(status.fixCommand).toBe('bun run worktree:setup');
  });

  test('once the file is copied in, the problem is gone', () => {
    const sb = track(createSandbox());
    const {wt} = setup(sb);
    writeFileSync(join(wt, '.env.local'), 'SECRET=1\n');
    expect(detectWorktreeHydration(wt).problems).toEqual([]);
  });

  /**
   * F7 — DELIBERATE CONTRACT CHANGE. This test was
   * "signal short-circuits on a missing manifest file alone" and asserted exit 1.
   * Ruled on home-base-v170.5: a missing `.worktreeinclude` file cannot corrupt
   * check RESULTS, so it must not make `signal` unrunnable — there is no override
   * flag, and a missing `.env.local` in a tree where eslint and tsc work fine is
   * not grounds for refusing to lint. It warns, and the checks run.
   */
  test('signal WARNS and RUNS the checks on a manifest file alone (advisory)', async () => {
    const sb = track(createSandbox());
    const sentinel = join(sb.path, 'advisory-checks-ran');
    const {wt} = setup(sb, {sentinel});

    const {result, stderr} = await captureStderr(() =>
      runSignal(wt, {quiet: true}),
    );

    // THE load-bearing assertion: discovery happened and the check really ran.
    expect(existsSync(sentinel)).toBe(true);
    expect(result).toBe(0);
    // All three advisory facts are present…
    expect(stderr).toContain('partially unhydrated worktree');
    expect(stderr).toContain('.env.local');
    expect(stderr).toContain(WORKTREE_SETUP_BUNX);
    // …and it is emphatically NOT the blocking banner, whose whole claim is that
    // the results are worthless. Reusing that here would train the reader to
    // ignore it when it matters.
    expect(stderr).not.toContain('UNHYDRATED');
    expect(stderr).not.toContain('PHANTOM');
  });

  test('the advisory exit code comes from the CHECKS, not the preflight', async () => {
    const sb = track(createSandbox());
    const sentinel = join(sb.path, 'advisory-failing-check');
    // Same advisory state, but the project's own check fails. Exit 1 here must
    // mean "your check failed", which is only meaningful because the sibling
    // test above shows a passing check yields 0 in the identical state.
    const primary = makePrimary(sb, {
      files: {'.env.local': 'SECRET=1\n'},
      packageJson: packageJsonWithCheck(sentinel, {}, 3),
      worktreeinclude: '.env.local\n',
    });
    const wt = addLinkedWorktree(
      primary,
      join(primary, '.claude', 'worktrees', 'w1'),
      'worktree-w1',
    );
    mkdirSync(join(wt, 'node_modules'), {recursive: true});

    const {result, stderr} = await captureStderr(() =>
      runSignal(wt, {quiet: true}),
    );

    expect(existsSync(sentinel)).toBe(true);
    expect(result).toBe(1);
    expect(stderr).toContain('partially unhydrated worktree');
  });
});

// ---------------------------------------------------------------------------
// F7: the blocking / advisory split
// ---------------------------------------------------------------------------

describe('blocking vs advisory problem kinds (F7)', () => {
  /**
   * Pinned at kind level, because this set IS the contract signal and doctor
   * share. The test is "does this kind cause PHANTOM CHECK FAILURES" — only a
   * missing node_modules makes eslint and tsc report errors in untouched files.
   */
  test('exactly node-modules blocks; the other two are advisory', () => {
    expect([...BLOCKING_PROBLEM_KINDS]).toEqual(['node-modules']);
    expect(isBlockingProblem(makeProblem('node-modules'))).toBe(true);
    expect(isBlockingProblem(makeProblem('worktreeinclude'))).toBe(false);
    expect(isBlockingProblem(makeProblem('mise-untrusted'))).toBe(false);
  });

  test('hasBlockingProblem is false for an advisory-only status', () => {
    const advisory: WorktreeHydrationStatus = {
      fixCommand: WORKTREE_SETUP_BUNX,
      isLinkedWorktree: true,
      primary: '/primary',
      problems: [makeProblem('worktreeinclude'), makeProblem('mise-untrusted')],
      target: '/primary/.claude/worktrees/w1',
    };
    expect(hasBlockingProblem(advisory)).toBe(false);
    expect(
      hasBlockingProblem({
        ...advisory,
        problems: [...advisory.problems, makeProblem('node-modules')],
      }),
    ).toBe(true);
  });

  /**
   * The precedence case, and the one a naive implementation gets wrong: an
   * advisory problem must never soften a blocking one. Mixed state -> full
   * banner, exit 1, checks never run.
   */
  test('a blocking problem alongside an advisory one still BLOCKS', async () => {
    const sb = track(createSandbox());
    const sentinel = join(sb.path, 'mixed-checks-ran');
    const primary = makePrimary(sb, {
      files: {'.env.local': 'SECRET=1\n'},
      packageJson: packageJsonWithCheck(sentinel, {}, 3),
      worktreeinclude: '.env.local\n',
    });
    // No node_modules mkdir: BOTH problems are present.
    const wt = addLinkedWorktree(
      primary,
      join(primary, '.claude', 'worktrees', 'w1'),
      'worktree-w1',
    );
    expect(kinds(detectWorktreeHydration(wt)).sort()).toEqual([
      'node-modules',
      'worktreeinclude',
    ]);

    const {result, stderr} = await captureStderr(() =>
      runSignal(wt, {quiet: true}),
    );

    expect(result).toBe(1);
    expect(existsSync(sentinel)).toBe(false);
    expect(stderr).toContain('UNHYDRATED');
    expect(stderr).toContain('PHANTOM');
    // Both are still listed — blocking changes the treatment, not the inventory.
    expect(stderr).toContain('node_modules');
    expect(stderr).toContain('.env.local');
    expect(stderr).not.toContain('partially unhydrated');
  });

  /**
   * home-base-v170.6 — doctor's MESSAGE follows the same split, its GATE does
   * not. The two fixtures below differ in exactly one thing (whether
   * node_modules exists), so any difference in the message is attributable to
   * the blocking/advisory decision and nothing else. Both must still fail.
   */
  describe("doctor's message (v170.6)", () => {
    /** Advisory `.env.local` gap always present; node_modules is the variable. */
    function fixture(sb: Sandbox, nodeModules: boolean): string {
      const primary = makePrimary(sb, {
        files: {'.env.local': 'SECRET=1\n'},
        worktreeinclude: '.env.local\n',
      });
      const wt = addLinkedWorktree(
        primary,
        join(primary, '.claude', 'worktrees', 'w1'),
        'worktree-w1',
      );
      if (nodeModules) mkdirSync(join(wt, 'node_modules'), {recursive: true});
      return wt;
    }

    function doctorMessage(worktree: string): {message: string; pass: boolean} {
      const result = makeWorktreeHydrationChecks(worktree)[0]?.check.fn?.() as {
        message?: string;
        pass: boolean;
      };
      return {message: result.message ?? '', pass: result.pass};
    }

    test('a BLOCKING worktree still gets the PHANTOM sentence', () => {
      const sb = track(createSandbox());
      const wt = fixture(sb, false);
      // Fixture sanity: this is the MIXED state, so the advisory problem is
      // present too and must not soften the claim.
      expect(kinds(detectWorktreeHydration(wt)).sort()).toEqual([
        'node-modules',
        'worktreeinclude',
      ]);

      const {message, pass} = doctorMessage(wt);
      expect(pass).toBe(false);
      expect(message).toContain('PHANTOM');
      expect(message).toContain('node_modules');
      // Not hedged into meaninglessness by the advisory wording.
      expect(message).not.toContain('still trustworthy');
      expect(message).not.toContain('partially unhydrated');
    });

    test('an ADVISORY-ONLY worktree does NOT claim phantom-ness', () => {
      const sb = track(createSandbox());
      const wt = fixture(sb, true);
      // Fixture sanity: node_modules intact, so the ONLY problem is advisory.
      expect(kinds(detectWorktreeHydration(wt))).toEqual(['worktreeinclude']);

      const {message, pass} = doctorMessage(wt);
      // The gate is unchanged — a real gap is still an error.
      expect(pass).toBe(false);
      // THE assertion this bead exists for.
      expect(message).not.toContain('PHANTOM');
      // …and it says what the gap DOES affect instead of what it doesn't.
      expect(message).toContain('still trustworthy');
      expect(message).toContain('build');
      expect(message).toContain('partially unhydrated');
      expect(message).toContain('.env.local');
    });
  });

  test('the advisory warning is 3 lines and carries all three facts', () => {
    const status: WorktreeHydrationStatus = {
      fixCommand: 'bun run worktree:setup',
      isLinkedWorktree: true,
      primary: '/primary',
      problems: [makeProblem('worktreeinclude')],
      target: '/primary/.claude/worktrees/w1',
    };
    const warning = formatAdvisoryWorktreeWarning(status);
    expect(warning.trimEnd().split('\n')).toHaveLength(3);
    expect(warning).toContain('/primary/.claude/worktrees/w1');
    expect(warning).toContain('worktreeinclude');
    expect(warning).toContain('bun run worktree:setup');
  });
});

// ---------------------------------------------------------------------------
// mise trust (read-only probe)
// ---------------------------------------------------------------------------

describe('parseMiseTrustStatus', () => {
  test('picks the line for the target directory, ignoring parents', () => {
    const stdout = ['/repo: untrusted', '/repo/child: trusted'].join('\n');
    expect(parseMiseTrustStatus(stdout, '/repo/child')).toBe('trusted');
    expect(parseMiseTrustStatus(stdout, '/repo')).toBe('untrusted');
  });

  test('expands the tilde form mise prints for paths under $HOME', () => {
    const home = process.env.HOME ?? '';
    expect(parseMiseTrustStatus('~/Dev/thing: untrusted', `${home}/Dev/thing`)).toBe(
      'untrusted',
    );
  });

  test('an unlisted target, empty output, or unknown word is "unknown"', () => {
    expect(parseMiseTrustStatus('/other: trusted', '/repo')).toBe('unknown');
    expect(parseMiseTrustStatus('', '/repo')).toBe('unknown');
    expect(parseMiseTrustStatus('/repo: ignored', '/repo')).toBe('unknown');
  });
});

describe('mise trust signal', () => {
  function setupWithMise(sb: Sandbox): string {
    const primary = makePrimary(sb, {
      files: {'mise.toml': '[tools]\n'},
    });
    const wt = addLinkedWorktree(
      primary,
      join(primary, '.claude', 'worktrees', 'w1'),
      'worktree-w1',
    );
    mkdirSync(join(wt, 'node_modules'), {recursive: true});
    return wt;
  }

  test('no mise.toml means no mise problem', () => {
    const sb = track(createSandbox());
    const primary = makePrimary(sb);
    const wt = addLinkedWorktree(
      primary,
      join(primary, '.claude', 'worktrees', 'w1'),
      'worktree-w1',
    );
    mkdirSync(join(wt, 'node_modules'), {recursive: true});
    expect(miseTrustStatus(wt)).toBe('unknown');
    expect(detectWorktreeHydration(wt).problems).toEqual([]);
  });

  test.skipIf(!MISE)('an untrusted mise.toml is reported', () => {
    const sb = track(createSandbox());
    const wt = setupWithMise(sb);
    withoutEnv('MISE_TRUSTED_CONFIG_PATHS', () => {
      expect(miseTrustStatus(wt)).toBe('untrusted');
      const status = detectWorktreeHydration(wt);
      expect(kinds(status)).toEqual(['mise-untrusted']);
      expect(status.problems[0]?.label).toContain('untrusted');
    });
  });

  test.skipIf(!MISE)('a trusted mise.toml is not a problem', () => {
    const sb = track(createSandbox());
    const wt = setupWithMise(sb);
    // sandbox.ts trusts the whole tmp base via MISE_TRUSTED_CONFIG_PATHS, so
    // leaving the env alone is the trusted case — the exact inverse of above.
    expect(miseTrustStatus(wt)).toBe('trusted');
    expect(detectWorktreeHydration(wt).problems).toEqual([]);
  });

  test.skipIf(!MISE)('the probe does not mutate trust state', () => {
    const sb = track(createSandbox());
    const wt = setupWithMise(sb);
    withoutEnv('MISE_TRUSTED_CONFIG_PATHS', () => {
      expect(miseTrustStatus(wt)).toBe('untrusted');
      // Still untrusted after probing: --show must not trust anything.
      expect(miseTrustStatus(wt)).toBe('untrusted');
    });
  });
});

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

describe('messaging', () => {
  function statusWith(labels: string[]): WorktreeHydrationStatus {
    return {
      fixCommand: WORKTREE_SETUP_BUNX,
      isLinkedWorktree: true,
      primary: '/primary',
      problems: labels.map((label) => ({
        detail: `${label} detail`,
        kind: 'worktreeinclude' as const,
        label,
      })),
      target: '/primary/.claude/worktrees/w1',
    };
  }

  test('describeMissing lists every problem up to the cap', () => {
    expect(describeMissing(statusWith(['a', 'b', 'c']))).toBe('a, b, c');
  });

  test('describeMissing collapses a long list rather than printing a wall', () => {
    const labels = Array.from({length: 11}, (_, i) => `f${i}`);
    const described = describeMissing(statusWith(labels));
    expect(described).toContain('f0');
    expect(described).toContain('+3 more');
    expect(described).not.toContain('f8');
  });

  test('the banner names the cause, the list, the fix and the worktree', () => {
    const banner = formatUnhydratedWorktreeBanner(statusWith(['.env.local']));
    expect(banner).toContain('UNHYDRATED');
    expect(banner).toContain('PHANTOM');
    expect(banner).toContain('.env.local');
    expect(banner).toContain(WORKTREE_SETUP_BUNX);
    expect(banner).toContain('/primary/.claude/worktrees/w1');
  });
});

describe('hydrationFixCommand', () => {
  const problem = makeProblem;
  const INCLUDE_ONLY = [problem('worktreeinclude')];
  const WITH_NODE_MODULES = [problem('worktreeinclude'), problem('node-modules')];

  function withAlias(sb: Sandbox): string {
    writeFileSync(
      join(sb.path, 'package.json'),
      JSON.stringify({scripts: {'worktree:setup': 'anything'}}),
    );
    return sb.path;
  }

  test('prefers the project-local alias when declared', () => {
    const sb = track(createSandbox());
    expect(hydrationFixCommand(withAlias(sb), INCLUDE_ONLY)).toBe(
      'bun run worktree:setup',
    );
  });

  /**
   * F6, THE safety assertion. With node_modules missing, the fleet alias form
   * `bunx justin-sdk worktree-setup` cannot resolve the SDK locally, and bunx
   * falls back to the BARE npm name `justin-sdk` — a package that is not ours.
   * Printing the alias here would hand the user a command that fetches and runs
   * a stranger's code, so the rule is absolute regardless of the alias existing.
   */
  test('a node-modules problem forces the bunx-github form despite the alias', () => {
    const sb = track(createSandbox());
    const target = withAlias(sb);
    // Same target, same alias — only the STATE differs between these two.
    expect(hydrationFixCommand(target, INCLUDE_ONLY)).toBe(
      'bun run worktree:setup',
    );
    expect(hydrationFixCommand(target, WITH_NODE_MODULES)).toBe(
      WORKTREE_SETUP_BUNX,
    );
  });

  test('the node-modules rule holds whatever else is missing', () => {
    const sb = track(createSandbox());
    const target = withAlias(sb);
    expect(hydrationFixCommand(target, [problem('node-modules')])).toBe(
      WORKTREE_SETUP_BUNX,
    );
    expect(
      hydrationFixCommand(target, [
        problem('mise-untrusted'),
        problem('node-modules'),
      ]),
    ).toBe(WORKTREE_SETUP_BUNX);
    // …and an untrusted mise.toml alone does NOT force it: node_modules is
    // intact there, so the alias can genuinely run.
    expect(hydrationFixCommand(target, [problem('mise-untrusted')])).toBe(
      'bun run worktree:setup',
    );
  });

  test('falls back to the static-safe bunx form (no tier flag)', () => {
    const sb = track(createSandbox());
    writeFileSync(join(sb.path, 'package.json'), JSON.stringify({scripts: {}}));
    expect(hydrationFixCommand(sb.path, INCLUDE_ONLY)).toBe(
      WORKTREE_SETUP_BUNX,
    );
    expect(WORKTREE_SETUP_BUNX).not.toContain('--');
  });

  test('a missing or unparseable package.json falls back too', () => {
    const sb = track(createSandbox());
    expect(hydrationFixCommand(sb.path, INCLUDE_ONLY)).toBe(
      WORKTREE_SETUP_BUNX,
    );
    writeFileSync(join(sb.path, 'package.json'), '{not json');
    expect(hydrationFixCommand(sb.path, INCLUDE_ONLY)).toBe(
      WORKTREE_SETUP_BUNX,
    );
  });
});
