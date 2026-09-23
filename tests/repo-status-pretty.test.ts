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
import {chmodSync, existsSync, mkdirSync, rmSync, writeFileSync} from 'fs';
import {join} from 'path';

import {PR_STATE_NOT_CHECKED} from '../src/repo-status/disposition';
import {renderReportPretty} from '../src/repo-status/pretty';
import {buildReport} from '../src/repo-status/report';
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

  test('the unmerged headline counts the branches the filters hid', () => {
    // `archive/finished` is hidden by the default filters and carries a commit
    // main does not — so a heading of `UNMERGED WORK (1)` would be the answer to
    // "what is still open?" with one of the answers filtered out of it
    // (epic design D4).
    const out = prettyFor(buildFixture(track(createSandbox())));

    expect(out).toContain('UNMERGED WORK (1 shown, 1 more hidden)');
    expect(out).toContain(
      '1 of the 1 hidden branch carries commits not on main',
    );
    // The measured statement REPLACES the disclaimer it was filed against.
    expect(out).not.toContain('these were not inspected');
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
    // branches held and found unmerged commits in nearly all of them — so the
    // line beneath the count no longer DISCLAIMS ("hidden does NOT mean
    // merged"), it STATES the result of having checked (epic design D4).
    expect(out).toContain(
      'carries commits not on main (checked by patch-id only — nothing else about them was inspected; `--all` shows them)',
    );
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

  test('a merged branch with a clean checkout still shows its path', () => {
    const repo = buildFixture(track(createSandbox()));
    // Claude Code's worktrees live under the repo and are gitignored there;
    // mirror that, so the fixture exercises the relative-path rendering rather
    // than the absolute-path fallback.
    writeFileSync(join(repo, '.git', 'info', 'exclude'), '.claude/\n');
    git(repo, [
      'worktree',
      'add',
      '-q',
      join(repo, '.claude', 'worktrees', 'landed'),
      'landed',
    ]);
    // A second merged branch, older so the sort is deterministic, with NO
    // checkout — the negative half of the same rule.
    const base = git(repo, ['rev-list', '--max-parents=0', 'HEAD']);
    git(repo, ['branch', '-q', 'settled', base]);

    const lines = prettyFor(repo).split('\n');
    const i = lines.findIndex((l) => /^ {2}landed\s/.test(l));
    expect(i).toBeGreaterThanOrEqual(0);

    // `landed` is MERGED and its checkout is CLEAN: the exact row the old
    // "show it only where useful" gate hid the path on, and exactly the row
    // that needs it — merged-plus-worktree is the `git worktree remove`
    // cleanup list (epic design D2).
    expect(lines[i + 1]).toBe('      in .claude/worktrees/landed');
    // The path is part of the ROW, not detail, so no blank line follows: the
    // next merged row starts immediately and the table stays single-spaced.
    expect(lines[i + 2]).toMatch(/^ {2}settled\s/);
    // And a row with no worktree renders no path line at all.
    expect(lines[i + 3]).not.toMatch(/^ {6}in /);
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

// ---------------------------------------------------------------------------
// The round-2 cut list (epic design D5, home-base-qyu1.33.10)
// ---------------------------------------------------------------------------

/** The row line for one branch, as rendered. Throws rather than returning null. */
function rowFor(out: string, name: string): string {
  const line = out
    .split('\n')
    .find((l) => l.startsWith(`  ${name} `) || l === `  ${name}`);
  if (line == null) throw new Error(`no row rendered for ${name}`);
  return line;
}

/**
 * A row's cells. Branch names never contain a space, so splitting on runs of
 * whitespace gives `[name, AHEAD, BEHIND, FILES, date, time, ...ALSO ON]`.
 */
function cells(out: string, name: string): string[] {
  return rowFor(out, name).trim().split(/\s+/);
}

/** Everything a row says under ALSO ON, which is whatever follows the clock. */
function alsoOn(out: string, name: string): string {
  const line = rowFor(out, name).trimEnd();
  // The date column is padded to hold the `*` fallback marker, so a row without
  // one has an extra space before the next column.
  const clock = /\d{2}:\d{2}\*? {2}/.exec(line);
  if (clock == null) throw new Error(`no timestamp in the row for ${name}`);
  return line.slice(clock.index + clock[0].length).trimStart();
}

/**
 * Every ALSO ON state in one repo: merged with a remote at the same sha, merged
 * with a remote that differs, merged local-only, merged remote-only, and an
 * UNMERGED local-only branch — the one row that must still say THIS DISK ONLY.
 */
function alsoOnFixture(sb: Sandbox): string {
  const repo = sb.path;
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  const base = commit(repo, 'shared.txt', 'original\n', 'initial');
  const head = commit(repo, 'second.txt', 'more\n', 'second');

  git(repo, ['branch', '-q', 'landed-pushed', head]);
  git(repo, ['update-ref', 'refs/remotes/origin/landed-pushed', head]);

  // The remote is at this branch's OLD tip: merged either way, but the remote
  // ref is not the same commit, so deleting one is not deleting the other.
  git(repo, ['branch', '-q', 'landed-drifted', head]);
  git(repo, ['update-ref', 'refs/remotes/origin/landed-drifted', base]);

  git(repo, ['branch', '-q', 'landed-local', head]);

  // No local branch at all — the row IS the remote ref.
  git(repo, ['update-ref', 'refs/remotes/origin/landed-remote', head]);

  git(repo, ['checkout', '-q', '-b', 'open-local', base]);
  commit(repo, 'open.txt', 'unmerged\n', 'work only here');
  git(repo, ['checkout', '-q', 'main']);
  return repo;
}

describe('ALSO ON says something different in each half of the ledger', () => {
  test('a merged row names the remote ref that also needs deleting', () => {
    const out = prettyFor(alsoOnFixture(track(createSandbox())), {
      sinceDays: null,
    });

    // The CLEANUP fact, not the tautology. `main` was the old answer and it was
    // the same answer on every merged row (epic design D5).
    expect(alsoOn(out, 'landed-pushed')).toBe('origin/landed-pushed');
    expect(alsoOn(out, 'landed-drifted')).toBe(
      'origin/landed-drifted (differs)',
    );
    expect(alsoOn(out, 'landed-local')).toBe('—');
    // A remote-only row's remote ref is its own name; repeating it would just
    // restate the BRANCH column.
    expect(alsoOn(out, 'origin/landed-remote')).toBe('—');

    // The tautology is gone: no merged row answers with the baseline name.
    const merged = out.slice(out.indexOf('ALREADY MERGED'));
    expect(merged).not.toMatch(/ {2}main\s*$/m);
  });

  test('THIS DISK ONLY survives where it means something, and only there', () => {
    const out = prettyFor(alsoOnFixture(track(createSandbox())), {
      sinceDays: null,
    });

    // `landed-local` and `open-local` are both on no remote. The difference is
    // that one has work to lose and the other does not, which is exactly what
    // this marker is for.
    expect(alsoOn(out, 'open-local')).toBe('THIS DISK ONLY');
    expect(out.slice(out.indexOf('ALREADY MERGED'))).not.toContain(
      'THIS DISK ONLY',
    );
  });
});

describe('FILES tells a structural zero from a measured one', () => {
  test('an ahead-0 row renders —, and an unmeasured row still renders ?', () => {
    const repo = alsoOnFixture(track(createSandbox()));

    // `overlaps: false` is what leaves `changedFileCount` null on a row with
    // unique work: the count comes from the changed-file walk that section runs.
    const unmeasured = prettyFor(repo, {overlaps: false, sinceDays: null});
    expect(cells(unmeasured, 'landed-local')[1]).toBe('0');
    expect(cells(unmeasured, 'landed-local')[3]).toBe('—');
    expect(cells(unmeasured, 'open-local')[3]).toBe('?');

    // POSITIVE CONTROL: with the walk on, the same row prints its real count —
    // so `?` above is the absence of a measurement, not a constant.
    const measured = prettyFor(repo, {overlaps: true, sinceDays: null});
    expect(cells(measured, 'open-local')[3]).toBe('1');
    // …and the merged row stays `—`, because its zero was never measured at all.
    expect(cells(measured, 'landed-local')[3]).toBe('—');
  });
});

/**
 * A parent repo where TWO branches each drag the submodule pointer backwards.
 *
 * Built the way `tests/repo-status-safety-claims.test.ts` builds its regression
 * fixture — deliberately duplicated rather than imported, because that file
 * asserts the claims `merge-preview` makes and must not be modified by work on
 * the renderer.
 */
function twoRegressionsFixture(sb: Sandbox): {
  old: string;
  parent: string;
  recent: string;
} {
  const sub = join(sb.path, 'sub');
  mkdirSync(sub, {recursive: true});
  git(sub, ['init', '-q', '-b', 'main']);
  git(sub, ['config', 'user.email', 'test@example.com']);
  git(sub, ['config', 'user.name', 'Test']);
  const old = commit(sub, 'v.txt', 'old\n', 'old release');
  const recent = commit(sub, 'v.txt', 'new\n', 'new release');

  const parent = join(sb.path, 'parent');
  mkdirSync(parent, {recursive: true});
  git(parent, ['init', '-q', '-b', 'main']);
  git(parent, ['config', 'user.email', 'test@example.com']);
  git(parent, ['config', 'user.name', 'Test']);
  commit(parent, 'README.md', 'x\n', 'initial');
  execFileSync(
    'git',
    ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'sub'],
    {cwd: parent, stdio: 'pipe'},
  );
  git(parent, ['-C', 'sub', 'checkout', '-q', recent]);
  git(parent, ['add', 'sub']);
  git(parent, ['commit', '-q', '-m', 'point sub at the new release']);
  const tip = git(parent, ['rev-parse', 'HEAD']);

  for (const name of ['stale-one', 'stale-two']) {
    git(parent, ['checkout', '-q', '-b', name, tip]);
    git(parent, ['-C', 'sub', 'checkout', '-q', old]);
    git(parent, ['add', 'sub']);
    git(parent, ['commit', '-q', '-m', `${name} drags sub backwards`]);
  }
  git(parent, ['checkout', '-q', 'main']);
  git(parent, ['-C', 'sub', 'checkout', '-q', recent]);
  return {old, parent, recent};
}

describe('a submodule REVERTS states the fact per row and the mechanism once', () => {
  test('two rows sharing a regression get one short line each', () => {
    const {old, parent, recent} = twoRegressionsFixture(track(createSandbox()));
    const out = prettyFor(parent, {sinceDays: null, submodules: true});
    const expected = `REVERTS submodule sub ${recent.slice(0, 7)} -> ${old.slice(0, 7)}`;

    const perRow = out.split('\n').filter((l) => l.includes(expected));
    expect(perRow).toHaveLength(2);
    expect(perRow[0]).toBe(`      ${expected}`);

    // The MECHANISM, exactly once, and in the footer rather than under a row.
    const mechanism = out
      .split('\n')
      .filter((l) => l.startsWith('A merge that REVERTS a submodule'));
    expect(mechanism).toHaveLength(1);
    expect(out.indexOf(mechanism[0] ?? '')).toBeGreaterThan(
      out.indexOf('WHAT WAS AND WAS NOT CHECKED'),
    );

    // The paragraph that used to print under every affected row is gone from
    // the ledger — and still intact on the typed object below.
    expect(out).not.toContain('an ancestor, so the merge silently UNDOES');
  });

  test('the typed object keeps the full explanation the renderer shortened', () => {
    const {parent} = twoRegressionsFixture(track(createSandbox()));
    const report = buildReport({
      content: false,
      cwd: parent,
      prs: false,
      sinceDays: null,
      submodules: true,
    });
    const shift = report?.branches
      ?.find((b) => b.name === 'stale-one')
      ?.mergePreview?.submoduleShifts?.find((s) => s.path === 'sub');

    expect(shift?.direction).toBe('regression');
    // A YAML consumer gets no footer, so the mechanism has to stay in the field.
    expect(shift?.why).toContain('the merge silently UNDOES submodule history');
  });

  test('no rendered regression means no mechanism line at all', () => {
    // NEGATIVE CONTROL: a standing explanation of a hazard this repo does not
    // exhibit is a line the reader learns to skip.
    const out = prettyFor(buildFixture(track(createSandbox())));
    expect(out).not.toContain('A merge that REVERTS a submodule');
  });
});

describe('the PR-state clause is stated once, and only where it is unknown', () => {
  test('with --prs off the footer says it and no row repeats it', () => {
    const out = prettyFor(alsoOnFixture(track(createSandbox())), {
      content: true,
      prs: false,
      sinceDays: null,
    });

    expect(out).toContain('PR state: NOT checked');
    expect(out).not.toContain('PR state not checked');
    // The footer no longer points at row text the reader will not find.
    expect(out).not.toContain('Rows saying');
  });

  test('the typed object still carries the clause on every row', () => {
    const report = buildReport({
      content: true,
      cwd: alsoOnFixture(track(createSandbox())),
      prs: false,
      sinceDays: null,
      submodules: false,
    });
    const row = report?.branches?.find((b) => b.name === 'open-local');

    // Stripping is a RENDERING decision. A YAML consumer reading one row in
    // isolation has no footer and still has to tell "no PR" from "not checked".
    expect(row?.why.endsWith(PR_STATE_NOT_CHECKED)).toBe(true);
  });
});
