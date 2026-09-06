/**
 * Which open branches are in each other's way — and the bookkeeping that keeps
 * "none" honest.
 *
 * The cheap half (file-set intersection) and the expensive half (a pairwise
 * merge) are deliberately separated, so the expensive one runs on a small
 * minority of pairs and can be capped. Everything a cap skips is a pair whose
 * outcome is UNKNOWN, so the tests below assert on the counts as hard as on the
 * pairs: an implementation that quietly checked fewer pairs, or that reported a
 * skipped pair as clean, has to fail here.
 *
 * The unmeasured case matters for the same reason it does everywhere else in
 * this tool. A branch whose `git diff` fails has an unknown footprint;
 * substituting an empty file set would make it intersect nothing, so it would
 * appear in no pair and read as "collides with nothing" — the reassuring
 * direction. It is named instead.
 *
 * Part of home-base-qyu1.33.3.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {execFileSync} from 'child_process';
import {writeFileSync} from 'fs';
import {join} from 'path';

import {
  buildOverlaps,
  readChangedFiles,
  type OverlapCandidate,
} from '../src/repo-status/overlap';
import {buildReport, type RepoStatusReport} from '../src/repo-status/report';
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
  return execFileSync('git', args, {cwd, encoding: 'utf-8', stdio: 'pipe'}).trim();
}

function commit(repo: string, file: string, body: string, msg: string): string {
  writeFileSync(join(repo, file), body);
  git(repo, ['add', '--', file]);
  git(repo, ['commit', '-q', '-m', msg]);
  return git(repo, ['rev-parse', 'HEAD']);
}

/**
 * Three branches off one base:
 *
 *   alpha   rewrites shared.txt line 1   -> collides with beta
 *   beta    rewrites shared.txt line 1   -> collides with alpha
 *   gamma   touches only its own file    -> collides with nobody
 */
function buildFixture(sb: Sandbox): string {
  const repo = sb.path;
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  const base = commit(repo, 'shared.txt', 'original\n', 'initial');

  git(repo, ['checkout', '-q', '-b', 'alpha', base]);
  commit(repo, 'shared.txt', 'alpha version\n', 'alpha edits shared');

  git(repo, ['checkout', '-q', '-b', 'beta', base]);
  commit(repo, 'shared.txt', 'beta version\n', 'beta edits shared');

  git(repo, ['checkout', '-q', '-b', 'gamma', base]);
  commit(repo, 'gamma.txt', 'gamma\n', 'gamma edits its own file');

  git(repo, ['checkout', '-q', 'main']);
  return repo;
}

function reportFor(
  repo: string,
  over: Partial<Parameters<typeof buildReport>[0]> = {},
): RepoStatusReport {
  const report = buildReport({
    content: false,
    cwd: repo,
    mergePreview: false,
    prs: false,
    sinceDays: null,
    submodules: false,
    ...over,
  });
  if (report == null) throw new Error('expected a report');
  return report;
}

