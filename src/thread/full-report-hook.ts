/**
 * full-report-hook — `thread full-report`, the UserPromptSubmit handler that
 * answers a typed `/full-report` (home-base-1rxt0.14).
 *
 * Justin, 2026-11-12: "Can the slash command print the report into the
 * conversation directly, without requiring cc to copy it in? ... I would like
 * to make the writing and handling of status reports as deterministic as
 * possible."
 *
 * HOW. The thread-rules component installs `.claude/commands/full-report.md`,
 * so `/full-report` is a known command and its prompt reaches UserPromptSubmit
 * "as you typed it rather than the expanded skill content" (hooks reference,
 * read 2026-11-13). With componentConfig.thread.fullReportCommand on, this
 * handler blocks that prompt, and Claude Code shows the block's `reason` to
 * Justin and does not add it to Claude's context. So the reason is the output
 * of `thread status --full`, and no model turn happens. Off, it prints
 * nothing, the command expands, and the command file tells Claude to run
 * `thread status --full` and paste it, as the status report rule already does.
 *
 * WHEN IT RUNS. In dispatch mode the dispatcher starts it only for a prompt of
 * exactly `/full-report` (the registry's prompt filter), so every other prompt
 * costs nothing. In per-handler mode install writes its entry only where the
 * knob is on, and it then starts on every prompt and checks the prompt here
 * before anything else.
 *
 * FAIL OPEN. This runs on Justin's prompts, so nothing in it may stop one by
 * accident: it never exits 2, and any failure (knob unreadable, no session id,
 * the report command failing or hanging, anything thrown) prints a hook message
 * saying what went wrong and lets the prompt through. Claude then runs the
 * command as the command file tells it. Only a report that was produced blocks.
 *
 * WHY A CHILD PROCESS FOR THE REPORT. (1) The reason is then `thread status
 * --full`'s output by construction, not a second rendering of it. (2) That
 * command writes to stdout and the console itself, which would corrupt this
 * hook's JSON in-process. (3) A crash in the report code cannot take the hook
 * down with it. The cost, one more bun start, is paid only on `/full-report`.
 *
 * READ-ONLY LOOKUP. The child runs `--session <payload session_id>` with
 * CLAUDE_CODE_SESSION_ID removed from its environment. A run whose env names
 * the session it reports is that session's "own" run, which saves a report
 * snapshot (the next report's markers), a trim-guard block, and question ids
 * (bead writes). A look-up Justin asked for should change none of that, so it
 * runs as the lookup `thread status --session <id>` is. The visible difference:
 * an open question filed before question ids existed shows no id here until the
 * session's own `thread status` gives it one.
 *
 * THE CAP. The hooks reference caps `additionalContext`, `systemMessage`,
 * `initialUserMessage` and plain stdout at 10,000 characters and does not name
 * `reason`. Whether `reason` is cut is unmeasured, and a full report is about
 * 13 KB (measured 2026-11-13 on the conductor session: 242 lines, 13,457
 * bytes). So the report is cut at a line boundary to fit
 * CLAUDE_CODE_HOOK_TEXT_CAP and ends with one line saying how much is missing
 * and how to print it all. Never cut silently.
 */

import {spawn} from 'child_process';
import {readFileSync} from 'fs';
import {fileURLToPath} from 'url';

import {silencedChildEnv} from '../health-notices';
import {
  CLAUDE_CODE_HOOK_TEXT_CAP,
  promptBlockJson,
  renderHookOutput,
} from '../hook-output';
import {FULL_REPORT_PROMPT} from '../hook-registry';
import {sdkRun} from '../sdk-invocation';
import {writeStdout} from '../write-stdout';

type Env = Record<string, string | undefined>;

const EVENT = 'UserPromptSubmit';

/**
 * How long the report may take. Below the dispatcher's 25 s UserPromptSubmit
 * limit (hook-dispatch.ts handlerTimeoutMs), so a slow report fails open with
 * this handler's own message rather than the dispatcher's. A full report took
 * 1.6 s on 2026-11-13.
 */
export const FULL_REPORT_TIMEOUT_MS = 20_000;

/** The command a session runs today for the full report, and the one named on a cut. */
export const FULL_REPORT_STATUS_COMMAND = sdkRun('thread status --full');

