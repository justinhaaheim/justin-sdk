/**
 * `thread nudge`, the PostToolUse commit nudge (home-base-vzwbj.4.4 design
 * item 3): its decision table, row by row, and once per turn. Real br in
 * $TMPDIR workspaces for the session bead and the request, like the other v4
 * tests; `needBr()` throws when br is missing.
 *
 * NEGATIVE CONTROLS: recorded in home-base-vzwbj.4.4's notes.
 */

import type {Sandbox} from './sandbox';

import {afterEach, describe, expect, spyOn, test} from 'bun:test';
import {appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync} from 'fs';
import {dirname, join} from 'path';

import {runBr} from '../src/beads/br';
import {
  messageLogPath,
  nudgeMarkPath,
  sessionIndexPath,
} from '../src/thread/archive';
import {
  type MessageLine,
  serializeMessageLine,
} from '../src/thread/message-log';
import {
  decideNudge,
  NUDGE_LINE,
  nudgeLine,
  runThreadNudgeHook,
} from '../src/thread/nudge';
import {fileRequest} from '../src/thread/request';
import {ensureSessionBead} from '../src/thread/session-bead';
import {initRepo} from './git-fixtures';
import {needBr} from './pinned-br';
import {createSandbox} from './sandbox';

const SESSION = '0d9e0000-1111-4222-8333-00000000abcd';
const NOW = new Date('2030-01-01T12:00:00.000Z');

const sandboxes: Sandbox[] = [];
const spies: {mockRestore: () => void}[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup();
  for (const spy of spies.splice(0)) spy.mockRestore();
});

interface World {
  env: Record<string, string | undefined>;
  repo: string;
  sb: Sandbox;
}

/** Write (or append) a user line: a new turn. */
function prompt(w: World, at: string, text: string, append = true): void {
  const path = messageLogPath(SESSION, w.env);
  mkdirSync(dirname(path), {recursive: true});
  const line: MessageLine = {
    at,
    cwd: w.repo,
    event: 'UserPromptSubmit',
    role: 'user',
    text,
  };
  if (append) appendFileSync(path, serializeMessageLine(line));
  else writeFileSync(path, serializeMessageLine(line));
}

function world(
  options: {knobs?: Record<string, unknown>; sessionBead?: boolean} = {},
): World {
  needBr();
  const sb = createSandbox();
  sandboxes.push(sb);
  const xdg = join(sb.path, 'xdg');
  mkdirSync(join(xdg, 'justin-sdk'), {recursive: true});
  writeFileSync(
    join(xdg, 'justin-sdk', 'config.json'),
    JSON.stringify({
      componentConfig: {
        thread: options.knobs ?? {enabled: true, sessionBeads: true},
      },
    }),
  );
  const env: Record<string, string | undefined> = {
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SESSION_ID: SESSION,
    JUSTIN_SDK_HEALTH_NOTICES: 'off',
    JUSTIN_THREADS_STATE_DIR: join(sb.path, 'state'),
    JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(sb.path, 'projects'),
    XDG_CONFIG_HOME: xdg,
  };
  const repo = initRepo(sb, 'nudge-repo', {'README.md': '# n\n'});
  const init = runBr(repo, ['init', '--prefix', 't', '-q']);
  if (!init.ok) throw new Error(`br init failed: ${init.reason ?? '?'}`);
  if (options.sessionBead !== false) {
    const filed = ensureSessionBead({
      cwd: repo,
      env,
      firstPrompt: {at: '2030-01-01T09:00:00.000Z', text: 'tidy the docs'},
      now: new Date('2030-01-01T09:00:00.000Z'),
      sessionId: SESSION,
    });
    if (filed.kind !== 'created') throw new Error(filed.detail);
  }
  prompt({env, repo, sb}, '2030-01-01T09:00:00.000Z', 'tidy the docs', false);
  return {env, repo, sb};
}

function payload(
  w: World,
  overrides: Record<string, unknown> = {},
  command = "git commit -qm 'docs: tidy'",
): string {
  return JSON.stringify({
    cwd: w.repo,
    hook_event_name: 'PostToolUse',
    session_id: SESSION,
    tool_input: {command, description: 'commit'},
    tool_name: 'Bash',
    tool_response: {stderr: '', stdout: ''},
    ...overrides,
  });
}

