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

import {buildCoreInventory} from './core';
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
} from './prs';
import {
  buildSubmoduleInventory,
  EMPTY_SUBMODULE_INVENTORY,
  type SubmoduleInventory,
} from './submodules';

import type {BranchDivergence, WorktreeEntry} from './types';

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
  /** Kept because it is the standard metric and reads fine — but see `why`. */
  ahead: number;
  behind: number;
  /**
   * What those two numbers already prove about merging this branch into the
   * baseline: fast-forward, real merge commit, or nothing to do.
   *
   * Always present, on every row including `merged` and `mirrored` ones. It is a
   * sha-reachability fact, orthogonal to the content-based `disposition`, and
   * the rows where the two disagree are the informative ones — a squash-merged
   * branch is `merged` yet cannot be fast-forwarded. Derived arithmetically from
   * `ahead`/`behind`; it costs no git invocation. See `merge-shape.ts`.
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

export interface RepoStatusReport {
  repo: {
    root: string;
    currentBranch: string | null;
    defaultBranch: string | null;
    baselineRef: string;
  };
  summary: {
    branches: number;
    merged: number;
    mirrored: number;
    review: number;
    needsJudgment: number;
    provenSafe: number;
  };
  enrichments: {
    content: boolean;
    prs: boolean;
    prsUnavailableReason: string | null;
    submodules: boolean;
  };
  worktrees: WorktreeEntry[];
  branches: BranchRow[];
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

  const submoduleInventory = submodules
    ? buildSubmoduleInventory({
        allWorktreeStores: submoduleStores,
        cwd,
        repoRoot: inventory.repoRoot,
        worktrees: inventory.worktrees,
      })
    : EMPTY_SUBMODULE_INVENTORY;

  const selected =
    only != null
      ? inventory.branches.filter(
          (b) => b.name === only || b.name === `origin/${only}`,
        )
      : inventory.branches;

  const rows: BranchRow[] = selected.map((branch) =>
    buildRow(branch, inventory.baselineRef, cwd, {content, only, prIndex}),
  );

  rows.sort((a, b) => {
    const d =
      DISPOSITION_ORDER.indexOf(a.disposition) -
      DISPOSITION_ORDER.indexOf(b.disposition);
    if (d !== 0) return d;
    if (a.ahead !== b.ahead) return b.ahead - a.ahead;
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
    repo: {
      baselineRef: inventory.baselineRef,
      currentBranch: inventory.currentBranch,
      defaultBranch: inventory.defaultBranch,
      root: inventory.repoRoot,
    },
    summary: {
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
  const proof =
    ctx.content && branch.ahead > 0
      ? proveContentOnBaseline(branch.name, baselineRef, cwd)
      : null;

  const pr = prForBranch(ctx.prIndex, branch.name);
  const {disposition, provenSafe, why} = decideDisposition({
    branch,
    pr,
    prDataAvailable: ctx.prIndex.available,
    proof,
  });

  return {
    ahead: branch.ahead,
    archiveMirror: proof?.archiveMirror ?? null,
    behind: branch.behind,
    ...(ctx.only != null && proof != null
      ? {commits: proof.uniqueCommits}
      : {}),
    disposition,
    isRemoteOnly: branch.isRemoteOnly,
    lastCommitDate: branch.lastCommitDate,
    mergeShape: describeMergeShape(branch, baselineRef),
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