/** What running the report command did. */
export interface ReportRun {
  /** The exit code, or null when the child never exited on its own. */
  exitCode: number | null;
  /** Why the child could not be started, or null when it started. */
  spawnError: string | null;
  stderr: string;
  stdout: string;
  /** True when this handler stopped it at FULL_REPORT_TIMEOUT_MS. */
  timedOut: boolean;
}

/** What the handler reads from outside; tests replace each. */
export interface FullReportHookDeps {
  /**
   * componentConfig.thread.fullReportCommand where the session is. May throw:
   * a throw fails open.
   */
  knobOn: (cwd: string, env: Env) => Promise<boolean>;
  /** Run `thread status --full --session <id>` and capture it. May throw. */
  runReport: (args: {
    cwd: string;
    env: Env;
    sessionId: string;
  }) => Promise<ReportRun>;
}

async function defaultKnobOn(cwd: string, env: Env): Promise<boolean> {
  // `await import`: thread/config reaches sdk-config and zod, and this module
  // is reached from cli-main only through thread/command's lazy import.
  const {resolveThreadConfig} = await import('./config');
  return resolveThreadConfig({cwd, env}).fullReportCommand;
}

/** The env the report child runs with: see READ-ONLY LOOKUP above. */
export function reportChildEnv(env: Env): Env {
  const child: Env = {...silencedChildEnv(env), NO_COLOR: '1'};
  delete child.CLAUDE_CODE_SESSION_ID;
  return child;
}

/** The argv of the report child: this bun, this SDK's cli.ts. */
export function reportChildArgv(sessionId: string): string[] {
  return [
    process.execPath,
    fileURLToPath(new URL('../cli.ts', import.meta.url)),
    'thread',
    'status',
    '--full',
    '--session',
    sessionId,
  ];
}

