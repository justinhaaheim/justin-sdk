/**
 * One report, one repo state — and the two facts that make it checkable.
 *
 * THE BUG THIS SUITE EXISTS FOR (home-base-qyu1.33.6, found in round 2 of the
 * blind ledger trials and confirmed from the reflog). The report resolved refs
 * lazily, once per measurement, so a commit landing mid-run split it across two
 * repo states: the header said `3 ahead / 0 behind origin/main` — computed AFTER
 * a commit landed — while all thirteen rows of the branch table were computed
 * against `main~1`. Nothing in the output could have revealed it, because the
 * baseline was named only as a REF, and refs move.
 *
 * The fix is a pin: `main` is resolved to a commit ONCE at the top of the walk,
 * every git invocation measures against that commit, and the sha is printed. The
 * test that a mid-walk commit cannot split the report is not writable from
 * outside the walk — nothing here can land a commit between two of its steps.
 * What IS writable, and is what these tests do instead, is the property that
 * makes the bug impossible AND detectable afterwards:
 *
 *   1. the report publishes the commit it measured against,
 *   2. every count in it reproduces against THAT commit, and
 *   3. measuring against the NAME gives different answers the moment the
 *      baseline moves — which is the whole reason (3) is not how any of this is
 *      measured any more.
 *
 * Assertion (3) is a permanent negative control for (1) and (2): it fails if the
 * pin ever stops being load-bearing, without anybody having to remember to
 * re-break the code by hand.
 *
 * The second half covers the fetch age, which is the other unstated
 * precondition: `0 behind origin/main` is a claim about a LOCAL ref that only a
 * fetch moves.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {execFileSync} from 'child_process';
import {writeFileSync} from 'fs';
import {join} from 'path';

import {
  buildCoreInventory,
  countDivergence,
} from '../src/plugin/lib/repo-status/core';
import {proveContentOnBaseline} from '../src/repo-status/content';
import {previewMerge} from '../src/repo-status/merge-preview';
import {renderReportPretty} from '../src/repo-status/pretty';
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
  return execFileSync('git', args, {cwd, encoding: 'utf-8', stdio: 'pipe'})
    .toString()
    .trim();
}

function commit(repo: string, file: string, body: string, msg: string): string {
  writeFileSync(join(repo, file), body);
  git(repo, ['add', '--', file]);
  git(repo, ['commit', '-q', '-m', msg]);
  return git(repo, ['rev-parse', 'HEAD']);
}

/** `main` with two commits, plus a branch that is one ahead and one behind. */
function buildFixture(sb: Sandbox): string {
  const repo = sb.path;
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  const base = commit(repo, 'shared.txt', 'original\n', 'initial');

  git(repo, ['checkout', '-q', '-b', 'feature', base]);
  commit(repo, 'feature.txt', 'work\n', 'feature work');

  git(repo, ['checkout', '-q', 'main']);
  commit(repo, 'main.txt', 'trunk\n', 'trunk work');
  return repo;
}

function report(repo: string): RepoStatusReport {
  const built = buildReport({
    content: false,
    cwd: repo,
    prs: false,
    sinceDays: null,
    submodules: false,
  });
  if (built == null) throw new Error('expected a report');
  return built;
}

/** `git rev-list --count A..B` — the check a reader would run by hand. */
function countTo(repo: string, from: string, to: string): number {
  return Number(git(repo, ['rev-list', '--count', `${from}..${to}`]));
}

