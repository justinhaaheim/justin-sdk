/**
 * home-base-p05kz.3 item 3: a branch already on origin/main is not "not merged".
 *
 * Reproduced 2026-11-06 in audio-journal-1: local main was 64 commits behind
 * origin/main, and worktree-oct24-model-prep was 64 ahead of local main and 0
 * ahead of origin/main. The inbox said "not merged into main (64 commits)".
 *
 * Real git in $TMPDIR, because the safety half of this is what git does with a
 * ref it cannot read. Critical rule 7: "landed" is never said on missing evidence.
 *
 * NEGATIVE CONTROLS (run 2026-11-06, in the report on home-base-p05kz.3):
 * - mergeStateOf returning 'notMerged' without asking about the remote ref fails
 *   "on origin and behind locally";
 * - a failed remote merge-base returning 'onRemoteDefault' fails "a remote ref
 *   git cannot read";
 * - aheadOfDefaultOf counting only `<default>..<branch>` fails "not on origin".
 */

import type {StatusFacts} from '../src/thread/session-status';
import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, test} from 'bun:test';
import {writeFileSync} from 'fs';
import {join} from 'path';

import {gitFacts, landItText} from '../src/thread/session-card';
import {
  type CheckoutGit,
  measureCheckoutCached,
} from '../src/thread/session-model';
import {deriveStatus} from '../src/thread/session-status';
import {git, initRepo} from './git-fixtures';
import {createSandbox} from './sandbox';

const sandboxes: Sandbox[] = [];

afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

/** main holds one commit; `feature` adds two. Local main stays behind. */
function repoWithFeature(): string {
  const sb = createSandbox();
  sandboxes.push(sb);
  const repo = initRepo(sb, 'repo', {'a.txt': 'a\n'});
  git(repo, ['checkout', '-q', '-b', 'feature']);
  git(repo, ['commit', '-q', '--allow-empty', '-m', 'one']);
  git(repo, ['commit', '-q', '--allow-empty', '-m', 'two']);
  return repo;
}

/** origin/main, as `git fetch` would leave it, pointing at `target`. */
function setOriginMain(repo: string, target: string): void {
  git(repo, ['update-ref', 'refs/remotes/origin/main', target]);
  git(repo, [
    'symbolic-ref',
    'refs/remotes/origin/HEAD',
    'refs/remotes/origin/main',
  ]);
}

async function measuredCheckout(
  repo: string,
): Promise<Extract<CheckoutGit, {kind: 'measured'}>> {
  const shared = await measureCheckoutCached(repo, null);
  if (shared.kind !== 'measured') throw new Error(shared.reason);
  return shared;
}

describe('a branch and origin/main (home-base-p05kz.3 item 3)', () => {
  test('the verdict: closed requests on a landed branch are done, not "to land"', () => {
    const facts: Omit<StatusFacts, 'merged'> = {
      activityUnmeasured: [],
      beadProblems: [],
      commits: {count: 2, kind: 'counted'},
      contextTokens: null,
      handedOff: false,
      helpersInFlight: [],
      lastMessageRole: 'assistant',
      lastRecordAt: null,
      openP0: 0,
      requests: {closed: 1, total: 1},
      sessionCloseReason: null,
      successor: null,
      uncommitted: {ok: true, value: 0},
      wrapUpAt: null,
    };
    const now = new Date('2026-11-06T12:00:00Z');
    expect(
      deriveStatus(
        {...facts, merged: {ok: true, value: 'onRemoteDefault'}},
        {asIfYielded: false, now},
      ),
    ).toEqual({by: 'requests', kind: 'done', reason: null});
    expect(
      deriveStatus(
        {...facts, merged: {ok: true, value: 'notMerged'}},
        {asIfYielded: false, now},
      ),
    ).toEqual({kind: 'doneUnmerged', notMerged: true, uncommitted: 0});
    expect(
      deriveStatus(
        {...facts, merged: {ok: false, reason: 'origin/main is unreadable'}},
        {asIfYielded: false, now},
      ),
    ).toEqual({kind: 'unknown', reasons: ['origin/main is unreadable']});
  });

  test('on origin and behind locally: landed, and local main is behind', async () => {
    const repo = repoWithFeature();
    setOriginMain(repo, 'feature');
    const shared = await measuredCheckout(repo);
    expect(shared.merged).toEqual({ok: true, value: 'onRemoteDefault'});
    expect(shared.aheadOfDefault).toEqual({ok: true, value: 0});
    expect(shared.localDefaultBehind).toEqual({
      ok: true,
      value: {count: 2, remote: 'origin/main'},
    });
    const facts = gitFacts(shared);
    expect(facts).toEqual([
      {
        label: 'Branch',
        value: 'feature, landed: all its commits are on origin/main',
      },
      {label: 'Local main', value: '2 commits behind origin/main'},
    ]);
    expect(JSON.stringify(facts)).not.toContain('not merged');
  });

  test('not on origin: not merged, counting only what origin lacks', async () => {
    const repo = repoWithFeature();
    setOriginMain(repo, 'feature');
    git(repo, ['commit', '-q', '--allow-empty', '-m', 'three']);
    const shared = await measuredCheckout(repo);
    expect(shared.merged).toEqual({ok: true, value: 'notMerged'});
    // 3 ahead of local main, but only 1 is unlanded.
    expect(shared.aheadOfDefault).toEqual({ok: true, value: 1});
    expect(gitFacts(shared)).toEqual([
      {label: 'Branch', value: 'feature, not merged into main (1 commit)'},
      {label: 'Local main', value: '2 commits behind origin/main'},
    ]);
    expect(landItText(shared, {notMerged: true, uncommitted: 0})).toBe(
      'Land it: merge feature into main (1 commit)',
    );
  });

  test('no origin/main at all: not merged, and nothing said about origin', async () => {
    const repo = repoWithFeature();
    const shared = await measuredCheckout(repo);
    expect(shared.merged).toEqual({ok: true, value: 'notMerged'});
    expect(shared.aheadOfDefault).toEqual({ok: true, value: 2});
    expect(shared.localDefaultBehind).toEqual({ok: true, value: null});
    expect(gitFacts(shared)).toEqual([
      {label: 'Branch', value: 'feature, not merged into main (2 commits)'},
    ]);
  });

  test('a remote ref git cannot read: never landed, and visibly unknown', async () => {
    const repo = repoWithFeature();
    setOriginMain(repo, 'feature');
    // A loose ref naming an object that does not exist.
    writeFileSync(
      join(repo, '.git', 'refs', 'remotes', 'origin', 'main'),
      '1111111111111111111111111111111111111111\n',
    );
    const shared = await measuredCheckout(repo);
    expect(shared.merged.ok).toBe(false);
    const facts = gitFacts(shared);
    expect(facts[0]?.value).toContain(
      'feature, whether it is merged into main is unknown',
    );
    expect(JSON.stringify(facts)).not.toContain('landed');
  });

  test('merged into local main: says so, with no word about origin', async () => {
    const repo = repoWithFeature();
    git(repo, ['branch', '-f', 'main', 'feature']);
    setOriginMain(repo, 'feature');
    const shared = await measuredCheckout(repo);
    expect(shared.merged).toEqual({ok: true, value: 'merged'});
    expect(gitFacts(shared)).toEqual([
      {label: 'Branch', value: 'feature, merged into main'},
    ]);
  });
});
