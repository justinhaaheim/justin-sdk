#!/usr/bin/env bun
/**
 * What does the status report v4 prompt-time line cost the capture hook?
 * (home-base-vzwbj.4.1, acceptance criterion 3: "must add no more than about
 * 60 ms to the hook — measure with the existing hookElapsedMs field".)
 *
 * Runs `runThreadCaptureHook` IN PROCESS, with the detached spawn stubbed so
 * the request it would have sent (hookElapsedMs, contextLineMs) is captured,
 * in three worlds:
 *
 *   off      componentConfig.thread.sessionBeads unset — the baseline.
 *   first    sessionBeads on, no session bead yet (the first-prompt line:
 *            index read + a files-only workspace walk).
 *   session  sessionBeads on, a session bead whose beads export is a COPY of a
 *            real one (default: this repo's .beads/issues.jsonl), so the scan
 *            cost is measured at a real repo's size.
 *
 * Then it times the REAL CLI end to end (`bun cli.ts thread capture`, payload
 * on stdin) with the knob off and on, which adds process start and module
 * loading — the part hookElapsedMs cannot see.
 *
 * Writes only under a fresh $TMPDIR directory: its own state dir, config, git
 * repo and beads workspace. The CLI runs spawn the real detached child, which
 * finds no threads repo there (bd fails, recorded in the temp capture.jsonl)
 * and files its session beads in the temp repo. Nothing touches ~/Dev/threads
 * or ~/.local/state. Spends no tokens.
 *
 *   bun run measure:session-line [--runs 30] [--export <issues.jsonl>] [--json]
 */

import type {ApplyRequest, SpawnOutcome} from '../src/thread/capture';

import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';

import {runBr} from '../src/beads/br';
import {messageLogPath} from '../src/thread/archive';
import {runThreadCaptureHook} from '../src/thread/capture';
import {serializeMessageLine} from '../src/thread/message-log';
import {appendSessionSighting} from '../src/thread/session-index';

const HELP = `measure-session-line — what the status report v4 context line costs the capture hook

Usage: bun run measure:session-line [--runs N] [--export <path>] [--json]

  --runs N         in-process runs per world (default 30; the CLI runs use N/3, at least 5)
  --export <path>  a beads issues.jsonl to scale the scan against
                   (default: <repo>/.beads/issues.jsonl)
  --json           print the numbers as JSON
  --help           print this and do nothing else

Writes only under a fresh directory in $TMPDIR. Spends no tokens.`;

interface Options {
  exportPath: string;
  json: boolean;
  runs: number;
}

function parseArgs(argv: string[]): Options | null {
  if (argv.includes('--help') || argv.includes('-h')) return null;
  const valueOf = (flag: string): string | null => {
    const index = argv.indexOf(flag);
    return index === -1 ? null : (argv[index + 1] ?? null);
  };
  const runs = Number(valueOf('--runs') ?? '30');
  return {
    exportPath: resolve(
      valueOf('--export') ??
        join(import.meta.dirname, '..', '..', '..', '.beads', 'issues.jsonl'),
    ),
    json: argv.includes('--json'),
    runs: Number.isFinite(runs) && runs > 0 ? Math.floor(runs) : 30,
  };
}

interface Stats {
  max: number;
  median: number;
  min: number;
  n: number;
  p90: number;
}

function stats(values: number[]): Stats | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? NaN;
  return {
    max: sorted[sorted.length - 1] ?? NaN,
    median: at(0.5),
    min: sorted[0] ?? NaN,
    n: sorted.length,
    p90: at(0.9),
  };
}

function fail(message: string): never {
  console.error(`measure-session-line: ${message}`);
  process.exit(1);
}

function git(cwd: string, args: string[]): void {
  const proc = spawnSync('git', args, {cwd, encoding: 'utf-8'});
  if (proc.status !== 0) fail(`git ${args.join(' ')}: ${proc.stderr}`);
}

