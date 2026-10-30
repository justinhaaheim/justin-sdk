#!/usr/bin/env bun
/**
 * What the spend quota's brake adds to a tool call (home-base-ys9t7.5.4, F1
 * and acceptance criterion 6). Four timings, interleaved run by run, the first
 * two runs discarded as warm-up:
 *
 *   A  dispatch, Bash, [guard]               quota off: a Bash call before the brake
 *   B  dispatch, Bash, [guard, brake]        quota off: F1, the brake registered but off
 *   C  dispatch, Bash, [guard, brake]        quota observe, cached decision
 *   D  dispatcher process, Read              quota observe, cached decision
 *
 * A to C run the dispatcher in this process (runHookDispatch with an explicit
 * handler list), so each is the handler children's wall time; B − A is F1 and
 * C − A what a Bash call pays once the brake is on. D starts the dispatcher
 * itself (`bun cli.ts hook PreToolUse`) on a non-Bash payload: before the
 * brake no hook ran for that tool at all, so all of D is added. The real entry
 * adds `bun run --cwd … justin-sdk` script resolution on top, which this does
 * not measure.
 *
 * With `--transcript <path>` (home-base-ys9t7.5.6, its acceptance criterion
 * 2), three more, on a SCRATCH COPY of that transcript with one typed user
 * record appended (dated when the run starts), so the session reads attended:
 *
 *   E  `thread brake` process, Read          observe, recompute every run: the attended fast path
 *   F  dispatcher process, Read              observe, recompute every run: the whole tool call
 *   G  readTypedTail in this process         the copy WITHOUT the typed line, read back
 *                                            to the start: the tail read's worst case
 *
 * E and F delete the throwaway brake state before every run, so each one
 * recomputes; that each took the fast path is checked, not assumed: every
 * E and F run must leave one recheck line with attendedFastPath: true.
 *
 * Everything runs in a throwaway world (XDG config and state, threads state,
 * transcripts root, project dirs), so no real session, log or bead is touched;
 * the transcript given is only read, to copy it. The cached path is checked,
 * not assumed: the throwaway quota log must hold exactly one recheck line of
 * C and D at the end.
 *
 *   bun run measure:brake-latency [--runs N] [--json] [--transcript <path>]
 */

import type {HookHandler} from '../src/hook-registry';

import {spawn} from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, join, resolve} from 'node:path';

import {planDispatch, runHookDispatch} from '../src/hook-dispatch';
import {HOOK_HANDLERS} from '../src/hook-registry';
import {brakeStatePath} from '../src/thread/quota-brake-state';
import {readTypedTail} from '../src/thread/quota-read';

const HELP = `measure-brake-latency — what the spend quota brake adds to a tool call

Usage: bun run measure:brake-latency [--runs N] [--json] [--transcript <path>]

  --runs          Timed runs per scenario, after 2 warm-up runs (default 15)
  --json          Print the results as JSON
  --transcript    Also time a recompute in an ATTENDED session (the fast
                  path) on a scratch copy of this transcript, with one typed
                  line appended to the copy. The file itself is only read.

Runs in a throwaway world; nothing real is written.`;

const CLI = resolve(import.meta.dir, '..', 'src', 'cli.ts');
const SESSION = '00000000-0000-4000-8000-00000000b4a3';

function parseArgs(argv: string[]): {
  json: boolean;
  runs: number;
  transcript: string | null;
} {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    process.exit(0);
  }
  const at = argv.indexOf('--runs');
  const runs = Number(at === -1 ? '15' : (argv[at + 1] ?? ''));
  if (!Number.isInteger(runs) || runs < 1) {
    console.error(`--runs must be a positive integer\n\n${HELP}`);
    process.exit(2);
  }
  const t = argv.indexOf('--transcript');
  const transcript = t === -1 ? null : (argv[t + 1] ?? '');
  if (transcript != null && (transcript === '' || !existsSync(transcript))) {
    console.error(`--transcript needs an existing file\n\n${HELP}`);
    process.exit(2);
  }
  return {json: argv.includes('--json'), runs, transcript};
}

/** The attended scenarios' world: the scratch copies and the payload. */
interface Attended {
  /** The copy with no typed line appended (G reads it). */
  bareCopy: string;
  bytes: number;
  payload: string;
  sessionId: string;
  source: string;
  statePath: string;
  typedAt: string;
}

