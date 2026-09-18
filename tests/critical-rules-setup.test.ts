/**
 * Tests for the critical-rules component — the COMMITTED per-repo rules
 * artifact (home-base-we85, t6a0.21 D13–D15, epic home-base-dchjw D2).
 *
 * FOUR CONTRACTS ARE UNDER TEST, and each one has a failure mode that is SILENT
 * in production, which is why the negative controls here matter more than the
 * positive assertions:
 *
 *  1. THE REGISTRY DECIDES, EVERY TIME (dchjw D2). A module added to the index
 *     reaches an already-enrolled repo; a repo that gains `expo` picks up the
 *     RN rules without the prompts source moving at all; a `modules` list left
 *     in a config changes nothing. Each arm carries the opposite arm, because
 *     "the module is absent" would also pass for an artifact never written.
 *  2. NO MODULE NAME IS HARDCODED (dchjw.3). The retired DEFAULT_SEED_EXCLUDED
 *     kept s2t-guidelines out of every repo from inside the SDK; it ships like
 *     any other universal module now, and only the registry may decide.
 *  3. THE REFRESH LAYER TOUCHES ONE PATH (Dispatch-B addendum). `rules-update`
 *     commits only .claude/rules/justin-sdk/, so the layer it calls must not
 *     rewrite config or the SDK pin. Asserted git-status-shaped, with unrelated
 *     dirt present, and with the INSTALLER as the sibling negative control that
 *     proves the drift is real and really avoided.
 *  4. CANNOT-CHECK IS NOT IN-SYNC (D15). The managed clone keeps working when a
 *     refresh fails — correct for a reader, fatal for a writer. The failing-fetch
 *     arm must produce a distinct outcome and NO file, and its negative control
 *     is the same fixture with a working remote.
 *
 * Hermetic: JSDK_PROMPTS_DIR (or a sandboxed XDG_CONFIG_HOME plus a local
 * origin) means no network, and JSDK_PRIME_PRETTIER=0 keeps `bunx prettier` out
 * of it except in the one test that deliberately exercises a prettier binary.
 */

import {afterEach, describe, expect, spyOn, test} from 'bun:test';
import {execFileSync} from 'child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import {join} from 'path';

