/**
 * usage-check — a hook that tells a session how much CONTEXT it has used.
 *
 * "Usage" here means THIS SESSION'S OWN TOKEN CONSUMPTION — the size of the
 * conversation currently in the model's context window. It is NOT the quota
 * percentage that `/usage` and `ralph`'s usage gate report; those measure how
 * much of Justin's subscription allowance is left, which is a completely
 * different number. Nothing in this file talks to the server.
 *
 * WHY: a session cannot see its own context size. The model has no reliable
 * sense of how full the window is, yet the wind-down contract (conductor,
 * mayor, ralph) depends on knowing — a handoff written at 90% is a good
 * handoff, one written at 100% never gets written at all. The statusline shows
 * Justin a percentage, but the model never sees the statusline.
 *
 * WHERE THE NUMBER COMES FROM: every assistant entry in the transcript carries
 * `message.usage`, and the context size of that API call is
 *   input_tokens + cache_creation_input_tokens + cache_read_input_tokens
 * (verified live 2026-08-20 against a running session and cross-checked with
 * the statusline). The hook input carries no context figure of its own —
 * exposing one is still an open request upstream (anthropics/claude-code
 * #25689, #27969, #44790) — so the transcript is the only source.
 *
 * TWO EVENTS, one script (both verified injecting in CC 2.1.238):
 *   - UserPromptSubmit — fires when Justin sends a message.
 *   - PostToolBatch — fires ONCE after each batch of tool calls resolves,
 *     "before the next model request" (Claude Code's own words). This is the
 *     event that matters for autonomous work, where a single turn can run for
 *     hours and UserPromptSubmit never fires at all.
 * PostToolUse was rejected deliberately: it fires per-tool AND runs
 * CONCURRENTLY for parallel tool calls, so two copies would each read the
 * transcript before either had written its marker and both would announce the
 * same setpoint. PostToolBatch has neither problem.
 *
 * STATE IS DERIVED FROM THE TRANSCRIPT, never from a state file — time-check's
 * rationale applies unchanged: a state file desyncs on resume, on another
 * machine, or when the state dir is cleared, and it fails silently when it
 * does. Our own notices carry a machine-readable `setpoint=<n>` token, so the
 * most recent one tells us exactly where the ladder stands.
 *
 * THE RE-ARM RULE (context can SHRINK — auto-compaction can drop a 300k
 * session to 60k, and after that the setpoints must fire again):
 *   Only the MOST RECENT notice matters. Let C be the current context and S the
 *   setpoint that notice named. We announce the highest setpoint <= C when:
 *     - there is no previous notice (first crossing), or
 *     - C has reached the next setpoint ABOVE S (ordinary ascent), or
 *     - C has fallen more than `reArmDropFraction` (default 25%) below S,
 *       which is read as a compaction and re-arms the whole ladder.
 *   A drop that small enough to stay within the fraction is treated as noise
 *   and changes nothing. Re-arming cannot chatter: the notice it emits names a
 *   setpoint <= C, so the very next evaluation sees S <= C and neither branch
 *   fires again.
 *
 * @see home-base-1r6d.1
 */

import {closeSync, openSync, readFileSync, readSync, statSync} from 'fs';
import {resolve} from 'path';

/** Marks our own output so a later run can find it in the transcript. */
export const USAGE_CHECK_MARKER = '[Automated Usage Check]';

/**
 * The machine-readable half of a notice. This is the component's entire
 * persistence layer — reword the prose around it freely, but never emit a
 * notice without it and never change its shape without changing the parser.
 */
const SETPOINT_TOKEN = /setpoint=(\d+)/;

/** The key under `componentConfig` in justin-sdk.config.json. */
export const USAGE_CHECK_CONFIG_KEY = 'usage-check';

/** The wrap-up directive, in Justin's words (home-base-1r6d.1, D5 REVISED). */
export const WRAP_UP_DIRECTIVE =
  'Wrap up your session at the next available opportunity. Follow the handoff/ralph-handoff protocol.';

export interface UsageCheckConfig {
  enabled?: boolean;
  /** Ascending token thresholds; each announces once. null/absent disables. */
  setpoints?: number[] | null;
  /**
   * At or above this context size the notice adds WRAP_UP_DIRECTIVE. Keyed off
   * the measured context rather than the announced setpoint, so it still fires
   * when it sits between two setpoints. null/absent means never nag.
   */
  wrapUpAt?: number | null;
  /** Fractional drop below the last announced setpoint that re-arms the ladder. */
  reArmDropFraction?: number;
}

