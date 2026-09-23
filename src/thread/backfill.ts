/**
 * `justin-sdk thread backfill` — a thread bead for every session, not just the
 * polite ones (home-base-k0b8n.3, decision K5).
 *
 * WHY IT EXISTS. The sweep of 2026-09-18 found 14 of 23 sessions in three days
 * had no thread bead at all: the hook is not installed everywhere, `thread
 * start` needs two knobs, and a session that dies before its report leaves
 * nothing behind. Search (K8) over a corpus with two thirds of the sessions
 * missing is not search. This command reads what Claude Code already wrote to
 * disk and makes the corpus complete.
 *
 * WHAT IT READS: every `~/.claude/projects/<slug>/<uuid>.jsonl`. READ ONLY,
 * always — nothing under `~/.claude/projects` is ever written, moved or
 * removed by this command or by anything it calls.
 * WHAT IT WRITES: thread beads in the threads repo (`~/Dev/threads`), and one
 * git commit of that repo per run (D13).
 * WHAT IT NEVER TOUCHES: a CLOSED thread bead, and the title/description/notes/
 * status of any thread a real session created. Those belong to the report path;
 * all this command may do to them is fill in verbatim messages they never had.
 *
 * IDEMPOTENT BY CONSTRUCTION. Sessions are keyed on `metadata.sessionId` (D1),
 * the same key `thread start` and `thread report` upsert on, so a session that
 * later reports REWRITES its backfill bead rather than gaining a second one.
 * A second run of this command with no new transcript activity creates nothing
 * and writes nothing.
 *
 * COST (K5). ONE `bd list` of every thread up front, then the whole diff is
 * in-process. Per-session lookups — 200+ of them, hourly, against the same
 * database live sessions are writing to — is the shape this deliberately
 * avoids.
 */

import type {BdContext, BdIssue} from './bd';
import type {EnvLike} from './paths';
import type {TranscriptMessages} from './transcript-messages';

import {readdirSync, statSync} from 'fs';
import {join} from 'path';

import {
  BODY_COLUMN,
  HEADER_COLUMN,
  type OutputStyle,
  outputStyle,
  pad,
  paint,
  PLAIN_STYLE,
  spacedList,
  wrapHanging,
} from '../cli-style';
import {SDK_RUN} from '../sdk-invocation';
import {
  bdContext,
  createThread,
  describeBdFailure,
  listThreads,
  mergeMetadata,
  updateThreadBody,
} from './bd';
import {commitThreadsRepo, describeCommit} from './commit';
import {readGitFacts, transcriptsRoot} from './facts';
import {syncMessageLogFromTranscript} from './message-log';
import {THREAD_SCHEMA_VERSION} from './schema';
import {extractTranscriptMessages} from './transcript-messages';

/** `metadata.source` on a bead this command created. */
export const BACKFILL_SOURCE = 'backfill';

/** `metadata.messagesSource` when the verbatim messages were read by this command. */
export const BACKFILL_MESSAGES_SOURCE = 'backfill';

/** Default window. Justin's stated horizon for "find that conversation". */
export const DEFAULT_BACKFILL_DAYS = 30;

/**
 * How far BEFORE the window a file's mtime may be and still be read.
 *
 * THE MTIME PRE-FILTER, AND WHY IT IS SOUND IN ONE DIRECTION ONLY. The window
 * is decided by the LAST RECORD'S TIMESTAMP, never mtime — cmux resume touches
 * a transcript without adding a record, so mtime reports activity that did not
 * happen. That failure is in the "too new" direction: a touched file looks
 * recent. The pre-filter only ever skips files that look OLD, and a record
 * cannot be written to a file after the file was last modified, so
 * `mtime < windowStart` implies `lastTimestamp < windowStart`. The grace period
 * absorbs clock skew and any filesystem that reports mtime coarsely.
 *
 * It matters because the corpus is 2.8 GB across ~1,750 session files (measured
 * 2026-09-19) and this runs hourly; reading all of it to learn that 1,500 files
 * are months old is the kind of cost that gets a scheduled job turned off. The
 * count of files it skipped is REPORTED (`skippedOldMtime`), so the reduced
 * scan is never silent.
 */
export const MTIME_GRACE_DAYS = 2;

/**
 * Project directories the scan skips, with the reason.
 *
 * MEASURED, not guessed: `scripts/e2e-justin-loop.ts:453` creates each scenario
 * repo under `mkdtempSync(join(tmpdir(), 'justin-loop-e2e-<scenario>-'))`, and
 * a project directory name is the cwd with every non-alphanumeric byte replaced
 * by a dash — so the literal `justin-loop-e2e-` survives into the slug
 * (`-private-var-folders-…-T-justin-loop-e2e-a-6S7JYc-repo`). 25 transcripts in
 * 17 such directories existed on this machine at the time of writing. They are
 * a test harness driving a real `claude`, so they DO contain real-looking user
 * messages — the "no substantive message" filter would not catch them.
 */
