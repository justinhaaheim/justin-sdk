/**
 * Install and doctor follow componentConfig.thread.fullReportCommand
 * (home-base-1rxt0.14), the same way they follow the guard's and the brake's
 * knobs.
 *
 *   - per-handler mode: `thread full-report` gets its own UserPromptSubmit
 *     entry only where the knob is on, and install takes back the exact entry
 *     it wrote when the knob goes off;
 *   - dispatch mode: the one UserPromptSubmit dispatcher entry is unchanged
 *     either way (the dispatcher's prompt filter does the narrowing), and no
 *     per-handler entry appears;
 *   - doctor's HOOK_ENTRIES agrees with install in every state.
 */

import type {DryRun} from '../src/hook-entries-check';
import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, spyOn, test} from 'bun:test';
import {readFileSync} from 'fs';
import {join} from 'path';

import {checkSdkHookEntries} from '../src/hook-entries-check';
import {handlersByKnob} from '../src/hook-knobs';
import {dispatchCommand} from '../src/hook-registry';
import {setQuiet} from '../src/setup-helpers';
import {
  stepThreadHooks,
  THREAD_CAPTURE_HOOK_COMMAND,
  THREAD_FULL_REPORT_HOOK_COMMAND,
} from '../src/thread-hooks-setup';
import {createSandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

const DRY: DryRun = (event) => ({
  exitCode: 0,
  stdout: JSON.stringify({event, handlers: [], ok: true}),
});

function repo(options: {dispatch: boolean}): {
  env: Record<string, string | undefined>;
  root: string;
  setKnob: (on: boolean) => void;
} {
  const sb = createSandbox();
  sandboxes.push(sb);
  const setKnob = (on: boolean): void => {
    const config: Record<string, unknown> = {
      componentConfig: {thread: {fullReportCommand: on}},
      components: ['thread-hooks-setup'],
    };
    if (!options.dispatch) config.hooks = {dispatch: false};
    sb.writeFile('justin-sdk.config.json', JSON.stringify(config));
  };
  setKnob(false);
  return {
    env: {HOME: join(sb.path, 'home'), XDG_CONFIG_HOME: join(sb.path, 'xdg')},
    root: sb.path,
    setKnob,
  };
}

function install(root: string, env: Record<string, string | undefined>) {
  setQuiet(true);
  const lines: string[] = [];
  const spy = spyOn(console, 'log').mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  try {
    expect(stepThreadHooks(root, handlersByKnob(root, env))).toBe(true);
  } finally {
    spy.mockRestore();
    setQuiet(false);
  }
  return lines;
}

/** Every command under UserPromptSubmit, in order. */
function promptCommands(root: string): string[] {
  const settings = JSON.parse(
    readFileSync(join(root, '.claude', 'settings.json'), 'utf8'),
  ) as {hooks?: Record<string, {hooks: {command: string}[]}[]>};
  return (settings.hooks?.UserPromptSubmit ?? []).flatMap((entry) =>
    entry.hooks.map((hook) => hook.command),
  );
}

function doctor(root: string, env: Record<string, string | undefined>) {
  const report = checkSdkHookEntries(root, {
    byKnob: handlersByKnob(root, env),
    dryRun: DRY,
  });
  if (report.kind !== 'checked') throw new Error(report.reason);
  // The thread handlers only: base-setup's repo-state entry is not this
  // installer's to write.
  const about = (lines: string[]) =>
    lines.filter(
      (l) => l.startsWith('UserPromptSubmit') && !l.includes('repo-state'),
    );
  return {
    doubleRuns: about(report.doubleRuns),
    extra: about(report.extra),
    missing: about(report.missing),
    stale: about(report.stale),
  };
}

const CLEAN = {doubleRuns: [], extra: [], missing: [], stale: []};

describe('install follows componentConfig.thread.fullReportCommand', () => {
  test('per-handler mode: the entry appears with the knob on and is taken back when it goes off', () => {
    const {env, root, setKnob} = repo({dispatch: false});
    install(root, env);
    expect(promptCommands(root)).toEqual([THREAD_CAPTURE_HOOK_COMMAND]);
    expect(doctor(root, env)).toEqual(CLEAN);

    setKnob(true);
    install(root, env);
    expect(promptCommands(root)).toEqual([
      THREAD_CAPTURE_HOOK_COMMAND,
      THREAD_FULL_REPORT_HOOK_COMMAND,
    ]);
    expect(doctor(root, env)).toEqual(CLEAN);

    // A second install changes nothing.
    install(root, env);
    expect(promptCommands(root)).toHaveLength(2);

    setKnob(false);
    const lines = install(root, env);
    expect(promptCommands(root)).toEqual([THREAD_CAPTURE_HOOK_COMMAND]);
    expect(lines.join('\n')).toContain(THREAD_FULL_REPORT_HOOK_COMMAND);
    expect(doctor(root, env)).toEqual(CLEAN);
  });

  test('dispatch mode: one dispatcher entry whatever the knob says, and doctor agrees', () => {
    const {env, root, setKnob} = repo({dispatch: true});
    install(root, env);
    expect(promptCommands(root)).toEqual([dispatchCommand('UserPromptSubmit')]);
    expect(doctor(root, env)).toEqual(CLEAN);

    setKnob(true);
    install(root, env);
    expect(promptCommands(root)).toEqual([dispatchCommand('UserPromptSubmit')]);
    expect(doctor(root, env)).toEqual(CLEAN);
  });
});
