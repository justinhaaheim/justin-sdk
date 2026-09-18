/**
 * repo-status — the default rendering: the same typed object, written to be read.
 *
 * This is what both a person and an agent get unless they ask for `--yaml` or
 * `--json`. It is ~15x smaller than the YAML for the same repo, and the
 * information an agent needs turns out to be the information a person needs —
 * what is open, how old it is, whether it landed, and what merging it will
 * cost. The structured formats stay for scripts and for anything that wants a
 * field this summary drops.
 *
 * A PURE FUNCTION over `RepoStatusReport`. It runs no git, reads no files, and
 * decides no verdicts; everything printed is already in the object. That is
 * what stops this format from quietly becoming a third source of truth.
 *
 * ── Layout rules, all of them learned from reading the output ────────────────
 *
 *   * ONE COLUMN GRID FOR EVERY SECTION. Widths are measured across all branch
 *     rows in the report, not per section, so a name under `ALREADY MERGED`
 *     lines up with a name under `UNMERGED WORK`. Per-section widths made the
 *     eye re-find the columns at every heading.
 *   * ONE TIMESTAMP FORMAT. `YYYY-MM-DD HH:MM` on every row, including old
 *     ones. Dropping the time on older commits made the column ragged and
 *     bought nothing.
 *   * A HEADER ROW PER SECTION, because a bare number in a column is unreadable
 *     without one — and an agent reading this cold has no schema to consult.
 *   * DETAIL IS INDENTED UNDER ITS ROW, and a row with detail is followed by a
 *     blank line. Rows with no detail stay tight: the blank line exists to bind
 *     a row to its own lines, and a one-line row has nothing to bind.
 *   * THE CHECKOUT PATH IS PART OF THE ROW, not detail, and it prints on EVERY
 *     row that has a worktree — including merged ones, which are exactly the
 *     `git worktree remove` cleanup list (epic design D2). Being part of the
 *     row rather than detail is what keeps that unconditional: a merged row
 *     with a clean checkout is two tight lines, so the merged table gains a
 *     path without becoming double-spaced.
 *
 * ── Two things it must not do ───────────────────────────────────────────────
 *
 *   * Print an all-clear over a repo git could not read. Enumeration failures
 *     render FIRST and the summary is never shown as if it were complete.
 *   * Leave a warning on stderr only. A person watching a terminal sees the two
 *     streams interleaved and will not attribute a line to either; a person
 *     redirecting stdout to a file loses them entirely.
 *
 * Part of home-base-qyu1.33.4 / qyu1.33.5.
 */

import {formatTouched} from './prime-view';
import {PR_STATE_NOT_CHECKED} from './disposition';

import type {FilterSummary} from './types';
import type {Disposition} from './disposition';
import type {FetchAge} from './fetch-age';
import type {SubmoduleShift} from './merge-preview';
import type {BranchOverlap, OverlapReport} from './overlap';
import type {RepoStatusReport, BranchRow} from './report';
import type {
  SubmoduleFinding,
  SubmoduleInventory,
  SubmoduleRow,
} from './submodules';

/**
 * Section names and blurbs, in reading order.
 *
 * The names are deliberately PLAIN. `needs-judgment` and `mirrored` are the
 * schema's words and they stay in the schema, but a heading has to be
 * intelligible to a reader who has never seen this tool: the first group is
 * unmerged work, and the third is work kept on a backup branch. Each blurb says
 * what the group MEANS for the reader, not what the classifier was thinking.
 */
const GROUPS: {blurb: string; heading: string; key: Disposition}[] = [
  {
    // NOT "not backed up anywhere". That was the old blurb and it was FALSE for
    // any branch sitting on origin at the same sha — a generalisation across
    // rows that the rows themselves did not support, caught by every blind
    // reviewer (2026-09-07). Where the work exists is now a per-branch column,
    // because it varies per branch.
    blurb: 'commits that are on these branches and not on main',
    heading: 'UNMERGED WORK',
    key: 'needs-judgment',
  },
  {
    blurb:
      'the evidence is incomplete or contradicts itself — check these before acting on them',
    heading: 'NEEDS A LOOK',
    key: 'review',
  },
  {
    blurb:
      'not on main, but every commit is preserved on an archive/ backup branch',
    heading: 'ARCHIVED',
    key: 'mirrored',
  },
  {
    // Deliberately NOT "nothing to lose here" any more. That sentence
    // authorises deleting a branch and its worktree, and it was being printed
    // over checkouts holding uncommitted edits — a claim about a working tree,
    // made without looking at one. The commit claim is what this group proves;
    // the working-tree claim is now a per-row `uncommitted` marker.
    blurb:
      'every COMMIT is already on main (by content, so squash-merges and rebases count)',
    heading: 'ALREADY MERGED',
    key: 'merged',
  },
];

// ---------------------------------------------------------------------------
// Styling
// ---------------------------------------------------------------------------

