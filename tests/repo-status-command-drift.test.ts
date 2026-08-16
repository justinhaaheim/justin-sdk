/**
 * The dry run's core promise: what the reader approves is what executes.
 *
 * `plan` prints the exact `git push` / `git push --delete --force-with-lease`
 * pair a remote archive will run. That is only worth anything if the strings and
 * the argv `apply` hands to git cannot drift apart — and they used to be two
 * independent hand-assemblies, so nothing but care kept them equal
 * (home-base-qyu1.17). They now come from one builder, and this file is what
 * makes that hold rather than merely be true today.
 *
 * The test is deliberately NOT "the builder agrees with itself", which is
 * unfalsifiable. It observes the argv git ACTUALLY receives during a real
 * `apply`, and compares it against what a real SHELL makes of the printed
 * strings. Bypassing the builder inside `archiveRemoteBranch` fails it; so does
 * printing a command a shell would expand into something else.
 *
 * ── How the observation works, and why it needs a subprocess ─────────────────
 *
 * Every git call is `execFileSync('git', argv)`, so the only place to see the
 * real argv is a `git` earlier on PATH. Env mutated inside a bun test does not
 * reach child processes — bun snapshots the environment at startup (verified:
 * setting process.env.PATH, or GIT_TRACE, has no effect on an execFileSync
 * child) — so the shim is installed on the PATH of a SUBPROCESS running the real
 * CLI, and its log path is baked into the script rather than passed in the
 * environment. Driving the shipped `apply` command also means the wiring under
 * test is the one a user actually runs.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {execFileSync, spawnSync} from 'child_process';
import {chmodSync, mkdirSync, readFileSync, writeFileSync} from 'fs';
import {join} from 'path';

import {
  buildPlan,
  remoteArchiveArgv,
  type CleanupPlan,
} from '../src/repo-status/plan';
import {buildReport} from '../src/repo-status/report';
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

interface Fixture {
  work: string;
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
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'initial']);
  git(work, ['remote', 'add', 'origin', remote]);
  git(work, ['push', '-q', '-u', 'origin', 'main']);
  return {remote, work};
}

/** A remote-only, squash-merged branch — the shape that becomes a remote archive. */
function addRemoteOnlySafeBranch(fx: Fixture, name: string): string {
  git(fx.work, ['checkout', '-q', '-b', name, 'main']);
  writeFileSync(join(fx.work, 'work.txt'), `${name}\n`);
  git(fx.work, ['add', '-A']);
  git(fx.work, ['commit', '-q', '-m', 'branch work']);
  git(fx.work, ['push', '-q', 'origin', name]);
  git(fx.work, ['checkout', '-q', 'main']);
  git(fx.work, ['merge', '--squash', name]);
  git(fx.work, ['commit', '-q', '-m', 'squashed']);
  git(fx.work, ['push', '-q', 'origin', 'main']);
  const sha = git(fx.work, ['rev-parse', `origin/${name}`]);
  git(fx.work, ['branch', '-D', name]);
  return sha;
}

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

function planFor(repo: string): CleanupPlan {
  const report = buildReport({
    content: true,
    cwd: repo,
    prs: false,
    sinceDays: null,
  });
  if (report == null) throw new Error('expected a report');
  const plan = buildPlan(report);
  // Null only when the branch listing itself failed (home-base-qyu1.23).
  if (plan == null) throw new Error('expected a plan');
  return plan;
}

