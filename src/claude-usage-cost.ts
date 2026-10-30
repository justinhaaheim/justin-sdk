/**
 * claude-usage-cost — Claude Code's OWN running cost of every session, as its
 * statusline payload reports it, recorded over time (request home-base-ys9t7.8,
 * built by home-base-ys9t7.8.1).
 *
 * WHY (Justin, 2026-10-30): "it sounded like we currently do NOT log the live
 * cost per session data when we're checking usage. Seems like we should -- no
 * reason to NOT log it if it's potentially helpful, right?" The spend quota
 * prices transcripts itself (session-cost.ts, D1 of home-base-ys9t7.5); this is
 * the figure to check that estimate against, for every session in every repo.
 *
 * ONE WRITER (D11 of home-base-ys9t7.5): the statusline store. Recording runs
 * inside `observeRender` (claude-usage-live.ts), which home-base's statusline
 * renderer calls on every render; this module owns the line format, the
 * write decision and the readers, and takes its paths from `storePaths`.
 *
 * WHAT A FIGURE MEANS (code.claude.com/docs/en/statusline, read 2026-10-30):
 * `cost.total_cost_usd` is "computed client-side at list price", "may differ
 * from your actual bill", and "resets to $0 when /clear starts a new session"
 * (a new session id). It is one number for the session, not per model, so the
 * quota never budgets on it (D1). Whether it includes subagents is not stated
 * there; the docs' cost example says it accumulates "all API calls in the
 * current session". Not verified here.
 *
 * WHEN A LINE IS WRITTEN: only when the session's figure differs from the
 * last one recorded for that session id. The figure changes only when a
 * response arrives, so a changed figure is fresh; an idle window's redraw
 * repeats the same figure and writes nothing. A session whose first figure is
 * $0 has spent nothing yet and writes nothing. A figure LOWER than the last
 * one for the same id (a resumed process restarting its counter, or two
 * processes on one id) is written with `decreased: true`, never dropped.
 *
 * COST PER RENDER: the no-change path reads one small per-session file
 * (`<cache>/session-costs/<id>.json`, the last figure recorded) and nothing
 * else. Only a change appends one line and rewrites that file.
 */
import type {UnreadableLine} from './claude-usage-samples';

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {dirname} from 'node:path';

import {projectDirSlug} from './thread/transcript-messages';
import {projectOf} from './usage-attribution';

export const COST_SCHEMA = 1;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─── the payload ─────────────────────────────────────────────────────────────

/** What one statusline payload says about the session's cost. */
export interface CostPayload {
  /** `workspace.current_dir`, else `cwd`. */
  cwd: string | null;
  linesAdded: number | null;
  linesRemoved: number | null;
  modelId: string | null;
  /** `workspace.project_dir`: where Claude Code was launched. */
  projectDir: string | null;
  totalApiDurationMs: number | null;
  totalCostUsd: number;
  totalDurationMs: number | null;
}

export type CostPayloadRead =
  | {kind: 'absent'}
  | {kind: 'invalid'; reason: string}
  | {kind: 'ok'; payload: CostPayload};

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * `costJson` is the wrapper's one-line slice of the payload:
 * `{cost, modelId, cwd, projectDir}` as JSON, or '' when the payload had no
 * `cost` (an older Claude Code, a test fixture). Absent is not invalid: only a
 * cost that is there and is not a finite, non-negative number is invalid.
 */
export function parseCostPayload(costJson: string): CostPayloadRead {
  const text = costJson.trim();
  if (text === '' || text === 'null') return {kind: 'absent'};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {kind: 'invalid', reason: `not JSON: ${message(err)}`};
  }
  if (!isObject(parsed)) return {kind: 'invalid', reason: 'not an object'};
  const cost = parsed.cost;
  if (cost == null) return {kind: 'absent'};
  if (!isObject(cost)) {
    return {
      kind: 'invalid',
      reason: `cost is not an object: ${JSON.stringify(cost)}`,
    };
  }
  const usd = cost.total_cost_usd;
  if (usd == null) return {kind: 'absent'};
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) {
    return {
      kind: 'invalid',
      reason: `cost.total_cost_usd is not a finite non-negative number: ${JSON.stringify(usd)}`,
    };
  }
  return {
    kind: 'ok',
    payload: {
      cwd: optionalString(parsed.cwd),
      linesAdded: optionalNumber(cost.total_lines_added),
      linesRemoved: optionalNumber(cost.total_lines_removed),
      modelId: optionalString(parsed.modelId),
      projectDir: optionalString(parsed.projectDir),
      totalApiDurationMs: optionalNumber(cost.total_api_duration_ms),
      totalCostUsd: usd,
      totalDurationMs: optionalNumber(cost.total_duration_ms),
    },
  };
}