/**
 * ANSI styling, on ONLY for an interactive terminal.
 *
 * The caller decides (`shouldStyle()` below) and passes the answer in, so this
 * module stays pure. Piped output, a redirect to a file, and every agent
 * reading this through a tool call get plain text — which is what they want,
 * since escape sequences in a transcript are noise the reader has to parse past.
 */
export interface Styler {
  alert: (s: string) => string;
  bold: (s: string) => string;
  dim: (s: string) => string;
  heading: (s: string) => string;
  ok: (s: string) => string;
}

const ESC = '[';

const PLAIN: Styler = {
  alert: (s) => s,
  bold: (s) => s,
  dim: (s) => s,
  heading: (s) => s,
  ok: (s) => s,
};

const ANSI: Styler = {
  alert: (s) => `${ESC}31m${s}${ESC}0m`,
  bold: (s) => `${ESC}1m${s}${ESC}0m`,
  dim: (s) => `${ESC}2m${s}${ESC}0m`,
  heading: (s) => `${ESC}1m${ESC}4m${s}${ESC}0m`,
  ok: (s) => `${ESC}32m${s}${ESC}0m`,
};

/** Whether this process should emit ANSI. Honours the NO_COLOR convention. */
export function shouldStyle(): boolean {
  if (process.env.NO_COLOR != null && process.env.NO_COLOR !== '') return false;
  if (process.env.FORCE_COLOR != null && process.env.FORCE_COLOR !== '') {
    return true;
  }
  return process.stdout.isTTY === true;
}

// ---------------------------------------------------------------------------
// Small formatters
// ---------------------------------------------------------------------------

function plural(n: number, word: string): string {
  if (n === 1) return `${n} ${word}`;
  return `${n} ${word}${/(?:ch|sh|s|x|z)$/.test(word) ? 'es' : 's'}`;
}

