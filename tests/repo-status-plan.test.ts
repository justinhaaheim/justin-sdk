/**
 * Tests for plan/apply — the only mutating path in repo-status.
 *
 * The test that matters most is the DRIFT one: a branch that was proven safe
 * when the plan was built, then gained a commit before apply ran, must be
 * SKIPPED rather than deleted. That guard is the difference between "proven
 * safe at report time" and "proven safe at deletion time", and without a test
 * it would be trivially easy to regress into deleting live work.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {execFileSync} from 'child_process';
import {writeFileSync} from 'fs';
import {join} from 'path';

import {buildPlan, executePlan} from '../src/repo-status/plan';
import {buildReport} from '../src/repo-status/report';
import {createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
function track(sb: Sandbox): Sandbox {
  sandboxes.push(sb);
  return sb;
}
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: 'pipe',
  }).trim();
}

function initRepo(sb: Sandbox): void {
  git(sb.path, ['init', '-q', '-b', 'main']);
  git(sb.path, ['config', 'user.email', 'test@example.com']);
  git(sb.path, ['config', 'user.name', 'Test']);
  sb.writeFile('README.md', 'hello\n');
  git(sb.path, ['add', 'README.md']);
  git(sb.path, ['commit', '-q', '-m', 'initial']);
}

function commit(sb: Sandbox, file: string, body: string, msg: string): void {
  writeFileSync(join(sb.path, file), body);
  git(sb.path, ['add', file]);
  git(sb.path, ['commit', '-q', '-m', msg]);
}

/** A branch whose work was squash-merged into main — provably safe. */
function addSquashMergedBranch(sb: Sandbox, name: string): void {
  git(sb.path, ['checkout', '-q', '-b', name]);
  commit(sb, `${name}.txt`, `${name} work\n`, `${name} work`);
  git(sb.path, ['checkout', '-q', 'main']);
  git(sb.path, ['merge', '--squash', name]);
  git(sb.path, ['commit', '-q', '-m', `squashed ${name}`]);
}

function report(sb: Sandbox) {
  const r = buildReport({
    content: true,
    cwd: sb.path,
    prs: false,
    sinceDays: null,
  });
  if (r == null) throw new Error('expected a report');
  return r;
}

describe('buildPlan', () => {
  test('proven-safe local branches are automatable; unmerged ones are never', () => {
    const sb = track(createSandbox());
    initRepo(sb);
    addSquashMergedBranch(sb, 'landed');
    git(sb.path, ['checkout', '-q', '-b', 'live-work']);
    commit(sb, 'live.txt', 'not merged anywhere\n', 'live work');
    git(sb.path, ['checkout', '-q', 'main']);

    const plan = buildPlan(report(sb));
    expect(plan.safe.map((a) => a.branch)).toEqual(['landed']);
    expect(plan.needsJudgment.map((a) => a.branch)).toContain('live-work');
    expect(plan.safe.every((a) => a.action === 'delete-local-branch')).toBe(
      true,
    );
  });

  test('a branch checked out in a worktree is proven-safe but left MANUAL', () => {
    const sb = track(createSandbox());
    initRepo(sb);
    addSquashMergedBranch(sb, 'landed');
    const wt = `${sb.path}-wt`;
    git(sb.path, ['worktree', 'add', '-q', wt, 'landed']);
    try {
      const plan = buildPlan(report(sb));
      expect(plan.safe).toHaveLength(0);
      expect(plan.manual.map((a) => a.branch)).toEqual(['landed']);
      expect(plan.manual[0]?.reason).toContain('remove the worktree first');
    } finally {
      execFileSync('git', ['worktree', 'remove', '--force', wt], {
        cwd: sb.path,
      });
    }
  });
});

describe('executePlan', () => {
  test('deletes a branch that is proven merged by content', () => {
    const sb = track(createSandbox());
    initRepo(sb);
    addSquashMergedBranch(sb, 'landed');

    const results = executePlan(buildPlan(report(sb)), sb.path);
    expect(results).toEqual([
      {
        branch: 'landed',
        outcome: 'deleted',
        reason: 'content present on baseline',
      },
    ]);
    const branches = git(sb.path, ['branch', '--format=%(refname:short)']);
    expect(branches.split('\n')).not.toContain('landed');
  });

  test('DRIFT GUARD: a branch that gains a commit after planning is skipped, not deleted', () => {
    const sb = track(createSandbox());
    initRepo(sb);
    addSquashMergedBranch(sb, 'landed');

    // Plan while it is genuinely safe.
    const plan = buildPlan(report(sb));
    expect(plan.safe.map((a) => a.branch)).toEqual(['landed']);

    // Someone pushes new work to it before apply runs.
    git(sb.path, ['checkout', '-q', 'landed']);
    commit(sb, 'late.txt', 'work added after the plan\n', 'late work');
    git(sb.path, ['checkout', '-q', 'main']);

    const results = executePlan(plan, sb.path);
    expect(results[0]?.outcome).toBe('skipped');
    expect(results[0]?.reason).toContain('no longer proves safe');
    // The branch — and the late commit — must still exist.
    const branches = git(sb.path, ['branch', '--format=%(refname:short)']);
    expect(branches.split('\n')).toContain('landed');
    expect(git(sb.path, ['log', '-1', '--format=%s', 'landed'])).toBe(
      'late work',
    );
  });

  test('a branch preserved only by an exact archive mirror is deleted; a stale mirror is not', () => {
    const sb = track(createSandbox());
    initRepo(sb);

    // Exactly mirrored, never merged -> safe to delete the branch itself.
    git(sb.path, ['checkout', '-q', '-b', 'mirrored-ok']);
    commit(sb, 'm.txt', 'archived work\n', 'archived work');
    git(sb.path, ['branch', 'archive/mirrored-ok']);

    // Mirror taken, then the branch moved on -> STALE, must never be deleted.
    git(sb.path, ['checkout', '-q', '-b', 'mirrored-stale', 'main']);
    commit(sb, 's.txt', 'first\n', 'first');
    git(sb.path, ['branch', 'archive/mirrored-stale']);
    commit(sb, 's2.txt', 'work after the mirror\n', 'work after the mirror');
    git(sb.path, ['checkout', '-q', 'main']);

    const plan = buildPlan(report(sb));
    expect(plan.safe.map((a) => a.branch)).toContain('mirrored-ok');
    expect(plan.safe.map((a) => a.branch)).not.toContain('mirrored-stale');
    expect(plan.needsJudgment.map((a) => a.branch)).toContain('mirrored-stale');

    executePlan(plan, sb.path);
    const branches = git(sb.path, [
      'branch',
      '--format=%(refname:short)',
    ]).split('\n');
    expect(branches).not.toContain('mirrored-ok');
    // The stale one, and its unmirrored commit, survive.
    expect(branches).toContain('mirrored-stale');
    expect(git(sb.path, ['log', '-1', '--format=%s', 'mirrored-stale'])).toBe(
      'work after the mirror',
    );
  });
});