import {
  addUserLevelRulesExclude,
  CLAUDE_MD_EXCLUDES_KEY,
  CRITICAL_RULES_COMPONENT,
  CRITICAL_RULES_CONFIG_KEY,
  hasRetiredModulesKey,
  legacyModulesWarning,
  readEnrollment,
  refreshCriticalRulesArtifact,
  refreshSucceeded,
  runCriticalRulesSetup,
  userLevelRulesExclude,
} from '../src/critical-rules-setup';
import {configNameFor} from '../src/component-registry';
import {
  contentHash,
  deployedIsDirty,
  deployedSourceSha,
  projectRulesFilePath,
  readDeployedStamp,
  rulesFilePath,
  STAMP_PREFIX,
} from '../src/rules/rules-file';
import {rulesDiff} from '../src/rules-diff';
import {checkRulesDrift} from '../src/rules/rules-drift';
import {readJson, setQuiet, writeJson} from '../src/setup-helpers';
import {git} from './git-fixtures';
import {createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
function track(sb: Sandbox): Sandbox {
  sandboxes.push(sb);
  return sb;
}

const SAVED_ENV = {
  home: process.env.HOME,
  promptsDir: process.env.JSDK_PROMPTS_DIR,
  prettier: process.env.JSDK_PRIME_PRETTIER,
  repoUrl: process.env.JSDK_PROMPTS_REPO_URL,
  xdg: process.env.XDG_CONFIG_HOME,
};

function restoreEnv(name: string, value: string | undefined): void {
  if (value == null) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
  restoreEnv('HOME', SAVED_ENV.home);
  restoreEnv('JSDK_PROMPTS_DIR', SAVED_ENV.promptsDir);
  restoreEnv('JSDK_PRIME_PRETTIER', SAVED_ENV.prettier);
  restoreEnv('JSDK_PROMPTS_REPO_URL', SAVED_ENV.repoUrl);
  restoreEnv('XDG_CONFIG_HOME', SAVED_ENV.xdg);
  setQuiet(false);
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * The rules-index shape that matters: universal modules, one carrying a unique
 * marker, and project-type-gated modules sitting in the MIDDLE of the index (so
 * an order bug is visible).
 */
const RULES_FILES: Record<string, string> = {
  'src/rules/index.md': [
    '@./alpha.md',
    '@./s2t-guidelines.md',
    '@./beads-only.md',
    '@./rn-only.md',
    '@./omega.md',
  ].join('\n\n'),
  'src/rules/alpha.md': '# Alpha\n\nALPHA_RULE',
  // 'Dakota' is the marker unique to s2t-guidelines in the real prompts repo —
  // the wake word. It ships to every repo (Justin, 2026-09-18); the SDK used to
  // hold a hardcoded exclusion for exactly this module, and no longer may.
  'src/rules/s2t-guidelines.md': '# Speech to text\n\nThe Dakota wake word.',
  'src/rules/beads-only.md':
    '---\nincludeIf: [isBeadsRust]\n---\n\n# Beads\n\nBEADS_ONLY_RULE',
  'src/rules/rn-only.md':
    '---\nincludeIf: [isReactNative]\n---\n\n# React Native\n\nRN_ONLY_RULE',
  'src/rules/omega.md': '# Omega\n\nOMEGA_RULE',
};

/** A non-git prompts fixture, pointed at via JSDK_PROMPTS_DIR. */
function promptsFixture(extra: Record<string, string> = {}): string {
  process.env.JSDK_PRIME_PRETTIER = '0';
  const sb = track(createSandbox());
  for (const [rel, content] of Object.entries({...RULES_FILES, ...extra})) {
    sb.writeFile(rel, content);
  }
  process.env.JSDK_PROMPTS_DIR = sb.path;
  return sb.path;
}

/** The same content as a REAL git checkout, so headSha() is non-null. */
function gitPromptsFixture(): {dir: string; sha: string} {
  process.env.JSDK_PRIME_PRETTIER = '0';
  const sb = track(createSandbox());
  const dir = initRepoAt(join(sb.path, 'prompts'), RULES_FILES);
  process.env.JSDK_PROMPTS_DIR = dir;
  return {dir, sha: git(dir, ['rev-parse', 'HEAD']).trim()};
}

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

interface ProjectOptions {
  /** package.json dependencies — drives isReact/isReactNative at every refresh. */
  deps?: Record<string, string>;
  /** Write a beads_rust .beads/metadata.json — drives isBeadsRust. */
  beads?: boolean;
  /**
   * Write the RETIRED `componentConfig["critical-rules"].modules` block, as the
   * fleet's configs still carry it. Nothing may honour it.
   */
  modules?: string[];
  /** Omit justin-sdk.config.json entirely. */
  noConfig?: boolean;
  /** Extra files (used to give a git fixture something unrelated to dirty). */
  files?: Record<string, string>;
  /** Make it a real git repo (for the git-status-shaped assertions). */
  git?: boolean;
}

function projectFixture(options: ProjectOptions = {}): string {
  const sb = track(createSandbox());
  const files: Record<string, string> = {
    'package.json':
      JSON.stringify(
        {dependencies: options.deps ?? {lodash: '*'}, name: 'fixture'},
        null,
        2,
      ) + '\n',
    ...(options.files ?? {}),
  };
  if (options.beads === true) {
    files['.beads/metadata.json'] =
      '{"database":"beads.db","jsonl_export":"issues.jsonl"}';
  }
  if (options.noConfig !== true) {
    files['justin-sdk.config.json'] =
      JSON.stringify(
        {
          components: ['base-setup', 'critical-rules-setup'],
          lastSynced: '2000-01-01',
          version: '0.0.1-fixture',
          ...(options.modules != null
            ? {
                componentConfig: {
                  [CRITICAL_RULES_CONFIG_KEY]: {modules: options.modules},
                },
              }
            : {}),
        },
        null,
        2,
      ) + '\n';
  }
  if (options.git === true) return initRepoAt(join(sb.path, 'repo'), files);
  for (const [rel, content] of Object.entries(files))
    sb.writeFile(rel, content);
  return sb.path;
}

/** Every path git reports as changed, untracked files listed individually. */
function statusPaths(repo: string): Set<string> {
  return new Set(
    git(repo, ['status', '--porcelain', '-uall'])
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => line.slice(3)),
  );
}

const ARTIFACT_REL = '.claude/rules/justin-sdk/critical-rules.md';

function readArtifact(projectRoot: string): string {
  return readFileSync(projectRulesFilePath(projectRoot), 'utf-8');
}

// ---------------------------------------------------------------------------
// The registry decides, at EVERY refresh (epic home-base-dchjw D2)
//
// These are the tests the deleted design could not have passed. Under the
// retired per-repo include-list, every one of them would have gone the other
// way SILENTLY: a new registry module never reaching an enrolled repo, a repo
// that became an Expo app never picking up the RN rules, and rules-drift
// certifying both as in-sync. Each arm therefore carries its negative control,
// so it cannot pass because the fixture was inert.
// ---------------------------------------------------------------------------

describe('assembly resolves the module set from the registry + predicates', () => {
  test('a module ADDED to the index reaches an already-enrolled repo; removing it takes it away', () => {
    setQuiet(true);
    // The repo is enrolled and its artifact already written, from an index that
    // does not mention `newcomer`.
    const dir = promptsFixture();
    const root = projectFixture();
    const first = refreshCriticalRulesArtifact(root, {promptsDir: dir});
    if (!refreshSucceeded(first)) throw new Error(first.message);
    expect(readArtifact(root)).not.toContain('NEWCOMER_RULE');

    // Now the registry gains a module. Nothing about the repo changes.
    writeFileSync(
      join(dir, 'src/rules/newcomer.md'),
      '# Newcomer\n\nNEWCOMER_RULE',
    );
    writeFileSync(
      join(dir, 'src/rules/index.md'),
      ['@./alpha.md', '@./newcomer.md', '@./omega.md'].join('\n\n'),
    );
    const second = refreshCriticalRulesArtifact(root, {promptsDir: dir});
    if (!refreshSucceeded(second)) throw new Error(second.message);
    expect(second.status).toBe('written');
    expect(second.modules).toEqual(['alpha', 'newcomer', 'omega']);
    expect(readArtifact(root)).toContain('NEWCOMER_RULE');

    // NEGATIVE CONTROL: take it back out of the index and it leaves the repo.
    writeFileSync(
      join(dir, 'src/rules/index.md'),
      ['@./alpha.md', '@./omega.md'].join('\n\n'),
    );
    const third = refreshCriticalRulesArtifact(root, {promptsDir: dir});
    if (!refreshSucceeded(third)) throw new Error(third.message);
    expect(third.modules).toEqual(['alpha', 'omega']);
    expect(readArtifact(root)).not.toContain('NEWCOMER_RULE');
  });

  test('a repo that gains `expo` AFTER enrollment picks up the RN rules on the next refresh', () => {
    setQuiet(true);
    const dir = promptsFixture();
    // Enrolled as a plain node project: no expo, so no RN module.
    const root = projectFixture();
    const before = refreshCriticalRulesArtifact(root, {promptsDir: dir});
    if (!refreshSucceeded(before)) throw new Error(before.message);
    expect(before.modules).not.toContain('rn-only');
    expect(readArtifact(root)).not.toContain('RN_ONLY_RULE');

    // The project becomes an Expo app. The prompts source does not move at all.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({dependencies: {expo: '*'}, name: 'fixture'}, null, 2) +
        '\n',
    );
    const after = refreshCriticalRulesArtifact(root, {promptsDir: dir});
    if (!refreshSucceeded(after)) throw new Error(after.message);
    expect(after.modules).toContain('rn-only');
    expect(readArtifact(root)).toContain('RN_ONLY_RULE');
    // The module set changed, so the header's fingerprint must have moved —
    // that is what makes rules-drift report this as stale (F3).
    expect(after.moduleFingerprint).not.toBe(before.moduleFingerprint);
  });

  test('predicates gate at every refresh: a beads repo gets the beads module, a plain one does not', () => {
    setQuiet(true);
    const dir = promptsFixture();
    const beads = projectFixture({beads: true});
    const plain = projectFixture();

    const withBeads = refreshCriticalRulesArtifact(beads, {promptsDir: dir});
    const without = refreshCriticalRulesArtifact(plain, {promptsDir: dir});
    if (!refreshSucceeded(withBeads) || !refreshSucceeded(without)) {
      throw new Error('unreachable');
    }
    expect(withBeads.modules).toContain('beads-only');
    expect(without.modules).not.toContain('beads-only');
  });

  test('NO module name is hardcoded: s2t-guidelines ships like any other universal module', () => {
    // The retired DEFAULT_SEED_EXCLUDED kept exactly this module out of every
    // repo from inside the SDK. If a hardcoded exclusion ever comes back, this
    // fails — the registry is the only thing allowed to decide.
    setQuiet(true);
    const dir = promptsFixture();
    const root = projectFixture();
    const outcome = refreshCriticalRulesArtifact(root, {promptsDir: dir});
    if (!refreshSucceeded(outcome)) throw new Error(outcome.message);
    expect(outcome.modules).toContain('s2t-guidelines');
    expect(readArtifact(root)).toContain('Dakota');
  });

  test('index order is the document order, whatever the config says', () => {
    setQuiet(true);
    const dir = promptsFixture();
    const root = projectFixture({modules: ['omega', 'alpha']});
    const outcome = refreshCriticalRulesArtifact(root, {promptsDir: dir});
    if (!refreshSucceeded(outcome)) throw new Error(outcome.message);
    const markdown = readArtifact(root);
    expect(markdown.indexOf('ALPHA_RULE')).toBeLessThan(
      markdown.indexOf('OMEGA_RULE'),
    );
    expect(markdown).toContain('# 1. Alpha');
  });

  test('an unknown predicate excludes the module LOUDLY, never silently', () => {
    // The t6a0.20 failure class. The retired design froze the predicate results
    // to dodge it; the defence now is that the exclusion is WARNED about and
    // moves the fingerprint, so it shows up in the committed diff.
    setQuiet(true);
    const dir = promptsFixture({
      'src/rules/index.md': ['@./alpha.md', '@./future.md'].join('\n\n'),
      'src/rules/future.md':
        '---\nincludeIf: [isSomePredicateFromTheFuture]\n---\n\n# Future\n\nFUTURE_RULE',
    });
    const root = projectFixture();
    const outcome = refreshCriticalRulesArtifact(root, {promptsDir: dir});
    if (!refreshSucceeded(outcome)) throw new Error(outcome.message);
    expect(outcome.modules).toEqual(['alpha']);
    expect(readArtifact(root)).not.toContain('FUTURE_RULE');
    expect(outcome.warnings.join('\n')).toContain(
      'isSomePredicateFromTheFuture',
    );
  });

  test('an index that resolves to NOTHING refuses to write an empty artifact', () => {
    // An empty rules file that reports success is the total-omission failure
    // this whole component exists to prevent.
    setQuiet(true);
    const dir = promptsFixture({'src/rules/index.md': '# Nothing here\n'});
    const root = projectFixture();
    const outcome = refreshCriticalRulesArtifact(root, {promptsDir: dir});
    expect(refreshSucceeded(outcome)).toBe(false);
    expect(existsSync(projectRulesFilePath(root))).toBe(false);
  });

  test('frontmatter never survives into the output', () => {
    setQuiet(true);
    const dir = promptsFixture();
    const root = projectFixture({beads: true, deps: {expo: '*'}});
    const outcome = refreshCriticalRulesArtifact(root, {promptsDir: dir});
    if (!refreshSucceeded(outcome)) throw new Error(outcome.message);
    const markdown = readArtifact(root);
    expect(markdown).not.toContain('includeIf');
    expect(markdown).not.toMatch(/^---/m);
  });
});

