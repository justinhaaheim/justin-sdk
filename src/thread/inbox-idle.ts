/**
 * Idle time in the inbox (home-base-kwand.8, gap G4 of epic home-base-kwand).
 *
 * Justin, 2026-11-17: "Can I filter by idle time (as in "idle for at least
 * 24hrs")?" `--days` means "active within"; `--idle-for` is the other edge,
 * "no activity for at least", and the two together give a band.
 *
 * Also the surprise in G4: `thread inbox --days 5` showed a card "36 days
 * ago", because a session waiting on him is never hidden by age. The window
 * keeps its meaning; a card older than it that is shown anyway now says why
 * (`OlderShownReason`) and sits under its own counted heading.
 *
 * Critical rule 7: a session whose last activity cannot be dated is never
 * counted as idle, and never as older than the window. `--idle-for` leaves it
 * out and names it.
 */
import type {InboxRead, InboxRow} from './session-inbox';

import {parseInstant} from './answer-store';
import {parseSince, type SinceParse} from './open-filters';

/**
 * Why a card whose last activity is older than the `--days` window is shown
 * anyway. Each is a rule the window already had; this only names it.
 */
export type OlderShownReason =
  /** home-base-kwand.2: `--before-restart` keeps every session that was in a tab. */
  | 'beforeRestart'
  /** R5: ⏳ export behind is never hidden by age. */
  | 'exportBehind'
  /**
   * A tracked session whose session index and message log carry no date,
   * so the window could not place it (an undated session is never hidden);
   * its transcript's last record is older than the window.
   */
  | 'indexUndated'
  /**
   * An untracked session is in the window when its transcript FILE was
   * written inside it; its last conversation record can be older.
   */
  | 'transcriptWritten'
  /** R5: ❔ unknown is never hidden by age (except when its activity is unreadable). */
  | 'unknown'
  /** A session that could not be loaded is never dropped. */
  | 'unreadable'
  /** D-DRAFTS: text typed and never sent exists nowhere else. */
  | 'unsentDraft'
  /** R5: 🛑 waiting on you is never hidden by age. */
  | 'waiting';

/** The order the older groups are listed in, and each one's words. */
export const OLDER_SHOWN_GROUPS: readonly {
  emoji: string;
  reason: OlderShownReason;
  words: string;
}[] = [
  {emoji: '🛑', reason: 'waiting', words: 'waiting on you'},
  {emoji: '✍️', reason: 'unsentDraft', words: 'unsent text in the input box'},
  {emoji: '🔁', reason: 'beforeRestart', words: 'open before the restart'},
  {emoji: '⏳', reason: 'exportBehind', words: 'export behind'},
  {emoji: '❔', reason: 'unknown', words: 'status unknown'},
  {emoji: '❔', reason: 'unreadable', words: 'could not be loaded'},
  {
    emoji: '❔',
    reason: 'indexUndated',
    words: 'the session index could not date it',
  },
  {
    emoji: '📄',
    reason: 'transcriptWritten',
    words: 'not tracked, its transcript file was written inside the window',
  },
];

/** "Older than 5 days, waiting on you": the heading of one older group. */
export function olderHeading(reason: OlderShownReason, days: number): string {
  const words =
    OLDER_SHOWN_GROUPS.find((group) => group.reason === reason)?.words ??
    reason;
  return `Older than ${days} ${days === 1 ? 'day' : 'days'}, ${words}`;
}

/** Milliseconds since `at`, or null when it is absent or cannot be parsed. */
export function idleMsAt(at: string | null, now: Date): number | null {
  if (at == null) return null;
  const ms = parseInstant(at);
  return ms == null ? null : Math.max(0, now.getTime() - ms);
}

/** `--idle-for`: `24h`, `3d`, `2w`, as `--since` takes them. */
export function parseIdleFor(raw: string): SinceParse {
  return parseSince(raw, '--idle-for');
}

/** The filter a run used, and what it left out and why (rule 7). */
export interface IdleForRead {
  /** Rows left out for activity newer than the filter: their session ids. */
  active: string[];
  ms: number;
  /** `24h`, as typed (lower-cased). */
  text: string;
  /** Rows left out because their last activity could not be dated. */
  undated: {sessionId: string; title: string}[];
  /** `24 hours`. */
  words: string;
}

/** One row's idle time: its own, else from its last activity. */
function rowIdleMs(row: InboxRow, now: Date): number | null {
  return row.idleMs !== undefined
    ? row.idleMs
    : idleMsAt(row.lastActivityAt, now);
}

/**
 * `--idle-for`: only the rows whose last activity is at least `ms` old
 * (exactly `ms` is included). A row that cannot be dated is left out and
 * named in `idleFor.undated`, never counted as idle. A folded line (F6)
 * stands for its newest session, so it is idle only when all of them are.
 */
export function filterIdleFor(
  read: InboxRead,
  filter: {ms: number; text: string; words: string},
  now: Date,
): InboxRead {
  const active: string[] = [];
  const undated: IdleForRead['undated'] = [];
  const rows = read.rows.filter((row) => {
    const idle = rowIdleMs(row, now);
    if (idle == null) {
      undated.push({sessionId: row.sessionId, title: row.title});
      return false;
    }
    if (idle < filter.ms) {
      active.push(row.sessionId);
      return false;
    }
    return true;
  });
  return {
    ...read,
    idleFor: {
      active,
      ms: filter.ms,
      text: filter.text,
      undated,
      words: filter.words,
    },
    rows,
  };
}

/**
 * The note the text inbox prints under an idle filter: what it left out and
 * why. Null when it left out nothing.
 */
export function idleForNote(idleFor: IdleForRead): string | null {
  const parts: string[] = [];
  if (idleFor.active.length > 0) {
    parts.push(`${idleFor.active.length} active in the last ${idleFor.words}`);
  }
  if (idleFor.undated.length > 0) {
    parts.push(
      `${idleFor.undated.length} whose last activity could not be dated, so ${idleFor.undated.length === 1 ? 'it is' : 'they are'} not counted as idle (${idleFor.undated.map((entry) => entry.sessionId).join(', ')})`,
    );
  }
  if (parts.length === 0) return null;
  return `--idle-for ${idleFor.text} left out ${parts.join('; and ')}.`;
}
