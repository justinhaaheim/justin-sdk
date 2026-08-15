/**
 * repo-status +submodules — can anything but THIS checkout resolve the gitlink?
 *
 * A parent repo records a submodule as a bare sha (a "gitlink"). Nothing in
 * ordinary git status output ever mentions that sha, so three failures stay
 * completely invisible until they bite, and they point in different directions:
 *
 *   1. The parent commits a gitlink to a submodule commit that was never
 *      pushed. Everything looks clean locally; every fresh clone, CI run and
 *      `git worktree add` dies with "upload-pack: not our ref <sha>". This is
 *      the high-value check — cheap to make, baffling to diagnose without it.
 *   2. The submodule checkout has commits of its own that are on no remote.
 *      That is work at risk, and in a LINKED worktree it is work that
 *      `git worktree remove` deletes outright (see the store note below).
 *   3. The checkout is behind its own remote with nothing ahead. This is NOT
 *      benign, which is the correction that shaped this module: no work is at
 *      risk, but you are building on a stale base with stale DEPENDENCIES —
 *      the observed scar was a fast-forward that revealed a dependency added
 *      upstream, turning a green suite red with eleven environmental failures
 *      that cost a diagnosis cycle to attribute.
 *
 * SAME NUMBER, DIFFERENT QUESTION. That third case is why every finding here
 * carries the QUESTION its numbers answer. "Behind by 49" is pure noise for
 * "can I delete this without losing work" and load-bearing for "am I building
 * on current code". Reporting the number without the question is what made the
 * original framing wrong, so the question is a field, not a comment.
 *
 * REACHABILITY IS PER-CHECKOUT, NEVER GLOBAL. A linked worktree does NOT share
 * its submodule checkout with the primary. Each gets its own gitdir AND its own
 * object store:
 *
 *     primary   <parent>/.git/modules/<path>
 *     worktree  <parent>/.git/worktrees/<name>/modules/<path>
 *
 * with `.git` inside the submodule being a FILE holding a `gitdir:` pointer,
 * and (verified) no `alternates` linking the two. So a commit can be on the
 * remote and present in one worktree's store while `git cat-file` in another
 * calls it "not a valid object". Every row therefore names the `store` it was
 * evaluated against, and "absent from this store" is reported as its own
 * advisory-with-a-fetch rather than being collapsed into the severe
 * "not on any remote" case. Handing someone the severe diagnosis for the
 * benign state is exactly the wrong outcome.
 *
 * COST. Off the `prime` session-start path by construction: this module is
 * reached only from `buildReport`, which the session-start view never calls.
 * By default only the CURRENT checkout's store is opened; every other worktree
 * contributes one cheap `ls-tree`/`ls-files` so pointer DIVERGENCE across
 * worktrees is still detected. `allWorktreeStores` opts into opening them all,
 * which is what answers the work-at-risk question per store.
 *
 * Part of home-base-qyu1.14.
 */

import {execFileSync} from 'child_process';
import {existsSync, realpathSync} from 'fs';
import {join} from 'path';

import type {WorktreeEntry} from './types';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export type SubmoduleSeverity = 'ok' | 'advisory' | 'severe';

/**
 * The question a finding's numbers answer.
 *
 * These are spelled as whole sentences rather than terse enum tags because the
 * primary reader is Claude reading YAML, and `question: am I building on
 * current code?` needs no lookup table to interpret.
 */
export const Q_WORK_AT_RISK = 'can this be removed without losing work?';
export const Q_CURRENT_CODE = 'am I building on current code?';
export const Q_RESOLVABLE =
  'can anything but this checkout resolve the recorded pointer?';

export type SubmoduleQuestion =
  | typeof Q_WORK_AT_RISK
  | typeof Q_CURRENT_CODE
  | typeof Q_RESOLVABLE;

export type SubmoduleFindingKind =
  /** Pointer is in this store but on no remote-tracking branch. Breaks everyone else. */
  | 'pointer-not-on-remote'
  /** Pointer is not an object HERE. Says nothing about the remote — fetch and re-run. */
  | 'pointer-absent-from-store'
  /** Checkout has commits on no remote. Dies with the worktree. */
  | 'unpushed-commits'
  /** Behind its remote — stale base, and therefore probably stale dependencies. */
  | 'stale-checkout'
  /** Checkout HEAD differs from the pointer the parent has committed. */
  | 'pointer-bump-uncommitted'
  /** The parent's worktrees record different submodule commits. */
  | 'pointer-diverges-across-worktrees'
  /** No checkout in this worktree at all. */
  | 'not-initialized'
  /** No remote-tracking refs, so pushedness cannot be judged either way. */
  | 'no-remote-refs';

