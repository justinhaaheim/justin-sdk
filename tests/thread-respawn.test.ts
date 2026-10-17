/**
 * `thread respawn` (home-base-1r6d.34.5). Real br and the real `thread
 * handoff` in $TMPDIR workspaces; cmux and the delayed close are injected
 * fakes, so no test reaches the real cmux or spawns anything.
 */

import type {CmuxCall} from '../src/thread/cmux';
import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, test} from 'bun:test';
import {execFileSync} from 'child_process';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'fs';
import {join} from 'path';

import {brShow, runBr} from '../src/beads/br';
import {kickoffText, respawn, zshWord} from '../src/thread/respawn';
import {ensureSessionBead} from '../src/thread/session-bead';
import {handOff} from '../src/thread/session-handoff';
import {selectSession} from '../src/thread/session-select';
import {initRepo} from './git-fixtures';
import {needBr} from './pinned-br';
import {createSandbox} from './sandbox';

const OLD = '01d00000-1111-4222-8333-0000000000a1';
const WS = 'AAAA0000-1111-4222-8333-0000000000b2';
const SOCK = '/tmp/respawn-test/cmux.sock';
const TRICKY = `say "hi" to $HOME and \`date\`, it's fine`;

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

interface World {
  beadId: string;
  env: Record<string, string | undefined>;
  repo: string;
  stateDir: string;
}

function world(): World {
  needBr();
  const sb = createSandbox();
  sandboxes.push(sb);
  const xdg = join(sb.path, 'xdg');
  mkdirSync(join(xdg, 'justin-sdk'), {recursive: true});
  writeFileSync(
    join(xdg, 'justin-sdk', 'config.json'),
    JSON.stringify({
      componentConfig: {thread: {enabled: true, sessionBeads: true}},
    }),
  );
  const stateDir = join(sb.path, 'state');
  const env: Record<string, string | undefined> = {
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SESSION_ID: OLD,
    CMUX_SOCKET_PATH: SOCK,
    CMUX_WORKSPACE_ID: WS,
    HOME: join(sb.path, 'home'),
    JUSTIN_SDK_HEALTH_NOTICES: 'off',
    JUSTIN_THREADS_STATE_DIR: stateDir,
    JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(sb.path, 'projects'),
    XDG_CONFIG_HOME: xdg,
  };
  const repo = initRepo(sb, 'respawn-repo', {'README.md': '# r\n'});
  const init = runBr(repo, ['init', '--prefix', 't', '-q']);
  if (!init.ok) throw new Error(`br init failed: ${init.reason ?? '?'}`);
  const filed = ensureSessionBead({
    cwd: repo,
    env,
    firstPrompt: {at: '2030-01-01T09:00:00.000Z', text: 'migrate the db'},
    now: new Date('2030-01-01T09:00:00.000Z'),
    sessionId: OLD,
  });
  if (filed.kind !== 'created') throw new Error(filed.detail);
  return {beadId: filed.beadId, env, repo, stateDir};
}

/** A fake cmux: records every call; ping and new-workspace answer as cmux does. */
function fakeCmux(answers: Partial<Record<string, CmuxCall>> = {}) {
  const calls: string[][] = [];
  const run = (args: readonly string[]): Promise<CmuxCall> => {
    calls.push([...args]);
    const preset = answers[args[0] ?? ''];
    if (preset != null) return Promise.resolve(preset);
    const stdout = args[0] === 'ping' ? 'PONG\n' : 'OK workspace:7\n';
    return Promise.resolve({kind: 'ok', stdout});
  };
  return {calls, run};
}

function fakeClose() {
  const closes: {argv: string[]; seconds: number}[] = [];
  const closeLater = (argv: readonly string[], seconds: number) => {
    closes.push({argv: [...argv], seconds});
    return null;
  };
  return {closeLater, closes};
}

const BASE = {
  closeAfter: 0,
  dryRun: false,
  kickoff: null,
  model: null,
  note: 'pick up at step 3',
  sessionId: null,
  successorSocket: false,
};

function labelsOf(w: World): string[] {
  const shown = brShow({cwd: w.repo}, w.beadId);
  if (shown.kind !== 'ok') throw new Error(`br show: ${shown.kind}`);
  return shown.issue.labels;
}

const handoffs = (w: World) => join(w.stateDir, 'handoffs');

