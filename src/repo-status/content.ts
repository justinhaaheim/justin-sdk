/**
 * repo-status +content — proving whether a branch's work already survives on
 * the baseline, by CONTENT rather than by commit sha.
 *
 * This is the robustness core. Everything here exists to serve one overriding
 * priority: NEVER report a branch as safe to delete when it still holds work
 * that exists nowhere else. Git calls are cheap and local, so this deliberately
 * errs toward running MORE checks. Running a thousand cheap commands to reach a
 * definitive answer is a good trade when the downside is silently destroying
 * unmerged commits.
 *
 * ── Two traps this module exists to encode permanently ────────────────────────
 *
 * 1. THE DIFF-STALENESS TRAP. Do NOT judge mergedness with `git diff <baseline>
 *    <branch>`. When a branch is far BEHIND the baseline, that diff is dominated
 *    by the BASELINE's own progress and looks enormous even when the branch's
 *    own content landed long ago. During the reconcile that motivated this tool,
 *    branches 250–750 commits behind main showed huge diffs that masked exactly
 *    that. Mergedness is decided per-commit by patch-id, never by a range diff.
 *
 * 2. THE ARCHIVE-MIRROR STALENESS TRAP. A branch `enhance-tamagui-theme` HAD an
 *    `archive/enhance-tamagui-theme` mirror — but `origin/enhance-tamagui-theme`
 *    was 122 commits AHEAD of that mirror. A naive "a mirror exists, therefore
 *    the branch is safe to delete" would have silently destroyed 122 unmerged
 *    commits. Mirror freshness is therefore computed in BOTH directions, and
 *    against the remote counterpart as well as the local ref.
 *
 * Part of home-base-qyu1.2 / qyu1.3.
 */

import {execFileSync} from 'child_process';

const ARCHIVE_PREFIX = 'archive/';

