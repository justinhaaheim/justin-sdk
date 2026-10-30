/**
 * The spend quota at the handoff and spawn gates (request home-base-ys9t7.5
 * D7; dispatch 2 item 2). The gate computes the verdict with purpose
 * `handoff` or `spawn` (the week floor always applies to both) and:
 *
 *   - mode off: skips, measuring nothing;
 *   - observe: logs the would-be refusal to the quota log and passes;
 *   - enforce: refuses, through the gate's own refusal path, with one of
 *     quotaUnknown, quotaChainSpent, quotaProjectSpent, quotaWeekFloor and a
 *     detail naming the numbers and the limits.
 *
 * A reader that throws is quotaUnknown (D10: gates refuse what they cannot
 * measure, as they refuse chainUnknown and usageUnknown).
 */

import type {QuotaMode} from './defaults';
import type {EnvLike} from './paths';
import type {QuotaLogGroupFacts} from './quota-log';
import type {QuotaPurpose, QuotaVerdict} from './quota-verdict';

import {overLine} from './quota-brake';

/** The quota refusal reasons, in the order a verdict is read. */
export const QUOTA_REFUSAL_REASONS = [
  'quotaUnknown',
  'quotaChainSpent',
  'quotaProjectSpent',
  'quotaWeekFloor',
] as const;

export type QuotaRefusalReason = (typeof QUOTA_REFUSAL_REASONS)[number];

export type QuotaGateRead =
  | {kind: 'off'}
  | {
      facts: QuotaLogGroupFacts | null;
      kind: 'measured';
      mode: Exclude<QuotaMode, 'off'>;
      purpose: Exclude<QuotaPurpose, 'running'>;
      sessionId: string | null;
      verdict: QuotaVerdict;
    };

export type QuotaGateDecision =
  | {detail: string; kind: 'observe' | 'refuse'; reason: QuotaRefusalReason}
  | {kind: 'pass'};

/** What the verdict means at a gate (pure). */
export function quotaGateDecision(read: QuotaGateRead): QuotaGateDecision {
  if (read.kind === 'off' || read.verdict.kind === 'fine') {
    return {kind: 'pass'};
  }
  const kind = read.mode === 'enforce' ? 'refuse' : 'observe';
  const {verdict} = read;
  if (verdict.kind === 'unknown') {
    return {
      detail: `the spend quota could not be measured: ${verdict.reasons.join('; ')}`,
      kind,
      reason: 'quotaUnknown',
    };
  }
  const [first] = verdict.over;
  const reason: QuotaRefusalReason =
    first?.limit === 'chain'
      ? 'quotaChainSpent'
      : first?.limit === 'project'
        ? 'quotaProjectSpent'
        : 'quotaWeekFloor';
  const also =
    verdict.unknown.length > 0
      ? `; also unknown: ${verdict.unknown.join('; ')}`
      : '';
  return {
    detail: `${verdict.over.map(overLine).join('; ')}${also}`,
    kind,
    reason,
  };
}

/** The quota log's `gate` line for a decision that is not a pass. */
export function gateLine(input: {
  decision: Exclude<QuotaGateDecision, {kind: 'pass'}>;
  nowMs: number;
  purpose: Exclude<QuotaPurpose, 'running'>;
  read: Extract<QuotaGateRead, {kind: 'measured'}> | null;
}): Record<string, unknown> {
  const {decision, read} = input;
  return {
    action: decision.kind === 'refuse' ? 'refused' : 'wouldRefuse',
    at: new Date(input.nowMs).toISOString(),
    detail: decision.detail,
    kind: 'gate',
    mode: read?.mode ?? null,
    purpose: input.purpose,
    reason: decision.reason,
    sessionId: read?.sessionId ?? null,
    ...(read?.facts ?? {}),
  };
}

/**
 * The real reader: the mode at `cwd` first (off measures nothing), then the
 * same measurement `thread quota` shows, for the calling session
 * (CLAUDE_CODE_SESSION_ID), with the verdict for `purpose`.
 */
export async function readQuotaForGate(input: {
  cwd: string;
  env: EnvLike;
  nowMs: number;
  purpose: Exclude<QuotaPurpose, 'running'>;
}): Promise<QuotaGateRead> {
  const {cwd, env, nowMs, purpose} = input;
  const {resolveThreadConfig} = await import('./config');
  const mode = resolveThreadConfig({cwd, env}).quota.mode.value;
  if (mode === 'off') return {kind: 'off'};
  const sessionId = env.CLAUDE_CODE_SESSION_ID ?? '';
  if (sessionId === '') {
    return {
      facts: null,
      kind: 'measured',
      mode,
      purpose,
      sessionId: null,
      verdict: {
        attendance: {kind: 'unknown', reason: 'no session id'},
        kind: 'unknown',
        reasons: [
          'CLAUDE_CODE_SESSION_ID is not set, so the calling session is unknown',
        ],
      },
    };
  }
  const {gatherQuotaReport} = await import('./quota-command');
  const {quotaLimitsOf} = await import('./quota-knob');
  const {quotaVerdict} = await import('./quota-verdict');
  const {groupFactsOf} = await import('./quota-log');
  const report = await gatherQuotaReport({
    cwd,
    env: env as NodeJS.ProcessEnv,
    nowMs,
    sessionId,
  });
  return {
    facts: groupFactsOf(report),
    kind: 'measured',
    mode,
    purpose,
    sessionId,
    verdict: quotaVerdict({
      group: report.group,
      limits: quotaLimitsOf(report.config),
      nowMs,
      project: report.project,
      purpose,
      week: report.week,
    }),
  };
}
