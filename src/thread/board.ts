/**
 * `justin-sdk thread board` — "here you go, Justin, here are the things you
 * were working on" (home-base-p1uj, the epic's WHY).
 *
 * This is the command the whole epic exists for. Resuming work used to mean
 * cycling through twelve to thirty cmux windows reading prose. This is that,
 * as a table: every live thread, grouped the way the question is actually asked
 * — by project, by recency, or by "what is waiting on me".
 *
 * IT MUST BE FAST, and the budget is a design constraint rather than an
 * aspiration: EXACTLY TWO bd calls, `list -t thread` and `list -t ask`, and the
 * threads are paired with their asks CLIENT-SIDE. A per-row `bd show` would
 * turn a 2-call render into 2+N, and a dashboard nobody waits for is a
 * dashboard nobody runs. Everything a row needs is already in the listing's
 * metadata — that is what metadata.ts is for.
 *
 * IT DRAINS THE SPOOL FIRST (D5). A report that bd refused earlier is applied
 * here, before anything is shown, so the board never renders a view it knows to
 * be out of date. Nothing is printed when the spool was empty.
 *
 * THE LAST LINES ARE AN EXCEPTION REPORT, NOT A REMINDER (p1uj.11 retiring D13,
 * then p1uj.20/D22). The tool now commits the threads repo itself after every
 * write AND pushes it, so a dirty `issues.jsonl` means a commit FAILED and a
 * branch ahead of origin means a push FAILED — each needs a human. Nothing is
 * printed when the repo is clean and pushed; an unmeasurable one says UNKNOWN
 * rather than 0, since "nothing to commit" and "nothing to push" are the
 * reassuring readings and the reassuring reading is the dangerous one.
 */

import type {EnvLike} from './paths';

import {spawnSync} from 'child_process';

import {
  BODY_COLUMN,
  DETAIL_COLUMN,
  displayWidth,
  HEADER_COLUMN,
  type OutputStyle,
  outputStyle,
  pad,
  padEndWidth,
  paint,
  PLAIN_STYLE,
  sectionHeader,
  spacedList,
  type StyleName,
  wrapHanging,
} from '../cli-style';
import {sdkRun} from '../sdk-invocation';
import {
  type BdContext,
  type BdIssue,
  describeBdFailure,
  listAsks,
  listThreads,
} from './bd';
import {bdContext} from './bd';
import {
  aheadOfOrigin,
  commitThreadsRepo,
  describeCommit,
  PUSH_REMOTE,
} from './commit';
import {drainSpool, renderDrain, type SpoolApplier} from './drain';
import {readAskPriority, readReportCount} from './metadata';
import {threadsRepoDir} from './paths';
import {priorityLabel} from './render';
import {priorityStyles} from './render-ansi';
import {ASK_PRIORITY_BLOCKING} from './schema';

const STOP_GLYPH: Record<string, string> = {
  blocked: '🛑',
  completed: '✅',
  error: '💥',
  needsYou: '🙋',
  other: '•',
  tokenLimit: '⚠️',
};

export interface BoardAsk {
  id: string;
  /** 0-4 (D15), via `readAskPriority` so a v1 ask bead still sorts. */
  priority: number;
  repo: string | null;
  reportedAt: string | null;
  threadId: string;
  threadTitle: string;
  title: string;
}

export interface BoardRow {
  age: string;
  /**
   * True when `thread backfill` made this row from a transcript rather than a
   * session reporting (K6). Hidden by default, tagged under `--all`.
   */
  backfilled: boolean;
  blockingAsks: number;
  branch: string | null;
  /**
   * The successor thread that took this arc over (D21), when there is one —
   * `metadata.continuedBy`, written by the session that continued it.
   */
  continuedBy: string | null;
  id: string;
  mergeState: string | null;
  openAsks: number;
  progress: number | null;
  repo: string | null;
  /** True when this thread has never reported: `thread start` made it and stopped. */
  reported: boolean;
  reportedAt: string | null;
  /** When the thread began — `threadStartedAt`, else the session's `startedAt`. */
  startedAt: string | null;
  stopDetail: string | null;
  stopKind: string | null;
  title: string;
  worktree: string | null;
}