describe('the baseline is pinned once, and published', () => {
  test('the report carries the commit the baseline named when it was called', () => {
    const repo = buildFixture(track(createSandbox()));
    const preCall = git(repo, ['rev-parse', 'main']);

    const built = report(repo);

    // Advance the baseline AFTER the walk. The report is a statement about the
    // repo as it was, and it has to keep being one.
    commit(repo, 'later.txt', 'later\n', 'landed after the report');
    expect(git(repo, ['rev-parse', 'main'])).not.toBe(preCall);

    expect(built.repo.baselineSha).toBe(preCall);
    expect(built.repo.baselineRef).toBe('main');
  });

  test('the pretty header prints the name AND the sha', () => {
    const repo = buildFixture(track(createSandbox()));
    const built = report(repo);

    const header = renderReportPretty(built)
      .split('\n')
      .find((l) => l.startsWith('Baseline:'));
    expect(header).toContain(
      `Baseline:  main @ ${built.repo.baselineSha.slice(0, 7)}`,
    );
    // Belt and braces: a `baselineSha` that had degraded to the ref name would
    // satisfy the line above (`'main'.slice(0, 7)` is `'main'`) while printing
    // nothing a reader could check anything against.
    expect(header).toMatch(/^Baseline: {2}main @ [0-9a-f]{7} /);
    expect(git(repo, ['rev-parse', 'main'])).toStartWith(
      built.repo.baselineSha.slice(0, 7),
    );
  });

  test('every ahead/behind in the ledger reproduces against the published sha', () => {
    const repo = buildFixture(track(createSandbox()));
    const built = report(repo);
    const pinned = built.repo.baselineSha;

    // Move the baseline before re-checking, so the audit can only be passed by
    // the sha: `main` no longer means what it meant during the walk.
    commit(repo, 'later.txt', 'later\n', 'landed after the report');

    const rows = built.branches;
    if (rows == null) throw new Error('expected branch rows');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect({
        ahead: row.ahead,
        behind: row.behind,
        name: row.name,
      }).toEqual({
        ahead: countTo(repo, pinned, row.tipSha),
        behind: countTo(repo, row.tipSha, pinned),
        name: row.name,
      });
    }
  });

  test('measuring by NAME instead of by the pin gives different answers once the baseline moves', () => {
    // The permanent negative control. If any of this stops measuring against
    // the pinned commit, the two sides of this comparison converge and the test
    // fails — which is the only way, from outside the walk, to keep proving
    // that the pin is doing work.
    const repo = buildFixture(track(createSandbox()));
    const inventory = buildCoreInventory({
      baseline: 'default',
      cwd: repo,
      sinceDays: null,
    });
    if (inventory == null) throw new Error('expected an inventory');
    const pinned = inventory.baselineSha;
    const tip = git(repo, ['rev-parse', 'feature']);

    expect(countDivergence(repo, pinned, tip)).toEqual({ahead: 1, behind: 1});

    commit(repo, 'later.txt', 'later\n', 'landed after the inventory');

    expect(countDivergence(repo, pinned, tip)).toEqual({ahead: 1, behind: 1});
    expect(countDivergence(repo, 'main', tip)).toEqual({ahead: 1, behind: 2});
    expect(countDivergence(repo, pinned, tip)).not.toEqual(
      countDivergence(repo, 'main', tip),
    );
  });

  test('a fresh walk sees the new commit — the pin is per-walk, not a cache', () => {
    const repo = buildFixture(track(createSandbox()));
    const first = report(repo).repo.baselineSha;
    commit(repo, 'later.txt', 'later\n', 'landed between the two walks');

    expect(report(repo).repo.baselineSha).toBe(
      git(repo, ['rev-parse', 'main']),
    );
    expect(report(repo).repo.baselineSha).not.toBe(first);
  });

  test('a baseline that resolves to no commit yields NO inventory', () => {
    // Rule 6 at the top of the walk: the alternative is a report that looks
    // entirely ordinary while every number in it was measured against a ref git
    // could not read.
    const repo = buildFixture(track(createSandbox()));

    expect(
      buildCoreInventory({baseline: 'no-such-ref', cwd: repo, sinceDays: null}),
    ).toBeNull();
    expect(
      buildCoreInventory({baseline: 'main', cwd: repo, sinceDays: null}),
    ).not.toBeNull();
  });
});

