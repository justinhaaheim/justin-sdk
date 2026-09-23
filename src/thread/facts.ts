/**
 * The facts Claude must never type (home-base-p1uj D7).
 *
 * Everything here is MEASURED: the session id, the transcript, the repo and
 * branch, the head sha, whether the tree is dirty, how far it has diverged, the
 * context size at stop, and the last thing Justin actually said. A report that
 * asks Claude to type these gets them wrong — quietly, and in the direction of
 * whatever it last saw.
 *
 * RULE 6 IS THE WHOLE DESIGN OF THIS FILE. Every fact is `T | null`, and a null
 * is always accompanied by a named entry in `autofillFailures`. There is no
 * fact here whose failure is representable as a zero, an empty string or an
 * empty list: `dirty: false` means "measured, and it is clean", `aheadBehind:
 * null` means "could not measure", and the two are never the same value.
 * `aheadBehind` is ONE nullable object rather than two nullable numbers for the
 * same reason — "3 ahead, unknown behind" is not a state anybody can act on.
 *
 * THE TRANSCRIPT IS FOUND BY UUID, NEVER BY CWD. Claude Code files a transcript
 * under a slug of the directory the session STARTED in, and the session's cwd
 * can move afterwards (into a worktree, most often). Deriving the directory
 * from cwd therefore finds nothing for exactly the sessions that did the most
 * interesting work. home-base's scripts/thread-facts.ts proved the enumeration;
 * this is a much smaller reimplementation of just the part needed here, because
 * that script lives in another package and importing across the boundary would
 * couple the SDK to home-base's layout.
 */

import type {EnvLike} from './paths';

import {execFileSync} from 'child_process';
import {readdirSync, statSync} from 'fs';
import {homedir} from 'os';
import {basename, dirname, join, resolve} from 'path';

import {readTranscriptFacts} from '../usage-check';
import {
  extractTranscriptMessages,
  stripHarnessNoise,
  substantiveUserText,
} from './transcript-messages';

/**
 * Justin's messages are stored UNCAPPED (home-base-k0b8n K4).
 *
 * The cap that used to live here truncated the message on its way to the BEAD,
 * so the full text was gone forever and `thread search` (k0b8n.2) could never
 * find a phrase past character 1500. Capping is a RENDERING concern and now
 * lives in `report-model.ts` — `COMPACT_LAST_MESSAGE_CAP` and
 * `FULL_LAST_MESSAGE_CAP` — where it only shortens what is printed.
 */

export interface AheadBehind {
  ahead: number;
  behind: number;
}

export interface ThreadFacts {
  /**
   * Divergence from the upstream branch, or null. ONE object, so "half
   * measured" cannot be represented (rule 6.2).
   */
  aheadBehind: AheadBehind | null;
  /** One line per fact that could not be measured. Never silently empty. */
  autofillFailures: string[];
  branch: string | null;
  /** Always known: it is this process's own working directory. */
  cwd: string;
  /** Uncommitted changes present. false means MEASURED clean. */
  dirty: boolean | null;
  /** `cli`, `remote`, … as the transcript records it. */
  entrypoint: string | null;
  /** Justin's FIRST real message, verbatim, noise stripped, uncapped (K2). */
  firstUserMessage: string | null;
  /** The timestamp of the record `firstUserMessage` came from. */
  firstUserMessageAt: string | null;
  headSha: string | null;
  isWorktree: boolean | null;
  /** Claude's last response, verbatim, uncapped (K3). */
  lastAssistantMessage: string | null;
  /** The timestamp of the record `lastAssistantMessage` came from. */
  lastAssistantMessageAt: string | null;
  /** Justin's last real message, verbatim, noise stripped, uncapped (K2). */
  lastUserMessage: string | null;
  /** The timestamp of the record `lastUserMessage` came from. */
  lastUserMessageAt: string | null;
  model: string | null;
  /** Repository NAME (the main checkout's directory name), not the worktree's. */
  repo: string | null;
  /** Absolute path of this checkout's top level. */
  repoPath: string | null;
  /** ISO timestamp this report was produced. */
  reportedAt: string;
  /** `cd '<dir>' && claude --resume <id>`, ready to paste (K4). */
  resumeCommand: string | null;
  sessionId: string | null;
  /** First timestamp in the transcript. */
  startedAt: string | null;
  /** Context tokens on the last assistant record (usage-check's measurement). */
  tokensAtStop: number | null;
  transcriptPath: string | null;
  /** Absolute path when this checkout is a linked worktree, else null. */
  worktreePath: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Transcript discovery
// ---------------------------------------------------------------------------

/** Root Claude Code files transcripts under, overridable for tests. */
export function transcriptsRoot(env: EnvLike = process.env): string {
  const override = env.JUSTIN_THREADS_TRANSCRIPTS_ROOT;
  if (override != null && override !== '') return override;
  return join(homedir(), '.claude', 'projects');
}

export type TranscriptLookup =
  | {path: string; status: 'found'}
  | {searched: string; status: 'not-found'}
  | {error: string; status: 'failed'};

/**
 * Find `<sessionId>.jsonl` anywhere under the transcripts root.
 *
 * Scans every project directory rather than guessing one from cwd — see the
 * file header. A project directory that cannot be read is skipped rather than
 * failing the search, but a root that cannot be read is a FAILURE, not an empty
 * result: "there is no transcript" and "I could not look" are different facts
 * and only one of them is safe to record as null-with-no-reason.
 */
export function findTranscript(
  sessionId: string,
  env: EnvLike = process.env,
): TranscriptLookup {
  const root = transcriptsRoot(env);
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(root);
  } catch (error) {
    return {error: `readdir ${root}: ${errorMessage(error)}`, status: 'failed'};
  }
  const wanted = `${sessionId}.jsonl`;
  for (const projectDir of projectDirs) {
    const candidate = join(root, projectDir, wanted);
    try {
      if (statSync(candidate).isFile())
        return {path: candidate, status: 'found'};
    } catch {
      // Not in this project directory. Absence, not failure.
    }
  }
  return {searched: root, status: 'not-found'};
}

