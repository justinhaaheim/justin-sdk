/**
 * Several `git rev-parse` answers from one git call (home-base-ejsq2.3 part B):
 * readGitFacts (thread/facts.ts), measureCheckout (thread/session-model.ts)
 * and buildCoreInventory (repo-status/core.ts). A clean batch must give each
 * piece the line its own call printed, and anything else must run the separate
 * calls, so each failure keeps the text it had: an unborn branch, a bare repo,
 * a `.git` directory, a directory outside any repo.
 *
 * A counting git shim first on PATH (`git` logs its arguments, then runs the
 * real git) shows how many rev-parse calls each case made.
 *
 * NEGATIVE CONTROLS (run by hand, recorded on home-base-ejsq2.3): make
 * `splitRevParseBatch` return null and every "one call" test fails on its
 * count; make it skip its count check and the unborn, bare, `.git` and
 * outside-a-repo tests still pass (git exits 128 there), while the split
 * unit test fails.
 */
import {afterAll, afterEach, beforeAll, describe, expect, test} from 'bun:test';
import {execFileSync, spawnSync} from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {
  revParseBatchArgs,
  splitRevParseBatch,
} from '../src/git-rev-parse-batch';
import {buildCoreInventory} from '../src/repo-status/core';
import {readGitFacts} from '../src/thread/facts';
import {measureCheckoutCached} from '../src/thread/session-model';

let root = '';
let shimLog = '';
let savedPath: string | undefined;
const repos: Record<string, string> = {};

function sh(cwd: string, script: string): void {
  const ran = spawnSync('sh', ['-c', script], {cwd, encoding: 'utf8'});
  if (ran.status !== 0) throw new Error(`${script}: ${ran.stderr}`);
}

const COMMIT =
  'git -c user.name=t -c user.email=t@t commit -q --allow-empty -m one';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'git-rev-parse-batch-'));
  const make = (name: string, script: string): string => {
    const dir = join(root, name);
    mkdirSync(dir);
    sh(dir, script);
    return dir;
  };
  repos.normal = make('normal', `git init -q -b main . && ${COMMIT}`);
  repos.detached = make(
    'detached',
    `git init -q -b main . && ${COMMIT} && git checkout -q --detach`,
  );
  repos.unborn = make('unborn', 'git init -q -b main .');
  repos.bare = make('bare.git', 'git init -q --bare -b main .');
  repos.notRepo = make('not-a-repo', 'true');
  repos.insideGit = join(repos.normal, '.git');
  make(
    'parent',
    `git init -q -b main . && ${COMMIT} && git worktree add -q ../linked -b feat`,
  );
  repos.linked = join(root, 'linked');

  // The counting shim: logs, then runs the git that was first on PATH.
  const realGit = execFileSync('sh', ['-c', 'command -v git'], {
    encoding: 'utf8',
  }).trim();
  const shimDir = join(root, 'shim');
  mkdirSync(shimDir);
  shimLog = join(root, 'git-calls.log');
  writeFileSync(
    join(shimDir, 'git'),
    `#!/bin/sh\necho "$*" >> '${shimLog}'\nexec '${realGit}' "$@"\n`,
    {mode: 0o755},
  );
  savedPath = process.env.PATH;
  process.env.PATH = `${shimDir}:${savedPath ?? ''}`;
});

afterAll(() => {
  process.env.PATH = savedPath;
  rmSync(root, {force: true, recursive: true});
});

afterEach(() => {
  rmSync(shimLog, {force: true});
});

