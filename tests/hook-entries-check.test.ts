/**
 * doctor's HOOK_ENTRIES check (home-base-rtsx1.3). Each scenario starts from a
 * repo the REAL installers wrote (both modes), then breaks one thing by hand,
 * so the check is measured against exactly what `install` produces.
 *
 * The dispatcher dry run is injected: a scratch repo has no node_modules, so
 * the real `bun run justin-sdk hook … --dry-run` could only fail there.
 */

import {afterEach, describe, expect, spyOn, test} from 'bun:test';
import {mkdirSync, readFileSync, writeFileSync} from 'fs';
import {join} from 'path';

import {stepClaudeSettings} from '../src/base-setup';
import {hookEntriesCheckResult} from '../src/doctor';
import {type DryRun} from '../src/hook-entries-check';
import {dispatchCommand} from '../src/hook-registry';
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
    const root = project({});
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

describe('what it reports', () => {
  test('a missing entry warns, and the fix names install and the sweep', () => {
    const root = project({});
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
      'runs twice:\n  Stop: thread stop-check runs 2 times (`bun run justin-sdk thread stop-check`, `bun run justin-sdk hook Stop`)',
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
    const root = project({});
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
      'dead:\n  `bun run justin-sdk hook UserPromptSubmit --dry-run` failed (no justin-sdk.config.json)',
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
      "  PostToolBatch: `bun run justin-sdk hook PostToolBatch` runs no handler for this repo's components",
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