async function decide(w: World, raw: string) {
  return await decideNudge({env: w.env, now: NOW, raw});
}

describe('thread nudge: the decision table', () => {
  test('sessionBeads off → silent', async () => {
    const w = world({knobs: {enabled: true, sessionBeads: false}});
    expect((await decide(w, payload(w))).kind).toBe('silent');
  });

  test('nudge knob false → silent', async () => {
    const w = world({knobs: {enabled: true, nudge: false, sessionBeads: true}});
    const decision = await decide(w, payload(w));
    expect(decision).toEqual({
      kind: 'silent',
      why: 'knob off (sessionBeads=true, nudge=false)',
    });
  });

  test('not a git commit → silent (including --help and a quoted mention)', async () => {
    const w = world();
    for (const command of [
      'git status',
      'git commit --help',
      'echo "git commit"',
    ]) {
      expect(await decide(w, payload(w, {}, command))).toEqual({
        kind: 'silent',
        why: 'not a git commit',
      });
    }
    expect((await decide(w, payload(w, {tool_name: 'Read'}))).kind).toBe(
      'silent',
    );
  });

  test('a subagent’s commit → silent', async () => {
    const w = world();
    expect((await decide(w, payload(w, {agent_id: 'a1b2'}))).why).toContain(
      'subagent',
    );
  });

  test('no session bead for the session → silent', async () => {
    const w = world({sessionBead: false});
    expect(await decide(w, payload(w))).toEqual({
      kind: 'silent',
      why: 'no session bead for this session',
    });
  });

  test('a request in progress → silent', async () => {
    const w = world();
    const filed = await fileRequest({
      bead: null,
      cwd: w.repo,
      doneWhen: null,
      env: w.env,
      here: false,
      now: NOW,
      sessionId: null,
      title: 'Tidy the docs',
    });
    expect(filed.kind).toBe('filed');
    expect(await decide(w, payload(w))).toEqual({
      kind: 'silent',
      why: 'a request is in progress',
    });
  });

  test('no request, a git commit, the knobs on → it speaks, and marks the turn', async () => {
    const w = world();
    const decision = await decide(w, payload(w));
    expect(decision).toEqual({
      kind: 'speak',
      marked: true,
      unchecked: null,
      why: 'no request in progress',
    });
    expect(existsSync(nudgeMarkPath(SESSION, w.env))).toBe(true);
  });

  // R7 (home-base-vzwbj.4.9): a check that could not be made is not "none".
  test('R7: an unreadable beads export prints the VARIANT line — it never claims no request is in progress', async () => {
    const w = world();
    const exportPath = join(w.repo, '.beads', 'issues.jsonl');
    rmSync(exportPath, {force: true});
    mkdirSync(exportPath); // a directory: EISDIR on read
    const out: string[] = [];
    spies.push(
      spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        out.push(args.join(' '));
      }),
    );
    expect(
      await runThreadNudgeHook({env: w.env, now: NOW, stdin: payload(w)}),
    ).toBe(0);
    expect(out).toHaveLength(1);
    const json = JSON.parse(out[0] ?? '{}') as {
      hookSpecificOutput: {additionalContext: string};
    };
    const said = json.hookSpecificOutput.additionalContext;
    expect(said).not.toBe(NUDGE_LINE);
    expect(said).not.toContain('no request is in progress');
    expect(said).toStartWith(
      '[thread] you committed; I could not check whether a request is in progress (',
    );
    expect(said).toContain(exportPath);
    expect(said).toContain(
      'if this is work Justin asked for, run: bun run justin-sdk thread request',
    );
  });

  // R9 (home-base-vzwbj.4.9): a corrupt index line for this session.
  test('R9: a corrupt index line naming this session (no readable created line) speaks the variant and names the line, rather than going silent', async () => {
    const w = world({sessionBead: false});
    const index = sessionIndexPath(w.env);
    mkdirSync(dirname(index), {recursive: true});
    writeFileSync(
      index,
      `{"at":"2030-01-01T09:00:01.000Z","beadId":"t-1","sessionId":"${SESSION}","ev\n`,
    );
    const decision = await decide(w, payload(w));
    expect(decision.kind).toBe('speak');
    if (decision.kind !== 'speak') return;
    expect(decision.unchecked).toContain(
      `sessions index has a corrupt line for this session: ${index}:1`,
    );
    expect(nudgeLine(decision)).toContain(
      'I could not check whether a request is in progress',
    );
  });
});

