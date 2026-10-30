/**
 * `thread brake` — the spend quota's brake on a RUNNING session (request
 * home-base-ys9t7.5 D6, D10; dispatch 2 item 4). A PreToolUse handler on
 * every tool, run by the hook dispatcher.
 *
 * PER SESSION, A CACHED DECISION. The first call of a session, and every call
 * once the cached decision is older than recheckSeconds, recomputes the
 * running verdict (`gatherQuotaReport`, the same measurement `thread quota`
 * shows) and writes it to `<threads state dir>/quota-brake/<session id>.json`
 * by tmp + rename, so parallel tool calls may recompute twice but never leave
 * a torn file. Every other call reads that file. A subagent's call carries its
 * parent's session id, so a session's subagents are braked with it.
 *
 * Justin typing resets it at once: while the cached decision is not clear,
 * each call reads the bytes the session's transcript gained since the
 * recompute, and a typed line there forces a recompute (typedLineSince).
 *
 * THE ATTENDED FAST PATH (home-base-ys9t7.5.6, D6). Before any group read or
 * pricing, a recompute reads the END of the session's own transcript for its
 * latest typed line (readTypedTail). Typed within attendedGraceMinutes: allow,
 * nothing measured, cached until the grace runs out (attendedUntilMs), and one
 * `recheck` line with attendedFastPath: true. While Justin has typed in the
 * grace the floor does not apply (D4), and the chain and project limits count
 * only spend since his latest typed line, so the full measurement (2.6 s on a
 * 4.2 MB transcript) would buy nothing in the sessions he is working in. Not
 * proven attended (no typed line in the grace, a read failure, a typed line
 * dated in the future): the full recompute below, as before. A typed line in
 * ANOTHER member of the group is not looked for here; the full path sees it.
 *
 * THE DECISION TABLE (brakeDecision, pure):
 *   - mode off, or no session id in the payload: allow, nothing written.
 *   - fine: allow.
 *   - over: enforce denies unless the call is on the allow-list; observe logs
 *     a would-deny and allows.
 *   - unknown, or the brake itself throws: attended allows, with one stderr
 *     line and a log entry per recompute; unattended or attendance unknown
 *     is treated as over (D10).
 *
 * FAIL-OPEN BY THE DISPATCHER'S DESIGN, NOT THIS FILE'S. The dispatcher stops
 * a PreToolUse handler at 25 s (hook-dispatch.ts handlerTimeoutMs) and lets
 * the call through. A recompute measured ~2.6 s; the cached path is a file
 * read. Nothing here waits on anything unbounded.
 *
 * DENYING: exit 2 with the message on stderr (session-guard.ts's pattern);
 * the dispatcher passes a child's exit 2 and stderr through.
 */

import type {QuotaMode} from './defaults';
import type {EnvLike} from './paths';
import type {QuotaReport} from './quota-command';
import type {Attendance} from './quota-group';
import type {QuotaLimits} from './quota-knob';
import type {QuotaOver, QuotaVerdict} from './quota-verdict';

import {readFileSync, statSync} from 'node:fs';
import {basename} from 'node:path';
import parse from 'shell-quote/parse';

import {
  type BrakeState,
  type BrakeStateKind,
  type BrakeStateRead,
  readBrakeState,
  writeBrakeState,
} from './quota-brake-state';
import {attendanceOf} from './quota-group';
import {appendQuotaLog} from './quota-log';
import {readTypedTail, typedLineSince} from './quota-read';
import {SPAWN_KICKOFF_ENV} from './session-bead';
import {
  scanShell,
  type ShellToken,
  simpleCommands,
  threadCommandIn,
  unwrapCommand,
} from './session-guard';

// ---------------------------------------------------------------------------
// The allow-list while braked
// ---------------------------------------------------------------------------

/** `thread <sub>` a braked session may still run (read, ask, record). */
export const BRAKE_THREAD_COMMANDS: ReadonlySet<string> = new Set([
  'ask',
  'quota',
  'request',
  'stage',
  'status',
]);