function attendedWorld(input: {
  cwd: string;
  root: string;
  source: string;
  stateDir: string;
}): Attended {
  // The session id is the source transcript's file name, as Claude Code
  // names it; the payload's transcript_path is the copy.
  const sessionId = basename(input.source, '.jsonl');
  const dir = join(input.root, 'attended');
  mkdirSync(dir, {recursive: true});
  const bareCopy = join(dir, 'bare.jsonl');
  const copy = join(dir, `${sessionId}.jsonl`);
  copyFileSync(input.source, bareCopy);
  copyFileSync(input.source, copy);
  const typedAt = new Date().toISOString();
  const text = readFileSync(copy, 'utf8');
  appendFileSync(
    copy,
    `${text.endsWith('\n') || text === '' ? '' : '\n'}${JSON.stringify({
      isSidechain: false,
      message: {
        content: 'measure-brake-latency: a typed line on a scratch copy',
        role: 'user',
      },
      sessionId,
      timestamp: typedAt,
      type: 'user',
    })}\n`,
  );
  return {
    bareCopy,
    bytes: statSync(copy).size,
    payload: JSON.stringify({
      cwd: input.cwd,
      hook_event_name: 'PreToolUse',
      session_id: sessionId,
      tool_input: {file_path: '/x'},
      tool_name: 'Read',
      transcript_path: copy,
    }),
    sessionId,
    source: input.source,
    statePath: brakeStatePath(sessionId, {
      JUSTIN_THREADS_STATE_DIR: input.stateDir,
    }),
    typedAt,
  };
}

