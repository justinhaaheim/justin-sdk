/**
 * `justin-sdk hook <Event>`, the dispatcher (home-base-rtsx1.1): which handlers
 * it picks, how it merges their output, and what it does when one fails.
 *
 * The handlers here are tests/fixtures/fake-hook-handler.ts, run as real child
 * processes, so spawning, piping and the time limit are all exercised for
 * real. The last block runs the real CLI with the real registry, through
 * cli.ts's fast path, in --dry-run mode, so no real handler ever runs.
 */

import {afterEach, describe, expect, test} from 'bun:test';
import {spawnSync} from 'child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {
  planDispatch,
  renderDispatchPlan,
  runHookDispatch,
} from '../src/hook-dispatch';
import {type HandlerRunResult, mergeHandlerOutputs} from '../src/hook-output';
import {
  type DispatchedEvent,
  HOOK_HANDLERS,
  type HookHandler,
} from '../src/hook-registry';

const FAKE = join(import.meta.dir, 'fixtures', 'fake-hook-handler.ts');
const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const FAKE_COMMAND = [process.execPath, FAKE];

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, {force: true, recursive: true});
});

/** A repo root holding a justin-sdk.config.json with these contents. */
function repo(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'hook-dispatch-'));
  dirs.push(dir);
  writeFileSync(
    join(dir, 'justin-sdk.config.json'),
    typeof config === 'string' ? config : JSON.stringify(config),
  );
  return dir;
}

function fake(
  args: string[],
  options: {
    component?: string;
    event?: DispatchedEvent;
    matcher?: string | null;
  } = {},
): HookHandler {
  return {
    args,
    command: `fake ${args.join(' ')}`,
    component: options.component ?? 'time-check-setup',
    events: [
      {
        event: options.event ?? 'UserPromptSubmit',
        matcher: options.matcher ?? null,
      },
    ],
    id: args.join(' '),
  };
}

async function dispatch(args: {
  event?: DispatchedEvent;
  handlers: HookHandler[];
  root: string;
  stdin?: string;
  timeoutMs?: number;
}) {
  return await runHookDispatch({
    env: {...process.env, CLAUDE_PROJECT_DIR: args.root},
    event: args.event ?? 'UserPromptSubmit',
    handlerCommand: FAKE_COMMAND,
    handlers: args.handlers,
    stdin: args.stdin ?? '{}',
    ...(args.timeoutMs == null ? {} : {timeoutMs: args.timeoutMs}),
  });
}

