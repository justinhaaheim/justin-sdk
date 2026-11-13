/**
 * vitals — the record home-base's `vitals` command writes each hour, and the
 * words a mayor session's status report shows for it (home-base-sg9q9.7,
 * decisions D3 and D4 there).
 *
 * WHY (Justin, 2026-11-12): a daily health check of his Claude Code and Mac
 * setup that finds problems and brings them to him, under his design
 * principles in home-base CLAUDE.md: an alert must be rare enough to act on,
 * and it is delivered where it can be acted on.
 *
 *   <vitals state dir>/latest.json   the newest record, rewritten each run
 *   <vitals state dir>/runs.jsonl    every recorded run, one record per line
 *
 * ONE WRITER, ONE READER. home-base `vitals --record` (src/vitals/), run by
 * the hourly chores job, writes both. The status report's Part 1, in mayor
 * sessions only, reads latest.json here (thread/session-report.ts), the same
 * way it reads the chores health file (job-health.ts). This module owns the
 * format, so the writer and the reader cannot drift apart.
 *
 * THIS MODULE IS A LEAF ON PURPOSE: it imports only node's fs, os and path,
 * like job-health.ts.
 *
 * RULE 7. Each outcome is its own value, and none becomes "all clear" by
 * accident:
 *   - a check that could not run is a finding of level `error`, never `ok`
 *     (the writer's job; a record whose status disagrees with its findings
 *     does not parse);
 *   - a record with no checks reads as unknown, not as healthy;
 *   - a file that cannot be read or parsed is "vitals unknown";
 *   - a file older than VITALS_STALE_MS, or a missing file where vitals has
 *     recorded runs before, is "vitals not running": the hourly job cannot
 *     report that it did not run, so the reader's clock is the backstop.
 *
 * THE ONE QUIET CASE: no latest.json AND no runs.jsonl beside it means vitals
 * has never recorded on this machine, which shows nothing.
 */

import {readFileSync, statSync} from 'fs';
import {homedir} from 'os';
import {join} from 'path';

/** Moves every vitals file (latest.json, runs.jsonl, home-base's triggered.json). */
export const VITALS_STATE_DIR_ENV = 'VITALS_STATE_DIR';
export const VITALS_LATEST_FILE_NAME = 'latest.json';
export const VITALS_RUNS_FILE_NAME = 'runs.jsonl';
export const VITALS_VERSION = 1;

/**
 * D4: a latest.json older than this is itself a problem. The job runs hourly
 * at about :57, so a normal file is at most about an hour old; three hours
 * leaves two missed ticks of room.
 */
export const VITALS_STALE_MS = 3 * 60 * 60 * 1000;

/** The command that shows the details, named in the report line. */
export const VITALS_DETAILS_COMMAND = 'vitals';

/**
 * The check the status report leaves out: its Jobs line already shows what the
 * chores health file says (D4).
 */
export const VITALS_JOBS_CHECK = 'jobs';

export const VITALS_STATUSES = ['ok', 'warning', 'error'] as const;
export type VitalsStatus = (typeof VITALS_STATUSES)[number];
export type VitalsLevel = Exclude<VitalsStatus, 'ok'>;

/** why-slow's grade of a resource (src/why-slow/analyze.ts `Level`). */
export const VITALS_GRADES = ['ok', 'strained', 'severe'] as const;
export type VitalsGrade = (typeof VITALS_GRADES)[number];

/** One problem a check found. */
export interface VitalsFinding {
  /**
   * Stable: the check plus the kind of problem (`disk:low`, `jobs:<job id>`,
   * `cpu:unchecked`). Dispatch B of home-base-sg9q9.7 (D5) starts at most one
   * research session per key, so a key must not change while the problem lasts.
   */
  key: string;
  level: VitalsLevel;
  /** One line, plain words: what the check saw. */
  summary: string;
}

export interface VitalsCheck {
  /** Stable id: `jobs`, `usage-samples`, `disk`, `cpu`, `memory`. */
  check: string;
  /** Empty exactly when `status` is `ok`. */
  findings: VitalsFinding[];
  /** The check in plain words, as Justin reads it: "usage samples". */
  name: string;
  /** The worst level among `findings`, or `ok` when there are none. */
  status: VitalsStatus;
  /** One line: the findings' summaries, or what was fine. */
  summary: string;
}

/**
 * why-slow's grade of each resource in this run, or null when it could not be
 * graded. The next runs read these: a bad grade warns only when the last three
 * hourly runs all had it (D2).
 */
export interface VitalsGrades {
  cpu: VitalsGrade | null;
  memory: VitalsGrade | null;
}

