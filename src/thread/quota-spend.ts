/**
 * Spend in percent of Justin's week (request home-base-ys9t7.5, D1).
 *
 * A CostEstimate (session-cost.ts) prices each model at list price. The
 * quota turns those dollars into percent of the week with one rate per model
 * family, the dollars-per-percent that `claude-usage calibrate` fitted against
 * the same estimator (home-base-ys9t7.5.1). Families come from
 * usage-attribution.ts's familyOf, the classifier the fit used; haiku and
 * every other family take the `other` rate.
 *
 * CRITICAL RULE 7. A model with no list price (ModelCost.usd null) makes the
 * whole result `unknown`. It still carries what the priced models add up to,
 * as an explicit LOWER BOUND, never as a number that reads as complete.
 */

import type {CostEstimate} from '../session-cost';
import type {QuotaRateFamily} from './defaults';

import {familyOf} from '../usage-attribution';
import {QUOTA_RATE_FAMILIES} from './defaults';

/** The quota rate family of a model id (D1): haiku and the rest are `other`. */
export function quotaFamilyOf(model: string): QuotaRateFamily {
  const family = familyOf(model);
  return family === 'haiku' ? 'other' : family;
}

export interface FamilySpend {
  usd: number;
  weekPercent: number;
}

export interface SpendTotals {
  /** Every rate family, zero when it spent nothing. */
  byFamily: Record<QuotaRateFamily, FamilySpend>;
  usd: number;
  weekPercent: number;
}

export type WeekSpend =
  | ({kind: 'known'} & SpendTotals)
  | {
      kind: 'unknown';
      /** What the priced models alone add up to: the spend is at least this. */
      lowerBound: SpendTotals;
      reason: string;
      /** The models with no list price. */
      unpricedModels: string[];
    };

function emptyTotals(): SpendTotals {
  const byFamily = Object.fromEntries(
    QUOTA_RATE_FAMILIES.map((family) => [family, {usd: 0, weekPercent: 0}]),
  ) as Record<QuotaRateFamily, FamilySpend>;
  return {byFamily, usd: 0, weekPercent: 0};
}

/** Convert an estimate's per-model dollars into percent of the week. */
export function weekSpendOf(
  estimate: CostEstimate,
  dollarsPerWeekPercent: Readonly<Record<QuotaRateFamily, number>>,
): WeekSpend {
  const totals = emptyTotals();
  const unpriced: string[] = [];
  const reasons: string[] = [];
  for (const [model, cost] of Object.entries(estimate.byModel)) {
    if (cost.usd == null) {
      unpriced.push(model);
      reasons.push(cost.unknownReason ?? `no list price for ${model}`);
      continue;
    }
    const family = quotaFamilyOf(model);
    const percent = cost.usd / dollarsPerWeekPercent[family];
    totals.byFamily[family].usd += cost.usd;
    totals.byFamily[family].weekPercent += percent;
    totals.usd += cost.usd;
    totals.weekPercent += percent;
  }
  if (unpriced.length > 0) {
    return {
      kind: 'unknown',
      lowerBound: totals,
      reason: `the spend includes models with no list price, so it is at least ${totals.weekPercent.toFixed(2)} % of the week but not known: ${reasons.join('; ')}`,
      unpricedModels: unpriced.sort(),
    };
  }
  return {kind: 'known', ...totals};
}
