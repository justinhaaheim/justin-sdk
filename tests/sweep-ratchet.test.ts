/**
 * Tests for home-base-ckc4: the ratchet gate, cleanup-on-failure, the
 * hook-proof worktree add, counted skips, and preflight leftover removal.
 *
 * WHY THERE ARE REAL END-TO-END RUNS HERE, unlike in sweep-component.test.ts.
 * Four of the six acceptance criteria are statements about what the WHOLE
 * per-repo pipeline leaves behind after a red step ("no worktree, no branch, a
 * log naming the step"), and a decision helper cannot testify to that. What
 * used to make the pipeline untestable was its two network dependencies: the
 * `bunx @justinhaaheim/justin-sdk doctor` gate resolves the TARGET repo's
 * pinned SDK, and `bunx prettier` fetches prettier. Both are resolved from the
 * repo's own node_modules first, so a fixture that declares a local `file:`
 * dependency named `@justinhaaheim/justin-sdk` (and one named `prettier`) makes
 * the real orchestrator run its real steps against controllable fakes —
 * offline, in about a second per repo. `bun install` of two local file: deps IS
 * the hydration step, so that is real too.
 *
 * The fake SDK's exit codes are baked in per repo, and each fixture's `signal`
 * script is a real script that INSPECTS THE TREE — so a green→red signal here
 * is caused by the payload's actual bytes landing, not by a scripted sequence
 * of return codes.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import {join} from 'path';

import {
  addSweepWorktree,
  allowedLeftoverPaths,
  assessSweepLeftover,
  cleanupWorktreeAndBranch,
  createRunLog,
  isWorktreeRegistered,
  parseWorktreePaths,
  ratchetVerdict,
  runSweep,
  SWEEP_BRANCH,
  SWEEP_WORKTREE_SEGMENTS,
  tailLines,
} from '../src/sweep';
import {git, write} from './git-fixtures';
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
// Pure decisions
// ---------------------------------------------------------------------------

describe('tailLines', () => {
  test('keeps the LAST lines — the end of a failure is where the cause is', () => {
    const text = Array.from({length: 10}, (_, i) => `line ${i}`).join('\n');
    expect(tailLines(text, 3)).toBe('line 7\nline 8\nline 9');
  });

  test('shorter than the limit is returned whole', () => {
    expect(tailLines('only\nthis', 60)).toBe('only\nthis');
  });

  test('trailing blank lines do not eat the tail', () => {
    expect(tailLines('a\nb\n\n\n', 2)).toBe('a\nb');
  });
});

describe('parseWorktreePaths', () => {
  test('reads only the worktree lines of the porcelain record', () => {
    expect(
      parseWorktreePaths(
        'worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /repo/wt\nHEAD abc\nbranch refs/heads/x\n',
      ),
    ).toEqual(['/repo', '/repo/wt']);
  });

  test('empty porcelain means no worktrees', () => {
    expect(parseWorktreePaths('')).toEqual([]);
  });
});

describe('ratchetVerdict — the whole decision table (F3)', () => {
  test('green → green proceeds silently', () => {
    expect(ratchetVerdict('signal', 0, 0)).toEqual({kind: 'proceed', note: ''});
  });

  test('green → red FAILS, and says the payload did it', () => {
    const verdict = ratchetVerdict('signal', 0, 1);
    expect(verdict.kind).toBe('fail');
    expect(verdict.kind === 'fail' && verdict.reason).toContain(
      'was GREEN before the update',
    );
  });

  test('red → red proceeds BLIND, naming both exit codes', () => {
    const verdict = ratchetVerdict('signal', 2, 3);
    expect(verdict.kind).toBe('blind');
    expect(verdict.kind === 'blind' && verdict.note).toContain('PRE-EXISTING');
    expect(verdict.kind === 'blind' && verdict.note).toContain('exit 2');
  });

  test('red → green proceeds, and says the payload improved it', () => {
    const verdict = ratchetVerdict('doctor', 1, 0);
    expect(verdict.kind).toBe('proceed');
    expect(verdict.kind === 'proceed' && verdict.note).toContain(
      'red before the update',
    );
  });

  test('an UNMEASURABLE baseline is not green: a red after it fails', () => {
    const verdict = ratchetVerdict('signal', null, 1);
    expect(verdict.kind).toBe('fail');
    expect(verdict.kind === 'fail' && verdict.reason).toContain(
      'BASELINE could not be measured',
    );
  });

  test('an UNMEASURABLE baseline is not red either: a green after it proceeds', () => {
    expect(ratchetVerdict('signal', null, 0)).toEqual({
      kind: 'proceed',
      note: '',
    });
  });
});

describe('allowedLeftoverPaths', () => {
  test('a component sweep may delete over its own contract', () => {
    expect(
      allowedLeftoverPaths({component: 'critical-rules', mode: 'component'}),
    ).toContain('.claude/rules/justin-sdk/');
  });

  test('a component with no enumerated contract allows nothing', () => {
    expect(
      allowedLeftoverPaths({component: 'gitignore', mode: 'component'}),
    ).toEqual([]);
  });

  test('a FULL sweep allows nothing — only a pristine leftover is provably empty', () => {
    expect(allowedLeftoverPaths({mode: 'full'})).toEqual([]);
  });
});

describe('createRunLog', () => {
  test('writes nothing until something fails', () => {
    const sb = track(createSandbox());
    const log = createRunLog(join(sb.path, 'logs'));
    expect(log.wrote()).toBe(false);
    expect(existsSync(log.path)).toBe(false);
  });

  test('a failure records the repo, the step, the detail and the output TAIL', () => {
    const sb = track(createSandbox());
    const log = createRunLog(join(sb.path, 'logs'));
    log.record({
      detail: 'signal red after the update',
      output: Array.from({length: 200}, (_, i) => `noise ${i}`).join('\n'),
      repo: 'some-repo',
      step: 'signal',
    });

    expect(log.wrote()).toBe(true);
    const written = readFileSync(log.path, 'utf-8');
    expect(written).toContain('some-repo · step: signal');
    expect(written).toContain('signal red after the update');
    expect(written).toContain('noise 199');
    // …and only the tail: the first 140 lines are not in the file.
    expect(written).not.toContain('noise 0\n');
    expect(written).not.toContain('noise 139');
  });
});

// ---------------------------------------------------------------------------
// F1 — the hook-proof worktree add, against real git
// ---------------------------------------------------------------------------

/** A committed repo whose `post-checkout` hook exits `code` (ynab's shape). */
function repoWithHooks(
  sb: Sandbox,
  name: string,
  hooks: {postCheckout?: number; preCommit?: number},
): string {
  const root = join(sb.path, name);
  mkdirSync(root, {recursive: true});
  git(root, ['init', '-q', '-b', 'main', '.']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);
  const excludes = join(root, '.git', 'controlled-excludes');
  writeFileSync(excludes, '');
  git(root, ['config', 'core.excludesFile', excludes]);
  write(root, 'a.txt', 'a\n');
  for (const [file, code] of [
    ['post-checkout', hooks.postCheckout],
    ['pre-commit', hooks.preCommit],
  ] as const) {
    if (code == null) continue;
    write(
      root,
      `.husky/${file}`,
      `#!/bin/sh\necho "husky - ${file} hook ran"\nexit ${code}\n`,
    );
    chmodSync(join(root, '.husky', file), 0o755);
  }
  git(root, ['config', 'core.hooksPath', '.husky']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'init']);
  return root;
}

