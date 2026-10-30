/**
 * `thread spawn` (home-base-yukaf.7, D-SPAWN). Directories are real, in a
 * $TMPDIR sandbox; cmux is an injected fake that records every call, so no
 * test reaches the real cmux or opens anything.
 */

import type {CmuxCall} from '../src/thread/cmux';
import type {SpawnOptions} from '../src/thread/spawn';
import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, test} from 'bun:test';
import {execFileSync} from 'child_process';
import {mkdirSync, readFileSync, writeFileSync} from 'fs';
import {join} from 'path';

import {spawnSession} from '../src/thread/spawn';
import {createSandbox} from './sandbox';

const SOCK = '/tmp/spawn-test/cmux.sock';
const TRICKY = `it's "$HOME" and \`date\``;

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

interface World {
  env: Record<string, string | undefined>;
  file: string;
  home: string;
  plain: string;
  root: string;
  tagged: string;
  worktree: string;
}

function world(): World {
  const sb = createSandbox();
  sandboxes.push(sb);
  const root = sb.path;
  const home = join(root, 'home');
  mkdirSync(join(home, 'Dev', 'notes'), {recursive: true});
  const tagged = join(root, 'tagged-repo');
  const worktree = join(tagged, '.claude', 'worktrees', 'wt-one');
  mkdirSync(worktree, {recursive: true});
  writeFileSync(
    join(tagged, 'justin-sdk.config.json'),
    JSON.stringify({projectTag: 'SPWN'}),
  );
  const plain = join(root, 'plain-repo');
  mkdirSync(plain);
  const file = join(root, 'a-file.txt');
  writeFileSync(file, 'not a directory\n');
  const env: Record<string, string | undefined> = {
    CMUX_SOCKET_PATH: SOCK,
    HOME: home,
    JUSTIN_SDK_HEALTH_NOTICES: 'off',
    // home-base-ys9t7.9.1 B3: spawn records the name it set; never in the
    // real ~/.local/state/justin-threads.
    JUSTIN_THREADS_STATE_DIR: join(root, 'state'),
    XDG_CONFIG_HOME: join(root, 'xdg'),
  };
  return {env, file, home, plain, root, tagged, worktree};
}

const NEW_WS = 'DDDDDDDD-0000-4000-8000-00000000000D';

/** A fake cmux: records every call; ping and new-workspace answer as cmux does. */
function fakeCmux(answers: Partial<Record<string, CmuxCall>> = {}) {
  const calls: string[][] = [];
  const run = (args: readonly string[]): Promise<CmuxCall> => {
    calls.push([...args]);
    const preset = answers[args[0] ?? ''];
    if (preset != null) return Promise.resolve(preset);
    if (args.includes('tree')) {
      // The tree read after new-workspace, to find workspace:9's uuid (B3).
      const tree = {
        windows: [
          {
            id: 'W-1',
            ref: 'window:1',
            workspaces: [{id: NEW_WS, panes: [], ref: 'workspace:9'}],
          },
        ],
      };
      return Promise.resolve({kind: 'ok', stdout: JSON.stringify(tree)});
    }
    const stdout = args[0] === 'ping' ? 'PONG\n' : 'OK workspace:9\n';
    return Promise.resolve({kind: 'ok', stdout});
  };
  return {calls, run};
}

function options(w: World, more: Partial<SpawnOptions>): SpawnOptions {
  return {
    cwd: w.root,
    dir: w.tagged,
    dryRun: false,
    env: w.env,
    kickoff: null,
    model: null,
    name: null,
    remoteControl: false,
    ...more,
  };
}

/** The value after `flag` in the new-workspace call. */
function argAfter(call: string[] | undefined, flag: string): string | null {
  if (call == null) return null;
  const at = call.indexOf(flag);
  return at === -1 ? null : (call[at + 1] ?? null);
}

/**
 * Every word zsh parses from `command`, with claude swapped for printf. The
 * leading NAME=value assignments (D8) stay; a command with no claude where
 * expected throws rather than run, so no test ever starts a real claude.
 */
function zshWords(command: string): string[] {
  const leading = /^((?:[A-Z_]+=\S+ )*)claude /u;
  if (!leading.test(command)) {
    throw new Error(`no claude after the assignments in: ${command}`);
  }
  const probe = command.replace(leading, `$1printf '%s\\n' `);
  const printed = execFileSync('zsh', ['-f', '-c', probe], {encoding: 'utf8'});
  return printed.split('\n').slice(0, -1);
}

