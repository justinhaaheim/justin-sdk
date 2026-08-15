/**
 * A failed measurement must never read as a safe one (home-base-qyu1.21).
 *
 * `countDivergence` used to answer `{ahead: 0, behind: 0}` whenever its
 * `rev-list` failed for ANY reason. `ahead === 0` is the disposition engine's
 * strongest statement — `merged`, `provenSafe: true` — and `provenSafe` is the
 * single field `plan`/`apply` act on. So a transient git failure turned into a
 * licence to archive a local branch and, on the `--include-remote` path, to
 * DELETE a remote one. The pre-flight guards could not catch it either: they
 * verify the tip sha with `rev-parse`, which keeps succeeding while the walk
 * fails.
 *
 * ── Why the fixture is a genuinely broken repo ───────────────────────────────
 *
 * The failure is induced by deleting one loose object that is an ANCESTOR of a
 * branch tip — a real (if unlucky) state: an interrupted fetch, a gc race, a
 * damaged object store. That gives precisely the asymmetry the bug needs:
 *
 *   for-each-ref  succeeds (it reads the TIP, which is intact)
 *   rev-parse     succeeds (same reason — so GUARDs 2/3 pass)
 *   rev-list      fails (it walks, and hits the missing object)
 *
 * A PATH shim that refuses `rev-list` would express the same thing, but only
 * for a SUBPROCESS: Bun snapshots PATH at startup, so `execFileSync` inside a
 * test cannot see a shim installed by that test, and the whole in-process
 * report/plan/apply chain — the part that actually decides what gets deleted —
 * would be out of reach. Corrupting the repo needs no shim at all, and asserts
 * against git's real behaviour rather than a simulation of it.
 *
 * Every case is paired with a HEALTHY control in the same repo, so a test that
 * passes by making everything unsafe would fail visibly.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {execFileSync, spawnSync} from 'child_process';
import {existsSync, mkdirSync, rmSync, writeFileSync} from 'fs';
import {join} from 'path';

import {countDivergence} from '../src/repo-status/core';
import {describeMergeShape} from '../src/repo-status/merge-shape';
import {
  buildPlan,
  executePlan,
  executeRemotePlan,
  type CleanupPlan,
} from '../src/repo-status/plan';
import {buildReport, type BranchRow} from '../src/repo-status/report';
import {createSandbox, type Sandbox} from './sandbox';

const CLI = join(import.meta.dir, '../src/repo-status/repo-status.ts');

const sandboxes: Sandbox[] = [];
function track(sb: Sandbox): Sandbox {
  sandboxes.push(sb);
  return sb;
}
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {cwd, encoding: 'utf-8', stdio: 'pipe'});
}

/** Exit status of a git command, without throwing — for the asymmetry checks. */
function gitStatus(cwd: string, args: string[]): number {
  return spawnSync('git', args, {cwd, stdio: 'ignore'}).status ?? -1;
}

function commit(repo: string, file: string, msg: string): string {
  writeFileSync(join(repo, file), `${msg}\n`);
  git(repo, ['add', file]);
  git(repo, ['commit', '-q', '-m', msg]);
  return git(repo, ['rev-parse', 'HEAD']).trim();
}

/** Delete the loose object for `sha`, so any walk THROUGH it fails. */
function destroyObject(repo: string, sha: string): void {
  const path = join(repo, '.git', 'objects', sha.slice(0, 2), sha.slice(2));
  if (!existsSync(path)) {
    throw new Error(`expected a loose object at ${path}`);
  }
  rmSync(path);
}

interface Fixture {
  repo: string;
  /** A bare repo standing in for `origin`. */
  remote: string;
}

/**
 * One repo holding both broken branches and both controls.
 *
 *   main               C0 -- M1                    the baseline
 *   corrupt-local      C0 -- [L1 destroyed] -- L2  local, unmeasurable
 *   origin/corrupt-remote
 *                      C0 -- [R1 destroyed] -- R2  remote-only, unmeasurable
 *                                                  (pushed BEFORE the damage,
 *                                                  so the remote is intact and
 *                                                  the work is real)
 *   healthy-contained  C0                          ahead 0 — provably safe
 *   healthy-ahead      C0 -- H1                    real unmerged work
 */