/**
 * The project of a directory, worktrees folded into their repo, by the same
 * rule the quota and calibrate use (usage-attribution.ts):
 * `/Users/jhaa/Dev/home-base/.claude/worktrees/x` → `home-base`.
 */
export function projectOfDir(dir: string): string {
  return projectOf(projectDirSlug(dir));
}

// ─── one line of session-cost.jsonl ──────────────────────────────────────────

export interface SessionCostLine {
  at: string;
  ccVersion: string | null;
  cwd: string | null;
  /** Lower than the previous figure recorded for this session id. */
  decreased: boolean;
  linesAdded: number | null;
  linesRemoved: number | null;
  modelId: string | null;
  /**
   * The figure last recorded for this session id, or null when there was none
   * (its first line) or the per-session file could not be read.
   */
  previousCostUsd: number | null;
  /** Folded from projectDir, else cwd (projectOfDir); null when neither is known. */
  project: string | null;
  projectDir: string | null;
  schema: typeof COST_SCHEMA;
  sessionId: string;
  totalApiDurationMs: number | null;
  totalCostUsd: number;
  totalDurationMs: number | null;
  transcriptPath: string | null;
}

/** What one render did about the session's cost. */
export type CostObservation =
  | {kind: 'absent'}
  | {kind: 'failed'; reason: string}
  | {kind: 'invalid'; reason: string}
  | {kind: 'no-session-id'}
  | {kind: 'unchanged'; totalCostUsd: number}
  | {
      /** Written, but the per-session file was not: the next change writes a line again. */
      cacheError: string | null;
      kind: 'written';
      line: SessionCostLine;
    }
  | {kind: 'zero'};

interface LastCost {
  at: string;
  schema: typeof COST_SCHEMA;
  totalCostUsd: number;
}

type LastCostRead =
  | {kind: 'failed'; reason: string}
  | {kind: 'missing'}
  | {kind: 'ok'; totalCostUsd: number};

function readLastCost(path: string): LastCostRead {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (err) {
    if ((err as {code?: string}).code === 'ENOENT') return {kind: 'missing'};
    return {kind: 'failed', reason: `could not read ${path}: ${message(err)}`};
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      isObject(parsed) &&
      parsed.schema === COST_SCHEMA &&
      typeof parsed.totalCostUsd === 'number' &&
      Number.isFinite(parsed.totalCostUsd)
    ) {
      return {kind: 'ok', totalCostUsd: parsed.totalCostUsd};
    }
    return {kind: 'failed', reason: `${path} is not a last-cost record`};
  } catch (err) {
    return {kind: 'failed', reason: `${path} is not JSON: ${message(err)}`};
  }
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), {recursive: true});
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, {force: true});
    throw err;
  }
}

export interface RecordCostInput {
  ccVersion: string | null;
  /** The wrapper's cost slice (parseCostPayload); '' when the payload had none. */
  costJson: string;
  /** session-cost.jsonl (storePaths().costHistory). */
  historyPath: string;
  /** This session's last-figure file (costSessionFile). */
  lastPath: string;
  nowMs: number;
  /** Already checked to be a safe file name by the caller. */
  sessionId: string;
  transcriptPath: string | null;
}

/**
 * Record the session's figure when it changed (see the file header). Never
 * throws for an I/O failure: it is the outcome, and the render carries on.
 */
