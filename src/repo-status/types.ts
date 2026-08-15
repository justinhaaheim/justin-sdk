/**
 * repo-status — the shared type schema.
 *
 * Everything the tool produces is compiled into ONE typed object, and only
 * THEN rendered (YAML by default, `--json` for the same object, a compact
 * prose form for the `prime` SessionStart injection). Building the object
 * first — rather than assembling bespoke JSON only when `--json` is passed —
 * is what keeps every output surface on one consistent schema.
 *
 * COST MODEL. The object is populated by a cheap core plus two ORTHOGONAL,
 * independently-togglable enrichments. They are not nested tiers: either can
 * be enabled without the other.
 *
 *   core      worktrees + branch tips + ahead/behind. Local refs only, no
 *             network, no per-commit work. Always populated.
 *   +prs      PR state via `gh`. Network. Independent of +content.
 *   +content  patch-id/cherry proofs, per-changed-file diffs, archive-mirror
 *             freshness. Local, but potentially thousands of git invocations.
 *             Independent of +prs.
 *
 * `repo-status` enables both by default. The `prime` session-start path
 * enables core only by default, with +prs available opt-in.
 *
 * Part of home-base-qyu1.
 */

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/** A checked-out working tree of the repo (the primary clone, or a linked worktree). */
export interface WorktreeEntry {
  path: string;
  /** Short branch name, or null when the worktree is on a detached HEAD. */
  branch: string | null;
  /** True for the original clone; false for `git worktree add` linked trees. */
  isPrimary: boolean;
}

/** A branch tip, local or remote-only. */
export interface BranchTip {
  /** Short name for locals (`main`), remote-qualified for remote-only (`origin/foo`). */
  name: string;
  isRemoteOnly: boolean;
  tipSha: string;
  /** ISO 8601 committer date of the tip commit. */
  lastCommitDate: string;
  /** Path of the worktree that has this branch checked out, if any. */
  worktreePath: string | null;
}

/**
 * How far a branch diverges from the baseline ref.
 *
 * `ahead` is what the branch has that the baseline lacks — the commits at risk
 * of being lost. `behind` is how far the branch trails the baseline; it is
 * reported because it is the standard metric, but it must NEVER be used to
 * infer mergedness (see the two-dot/three-dot footgun in `content.ts`).
 */
export interface DivergenceCounts {
  ahead: number;
  behind: number;
}

/**
 * A branch tip plus its divergence — or an explicit statement that the
 * divergence is UNKNOWN.
 *
 * WHY THIS IS NULLABLE, AND WHY IT IS ONE FIELD RATHER THAN TWO
 * (home-base-qyu1.21). The counts come from a single `rev-list`, which can fail
 * for reasons that have nothing to do with the branch: an unresolvable
 * baseline, a gc/lock race, a missing object. That failure used to be
 * FABRICATED into `{ahead: 0, behind: 0}`, and `ahead === 0` is exactly what
 * the disposition engine reads as "fully contained in the baseline, proven safe
 * to delete" — so a transient git error silently became a licence to destroy a
 * branch. The absence of evidence has to be representable, or it gets
 * misreported as evidence of absence.
 *
 * It is ONE nullable field and not two nullable numbers because the two numbers
 * are produced by one command: "ahead known, behind unknown" is not a state
 * that can occur, and a shape that can express it invites code that handles
 * only half of it.
 */
export interface BranchDivergence extends BranchTip {
  /** Null when the divergence could not be measured — never assume zero. */
  divergence: DivergenceCounts | null;
}

/**
 * The always-populated core inventory. Cheap: one `worktree list`, one
 * `for-each-ref`, and one `rev-list` per candidate branch.
 */
export interface CoreInventory {
  repoRoot: string;
  /** Null on a detached HEAD or outside a git repo. */
  currentBranch: string | null;
  /** The repo's default branch (`main`/`master`), if one could be determined. */
  defaultBranch: string | null;
  /** The ref `ahead`/`behind` are measured against. */
  baselineRef: string;
  branches: BranchDivergence[];
  worktrees: WorktreeEntry[];
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface CoreOptions {
  cwd: string;
  /**
   * What to measure divergence against. `current` is what the prime
   * session-start view wants ("work you might not know about from where you
   * are standing"); `default` is what reconcile wants (mergedness to main).
   * An explicit ref string overrides both.
   */
  baseline?: 'current' | 'default' | (string & {});
  /**
   * Branches with no commit inside this window are dropped unless they have a
   * worktree. Set to null to disable the filter entirely (reconcile wants every
   * branch, however old; the session-start view wants only recent ones).
   */
  sinceDays?: number | null;
}
