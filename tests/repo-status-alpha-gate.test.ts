/**
 * The ALPHA gate on `plan-experimental` and `apply-experimental`
 * (home-base-qyu1.29).
 *
 * WHY THERE IS A GATE AT ALL. The bugs this reacts to lived in the evidence
 * layer that computes `provenSafe`, and they did not crash — they FABRICATED
 * proof, so `plan` presented branches as safe whose work existed nowhere else
 * and `apply` was willing to act on them. A caller cannot tell a good verdict
 * from a fabricated one by reading the output, so the caution has to be
 * attached to the ACT of running the command rather than to its result.
 *
 * WHAT IS THEREFORE TESTED HERE IS COPY AND FRICTION, not computation. That
 * makes it unusual for this codebase, and it is deliberate: every assertion
 * below stands for a way the warning could quietly stop working.
 *
 *   * a rename instead of an alias — a stale skill or script must FAIL, loudly,
 *     rather than be helpfully redirected into the command it was warned about;
 *   * the old names hidden from --help, so nothing advertises them back;
 *   * a banner on stderr on EVERY run of both commands, with no flag to quiet
 *     it, and independent of whether the run then succeeds or refuses;
 *   * `--experimental-acknowledge-data-loss-risk` required to EXECUTE — and
 *     deliberately not required to LOOK, since making a dry run cost the scary
 *     flag would only teach a caller to type it early;
 *   * `stability: alpha` on the object itself, because a plan outlives the run
 *     that produced it and a `--json` consumer never sees stderr;
 *   * the --help narratives leading with the warning and the real history,
 *     rather than burying it under usage.
 *
 * Assertions are on SUBSTANCE, not on whole strings: the wording is meant to be
 * revised, so these check that the specific facts survive — the failure mode
 * (fabricated proof), the date, the blast radius (remote deletion), and the
 * instruction to check the plan yourself.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {execFileSync, spawnSync} from 'child_process';
import {mkdirSync, writeFileSync} from 'fs';
import {join} from 'path';

import {createSandbox, type Sandbox} from './sandbox';

const CLI = join(import.meta.dir, '../src/repo-status/repo-status.ts');

const ACK_FLAG = '--experimental-acknowledge-data-loss-risk';

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

/** Exit status of a git command, without throwing. */
function gitStatus(cwd: string, args: string[]): number {
  return spawnSync('git', args, {cwd, stdio: 'ignore'}).status ?? -1;
}

/**
 * A repo with exactly one proven-safe local branch, so `plan` has something to
 * propose and `apply` has something to do. Local-only on purpose: nothing here
 * should ever reach a network, and the gate is the same either way.
 */
