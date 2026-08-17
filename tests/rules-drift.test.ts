/**
 * Tests for the shared rules-staleness verdict (`checkRulesDrift`) and the
 * `critical-rules-setup` doctor check that reports it (home-base-si46).
 *
 * WHAT WOULD BE SILENT IN PRODUCTION — which is what these tests are for:
 *
 *  1. A HAND EDIT CERTIFIED AS IN SYNC. The fast path compares the stamp's sha
 *     to the clone's HEAD, and a stamp-preserving edit passes it (the Dispatch-C
 *     discovery). Every locally-modified arm therefore ALSO asserts that the sha
 *     still matches — i.e. that the fast path really would have said "in sync" —
 *     so the test cannot pass for the wrong reason.
 *  2. A FALSE NAG. A prompts commit that changes no rule content must NOT report
 *     stale, or twelve repos get told to update after every README typo. Proven
 *     with a real commit, asserting the shas DIFFER (so the content path ran).
 *  3. "COULD NOT CHECK" REPORTED AS "IN SYNC" (critical rule 5 / D5). Each such
 *     arm has a working-origin negative control, so it cannot pass merely because
 *     the sandbox was broken.
 *  4. THE CHECK NOT RUNNING AT ALL. `runDoctor` silently skips components with no
 *     registered factory, so "no warning" and "no check" look identical. The
 *     doctor arms include a de-registration control (drop the component from
 *     config -> the label disappears) so a green run proves the check ran.
 *
 * Hermetic: JSDK_PROMPTS_DIR (or a sandboxed XDG_CONFIG_HOME plus a local
 * origin) means no network, and JSDK_PRIME_PRETTIER=0 keeps `bunx prettier` out.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {spawnSync} from 'child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import {join, relative, resolve} from 'path';

import {
  CRITICAL_RULES_CONFIG_KEY,
  refreshCriticalRulesArtifact,
  refreshSucceeded,
} from '../src/critical-rules-setup';
import {runDoctor} from '../src/doctor';
import {projectRulesFilePath} from '../src/plugin/lib/rules-file';
import {
  checkRulesDrift,
  isRulesDriftProblem,
  rulesDriftAdvice,
  type RulesDriftStatus,
} from '../src/rules-drift';
import {setQuiet} from '../src/setup-helpers';
import {git} from './git-fixtures';
import {createSandbox, type Sandbox} from './sandbox';

const CLI = resolve(import.meta.dirname, '..', 'src', 'cli.ts');
const ARTIFACT_REL = '.claude/rules/justin-sdk/critical-rules.md';
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
// Fixtures (the shapes proven in tests/rules-commands.test.ts)
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

/** Commit a rules CONTENT change — "new guidance was pushed". */
function editPromptsRules(dir: string): void {
  writeFileSync(join(dir, 'src/rules/alpha.md'), '# Alpha\n\nALPHA_RULE_V2');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'edit alpha']);
}

