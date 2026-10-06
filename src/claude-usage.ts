/**
 * The ONE parser for the `/usage` panel Claude Code prints, and the reader that
 * fetches it (home-base-jptgj D2).
 *
 * `claude -p /usage --output-format json --no-session-persistence` returns the
 * panel as the `result` string in ~6.5 s, with num_turns 0 and total_cost_usd 0
 * (measured 2026-09-26). The panel is server-authoritative: it includes
 * claude.ai and other devices. The quota lines it carried that day:
 *
 *   Current session: 14% used · resets Sep 26 at 7:29pm (America/Los_Angeles)
 *   Current week (all models): 1% used · resets Oct 3 at 3:59pm (America/Los_Angeles)
 *   Current week (Fable): 0% used · resets Oct 3 at 4pm (America/Los_Angeles)
 *
 * Every "Current …: N% used" line is read GENERICALLY. `Current session` is the
 * 5-hour window, `Current week (all models)` is the weekly window, and every
 * other `Current week (<Model>)` line lands in `weekByModel` under its model
 * name — whatever models the plan lists, not a hardcoded Fable
 * (home-base-1r6d.12: the model label tracks the plan's per-model limits).
 *
 * FAILURE IS NEVER A NUMBER (critical rule 7). The session and all-models week
 * lines are REQUIRED: a panel missing either is a failed parse with a reason,
 * never a window at 0%. A reset time that cannot be turned into an instant
 * leaves `resetsAt` null WITH a reason, and the window's percentage still
 * stands — the two facts come from different parts of the line.
 *
 * justin-loop's usage gate (justin-loop/runner.ts `parseUsage`/`readUsage`) is
 * built on this module, so there is exactly one reading of the panel.
 */
import {tmpdir} from 'node:os';

import {resolveClaudeBin} from './claude-bin';
import {
  type ChildOptions,
  type ChildOutcome,
  describeChildFailure,
  runChild,
} from './justin-loop/child';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One quota window read off the panel. */
export interface UsageWindow {
  /** Percent of the window consumed, exactly as the panel printed it. */
  pct: number;
  /**
   * The instant the window resets, as an ISO-8601 UTC string
   * (`2026-10-03T22:59:00Z`), or null when `resetsText` could not be turned
   * into one — `resetsAtError` then says why.
   */
  resetsAt: string | null;
  /** Why `resetsAt` is null; null whenever `resetsAt` is set. */
  resetsAtError: string | null;
  /**
   * What followed `resets` on the line, verbatim
   * (`Oct 3 at 3:59pm (America/Los_Angeles)`), or null when the line carried no
   * `· resets …` clause at all.
   */
  resetsText: string | null;
}

export interface UsagePanel {
  /** True when the account is on a subscription rather than API billing. */
  isSubscription: boolean;
  /** `Current session` — the 5-hour window. */
  session: UsageWindow;
  /** `Current week (all models)` — the weekly window. */
  week: UsageWindow;
  /**
   * Every other `Current week (<Model>)` line, keyed by the model name as
   * printed (`Fable`). Empty when the panel lists no per-model limit — that is
   * "the panel shows none", not "0%".
   */
  weekByModel: Record<string, UsageWindow>;
}

/** What parsing one panel produced. */
export type UsagePanelParse =
  | {kind: 'failed'; reason: string}
  | {kind: 'ok'; panel: UsagePanel};

/**
 * What one `/usage` read produced.
 *
 * `failed` carries the four distinct reasons justin-loop's reader has always
 * told apart (home-base-685h F1) — the child failed, it printed unparseable
 * JSON, the JSON had no string `result`, the panel text was not recognised —
 * plus the panel text itself when the read got that far, so a caller can log
 * what the unrecognised panel said.
 */
export type UsagePanelRead =
  | {
      kind: 'failed';
      /** The panel text, when the JSON carried one; null otherwise. */
      raw: string | null;
      reason: string;
      /** When the read finished, ISO-8601 UTC. */
      sampledAt: string;
    }
  | {
      kind: 'ok';
      panel: UsagePanel;
      /** The full panel text, including the "What's contributing" section. */
      raw: string;
      /** When the read finished — the instant reset years were inferred from. */
      sampledAt: string;
    };

