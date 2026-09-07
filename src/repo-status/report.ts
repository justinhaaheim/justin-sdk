/**
 * repo-status — assembling the one typed object every renderer consumes.
 *
 * The typed-object-in-the-middle rule: a command computes ONE schema'd object
 * and only then renders it. Nothing assembles output-shaped data directly. That
 * is what keeps YAML, `--json` and the prime injection on a single consistent
 * schema instead of three drifting ones.
 *
 * State is computed fresh on every invocation. There is deliberately no
 * "build an artifact, then inspect the artifact" mode: an artifact goes stale
 * between write and read, and it pushes a token-stingy reader toward writing
 * bespoke jq against a blob whose schema it has to relearn each time. The
 * inspection logic lives here, WITH the schema.
 *
 * Part of home-base-qyu1.1 / qyu1.4.
 */

import {buildCoreInventory} from '../plugin/lib/repo-status/core';
import {
  proveContentOnBaseline,
  type ArchiveMirror,
  type CommitVerdict,
} from './content';
import {decideDisposition, type Disposition} from './disposition';
import {describeMergeShape, type MergeShape} from './merge-shape';
import {previewMerge, type MergePreview} from './merge-preview';
import {
  buildOverlaps,
  OVERLAPS_NOT_RUN,
  readChangedFiles,
  type ChangedFileSet,
  type OverlapReport,
} from './overlap';
import {
  EMPTY_PR_INDEX,
  fetchPullRequests,
  prForBranch,
  type PrIndex,
} from '../plugin/lib/repo-status/prs';
import {
  buildSubmoduleInventory,
  EMPTY_SUBMODULE_INVENTORY,
  type SubmoduleInventory,
} from './submodules';
import {readLastWork, type LastWork} from './last-work';
import {
  readUpstreamDivergence,
  readWorktreeState,
  readWorktreeStates,
  type WorktreeState,
} from './worktree-state';

import type {
  BranchDivergence,
  EnumerationFailure,
  FilterSummary,
  WorktreeEntry,
} from '../plugin/lib/repo-status/types';

export interface PrSummary {
  number: number;
  state: string;
  isDraft: boolean;
  baseRefName: string;
  url: string;
}

export interface BranchRow {
  name: string;
  isRemoteOnly: boolean;
  /**
   * The tip commit. Carried through from the core inventory so a plan can PIN
   * the exact commit it proved rather than re-resolving a ref later and
   * silently acting on whatever it has become by then.
   */
  tipSha: string;
  /**
   * Kept because it is the standard metric and reads fine — but see `why`.
   *
   * BOTH ARE NULL when the divergence could not be measured (home-base-
   * qyu1.21), which is a different statement from `0`: zero means "measured,
   * and there is nothing here", null means "no measurement exists". Such a row
   * is always `disposition: review` with `provenSafe: false`, and its
   * `mergeShape.kind` is `unknown`.
   *
   * They stay two flat fields on the published row — rather than the nullable
   * `divergence` object the core inventory carries — because these are the
   * documented top-level keys every reader of the YAML/JSON already looks for,
   * and re-nesting them would break that schema for every consumer to restate
   * a fact `mergeShape` and `why` already carry.
   */
  ahead: number | null;
  behind: number | null;
  /**
   * What those two numbers already prove about merging this branch into the
   * baseline: fast-forward, real merge commit, or nothing to do.
   *
   * Always present, on every row including `merged` and `mirrored` ones. It is a
   * sha-reachability fact, orthogonal to the content-based `disposition`, and
   * the rows where the two disagree are the informative ones — a squash-merged
   * branch is `merged` yet cannot be fast-forwarded. Derived arithmetically from
   * `ahead`/`behind`; it costs no git invocation, and reports `unknown` when
   * those two numbers do not exist. See `merge-shape.ts`.
   */
  mergeShape: MergeShape;
  /**
   * Whether the merge `mergeShape` describes would actually APPLY, and which
   * files break if not. Null when there was nothing to preview — no unique
   * commits, an unmeasured divergence, or the enrichment switched off — which
   * is a different statement from `kind: 'clean'`. See `merge-preview.ts`.
   */
  mergePreview: MergePreview | null;
  /**
   * How many files this branch changed relative to its merge base with the
   * baseline — the cheapest available proxy for how big a merge this is. Null
   * when not computed or not readable; the LIST lives on `changedFiles`, and
   * only in the `branch` deep-dive.
   */
  changedFileCount: number | null;
  lastCommitDate: string;
  /**
   * The newest commit the branch has that the baseline does not, EXCLUDING
   * merges — the last time somebody actually did work here.
   *
   * `lastCommitDate` alone misled every blind reviewer of this report in the
   * same way (2026-09-07): merging main into a dormant branch updates its tip,
   * so a branch whose real work stopped weeks ago shows today's date and reads
   * as live. Both are kept because they answer different questions — "when did
   * this ref last move" and "when was this branch last advanced" — and it is
   * the gap between them that identifies a branch somebody is maintaining
   * without progressing.
   *
   * Null when the branch has no unique commits, or when it was not computed.
   */
  lastWork: {date: string; sha: string; subject: string} | null;
  worktree: string | null;
  /**
   * Uncommitted work in this branch's checkout. Null when the branch has no
   * worktree, or when the enrichment was off.
   *
   * The merged group's "nothing to lose" reading depends entirely on this: it
   * is a claim about a working tree, and until this field existed it was made
   * without looking at one.
   */
  worktreeState: WorktreeState | null;
  /**
   * Where else this branch exists. Null means NO remote has it — the branch is
   * on this disk only, and losing the disk loses the work.
   */
  remote: {inSync: boolean; ref: string; sha: string} | null;
  disposition: Disposition;
  why: string;
  provenSafe: boolean;
  pr: PrSummary | null;
  archiveMirror: ArchiveMirror | null;
  /** Populated only by the `branch` deep-dive, which is where detail belongs. */
  commits?: CommitVerdict[];
  /** Same: the full changed-file list is deep-dive detail, not ledger material. */
  changedFiles?: string[];
}

