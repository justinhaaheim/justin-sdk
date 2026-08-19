/**
 * repo-status core — the cheap, always-on inventory.
 *
 * One `git worktree list`, one `git for-each-ref`, and one `git rev-list` per
 * candidate branch. Local refs only: this NEVER fetches and NEVER shells out to
 * `gh`, so it is safe on the `prime` SessionStart hot path.
 *
 * This is the single implementation of the branch/worktree walk. It grew out of
 * `project-prime`, which needed exactly this data to surface unmerged work at
 * session start; reconcile needs the same walk plus enrichments. Keeping two
 * copies was the thing worth avoiding (home-base-qyu1.11).
 *
 * REF-NAME SAFETY. Every call that embeds a branch name goes through
 * `gitArgv` (execFileSync, argv form) rather than a shell string. A ref like
 * `feature$(true)rest` is legal in git and would otherwise be interpolated by
 * the shell, silently resolving to nothing and reporting 0 commits ahead —
 * i.e. "this branch is safe to delete" about a branch that is not. There is a
 * regression test for exactly this.
 */

import {execFileSync} from 'child_process';

import type {
  BranchDivergence,
  BranchTip,
  CoreInventory,
  CoreOptions,
  DivergenceCounts,
  EnumerationFailure,
  WorktreeEntry,
} from './types';

const DEFAULT_SINCE_DAYS = 30;

// ---------------------------------------------------------------------------
// git plumbing
// ---------------------------------------------------------------------------

/** Run git with argv (never a shell string), returning null on any failure. */
function gitArgv(argv: string[], cwd: string): string | null {
  try {
    return execFileSync('git', argv, {cwd, encoding: 'utf-8', stdio: 'pipe'});
  } catch {
    return null;
  }
}

/**
 * Characters a shell leaves alone, so an argv element made only of them prints
 * bare. `--format=%(refname) %(objectname) …` is not one of those.
 */
const SHELL_SAFE_ARG = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * An argv array as the command line that reproduces it, quoted where a shell
 * would otherwise mangle it — so a reported failure can be pasted and re-run.
 *
 * Deliberately a LOCAL copy of the same idea in `plan.ts` rather than an import:
 * `plan.ts` imports `report.ts` which imports this file, so reaching the other
 * way would close a cycle (`submodules.ts` keeps its own `gitArgv` for the same
 * reason). The two also serve different purposes — plan.ts renders commands a
 * reader APPROVES and `apply` then executes, so its rendering is drift-tested
 * against the argv git actually receives; this one renders a command that has
 * ALREADY failed, for a human to reproduce.
 */