function buildFixture(sb: Sandbox): Fixture {
  const repo = join(sb.path, 'repo');
  const remote = join(sb.path, 'remote.git');
  mkdirSync(repo, {recursive: true});

  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  const base = commit(repo, 'README.md', 'c0');

  git(repo, ['checkout', '-q', '-b', 'corrupt-local']);
  const localMid = commit(repo, 'l1.txt', 'l1');
  commit(repo, 'l2.txt', 'l2');

  git(repo, ['checkout', '-q', '-b', 'corrupt-remote', base]);
  const remoteMid = commit(repo, 'r1.txt', 'r1');
  commit(repo, 'r2.txt', 'r2');

  execFileSync('git', ['init', '-q', '--bare', remote], {stdio: 'pipe'});
  git(repo, ['remote', 'add', 'origin', remote]);
  git(repo, ['push', '-q', 'origin', 'corrupt-remote']);
  git(repo, ['checkout', '-q', 'main']);
  // Drop the local ref so the branch is REMOTE-ONLY — the shape that
  // `apply --include-remote` would delete from the shared remote.
  git(repo, ['branch', '-q', '-D', 'corrupt-remote']);

  git(repo, ['branch', 'healthy-contained', base]);
  git(repo, ['checkout', '-q', '-b', 'healthy-ahead', base]);
  commit(repo, 'h.txt', 'h1');
  git(repo, ['checkout', '-q', 'main']);
  commit(repo, 'm.txt', 'm1');

  destroyObject(repo, localMid);
  destroyObject(repo, remoteMid);

  return {remote, repo};
}

function rowsFor(repo: string, only?: string): BranchRow[] {
  const report = buildReport({
    content: true,
    cwd: repo,
    only,
    prs: false,
    sinceDays: null,
    submodules: false,
  });
  if (report == null) throw new Error('expected a report');
  return report.branches;
}

function byName(rows: BranchRow[], name: string): BranchRow {
  const row = rows.find((r) => r.name === name);
  if (row == null) throw new Error(`no row for ${name}`);
  return row;
}

function planFor(repo: string): CleanupPlan {
  const report = buildReport({
    content: true,
    cwd: repo,
    prs: false,
    sinceDays: null,
    submodules: false,
  });
  if (report == null) throw new Error('expected a report');
  return buildPlan(report);
}

const BROKEN = ['corrupt-local', 'origin/corrupt-remote'];

// ---------------------------------------------------------------------------
// The measurement itself
// ---------------------------------------------------------------------------

describe('countDivergence reports failure as failure', () => {
  test('null when the walk fails, real counts when it does not', () => {
    const sb = track(createSandbox());
    const fx = buildFixture(sb);

    // The bug, at its source: these two are unmeasurable and must say so.
    expect(countDivergence(fx.repo, 'main', 'corrupt-local')).toBeNull();
    expect(countDivergence(fx.repo, 'main', 'origin/corrupt-remote')).toBeNull();
    // A baseline that resolves nowhere is the same class of failure.
    expect(countDivergence(fx.repo, 'no-such-baseline', 'main')).toBeNull();

    // ...while everything measurable still measures, unchanged. Without these
    // controls, "return null always" would pass every assertion above.
    expect(countDivergence(fx.repo, 'main', 'healthy-contained')).toEqual({
      ahead: 0,
      behind: 1,
    });
    expect(countDivergence(fx.repo, 'main', 'healthy-ahead')).toEqual({
      ahead: 1,
      behind: 1,
    });
  });

  test('rev-parse succeeds on exactly the refs rev-list cannot walk', () => {
    const sb = track(createSandbox());
    const fx = buildFixture(sb);

    // This asymmetry is WHY the tip-sha guards in plan.ts cannot catch this
    // class: everything they check keeps working while the count does not.
    for (const ref of BROKEN) {
      expect({
        ref,
        revList: gitStatus(fx.repo, [
          'rev-list',
          '--left-right',
          '--count',
          `main...${ref}`,
        ]),
        revParse: gitStatus(fx.repo, ['rev-parse', '--verify', '--quiet', ref]),
      }).toEqual({ref, revList: 128, revParse: 0});
    }
  });
});

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

