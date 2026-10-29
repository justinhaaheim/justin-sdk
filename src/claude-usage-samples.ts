/**
 * samples — the history file: one JSON record per `/usage` sample, appended and
 * never rewritten (home-base-jptgj D3).
 *
 * A successful sample:
 *   {schema: 1, sampledAt, ok: true, session, week, weekByModel, raw}
 * A failed one:
 *   {schema: 1, sampledAt, ok: false, reason}
 * Either may also carry `trigger` and `failedAttempts` (home-base-neapv.5);
 * both are optional and absent on older records.
 *
 * A failed read is APPENDED, never skipped and never written as 0% (critical
 * rule 7): a gap in the history has to be visible as a gap. `raw` is the whole
 * panel, kept as the canary for parser drift and so the "What's contributing"
 * section is history too.
 *
 * ONE IMPLEMENTATION (epic home-base-mbnjv C11, 2026-10-29): this module
 * moved here from home-base's src/claude-usage/samples.ts, with `dataDir` and
 * `samplesPath` from its paths.ts, so the hourly sampler that writes the
 * history (home-base `claude-usage sample`) and the handoff gate that reads
 * it (thread/handoff-gate.ts) share one record format and one path rule.
 * Behaviour is unchanged by the move.
 */
import type {UsagePanelRead, UsageWindow} from './claude-usage';

