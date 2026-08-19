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
 * The very first rule is the one for MISSING evidence: a branch whose
 * divergence could not be measured gets `review`, before any rule that could
 * read a fabricated number as reassurance (home-base-qyu1.21). The same
 * ordering applies one level down, to a content proof containing a file git
 * could not read (home-base-qyu1.24) — incomplete evidence is ruled on before
 * both `merged` and `mirrored`.
 *
 * Part of home-base-qyu1.1.
 */

import {findUnreadableEvidence, mirrorFullyPreserves} from './content';

import type {ContentProof} from './content';
import type {PullRequest} from '../plugin/lib/repo-status/prs';
import type {BranchDivergence} from '../plugin/lib/repo-status/types';

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
  /**
   * The ref divergence was measured against. Named in the verdict, so a reader
   * of a failed measurement can see WHICH comparison could not be made.
   */
  baselineRef: string;
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
  const {baselineRef, branch, pr, prDataAvailable, proof} = inputs;
  const {divergence} = branch;

  // --- UNMEASURED: no evidence at all, so no conclusion at all --------------
  // FIRST, above every other rule including the reassuring `ahead === 0` one
  // below. When the divergence could not be computed, this function has been
  // handed nothing to reason from: the content proof (when one was even
  // attempted) walks the same history with the same git, so it cannot rescue
  // the row either, and letting it try would let `allContentOnBaseline` grant
  // `provenSafe` off a proof of an unknown set of commits. Unknown is a
  // `review` — the disposition that exists for incomplete evidence — never a
  // `merged`. See home-base-qyu1.21.
  if (divergence == null) {
    return {
      disposition: 'review',
      provenSafe: false,
      why: `divergence could not be measured — \`git rev-list --left-right --count ${baselineRef}...${branch.name}\` failed, so how much unique work this branch holds is UNKNOWN and NOTHING about it is proven. Re-run; if it persists, check that both refs resolve (\`git rev-parse ${baselineRef} ${branch.name}\`) and that the objects are intact (\`git fsck\`).`,
    };
  }

  // --- Trivially contained: no unique commits at all -----------------------
  if (divergence.ahead === 0) {
    return {
      disposition: 'merged',
      provenSafe: true,
      why: `no unique commits; fully contained in ${divergence.behind > 0 ? `the baseline (${plural(divergence.behind, 'commit')} behind)` : 'the baseline'}`,
    };
  }

  const mirror = proof?.archiveMirror ?? null;

  // --- UNSAFE CASES FIRST ---------------------------------------------------
  // A stale mirror is the single most dangerous state: it LOOKS like a safe
  // archive and is not. This must be evaluated before any mirror-based
  // reassurance below. And within it, MISSING evidence is checked before stale
  // evidence, because an unmeasurable mirror used to be indistinguishable from
  // a perfect one (home-base-qyu1.22).
  if (mirror?.exists === true) {
    const missing = mirror.commitsMissingFromMirror;

    // UNMEASURED: `countAhead` fabricated 0 here, which read as "the mirror
    // holds everything" — `mirrored`, `provenSafe: true`, and the one plan
    // action that DELETES rather than renames. A mirror whose freshness cannot
    // be measured proves nothing, so it gets `review`, the disposition that
    // exists for incomplete evidence.
    if (missing == null) {
      const against = mirror.unmeasuredAgainst ?? branch.name;
      return {
        disposition: 'review',
        provenSafe: false,
        why: `archive mirror ${mirror.ref} could not be measured — \`git rev-list --count ${mirror.ref}..${against}\` failed, so whether the mirror still holds every commit is UNKNOWN and NOTHING about this branch is proven safe. Re-run; if it persists, check that both refs resolve to present objects (\`git rev-parse ${mirror.ref}^{commit} ${against}^{commit}\`) — a ref can resolve while its object is missing — and that the store is intact (\`git fsck\`).`,
      };
    }

    if (missing > 0) {
      const against =
        mirror.staleAgainst != null ? ` (${mirror.staleAgainst})` : '';
      return {
        disposition: 'review',
        provenSafe: false,
        why: `archive mirror ${mirror.ref} is STALE — ${plural(missing, 'commit')} exist${missing === 1 ? 's' : ''} on the branch${against} that the mirror does not have. Deleting would destroy them.`,
      };
    }
  }

  // --- No content proof computed: stay conservative -------------------------
  if (proof == null) {
    return {
      disposition: 'needs-judgment',
      provenSafe: false,
      why: `${plural(divergence.ahead, 'commit')} ahead; content proof not computed (run with content checking enabled to resolve)`,
    };
  }

  // --- UNREADABLE FILE EVIDENCE: a check that failed is not a check that passed
  // Before BOTH reassuring rules below, for the same reason the divergence rule
  // sits above `ahead === 0`: a verdict list with a hole in it must not be read
  // as a complete one (home-base-qyu1.24). The hole used to be invisible — a
  // deleted path git could not look up on the baseline was recorded as
  // `deletion-reflected`, so the proof came back "every file accounted for".
  //
  // It also outranks `mirrorFullyPreserves`, which is the deliberate part: the
  // mirror comparison is `rev-list`, which walks COMMITS and never opens a tree,
  // so it answers cleanly in exactly the damaged repo that produced this failure
  // and would hand back `provenSafe` off a measurement that cannot see the
  // damage. A branch in a repo whose object store just refused a read is a
  // branch to look at, not one to act on.
  const unreadable = findUnreadableEvidence(proof);
  if (unreadable != null) {
    return {
      disposition: 'review',
      provenSafe: false,
      why: `content proof INCOMPLETE — git could not read \`${unreadable.path}\` on ${unreadable.ref} while checking commit ${unreadable.sha.slice(0, 8)}: \`${unreadable.command}\` failed (${unreadable.detail}). Whether that path is really on ${proof.baselineRef} is UNKNOWN, so NOTHING about this branch is proven. Re-run; if it persists the object store is damaged — \`git fsck\` names the missing object, and a missing TREE is the shape that produces this.`,
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
  if (mirrorFullyPreserves(mirror)) {
    const extra = mirror?.isExact === false ? ' (mirror is ahead of the branch)' : '';
    return {
      disposition: 'mirrored',
      provenSafe: true,
      why: `not on ${proof.baselineRef}, but every commit is preserved in ${mirror?.ref}${extra}`,
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
    why: `${plural(proof.unaccountedCommits.length, 'commit')} not present on ${proof.baselineRef}${mirror?.exists === true ? ` and the ${mirror.ref} mirror does not cover them` : ' and no archive mirror'}${prNote}`,
  };
}
