/**
 * The SessionStart hook's notice about the COMMITTED per-repo rules artifact
 * (home-base-si46, t6a0.21 D4/D9).
 *
 * Run as a real subprocess, because the three things that can go wrong here are
 * all properties of the PROCESS, not of a function:
 *
 *  1. STDOUT CORRUPTION. The hook's entire contract is one JSON envelope on
 *     stdout. The drift check reaches into `critical-rules-setup` and
 *     `setup-helpers`, whose fail()/warn()/success() write to the console — one
 *     stray print and every session's hook output becomes unparseable. So every
 *     arm parses stdout, and the noisiest arms (stale, cannot-check) are asserted
 *     to still be exactly one JSON object.
 *  2. A WRITE INSIDE THE REPO. The local session-start path must never write in
 *     the project (D4/D9) — the artifact is a committed file, and a hook that
 *     silently regenerated it would put unexplained diffs in Justin's tree.
 *     Asserted file-by-file and git-status-shaped on the state that most tempts a
 *     write: a stale artifact.
 *  3. A CRASH TAKING THE INJECTION DOWN. The rules the model receives must not
 *     depend on whether the staleness check could run, so the cannot-check arm
 *     also asserts exit 0 and a non-empty injection.
 *
 * Also pinned here: the hook's import graph stays free of third-party packages.
 * The plugin runs from the marketplace cache, which is a full checkout of this
 * repo with NO node_modules — a single `import x from 'some-package'` anywhere in
 * the graph would break the hook in production while every test here still passed.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {spawnSync} from 'child_process';
import {existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync} from 'fs';
import {dirname, join, relative, resolve} from 'path';

import {
  CRITICAL_RULES_CONFIG_KEY,
  refreshCriticalRulesArtifact,
  refreshSucceeded,
} from '../src/critical-rules-setup';
import {projectRulesFilePath} from '../src/plugin/lib/rules-file';
import {setQuiet} from '../src/setup-helpers';
import {git} from './git-fixtures';
import {createSandbox, type Sandbox} from './sandbox';

const HOOK = resolve(
  import.meta.dirname,
  '..',
  'src',
  'plugin',
  'hooks',
  'session-start.ts',
);
const NOW = '2026-08-17';

const sandboxes: Sandbox[] = [];
function track(sb: Sandbox): Sandbox {
  sandboxes.push(sb);
  return sb;
}

const SAVED_ENV = {
  prettier: process.env.JSDK_PRIME_PRETTIER,
  promptsDir: process.env.JSDK_PROMPTS_DIR,
  xdg: process.env.XDG_CONFIG_HOME,
};

afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
  for (const [name, value] of [
    ['JSDK_PRIME_PRETTIER', SAVED_ENV.prettier],
    ['JSDK_PROMPTS_DIR', SAVED_ENV.promptsDir],
    ['XDG_CONFIG_HOME', SAVED_ENV.xdg],
  ] as const) {
    if (value == null) delete process.env[name];
    else process.env[name] = value;
  }
  setQuiet(false);
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RULES_FILES: Record<string, string> = {
  'src/rules/index.md': ['@./alpha.md', '@./omega.md'].join('\n\n'),
  'src/rules/alpha.md': '# Alpha\n\nALPHA_RULE',
  'src/rules/omega.md': '# Omega\n\nOMEGA_RULE',
};

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
    mkdirSync(dirname(full), {recursive: true});
    writeFileSync(full, content);
  }
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'init']);
  return root;
}

function promptsFixture(): string {
  process.env.JSDK_PRIME_PRETTIER = '0';
  const sb = track(createSandbox());
  const dir = initRepoAt(join(sb.path, 'prompts'), RULES_FILES);
  process.env.JSDK_PROMPTS_DIR = dir;
  return dir;
}

function editPromptsRules(dir: string): void {
  writeFileSync(join(dir, 'src/rules/alpha.md'), '# Alpha\n\nALPHA_RULE_V2');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'edit alpha']);
}

function projectFixture(modules?: string[]): string {
  const sb = track(createSandbox());
  return initRepoAt(join(sb.path, 'repo'), {
    'justin-sdk.config.json': `${JSON.stringify(
      {
        components: ['base-setup', 'critical-rules-setup'],
        ...(modules != null
          ? {
              componentConfig: {
                [CRITICAL_RULES_CONFIG_KEY]: {modules},
              },
            }
          : {}),
        version: '0.0.1-fixture',
      },
      null,
      2,
    )}\n`,
    'package.json': `${JSON.stringify({name: 'fixture'}, null, 2)}\n`,
  });
}

function writeArtifact(repo: string, promptsDir: string): string {
  setQuiet(true);
  const outcome = refreshCriticalRulesArtifact(repo, {now: NOW, promptsDir});
  if (!refreshSucceeded(outcome)) {
    throw new Error(`fixture could not write the artifact: ${outcome.message}`);
  }
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'add rules artifact']);
  return outcome.file;
}

interface HookRun {
  status: number | null;
  stderr: string;
  systemMessage: string;
  additionalContext: string;
}

/**
 * Run the hook the way Claude Code does. HOME is a throwaway directory, so the
 * USER-level rules file is absent and this can never read or write Justin's real
 * one; XDG_CONFIG_HOME is sandboxed so the managed clone is never touched.
 */
