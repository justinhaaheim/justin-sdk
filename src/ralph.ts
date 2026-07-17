/**
 * ralph — an EXTERNAL autonomous loop runner ("Ralph Wiggum loop").
 *
 * Each iteration spawns a FRESH `claude -p` process that does ONE unit of work
 * and exits. Progress lives in git + beads, never in a context window — that is
 * the entire point of the technique. The loop is the terminal, not a Stop hook
 * inside a session.
 *
 * Why this exists rather than adopting an off-the-shelf harness: every popular
 * Ralph implementation reinvents a task list (prd.json / fix_plan.md), detects
 * completion by grepping for a magic string, and estimates quota by counting
 * calls locally. We already have a better task list (beads), Claude Code ships
 * `--json-schema` for a typed verdict, and `/usage` reports the REAL server-side
 * quota for free. See beads home-base-aa6j for the full research + anti-decisions.
 *
 * Two facts this design rests on, both verified empirically (2026-07-16):
 *   1. `claude -p "/usage" --output-format json` costs ZERO tokens (num_turns=0,
 *      duration_api_ms=0, modelUsage={}) and returns the real subscription quota.
 *      So the gate can be checked before every iteration, for free.
 *   2. `--json-schema` composes with a slash-command prompt, so `/loop-session`
 *      can return a validated verdict object instead of a sentinel string.
 */
import {spawnSync} from 'node:child_process';
import {appendFileSync, mkdirSync} from 'node:fs';
import {dirname} from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VerdictStatus = 'CONTINUE' | 'COMPLETE' | 'BLOCKED' | 'FAILED';

export interface Verdict {
  status: VerdictStatus;
  summary: string;
  followUps: string[];
}

export interface UsageSnapshot {
  /** Percent of the 5-hour session window consumed (0-100). */
  sessionPct: number;
  /** Percent of the weekly all-models window consumed (0-100). */
  weekPct: number;
  sessionResetsAt: string | null;
  weekResetsAt: string | null;
  /** True when the account is on a subscription rather than API billing. */
  isSubscription: boolean;
  raw: string;
}

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface IterationResult {
  verdict: Verdict | null;
  costUsd: number;
  tokens: TokenCounts;
  numTurns: number;
  durationMs: number;
  sessionId: string | null;
  isError: boolean;
  subtype: string | null;
  /** Non-zero exit or unparseable output — the iteration did not report cleanly. */
  crashed: boolean;
}

export interface RalphOptions {
  /** Prompt for each iteration. A slash command works (verified). */
  prompt: string;
  maxIterations: number;
  /**
   * Stop/pause when the 5-hour session window reaches this percent.
   * Justin's default is 50 — leave half the window for interactive work.
   */
  sessionStopPct: number;
  /** Stop/pause when the weekly all-models window reaches this percent. */
  weeklyStopPct: number;
  /** What to do when a quota gate trips. */
  onGateHit: 'pause' | 'exit';
  /** Minutes between free /usage polls while paused at a gate. */
  gatePollMin: number;
  /** Hard per-iteration cost circuit breaker. null disables. */
  maxBudgetUsd: number | null;
  model: string;
  permissionMode: string;
  /** Per-iteration wall-clock timeout. */
  timeoutMin: number;
  /** Abort after this many consecutive iterations that produce no new commit. */
  noProgressAbort: number;
  /** Append one JSON line per iteration here. null disables. */
  ledgerPath: string | null;
  dryRun: boolean;
}

export const DEFAULT_OPTIONS: RalphOptions = {
  gatePollMin: 5,
  ledgerPath: 'tmp/ralph-ledger.jsonl',
  maxBudgetUsd: null,
  maxIterations: 10,
  model: 'opus',
  noProgressAbort: 3,
  onGateHit: 'pause',
  permissionMode: 'auto',
  prompt: '/loop-session',
  sessionStopPct: 50,
  timeoutMin: 45,
  weeklyStopPct: 80,
  dryRun: false,
};

/**
 * The verdict contract. Given to `claude` via --json-schema so the model cannot
 * typo or paraphrase its way past the gate the way a `<promise>COMPLETE</promise>`
 * sentinel allows.
 */
