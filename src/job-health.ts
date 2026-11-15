/**
 * job-health — the one small file that says which recurring jobs on this Mac
 * are broken, and the words every reader shows for it (home-base-1rxt0.10,
 * decisions D1, D2, D4 and D5 there).
 *
 * WHY (Justin, 2026-11-12): the life repo's 9am run failed every morning for
 * two weeks and he never heard about it. "At a minimum we need to set up some
 * much clearer alerting/monitoring so that I/we know right away when something
 * that's supposed to be running regularly 'hasn't been working for almost two
 * weeks'."
 *
 *   <chores state dir>/health.json
 *     {version: 1, at, checked, problems: [{id, name, kind, since, reason}]}
 *
 * ONE WRITER, SEVERAL READERS. home-base's chores runner writes it after every
 * hourly tick (src/chores/health.ts). The status report's Part 1, in mayor
 * sessions only (thread/part-one.ts, through session-report.ts), home-base
 * `vitals` (src/vitals/checks.ts), and the first-prompt repo-state block in a
 * repo that sets `componentConfig["job-health"].sessionNotice` (first-prompt.ts,
 * home-base-9dcx9.2; home-base sets it) read it. Every reader goes through
 * `readJobHealth` and `jobHealthNotice` here, so the rules below are decided
 * once. The Claude Code statusline does NOT read it: its alert was removed on
 * 2026-11-14 (home-base-9dcx9.1; Justin wants broken jobs raised where he can
 * act on them).
 *
 * THIS MODULE IS A LEAF ON PURPOSE: it imports only node's fs, os and path, so
 * any reader can import it cheaply.
 *
 * RULE 7, the whole point. Each outcome is its own value, and none of them
 * becomes "all clear" by accident:
 *   - a problem list that is empty means "checked every job, none broken";
 *     `checked: 0` is not that, and reads as unknown;
 *   - a job that could not be checked is a problem of kind `unknown`, never
 *     left out (the writer's job);
 *   - a file that cannot be read or parsed is "job health unknown";
 *   - a file older than JOB_HEALTH_STALE_MS, or a missing file where chores
 *     has run before, is "chores not running": the runner cannot report that
 *     it did not run (home-base src/chores/CLAUDE.md, rule 3), so the reader's
 *     clock is the only backstop.
 *
 * THE ONE QUIET CASE (D5): no health file AND no chores run log beside it
 * means chores has never run on this machine (another Mac, a fresh account).
 * That shows nothing, so a machine without chores does not carry a warning
 * forever. Where the run log's existence cannot be checked, it is unknown.
 */

import {mkdirSync, readFileSync, renameSync, statSync, writeFileSync} from 'fs';
import {homedir} from 'os';
import {dirname, join} from 'path';

/** Moves every chores path, the health file included (home-base src/chores/paths.ts). */
export const CHORES_STATE_DIR_ENV = 'CHORES_STATE_DIR';
export const JOB_HEALTH_FILE_NAME = 'health.json';
/** The run log chores appends to; its existence means chores has run here. */
export const CHORES_RUNS_FILE_NAME = 'runs.jsonl';
export const JOB_HEALTH_VERSION = 1;

/**
 * A health file older than this means the hourly runner stopped writing it.
 * The agent ticks hourly at :57, and a tick writes the file after its jobs, so
 * a normal file is at most about an hour old, plus the longest job of a tick.
 * Two and a half hours leaves one missed tick of room (D4).
 */
export const JOB_HEALTH_STALE_MS = 150 * 60 * 1000;

/** The command that shows the details, named in every notice. */
export const JOB_HEALTH_DETAILS_COMMAND = 'chores';

export const JOB_PROBLEM_KINDS = [
  'failing',
  'never-run',
  'overdue',
  'unknown',
] as const;

/**
 * - `failing`: its last conclusive run failed.
 * - `overdue`: it did not run when it should have (a chores job with no
 *   success in a whole missed unit; a watched job whose day has no output).
 * - `never-run`: no conclusive attempt has ever been recorded.
 * - `unknown`: it could not be checked.
 */
export type JobProblemKind = (typeof JOB_PROBLEM_KINDS)[number];

export interface JobProblem {
  /** Stable id: the chores job id, or the watched entry's id. */
  id: string;
  kind: JobProblemKind;
  /** The job in plain words, as Justin reads it: "life daily run". */
  name: string;
  /** One line: what the check saw. */
  reason: string;
  /** ISO-8601 instant the current breakage began; null when not known. */
  since: string | null;
}

export interface JobHealthFile {
  /** When the runner wrote this file, ISO-8601. */
  at: string;
  /** How many jobs were checked: registered plus watched. */
  checked: number;
  /** Every job that is not checked-and-fine. Empty: none broken. */
  problems: JobProblem[];
  version: typeof JOB_HEALTH_VERSION;
}

type Env = Readonly<Record<string, string | undefined>>;

function fromEnv(env: Env, key: string): string | null {
  const value = env[key]?.trim();
  return value == null || value === '' ? null : value;
}

