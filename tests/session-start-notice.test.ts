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
function runHook(
  repo: string,
  extraEnv: Record<string, string> = {},
  hookPath: string = HOOK,
): HookRun {
  const home = track(createSandbox());
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CLAUDE_PROJECT_DIR: repo,
    HOME: home.path,
    XDG_CONFIG_HOME: join(home.path, 'config'),
    ...extraEnv,
  };
  const result = spawnSync(process.execPath, [hookPath], {
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

/**
 * Every relative import reachable from `entry`, plus every bare specifier.
 *
 * `unresolved` matters as much as `files`: a relative specifier pointing at a
 * file that is not there is precisely the 0.5.0 shape (home-base-qjyj), and a
 * walker that just skipped it would report a clean graph for a hook that cannot
 * start. It is reported as the path the specifier POINTS AT, so the escape check
 * below can judge it the same way it judges a resolved file.
 */
function importGraph(entry: string): {
  files: string[];
  bare: string[];
  unresolved: string[];
} {
  const seen = new Set<string>();
  const bare = new Set<string>();
  const unresolved = new Set<string>();
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
      const resolved = [`${base}.ts`, join(base, 'index.ts')].find((candidate) =>
        existsSync(candidate),
      );
      if (resolved == null) unresolved.add(base);
      else stack.push(resolved);
    }
  }
  return {bare: [...bare], files: [...seen], unresolved: [...unresolved]};
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
    expect(
      graph.files.some((f) => f.endsWith('/src/plugin/lib/rules-drift.ts')),
    ).toBe(true);
    expect(
      graph.files.some((f) => f.endsWith('/src/plugin/lib/rules-selection.ts')),
    ).toBe(true);
    expect(
      graph.files.some((f) => f.endsWith('/src/plugin/lib/local-fs.ts')),
    ).toBe(true);

    const thirdParty = graph.bare.filter(
      (spec) => !BUILTINS.has(spec.replace(/^node:/, '')),
    );
    expect(thirdParty).toEqual([]);
  });

  /**
   * THE GUARD THAT WAS MISSING WHEN 0.5.0 SHIPPED (home-base-qjyj).
   *
   * `.claude-plugin/marketplace.json` publishes `"source": "./src/plugin"`, so
   * that directory IS the plugin package: at runtime the hook is
   * `<cache>/prime/<version>/hooks/session-start.ts` and nothing above it was
   * copied. 0.5.0's hook imported `../../repo-status/prime-view` and
   * `../../rules-drift`, which resolve fine in this repo and to nothing at all
   * in the cache — so the hook exited 1 at import time in every real session for
   * a week. It was invisible because Claude Code calls that a
   * `hook_non_blocking_error`: the session starts, and nothing is printed.
   *
   * Neither existing test could catch it. The third-party test above passes with
   * escaping imports (they are relative, not bare), and every behavioural test
   * runs the hook from this repo, where the escape resolves.
   */
  test('no import escapes the published plugin subtree', () => {
    const pluginRoot = resolve(import.meta.dirname, '..', 'src', 'plugin');
    const graph = importGraph(HOOK);

    // Sanity: the walk really traverses, or "no escapes" is vacuous. Asserted on
    // a module the hook reaches through a NON-escaping import, deliberately —
    // an assertion about the escaping half would collapse together with the
    // thing under test and report the wrong failure.
    expect(
      graph.files.some((f) => f.endsWith('/src/plugin/lib/prime.ts')),
    ).toBe(true);

    // Judged together: an import that resolves OUTSIDE the package and one that
    // resolves nowhere are the same production failure — a module the cache does
    // not contain — and the second is what the escaping paths become once the
    // SDK moves them, so neither may pass.
    const escapes = [...graph.files, ...graph.unresolved].filter((file) =>
      relative(pluginRoot, file).startsWith('..'),
    );
    expect(escapes).toEqual([]);
    expect(graph.unresolved).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The published file set, executed the way the plugin cache executes it
// ---------------------------------------------------------------------------

/** Copy a directory tree — the marketplace's own "publish this subdir" act. */
function copyTree(from: string, to: string): void {
  mkdirSync(to, {recursive: true});
  for (const entry of readdirSync(from, {withFileTypes: true})) {
    const src = join(from, entry.name);
    const dest = join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dest);
    else writeFileSync(dest, readFileSync(src));
  }
}

describe('the hook runs from a copy of ONLY the published plugin files', () => {
  /**
   * The static guard above reads import specifiers; this one PROVES the result
   * by doing what the marketplace does — copy `src/plugin` somewhere with
   * nothing above it and run the hook from there. A specifier form the regex
   * missed, or a runtime require, still fails here.
   */
  test('exit 0 and a valid envelope, with nothing outside src/plugin on disk', () => {
    const dir = promptsFixture();
    const repo = projectFixture(['alpha', 'omega']);
    writeArtifact(repo, dir);

    const sb = track(createSandbox());
    const published = join(sb.path, 'prime', '0.0.0-test');
    copyTree(resolve(import.meta.dirname, '..', 'src', 'plugin'), published);

    // The cache really is only the plugin subtree: the SDK's own src/ is absent.
    expect(existsSync(join(published, 'hooks', 'session-start.ts'))).toBe(true);
    expect(existsSync(join(published, 'lib', 'rules-drift.ts'))).toBe(true);
    expect(existsSync(join(sb.path, 'src'))).toBe(false);
    expect(existsSync(join(published, 'node_modules'))).toBe(false);

    const run = runHook(
      repo,
      {},
      join(published, 'hooks', 'session-start.ts'),
    );
    // runHook already JSON.parses stdout and asserts the envelope's event name.
    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.systemMessage).toContain('justin-sdk prime');
  });
});

