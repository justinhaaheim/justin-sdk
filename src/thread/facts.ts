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

import {closeSync, openSync, readdirSync, readSync, statSync} from 'fs';
import {basename, dirname, join, resolve} from 'path';
import {homedir} from 'os';
import {execFileSync} from 'child_process';

import {readTranscriptFacts} from '../usage-check';

import type {EnvLike} from './paths';

/** How many characters of Justin's last message are kept (D7). */
export const LAST_USER_MESSAGE_CAP = 1500;

/** Bytes read from the tail of a transcript per attempt, before growing. */
const TAIL_WINDOW_BYTES = 512 * 1024;

/** Stop growing the tail window here; a transcript can be 44MB. */
const MAX_TAIL_BYTES = 8 * 1024 * 1024;

/** Bytes read from the head, for the session's first timestamp. */
const HEAD_BYTES = 64 * 1024;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  headSha: string | null;
  isWorktree: boolean | null;
  /** Justin's last real message, verbatim, noise stripped, capped. */
  lastUserMessage: string | null;
  model: string | null;
  /** ISO timestamp this report was produced. */
  reportedAt: string;
  /** Repository NAME (the main checkout's directory name), not the worktree's. */
  repo: string | null;
  /** Absolute path of this checkout's top level. */
  repoPath: string | null;
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
  | {status: 'found'; path: string}
  | {status: 'not-found'; searched: string}
  | {status: 'failed'; error: string};

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

interface TranscriptRecord {
  isMeta?: unknown;
  isSidechain?: unknown;
  entrypoint?: unknown;
  message?: {content?: unknown; model?: unknown; role?: unknown};
  timestamp?: unknown;
  toolUseResult?: unknown;
  type?: unknown;
}

function readChunk(path: string, start: number, length: number): string {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(length);
    const bytes = readSync(fd, buf, 0, length, start);
    return buf.subarray(0, bytes).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function parseLines(
  chunk: string,
  dropFirst: boolean,
  dropLast: boolean,
): TranscriptRecord[] {
  const lines = chunk.split('\n');
  const start = dropFirst ? 1 : 0;
  const end = dropLast ? lines.length - 1 : lines.length;
  const records: TranscriptRecord[] = [];
  for (let i = start; i < end; i += 1) {
    const line = lines[i]?.trim();
    if (line == null || line === '') continue;
    try {
      records.push(JSON.parse(line) as TranscriptRecord);
    } catch {
      // A partially-written trailing line is normal on a live transcript.
    }
  }
  return records;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Noise Claude Code injects INTO a user turn. None of it is something Justin
 * typed, and every one of them has been observed sitting in front of a real
 * message rather than replacing it — so these are stripped from the text, not
 * used to reject the record.
 */
const NOISE_BLOCKS = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<task-notification>[\s\S]*?<\/task-notification>/g,
  /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g,
  /<command-name>[\s\S]*?<\/command-name>/g,
  /<command-message>[\s\S]*?<\/command-message>/g,
  /<command-args>[\s\S]*?<\/command-args>/g,
  /<user-prompt-submit-hook>[\s\S]*?<\/user-prompt-submit-hook>/g,
];

/**
 * An UNCLOSED injected block at the end of the text. A system-reminder is
 * sometimes the last thing in a record and its closing tag lands in the next
 * one; without this the whole reminder would be reported as Justin's message.
 */
const TRAILING_OPEN_BLOCK = /<(system-reminder|task-notification)>[\s\S]*$/;

/** Strip everything Claude Code injected, leaving only what Justin typed. */
export function stripInjectedNoise(text: string): string {
  let out = text;
  for (const pattern of NOISE_BLOCKS) out = out.replace(pattern, '');
  out = out.replace(TRAILING_OPEN_BLOCK, '');
  return out.trim();
}

/**
 * The human-authored text of one user record, or null when it has none.
 *
 * `tool_result` blocks are tool output wearing a user record's clothes — they
 * are the bulk of the `type: "user"` records in any real transcript — so a
 * record is read only for its `text` blocks, and a record carrying
 * `toolUseResult` is skipped outright. `isMeta` marks Claude Code's own
 * injections (the session preamble, `/clear`, hook envelopes).
 */
export function userMessageText(record: TranscriptRecord): string | null {
  if (record.type !== 'user') return null;
  if (record.isMeta === true) return null;
  if (record.toolUseResult != null) return null;
  const content = record.message?.content;
  let raw: string;
  if (typeof content === 'string') {
    raw = content;
  } else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block == null || typeof block !== 'object') continue;
      const typed = block as {text?: unknown; type?: unknown};
      // Anything that is not a text block is tool traffic or an image.
      if (typed.type !== 'text') return null;
      if (typeof typed.text === 'string') parts.push(typed.text);
    }
    raw = parts.join('\n');
  } else {
    return null;
  }
  const stripped = stripInjectedNoise(raw);
  return stripped === '' ? null : stripped;
}

