/**
 * repo-status — the proposed cleanup, and the guarded execution of it.
 *
 * `plan` is a pure function of the report: it proposes, it never touches the
 * repo. `apply` is the only mutating path in the whole tool.
 *
 * ── Why apply RENAMES instead of deleting ────────────────────────────────────
 *
 * The obvious design is "prove the branch is redundant, then delete it". That
 * makes the whole tool rest on a judgement call — is patch-id proof enough? is
 * a mirror fresh enough? — where being wrong destroys work permanently.
 *
 * Renaming a branch to `archive/<name>` sidesteps the question entirely. The
 * commits stay reachable under a namespaced ref, the branch list gets clean,
 * and nothing is destroyed even if the disposition engine is wrong. Justin's
 * own reconcile notes reached the same conclusion by hand: "git branch
 * archive/<name> first, then delete the remote."
 *
 * So the disposition no longer decides "is deleting safe" — it decides "is this
 * finished work worth tidying away", which is a far less dangerous thing to be
 * wrong about.
 *
 * Deletion survives in exactly one case: the branch is ALREADY fully preserved
 * in an `archive/*` mirror. Renaming would collide with that mirror, and the
 * commits are already held by it, so removing the redundant copy loses nothing.
 *
 * ── Remaining guards ─────────────────────────────────────────────────────────
 *
 *  1. Only rows the report marked `provenSafe` are candidates. 'review' and
 *     'needs-judgment' are never actioned, and there is no flag to override it.
 *  2. Deletions (the mirrored case only) are RE-PROVEN against live state
 *     immediately before running. A plan is a proposal, not a licence.
 *  3. LOCAL branches only. Renaming a remote branch means pushing a new ref and
 *     deleting the old one — outward-facing, and not something to automate this
 *     early. Worktree-checked-out branches are left alone too.
 *
 * Part of home-base-qyu1.7.
 */

import {execFileSync} from 'child_process';

import {mirrorFullyPreserves, proveContentOnBaseline} from './content';

import type {BranchRow, RepoStatusReport} from './report';

const ARCHIVE_PREFIX = 'archive/';

export type PlanActionKind =
  /** Rename to `archive/<name>`. Non-destructive: every commit stays reachable. */
  | 'archive-local-branch'
  /** Delete. ONLY when an archive/* mirror already holds every commit. */
  | 'delete-local-branch'
  /** Surfaced for a human; never executed. */
  | 'manual';

export interface PlanAction {
  branch: string;
  action: PlanActionKind;
  /** Where the branch ends up, for `archive-local-branch`. */
  target: string | null;
  reason: string;
}

export interface CleanupPlan {
  repoRoot: string;
  baselineRef: string;
  /** What `apply --safe-only` will execute. */
  safe: PlanAction[];
  /** Proven safe but deliberately left manual (remote refs, worktrees). */
  manual: PlanAction[];
  /** Never automated. Listed so they are visible, not so they are actioned. */
  needsJudgment: PlanAction[];
}