describe('cross-branch overlap', () => {
  test('pairs sharing a file are reported, and pairs that do not are not', () => {
    const repo = buildFixture(track(createSandbox()));
    const {overlaps} = reportFor(repo);

    expect(overlaps.candidates).toBe(3);
    expect(overlaps.pairsConsidered).toBe(3);
    expect(overlaps.pairsWithSharedFiles).toBe(1);

    const pair = overlaps.pairs?.[0];
    expect([pair?.a, pair?.b].sort()).toEqual(['alpha', 'beta']);
    expect(pair?.sharedFiles).toEqual(['shared.txt']);
    expect(pair?.sharedFileCount).toBe(1);
  });

  test('an intersecting pair is merge-checked against the other branch', () => {
    const repo = buildFixture(track(createSandbox()));
    const {overlaps} = reportFor(repo);

    expect(overlaps.pairsConflictChecked).toBe(1);
    expect(overlaps.pairs?.[0]?.conflict?.kind).toBe('conflicts');
    expect(overlaps.pairs?.[0]?.conflict?.conflictedFiles).toEqual([
      'shared.txt',
    ]);
  });

  test('every row with unique work carries its changed-file count', () => {
    const repo = buildFixture(track(createSandbox()));
    const rows = reportFor(repo).branches ?? [];

    expect(rows.find((r) => r.name === 'gamma')?.changedFileCount).toBe(1);
    // The LIST is deep-dive detail and must stay out of the ledger.
    expect(rows.find((r) => r.name === 'gamma')?.changedFiles).toBeUndefined();
  });

  test('the `branch` deep-dive is where the full changed-file list lives', () => {
    const repo = buildFixture(track(createSandbox()));
    const report = reportFor(repo, {only: 'gamma'});

    expect(report.branches?.[0]?.changedFiles).toEqual(['gamma.txt']);
  });

  test('the cap leaves pairs UNCHECKED, and says how many', () => {
    const repo = buildFixture(track(createSandbox()));
    // A cap of zero: every intersecting pair is skipped, and none of them may
    // come back looking like a merge somebody performed.
    const {overlaps} = reportFor(repo, {pairCap: 0});

    expect(overlaps.pairsWithSharedFiles).toBe(1);
    expect(overlaps.pairsConflictChecked).toBe(0);
    expect(overlaps.pairsSkippedByCap).toBe(1);
    expect(overlaps.pairs?.[0]?.conflict).toBeNull();
    expect(overlaps.why).toContain('unknown, not clean');
  });

  test('"none share a file" is stated as a comparison that ran', () => {
    const sb = track(createSandbox());
    const repo = sb.path;
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'Test']);
    const base = commit(repo, 'README.md', 'x\n', 'initial');
    git(repo, ['checkout', '-q', '-b', 'one', base]);
    commit(repo, 'one.txt', '1\n', 'one');
    git(repo, ['checkout', '-q', '-b', 'two', base]);
    commit(repo, 'two.txt', '2\n', 'two');
    git(repo, ['checkout', '-q', 'main']);

    const {overlaps} = reportFor(repo);
    expect(overlaps.pairs).toEqual([]);
    expect(overlaps.pairsConsidered).toBe(1);
    expect(overlaps.why).toContain('compared all 1 pair');
  });

  test('an unreadable diff is NULL, never an empty change set', () => {
    const repo = buildFixture(track(createSandbox()));
    const changed = readChangedFiles('main', 'no-such-branch', repo);

    expect(changed.files).toBeNull();
    expect(changed.count).toBeNull();
    expect(changed.command).toContain('diff');
  });

  test('a branch with an unreadable diff is NAMED, not silently paired away', () => {
    const repo = buildFixture(track(createSandbox()));
    const candidates: OverlapCandidate[] = [
      {
        changed: readChangedFiles('main', 'alpha', repo),
        lastCommitDate: '2026-09-01T00:00:00Z',
        name: 'alpha',
      },
      {
        changed: readChangedFiles('main', 'no-such-branch', repo),
        lastCommitDate: '2026-09-01T00:00:00Z',
        name: 'broken',
      },
    ];
    const overlaps = buildOverlaps(candidates, {cwd: repo});

    expect(overlaps.unmeasuredBranches).toEqual(['broken']);
    expect(overlaps.candidates).toBe(1);
    // It is in no pair, so the report has to say why rather than let its
    // absence read as "collides with nothing".
    expect(overlaps.pairs).toEqual([]);
    expect(overlaps.why).toContain('nothing here rules out a collision');
  });

  test('switching the enrichment off reports null counts, not zeros', () => {
    const repo = buildFixture(track(createSandbox()));
    const {overlaps} = reportFor(repo, {overlaps: false});

    expect(overlaps.pairs).toBeNull();
    expect(overlaps.candidates).toBeNull();
    expect(overlaps.pairsConsidered).toBeNull();
  });
});