describe('thread spawn: the workspace name', () => {
  test('defaults to "[TAG] new session <dir name>", the tag from the repo config', async () => {
    const w = world();
    const cmux = fakeCmux();
    const result = await spawnSession(options(w, {}), cmux);
    expect(result.exitCode).toBe(0);
    const made = cmux.calls[1];
    expect(made?.[0]).toBe('new-workspace');
    expect(argAfter(made, '--name')).toBe('[SPWN] new session tagged-repo');
  });

  test('--name replaces the title after the tag', async () => {
    const w = world();
    const cmux = fakeCmux();
    await spawnSession(options(w, {name: '  fix   the inbox '}), cmux);
    expect(argAfter(cmux.calls[1], '--name')).toBe('[SPWN] fix the inbox');
  });

  test('a repo with no projectTag is tagged with its folder name in capitals', async () => {
    const w = world();
    const cmux = fakeCmux();
    await spawnSession(options(w, {dir: w.plain}), cmux);
    expect(argAfter(cmux.calls[1], '--name')).toBe(
      '[PLAIN-REPO] new session plain-repo',
    );
  });

  test('a worktree takes its primary checkout’s tag and its own folder name', async () => {
    const w = world();
    const cmux = fakeCmux();
    await spawnSession(options(w, {dir: w.worktree}), cmux);
    expect(argAfter(cmux.calls[1], '--name')).toBe('[SPWN] new session wt-one');
  });
});

describe('thread spawn: the directory', () => {
  test('--cwd is the absolute directory', async () => {
    const w = world();
    const cmux = fakeCmux();
    await spawnSession(options(w, {}), cmux);
    expect(argAfter(cmux.calls[1], '--cwd')).toBe(w.tagged);
  });

  test('a leading ~ is the home directory', async () => {
    const w = world();
    const cmux = fakeCmux();
    const result = await spawnSession(options(w, {dir: '~/Dev/notes'}), cmux);
    expect(result.exitCode).toBe(0);
    expect(argAfter(cmux.calls[1], '--cwd')).toBe(join(w.home, 'Dev/notes'));
  });

  test('a relative path is read from the current directory', async () => {
    const w = world();
    const cmux = fakeCmux();
    await spawnSession(options(w, {dir: 'plain-repo'}), cmux);
    expect(argAfter(cmux.calls[1], '--cwd')).toBe(w.plain);
  });

  test('the full new-workspace call: name, cwd, command, and no focus switch', async () => {
    const w = world();
    const cmux = fakeCmux();
    await spawnSession(options(w, {}), cmux);
    expect(cmux.calls).toEqual([
      ['ping'],
      [
        'new-workspace',
        '--name',
        '[SPWN] new session tagged-repo',
        '--cwd',
        w.tagged,
        '--command',
        'claude',
        '--focus',
        'false',
      ],
      ['--json', '--id-format', 'both', 'tree', '--all'],
    ]);
  });

  test('home-base-ys9t7.9.1 B3: the name it set is recorded as the tool’s', async () => {
    const w = world();
    const cmux = fakeCmux();
    const result = await spawnSession(options(w, {}), cmux);
    expect(result.exitCode).toBe(0);
    const lines = readFileSync(
      join(w.root, 'state', 'workspace-names.jsonl'),
      'utf8',
    )
      .split('\n')
      .filter((line) => line !== '');
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      expect.objectContaining({
        beadId: '',
        hisName: null,
        nameSet: '[SPWN] new session tagged-repo',
        setBy: 'spawn',
        surfaceId: null,
        workspaceId: NEW_WS,
      }),
    ]);
    expect(result.lines.join('\n')).toContain(
      'its name is recorded as the tool',
    );
  });
});

describe('thread spawn: refusals (exit 2, cmux never called)', () => {
  test('a directory that does not exist', async () => {
    const w = world();
    const cmux = fakeCmux();
    const missing = join(w.root, 'no-such-dir');
    const result = await spawnSession(options(w, {dir: missing}), cmux);
    expect(result.exitCode).toBe(2);
    expect(result.lines.join('\n')).toContain(`${missing} does not exist`);
    expect(cmux.calls).toEqual([]);
  });

  test('a path that is a file, not a directory', async () => {
    const w = world();
    const cmux = fakeCmux();
    const result = await spawnSession(options(w, {dir: w.file}), cmux);
    expect(result.exitCode).toBe(2);
    expect(result.lines.join('\n')).toContain('is not a directory');
    expect(cmux.calls).toEqual([]);
  });

  test('no directory, a blank --name, a blank --model', async () => {
    const w = world();
    const cmux = fakeCmux();
    const cases: Partial<SpawnOptions>[] = [
      {dir: null},
      {dir: '  '},
      {name: '   '},
      {model: ' '},
    ];
    for (const more of cases) {
      const result = await spawnSession(options(w, more), cmux);
      expect(result.exitCode).toBe(2);
    }
    expect(cmux.calls).toEqual([]);
  });

  test('no cmux socket anywhere', async () => {
    const w = world();
    const cmux = fakeCmux();
    const env = {...w.env, CMUX_SOCKET_PATH: undefined};
    const result = await spawnSession(options(w, {env}), cmux);
    expect(result.exitCode).toBe(2);
    expect(result.lines.join('\n')).toContain('cmux cannot be found');
    expect(cmux.calls).toEqual([]);
  });
});

