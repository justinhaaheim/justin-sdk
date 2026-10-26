/**
 * hook-dispatch — `justin-sdk hook <Event>`, the one settings.json entry per
 * event that a dispatch-mode repo carries (home-base-rtsx1.1).
 *
 * Justin, 2026-10-17: "instead of hardcoding what the hooks configuration is
 * [...] dynamically check what the hooks configuration should be based on some
 * config (maybe something in the justin-sdk config file?)". Claude Code hooks
 * are static JSON, so this is the only shape that idea can take: a fixed entry
 * that decides at RUNTIME, from justin-sdk.config.json, which handlers run.
 *
 * WHAT ONE RUN DOES
 *  1. Reads the hook payload from stdin, once.
 *  2. Finds the repo: CLAUDE_PROJECT_DIR, else the payload's cwd, else this
 *     process's cwd. Reads its justin-sdk.config.json and resolves the
 *     components with `resolveComponents`, so an absent `components` key still
 *     means `core`.
 *  3. Picks every handler in `hook-registry.ts` registered for this event whose
 *     component the repo has and whose matcher accepts the payload's tool.
 *  4. Runs them as child processes of the SAME bun and the SAME cli.ts, in
 *     parallel, each fed the payload verbatim, with health notices silenced.
 *  5. Prints ONE merged output (`mergeHandlerOutputs` in hook-output.ts).
 *
 * WHY CHILD PROCESSES (epic D1). The handlers are untouched: each still reads
 * its own stdin and prints its own JSON, so its behaviour is exactly what its
 * per-handler entry produced. Latency is the slowest handler plus one
 * dispatcher start, because the children run in parallel as Claude Code ran
 * the separate entries. Running a handler in-process instead is a later,
 * per-handler optimisation; capturing a handler's stdout by patching
 * console.log was rejected (session-start used that pattern and it was removed
 * as fragile).
 *
 * WHY THE SAME cli.ts. It is resolved next to THIS module, not from
 * process.argv, so a child always runs the SDK version the dispatcher belongs
 * to — the project root's pinned one under the entry's `bun run --cwd
 * "${CLAUDE_PROJECT_DIR:-.}" justin-sdk` (home-base-rtsx1.6).
 *
 * WHERE A HANDLER RUNS. That `--cwd` moves THIS process to the project root,
 * while Claude Code runs a hook in the session's current directory, and some
 * handlers read process.cwd(). So each child is started in the payload's cwd
 * (where Claude is) when that directory exists, else in this process's cwd —
 * Claude Code's own fallback when the current directory is gone. The handlers
 * therefore see the same directory a per-handler entry gave them.
 *
 * TIME LIMITS. Claude Code discards ALL of a hook's output when the hook hits
 * its timeout ("Claude Code cancels a command [...] hook that reaches its
 * timeout, discarding the hook's output", hooks reference, read 2026-10-17).
 * The default is 600 s, lowered to 30 s on UserPromptSubmit. So one hung
 * handler would silently cost every other handler its output; each child is
 * stopped below that limit instead, and named in the merged message.
 *
 * NOTHING IS GUESSED. A missing or unreadable config, or components that cannot
 * be resolved, runs NO handler and says so in systemMessage (critical rule 7:
 * "could not read the config" is not "this repo has no components").
 */

import {spawn} from 'child_process';
import {existsSync, readFileSync, statSync} from 'fs';
import {join} from 'path';
import {fileURLToPath} from 'url';

import {resolveComponents} from './component-registry';
import {PROJECT_CONFIG_FILENAME, silencedChildEnv} from './health-notices';
import {
  type HandlerRunResult,
  hookOutputJson,
  type MergedHookOutput,
  mergeHandlerOutputs,
} from './hook-output';
import {
  DISPATCHED_EVENTS,
  type DispatchedEvent,
  type HookHandler,
  isDispatchedEvent,
  selectHandlers,
} from './hook-registry';
import {writeStdout} from './write-stdout';

type Env = Record<string, string | undefined>;

/**
 * How long one handler may run before it is stopped, per event. Each is below
 * Claude Code's own per-hook timeout for that event (30 s on UserPromptSubmit,
 * 600 s elsewhere), with room for the dispatcher to print the merged output.
 * The 120 s elsewhere is deliberately far under 600 s: no handler here
 * legitimately runs for minutes, and a turn end held for ten minutes by one
 * hung child is worse than a named failure.
 */
