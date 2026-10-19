/**
 * The filters of `thread open` (home-base-yukaf.22): which sessions a run
 * shows, like a dataview's filter over the inbox. Pure: parsing and matching
 * only, so open.ts and its tests share one reading of every flag.
 *
 * Justin, 2026-10-19: "Some times I will want to open only the last, say,
 * 24hrs. Some days I might want to see everything from the past week. Or even
 * two weeks" (--since, with the config default `openSince`); "Maybe --limit
 * n?" (--limit); "show me all the in-progress work for audio journal in a new
 * cmux window" (--repo, --include-open).
 */

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** The units `--since` takes: hours, days, weeks. Nothing else. */
const SINCE_UNITS: Readonly<Record<string, {ms: number; word: string}>> = {
  d: {ms: DAY_MS, word: 'day'},
  h: {ms: HOUR_MS, word: 'hour'},
  w: {ms: 7 * DAY_MS, word: 'week'},
};

const SINCE_FORMAT = /^(\d{1,6})([hdw])$/u;

export type SinceParse =
  | {kind: 'bad'; reason: string}
  | {kind: 'ok'; ms: number; text: string; words: string};

/**
 * `24h`, `3d`, `2w`: a whole number above 0 and one unit letter (h, d, w).
 * Anything else (`1.5d`, `7`, `2m`, `0d`, `-1d`) is refused, so a typo never
 * silently widens or narrows the window.
 */
export function parseSince(raw: string): SinceParse {
  const text = raw.trim().toLowerCase();
  const match = SINCE_FORMAT.exec(text);
  const count = match == null ? Number.NaN : Number(match[1]);
  const unit = match == null ? undefined : SINCE_UNITS[match[2] ?? ''];
  if (unit == null || !Number.isInteger(count) || count <= 0) {
    return {
      kind: 'bad',
      reason: `--since takes a whole number above 0 and h (hours), d (days) or w (weeks), like 24h, 3d or 2w; not ${JSON.stringify(raw)}`,
    };
  }
  return {
    kind: 'ok',
    ms: count * unit.ms,
    text,
    words: `${count} ${unit.word}${count === 1 ? '' : 's'}`,
  };
}

/** Where the window came from, for the header and the record. */
export type SinceSource = 'config' | 'days' | 'default' | 'since';

/** The filters a run used: printed in its header and kept in its record. */
export interface OpenFilters {
  includeOpen: boolean;
  /** At most this many sessions shown (opened plus moved); null = no limit. */
  limit: number | null;
  /** `--repo` values as typed; empty = every repo. */
  repos: string[];
  /** The window as text (`7d`), its length, and where it came from. */
  since: string;
  sinceMs: number;
  sinceSource: SinceSource;
  sinceWords: string;
}

/** `--limit`: a whole number above 0, or absent. */
export function parseLimit(
  raw: number | null,
): {kind: 'bad'; reason: string} | {kind: 'ok'; limit: number | null} {
  if (raw == null) return {kind: 'ok', limit: null};
  if (!Number.isInteger(raw) || raw <= 0) {
    return {
      kind: 'bad',
      reason: `--limit takes a whole number above 0; not ${String(raw)}`,
    };
  }
  return {kind: 'ok', limit: raw};
}

/** `[HB]`, `hb`, ` HB ` → `hb`: how a typed repo name or tag is compared. */
function repoKey(value: string): string {
  return value
    .trim()
    .replace(/^\[(.*)\]$/u, '$1')
    .trim()
    .toLowerCase();
}

/** `--repo` values, split on commas, blanks dropped. */
export function repoValues(raw: readonly string[]): string[] {
  return raw
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter((value) => value !== '');
}

/**
 * Whether a session belongs to one of the `--repo` values: its repo folder
 * name or its project tag, ignoring case (and the tag's brackets). No values
 * means every repo.
 */
export function matchesRepo(
  session: {repo: string | null; repoTag: string | null},
  wanted: readonly string[],
): boolean {
  if (wanted.length === 0) return true;
  const keys = new Set(wanted.map(repoKey));
  const own = [session.repo, session.repoTag]
    .filter((value): value is string => value != null && value.trim() !== '')
    .map(repoKey);
  return own.some((value) => keys.has(value));
}
