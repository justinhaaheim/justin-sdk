/**
 * `thread stop-check` — the Stop hook that will not let a hand-written status
 * report pass as a recorded one (home-base-p1uj.15).
 *
 * WHY IT EXISTS. The adoption sample taken on 2026-09-14 (in p1uj.15's notes)
 * measured 9 recorded reports out of 48 written since the tool shipped. Before
 * the sandbox allowlist landed, the rule's own fallback explains most of that —
 * `thread prepare` printed SANDBOX DENIED and the agent correctly wrote text
 * instead. After it, the failure mode changed shape: four of five report-ending
 * sessions never called `thread prepare` AT ALL, with the rule text sitting in
 * the transcript. A rule that is read and not followed needs something
 * deterministic behind it, and Stop is the only event that fires exactly when a
 * report has been written and not yet handed over.
 *
 * WHAT IT DECIDES. Exactly one thing: the turn's final assistant text LOOKS like
 * a status report (the 🛑 run above it and the 🕉️ run below it) and this
 * session has archived no report since Justin's last message. Everything else
 * passes. It never reads the bead store, never runs bd, and never writes
 * anything except its own one-byte marker.
 *
 * THE CONTRACT, VERIFIED 2026-09-14 against https://code.claude.com/docs/en/hooks.md
 * (quoted in p1uj.15's notes):
 *
 *  - stdin JSON carries `session_id`, `prompt_id`, `transcript_path`, `cwd`,
 *    `hook_event_name`, `last_assistant_message`, `stop_hook_active`, and
 *    `agent_id`/`agent_type` ONLY when the hook fires inside a subagent.
 *  - "`last_assistant_message`: Text of the final assistant message in this
 *    turn, available on `Stop` and `SubagentStop` hooks so you can inspect what
 *    Claude just said before deciding whether to let it stop." The transcript
 *    file lags the in-memory turn, so the final text comes from HERE and never
 *    from the transcript.
 *  - Exit 2 on Stop: "Prevents Claude from stopping, continues the conversation.
 *    Stderr shown to Claude as a system message." And: "exit 2 blocks whether or
 *    not you print JSON … Claude Code still reads any valid JSON output on
 *    stdout."
 *  - JSON: "A `Stop` or `SubagentStop` hook can return `"decision": "block"`
 *    with `"reason"` to prevent Claude from finishing and force another turn.
 *    When a Stop hook blocks, Claude Code sets `stop_hook_active: true` on the
 *    next `Stop` hook input to help you avoid infinite loops… If a hook blocks
 *    and you want Claude to see context about why, use `systemMessage` or
 *    `additionalContext` instead of relying on the reason alone, since the
 *    blocking reason is for Claude Code's internal logging and doesn't reach the
 *    model unless you repeat it in a message field."
 *
 * So a block is all three at once: exit 2, the reason on stderr (the documented
 * channel that reaches the model), and the JSON decision on stdout with the same
 * text repeated in `systemMessage` (the documented channel for the case where a
 * future version prefers JSON to stderr). The duplication is deliberate and
 * costs one repeated sentence; the alternative is a blocked turn that cannot see
 * why it was blocked, which would be a loop.
 *
 * EVERY WAY THIS PASSES. The knob is off; the payload is a subagent's; Claude
 * Code already told us we blocked this turn; our own marker says we blocked this
 * turn; the text is not a report; the session id is missing; the transcript
 * could not be read; the archive could not be read; the archive is newer than
 * Justin's last message; the marker could not be written. Nine of those ten are
 * ordinary, and one — "the marker could not be written" — is the rule-6 guard:
 * a block we cannot stop ourselves from repeating is not a block worth making.
 *
 * IT MUST FAIL SOFT EVERYWHERE. The hook is installed per repo in
 * `.claude/settings.json`, which travels to cloud and web sessions where there
 * is no justin-sdk on PATH and no way to record a report at all. A `bunx` that
 * cannot resolve the package exits non-zero with its own message — NOT 2 — so
 * nothing is blocked, which is the behaviour those sessions need. Inside this
 * process the same rule holds: every unexpected throw returns 0.
 */

import {readFileSync} from 'fs';

import {resolveThreadConfig} from './config';
import {newestArchivedReportAt, stopMarkExists, writeStopMark} from './archive';
import {findTranscript, scanTranscriptForThread} from './facts';

import type {ArchiveProbe} from './archive';
import type {EnvLike} from './paths';

