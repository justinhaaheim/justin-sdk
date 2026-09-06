/**
 * repo-status — which open branches are in each other's way.
 *
 * The ledger answers "has this branch landed?" one branch at a time. The
 * question that follows immediately, every time there is more than one branch
 * open, is the one it cannot answer that way: if I merge these, do they collide
 * with each other? A reconcile that merges four branches in the wrong order
 * pays for it in the fourth merge.
 *
 * ── KEEPING IT OUT OF QUADRATIC TERRITORY ───────────────────────────────────
 *
 * Two tiers, so the expensive one runs on almost nothing.
 *
 *   1. FILE SETS. One `git diff --name-only` per candidate — LINEAR in branch
 *      count. Intersecting those sets pairwise is pure memory: no git, no
 *      subprocess, and at the branch counts these repos actually have it is
 *      unmeasurably fast. This alone answers "do they touch the same files".
 *
 *   2. PAIRWISE MERGE. `git merge-tree` on a PAIR is the real answer, and it
 *      runs only for pairs whose file sets already intersect — which on real
 *      repos is a small minority — and then only up to a cap.
 *
 * The genuine bound is upstream: the 90-day window and the archive filter are
 * what keep the candidate count small, so this needs no recency knob of its own.
 *
 * ── WHY THE BOOKKEEPING FIELDS ARE NOT OPTIONAL ─────────────────────────────
 *
 * Anything that can skip work must say how much it skipped, or "no overlaps"
 * silently merges with "did not look" — the pair of statements rule 6 exists to
 * keep apart. So the report always carries how many candidates there were, how
 * many pairs were considered, how many shared files, how many were actually
 * merge-checked, and how many the cap dropped.
 *
 * EXPECTED NOISE, not a bug: in Justin's repos `.beads/issues.jsonl` is touched
 * by nearly every branch and will show up in nearly every shared-file list.
 * That is true and worth seeing; it is deliberately not special-cased.
 *
 * Part of home-base-qyu1.33.3.
 */

import {execFileSync} from 'child_process';

import {previewMerge, type MergePreview} from './merge-preview';

/** Pairs that may be merge-checked in one run, after the shared-file screen. */
export const DEFAULT_PAIR_CAP = 20;

/** Cap on a reported shared-path LIST. Counts are never capped. */
const SHARED_FILE_CAP = 12;

const SHELL_SAFE_ARG = /^[A-Za-z0-9_@%+=:,./-]+$/;

