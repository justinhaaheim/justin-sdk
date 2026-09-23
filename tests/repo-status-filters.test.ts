/**
 * The ledger's default filters, and the claim they are required to make.
 *
 * `status` now hides two things by default: `archive/*` mirrors, and branches
 * with no commit inside the window. Both are ergonomics — on a repo that has
 * been reconciled a few times they are most of the rows — and both are the
 * exact shape rule 6 exists to catch, because they make the answer SHORTER
 * without making anything in it false. A reader who asks "what branches are
 * open?" and is handed eight rows has been told there are eight.
 *
 * So the property under test is never just "the row is gone". It is that the
 * report says how many rows are gone and why, that the counts are NULL rather
 * than 0 when there was no branch set to filter in the first place, and that a
 * branch someone actually has checked out is never hidden at all.
 *
 * The last test here is the one that would catch the tempting wrong
 * implementation: filtering `archive/*` out of the LEDGER must not remove it as
 * EVIDENCE. A branch whose work is preserved in a hidden mirror still has to
 * come back `mirrored`, because the mirror lookup resolves a ref by name and
 * never reads the branch list.
 *
 * Part of home-base-qyu1.33.1.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {execFileSync} from 'child_process';
import {chmodSync, existsSync, rmSync, writeFileSync} from 'fs';
import {join} from 'path';

import {renderReportPretty} from '../src/repo-status/pretty';
import {
  buildReport,
  measureHiddenUnmerged,
  type RepoStatusReport,
} from '../src/repo-status/report';
import {createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
function track(sb: Sandbox): Sandbox {
  sandboxes.push(sb);
  return sb;
}
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

function git(
  cwd: string,
  args: string[],
  env?: Record<string, string>,
): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: env != null ? {...process.env, ...env} : process.env,
    stdio: 'pipe',
  }).trim();
}

/** An ISO date `days` in the past, in the form git accepts for a commit date. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function commit(
  repo: string,
  file: string,
  msg: string,
  when?: string,
): string {
  writeFileSync(join(repo, file), `${msg}\n`);
  git(repo, ['add', file]);
  git(
    repo,
    ['commit', '-q', '-m', msg],
    when != null
      ? {GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when}
      : undefined,
  );
  return git(repo, ['rev-parse', 'HEAD']);
}

function branchFrom(repo: string, base: string, name: string): void {
  git(repo, ['checkout', '-q', '-b', name, base]);
}

/**
 * One repo holding every case the filters have to distinguish.
 *
 *   recent-work            fresh, plain          -> always shown
 *   old-work               200 days old          -> hidden by the window
 *   archive/finished       fresh, archive/*      -> hidden by the archive rule
 *   origin/archive/remote  a remote-tracking archive ref, which does NOT begin
 *                          with `archive/` in its qualified form
 *   stale-worktree         200 days old AND checked out -> never hidden
 */
function buildFixture(sb: Sandbox): string {
  const repo = sb.path;
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  const base = commit(repo, 'README.md', 'initial');

  branchFrom(repo, base, 'recent-work');
  commit(repo, 'recent.txt', 'recent work');

  branchFrom(repo, base, 'old-work');
  commit(repo, 'old.txt', 'old work', daysAgo(200));

  branchFrom(repo, base, 'archive/finished');
  commit(repo, 'archived.txt', 'archived work');

  branchFrom(repo, base, 'stale-worktree');
  commit(repo, 'stale.txt', 'stale but checked out', daysAgo(200));

  // A remote-tracking archive ref. Its qualified name is
  // `origin/archive/remote-finished`, which does NOT start with `archive/` —
  // the exact case a naive prefix test on the full name would miss.
  branchFrom(repo, base, 'tmp-remote');
  const remoteTip = commit(repo, 'remote.txt', 'remote archived work');
  git(repo, [
    'update-ref',
    'refs/remotes/origin/archive/remote-finished',
    remoteTip,
  ]);
  git(repo, ['checkout', '-q', 'main']);
  git(repo, ['branch', '-q', '-D', 'tmp-remote']);

  // `stale-worktree` must be CHECKED OUT for the exemption to apply.
  git(repo, ['worktree', 'add', '-q', join(sb.path, 'wt'), 'stale-worktree']);

  return repo;
}

function names(report: RepoStatusReport): string[] {
  return (report.branches ?? []).map((b) => b.name).sort();
}

/** The default `status` shape, without the enrichments these tests do not use. */
function filteredReport(
  repo: string,
  over: Partial<Parameters<typeof buildReport>[0]> = {},
): RepoStatusReport {
  const report = buildReport({
    content: false,
    cwd: repo,
    excludeArchive: true,
    mergePreview: false,
    overlaps: false,
    prs: false,
    sinceDays: 90,
    submodules: false,
    ...over,
  });
  if (report == null) throw new Error('expected a report');
  return report;
}