export function handlerTimeoutMs(event: DispatchedEvent): number {
  return event === 'UserPromptSubmit' ? 25_000 : 120_000;
}

/** The argv that runs one SDK command in a child: this bun, this SDK's cli.ts. */
export function defaultHandlerCommand(): string[] {
  return [
    process.execPath,
    fileURLToPath(new URL('./cli.ts', import.meta.url)),
  ];
}

/** The two payload fields the dispatcher itself needs. */
function payloadFields(stdin: string): {
  cwd: string | null;
  toolName: string | null;
} {
  try {
    const parsed: unknown = JSON.parse(stdin);
    if (parsed == null || typeof parsed !== 'object') {
      return {cwd: null, toolName: null};
    }
    const fields = parsed as {cwd?: unknown; tool_name?: unknown};
    return {
      cwd:
        typeof fields.cwd === 'string' && fields.cwd !== '' ? fields.cwd : null,
      toolName:
        typeof fields.tool_name === 'string' && fields.tool_name !== ''
          ? fields.tool_name
          : null,
    };
  } catch {
    return {cwd: null, toolName: null};
  }
}

/**
 * The directory each handler child runs in (home-base-rtsx1.6): the payload's
 * cwd when it names an existing directory, else this process's cwd. See WHERE
 * A HANDLER RUNS above.
 */
export function handlerCwd(stdin: string): string {
  const {cwd} = payloadFields(stdin);
  if (cwd != null) {
    try {
      if (statSync(cwd).isDirectory()) return cwd;
    } catch {
      // Gone or unreadable: fall through to Claude Code's own fallback.
    }
  }
  return process.cwd();
}

export type DispatchPlan =
  | {
      componentSource: 'config' | 'core';
      handlers: HookHandler[];
      ok: true;
      projectRoot: string;
    }
  | {ok: false; projectRoot: string | null; reason: string};

/**
 * Which handlers this event runs in this repo, without running any. Shared by
 * the real run and by `--dry-run` (which doctor uses), so the two cannot
 * disagree.
 */
