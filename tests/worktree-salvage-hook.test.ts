/**
 * `justin-sdk worktree-salvage hook` and `hook-json` through the real CLI, as
 * Claude Code runs them: a subprocess with the PreToolUse payload on stdin
 * (epic home-base-us739, D9; dispatch 2, home-base-us739.2, AC 3 and AC 4).
 * Each case asserts stdout, stderr and the exit code.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {chmodSync, existsSync, readdirSync, readFileSync} from 'fs';
import {join, resolve} from 'path';

import {USER_LEVEL_SALVAGE_HOOK_COMMAND} from '../src/worktree-salvage/hook';
import {initPrimary, write} from './git-fixtures';
import {createSandbox, type Sandbox} from './sandbox';
import {buildDirtyWorktree} from './worktree-salvage-fixtures';

const CLI = resolve(import.meta.dirname, '..', 'src', 'cli.ts');

const sandboxes: Sandbox[] = [];
function track(): Sandbox {
  const sb = createSandbox();
  sandboxes.push(sb);
  return sb;
}
afterEach(() => {
  while (sandboxes.length > 0) sandboxes.pop()?.cleanup();
});

interface Run {
  code: number;
  stderr: string;
  stdout: string;
}

function run(sb: Sandbox, args: string[], stdin = ''): Run {
  const result = Bun.spawnSync(['bun', CLI, 'worktree-salvage', ...args], {
    cwd: sb.path,
    env: {
      ...process.env,
      NO_COLOR: '1',
      XDG_CONFIG_HOME: join(sb.path, 'config'),
      XDG_DATA_HOME: join(sb.path, 'data'),
    },
    stdin: Buffer.from(stdin),
  });
  return {
    code: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
  };
}

function payload(
  cwd: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): string {
  return JSON.stringify({
    cwd,
    hook_event_name: 'PreToolUse',
    session_id: 'test-session',
    tool_input: toolInput,
    tool_name: toolName,
    transcript_path: '/nonexistent/transcript.jsonl',
  });
}

const REMOVE = {action: 'remove', discard_changes: true};

/** Every save under the fallback data directory, as `<repo>/<worktree>/<stamp>`. */
function savesUnder(sb: Sandbox): string[] {
  const root = join(sb.path, 'data', 'worktree-salvage');
  if (!existsSync(root)) return [];
  return readdirSync(root, {recursive: true, withFileTypes: false})
    .map(String)
    .filter((path) => path.split('/').length === 3);
}

describe('worktree-salvage hook: payloads it ignores (D9)', () => {
  const ignored: [string, string, Record<string, unknown>][] = [
    [
      'a tool that is not ExitWorktree, even with a remove-shaped input',
      'Bash',
      {action: 'remove', command: 'rm -rf x', discard_changes: true},
    ],
    [
      'ExitWorktree keep, even with discard_changes',
      'ExitWorktree',
      {action: 'keep', discard_changes: true},
    ],
    [
      'ExitWorktree remove without discard_changes',
      'ExitWorktree',
      {action: 'remove'},
    ],
    [
      'ExitWorktree remove with discard_changes false',
      'ExitWorktree',
      {action: 'remove', discard_changes: false},
    ],
  ];
  for (const [name, tool, input] of ignored) {
    test(`${name}: exit 0, no output, nothing saved`, () => {
      const sb = track();
      const {worktree} = buildDirtyWorktree(sb);
      const result = run(sb, ['hook'], payload(worktree, tool, input));
      expect(result).toEqual({code: 0, stderr: '', stdout: ''});
      expect(savesUnder(sb)).toEqual([]);
    });
  }

  test('a clean checkout: exit 0, no output, nothing saved', () => {
    const sb = track();
    const clean = initPrimary(sb, {'a.txt': 'committed\n'});
    const result = run(sb, ['hook'], payload(clean, 'ExitWorktree', REMOVE));
    expect(result).toEqual({code: 0, stderr: '', stdout: ''});
    expect(savesUnder(sb)).toEqual([]);
  });

  test('F1: a checkout holding only ignored content: exit 0, nothing saved, and a systemMessage naming each ignored path', () => {
    const sb = track();
    const checkout = initPrimary(sb, {
      '.gitignore': 'tmp/\n',
      'a.txt': 'committed\n',
    });
    write(checkout, 'tmp/mail.txt', 'personal mail\n');
    const result = run(sb, ['hook'], payload(checkout, 'ExitWorktree', REMOVE));
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(Object.keys(json)).toEqual(['systemMessage']);
    const message = String(json.systemMessage);
    expect(message).toContain('it has no modified or untracked files');
    expect(message).toContain(
      'NOT saved (ignored by git): tmp/ (14 bytes, 1 file)',
    );
    expect(message).toContain('worktree-salvage save --ignored');
    expect(savesUnder(sb)).toEqual([]);
  });
});

