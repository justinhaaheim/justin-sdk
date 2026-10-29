/**
 * Where Claude Code puts a repo's worktrees, as a pure string rule.
 *
 * Claude Code creates a repo's worktrees at `<primary>/.claude/worktrees/<name>`,
 * so a path containing `/.claude/worktrees/` names its primary checkout in the
 * prefix before that segment. The rule reads the PATH only, which is why it is
 * the one way to find the primary of a worktree whose directory is gone: there
 * is no `.git` file left to read and nothing for git to answer from.
 *
 * Shared by `primaryCheckoutOf` (thread/config.ts, which tag a session's name
 * carries) and `resolveRecordedBeadsDb` (beads/br.ts, which beads DB an old
 * sessions-index entry now lives in), so the two never disagree on it.
 */

/** The path segment Claude Code's worktrees sit under. */
export const CLAUDE_WORKTREES_SEGMENT = '/.claude/worktrees/';

/**
 * The primary checkout of a path under `<primary>/.claude/worktrees/`, from the
 * path alone, or null when the path is not under such a directory. The first
 * occurrence wins, so a worktree path always maps to the outermost checkout.
 */
export function primaryOfClaudeWorktreePath(path: string): string | null {
  const at = path.indexOf(CLAUDE_WORKTREES_SEGMENT);
  return at > 0 ? path.slice(0, at) : null;
}
