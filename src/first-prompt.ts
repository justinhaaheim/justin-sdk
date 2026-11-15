/**
 * first-prompt — the repo-state block reaches Claude on the FIRST PROMPT of a
 * session, not at session start (home-base-39co9.4, decision M1).
 *
 * Justin, 2026-10-05: "Let us shift the repo state output to happen on the
 * first user prompt submit, NOT at session-start. [...] We really want the
 * repo-state NOW, not whenever the user opened this session."
 *
 * SESSIONSTART ARMS, THE FIRST PROMPT FIRES. Every SessionStart (startup,
 * resume, clear, compact, fork) writes `armed` into a per-session marker under
 * `$XDG_STATE_HOME/justin-sdk/first-prompt/<session_id>.json`. The
 * `repo-state --hook` UserPromptSubmit hook claims it: on `armed` it measures
 * the repo state at that moment, injects it, and rewrites the marker to
 * `fired`; on `fired` it prints nothing. A resumed or cleared session is armed
 * again by its own SessionStart, so its next prompt gets fresh repo state.
 *
 * A MISSING MARKER FIRES TOO (the cautious direction, critical rule 7). "No
 * marker" can mean the SessionStart hook had not finished yet — the hooks
 * reference says SessionStart hooks "run in the background. You can type right
 * away", and `claude "<prompt>"` submits a prompt immediately — or that the
 * SessionStart hook is not installed, or that it failed. Each of those would
 * otherwise cost the session its repo state in silence. The price of firing on
 * absence is a possible second delivery when a late `armed` lands after the
 * first prompt claimed it; a duplicate is visible and harmless, a gap is
 * neither. An UNREADABLE marker fires for the same reason.
 *
 * STATE LIVES OUTSIDE EVERY REPO, in XDG state (Justin's convention since
 * 2026-09-15), keyed by Claude Code's `session_id`. Nothing is written inside
 * the project.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import {join} from 'path';

import {hookEntriesFor} from './component-manifest';
import {PROJECT_CONFIG_FILENAME, xdgStateHome} from './health-notices';
import {hasDispatchEntry} from './hook-entries';
import {
  jobHealthNotice,
  type JobHealthRead,
  jobHealthSessionText,
  localDay,
  readJobHealth,
} from './job-health';
import {formatRepoState, runDivergenceCheck} from './repo-status/prime-view';
import {prettierMarkdown} from './rules/rules-file';
// From the leaf, not from handoff-number.ts, whose imports reach zod.
import {MAYOR_SUCCESSOR_SENTENCE} from './thread/mayor-sentence';
import {userSettingsPath} from './user-level-hook';

type EnvLike = Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// Is there a prompt hook to fire at all?
// ---------------------------------------------------------------------------

export type PromptHookPresence =
  | {kind: 'installed'; where: string}
  | {kind: 'absent'}
  /** A settings file could not be read or parsed — not the same as absent. */
  | {kind: 'unknown'; why: string};

/**
 * Is a `repo-state --hook` UserPromptSubmit hook registered in any settings
 * file Claude Code merges for this project — the user's, the project's, or the
 * project's local one?
 *
 * Arming is only worth anything if something will fire. Without this check a
 * repo whose SDK moved ahead of its `.claude/settings.json` — home-base the
 * moment this lands (the SDK is a workspace member there), or any repo whose
 * pin was bumped without `install` — would arm a marker nothing ever claims,
 * and every session there would quietly lose its repo state (critical rule 7).
 */