/** A commit, abbreviated for reading. The full sha stays in the YAML/JSON. */
function short(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * What the remote refs in this report are worth, in one line.
 *
 * `0 behind origin/main` rests entirely on this and never said so: `origin/main`
 * is a local ref that only a fetch moves, so the figure is against whatever this
 * disk last downloaded. The three states are printed as three different
 * sentences, and two of them are alerts — a never-fetched checkout and an
 * unreadable fetch age both mean the BEHIND column is unsupported, and neither
 * may be rendered as the quiet, ordinary case (home-base-qyu1.33.6).
 */
function remoteRefsLine(age: FetchAge, style: Styler): string {
  if (age.kind === 'fetched') {
    return style.dim(
      `Remote refs: last fetched ${formatTouched(age.at, 'always')} — every BEHIND against an origin/* ref is measured against what was downloaded then`,
    );
  }
  if (age.kind === 'never') {
    return style.alert(
      'Remote refs: NO fetch recorded in this checkout — any BEHIND against an origin/* ref is against refs that were never refreshed here',
    );
  }
  return style.alert(
    `Remote refs: fetch age UNKNOWN (${age.why}) — how stale the origin/* refs are cannot be said`,
  );
}

/** A path list, capped, with the remainder counted rather than dropped. */
function fileList(files: string[], total: number, cap: number): string {
  const shown = files.slice(0, cap);
  const hidden = total - shown.length;
  return `${shown.join(', ')}${hidden > 0 ? `, +${hidden} more` : ''}`;
}

/**
 * ALSO ON — one column answering two different questions, by section.
 *
 * ON AN UNMERGED ROW it is where the WORK survives: a branch on origin survives
 * losing this machine and a branch that is only here does not, which every blind
 * reviewer ranked the most important missing field. `THIS DISK ONLY` belongs to
 * this half and only this half.
 *
 * ON A MERGED ROW the work is on the baseline by definition, so "where does it
 * survive" has one answer for every row and printing it was a tautology — the
 * column said `main` ten times over (all three round-2 reviewers, independently).
 * The useful fact there is the CLEANUP one: deleting the local branch leaves the
 * remote ref behind, so what this column names is the ref that also has to go
 * (`git push origin --delete <name>`). Nothing to delete renders `—`: a
 * local-only merged branch has no remote ref, and a remote-only row IS its
 * remote ref, so naming it would just repeat the BRANCH column.
 *
 * `THIS DISK ONLY` is never printed on a merged row. It is an alert about work
 * at risk, and a merged row has none — firing the loudest marker in the table on
 * the rows needing no attention is how a real warning stops being read.
 *
 * Epic design D5.
 */
function backup(row: BranchRow): string {
  if (row.disposition === 'merged') {
    if (row.remote == null || row.isRemoteOnly) return '—';
    return row.remote.inSync ? row.remote.ref : `${row.remote.ref} (differs)`;
  }
  if (row.remote == null) return 'THIS DISK ONLY';
  return row.remote.inSync ? row.remote.ref : `${row.remote.ref} (differs)`;
}

/**
 * FILES — changed against the baseline, or `—` when there is nothing to change.
 *
 * A row with no unique commits changes no files: the zero is STRUCTURAL, implied
 * by AHEAD 0 on the same line, and a column of measured-looking zeroes invited
 * the reader to wonder what was counted. `—` says "not applicable" where `0`
 * said "measured, and it came out zero".
 *
 * `?` is untouched and keeps its own meaning — the count was not measured — so
 * the three states stay three states (rule 6; epic design D5).
 */
function filesCell(row: BranchRow): string {
  if (row.ahead === 0) return '—';
  return String(row.changedFileCount ?? '?');
}

/**
 * The row's verdict, with the PR-state clause removed when it is a global fact.
 *
 * `; PR state not checked` is true of EVERY row when `--prs` did not run, so as
 * a per-row clause it carries no per-row information — it appeared on every
 * unmerged row and again in the footer, four times in a real home-base run.
 * The footer states it once; the rows say what differs between them.
 *
 * The typed object is NOT touched: `row.why` still ends with the clause, because
 * a YAML consumer reading one row in isolation has no footer and still has to
 * tell "no PR" from "PR state unknown" (rule 6). This strip is a rendering
 * decision, and it fires under exactly the condition that prints the footer line
 * (`enrichments.prs` is `prIndex.available`, the same flag `decideDisposition`
 * receives as `prDataAvailable`), so the fact can never go missing from both.
 */
function whyLine(why: string, prsChecked: boolean): string {
  if (prsChecked || !why.endsWith(PR_STATE_NOT_CHECKED)) return why;
  return why.slice(0, why.length - PR_STATE_NOT_CHECKED.length);
}

/**
 * The checkout, as a path — not the word "worktree".
 *
 * "worktree" told a reader a worktree existed and then made them run `git
 * worktree list` to find it, which was the first thing every reviewer did.
 */
function checkout(row: BranchRow, repoRoot: string): string {
  if (row.worktree == null) return '—';
  const relative = row.worktree.startsWith(`${repoRoot}/`)
    ? row.worktree.slice(repoRoot.length + 1)
    : row.worktree;
  const state = row.worktreeState;
  if (state?.dirty === true) return `${relative} [UNCOMMITTED]`;
  if (state?.dirty == null && state != null) return `${relative} [state?]`;
  return relative;
}

/**
 * The merge question, as one English sentence.
 *
 * `mergeShape` (does it fast-forward?) and `mergePreview` (does it apply?) are
 * two different facts and both are worth having, but printed as two fields they
 * read as one confusing field — `merge: clean (merge-needed)` was the version
 * that prompted this rewrite. Combined, each pairing has an obvious meaning.
 *
 * Null only for a branch with no unique commits, where there is nothing to say.
 */
function mergeSentence(row: BranchRow, style: Styler): string | null {
  const preview = row.mergePreview;
  if (preview == null) {
    if (row.ahead === 0) return null;
    // Unique work and no preview: NOT CHECKED. It must never read as a merge
    // nobody had concerns about.
    return style.dim('merge into main: not checked (--merge-preview to check)');
  }
  if (preview.kind === 'unmeasured') {
    return style.alert(`merge into main COULD NOT BE CHECKED — ${preview.why}`);
  }
  if (preview.kind === 'conflicts') {
    const n = preview.conflictedFileCount ?? 0;
    return style.alert(
      `CONFLICTS with main in ${plural(n, 'file')}: ${fileList(
        preview.conflictedFiles ?? [],
        n,
        6,
      )}`,
    );
  }
  return style.ok(
    row.mergeShape.kind === 'fast-forward'
      ? 'merges into main cleanly (fast-forward, no merge commit)'
      : 'merges into main cleanly (writes a merge commit)',
  );
}

/**
 * A submodule pointer moving, as ONE short fact per row.
 *
 * `shift.why` is a paragraph — it has to be, because `merge-preview` appends it
 * to the preview's own `why` for a YAML consumer who gets no other explanation,
 * and a caller reading only that field must still learn why a conflict-free
 * merge is dangerous. Printed verbatim under every affected row it repeated the
 * mechanism once per branch (twice in a real home-base run) and buried the
 * per-row fact — which path, and which way — inside it.
 *
 * So the ledger splits them: the FACT is per row, here, and the MECHANISM is
 * stated once in the footer (`submoduleMechanismLine`). The word REVERTS stays
 * in the row line — it is what makes the row scannable, and dropping it was
 * never on the table. `merge-preview.ts` is untouched (epic design D5).
 */
function shiftLine(shift: SubmoduleShift): string {
  const move = `submodule ${shift.path} ${short(shift.baselineSha)} -> ${short(
    shift.mergedSha,
  )}`;
  if (shift.direction === 'regression') return `REVERTS ${move}`;
  if (shift.direction === 'unknown') return `${move}: direction UNKNOWN`;
  return `${move}: histories forked`;
}

/**
 * The mechanism behind a REVERTS line, said once for the whole report.
 *
 * Only when a rendered row actually has a regression or unknown shift: a
 * standing explanation of a hazard nothing in this report exhibits is a line the
 * reader learns to skip, and skipping it is exactly what must not happen on the
 * run where it does apply.
 */
function submoduleMechanismLine(rows: BranchRow[]): string | null {
  const hit = rows.some((r) =>
    (r.mergePreview?.submoduleShifts ?? []).some(
      (s) => s.direction === 'regression' || s.direction === 'unknown',
    ),
  );
  if (!hit) return null;
  return 'A merge that REVERTS a submodule reports no conflict — only one side moved the pointer, so git takes that side. Check the direction before landing.';
}

/**
 * What else is editing this branch's files.
 *
 * Folded UNDER the branch rather than kept in a section of its own. The reader
 * decides about one branch at a time, and a separate section made them hold a
 * branch name in their head while scrolling to look it up. It also removes the
 * worst confusion in the old layout: a branch could say "merges into main
 * cleanly" while a distant section said it conflicted — two different merges,
 * reading as a contradiction.
 */
function overlapLines(
  row: BranchRow,
  overlaps: OverlapReport,
  style: Styler,
): string[] {
  const mine = (overlaps.pairs ?? []).filter(
    (p) => p.a === row.name || p.b === row.name,
  );
  return mine.map((pair: BranchOverlap) => {
    const other = pair.a === row.name ? pair.b : pair.a;
    const files = `${plural(pair.sharedFileCount, 'file')} (${fileList(
      pair.sharedFiles,
      pair.sharedFileCount,
      4,
    )})`;
    const conflict = pair.conflict;
    if (conflict == null) {
      return style.dim(
        `also edited by ${other}: ${files} — the two were NOT merge-checked against each other (pair cap reached)`,
      );
    }
    if (conflict.kind === 'conflicts') {
      const n = conflict.conflictedFileCount ?? 0;
      return style.alert(
        `also edited by ${other}: ${files} — landing BOTH conflicts in ${plural(
          n,
          'file',
        )}: ${fileList(conflict.conflictedFiles ?? [], n, 4)}`,
      );
    }
    if (conflict.kind === 'unmeasured') {
      return style.alert(
        `also edited by ${other}: ${files} — whether landing both conflicts COULD NOT BE CHECKED`,
      );
    }
    return `also edited by ${other}: ${files} — landing both is still clean`;
  });
}

// ---------------------------------------------------------------------------
// The column grid
// ---------------------------------------------------------------------------

interface Columns {
  ahead: number;
  backup: number;
  behind: number;
  files: number;
  name: number;
}

/** `YYYY-MM-DD HH:MM` is 16, plus one for the `*` fallback marker. */
const DATE_WIDTH = 17;

const HEADERS = {
  ahead: 'AHEAD',
  backup: 'ALSO ON',
  behind: 'BEHIND',
  branch: 'BRANCH',
  files: 'FILES',
  lastWork: 'LAST WORK',
};

/** Widths measured over EVERY row in the report, so all sections share a grid. */
function measureColumns(rows: BranchRow[]): Columns {
  const max = (pick: (r: BranchRow) => string, floor: number): number =>
    rows.reduce((w, r) => Math.max(w, pick(r).length), floor);
  return {
    ahead: max((r) => String(r.ahead ?? '?'), HEADERS.ahead.length),
    // Measured through the SAME functions the rows print, so a cell can never be
    // wider than the column reserved for it.
    backup: max((r) => backup(r), HEADERS.backup.length),
    behind: max((r) => String(r.behind ?? '?'), HEADERS.behind.length),
    files: max((r) => filesCell(r), HEADERS.files.length),
    // A pathological branch name must not push every other column off screen.
    name: Math.min(
      52,
      max((r) => r.name, HEADERS.branch.length),
    ),
  };
}

function headerRow(cols: Columns, style: Styler): string {
  return style.dim(
    `  ${HEADERS.branch.padEnd(cols.name)}  ${HEADERS.ahead.padStart(
      cols.ahead,
    )}  ${HEADERS.behind.padStart(cols.behind)}  ${HEADERS.files.padStart(
      cols.files,
    )}  ${HEADERS.lastWork.padEnd(DATE_WIDTH)}  ${HEADERS.backup.padEnd(cols.backup)}`,
  );
}

/**
 * The date to show: when the branch was last ADVANCED, falling back to its tip.
 *
 * A trailing `*` marks the fallback, so the two are never silently
 * interchanged. A tip date on a branch whose only unique commits are merges is
 * a different fact from a work date, and that difference is the entire reason
 * `lastWork` exists.
 */
function workDate(row: BranchRow): string {
  if (row.lastWork != null) return formatTouched(row.lastWork.date, 'always');
  return `${formatTouched(row.lastCommitDate, 'always')}*`;
}

function branchRow(
  row: BranchRow,
  cols: Columns,
  style: Styler,
  repoRoot: string,
): string {
  // '?' rather than a blank cell: the value was not measured, and an empty cell
  // would read as a zero somebody forgot to print.
  const ahead = String(row.ahead ?? '?').padStart(cols.ahead);
  const behind = String(row.behind ?? '?').padStart(cols.behind);
  const files = filesCell(row).padStart(cols.files);
  const where = backup(row);
  const line = `  ${style.bold(row.name.padEnd(cols.name))}  ${ahead}  ${behind}  ${files}  ${workDate(
    row,
  ).padEnd(
    DATE_WIDTH,
  )}  ${where === 'THIS DISK ONLY' ? style.alert(where) : where}`;
  // UNCONDITIONAL on every row that has a checkout, merged rows included (epic
  // design D2). The earlier gate hid the path on merged-and-clean rows on the
  // theory that a settled row has nothing to cd into — but merged-plus-worktree
  // is precisely the `git worktree remove` cleanup list, so those are the rows
  // whose path the reader most needs. A branch name does not imply a path: the
  // two differ, and only some branches have a checkout at all.
  const place = checkout(row, repoRoot);
  return place === '—' ? line : `${line}\n      in ${place}`;
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/** The indent every line under the hidden count shares. */
const HIDDEN_INDENT = '       ';

/** What was and was not established about the branches this ledger hides. */
const HIDDEN_METHOD =
  'checked by patch-id only — nothing else about them was inspected; `--all` shows them';

/**
 * What the HIDDEN branches hold — measured, not disclaimed (epic design D4).
 *
 * The line this replaces was a disclaimer: "these were not inspected — hidden
 * does NOT mean merged". True, and useless, because the reader had no way to act
 * on it: two blind reviewers went and checked by hand and found unmerged commits
 * in nearly all of the hidden branches (2026-09-07). One `git cherry` per hidden
 * tip turns that footnote into a fact.
 *
 * It lives HERE, in the summary, and not only in the section heading, because a
 * group with zero rows is never rendered at all — a repo whose every SHOWN
 * branch is merged would otherwise print no unmerged-work heading to carry the
 * hidden count.
 *
 * THE DISCLAIMER SURVIVES, VERBATIM, when `hiddenUnmerged` is null: null means
 * NOT COMPUTED, and the one thing this block may never do is let a measurement
 * that did not happen read as a measurement that came back clean.
 */
function hiddenVerdict(
  hidden: number,
  measured: FilterSummary['hiddenUnmerged'],
  style: Styler,
): string[] {
  if (measured == null) {
    // NOT just a flag hint. Two reviewers checked what the hidden branches
    // actually held and found unmerged commits in nearly all of them — the word
    // "archive" reads as already-handled, and a bare pointer to `--all`
    // undersells that (2026-09-07).
    return [
      style.alert(
        `${HIDDEN_INDENT}these were not inspected — hidden does NOT mean merged; \`--all\` includes them`,
      ),
    ];
  }
  const lines: string[] = [];
  const {branchesWithUnmergedCommits: withWork, unmeasured} = measured;
  const checked = hidden - unmeasured;
  if (withWork > 0) {
    lines.push(
      style.alert(
        `${HIDDEN_INDENT}${withWork} of the ${plural(hidden, 'hidden branch')} ${
          withWork === 1 ? 'carries' : 'carry'
        } commits not on main (${HIDDEN_METHOD})`,
      ),
    );
  } else if (checked > 0) {
    // "none of the M" only when M is what was actually walked. With any tip
    // unmeasured the claim shrinks to the ones that were checked, because the
    // rest are UNKNOWN and folding them into a "none" is the fabrication this
    // whole field exists to prevent.
    lines.push(
      style.dim(
        unmeasured === 0
          ? `${HIDDEN_INDENT}none of the ${plural(hidden, 'hidden branch')} carries a commit not on main (${HIDDEN_METHOD})`
          : `${HIDDEN_INDENT}none of the ${plural(checked, 'hidden branch')} that could be checked carries a commit not on main (${HIDDEN_METHOD})`,
      ),
    );
  }
  if (unmeasured > 0) {
    lines.push(
      style.alert(
        `${HIDDEN_INDENT}${unmeasured} of the ${plural(hidden, 'hidden branch')} COULD NOT BE CHECKED — whether ${
          unmeasured === 1 ? 'it carries' : 'they carry'
        } commits not on main is UNKNOWN`,
      ),
    );
  }
  return lines;
}

function summaryBlock(report: RepoStatusReport, style: Styler): string[] {
  const s = report.summary;
  if (s == null) return [];
  const f = report.filtered;
  const hiddenKnown = f.excludedAsArchive != null && f.excludedAsStale != null;
  const hidden = hiddenKnown
    ? (f.excludedAsArchive ?? 0) + (f.excludedAsStale ?? 0)
    : null;

  // Zero rows are SUPPRESSED. A category with no members and no example in the
  // output is a label a cold reader cannot decode — three reviewers all asked
  // what "needs a look" meant and none could tell from a zero (2026-09-07). The
  // sections below define each category by showing it; a count with nothing
  // under it defines nothing.
  const counts: [number, string][] = [
    [s.needsJudgment, 'unmerged work'],
    [s.review, 'needs a look'],
    [s.mirrored, 'archived'],
    [s.merged, 'already merged'],
  ];
  const lines: string[] = [
    hidden == null
      ? `${plural(s.branches, 'branch')} shown (how many were hidden is UNKNOWN)`
      : `${s.branches} of ${s.branches + hidden} branches shown`,
    ...counts
      .filter(([n]) => n > 0)
      .map(([n, label]) => `  ${String(n).padStart(3)}  ${label}`),
    '',
  ];

  if (!hiddenKnown) {
    lines.push(
      style.alert(
        'Hidden: UNKNOWN — the branch listing failed, so nothing was filtered and nothing was counted',
      ),
    );
    return lines;
  }
  if (hidden === 0) {
    lines.push(
      style.dim(
        f.excludeArchive || f.sinceDays != null
          ? 'Nothing hidden — the filters ran and matched no branch'
          : 'Nothing hidden — no filters applied',
      ),
    );
    // `hidden != null` is already guaranteed by the `hiddenKnown` return above;
    // restating it is what lets the count below be a number rather than a `?? 0`
    // standing in for a measurement.
  } else if (hidden != null) {
    lines.push(`${plural(hidden, 'branch')} hidden`);
    // Same rule as the summary counts above: a reason that excluded nothing is
    // a line with no content. The filters that DID run are named in the
    // "what was and was not checked" footer either way.
    if (f.excludeArchive && (f.excludedAsArchive ?? 0) > 0) {
      lines.push(
        `  ${String(f.excludedAsArchive).padStart(3)}  on an archive/ backup branch`,
      );
    }
    if (f.sinceDays != null && (f.excludedAsStale ?? 0) > 0) {
      lines.push(
        `  ${String(f.excludedAsStale).padStart(3)}  no commit in the last ${f.sinceDays} days`,
      );
    }
    lines.push(...hiddenVerdict(hidden, f.hiddenUnmerged, style));
  }
  if ((f.keptForWorktree ?? 0) > 0) {
    lines.push(
      style.dim(
        `  ${f.keptForWorktree} branch(es) matched a filter but are shown anyway, for having a worktree`,
      ),
    );
  }
  return lines;
}

/**
 * What was checked, and what was not.
 *
 * Every line exists so an absence upstream is readable as a decision. An
 * overlap result with no pairs and a run that never compared any produce the
 * same rows otherwise — and "no conflicts between your branches" is exactly the
 * sentence somebody would act on.
 */
function methodBlock(report: RepoStatusReport, style: Styler): string[] {
  const lines: string[] = [];
  if ((report.branches ?? []).some((r) => r.lastWork == null)) {
    lines.push(
      'LAST WORK is the newest non-merge commit the branch has and the baseline does not — merging main into a branch moves its tip without advancing it. A `*` marks a row with no such commit, showing the tip date instead.',
    );
  }
  const o = report.overlaps;
  if (o.pairs == null) {
    lines.push(
      style.alert(
        'Cross-branch overlap: NOT CHECKED — nothing above says whether these branches collide with each other.',
      ),
    );
  } else {
    lines.push(
      `Cross-branch overlap: compared ${plural(
        o.candidates ?? 0,
        'branch',
      )} by changed files over ${plural(o.pairsConsidered ?? 0, 'pair')}; ${plural(
        o.pairsWithSharedFiles ?? 0,
        'pair',
      )} share a file, and ${plural(
        o.pairsConflictChecked ?? 0,
        'pair',
      )} were merge-checked against each other${
        (o.pairsSkippedByCap ?? 0) > 0
          ? `; ${plural(o.pairsSkippedByCap ?? 0, 'pair')} left UNCHECKED at the pair cap`
          : ''
      }.`,
    );
    for (const name of o.unmeasuredBranches ?? []) {
      lines.push(
        style.alert(
          `  ${name}: its changed files could not be read, so it appears in no overlap above — which does NOT mean it collides with nothing.`,
        ),
      );
    }
  }
  if (!report.enrichments.content) {
    lines.push(
      style.alert(
        'Content proofs: OFF — nothing here has been proven merged by content, so squash-merged work still shows as unmerged.',
      ),
    );
  }
  if (!report.enrichments.worktreeState) {
    lines.push(
      style.alert(
        'Working trees: NOT inspected — every "already merged" row above is a claim about commits only, and may sit on uncommitted work.',
      ),
    );
  }
  if (!report.enrichments.prs) {
    // The "Rows saying …" clause is gone with the rows that said it: no row
    // carries the per-row copy any more (see `whyLine`), so a pointer back to
    // text the reader will not find above is a wild goose chase. This line is
    // now the ONLY statement of the fact, which is why it is unconditional on
    // `--prs` being off rather than gated on any row having a PR.
    lines.push(
      `PR state: NOT checked${
        report.enrichments.prsUnavailableReason != null
          ? ` (${report.enrichments.prsUnavailableReason})`
          : ''
      } — pass \`--prs\`. Absent PR data is not the absence of a PR.`,
    );
  }
  const mechanism = submoduleMechanismLine(report.branches ?? []);
  if (mechanism != null) lines.push(style.alert(mechanism));
  return lines;
}

/**
 * EVERY non-ok finding under the entry, not just the worst one.
 *
 * `entry.why` is the worst finding's `why` and nothing else, so a second SEVERE
 * finding used to vanish from the output entirely. That is how round 2 of the
 * blind trials read "the submodule checkout has 1 commit on no remote" over a
 * checkout that was ALSO dirty and never heard about the dirt — two different
 * risks, one line, and the fragile one dropped (epic design D3).
 *
 * The findings are flattened in the same order `buildSubmoduleInventory` used
 * to pick `why` (row findings first, then each checkout's), and exactly one
 * copy of the line already printed as `why` is removed — matching `summarise`'s
 * `find`, which takes the FIRST finding at the entry's severity. Two findings
 * with identical text would otherwise silently drop the survivor.
 */
function furtherFindings(entry: SubmoduleRow): SubmoduleFinding[] {
  const all = [
    ...entry.findings,
    ...entry.checkouts.flatMap((c) => c.findings),
  ].filter((f) => f.severity !== 'ok');
  const printed = all.findIndex(
    (f) => f.severity === entry.severity && f.why === entry.why,
  );
  return printed < 0
    ? all
    : [...all.slice(0, printed), ...all.slice(printed + 1)];
}

function submoduleBlock(
  submodules: SubmoduleInventory,
  style: Styler,
): string[] {
  const notable = submodules.entries.filter((e) => e.severity !== 'ok');
  if (notable.length === 0) return [];
  const lines = [style.heading('SUBMODULES')];
  for (const entry of notable) {
    const label = `${entry.severity.toUpperCase()}  ${entry.path}`;
    lines.push(
      `  ${entry.severity === 'severe' ? style.alert(label) : label}`,
      `      ${entry.why}`,
    );
    for (const f of furtherFindings(entry)) {
      // The severity prefix appears only when it DIFFERS from the entry's:
      // repeating `SEVERE` under a row already headed SEVERE is noise, while an
      // unprefixed advisory sitting under a severe heading would read as one
      // more severe fact.
      const prefix =
        f.severity === entry.severity ? '' : `${f.severity.toUpperCase()}: `;
      const text = `${prefix}${f.why}`;
      lines.push(`      ${f.severity === 'severe' ? style.alert(text) : text}`);
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface PrettyOptions {
  /** Emit ANSI styling. Callers pass `shouldStyle()`; tests pass false. */
  color?: boolean;
}

/**
 * Render the whole report for reading.
 *
 * Never returns an all-clear it cannot support: when `branches` is null the
 * output says the repo could not be read and stops, rather than printing an
 * empty ledger that reads as a clean repo.
 */
export function renderReportPretty(
  report: RepoStatusReport,
  opts: PrettyOptions = {},
): string {
  const style = opts.color === true ? ANSI : PLAIN;
  const blocks: string[][] = [];

  // YOU ARE HERE, first. Every blind reviewer of an earlier revision ranked the
  // state of the checkout the reader is standing in as the single most missing
  // thing — the report described eleven other branches and said nothing about
  // the one under the reader's feet, including that it had unpushed commits and
  // uncommitted files (2026-09-07).
  const here = report.repo.here;
  blocks.push([
    style.heading('REPO STATUS'),
    `Repo:      ${report.repo.root}`,
    `Branch:    ${report.repo.currentBranch ?? '(detached HEAD)'}${
      here?.upstream != null
        ? `  ${here.upstream.ahead} ahead / ${here.upstream.behind} behind ${here.upstream.ref}`
        : '  (no upstream)'
    }`,
    // THE SHA, NOT JUST THE NAME (home-base-qyu1.33.6). `main` means whatever
    // `main` points at when the reader gets here; the sha is what every number
    // below was actually measured against, and printing it is what makes the
    // ledger re-checkable afterwards.
    `Baseline:  ${report.repo.baselineRef} @ ${short(report.repo.baselineSha)}  ${style.dim(
      'AHEAD = commits the branch has and this does not; BEHIND = the reverse',
    )}`,
    remoteRefsLine(report.repo.remoteRefs, style),
    here?.state?.dirty === true
      ? style.alert(
          `Uncommitted here: ${plural(here.state.changedPaths ?? 0, 'path')} — ${fileList(
            here.state.samplePaths ?? [],
            here.state.changedPaths ?? 0,
            5,
          )}`,
        )
      : here?.state?.dirty === false
        ? style.dim('Uncommitted here: none')
        : style.alert(
            "Uncommitted here: UNKNOWN — this checkout's state could not be read",
          ),
    style.dim(
      `Generated: ${formatTouched(new Date().toISOString(), 'always')}`,
    ),
  ]);

  // FIRST, and before any count: everything below is silence rather than
  // evidence while this is non-empty.
  const failures = report.enumerationFailures ?? [];
  if (failures.length > 0) {
    const lines = [
      style.alert(
        style.bold(
          'COULD NOT READ THIS REPO — treat its state as UNKNOWN, not as clean',
        ),
      ),
    ];
    for (const f of failures) {
      lines.push(`  ${f.what}: \`${f.command}\` failed`);
      lines.push(`      ${f.why}`);
      lines.push(`      ${f.diagnose}`);
    }
    blocks.push(lines);
  }

  if (report.branches == null || report.summary == null) {
    blocks.push([
      'No branch listing, so there is no ledger below. This is NOT "the repo has no branches" — see the failure above.',
    ]);
    return blocks.map((b) => b.join('\n')).join('\n\n');
  }

  blocks.push(summaryBlock(report, style));

  const cols = measureColumns(report.branches);
  for (const group of GROUPS) {
    const rows = report.branches.filter((r) => r.disposition === group.key);
    if (rows.length === 0) continue;
    // THE HEADLINE COUNTS WHAT IS HIDDEN TOO (epic design D4). `UNMERGED WORK
    // (3)` over a repo with four MORE unmerged branches the filters dropped is
    // a number every reader takes as the answer to "what is still open?", and
    // the correction was a dim line several blocks above it. Only this group
    // gets the suffix: it is the only one whose count reads as a total.
    const alsoHidden =
      group.key === 'needs-judgment'
        ? (report.filtered.hiddenUnmerged?.branchesWithUnmergedCommits ?? 0)
        : 0;
    const lines = [
      style.heading(
        alsoHidden > 0
          ? `${group.heading} (${rows.length} shown, ${alsoHidden} more hidden)`
          : `${group.heading} (${rows.length})`,
      ),
      style.dim(group.blurb),
      '',
      headerRow(cols, style),
    ];
    for (const row of rows) {
      lines.push(branchRow(row, cols, style, report.repo.root));
      const detail: string[] = [];
      if (row.lastWork != null) detail.push(style.dim(row.lastWork.subject));
      const merge = mergeSentence(row, style);
      if (merge != null) detail.push(merge);
      const dirty = row.worktreeState;
      if (dirty?.dirty === true) {
        detail.push(
          style.alert(
            `${plural(dirty.changedPaths ?? 0, 'uncommitted path')} in its checkout: ${fileList(
              dirty.samplePaths ?? [],
              dirty.changedPaths ?? 0,
              5,
            )} — ${(dirty.changedPaths ?? 0) === 1 ? 'it is' : 'these are'} on NO branch and no commit holds ${(dirty.changedPaths ?? 0) === 1 ? 'it' : 'them'}`,
          ),
        );
      } else if (dirty?.dirty == null && dirty != null) {
        detail.push(
          style.alert(
            `could not read its checkout's state (${dirty.unreadableReason}) — whether it holds uncommitted work is UNKNOWN`,
          ),
        );
      }
      // The `why` on a fully-contained row only restates the ahead/behind
      // already on its line. The squash-merge case says how the content was
      // proven, which is the whole evidence for the verdict, so it keeps its.
      if (!(row.disposition === 'merged' && row.ahead === 0)) {
        detail.push(whyLine(row.why, report.enrichments.prs));
      }
      // A submodule pointer moving the wrong way is invisible in a conflict
      // list — git takes the only side that moved and reports success — so it
      // gets its own line, above the overlap detail, on any row that has one.
      // ONE SHORT FACT per row; the mechanism is in the footer (epic design D5).
      for (const shift of row.mergePreview?.submoduleShifts ?? []) {
        if (shift.direction === 'advance') continue;
        const text = shiftLine(shift);
        detail.push(shift.direction === 'divergent' ? text : style.alert(text));
      }
      detail.push(...overlapLines(row, report.overlaps, style));
      if (detail.length > 0) {
        for (const line of detail) lines.push(`      ${line}`);
        lines.push('');
      }
    }
    while (lines[lines.length - 1] === '') lines.pop();
    blocks.push(lines);
  }

  const submodules = submoduleBlock(report.submodules, style);
  if (submodules.length > 0) blocks.push(submodules);

  const method = methodBlock(report, style);
  if (method.length > 0) {
    blocks.push([style.heading('WHAT WAS AND WAS NOT CHECKED'), ...method]);
  }

  return blocks.map((b) => b.join('\n')).join('\n\n');
}