/**
 * A `git` that records the argv it was handed and then hands off to the real
 * one, so `apply` runs for real against the scratch remote while every
 * invocation is captured verbatim.
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

/** Run the shipped `apply` with the shim first on PATH. */
function runApply(fx: Fixture, shimDir: string): {status: number; err: string} {
  const result = spawnSync(
    'bun',
    [
      CLI,
      'apply-experimental',
      '--repo',
      fx.work,
      '--safe-only',
      '--include-remote',
      '--experimental-acknowledge-data-loss-risk',
      '--yes',
    ],
    {
      encoding: 'utf-8',
      env: {...process.env, PATH: `${shimDir}:${process.env.PATH ?? ''}`},
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  return {err: result.stderr ?? '', status: result.status ?? -1};
}

/**
 * Parse a printed command the way a reader would — by handing it to a real
 * shell. A shell function shadows `git`, so the words are reported and nothing
 * touches a remote. Only a real shell can settle what a string expands to, which
 * is the whole question when the string is going to be pasted into one.
 */
function shellWords(command: string): string[] {
  const script = `git() { for a in "$@"; do printf '%s\\037' "$a"; done; }\n${command}\n`;
  const out = execFileSync('/bin/sh', ['-c', script], {encoding: 'utf-8'});
  return ['git', ...out.split(UNIT).slice(0, -1)];
}

/** The `push` invocations only — the two that mutate the remote. */
function pushes(invocations: string[][]): string[][] {
  return invocations.filter((argv) => argv[0] === 'push');
}

describe('the printed commands are the executed commands', () => {
  test('a real apply runs exactly the argv the plan printed', () => {
    const sb = track(createSandbox());
    const fx = setupFixture(sb);
    const sha = addRemoteOnlySafeBranch(fx, 'feat-a');

    // The plan is captured BEFORE applying — apply removes the branch it
    // describes, so this is the only moment both exist.
    const action = planFor(fx.work).remote[0];
    const spec = action?.remoteArchive;
    const printed = action?.commands;
    if (spec == null || printed == null) {
      throw new Error('expected a remote archive candidate with commands');
    }

    const shim = installGitShim(sb);
    const run = runApply(fx, shim.dir);
    expect(run.status).toBe(0);
    // The run must really have done the thing, or every assertion below could
    // pass vacuously against an apply that never got as far as pushing.
    expect(remoteBranches(fx)['archive/feat-a']).toBe(sha);
    expect(remoteBranches(fx)['feat-a']).toBeUndefined();

    const executed = pushes(shim.invocations());
    expect(executed).toHaveLength(2);

    // 1. What ran came from the shared builder — not from a second assembly
    //    inside archiveRemoteBranch that happens to look similar.
    const built = remoteArchiveArgv(spec);
    expect(executed).toEqual([built.push, built.delete]);

    // 2. ...and the strings the reader approved parse back, through a real
    //    shell, to precisely those argv. This is the promise itself.
    expect(printed.map(shellWords)).toEqual(
      executed.map((argv) => ['git', ...argv]),
    );

    // 3. For an ordinary branch name the quoting is a no-op, so the printed
    //    form stays byte-for-byte the plain join it has always been.
    expect(printed).toEqual(executed.map((argv) => `git ${argv.join(' ')}`));
  });

  test('a branch name a shell would expand is printed so it cannot be', () => {
    const sb = track(createSandbox());
    const fx = setupFixture(sb);
    // `check-ref-format` accepts this: only spaces and a few glob characters are
    // rejected, so `$( )`, backticks, `;`, `&` and `|` are all legal in a branch
    // name — and remote branch names come from other people's clones and bots.
    // `id` is chosen because it is harmless if the quoting is broken and this
    // test ends up actually running it.
    const hostile = 'feat/$(id)';
    const sha = addRemoteOnlySafeBranch(fx, hostile);

    const action = planFor(fx.work).remote[0];
    const spec = action?.remoteArchive;
    const printed = action?.commands;
    if (spec == null || printed == null) {
      throw new Error('expected a remote archive candidate with commands');
    }
    expect(spec.sourceBranch).toBe(hostile);
    expect(printed[1]).toContain(`'${hostile}'`);

    const shim = installGitShim(sb);
    expect(runApply(fx, shim.dir).status).toBe(0);
    expect(remoteBranches(fx)[`archive/${hostile}`]).toBe(sha);

    const executed = pushes(shim.invocations());
    expect(executed).toHaveLength(2);
    expect(printed.map(shellWords)).toEqual(
      executed.map((argv) => ['git', ...argv]),
    );

    // Why the quoting is load-bearing rather than decorative: the same command
    // printed the old, unquoted way expands to a DIFFERENT command — one that
    // runs `id` and then deletes a ref nobody proved anything about.
    const unquoted = `git push origin --delete ${hostile} --force-with-lease=refs/heads/${hostile}:${sha}`;
    expect(shellWords(unquoted)).not.toEqual([
      'git',
      ...(executed[1] as string[]),
    ]);
  });
});
