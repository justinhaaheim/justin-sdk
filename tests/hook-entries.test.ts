/**
 * hooks.dispatch in the installers and readers (home-base-rtsx1.2).
 *
 * The property that matters above all: no repo ever runs a handler twice. So
 * every test here drives the REAL settings steps of all four hook-writing
 * components (base-setup's stepClaudeSettings, time-check, usage-check,
 * thread-hooks) against a real .claude/settings.json in a scratch project,
 * in both directions, and checks the whole hooks block.
 */

import {afterEach, describe, expect, spyOn, test} from 'bun:test';
import {mkdirSync, readFileSync, writeFileSync} from 'fs';
import {join} from 'path';

import {stepClaudeSettings} from '../src/base-setup';
import {componentInstalledEvidence} from '../src/component-manifest';
import {repoStateHookPresence} from '../src/first-prompt';
import {applyDispatchForComponent} from '../src/hook-entries';
import {
  dispatchCommand,
  DISPATCHED_EVENTS,
  HOOK_HANDLERS,
} from '../src/hook-registry';
import {setQuiet} from '../src/setup-helpers';
import {stepThreadHooks} from '../src/thread-hooks-setup';
import {stepTimeCheckHook} from '../src/time-check-setup';
import {stepUsageCheckHooks} from '../src/usage-check-setup';
import {createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
const spies: {mockRestore: () => void}[] = [];
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
  for (const spy of spies.splice(0)) spy.mockRestore();
  setQuiet(false);
});

function project(config: Record<string, unknown>): string {
  const sandbox = createSandbox();
  sandboxes.push(sandbox);
  sandbox.writeFile('justin-sdk.config.json', JSON.stringify(config));
  return sandbox.path;
}

function setDispatch(root: string, on: boolean): void {
  const path = join(root, 'justin-sdk.config.json');
  const config = JSON.parse(readFileSync(path, 'utf8')) as Record<
    string,
    unknown
  >;
  config.hooks = {dispatch: on};
  writeFileSync(path, JSON.stringify(config));
}

function settingsPath(root: string): string {
  return join(root, '.claude', 'settings.json');
}

function readSettings(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsPath(root), 'utf8')) as Record<
    string,
    unknown
  >;
}

function hooksOf(root: string): Record<string, unknown> {
  return (readSettings(root).hooks ?? {}) as Record<string, unknown>;
}

/** Every command under one event, flattened. */
function commands(root: string, event: string): string[] {
  const entries = (hooksOf(root)[event] as unknown[] | undefined) ?? [];
  return entries.flatMap((entry) =>
    (((entry as {hooks?: unknown}).hooks as {command: string}[]) ?? []).map(
      (hook) => hook.command,
    ),
  );
}

/** Run every hook-writing settings step, as `install` would; return the lines printed. */
function installHooks(root: string): string[] {
  setQuiet(true);
  const lines: string[] = [];
  const spy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  try {
    expect(stepClaudeSettings(root)).toBe(true);
    expect(stepTimeCheckHook(root)).toBe(true);
    expect(stepUsageCheckHooks(root)).toBe(true);
    expect(stepThreadHooks(root)).toBe(true);
  } finally {
    spy.mockRestore();
  }
  return lines;
}

const PER_HANDLER_COMMANDS = HOOK_HANDLERS.map((h) => h.command);