function fixture(sb: Sandbox): string {
  const repo = join(sb.path, 'repo');
  mkdirSync(repo, {recursive: true});
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  writeFileSync(join(repo, 'README.md'), 'c0\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'initial']);

  git(repo, ['checkout', '-q', '-b', 'landed']);
  writeFileSync(join(repo, 'landed.txt'), 'work\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'landed work']);
  git(repo, ['checkout', '-q', 'main']);
  git(repo, ['merge', '--squash', 'landed']);
  git(repo, ['commit', '-q', '-m', 'squashed landed']);
  return repo;
}

interface CliRun {
  code: number;
  err: string;
  out: string;
}

/**
 * The SHIPPED path — a subprocess running the real bin. Exit codes and the
 * stdout/stderr split are the things under test here, and only a real process
 * settles those honestly.
 */
function run(args: string[]): CliRun {
  const result = spawnSync('bun', [CLI, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    code: result.status ?? -1,
    err: result.stderr ?? '',
    out: result.stdout ?? '',
  };
}

/** The facts the banner exists to deliver, checked one at a time. */
function expectAlphaBanner(stderr: string): void {
  expect(stderr).toContain('ALPHA');
  // The failure MODE, which is the whole reason a reader cannot just trust the
  // output: it did not crash, it produced a confident wrong answer.
  expect(stderr).toContain('FABRICATED');
  expect(stderr).toContain('2026-08');
  // The blast radius, and that it is one-way.
  expect(stderr).toContain('DELETES branches on the');
  expect(stderr).toContain('irreversible');
  // The conclusion an agent reading this mid-session is meant to reach.
  expect(stderr).toContain('confirm for yourself');
}

// ---------------------------------------------------------------------------
// The banner
// ---------------------------------------------------------------------------

describe('the ALPHA banner is on stderr, every run', () => {
  test('plan-experimental warns, and keeps stdout clean for its reader', () => {
    const repo = fixture(track(createSandbox()));

    const planned = run(['plan-experimental', '--repo', repo, '--json']);

    expect(planned.code).toBe(0);
    expectAlphaBanner(planned.err);
    // The warning must not contaminate the machine-readable output: a consumer
    // parses stdout, and the plan carries `stability` for its own warning.
    const plan = JSON.parse(planned.out) as {
      safe: {branch: string}[];
      stability: string;
    };
    expect(plan.safe.map((a) => a.branch)).toEqual(['landed']);
  });

  test('apply-experimental warns even on the run that refuses', () => {
    const repo = fixture(track(createSandbox()));

    // No --safe-only: the earliest refusal there is. The banner is printed
    // before any argument checking precisely so no flag mistake can skip it.
    const refused = run(['apply-experimental', '--repo', repo]);

    expect(refused.code).toBe(2);
    expectAlphaBanner(refused.err);
  });

  test('there is no flag that turns it off', () => {
    const repo = fixture(track(createSandbox()));

    // The plausible spellings someone would try, all of which must fail the
    // parse rather than quietly succeed at silencing the warning.
    for (const flag of ['--quiet', '--no-warn', '--no-alpha']) {
      const attempt = run(['plan-experimental', '--repo', repo, flag]);
      expect(attempt.code).not.toBe(0);
      expect(attempt.err).toContain('Unknown argument');
    }
  });
});

// ---------------------------------------------------------------------------
// The old names
// ---------------------------------------------------------------------------

describe('the old names fail loudly instead of redirecting', () => {
  test('`plan` explains the rename, exits 2, and produces no plan', () => {
    const repo = fixture(track(createSandbox()));

    const legacy = run(['plan', '--repo', repo, '--json']);

    expect(legacy.code).toBe(2);
    // Nothing on stdout: a caller piping this into a parser must get nothing to
    // parse, not a plan that silently came from the command it was warned about.
    expect(legacy.out.trim()).toBe('');
    expectAlphaBanner(legacy.err);
    expect(legacy.err).toContain("'plan' is now 'plan-experimental'");
    expect(legacy.err).toContain('not an alias');
    // The part aimed at whatever TOLD the caller to type the old name.
    expect(legacy.err).toContain('predates the rename');
  });

  test('`apply` explains the rename and changes nothing', () => {
    const repo = fixture(track(createSandbox()));

    // The exact invocation a stale skill would carry, flags and all.
    const legacy = run([
      'apply',
      '--repo',
      repo,
      '--safe-only',
      '--yes',
      '--json',
    ]);

    expect(legacy.code).toBe(2);
    expect(legacy.out.trim()).toBe('');
    expectAlphaBanner(legacy.err);
    expect(legacy.err).toContain("'apply' is now 'apply-experimental'");
    expect(legacy.err).toContain(ACK_FLAG);
    // The claim that matters most: it did not do the thing. `landed` is a
    // proven-safe branch, so an alias would have archived it right here.
    expect(gitStatus(repo, ['rev-parse', '--verify', '--quiet', 'landed'])).toBe(
      0,
    );
    expect(
      gitStatus(repo, ['rev-parse', '--verify', '--quiet', 'archive/landed']),
    ).not.toBe(0);
  });

  test('the old flags still reach the explanation rather than a parse error', () => {
    const repo = fixture(track(createSandbox()));

    // Under the CLI's global `.strict()`, `--markdown` and `--include-remote`
    // are unknown on a command that declares no options — which would replace
    // the explanation with a complaint about the flag. The legacy commands opt
    // out of strictness so the message always wins.
    const planned = run(['plan', '--repo', repo, '--markdown']);
    expect(planned.code).toBe(2);
    expect(planned.err).toContain("'plan' is now 'plan-experimental'");
    expect(planned.err).not.toContain('Unknown argument');

    const applied = run([
      'apply',
      '--repo',
      repo,
      '--safe-only',
      '--include-remote',
      '--yes',
    ]);
    expect(applied.code).toBe(2);
    expect(applied.err).toContain("'apply' is now 'apply-experimental'");
    expect(applied.err).not.toContain('Unknown argument');
  });

  test('nothing advertises the old names back', () => {
    const help = run(['--help']);
    expect(help.code).toBe(0);

    // The command list specifically — the narrative around it legitimately says
    // the words "plan" and "apply" while explaining what they are.
    const commands = help.out.split('Commands:')[1]?.split('\n\n')[0] ?? '';
    expect(commands).toContain('repo-status plan-experimental');
    expect(commands).toContain('repo-status apply-experimental');
    // A hidden command must not be listed, and must not be suggested either:
    // an agent that saw `plan` offered here would have no reason to believe the
    // rename means anything.
    expect(commands).not.toMatch(/repo-status (plan|apply)(?![\w-])/);
  });
});

// ---------------------------------------------------------------------------
// The acknowledgement flag
// ---------------------------------------------------------------------------

describe('apply-experimental requires the risk acknowledgement to execute', () => {
  test('without the flag it refuses, exits 2, and leaves the repo alone', () => {
    const repo = fixture(track(createSandbox()));

    const refused = run([
      'apply-experimental',
      '--repo',
      repo,
      '--safe-only',
      '--yes',
      '--json',
    ]);

    expect(refused.code).toBe(2);
    expect(refused.out.trim()).toBe('');
    expectAlphaBanner(refused.err);
    expect(refused.err).toContain(`refusing to execute without ${ACK_FLAG}`);
    // Says what to do instead, not just what it would not do.
    expect(refused.err).toContain('plan-experimental --markdown');
    expect(gitStatus(repo, ['rev-parse', '--verify', '--quiet', 'landed'])).toBe(
      0,
    );
    expect(
      gitStatus(repo, ['rev-parse', '--verify', '--quiet', 'archive/landed']),
    ).not.toBe(0);
  });

  test('with the flag it actually runs — the gate is friction, not a wall', () => {
    const repo = fixture(track(createSandbox()));

    const applied = run([
      'apply-experimental',
      '--repo',
      repo,
      '--safe-only',
      ACK_FLAG,
      '--yes',
      '--json',
    ]);

    expect(applied.code).toBe(0);
    expectAlphaBanner(applied.err);
    expect(
      (JSON.parse(applied.out) as {branch: string; outcome: string}[]).map(
        (r) => [r.branch, r.outcome],
      ),
    ).toEqual([['landed', 'archived']]);
    // The rename really happened, so the test above is refusing something that
    // would otherwise have worked rather than something already impossible.
    expect(
      gitStatus(repo, ['rev-parse', '--verify', '--quiet', 'landed']),
    ).not.toBe(0);
    expect(
      gitStatus(repo, ['rev-parse', '--verify', '--quiet', 'archive/landed']),
    ).toBe(0);
  });

  test('the dry-run preview stays reachable without acknowledging anything', () => {
    const repo = fixture(track(createSandbox()));

    // Looking must not cost the scary flag. If it did, a caller would type the
    // acknowledgement while merely previewing — habituating past it well before
    // the moment it is meant to interrupt.
    const preview = run(['apply-experimental', '--repo', repo, '--safe-only']);

    expect(preview.code).toBe(2);
    expectAlphaBanner(preview.err);
    expect(preview.err).toContain('# Cleanup plan (dry run)');
    expect(preview.err).toContain('refusing to act without --yes');
    expect(preview.err).not.toContain('refusing to execute without');
    expect(gitStatus(repo, ['rev-parse', '--verify', '--quiet', 'landed'])).toBe(
      0,
    );
  });
});

// ---------------------------------------------------------------------------
// The marker on the object
// ---------------------------------------------------------------------------

describe('the plan carries its own alpha marker in every format', () => {
  test('YAML, JSON and markdown all say stability: alpha', () => {
    const repo = fixture(track(createSandbox()));

    const yaml = run(['plan-experimental', '--repo', repo]);
    const json = run(['plan-experimental', '--repo', repo, '--json']);
    const markdown = run(['plan-experimental', '--repo', repo, '--markdown']);

    expect((Bun.YAML.parse(yaml.out) as {stability: string}).stability).toBe(
      'alpha',
    );
    expect((JSON.parse(json.out) as {stability: string}).stability).toBe(
      'alpha',
    );
    // The prose rendering has no field to carry, so it states the same marker in
    // words — and the reason is the same one in all three cases: stdout travels
    // without stderr the moment anyone redirects it.
    expect(markdown.out).toContain('stability: alpha');
    expect(markdown.out).toContain('FABRICATING');
    expect(markdown.out).toContain('2026-08');
  });

  test('the markdown warning is the first thing under the heading', () => {
    const repo = fixture(track(createSandbox()));

    const markdown = run(['plan-experimental', '--repo', repo, '--markdown']);
    const lines = markdown.out.split('\n');

    expect(lines[0]).toStartWith('# Cleanup plan (dry run)');
    expect(lines[2]).toStartWith('> **ALPHA');
    // Before any group, so a reader skimming for their branch has already
    // passed it.
    expect(markdown.out.indexOf('> **ALPHA')).toBeLessThan(
      markdown.out.indexOf('## Will run'),
    );
  });
});

// ---------------------------------------------------------------------------
// The narratives
// ---------------------------------------------------------------------------

describe('--help leads with the alpha warning and the real history', () => {
  for (const command of ['plan-experimental', 'apply-experimental']) {
    test(`${command} --help opens with it`, () => {
      const help = run([command, '--help']);
      expect(help.code).toBe(0);

      // LEADS with it: the warning comes before the description of what the
      // command does, not after it.
      const alpha = help.out.indexOf('ALPHA — READ THIS FIRST');
      const what = help.out.indexOf('WHAT IT DOES');
      expect(alpha).toBeGreaterThanOrEqual(0);
      expect(what).toBeGreaterThan(alpha);

      // The honest history, in the terms that make it actionable: a family of
      // bugs, dated, that fabricated rather than crashed, are fixed, and are
      // probably not the last of them.
      expect(help.out).toContain('2026-08');
      expect(help.out).toContain('FABRICATED');
      // A regex, not a literal: the CLAIM that more bugs are likely is what has
      // to survive an edit, not the sentence it is currently made of.
      expect(help.out).toMatch(/more (of them )?are likely/);
      expect(help.out).toContain('in production');
    });
  }

  test('the top-level narrative marks both commands as experimental', () => {
    const help = run(['--help']);

    expect(help.out).toContain('THE CLEANUP COMMANDS ARE ALPHA');
    expect(help.out).toContain('2026-08');
    expect(help.out).toContain(ACK_FLAG);
    // `status` and `branch` are read-only and are deliberately NOT marked; the
    // top narrative should be pointing a first-time reader at them.
    expect(help.out).toContain("'status' and 'branch' are read-only");
  });
});
