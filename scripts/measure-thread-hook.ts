#!/usr/bin/env bun
/**
 * The wall time of a thread HOOK as Claude Code pays it: a whole process,
 * module loading included — which a hook's own `--explain` timer cannot see,
 * since it starts after the imports.
 *
 *   --hook capture  (default) `thread capture`, a UserPromptSubmit payload.
 *                   home-base-vzwbj.4.9 P4: did the v4 modules capture.ts now
 *                   imports statically raise the KNOB-OFF cost?
 *   --hook nudge    `thread nudge`, a PostToolUse Bash payload whose command is
 *                   NOT a commit (`--commit` sends `git commit -m …`).
 *                   home-base-vzwbj.4.9 F8: the nudge runs after EVERY Bash
 *                   call Claude makes in an enrolled repo.
 *
 * Each target is timed in its own throwaway world: an isolated XDG config with
 * `thread.enabled` and `thread.capture` on and `sessionBeads` OFF (pass
 * `--session-beads` for on), an isolated state dir, a project dir with no
 * justin-sdk.config.json, and a threads repo that does not exist, so the
 * detached child the capture hook spawns fails at once and writes nowhere real.
 * Targets are interleaved run by run so machine drift hits them equally; the
 * first two runs of each are discarded as warm-up.
 *
 * A target is `--cli <path>` (runs `bun <path> thread <hook>`) or
 * `--bun-run <dir>` (runs `bun run justin-sdk thread <hook>` from <dir>, the
 * hook command exactly as thread-hooks-setup installs it). With neither it
 * times this checkout's src/cli.ts. To compare against an older commit,
 * extract that commit's pkg/justin-sdk somewhere (`git archive`), symlink this
 * checkout's node_modules into it, and pass both CLIs.
 *
 *   bun run measure:thread-hook [--hook capture|nudge] [--commit] [--cli <path>]... [--bun-run <dir>]... [--runs N] [--session-beads] [--json]
 */

