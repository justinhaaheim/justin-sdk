/**
 * The SESSION MODEL (status report v4, epic home-base-vzwbj.4 D2; built by
 * home-base-vzwbj.4.3): everything `thread status`, `thread show` and (dispatch
 * 4) `thread inbox` know about one Claude Code session, MEASURED — never typed
 * by Claude. Read from four places:
 *
 *  - the beads: the session bead, its requests, their children and every
 *    question, from the export of every beads DB the sessions index names for
 *    the session (session-tree.ts says why the export, not br);
 *  - git, in the session's checkout: branch, merged into the default branch or
 *    not, worktree, uncommitted paths (ignoring `.beads/`, which the session
 *    bead itself dirties), unpushed commits, and the commits THIS session made
 *    (attributed from its transcript, session-commits.ts — home-base-vzwbj.4.4);
 *  - the message log: first user message, last line, every user message;
 *  - the transcript: the last record's time (never the file mtime) and the
 *    context size through usage-check's reader.
 *
 * CRITICAL RULE 7 IS THE SHAPE OF THIS FILE. Every measurement is a
 * `Measured<T>`: a value, or a failure with its reason. Nothing defaults to 0,
 * [] or "clean"; a checkout that is gone makes every git measurement fail
 * with the path named, and status derivation then says "unknown", never
 * "answered".
 *
 * WHICH CHECKOUT (a decision of home-base-vzwbj.4.3, recorded in its notes):
 * the toplevel of the NEWEST working directory in the session's message log —
 * where the session is now, or ended — and the session bead's checkout only
 * when the log names none. A session that entered a worktree mid-session did
 * its work THERE; measuring the main checkout it started in would report
 * main's clean tree for a session with uncommitted worktree edits, which is
 * the reassuring direction rule 7 forbids. A newest directory that no longer
 * exists is measured as unreadable — never silently swapped for another.
 */

import type {MessageLine, MessageLogRead} from './message-log';
import type {EnvLike} from './paths';
import type {GitRun, SessionCommits} from './session-commits';
import type {SessionSighting} from './session-index';
import type {ExportRead, SessionTree} from './session-tree';

import {spawn} from 'child_process';
import {existsSync} from 'fs';
import {basename, dirname, isAbsolute, relative, resolve} from 'path';

import {findBeadsWorkspace} from '../beads/br';
import {findProjectRoot} from '../health-notices';
import {readTranscriptFacts} from '../usage-check';
import {findTranscript} from './facts';
import {readMessageLog} from './message-log';
import {
  CMUX_SURFACE_LABEL_PREFIX,
  CMUX_WORKSPACE_LABEL_PREFIX,
  labelValue,
  SID_LABEL_PREFIX,
} from './session-bead';
import {
  attributeCommits,
  readCommitEvidence,
  subagentTranscripts,
} from './session-commits';
import {
  corruptSightingsNote,
  readSessionIndex,
  readSessionSightings,
  sessionBeadSighting,
} from './session-index';
import {sessionIdForSelector, sessionIdFrom} from './session-select';
import {
  parseExportLine,
  readBeadsExport,
  readSessionTree,
} from './session-tree';
import {readHelperTail, readLastRecordTimestamp} from './transcript-messages';

/** A measurement: its value, or why it could not be taken. Never a stand-in. */
export type Measured<T> = {ok: false; reason: string} | {ok: true; value: T};

export function measured<T>(value: T): Measured<T> {
  return {ok: true, value};
}

export function unmeasured<T>(reason: string): Measured<T> {
  return {ok: false, reason};
}

export type MergeState = 'isDefault' | 'merged' | 'notMerged';

export type Unpushed =
  | {count: number; kind: 'counted'; upstream: string}
  | {kind: 'noUpstream'};

export type WorktreeKind = {kind: 'linked'; path: string} | {kind: 'primary'};

export interface GitMeasurements {
  /**
   * Commits on the branch that the default branch lacks (`git rev-list
   * --count <default>..<branch>`): the "N commits" of the dashboard's "merge
   * <branch> into main (N commits)" (home-base-j8q3e.1 D2, D3 rule 6). 0 on
   * the default branch itself.
   */
  aheadOfDefault: Measured<number>;
  /** `HEAD` when detached. */
  branch: Measured<string>;
  /** The checkout measured (absolute), and why that one. */
  checkout: string;
  checkoutSource: 'logCwd' | 'sessionBead';
  /**
   * The commits THIS session made: from its transcript (session-commits.ts),
   * or — labelled — the `--since` count when the transcript cannot be read
   * (home-base-vzwbj.4.4 item 4).
   */
  commits: Measured<SessionCommits>;
  /** The default branch "merged" is measured against, e.g. `main`. */
  defaultBranch: Measured<string>;
  merged: Measured<MergeState>;
  /** The repo's name from git's common dir; null when git could not say. */
  repo: string | null;
  /** `git status --porcelain` entries, `.beads/` excluded. */
  uncommitted: Measured<string[]>;
  unpushed: Measured<Unpushed>;
  worktree: Measured<WorktreeKind>;
}