/** `br <sub>` a braked session may still run, to record its state. */
export const BRAKE_BR_COMMANDS: ReadonlySet<string> = new Set([
  'close',
  'create',
  'list',
  'show',
  'update',
]);

/**
 * `git <sub>` a braked session may still run, so it can save its final
 * commit as the commit rules require. `push` is checked apart (plainPush).
 */
export const BRAKE_GIT_COMMANDS: ReadonlySet<string> = new Set([
  'add',
  'commit',
  'diff',
  'log',
  'status',
]);

/**
 * Tools other than Bash a braked session may call, because the deny message
 * tells it to: ScheduleWakeup (a /loop session stops its loop with it) and
 * SubagentHandback (a braked subagent's final report).
 */
export const BRAKE_TOOLS: ReadonlySet<string> = new Set([
  'ScheduleWakeup',
  'SubagentHandback',
]);

/** Programs that start the SDK, by basename. */
const SDK_PROGRAMS = new Set([
  'bun',
  'bunx',
  'justin-sdk',
  'justin-sdk-latest',
]);

/**
 * A `thread <allowed sub>` call through the SDK, in the spellings the session
 * guard recognises (threadCommandIn), and nothing else before `thread`: the
 * program, `run` / `x`, options, `--cwd <dir>`, and ONE word that names the
 * SDK. So `rm x justin-sdk thread status` is not a thread call.
 */
function threadCall(words: readonly string[]): boolean {
  const program = basename(words[0] ?? '');
  if (!SDK_PROGRAMS.has(program)) return false;
  if (threadCommandIn(words, BRAKE_THREAD_COMMANDS) == null) return false;
  const at = words.indexOf('thread');
  const sdkWord = (w: string): boolean =>
    w.includes('justin-sdk') ||
    basename(w) === 'cli.ts' ||
    basename(w) === 'cli-main.ts';
  let sdkWords = sdkWord(words[0] ?? '') ? 1 : 0;
  for (let i = 1; i < at; i++) {
    const word = words[i] ?? '';
    if (word === '--cwd') {
      i += 1;
      continue;
    }
    if (word === 'run' || word === 'x' || word.startsWith('-')) continue;
    if (sdkWord(word)) {
      sdkWords += 1;
      continue;
    }
    return false;
  }
  return sdkWords === 1;
}

/** The first word after a program's leading options; `valued` take a value. */
function subcommandOf(
  rest: readonly string[],
  valued: ReadonlySet<string>,
): {index: number; sub: string} | null {
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i] ?? '';
    if (valued.has(word)) {
      i += 1;
      continue;
    }
    if (word.startsWith('-')) continue;
    return {index: i, sub: word};
  }
  return null;
}

const GIT_VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree']);
const BR_VALUED = new Set(['--db']);

/**
 * A plain `git push`: no force in any spelling (-f in any short cluster,
 * --force, --force-with-lease, --force-if-includes, a +refspec), and nothing
 * that deletes (--delete, -d, a :refspec, --mirror, --prune).
 */
function plainPush(args: readonly string[]): boolean {
  return args.every((word) => {
    if (word.startsWith('+') || word.startsWith(':')) return false;
    if (word.startsWith('--')) {
      return !/^--(?:force|delete|mirror|prune)/u.test(word);
    }
    if (word.startsWith('-')) return !/[fd]/u.test(word.slice(1));
    return !word.includes(':') || !word.startsWith(':');
  });
}

function allowedSimpleCommand(words: readonly string[]): boolean {
  const unwrapped = unwrapCommand(words);
  if (unwrapped.kind === 'none' || unwrapped.kind === 'lookup') return true;
  if (unwrapped.kind === 'split') return false;
  const rest = unwrapped.words;
  const program = basename(rest[0] ?? '');
  // `cd` runs nothing: a braked session in a worktree needs it to commit.
  if (program === 'cd') return true;
  if (threadCall(rest)) return true;
  if (program === 'br') {
    const sub = subcommandOf(rest.slice(1), BR_VALUED);
    return sub != null && BRAKE_BR_COMMANDS.has(sub.sub);
  }
  if (program === 'git') {
    const sub = subcommandOf(rest.slice(1), GIT_VALUED);
    if (sub == null) return false;
    if (BRAKE_GIT_COMMANDS.has(sub.sub)) return true;
    if (sub.sub === 'push') return plainPush(rest.slice(sub.index + 2));
    return false;
  }
  return false;
}

