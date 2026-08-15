/**
 * `behind === 0` <=> the merge is a fast-forward — proved against git itself.
 *
 * The report has always carried the two numbers that settle this and never
 * carried the conclusion, so sessions kept re-deriving it with `git merge-base
 * --is-ancestor` (home-base-qyu1.19). These tests exist to make the derived
 * field trustworthy enough that nobody has to:
 *
 *  - THE ORACLE TEST is the load-bearing one. It does not check the field
 *    against a hand-written expectation of what the numbers should be; it runs
 *    the real `git merge-base --is-ancestor` on every branch in the fixture and
 *    requires that git's answer and `behind === 0` agree, row for row. An
 *    arithmetic slip cannot pass it, and neither could a future change to how
 *    ahead/behind is counted.
 *  - THE SQUASH-MERGE case is the one where ahead-only intuition fails: the
 *    branch's work is entirely on the baseline (disposition `merged`) and the
 *    branch STILL cannot be fast-forwarded, because the squash commit exists
 *    only on the baseline. Both facts have to be reported, and they are
 *    reported by different fields.
 *  - THE CONTAINED case is why the field has three states rather than being a
 *    boolean over `behind`: a branch with nothing to merge is "Already up to
 *    date" no matter how far behind it is, and calling that `merge-needed`
 *    would be exactly the confusion this field exists to end.
 *  - THE NO-SUBPROCESS test drives the shipped CLI behind a `git` that records
 *    every argv it receives, and requires that no `merge-base` runs at all. The
 *    field is arithmetic on numbers already computed; if it ever quietly
 *    becomes another git call, this fails.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {execFileSync, spawnSync} from 'child_process';
import {chmodSync, mkdirSync, readFileSync, writeFileSync} from 'fs';
import {join} from 'path';

import {describeMergeShape} from '../src/repo-status/merge-shape';
import {buildReport, type BranchRow} from '../src/repo-status/report';
import {createSandbox, type Sandbox} from './sandbox';

const CLI = join(import.meta.dir, '../src/repo-status/repo-status.ts');

/** ASCII unit/record separators — forbidden in git ref names, so unambiguous. */
const UNIT = '';
const RECORD = '';

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

function commit(sb: Sandbox, file: string, body: string, msg: string): void {
  writeFileSync(join(sb.path, file), body);
  git(sb.path, ['add', file]);
  git(sb.path, ['commit', '-q', '-m', msg]);
}

/**
 * One repo holding every merge shape at once.
 *
 *   main       C0 -- squashed(C0's work) -- M2
 *   contained  C0                                   (ahead 0, behind 2)
 *   squashed   C0 -- S1                             (ahead 1, behind 2)
 *   diverged   C0 -- squashed -- D1                 (ahead 1, behind 1)
 *   ff-able    C0 -- squashed -- M2 -- F1           (ahead 1, behind 0)
 */
function buildFixture(sb: Sandbox): void {
  git(sb.path, ['init', '-q', '-b', 'main']);
  git(sb.path, ['config', 'user.email', 'test@example.com']);
  git(sb.path, ['config', 'user.name', 'Test']);
  commit(sb, 'README.md', 'hello\n', 'initial');
  const base = git(sb.path, ['rev-parse', 'HEAD']);

  // Squash-merged: its content lands on main under a NEW sha, so main gains a
  // commit the branch will never have. `merged` by content, un-fast-forwardable.
  git(sb.path, ['checkout', '-q', '-b', 'squashed']);
  commit(sb, 'squashed.txt', 'squashed work\n', 'squashed work');
  git(sb.path, ['checkout', '-q', 'main']);
  git(sb.path, ['merge', '--squash', 'squashed']);
  git(sb.path, ['commit', '-q', '-m', 'squash-merge squashed']);

  // Genuinely diverged: real work on the branch, unrelated progress on main.
  git(sb.path, ['checkout', '-q', '-b', 'diverged']);
  commit(sb, 'diverged.txt', 'unmerged work\n', 'diverged work');
  git(sb.path, ['checkout', '-q', 'main']);
  commit(sb, 'main.txt', 'main moved\n', 'main moves on');

  // Strictly ahead: branched from the current main tip and never left behind.
  git(sb.path, ['checkout', '-q', '-b', 'ff-able']);
  commit(sb, 'ff.txt', 'ff work\n', 'ff work');
  git(sb.path, ['checkout', '-q', 'main']);

  // Contained: pinned at the original commit, so it holds nothing main lacks
  // while being two commits behind it.
  git(sb.path, ['branch', 'contained', base]);
}

