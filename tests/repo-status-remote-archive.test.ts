/**
 * Tests for REMOTE archiving — push archive/<name>, verify, then delete.
 *
 * These run against a real bare git repository in $TMPDIR acting as `origin`.
 * That is deliberate and load-bearing: the property under test is an ORDERING
 * across three network operations, and a mocked git can only prove that the
 * code calls what the test author expected it to call. A scratch remote proves
 * what actually ends up on the other side.
 *
 * The tests that matter most here are the FAILURE paths. A happy path only
 * shows the tool can archive a branch; the safety claim is that when anything
 * goes wrong — the push is rejected, the ref does not land, the remote moved
 * under us — the original branch is STILL ON THE REMOTE afterwards. Each of
 * those asserts on the remote's own ref list via `ls-remote`, not on the local
 * clone's stale view of it.
 *
 * Part of home-base-qyu1.13.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {execFileSync} from 'child_process';
import {chmodSync, writeFileSync} from 'fs';
import {join} from 'path';

import {
  buildPlan,
  executePlan,
  executeRemotePlan,
  remoteArchiveCommands,
  renderPlan,
} from '../src/repo-status/plan';
import {buildReport} from '../src/repo-status/report';
import {runCli} from '../src/repo-status/repo-status';
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
  return execFileSync('git', args, {cwd, encoding: 'utf-8', stdio: 'pipe'}).trim();
}

interface Fixture {
  /** The clone we plan and apply from. */
  work: string;
  /** The bare repo standing in for GitHub. */
  remote: string;
}

function setupFixture(sb: Sandbox): Fixture {
  const remote = join(sb.path, 'remote.git');
  const work = join(sb.path, 'work');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  git(work, ['config', 'user.email', 'test@example.com']);
  git(work, ['config', 'user.name', 'Test']);
  writeFileSync(join(work, 'README.md'), 'hello\n');
  git(work, ['add', 'README.md']);
  git(work, ['commit', '-q', '-m', 'initial']);
  git(work, ['remote', 'add', 'origin', remote]);
  git(work, ['push', '-q', '-u', 'origin', 'main']);
  return {remote, work};
}

/**
 * A branch that exists ONLY on the remote and whose work is squash-merged into
 * main — i.e. exactly the shape that made `apply` a no-op before this feature.
 * Returns the tip sha the tool should prove and pin.
 */
function addRemoteOnlySafeBranch(fx: Fixture, name: string): string {
  git(fx.work, ['checkout', '-q', '-b', name, 'main']);
  writeFileSync(join(fx.work, `${name.replace(/\//g, '-')}.txt`), `${name}\n`);
  git(fx.work, ['add', '-A']);
  git(fx.work, ['commit', '-q', '-m', `${name} work`]);
  git(fx.work, ['push', '-q', 'origin', name]);
  git(fx.work, ['checkout', '-q', 'main']);
  git(fx.work, ['merge', '--squash', name]);
  git(fx.work, ['commit', '-q', '-m', `squashed ${name}`]);
  git(fx.work, ['push', '-q', 'origin', 'main']);
  const sha = git(fx.work, ['rev-parse', `origin/${name}`]);
  git(fx.work, ['branch', '-D', name]);
  return sha;
}

/** What the REMOTE itself says it has — never the local clone's cached view. */
function remoteBranches(fx: Fixture): Record<string, string> {
  const out = git(fx.work, ['ls-remote', fx.remote, 'refs/heads/*']);
  const map: Record<string, string> = {};
  for (const line of out.split('\n')) {
    const [sha, ref] = line.split('\t');
    if (sha == null || ref == null) continue;
    map[ref.replace('refs/heads/', '')] = sha.trim();
  }
  return map;
}

