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
import {EMPTY_PR_INDEX, fetchPullRequests, prForBranch} from './prs';

import type {BranchDivergence, EnumerationFailure} from './types';

/**
 * PR fetching is OFF by default here, and that default is measured rather than
 * assumed. On a real repo the core walk costs ~150ms while the `gh` call adds
 * ~600ms — tolerable on its own, and Justin's expectation that it would not
 * meaningfully slow session start holds for the happy path.
 *
 * The tail is what decides it. `gh` is a network call, and it fails in
 * environments Justin actually uses (TLS inside the Claude Code sandbox,
 * offline, unauthenticated). Those paths pay the full timeout at EVERY session
 * start for no data. So it stays opt-in, and when enabled it uses a much
 * tighter timeout than the CLI's — a session-start hook must degrade fast.
 */
const PRIME_PR_TIMEOUT_MS = 2000;

/** Branches sharing a tip sha — usually one, but >1 hints at the same underlying work. */
export interface DivergentGroup {
  tipSha: string;
  branches: BranchDivergence[];
  /**
   * Null when the divergence could not be measured (home-base-qyu1.21). Such a
   * group is still SURFACED: this view exists so unmerged work is never missed,
   * and "I could not count it" is a weaker reason to stay quiet than any
   * count — dropping it would be the same silent-omission failure the module
   * was written to prevent.
   */
  aheadOfCurrent: number | null;
  lastCommitDate: string;
  hasWorktree: boolean;
  /** e.g. "PR #12 open". Null when PR data was not requested or unavailable. */
  prNote: string | null;
}

export interface DivergenceReport {
  currentBranch: string;
  groups: DivergentGroup[];
  /**
   * Halves of the core walk git could not read (home-base-qyu1.23). NON-EMPTY
   * MEANS `groups` IS NOT A COMPLETE ANSWER, and in the `for-each-ref` case it
   * carries no answer at all — so `formatRepoState` checks this FIRST and never
   * prints the all-clear sentence while it is non-empty.
   *
   * `groups` stays a plain array rather than becoming nullable because this
   * report has exactly one consumer, the formatter below, and the rule it has to
   * enforce is about the SENTENCE it prints rather than about a per-group value.
   * Making the array nullable would push a null check into every caller reading
   * group contents while doing nothing extra for the one thing that matters —
   * that a repo git could not read is never described as clean.
   */
  enumerationFailures: EnumerationFailure[];
}

export interface RunOptions {
  cwd: string;
  /** Branches with no commits within this many days are ignored unless they have a worktree. Default 30. */
  sinceDays?: number;
  /** Include PR state. Off by default — see PRIME_PR_TIMEOUT_MS above for why. */
  prs?: boolean;
}

export function runDivergenceCheck(opts: RunOptions): DivergenceReport | null {
  const inventory = buildCoreInventory({
    baseline: 'current',
    cwd: opts.cwd,
    sinceDays: opts.sinceDays,
  });
  // Detached HEAD / not a repo — nothing sensible to report.
  if (inventory?.currentBranch == null) return null;

  // Only branches that HAVE something we might lose are worth surfacing here —
  // plus the ones where that could not be determined, which are exactly the
  // branches this view must not quietly drop.
  //
  // A null `branches` is not "none": the listing failed, so there is no set to
  // filter. It yields no groups, and the enumeration failure below is what stops
  // that from being rendered as a clean repo.
  const withAhead = (inventory.branches ?? []).filter(
    (b) => b.divergence == null || b.divergence.ahead > 0,
  );

  // Fetch PRs only when asked, and only when there is something to annotate —
  // a clean repo should never pay for a network call it cannot use.
  const prIndex =
    opts.prs === true && withAhead.length > 0
      ? fetchPullRequests({cwd: opts.cwd, timeoutMs: PRIME_PR_TIMEOUT_MS})
      : EMPTY_PR_INDEX;

  const bySha = new Map<string, BranchDivergence[]>();
  for (const b of withAhead) {
    const list = bySha.get(b.tipSha) ?? [];
    list.push(b);
    bySha.set(b.tipSha, list);
  }

  const groups: DivergentGroup[] = Array.from(bySha.entries()).map(
    ([tipSha, branches]) => ({
      aheadOfCurrent: branches[0]?.divergence?.ahead ?? null,
      branches,
      hasWorktree: branches.some((b) => b.worktreePath != null),
      prNote: prNoteFor(branches, prIndex),
      lastCommitDate: branches.reduce(
        (latest, b) => (b.lastCommitDate > latest ? b.lastCommitDate : latest),
        branches[0]?.lastCommitDate ?? '',
      ),
      tipSha,
    }),
  );

  groups.sort((a, b) => {
    if (a.hasWorktree !== b.hasWorktree) return a.hasWorktree ? -1 : 1;
    // Unmeasured sorts to the top, as the largest possible count: it is the
    // group whose contents are least known, not the one with the least in it.
    const rank = (g: DivergentGroup): number =>
      g.aheadOfCurrent ?? Number.MAX_SAFE_INTEGER;
    if (rank(a) !== rank(b)) return rank(b) - rank(a);
    return b.lastCommitDate.localeCompare(a.lastCommitDate);
  });

  return {
    currentBranch: inventory.currentBranch,
    enumerationFailures: inventory.enumerationFailures,
    groups,
  };
}

