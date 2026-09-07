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

import {formatTouched} from '../plugin/lib/repo-status/prime-view';

import type {Disposition} from './disposition';
import type {BranchOverlap, OverlapReport} from './overlap';
import type {RepoStatusReport, BranchRow} from './report';
import type {SubmoduleInventory} from './submodules';

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

/** A path list, capped, with the remainder counted rather than dropped. */
function fileList(files: string[], total: number, cap: number): string {
  const shown = files.slice(0, cap);
  const hidden = total - shown.length;
  return `${shown.join(', ')}${hidden > 0 ? `, +${hidden} more` : ''}`;
}

/**
 * Where the branch's work EXISTS, which is the recoverable/unrecoverable line.
 *
 * Every blind reviewer ranked this the most important missing field: a branch
 * on origin survives losing this machine and a branch that is only here does
 * not, and the old output drew no distinction between them.
 */
function backup(row: BranchRow, baselineRef: string): string {
  // A branch with no unique commits has nothing at risk WHEREVER its ref lives:
  // its work is on the baseline. Flagging those as "this disk only" would fire
  // the loudest marker in the table on the ten rows that need no attention at
  // all, which is how a real warning stops being read.
  if (row.disposition === 'merged' && row.ahead === 0) return baselineRef;
  if (row.remote == null) return 'THIS DISK ONLY';
  return row.remote.inSync ? row.remote.ref : `${row.remote.ref} (differs)`;
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
function measureColumns(rows: BranchRow[], baselineRef: string): Columns {
  const max = (pick: (r: BranchRow) => string, floor: number): number =>
    rows.reduce((w, r) => Math.max(w, pick(r).length), floor);
  return {
    ahead: max((r) => String(r.ahead ?? '?'), HEADERS.ahead.length),
    backup: max((r) => backup(r, baselineRef), HEADERS.backup.length),
    behind: max((r) => String(r.behind ?? '?'), HEADERS.behind.length),
    files: max((r) => String(r.changedFileCount ?? '?'), HEADERS.files.length),
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
  baselineRef: string,
): string {
  // '?' rather than a blank cell: the value was not measured, and an empty cell
  // would read as a zero somebody forgot to print.
  const ahead = String(row.ahead ?? '?').padStart(cols.ahead);
  const behind = String(row.behind ?? '?').padStart(cols.behind);
  const files = String(row.changedFileCount ?? '?').padStart(cols.files);
  const where = backup(row, baselineRef);
  const line = `  ${style.bold(row.name.padEnd(cols.name))}  ${ahead}  ${behind}  ${files}  ${workDate(
    row,
  ).padEnd(
    DATE_WIDTH,
  )}  ${where === 'THIS DISK ONLY' ? style.alert(where) : where}`;
  // The checkout path earns its own line only where the reader would USE it —
  // an open branch they might cd into, or a checkout holding uncommitted work
  // they must look at before deleting it. Printing it under every settled row
  // doubled the height of the merged table to say what the branch name already
  // implies.
  const place = checkout(row, repoRoot);
  const worthShowing =
    place !== '—' &&
    (row.disposition !== 'merged' || row.worktreeState?.dirty !== false);
  return worthShowing ? `${line}\n      in ${place}` : line;
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

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
  } else {
    lines.push(`${plural(hidden ?? 0, 'branch')} hidden`);
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
    // NOT just a flag hint. Two reviewers checked what the hidden branches
    // actually held and found unmerged commits in nearly all of them — the word
    // "archive" reads as already-handled, and a bare pointer to `--all`
    // undersells that (2026-09-07).
    lines.push(
      style.alert(
        '       these were not inspected — hidden does NOT mean merged; `--all` includes them',
      ),
    );
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
    lines.push(
      `PR state: NOT checked${
        report.enrichments.prsUnavailableReason != null
          ? ` (${report.enrichments.prsUnavailableReason})`
          : ''
      } — pass \`--prs\`. Rows saying "PR state not checked" mean this, not that no PR exists.`,
    );
  }
  return lines;
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
    `Baseline:  ${report.repo.baselineRef}  ${style.dim(
      'AHEAD = commits the branch has and this does not; BEHIND = the reverse',
    )}`,
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

  const cols = measureColumns(report.branches, report.repo.baselineRef);
  for (const group of GROUPS) {
    const rows = report.branches.filter((r) => r.disposition === group.key);
    if (rows.length === 0) continue;
    const lines = [
      style.heading(`${group.heading} (${rows.length})`),
      style.dim(group.blurb),
      '',
      headerRow(cols, style),
    ];
    for (const row of rows) {
      lines.push(
        branchRow(row, cols, style, report.repo.root, report.repo.baselineRef),
      );
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
        detail.push(row.why);
      }
      // A submodule pointer moving the wrong way is invisible in a conflict
      // list — git takes the only side that moved and reports success — so it
      // gets its own line, above the overlap detail, on any row that has one.
      for (const shift of row.mergePreview?.submoduleShifts ?? []) {
        if (shift.direction === 'advance') continue;
        detail.push(
          shift.direction === 'divergent' ? shift.why : style.alert(shift.why),
        );
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
