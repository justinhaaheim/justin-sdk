/**
 * CHECKOUT FACTS for `repo-status status --checkouts` (home-base-39co9.5; first
 * built as `justin-sdk forensics repo`, home-base-lj3x9).
 *
 * The facts a project-forensics investigator assembled by hand on 2026-09-18,
 * about twenty git commands per repo: every checkout's branch, what is
 * uncommitted in it, whether it was ever pushed, when it last moved, and which
 * open beads exist only on it.
 *
 * MERGE STATE IS NOT HERE, ON PURPOSE. The digest this came from counted
 * commits by identity and printed "N commits not on main", which a squash-merge
 * or a rebase makes false. Whether a checkout's branch is on the baseline is the
 * ledger row's `disposition` and `why` (patch-id, then file by file), and the
 * renderer reads it from there (39co9.5 R1). Nothing in this module computes or
 * implies it.
 *
 * READ ONLY. Every git call here reads; nothing is checked out, fetched or
 * written. `git show <sha>:.beads/issues.jsonl` is how a branch's beads are read
 * without touching the checkout a live session may be sitting in.
 *
 * CRITICAL RULE 7 THROUGHOUT. "No upstream" and "could not read the upstream"
 * are different facts, and so are "no beads file on this branch" and "no beads
 * only on this branch". Each unmeasured field is null plus a named entry in
 * `failures`; none of them is ever a zero standing in for "I could not tell".
 */

import {execFileSync} from 'child_process';
import {existsSync} from 'fs';

import {readWorktreeState, type WorktreeState} from './worktree-state';

export type GitRead = {error: string; ok: false} | {ok: true; value: string};