export interface RepoStatusSummary {
  branches: number;
  merged: number;
  mirrored: number;
  review: number;
  needsJudgment: number;
  provenSafe: number;
}

/**
 * The whole ledger.
 *
 * `branches`, `summary` and `worktrees` are NULL when the underlying `git
 * for-each-ref` / `git worktree list` could not be read (home-base-qyu1.23).
 * They are nullable rather than empty-on-failure because every one of them is
 * read as a claim: no branches means "nothing unmerged anywhere", a summary of
 * zeroes means "nothing to review", and no worktrees means "no branch is checked
 * out, so archiving is unobstructed". Emitting those over a repo git could not
 * read is the failure this schema exists to prevent — and typing them nullable
 * is what forces each consumer to say what it does about it instead of
 * inheriting an empty array by accident.
 *
 * `enumerationFailures` is present ONLY when something failed, and carries the
 * detail (which command, what is unknown, how to diagnose). The nulls are the
 * load-bearing signal; this key is the explanation, so nothing depends on a
 * reader noticing an absent key.
 */
export interface RepoStatusReport {
  repo: {
    root: string;
    currentBranch: string | null;
    defaultBranch: string | null;
    baselineRef: string;
    /**
     * The state of the checkout the caller is standing in.
     *
     * The report described every branch except the one under the reader's feet
     * — including that it had unpushed commits and uncommitted files. Three
     * blind reviews independently ranked this the most important omission
     * (2026-09-07).
     */
    here: {
      /** Uncommitted work right here. Null when not inspected. */
      state: WorktreeState | null;
      /** Divergence from this branch's upstream. Null when there is none. */
      upstream: {ahead: number; behind: number; ref: string} | null;
    } | null;
  };
  /** Null when the branch listing failed — there is nothing to summarise. */
  summary: RepoStatusSummary | null;
  enrichments: {
    content: boolean;
    prs: boolean;
    prsUnavailableReason: string | null;
    submodules: boolean;
    mergePreview: boolean;
    overlaps: boolean;
    /**
     * Whether working trees were inspected. False means every "nothing to lose"
     * reading in this report is about COMMITS only, which the renderer has to
     * say rather than let the reader assume.
     */
    worktreeState: boolean;
  };
  /**
   * What the walk DROPPED before `branches` was built. Always present, so a
   * short ledger can never be mistaken for a small repo (home-base-qyu1.33.1).
   */
  filtered: FilterSummary;
  /**
   * Which of the branches above are in each other's way. Every count is null
   * when the enrichment did not run, so "no overlaps" and "did not look" stay
   * distinguishable.
   */
  overlaps: OverlapReport;
  enumerationFailures?: EnumerationFailure[];
  /** Null when `git worktree list` failed — NOT the same as "no worktrees". */
  worktrees: WorktreeEntry[] | null;
  /** Null when `git for-each-ref` failed — NOT the same as "no branches". */
  branches: BranchRow[] | null;
  submodules: SubmoduleInventory;
}