export function repoStateHookPresence(
  projectRoot: string,
  /**
   * Which twin must be present. The user-level one exits silently in an
   * enrolled repo, so it does not count for the project hook, and vice versa.
   */
  userLevel: boolean,
  env: EnvLike = process.env,
): PromptHookPresence {
  const files = [
    userSettingsPath(env),
    join(projectRoot, '.claude', 'settings.json'),
    join(projectRoot, '.claude', 'settings.local.json'),
  ];
  const unreadable: string[] = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    let settings: unknown;
    try {
      settings = JSON.parse(readFileSync(file, 'utf-8'));
    } catch (error) {
      unreadable.push(
        `${file} (${error instanceof Error ? error.message : String(error)})`,
      );
      continue;
    }
    if (settings == null || typeof settings !== 'object') continue;
    const fires = hookEntriesFor(
      settings as Record<string, unknown>,
      'UserPromptSubmit',
    ).some(
      (command) =>
        command.includes('repo-state') &&
        command.includes('--hook') &&
        command.includes('--user-level') === userLevel,
    );
    if (fires) return {kind: 'installed', where: file};
    // A dispatch-mode repo (home-base-rtsx1.2) runs `repo-state --hook` from
    // its UserPromptSubmit dispatcher entry: base-setup is in every repo's
    // components, so that entry always runs it. Without this, session-start
    // reads "absent", injects the repo state itself, arms nothing, and the
    // dispatcher's copy fires on the first prompt as well: two copies. Project
    // files only: the dispatcher is never a user-level hook.
    if (
      !userLevel &&
      file !== userSettingsPath(env) &&
      hasDispatchEntry(settings as Record<string, unknown>, 'UserPromptSubmit')
    ) {
      return {kind: 'installed', where: file};
    }
  }
  if (unreadable.length > 0) {
    return {kind: 'unknown', why: `could not read ${unreadable.join(', ')}`};
  }
  return {kind: 'absent'};
}

// ---------------------------------------------------------------------------
// The hook payload
// ---------------------------------------------------------------------------

/** The fields of a SessionStart / UserPromptSubmit payload this file reads. */
export interface HookPayload {
  cwd?: string;
  hook_event_name?: string;
  /**
   * UserPromptSubmit only: the prompt as typed. A slash command arrives as
   * typed (`/mayor …`), not as the transcript's `<command-name>` form.
   */
  prompt?: string;
  session_id?: string;
  /** SessionStart only: startup | resume | clear | compact | fork. */
  source?: string;
}

/**
 * Read the hook payload from stdin, or null when there is none to read.
 *
 * A TTY is never read: `bun run justin-sdk session-start` typed by hand would
 * otherwise sit waiting for an EOF that never comes. An empty or unparseable
 * stdin is null too — the callers treat "no payload" as "no session id", which
 * they each handle out loud.
 */
export function readHookPayload(
  read: () => string = () => readFileSync(0, 'utf-8'),
  isTty: boolean = process.stdin.isTTY === true,
): HookPayload | null {
  if (isTty) return null;
  try {
    const raw = read();
    if (raw.trim() === '') return null;
    const parsed: unknown = JSON.parse(raw);
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as HookPayload;
  } catch {
    return null;
  }
}

/**
 * A session id safe to use as a filename, or null. Claude Code sends UUIDs; the
 * pattern refuses anything that could climb out of the state directory.
 */
export function safeSessionId(payload: HookPayload | null): string | null {
  const id = payload?.session_id;
  if (typeof id !== 'string') return null;
  return /^[A-Za-z0-9._-]{1,200}$/.test(id) && !id.startsWith('.') ? id : null;
}

// ---------------------------------------------------------------------------
// The marker store
// ---------------------------------------------------------------------------

/** Where the per-session markers live. */
export function firstPromptStateDir(env: EnvLike = process.env): string {
  return join(xdgStateHome(env), 'justin-sdk', 'first-prompt');
}

type MarkerState = 'armed' | 'fired';

interface Marker {
  at: string;
  /** The SessionStart source that armed it, or null for a `fired` record. */
  source: string | null;
  state: MarkerState;
}

/** Markers older than this are deleted when a new session arms (housekeeping). */
const MARKER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function markerPath(sessionId: string, env: EnvLike): string {
  return join(firstPromptStateDir(env), `${sessionId}.json`);
}