/** Commit something that is NOT a rule — the false-nag probe. */
function editPromptsUnrelated(dir: string): void {
  writeFileSync(join(dir, 'README.md'), 'unrelated\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'docs only']);
}

function projectFixture(
  options: {modules?: string[]; components?: string[]} = {},
): string {
  const sb = track(createSandbox());
  const files: Record<string, string> = {
    'package.json': `${JSON.stringify({name: 'fixture'}, null, 2)}\n`,
  };
  files['justin-sdk.config.json'] = `${JSON.stringify(
    {
      components: options.components ?? ['base-setup', 'critical-rules-setup'],
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

/** Write the artifact the way the real writer does, then commit it. */
function writeArtifact(repo: string, promptsDir?: string): string {
  setQuiet(true);
  const outcome = refreshCriticalRulesArtifact(repo, {now: NOW, promptsDir});
  if (!refreshSucceeded(outcome)) {
    throw new Error(`fixture could not write the artifact: ${outcome.message}`);
  }
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'add rules artifact']);
  return outcome.file;
}

/** Rewrite just the module selection in an existing fixture repo. */
function setModules(repo: string, modules: unknown): void {
  const path = join(repo, 'justin-sdk.config.json');
  const config = JSON.parse(readFileSync(path, 'utf-8')) as Record<
    string,
    unknown
  >;
  config.componentConfig = {[CRITICAL_RULES_CONFIG_KEY]: {modules}};
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Point the managed-clone machinery at a sandbox and return where it will look.
 * Nothing here may touch the real ~/.config/justin-sdk/prompts.
 */
function sandboxedManagedClone(): {cloneDir: string; sandbox: string} {
  process.env.JSDK_PRIME_PRETTIER = '0';
  delete process.env.JSDK_PROMPTS_DIR; // force the managed-clone path
  const sb = track(createSandbox());
  process.env.XDG_CONFIG_HOME = sb.path;
  return {cloneDir: join(sb.path, 'justin-sdk', 'prompts'), sandbox: sb.path};
}

/** Mark the managed clone as freshly pulled, so the staleness gate skips. */
function markCloneFresh(sandbox: string): void {
  writeFileSync(
    join(sandbox, 'justin-sdk', '.prompts-last-pull'),
    new Date().toISOString(),
  );
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

function commitCount(repo: string): number {
  return Number(git(repo, ['rev-list', '--count', 'HEAD']).trim());
}

// ---------------------------------------------------------------------------
// Enrolment
// ---------------------------------------------------------------------------

describe('enrolment', () => {
  test('a repo with no recorded selection is NOT-ENROLLED, never stale', () => {
    const {dir} = gitPromptsFixture();
    const repo = projectFixture(); // no componentConfig block

    const result = checkRulesDrift(repo, {promptsDir: dir});
    expect(result.status).toBe('not-enrolled');
    expect(isRulesDriftProblem(result.status)).toBe(false);
    expect(result.message).toContain('add critical-rules');

    // NEGATIVE CONTROL: the same repo, with a selection, is judged.
    const enrolled = projectFixture({modules: ['alpha', 'omega']});
    expect(checkRulesDrift(enrolled, {promptsDir: dir}).status).toBe('missing');
  });

  test('a selection that is not a list of names is CANNOT-CHECK, not empty', () => {
    const {dir} = gitPromptsFixture();
    const repo = projectFixture({modules: ['alpha']});
    setModules(repo, 'alpha'); // a string, not an array

    const result = checkRulesDrift(repo, {promptsDir: dir});
    expect(result.status).toBe('cannot-check');
    expect(result.message).toContain('modules');
  });
});

// ---------------------------------------------------------------------------
// Missing / in-sync / stale
// ---------------------------------------------------------------------------

describe('the artifact against the source', () => {
  test('enrolled with no artifact is MISSING, naming the path and rules-update', () => {
    const {dir} = gitPromptsFixture();
    const repo = projectFixture({modules: ['alpha', 'omega']});

    const result = checkRulesDrift(repo, {promptsDir: dir});
    expect(result.status).toBe('missing');
    expect(result.message).toContain(ARTIFACT_REL);
    expect(result.moduleCount).toBe(2);
    expect(rulesDriftAdvice(result.status)).toContain('rules-update');

    // NEGATIVE CONTROL: write it, and the same repo is in sync.
    writeArtifact(repo, dir);
    expect(checkRulesDrift(repo, {promptsDir: dir}).status).toBe('in-sync');
  });

  test('a freshly written artifact is IN-SYNC via the sha fast path', () => {
    const {dir, sha} = gitPromptsFixture();
    const repo = projectFixture({modules: ['alpha', 'omega']});
    writeArtifact(repo, dir);

    const result = checkRulesDrift(repo, {promptsDir: dir});
    expect(result.status).toBe('in-sync');
    expect(result.artifactSha).toBe(sha.slice(0, 12));
    expect(result.sourceSha).toBe(sha.slice(0, 12));
    expect(rulesDriftAdvice(result.status)).toBeNull();
  });

  test('a rules change upstream is STALE, and the advice names rules-diff BEFORE rules-update', () => {
    const {dir} = gitPromptsFixture();
    const repo = projectFixture({modules: ['alpha', 'omega']});
    writeArtifact(repo, dir);
    expect(checkRulesDrift(repo, {promptsDir: dir}).status).toBe('in-sync');

    editPromptsRules(dir);

    const result = checkRulesDrift(repo, {promptsDir: dir});
    expect(result.status).toBe('stale');
    expect(result.artifactSha).not.toBe(result.sourceSha);
    const advice = rulesDriftAdvice('stale') ?? '';
    expect(advice).toContain('rules-diff');
    expect(advice).toContain('rules-update');
    expect(advice.indexOf('rules-diff')).toBeLessThan(
      advice.indexOf('rules-update'),
    );
  });

  test('a prompts commit that changes NO rule content does not nag (the false-nag guard)', () => {
    const {dir} = gitPromptsFixture();
    const repo = projectFixture({modules: ['alpha', 'omega']});
    writeArtifact(repo, dir);

    editPromptsUnrelated(dir);

    const result = checkRulesDrift(repo, {promptsDir: dir});
    // The shas DIFFER — so the content comparison really is what decided this,
    // and the fast path was bypassed.
    expect(result.artifactSha).not.toBe(result.sourceSha);
    expect(result.status).toBe('in-sync');

    // NEGATIVE CONTROL: a commit that DOES change a rule, from the same state.
    editPromptsRules(dir);
    expect(checkRulesDrift(repo, {promptsDir: dir}).status).toBe('stale');
  });
});

// ---------------------------------------------------------------------------
// Locally modified — the arm the fast path cannot see
// ---------------------------------------------------------------------------

describe('locally modified', () => {
  test('a stamp-preserving hand edit is LOCALLY-MODIFIED even though the sha matches', () => {
    const {dir, sha} = gitPromptsFixture();
    const repo = projectFixture({modules: ['alpha', 'omega']});
    const file = writeArtifact(repo, dir);
    const original = readFileSync(file, 'utf-8');

    // Edit the BODY, keep the stamp line: the fast path is blind to this.
    writeFileSync(file, `${original}\nHAND EDITED\n`);

    const result = checkRulesDrift(repo, {promptsDir: dir});
    expect(result.status).toBe('locally-modified');
    // Proof the fast path would have certified this file: the stamp names the
    // CURRENT prompts HEAD, so sha equality holds — only the byte/stamp
    // comparison could have caught the edit. And it caught it without reading
    // the source at all (sourceRefresh null), which is why the arm is cheap.
    expect(result.artifactSha).toBe(sha.slice(0, 12));
    expect(result.sourceRefresh).toBeNull();
    const advice = rulesDriftAdvice('locally-modified') ?? '';
    expect(advice).toContain('rules-diff');
    expect(advice).toContain('rules-update --force');

    // NEGATIVE CONTROL: restore the bytes and it is in sync again.
    writeFileSync(file, original);
    expect(checkRulesDrift(repo, {promptsDir: dir}).status).toBe('in-sync');
  });

  test('an unstamped file at the artifact path is LOCALLY-MODIFIED, not in sync', () => {
    const {dir} = gitPromptsFixture();
    const repo = projectFixture({modules: ['alpha', 'omega']});
    const file = projectRulesFilePath(repo);
    mkdirSync(join(file, '..'), {recursive: true});
    writeFileSync(file, '# My own rules\n\nhand written\n');

    const result = checkRulesDrift(repo, {promptsDir: dir});
    expect(result.status).toBe('locally-modified');
    expect(result.message).toContain('stamp');
    expect(result.message).not.toMatch(/in sync/i);
  });
});

// ---------------------------------------------------------------------------
// Cannot check (D5) — every arm with a working-origin control
// ---------------------------------------------------------------------------

describe('cannot check', () => {
  test('a clone that cannot be refreshed is CANNOT-CHECK, never in sync', () => {
    // Write a real, correct artifact from an override source FIRST, so the only
    // thing wrong in this test is the source refresh.
    const {dir} = gitPromptsFixture();
    const repo = projectFixture({modules: ['alpha', 'omega']});
    writeArtifact(repo, dir);

    // Now switch to a managed clone with real content and NO working origin:
    // the fetch fails while stale bytes stay perfectly readable. That is the trap.
    const {cloneDir, sandbox} = sandboxedManagedClone();
    initRepoAt(cloneDir, RULES_FILES);

    const result = checkRulesDrift(repo);
    expect(result.status).toBe('cannot-check');
    expect(result.sourceRefresh).toBe('failed');
    expect(result.message).toContain(sandbox); // the sandbox, not ~/.config
    expect(result.message).not.toMatch(/in sync/i);
    expect(rulesDriftAdvice('cannot-check')).toMatch(/unknown/i);
  });

  test('NEGATIVE CONTROL: the same sandboxed clone WITH a working origin answers', () => {
    const {dir} = gitPromptsFixture();
    const repo = projectFixture({modules: ['alpha', 'omega']});
    writeArtifact(repo, dir);

    const {cloneDir, sandbox} = sandboxedManagedClone();
    const origin = initRepoAt(join(sandbox, 'origin'), RULES_FILES);
    mkdirSync(join(sandbox, 'justin-sdk'), {recursive: true});
    git(sandbox, ['clone', '-q', origin, cloneDir]);

    const result = checkRulesDrift(repo);
    expect(result.status).toBe('in-sync');
    expect(result.sourceRefresh).toBe('pulled');
  });

  test('a refresh the staleness gate SKIPPED is fresh enough for a reader', () => {
    // The deliberate reader/writer difference (D15 is a writer rule): 'skipped'
    // is "we checked recently", not "we could not check". Same broken-origin
    // clone as the cannot-check arm — only the marker differs.
    const {dir} = gitPromptsFixture();
    const repo = projectFixture({modules: ['alpha', 'omega']});
    writeArtifact(repo, dir);

    const {cloneDir, sandbox} = sandboxedManagedClone();
    initRepoAt(cloneDir, RULES_FILES);
    markCloneFresh(sandbox);

    const result = checkRulesDrift(repo);
    expect(result.sourceRefresh).toBe('skipped');
    expect(result.status).toBe('in-sync');
  });

  test('no prompts checkout at all is CANNOT-CHECK, not missing rules', () => {
    const {dir} = gitPromptsFixture();
    const repo = projectFixture({modules: ['alpha', 'omega']});
    writeArtifact(repo, dir);

    const {sandbox} = sandboxedManagedClone();
    // An origin URL that cannot be cloned: no checkout is ever created.
    process.env.JSDK_PROMPTS_REPO_URL = join(sandbox, 'no-such-origin');

    const result = checkRulesDrift(repo);
    expect(result.status).toBe('cannot-check');
    expect(result.message).not.toMatch(/in sync/i);
  });

  test('a module name that does not exist upstream is CANNOT-CHECK, naming it', () => {
    const {dir} = gitPromptsFixture();
    const repo = projectFixture({modules: ['alpha', 'omega']});
    writeArtifact(repo, dir);
    // The artifact still matches its own stamp; only the selection is broken.
    setModules(repo, ['alpha', 'no-such-module']);

    const result = checkRulesDrift(repo, {promptsDir: dir});
    expect(result.status).toBe('cannot-check');
    expect(result.message).toContain('no-such-module');
    expect(result.message).not.toMatch(/in sync/i);
  });
});

// ---------------------------------------------------------------------------
// Contract invariants
// ---------------------------------------------------------------------------

describe('contract', () => {
  const ALL: RulesDriftStatus[] = [
    'not-enrolled',
    'in-sync',
    'missing',
    'locally-modified',
    'stale',
    'cannot-check',
  ];

  test('every status except in-sync has advice, and only in-sync/not-enrolled are silent', () => {
    for (const status of ALL) {
      const advice = rulesDriftAdvice(status);
      if (status === 'in-sync') expect(advice).toBeNull();
      else expect(advice?.length ?? 0).toBeGreaterThan(0);
    }
    expect(ALL.filter((s) => !isRulesDriftProblem(s))).toEqual([
      'not-enrolled',
      'in-sync',
    ]);
  });

  test('advice always spells out justin-sdk, never a bare `j`/`jsdk` bin', () => {
    for (const status of ALL) {
      const advice = rulesDriftAdvice(status);
      if (advice == null) continue;
      expect(advice).toContain('justin-sdk');
      expect(advice).not.toMatch(/(^|\s)jsdk\s/);
      expect(advice).not.toMatch(/(^|\s)j\s/);
    }
  });

  test('advice is LOCAL-FIRST inside an enrolled repo, github: only to enroll', () => {
    // home-base-r47v F4. Every problem state except not-enrolled is reachable
    // ONLY in a repo that already pins the SDK, so the local alias resolves (fast,
    // no network) — and a github: spec would be worse than slow here, because bunx
    // caches those on the spec STRING and can serve the first commit it ever
    // fetched. A staleness notice must not be answered by a stale binary.
    for (const status of ALL) {
      const advice = rulesDriftAdvice(status);
      if (advice == null || status === 'not-enrolled') continue;
      expect(advice).toContain('bunx @justinhaaheim/justin-sdk');
      expect(advice).not.toContain('github:');
    }
    // The one exception, and why: an unenrolled repo has no pin to resolve.
    expect(rulesDriftAdvice('not-enrolled')).toContain(
      'bunx github:justinhaaheim/justin-sdk add critical-rules',
    );
  });

  test('checking a stale repo writes nothing inside it', () => {
    const {dir} = gitPromptsFixture();
    const repo = projectFixture({modules: ['alpha', 'omega']});
    writeArtifact(repo, dir);
    editPromptsRules(dir);

    const before = snapshotFiles(repo);
    const status = statusLines(repo);
    const commits = commitCount(repo);

    expect(checkRulesDrift(repo, {promptsDir: dir}).status).toBe('stale');

    expect(snapshotFiles(repo)).toEqual(before);
    expect(statusLines(repo)).toBe(status);
    expect(commitCount(repo)).toBe(commits);
  });
});

// ---------------------------------------------------------------------------
// The doctor check
// ---------------------------------------------------------------------------

describe('doctor RULES_ARTIFACT check', () => {
  function doctor(
    repo: string,
    args: string[] = ['--quiet'],
  ): {status: number | null; out: string} {
    const result = spawnSync(process.execPath, [CLI, 'doctor', ...args], {
      cwd: repo,
      encoding: 'utf-8',
      env: {...process.env},
    });
    return {
      out: `${result.stdout ?? ''}${result.stderr ?? ''}`,
      status: result.status,
    };
  }

  test('in sync: exit 0, and --quiet says nothing about the rules', () => {
    const {dir} = gitPromptsFixture();
    const repo = projectFixture({
      components: ['critical-rules-setup'],
      modules: ['alpha', 'omega'],
    });
    writeArtifact(repo, dir);

    const run = doctor(repo);
    expect(run.status).toBe(0);
    expect(run.out).toMatch(/All 1 checks passed/);
    expect(run.out).not.toContain('RULES_ARTIFACT');
  });

  test('stale: warns, names both commands, and does NOT fail the run', () => {
    const {dir} = gitPromptsFixture();
    const repo = projectFixture({
      components: ['critical-rules-setup'],
      modules: ['alpha', 'omega'],
    });
    writeArtifact(repo, dir);
    editPromptsRules(dir);

    const run = doctor(repo);
    expect(run.out).toContain('RULES_ARTIFACT');
    expect(run.out).toContain('stale:');
    expect(run.out).toContain('rules-diff');
    expect(run.out).toContain('rules-update');
    expect(run.out).toMatch(/1 warn/);
    // Stale rules nag; they do not break the environment. doctor runs at every
    // session start, so a non-zero here would redden unrelated work.
    expect(run.status).toBe(0);
  });

  test('NEGATIVE CONTROL: without the component in config, the check does not run', () => {
    // runDoctor silently skips unregistered components, so "no warning" and "no
    // check" are indistinguishable in the output — this is what proves the
    // registry entry is doing the work in the test above.
    const {dir} = gitPromptsFixture();
    const repo = projectFixture({
      components: ['base-setup'],
      modules: ['alpha', 'omega'],
    });
    writeArtifact(repo, dir);
    editPromptsRules(dir);

    const run = doctor(repo);
    expect(run.out).not.toContain('RULES_ARTIFACT');
  });

  test('missing artifact: warns naming rules-update', () => {
    const {dir} = gitPromptsFixture();
    const repo = projectFixture({
      components: ['critical-rules-setup'],
      modules: ['alpha', 'omega'],
    });

    const run = doctor(repo);
    expect(run.out).toContain('RULES_ARTIFACT');
    expect(run.out).toContain('missing:');
    expect(run.out).toContain('rules-update');
  });

  test('locally modified: warns naming --force, not a plain update', () => {
    const {dir} = gitPromptsFixture();
    const repo = projectFixture({
      components: ['critical-rules-setup'],
      modules: ['alpha', 'omega'],
    });
    const file = writeArtifact(repo, dir);
    writeFileSync(file, `${readFileSync(file, 'utf-8')}\nHAND EDITED\n`);

    const run = doctor(repo);
    expect(run.out).toContain('locally-modified:');
    expect(run.out).toContain('rules-update --force');
  });

  test('cannot check: warns, and is never reported as a pass', () => {
    const {dir} = gitPromptsFixture();
    const repo = projectFixture({
      components: ['critical-rules-setup'],
      modules: ['alpha', 'omega'],
    });
    writeArtifact(repo, dir);
    const {cloneDir} = sandboxedManagedClone();
    initRepoAt(cloneDir, RULES_FILES);

    const run = doctor(repo);
    expect(run.out).toContain('cannot-check:');
    expect(run.out).toMatch(/1 warn/);
    expect(run.out).not.toMatch(/All 1 checks passed/);
  });

  test('doctor never writes in the repo it is checking', () => {
    const {dir} = gitPromptsFixture();
    const repo = projectFixture({
      components: ['critical-rules-setup'],
      modules: ['alpha', 'omega'],
    });
    writeArtifact(repo, dir);
    editPromptsRules(dir);

    const before = snapshotFiles(repo);
    const status = statusLines(repo);
    const commits = commitCount(repo);

    doctor(repo);

    expect(snapshotFiles(repo)).toEqual(before);
    expect(statusLines(repo)).toBe(status);
    expect(commitCount(repo)).toBe(commits);
  });

});

// ---------------------------------------------------------------------------
// The remote write path — `doctor --fix --yes` (home-base-r47v F1)
// ---------------------------------------------------------------------------

/**
 * The REMOTE session-start path is `runDoctor(target, {fix: true, yes: true})`
 * (setup-env-command.ts), and D4's contract for it is exactly one sentence: WRITE
 * the artifact, do NOT commit it — "the write is either committed with the
 * session work or discarded harmlessly". So every arm here asserts both halves;
 * a fixer that wrote AND committed would satisfy "the file is current" while
 * silently authoring commits in a repo nobody asked it to touch.
 *
 * The fixer is an in-process function (check-runner's `fixFn`), which is also
 * why the last arm runs `runDoctor` DIRECTLY with a cwd that is not the repo: a
 * shell fixCommand is spawned in `process.cwd()`, so it would have fixed the
 * wrong directory (home-base-6dni) and no CLI-subprocess test — where cwd IS the
 * repo — could ever have noticed.
 */
describe('doctor --fix --yes writes the artifact without committing it', () => {
  function doctorFix(repo: string): {status: number | null; out: string} {
    const result = spawnSync(
      process.execPath,
      [CLI, 'doctor', '--fix', '--yes'],
      {cwd: repo, encoding: 'utf-8', env: {...process.env}},
    );
    return {
      out: `${result.stdout ?? ''}${result.stderr ?? ''}`,
      status: result.status,
    };
  }

  test('a MISSING artifact is written, left uncommitted, and the re-check is green', () => {
    const {dir} = gitPromptsFixture();
    const repo = projectFixture({
      components: ['critical-rules-setup'],
      modules: ['alpha', 'omega'],
    });
    const commits = commitCount(repo);
    const file = projectRulesFilePath(repo);

    const run = doctorFix(repo);

    expect(existsSync(file)).toBe(true);
    expect(checkRulesDrift(repo, {promptsDir: dir}).status).toBe('in-sync');
    // Written, not committed: the artifact is sitting there as an untracked file.
    expect(commitCount(repo)).toBe(commits);
    expect(statusLines(repo)).toContain(`?? ${ARTIFACT_REL}`);
    // The fix ran through the in-process fixer, and the re-walk saw the result.
    expect(run.out).toContain('RULES_ARTIFACT');
    expect(run.out).toContain('in-process fixer');
    expect(run.status).toBe(0);
  });

  test('a STALE artifact is rewritten to canonical, and still uncommitted', () => {
    const {dir} = gitPromptsFixture();
    const repo = projectFixture({
      components: ['critical-rules-setup'],
      modules: ['alpha', 'omega'],
    });
    const file = writeArtifact(repo, dir);
    editPromptsRules(dir);
    const before = readFileSync(file, 'utf-8');
    const commits = commitCount(repo);
    expect(checkRulesDrift(repo, {promptsDir: dir}).status).toBe('stale');

    doctorFix(repo);

    const after = readFileSync(file, 'utf-8');
    expect(after).not.toBe(before);
    expect(after).toContain('ALPHA_RULE_V2');
    expect(checkRulesDrift(repo, {promptsDir: dir}).status).toBe('in-sync');
    expect(commitCount(repo)).toBe(commits);
    expect(statusLines(repo)).toContain(` M ${ARTIFACT_REL}`);
  });

  test('a LOCALLY MODIFIED artifact is NOT overwritten (no fixer, on purpose)', () => {
    const {dir} = gitPromptsFixture();
    const repo = projectFixture({
      components: ['critical-rules-setup'],
      modules: ['alpha', 'omega'],
    });
    const file = writeArtifact(repo, dir);
    writeFileSync(file, `${readFileSync(file, 'utf-8')}\nHAND EDITED\n`);
    const edited = readFileSync(file, 'utf-8');

    const run = doctorFix(repo);

    // --force would destroy a human's edit; a plain regenerate would no-op and
    // report success. Both are worse than warning and leaving it alone.
    expect(readFileSync(file, 'utf-8')).toBe(edited);
    expect(run.out).toContain('locally-modified:');
    expect(run.out).toContain('rules-update --force');
  });

  test('CANNOT-CHECK attempts no write at all — no fixer, so no fix failure', () => {
    const {dir} = gitPromptsFixture();
    const repo = projectFixture({
      components: ['critical-rules-setup'],
      modules: ['alpha', 'omega'],
    });
    const file = writeArtifact(repo, dir);
    const artifact = readFileSync(file, 'utf-8');
    const {cloneDir} = sandboxedManagedClone();
    initRepoAt(cloneDir, RULES_FILES);

    const run = doctorFix(repo);

    // The writer refuses an unverified source anyway (D15); offering the fixer
    // here would print a loud failure at every offline session start instead.
    expect(run.out).toContain('cannot-check:');
    expect(run.out).not.toContain('in-process fixer');
    expect(run.out).not.toContain('fix FAILED');
    expect(readFileSync(file, 'utf-8')).toBe(artifact);
  });

  test('in-process: the fixer writes the CHECKED root, not the cwd (home-base-6dni)', async () => {
    const {dir} = gitPromptsFixture();
    const repo = projectFixture({
      components: ['critical-rules-setup'],
      modules: ['alpha', 'omega'],
    });
    const commits = commitCount(repo);
    // cwd here is the SDK checkout the test runs from — deliberately NOT the
    // repo under examination, which is the whole point of the arm.
    const cwd = process.cwd();
    expect(resolve(cwd)).not.toBe(resolve(repo));
    const cwdArtifact = projectRulesFilePath(cwd);
    const cwdArtifactBefore = existsSync(cwdArtifact);

    const exit = await runDoctor(repo, {fix: true, quiet: false, yes: true});

    expect(exit).toBe(0);
    expect(existsSync(projectRulesFilePath(repo))).toBe(true);
    expect(existsSync(cwdArtifact)).toBe(cwdArtifactBefore);
    expect(commitCount(repo)).toBe(commits);
  });
});
