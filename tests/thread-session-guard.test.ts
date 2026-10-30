/**
 * The session guard (home-base-mbnjv.5, epic home-base-mbnjv C8): a PreToolUse
 * [Bash] hook that refuses raw cmux / claude calls that start or drive other
 * sessions, and a subagent's thread handoff. Table-driven over real payloads;
 * the subagent record and the fail-closed command run on real br.
 */

import type {DryRun} from '../src/hook-entries-check';
import type {GuardHookDeps} from '../src/thread/session-guard';
import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, spyOn, test} from 'bun:test';
import {mkdirSync, readFileSync, writeFileSync} from 'fs';
import {join} from 'path';

import {brShow, runBr} from '../src/beads/br';
import {checkSdkHookEntries} from '../src/hook-entries-check';
import {handlersByKnob} from '../src/hook-knobs';
import {dispatchCommand} from '../src/hook-registry';
import {SDK_HANDOFF_CALL} from '../src/sdk-invocation';
import {setQuiet} from '../src/setup-helpers';
import {
  describeGuardNotRegistered,
  guardRegistration,
} from '../src/thread/guard-registration';
import {threadHandoffCommand} from '../src/thread/handoff-successor';
import {ensureSessionBead} from '../src/thread/session-bead';
import {
  classifyCommand,
  guardHook,
  scanShell,
} from '../src/thread/session-guard';
import {spawnGate} from '../src/thread/spawn-gate';
import {
  stepThreadHooks,
  THREAD_GUARD_HOOK_COMMAND,
} from '../src/thread-hooks-setup';
import {initRepo} from './git-fixtures';
import {needBr} from './pinned-br';
import {createSandbox} from './sandbox';

const SESSION = '0e550000-1111-4222-8333-0000000000a1';
const AGENT = 'a1b2c3d4e5f6';

function payload(command: string, more: Record<string, unknown> = {}): string {
  return JSON.stringify({
    cwd: '/tmp/guard-test',
    hook_event_name: 'PreToolUse',
    session_id: SESSION,
    tool_input: {command, description: 'test'},
    tool_name: 'Bash',
    ...more,
  });
}

const KNOB_ON: Partial<GuardHookDeps> = {
  knobOn: () => true,
  recordSubagent: () => 'Recorded on t-1: handoff refused: subagent — test',
};

async function run(command: string, more: Record<string, unknown> = {}) {
  return await guardHook({env: {}, stdin: payload(command, more)}, KNOB_ON);
}

// ---------------------------------------------------------------------------
// AC1: the table
// ---------------------------------------------------------------------------

