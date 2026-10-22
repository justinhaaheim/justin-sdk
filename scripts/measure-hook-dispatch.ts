#!/usr/bin/env bun
/**
 * The wall time of one hook EVENT as Claude Code pays it, in both modes
 * (home-base-rtsx1.4):
 *
 *   per-handler  every handler's own entry, started in parallel the way Claude
 *                Code runs them; the event costs as long as the slowest.
 *   dispatch     the one `hook <Event>` entry, which starts the same handlers
 *                as its children.
 *
 * Each run happens in a throwaway world: an isolated XDG config (thread knobs
 * off), an isolated XDG state dir, and a project dir whose justin-sdk.config.json
 * lists every hook component but carries no componentConfig blocks, so every
 * handler takes its "not configured here" exit and writes nowhere real. What is
 * measured is therefore the fixed cost — process starts and module loading —
 * which is exactly what the dispatcher adds or saves. Modes are interleaved run
 * by run so machine drift hits both equally; the first two runs of each are
 * discarded as warm-up.
 *
 *   bun run measure:hook-dispatch [--event <Event>] [--runs N] [--json]
 */

import {spawn} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

import {
  DISPATCHED_EVENTS,
  type DispatchedEvent,
  HOOK_HANDLERS,
  isDispatchedEvent,
  selectHandlers,
} from '../src/hook-registry';

const HELP = `measure-hook-dispatch — wall time of one hook event, per-handler vs dispatch

Usage: bun run measure:hook-dispatch [--event <Event>] [--runs N] [--json]

  --event   One of ${DISPATCHED_EVENTS.join(', ')} (default: every one)
  --runs    Timed runs per mode, after 2 warm-up runs (default 15)
  --json    Print the results as JSON

Runs in a throwaway XDG config/state and project dir, so no real session,
thread or bead is touched. Measures process start and module loading.`;

const CLI = resolve(import.meta.dir, '..', 'src', 'cli.ts');

const COMPONENTS = [
  ...new Set(HOOK_HANDLERS.map((handler) => handler.component)),
];

function parseArgs(argv: string[]): {
  events: DispatchedEvent[];
  json: boolean;
  runs: number;
} {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    process.exit(0);
  }
  const value = (flag: string): string | null => {
    const at = argv.indexOf(flag);
    return at === -1 ? null : (argv[at + 1] ?? null);
  };
  const event = value('--event');
  if (event != null && !isDispatchedEvent(event)) {
    console.error(`unknown --event ${event}\n\n${HELP}`);
    process.exit(2);
  }
  const runs = Number(value('--runs') ?? '15');
  if (!Number.isInteger(runs) || runs < 1) {
    console.error(`--runs must be a positive integer\n\n${HELP}`);
    process.exit(2);
  }
  return {
    events: event == null ? [...DISPATCHED_EVENTS] : [event],
    json: argv.includes('--json'),
    runs,
  };
}

/** Run argv with the payload on stdin; resolve its wall time in ms. */
function timeOne(
  argv: string[],
  payload: string,
  env: Record<string, string | undefined>,
): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const started = performance.now();
    const child = spawn(argv[0] ?? process.execPath, argv.slice(1), {
      env,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.on('error', reject);
    child.on('close', () => resolvePromise(performance.now() - started));
    child.stdin.on('error', () => {
      // A handler that exits before reading stdin is still a valid timing.
    });
    child.stdin.end(payload);
  });
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

async function measureEvent(
  event: DispatchedEvent,
  runs: number,
  world: {env: Record<string, string | undefined>; project: string},
) {
  const toolName = event === 'PostToolUse' ? 'Bash' : null;
  const payload = JSON.stringify({
    cwd: world.project,
    hook_event_name: event,
    session_id: '00000000-0000-4000-8000-000000000000',
    ...(toolName == null
      ? {}
      : {tool_input: {command: 'ls'}, tool_name: toolName}),
  });
  const handlers = selectHandlers({components: COMPONENTS, event, toolName});

  const perHandler: number[] = [];
  const dispatch: number[] = [];
  for (let run = 0; run < runs + 2; run += 1) {
    const separate = await Promise.all(
      handlers.map((handler) =>
        timeOne([process.execPath, CLI, ...handler.args], payload, world.env),
      ),
    );
    const one = await timeOne(
      [process.execPath, CLI, 'hook', event],
      payload,
      world.env,
    );
    if (run < 2) continue;
    perHandler.push(Math.max(0, ...separate));
    dispatch.push(one);
  }
  return {
    dispatchMedianMs: Math.round(median(dispatch)),
    event,
    handlers: handlers.map((handler) => handler.id),
    perHandlerMedianMs: Math.round(median(perHandler)),
    runs,
  };
}

async function main(): Promise<void> {
  const {events, json, runs} = parseArgs(process.argv.slice(2));
  const root = mkdtempSync(join(tmpdir(), 'measure-hook-dispatch-'));
  try {
    const project = join(root, 'project');
    mkdirSync(project, {recursive: true});
    writeFileSync(
      join(project, 'justin-sdk.config.json'),
      `${JSON.stringify({components: COMPONENTS.filter((c) => c !== 'base-setup')})}\n`,
    );
    const env = {
      ...process.env,
      CLAUDE_PROJECT_DIR: project,
      JUSTIN_SDK_HEALTH_NOTICES: 'off',
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_STATE_HOME: join(root, 'state'),
    };

    const results = [];
    for (const event of events) {
      results.push(await measureEvent(event, runs, {env, project}));
    }

    if (json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }
    for (const result of results) {
      console.log(`\n  ${result.event}\n`);
      console.log(`    handlers:      ${result.handlers.join(', ')}`);
      console.log(
        `    per-handler:   ${result.perHandlerMedianMs} ms (median of ${result.runs}, slowest of the parallel set)`,
      );
      console.log(
        `    dispatch:      ${result.dispatchMedianMs} ms (median of ${result.runs})`,
      );
    }
    console.log('');
  } finally {
    rmSync(root, {force: true, recursive: true});
  }
}

await main();