describe('thread respawn: refusals (exit 2, nothing written)', () => {
  test('outside a cmux pane: no CMUX_WORKSPACE_ID', async () => {
    const w = world();
    const cmux = fakeCmux();
    const env = {...w.env, CMUX_WORKSPACE_ID: undefined};
    const result = await respawn({...BASE, cwd: w.repo, env}, cmux);
    expect(result.exitCode).toBe(2);
    expect(result.lines.join('\n')).toContain('not in a cmux pane');
    expect(result.lines.join('\n')).toContain('CMUX_WORKSPACE_ID');
    expect(cmux.calls).toEqual([]);
  });

  test('no socket path: neither CMUX_SOCKET_PATH nor last-socket-path', async () => {
    const w = world();
    const env = {...w.env, CMUX_SOCKET_PATH: undefined};
    const result = await respawn({...BASE, cwd: w.repo, env}, fakeCmux());
    expect(result.exitCode).toBe(2);
    const text = result.lines.join('\n');
    expect(text).toContain('no CMUX_SOCKET_PATH');
    expect(text).toContain('.local/state/cmux/last-socket-path');
  });

  test('the socket path comes from last-socket-path when the env has none', async () => {
    const w = world();
    const file = join(w.env.HOME ?? '', '.local/state/cmux/last-socket-path');
    mkdirSync(join(file, '..'), {recursive: true});
    writeFileSync(file, '/tmp/recorded.sock\n');
    const env = {...w.env, CMUX_SOCKET_PATH: undefined};
    const result = await respawn(
      {...BASE, cwd: w.repo, dryRun: true, env},
      fakeCmux(),
    );
    expect(result.exitCode).toBe(0);
    expect(result.lines.join('\n')).toContain(
      '"--socket","/tmp/recorded.sock"',
    );
  });

  test('no session bead: the same reason thread handoff gives', async () => {
    const w = world();
    const env = {
      ...w.env,
      CLAUDE_CODE_SESSION_ID: '0e400000-1111-4222-8333-00000000ffff',
    };
    const handoff = await handOff({
      cwd: w.repo,
      env,
      note: null,
      sessionId: null,
      to: null,
    });
    if (handoff.kind !== 'failed') throw new Error('expected handoff to fail');
    const result = await respawn({...BASE, cwd: w.repo, env}, fakeCmux());
    expect(result.exitCode).toBe(2);
    expect(result.lines).toEqual([
      `thread respawn: refused: ${handoff.reason}`,
    ]);
  });

  test('cmux unreachable: names the error and prints the sandbox hint; bead untouched', async () => {
    const w = world();
    const cmux = fakeCmux({
      ping: {
        kind: 'failed',
        reason:
          'cmux ping failed: Failed to connect to socket (Operation not permitted, errno 1)',
      },
    });
    const result = await respawn({...BASE, cwd: w.repo, env: w.env}, cmux);
    expect(result.exitCode).toBe(2);
    const text = result.lines.join('\n');
    expect(text).toContain('Operation not permitted, errno 1');
    expect(text).toContain(
      `{"sandbox":{"network":{"allowUnixSockets":["${SOCK}"]}}}`,
    );
    expect(text).toContain('retry with the sandbox disabled');
    expect(cmux.calls).toEqual([['ping']]);
    expect(existsSync(handoffs(w))).toBe(false);
    expect(labelsOf(w)).not.toContain('handed-off');
  });
});