function rowsFor(sb: Sandbox): {baselineRef: string; rows: BranchRow[]} {
  const report = buildReport({
    content: true,
    cwd: sb.path,
    prs: false,
    sinceDays: null,
    submodules: false,
  });
  if (report == null) throw new Error('expected a report');
  return {baselineRef: report.repo.baselineRef, rows: report.branches};
}

function byName(rows: BranchRow[], name: string): BranchRow {
  const row = rows.find((r) => r.name === name);
  if (row == null) throw new Error(`no row for ${name}`);
  return row;
}

/** git's own answer to "is <baseline> an ancestor of <branch>?" */
function isAncestor(cwd: string, baseline: string, branch: string): boolean {
  const result = spawnSync(
    'git',
    ['merge-base', '--is-ancestor', baseline, branch],
    {cwd, stdio: 'ignore'},
  );
  return result.status === 0;
}

describe('merge shape agrees with git', () => {
  test('behind === 0 is exactly "the baseline is an ancestor", every row', () => {
    const sb = track(createSandbox());
    buildFixture(sb);
    const {baselineRef, rows} = rowsFor(sb);
    expect(rows).toHaveLength(4);

    for (const row of rows) {
      const ancestor = isAncestor(sb.path, baselineRef, row.name);
      // The equivalence the field is built on, checked against git rather than
      // against a restatement of the arithmetic.
      expect({branch: row.name, equal: row.behind === 0}).toEqual({
        branch: row.name,
        equal: ancestor,
      });
      // ...and the field says "fast-forward" on exactly those rows that have
      // something to merge AND sit on top of the baseline.
      expect({
        branch: row.name,
        ff: row.mergeShape.kind === 'fast-forward',
      }).toEqual({branch: row.name, ff: ancestor && row.ahead > 0});
    }
  });

  test('every row carries a shape, and every shape matches its counts', () => {
    const sb = track(createSandbox());
    buildFixture(sb);
    const {rows} = rowsFor(sb);

    expect(
      Object.fromEntries(rows.map((r) => [r.name, r.mergeShape.kind])),
    ).toEqual({
      contained: 'already-up-to-date',
      diverged: 'merge-needed',
      'ff-able': 'fast-forward',
      squashed: 'merge-needed',
    });
    for (const row of rows) {
      expect(row.mergeShape.question).toContain('fast-forward');
      expect(row.mergeShape.why.length).toBeGreaterThan(0);
    }
  });
});

describe('the cases where the numbers mislead', () => {
  test('a SQUASH-merged branch is `merged` and still needs a real merge', () => {
    const sb = track(createSandbox());
    buildFixture(sb);
    const row = byName(rowsFor(sb).rows, 'squashed');

    // Content says the work is safely on main...
    expect(row.disposition).toBe('merged');
    expect(row.provenSafe).toBe(true);
    // ...while the shas say main is not an ancestor of it, so there is no
    // fast-forward available. Ahead-only intuition ("it's merged, so merging is
    // trivial") is wrong here, which is why both fields exist.
    expect(row.ahead).toBeGreaterThan(0);
    expect(row.behind).toBeGreaterThan(0);
    expect(row.mergeShape.kind).toBe('merge-needed');
    expect(isAncestor(sb.path, 'main', 'squashed')).toBe(false);
  });

  test('a fully-contained branch is "already up to date", however far behind', () => {
    const sb = track(createSandbox());
    buildFixture(sb);
    const row = byName(rowsFor(sb).rows, 'contained');

    expect(row.ahead).toBe(0);
    expect(row.behind).toBeGreaterThan(0);
    // Behind > 0 does NOT mean a merge commit here: there is nothing to merge.
    expect(row.mergeShape.kind).toBe('already-up-to-date');
    expect(row.mergeShape.why).toContain('Already up to date');
    expect(row.mergeShape.why).toContain('MISSING');
  });

  test('a genuinely diverged branch names the merge commit it would cost', () => {
    const sb = track(createSandbox());
    buildFixture(sb);
    const row = byName(rowsFor(sb).rows, 'diverged');

    expect(row.disposition).toBe('needs-judgment');
    expect(row.mergeShape.kind).toBe('merge-needed');
    expect(row.mergeShape.why).toContain('merge commit');
    expect(row.mergeShape.why).toContain('main');
  });
});