describe('thread nudge: once per turn', () => {
  test('a second commit in the same turn is silent; a new prompt makes it speak again', async () => {
    const w = world();
    expect((await decide(w, payload(w))).kind).toBe('speak');
    expect(await decide(w, payload(w))).toEqual({
      kind: 'silent',
      why: 'already nudged this turn',
    });
    prompt(w, '2030-01-01T11:00:00.000Z', 'keep going');
    expect((await decide(w, payload(w))).kind).toBe('speak');
    expect((await decide(w, payload(w))).kind).toBe('silent');
  });

  test('the hook prints ONE hook-JSON line whose context is the nudge, mirrored to Justin; silent prints nothing', async () => {
    const w = world();
    const out: string[] = [];
    const spy = spyOn(console, 'log').mockImplementation(
      (...args: unknown[]) => {
        out.push(args.join(' '));
      },
    );
    spies.push(spy);
    expect(
      await runThreadNudgeHook({env: w.env, now: NOW, stdin: payload(w)}),
    ).toBe(0);
    expect(out).toHaveLength(1);
    const json = JSON.parse(out[0] ?? '{}') as {
      hookSpecificOutput: {additionalContext: string; hookEventName: string};
      systemMessage: string;
    };
    expect(json.hookSpecificOutput).toEqual({
      additionalContext: NUDGE_LINE,
      hookEventName: 'PostToolUse',
    });
    expect(json.systemMessage).toBe(NUDGE_LINE);
    expect(
      await runThreadNudgeHook({env: w.env, now: NOW, stdin: payload(w)}),
    ).toBe(0);
    expect(out).toHaveLength(1);
    expect(
      await runThreadNudgeHook({env: w.env, now: NOW, stdin: 'not json'}),
    ).toBe(0);
    expect(out).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// F8 (home-base-vzwbj.4.9): the REAL entry point answers a non-commit payload
// before the command tree loads, and still hands a commit to the full hook.
// ---------------------------------------------------------------------------

describe('thread nudge: the CLI fast path (src/cli.ts)', () => {
  const cli = join(import.meta.dir, '..', 'src', 'cli.ts');
  function runCli(w: World, args: string[], stdin: string) {
    const run = Bun.spawnSync([process.execPath, cli, ...args], {
      cwd: w.repo,
      env: {...process.env, ...w.env},
      stdin: Buffer.from(stdin),
    });
    return {
      code: run.exitCode,
      stderr: run.stderr.toString(),
      stdout: run.stdout.toString(),
    };
  }

  test('a non-commit Bash payload exits 0, prints nothing, and never loads the command tree', () => {
    const w = world();
    const run = runCli(
      w,
      ['thread', 'nudge', '--explain'],
      payload(w, {}, 'ls -la'),
    );
    expect(run.code).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('fast path: the command tree was not loaded');
  });

  test('a commit payload is handed, already read, to the full hook, which speaks', () => {
    const w = world();
    const run = runCli(w, ['thread', 'nudge', '--explain'], payload(w));
    expect(run.code).toBe(0);
    expect(run.stderr).not.toContain('fast path');
    const json = JSON.parse(run.stdout.trim()) as {
      hookSpecificOutput: {additionalContext: string};
    };
    expect(json.hookSpecificOutput.additionalContext).toBe(NUDGE_LINE);
  });

  test('thread nudge --help still prints the help and does nothing else', () => {
    const w = world();
    const run = runCli(w, ['thread', 'nudge', '--help'], payload(w));
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('Hook (PostToolUse, matcher Bash)');
    expect(existsSync(nudgeMarkPath(SESSION, w.env))).toBe(false);
  });
});
