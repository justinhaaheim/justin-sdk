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
  return execFileSync('git', args, {cwd, encoding: 'utf-8', stdio: 'pipe'}).trim();
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

describe('--pretty', () => {
  test('groups branches by disposition and shows the merge verdict', () => {
    const out = prettyFor(buildFixture(track(createSandbox())));

    expect(out).toContain('NEEDS JUDGMENT');
    expect(out).toContain('conflicting');
    expect(out).toContain('merge: CONFLICTS in 1 file — shared.txt');
  });

  test('states what the filters hid', () => {
    const out = prettyFor(buildFixture(track(createSandbox())));

    expect(out).toContain('hidden:');
    expect(out).toContain('1 archive/* mirror(s)');
    expect(out).toContain('--all to show');
    expect(out).not.toContain('archive/finished');
  });

  test('says the filters ran even when they hid nothing', () => {
    const out = prettyFor(buildFixture(track(createSandbox())), {
      excludeArchive: false,
      sinceDays: null,
    });

    // Silence must be a claim: "no age window" and "archive/* mirrors shown"
    // are statements about what was applied, and they are printed either way.
    expect(out).toContain('archive/* mirrors shown');
    expect(out).toContain('no age window');
  });

  test('a branch with unique work and no preview says it was not previewed', () => {
    const out = prettyFor(buildFixture(track(createSandbox())), {
      mergePreview: false,
    });

    expect(out).toContain('merge: not previewed');
    expect(out).not.toContain('merge: clean');
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
    expect(out).toContain('UNKNOWN, not clean');
    expect(out).toContain('This is NOT "no branches"');
    // The failure is IN THE BODY, not only on stderr.
    expect(out).toContain('for-each-ref');
  });

  test('the CLI refuses --pretty together with --json', () => {
    const repo = buildFixture(track(createSandbox()));
    const run = spawnSync(
      'bun',
      [CLI, 'status', '--repo', repo, '--no-prs', '--pretty', '--json'],
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
      [CLI, 'status', '--repo', repo, '--no-prs', '--all', '--since-days', '30'],
      {encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe']},
    );

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('mutually exclusive');
  });

  test('the default status run is filtered, and --all is not', () => {
    const repo = buildFixture(track(createSandbox()));
    const base = [CLI, 'status', '--repo', repo, '--no-prs', '--pretty'];

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