describe('dispatch on', () => {
  test('one dispatcher entry per event, no per-handler entry, SessionStart untouched', () => {
    const root = project({hooks: {dispatch: true}});
    installHooks(root);

    for (const event of DISPATCHED_EVENTS) {
      expect(commands(root, event)).toEqual([dispatchCommand(event)]);
    }
    const postToolUse = hooksOf(root).PostToolUse as {matcher?: string}[];
    expect(postToolUse[0]?.matcher).toBe('Bash');
    expect(commands(root, 'SessionStart')).toHaveLength(1);
    for (const event of Object.keys(hooksOf(root))) {
      for (const command of commands(root, event)) {
        expect(PER_HANDLER_COMMANDS).not.toContain(command);
      }
    }
  });

  test('a second install changes nothing', () => {
    const root = project({hooks: {dispatch: true}});
    installHooks(root);
    const first = readFileSync(settingsPath(root), 'utf8');
    installHooks(root);
    expect(readFileSync(settingsPath(root), 'utf8')).toBe(first);
  });

  test('switching on takes back each per-handler entry by identity and says so', () => {
    const root = project({});
    installHooks(root);
    expect(commands(root, 'UserPromptSubmit')).toHaveLength(4);

    setDispatch(root, true);
    const lines = installHooks(root);
    for (const event of DISPATCHED_EVENTS) {
      expect(commands(root, event)).toEqual([dispatchCommand(event)]);
    }
    for (const handler of HOOK_HANDLERS) {
      for (const {event} of handler.events) {
        expect(lines).toContain(
          `  removed: .claude/settings.json ${event} hook (${handler.command}) — the ${event} dispatcher entry runs it now`,
        );
      }
    }
  });

  test('a hand-edited per-handler entry is kept, and reported as running twice', () => {
    const root = project({});
    installHooks(root);
    const settings = readSettings(root);
    const hooks = settings.hooks as Record<string, unknown[]>;
    const edited = 'bun run justin-sdk time-check && echo mine';
    hooks.UserPromptSubmit = [
      ...(hooks.UserPromptSubmit ?? []).filter(
        (entry) => !JSON.stringify(entry).includes('time-check'),
      ),
      {hooks: [{command: edited, type: 'command'}]},
    ];
    writeFileSync(settingsPath(root), JSON.stringify(settings));

    setDispatch(root, true);
    const lines = installHooks(root);
    expect(commands(root, 'UserPromptSubmit')).toEqual([
      edited,
      dispatchCommand('UserPromptSubmit'),
    ]);
    expect(
      lines.some(
        (line) => line.includes(edited) && line.includes('RUNS TWICE'),
      ),
    ).toBe(true);
  });

  test('foreign hooks survive in both directions', () => {
    const root = project({});
    const foreign = {
      Notification: [
        {hooks: [{command: 'terminal-notifier -message hi', type: 'command'}]},
      ],
      PostToolUse: [
        {
          hooks: [{command: 'bun run prettier --write', type: 'command'}],
          matcher: 'Edit|Write',
        },
      ],
    };
    mkdirSync(join(root, '.claude'), {recursive: true});
    writeFileSync(settingsPath(root), JSON.stringify({hooks: foreign}));

    setDispatch(root, true);
    installHooks(root);
    expect(commands(root, 'Notification')).toEqual([
      'terminal-notifier -message hi',
    ]);
    expect(commands(root, 'PostToolUse')).toEqual([
      'bun run prettier --write',
      dispatchCommand('PostToolUse'),
    ]);

    setDispatch(root, false);
    installHooks(root);
    expect(commands(root, 'Notification')).toEqual([
      'terminal-notifier -message hi',
    ]);
    expect(commands(root, 'PostToolUse')).toEqual([
      'bun run prettier --write',
      'bun run justin-sdk thread nudge',
    ]);
  });
});

describe('dispatch off again', () => {
  test('restores exactly the per-handler entries a never-dispatched repo has', () => {
    const plain = project({});
    installHooks(plain);
    const expected = hooksOf(plain);

    const root = project({hooks: {dispatch: true}});
    installHooks(root);
    setDispatch(root, false);
    const lines = installHooks(root);

    expect(hooksOf(root)).toEqual(expected);
    for (const event of DISPATCHED_EVENTS) {
      expect(
        lines.some((line) =>
          line.includes(
            `removed: .claude/settings.json ${event} hook (${dispatchCommand(event)})`,
          ),
        ),
      ).toBe(true);
    }
  });
});

describe('the readers see a dispatched handler as registered', () => {
  test('repoStateHookPresence: the dispatcher entry counts, so session-start arms instead of injecting twice', () => {
    const root = project({hooks: {dispatch: true}});
    installHooks(root);
    const home = project({});
    const presence = repoStateHookPresence(root, false, {HOME: home});
    expect(presence).toEqual({kind: 'installed', where: settingsPath(root)});
    // The user-level twin is a different hook; the dispatcher never stands in for it.
    expect(repoStateHookPresence(root, true, {HOME: home}).kind).toBe('absent');
  });

  test('componentInstalledEvidence: thread-hooks is installed through the dispatcher while the config lists it', () => {
    const root = project({hooks: {dispatch: true}});
    installHooks(root);
    expect(componentInstalledEvidence(root, 'thread-hooks')).toEqual({
      because: '.claude/settings.json UserPromptSubmit (hook dispatcher)',
      installed: true,
    });
  });

  test('…and not installed when the config does not list it, because the dispatcher does not run it', () => {
    const root = project({hooks: {dispatch: true}});
    installHooks(root);
    writeFileSync(
      join(root, 'justin-sdk.config.json'),
      JSON.stringify({
        components: ['time-check-setup'],
        hooks: {dispatch: true},
      }),
    );
    expect(componentInstalledEvidence(root, 'thread-hooks').installed).toBe(
      false,
    );
  });
});

describe('applyDispatchForComponent', () => {
  test('corrects a dispatcher entry whose matcher is wrong', () => {
    const settings: Record<string, unknown> = {
      hooks: {
        PostToolUse: [
          {hooks: [{command: dispatchCommand('PostToolUse'), type: 'command'}]},
        ],
      },
    };
    const outcome = applyDispatchForComponent(settings, 'thread-hooks-setup');
    expect(outcome.added).toContain('PostToolUse');
    const entry = (settings.hooks as Record<string, {matcher?: string}[]>)
      .PostToolUse?.[0];
    expect(entry?.matcher).toBe('Bash');
  });
});
