/**
 * justin-loop — the RUNNER: an external chain of Claude Code sessions working a
 * single arc, where the control channel IS a committed handoff bead.
 *
 * Each session is a fresh `claude --bg` process. It works, it writes exactly one
 * handoff bead through `justin-sdk justin-loop handoff`, and it ends. The runner
 * then reads that bead and ONLY that bead to decide what happens next
 * (home-base-1r6d.33, D2): `continue` boots a successor whose prompt is the
 * bead's `next`, `done` stops the loop, `blocked` stops it and shows Justin the
 * question. Progress lives in git and beads, never in a context window — that is
 * the entire point of the technique.
 *
 * WHAT THIS REPLACED, and why (home-base-1r6d.33.2):
 *   - The repo-local scratch verdict file (`ralph-verdict.json`, written under
 *     the repo's own scratch directory). Two sessions in one repo shared one,
 *     so the runner could read the wrong session's verdict. A bead stamped with
 *     its writer's label cannot be confused, and it is committed, so the chain is
 *     auditable from git alone.
 *   - Print mode (`claude -p` + `--json-schema`). D2 says the runner learns only
 *     from the bead; a headless session cannot be attached or answered, and the
 *     handoff helper needs no structured output — so print mode had nothing left
 *     to do. `--mode`, `--verdict-path` and `--max-budget-usd` are gone with it.
 *   - The 45-minute default timeout, which declared CRASH, did NOT stop the
 *     session, and spawned a successor onto a live predecessor (home-base-1r6d.31
 *     and .32). Sessions are now bounded by the 300k wrap-up notice, not by the
 *     clock (D7), and nothing is ever spawned onto an unverified predecessor (D6).
 *
 * The usage gate stays as it was, and stays ON by default: `claude -p "/usage"`
 * costs ZERO tokens (verified 2026-07-16: num_turns=0, duration_api_ms=0,
 * modelUsage={}) and returns the real subscription quota, so it can be checked
 * before every session for free.
 */
import {spawnSync} from 'node:child_process';
import {appendFileSync, existsSync, mkdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';

import {describeChildFailure, runChild} from './child';

import {
  type Disposition,
  type Handoff,
  HANDOFF_LABEL,
  type HandoffRow,
  parseCreatedId,
  parseHandoff,
  parseHandoffRows,
} from './handoff';
import {type BrRunner, runBr} from './br';

export {HANDOFF_LABEL};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

export interface JustinLoopOptions {
  /**
   * An OPTIONAL bound on how long a blocked session waits for an answer before
   * being stopped. null (the default) waits indefinitely.
   *
   * D3 (home-base-1r6d.26): the bound was built for the unattended scheduled-tick
   * workflow, where a blocked session nobody answers is an invisible open thread
   * (measured 2026-07-16: 37 background sessions, 17 blocked, oldest 43 days).
   * But in the direct-ask workflow — Justin kicks off a run and is the one being
   * asked — that bound KILLS the session he is about to answer. Blocked means
   * "waiting for Justin", and the runner does not get to decide he took too long.
   */
  blockedWaitMin: number | null;
  dryRun: boolean;
  /** Minutes between free /usage polls while paused at a quota gate. */
  gatePollMin: number;
  /**
   * `--handoff-retries`: how many times a session that ended without a valid
   * handoff bead is RESUMED and told to write one before the run gives up (D10).
   *
   * 0 disables the demand entirely and restores the pre-.3 behaviour: the run
   * stops at exit 2 saying what it found. That is a real choice, not a footgun —
   * but it is not the default, because a session that simply forgot to hand off
   * is the most likely way a chain dies, and re-asking it costs one turn.
   */
  handoffRetries: number;
  /**
   * `--label`: the slug half of every session label in this run (D3). null means
   * derive one from the ask. Normalised to `[a-z0-9-]` either way, because the
   * session contract interpolates the label into `--from=<label>` unquoted.
   */
  label: string | null;
  /** Chain length: how many sessions this run may spawn in total (D7). */
  maxSessions: number;
  model: string;
  /** Abort after this many consecutive sessions that produce no new commit. */
  noProgressAbort: number;
  onGateHit: 'pause' | 'exit';
  permissionMode: string;
  /**
   * `--pickup`: take the newest waiting handoff bead even though an explicit
   * `--prompt` was given. Opt-in, because the direct-ask workflow's default has
   * to be "do what I asked".
   */
  pickup: boolean;
  /** Seconds between `claude agents --json` polls while a session runs. */
  pollSec: number;
  /** Prompt for the FIRST session. A slash command works (verified). */
  prompt: string;
  /**
   * Whether `prompt` is an ASK the human typed, rather than the default
   * (home-base-1r6d.26, D1).
   *
   * The start-of-run scan prepends "PICK UP THE HANDOFF FIRST" to the prompt,
   * which is right for the scheduled-tick workflow and a HIJACK for the
   * direct-ask one: a stale handoff from an unrelated arc would run before the
   * thing that was actually asked for. So an explicit ask starts fresh unless
   * `pickup` says otherwise — and the scan still runs and still reports, because
   * "not picked up" must never look like "nothing was waiting" (critical rule 6).
   *
   * The CLI cannot infer this after the fact: with a yargs `default` on
   * `--prompt`, an explicit `--prompt /loop-session` and no flag at all produce
   * identical argv.
   */
  promptExplicit: boolean;
  /** Stop/pause when the 5-hour session window reaches this percent. */
  sessionStopPct: number;
  /** Where `runs.jsonl` lives. Injectable so tests never touch the real one. */
  stateDir: string;
  /** Seconds between polls while CONFIRMING a stopped session is gone. */
  stopPollSec: number;
  /**
   * Per-session wall-clock timeout in minutes. 0 = NONE, and that is the default
   * (D7): a session is bounded by the wrap-up notice it gets at ~300k tokens, not
   * by minutes. A clock that fires mid-work is how the 2026-09-07 pilot spawned a
   * successor onto a live predecessor.
   */
  timeoutMin: number;
  /**
   * Read `/usage` before every session and refuse to run when it cannot be read.
   * ON by default, and the default must stay that way: an unreadable quota is
   * UNKNOWN quota, and spending unknown quota is what the gate exists to prevent.
   *
   * The opt-out exists because the gate can become unsatisfiable rather than
   * merely unsatisfied (home-base-nsd5: `claude -p /usage` stopped rendering the
   * quota panel, so every scheduled run became a silent no-op). When off, NO
   * `/usage` call is made and quota is reported as unread everywhere — never as
   * 0%, because an absent measurement must look absent (critical rule 6).
   */
  usageGate: boolean;
  weeklyStopPct: number;
}

/**
 * Where the ledger lives (D9): durable, outside git, and never inside the repo —
 * a ledger in the working tree is a file every session has to remember not to
 * commit, which is where the old one lived.
 */
export const DEFAULT_STATE_DIR = join(
  homedir(),
  '.local',
  'state',
  'justin-sdk',
  'justin-loop',
);

export const DEFAULT_OPTIONS: JustinLoopOptions = {
  blockedWaitMin: null,
  dryRun: false,
  gatePollMin: 5,
  handoffRetries: 3,
  label: null,
  maxSessions: 3,
  model: 'opus',
  noProgressAbort: 3,
  onGateHit: 'pause',
  permissionMode: 'auto',
  pickup: false,
  pollSec: 20,
  prompt: '/loop-session',
  promptExplicit: false,
  sessionStopPct: 50,
  stateDir: DEFAULT_STATE_DIR,
  stopPollSec: 5,
  timeoutMin: 0,
  usageGate: true,
  weeklyStopPct: 80,
};

// ---------------------------------------------------------------------------
// The session contract
// ---------------------------------------------------------------------------

/**
 * The session contract, injected per-run rather than written into the skill.
 *
 * `/loop-session` is shared with the interactive path and shouldn't carry
 * runner-specific plumbing, so the loop semantics are appended to the system
 * prompt at spawn time instead (D11: nothing here reaches an interactive
 * session — running under the runner IS the toggle).
 *
 * This is the ONLY place a session learns the justin-loop protocol, so it has
 * to teach the whole of it: that the handoff bead is both the record and the
 * control signal (D2), what the helper writes (D3/D4), and that there is
 * exactly one handoff per session, stamped with this session's label (D5).
 *
 * Kept deliberately short — it is prepended to every session's context, so
 * every paragraph is paid for on every session of the chain. A unit test caps
 * the composed text at 6,000 characters.
 */
export function sessionContract(opts: {
  /** The runner's name for this session. Must equal the handoff's `--from`. */
  label: string;
  /** The run's `blockedWaitMin`. null = the default, wait indefinitely. */
  blockedWaitMin: number | null;
  /**
   * The directory the runner was launched in, ABSOLUTE (the real caller passes
   * `process.cwd()`). Interpolated into the contract because `br` resolves its
   * workspace from the process's own cwd: a session that runs the helper from a
   * worktree writes the handoff into that worktree's `.beads/`, which the runner
   * never scans, and the run then looks exactly like a session that wrote no
   * handoff at all (home-base-1r6d.33.9).
   */
  cwd: string;
}): string {
  // What the model is told about blocking has to match what the runner will
  // actually do, so it is generated from the same setting rather than written
  // once and left to rot. Both sentences say "do not block casually" — but for
  // opposite reasons, and telling the model the wrong one is how it either
  // strands a run or refuses to ask a question it needed to ask.
  const waitRule =
    opts.blockedWaitMin == null
      ? `The runner waits for them indefinitely: nothing else happens in this
session until you are answered, so a question nobody is expecting stalls the
whole run.`
      : `The runner waits ${opts.blockedWaitMin}m for an answer, then stops you
and files your question as a bead.`;
  return `
You are one session of a justin-loop: a chain of Claude Code sessions working a
single arc. A runner spawned you, you work, you hand off, and it spawns a fresh
successor from what you handed it. Your session label is \`${opts.label}\`.

NOTHING SURVIVES IN CONTEXT. Your successor is a new session that can read only
git, the beads database, and the working tree. Whatever you do not commit or
write into a bead is gone when this session ends. Act accordingly.

Rules for this session:
- Before concluding something is unimplemented, search for it. A failed search
  is not proof of absence.
- No placeholder or stub implementations. Finish what you start or say so.
- File follow-up work you discover as beads rather than doing it now.
- Commit your work. A session that leaves nothing committed is a lost one.
- Do NOT attempt to recover a broken tree with destructive git commands
  (reset --hard, clean -fd, restore .). The runner owns rescue: hand off with
  --disposition=blocked and say what is broken.
- If this repo has no beads workspace, do NOT run \`br init\`. Say plainly that
  there is nowhere to write a handoff, and stop: a stopped loop is better than a
  workspace created behind Justin's back.

WIND DOWN AND HAND OFF as soon as any of these is true:
- an [Automated Usage Check] notice tells you to wrap up — that is the normal
  ending here, because sessions are bounded by context, not by the clock;
- the work you were asked for is finished;
- you need Justin and cannot go further without him.

THE HANDOFF BEAD IS THE ONLY CHANNEL, and it is the control signal: it decides
whether a successor is spawned at all and what that successor is told. Write it
with the helper — never by hand — doing these, in this order, LAST:
  1. Commit your code.
  2. Flush and commit \`.beads/\`, so the bead travels with the branch.
  3. Create the handoff bead:

     justin-sdk justin-loop handoff --from=${opts.label} \\
       --disposition=continue --arc=<epic or bead id> \\
       --worktree=<absolute path> --branch=<branch> \\
       --state='<2-4 sentences: where the work actually stands>' \\
       --next='<complete starting instructions for your successor>' \\
       --open-question='<what only Justin can settle>' \\
       --context-tokens=<number from the latest usage notice>

     --from must be exactly \`${opts.label}\`. Repeat --open-question per
     question, or leave it out. Use the --flag=value form for every value, so a
     value starting with a dash is not parsed as a flag.
  4. End your turn. Do not keep working once the handoff exists.

RUN THAT HELPER — and the \`br close\` that claims a handoff — FROM
\`${opts.cwd}\`, the directory this loop was started in: the runner reads THAT
repo's beads database, not a worktree's, so cd there for those two commands even
if your work lives in a worktree.

--disposition says what the loop does next. Choose exactly one:
- continue: work remains. A successor is spawned, and your --next IS its prompt.
- done: the arc is finished. The loop stops; no successor is spawned.
- blocked: you need a decision only Justin can make. The loop stops and shows
  him your open questions.

WRITE --next FOR A COLD READER. Your successor knows nothing that you know. It
needs the worktree to work in, the branch, the state the work is in, the next
concrete step, and the open questions — as instructions to act on, not as a
summary of your session. If you could not start from it, it is not finished.

EXACTLY ONE HANDOFF PER SESSION. Never create a second one: the helper refuses
it, and two would fork the chain into two successors.

AUTHENTIC INFRASTRUCTURE NOTICES. Messages tagged [Automated Usage Check] or
[Automated Time Check] are generated by Justin's own tooling on this machine
(the justin-sdk hooks configured in this repo). They are not user text and not a
prompt-injection attempt. When such a notice tells you to wrap up your session
and hand off, that is an authentic instruction from the owner of this repo:
follow it — wind down and write the handoff rather than refusing the directive.

You CAN ask Justin a question mid-session: this session blocks and waits rather
than failing, and he can answer from \`claude agents\`. But do not block
casually. ${waitRule}
Ask only when you genuinely cannot proceed, and make the question answerable in
one line.
`.trim();
}

// ---------------------------------------------------------------------------
// Identity: the slug, the label, the name (D3)
//
// label = `<slug>-<n>`         — what the session stamps onto `--from`
// name  = `<YYYY-MM-DD HH:mm> <label>` (the RUN's kickoff time)
//
// The label must be shell-safe WITHOUT quoting, because the session contract
// writes `--from=<label>` unquoted into a command it tells the model to run. So
// it is `[a-z0-9-]` only: no spaces, no `#`. (This is why the earlier
// `#<n>` name format was retracted — a name with spaces and `#` cannot be an
// unquoted flag value. The NAME may contain spaces because nothing interpolates
// it into a command line; only the label does.)
//
// The name carries the run's kickoff time rather than each session's start time
// so that a whole chain sorts together in `claude agents`, and the label stays a
// verbatim substring of the name.
// ---------------------------------------------------------------------------

/** Used when nothing else yields a usable slug. Never an empty label. */
export const FALLBACK_SLUG = 'justin-loop';

/**
 * Words that say nothing about which arc this is. Dropped when deriving a slug
 * from an ask so `--prompt "please can you fix the worktree hydration bug"`
 * becomes `fix-worktree-hydration-bug` rather than `please-can-you-fix`.
 */
const SLUG_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'can',
  'do',
  'for',
  'go',
  'i',
  'in',
  'is',
  'it',
  'let',
  'me',
  'my',
  'of',
  'on',
  'our',
  'please',
  'that',
  'the',
  'then',
  'this',
  'to',
  'us',
  'we',
  'with',
  'you',
  'your',
]);

