/**
 * The pacing rule (home-base-jm5kg.17): one account-wide comparison, the week's
 * all-models percent against the share of the week elapsed since its reset. In
 * Justin's words: "I don't want to use 85% of my tokens on monday, when the
 * reset doesn't happen until saturday."
 *
 *   even pace    = time since the reset / the window's length, as a percent
 *   points ahead = week used - even pace
 *
 * A pure function over what one sample says, so every row of the decision table
 * is a unit test. Three callers read it: `claude-usage pace`, the phone summary
 * and notice (`claude-usage sample`), and the handoff gate's hold.
 *
 * BOTH SIDES AS OF THE SAME MOMENT. The even pace is taken at the moment the
 * percent was read, not at the wall clock: a two-hour-old 60 % set against this
 * minute's elapsed share would read about 1.2 points better than it was, which
 * is the reassuring direction (critical rule 7). The wall clock decides only
 * whether the reading is still usable.
 *
 * CRITICAL RULE 7: anything that cannot be worked out is `unknown` with its
 * reason, never a number and never `ok`.
 *
 * ANTI-DECISION: this does not replace the gate's 90 % week ceiling. The
 * proposal on home-base-jm5kg.9 said it would; a warn-only guard that replaced
 * it would remove the only stop.
 */

import type {OkSample, SamplesRead} from '../claude-usage-samples';

import {SAME_WINDOW_TOLERANCE_MS, WINDOW_LENGTH_MS} from '../claude-usage-live';
import {HANDOFF_DEFAULTS, PACING_DEFAULTS} from './defaults';

export interface PaceMargins {
  /** More than this many points ahead of an even pace: hold level. */
  holdPointsAhead: number;
  /** More than this many points ahead of an even pace: warn level. */
  warnPointsAhead: number;
}

export const DEFAULT_PACE_MARGINS: PaceMargins = PACING_DEFAULTS;

/** A sample older than this is unknown, unless the caller names its own limit. */
export const DEFAULT_PACE_MAX_SAMPLE_MINUTES: number =
  HANDOFF_DEFAULTS.usage.maxSampleAgeMinutes;

/** The week window's length. The reset itself always comes from the data. */
export const WEEK_WINDOW_MS = WINDOW_LENGTH_MS.seven_day;

export type PaceVerdict = 'hold' | 'ok' | 'warn';

export interface PaceKnown {
  /** The share of the window elapsed when the percent was read, as a percent. */
  evenPercent: number;
  kind: 'known';
  margins: PaceMargins;
  /** Week used minus the even pace. Negative is behind an even pace. */
  pointsAhead: number;
  /** When the percent was read. */
  readAt: string;
  resetsAt: string;
  verdict: PaceVerdict;
  weekPercent: number;
}

export interface PaceUnknown {
  kind: 'unknown';
  reason: string;
}

export type PaceRead = PaceKnown | PaceUnknown;

function unknown(reason: string): PaceUnknown {
  return {kind: 'unknown', reason};
}

function verdictFor(pointsAhead: number, margins: PaceMargins): PaceVerdict {
  if (pointsAhead > margins.holdPointsAhead) return 'hold';
  return pointsAhead > margins.warnPointsAhead ? 'warn' : 'ok';
}

/**
 * The rule itself. `nowMs` is the moment `weekPercent` was read. A reset up to
 * SAME_WINDOW_TOLERANCE_MS beyond one window from then counts as the very start
 * of the window: the panel's reset jitters by a minute or so (measured
 * 2026-10-17), and a read just after a reset can land there.
 */
export function computePace(input: {
  margins?: PaceMargins;
  nowMs: number;
  resetsAt: string | null;
  /** Why `resetsAt` is null, when the sample says. */
  resetsAtError?: string | null;
  weekPercent: number;
  windowMs?: number;
}): PaceRead {
  const margins = input.margins ?? DEFAULT_PACE_MARGINS;
  const windowMs = input.windowMs ?? WEEK_WINDOW_MS;
  const {nowMs, resetsAt, weekPercent} = input;
  if (!Number.isFinite(weekPercent) || weekPercent < 0) {
    return unknown(`the week percent ${weekPercent} is not a percentage`);
  }
  if (!Number.isFinite(nowMs)) {
    return unknown('the time of the reading is not a time');
  }
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    return unknown(`the window length ${windowMs} ms is not a length`);
  }
  if (resetsAt == null) {
    return unknown(
      `the week's reset time is unknown (${input.resetsAtError ?? 'no reason recorded'})`,
    );
  }
  const resetMs = Date.parse(resetsAt);
  if (Number.isNaN(resetMs)) {
    return unknown(`the week's reset time "${resetsAt}" is not a time`);
  }
  const remainingMs = resetMs - nowMs;
  if (remainingMs <= 0) {
    return unknown(
      `the window this reading belongs to reset at ${resetsAt}, before the reading`,
    );
  }
  const elapsedMs = windowMs - remainingMs;
  if (elapsedMs < -SAME_WINDOW_TOLERANCE_MS) {
    return unknown(
      `the week's reset at ${resetsAt} is more than one window away from the reading`,
    );
  }
  const evenPercent = (Math.max(0, elapsedMs) / windowMs) * 100;
  const pointsAhead = weekPercent - evenPercent;
  return {
    evenPercent,
    kind: 'known',
    margins,
    pointsAhead,
    readAt: new Date(nowMs).toISOString(),
    resetsAt,
    verdict: verdictFor(pointsAhead, margins),
    weekPercent,
  };
}