/**
 * "2h", "3d", "just now" — and "age UNKNOWN" when there is no timestamp.
 *
 * Takes `now` rather than reading the clock so the fixture test is
 * deterministic; a board test that drifted with the wall clock would be
 * rewritten to assert nothing, which is how age formatting stops being tested.
 */
export function formatAge(reportedAt: string | null, now: Date): string {
  if (reportedAt == null || reportedAt === '') return 'age UNKNOWN';
  const then = Date.parse(reportedAt);
  if (Number.isNaN(then)) return 'age UNKNOWN';
  const seconds = Math.round((now.getTime() - then) / 1000);
  if (seconds < 0) return 'in the future';
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function metaString(meta: Record<string, unknown>, key: string): string | null {
  const value = meta[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Which thread does this ask belong to?
 *
 * `parent` first (measured 2026-09-12: `bd list -t ask --json` carries it),
 * `metadata.threadId` as the fallback. Both, because an ask created outside
 * `thread report` could have one and not the other, and an ask that matched
 * neither would be silently dropped from the counts — under-reporting what
 * waits for Justin, which is the direction that matters.
 */
export function threadIdOfAsk(ask: BdIssue): string | null {
  if (ask.parent != null && ask.parent !== '') return ask.parent;
  const meta = ask.metadata ?? {};
  return metaString(meta, 'threadId');
}

export interface BoardData {
  /** Backfilled threads left out of `rows` (K6). 0 means none were. */
  hiddenBackfilled: number;
  /** Continued threads left out of `rows` (D21). 0 means none were. */
  hiddenContinued: number;
  orphanAsks: BoardAsk[];
  rows: BoardRow[];
}

/** Pure: turn two bd listings into the board's rows. */
export function buildBoard(
  threads: readonly BdIssue[],
  asks: readonly BdIssue[],
  now: Date,
  options: {includeBackfilled?: boolean; includeContinued?: boolean} = {},
): BoardData {
  const byThread = new Map<string, BdIssue[]>();
  const orphanAsks: BoardAsk[] = [];
  const threadIds = new Set(threads.map((thread) => thread.id));

  for (const ask of asks) {
    const threadId = threadIdOfAsk(ask);
    if (threadId == null || !threadIds.has(threadId)) {
      // An ask whose thread is closed or missing. NOT dropped: it is still open
      // and still Justin's, and a board that hid it would be claiming there is
      // less waiting for him than there is.
      const meta = ask.metadata ?? {};
      orphanAsks.push({
        id: ask.id,
        priority: readAskPriority(meta),
        repo: null,
        reportedAt: metaString(meta, 'createdAt'),
        threadId: threadId ?? 'UNKNOWN',
        threadTitle: '(thread closed or missing)',
        title: ask.title ?? '',
      });
      continue;
    }
    const bucket = byThread.get(threadId);
    if (bucket == null) byThread.set(threadId, [ask]);
    else bucket.push(ask);
  }

  const allRows = threads.map((thread): BoardRow => {
    const meta = thread.metadata ?? {};
    const mine = byThread.get(thread.id) ?? [];
    const progress = meta.progressPercent;
    // A START-ONLY THREAD HAS AN AGE (p1uj.8, folded into p1uj.7 item A).
    // `thread start` writes `reportedAt: null` on purpose — nothing has been
    // reported — and the row read "age UNKNOWN ? --%", which says "I know
    // nothing about this" about a session whose start time is right there in
    // `threadStartedAt`. The stamp is chosen, never merged: `reportedAt` when
    // this thread HAS reported, the start stamp when it has not, and the row
    // says which it is showing rather than passing one off as the other.
    const reportedAt = metaString(meta, 'reportedAt');
    const startedAt =
      metaString(meta, 'threadStartedAt') ?? metaString(meta, 'startedAt');
    // `reportCount` is consulted as well as `reportedAt`, so a report whose
    // stamp is missing is still a REPORT with an unknown age — never demoted to
    // "no report yet", which would hide a real session's stop reason.
    const reported = reportedAt != null || readReportCount(meta) > 0;
    return {
      age: reported
        ? formatAge(reportedAt, now)
        : startedAt == null
          ? 'age UNKNOWN'
          : `started ${formatAge(startedAt, now)}`,
      backfilled: metaString(meta, 'source') === 'backfill',
      // P0 IS THE NEW BLOCKING (D15). The field keeps its name because the
      // row's meaning is unchanged — "how many of these stop Justin" — and
      // `readAskPriority` is what lets an ask bead written before this release,
      // which carries only `blocking`, still be counted.
      blockingAsks: mine.filter(
        (ask) => readAskPriority(ask.metadata) === ASK_PRIORITY_BLOCKING,
      ).length,
      branch: metaString(meta, 'branch'),
      continuedBy: metaString(meta, 'continuedBy'),
      id: thread.id,
      mergeState: metaString(meta, 'mergeState'),
      openAsks: mine.length,
      progress:
        typeof progress === 'number' && Number.isFinite(progress)
          ? progress
          : null,
      repo: metaString(meta, 'repo'),
      reported,
      reportedAt,
      startedAt,
      stopDetail: metaString(meta, 'stopReasonDetail'),
      stopKind: metaString(meta, 'stopReasonKind'),
      title: thread.title ?? '(no title)',
      worktree: metaString(meta, 'worktreePath'),
    };
  });

  // A CONTINUED THREAD IS FOLDED AWAY, NOT DROPPED (D21). Its arc lives on in
  // its successor, so leaving it on the board makes every handover look like two
  // live sessions — but it is hidden ONLY when nothing is still waiting on it.
  // A continued thread with open asks stays visible whatever the flag says: the
  // whole point of the board is what Justin still owes, and hiding an open ask
  // because the session that asked it ended would be the reassuring direction of
  // exactly the loss this epic exists to stop. The count line says how many were
  // folded, so "fewer rows" is never silent.
  // A BACKFILLED THREAD IS FOLDED AWAY THE SAME WAY (K6). `thread backfill`
  // makes a row for every session of the last 30 days, which is exactly what
  // search needs and exactly what a board does not: the board is what is still
  // live, and a few hundred rows for sessions that ended would bury the dozen
  // that have not. The same open-asks exemption applies, for the same reason —
  // though a backfilled bead has no ask children, so it is a guard, not a case.
  // A row that is both continued and backfilled counts as continued: it is
  // folded once, by the first rule that matches.
  let hiddenContinued = 0;
  let hiddenBackfilled = 0;
  const rows = allRows.filter((row) => {
    if (row.openAsks > 0) return true;
    if (options.includeContinued !== true && row.continuedBy != null) {
      hiddenContinued += 1;
      return false;
    }
    if (options.includeBackfilled !== true && row.backfilled) {
      hiddenBackfilled += 1;
      return false;
    }
    return true;
  });
  return {hiddenBackfilled, hiddenContinued, orphanAsks, rows};
}

/**
 * Newest activity first — a REPORT if there is one, otherwise when the thread
 * started (conductor, extending item A).
 *
 * Sorting on `reportedAt` alone sent every start-only thread to the bottom,
 * under threads last touched days ago: a session that started ten minutes ago
 * is the most recent thing on the board, and burying it is the same mistake as
 * printing its age as UNKNOWN. A thread with neither stamp sorts last, where an
 * empty string puts it, rather than being dropped.
 */
function activityAt(row: BoardRow): string {
  return row.reportedAt ?? row.startedAt ?? '';
}

function byReportedAtDesc(a: BoardRow, b: BoardRow): number {
  return activityAt(b).localeCompare(activityAt(a));
}

/**
 * The row's state column — what the session is doing, before its title — in
 * plain and painted form. The plain form is what the column is measured by.
 */
function rowState(row: BoardRow, color: boolean): string {
  // A BACKFILLED ROW SAYS SO (K6). It is only ever shown under `--all`, and
  // without the tag it is indistinguishable from a session that started and
  // then went quiet — two different facts about whether anything is running.
  // Dim: it is a record of a session that ended, not something live.
  if (row.backfilled) return paint('📼 backfill', ['dim'], color);
  // A thread that has not reported says so, instead of rendering three columns
  // of "I don't know" (`? --%`) for facts that do not exist yet.
  if (!row.reported) return '⏳ no report yet';
  const glyph = row.stopKind == null ? '?' : (STOP_GLYPH[row.stopKind] ?? '•');
  const progress =
    row.progress == null ? ' --%' : `${String(row.progress).padStart(3)}%`;
  // P0 asks are the one count on the board that means "you are blocking
  // something", so it is the one that is loud (K11 rule 4).
  const asks =
    row.openAsks === 0
      ? ''
      : row.blockingAsks > 0
        ? ` ${paint(`🛑 ${row.blockingAsks}/${row.openAsks} ask`, ['bold', 'red'], color)}`
        : ` ${row.openAsks} ask`;
  return `${glyph} ${progress}${asks}`;
}

/** The merge suffix after a title: yellow, because both are "look at this". */
function mergeSuffix(row: BoardRow, color: boolean): string {
  if (row.mergeState === 'unmerged') {
    return ` ${paint('UNMERGED', ['yellow'], color)}`;
  }
  if (row.mergeState === 'unknown') {
    return ` ${paint('merge UNKNOWN', ['yellow'], color)}`;
  }
  return '';
}

/**
 * The widths a view's rows line up to, so every title in the view starts at
 * the same column. Measured in DISPLAY columns, which is what `padEnd` got
 * wrong: it counts UTF-16 units, so `✅` and `⏳` (one unit, two columns) and a
 * `🛑 1/4 ask` wider than its fixed 8-unit field all pushed titles out of line.
 */
interface RowColumns {
  age: number;
  state: number;
}

function rowColumns(rows: readonly BoardRow[]): RowColumns {
  let age = 0;
  let state = 0;
  for (const row of rows) {
    age = Math.max(age, displayWidth(row.age));
    state = Math.max(state, displayWidth(rowState(row, false)));
  }
  return {age, state};
}

/** Two spaces between the age, the state and the title. */
const GUTTER = 2;

/**
 * One thread, man-page style (K11 rules 2–4): the headline at the body column —
 * age, state, title — with a long title hanging at the title column on a
 * terminal, then the id and branch on their own line at the detail column, dim.
 */
function renderRow(
  row: BoardRow,
  columns: RowColumns,
  style: OutputStyle,
): string {
  const {color, width} = style;
  const lead = `${padEndWidth(row.age, columns.age)}${pad(GUTTER)}${padEndWidth(rowState(row, color), columns.state)}${pad(GUTTER)}`;
  const headline = wrapHanging(
    `${lead}${row.title}${mergeSuffix(row, color)}`,
    {
      hang: BODY_COLUMN + columns.age + GUTTER + columns.state + GUTTER,
      indent: BODY_COLUMN,
      width,
    },
  );
  const where = `${row.id}${row.branch == null ? '' : ` · ${row.branch}`}`;
  return `${headline}\n${pad(DETAIL_COLUMN)}${paint(where, ['dim'], color)}`;
}

/** Every row of a view, one blank line apart (K11 rule 1). */
function renderRows(
  rows: readonly BoardRow[],
  columns: RowColumns,
  style: OutputStyle,
): string {
  return spacedList(rows.map((row) => renderRow(row, columns, style)));
}

const NO_OPEN_THREADS = `${pad(HEADER_COLUMN)}(no open threads — checked, and there are none)`;

/**
 * Default view: by repo, then by branch. A thread with no repo is its own group.
 *
 * Each repo is a section — `📦 <repo>` in bold accent at the header column,
 * its count dim beside it — and its rows sit under it at the body column, a
 * blank line between every row and between every group.
 */
export function renderByRepo(
  data: BoardData,
  groupLabel: string,
  style: OutputStyle = PLAIN_STYLE,
): string {
  const groups = new Map<string, BoardRow[]>();
  for (const row of data.rows) {
    // Never dropped: a thread whose repo could not be measured still happened.
    const key = row.repo ?? 'UNKNOWN repo';
    const bucket = groups.get(key);
    if (bucket == null) groups.set(key, [row]);
    else bucket.push(row);
  }
  const names = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  if (names.length === 0) return `\n${NO_OPEN_THREADS}`;
  // One set of columns for the whole board, so titles line up across groups.
  const columns = rowColumns(data.rows);
  const sections = names.map((name) => {
    const rows = (groups.get(name) ?? []).sort(byReportedAtDesc);
    const count = `(${rows.length} ${groupLabel}${rows.length === 1 ? '' : 's'})`;
    const header = `${sectionHeader(name, {color: style.color, emoji: '📦'})}  ${paint(count, ['dim'], style.color)}`;
    return spacedList([header, renderRows(rows, columns, style)]);
  });
  return `\n${spacedList(sections)}`;
}

export function renderRecent(
  data: BoardData,
  style: OutputStyle = PLAIN_STYLE,
): string {
  const rows = [...data.rows].sort(byReportedAtDesc);
  if (rows.length === 0) return `\n${NO_OPEN_THREADS}`;
  return `\n${renderRows(rows, rowColumns(rows), style)}`;
}

/** Every open ask across every thread: P0 first, then newest first. */
export function collectOpenAsks(
  threads: readonly BdIssue[],
  asks: readonly BdIssue[],
): BoardAsk[] {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const rows: BoardAsk[] = [];
  for (const ask of asks) {
    const meta = ask.metadata ?? {};
    const threadId = threadIdOfAsk(ask);
    const thread = threadId == null ? undefined : byId.get(threadId);
    const threadMeta = thread?.metadata ?? {};
    rows.push({
      id: ask.id,
      priority: readAskPriority(meta),
      repo: metaString(threadMeta, 'repo'),
      reportedAt: metaString(meta, 'createdAt'),
      threadId: threadId ?? 'UNKNOWN',
      threadTitle: thread?.title ?? '(thread closed or missing)',
      title: ask.title ?? '',
    });
  }
  return rows.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return (b.reportedAt ?? '').localeCompare(a.reportedAt ?? '');
  });
}

/**
 * `--open-asks`: every open ask, numbered at the body column with its priority
 * coloured the way the report colours it (K11 rule 4), its title and its thread
 * on their own lines at the detail column, and a blank line between asks.
 */
export function renderOpenAsks(
  asks: readonly BoardAsk[],
  style: OutputStyle = PLAIN_STYLE,
): string {
  const {color, width} = style;
  if (asks.length === 0) {
    return `\n${pad(HEADER_COLUMN)}(no open asks — checked, and there are none)`;
  }
  const blocks = asks.map((ask, index) => {
    const label =
      ask.priority === ASK_PRIORITY_BLOCKING
        ? '🛑 P0'
        : `   ${priorityLabel(ask.priority)}`;
    const head = `${pad(BODY_COLUMN)}${index + 1}. ${paint(label, priorityStyles(ask.priority), color)} · ${paint(ask.id, ['dim'], color)}`;
    const title = wrapHanging(ask.title, {
      hang: DETAIL_COLUMN,
      indent: DETAIL_COLUMN,
      width,
    });
    const thread = wrapHanging(
      paint(
        `${ask.repo ?? 'UNKNOWN repo'} · ${ask.threadTitle} (${ask.threadId})`,
        ['dim'],
        color,
      ),
      {hang: DETAIL_COLUMN, indent: DETAIL_COLUMN, width},
    );
    return [head, title, thread].join('\n');
  });
  const answer = `${pad(HEADER_COLUMN)}Answer them: ${paint(sdkRun('thread answer <threadId>'), ['cyan'], color)}`;
  return `\n${spacedList([...blocks, answer])}`;
}

/**
 * WHAT IS STILL UNCOMMITTED — which, since p1uj.11, means SOMETHING FAILED.
 *
 * This used to be D13's standing reminder: the tool did not commit the beads
 * JSONL, so the board nagged after every session. The tool now commits after
 * every write batch (`commit.ts`), so a dirty `issues.jsonl` is no longer the
 * normal state — it means a commit was refused (a denied `.git` under the
 * sandbox, an `index.lock`, `autoCommit` turned off). Hence `null` for the
 * clean case: the board says nothing when there is nothing wrong.
 *
 * UNKNOWN is still its own answer, and is still printed. "git could not be
 * read" is not "there is nothing uncommitted" (rule 6) — and here the
 * reassuring reading is the dangerous one, because it would hide exactly the
 * reports that never reached git.
 */
export function uncommittedLine(env: EnvLike, dir?: string): string | null {
  const repoDir = dir ?? threadsRepoDir(env);
  const result = spawnSync(
    'git',
    ['diff', '--numstat', 'HEAD', '--', '.beads/issues.jsonl'],
    {cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']},
  );
  if (result.error != null || result.status !== 0) {
    const stderrText = (result.stderr ?? '').trim();
    const detail = stderrText !== '' ? stderrText : String(result.error ?? '');
    return `📌 uncommitted beads in ${repoDir}: UNKNOWN — git could not be read (${detail.slice(0, 120)})`;
  }
  const line = (result.stdout ?? '').trim();
  if (line === '') return null;
  const [added, removed] = line.split('\n')[0]!.split('\t');
  return `📌 ${repoDir}/.beads/issues.jsonl has UNCOMMITTED changes (+${added ?? '?'}/-${removed ?? '?'} lines), so a commit this tool should have made did NOT happen. Commit it: cd ${repoDir} && git add .beads/issues.jsonl && git commit -m 'chore(beads): thread reports'`;
}

/**
 * WHAT IS COMMITTED BUT NOT PUSHED — the second half of the same exception
 * report (home-base-p1uj.20, D22).
 *
 * Since 2026-09-15 the tool pushes after every commit, so a branch that is
 * ahead of origin means a push did NOT happen: `autoPush` is off, the machine
 * was offline, auth failed, or origin moved and the push was refused. This is
 * the ONLY surface that says so after the fact — the warning at the time of the
 * failure scrolls away with the session that printed it.
 *
 * DELIBERATELY NOT GATED ON THE KNOB. With `autoPush` false the board still
 * reports the backlog, because "how much of this exists only on this laptop" is
 * a fact about the repo, not about a setting. What IS gated is having a remote:
 * with no origin there is nothing to be ahead OF, and the line would be a
 * standing complaint about a repo that is exactly as its owner wants it.
 *
 * UNKNOWN, never 0, when git cannot be read (rule 6) — a detached HEAD, an
 * `origin/<branch>` that has never existed, an unreadable repo. Silence here
 * means "measured, and there is nothing waiting".
 */
export function unpushedLine(env: EnvLike, dir?: string): string | null {
  const repoDir = dir ?? threadsRepoDir(env);
  // The SAME measurement the commit path pushes on (`aheadOfOrigin`), so the
  // warning at write time and the dashboard afterwards can never disagree about
  // one repo.
  const ahead = aheadOfOrigin(repoDir, env);
  switch (ahead.kind) {
    // No origin means there is nothing to be ahead OF, and a repo that is not a
    // git repo at all already got its UNKNOWN from `uncommittedLine` directly
    // above — a second one would be the same fact twice.
    case 'no-remote':
    case 'level':
      return null;
    case 'unknown':
      return `📤 unpushed commits in ${repoDir}: UNKNOWN — ${ahead.reason}`;
    case 'ahead':
      return `📤 ${repoDir} is ${ahead.count} commit${ahead.count === 1 ? '' : 's'} ahead of ${PUSH_REMOTE}/${ahead.branch}, so a push this tool should have made did NOT happen. Push it: cd ${repoDir} && git push`;
  }
}

export type BoardView = 'repo' | 'recent' | 'openAsks';

export interface BoardOptions {
  /** Injected by tests so the drain can be exercised without a bd database. */
  apply?: SpoolApplier;
  /** Overrides componentConfig.thread.autoCommit. Tests pin it. */
  autoCommit?: boolean;
  env?: EnvLike;
  /** `--all`: show backfilled threads too (K6). They are folded away by default. */
  includeBackfilled?: boolean;
  /** `--all`: show continued threads too (D21). They are folded away by default. */
  includeContinued?: boolean;
  json?: boolean;
  now?: Date;
  /** Colour and wrap width; from the stdout stream when absent. */
  style?: OutputStyle;
  view?: BoardView;
}

/** The line that keeps a folded-away thread from being a silent omission. */
export function continuedHiddenLine(hidden: number): string | null {
  if (hidden <= 0) return null;
  return `${hidden} continued thread${hidden === 1 ? '' : 's'} hidden (--all shows them)`;
}

/** The same, for the sessions `thread backfill` recorded (K6). */
export function backfilledHiddenLine(hidden: number): string | null {
  if (hidden <= 0) return null;
  return `${hidden} backfilled session${hidden === 1 ? '' : 's'} hidden (--all shows them)`;
}

export async function runThreadBoard(
  options: BoardOptions = {},
): Promise<number> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const view = options.view ?? 'repo';
  const ctx: BdContext = bdContext(env);

  // 1. The spool, before anything is shown (D5).
  const drained = await drainSpool({apply: options.apply, ctx, env});
  const drainLines = renderDrain(drained);
  // PRINTED IMMEDIATELY, before the listings that can fail. The drain has
  // already MOVED things — applied a report, or left one spooled — and if the
  // bd read below then fails, a drain summary held back until "success" is a
  // report that silently changed state and said nothing. Measured: with bd
  // unreachable this was exactly the case, and the "1 STILL SPOOLED" line never
  // reached the screen. JSON mode is the exception, where the same facts go out
  // as the `drain` key and a loose line would corrupt the document.
  if (options.json !== true) {
    for (const line of drainLines) console.log(line);
  }
  // A drained report is a write like any other, so it gets the same commit
  // (p1uj.11). One commit for the whole drain, not one per file: they land in
  // the same JSONL in the same second, and N commits would say N things
  // happened when one batch did.
  if (drained != null && drained.applied > 0) {
    const commitLine = describeCommit(
      commitThreadsRepo(
        `thread drain: applied ${drained.applied} spooled report${drained.applied === 1 ? '' : 's'}`,
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

  // 2. Exactly two bd calls. Everything below is client-side.
  const threads = await listThreads(ctx);
  if (!threads.ok) {
    console.error(
      `thread board: could not list threads — ${describeBdFailure(threads.failure)}`,
    );
    return 1;
  }
  const asks = await listAsks(ctx);
  if (!asks.ok) {
    console.error(
      `thread board: could not list asks — ${describeBdFailure(asks.failure)}`,
    );
    return 1;
  }

  const data = buildBoard(threads.value, asks.value, now, {
    includeBackfilled: options.includeBackfilled,
    includeContinued: options.includeContinued,
  });

  if (options.json === true) {
    console.log(
      JSON.stringify(
        {
          asks: collectOpenAsks(threads.value, asks.value),
          drain: drained,
          hiddenBackfilled: data.hiddenBackfilled,
          hiddenContinued: data.hiddenContinued,
          rows: data.rows,
          uncommitted: uncommittedLine(env),
          unpushed: unpushedLine(env),
          view,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  const style = options.style ?? outputStyle();
  if (view === 'openAsks') {
    console.log(
      renderOpenAsks(collectOpenAsks(threads.value, asks.value), style),
    );
  } else if (view === 'recent') {
    console.log(renderRecent(data, style));
  } else {
    console.log(renderByRepo(data, 'thread', style));
  }
  // Everything after the rows is a footnote: at the header column, a blank
  // line before each, wrapped with a hang so a long command stays readable.
  const footnote = (line: string, styles: StyleName[]): void => {
    console.log('');
    console.log(
      wrapHanging(paint(line, styles, style.color), {
        hang: BODY_COLUMN,
        indent: HEADER_COLUMN,
        width: style.width,
      }),
    );
  };
  if (view === 'repo' && data.orphanAsks.length > 0) {
    footnote(
      `⚠️ ${data.orphanAsks.length} open ask(s) whose thread is closed or missing: ${data.orphanAsks.map((ask) => ask.id).join(', ')}`,
      ['yellow'],
    );
  }

  // Printed for every view, `--open-asks` included: that view is built from the
  // full listing, so a hidden ROW never hides an ask — and the count is still
  // the honest answer to "is this everything?".
  const continuedLine = continuedHiddenLine(data.hiddenContinued);
  if (continuedLine != null) footnote(continuedLine, ['dim']);
  const backfilledLine = backfilledHiddenLine(data.hiddenBackfilled);
  if (backfilledLine != null) footnote(backfilledLine, ['dim']);

  // Yellow: each of these means a write this tool should have made did not
  // happen, and each carries the command that fixes it.
  const uncommitted = uncommittedLine(env);
  if (uncommitted != null) footnote(uncommitted, ['yellow']);
  // Both lines, not one or the other: a repo can be dirty AND behind on pushes,
  // and they are two different things to fix.
  const unpushed = unpushedLine(env);
  if (unpushed != null) footnote(unpushed, ['yellow']);
  return 0;
}