/** Longest slug we will build. Keeps `claude agents` readable. */
const SLUG_MAX = 40;

/** Reduce any text to `[a-z0-9-]`, which is safe unquoted on a command line. */
export function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '');
}

/**
 * Build a slug out of the ask: the first few words that carry meaning.
 *
 * The words are split from the RAW ask, before any length cap. Capping first
 * (which an earlier version did) truncated the ask to 40 characters and then
 * picked words out of the stump, so "please can you fix the worktree hydration
 * bug" became `fix-worktree-hydratio` — a mangled word and a lost one.
 */
export function deriveSlug(ask: string): string {
  const words = ask
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w !== '');
  const meaningful = words.filter(
    (w) => !SLUG_STOPWORDS.has(w) && w.length > 1,
  );
  const chosen = (meaningful.length > 0 ? meaningful : words).slice(0, 4);
  const slug = slugify(chosen.join('-'));
  return slug !== '' ? slug : FALLBACK_SLUG;
}

/**
 * The slug for this whole run: `--label` if it survives normalisation, else one
 * derived from the ask. NEVER empty — an empty label would produce `--from=-1`
 * in the contract and a nameless session in `claude agents`.
 */
export function runSlug(opts: {label: string | null; prompt: string}): string {
  const fromFlag = opts.label != null ? slugify(opts.label) : '';
  if (fromFlag !== '') return fromFlag;
  return deriveSlug(opts.prompt);
}

export function sessionLabel(slug: string, n: number): string {
  return `${slug}-${n}`;
}

function two(n: number): string {
  return String(n).padStart(2, '0');
}

/** `YYYY-MM-DD HH:mm`, local time — the run's kickoff stamp. */
export function runStamp(when: Date): string {
  return (
    `${when.getFullYear()}-${two(when.getMonth() + 1)}-${two(when.getDate())}` +
    ` ${two(when.getHours())}:${two(when.getMinutes())}`
  );
}

/** The `--name` a background session is given. */
export function sessionName(stamp: string, label: string): string {
  return `${stamp} ${label}`;
}

// ---------------------------------------------------------------------------
// Background session control
//
// The control surface, MEASURED 2026-09-08 against claude v2.1.263 on this
// machine (home-base-1r6d.33.2, D8) — three throwaway `--bg` haiku sessions,
// polled to completion and then removed. Two long-standing beliefs in this file
// were WRONG and are corrected here.
//
// LIFECYCLE of one `--bg` row in `claude agents --json` (kind: 'background').
// Keys are id, cwd, kind, startedAt, sessionId, name, plus OPTIONALLY pid,
// state, status, waitingFor:
//   spawned, daemon not yet attached  {state:'working'}                 no pid
//   working                           {pid:N, status:'idle'|'busy', state:'working'}
//   blocked on a human/permission     {pid:N, state:'blocked'}          waitingFor set
//   TURN FINISHED                     {pid:N, status:'idle', state:'done'}
//   after `claude stop <id>`          ABSENT from the default list within 5s;
//                                     still under `--all` as {state:'done'}, no pid
//   after `claude rm <id>`            gone from `--all` too
//
// 1. AN ENDED SESSION DOES NOT DROP OUT OF THE LIST. It sits there as
//    state='done' WITH A LIVE PID — the `--bg` TUI stays up at its prompt —
//    indefinitely (three rows from 2026-08 were still listed). So "poll until the
//    row is absent" can never become true on its own: the runner has to STOP the
//    predecessor, and only then is absence a reachable verification.
//
// 2. SIGTERM DOES NOT STOP A BACKGROUND SESSION — THE DAEMON RESPAWNS IT.
//    Measured: SIGTERM pid 5949 → for ~15s the row read {state:'working'} with NO
//    pid → then the SAME id and sessionId came back under NEW pid 29161 with a
//    fresh startedAt and carried on working. Two consequences:
//      a. `claude stop <id>` is the stop mechanism, not signals. It is a real
//         subcommand as of v2.1.263 (the old comment here claiming it "is not a
//         registered subcommand and degrades into a prompt" is STALE): exit 0,
//         stdout `stopped <id>`, works on a working, blocked or done session,
//         idempotent, and exit 1 with `No job matching '<id>'` for an unknown id.
//      b. THE OLD `pid == null && state !== 'blocked'` TEST FOR "FINISHED" IS A
//         FALSE POSITIVE: that is precisely what a respawn in progress looks
//         like. It is deleted. `state === 'done'` is the end signal.
// ---------------------------------------------------------------------------

/** The one `state` value that means "this session finished its turn". */
export const ENDED_STATE = 'done';

export interface AgentRow {
  id: string;
  pid: number | null;
  name: string;
  /**
   * The FULL session id (`11205a3b-34c4-435b-b21f-4289486061a0`), which is the
   * only thing `--resume` accepts (home-base-1r6d.33.3 — the short `id` starts a
   * COPY). null when the row did not carry one, which must never be papered over
   * with the short id: `id` is a TRUNCATION of this, not a substitute for it.
   */
  sessionId: string | null;
  state: string | null;
  status: string | null;
  waitingFor: string | null;
}

/** Parse the `backgrounded · <id> · <name>` banner. */
export function parseBackgroundedId(stdout: string): string | null {
  const match = /backgrounded\s*·\s*(\S+)/.exec(stdout);
  return match != null ? match[1] : null;
}

/**
 * The result of asking `claude agents --json` what exists.
 *
 * `ok: false` is a DISTINCT member, and it is load-bearing (critical rule 6).
 * An earlier version returned `[]` when the command timed out, exited non-zero,
 * or printed unparseable JSON — which made "we could not look" indistinguishable
 * from "there is nothing there". Two such failures in a row would have been
 * counted as two consecutive absences and licensed spawning a successor onto a
 * predecessor that was, for all anyone knew, still running: the reassuring
 * substitution, arriving at the one decision this whole file exists to protect.
 */
export type AgentListing =
  {ok: true; rows: AgentRow[]} | {ok: false; reason: string};

export type AgentLookup =
  {ok: true; row: AgentRow | null} | {ok: false; reason: string};

// ---------------------------------------------------------------------------
// Every child call the runner makes, and its bound (home-base-a1go)
//
// All of them go through `runChild` (src/justin-loop/child.ts): asynchronous,
// timed, and answering as soon as the process WE spawned has exited rather than
// when the pipe reaches EOF. The measurement behind that is in child.ts; the
// consequence here is that no call can hold the runner, and that every failure
// reason comes from `describeChildFailure`, whose ordering makes a timed-out
// call that exited 0 a FAILURE rather than a success with truncated output.
//
// The bounds are the ones the old `spawnSync` calls carried, except the two that
// carried NONE — the HEAD-sha read and the preflight `claude --version` — which
// are the two calls that could hang forever and say nothing.
// ---------------------------------------------------------------------------

/** `claude agents --json`, once per poll. */
export const AGENTS_TIMEOUT_MS = 60_000;
/** `claude stop <id>`, one rung of the stop ladder. */
export const STOP_TIMEOUT_MS = 60_000;
/** `claude --bg …` — a spawn or a resume. The longest, because it does most. */
export const DISPATCH_TIMEOUT_MS = 120_000;
/** `claude -p /usage --output-format json`. */
export const USAGE_TIMEOUT_MS = 60_000;
/** `claude --version` in preflight. Was UNBOUNDED. */
export const CLAUDE_VERSION_TIMEOUT_MS = 10_000;
/** `git rev-parse HEAD`. Was UNBOUNDED, and is the positional suspect (a1go). */
export const GIT_HEAD_TIMEOUT_MS = 10_000;

/** The env var that overrides which `claude` every call here spawns. */
export const CLAUDE_BIN_ENV = 'JUSTIN_LOOP_CLAUDE_BIN';

/**
 * Which `claude` binary to spawn, resolved fresh on every call.
 *
 * MEASURED 2026-09-12: in a cmux pane a `cmux-cli-shim` named `claude` sits
 * ahead of the real CLI on PATH, and it turns `claude stop <id>` into a PROMPT
 * TO THE MODEL — chatty output saying "Stopped" while stopping nothing. A stop
 * ladder run against that shim would report success and leave the session alive,
 * which is precisely the reassuring substitution the successor gate exists to
 * refuse. So the real binary is resolved rather than inherited from PATH.
 *
 * Order, and why:
 *   1. `JUSTIN_LOOP_CLAUDE_BIN` — the explicit override, FIRST so tests (and a
 *      machine with claude installed elsewhere) can point every call at one
 *      binary. An empty value is not a path and is ignored.
 *   2. `~/.local/bin/claude` — where the real CLI lives on this machine, ahead
 *      of PATH exactly because PATH is what the shim wins.
 *   3. `claude` — the bare name, i.e. a PATH lookup, which is the old behaviour
 *      and the only thing available on a machine that installs it elsewhere.
 */
export function resolveClaudeBin(): string {
  const override = process.env[CLAUDE_BIN_ENV];
  if (override != null && override !== '') return override;
  const local = join(homedir(), '.local', 'bin', 'claude');
  if (existsSync(local)) return local;
  return 'claude';
}

