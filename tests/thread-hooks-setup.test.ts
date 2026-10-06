/**
 * `justin-sdk add thread-hooks` — the hook installer (home-base-p1uj.3, extended
 * with the Stop hook by home-base-p1uj.15, the capture hooks by k0b8n.9, and
 * the SessionStart entry RETIRED by home-base-39co9.1).
 *
 * Three properties matter. Exactly one entry per event is appended however
 * often the installer runs, and every hook the repo already had survives it.
 * The hooks are independent, so a repo installed by an older SDK gains only
 * what it lacks. And the retired SessionStart `thread start --hook` entry is
 * taken back out on re-apply ONLY when it is byte-identical to what the SDK
 * wrote (epic home-base-39co9 D3, identity rule F7) — a hand-edited variant is
 * reported and kept.
 *
 * The retirement tests drive `stepThreadHooks` against a real
 * `.claude/settings.json` in a scratch project (the full `runThreadHooksSetup`
 * also runs base-setup, which needs a git remote for the SDK pin and is covered
 * elsewhere). Run unsandboxed, like the rest of the suite.
 *
 * NEGATIVE CONTROLS: recorded on home-base-39co9.1's notes — each with the line
 * broken and the assertion that went red.
 */

import {afterEach, describe, expect, spyOn, test} from 'bun:test';
import {mkdirSync, readFileSync, writeFileSync} from 'fs';
import {join} from 'path';

import {stripAnsi} from '../src/check-runner';
import {
  componentInstalledEvidence,
  componentProvenanceEvidence,
} from '../src/component-manifest';
import {COMPONENT_NAMES, corePreset} from '../src/component-registry';
import {removeComponent, renderOutcome} from '../src/remove';
import {setQuiet} from '../src/setup-helpers';
import {
  addThreadStopHook,
  stepThreadHooks,
  THREAD_CAPTURE_HOOK_COMMAND,
  THREAD_START_HOOK_COMMAND,
  THREAD_START_HOOK_EVENT,
  THREAD_STOP_HOOK_COMMAND,
  THREAD_STOP_HOOK_EVENT,
} from '../src/thread-hooks-setup';
import {createSandbox, type Sandbox} from './sandbox';

function stopEntries(settings: Record<string, unknown>): unknown[] {
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  return (hooks[THREAD_STOP_HOOK_EVENT] as unknown[] | undefined) ?? [];
}

const sandboxes: Sandbox[] = [];
const spies: {mockRestore: () => void}[] = [];
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
  for (const spy of spies.splice(0)) spy.mockRestore();
  setQuiet(false);
});

/** A scratch project with an optional `.claude/settings.json`. */
function project(settings: Record<string, unknown> | null): string {
  const sb = createSandbox();
  sandboxes.push(sb);
  const root = join(sb.path, 'repo');
  mkdirSync(join(root, '.claude'), {recursive: true});
  if (settings != null) {
    writeFileSync(
      join(root, '.claude', 'settings.json'),
      `${JSON.stringify(settings, null, 2)}\n`,
    );
  }
  return root;
}

function readSettings(root: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(root, '.claude', 'settings.json'), 'utf8'),
  ) as Record<string, unknown>;
}

/** Every command under one event, flattened. */
function commandsUnder(
  settings: Record<string, unknown>,
  event: string,
): string[] {
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  const entries = (hooks[event] as unknown[] | undefined) ?? [];
  return entries.flatMap((entry) =>
    ((entry as {hooks?: {command?: string}[]}).hooks ?? []).map(
      (hook) => hook.command ?? '',
    ),
  );
}

/** console.log lines, ANSI stripped. */
function captureStdout(): string[] {
  const lines: string[] = [];
  const spy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(stripAnsi(args.join(' ')));
  });
  spies.push(spy);
  return lines;
}

/** The entry the pre-2026-10-05 installer wrote, exactly. */
const RETIRED_ENTRY = {
  hooks: [{command: THREAD_START_HOOK_COMMAND, type: 'command'}],
  matcher: 'startup|resume',
};

/** base-setup's own SessionStart hook, which must never be touched here. */
const SESSION_START_ENTRY = {
  hooks: [{command: 'bun run justin-sdk session-start', type: 'command'}],
};

