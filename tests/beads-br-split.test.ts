/**
 * A linked worktree and its primary checkout that run DIFFERENT brs
 * (home-base-dj5m9.1.6 F1).
 *
 * `findBeadsWorkspace` decides from the worktree's br whether the worktree
 * shares the primary's DB, but every `{db}` call runs in the primary's root
 * (`cwdForDb`), where mise runs the PRIMARY's pin. When the two disagree, the
 * SDK resolved the primary's DB and drove it with a br that disagrees, and
 * doctor's BR_DB probe ran the worktree's br against it. Now that is `failed`
 * with `brSplit`, and doctor fails without probing.
 *
 * Two real brs, picked by cwd (tests/br-by-cwd.ts), in throwaway repos under
 * $TMPDIR. Both directions, plus the two agreeing pairs as controls.
 *
 * NEGATIVE CONTROL (run by hand, recorded on home-base-dj5m9.1.6): drop the
 * primary's br from `primaryDbForWorktree` (`runs = null`) → both split tests
 * fail: the 0.7.6 worktree finds the 0.1.37 primary's DB (`found`), and the
 * 0.1.37 worktree says `none`.
 */

import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, test} from 'bun:test';
import {join} from 'path';

import {
  findBeadsWorkspace,
  resolveRecordedBeadsDb,
  runBr,
} from '../src/beads/br';
import {brDbCheckResult} from '../src/doctor';
import {brByCwd, withPath} from './br-by-cwd';
import {addLinkedWorktree, git, initRepo} from './git-fixtures';
import {installedBr} from './pinned-br';
import {createSandbox} from './sandbox';

const BR_076 = installedBr('0.7.6');
const BR_0137 = installedBr('0.1.37');
const missing = [BR_076, BR_0137].find((br) => br.kind !== 'installed');
if (missing?.kind === 'unresolved') {
  console.warn(
    `SKIPPED: the split-br tests in beads-br-split.test.ts need br 0.1.37 and 0.7.6 installed (${missing.reason})`,
  );
}
const withBoth = test.skipIf(missing != null);

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

function brPath(version: '0.1.37' | '0.7.6'): string {
  const br = version === '0.7.6' ? BR_076 : BR_0137;
  if (br.kind !== 'installed') throw new Error(br.reason);
  return br.path;
}

interface SplitRepo {
  calls: ReturnType<typeof brByCwd>['calls'];
  path: string;
  primary: string;
  worktree: string;
}

/**
 * A committed repo whose primary runs `primaryBr` and holds a DB that br
 * made, and a linked worktree with no DB that runs `worktreeBr`.
 */
function splitRepo(
  primaryBr: '0.1.37' | '0.7.6',
  worktreeBr: '0.1.37' | '0.7.6',
): SplitRepo {
  const sb = createSandbox();
  sandboxes.push(sb);
  const shim = brByCwd(sb);
  const primary = initRepo(sb, 'repo', {'README.md': '# repo\n'});
  return withPath(shim.path, () => {
    shim.pin(primary, brPath(primaryBr));
    const init = runBr(primary, ['init', '--prefix', 't', '-q']);
    if (!init.ok) throw new Error(`br init failed: ${init.reason ?? '?'}`);
    git(primary, ['add', '.beads']);
    git(primary, ['commit', '-qm', 'beads']);
    const worktree = addLinkedWorktree(
      primary,
      join(primary, '.claude', 'worktrees', 'wt'),
      'wt-branch',
    );
    shim.pin(worktree, brPath(worktreeBr));
    return {calls: shim.calls, path: shim.path, primary, worktree};
  });
}

describe('a worktree whose br disagrees with its primary checkout (F1)', () => {
  for (const [primaryBr, worktreeBr] of [
    ['0.1.37', '0.7.6'],
    ['0.7.6', '0.1.37'],
  ] as const) {
    withBoth(
      `primary on br ${primaryBr}, worktree on br ${worktreeBr}: no DB is chosen, and doctor fails without probing`,
      () => {
        const repo = splitRepo(primaryBr, worktreeBr);
        withPath(repo.path, () => {
          const found = findBeadsWorkspace(repo.worktree);
          expect(found.kind).toBe('failed');
          if (found.kind !== 'failed') return;
          expect(found.brSplit).toEqual({
            primary: {checkout: repo.primary, version: primaryBr},
            worktree: {checkout: repo.worktree, version: worktreeBr},
          });
          expect(found.reason).toContain(repo.primary);
          expect(found.reason).toContain(repo.worktree);
          expect(found.reason).toContain(`br ${primaryBr}`);
          expect(found.reason).toContain(`br ${worktreeBr}`);

          const recorded = resolveRecordedBeadsDb(
            join(repo.worktree, '.beads'),
          );
          expect(recorded.kind).toBe('failed');

          const before = repo.calls().length;
          const doctor = brDbCheckResult(repo.worktree);
          expect(doctor.pass).toBe(false);
          expect(doctor.severity).toBeUndefined();
          expect(doctor.fix).toContain('merge main into this worktree');
          expect(doctor.fix).toContain(`br ${worktreeBr}`);
          expect(doctor.fix).toContain(`br ${primaryBr}`);
          const probes = repo
            .calls()
            .slice(before)
            .filter((call) => !call.args.startsWith('--version'));
          expect(probes).toEqual([]);
        });
      },
    );
  }

  withBoth('both on br 0.7.6: the worktree uses the primary DB', () => {
    const repo = splitRepo('0.7.6', '0.7.6');
    withPath(repo.path, () => {
      const found = findBeadsWorkspace(repo.worktree);
      expect(found.kind).toBe('found');
      if (found.kind !== 'found') return;
      expect(found.via).toBe('primary');
      expect(found.db).toBe(join(repo.primary, '.beads', 'beads.db'));
      expect(brDbCheckResult(repo.worktree).pass).toBe(true);
    });
  });

  withBoth('both on br 0.1.37: the worktree has no DB, as before', () => {
    const repo = splitRepo('0.1.37', '0.1.37');
    withPath(repo.path, () => {
      expect(findBeadsWorkspace(repo.worktree).kind).toBe('none');
    });
  });
});