export const VERDICT_SCHEMA = {
  additionalProperties: false,
  properties: {
    followUps: {
      description:
        'Bead IDs filed for follow-up work discovered this iteration.',
      items: {type: 'string'},
      type: 'array',
    },
    status: {
      description:
        'COMPLETE = no eligible work remains. CONTINUE = did exactly one unit of work, more remains. BLOCKED = needs a human decision, credential, or physical device. FAILED = checks are red and could not be fixed.',
      enum: ['CONTINUE', 'COMPLETE', 'BLOCKED', 'FAILED'],
      type: 'string',
    },
    summary: {
      description: 'One sentence on what this iteration actually did.',
      type: 'string',
    },
  },
  required: ['status', 'summary', 'followUps'],
  type: 'object',
} as const;

/**
 * The verdict contract, injected per-run rather than written into the skill.
 *
 * `/loop-session` is shared with the interactive path and shouldn't carry
 * runner-specific plumbing, so the loop semantics are appended to the system
 * prompt at spawn time instead. --json-schema alone forces the SHAPE of the
 * answer; this is what tells the model how to CHOOSE between the four states.
 */
export const VERDICT_CONTRACT = `
You are running as one iteration of an autonomous loop. An external runner
spawns you, you do ONE unit of work, you exit, and it spawns a fresh you.
Nothing survives in context between iterations — only git, beads, and the
working tree carry state forward. Act accordingly.

Rules for this iteration:
- Do exactly ONE unit of work. Do not batch. The loop will call you again.
- Before concluding something is unimplemented, search for it. A failed search
  is not proof of absence.
- No placeholder or stub implementations. Finish what you start or report it.
- File follow-up work you discover as beads rather than doing it now.
- Commit your work. An iteration that leaves nothing committed is a lost one.
- Do NOT attempt to recover a broken tree with destructive git commands
  (reset --hard, clean -fd, restore .). The runner owns rescue. Report FAILED.

You MUST end by reporting a verdict:
- COMPLETE: no eligible work remains. The loop stops.
- CONTINUE: you did one unit of work and more remains. The loop continues.
- BLOCKED: you need a human decision, a credential, or a physical device.
  File a bead describing what you need. The loop stops.
- FAILED: checks are red and you could not fix them. The loop stops.

Be honest in the verdict. Reporting CONTINUE on work you did not actually
finish, or COMPLETE to end the loop early, corrupts every downstream decision
the runner makes.
`.trim();

// ---------------------------------------------------------------------------
// Usage gate — free, server-authoritative
// ---------------------------------------------------------------------------

/**
 * Parse the text `/usage` prints. Returns null when the shape is unrecognized,
 * which callers MUST treat as fail-closed: if we cannot read the quota we do not
 * spend it.
 */