function handlerNamed(id: string): HookHandler {
  const found = HOOK_HANDLERS.find((handler) => handler.id === id);
  if (found == null) throw new Error(`no hook handler ${id} in the registry`);
  return found;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

/** Run argv with the payload on stdin; resolve its wall time in ms. */
function timeProcess(
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

async function timeDispatch(
  handlers: HookHandler[],
  payload: string,
  env: Record<string, string | undefined>,
): Promise<number> {
  const started = performance.now();
  await runHookDispatch({env, event: 'PreToolUse', handlers, stdin: payload});
  return performance.now() - started;
}

async function main(): Promise<void> {
  const {json, runs, transcript: source} = parseArgs(process.argv.slice(2));
  const root = mkdtempSync(join(tmpdir(), 'measure-brake-latency-'));
  try {
    const project = (name: string, mode: string): string => {
      const dir = join(root, name);
      mkdirSync(dir, {recursive: true});
      writeFileSync(
        join(dir, 'justin-sdk.config.json'),
        `${JSON.stringify({
          componentConfig: {thread: {quota: {mode, recheckSeconds: 3600}}},
          components: ['thread-hooks-setup'],
        })}\n`,
      );
      return dir;
    };
    const off = project('project-off', 'off');
    const observe = project('project-observe', 'observe');
    const transcript = join(root, 'transcript.jsonl');
    writeFileSync(transcript, '');
    const stateDir = join(root, 'threads-state');
    const base = {
      ...process.env,
      JUSTIN_SDK_HEALTH_NOTICES: 'off',
      JUSTIN_THREADS_STATE_DIR: stateDir,
      JUSTIN_THREADS_TRANSCRIPTS_ROOT: join(root, 'projects'),
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(root, 'data'),
      XDG_STATE_HOME: join(root, 'state'),
    };
    const envOff = {...base, CLAUDE_PROJECT_DIR: off};
    const envObserve = {...base, CLAUDE_PROJECT_DIR: observe};
    const payload = (cwd: string, tool: 'Bash' | 'Read'): string =>
      JSON.stringify({
        cwd,
        hook_event_name: 'PreToolUse',
        session_id: SESSION,
        tool_input: tool === 'Bash' ? {command: 'ls'} : {file_path: '/x'},
        tool_name: tool,
        transcript_path: transcript,
      });
    // D is measured, not assumed, to run the brake: the dispatcher's own plan.
    const planD = planDispatch({
      env: envObserve,
      event: 'PreToolUse',
      stdin: payload(observe, 'Read'),
    });
    const dHandlers = planD.ok
      ? planD.handlers.map((handler) => handler.id)
      : [`NO PLAN: ${planD.reason}`];
    const guard = handlerNamed('thread guard');
    const brake = handlerNamed('thread brake');
    const attended =
      source == null
        ? null
        : attendedWorld({cwd: observe, root, source, stateDir});

    const times: Record<'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G', number[]> = {
      A: [],
      B: [],
      C: [],
      D: [],
      E: [],
      F: [],
      G: [],
    };
    for (let run = 0; run < runs + 2; run += 1) {
      if (attended != null) {
        // Every E and F run recomputes: no cached decision to read.
        rmSync(attended.statePath, {force: true});
        const e = await timeProcess(
          [process.execPath, CLI, 'thread', 'brake'],
          attended.payload,
          envObserve,
        );
        rmSync(attended.statePath, {force: true});
        const f = await timeProcess(
          [process.execPath, CLI, 'hook', 'PreToolUse'],
          attended.payload,
          envObserve,
        );
        const started = performance.now();
        readTypedTail(attended.bareCopy, {dropFirstPrompt: false, sinceMs: 0});
        const g = performance.now() - started;
        if (run >= 2) {
          times.E.push(e);
          times.F.push(f);
          times.G.push(g);
        }
      }
      const a = await timeDispatch([guard], payload(off, 'Bash'), envOff);
      const b = await timeDispatch(
        [guard, brake],
        payload(off, 'Bash'),
        envOff,
      );
      const c = await timeDispatch(
        [guard, brake],
        payload(observe, 'Bash'),
        envObserve,
      );
      const d = await timeProcess(
        [process.execPath, CLI, 'hook', 'PreToolUse'],
        payload(observe, 'Read'),
        envObserve,
      );
      if (run < 2) continue;
      times.A.push(a);
      times.B.push(b);
      times.C.push(c);
      times.D.push(d);
    }

    const logPath = join(stateDir, 'quota-events.jsonl');
    const lines = existsSync(logPath)
      ? readFileSync(logPath, 'utf8')
          .split('\n')
          .filter((line) => line !== '')
          .map(
            (line) =>
              JSON.parse(line) as {
                attendedFastPath?: unknown;
                kind?: unknown;
                sessionId?: unknown;
                unattended?: unknown;
              },
          )
      : [];
    const rechecks = lines.filter(
      (line) => line.kind === 'recheck' && line.sessionId === SESSION,
    ).length;
    const m = (key: keyof typeof times): number =>
      Math.round(median(times[key]));
    const attendedResult =
      attended == null
        ? null
        : (() => {
            const mine = lines.filter(
              (line) =>
                line.kind === 'recheck' &&
                line.sessionId === attended.sessionId,
            );
            const fast = mine.filter(
              (line) =>
                line.attendedFastPath === true && !('unattended' in line),
            ).length;
            const tail = readTypedTail(attended.bareCopy, {
              dropFirstPrompt: false,
              sinceMs: 0,
            });
            return {
              // One recheck per E and per F run, warm-ups included.
              fastPathChecked: fast === mine.length && fast === 2 * (runs + 2),
              fastPathRecheckLines: fast,
              medianMs: {
                E: m('E'),
                F: m('F'),
                G: Math.round(median(times.G) * 10) / 10,
              },
              recheckLines: mine.length,
              sessionId: attended.sessionId,
              source: attended.source,
              tailWorstCase:
                tail.kind === 'read'
                  ? {
                      bytesRead: tail.bytesRead,
                      typedFound: tail.latestTypedAtMs,
                    }
                  : {failed: tail.reason},
              transcriptBytes: attended.bytes,
              typedAt: attended.typedAt,
            };
          })();
    const result = {
      addedPerBashCallCachedMs: m('C') - m('A'),
      addedPerBashCallQuotaOffMs: m('B') - m('A'),
      addedPerOtherToolCallCachedMs: m('D'),
      attended: attendedResult,
      cachedPathChecked: rechecks === 1,
      dHandlers,
      medianMs: {A: m('A'), B: m('B'), C: m('C'), D: m('D')},
      recheckLines: rechecks,
      runs,
    };
    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`
  Medians over ${runs} runs

    A  dispatch, Bash, [guard], quota off:            ${m('A')} ms
    B  dispatch, Bash, [guard, brake], quota off:     ${m('B')} ms
    C  dispatch, Bash, [guard, brake], observe:       ${m('C')} ms
    D  dispatcher process, Read, observe:             ${m('D')} ms (runs: ${dHandlers.join(', ')})

  Added by the brake

    per Bash call, quota off (F1, B − A):             ${result.addedPerBashCallQuotaOffMs} ms
    per Bash call, cached (C − A):                    ${result.addedPerBashCallCachedMs} ms
    per other tool call, cached (all of D):           ${result.addedPerOtherToolCallCachedMs} ms

  Cached path:   ${rechecks} recheck line(s) in the throwaway log (${rechecks === 1 ? 'one recompute, then cached' : 'NOT the cached path'})
`);
    if (attendedResult != null) {
      const {medianMs: am} = attendedResult;
      console.log(`  Attended recompute (the fast path), on a scratch copy of
    ${attendedResult.source}
    (${attendedResult.transcriptBytes} bytes, one typed line appended at ${attendedResult.typedAt})

    E  thread brake process, Read, recompute:          ${am.E} ms
    F  dispatcher process, Read, recompute:            ${am.F} ms
    G  tail read back to the start, no typed line:     ${am.G} ms (${JSON.stringify(attendedResult.tailWorstCase)})

  Fast path:     ${attendedResult.fastPathRecheckLines} of ${attendedResult.recheckLines} recheck line(s) say attendedFastPath and carry no spend (${attendedResult.fastPathChecked ? 'every E and F run took it' : 'NOT every run took the fast path'})
`);
    }
  } finally {
    rmSync(root, {force: true, recursive: true});
  }
}

await main();