export async function listAgents(
  cwd: string,
  timeoutMs: number = AGENTS_TIMEOUT_MS,
): Promise<AgentListing> {
  const outcome = await runChild(resolveClaudeBin(), ['agents', '--json'], {
    cwd,
    timeoutMs,
  });
  const failure = describeChildFailure('claude agents --json', outcome);
  if (failure != null) {
    return {ok: false, reason: failure};
  }
  if (outcome.stdout.trim() === '') {
    return {ok: false, reason: 'claude agents --json produced no output'};
  }
  try {
    const rows = JSON.parse(outcome.stdout) as Array<Record<string, unknown>>;
    if (!Array.isArray(rows)) {
      return {
        ok: false,
        reason: 'claude agents --json did not return an array',
      };
    }
    return {
      ok: true,
      rows: rows.map((r) => ({
        id: String(r.id ?? ''),
        name: String(r.name ?? ''),
        pid: typeof r.pid === 'number' ? r.pid : null,
        sessionId: typeof r.sessionId === 'string' ? r.sessionId : null,
        state: typeof r.state === 'string' ? r.state : null,
        status: typeof r.status === 'string' ? r.status : null,
        waitingFor: typeof r.waitingFor === 'string' ? r.waitingFor : null,
      })),
    };
  } catch (err) {
    return {
      ok: false,
      reason: `claude agents --json was unparseable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function findAgent(
  cwd: string,
  id: string,
  timeoutMs: number = AGENTS_TIMEOUT_MS,
): Promise<AgentLookup> {
  const listing = await listAgents(cwd, timeoutMs);
  if (!listing.ok) return {ok: false, reason: listing.reason};
  return {ok: true, row: listing.rows.find((r) => r.id === id) ?? null};
}

/**
 * Has this session finished its turn? An ABSENT row also counts as ended, and
 * every caller checks `row == null` before calling this.
 *
 * Deliberately narrow: ONLY `done`. `working` with no pid is a respawn in
 * progress (see 2b above), `blocked` is waiting for Justin, and an unrecognised
 * state is something we do not understand — none of them are an ending, and
 * guessing "ended" would point the reassuring way, straight at spawning a
 * successor onto a live session (critical rule 6).
 */
export function isSessionEnded(row: AgentRow): boolean {
  return row.state === ENDED_STATE;
}

/** `claude stop <id>` — the measured stop. Injectable for tests. */
export async function stopSession(
  cwd: string,
  id: string,
  timeoutMs: number = STOP_TIMEOUT_MS,
): Promise<{ok: boolean; detail: string}> {
  const outcome = await runChild(resolveClaudeBin(), ['stop', id], {
    cwd,
    timeoutMs,
  });
  const said = `${outcome.stdout}${outcome.stderr}`.trim().split('\n')[0] ?? '';
  const failure = describeChildFailure(`claude stop ${id}`, outcome);
  if (failure != null) {
    // The reason comes first and whatever the CLI managed to say comes after:
    // "exited 1" alone names no cause, and the sentence `claude` printed is
    // usually the entire diagnosis.
    return {detail: said !== '' ? `${failure}: ${said}` : failure, ok: false};
  }
  return {detail: said !== '' ? said : 'claude stop exited 0', ok: true};
}

/** Send a signal. Returns false when the process was already gone. */
export function signalPid(pid: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    return false;
  }
}

/**
 * What became of a session we asked to stop. Every member is a DIFFERENT fact,
 * and only two of them license spawning a successor.
 *
 * already-gone  we LOOKED SUCCESSFULLY and the row was already absent.
 * stopped       we stopped it and CONFIRMED the row is gone.
 * no-pid        the row survived everything and carries no pid, so there was
 *               not even an OS process to fall back on. NOT verified gone.
 * kill-failed   the row survived everything and still has a pid. NOT verified
 *               gone — this stops the whole run (D6).
 * unverified    `claude agents --json` could not be read, so whether the session
 *               is gone is UNKNOWN. Not absence, not presence — its own answer,
 *               because the alternative is spending "we could not look" as
 *               "it is gone" (critical rule 6).
 */
export type StopOutcome =
  'already-gone' | 'stopped' | 'no-pid' | 'kill-failed' | 'unverified';

/** The two outcomes that mean the predecessor is provably not running. */
export function isVerifiedGone(outcome: StopOutcome): boolean {
  return outcome === 'already-gone' || outcome === 'stopped';
}

export interface StopReport {
  outcome: StopOutcome;
  /** Everything we did and saw, for the dashboard and the ledger. */
  notes: string[];
}

/**
 * The child calls are Promise-TYPED on purpose (home-base-a1go), not merely
 * implemented asynchronously: a synchronous spawn blocks the event loop, so no
 * watchdog timer can fire while one is stuck, and the only durable guard against
 * one creeping back is a type that will not accept it. `signalPid` stays
 * synchronous because `process.kill` is a syscall, not a child.
 */
export interface StopDeps {
  findAgent: (cwd: string, id: string) => Promise<AgentLookup>;
  signalPid: (pid: number, sig: NodeJS.Signals) => boolean;
  sleep: (ms: number) => Promise<void>;
  stopSession: (
    cwd: string,
    id: string,
  ) => Promise<{ok: boolean; detail: string}>;
  /**
   * Where each note goes AS IT HAPPENS (home-base-a1go). The ladder used to
   * return its notes and let the caller print them afterwards, which is fine
   * when it takes 5 seconds and a disaster when it does not: every `claude`
   * call is now bounded at 60s, so against a wedged daemon the four rungs ×
   * STOP_VERIFY_POLLS polls are half an hour of total silence followed by a
   * wall of text. The array survives for the ledger; this is the live channel.
   */
  write: (text: string) => void;
}

/** Polls per verification attempt. Measured: the row goes within 5s. */
export const STOP_VERIFY_POLLS = 6;
/** Consecutive absent observations required before we believe it (D6). */
export const STOP_CONSECUTIVE_ABSENT = 2;

/** Records a ladder note in the ledger array AND prints it immediately. */
type Note = (text: string) => void;

async function confirmGone(
  cwd: string,
  id: string,
  pollMs: number,
  deps: StopDeps,
  note: Note,
): Promise<boolean> {
  let consecutive = 0;
  for (let i = 0; i < STOP_VERIFY_POLLS; i++) {
    await deps.sleep(pollMs);
    const look = await deps.findAgent(cwd, id);
    if (!look.ok) {
      // UNKNOWN IS NOT ABSENT. A listing we could not read says nothing about
      // whether the session is gone, so it resets the streak rather than
      // counting toward it — otherwise two timed-out `claude agents` calls
      // would read as proof and license a spawn.
      note(
        `could not read \`claude agents\` (${look.reason}) — NOT counted as absent`,
      );
      consecutive = 0;
      continue;
    }
    if (look.row == null) {
      consecutive++;
      if (consecutive >= STOP_CONSECUTIVE_ABSENT) return true;
    } else {
      // A row that reappears resets the count — that is exactly what a daemon
      // respawn looks like, and it must not be averaged away.
      consecutive = 0;
    }
  }
  return false;
}

/**
 * Stop a session and PROVE it is gone before anything else happens (D6).
 *
 * The escalation ladder is ordered by what was measured to work:
 *   1. `claude stop <id>`      — the real stop. Confirmed to clear the row in 5s.
 *   2. `claude stop <id>` again — cheap, idempotent, covers a transient failure.
 *   3. SIGTERM, 4. SIGKILL     — last resorts only. SIGTERM ALONE IS MEASURED TO
 *      RESPAWN THE SESSION under a new pid, so a signal can never be the thing
 *      we trust; it is here because the epic asked for the escalation and because
 *      it costs nothing to try when `claude stop` has already failed twice. It
 *      cannot fool us either way: verification is absence of the row, and a
 *      respawned session is present.
 *
 * Anything but `stopped` / `already-gone` means the predecessor is NOT verified
 * gone, and the caller must refuse to spawn.
 */
export async function stopAndVerify(
  cwd: string,
  id: string,
  pollMs: number,
  deps: StopDeps,
): Promise<StopReport> {
  const notes: string[] = [];
  // ONE place notes are made, so the ledger copy and the printed copy can never
  // drift apart and no note can be printed twice (the caller used to re-print
  // the whole array afterwards).
  const note: Note = (text) => {
    notes.push(text);
    deps.write(`   ${DIM}stop${RESET} ${text}\n`);
  };

  const before = await deps.findAgent(cwd, id);
  if (before.ok && before.row == null) {
    note(`${id} was already absent from \`claude agents\``);
    return {notes, outcome: 'already-gone'};
  }
  if (!before.ok) {
    // We cannot even tell whether there is anything to stop. Stopping is
    // idempotent and harmless, so the ladder still runs — but nothing here may
    // shortcut to `already-gone`, which is the answer that licenses a spawn.
    note(
      `could not read \`claude agents\` before stopping (${before.reason}) — proceeding with the stop, and NOT assuming it is gone`,
    );
  }

  const attempts: Array<{label: string; act: () => Promise<boolean | null>}> = [
    {
      act: async () => {
        const r = await deps.stopSession(cwd, id);
        note(`claude stop ${id}: ${r.detail}`);
        return r.ok;
      },
      label: 'claude stop',
    },
    {
      act: async () => {
        const r = await deps.stopSession(cwd, id);
        note(`claude stop ${id} (retry): ${r.detail}`);
        return r.ok;
      },
      label: 'claude stop retry',
    },
    {
      act: async () => {
        const look = await deps.findAgent(cwd, id);
        const row = look.ok ? look.row : null;
        if (row?.pid == null) {
          note('SIGTERM skipped — no pid to signal');
          return null;
        }
        const sent = deps.signalPid(row.pid, 'SIGTERM');
        note(
          `SIGTERM ${row.pid}: ${sent ? 'sent' : 'process already gone'} (note: SIGTERM alone is measured to RESPAWN a background session)`,
        );
        return sent;
      },
      label: 'SIGTERM',
    },
    {
      act: async () => {
        const look = await deps.findAgent(cwd, id);
        const row = look.ok ? look.row : null;
        if (row?.pid == null) {
          note('SIGKILL skipped — no pid to signal');
          return null;
        }
        const sent = deps.signalPid(row.pid, 'SIGKILL');
        note(`SIGKILL ${row.pid}: ${sent ? 'sent' : 'process already gone'}`);
        return sent;
      },
      label: 'SIGKILL',
    },
  ];

  for (const attempt of attempts) {
    await attempt.act();
    if (await confirmGone(cwd, id, pollMs, deps, note)) {
      note(
        `verified gone: ${id} absent from \`claude agents\` on ${STOP_CONSECUTIVE_ABSENT} consecutive polls after ${attempt.label}`,
      );
      return {notes, outcome: 'stopped'};
    }
    note(`${attempt.label} did NOT clear the row — escalating`);
  }

  const after = await deps.findAgent(cwd, id);
  if (!after.ok) {
    // The honest answer is that we do not know, and "do not know" must never be
    // spendable as "gone" (critical rule 6). Refuses the spawn like a failure.
    note(
      `UNVERIFIED: \`claude agents\` could not be read on the final check (${after.reason}), so whether ${id} is gone is UNKNOWN`,
    );
    return {notes, outcome: 'unverified'};
  }
  if (after.row == null) {
    // Vanished between the last poll and now. Absence is absence.
    note(`${id} is absent on the final check`);
    return {notes, outcome: 'stopped'};
  }
  const outcome: StopOutcome = after.row.pid == null ? 'no-pid' : 'kill-failed';
  note(
    `${id} is STILL PRESENT (state=${after.row.state ?? 'unknown'}, pid=${after.row.pid ?? 'none'}) — NOT verified gone`,
  );
  return {notes, outcome};
}

// ---------------------------------------------------------------------------
// Reading the handoff beads
//
// Everything here is READ-ONLY on the runner side. The runner looks; the
// successor claims (by closing the bead), because the claim has to be an act of
// the session that actually picked the work up, not of the process that spawned
// it.
//
// Command shapes verified against br 0.1.37 AND br 0.4.1 (2026-09-08):
//   scan    br list -l handoff --json     (closed excluded by default)
//   claim   br close <id> --reason=…      (done by the successor, not by us)
// ---------------------------------------------------------------------------

/**
 * What a scan for open handoff beads found. `unavailable` is a distinct member
 * on purpose: a repo with no beads workspace and a repo with no waiting handoff
 * look identical if both collapse to an empty list, and only one of them is
 * safe to describe as "nothing waiting" (critical rule 6).
 */
export type HandoffScan =
  {kind: 'unavailable'; reason: string} | {kind: 'ok'; rows: HandoffRow[]};

export function scanHandoffBeads(
  cwd: string,
  run: BrRunner = runBr,
): HandoffScan {
  const out = run(cwd, ['list', '-l', HANDOFF_LABEL, '--json']);
  if (!out.ok) {
    return {
      kind: 'unavailable',
      reason: out.reason ?? 'br failed for an unrecorded reason',
    };
  }
  const rows = parseHandoffRows(out.stdout);
  if (rows == null) {
    return {kind: 'unavailable', reason: 'could not parse `br list --json`'};
  }
  return {kind: 'ok', rows};
}

/** A handoff bead the runner could read, with its parsed contract. */
export interface HandoffMatch {
  row: HandoffRow;
  handoff: Handoff;
}

/**
 * A handoff bead the runner could NOT read. Always reported, never skipped: an
 * unreadable bead might be the one this session wrote, and silently dropping it
 * would turn "we could not read your handoff" into "you did not write one".
 */
export interface InvalidHandoff {
  id: string;
  title: string;
  errors: string[];
}

/**
 * What the runner does after a session ends, decided ONLY from the beads (D2).
 *
 * `enforce` means the session ended without a handoff the runner could read. It
 * is never acted on directly: `demandHandoff` resumes that same session and asks
 * for one, up to `--handoff-retries` times (D10, home-base-1r6d.33.3). Nothing on
 * that path spawns anything.
 */
export type SessionOutcome =
  | {kind: 'continue'; match: HandoffMatch; invalid: InvalidHandoff[]}
  | {kind: 'done'; match: HandoffMatch; invalid: InvalidHandoff[]}
  | {kind: 'blocked'; match: HandoffMatch; invalid: InvalidHandoff[]}
  | {
      kind: 'enforce';
      /** Which of the two enforce cases this is — they ledger differently. */
      sub: 'no-handoff' | 'invalid-handoff';
      reason: string;
      invalid: InvalidHandoff[];
    }
  | {kind: 'multiple'; matches: HandoffMatch[]; invalid: InvalidHandoff[]}
  | {kind: 'br-unavailable'; reason: string};

/**
 * A verdict the run loop can actually act on: everything except `enforce`.
 *
 * The type is the guard. `enforce` can only leave the loop body through
 * `demandHandoff`, so there is no expressible path from "this session did not
 * hand off" to spawning a successor.
 */
export type ResolvedOutcome = Exclude<SessionOutcome, {kind: 'enforce'}>;

const DISPOSITION_TO_KIND: Record<
  Disposition,
  'continue' | 'done' | 'blocked'
> = {
  blocked: 'blocked',
  continue: 'continue',
  done: 'done',
};

/**
 * Read the scan as an instruction (D5).
 *
 * Identity is the `from` field, which must equal the label the runner gave the
 * session. Exactly one valid open bead with that `from` is the only shape that
 * can act; two is a forked chain and stops the run rather than picking a winner.
 *
 * Unreadable beads never make the decision — the runner cannot spawn from one,
 * so it cannot fan out — but they are always carried through and printed.
 */