export function parseUsage(raw: string): UsageSnapshot | null {
  const session = /Current session:\s*(\d+)%\s*used/.exec(raw);
  const week = /Current week \(all models\):\s*(\d+)%\s*used/.exec(raw);
  if (session == null || week == null) {
    return null;
  }
  const sessionResets = /Current session:[^·\n]*·\s*resets\s*([^\n(]+)/.exec(
    raw,
  );
  const weekResets =
    /Current week \(all models\):[^·\n]*·\s*resets\s*([^\n(]+)/.exec(raw);

  return {
    isSubscription: /using your subscription/i.test(raw),
    raw,
    sessionPct: Number(session[1]),
    sessionResetsAt: sessionResets != null ? sessionResets[1].trim() : null,
    weekPct: Number(week[1]),
    weekResetsAt: weekResets != null ? weekResets[1].trim() : null,
  };
}

/** Read the real quota. Costs zero tokens (verified: num_turns=0, cost=0). */
export function readUsage(cwd: string): UsageSnapshot | null {
  const proc = spawnSync(
    'claude',
    ['-p', '/usage', '--output-format', 'json'],
    {cwd, encoding: 'utf-8', env: process.env, timeout: 60_000},
  );
  if (proc.status !== 0 || proc.stdout == null) {
    return null;
  }
  try {
    const parsed = JSON.parse(proc.stdout) as {result?: string};
    return typeof parsed.result === 'string' ? parseUsage(parsed.result) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// One iteration
// ---------------------------------------------------------------------------

function emptyTokens(): TokenCounts {
  return {cacheCreation: 0, cacheRead: 0, input: 0, output: 0};
}

/**
 * Spawn one fresh `claude -p`. Never resumes: a clean context every iteration is
 * the technique, not an oversight.
 *
 * Uses argv rather than a shell string on purpose — the prompt and the JSON
 * schema are full of braces and quotes, and shell interpolation has silently
 * mangled arguments in this codebase before.
 */
export function runIteration(cwd: string, opts: RalphOptions): IterationResult {
  const args = [
    '-p',
    opts.prompt,
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(VERDICT_SCHEMA),
    '--model',
    opts.model,
    '--permission-mode',
    opts.permissionMode,
    '--append-system-prompt',
    VERDICT_CONTRACT,
  ];
  if (opts.maxBudgetUsd != null) {
    args.push('--max-budget-usd', String(opts.maxBudgetUsd));
  }

  const started = Date.now();
  const proc = spawnSync('claude', args, {
    cwd,
    encoding: 'utf-8',
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
    timeout: opts.timeoutMin * 60_000,
  });
  const durationMs = Date.now() - started;

  const crashedResult: IterationResult = {
    costUsd: 0,
    crashed: true,
    durationMs,
    isError: true,
    numTurns: 0,
    sessionId: null,
    subtype: proc.signal === 'SIGTERM' ? 'timeout' : 'crash',
    tokens: emptyTokens(),
    verdict: null,
  };

  if (proc.stdout == null || proc.stdout.trim() === '') {
    return crashedResult;
  }

  try {
    const d = JSON.parse(proc.stdout) as Record<string, unknown>;
    const usage = (d.usage ?? {}) as Record<string, number>;
    const structured = d.structured_output as Verdict | undefined;
    return {
      costUsd: typeof d.total_cost_usd === 'number' ? d.total_cost_usd : 0,
      crashed: false,
      durationMs,
      isError: d.is_error === true,
      numTurns: typeof d.num_turns === 'number' ? d.num_turns : 0,
      sessionId: typeof d.session_id === 'string' ? d.session_id : null,
      subtype: typeof d.subtype === 'string' ? d.subtype : null,
      tokens: {
        cacheCreation: usage.cache_creation_input_tokens ?? 0,
        cacheRead: usage.cache_read_input_tokens ?? 0,
        input: usage.input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
      },
      verdict: structured ?? null,
    };
  } catch {
    return crashedResult;
  }
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

function gitHead(cwd: string): string | null {
  const proc = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd,
    encoding: 'utf-8',
  });
  return proc.status === 0 ? proc.stdout.trim() : null;
}

interface PreflightProblem {
  fatal: boolean;
  message: string;
}

export function preflight(cwd: string): PreflightProblem[] {
  const problems: PreflightProblem[] = [];

  if (spawnSync('claude', ['--version'], {encoding: 'utf-8'}).status !== 0) {
    problems.push({fatal: true, message: 'claude CLI not found on PATH'});
  }
  if (gitHead(cwd) == null) {
    problems.push({fatal: true, message: `not a git repository: ${cwd}`});
  }
  // A stray API key silently bills credits while you believe you are on the
  // subscription — the SDK auth precedence puts it ahead of OAuth.
  if (
    process.env.ANTHROPIC_API_KEY != null &&
    process.env.ANTHROPIC_API_KEY !== ''
  ) {
    problems.push({
      fatal: true,
      message:
        'ANTHROPIC_API_KEY is set — this would bill API credits instead of your subscription. Unset it before looping.',
    });
  }
  // A nested claude inherits the parent sandbox and cannot create its session
  // dir (verified: EPERM on ~/.claude/session-env). Run from a real terminal.
  if (
    process.env.CLAUDECODE != null ||
    process.env.CLAUDE_CODE_SIMPLE != null
  ) {
    problems.push({
      fatal: false,
      message:
        'looks like this is running inside a Claude Code session — a nested claude may fail with EPERM. Run ralph from a real terminal.',
    });
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

const DIM = '[2m';
const RESET = '[0m';
const BOLD = '[1m';
const GREEN = '[32m';
const YELLOW = '[33m';
const RED = '[31m';
const CYAN = '[36m';

function statusColor(status: VerdictStatus | 'CRASH'): string {
  if (status === 'COMPLETE') return GREEN;
  if (status === 'CONTINUE') return CYAN;
  if (status === 'BLOCKED') return YELLOW;
  return RED;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function quotaBar(pct: number, limit: number): string {
  const width = 20;
  const filled = Math.min(width, Math.round((pct / 100) * width));
  const marker = Math.min(width, Math.round((limit / 100) * width));
  let bar = '';
  for (let i = 0; i < width; i++) {
    if (i === marker) bar += '|';
    else bar += i < filled ? '=' : '-';
  }
  const color = pct >= limit ? RED : pct >= limit * 0.8 ? YELLOW : GREEN;
  return `${color}[${bar}]${RESET} ${pct}%${DIM} (stop at ${limit}%)${RESET}`;
}

interface RunTotals {
  iterations: number;
  costUsd: number;
  tokens: TokenCounts;
  commits: number;
}

function renderHeader(cwd: string, opts: RalphOptions): void {
  process.stdout.write(
    `\n${BOLD}ralph${RESET} ${DIM}→${RESET} ${cwd}\n` +
      `${DIM}prompt=${opts.prompt}  model=${opts.model}  mode=${opts.permissionMode}  ` +
      `max=${opts.maxIterations} iters  session-stop=${opts.sessionStopPct}%  week-stop=${opts.weeklyStopPct}%${RESET}\n\n`,
  );
}

function renderIteration(
  n: number,
  opts: RalphOptions,
  usage: UsageSnapshot,
  result: IterationResult,
  progressed: boolean,
): void {
  const max = opts.maxIterations;
  const status: VerdictStatus | 'CRASH' = result.crashed
    ? 'CRASH'
    : (result.verdict?.status ?? 'FAILED');
  const total =
    result.tokens.input +
    result.tokens.output +
    result.tokens.cacheRead +
    result.tokens.cacheCreation;
  const secs = Math.round(result.durationMs / 1000);

  process.stdout.write(
    `${BOLD}#${n}/${max}${RESET} ${statusColor(status)}${status}${RESET} ` +
      `${DIM}${secs}s · ${result.numTurns} turns · ${fmtTokens(total)} tok · $${result.costUsd.toFixed(2)} · ` +
      `${progressed ? 'committed' : 'no commit'}${RESET}\n`,
  );
  const summary = result.verdict?.summary;
  if (summary != null && summary !== '') {
    process.stdout.write(`   ${summary}\n`);
  }
  const followUps = result.verdict?.followUps ?? [];
  if (followUps.length > 0) {
    process.stdout.write(
      `   ${DIM}follow-ups: ${followUps.join(', ')}${RESET}\n`,
    );
  }
  process.stdout.write(
    `   ${DIM}session${RESET} ${quotaBar(usage.sessionPct, opts.sessionStopPct)}` +
      `   ${DIM}week${RESET} ${quotaBar(usage.weekPct, opts.weeklyStopPct)}\n`,
  );
}

function renderSummary(totals: RunTotals, reason: string): void {
  const t = totals.tokens;
  const total = t.input + t.output + t.cacheRead + t.cacheCreation;
  process.stdout.write(
    `\n${BOLD}── run summary ──${RESET}\n` +
      `  stopped     ${reason}\n` +
      `  iterations  ${totals.iterations}\n` +
      `  commits     ${totals.commits}\n` +
      `  cost        $${totals.costUsd.toFixed(2)}\n` +
      `  tokens      ${fmtTokens(total)} ${DIM}(in ${fmtTokens(t.input)} · out ${fmtTokens(t.output)} · cache-r ${fmtTokens(t.cacheRead)} · cache-w ${fmtTokens(t.cacheCreation)})${RESET}\n\n`,
  );
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

function appendLedger(
  cwd: string,
  path: string | null,
  entry: Record<string, unknown>,
): void {
  if (path == null) return;
  const full = path.startsWith('/') ? path : `${cwd}/${path}`;
  try {
    mkdirSync(dirname(full), {recursive: true});
    appendFileSync(full, `${JSON.stringify(entry)}\n`);
  } catch {
    // A ledger write failure must never kill a run.
  }
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Block until both quota windows are back under their thresholds. Polling is
 * free (see readUsage), so we poll rather than parse the reset timestamp — no
 * timezone/date parsing to get wrong.
 */
async function waitForGate(
  cwd: string,
  opts: RalphOptions,
  usage: UsageSnapshot,
): Promise<UsageSnapshot | null> {
  let current: UsageSnapshot | null = usage;
  while (
    current != null &&
    (current.sessionPct >= opts.sessionStopPct ||
      current.weekPct >= opts.weeklyStopPct)
  ) {
    const which =
      current.sessionPct >= opts.sessionStopPct ? 'session' : 'weekly';
    process.stdout.write(
      `${YELLOW}⏸${RESET}  ${which} quota gate: session ${current.sessionPct}% / week ${current.weekPct}%. ` +
        `${DIM}resets ${current.sessionResetsAt ?? 'unknown'} · re-checking in ${opts.gatePollMin}m${RESET}\n`,
    );
    await sleep(opts.gatePollMin * 60_000);
    current = readUsage(cwd);
  }
  return current;
}

export async function runRalph(
  cwd: string,
  overrides: Partial<RalphOptions> = {},
): Promise<number> {
  const opts: RalphOptions = {...DEFAULT_OPTIONS, ...overrides};

  for (const problem of preflight(cwd)) {
    process.stderr.write(
      `${problem.fatal ? RED + 'error' : YELLOW + 'warn '}${RESET} ${problem.message}\n`,
    );
    if (problem.fatal) return 1;
  }

  renderHeader(cwd, opts);

  if (opts.dryRun) {
    const usage = readUsage(cwd);
    if (usage == null) {
      process.stderr.write(`${RED}error${RESET} could not read /usage\n`);
      return 1;
    }
    process.stdout.write(
      `${DIM}dry run — no iterations spawned${RESET}\n` +
        `  subscription  ${usage.isSubscription ? 'yes' : `${YELLOW}NO — check billing${RESET}`}\n` +
        `  session       ${quotaBar(usage.sessionPct, opts.sessionStopPct)}\n` +
        `  week          ${quotaBar(usage.weekPct, opts.weeklyStopPct)}\n\n`,
    );
    return 0;
  }

  const totals: RunTotals = {
    commits: 0,
    costUsd: 0,
    iterations: 0,
    tokens: emptyTokens(),
  };
  let noProgressStreak = 0;
  let crashStreak = 0;
  let stopReason = `reached max iterations (${opts.maxIterations})`;

  for (let n = 1; n <= opts.maxIterations; n++) {
    // --- gate (free) ---
    let usage = readUsage(cwd);
    if (usage == null) {
      // Fail closed: if we cannot read the quota, we do not spend it.
      stopReason =
        'could not read /usage — failing closed rather than spending unknown quota';
      break;
    }
    if (
      usage.sessionPct >= opts.sessionStopPct ||
      usage.weekPct >= opts.weeklyStopPct
    ) {
      if (opts.onGateHit === 'exit') {
        stopReason = `quota gate (session ${usage.sessionPct}% / week ${usage.weekPct}%)`;
        break;
      }
      const resumed = await waitForGate(cwd, opts, usage);
      if (resumed == null) {
        stopReason = 'could not read /usage while paused — failing closed';
        break;
      }
      usage = resumed;
    }

    // --- work ---
    const headBefore = gitHead(cwd);
    const result = runIteration(cwd, opts);
    const headAfter = gitHead(cwd);
    const progressed = headBefore !== headAfter;

    totals.iterations++;
    totals.costUsd += result.costUsd;
    totals.tokens.input += result.tokens.input;
    totals.tokens.output += result.tokens.output;
    totals.tokens.cacheRead += result.tokens.cacheRead;
    totals.tokens.cacheCreation += result.tokens.cacheCreation;
    if (progressed) totals.commits++;

    renderIteration(n, opts, usage, result, progressed);
    appendLedger(cwd, opts.ledgerPath, {
      costUsd: result.costUsd,
      durationMs: result.durationMs,
      iteration: n,
      numTurns: result.numTurns,
      progressed,
      sessionId: result.sessionId,
      sessionPct: usage.sessionPct,
      status: result.crashed ? 'CRASH' : (result.verdict?.status ?? 'UNKNOWN'),
      summary: result.verdict?.summary ?? null,
      tokens: result.tokens,
      weekPct: usage.weekPct,
    });

    // --- decide ---
    if (result.crashed || result.isError) {
      crashStreak++;
      // An auto-mode classifier abort lands here. One aborted iteration is
      // bounded (the next gets a fresh session and a fresh block counter), but a
      // streak means the classifier is missing environment context.
      if (crashStreak >= opts.noProgressAbort) {
        stopReason = `${crashStreak} consecutive failed iterations — check autoMode.environment`;
        break;
      }
      continue;
    }
    crashStreak = 0;

    const status = result.verdict?.status;
    if (status === 'COMPLETE') {
      stopReason = 'COMPLETE — no eligible work remains';
      break;
    }
    if (status === 'BLOCKED') {
      stopReason = `BLOCKED — ${result.verdict?.summary ?? 'needs a human'}`;
      break;
    }
    if (status === 'FAILED') {
      stopReason = `FAILED — ${result.verdict?.summary ?? 'checks red'}`;
      break;
    }

    noProgressStreak = progressed ? 0 : noProgressStreak + 1;
    if (noProgressStreak >= opts.noProgressAbort) {
      stopReason = `${noProgressStreak} iterations with no commit — circuit breaker`;
      break;
    }
  }

  renderSummary(totals, stopReason);
  return stopReason.startsWith('BLOCKED') || stopReason.startsWith('FAILED')
    ? 2
    : 0;
}
