/**
 * session-start never injects more than Claude Code's hook cap
 * (home-base-t6a0.17).
 *
 *  - D1: when the drift check cannot run, a rules artifact that is present,
 *    stamped and whole suppresses the injection, and nothing less does.
 *  - D2: the FINAL Claude-bound string (prettier'd, repo state joined) is held
 *    under SESSION_START_INJECTION_BUDGET by leaving whole modules out,
 *    conditional ones from the end first.
 *
 * In-process, against fixture prompts (JSDK_PROMPTS_DIR) with prettier off,
 * so every length below is exact and nothing touches the network. HOME is a
 * sandbox for the whole file, so Justin's real user-level rules file is never
 * read.
 */

import type {AssembledModule} from '../src/prime';

import {afterAll, afterEach, beforeAll, describe, expect, test} from 'bun:test';
import {mkdirSync, readFileSync, writeFileSync} from 'fs';
import {dirname, join} from 'path';

import {
  refreshCriticalRulesArtifact,
  refreshSucceeded,
} from '../src/critical-rules-setup';
import {composeRepoState} from '../src/first-prompt';
import {projectRulesFilePath, rulesFilePath} from '../src/rules/rules-file';
import {
  composeSessionStart,
  fitToBudget,
  repoCarriesRules,
  SESSION_START_INJECTION_BUDGET,
} from '../src/session-start';
import {setQuiet} from '../src/setup-helpers';
import {git} from './git-fixtures';
import {createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
function track(sb: Sandbox): Sandbox {
  sandboxes.push(sb);
  return sb;
}

const SAVED_ENV = {
  home: process.env.HOME,
  prettier: process.env.JSDK_PRIME_PRETTIER,
  promptsDir: process.env.JSDK_PROMPTS_DIR,
};
let home: Sandbox;

beforeAll(() => {
  home = createSandbox();
  process.env.HOME = home.path;
  process.env.JSDK_PRIME_PRETTIER = '0';
});

afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
  delete process.env.JSDK_PROMPTS_DIR;
  setQuiet(false);
});

afterAll(() => {
  home.cleanup();
  for (const [name, value] of [
    ['HOME', SAVED_ENV.home],
    ['JSDK_PRIME_PRETTIER', SAVED_ENV.prettier],
    ['JSDK_PROMPTS_DIR', SAVED_ENV.promptsDir],
  ] as const) {
    if (value == null) delete process.env[name];
    else process.env[name] = value;
  }
});

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

const RN_GATE = '---\nincludeIf: [isReactNative]\n---\n\n';

function promptsAt(files: Record<string, string>): string {
  const dir = initRepoAt(join(track(createSandbox()).path, 'prompts'), files);
  process.env.JSDK_PROMPTS_DIR = dir;
  return dir;
}

function rnProject(extra: Record<string, string> = {}): string {
  return initRepoAt(join(track(createSandbox()).path, 'repo'), {
    'package.json': `${JSON.stringify({dependencies: {'react-native': '*'}, name: 'fixture'}, null, 2)}\n`,
    ...extra,
  });
}

/** A stamped user-level rules file, so session-start injects only the conditional partition. */
function writeUserRulesFile(): void {
  const file = rulesFilePath();
  mkdirSync(dirname(file), {recursive: true});
  writeFileSync(
    file,
    '<!-- justin-sdk rules · v0.0.1 · commit 000000000000 · content 000000000000 -->\n\n# Critical Rules\n',
  );
}

// ---------------------------------------------------------------------------
// D1 — criterion 4
// ---------------------------------------------------------------------------