export interface VitalsRecord {
  /** When the run took its measurements, ISO-8601. */
  at: string;
  checks: VitalsCheck[];
  grades: VitalsGrades;
  version: typeof VITALS_VERSION;
}

type Env = Readonly<Record<string, string | undefined>>;

function fromEnv(env: Env, key: string): string | null {
  const value = env[key]?.trim();
  return value == null || value === '' ? null : value;
}

/**
 * VITALS_STATE_DIR, else `$XDG_STATE_HOME/vitals`, else `~/.local/state/vitals`.
 * Never ~/Library (home-base CLAUDE.md, Conventions).
 */
export function vitalsStateDir(env: Env): string {
  return (
    fromEnv(env, VITALS_STATE_DIR_ENV) ??
    join(
      fromEnv(env, 'XDG_STATE_HOME') ?? join(homedir(), '.local', 'state'),
      'vitals',
    )
  );
}

export function vitalsLatestPath(env: Env): string {
  return join(vitalsStateDir(env), VITALS_LATEST_FILE_NAME);
}

export function vitalsRunsPath(env: Env): string {
  return join(vitalsStateDir(env), VITALS_RUNS_FILE_NAME);
}

const LEVEL_RANK: Record<VitalsStatus, number> = {error: 2, ok: 0, warning: 1};

/** The worst level among `findings`; `ok` for none. */
export function worstStatus(findings: readonly VitalsFinding[]): VitalsStatus {
  let worst: VitalsStatus = 'ok';
  for (const finding of findings) {
    if (LEVEL_RANK[finding.level] > LEVEL_RANK[worst]) worst = finding.level;
  }
  return worst;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | null {
  const code = (error as {code?: unknown} | null)?.code;
  return typeof code === 'string' ? code : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isInstant(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isLevel(value: unknown): value is VitalsLevel {
  return value === 'warning' || value === 'error';
}

function isStatus(value: unknown): value is VitalsStatus {
  return (
    typeof value === 'string' &&
    (VITALS_STATUSES as readonly string[]).includes(value)
  );
}

function isGradeOrNull(value: unknown): value is VitalsGrade | null {
  return (
    value === null ||
    (typeof value === 'string' &&
      (VITALS_GRADES as readonly string[]).includes(value))
  );
}

function parseFinding(value: unknown, where: string): VitalsFinding | string {
  if (!isObject(value)) return `${where} is not an object`;
  const {key, level, summary} = value;
  if (!isText(key)) return `${where}.key is not a non-empty string`;
  if (!isLevel(level)) return `${where}.level is neither warning nor error`;
  if (!isText(summary)) return `${where}.summary is not a non-empty string`;
  return {key, level, summary};
}

function parseCheck(value: unknown, index: number): VitalsCheck | string {
  const where = `checks[${index}]`;
  if (!isObject(value)) return `${where} is not an object`;
  const {check, findings, name, status, summary} = value;
  if (!isText(check)) return `${where}.check is not a non-empty string`;
  if (!isText(name)) return `${where}.name is not a non-empty string`;
  if (!isStatus(status)) return `${where}.status is not ok, warning or error`;
  if (!isText(summary)) return `${where}.summary is not a non-empty string`;
  if (!Array.isArray(findings)) return `${where}.findings is not an array`;
  const parsed: VitalsFinding[] = [];
  for (const [i, entry] of findings.entries()) {
    const finding = parseFinding(entry, `${where}.findings[${i}]`);
    if (typeof finding === 'string') return finding;
    parsed.push(finding);
  }
  // An `ok` that carries findings, or a `warning` with none, is a writer bug
  // that could hide a problem: refuse it rather than pick one of the two.
  if (worstStatus(parsed) !== status) {
    return `${where}.status is ${status}, but its findings say ${worstStatus(parsed)}`;
  }
  return {check, findings: parsed, name, status, summary};
}

/** A parsed record, or why the value is not one. */
export function parseVitalsRecord(
  value: unknown,
): {error: string; ok: false} | {ok: true; record: VitalsRecord} {
  if (!isObject(value)) return {error: 'not a JSON object', ok: false};
  const {at, checks, grades, version} = value;
  if (version !== VITALS_VERSION) {
    return {
      error: `version is ${String(version)}, not ${VITALS_VERSION}`,
      ok: false,
    };
  }
  if (!isInstant(at)) return {error: '`at` is not a timestamp', ok: false};
  if (!Array.isArray(checks)) {
    return {error: '`checks` is not an array', ok: false};
  }
  if (
    !isObject(grades) ||
    !isGradeOrNull(grades.cpu) ||
    !isGradeOrNull(grades.memory)
  ) {
    return {
      error: '`grades` is not {cpu, memory}, each a grade or null',
      ok: false,
    };
  }
  const parsed: VitalsCheck[] = [];
  for (const [index, entry] of checks.entries()) {
    const check = parseCheck(entry, index);
    if (typeof check === 'string') return {error: check, ok: false};
    parsed.push(check);
  }
  return {
    ok: true,
    record: {
      at,
      checks: parsed,
      grades: {cpu: grades.cpu, memory: grades.memory},
      version: VITALS_VERSION,
    },
  };
}

/** A record from text (one latest.json, or one runs.jsonl line). */
export function parseVitalsText(
  text: string,
): {error: string; ok: false} | {ok: true; record: VitalsRecord} {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {error: `not JSON: ${errorText(error)}`, ok: false};
  }
  return parseVitalsRecord(raw);
}

export type VitalsRead =
  /**
   * No latest.json. `vitalsHasRun` says whether runs.jsonl is beside where it
   * would be: true, false, or null when that could not be checked.
   */
  | {kind: 'absent'; path: string; vitalsHasRun: boolean | null}
  | {error: string; kind: 'unreadable'; path: string}
  | {kind: 'read'; path: string; record: VitalsRecord};

/** Read latest.json. Never throws. */
export function readVitals(env: Env): VitalsRead {
  const path = vitalsLatestPath(env);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      return {error: errorText(error), kind: 'unreadable', path};
    }
    let vitalsHasRun: boolean | null;
    try {
      statSync(vitalsRunsPath(env));
      vitalsHasRun = true;
    } catch (statError) {
      vitalsHasRun = errorCode(statError) === 'ENOENT' ? false : null;
    }
    return {kind: 'absent', path, vitalsHasRun};
  }
  const parsed = parseVitalsText(text);
  return parsed.ok
    ? {kind: 'read', path, record: parsed.record}
    : {error: parsed.error, kind: 'unreadable', path};
}