describe('an unmeasurable branch is never proven safe', () => {
  test('it lands in review, with nulls and a why naming the failed command', () => {
    const sb = track(createSandbox());
    const fx = buildFixture(sb);
    const rows = rowsFor(fx.repo);

    for (const name of BROKEN) {
      const row = byName(rows, name);
      expect({
        ahead: row.ahead,
        behind: row.behind,
        disposition: row.disposition,
        mergeShape: row.mergeShape.kind,
        name,
        provenSafe: row.provenSafe,
      }).toEqual({
        ahead: null,
        behind: null,
        disposition: 'review',
        mergeShape: 'unknown',
        name,
        provenSafe: false,
      });
      // The why has to be actionable: which command failed, on which refs, and
      // what to do about it — not just "unknown".
      expect(row.why).toContain('git rev-list --left-right --count');
      expect(row.why).toContain(`main...${name}`);
      expect(row.why).toContain('UNKNOWN');
      expect(row.why).toContain('git fsck');
      // And the merge shape must not read as reassurance.
      expect(row.mergeShape.why).toContain('UNKNOWN');
      expect(row.mergeShape.why).not.toContain('Already up to date');
    }
  });

  test('the healthy rows in the same repo are unaffected', () => {
    const sb = track(createSandbox());
    const fx = buildFixture(sb);
    const rows = rowsFor(fx.repo);

    const contained = byName(rows, 'healthy-contained');
    expect({
      ahead: contained.ahead,
      disposition: contained.disposition,
      provenSafe: contained.provenSafe,
    }).toEqual({ahead: 0, disposition: 'merged', provenSafe: true});
    expect(contained.mergeShape.kind).toBe('already-up-to-date');

    const unmerged = byName(rows, 'healthy-ahead');
    expect({
      ahead: unmerged.ahead,
      disposition: unmerged.disposition,
      provenSafe: unmerged.provenSafe,
    }).toEqual({ahead: 1, disposition: 'needs-judgment', provenSafe: false});
  });

  test('no content proof is attached to a row whose commits are unknown', () => {
    const sb = track(createSandbox());
    const fx = buildFixture(sb);

    // The deep-dive attaches per-commit verdicts whenever a proof ran. It must
    // not run here: it would enumerate "unique commits" by walking the same
    // history the same git just failed to walk.
    const broken = byName(rowsFor(fx.repo, 'corrupt-local'), 'corrupt-local');
    expect(broken.commits).toBeUndefined();
    expect(broken.archiveMirror).toBeNull();

    // Control: the deep-dive DOES attach them for a measurable branch.
    const healthy = byName(rowsFor(fx.repo, 'healthy-ahead'), 'healthy-ahead');
    expect(healthy.commits).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The action
// ---------------------------------------------------------------------------

describe('plan and apply refuse an unmeasurable branch', () => {
  test('it is listed as needs-judgment and appears in no actionable group', () => {
    const sb = track(createSandbox());
    const fx = buildFixture(sb);
    const plan = planFor(fx.repo);

    const names = (actions: {branch: string}[]): string[] =>
      actions.map((a) => a.branch);
    for (const name of BROKEN) {
      expect(names(plan.needsJudgment)).toContain(name);
      expect(names(plan.safe)).not.toContain(name);
      expect(names(plan.remote)).not.toContain(name);
      expect(names(plan.manual)).not.toContain(name);
    }
    // The remote group is where the DESTRUCTIVE path lives, and the only
    // remote-only branch in this repo is an unmeasurable one.
    expect(plan.remote).toEqual([]);

    // Control: the plan still proposes the one thing it can actually prove.
    expect(names(plan.safe)).toEqual(['healthy-contained']);
  });

  test('executing the plan touches neither branch, locally or on the remote', () => {
    const sb = track(createSandbox());
    const fx = buildFixture(sb);
    const plan = planFor(fx.repo);

    const local = executePlan(plan, fx.repo);
    const remote = executeRemotePlan(plan, fx.repo);

    for (const name of BROKEN) {
      expect([...local, ...remote].map((r) => r.branch)).not.toContain(name);
    }
    expect(remote).toEqual([]);

    // Not just "no result mentions it" — the refs are all still there, under
    // their original names, and nothing was archived in their place.
    expect(
      gitStatus(fx.repo, ['rev-parse', '--verify', '--quiet', 'corrupt-local']),
    ).toBe(0);
    expect(
      gitStatus(fx.repo, [
        'rev-parse',
        '--verify',
        '--quiet',
        'refs/remotes/origin/corrupt-remote',
      ]),
    ).toBe(0);
    expect(
      gitStatus(fx.repo, [
        'rev-parse',
        '--verify',
        '--quiet',
        'archive/corrupt-local',
      ]),
    ).not.toBe(0);
    // The shared remote is untouched: the branch is still there and no
    // archive/* ref was pushed alongside it.
    expect(
      git(fx.remote, ['for-each-ref', '--format=%(refname)', 'refs/heads'])
        .trim()
        .split('\n'),
    ).toEqual(['refs/heads/corrupt-remote']);

    // Control: the proven-safe branch WAS archived, so `apply` is still doing
    // its job rather than passing this test by refusing everything.
    expect(local.map((r) => [r.branch, r.outcome])).toEqual([
      ['healthy-contained', 'archived'],
    ]);
    expect(
      gitStatus(fx.repo, [
        'rev-parse',
        '--verify',
        '--quiet',
        'archive/healthy-contained',
      ]),
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Rendering, through the shipped CLI
// ---------------------------------------------------------------------------

describe('the unknown state survives to the output', () => {
  test('status --json reports nulls, review, and mergeShape unknown', () => {
    const sb = track(createSandbox());
    const fx = buildFixture(sb);

    const result = spawnSync(
      'bun',
      [
        CLI,
        'status',
        '--repo',
        fx.repo,
        '--no-prs',
        '--no-submodules',
        '--json',
      ],
      {encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe']},
    );
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout ?? '') as {
      branches: BranchRow[];
      summary: {provenSafe: number; review: number};
    };

    expect(
      Object.fromEntries(
        parsed.branches.map((r) => [
          r.name,
          [r.ahead, r.behind, r.disposition, r.mergeShape.kind],
        ]),
      ),
    ).toEqual({
      'corrupt-local': [null, null, 'review', 'unknown'],
      'healthy-ahead': [1, 1, 'needs-judgment', 'merge-needed'],
      'healthy-contained': [0, 1, 'merged', 'already-up-to-date'],
      'origin/corrupt-remote': [null, null, 'review', 'unknown'],
    });
    expect(parsed.summary).toMatchObject({provenSafe: 1, review: 2});
  });
});

// ---------------------------------------------------------------------------
// The pure function, on its own
// ---------------------------------------------------------------------------

describe('describeMergeShape on a null divergence', () => {
  test('degrades to `unknown`, and says so in the terms that matter', () => {
    const shape = describeMergeShape(null, 'origin/trunk');
    expect(shape.kind).toBe('unknown');
    expect(shape.why).toContain('UNKNOWN');
    expect(shape.why).toContain('origin/trunk');
    // The specific wrong reading this exists to block: `{0, 0}` would have
    // produced `already-up-to-date`, the most reassuring value in the set.
    expect(shape.why).toContain('NOT "nothing to merge"');
    expect(shape.question).toBe(
      describeMergeShape({ahead: 1, behind: 0}, 'origin/trunk').question,
    );
  });
});