describe('D1: when the drift check cannot run, only a whole artifact suppresses the injection', () => {
  /** An enrolled repo with a real artifact, written by the real writer. */
  function repoWithArtifact(): {artifact: string; repo: string} {
    const prompts = promptsAt({
      'src/rules/alpha.md': '# Alpha\n\nALPHA_RULE',
      'src/rules/index.md': '@./alpha.md',
    });
    const repo = rnProject({
      'justin-sdk.config.json': `${JSON.stringify(
        {
          components: ['base-setup', 'critical-rules-setup'],
          version: '0.0.1-fixture',
        },
        null,
        2,
      )}\n`,
    });
    setQuiet(true);
    const outcome = refreshCriticalRulesArtifact(repo, {promptsDir: prompts});
    if (!refreshSucceeded(outcome)) throw new Error(outcome.message);
    return {artifact: outcome.file, repo};
  }

  test('a whole, stamped artifact suppresses', () => {
    const {artifact, repo} = repoWithArtifact();
    expect(readFileSync(artifact, 'utf-8')).toContain('ALPHA_RULE');
    expect(repoCarriesRules('cannot-check', repo)).toBe(true);
  });

  test('an absent artifact does not', () => {
    const repo = rnProject();
    expect(repoCarriesRules('cannot-check', repo)).toBe(false);
  });

  test('a zero-byte artifact does not', () => {
    const {artifact, repo} = repoWithArtifact();
    writeFileSync(artifact, '');
    expect(repoCarriesRules('cannot-check', repo)).toBe(false);
  });

  test('an artifact with no stamp does not, even when its text is the rules', () => {
    const {artifact, repo} = repoWithArtifact();
    const withoutStamp = readFileSync(artifact, 'utf-8')
      .split('\n')
      .slice(1)
      .join('\n');
    expect(withoutStamp).toContain('ALPHA_RULE');
    writeFileSync(artifact, withoutStamp);
    expect(repoCarriesRules('cannot-check', repo)).toBe(false);
  });

  test('a half-written artifact (stamp intact, body cut short) does not', () => {
    const {artifact, repo} = repoWithArtifact();
    const whole = readFileSync(artifact, 'utf-8');
    writeFileSync(artifact, whole.slice(0, whole.indexOf('ALPHA_RULE')));
    expect(readFileSync(artifact, 'utf-8').split('\n')[0]).toContain(
      '<!-- justin-sdk rules',
    );
    expect(repoCarriesRules('cannot-check', repo)).toBe(false);
  });

  test('every other status still decides alone, whatever is on disk', () => {
    const repo = rnProject();
    expect(repoCarriesRules('in-sync', repo)).toBe(true);
    expect(repoCarriesRules('stale', repo)).toBe(true);
    expect(repoCarriesRules('locally-modified', repo)).toBe(true);
    expect(repoCarriesRules('missing', repo)).toBe(false);
    expect(repoCarriesRules('not-enrolled', repo)).toBe(false);
    // The artifact path these read is the committed per-repo one.
    expect(projectRulesFilePath(repo)).toBe(
      join(repo, '.claude', 'rules', 'justin-sdk', 'critical-rules.md'),
    );
  });
});

// ---------------------------------------------------------------------------
// D2 — the order modules are left out in
// ---------------------------------------------------------------------------

describe('D2: fitToBudget leaves out whole modules, conditional ones from the end first', () => {
  const MODULES: AssembledModule[] = [
    {conditional: false, name: 'u1'},
    {conditional: true, name: 'c1'},
    {conditional: false, name: 'u2'},
    {conditional: true, name: 'c2'},
  ];
  /** Each module is 100 characters; the dropped list costs nothing. */
  const compose = (kept: readonly AssembledModule[]): string =>
    kept.map((m) => m.name.padEnd(100, '.')).join('');

  test('nothing is left out when the text already fits', () => {
    const fit = fitToBudget(MODULES, compose, 400);
    expect(fit.dropped).toEqual([]);
    expect(fit.text.length).toBe(400);
  });

  test('conditional modules go first, from the end, and it stops as soon as it fits', () => {
    expect(
      fitToBudget(MODULES, compose, 300).dropped.map((m) => m.name),
    ).toEqual(['c2']);
    expect(
      fitToBudget(MODULES, compose, 200).dropped.map((m) => m.name),
    ).toEqual(['c1', 'c2']);
  });

  test('universal modules go only once every conditional one is out, from the end', () => {
    const fit = fitToBudget(MODULES, compose, 100);
    // Reported in index order, whatever order they were dropped in.
    expect(fit.dropped.map((m) => m.name)).toEqual(['c1', 'u2', 'c2']);
    expect(fit.text).toStartWith('u1');
  });

  test('when even an empty module list is over, the text comes back over — never cut mid-module', () => {
    const withFloor = (kept: readonly AssembledModule[]): string =>
      `${'P'.repeat(150)}${compose(kept)}`;
    const fit = fitToBudget(MODULES, withFloor, 100);
    expect(fit.dropped.map((m) => m.name)).toEqual(['u1', 'c1', 'u2', 'c2']);
    expect(fit.text).toBe('P'.repeat(150));
  });
});

