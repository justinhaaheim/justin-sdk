/**
 * repo-status — turning evidence into a disposition.
 *
 * Every branch that is not trivially merged gets ONE verdict plus a one-line
 * "why", so a reconcile becomes: read the ledger, act on the provable rows,
 * and spend human judgment only on the residual. "32 branches" becomes
 * "17 provably safe, 5 squash-merged, 10 needing a look".
 *
 * SAFETY ORDERING. The rules below are evaluated in a deliberate order, and the
 * unsafe cases are checked BEFORE the reassuring ones. A stale archive mirror
 * must be caught before "a mirror exists" can conclude anything, because that
 * ordering is the difference between preserving 122 commits and destroying
 * them. `provenSafe` is the only field `apply` is ever allowed to act on, and
 * nothing sets it without positive proof.
 *
 * Part of home-base-qyu1.1.
 */

import type {ContentProof} from './content';
import type {PullRequest} from './prs';
import type {BranchDivergence} from './types';

export type Disposition =
  /** Every unique commit is demonstrably on the baseline. Nothing to lose. */
  | 'merged'
  /** Not on the baseline, but preserved in an exact, non-stale archive mirror. */
  | 'mirrored'
  /** Evidence conflicts or is incomplete — a human should look before acting. */
  | 'review'
  /** Real unmerged work with no proof of preservation anywhere. */
  | 'needs-judgment';

export interface BranchDisposition {
  disposition: Disposition;
  /** One line explaining the verdict, in plain language. */
  why: string;
  /**
   * True ONLY when the tool can prove no work would be lost by deleting this
   * branch. `apply` acts on nothing else.
   */
  provenSafe: boolean;
}

export interface DispositionInputs {
  branch: BranchDivergence;
  /** Null when the +content enrichment was not run. */
  proof: ContentProof | null;
  /** Null when there is no PR, or when +prs was not run / unavailable. */
  pr: PullRequest | null;
  /** Whether PR data was actually available (absent data != absence of a PR). */
  prDataAvailable: boolean;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function decideDisposition(
  inputs: DispositionInputs,
): BranchDisposition {
  const {branch, pr, prDataAvailable, proof} = inputs;

  // --- Trivially contained: no unique commits at all -----------------------
  if (branch.ahead === 0) {
    return {
      disposition: 'merged',
      provenSafe: true,
      why: `no unique commits; fully contained in ${branch.behind > 0 ? `the baseline (${plural(branch.behind, 'commit')} behind)` : 'the baseline'}`,
    };
  }

  const mirror = proof?.archiveMirror ?? null;

  // --- UNSAFE CASES FIRST ---------------------------------------------------
  // A stale mirror is the single most dangerous state: it LOOKS like a safe
  // archive and is not. This must be evaluated before any mirror-based
  // reassurance below.
  if (mirror?.exists === true && mirror.commitsMissingFromMirror > 0) {
    const against =
      mirror.staleAgainst != null ? ` (${mirror.staleAgainst})` : '';
    return {
      disposition: 'review',
      provenSafe: false,
      why: `archive mirror ${mirror.ref} is STALE — ${plural(mirror.commitsMissingFromMirror, 'commit')} exist${mirror.commitsMissingFromMirror === 1 ? 's' : ''} on the branch${against} that the mirror does not have. Deleting would destroy them.`,
    };
  }

  // --- No content proof computed: stay conservative -------------------------
  if (proof == null) {
    return {
      disposition: 'needs-judgment',
      provenSafe: false,
      why: `${plural(branch.ahead, 'commit')} ahead; content proof not computed (run with content checking enabled to resolve)`,
    };
  }

  // --- Proven merged by content --------------------------------------------
  if (proof.allContentOnBaseline) {
    const viaPatchId = proof.uniqueCommits.filter(
      (c) => c.patchIdPresent,
    ).length;
    const viaFiles = proof.uniqueCommits.length - viaPatchId;
    const how =
      viaFiles === 0
        ? 'all matched by patch-id'
        : viaPatchId === 0
          ? 'all changed files already identical on the baseline'
          : `${viaPatchId} matched by patch-id, ${viaFiles} confirmed file-by-file`;
    return {
      disposition: 'merged',
      provenSafe: true,
      why: `${plural(proof.uniqueCommits.length, 'unique commit')} already on ${proof.baselineRef} by content — ${how}`,
    };
  }

  // --- Not merged, but exactly mirrored ------------------------------------
  if (mirror?.exists === true && mirror.isExact) {
    return {
      disposition: 'mirrored',
      provenSafe: true,
      why: `not on ${proof.baselineRef}, but preserved exactly in ${mirror.ref} (mirror is current)`,
    };
  }

  // --- A merged PR that content cannot corroborate --------------------------
  if (pr?.state === 'MERGED') {
    return {
      disposition: 'review',
      provenSafe: false,
      why: `PR #${pr.number} is merged into ${pr.baseRefName}, but ${plural(proof.unaccountedCommits.length, 'commit')} could not be found on ${proof.baselineRef} — possibly merged to a different base, or reverted`,
    };
  }

  // --- Genuinely unresolved -------------------------------------------------
  const prNote =
    pr != null
      ? ` (PR #${pr.number} ${pr.state.toLowerCase()})`
      : prDataAvailable
        ? ' (no PR)'
        : ' (PR state unknown)';
  return {
    disposition: 'needs-judgment',
    provenSafe: false,
    why: `${plural(proof.unaccountedCommits.length, 'commit')} not present on ${proof.baselineRef} and no archive mirror${prNote}`,
  };
}
