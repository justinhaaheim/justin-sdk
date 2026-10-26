/**
 * doctor's HOOK_ENTRIES check (home-base-rtsx1.3). Each scenario starts from a
 * repo the REAL installers wrote (both modes), then breaks one thing by hand,
 * so the check is measured against exactly what `install` produces.
 *
 * The dispatcher dry run is injected: a scratch repo has no node_modules, so
 * the real `justin-sdk hook … --dry-run` could only fail there.
 */

import {afterEach, describe, expect, spyOn, test} from 'bun:test';
import {mkdirSync, readFileSync, writeFileSync} from 'fs';
import {join} from 'path';

import {stepClaudeSettings} from '../src/base-setup';
import {hookEntriesCheckResult} from '../src/doctor';
import {type DryRun, HOOK_ENTRIES_FIX} from '../src/hook-entries-check';
import {
  dispatchCommand,
  DISPATCHED_EVENTS,
  retiredDispatchCommand,
} from '../src/hook-registry';
import {setQuiet} from '../src/setup-helpers';
import {stepThreadHooks} from '../src/thread-hooks-setup';
import {stepTimeCheckHook} from '../src/time-check-setup';
import {stepUsageCheckHooks} from '../src/usage-check-setup';
import {createSandbox, type Sandbox} from './sandbox';

const sandboxes: Sandbox[] = [];
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
  setQuiet(false);
});

const DRY_OK: DryRun = (event) => ({
  exitCode: 0,
  stdout: JSON.stringify({event, handlers: [], ok: true}),
});

function project(config: Record<string, unknown>): string {
  const sandbox = createSandbox();
  sandboxes.push(sandbox);
  sandbox.writeFile('justin-sdk.config.json', JSON.stringify(config));
  return sandbox.path;
}

function installHooks(root: string): void {
  setQuiet(true);
  const spy = spyOn(console, 'log').mockImplementation(() => {
    // The installers' change lines are not what these tests are about.
  });
  try {
    stepClaudeSettings(root);
    stepTimeCheckHook(root);
    stepUsageCheckHooks(root);
    stepThreadHooks(root);
  } finally {
    spy.mockRestore();
  }
}

type Settings = {
  hooks: Record<string, {hooks: {command: string}[]; matcher?: string}[]>;
};

function edit(root: string, change: (settings: Settings) => void): void {
  const path = join(root, '.claude', 'settings.json');
  const settings = JSON.parse(readFileSync(path, 'utf8')) as Settings;
  change(settings);
  writeFileSync(path, JSON.stringify(settings));
}

function check(root: string, dryRun: DryRun = DRY_OK) {
  return hookEntriesCheckResult(root, {dryRun});
}

describe('a repo exactly as install wrote it passes', () => {
  test('per-handler mode', () => {
    const root = project({hooks: {dispatch: false}});
    installHooks(root);
    expect(check(root)).toEqual({
      message: 'per-handler: 8 SDK hook entries match what install writes',
      pass: true,
    });
  });

  test('dispatch mode', () => {
    const root = project({hooks: {dispatch: true}});
    installHooks(root);
    expect(check(root)).toEqual({
      message: 'dispatch: 4 SDK hook entries match what install writes',
      pass: true,
    });
  });
});

/**
 * home-base-rtsx1.7: dispatch is the default, so a config with no `hooks` key
 * (every consumer's) is checked against dispatch mode.
 */
describe('with no hooks key the check expects dispatch mode', () => {
  test('per-handler entries are stale, each naming the dispatcher that should run it', () => {
    const root = project({hooks: {dispatch: false}});
    installHooks(root);
    writeFileSync(join(root, 'justin-sdk.config.json'), '{}');
    const result = check(root);
    expect(result.pass).toBe(false);
    expect(result.fix).toBe(HOOK_ENTRIES_FIX);
    expect(result.message).toContain(
      `Stop: thread stop-check has its own entry (\`bun run justin-sdk thread stop-check\`); with hooks.dispatch on, \`${dispatchCommand('Stop')}\` should run it`,
    );
  });

  test('the dispatcher entries install writes pass', () => {
    const root = project({});
    installHooks(root);
    expect(check(root)).toEqual({
      message: 'dispatch: 4 SDK hook entries match what install writes',
      pass: true,
    });
  });
});

/** Age every current dispatcher command to the retired spelling (pre-rtsx1.6). */
function retire(settings: Settings): void {
  for (const event of DISPATCHED_EVENTS) {
    for (const entry of settings.hooks[event] ?? []) {
      for (const hook of entry.hooks) {
        if (hook.command === dispatchCommand(event)) {
          hook.command = retiredDispatchCommand(event);
        }
      }
    }
  }
}

