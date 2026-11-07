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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import {dirname, join, relative, resolve} from 'path';

import {REPO_STATE_HOOK_COMMAND} from '../src/base-setup';
import {
  CRITICAL_RULES_CONFIG_KEY,
  refreshCriticalRulesArtifact,
  refreshSucceeded,
} from '../src/critical-rules-setup';
import {projectRulesFilePath} from '../src/rules/rules-file';
import {SESSION_START_INJECTION_BUDGET} from '../src/session-start';
import {setQuiet} from '../src/setup-helpers';
import {git} from './git-fixtures';
import {createSandbox, type Sandbox} from './sandbox';

/**
 * The command the project SessionStart hook runs, spawned exactly as `sh` would
 * spawn it. Until dchjw.8 this pointed at `src/plugin/hooks/session-start.ts`;
 * D6 retired the plugin and folded that hook's whole job into the CLI, so the
 * entry point moved while every invariant below stayed put.
 */
const CLI = resolve(import.meta.dirname, '..', 'src', 'cli.ts');
const SESSION_START_ARGS = [CLI, 'session-start'];

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
  'src/rules/alpha.md': '# Alpha\n\nALPHA_RULE',
  'src/rules/index.md': ['@./alpha.md', '@./omega.md'].join('\n\n'),
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

/**
 * The project hooks base-setup writes. The UserPromptSubmit `repo-state --hook`
 * matters here: without it session-start injects the repo state itself
 * (home-base-39co9.4), and these fixtures model an up-to-date enrolled repo.
 */
const PROJECT_SETTINGS = `${JSON.stringify(
  {
    hooks: {
      UserPromptSubmit: [
        {hooks: [{command: REPO_STATE_HOOK_COMMAND, type: 'command'}]},
      ],
    },
  },
  null,
  2,
)}\n`;