const DENIED: [string, string][] = [
  // The acceptance criteria's cases.
  ['cmux new-surface --workspace w --command "claude"', 'cmux'],
  ['cmux send --surface surface:4 "hello"', 'cmux'],
  ['cmux close-surface --surface surface:4', 'cmux'],
  ['cmux /some/dir', 'cmux'],
  ["claude --bg 'do x'", 'claude'],
  ["claude 'do x'", 'claude'],
  ['claude -p x', 'claude'],
  ['env A=1 ~/.local/bin/claude --resume x', 'claude'],
  ['bash -c "cmux new-workspace"', 'cmux'],
  ['echo $(claude -p hi)', 'claude'],
  // More shapes a session might type.
  ['echo `claude -p hi`', 'claude'],
  ['echo "result: $(claude -p hi)"', 'claude'],
  ['cd /x && cmux new-split right', 'cmux'],
  ['git status; cmux send-key --surface s enter', 'cmux'],
  ['echo hi\ncmux respawn-pane --surface s --command x', 'cmux'],
  ['cmux --json --id-format both new-pane --type terminal', 'cmux'],
  ['cmux new-workspace --cwd .', 'cmux'],
  ['cmux workspace create', 'cmux'],
  ['cmux rename-workspace mine', 'cmux'],
  ['cmux', 'cmux'],
  ['/Users/jhaa/.local/bin/claude', 'claude'],
  ['claude', 'claude'],
  ['claude agents', 'claude'],
  ['claude --continue', 'claude'],
  ['claude attach abc', 'claude'],
  ['claude stop abc', 'claude'],
  ['claude ultrareview', 'claude'],
  ['claude --model haiku --version', 'claude'],
  ["claude 'explain' --help", 'claude'],
  ['timeout 5 claude -p x', 'claude'],
  ['nohup claude --bg x > /dev/null 2>&1 &', 'claude'],
  ['command claude -p x', 'claude'],
  ['exec cmux new-surface', 'cmux'],
  ['FOO=1 BAR=2 claude -p x', 'claude'],
  ['if true; then claude -p x; fi', 'claude'],
  ['zsh -lc "claude --bg x"', 'claude'],
  ['sh -c \'bash -c "cmux send x"\'', 'cmux'],
  ["eval 'cmux send x'", 'cmux'],
  ['diff <(claude -p a) b', 'claude'],
  ['cat <<EOF\n$(claude -p x)\nEOF', 'claude'],
  ['bunx @anthropic-ai/claude-code -p x', 'claude'],
  // F13 (home-base-mbnjv.8): the reviewer's probe cases, then the launchers
  // and multiplexers its fix shape names.
  ["tmux new-session -d 'claude --bg'", 'claude'],
  ['zellij run -- claude --bg', 'claude'],
  ['caffeinate -i claude --bg', 'claude'],
  ["bash -o pipefail -c 'claude --bg'", 'claude'],
  ['echo x | xargs claude --bg', 'claude'],
  ['sudo claude --bg', 'claude'],
  ['bun x @anthropic-ai/claude-code', 'claude'],
  ['npm exec -- claude --bg', 'claude'],
  ['npm exec @anthropic-ai/claude-code -- --bg', 'claude'],
  ['pnpm dlx @anthropic-ai/claude-code -p x', 'claude'],
  ['npx claude --bg', 'claude'],
  ['caffeinate -t 60 cmux new-surface', 'cmux'],
  ['sudo -u root -E cmux send x', 'cmux'],
  ['stdbuf -oL claude -p x', 'claude'],
  ['stdbuf -o L cmux send x', 'cmux'],
  ['unbuffer claude --bg', 'claude'],
  ['script -q /dev/null claude --bg', 'claude'],
  ['script -c "cmux send x" /dev/null', 'cmux'],
  ['watch -n 5 cmux send x', 'cmux'],
  ['screen -dmS work claude --bg', 'claude'],
  ['tmux new-window "cmux new-surface"', 'cmux'],
  ['xargs -n 1 -I {} cmux send {}', 'cmux'],
  ["bash +o histexpand -O extglob -c 'claude -p x'", 'claude'],
  ["bash --rcfile x.rc -c 'claude -p x'", 'claude'],
  ['echo "unclosed claude', 'unreadable'],
  ['echo $(cmux send x', 'unreadable'],
];

const ALLOWED: string[] = [
  // The acceptance criteria's cases.
  'cmux identify',
  'cmux tree --all',
  'cmux read-screen --surface s',
  'claude --version',
  'claude agents --json',
  "git commit -m 'mention claude and cmux'",
  'bun run justin-sdk thread handoff --note x',
  // More read-only and unrelated shapes.
  'cmux --json --id-format both tree --workspace workspace:1',
  'cmux list-workspaces',
  'cmux list-pane-surfaces --pane pane:3',
  'cmux capture-pane --surface s --lines 20',
  'cmux current-workspace',
  'cmux ping',
  'cmux --help',
  'cmux new-surface --help',
  'cmux notify --title done --body "tests pass"',
  'cmux browser open http://localhost:3000',
  'cmux markdown open README.md',
  'claude -v',
  'claude --help',
  'claude stop --help',
  'claude mcp list',
  'claude mcp get context7',
  'claude config get model',
  'claude doctor',
  'claude logs abc123',
  'claude --version 2>&1 | head -1',
  'command -v claude',
  'which cmux claude',
  'grep -rn claude src/',
  'claude-usage history',
  'ls ~/.claude/projects',
  'echo "see claude.ai/code"',
  'git commit -m "$(cat msg.txt)"',
  "cat <<'EOF'\nclaude --bg do things\ncmux send x\nEOF",
  'cat <<EOF\nclaude --bg is what we refuse\nEOF',
  'ls # then claude --bg',
  'echo "unclosed',
  'bun run justin-sdk thread spawn --repo x "work"',
  // F13: the same launchers running something harmless, or naming claude
  // only as an argument.
  'tmux ls',
  'tmux capture-pane -p -t 0',
  'zellij run -- bun test',
  'screen -ls',
  'caffeinate -i bun test',
  'sudo -n true',
  'echo a | xargs rg claude',
  'bash -o pipefail -c "bun test | tail -5"',
  'stdbuf -oL bun test',
  'script -q /dev/null bun test',
  'watch -n 5 git status',
  'bun x prettier --check .',
  'npm exec -- prettier --check .',
  'pnpm dlx tsx script.ts',
];

