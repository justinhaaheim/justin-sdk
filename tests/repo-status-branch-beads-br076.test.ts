/**
 * repo-status's "Open beads only on this branch", once br shares one DB
 * across a repo's worktrees (home-base-dj5m9.1.5, item 3).
 *
 * DECIDED (conductor, 2026-10-29): the list stays for the transition, because
 * old branches still carry their own committed issues.jsonl. What must not
 * happen: a checkout with no DB of its own, under a br that shares the
 * primary's DB, shown as having branch-only beads only because its committed
 * export is older than that DB.
 *
 * THE FIXTURE. A real git repo and a real br (mise's installed 0.7.6 or
 * 0.1.37, first on PATH for its own test). Bead A is created in the primary's
 * DB and committed; branch `feat` is cut in a linked worktree with no DB of
 * its own. Then bead X is created in the primary's DB and NOT committed on
 * main, the way a bead the flip imported from an old worktree's DB sits in
 * main's DB before main commits its export. `feat` commits an export holding
 * A, X (open) and Y, an open bead that exists nowhere else.
 *   - br 0.7.6: X is in the DB `feat` uses, so only Y is branch-only.
 *   - br 0.1.37: `feat` has no DB of its own and does not share the
 *     primary's, so the list is what it always was: X and Y.
 *
 * Every repo is under $TMPDIR; nothing here touches a real beads DB.
 *
 * NEGATIVE CONTROL (run by hand, recorded on home-base-dj5m9.1.5): drop
 * `sharedIds = shared.ids` in readCheckoutFacts and the 0.7.6 test fails
 * with X listed beside Y.
 */

import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, test} from 'bun:test';
import {readFileSync} from 'fs';
import {join} from 'path';

import {brCreate, runBr} from '../src/beads/br';
import {buildReport} from '../src/repo-status/report';
import {addLinkedWorktree, git, initRepo, write} from './git-fixtures';
import {installedBr, underInstalledBr} from './pinned-br';
import {createSandbox} from './sandbox';

const TAG = '[TEST_DATA_DELETABLE c3544428-ba57-47be-a2ea-134a46f1ef9b ]';
const ONLY_ON_BRANCH = 't-onlyonbranch';

const BR_076 = installedBr('0.7.6');
const BR_0137 = installedBr('0.1.37');
for (const br of [BR_076, BR_0137]) {
  if (br.kind !== 'installed') {
    console.warn(
      `SKIPPED: a per-version test in repo-status-branch-beads-br076.test.ts did NOT run (${br.reason})`,
    );
  }
}

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

function created(outcome: ReturnType<typeof brCreate>): string {
  if (outcome.kind !== 'ok') throw new Error(outcome.reason);
  return outcome.id;
}

/** See the header. Call it under the br the test is about. */
function branchOnlyIds(): {ids: string[]; x: string} {
  const sb = createSandbox();
  sandboxes.push(sb);
  const primary = initRepo(sb, 'repo', {'README.md': '# repo\n'});
  const init = runBr(primary, ['init', '--prefix', 't', '-q']);
  if (!init.ok) throw new Error(`br init failed: ${init.reason ?? '?'}`);
  created(
    brCreate({cwd: primary}, {priority: 2, title: `A ${TAG}`, type: 'task'}),
  );
  git(primary, ['add', '-A']);
  git(primary, ['commit', '-qm', 'bead A']);
  const feat = addLinkedWorktree(primary, join(sb.path, 'feat-wt'), 'feat');

  // In the primary's DB only: not committed on main.
  const x = created(
    brCreate({cwd: primary}, {priority: 2, title: `X ${TAG}`, type: 'task'}),
  );
  const live = readFileSync(join(primary, '.beads', 'issues.jsonl'), 'utf-8');
  const xLine = live.split('\n').find((line) => line.includes(`"${x}"`));
  if (xLine == null) throw new Error(`${x} is not in the primary's export`);

  const committedOnMain = git(primary, ['show', 'HEAD:.beads/issues.jsonl']);
  write(
    feat,
    '.beads/issues.jsonl',
    [
      committedOnMain.trimEnd(),
      xLine,
      JSON.stringify({
        id: ONLY_ON_BRANCH,
        status: 'open',
        title: `only on the branch ${TAG}`,
      }),
      '',
    ].join('\n'),
  );
  git(feat, ['add', '.beads/issues.jsonl']);
  git(feat, ['commit', '-qm', 'branch beads']);

  const report = buildReport({
    checkouts: true,
    cwd: primary,
    prs: false,
    submodules: false,
  });
  const row = report?.checkouts?.checkouts?.find((c) => c.branch === 'feat');
  if (row == null) throw new Error('no checkout row for feat');
  if (row.branchOnlyBeads?.kind !== 'measured') {
    throw new Error(
      `branch-only beads not measured: ${JSON.stringify(row.branchOnlyBeads)}; failures: ${row.failures.join(' | ')}`,
    );
  }
  return {ids: row.branchOnlyBeads.beads.map((bead) => bead.id).sort(), x};
}

describe('branch-only beads by br version', () => {
  test.skipIf(BR_076.kind !== 'installed')(
    'br 0.7.6: a bead the shared DB holds is not branch-only, though main has not committed it',
    async () => {
      const {ids, x} = await underInstalledBr(BR_076, branchOnlyIds);
      expect(ids).not.toContain(x);
      expect(ids).toEqual([ONLY_ON_BRANCH]);
    },
    60_000,
  );

  test.skipIf(BR_0137.kind !== 'installed')(
    'br 0.1.37: unchanged — the baseline commit alone decides',
    async () => {
      const {ids, x} = await underInstalledBr(BR_0137, branchOnlyIds);
      expect(ids).toEqual([x, ONLY_ON_BRANCH].sort());
    },
    60_000,
  );
});