function revParseCalls(): string[] {
  let text = '';
  try {
    text = readFileSync(shimLog, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').filter((line) => line.startsWith('rev-parse'));
}

/** What a separate call prints, trimmed, or null when it fails. */
function alone(cwd: string, args: string[]): null | string {
  const ran = spawnSync('git', args, {cwd, encoding: 'utf8'});
  return ran.status === 0 ? ran.stdout.trim() : null;
}

const BATCH = [
  '--show-toplevel --absolute-git-dir --path-format=absolute --git-common-dir HEAD --abbrev-ref HEAD',
];

describe('the batch helpers', () => {
  test('the flags of each call, in order, as one rev-parse', () => {
    expect(
      revParseBatchArgs([
        ['rev-parse', '--show-toplevel'],
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        ['rev-parse', '--abbrev-ref', 'HEAD'],
      ]),
    ).toEqual([
      'rev-parse',
      '--show-toplevel',
      '--path-format=absolute',
      '--git-common-dir',
      '--abbrev-ref',
      'HEAD',
    ]);
    expect(() => revParseBatchArgs([['status']])).toThrow(
      'not a rev-parse call',
    );
  });

  test('a split gives each call its own line, and refuses any other shape', () => {
    expect(splitRevParseBatch('/a\n/a/.git\nmain\n', 3)).toEqual([
      '/a\n',
      '/a/.git\n',
      'main\n',
    ]);
    expect(splitRevParseBatch('/a\n/a/.git\n', 3)).toBeNull();
    expect(splitRevParseBatch('/a\nb\n/a/.git\nmain\n', 3)).toBeNull();
    expect(splitRevParseBatch('/a\n\nmain\n', 3)).toBeNull();
    expect(splitRevParseBatch('/a\n/a/.git\nmain', 3)).toBeNull();
  });
});

describe('readGitFacts: five rev-parse answers', () => {
  test.each(['normal', 'detached', 'linked'])(
    'a %s checkout: one call, and the answers of the five separate calls',
    (name) => {
      const cwd = repos[name] ?? '';
      const facts = readGitFacts(cwd);
      expect(revParseCalls()).toEqual(
        BATCH.map((flags) => `rev-parse ${flags}`),
      );
      expect(facts.repoPath).toBe(alone(cwd, ['rev-parse', '--show-toplevel']));
      expect(facts.branch).toBe(
        alone(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
      );
      expect(facts.headSha).toBe(alone(cwd, ['rev-parse', 'HEAD']));
      expect(facts.isWorktree).toBe(name === 'linked');
      expect(facts.repo).toBe(name === 'linked' ? 'parent' : name);
      expect(
        facts.failures.filter((f) =>
          /^(repoPath|branch|headSha|isWorktree):/.test(f),
        ),
      ).toEqual([]);
    },
  );

  test('an unborn branch: the batch fails, and the branch and HEAD failures name their own calls', () => {
    const cwd = repos.unborn ?? '';
    const facts = readGitFacts(cwd);
    expect(revParseCalls()).toEqual([
      `rev-parse ${BATCH[0]}`,
      'rev-parse --show-toplevel',
      'rev-parse --abbrev-ref HEAD',
      'rev-parse HEAD',
      'rev-parse --absolute-git-dir',
      'rev-parse --path-format=absolute --git-common-dir',
    ]);
    expect(facts.repoPath).toBe(alone(cwd, ['rev-parse', '--show-toplevel']));
    expect(facts.branch).toBeNull();
    expect(facts.headSha).toBeNull();
    expect(facts.isWorktree).toBe(false);
    const failures = facts.failures.join('\n');
    expect(failures).toContain('branch: git rev-parse --abbrev-ref HEAD: ');
    expect(failures).toContain('headSha: git rev-parse HEAD: ');
    expect(failures).not.toContain('--show-toplevel --absolute-git-dir');
  });

  test.each(['bare', 'insideGit', 'notRepo'])(
    "%s: the batch fails, and the one failure is the top level's own",
    (name) => {
      const facts = readGitFacts(repos[name] ?? '');
      expect(revParseCalls()).toEqual([
        `rev-parse ${BATCH[0]}`,
        'rev-parse --show-toplevel',
      ]);
      expect(facts.repoPath).toBeNull();
      expect(facts.failures).toHaveLength(1);
      expect(facts.failures[0]).toStartWith(
        'repoPath: git rev-parse --show-toplevel: ',
      );
    },
  );
});

describe('measureCheckout: four rev-parse answers', () => {
  const FOUR =
    'rev-parse --show-toplevel --absolute-git-dir --path-format=absolute --git-common-dir --abbrev-ref HEAD';

  test.each(['normal', 'detached', 'linked'])(
    'a %s checkout: one call, and what the four separate calls said',
    async (name) => {
      const cwd = repos[name] ?? '';
      const measured = await measureCheckoutCached(cwd, null);
      expect(
        revParseCalls().filter((c) => c.includes('--show-toplevel')),
      ).toEqual([FOUR]);
      expect(revParseCalls()).not.toContain('rev-parse --absolute-git-dir');
      expect(measured.kind).toBe('measured');
      if (measured.kind !== 'measured') return;
      expect(measured.top).toBe(
        alone(cwd, ['rev-parse', '--show-toplevel']) ?? '',
      );
      expect(measured.branch).toEqual({
        ok: true,
        value: alone(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']) ?? '',
      });
      expect(measured.commonDir).toBe(
        alone(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
      );
      expect(measured.repo).toBe(name === 'linked' ? 'parent' : name);
    },
  );

  test('an unborn branch: the batch fails, and the branch failure names its own call', async () => {
    const measured = await measureCheckoutCached(repos.unborn ?? '', null);
    const calls = revParseCalls();
    expect(calls[0]).toBe(FOUR);
    expect(calls).toContain('rev-parse --show-toplevel');
    expect(calls).toContain('rev-parse --abbrev-ref HEAD');
    expect(measured.kind).toBe('measured');
    if (measured.kind !== 'measured') return;
    expect(measured.branch.ok).toBe(false);
    expect(measured.branch.ok ? '' : measured.branch.reason).toStartWith(
      'branch: git rev-parse --abbrev-ref HEAD exited 128',
    );
  });

  test.each(['bare', 'insideGit', 'notRepo'])(
    "%s: the batch fails, and the checkout is unreadable by the top level's own call",
    async (name) => {
      const cwd = repos[name] ?? '';
      const measured = await measureCheckoutCached(cwd, null);
      expect(revParseCalls()).toEqual([FOUR, 'rev-parse --show-toplevel']);
      expect(measured.kind).toBe('failed');
      expect(measured.kind === 'failed' ? measured.reason : '').toStartWith(
        `checkout unreadable: ${cwd} (git rev-parse --show-toplevel exited 128`,
      );
    },
  );
});

describe('buildCoreInventory: the repo root and the current branch', () => {
  const TWO = 'rev-parse --show-toplevel --abbrev-ref HEAD';

  test('a branch: one call for both', () => {
    const cwd = repos.normal ?? '';
    const inventory = buildCoreInventory({cwd});
    expect(revParseCalls()[0]).toBe(TWO);
    expect(revParseCalls()).not.toContain('rev-parse --show-toplevel');
    expect(inventory?.repoRoot).toBe(
      alone(cwd, ['rev-parse', '--show-toplevel']) ?? '',
    );
    expect(inventory?.currentBranch).toBe('main');
  });

  test('a detached HEAD: one call, and no current branch', () => {
    const inventory = buildCoreInventory({cwd: repos.detached ?? ''});
    expect(revParseCalls()[0]).toBe(TWO);
    expect(revParseCalls()).not.toContain('rev-parse --show-toplevel');
    // No branch and no remote: no baseline, so no inventory at all (as before).
    expect(inventory?.currentBranch ?? null).toBeNull();
  });

  test('an unborn branch: the batch fails, and each is asked alone', () => {
    buildCoreInventory({cwd: repos.unborn ?? ''});
    expect(revParseCalls().slice(0, 3)).toEqual([
      TWO,
      'rev-parse --show-toplevel',
      'rev-parse --abbrev-ref HEAD',
    ]);
  });

  test.each(['bare', 'notRepo'])(
    '%s: the batch fails, the root is asked alone, and there is no inventory',
    (name) => {
      expect(buildCoreInventory({cwd: repos[name] ?? ''})).toBeNull();
      expect(revParseCalls()).toEqual([TWO, 'rev-parse --show-toplevel']);
    },
  );
});
