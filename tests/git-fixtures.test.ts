/**
 * The fixture repo builder (tests/git-fixtures.ts, home-base-ejsq2.2).
 *
 * `initFixtureRepo` replaced four git processes (init, user.email, user.name,
 * core.excludesFile) with one. What these tests hold it to: the repo it
 * leaves is the repo the four left. Every file under `.git`, its bytes and
 * its mode, is compared with a reference built the old way, by git itself,
 * in a sibling directory; each repo's own path is the only thing normalised.
 */
import {afterAll, describe, expect, test} from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, relative} from 'node:path';

import {
  FIXTURE_IDENTITY,
  fixtureConfigText,
  type FixtureRepoConfig,
  git,
  initFixtureRepo,
  initPrimary,
} from './git-fixtures';
import {createSandbox, type Sandbox} from './sandbox';

const base = mkdtempSync(join(tmpdir(), 'git-fixtures-test-'));
const sandboxes: Sandbox[] = [];
afterAll(() => {
  for (const sb of sandboxes) sb.cleanup();
  rmSync(base, {force: true, recursive: true});
});

let dirCount = 0;
function freshDir(label: string): string {
  dirCount += 1;
  const dir = join(base, `${dirCount}-${label}`);
  mkdirSync(dir, {recursive: true});
  return dir;
}

/** The old way, verbatim: one git process per step. */
function referenceRepo(root: string, config: FixtureRepoConfig): void {
  git(root, ['init', '-q', '-b', 'main', '.']);
  if (config.identity != null) {
    git(root, ['config', 'user.email', config.identity.email]);
    git(root, ['config', 'user.name', config.identity.name]);
  }
  if (config.excludesFile != null) {
    git(root, ['config', 'core.excludesFile', config.excludesFile]);
  }
}

/**
 * Every entry under `<root>/.git`: its path, its mode, and for a file its
 * bytes, with `root` written as `<ROOT>`. `skip` leaves out paths (the object
 * store, whose commits carry a timestamp).
 */
function gitDirState(root: string, skip: string[] = []): string[] {
  const gitDir = join(root, '.git');
  const out: string[] = [];
  function walk(dir: string): void {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const rel = relative(gitDir, full);
      if (skip.some((s) => rel === s || rel.startsWith(`${s}/`))) continue;
      const stat = statSync(full);
      const mode = (stat.mode & 0o777).toString(8);
      if (stat.isDirectory()) {
        out.push(`${rel}/ ${mode}`);
        walk(full);
      } else {
        const bytes = readFileSync(full, 'utf-8').split(root).join('<ROOT>');
        out.push(`${rel} ${mode}\n${bytes}`);
      }
    }
  }
  walk(gitDir);
  return out;
}

/** `excludesFile` under the repo's own .git, as every fixture writes it. */
function withExcludes(root: string, identity: boolean): FixtureRepoConfig {
  const config: FixtureRepoConfig = {
    excludesFile: join(root, '.git', 'controlled-excludes'),
  };
  if (identity) config.identity = FIXTURE_IDENTITY;
  return config;
}

describe('initFixtureRepo leaves the repo the four git calls left', () => {
  const cases: {
    config: (root: string) => FixtureRepoConfig;
    label: string;
  }[] = [
    {
      config: (root) => withExcludes(root, true),
      label: 'identity and excludes',
    },
    {config: () => ({identity: FIXTURE_IDENTITY}), label: 'identity only'},
    {config: (root) => withExcludes(root, false), label: 'excludes only'},
    {config: () => ({}), label: 'neither'},
  ];

  for (const {config, label} of cases) {
    test(label, () => {
      const old = freshDir('old');
      const now = freshDir('new');
      referenceRepo(old, config(old));
      initFixtureRepo(now, config(now));
      expect(gitDirState(now)).toEqual(gitDirState(old));
    });
  }

  test('the reference really holds the keys (the comparison is not empty-vs-empty)', () => {
    const old = freshDir('old');
    referenceRepo(old, withExcludes(old, true));
    const listed = git(old, ['config', '--local', '--list']).trim().split('\n');
    expect(listed).toContain(
      `core.excludesfile=${join(old, '.git', 'controlled-excludes')}`,
    );
    expect(listed).toContain('user.email=test@example.com');
    expect(listed).toContain('user.name=Test');
  });

  test('a value git would quote goes through git config, and still matches', () => {
    const odd = 'Test #1; "quoted"';
    expect(
      fixtureConfigText('[core]\n\tbare = false\n', {
        identity: {email: 'a@b.c', name: odd},
      }),
    ).toBeNull();
    const old = freshDir('old with space');
    const now = freshDir('new with space');
    const config = (root: string): FixtureRepoConfig => ({
      excludesFile: join(root, '.git', 'controlled excludes'),
      identity: {email: 'test@example.com', name: odd},
    });
    referenceRepo(old, config(old));
    initFixtureRepo(now, config(now));
    expect(gitDirState(now)).toEqual(gitDirState(old));
  });

  test('a config that is not a fresh init is left to git config', () => {
    expect(
      fixtureConfigText('[core]\n\tbare = false\n[user]\n\tname = X\n', {
        identity: FIXTURE_IDENTITY,
      }),
    ).toBeNull();
    expect(fixtureConfigText('[core]\n\tbare = false', {})).toBeNull();
    expect(fixtureConfigText('', {})).toBeNull();
  });
});

describe('initPrimary, the main shared helper', () => {
  test('its .git (objects aside) equals the old four calls plus the same add and commit', () => {
    const sb = createSandbox();
    sandboxes.push(sb);
    const files = {'.gitignore': 'ignored/\n', 'README.md': '# hi\n'};
    const primary = initPrimary(sb, files);

    const old = join(freshDir('old primary'), 'primary');
    mkdirSync(old, {recursive: true});
    git(old, ['init', '-q', '-b', 'main', '.']);
    git(old, ['config', 'user.email', 'test@example.com']);
    git(old, ['config', 'user.name', 'Test']);
    const excludes = join(old, '.git', 'controlled-excludes');
    writeFileSync(excludes, '');
    git(old, ['config', 'core.excludesFile', excludes]);
    for (const [rel, content] of Object.entries(files)) {
      writeFileSync(join(old, rel), content);
    }
    git(old, ['add', '-A']);
    git(old, ['commit', '-qm', 'init']);

    // Objects, the index, refs and logs carry the commit's timestamp, so the
    // commit ids differ; config, hooks, info, HEAD and the excludes file do not.
    const skip = [
      'objects',
      'index',
      'logs',
      'refs',
      'ORIG_HEAD',
      'COMMIT_EDITMSG',
    ];
    expect(gitDirState(primary, skip)).toEqual(gitDirState(old, skip));
    expect(readFileSync(join(primary, '.git', 'config'), 'utf-8')).toBe(
      readFileSync(join(old, '.git', 'config'), 'utf-8')
        .split(old)
        .join(primary),
    );
    // The same tree, though: same files, same content, same ignore result.
    expect(git(primary, ['rev-parse', 'HEAD^{tree}'])).toBe(
      git(old, ['rev-parse', 'HEAD^{tree}']),
    );
    expect(git(primary, ['log', '-1', '--format=%an <%ae> %cn <%ce> %s'])).toBe(
      git(old, ['log', '-1', '--format=%an <%ae> %cn <%ce> %s']),
    );
  });
});