describe('the retired SessionStart entry (home-base-39co9 D3)', () => {
  test('the retired command is exactly what the old installer wrote', () => {
    // The identity a re-apply deletes on. If this ever changes, every repo's
    // retired entry stops matching and is reported "modified" instead of
    // removed — safe, but the cleanup silently stops happening.
    expect(THREAD_START_HOOK_COMMAND).toBe(
      'bun run justin-sdk thread start --hook',
    );
    expect(THREAD_START_HOOK_EVENT).toBe('SessionStart');
  });

  test('a FRESH install writes no SessionStart entry — only capture and stop-check', () => {
    const root = project(null);
    expect(stepThreadHooks(root)).toBe(true);

    const settings = readSettings(root);
    const hooks = settings.hooks as Record<string, unknown>;
    expect(hooks).not.toHaveProperty('SessionStart');
    expect(Object.keys(hooks).sort()).toEqual(['Stop', 'UserPromptSubmit']);
    expect(commandsUnder(settings, 'UserPromptSubmit')).toEqual([
      THREAD_CAPTURE_HOOK_COMMAND,
    ]);
    expect(commandsUnder(settings, 'Stop').sort()).toEqual(
      [THREAD_CAPTURE_HOOK_COMMAND, THREAD_STOP_HOOK_COMMAND].sort(),
    );
  });

  test('re-apply over the EXACT retired entry removes it, says so, and keeps base-setup’s hook', () => {
    const root = project({
      hooks: {SessionStart: [SESSION_START_ENTRY, RETIRED_ENTRY]},
    });
    const out = captureStdout();

    expect(stepThreadHooks(root)).toBe(true);

    const settings = readSettings(root);
    expect(commandsUnder(settings, 'SessionStart')).toEqual([
      'bun run justin-sdk session-start',
    ]);
    expect(out).toContain(
      `  removed: .claude/settings.json SessionStart hook (${THREAD_START_HOOK_COMMAND}) — retired; the thread bead is now created on the first prompt (home-base-39co9)`,
    );
    // And the current hooks arrived in the same run.
    expect(commandsUnder(settings, 'UserPromptSubmit')).toEqual([
      THREAD_CAPTURE_HOOK_COMMAND,
    ]);
  });

  test('the retired entry ALONE under SessionStart leaves no empty SessionStart array behind', () => {
    const root = project({hooks: {SessionStart: [RETIRED_ENTRY]}});
    captureStdout();
    stepThreadHooks(root);
    const hooks = readSettings(root).hooks as Record<string, unknown>;
    expect(hooks).not.toHaveProperty('SessionStart');
  });

  test('a foreign command bundled into the same entry survives, in place', () => {
    const root = project({
      hooks: {
        SessionStart: [
          {
            hooks: [
              {command: 'echo hello', type: 'command'},
              {command: THREAD_START_HOOK_COMMAND, type: 'command'},
            ],
            matcher: 'startup|resume',
          },
        ],
      },
    });
    captureStdout();
    stepThreadHooks(root);
    const hooks = readSettings(root).hooks as Record<string, unknown>;
    expect(hooks.SessionStart).toEqual([
      {
        hooks: [{command: 'echo hello', type: 'command'}],
        matcher: 'startup|resume',
      },
    ]);
  });

  test('re-apply over a HAND-EDITED variant leaves it, and reports it as modified', () => {
    const variants = [
      '/Users/jhaa/Dev/home-base/bin/justin-sdk thread start --hook',
      `${THREAD_START_HOOK_COMMAND} && echo mine`,
      'bunx github:justinhaaheim/justin-sdk#v0.38.0 thread start --hook',
    ];
    const root = project({
      hooks: {
        SessionStart: variants.map((command) => ({
          hooks: [{command, type: 'command'}],
          matcher: 'startup',
        })),
      },
    });
    const out = captureStdout();

    expect(stepThreadHooks(root)).toBe(true);

    expect(commandsUnder(readSettings(root), 'SessionStart')).toEqual(variants);
    for (const command of variants) {
      expect(out).toContain(
        `  left in place (modified): .claude/settings.json SessionStart hook (${command}) — not the exact command the SDK wrote, so it is yours to delete; \`thread start --hook\` is inert either way`,
      );
    }
    expect(out.some((line) => line.includes('removed:'))).toBe(false);
  });

  test('the removal line prints even in QUIET mode — how install, update and the sweep run it', () => {
    const root = project({hooks: {SessionStart: [RETIRED_ENTRY]}});
    setQuiet(true);
    const out = captureStdout();
    stepThreadHooks(root);
    expect(
      out.some((line) =>
        line.includes('removed: .claude/settings.json SessionStart hook'),
      ),
    ).toBe(true);
    // The routine "Updated …" lines stay quiet.
    expect(
      out.some((line) => line.includes('Updated .claude/settings.json')),
    ).toBe(false);
  });

  test('a second re-apply is a no-op: nothing removed, nothing written', () => {
    const root = project({hooks: {SessionStart: [RETIRED_ENTRY]}});
    captureStdout();
    stepThreadHooks(root);
    const before = readFileSync(join(root, '.claude', 'settings.json'), 'utf8');
    const out = captureStdout();
    stepThreadHooks(root);
    expect(readFileSync(join(root, '.claude', 'settings.json'), 'utf8')).toBe(
      before,
    );
    expect(out.some((line) => line.includes('removed:'))).toBe(false);
  });

  test('the component still reads as INSTALLED after the retired entry is gone', () => {
    const root = project({hooks: {SessionStart: [RETIRED_ENTRY]}});
    captureStdout();
    stepThreadHooks(root);
    const evidence = componentInstalledEvidence(root, 'thread-hooks');
    expect(evidence.installed).toBe(true);
    if (!evidence.installed) throw new Error('unreachable');
    expect(evidence.because).not.toContain('SessionStart');
  });

  test('the retired entry ALONE is not evidence of an install, of either kind', () => {
    // It proves an OLD install, not that this component is present today — the
    // manifest keeps it in `retiredHooks`, which the evidence checks never read.
    const root = project({hooks: {SessionStart: [RETIRED_ENTRY]}});
    expect(componentInstalledEvidence(root, 'thread-hooks')).toEqual({
      installed: false,
    });
    expect(componentProvenanceEvidence(root, 'thread-hooks')).toEqual({
      kind: 'absent',
    });
  });

  test('`remove thread-hooks` still takes the exact retired entry out, and keeps a variant', () => {
    const variant =
      '/Users/jhaa/Dev/home-base/bin/justin-sdk thread start --hook';
    const root = project({
      hooks: {
        SessionStart: [
          RETIRED_ENTRY,
          {hooks: [{command: variant, type: 'command'}]},
        ],
      },
    });
    const plan = removeComponent(root, 'thread-hooks', {dryRun: true});
    const lines = plan.outcomes.map((outcome) =>
      renderOutcome(outcome, {planned: true}),
    );
    expect(lines).toContain(
      `would remove: .claude/settings.json SessionStart hook (${THREAD_START_HOOK_COMMAND})`,
    );
    expect(lines).toContain(
      `left in place (modified): .claude/settings.json SessionStart hook (${variant})`,
    );
  });
});

