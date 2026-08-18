/**
 * Tests for the critical-rules component — the COMMITTED per-repo rules
 * artifact (home-base-we85, t6a0.21 D12–D15).
 *
 * FOUR CONTRACTS ARE UNDER TEST, and each one has a failure mode that is SILENT
 * in production, which is why the negative controls here matter more than the
 * positive assertions:
 *
 *  1. OPT-IN IS OPT-IN (D12). A module that is not in the recorded list must be
 *     ABSENT from the artifact — asserted with a marker string unique to that
 *     module ('Dakota', from s2t-guidelines), with the opposite arm proving the
 *     marker DOES appear once the module is selected. Without the second arm,
 *     "absent" would also pass for an artifact that was never written.
 *  2. PREDICATES NEVER RUN AT ASSEMBLY (D12). They run once, at enrollment, and
 *     the RESULT is recorded. So a selected module is emitted even when its own
 *     includeIf would say no — that is what structurally kills the t6a0.20
 *     class, where a predicate the running SDK didn't know silently deleted a
 *     module from delivery.
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
  computeDefaultModules,
  CRITICAL_RULES_CONFIG_KEY,
  readSelectedModules,
  refreshCriticalRulesArtifact,
  refreshSucceeded,
  runCriticalRulesSetup,
  stepCriticalRulesConfig,
} from '../src/critical-rules-setup';
import {assembleSelected, describeIndexModules} from '../src/plugin/lib/prime';
import {
  contentHash,
  deployedIsDirty,
  deployedSourceSha,
  projectRulesFilePath,
  readDeployedStamp,
  STAMP_PREFIX,
} from '../src/plugin/lib/rules-file';
import {rulesDiff} from '../src/rules-diff';
import {checkRulesDrift} from '../src/rules-drift';
import {readJson, setQuiet, writeJson} from '../src/setup-helpers';
import {git} from './git-fixtures';
import {createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
function track(sb: Sandbox): Sandbox {
  sandboxes.push(sb);
  return sb;
}

const SAVED_ENV = {
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
  restoreEnv('JSDK_PROMPTS_DIR', SAVED_ENV.promptsDir);
  restoreEnv('JSDK_PRIME_PRETTIER', SAVED_ENV.prettier);
  restoreEnv('JSDK_PROMPTS_REPO_URL', SAVED_ENV.repoUrl);
  restoreEnv('XDG_CONFIG_HOME', SAVED_ENV.xdg);
  setQuiet(false);
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The pinned stamp date, so artifact bytes are comparable across runs. */
const NOW = '2026-08-17';

/**
 * The rules-index shape that matters: universal modules, one excluded-by-default
 * universal module carrying a unique marker, and project-type-gated modules
 * sitting in the MIDDLE of the index (so an order bug is visible).
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
  // the wake word — and this module is excluded from the default seed there for
  // the same reason it is here (four enrolled repos are public).
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
  /** package.json dependencies — drives isReact/isReactNative at seed time. */
  deps?: Record<string, string>;
  /** Write a beads_rust .beads/metadata.json — drives isBeadsRust. */
  beads?: boolean;
  /** Pre-record a module selection (skips the seeding step). */
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
// assembleSelected — explicit selection, index order, loud on typos (D14)
// ---------------------------------------------------------------------------