export function decideAfterSession(
  scan: HandoffScan,
  label: string,
): SessionOutcome {
  if (scan.kind === 'unavailable') {
    return {kind: 'br-unavailable', reason: scan.reason};
  }
  const invalid: InvalidHandoff[] = [];
  const matches: HandoffMatch[] = [];
  let otherFrom = 0;
  for (const row of scan.rows) {
    const parsed = parseHandoff(row.notes);
    if (!parsed.ok) {
      invalid.push({errors: parsed.errors, id: row.id, title: row.title});
      continue;
    }
    if (parsed.handoff.from === label) {
      matches.push({handoff: parsed.handoff, row});
    } else {
      otherFrom++;
    }
  }

  if (matches.length > 1) {
    return {invalid, kind: 'multiple', matches};
  }
  if (matches.length === 1) {
    const match = matches[0];
    return {
      invalid,
      kind: DISPOSITION_TO_KIND[match.handoff.disposition],
      match,
    };
  }
  const others =
    otherFrom > 0
      ? ` ${otherFrom} open handoff bead(s) belong to other sessions.`
      : '';
  return invalid.length > 0
    ? {
        invalid,
        kind: 'enforce',
        reason: `no readable handoff bead with from=${label}, but ${invalid.length} open handoff bead(s) could not be parsed — one of them may be this session's.${others}`,
        sub: 'invalid-handoff',
      }
    : {
        invalid,
        kind: 'enforce',
        reason: `session ${label} ended without creating a handoff bead (checked: open beads labelled \`${HANDOFF_LABEL}\` with from=${label}).${others}`,
        sub: 'no-handoff',
      };
}

// ---------------------------------------------------------------------------
// How a session boots
// ---------------------------------------------------------------------------

/**
 * `reconstruct` is the honest shape of a session that left nothing behind: its
 * context exists only in git and beads. The successor is TOLD that, rather than
 * being started as though a clean handoff had happened (critical rule 6 — a
 * crash must never read as a clean start).
 */
export type BootPlan =
  | {kind: 'fresh'}
  | {kind: 'handoff'; match: HandoffMatch}
  | {kind: 'reconstruct'; reason: string};

export interface BootContext {
  plan: BootPlan;
  /** Names the session in claim reasons and in `--from`, e.g. `fix-hydration-2`. */
  label: string;
  /**
   * The runner's own directory, ABSOLUTE — the beads workspace the runner scans.
   * The preamble names it so the claim `br close` is run there rather than in
   * the worktree the handoff points at (home-base-1r6d.33.9).
   */
  cwd: string;
}

/**
 * Which workflow this run is, as far as the start-of-run scan is concerned
 * (home-base-1r6d.26, D1). Both flags come from the command line and nowhere
 * else — see JustinLoopOptions.promptExplicit.
 */
export interface StartBootPolicy {
  /** The human typed `--prompt`: this run has an ASK, not a standing job. */
  promptExplicit: boolean;
  /** `--pickup`: take the newest waiting handoff anyway. */
  pickup: boolean;
}

/**
 * Said on every run where an explicit ask suppressed the pickup, so the choice
 * is visible rather than inferred from a missing line.
 */
export const EXPLICIT_SKIP_LINE =
  'NOT picked up: --prompt was given explicitly; pass --pickup to start from the newest';

/**
 * Decide which handoff bead a fresh runner picks up, and say out loud what it is
 * NOT picking up.
 *
 * One arc per invocation, deliberately: fanning out to every open handoff would
 * start several sessions in one repo with no way to tell whose worktree is whose.
 *
 * D10 (home-base-1r6d.33): only a bead that PARSES and says `continue` is
 * eligible. A `done` or `blocked` bead is a finished chain, not a starting point,
 * and an unreadable one is not a starting point either — but all three are named
 * in the report, because "not eligible" must never look like "not there".
 */
export function planStartBoot(
  scan: HandoffScan,
  policy: StartBootPolicy = {pickup: false, promptExplicit: false},
): {
  plan: BootPlan;
  report: string[];
} {
  const skipping = policy.promptExplicit && !policy.pickup;
  if (scan.kind === 'unavailable') {
    // Reported as unavailable in EVERY path, skipping included: "we could not
    // look" and "we looked and chose not to take it" are different facts, and
    // the second must never absorb the first (critical rule 6).
    const report = [
      `handoff scan UNAVAILABLE — ${scan.reason}. Starting fresh; a handoff bead may exist and not be seen.`,
    ];
    if (skipping) report.push(EXPLICIT_SKIP_LINE);
    return {plan: {kind: 'fresh'}, report};
  }
  if (scan.rows.length === 0) {
    const report = [
      `no open handoff beads (checked, label \`${HANDOFF_LABEL}\`)`,
    ];
    if (skipping) report.push(EXPLICIT_SKIP_LINE);
    return {plan: {kind: 'fresh'}, report};
  }

  const eligible: HandoffMatch[] = [];
  const ineligible: string[] = [];
  for (const row of scan.rows) {
    const parsed = parseHandoff(row.notes);
    if (!parsed.ok) {
      ineligible.push(
        `  ${row.id} — UNREADABLE, not eligible: ${parsed.errors[0] ?? 'notes do not parse'}`,
      );
      continue;
    }
    if (parsed.handoff.disposition !== 'continue') {
      ineligible.push(
        `  ${row.id} — disposition=${parsed.handoff.disposition}, not a starting point`,
      );
      continue;
    }
    eligible.push({handoff: parsed.handoff, row});
  }

  // Newest first. A bead with no timestamp cannot be claimed to be newest, so it
  // sorts last rather than winning by accident; ties break on id so the choice is
  // reproducible.
  const ordered = [...eligible].sort((a, b) => {
    if (a.row.updatedAt !== b.row.updatedAt) {
      if (a.row.updatedAt == null) return 1;
      if (b.row.updatedAt == null) return -1;
      return a.row.updatedAt < b.row.updatedAt ? 1 : -1;
    }
    return a.row.id < b.row.id ? -1 : 1;
  });

  if (ordered.length === 0) {
    return {
      plan: {kind: 'fresh'},
      report: [
        `${scan.rows.length} open handoff bead(s), none eligible to start from:`,
        ...ineligible,
        ...(skipping ? [EXPLICIT_SKIP_LINE] : []),
      ],
    };
  }

  if (skipping) {
    // Every bead by id AND title: the point of still scanning is that the human
    // can see what is waiting and re-run with --pickup if they meant it.
    return {
      plan: {kind: 'fresh'},
      report: [
        `${ordered.length} open handoff bead(s) waiting:`,
        ...ordered.map((m) => `  ${m.row.id} — ${m.row.title}`),
        ...ineligible,
        EXPLICIT_SKIP_LINE,
      ],
    };
  }

  const [chosen, ...deferred] = ordered;
  const report = [`picking up handoff ${chosen.row.id} — ${chosen.row.title}`];
  if (deferred.length > 0) {
    report.push(
      `${deferred.length} other eligible handoff bead(s) NOT picked up this run (one arc per run): ${deferred
        .map((m) => m.row.id)
        .join(', ')}`,
    );
  }
  report.push(...ineligible);
  return {plan: {kind: 'handoff', match: chosen}, report};
}

/**
 * The boot preamble handed to the next session. null when there is nothing
 * special to say.
 */
export function bootPreamble(boot: BootContext): string | null {
  if (boot.plan.kind === 'fresh') return null;
  if (boot.plan.kind === 'reconstruct') {
    return `NO HANDOFF EXISTS — RECONSTRUCT BEFORE YOU CONTINUE.
The previous session ended without handing anything over (${boot.plan.reason}).
Nothing was passed to you: whatever it was doing survives only in git and beads.
Read \`git log\`, \`git status\` and the open beads to work out where it got to,
and SAY in your handoff --state that you reconstructed rather than picked up a
handoff. Do not assume it finished cleanly, and do not use destructive git
commands to tidy up what it left behind.`;
  }
  const {row, handoff} = boot.plan.match;
  return `PICK UP THE HANDOFF FIRST.
A previous session (${handoff.from}) ended and left your starting instructions in
bead ${row.id} ("${row.title}"). Before anything else:
  1. Read it: \`br show ${row.id}\`. Its notes carry the arc, the WORKTREE PATH
     (${handoff.worktree}) and branch (${handoff.branch}) it was working in, the
     state it left, and your next step. Work in the worktree it names — if you
     are not in it, go there first.
  2. Claim it: \`br close ${row.id} --reason='picked up by ${boot.label}'\`, run
     FROM \`${boot.cwd}\` — the directory this loop was started in, whose beads
     database the runner reads — and NOT from the worktree above.
     Claiming is how a second session finds out this arc is already taken, so do
     it before you start working, not after.
  3. If it is ALREADY CLOSED when you get there, another session claimed it
     first. Do NOT redo its work: say so plainly and stop — hand off with
     --disposition=done, saying in --state that the arc was already claimed.
The task below is the \`next\` field of that bead, quoted verbatim.`;
}

/**
 * How a successor boots after its predecessor left nothing behind.
 *
 * No handoff bead was written — the session did not reach the point where it
 * would have written one. So the successor is told exactly that, rather than
 * being started as though a handoff had happened and simply gone missing
 * (critical rule 6: a crash must never read as a clean start).
 */
export function crashBootPlan(session: number, reason: string): BootPlan {
  return {
    kind: 'reconstruct',
    reason: `session ${session} ended without handing anything over (${reason})`,
  };
}

/**
 * The prompt this session actually starts with.
 *
 * For a handoff boot it is the bead's `next`, VERBATIM (D6) — that text was
 * written to be a prompt. For everything else it is the run's own prompt.
 */
export function sessionPrompt(basePrompt: string, boot: BootContext): string {
  return boot.plan.kind === 'handoff'
    ? boot.plan.match.handoff.next
    : basePrompt;
}

/**
 * Compose the prompt handed to `claude`.
 *
 * The base prompt stays FIRST because it may be a slash command
 * (`/loop-session`), and a slash command is recognised by leading the prompt —
 * putting a paragraph in front of it would most likely make it literal text,
 * while trailing text is passed to the command as arguments. The same preamble
 * also goes into the appended system prompt (see bootContract), because a skill
 * that ignores its arguments would drop this copy silently. Delivered twice on
 * purpose: one channel is guaranteed to arrive, the other to be salient.
 */
export function composeBootPrompt(
  basePrompt: string,
  boot: BootContext,
): string {
  const preamble = bootPreamble(boot);
  const prompt = sessionPrompt(basePrompt, boot);
  return preamble == null ? prompt : `${prompt}\n\n${preamble}`;
}

