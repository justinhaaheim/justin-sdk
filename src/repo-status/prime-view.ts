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
 * the walk. Divergence is measured against the DEFAULT branch from any branch
 * (home-base-p05kz.4), and the session's own branch reads as a clause in the
 * header rather than as a row.
 *
 * Formerly `src/plugin/lib/repo-status/prime-view.ts`, and before that
 * `src/plugin/lib/project-prime.ts` (home-base-46w2/qyu1.11). It moved here
 * when dchjw.8 retired the plugin; the rest of `src/repo-status` had been
 * importing it across that boundary all along.
 */

import type {
  BranchDivergence,
  EnumerationFailure,
  FilterSummary,
} from './types';

import {countUnmergedByPatchId} from './content';
import {buildCoreInventory} from './core';
import {EMPTY_PR_INDEX, fetchPullRequests, prForBranch} from './prs';

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
  /**
   * Null when the divergence could not be measured (home-base-qyu1.21). Such a
   * group is still SURFACED: this view exists so unmerged work is never missed,
   * and "I could not count it" is a weaker reason to stay quiet than any
   * count — dropping it would be the same silent-omission failure the module
   * was written to prevent.
   */
  aheadOfCurrent: number | null;
  branches: BranchDivergence[];
  hasWorktree: boolean;
  lastCommitDate: string;
  /**
   * How many of those commits have no patch-equivalent on the baseline
   * (`git cherry`), so a partly merged branch reads "1 of 3 commits not on
   * main". NULL when that measurement failed: the renderer falls back to the
   * plain count and says so. Never 0 on a failure (critical rules section 7).
   */
  notOnBaseline: number | null;
  /** e.g. "PR #12 open". Null when PR data was not requested or unavailable. */
  prNote: string | null;
  tipSha: string;
}

export interface DivergenceReport {
  /** The branch the counts are measured against: the default branch when known. */
  baselineRef: string;
  currentBranch: string;
  /** Null when git cannot name a default branch: then the baseline is the current branch. */
  defaultBranch: string | null;
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
  /**
   * What the walk hid before any of this was computed.
   *
   * Carried because the sentence this view prints — "N branches have unmerged
   * work" — is read as a complete count, and two filters run before it. Saying
   * so in one clause is what keeps the number a claim about the whole repo
   * rather than about a subset the reader cannot see (home-base-qyu1.33.1).
   */
  filtered: FilterSummary;
  groups: DivergentGroup[];
  /** Null on the baseline itself, which has nothing to stand against. */
  standing: BranchStanding | null;
}

export interface RunOptions {
  cwd: string;
  /**
   * Hide `archive/*` mirrors. Default TRUE here: this section answers "what
   * work might I not know about", and an archive mirror is by definition work a
   * previous reconcile finished with. Left visible they are pure noise at the
   * top of every session in a repo that has been reconciled a few times — and
   * noise at session start is what makes the real rows get skimmed past.
   */
  excludeArchive?: boolean;
  /** Include PR state. Off by default — see PRIME_PR_TIMEOUT_MS above for why. */
  prs?: boolean;
  /** Branches with no commits within this many days are hidden, worktree or not, and counted under `Not listed`. Default 30. */
  sinceDays?: number;
}

/**
 * How the session's own branch stands against the baseline. Null when it IS the
 * baseline, or when git could not measure it (see `standing` on the report).
 */
export type BranchStanding =
  | {ahead: number; behind: number; kind: 'measured'}
  | {kind: 'unmeasured'};

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

