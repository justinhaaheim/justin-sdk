/**
 * pre-commit-ts-check (home-base-pp1vx.1.2). The pure gate is tested directly;
 * the acceptance criteria are tested with REAL commits in scratch repos under
 * $TMPDIR, through a real pre-commit hook that runs this SDK's cli.ts. The
 * "type-check" is a fake that logs each run and fails while a BROKEN file
 * exists, so whether it ran, and whether a red result blocks, is observable.
 */

import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, test} from 'bun:test';
import {spawnSync} from 'child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import {join} from 'path';

import {
  canAffectTypeCheck,
  decideTsCheck,
  decisionLine,
  FULL_CHECK_FAILED_LINE,
  type LastGreen,
  resolveGateKnob,
} from '../src/pre-commit-ts-check/gate';
import {addLinkedWorktree, git} from './git-fixtures';
import {createSandbox} from './sandbox';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const NOW = new Date('2026-10-29T12:00:00Z');
const hoursAgo = (h: number): Date => new Date(NOW.getTime() - h * 3_600_000);

describe('canAffectTypeCheck', () => {
  test.each([
    '.beads/issues.jsonl',
    '.beads/config.yaml',
    'README.md',
    'docs/Notes.MD',
    'data/log.jsonl',
    'notes.txt',
    'assets/icon.png',
    '.gitignore',
    'sub/.prettierignore',
  ])('%s cannot', (path) => {
    expect(canAffectTypeCheck(path)).toBe(false);
  });

  test.each([
    'src/a.ts',
    'src/b.tsx',
    'src/c.mts',
    'tsconfig.json',
    'tsconfig.node.json',
    'package.json',
    'bun.lock',
    'bun.lockb',
    'yarn.lock',
    'pnpm-lock.yaml',
    'package-lock.json',
    'scripts/x.mjs',
    'data/fixture.json',
    'bin/some-tool',
    'docs/page.mdx',
    'mise.toml',
    'notes.md.ts',
    'sub/.beads/x.ts',
  ])('%s can', (path) => {
    expect(canAffectTypeCheck(path)).toBe(true);
  });
});

describe('resolveGateKnob', () => {
  test('absent config: always, every 24h, no problems', () => {
    expect(resolveGateKnob(null)).toEqual({
      everyHours: 24,
      mode: 'always',
      problems: [],
    });
  });

  test('an unusable config file type-checks every commit and says so', () => {
    const knob = resolveGateKnob('x.json: not valid JSON');
    expect(knob.mode).toBe('always');
    expect(knob.problems).toEqual([
      'ts-check: type-checking every commit, because justin-sdk.config.json could not be used (x.json: not valid JSON)',
    ]);
  });

  test('the knob on', () => {
    expect(
      resolveGateKnob({
        componentConfig: {
          husky: {
            fullTsCheckEveryHours: 6,
            tsCheckOnCommit: 'onlyWhenTsStaged',
          },
        },
      }),
    ).toEqual({everyHours: 6, mode: 'onlyWhenTsStaged', problems: []});
  });

  test('an unknown mode type-checks every commit and names the value', () => {
    const knob = resolveGateKnob({
      componentConfig: {husky: {tsCheckOnCommit: 'onlyWhenTSStaged'}},
    });
    expect(knob.mode).toBe('always');
    expect(knob.problems[0]).toContain('"onlyWhenTSStaged"');
  });

  test('a non-number interval keeps the default and names the value', () => {
    const knob = resolveGateKnob({
      componentConfig: {
        husky: {
          fullTsCheckEveryHours: '24',
          tsCheckOnCommit: 'onlyWhenTsStaged',
        },
      },
    });
    expect(knob.everyHours).toBe(24);
    expect(knob.problems[0]).toContain('fullTsCheckEveryHours is "24"');
  });
});