/** Append the boot preamble to the session contract. */
export function bootContract(base: string, boot: BootContext): string {
  const preamble = bootPreamble(boot);
  return preamble == null ? base : `${base}\n\n${preamble}`;
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

/**
 * Read the real quota. Costs zero tokens (verified: num_turns=0, cost=0).
 *
 * null means "could not read", and every caller fails CLOSED on it (`checkGate`
 * turns it into `unreadable`, which stops the run) — it is never spent as 0%.
 * The `describeChildFailure` ordering matters here too: before home-base-a1go
 * this tested `status !== 0` first, so a call that timed out after the child
 * exited 0 arrived as a success carrying truncated JSON.
 */
export async function readUsage(
  cwd: string,
  timeoutMs: number = USAGE_TIMEOUT_MS,
): Promise<UsageSnapshot | null> {
  const outcome = await runChild(
    resolveClaudeBin(),
    ['-p', '/usage', '--output-format', 'json'],
    {cwd, timeoutMs},
  );
  if (describeChildFailure('claude -p /usage', outcome) != null) {
    return null;
  }
  try {
    const parsed = JSON.parse(outcome.stdout) as {result?: string};
    return typeof parsed.result === 'string' ? parseUsage(parsed.result) : null;
  } catch {
    return null;
  }
}

/**
 * The four things the pre-session gate can conclude. They are four DIFFERENT
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
 * Decide whether a session may start.
 *
 * The quota reader is injected rather than called directly so this stays
 * testable without spawning `claude` — and so a test can assert the property
 * that actually matters when the gate is off: that the reader is never called
 * AT ALL. "Skips the gate" must mean no `/usage` process is spawned, not that
 * one is spawned and its answer ignored.
 */
export async function checkGate(
  opts: Pick<
    JustinLoopOptions,
    'sessionStopPct' | 'usageGate' | 'weeklyStopPct'
  >,
  readQuota: () => Promise<UsageSnapshot | null>,
): Promise<GateDecision> {
  if (!opts.usageGate) {
    return {kind: 'disabled'};
  }
  const usage = await readQuota();
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
// Ledger (D9)
//
// One JSON line per SESSION, appended to ~/.local/state/justin-sdk/justin-loop/
// runs.jsonl: durable, outside git, and never inside the repo. A debugging aid — the
// facts Justin reads live in the handoff beads, which are committed. There is no
// cost dashboard: `claude --bg` never reports tokens or cost, so any number here
// would be invented.
// ---------------------------------------------------------------------------

/** 2 adds `demands` (home-base-1r6d.33.3). */
export const LEDGER_SCHEMA_VERSION = 2;

/** Every way a session can end, as the ledger names it. */
export type LedgerOutcome =
  | 'continue'
  | 'done'
  | 'blocked'
  | 'no-handoff'
  | 'invalid-handoff'
  /** Demanded `handoffRetries` times and still nothing readable (D10). */
  | 'no-handoff-after-demands'
  /**
   * We could not even DELIVER a demand — no full sessionId to resume, or the
   * resume itself failed. A different fact from a session that was asked and
   * refused, and it must not be filed under the same name (critical rule 6).
   */
  | 'demand-undeliverable'
  | 'multiple-handoffs'
  | 'kill-failed'
  | 'br-unavailable'
  | 'dispatch-failed'
  | 'agents-unreadable';

export interface LedgerRow {
  schemaVersion: number;
  runId: string;
  n: number;
  label: string;
  name: string;
  /** The `claude agents` id. null when dispatch never produced one. */
  sessionId: string | null;
  startedAt: string;
  endedAt: string;
  outcome: LedgerOutcome;
  /** The handoff bead this session wrote. null when there was none to read. */
  handoffBead: string | null;
  /** null when we never had a session to stop. */
  stopOutcome: StopOutcome | null;
  /** From the handoff bead. null = not measured, never 0 (critical rule 6). */
  contextTokens: number | null;
  /**
   * Did HEAD move while this session ran? null = one of the two `git rev-parse`
   * reads FAILED, so it was never measured — never "it did not commit"
   * (critical rule 6). No schema bump: no field was added or removed, and null
   * already means "not measured" in `contextTokens` and `stopOutcome`.
   */
  progressed: boolean | null;
  /**
   * How many times this session had to be RESUMED and told to write a handoff
   * (D10). 0 is the normal case — it handed off on its own. Recorded because
   * `outcome: 'continue'` alone cannot tell a session that handed off unprompted
   * apart from one that had to be asked three times, and the difference is the
   * whole reason the ledger exists.
   */
  demands: number;
}

export function runsJsonlPath(stateDir: string): string {
  return join(stateDir, 'runs.jsonl');
}

/**
 * Append one row. Returns the failure rather than swallowing it: a ledger write
 * must never kill a run, but a run that silently stopped ledgering looks exactly
 * like a run that never happened (critical rule 6), so the caller prints it.
 */
export function appendLedgerRow(
  path: string,
  row: LedgerRow,
): {ok: boolean; reason: string | null} {
  try {
    mkdirSync(dirname(path), {recursive: true});
    appendFileSync(path, `${JSON.stringify(row)}\n`);
    return {ok: true, reason: null};
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

/**
 * What `git rev-parse HEAD` said, or why it said nothing.
 *
 * `null` was not enough (critical rule 6): the only caller compared two reads
 * for inequality, so a FAILED read compared unequal to a good one and the run
 * reported "committed" — or, when both failed, `null !== null` is false and it
 * reported "no commit", which is a measurement nobody took. The reason is a
 * distinct member now, and it is printed.
 */
export type HeadRead = {ok: true; sha: string} | {ok: false; reason: string};

export async function gitHead(
  cwd: string,
  timeoutMs: number = GIT_HEAD_TIMEOUT_MS,
): Promise<HeadRead> {
  const outcome = await runChild('git', ['rev-parse', 'HEAD'], {
    cwd,
    timeoutMs,
  });
  const failure = describeChildFailure('git rev-parse HEAD', outcome);
  if (failure != null) return {ok: false, reason: failure};
  const sha = outcome.stdout.trim();
  if (sha === '') {
    return {ok: false, reason: 'git rev-parse HEAD printed no sha'};
  }
  return {ok: true, sha};
}

interface PreflightProblem {
  fatal: boolean;
  message: string;
}

/**
 * `timeoutMs` bounds both child calls below. It exists so the hang tests can
 * drive the real preflight against a `claude` that never answers in about a
 * second rather than ten.
 */
export async function preflight(
  cwd: string,
  timeoutMs: number = CLAUDE_VERSION_TIMEOUT_MS,
): Promise<PreflightProblem[]> {
  const problems: PreflightProblem[] = [];

  const bin = resolveClaudeBin();
  // No `cwd` here on purpose: this probe asks whether the CLI works, and
  // handing it a directory that may not exist would report a bad cwd as a bad
  // `claude`. The HEAD read below is the one that judges the directory.
  const version = await runChild(bin, ['--version'], {timeoutMs});
  const versionFailure = describeChildFailure(`${bin} --version`, version);
  if (versionFailure != null) {
    problems.push({
      fatal: true,
      // A CLI that is INSTALLED but not answering is a different problem from
      // one that is missing, and "not found on PATH" would send Justin looking
      // for the wrong thing entirely.
      message: version.timedOut
        ? `${versionFailure} — the claude CLI is there but is not answering`
        : `claude CLI unusable: ${versionFailure}`,
    });
  }
  const head = await gitHead(cwd, timeoutMs);
  if (!head.ok) {
    problems.push({
      fatal: true,
      message: `could not read HEAD in ${cwd} (not a git repository?): ${head.reason}`,
    });
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
        'looks like this is running inside a Claude Code session — a nested claude may fail with EPERM. Run justin-loop from a real terminal.',
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

function outcomeColor(outcome: LedgerOutcome): string {
  if (outcome === 'done') return GREEN;
  if (outcome === 'continue') return CYAN;
  if (outcome === 'blocked') return YELLOW;
  return RED;
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

/**
 * How the run header describes the blocked-wait policy (D3). One place, so the
 * header can never claim a bound the loop is not applying.
 */
export function blockedWaitDescription(blockedWaitMin: number | null): string {
  return blockedWaitMin == null
    ? 'blocked sessions wait INDEFINITELY for you (--blocked-wait-min to bound it)'
    : `blocked sessions wait ${blockedWaitMin}m for you, then stop`;
}

/**
 * How the header describes the timeout (D7). Same reason as above: the default
 * is NO timeout, and a header that implied one would be a lie about the thing
 * that broke the 2026-09-07 pilot.
 */
export function timeoutDescription(timeoutMin: number): string {
  return timeoutMin > 0
    ? `each session is stopped after ${timeoutMin}m of non-blocked wall clock, then its handoff beads are read as usual`
    : 'no wall-clock timeout — sessions end when they hand off (--timeout-min to bound it)';
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Get a blocked session in front of the human.
 *
 * Best-effort and deliberately dumb: a terminal bell plus a macOS notification.
 * Until "answer from my phone" is settled this at least makes a block audible
 * rather than silent, which is the actual failure mode (17 sessions on this
 * machine blocked unnoticed, oldest 43 days).
 */
export function notifyBlocked(cwd: string, n: number, row: AgentRow): void {
  process.stdout.write(''); // bell
  if (process.platform !== 'darwin') return;
  const message = `Session ${n} needs input: ${row.waitingFor ?? 'a question'}`;
  spawnSync(
    'osascript',
    [
      '-e',
      `display notification ${JSON.stringify(message)} with title "justin-loop" sound name "Ping"`,
    ],
    {cwd, encoding: 'utf-8', timeout: 10_000},
  );
}

/**
 * Everything the loop reaches outside itself.
 *
 * Injected purely so the loop is testable. Its interesting behaviours are all
 * about the passage of time — a blocked session that outlives an opt-in bound, a
 * predecessor that will not die — and none can be exercised against a real clock
 * and a real `claude agents` without a test that takes 45 real minutes. With a
 * fake clock and a scripted sequence of agent rows they run in milliseconds.
 */
export interface RunnerDeps extends StopDeps {
  /** Spawn the background session. Returns `claude`'s stdout (the banner). */
  dispatch: (cwd: string, args: string[]) => Promise<string>;
  now: () => number;
  br: BrRunner;
  gitHead: (cwd: string) => Promise<HeadRead>;
  readUsage: (cwd: string) => Promise<UsageSnapshot | null>;
  appendLedgerRow: (
    path: string,
    row: LedgerRow,
  ) => {ok: boolean; reason: string | null};
  notifyBlocked: (cwd: string, n: number, row: AgentRow) => void;
  write: (text: string) => void;
  writeErr: (text: string) => void;
  /** Preflight is skipped entirely in tests; real runs pass the real one. */
  preflight: (cwd: string) => Promise<PreflightProblem[]>;
}

export const REAL_DEPS: RunnerDeps = {
  appendLedgerRow,
  br: runBr,
  /**
   * Spawn (or resume) a background session and hand back what `claude` said.
   *
   * A FAILED dispatch must not come back as a banner that merely happens to
   * contain no id (critical rule 6). `claude` prints its refusal on stderr and
   * exits non-zero, and that sentence is the entire diagnosis — without it the
   * run summary reads `\`claude --bg\` printed no id: ""`, which names no cause
   * and points at nothing. Measured 2026-09-09 while building the e2e fixture
   * (home-base-1r6d.33.10): `--bg` with `--permission-mode bypassPermissions`
   * exits 1 with "requires accepting the disclaimer first. Run `claude
   * --dangerously-skip-permissions` once interactively", and every word of that
   * was being thrown away.
   *
   * On success the return value is byte-identical to what it always was: the
   * caller only ever runs `parseBackgroundedId` over it.
   */
  dispatch: async (cwd, args) => {
    const outcome = await runChild(resolveClaudeBin(), args, {
      cwd,
      timeoutMs: DISPATCH_TIMEOUT_MS,
    });
    const failure = describeChildFailure('claude --bg', outcome);
    if (failure == null) return outcome.stdout;
    const said = outcome.stderr.trim();
    return `${outcome.stdout}${failure}${said !== '' ? `: ${said}` : ''}`;
  },
  findAgent,
  gitHead,
  notifyBlocked,
  now: () => Date.now(),
  preflight,
  readUsage,
  signalPid,
  sleep,
  stopSession,
  write: (text) => process.stdout.write(text),
  writeErr: (text) => process.stderr.write(text),
};

/** How one session's own run ended, before any bead is consulted. */
export type SessionEnding =
  | {kind: 'ended'}
  | {kind: 'timeout'; afterMin: number}
  | {kind: 'blocked-timeout'; waitingFor: string | null}
  | {kind: 'dispatch-failed'; banner: string}
  /**
   * `claude agents --json` could not be read enough times in a row that we have
   * stopped pretending to be watching. Without this the default
   * `--timeout-min 0` would poll a dead daemon forever, and every poll would be
   * an unknown the runner was quietly treating as "keep waiting".
   */
  | {kind: 'agents-unreadable'; reason: string; failures: number};

/** Consecutive unreadable `claude agents` polls before a session is abandoned. */
export const AGENTS_FAILURE_LIMIT = 5;

/**
 * How much session time passes between liveness lines while watching (D-a1go).
 *
 * A working session is silent by design — it prints nothing until it ends — so
 * the runner's own stdout used to go quiet for the entire life of a session.
 * That is indistinguishable from the wedge this bead is about (717s of nothing
 * on 2026-09-10), and "is it working or is it stuck?" is the one question the
 * output has to answer. One dim line a minute is cheap enough to leave on
 * always and carries what the answer needs: how long, how many polls, what the
 * row said, and whether the listing could be read at all.
 */
export const LIVENESS_INTERVAL_MS = 60_000;

export interface SessionRun {
  ending: SessionEnding;
  /** The `claude agents` id. null only when dispatch failed. */
  id: string | null;
  /**
   * The FULL session id read off the agents row while the session was running —
   * the only id `--resume` will continue rather than copy (D10). null means we
   * never managed to observe a row, and null is load-bearing: the short `id` is
   * a truncation of this and substituting it would silently start a SECOND live
   * session on the same worktree.
   *
   * Captured DURING the run because `claude stop` removes the row, and the
   * demand happens after the stop.
   */
  fullSessionId: string | null;
  durationMs: number;
}

/**
 * Run one background session to its end.
 *
 * "Its end" is `state === 'done'` or an absent row, and NOTHING else — see the
 * measured lifecycle above. There is no verdict file to wait for (D2), so an
 * ended session goes straight to the bead scan.
 */
export async function runSession(
  cwd: string,
  opts: JustinLoopOptions,
  n: number,
  boot: BootContext,
  name: string,
  deps: RunnerDeps,
): Promise<SessionRun> {
  const started = deps.now();
  const banner = await deps.dispatch(cwd, [
    '--bg',
    '--name',
    name,
    '--model',
    opts.model,
    '--permission-mode',
    opts.permissionMode,
    '--append-system-prompt',
    bootContract(
      sessionContract({
        blockedWaitMin: opts.blockedWaitMin,
        // The runner's cwd IS the beads workspace it scans for the handoff, so
        // the session is told to run `br` there (home-base-1r6d.33.9).
        cwd,
        label: boot.label,
      }),
      boot,
    ),
    composeBootPrompt(opts.prompt, boot),
  ]);

  const id = parseBackgroundedId(banner);
  if (id == null) {
    return {
      durationMs: deps.now() - started,
      ending: {banner: banner.trim(), kind: 'dispatch-failed'},
      fullSessionId: null,
      id: null,
    };
  }

  deps.write(
    `   ${DIM}background ${id} · inspect: claude logs ${id} · step in: claude attach ${id}${RESET}\n`,
  );

  return watchSession(cwd, opts, n, id, started, deps);
}

/**
 * The one dim line a liveness tick prints.
 *
 * Every part of it is a FACT ABOUT A MEASUREMENT, never a substitute for one
 * (critical rule 6): a listing that has never been read successfully says so
 * rather than borrowing "no row", which means read-and-absent; and an
 * unreadable listing names its reason and its streak next to whatever row we
 * last actually saw, so a stale row can never read as a current one.
 */
function livenessLine(state: {
  elapsedMs: number;
  polls: number;
  everRead: boolean;
  lastSeen: AgentRow | null;
  agentsFailures: number;
  lastUnreadable: string | null;
}): string {
  const minutes = Math.round(state.elapsedMs / 60_000);
  const what = !state.everRead
    ? 'no listing read yet'
    : state.lastSeen == null
      ? 'no row'
      : state.lastSeen.state === 'blocked'
        ? `blocked: ${state.lastSeen.waitingFor ?? 'unknown'}`
        : `${state.lastSeen.state ?? 'unknown'}/${state.lastSeen.status ?? 'unknown'}`;
  const agents =
    state.agentsFailures === 0
      ? 'agents ok'
      : `agents unreadable ×${state.agentsFailures}: ${state.lastUnreadable ?? 'unknown'}`;
  return `   ${DIM}watching ${minutes}m · ${state.polls} polls · ${what} · ${agents}${RESET}\n`;
}

/**
 * Poll one already-dispatched background session until it is over.
 *
 * Shared by the first dispatch and by every `--resume` demand (D10), so a
 * demanded turn is watched, timed and bounded by exactly the same rules as the
 * turn that preceded it — including the blocked handling, which is the one place
 * where "waiting for Justin" must not be mistaken for a hang.
 */
async function watchSession(
  cwd: string,
  opts: JustinLoopOptions,
  n: number,
  id: string,
  started: number,
  deps: RunnerDeps,
): Promise<SessionRun> {
  // Mutable: time the session spends BLOCKED is pushed onto the deadline when it
  // starts moving again (D3). A wall-clock timeout is there to catch a session
  // that has run away, and a session waiting for a human has not run away — it is
  // doing exactly what it was told to do. null = no timeout at all (D7, default).
  let deadline: number | null =
    opts.timeoutMin > 0 ? started + opts.timeoutMin * 60_000 : null;
  let blockedSince: number | null = null;
  let notified = false;

  let agentsFailures = 0;
  /**
   * The last full session id we actually SAW. Captured here rather than after
   * the run because the stop removes the row, and `--resume` needs this exact
   * string (home-base-1r6d.33.3, measured).
   */
  let fullSessionId: string | null = null;

  // Liveness bookkeeping. `lastSeen` is the last row we ACTUALLY read, kept
  // apart from `everRead` so "never managed to look" can never print as "there
  // is no row".
  let polls = 0;
  let lastLiveness = started;
  let everRead = false;
  let lastSeen: AgentRow | null = null;
  let lastUnreadable: string | null = null;

  for (;;) {
    await deps.sleep(opts.pollSec * 1000);
    const look = await deps.findAgent(cwd, id);
    polls++;
    if (look.ok) {
      everRead = true;
      lastSeen = look.row;
      // A successful read ends the streak (the failure limit below counts
      // CONSECUTIVE failures), and with it the "unreadable" half of the line.
      agentsFailures = 0;
    } else {
      agentsFailures++;
      lastUnreadable = look.reason;
    }

    const nowMs = deps.now();
    if (nowMs - lastLiveness >= LIVENESS_INTERVAL_MS) {
      lastLiveness = nowMs;
      deps.write(
        livenessLine({
          agentsFailures,
          elapsedMs: nowMs - started,
          everRead,
          lastSeen,
          lastUnreadable,
          polls,
        }),
      );
    }

    if (!look.ok) {
      // A listing we could not read is NOT an ending and NOT a continuation —
      // it is an unknown. Keep waiting, but boundedly, and then say so.
      if (agentsFailures >= AGENTS_FAILURE_LIMIT) {
        return {
          durationMs: deps.now() - started,
          ending: {
            failures: agentsFailures,
            kind: 'agents-unreadable',
            reason: look.reason,
          },
          fullSessionId,
          id,
        };
      }
      continue;
    }
    const row = look.row;
    if (row?.sessionId != null) fullSessionId = row.sessionId;

    if (row == null || isSessionEnded(row)) {
      return {
        durationMs: deps.now() - started,
        ending: {kind: 'ended'},
        fullSessionId,
        id,
      };
    }

    if (row.state === 'blocked') {
      const now = deps.now();
      if (blockedSince == null) blockedSince = now;
      if (!notified) {
        deps.notifyBlocked(cwd, n, row);
        notified = true;
      }
      // The bound is OPT-IN (D3). null means blocked is "waiting for Justin", and
      // the runner has no business deciding he took too long.
      const waitMin = opts.blockedWaitMin;
      if (waitMin != null && now - blockedSince > waitMin * 60_000) {
        return {
          durationMs: now - started,
          ending: {kind: 'blocked-timeout', waitingFor: row.waitingFor},
          fullSessionId,
          id,
        };
      }
      // The timeout must NOT fire while the session waits for a human, so the
      // deadline check below is skipped for as long as this stretch lasts; when
      // it ends, the whole stretch is added back. Otherwise
      // `--blocked-wait-min 720` would be a lie.
      continue;
    }

    if (blockedSince != null) {
      // Answered, and moving again. Give the session back the time it spent
      // waiting on us.
      if (deadline != null) deadline += deps.now() - blockedSince;
      blockedSince = null;
      notified = false;
    }

    if (deadline != null && deps.now() > deadline) {
      return {
        durationMs: deps.now() - started,
        ending: {afterMin: opts.timeoutMin, kind: 'timeout'},
        fullSessionId,
        id,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Yield enforcement: resume the session and DEMAND a handoff (D10)
//
// A session that ends without a valid handoff bead has broken the only control
// channel the loop has. The runner does not guess what it meant and does not
// spawn anything — it wakes that same session and tells it, in the same
// conversation, what is missing and exactly which command writes it. Bounded by
// `--handoff-retries`, and every path out of here refuses to spawn a successor.
//
// THE RESUME MECHANISM, MEASURED 2026-09-08 against claude v2.1.263
// (home-base-1r6d.33.3 AC1). Two throwaway `--bg` haiku sessions, both removed:
//
//   `claude --bg --resume <FULL sessionId> "<prompt>"`, WITH NO OTHER FLAGS,
//   WAKES THE SAME SESSION — same short id, same sessionId, same conversation.
//   Proven by content, not by id: the session was asked for a word, replied
//   `done`, was `claude stop`-ed, and on resume answered "what did you reply a
//   moment ago" with `done AGAIN`. stderr: "note: woke session 11205a3b with its
//   saved options (--name, --model, --permission-mode)."
//
//   PASSING ANY OTHER FLAG STARTS A COPY — even the same `--name` it already
//   had: "note: background session 11205a3b keeps its own saved options, so the
//   flags you passed started a copy as 0ea9def1. Without flags, the same command
//   continues 11205a3b itself." A copy is a SECOND live session on the same
//   worktree, i.e. the 1r6d.31/.32 failure, so `resumeArgs` passes the prompt and
//   nothing else. The woken session keeps its own model, permission mode and
//   system prompt, so the demand text has to stand on its own.
//
//   A `claude stop` does not prevent a later resume (the row is gone from the
//   default list but the conversation is not). The banner is the usual
//   `backgrounded · <id> · <name>`, so `parseBackgroundedId` works unchanged.
//
// The short `id` is the first 8 characters of `sessionId`, and that near-miss is
// exactly the hazard: `--resume <short id>` silently forks a copy. The runner
// therefore READS `sessionId` off the row while the session is still listed, and
// treats "never observed" as its own outcome rather than falling back.
//
// No fallback path (a fresh session pointed at the transcript) is implemented,
// because resume works.
// ---------------------------------------------------------------------------

/** The enforce half of `SessionOutcome`, named so it can be passed around. */
export type EnforceOutcome = Extract<SessionOutcome, {kind: 'enforce'}>;

/**
 * The argv that CONTINUES a session rather than copying it.
 *
 * Deliberately minimal, and it must stay that way: every extra flag measured
 * turns this into a fork (see above). If a future flag is genuinely needed here,
 * re-measure first.
 */
export function resumeArgs(fullSessionId: string, demand: string): string[] {
  return ['--bg', '--resume', fullSessionId, demand];
}

/**
 * What the runner says to a session that did not hand off (D10, decision 3).
 *
 * Written for a session whose system prompt may not be re-applied on resume, so
 * it repeats the whole helper invocation with this session's real label already
 * interpolated. It quotes the validation errors VERBATIM, per bead: a session
 * told only "invalid" cannot tell whether it wrote nothing, wrote unparseable
 * notes, or is looking at someone else's broken bead.
 */
export function handoffDemand(opts: {
  label: string;
  /** The enforce outcome's own words for what the runner looked for and found. */
  reason: string;
  /**
   * The unreadable open handoff beads, if any. Deliberately NOT keyed off the
   * enforce `sub`: whether to tell the session about a broken bead depends on
   * whether there IS one, and nothing else. (Today `sub` is `invalid-handoff`
   * exactly when this is non-empty, but a demand that dropped a bead because a
   * flag said so would be the failure this whole file is about.)
   */
  invalid: InvalidHandoff[];
  /** 1-based. */
  attempt: number;
  attempts: number;
}): string {
  const lines: string[] = [
    `[justin-loop runner] This message is from the runner that started you, not from a person. Your session label is \`${opts.label}\`.`,
    '',
    `YOU ENDED WITHOUT A VALID HANDOFF BEAD, so the loop cannot continue and no successor session has been started. ${opts.reason}`,
    '',
  ];

  if (opts.invalid.length > 0) {
    lines.push(
      'These open handoff beads could not be read, and one of them may be the one you wrote:',
    );
    for (const bad of opts.invalid) {
      lines.push(`  - ${bad.id} ("${bad.title}"): ${bad.errors.join('; ')}`);
    }
    lines.push(
      '',
      'FIRST fix or close each of those: `br update <id> --notes=<the exact JSON the helper writes>` if it is yours and salvageable, or `br close <id> --reason=...` if it is not. An unreadable open handoff bead is why validation fails.',
      '',
    );
  }

  lines.push(
    'THEN commit your code and your `.beads/` changes, and run this ONCE:',
    '',
    `  justin-sdk justin-loop handoff --from=${opts.label} --disposition=continue|done|blocked --arc=<bead id or arc name> --worktree=<absolute path> --branch=<branch> --state='<where the work actually stands>' --next='<the successor's complete starting instructions, written for a cold reader>' [--open-question='<...>']... [--context-tokens=<N>]`,
    '',
    'Pick `continue` if work remains, `done` if the arc is finished, `blocked` if you need Justin. Write the bead with the helper, never by hand. Then end your turn.',
    '',
    `This is demand ${opts.attempt} of ${opts.attempts}. If there is still no valid handoff bead after the last one, the run stops and files a bug bead against this session.`,
  );
  return lines.join('\n');
}

/**
 * The bead filed when a session would not hand off however often it was asked.
 *
 * Deliberately NOT labelled `handoff` — it is a bug report about a missing
 * handoff, and a bead carrying that label would be picked up by the next run's
 * start-of-run scan as though it were the thing it is complaining about.
 */
export function handoffFailureTitle(label: string, demands: number): string {
  return `justin-loop: session ${label} ended without a handoff after ${demands} demand${demands === 1 ? '' : 's'}`;
}

export function handoffFailureDescription(opts: {
  label: string;
  demands: number;
  reason: string;
  invalid: InvalidHandoff[];
  cwd: string;
}): string {
  const lines = [
    `Session \`${opts.label}\` (in ${opts.cwd}) was resumed ${opts.demands} time(s) and told to write a handoff bead with \`justin-sdk justin-loop handoff --from=${opts.label} ...\`, and there is still no valid open handoff bead with that \`from\`.`,
    '',
    `Last thing the runner saw: ${opts.reason}`,
  ];
  if (opts.invalid.length > 0) {
    lines.push('', 'Open handoff beads that could not be parsed:');
    for (const bad of opts.invalid) {
      lines.push(`  - ${bad.id} ("${bad.title}"): ${bad.errors.join('; ')}`);
    }
  }
  lines.push(
    '',
    'The chain is stopped. Nothing was spawned. Read that session (`claude logs`) or the branch to find out what it actually did, then either write the handoff bead by hand or close this.',
  );
  return lines.join('\n');
}

/** Filing the failure bead is best-effort, and its failure is never silent. */
export type FailureBeadResult =
  {ok: true; id: string} | {ok: false; reason: string};

export function fileHandoffFailureBead(
  cwd: string,
  opts: {
    label: string;
    demands: number;
    reason: string;
    invalid: InvalidHandoff[];
  },
  run: BrRunner,
): FailureBeadResult {
  const created = run(cwd, [
    'create',
    handoffFailureTitle(opts.label, opts.demands),
    '-t',
    'bug',
    '-p',
    '1',
    `--description=${handoffFailureDescription({...opts, cwd})}`,
  ]);
  if (!created.ok) {
    return {
      ok: false,
      reason: created.reason ?? 'br failed for an unrecorded reason',
    };
  }
  const id = parseCreatedId(created.stdout);
  if (id == null) {
    return {
      ok: false,
      reason: `\`br create\` succeeded but its output did not name an id: ${JSON.stringify(created.stdout.trim())}`,
    };
  }
  return {id, ok: true};
}

/** Everything the demand loop needs about the session it is chasing. */
export interface DemandContext {
  cwd: string;
  opts: JustinLoopOptions;
  /** The session's label — the `from` every handoff bead must carry. */
  label: string;
  /** Session number in the chain, for the blocked notification. */
  n: number;
  /** The FULL sessionId. null = we never saw a row, so no demand can be sent. */
  fullSessionId: string | null;
}

/**
 * How the demand loop ended. Each member is a different fact, and NONE of them
 * is "spawn a successor" — that decision belongs to the caller, and only
 * `resolved` can even reach it.
 */
export type DemandResult =
  /** The session answered: this is the re-scan's verdict, whatever it is. */
  | {
      kind: 'resolved';
      outcome: ResolvedOutcome;
      stop: StopReport;
      demands: number;
    }
  /** Every demand spent, still no readable handoff. */
  | {
      kind: 'exhausted';
      enforce: EnforceOutcome;
      stop: StopReport;
      demands: number;
    }
  /**
   * We stopped being able to ask, or to watch the answer. Distinct from
   * `exhausted`, which is a session that WAS asked and did not comply.
   */
  | {
      kind: 'aborted';
      reason: string;
      ledgerOutcome: LedgerOutcome;
      stop: StopReport;
      demands: number;
      enforce: EnforceOutcome;
    };

/**
 * Resume the session and demand a handoff, up to `--handoff-retries` times.
 *
 * Invariants, all of them load-bearing:
 *   - Every dispatch from here is a `--resume` of the SAME session. Nothing in
 *     this function can start a new one.
 *   - Every demanded turn is stopped and verified before its beads are read,
 *     exactly like the turn that preceded it.
 *   - `handoffRetries: 0` sends nothing and returns `exhausted` with 0 demands,
 *     which is the pre-.3 behaviour and the negative control for the bound.
 */
export async function demandHandoff(
  ctx: DemandContext,
  first: EnforceOutcome,
  firstStop: StopReport,
  deps: RunnerDeps,
): Promise<DemandResult> {
  let enforce = first;
  let stop = firstStop;
  let demands = 0;

  while (demands < ctx.opts.handoffRetries) {
    // NOT SPECIFIED BY THE BEAD, added because .3 creates the hazard: a demand
    // is a `claude --bg` call aimed at a session we have just tried to stop. If
    // the stop could not be CONFIRMED, that session may still be running, and
    // what a resume does to a live session is not measured. D6 says an
    // unverified predecessor licenses nothing — that has to cover waking it too,
    // not only spawning past it.
    if (!isVerifiedGone(stop.outcome)) {
      return {
        demands,
        enforce,
        kind: 'aborted',
        // `stopOutcome` on the same ledger row says which of kill-failed /
        // no-pid / unverified this was.
        ledgerOutcome: 'kill-failed',
        reason: `REFUSING TO DEMAND: session ${ctx.label} could not be confirmed gone from \`claude agents\` (${stop.outcome}), so waking it could be talking to a session that is still running`,
        stop,
      };
    }

    const fullSessionId = ctx.fullSessionId;
    if (fullSessionId == null) {
      // The short `claude agents` id would start a COPY, not continue this
      // session, so there is nothing safe to fall back to (measured).
      return {
        demands,
        enforce,
        kind: 'aborted',
        ledgerOutcome: 'demand-undeliverable',
        reason: `cannot demand a handoff from ${ctx.label}: its full session id was never seen in \`claude agents\`, and \`--resume\` with the short id would start a COPY of the session rather than continue it`,
        stop,
      };
    }

    demands++;
    const demand = handoffDemand({
      attempt: demands,
      attempts: ctx.opts.handoffRetries,
      invalid: enforce.invalid,
      label: ctx.label,
      reason: enforce.reason,
    });
    deps.write(
      `   ${YELLOW}demand ${demands}/${ctx.opts.handoffRetries}${RESET}${DIM} waking ${fullSessionId} to ask for a handoff bead${RESET}\n`,
    );

    const started = deps.now();
    const banner = await deps.dispatch(
      ctx.cwd,
      resumeArgs(fullSessionId, demand),
    );
    const id = parseBackgroundedId(banner);
    if (id == null) {
      return {
        demands,
        enforce,
        kind: 'aborted',
        ledgerOutcome: 'demand-undeliverable',
        reason: `could not resume ${ctx.label} to demand a handoff — \`claude --bg --resume\` printed no id: ${JSON.stringify(banner.trim())}`,
        stop,
      };
    }

    const run = await watchSession(ctx.cwd, ctx.opts, ctx.n, id, started, deps);

    // Stop and verify the DEMANDED turn too. A woken session lingers in
    // `claude agents` exactly like any other, and the successor gate downstream
    // reads this report, not the one from before the demand.
    // The ladder prints its own notes as it climbs (StopDeps.write), so there
    // is nothing to print here — a second pass over `stop.notes` would double
    // every line.
    stop = await stopAndVerify(ctx.cwd, id, ctx.opts.stopPollSec * 1000, deps);

    if (run.ending.kind === 'agents-unreadable') {
      return {
        demands,
        enforce,
        kind: 'aborted',
        ledgerOutcome: 'agents-unreadable',
        reason: `lost sight of session ${ctx.label} while demanding a handoff: \`claude agents --json\` failed ${run.ending.failures} polls in a row (${run.ending.reason})`,
        stop,
      };
    }
    if (run.ending.kind === 'blocked-timeout') {
      return {
        demands,
        enforce,
        kind: 'aborted',
        ledgerOutcome: 'blocked',
        reason: `session ${ctx.label} blocked while being asked for a handoff ("${run.ending.waitingFor ?? 'a question'}") and waited ${ctx.opts.blockedWaitMin}m with no answer`,
        stop,
      };
    }
    if (run.ending.kind === 'timeout') {
      deps.write(
        `   ${YELLOW}!${RESET} the demanded turn hit --timeout-min (${run.ending.afterMin}m) — reading the beads anyway\n`,
      );
    }

    const outcome = decideAfterSession(
      scanHandoffBeads(ctx.cwd, deps.br),
      ctx.label,
    );
    if (outcome.kind !== 'br-unavailable')
      renderInvalid(outcome.invalid, deps.write);
    if (outcome.kind !== 'enforce') {
      return {demands, kind: 'resolved', outcome, stop};
    }
    deps.write(`   ${YELLOW}!${RESET} still no handoff: ${outcome.reason}\n`);
    enforce = outcome;
  }

  return {demands, enforce, kind: 'exhausted', stop};
}

/** Why the run stopped, and what the process should exit with. */
export interface RunEnd {
  reason: string;
  exitCode: number;
}

function renderInvalid(
  invalid: InvalidHandoff[],
  write: (t: string) => void,
): void {
  for (const bad of invalid) {
    write(
      `   ${YELLOW}!${RESET} handoff bead ${bad.id} ("${bad.title}") is UNREADABLE: ${bad.errors.join('; ')}\n`,
    );
  }
}

/**
 * Block until both quota windows are back under their thresholds. Polling is
 * free (see readUsage), so we poll rather than parse the reset timestamp — no
 * timezone/date parsing to get wrong.
 */
async function waitForGate(
  cwd: string,
  opts: JustinLoopOptions,
  usage: UsageSnapshot,
  deps: RunnerDeps,
): Promise<UsageSnapshot | null> {
  let current: UsageSnapshot | null = usage;
  while (
    current != null &&
    (current.sessionPct >= opts.sessionStopPct ||
      current.weekPct >= opts.weeklyStopPct)
  ) {
    const which =
      current.sessionPct >= opts.sessionStopPct ? 'session' : 'weekly';
    deps.write(
      `${YELLOW}⏸${RESET}  ${which} quota gate: session ${current.sessionPct}% / week ${current.weekPct}%. ` +
        `${DIM}resets ${current.sessionResetsAt ?? 'unknown'} · re-checking in ${opts.gatePollMin}m${RESET}\n`,
    );
    await deps.sleep(opts.gatePollMin * 60_000);
    current = await deps.readUsage(cwd);
  }
  return current;
}

export async function runJustinLoop(
  cwd: string,
  overrides: Partial<JustinLoopOptions> = {},
  deps: RunnerDeps = REAL_DEPS,
): Promise<number> {
  const opts: JustinLoopOptions = {...DEFAULT_OPTIONS, ...overrides};

  for (const problem of await deps.preflight(cwd)) {
    deps.writeErr(
      `${problem.fatal ? `${RED}error` : `${YELLOW}warn `}${RESET} ${problem.message}\n`,
    );
    if (problem.fatal) return 1;
  }

  const slug = runSlug(opts);
  const kickoff = new Date(deps.now());
  const stamp = runStamp(kickoff);
  const runId = `${stamp.replace(/[^0-9]/g, '')}-${slug}`;
  const ledgerPath = runsJsonlPath(opts.stateDir);

  deps.write(
    `\n${BOLD}justin-loop${RESET} ${DIM}→${RESET} ${cwd}\n` +
      `${DIM}prompt=${opts.prompt}  model=${opts.model}  perms=${opts.permissionMode}  ` +
      `max=${opts.maxSessions} sessions  labels=${slug}-1…${slug}-${opts.maxSessions}  ` +
      (opts.usageGate
        ? `session-stop=${opts.sessionStopPct}%  week-stop=${opts.weeklyStopPct}%`
        : `usage-gate=DISABLED`) +
      `${RESET}\n` +
      `${DIM}${timeoutDescription(opts.timeoutMin)}; ${blockedWaitDescription(opts.blockedWaitMin)}${RESET}\n` +
      // WHICH `claude` this run will spawn, said out loud once. A cmux pane puts
      // a shim first on PATH that answers `claude stop` by prompting the model
      // (measured 2026-09-12), so "which binary" is not a detail.
      `${DIM}claude=${resolveClaudeBin()}${RESET}\n` +
      `${DIM}ledger ${ledgerPath}${RESET}\n\n`,
  );

  // The pickup path (D1/D10): a run that starts with an open handoff bead
  // waiting is a continuation, not a fresh start. Read-only, and reported in dry
  // runs too — "is anything waiting in this repo?" is exactly what a dry run is
  // for. The scan ALWAYS runs; an explicit `--prompt` changes whether its result
  // is acted on, never whether the human gets to see it.
  const startBoot = planStartBoot(scanHandoffBeads(cwd, deps.br), {
    pickup: opts.pickup,
    promptExplicit: opts.promptExplicit,
  });
  for (const line of startBoot.report) {
    deps.write(`${DIM}handoff${RESET} ${line}\n`);
  }

  if (opts.dryRun) {
    if (!opts.usageGate) {
      deps.write(
        `${DIM}dry run — no sessions spawned${RESET}\n` +
          `  quota gate    ${quotaGateDisabled()}\n` +
          `  session       ${DIM}not read${RESET}\n` +
          `  week          ${DIM}not read${RESET}\n\n`,
      );
      return 0;
    }
    const usage = await deps.readUsage(cwd);
    if (usage == null) {
      deps.writeErr(`${RED}error${RESET} could not read /usage\n`);
      return 1;
    }
    deps.write(
      `${DIM}dry run — no sessions spawned${RESET}\n` +
        `  subscription  ${usage.isSubscription ? 'yes' : `${YELLOW}NO — check billing${RESET}`}\n` +
        `  session       ${quotaBar(usage.sessionPct, opts.sessionStopPct)}\n` +
        `  week          ${quotaBar(usage.weekPct, opts.weeklyStopPct)}\n\n`,
    );
    return 0;
  }

  let end: RunEnd = {
    exitCode: 0,
    reason: `reached --max-sessions (${opts.maxSessions})`,
  };
  let noProgressStreak = 0;
  /**
   * Did any session in the CURRENT streak have an unreadable HEAD? Only so the
   * abort reason can say so: "3 sessions with no commit" is a measurement, and
   * a session whose HEAD could not be read was never measured (critical rule 6).
   */
  let noProgressHadUnreadable = false;
  let bootPlan: BootPlan = startBoot.plan;
  let sessionsRun = 0;
  /**
   * The handoff bead the chain would have booted from next, if the run had any
   * sessions left. Named in the summary so hitting --max-sessions never looks
   * like the arc finishing: the bead stays OPEN, and the next run picks it up.
   */
  let unspentHandoff: string | null = null;

  for (let n = 1; n <= opts.maxSessions; n++) {
    const label = sessionLabel(slug, n);
    const name = sessionName(stamp, label);
    const boot: BootContext = {cwd, label, plan: bootPlan};

    // --- gate (free) ---
    const decision = await checkGate(opts, () => deps.readUsage(cwd));
    if (decision.kind === 'unreadable') {
      end = {exitCode: 2, reason: decision.reason};
      break;
    }
    // Stays null for the whole session when the gate is off, all the way through
    // the dashboard. A disabled gate means quota was never measured — never that
    // it measured zero.
    let usage: UsageSnapshot | null =
      decision.kind === 'disabled' ? null : decision.usage;
    if (decision.kind === 'tripped') {
      if (opts.onGateHit === 'exit') {
        end = {
          exitCode: 0,
          reason: `quota gate (session ${decision.usage.sessionPct}% / week ${decision.usage.weekPct}%)`,
        };
        break;
      }
      const resumed = await waitForGate(cwd, opts, decision.usage, deps);
      if (resumed == null) {
        end = {
          exitCode: 2,
          reason: 'could not read /usage while paused — failing closed',
        };
        break;
      }
      usage = resumed;
    }

    // --- work ---
    deps.write(
      `${BOLD}#${n}/${opts.maxSessions}${RESET} ${DIM}${name}${RESET}\n`,
    );
    const headBefore = await deps.gitHead(cwd);
    const startedAt = new Date(deps.now()).toISOString();
    const run = await runSession(cwd, opts, n, boot, name, deps);
    sessionsRun++;
    const headAfter = await deps.gitHead(cwd);
    // UNKNOWN IS NOT "NO COMMIT" (critical rule 6). Either read failing means we
    // do not know whether this session committed anything, and comparing a
    // failure to a sha — or a failure to a failure — invents an answer: the old
    // `null !== null` said "no commit", a measurement nobody took, and it feeds
    // the circuit breaker below.
    const progressed: boolean | null =
      headBefore.ok && headAfter.ok ? headBefore.sha !== headAfter.sha : null;
    for (const failed of [headBefore, headAfter]) {
      if (!failed.ok) {
        deps.writeErr(
          `${YELLOW}warn ${RESET} could not read HEAD in ${cwd}: ${failed.reason}\n`,
        );
      }
    }

    // How many times this session had to be resumed and TOLD to hand off (D10).
    // Reset per session, carried into the ledger row so a demanded handoff never
    // reads like a spontaneous one.
    let demands = 0;

    const ledger = (
      outcome: LedgerOutcome,
      handoffBead: string | null,
      stopOutcome: StopOutcome | null,
      contextTokens: number | null,
    ): void => {
      const written = deps.appendLedgerRow(ledgerPath, {
        contextTokens,
        demands,
        endedAt: new Date(deps.now()).toISOString(),
        handoffBead,
        label,
        n,
        name,
        outcome,
        progressed,
        runId,
        schemaVersion: LEDGER_SCHEMA_VERSION,
        sessionId: run.id,
        startedAt,
        stopOutcome,
      });
      if (!written.ok) {
        // Never fatal, never silent (D8).
        deps.writeErr(
          `${YELLOW}warn ${RESET} could not append to ${ledgerPath}: ${written.reason ?? 'unrecorded reason'}\n`,
        );
      }
      deps.write(
        `   ${outcomeColor(outcome)}${outcome}${RESET}${DIM} · ${Math.round(run.durationMs / 1000)}s · ${progressed == null ? 'HEAD unreadable' : progressed ? 'committed' : 'no commit'}` +
          (stopOutcome != null ? ` · stop=${stopOutcome}` : '') +
          `${RESET}\n`,
      );
      deps.write(
        usage == null
          ? `   ${DIM}quota${RESET} ${quotaGateDisabled()}\n`
          : `   ${DIM}session${RESET} ${quotaBar(usage.sessionPct, opts.sessionStopPct)}` +
              `   ${DIM}week${RESET} ${quotaBar(usage.weekPct, opts.weeklyStopPct)}\n`,
      );
    };

    if (run.ending.kind === 'dispatch-failed') {
      // No session exists, so there is nothing to stop, scan or resume. Stopping
      // is the honest response: a retry loop here would spend quota blind.
      ledger('dispatch-failed', null, null, null);
      end = {
        exitCode: 2,
        reason: `session ${label} could not be dispatched — \`claude --bg\` printed no id: ${JSON.stringify(run.ending.banner)}`,
      };
      break;
    }

    const sessionId = run.id as string;

    // --- STOP AND VERIFY, ALWAYS, BEFORE ANYTHING ELSE (D6) ---
    // Measured: an ended session lingers in `claude agents` as state='done' with
    // a live pid, forever. So there is no path on which "it ended" already means
    // "it is gone" — every path stops it and confirms, and only then may a
    // successor be spawned.
    //
    // The stop REMOVES the row, and with it the only place the full session id
    // is published — which is why `runSession` captured it while polling. A
    // demand needs it (D10) and the short id would fork a copy.
    // Notes stream out of the ladder itself as each rung is tried; printing
    // `stop.notes` here as well would print every one of them twice.
    let stop = await stopAndVerify(
      cwd,
      sessionId,
      opts.stopPollSec * 1000,
      deps,
    );

    if (run.ending.kind === 'agents-unreadable') {
      // We stopped watching, so we do not know what this session is doing. The
      // only safe move is to stop the run — reading the beads now would act on
      // a session that may still be writing them.
      ledger('agents-unreadable', null, stop.outcome, null);
      end = {
        exitCode: 2,
        reason: `lost sight of session ${label}: \`claude agents --json\` failed ${run.ending.failures} polls in a row (${run.ending.reason}). Nothing is spawned — check the Claude Code daemon.`,
      };
      break;
    }

    if (run.ending.kind === 'blocked-timeout') {
      ledger('blocked', null, stop.outcome, null);
      end = {
        exitCode: 2,
        reason: `session ${label} waited ${opts.blockedWaitMin}m for an answer to "${run.ending.waitingFor ?? 'a question'}" and got none — stopped`,
      };
      break;
    }

    // --- READ THE BEAD (D2): the only thing that decides what happens next ---
    //
    // A `--timeout-min` ending is read EXACTLY like any other (D7, reversing
    // .2's V-f, which threw the beads away on this path). The timeout says the
    // clock ran out; it says nothing about whether the session handed off before
    // it hung, and discarding a valid handoff that is sitting right there throws
    // away real, committed work and re-runs it. The session was stopped and
    // CONFIRMED gone above, so reading its beads now cannot race it.
    if (run.ending.kind === 'timeout') {
      deps.write(
        `   ${YELLOW}!${RESET} session ${label} was stopped after ${run.ending.afterMin}m (--timeout-min) — reading its handoff beads anyway: one written before it hung is still valid (D7)\n`,
      );
    }
    const scanned = decideAfterSession(scanHandoffBeads(cwd, deps.br), label);

    if (scanned.kind !== 'br-unavailable')
      renderInvalid(scanned.invalid, deps.write);

    // --- YIELD ENFORCEMENT (D10): ask the session itself, up to N times ---
    //
    // `outcome` is the verdict AFTER any demands, and its type cannot be
    // `enforce`: every enforce either resolves into something else or ends the
    // run right here. That is what makes "no successor on a demand path"
    // structural rather than a rule someone has to remember.
    let outcome: ResolvedOutcome;
    if (scanned.kind === 'enforce') {
      deps.write(`   ${YELLOW}!${RESET} ${scanned.reason}\n`);
      const demanded = await demandHandoff(
        {cwd, fullSessionId: run.fullSessionId, label, n, opts},
        scanned,
        stop,
        deps,
      );
      demands = demanded.demands;
      stop = demanded.stop;

      if (demanded.kind === 'aborted') {
        ledger(demanded.ledgerOutcome, null, stop.outcome, null);
        end = {
          exitCode: 2,
          reason: `${demanded.reason}. No successor is spawned.`,
        };
        break;
      }
      if (demanded.kind === 'exhausted') {
        // A bounded failure that has to be impossible to miss: the run stops,
        // the ledger says so, and a bead is filed so it survives the terminal.
        // With --handoff-retries=0 nothing was demanded, so this is simply the
        // pre-.3 report and no bug bead is filed against a session nobody asked.
        const bounded = demands > 0;
        ledger(
          bounded ? 'no-handoff-after-demands' : demanded.enforce.sub,
          null,
          stop.outcome,
          null,
        );
        let filed = '';
        if (bounded) {
          const bead = fileHandoffFailureBead(
            cwd,
            {
              demands,
              invalid: demanded.enforce.invalid,
              label,
              reason: demanded.enforce.reason,
            },
            deps.br,
          );
          filed = bead.ok
            ? ` Filed ${bead.id}.`
            : ` The failure bead could NOT be filed (${bead.reason}) — this run exists only in the ledger and in what you are reading.`;
          deps.write(
            bead.ok
              ? `   ${DIM}filed ${bead.id}${RESET}\n`
              : `   ${RED}!${RESET} could not file the failure bead: ${bead.reason}\n`,
          );
        }
        end = {
          exitCode: 2,
          reason: bounded
            ? `session ${label} was told ${demands} time(s) to write a handoff bead and still has none: ${demanded.enforce.reason} No successor is spawned.${filed}`
            : `${demanded.enforce.reason} No successor is spawned, and no handoff was demanded (--handoff-retries=0).`,
        };
        break;
      }
      outcome = demanded.outcome;
      if (outcome.kind !== 'br-unavailable') {
        deps.write(
          `   ${GREEN}✓${RESET}${DIM} handoff written after ${demands} demand(s)${RESET}\n`,
        );
      }
    } else {
      outcome = scanned;
    }

    if (outcome.kind === 'br-unavailable') {
      ledger('br-unavailable', null, stop.outcome, null);
      end = {
        exitCode: 2,
        reason: `could not read the handoff beads (${outcome.reason}) — stopping rather than guessing that none exist`,
      };
      break;
    }
    if (outcome.kind === 'multiple') {
      ledger('multiple-handoffs', null, stop.outcome, null);
      deps.write(
        `   ${RED}!${RESET} ${outcome.matches.length} open handoff beads carry from=${label}: ${outcome.matches
          .map((m) => m.row.id)
          .join(', ')}\n`,
      );
      end = {
        exitCode: 2,
        reason: `session ${label} left ${outcome.matches.length} open handoff beads — the chain has forked, so nothing is spawned. Close all but one and re-run.`,
      };
      break;
    }
    const {match} = outcome;
    ledger(
      outcome.kind,
      match.row.id,
      stop.outcome,
      match.handoff.contextTokens,
    );
    deps.write(
      `   ${DIM}handoff ${match.row.id} · disposition=${match.handoff.disposition} · arc=${match.handoff.arc}${RESET}\n` +
        `   ${match.handoff.state}\n`,
    );

    if (outcome.kind === 'done') {
      end = {
        exitCode: 0,
        reason: `done — ${match.handoff.arc} is finished (handoff bead ${match.row.id})`,
      };
      break;
    }
    if (outcome.kind === 'blocked') {
      for (const q of match.handoff.openQuestions) {
        deps.write(`   ${YELLOW}?${RESET} ${q}\n`);
      }
      end = {
        exitCode: 2,
        reason: `blocked — session ${label} needs Justin (handoff bead ${match.row.id}${match.handoff.openQuestions.length === 0 ? ', but it listed no open questions' : ''})`,
      };
      break;
    }

    // --- continue: spawn a successor, but ONLY off a verified-gone predecessor ---
    if (!isVerifiedGone(stop.outcome)) {
      end = {
        exitCode: 2,
        reason: `REFUSING TO SPAWN: session ${label} is still present in \`claude agents\` after every stop attempt (${stop.outcome}). A successor on a live predecessor is the failure this check exists to prevent.`,
      };
      break;
    }

    // An UNREADABLE head counts toward the streak, like a session that did not
    // commit. The two directions are not symmetric: treating unknown as progress
    // resets the breaker and licenses looping forever on quota, while treating
    // it as no-progress at worst stops a run early and says why.
    if (progressed === true) {
      noProgressStreak = 0;
      noProgressHadUnreadable = false;
    } else {
      noProgressStreak++;
      if (progressed == null) noProgressHadUnreadable = true;
    }
    if (noProgressStreak >= opts.noProgressAbort) {
      end = {
        exitCode: 2,
        reason: `${noProgressStreak} sessions with no commit${noProgressHadUnreadable ? ' or an unreadable HEAD' : ''} — circuit breaker`,
      };
      break;
    }

    bootPlan = {kind: 'handoff', match};
    unspentHandoff = match.row.id;
    deps.write(`   ${DIM}next session boots from ${match.row.id}${RESET}\n`);
  }

  // Reaching --max-sessions with a `continue` handoff in hand is a BOUND, not a
  // finish. Saying only "reached max sessions" would read as "the arc is done"
  // while an open bead sits there waiting (critical rule 6).
  const bound =
    unspentHandoff != null && sessionsRun >= opts.maxSessions
      ? ` Handoff bead ${unspentHandoff} is still OPEN — the arc is NOT finished; re-run to continue from it.`
      : '';

  deps.write(
    `\n${BOLD}── run summary ──${RESET}\n` +
      `  stopped     ${end.reason}${bound}\n` +
      `  sessions    ${sessionsRun}\n` +
      `  ledger      ${ledgerPath}\n\n`,
  );
  return end.exitCode;
}