function writeKnobs(xdg: string, knobs: Record<string, unknown>): void {
  mkdirSync(join(xdg, 'justin-sdk'), {recursive: true});
  writeFileSync(
    join(xdg, 'justin-sdk', 'config.json'),
    JSON.stringify({componentConfig: {thread: knobs}}),
  );
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (options == null) {
    console.log(HELP);
    return;
  }
  const runsPerWorld = options.runs;
  if (!existsSync(options.exportPath)) {
    fail(`no beads export at ${options.exportPath} (pass --export <path>)`);
  }

  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'measure-session-line-')),
  );
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main', '.']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  git(repo, ['commit', '-q', '--allow-empty', '-m', 'init']);
  const init = runBr(repo, ['init', '--prefix', 'm', '-q']);
  if (!init.ok) fail(`br init: ${init.reason ?? '?'}`);

  // A beads dir whose export is the real one plus this session's two records.
  const sessionId = randomUUID();
  const bigBeads = join(root, 'big', '.beads');
  mkdirSync(bigBeads, {recursive: true});
  const exportCopy = join(bigBeads, 'issues.jsonl');
  copyFileSync(options.exportPath, exportCopy);
  const sid = `sid:${sessionId}`;
  writeFileSync(
    exportCopy,
    `${JSON.stringify({id: 'm-sess', issue_type: 'session', labels: ['session', sid], status: 'in_progress', title: 'Measured session'})}\n${JSON.stringify({id: 'm-sess.1', issue_type: 'task', labels: ['request', sid], status: 'in_progress', title: 'A request'})}\n`,
    {flag: 'a'},
  );
  // The ANSWERS world (home-base-vzwbj.4.2): a session with a question Justin
  // answered after Claude's last yield, so the line also reads the message log
  // tail and restates the answer — the most the hook does on any prompt.
  const answersSessionId = randomUUID();
  const answersSid = `sid:${answersSessionId}`;
  writeFileSync(
    exportCopy,
    `${JSON.stringify({id: 'm-ans', issue_type: 'session', labels: ['session', answersSid], status: 'in_progress', title: 'Answered session'})}\n${JSON.stringify({close_reason: 'answer: b, and keep the old name', closed_at: new Date().toISOString(), id: 'm-ans.1', issue_type: 'question', labels: ['ask', answersSid], status: 'closed', title: 'Which database should the export use?'})}\n`,
    {flag: 'a'},
  );

  const base = {
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CMUX_SURFACE_ID: undefined,
    CMUX_WORKSPACE_ID: undefined,
    JUSTIN_SDK_HEALTH_NOTICES: 'off',
    JUSTIN_THREADS_REPO_DIR: join(root, 'no-threads-repo'),
    JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(root, 'no-transcripts'),
  };
  function world(name: string, knobs: Record<string, unknown>) {
    const xdg = join(root, name, 'xdg');
    writeKnobs(xdg, knobs);
    return {
      ...process.env,
      ...base,
      JUSTIN_THREADS_STATE_DIR: join(root, name, 'state'),
      XDG_CONFIG_HOME: xdg,
    } as Record<string, string | undefined>;
  }
  const off = world('off', {enabled: true});
  const first = world('first', {enabled: true, sessionBeads: true});
  const session = world('session', {enabled: true, sessionBeads: true});
  const indexed = appendSessionSighting(
    {
      at: new Date().toISOString(),
      beadId: 'm-sess',
      beadsDir: bigBeads,
      branch: 'main',
      checkoutPath: join(root, 'big'),
      event: 'created',
      repo: 'big',
      sessionId,
    },
    session,
  );
  if (indexed.kind !== 'appended') fail(`index: ${indexed.error}`);
  const answers = world('answers', {enabled: true, sessionBeads: true});
  const answersIndexed = appendSessionSighting(
    {
      at: new Date().toISOString(),
      beadId: 'm-ans',
      beadsDir: bigBeads,
      branch: 'main',
      checkoutPath: join(root, 'big'),
      event: 'created',
      repo: 'big',
      sessionId: answersSessionId,
    },
    answers,
  );
  if (answersIndexed.kind !== 'appended') {
    fail(`index: ${answersIndexed.error}`);
  }
  // A message log as big as the biggest real one (~272 KB on 2026-10-11),
  // ending in an assistant line an hour old.
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const logLines: string[] = [];
  for (let size = 0; size < 280_000; ) {
    const role = logLines.length % 2 === 0 ? 'user' : 'assistant';
    const line = serializeMessageLine({
      at: hourAgo,
      cwd: repo,
      event: role === 'user' ? 'UserPromptSubmit' : 'Stop',
      role,
      text: `${role} message ${logLines.length} `.repeat(40),
    });
    logLines.push(line);
    size += line.length;
  }
  if (logLines.length % 2 === 1) logLines.pop();
  const answersLog = messageLogPath(answersSessionId, answers);
  mkdirSync(dirname(answersLog), {recursive: true});
  writeFileSync(answersLog, logLines.join(''));

  function inProcess(
    env: Record<string, string | undefined>,
    measuredSessionId: string = sessionId,
  ) {
    const hook: number[] = [];
    const line: number[] = [];
    let sample: string | null = null;
    for (let index = 0; index < runsPerWorld; index += 1) {
      let sent: ApplyRequest | null = null;
      const result = runThreadCaptureHook({
        env,
        spawnApply: (request): SpawnOutcome => {
          sent = request;
          return {kind: 'spawned', pid: null};
        },
        stdin: JSON.stringify({
          cwd: repo,
          hook_event_name: 'UserPromptSubmit',
          prompt: `measured prompt ${index}`,
          session_id: measuredSessionId,
        }),
      });
      const request = sent as ApplyRequest | null;
      if (request?.hookElapsedMs != null) hook.push(request.hookElapsedMs);
      if (request?.contextLineMs != null) line.push(request.contextLineMs);
      sample ??= result.contextLine;
    }
    return {contextLineMs: stats(line), hookElapsedMs: stats(hook), sample};
  }

  // The hook prints its JSON line through console.log; keep it off the report.
  const realLog = console.log;
  const swallowed: unknown[] = [];
  console.log = (...args: unknown[]) => {
    swallowed.push(args);
  };
  // One discarded pass per world first, so no world pays the JIT warm-up.
  for (const env of [off, first, session]) inProcess(env);
  inProcess(answers, answersSessionId);
  const offRun = inProcess(off);
  const firstRun = inProcess(first);
  const sessionRun = inProcess(session);
  const answersRun = inProcess(answers, answersSessionId);
  const measured = {
    answers: answersRun,
    first: firstRun,
    off: offRun,
    session: sessionRun,
  };
  console.log = realLog;

  const cli = join(import.meta.dirname, '..', 'src', 'cli.ts');
  function wallClock(env: Record<string, string | undefined>): Stats | null {
    const times: number[] = [];
    const runs = Math.max(5, Math.floor(runsPerWorld / 3));
    for (let index = 0; index < runs; index += 1) {
      const started = performance.now();
      const proc = spawnSync(process.execPath, [cli, 'thread', 'capture'], {
        encoding: 'utf-8',
        env: env as NodeJS.ProcessEnv,
        input: JSON.stringify({
          cwd: repo,
          hook_event_name: 'UserPromptSubmit',
          prompt: `cli prompt ${index}`,
          // A fresh session each run: every run is a first prompt.
          session_id: randomUUID(),
        }),
      });
      times.push(performance.now() - started);
      if (proc.status !== 0) fail(`cli exited ${proc.status}: ${proc.stderr}`);
    }
    return stats(times);
  }
  const cliOff = wallClock(off);
  const cliOn = wallClock(first);

  const exportBytes = statSync(options.exportPath).size;
  const report = {
    cliWallMs: {off: cliOff, on: cliOn},
    exportBytes,
    exportPath: options.exportPath,
    inProcess: measured,
    tmpRoot: root,
  };
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const show = (s: Stats | null): string =>
    s == null
      ? 'not measured'
      : `median ${s.median.toFixed(1)} · p90 ${s.p90.toFixed(1)} · max ${s.max.toFixed(1)} ms (n=${s.n})`;
  console.log(
    `export scanned: ${options.exportPath} (${(exportBytes / 1e6).toFixed(1)} MB)\n`,
  );
  console.log('hookElapsedMs (synchronous part, includes the line):');
  console.log(`  off       ${show(measured.off.hookElapsedMs)}`);
  console.log(`  first     ${show(measured.first.hookElapsedMs)}`);
  console.log(`  session   ${show(measured.session.hookElapsedMs)}`);
  console.log(`  answers   ${show(measured.answers.hookElapsedMs)}\n`);
  console.log('contextLineMs (the line alone):');
  console.log(`  first     ${show(measured.first.contextLineMs)}`);
  console.log(`  session   ${show(measured.session.contextLineMs)}`);
  console.log(`  answers   ${show(measured.answers.contextLineMs)}\n`);
  console.log('CLI wall clock (process start to exit):');
  console.log(`  off       ${show(cliOff)}`);
  console.log(`  on        ${show(cliOn)}\n`);
  console.log(`sample line: ${measured.session.sample ?? '(none)'}`);
  console.log(`sample with answers:\n${measured.answers.sample ?? '(none)'}`);
  console.log(`scratch: ${root}`);
}

main();