describe('a retired-spelling dispatcher entry (home-base-rtsx1.6)', () => {
  test('is a stale WARNING naming the install fix — not missing, not a double run', () => {
    const root = project({hooks: {dispatch: true}});
    installHooks(root);
    edit(root, retire);
    const result = check(root);
    expect(result.pass).toBe(false);
    expect(result.severity).toBe('warn');
    expect(result.fix).toBe(HOOK_ENTRIES_FIX);
    expect(result.fix).toContain('bun run justin-sdk install');
    expect(result.message).toContain('stale:\n');
    for (const event of DISPATCHED_EVENTS) {
      expect(result.message).toContain(
        `  ${event}: stale dispatcher entry \`${retiredDispatchCommand(event)}\` (runs the SDK of whatever checkout the session is in, and loses every hook in an older one): run \`bun run justin-sdk install\``,
      );
    }
    expect(result.message).not.toContain('missing:');
    expect(result.message).not.toContain('runs twice:');
  });

  test('beside the current entry, every handler on it runs twice: an error', () => {
    const root = project({hooks: {dispatch: true}});
    installHooks(root);
    edit(root, (s) => {
      s.hooks.PostToolBatch?.push({
        hooks: [{command: retiredDispatchCommand('PostToolBatch')}],
      });
    });
    const result = check(root);
    expect(result.severity).toBe('error');
    expect(result.message).toContain(
      `runs twice:\n  PostToolBatch: usage-check runs 2 times (\`${dispatchCommand('PostToolBatch')}\`, \`${retiredDispatchCommand('PostToolBatch')}\`)`,
    );
  });

  test('install repairs it, and the new spelling passes', () => {
    const root = project({hooks: {dispatch: true}});
    installHooks(root);
    edit(root, retire);
    installHooks(root);
    const settings = JSON.parse(
      readFileSync(join(root, '.claude', 'settings.json'), 'utf8'),
    ) as Settings;
    expect(settings.hooks.Stop?.[0]?.hooks[0]?.command).toBe(
      'bun run --cwd "${CLAUDE_PROJECT_DIR:-.}" justin-sdk hook Stop',
    );
    expect(check(root)).toEqual({
      message: 'dispatch: 4 SDK hook entries match what install writes',
      pass: true,
    });
  });
});

describe('what it reports', () => {
  test('a missing entry warns, and the fix names install and the sweep', () => {
    const root = project({hooks: {dispatch: false}});
    installHooks(root);
    edit(root, (s) => {
      delete s.hooks.PostToolUse;
    });
    const result = check(root);
    expect(result.pass).toBe(false);
    expect(result.severity).toBe('warn');
    expect(result.message).toContain(
      'missing:\n  PostToolUse: `bun run justin-sdk thread nudge`',
    );
    expect(result.fix).toContain('bun run justin-sdk install');
    expect(result.fix).toContain(
      'bun run justin-sdk sweep --component install',
    );
  });

  test('dispatch on with a leftover per-handler entry is an error: it runs twice', () => {
    const root = project({hooks: {dispatch: true}});
    installHooks(root);
    edit(root, (s) => {
      s.hooks.Stop?.push({
        hooks: [{command: 'bun run justin-sdk thread stop-check'}],
      });
    });
    const result = check(root);
    expect(result.severity).toBe('error');
    expect(result.message).toContain(
      `runs twice:\n  Stop: thread stop-check runs 2 times (\`bun run justin-sdk thread stop-check\`, \`${dispatchCommand('Stop')}\`)`,
    );
  });

  test('a hand-edited variant beside the dispatcher also runs twice', () => {
    const root = project({hooks: {dispatch: true}});
    installHooks(root);
    edit(root, (s) => {
      s.hooks.UserPromptSubmit?.push({
        hooks: [{command: '/abs/node_modules/.bin/justin-sdk time-check'}],
      });
    });
    expect(check(root).message).toContain(
      'UserPromptSubmit: time-check runs 2 times',
    );
  });

  test('dispatch off with a dispatcher entry left over: every handler on it runs twice', () => {
    const root = project({hooks: {dispatch: false}});
    installHooks(root);
    edit(root, (s) => {
      s.hooks.PostToolBatch?.push({
        hooks: [{command: dispatchCommand('PostToolBatch')}],
      });
    });
    const result = check(root);
    expect(result.severity).toBe('error');
    expect(result.message).toContain('PostToolBatch: usage-check runs 2 times');
  });

  test('a dead dispatcher is an error, with the reason the dry run gave', () => {
    const root = project({hooks: {dispatch: true}});
    installHooks(root);
    const result = check(root, () => ({
      exitCode: 1,
      stdout: JSON.stringify({ok: false, reason: 'no justin-sdk.config.json'}),
    }));
    expect(result.severity).toBe('error');
    expect(result.message).toContain(
      `dead:\n  \`${dispatchCommand('UserPromptSubmit')} --dry-run\` failed (no justin-sdk.config.json)`,
    );
  });

  test('a dispatcher entry no component needs is extra', () => {
    const root = project({
      components: ['time-check-setup'],
      hooks: {dispatch: true},
    });
    installHooks(root);
    edit(root, (s) => {
      s.hooks.PostToolBatch = [
        {hooks: [{command: dispatchCommand('PostToolBatch')}]},
      ];
    });
    const result = check(root);
    expect(result.severity).toBe('warn');
    expect(result.message).toContain('extra:\n');
    // installHooks runs every step, as `install` would not for unlisted
    // components, so Stop and PostToolUse are extra here too.
    expect(result.message).toContain(
      `  PostToolBatch: \`${dispatchCommand('PostToolBatch')}\` runs no handler for this repo's components`,
    );
  });

  test('a dispatcher entry with the wrong matcher is stale', () => {
    const root = project({hooks: {dispatch: true}});
    installHooks(root);
    edit(root, (s) => {
      const entry = s.hooks.PostToolUse?.[0];
      if (entry != null) delete entry.matcher;
    });
    expect(check(root).message).toContain(
      "stale:\n  PostToolUse: the dispatcher entry's matcher is none; install writes Bash",
    );
  });

  test('an unreadable settings.json is UNKNOWN, never "no hooks"', () => {
    const root = project({});
    mkdirSync(join(root, '.claude'), {recursive: true});
    writeFileSync(join(root, '.claude', 'settings.json'), '{not json');
    const result = check(root);
    expect(result.pass).toBe(false);
    expect(String(result.message)).toStartWith('UNKNOWN: could not read');
  });
});
