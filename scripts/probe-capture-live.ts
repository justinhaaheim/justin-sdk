#!/usr/bin/env bun
/**
 * The LIVE proof of `thread capture` (home-base-k0b8n.9, K10 scope 9).
 *
 * Runs ONE real `claude --bg` session — the interactive entrypoint (`cli`,
 * measured by probe-capture-entrypoint), which capture keeps, unlike `-p` —
 * in a repo whose `.claude/settings.json` has the capture hooks installed, and
 * reports what the hooks did with NO thread report ever written:
 *
 *  - the session's `<stateDir>/messages/<sessionId>.jsonl` (the prompt line and
 *    the yield line, written synchronously by the hook),
 *  - the `<stateDir>/capture.jsonl` records of the detached children for that
 *    session (what they did to which bead, and each hook's `hookElapsedMs`),
 *  - Claude Code's own `stop_hook_summary` for that Stop: `durationMs` of every
 *    Stop hook, `bun run justin-sdk thread capture` included.
 *
 * The one thing piped payloads cannot prove, and this can: that the DETACHED
 * child survives Claude Code's own hook runner and lands its bead write.
 *
 * NOT part of `bun test`: it spends one short haiku turn and needs a logged-in
 * `claude`. Run it with the Claude Code sandbox OFF (network, the claude
 * daemon). The prompt carries a `[TEST_DATA_DELETABLE <marker> ]` marker; the
 * probe deletes NOTHING it did not create — it stops and removes only the
 * background agent row its own dispatch printed, and leaves the thread bead,
 * the message log and the transcript for you to inspect and close.
 */

import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join, resolve} from 'node:path';

import {captureRunLogPath, messagesDir} from '../src/thread/archive';
import {readMessageLogAt} from '../src/thread/message-log';

const HELP = `probe-capture-live — one real claude --bg session, and what thread capture did with it

Usage: bun run probe:capture-live [options]

  --marker <uuid>    The TEST_DATA_DELETABLE marker to put in the prompt
                     (default: a fresh uuid). Record it wherever the run is
                     written up.
  --model <m>        Model for the session (default: haiku).
  --cwd <dir>        The repo to run the session in (default: the checkout this
                     script lives in). Its .claude/settings.json must already
                     carry \`thread capture\` on UserPromptSubmit AND Stop.
  --timeout-min <n>  How long to wait for the Stop's capture child (default: 5).
  --help             Print this and do nothing else.

Prints the session's message log, the capture.jsonl records for it, and the
stop_hook_summary timings, then the thread id to inspect with
\`bun run justin-sdk thread show <id>\`. Deletes nothing but the background
agent row it created.
`;

interface Options {
  cwd: string;
  marker: string;
  model: string;
  timeoutMin: number;
}

function parseArgs(argv: string[]): Options | null {
  const opts: Options = {
    cwd: resolve(import.meta.dir, '..', '..', '..'),
    marker: randomUUID(),
    model: 'haiku',
    timeoutMin: 5,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--help' || arg === '-h') return null;
    if (arg === '--marker') opts.marker = argv[++i] ?? opts.marker;
    else if (arg === '--model') opts.model = argv[++i] ?? opts.model;
    else if (arg === '--cwd') opts.cwd = resolve(argv[++i] ?? opts.cwd);
    else if (arg === '--timeout-min')
      opts.timeoutMin = Number(argv[++i] ?? opts.timeoutMin);
    else {
      process.stderr.write(`unknown argument: ${arg}\n\n${HELP}`);
      process.exit(2);
    }
  }
  return opts;
}

/** The real `claude`, not a cmux shim (same reasoning as probe-bg-env.ts). */
function resolveClaude(): string {
  const local = join(homedir(), '.local', 'bin', 'claude');
  if (existsSync(local)) return local;
  const found = spawnSync('command', ['-v', 'claude'], {
    encoding: 'utf-8',
    shell: true,
  });
  const path = (found.stdout ?? '').trim();
  if (found.status !== 0 || path === '') {
    process.stderr.write('no `claude` binary found\n');
    process.exit(2);
  }
  return path;
}

/**
 * A terminal's environment: this process's CLAUDE_* and JUSTIN_* variables
 * removed, so the session measures itself rather than inheriting its parent's
 * entrypoint, session id or state-dir overrides.
 */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('CLAUDE') || key.startsWith('JUSTIN_')) continue;
    env[key] = value;
  }
  return env;
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

/** Both capture hooks present in the repo's committed settings? */
function captureHooksInstalled(cwd: string): string | null {
  const raw = readOrNull(join(cwd, '.claude', 'settings.json'));
  if (raw == null) return `no ${cwd}/.claude/settings.json`;
  const hooks = (JSON.parse(raw) as {hooks?: Record<string, unknown>}).hooks;
  for (const event of ['UserPromptSubmit', 'Stop']) {
    if (!JSON.stringify(hooks?.[event] ?? []).includes('thread capture')) {
      return `${event} has no \`thread capture\` hook in ${cwd}/.claude/settings.json`;
    }
  }
  return null;
}

/** The message log whose text carries the marker, if any has appeared. */
function findLog(
  dir: string,
  marker: string,
): {path: string; sessionId: string} | null {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const path = join(dir, name);
    if (readOrNull(path)?.includes(marker) === true) {
      return {path, sessionId: name.slice(0, -'.jsonl'.length)};
    }
  }
  return null;
}