describe('worktree-salvage hook: a dirty worktree being removed (D9)', () => {
  test('saves it, exits 0 and prints only a systemMessage naming the save', () => {
    const sb = track();
    const {worktree} = buildDirtyWorktree(sb);
    const result = run(sb, ['hook'], payload(worktree, 'ExitWorktree', REMOVE));
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(Object.keys(json)).toEqual(['systemMessage']);
    const saves = savesUnder(sb);
    expect(saves).toHaveLength(1);
    const message = String(json.systemMessage);
    expect(message).toContain(
      join(sb.path, 'data', 'worktree-salvage', saves[0] ?? ''),
    );
    expect(message).toContain(
      'files: 10 files copied, 2 deletions recorded, 3 index-only versions',
    );
    expect(message).toContain('NOT BACKED UP');
    expect(message).toContain('NOT saved (ignored by git): tmp/');
    expect(
      existsSync(
        join(
          sb.path,
          'data',
          'worktree-salvage',
          saves[0] ?? '',
          'manifest.json',
        ),
      ),
    ).toBe(true);
  });

  test('--help prints help and saves nothing, even with a remove payload on stdin', () => {
    const sb = track();
    const {worktree} = buildDirtyWorktree(sb);
    const result = run(
      sb,
      ['hook', '--help'],
      payload(worktree, 'ExitWorktree', REMOVE),
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('discard_changes');
    expect(savesUnder(sb)).toEqual([]);
  });
});

describe('worktree-salvage hook: blocking (exit 2, reason on stderr)', () => {
  test('a save that fails blocks ExitWorktree', () => {
    const sb = track();
    sb.mkdir('plain');
    const result = run(
      sb,
      ['hook'],
      payload(join(sb.path, 'plain'), 'ExitWorktree', REMOVE),
    );
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ExitWorktree was BLOCKED');
    expect(result.stderr).toContain('is not inside a git checkout');
  });

  test('a broken config blocks, and never falls back to the data directory', () => {
    const sb = track();
    const {worktree} = buildDirtyWorktree(sb);
    sb.writeFile('config/worktree-salvage/config.json', 'not json');
    const result = run(sb, ['hook'], payload(worktree, 'ExitWorktree', REMOVE));
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(
      'the save destination could not be resolved',
    );
    expect(savesUnder(sb)).toEqual([]);
  });

  test('a payload that is not JSON blocks', () => {
    const sb = track();
    const result = run(sb, ['hook'], 'not json');
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('is not JSON');
  });

  test('a remove payload with no cwd blocks', () => {
    const sb = track();
    const result = run(
      sb,
      ['hook'],
      JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_input: REMOVE,
        tool_name: 'ExitWorktree',
      }),
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('has no cwd');
  });
});

type HookJsonForm = {
  file: string;
  settings: {
    hooks: {
      PreToolUse: {
        hooks: {command: string; type: string}[];
        matcher: string;
      }[];
    };
  };
};

/** Run `hook-json` through the CLI and parse what it prints. */
function hookJson(sb: Sandbox): {
  project: HookJsonForm;
  userLevel: HookJsonForm;
} {
  const result = run(sb, ['hook-json']);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout) as {
    project: HookJsonForm;
    userLevel: HookJsonForm;
  };
}

/** The one hook of a form, after checking it is the only PreToolUse entry. */
function onlyHook(form: HookJsonForm): {command: string; type: string} {
  expect(form.settings.hooks.PreToolUse).toHaveLength(1);
  const [entry] = form.settings.hooks.PreToolUse;
  expect(entry?.matcher).toBe('ExitWorktree');
  expect(entry?.hooks).toHaveLength(1);
  const hook = entry?.hooks[0];
  if (hook == null) throw new Error('hook-json printed no hook');
  return hook;
}

describe('worktree-salvage hook-json (AC 4)', () => {
  test('prints both settings forms as JSON; the user-level command is the fail-closed line with no enrolled-repo test', () => {
    const sb = track();
    const parsed = hookJson(sb);
    expect(onlyHook(parsed.project)).toEqual({
      command: 'bun run justin-sdk worktree-salvage hook',
      type: 'command',
    });
    const userLevel = onlyHook(parsed.userLevel);
    expect(userLevel).toEqual({
      command: USER_LEVEL_SALVAGE_HOOK_COMMAND,
      type: 'command',
    });
    expect(userLevel.command).not.toContain('justin-sdk.config.json');
    expect(userLevel.command).toContain('exit 2');
    expect(
      userLevel.command.endsWith('; justin-sdk-latest worktree-salvage hook'),
    ).toBe(true);
    expect(parsed.project.file).toBe('.claude/settings.json');
    expect(parsed.userLevel.file).toBe('~/.claude/settings.json');
  });
});