export const SKIPPED_PROJECT_DIR_PATTERNS: readonly {
  reason: string;
  test: (dirName: string) => boolean;
}[] = [
  {
    reason: 'justin-loop e2e fixture repo (scripts/e2e-justin-loop.ts)',
    test: (dirName) => dirName.includes('justin-loop-e2e-'),
  },
];

/** `<uuid>.jsonl`, either case — every session file on this machine matches (measured over 1,750). */
const SESSION_FILE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

export interface DiscoveredFile {
  /** The session id from the FILENAME. The record's own id wins when they disagree. */
  fileSessionId: string;
  path: string;
  projectDir: string;
}

export interface DiscoveryResult {
  /**
   * Every reason a candidate was not returned. NEVER a silent drop: an
   * unreadable project directory and an empty one are different facts.
   */
  failures: string[];
  files: DiscoveredFile[];
  skippedAgentFiles: number;
  skippedFixtureDirs: string[];
  skippedNonSessionFiles: number;
  skippedOldMtime: number;
}

export interface DiscoveryOptions {
  env?: EnvLike;
  /** Files whose mtime is older than this are not opened. Null disables the pre-filter. */
  windowStart?: Date | null;
}

/**
 * Every session transcript worth opening, under the transcripts root.
 *
 * ONE LEVEL DEEP, deliberately. A subagent's transcript lives either beside its
 * parent as `agent-*.jsonl` or under `<uuid>/subagents/`, and neither is a
 * session: the first is skipped by name, the second by never recursing. A
 * subagent does not get its own thread bead (the same rule `thread start`
 * enforces with its `agent_id` guard).
 *
 * AN UNREADABLE ROOT IS A FAILURE, NOT AN EMPTY LIST (rule 7). So is an
 * unreadable project directory: "there are no sessions" and "I could not look"
 * would otherwise both render as a calm `0 sessions in window`.
 */
export function discoverSessionFiles(
  options: DiscoveryOptions = {},
): DiscoveryResult {
  const env = options.env ?? process.env;
  const root = transcriptsRoot(env);
  const result: DiscoveryResult = {
    failures: [],
    files: [],
    skippedAgentFiles: 0,
    skippedFixtureDirs: [],
    skippedNonSessionFiles: 0,
    skippedOldMtime: 0,
  };

  let projectDirs: string[];
  try {
    projectDirs = readdirSync(root);
  } catch (error) {
    result.failures.push(
      `readdir ${root}: ${error instanceof Error ? error.message : String(error)} — the scan saw NOTHING, so the counts below are not a measurement of this machine`,
    );
    return result;
  }

  const mtimeFloor =
    options.windowStart == null
      ? null
      : options.windowStart.getTime() - MTIME_GRACE_DAYS * 86_400_000;

  for (const projectDir of projectDirs.sort()) {
    const skipRule = SKIPPED_PROJECT_DIR_PATTERNS.find((rule) =>
      rule.test(projectDir),
    );
    if (skipRule != null) {
      result.skippedFixtureDirs.push(`${projectDir} (${skipRule.reason})`);
      continue;
    }
    let entries: string[];
    try {
      entries = readdirSync(join(root, projectDir));
    } catch (error) {
      // A FILE here (not a directory) is the common case and is not a failure
      // worth naming; anything else is.
      let isDirectory = false;
      try {
        isDirectory = statSync(join(root, projectDir)).isDirectory();
      } catch {
        isDirectory = true; // cannot tell — report it rather than swallow it
      }
      if (isDirectory) {
        result.failures.push(
          `readdir ${join(root, projectDir)}: ${error instanceof Error ? error.message : String(error)} — its sessions were NOT scanned`,
        );
      }
      continue;
    }

    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      if (entry.startsWith('agent-')) {
        result.skippedAgentFiles += 1;
        continue;
      }
      if (!SESSION_FILE.test(entry)) {
        result.skippedNonSessionFiles += 1;
        continue;
      }
      const path = join(root, projectDir, entry);
      if (mtimeFloor != null) {
        try {
          if (statSync(path).mtimeMs < mtimeFloor) {
            result.skippedOldMtime += 1;
            continue;
          }
        } catch (error) {
          // Could not stat: DO NOT skip. An unmeasurable mtime is not evidence
          // the file is old, and the extractor below reports its own failure.
          result.failures.push(
            `stat ${path}: ${error instanceof Error ? error.message : String(error)} — read anyway rather than assumed old`,
          );
        }
      }
      result.files.push({
        fileSessionId: entry.slice(0, -'.jsonl'.length),
        path,
        projectDir,
      });
    }
  }
  return result;
}

