/**
 * SESSIONS WITHOUT A SESSION BEAD on the dashboard (epic home-base-j8q3e.1
 * design D6; built by home-base-j8q3e.1.2). Justin, 2026-10-15: "Sometimes I
 * don't remember the sessions I had going." `thread inbox` lists the sessions
 * the sessions index knows; this module finds every OTHER Claude Code session
 * under ~/Dev in the window — other repos, life, home-base before session
 * beads — and shows each from facts only.
 *
 * FOUND THE WAY `repo-status repos` FINDS THEM (D6: reuse its enumerator, never
 * a second one): `discoverSessionFiles` and `scanSessions` (thread backfill's,
 * which repo-status uses) read the transcripts, `resolveRepoRoot` places each
 * in its repo — a `.claude/worktrees/<name>` checkout belongs to its main
 * checkout — and `isUnderRoot` keeps the ones under ~/Dev. Subagent transcripts
 * are never sessions: discovery skips `agent-*.jsonl` and never recurses into
 * `<session>/subagents/`. A session in the sessions index is excluded by its id
 * BEFORE its transcript is read, so none appears twice.
 *
 * FACTS ONLY, NEVER A STATUS THAT CLAIMS DONE. Each session's checkout is
 * measured with the same git code as a tracked session's
 * (`measureCheckoutCached`, shared through the run's cache), its transcript with
 * the same readers (`measureTranscriptAt`: last activity with subagents, context
 * size through usage-check), and its old-style report in ~/Dev/threads, when it
 * has one, for its open questions.
 *
 * FULL CARD OR ONE LINE (D6). A full card when there is evidence of open work —
 * a branch not merged into the default branch, uncommitted files in its
 * checkout, working now, out of context, or an open blocking question in its
 * old report — else one line, "nothing open found": honest, because nothing
 * open was FOUND, not because the session is done.
 *
 * CRITICAL RULE 7. Anything the verdict needs that could not be measured — the
 * checkout, a git call, the last activity, the old reports — makes a FULL card
 * whose action is D3 rule 10, "Check it by hand: <why>", checked before any
 * other rule. Never the one-liner.
 */

import type {EnvLike} from './paths';
import type {
  CardAction,
  CardFact,
  CardGitInput,
  SessionCard,
} from './session-card';
import type {CheckoutGit, LoadCache, Measured} from './session-model';

import {existsSync, readFileSync} from 'fs';
import {homedir} from 'os';
import {basename, dirname, join} from 'path';

import {findProjectRoot} from '../health-notices';
import {
  isUnderRoot,
  type RepoResolution,
  resolveRepoRoot,
} from '../repo-status/sessions';
import {discoverSessionFiles, scanSessions} from './backfill';
import {resolveReportWrapUpAt} from './config';
import {readMessageLog} from './message-log';
import {readAskPriority} from './metadata';
import {ageWords, FIRST_MESSAGE_CUT, firstLineOf, tildeText} from './part-one';
import {threadsRepoDir} from './paths';
import {ASK_PRIORITY_BLOCKING} from './schema';
import {gitFacts, landItText, sectionInfo} from './session-card';
import {
  firstUserLine,
  lastAssistantLine,
  measureCheckoutCached,
  measured,
  measureTranscriptAt,
  unmeasured,
  userLines,
} from './session-model';
import {WORKING_WINDOW_MS} from './session-status';

/** D6: "every Claude Code session ... under ~/Dev". */
export function defaultDevRoot(): string {
  return join(homedir(), 'Dev');
}

/** How much of his first message a one-line entry shows. */
export const LINE_MESSAGE_CUT = 80;

// ---------------------------------------------------------------------------
// Old-style reports (~/Dev/threads)
// ---------------------------------------------------------------------------

/** A session's old-style report: its thread bead and its open questions. */
export interface OldReport {
  /** Open questions whose priority is P0 (an old `blocking: true` ask counts). */
  blockingAsks: number;
  openAsks: number;
  threadId: string;
  title: string | null;
}

export type OldReports =
  | {
      bySession: Map<string, OldReport>;
      corrupt: number[];
      kind: 'read';
      path: string;
    }
  /** No threads repo on this machine: measured, there are no old reports. */
  | {kind: 'missing'; path: string}
  | {kind: 'failed'; path: string; reason: string};