/** Write via a temp file and a rename, so a reader never sees half a marker. */
function writeMarker(sessionId: string, marker: Marker, env: EnvLike): void {
  const dir = firstPromptStateDir(env);
  mkdirSync(dir, {recursive: true});
  const path = markerPath(sessionId, env);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(marker)}\n`);
  renameSync(tmp, path);
}

/**
 * Delete this store's own markers that are older than MARKER_MAX_AGE_MS.
 *
 * Only `<id>.json` files in this store's own directory are considered, and a
 * failure is ignored: pruning is housekeeping, and nothing a session needs
 * depends on it.
 */
function pruneOldMarkers(env: EnvLike, nowMs: number): void {
  const dir = firstPromptStateDir(env);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!/^[A-Za-z0-9._-]+\.json$/.test(name)) continue;
    const path = join(dir, name);
    try {
      if (nowMs - statSync(path).mtimeMs > MARKER_MAX_AGE_MS) unlinkSync(path);
    } catch {
      // Gone already, or not ours to touch. Either way, nothing to do.
    }
  }
}

export type ArmResult = {ok: true} | {error: string; ok: false};

/**
 * SessionStart's half: mark this session as owed a repo-state block on its next
 * prompt. Returns the failure rather than throwing — the caller falls back to
 * injecting the block at SessionStart and says why.
 */
export function armFirstPrompt(
  sessionId: string,
  source: string | null,
  env: EnvLike = process.env,
  now: Date = new Date(),
): ArmResult {
  try {
    writeMarker(
      sessionId,
      {at: now.toISOString(), source, state: 'armed'},
      env,
    );
  } catch (error) {
    return {
      error: `could not write ${markerPath(sessionId, env)}: ${error instanceof Error ? error.message : String(error)}`,
      ok: false,
    };
  }
  pruneOldMarkers(env, now.getTime());
  return {ok: true};
}

export type ClaimResult =
  | {
      fire: true;
      /**
       * Set when the `fired` record could not be written, so the next prompt
       * may fire again. Said out loud by the caller.
       */
      recordError: string | null;
      why: 'armed' | 'never-armed' | 'unreadable-marker';
    }
  | {fire: false; why: 'already-fired'}
  | {error: string; fire: false; why: 'cannot-record'};

/**
 * The UserPromptSubmit half: should THIS prompt carry the repo state?
 *
 * Fires on `armed`, on no marker, and on a marker it cannot read — see the file
 * header for why the last two fire. Records `fired` before returning, so the
 * next prompt is silent.
 *
 * ONE EXCEPTION, so a broken state directory cannot turn this into a block on
 * EVERY prompt: when the `fired` record cannot be written AND there was no
 * readable `armed` marker, nothing fires. Writes failing there means
 * SessionStart could not arm either, and in that case session-start has
 * already injected the block itself (its fallback) and said so to Justin.
 */
export function claimFirstPrompt(
  sessionId: string,
  env: EnvLike = process.env,
  now: Date = new Date(),
): ClaimResult {
  const path = markerPath(sessionId, env);
  let why: 'armed' | 'never-armed' | 'unreadable-marker';
  if (!existsSync(path)) {
    why = 'never-armed';
  } else {
    try {
      const marker = JSON.parse(readFileSync(path, 'utf-8')) as Partial<Marker>;
      if (marker.state === 'fired') return {fire: false, why: 'already-fired'};
      why = marker.state === 'armed' ? 'armed' : 'unreadable-marker';
    } catch {
      why = 'unreadable-marker';
    }
  }
  try {
    writeMarker(
      sessionId,
      {at: now.toISOString(), source: null, state: 'fired'},
      env,
    );
    return {fire: true, recordError: null, why};
  } catch (error) {
    const recordError = `could not write ${path}: ${error instanceof Error ? error.message : String(error)}`;
    if (why !== 'armed') {
      return {error: recordError, fire: false, why: 'cannot-record'};
    }
    return {fire: true, recordError, why};
  }
}

// ---------------------------------------------------------------------------
// The block itself
// ---------------------------------------------------------------------------

/**
 * The repo-state block, measured now — the same text session-start injected
 * before this change, from the same two functions.
 *
 * Three outcomes, never collapsed (critical rule 7): the block; '' when there
 * is nothing sensible to report (a detached HEAD, not a git repo —
 * `formatRepoState`'s own contract); and a block that SAYS the walk failed,
 * because a thrown git inspection is not a clean repo and used to be silently
 * omitted.
 */
function composeRepoStateBlock(projectRoot: string): string {
  let block: string;
  try {
    // PR state is a network call (~600ms against ~150ms for the core walk) and
    // pays a full timeout when `gh` cannot reach GitHub. Opt in per machine.
    const wantPrs = process.env.JUSTIN_SDK_PRIME_PRS === '1';
    block = formatRepoState(
      runDivergenceCheck({cwd: projectRoot, prs: wantPrs}),
    );
  } catch (error) {
    return [
      '# Current repo state',
      '',
      `UNKNOWN — inspecting the repo failed (${error instanceof Error ? error.message : String(error)}). Treat it as unknown, not as clean.`,
    ].join('\n');
  }
  if (block === '') return '';
  // Presentation only, as before: a prettier failure keeps the unformatted
  // (still complete) block.
  const formatted = prettierMarkdown(block);
  return formatted.status === 'failed' ? block : formatted.markdown;
}

/** `value[key]` when both are plain JSON objects; otherwise null. */
function jsonObjectField(
  value: unknown,
  key: string,
): Record<string, unknown> | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const field = (value as Record<string, unknown>)[key];
  if (field == null || typeof field !== 'object' || Array.isArray(field)) {
    return null;
  }
  return field as Record<string, unknown>;
}

/**
 * Has this repo opted in to the jobs section (home-base-9dcx9.2 D2)? The health
 * file is machine-wide, so only a repo whose own config sets
 * `componentConfig["job-health"].sessionNotice` to true gets it; home-base
 * does. A config that is absent, unreadable or not JSON has not opted in, and
 * doctor's config check already names a broken one.
 *
 * Read by hand, like `hookDispatchEnabled`, NOT through sdk-config's typed
 * reader: this module is in the command tree every hook loads on every
 * prompt, and sdk-config brings zod (12-13 ms) with it
 * (tests/health-notices-cli.test.ts, "the CLI hot path"). The key's schema
 * entry in sdk-config.ts stays, for `config schema` and doctor.
 */
export function jobHealthSessionNoticeOn(projectRoot: string): boolean {
  let config: unknown;
  try {
    config = JSON.parse(
      readFileSync(join(projectRoot, PROJECT_CONFIG_FILENAME), 'utf-8'),
    );
  } catch {
    return false;
  }
  const componentConfig = jsonObjectField(config, 'componentConfig');
  const block = jsonObjectField(componentConfig, 'job-health');
  return block?.sessionNotice === true;
}

export interface JobHealthSectionOptions {
  /** Where the chores state dir is resolved from. Default: process.env. */
  env?: EnvLike;
  now?: Date;
  /** The health file reader (tests). Default: `readJobHealth`. */
  read?: (env: EnvLike) => JobHealthRead;
  /** For the "since" days. Default: this machine's. */
  timeZone?: string;
}

/**
 * The jobs section, or '' when every job checked out fine or chores has never
 * run here (`jobHealthNotice` returned null). Never throws (D5): a failure in
 * here is an "unknown" section naming the error, never nothing (rule 7).
 */
export function composeJobHealthSection(
  options: JobHealthSectionOptions = {},
): string {
  const env = options.env ?? process.env;
  try {
    const notice = jobHealthNotice(
      (options.read ?? readJobHealth)(env),
      options.now ?? new Date(),
    );
    return notice == null ? '' : jobHealthSessionText(notice, options.timeZone);
  } catch (error) {
    return jobHealthSessionText({
      error: `composing this notice failed (${error instanceof Error ? error.message : String(error)})`,
      kind: 'unknown',
      // Not shown; the read may not have got as far as a path.
      path: '(not resolved)',
    });
  }
}

// ---------------------------------------------------------------------------
// How often the jobs section shows (home-base-lv87w.2)
// ---------------------------------------------------------------------------

/**
 * Which rule decides whether the jobs section shows (home-base-lv87w.2).
 *
 * - `mayor`: a mayor session's first prompt. Always shows, and records today.
 * - `daily`: any other home-base session. Shows only when no session has
 *   shown it yet today, and records today when it does.
 * - `always`: `justin-sdk repo-state` typed by a human or an agent (D4).
 *   Always shows, and records nothing.
 *
 * Justin, 2026-11-15: "let's have it show in all mayor sessions, AND once a
 * day in a home base session (which could be the mayor session)."
 */
export type JobsNoticeRule = 'always' | 'daily' | 'mayor';

/** A typed `/mayor`, alone or with arguments, at the start of the prompt. */
const MAYOR_COMMAND = /^\s*\/mayor(?:\s|$)/u;

/**
 * Is this the first prompt of a mayor session (home-base-lv87w.2 D1)? It is
 * when it starts with a typed `/mayor`, or when it carries the sentence a mayor
 * session's successor is given in its kickoff. Anything that is not a string
 * is not.
 *
 * By the prompt's text only: the session bead's `session-role:mayor` label is
 * written at the end of the first turn, so it is usually absent here. A mayor
 * session whose first prompt is something else gets the daily rule.
 */
export function isMayorFirstPrompt(prompt: unknown): boolean {
  if (typeof prompt !== 'string') return false;
  return (
    MAYOR_COMMAND.test(prompt) || prompt.includes(MAYOR_SUCCESSOR_SENTENCE)
  );
}

/**
 * Where the day the jobs section was last shown is recorded (D6): the SDK's own
 * state dir, beside the first-prompt markers. Machine-wide, like the health
 * file it is about.
 */
export function jobsNoticeRecordPath(env: EnvLike = process.env): string {
  return join(xdgStateHome(env), 'justin-sdk', 'job-health-notice.json');
}

/** What the record says. `none` and `unreadable` both count as "not shown today" (D3). */
export type JobsNoticeRecord =
  | {day: string; kind: 'shown'}
  | {kind: 'none'}
  | {kind: 'unreadable'; why: string};

const RECORD_DAY = /^\d{4}-\d{2}-\d{2}$/u;

export function readJobsNoticeRecord(
  env: EnvLike = process.env,
): JobsNoticeRecord {
  const path = jobsNoticeRecordPath(env);
  if (!existsSync(path)) return {kind: 'none'};
  try {
    const record: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    const day =
      record != null && typeof record === 'object' && !Array.isArray(record)
        ? (record as Record<string, unknown>).day
        : undefined;
    if (typeof day === 'string' && RECORD_DAY.test(day)) {
      return {day, kind: 'shown'};
    }
    return {kind: 'unreadable', why: `${path} holds no day`};
  } catch (error) {
    return {
      kind: 'unreadable',
      why: `could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Record that the jobs section was shown on `day`. Via a temp file and a
 * rename, like the markers. Returns the failure rather than throwing.
 */
