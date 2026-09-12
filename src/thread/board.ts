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
 * THE LAST LINE IS THE D13 REMINDER: bd auto-exports `issues.jsonl` and git-adds
 * it, but committing stays manual, so every thread written today is one `git
 * commit` away from being real. The count is measured, and an unmeasurable one
 * says UNKNOWN rather than 0 — "nothing to commit" is the reassuring reading,
 * and the reassuring reading is the dangerous one.
 */

import {spawnSync} from 'child_process';

import {
  describeBdFailure,
  listAsks,
  listThreads,
  type BdContext,
  type BdIssue,
} from './bd';
import {bdContext} from './bd';
import {drainSpool, renderDrain, type SpoolApplier} from './drain';
import {lifeRepoDir} from './paths';
import {readReportCount} from './metadata';

import type {EnvLike} from './paths';

const STOP_GLYPH: Record<string, string> = {
  blocked: '🛑',
  completed: '✅',
  error: '💥',
  needsYou: '🙋',
  other: '•',
  tokenLimit: '⚠️',
};

export interface BoardAsk {
  blocking: boolean;
  id: string;
  repo: string | null;
  reportedAt: string | null;
  threadId: string;
  threadTitle: string;
  title: string;
}

export interface BoardRow {
  age: string;
  blockingAsks: number;
  branch: string | null;
  id: string;
  mergeState: string | null;
  openAsks: number;
  progress: number | null;
  repo: string | null;
  /** True when this thread has never reported: `thread start` made it and stopped. */
  reported: boolean;
  reportedAt: string | null;
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
  const meta = (ask.metadata ?? {}) as Record<string, unknown>;
  return metaString(meta, 'threadId');
}

export interface BoardData {
  orphanAsks: BoardAsk[];
  rows: BoardRow[];
}