/** A helper agent (subagent) still in flight, and its newest record (null = undated). */
export interface HelperInFlight {
  agentFile: string;
  lastRecordAt: string | null;
}

export interface TranscriptMeasurements {
  contextTokens: Measured<number>;
  /**
   * F10 (home-base-j8q3e.1.10): the session's helper agents still in flight,
   * read in the same pass as `lastRecordAt`; unmeasured exactly when it is.
   */
  helpers: Measured<HelperInFlight[]>;
  lastRecordAt: Measured<string>;
  path: string | null;
}

export interface SessionModel {
  beads: SessionTree;
  /** From the session bead's labels; null = not recorded (not a failure). */
  cmux: {surface: string | null; workspace: string | null};
  git: GitMeasurements;
  log: MessageLogRead;
  /** The repo's name, from the index (else git); null when neither knows. */
  repo: string | null;
  /**
   * The tag the session's name starts with (home-base-bomy5.7.1), resolved
   * once from the session's OWN checkout: its `projectTag`, else `repo`
   * uppercased; null exactly when `repo` is.
   */
  repoTag: string | null;
  sessionBeadId: string;
  sessionId: string;
  /** Every sighting the index holds for this session, newest first. */
  sightings: SessionSighting[];
  /** The request stage ladder in force (componentConfig.thread.stages). */
  stages: readonly string[];
  /** When the session's first prompt was sent. */
  startedAt: Measured<string>;
  transcript: TranscriptMeasurements;
  /** usage-check's wrap-up threshold; null means none is configured. */
  wrapUpAt: number | null;
}

export type SessionLoad =
  | {detail: string; kind: 'unreadable'}
  | {kind: 'loaded'; model: SessionModel}
  | {kind: 'noSession'; reason: string};

// ---------------------------------------------------------------------------
// The message log, read as the model needs it
// ---------------------------------------------------------------------------

/** The log's lines, or null when there is no log or it could not be read. */
export function logLines(log: MessageLogRead): MessageLine[] | null {
  return log.kind === 'read' ? log.lines : null;
}

/** Why the log has no lines to give, or null when it was read. */
export function logProblem(log: MessageLogRead): string | null {
  if (log.kind === 'missing') return `no message log at ${log.path}`;
  if (log.kind === 'failed') return `could not read ${log.path}: ${log.error}`;
  return null;
}

/** The first user line: measured (null = the log has none), or unreadable. */
export function firstUserLine(
  log: MessageLogRead,
): Measured<MessageLine | null> {
  const lines = logLines(log);
  if (lines == null) return unmeasured(logProblem(log) ?? 'no message log');
  return measured(lines.find((line) => line.role === 'user') ?? null);
}

/** Every user line, oldest first. */
export function userLines(log: MessageLogRead): Measured<MessageLine[]> {
  const lines = logLines(log);
  if (lines == null) return unmeasured(logProblem(log) ?? 'no message log');
  return measured(lines.filter((line) => line.role === 'user'));
}

/** The last line of the log, whatever its role (null = an empty log). */
export function lastLogLine(log: MessageLogRead): Measured<MessageLine | null> {
  const lines = logLines(log);
  if (lines == null) return unmeasured(logProblem(log) ?? 'no message log');
  return measured(lines.at(-1) ?? null);
}

/** The newest assistant line (null = Claude has not yielded yet). */
export function lastAssistantLine(
  log: MessageLogRead,
): Measured<MessageLine | null> {
  const lines = logLines(log);
  if (lines == null) return unmeasured(logProblem(log) ?? 'no message log');
  return measured(
    [...lines].reverse().find((line) => line.role === 'assistant') ?? null,
  );
}

/** The newest `at` among the lines — the log's own idea of last activity. */
export function newestLogAt(log: MessageLogRead): string | null {
  const lines = logLines(log);
  if (lines == null) return null;
  let newest: string | null = null;
  for (const line of lines) {
    if (line.at != null && (newest == null || line.at > newest)) {
      newest = line.at;
    }
  }
  return newest;
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

/** How long one git command may run before it is killed and failed. */
const GIT_TIMEOUT_MS = 30_000;

/**
 * Run git ASYNCHRONOUSLY (home-base-vzwbj.4.9 F7): the inbox loads sessions
 * concurrently, and a synchronous spawn would serialise every one of them.
 * The outcome has the same three shapes the synchronous runner had: `error`
 * (git could not run), `exit` (non-zero, or killed: status -1), `ok`.
 */
function runGit(cwd: string, args: string[]): Promise<GitRun> {
  return new Promise((done) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('git', args, {cwd, stdio: ['ignore', 'pipe', 'pipe']});
    } catch (error) {
      done({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));
    const timer = setTimeout(() => child.kill('SIGTERM'), GIT_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      done({kind: 'error', message: error.message});
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        done({kind: 'ok', stdout: Buffer.concat(out).toString('utf8')});
      } else {
        done({
          kind: 'exit',
          status: code ?? -1,
          stderr: Buffer.concat(err).toString('utf8').trim(),
        });
      }
    });
  });
}

