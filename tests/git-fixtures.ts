/**
 * Real-git fixture helpers, shared by the worktree tests.
 *
 * Fixtures are real git repos in $TMPDIR because the behavior under test IS git
 * behavior — worktree admin files, `--git-dir` vs `--git-common-dir`,
 * `check-ignore`'s index awareness — so mocking git would test nothing.
 *
 * Every fixture repo pins `core.excludesFile` to an empty controlled file. The
 * machine's real global ignore (~/.config/git/ignore) DOES ignore
 * .claude/worktrees on Justin's machine, and these tests turn on exactly which
 * files are gitignored, so without this they would pass or fail depending on the
 * host.
 *
 * Extracted from tests/worktree-setup.test.ts (dispatch 1), unchanged.
 */

import {execFileSync} from 'child_process';
import {mkdirSync, readFileSync, writeFileSync} from 'fs';
import {dirname, join} from 'path';

import {SDK_REPO_URL} from '../src/sdk-latest';
import {createSandbox, type Sandbox} from './sandbox';

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** The identity every fixture repo commits as. */
export const FIXTURE_IDENTITY = {email: 'test@example.com', name: 'Test'};

export type FixtureRepoConfig = {
  /** `core.excludesFile`; absent: not set. */
  excludesFile?: string;
  /** `user.email`, then `user.name`; absent: neither is set. */
  identity?: {email: string; name: string};
};

/**
 * A value `git config` writes as it is: no quoting, no escapes. Anything else
 * (a space, `#`, `;`, a quote, a backslash, a control character) goes through
 * `git config` itself.
 */
const PLAIN_CONFIG_VALUE = /^[A-Za-z0-9._@/+:-]+$/;

/**
 * The `.git/config` that `git config user.email`, `git config user.name` and
 * then `git config core.excludesFile` would leave, run in that order on the
 * config `git init` just wrote; null when that is not certain.
 *
 * It is certain only for the config a fresh `git init` writes: one `[core]`
 * section and nothing else. `git config` appends a key it does not find to
 * the end of its section, and a section it does not find to the end of the
 * file, with a tab before the key and ` = ` around the value. So user.email
 * creates `[user]` at the end, user.name joins it, and core.excludesFile goes
 * at the end of `[core]`, which is just before `[user]`. tests/git-fixtures.test.ts
 * compares the result byte for byte with what git itself writes.
 */
export function fixtureConfigText(
  initConfig: string,
  config: FixtureRepoConfig,
): string | null {
  const lines = initConfig.split('\n');
  if (lines[0] !== '[core]' || !initConfig.endsWith('\n')) return null;
  if (lines.slice(1).some((line) => line.startsWith('['))) return null;
  const values = [
    config.excludesFile,
    config.identity?.email,
    config.identity?.name,
  ];
  if (values.some((v) => v != null && !PLAIN_CONFIG_VALUE.test(v))) {
    return null;
  }
  let text = initConfig;
  if (config.excludesFile != null) {
    text += `\texcludesFile = ${config.excludesFile}\n`;
  }
  if (config.identity != null) {
    text += `[user]\n\temail = ${config.identity.email}\n\tname = ${config.identity.name}\n`;
  }
  return text;
}

/**
 * `git init -q -b main .` in `root`, then the fixture's local config, in ONE
 * git process where the old four (init, user.email, user.name,
 * core.excludesFile) were four (home-base-ejsq2.2). The repo it leaves is the
 * one those four left, byte for byte: `.git/config` is written as
 * `fixtureConfigText` says git would write it, and when that is not certain
 * the keys go through `git config`, as before.
 */
export function initFixtureRepo(root: string, config: FixtureRepoConfig): void {
  git(root, ['init', '-q', '-b', 'main', '.']);
  const configPath = join(root, '.git', 'config');
  const text = fixtureConfigText(readFileSync(configPath, 'utf-8'), config);
  if (text != null) {
    writeFileSync(configPath, text);
    return;
  }
  if (config.identity != null) {
    git(root, ['config', 'user.email', config.identity.email]);
    git(root, ['config', 'user.name', config.identity.name]);
  }
  if (config.excludesFile != null) {
    git(root, ['config', 'core.excludesFile', config.excludesFile]);
  }
}