/** Pure: turn two bd listings into the board's rows. */
export function buildBoard(
  threads: readonly BdIssue[],
  asks: readonly BdIssue[],
  now: Date,
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
      const meta = (ask.metadata ?? {}) as Record<string, unknown>;
      orphanAsks.push({
        blocking: meta.blocking === true,
        id: ask.id,
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

  const rows = threads.map((thread): BoardRow => {
    const meta = (thread.metadata ?? {}) as Record<string, unknown>;
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
      blockingAsks: mine.filter(
        (ask) =>
          ((ask.metadata ?? {}) as Record<string, unknown>).blocking === true,
      ).length,
      branch: metaString(meta, 'branch'),
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
      stopDetail: metaString(meta, 'stopReasonDetail'),
      stopKind: metaString(meta, 'stopReasonKind'),
      title: thread.title ?? '(no title)',
      worktree: metaString(meta, 'worktreePath'),
    };
  });

  return {orphanAsks, rows};
}

function byReportedAtDesc(a: BoardRow, b: BoardRow): number {
  return (b.reportedAt ?? '').localeCompare(a.reportedAt ?? '');
}

function renderRow(row: BoardRow): string {
  // A thread that has not reported says so, instead of rendering three columns
  // of "I don't know" (`? --%`) for facts that do not exist yet.
  if (!row.reported) {
    return `  ${row.age.padStart(9)} ⏳ no report yet   ${row.title}\n             ${row.id}${row.branch == null ? '' : ` · ${row.branch}`}`;
  }
  const glyph = row.stopKind == null ? '?' : (STOP_GLYPH[row.stopKind] ?? '•');
  const progress =
    row.progress == null ? ' --%' : `${String(row.progress).padStart(3)}%`;
  const asks =
    row.openAsks === 0
      ? '        '
      : row.blockingAsks > 0
        ? `🛑 ${row.blockingAsks}/${row.openAsks} ask`.padEnd(8)
        : `${row.openAsks} ask`.padEnd(8);
  const merge =
    row.mergeState === 'unmerged'
      ? ' UNMERGED'
      : row.mergeState === 'unknown'
        ? ' merge UNKNOWN'
        : '';
  return `  ${row.age.padStart(9)} ${glyph} ${progress} ${asks} ${row.title}${merge}\n             ${row.id}${row.branch == null ? '' : ` · ${row.branch}`}`;
}

/** Default view: by repo, then by branch. A thread with no repo is its own group. */
export function renderByRepo(data: BoardData, groupLabel: string): string {
  const lines: string[] = [];
  const groups = new Map<string, BoardRow[]>();
  for (const row of data.rows) {
    // Never dropped: a thread whose repo could not be measured still happened.
    const key = row.repo ?? 'UNKNOWN repo';
    const bucket = groups.get(key);
    if (bucket == null) groups.set(key, [row]);
    else bucket.push(row);
  }
  const names = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  if (names.length === 0) {
    lines.push('(no open threads — checked, and there are none)');
  }
  for (const name of names) {
    const rows = (groups.get(name) ?? []).sort(byReportedAtDesc);
    lines.push('');
    lines.push(
      `${name}  (${rows.length} ${groupLabel}${rows.length === 1 ? '' : 's'})`,
    );
    for (const row of rows) lines.push(renderRow(row));
  }
  return lines.join('\n');
}

export function renderRecent(data: BoardData): string {
  const rows = [...data.rows].sort(byReportedAtDesc);
  if (rows.length === 0) {
    return '(no open threads — checked, and there are none)';
  }
  return ['', ...rows.map(renderRow)].join('\n');
}

/** Every open ask across every thread: blocking first, then newest first. */
export function collectOpenAsks(
  threads: readonly BdIssue[],
  asks: readonly BdIssue[],
): BoardAsk[] {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const rows: BoardAsk[] = [];
  for (const ask of asks) {
    const meta = (ask.metadata ?? {}) as Record<string, unknown>;
    const threadId = threadIdOfAsk(ask);
    const thread = threadId == null ? undefined : byId.get(threadId);
    const threadMeta = (thread?.metadata ?? {}) as Record<string, unknown>;
    rows.push({
      blocking: meta.blocking === true,
      id: ask.id,
      repo: metaString(threadMeta, 'repo'),
      reportedAt: metaString(meta, 'createdAt'),
      threadId: threadId ?? 'UNKNOWN',
      threadTitle: thread?.title ?? '(thread closed or missing)',
      title: ask.title ?? '',
    });
  }
  return rows.sort((a, b) => {
    if (a.blocking !== b.blocking) return a.blocking ? -1 : 1;
    return (b.reportedAt ?? '').localeCompare(a.reportedAt ?? '');
  });
}

export function renderOpenAsks(asks: readonly BoardAsk[]): string {
  if (asks.length === 0) {
    return '(no open asks — checked, and there are none)';
  }
  const lines: string[] = [''];
  asks.forEach((ask, index) => {
    lines.push(
      `  ${index + 1}. ${ask.blocking ? '🛑 BLOCKING' : '  non-blocking'} · ${ask.id}`,
    );
    lines.push(`     ${ask.title}`);
    lines.push(
      `     ${ask.repo ?? 'UNKNOWN repo'} · ${ask.threadTitle} (${ask.threadId})`,
    );
  });
  lines.push('');
  lines.push('Answer them: justin-sdk thread answer <threadId>');
  return lines.join('\n');
}

/**
 * D13's reminder line. Measured, and UNKNOWN when it cannot be.
 *
 * The tool deliberately does not commit life's `issues.jsonl` (a cross-repo
 * commit from every session's wrap-up is an index.lock hazard), so this is the
 * only thing standing between a written thread and a committed one.
 */
export function uncommittedLine(env: EnvLike, dir?: string): string {
  const lifeDir = dir ?? lifeRepoDir(env);
  const result = spawnSync(
    'git',
    ['diff', '--numstat', 'HEAD', '--', '.beads/issues.jsonl'],
    {cwd: lifeDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']},
  );
  if (result.error != null || result.status !== 0) {
    const detail = (result.stderr ?? '').trim() || String(result.error ?? '');
    return `📌 uncommitted beads in ~/Dev/life: UNKNOWN — git could not be read (${detail.slice(0, 120)})`;
  }
  const line = (result.stdout ?? '').trim();
  if (line === '') {
    return '📌 ~/Dev/life/.beads/issues.jsonl: no uncommitted changes.';
  }
  const [added, removed] = line.split('\n')[0]!.split('\t');
  return `📌 ~/Dev/life/.beads/issues.jsonl has UNCOMMITTED changes (+${added ?? '?'}/-${removed ?? '?'} lines). Commit it so today's threads survive: cd ~/Dev/life && git add .beads/issues.jsonl && git commit -m 'chore(beads): thread reports'`;
}

export type BoardView = 'repo' | 'recent' | 'openAsks';

export interface BoardOptions {
  /** Injected by tests so the drain can be exercised without a bd database. */
  apply?: SpoolApplier;
  env?: EnvLike;
  json?: boolean;
  now?: Date;
  view?: BoardView;
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

  const data = buildBoard(threads.value, asks.value, now);

  if (options.json === true) {
    console.log(
      JSON.stringify(
        {
          asks: collectOpenAsks(threads.value, asks.value),
          drain: drained,
          rows: data.rows,
          uncommitted: uncommittedLine(env),
          view,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  if (view === 'openAsks') {
    console.log(renderOpenAsks(collectOpenAsks(threads.value, asks.value)));
  } else if (view === 'recent') {
    console.log(renderRecent(data));
  } else {
    console.log(renderByRepo(data, 'thread'));
    if (data.orphanAsks.length > 0) {
      console.log('');
      console.log(
        `⚠️ ${data.orphanAsks.length} open ask(s) whose thread is closed or missing: ${data.orphanAsks.map((ask) => ask.id).join(', ')}`,
      );
    }
  }

  console.log('');
  console.log(uncommittedLine(env));
  return 0;
}