function gitFailure(args: string[], run: GitRun): string {
  if (run.kind === 'error')
    return `git ${args.join(' ')} could not run: ${run.message}`;
  if (run.kind === 'exit') {
    const first = run.stderr.split('\n')[0] ?? '';
    return `git ${args.join(' ')} exited ${run.status}${first === '' ? '' : `: ${first}`}`;
  }
  return `git ${args.join(' ')} succeeded`;
}

/** Paths under `.beads/` are the session bead's own writes, not the work. */
export function isBeadsPath(path: string): boolean {
  const clean = path.replace(/^"|"$/g, '');
  return clean === '.beads' || clean.startsWith('.beads/');
}

/**
 * `git status --porcelain` entries, minus `.beads/`. A rename entry
 * (`R  old -> new`) counts as one path; it is excluded only when BOTH sides
 * are under `.beads/`.
 */
export function uncommittedFromPorcelain(porcelain: string): string[] {
  return porcelain
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => line.slice(3))
    .filter((path) => !path.split(' -> ').every(isBeadsPath));
}

function allFailed(
  checkout: string,
  checkoutSource: GitMeasurements['checkoutSource'],
  reason: string,
): GitMeasurements {
  return {
    aheadOfDefault: unmeasured(reason),
    branch: unmeasured(reason),
    checkout,
    checkoutSource,
    commits: unmeasured(reason),
    defaultBranch: unmeasured(reason),
    merged: unmeasured(reason),
    repo: null,
    uncommitted: unmeasured(reason),
    unpushed: unmeasured(reason),
    worktree: unmeasured(reason),
  };
}