/** What the report shows. `null` from `vitalsNotice` means nothing to show. */
export type VitalsNotice =
  | {
      /** The file's age when it is stale; null when it is missing. */
      ageMs: number | null;
      kind: 'not-running';
      path: string;
    }
  | {checks: VitalsCheck[]; kind: 'problems'}
  | {error: string; kind: 'unknown'; path: string};

/**
 * Turn a read into what to show. `null` is a claim: the file is fresh and every
 * check other than jobs is ok, or vitals has never recorded on this machine.
 */
export function vitalsNotice(read: VitalsRead, now: Date): VitalsNotice | null {
  if (read.kind === 'unreadable') {
    return {error: read.error, kind: 'unknown', path: read.path};
  }
  if (read.kind === 'absent') {
    if (read.vitalsHasRun === false) return null;
    if (read.vitalsHasRun == null) {
      return {
        error:
          'there is no latest result, and whether vitals has run here could not be checked',
        kind: 'unknown',
        path: read.path,
      };
    }
    return {ageMs: null, kind: 'not-running', path: read.path};
  }
  const {record} = read;
  // A future `at` (clock skew) is not stale.
  const ageMs = now.getTime() - Date.parse(record.at);
  if (ageMs > VITALS_STALE_MS) {
    return {ageMs, kind: 'not-running', path: read.path};
  }
  if (record.checks.length === 0) {
    return {
      error: 'the latest result lists no checks',
      kind: 'unknown',
      path: read.path,
    };
  }
  const shown = record.checks.filter(
    (check) => check.status !== 'ok' && check.check !== VITALS_JOBS_CHECK,
  );
  return shown.length === 0 ? null : {checks: shown, kind: 'problems'};
}

function hoursWords(ageMs: number): string {
  const hours = Math.floor(ageMs / (60 * 60 * 1000));
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

/**
 * The status report's Vitals line, without its label: each check that is not
 * ok, in plain words. The caller adds the details command.
 */
export function vitalsReportText(notice: VitalsNotice): string {
  switch (notice.kind) {
    case 'problems': {
      const icon = notice.checks.some((check) => check.status === 'error')
        ? '🛑'
        : '⚠️';
      return `${icon} ${notice.checks
        .map((check) => `${check.name}: ${check.summary}`)
        .join('; ')}`;
    }
    case 'not-running':
      return notice.ageMs == null
        ? '⚠️ vitals not running: it has recorded runs on this Mac, but there is no latest result'
        : `⚠️ vitals not running: its latest result is ${hoursWords(notice.ageMs)} old`;
    case 'unknown':
      return `⚠️ vitals unknown: ${notice.error}`;
  }
}