/** A sample dated more than this far in the future is not trusted. */
const FUTURE_TOLERANCE_MINUTES = 5;

export type NewestSampleRead =
  | {ageMinutes: number; ok: true; sample: OkSample}
  | {detail: string; ok: false};

/**
 * The newest sample of the hourly /usage history, if it can be used. Missing
 * history, an unreadable one, no samples, a failed newest sample, or one older
 * than the limit: not usable, with the reason. The handoff gate's usage check
 * and the pacing rule share this, so they can never disagree about it.
 */
export function newestUsableSample(
  read: SamplesRead,
  maxSampleAgeMinutes: number,
  now: Date,
): NewestSampleRead {
  const notUsable = (detail: string): NewestSampleRead => ({detail, ok: false});
  if (read.kind === 'missing') {
    return notUsable(
      `there is no usage history at ${read.path} (the hourly claude-usage-sample chore writes it)`,
    );
  }
  if (read.kind === 'failed') {
    return notUsable(`the usage history could not be read: ${read.reason}`);
  }
  // F20 (home-base-mbnjv.8): an unreadable LAST line may be the newest
  // sample; an older one is not used in its place.
  if (read.lastLineUnreadable) {
    const last = read.unreadable.at(-1);
    return notUsable(
      `the newest line of the usage history (${read.path}${last == null ? '' : ` line ${last.line}`}) could not be read${last == null ? '' : `: ${last.reason}`}; an older sample is not used in its place`,
    );
  }
  const newest = read.samples.at(-1);
  if (newest == null) {
    return notUsable(
      `the usage history at ${read.path} holds no readable sample${read.unreadable.length > 0 ? ` (${read.unreadable.length} unreadable line${read.unreadable.length === 1 ? '' : 's'})` : ''}`,
    );
  }
  if (!newest.ok) {
    return notUsable(
      `the newest usage sample (${newest.sampledAt}) is a failed read: ${newest.reason}`,
    );
  }
  const ageMinutes = (now.getTime() - Date.parse(newest.sampledAt)) / 60_000;
  if (ageMinutes < -FUTURE_TOLERANCE_MINUTES) {
    return notUsable(
      `the newest usage sample is dated ${newest.sampledAt}, in the future`,
    );
  }
  if (ageMinutes > maxSampleAgeMinutes) {
    return notUsable(
      `the newest usage sample is ${Math.round(ageMinutes)} minutes old (${newest.sampledAt}), older than the ${maxSampleAgeMinutes}-minute limit`,
    );
  }
  return {ageMinutes, ok: true, sample: newest};
}

/**
 * The pace the usage history says now. Only the all-models week counts: the
 * rule is one account-wide comparison, so a per-model week has no say here (the
 * gate's ceiling still covers those).
 */
export function paceFromSamples(
  read: SamplesRead,
  options: {
    margins?: PaceMargins;
    /** Default: the handoff gate's own default. */
    maxSampleAgeMinutes?: number;
    now: Date;
    windowMs?: number;
  },
): PaceRead {
  const newest = newestUsableSample(
    read,
    options.maxSampleAgeMinutes ?? DEFAULT_PACE_MAX_SAMPLE_MINUTES,
    options.now,
  );
  if (!newest.ok) return unknown(newest.detail);
  const {sample} = newest;
  const {pct, resetsAt, resetsAtError} = sample.week;
  // A percent from a week that has since ended says nothing about this one.
  if (resetsAt != null && Date.parse(resetsAt) <= options.now.getTime()) {
    return unknown(
      `the newest usage sample (${sample.sampledAt}) reads a week that reset at ${resetsAt}; there is no reading of the new week yet`,
    );
  }
  return computePace({
    ...(options.margins == null ? {} : {margins: options.margins}),
    nowMs: Date.parse(sample.sampledAt),
    resetsAt,
    resetsAtError,
    weekPercent: pct,
    ...(options.windowMs == null ? {} : {windowMs: options.windowMs}),
  });
}

/** `22.0 points ahead of an even pace`, or `43.7 points behind an even pace`. */
export function paceGapText(pointsAhead: number): string {
  const size = Math.abs(pointsAhead).toFixed(1);
  return pointsAhead < 0
    ? `${size} points behind an even pace`
    : `${size} points ahead of an even pace`;
}

/** The numbers in one sentence, for a refusal, a notice or a summary line. */
export function describePace(pace: PaceKnown): string {
  return `the week is at ${pace.weekPercent} % with ${pace.evenPercent.toFixed(1)} % of it elapsed since the reset: ${paceGapText(pace.pointsAhead)} (warn above ${pace.margins.warnPointsAhead}, hold above ${pace.margins.holdPointsAhead})`;
}
