/**
 * repo-status — the proposed cleanup, and the guarded execution of it.
 *
 * `plan` is a pure function of the report: it proposes, it never touches the
 * repo. `apply` is the only mutating path in the whole tool, and it is
 * deliberately the most paranoid code here.
 *
 * THREE GUARDS, because deleting a branch is irreversible:
 *
 *  1. Only rows the report marked `provenSafe` are ever candidates. A
 *     'review' or 'needs-judgment' row is never actioned, and there is no flag
 *     to override that.
 *  2. Every candidate is RE-PROVEN immediately before deletion. The report may
 *     be seconds or minutes old, and a branch can gain commits in between; a
 *     plan is a proposal, not a licence. A candidate that no longer proves out
 *     is skipped with a reason rather than deleted.
 *  3. V0 deletes LOCAL branches only. Remote branches and worktrees are
 *     surfaced as manual follow-ups: deleting a remote ref is outward-facing
 *     and removing a worktree can discard uncommitted files, neither of which
 *     belongs in an automated pass this young.
 *
 * Part of home-base-qyu1.7.
 */

import {execFileSync} from 'child_process';

import {mirrorFullyPreserves, proveContentOnBaseline} from './content';

import type {BranchRow, RepoStatusReport} from './report';

export interface PlanAction {
  branch: string;
  /** What the action would be. `delete-local-branch` is the only automated one. */
  action: 'delete-local-branch' | 'manual';
  reason: string;
}

export interface CleanupPlan {
  repoRoot: string;
  baselineRef: string;
  /** Proven safe AND automatable — what `apply --safe-only` will act on. */
  safe: PlanAction[];
  /** Proven safe but deliberately left manual (remote refs, worktrees). */
  manual: PlanAction[];
  /** Never automated. Listed so they are visible, not so they are actioned. */
  needsJudgment: PlanAction[];
}

function isAutomatable(row: BranchRow): boolean {
  return row.provenSafe && !row.isRemoteOnly && row.worktree == null;
}

export function buildPlan(report: RepoStatusReport): CleanupPlan {
  const safe: PlanAction[] = [];
  const manual: PlanAction[] = [];
  const needsJudgment: PlanAction[] = [];

  for (const row of report.branches) {
    if (!row.provenSafe) {
      needsJudgment.push({
        action: 'manual',
        branch: row.name,
        reason: row.why,
      });
      continue;
    }
    if (isAutomatable(row)) {
      safe.push({
        action: 'delete-local-branch',
        branch: row.name,
        reason: row.why,
      });
    } else {
      manual.push({
        action: 'manual',
        branch: row.name,
        reason: row.isRemoteOnly
          ? `${row.why} — remote ref; delete it yourself if you want it gone`
          : `${row.why} — checked out at ${row.worktree}; remove the worktree first`,
      });
    }
  }

  return {
    baselineRef: report.repo.baselineRef,
    manual,
    needsJudgment,
    repoRoot: report.repo.root,
    safe,
  };
}

export function renderPlan(plan: CleanupPlan): string {
  const lines: string[] = [
    `# Cleanup plan (dry run) — baseline ${plan.baselineRef}`,
    '',
  ];

  const section = (
    title: string,
    actions: PlanAction[],
    note: string,
  ): void => {
    lines.push(`## ${title} (${actions.length})`);
    if (actions.length === 0) {
      lines.push('  none');
    } else {
      lines.push(`  ${note}`);
      for (const a of actions) lines.push(`  - ${a.branch}: ${a.reason}`);
    }
    lines.push('');
  };

  section(
    'Proven safe — will be deleted by `apply --safe-only --yes`',
    plan.safe,
    'each is re-proven immediately before deletion',
  );
  section(
    'Proven safe, left manual',
    plan.manual,
    'remote refs and checked-out worktrees are never automated',
  );
  section(
    'Needs judgment — NEVER automated',
    plan.needsJudgment,
    'these are the ones actually worth your attention',
  );

  return lines.join('\n').trimEnd();
}

export interface ApplyResult {
  branch: string;
  outcome: 'deleted' | 'skipped' | 'failed';
  reason: string;
}

function gitArgv(argv: string[], cwd: string): {ok: boolean; out: string} {
  try {
    return {
      ok: true,
      out: execFileSync('git', argv, {cwd, encoding: 'utf-8', stdio: 'pipe'}),
    };
  } catch (error) {
    return {
      ok: false,
      out: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Execute the safe group, re-proving each branch first.
 *
 * The re-proof is not ceremony. Between building a plan and running it, a
 * branch can be pushed to, a mirror can fall behind, or another session can
 * move a ref. Proving again against live state — and skipping anything that no
 * longer holds — is what makes "proven safe" mean something at the moment of
 * deletion rather than at the moment of reporting.
 */
export function executePlan(plan: CleanupPlan, cwd: string): ApplyResult[] {
  return plan.safe.map(({branch}): ApplyResult => {
    const proof = proveContentOnBaseline(branch, plan.baselineRef, cwd);
    const mirror = proof.archiveMirror;
    const stillSafe =
      proof.allContentOnBaseline || mirrorFullyPreserves(mirror);

    if (!stillSafe) {
      return {
        branch,
        outcome: 'skipped',
        reason:
          'no longer proves safe against live state — the repo changed since the plan was built',
      };
    }

    // -D rather than -d: our proof is by CONTENT, which is strictly stronger
    // than git's ancestry test and correctly covers squash-merged branches that
    // -d would refuse. The re-proof above is what earns the right to use it.
    const result = gitArgv(['branch', '-D', branch], cwd);
    return result.ok
      ? {
          branch,
          outcome: 'deleted',
          reason: proof.allContentOnBaseline
            ? 'content present on baseline'
            : 'every commit preserved in the archive mirror',
        }
      : {
          branch,
          outcome: 'failed',
          reason: result.out.split('\n')[0] ?? 'git branch -D failed',
        };
  });
}
