/**
 * Which sessions must never reach the threads repo (home-base-bj5xm).
 *
 * ~/Dev/threads is pushed to GitHub every hour. Until this module, every
 * session of every repo with capture on wrote its messages there, including
 * sessions about a private personal matter. This module decides, for one
 * session, whether anything about it may be written into that repo. Every
 * write in the bd adapter (bd.ts) asks it first, so a writer added later is
 * checked without having to remember to (D2).
 *
 * A SESSION IS PRIVATE (D1) when any of these holds:
 *
 *   - it was marked private: `thread private` wrote
 *     `<threads state dir>/private-sessions/<session id>.json`. That directory
 *     is local state, never a git repo.
 *   - one of its working directories is inside a repo listed in the USER
 *     config, `componentConfig.thread.privateRepos` (~ expanded, matched by
 *     path prefix, so worktrees under the repo are covered and a deleted
 *     checkout still matches). The user file only: the hourly backfill decides
 *     for sessions of every repo from home-base, often after their checkout is
 *     gone, so a per-repo flag could not be read.
 *
 * UNKNOWN MEANS PRIVATE (D3). No session id, no working directory, a relative
 * one, a mark that could not be read, and a user config that exists but could
 * not be read, parsed or validated all return `private` with the reason. Only
 * a missing user config file means "no repo is private".
 *
 * WHAT IT DOES NOT DO. It never edits, blanks or deletes what is already in
 * the threads repo; it stops new writes only. The session's messages still go
 * to the local message log (~/.local/state/justin-threads/messages/), which is
 * never pushed (D4).
 */

import type {EnvLike} from './paths';

import {mkdirSync, realpathSync, statSync, writeFileSync} from 'fs';
import {homedir} from 'os';
import {isAbsolute, join, resolve, sep} from 'path';

import {describeConfigOutcome, readUserConfig} from '../sdk-config';
import {threadsStateDir} from './paths';

/** The directory, under the threads state dir, that holds the marks. */
export const PRIVATE_SESSIONS_DIRNAME = 'private-sessions';

/**
 * The shape the message log accepts as a file name (`SESSION_ID_SHAPE` in
 * message-log.ts). Repeated rather than imported, so the bd adapter, which
 * imports this module, does not pull the message log into its import graph.
 */
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function privateSessionsDir(env: EnvLike = process.env): string {
  return join(threadsStateDir(env), PRIVATE_SESSIONS_DIRNAME);
}

export function privateMarkPath(
  sessionId: string,
  env: EnvLike = process.env,
): string {
  return join(privateSessionsDir(env), `${sessionId}.json`);
}

/** Whose session a write is for. */
export interface WriteOwner {
  /**
   * Every working directory known for the session. Empty means it cannot be
   * told, which is private (D3).
   */
  cwds: readonly string[];
  sessionId: string | null;
}

/** The verdict. `reason` is what every refusal and skip prints. */
export type Privacy = {kind: 'private'; reason: string} | {kind: 'public'};

