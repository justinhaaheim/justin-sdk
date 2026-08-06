/**
 * time-check — a UserPromptSubmit hook that gives the transcript a clock.
 *
 * WHY: a transcript has no wall-clock. The system prompt carries the date at
 * session start, but a long-running or resumed conversation can span weeks
 * while every message sits flush against the last one in context. The model
 * then reads "earlier in this conversation" as "earlier today". That is not
 * hypothetical — on 2026-08-05 it produced the claim that nine days of terminal
 * tab growth had happened "in the last hour", in a thread begun 2026-07-20.
 *
 * NOT the same thing as ~/.claude/scripts/timestamp-hook.sh, which emits
 * `{systemMessage}` — that renders for JUSTIN and never enters the model's
 * context. This writes plain stdout, which for UserPromptSubmit IS injected
 * into the model's context. Both can coexist; they serve different readers.
 *
 * TWO INDEPENDENT TRIGGERS, fired on either (they answer different questions):
 *   - gapHours — spacing BETWEEN messages. Marks genuine discontinuities,
 *     which is what actually corrupts the model's sense of time.
 *   - notifyOnNewDayBoundaryHour — guarantees AT LEAST one stamp per working
 *     day. Without it a steady drip of messages just under `gapHours` could run
 *     for weeks and never once print a date.
 *
 * STATE IS DERIVED FROM THE TRANSCRIPT, never from a state file: a state file
 * desyncs on resume, on another machine, or when the state dir is cleared,
 * and it fails silently when it does. The transcript is the ground truth we
 * are describing, so we read it directly.
 */

import {readFileSync} from 'fs';
import {resolve} from 'path';

/** Marks our own output so a later run can find it in the transcript. */
export const TIME_CHECK_MARKER = '[Automated Time Check]';

/** The key under `componentConfig` in justin-sdk.config.json. */
export const TIME_CHECK_CONFIG_KEY = 'time-check';

export interface TimeCheckConfig {
  enabled?: boolean;
  /** Hours between messages that trigger a stamp. null/absent disables. */
  gapHours?: number | null;
  /**
   * Hour (0-23) at which a new "working day" starts. null/absent disables the
   * once-a-day stamp. 0 means calendar midnight; 5 means a 2am message still
   * counts as the previous day — which matters because Justin works past
   * midnight, and a midnight boundary would fire mid-session.
   */
  notifyOnNewDayBoundaryHour?: number | null;
}

/**
 * Written into a project's config when the component is installed. A project
 * with NO config is treated as disabled (see resolveConfig), so these defaults
 * only ever apply where the component was deliberately added.
 */
export const TIME_CHECK_DEFAULTS: Required<TimeCheckConfig> = {
  enabled: true,
  gapHours: 8,
  notifyOnNewDayBoundaryHour: 0,
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Read `componentConfig["time-check"]` from justin-sdk.config.json.
 *
 * Returns null when the file, the section, or the key is absent — meaning
 * "disabled". Absence is the safe default: this hook runs on EVERY prompt, so
 * a project that never opted in must pay nothing and say nothing.
 */
export function readTimeCheckConfig(
  projectRoot: string,
): TimeCheckConfig | null {
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
  const section = config.componentConfig?.[TIME_CHECK_CONFIG_KEY];
  if (section == null || typeof section !== 'object') {
    return null;
  }
  return section as TimeCheckConfig;
}

/**
 * Merge a project's config over the defaults.
 *
 * `?? ` and `== null` are load-bearing throughout: `notifyOnNewDayBoundaryHour`
 * is legitimately 0 (midnight) and `gapHours` could legitimately be 0, both of
 * which are falsy. A truthiness check here would silently disable the shipped
 * default.
 */
export function resolveConfig(
  config: TimeCheckConfig | null,
): Required<TimeCheckConfig> | null {
  if (config == null) {
    return null;
  }
  if (config.enabled === false) {
    return null;
  }
  return {
    enabled: config.enabled ?? TIME_CHECK_DEFAULTS.enabled,
    gapHours:
      config.gapHours === undefined
        ? TIME_CHECK_DEFAULTS.gapHours
        : config.gapHours,
    notifyOnNewDayBoundaryHour:
      config.notifyOnNewDayBoundaryHour === undefined
        ? TIME_CHECK_DEFAULTS.notifyOnNewDayBoundaryHour
        : config.notifyOnNewDayBoundaryHour,
  };
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

export interface TranscriptFacts {
  /** Timestamp of the most recent assistant message, if any. */
  lastMessage: Date | null;
  /** Timestamp of the most recent time-check we emitted, if any. */
  lastCheck: Date | null;
}

/**
 * Scan a transcript backwards for the two timestamps we need.
 *
 * Deliberately keys the gap off the last ASSISTANT message, not the last user
 * message, for two reasons:
 *   1. Claude's own working time can be hours (autonomous loops, agent
 *      fan-outs). Measuring from the last USER message counts that as a "gap"
 *      and fires spuriously during the most active work.
 *   2. It is immune to whether the incoming prompt has already been appended
 *      to the transcript when this hook runs.
 *
 * Two shapes in the file make a naive scan wrong, both verified against a real
 * transcript:
 *   - Metadata entries (`mode`, `ai-title`, `last-prompt`, `bridge-session`, …)
 *     carry NO timestamp and cluster at the tail, so "the last line" is often
 *     not a message at all.
 *   - `attachment`/`system`/`queue-operation` entries DO carry timestamps but
 *     are not messages, so "the last line with a timestamp" is also wrong.
 * Hence: filter on `type` explicitly.
 */
export function scanTranscript(transcriptPath: string): TranscriptFacts {
  let lines: string[];
  try {
    lines = readFileSync(transcriptPath, 'utf8').split('\n');
  } catch {
    return {lastCheck: null, lastMessage: null};
  }

  let lastMessage: Date | null = null;
  let lastCheck: Date | null = null;

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line == null || line.length === 0) {
      continue;
    }
    // Cheap pre-filter: skip JSON.parse for lines that can't be either target.
    const maybeMessage = line.includes('"assistant"');
    const maybeCheck = line.includes(TIME_CHECK_MARKER);
    if (!maybeMessage && !maybeCheck) {
      continue;
    }

    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // A partially-written trailing line is normal on a live file.
    }

    const stamp =
      typeof entry.timestamp === 'string' ? new Date(entry.timestamp) : null;
    if (stamp == null || Number.isNaN(stamp.getTime())) {
      continue;
    }

    if (lastMessage == null && entry.type === 'assistant') {
      lastMessage = stamp;
    }

    if (lastCheck == null && entry.type === 'attachment') {
      const attachment = entry.attachment as
        | {content?: unknown; hookEvent?: unknown}
        | undefined;
      if (
        attachment?.hookEvent === 'UserPromptSubmit' &&
        typeof attachment.content === 'string' &&
        attachment.content.includes(TIME_CHECK_MARKER)
      ) {
        lastCheck = stamp;
      }
    }

    if (lastMessage != null && lastCheck != null) {
      break;
    }
  }

  return {lastCheck, lastMessage};
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