describe('repo-status default filters', () => {
  test('hides archive mirrors and branches outside the window', () => {
    const repo = buildFixture(track(createSandbox()));
    const report = filteredReport(repo);

    expect(names(report)).toEqual(['recent-work', 'stale-worktree']);
    expect(names(report)).not.toContain('archive/finished');
    expect(names(report)).not.toContain('old-work');
  });

  test('a remote-tracking archive ref is filtered on its BARE name', () => {
    const repo = buildFixture(track(createSandbox()));

    // Present when nothing is filtered, so the assertion below is about the
    // filter and not about the fixture failing to create the ref.
    const all = filteredReport(repo, {excludeArchive: false, sinceDays: null});
    expect(names(all)).toContain('origin/archive/remote-finished');

    expect(names(filteredReport(repo))).not.toContain(
      'origin/archive/remote-finished',
    );
  });

  test('reports how many rows each filter removed', () => {
    const repo = buildFixture(track(createSandbox()));
    const {filtered} = filteredReport(repo);

    expect(filtered.excludeArchive).toBe(true);
    expect(filtered.sinceDays).toBe(90);
    // `archive/finished` and `origin/archive/remote-finished`.
    expect(filtered.excludedAsArchive).toBe(2);
    // `old-work` only — `stale-worktree` is exempt.
    expect(filtered.excludedAsStale).toBe(1);
    expect(filtered.keptForWorktree).toBe(1);
  });

  test('every count is present, and zero, when nothing was filtered out', () => {
    const repo = buildFixture(track(createSandbox()));
    const {filtered} = filteredReport(repo, {
      excludeArchive: false,
      sinceDays: null,
    });

    // Zero is a MEASUREMENT here — "the gate ran and dropped nothing" — which
    // is why these keys are present rather than omitted on the happy path.
    expect(filtered.excludedAsArchive).toBe(0);
    expect(filtered.excludedAsStale).toBe(0);
    expect(filtered.sinceDays).toBeNull();
    expect(filtered.excludeArchive).toBe(false);
  });

  test('a checked-out branch is never hidden, however old', () => {
    const repo = buildFixture(track(createSandbox()));
    // A one-day window: everything but the newest commit is outside it.
    const report = filteredReport(repo, {sinceDays: 1});

    expect(names(report)).toContain('stale-worktree');
    expect(report.filtered.keptForWorktree).toBeGreaterThan(0);
  });

  test('the counts are NULL, not 0, when the branch listing failed', () => {
    const sb = track(createSandbox());
    const repo = buildFixture(sb);

    // Destroy the object behind a ref tip. `for-each-ref` has to parse every
    // tip's committer date, so one unreadable object fails the listing for the
    // whole repo — and then there is no branch set that could have been
    // filtered, so "0 excluded" would be a measurement that never ran.
    const tip = git(repo, ['rev-parse', 'recent-work']);
    const objectPath = join(
      repo,
      '.git',
      'objects',
      tip.slice(0, 2),
      tip.slice(2),
    );
    if (existsSync(objectPath)) {
      chmodSync(join(repo, '.git', 'objects', tip.slice(0, 2)), 0o755);
      rmSync(objectPath);
    }

    const report = filteredReport(repo);
    expect(report.branches).toBeNull();
    expect(report.filtered.excludedAsArchive).toBeNull();
    expect(report.filtered.excludedAsStale).toBeNull();
    expect(report.filtered.keptForWorktree).toBeNull();
    // Same rule one level down: there was no hidden SET to walk, so "0 hidden
    // branches carry unmerged work" would be a measurement that never ran.
    expect(report.filtered.hiddenUnmerged).toBeNull();
    // The window itself is still a fact about what was ASKED for, so it stays.
    expect(report.filtered.sinceDays).toBe(90);
  });

  test('a hidden archive mirror still proves its branch is preserved', () => {
    const sb = track(createSandbox());
    const repo = sb.path;
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'Test']);
    const base = commit(repo, 'README.md', 'initial');

    branchFrom(repo, base, 'feature');
    const tip = commit(repo, 'feature.txt', 'unmerged feature work');
    git(repo, ['checkout', '-q', 'main']);
    // An EXACT mirror of `feature`, which the ledger will not show.
    git(repo, ['update-ref', 'refs/heads/archive/feature', tip]);

    const report = filteredReport(repo, {content: true});

    expect(names(report)).not.toContain('archive/feature');
    const feature = (report.branches ?? []).find((b) => b.name === 'feature');
    expect(feature?.disposition).toBe('mirrored');
    expect(feature?.archiveMirror?.ref).toBe('archive/feature');
  });
});

// ---------------------------------------------------------------------------
// What the hidden set holds (home-base-qyu1.33.9, epic decision D4)
// ---------------------------------------------------------------------------

/** A 40-hex name for no object at all: `git cherry` fails on it. */
const NO_SUCH_COMMIT = '0123456789abcdef0123456789abcdef01234567';

/**
 * A repo whose two HIDDEN branches differ in what they actually hold.
 *
 *   shown-work        fresh, unique work        -> the one SHOWN unmerged row
 *   archive/finished  hidden as an archive/*    -> carries work, or not, per flag
 *   stale-landed      hidden by the age window  -> its patch is already on main
 *
 * `stale-landed` is the case that makes the measurement worth making: it HAS a
 * commit of its own by sha, so any count based on `ahead` would call it unmerged
 * work, and the identical patch is sitting on main under a different sha. Only
 * the patch-id walk can tell the two hidden branches apart.
 */