import {appendFileSync, mkdirSync, readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';

// ---------------------------------------------------------------------------
// Where the history lives
// ---------------------------------------------------------------------------

/** Replaces the whole data directory, so tests never touch the real one. */
export const DATA_DIR_ENV = 'CLAUDE_USAGE_DATA_DIR';

export type UsageEnv = Readonly<Record<string, string | undefined>>;

function fromEnv(env: UsageEnv, key: string): string | null {
  const value = env[key]?.trim();
  // An empty override is a mistake, not a request for the current directory.
  return value == null || value === '' ? null : value;
}

/**
 * `~/.local/share/claude-usage`, or its XDG / env override: $CLAUDE_USAGE_DATA_DIR,
 * else $XDG_DATA_HOME/claude-usage. XDG data, never ~/Library: the history is
 * data Justin would miss (home-base-jptgj D3).
 */
export function dataDir(env: UsageEnv = process.env): string {
  return (
    fromEnv(env, DATA_DIR_ENV) ??
    join(
      fromEnv(env, 'XDG_DATA_HOME') ?? join(homedir(), '.local', 'share'),
      'claude-usage',
    )
  );
}

/** The append-only history: one JSON record per sample. */
export function samplesPath(env: UsageEnv = process.env): string {
  return join(dataDir(env), 'samples.jsonl');
}

// ---------------------------------------------------------------------------
// The records
// ---------------------------------------------------------------------------

export const SCHEMA = 1;

/**
 * Why a sample was taken (home-base-neapv). `hourly` is the chores job,
 * `near-reset` an extra read the statusline starts in the hour before the
 * weekly reset, `manual` anything run by hand. Records from before 2026-10-17
 * carry no trigger; they were all hourly.
 */
export const SAMPLE_TRIGGERS = ['hourly', 'manual', 'near-reset'] as const;
export type SampleTrigger = (typeof SAMPLE_TRIGGERS)[number];

/** One attempt that failed before the record's own outcome (neapv.5). */
export interface FailedAttempt {
  reason: string;
  sampledAt: string;
}

/**
 * Optional on both arms and absent when empty, so a schema-1 record from
 * before neapv.5 still reads exactly as it did.
 */
interface SampleExtras {
  /** Attempts that failed before this outcome, oldest first. */
  failedAttempts?: FailedAttempt[];
  trigger?: SampleTrigger;
}

export interface OkSample extends SampleExtras {
  ok: true;
  raw: string;
  sampledAt: string;
  schema: typeof SCHEMA;
  session: UsageWindow;
  week: UsageWindow;
  weekByModel: Record<string, UsageWindow>;
}

export interface FailedSample extends SampleExtras {
  ok: false;
  reason: string;
  sampledAt: string;
  schema: typeof SCHEMA;
}

export type Sample = FailedSample | OkSample;

/** A line of the history that is not a sample this code understands. */
export interface UnreadableLine {
  line: number;
  reason: string;
}

/**
 * What reading the history produced. `missing` (no file yet) is not `ok` with
 * no samples, and neither is a file that could not be read at all.
 */
export type SamplesRead =
  | {kind: 'failed'; path: string; reason: string}
  | {kind: 'missing'; path: string}
  | {
      kind: 'ok';
      /**
       * The file's last non-empty line is one of `unreadable` (home-base-mbnjv.8
       * F20): the newest sample may be the one that could not be read, so
       * `samples.at(-1)` is not proven to be the newest.
       */
      lastLineUnreadable: boolean;
      path: string;
      /** In file order, which is sample order. */
      samples: Sample[];
      /** Lines that were skipped, each with why — never silently. */
      unreadable: UnreadableLine[];
    };

/** The record one read becomes. */
export function sampleFromRead(
  read: UsagePanelRead,
  extras: {
    failedAttempts?: readonly FailedAttempt[];
    trigger?: SampleTrigger;
  } = {},
): Sample {
  const extra: SampleExtras = {
    ...(extras.failedAttempts != null &&
      extras.failedAttempts.length > 0 && {
        failedAttempts: [...extras.failedAttempts],
      }),
    ...(extras.trigger != null && {trigger: extras.trigger}),
  };
  if (read.kind === 'failed') {
    return {
      ok: false,
      reason: read.reason,
      sampledAt: read.sampledAt,
      schema: SCHEMA,
      ...extra,
    };
  }
  return {
    ok: true,
    raw: read.raw,
    sampledAt: read.sampledAt,
    schema: SCHEMA,
    session: read.panel.session,
    week: read.panel.week,
    weekByModel: read.panel.weekByModel,
    ...extra,
  };
}

/**
 * Append one record as one line, with ONE write call, creating the directory
 * on first use. `appendFileSync` opens with O_APPEND, so the line lands whole at
 * the end of the file.
 */
export function appendSample(path: string, sample: Sample): void {
  mkdirSync(dirname(path), {recursive: true});
  appendFileSync(path, `${JSON.stringify(sample)}\n`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isWindow(value: unknown): value is UsageWindow {
  return (
    isObject(value) &&
    typeof value.pct === 'number' &&
    Number.isFinite(value.pct) &&
    isNullableString(value.resetsAt) &&
    isNullableString(value.resetsAtError) &&
    isNullableString(value.resetsText)
  );
}

/** Why `value` is not a schema-1 sample, or null when it is one. */
function sampleProblem(value: unknown): string | null {
  if (!isObject(value)) return 'not a JSON object';
  if (value.schema !== SCHEMA) {
    return `schema ${JSON.stringify(value.schema)} is not one this version reads (${SCHEMA})`;
  }
  if (
    typeof value.sampledAt !== 'string' ||
    Number.isNaN(Date.parse(value.sampledAt))
  ) {
    return 'no valid sampledAt';
  }
  if (value.ok === false) {
    return typeof value.reason === 'string'
      ? null
      : 'a failed sample with no reason';
  }
  if (value.ok !== true) return '`ok` is neither true nor false';
  if (!isWindow(value.session)) return 'no valid session window';
  if (!isWindow(value.week)) return 'no valid week window';
  if (
    !isObject(value.weekByModel) ||
    !Object.values(value.weekByModel).every(isWindow)
  ) {
    return 'no valid weekByModel';
  }
  if (typeof value.raw !== 'string') return 'no raw panel text';
  return null;
}

/**
 * Read the whole history.
 *
 * A malformed line is skipped AND reported with its line number, rather than
 * failing the whole read: the file is append-only, so a line torn by a power
 * cut would otherwise blind the history and the phone summary until someone
 * edited the file by hand. Every consumer prints the unreadable count.
 */
export function readSamples(path: string): SamplesRead {
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
      reason: `could not read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const samples: Sample[] = [];
  const unreadable: UnreadableLine[] = [];
  let lastLine = 0;
  text.split('\n').forEach((line, index) => {
    if (line.trim() === '') return;
    lastLine = index + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      unreadable.push({
        line: index + 1,
        reason: `not JSON: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    const problem = sampleProblem(parsed);
    if (problem == null) {
      samples.push(parsed as Sample);
    } else {
      unreadable.push({line: index + 1, reason: problem});
    }
  });
  return {
    kind: 'ok',
    lastLineUnreadable: unreadable.some((entry) => entry.line === lastLine),
    path,
    samples,
    unreadable,
  };
}