// ---------------------------------------------------------------------------
// Half B of the deduplication: the hook stops injecting rules a repo already has
// (home-base-anhw, D20)
// ---------------------------------------------------------------------------

/**
 * An enrolled repo loads its committed artifact natively, so injecting the
 * conditional rules on top delivers them TWICE. The hook drops its rule text
 * for such a repo and keeps the repo state — Justin's explicit requirement, and
 * the right split: repo state is per-session and no committed file can carry it.
 *
 * These fixtures carry a project-type-GATED module, unlike the ones above, for a
 * reason: with only universal modules the hook's conditional partition is empty
 * and "no rule text was injected" would pass vacuously. Here RN_ONLY_RULE is
 * real content that the hook demonstrably injects when it should — so its
 * absence means suppression, not an empty payload.
 *
 * Every arm also asserts where the content WENT: the same RN_ONLY_RULE must be
 * inside the committed artifact. Suppression is only correct if the repo really
 * has the rules; a test that checked only for absence would be equally happy
 * with a bug that dropped them everywhere.
 */
const GATED_RULES_FILES: Record<string, string> = {
  'src/rules/index.md': ['@./alpha.md', '@./rn-only.md', '@./omega.md'].join(
    '\n\n',
  ),
  'src/rules/alpha.md': '# Alpha\n\nALPHA_RULE',
  'src/rules/rn-only.md':
    '---\nincludeIf: [isReactNative]\n---\n\n# React Native\n\nRN_ONLY_RULE',
  'src/rules/omega.md': '# Omega\n\nOMEGA_RULE',
};

const GATED_MODULES = ['alpha', 'rn-only', 'omega'];

function gatedPromptsFixture(): string {
  process.env.JSDK_PRIME_PRETTIER = '0';
  const sb = track(createSandbox());
  const dir = initRepoAt(join(sb.path, 'prompts'), GATED_RULES_FILES);
  process.env.JSDK_PROMPTS_DIR = dir;
  return dir;
}

/** A React Native project, so the gated module is genuinely in the injection. */
function rnProjectFixture(modules?: string[]): string {
  const sb = track(createSandbox());
  return initRepoAt(join(sb.path, 'repo'), {
    'justin-sdk.config.json': `${JSON.stringify(
      {
        components: ['base-setup', 'critical-rules-setup'],
        ...(modules != null
          ? {componentConfig: {[CRITICAL_RULES_CONFIG_KEY]: {modules}}}
          : {}),
        version: '0.0.1-fixture',
      },
      null,
      2,
    )}\n`,
    'package.json': `${JSON.stringify(
      {dependencies: {'react-native': '*'}, name: 'fixture'},
      null,
      2,
    )}\n`,
  });
}

const REPO_STATE_HEADER = '# Current repo state';