export interface ReportOptions {
  cwd: string;
  /** Run the per-commit content proofs. Local but heavy. */
  content?: boolean;
  /** Query GitHub for PR state. Network. Independent of `content`. */
  prs?: boolean;
  /**
   * Inspect submodule gitlink state. Local and cheap, and independent of both
   * `content` and `prs`. The `prime` session-start path never calls
   * `buildReport` at all, so this costs it nothing whatever it is set to.
   */
  submodules?: boolean;
  /**
   * Open EVERY worktree's submodule object store rather than just the current
   * one. Off by default because it is the only part that reaches outside the
   * worktree being inspected; on, it answers the work-at-risk question per
   * store, which is what catches commits that `git worktree remove` would eat.
   */
  submoduleStores?: boolean;
  /** Age gate; null keeps every branch however old (what reconcile wants). */
  sinceDays?: number | null;
  /**
   * Drop `archive/*` mirrors from the ledger. They are finished work a previous
   * reconcile already dealt with, and in a repo that has been reconciled a few
   * times they are most of the rows. Off by default here so `plan`/`apply` — the
   * callers that must see every branch — get the full set without asking.
   */
  excludeArchive?: boolean;
  /**
   * Run `git merge-tree` per branch with unique work: one cheap local call each
   * (~0.1s), answering whether the merge applies cleanly.
   */
  mergePreview?: boolean;
  /**
   * Read each candidate's changed-file set and cross-compare them. Populates
   * `changedFileCount` on every row with unique work AND the `overlaps` section.
   * Linear in branches, plus a capped number of pairwise merges.
   */
  overlaps?: boolean;
  /** Max pairs to merge-check after the shared-file screen. */
  pairCap?: number;
  /**
   * Run `git status` in every checkout, so "nothing to lose" is a claim about a
   * working tree rather than only about commits. One call per worktree.
   */
  worktreeState?: boolean;
  /** Restrict to one branch (the `branch <name>` deep-dive). */
  only?: string;
}

const DISPOSITION_ORDER: Disposition[] = [
  'needs-judgment',
  'review',
  'mirrored',
  'merged',
];

