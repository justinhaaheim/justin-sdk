/**
 * WORKTREE FACTS for `justin-sdk forensics repo` (home-base-lj3x9).
 *
 * The facts a project-forensics investigator assembled by hand on 2026-09-18,
 * about twenty git commands per repo: every checkout's branch, what is
 * uncommitted in it, how far it is from the baseline, whether it was ever
 * pushed, when it last moved, and which open beads exist only on it.
 *
 * READ ONLY. Every git call here reads; nothing is checked out, fetched or
 * written. `git show <sha>:.beads/issues.jsonl` is how a branch's beads are read
 * without touching the checkout a live session may be sitting in.
 *
 * CRITICAL RULE 7 THROUGHOUT. "No upstream" and "could not read the upstream"
 * are different facts, and so are "no beads file on this branch" and "no beads
 * only on this branch". Each unmeasured field is null plus a named entry in
 * `failures`; none of them is ever a zero standing in for "I could not tell".
 *
 * AHEAD/BEHIND HERE IS BY COMMIT IDENTITY. A squash-merged or rebased branch
 * still shows commits "ahead" although its content is on the baseline. That is
 * `repo-status`'s job to prove (it compares by patch-id and by file); this
 * module says so in its output rather than pretending to be that tool.
 */

import {execFileSync} from 'child_process';
import {existsSync} from 'fs';

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

export interface WorktreeEntry {
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
export function parseWorktreePorcelain(text: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
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

/**
 * The branch everything is measured against: origin/HEAD's branch when it
 * exists locally, else `main`, else `master`. Null (with the reason) when none
 * exists — never a guess.
 */
export function resolveBaseline(repo: string): GitRead {
  const candidates: string[] = [];
  const originHead = gitRead(repo, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'refs/remotes/origin/HEAD',
  ]);
  if (originHead.ok) {
    const name = originHead.value.trim().replace(/^origin\//u, '');
    if (name !== '') candidates.push(name);
  }
  candidates.push('main', 'master');
  for (const name of candidates) {
    const exists = gitRead(repo, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${name}`,
    ]);
    if (exists.ok) return {ok: true, value: name};
  }
  return {
    error: `baseline: none of ${[...new Set(candidates)].join(', ')} exists as a local branch in ${repo}`,
    ok: false,
  };
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

export interface WorktreeFacts {
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
  /** `git status --porcelain` lines. `[]` = checked and clean; null = not checked. */
  uncommitted: string[] | null;
  upstream: 'none' | Upstream | null;
  /** Commits by identity against the baseline. Null when unmeasured. */
  vsBaseline: {ahead: number; behind: number} | null;
}

/** Read the baseline's beads file once; null when it has none. */
export function readBaselineBeads(
  repo: string,
  baseline: string,
): GitRead | {ok: true; value: null} {
  const read = gitRead(repo, ['show', `${baseline}:${BEADS_PATH}`]);
  if (read.ok) return read;
  if (isMissingPath(read.error)) return {ok: true, value: null};
  return read;
}

export function readWorktreeFacts(
  repo: string,
  entry: WorktreeEntry,
  isPrimary: boolean,
  baseline: string | null,
  baselineBeads: string | null | undefined,
): WorktreeFacts {
  const failures: string[] = [];
  const facts: WorktreeFacts = {
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
    uncommitted: null,
    upstream: null,
    vsBaseline: null,
  };

  if (facts.exists) {
    const status = gitRead(entry.path, [
      'status',
      '--porcelain=v1',
      '--untracked-files=normal',
    ]);
    if (status.ok) {
      facts.uncommitted = status.value
        .split('\n')
        .filter((line) => line.trim() !== '');
    } else {
      failures.push(`uncommitted: ${status.error}`);
    }
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

  if (baseline == null) {
    failures.push('vs baseline: no baseline branch could be resolved');
  } else {
    const counts = leftRight(repo, baseline, head);
    if ('error' in counts) failures.push(`vs baseline: ${counts.error}`);
    else facts.vsBaseline = {ahead: counts.right, behind: counts.left};
  }

  if (entry.branch != null) {
    facts.upstream = readUpstream(repo, entry.branch, failures);
  } else {
    failures.push('upstream: detached HEAD, no branch to have one');
  }

  if (baseline == null) {
    failures.push('branch-only beads: no baseline branch to compare against');
  } else if (entry.branch === baseline) {
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

export interface RepoWorktrees {
  baseline: string | null;
  failures: string[];
  repo: string;
  worktrees: WorktreeFacts[];
}

/** Every checkout of `repo`, primary first. */
export function readRepoWorktrees(repo: string): RepoWorktrees {
  const failures: string[] = [];
  const result: RepoWorktrees = {
    baseline: null,
    failures,
    repo,
    worktrees: [],
  };
  const list = gitRead(repo, ['worktree', 'list', '--porcelain']);
  if (!list.ok) {
    failures.push(`worktrees: ${list.error}`);
    return result;
  }
  const baseline = resolveBaseline(repo);
  if (baseline.ok) result.baseline = baseline.value;
  else failures.push(baseline.error);

  let baselineBeads: string | null | undefined;
  if (result.baseline != null) {
    const read = readBaselineBeads(repo, result.baseline);
    if (read.ok) baselineBeads = read.value;
    else failures.push(`baseline beads: ${read.error}`);
  }

  const entries = parseWorktreePorcelain(list.value).filter(
    (entry) => !entry.bare,
  );
  result.worktrees = entries.map((entry, index) =>
    readWorktreeFacts(repo, entry, index === 0, result.baseline, baselineBeads),
  );
  return result;
}
