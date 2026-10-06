/**
 * TEXT RENDERING for `justin-sdk forensics` (home-base-lj3x9).
 *
 * Pure functions over the scans, styled through cli-style.ts so the output
 * follows the man-page rules every SDK command follows (K11): headers at
 * column 2, body at 6, detail at 9, a blank line between every item, colour
 * only on a TTY, wrapping only on a TTY.
 *
 * Messages are PREVIEWS here: whitespace collapsed to one line and cut at
 * `chars`. `--json` carries them verbatim and uncapped.
 */

import type {
  ForensicsSession,
  OutsideRoot,
  RepoSummary,
  ThreadIndex,
} from './sessions';
import type {RepoWorktrees, WorktreeFacts} from './worktrees';

import {homedir} from 'os';
import {relative} from 'path';

import {
  BODY_COLUMN,
  DETAIL_COLUMN,
  type OutputStyle,
  paint,
  sectionHeader,
  spacedList,
  wrapHanging,
} from '../cli-style';
import {formatLocalDate, formatLocalTime} from '../date';

const SEP = ' · ';

/** "3h ago" from an ISO timestamp; the timestamp itself when unparseable. */
export function ageFrom(iso: string, now: Date): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const minutes = Math.max(0, Math.round((now.getTime() - at) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Local `YYYY-MM-DD HH:MM`, or the input when unparseable. */
export function localStamp(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return `${formatLocalDate(at)} ${formatLocalTime(at).slice(0, 5)}`;
}

/** One line of `text`, cut at `chars` with a count of what was cut. */
export function preview(text: string, chars: number): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  if (chars <= 0 || flat.length <= chars) return flat;
  return `${flat.slice(0, chars).trimEnd()}… (+${flat.length - chars} chars)`;
}

function body(text: string, style: OutputStyle): string {
  return wrapHanging(text, {
    hang: DETAIL_COLUMN,
    indent: BODY_COLUMN,
    width: style.width,
  });
}

function detail(text: string, style: OutputStyle): string {
  return wrapHanging(text, {
    hang: DETAIL_COLUMN + 2,
    indent: DETAIL_COLUMN,
    width: style.width,
  });
}

function failuresSection(
  failures: readonly string[],
  style: OutputStyle,
): string {
  if (failures.length === 0) return '';
  return [
    sectionHeader('Could not check', {color: style.color, emoji: '⚠️'}),
    '',
    spacedList(
      failures.map((failure) =>
        body(paint(failure, ['yellow'], style.color), style),
      ),
    ),
  ].join('\n');
}

function threadsFailure(threads: ThreadIndex): string[] {
  return threads.ok
    ? []
    : [
        `threads: ${threads.error} — thread coverage below is UNKNOWN, not zero`,
      ];
}

// ---------------------------------------------------------------------------
// forensics repos
// ---------------------------------------------------------------------------

export interface ReposView {
  days: number;
  failures: string[];
  now: Date;
  /** Sessions whose repo is outside `root`, hidden and counted. */
  outsideRoot: OutsideRoot;
  /** Only repos under this directory are listed; `/` lists everything. */
  root: string;
  summaries: RepoSummary[];
  threads: ThreadIndex;
  unplaced: number;
}

/** `/Users/x/Dev` → `~/Dev`, for display only. */
export function tildePath(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`)
    ? `~${path.slice(home.length)}`
    : path;
}

function repoSummaryBlock(
  summary: RepoSummary,
  view: ReposView,
  style: OutputStyle,
): string {
  const parts = [
    `${summary.sessions} session${summary.sessions === 1 ? '' : 's'}`,
    `last active ${ageFrom(summary.lastActivity, view.now)}`,
  ];
  const {coverage} = summary;
  if (coverage == null) {
    parts.push('thread coverage unknown');
  } else {
    parts.push(`${coverage.reported} reported`);
    const never = coverage.backfilled + coverage.started;
    if (never > 0) {
      parts.push(paint(`${never} never reported`, ['yellow'], style.color));
    }
    if (coverage.none > 0) {
      parts.push(
        paint(`${coverage.none} with no thread`, ['yellow'], style.color),
      );
    }
  }
  const path =
    summary.repoResolvedBy === 'path'
      ? `${summary.repoRoot} ${paint('(from the path; directory gone or not a repo)', ['dim'], style.color)}`
      : summary.repoRoot;
  return [
    body(paint(path, ['bold'], style.color), style),
    detail(parts.join(SEP), style),
  ].join('\n');
}

export function renderRepos(view: ReposView, style: OutputStyle): string {
  const header = sectionHeader(
    `Repos under ${tildePath(view.root)} with Claude Code sessions in the last ${view.days} days`,
    {color: style.color, emoji: '📂'},
  );
  const blocks =
    view.summaries.length === 0
      ? [body('No session in the window.', style)]
      : view.summaries.map((summary) => repoSummaryBlock(summary, view, style));
  const notes: string[] = [];
  if (view.unplaced > 0) {
    notes.push(
      `${view.unplaced} session(s) had no cwd in their transcript and are not placed in any repo.`,
    );
  }
  if (view.outsideRoot.sessions > 0) {
    notes.push(
      `${view.outsideRoot.sessions} session(s) in ${view.outsideRoot.directories} director${view.outsideRoot.directories === 1 ? 'y' : 'ies'} outside ${tildePath(view.root)} are not listed (usually test probes in temp directories). ${paint('--root /', ['cyan'], style.color)} lists them.`,
    );
  }
  const next = body(
    `Next: ${paint('bun run justin-sdk forensics repo <path>', ['cyan'], style.color)} for one repo's checkouts and sessions.`,
    style,
  );
  return `${spacedList([
    [header, '', spacedList(blocks)].join('\n'),
    notes.length === 0
      ? ''
      : spacedList(notes.map((note) => body(note, style))),
    next,
    failuresSection([...threadsFailure(view.threads), ...view.failures], style),
  ])}\n`;
}