describe('assembleSelected', () => {
  test('emits only the selected modules, in INDEX order regardless of argument order', () => {
    const dir = promptsFixture();
    // Deliberately reversed: a hand-edited config must not be able to reshuffle
    // the document (the numbering would then mean something different per repo).
    const {markdown, names} = assembleSelected(['omega', 'alpha'], {
      promptsDir: dir,
    });

    expect(names).toEqual(['alpha', 'omega']);
    expect(markdown.indexOf('ALPHA_RULE')).toBeLessThan(
      markdown.indexOf('OMEGA_RULE'),
    );
    expect(markdown).not.toContain('Dakota');
    expect(markdown).not.toContain('RN_ONLY_RULE');
    // Numbering restarts from the selection, and the title stays unnumbered.
    expect(markdown).toContain('# Critical Rules');
    expect(markdown).toContain('# 1. Alpha');
    expect(markdown).toContain('# 2. Omega');
  });

  test('a module name absent from index.md is a LOUD error naming it and the alternatives', () => {
    const dir = promptsFixture();
    expect(() =>
      assembleSelected(['alpha', 'no-such-module'], {promptsDir: dir}),
    ).toThrow(/no-such-module/);
    // The error must also say what IS available, or a typo is a guessing game.
    expect(() =>
      assembleSelected(['no-such-module'], {promptsDir: dir}),
    ).toThrow(/omega/);
  });

  test('includeIf is IGNORED: a gated module selected in a project it does not match is still emitted', () => {
    // The whole t6a0.20 defence. assembleSelected takes no project at all, so
    // there is nothing for a predicate to be evaluated against.
    const dir = promptsFixture();
    const {markdown, names} = assembleSelected(['rn-only'], {promptsDir: dir});
    expect(names).toEqual(['rn-only']);
    expect(markdown).toContain('RN_ONLY_RULE');
  });

  test('an unknown predicate name cannot delete a selected module', () => {
    // Same shape as the t6a0.20 regression: the frontmatter names a predicate
    // this SDK has never heard of. Under the old path that silently excluded the
    // module; under selection it is emitted, because selection is the truth.
    const dir = promptsFixture({
      'src/rules/index.md': ['@./alpha.md', '@./future.md'].join('\n\n'),
      'src/rules/future.md':
        '---\nincludeIf: [isSomePredicateFromTheFuture]\n---\n\n# Future\n\nFUTURE_RULE',
    });
    const {markdown} = assembleSelected(['alpha', 'future'], {promptsDir: dir});
    expect(markdown).toContain('FUTURE_RULE');
  });

  test('a NESTED @-reference with includeIf is inlined, and warned about', () => {
    const dir = promptsFixture({
      'src/rules/index.md': ['@./alpha.md', '@./parent.md'].join('\n\n'),
      'src/rules/parent.md': '# Parent\n\nPARENT_RULE\n\n@./nested-gated.md',
      'src/rules/nested-gated.md':
        '---\nincludeIf: [isReactNative]\n---\n\nNESTED_GATED_RULE',
    });
    const {markdown, warnings} = assembleSelected(['alpha', 'parent'], {
      promptsDir: dir,
    });
    expect(markdown).toContain('NESTED_GATED_RULE');
    // Included, but never SILENTLY: the choice is visible in the output.
    expect(warnings.join('\n')).toContain('nested-gated');
    expect(warnings.join('\n')).toContain('includeIf');
  });

  test('frontmatter never survives into the output', () => {
    const dir = promptsFixture();
    const {markdown} = assembleSelected(['alpha', 'rn-only'], {
      promptsDir: dir,
    });
    expect(markdown).not.toContain('includeIf');
    expect(markdown).not.toMatch(/^---/m);
  });
});

// ---------------------------------------------------------------------------
// Seeding — predicates run ONCE, here (D12)
// ---------------------------------------------------------------------------

