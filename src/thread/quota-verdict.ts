/**
 * The spend quota's verdict (request home-base-ys9t7.5, D2–D4, D10): pure,
 * no IO. Given the resolved limits, a group's unattended spend, its project's
 * last-24-hours spend, the week reading and the time, it says `fine`, `over`
 * (with every limit crossed) or `unknown` (with every reason). The mode
 * (off | observe | enforce) is the caller's concern, never the verdict's.
 *
 *   - CHAIN: the group's unattended spend above chainWeekPercent.
 *   - PROJECT: the project's 24-hour spend above projectDayWeekPercent.
 *   - FLOOR: the week (all-models or any per-model week) at or above
 *     floorWeekPercent. For a handoff or a spawn always; for a running
 *     session only when its group is unattended: its latest typed line is
 *     older than attendedGraceMinutes, or it has none, or it cannot be read.
 *     Otherwise Justin's own prompt would be braked the moment it starts work.
 *
 * ORDER. A limit proven crossed is `over` even when another input is
 * unknown: the unknown reasons ride along. A lower bound (a spend with an
 * unpriced model) that already crosses its limit is proven crossed. Anything
 * else unknown that the verdict needs makes it `unknown` (D10), never `fine`.
 * A week reading the verdict does not need (an attended running session) is
 * not consulted at all.
 */

import type {Attendance, GroupSpend} from './quota-group';
import type {QuotaLimits} from './quota-knob';
import type {ProjectSpend} from './quota-project';
import type {WeekReading} from './quota-week';

import {attendanceOf} from './quota-group';

/** What the verdict is for: a running session's tool call, or a gate. */
export type QuotaPurpose = 'handoff' | 'running' | 'spawn';

export type QuotaOver =
  | {
      /** True when the spend is a lower bound (a model had no price). */
      atLeast: boolean;
      limit: 'chain' | 'project';
      limitPercent: number;
      spentPercent: number;
    }
  | {
      limit: 'floor';
      limitPercent: number;
      weekPercent: number;
      /** `week` for the all-models week, otherwise the model's panel name. */
      window: string;
    };

export type QuotaVerdict =
  | {
      /** Whether the floor was skipped because Justin typed recently. */
      attended: boolean;
      kind: 'fine';
    }
  | {
      attended: boolean;
      kind: 'over';
      over: QuotaOver[];
      /** Inputs that could not be measured, beside the limits proven crossed. */
      unknown: string[];
    }
  | {
      /**
       * Measured apart from the spend (dispatch 2 item 1): the brake allows
       * an attended session whose spend is unknown (D10), and treats
       * `unattended` and `unknown` alike.
       */
      attendance: Attendance;
      kind: 'unknown';
      reasons: string[];
    };

export interface QuotaVerdictInput {
  group: GroupSpend;
  limits: QuotaLimits;
  nowMs: number;
  project: ProjectSpend;
  purpose: QuotaPurpose;
  week: WeekReading;
}

/** A spend's percent, or its lower bound, or null when nothing is known. */
function spentOf(
  spend: GroupSpend | ProjectSpend,
): {atLeast: boolean; percent: number} | null {
  if (spend.kind === 'known') {
    return {atLeast: false, percent: spend.spend.weekPercent};
  }
  if (spend.lowerBound != null) {
    return {atLeast: true, percent: spend.lowerBound.weekPercent};
  }
  return null;
}

export function quotaVerdict(input: QuotaVerdictInput): QuotaVerdict {
  const {group, limits, nowMs, project, purpose, week} = input;
  const over: QuotaOver[] = [];
  const unknown: string[] = [];

  const spendLimit = (
    limit: 'chain' | 'project',
    spend: GroupSpend | ProjectSpend,
    limitPercent: number,
  ): void => {
    const spent = spentOf(spend);
    if (spent != null && spent.percent > limitPercent) {
      over.push({
        atLeast: spent.atLeast,
        limit,
        limitPercent,
        spentPercent: spent.percent,
      });
      return;
    }
    if (spend.kind === 'unknown') {
      unknown.push(
        `${limit === 'chain' ? 'group' : 'project'}: ${spend.reason}`,
      );
    }
  };
  spendLimit('chain', group, limits.chainWeekPercent);
  spendLimit('project', project, limits.projectDayWeekPercent);

  // Attended only when a typed line within the grace is PROVEN: read from
  // the group's typed lines alone, before and apart from any pricing.
  const attendance = attendanceOf(
    group.typed,
    nowMs,
    limits.attendedGraceMinutes,
  );
  const attended = attendance.kind === 'attended';
  const floorApplies = purpose !== 'running' || !attended;

  if (floorApplies) {
    if (week.kind === 'unknown') {
      unknown.push(`week: ${week.reason}`);
    } else {
      const windows: [string, number][] = [
        ['week', week.allModels.percent],
        ...Object.entries(week.byModel).map(
          ([model, reading]): [string, number] => [model, reading.percent],
        ),
      ];
      for (const [window, weekPercent] of windows) {
        if (weekPercent >= limits.floorWeekPercent) {
          over.push({
            limit: 'floor',
            limitPercent: limits.floorWeekPercent,
            weekPercent,
            window,
          });
        }
      }
    }
  }

  if (over.length > 0) return {attended, kind: 'over', over, unknown};
  if (unknown.length > 0) {
    return {attendance, kind: 'unknown', reasons: unknown};
  }
  return {attended, kind: 'fine'};
}
