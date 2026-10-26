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
import {
  applyDispatchForComponent,
  describeDispatchOutcome,
  hookDispatchEnabled,
  removeDispatchEntriesForComponent,
} from '../src/hook-entries';
import {
  dispatchCommand,
  DISPATCHED_EVENTS,
  HOOK_HANDLERS,
  retiredDispatchCommand,
} from '../src/hook-registry';
import {removeComponent} from '../src/remove';
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

/**
 * home-base-rtsx1.7: dispatch is the DEFAULT. An absent knob is on; only an
 * explicit `false`, or a config that cannot be read, is off, because
 * per-handler entries work with every SDK version.
 */
describe('the knob: absent means on (rtsx1.7)', () => {
  /** A scratch project whose config file holds exactly `text`, or no file. */
  function rawProject(text: string | null): string {
    const sandbox = createSandbox();
    sandboxes.push(sandbox);
    if (text != null) sandbox.writeFile('justin-sdk.config.json', text);
    return sandbox.path;
  }

  test('absent is on: no hooks key, or a hooks block with no dispatch key', () => {
    for (const config of [
      {},
      {components: ['time-check-setup']},
      {hooks: {}},
      {hooks: {dispatch: true}},
    ]) {
      const text = JSON.stringify(config);
      expect({on: hookDispatchEnabled(rawProject(text)), text}).toEqual({
        on: true,
        text,
      });
    }
  });

  test('an explicit false is off', () => {
    expect(
      hookDispatchEnabled(
        rawProject(JSON.stringify({hooks: {dispatch: false}})),
      ),
    ).toBe(false);
  });

  test('a missing or unreadable config is off', () => {
    for (const text of [
      null, // no config file at all
      '',
      '{not json',
      'null',
      '[]',
      '"on"',
      '{"hooks": null}',
      '{"hooks": "on"}',
      '{"hooks": []}',
      '{"hooks": {"dispatch": "true"}}',
      '{"hooks": {"dispatch": null}}',
      '{"hooks": {"dispatch": 1}}',
    ]) {
      expect({on: hookDispatchEnabled(rawProject(text)), text}).toEqual({
        on: false,
        text,
      });
    }
    const directory = rawProject(null);
    mkdirSync(join(directory, 'justin-sdk.config.json'));
    expect(hookDispatchEnabled(directory)).toBe(false);
  });

  test('a per-handler repo whose config has no hooks key moves to the dispatcher entries on install', () => {
    const root = project({hooks: {dispatch: false}});
    installHooks(root);
    expect(commands(root, 'UserPromptSubmit')).toHaveLength(4);

    // Every consumer config: the key was never written.
    writeFileSync(join(root, 'justin-sdk.config.json'), '{}');
    const lines = installHooks(root);

    for (const event of DISPATCHED_EVENTS) {
      expect(commands(root, event)).toEqual([dispatchCommand(event)]);
    }
    for (const event of Object.keys(hooksOf(root))) {
      for (const command of commands(root, event)) {
        expect(PER_HANDLER_COMMANDS).not.toContain(command);
      }
    }
    for (const handler of HOOK_HANDLERS) {
      for (const {event} of handler.events) {
        expect(lines).toContain(
          `  removed: .claude/settings.json ${event} hook (${handler.command}) — the ${event} dispatcher entry runs it now`,
        );
      }
    }
  });

  test('…and a missing config writes per-handler entries, as every SDK version can run', () => {
    const sandbox = createSandbox();
    sandboxes.push(sandbox);
    installHooks(sandbox.path);
    expect(commands(sandbox.path, 'UserPromptSubmit')).toHaveLength(4);
    for (const event of DISPATCHED_EVENTS) {
      expect(commands(sandbox.path, event)).not.toContain(
        dispatchCommand(event),
      );
    }
  });
});

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
    const root = project({hooks: {dispatch: false}});
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
    const root = project({hooks: {dispatch: false}});
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
    const plain = project({hooks: {dispatch: false}});
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

/**
 * Rewrite every current dispatcher command in the settings file to the retired
 * spelling: the shape home-base main carried before home-base-rtsx1.6, written
 * by the real installers and then aged by hand.
 */
