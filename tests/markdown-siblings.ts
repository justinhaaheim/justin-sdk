/**
 * Sibling list items in markdown Claude pastes, and the empty lines between
 * them (home-base-j8q3e.1.7.2, reused by home-base-j8q3e.1.10 F7). Measured on
 * Claude Code 2.1.300 (docs/reference/claude-code-markdown-rendering.md): ONE
 * empty line between two list items is dropped on screen, TWO show as one
 * empty row. A test asserts `emptyLines >= 2` on the pairs that must show a gap.
 */

const LIST_ITEM = /^( *)(?:\d+\.|[-*]) /u;

export interface SiblingPair {
  before: string;
  /** Empty lines directly above `next`. */
  emptyLines: number;
  next: string;
}

/**
 * Every pair of sibling list items in `lines`: an item and the next item at
 * the same indent, when no line at a shallower indent (or a non-item line at
 * the same indent, such as a question's "If you don't answer" paragraph or a
 * request's Stage line) comes between them and ends the list.
 */
export function siblingPairs(lines: readonly string[]): SiblingPair[] {
  const pairs: SiblingPair[] = [];
  lines.forEach((text, at) => {
    const item = LIST_ITEM.exec(text);
    if (item == null) return;
    const indent = item[1]?.length ?? 0;
    for (let next = at + 1; next < lines.length; next += 1) {
      const candidate = lines[next] ?? '';
      if (candidate.trim() === '') continue;
      const depth = candidate.length - candidate.trimStart().length;
      if (depth < indent) return;
      if (depth > indent) continue;
      if (!LIST_ITEM.test(candidate)) return;
      let emptyLines = 0;
      while (lines[next - 1 - emptyLines] === '') emptyLines += 1;
      pairs.push({before: text.trim(), emptyLines, next: candidate.trim()});
      return;
    }
  });
  return pairs;
}
