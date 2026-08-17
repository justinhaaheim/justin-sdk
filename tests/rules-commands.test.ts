/**
 * Tests for `rules-update` and `rules-diff` — the PULL channel for the committed
 * per-repo rules artifact (home-base-q1hp, t6a0.21 D2b/D4/D5/D9).
 *
 * THE FOUR THINGS THAT WOULD BE SILENT IN PRODUCTION, which is what these tests
 * are actually for:
 *
 *  1. A COMMIT THAT TOOK MORE THAN THE RULES. `rules-update` runs in whatever
 *     tree Justin is mid-session in, so it is guaranteed to meet unrelated dirty
 *     files — and sometimes already-STAGED ones. Sweeping those into a
 *     "chore(rules)" commit would be invisible until someone read the history.
 *     Asserted git-status-shaped, with modified + untracked + staged dirt
 *     present, and against the commit's own name-only file list.
 *  2. WRITING DURING A HALF-DONE GIT OPERATION. The refusals are only worth
 *     anything if they happen BEFORE the write, so every refusal arm also
 *     asserts that no artifact file exists afterwards. The rebase arm doubles as
 *     the ordering proof: git detaches HEAD during a rebase (asserted here), so
 *     a naive check order would report the wrong fact and the wrong fix.
 *  3. "COULD NOT CHECK" REPORTED AS "IN SYNC" (critical rule 5). The managed
 *     clone keeps serving stale bytes when a refresh fails; both commands must
 *     refuse, and rules-diff's cannot-check report is asserted NOT to contain
 *     the in-sync claim. Each such arm has a working-origin negative control, so
 *     it cannot pass merely because the sandbox was broken.
 *  4. A PHANTOM DIFF. rules-diff must format the canonical side with the SAME
 *     prettier the writer used, and must ignore the stamp's date. Both are
 *     asserted by "write, then diff, expect IN-SYNC" — including with a fake
 *     repo-local prettier that marks the bytes it touches.
 *
 * Hermetic: JSDK_PROMPTS_DIR (or a sandboxed XDG_CONFIG_HOME plus a local
 * origin) means no network, and JSDK_PRIME_PRETTIER=0 keeps `bunx prettier` out
 * of it except in the one test that deliberately exercises a prettier binary.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {execFileSync, spawnSync} from 'child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import {join, relative, resolve} from 'path';

import {CRITICAL_RULES_CONFIG_KEY} from '../src/critical-rules-setup';
import {projectRulesFilePath} from '../src/plugin/lib/rules-file';
import {rulesDiff, RULES_DIFF_EXIT} from '../src/rules-diff';
import {
  describeGitState,
  RULES_UPDATE_EXIT,
  runRulesUpdate,
} from '../src/rules-update';
import {setQuiet} from '../src/setup-helpers';
import {git} from './git-fixtures';
import {createSandbox, type Sandbox} from './sandbox';

const CLI = resolve(import.meta.dirname, '..', 'src', 'cli.ts');
const ARTIFACT_REL = '.claude/rules/justin-sdk/critical-rules.md';
const TOOL_DIR_REL = '.claude/rules/justin-sdk';
/** Pinned stamp date, so artifact bytes are comparable across runs. */
const NOW = '2026-08-17';

const sandboxes: Sandbox[] = [];
function track(sb: Sandbox): Sandbox {
  sandboxes.push(sb);
  return sb;
}

const SAVED_ENV = {
  prettier: process.env.JSDK_PRIME_PRETTIER,
  promptsDir: process.env.JSDK_PROMPTS_DIR,
  repoUrl: process.env.JSDK_PROMPTS_REPO_URL,
  xdg: process.env.XDG_CONFIG_HOME,
};

function restoreEnv(name: string, value: string | undefined): void {
  if (value == null) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
  restoreEnv('JSDK_PRIME_PRETTIER', SAVED_ENV.prettier);
  restoreEnv('JSDK_PROMPTS_DIR', SAVED_ENV.promptsDir);
  restoreEnv('JSDK_PROMPTS_REPO_URL', SAVED_ENV.repoUrl);
  restoreEnv('XDG_CONFIG_HOME', SAVED_ENV.xdg);
  setQuiet(false);
});

// ---------------------------------------------------------------------------
// Fixtures (the shapes proven in tests/critical-rules-setup.test.ts)
// ---------------------------------------------------------------------------

const RULES_FILES: Record<string, string> = {
  'src/rules/index.md': ['@./alpha.md', '@./omega.md'].join('\n\n'),
  'src/rules/alpha.md': '# Alpha\n\nALPHA_RULE',
  'src/rules/omega.md': '# Omega\n\nOMEGA_RULE',
};

/** initRepo, but at an explicit path (the shared helper derives it from a name). */
function initRepoAt(root: string, files: Record<string, string>): string {
  mkdirSync(root, {recursive: true});
  git(root, ['init', '-q', '-b', 'main', '.']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);
  const excludes = join(root, '.git', 'controlled-excludes');
  writeFileSync(excludes, '');
  git(root, ['config', 'core.excludesFile', excludes]);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), {recursive: true});
    writeFileSync(full, content);
  }
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'init']);
  return root;
}

