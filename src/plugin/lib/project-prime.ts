#!/usr/bin/env bun

/**
 * project-prime — surface unmerged work sitting on other branches/worktrees
 * that the current session might not know about.
 *
 * Justin's recurring failure mode: he kicks off a session on main (or a stale
 * worktree), Claude builds there, and only later does it turn out weeks of
 * unmerged work were sitting on a feature branch/worktree nobody checked.
 * This inspects the current repo's local branches, remote-only branches, and
 * worktree HEADs; flags anything with commits ahead of the current branch
 * that isn't trivially stale; and stays silent when there's nothing notable.
 *
 * Read-only, local-refs-only (never fetches) — safe for a session-start hot
 * path. Can be used as a CLI or imported as a TypeScript module. Part of
 * home-base-46w2 (branch-status).
 */

import {execFileSync, execSync} from 'child_process';

const DEFAULT_SINCE_DAYS = 30;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BranchTip {
  /** Short name, e.g. "main" or "origin/feature-x" for remote-only branches */
  name: string;
  isRemoteOnly: boolean;
  tipSha: string;
  lastCommitDate: string; // ISO 8601
  /** Path to the worktree that has this branch checked out, if any */
  worktreePath: string | null;
}

export interface DivergentGroup {
  tipSha: string;
  /** All branch names sharing this tip (usually one; >1 hints at the same underlying work) */
  branches: BranchTip[];
  aheadOfCurrent: number;
  lastCommitDate: string;
  hasWorktree: boolean;
}

export interface DivergenceReport {
  currentBranch: string;
  groups: DivergentGroup[];
}

export interface RunOptions {
  cwd: string;
  /** Branches with no commits within this many days are ignored unless they have a worktree. Default 30. */
  sinceDays?: number;
}

// ---------------------------------------------------------------------------
// git plumbing
// ---------------------------------------------------------------------------

function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, {cwd, encoding: 'utf-8', stdio: 'pipe'});
}

function tryGit(args: string, cwd: string): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

/** Like tryGit, but takes argv directly — for calls that embed ref names (avoids shell interpolation of untrusted-ish branch names). */
function tryGitArgv(argv: string[], cwd: string): string | null {
  try {
    return execFileSync('git', argv, {cwd, encoding: 'utf-8', stdio: 'pipe'});
  } catch {
    return null;
  }
}

function getCurrentBranch(cwd: string): string | null {
  const out = tryGit('rev-parse --abbrev-ref HEAD', cwd)?.trim();
  return out != null && out.length > 0 && out !== 'HEAD' ? out : null;
}

interface WorktreeEntry {
  path: string;
  branch: string | null; // short branch name, null if detached
}

function getWorktrees(cwd: string): WorktreeEntry[] {
  const out = tryGit('worktree list --porcelain', cwd);
  if (out == null) return [];

  const entries: WorktreeEntry[] = [];
  let currentPath: string | null = null;
  let currentBranch: string | null = null;

  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (currentPath != null) {
        entries.push({branch: currentBranch, path: currentPath});
      }
      currentPath = line.slice('worktree '.length).trim();
      currentBranch = null;
    } else if (line.startsWith('branch ')) {
      // "branch refs/heads/foo" -> "foo"
      currentBranch = line
        .slice('branch '.length)
        .replace('refs/heads/', '')
        .trim();
    }
  }
  if (currentPath != null) {
    entries.push({branch: currentBranch, path: currentPath});
  }
  return entries;
}

/** All local + remote branch tips, deduped (a remote branch mirroring an identically-named local branch is dropped). */
function getBranchTips(cwd: string, worktrees: WorktreeEntry[]): BranchTip[] {
  const out = tryGit(
    "for-each-ref --format='%(refname) %(objectname) %(committerdate:iso-strict)' refs/heads refs/remotes",
    cwd,
  );
  if (out == null) return [];

  const worktreeByBranch = new Map(
    worktrees
      .filter((w) => w.branch != null)
      .map((w) => [w.branch as string, w.path]),
  );

  const local = new Map<string, BranchTip>();
  const remote: BranchTip[] = [];

  for (const line of out.trim().split('\n')) {
    if (line.length === 0) continue;
    const match = /^(\S+) (\S+) (\S+)$/.exec(line);
    if (match == null) continue;
    const [, refname, tipSha, lastCommitDate] = match;
    if (refname == null || tipSha == null || lastCommitDate == null) continue;

    if (refname.startsWith('refs/heads/')) {
      const name = refname.slice('refs/heads/'.length);
      local.set(name, {
        isRemoteOnly: false,
        lastCommitDate,
        name,
        tipSha,
        worktreePath: worktreeByBranch.get(name) ?? null,
      });
    } else if (refname.startsWith('refs/remotes/')) {
      const short = refname.slice('refs/remotes/'.length);
      if (short.endsWith('/HEAD')) continue; // symbolic ref, not a real branch
      const nameWithoutRemote = short.slice(short.indexOf('/') + 1);
      remote.push({
        isRemoteOnly: !local.has(nameWithoutRemote),
        lastCommitDate,
        name: short,
        tipSha,
        worktreePath: null,
      });
    }
  }

  const remoteOnly = remote.filter((r) => r.isRemoteOnly);
  return [...local.values(), ...remoteOnly];
}

