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
  LEGACY_SWEEP_NAME,
  parseWorktreePaths,
  ratchetVerdict,
  runSweep,
  sweepBranchFor,
  SWEEP_WORKTREES_DIR,
  tailLines,
} from '../src/sweep';
import {
  captureLog,
  e2eRepo,
  expectNoSweepRemains,
  sweepRemains,
} from './sweep-e2e-fixtures';
import {git, write} from './git-fixtures';
import {createSandbox, type Sandbox} from './sandbox';

/**
 * The FIXED name every run used until 2026-10-05 (39co9.6 S1). Runs now stamp
 * their own name; these tests build leftovers under the old one because that is
 * what the pre-2026-10-05 runs left in the fleet, and the scan must still find
 * and judge them.
 */
const SWEEP_BRANCH = sweepBranchFor(LEGACY_SWEEP_NAME);
const SWEEP_WORKTREE_SEGMENTS = [...SWEEP_WORKTREES_DIR, LEGACY_SWEEP_NAME];

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
  test('S4: the log exists from the moment the run starts, header first', () => {
    // Reversed 2026-10-05 (39co9.6 S4). It used to write nothing until a step
    // went red, so an INTERRUPTED run left no trace at all.
    const sb = track(createSandbox());
    const log = createRunLog(join(sb.path, 'logs'), new Date(), {
      header: ['branch: worktree-sdk-sweep-x'],
    });
    expect(log.recordedFailure()).toBe(false);
    expect(existsSync(log.path)).toBe(true);
    expect(readFileSync(log.path, 'utf-8')).toContain(
      'branch: worktree-sdk-sweep-x',
    );
    log.note('some-repo', 'committed abc on worktree-sdk-sweep-x');
    expect(readFileSync(log.path, 'utf-8')).toContain(
      'some-repo: committed abc on worktree-sdk-sweep-x',
    );
  });

  test('a dry run writes nothing anywhere', () => {
    const sb = track(createSandbox());
    const log = createRunLog(join(sb.path, 'logs'), new Date(), {
      persist: false,
    });
    log.note('some-repo', 'would do things');
    expect(existsSync(join(sb.path, 'logs'))).toBe(false);
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

    expect(log.recordedFailure()).toBe(true);
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

    const logPath = /failure log: (\S+\.log)/.exec(out)?.[1];
    expect(logPath).toBeDefined();
    const written = readFileSync(logPath!, 'utf-8');
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

    const logPath = /failure log: (\S+\.log)/.exec(out)?.[1];
    const written = readFileSync(logPath!, 'utf-8');
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

    const logPath = /failure log: (\S+\.log)/.exec(out)?.[1];
    const written = readFileSync(logPath!, 'utf-8');
    expect(written).toContain('uncommittable · step: commit');
    // The raw command output, not just our own summary of it.
    expect(written).toContain('empty ident name');
  });

  test('a green run writes a run log (S4) but no failure section', async () => {
    // Was "a green run writes no log file at all" until 39co9.6 S4.
    const sb = track(createSandbox());
    const repo = e2eRepo(sb, 'green');
    const logDir = join(sb.path, 'logs');

    const {out, value} = await captureLog(() =>
      runSweep({component: 'gitignore', logDir, repos: [repo]}),
    );

    expect(value).toBe(0);
    expect(out).not.toContain('\nfailure log:');
    expect(out).not.toContain('registry.npmjs.org');
    expectNoSweepRemains(repo);
    const logPath = /run log: (\S+\.log)/.exec(out)?.[1];
    const written = readFileSync(logPath!, 'utf-8');
    expect(written).toContain('green: committed');
    expect(written).toContain('green: merged worktree-sdk-sweep-');
    expect(written).toContain('exit 0');
    expect(written).not.toContain('· step:');
  });

  test('a merge-pending run KEEPS its worktree on purpose, says so, and FAILS the run (S7)', async () => {
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

    // S7 (2026-10-05): a merge-deferred repo did not get the payload, so the
    // run exits non-zero. It used to exit 0 and say "0 failed".
    expect(value).toBe(1);
    expect(out).toContain('merge deferred');
    expect(out).toContain('KEPT ON PURPOSE');
    expect(out).toContain('1 merge-pending');
    // Kept under THIS run's stamped name, branch and directory alike.
    const [kept, ...others] = sweepRemains(repo);
    expect(others).toEqual([]);
    expect(kept).toMatch(/^sdk-sweep-\d{4}-/);
    expect(existsSync(join(repo, ...SWEEP_WORKTREES_DIR, kept!))).toBe(true);
    expect(
      git(repo, ['branch', '--list', sweepBranchFor(kept!)]).trim(),
    ).not.toBe('');
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
    // …and b's committed enrollment cannot be read. (Until 39co9.6 the blocker
    // here was a leftover holding work; a leftover no longer blocks — S2 — so
    // the could-not-sweep case is now built from an unreadable config.)
    write(stuck, 'justin-sdk.config.json', '{ not json\n');
    git(stuck, ['add', '-A']);
    git(stuck, ['commit', '-qm', 'corrupt the config']);
    const stuckHead = git(stuck, ['rev-parse', 'HEAD']).trim();

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
    expect(git(stuck, ['rev-parse', 'HEAD']).trim()).toBe(stuckHead);
    expectNoSweepRemains(stuck);
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
    expect(out).toContain('a leftover from an earlier run was left alone');
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