/**
 * Written into a project's config when the component is installed. A project
 * with NO config is treated as disabled (see resolveUsageCheckConfig), so these
 * only ever apply where the component was deliberately added.
 *
 * Typed explicitly rather than as `Required<UsageCheckConfig>`: `Required` only
 * strips optionality, so the null halves of the config's own union would
 * survive into the defaults and make `setpoints` un-iterable at every call
 * site. The defaults are exactly the values that are always present.
 */
export const USAGE_CHECK_DEFAULTS: {
  enabled: boolean;
  reArmDropFraction: number;
  setpoints: number[];
  wrapUpAt: number;
} = {
  enabled: true,
  reArmDropFraction: 0.25,
  setpoints: [150_000, 200_000, 250_000, 300_000, 400_000, 500_000],
  wrapUpAt: 300_000,
};

export interface ResolvedUsageCheckConfig {
  /** Ascending, deduped, and guaranteed to contain wrapUpAt (see below). */
  setpoints: number[];
  wrapUpAt: number | null;
  reArmDropFraction: number;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Read `componentConfig["usage-check"]` from justin-sdk.config.json.
 *
 * Returns null when the file, the section, or the key is absent — meaning
 * "disabled". Absence is the safe default: this hook runs after every tool
 * batch, so a project that never opted in must pay nothing and say nothing.
 *
 * Deliberately reads the file itself rather than importing setup-helpers'
 * readJson: this is the hot path of a hook that runs many times per turn, and
 * setup-helpers drags in the installer machinery. Same reason time-check
 * imports nothing but `fs` and `path`.
 */
export function readUsageCheckConfig(
  projectRoot: string,
): UsageCheckConfig | null {
  let raw: string;
  try {
    raw = readFileSync(resolve(projectRoot, 'justin-sdk.config.json'), 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // A malformed config must not break the user's prompt.
  }

  const config = parsed as {componentConfig?: Record<string, unknown>};
  const section = config.componentConfig?.[USAGE_CHECK_CONFIG_KEY];
  if (section == null || typeof section !== 'object') {
    return null;
  }
  return section as UsageCheckConfig;
}

/**
 * Merge a project's config over the defaults and normalize the ladder.
 *
 * `wrapUpAt` is folded INTO the setpoints. Without that, a config whose
 * wrapUpAt sits between two setpoints would cross the wrap-up threshold
 * without any notice being due, and the directive would never be said — a
 * silent, config-shaped way to lose the one message that matters most.
 *
 * Returns null when the component is absent, disabled, or left with an empty
 * ladder (nothing could ever fire, so say so by returning the same "off" value
 * rather than a config that silently does nothing).
 */
export function resolveUsageCheckConfig(
  config: UsageCheckConfig | null,
): ResolvedUsageCheckConfig | null {
  if (config == null || config.enabled === false) {
    return null;
  }

  const rawSetpoints =
    config.setpoints === undefined
      ? USAGE_CHECK_DEFAULTS.setpoints
      : config.setpoints;
  const wrapUpAt =
    config.wrapUpAt === undefined
      ? USAGE_CHECK_DEFAULTS.wrapUpAt
      : config.wrapUpAt;
  const reArmDropFraction =
    typeof config.reArmDropFraction === 'number' &&
    Number.isFinite(config.reArmDropFraction) &&
    config.reArmDropFraction > 0 &&
    config.reArmDropFraction < 1
      ? config.reArmDropFraction
      : USAGE_CHECK_DEFAULTS.reArmDropFraction;

  const ladder = new Set<number>();
  for (const value of Array.isArray(rawSetpoints) ? rawSetpoints : []) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      ladder.add(Math.floor(value));
    }
  }
  if (typeof wrapUpAt === 'number' && Number.isFinite(wrapUpAt) && wrapUpAt > 0) {
    ladder.add(Math.floor(wrapUpAt));
  }
  if (ladder.size === 0) {
    return null;
  }