function recordJobsNoticeShown(
  day: string,
  env: EnvLike,
  now: Date,
): {ok: true} | {error: string; ok: false} {
  const path = jobsNoticeRecordPath(env);
  try {
    mkdirSync(join(xdgStateHome(env), 'justin-sdk'), {recursive: true});
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({at: now.toISOString(), day})}\n`);
    renameSync(tmp, path);
    return {ok: true};
  } catch (error) {
    return {
      error: `could not write ${path}: ${error instanceof Error ? error.message : String(error)}`,
      ok: false,
    };
  }
}

export interface RepoStateComposeOptions extends JobHealthSectionOptions {
  /**
   * Which rule decides whether the jobs section shows (home-base-lv87w.2).
   * Default `always`: shows and records nothing, the cautious side (D3).
   */
  jobsNotice?: JobsNoticeRule;
}

/**
 * The jobs section under `options.jobsNotice`. `env` resolves both the chores
 * state dir and the record's state dir.
 *
 * Nothing broken: '' and no record, so a job that breaks at 3pm shows in the
 * next session after that. A record that cannot be read counts as "not shown
 * today" (D3). A record that cannot be written leaves the section shown, says
 * so in it, and the next session shows it again.
 */
function jobsSectionUnderRule(options: RepoStateComposeOptions): string {
  const section = composeJobHealthSection(options);
  const rule = options.jobsNotice ?? 'always';
  if (section === '' || rule === 'always') return section;

  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const today = localDay(now.toISOString(), options.timeZone);
  if (rule === 'daily') {
    const record = readJobsNoticeRecord(env);
    if (record.kind === 'shown' && record.day === today) return '';
  }
  const recorded = recordJobsNoticeShown(today, env, now);
  return recorded.ok
    ? section
    : `${section}\n\n⚠️ Could not record that this notice was shown today (${recorded.error}), so the next home-base session shows it again.`;
}

/**
 * What the first prompt gets: the repo-state block above, then, in a repo that
 * opted in, the jobs section (home-base-9dcx9.2): which recurring jobs on this
 * Mac are broken, under the rule `options.jobsNotice` names
 * (home-base-lv87w.2). '' only when both parts are empty.
 */
export function composeRepoState(
  projectRoot: string,
  options: RepoStateComposeOptions = {},
): string {
  const parts = [composeRepoStateBlock(projectRoot)];
  // home-base-9dcx9.2 D1: the jobs section rides on this block, so the
  // first-prompt hook and session-start's fallback both carry it. It stands on
  // its own: a detached HEAD ('' above) still gets it.
  if (jobHealthSessionNoticeOn(projectRoot)) {
    parts.push(jobsSectionUnderRule(options));
  }
  return parts.filter((part) => part !== '').join('\n\n');
}