// ---------------------------------------------------------------------------
// forensics repo <path>
// ---------------------------------------------------------------------------

export interface RepoView {
  chars: number;
  days: number;
  failures: string[];
  now: Date;
  sessions: ForensicsSession[];
  threads: ThreadIndex;
  worktrees: RepoWorktrees;
}

const MAX_LISTED = 10;

function upstreamText(wt: WorktreeFacts, style: OutputStyle): string {
  const {upstream} = wt;
  if (upstream == null) return 'upstream unknown';
  if (upstream === 'none') {
    const onlyHere =
      wt.vsBaseline != null && wt.vsBaseline.ahead > 0
        ? ': its commits exist on this machine only'
        : '';
    return paint(`no upstream${onlyHere}`, ['yellow'], style.color);
  }
  const label =
    upstream.kind === 'same-name'
      ? `${upstream.ref} (not tracked)`
      : upstream.ref;
  const unpushed = `${upstream.ahead} unpushed`;
  return `${label}: ${upstream.ahead > 0 ? paint(unpushed, ['yellow'], style.color) : unpushed}, ${upstream.behind} behind`;
}

function worktreeBlock(
  wt: WorktreeFacts,
  repo: RepoWorktrees,
  style: OutputStyle,
): string {
  const name = wt.branch ?? `detached at ${(wt.head ?? '?').slice(0, 12)}`;
  const tags: string[] = [];
  if (wt.isPrimary) tags.push('primary checkout');
  if (wt.locked) tags.push('locked');
  if (!wt.exists) tags.push('directory missing');
  const title = [
    paint(name, ['bold'], style.color),
    ...tags.map((tag) => paint(tag, ['dim'], style.color)),
  ].join(SEP);
  const rel = relative(repo.repo, wt.path);
  const lines = [body(title, style)];
  if (!wt.isPrimary) {
    lines.push(detail(rel.startsWith('..') ? wt.path : rel, style));
  }

  const position: string[] = [];
  if (wt.vsBaseline != null && repo.baseline != null) {
    position.push(
      `${wt.vsBaseline.ahead} commits not on ${repo.baseline}`,
      `${wt.vsBaseline.behind} ${repo.baseline} commits missing`,
    );
  }
  position.push(upstreamText(wt, style));
  if (wt.lastCommitAt != null) {
    position.push(`last commit ${localStamp(wt.lastCommitAt)}`);
  }
  lines.push(detail(position.join(SEP), style));

  if (wt.uncommitted == null) {
    lines.push(detail('uncommitted: not checked', style));
  } else if (wt.uncommitted.length > 0) {
    const shown = wt.uncommitted
      .slice(0, MAX_LISTED)
      .map((line) => line.trim());
    const more =
      wt.uncommitted.length > MAX_LISTED
        ? `, +${wt.uncommitted.length - MAX_LISTED} more`
        : '';
    lines.push(
      detail(
        paint(
          `uncommitted (${wt.uncommitted.length}): ${shown.join(', ')}${more}`,
          ['yellow'],
          style.color,
        ),
        style,
      ),
    );
  }

  const beads = wt.branchOnlyBeads;
  if (beads?.kind === 'measured' && beads.beads.length > 0) {
    const shown = beads.beads
      .slice(0, MAX_LISTED)
      .map((bead) => `${bead.id} ${preview(bead.title ?? '', 60)}`);
    const more =
      beads.beads.length > MAX_LISTED
        ? ` (+${beads.beads.length - MAX_LISTED} more)`
        : '';
    lines.push(
      detail(
        `open beads only on this branch (${beads.beads.length}): ${shown.join('; ')}${more}`,
        style,
      ),
    );
  }
  for (const failure of wt.failures) {
    lines.push(detail(paint(failure, ['yellow'], style.color), style));
  }
  return lines.join('\n');
}