function runHook(repo: string, extraEnv: Record<string, string> = {}): HookRun {
  const home = track(createSandbox());
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CLAUDE_PROJECT_DIR: repo,
    HOME: home.path,
    XDG_CONFIG_HOME: join(home.path, 'config'),
    ...extraEnv,
  };
  const result = spawnSync(process.execPath, [HOOK], {
    cwd: repo,
    encoding: 'utf-8',
    env,
  });
  const stdout = result.stdout ?? '';
  // The contract is ONE JSON object and nothing else. JSON.parse is the
  // assertion: a stray console.log from any helper in the graph fails here.
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput?: {additionalContext?: string; hookEventName?: string};
    systemMessage?: string;
  };
  expect(parsed.hookSpecificOutput?.hookEventName).toBe('SessionStart');
  return {
    additionalContext: parsed.hookSpecificOutput?.additionalContext ?? '',
    status: result.status,
    stderr: result.stderr ?? '',
    systemMessage: parsed.systemMessage ?? '',
  };
}

function statusLines(repo: string): string {
  return git(repo, ['status', '--porcelain', '-uall']);
}

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

// ---------------------------------------------------------------------------
// The five outcomes
// ---------------------------------------------------------------------------

describe('the repo-rules segment of the systemMessage', () => {
  test('in sync: a short green marker and no advice', () => {
    const dir = promptsFixture();
    const repo = projectFixture(['alpha', 'omega']);
    writeArtifact(repo, dir);

    const run = runHook(repo);
    expect(run.status).toBe(0);
    expect(run.systemMessage).toContain('repo rules ✓ in sync');
    expect(run.systemMessage).not.toContain('⚠️ repo rules:');
  });

  test('stale: names rules-diff first, then rules-update', () => {
    const dir = promptsFixture();
    const repo = projectFixture(['alpha', 'omega']);
    writeArtifact(repo, dir);
    editPromptsRules(dir);

    const run = runHook(repo);
    expect(run.status).toBe(0);
    expect(run.systemMessage).toContain('repo rules ⚠️ STALE');
    const detail = run.systemMessage
      .split('\n')
      .find((line) => line.startsWith('   → ')) as string;
    expect(detail).toContain('rules-diff');
    expect(detail).toContain('rules-update');
    expect(detail.indexOf('rules-diff')).toBeLessThan(
      detail.indexOf('rules-update'),
    );
    // Spelled out as `justin-sdk`, never a bare `j`/`jsdk` bin — and LOCAL-FIRST,
    // not a github: spec (home-base-r47v F4): this notice only ever appears inside
    // an enrolled repo, which has a pin to resolve, and bunx caches github specs
    // on the spec string — so that form can serve a stale binary to answer a
    // question about staleness.
    expect(detail).toContain('bunx @justinhaaheim/justin-sdk rules-diff');
    expect(detail).toContain('bunx @justinhaaheim/justin-sdk rules-update');
    expect(detail).not.toContain('github:');
  });

  test('missing: names rules-update', () => {
    const dir = promptsFixture();
    const repo = projectFixture(['alpha', 'omega']);

    const run = runHook(repo);
    expect(run.systemMessage).toContain('repo rules ⚠️ MISSING');
    expect(run.systemMessage).toContain('rules-update');
  });

  test('locally modified: names rules-diff first, then rules-update --force', () => {
    const dir = promptsFixture();
    const repo = projectFixture(['alpha', 'omega']);
    const file = writeArtifact(repo, dir);
    writeFileSync(file, `${readFileSync(file, 'utf-8')}\nHAND EDITED\n`);

    const run = runHook(repo);
    expect(run.systemMessage).toContain('repo rules ⚠️ LOCALLY MODIFIED');
    const detail = run.systemMessage
      .split('\n')
      .find((line) => line.startsWith('   → ')) as string;
    expect(detail).toContain('rules-diff');
    expect(detail).toContain('rules-update --force');
  });

  test('cannot check: says UNKNOWN, never claims in sync, still injects the rules', () => {
    const dir = promptsFixture();
    const repo = projectFixture(['alpha', 'omega']);
    writeArtifact(repo, dir);
    // A managed clone with readable-but-unrefreshable content: the trap (D5).
    const home = track(createSandbox());
    const cloneDir = join(home.path, 'config', 'justin-sdk', 'prompts');
    initRepoAt(cloneDir, RULES_FILES);

    const run = runHook(repo, {
      HOME: home.path,
      JSDK_PROMPTS_DIR: '', // force the managed-clone path
      XDG_CONFIG_HOME: join(home.path, 'config'),
    });
    expect(run.status).toBe(0);
    expect(run.systemMessage).toContain('repo rules ⚠️ staleness UNKNOWN');
    expect(run.systemMessage).not.toContain('repo rules ✓');
    // A check that could not run must not cost the model its rules.
    expect(run.additionalContext.length).toBeGreaterThan(0);
  });

  test('a repo that is not enrolled says nothing about repo rules at all', () => {
    const dir = promptsFixture();
    const repo = projectFixture(); // no selection recorded

    const run = runHook(repo);
    expect(run.status).toBe(0);
    expect(run.systemMessage).not.toContain('repo rules');
    expect(run.systemMessage).not.toContain('⚠️ repo rules:');
    // Sanity: the fixture IS otherwise identical to the enrolled ones, so this
    // silence is about enrolment and not about a broken run.
    expect(run.systemMessage).toContain('justin-sdk prime ·');

    // NEGATIVE CONTROL: record a selection, and the same repo gets a segment.
    writeFileSync(
      join(repo, 'justin-sdk.config.json'),
      `${JSON.stringify(
        {
          componentConfig: {[CRITICAL_RULES_CONFIG_KEY]: {modules: ['alpha']}},
          components: ['critical-rules-setup'],
          version: '0.0.1-fixture',
        },
        null,
        2,
      )}\n`,
    );
    expect(runHook(repo).systemMessage).toContain('repo rules ⚠️ MISSING');
  });
});

