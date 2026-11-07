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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import {basename, dirname, join} from 'path';

import {DEFAULT_COMPONENT_CONFIG, renderConfigSchema} from '../src/sdk-config';
import {resolveThreadConfig} from '../src/thread/config';
import {SPAWN_DEFAULTS} from '../src/thread/defaults';
import {
  TYPED_COMMAND_BYTE_LIMIT,
  typedCommandBytes,
  typedCommandTooLong,
} from '../src/thread/respawn';
import {
  spawnKickoffPath,
  spawnSession,
  writeKickoffFile,
} from '../src/thread/spawn';
import {resolveSpawnConfig} from '../src/thread/spawn-knob';
import {createSandbox} from './sandbox';

const SOCK = '/tmp/spawn-test/cmux.sock';
const TRICKY = `it's "$HOME" and \`date\``;

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

/** A config file body that sets componentConfig.thread.spawn.allowed. */
function spawnConfig(allowed: unknown): Record<string, unknown> {
  return {componentConfig: {thread: {spawn: {allowed}}}};
}

interface World {
  env: Record<string, string | undefined>;
  file: string;
  home: string;
  plain: string;
  root: string;
  tagged: string;
  worktree: string;
}

/**
 * home-base-11ya7.9: `spawnAllowed` writes componentConfig.thread.spawn.allowed
 * into the USER file (default true, so every test outside the access block
 * runs where spawning is allowed); null writes no user file at all.
 */