describe('thread spawn: cmux failures', () => {
  test('cmux unreachable: exit 2 with the sandbox hint, and nothing after the ping', async () => {
    const w = world();
    const cmux = fakeCmux({
      ping: {kind: 'failed', reason: 'connect ENOENT /tmp/spawn-test'},
    });
    const result = await spawnSession(options(w, {}), cmux);
    expect(result.exitCode).toBe(2);
    const text = result.lines.join('\n');
    expect(text).toContain('cmux cannot be reached');
    expect(text).toContain(`"allowUnixSockets":["${SOCK}"]`);
    expect(text).toContain('retry with the sandbox disabled');
    expect(cmux.calls).toEqual([['ping']]);
  });

  test('new-workspace fails: exit 1, with what cmux said', async () => {
    const w = world();
    const cmux = fakeCmux({
      'new-workspace': {kind: 'failed', reason: 'cmux new-workspace failed: x'},
    });
    const result = await spawnSession(options(w, {}), cmux);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('cmux new-workspace failed: x');
  });

  test('new-workspace prints something other than OK <ref>: exit 1', async () => {
    const w = world();
    const cmux = fakeCmux({'new-workspace': {kind: 'ok', stdout: 'ERROR\n'}});
    const result = await spawnSession(options(w, {}), cmux);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('cmux printed "ERROR"');
  });
});

describe('thread spawn: the command and --remote-control', () => {
  test('without --remote-control: plain claude, and no phone instructions', async () => {
    const w = world();
    const cmux = fakeCmux();
    const result = await spawnSession(options(w, {}), cmux);
    const command = argAfter(cmux.calls[1], '--command') ?? '';
    expect(command).toBe('claude');
    expect(command).not.toContain('--remote-control');
    expect(result.lines.join('\n')).not.toContain('Connect from your phone');
  });

  test('with --remote-control: claude --remote-control <the workspace name>, and how to connect', async () => {
    const w = world();
    const cmux = fakeCmux();
    const opts = options(w, {remoteControl: true});
    const result = await spawnSession(opts, cmux);
    const command = argAfter(cmux.calls[1], '--command') ?? '';
    expect(zshWords(command)).toEqual([
      '--remote-control',
      '[SPWN] new session tagged-repo',
    ]);
    const text = result.lines.join('\n');
    expect(text).toContain('Connect from your phone');
    expect(text).toContain('tap Code');
    expect(text).toContain('"[SPWN] new session tagged-repo"');
    expect(text).toContain('Workspace id:');
    expect(text).toContain('workspace:9');
  });

  test('zsh receives a name with quotes, $, backticks and an apostrophe, and the model, literally', async () => {
    const w = world();
    const cmux = fakeCmux();
    const opts = options(w, {
      model: 'haiku',
      name: TRICKY,
      remoteControl: true,
    });
    await spawnSession(opts, cmux);
    const name = argAfter(cmux.calls[1], '--name');
    expect(name).toBe(`[SPWN] ${TRICKY}`);
    const command = argAfter(cmux.calls[1], '--command') ?? '';
    expect(zshWords(command)).toEqual([
      '--model',
      'haiku',
      '--remote-control',
      `[SPWN] ${TRICKY}`,
    ]);
  });
});