import {spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

const HELP = `measure-thread-hook — wall time of a thread hook, module loading included

Usage: bun run measure:thread-hook [--hook capture|nudge] [--commit] [--cli <path>]... [--bun-run <dir>]... [--runs N] [--session-beads] [--json]

  --hook capture|nudge  which hook (default capture)
  --commit              nudge only: send a git commit command (default: ls -la)
  --cli <path>          a justin-sdk src/cli.ts to time with bun <path> (repeatable)
  --bun-run <dir>       time bun run justin-sdk from <dir>, the installed hook command (repeatable)
  --runs N              timed runs per target after 2 warm-up runs (default 20)
  --session-beads       time with componentConfig.thread.sessionBeads ON (default OFF)
  --json                print the numbers as JSON

With no --cli and no --bun-run, times this checkout's src/cli.ts.
Writes only inside throwaway directories under the OS temp dir.`;

type Hook = 'capture' | 'nudge';

interface Target {
  /** The argv after `bun`, before `thread <hook>`. */
  argv: string[];
  cwd: string | null;
  label: string;
}

interface Args {
  commit: boolean;
  hook: Hook;
  json: boolean;
  runs: number;
  sessionBeads: boolean;
  targets: Target[];
}

function parseArgs(argv: string[]): Args | null {
  const args: Args = {
    commit: false,
    hook: 'capture',
    json: false,
    runs: 20,
    sessionBeads: false,
    targets: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--help' || arg === '-h') return null;
    if (arg === '--json') args.json = true;
    else if (arg === '--commit') args.commit = true;
    else if (arg === '--session-beads') args.sessionBeads = true;
    else if (arg === '--hook' && (next === 'capture' || next === 'nudge')) {
      args.hook = next;
      index += 1;
    } else if (arg === '--cli' && next != null) {
      const path = resolve(next);
      args.targets.push({argv: [path], cwd: null, label: `bun ${path}`});
      index += 1;
    } else if (arg === '--bun-run' && next != null) {
      const dir = resolve(next);
      args.targets.push({
        argv: ['run', 'justin-sdk'],
        cwd: dir,
        label: `bun run justin-sdk (from ${dir})`,
      });
      index += 1;
    } else if (arg === '--runs' && next != null && /^\d+$/.test(next)) {
      args.runs = Number(next);
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg ?? ''}`);
    }
  }
  if (args.targets.length === 0) {
    const path = resolve(import.meta.dirname, '..', 'src', 'cli.ts');
    args.targets.push({argv: [path], cwd: null, label: `bun ${path}`});
  }
  return args;
}

interface World {
  env: Record<string, string>;
  projectDir: string;
  root: string;
}

function makeWorld(sessionBeads: boolean): World {
  const root = mkdtempSync(join(tmpdir(), 'measure-thread-hook-'));
  const xdg = join(root, 'xdg');
  mkdirSync(join(xdg, 'justin-sdk'), {recursive: true});
  writeFileSync(
    join(xdg, 'justin-sdk', 'config.json'),
    JSON.stringify({
      componentConfig: {thread: {capture: true, enabled: true, sessionBeads}},
    }),
  );
  const projectDir = join(root, 'project');
  mkdirSync(projectDir, {recursive: true});
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('CMUX_')) env[key] = value;
  }
  Object.assign(env, {
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    JUSTIN_SDK_HEALTH_NOTICES: 'off',
    JUSTIN_THREADS_REPO_DIR: join(root, 'no-threads-repo'),
    JUSTIN_THREADS_STATE_DIR: join(root, 'state'),
    JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(root, 'no-transcripts'),
    XDG_CONFIG_HOME: xdg,
  });
  return {env, projectDir, root};
}

const SESSION = '0f0f0f0f-1111-4222-8333-444455556666';

function payloadFor(args: Args, world: World, run: number): string {
  if (args.hook === 'nudge') {
    return JSON.stringify({
      cwd: world.projectDir,
      hook_event_name: 'PostToolUse',
      session_id: SESSION,
      tool_input: {
        command: args.commit ? `git commit -m 'run ${run}'` : 'ls -la',
      },
      tool_name: 'Bash',
      tool_response: {stdout: ''},
    });
  }
  return JSON.stringify({
    cwd: world.projectDir,
    hook_event_name: 'UserPromptSubmit',
    prompt: `measure run ${run}`,
    session_id: SESSION,
    transcript_path: join(world.root, 'no-transcripts', `${SESSION}.jsonl`),
  });
}

function timeOnce(
  args: Args,
  target: Target,
  world: World,
  run: number,
): {syncMs: number | null; wallMs: number} {
  const started = performance.now();
  const proc = spawnSync(
    process.execPath,
    [...target.argv, 'thread', args.hook, '--explain'],
    {
      cwd: target.cwd ?? world.projectDir,
      encoding: 'utf-8',
      env: world.env,
      input: payloadFor(args, world, run),
    },
  );
  const wallMs = performance.now() - started;
  if (proc.status !== 0) {
    throw new Error(
      `${target.label} exited ${proc.status ?? 'killed'}: ${(proc.stderr ?? '').trim()}`,
    );
  }
  const match = /([\d.]+)ms \(synchronous part\)/.exec(proc.stderr ?? '');
  return {syncMs: match?.[1] != null ? Number(match[1]) : null, wallMs};
}

function quantile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round(q * (sorted.length - 1))),
  );
  return Math.round((sorted[index] ?? Number.NaN) * 10) / 10;
}

function main(): number {
  let args: Args | null;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(HELP);
    return 2;
  }
  if (args == null) {
    console.log(HELP);
    return 0;
  }
  const worlds = args.targets.map(() => makeWorld(args.sessionBeads));
  const walls: number[][] = args.targets.map(() => []);
  const syncs: number[][] = args.targets.map(() => []);
  try {
    for (let run = 0; run < args.runs + 2; run += 1) {
      for (const [index, target] of args.targets.entries()) {
        const world = worlds[index];
        if (world == null) continue;
        const timed = timeOnce(args, target, world, run);
        if (run < 2) continue;
        walls[index]?.push(timed.wallMs);
        if (timed.syncMs != null) syncs[index]?.push(timed.syncMs);
      }
    }
  } finally {
    for (const world of worlds) {
      rmSync(world.root, {force: true, recursive: true});
    }
  }
  const results = args.targets.map((target, index) => ({
    inHookMedianMs: quantile(syncs[index] ?? [], 0.5),
    runs: walls[index]?.length ?? 0,
    target: target.label,
    wallMedianMs: quantile(walls[index] ?? [], 0.5),
    wallP90Ms: quantile(walls[index] ?? [], 0.9),
  }));
  const what =
    args.hook === 'nudge'
      ? `thread nudge, PostToolUse Bash ${args.commit ? 'git commit' : 'ls -la (not a commit)'}`
      : 'thread capture, UserPromptSubmit';
  if (args.json) {
    console.log(
      JSON.stringify(
        {hook: what, results, sessionBeads: args.sessionBeads},
        null,
        2,
      ),
    );
    return 0;
  }
  console.log(
    `${what}, sessionBeads ${args.sessionBeads ? 'ON' : 'OFF'}, ${args.runs} runs each (after 2 warm-up)`,
  );
  for (const result of results) {
    console.log('');
    console.log(`  ${result.target}`);
    console.log(`    wall median:        ${result.wallMedianMs ?? '—'} ms`);
    console.log(`    wall p90:           ${result.wallP90Ms ?? '—'} ms`);
    console.log(
      `    in-hook median:     ${result.inHookMedianMs ?? 'not printed'}${result.inHookMedianMs != null ? ' ms (the --explain timer; excludes module loading)' : ''}`,
    );
  }
  return 0;
}

process.exit(main());
