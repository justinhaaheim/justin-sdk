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
  lastRequestMarkPath,
  messageLogPath,
  nudgeMarkPath,
  sessionIndexPath,
} from '../src/thread/archive';
import {
  type MessageLine,
  serializeMessageLine,
} from '../src/thread/message-log';
import {
  brCloseIds,
  brRefusedIds,
  decideLastRequestNudge,
  decideNudge,
  lastRequestLine,
  lastRequestNudgeLine,
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
// The last-request warning (home-base-yukaf.3, D-LAST-REQUEST-WARNING)
// ---------------------------------------------------------------------------

describe('thread nudge: brCloseIds reads the ids a br close names', () => {
  test('ids, global options, option values, quoting, --help and other verbs', () => {
    expect(brCloseIds('br close home-base-abcde --reason "done"')).toEqual([
      'home-base-abcde',
    ]);
    expect(
      brCloseIds(
        "br --db /x/.beads/beads.db close t-1.2 t-3 --reason='not needed: t-9'",
      ),
    ).toEqual(['t-1.2', 't-3']);
    // An unquoted reason that has the id shape is a VALUE, not an id.
    expect(brCloseIds('br close t-4 --reason not-needed -fr also-not')).toEqual(
      ['t-4'],
    );
    expect(brCloseIds('cd /repo && br close t-5 && git status')).toEqual([
      't-5',
    ]);
    expect(brCloseIds('echo "br close t-6"')).toEqual([]);
    expect(brCloseIds('br close --help t-7')).toEqual([]);
    expect(brCloseIds('br close')).toEqual([]);
    expect(brCloseIds('br show t-8 && br update t-8 --status closed')).toEqual(
      [],
    );
    expect(brCloseIds('bun run br:set-field t-9 --field notes')).toEqual([]);
  });

  test('F14: comments, echo and other non-command br words close nothing', () => {
    expect(brCloseIds('# br close t-1 later')).toEqual([]);
    expect(brCloseIds('git status # then br close t-2')).toEqual([]);
    expect(brCloseIds('git status\n# br close t-3\nbr show t-3')).toEqual([]);
    // A comment hides the rest of its line, separators included.
    expect(brCloseIds('git status # tidy; br close t-11 next')).toEqual([]);
    expect(brCloseIds('git status # tidy\nbr close t-12')).toEqual(['t-12']);
    expect(brCloseIds('echo br close t-4')).toEqual([]);
    expect(brCloseIds('grep -n br close.ts t-5')).toEqual([]);
    // A `#` inside a word is no comment.
    expect(brCloseIds('br close t-6 --reason fixed#7')).toEqual(['t-6']);
    // The command word may follow env assignments, a path, or $( … ).
    expect(brCloseIds('BR_ACTOR=me br close t-7')).toEqual(['t-7']);
    expect(brCloseIds('/opt/homebrew/bin/br close t-8')).toEqual(['t-8']);
    expect(brCloseIds('x=$(br close t-9)')).toEqual(['t-9']);
    expect(brCloseIds('br close t-10 2>&1 | tail -3')).toEqual(['t-10']);
  });

  test('F14: br update --status closed is no close (br refuses it)', () => {
    expect(brCloseIds('br update t-1 --status closed')).toEqual([]);
    expect(brCloseIds('br update t-1 --status=closed -s closed')).toEqual([]);
  });

  test('F14: brRefusedIds reads the ids br says it did not close', () => {
    const output = [
      '✓ Closed probe-ue6.1: Child (test)',
      'Warning: Skipped probe-ue6: epic has 1/1 open children (use --force to close anyway)',
      'Error: Partially applied: 1 closed, 1 skipped — probe-ue6: epic has 1/1 open children',
      'Error: Issue not found: probe-nope',
    ].join('\n');
    expect([...brRefusedIds(output)].sort()).toEqual([
      'probe-nope',
      'probe-ue6',
    ]);
    expect(brRefusedIds('✓ Closed t-1: Tidy (done)').size).toBe(0);
  });
});

describe('thread nudge: the last-request warning', () => {
  async function request(w: World, title: string): Promise<string> {
    const filed = await fileRequest({
      bead: null,
      cwd: w.repo,
      doneWhen: null,
      env: w.env,
      here: false,
      now: NOW,
      sessionId: null,
      title,
    });
    if (filed.kind !== 'filed') throw new Error(JSON.stringify(filed));
    return filed.id;
  }

  function close(w: World, id: string): void {
    const closed = runBr(w.repo, ['close', id, '--reason', 'done']);
    if (!closed.ok) throw new Error(closed.reason ?? 'br close failed');
  }

  const closeCommand = (id: string): string =>
    `br close ${id} --reason "built and tested"`;

  async function decideLast(w: World, command: string) {
    return await decideLastRequestNudge({
      env: w.env,
      now: NOW,
      raw: payload(w, {}, command),
    });
  }

  test('closing the last open request speaks, naming it, and marks the turn', async () => {
    const w = world();
    const id = await request(w, 'Tidy the docs');
    close(w, id);
    const decision = await decideLast(w, closeCommand(id));
    expect(decision).toEqual({
      closedIds: [id],
      kind: 'speak',
      marked: true,
      titles: ['Tidy the docs'],
      unchecked: null,
      why: 'closed the last open request of this session',
    });
    if (decision.kind !== 'speak') return;
    expect(lastRequestNudgeLine(decision)).toBe(
      `[thread] you closed the last open request in this session ("Tidy the docs"). Before you stop: re-read Justin's first message — does everything he asked for exist, or is it answered in your message? If anything is missing, even a conditional or uncertain ask, file it: bun run justin-sdk thread request "…"`,
    );
    expect(existsSync(lastRequestMarkPath(SESSION, w.env))).toBe(true);
    // Its own marker: the commit nudge's is untouched.
    expect(existsSync(nudgeMarkPath(SESSION, w.env))).toBe(false);
  });

  test('F14: a close br refused, its exit code hidden by a later step, is silent', async () => {
    const w = world();
    const id = await request(w, 'Tidy the docs');
    // The export says the request is still open, and br said why.
    const decision = await decideLastRequestNudge({
      env: w.env,
      now: NOW,
      raw: payload(
        w,
        {
          tool_response: {
            stderr: `Warning: Skipped ${id}: blocked by 1 open dependency\nError: Nothing to do: all 1 issue(s) skipped`,
            stdout: 'done',
          },
        },
        `br close ${id} --reason "built"; echo done`,
      ),
    });
    expect(decision).toEqual({
      kind: 'silent',
      why: `br refused the close (${id})`,
    });
    expect(existsSync(lastRequestMarkPath(SESSION, w.env))).toBe(false);
  });

  test('the export not yet flushed: the ids just closed count as closed', async () => {
    const w = world();
    const id = await request(w, 'Tidy the docs');
    // No close ran: the export still says in_progress.
    const decision = await decideLast(w, closeCommand(id));
    expect(decision.kind).toBe('speak');
  });

  test('closing a request while another is still open is silent', async () => {
    const w = world();
    const first = await request(w, 'Tidy the docs');
    const second = await request(w, 'Fix the broken links');
    close(w, first);
    expect(await decideLast(w, closeCommand(first))).toEqual({
      kind: 'silent',
      why: `1 request of this session still open (${second})`,
    });
  });

  test('closing a bead that is no request of this session is silent, even with every request closed', async () => {
    const w = world();
    const id = await request(w, 'Tidy the docs');
    close(w, id);
    const created = runBr(w.repo, [
      'create',
      'A follow-up task',
      '-t',
      'task',
      '--silent',
    ]);
    if (!created.ok) throw new Error(created.reason ?? 'br create failed');
    const other = created.stdout.trim();
    close(w, other);
    expect(await decideLast(w, closeCommand(other))).toEqual({
      kind: 'silent',
      why: `closed no request of this session (${other})`,
    });
  });

  test('once per turn: a second close in the same turn is silent; a new prompt speaks again', async () => {
    const w = world();
    const id = await request(w, 'Tidy the docs');
    close(w, id);
    expect((await decideLast(w, closeCommand(id))).kind).toBe('speak');
    expect(await decideLast(w, closeCommand(id))).toEqual({
      kind: 'silent',
      why: 'already warned this turn',
    });
    prompt(w, '2030-01-01T11:00:00.000Z', 'keep going');
    expect((await decideLast(w, closeCommand(id))).kind).toBe('speak');
  });

  test('rule 7: an unreadable export speaks the variant — never the claim, never silence', async () => {
    const w = world();
    const id = await request(w, 'Tidy the docs');
    const exportPath = join(w.repo, '.beads', 'issues.jsonl');
    rmSync(exportPath, {force: true});
    mkdirSync(exportPath); // a directory: EISDIR on read
    const decision = await decideLast(w, closeCommand(id));
    expect(decision.kind).toBe('speak');
    if (decision.kind !== 'speak') return;
    const line = lastRequestNudgeLine(decision);
    expect(line).toStartWith(
      `[thread] you closed ${id}; I could not check whether that was the last open request in this session (`,
    );
    expect(line).toContain(exportPath);
    expect(line).not.toContain('you closed the last open request');
  });

  test('no session bead, a subagent, or the knob off → silent', async () => {
    const bare = world({sessionBead: false});
    expect(await decideLast(bare, closeCommand('t-1'))).toEqual({
      kind: 'silent',
      why: 'no session bead for this session',
    });
    const w = world();
    const id = await request(w, 'Tidy the docs');
    close(w, id);
    expect(
      (
        await decideLastRequestNudge({
          env: w.env,
          now: NOW,
          raw: payload(w, {agent_id: 'a1b2'}, closeCommand(id)),
        })
      ).why,
    ).toContain('subagent');
    const off = world({
      knobs: {enabled: true, nudge: false, sessionBeads: true},
    });
    expect((await decideLast(off, closeCommand('t-1'))).why).toBe(
      'knob off (sessionBeads=true, nudge=false)',
    );
  });

  test('the hook prints both lines as one context block when a command commits and closes the last request', async () => {
    const w = world();
    const id = await request(w, 'Tidy the docs');
    close(w, id);
    const out: string[] = [];
    spies.push(
      spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        out.push(args.join(' '));
      }),
    );
    const command = `${closeCommand(id)} && git commit -qm 'docs: tidy'`;
    expect(
      await runThreadNudgeHook({
        env: w.env,
        now: NOW,
        stdin: payload(w, {}, command),
      }),
    ).toBe(0);
    expect(out).toHaveLength(1);
    const json = JSON.parse(out[0] ?? '{}') as {
      hookSpecificOutput: {additionalContext: string};
    };
    expect(json.hookSpecificOutput.additionalContext).toBe(
      `${NUDGE_LINE}\n${lastRequestLine(['Tidy the docs'])}`,
    );
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

  test('a br close payload is handed to the full hook too (home-base-yukaf.3)', async () => {
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
    if (filed.kind !== 'filed') throw new Error('not filed');
    const run = runCli(
      w,
      ['thread', 'nudge', '--explain'],
      payload(w, {}, `br close ${filed.id} --reason "done"`),
    );
    expect(run.code).toBe(0);
    expect(run.stderr).not.toContain('fast path');
    expect(run.stderr).toContain(
      'thread nudge (last request): speak — closed the last open request of this session',
    );
    const json = JSON.parse(run.stdout.trim()) as {
      hookSpecificOutput: {additionalContext: string};
    };
    expect(json.hookSpecificOutput.additionalContext).toBe(
      lastRequestLine(['Tidy the docs']),
    );
  });

  test('thread nudge --help still prints the help and does nothing else', () => {
    const w = world();
    const run = runCli(w, ['thread', 'nudge', '--help'], payload(w));
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('Hook (PostToolUse, matcher Bash)');
    expect(existsSync(nudgeMarkPath(SESSION, w.env))).toBe(false);
  });
});