/** Spawns one bounded child call. `runChild` in production; injected in tests. */
export type ChildRunner = (
  bin: string,
  args: string[],
  opts: ChildOptions,
) => Promise<ChildOutcome>;

export interface ReadUsagePanelOptions {
  /** The `claude` binary. Defaults to `resolveClaudeBin()` — an absolute path when one exists. */
  claudeBin?: string;
  // Deliberately NO `cwd` option: see `usagePanelCwd` (home-base-jptgj F1).
  /** The clock `sampledAt` is read from. */
  now?: () => Date;
  run?: ChildRunner;
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How every failure reason names the command. */
export const USAGE_COMMAND_LABEL = 'claude -p /usage';

/**
 * The arguments. `--no-session-persistence` keeps an hourly sampler from
 * writing a session transcript per read (D2).
 */
export const USAGE_PANEL_ARGS: readonly string[] = [
  '-p',
  '/usage',
  '--output-format',
  'json',
  '--no-session-persistence',
];

/** Same bound justin-loop has always given the read. */
export const USAGE_PANEL_TIMEOUT_MS = 60_000;

const ALL_MODELS = 'all models';

/**
 * Month names a reset text may abbreviate. A token matches when it is a prefix
 * of at least three letters (`Sep`, `Sept`, `September`).
 */
const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
] as const;

/**
 * One quota line. Not anchored to the line start, so a decoration in front of
 * `Current` (a bullet, indentation) still matches, exactly as the pre-jptgj
 * regexes did.
 *
 *   group 1  `session`, or `week (<label>)`
 *   group 2  the label inside the parentheses, when it is a week line
 *   group 3  the percentage
 *   group 4  the rest of the line (the `· resets …` clause, when present)
 */
const QUOTA_LINE =
  /Current (session|week \(([^)\n]+)\)):\s*(\d+(?:\.\d+)?)%\s*used(.*)$/;

/** The reset clause at the end of a quota line. */
const RESETS_CLAUSE = /·\s*resets\s+(.+?)\s*$/i;

/**
 * `Oct 3 at 3:59pm (America/Los_Angeles)` / `Oct 3 at 4pm (America/Los_Angeles)`.
 *
 *   group 1  month name or abbreviation
 *   group 2  day of month
 *   group 3  hour
 *   group 4  minutes (optional — `4pm` has none)
 *   group 5  am/pm (optional — a 24-hour `16:00` has none)
 *   group 6  the IANA zone
 */
const RESET_TEXT =
  /^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+at\s+(\d{1,2})(?::(\d{2}))?\s*([ap]m)?\s*\(([^()]+)\)$/i;

/** A trailing `(Zone/Name)` on a reset text. */
const TRAILING_ZONE = /\s*\([^()]*\)\s*$/;

// ---------------------------------------------------------------------------
// Wall-clock time in an IANA zone → an instant
// ---------------------------------------------------------------------------

interface WallClock {
  day: number;
  hour: number;
  minute: number;
  /** 1–12. */
  month: number;
  year: number;
}

type Resolved = {kind: 'failed'; reason: string} | {kind: 'ok'; ms: number};

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Throws RangeError for a zone the runtime does not know. */
function zoneFormatter(zone: string): Intl.DateTimeFormat {
  const cached = formatters.get(zone);
  if (cached != null) return cached;
  const formatter = new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    hour: 'numeric',
    hourCycle: 'h23',
    minute: 'numeric',
    month: 'numeric',
    second: 'numeric',
    timeZone: zone,
    year: 'numeric',
  });
  formatters.set(zone, formatter);
  return formatter;
}

/** The wall clock in `zone` at `ms`, to the second. */
function wallClockAt(ms: number, zone: string): WallClock & {second: number} {
  const parts = zoneFormatter(zone).formatToParts(new Date(ms));
  function part(type: Intl.DateTimeFormatPartTypes): number {
    const found = parts.find((p) => p.type === type);
    const value = found == null ? Number.NaN : Number(found.value);
    if (!Number.isInteger(value)) {
      throw new Error(
        `Intl.DateTimeFormat gave no usable ${type} for ${zone} at ${new Date(ms).toISOString()}`,
      );
    }
    return value;
  }
  return {
    day: part('day'),
    hour: part('hour'),
    minute: part('minute'),
    month: part('month'),
    second: part('second'),
    year: part('year'),
  };
}