function buildHiddenSetFixture(
  sb: Sandbox,
  opts: {archiveCarriesWork: boolean},
): string {
  const repo = sb.path;
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  const base = commit(repo, 'README.md', 'initial');

  branchFrom(repo, base, 'shown-work');
  commit(repo, 'shown.txt', 'work in flight');

  branchFrom(repo, base, 'stale-landed');
  const landed = commit(repo, 'landed.txt', 'landed long ago', daysAgo(200));

  branchFrom(repo, base, 'archive/finished');
  const archived = commit(repo, 'archived.txt', 'archived work');

  git(repo, ['checkout', '-q', 'main']);
  // The landed halves are replayed onto main, so their patch-ids match there
  // under a DIFFERENT sha — which is exactly what `git cherry` sees through.
  git(repo, ['cherry-pick', landed]);
  if (!opts.archiveCarriesWork) git(repo, ['cherry-pick', archived]);
  return repo;
}

describe('what the hidden set holds', () => {
  test('counts the hidden branches carrying commits the baseline lacks', () => {
    const repo = buildHiddenSetFixture(track(createSandbox()), {
      archiveCarriesWork: true,
    });
    const report = filteredReport(repo);

    // Two branches hidden, by two different rules.
    expect(report.filtered.excludedAsArchive).toBe(1);
    expect(report.filtered.excludedAsStale).toBe(1);
    // One of them holds work the baseline lacks; the other's patch is on main.
    expect(report.filtered.hiddenUnmerged).toEqual({
      branchesWithUnmergedCommits: 1,
      unmeasured: 0,
    });

    const out = renderReportPretty(report);
    // THE HEADLINE, which is the whole point: the ledger shows one unmerged
    // branch and there is another one it is not showing.
    expect(out).toContain('UNMERGED WORK (1 shown, 1 more hidden)');
    expect(out).toContain(
      '1 of the 2 hidden branches carries commits not on main',
    );
    // The disclaimer it replaces must be gone: a measurement happened.
    expect(out).not.toContain('these were not inspected');
  });

  test('every hidden branch already landed reads as a measured NONE', () => {
    const repo = buildHiddenSetFixture(track(createSandbox()), {
      archiveCarriesWork: false,
    });
    const report = filteredReport(repo);

    expect(report.filtered.hiddenUnmerged).toEqual({
      branchesWithUnmergedCommits: 0,
      unmeasured: 0,
    });

    const out = renderReportPretty(report);
    expect(out).toContain(
      'none of the 2 hidden branches carries a commit not on main',
    );
    // Nothing is hidden that carries work, so the heading is a plain count.
    expect(out).toContain('UNMERGED WORK (1)');
    expect(out).not.toContain('more hidden');
  });

  test('a hidden tip whose cherry FAILS is unmeasured, never a clean zero', () => {
    const repo = buildHiddenSetFixture(track(createSandbox()), {
      archiveCarriesWork: true,
    });
    const report = filteredReport(repo);

    // One real tip, one that names no object — the shape of a tip whose commit
    // has been gc'd or corrupted out from under the walk.
    const measured = measureHiddenUnmerged(
      [
        {
          name: 'archive/finished',
          reason: 'archive',
          tipSha: git(repo, ['rev-parse', 'archive/finished']),
        },
        {name: 'stale-landed', reason: 'stale', tipSha: NO_SUCH_COMMIT},
      ],
      report.repo.baselineSha,
      repo,
    );
    expect(measured).toEqual({
      branchesWithUnmergedCommits: 1,
      unmeasured: 1,
    });

    const out = renderReportPretty({
      ...report,
      filtered: {...report.filtered, hiddenUnmerged: measured},
    });
    expect(out).toContain(
      '1 of the 2 hidden branches COULD NOT BE CHECKED — whether it carries commits not on main is UNKNOWN',
    );
    expect(out).toContain(
      '1 of the 2 hidden branches carries commits not on main',
    );
  });

  test('when NO hidden tip could be checked, nothing reassuring is printed', () => {
    const repo = buildHiddenSetFixture(track(createSandbox()), {
      archiveCarriesWork: true,
    });
    const report = filteredReport(repo);

    const measured = measureHiddenUnmerged(
      [
        {name: 'archive/finished', reason: 'archive', tipSha: NO_SUCH_COMMIT},
        {name: 'stale-landed', reason: 'stale', tipSha: `${'f'.repeat(40)}`},
      ],
      report.repo.baselineSha,
      repo,
    );
    expect(measured).toEqual({
      branchesWithUnmergedCommits: 0,
      unmeasured: 2,
    });

    const out = renderReportPretty({
      ...report,
      filtered: {...report.filtered, hiddenUnmerged: measured},
    });
    expect(out).toContain('2 of the 2 hidden branches COULD NOT BE CHECKED');
    // Zero branches were found to carry work ONLY because zero were looked at.
    // No sentence in the output may spend that as a "none".
    expect(out).not.toContain('none of the');
    expect(out).not.toContain('more hidden');
  });
});