describe('the pinned commit is what git is actually run against', () => {
  // The tests above prove the report PUBLISHES a pin and is self-consistent
  // under it. These prove the pin reaches the argv — that each enrichment
  // measures the commit it was handed and not the name beside it — by moving
  // the baseline and showing the two answers come apart. Nothing outside
  // `buildReport` can land a commit between two of its own steps, so this is
  // the seam where the property is testable.

  test('the content proof walks the pinned commit, not the ref', () => {
    const repo = buildFixture(track(createSandbox()));
    const pinned = git(repo, ['rev-parse', 'main']);
    const tip = git(repo, ['rev-parse', 'feature']);

    // The branch's work lands on the baseline AFTER the pin was taken.
    git(repo, ['cherry-pick', tip]);
    expect(git(repo, ['rev-parse', 'main'])).not.toBe(pinned);

    expect(
      proveContentOnBaseline('feature', 'main', repo, {
        baseline: pinned,
        branch: tip,
      }).allContentOnBaseline,
    ).toBe(false);
    // Same call, measuring the NAME: the answer flips to the reassuring one.
    expect(
      proveContentOnBaseline('feature', 'main', repo).allContentOnBaseline,
    ).toBe(true);
  });

  test('the merge preview merges the pinned commit, not the ref', () => {
    const repo = buildFixture(track(createSandbox()));
    const pinned = git(repo, ['rev-parse', 'main']);
    const tip = git(repo, ['rev-parse', 'feature']);

    // A conflicting edit lands on the baseline AFTER the pin was taken.
    commit(repo, 'feature.txt', 'trunk took this path\n', 'trunk edits it too');

    expect(
      previewMerge('main', 'feature', repo, {
        pins: {baseline: pinned, branch: tip},
      }).kind,
    ).toBe('clean');
    expect(previewMerge('main', 'feature', repo).kind).toBe('conflicts');
  });

  test('the prose keeps the NAME even when the measurement is a sha', () => {
    const repo = buildFixture(track(createSandbox()));
    const pinned = git(repo, ['rev-parse', 'main']);
    const tip = git(repo, ['rev-parse', 'feature']);

    const preview = previewMerge('main', 'feature', repo, {
      pins: {baseline: pinned, branch: tip},
    });
    expect(preview.why).toContain('merges into main');
    expect(preview.why).not.toContain(pinned);
  });
});

describe('the fetch age behind every BEHIND-against-origin figure', () => {
  test('a checkout that has never fetched says so, and never says "recent"', () => {
    const repo = buildFixture(track(createSandbox()));
    const built = report(repo);

    expect(built.repo.remoteRefs).toEqual({kind: 'never'});
    const pretty = renderReportPretty(built);
    expect(pretty).toContain('Remote refs: NO fetch recorded in this checkout');
    expect(pretty).not.toContain('last fetched');
  });

  test('after a fetch, the age is the fetch, and the header prints it', () => {
    const sb = track(createSandbox());
    const repo = buildFixture(sb);
    const remote = join(sb.path, '..', `${sb.path.split('/').pop()}-remote.git`);
    git(repo, ['init', '-q', '--bare', remote]);
    git(repo, ['remote', 'add', 'origin', remote]);
    git(repo, ['push', '-q', 'origin', 'main']);
    const before = Date.now();
    git(repo, ['fetch', '-q', 'origin']);

    const built = report(repo);

    expect(built.repo.remoteRefs.kind).toBe('fetched');
    const at =
      built.repo.remoteRefs.kind === 'fetched'
        ? Date.parse(built.repo.remoteRefs.at)
        : NaN;
    // A real timestamp from the file, not a fabricated `now`: it must be at or
    // after the moment just before the fetch, and not in the future.
    expect(at).toBeGreaterThanOrEqual(before - 1000);
    expect(at).toBeLessThanOrEqual(Date.now() + 1000);
    expect(renderReportPretty(built)).toContain('Remote refs: last fetched ');

    execFileSync('rm', ['-rf', remote]);
  });
});
