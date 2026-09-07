/**
 * repo-status — is there work in a checkout that no commit has captured?
 *
 * WHY THIS EXISTS. The ledger's most consequential sentence is the one over the
 * merged group: every commit is on main, so there is nothing here to lose. That
 * sentence authorises deleting a branch and its worktree — and until this
 * module existed it was emitted having never looked at a working tree. Three
 * independent blind reviews of the output found the same thing on this very
 * repo: two worktrees sitting under "nothing to lose here" with uncommitted
 * edits in them, one of them a one-line config change that was plausibly the
 * entire point of the branch.
 *
 * That is the rule-6 shape exactly. "Every COMMIT is on main" is true and
 * provable; "nothing to lose" is a bigger claim about a thing that was never
 * measured, and it fails in the reassuring direction.
 *
 * COST. One `git status --porcelain` per worktree, ~40ms each. That is real but
 * it buys the difference between a safe deletion and a silent one, and it is
 * paid only by `status` — the `prime` session-start path never calls this.
 *
 * Part of home-base-qyu1.33.5.
 */

import {execFileSync} from 'child_process';

/**
 * What a checkout is holding that no commit has.
 *
 * NULL FOR THE WHOLE RECORD when `git status` could not run there, which is a
 * different statement from "clean" and is why this is not a bare boolean. A
 * worktree whose directory has been deleted out from under git is exactly the
 * case that would otherwise report clean and then be reported as safe.
 */
export interface WorktreeState {
  path: string;
  /** Null when `git status` failed — never assume clean. */
  dirty: boolean | null;
  /** How many paths are modified/untracked. Null when unmeasured. */
  changedPaths: number | null;
  /** A few of them, for the report. Empty when clean, null when unmeasured. */
  samplePaths: string[] | null;
  /** Why it could not be read. Null when it could. */
  unreadableReason: string | null;
}

const SAMPLE_CAP = 5;

/**
 * Read one checkout's uncommitted state.
 *
 * `--porcelain=v1` with `--untracked-files=normal`: untracked files COUNT here.
 * A newly written file nobody has added yet is the most easily lost thing in a
 * worktree, and the question being asked is "would deleting this destroy
 * something", not "is the index tidy".
 *
 * `--ignore-submodules=none` so a dirty submodule inside the checkout registers
 * too — in this fleet that is where the live work often is.
 */
export function readWorktreeState(path: string): WorktreeState {
  let out: string;
  try {
    out = execFileSync(
      'git',
      [
        'status',
        '--porcelain=v1',
        '--untracked-files=normal',
        '--ignore-submodules=none',
      ],
      {
        cwd: path,
        encoding: 'utf-8',
        maxBuffer: 16 * 1024 * 1024,
        stdio: 'pipe',
      },
    );
  } catch (err) {
    const detail = (err as {stderr?: string}).stderr?.trim().split('\n')[0];
    return {
      changedPaths: null,
      dirty: null,
      path,
      samplePaths: null,
      unreadableReason:
        detail != null && detail.length > 0
          ? detail
          : `\`git -C ${path} status --porcelain\` failed`,
    };
  }
  const lines = out.split('\n').filter((l) => l.trim().length > 0);
  return {
    changedPaths: lines.length,
    dirty: lines.length > 0,
    path,
    // The status code prefix is fixed-width; the path starts at column 3.
    samplePaths: lines.slice(0, SAMPLE_CAP).map((l) => l.slice(3).trim()),
    unreadableReason: null,
  };
}

/** Every checkout's uncommitted state, keyed by path. */
export function readWorktreeStates(
  paths: string[],
): Map<string, WorktreeState> {
  return new Map(paths.map((p) => [p, readWorktreeState(p)]));
}

/**
 * How far the CURRENT branch has drifted from its own upstream.
 *
 * The ledger measures every other branch against the baseline and measured the
 * baseline against nothing, so a `main` sitting on two unpushed commits looked
 * identical to a `main` in sync — while being the branch whose work is least
 * protected, since nothing else in the report tracks it.
 *
 * Null when the branch has no upstream (which is itself worth saying, and the
 * renderer says it) or when the count could not be read. Never a fabricated
 * `{0, 0}`: zero unpushed commits is the single most reassuring thing this can
 * report, and it may only be printed when it was measured.
 */
export function readUpstreamDivergence(
  branch: string,
  cwd: string,
): {ahead: number; behind: number; ref: string} | null {
  let ref: string;
  try {
    ref = execFileSync(
      'git',
      // `--abbrev-ref` alone. Pairing it with `--symbolic-full-name` makes git
      // resolve the ref rather than name it, and the call fails (measured).
      ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`],
      {cwd, encoding: 'utf-8', stdio: 'pipe'},
    ).trim();
  } catch {
    return null; // no upstream configured
  }
  if (ref.length === 0) return null;
  try {
    const out = execFileSync(
      'git',
      ['rev-list', '--left-right', '--count', `${ref}...${branch}`],
      {cwd, encoding: 'utf-8', stdio: 'pipe'},
    );
    const parts = out.trim().split(/\s+/);
    const behind = Number(parts[0]);
    const ahead = Number(parts[1]);
    if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return null;
    return {ahead, behind, ref};
  } catch {
    return null;
  }
}