export function recordSessionCost(input: RecordCostInput): CostObservation {
  const read = parseCostPayload(input.costJson);
  if (read.kind !== 'ok') return read;
  const {payload} = read;
  const last = readLastCost(input.lastPath);
  const previous = last.kind === 'ok' ? last.totalCostUsd : null;
  if (previous != null && payload.totalCostUsd === previous) {
    return {kind: 'unchanged', totalCostUsd: previous};
  }
  if (last.kind === 'missing' && payload.totalCostUsd === 0) {
    return {kind: 'zero'};
  }
  const at = new Date(input.nowMs).toISOString();
  const dir = payload.projectDir ?? payload.cwd;
  const line: SessionCostLine = {
    at,
    ccVersion: input.ccVersion,
    cwd: payload.cwd,
    decreased: previous != null && payload.totalCostUsd < previous,
    linesAdded: payload.linesAdded,
    linesRemoved: payload.linesRemoved,
    modelId: payload.modelId,
    previousCostUsd: previous,
    project: dir == null ? null : projectOfDir(dir),
    projectDir: payload.projectDir,
    schema: COST_SCHEMA,
    sessionId: input.sessionId,
    totalApiDurationMs: payload.totalApiDurationMs,
    totalCostUsd: payload.totalCostUsd,
    totalDurationMs: payload.totalDurationMs,
    transcriptPath: input.transcriptPath,
  };
  // The history first: it is the data Justin would miss. A failed append
  // leaves the per-session file alone, so the next render tries again.
  try {
    mkdirSync(dirname(input.historyPath), {recursive: true});
    appendFileSync(input.historyPath, `${JSON.stringify(line)}\n`);
  } catch (err) {
    return {
      kind: 'failed',
      reason: `could not append to ${input.historyPath}: ${message(err)}`,
    };
  }
  const record: LastCost = {
    at,
    schema: COST_SCHEMA,
    totalCostUsd: payload.totalCostUsd,
  };
  let cacheError: string | null = last.kind === 'failed' ? last.reason : null;
  try {
    writeAtomic(input.lastPath, `${JSON.stringify(record)}\n`);
  } catch (err) {
    cacheError = `could not write ${input.lastPath}: ${message(err)}`;
  }
  return {cacheError, kind: 'written', line};
}

// ─── reading the history back ────────────────────────────────────────────────

export type SessionCostHistoryRead =
  | {kind: 'failed'; path: string; reason: string}
  | {kind: 'missing'; path: string}
  | {
      kind: 'ok';
      lines: SessionCostLine[];
      path: string;
      unreadable: UnreadableLine[];
    };

function nullableNumber(value: unknown): boolean {
  return (
    value === null || (typeof value === 'number' && Number.isFinite(value))
  );
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function lineProblem(value: unknown): string | null {
  if (!isObject(value)) return 'not a JSON object';
  if (value.schema !== COST_SCHEMA) {
    return `schema ${JSON.stringify(value.schema)}`;
  }
  if (typeof value.at !== 'string' || Number.isNaN(Date.parse(value.at))) {
    return 'no valid at';
  }
  if (typeof value.sessionId !== 'string' || value.sessionId === '') {
    return 'no sessionId';
  }
  if (
    typeof value.totalCostUsd !== 'number' ||
    !Number.isFinite(value.totalCostUsd)
  ) {
    return 'no finite totalCostUsd';
  }
  if (typeof value.decreased !== 'boolean') return 'no decreased flag';
  for (const key of [
    'linesAdded',
    'linesRemoved',
    'previousCostUsd',
    'totalApiDurationMs',
    'totalDurationMs',
  ]) {
    if (!nullableNumber(value[key])) return `${key} is not a number or null`;
  }
  for (const key of [
    'ccVersion',
    'cwd',
    'modelId',
    'project',
    'projectDir',
    'transcriptPath',
  ]) {
    if (!nullableString(value[key])) return `${key} is not a string or null`;
  }
  return null;
}

/** Read session-cost.jsonl; a malformed line is skipped AND reported. */
export function readSessionCostHistory(path: string): SessionCostHistoryRead {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (err) {
    if ((err as {code?: string}).code === 'ENOENT') {
      return {kind: 'missing', path};
    }
    return {
      kind: 'failed',
      path,
      reason: `could not read ${path}: ${message(err)}`,
    };
  }
  const lines: SessionCostLine[] = [];
  const unreadable: UnreadableLine[] = [];
  text.split('\n').forEach((raw, index) => {
    if (raw.trim() === '') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      unreadable.push({line: index + 1, reason: `not JSON: ${message(err)}`});
      return;
    }
    const problem = lineProblem(parsed);
    if (problem == null) lines.push(parsed as SessionCostLine);
    else unreadable.push({line: index + 1, reason: problem});
  });
  return {kind: 'ok', lines, path, unreadable};
}