  return {
    reArmDropFraction,
    setpoints: [...ladder].sort((a, b) => a - b),
    wrapUpAt:
      typeof wrapUpAt === 'number' && Number.isFinite(wrapUpAt) && wrapUpAt > 0
        ? Math.floor(wrapUpAt)
        : null,
  };
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

export interface TranscriptFacts {
  /**
   * Current context size in tokens, or null when it could NOT be measured.
   * Null never means zero — a session with no measurable usage and a session
   * whose transcript we failed to read are different facts, and only one of
   * them is safe to reason about.
   */
  contextTokens: number | null;
  /** The setpoint named by our most recent notice, or null. */
  lastAnnouncedSetpoint: number | null;
  /**
   * Whether the scan reached the START of the transcript. This is what makes
   * `lastAnnouncedSetpoint: null` interpretable: with reachedStart true it
   * means "there is no prior notice"; with it false it means "we stopped
   * looking", which is not the same claim at all.
   */
  reachedStart: boolean;
}

interface TailWindow {
  text: string;
  reachedStart: boolean;
}

/**
 * Read the last `windowBytes` of a file.
 *
 * Transcripts get large — a real 44MB one measured here holds only 1,584 lines
 * (28KB per line), and reading it whole costs 39ms against 1.0ms for a 1MB
 * tail. Since a hook on PostToolBatch runs once per model request, the tail is
 * the difference between free and noticeable.
 *
 * When the window does not reach the start of the file its first line is
 * dropped: it is a partial line, and it is also the only place a multi-byte
 * character could have been sliced in half.
 *
 * Returns null on any I/O failure — the caller must not confuse that with an
 * empty transcript.
 */
function readTailWindow(path: string, windowBytes: number): TailWindow | null {
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - windowBytes);
    const reachedStart = start === 0;
    const length = size - start;
    if (length === 0) {
      return {reachedStart: true, text: ''};
    }

    const fd = openSync(path, 'r');
    let text: string;
    try {
      const buf = Buffer.alloc(length);
      const read = readSync(fd, buf, 0, length, start);
      text = buf.subarray(0, read).toString('utf8');
    } finally {
      closeSync(fd);
    }

    if (!reachedStart) {
      const firstBreak = text.indexOf('\n');
      text = firstBreak === -1 ? '' : text.slice(firstBreak + 1);
    }
    return {reachedStart, text};
  } catch {
    return null;
  }
}

/**
 * The context size an assistant entry's usage block describes, or null.
 *
 * A missing cache field genuinely means zero cached tokens (an uncached first
 * call reports neither), so those default to 0. A missing or non-numeric
 * `input_tokens` is different in kind — that is a shape we do not understand,
 * and guessing would fabricate a context reading — so it yields null.
 */
export function contextTokensFromUsage(usage: unknown): number | null {
  if (usage == null || typeof usage !== 'object') {
    return null;
  }
  const fields = usage as Record<string, unknown>;
  const input = fields.input_tokens;
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    return null;
  }

  let total = input;
  for (const key of ['cache_creation_input_tokens', 'cache_read_input_tokens']) {
    const value = fields[key];
    if (value == null) {
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return null;
    }
    total += value;
  }
  return total;
}

/** Every string an attachment's `content` field might be carrying. */
function attachmentStrings(entry: Record<string, unknown>): string[] {
  const attachment = entry.attachment as {content?: unknown} | undefined;
  const content = attachment?.content;
  if (typeof content === 'string') {
    return [content];
  }
  if (Array.isArray(content)) {
    return content.filter((part): part is string => typeof part === 'string');
  }
  return [];
}

interface ScanState {
  contextTokens: number | null;
  lastAnnouncedSetpoint: number | null;
}

/**
 * Scan one window of transcript text backwards, filling in whatever is still
 * unknown. Mutates `state` so successive (larger) windows can extend a scan.
 *
 * Two entry shapes matter, both verified against real transcripts:
 *   - assistant entries carry `message.usage`.
 *   - our own notices land as `type: "attachment"`, where the model-facing copy
 *     is `attachment.type "hook_additional_context"` with content as a STRING
 *     ARRAY and the Justin-facing copy is `"hook_system_message"` with content
 *     as a STRING. Either dates the notice equally, so both are accepted and
 *     `hookEvent` is deliberately NOT filtered on — we now fire from two
 *     different events, and a filter would have to be updated for a third.
 */
