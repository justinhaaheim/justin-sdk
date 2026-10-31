/**
 * The one spelling of a session's name: "[TAG] <title>" (home-base-j8q3e.5
 * D1). Plain text, no markdown escaping and no truncation: callers that render
 * markdown wrap it in tildeText themselves, and the cmux workspace name uses it
 * as it is.
 *
 * `repoTag` is the RESOLVED tag (home-base-bomy5.7.1): the repo's declared
 * `projectTag`, else its folder name uppercased — `resolveRepoTag` in
 * config.ts decides it, from the session's own checkout, and the session model
 * and the inbox card carry it as `repoTag`. Never pass a plain repo name here.
 * Null means the repo itself is unknown. `text` is the title, or, for the
 * untracked one-liner, his first message.
 */
export function sessionDisplayName(
  repoTag: string | null,
  text: string,
): string {
  return `[${repoTag ?? 'UNKNOWN REPO'}] ${text}`;
}

/** A session name used as a tab title or a Claude Code session name is cut here. */
export const SESSION_NAME_LIMIT = 80;

/**
 * home-base-mbnjv.3 item 6: the name a successor's --name, --remote-control
 * name and tab title use, sessionDisplayName cut to SESSION_NAME_LIMIT
 * characters with "…". Same `repoTag` contract as sessionDisplayName. The
 * workspace name is the uncut sessionDisplayName (it was before this), so a
 * title past the limit is cut in the tab and whole in the workspace.
 */
export function sessionName(repoTag: string | null, text: string): string {
  const full = sessionDisplayName(repoTag, text).trimEnd();
  return full.length > SESSION_NAME_LIMIT
    ? `${full.slice(0, SESSION_NAME_LIMIT - 1)}…`
    : full;
}

// ---------------------------------------------------------------------------
// TRIAL (home-base-jm5kg.6 D5): the workspace name with its items
// ---------------------------------------------------------------------------

export const DONE_ITEM_MARK = '✅';
export const OPEN_ITEM_MARK = '🔳';

/**
 * The longest workspace name the trial writes, in characters (code points).
 * NOT MEASURED against what the cmux sidebar shows (home-base-jm5kg.6 notes):
 * the sidebar cuts by pixel width, which a session cannot see. Justin's own
 * example name is 125 code points, so 160 keeps it whole with room for about
 * one more request.
 */
export const WORKSPACE_ITEMS_NAME_LIMIT = 160;

export interface NameItem {
  done: boolean;
  title: string;
}

/**
 * "[TAG] <title> ✅ <done> 🔳 <open> …", cut to WORKSPACE_ITEMS_NAME_LIMIT
 * code points with "…" (never inside a surrogate pair).
 */
export function itemsDisplayName(
  repoTag: string | null,
  title: string,
  items: readonly NameItem[],
): string {
  const text = [
    title.trim(),
    ...items.map(
      (item) =>
        `${item.done ? DONE_ITEM_MARK : OPEN_ITEM_MARK} ${item.title.trim()}`,
    ),
  ].join(' ');
  const full = sessionDisplayName(repoTag, text).trimEnd();
  const points = Array.from(full);
  if (points.length <= WORKSPACE_ITEMS_NAME_LIMIT) return full;
  return `${points
    .slice(0, WORKSPACE_ITEMS_NAME_LIMIT - 1)
    .join('')
    .trimEnd()}…`;
}
