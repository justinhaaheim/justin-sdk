/**
 * `plan`'s THREE renderings — YAML by default, `--json`, `--markdown`.
 *
 * `plan` used to be the one command that rendered prose instead of the typed
 * object, which broke the rule the rest of the tool is built on: compute ONE
 * schema'd object, then render it. Now YAML is the default, `--json` is that
 * same object, and the prose dry run lives behind `--markdown`.
 *
 * Two properties are worth more than "the flag works", and they are what these
 * tests actually assert:
 *
 *  - UNIFIED SCHEMA. The YAML and the JSON must parse to the SAME object. That
 *    is asserted against each other rather than against a hand-written literal,
 *    so it keeps holding as the plan schema grows.
 *  - NO LOSS. The prose dry run prints the exact push/delete pair for a remote
 *    archive (home-base-qyu1.13). Making that the opt-in format must not leave
 *    the DEFAULT reader — Claude Code — having to reassemble a
 *    `--force-with-lease` from parts. The commands live on the object now, so
 *    every format carries them, and the markdown is proven to be a pure
 *    function of exactly the object the YAML shows.
 *
 * Part of home-base-qyu1.16.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {execFileSync, spawnSync} from 'child_process';
import {writeFileSync} from 'fs';
import {join} from 'path';

import {
  buildPlan,
  remoteArchiveCommands,
  renderPlan,
  type CleanupPlan,
} from '../src/repo-status/plan';
import {buildReport} from '../src/repo-status/report';
import {runCli} from '../src/repo-status/repo-status';
import {createSandbox, type Sandbox} from './sandbox';

const CLI = join(import.meta.dir, '../src/repo-status/repo-status.ts');

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

function commit(cwd: string, file: string, body: string, msg: string): void {
  writeFileSync(join(cwd, file), body);
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-q', '-m', msg]);
}

/**
 * A repo whose plan populates EVERY group: a remote-only archive candidate
 * (the only kind that carries commands), a local rename, and an unmerged branch
 * that must stay in `needsJudgment`. A single-group fixture would let a
 * rendering bug hide in the groups it never printed.
 */
function fixture(sb: Sandbox): string {
  const remote = join(sb.path, 'remote.git');
  const work = join(sb.path, 'work');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  git(work, ['config', 'user.email', 'test@example.com']);
  git(work, ['config', 'user.name', 'Test']);
  commit(work, 'README.md', 'hello\n', 'initial');
  git(work, ['remote', 'add', 'origin', remote]);
  git(work, ['push', '-q', '-u', 'origin', 'main']);

  // Remote-only and squash-merged -> the remote-archive group.
  git(work, ['checkout', '-q', '-b', 'feat-remote', 'main']);
  commit(work, 'remote.txt', 'remote work\n', 'remote work');
  git(work, ['push', '-q', 'origin', 'feat-remote']);
  git(work, ['checkout', '-q', 'main']);
  git(work, ['merge', '--squash', 'feat-remote']);
  git(work, ['commit', '-q', '-m', 'squashed feat-remote']);
  git(work, ['push', '-q', 'origin', 'main']);
  git(work, ['branch', '-D', 'feat-remote']);

  // Local and squash-merged -> the safe (rename) group.
  git(work, ['checkout', '-q', '-b', 'feat-local', 'main']);
  commit(work, 'local.txt', 'local work\n', 'local work');
  git(work, ['checkout', '-q', 'main']);
  git(work, ['merge', '--squash', 'feat-local']);
  git(work, ['commit', '-q', '-m', 'squashed feat-local']);

  // Genuinely unmerged -> needs judgment, never automated.
  git(work, ['checkout', '-q', '-b', 'live-work', 'main']);
  commit(work, 'live.txt', 'nowhere else\n', 'live work');
  git(work, ['checkout', '-q', 'main']);

  return work;
}

/** The plan the CLI itself would build — same inputs the `plan` handler passes. */
function planFor(repo: string): CleanupPlan {
  const report = buildReport({
    content: true,
    cwd: repo,
    prs: true,
    sinceDays: null,
  });
  if (report == null) throw new Error('expected a report');
  const plan = buildPlan(report);
  // Null only when the branch listing itself failed (home-base-qyu1.23).
  if (plan == null) throw new Error('expected a plan');
  return plan;
}

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Drive the real handler in-process. `runCli` is used rather than a subprocess
 * so the flag wiring under test is the same code path a host CLI would hit.
 */