/**
 * A bare git repo carrying the tag this SDK would pin to.
 *
 * WHY EVERY TEST THAT INSTALLS ANYTHING NEEDS ONE (dchjw.17 F7). `add`,
 * `install`, `init` and every installer chain `base-setup`, whose
 * `stepDepsHasSdk` verifies the pin tag with a real `git ls-remote` against
 * github — once per component, per test. Measured with a logging `git` shim on
 * PATH: 38 calls to github.com in one suite run. That is a suite that fails on
 * a plane, that cannot be trusted offline, and whose "measured" outcomes are
 * partly a network's opinion. Passing this as `sdkRepoUrl` makes the real
 * verification run, hermetically.
 *
 * `register` is the caller's sandbox tracker: the fixture gets its OWN sandbox,
 * because built inside a project sandbox it leaves two untracked directories
 * there and `init`'s preflight then refuses the dirty tree — a failure that
 * looks like the feature is broken and is not.
 */
export function sdkRemoteWithOwnTag(
  register: (sb: Sandbox) => Sandbox,
): string {
  const host = register(createSandbox());
  const work = join(host.path, 'remote-work');
  mkdirSync(work, {recursive: true});
  initFixtureRepo(work, {identity: FIXTURE_IDENTITY});
  git(work, ['commit', '-q', '--allow-empty', '-m', 'init']);
  const version = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf-8'),
  ) as {version: string};
  git(work, ['tag', `v${version.version}`]);
  const bare = join(host.path, 'remote.git');
  git(host.path, ['clone', '-q', '--bare', work, bare]);
  return bare;
}

/**
 * One sdkRemoteWithOwnTag for a whole test file: built on the first `url()`,
 * removed by `cleanup()`, which the file calls from `afterAll`.
 *
 * Sharing is safe because the product only ever READS the remote (`git
 * ls-remote --tags`), and it saves the four git calls of a fresh remote in
 * every test after the first (home-base-ejsq2.5).
 */
export function sharedSdkRemote(): {cleanup: () => void; url: () => string} {
  let host: Sandbox | null = null;
  let url: string | null = null;
  return {
    cleanup() {
      host?.cleanup();
      host = null;
      url = null;
    },
    url() {
      url ??= sdkRemoteWithOwnTag((sb) => {
        host = sb;
        return sb;
      });
      return url;
    },
  };
}

/**
 * Run `fn` while git answers the published SDK repo URL from `remote`, a local
 * bare repo (`url.<remote>.insteadOf <SDK_REPO_URL>`, given to every git child
 * of this process through GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n /
 * GIT_CONFIG_VALUE_n, git 2.31 and later).
 *
 * ONLY for a test that must exercise the DEFAULT remote on purpose: the
 * negative controls in tests/sdk-repo-url-forwarding.test.ts, which show that
 * a call without `sdkRepoUrl` asks SDK_REPO_URL. The product still runs its
 * real `git ls-remote --tags <SDK_REPO_URL>`; git fetches the listing from the
 * local repo instead of GitHub. Everywhere else, pass `sdkRepoUrl`: every
 * product path that verifies the SDK pin takes it (home-base-ejsq2.9), it is
 * the product's own seam, and it is the remote the product's messages name.
 *
 * A GIT_CONFIG_COUNT already set is extended, never replaced; a count that is
 * not a whole number throws rather than guessing. Every variable it touches
 * is put back as it was, on success and on throw.
 */
export async function withSdkRepoAnsweredBy<T>(
  remote: string,
  fn: () => Promise<T>,
): Promise<T> {
  const countText = process.env.GIT_CONFIG_COUNT;
  const count = countText == null ? 0 : Number(countText);
  if (!Number.isInteger(count) || count < 0 || countText === '') {
    throw new Error(
      `withSdkRepoAnsweredBy: GIT_CONFIG_COUNT is ${JSON.stringify(countText)}, not a whole number`,
    );
  }
  const names = [
    'GIT_CONFIG_COUNT',
    `GIT_CONFIG_KEY_${count}`,
    `GIT_CONFIG_VALUE_${count}`,
  ];
  const previous = names.map((name) => process.env[name]);
  process.env[`GIT_CONFIG_KEY_${count}`] = `url.${remote}.insteadOf`;
  process.env[`GIT_CONFIG_VALUE_${count}`] = SDK_REPO_URL;
  process.env.GIT_CONFIG_COUNT = String(count + 1);
  try {
    return await fn();
  } finally {
    names.forEach((name, i) => {
      const value = previous[i];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    });
  }
}