describe('thread spawn: the parent link in the environment (home-base-ys9t7.5.4 item 3, D8)', () => {
  const PARENT = '3dbc86df-1bf7-4c21-b99f-cef99208bdbd';

  /** The JUSTIN_SDK_ variables the program zsh starts sees, NAME=value. */
  function envSeen(command: string): string[] {
    const leading = /^((?:[A-Z_]+=\S+ )*)claude( |$)/u;
    if (!leading.test(command)) throw new Error(`no claude in: ${command}`);
    const probe = command.replace(/^((?:[A-Z_]+=\S+ )*)claude.*$/su, `$1env`);
    const printed = execFileSync('zsh', ['-f', '-c', probe], {
      encoding: 'utf8',
      env: {PATH: process.env.PATH},
    });
    return printed
      .split('\n')
      .filter((line) => line.startsWith('JUSTIN_SDK_'))
      .sort();
  }

  test('inside a session with a kickoff: claude starts with the parent session and the kickoff marker', async () => {
    const w = world();
    const cmux = fakeCmux();
    const kickoff = '/conductor Work on x-1';
    const env = {...w.env, CLAUDE_CODE_SESSION_ID: PARENT};
    const result = await spawnSession(options(w, {env, kickoff}), cmux);
    expect(result.exitCode).toBe(0);
    const command = argAfter(cmux.calls[1], '--command') ?? '';
    expect(command).toBe(
      `JUSTIN_SDK_SPAWNED_BY_SESSION=${PARENT} JUSTIN_SDK_SPAWN_KICKOFF=1 claude '${kickoff}'`,
    );
    // The kickoff stays claude's prompt, untouched: a slash command still
    // starts with "/".
    expect(zshWords(command)).toEqual([kickoff]);
    expect(envSeen(command)).toEqual([
      `JUSTIN_SDK_SPAWNED_BY_SESSION=${PARENT}`,
      'JUSTIN_SDK_SPAWN_KICKOFF=1',
    ]);
  });

  test('inside a session, no kickoff: the parent only (Justin types the first prompt)', async () => {
    const w = world();
    const cmux = fakeCmux();
    const env = {...w.env, CLAUDE_CODE_SESSION_ID: PARENT};
    await spawnSession(options(w, {env}), cmux);
    const command = argAfter(cmux.calls[1], '--command') ?? '';
    expect(command).toBe(`JUSTIN_SDK_SPAWNED_BY_SESSION=${PARENT} claude`);
    expect(envSeen(command)).toEqual([
      `JUSTIN_SDK_SPAWNED_BY_SESSION=${PARENT}`,
    ]);
  });

  test('outside a session, with a kickoff: the kickoff marker only, so the child is its own unattended group', async () => {
    const w = world();
    const cmux = fakeCmux();
    await spawnSession(options(w, {kickoff: 'go'}), cmux);
    const command = argAfter(cmux.calls[1], '--command') ?? '';
    expect(command).toBe('JUSTIN_SDK_SPAWN_KICKOFF=1 claude go');
    expect(envSeen(command)).toEqual(['JUSTIN_SDK_SPAWN_KICKOFF=1']);
  });
});

describe('thread spawn --dry-run', () => {
  test('prints the name, directory and command, and never touches cmux', async () => {
    const w = world();
    const cmux = fakeCmux();
    const opts = options(w, {dryRun: true, remoteControl: true});
    const result = await spawnSession(opts, cmux);
    expect(result.exitCode).toBe(0);
    expect(cmux.calls).toEqual([]);
    const text = result.lines.join('\n');
    expect(text).toContain('Dry run: nothing opened');
    expect(text).toContain('[SPWN] new session tagged-repo');
    expect(text).toContain(w.tagged);
    expect(text).toContain(
      `claude --remote-control '[SPWN] new session tagged-repo'`,
    );
    expect(text).toContain(SOCK);
  });

  test('a --kickoff becomes claude’s positional prompt, after every flag, and is shown', async () => {
    const w = world();
    const cmux = fakeCmux();
    const kickoff = `/conductor Work on x-1: it's "quoted". Run br show x-1 first.`;
    const opts = options(w, {kickoff, remoteControl: true});
    const result = await spawnSession(opts, cmux);
    expect(result.exitCode).toBe(0);
    const text = result.lines.join('\n');
    expect(text).toContain('Kickoff');
    expect(text).toContain(kickoff);
    const command = argAfter(cmux.calls[1], '--command') ?? '';
    expect(zshWords(command)).toEqual([
      '--remote-control',
      '[SPWN] new session tagged-repo',
      kickoff,
    ]);
  });

  test('refuses an empty --kickoff', async () => {
    const w = world();
    const cmux = fakeCmux();
    const result = await spawnSession(
      options(w, {dryRun: true, kickoff: '   '}),
      cmux,
    );
    expect(result.exitCode).toBe(2);
    expect(result.lines.join('\n')).toContain('--kickoff');
    expect(cmux.calls).toEqual([]);
  });

  test('still refuses a missing directory', async () => {
    const w = world();
    const cmux = fakeCmux();
    const opts = options(w, {dir: join(w.root, 'gone'), dryRun: true});
    const result = await spawnSession(opts, cmux);
    expect(result.exitCode).toBe(2);
    expect(cmux.calls).toEqual([]);
  });
});