function parse(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

const LISTED = {components: ['time-check-setup', 'thread-hooks-setup']};

describe('merging', () => {
  test('contexts and messages from several handlers arrive joined, in registry order', async () => {
    const out = await dispatch({
      handlers: [fake(['context', 'first']), fake(['context', 'second'])],
      root: repo(LISTED),
    });
    expect(out.exitCode).toBe(0);
    const json = parse(out.stdout);
    expect(json.hookSpecificOutput).toEqual({
      additionalContext: 'first\n\nsecond',
      hookEventName: 'UserPromptSubmit',
    });
    expect(json.systemMessage).toBe('first\n\nsecond');
  });

  test('silent handlers print nothing at all', async () => {
    const out = await dispatch({
      handlers: [fake(['silent']), fake(['silent'])],
      root: repo(LISTED),
    });
    expect(out).toEqual({exitCode: 0, stderr: '', stdout: ''});
  });

  test('each handler gets the payload byte for byte', async () => {
    const payload = '{"hook_event_name":"UserPromptSubmit","prompt":"héllo"}';
    const out = await dispatch({
      handlers: [fake(['echo-stdin'])],
      root: repo(LISTED),
      stdin: payload,
    });
    expect(parse(out.stdout).systemMessage).toBe(payload);
  });

  test('a Stop block exits 2 with only the blocker on stderr, and keeps the others output', async () => {
    const out = await dispatch({
      event: 'Stop',
      handlers: [
        fake(['chatty', 'captured'], {event: 'Stop'}),
        fake(['block', 'record your report first'], {event: 'Stop'}),
      ],
      root: repo(LISTED),
    });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toBe('record your report first\n');
    const json = parse(out.stdout);
    expect(json.decision).toBe('block');
    expect(json.reason).toBe('record your report first');
    expect(json.systemMessage).toBe('captured\n\nrecord your report first');
  });

  test('stderr from a handler that exited 0 is passed on, labelled, without blocking', async () => {
    const out = await dispatch({
      handlers: [fake(['chatty', 'hi'])],
      root: repo(LISTED),
    });
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toBe('[chatty hi] a diagnostic line\n');
  });
});

describe('a failing handler is named and costs nobody else their output', () => {
  test('non-zero exit', async () => {
    const out = await dispatch({
      handlers: [fake(['context', 'kept']), fake(['fail'])],
      root: repo(LISTED),
    });
    expect(out.exitCode).toBe(0);
    const json = parse(out.stdout);
    expect(json.hookSpecificOutput).toEqual({
      additionalContext: 'kept',
      hookEventName: 'UserPromptSubmit',
    });
    expect(json.systemMessage).toBe(
      'kept\n\n⚠️ justin-sdk hook UserPromptSubmit: fail failed (exit 1): boom',
    );
  });

  test('output that is not JSON', async () => {
    const out = await dispatch({
      handlers: [fake(['garbage'])],
      root: repo(LISTED),
    });
    expect(parse(out.stdout).systemMessage).toBe(
      '⚠️ justin-sdk hook UserPromptSubmit: garbage printed output that is not one JSON object',
    );
  });

  test('a handler that hangs is stopped at its time limit', async () => {
    const started = Date.now();
    const out = await dispatch({
      handlers: [fake(['message', 'fast']), fake(['hang'])],
      root: repo(LISTED),
      timeoutMs: 500,
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(out.exitCode).toBe(0);
    expect(parse(out.stdout).systemMessage).toBe(
      'fast\n\n⚠️ justin-sdk hook UserPromptSubmit: hang was stopped after 0.5 s without finishing',
    );
  });

  test('a handler that cannot start', async () => {
    const out = await runHookDispatch({
      env: {...process.env, CLAUDE_PROJECT_DIR: repo(LISTED)},
      event: 'UserPromptSubmit',
      handlerCommand: ['/nonexistent/bun-binary'],
      handlers: [fake(['message', 'x'])],
      stdin: '{}',
    });
    expect(out.exitCode).toBe(0);
    expect(String(parse(out.stdout).systemMessage)).toStartWith(
      '⚠️ justin-sdk hook UserPromptSubmit: message x did not start (',
    );
  });
});

describe('which handlers run', () => {
  test('only handlers whose component the repo has', async () => {
    const out = await dispatch({
      handlers: [
        fake(['message', 'listed'], {component: 'time-check-setup'}),
        fake(['message', 'unlisted'], {component: 'usage-check-setup'}),
      ],
      root: repo(LISTED),
    });
    expect(parse(out.stdout).systemMessage).toBe('listed');
  });

  test('an absent components key means core, so every ungated component runs', async () => {
    const out = await dispatch({
      handlers: [
        fake(['message', 'a'], {component: 'usage-check-setup'}),
        fake(['message', 'b'], {component: 'base-setup'}),
      ],
      root: repo({}),
    });
    expect(parse(out.stdout).systemMessage).toBe('a\n\nb');
  });

  test('a matcher limits a handler to its tools', async () => {
    const handlers = [
      fake(['message', 'bash only'], {event: 'PostToolUse', matcher: 'Bash'}),
    ];
    const root = repo(LISTED);
    const onBash = await dispatch({
      event: 'PostToolUse',
      handlers,
      root,
      stdin: '{"tool_name":"Bash"}',
    });
    expect(parse(onBash.stdout).systemMessage).toBe('bash only');
    const onEdit = await dispatch({
      event: 'PostToolUse',
      handlers,
      root,
      stdin: '{"tool_name":"Edit"}',
    });
    expect(onEdit.stdout).toBe('');
    // An unreadable payload must not widen a matched handler to every tool.
    const unreadable = await dispatch({
      event: 'PostToolUse',
      handlers,
      root,
      stdin: 'not json',
    });
    expect(unreadable.stdout).toBe('');
  });

  test('handlers for other events do not run', async () => {
    const out = await dispatch({
      event: 'PostToolBatch',
      handlers: [fake(['message', 'prompt only'])],
      root: repo(LISTED),
    });
    expect(out.stdout).toBe('');
  });
});

describe('nothing is guessed when the config cannot be read', () => {
  test('no config file: no handler runs, and the message says why', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hook-dispatch-'));
    dirs.push(dir);
    const out = await dispatch({handlers: [fake(['message', 'x'])], root: dir});
    expect(out.exitCode).toBe(0);
    expect(String(parse(out.stdout).systemMessage)).toStartWith(
      '⚠️ justin-sdk hook UserPromptSubmit: no handlers ran — no ',
    );
  });

  test('a config that does not parse', async () => {
    const out = await dispatch({
      handlers: [fake(['message', 'x'])],
      root: repo('{not json'),
    });
    expect(String(parse(out.stdout).systemMessage)).toContain(
      'no handlers ran — could not read',
    );
  });

  test('a components key that is not a list', async () => {
    const out = await dispatch({
      handlers: [fake(['message', 'x'])],
      root: repo({components: 'time-check-setup'}),
    });
    expect(String(parse(out.stdout).systemMessage)).toContain(
      'no handlers ran — justin-sdk.config.json "components" is not an array',
    );
  });

  test('an event the dispatcher does not handle', async () => {
    const out = await runHookDispatch({
      env: {...process.env, CLAUDE_PROJECT_DIR: repo(LISTED)},
      event: 'SessionStart',
      handlerCommand: FAKE_COMMAND,
      stdin: '{}',
    });
    expect(String(parse(out.stdout).systemMessage)).toContain(
      'SessionStart is not a dispatched event',
    );
  });
});

describe('mergeHandlerOutputs', () => {
  const ok = (id: string, stdout: string): HandlerRunResult => ({
    exitCode: 0,
    id,
    spawnError: null,
    stderr: '',
    stdout,
    timedOut: false,
    timeoutMs: 1000,
  });

  test('a handler that exits 2 with no stderr still blocks', () => {
    const out = mergeHandlerOutputs('Stop', [
      {...ok('quiet blocker', ''), exitCode: 2},
      ok('other', '{"systemMessage":"note"}'),
    ]);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toBe('');
    expect(parse(out.stdout).systemMessage).toBe('note');
  });

  test('an unknown output key is reported, not silently dropped or passed', () => {
    const out = mergeHandlerOutputs('Stop', [
      ok('x', '{"systemMessage":"hi","somethingNew":1}'),
    ]);
    expect(parse(out.stdout).systemMessage).toBe(
      'hi\n\n⚠️ justin-sdk hook Stop: x printed output keys the dispatcher does not pass on: somethingNew',
    );
  });

  test('continue: false from any handler stops Claude, with the reasons joined', () => {
    const out = mergeHandlerOutputs('Stop', [
      ok('a', '{"continue":false,"stopReason":"halt"}'),
      ok('b', '{"systemMessage":"note"}'),
    ]);
    const json = parse(out.stdout);
    expect(json.continue).toBe(false);
    expect(json.stopReason).toBe('halt');
    expect(json.systemMessage).toBe('note');
  });
});

describe('the real registry, through the real CLI, without running a handler', () => {
  function dryRun(event: string, root: string, stdin = '{}') {
    const result = spawnSync(
      process.execPath,
      [CLI, 'hook', event, '--dry-run'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: root,
          JUSTIN_SDK_HEALTH_NOTICES: 'off',
        },
        input: stdin,
      },
    );
    return {
      body: JSON.parse(result.stdout) as Record<string, unknown>,
      status: result.status,
    };
  }

  test('a core repo runs every UserPromptSubmit handler today’s entries run', () => {
    const {body, status} = dryRun('UserPromptSubmit', repo({}));
    expect(status).toBe(0);
    expect(body.handlers).toEqual([
      'repo-state --hook',
      'time-check',
      'usage-check',
      'thread capture',
    ]);
    expect(body.componentSource).toBe('core');
  });

  test('Stop, PostToolBatch and PostToolUse on Bash', () => {
    const root = repo({});
    expect(dryRun('Stop', root).body.handlers).toEqual([
      'thread capture',
      'thread stop-check',
    ]);
    expect(dryRun('PostToolBatch', root).body.handlers).toEqual([
      'usage-check',
    ]);
    expect(
      dryRun('PostToolUse', root, '{"tool_name":"Bash"}').body.handlers,
    ).toEqual(['thread nudge']);
    expect(
      dryRun('PostToolUse', root, '{"tool_name":"Read"}').body.handlers,
    ).toEqual([]);
  });

  test('a repo without thread-hooks never runs a thread handler', () => {
    const root = repo({components: ['time-check-setup']});
    expect(dryRun('Stop', root).body.handlers).toEqual([]);
    expect(dryRun('UserPromptSubmit', root).body.handlers).toEqual([
      'repo-state --hook',
      'time-check',
    ]);
  });

  test('a failed plan exits 1 with the reason, so doctor can see it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hook-dispatch-'));
    dirs.push(dir);
    const {body, status} = dryRun('Stop', dir);
    expect(status).toBe(1);
    expect(body.ok).toBe(false);
  });

  test('planDispatch and --dry-run agree', () => {
    const root = repo({});
    const env = {...process.env, CLAUDE_PROJECT_DIR: root};
    const plan = planDispatch({env, event: 'Stop', stdin: '{}'});
    const rendered = JSON.parse(
      renderDispatchPlan({env, event: 'Stop', stdin: '{}'}).stdout,
    ) as {handlers: string[]};
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.handlers.map((h) => h.id)).toEqual(rendered.handlers);
    }
    expect(HOOK_HANDLERS.length).toBeGreaterThan(0);
  });
});