function errorCode(error: unknown): string | null {
  if (error == null || typeof error !== 'object' || !('code' in error)) {
    return null;
  }
  const code = (error as {code: unknown}).code;
  return typeof code === 'string' ? code : null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function homeOf(env: EnvLike): string {
  const home = env.HOME;
  return home != null && home !== '' ? home : homedir();
}

/** `~` and `~/x` expanded against HOME; anything else returned as given. */
export function expandHome(path: string, env: EnvLike = process.env): string {
  if (path === '~') return homeOf(env);
  if (path.startsWith('~/')) return join(homeOf(env), path.slice(2));
  return path;
}

/** What the user config says about private repos. */
export type PrivateReposRead =
  | {kind: 'read'; path: string; repos: string[]}
  | {kind: 'unreadable'; reason: string};

/**
 * `componentConfig.thread.privateRepos` from the USER file, expanded to
 * absolute paths.
 *
 * A missing file is `read` with no repos. A file that cannot be read, is not
 * JSON, or breaks the schema is `unreadable`, and so is an entry that is not
 * an absolute or `~` path: guessing what a relative path was meant to name
 * could leave a private repo unprotected (D3).
 */
export function readPrivateRepos(env: EnvLike = process.env): PrivateReposRead {
  const outcome = readUserConfig(env);
  if (outcome.status === 'absent') {
    return {kind: 'read', path: outcome.path, repos: []};
  }
  if (outcome.status !== 'ok') {
    return {
      kind: 'unreadable',
      reason: `the user config cannot be used (${describeConfigOutcome(outcome)}), so every session counts as private until it is fixed`,
    };
  }
  const entries = outcome.config.componentConfig?.thread?.privateRepos ?? [];
  const repos: string[] = [];
  for (const entry of entries) {
    const expanded = expandHome(entry, env);
    if (!isAbsolute(expanded)) {
      return {
        kind: 'unreadable',
        reason: `componentConfig.thread.privateRepos in ${outcome.path} lists ${JSON.stringify(entry)}, which is not an absolute or ~ path, so every session counts as private until it is fixed`,
      };
    }
    repos.push(resolve(expanded));
  }
  return {kind: 'read', path: outcome.path, repos};
}

/** Whether a session carries the `thread private` mark. */
export type SessionMark =
  | {kind: 'marked'; path: string}
  | {kind: 'unknown'; reason: string}
  | {kind: 'unmarked'};

export function readSessionMark(
  sessionId: string,
  env: EnvLike = process.env,
): SessionMark {
  if (!SAFE_SESSION_ID.test(sessionId)) {
    return {
      kind: 'unknown',
      reason: `session id ${JSON.stringify(sessionId)} is not a safe file name, so its private mark cannot be looked up`,
    };
  }
  const path = privateMarkPath(sessionId, env);
  try {
    statSync(path);
    return {kind: 'marked', path};
  } catch (error) {
    // ENOENT covers a missing directory too: no session was ever marked.
    if (errorCode(error) === 'ENOENT') return {kind: 'unmarked'};
    return {
      kind: 'unknown',
      reason: `its private mark ${path} could not be checked (${errorText(error)})`,
    };
  }
}

/** What `thread private` did. */
export type MarkOutcome =
  | {error: string; kind: 'failed'; path: string}
  | {kind: 'already'; path: string}
  | {kind: 'marked'; path: string};

/** Record that a session is private. Never throws. */
export function markSessionPrivate(
  sessionId: string,
  env: EnvLike = process.env,
  now: Date = new Date(),
): MarkOutcome {
  const path = SAFE_SESSION_ID.test(sessionId)
    ? privateMarkPath(sessionId, env)
    : join(privateSessionsDir(env), '(unsafe session id)');
  if (!SAFE_SESSION_ID.test(sessionId)) {
    return {
      error: `session id ${JSON.stringify(sessionId)} is not a safe file name`,
      kind: 'failed',
      path,
    };
  }
  try {
    mkdirSync(privateSessionsDir(env), {recursive: true});
    writeFileSync(
      path,
      `${JSON.stringify({at: now.toISOString(), sessionId})}\n`,
      {flag: 'wx'},
    );
    return {kind: 'marked', path};
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return {kind: 'already', path};
    return {error: errorText(error), kind: 'failed', path};
  }
}

function realOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function withoutTrailingSep(path: string): string {
  return path.length > 1 && path.endsWith(sep) ? path.slice(0, -1) : path;
}

/**
 * Is `child` the directory `parent` or inside it?
 *
 * Compared case-insensitively (macOS volumes usually are), and both as given
 * and with symlinks resolved where the path still exists. Every variant can
 * only ADD a match, which is the safe direction here.
 */
export function pathInside(child: string, parent: string): boolean {
  const children = [resolve(child), realOrNull(child)];
  const parents = [resolve(parent), realOrNull(parent)];
  for (const rawChild of children) {
    if (rawChild == null) continue;
    const c = withoutTrailingSep(rawChild).toLowerCase();
    for (const rawParent of parents) {
      if (rawParent == null) continue;
      const p = withoutTrailingSep(rawParent).toLowerCase();
      if (p === sep) return true;
      if (c === p || c.startsWith(`${p}${sep}`)) return true;
    }
  }
  return false;
}

/** The decision (D1, D3). Never throws. */
export function sessionPrivacy(
  owner: WriteOwner,
  env: EnvLike = process.env,
): Privacy {
  const {sessionId} = owner;
  if (sessionId == null || sessionId === '') {
    return {
      kind: 'private',
      reason:
        'the write names no session, so its private mark cannot be checked',
    };
  }
  const mark = readSessionMark(sessionId, env);
  if (mark.kind === 'marked') {
    return {
      kind: 'private',
      reason: `session ${sessionId} was marked private (${mark.path})`,
    };
  }
  if (mark.kind === 'unknown') return {kind: 'private', reason: mark.reason};

  const cwds = owner.cwds.filter((cwd) => cwd !== '');
  if (cwds.length === 0) {
    return {
      kind: 'private',
      reason: `the working directory of session ${sessionId} is unknown`,
    };
  }
  const relative = cwds.find((cwd) => !isAbsolute(cwd));
  if (relative != null) {
    return {
      kind: 'private',
      reason: `session ${sessionId} records the working directory ${JSON.stringify(relative)}, which is not absolute`,
    };
  }
  const repos = readPrivateRepos(env);
  if (repos.kind === 'unreadable') {
    return {kind: 'private', reason: repos.reason};
  }
  for (const cwd of cwds) {
    for (const repo of repos.repos) {
      if (pathInside(cwd, repo)) {
        return {
          kind: 'private',
          reason: `${cwd} is inside ${repo}, which componentConfig.thread.privateRepos lists`,
        };
      }
    }
  }
  return {kind: 'public'};
}

function metaString(
  meta: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = meta?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * The owner a thread bead's metadata names: its session and every directory
 * it recorded. A bead that recorded none gives an owner that is private (D3).
 */
export function ownerOfMetadata(
  meta: Record<string, unknown> | null | undefined,
): WriteOwner {
  return {
    cwds: ['cwd', 'repoPath', 'worktreePath']
      .map((key) => metaString(meta, key))
      .filter((value): value is string => value != null),
    sessionId: metaString(meta, 'sessionId'),
  };
}

/** An owner from a session id and whatever directories are known. */
export function ownerOf(
  sessionId: string | null,
  cwds: readonly (null | string | undefined)[],
): WriteOwner {
  return {
    cwds: cwds.filter(
      (cwd): cwd is string => typeof cwd === 'string' && cwd !== '',
    ),
    sessionId,
  };
}

export interface ThreadPrivateOptions {
  /** Print the verdict for this session and change nothing. */
  check?: boolean;
  /** The directory the verdict is checked for (default: the current one). */
  cwd?: string;
  env?: EnvLike;
  now?: Date;
  /** Default: CLAUDE_CODE_SESSION_ID. */
  sessionId?: string | null;
}

/**
 * `thread private`: mark the session private (D1, option a of home-base-sg9q9.4).
 *
 * Exit 0 marked (or already marked, or `--check` ran) · 1 the mark could not be
 * written · 2 no session id.
 */
export function runThreadPrivate(options: ThreadPrivateOptions = {}): number {
  const env = options.env ?? process.env;
  const sessionId =
    options.sessionId != null && options.sessionId !== ''
      ? options.sessionId
      : (env.CLAUDE_CODE_SESSION_ID ?? '');
  if (sessionId === '') {
    console.error(
      'thread private: no session id (CLAUDE_CODE_SESSION_ID is unset and --session was not passed). Nothing was marked.',
    );
    return 2;
  }
  if (options.check === true) {
    const cwd = options.cwd ?? process.cwd();
    const verdict = sessionPrivacy(ownerOf(sessionId, [cwd]), env);
    console.log(
      verdict.kind === 'private'
        ? `Session ${sessionId} is PRIVATE: nothing from it is written to the threads repo. Why: ${verdict.reason}.`
        : `Session ${sessionId} is not private: its messages are written to the threads repo, which is pushed to GitHub. Run this command without --check to mark it private.`,
    );
    return 0;
  }
  const marked = markSessionPrivate(sessionId, env, options.now);
  if (marked.kind === 'failed') {
    console.error(
      `thread private: could NOT mark session ${sessionId} private: ${marked.error} (${marked.path}). Its messages are still written to the threads repo.`,
    );
    return 1;
  }
  console.log(
    `${marked.kind === 'already' ? 'Session already private' : 'Session marked private'}: ${sessionId}.`,
  );
  console.log(
    '  From now on nothing from this session is written to the threads repo, which is pushed to GitHub. What it wrote before stays there.',
  );
  console.log(
    `  Its messages are still kept in the local message log, which is never pushed. The mark: ${marked.path}`,
  );
  return 0;
}