export function runDivergenceCheck(opts: RunOptions): DivergenceReport | null {
  const inventoryAgainst = (baseline: 'current' | 'default') =>
    buildCoreInventory({
      ageOutWorktrees: true,
      baseline,
      cwd: opts.cwd,
      excludeArchive: opts.excludeArchive ?? true,
      sinceDays: opts.sinceDays,
    });
  // Against the DEFAULT branch, from any branch (home-base-p05kz.4). Against the
  // current branch, a session cut earlier than main saw `main` listed as
  // unmerged work: 56 of 163 blocks in the 2026-11-06 audit. A repo that cannot
  // name its default branch still gets a block, measured from where it stands.
  const inventory = inventoryAgainst('default') ?? inventoryAgainst('current');
  // Detached HEAD / not a repo — nothing sensible to report.
  if (inventory?.currentBranch == null) return null;
  const {currentBranch, baselineRef, baselineSha} = inventory;

  // The session's own branch is not "other work": it moves to the header.
  const own = (inventory.branches ?? []).find((b) => b.name === currentBranch);
  const standing: BranchStanding | null =
    currentBranch === baselineRef
      ? null
      : own?.divergence != null
        ? {
            ahead: own.divergence.ahead,
            behind: own.divergence.behind,
            kind: 'measured',
          }
        : {kind: 'unmeasured'};

  // Only branches that HAVE something we might lose are worth surfacing here —
  // plus the ones where that could not be determined, which are exactly the
  // branches this view must not quietly drop.
  //
  // A null `branches` is not "none": the listing failed, so there is no set to
  // filter. It yields no groups, and the enumeration failure below is what stops
  // that from being rendered as a clean repo.
  const withAhead = (inventory.branches ?? []).filter(
    (b) =>
      b.name !== currentBranch &&
      (b.divergence == null || b.divergence.ahead > 0),
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
      lastCommitDate: branches.reduce(
        (latest, b) => (b.lastCommitDate > latest ? b.lastCommitDate : latest),
        branches[0]?.lastCommitDate ?? '',
      ),
      // One `git cherry` per LISTED group, never per hidden branch: this view
      // runs on the first prompt, and the list is short once old branches age
      // out. Skipped when rev-list already failed: there is no count to qualify.
      notOnBaseline:
        branches[0]?.divergence == null
          ? null
          : countUnmergedByPatchId(baselineSha, tipSha, opts.cwd),
      prNote: prNoteFor(branches, prIndex),
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
    baselineRef,
    currentBranch,
    defaultBranch: inventory.defaultBranch,
    enumerationFailures: inventory.enumerationFailures,
    filtered: inventory.filtered,
    groups,
    standing,
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const RECENT_TOUCH_MS = 72 * 60 * 60 * 1000;

/**
 * `YYYY-MM-DD`, plus ` HH:MM` (24h, local).
 *
 * TWO MODES, and the difference is about the surrounding layout rather than the
 * date. `recent` (the default, and what the session-start prose wants) prints
 * the time only for a commit inside the last 72h, because in flowing prose an
 * unhelpful `00:00` on a two-month-old commit is clutter. `always` is what a
 * COLUMN wants: a variable-width cell makes the whole table ragged, and the
 * ragged column costs more than the extra digits.
 *
 * Exported because the ledger renders the same dates for the same reader, and
 * two copies of this would have drifted into two conventions.
 */
export function formatTouched(
  iso: string,
  time: 'always' | 'recent' = 'recent',
): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const date = `${y}-${mo}-${day}`;
  if (time === 'recent' && Date.now() - d.getTime() > RECENT_TOUCH_MS) {
    return date;
  }
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${date} ${hh}:${mm}`;
}

/**
 * The one clause that keeps the count above honest, or '' when nothing was hidden.
 *
 * Both filters run before any branch is counted, so "no unmerged work on any
 * other branch" is, strictly, "none among the branches I listed". That gap is
 * small and it is real, and one clause closes it — including on the all-clear
 * line, which is the sentence most likely to be acted on.
 */
function formatHidden(filtered: FilterSummary): string {
  const parts: string[] = [];
  if ((filtered.excludedAsArchive ?? 0) > 0) {
    parts.push(`${filtered.excludedAsArchive} archive/* mirror(s)`);
  }
  if ((filtered.excludedAsStale ?? 0) > 0) {
    parts.push(
      `${filtered.excludedAsStale} branch(es) with no commit in ${filtered.sinceDays}d`,
    );
  }
  if (parts.length === 0) return '';
  return `Not listed: ${parts.join(', ')} — \`repo-status status --all\` shows everything.`;
}

/** The clause naming where the session's own branch stands, or '' on the baseline. */
function formatStanding(report: DivergenceReport): string {
  const {baselineRef, standing} = report;
  if (standing == null) return '';
  if (standing.kind === 'unmeasured') {
    return ` (divergence from \`${baselineRef}\` UNKNOWN)`;
  }
  return ` (${standing.ahead} ahead of \`${baselineRef}\`, ${standing.behind} behind)`;
}

/**
 * The count for one row.
 *
 * Three cases, and the failures stay visible (critical rules section 7):
 *  - rev-list failed: it may hold anything, so it reads UNKNOWN, never zero.
 *  - `git cherry` failed: the plain count, and the row says it is not proven.
 *  - both measured: "1 of 3 commits not on main", or "3 commits not on main"
 *    when none has an equivalent there.
 */
function formatAhead(group: DivergentGroup, baselineRef: string): string {
  const ahead = group.aheadOfCurrent;
  if (ahead == null) {
    return 'commits ahead UNKNOWN — could not measure divergence';
  }
  const noun = ahead === 1 ? 'commit' : 'commits';
  if (group.notOnBaseline == null) {
    return `${ahead} ${noun} ahead of ${baselineRef}, patch check failed so some may already be merged`;
  }
  return group.notOnBaseline === ahead
    ? `${ahead} ${noun} not on ${baselineRef}`
    : `${group.notOnBaseline} of ${ahead} ${noun} not on ${baselineRef}`;
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

  const hidden = formatHidden(report.filtered);

  const here = `\`${report.currentBranch}\`${formatStanding(report)}`;

  if (report.groups.length === 0) {
    if (failed.length > 0) return failed.join('\n');
    return [
      header,
      '',
      `On ${here} — no unmerged work on any other branch or worktree.`,
      ...(hidden.length > 0 ? ['', hidden] : []),
    ].join('\n');
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
          `On ${here}, ${report.groups.length} branch${one ? '' : 'es'} ${one ? 'has' : 'have'} unmerged work:`,
        ];
  for (const group of report.groups) {
    const names = group.branches.map((b) => b.name).join(' / ');
    const worktreeNote = group.hasWorktree ? 'worktree, ' : '';
    const aheadNote = formatAhead(group, report.baselineRef);
    const sameTipNote =
      group.branches.length > 1
        ? ' -- same tip, may be the same underlying work'
        : '';
    const prNote = group.prNote != null ? `, ${group.prNote}` : '';
    lines.push(
      `  - ${names} (${worktreeNote}${aheadNote}, last touched ${formatTouched(group.lastCommitDate)}${prNote})${sameTipNote}`,
    );
  }
  if (hidden.length > 0) lines.push('', hidden);
  // Only on the default branch: from a feature branch it pointed the wrong way
  // (home-base-p05kz.4).
  if (report.currentBranch === report.defaultBranch) {
    lines.push(
      '',
      'When there is unmerged work on feature branch(es), the human may prefer for new work to base from the feature branches rather than main. When in doubt, ask.',
    );
  }
  return lines.join('\n');
}
