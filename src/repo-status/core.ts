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

export function getWorktrees(cwd: string): WorktreeEntry[] {
  const out = gitArgv(['worktree', 'list', '--porcelain'], cwd);
  if (out == null) return [];

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
 * an identically-named local branch is dropped in favour of the local one.
 */
export function getBranchTips(
  cwd: string,
  worktrees: WorktreeEntry[],
): BranchTip[] {
  const out = gitArgv(
    [
      'for-each-ref',
      '--format=%(refname) %(objectname) %(committerdate:iso-strict)',
      'refs/heads',
      'refs/remotes',
    ],
    cwd,
  );
  if (out == null) return [];

  const worktreeByBranch = new Map(
    worktrees
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
 * Commits each side has that the other lacks, in ONE call.
 *
 * `A...B` (three dots) with `--left-right --count` yields "<only-in-A>
 * <only-in-B>". Note this is the symmetric-difference form; the two-dot `A..B`
 * form answers a different question and is the source of a well-known
 * misreading when a branch is far behind its baseline.
 */
export function countDivergence(
  cwd: string,
  baseline: string,
  branch: string,
): {ahead: number; behind: number} {
  const out = gitArgv(
    ['rev-list', '--left-right', '--count', `${baseline}...${branch}`],
    cwd,
  );
  if (out == null) return {ahead: 0, behind: 0};
  const parts = out.trim().split(/\s+/);
  const behind = Number(parts[0] ?? '0');
  const ahead = Number(parts[1] ?? '0');
  return {
    ahead: Number.isFinite(ahead) ? ahead : 0,
    behind: Number.isFinite(behind) ? behind : 0,
  };
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

  const candidates = getBranchTips(cwd, worktrees)
    .filter((t) => t.name !== baselineRef)
    .filter(
      (t) =>
        sinceDays === null ||
        t.worktreePath != null ||
        isRecentEnough(t.lastCommitDate, sinceDays),
    );

  const branches: BranchDivergence[] = candidates.map((t) => ({
    ...t,
    ...countDivergence(cwd, baselineRef, t.name),
  }));

  return {
    baselineRef,
    branches,
    currentBranch,
    defaultBranch,
    repoRoot,
    worktrees,
  };
}