function writeHook(fx: Fixture, name: string, body: string): void {
  const path = join(fx.remote, 'hooks', name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function plan(fx: Fixture) {
  const report = buildReport({
    content: true,
    cwd: fx.work,
    prs: false,
    sinceDays: null,
  });
  if (report == null) throw new Error('expected a report');
  return buildPlan(report);
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

describe('buildPlan — remote candidates', () => {
  test('a proven-safe remote-only branch lands in `remote`, never in `safe`', () => {
    const fx = setupFixture(track(createSandbox()));
    const sha = addRemoteOnlySafeBranch(fx, 'feat-a');

    const p = plan(fx);
    expect(p.remote.map((a) => a.branch)).toEqual(['origin/feat-a']);
    // The structural guarantee: nothing remote can ride along in the safe group,
    // which is the only group a bare `apply --safe-only` executes.
    expect(p.safe).toHaveLength(0);
    expect(p.remote[0]?.action).toBe('archive-remote-branch');
    expect(p.remote[0]?.remoteArchive).toEqual({
      archiveBranch: 'archive/feat-a',
      remote: 'origin',
      sha,
      sourceBranch: 'feat-a',
    });
    expect(p.remote[0]?.target).toBe('origin/archive/feat-a');
  });

  test('a slashed branch name keeps its full bare name after the remote prefix', () => {
    const fx = setupFixture(track(createSandbox()));
    addRemoteOnlySafeBranch(fx, 'claude/session-xyz');

    const p = plan(fx);
    expect(p.remote[0]?.remoteArchive?.sourceBranch).toBe('claude/session-xyz');
    expect(p.remote[0]?.remoteArchive?.archiveBranch).toBe(
      'archive/claude/session-xyz',
    );
  });

  test('an ALREADY-archived remote ref is never re-archived', () => {
    const fx = setupFixture(track(createSandbox()));
    addRemoteOnlySafeBranch(fx, 'archive/old-thing');

    const p = plan(fx);
    // The bug this guards: `origin/archive/old-thing` does not start with
    // `archive/`, so a naive check proposes `archive/archive/old-thing`.
    expect(p.remote).toHaveLength(0);
    expect(p.manual.map((a) => a.branch)).toContain('origin/archive/old-thing');
    expect(p.manual[0]?.reason).toContain('already under archive/');
  });

  test('a protected branch name is never archived, however safe it looks', () => {
    const fx = setupFixture(track(createSandbox()));
    addRemoteOnlySafeBranch(fx, 'develop');

    const p = plan(fx);
    expect(p.remote).toHaveLength(0);
    expect(p.manual[0]?.reason).toContain('protected branch name');
  });

  test('the dry run prints the exact push/delete pair, in order', () => {
    const fx = setupFixture(track(createSandbox()));
    const sha = addRemoteOnlySafeBranch(fx, 'feat-a');

    const rendered = renderPlan(plan(fx));
    const commands = remoteArchiveCommands({
      archiveBranch: 'archive/feat-a',
      remote: 'origin',
      sha,
      sourceBranch: 'feat-a',
    });
    expect(commands[0]).toBe(
      `git push origin ${sha}:refs/heads/archive/feat-a`,
    );
    expect(commands[1]).toBe(
      `git push origin --delete feat-a --force-with-lease=refs/heads/feat-a:${sha}`,
    );
    for (const cmd of commands) expect(rendered).toContain(cmd);
    // The push must be shown before the delete — the ordering IS the safety
    // argument, so a dry run that implied the reverse would be a lie.
    expect(rendered.indexOf(commands[0] as string)).toBeLessThan(
      rendered.indexOf(commands[1] as string),
    );
    expect(rendered).toContain('--include-remote');
  });
});

// ---------------------------------------------------------------------------
// Execution against a real remote
// ---------------------------------------------------------------------------

describe('executeRemotePlan — happy path', () => {
  test('pushes the archive ref and only then deletes the original', () => {
    const fx = setupFixture(track(createSandbox()));
    const sha = addRemoteOnlySafeBranch(fx, 'feat-a');
    expect(remoteBranches(fx)['feat-a']).toBe(sha);

    const results = executeRemotePlan(plan(fx), fx.work);
    expect(results).toHaveLength(1);
    expect(results[0]?.outcome).toBe('archived');

    const after = remoteBranches(fx);
    // The commits are on the remote under the archived name...
    expect(after['archive/feat-a']).toBe(sha);
    // ...and the original is gone from the remote itself.
    expect(after['feat-a']).toBeUndefined();
  });

  test('re-running after a partial run finishes the delete instead of failing', () => {
    const fx = setupFixture(track(createSandbox()));
    const sha = addRemoteOnlySafeBranch(fx, 'feat-a');
    // Simulate an earlier run that pushed the archive ref and then died before
    // deleting: the exact sha is already on the remote under archive/.
    git(fx.work, ['push', 'origin', `${sha}:refs/heads/archive/feat-a`]);

    const results = executeRemotePlan(plan(fx), fx.work);
    expect(results[0]?.outcome).toBe('archived');
    const after = remoteBranches(fx);
    expect(after['archive/feat-a']).toBe(sha);
    expect(after['feat-a']).toBeUndefined();
  });
});

describe('executeRemotePlan — the safety properties', () => {
  test('PUSH FAILS: the original branch still exists on the remote', () => {
    const fx = setupFixture(track(createSandbox()));
    const sha = addRemoteOnlySafeBranch(fx, 'feat-a');
    const p = plan(fx);
    // Build the plan while the push would have worked, THEN make the remote
    // reject the archive ref — the shape of a branch-protection rule appearing
    // between planning and applying.
    //
    // Crucially this rejects ONLY the archive ref and would happily accept a
    // delete. A hook that rejected everything would pass this test even if the
    // code deleted first, since the delete would bounce too; letting the delete
    // through is what makes this an ORDERING test rather than a "the remote
    // said no to everything" test. Verified by negative control.
    writeHook(
      fx,
      'update',
      '#!/bin/sh\ncase "$1" in\n  refs/heads/archive/*) echo "archive refs are blocked" >&2; exit 1;;\nesac\nexit 0\n',
    );

    const results = executeRemotePlan(p, fx.work);
    expect(results[0]?.outcome).toBe('failed');
    expect(results[0]?.reason).toContain('was left alone');

    const after = remoteBranches(fx);
    // THE assertion this whole feature exists to satisfy.
    expect(after['feat-a']).toBe(sha);
    expect(after['archive/feat-a']).toBeUndefined();
  });

  test('VERIFICATION FAILS: the original branch still exists on the remote', () => {
    const fx = setupFixture(track(createSandbox()));
    const sha = addRemoteOnlySafeBranch(fx, 'feat-a');
    const p = plan(fx);
    // The push SUCCEEDS — git reports success and exits 0 — but the ref is not
    // there afterwards. post-receive runs after refs are updated and its exit
    // code is ignored by git, so this reproduces "the push worked and the ref
    // still is not on the remote" without faking anything.
    writeHook(
      fx,
      'post-receive',
      '#!/bin/sh\ngit update-ref -d refs/heads/archive/feat-a\n',
    );

    const results = executeRemotePlan(p, fx.work);
    expect(results[0]?.outcome).toBe('failed');
    expect(results[0]?.reason).toContain('could not verify');
    expect(results[0]?.reason).toContain('NOT deleted');

    const after = remoteBranches(fx);
    expect(after['feat-a']).toBe(sha);
    expect(after['archive/feat-a']).toBeUndefined();
  });

  test('REMOTE MOVED: a stale pinned sha is refused, and the new commits survive', () => {
    const fx = setupFixture(track(createSandbox()));
    const provenSha = addRemoteOnlySafeBranch(fx, 'feat-a');
    const p = plan(fx);
    expect(p.remote[0]?.remoteArchive?.sha).toBe(provenSha);

    // Someone pushes new work to the branch from another clone after the plan.
    const other = join(fx.work, '..', 'other');
    execFileSync('git', ['clone', '-q', fx.remote, other]);
    git(other, ['config', 'user.email', 'other@example.com']);
    git(other, ['config', 'user.name', 'Other']);
    git(other, ['checkout', '-q', 'feat-a']);
    writeFileSync(join(other, 'late.txt'), 'work that exists nowhere else\n');
    git(other, ['add', '-A']);
    git(other, ['commit', '-q', '-m', 'late work']);
    git(other, ['push', '-q', 'origin', 'feat-a']);
    const movedSha = git(other, ['rev-parse', 'feat-a']);
    expect(movedSha).not.toBe(provenSha);

    const results = executeRemotePlan(p, fx.work);

    // The SAFETY property is asserted before the cosmetic one: had the tool
    // archived the pinned sha and deleted the branch, `late work` would exist
    // nowhere. Two independent mechanisms defend this — the live-sha check
    // below and the `--force-with-lease` on the delete — and a negative control
    // confirmed that removing BOTH is what it takes to destroy the commit.
    const after = remoteBranches(fx);
    expect(after['feat-a']).toBe(movedSha);
    expect(after['archive/feat-a']).toBeUndefined();

    expect(results[0]?.outcome).toBe('skipped');
    expect(results[0]?.reason).toContain('has moved');
  });

  test('CLOBBER: an existing archive ref at another sha is never overwritten', () => {
    const fx = setupFixture(track(createSandbox()));
    const sha = addRemoteOnlySafeBranch(fx, 'feat-a');
    // An archive/feat-a already on the remote, at an ANCESTOR of our sha. The
    // ancestor matters: pushing over it would be a legal fast-forward that git
    // accepts silently, so git's own non-fast-forward refusal does NOT cover
    // this case and the explicit pre-check is the only thing that does.
    const foreign = git(fx.work, ['rev-parse', 'main~1']);
    git(fx.work, ['push', 'origin', `${foreign}:refs/heads/archive/feat-a`]);
    // `--is-ancestor` exits non-zero (and so throws here) if the premise above
    // is not actually true, keeping this test honest about what it is proving.
    git(fx.work, ['merge-base', '--is-ancestor', foreign, sha]);

    const results = executeRemotePlan(plan(fx), fx.work);
    expect(results[0]?.outcome).toBe('skipped');
    expect(results[0]?.reason).toContain('refusing to clobber');

    const after = remoteBranches(fx);
    expect(after['archive/feat-a']).toBe(foreign);
    expect(after['feat-a']).toBe(sha);
  });

  test('the branch is skipped when someone else already deleted it on the remote', () => {
    const fx = setupFixture(track(createSandbox()));
    addRemoteOnlySafeBranch(fx, 'feat-a');
    const p = plan(fx);
    // Deleted from ANOTHER clone, so our local remote-tracking ref still points
    // at it — the tool's cached view says the branch is there and only asking
    // the remote reveals otherwise.
    const other = join(fx.work, '..', 'other');
    execFileSync('git', ['clone', '-q', fx.remote, other]);
    git(other, ['push', '-q', 'origin', '--delete', 'feat-a']);

    const results = executeRemotePlan(p, fx.work);
    expect(results[0]?.outcome).toBe('skipped');
    expect(results[0]?.reason).toContain('no longer exists');
    // Nothing was resurrected under archive/ from a branch that is already gone.
    expect(remoteBranches(fx)['archive/feat-a']).toBeUndefined();
  });
});

describe('the opt-in is structural', () => {
  test('executePlan (what a bare --safe-only runs) never touches the remote', () => {
    const fx = setupFixture(track(createSandbox()));
    const sha = addRemoteOnlySafeBranch(fx, 'feat-a');
    const before = remoteBranches(fx);

    const results = executePlan(plan(fx), fx.work);
    expect(results).toHaveLength(0);
    expect(remoteBranches(fx)).toEqual(before);
    expect(remoteBranches(fx)['feat-a']).toBe(sha);
  });

  test('local archiving still works unchanged alongside remote candidates', () => {
    const fx = setupFixture(track(createSandbox()));
    addRemoteOnlySafeBranch(fx, 'feat-a');
    // A purely local proven-safe branch, in the same repo as a remote candidate.
    git(fx.work, ['checkout', '-q', '-b', 'local-landed', 'main']);
    writeFileSync(join(fx.work, 'local.txt'), 'local\n');
    git(fx.work, ['add', '-A']);
    git(fx.work, ['commit', '-q', '-m', 'local work']);
    git(fx.work, ['checkout', '-q', 'main']);
    git(fx.work, ['merge', '--squash', 'local-landed']);
    git(fx.work, ['commit', '-q', '-m', 'squashed local-landed']);

    const p = plan(fx);
    expect(p.safe.map((a) => a.branch)).toEqual(['local-landed']);
    expect(p.safe[0]?.action).toBe('archive-local-branch');
    expect(p.safe[0]?.target).toBe('archive/local-landed');

    executePlan(p, fx.work);
    const locals = git(fx.work, ['branch', '--format=%(refname:short)']).split(
      '\n',
    );
    expect(locals).toContain('archive/local-landed');
    expect(locals).not.toContain('local-landed');
    // ...and the remote was left entirely alone by that local-only run.
    expect(remoteBranches(fx)['feat-a']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// The CLI gate
// ---------------------------------------------------------------------------
//
// The acceptance criterion is about a FLAG, so it has to be tested through the
// flag. Asserting on executeRemotePlan alone would leave the actual wiring —
// the thing that decides whether the network is touched — unproven.

describe('apply --include-remote (through the CLI)', () => {
  async function runApply(fx: Fixture, extra: string[]): Promise<void> {
    const logged: string[] = [];
    const log = console.log;
    const err = console.error;
    console.log = (...a: unknown[]) => void logged.push(a.join(' '));
    console.error = () => {};
    const previousExitCode = process.exitCode;
    try {
      await runCli([
        'bun',
        'repo-status',
        'apply',
        '--repo',
        fx.work,
        '--safe-only',
        '--yes',
        ...extra,
      ]);
    } finally {
      console.log = log;
      console.error = err;
      // Handlers set process.exitCode; left set it would fail the whole run.
      process.exitCode = previousExitCode;
    }
  }

  test('a BARE --safe-only run leaves the remote branch untouched', async () => {
    const fx = setupFixture(track(createSandbox()));
    const sha = addRemoteOnlySafeBranch(fx, 'feat-a');

    await runApply(fx, []);

    const after = remoteBranches(fx);
    expect(after['feat-a']).toBe(sha);
    expect(after['archive/feat-a']).toBeUndefined();
  });

  test('--include-remote archives it on the remote', async () => {
    const fx = setupFixture(track(createSandbox()));
    const sha = addRemoteOnlySafeBranch(fx, 'feat-a');

    await runApply(fx, ['--include-remote']);

    const after = remoteBranches(fx);
    expect(after['archive/feat-a']).toBe(sha);
    expect(after['feat-a']).toBeUndefined();
  });

  test('--include-remote without --yes changes nothing and names the count', async () => {
    const fx = setupFixture(track(createSandbox()));
    const sha = addRemoteOnlySafeBranch(fx, 'feat-a');
    const errors: string[] = [];
    const err = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.join(' '));
    const previousExitCode = process.exitCode;
    try {
      await runCli([
        'bun',
        'repo-status',
        'apply',
        '--repo',
        fx.work,
        '--safe-only',
        '--include-remote',
      ]);
    } finally {
      console.error = err;
      process.exitCode = previousExitCode;
    }

    expect(errors.join('\n')).toContain('1 branch(es) on the remote');
    const after = remoteBranches(fx);
    expect(after['feat-a']).toBe(sha);
    expect(after['archive/feat-a']).toBeUndefined();
  });
});
