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

/**
 * A git invocation's full outcome, exit status and stderr included.
 *
 * `gitArgv` below collapses every failure into null, which is enough whenever
 * the only question is "did git answer". It is NOT enough when the ABSENCE of
 * an answer is itself meaningful — see `lookupPathOnRef` (home-base-qyu1.24).
 */
interface GitOutcome {
  ok: boolean;
  /** Exit status; null when git could not be spawned at all. */
  status: number | null;
  stderr: string;
  stdout: string;
}

function gitOutcome(argv: string[], cwd: string): GitOutcome {
  try {
    return {
      ok: true,
      status: 0,
      stderr: '',
      stdout: execFileSync('git', argv, {cwd, encoding: 'utf-8', stdio: 'pipe'}),
    };
  } catch (err: unknown) {
    const failure: {status?: unknown; stderr?: unknown} =
      typeof err === 'object' && err !== null ? err : {};
    return {
      ok: false,
      status: typeof failure.status === 'number' ? failure.status : null,
      stderr: typeof failure.stderr === 'string' ? failure.stderr : '',
      stdout: '',
    };
  }
}

function gitArgv(argv: string[], cwd: string): string | null {
  const outcome = gitOutcome(argv, cwd);
  return outcome.ok ? outcome.stdout : null;
}

/** git's own first line of complaint, for a verdict a human has to act on. */
function firstLine(text: string, fallback: string): string {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ?? fallback;
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
  | 'deletion-not-reflected'
  /**
   * git could not READ the path on one side. Evidence is MISSING — this is not
   * a statement about the path at all, and above all it is not an absence
   * (home-base-qyu1.24).
   */
  | 'unreadable';

/** Why a path could not be read, in terms a reader can re-run. */
export interface UnreadablePath {
  /** The git command that failed, verbatim. */
  command: string;
  /** git's own first line of complaint. */
  detail: string;
  /** The ref whose copy of the path could not be read. */
  ref: string;
}

export interface FileVerdict {
  path: string;
  /**
   * Present ONLY on the DELETION half of a rename, naming the path the file
   * moved TO (home-base-qyu1.27).
   *
   * `path` on such a verdict is the OLD path — the one whose ABSENCE is the
   * claim being checked — which is the only sensible name for it and also a
   * path that does NOT appear in the commit's post-state. Without this key a
   * reader would see a `deletion-*` verdict for a file the commit did not
   * delete in any way `git show` reports, with nothing to explain it. With it,
   * the two halves of the rename are legible as one event.
   *
   * Omitted otherwise — same conditional-key discipline as `unreadable`, and
   * the reason a repo whose unique commits contain no renames produces exactly
   * the output it did before this key existed.
   */
  renamedTo?: string;
  status: FileStatus;
  /**
   * Present ONLY when `status` is `unreadable`, and omitted otherwise so a
   * healthy repo's output is byte-for-byte what it was before this key existed.
   */
  unreadable?: UnreadablePath;
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
   *
   * NULL when that could not be measured (home-base-qyu1.22) — a `rev-list`
   * naming the mirror failed, so how much the mirror is missing is UNKNOWN.
   * Unknown is not zero: zero is the value that authorises deleting the branch,
   * and it must be earned by a comparison that actually ran.
   */
  commitsMissingFromMirror: number | null;
  /** Which ref produced that worst case (useful when it is the remote, not the local). */
  staleAgainst: string | null;
  /**
   * Which ref's comparison against the mirror could not be measured, when one
   * could not be. Named in the verdict so a reader can see WHICH comparison
   * failed and re-run it by hand.
   */
  unmeasuredAgainst: string | null;
  isExact: boolean;
}

/**
 * Whether a mirror preserves EVERYTHING the branch has.
 *
 * This — not `isExact` — is the safety question. A mirror that is AHEAD of the
 * branch is a superset: it still contains every commit the branch holds, so
 * deleting the branch loses nothing. Requiring identical tips instead produced
 * false 'needs-judgment' verdicts on branches that were provably preserved
 * (caught by comparing against a hand-built classification), which quietly
 * defeats the point of the tool: shrinking the set that needs human attention.
 *
 * `isExact` is retained as informational detail, not as a safety gate.
 *
 * UNKNOWN IS NOT ZERO (home-base-qyu1.22). A mirror whose freshness could not
 * be measured preserves nothing PROVABLE, so it answers false here — the same
 * answer as a stale mirror, because the two are indistinguishable from the
 * evidence available. Spelled as an explicit null check rather than left to
 * `=== 0`: this is the gate a deletion is authorised through, and it should say
 * out loud what it refuses.
 */
export function mirrorFullyPreserves(mirror: ArchiveMirror | null): boolean {
  if (mirror == null || !mirror.exists) return false;
  if (mirror.commitsMissingFromMirror == null) return false;
  return mirror.commitsMissingFromMirror === 0;
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

/**
 * What `<ref>:<path>` is: a blob (or tree) sha, genuinely nothing, or unknown.
 *
 * ABSENT AND UNREADABLE ARE DIFFERENT ANSWERS (home-base-qyu1.24). This used to
 * be a `string | null` where null meant both, and the reassuring reading won:
 * a DELETED path that came back null was called `deletion-reflected` — "the
 * baseline dropped it too, nothing to lose" — which feeds `allFilesReflected`,
 * then `allContentOnBaseline`, then `merged` with `provenSafe: true`.
 */
export type PathOnRef =
  | {kind: 'present'; sha: string}
  | {kind: 'absent'}
  | {kind: 'unreadable'; command: string; detail: string};

/**
 * Ask a ref for a path, distinguishing "not there" from "could not look".
 *
 * WHY THIS TAKES TWO COMMANDS, AND WHY NOT stderr. The obvious discriminator is
 * the wording — `rev-parse` says `fatal: path 'x' does not exist in 'ref'` for a
 * genuine absence — and it is WRONG. Measured on git 2.50.1: destroy the tree
 * object a path lives in and `rev-parse ref:path` emits that exact sentence,
 * verbatim, for a path that IS on the ref. (It says "exists on disk, but not in"
 * instead only when the file happens to be present in the working tree — an
 * accident of the checkout, not of the ref.) So the one string a reader would
 * reach for identifies a corrupt object store as an absence.
 *
 * `git ls-tree` answers structurally instead, with no wording involved:
 *
 *   - exit 0 with a line   -> the entry is there
 *   - exit 0 with NOTHING  -> genuinely absent
 *   - non-zero             -> git could not read it (`error: Could not read
 *                             <tree>` for a missing tree, `fatal: not a tree
 *                             object` for a missing commit)
 *
 * `--full-tree` because ls-tree pathspecs are otherwise relative to the CWD
 * while `ref:path` is always relative to the tree root, and `:(literal)` because
 * a pathspec would treat `[`/`*` in a real filename as glob syntax and could
 * match a DIFFERENT file (or none).
 *
 * `rev-parse` stays the primary: it is the command that produces the sha, so the
 * common path keeps exactly the behaviour and the output it has always had, and
 * the second command runs only once the first has already failed.
 */
function lookupPathOnRef(ref: string, path: string, cwd: string): PathOnRef {
  const revParseArgv = ['rev-parse', `${ref}:${path}`];
  const revParse = gitOutcome(revParseArgv, cwd);
  const sha = revParse.stdout.trim();
  if (revParse.ok && sha.length > 0) return {kind: 'present', sha};

  const lsTreeArgv = ['ls-tree', '--full-tree', ref, '--', `:(literal)${path}`];
  const lsTree = gitOutcome(lsTreeArgv, cwd);
  if (!lsTree.ok) {
    return {
      command: `git ${lsTreeArgv.join(' ')}`,
      detail: firstLine(lsTree.stderr, `exit ${lsTree.status ?? 'unknown'}`),
      kind: 'unreadable',
    };
  }
  if (lsTree.stdout.trim().length === 0) return {kind: 'absent'};

  // ls-tree found the entry that rev-parse would not name. Whatever stopped the
  // primary command is unexplained, and an unexplained failure is not an
  // absence — the sha it should have produced is still unknown.
  return {
    command: `git ${revParseArgv.join(' ')}`,
    detail: firstLine(
      revParse.stderr,
      `exit ${revParse.status ?? 'unknown'} with no output`,
    ),
    kind: 'unreadable',
  };
}

/**
 * A `--name-status` status field: one letter, plus a similarity score for the
 * rename/copy/broken-pair forms (`R100`, `C75`, `B50`).
 */
const STATUS_RECORD = /^[A-Z][0-9]*$/;

/** One check a commit's diff asks for: a path, and the status that asked. */
interface ChangedPath {
  path: string;
  /**
   * Set only on the synthetic DELETION half of a rename, where `path` is the
   * OLD path and this is where it went. Carried through to `FileVerdict`.
   */
  renamedTo?: string;
  /**
   * The git status letter, except on the synthetic deletion half of a rename,
   * which is a `D` because that is what the rename did to the old path.
   */
  status: string;
}

/**
 * Which paths a commit touched, with its own status letter.
 * `-m --first-parent` makes merge commits report a diff instead of nothing.
 *
 * `-z` IS THE FIX, NOT A TIDINESS PREFERENCE (home-base-qyu1.26). Without it git
 * applies `core.quotePath`, which defaults to true, and hands back a C-quoted
 * ASCII rendering of any path outside 7-bit ASCII: `d/café.txt` arrives as the
 * literal 18 characters `"d/caf\303\251.txt"`, surrounding quotes included.
 * That string is not a path on any ref, so looking it up finds nothing — and for
 * a DELETED file, "found nothing on the baseline" was read as
 * `deletion-reflected`, the most reassuring verdict in this module. It feeds
 * `allFilesReflected` -> `allContentOnBaseline` -> `merged` with
 * `provenSafe: true`. So a perfectly HEALTHY repo that had ever deleted an
 * accented, CJK or emoji filename reported the branch as safe to delete while
 * the baseline still held the file. No corruption required, unlike qyu1.24 —
 * only a filename most codebases already have.
 *
 * `-z` emits the bytes git actually stored. It also removes the tab-and-newline
 * framing, which a filename containing either would otherwise break, and it is
 * why nothing here trims: under `-z` a leading or trailing space in a record IS
 * part of the filename.
 *
 * THE FRAMING IS DIFFERENT UNDER `-z`, and getting it wrong re-opens this exact
 * bug. Every record is NUL-TERMINATED and the status is its OWN record, so the
 * stream is `M\0path\0D\0path\0`, not one line per file. Renames and copies emit
 * THREE records — `R100\0old\0new\0` — of which the POST-state path is the
 * second. A parser that assumed one path per status would take `old` for a
 * rename and then read every later record off by one, turning real paths into
 * garbage that resolves nowhere, which lands straight back in
 * `deletion-reflected`. Hence `STATUS_RECORD`: a record that cannot be a status
 * means the framing assumption has broken, and the safe answer to "what did this
 * commit touch" is then NOT a half-parsed list. An empty list makes
 * `allFilesReflected` false, so the commit stays unaccounted and the branch
 * stays out of the safe group.
 *
 * A RENAME IS TWO FACTS, AND TAKING ONLY THE POST-STATE PATH CHECKS ONE OF THEM
 * (home-base-qyu1.27). qyu1.26 settled the FRAMING of the triplet and left its
 * MEANING alone: the old path was read and discarded. So `R100\0old\0new\0`
 * became the single claim "the baseline has `new`" — and a baseline that took
 * the ADD half without the DELETE half satisfies it completely. It has `new`,
 * byte-identical; it also still has `old`; and the branch was reported `merged`
 * with `provenSafe: true`. Deleting it then destroys the only remaining record
 * that `old` was supposed to be gone. An `R` therefore yields TWO entries: the
 * new path, checked as before, and the old path checked as a `D` — because that
 * is precisely what a rename does to it.
 *
 * `C` IS RULED THE OTHER WAY, DELIBERATELY. A copy leaves the source in place —
 * that is the entire difference between `C` and `R` — so asserting the old
 * path's absence would assert the opposite of what the commit did. git says so
 * in the same stream: with copy detection on, the source arrives with its own
 * `M` record right after the triplet (measured: `C100\0src\0copy\0M\0src\0`).
 * So `C` keeps exactly the behaviour it has always had, new path only.
 *
 * The post-state set below is the guard for the one shape that would make the
 * synthetic deletion wrong: an old path that is ALSO some record's new path,
 * and so present after the commit. git cannot produce it with the argv above —
 * it pairs a rename only from a source it saw DELETED — but it does under `-B`
 * (measured: `R100\0c\0a\0R100\0a\0b\0`), and one Set buys correctness that does
 * not depend on record order or on which flags a future caller adds.
 */
function changedPaths(sha: string, cwd: string): ChangedPath[] {
  const out = gitArgv(
    ['show', '-z', '--name-status', '--format=', '-m', '--first-parent', sha],
    cwd,
  );
  if (out == null) return [];

  const records = out.split('\0');
  // `-z` TERMINATES rather than separates, so the split always leaves an empty
  // tail record. Dropping it here is what lets the loop treat every remaining
  // empty record as the desync it would be.
  if (records[records.length - 1] === '') records.pop();

  // Framing first, meaning second. The whole stream is parsed into its records
  // before any verdict is decided, because deciding whether a rename's old path
  // deserves a deletion check needs to know every OTHER record's post-state
  // path — which a single forward pass does not yet have.
  const parsed: {letter: string; newPath: string; oldPath: string | null}[] = [];
  for (let i = 0; i < records.length; i += 1) {
    const status = records[i];
    if (status == null || !STATUS_RECORD.test(status)) return [];
    const letter = status.charAt(0);
    const twoPaths = letter === 'R' || letter === 'C';
    const first = records[i + 1];
    const second = twoPaths ? records[i + 2] : null;
    i += twoPaths ? 2 : 1;
    // An empty or missing record is the same desync `STATUS_RECORD` catches,
    // and it is checked on BOTH paths of a triplet now that both are used.
    if (first == null || first.length === 0) return [];
    if (!twoPaths) {
      parsed.push({letter, newPath: first, oldPath: null});
      continue;
    }
    if (second == null || second.length === 0) return [];
    parsed.push({letter, newPath: second, oldPath: first});
  }

  const postState = new Set(parsed.map((p) => p.newPath));
  const seen = new Set<string>();
  const result: ChangedPath[] = [];
  for (const {letter, newPath, oldPath} of parsed) {
    if (!seen.has(newPath)) {
      seen.add(newPath);
      result.push({path: newPath, status: letter});
    }
    // `C` is excluded on purpose — see the ruling in the doc comment above.
    if (letter !== 'R' || oldPath == null) continue;
    if (postState.has(oldPath) || seen.has(oldPath)) continue;
    seen.add(oldPath);
    result.push({path: oldPath, renamedTo: newPath, status: 'D'});
  }
  return result;
}

function unreadableVerdict(
  path: string,
  ref: string,
  lookup: {command: string; detail: string},
): FileVerdict {
  return {
    path,
    status: 'unreadable',
    unreadable: {command: lookup.command, detail: lookup.detail, ref},
  };
}

/**
 * Compare every path a commit touched against the baseline.
 *
 * This is the comprehensive fallback for commits patch-id could not match. It
 * compares blob shas, so it is exact rather than a heuristic spot-check — the
 * motivating reconcile got burned by checking one signature file and
 * generalising from it.
 *
 * "Every path a commit touched" now includes the path a rename moved AWAY from,
 * which is a second entry with the same `sha` and a `D` status (qyu1.27).
 */
export function verifyCommitFiles(
  sha: string,
  baselineRef: string,
  cwd: string,
): FileVerdict[] {
  return changedPaths(sha, cwd).map(
    ({path, renamedTo, status}): FileVerdict => {
      const verdict = verifyChangedPath(path, status, sha, baselineRef, cwd);
      // The annotation rides on whatever the verdict turned out to be,
      // `unreadable` included — which is where a reader is MOST likely to
      // wonder why a path absent from the post-state is being looked up at all.
      return renamedTo == null ? verdict : {...verdict, renamedTo};
    },
  );
}

/**
 * One path's verdict against the baseline.
 *
 * A FAILED LOOK IS NOT A FINDING (home-base-qyu1.24), and it is checked first,
 * before the branch that reads a missing path as a reflected deletion. That
 * ordering is the fix: `deletion-reflected` is the most reassuring verdict in
 * this file, and it used to be what a broken object store produced.
 *
 * Split out of `verifyCommitFiles` only so the rename annotation attaches in
 * ONE place instead of at each of the four returns below.
 */
function verifyChangedPath(
  path: string,
  status: string,
  sha: string,
  baselineRef: string,
  cwd: string,
): FileVerdict {
  const onBaseline = lookupPathOnRef(baselineRef, path, cwd);
  if (onBaseline.kind === 'unreadable') {
    return unreadableVerdict(path, baselineRef, onBaseline);
  }

  if (status === 'D') {
    return {
      path,
      status:
        onBaseline.kind === 'absent'
          ? 'deletion-reflected'
          : 'deletion-not-reflected',
    };
  }
  if (onBaseline.kind === 'absent') {
    return {path, status: 'absent-on-baseline'};
  }

  const onCommit = lookupPathOnRef(sha, path, cwd);
  // Unreadable on the COMMIT side used to read as `differs`, which degrades
  // safe — but it is still a claim about content that was never compared, and
  // it would send a reader to diff two things git cannot even open.
  if (onCommit.kind === 'unreadable') {
    return unreadableVerdict(path, sha, onCommit);
  }
  return {
    path,
    status:
      onCommit.kind === 'present' && onCommit.sha === onBaseline.sha
        ? 'identical'
        : 'differs',
  };
}

/**
 * The first path in a proof that git could not read, or null when every look
 * actually landed.
 *
 * The disposition engine needs this to refuse a row BEFORE any reassuring rule
 * reads the remaining verdicts as complete evidence. It is a search rather than
 * a stored field so that nothing has to be kept in sync, and so a healthy
 * proof carries no new key.
 */
export function findUnreadableEvidence(
  proof: ContentProof,
): (UnreadablePath & {path: string; sha: string}) | null {
  for (const commit of proof.uniqueCommits) {
    for (const file of commit.files) {
      if (file.status === 'unreadable' && file.unreadable != null) {
        return {...file.unreadable, path: file.path, sha: commit.sha};
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Archive mirrors
// ---------------------------------------------------------------------------

function refExists(ref: string, cwd: string): boolean {
  return gitArgv(['rev-parse', '--verify', '--quiet', ref], cwd) != null;
}

/**
 * Commits `ref` has that `other` lacks — or null when git could not answer.
 *
 * FAILURE IS NOT ZERO (home-base-qyu1.22). This returned 0 on any git failure,
 * and 0 here is the most reassuring number in the module: it makes
 * `commitsMissingFromMirror` zero, which makes `mirrorFullyPreserves` true,
 * which makes the disposition `mirrored` with `provenSafe: true`, which makes
 * `buildPlan` emit `delete-local-branch` — the only outright deletion the tool
 * proposes on the local path. `executePlan` re-proves before deleting, but the
 * re-proof called THIS function, so it re-confirmed the fabrication rather than
 * catching it. Exactly the qyu1.21 bug on a strictly worse path.
 *
 * The failure is reachable without any exotic transient: `git rev-parse
 * --verify` on a ref resolves from the ref file and does NOT check that the
 * object is present, so an archive mirror whose tip object is gone still passes
 * `refExists` while every `rev-list` naming it fails with "Invalid revision
 * range". Such a mirror preserves nothing at all, and the old code called it a
 * complete one.
 *
 * Empty or unparseable output is treated as failure too: git answering
 * something this cannot read is no more informative than git not answering.
 * `Number('')` is 0, so the emptiness check is what stops the same fabrication
 * from sneaking back in through the parse.
 */
export function countAhead(
  ref: string,
  other: string,
  cwd: string,
): number | null {
  const out = gitArgv(['rev-list', '--count', `${other}..${ref}`], cwd);
  const trimmed = out?.trim();
  if (trimmed == null || trimmed.length === 0) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
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
      unmeasuredAgainst: null,
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
      unmeasuredAgainst: null,
    };
  }

  // Every ref that could still hold work this mirror is supposed to preserve.
  const candidates = [bare, `origin/${bare}`, branch].filter(
    (r, i, all) => all.indexOf(r) === i && refExists(r, cwd),
  );

  let worst = 0;
  let staleAgainst: string | null = null;
  // The first candidate whose comparison git could not answer. A failed
  // comparison is NOT a clean one: skipping past it would leave `worst` at
  // whatever the other candidates said, which is a claim about a strictly
  // smaller set of refs than the one this function promises to cover.
  let unmeasuredAgainst: string | null = null;
  for (const candidate of candidates) {
    const missing = countAhead(candidate, ref, cwd);
    if (missing == null) {
      unmeasuredAgainst ??= candidate;
      continue;
    }
    if (missing > worst) {
      worst = missing;
      staleAgainst = candidate;
    }
  }

  // No candidate ref resolved at all: there is nothing this mirror was compared
  // against, and "compared against nothing" must not read as "compared and
  // found complete" — the same fabrication one level up from countAhead.
  if (candidates.length === 0) unmeasuredAgainst = bare;

  const measured = unmeasuredAgainst == null;

  // `isExact` asks whether the mirror sits ON one of these refs rather than
  // ahead of it: `countAhead(ref, c) === 0` is "the mirror holds nothing beyond
  // c". A null is not that, so the short-circuit keeps an unmeasurable mirror
  // out of the exact case (and skips git calls that already failed).
  const mirrorSitsOnACandidate =
    measured && candidates.some((c) => countAhead(ref, c, cwd) === 0);

  return {
    commitsMissingFromMirror: measured ? worst : null,
    exists: true,
    isArchiveRef: false,
    isExact: measured && worst === 0 && mirrorSitsOnACandidate,
    ref,
    staleAgainst,
    unmeasuredAgainst,
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
      // Only the two POSITIVE verdicts count, so `unreadable` fails this the
      // same way `differs` does. That is necessary but not sufficient: it makes
      // the commit unaccounted, which the disposition engine could still walk
      // past into a mirror-based reassurance — see `findUnreadableEvidence`.
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
