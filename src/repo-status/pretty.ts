/**
 * repo-status — the same report, written for a person.
 *
 * YAML stays the default and that is deliberate: the primary caller of this
 * tool is an agent, and a consistently-keyed object is what an agent should
 * read. But the object is 58KB for 20 branches, and nobody reads 58KB in a
 * terminal. This renders it at the density a human scans — one line per branch,
 * grouped by what to do about it, detail indented underneath.
 *
 * A PURE FUNCTION over `RepoStatusReport`. It runs no git, reads no files, and
 * computes no verdicts; everything it prints is already in the object, which is
 * what keeps this format from quietly becoming a third source of truth
 * (home-base-qyu1.33.4).
 *
 * TWO THINGS IT MUST NOT DO, both learned from the failures this tool is built
 * around:
 *
 *   * Print an all-clear over a repo git could not read. Enumeration failures
 *     are rendered FIRST and the summary line is never shown as if it were
 *     complete.
 *   * Leave a warning on stderr only. `emit` already puts severe submodule rows
 *     and enumeration failures there, but a person reading a terminal sees the
 *     two streams interleaved and will not reliably attribute a line to either,
 *     and a person redirecting stdout to a file loses them outright. So they
 *     appear in this body too.
 *
 * No color and no table library. Terminal width is unknowable when output is
 * piped, and a wrapped table is less readable than plain lines.
 */

import {formatTouched} from '../plugin/lib/repo-status/prime-view';

import type {RepoStatusReport, BranchRow} from './report';
import type {Disposition} from './disposition';
import type {OverlapReport} from './overlap';
import type {SubmoduleInventory} from './submodules';

const GROUPS: {heading: string; key: Disposition; blurb: string}[] = [
  {
    blurb: 'real unmerged work, with nothing proving it is preserved anywhere',
    heading: 'NEEDS JUDGMENT',
    key: 'needs-judgment',
  },
  {
    blurb: 'evidence conflicts or is incomplete — look before acting',
    heading: 'REVIEW',
    key: 'review',
  },
  {
    blurb: 'not on the baseline, but held in full by an archive/* mirror',
    heading: 'MIRRORED',
    key: 'mirrored',
  },
  {
    blurb: 'every unique commit is on the baseline by content — nothing to lose',
    heading: 'MERGED',
    key: 'merged',
  },
];

/** `1 branch` / `13 branches` — the sibilant endings need `es`, not `s`. */
function plural(n: number, word: string): string {
  if (n === 1) return `${n} ${word}`;
  const suffix = /(?:ch|sh|s|x|z)$/.test(word) ? 'es' : 's';
  return `${n} ${word}${suffix}`;
}

/** A path list, capped, with the remainder counted rather than dropped. */
function fileList(files: string[], total: number, cap: number): string {
  const shown = files.slice(0, cap);
  const hidden = total - shown.length;
  return `${shown.join(', ')}${hidden > 0 ? `, +${hidden} more` : ''}`;
}

/** `41 ahead, 60 behind` — or the fact that neither number exists. */
function divergence(row: BranchRow): string {
  if (row.ahead == null || row.behind == null) return 'divergence UNMEASURED';
  return `${row.ahead} ahead, ${row.behind} behind`;
}

function branchLines(row: BranchRow, nameWidth: number): string[] {
  const markers: string[] = [];
  if (row.worktree != null) markers.push('worktree');
  if (row.isRemoteOnly) markers.push('remote-only');
  if (row.pr != null) {
    markers.push(`PR #${row.pr.number} ${row.pr.state.toLowerCase()}`);
  }
  if (row.changedFileCount != null) {
    markers.push(plural(row.changedFileCount, 'file'));
  }

  const lines = [
    `  ${row.name.padEnd(nameWidth)}  ${divergence(row)}  ·  ${formatTouched(row.lastCommitDate)}${
      markers.length > 0 ? `  ·  ${markers.join(' · ')}` : ''
    }`,
  ];

  // The merge line is the one a reader is here for, so it goes above `why`.
  const preview = row.mergePreview;
  if (preview != null) {
    if (preview.kind === 'conflicts') {
      lines.push(
        `      merge: CONFLICTS in ${plural(preview.conflictedFileCount ?? 0, 'file')} — ${fileList(
          preview.conflictedFiles ?? [],
          preview.conflictedFileCount ?? 0,
          6,
        )}`,
      );
    } else if (preview.kind === 'clean') {
      lines.push(
        `      merge: clean (${row.mergeShape.kind})`,
      );
    } else {
      lines.push(`      merge: UNMEASURED — ${preview.why}`);
    }
  } else if (row.ahead !== 0) {
    // Silence must be a claim: a row with unique work and no preview was not
    // checked, and that must not read as a merge nobody had concerns about.
    lines.push('      merge: not previewed');
  }

  // A `merged` row with no unique commits explains itself: its `why` is a
  // restatement of the ahead/behind already on the line above. The squash-merge
  // case (merged WITH unique commits) says how the content was proven, which is
  // the whole evidence for the verdict, so that one keeps its line.
  const boilerplate = row.disposition === 'merged' && row.ahead === 0;
  if (!boilerplate) lines.push(`      ${row.why}`);
  return lines;
}

