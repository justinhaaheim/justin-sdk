/**
 * The thread-rules component (home-base-yukaf.26). Its doctor check is in
 * thread-rules-doctor.test.ts.
 *
 * The rules move from the prompts repo into the SDK and are COPIED into each
 * repo by `install`. Two things are guarded here:
 *
 *   1. install writes every file byte-identical to the SDK templates, a second
 *      install changes nothing, and a drifted file is replaced (the SDK's copy
 *      wins, D-RULES-INSTALL).
 *   2. remove deletes by IDENTITY: a pristine file goes, a modified one is
 *      "left in place (modified)", and `--dry-run` writes nothing. These are the
 *      pairs the lifecycle tests use — a test that only proved "it deletes"
 *      would pass on an `rm` that deletes everything.
 *
 * Every repo here sets `componentConfig.thread.enabled` in its own project
 * config, which outranks the user file, and XDG_CONFIG_HOME points at an empty
 * directory, so the results are the same on any machine.
 */

import {afterAll, afterEach, beforeAll, describe, expect, test} from 'bun:test';
import {execSync} from 'child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {runAdd} from '../src/add';
import {stripAnsi} from '../src/check-runner';
import {COMPONENT_MANIFESTS} from '../src/component-manifest';
import {runInstall} from '../src/install';
import {buildComponentListing, renderComponentListing} from '../src/list';
import {removeComponent, runRemove} from '../src/remove';
import {SDK_HANDOFF_CALL} from '../src/sdk-invocation';
import {
  THREAD_RULES_FILES,
  threadRulesFilesFor,
  threadRulesInstalledPath,
  threadRulesTemplateText,
} from '../src/thread-rules';
import {writeThreadRules} from '../src/thread-rules-setup';
import {createProjectSandbox, createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
function track(sandbox: Sandbox): Sandbox {
  sandboxes.push(sandbox);
  return sandbox;
}

const savedXdg = process.env.XDG_CONFIG_HOME;
const emptyXdg = mkdtempSync(join(tmpdir(), 'jsdk-thread-rules-xdg-'));
beforeAll(() => {
  process.env.XDG_CONFIG_HOME = emptyXdg;
});
afterAll(() => {
  if (savedXdg == null) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  rmSync(emptyXdg, {force: true, recursive: true});
});

let cachedRemote: string | null = null;
afterEach(() => {
  cachedRemote = null;
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

/** A bare remote carrying this SDK's tag, so base-setup's pin check is offline. */
function sdkRemote(): string {
  if (cachedRemote != null) return cachedRemote;
  const host = track(createSandbox());
  const work = join(host.path, 'remote-work');
  mkdirSync(work, {recursive: true});
  execSync('git init -q -b main .', {cwd: work});
  execSync('git config user.email "test@example.com"', {cwd: work});
  execSync('git config user.name "Test"', {cwd: work});
  execSync("git commit -q --allow-empty -m 'init'", {cwd: work});
  const version = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf-8'),
  ) as {version: string};
  execSync(`git tag v${version.version}`, {cwd: work});
  const bare = join(host.path, 'remote.git');
  execSync(`git clone -q --bare '${work}' '${bare}'`, {cwd: host.path});
  cachedRemote = bare;
  return bare;
}

/**
 * console.log, console.warn and console.error: `would remove:` goes to log or
 * warn, and the installer's `fail` lines go to error.
 */
async function captureOutput<T>(
  fn: () => Promise<T> | T,
): Promise<{out: string; value: T}> {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const lines: string[] = [];
  const collect = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(' '));
  };
  console.log = collect;
  console.warn = collect;
  console.error = collect;
  try {
    const value = await fn();
    return {out: stripAnsi(lines.join('\n')), value};
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
}

/**
 * An enrolled git repo with threads on or off in its own config, and the
 * handoff successor knob set explicitly (home-base-jm5kg.8): it decides
 * whether handoff.md is installed.
 */
function threadsRepo(enabled: boolean, successor: boolean): string {
  const sb = track(
    createProjectSandbox({
      justinSdkConfig: {
        componentConfig: {thread: {enabled, handoff: {successor}}},
      },
    }),
  );
  execSync('git init -q', {cwd: sb.path});
  execSync('git config user.email "test@example.com"', {cwd: sb.path});
  execSync('git config user.name "Test"', {cwd: sb.path});
  return sb.path;
}

function installed(root: string, file: (typeof THREAD_RULES_FILES)[number]) {
  return join(root, threadRulesInstalledPath(file));
}

function template(file: (typeof THREAD_RULES_FILES)[number]): string {
  const text = threadRulesTemplateText(file);
  if (text == null) throw new Error(`template ${file} unreadable`);
  return text;
}

async function addThreadRules(root: string): Promise<void> {
  const exit = await runAdd(['thread-rules'], {
    commit: false,
    force: false,
    projectRoot: root,
    sdkRepoUrl: sdkRemote(),
  });
  expect(exit).toBe(0);
}

describe('the templates', () => {
  test('all three ship with the SDK and are not empty', () => {
    for (const file of THREAD_RULES_FILES) {
      expect(template(file).length).toBeGreaterThan(1000);
    }
    expect(THREAD_RULES_FILES).toEqual([
      'status-report-format.md',
      'requests.md',
      'handoff.md',
    ]);
  });

  test('the manifest owns all three files, with the template as pristine content', () => {
    const files = COMPONENT_MANIFESTS['thread-rules'].files;
    expect(files.map((f) => f.path)).toEqual([
      '.claude/rules/justin-sdk/status-report-format.md',
      '.claude/rules/justin-sdk/requests.md',
      '.claude/rules/justin-sdk/handoff.md',
    ]);
    for (const [index, file] of THREAD_RULES_FILES.entries()) {
      expect(files[index]?.pristine()).toBe(template(file));
    }
  });
});

describe('install (AC 1)', () => {
  test('add writes every file byte-identical; a second install changes nothing', async () => {
    const root = threadsRepo(true, true);
    await addThreadRules(root);
    // home-base-mbnjv.6 AC1: the handoff rule is among them.
    expect(readFileSync(installed(root, 'handoff.md'), 'utf-8')).toBe(
      template('handoff.md'),
    );
    for (const file of THREAD_RULES_FILES) {
      expect(readFileSync(installed(root, file), 'utf-8')).toBe(template(file));
    }
    const mtimes = THREAD_RULES_FILES.map(
      (file) => statSync(installed(root, file)).mtimeMs,
    );

    const {out, value} = await captureOutput(() =>
      runInstall({projectRoot: root, sdkRepoUrl: sdkRemote()}),
    );
    expect(value).toBe(0);
    expect(out).toContain('thread-rules: applied');
    expect(
      THREAD_RULES_FILES.map((file) => statSync(installed(root, file)).mtimeMs),
    ).toEqual(mtimes);
    for (const file of THREAD_RULES_FILES) {
      expect(readFileSync(installed(root, file), 'utf-8')).toBe(template(file));
    }
  });

  test('install replaces a drifted file with the SDK copy and says so', async () => {
    const root = threadsRepo(true, true);
    await addThreadRules(root);
    const target = installed(root, 'requests.md');
    writeFileSync(target, '# my own requests rule\n');

    const {out} = await captureOutput(() =>
      runAdd(['thread-rules'], {
        commit: false,
        force: false,
        projectRoot: root,
        sdkRepoUrl: sdkRemote(),
      }),
    );
    expect(readFileSync(target, 'utf-8')).toBe(template('requests.md'));
    expect(out).toContain(
      "replaced .claude/rules/justin-sdk/requests.md: it differed from the SDK's copy",
    );
  });

  test('list shows the component with its purpose', async () => {
    const root = threadsRepo(true, true);
    await addThreadRules(root);
    const listing = buildComponentListing(root);
    const row = listing.rows.find((r) => r.name === 'thread-rules');
    expect(row).toMatchObject({
      applicable: true,
      installed: true,
      resolved: true,
    });
    const text = renderComponentListing(listing);
    expect(text).toContain('thread-rules');
    expect(text).toContain(COMPONENT_MANIFESTS['thread-rules'].purpose);
  });

  test('list says it does not apply where threads are off', () => {
    const root = threadsRepo(false, false);
    const row = buildComponentListing(root).rows.find(
      (r) => r.name === 'thread-rules',
    );
    expect(row).toMatchObject({applicable: false, installed: false});
  });
});

/**
 * home-base-jm5kg.8. Justin, 2026-10-30: "it's probably better to not put
 * information about this in critical-rules until i'm ready for all projects to
 * adopt it." handoff.md is installed only where
 * componentConfig.thread.handoff.successor is on; nothing else installed names
 * a handoff or spawn command; and install, which never removes, names a
 * handoff.md it finds where the knob is off.
 */
describe('the handoff rule follows componentConfig.thread.handoff.successor (jm5kg.8)', () => {
  const HANDOFF_PATH = '.claude/rules/justin-sdk/handoff.md';

  test('successor off: add writes the shared rules and NOT handoff.md, and says why', async () => {
    const root = threadsRepo(true, false);
    const {out} = await captureOutput(() => addThreadRules(root));
    expect(existsSync(installed(root, 'handoff.md'))).toBe(false);
    for (const file of ['status-report-format.md', 'requests.md'] as const) {
      expect(readFileSync(installed(root, file), 'utf-8')).toBe(template(file));
    }
    expect(out).toContain(
      'handoff.md is not installed here: componentConfig.thread.handoff.successor is off.',
    );
  });

  test('CONTROL: successor on, the same add writes handoff.md', async () => {
    const root = threadsRepo(true, true);
    await addThreadRules(root);
    expect(readFileSync(installed(root, 'handoff.md'), 'utf-8')).toBe(
      template('handoff.md'),
    );
  });

  test('successor off, the SDK copy of handoff.md already here: install keeps it, untouched, and names it even though install runs quiet', async () => {
    const root = threadsRepo(true, true);
    await addThreadRules(root);
    const target = installed(root, 'handoff.md');
    const before = statSync(target).mtimeMs;
    // Justin turns the knob off (the shortcut-helpers case).
    writeFileSync(
      join(root, 'justin-sdk.config.json'),
      JSON.stringify({
        componentConfig: {thread: {enabled: true, handoff: {successor: false}}},
        components: ['base-setup', 'thread-rules-setup'],
      }),
    );

    const {out, value} = await captureOutput(() =>
      runInstall({projectRoot: root, sdkRepoUrl: sdkRemote()}),
    );
    expect(value).toBe(0);
    expect(readFileSync(target, 'utf-8')).toBe(template('handoff.md'));
    expect(statSync(target).mtimeMs).toBe(before);
    expect(out).toContain(
      `left in place: ${HANDOFF_PATH} — componentConfig.thread.handoff.successor is off here`,
    );
    expect(out).toContain(
      `it is byte-identical to the SDK's copy, so deleting it loses nothing: git rm ${HANDOFF_PATH}`,
    );
  });

  test('successor off, an EDITED handoff.md: install neither rewrites it nor calls deleting it free', async () => {
    const root = threadsRepo(true, false);
    const target = installed(root, 'handoff.md');
    mkdirSync(join(target, '..'), {recursive: true});
    writeFileSync(target, '# my own handoff notes\n');

    const {out} = await captureOutput(() => addThreadRules(root));
    expect(readFileSync(target, 'utf-8')).toBe('# my own handoff notes\n');
    expect(out).toContain(
      "it differs from the SDK's copy, so read it before you delete it",
    );
    expect(out).not.toContain('loses nothing');
  });

  test('NEGATIVE CONTROL: successor on, the same edited handoff.md IS replaced (the SDK copy wins)', async () => {
    const root = threadsRepo(true, true);
    const target = installed(root, 'handoff.md');
    mkdirSync(join(target, '..'), {recursive: true});
    writeFileSync(target, '# my own handoff notes\n');
    await addThreadRules(root);
    expect(readFileSync(target, 'utf-8')).toBe(template('handoff.md'));
  });

  test('an unreadable knob writes no handoff.md, writes the rest, and fails loudly (rule 7)', async () => {
    const root = threadsRepo(true, true);
    const {out, value} = await captureOutput(() =>
      writeThreadRules(root, {kind: 'unknown', reason: 'boom'}),
    );
    expect(value).toBe(false);
    expect(existsSync(installed(root, 'handoff.md'))).toBe(false);
    expect(existsSync(installed(root, 'requests.md'))).toBe(true);
    expect(out).toContain(
      `could not read componentConfig.thread.handoff.successor (boom) — NOT writing ${HANDOFF_PATH}`,
    );
  });

  test('threadRulesFilesFor: handoff.md only with the knob on', () => {
    expect(threadRulesFilesFor(true)).toEqual(THREAD_RULES_FILES);
    expect(threadRulesFilesFor(false)).toEqual([
      'status-report-format.md',
      'requests.md',
    ]);
  });

  test('the shared templates name no handoff or spawn command, and do not point at handoff.md', () => {
    for (const file of threadRulesFilesFor(false)) {
      const text = template(file);
      for (const banned of [
        'thread handoff',
        'thread spawn',
        'handoff.md',
        SDK_HANDOFF_CALL,
      ]) {
        expect({banned, file, found: text.includes(banned)}).toEqual({
          banned,
          file,
          found: false,
        });
      }
    }
  });

  test('remove still deletes a stray pristine handoff.md by identity, knob off', async () => {
    const root = threadsRepo(true, true);
    await addThreadRules(root);
    writeFileSync(
      join(root, 'justin-sdk.config.json'),
      JSON.stringify({
        componentConfig: {thread: {enabled: true, handoff: {successor: false}}},
        components: ['base-setup', 'thread-rules-setup'],
      }),
    );
    const report = removeComponent(root, 'thread-rules');
    expect(report.outcomes).toContainEqual({
      kind: 'removed',
      what: HANDOFF_PATH,
    });
  });
});

describe('remove deletes by identity (AC 1)', () => {
  test('--dry-run names every file and writes nothing', async () => {
    const root = threadsRepo(true, true);
    await addThreadRules(root);
    const {out, value} = await captureOutput(() =>
      runRemove(['thread-rules'], {dryRun: true, projectRoot: root}),
    );
    expect(value).toBe(0);
    expect(out).toContain(
      'would remove: .claude/rules/justin-sdk/status-report-format.md',
    );
    expect(out).toContain('would remove: .claude/rules/justin-sdk/requests.md');
    expect(out).toContain('would remove: .claude/rules/justin-sdk/handoff.md');
    expect(out).toContain('would drop thread-rules-setup');
    expect(out).toContain('(dry-run) nothing was changed');
    for (const file of THREAD_RULES_FILES) {
      expect(existsSync(installed(root, file))).toBe(true);
    }
    const config = JSON.parse(
      readFileSync(join(root, 'justin-sdk.config.json'), 'utf-8'),
    ) as {components?: string[]};
    expect(config.components).toContain('thread-rules-setup');
  });

  test('pristine files are removed', async () => {
    const root = threadsRepo(true, true);
    await addThreadRules(root);
    const report = removeComponent(root, 'thread-rules');
    expect(report.outcomes).toEqual([
      {
        kind: 'removed',
        what: '.claude/rules/justin-sdk/status-report-format.md',
      },
      {kind: 'removed', what: '.claude/rules/justin-sdk/requests.md'},
      {kind: 'removed', what: '.claude/rules/justin-sdk/handoff.md'},
    ]);
    for (const file of THREAD_RULES_FILES) {
      expect(existsSync(installed(root, file))).toBe(false);
    }
  });

  test('NEGATIVE CONTROL: a modified file is left in place (modified); its pristine sibling still goes', async () => {
    const root = threadsRepo(true, true);
    await addThreadRules(root);
    const edited = installed(root, 'status-report-format.md');
    writeFileSync(edited, `${template('status-report-format.md')}\nmine\n`);

    const plan = await captureOutput(() =>
      runRemove(['thread-rules'], {dryRun: true, projectRoot: root}),
    );
    expect(plan.out).toContain(
      'left in place (modified): .claude/rules/justin-sdk/status-report-format.md',
    );

    const report = removeComponent(root, 'thread-rules');
    expect(report.outcomes).toContainEqual({
      kind: 'modified',
      what: '.claude/rules/justin-sdk/status-report-format.md',
    });
    expect(existsSync(edited)).toBe(true);
    expect(readFileSync(edited, 'utf-8')).toContain('mine');
    expect(existsSync(installed(root, 'requests.md'))).toBe(false);
  });
});
