/**
 * repo-status — saying what `behind` already proves about MERGING.
 *
 * Every branch row already carries `ahead`/`behind` from one `rev-list
 * --left-right --count baseline...branch`. Those two numbers ALREADY settle the
 * "if I merge this, what happens?" question exactly, with no further git work:
 *
 *   behind === 0   <=>  no commit reachable from the baseline is missing from
 *                       the branch  <=>  the baseline is an ANCESTOR of the
 *                       branch  <=>  `git merge <branch>` from the baseline is
 *                       a fast-forward.
 *   behind > 0     <=>  the baseline has commits the branch lacks  <=>  the
 *                       merge writes a real merge commit and can conflict.
 *
 * That equivalence is exact — `git merge-base --is-ancestor <baseline>
 * <branch>` is asking the same question a second time. Sessions kept shelling
 * out for it anyway, because the report published the NUMBER and not the
 * QUESTION it answers. The same lesson as the submodule `question` field
 * (home-base-qyu1.14): a number whose meaning lives only in the reader's head
 * gets re-derived by hand every time. So the conclusion is a field.
 *
 * ── Why THREE states and not a boolean ───────────────────────────────────────
 *
 * The biconditional above holds only where there is something to merge. When
 * `ahead === 0` the branch is entirely contained in the baseline, and
 * `git merge` reports "Already up to date" — no fast-forward, no merge commit —
 * however far behind the branch is. A two-state `behind > 0 ? 'merge-needed' :
 * 'fast-forward'` would therefore tell a reader that a fully-merged, long-
 * abandoned branch "needs a merge commit", which is precisely the confusion
 * this field exists to end. `already-up-to-date` is that case, stated.
 *
 * ── What this is NOT ─────────────────────────────────────────────────────────
 *
 * It is a fact about SHA REACHABILITY, deliberately independent of the content
 * proofs in `content.ts` and the verdict in `disposition.ts`. The two can and
 * should disagree: a squash-merged branch is `disposition: merged` (every line
 * of its work is on the baseline) while its merge shape is `merge-needed` (the
 * squash commit is on the baseline and not on the branch, so the shas diverged).
 * Both readings are true and they drive different actions — "delete it, the work
 * landed" versus "you cannot fast-forward onto this". Suppressing the shape on
 * merged rows would delete the single most informative instance of it.
 *
 * KNOWN IMPRECISION: two histories with no common ancestor count as fully
 * divergent, so they report `merge-needed`; `git merge` would actually refuse
 * outright without `--allow-unrelated-histories`. Not a fast-forward either way,
 * which is the distinction being drawn.
 *
 * COST: zero. This module takes two integers and a ref NAME — it has no cwd and
 * cannot reach git even by accident.
 *
 * Part of home-base-qyu1.19.
 */

/**
 * The question this field's value answers.
 *
 * A whole sentence rather than a terse tag, for the same reason the submodule
 * questions are (home-base-qyu1.14): the primary reader is Claude reading YAML,
 * and it should need no lookup table to interpret what it is looking at.
 */
export const Q_MERGE_SHAPE =
  'if I merge this branch into the baseline, does it fast-forward or does it need a merge commit?';

export type MergeShapeKind =
  /** The baseline is an ancestor of the branch. `git merge` fast-forwards. */
  | 'fast-forward'
  /** Both sides moved. `git merge` writes a merge commit and can conflict. */
  | 'merge-needed'
  /** Nothing to merge: the branch is contained in the baseline already. */
  | 'already-up-to-date';

export interface MergeShape {
  /** Which question this row's ahead/behind numbers answer. */
  question: typeof Q_MERGE_SHAPE;
  kind: MergeShapeKind;
  /** One line, plain language — the same discipline as a branch row's `why`. */
  why: string;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * Read the merge shape off divergence counts that were already computed.
 *
 * `baselineRef` is used for wording only. Pure by construction: no cwd, no
 * subprocess, no git.
 */
export function describeMergeShape(
  divergence: {ahead: number; behind: number},
  baselineRef: string,
): MergeShape {
  const {ahead, behind} = divergence;

  if (ahead === 0) {
    const trailing =
      behind > 0
        ? ` — the ${plural(behind, 'commit')} behind are commits this branch is MISSING, not commits to merge`
        : '';
    return {
      kind: 'already-up-to-date',
      question: Q_MERGE_SHAPE,
      why: `nothing to merge: no commit here is missing from ${baselineRef}, so \`git merge\` reports "Already up to date"${trailing}`,
    };
  }

  if (behind === 0) {
    return {
      kind: 'fast-forward',
      question: Q_MERGE_SHAPE,
      why: `${baselineRef} is an ancestor of this branch (0 behind), so merging ${plural(ahead, 'commit')} into ${baselineRef} fast-forwards — no merge commit, no conflicts`,
    };
  }

  return {
    kind: 'merge-needed',
    question: Q_MERGE_SHAPE,
    why: `both sides moved (${ahead} ahead, ${behind} behind), so ${baselineRef} is NOT an ancestor of this branch — merging it in writes a merge commit and can conflict`,
  };
}
