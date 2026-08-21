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
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import {dirname, join} from 'node:path';

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

/**
 * How each iteration runs. These are mutually exclusive at the CLI level — the
 * binary itself refuses `--bg` with `--print`, because "--print never starts the
 * interactive session that `claude agents` attaches to, so the job would be
 * unattachable". So this is a real fork, not a flag.
 *
 * print      — headless. Returns a --json-schema verdict directly. Cannot be
 *              attached to or answered; a question means a BLOCKED verdict.
 * attachable — `claude --bg`. Inspect with `claude logs <id>`, step in with
 *              `claude attach <id>`, answer questions from `claude agents`.
 *              No --print means no --json-schema, so the verdict arrives via a
 *              file the iteration writes as its last act.
 */
export type RunMode = 'print' | 'attachable';

export interface RalphOptions {
  mode: RunMode;
  /**
   * Attachable mode only. How long to leave a blocked session waiting for an
   * answer before giving up on it.
   *
   * This bound is the whole point. Background agents block instead of failing,
   * which is the behaviour we want — but a blocked session nobody answers is an
   * invisible open thread. (Measured on this machine 2026-07-16: 37 background
   * sessions, 17 blocked, oldest 43 days.) When the bound expires we stop the
   * session and file the question as a bead, so it lands somewhere visible
   * instead of joining that graveyard.
   */
  blockedWaitMin: number;
  /** Attachable mode only. Seconds between `claude agents --json` polls. */
  pollSec: number;
  /** Attachable mode only. Where the iteration writes its verdict. */
  verdictPath: string;
  /** Prompt for each iteration. A slash command works (verified). */
  prompt: string;
  maxIterations: number;
  /**
   * Whether to read `/usage` before every iteration and refuse to run when it
   * cannot be read. ON by default, and the default must stay that way: an
   * unreadable quota is UNKNOWN quota, and spending unknown quota is exactly
   * what the gate exists to prevent.
   *
   * The opt-out (`--no-usage-gate`) exists because the gate can become
   * unsatisfiable rather than merely unsatisfied, and then fail-closed stops
   * meaning "careful" and starts meaning "never runs". That is not
   * hypothetical: `claude -p /usage` stopped rendering the quota panel in print
   * mode, so `parseUsage` returned null on every call and every scheduled run
   * became a silent no-op — 0 iterations, $0.00, no output (home-base-nsd5;
   * home-base-j0yo tracks finding a print-mode-compatible quota source).
   *
   * Opting out is sound exactly when the spend is bounded up front rather than
   * by the quota reading — a `--max-iterations 1` job that runs once a day
   * costs what it costs, once. It is NOT sound for a long multi-iteration loop,
   * which is the runaway the gate was built for.
   *
   * When off, NO `/usage` call is made at all, and quota is reported as
   * unread everywhere (dashboard and ledger). It is never reported as 0%:
   * an absent measurement must look absent, not reassuring (critical rule 6).
   */
  usageGate: boolean;
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
  blockedWaitMin: 15,
  dryRun: false,
  gatePollMin: 5,
  ledgerPath: 'tmp/ralph-ledger.jsonl',
  maxBudgetUsd: null,
  maxIterations: 10,
  mode: 'attachable',
  model: 'opus',
  noProgressAbort: 3,
  onGateHit: 'pause',
  permissionMode: 'auto',
  pollSec: 20,
  prompt: '/loop-session',
  sessionStopPct: 50,
  timeoutMin: 45,
  usageGate: true,
  verdictPath: 'tmp/ralph-verdict.json',
  weeklyStopPct: 80,
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

/**
 * Extra contract for attachable mode.
 *
 * In print mode --json-schema guarantees a verdict comes back. Here there is no
 * --print, so nothing forces one: the model has to write the file itself, and a
 * missing file is indistinguishable from a crash. Hence the emphasis.
 */
export function attachableContract(verdictPath: string): string {
  return `${VERDICT_CONTRACT}

You are running as a background agent, so there is no structured-output channel.
Report your verdict by writing ${verdictPath} as the LAST thing you do:

  {"status":"CONTINUE","summary":"<one sentence>","followUps":["<bead-id>"]}

status must be exactly one of CONTINUE, COMPLETE, BLOCKED, FAILED. Write this
file even when things went badly — a missing file is read as a crash, and the
runner cannot tell the difference between "you failed" and "you died".

You CAN ask the human a question: this session blocks and waits rather than
failing, and they can answer from \`claude agents\`. But do not block casually.
The runner only waits a bounded time before stopping you and filing your
question as a bead. Ask only when you genuinely cannot proceed, and make the
question answerable in one line.`;
}

// ---------------------------------------------------------------------------
// Background session control
//
// The control surface, established empirically (2026-07-16) rather than from
// docs, because the docs and the CLI disagree:
//   dispatch — `claude --bg --name X "task"` prints `backgrounded · <id> · <name>`
//   poll     — `claude agents --json` → {id, pid, state, status, waitingFor}
//   inspect  — `claude logs <id>` / `claude attach <id>`  (both real, both hidden)
//   stop     — kill the pid. NOT `claude stop <id>`: the --bg banner advertises
//              that command but it is not a subcommand, so it silently degrades
//              into a *prompt* — spawning a session that bills tokens and leaves
//              the target running.
// ---------------------------------------------------------------------------

export interface AgentRow {
  id: string;
  pid: number | null;
  name: string;
  state: string | null;
  status: string | null;
  waitingFor: string | null;
}

/** Parse the `backgrounded · <id> · <name>` banner. */
export function parseBackgroundedId(stdout: string): string | null {
  const match = /backgrounded\s*·\s*(\S+)/.exec(stdout);
  return match != null ? match[1] : null;
}

export function listAgents(cwd: string): AgentRow[] {
  const proc = spawnSync('claude', ['agents', '--json'], {
    cwd,
    encoding: 'utf-8',
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60_000,
  });
  if (proc.status !== 0 || proc.stdout == null) return [];
  try {
    const rows = JSON.parse(proc.stdout) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id ?? ''),
      name: String(r.name ?? ''),
      pid: typeof r.pid === 'number' ? r.pid : null,
      state: typeof r.state === 'string' ? r.state : null,
      status: typeof r.status === 'string' ? r.status : null,
      waitingFor: typeof r.waitingFor === 'string' ? r.waitingFor : null,
    }));
  } catch {
    return [];
  }
}