/** The repo's default branch: origin/HEAD, else a local `main`. */
async function defaultBranchOf(top: string): Promise<Measured<string>> {
  const args = ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'];
  const head = await runGit(top, args);
  if (head.kind === 'ok') {
    const ref = head.stdout.trim();
    const name = ref.replace(/^refs\/remotes\/origin\//, '');
    if (name !== '' && name !== ref) return measured(name);
  }
  const main = await runGit(top, [
    'rev-parse',
    '--verify',
    '--quiet',
    'refs/heads/main',
  ]);
  if (main.kind === 'ok') return measured('main');
  return unmeasured(
    `no default branch: refs/remotes/origin/HEAD is not set and there is no local main branch`,
  );
}

async function mergeStateOf(
  top: string,
  branch: Measured<string>,
  defaultBranch: Measured<string>,
): Promise<Measured<MergeState>> {
  if (!branch.ok) return unmeasured(branch.reason);
  if (!defaultBranch.ok) return unmeasured(defaultBranch.reason);
  if (branch.value === defaultBranch.value) return measured('isDefault');
  const args = [
    'merge-base',
    '--is-ancestor',
    branch.value,
    defaultBranch.value,
  ];
  const run = await runGit(top, args);
  if (run.kind === 'ok') return measured('merged');
  if (run.kind === 'exit' && run.status === 1) return measured('notMerged');
  return unmeasured(gitFailure(args, run));
}

/** home-base-j8q3e.1 D3 rule 6: how many commits the branch has that main lacks. */
async function aheadOfDefaultOf(
  top: string,
  branch: Measured<string>,
  defaultBranch: Measured<string>,
): Promise<Measured<number>> {
  if (!branch.ok) return unmeasured(branch.reason);
  if (!defaultBranch.ok) return unmeasured(defaultBranch.reason);
  if (branch.value === defaultBranch.value) return measured(0);
  const args = [
    'rev-list',
    '--count',
    `${defaultBranch.value}..${branch.value}`,
  ];
  const run = await runGit(top, args);
  if (run.kind !== 'ok') return unmeasured(gitFailure(args, run));
  const text = run.stdout.trim();
  // Strict (rule 7): `Number('')` is 0, and an empty answer is not "none".
  if (!/^\d+$/.test(text)) {
    return unmeasured(
      `git ${args.join(' ')} printed ${JSON.stringify(text)}, not a count`,
    );
  }
  return measured(Number(text));
}

/**
 * Primary checkout or linked worktree. `isWorktree` is the git dir compared
 * with the common dir (measured once in `measureCheckout`), and `commonDir` is
 * that common dir, so this runs no git of its own.
 */
function worktreeOf(
  top: string,
  isWorktree: Measured<boolean>,
  commonDir: string | null,
): Measured<WorktreeKind> {
  if (!isWorktree.ok) return unmeasured(isWorktree.reason);
  if (!isWorktree.value) return measured({kind: 'primary'});
  if (commonDir == null) return measured({kind: 'linked', path: top});
  const mainRoot = commonDir.endsWith('/.git') ? dirname(commonDir) : null;
  if (mainRoot == null) return measured({kind: 'linked', path: top});
  const rel = relative(mainRoot, top);
  return measured({
    kind: 'linked',
    path: rel === '' || rel.startsWith('..') || isAbsolute(rel) ? top : rel,
  });
}

async function unpushedOf(top: string): Promise<Measured<Unpushed>> {
  const nameArgs = [
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{upstream}',
  ];
  const name = await runGit(top, nameArgs);
  if (
    name.kind === 'exit' &&
    /no upstream|does not point to a branch/i.test(name.stderr)
  ) {
    return measured({kind: 'noUpstream'});
  }
  if (name.kind !== 'ok') return unmeasured(gitFailure(nameArgs, name));
  const upstream = name.stdout.trim();
  const countArgs = ['rev-list', '--count', '@{upstream}..HEAD'];
  const count = await runGit(top, countArgs);
  if (count.kind !== 'ok') return unmeasured(gitFailure(countArgs, count));
  const text = count.stdout.trim();
  if (!/^\d+$/.test(text)) {
    return unmeasured(
      `git ${countArgs.join(' ')} printed ${JSON.stringify(text)}, not a count`,
    );
  }
  return measured({count: Number(text), kind: 'counted', upstream});
}

/** The FALLBACK count: commits on HEAD since the first prompt (epic D2's rule). */
async function commitsSince(
  top: string,
  firstPromptAt: Measured<string>,
): Promise<Measured<number>> {
  if (!firstPromptAt.ok) {
    return unmeasured(
      `no first prompt to count from (${firstPromptAt.reason})`,
    );
  }
  const args = ['log', `--since=${firstPromptAt.value}`, '--format=%H', 'HEAD'];
  const run = await runGit(top, args);
  if (run.kind !== 'ok') return unmeasured(gitFailure(args, run));
  return measured(
    run.stdout.split('\n').filter((line) => /^[0-9a-f]{7,}$/.test(line.trim()))
      .length,
  );
}

/** Where the session's transcript is, or why it could not be found. */
export type TranscriptLocation =
  | {ok: false; reason: string}
  | {ok: true; path: string};

/**
 * This session's commits (home-base-vzwbj.4.4 item 4): from the transcript
 * when it can be read, resolved in `top`; else the `--since` count, LABELLED
 * with why the transcript could not be used. Never a bare 0 for "could not
 * tell" (rule 7).
 */
async function sessionCommits(
  top: string,
  transcript: TranscriptLocation,
  firstPromptAt: Measured<string>,
): Promise<Measured<SessionCommits>> {
  const read = transcript.ok
    ? readCommitEvidence(transcript.path)
    : {ok: false as const, reason: transcript.reason};
  if (read.ok) {
    const attributed = await attributeCommits(read.evidence, (args) =>
      runGit(top, args),
    );
    return attributed.ok
      ? measured(attributed.value)
      : unmeasured(attributed.reason);
  }
  const since = await commitsSince(top, firstPromptAt);
  if (!since.ok) {
    return unmeasured(
      `the transcript could not be read (${read.reason}), and the fallback count failed too: ${since.reason}`,
    );
  }
  return measured({
    count: since.value,
    fallbackBecause: read.reason,
    source: 'sinceFirstPrompt',
  });
}

/**
 * What git says about a CHECKOUT, whoever's session it is: everything in
 * GitMeasurements except the session's own commits. One per distinct checkout
 * path per inbox run (home-base-vzwbj.4.9 F7) — many sessions share home-base
 * main, and these are most of a session's git subprocesses.
 */
export type CheckoutGit =
  | {kind: 'failed'; reason: string}
  | {
      aheadOfDefault: Measured<number>;
      branch: Measured<string>;
      /**
       * git's common dir, absolute (`<main checkout>/.git` for a normal repo);
       * null when git could not say. The dashboard's untracked sessions
       * (home-base-j8q3e.1.2) place a checkout in its repo from it, exactly as
       * repo-status's `resolveRepoRoot` does.
       */
      commonDir: string | null;
      defaultBranch: Measured<string>;
      kind: 'measured';
      merged: Measured<MergeState>;
      repo: string | null;
      top: string;
      uncommitted: Measured<string[]>;
      unpushed: Measured<Unpushed>;
      worktree: Measured<WorktreeKind>;
    };

/**
 * What one inbox run shares between the sessions it loads, and nothing else:
 * no entry outlives the run (the bead's AC 3 — nothing is cached ACROSS runs).
 * A failed measurement is shared like a good one: two sessions in one checkout
 * see the same checkout, and a session's own failures (its transcript, its
 * commits) are never in here.
 */
export interface LoadCache {
  checkouts: Map<string, Promise<CheckoutGit>>;
  exports: Map<string, ExportRead>;
  /** Each directory's declared `projectTag`, for `resolveRepoTag` (bomy5.7.2). */
  repoTags: Map<string, string | null>;
}

export function createLoadCache(): LoadCache {
  return {checkouts: new Map(), exports: new Map(), repoTags: new Map()};
}

async function measureCheckout(checkout: string): Promise<CheckoutGit> {
  if (!existsSync(checkout)) {
    return {
      kind: 'failed',
      reason: `checkout unreadable: ${checkout} no longer exists`,
    };
  }
  const topArgs = ['rev-parse', '--show-toplevel'];
  const topRun = await runGit(checkout, topArgs);
  if (topRun.kind !== 'ok' || topRun.stdout.trim() === '') {
    return {
      kind: 'failed',
      reason: `checkout unreadable: ${checkout} (${gitFailure(topArgs, topRun)})`,
    };
  }
  const top = topRun.stdout.trim();
  // ALL ASYNCHRONOUS (home-base-j8q3e.1.2): the dashboard measures every
  // checkout any recent session used (29 on 2026-10-15), and the synchronous
  // `readGitFacts` this used to call ran 8 git commands per checkout one after
  // another (2.3 s for 29), two of them repeats of `status` and the upstream
  // count below. Only the three it needed are kept: the branch, and the git
  // dir against the common dir (linked worktree or not, and the repo's name).
  const branchArgs = ['rev-parse', '--abbrev-ref', 'HEAD'];
  const gitDirArgs = ['rev-parse', '--absolute-git-dir'];
  const commonArgs = [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ];
  const statusArgs = ['status', '--porcelain'];
  const [branchRun, gitDirRun, commonRun, defaultBranch, status, unpushed] =
    await Promise.all([
      runGit(top, branchArgs),
      runGit(top, gitDirArgs),
      runGit(top, commonArgs),
      defaultBranchOf(top),
      runGit(top, statusArgs),
      unpushedOf(top),
    ]);
  const branchName = branchRun.kind === 'ok' ? branchRun.stdout.trim() : '';
  const branch: Measured<string> =
    branchName !== ''
      ? measured(branchName)
      : unmeasured(`branch: ${gitFailure(branchArgs, branchRun)}`);
  const commonDir =
    commonRun.kind === 'ok' && commonRun.stdout.trim() !== ''
      ? resolve(commonRun.stdout.trim())
      : null;
  const gitDir =
    gitDirRun.kind === 'ok' && gitDirRun.stdout.trim() !== ''
      ? resolve(gitDirRun.stdout.trim())
      : null;
  const isWorktree: Measured<boolean> =
    gitDir != null && commonDir != null
      ? measured(gitDir !== commonDir)
      : unmeasured(
          `isWorktree: ${gitDir == null ? gitFailure(gitDirArgs, gitDirRun) : gitFailure(commonArgs, commonRun)}`,
        );
  const repo =
    commonDir != null
      ? basename(
          basename(commonDir) === '.git' ? dirname(commonDir) : commonDir,
        )
      : basename(top);
  const [aheadOfDefault, merged] = await Promise.all([
    aheadOfDefaultOf(top, branch, defaultBranch),
    mergeStateOf(top, branch, defaultBranch),
  ]);
  return {
    aheadOfDefault,
    branch,
    commonDir,
    defaultBranch,
    kind: 'measured',
    merged,
    repo,
    top,
    uncommitted:
      status.kind === 'ok'
        ? measured(uncommittedFromPorcelain(status.stdout))
        : unmeasured(gitFailure(statusArgs, status)),
    unpushed,
    worktree: worktreeOf(top, isWorktree, commonDir),
  };
}

/**
 * One checkout's git facts, measured once per run through `cache` and shared
 * by every session in it — tracked or not (home-base-j8q3e.1.2). A failed
 * measurement is shared like a good one.
 */
export async function measureCheckoutCached(
  checkout: string,
  cache: LoadCache | null,
): Promise<CheckoutGit> {
  let pending = cache?.checkouts.get(checkout);
  if (pending == null) {
    pending = measureCheckout(checkout);
    cache?.checkouts.set(checkout, pending);
  }
  return await pending;
}

/**
 * Every git measurement for `checkout`. A checkout that is gone, or is not a
 * git checkout, fails EVERY measurement with the path named (rule 7). With a
 * `cache`, the checkout's half is measured once per run and shared; the
 * session's commits are always its own.
 */
export async function measureGit(input: {
  cache?: LoadCache;
  checkout: string;
  checkoutSource: GitMeasurements['checkoutSource'];
  firstPromptAt: Measured<string>;
  transcript: TranscriptLocation;
}): Promise<GitMeasurements> {
  const {checkout, checkoutSource} = input;
  const shared = await measureCheckoutCached(checkout, input.cache ?? null);
  if (shared.kind === 'failed') {
    return allFailed(checkout, checkoutSource, shared.reason);
  }
  return {
    aheadOfDefault: shared.aheadOfDefault,
    branch: shared.branch,
    checkout: shared.top,
    checkoutSource,
    commits: await sessionCommits(
      shared.top,
      input.transcript,
      input.firstPromptAt,
    ),
    defaultBranch: shared.defaultBranch,
    merged: shared.merged,
    repo: shared.repo,
    uncommitted: shared.uncommitted,
    unpushed: shared.unpushed,
    worktree: shared.worktree,
  };
}

// ---------------------------------------------------------------------------
// The transcript
// ---------------------------------------------------------------------------

/**
 * The session's last activity: the newest conversation record of its main
 * transcript AND of every subagent transcript beside it
 * (`<transcript dir>/<session id>/subagents/agent-*.jsonl`, the files the
 * commit attribution already reads) — home-base-vzwbj.4.9 F6. A conductor
 * waiting on its players writes nothing to its own transcript, so reading the
 * main file alone showed it ⚠️ idle, with a stale time, while players worked.
 *
 * A subagent file with no timestamped record is a measured "nothing there".
 * The listing or any subagent file that cannot be READ makes the whole answer
 * unmeasured, naming it (critical rule 7): the newest of the files that could
 * be read is not the newest activity when one file is unknown.
 *
 * From the same reads, the helper agents still in flight (F10,
 * home-base-j8q3e.1.10; `readHelperTail` says how a helper's tail is read).
 * Whatever makes the last activity unmeasured makes the helpers unmeasured
 * too, with the same reason.
 */
export function readActivity(
  transcriptPath: string,
): Pick<TranscriptMeasurements, 'helpers' | 'lastRecordAt'> {
  const fail = (
    reason: string,
  ): Pick<TranscriptMeasurements, 'helpers' | 'lastRecordAt'> => ({
    helpers: unmeasured(reason),
    lastRecordAt: unmeasured(reason),
  });
  const main = readLastRecordTimestamp(transcriptPath);
  if (main.kind === 'failed') return fail(main.reason);
  const subagents = subagentTranscripts(transcriptPath);
  if (!subagents.ok) return fail(subagents.reason);
  let newest: {at: string; ms: number} | null = null;
  const consider = (at: string): void => {
    const ms = Date.parse(at);
    if (Number.isNaN(ms)) return;
    if (newest == null || ms > newest.ms) newest = {at, ms};
  };
  if (main.kind === 'found') consider(main.at);
  const inFlight: HelperInFlight[] = [];
  for (const file of subagents.files) {
    const read = readHelperTail(file);
    if (read.kind === 'failed') return fail(read.reason);
    if (read.kind !== 'found') continue;
    if (read.at != null) consider(read.at);
    if (read.inFlight) inFlight.push({agentFile: file, lastRecordAt: read.at});
  }
  const helpers = measured(inFlight);
  const found = newest as {at: string; ms: number} | null;
  if (found != null) return {helpers, lastRecordAt: measured(found.at)};
  if (main.kind === 'found') {
    // Found, but not a date Date.parse reads: the raw value, as before F6.
    return {helpers, lastRecordAt: measured(main.at)};
  }
  return {
    helpers,
    lastRecordAt: unmeasured(
      subagents.files.length === 0
        ? main.reason
        : `${main.reason}; nor does any of its ${subagents.files.length} subagent transcripts`,
    ),
  };
}

/** `readActivity`'s last activity alone (its doc above `readActivity`). */
export function readLastActivityAt(transcriptPath: string): Measured<string> {
  return readActivity(transcriptPath).lastRecordAt;
}

/**
 * The transcript measurements of a transcript whose path is already known (the
 * dashboard's untracked sessions are found BY their transcript,
 * home-base-j8q3e.1.2): its context size through usage-check's reader, and its
 * last activity, subagents included.
 */
export function measureTranscriptAt(path: string): TranscriptMeasurements {
  let contextTokens: Measured<number>;
  try {
    // usage-check's reader, never a sum of message.usage here (pkg CLAUDE.md:
    // an advisor record's usage double-counts). MAX_SAFE_INTEGER keeps its
    // second job — hunting back for a prior notice — from ever running.
    const facts = readTranscriptFacts({
      lowestSetpoint: Number.MAX_SAFE_INTEGER,
      scope: 'session',
      transcriptPath: path,
    });
    contextTokens =
      facts.contextTokens != null
        ? measured(facts.contextTokens)
        : unmeasured(
            `no context reading in ${path} (no assistant record with usage, or the file could not be read)`,
          );
  } catch (error) {
    contextTokens = unmeasured(
      `could not read the context size from ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {contextTokens, ...readActivity(path), path};
}

export function measureTranscript(
  sessionId: string,
  env: EnvLike,
): TranscriptMeasurements {
  const lookup = findTranscript(sessionId, env);
  if (lookup.status !== 'found') {
    const reason =
      lookup.status === 'not-found'
        ? `no transcript ${sessionId}.jsonl under ${lookup.searched}`
        : `could not look for the transcript: ${lookup.error}`;
    return {
      contextTokens: unmeasured(reason),
      helpers: unmeasured(reason),
      lastRecordAt: unmeasured(reason),
      path: null,
    };
  }
  return measureTranscriptAt(lookup.path);
}

// ---------------------------------------------------------------------------
// Finding the session
// ---------------------------------------------------------------------------

/** The `sid:` session id a bead carries, found in any export we know of. */
function sessionIdFromBead(
  beadId: string,
  input: {cwd: string; env: EnvLike},
):
  | {kind: 'failed'; reason: string}
  | {kind: 'found'; sessionId: string}
  | {kind: 'unknown'; searched: string[]} {
  const dirs: string[] = [];
  const index = readSessionIndex(input.env);
  if (index.kind === 'failed') {
    return {
      kind: 'failed',
      reason: `the sessions index is unreadable: ${index.path}: ${index.error}`,
    };
  }
  const workspace = findBeadsWorkspace(input.cwd);
  if (workspace.kind === 'found') dirs.push(workspace.beadsDir);
  if (index.kind === 'read') {
    for (const session of index.sessions) {
      for (const sighting of session.sightings) dirs.push(sighting.beadsDir);
    }
  }
  const needle = `"id":${JSON.stringify(beadId)}`;
  const searched: string[] = [];
  for (const dir of [...new Set(dirs)]) {
    const read = readBeadsExport(dir);
    searched.push(read.path);
    if (read.kind === 'failed' || !read.text.includes(needle)) continue;
    const line = read.text.split('\n').find((entry) => entry.includes(needle));
    if (line == null) continue;
    const parsed = parseExportLine(line, dir);
    if (!parsed.ok || parsed.issue.id !== beadId) continue;
    const sid = parsed.issue.labels.find((label) =>
      label.startsWith(SID_LABEL_PREFIX),
    );
    if (sid != null)
      return {kind: 'found', sessionId: sid.slice(SID_LABEL_PREFIX.length)};
  }
  return {kind: 'unknown', searched};
}

/**
 * Which session `selector` names: a session bead id or a Claude session id
 * (through the index), else any bead carrying a `sid:` label (a request or a
 * question — `thread show <id>`). No selector: `--session`, else
 * CLAUDE_CODE_SESSION_ID.
 */
export function resolveSessionId(input: {
  cwd: string;
  env: EnvLike;
  selector: string | null;
  sessionIdOption: string | null;
}):
  | {kind: 'failed'; reason: string}
  | {kind: 'found'; sessionId: string}
  | {kind: 'noSession'; reason: string} {
  const selector = input.selector?.trim() ?? '';
  if (selector === '') {
    const session = sessionIdFrom(input.sessionIdOption, input.env);
    return session.ok
      ? {kind: 'found', sessionId: session.id}
      : {kind: 'noSession', reason: session.reason};
  }
  const indexed = sessionIdForSelector(selector, input.env);
  if (indexed.kind === 'found') return indexed;
  if (indexed.kind === 'failed') return indexed;
  const viaBead = sessionIdFromBead(selector, input);
  if (viaBead.kind !== 'unknown') return viaBead;
  return {
    kind: 'noSession',
    reason: `${indexed.reason}, and no bead ${selector} carrying a ${SID_LABEL_PREFIX} label is in ${viaBead.searched.length > 0 ? viaBead.searched.join(' or ') : 'any beads export (the index names none, and the current directory has no beads workspace)'}`,
  };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** The `Started: <ISO>` line the capture child wrote into the description. */
function startedFromDescription(description: string | null): string | null {
  const line = description
    ?.split('\n')
    .find((entry) => entry.startsWith('Started: '));
  const value = line?.slice('Started: '.length).trim() ?? '';
  return value === '' ? null : value;
}

/**
 * Load one session's model. `unreadable` only when the index itself cannot be
 * read; a gone checkout, an unreadable export or a missing transcript are
 * measurements that FAILED inside a loaded model, each with its reason.
 */
export async function loadSession(input: {
  /**
   * Shared by every session one inbox run loads (F7): each checkout's git
   * facts and each beads export, read once. Omitted: nothing is shared.
   */
  cache?: LoadCache;
  cwd: string;
  env: EnvLike;
  selector: string | null;
  sessionIdOption: string | null;
}): Promise<SessionLoad> {
  const {cwd, env} = input;
  const resolved = resolveSessionId(input);
  if (resolved.kind === 'failed')
    return {detail: resolved.reason, kind: 'unreadable'};
  if (resolved.kind === 'noSession')
    return {kind: 'noSession', reason: resolved.reason};
  const {sessionId} = resolved;

  const read = readSessionSightings(sessionId, env);
  if (read.kind === 'failed') {
    return {
      detail: `the sessions index is unreadable: ${read.path}: ${read.error}`,
      kind: 'unreadable',
    };
  }
  const sightings = read.kind === 'read' ? read.sightings : [];
  const created = sessionBeadSighting(sightings);
  // R9 (home-base-vzwbj.4.9): a corrupt index line naming this session is
  // said — in the refusal, and in Part 1 as a beads problem (a second DB it
  // named may hold requests nobody can see, so the status is not claimed).
  const corruptNote = corruptSightingsNote(read);
  if (created == null) {
    return {
      kind: 'noSession',
      reason: `${corruptNote != null ? `${corruptNote}; ` : ''}no session bead is recorded for session ${sessionId} in ${read.path} (componentConfig.thread.sessionBeads was off when its prompts were captured, the capture hook is not installed, or the repo has no beads workspace)`,
    };
  }

  // The session bead's own DB first, then every other DB the index names.
  const beadsDirs = [
    created.beadsDir,
    ...sightings.map((entry) => entry.beadsDir),
  ];
  const {cache} = input;
  const tree = readSessionTree({
    beadsDirs,
    ...(cache != null
      ? {
          readExport: (dir: string): ExportRead => {
            const known = cache.exports.get(dir);
            if (known != null) return known;
            const exported = readBeadsExport(dir);
            cache.exports.set(dir, exported);
            return exported;
          },
        }
      : {}),
    sessionBeadId: created.beadId,
    sessionId,
  });
  const beads =
    corruptNote == null
      ? tree
      : {...tree, problems: [...tree.problems, corruptNote]};

  const log = readMessageLog(sessionId, env);
  const first = firstUserLine(log);
  const lines = logLines(log);
  const newestCwd =
    lines == null
      ? null
      : ([...lines].reverse().find((line) => line.cwd != null)?.cwd ?? null);

  const firstPromptAt: Measured<string> = first.ok
    ? first.value?.at != null
      ? measured(first.value.at)
      : unmeasured(
          first.value == null
            ? 'the message log has no user line'
            : 'the first user line has no time',
        )
    : unmeasured(first.reason);

  const transcript = measureTranscript(sessionId, env);
  const git = await measureGit({
    ...(cache != null ? {cache} : {}),
    checkout: newestCwd ?? created.checkoutPath,
    checkoutSource: newestCwd != null ? 'logCwd' : 'sessionBead',
    firstPromptAt,
    transcript:
      transcript.path != null
        ? {ok: true, path: transcript.path}
        : {
            ok: false,
            reason: transcript.lastRecordAt.ok
              ? 'no transcript path'
              : transcript.lastRecordAt.reason,
          },
  });

  const fromBead = startedFromDescription(beads.session?.description ?? null);
  const startedAt: Measured<string> = firstPromptAt.ok
    ? firstPromptAt
    : fromBead != null
      ? measured(fromBead)
      : unmeasured(firstPromptAt.reason);

  // Config (the ladder, the wrap-up threshold) is the session checkout's when
  // it exists, else the caller's directory.
  const configDir = existsSync(git.checkout) ? git.checkout : cwd;
  const {resolveReportWrapUpAt, resolveRepoTag, resolveThreadConfig} =
    await import('./config');
  const stages = resolveThreadConfig({cwd: configDir, env}).stages;
  const wrapUpAt = resolveReportWrapUpAt(findProjectRoot(configDir));
  const repo = created.repo ?? git.repo;
  // The tag, unlike the ladder, never falls back to the caller's directory: a
  // cross-repo inbox would print the caller's tag on every repo's sessions.
  const repoTag = resolveRepoTag({
    ...(cache != null ? {cache: cache.repoTags} : {}),
    checkout: git.checkout,
    env,
    repo,
  });

  // The cmux ids are display-only pointers: an unreadable session bead (said
  // on the Session line) simply shows no pane line.
  const session = beads.session;
  return {
    kind: 'loaded',
    model: {
      beads,
      cmux: {
        surface:
          session == null
            ? null
            : labelValue(session.labels, CMUX_SURFACE_LABEL_PREFIX),
        workspace:
          session == null
            ? null
            : labelValue(session.labels, CMUX_WORKSPACE_LABEL_PREFIX),
      },
      git,
      log,
      repo,
      repoTag,
      sessionBeadId: created.beadId,
      sessionId,
      sightings,
      stages,
      startedAt,
      transcript,
      wrapUpAt,
    },
  };
}