describe('describeMergeShape', () => {
  test('maps counts to shapes without touching a repo at all', () => {
    // No cwd is passed and none exists to pass: the shape is arithmetic on two
    // numbers, so it answers even for a ref name that resolves nowhere.
    expect(describeMergeShape({ahead: 3, behind: 0}, 'no-such-ref').kind).toBe(
      'fast-forward',
    );
    expect(describeMergeShape({ahead: 3, behind: 2}, 'no-such-ref').kind).toBe(
      'merge-needed',
    );
    expect(describeMergeShape({ahead: 0, behind: 9}, 'no-such-ref').kind).toBe(
      'already-up-to-date',
    );
    // Identical tips: still nothing to merge.
    expect(describeMergeShape({ahead: 0, behind: 0}, 'no-such-ref').kind).toBe(
      'already-up-to-date',
    );
  });

  test('the wording names the baseline and the question, not just a verdict', () => {
    const shape = describeMergeShape({ahead: 1, behind: 0}, 'origin/trunk');
    expect(shape.question).toBe(
      'if I merge this branch into the baseline, does it fast-forward or does it need a merge commit?',
    );
    expect(shape.why).toContain('origin/trunk is an ancestor of this branch');
  });
});

// ---------------------------------------------------------------------------
// Rendering + cost, through the shipped CLI
// ---------------------------------------------------------------------------

/**
 * A `git` that records the argv it was handed and then hands off to the real
 * one, so a real `status` runs while every invocation is captured verbatim.
 * (Same device as the command-drift suite: env mutated inside a bun test does
 * not reach child processes, so the shim goes on a SUBPROCESS's PATH and its
 * log path is baked into the script.)
 */
function installGitShim(sb: Sandbox): {
  dir: string;
  invocations: () => string[][];
} {
  const dir = join(sb.path, 'shim');
  mkdirSync(dir, {recursive: true});
  const log = join(sb.path, 'git-argv.log');
  writeFileSync(log, '');
  const realGit = execFileSync('which', ['git'], {encoding: 'utf-8'}).trim();
  writeFileSync(
    join(dir, 'git'),
    [
      '#!/bin/sh',
      `for a in "$@"; do printf '%s\\037' "$a" >> '${log}'; done`,
      `printf '\\036' >> '${log}'`,
      `exec '${realGit}' "$@"`,
      '',
    ].join('\n'),
  );
  chmodSync(join(dir, 'git'), 0o755);
  return {
    dir,
    invocations: () =>
      readFileSync(log, 'utf-8')
        .split(RECORD)
        .filter((record) => record.length > 0)
        .map((record) => record.split(UNIT).slice(0, -1)),
  };
}

function runStatus(
  repo: string,
  shimDir: string,
  extra: string[],
): {out: string; status: number} {
  const result = spawnSync(
    'bun',
    [CLI, 'status', '--repo', repo, '--no-prs', '--no-submodules', ...extra],
    {
      encoding: 'utf-8',
      env: {...process.env, PATH: `${shimDir}:${process.env.PATH ?? ''}`},
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  return {out: result.stdout ?? '', status: result.status ?? -1};
}

describe('the shape rides the typed object', () => {
  test('renders in JSON and YAML, and costs no extra git call', () => {
    const sb = track(createSandbox());
    buildFixture(sb);
    const shim = installGitShim(sb);

    const json = runStatus(sb.path, shim.dir, ['--json']);
    expect(json.status).toBe(0);
    const parsed = JSON.parse(json.out) as {branches: BranchRow[]};
    expect(
      Object.fromEntries(
        parsed.branches.map((r) => [r.name, r.mergeShape.kind]),
      ),
    ).toEqual({
      contained: 'already-up-to-date',
      diverged: 'merge-needed',
      'ff-able': 'fast-forward',
      squashed: 'merge-needed',
    });

    const yaml = runStatus(sb.path, shim.dir, []);
    expect(yaml.status).toBe(0);
    expect(yaml.out).toContain('mergeShape:');
    expect(yaml.out).toContain('kind: fast-forward');
    expect(yaml.out).toContain('question:');

    // The whole point: the conclusion is read off numbers the report already
    // had. Both runs above, and not one `merge-base` between them.
    const merges = shim
      .invocations()
      .filter((argv) => argv[0] === 'merge-base');
    expect(merges).toEqual([]);
  });
});