function runRecords(
  path: string,
  sessionId: string,
): Record<string, unknown>[] {
  const text = readOrNull(path) ?? '';
  const records: Record<string, unknown>[] = [];
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    try {
      const record = JSON.parse(raw) as Record<string, unknown>;
      if (record.sessionId === sessionId) records.push(record);
    } catch {
      // A torn line from a concurrent append; the next read sees it whole.
    }
  }
  return records;
}

/** Claude Code's own timing of every Stop hook, from the transcript. */
function stopHookTimings(cwd: string, sessionId: string): string[] {
  const slug = cwd.replace(/[/.]/g, '-');
  const path = join(
    homedir(),
    '.claude',
    'projects',
    slug,
    `${sessionId}.jsonl`,
  );
  const text = readOrNull(path);
  if (text == null) return [`(transcript not found at ${path})`];
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    if (!raw.includes('stop_hook_summary')) continue;
    const record = JSON.parse(raw) as {
      hookInfos?: {command?: string; durationMs?: number}[];
      timestamp?: string;
    };
    for (const info of record.hookInfos ?? []) {
      out.push(
        `${record.timestamp ?? '?'}  ${String(info.durationMs ?? '?').padStart(5)} ms  ${info.command ?? '?'}`,
      );
    }
  }
  return out.length === 0 ? [`(no stop_hook_summary in ${path})`] : out;
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts == null) {
    process.stdout.write(HELP);
    return 0;
  }
  const missing = captureHooksInstalled(opts.cwd);
  if (missing != null) {
    process.stderr.write(`refusing: ${missing}\n`);
    return 2;
  }
  const env = cleanEnv();
  const logsDir = messagesDir(env);
  const runLog = captureRunLogPath(env);
  const claudeBin = resolveClaude();
  const version = (
    spawnSync(claudeBin, ['--version'], {encoding: 'utf-8'}).stdout ?? ''
  ).trim();
  const prompt = `[TEST_DATA_DELETABLE ${opts.marker} ] capture live proof. Reply with the single word ok and nothing else. Use no tools.`;
  process.stdout.write(
    `claude ${version} · cwd ${opts.cwd}\nmarker ${opts.marker}\nlogs ${logsDir}\n`,
  );

  const dispatched = spawnSync(
    claudeBin,
    [
      '--bg',
      '--name',
      `TEST_DATA_DELETABLE ${opts.marker} capture live proof`,
      '--model',
      opts.model,
      prompt,
    ],
    {cwd: opts.cwd, encoding: 'utf-8', env, timeout: 120_000},
  );
  const banner = `${dispatched.stdout ?? ''}${dispatched.stderr ?? ''}`;
  const agentId = /\b([0-9a-f]{8})\b/.exec(banner)?.[1] ?? null;
  process.stdout.write(`--bg banner: ${banner.trim().slice(0, 200)}\n`);
  if (agentId == null) {
    process.stderr.write(
      'no agent id in the --bg banner; nothing to wait on\n',
    );
    return 1;
  }

  const deadline = Date.now() + opts.timeoutMin * 60_000;
  let found: {path: string; sessionId: string} | null = null;
  let yieldAt: string | null = null;
  let stopChild: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    found ??= findLog(logsDir, opts.marker);
    if (found != null) {
      const read = readMessageLogAt(found.path);
      const yielded =
        read.kind === 'read'
          ? read.lines.findLast((line) => line.role === 'assistant')
          : undefined;
      yieldAt = yielded?.at ?? null;
      if (yieldAt != null) {
        const after = yieldAt;
        stopChild =
          runRecords(runLog, found.sessionId).find(
            (record) => typeof record.at === 'string' && record.at > after,
          ) ?? null;
        if (stopChild != null) break;
      }
    }
    await sleep(2_000);
  }

  const stop = spawnSync(claudeBin, ['stop', agentId], {
    encoding: 'utf-8',
    timeout: 30_000,
  });
  const rm = spawnSync(claudeBin, ['rm', agentId], {
    encoding: 'utf-8',
    timeout: 30_000,
  });
  process.stdout.write(
    `cleanup: stop ${agentId} exit ${stop.status ?? 'null'} · rm ${agentId} exit ${rm.status ?? 'null'} (the agent row only)\n`,
  );

  if (found == null) {
    process.stdout.write(
      `\nNO MESSAGE LOG carries the marker after ${opts.timeoutMin} min — the UserPromptSubmit capture never wrote.\n`,
    );
    return 1;
  }
  process.stdout.write(
    `\nsession ${found.sessionId}\n\nMESSAGE LOG ${found.path}\n`,
  );
  process.stdout.write(`${readOrNull(found.path) ?? '(unreadable)'}`);
  process.stdout.write(`\nCAPTURE CHILD RUNS (${runLog}, this session)\n`);
  for (const record of runRecords(runLog, found.sessionId)) {
    process.stdout.write(`${JSON.stringify(record)}\n`);
  }
  process.stdout.write('\nSTOP HOOK TIMINGS (Claude Code stop_hook_summary)\n');
  for (const row of stopHookTimings(opts.cwd, found.sessionId)) {
    process.stdout.write(`${row}\n`);
  }
  if (stopChild == null) {
    process.stdout.write(
      `\nNO capture child run after the yield (${yieldAt ?? 'no yield line'}) within ${opts.timeoutMin} min.\n`,
    );
    return 1;
  }
  const threadId =
    typeof stopChild.threadId === 'string' ? stopChild.threadId : null;
  process.stdout.write(
    `\nthe Stop's child: outcome ${JSON.stringify(stopChild.outcome)} · thread ${threadId ?? 'UNKNOWN (no threadId in the record)'}\ninspect: bun run justin-sdk thread show ${threadId ?? '<id>'}\n`,
  );
  return 0;
}

process.exit(await main());