export interface BackfillSession {
  lastTimestamp: string;
  messages: TranscriptMessages;
  projectDir: string;
  /** The id everything is keyed on (D1): the record's own, else the filename's. */
  sessionId: string;
  transcriptPath: string;
}

export interface ScanResult {
  failures: string[];
  /** Read, dated, inside the window, and carrying at least one real user message. */
  sessions: BackfillSession[];
  /** Inside the window but with nothing Justin said — `claude -p` probes, hook-only runs. */
  skippedNoUserMessage: number;
  /** Read but last active before the window. */
  skippedOutOfWindow: number;
  /** Read but with no readable timestamp at all: cannot be placed in or out. */
  skippedUndated: number;
  /**
   * The undated transcripts, by path, so the skip is named and not just counted.
   *
   * NOT a failure list (k0b8n.7 F1). See `scanSessions` for why.
   */
  undatedFiles: string[];
}

/**
 * Read every discovered transcript and keep the ones this run is about.
 *
 * A TRANSCRIPT THAT CANNOT BE READ IS A NAMED FAILURE, not one fewer session:
 * `extractTranscriptMessages` throws on an unreadable file, and swallowing that
 * would turn "I could not open 40 files" into a quieter number of sessions with
 * nothing to show for the difference.
 *
 * AN UNDATED TRANSCRIPT IS A PER-FILE SKIP, NOT A RUN FAILURE (k0b8n.7 F1). It
 * was a failure until 2026-09-19, which made every real run on this machine exit
 * 1 — three transcripts here carry no timestamp on any record — so the daily
 * `thread-backfill` chore would have been recorded FAILED for ever, which is the
 * kind of noise that teaches you to stop reading the board. It is still MEASURED
 * and still NAMED: counted in `skippedUndated`, listed in `undatedFiles`, and
 * printed under a `note:` line. What stays a run failure is anything that means
 * the run did not do its job: a projects directory that could not be read, a
 * transcript that could not be opened, a failed bd read, and any write that did
 * not land.
 */
