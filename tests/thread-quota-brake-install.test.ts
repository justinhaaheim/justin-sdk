/**
 * Registration of the spend quota's brake (request home-base-ys9t7.5 D6;
 * dispatch 2 item 6): install writes `thread brake` on PreToolUse for EVERY
 * tool only where componentConfig.thread.quota.mode is not off. In dispatch
 * mode that is the existing PreToolUse dispatcher entry with its Bash matcher
 * REWRITTEN IN PLACE to no matcher (never a second entry), and the session
 * guard's registration check still finds the guard behind it.
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

function repo(options: {dispatch: boolean}): {
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
  return {
    env: {HOME: join(sb.path, 'home'), XDG_CONFIG_HOME: join(sb.path, 'xdg')},
    root: sb.path,
    setMode,
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

const BASH_DISPATCHER = {
  hooks: [{command: dispatchCommand('PreToolUse'), type: 'command'}],
  matcher: 'Bash',
};

describe('install follows componentConfig.thread.quota.mode', () => {
  test('dispatch on: the Bash dispatcher entry is rewritten in place to every tool; the guard is still found', () => {
    const {env, root, setMode} = repo({dispatch: true});
    install(root, env);
    // Before: the guard alone, the Bash-matcher dispatcher entry.
    expect(preToolUse(root)).toEqual([BASH_DISPATCHER]);

    setMode('observe');
    install(root, env);
    // After: ONE entry, the same command, no matcher (every tool).
    expect(preToolUse(root)).toEqual([
      {hooks: [{command: dispatchCommand('PreToolUse'), type: 'command'}]},
    ]);
    expect(doctor(root, env)).toEqual(CLEAN);
    expect(guardRegistration({env, roots: [root]}).kind).toBe('registered');

    // A second install changes nothing; mode back off narrows it again.
    install(root, env);
    expect(preToolUse(root)).toHaveLength(1);
    setMode('off');
    install(root, env);
    expect(preToolUse(root)).toEqual([BASH_DISPATCHER]);
    expect(doctor(root, env)).toEqual(CLEAN);
  });

  test('dispatch on, mode off: no brake, the matcher stays Bash; doctor agrees', () => {
    const {env, root} = repo({dispatch: true});
    install(root, env);
    expect(preToolUse(root)).toEqual([BASH_DISPATCHER]);
    expect(doctor(root, env)).toEqual(CLEAN);
  });

  test('dispatch off: a per-handler brake entry with no matcher beside the guard; mode off takes it back', () => {
    const {env, root, setMode} = repo({dispatch: false});
    setMode('enforce');
    install(root, env);
    expect(preToolUse(root)).toEqual([
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

  test('doctor names a missing brake where the mode is on', () => {
    const {env, root, setMode} = repo({dispatch: true});
    install(root, env);
    setMode('observe');
    // The settings still carry only the Bash entry: the brake would never
    // see an Edit call.
    const found = doctor(root, env);
    expect([...found.missing, ...found.stale].join('\n')).not.toBe('');
  });
});