function gitArgv(argv: string[], cwd: string): string | null {
  try {
    return execFileSync('git', argv, {cwd, encoding: 'utf-8', stdio: 'pipe'});
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FileStatus =
  /** The baseline's version of this path is byte-identical to the branch's. */
  | 'identical'
  /** The path exists on both sides but the contents differ. */
  | 'differs'
  /** The commit's version exists, but the baseline has no such path at all. */
  | 'absent-on-baseline'
  /** The commit deleted this path and the baseline has also dropped it. */
  | 'deletion-reflected'
  /** The commit deleted this path but the baseline still has it. */
  | 'deletion-not-reflected';

export interface FileVerdict {
  path: string;
  status: FileStatus;
}

export interface CommitVerdict {
  sha: string;
  subject: string;
  /**
   * True when `git cherry` found a patch-id-equivalent commit on the baseline.
   * This is what sees through squash-merge, rebase and cherry-pick: a different
   * sha carrying identical content.
   */
  patchIdPresent: boolean;
  /**
   * For commits with NO patch-id equivalent: whether every path the commit
   * touched is nonetheless already reflected on the baseline. A commit can land
   * via a squash that reshaped history enough to defeat patch-id, so this is the
   * comprehensive fallback. Null when not computed (patch-id already proved it).
   */
  allFilesReflected: boolean | null;
  files: FileVerdict[];
}

export interface ArchiveMirror {
  /** The mirror ref inspected, e.g. `archive/enhance-tamagui-theme`. */
  ref: string;
  exists: boolean;
  /** True when the branch IS itself an archive/* mirror, so has no mirror of its own. */
  isArchiveRef: boolean;
  /**
   * The worst case across the branch and its remote counterpart: how many
   * commits exist that the mirror does NOT have. ANY value above zero means the
   * mirror is STALE and the branch must not be treated as safely archived.
   */
  commitsMissingFromMirror: number;
  /** Which ref produced that worst case (useful when it is the remote, not the local). */
  staleAgainst: string | null;
  isExact: boolean;
}

export interface ContentProof {
  baselineRef: string;
  branch: string;
  /** Commits the branch has that the baseline lacks by sha. */
  uniqueCommits: CommitVerdict[];
  /** Unique commits whose content is NOT demonstrably present on the baseline. */
  unaccountedCommits: CommitVerdict[];
  archiveMirror: ArchiveMirror | null;
  /**
   * The load-bearing conclusion. True ONLY when every unique commit is proven
   * present on the baseline by content. Archive mirroring is reported
   * separately and deliberately does NOT feed this flag.
   */
  allContentOnBaseline: boolean;
}

// ---------------------------------------------------------------------------
// Per-commit content checks
// ---------------------------------------------------------------------------

/** Blob sha of `<ref>:<path>`, or null when the path does not exist there. */
function blobSha(ref: string, path: string, cwd: string): string | null {
  return gitArgv(['rev-parse', `${ref}:${path}`], cwd)?.trim() ?? null;
}

/**
 * Which paths a commit touched, with its own status letter.
 * `-m --first-parent` makes merge commits report a diff instead of nothing.
 */
function changedPaths(
  sha: string,
  cwd: string,
): {path: string; status: string}[] {
  const out = gitArgv(
    ['show', '--name-status', '--format=', '-m', '--first-parent', sha],
    cwd,
  );
  if (out == null) return [];

  const seen = new Set<string>();
  const result: {path: string; status: string}[] = [];
  for (const line of out.split('\n')) {
    if (line.trim().length === 0) continue;
    const parts = line.split('\t');
    const status = parts[0]?.trim();
    // Renames/copies report "R100\told\tnew" — the post-state path is last.
    const path = parts[parts.length - 1]?.trim();
    if (status == null || path == null || path.length === 0) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    result.push({path, status: status[0] ?? '?'});
  }
  return result;
}

/**
 * Compare every path a commit touched against the baseline.
 *
 * This is the comprehensive fallback for commits patch-id could not match. It
 * compares blob shas, so it is exact rather than a heuristic spot-check — the
 * motivating reconcile got burned by checking one signature file and
 * generalising from it.
 */
export function verifyCommitFiles(
  sha: string,
  baselineRef: string,
  cwd: string,
): FileVerdict[] {
  return changedPaths(sha, cwd).map(({path, status}) => {
    const onBaseline = blobSha(baselineRef, path, cwd);

    if (status === 'D') {
      return {
        path,
        status:
          onBaseline == null
            ? 'deletion-reflected'
            : ('deletion-not-reflected' as FileStatus),
      };
    }
    if (onBaseline == null) return {path, status: 'absent-on-baseline'};
    const onCommit = blobSha(sha, path, cwd);
    return {
      path,
      status:
        onCommit != null && onCommit === onBaseline ? 'identical' : 'differs',
    };
  });
}

// ---------------------------------------------------------------------------
// Archive mirrors
// ---------------------------------------------------------------------------

function refExists(ref: string, cwd: string): boolean {
  return gitArgv(['rev-parse', '--verify', '--quiet', ref], cwd) != null;
}

/** Commits `ref` has that `other` lacks. */
function countAhead(ref: string, other: string, cwd: string): number {
  const out = gitArgv(['rev-list', '--count', `${other}..${ref}`], cwd);
  const n = Number(out?.trim() ?? '0');
  return Number.isFinite(n) ? n : 0;
}

/**
 * Inspect the archive mirror for a branch, in BOTH directions and against the
 * remote counterpart as well as the local ref.
 *
 * Checking only "does a mirror exist" is the exact mistake that would have
 * destroyed 122 commits (see the module header). Checking only the LOCAL branch
 * against the mirror is the same mistake one level down: the local ref can sit
 * at the mirror point while the remote has moved far ahead.
 */
export function inspectArchiveMirror(
  branch: string,
  cwd: string,
): ArchiveMirror | null {
  // Strip any remote prefix so `origin/foo` still looks for `archive/foo`.
  const bare = branch.startsWith('origin/')
    ? branch.slice('origin/'.length)
    : branch;

  // An archive/* branch IS a mirror. Looking for a mirror OF it would build the
  // nonsense ref `archive/archive/foo`, which never exists — reporting "no
  // mirror" for something that is itself the mirror is actively misleading.
  if (bare.startsWith(ARCHIVE_PREFIX)) {
    return {
      commitsMissingFromMirror: 0,
      exists: false,
      isArchiveRef: true,
      isExact: false,
      ref: bare,
      staleAgainst: null,
    };
  }

  const ref = `${ARCHIVE_PREFIX}${bare}`;

  if (!refExists(ref, cwd)) {
    return {
      commitsMissingFromMirror: 0,
      exists: false,
      isArchiveRef: false,
      isExact: false,
      ref,
      staleAgainst: null,
    };
  }

  // Every ref that could still hold work this mirror is supposed to preserve.
  const candidates = [bare, `origin/${bare}`, branch].filter(
    (r, i, all) => all.indexOf(r) === i && refExists(r, cwd),
  );

  let worst = 0;
  let staleAgainst: string | null = null;
  for (const candidate of candidates) {
    const missing = countAhead(candidate, ref, cwd);
    if (missing > worst) {
      worst = missing;
      staleAgainst = candidate;
    }
  }

  const mirrorAhead = candidates.some((c) => countAhead(ref, c, cwd) === 0);

  return {
    commitsMissingFromMirror: worst,
    exists: true,
    isArchiveRef: false,
    isExact: worst === 0 && mirrorAhead,
    ref,
    staleAgainst,
  };
}

// ---------------------------------------------------------------------------
// The proof
// ---------------------------------------------------------------------------

/**
 * Decide, definitively, whether `branch`'s unique work already exists on
 * `baselineRef`.
 *
 * Order of evidence, cheapest first:
 *   1. `git cherry` patch-ids — catches squash/rebase/cherry-pick.
 *   2. per-changed-file blob comparison for whatever patch-id could not match.
 * Archive-mirror state is gathered but deliberately kept OUT of
 * `allContentOnBaseline`: "mirrored" and "already merged" are different claims
 * with different risks, and collapsing them is how work gets lost.
 */
export function proveContentOnBaseline(
  branch: string,
  baselineRef: string,
  cwd: string,
): ContentProof {
  const archiveMirror = inspectArchiveMirror(branch, cwd);

  // `git cherry -v <upstream> <head>`: "- sha subject" when an equivalent patch
  // is already upstream, "+ sha subject" when it is not.
  const cherry = gitArgv(['cherry', '-v', baselineRef, branch], cwd);
  if (cherry == null) {
    return {
      allContentOnBaseline: false,
      archiveMirror,
      baselineRef,
      branch,
      unaccountedCommits: [],
      uniqueCommits: [],
    };
  }

  const uniqueCommits: CommitVerdict[] = [];
  for (const line of cherry.split('\n')) {
    if (line.trim().length === 0) continue;
    const marker = line[0];
    const rest = line.slice(2).trim();
    const spaceIdx = rest.indexOf(' ');
    const sha = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
    const subject = spaceIdx === -1 ? '' : rest.slice(spaceIdx + 1);
    if (sha.length === 0) continue;

    const patchIdPresent = marker === '-';
    if (patchIdPresent) {
      uniqueCommits.push({
        allFilesReflected: null,
        files: [],
        patchIdPresent: true,
        sha,
        subject,
      });
      continue;
    }

    // No patch-id match — fall back to the comprehensive per-file comparison.
    const files = verifyCommitFiles(sha, baselineRef, cwd);
    uniqueCommits.push({
      allFilesReflected:
        files.length > 0 &&
        files.every(
          (f) => f.status === 'identical' || f.status === 'deletion-reflected',
        ),
      files,
      patchIdPresent: false,
      sha,
      subject,
    });
  }

  const unaccountedCommits = uniqueCommits.filter(
    (c) => !c.patchIdPresent && c.allFilesReflected !== true,
  );

  return {
    allContentOnBaseline: unaccountedCommits.length === 0,
    archiveMirror,
    baselineRef,
    branch,
    unaccountedCommits,
    uniqueCommits,
  };
}
