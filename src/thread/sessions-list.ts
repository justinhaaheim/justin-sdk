/**
 * `thread sessions <project>` (alias `thread latest`): one project's latest
 * sessions, newest first (home-base-c82t4.1; the decisions are home-base-c82t4
 * D1 and D2).
 *
 * Justin, 2026-11-13: "This is going to be a common use case for me: "what are
 * my latest sessions in the X project?"" He asks it at the Mac and, through the
 * mayor, from his phone, so the output is short by default and reads the same
 * piped as on a terminal.
 *
 * BUILT ON THE INBOX (D1). `readInbox` gives the inbox's own title, status and
 * order, so the two cannot disagree. The project is resolved first (D2,
 * projects.ts), and its folder name is the inbox's repo filter. There is no
 * age window unless `--since` is given, Done and Archived sessions are listed,
 * and no pane lookup runs: the listing needs no pane, and the lookup costs 0.5
 * to 1.9 s.
 *
 * INCOMPLETE READS (D1, critical rule 7). A corrupt sessions-index line, a
 * session that could not be loaded, or an untracked-scan failure that means a
 * transcript or directory could not be READ makes the listing incomplete: one
 * warning line and exit 2. An untracked-scan entry that is only an anomaly in a
 * file that WAS read is not a read failure (`classifyUntrackedFailure`).
 */

import type {OutputStyle, StyleEnv, StyleStream} from '../cli-style';
import type {EnvLike} from './paths';
import type {KnownProject, KnownProjects} from './projects';
import type {InboxRead, InboxRow} from './session-inbox';
import type {SessionModel} from './session-model';
import type {SessionMarks} from './session-name';
import type {UntrackedSession, UntrackedVerdict} from './session-untracked';

import {
  BODY_COLUMN,
  displayWidth,
  fieldLabelWidth,
  fieldLines,
  HEADER_COLUMN,
  outputStyle,
  pad,
  paint,
  PLAIN_STYLE,
  sectionHeader,
  spacedList,
  stepColumn,
  wrapHanging,
} from '../cli-style';
import {formatLocalDate, formatLocalTime} from '../date';
import {sdkRun} from '../sdk-invocation';
import {writeStdout} from '../write-stdout';
import {parseInstant} from './answer-store';
import {parseSince} from './open-filters';
import {ageWords, tildeText} from './part-one';
import {knownProjects, resolutionErrorText, resolveProjects} from './projects';
import {byNewest, readInbox, rowCheckout, sessionsIn} from './session-inbox';
import {logLines} from './session-model';
import {sessionNameParts} from './session-name';
import {defaultDevRoot, NO_REQUEST_RECORDED} from './session-untracked';
import {buildResumeCommand} from './transcript-messages';

/** D1: five rows unless `--limit` says otherwise. */
export const SESSIONS_DEFAULT_LIMIT = 5;

/**
 * D1: no age window. The inbox needs a number of days, and its window becomes
 * a Date, so "all time" is a hundred years rather than Infinity (which would
 * make an Invalid Date).
 */
export const SESSIONS_ALL_TIME_DAYS = 36_500;

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

// ---------------------------------------------------------------------------
// Incomplete reads (D1, rule 7)
// ---------------------------------------------------------------------------

/** What the untracked scan's failure strings mean for this listing. */
export type UntrackedFailureKind = 'anomaly' | 'read';

/**
 * An entry of the untracked scan's `failures` (discoverSessionFiles and
 * scanSessions in backfill.ts). Two shapes are notes about a file that WAS
 * read, so its session is listed:
 *   - "<path>: the records say sessionId X but the filename says Y; keyed on
 *     the records' id" (scanSessions);
 *   - "stat <path>: <error> — read anyway rather than assumed old"
 *     (discoverSessionFiles; when the read that follows fails, it adds its own
 *     "read <path>: …" entry, which is a read failure).
 * Everything else is a read failure: "readdir <root>: … the scan saw NOTHING",
 * "readdir <project dir>: … its sessions were NOT scanned", "read <path>: …",
 * and any shape not listed here (an unknown note is never taken as harmless).
 */