function isAutomatable(row: BranchRow): boolean {
  return (
    row.provenSafe &&
    !row.isRemoteOnly &&
    row.worktree == null &&
    !row.name.startsWith(ARCHIVE_PREFIX)
  );
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
        target: null,
      });
      continue;
    }

    if (!isAutomatable(row)) {
      manual.push({
        action: 'manual',
        branch: row.name,
        reason: row.isRemoteOnly
          ? `${row.why} — remote ref; renaming it means pushing a new ref and deleting the old one, so do it yourself`
          : row.name.startsWith(ARCHIVE_PREFIX)
            ? `${row.why} — already under ${ARCHIVE_PREFIX}`
            : `${row.why} — checked out at ${row.worktree}; remove the worktree first`,
        target: null,
      });
      continue;
    }

    // Already mirrored -> the archive holds these commits, so this local branch
    // is a redundant copy and renaming would collide with the mirror.
    if (mirrorFullyPreserves(row.archiveMirror)) {
      safe.push({
        action: 'delete-local-branch',
        branch: row.name,
        reason: `every commit is already preserved in ${row.archiveMirror?.ref}; this local copy is redundant`,
        target: null,
      });
      continue;
    }

    safe.push({
      action: 'archive-local-branch',
      branch: row.name,
      reason: row.why,
      target: `${ARCHIVE_PREFIX}${row.name}`,
    });
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

  // Valid markdown, not markdown-flavoured plain text: a blank line after every
  // heading, the note as its own paragraph rather than an indented orphan, and
  // list items at column 0. The reason each item's detail sits on a continuation
  // line is length — `<branch> -> <target>` plus a full sentence of reasoning on
  // one line wraps badly in a terminal and reads worse in a renderer.
  const section = (
    title: string,
    actions: PlanAction[],
    note: string,
  ): void => {
    lines.push(`## ${title} (${actions.length})`, '');
    if (actions.length === 0) {
      lines.push('None.', '');
      return;
    }
    lines.push(`${note}`, '');
    for (const a of actions) {
      const arrow = a.target != null ? ` → \`${a.target}\`` : '';
      lines.push(`- \`${a.branch}\`${arrow}`, `  ${a.reason}`);
    }
    lines.push('');
  };

  section(
    'Will run under `apply --safe-only --yes`',
    plan.safe,
    'Renames preserve every commit. The only deletions are branches an archive mirror already holds in full.',
  );
  section(
    'Proven safe, left manual',
    plan.manual,
    'Remote refs and checked-out worktrees are never automated.',
  );
  section(
    'Needs judgment — NEVER automated',
    plan.needsJudgment,
    'These are the ones actually worth your attention.',
  );

  return lines.join('\n').trimEnd();
}

export interface ApplyResult {
  branch: string;
  outcome: 'archived' | 'deleted' | 'skipped' | 'failed';
  target: string | null;
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

function refExists(ref: string, cwd: string): boolean {
  const result = gitArgv(['rev-parse', '--verify', '--quiet', ref], cwd);
  return result.ok && result.out.trim().length > 0;
}

/**
 * Execute the safe group.
 *
 * Renames are non-destructive and need no re-proof — the commits survive under
 * the new name whatever the disposition engine concluded. They are still
 * guarded against clobbering an existing ref.
 *
 * Deletions DO get re-proven against live state, because that is the one path
 * where being stale could destroy something: between building the plan and
 * running it, a mirror can fall behind or a branch can gain commits.
 */
export function executePlan(plan: CleanupPlan, cwd: string): ApplyResult[] {
  return plan.safe.map((action): ApplyResult => {
    const {branch, target} = action;

    if (action.action === 'archive-local-branch') {
      if (target == null) {
        return {branch, outcome: 'failed', reason: 'no archive target', target};
      }
      if (refExists(target, cwd)) {
        return {
          branch,
          outcome: 'skipped',
          reason: `${target} already exists — refusing to clobber it`,
          target,
        };
      }
      const result = gitArgv(['branch', '-m', branch, target], cwd);
      return result.ok
        ? {branch, outcome: 'archived', reason: action.reason, target}
        : {
            branch,
            outcome: 'failed',
            reason: result.out.split('\n')[0] ?? 'git branch -m failed',
            target,
          };
    }

    // Deletion: only ever the already-mirrored case, and only after re-proving.
    const proof = proveContentOnBaseline(branch, plan.baselineRef, cwd);
    if (!mirrorFullyPreserves(proof.archiveMirror)) {
      return {
        branch,
        outcome: 'skipped',
        reason:
          'the archive mirror no longer holds every commit — the repo changed since the plan was built',
        target: null,
      };
    }

    // -D rather than -d: the mirror provably holds these commits, which is a
    // stronger guarantee than git's ancestry test and covers squash-merged
    // branches -d would refuse. The re-proof above earns the right to use it.
    const result = gitArgv(['branch', '-D', branch], cwd);
    return result.ok
      ? {
          branch,
          outcome: 'deleted',
          reason: `redundant copy; ${proof.archiveMirror?.ref} holds every commit`,
          target: null,
        }
      : {
          branch,
          outcome: 'failed',
          reason: result.out.split('\n')[0] ?? 'git branch -D failed',
          target: null,
        };
  });
}