describe('module selection seeding', () => {
  test('the default seed is universal-minus-excluded plus the DETECTED type modules', () => {
    const dir = promptsFixture();
    const rn = projectFixture({beads: true, deps: {expo: '*'}});
    const plain = projectFixture();

    const rnSeed = computeDefaultModules(
      describeIndexModules(rn, {promptsDir: dir}).modules,
    );
    const plainSeed = computeDefaultModules(
      describeIndexModules(plain, {promptsDir: dir}).modules,
    );

    expect(rnSeed).toEqual(['alpha', 'beads-only', 'rn-only', 'omega']);
    expect(plainSeed).toEqual(['alpha', 'omega']);
    // s2t-guidelines is universal and still excluded — in BOTH arms.
    expect(rnSeed).not.toContain('s2t-guidelines');
    expect(plainSeed).not.toContain('s2t-guidelines');
  });

  test('an RN-shaped project records the react-native module in config; a plain one does not', () => {
    setQuiet(true);
    const dir = promptsFixture();
    const rn = projectFixture({deps: {expo: '*'}});
    const plain = projectFixture();

    expect(stepCriticalRulesConfig(rn, {promptsDir: dir})).toBe(true);
    expect(stepCriticalRulesConfig(plain, {promptsDir: dir})).toBe(true);

    const rnRead = readSelectedModules(rn);
    const plainRead = readSelectedModules(plain);
    if (!rnRead.ok || !plainRead.ok) throw new Error('unreachable');
    expect(rnRead.modules).toContain('rn-only');
    expect(plainRead.modules).not.toContain('rn-only');
    // The detection RESULT is what's recorded, in the config, readable by hand.
    const block = (
      (
        readJson(join(rn, 'justin-sdk.config.json'))?.componentConfig as Record<
          string,
          unknown
        >
      )[CRITICAL_RULES_CONFIG_KEY] as {modules: string[]}
    ).modules;
    expect(block).toEqual(rnRead.modules);
  });

  test('a hand-tuned selection survives a re-run untouched', () => {
    setQuiet(true);
    const dir = promptsFixture();
    // Justin's per-repo call: s2t opted IN, a universal module dropped.
    const root = projectFixture({modules: ['alpha', 's2t-guidelines']});
    const cfgPath = join(root, 'justin-sdk.config.json');
    const before = readFileSync(cfgPath, 'utf-8');

    expect(stepCriticalRulesConfig(root, {promptsDir: dir})).toBe(true);

    expect(readFileSync(cfgPath, 'utf-8')).toBe(before);
  });

  test('seeding without a justin-sdk.config.json fails instead of inventing one', () => {
    setQuiet(true);
    const dir = promptsFixture();
    const root = projectFixture({noConfig: true});
    expect(stepCriticalRulesConfig(root, {promptsDir: dir})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The artifact: shape, stamp, idempotency
// ---------------------------------------------------------------------------

describe('the committed artifact', () => {
  test('writes .claude/rules/justin-sdk/critical-rules.md with an HTML-comment stamp carrying the prompts sha and the date', () => {
    setQuiet(true);
    const {dir, sha} = gitPromptsFixture();
    const root = projectFixture({modules: ['alpha', 'omega']});

    const outcome = refreshCriticalRulesArtifact(root, {
      now: NOW,
      promptsDir: dir,
    });
    expect(outcome.status).toBe('written');
    if (!refreshSucceeded(outcome)) throw new Error('unreachable');
    expect(outcome.sourceSha).toBe(sha);

    const body = readArtifact(root);
    const firstLine = body.split('\n')[0] ?? '';
    expect(firstLine.startsWith(STAMP_PREFIX)).toBe(true);
    expect(firstLine).toContain(sha.slice(0, 12));
    expect(firstLine).toContain(`generated ${NOW}`);
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
    expect(deployedSourceSha(stamp)).toBe(sha.slice(0, 12));
    expect(deployedIsDirty(stamp)).toBe(false);
    expect(stamp?.version).toBe('unknown');
  });

  test('a second run is a no-op; --force rewrites', () => {
    setQuiet(true);
    const {dir} = gitPromptsFixture();
    const root = projectFixture({modules: ['alpha', 'omega']});

    expect(
      refreshCriticalRulesArtifact(root, {now: NOW, promptsDir: dir}).status,
    ).toBe('written');
    const bytes = readArtifact(root);

    const second = refreshCriticalRulesArtifact(root, {
      now: '2099-01-01',
      promptsDir: dir,
    });
    expect(second.status).toBe('unchanged');
    // Not rewritten — so the date in the stamp did not churn either. This is
    // what keeps a branch and a swept main byte-identical across days (D3).
    expect(readArtifact(root)).toBe(bytes);

    expect(
      refreshCriticalRulesArtifact(root, {
        force: true,
        now: '2099-01-01',
        promptsDir: dir,
      }).status,
    ).toBe('written');
    expect(readArtifact(root)).not.toBe(bytes);
  });

  test('OPT-IN NEGATIVE CONTROL: the excluded module is absent by default and present when selected', () => {
    setQuiet(true);
    const {dir} = gitPromptsFixture();

    // Default seed (predicates + the exclusion list) — no marker.
    const seeded = projectFixture();
    expect(stepCriticalRulesConfig(seeded, {promptsDir: dir})).toBe(true);
    expect(
      refreshCriticalRulesArtifact(seeded, {now: NOW, promptsDir: dir}).status,
    ).toBe('written');
    expect(readArtifact(seeded)).not.toContain('Dakota');

    // Same fixture, module opted in by hand — the marker appears. Without this
    // arm, "absent" would also pass for an artifact that assembled nothing.
    const optedIn = projectFixture({
      modules: ['alpha', 's2t-guidelines', 'omega'],
    });
    expect(
      refreshCriticalRulesArtifact(optedIn, {now: NOW, promptsDir: dir}).status,
    ).toBe('written');
    expect(readArtifact(optedIn)).toContain('Dakota');
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

    expect(
      refreshCriticalRulesArtifact(root, {now: NOW, promptsDir: dir}).status,
    ).toBe('written');
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
      now: NOW,
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

    expect(
      refreshCriticalRulesArtifact(root, {now: NOW, promptsDir}).status,
    ).toBe('written');

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

    expect(
      refreshCriticalRulesArtifact(root, {now: NOW, promptsDir}).status,
    ).toBe('written');

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

      expect(
        refreshCriticalRulesArtifact(root, {now: NOW, promptsDir}).status,
      ).toBe('written');
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

      expect(
        refreshCriticalRulesArtifact(root, {now: NOW, promptsDir}).status,
      ).toBe('written');
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
    expect(
      refreshCriticalRulesArtifact(root, {now: NOW, promptsDir}).status,
    ).toBe('written');

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

    expect(
      refreshCriticalRulesArtifact(repo, {now: NOW, promptsDir: dir}).status,
    ).toBe('written');

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

  test('the installer seeds the selection AND writes the artifact in one pass', async () => {
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

    const read = readSelectedModules(root);
    if (!read.ok)
      throw new Error(`expected a seeded selection: ${read.message}`);
    expect(read.modules).toEqual(['alpha', 'beads-only', 'rn-only', 'omega']);
    const body = readArtifact(root);
    expect(body).toContain('BEADS_ONLY_RULE');
    expect(body).toContain('RN_ONLY_RULE');
    expect(body).not.toContain('Dakota');
  });
});

// ---------------------------------------------------------------------------
// Failure is not empty — every refusal is its own state
// ---------------------------------------------------------------------------

describe('refresh refusals are distinct and never write', () => {
  test('no justin-sdk.config.json at all -> not-enrolled', () => {
    setQuiet(true);
    const dir = promptsFixture();
    const root = projectFixture({noConfig: true});
    const outcome = refreshCriticalRulesArtifact(root, {promptsDir: dir});
    expect(outcome.status).toBe('not-enrolled');
    expect(existsSync(projectRulesFilePath(root))).toBe(false);
  });

  test('a config with no module selection -> not-enrolled (and says so)', () => {
    setQuiet(true);
    const dir = promptsFixture();
    const root = projectFixture();
    const outcome = refreshCriticalRulesArtifact(root, {promptsDir: dir});
    expect(outcome.status).toBe('not-enrolled');
    if (refreshSucceeded(outcome)) throw new Error('unreachable');
    expect(outcome.message).toContain(CRITICAL_RULES_CONFIG_KEY);
    expect(existsSync(projectRulesFilePath(root))).toBe(false);
  });

  test('a CORRUPT config is failed, not not-enrolled — the two are different facts', () => {
    setQuiet(true);
    const dir = promptsFixture();
    const root = projectFixture();
    writeFileSync(join(root, 'justin-sdk.config.json'), '{ this is not json');
    const outcome = refreshCriticalRulesArtifact(root, {promptsDir: dir});
    expect(outcome.status).toBe('failed');
    expect(existsSync(projectRulesFilePath(root))).toBe(false);
  });

  test('an EMPTY module list is failed, not an artifact stripped of every rule', () => {
    setQuiet(true);
    const dir = promptsFixture();
    const root = projectFixture({modules: []});
    const outcome = refreshCriticalRulesArtifact(root, {promptsDir: dir});
    expect(outcome.status).toBe('failed');
    expect(existsSync(projectRulesFilePath(root))).toBe(false);
  });

  test('a typo in the module list is failed and leaves any existing artifact alone', () => {
    setQuiet(true);
    const {dir} = gitPromptsFixture();
    const root = projectFixture({modules: ['alpha', 'omega']});
    expect(
      refreshCriticalRulesArtifact(root, {now: NOW, promptsDir: dir}).status,
    ).toBe('written');
    const good = readArtifact(root);

    const cfgPath = join(root, 'justin-sdk.config.json');
    const cfg = readJson(cfgPath) ?? {};
    (
      (cfg.componentConfig as Record<string, {modules: string[]}>)[
        CRITICAL_RULES_CONFIG_KEY
      ] as {modules: string[]}
    ).modules = ['alpha', 'ompga'];
    writeJson(cfgPath, cfg);

    const outcome = refreshCriticalRulesArtifact(root, {
      now: NOW,
      promptsDir: dir,
    });
    expect(outcome.status).toBe('failed');
    if (refreshSucceeded(outcome)) throw new Error('unreachable');
    expect(outcome.message).toContain('ompga');
    // A bad selection must not silently shrink the delivered rules.
    expect(readArtifact(root)).toBe(good);
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

    const outcome = refreshCriticalRulesArtifact(root, {now: NOW});

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

    const outcome = refreshCriticalRulesArtifact(root, {now: NOW});

    expect(outcome.status).toBe('written');
    if (!refreshSucceeded(outcome)) throw new Error('unreachable');
    expect(outcome.sourceRefresh).toBe('pulled');
    expect(outcome.sourceSha).toBe(git(origin, ['rev-parse', 'HEAD']).trim());
    expect(readArtifact(root)).toContain('ALPHA_RULE');
  });

  test('no usable checkout AT ALL is cannot-refresh, not a content failure', () => {
    setQuiet(true);
    const {sandbox} = sandboxedManagedClone();
    // Nothing cloned yet, and the remote does not exist.
    process.env.JSDK_PROMPTS_REPO_URL = join(sandbox, 'nope', 'missing.git');
    const root = projectFixture({modules: ['alpha', 'omega']});

    const outcome = refreshCriticalRulesArtifact(root, {now: NOW});

    expect(outcome.status).toBe('cannot-refresh');
    expect(existsSync(projectRulesFilePath(root))).toBe(false);
  });

  test('seeding also refuses a stale index', () => {
    setQuiet(true);
    const {cloneDir} = sandboxedManagedClone();
    initRepoAt(cloneDir, RULES_FILES);
    const root = projectFixture();

    expect(stepCriticalRulesConfig(root)).toBe(false);
    // …and recorded nothing, so nothing later reads a guessed selection.
    expect(readSelectedModules(root).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D3 determinism
// ---------------------------------------------------------------------------

describe('determinism', () => {
  test('same prompts sha + same selection + same date -> byte-identical artifacts', () => {
    setQuiet(true);
    const {dir} = gitPromptsFixture();
    const a = projectFixture({modules: ['alpha', 'omega']});
    const b = projectFixture({modules: ['alpha', 'omega']});

    refreshCriticalRulesArtifact(a, {now: NOW, promptsDir: dir});
    refreshCriticalRulesArtifact(b, {now: NOW, promptsDir: dir});

    expect(readArtifact(a)).toBe(readArtifact(b));
  });

  test('a different selection changes the bytes', () => {
    setQuiet(true);
    const {dir} = gitPromptsFixture();
    const a = projectFixture({modules: ['alpha', 'omega']});
    const b = projectFixture({modules: ['alpha', 's2t-guidelines', 'omega']});

    refreshCriticalRulesArtifact(a, {now: NOW, promptsDir: dir});
    refreshCriticalRulesArtifact(b, {now: NOW, promptsDir: dir});

    expect(readArtifact(a)).not.toBe(readArtifact(b));
  });

  test('a different prompts commit changes the bytes', () => {
    setQuiet(true);
    const {dir} = gitPromptsFixture();
    const root = projectFixture({modules: ['alpha', 'omega']});
    refreshCriticalRulesArtifact(root, {now: NOW, promptsDir: dir});
    const before = readArtifact(root);

    writeFileSync(join(dir, 'src/rules/alpha.md'), '# Alpha\n\nALPHA_RULE_V2');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'edit alpha']);
    refreshCriticalRulesArtifact(root, {now: NOW, promptsDir: dir});

    expect(readArtifact(root)).not.toBe(before);
    expect(readArtifact(root)).toContain('ALPHA_RULE_V2');
  });

  test('the assembly DATE is excluded from the content hash — only the stamp line moves', () => {
    setQuiet(true);
    const {dir} = gitPromptsFixture();
    const root = projectFixture({modules: ['alpha', 'omega']});

    const first = refreshCriticalRulesArtifact(root, {
      now: '2026-01-01',
      promptsDir: dir,
    });
    const firstBytes = readArtifact(root);
    const second = refreshCriticalRulesArtifact(root, {
      force: true,
      now: '2026-12-31',
      promptsDir: dir,
    });
    const secondBytes = readArtifact(root);

    if (!refreshSucceeded(first) || !refreshSucceeded(second)) {
      throw new Error('unreachable');
    }
    expect(second.contentHash).toBe(first.contentHash);
    expect(secondBytes).not.toBe(firstBytes);
    // Every line after the stamp is identical…
    expect(secondBytes.split('\n').slice(1)).toEqual(
      firstBytes.split('\n').slice(1),
    );
    // …and the hash is the hash of that body, not of the stamped file.
    expect(contentHash(firstBytes.split('\n').slice(2).join('\n').trim())).toBe(
      first.contentHash,
    );
  });
});
