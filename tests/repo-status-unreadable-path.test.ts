/**
 * A path git could not READ on the baseline must never read as one the baseline
 * DROPPED (home-base-qyu1.24).
 *
 * `blobSha` returned null for both, and for a `D`-status path the null branch is
 * `deletion-reflected` — "the baseline let this file go too, so the branch's
 * deletion already landed". That is the most reassuring per-file verdict in
 * `content.ts`, and it feeds `allFilesReflected` -> `allContentOnBaseline` ->
 * `merged` with `provenSafe: true`, which is the only field `plan`/`apply` act
 * on. A repo that cannot answer the question therefore answered it in the one
 * direction that authorises deleting the branch.
 *
 * ── The bead called reachability a hypothesis. It is a deterministic repo state ─
 *
 * `buildFixture` needs no shim, no transient failure and no exotic clone. ONE
 * missing tree object does it, because git's tree diff PRUNES subtrees whose
 * OIDs are equal on both sides: every command in the chain either walks commits
 * (`rev-list`, `for-each-ref`) or diffs pairs of trees that never differ inside
 * `d/`, while `rev-parse main:d/foo` must open `d` on main and cannot. So
 * `cherry` and `show --name-status` both exit 0 while the baseline lookup fails
 * — the exact asymmetry the bug needs, pinned in the first test below.
 *
 * The `d` tree is reachable ONLY from main's tip because main modified `d/bar`
 * while the branch reached the same tree through an EVIL MERGE (a merge commit
 * that also edits `d/foo`). `git cherry` sets `max_parents = 1`, so it never
 * asks a merge commit for a patch-id — which is what keeps main's `d` out of
 * every diff the proof runs.
 *
 * ── Why the discriminator is `ls-tree` and not the error text ────────────────
 *
 * The obvious fix is to read `rev-parse`'s stderr, since a genuine absence says
 * `fatal: path 'x' does not exist in 'ref'`. `stderr wording cannot tell the two
 * apart` below is the measurement that kills that idea: with the tree destroyed
 * and the file absent from the working copy, git emits that sentence VERBATIM
 * for a path that is on the ref. String-matching would have shipped the bug
 * back in, silently, as a fix.
 *
 * Every damaged case is paired with a HEALTHY control in the SAME damaged repo —
 * `genuine-delete` is still `merged`, still `provenSafe`, and still lands in the
 * plan's safe group — so a "refuse everything" fix fails here.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {execFileSync, spawnSync} from 'child_process';
import {existsSync, mkdirSync, rmSync, writeFileSync} from 'fs';
import {join} from 'path';

import {
  proveContentOnBaseline,
  verifyCommitFiles,
  type FileVerdict,
} from '../src/repo-status/content';
import {buildPlan, type CleanupPlan} from '../src/repo-status/plan';
import {
  buildReport,
  type BranchRow,
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

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {cwd, encoding: 'utf-8', stdio: 'pipe'});
}

/** Run git without throwing, keeping the exit status and stderr. */
function gitRun(
  cwd: string,
  args: string[],
): {status: number; stderr: string; stdout: string} {
  const result = spawnSync('git', args, {cwd, encoding: 'utf-8'});
  return {
    status: result.status ?? -1,
    stderr: (result.stderr ?? '').trim(),
    stdout: (result.stdout ?? '').trim(),
  };
}

function commit(repo: string, msg: string): string {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', msg]);
  return git(repo, ['rev-parse', 'HEAD']).trim();
}

function write(repo: string, file: string, body: string): void {
  writeFileSync(join(repo, file), `${body}\n`);
}

/** Delete the loose object for `sha`, so any read that must parse it fails. */
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
 * A branch that deletes `d/foo` while reaching main's content through an evil
 * merge, so its own `d` tree is a different object from main's.
 */
function addEvilMergeDeleter(repo: string, name: string, mark: string): void {
  git(repo, ['checkout', '-q', '-b', name, 'M0']);
  git(repo, ['merge', '-q', '--no-ff', '--no-commit', 'main']);
  write(repo, 'd/foo', `foo edited on ${mark}`);
  commit(repo, `${name}: evil merge of main`);
  git(repo, ['rm', '-q', 'd/foo']);
  commit(repo, `${name}: delete d/foo`);
}

