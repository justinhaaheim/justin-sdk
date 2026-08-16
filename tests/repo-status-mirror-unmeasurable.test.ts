/**
 * An UNMEASURABLE archive mirror must never read as a complete one
 * (home-base-qyu1.22).
 *
 * `countAhead` answered 0 whenever its `rev-list` failed. Zero is the most
 * reassuring number in `content.ts`: it makes `commitsMissingFromMirror` zero,
 * which makes `mirrorFullyPreserves` true, which makes the disposition
 * `mirrored` with `provenSafe: true`, which makes `buildPlan` emit
 * `delete-local-branch` — the one action on the local path that DESTROYS a ref
 * instead of renaming it. `executePlan` re-proves before deleting, but the
 * re-proof called the same fabricating function, so it re-confirmed the lie.
 *
 * ── Two damaged-object states, and why they reach different depths ───────────
 *
 * The bug was filed believing the full chain needed a transient failure (a
 * lock, EAGAIN, SIGPIPE) with no deterministic repo state behind it. Two
 * ordinary damaged-object states reach it with real git, at different depths:
 *
 * 1. STALE REMOTE (`buildFixture`) — the mirror is fresh against the LOCAL
 *    branch, but the branch's remote counterpart has moved ahead of it and one
 *    of those extra commits is missing locally. The `origin/x` side of the
 *    comparison fails while the local side answers 0. Every ref TIP is intact,
 *    so the inventory builds normally and this reaches the ENTIRE chain:
 *    report -> disposition -> plan -> apply. It is also the module's motivating
 *    122-commit staleness trap, with the count that would have caught it
 *    fabricated into "nothing missing".
 *
 * 2. BROKEN MIRROR (`buildBrokenMirrorRepo`) — the mirror ref resolves but its
 *    tip OBJECT is gone. `git rev-parse --verify --quiet` reads the ref file
 *    and never opens the object, so `refExists` says the mirror is there while
 *    every `rev-list` naming it fails with "Invalid revision range". This is
 *    the maximally dangerous shape — the mirror preserves NOTHING — but it
 *    cannot reach `buildReport`, because `for-each-ref --format=%(committerdate
 *    :iso-strict)` must parse each tip and fails for the whole repo, leaving an
 *    empty inventory (asserted below: fail-closed). It DOES reach `executePlan`,
 *    which re-proves without any `for-each-ref` — and that is the code path
 *    that deletes, so it is the one that matters most.
 *
 * The shape of the damage matters, and the fixtures pin it: a missing object on
 * the UNINTERESTING side of `A..B` does NOT fail — git returns a wrong,
 * INFLATED count (exit 0), which degrades toward `review` and is therefore
 * safe. Only damage the walk must parse produces the failure this file is
 * about.
 *
 * Every broken case is paired with a HEALTHY control in the same repo, and the
 * control is the one that gets DELETED — so a fix that passed by refusing
 * everything would fail visibly.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {execFileSync, spawnSync} from 'child_process';
import {existsSync, mkdirSync, rmSync, writeFileSync} from 'fs';
import {join} from 'path';

import {countAhead, inspectArchiveMirror} from '../src/repo-status/content';
import {buildPlan, executePlan, type CleanupPlan} from '../src/repo-status/plan';
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

/** Delete the loose object for `sha`, so any walk that must parse it fails. */
function destroyObject(repo: string, sha: string): void {
  const path = join(repo, '.git', 'objects', sha.slice(0, 2), sha.slice(2));
  if (!existsSync(path)) {
    throw new Error(`expected a loose object at ${path}`);
  }
  rmSync(path);
}

function initRepo(sb: Sandbox, name: string): string {
  const repo = join(sb.path, name);
  mkdirSync(repo, {recursive: true});
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  return repo;
}

/**
 * The shape that reaches the whole chain. Every ref TIP is present, so the
 * inventory builds; only an ancestor of the remote counterpart is missing.
 *
 *   main                     C0 -- M1                      the baseline
 *   stale-remote             C0 -- S1                      real unmerged work
 *   archive/stale-remote     C0 -- S1                      fresh against the LOCAL ref
 *   origin/stale-remote      C0 -- S1 -- [R1 DESTROYED] -- R2
 *                                                          remote 2 ahead of the mirror
 *   healthy-mirrored         C0 -- H1                      CONTROL: really mirrored
 *   archive/healthy-mirrored C0 -- H1 -- H2                mirror ahead: a superset
 *   healthy-ahead            C0 -- U1                      CONTROL: no mirror at all
 */