export interface TranscriptScan {
  entrypoint: string | null;
  lastUserMessage: string | null;
  model: string | null;
  startedAt: string | null;
}

/**
 * Scan a transcript for the four fields only it can answer.
 *
 * The tail is read first and GROWN until a user message is found or the file is
 * exhausted, because a long tool-driven stretch can push Justin's last message
 * a long way back. The head is read once, for the session's first timestamp.
 *
 * Sidechain records are skipped: they belong to subagents, and a subagent's
 * prompt is written by Claude, not by Justin.
 */
export function scanTranscriptForThread(path: string): TranscriptScan {
  const scan: TranscriptScan = {
    entrypoint: null,
    lastUserMessage: null,
    model: null,
    startedAt: null,
  };

  const size = statSync(path).size;

  let tailBytes = Math.min(TAIL_WINDOW_BYTES, Math.max(size, 1));
  for (;;) {
    const readWholeFile = size <= tailBytes;
    const chunk = readChunk(
      path,
      readWholeFile ? 0 : size - tailBytes,
      readWholeFile ? size : tailBytes,
    );
    const records = parseLines(chunk, !readWholeFile, false);
    for (let i = records.length - 1; i >= 0; i -= 1) {
      const record = records[i];
      if (record == null) continue;
      if (record.isSidechain === true) continue;
      scan.entrypoint ??= asString(record.entrypoint);
      if (scan.model == null && record.type === 'assistant') {
        scan.model = asString(record.message?.model);
      }
      if (scan.lastUserMessage == null) {
        const text = userMessageText(record);
        if (text != null) {
          scan.lastUserMessage =
            text.length > LAST_USER_MESSAGE_CAP
              ? text.slice(0, LAST_USER_MESSAGE_CAP)
              : text;
        }
      }
    }
    const exhausted = readWholeFile || tailBytes >= MAX_TAIL_BYTES;
    if (scan.lastUserMessage != null || exhausted) break;
    tailBytes = Math.min(tailBytes * 4, MAX_TAIL_BYTES, size);
  }

  const headRecords = parseLines(
    readChunk(path, 0, Math.min(size, HEAD_BYTES)),
    false,
    size > HEAD_BYTES,
  );
  for (const record of headRecords) {
    scan.startedAt ??= asString(record.timestamp);
    scan.entrypoint ??= asString(record.entrypoint);
    if (scan.startedAt != null && scan.entrypoint != null) break;
  }

  return scan;
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

type GitRead = {ok: true; value: string} | {ok: false; error: string};

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
  /** Overrides CLAUDE_CODE_SESSION_ID (the `--session` flag). */
  sessionId?: string | null;
  /** Overrides transcript discovery entirely (the `--transcript` flag). */
  transcriptPath?: string | null;
  /** Injectable clock, so the renderer snapshot tests are deterministic. */
  now?: Date;
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
    lastUserMessage: null,
    model: null,
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
    } catch (error) {
      autofillFailures.push(`transcript scan: ${errorMessage(error)}`);
    }
    if (scan.lastUserMessage == null) {
      autofillFailures.push(
        `lastUserMessage: no human-authored user record found in ${transcriptPath}`,
      );
    }
  } else {
    autofillFailures.push(
      'tokensAtStop, lastUserMessage, startedAt, model: no transcript to read',
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
    headSha: gitFacts.headSha,
    isWorktree: gitFacts.isWorktree,
    lastUserMessage: scan.lastUserMessage,
    model: scan.model,
    reportedAt: now.toISOString(),
    repo: gitFacts.repo,
    repoPath: gitFacts.repoPath,
    sessionId,
    startedAt: scan.startedAt,
    tokensAtStop,
    transcriptPath,
    worktreePath: gitFacts.worktreePath,
  };
}