export interface SubmoduleFinding {
  kind: SubmoduleFindingKind;
  severity: SubmoduleSeverity;
  /** Which question this finding's numbers answer. */
  question: SubmoduleQuestion;
  /** One line, plain language — the same discipline as a branch row's `why`. */
  why: string;
  /** A concrete next action, or null when there is nothing to run. */
  fix: string | null;
}

/** One submodule as seen from ONE of the parent repo's worktrees. */
export interface SubmoduleCheckout {
  /** The parent worktree this row describes. */
  worktree: string;
  isPrimary: boolean;
  /** True for the worktree `repo-status` was pointed at. */
  isCurrent: boolean;
  /** The gitlink in this worktree's HEAD — what a clone of this branch gets. */
  recordedPointer: string | null;
  /** The gitlink staged in this worktree's index, when it differs from HEAD. */
  stagedPointer: string | null;
  /**
   * The submodule object store this row was evaluated against. Reachability is
   * a property of this store alone — never of "the repo".
   */
  store: string | null;
  /** Why `store` is null, when it is. */
  storeNote: string | null;
  checkoutHead: string | null;
  checkoutBranch: string | null;
  /** Whether `recordedPointer` resolves to a commit in `store`. */
  pointerInStore: boolean | null;
  /** Remote-tracking refs in `store` that contain `recordedPointer`. */
  pointerOnRemotes: string[] | null;
  /** Commits reachable from the checkout's HEAD but from no remote-tracking ref. */
  unpushedCommits: number | null;
  /** Commits `upstreamRef` has that the checkout does not — the stale-base number. */
  behind: number | null;
  upstreamRef: string | null;
  findings: SubmoduleFinding[];
  severity: SubmoduleSeverity;
}

export interface SubmoduleRow {
  /** Path within the parent repo, e.g. `projects/justin-sdk`. */
  path: string;
  url: string | null;
  severity: SubmoduleSeverity;
  /** One line: the worst finding, or the all-clear. */
  why: string;
  /** Distinct pointers recorded across the parent's worktrees; >1 means they disagree. */
  pointersAcrossWorktrees: number;
  /** Findings about the submodule as a whole rather than one checkout. */
  findings: SubmoduleFinding[];
  checkouts: SubmoduleCheckout[];
}

export interface SubmoduleInventory {
  enabled: boolean;
  /** True when EVERY worktree's store was opened, not just the current one. */
  allWorktreeStores: boolean;
  /** One row per submodule; explicitly empty when the repo has none. */
  entries: SubmoduleRow[];
}

export const EMPTY_SUBMODULE_INVENTORY: SubmoduleInventory = {
  allWorktreeStores: false,
  enabled: false,
  entries: [],
};

export interface SubmoduleOptions {
  /** The worktree `repo-status` was pointed at. */
  cwd: string;
  repoRoot: string;
  worktrees: WorktreeEntry[];
  /**
   * Open every worktree's submodule store, not just the current one. Off by
   * default: it is the only part of this module that reaches into directories
   * outside the worktree being inspected.
   */
  allWorktreeStores?: boolean;
}

// ---------------------------------------------------------------------------
// git plumbing
// ---------------------------------------------------------------------------

/**
 * Run git with argv (never a shell string), returning null on any failure.
 *
 * Deliberately a local copy rather than an import: `core.ts` and `content.ts`
 * each keep their own so a module can be read end to end without chasing a
 * shared helper. Consolidating all three is a separate change.
 */
function gitArgv(argv: string[], cwd: string): string | null {
  try {
    return execFileSync('git', argv, {cwd, encoding: 'utf-8', stdio: 'pipe'});
  } catch {
    return null;
  }
}

/** Exit-status-only form: true when git succeeded. */
function gitOk(argv: string[], cwd: string): boolean {
  return gitArgv(argv, cwd) != null;
}

