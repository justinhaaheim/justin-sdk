/**
 * The human rendering, and the two things it is forbidden to do.
 *
 * `--pretty` exists because 58KB of YAML is not something a person reads in a
 * terminal. It is a pure function over the same typed object — it runs no git
 * and decides nothing — so most of what is worth testing is not "does it look
 * right" but "does it still say the things that must never be dropped":
 *
 *   1. It must never print an all-clear over a repo git could not read. When
 *      the branch listing failed there is no ledger, and an empty one would
 *      read as a clean repo — the exact failure qyu1.23 was filed for.
 *   2. It must not leave a warning on stderr only. `emit` puts enumeration
 *      failures and severe submodule rows there, but a person watching a
 *      terminal sees both streams interleaved and a person redirecting stdout
 *      to a file sees neither.
 *
 * Plus the filtering line, which is the whole reason the filters are allowed to
 * be on by default at all.
 *
 * Part of home-base-qyu1.33.4.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {execFileSync, spawnSync} from 'child_process';
import {chmodSync, existsSync, rmSync, writeFileSync} from 'fs';
import {join} from 'path';

import {renderReportPretty} from '../src/repo-status/pretty';
import {buildReport, type RepoStatusReport} from '../src/repo-status/report';
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

function commit(repo: string, file: string, body: string, msg: string): string {
  writeFileSync(join(repo, file), body);
  git(repo, ['add', '--', file]);
  git(repo, ['commit', '-q', '-m', msg]);
  return git(repo, ['rev-parse', 'HEAD']);
}

function buildFixture(sb: Sandbox): string {
  const repo = sb.path;
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  const base = commit(repo, 'shared.txt', 'original\n', 'initial');

  git(repo, ['checkout', '-q', '-b', 'conflicting', base]);
  commit(repo, 'shared.txt', 'branch version\n', 'branch edits shared');

  git(repo, ['checkout', '-q', '-b', 'archive/finished', base]);
  commit(repo, 'archived.txt', 'archived\n', 'archived work');

  git(repo, ['checkout', '-q', 'main']);
  commit(repo, 'shared.txt', 'main version\n', 'main edits shared');

  // A branch with nothing of its own, so the report has a SECOND section. The
  // shared column grid is only testable across more than one.
  git(repo, ['branch', '-q', 'landed', 'main']);
  return repo;
}

function prettyFor(
  repo: string,
  over: Partial<Parameters<typeof buildReport>[0]> = {},
): string {
  const report = buildReport({
    content: false,
    cwd: repo,
    excludeArchive: true,
    prs: false,
    sinceDays: 90,
    submodules: false,
    ...over,
  });
  if (report == null) throw new Error('expected a report');
  return renderReportPretty(report);
}

describe('the ledger rendering', () => {
  test('groups branches by disposition and shows the merge verdict', () => {
    const out = prettyFor(buildFixture(track(createSandbox())));

    expect(out).toContain('UNMERGED WORK');
    expect(out).toContain('conflicting');
    expect(out).toContain('CONFLICTS with main in 1 file: shared.txt');
  });

  test('one column grid across every section, so the sections line up', () => {
    const out = prettyFor(buildFixture(track(createSandbox())), {
      excludeArchive: false,
      sinceDays: null,
    });
    const headers = out
      .split('\n')
      .filter((l) => l.includes('BRANCH') && l.includes('AHEAD'));

    // Two sections in this fixture, and their header rows must be identical —
    // per-section widths would make the eye re-find the columns at every
    // heading, which is the thing the shared grid exists to prevent.
    expect(headers.length).toBeGreaterThan(1);
    expect(new Set(headers).size).toBe(1);
  });

  test('every timestamp carries the time, so the column stays flush', () => {
    const out = prettyFor(buildFixture(track(createSandbox())));
    const stamps = out.match(/\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?/g) ?? [];

    expect(stamps.length).toBeGreaterThan(0);
    for (const stamp of stamps) expect(stamp).toMatch(/\d{2}:\d{2}$/);
  });

  test('states what the filters hid', () => {
    const out = prettyFor(buildFixture(track(createSandbox())));

    expect(out).toContain('branch hidden');
    expect(out).toContain('on an archive/ backup branch');
    // Hiding is fine; hiding SILENTLY is not. Reviewers checked what the hidden
    // branches held and found unmerged commits in nearly all of them, so the
    // line has to say hidden is not a synonym for handled.
    expect(out).toContain('hidden does NOT mean merged');
    expect(out).not.toContain('archive/finished');
  });

  test('says the filters ran even when they hid nothing', () => {
    const out = prettyFor(buildFixture(track(createSandbox())), {
      excludeArchive: false,
      sinceDays: null,
    });

    // Silence must be a claim: an unfiltered run says so, rather than simply
    // omitting the line and letting the reader assume either way.
    expect(out).toContain('Nothing hidden');
  });

  test('a branch with unique work and no preview says it was not checked', () => {
    const out = prettyFor(buildFixture(track(createSandbox())), {
      mergePreview: false,
    });

    expect(out).toContain('merge into main: not checked');
    expect(out).not.toContain('merges into main cleanly');
  });

  test('ANSI is emitted only when the caller asks for it', () => {
    const repo = buildFixture(track(createSandbox()));
    const report = buildReport({
      content: false,
      cwd: repo,
      prs: false,
      sinceDays: 90,
      submodules: false,
    });
    if (report == null) throw new Error('expected a report');

    // Plain by default, because the default reader is a tool call or a pipe and
    // escape sequences there are noise the reader has to parse past.
    expect(renderReportPretty(report)).not.toContain('[');
    expect(renderReportPretty(report, {color: true})).toContain('[');
  });

  test('a repo git could not read renders as UNKNOWN, never as clean', () => {
    const sb = track(createSandbox());
    const repo = buildFixture(sb);

    // One unreadable object behind any ref tip fails `for-each-ref` for the
    // whole repo, which is what makes the branch listing null.
    const tip = git(repo, ['rev-parse', 'conflicting']);
    const dir = join(repo, '.git', 'objects', tip.slice(0, 2));
    const objectPath = join(dir, tip.slice(2));
    if (existsSync(objectPath)) {
      chmodSync(dir, 0o755);
      rmSync(objectPath);
    }

    const out = prettyFor(repo);
    expect(out).toContain('COULD NOT READ THIS REPO');
    expect(out).toContain('UNKNOWN, not as clean');
    expect(out).toContain('This is NOT "the repo has no branches"');
    // The failure is IN THE BODY, not only on stderr.
    expect(out).toContain('for-each-ref');
  });

  test('the ledger is the DEFAULT format; --yaml and --json opt out', () => {
    const repo = buildFixture(track(createSandbox()));
    const run = (extra: string[]): string =>
      spawnSync('bun', [CLI, 'status', '--repo', repo, '--no-prs', ...extra], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).stdout ?? '';

    expect(run([])).toContain('REPO STATUS');
    expect(run(['--yaml'])).toContain('baselineRef:');
    expect(run(['--json']).trimStart().startsWith('{')).toBe(true);
    // The ledger is ~15x smaller; that ratio is the reason it is the default.
    expect(run([]).length).toBeLessThan(run(['--yaml']).length);
  });

  test('the CLI refuses --json together with --yaml', () => {
    const repo = buildFixture(track(createSandbox()));
    const run = spawnSync(
      'bun',
      [CLI, 'status', '--repo', repo, '--no-prs', '--json', '--yaml'],
      {encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe']},
    );

    expect(run.status).toBe(2);
    expect(run.stderr).toContain('at most one');
    expect(run.stdout.trim()).toBe('');
  });

  test('--all is refused alongside an explicit --since-days', () => {
    const repo = buildFixture(track(createSandbox()));
    const run = spawnSync(
      'bun',
      [
        CLI,
        'status',
        '--repo',
        repo,
        '--no-prs',
        '--all',
        '--since-days',
        '30',
      ],
      {encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe']},
    );

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('mutually exclusive');
  });

  test('the default status run is filtered, and --all is not', () => {
    const repo = buildFixture(track(createSandbox()));
    const base = [CLI, 'status', '--repo', repo, '--no-prs'];

    const filtered = spawnSync('bun', base, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const all = spawnSync('bun', [...base, '--all'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    expect(filtered.stdout).not.toContain('archive/finished');
    expect(all.stdout).toContain('archive/finished');
  });
});