/** The first line of whatever git (or the spawn) said went wrong. */
function errorText(error: unknown): string {
  if (error != null && typeof error === 'object' && 'stderr' in error) {
    const stderr = (error as {stderr?: unknown}).stderr;
    const text =
      typeof stderr === 'string'
        ? stderr
        : Buffer.isBuffer(stderr)
          ? stderr.toString('utf8')
          : '';
    const first = text.split('\n').find((line) => line.trim() !== '');
    if (first != null) return first.trim();
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * One git read. The output is returned UNTRIMMED: porcelain status lines start
 * with a significant space, and trimming would turn ` M file` into `M file`.
 */
export function gitRead(cwd: string, args: readonly string[]): GitRead {
  try {
    const value = execFileSync('git', [...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {ok: true, value};
  } catch (error) {
    return {error: `git ${args.join(' ')}: ${errorText(error)}`, ok: false};
  }
}

/**
 * One entry of `git worktree list --porcelain`, with the fields core.ts's
 * listing does not keep (HEAD, locked, prunable, bare). core.ts stays the
 * listing the ledger is built on; this one is read only when `--checkouts`
 * asks for the per-checkout view.
 */
export interface PorcelainWorktree {
  bare: boolean;
  /** Short branch name, or null for a detached HEAD. */
  branch: string | null;
  head: string | null;
  locked: boolean;
  path: string;
  /** Git itself says the directory is gone. */
  prunable: boolean;
}

/** Parse `git worktree list --porcelain`. The first entry is the primary checkout. */
export function parseWorktreePorcelain(text: string): PorcelainWorktree[] {
  const entries: PorcelainWorktree[] = [];
  let current: PorcelainWorktree | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = {
        bare: false,
        branch: null,
        head: null,
        locked: false,
        path: line.slice('worktree '.length),
        prunable: false,
      };
      entries.push(current);
      continue;
    }
    if (current == null) continue;
    if (line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length);
    else if (line.startsWith('branch ')) {
      current.branch = line
        .slice('branch '.length)
        .replace(/^refs\/heads\//u, '');
    } else if (line === 'bare') current.bare = true;
    else if (line === 'locked' || line.startsWith('locked ')) {
      current.locked = true;
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      current.prunable = true;
    }
  }
  return entries;
}

/** `rev-list --left-right --count A...B` → {left, right}. */
function leftRight(
  repo: string,
  left: string,
  right: string,
): {left: number; right: number} | {error: string} {
  const read = gitRead(repo, [
    'rev-list',
    '--left-right',
    '--count',
    `${left}...${right}`,
  ]);
  if (!read.ok) return {error: read.error};
  const match = /^(\d+)\s+(\d+)\s*$/u.exec(read.value);
  if (match?.[1] == null || match[2] == null) {
    return {
      error: `git rev-list --left-right --count ${left}...${right}: unparseable output ${JSON.stringify(read.value)}`,
    };
  }
  return {left: Number(match[1]), right: Number(match[2])};
}

export interface Upstream {
  ahead: number;
  behind: number;
  /**
   * `tracked`: the branch's configured upstream. `same-name`: no upstream is
   * configured, but `origin/<branch>` exists and is what this is measured
   * against.
   */
  kind: 'same-name' | 'tracked';
  ref: string;
}

/**
 * The branch's relationship to the remote.
 *
 * `'none'` is a MEASURED answer: no upstream is configured and no
 * `origin/<branch>` exists, so every commit on it lives on this machine only.
 * `null` means the question could not be answered, and says why in `failures`.
 */
export function readUpstream(
  repo: string,
  branch: string,
  failures: string[],
): 'none' | Upstream | null {
  const configured = gitRead(repo, [
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    `${branch}@{upstream}`,
  ]);
  let ref: string | null = null;
  let kind: Upstream['kind'] = 'tracked';
  if (configured.ok) {
    ref = configured.value.trim();
  } else if (/no upstream configured/iu.test(configured.error)) {
    const sameName = gitRead(repo, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/remotes/origin/${branch}`,
    ]);
    if (!sameName.ok) return 'none';
    ref = `origin/${branch}`;
    kind = 'same-name';
  } else {
    failures.push(`upstream of ${branch}: ${configured.error}`);
    return null;
  }
  const counts = leftRight(repo, ref, branch);
  if ('error' in counts) {
    failures.push(`upstream of ${branch}: ${counts.error}`);
    return null;
  }
  return {ahead: counts.right, behind: counts.left, kind, ref};
}

export interface BeadRef {
  id: string;
  priority: number | null;
  status: string | null;
  title: string | null;
}

/**
 * Open beads in `branchJsonl` whose id does not appear in `baselineJsonl` at
 * all. `baselineJsonl: null` means the baseline has no beads file, so every
 * open bead on the branch is branch-only. Malformed lines are counted in
 * `malformed`, never silently dropped.
 */
export function branchOnlyOpenBeads(
  branchJsonl: string,
  baselineJsonl: string | null,
): {beads: BeadRef[]; malformed: number} {
  const baselineIds = new Set<string>();
  let malformed = 0;
  for (const line of (baselineJsonl ?? '').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const record = JSON.parse(line) as {id?: unknown};
      if (typeof record.id === 'string') baselineIds.add(record.id);
    } catch {
      malformed += 1;
    }
  }
  const beads: BeadRef[] = [];
  for (const line of branchJsonl.split('\n')) {
    if (line.trim() === '') continue;
    let record: {
      id?: unknown;
      priority?: unknown;
      status?: unknown;
      title?: unknown;
    };
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      malformed += 1;
      continue;
    }
    if (typeof record.id !== 'string') continue;
    if (record.status === 'closed' || record.status === 'tombstone') continue;
    if (baselineIds.has(record.id)) continue;
    beads.push({
      id: record.id,
      priority: typeof record.priority === 'number' ? record.priority : null,
      status: typeof record.status === 'string' ? record.status : null,
      title: typeof record.title === 'string' ? record.title : null,
    });
  }
  return {beads, malformed};
}

const BEADS_PATH = '.beads/issues.jsonl';

/** A path missing at a commit, as opposed to a read that failed. */
function isMissingPath(error: string): boolean {
  return /does not exist in|exists on disk, but not in/iu.test(error);
}

export type BranchBeads =
  | {beads: BeadRef[]; kind: 'measured'}
  | {kind: 'no-beads-file'};

export interface CheckoutFacts {
  branch: string | null;
  /** Open beads only this branch carries. Null when unmeasured (see failures). */
  branchOnlyBeads: BranchBeads | null;
  /** The directory exists on disk. */
  exists: boolean;
  failures: string[];
  head: string | null;
  isPrimary: boolean;
  lastCommitAt: string | null;
  locked: boolean;
  path: string;
  prunable: boolean;
  /**
   * What is uncommitted here, from the same reader as the ledger's
   * `worktreeState`. Null when the directory is gone, so it was never read.
   */
  state: WorktreeState | null;
  upstream: 'none' | Upstream | null;
}

/** Read the baseline's beads file once; null when it has none. */
export function readBaselineBeads(
  repo: string,
  baselineRev: string,
): GitRead | {ok: true; value: null} {
  const read = gitRead(repo, ['show', `${baselineRev}:${BEADS_PATH}`]);
  if (read.ok) return read;
  if (isMissingPath(read.error)) return {ok: true, value: null};
  return read;
}

export function readCheckoutFacts(
  repo: string,
  entry: PorcelainWorktree,
  isPrimary: boolean,
  baselineName: string,
  baselineBeads: string | null | undefined,
  knownStates: ReadonlyMap<string, WorktreeState>,
): CheckoutFacts {
  const failures: string[] = [];
  const facts: CheckoutFacts = {
    branch: entry.branch,
    branchOnlyBeads: null,
    exists: existsSync(entry.path),
    failures,
    head: entry.head,
    isPrimary,
    lastCommitAt: null,
    locked: entry.locked,
    path: entry.path,
    prunable: entry.prunable,
    state: null,
    upstream: null,
  };

  if (facts.exists) {
    // The ledger already ran `git status` in every checkout it knows; reuse
    // that reading rather than run a second one that could disagree with it.
    facts.state = knownStates.get(entry.path) ?? readWorktreeState(entry.path);
  } else {
    failures.push(
      `uncommitted: ${entry.path} does not exist on disk${entry.prunable ? ' (git marks it prunable)' : ''}`,
    );
  }

  const head = entry.head;
  if (head == null) {
    failures.push('HEAD: git worktree list gave no HEAD for this checkout');
    return facts;
  }

  const last = gitRead(repo, ['log', '-1', '--format=%cI', head]);
  if (last.ok && last.value.trim() !== '') {
    facts.lastCommitAt = last.value.trim();
  } else {
    failures.push(
      `last commit: ${last.ok ? `git log printed no date for ${head}` : last.error}`,
    );
  }

  if (entry.branch != null) {
    facts.upstream = readUpstream(repo, entry.branch, failures);
  } else {
    failures.push('upstream: detached HEAD, no branch to have one');
  }

  if (entry.branch === baselineName) {
    facts.branchOnlyBeads = {beads: [], kind: 'measured'};
  } else if (baselineBeads === undefined) {
    failures.push(
      'branch-only beads: the baseline beads file could not be read',
    );
  } else {
    const branchBeads = gitRead(repo, ['show', `${head}:${BEADS_PATH}`]);
    if (branchBeads.ok) {
      const diff = branchOnlyOpenBeads(branchBeads.value, baselineBeads);
      facts.branchOnlyBeads = {beads: diff.beads, kind: 'measured'};
      if (diff.malformed > 0) {
        failures.push(
          `branch-only beads: ${diff.malformed} malformed line(s) in ${BEADS_PATH} were skipped`,
        );
      }
    } else if (isMissingPath(branchBeads.error)) {
      facts.branchOnlyBeads = {kind: 'no-beads-file'};
    } else {
      failures.push(`branch-only beads: ${branchBeads.error}`);
    }
  }
  return facts;
}

/**
 * One repo at a glance, for `repo-status repos`: its primary checkout's branch,
 * uncommitted work, upstream and last commit, and how many checkouts it has.
 *
 * These are the per-repo facts the retired cross-project scanner gave (home-base
 * 39co9.5 R6 inventory), now read with the same readers as `--checkouts`.
 * Every field is null when unmeasured, with the reason in `failures`.
 */
export interface RepoGlance {
  branch: string | null;
  /** How many checkouts `git worktree list` names; null when it failed. */
  checkouts: number | null;
  failures: string[];
  lastCommitAt: string | null;
  state: WorktreeState | null;
  upstream: 'none' | Upstream | null;
}

export function readRepoGlance(repo: string): RepoGlance {
  const failures: string[] = [];
  const glance: RepoGlance = {
    branch: null,
    checkouts: null,
    failures,
    lastCommitAt: null,
    state: null,
    upstream: null,
  };
  const list = gitRead(repo, ['worktree', 'list', '--porcelain']);
  if (!list.ok) {
    failures.push(`checkouts: ${list.error}`);
    return glance;
  }
  const entries = parseWorktreePorcelain(list.value).filter((e) => !e.bare);
  glance.checkouts = entries.length;
  const primary = entries[0];
  if (primary == null) {
    failures.push('checkouts: git worktree list named no checkout');
    return glance;
  }
  glance.branch = primary.branch;
  if (existsSync(primary.path)) {
    glance.state = readWorktreeState(primary.path);
  } else {
    failures.push(`uncommitted: ${primary.path} does not exist on disk`);
  }
  if (primary.branch != null) {
    glance.upstream = readUpstream(repo, primary.branch, failures);
  }
  if (primary.head == null) {
    failures.push('last commit: git worktree list gave no HEAD');
  } else {
    const last = gitRead(repo, ['log', '-1', '--format=%cI', primary.head]);
    if (last.ok && last.value.trim() !== '') {
      glance.lastCommitAt = last.value.trim();
    } else {
      failures.push(
        `last commit: ${last.ok ? 'git log printed no date' : last.error}`,
      );
    }
  }
  return glance;
}

/**
 * Every checkout of the repo, primary first. `checkouts` is NULL, with the
 * reason in `failures`, when git could not list them — never an empty list
 * standing in for "could not tell".
 */
export interface CheckoutsReport {
  checkouts: CheckoutFacts[] | null;
  failures: string[];
}

/**
 * Every checkout of `repo`, read against the ledger's PINNED baseline: the
 * baseline's beads are read at `baseline.sha`, the commit every ledger row was
 * measured against, so the two halves of one report describe one repo state.
 */
export function readCheckouts(
  repo: string,
  baseline: {name: string; sha: string},
  knownStates: ReadonlyMap<string, WorktreeState>,
): CheckoutsReport {
  const failures: string[] = [];
  const list = gitRead(repo, ['worktree', 'list', '--porcelain']);
  if (!list.ok) {
    failures.push(`checkouts: ${list.error}`);
    return {checkouts: null, failures};
  }

  let baselineBeads: string | null | undefined;
  const read = readBaselineBeads(repo, baseline.sha);
  if (read.ok) baselineBeads = read.value;
  else failures.push(`baseline beads: ${read.error}`);

  const entries = parseWorktreePorcelain(list.value).filter(
    (entry) => !entry.bare,
  );
  return {
    checkouts: entries.map((entry, index) =>
      readCheckoutFacts(
        repo,
        entry,
        index === 0,
        baseline.name,
        baselineBeads,
        knownStates,
      ),
    ),
    failures,
  };
}