describe('the hook does not re-deliver rules the repo already carries', () => {
  test('NOT enrolled: rule text AND repo state, exactly as before anhw', () => {
    gatedPromptsFixture();
    const repo = rnProjectFixture(); // no selection recorded

    const run = runHook(repo);
    expect(run.status).toBe(0);
    // The positive control the suppression arms depend on: this content really
    // does travel through the hook when nothing suppresses it.
    expect(run.additionalContext).toContain('RN_ONLY_RULE');
    expect(run.additionalContext).toContain(REPO_STATE_HEADER);
    expect(run.systemMessage).not.toContain('rule text NOT injected');
  });

  test('enrolled with the artifact PRESENT: repo state only, and it says so', () => {
    const dir = gatedPromptsFixture();
    const repo = rnProjectFixture(GATED_MODULES);
    const artifact = writeArtifact(repo, dir);

    const run = runHook(repo);
    expect(run.status).toBe(0);
    expect(run.systemMessage).toContain('repo rules ✓ in sync');

    // The rules are NOT injected…
    expect(run.additionalContext).not.toContain('RN_ONLY_RULE');
    expect(run.additionalContext).not.toContain('ALPHA_RULE');
    expect(run.additionalContext).not.toContain('📋'); // the pointer line too
    // …because the repo carries them itself. Asserted, not assumed.
    const committed = readFileSync(artifact, 'utf-8');
    expect(committed).toContain('RN_ONLY_RULE');
    expect(committed).toContain('ALPHA_RULE');

    // Repo state still ships, for every repo, enrolled or not (Justin).
    expect(run.additionalContext).toContain(REPO_STATE_HEADER);
    // And the systemMessage says what happened, so "where did my rules go?" is
    // answerable from one line instead of by reading this file.
    expect(run.systemMessage).toContain('rule text NOT injected');
    expect(run.systemMessage).toContain('NOT injected — already in this repo');
  });

  test('D20 — enrolled but the artifact is MISSING: keep injecting', () => {
    gatedPromptsFixture();
    const repo = rnProjectFixture(GATED_MODULES); // enrolled, nothing written

    const run = runHook(repo);
    expect(run.systemMessage).toContain('repo rules ⚠️ MISSING');
    // Fail toward delivery: the repo is enrolled but has no rules on disk, so
    // suppressing here would leave the session with NO rules at all — the one
    // outcome this whole epic exists to prevent.
    expect(run.additionalContext).toContain('RN_ONLY_RULE');
    expect(run.systemMessage).not.toContain('rule text NOT injected');
  });

  test('D20 — cannot-check: a failed MEASUREMENT never suppresses', () => {
    gatedPromptsFixture();
    const repo = rnProjectFixture(GATED_MODULES);
    writeArtifact(repo, gatedPromptsFixture());
    // A managed clone that exists but cannot be refreshed (D5's trap).
    const home = track(createSandbox());
    initRepoAt(join(home.path, 'config', 'justin-sdk', 'prompts'), GATED_RULES_FILES);

    const run = runHook(repo, {
      HOME: home.path,
      JSDK_PROMPTS_DIR: '',
      XDG_CONFIG_HOME: join(home.path, 'config'),
    });
    expect(run.systemMessage).toContain('repo rules ⚠️ staleness UNKNOWN');
    expect(run.additionalContext).toContain('RN_ONLY_RULE');
    expect(run.systemMessage).not.toContain('rule text NOT injected');
  });

  test('STALE and LOCALLY MODIFIED still suppress — the file is loaded either way', () => {
    const dir = gatedPromptsFixture();

    // stale: the artifact exists, the source moved past it.
    const staleRepo = rnProjectFixture(GATED_MODULES);
    writeArtifact(staleRepo, dir);
    writeFileSync(join(dir, 'src/rules/alpha.md'), '# Alpha\n\nALPHA_RULE_V2');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'edit alpha']);
    const stale = runHook(staleRepo);
    expect(stale.systemMessage).toContain('repo rules ⚠️ STALE');
    expect(stale.additionalContext).not.toContain('RN_ONLY_RULE');
    expect(stale.additionalContext).toContain(REPO_STATE_HEADER);

    // locally modified: hand-edited bytes, stamp intact.
    const editedRepo = rnProjectFixture(GATED_MODULES);
    const file = writeArtifact(editedRepo, dir);
    writeFileSync(file, `${readFileSync(file, 'utf-8')}\nHAND EDITED\n`);
    const edited = runHook(editedRepo);
    expect(edited.systemMessage).toContain('repo rules ⚠️ LOCALLY MODIFIED');
    expect(edited.additionalContext).not.toContain('RN_ONLY_RULE');
    expect(edited.additionalContext).toContain(REPO_STATE_HEADER);
  });
});