// ---------------------------------------------------------------------------
// Transcript reading
// ---------------------------------------------------------------------------

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Strip everything Claude Code injected, leaving only what Justin typed.
 *
 * The implementation moved to `transcript-messages.ts` (K1: one noise list, one
 * definition of substantive, shared by the report path and the backfill). This
 * name is kept because it is the one the existing callers and tests import.
 */
export const stripInjectedNoise = stripHarnessNoise;

/** The human-authored text of one user record, or null. See K2. */
export const userMessageText = substantiveUserText;

export interface TranscriptScan {
  entrypoint: string | null;
  /** Justin's FIRST real message, verbatim and UNCAPPED. */
  firstUserMessage: string | null;
  firstUserMessageAt: string | null;
  /** Claude's last response, verbatim and UNCAPPED (K3). */
  lastAssistantMessage: string | null;
  lastAssistantMessageAt: string | null;
  /** Justin's last real message, verbatim and UNCAPPED (K2/K4). */
  lastUserMessage: string | null;
  /**
   * The ISO timestamp of the record `lastUserMessage` came from, or null when
   * no user message was found.
   *
   * Added for the Stop hook (home-base-p1uj.15), which compares it against the
   * newest archived report to tell a recorded report from a hand-written one.
   * It is read from the SAME record as the text, in the same pass, so the two
   * can never describe different messages.
   */
  lastUserMessageAt: string | null;
  /** One line per field the extractor could not measure (rule 7). */
  messageFailures: string[];
  model: string | null;
  /** `cd '<dir>' && claude --resume <id>` (K4), or null. */
  resumeCommand: string | null;
  startedAt: string | null;
}

/**
 * Scan a transcript for the fields only it can answer.
 *
 * A THIN ADAPTER over `extractTranscriptMessages` since k0b8n.1 — the tail-
 * window-growing backward scan that used to live here is gone, and with it the
 * two ways this repo had of deciding what counts as one of Justin's messages.
 * The extractor makes one forward streaming pass, which also gets the FIRST
 * message and the last assistant response for free; the old reader could only
 * ever have answered "the last one".
 */