export function scanSessions(
  files: readonly DiscoveredFile[],
  windowStart: Date,
): ScanResult {
  const result: ScanResult = {
    failures: [],
    sessions: [],
    skippedNoUserMessage: 0,
    skippedOutOfWindow: 0,
    skippedUndated: 0,
    undatedFiles: [],
  };
  const floor = windowStart.toISOString();
  for (const file of files) {
    let messages: TranscriptMessages;
    try {
      messages = extractTranscriptMessages(file.path);
    } catch (error) {
      result.failures.push(
        `read ${file.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (messages.lastTimestamp == null) {
      result.skippedUndated += 1;
      result.undatedFiles.push(file.path);
      continue;
    }
    // ISO-8601 UTC strings from the same producer compare lexicographically the
    // way they compare chronologically; Date.parse on every record would cost a
    // parse per file for no extra truth.
    if (messages.lastTimestamp < floor) {
      result.skippedOutOfWindow += 1;
      continue;
    }
    if (messages.firstUserMessage == null) {
      result.skippedNoUserMessage += 1;
      continue;
    }
    if (
      messages.sessionId != null &&
      messages.sessionId !== file.fileSessionId
    ) {
      result.failures.push(
        `${file.path}: the records say sessionId ${messages.sessionId} but the filename says ${file.fileSessionId}; keyed on the records' id`,
      );
    }
    result.sessions.push({
      lastTimestamp: messages.lastTimestamp,
      messages,
      projectDir: file.projectDir,
      sessionId: messages.sessionId ?? file.fileSessionId,
      transcriptPath: file.path,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// The diff
// ---------------------------------------------------------------------------

export type BackfillAction =
  | {kind: 'create'; session: BackfillSession}
  | {kind: 'refreshBackfill'; session: BackfillSession; threadId: string}
  | {
      kind: 'refreshMessages';
      patch: Record<string, unknown>;
      session: BackfillSession;
      threadId: string;
    }
  | {
      kind: 'unchanged';
      reason: string;
      session: BackfillSession;
      threadId: string;
    };

/** The six verbatim-message fields, rewritten together or not at all (K5). */
const MESSAGE_KEYS = [
  'firstUserMessage',
  'firstUserMessageAt',
  'lastAssistantMessage',
  'lastAssistantMessageAt',
  'lastUserMessage',
  'lastUserMessageAt',
  'resumeCommand',
] as const;

function metaOf(issue: BdIssue): Record<string, unknown> {
  return issue.metadata ?? {};
}

function metaString(meta: Record<string, unknown>, key: string): string | null {
  const value = meta[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** The newest thing the BEAD claims about itself. Null means it claims nothing. */
export function storedActivityAt(meta: Record<string, unknown>): string | null {
  const candidates = [
    metaString(meta, 'lastActivityAt'),
    metaString(meta, 'reportedAt'),
  ].filter((value): value is string => value != null);
  if (candidates.length === 0) return null;
  return candidates.sort().at(-1) ?? null;
}

/** The K4 message fields this session's transcript says, plus the stamps that date them. */
function messagePatch(session: BackfillSession): Record<string, unknown> {
  const {messages} = session;
  return {
    firstUserMessage: messages.firstUserMessage,
    firstUserMessageAt: messages.firstUserMessageAt,
    lastActivityAt: session.lastTimestamp,
    lastAssistantMessage: messages.lastAssistantMessage,
    lastAssistantMessageAt: messages.lastAssistantMessageAt,
    lastUserMessage: messages.lastUserMessage,
    lastUserMessageAt: messages.lastUserMessageAt,
    messagesSource: BACKFILL_MESSAGES_SOURCE,
    resumeCommand: messages.resumeCommand,
  };
}

function patchWouldChange(
  patch: Record<string, unknown>,
  meta: Record<string, unknown>,
): boolean {
  for (const [key, value] of Object.entries(patch)) {
    const current = meta[key] ?? null;
    if ((current ?? null) !== (value ?? null)) return true;
  }
  return false;
}

/**
 * What this run would do to each session, decided entirely in process.
 *
 * `threads` must be EVERY thread bead including CLOSED ones. A closed thread is
 * still a session's one bead (D1): reading only open threads would make this
 * create a second bead for every session Justin has finished, which is the one
 * outcome that would make the board worse rather than better.
 */
export function planBackfill(
  sessions: readonly BackfillSession[],
  threads: readonly BdIssue[],
): {actions: BackfillAction[]; failures: string[]} {
  const failures: string[] = [];
  const bySession = new Map<string, BdIssue[]>();
  for (const thread of threads) {
    const sessionId = metaString(metaOf(thread), 'sessionId');
    if (sessionId == null) continue;
    const bucket = bySession.get(sessionId);
    if (bucket == null) bySession.set(sessionId, [thread]);
    else bucket.push(thread);
  }

  const actions: BackfillAction[] = [];
  for (const session of sessions) {
    const matches = bySession.get(session.sessionId) ?? [];
    if (matches.length > 1) {
      // D1 says one bead per session. Writing to one of several would pick a
      // winner silently and make the duplicate permanent.
      failures.push(
        `session ${session.sessionId} already has ${matches.length} thread beads (${matches
          .map((thread) => thread.id)
          .join(', ')}); D1 says one. NOTHING was written for it.`,
      );
      continue;
    }
    const existing = matches[0];
    if (existing == null) {
      actions.push({kind: 'create', session});
      continue;
    }
    const meta = metaOf(existing);
    if (existing.status === 'closed') {
      actions.push({
        kind: 'unchanged',
        reason: 'the thread is closed — a closed thread is never touched (K5)',
        session,
        threadId: existing.id,
      });
      continue;
    }

    const advanced = (() => {
      const stored = storedActivityAt(meta);
      return stored == null || session.lastTimestamp > stored;
    })();

    if (metaString(meta, 'source') === BACKFILL_SOURCE) {
      // WE own this bead's whole body, so the refresh rewrites all of it — but
      // only when the transcript actually moved. An hourly job that rewrote
      // every backfilled bead every hour would churn the threads repo's git
      // history into noise and say a thousand things happened when none did.
      if (!advanced) {
        actions.push({
          kind: 'unchanged',
          reason: 'the transcript has not advanced since the last backfill',
          session,
          threadId: existing.id,
        });
        continue;
      }
      actions.push({kind: 'refreshBackfill', session, threadId: existing.id});
      continue;
    }

    // A thread a REAL session created (`source` absent, 'start' or 'report').
    // The report path owns its title, description, notes and status; all this
    // may do is fill in the verbatim messages, which every bead written before
    // 2026-09-19 lacks entirely (K5, and k0b8n.1's note about th-lve).
    const anyMessageMissing = MESSAGE_KEYS.some(
      (key) => metaString(meta, key) == null,
    );
    if (!anyMessageMissing && !advanced) {
      actions.push({
        kind: 'unchanged',
        reason: 'its messages are present and the transcript has not advanced',
        session,
        threadId: existing.id,
      });
      continue;
    }
    const patch = messagePatch(session);
    if (!patchWouldChange(patch, meta)) {
      // The trigger fired but there is nothing to write: a field is null
      // because the TRANSCRIPT has no such message (a session Claude never
      // answered), not because nobody looked. Writing it every hour forever is
      // what this branch exists to stop.
      actions.push({
        kind: 'unchanged',
        reason: 'the transcript says exactly what the bead already says',
        session,
        threadId: existing.id,
      });
      continue;
    }
    actions.push({
      kind: 'refreshMessages',
      patch,
      session,
      threadId: existing.id,
    });
  }
  return {actions, failures};
}

// ---------------------------------------------------------------------------
// The bead body
// ---------------------------------------------------------------------------

/** First non-empty line of the first user message, at most 100 characters. */
export function backfillTitle(session: BackfillSession): string {
  const first = session.messages.firstUserMessage ?? '';
  const line =
    first
      .split('\n')
      .map((candidate) => candidate.trim())
      .find((candidate) => candidate !== '') ?? '';
  const label = line === '' ? `session ${session.sessionId.slice(0, 8)}` : line;
  return label.length <= 100 ? label : `${label.slice(0, 99)}…`;
}

export interface BackfillGitFacts {
  branch: string | null;
  repo: string | null;
  repoPath: string | null;
}

/**
 * Repo, path and branch for a session that is over.
 *
 * ONLY ON THE CREATE PATH, deliberately: this shells out to git three times,
 * and a refresh does not need it. On the first run that is a few hundred calls
 * once; afterwards it is however many sessions are new this hour.
 *
 * THE BRANCH THE SESSION WAS ON WINS over the branch the directory is on now.
 * The transcript records the branch contemporaneously; `git branch --show-current`
 * a week later answers a different question.
 */
export function gitFactsForSession(session: BackfillSession): BackfillGitFacts {
  const cwd = session.messages.cwd ?? session.messages.firstCwd;
  if (cwd == null) {
    return {branch: session.messages.gitBranch, repo: null, repoPath: null};
  }
  const git = readGitFacts(cwd);
  return {
    branch: session.messages.gitBranch ?? git.branch,
    repo: git.repo,
    repoPath: git.repoPath,
  };
}

export function backfillDescription(
  session: BackfillSession,
  git: BackfillGitFacts,
): string {
  const {messages} = session;
  return [
    'BACKFILLED FROM THE TRANSCRIPT — this session never reported.',
    '',
    `repo          ${git.repo ?? 'UNKNOWN'}`,
    `branch        ${git.branch ?? 'UNKNOWN'}`,
    `cwd           ${messages.cwd ?? messages.firstCwd ?? 'UNKNOWN'}`,
    `started       ${messages.firstTimestamp ?? 'UNKNOWN'}`,
    `last activity ${session.lastTimestamp}`,
    `session       ${session.sessionId}`,
    `transcript    ${session.transcriptPath}`,
    '',
    'Resume it:',
    `  ${messages.resumeCommand ?? 'UNKNOWN — no cwd was recorded in the transcript'}`,
    '',
    `Created by \`${SDK_RUN} thread backfill\` from what Claude Code wrote to disk,`,
    'because no status report was ever written for this session. The first',
    `\`${SDK_RUN} thread report\` for it rewrites this bead in place — it does not`,
    'create a second one.',
    ...(messages.failures.length === 0
      ? []
      : [
          '',
          'Not measurable from the transcript:',
          ...messages.failures.map((line) => `  - ${line}`),
        ]),
  ].join('\n');
}

/**
 * `notes` is the last thing Claude said, verbatim (D10: `bd show` alone is a
 * complete record). A session Claude never answered says so rather than being
 * given an empty notes field, which would read as "it said nothing".
 */
export function backfillNotes(session: BackfillSession): string {
  const last = session.messages.lastAssistantMessage;
  if (last == null) {
    return [
      'LAST CLAUDE RESPONSE: (not captured)',
      '',
      ...(session.messages.failures.length === 0
        ? ['No assistant record in this transcript carries any text.']
        : session.messages.failures.map((line) => `  - ${line}`)),
    ].join('\n');
  }
  return ['LAST CLAUDE RESPONSE (verbatim):', '', last].join('\n');
}

export function backfillMetadata(
  session: BackfillSession,
  git: BackfillGitFacts,
): Record<string, unknown> {
  const {messages} = session;
  return {
    branch: git.branch,
    cwd: messages.cwd ?? messages.firstCwd,
    entrypoint: messages.entrypoint,
    firstUserMessage: messages.firstUserMessage,
    firstUserMessageAt: messages.firstUserMessageAt,
    lastActivityAt: session.lastTimestamp,
    lastAssistantMessage: messages.lastAssistantMessage,
    lastAssistantMessageAt: messages.lastAssistantMessageAt,
    lastUserMessage: messages.lastUserMessage,
    lastUserMessageAt: messages.lastUserMessageAt,
    messagesSource: BACKFILL_MESSAGES_SOURCE,
    model: messages.model,
    // NEVER a fabricated report (rule 7). A backfilled session reported
    // nothing, so every field a report would have filled stays null and
    // `reportCount: 0` says out loud that it is a measured zero.
    progressPercent: null,
    repo: git.repo,
    repoPath: git.repoPath,
    reportCount: 0,
    reportedAt: null,
    resumeCommand: messages.resumeCommand,
    schemaVersion: THREAD_SCHEMA_VERSION,
    sessionId: session.sessionId,
    source: BACKFILL_SOURCE,
    startedAt: messages.firstTimestamp,
    stopReasonDetail: null,
    stopReasonKind: null,
    transcriptPath: session.transcriptPath,
    transcriptReadFailures: messages.failures,
  };
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

/**
 * What the run did to the per-session message logs (K10 e). Counted apart from
 * the beads because the two can disagree — a log is rewritten even when bd is
 * down, and a bead is refreshed even when its log was already current.
 */
export interface MessageLogCounts {
  /** Live lines newer than the transcript's end, kept after a rewrite. */
  carried: number;
  failed: number;
  /** Lines in the logs written (or, on a dry run, that would be written). */
  messages: number;
  unchanged: number;
  written: number;
}

/**
 * Rewrite `messages/<sessionId>.jsonl` from the transcript for EVERY session in
 * the window (K10 e) — reported or not, bead or not.
 *
 * AUTHORITATIVE: the transcript's every turn replaces whatever the log held,
 * and only a live line newer than the transcript's last record is kept after
 * it (`carriedLiveLines`). Run BEFORE the bd read, on purpose: search reads the
 * logs directly, so a locked Dolt database must not also cost the run its
 * message coverage.
 *
 * `claude -p` sessions are NOT excluded here, although `thread capture` skips
 * them live: the brief says every session in the window, and whether the
 * backfill should import `-p` sessions at all is a separate question
 * (home-base-k0b8n.9's notes name the bead that asks it).
 */
export function syncSessionLogs(
  sessions: readonly BackfillSession[],
  options: {dryRun: boolean; env: EnvLike},
): {counts: MessageLogCounts; failures: string[]} {
  const counts: MessageLogCounts = {
    carried: 0,
    failed: 0,
    messages: 0,
    unchanged: 0,
    written: 0,
  };
  const failures: string[] = [];
  for (const session of sessions) {
    const outcome = syncMessageLogFromTranscript({
      dryRun: options.dryRun,
      env: options.env,
      sessionId: session.sessionId,
      transcriptPath: session.transcriptPath,
    });
    if (outcome.kind === 'failed') {
      counts.failed += 1;
      failures.push(
        `message log NOT rewritten — ${outcome.path}: ${outcome.error}`,
      );
      continue;
    }
    counts[outcome.kind] += 1;
    counts.carried += outcome.carried;
    if (outcome.kind === 'written') counts.messages += outcome.messages;
  }
  return {counts, failures};
}

export interface BackfillSummary {
  created: number;
  days: number;
  dryRun: boolean;
  /** Every named failure. A non-empty list means the counts above are incomplete. */
  failures: string[];
  /** The per-session message logs (K10 e). */
  messageLogs: MessageLogCounts;
  refreshed: number;
  refreshedBackfill: number;
  refreshedMessages: number;
  /** Discovery + read counts, so a reduced scan is never silent. */
  scan: {
    filesRead: number;
    skippedAgentFiles: number;
    skippedFixtureDirs: string[];
    skippedNoUserMessage: number;
    skippedNonSessionFiles: number;
    skippedOldMtime: number;
    skippedOutOfWindow: number;
    skippedUndated: number;
    /** The undated transcripts by path — a named skip, never a failure (F1). */
    undatedFiles: string[];
  };
  sessionsInWindow: number;
  unchanged: number;
}

/** The one line (K5). `S skipped` counts sessions in the window with nothing Justin said. */
/**
 * The run's summary, man-page style (K11): a header at column 2 that says
 * whether anything was written, then the three facts — the window, the beads,
 * the message logs — each at the body column with a blank line between.
 */
export function describeBackfill(
  summary: BackfillSummary,
  style: OutputStyle = PLAIN_STYLE,
): string {
  const {color, width} = style;
  const logs = summary.messageLogs;
  const failed =
    logs.failed > 0
      ? `, ${paint(`${logs.failed} FAILED`, ['bold', 'red'], color)}`
      : '';
  const body = (text: string): string =>
    wrapHanging(text, {hang: BODY_COLUMN, indent: BODY_COLUMN, width});
  const title = summary.dryRun
    ? `backfill — ${paint('DRY RUN, nothing was written', ['yellow'], color)}`
    : 'backfill';
  return spacedList([
    `${pad(HEADER_COLUMN)}📼 ${paint(title, ['bold'], color)}`,
    body(`${summary.sessionsInWindow} sessions in window`),
    body(
      `${summary.created} created, ${summary.refreshed} refreshed, ${summary.scan.skippedNoUserMessage} skipped (no user message), ${summary.unchanged} unchanged`,
    ),
    body(
      `message logs: ${logs.written} ${summary.dryRun ? 'would be written' : 'written'} (${logs.messages} messages), ${logs.unchanged} unchanged${failed}`,
    ),
  ]);
}

/**
 * The `note:` block for the undated transcripts, or null when there were none.
 *
 * A NOTE, NOT A WARNING (F1): nothing about the run went wrong, and these files
 * are named every run because the skip is permanent — a transcript with no
 * timestamp on any record can never be placed in or out of the window, so the
 * only way it stops being reported is if it stops existing.
 */
export function describeUndated(
  summary: BackfillSummary,
  style: OutputStyle = PLAIN_STYLE,
): string | null {
  const files = summary.scan.undatedFiles;
  if (files.length === 0) return null;
  const count = summary.scan.skippedUndated;
  const head =
    count === 1
      ? 'note: 1 transcript carries no timestamp on any record, so it can be placed neither inside nor outside the window and was skipped:'
      : `note: ${count} transcripts carry no timestamp on any record, so they can be placed neither inside nor outside the window and were skipped:`;
  // K11: the note at column 2, its paths at the body column — a path is never
  // wrapped, so it still pastes.
  return spacedList([
    wrapHanging(head, {
      hang: BODY_COLUMN,
      indent: HEADER_COLUMN,
      width: style.width,
    }),
    ...files.map((path) => `${pad(BODY_COLUMN)}- ${path}`),
  ]);
}

export interface BackfillOptions {
  /** Overrides componentConfig.thread.autoCommit. Tests pin it. */
  autoCommit?: boolean;
  days?: number;
  dryRun?: boolean;
  env?: EnvLike;
  json?: boolean;
  now?: Date;
}

/**
 * The decision half: scan, diff, write. Returns the summary; prints nothing.
 */
export async function backfillThreads(
  options: BackfillOptions = {},
): Promise<BackfillSummary> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const days = options.days ?? DEFAULT_BACKFILL_DAYS;
  const dryRun = options.dryRun === true;
  const windowStart = new Date(now.getTime() - days * 86_400_000);

  const discovery = discoverSessionFiles({env, windowStart});
  const scan = scanSessions(discovery.files, windowStart);
  // THE LOGS FIRST (K10 e), independent of bd — see syncSessionLogs.
  const logs = syncSessionLogs(scan.sessions, {dryRun, env});
  const summary: BackfillSummary = {
    created: 0,
    days,
    dryRun,
    failures: [...discovery.failures, ...scan.failures, ...logs.failures],
    messageLogs: logs.counts,
    refreshed: 0,
    refreshedBackfill: 0,
    refreshedMessages: 0,
    scan: {
      filesRead: discovery.files.length,
      skippedAgentFiles: discovery.skippedAgentFiles,
      skippedFixtureDirs: discovery.skippedFixtureDirs,
      skippedNoUserMessage: scan.skippedNoUserMessage,
      skippedNonSessionFiles: discovery.skippedNonSessionFiles,
      skippedOldMtime: discovery.skippedOldMtime,
      skippedOutOfWindow: scan.skippedOutOfWindow,
      skippedUndated: scan.skippedUndated,
      undatedFiles: scan.undatedFiles,
    },
    sessionsInWindow: scan.sessions.length,
    unchanged: 0,
  };

  const ctx: BdContext = bdContext(env);
  // ONE READ, every thread, CLOSED INCLUDED — see planBackfill.
  const threads = await listThreads(ctx, {includeClosed: true});
  if (!threads.ok) {
    summary.failures.push(
      `NOT RECORDED — could not list threads: ${describeBdFailure(threads.failure)}. NOTHING was scanned against bd and nothing was written.`,
    );
    return summary;
  }

  const plan = planBackfill(scan.sessions, threads.value);
  summary.failures.push(...plan.failures);

  for (const action of plan.actions) {
    if (action.kind === 'unchanged') {
      summary.unchanged += 1;
      continue;
    }
    if (dryRun) {
      if (action.kind === 'create') summary.created += 1;
      else if (action.kind === 'refreshBackfill') {
        summary.refreshed += 1;
        summary.refreshedBackfill += 1;
      } else {
        summary.refreshed += 1;
        summary.refreshedMessages += 1;
      }
      continue;
    }

    if (action.kind === 'create') {
      const git = gitFactsForSession(action.session);
      const created = await createThread(ctx, {
        description: backfillDescription(action.session, git),
        metadata: backfillMetadata(action.session, git),
        notes: backfillNotes(action.session),
        title: backfillTitle(action.session),
      });
      // NO `-s in_progress` FOLLOW-UP. A backfilled session is not running; it
      // is a record of one that ended. `open` is the honest status and is what
      // K5 asks for.
      if (!created.ok) {
        summary.failures.push(
          `NOT RECORDED — session ${action.session.sessionId}: ${describeBdFailure(created.failure)}`,
        );
        continue;
      }
      summary.created += 1;
      continue;
    }

    if (action.kind === 'refreshBackfill') {
      const git = gitFactsForSession(action.session);
      const updated = await updateThreadBody(ctx, action.threadId, {
        description: backfillDescription(action.session, git),
        metadata: backfillMetadata(action.session, git),
        notes: backfillNotes(action.session),
        title: backfillTitle(action.session),
      });
      if (!updated.ok) {
        summary.failures.push(
          `NOT REFRESHED — ${action.threadId} (session ${action.session.sessionId}): ${describeBdFailure(updated.failure)}`,
        );
        continue;
      }
      summary.refreshed += 1;
      summary.refreshedBackfill += 1;
      continue;
    }

    // refreshMessages: the message fields and nothing else (K5).
    const merged = await mergeMetadata(ctx, action.threadId, action.patch);
    if (!merged.ok) {
      summary.failures.push(
        `NOT REFRESHED — ${action.threadId} (session ${action.session.sessionId}): ${describeBdFailure(merged.failure)}`,
      );
      continue;
    }
    summary.refreshed += 1;
    summary.refreshedMessages += 1;
  }

  return summary;
}

/**
 * `justin-sdk thread backfill`. Prints the summary line, the undated `note:`,
 * then every failure.
 *
 * EXIT 1 WHEN ANYTHING FAILED, even if beads were still written: a run that
 * could not read 40 transcripts and says so in a line nobody reads, while
 * exiting 0, is the silence this whole epic exists to remove. An undated
 * transcript is NOT one of those (F1) — see `scanSessions`.
 */
export async function runThreadBackfill(
  options: BackfillOptions = {},
): Promise<number> {
  const summary = await backfillThreads(options);

  if (options.json === true) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    const style = outputStyle();
    console.log('');
    console.log(describeBackfill(summary, style));
    // The note and the failures both go to STDERR so stdout stays the summary
    // alone; --json carries the same facts in `scan.undatedFiles`. A blank line
    // before each block (K11 rule 1).
    // The note goes to STDERR, so its width is measured there.
    const note = describeUndated(summary, outputStyle(process.stderr));
    if (note != null) {
      console.error('');
      console.error(note);
    }
    if (summary.failures.length > 0) console.error('');
    for (const line of summary.failures) console.error(`  ⚠️ ${line}`);
  }

  // ONE COMMIT PER RUN (D13), and only when something was actually written.
  //
  // `--json` IS NOT EXEMPT. It was, briefly, out of a worry that the commit
  // line would corrupt the JSON document — measured 2026-09-19 on the real
  // threads repo: it does not, because `describeCommit`'s line goes to STDERR
  // on every path. What the exemption actually did was leave beads written and
  // uncommitted, which is the one failure mode D13 exists to remove.
  if (options.dryRun !== true && summary.created + summary.refreshed > 0) {
    const env = options.env ?? process.env;
    const ctx = bdContext(env);
    const commitLine = describeCommit(
      commitThreadsRepo(
        `thread backfill: ${summary.created} created, ${summary.refreshed} refreshed`,
        {
          autoCommit: options.autoCommit,
          dir: ctx.repoDir,
          env,
          exportUnstaged: ctx.exportUnstaged,
        },
      ),
      'the threads repo',
    );
    if (commitLine != null) console.error(commitLine);
  }

  return summary.failures.length > 0 ? 1 : 0;
}