async function runPlan(repo: string, extra: string[]): Promise<CliRun> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => void out.push(a.join(' '));
  console.error = (...a: unknown[]) => void err.push(a.join(' '));
  const previousExitCode = process.exitCode;
  let code = 0;
  try {
    code = await runCli(['bun', 'repo-status', 'plan', '--repo', repo, ...extra]);
  } finally {
    console.log = log;
    console.error = error;
    // Handlers set process.exitCode; left set it would fail the whole run.
    process.exitCode = previousExitCode;
  }
  return {code, stderr: err.join('\n'), stdout: out.join('\n')};
}

describe('plan renderings', () => {
  test('no flags emits YAML — the plan object, not prose', async () => {
    const work = fixture(track(createSandbox()));

    const {code, stdout} = await runPlan(work, []);
    expect(code).toBe(0);
    // The regression this guards: the default silently going back to markdown.
    expect(stdout.startsWith('# Cleanup plan')).toBe(false);
    expect(Bun.YAML.parse(stdout)).toEqual(planFor(work));
  });

  test('--json is unchanged, and is the SAME object as the YAML', async () => {
    const work = fixture(track(createSandbox()));

    const {stdout: json} = await runPlan(work, ['--json']);
    const {stdout: yaml} = await runPlan(work, []);

    expect(json).toBe(JSON.stringify(planFor(work), null, 2));
    // One schema, two encodings — the property the typed-object-in-the-middle
    // rule exists to protect.
    expect(JSON.parse(json)).toEqual(Bun.YAML.parse(yaml));
  });

  test('--markdown reproduces the prose dry run exactly', async () => {
    const work = fixture(track(createSandbox()));

    const {code, stdout: markdown} = await runPlan(work, ['--markdown']);
    expect(code).toBe(0);
    expect(markdown).toBe(renderPlan(planFor(work)));
    expect(markdown.startsWith('# Cleanup plan (dry run) — baseline ')).toBe(
      true,
    );

    // Stronger than "it matches renderPlan": it matches renderPlan applied to
    // the very object the DEFAULT rendering emitted, so the two formats cannot
    // be describing different plans.
    const {stdout: yaml} = await runPlan(work, []);
    expect(markdown).toBe(renderPlan(Bun.YAML.parse(yaml) as CleanupPlan));
  });

  test('the exact push/delete pair survives into every format', async () => {
    const work = fixture(track(createSandbox()));
    const plan = planFor(work);
    const spec = plan.remote[0]?.remoteArchive;
    if (spec == null) throw new Error('expected a remote archive candidate');
    const expected = remoteArchiveCommands(spec);

    const {stdout: yaml} = await runPlan(work, []);
    const {stdout: json} = await runPlan(work, ['--json']);
    const {stdout: markdown} = await runPlan(work, ['--markdown']);

    // The whole point of moving the commands onto the object: the DEFAULT
    // rendering hands them over verbatim rather than making its reader rebuild
    // a --force-with-lease from a sha and two branch names.
    const fromYaml = (Bun.YAML.parse(yaml) as CleanupPlan).remote[0]?.commands;
    expect(fromYaml).toEqual(expected);
    expect((JSON.parse(json) as CleanupPlan).remote[0]?.commands).toEqual(
      expected,
    );
    for (const cmd of expected) expect(markdown).toContain(cmd);

    // Order is the safety argument: push, THEN delete.
    expect(expected[0]).toContain(`:refs/heads/${spec.archiveBranch}`);
    expect(expected[1]).toContain('--delete');

    // Local actions stay null — `target` already says where they land, and
    // nothing about a local rename needs quoting verbatim.
    expect(plan.safe.map((a) => a.commands)).toEqual([null]);
  });

  test('--json and --markdown together is refused, not silently resolved', async () => {
    const work = fixture(track(createSandbox()));

    const {code, stdout, stderr} = await runPlan(work, ['--json', '--markdown']);
    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain('pass at most one');
  });

  test('--help documents --markdown', () => {
    // A subprocess, because yargs prints help and exits the process itself.
    const result = spawnSync('bun', [CLI, 'plan', '--help'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--markdown');
    // The usage NARRATIVE, not just the flag list — the narrative is what a
    // reader with no external memory drives this tool from (home-base-qyu1.5).
    expect(result.stdout).toContain('repo-status plan --markdown');
  });
});
