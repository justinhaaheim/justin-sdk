/**
 * Unit tests for the worktree-ignore surface detection used by the doctor
 * WORKTREE_* checks.
 *
 * The git-surface tests neutralize the machine's real global git ignore
 * (~/.config/git/ignore, which on Justin's machine DOES ignore
 * .claude/worktrees) by pointing each repo's LOCAL core.excludesFile at a
 * controlled file — so 'none' / 'ephemeral' / 'committed' are deterministic
 * regardless of the host's global config.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {execFileSync} from 'child_process';
import {writeFileSync} from 'fs';
import {join} from 'path';

import {
  eslintWorktreeStatus,
  ignoreContentCovers,
  prettierWorktreeStatus,
  worktreeGitStatus,
} from '../src/worktree-ignore';
import {createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];

function track(sb: Sandbox): Sandbox {
  sandboxes.push(sb);
  return sb;
}

afterEach(() => {
  while (sandboxes.length > 0) {
    sandboxes.pop()?.cleanup();
  }
});

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {cwd, stdio: ['pipe', 'pipe', 'pipe']});
}

/**
 * Create a git repo whose global-ignore layer is controlled via a local
 * core.excludesFile containing `excludesFileContent` (empty = ignores nothing).
 */
function initRepo(sb: Sandbox, excludesFileContent = ''): void {
  git(sb.path, ['init', '-q', '-b', 'main']);
  git(sb.path, ['config', 'user.email', 'test@example.com']);
  git(sb.path, ['config', 'user.name', 'Test']);
  const excludesPath = join(sb.path, '.git', 'controlled-excludes');
  writeFileSync(excludesPath, excludesFileContent);
  git(sb.path, ['config', 'core.excludesFile', excludesPath]);
}

describe('ignoreContentCovers', () => {
  test.each([
    ['.claude/worktrees/', true],
    ['**/.claude/worktrees/', true],
    ['.claude/', true],
    ['# comment\n\n.claude/worktrees/\n', true],
    ['worktrees', true],
    ['node_modules/\ntmp/', false],
    ['', false],
    [null, false],
    ['# only a comment', false],
  ] as Array<[string | null, boolean]>)(
    'covers(%p) === %p',
    (content, expected) => {
      expect(ignoreContentCovers(content)).toBe(expected);
    },
  );
});

describe('worktreeGitStatus', () => {
  test('not a git repo → not-git', () => {
    const sb = track(createSandbox());
    expect(worktreeGitStatus(sb.path)).toBe('not-git');
  });

  test('committed .gitignore covers → committed', () => {
    const sb = track(createSandbox());
    initRepo(sb);
    sb.writeFile('.gitignore', 'node_modules/\n.claude/worktrees/\n');
    expect(worktreeGitStatus(sb.path)).toBe('committed');
  });

  test('parent-dir committed pattern (.claude/) → committed', () => {
    const sb = track(createSandbox());
    initRepo(sb);
    sb.writeFile('.gitignore', '.claude/\n');
    expect(worktreeGitStatus(sb.path)).toBe('committed');
  });

  test('ignored only by global excludesFile → ephemeral', () => {
    const sb = track(createSandbox());
    initRepo(sb, '.claude/worktrees/\n');
    // no .gitignore
    expect(worktreeGitStatus(sb.path)).toBe('ephemeral');
  });

  test('ignored only by .git/info/exclude → ephemeral', () => {
    const sb = track(createSandbox());
    initRepo(sb);
    sb.writeFile('.git/info/exclude', '.claude/worktrees/\n');
    expect(worktreeGitStatus(sb.path)).toBe('ephemeral');
  });

  test('not ignored by any layer → none', () => {
    const sb = track(createSandbox());
    initRepo(sb);
    sb.writeFile('.gitignore', 'node_modules/\n');
    expect(worktreeGitStatus(sb.path)).toBe('none');
  });
});

describe('eslintWorktreeStatus', () => {
  test('no eslint config → not applicable', () => {
    const sb = track(createSandbox());
    expect(eslintWorktreeStatus(sb.path)).toMatchObject({
      applicable: false,
      covered: false,
    });
  });

  test('flat config without the pattern → applicable, not covered', () => {
    const sb = track(createSandbox());
    sb.writeFile(
      'eslint.config.js',
      'export default [{ignores: ["dist/"]}];\n',
    );
    expect(eslintWorktreeStatus(sb.path)).toMatchObject({
      applicable: true,
      covered: false,
      configFile: 'eslint.config.js',
    });
  });

  test('flat config with the pattern → covered', () => {
    const sb = track(createSandbox());
    sb.writeFile(
      'eslint.config.js',
      'export default [{ignores: ["**/.claude/worktrees/"]}];\n',
    );
    expect(eslintWorktreeStatus(sb.path).covered).toBe(true);
  });

  test('legacy .eslintignore parsed via ignore → covered', () => {
    const sb = track(createSandbox());
    sb.writeFile('.eslintignore', 'dist/\n.claude/worktrees/\n');
    expect(eslintWorktreeStatus(sb.path).covered).toBe(true);
  });
});

describe('prettierWorktreeStatus', () => {
  test('no prettier configured → not applicable', () => {
    const sb = track(createSandbox());
    expect(prettierWorktreeStatus(sb.path, 'none')).toMatchObject({
      applicable: false,
    });
  });

  test('committed git coverage counts for prettier', () => {
    const sb = track(createSandbox());
    sb.writeFile('.prettierrc.json', '{}\n');
    expect(prettierWorktreeStatus(sb.path, 'committed')).toMatchObject({
      applicable: true,
      covered: true,
    });
  });

  test('.prettierignore covers even when git does not', () => {
    const sb = track(createSandbox());
    sb.writeFile('.prettierignore', 'dist/\n.claude/worktrees/\n');
    expect(prettierWorktreeStatus(sb.path, 'none').covered).toBe(true);
  });

  test('prettier dep present, nothing covers → applicable, not covered', () => {
    const sb = track(createSandbox());
    sb.writeFile(
      'package.json',
      JSON.stringify({devDependencies: {prettier: '3.6.2'}}) + '\n',
    );
    expect(prettierWorktreeStatus(sb.path, 'none')).toMatchObject({
      applicable: true,
      covered: false,
    });
  });
});