/**
 * The chores state dir: CHORES_STATE_DIR, else `$XDG_STATE_HOME/chores`, else
 * `~/.local/state/chores`. The same rule as `stateDir` in home-base
 * src/chores/paths.ts; a test there asserts the two agree.
 */
export function choresStateDir(env: Env): string {
  return (
    fromEnv(env, CHORES_STATE_DIR_ENV) ??
    join(
      fromEnv(env, 'XDG_STATE_HOME') ?? join(homedir(), '.local', 'state'),
      'chores',
    )
  );
}

export function jobHealthPath(env: Env): string {
  return join(choresStateDir(env), JOB_HEALTH_FILE_NAME);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | null {
  const code = (error as {code?: unknown} | null)?.code;
  return typeof code === 'string' ? code : null;
}

function isInstant(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isKind(value: unknown): value is JobProblemKind {
  return (
    typeof value === 'string' &&
    (JOB_PROBLEM_KINDS as readonly string[]).includes(value)
  );
}

function parseProblem(value: unknown, index: number): JobProblem | string {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return `problems[${index}] is not an object`;
  }
  const {id, kind, name, reason, since} = value as Record<string, unknown>;
  if (!isText(id)) return `problems[${index}].id is not a non-empty string`;
  if (!isKind(kind)) return `problems[${index}].kind is not a known kind`;
  if (!isText(name)) return `problems[${index}].name is not a non-empty string`;
  if (!isText(reason)) {
    return `problems[${index}].reason is not a non-empty string`;
  }
  if (since !== null && !isInstant(since)) {
    return `problems[${index}].since is neither null nor a timestamp`;
  }
  return {id, kind, name, reason, since};
}

/** The file's text as the documented shape, or why it is not that shape. */
export function parseJobHealth(
  text: string,
): {error: string; ok: false} | {health: JobHealthFile; ok: true} {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {error: `not JSON: ${errorText(error)}`, ok: false};
  }
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {error: 'not a JSON object', ok: false};
  }
  const {at, checked, problems, version} = raw as Record<string, unknown>;
  if (version !== JOB_HEALTH_VERSION) {
    return {error: `version is ${String(version)}, not 1`, ok: false};
  }
  if (!isInstant(at)) return {error: '`at` is not a timestamp', ok: false};
  if (
    typeof checked !== 'number' ||
    !Number.isInteger(checked) ||
    checked < 0
  ) {
    return {error: '`checked` is not a whole number', ok: false};
  }
  if (!Array.isArray(problems)) {
    return {error: '`problems` is not an array', ok: false};
  }
  const parsed: JobProblem[] = [];
  for (const [index, entry] of problems.entries()) {
    const problem = parseProblem(entry, index);
    if (typeof problem === 'string') return {error: problem, ok: false};
    parsed.push(problem);
  }
  return {
    health: {at, checked, problems: parsed, version: JOB_HEALTH_VERSION},
    ok: true,
  };
}

export type JobHealthWrite =
  | {error: string; kind: 'failed'; path: string}
  | {kind: 'written'; path: string};

/**
 * Write the file whole: a temp file, then a rename, so a reader never sees half
 * of one. Never throws; a failed write is its own result.
 */
export function writeJobHealth(
  path: string,
  health: JobHealthFile,
): JobHealthWrite {
  const temp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(temp, `${JSON.stringify(health, null, 2)}\n`);
    renameSync(temp, path);
    return {kind: 'written', path};
  } catch (error) {
    return {error: errorText(error), kind: 'failed', path};
  }
}

export type JobHealthRead =
  /**
   * No health file. `choresHasRun` says whether chores's run log is beside
   * where it would be: true, false, or null when that could not be checked.
   */
  | {choresHasRun: boolean | null; kind: 'absent'; path: string}
  | {error: string; kind: 'unreadable'; path: string}
  | {health: JobHealthFile; kind: 'read'; path: string};

/** Read the health file. Never throws. */
export function readJobHealth(env: Env): JobHealthRead {
  const path = jobHealthPath(env);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      return {error: errorText(error), kind: 'unreadable', path};
    }
    let choresHasRun: boolean | null;
    try {
      statSync(join(choresStateDir(env), CHORES_RUNS_FILE_NAME));
      choresHasRun = true;
    } catch (statError) {
      choresHasRun = errorCode(statError) === 'ENOENT' ? false : null;
    }
    return {choresHasRun, kind: 'absent', path};
  }
  const parsed = parseJobHealth(text);
  return parsed.ok
    ? {health: parsed.health, kind: 'read', path}
    : {error: parsed.error, kind: 'unreadable', path};
}

/** What a reader shows. `null` from `jobHealthNotice` means nothing to show. */
export type JobHealthNotice =
  | {
      /** The file's age when it is stale; null when it is missing. */
      ageMs: number | null;
      kind: 'not-running';
      path: string;
    }
  | {error: string; kind: 'unknown'; path: string}
  | {kind: 'broken'; problems: JobProblem[]};

/**
 * Turn a read into what to show. `null` is a claim: the file is fresh and
 * lists no problem, or chores has never run on this machine.
 */