// ---------------------------------------------------------------------------
// The retired per-repo include-list: ignored, and said out loud (dchjw.3)
// ---------------------------------------------------------------------------

describe('a config still carrying componentConfig["critical-rules"].modules', () => {
  test('is IGNORED — the artifact regenerates from the whole registry', () => {
    setQuiet(true);
    const dir = promptsFixture();
    // The exact shape the fleet carries today, and the exact harm: a list that
    // omits most of the registry. Under the retired design this repo got two
    // modules forever.
    const root = projectFixture({modules: ['alpha']});
    const outcome = refreshCriticalRulesArtifact(root, {promptsDir: dir});
    if (!refreshSucceeded(outcome)) throw new Error(outcome.message);

    expect(outcome.modules).toEqual(['alpha', 's2t-guidelines', 'omega']);
    const markdown = readArtifact(root);
    expect(markdown).toContain('OMEGA_RULE');
    expect(markdown).toContain('Dakota');
  });

  test('is DETECTED, with one shared warning naming the key', () => {
    const root = projectFixture({modules: ['alpha']});
    const message = legacyModulesWarning(root);
    expect(message).not.toBeNull();
    expect(message).toContain('critical-rules');
    expect(message).toContain('modules');
    expect(hasRetiredModulesKey(root)).toBe(true);
  });

  test('NEGATIVE CONTROL: a config without the key produces no warning at all', () => {
    const root = projectFixture();
    expect(legacyModulesWarning(root)).toBeNull();
    expect(hasRetiredModulesKey(root)).toBe(false);
  });

  test('NEGATIVE CONTROL: a config with the BLOCK but no modules key is not flagged', () => {
    // `componentConfig["critical-rules"]` may legitimately hold future keys.
    // Only the retired one is the warning's subject.
    const sb = track(createSandbox());
    sb.writeFile('package.json', '{"name":"fixture"}');
    sb.writeFile(
      'justin-sdk.config.json',
      JSON.stringify({
        componentConfig: {[CRITICAL_RULES_CONFIG_KEY]: {}},
        components: ['critical-rules-setup'],
      }),
    );
    expect(hasRetiredModulesKey(sb.path)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Enrollment is the component list or the artifact — never the module list (F2)
// ---------------------------------------------------------------------------

describe('readEnrollment', () => {
  test('a repo with critical-rules-setup in components and NO modules key is ENROLLED', () => {
    // The whole point of F2: the retired reader answered "not enrolled" here,
    // which silently switched off every rules check for the entire fleet the
    // moment the modules blocks are swept away.
    const root = projectFixture();
    const read = readEnrollment(root);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.evidence).toBe('components');
  });

  test('a repo carrying the ARTIFACT is enrolled whatever its config says', () => {
    const sb = track(createSandbox());
    sb.writeFile(ARTIFACT_REL, '# Critical Rules\n');
    const read = readEnrollment(sb.path);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.evidence).toBe('artifact');
  });

  test('NEGATIVE CONTROL: no component, no artifact = not-enrolled', () => {
    const sb = track(createSandbox());
    sb.writeFile(
      'justin-sdk.config.json',
      JSON.stringify({components: ['base-setup']}),
    );
    const read = readEnrollment(sb.path);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.status).toBe('not-enrolled');
  });

  test('an UNPARSEABLE config is a failure, never a "no" (critical rule 6)', () => {
    const sb = track(createSandbox());
    sb.writeFile('justin-sdk.config.json', '{ not json');
    const read = readEnrollment(sb.path);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.status).toBe('failed');
  });

  test('a components key that is not an array is a failure, never a "no"', () => {
    const sb = track(createSandbox());
    sb.writeFile(
      'justin-sdk.config.json',
      JSON.stringify({components: 'critical-rules-setup'}),
    );
    const read = readEnrollment(sb.path);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.status).toBe('failed');
  });

  test('the component name matches the one components.ts registers', () => {
    // rules-enrollment.ts spells it by hand (it ships in the plugin's
    // self-contained file set and may not import components.ts). This is the
    // guard that the two never drift apart.
    expect(CRITICAL_RULES_COMPONENT).toBe(configNameFor('critical-rules'));
  });
});

// ---------------------------------------------------------------------------
// The artifact: shape, stamp, idempotency
// ---------------------------------------------------------------------------