function scanWindow(text: string, state: ScanState): void {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (state.contextTokens != null && state.lastAnnouncedSetpoint != null) {
      return;
    }
    const line = lines[i];
    if (line == null || line.length === 0) {
      continue;
    }

    // Cheap pre-filter: skip JSON.parse for lines that can't be either target.
    const maybeAssistant =
      state.contextTokens == null && line.includes('"assistant"');
    const maybeNotice =
      state.lastAnnouncedSetpoint == null && line.includes(USAGE_CHECK_MARKER);
    if (!maybeAssistant && !maybeNotice) {
      continue;
    }

    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // A partially-written trailing line is normal on a live file.
    }

    // A subagent's context is not this session's. Current Claude Code writes
    // sidechains to a separate file, but older versions inlined them and this
    // costs one comparison.
    if (entry.isSidechain === true) {
      continue;
    }

    if (maybeAssistant && entry.type === 'assistant') {
      const message = entry.message as {usage?: unknown} | undefined;
      const tokens = contextTokensFromUsage(message?.usage);
      if (tokens != null) {
        state.contextTokens = tokens;
      }
    }

    if (maybeNotice && entry.type === 'attachment') {
      for (const content of attachmentStrings(entry)) {
        if (!content.includes(USAGE_CHECK_MARKER)) {
          continue;
        }
        const match = SETPOINT_TOKEN.exec(content);
        if (match?.[1] != null) {
          state.lastAnnouncedSetpoint = Number(match[1]);
          break;
        }
      }
    }
  }
}

/** The window the escalating scan starts from, and its growth cap per step. */
const INITIAL_WINDOW_BYTES = 1024 * 1024;

/**
 * Read the transcript tail, growing the window until the facts are known or
 * the file is exhausted.
 *
 * The hunt for a prior notice is skipped entirely when the measured context is
 * below the lowest setpoint, because no notice could be due either way. That
 * matters: the one case that can force a full-file read is a session that has
 * never announced, and it terminates immediately — with the context above the
 * lowest setpoint and no prior notice, a notice is ALWAYS due, so the marker
 * lands near the tail and every later call is a 1MB read again.
 */
