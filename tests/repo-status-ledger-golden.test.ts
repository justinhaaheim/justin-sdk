/**
 * The DEFAULT `repo-status status` ledger, byte for byte, on a fixed fixture.
 *
 * home-base-39co9.5 AC4: the checkout facts and the sessions view joined
 * repo-status as opt-in flags, and the default ledger had to stay exactly what
 * it was. Session start, conductors and Justin all read this output, so a
 * change to it has to be a decision someone made and wrote down, never a side
 * effect of adding a section somewhere else.
 *
 * This test was written and run green BEFORE the 39co9.5 changes, so its
 * expected text IS the pre-change output. The only things masked are the two
 * that cannot be fixed by a fixture: the temp directory's path and the
 * `Generated:` wall-clock line. Every commit is dated in 2099 (and the CLI runs
 * in UTC), which keeps the 90-day filter from hiding anything and keeps every
 * date column stable for the next seventy years.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {execFileSync, spawnSync} from 'child_process';
import {mkdirSync, realpathSync, writeFileSync} from 'fs';
import {dirname, join} from 'path';

import {createSandbox, type Sandbox} from './sandbox';

const CLI = join(import.meta.dir, '../src/repo-status/repo-status.ts');

const sandboxes: Sandbox[] = [];
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

const FIXED_ENV = {
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_AUTHOR_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
};

let clock = 0;

function git(cwd: string, args: string[]): string {
  // Each call that might write a commit gets the next fixed minute, so every
  // sha and every date in the fixture is the same on every run.
  clock += 1;
  const date = `2099-01-01T00:${String(clock).padStart(2, '0')}:00Z`;
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      ...FIXED_ENV,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
    stdio: 'pipe',
  }).trim();
}

function commit(repo: string, file: string, body: string, msg: string): void {
  writeFileSync(join(repo, file), body);
  git(repo, ['add', '--', file]);
  git(repo, ['commit', '-q', '-m', msg]);
}

/**
 * main, an unmerged branch checked out in a worktree with an uncommitted file,
 * a branch merged by fast-forward, a squash-merged branch (merged by content,
 * not by identity), and an archive/ mirror the default filter hides.
 */
function buildFixture(sb: Sandbox): string {
  clock = 0;
  // The repo and its worktree are SIBLINGS, so the worktree's files never
  // show up as untracked in the primary checkout.
  const repo = join(sb.path, 'repo');
  mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  commit(repo, 'shared.txt', 'original\n', 'initial');

  git(repo, ['checkout', '-q', '-b', 'feature']);
  commit(repo, 'feature.txt', 'feature\n', 'feature work');

  git(repo, ['checkout', '-q', '-b', 'squashed', 'main']);
  commit(repo, 'squash.txt', 'one\n', 'squash part one');
  commit(repo, 'squash.txt', 'one\ntwo\n', 'squash part two');

  git(repo, ['checkout', '-q', '-b', 'archive/old', 'main']);
  commit(repo, 'old.txt', 'old\n', 'old work');

  git(repo, ['checkout', '-q', 'main']);
  git(repo, ['merge', '-q', '--squash', 'squashed']);
  git(repo, ['commit', '-q', '-m', 'squash-merge squashed']);
  git(repo, ['branch', '-q', 'landed', 'main']);
  commit(repo, 'main.txt', 'main\n', 'main moves on');

  const wt = join(sb.path, 'wt-feature');
  git(repo, ['worktree', 'add', '-q', wt, 'feature']);
  writeFileSync(join(wt, 'scratch.txt'), 'not committed\n');
  return repo;
}

function ledger(repo: string, extra: string[] = []): string {
  const result = spawnSync(
    'bun',
    [CLI, 'status', '--no-prs', '--repo', repo, ...extra],
    {
      encoding: 'utf-8',
      env: {...process.env, NO_COLOR: '1', TZ: 'UTC'},
    },
  );
  if (result.status !== 0) {
    throw new Error(`repo-status exited ${result.status}: ${result.stderr}`);
  }
  const root = dirname(repo);
  const real = realpathSync(root);
  return result.stdout
    .replaceAll(real, '<sandbox>')
    .replaceAll(root, '<sandbox>')
    .replace(/^Generated: .*$/mu, 'Generated: <now>');
}

const EXPECTED = `REPO STATUS
Repo:      <sandbox>/repo
Branch:    main  (no upstream)
Baseline:  main @ ba5596b  AHEAD = commits the branch has and this does not; BEHIND = the reverse
Remote refs: NO fetch recorded in this checkout — any BEHIND against an origin/* ref is against refs that were never refreshed here
Uncommitted here: none
Generated: <now>

3 of 4 branches shown
    2  unmerged work
    1  already merged

1 branch hidden
    1  on an archive/ backup branch
       1 of the 1 hidden branch carries commits not on main (checked by patch-id only — nothing else about them was inspected; \`--all\` shows them)

UNMERGED WORK (2 shown, 1 more hidden)
commits that are on these branches and not on main

  BRANCH    AHEAD  BEHIND  FILES  LAST WORK          ALSO ON       
  squashed      2       2      1  2099-01-01 00:11   THIS DISK ONLY
      squash part two
      merges into main cleanly (writes a merge commit)
      1 commit exists only here (AHEAD 2 = 1 not on main + 1 already on main by content) — not on main, and no archive/ backup branch holds it

  feature       1       2      1  2099-01-01 00:06   THIS DISK ONLY
      in <sandbox>/wt-feature [UNCOMMITTED]
      feature work
      merges into main cleanly (writes a merge commit)
      1 uncommitted path in its checkout: scratch.txt — it is on NO branch and no commit holds it
      1 commit exists only here — not on main, and no archive/ backup branch holds it

ALREADY MERGED (1)
every COMMIT is already on main (by content, so squash-merges and rebases count)

  BRANCH    AHEAD  BEHIND  FILES  LAST WORK          ALSO ON       
  landed        0       1      —  2099-01-01 00:17*  —

WHAT WAS AND WAS NOT CHECKED
LAST WORK is the newest non-merge commit the branch has and the baseline does not — merging main into a branch moves its tip without advancing it. A \`*\` marks a row with no such commit, showing the tip date instead.
Cross-branch overlap: compared 2 branches by changed files over 1 pair; 0 pairs share a file, and 0 pairs were merge-checked against each other.
PR state: NOT checked (not requested) — pass \`--prs\`. Absent PR data is not the absence of a PR.
`;

describe('the default repo-status ledger (39co9.5 AC4)', () => {
  test('is byte-identical to the pre-39co9.5 output on a fixed fixture', () => {
    const sb = createSandbox();
    sandboxes.push(sb);
    const repo = buildFixture(sb);
    const actual = ledger(repo);
    // The explicit update path: GOLDEN_DUMP=<file> writes what the ledger
    // printed, for a person to review and paste in. A run never rewrites the
    // expected text by itself.
    const dump = process.env.GOLDEN_DUMP;
    if (dump != null && dump !== '') writeFileSync(dump, actual);
    expect(actual).toBe(EXPECTED);
  });
});
