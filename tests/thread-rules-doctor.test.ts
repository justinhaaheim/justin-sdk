/**
 * THREAD_RULES, the doctor check for the threads rules (home-base-yukaf.26,
 * D-RULES-DOCTOR): ok when both installed files match the SDK templates, warn
 * when missing with threads on, ok when missing with threads off, warn with
 * the command when drifted, and "could not check" — never "missing" — when a
 * file cannot be read (critical rule 7).
 *
 * Every repo sets `componentConfig.thread.enabled` in its own project config,
 * which outranks the user file, and XDG_CONFIG_HOME points at an empty
 * directory, so the results are the same on any machine.
 */

import {afterAll, afterEach, beforeAll, describe, expect, test} from 'bun:test';
import {chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {stripAnsi} from '../src/check-runner';
import {makeThreadRulesChecks, renderDoctor} from '../src/doctor';
import {
  THREAD_RULES_FILES,
  threadRulesInstalledPath,
  threadRulesTemplateText,
} from '../src/thread-rules';
import {createProjectSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
const savedXdg = process.env.XDG_CONFIG_HOME;
const emptyXdg = mkdtempSync(join(tmpdir(), 'jsdk-thread-rules-doctor-xdg-'));
beforeAll(() => {
  process.env.XDG_CONFIG_HOME = emptyXdg;
});
afterAll(() => {
  if (savedXdg == null) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  rmSync(emptyXdg, {force: true, recursive: true});
});
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

/** An enrolled repo with threads on or off in its own config. */
function threadsRepo(enabled: boolean): string {
  const sb = createProjectSandbox({
    justinSdkConfig: {componentConfig: {thread: {enabled}}},
  });
  sandboxes.push(sb);
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
describe('THREAD_RULES doctor check (AC 4)', () => {
  async function doctorLine(root: string): Promise<string> {
    const run = await renderDoctor(root, {});
    const report = stripAnsi(run.report);
    const lines = report.split('\n');
    const at = lines.findIndex((line) => line.includes('THREAD_RULES'));
    if (at < 0) throw new Error(`no THREAD_RULES line in:\n${report}`);
    // The check's line plus its Fix line, when there is one.
    return lines.slice(at, at + 3).join('\n');
  }

  function writeRules(root: string): void {
    for (const file of THREAD_RULES_FILES) {
      mkdirSync(join(installed(root, file), '..'), {recursive: true});
      writeFileSync(installed(root, file), template(file));
    }
  }

  test('ok when both files match', async () => {
    const root = threadsRepo(true);
    writeRules(root);
    const line = await doctorLine(root);
    expect(line).toContain('✓ THREAD_RULES');
    expect(line).toContain("2 rule files match the SDK's copy");
  });

  test('warns when missing while threads are on, with the command', async () => {
    const root = threadsRepo(true);
    const line = await doctorLine(root);
    expect(line).toContain('⚠ THREAD_RULES');
    expect(line).toContain('threads are on here');
    expect(line).toContain('.claude/rules/justin-sdk/status-report-format.md');
    // The fixture's config lists no thread-rules-setup (it resolves to core,
    // which here includes it because threads are on) — so `install` is right.
    expect(line).toContain('bun run justin-sdk install');
  });

  test('POSITIVE CONTROL: missing while threads are off is ok', async () => {
    const root = threadsRepo(false);
    const line = await doctorLine(root);
    expect(line).toContain('✓ THREAD_RULES');
    expect(line).toContain('threads are off here');
  });

  test('a config that does not list the component is told to add it', async () => {
    const root = threadsRepo(true);
    writeFileSync(
      join(root, 'justin-sdk.config.json'),
      JSON.stringify({
        componentConfig: {thread: {enabled: true}},
        components: ['base-setup'],
      }),
    );
    const line = await doctorLine(root);
    expect(line).toContain('⚠ THREAD_RULES');
    expect(line).toContain('bun run justin-sdk add thread-rules');
  });

  test('warns when a file drifted, naming it and the command', async () => {
    const root = threadsRepo(true);
    writeRules(root);
    writeFileSync(installed(root, 'requests.md'), '# edited\n');
    const line = await doctorLine(root);
    expect(line).toContain('⚠ THREAD_RULES');
    expect(line).toContain(
      ".claude/rules/justin-sdk/requests.md differs from the SDK's copy",
    );
    expect(line).toContain('bun run justin-sdk install');
  });

  test('advice only: no state carries a fixCommand or fixFn (a fixCommand runs in process.cwd(), not in the repo checked)', async () => {
    const missingOn = threadsRepo(true);
    const drifted = threadsRepo(true);
    writeRules(drifted);
    writeFileSync(installed(drifted, 'requests.md'), '# edited\n');
    for (const [root, components] of [
      [missingOn, ['base-setup', 'thread-rules-setup']],
      [missingOn, ['base-setup']],
      [drifted, ['base-setup', 'thread-rules-setup']],
    ] as const) {
      const [node] = makeThreadRulesChecks(root, components);
      const result = await node?.check.fn?.();
      expect(result?.pass).toBe(false);
      expect(result?.fix).toContain('bun run justin-sdk');
      expect(result?.fixCommand).toBeUndefined();
      expect(result?.fixFn).toBeUndefined();
    }
  });

  test('an unreadable file is "could not check", never "missing" (rule 7)', async () => {
    const root = threadsRepo(true);
    writeRules(root);
    const target = installed(root, 'status-report-format.md');
    chmodSync(target, 0o000);
    try {
      const line = await doctorLine(root);
      expect(line).toContain('⚠ THREAD_RULES');
      expect(line).toContain('could not check');
      expect(line).not.toContain('missing');
    } finally {
      chmodSync(target, 0o644);
    }
  });
});
