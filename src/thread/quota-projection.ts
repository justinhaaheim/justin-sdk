/**
 * Time to a spend limit (request home-base-ys9t7.5, D9): pure, no IO.
 *
 * `thread quota` shows, for each spend limit, how long the group has been
 * unattended and when it would reach the limit if it kept spending at its
 * average rate since it became unattended. Justin asked for this to calibrate
 * the limits (home-base-ys9t7.7: "see how long it takes the model to reach
 * those limits").
 *
 * The rate is the GROUP's: its unattended spend over the time since it became
 * unattended (its latest typed line; with none, its first unattended
 * request). The project limit is projected at the group's rate too: it is the
 * group that is running. That reading ignores spend leaving the project's
 * rolling 24-hour window, so for the project it is the early side.
 */

export interface UnattendedRate {
  /** How long the rate is averaged over. */
  elapsedMs: number;
  /** Percent of the week per hour. Zero when nothing was spent. */
  percentPerHour: number;
}

export type LimitProjection =
  | {
      /** When the limit is reached at this rate, epoch ms. */
      atMs: number;
      /** How long from now. */
      inMs: number;
      kind: 'at';
    }
  | {
      kind: 'none';
      /** `noRate`: nothing spent, or no time to average over. `reached`: spent >= limit. */
      reason: 'noRate' | 'reached';
    };

const HOUR_MS = 60 * 60 * 1000;

/**
 * The average rate of `spentPercent` since `sinceMs`, or null when there is
 * no start (nothing unattended yet) or the start is not in the past.
 */
export function unattendedRate(input: {
  nowMs: number;
  sinceMs: number | null;
  spentPercent: number;
}): UnattendedRate | null {
  const {nowMs, sinceMs, spentPercent} = input;
  if (sinceMs == null) return null;
  const elapsedMs = nowMs - sinceMs;
  if (!(elapsedMs > 0)) return null;
  return {elapsedMs, percentPerHour: (spentPercent * HOUR_MS) / elapsedMs};
}

/**
 * When `spentPercent` reaches `limitPercent` at `percentPerHour`. None when
 * the limit is already reached (`spent >= limit`) or the rate is zero or
 * unknown: a projection then would be a made-up number.
 */
export function projectTimeToLimit(input: {
  limitPercent: number;
  nowMs: number;
  percentPerHour: number | null;
  spentPercent: number;
}): LimitProjection {
  const {limitPercent, nowMs, percentPerHour, spentPercent} = input;
  if (spentPercent >= limitPercent) return {kind: 'none', reason: 'reached'};
  if (percentPerHour == null || !(percentPerHour > 0)) {
    return {kind: 'none', reason: 'noRate'};
  }
  const inMs = ((limitPercent - spentPercent) / percentPerHour) * HOUR_MS;
  return {atMs: nowMs + inMs, inMs, kind: 'at'};
}