describe('the committed artifact', () => {
  test('writes .claude/rules/justin-sdk/critical-rules.md with an HTML-comment stamp carrying the prompts commit, its date and the module fingerprint', () => {
    setQuiet(true);
    const {dir, sha} = gitPromptsFixture();
    const root = projectFixture();

    const outcome = refreshCriticalRulesArtifact(root, {
      promptsDir: dir,
    });
    expect(outcome.status).toBe('written');
    if (!refreshSucceeded(outcome)) throw new Error('unreachable');
    expect(outcome.sourceCommit?.sha).toBe(sha);

    const body = readArtifact(root);
    const firstLine = body.split('\n')[0] ?? '';
    expect(firstLine.startsWith(STAMP_PREFIX)).toBe(true);
    expect(firstLine).toContain(`prompts ${sha.slice(0, 12)}`);
    // The prompts COMMIT date, in parentheses after the sha — not the date of
    // this run, which would churn the bytes of twelve committed files daily.
    const commitDate = git(dir, ['show', '-s', '--format=%cs', 'HEAD']).trim();
    expect(firstLine).toContain(`(${commitDate})`);
    expect(firstLine).toContain(`modules ${outcome.moduleFingerprint}`);
    // NO SDK version (F6): an SDK release must not move these bytes.
    expect(firstLine).not.toMatch(/· v\d/);
    expect(firstLine).not.toContain('generated ');
    expect(firstLine.endsWith('-->')).toBe(true);
    // The stamp names the command that regenerates THIS file, not sync-rules
    // (which would regenerate the user-level one).
    expect(firstLine).toContain('rules-update');
    expect(firstLine).not.toContain('sync-rules');

    // NO YAML frontmatter, anywhere: a `paths:` field would demote the file from
    // "loaded at launch" to "lazy-loaded", i.e. usually not loaded at all (D1).
    expect(body.startsWith('---')).toBe(false);
    expect(body).not.toMatch(/^---\s*$/m);
    expect(body).toContain('# Critical Rules');
    // The reader contract the staleness check (home-base-si46) will use: the
    // sha fast-path resolves, and the version field reads 'unknown' BY DESIGN
    // (no SDK version is stamped, so an SDK release can't move these bytes).
    const stamp = readDeployedStamp(projectRulesFilePath(root));
    expect(stamp?.contentHash).toBe(outcome.contentHash);
    expect(stamp?.moduleFingerprint).toBe(outcome.moduleFingerprint);
    expect(stamp?.promptsDate).toBe(commitDate);
    expect(deployedSourceSha(stamp)).toBe(sha.slice(0, 12));
    expect(deployedIsDirty(stamp)).toBe(false);
    expect(stamp?.version).toBe('unknown');
  });

  test('a second run is a no-op, and --force reproduces the SAME bytes', () => {
    setQuiet(true);
    const {dir} = gitPromptsFixture();
    const root = projectFixture();

    expect(refreshCriticalRulesArtifact(root, {promptsDir: dir}).status).toBe(
      'written',
    );
    const bytes = readArtifact(root);

    const second = refreshCriticalRulesArtifact(root, {
      promptsDir: dir,
    });
    expect(second.status).toBe('unchanged');
    expect(readArtifact(root)).toBe(bytes);

    // --force rewrites, and the bytes come out IDENTICAL: the header carries no
    // generation timestamp any more, so the artifact is a pure function of
    // (prompts commit, project). That is what keeps a branch and a swept main
    // byte-identical across days.
    expect(
      refreshCriticalRulesArtifact(root, {
        force: true,
        promptsDir: dir,
      }).status,
    ).toBe('written');
    expect(readArtifact(root)).toBe(bytes);
  });

  test('a HAND EDIT that keeps the header is repaired by a plain refresh', () => {
    // The retired idempotency gate was the stamp's own content hash, so an
    // edited body under a header still claiming the canonical hash was reported
    // "already in sync" and left wrong. It is a BYTE comparison now.
    setQuiet(true);
    const {dir} = gitPromptsFixture();
    const root = projectFixture();
    expect(refreshCriticalRulesArtifact(root, {promptsDir: dir}).status).toBe(
      'written',
    );
    const canonical = readArtifact(root);

    writeFileSync(
      projectRulesFilePath(root),
      canonical.replace('ALPHA_RULE', 'HAND_EDITED'),
    );
    expect(readArtifact(root)).toContain('HAND_EDITED');

    expect(refreshCriticalRulesArtifact(root, {promptsDir: dir}).status).toBe(
      'written',
    );
    expect(readArtifact(root)).toBe(canonical);

    // NEGATIVE CONTROL: with the edit gone, the very same call is a no-op — so
    // the 'written' above really was caused by the edit.
    expect(refreshCriticalRulesArtifact(root, {promptsDir: dir}).status).toBe(
      'unchanged',
    );
  });

  test('formats with the TARGET REPO’s own prettier when it has one', () => {
    // The artifact is committed and checked by the repo's own signal, which the
    // sweep gates on — so it must be formatted by the prettier that repo pinned,
    // not by whatever `bunx prettier` resolves today.
    const {dir} = gitPromptsFixture();
    delete process.env.JSDK_PRIME_PRETTIER; // prettier ON for this test only
    setQuiet(true);
    const root = projectFixture({modules: ['alpha']});
    const binDir = join(root, 'node_modules', '.bin');
    mkdirSync(binDir, {recursive: true});
    const fake = join(binDir, 'prettier');
    // Marks the content it is handed, so "which prettier ran" is observable.
    // It reads STDIN and writes STDOUT because that is how the formatter is
    // now invoked (--stdin-filepath, t6a0.21.1) — a fake that appended to a
    // path argument would CREATE the artifact behind the writer's back, and
    // would also be run by setup-helpers' writeJson (`--write
    // --ignore-unknown <path>`) and by the post-write `--check`.
    writeFileSync(fake, "#!/bin/sh\ncat\nprintf 'LOCAL_PRETTIER_RAN\\n'\n");
    chmodSync(fake, 0o755);

    expect(refreshCriticalRulesArtifact(root, {promptsDir: dir}).status).toBe(
      'written',
    );
    expect(readArtifact(root)).toContain('LOCAL_PRETTIER_RAN');
  });

  test('a prettier that FAILS blocks the write — it never yields unformatted bytes', () => {
    // The rule-5 half of t6a0.21.1. Unformatted bytes here get COMMITTED and
    // fail the repo's own gate three steps later with no hint why, and their
    // stamped hash describes bytes no reader can reproduce.
    const {dir} = gitPromptsFixture();
    delete process.env.JSDK_PRIME_PRETTIER; // prettier ON for this test only
    setQuiet(true);
    const root = projectFixture({modules: ['alpha']});
    const binDir = join(root, 'node_modules', '.bin');
    mkdirSync(binDir, {recursive: true});
    const fake = join(binDir, 'prettier');
    writeFileSync(fake, '#!/bin/sh\necho "prettier exploded" >&2\nexit 2\n');
    chmodSync(fake, 0o755);

    const outcome = refreshCriticalRulesArtifact(root, {
      promptsDir: dir,
    });
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('unreachable');
    expect(outcome.message).toContain('prettier exploded');
    expect(outcome.message).toContain(fake);
    // NOTHING on disk: a half-formatted artifact is worse than none.
    expect(existsSync(projectRulesFilePath(root))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The committed bytes are the TARGET REPO'S prettier output (home-base-t6a0.21.1)
//
// The P0 this guards: `findLocalPrettier` correctly located the repo's BINARY,
// but the content was formatted in a scratch directory, so prettier resolved its
// CONFIG from there — i.e. the defaults. The artifact then failed the enrolled
// repo's own `prettier --check .`, which is precisely `signal-source:PRETTIER`,
// which is precisely what `sweep --component critical-rules` gates on.
//
// So this suite runs a REAL prettier against a repo whose config differs from
// the defaults on an option the rules content exercises (nature-sounds' actual
// divergence: `bracketSpacing: false` against a fenced json example), and
// asserts byte equality with that repo's prettier output — not "prettier ran".
// ---------------------------------------------------------------------------

/** The SDK's own prettier — a devDependency, so this is offline and pinned. */
const REAL_PRETTIER = join(
  import.meta.dir,
  '..',
  'node_modules',
  '.bin',
  'prettier',
);

/** Give a fixture repo a real local prettier, the way an enrolled repo has one. */
function installRealPrettier(root: string): string {
  if (!existsSync(REAL_PRETTIER)) {
    throw new Error(
      `missing ${REAL_PRETTIER} — prettier is a devDependency of this repo precisely so this test can run a real one`,
    );
  }
  const binDir = join(root, 'node_modules', '.bin');
  mkdirSync(binDir, {recursive: true});
  const shim = join(binDir, 'prettier');
  writeFileSync(shim, `#!/bin/sh\nexec "${REAL_PRETTIER}" "$@"\n`);
  chmodSync(shim, 0o755);
  return shim;
}

/** A rules module whose body is a json fence — the surface where a config
 * difference between the repo and prettier's defaults becomes visible bytes. */
const FENCED_ALPHA =
  '# Alpha\n\nALPHA_RULE\n\n```json\n{ "proseWrap": "preserve" }\n```\n';
const REPO_SPELLING = '{"proseWrap": "preserve"}'; // bracketSpacing: false
const DEFAULT_SPELLING = '{ "proseWrap": "preserve" }'; // prettier's default

describe('the committed artifact is byte-identical to the repo prettier output', () => {
  test('the repo config wins, and the bytes on disk are exactly what that prettier emits', () => {
    const promptsDir = promptsFixture({'src/rules/alpha.md': FENCED_ALPHA});
    delete process.env.JSDK_PRIME_PRETTIER; // prettier ON for this test only
    setQuiet(true);
    const root = projectFixture({
      files: {
        '.prettierrc.json': `${JSON.stringify({bracketSpacing: false}, null, 2)}\n`,
      },
      modules: ['alpha'],
    });
    const prettier = installRealPrettier(root);

    expect(refreshCriticalRulesArtifact(root, {promptsDir}).status).toBe(
      'written',
    );

    const file = projectRulesFilePath(root);
    const bytes = readFileSync(file, 'utf-8');

    // (1) BYTE EQUALITY with what this repo's prettier produces for this path.
    //     Not "prettier ran": the exact output, compared whole.
    const repoPrettierOutput = execFileSync(prettier, [file], {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(bytes).toBe(repoPrettierOutput);

    // (2) The repo's config really is the one that applied.
    expect(bytes).toContain(REPO_SPELLING);
    expect(bytes).not.toContain(DEFAULT_SPELLING);

    // (3) NEGATIVE CONTROL, in-test: the same content formatted OUTSIDE the
    //     repo — which is exactly what the old implementation did — produces
    //     the OTHER spelling. Without this arm, (2) would also pass for a
    //     fixture whose fence happened to be config-insensitive.
    const outsideRepo = execFileSync(
      prettier,
      [
        '--ignore-path',
        '/dev/null',
        '--stdin-filepath',
        join(root, '..', 'elsewhere', 'critical-rules.md'),
      ],
      {
        cwd: root,
        encoding: 'utf-8',
        input: FENCED_ALPHA,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    expect(outsideRepo).toContain(DEFAULT_SPELLING);
    expect(outsideRepo).not.toContain(REPO_SPELLING);
  });

  test('the READERS canonicalize to the same bytes, so a fresh artifact is in sync', () => {
    // The crux of the fix: rules-drift/rules-diff must reach byte-identical
    // canonical content WITHOUT writing the artifact's real path. If they
    // resolved a different config, every freshly generated artifact in every
    // enrolled repo would report drift on the very next session.
    const promptsDir = promptsFixture({'src/rules/alpha.md': FENCED_ALPHA});
    delete process.env.JSDK_PRIME_PRETTIER;
    setQuiet(true);
    const root = projectFixture({
      files: {
        '.prettierrc.json': `${JSON.stringify({bracketSpacing: false}, null, 2)}\n`,
      },
      modules: ['alpha'],
    });
    installRealPrettier(root);

    expect(refreshCriticalRulesArtifact(root, {promptsDir}).status).toBe(
      'written',
    );

    expect(checkRulesDrift(root, {promptsDir}).status).toBe('in-sync');
    expect(rulesDiff({projectRoot: root, promptsDir}).outcome).toBe('in-sync');
  });

  test('the COMMITTED bytes are checked against the repo prettier, and a non-fixpoint warns', () => {
    // The body is formatted, but the stamp is prepended afterwards (it carries
    // the hash OF that body). Whether prettier leaves a stamped file alone is
    // therefore an assumption, so the writer checks it — this proves the check
    // is wired and speaks up. The fake formats happily and only fails --check,
    // which is exactly the shape of "the stamp perturbed formatting".
    const promptsDir = promptsFixture();
    delete process.env.JSDK_PRIME_PRETTIER;
    setQuiet(false); // warn() is suppressed in quiet mode
    const warns = spyOn(console, 'warn').mockImplementation(() => {});
    const logs = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const root = projectFixture({modules: ['alpha']});
      const binDir = join(root, 'node_modules', '.bin');
      mkdirSync(binDir, {recursive: true});
      const fake = join(binDir, 'prettier');
      writeFileSync(
        fake,
        '#!/bin/sh\ncase "$1" in --check) exit 1 ;; esac\ncat\n',
      );
      chmodSync(fake, 0o755);

      expect(refreshCriticalRulesArtifact(root, {promptsDir}).status).toBe(
        'written',
      );
      const said = warns.mock.calls.flat().join('\n');
      expect(said).toContain('does NOT satisfy');
      expect(said).toContain(ARTIFACT_REL);
    } finally {
      warns.mockRestore();
      logs.mockRestore();
    }
  });

  test('NEGATIVE CONTROL: a prettier-clean artifact produces NO such warning', () => {
    const promptsDir = promptsFixture();
    delete process.env.JSDK_PRIME_PRETTIER;
    setQuiet(false);
    const warns = spyOn(console, 'warn').mockImplementation(() => {});
    const logs = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const root = projectFixture({modules: ['alpha']});
      const binDir = join(root, 'node_modules', '.bin');
      mkdirSync(binDir, {recursive: true});
      const fake = join(binDir, 'prettier');
      // Identical to the arm above except --check succeeds.
      writeFileSync(
        fake,
        '#!/bin/sh\ncase "$1" in --check) exit 0 ;; esac\ncat\n',
      );
      chmodSync(fake, 0o755);

      expect(refreshCriticalRulesArtifact(root, {promptsDir}).status).toBe(
        'written',
      );
      expect(warns.mock.calls.flat().join('\n')).not.toContain(
        'does NOT satisfy',
      );
    } finally {
      warns.mockRestore();
      logs.mockRestore();
    }
  });

  test('NEGATIVE CONTROL: a hand-edit to the repo spelling IS detected', () => {
    // Proves the in-sync verdicts above are measurements, not a checker that
    // says in-sync no matter what.
    const promptsDir = promptsFixture({'src/rules/alpha.md': FENCED_ALPHA});
    delete process.env.JSDK_PRIME_PRETTIER;
    setQuiet(true);
    const root = projectFixture({
      files: {
        '.prettierrc.json': `${JSON.stringify({bracketSpacing: false}, null, 2)}\n`,
      },
      modules: ['alpha'],
    });
    installRealPrettier(root);
    expect(refreshCriticalRulesArtifact(root, {promptsDir}).status).toBe(
      'written',
    );

    const file = projectRulesFilePath(root);
    writeFileSync(
      file,
      readFileSync(file, 'utf-8').replace(REPO_SPELLING, DEFAULT_SPELLING),
    );
    expect(checkRulesDrift(root, {promptsDir}).status).toBe('locally-modified');
    expect(rulesDiff({projectRoot: root, promptsDir}).outcome).not.toBe(
      'in-sync',
    );
  });
});

// ---------------------------------------------------------------------------
// Layer (a) narrowness — the property rules-update depends on
// ---------------------------------------------------------------------------

describe('refreshCriticalRulesArtifact touches ONE path', () => {
  test('only the artifact changes, even with unrelated dirt already present', () => {
    setQuiet(true);
    const {dir} = gitPromptsFixture();
    const repo = projectFixture({
      files: {'src/app.ts': 'export const a = 1;\n'},
      git: true,
      modules: ['alpha', 'omega'],
    });
    // Pre-existing dirt of both kinds: a modified tracked file and an untracked
    // one. A layer that "helpfully" normalized the tree would show up here.
    writeFileSync(join(repo, 'src/app.ts'), 'export const a = 2;\n');
    writeFileSync(join(repo, 'scratch.txt'), 'scratch\n');
    const before = statusPaths(repo);
    const cfgBytes = readFileSync(
      join(repo, 'justin-sdk.config.json'),
      'utf-8',
    );
    const pkgBytes = readFileSync(join(repo, 'package.json'), 'utf-8');

    expect(refreshCriticalRulesArtifact(repo, {promptsDir: dir}).status).toBe(
      'written',
    );

    const after = statusPaths(repo);
    const added = [...after].filter((p) => !before.has(p));
    expect(added).toEqual([ARTIFACT_REL]);
    // The pre-existing dirt is still exactly as it was (nothing reverted).
    for (const path of before) expect(after.has(path)).toBe(true);
    expect(readFileSync(join(repo, 'justin-sdk.config.json'), 'utf-8')).toBe(
      cfgBytes,
    );
    expect(readFileSync(join(repo, 'package.json'), 'utf-8')).toBe(pkgBytes);
    expect(readFileSync(join(repo, 'src/app.ts'), 'utf-8')).toBe(
      'export const a = 2;\n',
    );
  });

  test('NEGATIVE CONTROL: the INSTALLER does move config, which is why the layers are split', async () => {
    // If this ever stops being true, the split (and the sweep's pin-neutrality
    // guard) can be retired — deliberately, not by accident.
    setQuiet(true);
    const {dir} = gitPromptsFixture();
    const repo = projectFixture({
      files: {'src/app.ts': 'export const a = 1;\n'},
      git: true,
      modules: ['alpha', 'omega'],
    });
    const before = statusPaths(repo);
    const cfgBytes = readFileSync(
      join(repo, 'justin-sdk.config.json'),
      'utf-8',
    );

    const exit = await runCriticalRulesSetup({
      projectRoot: repo,
      promptsDir: dir,
      quiet: true,
    });
    expect(exit).toBe(0);

    const after = statusPaths(repo);
    const added = [...after].filter((p) => !before.has(p));
    expect(added).toContain(ARTIFACT_REL);
    // …and MORE than the artifact: base-setup's own scaffolding + the config.
    expect(added.length).toBeGreaterThan(1);
    expect(
      readFileSync(join(repo, 'justin-sdk.config.json'), 'utf-8'),
    ).not.toBe(cfgBytes);
    expect(
      (readJson(join(repo, 'justin-sdk.config.json')) ?? {}).version,
    ).not.toBe('0.0.1-fixture');
  });

  test('the installer writes the artifact from the registry in one pass', async () => {
    setQuiet(true);
    const {dir} = gitPromptsFixture();
    const root = projectFixture({beads: true, deps: {expo: '*'}});

    expect(
      await runCriticalRulesSetup({
        projectRoot: root,
        promptsDir: dir,
        quiet: true,
      }),
    ).toBe(0);

    const body = readArtifact(root);
    expect(body).toContain('BEADS_ONLY_RULE');
    expect(body).toContain('RN_ONLY_RULE');
    // s2t-guidelines ships everywhere now (Justin, 2026-09-18) — the retired
    // DEFAULT_SEED_EXCLUDED kept it out of every repo from inside the SDK.
    expect(body).toContain('Dakota');
    // It records NO module selection: there is no per-repo list to record.
    const config = readJson(join(root, 'justin-sdk.config.json')) ?? {};
    const block = (config.componentConfig as Record<string, unknown>)?.[
      CRITICAL_RULES_CONFIG_KEY
    ];
    expect(block).toBeUndefined();
  });

  test('NEGATIVE CONTROL: a plain node project gets neither gated module', async () => {
    setQuiet(true);
    const {dir} = gitPromptsFixture();
    const root = projectFixture();
    expect(
      await runCriticalRulesSetup({
        projectRoot: root,
        promptsDir: dir,
        quiet: true,
      }),
    ).toBe(0);
    const body = readArtifact(root);
    expect(body).not.toContain('BEADS_ONLY_RULE');
    expect(body).not.toContain('RN_ONLY_RULE');
    expect(body).toContain('ALPHA_RULE');
  });
});

// ---------------------------------------------------------------------------
// Failure is not empty — every refusal is its own state
// ---------------------------------------------------------------------------

describe('refresh refusals are distinct and never write', () => {
  test('a rules index that resolves to nothing is failed, not an empty artifact', () => {
    setQuiet(true);
    const dir = promptsFixture({'src/rules/index.md': '# no references\n'});
    const root = projectFixture();
    const outcome = refreshCriticalRulesArtifact(root, {promptsDir: dir});
    expect(outcome.status).toBe('failed');
    expect(existsSync(projectRulesFilePath(root))).toBe(false);
  });

  test('a MISSING rules index is failed and leaves any existing artifact alone', () => {
    setQuiet(true);
    const {dir} = gitPromptsFixture();
    const root = projectFixture();
    expect(refreshCriticalRulesArtifact(root, {promptsDir: dir}).status).toBe(
      'written',
    );
    const good = readArtifact(root);

    const outcome = refreshCriticalRulesArtifact(root, {
      promptsDir: join(dir, 'no-such-prompts-checkout'),
    });
    expect(outcome.status).toBe('failed');
    if (refreshSucceeded(outcome)) throw new Error('unreachable');
    expect(outcome.message).toContain('rules index');
    // A broken source must never silently shrink the delivered rules.
    expect(readArtifact(root)).toBe(good);
  });

  test('a repo with NO justin-sdk.config.json still gets its artifact written', () => {
    // The refresh layer does not gate on enrolment — `rules-update` does. This
    // is the call `add critical-rules` makes while it is still enrolling.
    setQuiet(true);
    const dir = promptsFixture();
    const root = projectFixture({noConfig: true});
    const outcome = refreshCriticalRulesArtifact(root, {promptsDir: dir});
    expect(outcome.status).toBe('written');
    expect(existsSync(projectRulesFilePath(root))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D15: a failed refresh never becomes a committed artifact
// ---------------------------------------------------------------------------

/**
 * Point the managed-clone machinery at a sandbox and return where it will look.
 * Nothing here may touch the real ~/.config/justin-sdk/prompts — the assertions
 * below name the sandbox path explicitly, so a leak fails the test loudly rather
 * than quietly fetching (or `reset --hard`ing) Justin's real clone.
 */
function sandboxedManagedClone(): {cloneDir: string; sandbox: string} {
  process.env.JSDK_PRIME_PRETTIER = '0';
  delete process.env.JSDK_PROMPTS_DIR; // force the managed-clone path
  const sb = track(createSandbox());
  process.env.XDG_CONFIG_HOME = sb.path;
  return {cloneDir: join(sb.path, 'justin-sdk', 'prompts'), sandbox: sb.path};
}

describe('D15 — cannot-refresh is not in-sync', () => {
  test('a FAILING fetch aborts the write with a distinct outcome and no file', () => {
    setQuiet(true);
    const {cloneDir, sandbox} = sandboxedManagedClone();
    // A real checkout with real content — and no working origin, so the forced
    // fetch fails while the content stays perfectly readable. That is precisely
    // the trap: the stale bytes are RIGHT THERE.
    initRepoAt(cloneDir, RULES_FILES);
    const root = projectFixture({modules: ['alpha', 'omega']});

    const outcome = refreshCriticalRulesArtifact(root, {});

    expect(outcome.status).toBe('cannot-refresh');
    if (refreshSucceeded(outcome)) throw new Error('unreachable');
    expect(outcome.message).toContain(sandbox); // the sandbox, not ~/.config
    expect(outcome.message).toMatch(/stale/i);
    expect(existsSync(projectRulesFilePath(root))).toBe(false);
  });

  test('NEGATIVE CONTROL: the same fixture with a WORKING origin writes the artifact', () => {
    // Proves the abort above is caused by the failed refresh and not by the
    // sandboxed-clone setup itself.
    setQuiet(true);
    const {cloneDir, sandbox} = sandboxedManagedClone();
    const origin = initRepoAt(join(sandbox, 'origin'), RULES_FILES);
    mkdirSync(join(sandbox, 'justin-sdk'), {recursive: true});
    git(sandbox, ['clone', '-q', origin, cloneDir]);
    const root = projectFixture({modules: ['alpha', 'omega']});

    const outcome = refreshCriticalRulesArtifact(root, {});

    expect(outcome.status).toBe('written');
    if (!refreshSucceeded(outcome)) throw new Error('unreachable');
    expect(outcome.sourceRefresh).toBe('pulled');
    expect(outcome.sourceCommit?.sha).toBe(
      git(origin, ['rev-parse', 'HEAD']).trim(),
    );
    expect(readArtifact(root)).toContain('ALPHA_RULE');
  });

  test('no usable checkout AT ALL is cannot-refresh, not a content failure', () => {
    setQuiet(true);
    const {sandbox} = sandboxedManagedClone();
    // Nothing cloned yet, and the remote does not exist.
    process.env.JSDK_PROMPTS_REPO_URL = join(sandbox, 'nope', 'missing.git');
    const root = projectFixture({modules: ['alpha', 'omega']});

    const outcome = refreshCriticalRulesArtifact(root, {});

    expect(outcome.status).toBe('cannot-refresh');
    expect(existsSync(projectRulesFilePath(root))).toBe(false);
  });

  test('the INSTALLER refuses a stale clone too, and writes no artifact', async () => {
    // The installer's write goes through the same refresh layer, so a clone it
    // could not refresh must stop enrollment rather than commit unverified
    // rules into a repo (D15).
    setQuiet(true);
    const {cloneDir} = sandboxedManagedClone();
    initRepoAt(cloneDir, RULES_FILES);
    const root = projectFixture();

    expect(
      await runCriticalRulesSetup({projectRoot: root, quiet: true}),
    ).not.toBe(0);
    expect(existsSync(projectRulesFilePath(root))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D3 determinism
// ---------------------------------------------------------------------------

describe('determinism', () => {
  test('same prompts commit + same project -> byte-identical artifacts', () => {
    setQuiet(true);
    const {dir} = gitPromptsFixture();
    const a = projectFixture();
    const b = projectFixture();

    refreshCriticalRulesArtifact(a, {promptsDir: dir});
    refreshCriticalRulesArtifact(b, {promptsDir: dir});

    expect(readArtifact(a)).toBe(readArtifact(b));
  });

  test('the per-repo config CANNOT change the bytes any more', () => {
    // The retired design's whole point was that these two repos differed. They
    // must not: `modules` is ignored, so two identically-shaped projects get
    // identical rules whatever their configs say.
    setQuiet(true);
    const {dir} = gitPromptsFixture();
    const a = projectFixture({modules: ['alpha']});
    const b = projectFixture({modules: ['alpha', 's2t-guidelines', 'omega']});

    refreshCriticalRulesArtifact(a, {promptsDir: dir});
    refreshCriticalRulesArtifact(b, {promptsDir: dir});

    expect(readArtifact(a)).toBe(readArtifact(b));
  });

  test('a different PROJECT TYPE changes the bytes', () => {
    // The negative control for the test above: something still moves the bytes,
    // so "identical" is not an artefact of an inert fixture.
    setQuiet(true);
    const {dir} = gitPromptsFixture();
    const plain = projectFixture();
    const rn = projectFixture({deps: {expo: '*'}});

    refreshCriticalRulesArtifact(plain, {promptsDir: dir});
    refreshCriticalRulesArtifact(rn, {promptsDir: dir});

    expect(readArtifact(plain)).not.toBe(readArtifact(rn));
    expect(readArtifact(rn)).toContain('RN_ONLY_RULE');
  });

  test('a different prompts commit changes the bytes', () => {
    setQuiet(true);
    const {dir} = gitPromptsFixture();
    const root = projectFixture();
    refreshCriticalRulesArtifact(root, {promptsDir: dir});
    const before = readArtifact(root);

    writeFileSync(join(dir, 'src/rules/alpha.md'), '# Alpha\n\nALPHA_RULE_V2');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'edit alpha']);
    refreshCriticalRulesArtifact(root, {promptsDir: dir});

    expect(readArtifact(root)).not.toBe(before);
    expect(readArtifact(root)).toContain('ALPHA_RULE_V2');
  });

  test('a REGENERATION on a later day is byte-identical — the header carries no run date', () => {
    // The stamp used to carry `generated <today>`, so the same source produced
    // different bytes tomorrow and a --force churned twelve repos' diffs. The
    // date in the header is now the prompts COMMIT's, which only the source
    // moves.
    setQuiet(true);
    const {dir} = gitPromptsFixture();
    const root = projectFixture();

    const first = refreshCriticalRulesArtifact(root, {promptsDir: dir});
    const firstBytes = readArtifact(root);
    const second = refreshCriticalRulesArtifact(root, {
      force: true,
      promptsDir: dir,
    });
    const secondBytes = readArtifact(root);

    if (!refreshSucceeded(first) || !refreshSucceeded(second)) {
      throw new Error('unreachable');
    }
    expect(second.contentHash).toBe(first.contentHash);
    expect(secondBytes).toBe(firstBytes);
    // The stamped hash is the hash of the BODY, not of the stamped file.
    expect(contentHash(firstBytes.split('\n').slice(2).join('\n').trim())).toBe(
      first.contentHash,
    );
  });
});

// ---------------------------------------------------------------------------
// The user-level exclusion (home-base-anhw, half A)
// ---------------------------------------------------------------------------

/**
 * Enrollment drops the USER-LEVEL rules file from the repo's autoload set, so an
 * enrolled repo stops receiving the universal rules twice.
 *
 * WHAT THESE TESTS CAN AND CANNOT PROVE, stated plainly because the difference
 * is the whole risk here. Claude Code's own glob matcher is not importable, so
 * NO unit test can establish that a given exclude string matches one file and
 * not another — that was settled by six real `claude -p --disallowedTools '*'`
 * probes recorded on home-base-anhw, which found that `**​/justin-sdk/critical-
 * rules.md` excludes the repo's OWN artifact too (total omission) while `~/…`,
 * `$HOME/…` and `/Users/*​/…` all silently match nothing.
 *
 * What these tests DO guarantee is that no future edit can quietly reintroduce
 * any of those five broken forms: the entry must be an absolute path, carry no
 * glob metacharacter at all (so it can only ever name ONE file), and lie outside
 * the project. A single `*` added to that string turns the trap back on, and
 * `matchesExactlyOneFileOutsideTheRepo` below goes red the moment it appears.
 */
function settingsPathOf(repo: string): string {
  return join(repo, '.claude', 'settings.json');
}

function readExcludes(repo: string): unknown {
  return readJson(settingsPathOf(repo))?.[CLAUDE_MD_EXCLUDES_KEY];
}

/** A throwaway $HOME, so the expected value never depends on this machine. */
function sandboxHome(): string {
  const sb = track(createSandbox());
  process.env.HOME = sb.path;
  return sb.path;
}

describe('the user-level rules exclusion', () => {
  test('names the USER-LEVEL file, and is the same path sync-rules writes', () => {
    const home = sandboxHome();
    const repo = projectFixture({modules: ['alpha']});

    const outcome = addUserLevelRulesExclude(repo);
    expect(outcome.status).toBe('added');
    expect(readExcludes(repo)).toEqual([
      join(home, '.claude/rules/justin-sdk/critical-rules.md'),
    ]);
    // ONE source for the path: the exclusion and the file it suppresses cannot
    // drift apart, because both come from rulesFilePath().
    expect(userLevelRulesExclude()).toBe(rulesFilePath());
  });

  test('matchesExactlyOneFileOutsideTheRepo: the trap cannot creep back in', () => {
    sandboxHome();
    const repo = projectFixture({modules: ['alpha']});
    addUserLevelRulesExclude(repo);
    const [entry] = readExcludes(repo) as string[];

    // No glob metacharacter anywhere: an exact path can match exactly one file,
    // which is what makes "does it also hit the repo's artifact?" answerable at
    // all. `**​/justin-sdk/critical-rules.md` fails on the very first assertion.
    for (const meta of ['*', '?', '[', ']', '{', '}']) {
      expect(entry).not.toContain(meta);
    }
    // Absolute, and NOT the repo's own artifact — the two files share a basename
    // AND their last four segments, so only the prefix can separate them.
    expect(entry.startsWith('/')).toBe(true);
    expect(entry).not.toBe(projectRulesFilePath(repo));
    expect(entry.startsWith(repo)).toBe(false);
    expect(entry.endsWith(ARTIFACT_REL)).toBe(true); // same tail, different file
    // No unexpanded shell/tilde syntax: all three spellings measured as no-ops.
    expect(entry.startsWith('~')).toBe(false);
    expect(entry).not.toContain('$');
  });

  test('is ADDITIVE — an existing claudeMdExcludes list survives entry for entry', () => {
    const home = sandboxHome();
    const repo = projectFixture({modules: ['alpha']});
    // A list Justin curated by hand, including one entry that looks like ours.
    const existing = [
      'docs/legacy-notes.md',
      '/Users/someone-else/.claude/rules/justin-sdk/critical-rules.md',
    ];
    mkdirSync(join(repo, '.claude'), {recursive: true});
    writeJson(settingsPathOf(repo), {
      [CLAUDE_MD_EXCLUDES_KEY]: existing,
      otherSetting: {keep: true},
    });

    expect(addUserLevelRulesExclude(repo).status).toBe('added');
    expect(readExcludes(repo)).toEqual([
      ...existing,
      join(home, '.claude/rules/justin-sdk/critical-rules.md'),
    ]);
    // Sibling keys are untouched — this component owns one line, not the file.
    expect(readJson(settingsPathOf(repo))?.otherSetting).toEqual({keep: true});
  });

  test('is idempotent — a second run reports already-present and rewrites nothing', () => {
    sandboxHome();
    const repo = projectFixture({modules: ['alpha']});
    expect(addUserLevelRulesExclude(repo).status).toBe('added');
    const bytes = readFileSync(settingsPathOf(repo), 'utf-8');

    const again = addUserLevelRulesExclude(repo);
    expect(again.status).toBe('already-present');
    // Byte-identical: every future `sweep --component critical-rules` must leave
    // twelve repos with nothing to commit.
    expect(readFileSync(settingsPathOf(repo), 'utf-8')).toBe(bytes);
  });

  test('REFUSES a settings.json it cannot parse, and leaves the bytes alone', () => {
    sandboxHome();
    const repo = projectFixture({modules: ['alpha']});
    mkdirSync(join(repo, '.claude'), {recursive: true});
    const corrupt =
      '{ "claudeMdExcludes": [ // a comment JSON does not allow\n';
    writeFileSync(settingsPathOf(repo), corrupt);

    const outcome = addUserLevelRulesExclude(repo);
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('unreachable');
    expect(outcome.message).toContain('could not be parsed');
    // The refusal is the point: these are a human's bytes.
    expect(readFileSync(settingsPathOf(repo), 'utf-8')).toBe(corrupt);
  });

  test('REFUSES a claudeMdExcludes that is not a list of strings', () => {
    sandboxHome();
    const repo = projectFixture({modules: ['alpha']});
    mkdirSync(join(repo, '.claude'), {recursive: true});

    for (const bad of ['a-single-string', {}, ['fine.md', 42]]) {
      writeFileSync(
        settingsPathOf(repo),
        JSON.stringify({[CLAUDE_MD_EXCLUDES_KEY]: bad}),
      );
      const bytes = readFileSync(settingsPathOf(repo), 'utf-8');
      const outcome = addUserLevelRulesExclude(repo);
      expect(outcome.status).toBe('failed');
      expect(readFileSync(settingsPathOf(repo), 'utf-8')).toBe(bytes);
    }

    // NEGATIVE CONTROL: a well-formed list at the same key IS accepted, so the
    // refusals above are about the shape and not about the key being present.
    writeFileSync(
      settingsPathOf(repo),
      JSON.stringify({[CLAUDE_MD_EXCLUDES_KEY]: ['fine.md']}),
    );
    expect(addUserLevelRulesExclude(repo).status).toBe('added');
  });

  test('enrollment writes BOTH the artifact and the exclusion', async () => {
    const home = sandboxHome();
    const {dir} = gitPromptsFixture();
    const repo = projectFixture({git: true, modules: ['alpha', 'omega']});

    const exit = await runCriticalRulesSetup({
      projectRoot: repo,
      promptsDir: dir,
      quiet: true,
    });
    expect(exit).toBe(0);
    expect(existsSync(projectRulesFilePath(repo))).toBe(true);
    expect(readExcludes(repo)).toContain(
      join(home, '.claude/rules/justin-sdk/critical-rules.md'),
    );
  });

  test('DELIVERY BEFORE DEDUPLICATION: a refused exclusion still leaves the rules', async () => {
    sandboxHome();
    const {dir} = gitPromptsFixture();
    const repo = projectFixture({git: true, modules: ['alpha', 'omega']});
    // base-setup rewrites this file but preserves keys it does not own, so a
    // malformed claudeMdExcludes survives to reach the exclusion step.
    mkdirSync(join(repo, '.claude'), {recursive: true});
    writeJson(settingsPathOf(repo), {
      [CLAUDE_MD_EXCLUDES_KEY]: 'not-an-array',
    });

    const exit = await runCriticalRulesSetup({
      projectRoot: repo,
      promptsDir: dir,
      quiet: true,
    });
    // Loud…
    expect(exit).toBe(1);
    expect(readExcludes(repo)).toBe('not-an-array');
    // …but the rules landed anyway. The worst case of a refusal is a DUPLICATE
    // (the pre-anhw status quo), never a repo left with no rules at all.
    expect(existsSync(projectRulesFilePath(repo))).toBe(true);
    expect(readArtifact(repo)).toContain('ALPHA_RULE');
  });
});