function renderGitCommand(argv: string[]): string {
  const quote = (arg: string): string =>
    SHELL_SAFE_ARG.test(arg) ? arg : `'${arg.split("'").join(`'\\''`)}'`;
  return ['git', ...argv.map(quote)].join(' ');
}

/**
 * The paths a branch changed relative to its merge base with the baseline — or
 * an explicit statement that they could not be read.
 *
 * NULL IS NOT AN EMPTY CHANGE SET. A branch whose diff fails has an UNKNOWN
 * footprint; reporting `[]` would make it intersect nothing, so it would appear
 * in no overlap and read as "collides with nothing" — the reassuring direction,
 * which is the one that does damage.
 */
export interface ChangedFileSet {
  /** Null when the diff could not be read. */
  files: string[] | null;
  /** Null when the diff could not be read. Exact; never capped. */
  count: number | null;
  /** The command that failed. Null when it did not. */
  command: string | null;
}

function changedFilesArgv(baselineRef: string, branch: string): string[] {
  // Three dots: diff the merge base against the branch tip, which is the
  // branch's own footprint. Two dots would fold in everything the baseline did
  // since they diverged and make every long-lived branch look enormous.
  return ['diff', '--name-only', '-z', `${baselineRef}...${branch}`];
}

/** One `git diff` per branch. This is the linear half of the module. */
export function readChangedFiles(
  baselineRef: string,
  branch: string,
  cwd: string,
): ChangedFileSet {
  const argv = changedFilesArgv(baselineRef, branch);
  let out: string;
  try {
    out = execFileSync('git', argv, {
      cwd,
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: 'pipe',
    });
  } catch {
    return {command: renderGitCommand(argv), count: null, files: null};
  }
  // `-z` so a path containing a newline stays one path.
  const files = out.split('\0').filter((f) => f.length > 0);
  return {command: null, count: files.length, files};
}

export interface OverlapCandidate {
  name: string;
  lastCommitDate: string;
  changed: ChangedFileSet;
}

export interface BranchOverlap {
  a: string;
  b: string;
  /** Paths both branches touch. Capped for display; see `sharedFileCount`. */
  sharedFiles: string[];
  sharedFileCount: number;
  sharedFilesTruncated: boolean;
  /**
   * The three-way merge of the two branches with each other. NULL means NOT
   * CHECKED — the pair cap was reached — never "checked and clean". `why` on
   * the report says how many such pairs there are.
   */
  conflict: MergePreview | null;
}

export interface OverlapReport {
  /**
   * Null when there was no branch set to compare — the listing failed, or the
   * enrichment was switched off. NOT the same as an empty array, which means
   * "compared them and none share a file".
   */
  pairs: BranchOverlap[] | null;
  /** Branches whose footprint was read and compared. */
  candidates: number | null;
  /**
   * Candidates whose `git diff` failed. They are in NO pair, so they are
   * named here rather than silently reading as colliding with nothing.
   */
  unmeasuredBranches: string[] | null;
  pairsConsidered: number | null;
  pairsWithSharedFiles: number | null;
  pairsConflictChecked: number | null;
  pairsSkippedByCap: number | null;
  pairCap: number;
  /** What the numbers above amount to, in one line. */
  why: string;
}

/** The shape for "this enrichment did not run" — every count null, nothing implied. */
export const OVERLAPS_NOT_RUN: OverlapReport = {
  candidates: null,
  pairCap: DEFAULT_PAIR_CAP,
  pairsConflictChecked: null,
  pairsConsidered: null,
  pairsSkippedByCap: null,
  pairsWithSharedFiles: null,
  pairs: null,
  unmeasuredBranches: null,
  why: 'cross-branch overlap was not computed, so nothing here says branches do or do not collide',
};

export interface OverlapOptions {
  cwd: string;
  /** Max pairs to merge-check after the shared-file screen. */
  pairCap?: number;
}

/**
 * Compare every candidate against every other by file set, then merge-check the
 * intersecting pairs up to the cap.
 *
 * Candidates must already be the branches worth comparing — rows with unique
 * work, after filtering. Passing the whole ledger would put fully-merged
 * branches in pairs, where they collide with everything and mean nothing.
 */
export function buildOverlaps(
  candidates: OverlapCandidate[],
  opts: OverlapOptions,
): OverlapReport {
  const pairCap = opts.pairCap ?? DEFAULT_PAIR_CAP;

  const measured = candidates.filter((c) => c.changed.files != null);
  const unmeasuredBranches = candidates
    .filter((c) => c.changed.files == null)
    .map((c) => c.name);

  interface Pending {
    a: OverlapCandidate;
    b: OverlapCandidate;
    shared: string[];
  }
  const pending: Pending[] = [];
  let pairsConsidered = 0;

  for (let i = 0; i < measured.length; i += 1) {
    for (let j = i + 1; j < measured.length; j += 1) {
      const a = measured[i];
      const b = measured[j];
      if (a == null || b == null) continue;
      pairsConsidered += 1;
      const bFiles = new Set(b.changed.files ?? []);
      const shared = (a.changed.files ?? []).filter((f) => bFiles.has(f));
      if (shared.length === 0) continue;
      pending.push({a, b, shared});
    }
  }

  // Rank before capping so the cap drops the LEAST informative pairs: most
  // shared files first (most likely to actually collide), then most recently
  // touched (most likely to be live work someone is about to merge).
  pending.sort((x, y) => {
    if (x.shared.length !== y.shared.length) return y.shared.length - x.shared.length;
    const xDate = x.a.lastCommitDate > x.b.lastCommitDate ? x.a.lastCommitDate : x.b.lastCommitDate;
    const yDate = y.a.lastCommitDate > y.b.lastCommitDate ? y.a.lastCommitDate : y.b.lastCommitDate;
    return yDate.localeCompare(xDate);
  });

  let checked = 0;
  const pairs: BranchOverlap[] = pending.map((p, index) => {
    const withinCap = index < pairCap;
    if (withinCap) checked += 1;
    const truncated = p.shared.length > SHARED_FILE_CAP;
    return {
      a: p.a.name,
      b: p.b.name,
      conflict: withinCap
        ? previewMerge(p.a.name, p.b.name, opts.cwd)
        : null,
      sharedFileCount: p.shared.length,
      sharedFiles: truncated ? p.shared.slice(0, SHARED_FILE_CAP) : p.shared,
      sharedFilesTruncated: truncated,
    };
  });

  const skipped = pending.length - checked;
  return {
    candidates: measured.length,
    pairCap,
    pairsConflictChecked: checked,
    pairsConsidered,
    pairsSkippedByCap: skipped,
    pairsWithSharedFiles: pending.length,
    pairs,
    unmeasuredBranches,
    why: describeOverlaps({
      candidates: measured.length,
      checked,
      pairsConsidered,
      skipped,
      unmeasured: unmeasuredBranches.length,
      withShared: pending.length,
    }),
  };
}

function describeOverlaps(n: {
  candidates: number;
  checked: number;
  pairsConsidered: number;
  skipped: number;
  unmeasured: number;
  withShared: number;
}): string {
  // The unmeasured note is appended to EVERY branch of this function, including
  // this early one. A repo with one readable branch and one unreadable one hits
  // this path, and saying only "there is no pair to compare" there would drop
  // the single most important fact — that a branch was left out because its
  // footprint could not be read.
  const unmeasuredNote =
    n.unmeasured > 0
      ? `. ${n.unmeasured} branch(es) could not have their changed files read and appear in NO pair, so nothing here rules out a collision with them`
      : '';

  if (n.candidates < 2) {
    const only =
      n.candidates === 0
        ? 'no branch has unique work'
        : 'only one branch has unique work';
    return `${only}, so there is no pair to compare — this is not a statement that branches agree${unmeasuredNote}`;
  }
  const base =
    n.withShared === 0
      ? `compared all ${n.pairsConsidered} pair(s) of the ${n.candidates} branch(es) with unique work: none touch a common file`
      : `${n.withShared} of ${n.pairsConsidered} pair(s) touch a common file; ${n.checked} merge-checked against each other`;
  const capNote =
    n.skipped > 0
      ? `, and ${n.skipped} more shared files but were NOT merge-checked (pair cap) — those are unknown, not clean`
      : '';
  return `${base}${capNote}${unmeasuredNote}`;
}