/** Every simple command of a Bash command, its substitutions included. */
function bashAllowed(raw: string, depth = 0): boolean {
  if (depth > 4) return false;
  const scan = scanShell(raw);
  if (!scan.ok) return false;
  for (const inner of scan.substitutions) {
    if (!bashAllowed(inner, depth + 1)) return false;
  }
  let tokens: ShellToken[];
  try {
    tokens = parse<never>(scan.text, (key: string) => `$${key}`);
  } catch {
    return false;
  }
  const commands = simpleCommands(tokens);
  if (commands.length === 0) return false;
  return commands.every(allowedSimpleCommand);
}

/**
 * Is this call on the allow-list while braked? A compound Bash command is
 * allowed only when every simple command in it is (and every substitution).
 * Nothing that turns the quota off is on the list.
 */
export function brakeAllows(call: {
  command: string | null;
  toolName: string | null;
}): boolean {
  if (call.toolName != null && BRAKE_TOOLS.has(call.toolName)) return true;
  if (call.toolName !== 'Bash' || call.command == null) return false;
  return bashAllowed(call.command);
}

// ---------------------------------------------------------------------------
// From a verdict to a state, and from a state to a decision (pure)
// ---------------------------------------------------------------------------

function percent(value: number): string {
  return String(Number(value.toFixed(2)));
}

/** One crossed limit, in the words the deny message uses. */
export function overLine(over: QuotaOver): string {
  if (over.limit !== 'floor') {
    const spent = `${over.atLeast ? 'at least ' : ''}${percent(over.spentPercent)} % of your week`;
    return over.limit === 'chain'
      ? `this chain has spent ${spent} since you last typed, limit ${over.limitPercent} %`
      : `this project has spent ${spent} in the last 24 hours since you last typed, limit ${over.limitPercent} %`;
  }
  const which =
    over.window === 'week' ? 'your week' : `your ${over.window} week`;
  return `${which} is at ${percent(over.weekPercent)} %, and no unattended work runs at or past ${over.limitPercent} %`;
}

export function stateOfVerdict(
  verdict: QuotaVerdict,
  graceMinutes: number,
): {limitText: string; state: BrakeStateKind} {
  if (verdict.kind === 'fine') return {limitText: '', state: 'clear'};
  if (verdict.kind === 'over') {
    return {limitText: verdict.over.map(overLine).join('; '), state: 'braked'};
  }
  const why = `the spend quota could not be measured (${verdict.reasons.join('; ')})`;
  if (verdict.attendance.kind === 'attended') {
    return {limitText: why, state: 'attendedUnknown'};
  }
  return {
    limitText: `${why}, and nobody has typed in this session in the last ${graceMinutes} min`,
    state: 'braked',
  };
}

export type BrakeAction =
  | 'allow'
  | 'allowAttendedUnknown'
  | 'allowListed'
  | 'deny'
  | 'wouldDeny';

/** The decision table, given a state (the mode-off and no-session rows are earlier). */
export function brakeDecision(input: {
  command: string | null;
  mode: Exclude<QuotaMode, 'off'>;
  state: BrakeStateKind;
  toolName: string | null;
}): BrakeAction {
  if (input.state === 'clear') return 'allow';
  if (input.state === 'attendedUnknown') return 'allowAttendedUnknown';
  if (brakeAllows(input)) return 'allowListed';
  return input.mode === 'enforce' ? 'deny' : 'wouldDeny';
}