/** Every line of one session, in the order written. */
export function sessionCostLines(
  lines: readonly SessionCostLine[],
  sessionId: string,
): SessionCostLine[] {
  return lines.filter((line) => line.sessionId === sessionId);
}

/** The newest line of each session (the last one written wins). */
export function latestCostBySession(
  lines: readonly SessionCostLine[],
): Map<string, SessionCostLine> {
  const latest = new Map<string, SessionCostLine>();
  for (const line of lines) latest.set(line.sessionId, line);
  return latest;
}

/**
 * What each line of ONE session adds: the rise from the previous line of that
 * session in the file, or, for its first line and after a decrease, the whole
 * figure (the counter started from $0). Order is the file's, not the `at`s.
 *
 * A session whose recording began after it had already spent (the recorder
 * was installed mid-session, or the per-session file was lost) puts that
 * earlier spend at its first line's time; there is nothing to place it by.
 */
export function costIncrements(
  sessionLines: readonly SessionCostLine[],
): {atMs: number; usd: number}[] {
  let previous: number | null = null;
  return sessionLines.map((line) => {
    const usd =
      previous == null || line.totalCostUsd < previous
        ? line.totalCostUsd
        : line.totalCostUsd - previous;
    previous = line.totalCostUsd;
    return {atMs: Date.parse(line.at), usd};
  });
}

export interface SessionCostSummary {
  /** The rise of the figure over lines dated in the window (costIncrements). */
  inWindowUsd: number;
  latest: SessionCostLine;
  lines: number;
  /** The session's project as its newest line has it. */
  project: string | null;
  /** How many times its figure went down (the counter restarted). */
  restarts: number;
  sessionId: string;
}

/** Each session with a line dated at or after `sinceMs`, highest figure first. */
export function summarizeSessionCosts(
  lines: readonly SessionCostLine[],
  options: {sinceMs: number},
): SessionCostSummary[] {
  const bySession = new Map<string, SessionCostLine[]>();
  for (const line of lines) {
    const list = bySession.get(line.sessionId);
    if (list == null) bySession.set(line.sessionId, [line]);
    else list.push(line);
  }
  const summaries: SessionCostSummary[] = [];
  for (const [sessionId, list] of bySession) {
    const latest = list.at(-1);
    if (latest == null || Date.parse(latest.at) < options.sinceMs) continue;
    const inWindowUsd = costIncrements(list)
      .filter((step) => step.atMs >= options.sinceMs)
      .reduce((sum, step) => sum + step.usd, 0);
    summaries.push({
      inWindowUsd,
      latest,
      lines: list.length,
      project: latest.project,
      restarts: list.filter((line, index) => {
        const before = list[index - 1];
        return before != null && line.totalCostUsd < before.totalCostUsd;
      }).length,
      sessionId,
    });
  }
  return summaries.sort(
    (a, b) => b.latest.totalCostUsd - a.latest.totalCostUsd,
  );
}

export interface ProjectCostSummary {
  /** Null: lines that named no directory. */
  project: string | null;
  sessions: number;
  /** Claude Code's figures risen over the window, summed over its sessions. */
  usd: number;
}

/** Spend per project over the window, from the per-session summaries; highest first. */
export function projectCosts(
  sessions: readonly SessionCostSummary[],
): ProjectCostSummary[] {
  const byProject = new Map<string | null, ProjectCostSummary>();
  for (const session of sessions) {
    const entry = byProject.get(session.project) ?? {
      project: session.project,
      sessions: 0,
      usd: 0,
    };
    entry.sessions += 1;
    entry.usd += session.inWindowUsd;
    byProject.set(session.project, entry);
  }
  return [...byProject.values()].sort((a, b) => b.usd - a.usd);
}