function retire(root: string): void {
  const settings = readSettings(root);
  const hooks = settings.hooks as Record<
    string,
    {hooks: {command: string}[]; matcher?: string}[]
  >;
  for (const event of DISPATCHED_EVENTS) {
    for (const entry of hooks[event] ?? []) {
      for (const hook of entry.hooks) {
        if (hook.command === dispatchCommand(event)) {
          hook.command = retiredDispatchCommand(event);
        }
      }
    }
  }
  writeFileSync(settingsPath(root), JSON.stringify(settings));
}

/**
 * home-base-rtsx1.6, the double-run trap: the retired spelling carries no
 * handler id, so nothing else flags it. If install only learned the new
 * spelling it would append the new entry beside the old one and every handler
 * would run twice, silently.
 */
describe('a retired-spelling dispatcher entry (rtsx1.6)', () => {
  test('install rewrites it in place: exactly one dispatcher entry per event, reported', () => {
    const root = project({hooks: {dispatch: true}});
    installHooks(root);
    retire(root);
    for (const event of DISPATCHED_EVENTS) {
      expect(commands(root, event)).toEqual([retiredDispatchCommand(event)]);
    }

    const lines = installHooks(root);
    for (const event of DISPATCHED_EVENTS) {
      expect(commands(root, event)).toEqual([dispatchCommand(event)]);
      expect(lines).toContain(
        `  rewritten: .claude/settings.json ${event} hook (${retiredDispatchCommand(event)} → ${dispatchCommand(event)}) — the old spelling ran the SDK of whatever checkout the session was in, and lost every hook in one older than the dispatcher`,
      );
    }
    const postToolUse = hooksOf(root).PostToolUse as {matcher?: string}[];
    expect(postToolUse[0]?.matcher).toBe('Bash');
    for (const event of ['UserPromptSubmit', 'PostToolBatch', 'Stop']) {
      const entries = hooksOf(root)[event] as {matcher?: string}[];
      expect(entries[0]?.matcher).toBeUndefined();
    }

    // …and the result is exactly what a repo that never had the retired
    // spelling holds, so a further install is a no-op.
    const fresh = project({hooks: {dispatch: true}});
    installHooks(fresh);
    expect(hooksOf(root)).toEqual(hooksOf(fresh));
    const settled = readFileSync(settingsPath(root), 'utf8');
    installHooks(root);
    expect(readFileSync(settingsPath(root), 'utf8')).toBe(settled);
  });

  test('applyDispatchForComponent: in place, keeping position and foreign hooks; matcher corrected', () => {
    const retired = retiredDispatchCommand('PostToolUse');
    const settings: Record<string, unknown> = {
      hooks: {
        PostToolUse: [
          {
            hooks: [{command: 'bun run prettier --write', type: 'command'}],
            matcher: 'Edit|Write',
          },
          // The retired entry, without its matcher, sharing its entry with a
          // foreign hook.
          {
            hooks: [
              {command: retired, timeout: 30, type: 'command'},
              {command: 'echo foreign', type: 'command'},
            ],
          },
        ],
      },
    };
    const outcome = applyDispatchForComponent(settings, 'thread-hooks-setup');
    expect(outcome.rewritten).toEqual(['PostToolUse']);
    // UserPromptSubmit and Stop are added (thread-hooks runs on them too and
    // they had no entry); PostToolUse is reported once, as the rewrite.
    expect(outcome.added).toEqual(['UserPromptSubmit', 'Stop']);
    expect(outcome.changed).toBe(true);
    expect((settings.hooks as Record<string, unknown>).PostToolUse).toEqual([
      {
        hooks: [{command: 'bun run prettier --write', type: 'command'}],
        matcher: 'Edit|Write',
      },
      {
        hooks: [
          {
            command: dispatchCommand('PostToolUse'),
            timeout: 30,
            type: 'command',
          },
          {command: 'echo foreign', type: 'command'},
        ],
        matcher: 'Bash',
      },
    ]);
  });

  test('applyDispatchForComponent: a retired entry BESIDE the current one is taken back', () => {
    const settings: Record<string, unknown> = {
      hooks: {
        Stop: [
          {hooks: [{command: dispatchCommand('Stop'), type: 'command'}]},
          {hooks: [{command: retiredDispatchCommand('Stop'), type: 'command'}]},
        ],
      },
    };
    const outcome = applyDispatchForComponent(settings, 'thread-hooks-setup');
    expect(outcome.rewritten).toEqual([]);
    expect(outcome.removed).toContainEqual({
      command: retiredDispatchCommand('Stop'),
      event: 'Stop',
    });
    expect((settings.hooks as Record<string, unknown>).Stop).toEqual([
      {hooks: [{command: dispatchCommand('Stop'), type: 'command'}]},
    ]);
    expect(describeDispatchOutcome(outcome)).toContain(
      `removed: .claude/settings.json Stop hook (${retiredDispatchCommand('Stop')}) — a retired spelling of the dispatcher entry, beside the current one: every handler on it ran twice`,
    );
  });

  test('a second copy of the retired command in one entry does not become a second current one', () => {
    const retired = retiredDispatchCommand('Stop');
    const settings: Record<string, unknown> = {
      hooks: {
        Stop: [
          {
            hooks: [
              {command: retired, type: 'command'},
              {command: retired, type: 'command'},
            ],
          },
        ],
      },
    };
    applyDispatchForComponent(settings, 'thread-hooks-setup');
    expect((settings.hooks as Record<string, unknown>).Stop).toEqual([
      {hooks: [{command: dispatchCommand('Stop'), type: 'command'}]},
    ]);
  });

  test('dispatch off: removeDispatchEntriesForComponent takes back both spellings by exact match, and nothing else', () => {
    const edited = `${retiredDispatchCommand('Stop')} && echo mine`;
    const settings: Record<string, unknown> = {
      hooks: {
        Stop: [
          {hooks: [{command: dispatchCommand('Stop'), type: 'command'}]},
          {hooks: [{command: retiredDispatchCommand('Stop'), type: 'command'}]},
          {hooks: [{command: edited, type: 'command'}]},
          {hooks: [{command: 'echo foreign', type: 'command'}]},
          {
            hooks: [
              {command: dispatchCommand('UserPromptSubmit'), type: 'command'},
            ],
          },
        ],
      },
    };
    const cleared = removeDispatchEntriesForComponent(
      settings,
      'thread-hooks-setup',
    );
    expect(cleared).toEqual([
      {command: dispatchCommand('Stop'), event: 'Stop'},
      {command: retiredDispatchCommand('Stop'), event: 'Stop'},
    ]);
    expect((settings.hooks as Record<string, unknown>).Stop).toEqual([
      {hooks: [{command: edited, type: 'command'}]},
      {hooks: [{command: 'echo foreign', type: 'command'}]},
      {
        hooks: [
          {command: dispatchCommand('UserPromptSubmit'), type: 'command'},
        ],
      },
    ]);
  });

  test('dispatch off through install: the retired entries go, named as they were spelled', () => {
    const plain = project({hooks: {dispatch: false}});
    installHooks(plain);

    const root = project({hooks: {dispatch: true}});
    installHooks(root);
    retire(root);
    setDispatch(root, false);
    const lines = installHooks(root);

    expect(hooksOf(root)).toEqual(hooksOf(plain));
    for (const event of DISPATCHED_EVENTS) {
      expect(lines).toContain(
        `  removed: .claude/settings.json ${event} hook (${retiredDispatchCommand(event)}) — hooks.dispatch is off, so each handler gets its own entry again`,
      );
    }
  });

  test('remove / install --prune leave a shared dispatcher entry alone, in either spelling (rtsx1.2 finding 5)', () => {
    // A dispatcher entry runs every listed component's handlers, so removing
    // ONE component must not take it: `remove` drops the component from the
    // config, which is what stops the dispatcher running it. remove.ts's
    // manifest hooks are per-handler commands only, matched exactly, so
    // neither spelling is ever theirs to delete.
    for (const age of ['current', 'retired'] as const) {
      const root = project({hooks: {dispatch: true}});
      installHooks(root);
      if (age === 'retired') retire(root);
      const before = hooksOf(root);
      const plan = removeComponent(root, 'thread-hooks', {dryRun: true});
      for (const outcome of plan.outcomes) {
        expect(outcome.what).not.toContain('justin-sdk hook');
      }
      removeComponent(root, 'thread-hooks');
      expect(hooksOf(root)).toEqual(before);
    }
  });

  test('the readers count it: session-start arms, and component evidence holds', () => {
    const root = project({hooks: {dispatch: true}});
    installHooks(root);
    retire(root);
    const home = project({});
    expect(repoStateHookPresence(root, false, {HOME: home})).toEqual({
      kind: 'installed',
      where: settingsPath(root),
    });
    expect(componentInstalledEvidence(root, 'thread-hooks')).toEqual({
      because: '.claude/settings.json UserPromptSubmit (hook dispatcher)',
      installed: true,
    });
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
