/**
 * Tests for the +submodules enrichment.
 *
 * Real git repos in $TMPDIR, because every property under test IS git
 * behaviour: gitlinks recorded in a tree, per-checkout submodule object stores,
 * remote-tracking reachability. A mocked git could only prove the code calls
 * what the test author expected it to call, which is exactly the thing that was
 * already believed and already wrong.
 *
 * The shape of each test is a PAIR: the broken state, then the repair, asserting
 * that the finding appears and then disappears. A test that only ever sees the
 * broken state cannot tell a real detector from one that always fires.
 *
 * Part of home-base-qyu1.14.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {existsSync, readFileSync, writeFileSync} from 'fs';
import {dirname, join, resolve} from 'path';

import {buildReport, type RepoStatusReport} from '../src/repo-status/report';
import {runDivergenceCheck} from '../src/repo-status/prime-view';
import {
  buildSubmoduleInventory,
  Q_CURRENT_CODE,
  Q_MERGE_POINTER,
  Q_RESOLVABLE,
  Q_WORK_AT_RISK,
  type SubmoduleFinding,
  type SubmoduleRow,
} from '../src/repo-status/submodules';
import {git} from './git-fixtures';
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
// Fixture
// ---------------------------------------------------------------------------

interface Fixture {
  /** Bare repo standing in for the submodule's GitHub. */
  subRemote: string;
  /** A second clone of the submodule, used to push commits the parent's checkout has never seen. */
  subWork: string;
  /** The parent repo, with the submodule at `sub`. */
  parent: string;
}

/**
 * `-c protocol.file.allow=always` is required on the COMMAND LINE for any
 * command that clones a submodule: git refuses the `file` transport for
 * submodules (CVE-2022-39253) and deliberately ignores `protocol.*.allow` from
 * repo config. Only the fixture ever passes it — the production code never
 * clones anything, so it needs no protocol override at all.
 */
function gitClone(cwd: string, args: string[]): string {
  return git(cwd, ['-c', 'protocol.file.allow=always', ...args]);
}

function initRepoAt(path: string, bare = false): void {
  git(dirname(path), ['init', '-q', ...(bare ? ['--bare'] : ['-b', 'main']), path]);
  if (bare) return;
  git(path, ['config', 'user.email', 'test@example.com']);
  git(path, ['config', 'user.name', 'Test']);
}

function setupFixture(sb: Sandbox): Fixture {
  const subRemote = join(sb.path, 'sub-remote.git');
  const subWork = join(sb.path, 'sub-work');
  const parent = join(sb.path, 'parent');

  initRepoAt(subRemote, true);
  initRepoAt(subWork);
  writeFileSync(join(subWork, 'lib.txt'), 'v1\n');
  git(subWork, ['add', '-A']);
  git(subWork, ['commit', '-qm', 'sub v1']);
  git(subWork, ['remote', 'add', 'origin', subRemote]);
  git(subWork, ['push', '-q', '-u', 'origin', 'main']);

  initRepoAt(parent);
  writeFileSync(join(parent, 'README.md'), 'parent\n');
  git(parent, ['add', '-A']);
  git(parent, ['commit', '-qm', 'init']);
  gitClone(parent, ['submodule', 'add', '-q', subRemote, 'sub']);
  git(parent, ['commit', '-qm', 'add submodule sub']);

  return {parent, subRemote, subWork};
}