/**
 * How many delimiter glyphs in a row count as a report rule line.
 *
 * Three, not one: the template prints 28 and 29 of them, so any real report
 * clears this easily, while a single 🛑 is ordinary prose ("🛑 Blocked on you"
 * is a stop-reason badge that appears mid-report and in plenty of messages that
 * are not reports). The asymmetry decides the number — a false positive blocks a
 * turn that did nothing wrong, a false negative merely leaves today's behaviour
 * in place.
 */
export const RULE_RUN_MIN = 3;

const LEADING_RULE = new RegExp(`^\\s*🛑{${RULE_RUN_MIN},}`, 'u');
const TRAILING_RULE = new RegExp(`(?:🕉️){${RULE_RUN_MIN},}\\s*$`, 'u');

/**
 * Does this text carry the status report's delimiters?
 *
 * BOTH ends are required. The top rule alone appears on any message that opens
 * with the stop-reason banner; the pair is what the template mandates and what
 * every renderer emits, so requiring both is the conservative test.
 *
 * Note what this deliberately does NOT look at: the `Answer: justin-sdk thread
 * answer <id>` line that a recorded report contains. That line is text like any
 * other and a hand-written report can copy it, so it proves nothing. The proof
 * is the archive timestamp, below.
 */
export function looksLikeStatusReport(text: string | null): boolean {
  if (text == null || text === '') return false;
  return LEADING_RULE.test(text) && TRAILING_RULE.test(text);
}

/**
 * Which branch decided.
 *
 * The first ten are `decideStopCheck`'s own returns, one each. The last three
 * belong to the IO wrapper and exist so a failure can never borrow another
 * branch's name: "the payload was unreadable", "the loop guard could not be
 * written" and "something threw" all pass, but they are three different facts
 * and reporting any of them as `archiveUnknown` would be the exact conflation
 * rule 6 forbids.
 */
export type StopCheckWhy =
  | 'knobOff'
  | 'subagent'
  | 'stopHookActive'
  | 'markerPresent'
  | 'notAReport'
  | 'noSessionId'
  | 'lastUserMessageUnknown'
  | 'archiveUnknown'
  | 'archiveNewer'
  | 'notRecorded'
  | 'unreadablePayload'
  | 'markerWriteFailed'
  | 'internalFailure';

export interface StopCheckInputs {
  /** Present only for a subagent's Stop. Its presence is the role discriminant. */
  agentId: string | null;
  /**
   * When this session last archived a report. Three states on purpose — see
   * `ArchiveProbe`.
   */
  archive: ArchiveProbe;
  /** `componentConfig.thread.enforce`. False is the default and passes always. */
  enforce: boolean;
  /** `last_assistant_message` from the payload, never the transcript. */
  lastAssistantMessage: string | null;
  /**
   * Epoch ms of Justin's last message in this transcript, or null for "could not
   * measure" — which passes. The IO boundary converts an unparseable timestamp
   * to null, and this function re-checks with `Number.isFinite` so a NaN cannot
   * arrive dressed as a measurement.
   */
  lastUserMessageAt: number | null;
  /** Have we already blocked this exact turn? */
  markerExists: boolean;
  /** Null when there is no session id to key anything by. */
  sessionId: string | null;
  /** Claude Code's own loop guard: a Stop hook already blocked this turn. */
  stopHookActive: boolean;
}

export interface StopCheckDecision {
  action: 'block' | 'pass';
  /** The one line Claude is shown. Null on every pass. */
  reason: string | null;
  why: StopCheckWhy;
}

/** The one line a blocked turn is shown, in both channels. */
export const STOP_CHECK_BLOCK_REASON =
  'This report was not recorded; run justin-sdk thread prepare then thread report --file and paste its output.';

/**
 * The whole decision, as a pure function. No filesystem, no clock, no env.
 *
 * ORDER IS LOAD-BEARING. `enforce` is tested first so that the knob being off is
 * a guarantee rather than a likelihood — no later branch can reach a block past
 * it. The subagent test is second for the same reason (a player must never be
 * held at its own Stop; it has no thread of its own to record). The two loop
 * guards come next, before any measurement, because a second block on one turn
 * is worse than every problem this hook exists to fix.
 */