describe('the guard on payloads (AC1)', () => {
  for (const [command, reason] of DENIED) {
    test(`denies: ${JSON.stringify(command)}`, async () => {
      const result = await run(command);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('thread handoff');
      expect(result.stderr).toContain('thread spawn');
      const verdict = classifyCommand(command, {subagent: false});
      expect(verdict.kind === 'deny' && verdict.reason).toBe(
        reason as 'claude',
      );
    });
  }

  for (const command of ALLOWED) {
    test(`allows: ${JSON.stringify(command)}`, async () => {
      const result = await run(command);
      expect(result).toEqual({exitCode: 0, stderr: ''});
    });
  }

  test('a denial names the refused command, the doors, finality and what stays allowed', async () => {
    const result = await run('cd /x && cmux new-surface --command y');
    expect(result.stderr).toContain(
      'thread guard: refused `cmux new-surface --command y`',
    );
    expect(result.stderr).toContain(
      'run `./node_modules/.bin/justin-sdk thread handoff --note',
    );
    expect(result.stderr).toContain('bare, from the repository root.');
    expect(result.stderr).not.toContain('bun run justin-sdk thread handoff');
    expect(result.stderr).toContain('A refusal is final');
    expect(result.stderr).toContain('read-only cmux (identify, tree,');
    expect(result.stderr).toContain('`claude agents --json`');
  });
});

describe('subagents and the thread command', () => {
  const SUB = {agent_id: AGENT, agent_type: 'player'};

  test('thread handoff from a subagent is denied and recorded; the parent may run it', async () => {
    const denied = await run('bun run justin-sdk thread handoff --note x', SUB);
    expect(denied.exitCode).toBe(2);
    expect(denied.stderr).toContain('a subagent may not run `thread handoff`');
    expect(denied.stderr).toContain('Recorded on t-1');
    expect(await run('bun run justin-sdk thread handoff --note x')).toEqual({
      exitCode: 0,
      stderr: '',
    });
  });

  test('the by-path call (SDK_HANDOFF_CALL, mbnjv.10 AC3): denied for a subagent, allowed otherwise', async () => {
    const command =
      './node_modules/.bin/justin-sdk thread handoff --note "plain note"';
    expect(command.startsWith(SDK_HANDOFF_CALL)).toBe(true);
    expect(classifyCommand(command, {subagent: true})).toMatchObject({
      kind: 'deny',
      reason: 'subagentThread',
    });
    const denied = await run(command, SUB);
    expect(denied.exitCode).toBe(2);
    expect(denied.stderr).toContain('a subagent may not run `thread handoff`');
    expect(denied.stderr).toContain(
      'That session decides whether to run `./node_modules/.bin/justin-sdk thread handoff`.',
    );
    expect(classifyCommand(command, {subagent: false})).toEqual({
      kind: 'allow',
    });
    expect(await run(command)).toEqual({exitCode: 0, stderr: ''});
    // The bare call (no arguments) is the same command.
    expect(
      (await run('./node_modules/.bin/justin-sdk thread handoff', SUB))
        .exitCode,
    ).toBe(2);
  });

  for (const command of [
    'justin-sdk thread spawn --repo x "y"',
    'bun run --cwd "${CLAUDE_PROJECT_DIR:-.}" justin-sdk thread respawn',
    'bunx github:justinhaaheim/justin-sdk#v0.50.0 thread handoff',
    'cd pkg/justin-sdk && bun src/cli.ts thread handoff',
  ]) {
    test(`a subagent's ${JSON.stringify(command)} is denied`, async () => {
      expect((await run(command, SUB)).exitCode).toBe(2);
    });
  }

  for (const command of [
    'bun run justin-sdk thread show',
    'bun run justin-sdk thread request "x"',
    'echo thread handoff',
    'cmux tree',
  ]) {
    test(`a subagent's ${JSON.stringify(command)} is allowed`, async () => {
      expect((await run(command, SUB)).exitCode).toBe(0);
    });
  }
});