function short(sha: string | null): string {
  return sha == null ? '(none)' : sha.slice(0, 7);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

const SEVERITY_RANK: Record<SubmoduleSeverity, number> = {
  advisory: 1,
  ok: 0,
  severe: 2,
};

function worstSeverity(findings: SubmoduleFinding[]): SubmoduleSeverity {
  let worst: SubmoduleSeverity = 'ok';
  for (const f of findings) {
    if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[worst]) worst = f.severity;
  }
  return worst;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Every submodule the repo knows about, as `path -> url`.
 *
 * Two sources, unioned, because either can exist without the other: the
 * `.gitmodules` file carries the URL but can be stale or missing, while the
 * mode-160000 entries in HEAD are what is actually RECORDED and therefore what
 * a clone will try to resolve.
 */
export function discoverSubmodules(
  cwd: string,
  repoRoot: string,
): Array<{path: string; url: string | null}> {
  const urls = new Map<string, string>();
  const paths = new Map<string, string | null>();

  const config = gitArgv(
    [
      'config',
      '-f',
      join(repoRoot, '.gitmodules'),
      '--get-regexp',
      '^submodule\\..*\\.(path|url)$',
    ],
    cwd,
  );
  if (config != null) {
    // Lines are `submodule.<name>.<key> <value>`, and <name> may itself contain
    // dots and slashes, so split on the LAST dot before the key.
    const byName = new Map<string, {path?: string; url?: string}>();
    for (const line of config.split('\n')) {
      const sep = line.indexOf(' ');
      if (sep < 0) continue;
      const key = line.slice(0, sep);
      const value = line.slice(sep + 1).trim();
      const lastDot = key.lastIndexOf('.');
      if (lastDot < 0 || !key.startsWith('submodule.')) continue;
      const name = key.slice('submodule.'.length, lastDot);
      const field = key.slice(lastDot + 1);
      const entry = byName.get(name) ?? {};
      if (field === 'path') entry.path = value;
      if (field === 'url') entry.url = value;
      byName.set(name, entry);
    }
    for (const entry of byName.values()) {
      if (entry.path == null || entry.path.length === 0) continue;
      paths.set(entry.path, entry.url ?? null);
      if (entry.url != null) urls.set(entry.path, entry.url);
    }
  }

  const tree = gitArgv(['ls-tree', '-r', 'HEAD'], cwd);
  if (tree != null) {
    for (const line of tree.split('\n')) {
      if (!line.startsWith('160000 ')) continue;
      const tab = line.indexOf('\t');
      if (tab < 0) continue;
      const path = line.slice(tab + 1).trim();
      if (path.length === 0) continue;
      if (!paths.has(path)) paths.set(path, urls.get(path) ?? null);
    }
  }

  return [...paths.entries()]
    .map(([path, url]) => ({path, url}))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** The gitlink sha recorded in `worktree`'s HEAD commit for `subPath`. */
function pointerInHead(worktree: string, subPath: string): string | null {
  const out = gitArgv(['ls-tree', 'HEAD', '--', subPath], worktree);
  if (out == null) return null;
  const match = /^160000 commit (\S+)\t/.exec(out.trim());
  return match?.[1] ?? null;
}

/** The gitlink sha staged in `worktree`'s index for `subPath`. */
function pointerInIndex(worktree: string, subPath: string): string | null {
  const out = gitArgv(['ls-files', '--stage', '--', subPath], worktree);
  if (out == null) return null;
  const match = /^160000 (\S+) /.exec(out.trim());
  return match?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Store evaluation
// ---------------------------------------------------------------------------

interface StoreFacts {
  store: string;
  head: string | null;
  branch: string | null;
  hasRemoteRefs: boolean;
  unpushedCommits: number | null;
  upstreamRef: string | null;
  behind: number | null;
}

/**
 * Open the submodule checkout at `dir` and read its store.
 *
 * Returns null when there is no checkout there. The `--show-toplevel` guard is
 * load-bearing: `git -C <uninitialised-submodule-dir>` walks UP and answers for
 * the PARENT repo, so without it an uninitialised submodule would be reported
 * with the parent's HEAD, branch and push state — confidently wrong.
 */
function readStore(dir: string): StoreFacts | null {
  if (!existsSync(join(dir, '.git'))) return null;
  const toplevel = gitArgv(['rev-parse', '--show-toplevel'], dir)?.trim();
  if (toplevel == null || canonical(toplevel) !== canonical(dir)) return null;

  const store = gitArgv(['rev-parse', '--absolute-git-dir'], dir)?.trim();
  if (store == null) return null;

  const head = gitArgv(['rev-parse', 'HEAD'], dir)?.trim() ?? null;
  const abbrev = gitArgv(['rev-parse', '--abbrev-ref', 'HEAD'], dir)?.trim();
  const branch = abbrev != null && abbrev !== 'HEAD' ? abbrev : null;

  const remoteRefs = gitArgv(
    ['for-each-ref', '--count=1', '--format=%(refname)', 'refs/remotes'],
    dir,
  );
  const hasRemoteRefs = remoteRefs != null && remoteRefs.trim().length > 0;

  // "Unpushed" is measured against EVERY remote-tracking ref, not against one
  // upstream: a commit that is on some other pushed branch is not at risk, and
  // a submodule checkout is usually on a detached HEAD with no upstream at all.
  const unpushedCommits =
    hasRemoteRefs && head != null
      ? toCount(gitArgv(['rev-list', '--count', 'HEAD', '--not', '--remotes'], dir))
      : null;

  const upstreamRef = resolveUpstream(dir);
  const behind =
    upstreamRef != null && head != null
      ? toCount(gitArgv(['rev-list', '--count', `HEAD..${upstreamRef}`], dir))
      : null;

  return {behind, branch, hasRemoteRefs, head, store, unpushedCommits, upstreamRef};
}

function toCount(out: string | null): number | null {
  if (out == null) return null;
  const n = Number(out.trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * What "current" means for this checkout: its configured upstream when it has
 * one, else the remote's own default branch. Submodules are usually on a
 * detached HEAD, so the fallback is the common path, not the exotic one.
 */
function resolveUpstream(dir: string): string | null {
  const upstream = gitArgv(
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    dir,
  )?.trim();
  if (upstream != null && upstream.length > 0) return upstream;

  const symbolic = gitArgv(
    ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
    dir,
  )?.trim();
  if (symbolic != null && symbolic.length > 0) return symbolic;

  for (const candidate of ['origin/main', 'origin/master']) {
    if (gitOk(['rev-parse', '--verify', '--quiet', candidate], dir)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Remote-tracking refs in this store that contain `sha`.
 *
 * Branches only, deliberately. A local tag containing the commit proves nothing
 * about the remote — tags are pushed separately and routinely are not — whereas
 * a `refs/remotes/*` ref is a record of what the remote had at the last fetch.
 * `origin/HEAD` is dropped because it is a symbolic alias, not a branch.
 */
function remotesContaining(dir: string, sha: string): string[] {
  const out = gitArgv(
    ['branch', '--remotes', '--contains', sha, '--format=%(refname)'],
    dir,
  );
  if (out == null) return [];
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('refs/remotes/') && !l.endsWith('/HEAD'))
    .map((l) => l.slice('refs/remotes/'.length));
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

function buildCheckout(
  worktree: WorktreeEntry,
  subPath: string,
  isCurrent: boolean,
  openStore: boolean,
): SubmoduleCheckout {
  const recordedPointer = pointerInHead(worktree.path, subPath);
  const staged = pointerInIndex(worktree.path, subPath);
  const stagedPointer = staged != null && staged !== recordedPointer ? staged : null;

  const dir = join(worktree.path, subPath);
  const facts = openStore ? readStore(dir) : null;

  if (!openStore) {
    return {
      behind: null,
      checkoutBranch: null,
      checkoutHead: null,
      findings: [],
      isCurrent,
      isPrimary: worktree.isPrimary,
      pointerInStore: null,
      pointerOnRemotes: null,
      recordedPointer,
      severity: 'ok',
      stagedPointer,
      store: null,
      storeNote:
        'store not opened — only the recorded pointer was read (pass --submodule-stores to evaluate every worktree)',
      unpushedCommits: null,
      upstreamRef: null,
      worktree: worktree.path,
    };
  }

  if (facts == null) {
    const findings: SubmoduleFinding[] = [
      {
        fix: `git -C ${worktree.path} submodule update --init -- ${subPath}`,
        kind: 'not-initialized',
        question: Q_CURRENT_CODE,
        severity: 'advisory',
        why: `no submodule checkout at ${dir} — this worktree has nothing to build against`,
      },
    ];
    return {
      behind: null,
      checkoutBranch: null,
      checkoutHead: null,
      findings,
      isCurrent,
      isPrimary: worktree.isPrimary,
      pointerInStore: null,
      pointerOnRemotes: null,
      recordedPointer,
      severity: worstSeverity(findings),
      stagedPointer,
      store: null,
      storeNote: 'not initialized in this worktree',
      unpushedCommits: null,
      upstreamRef: null,
      worktree: worktree.path,
    };
  }

  const pointerInStore =
    recordedPointer != null
      ? gitArgv(['cat-file', '-t', recordedPointer], dir)?.trim() === 'commit'
      : null;
  const pointerOnRemotes =
    recordedPointer != null && pointerInStore === true
      ? remotesContaining(dir, recordedPointer)
      : null;

  const findings = decideCheckoutFindings({
    dir,
    facts,
    pointerInStore,
    pointerOnRemotes,
    recordedPointer,
    subPath,
    worktree,
  });

  return {
    behind: facts.behind,
    checkoutBranch: facts.branch,
    checkoutHead: facts.head,
    findings,
    isCurrent,
    isPrimary: worktree.isPrimary,
    pointerInStore,
    pointerOnRemotes,
    recordedPointer,
    severity: worstSeverity(findings),
    stagedPointer,
    store: facts.store,
    storeNote: null,
    unpushedCommits: facts.unpushedCommits,
    upstreamRef: facts.upstreamRef,
    worktree: worktree.path,
  };
}

function decideCheckoutFindings(ctx: {
  dir: string;
  facts: StoreFacts;
  pointerInStore: boolean | null;
  pointerOnRemotes: string[] | null;
  recordedPointer: string | null;
  subPath: string;
  worktree: WorktreeEntry;
}): SubmoduleFinding[] {
  const {dir, facts, pointerInStore, pointerOnRemotes, recordedPointer, worktree} =
    ctx;
  const findings: SubmoduleFinding[] = [];

  // --- Is the recorded pointer usable anywhere but here? -------------------
  if (recordedPointer != null && pointerInStore === false) {
    // The benign-looking twin of the severe case below, and the one a bare
    // `git cat-file` cannot tell apart from it. Object stores are per-checkout,
    // so absence here is evidence about THIS store and nothing else.
    findings.push({
      fix: `git -C ${dir} fetch --all, then re-run`,
      kind: 'pointer-absent-from-store',
      question: Q_RESOLVABLE,
      severity: 'advisory',
      why: `recorded pointer ${short(recordedPointer)} is not an object in this checkout's store (${facts.store}) — object stores are per-checkout, so this says nothing about whether the commit exists on the remote`,
    });
  } else if (recordedPointer != null && pointerInStore === true) {
    if (!facts.hasRemoteRefs) {
      findings.push({
        fix: `git -C ${dir} fetch --all, then re-run`,
        kind: 'no-remote-refs',
        question: Q_RESOLVABLE,
        severity: 'advisory',
        why: `this checkout's store (${facts.store}) has no remote-tracking refs at all, so whether ${short(recordedPointer)} was ever pushed cannot be judged from here`,
      });
    } else if (pointerOnRemotes != null && pointerOnRemotes.length === 0) {
      findings.push({
        fix: `git -C ${dir} push ${facts.branch != null ? `origin ${facts.branch}` : `origin HEAD`} (fetch first if the remote-tracking refs may be stale)`,
        kind: 'pointer-not-on-remote',
        question: Q_RESOLVABLE,
        severity: 'severe',
        why: `recorded pointer ${short(recordedPointer)} exists here but is on no remote-tracking branch — a fresh clone, a CI checkout and \`git worktree add\` all fail on it with "upload-pack: not our ref"`,
      });
    }
  }

  // --- Is work at risk in this store? --------------------------------------
  if (facts.unpushedCommits != null && facts.unpushedCommits > 0) {
    const storeDies = !worktree.isPrimary;
    findings.push({
      fix: `git -C ${dir} push`,
      kind: 'unpushed-commits',
      question: Q_WORK_AT_RISK,
      severity: 'severe',
      why: `the submodule checkout has ${plural(facts.unpushedCommits, 'commit')} on no remote, held only in ${facts.store}${storeDies ? ' — that store belongs to a linked worktree and `git worktree remove` deletes it, taking the commits with it' : ''}`,
    });
  }

  // --- Am I building on current code? --------------------------------------
  if (facts.behind != null && facts.behind > 0 && facts.upstreamRef != null) {
    const nothingAhead = facts.unpushedCommits === 0;
    findings.push({
      fix: `git -C ${dir} fetch && git -C ${worktree.path} submodule update --init -- ${ctx.subPath}, then reinstall the submodule's dependencies (a stale checkout usually means stale node_modules too)`,
      kind: 'stale-checkout',
      question: Q_CURRENT_CODE,
      severity: 'advisory',
      why: `checkout is ${plural(facts.behind, 'commit')} behind ${facts.upstreamRef}${nothingAhead ? ' with nothing unpushed — no work is at risk' : ''}, so this is a stale base and probably stale dependencies, not a data-loss risk`,
    });
  }

  // --- Does the parent agree with what is checked out? ---------------------
  if (
    recordedPointer != null &&
    facts.head != null &&
    facts.head !== recordedPointer
  ) {
    findings.push({
      fix: `git -C ${worktree.path} add -- ${ctx.subPath} && git -C ${worktree.path} commit (or \`git -C ${worktree.path} submodule update -- ${ctx.subPath}\` to discard)`,
      kind: 'pointer-bump-uncommitted',
      question: Q_RESOLVABLE,
      severity: 'advisory',
      why: `this worktree has ${short(facts.head)} checked out (${describeRelation(dir, facts.head, recordedPointer)}) but the parent still records ${short(recordedPointer)}, so every other clone and worktree gets ${short(recordedPointer)}`,
    });
  }

  return findings;
}

/** How the checked-out commit relates to the one the parent recorded. */
function describeRelation(dir: string, head: string, recorded: string): string {
  const headIsAncestor = gitOk(
    ['merge-base', '--is-ancestor', head, recorded],
    dir,
  );
  const recordedIsAncestor = gitOk(
    ['merge-base', '--is-ancestor', recorded, head],
    dir,
  );
  if (headIsAncestor && !recordedIsAncestor) return 'behind the recorded pointer';
  if (recordedIsAncestor && !headIsAncestor) return 'ahead of the recorded pointer';
  if (headIsAncestor && recordedIsAncestor) return 'the same commit';
  return 'divergent from the recorded pointer';
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

export function buildSubmoduleInventory(
  opts: SubmoduleOptions,
): SubmoduleInventory {
  const {allWorktreeStores = false, cwd, repoRoot, worktrees} = opts;
  const currentRoot = canonical(repoRoot);

  // Fall back to a single synthetic worktree when `git worktree list` gave
  // nothing, so a plain repo still gets a full row rather than none.
  const trees: WorktreeEntry[] =
    worktrees.length > 0
      ? worktrees
      : [{branch: null, isPrimary: true, path: repoRoot}];

  const entries = discoverSubmodules(cwd, repoRoot).map(({path, url}) => {
    const checkouts = trees.map((wt) => {
      const isCurrent = canonical(wt.path) === currentRoot;
      return buildCheckout(wt, path, isCurrent, allWorktreeStores || isCurrent);
    });

    const rowFindings = decideRowFindings(checkouts, path);
    const findings = [...rowFindings, ...checkouts.flatMap((c) => c.findings)];
    const severity = worstSeverity(findings);

    return {
      checkouts,
      findings: rowFindings,
      path,
      pointersAcrossWorktrees: distinctPointers(checkouts).length,
      severity,
      url,
      why: summarise(findings, checkouts, severity),
    };
  });

  return {allWorktreeStores, enabled: true, entries};
}

/** The pointer each worktree would hand a clone: staged when bumped, else HEAD's. */
function effectivePointer(checkout: SubmoduleCheckout): string | null {
  return checkout.stagedPointer ?? checkout.recordedPointer;
}

function distinctPointers(checkouts: SubmoduleCheckout[]): string[] {
  return [
    ...new Set(
      checkouts
        .map(effectivePointer)
        .filter((sha): sha is string => sha != null),
    ),
  ];
}

function decideRowFindings(
  checkouts: SubmoduleCheckout[],
  subPath: string,
): SubmoduleFinding[] {
  const pointers = distinctPointers(checkouts);
  if (pointers.length < 2) return [];

  const primary = checkouts.find((c) => c.isPrimary)?.worktree ?? null;
  const detail = checkouts
    .filter((c) => effectivePointer(c) != null)
    .map(
      (c) =>
        `${relativeToPrimary(c.worktree, primary)}: ${short(effectivePointer(c))}`,
    )
    .join(', ');

  // The merge-base is the honest size of the divergence. A tip-to-tip
  // `git diff --stat` is NOT: it counts every line either side changed since
  // they parted, which reads as a huge conflict even when the two sides touch
  // disjoint files. Deliberately no line count is reported here.
  const store = checkouts.find((c) => c.store != null);
  const mergeBase =
    store != null
      ? gitArgv(
          ['merge-base', ...pointers],
          join(store.worktree, subPath),
        )?.trim()
      : null;
  const base =
    mergeBase != null && mergeBase.length > 0
      ? `; merge-base ${short(mergeBase)}`
      : '';

  // SEVERITY. Divergent pointers on their own are the NORMAL state of a
  // multi-worktree repo — each worktree branched at a different time, and
  // nothing is at risk. Flagging that as a problem forever would repeat, in a
  // new costume, exactly the mistake of treating "behind" as an alarm. It
  // escalates only when two opened stores each hold work of their own, which
  // is the state where `git worktree remove` can destroy a unique copy.
  const opened = checkouts.filter((c) => c.store != null);
  const withUnpushed = opened.filter(
    (c) => c.unpushedCommits != null && c.unpushedCommits > 0,
  );
  const escalate = withUnpushed.length >= 2;
  const unopened = checkouts.length - opened.length;
  const tail = escalate
    ? ` — ${withUnpushed.length} of those checkouts hold commits on no remote, so removing the wrong worktree destroys a unique copy`
    : unopened > 0
      ? ` — divergence alone is normal; pass --submodule-stores to check whether any of the ${unopened} unopened store(s) holds work of its own`
      : '';

  return [
    {
      fix: "check each checkout's unpushed count before removing any worktree — `git worktree remove` deletes that worktree's submodule object store",
      kind: 'pointer-diverges-across-worktrees',
      question: Q_WORK_AT_RISK,
      severity: escalate ? 'advisory' : 'ok',
      why: `the parent's worktrees record different submodule commits (${detail}${base}) and each worktree has its OWN object store, so a commit present in one may be unresolvable in another${tail}`,
    },
  ];
}

/** `.` / `.claude/worktrees/foo` instead of five absolute paths in one line. */
function relativeToPrimary(path: string, primary: string | null): string {
  if (primary == null) return path;
  if (path === primary) return '.';
  return path.startsWith(`${primary}/`)
    ? path.slice(primary.length + 1)
    : path;
}

function summarise(
  findings: SubmoduleFinding[],
  checkouts: SubmoduleCheckout[],
  severity: SubmoduleSeverity,
): string {
  if (severity !== 'ok') {
    const worst = findings.find((f) => f.severity === severity);
    if (worst != null) return worst.why;
  }

  const current = checkouts.find((c) => c.isCurrent) ?? checkouts[0];
  if (current == null) return 'no checkout of this submodule in any worktree';

  // Divergence that did not rise to an advisory still belongs in the one-liner:
  // it is the fact a reader needs in order to decide whether to escalate.
  const spread = distinctPointers(checkouts).length;
  const note =
    spread > 1
      ? `; the parent's worktrees record ${spread} different pointers (see findings)`
      : '';

  if (current.store == null) {
    return `recorded pointer ${short(current.recordedPointer)}; no store was opened for this worktree${note}`;
  }
  const on =
    current.pointerOnRemotes != null && current.pointerOnRemotes.length > 0
      ? current.pointerOnRemotes[0]
      : 'a remote';
  const level =
    current.upstreamRef != null && current.behind === 0
      ? `, level with ${current.upstreamRef}`
      : '';
  return `recorded pointer ${short(current.recordedPointer)} is on ${on}${level}, and the checkout has nothing unpushed${note}`;
}
