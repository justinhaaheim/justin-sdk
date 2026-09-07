/**
 * repo-status — when was this branch last actually ADVANCED?
 *
 * A branch's tip date answers "when did this ref last move", and everyone reads
 * it as "when was this last worked on". Those come apart the moment somebody
 * merges main into a feature branch to keep it current: the tip is today, the
 * work is six weeks old, and the ledger presents a dormant branch as the
 * freshest thing in the repo.
 *
 * Three independent blind reviews of the output made exactly that mistake on
 * this repo (2026-09-07), on the same branch: tip 2026-09-05, last real commit
 * 2026-08-20 — sixteen days of "Merge branch 'main' into …" and nothing else.
 * Two of the three ranked it as the most misleading thing in the report.
 *
 * So this reads the newest NON-MERGE commit the branch has that the baseline
 * does not, with its subject. The subject is the other half of the value: it is
 * the cheapest possible answer to "what is this branch even about", which every
 * reviewer also asked for, and it comes back in the same command.
 *
 * COST. One `git log -1` per branch WITH unique work — three calls on this repo,
 * not one per ref. Callers must not ask for it on branches with `ahead === 0`,
 * where the answer is empty by construction.
 *
 * WHY IT DOES NOT DRIVE THE AGE FILTER. Filtering on this instead of the tip
 * date would be more accurate and would cost a `git log` for every branch in the
 * repo before anything could be dropped — which is precisely the work the filter
 * exists to avoid. Filtering on the tip date errs toward SHOWING a branch that
 * has only been merge-maintained, and showing too much is the safe direction.
 *
 * Part of home-base-qyu1.33.5.
 */

import {execFileSync} from 'child_process';

export interface LastWork {
  /** ISO 8601 committer date of the newest non-merge unique commit. */
  date: string;
  sha: string;
  /** Its subject line — the one-line answer to "what is this branch about". */
  subject: string;
}

const RECORD = '';

/**
 * The newest non-merge commit on `branch` that `baselineRef` does not have.
 *
 * Returns null when there is none — a branch whose only unique commits are
 * merges, or which has none at all — and null when git could not answer. Those
 * are deliberately not distinguished here: both mean "no work date to show",
 * the row still carries its tip date and its ahead count, and nothing downstream
 * reads a null as a reassurance.
 */
export function readLastWork(
  baselineRef: string,
  branch: string,
  cwd: string,
): LastWork | null {
  let out: string;
  try {
    out = execFileSync(
      'git',
      [
        'log',
        '-1',
        '--no-merges',
        `--format=%H${RECORD}%cI${RECORD}%s`,
        `${baselineRef}..${branch}`,
      ],
      {cwd, encoding: 'utf-8', maxBuffer: 1024 * 1024, stdio: 'pipe'},
    );
  } catch {
    return null;
  }
  const [sha, date, subject] = out.trim().split(RECORD);
  if (sha == null || date == null || subject == null) return null;
  if (sha.length === 0) return null;
  return {date, sha, subject};
}