export function scanTranscriptForThread(path: string): TranscriptScan {
  const messages = extractTranscriptMessages(path);
  return {
    entrypoint: messages.entrypoint,
    firstUserMessage: messages.firstUserMessage,
    firstUserMessageAt: messages.firstUserMessageAt,
    lastAssistantMessage: messages.lastAssistantMessage,
    lastAssistantMessageAt: messages.lastAssistantMessageAt,
    lastUserMessage: messages.lastUserMessage,
    lastUserMessageAt: messages.lastUserMessageAt,
    messageFailures: messages.failures,
    model: messages.model,
    resumeCommand: messages.resumeCommand,
    startedAt: messages.firstTimestamp,
  };
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

type GitRead = {ok: true; value: string} | {error: string; ok: false};

function git(cwd: string, args: string[]): GitRead {
  try {
    const out = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {ok: true, value: out.trim()};
  } catch (error) {
    return {error: `git ${args.join(' ')}: ${errorMessage(error)}`, ok: false};
  }
}

export interface GitFacts {
  aheadBehind: AheadBehind | null;
  branch: string | null;
  dirty: boolean | null;
  failures: string[];
  headSha: string | null;
  isWorktree: boolean | null;
  repo: string | null;
  repoPath: string | null;
  worktreePath: string | null;
}

/**
 * Read the git facts for `cwd`.
 *
 * `repo` is derived from `--git-common-dir`, not from the checkout's own
 * directory name: in a linked worktree the directory is named after the BRANCH
 * (`.claude/worktrees/thread-reports`), and reporting that as the repo name
 * makes every worktree look like a different project.
 *
 * `aheadBehind` is null whenever there is no upstream at all — which is a
 * perfectly ordinary state for a local branch, and is recorded as a named
 * failure rather than as `{ahead: 0, behind: 0}`. That substitution is the
 * exact bug family critical rule 6 was written from: "0 commits ahead" reads
 * downstream as "fully merged, safe to delete".
 */
export function readGitFacts(cwd: string): GitFacts {
  const failures: string[] = [];
  const facts: GitFacts = {
    aheadBehind: null,
    branch: null,
    dirty: null,
    failures,
    headSha: null,
    isWorktree: null,
    repo: null,
    repoPath: null,
    worktreePath: null,
  };

  const topLevel = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!topLevel.ok) {
    failures.push(`repoPath: ${topLevel.error}`);
    return facts;
  }
  facts.repoPath = topLevel.value;

  const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch.ok) facts.branch = branch.value;
  else failures.push(`branch: ${branch.error}`);

  const head = git(cwd, ['rev-parse', 'HEAD']);
  if (head.ok) facts.headSha = head.value;
  else failures.push(`headSha: ${head.error}`);

  const gitDir = git(cwd, ['rev-parse', '--absolute-git-dir']);
  const commonDir = git(cwd, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  if (gitDir.ok && commonDir.ok) {
    facts.isWorktree = resolve(gitDir.value) !== resolve(commonDir.value);
    facts.worktreePath = facts.isWorktree ? facts.repoPath : null;
  } else {
    failures.push(
      `isWorktree: ${!gitDir.ok ? gitDir.error : (commonDir as {error: string}).error}`,
    );
  }
  if (commonDir.ok) {
    const common = resolve(commonDir.value);
    facts.repo = basename(
      basename(common) === '.git' ? dirname(common) : common,
    );
  } else {
    facts.repo = facts.repoPath == null ? null : basename(facts.repoPath);
  }

  const status = git(cwd, ['status', '--porcelain']);
  if (status.ok) facts.dirty = status.value !== '';
  else failures.push(`dirty: ${status.error}`);

  const divergence = git(cwd, [
    'rev-list',
    '--left-right',
    '--count',
    '@{upstream}...HEAD',
  ]);
  if (divergence.ok) {
    const parts = divergence.value.split(/\s+/);
    const behind = Number(parts[0]);
    const ahead = Number(parts[1]);
    if (
      Number.isFinite(behind) &&
      Number.isFinite(ahead) &&
      parts.length >= 2
    ) {
      facts.aheadBehind = {ahead, behind};
    } else {
      failures.push(
        `aheadBehind: could not parse "${divergence.value}" from git rev-list`,
      );
    }
  } else {
    failures.push(`aheadBehind: ${divergence.error} (no upstream branch?)`);
  }

  return facts;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export interface CollectFactsOptions {
  cwd?: string;
  env?: EnvLike;
  /** Injectable clock, so the renderer snapshot tests are deterministic. */
  now?: Date;
  /** Overrides CLAUDE_CODE_SESSION_ID (the `--session` flag). */
  sessionId?: string | null;
  /** Overrides transcript discovery entirely (the `--transcript` flag). */
  transcriptPath?: string | null;
}

/**
 * Measure everything. Never throws; every failure lands in `autofillFailures`.
 *
 * ⚠️ MEASURED 2026-09-12, and it matters: inside a SUBAGENT,
 * `CLAUDE_CODE_SESSION_ID` is the PARENT session's id, and the id's transcript
 * is the parent's file. A report written from a subagent is therefore a report
 * about the conductor's thread. That is a property of the environment, not of
 * this code, and it is left visible rather than papered over — the alternative
 * (guessing a subagent identity from a sidechain path) would silently key
 * threads on something Claude Code does not consider a session at all.
 */
export function collectThreadFacts(
  options: CollectFactsOptions = {},
): ThreadFacts {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? new Date();
  const autofillFailures: string[] = [];

  const sessionId =
    options.sessionId != null && options.sessionId !== ''
      ? options.sessionId
      : (asString(env.CLAUDE_CODE_SESSION_ID) ?? null);
  if (sessionId == null) {
    autofillFailures.push(
      'sessionId: CLAUDE_CODE_SESSION_ID is not set and --session was not passed',
    );
  }

  let transcriptPath: string | null = null;
  if (options.transcriptPath != null && options.transcriptPath !== '') {
    transcriptPath = options.transcriptPath;
  } else if (sessionId != null) {
    const lookup = findTranscript(sessionId, env);
    if (lookup.status === 'found') transcriptPath = lookup.path;
    else if (lookup.status === 'not-found') {
      autofillFailures.push(
        `transcriptPath: no ${sessionId}.jsonl under ${lookup.searched}`,
      );
    } else {
      autofillFailures.push(`transcriptPath: ${lookup.error}`);
    }
  }

  let tokensAtStop: number | null = null;
  let scan: TranscriptScan = {
    entrypoint: null,
    firstUserMessage: null,
    firstUserMessageAt: null,
    lastAssistantMessage: null,
    lastAssistantMessageAt: null,
    lastUserMessage: null,
    lastUserMessageAt: null,
    messageFailures: [],
    model: null,
    resumeCommand: null,
    startedAt: null,
  };
  if (transcriptPath != null) {
    try {
      // usage-check's reader, reused rather than reimplemented: it already
      // knows the usage shape and the tail-window growth. `lowestSetpoint` is
      // MAX_SAFE_INTEGER so its second job — hunting backwards for a prior
      // usage notice — can never be triggered; we only want the token count.
      const facts = readTranscriptFacts({
        lowestSetpoint: Number.MAX_SAFE_INTEGER,
        scope: 'session',
        transcriptPath,
      });
      tokensAtStop = facts.contextTokens;
      if (tokensAtStop == null) {
        autofillFailures.push(
          `tokensAtStop: no assistant record with usage found in ${transcriptPath}`,
        );
      }
    } catch (error) {
      autofillFailures.push(`tokensAtStop: ${errorMessage(error)}`);
    }
    try {
      scan = scanTranscriptForThread(transcriptPath);
      // The extractor already names every field it could not measure — the
      // messages, the resume command, any unparseable line. Adopting its list
      // wholesale is what keeps D7's promise that a null here always arrives
      // with a reason, without this function second-guessing which nulls the
      // extractor meant.
      autofillFailures.push(...scan.messageFailures);
    } catch (error) {
      autofillFailures.push(`transcript scan: ${errorMessage(error)}`);
    }
  } else {
    autofillFailures.push(
      'tokensAtStop, firstUserMessage, lastUserMessage, lastAssistantMessage, resumeCommand, startedAt, model: no transcript to read',
    );
  }

  const gitFacts = readGitFacts(cwd);
  autofillFailures.push(...gitFacts.failures);

  return {
    aheadBehind: gitFacts.aheadBehind,
    autofillFailures,
    branch: gitFacts.branch,
    cwd,
    dirty: gitFacts.dirty,
    entrypoint: scan.entrypoint,
    firstUserMessage: scan.firstUserMessage,
    firstUserMessageAt: scan.firstUserMessageAt,
    headSha: gitFacts.headSha,
    isWorktree: gitFacts.isWorktree,
    lastAssistantMessage: scan.lastAssistantMessage,
    lastAssistantMessageAt: scan.lastAssistantMessageAt,
    lastUserMessage: scan.lastUserMessage,
    lastUserMessageAt: scan.lastUserMessageAt,
    model: scan.model,
    repo: gitFacts.repo,
    repoPath: gitFacts.repoPath,
    reportedAt: now.toISOString(),
    resumeCommand: scan.resumeCommand,
    sessionId,
    startedAt: scan.startedAt,
    tokensAtStop,
    transcriptPath,
    worktreePath: gitFacts.worktreePath,
  };
}
