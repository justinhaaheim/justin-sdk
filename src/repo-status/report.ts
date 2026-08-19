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

import type {
  BranchDivergence,
  EnumerationFailure,
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
  lastCommitDate: string;
  worktree: string | null;
  disposition: Disposition;
  why: string;
  provenSafe: boolean;
  pr: PrSummary | null;
  archiveMirror: ArchiveMirror | null;
  /** Populated only by the `branch` deep-dive, which is where detail belongs. */
  commits?: CommitVerdict[];
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
  };
  /** Null when the branch listing failed — there is nothing to summarise. */
  summary: RepoStatusSummary | null;
  enrichments: {
    content: boolean;
    prs: boolean;
    prsUnavailableReason: string | null;
    submodules: boolean;
  };
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
    only,
    prs = true,
    sinceDays = null,
    submoduleStores = false,
    submodules = true,
  } = opts;

  const inventory = buildCoreInventory({
    baseline: 'default',
    cwd,
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

  const rows: BranchRow[] | null =
    selected?.map((branch) =>
      buildRow(branch, inventory.baselineRef, cwd, {content, only, prIndex}),
    ) ?? null;

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
      prs: prIndex.available,
      prsUnavailableReason: prIndex.unavailableReason,
      submodules,
    },
    // Emitted only when something actually failed, so a healthy repo's output is
    // byte-for-byte what it was before this key existed.
    ...(inventory.enumerationFailures.length > 0
      ? {enumerationFailures: inventory.enumerationFailures}
      : {}),
    repo: {
      baselineRef: inventory.baselineRef,
      currentBranch: inventory.currentBranch,
      defaultBranch: inventory.defaultBranch,
      root: inventory.repoRoot,
    },
    summary:
      rows == null
        ? null
        : {
            branches: rows.length,
            merged: rows.filter((r) => r.disposition === 'merged').length,
            mirrored: rows.filter((r) => r.disposition === 'mirrored').length,
            needsJudgment: rows.filter((r) => r.disposition === 'needs-judgment')
              .length,
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
  ctx: {content: boolean; only: string | undefined; prIndex: PrIndex},
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

  return {
    ahead: branch.divergence?.ahead ?? null,
    archiveMirror: proof?.archiveMirror ?? null,
    behind: branch.divergence?.behind ?? null,
    ...(ctx.only != null && proof != null
      ? {commits: proof.uniqueCommits}
      : {}),
    disposition,
    isRemoteOnly: branch.isRemoteOnly,
    lastCommitDate: branch.lastCommitDate,
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
    tipSha: branch.tipSha,
    why,
    worktree: branch.worktreePath,
  };
}