describe('addSweepWorktree (F1)', () => {
  test('NEGATIVE CONTROL: raw `git worktree add` in this fixture exits non-zero AND creates the worktree', () => {
    // The bug, reproduced exactly (measured first on ynab-mcp-deluxe, where
    // mise refuses the untrusted mise.toml the husky hook runs under): git
    // propagates the post-checkout hook's exit code, and keeps the worktree it
    // already created and registered. Without this control the test below would
    // also pass against a fixture whose hook never ran at all.
    const sb = track(createSandbox());
    const repo = repoWithHooks(sb, 'hostile', {postCheckout: 1});
    const dest = join(repo, 'raw-wt');

    let exitCode = 0;
    try {
      git(repo, ['worktree', 'add', '-b', 'raw-branch', dest, 'main']);
    } catch (error) {
      exitCode = (error as {status?: number}).status ?? -1;
    }

    expect(exitCode).toBe(1);
    expect(existsSync(dest)).toBe(true);
    expect(isWorktreeRegistered(repo, dest)).toBe(true);
  });

  test('the sweep adds the worktree anyway: hooks are disabled for that one invocation', () => {
    const sb = track(createSandbox());
    const repo = repoWithHooks(sb, 'hostile', {postCheckout: 1});
    const dest = join(repo, ...SWEEP_WORKTREE_SEGMENTS);
    const baseSha = git(repo, ['rev-parse', 'refs/heads/main']).trim();

    const result = addSweepWorktree(repo, dest, SWEEP_BRANCH, baseSha);

    expect(result.ok).toBe(true);
    expect(existsSync(dest)).toBe(true);
    expect(isWorktreeRegistered(repo, dest)).toBe(true);
    expect(git(repo, ['branch', '--list', SWEEP_BRANCH]).trim()).not.toBe('');
    // The hook did not run — its message is not in the add's output.
    expect(result.output).not.toContain('post-checkout hook ran');
    // …and the override was per-invocation: the repo still uses its own hooks.
    expect(git(dest, ['config', '--get', 'core.hooksPath']).trim()).toBe(
      '.husky',
    );
  });

  test('a failed add leaves nothing behind, even when git registered the worktree first', () => {
    // Drive the recovery path with the real failure it exists for: the raw
    // hooks-live add above, which really does exit 1 with a registered
    // worktree. cleanupWorktreeAndBranch is what addSweepWorktree calls on a
    // non-zero add, so this is that path, exercised against a genuine mess
    // rather than a simulated one.
    const sb = track(createSandbox());
    const repo = repoWithHooks(sb, 'hostile', {postCheckout: 1});
    const dest = join(repo, ...SWEEP_WORKTREE_SEGMENTS);
    mkdirSync(join(repo, '.claude', 'worktrees'), {recursive: true});
    try {
      git(repo, ['worktree', 'add', '-b', SWEEP_BRANCH, dest, 'main']);
    } catch {
      // expected: the hook fails the add after creating the worktree
    }
    expect(isWorktreeRegistered(repo, dest)).toBe(true);

    const cleaned = cleanupWorktreeAndBranch(repo, dest, SWEEP_BRANCH);

    expect(cleaned.ok).toBe(true);
    expect(existsSync(dest)).toBe(false);
    expect(isWorktreeRegistered(repo, dest)).toBe(false);
    expect(git(repo, ['branch', '--list', SWEEP_BRANCH]).trim()).toBe('');
  });
});