/** A commit made in the parent's own submodule checkout. Never pushed. */
function commitInParentSub(fx: Fixture, text: string): string {
  const dir = join(fx.parent, 'sub');
  writeFileSync(join(dir, 'lib.txt'), `${text}\n`);
  git(dir, ['commit', '-qam', text]);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

/** A commit made in the OTHER clone and pushed — the parent's checkout has never seen it. */
function pushFromSubWork(fx: Fixture, text: string): string {
  writeFileSync(join(fx.subWork, 'lib.txt'), `${text}\n`);
  git(fx.subWork, ['commit', '-qam', text]);
  git(fx.subWork, ['push', '-q', 'origin', 'main']);
  return git(fx.subWork, ['rev-parse', 'HEAD']).trim();
}

/**
 * Record `sha` as the gitlink for `sub` and commit it.
 *
 * `update-index --cacheinfo` is what makes the "pointer absent from this store"
 * fixture possible at all: git records a gitlink WITHOUT requiring the object to
 * exist anywhere the parent can see, which is precisely why the failure this
 * feature exists to catch is possible in the first place.
 */
function recordPointer(fx: Fixture, sha: string, message: string): void {
  git(fx.parent, ['update-index', '--add', '--cacheinfo', `160000,${sha},sub`]);
  git(fx.parent, ['commit', '-qm', message]);
}

function report(cwd: string, submoduleStores = false): RepoStatusReport {
  const r = buildReport({
    content: false,
    cwd,
    prs: false,
    sinceDays: null,
    submoduleStores,
    submodules: true,
  });
  if (r == null) throw new Error('expected a report');
  return r;
}

function subRow(r: RepoStatusReport): SubmoduleRow {
  const row = r.submodules.entries.find((e) => e.path === 'sub');
  if (row == null) throw new Error('expected a row for `sub`');
  return row;
}

/** Every finding for the row, whether it hangs off the row or one of its checkouts. */
function allFindings(row: SubmoduleRow): SubmoduleFinding[] {
  return [...row.findings, ...row.checkouts.flatMap((c) => c.findings)];
}

function kinds(row: SubmoduleRow): string[] {
  return allFindings(row).map((f) => f.kind);
}

function findingOf(row: SubmoduleRow, kind: string): SubmoduleFinding {
  const f = allFindings(row).find((x) => x.kind === kind);
  if (f == null) {
    throw new Error(`expected a ${kind} finding, saw: ${kinds(row).join(', ')}`);
  }
  return f;
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

describe('submodule inventory shape', () => {
  test('a repo with no submodules gets an explicit empty list, not a missing key', () => {
    const sb = track(createSandbox());
    const repo = join(sb.path, 'plain');
    initRepoAt(repo);
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'init']);

    const r = report(repo);
    expect(r.submodules.enabled).toBe(true);
    expect(r.submodules.entries).toEqual([]);
  });

  test('one row per submodule, carrying its path and configured url', () => {
    const sb = track(createSandbox());
    const fx = setupFixture(sb);

    const r = report(fx.parent);
    expect(r.submodules.entries).toHaveLength(1);
    expect(subRow(r).path).toBe('sub');
    expect(subRow(r).url).toBe(fx.subRemote);
  });

  test('the enrichment can be switched off, and then reports nothing at all', () => {
    const sb = track(createSandbox());
    const fx = setupFixture(sb);

    const r = buildReport({
      content: false,
      cwd: fx.parent,
      prs: false,
      sinceDays: null,
      submodules: false,
    });
    expect(r?.submodules).toEqual({
      allWorktreeStores: false,
      enabled: false,
      entries: [],
    });
    expect(r?.enrichments.submodules).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The original failure
// ---------------------------------------------------------------------------

describe('a gitlink pointing at an unpushed submodule commit', () => {
  test('is SEVERE, names the fresh-clone breakage, and clears once pushed', () => {
    const sb = track(createSandbox());
    const fx = setupFixture(sb);

    // The exact shape that broke `git worktree add` on home-base: a commit made
    // in the submodule checkout, then recorded by the parent, never pushed.
    const unpushed = commitInParentSub(fx, 'local only');
    git(fx.parent, ['add', '--', 'sub']);
    git(fx.parent, ['commit', '-qm', 'bump sub']);

    const broken = subRow(report(fx.parent));
    expect(broken.severity).toBe('severe');
    expect(broken.checkouts[0]?.recordedPointer).toBe(unpushed);
    expect(broken.checkouts[0]?.pointerInStore).toBe(true);
    expect(broken.checkouts[0]?.pointerOnRemotes).toEqual([]);

    const pointer = findingOf(broken, 'pointer-not-on-remote');
    expect(pointer.severity).toBe('severe');
    expect(pointer.question).toBe(Q_RESOLVABLE);
    expect(pointer.why).toContain('not our ref');
    expect(pointer.why).toContain('git worktree add');
    expect(pointer.fix).toContain('push');

    // NEGATIVE CONTROL: push the very same commit and the severe finding must go.
    git(join(fx.parent, 'sub'), ['push', '-q', 'origin', 'main']);
    const fixed = subRow(report(fx.parent));
    expect(kinds(fixed)).not.toContain('pointer-not-on-remote');
    expect(fixed.severity).toBe('ok');
    expect(fixed.checkouts[0]?.pointerOnRemotes).toContain('origin/main');
  });

  test('is reported separately from a pointer that is merely ABSENT FROM THIS STORE', () => {
    const sb = track(createSandbox());
    const fx = setupFixture(sb);

    // Pushed from the other clone, so it genuinely IS on the remote — the
    // parent's submodule store has simply never fetched it.
    const pushed = pushFromSubWork(fx, 'v2');
    recordPointer(fx, pushed, 'bump sub to a commit this store has not fetched');

    const row = subRow(report(fx.parent));
    const checkout = row.checkouts[0];
    expect(checkout?.pointerInStore).toBe(false);
    // The row must say WHICH store it looked in — reachability is per-checkout.
    expect(checkout?.store).toContain('.git/modules/sub');

    const absent = findingOf(row, 'pointer-absent-from-store');
    expect(absent.severity).toBe('advisory');
    expect(absent.why).toContain('says nothing about whether the commit exists');
    expect(absent.fix).toContain('fetch');
    // The severe diagnosis is the WRONG answer here and must not be given.
    expect(kinds(row)).not.toContain('pointer-not-on-remote');
    expect(row.severity).toBe('advisory');

    // NEGATIVE CONTROL: the prescribed fix resolves it, and still never
    // produces the severe finding.
    git(join(fx.parent, 'sub'), ['fetch', '--all', '-q']);
    const fetched = subRow(report(fx.parent));
    expect(kinds(fetched)).not.toContain('pointer-absent-from-store');
    expect(kinds(fetched)).not.toContain('pointer-not-on-remote');
    expect(fetched.checkouts[0]?.pointerInStore).toBe(true);
  });

  test('claims nothing about how the checkout RELATES to a pointer it does not have', () => {
    const sb = track(createSandbox());
    const fx = setupFixture(sb);
    const pushed = pushFromSubWork(fx, 'v2');
    recordPointer(fx, pushed, 'bump sub to an unfetched commit');

    // `merge-base` fails outright on a missing object, and reading that failure
    // as "divergent" would print a confident lie about a commit that is one
    // fetch away. Silence is the only correct answer here.
    const row = subRow(report(fx.parent));
    expect(kinds(row)).not.toContain('pointer-bump-uncommitted');
    expect(kinds(row)).not.toContain('checkout-behind-pointer');
    expect(row.why).not.toContain('divergent');
  });

  test('a checkout sitting on an ANCESTOR of the recorded pointer is a stale-base advisory', () => {
    const sb = track(createSandbox());
    const fx = setupFixture(sb);
    const pushed = pushFromSubWork(fx, 'v2');
    // Fetched this time, so the relation is genuinely knowable.
    git(join(fx.parent, 'sub'), ['fetch', '--all', '-q']);
    recordPointer(fx, pushed, 'bump sub without checking it out');

    const row = subRow(report(fx.parent));
    const behind = findingOf(row, 'checkout-behind-pointer');
    expect(behind.severity).toBe('advisory');
    expect(behind.question).toBe(Q_CURRENT_CODE);
    expect(behind.why).toContain('ANCESTOR');
    expect(behind.fix).toContain('submodule update');
    expect(kinds(row)).not.toContain('pointer-bump-uncommitted');

    // NEGATIVE CONTROL: check the recorded pointer out and it clears.
    gitClone(fx.parent, ['submodule', 'update', '--init', '--', 'sub']);
    expect(kinds(subRow(report(fx.parent)))).not.toContain(
      'checkout-behind-pointer',
    );
  });
});

// ---------------------------------------------------------------------------
// Behind is not noise
// ---------------------------------------------------------------------------

describe('a checkout behind its remote with nothing ahead', () => {
  test('surfaces as an advisory with a next action — neither filtered nor alarmed', () => {
    const sb = track(createSandbox());
    const fx = setupFixture(sb);

    pushFromSubWork(fx, 'v2');
    pushFromSubWork(fx, 'v3');
    // Fetch only: the checkout stays where it is, so it is behind and 0 ahead.
    git(join(fx.parent, 'sub'), ['fetch', '--all', '-q']);

    const row = subRow(report(fx.parent));
    const checkout = row.checkouts[0];
    expect(checkout?.behind).toBe(2);
    expect(checkout?.unpushedCommits).toBe(0);
    expect(checkout?.upstreamRef).toBe('origin/main');

    const stale = findingOf(row, 'stale-checkout');
    // Not an alarm...
    expect(stale.severity).toBe('advisory');
    expect(row.severity).not.toBe('severe');
    // ...but not silence either: it says which question the number answers, and
    // it names the stale-dependency hazard plus a concrete next action.
    expect(stale.question).toBe(Q_CURRENT_CODE);
    expect(stale.why).toContain('no work is at risk');
    expect(stale.why).toContain('stale base');
    expect(stale.fix).toContain('submodule update');
    expect(stale.fix).toContain('dependencies');

    // NEGATIVE CONTROL: bring the checkout up to date and it clears.
    gitClone(fx.parent, ['submodule', 'update', '--init', '--remote', '--', 'sub']);
    const fresh = subRow(report(fx.parent));
    expect(kinds(fresh)).not.toContain('stale-checkout');
    expect(fresh.checkouts[0]?.behind).toBe(0);
  });

  test('answers a different question than the work-at-risk findings do', () => {
    const sb = track(createSandbox());
    const fx = setupFixture(sb);

    pushFromSubWork(fx, 'v2');
    git(join(fx.parent, 'sub'), ['fetch', '--all', '-q']);
    commitInParentSub(fx, 'my own work');

    const row = subRow(report(fx.parent));
    expect(findingOf(row, 'stale-checkout').question).toBe(Q_CURRENT_CODE);
    expect(findingOf(row, 'unpushed-commits').question).toBe(Q_WORK_AT_RISK);
    // Same checkout, both numbers present, and they are not the same question.
    expect(row.checkouts[0]?.behind).toBeGreaterThan(0);
    expect(row.checkouts[0]?.unpushedCommits).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Per-worktree stores
// ---------------------------------------------------------------------------

describe('multiple parent worktrees', () => {
  /** A linked parent worktree with its own, separately cloned, submodule store. */
  function addWorktree(fx: Fixture, sb: Sandbox, name: string): string {
    const path = join(sb.path, name);
    git(fx.parent, ['worktree', 'add', '-q', '-b', name, path, 'main']);
    gitClone(path, ['submodule', 'update', '--init', '--', 'sub']);
    return path;
  }

  test('each worktree gets its OWN submodule object store', () => {
    const sb = track(createSandbox());
    const fx = setupFixture(sb);
    const wt = addWorktree(fx, sb, 'wt');

    const r = report(fx.parent, true);
    const row = subRow(r);
    const primary = row.checkouts.find((c) => c.isPrimary);
    const linked = row.checkouts.find((c) => c.worktree === wt);

    expect(primary?.store).toContain('.git/modules/sub');
    expect(linked?.store).toContain('.git/worktrees/wt/modules/sub');
    expect(primary?.store).not.toBe(linked?.store);
    expect(primary?.isCurrent).toBe(true);
    expect(linked?.isCurrent).toBe(false);
  });

  test('unpushed commits in a LINKED worktree store are severe and named as such', () => {
    const sb = track(createSandbox());
    const fx = setupFixture(sb);
    const wt = addWorktree(fx, sb, 'wt');

    const dir = join(wt, 'sub');
    writeFileSync(join(dir, 'lib.txt'), 'only in the worktree store\n');
    git(dir, ['commit', '-qam', 'worktree-only work']);

    const row = subRow(report(fx.parent, true));
    const linked = row.checkouts.find((c) => c.worktree === wt);
    expect(linked?.unpushedCommits).toBe(1);

    const risk = findingOf(row, 'unpushed-commits');
    expect(risk.severity).toBe('severe');
    expect(risk.question).toBe(Q_WORK_AT_RISK);
    expect(risk.why).toContain('git worktree remove');
    expect(risk.why).toContain('.git/worktrees/wt/modules/sub');
    expect(row.severity).toBe('severe');

    // NEGATIVE CONTROL: push it, and the work is no longer at risk.
    git(dir, ['push', '-q', 'origin', 'HEAD:main']);
    const pushed = subRow(report(fx.parent, true));
    expect(kinds(pushed)).not.toContain('unpushed-commits');
  });

  test('by DEFAULT only the current store is opened, but every pointer is still read', () => {
    const sb = track(createSandbox());
    const fx = setupFixture(sb);
    const wt = addWorktree(fx, sb, 'wt');

    const row = subRow(report(fx.parent));
    const linked = row.checkouts.find((c) => c.worktree === wt);
    expect(linked?.store).toBeNull();
    expect(linked?.storeNote).toContain('--submodule-stores');
    // The cheap half still happens: the pointer each worktree records is known.
    expect(linked?.recordedPointer).not.toBeNull();
    expect(row.checkouts.find((c) => c.isPrimary)?.store).not.toBeNull();
  });

  test('divergent pointers are reported per worktree, and stay quiet until work is actually at risk', () => {
    const sb = track(createSandbox());
    const fx = setupFixture(sb);
    const wt = addWorktree(fx, sb, 'wt');

    // Move the linked worktree's recorded pointer somewhere else entirely.
    const pushed = pushFromSubWork(fx, 'v2');
    git(join(wt, 'sub'), ['fetch', '--all', '-q']);
    git(join(wt, 'sub'), ['checkout', '-q', pushed]);
    git(wt, ['add', '--', 'sub']);
    git(wt, ['commit', '-qm', 'bump sub in the worktree']);

    const quiet = subRow(report(fx.parent));
    expect(quiet.pointersAcrossWorktrees).toBe(2);
    const divergence = findingOf(quiet, 'pointer-diverges-across-worktrees');
    // Divergence alone is the NORMAL state of a multi-worktree repo. Reported,
    // explained, and pointed at the escalation — but not called a problem.
    expect(divergence.severity).toBe('ok');
    expect(divergence.why).toContain('its OWN object store');
    expect(divergence.why).toContain('--submodule-stores');
    expect(quiet.why).toContain('2 different pointers');

    // It escalates only when two opened stores each hold work of their own,
    // which is the state where removing a worktree destroys a unique copy.
    commitInParentSub(fx, 'primary-only work');
    writeFileSync(join(wt, 'sub', 'lib.txt'), 'worktree-only work\n');
    git(join(wt, 'sub'), ['commit', '-qam', 'worktree-only work']);

    const loud = findingOf(
      subRow(report(fx.parent, true)),
      'pointer-diverges-across-worktrees',
    );
    expect(loud.severity).toBe('advisory');
    expect(loud.why).toContain('destroys a unique copy');
  });
});

// ---------------------------------------------------------------------------
// Per-branch gitlinks (home-base-qyu1.20)
// ---------------------------------------------------------------------------

/** Create `branch` off main recording `sha` as the gitlink for `sub`. */
function branchRecording(fx: Fixture, branch: string, sha: string): void {
  git(fx.parent, ['checkout', '-q', '-b', branch]);
  git(fx.parent, ['update-index', '--add', '--cacheinfo', `160000,${sha},sub`]);
  git(fx.parent, ['commit', '-qm', `record ${sha.slice(0, 7)} on ${branch}`]);
  git(fx.parent, ['checkout', '-q', 'main']);
}

/** A branch that touches everything EXCEPT the gitlink. */
function branchLeavingPointerAlone(fx: Fixture, branch: string): void {
  git(fx.parent, ['checkout', '-q', '-b', branch]);
  writeFileSync(join(fx.parent, 'README.md'), `changed on ${branch}\n`);
  git(fx.parent, ['commit', '-qam', `unrelated work on ${branch}`]);
  git(fx.parent, ['checkout', '-q', 'main']);
}

function branchFindings(row: SubmoduleRow): SubmoduleFinding[] {
  return allFindings(row).filter(
    (f) => f.kind === 'pointer-diverges-across-branches',
  );
}

describe('gitlinks recorded by other BRANCHES', () => {
  test('says nothing when every branch agrees — and the silence is a CLAIM, not an absence', () => {
    const sb = track(createSandbox());
    const fx = setupFixture(sb);
    branchLeavingPointerAlone(fx, 'feature');

    const row = subRow(report(fx.parent));
    expect(branchFindings(row)).toEqual([]);

    // The whole point: "checked, all agree" must be readable as such. A caller
    // that cannot tell this apart from "nobody looked" learns nothing from the
    // silence, so the positive form is recorded explicitly.
    expect(row.branchPointers.checked).toBe(true);
    expect(row.branchPointers.branchesCompared).toBe(1);
    expect(row.branchPointers.divergent).toEqual([]);
    expect(row.branchPointers.baselineRef).toBe('main');
    expect(row.branchPointers.baselinePointer).not.toBeNull();
    expect(row.branchPointers.note).toBeNull();
  });

  test('NOT checked is spelled differently from checked-and-agreeing', () => {
    const sb = track(createSandbox());
    const fx = setupFixture(sb);
    branchLeavingPointerAlone(fx, 'feature');

    // `enabled` alone cannot carry this: the section ran, and the branch
    // comparison still did not happen.
    const inventory = buildSubmoduleInventory({
      cwd: fx.parent,
      repoRoot: fx.parent,
      worktrees: [],
    });
    expect(inventory.enabled).toBe(true);
    const audit = inventory.entries[0]?.branchPointers;
    expect(audit?.checked).toBe(false);
    expect(audit?.divergent).toEqual([]);
    expect(audit?.branchesCompared).toBe(0);
    expect(audit?.note).toContain('no branch rows were supplied');
  });

  test('a baseline that does not record the submodule at all is not-checked, never divergence', () => {
    const sb = track(createSandbox());
    const fx = setupFixture(sb);

    // `sub` exists only on a branch: keep a ref to the commit that added it,
    // then rewind main behind it and inspect from the branch. The submodule is
    // discoverable (the checkout has it) while the BASELINE records nothing.
    git(fx.parent, ['branch', 'adds-sub']);
    git(fx.parent, ['reset', '--hard', '-q', 'HEAD~1']);
    git(fx.parent, ['checkout', '-q', 'adds-sub']);

    const r = report(fx.parent);
    const row = r.submodules.entries.find((e) => e.path === 'sub');
    expect(row).not.toBeUndefined();

    // Reported as "nothing to compare against" rather than as every branch
    // disagreeing, which would be a loud lie about a submodule nobody moved.
    expect(row?.branchPointers.checked).toBe(false);
    expect(row?.branchPointers.note).toContain('does not record this submodule');
    expect(branchFindings(row as SubmoduleRow)).toEqual([]);
  });

  test('one finding per divergent branch, naming the branch, BOTH shas and the merge consequence', () => {
    const sb = track(createSandbox());
    const fx = setupFixture(sb);
    const baseline = git(fx.parent, ['rev-parse', 'HEAD:sub']).trim();

    const v2 = pushFromSubWork(fx, 'v2');
    const v3 = pushFromSubWork(fx, 'v3');
    git(join(fx.parent, 'sub'), ['fetch', '--all', '-q']);
    branchRecording(fx, 'one', v2);
    branchRecording(fx, 'two', v3);
    branchLeavingPointerAlone(fx, 'agrees');

    const row = subRow(report(fx.parent));
    const found = branchFindings(row);
    // Exactly the two that disagree — the third branch is compared and silent.
    expect(found).toHaveLength(2);
    expect(row.branchPointers.branchesCompared).toBe(3);
    expect(row.branchPointers.divergent.map((d) => d.branch).sort()).toEqual([
      'one',
      'two',
    ]);

    const one = found.find((f) => f.why.includes('branch one'));
    expect(one?.question).toBe(Q_MERGE_POINTER);
    expect(one?.why).toContain(v2.slice(0, 7));
    expect(one?.why).toContain(baseline.slice(0, 7));
    expect(one?.why).toContain('moves the recorded gitlink');
    expect(one?.why).toContain('conflicts on the gitlink');
    expect(one?.fix).toContain('diff main one -- sub');

    // Both shas are in the store here, so the relation IS knowable and is the
    // fact that says how to unify them.
    expect(
      row.branchPointers.divergent.find((d) => d.branch === 'one')
        ?.relationToBaseline,
    ).toBe('ahead of');

    // NEGATIVE CONTROL: point both branches back at the baseline pointer and
    // every finding must vanish while the comparison still reports as done.
    for (const branch of ['one', 'two']) {
      git(fx.parent, ['checkout', '-q', branch]);
      git(fx.parent, [
        'update-index',
        '--add',
        '--cacheinfo',
        `160000,${baseline},sub`,
      ]);
      git(fx.parent, ['commit', '-qm', `back to baseline on ${branch}`]);
    }
    git(fx.parent, ['checkout', '-q', 'main']);

    const quiet = subRow(report(fx.parent));
    expect(branchFindings(quiet)).toEqual([]);
    expect(quiet.branchPointers.checked).toBe(true);
    expect(quiet.branchPointers.branchesCompared).toBe(3);
  });

  test('a divergent pointer that is on NO REMOTE inherits the severe framing', () => {
    const sb = track(createSandbox());
    const fx = setupFixture(sb);

    // A submodule commit that exists in this store and nowhere else. The
    // checkout is put back on the pushed commit afterwards so the ONLY thing
    // wrong with this repo is the branch's recorded pointer — otherwise
    // qyu1.14's unpushed-commits finding would supply the severity instead.
    const orphan = commitInParentSub(fx, 'never pushed anywhere');
    git(join(fx.parent, 'sub'), ['reset', '--hard', '-q', 'origin/main']);
    branchRecording(fx, 'doomed', orphan);

    const row = subRow(report(fx.parent));
    expect(kinds(row)).not.toContain('unpushed-commits');

    const finding = branchFindings(row)[0];
    expect(finding?.severity).toBe('severe');
    expect(finding?.question).toBe(Q_MERGE_POINTER);
    expect(finding?.why).toContain('doomed');
    expect(finding?.why).toContain('on no remote-tracking branch');
    expect(finding?.why).toContain('not our ref');
    expect(finding?.fix).toContain('BEFORE merging doomed');
    // The severity has to reach the row, or nothing surfaces it to a reader.
    expect(row.severity).toBe('severe');
    expect(row.why).toContain('doomed');

    const divergence = row.branchPointers.divergent[0];
    expect(divergence?.inStore).toBe(true);
    expect(divergence?.onRemotes).toEqual([]);

    // NEGATIVE CONTROL: push that exact commit. It is still divergent — the
    // branch still moves the gitlink — but it is no longer an alarm.
    git(join(fx.parent, 'sub'), [
      'push',
      '-q',
      'origin',
      `${orphan}:refs/heads/rescued`,
    ]);
    const rescued = subRow(report(fx.parent));
    expect(branchFindings(rescued)).toHaveLength(1);
    expect(branchFindings(rescued)[0]?.severity).toBe('ok');
    expect(rescued.severity).toBe('ok');
    expect(rescued.branchPointers.divergent[0]?.onRemotes).toContain(
      'origin/rescued',
    );
  });

  test('a branch pointer this store has never fetched is reported, but not as an alarm', () => {
    const sb = track(createSandbox());
    const fx = setupFixture(sb);

    // Pushed from the other clone and never fetched here. This is the ORDINARY
    // state for a branch someone else pushed, so treating "I do not have that
    // object" as evidence of breakage would fire on almost every real repo.
    const unfetched = pushFromSubWork(fx, 'v2');
    branchRecording(fx, 'theirs', unfetched);

    const finding = branchFindings(subRow(report(fx.parent)))[0];
    expect(finding?.severity).toBe('ok');
    expect(finding?.why).toContain('is not an object in this checkout');
    expect(finding?.why).toContain('cannot be judged from here');
    expect(finding?.fix).toContain('fetch --all');

    const divergence = subRow(report(fx.parent)).branchPointers.divergent[0];
    expect(divergence?.inStore).toBe(false);
    // No merge-base was attempted against an object we do not have.
    expect(divergence?.relationToBaseline).toBeNull();
  });

  test('claims no RELATION when the object missing from this store is the BASELINE one', () => {
    const sb = track(createSandbox());
    const fx = setupFixture(sb);
    const original = git(fx.parent, ['rev-parse', 'HEAD:sub']).trim();

    // The asymmetric case, and the one seen live on home-base: the BRANCH's
    // pointer is present here while the BASELINE's is not. `merge-base` fails
    // on either missing object, and reading that failure as "divergent from"
    // would print a confident lie — so the relation must stay unknown.
    const unfetched = pushFromSubWork(fx, 'v2');
    recordPointer(fx, unfetched, 'move main to a commit this store lacks');
    branchRecording(fx, 'stays', original);

    const row = subRow(report(fx.parent));
    const divergence = row.branchPointers.divergent[0];
    expect(divergence?.branch).toBe('stays');
    expect(divergence?.inStore).toBe(true);
    expect(divergence?.relationToBaseline).toBeNull();
    // Knowing nothing about the relation is not an alarm, and the finding must
    // not silently drop the parenthetical's absence into a wrong claim.
    expect(branchFindings(row)[0]?.severity).toBe('ok');
    expect(branchFindings(row)[0]?.why).not.toContain('in submodule history');

    // NEGATIVE CONTROL: fetch, and the relation becomes knowable.
    git(join(fx.parent, 'sub'), ['fetch', '--all', '-q']);
    const fetched = subRow(report(fx.parent));
    expect(fetched.branchPointers.divergent[0]?.relationToBaseline).toBe(
      'behind',
    );
    expect(branchFindings(fetched)[0]?.why).toContain(
      'behind it in submodule history',
    );
  });
});

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

/**
 * Every relative import reachable from `entry`, ignoring type-only imports.
 *
 * The claim being tested is a COST claim ("adds nothing to session start"), and
 * the honest way to prove it for a synchronous CLI is that the code is not
 * reachable from the entry point at all. A single-file grep would miss a module
 * pulled in two hops away, so this walks the whole graph.
 */
function transitiveImports(entry: string): string[] {
  const seen = new Set<string>();
  const stack = [resolve(entry)];
  while (stack.length > 0) {
    const file = stack.pop();
    if (file == null || seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf-8').replace(
      /import\s+type\s+[^;]*?from\s+'[^']+';/g,
      '',
    );
    for (const match of source.matchAll(/from\s+'(\.[^']+)'/g)) {
      const spec = match[1];
      if (spec == null) continue;
      const base = resolve(dirname(file), spec);
      for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
        if (existsSync(candidate)) {
          stack.push(candidate);
          break;
        }
      }
    }
  }
  return [...seen];
}

describe('cost to the prime session-start path', () => {
  const HOOK = resolve(import.meta.dir, '../src/plugin/hooks/session-start.ts');

  test('the session-start hook cannot reach the submodule module at all', () => {
    const graph = transitiveImports(HOOK);
    // Sanity: the walker really does traverse, or the assertion below is vacuous.
    expect(graph.some((f) => f.endsWith('/repo-status/prime-view.ts'))).toBe(true);
    expect(graph.some((f) => f.endsWith('/repo-status/core.ts'))).toBe(true);

    expect(graph.filter((f) => f.endsWith('/repo-status/submodules.ts'))).toEqual(
      [],
    );
    expect(graph.filter((f) => f.endsWith('/repo-status/report.ts'))).toEqual([]);
  });

  test('the session-start view produces no submodule data on a repo that has one', () => {
    const sb = track(createSandbox());
    const fx = setupFixture(sb);
    commitInParentSub(fx, 'local only');
    git(fx.parent, ['add', '--', 'sub']);
    git(fx.parent, ['commit', '-qm', 'bump sub']);

    // Same repo that `buildReport` calls severe — the session-start view is
    // deliberately silent about it rather than paying to find out.
    expect(subRow(report(fx.parent)).severity).toBe('severe');

    const divergence = runDivergenceCheck({cwd: fx.parent});
    expect(divergence).not.toBeNull();
    expect(Object.keys(divergence ?? {}).sort()).toEqual([
      'currentBranch',
      'groups',
    ]);
  });
});