function prNoteFor(
  branches: BranchDivergence[],
  prIndex: ReturnType<typeof fetchPullRequests>,
): string | null {
  if (!prIndex.available) return null;
  for (const b of branches) {
    const pr = prForBranch(prIndex, b.name);
    if (pr != null) return `PR #${pr.number} ${pr.state.toLowerCase()}`;
  }
  return null;
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
 *
 * THE ALL-CLEAR IS A CLAIM (home-base-qyu1.23). "no unmerged work on any other
 * branch or worktree" is the single most consequential sentence this module
 * emits: it is injected at session start, and it tells the reader it is safe to
 * start building where they stand. It used to be printed whenever the group list
 * came back empty — including when the list was empty because `git for-each-ref`
 * failed and the inventory was fabricated from nothing. A repo git cannot read is
 * the one repo where that sentence is most likely to be wrong, so the failures
 * are checked BEFORE the count of groups, and while any exist the section says
 * UNKNOWN instead.
 */
export function formatRepoState(report: DivergenceReport | null): string {
  if (report == null) return '';

  const header = '# Current repo state';

  // Deliberately first, and deliberately not merged into the branch listing:
  // when the branch listing itself is what failed, everything below is silence
  // rather than evidence, and a reader has to see that before anything else.
  const failed: string[] = [];
  if (report.enumerationFailures.length > 0) {
    failed.push(
      header,
      '',
      `On \`${report.currentBranch}\` — the repo state could NOT be fully read. Treat it as UNKNOWN, not as clean:`,
      '',
    );
    for (const f of report.enumerationFailures) {
      failed.push(`  - could not enumerate ${f.what}: \`${f.command}\` failed`);
      failed.push(`    ${f.why}`);
      failed.push(`    ${f.diagnose}`);
    }
  }

  if (report.groups.length === 0) {
    if (failed.length > 0) return failed.join('\n');
    return `${header}\n\nOn \`${report.currentBranch}\` — no unmerged work on any other branch or worktree.`;
  }

  const one = report.groups.length === 1;
  const lines: string[] =
    failed.length > 0
      ? [
          ...failed,
          '',
          `Of what COULD be read, ${report.groups.length} branch${one ? '' : 'es'} ${one ? 'has' : 'have'} unmerged work:`,
        ]
      : [
          header,
          '',
          `On \`${report.currentBranch}\`, ${report.groups.length} branch${one ? '' : 'es'} ${one ? 'has' : 'have'} unmerged work:`,
        ];
  for (const group of report.groups) {
    const names = group.branches.map((b) => b.name).join(' / ');
    const worktreeNote = group.hasWorktree ? 'worktree, ' : '';
    // "unknown" rather than a number: `git rev-list` failed for this branch, so
    // it may hold anything from nothing to everything, and the one thing it may
    // not be reported as is zero.
    const aheadNote =
      group.aheadOfCurrent == null
        ? 'commits ahead UNKNOWN — could not measure divergence'
        : `${group.aheadOfCurrent} ${group.aheadOfCurrent === 1 ? 'commit' : 'commits'} ahead`;
    const sameTipNote =
      group.branches.length > 1
        ? ' -- same tip, may be the same underlying work'
        : '';
    const prNote = group.prNote != null ? `, ${group.prNote}` : '';
    lines.push(
      `  - ${names} (${worktreeNote}${aheadNote}, last touched ${formatTouched(group.lastCommitDate)}${prNote})${sameTipNote}`,
    );
  }
  lines.push(
    '',
    'When there is unmerged work on feature branch(es), the human may prefer for new work to base from the feature branches rather than main. When in doubt, ask.',
  );
  return lines.join('\n');
}