function buildFixture(sb: Sandbox): {repo: string} {
  const repo = initRepo(sb, 'repo');
  const remote = join(sb.path, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', remote], {stdio: 'pipe'});

  const base = commit(repo, 'README.md', 'c0');

  git(repo, ['checkout', '-q', '-b', 'stale-remote', base]);
  commit(repo, 's1.txt', 's1');
  git(repo, ['branch', 'archive/stale-remote', 'stale-remote']);
  // A throwaway ref carries the remote past the mirror, then goes away — so the
  // extra commits live ONLY on origin/stale-remote, exactly as they would after
  // someone else pushed to the branch.
  git(repo, ['checkout', '-q', '-b', 'push-src', 'stale-remote']);
  const remoteMid = commit(repo, 'r1.txt', 'r1');
  commit(repo, 'r2.txt', 'r2');
  git(repo, ['remote', 'add', 'origin', remote]);
  git(repo, ['push', '-q', 'origin', 'push-src:stale-remote']);
  git(repo, ['fetch', '-q', 'origin']);

  git(repo, ['checkout', '-q', '-b', 'healthy-mirrored', base]);
  commit(repo, 'h1.txt', 'h1');
  git(repo, ['checkout', '-q', '-b', 'archive/healthy-mirrored']);
  commit(repo, 'h2.txt', 'h2');

  git(repo, ['checkout', '-q', '-b', 'healthy-ahead', base]);
  commit(repo, 'u1.txt', 'u1');

  git(repo, ['checkout', '-q', 'main']);
  git(repo, ['branch', '-q', '-D', 'push-src']);
  commit(repo, 'm.txt', 'm1');

  destroyObject(repo, remoteMid);

  return {repo};
}

/**
 * The shape whose mirror ref resolves to a MISSING object. Returned undamaged,
 * with the sha to destroy, because the damage has to happen at different points
 * in different tests — after the plan is built, in the case that matters.
 *
 *   main                C0 -- M1
 *   will-break          C0 -- W1
 *   archive/will-break  C0 -- W1 -- W2   <- W2 is the object to destroy
 */
function buildBrokenMirrorRepo(sb: Sandbox): {repo: string; mirrorTip: string} {
  const repo = initRepo(sb, 'broken');
  const base = commit(repo, 'README.md', 'c0');
  git(repo, ['checkout', '-q', '-b', 'will-break', base]);
  commit(repo, 'w1.txt', 'w1');
  git(repo, ['checkout', '-q', '-b', 'archive/will-break']);
  const mirrorTip = commit(repo, 'w2.txt', 'w2');
  git(repo, ['checkout', '-q', 'main']);
  commit(repo, 'm.txt', 'm1');
  return {mirrorTip, repo};
}

function rowsFor(repo: string): BranchRow[] {
  const report = buildReport({
    content: true,
    cwd: repo,
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

function deletesIn(plan: CleanupPlan): string[] {
  return plan.safe
    .filter((a) => a.action === 'delete-local-branch')
    .map((a) => a.branch);
}

// ---------------------------------------------------------------------------
// The measurement itself
// ---------------------------------------------------------------------------

describe('countAhead reports failure as failure', () => {
  test('null when the walk fails, real counts when it does not', () => {
    const sb = track(createSandbox());
    const fx = buildFixture(sb);
    const broken = buildBrokenMirrorRepo(sb);
    destroyObject(broken.repo, broken.mirrorTip);

    // The bug at its source: the remote side of the stale-remote shape, and
    // both directions across a mirror whose object is gone.
    expect(
      countAhead('origin/stale-remote', 'archive/stale-remote', fx.repo),
    ).toBeNull();
    expect(
      countAhead('will-break', 'archive/will-break', broken.repo),
    ).toBeNull();
    expect(
      countAhead('archive/will-break', 'will-break', broken.repo),
    ).toBeNull();
    // A ref that resolves nowhere is the same class of failure.
    expect(countAhead('no-such-ref', 'main', fx.repo)).toBeNull();

    // ...while everything measurable still measures. Without these controls,
    // "return null always" would satisfy every assertion above.
    expect(countAhead('stale-remote', 'archive/stale-remote', fx.repo)).toBe(0);
    expect(
      countAhead('archive/healthy-mirrored', 'healthy-mirrored', fx.repo),
    ).toBe(1);
    expect(countAhead('healthy-ahead', 'main', fx.repo)).toBe(1);
  });

  test('a mirror ref resolves even when rev-list cannot walk it', () => {
    const sb = track(createSandbox());
    const broken = buildBrokenMirrorRepo(sb);
    destroyObject(broken.repo, broken.mirrorTip);

    // This asymmetry is WHY `refExists` cannot catch this class: a ref resolves
    // from the ref file, and git never opens the object to answer it.
    expect({
      revList: gitStatus(broken.repo, [
        'rev-list',
        '--count',
        'archive/will-break..will-break',
      ]),
      revParse: gitStatus(broken.repo, [
        'rev-parse',
        '--verify',
        '--quiet',
        'archive/will-break',
      ]),
    }).toEqual({revList: 128, revParse: 0});

    // It cannot reach `buildReport` though: listing tips reads every tip's
    // committer date, which fails for the whole repo. That is fail-CLOSED — an
    // empty inventory proposes nothing — and it is why this shape lives in its
    // own repo rather than alongside the rows above.
    expect(rowsFor(broken.repo)).toEqual([]);
  });

  test('inspectArchiveMirror says UNKNOWN, naming the ref it could not measure', () => {
    const sb = track(createSandbox());
    const fx = buildFixture(sb);

    // The remote counterpart is the ref that could not be measured here, and
    // naming the LOCAL branch instead would send a reader to a working command.
    const stale = inspectArchiveMirror('stale-remote', fx.repo);
    expect({
      exists: stale?.exists,
      isExact: stale?.isExact,
      missing: stale?.commitsMissingFromMirror,
      unmeasuredAgainst: stale?.unmeasuredAgainst,
    }).toEqual({
      exists: true,
      isExact: false,
      missing: null,
      unmeasuredAgainst: 'origin/stale-remote',
    });

    // Control: a measurable mirror still reports a number, and a mirror that is
    // AHEAD of its branch still counts as preserving it.
    const healthy = inspectArchiveMirror('healthy-mirrored', fx.repo);
    expect({
      missing: healthy?.commitsMissingFromMirror,
      unmeasuredAgainst: healthy?.unmeasuredAgainst,
    }).toEqual({missing: 0, unmeasuredAgainst: null});
  });
});

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

describe('an unmeasurable mirror is never `mirrored`', () => {
  test('it lands in review, with a why naming the failed command', () => {
    const sb = track(createSandbox());
    const fx = buildFixture(sb);
    const row = byName(rowsFor(fx.repo), 'stale-remote');

    expect({
      disposition: row.disposition,
      missing: row.archiveMirror?.commitsMissingFromMirror,
      provenSafe: row.provenSafe,
    }).toEqual({disposition: 'review', missing: null, provenSafe: false});

    // Actionable, not just "unknown": which command failed, on which refs. The
    // ref named is the REMOTE counterpart — the one that failed — not the local
    // ref that answered fine.
    expect(row.why).toContain(
      'git rev-list --count archive/stale-remote..origin/stale-remote',
    );
    expect(row.why).toContain('UNKNOWN');
    expect(row.why).toContain('git fsck');
    // The exact wrong readings this rule exists to block.
    expect(row.why).not.toContain('every commit is preserved');
    expect(row.why).not.toContain('is STALE');
  });

  test('the healthy rows in the same repo still reach their verdicts', () => {
    const sb = track(createSandbox());
    const fx = buildFixture(sb);
    const rows = rowsFor(fx.repo);

    const mirrored = byName(rows, 'healthy-mirrored');
    expect({
      disposition: mirrored.disposition,
      missing: mirrored.archiveMirror?.commitsMissingFromMirror,
      provenSafe: mirrored.provenSafe,
    }).toEqual({disposition: 'mirrored', missing: 0, provenSafe: true});

    const unmerged = byName(rows, 'healthy-ahead');
    expect({
      disposition: unmerged.disposition,
      provenSafe: unmerged.provenSafe,
    }).toEqual({disposition: 'needs-judgment', provenSafe: false});
  });
});

// ---------------------------------------------------------------------------
// The action
// ---------------------------------------------------------------------------

describe('plan and apply refuse an unmeasurable mirror', () => {
  test('no delete is proposed for it, while the proven one still is', () => {
    const sb = track(createSandbox());
    const fx = buildFixture(sb);
    const plan = planFor(fx.repo);

    const names = (actions: {branch: string}[]): string[] =>
      actions.map((a) => a.branch);
    expect(names(plan.needsJudgment)).toContain('stale-remote');
    expect(names(plan.safe)).not.toContain('stale-remote');
    expect(names(plan.remote)).not.toContain('stale-remote');

    // The only deletion in the plan is the one backed by a mirror that was
    // actually compared. Stated as the full list, so a new delete appearing
    // here has to be looked at.
    expect(deletesIn(plan)).toEqual(['healthy-mirrored']);
  });

  test('applying it deletes the proven branch and leaves the other intact', () => {
    const sb = track(createSandbox());
    const fx = buildFixture(sb);
    const plan = planFor(fx.repo);

    const results = executePlan(plan, fx.repo);

    expect(
      results.filter((r) => r.outcome === 'deleted').map((r) => r.branch),
    ).toEqual(['healthy-mirrored']);
    expect(
      gitStatus(fx.repo, [
        'rev-parse',
        '--verify',
        '--quiet',
        'healthy-mirrored',
      ]),
    ).not.toBe(0);

    // The unmeasurable branch is still there, under its original name.
    expect(results.map((r) => r.branch)).not.toContain('stale-remote');
    expect(
      gitStatus(fx.repo, ['rev-parse', '--verify', '--quiet', 'stale-remote']),
    ).toBe(0);
  });

  test('the re-proof REFUSES when the mirror breaks after the plan was built', () => {
    const sb = track(createSandbox());
    const broken = buildBrokenMirrorRepo(sb);

    // Built while the mirror was intact, so it really does carry the delete.
    const plan = planFor(broken.repo);
    expect(deletesIn(plan)).toEqual(['will-break']);

    // ...and THEN the repo changes under it. This is the exact scenario the
    // re-proof exists for, and the case where it used to re-confirm the
    // fabrication instead of catching it: same broken measurement, same 0.
    destroyObject(broken.repo, broken.mirrorTip);

    const results = executePlan(plan, broken.repo);
    const willBreak = results.find((r) => r.branch === 'will-break');
    expect(willBreak?.outcome).toBe('skipped');
    expect(willBreak?.reason).toContain('could not be re-proven');
    expect(willBreak?.reason).toContain(
      'git rev-list --count archive/will-break..will-break',
    );
    // The refusal has to be the real thing, not just a different string: the
    // branch — now the only ref whose objects are all present — still exists.
    expect(
      gitStatus(broken.repo, [
        'rev-parse',
        '--verify',
        '--quiet',
        'will-break',
      ]),
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Rendering, through the shipped CLI
// ---------------------------------------------------------------------------

describe('the unknown state survives to the output', () => {
  test('status --json publishes a null count, not a zero', () => {
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
    const parsed = JSON.parse(result.stdout ?? '') as {branches: BranchRow[]};
    const row = (name: string): BranchRow => byName(parsed.branches, name);

    expect({
      disposition: row('stale-remote').disposition,
      missing: row('stale-remote').archiveMirror?.commitsMissingFromMirror,
    }).toEqual({disposition: 'review', missing: null});
    expect({
      disposition: row('healthy-mirrored').disposition,
      missing: row('healthy-mirrored').archiveMirror?.commitsMissingFromMirror,
    }).toEqual({disposition: 'mirrored', missing: 0});
  });
});