// ---------------------------------------------------------------------------
// The hook writes nothing in the repo
// ---------------------------------------------------------------------------

describe('the hook never writes inside the project', () => {
  test('a stale artifact is reported, not regenerated', () => {
    const dir = promptsFixture();
    const repo = projectFixture(['alpha', 'omega']);
    writeArtifact(repo, dir);
    editPromptsRules(dir);

    const before = snapshotFiles(repo);
    const status = statusLines(repo);
    const commits = git(repo, ['rev-list', '--count', 'HEAD']).trim();

    const run = runHook(repo);
    expect(run.systemMessage).toContain('repo rules ⚠️ STALE');

    expect(snapshotFiles(repo)).toEqual(before);
    expect(statusLines(repo)).toBe(status);
    expect(git(repo, ['rev-list', '--count', 'HEAD']).trim()).toBe(commits);
  });

  test('a MISSING artifact is not created either', () => {
    const dir = promptsFixture();
    const repo = projectFixture(['alpha', 'omega']);

    const run = runHook(repo);
    expect(run.systemMessage).toContain('repo rules ⚠️ MISSING');
    expect(existsSync(projectRulesFilePath(repo))).toBe(false);
    expect(statusLines(repo)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// The plugin-cache constraint
// ---------------------------------------------------------------------------

/** Every relative import reachable from `entry`, plus every bare specifier. */
function importGraph(entry: string): {files: string[]; bare: string[]} {
  const seen = new Set<string>();
  const bare = new Set<string>();
  const stack = [resolve(entry)];
  while (stack.length > 0) {
    const file = stack.pop();
    if (file == null || seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf-8');
    for (const match of source.matchAll(/from\s+'([^']+)'/g)) {
      const spec = match[1];
      if (spec == null) continue;
      if (!spec.startsWith('.')) {
        bare.add(spec);
        continue;
      }
      const base = resolve(dirname(file), spec);
      for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
        if (existsSync(candidate)) {
          stack.push(candidate);
          break;
        }
      }
    }
  }
  return {bare: [...bare], files: [...seen]};
}

describe('the hook stays runnable from the marketplace cache (no node_modules)', () => {
  /** Modules bun resolves without node_modules. */
  const BUILTINS = new Set([
    'child_process',
    'crypto',
    'fs',
    'os',
    'path',
    'url',
    'util',
  ]);

  test('nothing in the import graph needs a third-party package', () => {
    const graph = importGraph(HOOK);
    // Sanity: the walker really traversed into the new code, or this is vacuous.
    expect(graph.files.some((f) => f.endsWith('/src/rules-drift.ts'))).toBe(true);
    expect(
      graph.files.some((f) => f.endsWith('/src/critical-rules-setup.ts')),
    ).toBe(true);
    expect(graph.files.some((f) => f.endsWith('/src/setup-helpers.ts'))).toBe(
      true,
    );

    const thirdParty = graph.bare.filter(
      (spec) => !BUILTINS.has(spec.replace(/^node:/, '')),
    );
    expect(thirdParty).toEqual([]);
  });
});