function renderGitCommand(argv: string[]): string {
  const quote = (arg: string): string =>
    SHELL_SAFE_ARG.test(arg)
      ? arg
      : `'${arg.split("'").join(`'\\''`)}'`;
  return ['git', ...argv.map(quote)].join(' ');
}

export function getRepoRoot(cwd: string): string | null {
  return gitArgv(['rev-parse', '--show-toplevel'], cwd)?.trim() ?? null;
}

export function getCurrentBranch(cwd: string): string | null {
  const out = gitArgv(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)?.trim();
  return out != null && out.length > 0 && out !== 'HEAD' ? out : null;
}

function refExists(name: string, cwd: string): boolean {
  return gitArgv(['rev-parse', '--verify', '--quiet', name], cwd) != null;
}

/**
 * The repo's default branch. Prefers what the remote actually says
 * (`origin/HEAD`), then falls back to the conventional names. Returns null
 * rather than guessing when neither exists — a wrong baseline would silently
 * skew every ahead/behind number in the report.
 */
export function detectDefaultBranch(cwd: string): string | null {
  const symbolic = gitArgv(
    ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
    cwd,
  )?.trim();
  if (symbolic != null && symbolic.length > 0) {
    // "origin/main" -> "main"
    const short = symbolic.slice(symbolic.indexOf('/') + 1);
    if (refExists(short, cwd)) return short;
    if (refExists(symbolic, cwd)) return symbolic;
  }
  for (const candidate of ['main', 'master']) {
    if (refExists(candidate, cwd)) return candidate;
  }
  return null;
}

const WORKTREE_LIST_ARGV = ['worktree', 'list', '--porcelain'];

const BRANCH_TIPS_ARGV = [
  'for-each-ref',
  '--format=%(refname) %(objectname) %(committerdate:iso-strict)',
  'refs/heads',
  'refs/remotes',
];

/**
 * What is not known when a listing fails, in the terms a reader has to act on.
 *
 * Written HERE, next to the commands, so the session-start prose, the `status`
 * object and the plan's refusals all quote one description rather than three
 * that can drift (home-base-qyu1.23).
 */
export const ENUMERATION_FAILURES: Record<
  'branches' | 'worktrees',
  EnumerationFailure
> = {
  branches: {
    command: renderGitCommand(BRANCH_TIPS_ARGV),
    diagnose:
      'run the command above to see git\'s own error, then `git fsck --no-progress` — the listing must parse EVERY ref tip, so one unreadable object anywhere fails it for the entire repo',
    what: 'branches',
    why: 'no branch could be listed at all, so an empty branch inventory here means NOTHING COULD BE READ — not that the repo has no branches; unmerged work may exist on any number of them',
  },
  worktrees: {
    command: renderGitCommand(WORKTREE_LIST_ARGV),
    diagnose:
      "run the command above to see git's own error; `git worktree prune` clears a stale administrative entry",
    what: 'worktrees',
    why: 'the repo\'s checkouts could not be listed, so NO branch can be said to be free of a worktree — one that is actually checked out reads as unattached, and `git branch -m` on a checked-out branch SUCCEEDS and silently retargets that worktree\'s HEAD rather than refusing',
  },
};

/**
 * Every checked-out tree of this repo — or NULL when git could not say.
 *
 * FAILURE IS NOT "NONE" (home-base-qyu1.23). This returned `[]` on failure, and
 * an empty list is read downstream as "no branch is checked out anywhere", which
 * is the precondition for archiving a branch. Renaming a branch that IS checked
 * out is not blocked by git — verified: `git branch -m` succeeds and moves the
 * live worktree's HEAD onto the new name — so nothing further down would have
 * caught the substitution either.
 */
export function getWorktrees(cwd: string): WorktreeEntry[] | null {
  const out = gitArgv(WORKTREE_LIST_ARGV, cwd);
  if (out == null) return null;

  const entries: WorktreeEntry[] = [];
  let path: string | null = null;
  let branch: string | null = null;

  const flush = (): void => {
    if (path == null) return;
    // `git worktree list` always emits the primary worktree first.
    entries.push({branch, isPrimary: entries.length === 0, path});
  };

  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush();
      path = line.slice('worktree '.length).trim();
      branch = null;
    } else if (line.startsWith('branch ')) {
      branch = line.slice('branch '.length).replace('refs/heads/', '').trim();
    }
  }
  flush();
  return entries;
}

/**
 * All local + remote branch tips, deduped: a remote branch that merely mirrors
 * an identically-named local branch is dropped in favour of the local one. NULL
 * when the listing failed.
 *
 * FAILURE IS NOT "NO BRANCHES" (home-base-qyu1.23). This returned `[]` on
 * failure, which produced an inventory with zero branches — and the session-start
 * view renders zero branches as "no unmerged work on any other branch or
 * worktree", the exact all-clear this module exists to avoid printing falsely.
 * The trigger is not exotic: `%(committerdate:iso-strict)` has to parse every
 * tip commit, so a SINGLE missing object behind ANY ref fails the command for
 * the whole repo (proven in the qyu1.22 suite, where the whole inventory went
 * empty from one destroyed object).
 *
 * `worktrees` is nullable for the same reason. A null there is not treated as
 * "no worktrees": no tip gets a `worktreePath`, and the caller records the
 * enumeration failure so the unknown-ness travels with the inventory rather than
 * being silently spelled as `worktreePath: null` on every row.
 */
export function getBranchTips(
  cwd: string,
  worktrees: WorktreeEntry[] | null,
): BranchTip[] | null {
  const out = gitArgv(BRANCH_TIPS_ARGV, cwd);
  if (out == null) return null;

  const worktreeByBranch = new Map(
    (worktrees ?? [])
      .filter((w) => w.branch != null)
      .map((w) => [w.branch as string, w.path]),
  );

  const local = new Map<string, BranchTip>();
  const remote: BranchTip[] = [];

  for (const line of out.trim().split('\n')) {
    if (line.length === 0) continue;
    const match = /^(\S+) (\S+) (\S+)$/.exec(line);
    if (match == null) continue;
    const [, refname, tipSha, lastCommitDate] = match;
    if (refname == null || tipSha == null || lastCommitDate == null) continue;

    if (refname.startsWith('refs/heads/')) {
      const name = refname.slice('refs/heads/'.length);
      local.set(name, {
        isRemoteOnly: false,
        lastCommitDate,
        name,
        tipSha,
        worktreePath: worktreeByBranch.get(name) ?? null,
      });
    } else if (refname.startsWith('refs/remotes/')) {
      const short = refname.slice('refs/remotes/'.length);
      if (short.endsWith('/HEAD')) continue; // symbolic ref, not a real branch
      const withoutRemote = short.slice(short.indexOf('/') + 1);
      remote.push({
        isRemoteOnly: !local.has(withoutRemote),
        lastCommitDate,
        name: short,
        tipSha,
        worktreePath: null,
      });
    }
  }

  return [...local.values(), ...remote.filter((r) => r.isRemoteOnly)];
}

/**
 * Commits each side has that the other lacks, in ONE call — or null when that
 * call could not answer.
 *
 * `A...B` (three dots) with `--left-right --count` yields "<only-in-A>
 * <only-in-B>". Note this is the symmetric-difference form; the two-dot `A..B`
 * form answers a different question and is the source of a well-known
 * misreading when a branch is far behind its baseline.
 *
 * FAILURE IS NOT ZERO (home-base-qyu1.21). This returned `{ahead: 0, behind: 0}`
 * on any git failure — an unresolvable baseline, a gc/lock race, a missing
 * object — and `ahead === 0` is the disposition engine's strongest possible
 * statement: "nothing unique here, proven safe to delete". `rev-parse` on the
 * tip can keep succeeding while this walk fails, so the pre-flight guards in
 * `plan.ts` cannot catch the substitution either. A branch whose divergence
 * cannot be measured must report exactly that, all the way to the verdict.
 *
 * Unparseable output is treated identically: git answering something this
 * cannot read is no more informative than git not answering at all, and
 * coercing it to 0 was the same fabrication in miniature.
 */
export function countDivergence(
  cwd: string,
  baseline: string,
  branch: string,
): DivergenceCounts | null {
  const out = gitArgv(
    ['rev-list', '--left-right', '--count', `${baseline}...${branch}`],
    cwd,
  );
  if (out == null) return null;
  const parts = out.trim().split(/\s+/);
  const behind = Number(parts[0]);
  const ahead = Number(parts[1]);
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return null;
  return {ahead, behind};
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

function isRecentEnough(lastCommitDate: string, sinceDays: number): boolean {
  const ageMs = Date.now() - new Date(lastCommitDate).getTime();
  return ageMs <= sinceDays * 24 * 60 * 60 * 1000;
}

function resolveBaseline(
  opts: CoreOptions,
  currentBranch: string | null,
  defaultBranch: string | null,
): string | null {
  const requested = opts.baseline ?? 'current';
  if (requested === 'current') return currentBranch;
  if (requested === 'default') return defaultBranch;
  return requested;
}

/**
 * Build the core inventory.
 *
 * Returns null only when there is nothing sensible to measure against — a
 * detached HEAD with no explicit baseline, or not a git repo at all.
 *
 * Branches are gated by `sinceDays` BEFORE any per-branch `rev-list` runs (that
 * gate is what keeps the session-start path cheap), except that a branch with a
 * worktree is always kept regardless of age — an old branch someone still has
 * checked out is precisely the kind of thing worth surfacing. Pass
 * `sinceDays: null` to keep every branch, which is what reconcile wants.
 *
 * No `ahead > 0` filtering happens here: a branch with `ahead === 0` is fully
 * merged, which is a meaningful disposition rather than something to hide.
 * Filtering is left to the view.
 *
 * A FAILED LISTING IS NOT AN EMPTY ONE (home-base-qyu1.23). Either half of the
 * walk can fail on its own, so each is nullable and each failure is recorded in
 * `enumerationFailures` for the views to surface. Note the second-order effect
 * when the WORKTREE listing fails: no tip carries a `worktreePath`, so the
 * `sinceDays` gate can also drop an old branch it would normally have kept for
 * having a worktree. That is one more reason the failure must be reported rather
 * than absorbed — the missing rows are invisible by construction.
 */
export function buildCoreInventory(opts: CoreOptions): CoreInventory | null {
  const {cwd} = opts;
  const repoRoot = getRepoRoot(cwd);
  if (repoRoot == null) return null;

  const currentBranch = getCurrentBranch(cwd);
  const defaultBranch = detectDefaultBranch(cwd);
  const baselineRef = resolveBaseline(opts, currentBranch, defaultBranch);
  if (baselineRef == null) return null;

  const worktrees = getWorktrees(cwd);
  const sinceDays =
    opts.sinceDays === null ? null : (opts.sinceDays ?? DEFAULT_SINCE_DAYS);

  const tips = getBranchTips(cwd, worktrees);
  const candidates = tips
    ?.filter((t) => t.name !== baselineRef)
    .filter(
      (t) =>
        sinceDays === null ||
        t.worktreePath != null ||
        isRecentEnough(t.lastCommitDate, sinceDays),
    );

  const branches: BranchDivergence[] | null =
    candidates?.map((t) => ({
      ...t,
      divergence: countDivergence(cwd, baselineRef, t.name),
    })) ?? null;

  const enumerationFailures: EnumerationFailure[] = [];
  if (worktrees == null) enumerationFailures.push(ENUMERATION_FAILURES.worktrees);
  if (tips == null) enumerationFailures.push(ENUMERATION_FAILURES.branches);

  return {
    baselineRef,
    branches,
    currentBranch,
    defaultBranch,
    enumerationFailures,
    repoRoot,
    worktrees,
  };
}