/** Write a file under `root`, creating parent directories. */
export function write(root: string, relPath: string, content: string): void {
  const full = join(root, relPath);
  mkdirSync(dirname(full), {recursive: true});
  writeFileSync(full, content);
}

/**
 * Create a committed git repo at `<sandbox>/primary` containing `files`.
 * Anything matching the repo's own .gitignore stays untracked (`git add -A`
 * honors it), which is how the gitignored fixtures are made.
 */
export function initPrimary(
  sb: Sandbox,
  files: Record<string, string>,
  options?: {
    /**
     * Paths to `git add -f`, i.e. track them even though .gitignore matches.
     * That combination — tracked AND ignore-pattern-matched — is the only way
     * to exercise `git check-ignore`'s index awareness.
     */
    forceAdd?: string[];
  },
): string {
  const primary = join(sb.path, 'primary');
  mkdirSync(primary, {recursive: true});
  const excludes = join(primary, '.git', 'controlled-excludes');
  initFixtureRepo(primary, {
    excludesFile: excludes,
    identity: FIXTURE_IDENTITY,
  });
  writeFileSync(excludes, '');
  for (const [relPath, content] of Object.entries(files)) {
    write(primary, relPath, content);
  }
  git(primary, ['add', '-A']);
  for (const relPath of options?.forceAdd ?? []) {
    git(primary, ['add', '-f', '--', relPath]);
  }
  git(primary, ['commit', '-qm', 'init']);
  return primary;
}

export function addLinkedWorktree(
  primary: string,
  dest: string,
  branch: string,
): string {
  mkdirSync(dirname(dest), {recursive: true});
  git(primary, ['worktree', 'add', '-q', '-b', branch, dest, 'main']);
  return dest;
}

/**
 * Create a standalone committed repo at `<sandbox>/<name>`, usable as a
 * submodule source. Same controlled-excludes discipline as initPrimary.
 */
export function initRepo(
  sb: Sandbox,
  name: string,
  files: Record<string, string>,
): string {
  const root = join(sb.path, name);
  mkdirSync(root, {recursive: true});
  const excludes = join(root, '.git', 'controlled-excludes');
  initFixtureRepo(root, {excludesFile: excludes, identity: FIXTURE_IDENTITY});
  writeFileSync(excludes, '');
  for (const [relPath, content] of Object.entries(files)) {
    write(root, relPath, content);
  }
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'init']);
  return root;
}

/**
 * Register `source` as a submodule of `repo` at `relPath`, and commit it.
 *
 * `-c protocol.file.allow=always` is REQUIRED: git refuses the `file` transport
 * for submodules by default (CVE-2022-39253), and a fixture's submodule URL can
 * only be a local path. It is passed on the COMMAND LINE because git
 * deliberately ignores `protocol.*.allow` from repo-local config — verified,
 * setting it with `git config` in the fixture does nothing.
 */
export function addSubmodule(
  repo: string,
  source: string,
  relPath: string,
): void {
  git(repo, [
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    '-q',
    source,
    relPath,
  ]);
  git(repo, ['commit', '-qm', `add submodule ${relPath}`]);
}

/**
 * Run `fn` with git's file-transport restriction lifted for CHILD processes.
 *
 * The production code must never pass `-c protocol.file.allow=always` (real
 * consumers use https/ssh URLs, and hardcoding a protocol override in a command
 * that clones would be a security regression), so the fixture supplies it out of
 * band via the env instead. `GIT_ALLOW_PROTOCOL` is a whitelist, so `file` is
 * the ONLY protocol allowed inside `fn` — which is exactly right for a hermetic
 * test: any accidental network clone fails loudly.
 */
export function withFileSubmodulesAllowed<T>(fn: () => T): T {
  const previous = process.env.GIT_ALLOW_PROTOCOL;
  process.env.GIT_ALLOW_PROTOCOL = 'file';
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.GIT_ALLOW_PROTOCOL;
    } else {
      process.env.GIT_ALLOW_PROTOCOL = previous;
    }
  }
}
