/**
 * A request's SHORT LABEL (home-base-jm5kg.18): two to five words, "like
 * compact commit messages" (Justin, 2026-11-03), for the cmux workspace name
 * and description. `thread request --short` sets it.
 *
 * STORED AS A LABEL, `short:Fix_login_bug`, like `overarching-set:`. br allows
 * only letters, digits, hyphen, underscore and colon in a label (measured
 * 2026-11-06 on br 0.5.12: anything else exits 4), so `_` stands for a space
 * and a text holding any other character is refused rather than altered. The
 * label reads as it means in `br show`.
 *
 * A request with no label (every request filed before this) falls back to its
 * title cut with "…".
 */

export const SHORT_LABEL_PREFIX = 'short:';

export const SHORT_MIN_WORDS = 2;
export const SHORT_MAX_WORDS = 5;
export const SHORT_MAX_CHARS = 60;

/** Where a title with no short label is cut, in code points. */
export const CUT_TITLE_LIMIT = 40;

export const SHORT_USAGE = `--short takes ${SHORT_MIN_WORDS} to ${SHORT_MAX_WORDS} words, like a compact commit message, in at most ${SHORT_MAX_CHARS} characters: letters, digits, spaces, hyphens and colons only (br refuses anything else in a label)`;

/** The text with its spacing normalised, or why it cannot be a short label. */
export function checkShortText(
  raw: string,
): {ok: false; reason: string} | {ok: true; text: string} {
  const text = raw.trim().replace(/\s+/gu, ' ');
  const words = text === '' ? [] : text.split(' ');
  if (
    words.length < SHORT_MIN_WORDS ||
    words.length > SHORT_MAX_WORDS ||
    text.length > SHORT_MAX_CHARS ||
    !/^[A-Za-z0-9 :-]*$/u.test(text)
  ) {
    return {ok: false, reason: `"${raw}" is refused: ${SHORT_USAGE}`};
  }
  return {ok: true, text};
}

/** `short:Fix_login_bug` for a text checkShortText passed. */
export function shortLabelOf(text: string): string {
  return `${SHORT_LABEL_PREFIX}${text.replaceAll(' ', '_')}`;
}

/** Every short label a bead carries. */
export function staleShortLabels(labels: readonly string[]): string[] {
  return labels.filter((label) => label.startsWith(SHORT_LABEL_PREFIX));
}

/** The label edit that gives a request this short label, in one `br update`. */
export function shortLabelEdit(
  labels: readonly string[],
  text: string,
): {addLabels: string[]; removeLabels: string[]} {
  const label = shortLabelOf(text);
  return {
    addLabels: [label],
    removeLabels: staleShortLabels(labels).filter((entry) => entry !== label),
  };
}

/** The short label's text, or null when the request has none. */
export function readShortLabel(labels: readonly string[]): string | null {
  const label = labels.find((entry) => entry.startsWith(SHORT_LABEL_PREFIX));
  if (label == null) return null;
  const text = label.slice(SHORT_LABEL_PREFIX.length).replaceAll('_', ' ');
  return text.trim() === '' ? null : text;
}

/** A title cut to CUT_TITLE_LIMIT code points with "…", never inside an emoji. */
export function cutTitle(title: string): string {
  const points = Array.from(title.trim());
  if (points.length <= CUT_TITLE_LIMIT) return points.join('');
  return `${points
    .slice(0, CUT_TITLE_LIMIT - 1)
    .join('')
    .trimEnd()}…`;
}

/** What the description shows for a request: its short label, else its cut title. */
export function shortOrCutTitle(issue: {
  labels: readonly string[];
  title: string;
}): string {
  return readShortLabel(issue.labels) ?? cutTitle(issue.title);
}