export function decideStopCheck(inputs: StopCheckInputs): StopCheckDecision {
  const pass = (why: StopCheckWhy): StopCheckDecision => ({
    action: 'pass',
    reason: null,
    why,
  });

  if (!inputs.enforce) return pass('knobOff');
  if (inputs.agentId != null && inputs.agentId !== '') return pass('subagent');
  if (inputs.stopHookActive) return pass('stopHookActive');
  if (inputs.markerExists) return pass('markerPresent');
  if (!looksLikeStatusReport(inputs.lastAssistantMessage))
    return pass('notAReport');
  if (inputs.sessionId == null || inputs.sessionId === '')
    return pass('noSessionId');

  const lastUserMessageAt = inputs.lastUserMessageAt;
  if (lastUserMessageAt == null || !Number.isFinite(lastUserMessageAt))
    return pass('lastUserMessageUnknown');

  if (inputs.archive.kind === 'unknown') return pass('archiveUnknown');
  if (
    inputs.archive.kind === 'newest' &&
    inputs.archive.at >= lastUserMessageAt
  ) {
    return pass('archiveNewer');
  }

  return {
    action: 'block',
    reason: STOP_CHECK_BLOCK_REASON,
    why: 'notRecorded',
  };
}

/** One human-readable line per branch, for `--explain` and the debug log. */
export function describeStopCheck(decision: StopCheckDecision): string {
  switch (decision.why) {
    case 'knobOff':
      return 'pass: componentConfig.thread.enforce is off';
    case 'subagent':
      return 'pass: subagent Stop (agent_id present)';
    case 'stopHookActive':
      return 'pass: stop_hook_active — a Stop hook already blocked this turn';
    case 'markerPresent':
      return 'pass: already blocked this turn (marker present)';
    case 'notAReport':
      return 'pass: the final message is not a status report';
    case 'noSessionId':
      return 'pass: no session_id in the payload';
    case 'lastUserMessageUnknown':
      return 'pass: UNKNOWN — could not read the last user message timestamp';
    case 'archiveUnknown':
      return 'pass: UNKNOWN — could not read this session’s report archive';
    case 'archiveNewer':
      return 'pass: a report was archived after the last user message';
    case 'notRecorded':
      return 'BLOCK: a report was written but none was archived for this turn';
    case 'unreadablePayload':
      return 'pass: the hook payload was missing or was not JSON';
    case 'markerWriteFailed':
      return 'pass: the loop guard could not be written, so a block was withheld';
    case 'internalFailure':
      return 'pass: the check threw';
  }
}

// ---------------------------------------------------------------------------
// The IO wrapper
// ---------------------------------------------------------------------------

/** The Stop payload, as much of it as this hook reads. */
interface StopHookInput {
  agent_id?: string | null;
  cwd?: string;
  last_assistant_message?: string | null;
  prompt_id?: string | null;
  session_id?: string | null;
  stop_hook_active?: boolean;
  transcript_path?: string | null;
}