function projectFixture(
  options: {components?: string[]; modules?: string[]} = {},
): string {
  const {components, modules} = options;
  const sb = track(createSandbox());
  return initRepoAt(join(sb.path, 'repo'), {
    '.claude/settings.json': PROJECT_SETTINGS,
    'justin-sdk.config.json': `${JSON.stringify(
      {
        components: components ?? ['base-setup', 'critical-rules-setup'],
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
  const outcome = refreshCriticalRulesArtifact(repo, {promptsDir});
  if (!refreshSucceeded(outcome)) {
    throw new Error(`fixture could not write the artifact: ${outcome.message}`);
  }
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'add rules artifact']);
  return outcome.file;
}

interface HookRun {
  additionalContext: string;
  status: number | null;
  stderr: string;
  systemMessage: string;
}

/**
 * Run the hook the way Claude Code does, SessionStart payload on stdin. HOME is
 * a throwaway directory, so the USER-level rules file is absent and this can
 * never read or write Justin's real one; XDG_CONFIG_HOME is sandboxed so the
 * managed clone is never touched, and XDG_STATE_HOME so the first-prompt
 * marker (home-base-39co9.4) lands in the sandbox too.
 */
let sessionCounter = 0;
function runHook(
  repo: string,
  extraEnv: Record<string, string> = {},
  args: string[] = SESSION_START_ARGS,
): HookRun {
  const home = track(createSandbox());
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CLAUDE_PROJECT_DIR: repo,
    HOME: home.path,
    XDG_CONFIG_HOME: join(home.path, 'config'),
    XDG_STATE_HOME: join(home.path, 'state'),
    ...extraEnv,
  };
  sessionCounter += 1;
  const result = spawnSync(process.execPath, args, {
    cwd: repo,
    encoding: 'utf-8',
    env,
    input: JSON.stringify({
      hook_event_name: 'SessionStart',
      session_id: `notice-test-${sessionCounter}`,
      source: 'startup',
    }),
  });
  const stdout = result.stdout ?? '';
  // The contract is ONE JSON object and nothing else. JSON.parse is the
  // assertion: a stray console.log from any helper in the graph fails here.
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput?: {additionalContext?: string; hookEventName?: string};
    systemMessage?: string;
  };
  // hookSpecificOutput is present exactly when something goes to Claude.
  if (parsed.hookSpecificOutput != null) {
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
  }
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
    const repo = projectFixture();
    writeArtifact(repo, dir);

    const run = runHook(repo);
    expect(run.status).toBe(0);
    expect(run.systemMessage).toContain('repo rules ✓ in sync');
    expect(run.systemMessage).not.toContain('⚠️ repo rules:');
  });

  test('stale: names rules-diff first, then rules-update', () => {
    const dir = promptsFixture();
    const repo = projectFixture();
    writeArtifact(repo, dir);
    editPromptsRules(dir);

    const run = runHook(repo);
    expect(run.status).toBe(0);
    expect(run.systemMessage).toContain('repo rules ⚠️ STALE');
    const detail = run.systemMessage
      .split('\n')
      .find((line) => line.startsWith('   → '))!;
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
    expect(detail).toContain('bun run justin-sdk rules-diff');
    expect(detail).toContain('bun run justin-sdk rules-update');
    expect(detail).not.toContain('github:');
  });

  test('missing: names rules-update', () => {
    promptsFixture();
    const repo = projectFixture();

    const run = runHook(repo);
    expect(run.systemMessage).toContain('repo rules ⚠️ MISSING');
    expect(run.systemMessage).toContain('rules-update');
  });

  test('locally modified: names rules-diff first, then rules-update --force', () => {
    const dir = promptsFixture();
    const repo = projectFixture();
    const file = writeArtifact(repo, dir);
    writeFileSync(file, `${readFileSync(file, 'utf-8')}\nHAND EDITED\n`);

    const run = runHook(repo);
    expect(run.systemMessage).toContain('repo rules ⚠️ LOCALLY MODIFIED');
    const detail = run.systemMessage
      .split('\n')
      .find((line) => line.startsWith('   → '))!;
    expect(detail).toContain('rules-diff');
    expect(detail).toContain('rules-update --force');
  });

  test('cannot check: says UNKNOWN, never claims in sync, and says the repo carries its rules', () => {
    const dir = promptsFixture();
    const repo = projectFixture();
    const artifact = writeArtifact(repo, dir);
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
    // A check that could not run must not cost the model its rules. It does
    // not: the whole artifact is in the repo, and Claude Code loads it in full
    // (home-base-t6a0.17 D1), so nothing is injected and the header says why.
    expect(readFileSync(artifact, 'utf-8')).toContain('ALPHA_RULE');
    expect(run.additionalContext).toBe('');
    expect(run.systemMessage).toContain(
      'rule text NOT injected (this repo carries its own; its staleness is UNKNOWN)',
    );
  });

  test('a repo that is not enrolled says nothing about repo rules at all', () => {
    promptsFixture();
    // critical-rules is NOT among the repo's components and there is no
    // artifact — the two pieces of evidence enrolment is keyed on (dchjw.3 F2).
    const repo = projectFixture({components: ['base-setup']});

    const run = runHook(repo);
    expect(run.status).toBe(0);
    expect(run.systemMessage).not.toContain('repo rules');
    expect(run.systemMessage).not.toContain('⚠️ repo rules:');
    // Sanity: the fixture IS otherwise identical to the enrolled ones, so this
    // silence is about enrolment and not about a broken run.
    expect(run.systemMessage).toContain('justin-sdk session-start ·');

    // NEGATIVE CONTROL: install the component, and the same repo gets a segment.
    writeFileSync(
      join(repo, 'justin-sdk.config.json'),
      `${JSON.stringify(
        {
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
    const repo = projectFixture();
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
    promptsFixture();
    const repo = projectFixture();

    const run = runHook(repo);
    expect(run.systemMessage).toContain('repo rules ⚠️ MISSING');
    expect(existsSync(projectRulesFilePath(repo))).toBe(false);
    expect(statusLines(repo)).toBe('');
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
  'src/rules/alpha.md': '# Alpha\n\nALPHA_RULE',
  'src/rules/index.md': ['@./alpha.md', '@./rn-only.md', '@./omega.md'].join(
    '\n\n',
  ),
  'src/rules/omega.md': '# Omega\n\nOMEGA_RULE',
  'src/rules/rn-only.md':
    '---\nincludeIf: [isReactNative]\n---\n\n# React Native\n\nRN_ONLY_RULE',
};

function gatedPromptsFixture(): string {
  process.env.JSDK_PRIME_PRETTIER = '0';
  const sb = track(createSandbox());
  const dir = initRepoAt(join(sb.path, 'prompts'), GATED_RULES_FILES);
  process.env.JSDK_PROMPTS_DIR = dir;
  return dir;
}

/** A React Native project, so the gated module is genuinely in the injection. */
function rnProjectFixture(
  options: {components?: string[]; modules?: string[]} = {},
): string {
  const {components, modules} = options;
  const sb = track(createSandbox());
  return initRepoAt(join(sb.path, 'repo'), {
    '.claude/settings.json': PROJECT_SETTINGS,
    'justin-sdk.config.json': `${JSON.stringify(
      {
        components: components ?? ['base-setup', 'critical-rules-setup'],
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
  test('NOT enrolled: rule text, mirrored to Justin; the repo state waits for the first prompt', () => {
    gatedPromptsFixture();
    const repo = rnProjectFixture({components: ['base-setup']});

    const run = runHook(repo);
    expect(run.status).toBe(0);
    // The positive control the suppression arms depend on: this content really
    // does travel through the hook when nothing suppresses it.
    expect(run.additionalContext).toContain('RN_ONLY_RULE');
    expect(run.systemMessage).not.toContain('rule text NOT injected');
    // M3: what Claude got, Justin sees.
    expect(run.systemMessage).toContain('↓ also sent to Claude');
    expect(run.systemMessage).toContain('RN_ONLY_RULE');
    // M1: the repo state is no longer a SessionStart injection.
    expect(run.additionalContext).not.toContain(REPO_STATE_HEADER);
    expect(run.systemMessage).toContain('repo state → your first prompt');
  });

  test('enrolled with the artifact PRESENT: nothing injected at all, and it says so', () => {
    const dir = gatedPromptsFixture();
    const repo = rnProjectFixture();
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

    // And the repo state now arrives on the first prompt (M1), so SessionStart
    // injects NOTHING into Claude here — no hookSpecificOutput at all.
    expect(run.additionalContext).toBe('');
    expect(run.systemMessage).not.toContain('↓ also sent to Claude');
    // The systemMessage says what happened, so "where did my rules go?" is
    // answerable from one line instead of by reading this file.
    expect(run.systemMessage).toContain('rule text NOT injected');
    expect(run.systemMessage).toContain(
      'conditional rule modules that apply here (already in this repo’s rules artifact, not injected):\n  1. rn-only',
    );
  });

  test('D20 — enrolled but the artifact is MISSING: keep injecting', () => {
    gatedPromptsFixture();
    const repo = rnProjectFixture(); // enrolled, nothing written

    const run = runHook(repo);
    expect(run.systemMessage).toContain('repo rules ⚠️ MISSING');
    // Fail toward delivery: the repo is enrolled but has no rules on disk, so
    // suppressing here would leave the session with NO rules at all — the one
    // outcome this whole epic exists to prevent.
    expect(run.additionalContext).toContain('RN_ONLY_RULE');
    expect(run.systemMessage).not.toContain('rule text NOT injected');
  });

  test('t6a0.17 D1 — cannot-check with the whole artifact on disk: nothing injected, and it says so', () => {
    gatedPromptsFixture();
    const repo = rnProjectFixture();
    const artifact = writeArtifact(repo, gatedPromptsFixture());
    // A managed clone that exists but cannot be refreshed (D5's trap).
    const home = track(createSandbox());
    initRepoAt(
      join(home.path, 'config', 'justin-sdk', 'prompts'),
      GATED_RULES_FILES,
    );

    const run = runHook(repo, {
      HOME: home.path,
      JSDK_PROMPTS_DIR: '',
      XDG_CONFIG_HOME: join(home.path, 'config'),
    });
    expect(run.systemMessage).toContain('repo rules ⚠️ staleness UNKNOWN');
    // Suppressing here is only right because the repo really has the rules.
    expect(readFileSync(artifact, 'utf-8')).toContain('RN_ONLY_RULE');
    expect(run.additionalContext).not.toContain('RN_ONLY_RULE');
    expect(run.additionalContext).toBe('');
    expect(run.systemMessage).toContain(
      'rule text NOT injected (this repo carries its own; its staleness is UNKNOWN)',
    );
    expect(run.systemMessage).toContain(
      'conditional rule modules that apply here (already in this repo’s rules artifact, not injected):\n  1. rn-only',
    );
  });

  test('t6a0.17 D1 — cannot-check with an artifact that cannot be read: keep injecting', () => {
    const dir = gatedPromptsFixture();
    const repo = rnProjectFixture();
    const artifact = writeArtifact(repo, dir);
    // Unreadable: the drift check cannot read it (cannot-check), and neither
    // can Claude Code, so this session must get the rules from the hook.
    chmodSync(artifact, 0o000);
    try {
      const run = runHook(repo);
      expect(run.systemMessage).toContain('repo rules ⚠️ staleness UNKNOWN');
      expect(run.additionalContext).toContain('RN_ONLY_RULE');
      expect(run.systemMessage).not.toContain('rule text NOT injected');
    } finally {
      chmodSync(artifact, 0o644);
    }
  });

  test('STALE and LOCALLY MODIFIED still suppress — the file is loaded either way', () => {
    const dir = gatedPromptsFixture();

    // stale: the artifact exists, the source moved past it.
    const staleRepo = rnProjectFixture();
    writeArtifact(staleRepo, dir);
    writeFileSync(join(dir, 'src/rules/alpha.md'), '# Alpha\n\nALPHA_RULE_V2');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'edit alpha']);
    const stale = runHook(staleRepo);
    expect(stale.systemMessage).toContain('repo rules ⚠️ STALE');
    expect(stale.additionalContext).not.toContain('RN_ONLY_RULE');
    expect(stale.additionalContext).toBe('');

    // locally modified: hand-edited bytes, stamp intact.
    const editedRepo = rnProjectFixture();
    const file = writeArtifact(editedRepo, dir);
    writeFileSync(file, `${readFileSync(file, 'utf-8')}\nHAND EDITED\n`);
    const edited = runHook(editedRepo);
    expect(edited.systemMessage).toContain('repo rules ⚠️ LOCALLY MODIFIED');
    expect(edited.additionalContext).not.toContain('RN_ONLY_RULE');
    expect(edited.additionalContext).toBe('');
  });
});

// ---------------------------------------------------------------------------
// What Justin is told at session start (home-base-39co9.4, M2; criterion 3)
// ---------------------------------------------------------------------------

describe('the SessionStart systemMessage names staleness and the conditional modules', () => {
  test('a STALE artifact and the gated module that applies, in one message', () => {
    const dir = gatedPromptsFixture();
    const repo = rnProjectFixture();
    writeArtifact(repo, dir);
    editPromptsRules(dir);

    const run = runHook(repo);
    expect(run.systemMessage).toContain('repo rules ⚠️ STALE');
    expect(run.systemMessage).toContain('bun run justin-sdk rules-update');
    expect(run.systemMessage).toMatch(
      /conditional rule modules that apply here \([^)]*\):\n {2}1\. rn-only/,
    );
  });

  test('a repo the gated module does NOT apply to says "none", not nothing', () => {
    gatedPromptsFixture();
    // Same prompts, but not a React Native project: rn-only's includeIf fails.
    const repo = projectFixture();

    const run = runHook(repo);
    expect(run.systemMessage).toContain(
      'conditional rule modules that apply here: none',
    );
    expect(run.systemMessage).not.toContain('rn-only');
  });

  test('rules that cannot be loaded say UNKNOWN, never "none"', () => {
    const repo = projectFixture();
    const run = runHook(repo, {
      JSDK_PROMPTS_DIR: join(track(createSandbox()).path, 'no-such-prompts'),
    });
    expect(run.status).toBe(0);
    expect(run.systemMessage).toContain('conditional rule modules: UNKNOWN');
    expect(run.systemMessage).not.toContain('apply here: none');
  });

  test('doctor’s report goes to Justin, not into Claude’s context', () => {
    promptsFixture();
    const repo = projectFixture();
    const run = runHook(repo);
    // A check label only doctor emits.
    expect(run.systemMessage).toContain('Ran ');
    expect(run.additionalContext).not.toContain('Ran ');
  });
});

// ---------------------------------------------------------------------------
// The injection stays under Claude Code's hook cap (home-base-t6a0.17 D2/D3)
// ---------------------------------------------------------------------------

/**
 * Every runHook here has a throwaway HOME, so the user-level rules file is
 * missing and the FULL rules are injected: the state where both halves of D2
 * can be reached. The repo is not enrolled, so nothing suppresses the rules.
 */
function sizedPromptsFixture(files: Record<string, string>): string {
  process.env.JSDK_PRIME_PRETTIER = '0';
  const dir = initRepoAt(join(track(createSandbox()).path, 'prompts'), files);
  process.env.JSDK_PROMPTS_DIR = dir;
  return dir;
}

const RN = '---\nincludeIf: [isReactNative]\n---\n\n';
const filler = (length: number): string =>
  Array.from({length: Math.ceil(length / 80)}, () => 'x'.repeat(79)).join('\n');

/** Run the CLI's `prime` in `repo`, as the line's command would (locally). */
function primeIn(
  repo: string,
  promptsDir: string,
  args: string[],
): {status: number | null; stdout: string} {
  const result = spawnSync(
    process.execPath,
    [CLI, 'prime', '--prompts-dir', promptsDir, ...args],
    {
      cwd: repo,
      encoding: 'utf-8',
      env: {
        ...(process.env as Record<string, string>),
        JUSTIN_SDK_HEALTH_NOTICES: 'off',
      },
    },
  );
  return {status: result.status, stdout: result.stdout ?? ''};
}

describe('the injection is held under the hook budget', () => {
  test('over budget: the last conditional module is left out and named, with a command that prints it', () => {
    const prompts = sizedPromptsFixture({
      'src/rules/alpha.md': '# Alpha\n\nALPHA_RULE',
      'src/rules/index.md': [
        '@./alpha.md',
        '@./rn-small.md',
        '@./rn-big.md',
      ].join('\n\n'),
      'src/rules/rn-big.md': `${RN}# RN big\n\nRN_BIG_RULE\n\n${filler(9_500)}`,
      'src/rules/rn-small.md': `${RN}# RN small\n\nRN_SMALL_RULE`,
    });
    const repo = rnProjectFixture({components: ['base-setup']});

    const run = runHook(repo);
    expect(run.status).toBe(0);
    expect(run.additionalContext.length).toBeLessThanOrEqual(
      SESSION_START_INJECTION_BUDGET,
    );
    expect(run.additionalContext).toContain('ALPHA_RULE');
    expect(run.additionalContext).toContain('RN_SMALL_RULE');
    expect(run.additionalContext).not.toContain('RN_BIG_RULE');
    const command =
      'bunx github:justinhaaheim/justin-sdk prime --module rn-big';
    expect(run.additionalContext).toContain(`\`${command}\``);
    expect(run.systemMessage).toContain(
      '⚠️ 1 rule module left out to stay under the 10,000-character hook limit (rn-big); Claude was told how to print it',
    );
    // The command reaches Justin through the mirror of Claude's text.
    expect(run.systemMessage).toContain(`\`${command}\``);
    expect(run.systemMessage).not.toContain("over Claude Code's");

    // The command it names prints exactly that module (run locally: the
    // github: form resolves the published SDK).
    const printed = primeIn(repo, prompts, ['--module', 'rn-big']);
    expect(printed.status).toBe(0);
    expect(printed.stdout).toContain('RN_BIG_RULE');
    expect(printed.stdout).not.toContain('RN_SMALL_RULE');
    expect(printed.stdout).not.toContain('ALPHA_RULE');
  });

  test('still over with every conditional module out: universal ones go too, from the end, and the line says so', () => {
    const prompts = sizedPromptsFixture({
      'src/rules/alpha.md': `# Alpha\n\nALPHA_RULE\n\n${filler(5_000)}`,
      'src/rules/index.md': [
        '@./alpha.md',
        '@./omega.md',
        '@./rn-small.md',
      ].join('\n\n'),
      'src/rules/omega.md': `# Omega\n\nOMEGA_RULE\n\n${filler(5_000)}`,
      'src/rules/rn-small.md': `${RN}# RN small\n\nRN_SMALL_RULE`,
    });
    const repo = rnProjectFixture({components: ['base-setup']});

    const run = runHook(repo);
    expect(run.status).toBe(0);
    expect(run.additionalContext.length).toBeLessThanOrEqual(
      SESSION_START_INJECTION_BUDGET,
    );
    expect(run.additionalContext).toContain('ALPHA_RULE');
    expect(run.additionalContext).not.toContain('OMEGA_RULE');
    expect(run.additionalContext).not.toContain('RN_SMALL_RULE');
    expect(run.additionalContext).toContain(
      'the project-specific modules rn-small and, because leaving those out was not enough, the always-on modules omega.',
    );
    expect(run.additionalContext).toContain(
      '`bunx github:justinhaaheim/justin-sdk prime --module omega --module rn-small`',
    );

    const printed = primeIn(repo, prompts, [
      '--module',
      'omega',
      '--module',
      'rn-small',
    ]);
    expect(printed.status).toBe(0);
    expect(printed.stdout).toContain('OMEGA_RULE');
    expect(printed.stdout).toContain('RN_SMALL_RULE');
    expect(printed.stdout).not.toContain('ALPHA_RULE');
  });

  test('under budget: nothing is left out and no line is added', () => {
    gatedPromptsFixture();
    const repo = rnProjectFixture({components: ['base-setup']});

    const run = runHook(repo);
    expect(run.additionalContext).toContain('RN_ONLY_RULE');
    expect(run.additionalContext).not.toContain('leaves out');
    expect(run.systemMessage).not.toContain('left out to stay under');
  });
});
