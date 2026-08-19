/**
 * repo-status +prs — pull-request state via `gh`.
 *
 * ONE `gh` call fetches every PR for the repo, indexed by head branch, rather
 * than one call per branch. On a repo with 80 branches that is the difference
 * between one network round-trip and eighty.
 *
 * DEGRADES, NEVER THROWS. This enrichment is opt-in from the `prime`
 * SessionStart path, where a hang or a crash would delay or break every new
 * session. `gh` is genuinely unreliable in several environments Justin actually
 * runs in — it TLS-fails inside the Claude Code sandbox, it fails when
 * unauthenticated, and it fails offline. Every one of those must produce an
 * explicit `unavailable` state carrying the reason, never an exception and
 * never an unbounded wait.
 *
 * Part of home-base-qyu1.12.
 */

import {execFileSync} from 'child_process';

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_LIMIT = 300;

export type PrState = 'OPEN' | 'CLOSED' | 'MERGED';

export interface PullRequest {
  number: number;
  title: string;
  state: PrState;
  isDraft: boolean;
  url: string;
  headRefName: string;
  baseRefName: string;
  mergedAt: string | null;
}

export interface PrIndex {
  available: boolean;
  /** Why PR data is missing — sandbox TLS, not authenticated, offline, no remote. */
  unavailableReason: string | null;
  /** Head branch name -> its PRs, newest first. */
  byHeadRef: Map<string, PullRequest[]>;
}

export const EMPTY_PR_INDEX: PrIndex = {
  available: false,
  byHeadRef: new Map(),
  unavailableReason: 'not requested',
};

export interface PrOptions {
  cwd: string;
  timeoutMs?: number;
  limit?: number;
}

/**
 * Fetch every PR for the repo in one call.
 *
 * Never throws: any failure returns an unavailable index with the reason
 * attached, so callers can render "PR state unknown" rather than mistaking
 * absence of data for absence of a PR — a distinction that matters when the
 * answer feeds a delete decision.
 */
export function fetchPullRequests(opts: PrOptions): PrIndex {
  const {cwd, limit = DEFAULT_LIMIT, timeoutMs = DEFAULT_TIMEOUT_MS} = opts;

  let raw: string;
  try {
    raw = execFileSync(
      'gh',
      [
        'pr',
        'list',
        '--state',
        'all',
        '--limit',
        String(limit),
        '--json',
        'number,title,state,isDraft,url,headRefName,baseRefName,mergedAt',
      ],
      {cwd, encoding: 'utf-8', stdio: 'pipe', timeout: timeoutMs},
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stderr =
      typeof (error as {stderr?: unknown}).stderr === 'string'
        ? ((error as {stderr: string}).stderr ?? '')
        : '';
    return {
      available: false,
      byHeadRef: new Map(),
      unavailableReason: summariseGhFailure(`${message}\n${stderr}`),
    };
  }

  let parsed: PullRequest[];
  try {
    parsed = JSON.parse(raw) as PullRequest[];
  } catch {
    return {
      available: false,
      byHeadRef: new Map(),
      unavailableReason: 'gh returned output that was not valid JSON',
    };
  }

  const byHeadRef = new Map<string, PullRequest[]>();
  for (const pr of parsed) {
    const list = byHeadRef.get(pr.headRefName) ?? [];
    list.push(pr);
    byHeadRef.set(pr.headRefName, list);
  }
  // Merged PRs first, then open, so a branch's most decisive PR leads.
  for (const list of byHeadRef.values()) {
    list.sort((a, b) => rank(a.state) - rank(b.state) || b.number - a.number);
  }

  return {available: true, byHeadRef, unavailableReason: null};
}

function rank(state: PrState): number {
  if (state === 'MERGED') return 0;
  if (state === 'OPEN') return 1;
  return 2;
}

/** Turn gh's noisy failure text into one actionable line. */
function summariseGhFailure(text: string): string {
  const t = text.toLowerCase();
  if (t.includes('etimedout') || t.includes('timed out')) return 'gh timed out';
  if (t.includes('x509') || t.includes('certificate') || t.includes('tls'))
    return 'gh TLS/certificate failure (typical inside the Claude Code sandbox — retry unsandboxed)';
  if (t.includes('auth') || t.includes('gh auth login'))
    return 'gh is not authenticated (run: gh auth login)';
  if (t.includes('enoent') || t.includes('not found'))
    return 'gh CLI is not installed or not on PATH';
  if (t.includes('no git remote') || t.includes('not a git repository'))
    return 'no GitHub remote for this repository';
  if (t.includes('network') || t.includes('dial tcp') || t.includes('dns'))
    return 'network unavailable';
  return 'gh call failed';
}

/**
 * The PR that most decisively describes a branch's fate, or null.
 *
 * `strippedName` accepts either `feature-x` or `origin/feature-x`, since the
 * core inventory reports remote-only branches remote-qualified while GitHub
 * indexes them bare.
 */
export function prForBranch(
  index: PrIndex,
  branchName: string,
): PullRequest | null {
  const bare = branchName.startsWith('origin/')
    ? branchName.slice('origin/'.length)
    : branchName;
  return index.byHeadRef.get(bare)?.[0] ?? null;
}