/** A prompts checkout as a REAL git repo, so the stamped sha is non-null. */
function gitPromptsFixture(): {dir: string; sha: string} {
  process.env.JSDK_PRIME_PRETTIER = '0';
  const sb = track(createSandbox());
  const dir = initRepoAt(join(sb.path, 'prompts'), RULES_FILES);
  process.env.JSDK_PROMPTS_DIR = dir;
  return {dir, sha: git(dir, ['rev-parse', 'HEAD']).trim()};
}

/** Commit a rules change in the prompts fixture — "something new was pushed". */
function editPrompts(dir: string): void {
  writeFileSync(join(dir, 'src/rules/alpha.md'), '# Alpha\n\nALPHA_RULE_V2');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'edit alpha']);
}

interface ProjectOptions {
  /** Pre-record a module selection. Omit for a repo that is not enrolled. */
  modules?: string[];
  /** Extra committed files (something unrelated to dirty). */
  files?: Record<string, string>;
}

function projectFixture(options: ProjectOptions = {}): string {
  const sb = track(createSandbox());
  const files: Record<string, string> = {
    'package.json': `${JSON.stringify({name: 'fixture'}, null, 2)}\n`,
    ...(options.files ?? {}),
  };
  files['justin-sdk.config.json'] =
    `${JSON.stringify(
      {
        components: ['base-setup', 'critical-rules-setup'],
        ...(options.modules != null
          ? {
              componentConfig: {
                [CRITICAL_RULES_CONFIG_KEY]: {modules: options.modules},
              },
            }
          : {}),
        lastSynced: '2000-01-01',
        version: '0.0.1-fixture',
      },
      null,
      2,
    )}\n`;
  return initRepoAt(join(sb.path, 'repo'), files);
}

/**
 * Point the managed-clone machinery at a sandbox and return where it will look.
 * Nothing here may touch the real ~/.config/justin-sdk/prompts — the assertions
 * name the sandbox path, so a leak fails loudly rather than quietly fetching
 * (or `reset --hard`ing) Justin's real clone.
 */
function sandboxedManagedClone(): {cloneDir: string; sandbox: string} {
  process.env.JSDK_PRIME_PRETTIER = '0';
  delete process.env.JSDK_PROMPTS_DIR; // force the managed-clone path
  const sb = track(createSandbox());
  process.env.XDG_CONFIG_HOME = sb.path;
  return {cloneDir: join(sb.path, 'justin-sdk', 'prompts'), sandbox: sb.path};
}

/** Every path git reports as changed, with its status letters. */
function statusLines(repo: string): string {
  return git(repo, ['status', '--porcelain', '-uall']);
}

/** Every non-.git file in the repo, path -> bytes. The read-only assertion. */
function snapshotFiles(repo: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      if (entry.name === '.git') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[relative(repo, full)] = readFileSync(full, 'utf-8');
    }
  };
  walk(repo);
  return out;
}

function commitCount(repo: string): number {
  return Number(git(repo, ['rev-list', '--count', 'HEAD']).trim());
}