function defaultRunReport(args: {
  cwd: string;
  env: Env;
  sessionId: string;
}): Promise<ReportRun> {
  return new Promise((resolvePromise) => {
    const result: ReportRun = {
      exitCode: null,
      spawnError: null,
      stderr: '',
      stdout: '',
      timedOut: false,
    };
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = (patch: Partial<ReportRun>): void => {
      if (settled) return;
      settled = true;
      if (timer != null) clearTimeout(timer);
      resolvePromise({...result, ...patch});
    };
    const [bin, ...rest] = reportChildArgv(args.sessionId);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin ?? process.execPath, rest, {
        cwd: args.cwd,
        env: reportChildEnv(args.env),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      settle({
        spawnError: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    timer = setTimeout(() => {
      result.timedOut = true;
      child.kill('SIGKILL');
    }, FULL_REPORT_TIMEOUT_MS);
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
    child.on('close', (code) => {
      settle(result.timedOut ? {timedOut: true} : {exitCode: code});
    });
  });
}

const DEFAULT_DEPS: FullReportHookDeps = {
  knobOn: defaultKnobOn,
  runReport: defaultRunReport,
};

/** The payload fields this handler reads. Null when absent or not a string. */
function payloadFields(stdin: string): {
  cwd: string | null;
  prompt: string | null;
  sessionId: string | null;
} {
  try {
    const parsed: unknown = JSON.parse(stdin);
    if (parsed == null || typeof parsed !== 'object') {
      return {cwd: null, prompt: null, sessionId: null};
    }
    const fields = parsed as {
      cwd?: unknown;
      prompt?: unknown;
      session_id?: unknown;
    };
    const text = (value: unknown): string | null =>
      typeof value === 'string' && value !== '' ? value : null;
    return {
      cwd: text(fields.cwd),
      prompt: typeof fields.prompt === 'string' ? fields.prompt : null,
      sessionId: text(fields.session_id),
    };
  } catch {
    return {cwd: null, prompt: null, sessionId: null};
  }
}

/** Is this prompt the one this handler answers? Trimmed, exact. */
export function isFullReportPrompt(prompt: string | null): boolean {
  return prompt?.trim() === FULL_REPORT_PROMPT;
}

/** The command that prints this session's whole report from any shell. */
export function fullReportCommandFor(sessionId: string): string {
  return `${FULL_REPORT_STATUS_COMMAND} --session ${sessionId}`;
}

/**
 * The line that ends a cut report. `hidden` is how many lines were left out.
 */
export function cutLine(
  hidden: number,
  sessionId: string,
  cap: number,
): string {
  return `✂️ ${hidden} more ${hidden === 1 ? 'line' : 'lines'} not shown: a hook shows at most ${cap.toLocaleString('en-US')} characters. Print the whole report with \`${fullReportCommandFor(sessionId)}\`, or ask Claude in words for the full report.`;
}

/**
 * The report fitted to `cap` characters (JavaScript string length, which is
 * never fewer than the code points Claude Code could be counting). Whole lines
 * only, so nothing is cut mid-line or mid-emoji. A report that fits is returned
 * as is, minus trailing whitespace; one that does not keeps as many leading
 * lines as fit, then an empty line and `cutLine`.
 */
export function fitFullReport(
  report: string,
  sessionId: string,
  cap: number = CLAUDE_CODE_HOOK_TEXT_CAP,
): string {
  const body = report.trimEnd();
  if (body.length <= cap) return body;
  const lines = body.split('\n');
  // Budget with the longest possible cut line (every line hidden), so the line
  // actually printed, whose count has no more digits, always fits.
  const budget = cap - cutLine(lines.length, sessionId, cap).length - 2;
  let kept = 0;
  let length = 0;
  for (const line of lines) {
    const next = length + (kept === 0 ? 0 : 1) + line.length;
    if (next > budget) break;
    length = next;
    kept += 1;
  }
  const tail = cutLine(lines.length - kept, sessionId, cap);
  return kept === 0 ? tail : `${lines.slice(0, kept).join('\n')}\n\n${tail}`;
}

/** The hook message for a failure: the prompt goes through, and Justin is told why. */
function failOpen(detail: string): string {
  return renderHookOutput({
    event: EVENT,
    forClaude: '',
    forJustin: `⚠️ /full-report could not answer by itself: ${detail}. Your prompt went to Claude instead, which runs \`${FULL_REPORT_STATUS_COMMAND}\` as the command file says.`,
  });
}

function firstLine(text: string): string | null {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '') ?? null
  );
}

function describeRun(run: ReportRun): string | null {
  if (run.spawnError != null) {
    return `\`${FULL_REPORT_STATUS_COMMAND}\` did not start (${run.spawnError})`;
  }
  if (run.timedOut) {
    return `\`${FULL_REPORT_STATUS_COMMAND}\` was stopped after ${FULL_REPORT_TIMEOUT_MS / 1000} s without finishing`;
  }
  if (run.exitCode !== 0) {
    const detail = firstLine(run.stderr);
    return `\`${FULL_REPORT_STATUS_COMMAND}\` failed (exit ${run.exitCode ?? 'unknown'})${detail == null ? '' : `: ${detail}`}`;
  }
  if (run.stdout.trim() === '') {
    return `\`${FULL_REPORT_STATUS_COMMAND}\` printed nothing`;
  }
  return null;
}

/**
 * One run of the hook: its stdout, '' when it has nothing to say. Never
 * throws, and never blocks except with a report that was produced.
 */
export async function fullReportHook(input: {
  cwd: string;
  deps?: Partial<FullReportHookDeps>;
  env: Env;
  stdin: string;
}): Promise<string> {
  const fields = payloadFields(input.stdin);
  // Any other prompt, or a payload with no prompt: not ours, say nothing. This
  // is the per-handler path for every ordinary prompt.
  if (!isFullReportPrompt(fields.prompt)) return '';
  const deps = {...DEFAULT_DEPS, ...input.deps};
  const cwd = fields.cwd ?? input.cwd;
  try {
    if (!(await deps.knobOn(cwd, input.env))) return '';
    if (fields.sessionId == null) {
      return failOpen('the hook payload has no session_id');
    }
    const run = await deps.runReport({
      cwd,
      env: input.env,
      sessionId: fields.sessionId,
    });
    const problem = describeRun(run);
    if (problem != null) return failOpen(problem);
    return `${JSON.stringify(promptBlockJson(fitFullReport(run.stdout, fields.sessionId)))}\n`;
  } catch (error) {
    return failOpen(
      `it threw (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

/** The CLI entry: read the payload, answer, exit 0 whatever happened. */
export async function runThreadFullReportHook(): Promise<number> {
  let stdin = '';
  // A terminal is skipped so the command typed by hand does not wait for
  // input; Claude Code always pipes a payload in.
  if (process.stdin.isTTY !== true) {
    try {
      stdin = readFileSync(0, 'utf8');
    } catch {
      stdin = '';
    }
  }
  const stdout = await fullReportHook({
    cwd: process.cwd(),
    env: process.env,
    stdin,
  });
  if (stdout !== '') await writeStdout(stdout);
  return 0;
}