describe('when the guard does nothing', () => {
  test('the knob is off: even cmux new-surface passes', async () => {
    const result = await guardHook(
      {env: {}, stdin: payload('cmux new-surface')},
      {knobOn: () => false},
    );
    expect(result).toEqual({exitCode: 0, stderr: ''});
  });

  test('another tool passes without a look', async () => {
    const result = await guardHook(
      {env: {}, stdin: payload('cmux send x', {tool_name: 'Read'})},
      KNOB_ON,
    );
    expect(result).toEqual({exitCode: 0, stderr: ''});
  });

  test('a payload that is not JSON passes and says it was not checked', async () => {
    const result = await guardHook({env: {}, stdin: 'nope'}, KNOB_ON);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('this call was not checked');
  });

  test('the knob is read at CLAUDE_PROJECT_DIR, else the payload cwd', async () => {
    const roots: string[] = [];
    const knobOn = (root: string) => {
      roots.push(root);
      return false;
    };
    await guardHook(
      {env: {CLAUDE_PROJECT_DIR: '/proj'}, stdin: payload('ls')},
      {knobOn},
    );
    await guardHook({env: {}, stdin: payload('ls')}, {knobOn});
    expect(roots).toEqual(['/proj', '/tmp/guard-test']);
  });
});

describe('the scanner', () => {
  test('substitutions are cut out and returned; newlines become separators', () => {
    const scan = scanShell('a $(b c) "d `e`"\nf');
    expect(scan.ok).toBe(true);
    if (scan.ok) {
      expect(scan.substitutions).toEqual(['b c', 'e']);
      expect(scan.text).toContain(' ; f');
    }
  });

  test('single quotes keep everything literal', () => {
    const scan = scanShell("echo '$(claude) `cmux`'");
    expect(scan.ok && scan.substitutions).toEqual([]);
  });

  test('a quoted heredoc body is dropped; an unquoted one is scanned for substitutions', () => {
    const quoted = scanShell("cat <<'X'\n$(a)\nX\nls");
    expect(quoted.ok && quoted.substitutions).toEqual([]);
    const open = scanShell('cat <<-X\n\t$(a)\n\tX\nls');
    expect(open.ok && open.substitutions).toEqual(['a']);
  });
});

// ---------------------------------------------------------------------------
// Real br: the subagent record (AC2) and the fail-closed command (AC5)
// ---------------------------------------------------------------------------

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
});

interface World {
  beadId: string;
  env: Record<string, string | undefined>;
  repo: string;
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
      componentConfig: {
        thread: {enabled: true, handoff: {successor: true}, sessionBeads: true},
      },
    }),
  );
  const env: Record<string, string | undefined> = {
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SESSION_ID: SESSION,
    CMUX_SOCKET_PATH: join(sb.path, 'no-cmux.sock'),
    CMUX_SURFACE_ID: 'CCCC0000-1111-4222-8333-0000000000c3',
    CMUX_WORKSPACE_ID: 'AAAA0000-1111-4222-8333-0000000000b2',
    HOME: join(sb.path, 'home'),
    JUSTIN_SDK_HEALTH_NOTICES: 'off',
    JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state'),
    JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(sb.path, 'projects'),
    XDG_CONFIG_HOME: xdg,
  };
  const repo = initRepo(sb, 'guard-repo', {'README.md': '# r\n'});
  const init = runBr(repo, ['init', '--prefix', 't', '-q']);
  if (!init.ok) throw new Error(`br init failed: ${init.reason ?? '?'}`);
  const filed = ensureSessionBead({
    cwd: repo,
    env,
    firstPrompt: {at: '2030-01-01T09:00:00.000Z', text: 'migrate the db'},
    now: new Date('2030-01-01T09:00:00.000Z'),
    sessionId: SESSION,
  });
  if (filed.kind !== 'created') throw new Error(filed.detail);
  return {beadId: filed.beadId, env, repo};
}

