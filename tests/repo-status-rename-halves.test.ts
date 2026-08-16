/**
 * A RENAME IS TWO FACTS, and only one of them used to be checked
 * (home-base-qyu1.27).
 *
 * `changedPaths` took the POST-state path from an `R` record and discarded the
 * pre-state one — deliberately, under qyu1.26, whose subject was the framing of
 * the `-z` triplet rather than its meaning. The consequence is the same
 * false-`provenSafe` family this module keeps producing: a commit that renames
 * `old` -> `new` was reduced to the single claim "the baseline has `new`". A
 * baseline that took the ADD half and not the DELETE half — it has `new`,
 * byte-identical, and it STILL has `old` — satisfies that claim completely.
 * `allFilesReflected` -> `allContentOnBaseline` -> `merged` with
 * `provenSafe: true`, and `plan` offers to archive and delete the branch. What
 * is destroyed is not a file; it is the RECORD that `old` was supposed to be
 * gone. Nothing on the baseline says so any more.
 *
 * ── No corruption, and not even an unusual filename ─────────────────────────
 *
 * qyu1.24 needed a destroyed tree object. qyu1.26 needed a non-ASCII (or
 * trailing-space) filename. This needs NEITHER: the fixture is `git init`,
 * `git mv`, `cp`. The trigger is a baseline that took half of a rename, which is
 * exactly what a cherry-pick of the addition, a manual re-application, or a
 * conflict resolution that kept both sides leaves behind.
 *
 * ── What each block is for ──────────────────────────────────────────────────
 *
 *   1. the mechanism, measured at the git level: rename detection is ON for
 *      `git show` with the argv the product actually passes, and the baseline
 *      really does hold both halves
 *   2. the bug: the old path's deletion is checked, and the branch is refused
 *   3. the CONTROL, in the same repo: a rename the baseline took IN FULL still
 *      reads merged and still reaches `plan.safe`, so "refuse every rename"
 *      fails here
 *   4. the gauntlet: renames of hostile filenames go through the same `-z`
 *      parse, and both halves must survive it
 *   5. the `C` (copy) ruling, exercised through the product code: a copy does
 *      NOT imply the old path should be gone, and the copy source arrives with
 *      its own `M` record to prove it
 *   6. the measurement behind the post-state guard: only under `-B` — which the
 *      product does not pass — can one rename's OLD path be another's NEW path
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {execFileSync, spawnSync} from 'child_process';
import {copyFileSync, mkdirSync, writeFileSync} from 'fs';
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

function gitRun(cwd: string, args: string[]): {status: number; stdout: string} {
  const result = spawnSync('git', args, {cwd, encoding: 'utf-8'});
  return {status: result.status ?? -1, stdout: result.stdout ?? ''};
}

/** The exact argv `changedPaths` runs, so a test measures the real stream. */
const NAME_STATUS = ['-z', '--name-status', '--format=', '-m', '--first-parent'];

function nameStatus(cwd: string, sha: string, extra: string[] = []): string {
  return gitRun(cwd, ['show', ...NAME_STATUS, ...extra, sha]).stdout;
}

/**
 * A body long and distinctive enough that git pairs each file with its own
 * rename target and with nothing else in the same commit.
 */
function body(slug: string): string {
  return [
    `${slug}: a body long and distinctive enough that git pairs this file`,
    `${slug}: with its own rename target and with nothing else nearby`,
    `${slug}: line three, for similarity's sake`,
    '',
  ].join('\n');
}

function initRepo(sb: Sandbox, name: string): string {
  const repo = join(sb.path, name);
  mkdirSync(repo, {recursive: true});
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  return repo;
}

function write(repo: string, file: string, text: string): void {
  writeFileSync(join(repo, file), text);
}

function commit(repo: string, msg: string): string {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', msg]);
  return git(repo, ['rev-parse', 'HEAD']).trim();
}

function statuses(files: FileVerdict[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of files) out[file.path] = file.status;
  return out;
}