interface Fixture {
  /** The branch's delete commit — the one whose D-status path is unreadable. */
  localDeleteSha: string;
  /** The tree object destroyed: main's `d/`. */
  missingTree: string;
  repo: string;
  /** The fully-reflected control commit. */
  genuineDeleteSha: string;
}

/**
 *   M0                     d/foo, d/bar, dropped1.txt, dropped2.txt
 *   main                   M0 -- M1 (edit d/bar) -- M2 (rm dropped1, add also)
 *                                -- M3 (rm dropped2)
 *   local-delete           M0 -- [evil merge of main@M1] -- (rm d/foo)
 *   origin/remote-delete   the same shape, pushed and dropped locally
 *   genuine-delete         M1 -- (rm dropped1, rm dropped2, add also.txt)
 *
 *   DESTROYED: main:d — the tree {foo, bar'}, reachable only from main's tip.
 */
function buildFixture(sb: Sandbox): Fixture {
  const repo = initRepo(sb, 'repo');
  const remote = join(sb.path, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', remote], {stdio: 'pipe'});

  mkdirSync(join(repo, 'd'), {recursive: true});
  write(repo, 'd/foo', 'foo');
  write(repo, 'd/bar', 'bar');
  write(repo, 'dropped1.txt', 'one');
  write(repo, 'dropped2.txt', 'two');
  commit(repo, 'M0');
  git(repo, ['tag', 'M0']);

  write(repo, 'd/bar', 'bar edited on main');
  commit(repo, 'M1: edit d/bar');
  git(repo, ['tag', 'M1']);
  const missingTree = git(repo, ['rev-parse', 'main:d']).trim();

  addEvilMergeDeleter(repo, 'local-delete', 'local-delete');

  addEvilMergeDeleter(repo, 'push-src', 'remote-delete');
  git(repo, ['remote', 'add', 'origin', remote]);
  git(repo, ['push', '-q', 'origin', 'push-src:remote-delete']);
  git(repo, ['fetch', '-q', 'origin']);
  const localDeleteSha = git(repo, ['rev-parse', 'local-delete']).trim();

  // The control: its deletions are GENUINELY reflected on main, and it deletes
  // both files in one commit where main deleted them in two, so no patch-id
  // matches and the verdict has to come from the per-file comparison.
  git(repo, ['checkout', '-q', '-b', 'genuine-delete', 'M1']);
  git(repo, ['rm', '-q', 'dropped1.txt', 'dropped2.txt']);
  write(repo, 'also.txt', 'also');
  const genuineDeleteSha = commit(repo, 'genuine-delete: drop both, add also');

  git(repo, ['checkout', '-q', 'main']);
  git(repo, ['branch', '-q', '-D', 'push-src']);
  git(repo, ['rm', '-q', 'dropped1.txt']);
  write(repo, 'also.txt', 'also');
  commit(repo, 'M2: rm dropped1, add also');
  git(repo, ['rm', '-q', 'dropped2.txt']);
  commit(repo, 'M3: rm dropped2');

  // The whole fixture rests on main's tip still pointing at the tree about to be
  // destroyed; a later commit that touched `d/` would silently defuse it.
  if (git(repo, ['rev-parse', 'main:d']).trim() !== missingTree) {
    throw new Error('main:d moved — the fixture would prove nothing');
  }
  destroyObject(repo, missingTree);

  return {genuineDeleteSha, localDeleteSha, missingTree, repo};
}

function reportFor(repo: string): RepoStatusReport {
  const report = buildReport({
    content: true,
    cwd: repo,
    prs: false,
    sinceDays: null,
    submodules: false,
  });
  if (report == null) throw new Error('expected a report');
  return report;
}

function rowsFor(repo: string): BranchRow[] {
  const rows = reportFor(repo).branches;
  if (rows == null) throw new Error('expected branch rows');
  return rows;
}

function byName(rows: BranchRow[], name: string): BranchRow {
  const row = rows.find((r) => r.name === name);
  if (row == null) throw new Error(`no row for ${name}`);
  return row;
}

function planFor(repo: string): CleanupPlan {
  const plan = buildPlan(reportFor(repo));
  if (plan == null) throw new Error('expected a plan');
  return plan;
}

function statusOf(files: FileVerdict[], path: string): string | undefined {
  return files.find((f) => f.path === path)?.status;
}

// ---------------------------------------------------------------------------
// The premise: this is a repo state, not a hypothetical
// ---------------------------------------------------------------------------

describe('a missing tree makes the baseline lookup fail while the walk succeeds', () => {
  test('cherry and show succeed; only the path lookup cannot answer', () => {
    const sb = track(createSandbox());
    const fx = buildFixture(sb);

    // Everything the proof needs to REACH the file comparison still works...
    expect(gitRun(fx.repo, ['cherry', '-v', 'main', 'local-delete']).status).toBe(0);
    expect(
      gitRun(fx.repo, [
        'show',
        '--name-status',
        '--format=',
        '-m',
        '--first-parent',
        fx.localDeleteSha,
      ]).stdout,
    ).toBe('D\td/foo');
    expect(
      gitRun(fx.repo, ['rev-list', '--left-right', '--count', 'main...local-delete'])
        .status,
    ).toBe(0);
    // ...and the branch listing too, so the row is built rather than refused
    // upstream by the qyu1.23 enumeration guard.
    expect(reportFor(fx.repo).enumerationFailures).toBeUndefined();

    // ...while the one question that decides the verdict cannot be answered.
    expect(gitRun(fx.repo, ['rev-parse', 'main:d/foo']).status).not.toBe(0);
    // And the path is REALLY there — this is a failed read, not an absence.
    expect(gitRun(fx.repo, ['rev-parse', 'local-delete^:d/foo']).status).toBe(0);
  });

  test('stderr wording cannot tell the two apart, so the fix does not read it', () => {
    const sb = track(createSandbox());
    const repo = initRepo(sb, 'wording');
    mkdirSync(join(repo, 'd'), {recursive: true});
    write(repo, 'd/foo', 'foo');
    write(repo, 'top.txt', 'top');
    commit(repo, 'init');
    const tree = git(repo, ['rev-parse', 'HEAD:d']).trim();
    // Remove the file from the WORKING COPY too: git's "exists on disk, but not
    // in" variant is about the checkout, and a branch whose commit deleted the
    // path (the shape this bug lives in) has no such file on disk.
    rmSync(join(repo, 'd'), {recursive: true});
    destroyObject(repo, tree);

    const unreadable = gitRun(repo, ['rev-parse', 'HEAD:d/foo']);
    const absent = gitRun(repo, ['rev-parse', 'HEAD:never-existed']);

    // Byte-identical but for the path. Any `includes('does not exist in')` test
    // would classify the damaged tree as an absence and re-open the bug.
    expect(unreadable.stderr).toBe("fatal: path 'd/foo' does not exist in 'HEAD'");
    expect(absent.stderr).toBe(
      "fatal: path 'never-existed' does not exist in 'HEAD'",
    );
    expect(unreadable.status).toBe(absent.status);

    // The structural discriminator separates them cleanly: an exit code, and
    // whether there was any output at all.
    const lsUnreadable = gitRun(repo, [
      'ls-tree',
      '--full-tree',
      'HEAD',
      '--',
      ':(literal)d/foo',
    ]);
    const lsAbsent = gitRun(repo, [
      'ls-tree',
      '--full-tree',
      'HEAD',
      '--',
      ':(literal)never-existed',
    ]);
    const lsPresent = gitRun(repo, [
      'ls-tree',
      '--full-tree',
      'HEAD',
      '--',
      ':(literal)top.txt',
    ]);
    expect(lsUnreadable.status).not.toBe(0);
    expect({status: lsAbsent.status, stdout: lsAbsent.stdout}).toEqual({
      status: 0,
      stdout: '',
    });
    expect(lsPresent.status).toBe(0);
    expect(lsPresent.stdout).toContain('top.txt');
  });
});

// ---------------------------------------------------------------------------
// The per-file verdict
// ---------------------------------------------------------------------------

describe('verifyCommitFiles reports a failed read as a failed read', () => {
  test('the unreadable deletion is `unreadable`, naming the command that failed', () => {
    const sb = track(createSandbox());
    const fx = buildFixture(sb);

    const files = verifyCommitFiles(fx.localDeleteSha, 'main', fx.repo);
    expect(files).toHaveLength(1);
    const verdict = files[0] as FileVerdict;
    expect({path: verdict.path, status: verdict.status}).toEqual({
      path: 'd/foo',
      status: 'unreadable',
    });
    expect(verdict.unreadable).toEqual({
      command: 'git ls-tree --full-tree main -- :(literal)d/foo',
      detail: `error: Could not read ${fx.missingTree}`,
      ref: 'main',
    });
  });

  test('a genuine absence still produces the verdicts it always did', () => {
    const sb = track(createSandbox());
    const fx = buildFixture(sb);

    // Same repo, same damaged object store: deletions that ARE reflected still
    // read as reflected, and a path present on both sides still reads as
    // identical. Without this, "call everything unreadable" would pass.
    const files = verifyCommitFiles(fx.genuineDeleteSha, 'main', fx.repo);
    expect({
      also: statusOf(files, 'also.txt'),
      one: statusOf(files, 'dropped1.txt'),
      two: statusOf(files, 'dropped2.txt'),
    }).toEqual({
      also: 'identical',
      one: 'deletion-reflected',
      two: 'deletion-reflected',
    });

    // The failure detail is a key that only exists when something failed, so a
    // healthy repo's JSON is byte-for-byte what it was before this change.
    for (const file of files) {
      expect(Object.keys(file).sort()).toEqual(['path', 'status']);
    }
  });
});

// ---------------------------------------------------------------------------
// The verdict, and what acts on it
// ---------------------------------------------------------------------------

describe('an unreadable file keeps a branch out of the safe group', () => {
  test('the proof refuses to conclude, and the row lands in review', () => {
    const sb = track(createSandbox());
    const fx = buildFixture(sb);

    const proof = proveContentOnBaseline('local-delete', 'main', fx.repo);
    expect(proof.allContentOnBaseline).toBe(false);
    expect(proof.unaccountedCommits).toHaveLength(1);

    const row = byName(rowsFor(fx.repo), 'local-delete');
    expect({disposition: row.disposition, provenSafe: row.provenSafe}).toEqual({
      disposition: 'review',
      provenSafe: false,
    });
    // Actionable: which path, on which ref, and the command to re-run.
    expect(row.why).toContain('content proof INCOMPLETE');
    expect(row.why).toContain('`d/foo` on main');
    expect(row.why).toContain('git ls-tree --full-tree main -- :(literal)d/foo');
    expect(row.why).toContain(`error: Could not read ${fx.missingTree}`);
  });

  test('the remote-only branch is refused too — the path that deletes a remote ref', () => {
    const sb = track(createSandbox());
    const fx = buildFixture(sb);

    const row = byName(rowsFor(fx.repo), 'origin/remote-delete');
    expect({
      isRemoteOnly: row.isRemoteOnly,
      provenSafe: row.provenSafe,
    }).toEqual({isRemoteOnly: true, provenSafe: false});

    // `archive-remote-branch` pushes an archive and then DELETES the remote
    // branch, so this is the assertion with teeth: the plan proposes no such
    // action for a branch whose deletion could not be verified.
    const plan = planFor(fx.repo);
    expect(plan.remote).toEqual([]);
    expect(plan.needsJudgment.map((a) => a.branch).sort()).toEqual([
      'local-delete',
      'origin/remote-delete',
    ]);
  });

  test('the provably-merged control is still merged, and still acted on', () => {
    const sb = track(createSandbox());
    const fx = buildFixture(sb);

    const row = byName(rowsFor(fx.repo), 'genuine-delete');
    expect({disposition: row.disposition, provenSafe: row.provenSafe}).toEqual({
      disposition: 'merged',
      provenSafe: true,
    });
    // Its verdict came from the per-file comparison (no patch-id matched), which
    // is the same code path the damaged branch went down.
    expect(row.why).toContain('already on main by content');

    const plan = planFor(fx.repo);
    expect(
      plan.safe
        .filter((a) => a.action === 'archive-local-branch')
        .map((a) => a.branch),
    ).toEqual(['genuine-delete']);
  });
});