export function jobHealthNotice(
  read: JobHealthRead,
  now: Date,
): JobHealthNotice | null {
  if (read.kind === 'unreadable') {
    return {error: read.error, kind: 'unknown', path: read.path};
  }
  if (read.kind === 'absent') {
    if (read.choresHasRun === false) return null;
    if (read.choresHasRun == null) {
      return {
        error:
          'there is no health file, and whether chores has run here could not be checked',
        kind: 'unknown',
        path: read.path,
      };
    }
    return {ageMs: null, kind: 'not-running', path: read.path};
  }
  const {health} = read;
  // A future `at` (clock skew) is not stale.
  const ageMs = now.getTime() - Date.parse(health.at);
  if (ageMs > JOB_HEALTH_STALE_MS) {
    return {ageMs, kind: 'not-running', path: read.path};
  }
  if (health.problems.length > 0) {
    return {kind: 'broken', problems: health.problems};
  }
  if (health.checked === 0) {
    return {
      error: 'the health file says chores checked no jobs',
      kind: 'unknown',
      path: read.path,
    };
  }
  return null;
}

// ─── words ───────────────────────────────────────────────────────────────────

/** How each kind reads after the job's name. */
export function problemWords(kind: JobProblemKind): string {
  switch (kind) {
    case 'failing':
      return 'failing';
    case 'never-run':
      return 'never run';
    case 'overdue':
      return 'not running';
    case 'unknown':
      return 'unknown';
  }
}

const HOUR_MS = 60 * 60 * 1000;

/** YYYY-MM-DD of an instant in `timeZone` (undefined: this machine's). */
/**
 * The calendar day of `instant` as `YYYY-MM-DD`, in `timeZone` (default: this
 * machine's). Also the day the session notice records (home-base-lv87w.2 D2).
 */
export function localDay(
  instant: string,
  timeZone: string | undefined,
): string {
  return new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone,
    year: 'numeric',
  }).format(new Date(instant));
}

function hoursWords(ageMs: number): string {
  const hours = Math.floor(ageMs / HOUR_MS);
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

/**
 * The status report's line (D5), without its label: which jobs, since when.
 * The caller adds the details command.
 */
export function jobHealthReportText(
  notice: JobHealthNotice,
  timeZone?: string,
): string {
  switch (notice.kind) {
    case 'broken': {
      const each = notice.problems.map(
        (problem) =>
          `${problem.name} ${problemWords(problem.kind)}${problem.since == null ? '' : ` since ${localDay(problem.since, timeZone)}`}`,
      );
      const count =
        notice.problems.length === 1
          ? ''
          : `${notice.problems.length} jobs broken: `;
      return `⚠️ ${count}${each.join('; ')}`;
    }
    case 'not-running':
      return notice.ageMs == null
        ? '⚠️ chores not running: it has run on this Mac, but it has written no health file'
        : `⚠️ chores not running: its health file is ${hoursWords(notice.ageMs)} old`;
    case 'unknown':
      return `⚠️ job health unknown: ${notice.error}`;
  }
}

/** The heading every session notice starts with (home-base-9dcx9.2 D4). */
export const JOB_HEALTH_SESSION_HEADING = '# Recurring jobs on this Mac';

/**
 * What the session is told to do with the notice (home-base-9dcx9.2 D4). The
 * same words for every kind: Justin raises it, and Claude does not start fixing
 * on its own.
 */
export const JOB_HEALTH_SESSION_INSTRUCTION =
  'In your first reply, tell Justin which jobs are broken, in a short list, and propose one next step for each. Do not start fixing them unless he asks.';

/**
 * When the notice shows (home-base-lv87w.2): the rule `composeRepoState`
 * applies in first-prompt.ts, said in the notice so neither reader wonders why
 * it is missing from a session.
 */
export const JOB_HEALTH_SESSION_WHEN =
  'Shown in every mayor session and in the first home-base session each day.';

/**
 * The jobs section a home-base session gets on its first prompt
 * (home-base-9dcx9.2 D4): which jobs are broken, since when and why, the
 * details command, when the notice shows, and what to do in the first reply.
 * For `not-running` and `unknown` the heading says so and the body is the
 * status report's line.
 */
export function jobHealthSessionText(
  notice: JobHealthNotice,
  timeZone?: string,
): string {
  let headline: string;
  let body: string[];
  switch (notice.kind) {
    case 'broken':
      headline = `${notice.problems.length} broken`;
      body = notice.problems.map(
        (problem) =>
          `- **${problem.name}** (\`${problem.id}\`): ${problemWords(problem.kind)}${problem.since == null ? '' : ` since ${localDay(problem.since, timeZone)}`}. ${problem.reason}`,
      );
      break;
    case 'not-running':
      headline = 'chores not running';
      body = [jobHealthReportText(notice, timeZone)];
      break;
    case 'unknown':
      headline = 'health unknown';
      body = [jobHealthReportText(notice, timeZone)];
      break;
  }
  return [
    `${JOB_HEALTH_SESSION_HEADING}: ${headline}`,
    body.join('\n'),
    `Details: run \`${JOB_HEALTH_DETAILS_COMMAND}\`.`,
    JOB_HEALTH_SESSION_WHEN,
    JOB_HEALTH_SESSION_INSTRUCTION,
  ].join('\n\n');
}