export function planDispatch(args: {
  env: Env;
  event: string;
  handlers?: readonly HookHandler[];
  stdin: string;
}): DispatchPlan {
  const {cwd, toolName} = payloadFields(args.stdin);
  const projectDir = args.env.CLAUDE_PROJECT_DIR;
  const projectRoot =
    projectDir != null && projectDir !== ''
      ? projectDir
      : (cwd ?? process.cwd());

  if (!isDispatchedEvent(args.event)) {
    return {
      ok: false,
      projectRoot,
      reason: `${args.event} is not a dispatched event (the dispatched events are ${DISPATCHED_EVENTS.join(', ')})`,
    };
  }

  const configPath = join(projectRoot, PROJECT_CONFIG_FILENAME);
  if (!existsSync(configPath)) {
    return {ok: false, projectRoot, reason: `no ${configPath}`};
  }
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    return {
      ok: false,
      projectRoot,
      reason: `could not read ${configPath} (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  const resolved = resolveComponents(config, projectRoot);
  if (!resolved.ok) {
    return {ok: false, projectRoot, reason: resolved.reason};
  }

  return {
    componentSource: resolved.source,
    handlers: selectHandlers({
      components: resolved.components,
      event: args.event,
      ...(args.handlers == null ? {} : {handlers: args.handlers}),
      toolName,
    }),
    ok: true,
    projectRoot,
  };
}

/** Run one handler child to completion, or until its time limit. Never throws. */
function runHandler(args: {
  command: readonly string[];
  /** The child's working directory: `handlerCwd(stdin)`. */
  cwd: string;
  env: Env;
  handler: HookHandler;
  stdin: string;
  timeoutMs: number;
}): Promise<HandlerRunResult> {
  const {handler, timeoutMs} = args;
  return new Promise((resolvePromise) => {
    const result: HandlerRunResult = {
      exitCode: null,
      id: handler.id,
      spawnError: null,
      stderr: '',
      stdout: '',
      timedOut: false,
      timeoutMs,
    };
    const [bin, ...prefix] = args.command;
    if (bin == null) {
      resolvePromise({...result, spawnError: 'no handler command configured'});
      return;
    }

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = (patch: Partial<HandlerRunResult>): void => {
      if (settled) return;
      settled = true;
      if (timer != null) clearTimeout(timer);
      resolvePromise({...result, ...patch});
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, [...prefix, ...handler.args], {
        cwd: args.cwd,
        env: silencedChildEnv(args.env),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolvePromise({
        ...result,
        spawnError: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    timer = setTimeout(() => {
      result.timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      result.stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      result.stderr += chunk;
    });
    child.on('error', (error) => {
      settle({spawnError: error.message});
    });
    // 'close', not 'exit': it fires after stdout and stderr have both ended,
    // so nothing the handler printed is lost.
    child.on('close', (code) => {
      settle(result.timedOut ? {timedOut: true} : {exitCode: code});
    });

    // A handler that exits before reading its stdin makes this write fail with
    // EPIPE; that is the handler's business, not a dispatch failure.
    child.stdin?.on('error', () => {
      // Deliberately ignored: the handler's exit code and output say the rest.
    });
    child.stdin?.end(args.stdin);
  });
}

/** A Justin-only notice in the hook's JSON, for a dispatch that ran nothing. */
function noticeOutput(event: string, text: string): MergedHookOutput {
  const json = hookOutputJson({event, forClaude: '', forJustin: text});
  return {
    exitCode: 0,
    stderr: '',
    stdout: json == null ? '' : `${JSON.stringify(json)}\n`,
  };
}

export async function runHookDispatch(args: {
  env?: Env;
  event: string;
  /** The argv prefix that runs one SDK command; tests point it at a fake. */
  handlerCommand?: readonly string[];
  handlers?: readonly HookHandler[];
  stdin: string;
  /** Overrides `handlerTimeoutMs`; tests use it to exercise the time limit. */
  timeoutMs?: number;
}): Promise<MergedHookOutput> {
  const env = args.env ?? process.env;
  const plan = planDispatch({
    env,
    event: args.event,
    ...(args.handlers == null ? {} : {handlers: args.handlers}),
    stdin: args.stdin,
  });
  if (!plan.ok) {
    return noticeOutput(
      args.event,
      `⚠️ justin-sdk hook ${args.event}: no handlers ran — ${plan.reason}`,
    );
  }
  if (plan.handlers.length === 0) {
    return {exitCode: 0, stderr: '', stdout: ''};
  }

  const command = args.handlerCommand ?? defaultHandlerCommand();
  const timeoutMs =
    args.timeoutMs ??
    handlerTimeoutMs(
      args.event as DispatchedEvent /* checked by planDispatch */,
    );
  const cwd = handlerCwd(args.stdin);
  const runs = await Promise.all(
    plan.handlers.map((handler) =>
      runHandler({command, cwd, env, handler, stdin: args.stdin, timeoutMs}),
    ),
  );
  return mergeHandlerOutputs(args.event, runs);
}

/** `--dry-run`: what this event would run here, as JSON, spawning nothing. */
export function renderDispatchPlan(args: {
  env?: Env;
  event: string;
  stdin: string;
}): {exitCode: 0 | 1; stdout: string} {
  const plan = planDispatch({
    env: args.env ?? process.env,
    event: args.event,
    stdin: args.stdin,
  });
  const body = plan.ok
    ? {
        componentSource: plan.componentSource,
        event: args.event,
        handlers: plan.handlers.map((h) => h.id),
        ok: true,
        projectRoot: plan.projectRoot,
      }
    : {
        event: args.event,
        ok: false,
        projectRoot: plan.projectRoot,
        reason: plan.reason,
      };
  return {
    exitCode: plan.ok ? 0 : 1,
    stdout: `${JSON.stringify(body, null, 2)}\n`,
  };
}

/** The CLI entry: read stdin once, dispatch, print, and return the exit code. */
export async function runHookCommand(args: {
  dryRun: boolean;
  event: string;
}): Promise<number> {
  // A terminal is skipped so `hook <Event> --dry-run` typed by hand does not
  // sit waiting for input; Claude Code and doctor always pipe a payload (or
  // nothing) in.
  let stdin = '';
  if (process.stdin.isTTY !== true) {
    try {
      stdin = readFileSync(0, 'utf8');
    } catch {
      stdin = '';
    }
  }
  if (args.dryRun) {
    const plan = renderDispatchPlan({event: args.event, stdin});
    await writeStdout(plan.stdout);
    return plan.exitCode;
  }
  const merged = await runHookDispatch({event: args.event, stdin});
  // Awaited writes, because the caller exits right after and this process has
  // just run several children: the shape write-stdout.ts was written for.
  if (merged.stderr !== '') await Bun.write(Bun.stderr, merged.stderr);
  if (merged.stdout !== '') await writeStdout(merged.stdout);
  return merged.exitCode;
}
