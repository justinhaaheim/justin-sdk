/**
 * The USER-LEVEL half of `session-start` (epic home-base-dchjw D6, dchjw.8).
 *
 * Two hooks now call one command and they must NEVER both act: the project hook
 * base-setup writes into an enrolled repo, and the user-level hook in
 * `~/.claude/settings.json` that covers everything else. The whole of that
 * guarantee is `--user-level` staying silent in an enrolled repo, so it is
 * pinned here from both directions:
 *
 *  - SILENCE IS NOT THE SAFE DEFAULT. A `--user-level` that printed nothing
 *    everywhere would look exactly like a working hook and would silently cost
 *    every unenrolled repo its repo-state block — the same shape as the plugin
 *    failure this replaced. So the unenrolled arm asserts real content, not just
 *    exit 0.
 *  - THE ROOT LOOKUP IS BOUNDED. `$CLAUDE_PROJECT_DIR`, else the git toplevel of
 *    cwd, else the cwd — never a walk up the parent chain. An unbounded walk
 *    would let an enrolled ancestor silence an unrelated session (one started in
 *    ~/Downloads, or inside `pkg/justin-sdk`), and silence is indistinguishable
 *    from the hook not running at all.
 */

import {describe, expect, test} from 'bun:test';
import {execFileSync} from 'child_process';
import {mkdirSync, writeFileSync} from 'fs';
import {join, resolve} from 'path';

import {projectHookOwnsRepo, sessionProjectRoot} from '../src/session-start';
import {git} from './git-fixtures';
import {createSandbox} from './sandbox';

function enrol(root: string): void {
  writeFileSync(
    join(root, 'justin-sdk.config.json'),
    `${JSON.stringify({components: ['base-setup']}, null, 2)}\n`,
  );
}

function initRepoAt(root: string): void {
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);
  writeFileSync(join(root, 'README.md'), 'x\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'init']);
}

/**
 * A throwaway prompts repo, so `assemble` has a real source to read.
 *
 * Without it the rules load THROWS in the sandbox and the command fail-softs to
 * repo-state only — correct behaviour, but it would make the pointer-line
 * assertion below pass or fail for the wrong reason.
 */
function promptsFixture(): string {
  const sb = createSandbox();
  const dir = join(sb.path, 'prompts');
  mkdirSync(join(dir, 'src', 'rules'), {recursive: true});
  writeFileSync(join(dir, 'src/rules/index.md'), '@./alpha.md');
  writeFileSync(join(dir, 'src/rules/alpha.md'), '# Alpha\n\nALPHA_RULE');
  initRepoAt(dir);
  return dir;
}

describe('projectHookOwnsRepo', () => {
  test('true exactly when justin-sdk.config.json is at the root', () => {
    const sb = createSandbox();
    expect(projectHookOwnsRepo(sb.path)).toBe(false);
    enrol(sb.path);
    expect(projectHookOwnsRepo(sb.path)).toBe(true);
    sb.cleanup();
  });

  /**
   * THE NEGATIVE CONTROL for the enrolment check (dchjw.8 acceptance (2)).
   *
   * Removing the check is equivalent to answering `true` unconditionally, and
   * the guarantee is that the answer is driven by a file that is really there.
   * A subdirectory of an enrolled root must answer FALSE: that is the bound, and
   * it is the difference between "the project hook owns this" and "some ancestor
   * does".
   */
  test('a SUBDIRECTORY of an enrolled root is not owned — no parent walk', () => {
    const sb = createSandbox();
    enrol(sb.path);
    const sub = join(sb.path, 'pkg', 'nested');
    mkdirSync(sub, {recursive: true});
    expect(projectHookOwnsRepo(sb.path)).toBe(true);
    expect(projectHookOwnsRepo(sub)).toBe(false);
    sb.cleanup();
  });
});