function world(setup: {spawnAllowed?: boolean | null} = {}): World {
  const sb = createSandbox();
  sandboxes.push(sb);
  const root = sb.path;
  const spawnAllowed =
    setup.spawnAllowed === undefined ? true : setup.spawnAllowed;
  if (spawnAllowed != null) {
    mkdirSync(join(root, 'xdg', 'justin-sdk'), {recursive: true});
    writeFileSync(
      join(root, 'xdg', 'justin-sdk', 'config.json'),
      JSON.stringify(spawnConfig(spawnAllowed)),
    );
  }
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
 * The kickoff file a typed command reads back as claude's prompt
 * (home-base-8vywn), or null when it reads none. Test paths need no quoting.
 */
function kickoffFileOf(command: string): string | null {
  return /"\$\(command cat -- (\S+)\)"$/u.exec(command)?.[1] ?? null;
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

describe('thread spawn: who may run it (home-base-11ya7.9)', () => {
  const KNOB = 'componentConfig.thread.spawn.allowed';

  /** Write the project file at the directory spawn runs from (w.root). */
  function projectFile(w: World, body: Record<string, unknown>): void {
    writeFileSync(join(w.root, 'justin-sdk.config.json'), JSON.stringify(body));
  }

  test('the default is false: no config anywhere resolves to off, from the default', () => {
    const w = world({spawnAllowed: null});
    const config = resolveThreadConfig({cwd: w.root, env: w.env});
    expect(config.problems).toEqual([]);
    expect(config.spawn).toEqual({allowed: false, allowedSource: 'default'});
    expect(SPAWN_DEFAULTS.allowed).toBe(false);
    expect(DEFAULT_COMPONENT_CONFIG.thread.spawn).toBe(SPAWN_DEFAULTS);
  });

  test('knob off: a real run refuses with exit 2, never reaches cmux, and says what to do instead', async () => {
    const w = world({spawnAllowed: null});
    const cmux = fakeCmux();
    const result = await spawnSession(options(w, {kickoff: 'go'}), cmux);
    expect(result.exitCode).toBe(2);
    expect(cmux.calls).toEqual([]);
    const text = result.lines.join('\n');
    expect(text).toContain(
      `thread spawn: refused: ${KNOB} is not set (default false) for ${w.root}. Nothing was opened.`,
    );
    expect(text).toContain(
      'Only the home-base mayor starts sessions in other projects. Here, file the work as a bead and tell Justin in your report.',
    );
    expect(text).toContain('do not retry from another directory');
    expect(text).not.toContain('Config problems');
  });

  test('knob off: --dry-run refuses the same way and prints no plan', async () => {
    const w = world({spawnAllowed: null});
    const cmux = fakeCmux();
    const result = await spawnSession(options(w, {dryRun: true}), cmux);
    expect(result.exitCode).toBe(2);
    expect(cmux.calls).toEqual([]);
    const text = result.lines.join('\n');
    expect(text).toContain(`thread spawn: refused: ${KNOB}`);
    expect(text).not.toContain('Dry run');
    expect(text).not.toContain('cmux argv');
  });

  test('knob off: it refuses before any other check, so a missing directory gets the knob refusal', async () => {
    const w = world({spawnAllowed: null});
    const missing = join(w.root, 'no-such-dir');
    const result = await spawnSession(
      options(w, {dir: missing, dryRun: true}),
      fakeCmux(),
    );
    expect(result.exitCode).toBe(2);
    expect(result.lines.join('\n')).toContain(KNOB);
    expect(result.lines.join('\n')).not.toContain('does not exist');
  });

  test('knob on in the project file: a dry run and a real run both go ahead', async () => {
    const w = world({spawnAllowed: null});
    projectFile(w, spawnConfig(true));
    expect(resolveThreadConfig({cwd: w.root, env: w.env}).spawn).toEqual({
      allowed: true,
      allowedSource: 'project',
    });
    const dry = await spawnSession(options(w, {dryRun: true}), fakeCmux());
    expect(dry.exitCode).toBe(0);
    expect(dry.lines.join('\n')).toContain('Dry run: nothing opened');
    const cmux = fakeCmux();
    const real = await spawnSession(options(w, {}), cmux);
    expect(real.exitCode).toBe(0);
    expect(cmux.calls.map((args) => args[0])).toEqual([
      'ping',
      'new-workspace',
      '--json',
    ]);
  });

  test('the project file overrides the user file, both ways', async () => {
    // The user file alone decides when the project file says nothing.
    const userOnly = world({spawnAllowed: true});
    expect(
      resolveThreadConfig({cwd: userOnly.root, env: userOnly.env}).spawn,
    ).toEqual({allowed: true, allowedSource: 'user'});

    // User true, project false: refused, and the refusal names the project.
    const off = world({spawnAllowed: true});
    projectFile(off, spawnConfig(false));
    expect(resolveThreadConfig({cwd: off.root, env: off.env}).spawn).toEqual({
      allowed: false,
      allowedSource: 'project',
    });
    const cmux = fakeCmux();
    const refused = await spawnSession(options(off, {}), cmux);
    expect(refused.exitCode).toBe(2);
    expect(refused.lines.join('\n')).toContain(
      `${KNOB} is false in the project config for ${off.root}`,
    );
    expect(cmux.calls).toEqual([]);

    // User false, project true: allowed.
    const on = world({spawnAllowed: false});
    projectFile(on, spawnConfig(true));
    expect(resolveThreadConfig({cwd: on.root, env: on.env}).spawn).toEqual({
      allowed: true,
      allowedSource: 'project',
    });
    const allowed = await spawnSession(options(on, {dryRun: true}), fakeCmux());
    expect(allowed.exitCode).toBe(0);
  });

  test('a value that is not true or false is named in the refusal, and the knob stays off', async () => {
    const w = world({spawnAllowed: null});
    projectFile(w, spawnConfig('yes'));
    const result = await spawnSession(options(w, {dryRun: true}), fakeCmux());
    expect(result.exitCode).toBe(2);
    const text = result.lines.join('\n');
    expect(text).toContain('Config problems:');
    expect(text).toContain(`- ${w.root}`);
    expect(text).toContain('componentConfig.thread.spawn.allowed');
  });

  test('the field walk names and skips a value zod never saw (second line)', () => {
    const problems: string[] = [];
    const spawn = resolveSpawnConfig(
      [
        {name: 'user', section: {allowed: true}},
        {name: 'project', section: {allowed: 'yes'}},
      ],
      problems,
    );
    expect(spawn).toEqual({allowed: true, allowedSource: 'user'});
    expect(problems).toEqual([
      'componentConfig.thread.spawn.allowed in the project config is "yes", which is not true or false — ignoring it and using true.',
    ]);
    const notObject: string[] = [];
    expect(
      resolveSpawnConfig([{name: 'project', section: true}], notObject),
    ).toEqual({allowed: false, allowedSource: 'default'});
    expect(notObject).toEqual([
      'componentConfig.thread.spawn in the project config is true, which is not an object — ignoring it.',
    ]);
  });

  test('`config schema` prints the knob with its default and a description', () => {
    const w = world({spawnAllowed: null});
    const line = renderConfigSchema({env: w.env, projectRoot: w.root})
      .split('\n')
      .find((entry) => entry.trimStart().startsWith(`${KNOB} `));
    expect(line).toBeDefined();
    expect(line).toContain('default false');
    // A description follows the last ` · `.
    expect((line ?? '').split('  ·  ').length).toBeGreaterThan(1);
  });
});

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
        `claude --name '[SPWN] new session tagged-repo'`,
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
      ping: {
        kind: 'failed',
        reason: 'connect ENOENT /tmp/spawn-test',
        timedOut: false,
      },
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
      'new-workspace': {
        kind: 'failed',
        reason: 'cmux new-workspace failed: x',
        timedOut: false,
      },
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
    expect(command).toBe(`claude --name '[SPWN] new session tagged-repo'`);
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
      '--name',
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
      '--name',
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
    // home-base-8vywn: the kickoff is read from its file, never typed; with
    // no XDG_STATE_HOME the file is under HOME's .local/state.
    const file = kickoffFileOf(command) ?? '';
    expect(file.startsWith(join(w.home, '.local', 'state', 'justin-sdk'))).toBe(
      true,
    );
    expect(command).toBe(
      `JUSTIN_SDK_SPAWNED_BY_SESSION=${PARENT} JUSTIN_SDK_SPAWN_KICKOFF=1 claude --name '[SPWN] new session tagged-repo' "$(command cat -- ${file})"`,
    );
    // The kickoff stays claude's prompt, untouched: a slash command still
    // starts with "/".
    expect(zshWords(command)).toEqual([
      '--name',
      '[SPWN] new session tagged-repo',
      kickoff,
    ]);
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
    expect(command).toBe(
      `JUSTIN_SDK_SPAWNED_BY_SESSION=${PARENT} claude --name '[SPWN] new session tagged-repo'`,
    );
    expect(envSeen(command)).toEqual([
      `JUSTIN_SDK_SPAWNED_BY_SESSION=${PARENT}`,
    ]);
  });

  test('outside a session, with a kickoff: the kickoff marker only, so the child is its own unattended group', async () => {
    const w = world();
    const cmux = fakeCmux();
    await spawnSession(options(w, {kickoff: 'go'}), cmux);
    const command = argAfter(cmux.calls[1], '--command') ?? '';
    const file = kickoffFileOf(command) ?? '';
    expect(command).toBe(
      `JUSTIN_SDK_SPAWN_KICKOFF=1 claude --name '[SPWN] new session tagged-repo' "$(command cat -- ${file})"`,
    );
    expect(zshWords(command)).toEqual([
      '--name',
      '[SPWN] new session tagged-repo',
      'go',
    ]);
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
      '--name',
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

describe('thread spawn: the kickoff goes through a file, never the typed line (home-base-8vywn)', () => {
  const PARENT = '3dbc86df-1bf7-4c21-b99f-cef99208bdbd';
  const NOW = new Date('2026-11-03T21:04:05.678Z');

  /**
   * At least 3,000 bytes holding everything a shell or a typed line could
   * mangle: newlines (one blank line, one CRLF), double quotes, apostrophes,
   * backticks, $ and $( ), history !, backslashes, %, a tab, and multibyte
   * characters. It starts and ends with a word, as a trimmed kickoff does.
   */
  function longKickoff(): string {
    const line = `it's "quoted", \`date\`, $HOME, $(whoami), !!, a \\n backslash, 'single', 100%s, é, 🎵 and a tab\there.`;
    const lines = ['/conductor Work on x-1.', '', 'Line one.\r'];
    for (let i = 0; Buffer.byteLength(lines.join('\n')) < 3000; i += 1) {
      lines.push(`${i}: ${line}`);
    }
    lines.push('End.');
    return lines.join('\n');
  }

  /** The value printed after "<label>:" (fields are padded to align). */
  function fieldValue(lines: readonly string[], label: string): string | null {
    const prefix = `${label}:`;
    for (const block of lines) {
      for (const raw of block.split('\n')) {
        const line = raw.trim();
        if (line.startsWith(prefix)) return line.slice(prefix.length).trim();
      }
    }
    return null;
  }

  function stateWorld() {
    const w = world();
    const xdgState = join(w.root, 'xdg-state');
    const env = {...w.env, CLAUDE_CODE_SESSION_ID: PARENT};
    return {env: {...env, XDG_STATE_HOME: xdgState}, w, xdgState};
  }

  test('a 3,000-byte kickoff: the typed command stays under the limit, and the file under XDG_STATE_HOME holds the kickoff byte for byte', async () => {
    const kickoff = longKickoff();
    expect(Buffer.byteLength(kickoff)).toBeGreaterThanOrEqual(3000);
    const {env, w, xdgState} = stateWorld();
    const cmux = fakeCmux();
    const opts = options(w, {
      env,
      kickoff,
      model: 'claude-opus-5-5',
      now: NOW,
      remoteControl: true,
    });
    const result = await spawnSession(opts, cmux);
    expect(result.exitCode).toBe(0);
    const command = argAfter(cmux.calls[1], '--command') ?? '';
    expect(typedCommandBytes(command)).toBeLessThan(TYPED_COMMAND_BYTE_LIMIT);
    expect(command).not.toContain('Work on x-1');
    const file = kickoffFileOf(command) ?? '';
    const dir = join(xdgState, 'justin-sdk', 'spawn-kickoffs');
    expect(dirname(file)).toBe(dir);
    expect(basename(file)).toMatch(/^20261103T210405Z-[0-9a-f]{8}\.md$/u);
    expect(readFileSync(file)).toEqual(Buffer.from(kickoff, 'utf8'));
    expect(fieldValue(result.lines, 'Kickoff file')).toBe(file);
    expect(fieldValue(result.lines, 'Command size')).toBe(
      `${typedCommandBytes(command)} bytes typed (1000 or more is refused)`,
    );
  });

  test('zsh runs the exact typed command, and claude receives the kickoff byte for byte', async () => {
    const kickoff = longKickoff();
    const {env, w} = stateWorld();
    const cmux = fakeCmux();
    const opts = options(w, {
      env,
      kickoff,
      model: 'haiku',
      remoteControl: true,
    });
    expect((await spawnSession(opts, cmux)).exitCode).toBe(0);
    const command = argAfter(cmux.calls[1], '--command') ?? '';
    // Only the stub can run: claude is the first word after the assignments,
    // and PATH holds the stub's directory and the system's, nothing else.
    expect(command).toMatch(/^(?:[A-Z_]+=\S+ )*claude /u);
    const bin = join(w.root, 'stub-bin');
    mkdirSync(bin);
    const out = join(w.root, 'stub-out');
    const stub = join(bin, 'claude');
    writeFileSync(
      stub,
      [
        '#!/bin/sh',
        '# Stands in for claude: records argc, the last argument, and the JUSTIN_SDK_ variables.',
        'printf "%s" "$#" > "$STUB_OUT.argc"',
        'for last in "$@"; do :; done',
        'printf "%s" "$last" > "$STUB_OUT.prompt"',
        'env | grep "^JUSTIN_SDK_" | sort > "$STUB_OUT.env"',
        '',
      ].join('\n'),
    );
    chmodSync(stub, 0o755);
    execFileSync('zsh', ['-f', '-c', command], {
      cwd: w.root,
      env: {HOME: w.home, PATH: `${bin}:/usr/bin:/bin`, STUB_OUT: out},
    });
    expect(readFileSync(`${out}.prompt`)).toEqual(Buffer.from(kickoff, 'utf8'));
    // --model haiku --remote-control <name> --name <name> <prompt>
    expect(readFileSync(`${out}.argc`, 'utf8')).toBe('7');
    expect(readFileSync(`${out}.env`, 'utf8')).toBe(
      `JUSTIN_SDK_SPAWNED_BY_SESSION=${PARENT}\nJUSTIN_SDK_SPAWN_KICKOFF=1\n`,
    );
  });

  test('a command that would still reach the limit is refused with exit 2: no cmux call, no file, dry run too', async () => {
    for (const dryRun of [false, true]) {
      const {env, w, xdgState} = stateWorld();
      const cmux = fakeCmux();
      const model = 'm'.repeat(TYPED_COMMAND_BYTE_LIMIT);
      const opts = options(w, {dryRun, env, kickoff: 'go', model});
      const result = await spawnSession(opts, cmux);
      expect(result.exitCode).toBe(2);
      const text = result.lines.join('\n');
      expect(text).toContain('thread spawn: refused:');
      expect(text).toContain('Nothing was written or opened');
      expect(cmux.calls).toEqual([]);
      expect(existsSync(join(xdgState, 'justin-sdk'))).toBe(false);
    }
  });

  test('the limit is exact: 999 typed bytes open, 1,000 are refused', async () => {
    // No kickoff and no parent session: the command is `claude --model <m> --name
    // <name>`, the model plus the rest.
    const at = async (bytes: number) => {
      const w = world();
      const cmux = fakeCmux();
      const rest = `claude --model  --name '[SPWN] new session tagged-repo'`;
      const model = 'm'.repeat(bytes - rest.length);
      const result = await spawnSession(options(w, {model}), cmux);
      const command = argAfter(cmux.calls[1], '--command');
      return {command, exitCode: result.exitCode};
    };
    const under = await at(TYPED_COMMAND_BYTE_LIMIT - 1);
    expect(under.exitCode).toBe(0);
    expect(typedCommandBytes(under.command ?? '')).toBe(999);
    const over = await at(TYPED_COMMAND_BYTE_LIMIT);
    expect(over.exitCode).toBe(2);
    expect(over.command).toBeNull();
    // Bytes, not characters: 500 two-byte characters are 1,000 bytes.
    expect(typedCommandTooLong('é'.repeat(500))).toContain('1000 bytes');
    expect(typedCommandTooLong(`${'é'.repeat(499)}a`)).toBeNull();
  });

  test('--dry-run prints the kickoff file and the typed size, and writes nothing', async () => {
    const {env, w, xdgState} = stateWorld();
    const cmux = fakeCmux();
    const opts = options(w, {dryRun: true, env, kickoff: longKickoff()});
    const result = await spawnSession(opts, cmux);
    expect(result.exitCode).toBe(0);
    expect(cmux.calls).toEqual([]);
    const command = fieldValue(result.lines, 'Command') ?? '';
    const file = kickoffFileOf(command) ?? '';
    expect(dirname(file)).toBe(join(xdgState, 'justin-sdk', 'spawn-kickoffs'));
    expect(fieldValue(result.lines, 'Kickoff file')).toBe(
      `${file} (not written: dry run)`,
    );
    expect(fieldValue(result.lines, 'Command size')).toBe(
      `${typedCommandBytes(command)} bytes typed (1000 or more is refused)`,
    );
    expect(existsSync(join(xdgState, 'justin-sdk'))).toBe(false);
  });

  test('cmux unreachable: the kickoff file is not written (the sandboxed first try leaves no file)', async () => {
    const {env, w, xdgState} = stateWorld();
    const cmux = fakeCmux({
      ping: {kind: 'failed', reason: 'EPERM', timedOut: false},
    });
    const result = await spawnSession(options(w, {env, kickoff: 'go'}), cmux);
    expect(result.exitCode).toBe(2);
    expect(result.lines.join('\n')).toContain('cmux cannot be reached');
    expect(existsSync(join(xdgState, 'justin-sdk'))).toBe(false);
  });

  test('a kickoff file that cannot be written: exit 2, and no workspace is opened', async () => {
    const {env, w, xdgState} = stateWorld();
    // A FILE where the state directory should be: mkdir under it fails.
    writeFileSync(xdgState, 'not a directory\n');
    const cmux = fakeCmux();
    const result = await spawnSession(options(w, {env, kickoff: 'go'}), cmux);
    expect(result.exitCode).toBe(2);
    expect(result.lines.join('\n')).toContain('could not be written');
    expect(cmux.calls).toEqual([['ping']]);
  });

  test('a kickoff holding a NUL byte is refused: no program argument can carry it', async () => {
    const {env, w, xdgState} = stateWorld();
    const cmux = fakeCmux();
    const opts = options(w, {env, kickoff: 'before\0after'});
    const result = await spawnSession(opts, cmux);
    expect(result.exitCode).toBe(2);
    expect(result.lines.join('\n')).toContain('NUL byte');
    expect(cmux.calls).toEqual([]);
    expect(existsSync(join(xdgState, 'justin-sdk'))).toBe(false);
  });

  test('a kickoff file is never overwritten: each one is a record', () => {
    const w = world();
    const path = spawnKickoffPath({XDG_STATE_HOME: w.root}, NOW, 'abcd1234');
    expect(path).toBe(
      join(
        w.root,
        'justin-sdk',
        'spawn-kickoffs',
        '20261103T210405Z-abcd1234.md',
      ),
    );
    expect(writeKickoffFile(path, 'first')).toBeNull();
    expect(writeKickoffFile(path, 'second')).toContain('EEXIST');
    expect(readFileSync(path, 'utf8')).toBe('first');
  });
});