function bead(w: World) {
  const shown = brShow({cwd: w.repo}, w.beadId);
  if (shown.kind !== 'ok') throw new Error(`br show: ${shown.kind}`);
  return shown.issue;
}

function registerGuard(root: string, settings: unknown): void {
  mkdirSync(join(root, '.claude'), {recursive: true});
  writeFileSync(
    join(root, '.claude', 'settings.json'),
    JSON.stringify(settings),
  );
}

const PER_HANDLER = {
  hooks: {
    PreToolUse: [
      {
        hooks: [{command: THREAD_GUARD_HOOK_COMMAND, type: 'command'}],
        matcher: 'Bash',
      },
    ],
  },
};

describe('the subagent refusal is recorded on the session bead (AC2, real br)', () => {
  test('with agent_id: denied, labelled handoff-refused, noted; without: allowed, nothing written', async () => {
    const w = world();
    const command = 'bun run justin-sdk thread handoff --note "wrap up"';

    const allowed = await guardHook({
      env: w.env,
      stdin: payload(command, {cwd: w.repo}),
    });
    expect(allowed).toEqual({exitCode: 0, stderr: ''});
    expect(bead(w).labels ?? []).not.toContain('handoff-refused');

    const denied = await guardHook({
      env: w.env,
      now: new Date('2030-01-01T10:00:00.000Z'),
      stdin: payload(command, {
        agent_id: AGENT,
        agent_type: 'player',
        cwd: w.repo,
      }),
    });
    expect(denied.exitCode).toBe(2);
    expect(denied.stderr).toContain('thread handoff');
    expect(denied.stderr).toContain(
      `Recorded on ${w.beadId}: handoff refused: subagent`,
    );
    const after = bead(w);
    expect(after.labels ?? []).toContain('handoff-refused');
    expect(after.notes ?? '').toContain(
      `handoff refused: subagent — a subagent (player ${AGENT}) ran`,
    );
  });
});

describe('fail closed: thread handoff and thread spawn need the guard registered (AC5)', () => {
  test('no guard entry: thread handoff exits 3 with guardNotRegistered and opens nothing', async () => {
    const w = world();
    const calls: string[][] = [];
    const result = await threadHandoffCommand(
      {
        cwd: w.repo,
        dryRun: false,
        env: w.env,
        model: null,
        note: 'wrap up',
        now: new Date('2030-01-01T10:00:00.000Z'),
        sessionId: null,
        to: null,
      },
      {
        run: (args) => {
          calls.push([...args]);
          return Promise.resolve({kind: 'failed', reason: 'no cmux in tests'});
        },
      },
    );
    expect(result.exitCode).toBe(3);
    expect(result.launch).toBeNull();
    expect(result.lines.join('\n')).toContain(
      'handoff refused: guardNotRegistered: the session guard (PreToolUse [Bash] → thread guard) is not registered',
    );
    expect(calls).toEqual([]);
    const after = bead(w);
    expect(after.labels ?? []).toContain('handoff-refused');
    expect(after.notes ?? '').toContain('handoff refused: guardNotRegistered');
  });

  test('no guard entry: thread spawn exits 3 with guardNotRegistered', async () => {
    const w = world();
    const refused = await spawnGate({cwd: w.repo, env: w.env});
    expect(refused?.exitCode).toBe(3);
    expect(refused?.lines.join('\n')).toContain(
      'refused by the handoff gate: guardNotRegistered',
    );
  });

  test('with the guard entry, the gate goes past it, and then needs the guard pass (F14: none here, so guardNotSeen)', async () => {
    const w = world();
    registerGuard(w.repo, PER_HANDLER);
    const refused = await spawnGate({cwd: w.repo, env: w.env});
    expect(refused?.lines.join('\n')).not.toContain('guardNotRegistered');
    expect(refused?.lines.join('\n')).toContain(
      'refused by the handoff gate: guardNotSeen: no guard pass at',
    );
  });
});