describe('sessionProjectRoot', () => {
  const SAVED = process.env.CLAUDE_PROJECT_DIR;
  function withProjectDir<T>(value: string | undefined, fn: () => T): T {
    if (value == null) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = value;
    try {
      return fn();
    } finally {
      if (SAVED == null) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = SAVED;
    }
  }

  test('$CLAUDE_PROJECT_DIR wins outright', () => {
    const sb = createSandbox();
    withProjectDir('/declared/by/claude', () => {
      expect(sessionProjectRoot(sb.path)).toBe('/declared/by/claude');
    });
    sb.cleanup();
  });

  test('falls back to the git toplevel of the cwd', () => {
    const sb = createSandbox();
    initRepoAt(sb.path);
    const sub = join(sb.path, 'deep', 'nested');
    mkdirSync(sub, {recursive: true});
    withProjectDir(undefined, () => {
      // realpath, because macOS temp dirs are symlinked through /private.
      const top = git(sb.path, ['rev-parse', '--show-toplevel']).trim();
      expect(sessionProjectRoot(sub)).toBe(top);
    });
    sb.cleanup();
  });

  test('a non-git directory resolves to ITSELF, never to an enrolled ancestor', () => {
    const sb = createSandbox();
    enrol(sb.path); // an enrolled ancestor, deliberately NOT a git repo
    const sub = join(sb.path, 'scratch');
    mkdirSync(sub, {recursive: true});
    withProjectDir(undefined, () => {
      expect(sessionProjectRoot(sub)).toBe(sub);
      // The point of the bound: this session is NOT silenced by the ancestor.
      expect(projectHookOwnsRepo(sessionProjectRoot(sub))).toBe(false);
    });
    sb.cleanup();
  });
});

// ---------------------------------------------------------------------------
// End to end, through the CLI, spawned the way `sh` spawns the hook
// ---------------------------------------------------------------------------

const CLI = resolve(import.meta.dirname, '..', 'src', 'cli.ts');

function runUserLevel(
  projectRoot: string,
  promptsDir?: string,
): {status: number; stdout: string} {
  const home = createSandbox();
  try {
    const result = execFileSync(
      process.execPath,
      [CLI, 'session-start', '--user-level'],
      {
        cwd: projectRoot,
        encoding: 'utf-8',
        env: {
          ...(process.env as Record<string, string>),
          CLAUDE_PROJECT_DIR: projectRoot,
          // A throwaway HOME, so the USER-level rules file is absent and this
          // can never read or write Justin's real one; XDG_CONFIG_HOME is
          // sandboxed so the managed prompts clone is never touched.
          HOME: home.path,
          JSDK_PRIME_PRETTIER: '0',
          ...(promptsDir != null ? {JSDK_PROMPTS_DIR: promptsDir} : {}),
          XDG_CONFIG_HOME: join(home.path, 'config'),
        },
      },
    );
    return {status: 0, stdout: result};
  } finally {
    home.cleanup();
  }
}

describe('session-start --user-level', () => {
  test('an ENROLLED repo gets absolutely nothing on stdout', () => {
    const prompts = promptsFixture();
    const sb = createSandbox();
    initRepoAt(sb.path);
    enrol(sb.path);
    // The prompts source is available, so silence here is a DECISION rather
    // than a rules load that quietly failed.
    const run = runUserLevel(sb.path, prompts);
    expect(run.stdout).toBe('');
    expect(run.status).toBe(0);
    sb.cleanup();
  });

  /**
   * The other side of the same coin, and the reason the test above is not
   * vacuous: with the enrolment check removed this arm and the one above would
   * print the same thing, and only one of them can be right.
   */
  test('an UNENROLLED repo gets the rules pointer and the repo-state block', () => {
    const prompts = promptsFixture();
    const sb = createSandbox();
    initRepoAt(sb.path);
    const run = runUserLevel(sb.path, prompts);
    expect(run.status).toBe(0);
    // One JSON object and nothing else — a stray print breaks every session's
    // hook output, so JSON.parse IS the assertion.
    const parsed = JSON.parse(run.stdout) as {
      hookSpecificOutput?: {additionalContext?: string; hookEventName?: string};
      systemMessage?: string;
    };
    expect(parsed.hookSpecificOutput?.hookEventName).toBe('SessionStart');
    const context = parsed.hookSpecificOutput?.additionalContext ?? '';
    expect(context).toContain('~/.claude/rules/justin-sdk/critical-rules.md');
    expect(context).toContain('# Current repo state');
    sb.cleanup();
  });
});
