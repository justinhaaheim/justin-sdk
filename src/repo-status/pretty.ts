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
 * Part of home-base-qyu1.33.4 / qyu1.34.
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
    blurb:
      'commits that exist only on these branches — not on main, and not backed up anywhere',
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
    blurb:
      'every commit is already on main by content, so squash-merges and rebases count — nothing to lose here',
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

/** Where the branch lives, in one word. Empty for an ordinary local ref. */
function location(row: BranchRow): string {
  if (row.worktree != null) return 'worktree';
  if (row.isRemoteOnly) return 'remote-only';
  return 'local';
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
  behind: number;
  files: number;
  location: number;
  name: number;
}

const DATE_WIDTH = 16;

const HEADERS = {
  ahead: 'AHEAD',
  behind: 'BEHIND',
  branch: 'BRANCH',
  files: 'FILES',
  lastCommit: 'LAST COMMIT',
  location: 'LOCATION',
};

/** Widths measured over EVERY row in the report, so all sections share a grid. */
function measureColumns(rows: BranchRow[]): Columns {
  const max = (pick: (r: BranchRow) => string, floor: number): number =>
    rows.reduce((w, r) => Math.max(w, pick(r).length), floor);
  return {
    ahead: max((r) => String(r.ahead ?? '?'), HEADERS.ahead.length),
    behind: max((r) => String(r.behind ?? '?'), HEADERS.behind.length),
    files: max((r) => String(r.changedFileCount ?? ''), HEADERS.files.length),
    location: max(location, HEADERS.location.length),
    // A pathological branch name must not push every other column off screen.
    name: Math.min(52, max((r) => r.name, HEADERS.branch.length)),
  };
}

function headerRow(cols: Columns, style: Styler): string {
  return style.dim(
    `  ${HEADERS.branch.padEnd(cols.name)}  ${HEADERS.ahead.padStart(
      cols.ahead,
    )}  ${HEADERS.behind.padStart(cols.behind)}  ${HEADERS.lastCommit.padEnd(
      DATE_WIDTH,
    )}  ${HEADERS.location.padEnd(cols.location)}  ${HEADERS.files.padStart(
      cols.files,
    )}`,
  );
}

function branchRow(row: BranchRow, cols: Columns, style: Styler): string {
  // '?' rather than a blank cell: the divergence was not measured, and an empty
  // cell would read as a zero somebody forgot to print.
  const ahead = String(row.ahead ?? '?').padStart(cols.ahead);
  const behind = String(row.behind ?? '?').padStart(cols.behind);
  const files = String(row.changedFileCount ?? '').padStart(cols.files);
  const when = formatTouched(row.lastCommitDate, 'always').padEnd(DATE_WIDTH);
  return `  ${style.bold(row.name.padEnd(cols.name))}  ${ahead}  ${behind}  ${when}  ${location(
    row,
  ).padEnd(cols.location)}  ${files}`;
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

  const lines: string[] = [
    hidden == null
      ? `${plural(s.branches, 'branch')} shown (how many were hidden is UNKNOWN)`
      : `${s.branches} of ${s.branches + hidden} branches shown`,
    `  ${String(s.needsJudgment).padStart(3)}  unmerged work`,
    `  ${String(s.review).padStart(3)}  needs a look`,
    `  ${String(s.mirrored).padStart(3)}  archived`,
    `  ${String(s.merged).padStart(3)}  already merged`,
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
    if (f.excludeArchive) {
      lines.push(
        `  ${String(f.excludedAsArchive).padStart(3)}  archive/ backup branches`,
      );
    }
    if (f.sinceDays != null) {
      lines.push(
        `  ${String(f.excludedAsStale).padStart(3)}  no commit in the last ${f.sinceDays} days`,
      );
    }
    lines.push(style.dim('       (--all shows every branch)'));
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
      )} by changed files over ${plural(o.pairsConsidered ?? 0, 'pair')}; ${
        o.pairsWithSharedFiles
      } share a file, ${o.pairsConflictChecked} merge-checked${
        (o.pairsSkippedByCap ?? 0) > 0
          ? `, ${o.pairsSkippedByCap} left UNCHECKED at the pair cap`
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
  if (!report.enrichments.prs) {
    lines.push(
      `PR state: not included${
        report.enrichments.prsUnavailableReason != null
          ? ` (${report.enrichments.prsUnavailableReason})`
          : ''
      }.`,
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

  blocks.push([
    style.heading('REPO STATUS'),
    `Repo:      ${report.repo.root}`,
    `Branch:    ${report.repo.currentBranch ?? '(detached HEAD)'}`,
    `Baseline:  ${report.repo.baselineRef}  ${style.dim('(every branch below is compared against this)')}`,
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
    const lines = [
      style.heading(`${group.heading} (${rows.length})`),
      style.dim(group.blurb),
      '',
      headerRow(cols, style),
    ];
    for (const row of rows) {
      lines.push(branchRow(row, cols, style));
      const detail: string[] = [];
      const merge = mergeSentence(row, style);
      if (merge != null) detail.push(merge);
      // The `why` on a fully-contained row only restates the ahead/behind
      // already on its line. The squash-merge case says how the content was
      // proven, which is the whole evidence for the verdict, so it keeps its.
      if (!(row.disposition === 'merged' && row.ahead === 0)) {
        detail.push(row.why);
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