function sessionBlock(
  session: ForensicsSession,
  view: RepoView,
  style: OutputStyle,
): string {
  // A reported thread's title was written to be recognisable; a backfilled
  // one is only the first line of the first message, so the preview beats it.
  const reportedTitle =
    session.thread?.source === 'report' ? session.thread.title : null;
  const heading =
    reportedTitle ??
    (session.firstUserMessage == null
      ? '(no user message)'
      : preview(session.firstUserMessage, 90));
  const lines = [body(paint(heading, ['bold'], style.color), style)];

  const when = [
    paint(session.sessionId, ['cyan'], style.color),
    `last active ${ageFrom(session.lastTimestamp, view.now)} (${localStamp(session.lastTimestamp)})`,
  ];
  if (session.firstTimestamp != null) {
    when.push(`started ${localStamp(session.firstTimestamp)}`);
  }
  if (session.branch != null) when.push(`branch ${session.branch}`);
  lines.push(detail(when.join(SEP), style));

  if (!view.threads.ok) {
    lines.push(detail('thread: unknown (threads unreadable)', style));
  } else if (session.thread == null) {
    lines.push(detail(paint('thread: none', ['yellow'], style.color), style));
  } else {
    const thread = [
      `thread ${session.thread.id}`,
      session.thread.source ?? 'source unknown',
    ];
    if (session.thread.status === 'closed') thread.push('closed');
    if (session.thread.mergeState != null) {
      thread.push(`merge badge: ${session.thread.mergeState}`);
    }
    if (session.thread.openAsks > 0) {
      thread.push(`${session.thread.openAsks} open asks`);
    }
    lines.push(detail(thread.join(SEP), style));
  }

  const message = (label: string, text: string | null): string =>
    detail(
      `${paint(label, ['italic'], style.color)} ${text == null ? paint('(none)', ['dim'], style.color) : preview(text, view.chars)}`,
      style,
    );
  lines.push(
    message('your first message:', session.firstUserMessage),
    message('your last message:', session.lastUserMessage),
    message("Claude's last response:", session.lastAssistantMessage),
  );
  if (session.resumeCommand != null) {
    lines.push(
      detail(
        `resume: ${paint(session.resumeCommand, ['cyan'], style.color)}`,
        style,
      ),
    );
  }
  for (const failure of session.failures) {
    lines.push(detail(paint(failure, ['dim'], style.color), style));
  }
  return lines.join('\n');
}

export function renderRepo(view: RepoView, style: OutputStyle): string {
  const {worktrees} = view;
  const baseline = worktrees.baseline ?? 'no baseline';
  const checkouts = [
    sectionHeader(`Checkouts of ${worktrees.repo}${SEP}baseline ${baseline}`, {
      color: style.color,
      emoji: '🌿',
    }),
    '',
    body(
      paint(
        'Commit counts are by identity: a squash-merged or rebased branch still shows commits here. `justin-sdk repo-status` proves merges by content.',
        ['dim'],
        style.color,
      ),
      style,
    ),
    '',
    spacedList(
      worktrees.worktrees.map((wt) => worktreeBlock(wt, worktrees, style)),
    ),
  ].join('\n');

  const sessions = [
    sectionHeader(
      `Sessions in the last ${view.days} days${SEP}${view.sessions.length}`,
      {color: style.color, emoji: '💬'},
    ),
    '',
    view.sessions.length === 0
      ? body('No session in the window.', style)
      : spacedList(
          view.sessions.map((session) => sessionBlock(session, view, style)),
        ),
    '',
    body(
      `Full message log of one session: ${paint('bun run justin-sdk thread show --session <id> --messages', ['cyan'], style.color)}`,
      style,
    ),
  ].join('\n');

  return `${spacedList([
    checkouts,
    sessions,
    failuresSection(
      [
        ...worktrees.failures,
        ...threadsFailure(view.threads),
        ...view.failures,
      ],
      style,
    ),
  ])}\n`;
}
