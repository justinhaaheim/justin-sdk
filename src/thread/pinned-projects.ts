/**
 * D-PINS (home-base-yukaf.9, epic home-base-yukaf): the repos Justin keeps at
 * the top of every by-repo view (`componentConfig.thread.pinnedProjects`,
 * repo folder names; he said home-base "always needs to be right at the top").
 *
 * A LEAF, so the threads TUI orders its repo groups with the same function
 * `thread inbox --by-repo` uses, without loading the inbox.
 */

/**
 * `keys` (repo folder names, already newest-first) with the pinned ones moved
 * to the front in config order. A pin matches a key ignoring case; a pin with
 * no sessions in view adds nothing, and the unpinned keep their order.
 */
export function pinnedFirst(
  keys: readonly string[],
  pinned: readonly string[],
): string[] {
  const front: string[] = [];
  const taken = new Set<string>();
  for (const pin of pinned) {
    const want = pin.trim().toLowerCase();
    if (want === '') continue;
    for (const key of keys) {
      if (taken.has(key) || key.toLowerCase() !== want) continue;
      front.push(key);
      taken.add(key);
    }
  }
  return [...front, ...keys.filter((key) => !taken.has(key))];
}