function renderOverlaps(overlaps: OverlapReport): string[] {
  const lines = ['CROSS-BRANCH OVERLAP — which open branches are in each other\'s way', `  ${overlaps.why}`];
  for (const pair of overlaps.pairs ?? []) {
    const verdict =
      pair.conflict == null
        ? 'NOT merge-checked (pair cap)'
        : pair.conflict.kind === 'conflicts'
          ? `CONFLICT in ${plural(pair.conflict.conflictedFileCount ?? 0, 'file')}`
          : pair.conflict.kind === 'clean'
            ? 'merge each other cleanly'
            : 'merge check UNMEASURED';
    lines.push(`  ${pair.a}  ✕  ${pair.b}`);
    lines.push(
      `      ${verdict}; ${plural(pair.sharedFileCount, 'shared file')} — ${fileList(
        pair.sharedFiles,
        pair.sharedFileCount,
        6,
      )}`,
    );
  }
  for (const name of overlaps.unmeasuredBranches ?? []) {
    lines.push(`  ${name}: changed files UNREADABLE — appears in no pair above`);
  }
  return lines;
}

function renderSubmodules(submodules: SubmoduleInventory): string[] {
  const notable = submodules.entries.filter((e) => e.severity !== 'ok');
  if (notable.length === 0) return [];
  const lines = ['SUBMODULES'];
  for (const entry of notable) {
    lines.push(`  ${entry.severity.toUpperCase()}  ${entry.path}`);
    lines.push(`      ${entry.why}`);
  }
  return lines;
}

/** The filtering line — printed always, including when nothing was filtered. */
function renderFiltered(report: RepoStatusReport): string {
  const f = report.filtered;
  if (f.excludedAsArchive == null || f.excludedAsStale == null) {
    return '  hidden: UNKNOWN — the branch listing failed, so nothing was filtered and nothing was counted';
  }
  const parts: string[] = [];
  parts.push(
    f.excludeArchive
      ? `${f.excludedAsArchive} archive/* mirror(s)`
      : 'archive/* mirrors shown',
  );
  parts.push(
    f.sinceDays == null
      ? 'no age window'
      : `${f.excludedAsStale} with no commit in ${f.sinceDays}d`,
  );
  if ((f.keptForWorktree ?? 0) > 0) {
    parts.push(`${f.keptForWorktree} kept anyway for having a worktree`);
  }
  const anyHidden = f.excludedAsArchive > 0 || f.excludedAsStale > 0;
  return `  hidden: ${parts.join(' · ')}${anyHidden ? '  (--all to show)' : ''}`;
}

/**
 * Render the whole report as a human-readable ledger.
 *
 * Never returns an all-clear it cannot support: when `branches` is null the
 * output says the repo could not be read and stops, rather than printing an
 * empty ledger that reads as a clean repo.
 */
export function renderReportPretty(report: RepoStatusReport): string {
  const blocks: string[][] = [];

  blocks.push([
    `${report.repo.root}`,
    `  on ${report.repo.currentBranch ?? 'a detached HEAD'} · baseline ${report.repo.baselineRef}`,
  ]);

  // FIRST, and before any count: everything below is silence rather than
  // evidence while this is non-empty.
  const failures = report.enumerationFailures ?? [];
  if (failures.length > 0) {
    const lines = ['COULD NOT READ THIS REPO — treat the state as UNKNOWN, not clean'];
    for (const f of failures) {
      lines.push(`  ${f.what}: \`${f.command}\` failed`);
      lines.push(`      ${f.why}`);
      lines.push(`      ${f.diagnose}`);
    }
    blocks.push(lines);
  }

  if (report.branches == null || report.summary == null) {
    blocks.push([
      'No branch ledger. This is NOT "no branches" — see the failure above.',
    ]);
    return blocks.map((b) => b.join('\n')).join('\n\n');
  }

  const s = report.summary;
  blocks.push([
    `  ${plural(s.branches, 'branch')} shown — ${s.needsJudgment} needs-judgment, ${s.review} review, ${s.mirrored} mirrored, ${s.merged} merged`,
    renderFiltered(report),
    ...(report.enrichments.prs
      ? []
      : [
          `  PR state: UNAVAILABLE${
            report.enrichments.prsUnavailableReason != null
              ? ` — ${report.enrichments.prsUnavailableReason}`
              : ''
          }`,
        ]),
  ]);

  for (const group of GROUPS) {
    const rows = report.branches.filter((r) => r.disposition === group.key);
    if (rows.length === 0) continue;
    const nameWidth = Math.min(
      44,
      rows.reduce((w, r) => Math.max(w, r.name.length), 0),
    );
    blocks.push([
      `${group.heading} (${rows.length}) — ${group.blurb}`,
      ...rows.flatMap((r) => branchLines(r, nameWidth)),
    ]);
  }

  if (report.enrichments.overlaps) {
    blocks.push(renderOverlaps(report.overlaps));
  }

  const submoduleLines = renderSubmodules(report.submodules);
  if (submoduleLines.length > 0) blocks.push(submoduleLines);

  return blocks.map((b) => b.join('\n')).join('\n\n');
}
