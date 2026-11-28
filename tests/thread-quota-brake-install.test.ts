/**
 * Registration of the spend quota's brake (request home-base-ys9t7.5 D6;
 * dispatch 2 item 6): install writes `thread brake` on PreToolUse for EVERY
 * tool only where componentConfig.thread.quota.mode is not off, and the
 * session guard's registration check still finds the guard behind it.
 *
 * Since the file-access audit log (home-base-n1qy7.15.1) every enrolled repo
 * has a PreToolUse handler for every tool, so the dispatcher entry matches
 * every tool whatever the quota mode. A repo installed before it carries the
 * entry with a Bash matcher (home-base did on 2026-11-28): install rewrites
 * that entry IN PLACE to no matcher, never a second entry.
 */

import type {DryRun} from '../src/hook-entries-check';
import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, spyOn, test} from 'bun:test';
import {readFileSync} from 'fs';
import {join} from 'path';

import {FILE_AUDIT_HOOK_COMMAND, stepClaudeSettings} from '../src/base-setup';
import {checkSdkHookEntries} from '../src/hook-entries-check';
import {handlersByKnob} from '../src/hook-knobs';
import {dispatchCommand} from '../src/hook-registry';
import {setQuiet} from '../src/setup-helpers';
import {guardRegistration} from '../src/thread/guard-registration';
import {
  stepThreadHooks,
  THREAD_BRAKE_HOOK_COMMAND,
  THREAD_GUARD_HOOK_COMMAND,
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

type Mode = 'enforce' | 'observe' | 'off';

const BASH_DISPATCHER = {
  hooks: [{command: dispatchCommand('PreToolUse'), type: 'command'}],
  matcher: 'Bash',
};

const EVERY_TOOL_DISPATCHER = {
  hooks: [{command: dispatchCommand('PreToolUse'), type: 'command'}],
};

function repo(options: {dispatch: boolean; seedBashEntry?: boolean}): {
  env: Record<string, string | undefined>;
  root: string;
  setMode: (mode: Mode) => void;
} {
  const sb = createSandbox();
  sandboxes.push(sb);
  const setMode = (mode: Mode): void => {
    const config: Record<string, unknown> = {
      componentConfig: {
        thread: {handoff: {successor: true}, quota: {mode}},
      },
      components: ['thread-hooks-setup'],
    };
    if (!options.dispatch) config.hooks = {dispatch: false};
    sb.writeFile('justin-sdk.config.json', JSON.stringify(config));
  };
  setMode('off');
  if (options.seedBashEntry === true) {
    sb.writeFile(
      '.claude/settings.json',
      JSON.stringify({hooks: {PreToolUse: [BASH_DISPATCHER]}}),
    );
  }
  return {
    env: {HOME: join(sb.path, 'home'), XDG_CONFIG_HOME: join(sb.path, 'xdg')},
    root: sb.path,
    setMode,
  };
}

/** base-setup first, then the thread hooks: what every installer does. */
function install(root: string, env: Record<string, string | undefined>) {
  setQuiet(true);
  const lines: string[] = [];
  const spy = spyOn(console, 'log').mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  try {
    expect(stepClaudeSettings(root)).toBe(true);
    expect(stepThreadHooks(root, handlersByKnob(root, env))).toBe(true);
  } finally {
    spy.mockRestore();
    setQuiet(false);
  }
  return lines;
}

function preToolUse(root: string): unknown {
  const settings = JSON.parse(
    readFileSync(join(root, '.claude', 'settings.json'), 'utf8'),
  ) as {hooks?: Record<string, unknown>};
  return settings.hooks?.PreToolUse;
}

function doctor(root: string, env: Record<string, string | undefined>) {
  const report = checkSdkHookEntries(root, {
    byKnob: handlersByKnob(root, env),
    dryRun: DRY,
  });
  if (report.kind !== 'checked') throw new Error(report.reason);
  const about = (lines: string[]) =>
    lines.filter((l) => l.startsWith('PreToolUse'));
  return {
    doubleRuns: about(report.doubleRuns),
    extra: about(report.extra),
    missing: about(report.missing),
    stale: about(report.stale),
  };
}

const CLEAN = {doubleRuns: [], extra: [], missing: [], stale: []};

describe('install follows componentConfig.thread.quota.mode', () => {
  test('dispatch on: a Bash dispatcher entry is rewritten in place to every tool; the guard is still found', () => {
    const {env, root, setMode} = repo({dispatch: true, seedBashEntry: true});
    expect(doctor(root, env).stale).toEqual([
      "PreToolUse: the dispatcher entry's matcher is Bash; install writes none",
    ]);
    install(root, env);
    // ONE entry, the same command, no matcher (every tool).
    expect(preToolUse(root)).toEqual([EVERY_TOOL_DISPATCHER]);
    expect(doctor(root, env)).toEqual(CLEAN);
    expect(guardRegistration({env, roots: [root]}).kind).toBe('registered');

    // The quota mode no longer changes the entry: the audit hook needs every
    // tool either way.
    setMode('observe');
    install(root, env);
    expect(preToolUse(root)).toEqual([EVERY_TOOL_DISPATCHER]);
    setMode('off');
    install(root, env);
    expect(preToolUse(root)).toEqual([EVERY_TOOL_DISPATCHER]);
    expect(doctor(root, env)).toEqual(CLEAN);
  });

  test('dispatch on, mode off: one every-tool entry; doctor agrees', () => {
    const {env, root} = repo({dispatch: true});
    install(root, env);
    expect(preToolUse(root)).toEqual([EVERY_TOOL_DISPATCHER]);
    expect(doctor(root, env)).toEqual(CLEAN);
  });

  test('dispatch off: a per-handler brake entry with no matcher beside the guard; mode off takes it back', () => {
    const {env, root, setMode} = repo({dispatch: false});
    setMode('enforce');
    install(root, env);
    expect(preToolUse(root)).toEqual([
      {hooks: [{command: FILE_AUDIT_HOOK_COMMAND, type: 'command'}]},
      {
        hooks: [{command: THREAD_GUARD_HOOK_COMMAND, type: 'command'}],
        matcher: 'Bash',
      },
      {hooks: [{command: THREAD_BRAKE_HOOK_COMMAND, type: 'command'}]},
    ]);
    expect(doctor(root, env)).toEqual(CLEAN);
    expect(guardRegistration({env, roots: [root]}).kind).toBe('registered');

    setMode('off');
    const lines = install(root, env);
    expect(JSON.stringify(preToolUse(root))).not.toContain('thread brake');
    expect(lines.join('\n')).toContain('thread brake');
    expect(doctor(root, env)).toEqual(CLEAN);
  });

  test('doctor names a Bash-only entry stale where the mode is on', () => {
    const {env, root, setMode} = repo({dispatch: true, seedBashEntry: true});
    setMode('observe');
    // The settings still carry only the Bash entry: neither the brake nor the
    // audit hook would see an Edit call.
    const found = doctor(root, env);
    expect([...found.missing, ...found.stale].join('\n')).not.toBe('');
  });
});