export function readTranscriptFacts(args: {
  transcriptPath: string;
  lowestSetpoint: number;
  initialWindowBytes?: number;
}): TranscriptFacts {
  const state: ScanState = {contextTokens: null, lastAnnouncedSetpoint: null};
  let windowBytes = args.initialWindowBytes ?? INITIAL_WINDOW_BYTES;
  let reachedStart = false;

  for (;;) {
    const window = readTailWindow(args.transcriptPath, windowBytes);
    if (window == null) {
      // I/O failure: report what we have, and that we did NOT reach the start.
      return {...state, reachedStart: false};
    }
    reachedStart = window.reachedStart;
    scanWindow(window.text, state);

    const needContext = state.contextTokens == null;
    const needSetpoint =
      state.lastAnnouncedSetpoint == null &&
      state.contextTokens != null &&
      state.contextTokens >= args.lowestSetpoint;
    if (reachedStart || (!needContext && !needSetpoint)) {
      return {...state, reachedStart};
    }
    windowBytes *= 2;
  }
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export type FireReason = 'first' | 'ascend' | 're-arm';

export interface UsageDecision {
  /** The setpoint being announced: the highest one at or below the context. */
  setpoint: number;
  contextTokens: number;
  /** Whether to append WRAP_UP_DIRECTIVE. */
  wrapUp: boolean;
  reason: FireReason;
}

function highestAtOrBelow(setpoints: number[], value: number): number | null {
  let best: number | null = null;
  for (const setpoint of setpoints) {
    if (setpoint <= value) {
      best = setpoint;
    }
  }
  return best;
}

function lowestAbove(setpoints: number[], value: number): number | null {
  for (const setpoint of setpoints) {
    if (setpoint > value) {
      return setpoint;
    }
  }
  return null;
}

/**
 * Decide whether a notice is due. See the file header for the re-arm rule.
 *
 * Returns null (silent) whenever the context has not reached the lowest
 * setpoint, when the ladder has not advanced, and when a shrink is too small
 * to read as a compaction.
 */
export function decide(args: {
  config: ResolvedUsageCheckConfig;
  contextTokens: number;
  lastAnnouncedSetpoint: number | null;
}): UsageDecision | null {
  const {config, contextTokens, lastAnnouncedSetpoint} = args;
  const setpoint = highestAtOrBelow(config.setpoints, contextTokens);
  if (setpoint == null) {
    return null;
  }

  const wrapUp = config.wrapUpAt != null && contextTokens >= config.wrapUpAt;
  const fire = (reason: FireReason): UsageDecision => ({
    contextTokens,
    reason,
    setpoint,
    wrapUp,
  });

  if (lastAnnouncedSetpoint == null) {
    return fire('first');
  }

  const nextUp = lowestAbove(config.setpoints, lastAnnouncedSetpoint);
  if (nextUp != null && contextTokens >= nextUp) {
    return fire('ascend');
  }

  if (contextTokens < lastAnnouncedSetpoint * (1 - config.reArmDropFraction)) {
    return fire('re-arm');
  }

  return null;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Thousands separators, hand-rolled. `toLocaleString` would drag in ICU
 * behaviour that varies by runtime and locale, and this needs to be identical
 * everywhere so the tests mean something.
 */
export function formatTokens(value: number): string {
  const digits = Math.round(value).toString();
  const parts: string[] = [];
  for (let end = digits.length; end > 0; end -= 3) {
    parts.unshift(digits.slice(Math.max(0, end - 3), end));
  }
  return parts.join(',');
}

/**
 * The notice. The first line carries the marker AND the machine-readable
 * `setpoint=` token that a later run reads back as state — see SETPOINT_TOKEN.
 *
 * "of context" is load-bearing wording: elsewhere in this SDK "usage" means
 * subscription QUOTA (`/usage`, ralph's usage gate), and the two numbers must
 * never be mistaken for each other.
 */
export function formatNotice(decision: UsageDecision): string {
  const first = `${USAGE_CHECK_MARKER} This session has now used ${formatTokens(
    decision.contextTokens,
  )} tokens of context (setpoint=${decision.setpoint}).`;
  return decision.wrapUp ? `${first}\n${WRAP_UP_DIRECTIVE}` : first;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

interface HookInput {
  cwd?: string;
  transcript_path?: string;
  hook_event_name?: string;
}

/** The events this hook is wired to; anything else still echoes its own name. */
const DEFAULT_HOOK_EVENT = 'UserPromptSubmit';

/**
 * Run the hook. Always resolves 0 — a failing UserPromptSubmit hook can block
 * the prompt entirely, so every path here degrades to silence rather than
 * costing Justin a turn.
 *
 * On unmeasurable state (unreadable transcript, or a prior notice we could not
 * find because reads failed mid-scan) this stays SILENT rather than announcing.
 * That is the opposite of the usual "route missing evidence to the cautious
 * verdict" instinct, and it is deliberate: announcing on unknown state would
 * repeat on every tool batch for the rest of the session — unbounded spam that
 * would train Justin to ignore the one message that matters. A missed nudge
 * self-corrects at the next setpoint or the next successful read. The unknown
 * state is also near-unreachable, since the same failed read would already have
 * left the context unmeasured.
 */
export function runUsageCheck(args?: {stdin?: string}): number {
  let input: HookInput = {};
  try {
    const raw = args?.stdin ?? readFileSync(0, 'utf8');
    input = raw.trim() === '' ? {} : (JSON.parse(raw) as HookInput);
  } catch {
    return 0;
  }

  const projectRoot = input.cwd ?? process.cwd();
  const config = resolveUsageCheckConfig(readUsageCheckConfig(projectRoot));
  if (config == null) {
    return 0; // Not installed here, or explicitly disabled.
  }

  if (input.transcript_path == null || input.transcript_path === '') {
    return 0;
  }

  const facts = readTranscriptFacts({
    lowestSetpoint: config.setpoints[0] as number,
    transcriptPath: input.transcript_path,
  });
  if (facts.contextTokens == null) {
    return 0;
  }
  if (facts.lastAnnouncedSetpoint == null && !facts.reachedStart) {
    return 0; // State unknown — see the doc comment.
  }

  const decision = decide({
    config,
    contextTokens: facts.contextTokens,
    lastAnnouncedSetpoint: facts.lastAnnouncedSetpoint,
  });
  if (decision == null) {
    return 0;
  }

  const notice = formatNotice(decision);

  // Emit BOTH channels, exactly as time-check does and for the same reason:
  // `systemMessage` renders in Justin's terminal but never enters the model's
  // context, while `additionalContext` goes to the model and is invisible to
  // Justin. The model is the one that has to act on this; Justin is the one who
  // needs to know why it suddenly started wrapping up.
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        additionalContext: notice,
        hookEventName: input.hook_event_name ?? DEFAULT_HOOK_EVENT,
      },
      systemMessage: notice,
    }),
  );
  return 0;
}