/** What a denied call tells the calling Claude (and Justin, in the transcript). */
export function brakeDenialMessage(limitText: string): string {
  return [
    `thread brake: this session is stopped by the spend quota: ${limitText}.`,
    '',
    'Write your final report now and stop.',
    'Do not hand off and do not spawn a session.',
    'Do not retry this call and do not work around this brake.',
    'A /loop session calls ScheduleWakeup with stop.',
    'Justin typing in this session resets it.',
    '',
    `Still allowed: thread ${[...BRAKE_THREAD_COMMANDS].join('|')}, br ${[...BRAKE_BR_COMMANDS].join('|')}, git ${[...BRAKE_GIT_COMMANDS].join('|')}, a plain git push, cd.`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

export interface BrakePayload {
  agentId: string | null;
  agentType: string | null;
  command: string | null;
  cwd: string | null;
  sessionId: string | null;
  toolName: string | null;
  transcriptPath: string | null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

export function parseBrakePayload(raw: string): BrakePayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const input = record.tool_input;
  return {
    agentId: nonEmpty(record.agent_id),
    agentType: nonEmpty(record.agent_type),
    command:
      input != null && typeof input === 'object'
        ? nonEmpty((input as Record<string, unknown>).command)
        : null,
    cwd: nonEmpty(record.cwd),
    sessionId: nonEmpty(record.session_id),
    toolName: nonEmpty(record.tool_name),
    transcriptPath: nonEmpty(record.transcript_path),
  };
}

export interface BrakeKnobs {
  attendedGraceMinutes: number;
  mode: QuotaMode;
  recheckSeconds: number;
}

export interface BrakeMeasurement {
  limits: QuotaLimits;
  report: QuotaReport;
  verdict: QuotaVerdict;
  verdictText: string;
}

export interface BrakeHookDeps {
  /** componentConfig.thread.quota at the project root. */
  knobs: (
    projectRoot: string,
    env: EnvLike,
  ) => BrakeKnobs | Promise<BrakeKnobs>;
  /** Append one quota-log line; returns why it failed, or null. */
  log: (line: Record<string, unknown>, env: EnvLike) => string | null;
  /** The running verdict, measured (gatherQuotaReport). May throw. */
  measure: (input: {
    cwd: string;
    env: EnvLike;
    nowMs: number;
    sessionId: string;
  }) => Promise<BrakeMeasurement>;
  /**
   * Attendance from the session's own transcript alone, which can prove
   * attended and never unattended. Asked first by the attended fast path
   * (home-base-ys9t7.5.6), before anything is measured; asked again when the
   * group's attendance is not known to be attended (a failure, or a
   * measurement that could not read the group, such as a session whose bead
   * is not filed yet). `dropFirstPrompt`: the session's first prompt is a
   * `thread spawn` kickoff (D8), not Justin.
   */
  ownAttendance: (input: {
    dropFirstPrompt: boolean;
    graceMinutes: number;
    nowMs: number;
    transcriptPath: string | null;
  }) => Promise<Attendance>;
}

async function realKnobs(
  projectRoot: string,
  env: EnvLike,
): Promise<BrakeKnobs> {
  const {resolveThreadConfig} = await import('./config');
  const {quota} = resolveThreadConfig({cwd: projectRoot, env});
  return {
    attendedGraceMinutes: quota.attendedGraceMinutes.value,
    mode: quota.mode.value,
    recheckSeconds: quota.recheckSeconds.value,
  };
}

async function realMeasure(input: {
  cwd: string;
  env: EnvLike;
  nowMs: number;
  sessionId: string;
}): Promise<BrakeMeasurement> {
  const {gatherQuotaReport, verdictText} = await import('./quota-command');
  const {quotaLimitsOf} = await import('./quota-knob');
  const report = await gatherQuotaReport({
    cwd: input.cwd,
    env: input.env as NodeJS.ProcessEnv,
    nowMs: input.nowMs,
    sessionId: input.sessionId,
  });
  const verdict = report.verdicts.running;
  return {
    limits: quotaLimitsOf(report.config),
    report,
    verdict,
    verdictText: verdictText(verdict),
  };
}

/**
 * The session's attendance from its own transcript, by a TAIL read
 * (home-base-ys9t7.5.6): only the latest typed line matters, so an attended
 * session reads the minutes since Justin typed, not the whole file. Partial:
 * it proves attended and never the opposite (attendanceOf).
 */
function ownAttendanceFromTail(input: {
  dropFirstPrompt: boolean;
  graceMinutes: number;
  nowMs: number;
  transcriptPath: string | null;
}): Attendance {
  if (input.transcriptPath == null) {
    return {kind: 'unknown', reason: 'the payload names no transcript'};
  }
  const tail = readTypedTail(input.transcriptPath, {
    dropFirstPrompt: input.dropFirstPrompt,
    sinceMs: input.nowMs - input.graceMinutes * 60_000,
  });
  if (tail.kind === 'failed') {
    return {
      kind: 'unknown',
      reason: `${input.transcriptPath}: ${tail.reason}`,
    };
  }
  return attendanceOf(
    {
      kind: 'partial',
      latestTypedAtMs: tail.latestTypedAtMs,
      reason: 'only the end of this session’s own transcript was read',
    },
    input.nowMs,
    input.graceMinutes,
  );
}

const REAL_DEPS: BrakeHookDeps = {
  knobs: realKnobs,
  log: (line, env) => {
    const written = appendQuotaLog(line, env);
    return written.kind === 'failed' ? written.reason : null;
  },
  measure: realMeasure,
  ownAttendance: (input) => Promise.resolve(ownAttendanceFromTail(input)),
};

export interface BrakeHookResult {
  /** What the table decided; null when the brake did not apply (off, no session). */
  action: BrakeAction | null;
  exitCode: 0 | 2;
  /** Whether this call recomputed the verdict. */
  recomputed: boolean;
  stderr: string;
}

function sizeOf(path: string | null): number | null {
  if (path == null) return null;
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

/** Is the cached state still the answer for this call? */
function stillFresh(input: {
  knobs: BrakeKnobs;
  nowMs: number;
  read: BrakeStateRead;
}): BrakeState | null {
  const {knobs, nowMs, read} = input;
  if (read.kind !== 'read') return null;
  const {state} = read;
  if (state.mode !== knobs.mode) return null;
  const age = nowMs - state.computedAtMs;
  if (age < 0) return null;
  if (state.attendedUntilMs != null) {
    // The attended fast path: fresh until the grace runs out, by today's
    // grace knob too, so shortening it takes effect at once. An unreadable
    // typed time recomputes.
    const typedAtMs =
      state.latestTypedAt == null
        ? Number.NaN
        : Date.parse(state.latestTypedAt);
    const untilMs = Math.min(
      state.attendedUntilMs,
      typedAtMs + knobs.attendedGraceMinutes * 60_000,
    );
    return nowMs < untilMs ? state : null;
  }
  if (age >= knobs.recheckSeconds * 1000) return null;
  // Justin typing resets it: a typed line since the recompute recomputes.
  if (state.state !== 'clear' && state.transcriptPath != null) {
    const since = typedLineSince(
      state.transcriptPath,
      state.transcriptSize ?? 0,
    );
    if (since.kind !== 'none') return null;
  }
  return state;
}

/** The session's own attendance; a throw is unknown (the cautious side). */
async function ownAttendanceOf(input: {
  deps: BrakeHookDeps;
  env: EnvLike;
  knobs: BrakeKnobs;
  nowMs: number;
  payload: BrakePayload;
}): Promise<Attendance> {
  try {
    return await input.deps.ownAttendance({
      dropFirstPrompt: input.env[SPAWN_KICKOFF_ENV] === '1',
      graceMinutes: input.knobs.attendedGraceMinutes,
      nowMs: input.nowMs,
      transcriptPath: input.payload.transcriptPath,
    });
  } catch (error) {
    return {kind: 'unknown', reason: String(error)};
  }
}

/**
 * D10: the state when the measurement (or the brake) failed. Attended,
 * proven from this session's own transcript, allows; anything else is as over.
 */
async function failureState(input: {
  base: Omit<
    BrakeState,
    | 'attendance'
    | 'latestTypedAt'
    | 'limitText'
    | 'state'
    | 'unattendedWeekPercent'
    | 'verdict'
  >;
  deps: BrakeHookDeps;
  env: EnvLike;
  knobs: BrakeKnobs;
  nowMs: number;
  payload: BrakePayload;
  why: string;
}): Promise<BrakeState> {
  const {knobs, why} = input;
  const attendance = await ownAttendanceOf(input);
  const attended = attendance.kind === 'attended';
  return {
    ...input.base,
    attendance: attendance.kind,
    latestTypedAt:
      attendance.kind === 'unknown' || attendance.latestTypedAtMs == null
        ? null
        : new Date(attendance.latestTypedAtMs).toISOString(),
    limitText: attended
      ? why
      : `${why}, and nobody has typed in this session in the last ${knobs.attendedGraceMinutes} min`,
    state: attended ? 'attendedUnknown' : 'braked',
    unattendedWeekPercent: null,
    verdict: `UNKNOWN: ${why}`,
  };
}

/** Write the state and its `recheck` line; returns what failed. */
function persist(input: {
  deps: BrakeHookDeps;
  env: EnvLike;
  line: Record<string, unknown>;
  state: BrakeState;
}): string[] {
  const problems: string[] = [];
  try {
    writeBrakeState(input.state, input.env);
  } catch (error) {
    problems.push(
      `the brake state was NOT written (${String(error)}); the next call recomputes`,
    );
  }
  const logged = input.deps.log(input.line, input.env);
  if (logged != null) problems.push(`the quota log was NOT written: ${logged}`);
  return problems;
}

/** Recompute the state; a failure of the measurement is the D10 path. */
async function recompute(input: {
  deps: BrakeHookDeps;
  env: EnvLike;
  knobs: BrakeKnobs;
  nowMs: number;
  payload: BrakePayload;
  projectRoot: string;
  sessionId: string;
}): Promise<{problems: string[]; state: BrakeState}> {
  const {deps, env, knobs, nowMs, payload, sessionId} = input;
  const mode = knobs.mode;
  const base = {
    attendedUntilMs: null,
    computedAtMs: nowMs,
    mode,
    sessionId,
    transcriptPath: payload.transcriptPath,
    transcriptSize: sizeOf(payload.transcriptPath),
    version: 1 as const,
  };
  let state: BrakeState;
  let line: Record<string, unknown>;
  try {
    const measured = await deps.measure({
      cwd: payload.cwd ?? input.projectRoot,
      env,
      nowMs,
      sessionId,
    });
    // D10 for a measured unknown: when the group's attendance is not proven
    // (no session bead yet, an unreadable member), this session's own
    // transcript can still prove Justin is here. It can never prove the
    // opposite, so it is read only to allow. Without it a session Justin
    // just started would be braked until its bead is filed (~15 s).
    let verdict = measured.verdict;
    let ownTypedAt: string | null = null;
    if (verdict.kind === 'unknown' && verdict.attendance.kind !== 'attended') {
      const own = await ownAttendanceOf({deps, env, knobs, nowMs, payload});
      if (own.kind === 'attended') {
        verdict = {...verdict, attendance: own};
        ownTypedAt = new Date(own.latestTypedAtMs).toISOString();
      }
    }
    const {limitText, state: kind} = stateOfVerdict(
      verdict,
      measured.limits.attendedGraceMinutes,
    );
    const {recheckLine} = await import('./quota-log');
    line = recheckLine({
      mode,
      report: measured.report,
      verdict: measured.verdict,
      verdictText: measured.verdictText,
    });
    if (ownTypedAt != null) {
      line.ownTranscriptAttended = true;
      line.latestTypedAt = ownTypedAt;
    }
    state = {
      ...base,
      attendance:
        verdict.kind === 'unknown'
          ? verdict.attendance.kind
          : verdict.attended
            ? 'attended'
            : 'unattended',
      latestTypedAt: (line.latestTypedAt as string | null) ?? null,
      limitText,
      state: kind,
      unattendedWeekPercent:
        (line.unattendedWeekPercent as number | null) ?? null,
      verdict: measured.verdictText,
    };
  } catch (error) {
    // D10: a crash of the measurement is unknown.
    state = await failureState({
      base,
      deps,
      env,
      knobs,
      nowMs,
      payload,
      why: `the brake failed (${error instanceof Error ? error.message : String(error)})`,
    });
    line = {
      at: new Date(nowMs).toISOString(),
      attendance: state.attendance,
      failed: state.verdict,
      kind: 'recheck',
      latestTypedAt: state.latestTypedAt,
      mode,
      sessionId,
      verdict: state.verdict,
      verdictKind: 'unknown',
    };
  }
  return {problems: persist({deps, env, line, state}), state};
}

/**
 * The attended fast path (home-base-ys9t7.5.6, D6): before any group read or
 * pricing, the session's own transcript tail. Typed within the grace: a clear
 * state cached until the grace runs out, and a `recheck` line with
 * attendedFastPath: true and no spend. Anything else returns null and the
 * caller runs the full recompute.
 *
 * A typed line dated after now is not used: the cache would run past now plus
 * the grace (a clock step, a bad timestamp), which moves the verdict toward
 * allow for longer than the grace. The full path decides that call.
 */
async function attendedFastPath(input: {
  deps: BrakeHookDeps;
  env: EnvLike;
  knobs: BrakeKnobs;
  nowMs: number;
  payload: BrakePayload;
  sessionId: string;
}): Promise<{problems: string[]; state: BrakeState} | null> {
  const {deps, env, knobs, nowMs, payload, sessionId} = input;
  const own = await ownAttendanceOf({deps, env, knobs, nowMs, payload});
  if (own.kind !== 'attended' || own.latestTypedAtMs > nowMs) return null;
  const typedAt = new Date(own.latestTypedAtMs).toISOString();
  const attendedUntilMs =
    own.latestTypedAtMs + knobs.attendedGraceMinutes * 60_000;
  const attendedUntil = new Date(attendedUntilMs).toISOString();
  const verdict = `ALLOWED: Justin typed in this session at ${typedAt}; not measured until ${attendedUntil} (attended fast path)`;
  const state: BrakeState = {
    attendance: 'attended',
    attendedUntilMs,
    computedAtMs: nowMs,
    latestTypedAt: typedAt,
    limitText: '',
    mode: knobs.mode,
    sessionId,
    state: 'clear',
    transcriptPath: payload.transcriptPath,
    transcriptSize: sizeOf(payload.transcriptPath),
    unattendedWeekPercent: null,
    verdict,
    version: 1,
  };
  const line = {
    at: new Date(nowMs).toISOString(),
    attendance: 'attended',
    attendedFastPath: true,
    attendedUntil,
    kind: 'recheck',
    latestTypedAt: typedAt,
    mode: knobs.mode,
    sessionId,
    verdict,
  };
  return {problems: persist({deps, env, line, state}), state};
}

/**
 * The one fail-open row: the quota MODE could not be read (or the brake threw
 * before it could be). Without the mode a deny would brake repos whose quota
 * is off, so it says so on stderr and allows. Every failure AFTER the mode is
 * known goes through failureState (D10) instead.
 */
function failedBrake(why: string): BrakeHookResult {
  return {
    action: null,
    exitCode: 0,
    recomputed: false,
    stderr: `thread brake: ${why}; this call was not checked\n`,
  };
}

async function brakeHookUnsafe(
  args: {env: EnvLike; nowMs: number; stdin: string},
  deps: BrakeHookDeps,
): Promise<BrakeHookResult> {
  const {env, nowMs} = args;
  const allow: BrakeHookResult = {
    action: null,
    exitCode: 0,
    recomputed: false,
    stderr: '',
  };
  const payload = parseBrakePayload(args.stdin);
  // No payload means no session id: the table's "allow, nothing written".
  if (payload?.sessionId == null) return allow;
  const projectRoot =
    nonEmpty(env.CLAUDE_PROJECT_DIR) ?? payload.cwd ?? process.cwd();
  let knobs: BrakeKnobs;
  try {
    knobs = await deps.knobs(projectRoot, env);
  } catch (error) {
    // The mode itself is unknown: a deny here would brake repos whose quota
    // is off, so this one row says so and allows.
    return failedBrake(
      `the quota mode could not be read (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (knobs.mode === 'off') return allow;
  const mode = knobs.mode;
  const {sessionId} = payload;

  const problems: string[] = [];
  let fresh: BrakeState | null = null;
  let state: BrakeState;
  try {
    fresh = stillFresh({
      knobs,
      nowMs,
      read: readBrakeState(sessionId, env),
    });
    if (fresh != null) state = fresh;
    else {
      const computed =
        (await attendedFastPath({
          deps,
          env,
          knobs,
          nowMs,
          payload,
          sessionId,
        })) ??
        (await recompute({
          deps,
          env,
          knobs,
          nowMs,
          payload,
          projectRoot,
          sessionId,
        }));
      state = computed.state;
      problems.push(...computed.problems);
    }
  } catch (error) {
    // D10: the brake itself threw. The same rule as a failed measurement.
    state = await failureState({
      base: {
        attendedUntilMs: null,
        computedAtMs: nowMs,
        mode,
        sessionId,
        transcriptPath: payload.transcriptPath,
        transcriptSize: null,
        version: 1,
      },
      deps,
      env,
      knobs,
      nowMs,
      payload,
      why: `the brake failed (${error instanceof Error ? error.message : String(error)})`,
    });
  }
  const recomputed = fresh == null;

  const action = brakeDecision({
    command: payload.command,
    mode,
    state: state.state,
    toolName: payload.toolName,
  });
  const logBrake = (): void => {
    const problem = deps.log(
      {
        action,
        agentId: payload.agentId,
        agentType: payload.agentType,
        at: new Date(nowMs).toISOString(),
        command: payload.command == null ? null : payload.command.slice(0, 300),
        kind: 'brake',
        latestTypedAt: state.latestTypedAt,
        limit: state.limitText,
        mode,
        sessionId,
        toolName: payload.toolName,
        transcriptPath: payload.transcriptPath,
        unattendedWeekPercent: state.unattendedWeekPercent,
        verdict: state.verdict,
      },
      env,
    );
    if (problem != null)
      problems.push(`the quota log was NOT written: ${problem}`);
  };
  const notes = (): string =>
    problems.map((p) => `thread brake: ${p}\n`).join('');

  if (action === 'deny') {
    logBrake();
    return {
      action,
      exitCode: 2,
      recomputed,
      stderr: `${brakeDenialMessage(state.limitText)}\n${notes()}`,
    };
  }
  if (action === 'wouldDeny') {
    // F2: once per recompute, as allowAttendedUnknown. Per call, an over
    // session in observe would write a line for every tool call it makes.
    if (recomputed) logBrake();
    return {action, exitCode: 0, recomputed, stderr: notes()};
  }
  if (action === 'allowAttendedUnknown' && recomputed) {
    logBrake();
    return {
      action,
      exitCode: 0,
      recomputed,
      stderr: `thread brake: allowed because Justin typed here recently, but ${state.limitText}\n${notes()}`,
    };
  }
  return {action, exitCode: 0, recomputed, stderr: notes()};
}

/** One PreToolUse run: allow (exit 0) or deny (exit 2, message on stderr). */
export async function brakeHook(
  args: {env?: EnvLike; nowMs?: number; stdin: string},
  deps: Partial<BrakeHookDeps> = {},
): Promise<BrakeHookResult> {
  try {
    return await brakeHookUnsafe(
      {
        env: args.env ?? process.env,
        nowMs: args.nowMs ?? Date.now(),
        stdin: args.stdin,
      },
      {...REAL_DEPS, ...deps},
    );
  } catch (error) {
    return failedBrake(
      `the brake failed (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

/** The CLI: read stdin once, decide, print, exit. */
export async function runThreadBrakeHook(): Promise<number> {
  let stdin = '';
  try {
    stdin = readFileSync(0, 'utf8');
  } catch {
    stdin = '';
  }
  const result = await brakeHook({stdin});
  if (result.stderr !== '') process.stderr.write(result.stderr);
  return result.exitCode;
}