/** Epoch ms of an ISO timestamp, or null when it is absent or unparseable. */
export function epochMs(iso: string | null | undefined): number | null {
  if (iso == null || iso === '') return null;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface StopCheckRunResult {
  decision: StopCheckDecision;
  /** Wall time of the whole run, ms. Printed by `--explain` (AC: under 500). */
  elapsedMs: number;
  exitCode: number;
}

/**
 * Measure the last user message's timestamp for this session.
 *
 * Prefers the payload's `transcript_path` and falls back to the by-session-id
 * search, which is what `facts.ts` exists for — a transcript follows its session
 * into a worktree, so the path in the payload is the cheap answer and the search
 * is the correct one.
 *
 * Null means UNKNOWN in every failing case, and the caller passes on it.
 */
function measureLastUserMessageAt(
  sessionId: string,
  transcriptPath: string | null,
  env: EnvLike,
): {at: number | null; error: string | null} {
  let path = transcriptPath;
  if (path == null || path === '') {
    const lookup = findTranscript(sessionId, env);
    if (lookup.status !== 'found') {
      return {
        at: null,
        error:
          lookup.status === 'failed'
            ? lookup.error
            : `no transcript for ${sessionId} under ${lookup.searched}`,
      };
    }
    path = lookup.path;
  }
  try {
    const at = epochMs(scanTranscriptForThread(path).lastUserMessageAt);
    return {at, error: at == null ? `no user message in ${path}` : null};
  } catch (error) {
    return {
      at: null,
      error: `read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Run the hook. ALWAYS resolves; never throws.
 *
 * Returns 0 with nothing on stdout on every pass. Returns 2 on a block, with the
 * reason on stderr and the JSON decision on stdout — see the file header for why
 * both.
 */
export function runThreadStopCheck(args?: {
  env?: EnvLike;
  explain?: boolean;
  stdin?: string;
}): StopCheckRunResult {
  const started = Date.now();
  const env = args?.env ?? process.env;
  const explain = args?.explain === true;

  const finish = (
    decision: StopCheckDecision,
    exitCode: number,
  ): StopCheckRunResult => {
    const elapsedMs = Date.now() - started;
    if (explain) {
      console.error(`[thread stop-check] ${describeStopCheck(decision)}`);
      console.error(`[thread stop-check] ${elapsedMs}ms`);
    }
    return {decision, elapsedMs, exitCode};
  };

  let input: StopHookInput = {};
  try {
    const raw = args?.stdin ?? readFileSync(0, 'utf8');
    input = raw.trim() === '' ? {} : (JSON.parse(raw) as StopHookInput);
  } catch {
    // An unreadable or malformed payload is not evidence of anything. Pass.
    return finish({action: 'pass', reason: null, why: 'unreadablePayload'}, 0);
  }

  try {
    const sessionId = input.session_id ?? null;
    const agentId = input.agent_id ?? null;
    const stopHookActive = input.stop_hook_active === true;
    const lastAssistantMessage = input.last_assistant_message ?? null;

    // The knob and the subagent test come before ANY filesystem work, so the
    // overwhelmingly common Stop — knob off, or a player finishing — costs one
    // config read and nothing else.
    const enforce = resolveThreadConfig({cwd: input.cwd, env}).enforce;
    const cheap = decideStopCheck({
      agentId,
      archive: {error: 'not measured yet', kind: 'unknown'},
      enforce,
      lastAssistantMessage,
      lastUserMessageAt: null,
      markerExists: false,
      sessionId,
      stopHookActive,
    });
    // Fed a deliberately unmeasured archive and no timestamp, `decideStopCheck`
    // can only return one of its pre-measurement branches or the sentinel
    // `lastUserMessageUnknown`, which is the one that means "keep going" — the
    // marker and archive branches sit behind it. So the sentinel is the ONLY
    // thing that falls through, and any branch added ahead of it later
    // short-circuits here automatically instead of being forgotten.
    if (cheap.why !== 'lastUserMessageUnknown') return finish(cheap, 0);

    // Past here the text IS a report, the knob is on, and we have a session id.
    const id = sessionId as string;
    const turnKey = input.prompt_id ?? null;

    const measured = measureLastUserMessageAt(
      id,
      input.transcript_path ?? null,
      env,
    );
    const archive = newestArchivedReportAt(id, env);

    // The turn's identity: `prompt_id` when Claude Code supplies it (it is the
    // turn's own id), else the last user message timestamp, which changes for
    // exactly the same reason. Both absent is unreachable — a null timestamp
    // passes below before the marker is ever needed.
    const key = turnKey ?? String(measured.at ?? '');
    const markerExists = key === '' ? false : stopMarkExists(id, key, env);

    const decision = decideStopCheck({
      agentId,
      archive,
      enforce,
      lastAssistantMessage,
      lastUserMessageAt: measured.at,
      markerExists,
      sessionId,
      stopHookActive,
    });

    if (explain) {
      if (measured.error != null) {
        console.error(`[thread stop-check] transcript: ${measured.error}`);
      }
      if (archive.kind === 'unknown') {
        console.error(`[thread stop-check] archive: ${archive.error}`);
      }
    }

    if (decision.action === 'pass') return finish(decision, 0);

    // A block is only allowed once we can PROVE we will not repeat it. The
    // marker is written first; if it cannot be written we pass instead, because
    // a session wedged in a block loop is a far worse outcome than a report that
    // went unrecorded.
    const mark = writeStopMark(id, key, env);
    if (!mark.ok) {
      console.error(
        `[thread stop-check] not blocking: could not write the loop guard at ${mark.path} (${mark.error})`,
      );
      return finish(
        {action: 'pass', reason: null, why: 'markerWriteFailed'},
        0,
      );
    }

    const reason = decision.reason ?? STOP_CHECK_BLOCK_REASON;
    console.log(
      JSON.stringify({decision: 'block', reason, systemMessage: reason}),
    );
    console.error(reason);
    return finish(decision, 2);
  } catch (error) {
    // Nothing this hook can fail at is worth holding a session for.
    console.error(
      `[thread stop-check] unexpected failure, nothing blocked: ${error instanceof Error ? error.message : String(error)}`,
    );
    return finish({action: 'pass', reason: null, why: 'internalFailure'}, 0);
  }
}