describe('addThreadStopHook (home-base-p1uj.15)', () => {
  test('appends exactly ONE Stop entry, with NO matcher', () => {
    const settings: Record<string, unknown> = {};
    expect(addThreadStopHook(settings)).toBe(true);

    const entries = stopEntries(settings);
    expect(entries).toHaveLength(1);
    // Stop has no matcher dimension — one would be silently ignored rather than
    // helpfully restrictive, so the entry must not carry the key at all.
    expect(entries[0]).toEqual({
      hooks: [{command: THREAD_STOP_HOOK_COMMAND, type: 'command'}],
    });
    expect(entries[0]).not.toHaveProperty('matcher');
  });

  test('a re-run changes NOTHING', () => {
    const settings: Record<string, unknown> = {};
    expect(addThreadStopHook(settings)).toBe(true);
    expect(addThreadStopHook(settings)).toBe(false);
    expect(addThreadStopHook(settings)).toBe(false);
    expect(stopEntries(settings)).toHaveLength(1);
  });

  test('a repo with only the old SessionStart entry gains Stop and capture, and loses the retired entry', () => {
    // The upgrade path for every repo that ran `add thread-hooks` before
    // p1uj.15: it has the SessionStart entry and nothing else.
    const root = project({hooks: {SessionStart: [RETIRED_ENTRY]}});
    captureStdout();
    stepThreadHooks(root);
    const settings = readSettings(root);
    expect(commandsUnder(settings, 'SessionStart')).toEqual([]);
    expect(commandsUnder(settings, 'Stop')).toContain(THREAD_STOP_HOOK_COMMAND);
    expect(commandsUnder(settings, 'UserPromptSubmit')).toEqual([
      THREAD_CAPTURE_HOOK_COMMAND,
    ]);
  });

  test('an unrelated Stop hook the repo already had survives', () => {
    const other = {hooks: [{command: 'echo bye', type: 'command'}]};
    const settings: Record<string, unknown> = {hooks: {Stop: [other]}};
    expect(addThreadStopHook(settings)).toBe(true);

    const entries = stopEntries(settings);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual(other);
  });

  test('a hand-edited spelling of the command counts as installed', () => {
    const settings: Record<string, unknown> = {
      hooks: {
        Stop: [
          {
            hooks: [
              {
                command:
                  '/Users/jhaa/Dev/home-base/bin/justin-sdk thread stop-check',
                type: 'command',
              },
            ],
          },
        ],
      },
    };
    expect(addThreadStopHook(settings)).toBe(false);
    expect(stopEntries(settings)).toHaveLength(1);
  });
});

describe('the component registry', () => {
  test('thread-hooks is registered, and is part of core', () => {
    // It was OPT_IN_ONLY until 2026-09-18, on the grounds that its (now
    // retired) SessionStart hook wrote to a shared Dolt database. Justin's call
    // (epic home-base-dchjw D3) is that it belongs in the default install; the
    // hooks stay INERT until componentConfig.thread.enabled is true, which is
    // what actually bounds the cost, and that is a config decision rather than
    // a preset one.
    expect(COMPONENT_NAMES).toContain('thread-hooks');
    expect(corePreset(process.cwd())).toContain('thread-hooks');
  });
});