describe('F14 (home-base-mbnjv.8): the guard fails closed on its own failures, and leaves a pass for the calls it allowed', () => {
  const throwing: Partial<GuardHookDeps> = {
    ...KNOB_ON,
    classify: () => {
      throw new Error('classifier exploded');
    },
  };

  test('a throwing classifier denies a claude command and names thread handoff; an unrelated command passes', async () => {
    const denied = await guardHook(
      {env: {}, stdin: payload('claude --bg')},
      throwing,
    );
    expect(denied.exitCode).toBe(2);
    expect(denied.stderr).toContain('the guard failed (classifier exploded)');
    expect(denied.stderr).toContain(SDK_HANDOFF_CALL);
    const cmux = await guardHook(
      {env: {}, stdin: payload('cmux new-surface')},
      throwing,
    );
    expect(cmux.exitCode).toBe(2);
    const ls = await guardHook({env: {}, stdin: payload('ls -la')}, throwing);
    expect(ls.exitCode).toBe(0);
    expect(ls.stderr).toContain('this call was not checked');
  });

  test('a knob reader that throws, and a payload that is not JSON, deny when the text names claude or cmux', async () => {
    const knobThrows = await guardHook(
      {env: {}, stdin: payload('cmux send hi')},
      {
        knobOn: () => {
          throw new Error('config unreadable');
        },
      },
    );
    expect(knobThrows.exitCode).toBe(2);
    const notJson = await guardHook(
      {env: {}, stdin: '{"tool_input": "claude --bg"'},
      KNOB_ON,
    );
    expect(notJson.exitCode).toBe(2);
    expect(notJson.stderr).toContain('the hook payload is not a JSON object');
  });

  test('an allowed thread handoff from a main session writes the pass with its words; a subagent, a nested call and other commands write none', async () => {
    const writes: {sessionId: string; words: readonly string[]}[] = [];
    const deps: Partial<GuardHookDeps> = {
      ...KNOB_ON,
      writePass: (input) => {
        writes.push({sessionId: input.sessionId, words: input.words});
        return {kind: 'written', path: '/fake'};
      },
    };
    const call = `${SDK_HANDOFF_CALL} --note "wrap up"`;
    expect(
      (await guardHook({env: {}, stdin: payload(call)}, deps)).exitCode,
    ).toBe(0);
    expect(writes).toEqual([
      {
        sessionId: SESSION,
        words: [
          './node_modules/.bin/justin-sdk',
          'thread',
          'handoff',
          '--note',
          'wrap up',
        ],
      },
    ]);
    await guardHook(
      {env: {}, stdin: payload('bun run justin-sdk thread spawn --dry-run')},
      deps,
    );
    expect(writes.at(-1)?.words.slice(-2)).toEqual(['spawn', '--dry-run']);
    const before = writes.length;
    await guardHook({env: {}, stdin: payload(call, {agent_id: AGENT})}, deps);
    await guardHook(
      {env: {}, stdin: payload(`bash -c '${SDK_HANDOFF_CALL}'`)},
      deps,
    );
    await guardHook(
      {env: {}, stdin: payload('bun run justin-sdk thread show')},
      deps,
    );
    expect(writes.length).toBe(before);
  });

  test('a pass that could not be written is said on stderr; the call itself still passes', async () => {
    const result = await guardHook(
      {env: {}, stdin: payload(`${SDK_HANDOFF_CALL} --note x`)},
      {...KNOB_ON, writePass: () => ({kind: 'failed', reason: 'EACCES'})},
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('the guard pass was NOT written (EACCES)');
  });
});

describe('guardRegistration', () => {
  function root(): string {
    const sb = createSandbox();
    sandboxes.push(sb);
    return sb.path;
  }
  const env = (home: string) => ({HOME: home});

  test('absent everywhere: absent, naming the three files', () => {
    const r = root();
    const result = guardRegistration({env: env(join(r, 'home')), roots: [r]});
    expect(result.kind).toBe('absent');
    if (result.kind === 'absent') {
      expect(result.looked).toEqual([
        join(r, 'home', '.claude', 'settings.json'),
        join(r, '.claude', 'settings.json'),
        join(r, '.claude', 'settings.local.json'),
      ]);
      expect(describeGuardNotRegistered(result)).toContain(
        'bun run justin-sdk install',
      );
    }
  });

  test('the per-handler entry in the project, in the local file, or in the user file counts', () => {
    const r = root();
    registerGuard(r, PER_HANDLER);
    expect(
      guardRegistration({env: env(join(r, 'home')), roots: [r]}).kind,
    ).toBe('registered');
    const user = root();
    registerGuard(join(user, 'home'), PER_HANDLER);
    expect(
      guardRegistration({env: env(join(user, 'home')), roots: [user]}).kind,
    ).toBe('registered');
  });

  test('a matcher that does not accept Bash does not count', () => {
    const r = root();
    registerGuard(r, {
      hooks: {
        PreToolUse: [
          {
            hooks: [{command: THREAD_GUARD_HOOK_COMMAND}],
            matcher: 'Edit|Write',
          },
        ],
      },
    });
    expect(
      guardRegistration({env: env(join(r, 'home')), roots: [r]}).kind,
    ).toBe('absent');
  });

  test('the dispatcher entry counts only while the config lists the thread hooks', () => {
    const r = root();
    registerGuard(r, {
      hooks: {
        PreToolUse: [
          {hooks: [{command: dispatchCommand('PreToolUse')}], matcher: 'Bash'},
        ],
      },
    });
    writeFileSync(
      join(r, 'justin-sdk.config.json'),
      JSON.stringify({components: ['thread-hooks-setup']}),
    );
    expect(
      guardRegistration({env: env(join(r, 'home')), roots: [r]}).kind,
    ).toBe('registered');
    writeFileSync(
      join(r, 'justin-sdk.config.json'),
      JSON.stringify({components: ['prettier-setup']}),
    );
    expect(
      guardRegistration({env: env(join(r, 'home')), roots: [r]}).kind,
    ).toBe('absent');
  });

  test('an unreadable settings file is unknown, never absent or registered', () => {
    const r = root();
    mkdirSync(join(r, '.claude'), {recursive: true});
    writeFileSync(join(r, '.claude', 'settings.json'), '{ not json');
    expect(
      guardRegistration({env: env(join(r, 'home')), roots: [r]}).kind,
    ).toBe('unknown');
  });

  test('every root must have it', () => {
    const a = root();
    const b = root();
    registerGuard(a, PER_HANDLER);
    const result = guardRegistration({
      env: env(join(a, 'home')),
      roots: [a, b],
    });
    expect(result.kind === 'absent' && result.root).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// AC4: install writes the entry only where the knob is on; doctor agrees
// ---------------------------------------------------------------------------

describe('install and doctor follow the knob (AC4)', () => {
  const DRY: DryRun = (event) => ({
    exitCode: 0,
    stdout: JSON.stringify({event, handlers: [], ok: true}),
  });

  function repo(options: {dispatch: boolean; successor: boolean}): {
    env: Record<string, string | undefined>;
    root: string;
  } {
    const sb = createSandbox();
    sandboxes.push(sb);
    const config: Record<string, unknown> = {
      componentConfig: {thread: {handoff: {successor: options.successor}}},
      components: ['thread-hooks-setup'],
    };
    if (!options.dispatch) config.hooks = {dispatch: false};
    sb.writeFile('justin-sdk.config.json', JSON.stringify(config));
    // An empty user config: the knob is the project's alone.
    const env = {
      HOME: join(sb.path, 'home'),
      XDG_CONFIG_HOME: join(sb.path, 'xdg'),
    };
    return {env, root: sb.path};
  }

  function install(root: string, env: Record<string, string | undefined>) {
    setQuiet(true);
    const lines: string[] = [];
    const spy = spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    try {
      expect(stepThreadHooks(root, handlersByKnob(root, env))).toBe(true);
    } finally {
      spy.mockRestore();
      setQuiet(false);
    }
    return lines;
  }

  function preToolUse(root: string): unknown {
    const settings = JSON.parse(
      readFileSync(join(root, '.claude', 'settings.json'), 'utf8'),
    ) as {hooks?: Record<string, unknown>};
    return settings.hooks?.PreToolUse;
  }

  /** Every doctor line about PreToolUse, by kind. */
  function doctor(root: string, env: Record<string, string | undefined>) {
    const report = checkSdkHookEntries(root, {
      byKnob: handlersByKnob(root, env),
      dryRun: DRY,
    });
    if (report.kind !== 'checked') throw new Error(report.reason);
    const about = (lines: string[]) =>
      lines.filter((l) => l.startsWith('PreToolUse'));
    return {
      doubleRuns: about(report.doubleRuns),
      extra: about(report.extra),
      missing: about(report.missing),
      stale: about(report.stale),
    };
  }

  const CLEAN = {doubleRuns: [], extra: [], missing: [], stale: []};

  test('knob on, dispatch on: the PreToolUse dispatcher entry, matcher Bash; doctor agrees', () => {
    const {env, root} = repo({dispatch: true, successor: true});
    install(root, env);
    expect(preToolUse(root)).toEqual([
      {
        hooks: [{command: dispatchCommand('PreToolUse'), type: 'command'}],
        matcher: 'Bash',
      },
    ]);
    expect(doctor(root, env)).toEqual(CLEAN);
    expect(guardRegistration({env, roots: [root]}).kind).toBe('registered');
  });

  test('knob on, dispatch off: the per-handler thread guard entry, matcher Bash; doctor agrees', () => {
    const {env, root} = repo({dispatch: false, successor: true});
    install(root, env);
    expect(preToolUse(root)).toEqual([
      {
        hooks: [{command: THREAD_GUARD_HOOK_COMMAND, type: 'command'}],
        matcher: 'Bash',
      },
    ]);
    expect(doctor(root, env)).toEqual(CLEAN);
    expect(guardRegistration({env, roots: [root]}).kind).toBe('registered');
  });

  for (const dispatch of [true, false]) {
    const mode = dispatch ? 'on' : 'off';

    test(`knob off, dispatch ${mode}: no PreToolUse entry at all; doctor agrees`, () => {
      const {env, root} = repo({dispatch, successor: false});
      install(root, env);
      expect(preToolUse(root)).toBeUndefined();
      expect(doctor(root, env)).toEqual(CLEAN);
    });

    test(`knob turned off, dispatch ${mode}: install takes the exact entry back and says why`, () => {
      const {env, root} = repo({dispatch, successor: true});
      install(root, env);
      expect(preToolUse(root)).toBeDefined();
      writeFileSync(
        join(root, 'justin-sdk.config.json'),
        JSON.stringify({
          componentConfig: {thread: {handoff: {successor: false}}},
          components: ['thread-hooks-setup'],
          ...(dispatch ? {} : {hooks: {dispatch: false}}),
        }),
      );
      const written = dispatch
        ? dispatchCommand('PreToolUse')
        : THREAD_GUARD_HOOK_COMMAND;
      expect(doctor(root, env).extra).toEqual([
        dispatch
          ? // The quota brake (ys9t7.5.4) is the other PreToolUse handler; its
            // knob, componentConfig.thread.quota.mode, is off here too.
            `PreToolUse: \`${written}\` runs only thread guard, thread brake, and componentConfig.thread.handoff.successor, componentConfig.thread.quota.mode is off here`
          : `PreToolUse: \`${written}\` is installed, but componentConfig.thread.handoff.successor is off here`,
      ]);
      const lines = install(root, env);
      expect(preToolUse(root)).toBeUndefined();
      expect(lines.join('\n')).toContain(
        `PreToolUse hook (${written}) — componentConfig.thread.handoff.successor is off here, so thread guard has nothing to do`,
      );
      expect(doctor(root, env)).toEqual(CLEAN);
    });
  }

  test('knob on and the entry missing: doctor names it missing', () => {
    const {env, root} = repo({dispatch: true, successor: true});
    expect(doctor(root, env).missing).toEqual([
      `PreToolUse: \`${dispatchCommand('PreToolUse')}\``,
    ]);
  });
});
