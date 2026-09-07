/**
 * repo-status — will this branch actually merge, and if not, where does it break?
 *
 * `mergeShape` already says whether merging FAST-FORWARDS. That is a fact about
 * sha reachability and it is free, but it is not the question anyone actually
 * asks before picking what to merge next. That question is "how hard is this
 * going to be?", and the answer is the CONFLICT SET.
 *
 * `git merge-tree --write-tree` computes a real three-way merge entirely in the
 * object store — no worktree, no index, no checkout, nothing to clean up
 * afterwards, and nothing that can disturb whatever the caller has open. On a
 * 41-ahead/60-behind branch of home-base it takes ~0.1s, so this runs per
 * branch and stays linear.
 *
 * ── THE TRAP THIS MODULE EXISTS TO CONTAIN ──────────────────────────────────
 *
 * `merge-tree` exits NON-ZERO for a conflict. It also exits non-zero when it
 * cannot merge at all. Measured 2026-09-06 on git 2.50.1:
 *
 *   conflict ................. exit 1,   stdout starts with a tree OID
 *   `not something we can merge` exit 1,   stdout EMPTY, message on stderr
 *   refusing unrelated histories exit 128, stdout EMPTY, message on stderr
 *
 * So the exit code alone cannot tell "these conflict" from "I could not look",
 * and BOTH ways of guessing are the rule-6 failure in miniature. Routing this
 * through `core.ts`'s `gitArgv` — which returns null on any non-zero exit —
 * would report every genuinely conflicting branch as unmeasured, burying the
 * signal in noise. Reading exit 1 as "conflicts" would do the more dangerous
 * thing and report a broken ref as a measured merge result.
 *
 * The discriminator is STDOUT: a real result always begins with the OID of the
 * merged tree, and a failure produces no stdout at all. That is what this
 * module keys on, and `unmeasured` is a first-class outcome carrying the exact
 * command and git's own message rather than a null anybody can mistake for
 * "clean".
 *
 * Part of home-base-qyu1.33.2.
 */

import {execFileSync} from 'child_process';

import {renderGitCommand} from '../plugin/lib/repo-status/core';

/**
 * How many conflicted paths a preview carries. The COUNT is always exact; this
 * caps only the list, so one branch that renamed a directory cannot bury the
 * ledger under a thousand paths. `branch <name>` is where the full list belongs.
 */
export const DEFAULT_CONFLICT_FILE_CAP = 20;

export type MergePreviewKind = 'clean' | 'conflicts' | 'unmeasured';

export interface MergePreview {
  kind: MergePreviewKind;
  /** What this field answers, stated so a reader never re-derives it by hand. */
  question: string;
  /** The verdict in one line. Never phrased as reassurance when unmeasured. */
  why: string;
  /**
   * Paths git reported as conflicting. `[]` when the merge is clean (measured,
   * and there are none); NULL when nothing was measured at all.
   */
  conflictedFiles: string[] | null;
  /** Exact count, uncapped. Null when nothing was measured. */
  conflictedFileCount: number | null;
  /** True when `conflictedFiles` was cut to the cap; the count is still exact. */
  conflictedFilesTruncated: boolean;
  /** The command that failed. Populated only when `kind` is `unmeasured`. */
  command: string | null;
  /**
   * Submodule pointers the merge would move. EMPTY means checked and none move;
   * NULL means the check did not run (no submodule paths were supplied), which
   * is a different claim and must not read as "no submodule moved".
   *
   * A `clean` merge can still carry a `regression` here, and that combination is
   * the reason this field exists — see `SubmoduleShift`.
   */
  submoduleShifts: SubmoduleShift[] | null;
}

const QUESTION =
  'if I merge this branch into the baseline right now, does it apply cleanly, and if not which files do I have to resolve?';