export function classifyUntrackedFailure(text: string): UntrackedFailureKind {
  if (
    / the records say sessionId \S+ but the filename says \S+; keyed on the records' id$/u.test(
      text,
    )
  ) {
    return 'anomaly';
  }
  if (
    text.startsWith('stat ') &&
    text.endsWith(' — read anyway rather than assumed old')
  ) {
    return 'anomaly';
  }
  return 'read';
}

/**
 * F1 (home-base-c82t4.4): one string per untracked session the scan could not
 * place in any repo, because no record of its transcript names a working
 * directory. The scan counts them and keeps no id, so they are numbered.
 */
export function unplacedFailures(unplaced: number): string[] {
  return Array.from(
    {length: unplaced},
    (_, index) =>
      `untracked session ${index + 1} of ${unplaced} could not be placed in a project: no record of its transcript names a working directory`,
  );
}

/**
 * Everything that makes the listing incomplete, one string each: corrupt
 * index lines, tracked sessions that could not load, the untracked scan's
 * read failures, and the untracked sessions it could not place (F1). All four
 * are machine-wide, not per project: a line or a transcript that could not be
 * read, or a session with no working directory, cannot be placed in a
 * project, so it may be this one's.
 */
export function readFailures(read: InboxRead): string[] {
  return [
    ...read.corrupt.map(
      (line) =>
        `${read.indexPath} line ${line.lineNumber} could not be read: ${line.reason}`,
    ),
    ...read.rows
      .filter((row) => row.tracked && row.loaded == null)
      .map(
        (row) =>
          `session ${row.sessionId} could not be loaded: ${row.unreadable ?? 'no reason recorded'}`,
      ),
    ...read.untracked.failures.filter(
      (failure) => classifyUntrackedFailure(failure) === 'read',
    ),
    ...unplacedFailures(read.untracked.unplaced),
  ];
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** One session (or one folded run of sessions) as the listing shows it. */
export interface SessionListRow {
  checkout: string | null;
  /** The card's status emoji, which leads the title line. */
  emoji: string;
  lastActivityAt: string | null;
  marks: SessionMarks;
  repo: string | null;
  repoTag: string | null;
  resume: string;
  /** False when no directory is known: `resume` is then the bare command. */
  resumeHasDirectory: boolean;
  /**
   * F2 (home-base-c82t4.4): true when a loaded row's directory could not be
   * confirmed as the folder its transcript is filed under, so `resume` falls
   * back to its checkout and the renderer says so. False when it was confirmed,
   * and for a row that was not checked (an untracked session's own command, a
   * bare command).
   */
  resumeUnconfirmed: boolean;
  /** How many sessions the row stands for (a folded row, F6, is several). */
  runs: number;
  /** The oldest run's last activity, for a folded row; null otherwise. */
  runsOldestAt: string | null;
  sessionId: string;
  /** The v4 status kind, `notTracked` with no session bead, `unloaded` when it could not load. */
  statusKind: string;
  /** The status in words, without the emoji the title line already shows. */
  statusText: string;
  title: string;
  tracked: boolean;
}

/** POSIX single-quoting, as transcript-messages.ts quotes a resume directory. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** "land it: …" from "Land it: …": a finding inside a sentence. */
function lowerFirst(text: string): string {
  return text.length === 0 ? text : `${text[0]?.toLowerCase()}${text.slice(1)}`;
}

/**
 * D1: an untracked row's short status. Never the card's "Not tracked: it has
 * no session bead, so this is read from git …" sentence: "Not tracked" and the
 * verdict's own finding. With nothing open found, that finding is the inbox's
 * one-liner wording, NO_REQUEST_RECORDED, and not "nothing open found", which
 * Justin read as "safe to close" (home-base-j8q3e.7 D4).
 */
export function untrackedStatusText(
  session: Pick<UntrackedSession, 'oldReport'>,
  verdict: Pick<UntrackedVerdict, 'action' | 'evidence' | 'unmeasured'>,
): string {
  const findings: string[] = [];
  if (verdict.unmeasured.length > 0) {
    findings.push('could not be read in full, so check it by hand');
  } else if (verdict.evidence.includes('working')) {
    findings.push('working now');
  } else if (verdict.action.rule === 6) {
    findings.push(lowerFirst(verdict.action.text));
  } else if (verdict.action.rule === 4) {
    findings.push('out of context');
  }
  const report = session.oldReport.ok ? session.oldReport.value : null;
  if (verdict.evidence.includes('blockingAsks') && report != null) {
    findings.push(
      `its old report has ${plural(report.blockingAsks, 'blocking question', 'blocking questions')}`,
    );
  }
  if (findings.length === 0) findings.push(NO_REQUEST_RECORDED);
  return `Not tracked; ${findings.join('; ')}`;
}

/** The card's status without its leading emoji (the title line has it). */
function withoutEmoji(status: string, emoji: string): string {
  return status.startsWith(emoji)
    ? status.slice(emoji.length).trimStart()
    : status;
}

/**
 * F2 (home-base-c82t4.4): a loaded session's resume command, by
 * buildResumeCommand's rule. `claude --resume` looks for the transcript under
 * the folder it is filed in (~/.claude/projects/<slug of the directory>), so
 * the command must cd to the directory whose slug names that folder. Of the
 * log's last cwd, the measured checkout and the log's first cwd, the first
 * that does is used: a session that cd'd into a worktree without its
 * transcript following resumes from where it started. Null when the
 * transcript's path is unknown or none of them matches.
 */
export function confirmedResume(
  model: Pick<SessionModel, 'git' | 'log' | 'transcript'>,
  sessionId: string,
): string | null {
  const transcriptPath = model.transcript.path;
  if (transcriptPath == null) return null;
  const cwds = (logLines(model.log) ?? [])
    .map((line) => line.cwd)
    .filter((cwd): cwd is string => cwd != null && cwd !== '');
  const candidates = [cwds.at(-1) ?? null, model.git.checkout, cwds[0] ?? null];
  for (const candidate of candidates) {
    if (candidate == null) continue;
    // One candidate at a time, so buildResumeCommand's own slug check and
    // quoting decide, and its fallback (a command it could not confirm) is
    // never taken: its `failure` says so.
    const built = buildResumeCommand({
      firstCwd: null,
      lastCwd: candidate,
      sessionId,
      transcriptPath,
    });
    if (built.failure == null && built.command != null) return built.command;
  }
  return null;
}

/**
 * D1: a resume command that works from any directory. An untracked session's
 * own command already cds to the directory its transcript is filed under
 * (buildResumeCommand, which also handles the session that later cd'd into a
 * worktree). A loaded session's directory follows the same rule (F2,
 * `confirmedResume`); when it cannot be confirmed, the row cds to its checkout
 * and the renderer says it is unconfirmed. With no directory known it is the
 * bare command, and the renderer says so.
 */
function resumeOf(row: InboxRow): {
  command: string;
  hasDirectory: boolean;
  unconfirmed: boolean;
} {
  const own = row.untracked?.session.resume ?? null;
  if (own?.startsWith('cd ') === true) {
    return {command: own, hasDirectory: true, unconfirmed: false};
  }
  const model = row.loaded?.model ?? null;
  const confirmed =
    model == null ? null : confirmedResume(model, row.sessionId);
  if (confirmed != null) {
    return {command: confirmed, hasDirectory: true, unconfirmed: false};
  }
  const bare = `claude --resume ${row.sessionId}`;
  const checkout = rowCheckout(row);
  return checkout == null
    ? {command: bare, hasDirectory: false, unconfirmed: false}
    : {
        command: `cd ${shellQuote(checkout)} && ${bare}`,
        hasDirectory: true,
        unconfirmed: model != null,
      };
}

export function listRow(row: InboxRow): SessionListRow {
  const {card} = row;
  const statusText =
    row.untracked != null
      ? untrackedStatusText(row.untracked.session, row.untracked.verdict)
      : withoutEmoji(card.status, card.emoji);
  const statusKind =
    row.loaded?.status.kind ??
    (row.untracked != null ? 'notTracked' : 'unloaded');
  const resume = resumeOf(row);
  return {
    checkout: rowCheckout(row),
    emoji: card.emoji,
    lastActivityAt: row.lastActivityAt,
    marks: card.marks,
    repo: row.repo,
    repoTag: card.repoTag,
    resume: resume.command,
    resumeHasDirectory: resume.hasDirectory,
    resumeUnconfirmed: resume.unconfirmed,
    runs: sessionsIn(row),
    runsOldestAt: row.repeats?.oldestAt ?? null,
    sessionId: row.sessionId,
    statusKind,
    statusText,
    title: card.title,
    tracked: row.tracked,
  };
}

// ---------------------------------------------------------------------------
// The listing
// ---------------------------------------------------------------------------

export interface SessionList {
  /** False when anything could not be read (`failures`): exit 2. */
  complete: boolean;
  failures: string[];
  project: KnownProject;
  /** Every row in view, newest first; `shown` of them are printed. */
  rows: SessionListRow[];
  /** Sessions the rows stand for, measured from the rows (D1). */
  sessions: number;
  shown: number;
  /** `--since` as given, or null for no window. */
  since: {text: string; words: string} | null;
  /** Rows `--since` left out (older than the window). */
  sinceLeftOut: number;
  /** Test sessions (the test-data marker) in view: counted, never listed. */
  testSessions: number;
  /**
   * F1: untracked sessions the scan could not place in any repo. Each is one
   * of `failures` too; this count lets the warning name them apart.
   */
  unplaced: number;
}

/** Whether a dated activity is inside the window; undated is never left out. */
function inWindow(at: string | null, sinceStartMs: number | null): boolean {
  if (sinceStartMs == null || at == null) return true;
  const ms = parseInstant(at);
  return ms == null || ms >= sinceStartMs;
}

export function buildSessionList(
  read: InboxRead,
  options: {
    limit: number;
    now: Date;
    project: KnownProject;
    since: {ms: number; text: string; words: string} | null;
  },
): SessionList {
  const sinceStartMs =
    options.since == null ? null : options.now.getTime() - options.since.ms;
  const sorted = [...read.rows].sort(byNewest);
  const inView = sorted.filter((row) =>
    inWindow(row.lastActivityAt, sinceStartMs),
  );
  const rows = inView.map(listRow);
  const failures = readFailures(read);
  return {
    complete: failures.length === 0,
    failures,
    project: options.project,
    rows,
    sessions: rows.reduce((sum, row) => sum + row.runs, 0),
    shown:
      options.limit === 0 ? rows.length : Math.min(options.limit, rows.length),
    since:
      options.since == null
        ? null
        : {text: options.since.text, words: options.since.words},
    sinceLeftOut: sorted.length - inView.length,
    testSessions: read.testSessions.filter((test) =>
      inWindow(test.lastActivityAt, sinceStartMs),
    ).length,
    unplaced: read.untracked.unplaced,
  };
}

/** 0 rows listed and complete, 1 none found, 2 incomplete (D1). */
export function sessionListExit(list: SessionList): 0 | 1 | 2 {
  if (!list.complete) return 2;
  return list.rows.length === 0 ? 1 : 0;
}

/** D1's JSON record: the shown rows, and the counts that say what is not shown. */
export function sessionListJson(list: SessionList) {
  return {
    complete: list.complete,
    failures: list.failures,
    project: {folder: list.project.folder, tag: list.project.tag},
    rows: list.rows.slice(0, list.shown).map((row) => ({
      checkout: row.checkout,
      emoji: row.emoji,
      lastActivityAt: row.lastActivityAt,
      marks: row.marks,
      repo: row.repo,
      repoTag: row.repoTag,
      resume: row.resume,
      runs: row.runs,
      sessionId: row.sessionId,
      statusKind: row.statusKind,
      statusText: row.statusText,
      title: row.title,
      tracked: row.tracked,
    })),
    sessions: list.sessions,
    shown: list.shown,
    since: list.since?.text ?? null,
    testSessions: list.testSessions,
    totalRows: list.rows.length,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** "3 days ago (2026-11-10 05:24)": the age and the local date and time. */
/** "2026-11-10 05:24", local time. */
function localStamp(date: Date): string {
  return `${formatLocalDate(date)} ${formatLocalTime(date).slice(0, 5)}`;
}

function activeValue(at: string | null, now: Date): string {
  const ms = at == null ? null : parseInstant(at);
  if (ms == null) return 'unknown (nothing dates its last activity)';
  const date = new Date(ms);
  return `${ageWords(date, now)} (${localStamp(date)})`;
}

/**
 * The title line's text after the emoji: the marks ([MAYOR], [#N]) from the
 * one builder session names use, minus the repo tag (the header names the
 * project), then the title.
 */
export function markedTitle(
  row: Pick<SessionListRow, 'marks' | 'title'>,
): string {
  const parts = sessionNameParts(null, tildeText(row.title), row.marks);
  return `${parts.before}${parts.after}`.trimStart();
}

const ROW_LABELS = ['Active', 'Status', 'Runs', 'Resume'].map((label) => ({
  label,
  value: '',
}));

function renderRow(row: SessionListRow, style: OutputStyle, now: Date): string {
  const {color, width} = style;
  const fields = [
    {label: 'Active', value: activeValue(row.lastActivityAt, now)},
    {label: 'Status', value: row.statusText},
  ];
  if (row.runs > 1) {
    const oldestMs =
      row.runsOldestAt == null ? null : parseInstant(row.runsOldestAt);
    const oldest =
      oldestMs == null ? '' : `, the oldest ${localStamp(new Date(oldestMs))}`;
    fields.push({
      label: 'Runs',
      value: `${row.runs} sessions with the same first message${oldest}; Resume opens the newest`,
    });
  }
  const indent = stepColumn(1);
  const labelWidth = fieldLabelWidth(ROW_LABELS);
  // D1: the Resume line is never wrapped, so it is built here, not by fieldLines.
  const resumeNote = !row.resumeHasDirectory
    ? "(checkout unknown: run it from the project's folder)"
    : row.resumeUnconfirmed
      ? '(could not confirm that this folder holds the transcript)'
      : null;
  const resume = `${pad(indent)}${paint('Resume:', ['bold'], color)}${pad(labelWidth - displayWidth('Resume:'))}${paint(row.resume, ['cyan'], color)}${
    resumeNote == null ? '' : `  ${paint(resumeNote, ['dim'], color)}`
  }`;
  return [
    wrapHanging(`${row.emoji} ${paint(markedTitle(row), ['bold'], color)}`, {
      hang: BODY_COLUMN + 3,
      indent: BODY_COLUMN,
      width,
    }),
    fieldLines(fields, {color, indent, labelWidth, width}),
    resume,
  ].join('\n');
}

function headerText(list: SessionList): string {
  const {folder, tag} = list.project;
  // The line under it says why there are none.
  if (list.rows.length === 0) return `${folder} [${tag}]`;
  const window =
    list.since == null ? '' : `, active in the last ${list.since.words}`;
  const folded = list.rows.length !== list.sessions;
  const count = folded
    ? `${plural(list.sessions, 'session', 'sessions')} in ${plural(list.rows.length, 'row', 'rows')}`
    : plural(list.sessions, 'session', 'sessions');
  const showing = folded
    ? plural(list.shown, 'row', 'rows')
    : String(list.shown);
  return `${folder} [${tag}]: ${count}${window}, newest first (showing ${showing})`;
}

/** The lines after the rows: what is not shown, and why the list may be short. */
function notes(list: SessionList): string[] {
  const out: string[] = [];
  const project = `${list.project.folder} [${list.project.tag}]`;
  if (list.rows.length === 0) {
    out.push(
      list.since == null
        ? `No sessions found for ${project}.`
        : `No session of ${project} was active in the last ${list.since.words}${list.sinceLeftOut > 0 ? `; ${plural(list.sinceLeftOut, 'older one is', 'older ones are')} left out, and dropping --since shows ${list.sinceLeftOut === 1 ? 'it' : 'them'}` : ''}.`,
    );
  }
  const hiddenRows = list.rows.slice(list.shown);
  if (hiddenRows.length > 0) {
    const hiddenSessions = hiddenRows.reduce((sum, row) => sum + row.runs, 0);
    const what =
      hiddenSessions === hiddenRows.length
        ? plural(hiddenRows.length, 'more session', 'more sessions')
        : `${plural(hiddenRows.length, 'more row', 'more rows')} (${plural(hiddenSessions, 'session', 'sessions')})`;
    out.push(
      `${what} not shown: --limit 0 shows every one, --limit N the newest N.`,
    );
  }
  if (list.testSessions > 0) {
    out.push(
      `${plural(list.testSessions, 'test session is', 'test sessions are')} left out: ${list.testSessions === 1 ? 'its' : 'their'} first message carries the [TEST_DATA_DELETABLE …] marker.`,
    );
  }
  if (!list.complete) {
    // F1: the sessions with no working directory are counted apart, because
    // they were read; the inbox's JSON counts them and cannot name them.
    const unreadable = list.failures.length - list.unplaced;
    const what = [
      ...(unreadable > 0
        ? [
            `${plural(unreadable, 'session or file', 'sessions or files')} could not be read`,
          ]
        : []),
      ...(list.unplaced > 0
        ? [
            `${plural(list.unplaced, 'untracked session has', 'untracked sessions have')} no recorded working directory`,
          ]
        : []),
    ].join(' and ');
    const inbox = sdkRun('thread inbox --json');
    const where =
      list.unplaced === 0
        ? `${inbox} names them.`
        : unreadable === 0
          ? `${inbox} counts them under untracked.unplaced.`
          : `${inbox} names the unreadable ones and counts the others under untracked.unplaced.`;
    out.push(
      `⚠️ This list may be incomplete: ${what}, and any of them may belong to ${list.project.folder}. ${where}`,
    );
  }
  return out;
}

export function renderSessionList(
  list: SessionList,
  style: OutputStyle,
  now: Date,
): string {
  const blocks = [
    sectionHeader(headerText(list), {color: style.color, emoji: '🗂️'}),
    ...list.rows.slice(0, list.shown).map((row) => renderRow(row, style, now)),
    ...notes(list).map((note) =>
      wrapHanging(note, {
        hang: HEADER_COLUMN,
        indent: HEADER_COLUMN,
        width: style.width,
      }),
    ),
  ];
  return spacedList(blocks);
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

/**
 * D1: piped output and NO_COLOR output are plain, with no ANSI codes and no
 * wrapping (the mayor relays it to a phone, which wraps for itself). A
 * terminal with colour gets both.
 */
export function sessionsStyle(
  stream: StyleStream = process.stdout,
  env: StyleEnv = process.env,
): OutputStyle {
  const style = outputStyle(stream, env);
  return style.color ? style : PLAIN_STYLE;
}

export interface ThreadSessionsOptions {
  cwd?: string;
  /** Default ~/Dev (`defaultDevRoot`). */
  devRoot?: string;
  env?: EnvLike;
  json: boolean;
  /** Injectable for tests; default `knownProjects` over the dev root and the sessions index. */
  known?: () => KnownProjects;
  /** Rows to print; 0 = all. */
  limit: number;
  now?: Date;
  project: string;
  /** Injectable for tests; default `readInbox`. */
  readInbox?: typeof readInbox;
  since: string | null;
  style?: OutputStyle;
}

/** `thread sessions <project>`: print the listing, return the exit code. */
export async function runThreadSessions(
  options: ThreadSessionsOptions,
): Promise<number> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const devRoot = options.devRoot ?? defaultDevRoot();
  if (!Number.isInteger(options.limit) || options.limit < 0) {
    console.error(
      `thread sessions: --limit takes a whole number, 0 for every session; not ${String(options.limit)}`,
    );
    return 2;
  }
  let since: {ms: number; text: string; words: string} | null = null;
  if (options.since != null) {
    const parsed = parseSince(options.since);
    if (parsed.kind === 'bad') {
      console.error(`thread sessions: ${parsed.reason}`);
      return 2;
    }
    since = parsed;
  }

  const known = options.known?.() ?? knownProjects({devRoot, env});
  const resolution = resolveProjects([options.project], known.projects);
  if (resolution.kind !== 'ok') {
    console.error(`thread sessions: ${resolutionErrorText(resolution, known)}`);
    return 2;
  }
  const [project] = resolution.projects;
  if (project == null) {
    console.error('thread sessions: no project was given');
    return 2;
  }

  const result = await (options.readInbox ?? readInbox)({
    cwd: options.cwd ?? process.cwd(),
    days: SESSIONS_ALL_TIME_DAYS,
    devRoot,
    env,
    now,
    repo: project.folder,
  });
  if (result.kind === 'failed') {
    console.error(`thread sessions: ${result.reason}`);
    return 2;
  }
  const list = buildSessionList(result.read, {
    limit: options.limit,
    now,
    project,
    since,
  });
  if (options.json) {
    await writeStdout(`${JSON.stringify(sessionListJson(list), null, 2)}\n`);
  } else {
    await writeStdout(
      `${renderSessionList(list, options.style ?? sessionsStyle(), now)}\n`,
    );
  }
  return sessionListExit(list);
}