/** Commits `other` has that `current` doesn't (i.e. how far ahead `other` is). */
function countAhead(cwd: string, current: string, other: string): number {
  const out = tryGitArgv(
    ['rev-list', '--left-right', '--count', `${current}...${other}`],
    cwd,
  );
  if (out == null) return 0;
  const parts = out.trim().split(/\s+/);
  const ahead = Number(parts[1] ?? '0');
  return Number.isFinite(ahead) ? ahead : 0;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function isRecentEnough(lastCommitDate: string, sinceDays: number): boolean {
  const ageMs = Date.now() - new Date(lastCommitDate).getTime();
  return ageMs <= sinceDays * 24 * 60 * 60 * 1000;
}

export function runDivergenceCheck(opts: RunOptions): DivergenceReport | null {
  const {cwd, sinceDays = DEFAULT_SINCE_DAYS} = opts;
  const currentBranch = getCurrentBranch(cwd);
  if (currentBranch == null) return null; // detached HEAD, not a repo, etc — nothing sensible to report

  const worktrees = getWorktrees(cwd);
  const tips = getBranchTips(cwd, worktrees).filter(
    (t) => t.name !== currentBranch,
  );

  const candidates = tips.filter(
    (t) =>
      t.worktreePath != null || isRecentEnough(t.lastCommitDate, sinceDays),
  );

  const withAhead = candidates
    .map((t) => ({
      ...t,
      aheadOfCurrent: countAhead(cwd, currentBranch, t.name),
    }))
    .filter((t) => t.aheadOfCurrent > 0);

  // Group by tip sha — branches sharing a tip likely represent the same work.
  const bySha = new Map<string, typeof withAhead>();
  for (const t of withAhead) {
    const list = bySha.get(t.tipSha) ?? [];
    list.push(t);
    bySha.set(t.tipSha, list);
  }

  const groups: DivergentGroup[] = Array.from(bySha.entries()).map(
    ([tipSha, branches]) => ({
      aheadOfCurrent: branches[0]?.aheadOfCurrent ?? 0,
      branches,
      hasWorktree: branches.some((b) => b.worktreePath != null),
      lastCommitDate: branches.reduce(
        (latest, b) => (b.lastCommitDate > latest ? b.lastCommitDate : latest),
        branches[0]?.lastCommitDate ?? '',
      ),
      tipSha,
    }),
  );

  groups.sort((a, b) => {
    if (a.hasWorktree !== b.hasWorktree) return a.hasWorktree ? -1 : 1;
    if (a.aheadOfCurrent !== b.aheadOfCurrent)
      return b.aheadOfCurrent - a.aheadOfCurrent;
    return b.lastCommitDate.localeCompare(a.lastCommitDate);
  });

  return {currentBranch, groups};
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const RECENT_TOUCH_MS = 72 * 60 * 60 * 1000;

/** YYYY-MM-DD, plus ` HH:MM` (24h, local) when the commit is within the last 72h. */
function formatTouched(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const date = `${y}-${mo}-${day}`;
  if (Date.now() - d.getTime() > RECENT_TOUCH_MS) return date;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${date} ${hh}:${mm}`;
}

/**
 * Render the repo-state section for session-start injection. ALWAYS returns a
 * titled section when on a branch — including a "clean" line when there's no
 * divergence — so a reader always sees the current repo state. Returns '' only
 * when there's nothing sensible to report (detached HEAD / not a git repo).
 */
export function formatRepoState(report: DivergenceReport | null): string {
  if (report == null) return '';

  const header = '# Current repo state';
  if (report.groups.length === 0) {
    return `${header}\n\nOn \`${report.currentBranch}\` — no unmerged work on any other branch or worktree.`;
  }

  const plural = report.groups.length === 1 ? '' : 'es';
  const lines: string[] = [
    header,
    '',
    `On \`${report.currentBranch}\`, ${report.groups.length} branch${plural} have unmerged work:`,
  ];
  for (const group of report.groups) {
    const names = group.branches.map((b) => b.name).join(' / ');
    const worktreeNote = group.hasWorktree ? 'worktree, ' : '';
    const commitWord = group.aheadOfCurrent === 1 ? 'commit' : 'commits';
    const sameTipNote =
      group.branches.length > 1
        ? ' -- same tip, may be the same underlying work'
        : '';
    lines.push(
      `  - ${names} (${worktreeNote}${group.aheadOfCurrent} ${commitWord} ahead, last touched ${formatTouched(group.lastCommitDate)})${sameTipNote}`,
    );
  }
  lines.push(
    '',
    'When there is unmerged work on feature branch(es), the human may prefer for new work to base from the feature branches rather than main. When in doubt, ask.',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export function runCli(cwd: string, argv: string[]): number {
  const sinceDaysArg = argv.find((a) => a.startsWith('--since-days='));
  const sinceDays =
    sinceDaysArg != null ? Number(sinceDaysArg.split('=')[1]) : undefined;
  const json = argv.includes('--json');

  const report = runDivergenceCheck({cwd, sinceDays});

  if (json) {
    console.log(JSON.stringify(report ?? {currentBranch: null, groups: []}));
    return 0;
  }

  const text = formatRepoState(report);
  if (text.length > 0) console.log(text);
  return 0;
}

const isDirectExecution =
  import.meta.path === Bun.main ||
  process.argv[1]?.endsWith('project-prime.ts');
if (isDirectExecution) {
  process.exit(runCli(process.cwd(), process.argv.slice(2)));
}
