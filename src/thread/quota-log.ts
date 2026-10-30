/**
 * The quota log (request home-base-ys9t7.5 D9; dispatch 2 item 7): one jsonl
 * under the threads state dir, `quota-events.jsonl`. It is also the live
 * cost record home-base-ys9t7.8 asks for.
 *
 *   - `recheck`: every recompute of a running session's verdict (the brake).
 *   - `gate`: every handoff or spawn gate decision that is not fine.
 *   - `brake`: every deny and every observe-mode would-deny, plus an attended
 *     session allowed with an unknown spend (D10), carrying the payload's
 *     tool name, agent_id and transcript_path.
 *
 * Every line carries the group's latest typed time and its spend so far, so
 * time-to-limit can be read back (D9). Appends only: a line is one
 * appendFileSync, small enough to land whole.
 */

import type {QuotaMode} from './defaults';
import type {QuotaReport} from './quota-command';
import type {QuotaVerdict} from './quota-verdict';

import {appendFileSync, mkdirSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';

import {type EnvLike, threadsStateDir} from './paths';

export const QUOTA_LOG_FILE = 'quota-events.jsonl';

export function quotaLogPath(env: EnvLike = process.env): string {
  return join(threadsStateDir(env), QUOTA_LOG_FILE);
}

function iso(ms: number | null): string | null {
  return ms == null ? null : new Date(ms).toISOString();
}

/** What every line says about the group, from one measurement. */
export interface QuotaLogGroupFacts {
  firstUnattendedAt: string | null;
  groupRoot: string | null;
  latestTypedAt: string | null;
  /** The group's unattended spend in % of the week, or null when unknown. */
  unattendedWeekPercent: number | null;
}

export function groupFactsOf(report: QuotaReport): QuotaLogGroupFacts {
  const {group} = report;
  const typedAt =
    group.typed.kind === 'unknown' ? null : group.typed.latestTypedAtMs;
  return {
    firstUnattendedAt:
      group.kind === 'known' ? iso(group.firstUnattendedAtMs) : null,
    groupRoot: group.kind === 'known' ? group.root : null,
    latestTypedAt: iso(typedAt),
    unattendedWeekPercent:
      group.kind === 'known' ? group.spend.weekPercent : null,
  };
}

/**
 * The verdict's fields. `text` is quota-command.ts's verdictText, passed in:
 * this file stays off quota-command's import tree (zod, cli-style), because
 * the brake appends here on its fast path.
 */
export function verdictFields(
  verdict: QuotaVerdict,
  text: string,
): {
  attendance: string;
  verdict: string;
  verdictKind: QuotaVerdict['kind'];
} {
  return {
    attendance:
      verdict.kind === 'unknown'
        ? verdict.attendance.kind
        : verdict.attended
          ? 'attended'
          : 'unattended',
    verdict: text,
    verdictKind: verdict.kind,
  };
}

/** The `recheck` line for one recompute of a running session's verdict. */
export function recheckLine(input: {
  mode: QuotaMode;
  report: QuotaReport;
  verdict: QuotaVerdict;
  /** verdictText(verdict), from quota-command.ts. */
  verdictText: string;
}): Record<string, unknown> {
  const {mode, report, verdict} = input;
  const {group, project, week} = report;
  return {
    at: new Date(report.nowMs).toISOString(),
    kind: 'recheck',
    sessionId: report.sessionId,
    ...groupFactsOf(report),
    members: group.members.map((m) => ({
      beadId: m.beadId,
      sessionId: m.sessionId,
    })),
    mode,
    project: project.projectSlug,
    projectDayWeekPercent:
      project.kind === 'known' ? project.spend.weekPercent : null,
    unattended:
      group.kind === 'known'
        ? {
            byFamily: group.spend.byFamily,
            usd: group.spend.usd,
            weekPercent: group.spend.weekPercent,
          }
        : {unknown: group.reason},
    week:
      week.kind === 'known'
        ? {
            ageMinutes: week.allModels.ageMinutes,
            byModel: Object.fromEntries(
              Object.entries(week.byModel).map(([model, reading]) => [
                model,
                reading.percent,
              ]),
            ),
            percent: week.allModels.percent,
            source: week.allModels.source,
          }
        : {unknown: week.reason},
    ...verdictFields(verdict, input.verdictText),
  };
}

export type QuotaLogWrite =
  | {kind: 'failed'; reason: string}
  | {kind: 'written'};

/** Append one line. Never throws: a failure is returned for the caller to say. */
export function appendQuotaLog(
  line: Record<string, unknown>,
  env: EnvLike = process.env,
): QuotaLogWrite {
  const path = quotaLogPath(env);
  try {
    mkdirSync(dirname(path), {recursive: true});
    appendFileSync(path, `${JSON.stringify(line)}\n`);
    return {kind: 'written'};
  } catch (error) {
    return {
      kind: 'failed',
      reason: `${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export type SessionLogLines =
  | {
      brake: Record<string, unknown> | null;
      kind: 'read';
      path: string;
      recheck: Record<string, unknown> | null;
    }
  | {kind: 'failed'; reason: string}
  | {kind: 'none'; path: string};

/** The newest `recheck` and `brake` lines of one session (for `thread quota`). */
export function readSessionLogLines(
  sessionId: string,
  env: EnvLike = process.env,
): SessionLogLines {
  const path = quotaLogPath(env);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {kind: 'none', path};
    }
    return {
      kind: 'failed',
      reason: `${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  let recheck: Record<string, unknown> | null = null;
  let brake: Record<string, unknown> | null = null;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (recheck != null && brake != null) break;
    const raw = lines[i] ?? '';
    if (!raw.includes(sessionId)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (parsed == null || typeof parsed !== 'object') continue;
    const line = parsed as Record<string, unknown>;
    if (line.sessionId !== sessionId) continue;
    if (line.kind === 'recheck' && recheck == null) recheck = line;
    if (line.kind === 'brake' && brake == null) brake = line;
  }
  return {brake, kind: 'read', path, recheck};
}