const pad = (n: number) => n.toString().padStart(2, '0');

/**
 * A stable key for the "working day" a timestamp belongs to.
 *
 * Shifting back by the boundary hour before taking the local date is what makes
 * a 2am message belong to the previous working day when boundaryHour is 5.
 */
export function workingDayKey(when: Date, boundaryHour: number): string {
  const shifted = new Date(when.getTime() - boundaryHour * 3_600_000);
  return `${shifted.getFullYear()}-${pad(shifted.getMonth() + 1)}-${pad(
    shifted.getDate(),
  )}`;
}

export type FireReason = 'gap' | 'new-day' | null;

/**
 * Decide whether to emit, and which trigger caused it.
 *
 * Returns null (silent) on the first prompt of a conversation: there is no
 * prior message to measure from, and the system prompt already carries today's
 * date, so there is nothing to correct yet.
 */
export function decide(args: {
  config: Required<TimeCheckConfig>;
  lastCheck: Date | null;
  lastMessage: Date | null;
  now: Date;
}): FireReason {
  const {config, lastCheck, lastMessage, now} = args;
  if (lastMessage == null) {
    return null;
  }

  if (config.gapHours != null) {
    const elapsedHours = (now.getTime() - lastMessage.getTime()) / 3_600_000;
    if (elapsedHours >= config.gapHours) {
      return 'gap';
    }
  }

  if (config.notifyOnNewDayBoundaryHour != null) {
    // Fall back to the last message when we have never stamped this
    // conversation, so a session that simply runs past the boundary still
    // gets its daily stamp.
    const baseline = lastCheck ?? lastMessage;
    const boundary = config.notifyOnNewDayBoundaryHour;
    if (workingDayKey(now, boundary) !== workingDayKey(baseline, boundary)) {
      return 'new-day';
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Local ISO-8601 with offset, e.g. 2026-08-06T00:25:33-07:00. */
export function formatLocalIso(when: Date): string {
  const offsetMinutes = -when.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return (
    `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}` +
    `T${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** Compact elapsed time: "3d 4h 32m", "4h 32m", "32m". */
export function formatGap(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  const parts: string[] = [];
  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (hours > 0 || days > 0) {
    parts.push(`${hours}h`);
  }
  parts.push(`${minutes}m`);
  return parts.join(' ');
}

export function formatReport(now: Date, lastMessage: Date): string {
  const weekday = now.toLocaleDateString('en-US', {weekday: 'long'});
  return [
    TIME_CHECK_MARKER,
    `Current: ${weekday} ${formatLocalIso(now)}`,
    `Time since last message: ${formatGap(now.getTime() - lastMessage.getTime())}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

interface HookInput {
  cwd?: string;
  transcript_path?: string;
}

/**
 * Run the hook. Always resolves 0 — a failing UserPromptSubmit hook can block
 * the prompt entirely, so every path here degrades to silence rather than
 * costing Justin a turn.
 */
export function runTimeCheck(args: {now?: Date; stdin?: string}): number {
  let input: HookInput = {};
  try {
    const raw = args.stdin ?? readFileSync(0, 'utf8');
    input = raw.trim() === '' ? {} : (JSON.parse(raw) as HookInput);
  } catch {
    return 0;
  }

  const projectRoot = input.cwd ?? process.cwd();
  const config = resolveConfig(readTimeCheckConfig(projectRoot));
  if (config == null) {
    return 0; // Not installed here, or explicitly disabled.
  }

  if (input.transcript_path == null || input.transcript_path === '') {
    return 0;
  }

  const now = args.now ?? new Date();
  const {lastCheck, lastMessage} = scanTranscript(input.transcript_path);
  if (decide({config, lastCheck, lastMessage, now}) == null) {
    return 0;
  }

  // decide() returns non-null only when lastMessage is set.
  console.log(formatReport(now, lastMessage as Date));
  return 0;
}
