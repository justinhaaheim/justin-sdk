/**
 * A project's unattended spend over the last 24 hours (request
 * home-base-ys9t7.5, D3).
 *
 * THE PROJECT is a repo and its `.claude/worktrees/` checkouts: every
 * transcript directory whose slug, worktrees folded (usage-attribution.ts's
 * foldWorktreeSlug, as `claude-usage calibrate` folds them), is the repo's.
 *
 * ITS SPEND is every request in those directories (main transcripts, their
 * subagents, older-layout `agent-<id>.jsonl` files; each request once) dated
 * inside the rolling window AND after the latest line Justin typed in any
 * session of the project. Rolling, not since midnight: a chain across
 * midnight would otherwise get two days' budget, and midnight is a timezone
 * question (D3). Only files modified inside the window are read: a
 * transcript is append-only, so an older file holds no request in it, and a
 * typed line older than the window cannot move a cut-off that the window
 * already sets.
 *
 * CRITICAL RULE 7 (D10). An unlistable directory, an unreadable file, a typed
 * line or a request with no timestamp, and a model with no list price (with
 * the priced part kept as a lower bound) make the result `unknown`.
 */

import type {CostRequest} from '../session-cost';
import type {QuotaRateFamily} from './defaults';
import type {SpendTotals} from './quota-spend';

import {readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';

import {estimateCost} from '../session-cost';
import {foldWorktreeSlug} from '../usage-attribution';
import {earliestOf, requestsAfter} from './quota-group';
import {latestTyped, readSpendTranscript} from './quota-read';
import {weekSpendOf} from './quota-spend';
import {projectDirSlug} from './transcript-messages';

export const PROJECT_WINDOW_MS = 24 * 60 * 60 * 1000;

export type ProjectSpend =
  | {
      /**
       * Epoch ms of the cut-off: requests strictly after it count. Just before
       * the window start, or the latest typed line when that is later.
       */
      cutoffMs: number;
      /** The project dirs read (the repo's and its worktrees'). */
      dirs: string[];
      /** Transcript files read (modified inside the window). */
      files: number;
      firstCountedAtMs: number | null;
      kind: 'known';
      latestTypedAtMs: number | null;
      projectSlug: string;
      requests: number;
      spend: SpendTotals;
      unparseableLines: number;
      windowStartMs: number;
    }
  | {
      kind: 'unknown';
      lowerBound: SpendTotals | null;
      projectSlug: string;
      reason: string;
    };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  return (error as {code?: string}).code ?? '';
}

/**
 * Every `.jsonl` under one project dir modified at or after `sinceMs`: its
 * top-level files and each session's `subagents/agent-*.jsonl`. Throws when a
 * directory that exists cannot be listed or a file cannot be stat'd.
 */
export function transcriptFilesSince(dir: string, sinceMs: number): string[] {
  const files: string[] = [];
  const entries = readdirSync(dir, {withFileTypes: true});
  const newEnough = (path: string): boolean =>
    statSync(path).mtimeMs >= sinceMs;
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      if (newEnough(path)) files.push(path);
      continue;
    }
    if (!entry.isDirectory()) continue;
    let subs: string[];
    try {
      subs = readdirSync(join(path, 'subagents'));
    } catch (error) {
      if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') {
        continue;
      }
      throw error;
    }
    for (const name of subs) {
      if (!name.startsWith('agent-') || !name.endsWith('.jsonl')) continue;
      const sub = join(path, 'subagents', name);
      if (newEnough(sub)) files.push(sub);
    }
  }
  return files.sort();
}

/**
 * The spend of the project holding `checkoutPath` (the repo root or any of
 * its `.claude/worktrees/` checkouts) in the window ending at `nowMs`.
 */
export async function measureProjectSpend(input: {
  checkoutPath: string;
  dollarsPerWeekPercent: Readonly<Record<QuotaRateFamily, number>>;
  nowMs: number;
  /** ~/.claude/projects, or the transcripts-root override. */
  projectsRoot: string;
  windowMs?: number;
}): Promise<ProjectSpend> {
  const projectSlug = foldWorktreeSlug(projectDirSlug(input.checkoutPath));
  const windowStartMs = input.nowMs - (input.windowMs ?? PROJECT_WINDOW_MS);
  const unknown = (reason: string): ProjectSpend => ({
    kind: 'unknown',
    lowerBound: null,
    projectSlug,
    reason,
  });

  let names: string[];
  try {
    names = readdirSync(input.projectsRoot);
  } catch (error) {
    return unknown(
      `the transcripts root ${input.projectsRoot} could not be listed: ${errorText(error)}`,
    );
  }
  const dirs = names
    .filter((name) => foldWorktreeSlug(name) === projectSlug)
    .sort()
    .map((name) => join(input.projectsRoot, name));

  const files: string[] = [];
  for (const dir of dirs) {
    try {
      files.push(...transcriptFilesSince(dir, windowStartMs));
    } catch (error) {
      return unknown(`${dir} could not be listed: ${errorText(error)}`);
    }
  }

  const requests = new Map<string, CostRequest>();
  const typed: (number | null)[] = [];
  let unparseableLines = 0;
  for (const file of files) {
    try {
      const read = await readSpendTranscript(file, requests);
      typed.push(...read.typedAtMs);
      unparseableLines += read.unparseableLines;
    } catch (error) {
      return unknown(`${file} could not be read: ${errorText(error)}`);
    }
  }

  const latest = latestTyped(typed);
  if (latest.kind === 'undated') {
    return unknown(
      'a line Justin typed in the project carries no timestamp, so where its unattended work starts is unknown',
    );
  }
  const latestTypedAtMs = latest.kind === 'at' ? latest.atMs : null;
  // A request exactly at the window start is inside the window.
  const cutoffMs = Math.max(windowStartMs - 1, latestTypedAtMs ?? -Infinity);
  const counted = requestsAfter(requests.values(), cutoffMs);
  if (counted.kind === 'undated') {
    return unknown(
      `${counted.undated} request(s) in the project carry no timestamp, so whether they fall inside the window is unknown`,
    );
  }
  const spend = weekSpendOf(
    estimateCost(counted.requests),
    input.dollarsPerWeekPercent,
  );
  if (spend.kind === 'unknown') {
    return {
      kind: 'unknown',
      lowerBound: spend.lowerBound,
      projectSlug,
      reason: spend.reason,
    };
  }
  return {
    cutoffMs,
    dirs,
    files: files.length,
    firstCountedAtMs: earliestOf(counted.requests),
    kind: 'known',
    latestTypedAtMs,
    projectSlug,
    requests: counted.requests.length,
    spend: {
      byFamily: spend.byFamily,
      usd: spend.usd,
      weekPercent: spend.weekPercent,
    },
    unparseableLines,
    windowStartMs,
  };
}