// ---------------------------------------------------------------------------
// D2 — criterion 3: the budget is applied to the FINAL string
// ---------------------------------------------------------------------------

describe('D2: the budget measures the final string, repo state included', () => {
  test('rules and repo state that cross the budget only together are cut to fit', () => {
    writeUserRulesFile();
    const PAD_MARKER = 'RN_PAD_RULE';
    const files = (padLength: number): Record<string, string> => ({
      'src/rules/alpha.md': '# Alpha\n\nALPHA_RULE',
      'src/rules/index.md': ['@./alpha.md', '@./rn-a.md', '@./rn-pad.md'].join(
        '\n\n',
      ),
      'src/rules/rn-a.md': `${RN_GATE}# RN A\n\nRN_A_RULE`,
      'src/rules/rn-pad.md': `${RN_GATE}# RN Pad\n\n${PAD_MARKER}\n\n${'x'.repeat(padLength)}`,
    });
    const repo = rnProject();
    const repoState = composeRepoState(repo);
    expect(repoState).toContain('# Current repo state');

    const measure = (withState: boolean): string =>
      composeSessionStart(repo, {
        firstPrompt: withState
          ? {error: 'test: not armed', ok: false}
          : {ok: true},
        userLevel: false,
      }).forClaude;

    // Size the pad so the rules ALONE land halfway into the window where only
    // rules + repo state cross the budget.
    promptsAt(files(0));
    const base = measure(false).length;
    const target =
      SESSION_START_INJECTION_BUDGET - Math.floor(repoState.length / 2);
    promptsAt(files(target - base));

    const rulesOnly = measure(false);
    expect(rulesOnly).toContain(PAD_MARKER);
    // The preconditions that make this test mean something: neither half is
    // over the budget on its own, and the two together are.
    expect(rulesOnly.length).toBeLessThanOrEqual(
      SESSION_START_INJECTION_BUDGET,
    );
    expect(repoState.length).toBeLessThan(SESSION_START_INJECTION_BUDGET);
    expect(rulesOnly.length + 2 + repoState.length).toBeGreaterThan(
      SESSION_START_INJECTION_BUDGET,
    );

    const message = composeSessionStart(repo, {
      firstPrompt: {error: 'test: not armed', ok: false},
      userLevel: false,
    });
    expect(message.forClaude.length).toBeLessThanOrEqual(
      SESSION_START_INJECTION_BUDGET,
    );
    // The last conditional module went, and nothing else did.
    expect(message.forClaude).not.toContain(PAD_MARKER);
    expect(message.forClaude).toContain('RN_A_RULE');
    // The pointer line and the repo state are never dropped.
    expect(message.forClaude).toContain('📋 Justin');
    expect(message.forClaude).toContain('# Current repo state');
    // Claude is told what it did not get, and how to get it.
    expect(message.forClaude).toContain(
      'this injection leaves out 1 rule module that applies to this repo: rn-pad.',
    );
    expect(message.forClaude).toContain(
      '`bunx github:justinhaaheim/justin-sdk prime --module rn-pad`',
    );
    // Justin is told too, by name.
    expect(message.forJustin).toContain('⚠️ 1 rule module left out');
    expect(message.forJustin).toContain('(rn-pad)');
    expect(message.forJustin).toContain(
      '  2. rn-pad (NOT injected: over the hook limit)',
    );
  });
});
