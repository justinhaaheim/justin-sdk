/**
 * Refuse a commit that stages a bead export holding conflict markers or a line
 * that is not JSON (home-base-jm5kg.11.3).
 *
 * On 2026-11-06 commit b56cc68b put markers in `.beads/issues.jsonl` on main. br
 * then would not rewrite the export (measured: `br update` exits 0, writes the
 * database and leaves the file; `br sync --flush-only` exits 7), so it fell 25
 * changes behind until another session repaired it, and `thread status` read
 * the lag as a failed handoff pickup.
 *
 * It reads the STAGED BLOB, because a commit records that and not the working
 * file. Anything it cannot read refuses: rule 7, "could not check" is not "clean".
 */

import {spawnSync} from 'node:child_process';

export const BEADS_EXPORT_PATH = '.beads/issues.jsonl';

/** home-base's export is about 10 MB. */
const MAX_EXPORT_BYTES = 512 * 1024 * 1024;

export interface ExportLineProblem {
  /** 1-based. */
  line: number;
  what: string;
}

const MARKERS = ['<<<<<<<', '|||||||', '=======', '>>>>>>>'] as const;

/** Every line of an export that is not a bead record's JSON. Empty is clean. */
export function exportLineProblems(text: string): ExportLineProblem[] {
  const problems: ExportLineProblem[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (line.trim() === '') continue;
    if (MARKERS.some((marker) => line.startsWith(marker))) {
      problems.push({
        line: index + 1,
        what: `conflict marker: ${line.slice(0, 40)}`,
      });
      continue;
    }
    try {
      JSON.parse(line);
    } catch {
      problems.push({
        line: index + 1,
        what: `not valid JSON: ${line.slice(0, 40)}`,
      });
    }
  }
  return problems;
}

export type StagedExportCheck =
  /** Not staged, or staged as a deletion: this commit records no such file. */
  | {kind: 'notStaged'}
  | {kind: 'clean'}
  | {kind: 'bad'; problems: ExportLineProblem[]}
  | {kind: 'failed'; reason: string};

function git(
  cwd: string,
  args: readonly string[],
): {ok: false; reason: string} | {ok: true; stdout: string} {
  const run = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_EXPORT_BYTES,
  });
  if (run.error != null) {
    return {ok: false, reason: `git ${args[0]}: ${run.error.message}`};
  }
  if (run.status !== 0) {
    return {
      ok: false,
      reason: `git ${args.join(' ')} exited ${run.status}: ${run.stderr.trim()}`,
    };
  }
  return {ok: true, stdout: run.stdout};
}

export function checkStagedExport(cwd: string): StagedExportCheck {
  const staged = git(cwd, [
    'diff',
    '--cached',
    '--name-only',
    '--diff-filter=d',
    '--',
    `:(top)${BEADS_EXPORT_PATH}`,
  ]);
  if (!staged.ok) return {kind: 'failed', reason: staged.reason};
  if (staged.stdout.trim() === '') return {kind: 'notStaged'};
  // `:<path>` is the index entry, and is relative to the top of the repo.
  const blob = git(cwd, ['show', `:${BEADS_EXPORT_PATH}`]);
  if (!blob.ok) return {kind: 'failed', reason: blob.reason};
  const problems = exportLineProblems(blob.stdout);
  return problems.length === 0 ? {kind: 'clean'} : {kind: 'bad', problems};
}

const SHOWN = 8;

/** Prints why, and returns the exit code. Silent when there is nothing to say. */
export function runPreCommitBeadsExport(input: {
  cwd: string;
  print: (line: string) => void;
}): number {
  const {print} = input;
  const check = checkStagedExport(input.cwd);
  if (check.kind === 'failed') {
    print(
      `Commit refused: the staged ${BEADS_EXPORT_PATH} could not be checked: ${check.reason}`,
    );
    return 1;
  }
  if (check.kind !== 'bad') return 0;
  print(
    `Commit refused: the staged ${BEADS_EXPORT_PATH} has ${check.problems.length} lines that are not bead records.`,
  );
  print('');
  for (const problem of check.problems.slice(0, SHOWN)) {
    print(`  line ${problem.line}: ${problem.what}`);
  }
  const more = check.problems.length - SHOWN;
  if (more > 0) print(`  and ${more} more`);
  print('');
  print(
    'br will not rewrite an export in this state, so every later bead write stays out of it. Settle the conflict (home-base: bun run beads:resolve-conflict), then stage the file again.',
  );
  return 1;
}