// ---------------------------------------------------------------------------
// F5 — is a leftover provably empty? (real git)
// ---------------------------------------------------------------------------

const RULES_CONTRACT = ['.claude/rules/justin-sdk/'] as const;

/** A repo carrying a leftover sweep worktree + branch, as a red run left it. */
function repoWithLeftover(
  sb: Sandbox,
  name: string,
): {
  repo: string;
  worktree: string;
} {
  const repo = repoWithHooks(sb, name, {});
  write(repo, '.claude/rules/justin-sdk/critical-rules.md', '# rules v1\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'rules']);
  const worktree = join(repo, ...SWEEP_WORKTREE_SEGMENTS);
  mkdirSync(join(repo, '.claude', 'worktrees'), {recursive: true});
  git(repo, ['worktree', 'add', '-q', '-b', SWEEP_BRANCH, worktree, 'main']);
  return {repo, worktree};
}

describe('assessSweepLeftover (F5)', () => {
  test('no leftover at all is reported as absent, not as unsafe', () => {
    const sb = track(createSandbox());
    const repo = repoWithHooks(sb, 'clean', {});
    expect(
      assessSweepLeftover(
        repo,
        join(repo, ...SWEEP_WORKTREE_SEGMENTS),
        SWEEP_BRANCH,
        'main',
        RULES_CONTRACT,
      ),
    ).toEqual({present: false});
  });

  test('zero commits and a pristine tree is SAFE', () => {
    const sb = track(createSandbox());
    const {repo, worktree} = repoWithLeftover(sb, 'empty');

    const verdict = assessSweepLeftover(
      repo,
      worktree,
      SWEEP_BRANCH,
      'main',
      RULES_CONTRACT,
    );

    expect(verdict).toMatchObject({present: true, safe: true});
    expect(verdict.present && verdict.reason).toContain(
      '0 commits beyond main',
    );
  });

  test('an uncommitted change INSIDE the contract is SAFE — the sweep regenerates it', () => {
    const sb = track(createSandbox());
    const {repo, worktree} = repoWithLeftover(sb, 'regenerable');
    writeFileSync(
      join(worktree, '.claude/rules/justin-sdk/critical-rules.md'),
      '# rules v2 (half-written by a red run)\n',
    );

    expect(
      assessSweepLeftover(repo, worktree, SWEEP_BRANCH, 'main', RULES_CONTRACT),
    ).toMatchObject({present: true, safe: true});
  });

  test('NEGATIVE CONTROL: an uncommitted change OUTSIDE the contract is never removed', () => {
    const sb = track(createSandbox());
    const {repo, worktree} = repoWithLeftover(sb, 'has-work');
    writeFileSync(join(worktree, 'a.txt'), 'somebody was editing this\n');

    const verdict = assessSweepLeftover(
      repo,
      worktree,
      SWEEP_BRANCH,
      'main',
      RULES_CONTRACT,
    );

    expect(verdict).toMatchObject({present: true, safe: false});
    expect(verdict.present && verdict.reason).toContain('a.txt');
  });

  test('NEGATIVE CONTROL: a commit beyond the default branch is never removed', () => {
    const sb = track(createSandbox());
    const {repo, worktree} = repoWithLeftover(sb, 'has-commit');
    writeFileSync(join(worktree, 'a.txt'), 'real work\n');
    git(worktree, ['add', '-A']);
    git(worktree, ['commit', '-qm', 'work nobody else has']);

    const verdict = assessSweepLeftover(
      repo,
      worktree,
      SWEEP_BRANCH,
      'main',
      RULES_CONTRACT,
    );

    expect(verdict).toMatchObject({present: true, safe: false});
    expect(verdict.present && verdict.reason).toContain('1 commit(s) beyond');
  });

  test('a directory that is not a registered worktree is never deleted', () => {
    const sb = track(createSandbox());
    const repo = repoWithHooks(sb, 'stray', {});
    const path = join(repo, ...SWEEP_WORKTREE_SEGMENTS);
    mkdirSync(path, {recursive: true});
    writeFileSync(join(path, 'someones-notes.txt'), 'not gits\n');

    const verdict = assessSweepLeftover(
      repo,
      path,
      SWEEP_BRANCH,
      'main',
      RULES_CONTRACT,
    );

    expect(verdict).toMatchObject({present: true, safe: false});
    expect(verdict.present && verdict.reason).toContain(
      'git does not know as a worktree',
    );
  });

  test('a leftover BRANCH with no worktree is assessed too', () => {
    const sb = track(createSandbox());
    const repo = repoWithHooks(sb, 'branch-only', {});
    git(repo, ['branch', SWEEP_BRANCH, 'main']);

    expect(
      assessSweepLeftover(
        repo,
        join(repo, ...SWEEP_WORKTREE_SEGMENTS),
        SWEEP_BRANCH,
        'main',
        RULES_CONTRACT,
      ),
    ).toMatchObject({present: true, safe: true});
  });
});

// ---------------------------------------------------------------------------
// The hermetic end-to-end harness
// ---------------------------------------------------------------------------

interface E2EOptions {
  /** Exit code of the read-only `doctor` baseline. */
  doctorExit?: number;
  /** Exit code of the `doctor --fix` gate. */
  doctorFixExit?: number;
  /**
   * always-green      — signal passes before and after (the ordinary repo)
   * always-red        — signal fails before and after (userscripts-j's shape)
   * red-when-swept    — signal fails exactly once the payload's bytes land
   */
  signal?: 'always-green' | 'always-red' | 'red-when-swept';
  /** A pre-commit hook that exits non-zero (health-logger-rn's shape). */
  hostilePreCommit?: boolean;
  /** A dependency bun cannot resolve, so hydration really fails. */
  breakHydration?: boolean;
}

/**
 * A committed repo the WHOLE sweep pipeline can run against, offline.
 *
 * The two `file:` dependencies are what make it hermetic: `bunx
 * @justinhaaheim/justin-sdk doctor` and `bunx prettier` both resolve the
 * repo's own node_modules first, so the fixture decides what the gates do
 * without any network or any installed SDK.
 */
function e2eRepo(sb: Sandbox, name: string, options: E2EOptions = {}): string {
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

/** Nothing of the sweep survives in `repo`: no directory, no registration, no branch. */
function expectNoSweepRemains(repo: string): void {
  const worktree = join(repo, ...SWEEP_WORKTREE_SEGMENTS);
  expect(existsSync(worktree)).toBe(false);
  expect(isWorktreeRegistered(repo, worktree)).toBe(false);
  expect(git(repo, ['branch', '--list', SWEEP_BRANCH]).trim()).toBe('');
}

// ---------------------------------------------------------------------------
// F2 — a red step cleans up and leaves its evidence in the log
// ---------------------------------------------------------------------------

describe('a red step removes the worktree and logs the evidence (F2)', () => {
  test('a hydration failure leaves NO worktree and NO branch, and names the step in the log', async () => {
    const sb = track(createSandbox());
    const repo = e2eRepo(sb, 'broken-hydration', {breakHydration: true});
    const logDir = join(sb.path, 'logs');

    const {out, value} = await captureLog(() =>
      runSweep({component: 'gitignore', logDir, repos: [repo]}),
    );

    expect(value).toBe(1);
    expect(out).toContain('hydration failed twice');
    expectNoSweepRemains(repo);

    const logPath = out.match(/failure log: (\S+\.log)/)?.[1];
    expect(logPath).toBeDefined();
    const written = readFileSync(logPath as string, 'utf-8');
    expect(written).toContain('broken-hydration · step: hydrate');
    expect(written).toContain('INSTALL failed');
  });

  test('a payload-caused signal red is FAILED, cleaned up, and both gate runs are logged', async () => {
    const sb = track(createSandbox());
    const repo = e2eRepo(sb, 'payload-breaks-it', {signal: 'red-when-swept'});
    const logDir = join(sb.path, 'logs');

    const {out, value} = await captureLog(() =>
      runSweep({component: 'gitignore', logDir, repos: [repo]}),
    );

    expect(value).toBe(1);
    expect(out).toContain('was GREEN before the update and is red after');
    expectNoSweepRemains(repo);
    // Nothing was merged into main either.
    expect(git(repo, ['show', 'main:.gitignore'])).not.toContain(
      'justin-sdk baseline',
    );

    const logPath = out.match(/failure log: (\S+\.log)/)?.[1];
    const written = readFileSync(logPath as string, 'utf-8');
    expect(written).toContain('payload-breaks-it · step: signal');
    expect(written).toContain('--- BASELINE (signal, before the payload) ---');
    expect(written).toContain('fixture signal: payload applied = false');
    expect(written).toContain('fixture signal: payload applied = true');
  });

  test('a commit failure is cleaned up too, with git own error in the log', async () => {
    // The one red step --no-verify cannot mask: git refuses an empty ident. It
    // is also the step furthest down the pipeline, so reaching it proves the
    // cleanup runs from the very end of the per-repo run, not just from the
    // early failures.
    const sb = track(createSandbox());
    const repo = e2eRepo(sb, 'uncommittable');
    git(repo, ['config', 'user.name', '']);
    git(repo, ['config', 'user.email', '']);

    const {out, value} = await captureLog(() =>
      runSweep({
        component: 'gitignore',
        logDir: join(sb.path, 'logs'),
        repos: [repo],
      }),
    );

    expect(value).toBe(1);
    expect(out).toContain('commit failed');
    expectNoSweepRemains(repo);

    const logPath = out.match(/failure log: (\S+\.log)/)?.[1];
    const written = readFileSync(logPath as string, 'utf-8');
    expect(written).toContain('uncommittable · step: commit');
    // The raw command output, not just our own summary of it.
    expect(written).toContain('empty ident name');
  });

  test('a green run writes no log file at all', async () => {
    const sb = track(createSandbox());
    const repo = e2eRepo(sb, 'green');
    const logDir = join(sb.path, 'logs');

    const {out, value} = await captureLog(() =>
      runSweep({component: 'gitignore', logDir, repos: [repo]}),
    );

    expect(value).toBe(0);
    expect(out).not.toContain('\nfailure log:');
    expect(existsSync(logDir)).toBe(false);
    expect(out).not.toContain('registry.npmjs.org');
    expectNoSweepRemains(repo);
  });

  test('a merge-pending run KEEPS its worktree on purpose, and says so', async () => {
    const sb = track(createSandbox());
    const repo = e2eRepo(sb, 'merge-deferred');
    // The primary is dirty on a file the sweep changes → mergeSafety refuses,
    // and the commit lives only on the sweep branch.
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\nbun.lock\nlocal\n');

    const {out, value} = await captureLog(() =>
      runSweep({
        component: 'gitignore',
        logDir: join(sb.path, 'logs'),
        repos: [repo],
      }),
    );

    expect(value).toBe(0);
    expect(out).toContain('merge deferred');
    expect(out).toContain('KEPT ON PURPOSE');
    expect(existsSync(join(repo, ...SWEEP_WORKTREE_SEGMENTS))).toBe(true);
    expect(git(repo, ['branch', '--list', SWEEP_BRANCH]).trim()).not.toBe('');
  });
});

// ---------------------------------------------------------------------------
// F3 / F3b — the ratchet, end to end
// ---------------------------------------------------------------------------

describe('the ratchet gate, end to end (F3)', () => {
  test('a repo that was ALREADY red is swept and merged, with the pre-existing note in its summary line', async () => {
    const sb = track(createSandbox());
    const repo = e2eRepo(sb, 'already-red', {
      doctorExit: 1,
      doctorFixExit: 1,
      signal: 'always-red',
    });

    const {out, value} = await captureLog(() =>
      runSweep({
        component: 'gitignore',
        logDir: join(sb.path, 'logs'),
        repos: [repo],
      }),
    );

    expect(value).toBe(0);
    expect(out).toContain('signal already red before the update');
    expect(out).toContain('doctor already red before the update');
    expect(out).toContain('gate blind here');
    // HERMETICITY GUARD. Measured while writing these tests: with no exec bit
    // on the fake's cli.js, bunx fell through to the registry and the doctor
    // gate reported npm's 404 as the repo's exit code — the test would have
    // passed for entirely the wrong reason.
    expect(out).toContain('fixture justin-sdk doctor');
    expect(out).not.toContain('registry.npmjs.org');
    // Really merged, not merely "not failed".
    expect(git(repo, ['show', 'main:.gitignore'])).toContain(
      'justin-sdk baseline',
    );
    expectNoSweepRemains(repo);
  });

  test('the blind note reaches the SUMMARY line, not just the scrollback', async () => {
    const sb = track(createSandbox());
    const repo = e2eRepo(sb, 'already-red-summary', {signal: 'always-red'});

    const {out} = await captureLog(() =>
      runSweep({
        component: 'gitignore',
        logDir: join(sb.path, 'logs'),
        repos: [repo],
      }),
    );

    const summaryLine = out
      .split('\n')
      .find(
        (line) =>
          line.includes('already-red-summary') &&
          line.includes('merged into main'),
      );
    expect(summaryLine).toBeDefined();
    expect(summaryLine).toContain('PRE-EXISTING');
  });

  test('a doctor that goes green → red fails the repo', async () => {
    const sb = track(createSandbox());
    const repo = e2eRepo(sb, 'doctor-regressed', {
      doctorExit: 0,
      doctorFixExit: 1,
    });

    const {out, value} = await captureLog(() =>
      runSweep({
        component: 'gitignore',
        logDir: join(sb.path, 'logs'),
        repos: [repo],
      }),
    );

    expect(value).toBe(1);
    expect(out).toContain(
      'doctor was GREEN before the update and is red after',
    );
    expectNoSweepRemains(repo);
  });
});

describe('the sweep commit passes --no-verify (F3b)', () => {
  test('a repo whose pre-commit hook always fails is still committed and merged', async () => {
    const sb = track(createSandbox());
    const repo = e2eRepo(sb, 'hostile-pre-commit', {hostilePreCommit: true});

    const {out, value} = await captureLog(() =>
      runSweep({
        component: 'gitignore',
        logDir: join(sb.path, 'logs'),
        repos: [repo],
      }),
    );

    expect(value).toBe(0);
    expect(out).toContain('merged into main');
    expect(out).not.toContain('pre-commit (ts-check) FAILED');
    expect(git(repo, ['show', 'main:.gitignore'])).toContain(
      'justin-sdk baseline',
    );
  });

  test('NEGATIVE CONTROL: the same fixture refuses an ordinary commit', () => {
    // Proves the hook is genuinely hostile — otherwise the test above would
    // pass just as well with --no-verify removed.
    const sb = track(createSandbox());
    const repo = e2eRepo(sb, 'hostile-pre-commit-control', {
      hostilePreCommit: true,
    });
    writeFileSync(join(repo, 'a.txt'), 'change\n');
    git(repo, ['add', '-A']);

    let exitCode = 0;
    try {
      git(repo, ['commit', '-m', 'would be blocked']);
    } catch (error) {
      exitCode = (error as {status?: number}).status ?? -1;
    }
    expect(exitCode).toBe(1);

    // …and the sweep's own form of that commit goes through.
    expect(() =>
      git(repo, ['commit', '--no-verify', '-m', 'the sweep shape']),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// F4 / F5 — counted skips and preflight leftover removal, end to end
// ---------------------------------------------------------------------------

describe('skips are counted and separated (F4)', () => {
  test('"could not sweep" is named LAST and fails the run; "not enrolled" does not', async () => {
    const sb = track(createSandbox());
    const green = e2eRepo(sb, 'a-green');
    const stuck = e2eRepo(sb, 'b-stuck');
    const other = e2eRepo(sb, 'c-not-enrolled');
    // c is enrolled in neither the payload's component…
    write(
      other,
      'justin-sdk.config.json',
      JSON.stringify({components: ['base-setup']}, null, 2) + '\n',
    );
    git(other, ['add', '-A']);
    git(other, ['commit', '-qm', 'drop the component']);
    // …and b carries a leftover the sweep may NOT delete.
    const stuckWorktree = join(stuck, ...SWEEP_WORKTREE_SEGMENTS);
    mkdirSync(join(stuck, '.claude', 'worktrees'), {recursive: true});
    git(stuck, [
      'worktree',
      'add',
      '-q',
      '-b',
      SWEEP_BRANCH,
      stuckWorktree,
      'main',
    ]);
    writeFileSync(join(stuckWorktree, 'a.txt'), 'unfinished work\n');
    git(stuckWorktree, ['add', '-A']);
    git(stuckWorktree, ['commit', '-qm', 'work nobody else has']);

    const {out, value} = await captureLog(() =>
      runSweep({
        component: 'gitignore',
        logDir: join(sb.path, 'logs'),
        repos: [green, stuck, other],
      }),
    );

    expect(value).toBe(1);
    expect(out).toContain('1 not enrolled in this payload');
    expect(out).toContain('c-not-enrolled');
    expect(out).toContain('COULD NOT SWEEP: b-stuck');
    // Last, where the tail of a long run is actually read.
    const lines = out.split('\n').filter((line) => line.trim() !== '');
    expect(lines[lines.length - 1]).toContain('then re-sweep');
    expect(out.indexOf('COULD NOT SWEEP')).toBeGreaterThan(
      out.indexOf('not enrolled in this payload'),
    );
    // The green repo was still swept — one blocked repo does not stop the run.
    expect(git(green, ['show', 'main:.gitignore'])).toContain(
      'justin-sdk baseline',
    );
    // And b was left exactly as it was.
    expect(existsSync(stuckWorktree)).toBe(true);
  });
});

describe('preflight removes a provably-empty leftover (F5)', () => {
  test('an empty leftover is removed, explained, and the repo is then swept', async () => {
    const sb = track(createSandbox());
    const repo = e2eRepo(sb, 'leftover');
    const worktree = join(repo, ...SWEEP_WORKTREE_SEGMENTS);
    mkdirSync(join(repo, '.claude', 'worktrees'), {recursive: true});
    git(repo, ['worktree', 'add', '-q', '-b', SWEEP_BRANCH, worktree, 'main']);

    const {out, value} = await captureLog(() =>
      runSweep({
        component: 'gitignore',
        logDir: join(sb.path, 'logs'),
        repos: [repo],
      }),
    );

    expect(value).toBe(0);
    expect(out).toContain('auto-removed a leftover from an earlier run');
    expect(out).toContain('0 commits beyond main');
    expect(git(repo, ['show', 'main:.gitignore'])).toContain(
      'justin-sdk baseline',
    );
    expectNoSweepRemains(repo);
  });

  test('a leftover is cleaned even in a repo NOT enrolled in this payload', async () => {
    // The leftover is the sweep's own litter at a fixed path, so it blocks
    // every future sweep of that repo whatever the payload — while enrollment
    // only says whether the PAYLOAD applies. A repo that is out of scope for
    // this component would otherwise keep its stranded worktree until some
    // future run happened to carry a payload it is enrolled in.
    const sb = track(createSandbox());
    const repo = e2eRepo(sb, 'leftover-unenrolled');
    write(
      repo,
      'justin-sdk.config.json',
      JSON.stringify({components: ['base-setup']}, null, 2) + '\n',
    );
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'drop the component']);
    const worktree = join(repo, ...SWEEP_WORKTREE_SEGMENTS);
    mkdirSync(join(repo, '.claude', 'worktrees'), {recursive: true});
    git(repo, ['worktree', 'add', '-q', '-b', SWEEP_BRANCH, worktree, 'main']);

    const {out, value} = await captureLog(() =>
      runSweep({
        component: 'gitignore',
        logDir: join(sb.path, 'logs'),
        repos: [repo],
      }),
    );

    expect(value).toBe(0);
    expect(out).toContain('auto-removed a leftover from an earlier run');
    expect(out).toContain('not enrolled in gitignore');
    expectNoSweepRemains(repo);
  });

  test('an UNSAFE leftover in a not-enrolled repo is reported, but does not fail the run', async () => {
    // The mirror of the case above: this run had no business sweeping the repo,
    // so a leftover it may not delete is news, not a failure. In an ENROLLED
    // repo the same leftover is a "could not sweep" (see the F4 test).
    const sb = track(createSandbox());
    const repo = e2eRepo(sb, 'unenrolled-with-work');
    write(
      repo,
      'justin-sdk.config.json',
      JSON.stringify({components: ['base-setup']}, null, 2) + '\n',
    );
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'drop the component']);
    const worktree = join(repo, ...SWEEP_WORKTREE_SEGMENTS);
    mkdirSync(join(repo, '.claude', 'worktrees'), {recursive: true});
    git(repo, ['worktree', 'add', '-q', '-b', SWEEP_BRANCH, worktree, 'main']);
    writeFileSync(join(worktree, 'a.txt'), 'unfinished work\n');

    const {out, value} = await captureLog(() =>
      runSweep({
        component: 'gitignore',
        logDir: join(sb.path, 'logs'),
        repos: [repo],
      }),
    );

    expect(value).toBe(0);
    expect(out).toContain('a leftover was left alone');
    expect(out).not.toContain('COULD NOT SWEEP');
    expect(existsSync(worktree)).toBe(true);
  });

  test('--dry-run says it WOULD remove one, and removes nothing', async () => {
    const sb = track(createSandbox());
    const repo = e2eRepo(sb, 'leftover-dry');
    const worktree = join(repo, ...SWEEP_WORKTREE_SEGMENTS);
    mkdirSync(join(repo, '.claude', 'worktrees'), {recursive: true});
    git(repo, ['worktree', 'add', '-q', '-b', SWEEP_BRANCH, worktree, 'main']);

    const {out, value} = await captureLog(() =>
      runSweep({
        component: 'gitignore',
        dryRun: true,
        logDir: join(sb.path, 'logs'),
        repos: [repo],
      }),
    );

    expect(value).toBe(0);
    expect(out).toContain('would auto-remove a leftover');
    expect(existsSync(worktree)).toBe(true);
    expect(git(repo, ['branch', '--list', SWEEP_BRANCH]).trim()).not.toBe('');
  });
});