export function buildReport(opts: ReportOptions): RepoStatusReport | null {
  const {
    content = true,
    cwd,
    excludeArchive = false,
    mergePreview = true,
    only,
    overlaps = true,
    pairCap,
    prs = true,
    sinceDays = null,
    submoduleStores = false,
    submodules = true,
    worktreeState = true,
  } = opts;

  const inventory = buildCoreInventory({
    baseline: 'default',
    cwd,
    excludeArchive,
    sinceDays,
  });
  if (inventory == null) return null;

  const prIndex: PrIndex = prs ? fetchPullRequests({cwd}) : EMPTY_PR_INDEX;

  const selected =
    only != null
      ? inventory.branches?.filter(
          (b) => b.name === only || b.name === `origin/${only}`,
        )
      : inventory.branches;

  // `selected`, not `inventory.branches`: the per-branch gitlink audit is a
  // claim about the branch rows this report actually carries, so it must be
  // computed over exactly those rows and no others. When the branch listing
  // failed there are no such rows, and `branches: undefined` is how this module
  // says NOT CHECKED — passing `[]` instead would make it report that it
  // compared every branch and they all agreed.
  const submoduleInventory = submodules
    ? buildSubmoduleInventory({
        allWorktreeStores: submoduleStores,
        baselineRef: inventory.baselineRef,
        branches: selected ?? undefined,
        cwd,
        repoRoot: inventory.repoRoot,
        worktrees: inventory.worktrees,
      })
    : EMPTY_SUBMODULE_INVENTORY;

  // Changed-file sets are read ONCE and then used twice — for each row's
  // `changedFileCount` and for the pairwise intersection. Reading them per
  // consumer would double the git calls to answer the same question.
  //
  // Only branches with unique work get one: a branch with `ahead === 0` has no
  // footprint of its own to compare, and one with an unmeasured divergence has
  // already failed the walk this would repeat.
  const changedByBranch = new Map<string, ChangedFileSet>();
  if (overlaps) {
    for (const branch of selected ?? []) {
      if (branch.divergence == null || branch.divergence.ahead === 0) continue;
      changedByBranch.set(
        branch.name,
        readChangedFiles(inventory.baselineRef, branch.name, cwd),
      );
    }
  }

  // One `git status` per CHECKOUT, not per branch — several branches can share
  // none and no worktree is inspected twice.
  const worktreeStates = worktreeState
    ? readWorktreeStates((inventory.worktrees ?? []).map((w) => w.path))
    : new Map();

  // Submodule paths for the merge preview's gitlink check. Taken from the
  // inventory that was already built, so this costs nothing; when submodules
  // were not inspected the preview is told so and reports the check as not run
  // rather than as "no submodule moved".
  const submodulePaths = submodules
    ? submoduleInventory.entries.map((e) => e.path)
    : [];

  const rows: BranchRow[] | null =
    selected?.map((branch) =>
      buildRow(branch, inventory.baselineRef, cwd, {
        changed: changedByBranch.get(branch.name) ?? null,
        content,
        // Only branches with unique work have a "last work" to find; on the rest
        // the answer is empty by construction and the call would be wasted.
        lastWork:
          branch.divergence != null && branch.divergence.ahead > 0
            ? readLastWork(inventory.baselineRef, branch.name, cwd)
            : null,
        mergePreview,
        only,
        prIndex,
        submodulePaths,
        worktreeState:
          branch.worktreePath != null
            ? (worktreeStates.get(branch.worktreePath) ?? null)
            : null,
      }),
    ) ?? null;

  // Pairs are built from the rows this report actually SHOWS, so the overlap
  // section is a claim about the ledger above it rather than about some larger
  // set the reader cannot see. A null `rows` means there was no set to compare,
  // which `OVERLAPS_NOT_RUN` states without implying agreement.
  const overlapReport: OverlapReport =
    overlaps && rows != null
      ? buildOverlaps(
          rows
            // OPEN work only. Justin's question is about the branches still in
            // flight; a `merged` (squash-merged) or `mirrored` row is finished,
            // and pairing it against a live branch restates what that row's own
            // `mergePreview` already said, at the cost of a merge-tree run.
            .filter(
              (r) =>
                r.disposition === 'needs-judgment' ||
                r.disposition === 'review',
            )
            .filter((r) => changedByBranch.has(r.name))
            .map((r) => ({
              changed: changedByBranch.get(r.name) as ChangedFileSet,
              lastCommitDate: r.lastCommitDate,
              name: r.name,
            })),
          {cwd, pairCap},
        )
      : OVERLAPS_NOT_RUN;

  rows?.sort((a, b) => {
    const d =
      DISPOSITION_ORDER.indexOf(a.disposition) -
      DISPOSITION_ORDER.indexOf(b.disposition);
    if (d !== 0) return d;
    // An unmeasured row sorts as if it were the largest possible ahead-count:
    // within its group it is the row most likely to be hiding work, so it goes
    // to the top rather than to the bottom where a `0` would have put it.
    const aheadRank = (r: BranchRow): number =>
      r.ahead ?? Number.MAX_SAFE_INTEGER;
    if (aheadRank(a) !== aheadRank(b)) return aheadRank(b) - aheadRank(a);
    return b.lastCommitDate.localeCompare(a.lastCommitDate);
  });

  return {
    branches: rows,
    enrichments: {
      content,
      mergePreview,
      overlaps,
      prs: prIndex.available,
      prsUnavailableReason: prIndex.unavailableReason,
      submodules,
      worktreeState,
    },
    // Emitted only when something actually failed, so a healthy repo's output is
    // byte-for-byte what it was before this key existed.
    ...(inventory.enumerationFailures.length > 0
      ? {enumerationFailures: inventory.enumerationFailures}
      : {}),
    filtered: inventory.filtered,
    overlaps: overlapReport,
    repo: {
      baselineRef: inventory.baselineRef,
      currentBranch: inventory.currentBranch,
      defaultBranch: inventory.defaultBranch,
      here: {
        state: worktreeState ? readWorktreeState(cwd) : null,
        upstream:
          inventory.currentBranch != null
            ? readUpstreamDivergence(inventory.currentBranch, cwd)
            : null,
      },
      root: inventory.repoRoot,
    },
    summary:
      rows == null
        ? null
        : {
            branches: rows.length,
            merged: rows.filter((r) => r.disposition === 'merged').length,
            mirrored: rows.filter((r) => r.disposition === 'mirrored').length,
            needsJudgment: rows.filter(
              (r) => r.disposition === 'needs-judgment',
            ).length,
            provenSafe: rows.filter((r) => r.provenSafe).length,
            review: rows.filter((r) => r.disposition === 'review').length,
          },
    submodules: submoduleInventory,
    worktrees: inventory.worktrees,
  };
}