describe('decideTsCheck', () => {
  const on = {everyHours: 24, mode: 'onlyWhenTsStaged' as const, now: NOW};
  const fresh: LastGreen = {at: hoursAgo(2), kind: 'recorded'};
  const beadsOnly = {
    kind: 'listed' as const,
    paths: ['.beads/issues.jsonl'],
  };

  test('knob off runs, whatever is staged, and prints nothing', () => {
    const decision = decideTsCheck({
      ...on,
      lastGreen: fresh,
      mode: 'always',
      staged: beadsOnly,
    });
    expect(decision).toEqual({reason: 'always', run: true});
    expect(decisionLine(decision)).toBeNull();
  });

  test('beads-only with a fresh green check skips, in one line', () => {
    const decision = decideTsCheck({
      ...on,
      lastGreen: fresh,
      staged: beadsOnly,
    });
    expect(decision.run).toBe(false);
    const line = decisionLine(decision) ?? '';
    expect(line).toStartWith('ts-check skipped: no staged file');
    expect(line).toContain('.beads/issues.jsonl');
    expect(line).toContain('2h 0m ago');
    expect(line).not.toContain('\n');
  });

  test('nothing staged with a fresh green check skips', () => {
    const decision = decideTsCheck({
      ...on,
      lastGreen: fresh,
      staged: {kind: 'listed', paths: []},
    });
    expect(decision.run).toBe(false);
    expect(decisionLine(decision)).toStartWith(
      'ts-check skipped: nothing is staged',
    );
  });

  test('any TS-relevant path runs, naming it', () => {
    const decision = decideTsCheck({
      ...on,
      lastGreen: fresh,
      staged: {kind: 'listed', paths: ['.beads/issues.jsonl', 'package.json']},
    });
    expect(decision).toEqual({
      reason: 'ts-staged',
      relevant: ['package.json'],
      run: true,
    });
  });

  test('staged files that could not be listed run (never read as empty)', () => {
    const decision = decideTsCheck({
      ...on,
      lastGreen: fresh,
      staged: {error: 'git exploded', kind: 'unknown'},
    });
    expect(decision.run).toBe(true);
    expect(decisionLine(decision)).toContain('git exploded');
  });

  test.each<[string, LastGreen, string]>([
    ['no record', {kind: 'none'}, 'no green type-check on record'],
    [
      'an unreadable record',
      {error: 'EACCES', kind: 'unreadable'},
      'could not be read (EACCES)',
    ],
    [
      'a record exactly 24h old',
      {at: hoursAgo(24), kind: 'recorded'},
      'was 1d 0h ago (the limit is 24h)',
    ],
    [
      'a record dated in the future',
      {at: hoursAgo(-1), kind: 'recorded'},
      'dated in the future',
    ],
  ])('beads-only with %s runs the regular full check', (_, lastGreen, why) => {
    const decision = decideTsCheck({...on, lastGreen, staged: beadsOnly});
    expect(decision.run).toBe(true);
    expect(decision.reason).toBe('full-check-due');
    const line = decisionLine(decision) ?? '';
    expect(line).toStartWith('ts-check: running the regular full check.');
    expect(line).toContain(why);
  });

  test('fullTsCheckEveryHours 0 type-checks every commit', () => {
    const decision = decideTsCheck({
      ...on,
      everyHours: 0,
      lastGreen: {at: hoursAgo(0.01), kind: 'recorded'},
      staged: beadsOnly,
    });
    expect(decision.run).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Real commits through a real hook
// ---------------------------------------------------------------------------

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

/** Git's own variables from an enclosing hook would point git at the wrong repo. */
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value != null && !key.startsWith('GIT_')) env[key] = value;
  }
  return env;
}

const FAKE_TSC = `#!/bin/sh
echo run >> "$(git rev-parse --git-common-dir)/fake-tsc.log"
if [ -e BROKEN ]; then echo "fake-tsc: error TS2322 in src/a.ts" >&2; exit 1; fi
exit 0
`;

function makeRepo(knob: Record<string, unknown> | null): string {
  const sb = createSandbox();
  sandboxes.push(sb);
  const repo = join(sb.path, 'repo');
  mkdirSync(join(repo, 'src'), {recursive: true});
  git(repo, ['init', '-q', '-b', 'main', '.']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  // Explicit, so a global core.hooksPath on the host cannot bypass the hook.
  git(repo, ['config', 'core.hooksPath', '.githooks']);
  mkdirSync(join(repo, '.githooks'));
  writeFileSync(
    join(repo, '.githooks', 'pre-commit'),
    `#!/bin/sh\nexec '${process.execPath}' '${CLI}' pre-commit-ts-check -- sh ./fake-tsc.sh\n`,
  );
  chmodSync(join(repo, '.githooks', 'pre-commit'), 0o755);
  writeFileSync(join(repo, 'fake-tsc.sh'), FAKE_TSC);
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  mkdirSync(join(repo, '.beads'));
  writeFileSync(join(repo, '.beads', 'issues.jsonl'), '{"id":"x-1"}\n');
  if (knob != null) {
    writeFileSync(
      join(repo, 'justin-sdk.config.json'),
      JSON.stringify({componentConfig: {husky: knob}}),
    );
  }
  return repo;
}

function tscRuns(repo: string): number {
  const log = join(
    repo,
    git(repo, ['rev-parse', '--git-common-dir']).trim(),
    'fake-tsc.log',
  );
  return existsSync(log)
    ? readFileSync(log, 'utf-8').split('\n').length - 1
    : 0;
}

function commit(
  repo: string,
  args: string[] = [],
): {code: number; output: string} {
  const result = spawnSync('git', ['commit', '-q', '-m', 'test', ...args], {
    cwd: repo,
    encoding: 'utf-8',
    env: cleanEnv(),
  });
  return {code: result.status ?? -1, output: result.stdout + result.stderr};
}

function stampFile(repo: string): string {
  return join(
    repo,
    git(repo, [
      'rev-parse',
      '--git-path',
      'justin-sdk/ts-check-last-green.json',
    ]).trim(),
  );
}

function stampAt(repo: string): string {
  return (JSON.parse(readFileSync(stampFile(repo), 'utf-8')) as {at: string})
    .at;
}

function appendBead(repo: string, id: string): void {
  writeFileSync(
    join(repo, '.beads', 'issues.jsonl'),
    `${readFileSync(join(repo, '.beads', 'issues.jsonl'), 'utf-8')}{"id":"${id}"}\n`,
  );
  git(repo, ['add', '.beads/issues.jsonl']);
}

const ON = {tsCheckOnCommit: 'onlyWhenTsStaged'};

/** First commit of everything: TS is staged, so the check runs and records green. */
function seed(repo: string, knobOn = true): void {
  git(repo, ['add', '-A']);
  const first = commit(repo);
  expect(first.code).toBe(0);
  expect(tscRuns(repo)).toBe(1);
  // Knob off writes nothing at all: the old hook line, unchanged.
  expect(existsSync(stampFile(repo))).toBe(knobOn);
}

describe('pre-commit hook, knob on (real commits)', () => {
  test('AC1: a beads-only commit runs no type-check and says so in one line', () => {
    const repo = makeRepo(ON);
    seed(repo);
    appendBead(repo, 'x-2');
    const result = commit(repo);
    expect(result.code).toBe(0);
    expect(tscRuns(repo)).toBe(1);
    const lines = result.output.split('\n').filter((l) => l.trim() !== '');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith(
      'ts-check skipped: no staged file can affect type-checking (.beads/issues.jsonl). Last green check',
    );
  });

  test.each(['src/a.ts', 'tsconfig.json', 'package.json', 'bun.lock'])(
    'AC2: staging %s runs the type-check, and a red one blocks the commit',
    (path) => {
      const repo = makeRepo(ON);
      seed(repo);
      writeFileSync(join(repo, path), `// changed ${path}\n`);
      git(repo, ['add', path]);
      // Negative control: the same commit with the type-check red is refused.
      writeFileSync(join(repo, 'BROKEN'), '');
      const red = commit(repo);
      expect(red.code).not.toBe(0);
      expect(red.output).toContain('fake-tsc: error TS2322');
      expect(red.output).toContain(
        `ts-check: running, because 1 staged file can affect type-checking: ${path}`,
      );
      expect(tscRuns(repo)).toBe(2);
      rmSync(join(repo, 'BROKEN'));
      expect(commit(repo).code).toBe(0);
      expect(tscRuns(repo)).toBe(3);
    },
  );

  test('AC2: `git commit -a` shows the hook the temporary index', () => {
    const repo = makeRepo(ON);
    seed(repo);
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 2;\n');
    const result = commit(repo, ['-a']);
    expect(result.code).toBe(0);
    expect(result.output).toContain('src/a.ts');
    expect(tscRuns(repo)).toBe(2);
  });

  test('AC2: renaming a .ts file to .md still counts the .ts half', () => {
    const repo = makeRepo(ON);
    seed(repo);
    git(repo, ['mv', 'src/a.ts', 'src/a.md']);
    expect(commit(repo).code).toBe(0);
    expect(tscRuns(repo)).toBe(2);
  });

  test('AC3: a stale green record makes a beads-only commit run the full check; red blocks it', () => {
    const repo = makeRepo(ON);
    seed(repo);
    const stamp = stampFile(repo);
    const stale = new Date(Date.now() - 25 * 3_600_000).toISOString();
    writeFileSync(stamp, JSON.stringify({at: stale}));
    writeFileSync(join(repo, 'BROKEN'), '');
    appendBead(repo, 'x-2');

    const red = commit(repo);
    expect(red.code).not.toBe(0);
    expect(red.output).toContain(
      'ts-check: running the regular full check. Nothing staged affects type-checking, but the last green type-check was 1d 1h ago (the limit is 24h)',
    );
    expect(red.output).toContain(FULL_CHECK_FAILED_LINE);
    expect(tscRuns(repo)).toBe(2);
    // A red check never refreshes the record, so the next commit checks again.
    expect(stampAt(repo)).toBe(stale);

    rmSync(join(repo, 'BROKEN'));
    expect(commit(repo).code).toBe(0);
    expect(tscRuns(repo)).toBe(3);
    const refreshed = new Date(stampAt(repo));
    expect(Date.now() - refreshed.getTime()).toBeLessThan(60_000);

    appendBead(repo, 'x-3');
    expect(commit(repo).output).toStartWith('ts-check skipped:');
    expect(tscRuns(repo)).toBe(3);
  });

  test('AC3: the record is per checkout: a new worktree runs its own full check first', () => {
    const repo = makeRepo(ON);
    seed(repo);
    const wt = addLinkedWorktree(repo, join(repo, '..', 'wt'), 'worktree-test');
    appendBead(wt, 'x-2');
    const result = commit(wt);
    expect(result.code).toBe(0);
    expect(result.output).toContain('no green type-check on record');
    expect(tscRuns(repo)).toBe(2);
    expect(stampFile(wt)).not.toBe(stampFile(repo));
  });

  test('AC4 is untouched: the gate decides only the type-check line of the hook', () => {
    // The hook keeps its lint-staged line after this one; with the type-check
    // skipped this command exits 0, so `sh -e` goes on to lint-staged.
    const repo = makeRepo(ON);
    seed(repo);
    appendBead(repo, 'x-2');
    const result = spawnSync(
      process.execPath,
      [CLI, 'pre-commit-ts-check', '--', 'sh', './fake-tsc.sh'],
      {cwd: repo, encoding: 'utf-8', env: cleanEnv()},
    );
    expect(result.status).toBe(0);
  });
});

describe('pre-commit hook, knob off (real commits)', () => {
  test('no config: a beads-only commit still type-checks, and the gate prints nothing', () => {
    const repo = makeRepo(null);
    seed(repo, false);
    appendBead(repo, 'x-2');
    const result = commit(repo);
    expect(result.code).toBe(0);
    expect(result.output).toBe('');
    expect(tscRuns(repo)).toBe(2);
  });

  test('"always" written out behaves the same, and a red check blocks', () => {
    const repo = makeRepo({tsCheckOnCommit: 'always'});
    seed(repo, false);
    appendBead(repo, 'x-2');
    writeFileSync(join(repo, 'BROKEN'), '');
    expect(commit(repo).code).not.toBe(0);
    expect(tscRuns(repo)).toBe(2);
  });
});