/** A PATH with the system tools and no justin-sdk-latest. */
const SYSTEM_PATH = '/usr/bin:/bin';

/**
 * Run a hook command string the way Claude Code does: under `sh -c`, with the
 * payload on stdin, in the project directory.
 */
function runSh(
  command: string,
  options: {path: string; projectDir: string; stdin: string},
): Run {
  const result = Bun.spawnSync(['/bin/sh', '-c', command], {
    cwd: options.projectDir,
    env: {CLAUDE_PROJECT_DIR: options.projectDir, PATH: options.path},
    stdin: Buffer.from(options.stdin),
  });
  return {
    code: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
  };
}

/** A project directory under the sandbox, enrolled (a justin-sdk.config.json) or not. */
function projectDir(sb: Sandbox, enrolled: boolean): string {
  const dir = join(sb.path, enrolled ? 'enrolled' : 'unenrolled');
  sb.mkdir(enrolled ? 'enrolled' : 'unenrolled');
  if (enrolled) sb.writeFile('enrolled/justin-sdk.config.json', '{}\n');
  return dir;
}

/**
 * A fake justin-sdk-latest in `<sandbox>/fake-bin` that writes its argv (one
 * per line) and its stdin to files, then exits `exitCode`.
 */
function fakeLauncher(
  sb: Sandbox,
  exitCode: number,
): {argvFile: string; binDir: string; stdinFile: string} {
  const binDir = join(sb.path, 'fake-bin');
  const argvFile = join(sb.path, 'launcher-argv.txt');
  const stdinFile = join(sb.path, 'launcher-stdin.txt');
  sb.writeFile(
    'fake-bin/justin-sdk-latest',
    `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvFile}'\ncat > '${stdinFile}'\nexit ${exitCode}\n`,
  );
  chmodSync(join(binDir, 'justin-sdk-latest'), 0o755);
  return {argvFile, binDir, stdinFile};
}

describe('worktree-salvage hook-json: the printed user-level command under sh (home-base-us739.8)', () => {
  test('the system PATH used below really holds no justin-sdk-latest', () => {
    for (const dir of SYSTEM_PATH.split(':')) {
      expect(existsSync(join(dir, 'justin-sdk-latest'))).toBe(false);
    }
  });

  for (const enrolled of [false, true]) {
    test(`AC 1: no justin-sdk-latest on PATH, ${enrolled ? 'enrolled' : 'unenrolled'} repo: exit 2, one stderr line naming justin-sdk-latest`, () => {
      const sb = track();
      const command = onlyHook(hookJson(sb).userLevel).command;
      const dir = projectDir(sb, enrolled);
      const result = runSh(command, {
        path: SYSTEM_PATH,
        projectDir: dir,
        stdin: payload(dir, 'ExitWorktree', REMOVE),
      });
      expect(result).toEqual({
        code: 2,
        stderr:
          'worktree-salvage hook: ExitWorktree was BLOCKED so the worktree is not removed unsaved: justin-sdk-latest is not on PATH\n',
        stdout: '',
      });
    });
  }

  test('AC 2: a justin-sdk-latest on PATH is invoked with `worktree-salvage hook` and the payload, even in an enrolled repo', () => {
    const sb = track();
    const command = onlyHook(hookJson(sb).userLevel).command;
    const dir = projectDir(sb, true);
    const launcher = fakeLauncher(sb, 0);
    const stdin = payload(dir, 'ExitWorktree', REMOVE);
    const result = runSh(command, {
      path: `${launcher.binDir}:${SYSTEM_PATH}`,
      projectDir: dir,
      stdin,
    });
    expect(result).toEqual({code: 0, stderr: '', stdout: ''});
    expect(existsSync(launcher.argvFile)).toBe(true);
    expect(readFileSync(launcher.argvFile, 'utf8')).toBe(
      'worktree-salvage\nhook\n',
    );
    expect(readFileSync(launcher.stdinFile, 'utf8')).toBe(stdin);
  });

  test("the hook's own exit 2 comes through the line, so its block still blocks", () => {
    const sb = track();
    const command = onlyHook(hookJson(sb).userLevel).command;
    const dir = projectDir(sb, true);
    const launcher = fakeLauncher(sb, 2);
    const result = runSh(command, {
      path: `${launcher.binDir}:${SYSTEM_PATH}`,
      projectDir: dir,
      stdin: payload(dir, 'ExitWorktree', REMOVE),
    });
    expect(result.code).toBe(2);
    expect(readFileSync(launcher.argvFile, 'utf8')).toBe(
      'worktree-salvage\nhook\n',
    );
  });
});