/** How far `zone` is ahead of UTC at `ms`, in milliseconds. */
function zoneOffsetMs(ms: number, zone: string): number {
  const wall = wallClockAt(ms, zone);
  const wallAsUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );
  return wallAsUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant at which the wall clock in `zone` reads `wall`.
 *
 * Two passes of the offset, because the offset at the naive guess can differ
 * from the offset at the answer across a DST change. A wall time inside a
 * spring-forward gap does not exist and fails with that reason. A wall time
 * inside a fall-back overlap exists twice; this returns the earlier of the two
 * (the offset before the change), which is an hour early if the server meant
 * the later one — a reset at 1–2am on the fall-back night is the only case.
 */
function wallClockToInstant(wall: WallClock, zone: string): Resolved {
  const asUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
  );
  const first = asUtc - zoneOffsetMs(asUtc, zone);
  const ms = asUtc - zoneOffsetMs(first, zone);
  const check = wallClockAt(ms, zone);
  if (
    check.year !== wall.year ||
    check.month !== wall.month ||
    check.day !== wall.day ||
    check.hour !== wall.hour ||
    check.minute !== wall.minute
  ) {
    return {
      kind: 'failed',
      reason: `${wall.year}-${wall.month}-${wall.day} ${wall.hour}:${String(wall.minute).padStart(2, '0')} does not exist in ${zone} (a date that is not in the calendar, or a daylight-saving gap)`,
    };
  }
  return {kind: 'ok', ms};
}

/** `2026-10-03T22:59:00Z` — minute-precision instants need no milliseconds. */
function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function monthNumber(token: string): number | null {
  const lower = token.toLowerCase();
  if (lower.length < 3) return null;
  const index = MONTHS.findIndex((name) => name.startsWith(lower));
  return index === -1 ? null : index + 1;
}

/** 24-hour clock hour from the printed hour and optional am/pm. */
function hour24(hour: number, meridiem: string | undefined): number | null {
  if (meridiem == null) {
    return hour >= 0 && hour <= 23 ? hour : null;
  }
  if (hour < 1 || hour > 12) return null;
  const pm = meridiem.toLowerCase() === 'pm';
  if (hour === 12) return pm ? 12 : 0;
  return pm ? hour + 12 : hour;
}

/**
 * Pick the year the panel meant. The panel prints no year.
 *
 * D2 says "the occurrence nearest AFTER the sample instant", because a reset is
 * always in the future and at most ~7 days out. This picks the candidate
 * NEAREST THE SAMPLE IN EITHER DIRECTION, which is the same answer whenever
 * that premise holds (any reset under ~6 months out) — including the Dec 30 →
 * Jan 2 rollover. It differs only when the premise fails: a reset text that is
 * already a few minutes or days in the past (clock skew, or a stale window the
 * server has not rolled). "Nearest after" would push that a whole YEAR forward,
 * and a history keyed by the week's reset instant would then grow a phantom
 * week a year away. Nearest-either-way reads it as the past instant the text
 * actually names.
 */
function pickYear(
  wall: Omit<WallClock, 'year'>,
  zone: string,
  sampledAtMs: number,
): Resolved {
  const sampleYear = wallClockAt(sampledAtMs, zone).year;
  let best: {distance: number; ms: number} | null = null;
  const reasons: string[] = [];
  for (const year of [sampleYear - 1, sampleYear, sampleYear + 1]) {
    const resolved = wallClockToInstant({...wall, year}, zone);
    if (resolved.kind === 'failed') {
      reasons.push(resolved.reason);
      continue;
    }
    const distance = Math.abs(resolved.ms - sampledAtMs);
    if (best == null || distance < best.distance) {
      best = {distance, ms: resolved.ms};
    }
  }
  if (best == null) {
    return {kind: 'failed', reason: reasons.join('; ')};
  }
  return {kind: 'ok', ms: best.ms};
}

