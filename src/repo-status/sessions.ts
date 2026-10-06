/**
 * SESSIONS for `repo-status status --sessions` and `repo-status repos`
 * (home-base-39co9.5; first built as `justin-sdk forensics`, home-base-lj3x9).
 *
 * IMPORTED LAZILY, ALWAYS. This module reaches thread/backfill.ts and with it
 * zod, and repo-status.ts is imported eagerly by cli.ts, the entry for the hooks
 * that run on every prompt (home-base-wxa4c D-W1;
 * tests/health-notices-cli.test.ts fails if zod becomes statically reachable).
 * Only views-run.ts imports it, and only views-run.ts is `await import`ed.
 *
 * Which Claude Code sessions ran in a repo inside a window, and for each: the
 * three messages Justin reads to get his bearings (his first message, his last
 * message, Claude's last response), the command that resumes it, and the thread
 * bead it has, if any.
 *
 * NOTHING HERE READS A TRANSCRIPT ITSELF. Discovery, the mtime pre-filter, the
 * last-record window and the message definitions are `thread backfill`'s
 * (`discoverSessionFiles`, `scanSessions`, `extractTranscriptMessages`), so
 * "substantive user message" and "last activity" mean exactly what they mean on
 * the thread board.
 *
 * A REPO IS ITS MAIN CHECKOUT. A session in `<repo>/.claude/worktrees/x` or in
 * `<repo>/pkg/y` belongs to `<repo>`: git's common dir says so when the
 * directory still exists, and the path before `/.claude/worktrees/` says so when
 * the worktree has been removed. Which of the two decided is recorded.
 *
 * A session is found only under the directory Claude Code filed its transcript
 * in, which is where it was LAUNCHED. A session launched elsewhere that later
 * `cd`'d into the repo is found by `repo-status repos` (full scan) and missed by
 * `status --sessions` (which only opens the repo's own transcript directories).
 */

import type {EnvLike} from '../thread/paths';

import {existsSync} from 'fs';
import {dirname, isAbsolute, relative} from 'path';

import {
  type BackfillSession,
  discoverSessionFiles,
  scanSessions,
} from '../thread/backfill';
import {
  bdContext,
  type BdIssue,
  describeBdFailure,
  listAsks,
  listThreads,
} from '../thread/bd';
import {projectDirSlug} from '../thread/transcript-messages';
import {gitRead} from './checkouts';

const WORKTREE_MARKER = '/.claude/worktrees/';

/** The main checkout a path belongs to, by its shape alone. */
export function repoRootFromPath(cwd: string): string {
  const index = cwd.indexOf(WORKTREE_MARKER);
  return index === -1 ? cwd : cwd.slice(0, index);
}

export type RepoResolution =
  | {by: 'git' | 'path'; root: string}
  | {by: null; root: null};