describe('thread spawn: the window (home-base-yukaf.14 F8)', () => {
  test('CMUX_WINDOW_ID, when set, is passed as --window and printed', async () => {
    const w = world();
    const cmux = fakeCmux();
    const env = {...w.env, CMUX_WINDOW_ID: 'window:3'};
    const result = await spawnSession(options(w, {env}), cmux);
    expect(result.exitCode).toBe(0);
    expect(argAfter(cmux.calls[1], '--window')).toBe('window:3');
    expect(result.lines.join('\n')).toMatch(/Window:\s+window:3/u);
  });

  test("without it, no --window: the output names cmux's default and the caller's workspace", async () => {
    const w = world();
    const cmux = fakeCmux();
    const env = {...w.env, CMUX_WORKSPACE_ID: 'WS-CALLER'};
    const result = await spawnSession(options(w, {env}), cmux);
    expect(cmux.calls[1]).not.toContain('--window');
    expect(result.lines.join('\n')).toContain(
      "cmux's default: the window of the workspace this runs in (WS-CALLER)",
    );
    // A dry run shows the same in the planned argv.
    const dry = await spawnSession(
      options(w, {dryRun: true, env: {...w.env, CMUX_WINDOW_ID: 'window:7'}}),
      fakeCmux(),
    );
    expect(dry.lines.join('\n')).toContain('"--window","window:7"');
  });
});

describe('thread spawn: a folder Claude Code has not trusted (home-base-yukaf.14 F9)', () => {
  const trustFile = (w: World, projects: Record<string, unknown>): void => {
    writeFileSync(join(w.home, '.claude.json'), JSON.stringify({projects}));
  };
  const WARNING = 'This folder has not been trusted yet';

  test('a trusted folder prints no warning; the file is only read', async () => {
    const w = world();
    trustFile(w, {[w.tagged]: {hasTrustDialogAccepted: true}});
    const before = readFileSync(join(w.home, '.claude.json'), 'utf8');
    const result = await spawnSession(options(w, {}), fakeCmux());
    expect(result.lines.join('\n')).not.toContain(WARNING);
    expect(readFileSync(join(w.home, '.claude.json'), 'utf8')).toBe(before);
  });

  test('an untrusted, unlisted or never-configured folder warns, and the spawn still runs', async () => {
    for (const projects of [
      {DIR: {hasTrustDialogAccepted: false}},
      {DIR: {}},
      {'/somewhere/else': {hasTrustDialogAccepted: true}},
    ]) {
      const w = world();
      trustFile(
        w,
        Object.fromEntries(
          Object.entries(projects).map(([key, value]) => [
            key === 'DIR' ? w.tagged : key,
            value,
          ]),
        ),
      );
      const cmux = fakeCmux();
      const result = await spawnSession(options(w, {}), cmux);
      expect(result.exitCode).toBe(0);
      expect(cmux.calls[1]?.[0]).toBe('new-workspace');
      expect(result.lines.join('\n')).toContain(WARNING);
      expect(result.lines.join('\n')).toContain(
        'a trust prompt you must answer on the Mac',
      );
    }
    // No ~/.claude.json at all: nothing is trusted yet.
    const fresh = world();
    const result = await spawnSession(
      options(fresh, {dryRun: true}),
      fakeCmux(),
    );
    expect(result.lines.join('\n')).toContain(WARNING);
  });

  test('an unreadable ~/.claude.json says it could not check (rule 7), never that it is trusted', async () => {
    const w = world();
    writeFileSync(join(w.home, '.claude.json'), '{not json');
    const result = await spawnSession(options(w, {}), fakeCmux());
    expect(result.lines.join('\n')).toContain(
      'Could not check whether Claude Code trusts this folder',
    );
    // CLAUDE_CONFIG_DIR moves the file, as it does for Claude Code.
    const moved = world();
    mkdirSync(join(moved.root, 'cfg'));
    writeFileSync(
      join(moved.root, 'cfg', '.claude.json'),
      JSON.stringify({
        projects: {[moved.tagged]: {hasTrustDialogAccepted: true}},
      }),
    );
    const env = {...moved.env, CLAUDE_CONFIG_DIR: join(moved.root, 'cfg')};
    const trusted = await spawnSession(options(moved, {env}), fakeCmux());
    expect(trusted.lines.join('\n')).not.toContain(WARNING);
  });
});