interface ExportRow {
  dependencies?: {depends_on_id?: unknown; type?: unknown}[];
  id?: unknown;
  issue_type?: unknown;
  metadata?: unknown;
  status?: unknown;
  title?: unknown;
}

function metaString(metadata: unknown, key: string): string | null {
  if (metadata == null || typeof metadata !== 'object') return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Every old-style report, keyed by session id, READ ONLY. It reads the threads
 * repo's beads export (`.beads/issues.jsonl`, which bd writes within a second
 * of every write: `export.auto`, interval 1s) rather than running `bd list`
 * twice — measured 2026-10-15: 10 ms against 986 ms, and the dashboard's
 * whole budget is 3 s. Questions are paired with their thread the way
 * `thread board` pairs them: the parent, else `metadata.threadId`; open means
 * not closed; blocking is P0 by `readAskPriority`, the board's rule.
 */
export function readOldReports(env: EnvLike): OldReports {
  const repoDir = threadsRepoDir(env);
  const path = join(repoDir, '.beads', 'issues.jsonl');
  if (!existsSync(repoDir)) return {kind: 'missing', path};
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return {
      kind: 'failed',
      path,
      reason: `could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const corrupt: number[] = [];
  const threads: ExportRow[] = [];
  const asks: ExportRow[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (line.trim() === '') continue;
    let row: ExportRow;
    try {
      row = JSON.parse(line) as ExportRow;
    } catch {
      corrupt.push(index + 1);
      continue;
    }
    if (row.issue_type === 'thread') threads.push(row);
    else if (row.issue_type === 'ask' && row.status !== 'closed')
      asks.push(row);
  }
  const asksByThread = new Map<string, {blocking: number; open: number}>();
  for (const ask of asks) {
    const parent =
      ask.dependencies?.find((dep) => dep.type === 'parent-child')
        ?.depends_on_id ?? metaString(ask.metadata, 'threadId');
    if (typeof parent !== 'string') continue;
    const counts = asksByThread.get(parent) ?? {blocking: 0, open: 0};
    counts.open += 1;
    if (readAskPriority(ask.metadata) === ASK_PRIORITY_BLOCKING) {
      counts.blocking += 1;
    }
    asksByThread.set(parent, counts);
  }
  const bySession = new Map<string, OldReport>();
  for (const thread of threads) {
    const sessionId = metaString(thread.metadata, 'sessionId');
    if (sessionId == null || typeof thread.id !== 'string') continue;
    const counts = asksByThread.get(thread.id) ?? {blocking: 0, open: 0};
    bySession.set(sessionId, {
      blockingAsks: counts.blocking,
      openAsks: counts.open,
      threadId: thread.id,
      title: typeof thread.title === 'string' ? thread.title : null,
    });
  }
  return {bySession, corrupt, kind: 'read', path};
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/** Everything the dashboard knows about one session with no session bead. */
export interface UntrackedSession {
  /** The directory the session ended in (the transcript's last cwd). */
  checkout: string;
  /** Context tokens at the last record (usage-check's reader). */
  contextTokens: Measured<number>;
  /** His first message, one line; null = none captured. */
  firstMessage: string | null;
  /** When he sent it; null = not known. */
  firstMessageAt: string | null;
  git: CardGitInput;
  /** The newest record of the transcript and its subagents. */
  lastActivityAt: Measured<string>;
  /** His last message, one line; null = none captured. */
  lastMessage: string | null;
  /** Claude's last reply, first line; null = none captured. */
  lastReply: string | null;
  /** Where the three messages were read from (D6: the log, else the transcript). */
  messagesFrom: 'messageLog' | 'transcript';
  /** Its old-style report (null = it has none), or why that is unknown. */
  oldReport: Measured<OldReport | null>;
  /** The repo's name (its main checkout's directory name). */
  repo: string;
  repoResolvedBy: 'git' | 'path';
  repoRoot: string;
  resume: string;
  /** The main transcript's last record, from the scan: the order's fallback. */
  scannedLastAt: string;
  sessionId: string;
  /**
   * His WHOLE first message carries the test-data marker (F5,
   * home-base-j8q3e.1.10): the session is a test, listed only in a count.
   */
  testDataMarker: boolean;
  transcriptPath: string;
  /** usage-check's wrap-up threshold in its checkout; null = none configured. */
  wrapUpAt: number | null;
}

/**
 * The test-data marker of the prompts rule test-data-marker.md,
 * `[TEST_DATA_DELETABLE <uuid> ]` (F5, home-base-j8q3e.1.10). A real UUID is
 * required, so a message that only NAMES the marker (`<uuid>`) is not a test.
 */
const TEST_DATA_MARKER =
  /\[TEST_DATA_DELETABLE [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12} ?\]/i;

/** True when `text` (a whole first message) carries the test-data marker. */
export function carriesTestDataMarker(text: string | null): boolean {
  return text != null && TEST_DATA_MARKER.test(text);
}

/** D6's evidence of open work. */
export type OpenWorkEvidence =
  | 'blockingAsks'
  | 'outOfContext'
  | 'uncommitted'
  | 'unmerged'
  | 'working';

export interface UntrackedVerdict {
  action: CardAction;
  /** D6: a full card when anything is open or could not be read, else one line. */
  display: 'card' | 'line';
  evidence: OpenWorkEvidence[];
  /** What the verdict needed and could not measure; any makes rule 10. */
  unmeasured: string[];
}

/**
 * D6's verdict, pure: the evidence of open work, what could not be measured,
 * the display, and the "You need to" line. Rule 10 first (critical rule 7: an
 * unread fact never ends in "nothing open found"), then D3 rules 2, 4 and 6,
 * then D6's "Read Claude's last reply".
 */
export function untrackedVerdict(
  session: UntrackedSession,
  now: Date,
): UntrackedVerdict {
  const evidence: OpenWorkEvidence[] = [];
  const missing: string[] = [];
  const {git} = session;

  let working = false;
  if (session.lastActivityAt.ok) {
    const at = Date.parse(session.lastActivityAt.value);
    if (Number.isNaN(at)) {
      missing.push(
        `the last activity ${JSON.stringify(session.lastActivityAt.value)} is not a time`,
      );
    } else {
      const age = now.getTime() - at;
      working = age >= 0 && age < WORKING_WINDOW_MS;
    }
  } else {
    missing.push(session.lastActivityAt.reason);
  }
  if (working) evidence.push('working');

  // v4 D2's rule: out of context only when both numbers are known (an
  // unmeasured context size is not evidence either way, as for tracked cards).
  const outOfContext =
    session.contextTokens.ok &&
    session.wrapUpAt != null &&
    session.contextTokens.value >= session.wrapUpAt;
  if (outOfContext) evidence.push('outOfContext');

  let notMerged = false;
  if (!git.merged.ok) missing.push(git.merged.reason);
  else if (git.merged.value === 'notMerged') {
    notMerged = true;
    evidence.push('unmerged');
  }
  let uncommitted = 0;
  if (!git.uncommitted.ok) missing.push(git.uncommitted.reason);
  else if (git.uncommitted.value.length > 0) {
    uncommitted = git.uncommitted.value.length;
    evidence.push('uncommitted');
  }
  if (!session.oldReport.ok) missing.push(session.oldReport.reason);
  else if ((session.oldReport.value?.blockingAsks ?? 0) > 0) {
    evidence.push('blockingAsks');
  }

  const unique = [...new Set(missing)];
  const display = evidence.length > 0 || unique.length > 0 ? 'card' : 'line';
  let action: CardAction;
  if (unique.length > 0) {
    action = {
      command: session.resume,
      rule: 10,
      text: `Check it by hand: ${tildeText(unique.join('; '))}`,
    };
  } else if (working) {
    action = {command: null, rule: 2, text: 'Nothing yet. Claude is working.'};
  } else if (outOfContext) {
    action = {
      command: session.resume,
      rule: 4,
      text: 'Resume it and ask Claude for a handoff:',
    };
  } else if (notMerged || uncommitted > 0) {
    action = {
      command: null,
      rule: 6,
      text: landItText(git, {notMerged, uncommitted}),
    };
  } else {
    action = {
      command: session.resume,
      rule: null,
      text:
        session.lastReply == null
          ? "Resume it to see where it stopped (Claude's last reply was not captured):"
          : `Read Claude's last reply: "${session.lastReply}"`,
    };
  }
  return {action, display, evidence, unmeasured: unique};
}