/** The main checkout containing `dir`, by git's common dir; null when none. */
function gitRootOf(dir: string): string | null {
  const common = gitRead(dir, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  if (!common.ok) return null;
  const gitDir = common.value.trim();
  if (gitDir.endsWith('/.git')) return dirname(gitDir);
  const top = gitRead(dir, ['rev-parse', '--show-toplevel']);
  return top.ok ? top.value.trim() : null;
}

/**
 * The main checkout for `cwd`: git's common dir when the directory exists and
 * is a repo, else the path's shape. Cached, because a repo's sessions share a
 * handful of directories.
 */
export function resolveRepoRoot(
  cwd: string | null,
  cache: Map<string, RepoResolution>,
): RepoResolution {
  if (cwd == null) return {by: null, root: null};
  const cached = cache.get(cwd);
  if (cached != null) return cached;
  const byShape = repoRootFromPath(cwd);
  let resolution: RepoResolution = {by: 'path', root: byShape};
  if (existsSync(cwd)) {
    const root = gitRootOf(cwd);
    if (root != null) resolution = {by: 'git', root};
  } else if (byShape === cwd) {
    // A directory that is gone and is not a removed worktree — a deleted
    // subdirectory, or a submodule that was folded in. It belongs to whatever
    // repo its nearest surviving ancestor is in, when that ancestor is in one.
    let ancestor = dirname(cwd);
    while (ancestor !== dirname(ancestor) && !existsSync(ancestor)) {
      ancestor = dirname(ancestor);
    }
    const root = existsSync(ancestor) ? gitRootOf(ancestor) : null;
    if (root != null) resolution = {by: 'path', root};
  }
  cache.set(cwd, resolution);
  return resolution;
}

export interface SessionThread {
  id: string;
  mergeState: string | null;
  /** Open ask beads under this thread. */
  openAsks: number;
  /** `report`, `start` or `backfill`: how the bead came to exist. */
  source: string | null;
  status: string | null;
  title: string | null;
}

export type ThreadIndex =
  | {bySession: Map<string, SessionThread>; ok: true}
  | {error: string; ok: false};

function metaString(issue: BdIssue, key: string): string | null {
  const value = issue.metadata?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Index thread beads by session id, with their open-ask counts. */
export function buildThreadIndex(
  threads: readonly BdIssue[],
  openAsks: readonly BdIssue[],
): Map<string, SessionThread> {
  const asksByThread = new Map<string, number>();
  for (const ask of openAsks) {
    const parent = ask.parent ?? metaString(ask, 'threadId');
    if (parent == null) continue;
    asksByThread.set(parent, (asksByThread.get(parent) ?? 0) + 1);
  }
  const bySession = new Map<string, SessionThread>();
  for (const thread of threads) {
    const sessionId = metaString(thread, 'sessionId');
    if (sessionId == null) continue;
    bySession.set(sessionId, {
      id: thread.id,
      mergeState: metaString(thread, 'mergeState'),
      openAsks: asksByThread.get(thread.id) ?? 0,
      source: metaString(thread, 'source'),
      status: thread.status ?? null,
      title: thread.title ?? null,
    });
  }
  return bySession;
}

/** Every thread bead, closed ones included, keyed by session id. */
export async function readThreadIndex(
  env: EnvLike = process.env,
): Promise<ThreadIndex> {
  const ctx = bdContext(env);
  const threads = await listThreads(ctx, {includeClosed: true});
  if (!threads.ok) {
    return {error: describeBdFailure(threads.failure), ok: false};
  }
  const asks = await listAsks(ctx);
  if (!asks.ok) return {error: describeBdFailure(asks.failure), ok: false};
  return {bySession: buildThreadIndex(threads.value, asks.value), ok: true};
}

export interface SessionFacts {
  branch: string | null;
  cwd: string | null;
  failures: string[];
  firstTimestamp: string | null;
  firstUserMessage: string | null;
  lastAssistantMessage: string | null;
  lastTimestamp: string;
  lastUserMessage: string | null;
  repoResolvedBy: 'git' | 'path' | null;
  repoRoot: string | null;
  resumeCommand: string | null;
  sessionId: string;
  /**
   * The session's thread bead. Null means "no thread bead" ONLY when the thread
   * index was read; when it was not, the caller's `threads` result says why.
   */
  thread: SessionThread | null;
  transcriptPath: string;
}

export interface SessionScan {
  failures: string[];
  sessions: SessionFacts[];
  threads: ThreadIndex;
  windowStart: string;
}

export interface ScanOptions {
  days: number;
  env?: EnvLike;
  now?: Date;
  /** Only open transcript directories that belong to this repo's path. */
  repoRoot?: string | null;
  /** Injected in tests; the real index otherwise. */
  threads?: ThreadIndex;
}

function toSessionFacts(
  session: BackfillSession,
  cache: Map<string, RepoResolution>,
  index: ThreadIndex,
): SessionFacts {
  const {messages} = session;
  const cwd = messages.cwd ?? messages.firstCwd;
  const repo = resolveRepoRoot(cwd, cache);
  const failures = [...messages.failures];
  if (repo.root == null) {
    failures.push('repo: no record in the transcript carries a cwd');
  }
  return {
    branch: messages.gitBranch,
    cwd,
    failures,
    firstTimestamp: messages.firstTimestamp,
    firstUserMessage: messages.firstUserMessage,
    lastAssistantMessage: messages.lastAssistantMessage,
    lastTimestamp: session.lastTimestamp,
    lastUserMessage: messages.lastUserMessage,
    repoResolvedBy: repo.by,
    repoRoot: repo.root,
    resumeCommand: messages.resumeCommand,
    sessionId: session.sessionId,
    thread: index.ok ? (index.bySession.get(session.sessionId) ?? null) : null,
    transcriptPath: session.transcriptPath,
  };
}

/**
 * Every session whose LAST RECORD falls inside the window, newest first,
 * optionally narrowed to one repo.
 */
export async function scanRepoSessions(
  options: ScanOptions,
): Promise<SessionScan> {
  const now = options.now ?? new Date();
  const windowStart = new Date(now.getTime() - options.days * 86_400_000);
  const env = options.env ?? process.env;

  const discovery = discoverSessionFiles({env, windowStart});
  const failures = [...discovery.failures];
  let files = discovery.files;
  const repoRoot = options.repoRoot ?? null;
  if (repoRoot != null) {
    const slug = projectDirSlug(repoRoot);
    files = files.filter((file) => file.projectDir.startsWith(slug));
  }
  const scan = scanSessions(files, windowStart);
  failures.push(...scan.failures);

  const threads = options.threads ?? (await readThreadIndex(env));
  const cache = new Map<string, RepoResolution>();
  let sessions = scan.sessions.map((session) =>
    toSessionFacts(session, cache, threads),
  );
  if (repoRoot != null) {
    sessions = sessions.filter((session) => session.repoRoot === repoRoot);
  }
  sessions.sort((a, b) => b.lastTimestamp.localeCompare(a.lastTimestamp));
  return {failures, sessions, threads, windowStart: windowStart.toISOString()};
}

/**
 * How a repo's sessions are covered by threads. Null as a whole when the
 * thread beads could not be read — never a set of zeros.
 */
export interface ThreadCoverage {
  /** Only `thread backfill` recorded them: the session never reported. */
  backfilled: number;
  /** No thread bead at all. */
  none: number;
  /** A real `thread report` ran at least once. */
  reported: number;
  /** `thread start` created the bead and no report followed. */
  started: number;
}

export interface RepoSummary {
  coverage: ThreadCoverage | null;
  /** The oldest last-activity among this repo's sessions in the window. */
  firstActivity: string;
  lastActivity: string;
  repoResolvedBy: 'git' | 'path';
  repoRoot: string;
  sessions: number;
}

/** Whether `path` is `root` or inside it. */
export function isUnderRoot(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Sessions left out because their repo is outside `--root`: counted, never dropped silently. */
export interface OutsideRoot {
  directories: number;
  sessions: number;
}

/**
 * One summary row per repo, most recently active first.
 *
 * `root` limits the rows to repos inside it (default ~/Dev in the command).
 * Why a limit is needed: some test scripts launch REAL `claude` sessions in
 * mkdtemp directories (pkg/justin-sdk/scripts/probe-bg-env.ts,
 * probe-capture-entrypoint.ts), and Claude Code files a transcript for every
 * one of them, so an unlimited scan lists /private/var/folders/… as repos.
 * What the limit hides is COUNTED in `outsideRoot`, so the report can say so.
 */
export function summarizeRepos(
  sessions: readonly SessionFacts[],
  threadsReadable: boolean,
  root: string | null = null,
): {outsideRoot: OutsideRoot; summaries: RepoSummary[]; unplaced: number} {
  const byRepo = new Map<string, RepoSummary>();
  let unplaced = 0;
  const outsideDirs = new Set<string>();
  let outsideSessions = 0;
  for (const session of sessions) {
    if (session.repoRoot == null || session.repoResolvedBy == null) {
      unplaced += 1;
      continue;
    }
    if (root != null && !isUnderRoot(session.repoRoot, root)) {
      outsideSessions += 1;
      outsideDirs.add(session.repoRoot);
      continue;
    }
    let summary = byRepo.get(session.repoRoot);
    if (summary == null) {
      summary = {
        coverage: threadsReadable
          ? {backfilled: 0, none: 0, reported: 0, started: 0}
          : null,
        firstActivity: session.lastTimestamp,
        lastActivity: session.lastTimestamp,
        repoResolvedBy: session.repoResolvedBy,
        repoRoot: session.repoRoot,
        sessions: 0,
      };
      byRepo.set(session.repoRoot, summary);
    }
    summary.sessions += 1;
    if (session.lastTimestamp > summary.lastActivity) {
      summary.lastActivity = session.lastTimestamp;
    }
    if (session.lastTimestamp < summary.firstActivity) {
      summary.firstActivity = session.lastTimestamp;
    }
    if (session.repoResolvedBy === 'git') summary.repoResolvedBy = 'git';
    const coverage = summary.coverage;
    if (coverage != null) {
      const source = session.thread?.source ?? null;
      if (session.thread == null) coverage.none += 1;
      else if (source === 'report') coverage.reported += 1;
      else if (source === 'start') coverage.started += 1;
      else coverage.backfilled += 1;
    }
  }
  const summaries = [...byRepo.values()].sort((a, b) =>
    b.lastActivity.localeCompare(a.lastActivity),
  );
  return {
    outsideRoot: {directories: outsideDirs.size, sessions: outsideSessions},
    summaries,
    unplaced,
  };
}