/** Every verdict that carries the rename annotation, path -> renamedTo. */
function annotations(files: FileVerdict[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of files) {
    if (file.renamedTo != null) out[file.path] = file.renamedTo;
  }
  return out;
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

function rowFor(repo: string, name: string): BranchRow {
  const row = reportFor(repo).branches?.find((r) => r.name === name);
  if (row == null) throw new Error(`no row for ${name}`);
  return row;
}

function planFor(repo: string): CleanupPlan {
  const plan = buildPlan(reportFor(repo));
  if (plan == null) throw new Error('expected a plan');
  return plan;
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/**
 * The qyu1.26 gauntlet, inherited whole: a rename of one of these spends the
 * same three `-z` records as any other rename, so BOTH of its paths now have to
 * survive the parse rather than just the second. `trailing space ` is the
 * pure-ASCII one that the pre-`-z` parser also mangled, and it is here for the
 * same reason it is there — the families that break are not only the exotic
 * ones. (The emoji is escaped only because it is outside the BMP and reads
 * badly in diffs.)
 */
const TRICKY = [
  'café.txt',
  '日本語.txt',
  'emoji\u{1f600}.txt',
  'with\ttab.txt',
  'with\nnewline.txt',
  'with"quote.txt',
  'with\\back.txt',
  'trailing space ',
  'with space.txt',
];

const GAUNTLET_SRC = 'gauntlet';
const GAUNTLET_DST = 'gauntlet-moved';

const srcPath = (name: string): string => `${GAUNTLET_SRC}/${name}`;
const dstPath = (name: string): string => `${GAUNTLET_DST}/${name}`;

interface Fixture {
  repo: string;
  /** `git mv kept-src -> kept-dst`; the baseline kept BOTH. The bug. */
  halfLostSha: string;
  /** `git mv moved-src -> moved-dst`; the baseline took the whole rename. */
  reflectedSha: string;
  /** Three hostile-named renames, all of whose old halves the baseline kept. */
  gauntletSha: string;
}

/**
 *   M0    anchor, moved-src, kept-src, gauntlet/<3 tricky>
 *   M1    edit anchor                                            (tag M1)
 *
 *   branches, each forked at M1 and each a single `git mv`:
 *     rename-reflected   moved-src  -> moved-dst
 *     rename-half-lost   kept-src   -> kept-dst
 *     rename-gauntlet    gauntlet/* -> gauntlet-moved/*
 *
 *   M2 (main, ONE commit, deliberately a DIFFERENT patch shape from every
 *       branch so `git cherry` matches none of them by patch-id and the verdict
 *       has to come from the per-file comparison — the code under test):
 *     git mv moved-src -> moved-dst      the whole rename, both halves
 *     cp kept-src kept-dst               the ADD half only; kept-src stays
 *     cp gauntlet/* gauntlet-moved/*     the ADD half only; the sources stay
 *     add also.txt                       what makes the patch differ
 *
 *   So on main every rename DESTINATION is byte-identical to the branch's, and
 *   that is the point: the new half is spotless for all three branches, so the
 *   only thing that can refuse `rename-half-lost` and `rename-gauntlet` is the
 *   old half. NOTHING here is corrupted.
 */
function buildFixture(sb: Sandbox): Fixture {
  const repo = initRepo(sb, 'repo');
  mkdirSync(join(repo, GAUNTLET_SRC), {recursive: true});

  write(repo, 'anchor.txt', 'anchor\n');
  write(repo, 'moved-src.txt', body('moved'));
  write(repo, 'kept-src.txt', body('kept'));
  for (const name of TRICKY) write(repo, srcPath(name), body(name));
  commit(repo, 'M0');

  // Every assertion below is a statement about these exact strings; a
  // filesystem that normalised or refused one would quietly make it a statement
  // about some other file (see the qyu1.26 note on `core.precomposeunicode`).
  const tracked = new Set(
    git(repo, ['ls-files', '-z'])
      .split('\0')
      .filter((p) => p.length > 0),
  );
  for (const name of TRICKY) {
    if (!tracked.has(srcPath(name))) {
      throw new Error(
        `fixture did not record ${JSON.stringify(srcPath(name))} — got ${JSON.stringify([...tracked])}`,
      );
    }
  }

  write(repo, 'anchor.txt', 'anchor edited on main\n');
  commit(repo, 'M1: edit anchor');
  git(repo, ['tag', 'M1']);

  const branchRenaming = (
    branch: string,
    moves: [string, string][],
  ): string => {
    git(repo, ['checkout', '-q', '-b', branch, 'M1']);
    for (const [from, to] of moves) git(repo, ['mv', from, to]);
    const sha = commit(repo, `${branch}: mv`);
    git(repo, ['checkout', '-q', 'main']);
    return sha;
  };

  const reflectedSha = branchRenaming('rename-reflected', [
    ['moved-src.txt', 'moved-dst.txt'],
  ]);
  const halfLostSha = branchRenaming('rename-half-lost', [
    ['kept-src.txt', 'kept-dst.txt'],
  ]);
  mkdirSync(join(repo, GAUNTLET_DST), {recursive: true});
  const gauntletSha = branchRenaming(
    'rename-gauntlet',
    TRICKY.map((name): [string, string] => [srcPath(name), dstPath(name)]),
  );

  // M2 — main takes one rename in full and the ADD half of every other.
  git(repo, ['mv', 'moved-src.txt', 'moved-dst.txt']);
  copyFileSync(join(repo, 'kept-src.txt'), join(repo, 'kept-dst.txt'));
  mkdirSync(join(repo, GAUNTLET_DST), {recursive: true});
  for (const name of TRICKY) {
    copyFileSync(join(repo, srcPath(name)), join(repo, dstPath(name)));
  }
  write(repo, 'also.txt', 'also\n');
  commit(repo, 'M2: take one rename in full, and only the add half of the rest');

  return {gauntletSha, halfLostSha, reflectedSha, repo};
}

// ---------------------------------------------------------------------------
// 1. The mechanism
// ---------------------------------------------------------------------------

describe('the premise: rename detection fires, and the baseline holds both halves', () => {
  test('the product argv already reports `R`, with no `-M` of its own', () => {
    const sb = track(createSandbox());
    const fx = buildFixture(sb);

    // `diff.renames` has defaulted to true since git 2.9, so the argv in
    // `changedPaths` gets rename records without asking for them. If that ever
    // changed, this whole bead's shape would arrive as a `D` plus an `A` — a
    // different (and already-correct) code path — and this test says so first.
    expect(nameStatus(fx.repo, fx.halfLostSha)).toBe(
      'R100\0kept-src.txt\0kept-dst.txt\0',
    );
  });

  test('the baseline has BOTH paths, and the new one is byte-identical', () => {
    const sb = track(createSandbox());
    const fx = buildFixture(sb);

    // This is the whole bug in three commands: everything the old code checked
    // (`main:kept-dst.txt` matches) is true, and the branch is still not safe to
    // delete, because of the fact it never asked about.
    expect(git(fx.repo, ['rev-parse', 'main:kept-dst.txt']).trim()).toBe(
      git(fx.repo, ['rev-parse', `${fx.halfLostSha}:kept-dst.txt`]).trim(),
    );
    expect(gitRun(fx.repo, ['rev-parse', 'main:kept-src.txt']).status).toBe(0);

    // And the control's old half really is gone from the baseline.
    expect(gitRun(fx.repo, ['rev-parse', 'main:moved-src.txt']).status).not.toBe(
      0,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. The bug
// ---------------------------------------------------------------------------

describe('a rename whose deletion half the baseline never took', () => {
  test('the old path is checked as a deletion, and it is not reflected', () => {
    const sb = track(createSandbox());
    const fx = buildFixture(sb);

    const files = verifyCommitFiles(fx.halfLostSha, 'main', fx.repo);
    // Before the fix this was `{'kept-dst.txt': 'identical'}` and nothing else.
    expect(statuses(files)).toEqual({
      'kept-dst.txt': 'identical',
      'kept-src.txt': 'deletion-not-reflected',
    });

    // The synthetic verdict names the OLD path — the file whose absence is
    // being asserted — and says which path it moved to, so a reader is not left
    // wondering why a path the commit's post-state does not contain is being
    // reported at all.
    expect(annotations(files)).toEqual({'kept-src.txt': 'kept-dst.txt'});
  });

  test('the branch is refused, and the plan proposes nothing for it', () => {
    const sb = track(createSandbox());
    const fx = buildFixture(sb);

    const proof = proveContentOnBaseline('rename-half-lost', 'main', fx.repo);
    expect(proof.allContentOnBaseline).toBe(false);

    // Reverting `content.ts` under this fixture puts `provenSafe` back to
    // `true` — that is the negative control, and it is the assertion below that
    // catches it. On a standalone probe of the same shape the full pre-fix
    // verdict measured as: disposition `merged`, provenSafe `true`, why "1
    // unique commit already on main by content — all changed files already
    // identical on the baseline", and `archive-local-branch ren` in `plan.safe`.
    const row = rowFor(fx.repo, 'rename-half-lost');
    expect(row.provenSafe).toBe(false);
    expect(row.disposition).not.toBe('merged');

    const plan = planFor(fx.repo);
    expect(plan.safe.map((a) => a.branch)).not.toContain('rename-half-lost');
    expect(plan.needsJudgment.map((a) => a.branch)).toContain(
      'rename-half-lost',
    );
  });
});

// ---------------------------------------------------------------------------
// 3. The control — a fix that refuses every rename fails here
// ---------------------------------------------------------------------------

describe('a rename the baseline took IN FULL is still merged', () => {
  test('both halves answer positively, and the branch reaches plan.safe', () => {
    const sb = track(createSandbox());
    const fx = buildFixture(sb);

    const files = verifyCommitFiles(fx.reflectedSha, 'main', fx.repo);
    expect(statuses(files)).toEqual({
      'moved-dst.txt': 'identical',
      'moved-src.txt': 'deletion-reflected',
    });

    const row = rowFor(fx.repo, 'rename-reflected');
    expect({disposition: row.disposition, provenSafe: row.provenSafe}).toEqual({
      disposition: 'merged',
      provenSafe: true,
    });
    expect(
      planFor(fx.repo)
        .safe.filter((a) => a.action === 'archive-local-branch')
        .map((a) => a.branch),
    ).toContain('rename-reflected');
  });

  test('the annotation is the only new key, and only the deletion half has it', () => {
    const sb = track(createSandbox());
    const fx = buildFixture(sb);

    const files = verifyCommitFiles(fx.reflectedSha, 'main', fx.repo);
    const keys = Object.fromEntries(
      files.map((f) => [f.path, Object.keys(f).sort()]),
    );
    // The post-state verdict is byte-for-byte what it has always been. Only the
    // half that did not exist before carries the new key — the same conditional
    // -key discipline `unreadable` follows, and what keeps a repo whose unique
    // commits contain no renames byte-identical to before this change.
    expect(keys).toEqual({
      'moved-dst.txt': ['path', 'status'],
      'moved-src.txt': ['path', 'renamedTo', 'status'],
    });
  });
});

// ---------------------------------------------------------------------------
// 4. The gauntlet — both halves through the `-z` parse
// ---------------------------------------------------------------------------

describe('hostile filenames survive on BOTH sides of a rename', () => {
  test('every family answers deletion-not-reflected under its real spelling', () => {
    const sb = track(createSandbox());
    const fx = buildFixture(sb);

    const files = verifyCommitFiles(fx.gauntletSha, 'main', fx.repo);
    const expected: Record<string, string> = {};
    for (const name of TRICKY) {
      expected[dstPath(name)] = 'identical';
      expected[srcPath(name)] = 'deletion-not-reflected';
    }
    // The assertion is on the WHOLE map, so an old path arriving C-quoted
    // (`"gauntlet/caf\303\251.txt"`) fails as a missing key rather than passing
    // as some other file's absence.
    expect(statuses(files)).toEqual(expected);

    const annotated: Record<string, string> = {};
    for (const name of TRICKY) annotated[srcPath(name)] = dstPath(name);
    expect(annotations(files)).toEqual(annotated);

    expect(rowFor(fx.repo, 'rename-gauntlet').provenSafe).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. The `C` ruling
// ---------------------------------------------------------------------------

/**
 * A COPY IS NOT A RENAME, and the difference is the whole ruling: `R` means the
 * old path is GONE, `C` means it is still there. Synthesising a deletion check
 * for a `C` record's old path would assert the absence of a path the commit
 * deliberately kept — and git says so in the same breath, because the copy
 * SOURCE arrives with its own `M` record right after the triplet. So `C` keeps
 * the behaviour it has always had: the new path is checked, and nothing else.
 *
 * This is not merely a safety-preserving choice. Getting it wrong here would
 * degrade toward refusal rather than toward a false `provenSafe` — but it would
 * still be wrong, and the fixture below is built so the wrong ruling changes the
 * OUTCOME: the copy source is identical on the baseline, so a bogus deletion
 * check turns a genuinely-merged branch into `needs-judgment`.
 *
 * Copy detection is off by default (`diff.renames` is `true`, not `copies`), so
 * the fixture turns it on in the repo's own config — which the product code
 * picks up, because it shells out to `git show` in that repo. The `C` records
 * here are produced by the real invocation, not by a hand-built stream.
 */
describe('a copy does not imply the old path should be gone', () => {
  function buildCopyFixture(sb: Sandbox): {repo: string; sha: string} {
    const repo = initRepo(sb, 'copy-repo');
    git(repo, ['config', 'diff.renames', 'copies']);

    const v1 = body('src');
    const v2 = `${v1}src: one more line, so the source counts as modified\n`;

    write(repo, 'src.txt', v1);
    commit(repo, 'M0');

    // Copy detection only considers files modified in the SAME commit as
    // sources, so the copy and the edit have to travel together.
    git(repo, ['checkout', '-q', '-b', 'copied', 'main']);
    copyFileSync(join(repo, 'src.txt'), join(repo, 'copy.txt'));
    write(repo, 'src.txt', v2);
    const sha = commit(repo, 'copied: copy src, modify src');
    git(repo, ['checkout', '-q', 'main']);

    // Main reaches the same two blobs by a different patch shape, so `git
    // cherry` finds no patch-id match and the per-file comparison runs.
    write(repo, 'copy.txt', v1);
    write(repo, 'src.txt', v2);
    write(repo, 'extra.txt', 'extra\n');
    commit(repo, 'M1: same content, different patch');

    return {repo, sha};
  }

  test('git really emits a `C` triplet plus an `M` for the source', () => {
    const sb = track(createSandbox());
    const fx = buildCopyFixture(sb);

    // Pinned so that a git whose copy detection changed shape announces itself
    // here, rather than silently turning this into a test about an `A` record.
    expect(nameStatus(fx.repo, fx.sha)).toBe(
      'C100\0src.txt\0copy.txt\0M\0src.txt\0',
    );
  });

  test('the copy source is judged as a live path, never as a deletion', () => {
    const sb = track(createSandbox());
    const fx = buildCopyFixture(sb);

    const files = verifyCommitFiles(fx.sha, 'main', fx.repo);
    expect(statuses(files)).toEqual({
      'copy.txt': 'identical',
      'src.txt': 'identical',
    });
    // No verdict claims a rename, because none happened.
    expect(annotations(files)).toEqual({});

    // And the ruling is load-bearing: a deletion check on `src.txt` would read
    // `deletion-not-reflected` (main has it, by design) and refuse this branch.
    const row = rowFor(fx.repo, 'copied');
    expect({disposition: row.disposition, provenSafe: row.provenSafe}).toEqual({
      disposition: 'merged',
      provenSafe: true,
    });
  });
});

// ---------------------------------------------------------------------------
// 6. The measurement behind the post-state guard
// ---------------------------------------------------------------------------

/**
 * `changedPaths` skips the synthetic deletion when the old path is ALSO some
 * record's post-state path. That guard exists because the alternative is
 * asserting the absence of a path the commit leaves behind — and the shape is
 * real, not imagined, as the second expectation below measures.
 *
 * It is NOT reachable through the product's own argv, and that is worth stating
 * plainly rather than implying otherwise: git pairs a rename only from a source
 * it saw DELETED, so with the flags `changedPaths` passes, an `R` old path is
 * absent from the post-state by construction. Break-rewrite detection (`-B`) is
 * what manufactures the exception, there is no config that turns it on for
 * `git show`, and the product never passes it. The guard is therefore correct
 * ORDER-INDEPENDENTLY for a stream this code could receive, at the cost of one
 * Set — cheap insurance against a future flag, and this test is the record of
 * why it is there.
 */
describe('an old path that is also a post-state path', () => {
  /**
   * Break detection has a SIZE FLOOR, measured on git 2.50.1: with these lines
   * at 3 and at 6 lines (120 and 240 bytes) `-B` declines to break the rewrite
   * and the shape below never appears; at 12 lines (483 bytes) it does. So the
   * body length here is load-bearing, not decoration.
   */
  function bulkBody(slug: string): string {
    return (
      Array.from(
        {length: 12},
        (_, i) => `${slug} line ${i + 1} distinctive filler text here`,
      ).join('\n') + '\n'
    );
  }

  function buildRotation(sb: Sandbox): {repo: string; sha: string} {
    const repo = initRepo(sb, 'rotate');
    write(repo, 'a.txt', bulkBody('AAA'));
    write(repo, 'c.txt', bulkBody('CCC'));
    commit(repo, 'M0');
    // On a BRANCH, so `main` stays at M0 and is a real baseline to compare to.
    git(repo, ['checkout', '-q', '-b', 'rotated']);
    git(repo, ['mv', 'a.txt', 'b.txt']);
    git(repo, ['mv', 'c.txt', 'a.txt']);
    const sha = commit(repo, 'rotate: a->b, c->a');
    git(repo, ['checkout', '-q', 'main']);
    return {repo, sha};
  }

  test('the product argv never produces one; `-B` does', () => {
    const sb = track(createSandbox());
    const fx = buildRotation(sb);

    // What `changedPaths` actually receives: no rename at all. `a.txt` exists on
    // both sides, so there is no deletion for git to pair, and the records are a
    // plain modify/add/delete.
    expect(nameStatus(fx.repo, fx.sha)).toBe('M\0a.txt\0A\0b.txt\0D\0c.txt\0');

    // With break-rewrites, the same commit becomes two renames — and `a.txt` is
    // the OLD path of the second while being the NEW path of the first.
    expect(nameStatus(fx.repo, fx.sha, ['-B', '-M'])).toBe(
      'R100\0c.txt\0a.txt\0R100\0a.txt\0b.txt\0',
    );
  });

  test('the verdicts for the shape the product does see are the ordinary ones', () => {
    const sb = track(createSandbox());
    const fx = buildRotation(sb);

    const files = verifyCommitFiles(fx.sha, 'main', fx.repo);
    expect(statuses(files)).toEqual({
      'a.txt': 'differs',
      'b.txt': 'absent-on-baseline',
      'c.txt': 'deletion-not-reflected',
    });
    expect(annotations(files)).toEqual({});
  });
});
