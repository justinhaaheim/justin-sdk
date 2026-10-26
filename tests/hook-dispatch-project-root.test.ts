/**
 * The dispatcher entry runs the PROJECT ROOT's SDK, not the SDK of whatever
 * checkout the session is working in (home-base-rtsx1.6).
 *
 * The bug: Claude Code runs a hook in the session's current directory, and the
 * retired entry `bun run justin-sdk hook <Event>` resolved the SDK from there.
 * In a worktree whose own node_modules held an SDK older than `hook`, that SDK
 * printed its help screen and exited 1, and every handler on the event was
 * lost (142 errors in one session, 2026-10-22).
 *
 * This runs the EXACT settings.json string under `sh -c`, as Claude Code does,
 * between two scratch checkouts that each have an executable
 * node_modules/.bin/justin-sdk:
 *  - OLD: a fake SDK that prints a help screen and exits 1. The shell's cwd.
 *  - PROJECT: a bin that runs this SDK's real cli.ts, plus a config.
 *    CLAUDE_PROJECT_DIR, exported as Claude Code exports it.
 * The current spelling must reach the real dispatcher; the retired spelling,
 * run the same way, must hit the fake help screen — the negative control that
 * proves the scratch setup reproduces the bug at all.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {spawnSync} from 'child_process';
import {chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {dirname, join} from 'path';

import {dispatchCommand, retiredDispatchCommand} from '../src/hook-registry';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const FAKE_HELP = 'fake-old-justin-sdk v0.45.1 — Usage: justin-sdk <command>';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, {force: true, recursive: true});
});

/** A scratch checkout: package.json plus an EXECUTABLE node_modules/.bin/justin-sdk. */
function checkout(prefix: string, binScript: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({name: prefix.replace(/-$/, ''), private: true}),
  );
  const binDir = join(dir, 'node_modules', '.bin');
  mkdirSync(binDir, {recursive: true});
  const bin = join(binDir, 'justin-sdk');
  writeFileSync(bin, binScript);
  // `bun run` resolves a .bin entry only when it is executable; without the
  // bit it falls through to PATH (pkg/justin-sdk/CLAUDE.md, Gotchas).
  chmodSync(bin, 0o755);
  return dir;
}

function scratch(): {old: string; project: string} {
  const old = checkout(
    'old-checkout-',
    `#!/bin/sh\necho '${FAKE_HELP}'\nexit 1\n`,
  );
  const project = checkout(
    'project-root-',
    `#!/bin/sh\nexec '${process.execPath}' '${CLI}' "$@"\n`,
  );
  writeFileSync(
    join(project, 'justin-sdk.config.json'),
    JSON.stringify({components: ['thread-hooks-setup']}),
  );
  return {old, project};
}

/** Run one settings.json command string the way Claude Code does: `sh -c`, cwd = where Claude is. */
function runEntry(
  command: string,
  pair: {old: string; project: string},
): {status: number | null; stdout: string} {
  const result = spawnSync('sh', ['-c', `${command} --dry-run`], {
    cwd: pair.old,
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: pair.project,
      JUSTIN_SDK_HEALTH_NOTICES: 'off',
      PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
    },
    input: JSON.stringify({
      cwd: pair.old,
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
    }),
    timeout: 60_000,
  });
  return {status: result.status, stdout: result.stdout ?? ''};
}

describe('the dispatcher entry, from a checkout whose SDK predates `hook`', () => {
  test('runs the project root SDK; the retired spelling hits the old one', () => {
    const pair = scratch();

    const current = runEntry(dispatchCommand('PostToolUse'), pair);
    expect(current.stdout).not.toContain(FAKE_HELP);
    expect(current.status).toBe(0);
    expect(JSON.parse(current.stdout)).toEqual({
      componentSource: 'config',
      event: 'PostToolUse',
      handlers: ['thread nudge'],
      ok: true,
      projectRoot: pair.project,
    });

    // Negative control: the same scratch setup, the retired spelling.
    const retired = runEntry(retiredDispatchCommand('PostToolUse'), pair);
    expect(retired.stdout.trim()).toBe(FAKE_HELP);
    expect(retired.status).toBe(1);
  });
});
