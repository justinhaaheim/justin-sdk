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
import {xdgStateHome} from './health-notices';
import {formatRepoState, runDivergenceCheck} from './repo-status/prime-view';
import {prettierMarkdown} from './rules/rules-file';
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
export function composeRepoState(projectRoot: string): string {
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