describe('thread respawn: the successor', () => {
  test('hands off, writes the block, and starts the successor with the exact argv', async () => {
    const w = world();
    const cmux = fakeCmux();
    const close = fakeClose();
    const result = await respawn(
      {...BASE, cwd: w.repo, env: w.env, kickoff: TRICKY, model: 'haiku'},
      {...cmux, ...close},
    );
    expect(result.exitCode).toBe(0);
    expect(labelsOf(w)).toContain('handed-off');

    const blockPath = join(handoffs(w), `${OLD}.md`);
    const block = readFileSync(blockPath, 'utf8');
    expect(block).toContain('🤝 **HANDOFF**');
    expect(block).toContain('pick up at step 3');
    expect(block).toContain(`thread request --continues ${w.beadId}`);
    expect(existsSync(join(handoffs(w), 'cmux-sandbox-settings.json'))).toBe(
      false,
    );

    const selected = selectSession({
      env: w.env,
      selector: null,
      sessionIdOption: null,
    });
    if (selected.kind !== 'found') throw new Error(selected.kind);
    const kickoff = kickoffText(blockPath, w.beadId, TRICKY);
    expect(kickoff).toContain(
      `bun run justin-sdk thread request --continues ${w.beadId}`,
    );
    expect(kickoff.endsWith(TRICKY)).toBe(true);
    expect(cmux.calls).toHaveLength(2);
    expect(cmux.calls[0]).toEqual(['ping']);
    const [verb, nameFlag, name, ...rest] = cmux.calls[1] ?? [];
    expect([verb, nameFlag]).toEqual(['new-workspace', '--name']);
    expect(name).toMatch(/^\[.*\] /u);
    expect(rest).toEqual([
      '--cwd',
      selected.session.checkoutPath,
      '--command',
      `claude --model haiku 'You are the successor of a handed-off Claude Code session. Read ${blockPath}. First run the command under its pick-up section: bun run justin-sdk thread request --continues ${w.beadId}. Then continue the work the block describes, starting from its note. say "hi" to $HOME and \`date\`, it'\\''s fine'`,
    ]);
    expect(close.closes).toEqual([]);
    const text = result.lines.join('\n');
    expect(text).toContain(blockPath);
    expect(text).toContain('workspace:7');
    expect(result.lines.at(-1)).toBe(
      'Next: write your last message and end the turn.',
    );
  });

  test('zsh receives the kickoff literally (quote, dollar, backtick, space, apostrophe)', () => {
    const kickoff = kickoffText('/tmp/x y/block.md', 't-abc', TRICKY);
    const command = ['claude', '--model', 'haiku', kickoff]
      .map(zshWord)
      .join(' ');
    // Swap the program for printf: zsh then prints every word it parsed.
    const probe = command.replace(/^claude /u, `printf '%s\\n' `);
    const printed = execFileSync('zsh', ['-f', '-c', probe], {
      encoding: 'utf8',
    });
    expect(printed).toBe(`--model\nhaiku\n${kickoff}\n`);
  });

  test('zsh receives a word starting with "=" literally (no EQUALS expansion)', () => {
    // Bare, `=date` would become the path of the date binary; `a=b` is safe bare.
    const command = ['claude', '=date', 'a=b'].map(zshWord).join(' ');
    const probe = command.replace(/^claude /u, `printf '%s\\n' `);
    const printed = execFileSync('zsh', ['-f', '-c', probe], {
      encoding: 'utf8',
    });
    expect(printed).toBe('=date\na=b\n');
  });

  test('--successor-socket writes the settings file and passes it with --settings', async () => {
    const w = world();
    const cmux = fakeCmux();
    const result = await respawn(
      {...BASE, cwd: w.repo, env: w.env, successorSocket: true},
      cmux,
    );
    expect(result.exitCode).toBe(0);
    const settings = join(handoffs(w), 'cmux-sandbox-settings.json');
    expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual({
      sandbox: {network: {allowUnixSockets: [SOCK]}},
    });
    const command = cmux.calls[1]?.at(-1) ?? '';
    expect(command.startsWith(`claude --settings ${settings} '`)).toBe(true);
  });

  test('--close-after N schedules the close of THIS workspace, N seconds out', async () => {
    const w = world();
    const close = fakeClose();
    const result = await respawn(
      {...BASE, closeAfter: 45, cwd: w.repo, env: w.env},
      {...fakeCmux(), ...close},
    );
    expect(result.exitCode).toBe(0);
    expect(close.closes).toEqual([
      {
        argv: ['cmux', '--socket', SOCK, 'close-workspace', '--workspace', WS],
        seconds: 45,
      },
    ]);
    expect(result.lines.join('\n')).toContain(`${WS} in 45 s`);
  });

  test('--dry-run writes nothing and spawns nothing', async () => {
    const w = world();
    const cmux = fakeCmux();
    const close = fakeClose();
    const result = await respawn(
      {
        ...BASE,
        closeAfter: 45,
        cwd: w.repo,
        dryRun: true,
        env: w.env,
        successorSocket: true,
      },
      {...cmux, ...close},
    );
    expect(result.exitCode).toBe(0);
    expect(cmux.calls).toEqual([['ping']]);
    expect(close.closes).toEqual([]);
    expect(existsSync(handoffs(w))).toBe(false);
    expect(labelsOf(w)).not.toContain('handed-off');
    const text = result.lines.join('\n');
    expect(text).toContain('"new-workspace"');
    expect(text).toContain(`thread request --continues ${w.beadId}`);
    expect(text).toContain('cmux-sandbox-settings.json');
  });

  test('a cmux new-workspace failure surfaces its stderr and exits 1', async () => {
    const w = world();
    const cmux = fakeCmux({
      'new-workspace': {
        kind: 'failed',
        reason:
          'cmux new-workspace --name x failed: Error: no window to attach to',
      },
    });
    const result = await respawn({...BASE, cwd: w.repo, env: w.env}, cmux);
    expect(result.exitCode).toBe(1);
    const text = result.lines.join('\n');
    expect(text).toContain('starting the successor');
    expect(text).toContain('Error: no window to attach to');
    expect(text).toContain('WAS handed off');
  });

  test('cmux exiting 0 without naming a workspace is a failure, not a success', async () => {
    const w = world();
    const cmux = fakeCmux({'new-workspace': {kind: 'ok', stdout: ''}});
    const result = await respawn({...BASE, cwd: w.repo, env: w.env}, cmux);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('cmux printed ""');
  });

  test('a close that cannot be scheduled exits 1 and says the successor started', async () => {
    const w = world();
    const result = await respawn(
      {...BASE, closeAfter: 5, cwd: w.repo, env: w.env},
      {...fakeCmux(), closeLater: () => 'spawn EAGAIN'},
    );
    expect(result.exitCode).toBe(1);
    const text = result.lines.join('\n');
    expect(text).toContain('spawn EAGAIN');
    expect(text).toContain('the successor DID start, as workspace:7');
  });
});