/**
 * The absolute instant a reset text names, relative to when it was sampled.
 *
 * `Oct 3 at 3:59pm (America/Los_Angeles)` sampled at 2026-09-26T23:10Z →
 * `2026-10-03T22:59:00Z`. Anything it cannot read fails with a reason; it never
 * guesses a zone, a year it cannot justify, or a time of day.
 */
export function resolveResetInstant(
  resetsText: string,
  sampledAt: Date,
): {kind: 'failed'; reason: string} | {kind: 'ok'; resetsAt: string} {
  const sampledAtMs = sampledAt.getTime();
  if (Number.isNaN(sampledAtMs)) {
    return {
      kind: 'failed',
      reason: 'the sample time is not a valid date, so no year can be inferred',
    };
  }
  const match = RESET_TEXT.exec(resetsText.trim());
  if (match == null) {
    return {
      kind: 'failed',
      reason: `unrecognised reset text "${resetsText}" (expected like "Oct 3 at 3:59pm (America/Los_Angeles)")`,
    };
  }
  const [, monthToken, dayText, hourText, minuteText, meridiem, zoneText] =
    match;
  const month = monthNumber(monthToken ?? '');
  if (month == null) {
    return {
      kind: 'failed',
      reason: `unrecognised month "${monthToken ?? ''}" in reset text "${resetsText}"`,
    };
  }
  const hour = hour24(Number(hourText), meridiem);
  const minute = minuteText == null ? 0 : Number(minuteText);
  if (hour == null || minute > 59 || (meridiem == null && minuteText == null)) {
    return {
      kind: 'failed',
      reason: `unrecognised time of day in reset text "${resetsText}"`,
    };
  }
  const zone = (zoneText ?? '').trim();
  try {
    zoneFormatter(zone);
  } catch (err) {
    return {
      kind: 'failed',
      reason: `unknown time zone "${zone}" in reset text "${resetsText}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  let picked: Resolved;
  try {
    picked = pickYear(
      {day: Number(dayText), hour, minute, month},
      zone,
      sampledAtMs,
    );
  } catch (err) {
    return {
      kind: 'failed',
      reason: `could not resolve reset text "${resetsText}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (picked.kind === 'failed') {
    return {
      kind: 'failed',
      reason: `reset text "${resetsText}" names no real instant: ${picked.reason}`,
    };
  }
  return {kind: 'ok', resetsAt: isoSeconds(picked.ms)};
}

/**
 * A reset text without its trailing zone: `Jul 16 at 10:50pm (America/Los_Angeles)`
 * → `Jul 16 at 10:50pm`. justin-loop's `UsageSnapshot` has always carried this
 * form, and its banner prints it.
 */
export function resetsTextWithoutZone(resetsText: string): string {
  return resetsText.replace(TRAILING_ZONE, '').trim();
}

function windowFrom(pct: number, tail: string, sampledAt: Date): UsageWindow {
  const clause = RESETS_CLAUSE.exec(tail);
  const resetsText = clause?.[1] ?? null;
  if (resetsText == null) {
    return {
      pct,
      resetsAt: null,
      resetsAtError: 'the panel line carries no "· resets …" clause',
      resetsText: null,
    };
  }
  const resolved = resolveResetInstant(resetsText, sampledAt);
  return resolved.kind === 'ok'
    ? {pct, resetsAt: resolved.resetsAt, resetsAtError: null, resetsText}
    : {pct, resetsAt: null, resetsAtError: resolved.reason, resetsText};
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

/**
 * Parse the text `/usage` prints.
 *
 * `sampledAt` is when the panel was read; it is what the year of each reset is
 * inferred from (the panel prints none). When a quota line appears twice the
 * first one wins, as it always has.
 */
export function parseUsagePanel(raw: string, sampledAt: Date): UsagePanelParse {
  let session: UsageWindow | null = null;
  let week: UsageWindow | null = null;
  const weekByModel: Record<string, UsageWindow> = {};

  for (const line of raw.split(/\r?\n/)) {
    const match = QUOTA_LINE.exec(line);
    if (match == null) continue;
    const [, which, label, pctText, tail] = match;
    const pct = Number(pctText);
    if (!Number.isFinite(pct)) continue;
    if (which === 'session') {
      session ??= windowFrom(pct, tail ?? '', sampledAt);
      continue;
    }
    const model = (label ?? '').trim();
    if (model === ALL_MODELS) {
      week ??= windowFrom(pct, tail ?? '', sampledAt);
    } else if (model !== '' && !(model in weekByModel)) {
      weekByModel[model] = windowFrom(pct, tail ?? '', sampledAt);
    }
  }

  const missing: string[] = [];
  if (session == null) missing.push('`Current session: N% used`');
  if (week == null) missing.push('`Current week (all models): N% used`');
  if (session == null || week == null) {
    return {
      kind: 'failed',
      reason: `the panel has no ${missing.join(' and no ')} line`,
    };
  }
  return {
    kind: 'ok',
    panel: {
      isSubscription: /using your subscription/i.test(raw),
      session,
      week,
      weekByModel,
    },
  };
}

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

/**
 * The directory every `/usage` read runs in: the OS temp directory, which is
 * outside any repository (`/tmp` when TMPDIR is unset, as under launchd).
 *
 * WHY (home-base-jptgj F1, measured 2026-09-26 by the conductor): `claude -p`
 * run from a repository fires that repository's PROJECT SessionStart hook, and
 * in an enrolled repo that hook ran `justin-sdk thread start`, which committed
 * a new thread bead to ~/Dev/threads. Three reads made from repo checkouts that
 * day each left one (th-o7as, th-csep, th-at6o); an hourly sampler would leave
 * 24 a day. That hook is inert since home-base-39co9 (2026-10-05), but a repo
 * on an older SDK pin still runs the old one, and every other project hook
 * still fires, so the neutral cwd stays. `--no-session-persistence` does NOT prevent it. The user-level
 * settings carry no SessionStart hook, so a neutral cwd runs no hook at all.
 * `/usage` is account-level, so the directory cannot change its answer. That is
 * why the option to choose the directory was removed rather than defaulted.
 */
export function usagePanelCwd(): string {
  return tmpdir();
}

/**
 * Run `claude -p /usage --output-format json --no-session-persistence` and parse
 * what it prints. Costs zero tokens (measured 2026-09-26: num_turns 0,
 * total_cost_usd 0). It needs the network, so it cannot succeed inside a
 * sandbox that blocks it — that arrives here as a failed read, never as 0%.
 * It always runs from `usagePanelCwd()`, never from the caller's repository.
 *
 * Never throws: every way it can go wrong is a `failed` result whose reason
 * names which one.
 */
export async function readUsagePanel(
  opts: ReadUsagePanelOptions = {},
): Promise<UsagePanelRead> {
  const run = opts.run ?? runChild;
  const now = opts.now ?? (() => new Date());
  const outcome = await run(
    opts.claudeBin ?? resolveClaudeBin(),
    [...USAGE_PANEL_ARGS],
    {
      cwd: usagePanelCwd(),
      timeoutMs: opts.timeoutMs ?? USAGE_PANEL_TIMEOUT_MS,
    },
  );
  const sampled = now();
  const sampledAt = sampled.toISOString();

  const failure = describeChildFailure(USAGE_COMMAND_LABEL, outcome);
  if (failure != null) {
    return {kind: 'failed', raw: null, reason: failure, sampledAt};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(outcome.stdout);
  } catch (err) {
    return {
      kind: 'failed',
      raw: null,
      reason: `${USAGE_COMMAND_LABEL} printed unparseable JSON: ${err instanceof Error ? err.message : String(err)}`,
      sampledAt,
    };
  }
  const result =
    typeof parsed === 'object' && parsed != null && 'result' in parsed
      ? parsed.result
      : undefined;
  if (typeof result !== 'string') {
    return {
      kind: 'failed',
      raw: null,
      reason: `${USAGE_COMMAND_LABEL} returned JSON with no string \`result\` field — the shape of the output changed`,
      sampledAt,
    };
  }
  const panel = parseUsagePanel(result, sampled);
  if (panel.kind === 'failed') {
    return {
      kind: 'failed',
      raw: result,
      reason: `${USAGE_COMMAND_LABEL} printed no recognisable quota lines (expected \`Current session: N% used\` and \`Current week (all models): N% used\`): ${panel.reason}`,
      sampledAt,
    };
  }
  return {kind: 'ok', panel: panel.panel, raw: result, sampledAt};
}