function filesInHead(repo: string): string[] {
  return git(repo, ['show', '--name-only', '--pretty=format:', 'HEAD'])
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function headSubject(repo: string): string {
  return git(repo, ['log', '-1', '--pretty=format:%s']).trim();
}

/** Run a git command that is EXPECTED to fail (a conflicting merge/rebase). */
function gitExpectFail(repo: string, argv: string[]): void {
  try {
    execFileSync('git', ['-C', repo, ...argv], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    throw new Error(`expected \`git ${argv.join(' ')}\` to fail, but it passed`);
  } catch (error) {
    if (error instanceof Error && /expected `git/.test(error.message)) throw error;
  }
}

/** Leave `repo` with a conflicting merge in progress, still on its branch. */
function startConflictingMerge(repo: string): void {
  const branch = git(repo, ['symbolic-ref', '--short', 'HEAD']).trim();
  git(repo, ['checkout', '-q', '-b', 'other']);
  writeFileSync(join(repo, 'conflict.txt'), 'other\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'other side']);
  git(repo, ['checkout', '-q', branch]);
  writeFileSync(join(repo, 'conflict.txt'), 'mine\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'my side']);
  gitExpectFail(repo, ['merge', 'other']);
}

// ---------------------------------------------------------------------------
// describeGitState — the preconditions, as a pure-ish decision
// ---------------------------------------------------------------------------

describe('describeGitState', () => {
  test('a clean checkout on a branch is usable and names the branch', () => {
    const repo = projectFixture({modules: ['alpha']});
    git(repo, ['checkout', '-q', '-b', 'feature-x']);
    const state = describeGitState(repo);
    expect(state.ok).toBe(true);
    if (!state.ok) throw new Error('unreachable');
    expect(state.branch).toBe('feature-x');
  });

  test('a detached HEAD refuses, naming the fix', () => {
    const repo = projectFixture({modules: ['alpha']});
    git(repo, ['checkout', '-q', '--detach']);
    const state = describeGitState(repo);
    expect(state.ok).toBe(false);
    if (state.ok) throw new Error('unreachable');
    expect(state.code).toBe(RULES_UPDATE_EXIT.detachedHead);
    expect(state.message).toMatch(/detached/i);
    expect(state.message).toMatch(/git switch/);
  });

  test('a conflicting MERGE refuses while HEAD is still on the branch', () => {
    // The subtle one: HEAD is NOT detached mid-merge (measured), so only the
    // MERGE_HEAD marker can catch this state.
    const repo = projectFixture({modules: ['alpha']});
    startConflictingMerge(repo);
    expect(git(repo, ['symbolic-ref', '--short', 'HEAD']).trim()).toBe('main');

    const state = describeGitState(repo);
    expect(state.ok).toBe(false);
    if (state.ok) throw new Error('unreachable');
    expect(state.code).toBe(RULES_UPDATE_EXIT.operationInProgress);
    expect(state.message).toContain('merge');
    expect(state.message).toContain('MERGE_HEAD');

    // NEGATIVE CONTROL: abort the merge and the same tree is usable again, so
    // the refusal is caused by the merge state and not by the fixture.
    git(repo, ['merge', '--abort']);
    expect(describeGitState(repo).ok).toBe(true);
  });

  test('a conflicting REBASE is reported as a rebase, not as a detached HEAD', () => {
    // Ordering proof: git detaches HEAD for the duration of a rebase, so a
    // branch-first check would name the wrong problem AND the wrong fix.
    const repo = projectFixture({modules: ['alpha']});
    git(repo, ['checkout', '-q', '-b', 'other']);
    writeFileSync(join(repo, 'conflict.txt'), 'other\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'other side']);
    git(repo, ['checkout', '-q', 'main']);
    writeFileSync(join(repo, 'conflict.txt'), 'mine\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'my side']);
    gitExpectFail(repo, ['rebase', 'other']);

    // The premise of the ordering: HEAD really is detached right now.
    expect(() =>
      execFileSync('git', ['-C', repo, 'symbolic-ref', '--quiet', 'HEAD'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    ).toThrow();

    const state = describeGitState(repo);
    expect(state.ok).toBe(false);
    if (state.ok) throw new Error('unreachable');
    expect(state.code).toBe(RULES_UPDATE_EXIT.operationInProgress);
    expect(state.message).toContain('rebase');
    expect(state.code).not.toBe(RULES_UPDATE_EXIT.detachedHead);

    git(repo, ['rebase', '--abort']);
    expect(describeGitState(repo).ok).toBe(true);
  });

  test('a directory outside any git repo is its own refusal', () => {
    const sb = track(createSandbox());
    const state = describeGitState(sb.path);
    expect(state.ok).toBe(false);
    if (state.ok) throw new Error('unreachable');
    expect(state.code).toBe(RULES_UPDATE_EXIT.notARepo);
  });
});

// ---------------------------------------------------------------------------
// rules-update — the commit is rules-only, on the current branch
// ---------------------------------------------------------------------------

describe('rules-update commits the artifact and nothing else', () => {
  test('commits ONLY the artifact on the CURRENT branch, leaving unrelated dirt (modified, untracked AND staged) exactly as it was', () => {
    setQuiet(true);
    const {dir, sha} = gitPromptsFixture();
    const repo = projectFixture({
      files: {'src/app.ts': 'export const a = 1;\n', 'other.txt': 'one\n'},
      modules: ['alpha', 'omega'],
    });
    const mainBefore = git(repo, ['rev-parse', 'main']).trim();
    git(repo, ['checkout', '-q', '-b', 'feature']);

    // Dirt of all three kinds. The staged one is the sharp case: a plain
    // `git commit` would swallow it into the rules commit.
    writeFileSync(join(repo, 'src/app.ts'), 'export const a = 2;\n');
    writeFileSync(join(repo, 'scratch.txt'), 'scratch\n');
    writeFileSync(join(repo, 'other.txt'), 'two\n');
    git(repo, ['add', '--', 'other.txt']);
    const dirtBefore = statusLines(repo);

    expect(
      runRulesUpdate({now: NOW, projectRoot: repo, promptsDir: dir}),
    ).toBe(RULES_UPDATE_EXIT.ok);

    // The commit landed on the current branch, and carries one path.
    expect(git(repo, ['symbolic-ref', '--short', 'HEAD']).trim()).toBe(
      'feature',
    );
    expect(filesInHead(repo)).toEqual([ARTIFACT_REL]);
    expect(headSubject(repo)).toBe(
      `chore(rules): update justin-sdk rules to ${sha.slice(0, 12)}`,
    );
    // …and the default branch was not touched at all.
    expect(git(repo, ['rev-parse', 'main']).trim()).toBe(mainBefore);

    // Every piece of unrelated dirt survives, in its original state: the
    // modification unstaged, the untracked file untracked, the staged file
    // STILL STAGED (not committed).
    expect(statusLines(repo)).toBe(dirtBefore);
    expect(readFileSync(join(repo, 'src/app.ts'), 'utf-8')).toBe(
      'export const a = 2;\n',
    );
    expect(readFileSync(join(repo, 'scratch.txt'), 'utf-8')).toBe('scratch\n');
    expect(git(repo, ['show', 'HEAD:other.txt']).trim()).toBe('one');
  });

  test('pre-existing dirt UNDER the tool-owned folder is absorbed into the commit', () => {
    setQuiet(true);
    const {dir} = gitPromptsFixture();
    const repo = projectFixture({modules: ['alpha', 'omega']});
    expect(
      runRulesUpdate({now: NOW, projectRoot: repo, promptsDir: dir}),
    ).toBe(RULES_UPDATE_EXIT.ok);

    // Someone edited the generated file and left a sibling behind; the folder is
    // tool-owned by contract (D2b), so this commit cleans up after them.
    writeFileSync(projectRulesFilePath(repo), 'HAND EDITED\n');
    writeFileSync(join(repo, TOOL_DIR_REL, 'stale.md'), 'STALE\n');
    editPrompts(dir); // and there IS new content, so the artifact is rewritten

    expect(
      runRulesUpdate({now: NOW, projectRoot: repo, promptsDir: dir}),
    ).toBe(RULES_UPDATE_EXIT.ok);

    expect(filesInHead(repo).sort()).toEqual(
      [ARTIFACT_REL, `${TOOL_DIR_REL}/stale.md`].sort(),
    );
    expect(git(repo, ['show', `HEAD:${TOOL_DIR_REL}/stale.md`])).toContain(
      'STALE',
    );
    // The regenerated artifact replaced the hand edit, and nothing under the
    // folder is left dirty.
    expect(readFileSync(projectRulesFilePath(repo), 'utf-8')).toContain(
      'ALPHA_RULE_V2',
    );
    expect(statusLines(repo)).toBe('');
  });

  test('a second run is already-up-to-date: exit 0, no new commit', () => {
    setQuiet(true);
    const {dir} = gitPromptsFixture();
    const repo = projectFixture({modules: ['alpha', 'omega']});
    expect(
      runRulesUpdate({now: NOW, projectRoot: repo, promptsDir: dir}),
    ).toBe(RULES_UPDATE_EXIT.ok);
    const commits = commitCount(repo);
    const bytes = readFileSync(projectRulesFilePath(repo), 'utf-8');

    // A different date, to prove the no-op is content-driven and not date-driven.
    expect(
      runRulesUpdate({now: '2099-01-01', projectRoot: repo, promptsDir: dir}),
    ).toBe(RULES_UPDATE_EXIT.ok);

    expect(commitCount(repo)).toBe(commits);
    expect(readFileSync(projectRulesFilePath(repo), 'utf-8')).toBe(bytes);
    expect(statusLines(repo)).toBe('');
  });

  test('--force on an already-current artifact makes no empty commit', () => {
    setQuiet(true);
    const {dir} = gitPromptsFixture();
    const repo = projectFixture({modules: ['alpha', 'omega']});
    expect(
      runRulesUpdate({now: NOW, projectRoot: repo, promptsDir: dir}),
    ).toBe(RULES_UPDATE_EXIT.ok);
    const commits = commitCount(repo);

    // Same date -> byte-identical regeneration. `git commit` would exit
    // non-zero on that, and calling it a failure would be a lie.
    expect(
      runRulesUpdate({
        force: true,
        now: NOW,
        projectRoot: repo,
        promptsDir: dir,
      }),
    ).toBe(RULES_UPDATE_EXIT.ok);
    expect(commitCount(repo)).toBe(commits);
    expect(statusLines(repo)).toBe('');
  });

  test('an edit that PRESERVES the stamp is invisible to plain rules-update; --force heals it, in the tree and in a commit', () => {
    setQuiet(true);
    const {dir} = gitPromptsFixture();
    const repo = projectFixture({modules: ['alpha', 'omega']});
    expect(
      runRulesUpdate({now: NOW, projectRoot: repo, promptsDir: dir}),
    ).toBe(RULES_UPDATE_EXIT.ok);
    const canonical = readFileSync(projectRulesFilePath(repo), 'utf-8');
    const stampLine = canonical.split('\n')[0] ?? '';
    const commits = commitCount(repo);

    // NOTE the shape: only an edit that KEEPS the stamp is invisible, because
    // the refresh's idempotency gate reads the stamp's content hash. A wholesale
    // replacement drops the stamp and is therefore regenerated normally — this
    // is the narrow hole that rules-diff's --force note exists for.
    const edited = `${stampLine}\n\n# Critical Rules\n\nHAND EDITED\n`;
    writeFileSync(projectRulesFilePath(repo), edited);

    expect(
      runRulesUpdate({now: NOW, projectRoot: repo, promptsDir: dir}),
    ).toBe(RULES_UPDATE_EXIT.ok);
    expect(readFileSync(projectRulesFilePath(repo), 'utf-8')).toBe(edited);
    expect(commitCount(repo)).toBe(commits);

    // --force regenerates, restoring exactly what HEAD already holds — so the
    // working tree is healed and there is correctly nothing to commit.
    expect(
      runRulesUpdate({
        force: true,
        now: NOW,
        projectRoot: repo,
        promptsDir: dir,
      }),
    ).toBe(RULES_UPDATE_EXIT.ok);
    expect(readFileSync(projectRulesFilePath(repo), 'utf-8')).toBe(canonical);
    expect(statusLines(repo)).toBe('');
    expect(commitCount(repo)).toBe(commits);

    // And when the edit was COMMITTED, --force is what puts the canonical bytes
    // back into history.
    writeFileSync(projectRulesFilePath(repo), edited);
    git(repo, ['commit', '-qam', 'hand edit the generated file']);
    expect(
      runRulesUpdate({now: NOW, projectRoot: repo, promptsDir: dir}),
    ).toBe(RULES_UPDATE_EXIT.ok);
    expect(readFileSync(projectRulesFilePath(repo), 'utf-8')).toBe(edited);

    expect(
      runRulesUpdate({
        force: true,
        now: NOW,
        projectRoot: repo,
        promptsDir: dir,
      }),
    ).toBe(RULES_UPDATE_EXIT.ok);
    expect(readFileSync(projectRulesFilePath(repo), 'utf-8')).toBe(canonical);
    expect(filesInHead(repo)).toEqual([ARTIFACT_REL]);
    expect(headSubject(repo)).toContain('chore(rules): update justin-sdk rules');
  });
});

describe('rules-update refuses, distinctly, and without writing', () => {
  test('a repo not enrolled in critical-rules: exit notEnrolled, no artifact, no commit', () => {
    setQuiet(true);
    const {dir} = gitPromptsFixture();
    const repo = projectFixture(); // no module selection recorded
    const commits = commitCount(repo);

    expect(
      runRulesUpdate({now: NOW, projectRoot: repo, promptsDir: dir}),
    ).toBe(RULES_UPDATE_EXIT.notEnrolled);
    expect(existsSync(projectRulesFilePath(repo))).toBe(false);
    expect(commitCount(repo)).toBe(commits);

    // NEGATIVE CONTROL: enrol the same repo and it succeeds, so the refusal is
    // about the missing selection, not about the fixture.
    const enrolled = projectFixture({modules: ['alpha']});
    expect(
      runRulesUpdate({now: NOW, projectRoot: enrolled, promptsDir: dir}),
    ).toBe(RULES_UPDATE_EXIT.ok);
  });

  test('a detached HEAD: exit detachedHead and NOTHING is written', () => {
    setQuiet(true);
    const {dir} = gitPromptsFixture();
    const repo = projectFixture({modules: ['alpha', 'omega']});
    git(repo, ['checkout', '-q', '--detach']);
    const commits = commitCount(repo);

    expect(
      runRulesUpdate({now: NOW, projectRoot: repo, promptsDir: dir}),
    ).toBe(RULES_UPDATE_EXIT.detachedHead);
    // The point of checking preconditions first: no orphaned generated file.
    expect(existsSync(projectRulesFilePath(repo))).toBe(false);
    expect(statusLines(repo)).toBe('');
    expect(commitCount(repo)).toBe(commits);

    // NEGATIVE CONTROL: re-attach and the same tree commits.
    git(repo, ['checkout', '-q', 'main']);
    expect(
      runRulesUpdate({now: NOW, projectRoot: repo, promptsDir: dir}),
    ).toBe(RULES_UPDATE_EXIT.ok);
    expect(commitCount(repo)).toBe(commits + 1);
  });

  test('a merge in progress: exit operationInProgress and NOTHING is written', () => {
    setQuiet(true);
    const {dir} = gitPromptsFixture();
    const repo = projectFixture({modules: ['alpha', 'omega']});
    startConflictingMerge(repo);
    const dirtBefore = statusLines(repo);

    expect(
      runRulesUpdate({now: NOW, projectRoot: repo, promptsDir: dir}),
    ).toBe(RULES_UPDATE_EXIT.operationInProgress);
    expect(existsSync(projectRulesFilePath(repo))).toBe(false);
    // The half-done merge is left exactly as the human left it.
    expect(statusLines(repo)).toBe(dirtBefore);

    // NEGATIVE CONTROL: resolve + abort, and the same tree commits.
    git(repo, ['merge', '--abort']);
    expect(
      runRulesUpdate({now: NOW, projectRoot: repo, promptsDir: dir}),
    ).toBe(RULES_UPDATE_EXIT.ok);
    expect(filesInHead(repo)).toEqual([ARTIFACT_REL]);
  });

  test('a prompts clone that cannot be refreshed: exit cannotRefresh, no artifact (D15)', () => {
    setQuiet(true);
    const {cloneDir} = sandboxedManagedClone();
    // A real checkout with real content and NO working origin: the forced fetch
    // fails while the stale bytes stay perfectly readable. That is the trap.
    initRepoAt(cloneDir, RULES_FILES);
    const repo = projectFixture({modules: ['alpha', 'omega']});
    const commits = commitCount(repo);

    expect(runRulesUpdate({now: NOW, projectRoot: repo})).toBe(
      RULES_UPDATE_EXIT.cannotRefresh,
    );
    expect(existsSync(projectRulesFilePath(repo))).toBe(false);
    expect(commitCount(repo)).toBe(commits);
    expect(statusLines(repo)).toBe('');
  });

  test('NEGATIVE CONTROL: the same sandboxed clone WITH a working origin commits', () => {
    setQuiet(true);
    const {cloneDir, sandbox} = sandboxedManagedClone();
    const origin = initRepoAt(join(sandbox, 'origin'), RULES_FILES);
    mkdirSync(join(sandbox, 'justin-sdk'), {recursive: true});
    git(sandbox, ['clone', '-q', origin, cloneDir]);
    const repo = projectFixture({modules: ['alpha', 'omega']});

    expect(runRulesUpdate({now: NOW, projectRoot: repo})).toBe(
      RULES_UPDATE_EXIT.ok,
    );
    expect(filesInHead(repo)).toEqual([ARTIFACT_REL]);
    expect(headSubject(repo)).toContain(
      git(origin, ['rev-parse', 'HEAD']).trim().slice(0, 12),
    );
  });

  test('a repo that GITIGNORES the artifact fails loudly, keeping the written file for the human', () => {
    // Reachable in the fleet: some repos ignore `.claude/`. git refuses to add
    // an ignored path, and that must surface as a distinct failure rather than
    // as a quiet "committed nothing".
    setQuiet(true);
    const {dir} = gitPromptsFixture();
    const repo = projectFixture({
      files: {'.gitignore': '.claude/\n'},
      modules: ['alpha', 'omega'],
    });
    const commits = commitCount(repo);

    expect(
      runRulesUpdate({now: NOW, projectRoot: repo, promptsDir: dir}),
    ).toBe(RULES_UPDATE_EXIT.commitFailed);
    expect(commitCount(repo)).toBe(commits);
    // The regenerated file is left on disk on purpose: the write succeeded, only
    // the commit could not happen, and deleting it would hide the evidence.
    expect(existsSync(projectRulesFilePath(repo))).toBe(true);

    // NEGATIVE CONTROL: the same fixture without that ignore line commits.
    const ok = projectFixture({modules: ['alpha', 'omega']});
    expect(runRulesUpdate({now: NOW, projectRoot: ok, promptsDir: dir})).toBe(
      RULES_UPDATE_EXIT.ok,
    );
    expect(filesInHead(ok)).toEqual([ARTIFACT_REL]);
  });

  test('a broken module selection is assemblyFailed, not notEnrolled', () => {
    setQuiet(true);
    const {dir} = gitPromptsFixture();
    const repo = projectFixture({modules: ['alpha', 'no-such-module']});

    expect(
      runRulesUpdate({now: NOW, projectRoot: repo, promptsDir: dir}),
    ).toBe(RULES_UPDATE_EXIT.assemblyFailed);
    expect(existsSync(projectRulesFilePath(repo))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// rules-diff — read-only, three outcomes, never conflated
// ---------------------------------------------------------------------------

describe('rules-diff', () => {
  test('after rules-update it reports IN SYNC naming the sha — and the run writes NOTHING in the repo', () => {
    setQuiet(true);
    const {dir, sha} = gitPromptsFixture();
    const repo = projectFixture({modules: ['alpha', 'omega']});
    expect(
      runRulesUpdate({now: NOW, projectRoot: repo, promptsDir: dir}),
    ).toBe(RULES_UPDATE_EXIT.ok);

    const statusBefore = statusLines(repo);
    const filesBefore = snapshotFiles(repo);
    const headBefore = git(repo, ['rev-parse', 'HEAD']).trim();

    const result = rulesDiff({projectRoot: repo, promptsDir: dir});

    expect(result.outcome).toBe('in-sync');
    expect(result.exitCode).toBe(RULES_DIFF_EXIT.inSync);
    // Silence is a claim, so the claim is made in words, with the sha in it.
    expect(result.report).toMatch(/in sync/i);
    expect(result.report).toContain(sha.slice(0, 12));

    // Read-only: not one byte anywhere in the repo, and no new commit.
    expect(statusLines(repo)).toBe(statusBefore);
    expect(snapshotFiles(repo)).toEqual(filesBefore);
    expect(git(repo, ['rev-parse', 'HEAD']).trim()).toBe(headBefore);
  });

  test('new content in the prompts is a DIFF: exit 1, the new rule visible, one line naming rules-update', () => {
    setQuiet(true);
    const {dir} = gitPromptsFixture();
    const repo = projectFixture({modules: ['alpha', 'omega']});
    expect(
      runRulesUpdate({now: NOW, projectRoot: repo, promptsDir: dir}),
    ).toBe(RULES_UPDATE_EXIT.ok);
    // NEGATIVE CONTROL for this whole test: in sync BEFORE the prompts change.
    expect(rulesDiff({projectRoot: repo, promptsDir: dir}).outcome).toBe(
      'in-sync',
    );

    editPrompts(dir);
    const statusBefore = statusLines(repo);
    const filesBefore = snapshotFiles(repo);

    const result = rulesDiff({projectRoot: repo, promptsDir: dir});

    expect(result.outcome).toBe('diff');
    expect(result.exitCode).toBe(RULES_DIFF_EXIT.diff);
    expect(result.report).toContain('-ALPHA_RULE');
    expect(result.report).toContain('+ALPHA_RULE_V2');
    expect(result.report).toContain('rules-update');
    expect(result.report).not.toMatch(/in sync/i);
    // Still read-only, in the outcome that has something to say.
    expect(statusLines(repo)).toBe(statusBefore);
    expect(snapshotFiles(repo)).toEqual(filesBefore);
  });

  test('a MISSING artifact while enrolled is diff-shaped, not a crash — and is not created', () => {
    setQuiet(true);
    const {dir} = gitPromptsFixture();
    const repo = projectFixture({modules: ['alpha', 'omega']});

    const result = rulesDiff({projectRoot: repo, promptsDir: dir});

    expect(result.outcome).toBe('diff');
    expect(result.exitCode).toBe(RULES_DIFF_EXIT.diff);
    expect(result.report).toContain('NO ARTIFACT');
    // Everything is new, so every rule shows as an addition.
    expect(result.report).toContain('+ALPHA_RULE');
    expect(result.report).toContain('+OMEGA_RULE');
    expect(result.report).toContain('rules-update');
    // A READ-only command does not fix the problem it reports.
    expect(existsSync(projectRulesFilePath(repo))).toBe(false);
  });

  test('a hand-edited artifact is a diff that says plain rules-update will not fix it', () => {
    setQuiet(true);
    const {dir} = gitPromptsFixture();
    const repo = projectFixture({modules: ['alpha', 'omega']});
    expect(
      runRulesUpdate({now: NOW, projectRoot: repo, promptsDir: dir}),
    ).toBe(RULES_UPDATE_EXIT.ok);

    // Keep the stamp, change the body: the file now certifies itself as
    // canonical while its bytes are not. This is the case where reading the
    // stamp instead of the bytes would have reported "in sync".
    const stamped = readFileSync(projectRulesFilePath(repo), 'utf-8');
    const stampLine = stamped.split('\n')[0] ?? '';
    writeFileSync(
      projectRulesFilePath(repo),
      `${stampLine}\n\n# Critical Rules\n\nSOMEONE EDITED THIS\n`,
    );

    const result = rulesDiff({projectRoot: repo, promptsDir: dir});
    expect(result.outcome).toBe('diff');
    expect(result.report).toContain('SOMEONE EDITED THIS');
    expect(result.report).toContain('--force');
    expect(result.report).toMatch(/already up to date/);
  });

  test('a stamp date change alone is NOT a diff (the date is excluded, D3)', () => {
    setQuiet(true);
    const {dir} = gitPromptsFixture();
    const repo = projectFixture({modules: ['alpha', 'omega']});
    expect(
      runRulesUpdate({now: '2026-01-01', projectRoot: repo, promptsDir: dir}),
    ).toBe(RULES_UPDATE_EXIT.ok);
    expect(
      runRulesUpdate({
        force: true,
        now: '2026-12-31',
        projectRoot: repo,
        promptsDir: dir,
      }),
    ).toBe(RULES_UPDATE_EXIT.ok);

    // A year later in the stamp, same rules: nothing to report.
    expect(rulesDiff({projectRoot: repo, promptsDir: dir}).outcome).toBe(
      'in-sync',
    );
  });

  test('CANNOT-CHECK on a failed refresh: exit 2, names the failure, never claims in sync', () => {
    setQuiet(true);
    const {cloneDir, sandbox} = sandboxedManagedClone();
    initRepoAt(cloneDir, RULES_FILES);
    const repo = projectFixture({modules: ['alpha', 'omega']});

    const result = rulesDiff({projectRoot: repo});

    expect(result.outcome).toBe('cannot-check');
    expect(result.exitCode).toBe(RULES_DIFF_EXIT.cannotCheck);
    expect(result.report).toContain(sandbox); // the sandbox, not ~/.config
    expect(result.report).toMatch(/stale/i);
    expect(result.report).not.toMatch(/in sync/i);
  });

  test('NEGATIVE CONTROL: the same sandboxed clone WITH a working origin answers the question', () => {
    setQuiet(true);
    const {cloneDir, sandbox} = sandboxedManagedClone();
    const origin = initRepoAt(join(sandbox, 'origin'), RULES_FILES);
    mkdirSync(join(sandbox, 'justin-sdk'), {recursive: true});
    git(sandbox, ['clone', '-q', origin, cloneDir]);
    const repo = projectFixture({modules: ['alpha', 'omega']});

    // No artifact yet, so the honest answer is "everything is new" — the point
    // is that it is an ANSWER (exit 1), not a cannot-check.
    const result = rulesDiff({projectRoot: repo});
    expect(result.outcome).toBe('diff');
    expect(result.report).toContain('+ALPHA_RULE');
  });

  test('a repo that is not enrolled is CANNOT-CHECK, naming enrolment — never in sync', () => {
    setQuiet(true);
    const {dir} = gitPromptsFixture();
    const repo = projectFixture(); // no selection recorded

    const result = rulesDiff({projectRoot: repo, promptsDir: dir});
    expect(result.outcome).toBe('cannot-check');
    expect(result.exitCode).toBe(RULES_DIFF_EXIT.cannotCheck);
    expect(result.report).toContain('add critical-rules');
    expect(result.report).not.toMatch(/in sync/i);
  });

  test('a broken module selection is CANNOT-CHECK, not an empty diff', () => {
    setQuiet(true);
    const {dir} = gitPromptsFixture();
    const repo = projectFixture({modules: ['alpha', 'no-such-module']});

    const result = rulesDiff({projectRoot: repo, promptsDir: dir});
    expect(result.outcome).toBe('cannot-check');
    expect(result.report).toContain('no-such-module');
    expect(result.report).not.toMatch(/in sync/i);
  });

  test('works with a non-git prompts source, reporting the sha as unknown rather than failing', () => {
    // JSDK_PROMPTS_DIR can point at a plain directory (advanced/offline setups);
    // "no sha" must not be mistaken for "cannot check".
    setQuiet(true);
    process.env.JSDK_PRIME_PRETTIER = '0';
    const sb = track(createSandbox());
    for (const [rel, content] of Object.entries(RULES_FILES))
      sb.writeFile(rel, content);
    const repo = projectFixture({modules: ['alpha', 'omega']});

    expect(
      runRulesUpdate({now: NOW, projectRoot: repo, promptsDir: sb.path}),
    ).toBe(RULES_UPDATE_EXIT.ok);
    expect(headSubject(repo)).toContain('unknown');

    const result = rulesDiff({projectRoot: repo, promptsDir: sb.path});
    expect(result.outcome).toBe('in-sync');
  });

  test('both sides are formatted by the REPO’s own prettier, so a formatted artifact is in sync', () => {
    // The phantom-diff guard: the writer formats with the target repo's pinned
    // prettier, so the differ must resolve the same binary or every enrolled
    // repo would look permanently out of sync.
    const {dir} = gitPromptsFixture();
    delete process.env.JSDK_PRIME_PRETTIER; // prettier ON for this test only
    setQuiet(true);
    const repo = projectFixture({modules: ['alpha', 'omega']});
    const binDir = join(repo, 'node_modules', '.bin');
    mkdirSync(binDir, {recursive: true});
    const fake = join(binDir, 'prettier');
    // Marks the file it is handed, so "which prettier ran" is observable.
    writeFileSync(
      fake,
      '#!/bin/sh\nfor f in "$@"; do :; done\nprintf \'\\nLOCAL_PRETTIER_RAN\\n\' >> "$f"\n',
    );
    chmodSync(fake, 0o755);

    expect(
      runRulesUpdate({now: NOW, projectRoot: repo, promptsDir: dir}),
    ).toBe(RULES_UPDATE_EXIT.ok);
    // The marker really is in play — without this the test could pass because
    // neither side ran prettier at all.
    expect(readFileSync(projectRulesFilePath(repo), 'utf-8')).toContain(
      'LOCAL_PRETTIER_RAN',
    );

    expect(rulesDiff({projectRoot: repo, promptsDir: dir}).outcome).toBe(
      'in-sync',
    );
  });
});

// ---------------------------------------------------------------------------
// CLI wiring — the names are frozen (home-base-si46 names them) and the exit
// codes have to survive the trip through yargs.
// ---------------------------------------------------------------------------

describe('CLI wiring', () => {
  test('--help lists rules-update and rules-diff', () => {
    const help = execFileSync(process.execPath, [CLI, '--help'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(help).toContain('rules-update');
    expect(help).toContain('rules-diff');
  });

  test('the shipped commands really commit, then really report in sync', () => {
    const {dir} = gitPromptsFixture();
    const repo = projectFixture({modules: ['alpha', 'omega']});
    // Bun snapshots the environment at startup, so a child gets the fixture
    // settings only if they are passed explicitly.
    const env = {
      ...process.env,
      JSDK_PRIME_PRETTIER: '0',
      JSDK_PROMPTS_DIR: dir,
    };

    const update = spawnSync(process.execPath, [CLI, 'rules-update'], {
      cwd: repo,
      encoding: 'utf-8',
      env,
    });
    expect(update.status).toBe(RULES_UPDATE_EXIT.ok);
    expect(filesInHead(repo)).toEqual([ARTIFACT_REL]);

    const inSync = spawnSync(process.execPath, [CLI, 'rules-diff'], {
      cwd: repo,
      encoding: 'utf-8',
      env,
    });
    expect(inSync.status).toBe(RULES_DIFF_EXIT.inSync);
    expect(inSync.stdout).toMatch(/in sync/i);

    editPrompts(dir);
    const drifted = spawnSync(process.execPath, [CLI, 'rules-diff'], {
      cwd: repo,
      encoding: 'utf-8',
      env,
    });
    expect(drifted.status).toBe(RULES_DIFF_EXIT.diff);
    expect(drifted.stdout).toContain('+ALPHA_RULE_V2');
  });

  test('a repo that is not enrolled is told to run `add critical-rules`, on stderr, non-zero', () => {
    const {dir} = gitPromptsFixture();
    const repo = projectFixture();
    const env = {
      ...process.env,
      JSDK_PRIME_PRETTIER: '0',
      JSDK_PROMPTS_DIR: dir,
    };

    const update = spawnSync(process.execPath, [CLI, 'rules-update'], {
      cwd: repo,
      encoding: 'utf-8',
      env,
    });
    expect(update.status).toBe(RULES_UPDATE_EXIT.notEnrolled);
    expect(update.stderr).toContain('add critical-rules');

    const diff = spawnSync(process.execPath, [CLI, 'rules-diff'], {
      cwd: repo,
      encoding: 'utf-8',
      env,
    });
    expect(diff.status).toBe(RULES_DIFF_EXIT.cannotCheck);
    expect(diff.stderr).toContain('add critical-rules');
    expect(diff.stdout).not.toMatch(/in sync/i);
  });
});