/** The newest activity known: the measured one, else the scan's. */
export function untrackedActivityAt(session: UntrackedSession): string {
  return session.lastActivityAt.ok
    ? session.lastActivityAt.value
    : session.scannedLastAt;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The title `thread backfill` gives a thread it found with no report. */
const UNTITLED_PREFIX = '(untitled)';

/** A day: transcript writes closer than this to the last message are not named. */
const TOUCHED_AFTER_MS = 24 * 60 * 60_000;

/**
 * "3 days ago", from the last CONVERSATION record. The window is
 * repo-status's (the transcript's last record of any kind), and opening an
 * old session writes hook output and bookkeeping records into it without a
 * message (measured 2026-10-15: a session last spoken in on 2026-07-12 was
 * written to on 2026-10-05). So when the transcript was written to more than
 * a day after the last message, the age says both.
 */
function untrackedAge(session: UntrackedSession, now: Date): string | null {
  const at = Date.parse(untrackedActivityAt(session));
  if (Number.isNaN(at)) return null;
  const words = ageWords(new Date(at), now);
  const touched = Date.parse(session.scannedLastAt);
  if (Number.isNaN(touched) || touched - at < TOUCHED_AFTER_MS) return words;
  return `${words}; transcript touched ${ageWords(new Date(touched), now)}`;
}

/** D2's "Where it is" for a session with no session bead: never "done". */
function untrackedWhere(evidence: readonly OpenWorkEvidence[]): string {
  if (evidence.includes('working')) {
    return '🏃 Working (not tracked: it has no session bead)';
  }
  if (evidence.includes('outOfContext')) {
    return '🧯 Out of context (not tracked: it has no session bead)';
  }
  return '❔ Not tracked: it has no session bead, so this is read from git, its transcript and any old report';
}

/** D6's full card, as data (the inbox renders it like any other card). */
export function untrackedCard(
  session: UntrackedSession,
  verdict: UntrackedVerdict,
  now: Date,
): SessionCard {
  const facts: CardFact[] = gitFacts(session.git);
  const {oldReport} = session;
  if (!oldReport.ok) {
    facts.push({
      label: 'Old report',
      value: `unknown (${tildeText(oldReport.reason)})`,
    });
  } else if (oldReport.value != null && oldReport.value.openAsks > 0) {
    facts.push({
      label: 'Old report',
      value: `${plural(oldReport.value.openAsks, 'open question', 'open questions')}, ${oldReport.value.blockingAsks} blocking (thread ${oldReport.value.threadId})`,
    });
  }
  if (!session.lastActivityAt.ok) {
    facts.push({
      label: 'Last activity',
      value: `unknown (${tildeText(session.lastActivityAt.reason)})`,
    });
  }
  const where = untrackedWhere(verdict.evidence);
  const info = sectionInfo('notTracked');
  const oldTitle =
    session.oldReport.ok && session.oldReport.value?.title != null
      ? session.oldReport.value.title
      : null;
  return {
    action: verdict.action,
    age: untrackedAge(session, now),
    emoji: where.split(' ')[0] ?? '❔',
    facts,
    optional: null,
    pane: null,
    repo: session.repo,
    resume: session.resume,
    section: 'notTracked',
    sectionEmoji: info.emoji,
    sectionTitle: info.title,
    status: where,
    // The old report's title is Claude's summary of the session, unless
    // `thread backfill` made it up ("(untitled) <repo> session <id>").
    title:
      oldTitle != null && !oldTitle.startsWith(UNTITLED_PREFIX)
        ? oldTitle
        : (session.firstMessage ?? '(no message of yours was captured)'),
    youAsked: {firstMessage: session.firstMessage, kind: 'untracked'},
  };
}

/**
 * D6's one-line entry: "[REPO] his first message, cut (age) · nothing open
 * found". `repeats` > 1 is a folded line (F6, home-base-j8q3e.1.10): "(× 6,
 * newest 2 days ago)", the age being the newest session's.
 */
export function untrackedLine(
  card: SessionCard,
  firstMessage: string | null,
  repeats = 1,
): string {
  const message =
    firstMessage == null
      ? '(no message of yours was captured)'
      : firstLineOf(firstMessage, LINE_MESSAGE_CUT);
  const when =
    repeats > 1
      ? ` (× ${repeats}${card.age == null ? '' : `, newest ${card.age}`})`
      : card.age == null
        ? ''
        : ` (${card.age})`;
  return `❔ [${(card.repo ?? 'unknown repo').toUpperCase()}] ${tildeText(message)}${when} · nothing open found`;
}

/**
 * F6 (home-base-j8q3e.1.10): the key that folds one-liners — the repo and his
 * first message with every run of digits masked. Unattended scheduled runs
 * (life's `/daily-loop SCHEDULED RUN`) differ only in the date they name
 * (measured 2026-10-15: `preflight-2026-10-14.md`), so an exact match folded
 * none of them; a message that differs in any word is never folded.
 */
export function repeatKey(repo: string, firstMessage: string | null): string {
  return `${repo}\n${(firstMessage ?? '').replace(/\d+/g, '#')}`;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface UntrackedRead {
  devRoot: string;
  /** Transcripts or directories that could not be read: named, never dropped. */
  failures: string[];
  oldReports: OldReports | null;
  /** Sessions whose repo is outside the dev root (test probes in $TMPDIR). */
  outsideRoot: {directories: number; sessions: number};
  sessions: UntrackedSession[];
  /** Sessions no record of which names a working directory: no repo to place. */
  unplaced: number;
}

function checkoutGitInput(shared: CheckoutGit): CardGitInput {
  if (shared.kind === 'failed') {
    const reason = shared.reason;
    return {
      aheadOfDefault: unmeasured(reason),
      branch: unmeasured(reason),
      defaultBranch: unmeasured(reason),
      merged: unmeasured(reason),
      uncommitted: unmeasured(reason),
      unpushed: unmeasured(reason),
    };
  }
  return shared;
}

/** The main checkout git places `shared` in — `resolveRepoRoot`'s own rule. */
function rootOfCheckout(shared: CheckoutGit): string | null {
  if (shared.kind === 'failed' || shared.commonDir == null) return null;
  return shared.commonDir.endsWith('/.git')
    ? dirname(shared.commonDir)
    : shared.top;
}

/**
 * Every session in the window under `devRoot` that `exclude` (the sessions
 * index's ids) does not hold, newest first, each measured. `cache` is the
 * inbox run's, so a checkout a tracked session shares is measured once.
 */
export async function readUntracked(input: {
  cache: LoadCache;
  days: number;
  devRoot: string;
  env: EnvLike;
  exclude: ReadonlySet<string>;
  now: Date;
  repo: string | null;
}): Promise<UntrackedRead> {
  const {cache, devRoot, env, exclude, now} = input;
  const windowStart = new Date(now.getTime() - input.days * 86_400_000);
  const discovery = discoverSessionFiles({env, windowStart});
  const failures = [...discovery.failures];
  // Excluded BEFORE reading: a tracked session's transcript is never opened
  // here (by the filename's id; the records' id is checked again below).
  const files = discovery.files.filter(
    (file) => !exclude.has(file.fileSessionId),
  );
  const scan = scanSessions(files, windowStart);
  failures.push(...scan.failures);
  const scanned = scan.sessions.filter(
    (session) => !exclude.has(session.sessionId),
  );

  // Each checkout under the dev root is measured concurrently, once, and its
  // repo root seeds resolveRepoRoot's cache — so placing a session in its
  // repo runs no synchronous git of its own (453 ms for 29 checkouts,
  // measured 2026-10-15). A checkout outside the dev root is left to
  // resolveRepoRoot itself.
  const cwdOf = (session: (typeof scanned)[number]): string | null =>
    session.messages.cwd ?? session.messages.firstCwd;
  const nearby = [
    ...new Set(
      scanned
        .map(cwdOf)
        .filter(
          (cwd): cwd is string => cwd != null && isUnderRoot(cwd, devRoot),
        ),
    ),
  ];
  const measuredCheckouts = await Promise.all(
    nearby.map(
      async (cwd) => [cwd, await measureCheckoutCached(cwd, cache)] as const,
    ),
  );
  const repoCache = new Map<string, RepoResolution>();
  for (const [cwd, shared] of measuredCheckouts) {
    const root = rootOfCheckout(shared);
    if (root != null) repoCache.set(cwd, {by: 'git', root});
  }

  const wantRepo = input.repo?.trim().toLowerCase() ?? null;
  let unplaced = 0;
  let outsideSessions = 0;
  const outsideDirs = new Set<string>();
  const placed: {
    cwd: string;
    repo: {by: 'git' | 'path'; root: string};
    session: (typeof scanned)[number];
  }[] = [];
  for (const session of scanned) {
    const cwd = cwdOf(session);
    const repo = resolveRepoRoot(cwd, repoCache);
    if (cwd == null || repo.root == null || repo.by == null) {
      unplaced += 1;
      continue;
    }
    if (!isUnderRoot(repo.root, devRoot)) {
      outsideSessions += 1;
      outsideDirs.add(repo.root);
      continue;
    }
    if (
      wantRepo != null &&
      basename(repo.root).toLowerCase() !== wantRepo &&
      repo.root.toLowerCase() !== wantRepo &&
      cwd.toLowerCase() !== wantRepo
    ) {
      continue;
    }
    placed.push({cwd, repo: {by: repo.by, root: repo.root}, session});
  }

  const oldReports = placed.length > 0 ? readOldReports(env) : null;
  const wrapUpByRoot = new Map<string, number | null>();
  const sessions = await Promise.all(
    placed.map(async ({cwd, repo, session}): Promise<UntrackedSession> => {
      const shared = await measureCheckoutCached(cwd, cache);
      const configDir = shared.kind === 'measured' ? shared.top : cwd;
      const projectRoot = existsSync(configDir)
        ? findProjectRoot(configDir)
        : null;
      let wrapUpAt: number | null = null;
      if (projectRoot != null) {
        if (!wrapUpByRoot.has(projectRoot)) {
          wrapUpByRoot.set(projectRoot, resolveReportWrapUpAt(projectRoot));
        }
        wrapUpAt = wrapUpByRoot.get(projectRoot) ?? null;
      }
      const transcript = measureTranscriptAt(session.transcriptPath);
      const {messages} = session;

      // D6: the message log when it holds his messages, else the transcript.
      const log = readMessageLog(session.sessionId, env);
      const first = firstUserLine(log);
      const users = userLines(log);
      const reply = lastAssistantLine(log);
      const fromLog = first.ok && first.value != null;
      const oneLine = (text: string | null): string | null =>
        text == null ? null : firstLineOf(text, FIRST_MESSAGE_CUT);
      let oldReport: Measured<OldReport | null>;
      if (oldReports == null || oldReports.kind === 'missing') {
        oldReport = measured(null);
      } else if (oldReports.kind === 'failed') {
        oldReport = unmeasured(
          `its old report is unknown: ${oldReports.reason}`,
        );
      } else {
        oldReport = measured(
          oldReports.bySession.get(session.sessionId) ?? null,
        );
      }
      return {
        checkout: cwd,
        contextTokens: transcript.contextTokens,
        firstMessage: fromLog
          ? oneLine(first.value?.text ?? null)
          : oneLine(messages.firstUserMessage),
        firstMessageAt: fromLog
          ? (first.value?.at ?? null)
          : messages.firstUserMessageAt,
        git: checkoutGitInput(shared),
        lastActivityAt: transcript.lastRecordAt,
        lastMessage: fromLog
          ? oneLine(users.ok ? (users.value.at(-1)?.text ?? null) : null)
          : oneLine(messages.lastUserMessage),
        lastReply: fromLog
          ? oneLine(reply.ok ? (reply.value?.text ?? null) : null)
          : oneLine(messages.lastAssistantMessage),
        messagesFrom: fromLog ? 'messageLog' : 'transcript',
        oldReport,
        repo: basename(repo.root),
        repoResolvedBy: repo.by,
        repoRoot: repo.root,
        resume:
          messages.resumeCommand ?? `claude --resume ${session.sessionId}`,
        scannedLastAt: session.lastTimestamp,
        sessionId: session.sessionId,
        // F5: the WHOLE first message, not the one line the card shows.
        testDataMarker: carriesTestDataMarker(
          fromLog ? (first.value?.text ?? null) : messages.firstUserMessage,
        ),
        transcriptPath: session.transcriptPath,
        wrapUpAt,
      };
    }),
  );
  return {
    devRoot,
    failures,
    oldReports,
    outsideRoot: {directories: outsideDirs.size, sessions: outsideSessions},
    sessions,
    unplaced,
  };
}
