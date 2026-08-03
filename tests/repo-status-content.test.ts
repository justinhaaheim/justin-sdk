/**
 * Tests for the +content proof engine — the safety-critical half of
 * repo-status.
 *
 * These build real git repos and run the real plumbing, because the whole point
 * of the module is correctly interpreting `git cherry` / `rev-parse <ref>:<path>`
 * against genuinely awkward histories (squash merges, cherry-picks, branches
 * hundreds of commits behind their baseline).
 *
 * The two regression tests that matter most are marked TRAP: they encode
 * failures that actually happened during the reconcile that motivated the tool,
 * and that would silently destroy work if they regressed.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {execFileSync} from 'child_process';
import {writeFileSync} from 'fs';
import {join} from 'path';

import {
  inspectArchiveMirror,
  proveContentOnBaseline,
} from '../src/repo-status/content';
import {createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];

function track(sandbox: Sandbox): Sandbox {
  sandboxes.push(sandbox);
  return sandbox;
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

function initRepo(sb: Sandbox): void {
  git(sb.path, ['init', '-q', '-b', 'main']);
  git(sb.path, ['config', 'user.email', 'test@example.com']);
  git(sb.path, ['config', 'user.name', 'Test']);
  sb.writeFile('README.md', 'hello\n');
  git(sb.path, ['add', 'README.md']);
  git(sb.path, ['commit', '-q', '-m', 'initial']);
}

function commit(sb: Sandbox, file: string, content: string, msg: string): void {
  writeFileSync(join(sb.path, file), content);
  git(sb.path, ['add', file]);
  git(sb.path, ['commit', '-q', '-m', msg]);
}

describe('proveContentOnBaseline', () => {
  test('genuinely unmerged work is NOT reported as present on the baseline', () => {
    const sb = track(createSandbox());
    initRepo(sb);
    git(sb.path, ['checkout', '-q', '-b', 'feature']);
    commit(sb, 'feature.txt', 'unique work\n', 'feature work');
    git(sb.path, ['checkout', '-q', 'main']);

    const proof = proveContentOnBaseline('feature', 'main', sb.path);
    expect(proof.uniqueCommits).toHaveLength(1);
    expect(proof.uniqueCommits[0]?.patchIdPresent).toBe(false);
    expect(proof.unaccountedCommits).toHaveLength(1);
    expect(proof.allContentOnBaseline).toBe(false);
  });

  test('a cherry-picked commit is recognised by patch-id despite a different sha', () => {
    const sb = track(createSandbox());
    initRepo(sb);
    git(sb.path, ['checkout', '-q', '-b', 'feature']);
    commit(sb, 'feature.txt', 'ported work\n', 'feature work');
    const featureSha = git(sb.path, ['rev-parse', 'HEAD']);
    git(sb.path, ['checkout', '-q', 'main']);
    // Main must diverge FIRST. Cherry-picking onto an undiverged main would
    // reproduce a bit-identical commit (same parent, tree, author and message),
    // so the sha would not actually change and the test would prove nothing.
    commit(sb, 'main-only.txt', 'main moved on\n', 'unrelated main work');
    git(sb.path, ['cherry-pick', featureSha]);

    // Different sha on main, identical content.
    expect(git(sb.path, ['rev-parse', 'HEAD'])).not.toBe(featureSha);

    const proof = proveContentOnBaseline('feature', 'main', sb.path);
    expect(proof.uniqueCommits.every((c) => c.patchIdPresent)).toBe(true);
    expect(proof.allContentOnBaseline).toBe(true);
  });

  test('a SQUASH-merged branch is proven landed via the per-file fallback', () => {
    const sb = track(createSandbox());
    initRepo(sb);
    git(sb.path, ['checkout', '-q', '-b', 'feature']);
    commit(sb, 'a.txt', 'alpha\n', 'add a');
    commit(sb, 'b.txt', 'beta\n', 'add b');
    git(sb.path, ['checkout', '-q', 'main']);
    // Squash: one commit on main carrying both files. Patch-ids will NOT match
    // the two original commits, so only the per-file comparison can prove this.
    git(sb.path, ['merge', '--squash', 'feature']);
    git(sb.path, ['commit', '-q', '-m', 'squashed feature']);

    const proof = proveContentOnBaseline('feature', 'main', sb.path);
    expect(proof.uniqueCommits.length).toBeGreaterThan(0);
    expect(proof.unaccountedCommits).toHaveLength(0);
    expect(proof.allContentOnBaseline).toBe(true);
  });

  test('TRAP: a branch far BEHIND the baseline is still judged by content, not by range diff', () => {
    const sb = track(createSandbox());
    initRepo(sb);
    // Branch lands its work, then main races far ahead. `git diff main branch`
    // would be dominated by MAIN's 40 commits and look enormous — the exact
    // misreading that made 250-750-commit-behind branches look unmerged.
    git(sb.path, ['checkout', '-q', '-b', 'landed']);
    commit(sb, 'landed.txt', 'landed work\n', 'landed work');
    const sha = git(sb.path, ['rev-parse', 'HEAD']);
    git(sb.path, ['checkout', '-q', 'main']);
    git(sb.path, ['cherry-pick', sha]);
    for (let i = 0; i < 40; i++) {
      commit(sb, `noise-${i}.txt`, `noise ${i}\n`, `unrelated main work ${i}`);
    }

    // Sanity: the branch really is far behind, and a range diff really is huge.
    const behind = git(sb.path, ['rev-list', '--count', 'landed..main']);
    expect(Number(behind)).toBeGreaterThan(39);
    const rangeDiff = git(sb.path, ['diff', '--name-only', 'main', 'landed']);
    expect(rangeDiff.split('\n').length).toBeGreaterThan(30);

    // Despite all that, the branch's own content demonstrably landed.
    const proof = proveContentOnBaseline('landed', 'main', sb.path);
    expect(proof.allContentOnBaseline).toBe(true);
    expect(proof.unaccountedCommits).toHaveLength(0);
  });

  test('a commit whose file was later CHANGED on the baseline is not called reflected', () => {
    const sb = track(createSandbox());
    initRepo(sb);
    git(sb.path, ['checkout', '-q', '-b', 'feature']);
    commit(sb, 'shared.txt', 'branch version\n', 'branch edit');
    git(sb.path, ['checkout', '-q', 'main']);
    commit(sb, 'shared.txt', 'different main version\n', 'main edit');

    const proof = proveContentOnBaseline('feature', 'main', sb.path);
    expect(proof.allContentOnBaseline).toBe(false);
    expect(proof.unaccountedCommits[0]?.files[0]).toEqual({
      path: 'shared.txt',
      status: 'differs',
    });
  });
});

describe('inspectArchiveMirror', () => {
  test('an exact mirror is reported as exact with nothing missing', () => {
    const sb = track(createSandbox());
    initRepo(sb);
    git(sb.path, ['checkout', '-q', '-b', 'feature']);
    commit(sb, 'f.txt', 'work\n', 'work');
    git(sb.path, ['checkout', '-q', 'main']);
    git(sb.path, ['branch', 'archive/feature', 'feature']);

    const mirror = inspectArchiveMirror('feature', sb.path);
    expect(mirror?.exists).toBe(true);
    expect(mirror?.commitsMissingFromMirror).toBe(0);
    expect(mirror?.isExact).toBe(true);
  });

  test('no mirror at all is reported as absent, not as safe', () => {
    const sb = track(createSandbox());
    initRepo(sb);
    git(sb.path, ['checkout', '-q', '-b', 'feature']);
    commit(sb, 'f.txt', 'work\n', 'work');
    git(sb.path, ['checkout', '-q', 'main']);

    const mirror = inspectArchiveMirror('feature', sb.path);
    expect(mirror?.exists).toBe(false);
    expect(mirror?.isExact).toBe(false);
  });

  test('TRAP: a mirror the LOCAL branch has outgrown is reported stale', () => {
    const sb = track(createSandbox());
    initRepo(sb);
    git(sb.path, ['checkout', '-q', '-b', 'feature']);
    commit(sb, 'f.txt', 'work\n', 'work');
    git(sb.path, ['branch', 'archive/feature']); // mirror taken HERE
    commit(sb, 'f2.txt', 'more work\n', 'work after the mirror was taken');
    commit(sb, 'f3.txt', 'even more\n', 'more work still');
    git(sb.path, ['checkout', '-q', 'main']);

    const mirror = inspectArchiveMirror('feature', sb.path);
    expect(mirror?.exists).toBe(true);
    expect(mirror?.commitsMissingFromMirror).toBe(2);
    expect(mirror?.isExact).toBe(false);
  });

  test('TRAP: the enhance-tamagui-theme case — REMOTE is ahead of the mirror while the local ref is not', () => {
    const sb = track(createSandbox());
    initRepo(sb);

    // A real remote, so `origin/feature` is a genuine remote-tracking ref.
    const remote = track(createSandbox());
    git(remote.path, ['init', '-q', '--bare', '-b', 'main']);
    git(sb.path, ['remote', 'add', 'origin', remote.path]);

    git(sb.path, ['checkout', '-q', '-b', 'feature']);
    commit(sb, 'f.txt', 'work\n', 'work');
    git(sb.path, ['branch', 'archive/feature']); // mirror matches LOCAL exactly

    // The remote moves ahead by 3 commits that exist nowhere else locally.
    commit(sb, 'r1.txt', 'remote 1\n', 'remote work 1');
    commit(sb, 'r2.txt', 'remote 2\n', 'remote work 2');
    commit(sb, 'r3.txt', 'remote 3\n', 'remote work 3');
    git(sb.path, ['push', '-q', 'origin', 'feature']);
    // Rewind the LOCAL branch back to the mirror point, so a local-only check
    // would conclude "mirror is exact, safe to delete" — while origin/feature
    // still holds 3 unmerged commits. This is the 122-commit trap in miniature.
    git(sb.path, ['reset', '-q', '--hard', 'archive/feature']);
    git(sb.path, ['checkout', '-q', 'main']);

    // Precondition: local really does match the mirror exactly.
    expect(git(sb.path, ['rev-parse', 'feature'])).toBe(
      git(sb.path, ['rev-parse', 'archive/feature']),
    );

    const mirror = inspectArchiveMirror('feature', sb.path);
    expect(mirror?.exists).toBe(true);
    // The remote-ahead commits MUST surface, or work gets silently destroyed.
    expect(mirror?.commitsMissingFromMirror).toBe(3);
    expect(mirror?.staleAgainst).toBe('origin/feature');
    expect(mirror?.isExact).toBe(false);
  });

  test('archive mirroring does NOT by itself mark content as present on the baseline', () => {
    const sb = track(createSandbox());
    initRepo(sb);
    git(sb.path, ['checkout', '-q', '-b', 'feature']);
    commit(sb, 'f.txt', 'work that never landed on main\n', 'work');
    git(sb.path, ['branch', 'archive/feature', 'feature']);
    git(sb.path, ['checkout', '-q', 'main']);

    const proof = proveContentOnBaseline('feature', 'main', sb.path);
    expect(proof.archiveMirror?.isExact).toBe(true);
    // "mirrored" and "already merged" are different claims. Conflating them is
    // how work gets lost, so the merged conclusion must remain false.
    expect(proof.allContentOnBaseline).toBe(false);
  });
});
