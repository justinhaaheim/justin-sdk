/**
 * The `prime` session-start view over the core inventory.
 *
 * Justin's recurring failure mode: he kicks off a session on main (or a stale
 * worktree), Claude builds there, and only later does it turn out weeks of
 * unmerged work were sitting on a feature branch/worktree nobody checked. This
 * view answers exactly one question — "what work exists that I might not know
 * about, measured from where I am standing right now?" — and stays quiet when
 * the answer is nothing.
 *
 * It is a RENDERER over `buildCoreInventory`, not a second implementation of
 * the walk. Divergence is measured against the CURRENT branch here (not the
 * default branch), which is what makes it the right view for session start.
 *
 * Formerly `src/plugin/lib/project-prime.ts`. Part of home-base-46w2/qyu1.11.
 */

import {buildCoreInventory} from './core';

import type {BranchDivergence} from './types';

/** Branches sharing a tip sha — usually one, but >1 hints at the same underlying work. */
export interface DivergentGroup {
  tipSha: string;
  branches: BranchDivergence[];
  aheadOfCurrent: number;
  lastCommitDate: string;
  hasWorktree: boolean;
}

export interface DivergenceReport {
  currentBranch: string;
  groups: DivergentGroup[];
}

export interface RunOptions {
  cwd: string;
  /** Branches with no commits within this many days are ignored unless they have a worktree. Default 30. */
  sinceDays?: number;
}

export function runDivergenceCheck(opts: RunOptions): DivergenceReport | null {
  const inventory = buildCoreInventory({
    baseline: 'current',
    cwd: opts.cwd,
    sinceDays: opts.sinceDays,
  });
  // Detached HEAD / not a repo — nothing sensible to report.
  if (inventory?.currentBranch == null) return null;

  // Only branches that HAVE something we might lose are worth surfacing here.
  const withAhead = inventory.branches.filter((b) => b.ahead > 0);

  const bySha = new Map<string, BranchDivergence[]>();
  for (const b of withAhead) {
    const list = bySha.get(b.tipSha) ?? [];
    list.push(b);
    bySha.set(b.tipSha, list);
  }

  const groups: DivergentGroup[] = Array.from(bySha.entries()).map(
    ([tipSha, branches]) => ({
      aheadOfCurrent: branches[0]?.ahead ?? 0,
      branches,
      hasWorktree: branches.some((b) => b.worktreePath != null),
      lastCommitDate: branches.reduce(
        (latest, b) => (b.lastCommitDate > latest ? b.lastCommitDate : latest),
        branches[0]?.lastCommitDate ?? '',
      ),
      tipSha,
    }),
  );

  groups.sort((a, b) => {
    if (a.hasWorktree !== b.hasWorktree) return a.hasWorktree ? -1 : 1;
    if (a.aheadOfCurrent !== b.aheadOfCurrent)
      return b.aheadOfCurrent - a.aheadOfCurrent;
    return b.lastCommitDate.localeCompare(a.lastCommitDate);
  });

  return {currentBranch: inventory.currentBranch, groups};
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const RECENT_TOUCH_MS = 72 * 60 * 60 * 1000;

/** YYYY-MM-DD, plus ` HH:MM` (24h, local) when the commit is within the last 72h. */
function formatTouched(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const date = `${y}-${mo}-${day}`;
  if (Date.now() - d.getTime() > RECENT_TOUCH_MS) return date;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${date} ${hh}:${mm}`;
}

/**
 * Render the repo-state section for session-start injection. ALWAYS returns a
 * titled section when on a branch — including a "clean" line when there's no
 * divergence — so a reader always sees the current repo state. Returns '' only
 * when there's nothing sensible to report (detached HEAD / not a git repo).
 */
export function formatRepoState(report: DivergenceReport | null): string {
  if (report == null) return '';

  const header = '# Current repo state';
  if (report.groups.length === 0) {
    return `${header}\n\nOn \`${report.currentBranch}\` — no unmerged work on any other branch or worktree.`;
  }

  const one = report.groups.length === 1;
  const lines: string[] = [
    header,
    '',
    `On \`${report.currentBranch}\`, ${report.groups.length} branch${one ? '' : 'es'} ${one ? 'has' : 'have'} unmerged work:`,
  ];
  for (const group of report.groups) {
    const names = group.branches.map((b) => b.name).join(' / ');
    const worktreeNote = group.hasWorktree ? 'worktree, ' : '';
    const commitWord = group.aheadOfCurrent === 1 ? 'commit' : 'commits';
    const sameTipNote =
      group.branches.length > 1
        ? ' -- same tip, may be the same underlying work'
        : '';
    lines.push(
      `  - ${names} (${worktreeNote}${group.aheadOfCurrent} ${commitWord} ahead, last touched ${formatTouched(group.lastCommitDate)})${sameTipNote}`,
    );
  }
  lines.push(
    '',
    'When there is unmerged work on feature branch(es), the human may prefer for new work to base from the feature branches rather than main. When in doubt, ask.',
  );
  return lines.join('\n');
}