/** A completed git run, whatever its exit status. Never throws. */
interface GitRun {
  /** Exit code; null when the process could not be spawned or was signalled. */
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * `execFileSync` that reports a failure instead of throwing it away.
 *
 * `core.ts`'s `gitArgv` collapses every non-zero exit to null, which is exactly
 * right for commands where non-zero means "could not answer" — and exactly
 * wrong here, where non-zero is how the answer itself is delivered.
 */
function runGit(argv: string[], cwd: string): GitRun {
  try {
    const stdout = execFileSync('git', argv, {
      cwd,
      encoding: 'utf-8',
      // A pathological merge could print a lot; 32MB is far past anything real
      // and still bounded. Overflow surfaces as a failed run, not as a truncated
      // one silently parsed as a short conflict list.
      maxBuffer: 32 * 1024 * 1024,
      stdio: 'pipe',
    });
    return {status: 0, stderr: '', stdout};
  } catch (err) {
    const e = err as {status?: number; stderr?: string; stdout?: string};
    return {
      status: typeof e.status === 'number' ? e.status : null,
      stderr: e.stderr ?? '',
      stdout: e.stdout ?? '',
    };
  }
}

/** A 40-char sha1 or 64-char sha256 object id — what a real result starts with. */
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;


/** git's own complaint, first line only, collapsed to fit in a one-line `why`. */
function firstLine(text: string): string {
  const line = text.trim().split('\n')[0]?.trim() ?? '';
  return line.length > 0 ? line : 'no output on stderr';
}

function mergeTreeArgv(baselineRef: string, branch: string): string[] {
  return [
    'merge-tree',
    '--write-tree',
    '--name-only',
    // NUL-separated rather than newline-separated so a path containing a
    // newline — legal in git — cannot desync the parse and turn one conflicted
    // file into two invented ones.
    '-z',
    baselineRef,
    branch,
  ];
}

/**
 * Parse the `-z` payload. Shape, measured:
 *
 *   clean      `<oid>\0`
 *   conflict   `<oid>\0<path>\0…\0\0<informational messages…>`
 *
 * i.e. the first NUL-separated field is the merged tree, the fields after it up
 * to the first EMPTY field are the conflicted paths, and everything past that
 * is prose for humans. Returns null when the first field is not an OID, which
 * is how a failure that still printed something is refused.
 */
function parseConflictedPaths(stdout: string): string[] | null {
  const fields = stdout.split('\0');
  const oid = fields[0]?.trim();
  if (oid == null || !OID.test(oid)) return null;
  const paths: string[] = [];
  for (const field of fields.slice(1)) {
    if (field.length === 0) break;
    paths.push(field);
  }
  return paths;
}

/**
 * A submodule pointer the merge would MOVE, and which way.
 *
 * WHY THIS EXISTS. `merge-tree` exiting 0 means git resolved every path without
 * asking — it does NOT mean the resulting tree is what you want. A gitlink is
 * the case where those come apart hardest: when only one side moved a submodule
 * pointer, git takes that side unconditionally and reports no conflict, so a
 * branch whose submodule is MONTHS BEHIND the baseline's merges "cleanly" and
 * silently reverts it. Found in a blind review (2026-09-07): merging a live
 * feature branch here would have rolled the SDK submodule back three releases,
 * with the ledger calling the merge clean.
 *
 * `direction` is decided by ancestry, which is the only thing that makes
 * "backwards" a fact rather than a guess:
 *
 *   regression  the merged pointer is an ANCESTOR of the baseline's — the merge
 *               undoes submodule history the baseline already has
 *   advance     the baseline's is an ancestor of the merged one — an ordinary
 *               bump, which is usually the point of the branch
 *   divergent   neither reaches the other — the two histories forked
 *   unknown     ancestry could not be determined (a pointer whose commit is not
 *               in the submodule's object store, most often). NOT reassuring.
 */
export interface SubmoduleShift {
  path: string;
  /** The gitlink the baseline records today. */
  baselineSha: string;
  /** The gitlink the merged tree would record. */
  mergedSha: string;
  direction: 'advance' | 'divergent' | 'regression' | 'unknown';
  why: string;
}

export interface MergePreviewOptions {
  /** Cap on the reported path LIST. The count is never capped. */
  maxFiles?: number;
  /**
   * Submodule paths to check the merged tree against. Empty means the check did
   * not run, which is reported as such rather than as "no submodule moved".
   */
  submodulePaths?: string[];
}

/** The gitlink a tree-ish records at `path`, or null when there is none/unreadable. */
function gitlinkAt(treeish: string, path: string, cwd: string): string | null {
  const run = runGit(['ls-tree', treeish, '--', path], cwd);
  if (run.status !== 0) return null;
  // `<mode> <type> <sha>\t<path>` — a submodule is mode 160000, type commit.
  const match = /^160000 commit ([0-9a-f]{40,64})\t/.exec(run.stdout.trim());
  return match?.[1] ?? null;
}

/** Is `maybeAncestor` reachable from `descendant`? Null when git could not say. */
function isAncestor(
  maybeAncestor: string,
  descendant: string,
  cwd: string,
): boolean | null {
  const run = runGit(
    ['merge-base', '--is-ancestor', maybeAncestor, descendant],
    cwd,
  );
  if (run.status === 0) return true;
  if (run.status === 1) return false;
  // Any other status means the question was not answered — a missing object,
  // most likely. Not the same as "no".
  return null;
}

/**
 * Which submodule pointers the merged tree would move, and which way.
 *
 * Runs inside the SUBMODULE's own object store (`cwd` is the submodule path),
 * because the ancestry question is about the submodule's history, not the
 * parent's.
 */
function checkSubmoduleShifts(
  mergedTree: string,
  baselineRef: string,
  paths: string[],
  repoCwd: string,
): SubmoduleShift[] {
  const shifts: SubmoduleShift[] = [];
  for (const path of paths) {
    const mergedSha = gitlinkAt(mergedTree, path, repoCwd);
    const baselineSha = gitlinkAt(baselineRef, path, repoCwd);
    if (mergedSha == null || baselineSha == null) continue;
    if (mergedSha === baselineSha) continue;

    const subCwd = `${repoCwd}/${path}`;
    const mergedIsOlder = isAncestor(mergedSha, baselineSha, subCwd);
    const mergedIsNewer = isAncestor(baselineSha, mergedSha, subCwd);

    let direction: SubmoduleShift['direction'];
    let why: string;
    if (mergedIsOlder === null || mergedIsNewer === null) {
      direction = 'unknown';
      why = `submodule ${path} would move ${baselineSha.slice(0, 8)} -> ${mergedSha.slice(0, 8)}, but which way could not be determined — \`git -C ${path} merge-base --is-ancestor\` failed, most likely because one of those commits is not in the submodule's object store. This is NOT known to be safe.`;
    } else if (mergedIsOlder) {
      direction = 'regression';
      why = `REVERTS submodule ${path} from ${baselineSha.slice(0, 8)} back to ${mergedSha.slice(0, 8)} — an ancestor, so the merge silently UNDOES submodule history ${baselineRef} already has. git reports no conflict for this: only one side moved the pointer, so it takes that side.`;
    } else if (mergedIsNewer) {
      direction = 'advance';
      why = `advances submodule ${path} from ${baselineSha.slice(0, 8)} to ${mergedSha.slice(0, 8)} (a descendant) — an ordinary bump`;
    } else {
      direction = 'divergent';
      why = `submodule ${path} would move ${baselineSha.slice(0, 8)} -> ${mergedSha.slice(0, 8)}, and neither commit reaches the other — the submodule histories have forked, so somebody has to choose`;
    }
    shifts.push({baselineSha, direction, mergedSha, path, why});
  }
  return shifts;
}

/**
 * Preview merging `branch` into `baselineRef`.
 *
 * Call it only for branches that have something to merge — a branch with
 * `ahead === 0` has nothing to preview, and one whose divergence could not be
 * measured has already failed the walk this would repeat. `report.ts` enforces
 * both; doing it there keeps the cost proportional to the interesting rows.
 */
export function previewMerge(
  baselineRef: string,
  branch: string,
  cwd: string,
  opts: MergePreviewOptions = {},
): MergePreview {
  const maxFiles = opts.maxFiles ?? DEFAULT_CONFLICT_FILE_CAP;
  const argv = mergeTreeArgv(baselineRef, branch);
  const run = runGit(argv, cwd);
  const command = renderGitCommand(argv);

  const paths = parseConflictedPaths(run.stdout);

  // NO OID MEANS NO MEASUREMENT, whatever the exit code was. This is the branch
  // that catches a missing ref (exit 1, like a conflict), unrelated histories
  // (exit 128), a git too old for `--write-tree` (added in 2.38), and a merge
  // driver that died halfway. None of them may be reported as `clean`.
  if (paths == null) {
    return {
      command,
      conflictedFileCount: null,
      conflictedFiles: null,
      conflictedFilesTruncated: false,
      kind: 'unmeasured',
      question: QUESTION,
      submoduleShifts: null,
      why: `merge could not be previewed — \`${command}\` exited ${run.status ?? 'abnormally'} without producing a merged tree (${firstLine(run.stderr)}). Whether merging ${branch} conflicts is UNKNOWN; it is NOT known to be clean. \`git merge-tree --write-tree\` needs git >= 2.38, and refuses outright when the two sides share no common ancestor.`,
    };
  }

  // The merged tree is the first field, and it is what makes the gitlink check
  // possible at all: the question is not what the branch records, it is what the
  // MERGE RESULT would record.
  const mergedTree = run.stdout.split('\0')[0]?.trim() ?? '';
  const submodulePaths = opts.submodulePaths ?? [];
  const shifts =
    submodulePaths.length > 0
      ? checkSubmoduleShifts(mergedTree, baselineRef, submodulePaths, cwd)
      : null;
  const regressions = (shifts ?? []).filter(
    (s) => s.direction === 'regression' || s.direction === 'unknown',
  );
  // Appended to whatever verdict follows, because a clean merge that reverts a
  // submodule is still a clean merge — and still something nobody should land
  // without knowing.
  const shiftNote =
    regressions.length > 0
      ? ` WARNING: ${regressions.map((s) => s.why).join(' ')}`
      : '';

  if (paths.length === 0) {
    return {
      command: null,
      conflictedFileCount: 0,
      conflictedFiles: [],
      conflictedFilesTruncated: false,
      kind: 'clean',
      question: QUESTION,
      submoduleShifts: shifts,
      why: `merges into ${baselineRef} with no conflicts — git resolved every path on its own.${shiftNote}`,
    };
  }

  const truncated = paths.length > maxFiles;
  const shown = truncated ? paths.slice(0, maxFiles) : paths;
  return {
    command: null,
    conflictedFileCount: paths.length,
    conflictedFiles: shown,
    conflictedFilesTruncated: truncated,
    kind: 'conflicts',
    question: QUESTION,
    submoduleShifts: shifts,
    why: `merging into ${baselineRef} conflicts in ${paths.length} file${paths.length === 1 ? '' : 's'}${truncated ? ` (first ${maxFiles} listed)` : ''} — someone has to resolve ${paths.length === 1 ? 'it' : 'them'} by hand.${shiftNote}`,
  };
}
