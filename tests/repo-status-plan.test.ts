/**
 * Tests for plan/apply — the only mutating path in repo-status.
 *
 * apply RENAMES finished branches to archive/<name> rather than deleting them,
 * so the tests here are mostly about proving nothing is destroyed:
 *
 *  - DRIFT: a branch that gains a commit between plan and apply keeps that
 *    commit. Under a delete-based design this was the dangerous case; under a
 *    rename it is simply carried along, which is the whole argument for the
 *    rename default.
 *  - COLLISION: an existing archive/<name> is never clobbered.
 *  - The one surviving deletion path (a branch an archive mirror already holds
 *    in full) still refuses when the mirror has gone stale.
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
    // Default action is a non-destructive rename, not a delete.
    expect(plan.safe[0]?.action).toBe('archive-local-branch');
    expect(plan.safe[0]?.target).toBe('archive/landed');
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
  test('RENAMES a merged branch to archive/* — the commits survive', () => {
    const sb = track(createSandbox());
    initRepo(sb);
    addSquashMergedBranch(sb, 'landed');
    const tip = git(sb.path, ['rev-parse', 'landed']);

    const results = executePlan(buildPlan(report(sb)), sb.path);
    expect(results[0]?.outcome).toBe('archived');
    expect(results[0]?.target).toBe('archive/landed');

    const branches = git(sb.path, [
      'branch',
      '--format=%(refname:short)',
    ]).split('\n');
    expect(branches).not.toContain('landed');
    expect(branches).toContain('archive/landed');
    // The whole point: nothing was destroyed.
    expect(git(sb.path, ['rev-parse', 'archive/landed'])).toBe(tip);
  });

  test('refuses to clobber an existing archive ref', () => {
    const sb = track(createSandbox());
    initRepo(sb);
    addSquashMergedBranch(sb, 'landed');
    // An unrelated archive/landed already exists, holding different work.
    git(sb.path, ['branch', 'archive/landed', 'main']);
    const existing = git(sb.path, ['rev-parse', 'archive/landed']);
    const plan = buildPlan(report(sb));

    // buildPlan sees a mirror that does NOT cover the branch -> not safe at all.
    // Force the rename path to prove executePlan itself guards the collision.
    const forced = {
      ...plan,
      safe: [
        {
          action: 'archive-local-branch' as const,
          branch: 'landed',
          reason: 'forced',
          remoteArchive: null,
          target: 'archive/landed',
        },
      ],
    };
    const results = executePlan(forced, sb.path);
    expect(results[0]?.outcome).toBe('skipped');
    expect(results[0]?.reason).toContain('already exists');
    expect(git(sb.path, ['rev-parse', 'archive/landed'])).toBe(existing);
    expect(git(sb.path, ['rev-parse', 'landed'])).toBeTruthy();
  });

  test('DRIFT: a branch that gains a commit after planning still keeps that commit', () => {
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
    // A rename is safe regardless of drift — the late commit rides along.
    expect(results[0]?.outcome).toBe('archived');
    // This is the property that makes renaming the right default: even when the
    // plan was stale, the work that arrived after it survives — under the
    // archived name, reachable, recoverable.
    expect(git(sb.path, ['log', '-1', '--format=%s', 'archive/landed'])).toBe(
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