export function findAgent(cwd: string, id: string): AgentRow | null {
  return listAgents(cwd).find((r) => r.id === id) ?? null;
}

/**
 * Best-effort stop of a background session.
 *
 * CAVEAT, measured rather than assumed: this is NOT a reliable kill. Background
 * agents run under Claude Code's own daemon (`backend: "daemon"` in the job's
 * state.json) with a `respawnFlags` entry, and a SIGTERM'd session was observed
 * coming back under a new pid. `claude stop <id>` — which the `--bg` banner
 * itself advertises — is not a registered subcommand and degrades into a
 * *prompt*, so it stops nothing and bills tokens for the privilege.
 *
 * So the "we always clean up after ourselves" guarantee is currently
 * best-effort. The reliable stop is `claude agents` → Ctrl+X, which is
 * interactive-only. Tracked in home-base-aa6j.9.
 */
export function stopAgent(row: AgentRow | null): void {
  if (row?.pid == null) return;
  try {
    process.kill(row.pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
}

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

/**
 * The four things the pre-iteration gate can conclude. They are four DIFFERENT
 * facts and the type keeps them that way: "the gate was off" is not "the quota
 * is 0%", and neither is "the quota could not be read" (critical rule 6).
 *
 * `disabled` deliberately carries no UsageSnapshot. There is nothing to carry —
 * with the gate off no quota is read at all, so any number here would be
 * invented.
 */
export type GateDecision =
  | {kind: 'disabled'}
  | {kind: 'ok'; usage: UsageSnapshot}
  | {kind: 'tripped'; usage: UsageSnapshot}
  | {kind: 'unreadable'; reason: string};

/**
 * Decide whether an iteration may start.
 *
 * The quota reader is injected rather than called directly so this stays
 * testable without spawning `claude` — and so a test can assert the property
 * that actually matters when the gate is off: that the reader is never called
 * AT ALL. "Skips the gate" must mean no `/usage` process is spawned, not that
 * one is spawned and its answer ignored.
 */
export function checkGate(
  opts: Pick<RalphOptions, 'sessionStopPct' | 'usageGate' | 'weeklyStopPct'>,
  readQuota: () => UsageSnapshot | null,
): GateDecision {
  if (!opts.usageGate) {
    return {kind: 'disabled'};
  }
  const usage = readQuota();
  if (usage == null) {
    // Fail closed: if we cannot read the quota, we do not spend it.
    return {
      kind: 'unreadable',
      reason:
        'could not read /usage — failing closed rather than spending unknown quota',
    };
  }
  if (
    usage.sessionPct >= opts.sessionStopPct ||
    usage.weekPct >= opts.weeklyStopPct
  ) {
    return {kind: 'tripped', usage};
  }
  return {kind: 'ok', usage};
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

/**
 * Read and validate the verdict file. Returns null when it is missing or
 * malformed, which the caller treats as a crash — deliberately, since a silent
 * "assume it worked" would let a dead iteration look like a successful one.
 */
export function readVerdictFile(cwd: string, path: string): Verdict | null {
  const full = path.startsWith('/') ? path : join(cwd, path);
  if (!existsSync(full)) return null;
  try {
    const parsed = JSON.parse(readFileSync(full, 'utf8')) as Partial<Verdict>;
    const valid: VerdictStatus[] = ['CONTINUE', 'COMPLETE', 'BLOCKED', 'FAILED'];
    if (
      typeof parsed.status !== 'string' ||
      !valid.includes(parsed.status as VerdictStatus)
    ) {
      return null;
    }
    return {
      followUps: Array.isArray(parsed.followUps) ? parsed.followUps : [],
      status: parsed.status as VerdictStatus,
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    };
  } catch {
    return null;
  }
}

/**
 * One iteration as an attachable background agent.
 *
 * Trade-off vs print mode: no --json-schema and no token/cost telemetry, since
 * `--bg` returns immediately and never emits a result object. What it buys is
 * the ability to see the work (`claude logs`), step into it (`claude attach`),
 * and answer a question mid-flight instead of losing the iteration.
 */
export async function runIterationAttachable(
  cwd: string,
  opts: RalphOptions,
  n: number,
  onBlocked: (row: AgentRow, id: string) => void,
): Promise<IterationResult> {
  const verdictFull = opts.verdictPath.startsWith('/')
    ? opts.verdictPath
    : join(cwd, opts.verdictPath);
  // A stale verdict from the previous iteration would be read as this one's.
  rmSync(verdictFull, {force: true});

  // The contract carries an absolute path because a relative one is ambiguous
  // to the model, not because the cwd is wrong. Measured: a background agent
  // runs in the project directory (`pwd` and `git rev-parse --show-toplevel`
  // both report it). But given a relative `tmp/verdict.json`, one run resolved
  // it against its job dir (~/.claude/jobs/<id>/tmp/) instead, and the runner
  // never found the file. An absolute path removes the choice.
  const name = `ralph-${n}`;
  const started = Date.now();
  const dispatch = spawnSync(
    'claude',
    [
      '--bg',
      '--name',
      name,
      '--model',
      opts.model,
      '--permission-mode',
      opts.permissionMode,
      '--append-system-prompt',
      attachableContract(verdictFull),
      opts.prompt,
    ],
    {cwd, encoding: 'utf-8', env: process.env, timeout: 120_000},
  );

  const id = parseBackgroundedId(dispatch.stdout ?? '');
  if (id == null) {
    return {
      costUsd: 0,
      crashed: true,
      durationMs: Date.now() - started,
      isError: true,
      numTurns: 0,
      sessionId: null,
      subtype: 'dispatch-failed',
      tokens: emptyTokens(),
      verdict: null,
    };
  }

  process.stdout.write(
    `   ${DIM}background ${id} · inspect: claude logs ${id} · step in: claude attach ${id}${RESET}\n`,
  );

  const deadline = started + opts.timeoutMin * 60_000;
  let blockedSince: number | null = null;
  let notified = false;

  for (;;) {
    await sleep(opts.pollSec * 1000);
    const row = findAgent(cwd, id);
    const verdict = readVerdictFile(cwd, opts.verdictPath);

    // The verdict file is the real completion signal. A session can linger in
    // agent view after finishing its work, so trust the file over the state.
    if (verdict != null) {
      stopAgent(row);
      return {
        costUsd: 0,
        crashed: false,
        durationMs: Date.now() - started,
        isError: false,
        numTurns: 0,
        sessionId: id,
        subtype: 'success',
        tokens: emptyTokens(),
        verdict,
      };
    }

    // Finished (or vanished) without writing a verdict. Give the file one grace
    // poll to appear — the session can report `done` a beat before the write
    // lands — then call it a crash rather than polling to the timeout, which is
    // what the first version did for a full 45 minutes.
    const finished =
      row == null ||
      row.state === 'done' ||
      (row.pid == null && row.state !== 'blocked');
    if (finished) {
      await sleep(opts.pollSec * 1000);
      const late = readVerdictFile(cwd, opts.verdictPath);
      if (late != null) {
        stopAgent(row);
        return {
          costUsd: 0,
          crashed: false,
          durationMs: Date.now() - started,
          isError: false,
          numTurns: 0,
          sessionId: id,
          subtype: 'success',
          tokens: emptyTokens(),
          verdict: late,
        };
      }
      return {
        costUsd: 0,
        crashed: true,
        durationMs: Date.now() - started,
        isError: true,
        numTurns: 0,
        sessionId: id,
        subtype: 'no-verdict',
        tokens: emptyTokens(),
        verdict: null,
      };
    }

    if (row.state === 'blocked') {
      if (blockedSince == null) {
        blockedSince = Date.now();
      }
      if (!notified) {
        onBlocked(row, id);
        notified = true;
      }
      // Bounded wait: answer it, or it gets filed as a bead rather than stranded.
      if (Date.now() - blockedSince > opts.blockedWaitMin * 60_000) {
        stopAgent(row);
        return {
          costUsd: 0,
          crashed: false,
          durationMs: Date.now() - started,
          isError: false,
          numTurns: 0,
          sessionId: id,
          subtype: 'blocked-timeout',
          tokens: emptyTokens(),
          verdict: {
            followUps: [],
            status: 'BLOCKED',
            summary: `Waited ${opts.blockedWaitMin}m for an answer to "${row.waitingFor ?? 'a question'}" and got none. Session stopped so it would not strand. Re-run to retry.`,
          },
        };
      }
    } else {
      // Answered, and moving again.
      blockedSince = null;
      notified = false;
    }

    if (Date.now() > deadline) {
      stopAgent(row);
      return {
        costUsd: 0,
        crashed: true,
        durationMs: Date.now() - started,
        isError: true,
        numTurns: 0,
        sessionId: id,
        subtype: 'timeout',
        tokens: emptyTokens(),
        verdict: null,
      };
    }
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

/**
 * What to print where the quota bars would go when the gate is off.
 *
 * Not an empty space and not a 0% bar: the reader has to be able to tell that
 * quota was NOT MEASURED this run, which is a different fact from measuring it
 * and finding room (critical rule 6 — silence must be a claim).
 */
function quotaGateDisabled(): string {
  return `${YELLOW}[gate disabled]${RESET}${DIM} /usage not read — quota UNKNOWN, not 0% (--no-usage-gate)${RESET}`;
}

function renderHeader(cwd: string, opts: RalphOptions): void {
  process.stdout.write(
    `\n${BOLD}ralph${RESET} ${DIM}→${RESET} ${cwd}\n` +
      `${DIM}prompt=${opts.prompt}  model=${opts.model}  perms=${opts.permissionMode}  ` +
      `max=${opts.maxIterations} iters  ` +
      (opts.usageGate
        ? `session-stop=${opts.sessionStopPct}%  week-stop=${opts.weeklyStopPct}%`
        : `usage-gate=DISABLED`) +
      `${RESET}\n` +
      (opts.mode === 'attachable'
        ? `${DIM}mode=attachable — inspect with \`claude agents\`; blocked iterations wait ${opts.blockedWaitMin}m for you${RESET}\n\n`
        : `${DIM}mode=print — headless, not attachable; a question becomes a BLOCKED verdict${RESET}\n\n`),
  );
}

function renderIteration(
  n: number,
  opts: RalphOptions,
  /** null when the gate was disabled — no quota was read for this iteration. */
  usage: UsageSnapshot | null,
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
    usage == null
      ? `   ${DIM}quota${RESET} ${quotaGateDisabled()}\n`
      : `   ${DIM}session${RESET} ${quotaBar(usage.sessionPct, opts.sessionStopPct)}` +
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
 * Get a blocked iteration in front of the human.
 *
 * Best-effort and deliberately dumb: a terminal bell plus a macOS notification.
 * The real "answer from my phone" path is Remote Control, which pushes
 * permission prompts and questions to the Claude app — but it attaches to
 * interactive sessions, and whether it composes with `--bg` is untested. Until
 * that is settled this at least makes a block audible rather than silent, which
 * is the actual failure mode (17 sessions on this machine blocked unnoticed,
 * oldest 43 days).
 */
function notifyBlocked(cwd: string, n: number, row: AgentRow): void {
  process.stdout.write(''); // bell
  if (process.platform !== 'darwin') return;
  const message = `Iteration ${n} needs input: ${row.waitingFor ?? 'a question'}`;
  spawnSync(
    'osascript',
    [
      '-e',
      `display notification ${JSON.stringify(message)} with title "ralph" sound name "Ping"`,
    ],
    {cwd, encoding: 'utf-8', timeout: 10_000},
  );
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
    if (!opts.usageGate) {
      process.stdout.write(
        `${DIM}dry run — no iterations spawned${RESET}\n` +
          `  quota gate    ${quotaGateDisabled()}\n` +
          `  session       ${DIM}not read${RESET}\n` +
          `  week          ${DIM}not read${RESET}\n\n`,
      );
      return 0;
    }
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
    const decision = checkGate(opts, () => readUsage(cwd));
    if (decision.kind === 'unreadable') {
      stopReason = decision.reason;
      break;
    }
    // Stays null for the whole iteration when the gate is off, all the way
    // through the dashboard and the ledger. A disabled gate means quota was
    // never measured — never that it measured zero.
    let usage: UsageSnapshot | null =
      decision.kind === 'disabled' ? null : decision.usage;
    if (decision.kind === 'tripped') {
      if (opts.onGateHit === 'exit') {
        stopReason = `quota gate (session ${decision.usage.sessionPct}% / week ${decision.usage.weekPct}%)`;
        break;
      }
      const resumed = await waitForGate(cwd, opts, decision.usage);
      if (resumed == null) {
        stopReason = 'could not read /usage while paused — failing closed';
        break;
      }
      usage = resumed;
    }

    // --- work ---
    const headBefore = gitHead(cwd);
    const result =
      opts.mode === 'attachable'
        ? await runIterationAttachable(cwd, opts, n, (row, id) => {
            process.stdout.write(
              `\n${YELLOW}?${RESET}  ${BOLD}iteration ${n} needs you${RESET} — ${row.waitingFor ?? 'waiting for input'}\n` +
                `   ${DIM}answer it:  claude agents   (Space to peek, type a reply)${RESET}\n` +
                `   ${DIM}or step in: claude attach ${id}${RESET}\n` +
                `   ${DIM}waiting up to ${opts.blockedWaitMin}m, then filing it as a bead and moving on${RESET}\n\n`,
            );
            notifyBlocked(cwd, n, row);
          })
        : runIteration(cwd, opts);
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
      // Always emitted, both ways round: a row without this field would leave a
      // later reader unable to tell "gate was on" from "written by an older
      // ralph". Silence must be a claim (critical rule 6).
      gateDisabled: !opts.usageGate,
      iteration: n,
      numTurns: result.numTurns,
      progressed,
      sessionId: result.sessionId,
      // null (not 0) when the gate was off — nothing was measured.
      sessionPct: usage?.sessionPct ?? null,
      status: result.crashed ? 'CRASH' : (result.verdict?.status ?? 'UNKNOWN'),
      summary: result.verdict?.summary ?? null,
      tokens: result.tokens,
      weekPct: usage?.weekPct ?? null,
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