function buildRow(
  branch: BranchDivergence,
  baselineRef: string,
  cwd: string,
  ctx: {
    changed: ChangedFileSet | null;
    content: boolean;
    lastWork: LastWork | null;
    mergePreview: boolean;
    only: string | undefined;
    prIndex: PrIndex;
    submodulePaths: string[];
    worktreeState: WorktreeState | null;
  },
): BranchRow {
  // Skip the expensive proof when the branch has nothing unique — there is
  // nothing for it to prove, and on a large repo that is most of the work.
  //
  // Skip it too when the divergence is UNKNOWN, which is a different reason:
  // the proof enumerates "commits the baseline lacks" by walking the same
  // history with the same git that just failed to walk it, so whatever it
  // returned would describe an unknown subset of the branch. The disposition
  // engine refuses such a row before reading any proof anyway (qyu1.21); not
  // computing one keeps the row from carrying evidence nobody may rely on.
  const proof =
    ctx.content && branch.divergence != null && branch.divergence.ahead > 0
      ? proveContentOnBaseline(branch.name, baselineRef, cwd)
      : null;

  const pr = prForBranch(ctx.prIndex, branch.name);
  const {disposition, provenSafe, why} = decideDisposition({
    baselineRef,
    branch,
    pr,
    prDataAvailable: ctx.prIndex.available,
    proof,
  });

  // Same gate as the proof, for the same two reasons: a branch with no unique
  // commits has nothing to merge, and one with an unmeasured divergence would
  // be previewed by the same git that just failed to walk it. `null` here means
  // NOT PREVIEWED, which is deliberately not expressible as `kind: 'clean'`.
  const preview =
    ctx.mergePreview && branch.divergence != null && branch.divergence.ahead > 0
      ? previewMerge(baselineRef, branch.name, cwd, {
          submodulePaths: ctx.submodulePaths,
        })
      : null;

  return {
    ahead: branch.divergence?.ahead ?? null,
    archiveMirror: proof?.archiveMirror ?? null,
    behind: branch.divergence?.behind ?? null,
    // A branch with no unique commits has no unique footprint either: its merge
    // base with the baseline IS its tip, so the diff is empty. Deriving the 0
    // rather than leaving the cell blank costs no git call and keeps "measured
    // zero" distinguishable from "not measured", which a blank is not.
    changedFileCount:
      ctx.changed?.count ?? (branch.divergence?.ahead === 0 ? 0 : null),
    ...(ctx.only != null && ctx.changed?.files != null
      ? {changedFiles: ctx.changed.files}
      : {}),
    ...(ctx.only != null && proof != null
      ? {commits: proof.uniqueCommits}
      : {}),
    disposition,
    isRemoteOnly: branch.isRemoteOnly,
    lastCommitDate: branch.lastCommitDate,
    lastWork: ctx.lastWork,
    mergePreview: preview,
    mergeShape: describeMergeShape(branch.divergence, baselineRef),
    name: branch.name,
    pr:
      pr != null
        ? {
            baseRefName: pr.baseRefName,
            isDraft: pr.isDraft,
            number: pr.number,
            state: pr.state,
            url: pr.url,
          }
        : null,
    provenSafe,
    remote: branch.remote,
    tipSha: branch.tipSha,
    why,
    worktree: branch.worktreePath,
    worktreeState: ctx.worktreeState,
  };
}
