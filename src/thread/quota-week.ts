/**
 * The live week percent (request home-base-ys9t7.5, D4, D11): the newer of
 * the statusline store's live.json (claude-usage-live.ts) and the hourly
 * /usage samples (claude-usage-samples.ts), for the all-models week; the
 * per-model weeks come from the samples alone, because no statusline payload
 * seen so far carries them.
 *
 * live.json's seven-day window is written only after the store proved it
 * fresh (a changed reading, validated: claude-usage-live.ts's header), by a
 * statusline render (`source: statusline`) or by an hourly sample
 * (`source: usage`). Its `at` is when that reading was taken, so it is
 * compared with the newest sample's `sampledAt`. A window whose reset has
 * passed is over (the store's own rule 3), so it is not used.
 *
 * A reading older than `maxAgeMinutes` (handoff.usage.maxSampleAgeMinutes) is
 * UNKNOWN, never "fine", and so is a missing or unreadable source with no
 * fresh alternative (critical rule 7). A fresh live.json does not stand in
 * for stale samples: the per-model weeks would then be unknown. The result
 * names the source it read and its age, so `thread quota` can say both.
 */

import type {UsageEnv} from '../claude-usage-samples';

import {readLive, storePaths} from '../claude-usage-live';
import {readSamples, samplesPath} from '../claude-usage-samples';

/** `live` is the statusline store's live.json; `samples` is samples.jsonl. */
export type WeekSource = 'live' | 'samples';

export interface WeekWindowReading {
  ageMinutes: number;
  /** When the reading was taken, ISO-8601. */
  at: string;
  /**
   * Who measured it: a statusline render (live.json only) or a /usage sample
   * (always, for samples.jsonl; for live.json when the sampler wrote it).
   */
  measuredBy: 'statusline' | 'usage';
  /** The file it was read from. */
  path: string;
  percent: number;
  /** The session whose statusline saw it; null for a /usage sample. */
  sessionId: string | null;
  source: WeekSource;
}

export type WeekReading =
  | {
      /** The all-models week: the newer of live.json and the samples. */
      allModels: WeekWindowReading;
      /** Each per-model week the newest sample lists, by its panel name. */
      byModel: Record<string, WeekWindowReading>;
      kind: 'known';
      /** Why a source was not used: stale, missing, expired. Never silent. */
      notes: string[];
    }
  | {kind: 'unknown'; notes: string[]; reason: string};

/** A reading this far in the future is a clock problem, not a reading. */
const FUTURE_TOLERANCE_MINUTES = 5;

/** What one source offers: a reading, or why it has none. */
export type WeekCandidate =
  | {kind: 'none'; note: string}
  | {
      allModels: WeekWindowReading;
      byModel: Record<string, WeekWindowReading> | null;
      kind: 'ok';
    };

function ageOf(at: string, nowMs: number): number {
  return (nowMs - Date.parse(at)) / 60_000;
}

function fromSamples(env: UsageEnv, nowMs: number): WeekCandidate {
  const read = readSamples(samplesPath(env));
  if (read.kind === 'missing') {
    return {kind: 'none', note: `no usage samples at ${read.path}`};
  }
  if (read.kind === 'failed') {
    return {kind: 'none', note: `the usage samples: ${read.reason}`};
  }
  if (read.lastLineUnreadable) {
    return {
      kind: 'none',
      note: `the newest line of ${read.path} could not be read; an older sample is not used in its place`,
    };
  }
  const newest = read.samples.at(-1);
  if (newest == null) {
    return {kind: 'none', note: `${read.path} holds no readable sample`};
  }
  if (!newest.ok) {
    return {
      kind: 'none',
      note: `the newest usage sample (${newest.sampledAt}) is a failed read: ${newest.reason}`,
    };
  }
  const ageMinutes = ageOf(newest.sampledAt, nowMs);
  const reading = (percent: number): WeekWindowReading => ({
    ageMinutes,
    at: newest.sampledAt,
    measuredBy: 'usage',
    path: read.path,
    percent,
    sessionId: null,
    source: 'samples',
  });
  return {
    allModels: reading(newest.week.pct),
    byModel: Object.fromEntries(
      Object.entries(newest.weekByModel).map(([model, window]) => [
        model,
        reading(window.pct),
      ]),
    ),
    kind: 'ok',
  };
}

/** live.json's seven-day window, read through the store's own reader. */
export function fromLive(env: UsageEnv, nowMs: number): WeekCandidate {
  const path = storePaths(env).live;
  const read = readLive(path);
  if (read.kind === 'missing') {
    return {kind: 'none', note: `no statusline store reading at ${path}`};
  }
  if (read.kind === 'failed') {
    return {kind: 'none', note: `the statusline store: ${read.reason}`};
  }
  const week = read.state.seven_day;
  if (week == null) {
    return {kind: 'none', note: `${path} holds no seven-day reading`};
  }
  if (week.resetsAt * 1000 <= nowMs) {
    return {
      kind: 'none',
      note: `the seven-day reading in ${path} (${week.at}) is of a window that reset at ${new Date(week.resetsAt * 1000).toISOString()}`,
    };
  }
  return {
    allModels: {
      ageMinutes: ageOf(week.at, nowMs),
      at: week.at,
      measuredBy: week.source,
      path,
      percent: week.pct,
      sessionId: week.sessionId,
      source: 'live',
    },
    byModel: null,
    kind: 'ok',
  };
}

function freshness(
  reading: WeekWindowReading,
  maxAgeMinutes: number,
): string | null {
  if (reading.ageMinutes < -FUTURE_TOLERANCE_MINUTES) {
    return `the ${reading.source} reading is dated ${reading.at}, in the future`;
  }
  if (reading.ageMinutes > maxAgeMinutes) {
    return `the ${reading.source} reading is ${Math.round(reading.ageMinutes)} minutes old (${reading.at}), older than the ${maxAgeMinutes}-minute limit`;
  }
  return null;
}

/** The pure choice between the two candidates (exported for tests). */
export function chooseWeekReading(input: {
  live: WeekCandidate;
  maxAgeMinutes: number;
  samples: WeekCandidate;
}): WeekReading {
  const notes: string[] = [];
  const fresh = (candidate: WeekCandidate): WeekWindowReading | null => {
    if (candidate.kind === 'none') {
      notes.push(candidate.note);
      return null;
    }
    const problem = freshness(candidate.allModels, input.maxAgeMinutes);
    if (problem != null) {
      notes.push(problem);
      return null;
    }
    return candidate.allModels;
  };
  const sample = fresh(input.samples);
  const live = fresh(input.live);
  if (sample == null || input.samples.kind !== 'ok') {
    return {
      kind: 'unknown',
      notes,
      reason:
        'no fresh usage sample, so the per-model weeks are unknown (the statusline carries only the all-models week)',
    };
  }
  const allModels =
    live != null && Date.parse(live.at) > Date.parse(sample.at) ? live : sample;
  return {
    allModels,
    byModel: input.samples.byModel ?? {},
    kind: 'known',
    notes,
  };
}

/** Read both sources and return the week reading, or why it is unknown. */
export function readWeekReading(input: {
  env: UsageEnv;
  maxAgeMinutes: number;
  nowMs: number;
}): WeekReading {
  return chooseWeekReading({
    live: fromLive(input.env, input.nowMs),
    maxAgeMinutes: input.maxAgeMinutes,
    samples: fromSamples(input.env, input.nowMs),
  });
}
