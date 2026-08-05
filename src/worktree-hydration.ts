/**
 * worktree-hydration.ts — detect an UNHYDRATED linked git worktree.
 *
 * WHY THIS IS THE HIGHEST-VALUE PIECE OF THE FEATURE. `worktree-setup` (see
 * src/worktree-setup.ts) is the FIXER; this is the GUARD. A fresh `git worktree`
 * contains only what git TRACKS, so every piece of gitignored build state is
 * absent — and the errors that produces name the WRONG CAUSE: ~10 eslint/tsc
 * failures in files the change never touched, CocoaPods errors pointing at the
 * primary checkout, `mise` refusing to run because the new mise.toml path is
 * untrusted. The natural response is to debug the wrong thing for twenty
 * minutes. This module converts that into a one-line instruction.
 *
 * TWO CONSUMERS, ONE DETECTION (D3 — the integration points are doctor and
 * signal, NOT a WorktreeCreate hook):
 *   - src/doctor.ts   — the WORKTREE_HYDRATION check.
 *   - src/signal.ts   — a PREFLIGHT that refuses to run the checks at all,
 *                       because relaying phantom failures is worse than
 *                       printing nothing.
 *
 * ZERO BEHAVIOR CHANGE OUTSIDE A LINKED WORKTREE. This runs inside every
 * `signal` invocation, so the primary-checkout path must be both free and inert:
 * `isLinkedWorktree()` short-circuits on a single `stat` there (a `.git`
 * directory can only be a main worktree), and nothing else in this module runs.
 *
 * BUDGET: < ~200ms. Only `git rev-parse`, `git check-ignore`, `stat`, and at
 * most one `mise trust --show`. No installs, no network, no mutation — this is
 * a detector, and a detector that changes state is a bug.
 */

import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync, realpathSync} from 'node:fs';
import {homedir} from 'node:os';
import {join, resolve} from 'node:path';

import {
  planWorktreeIncludeCopies,
  resolveGitTopology,
  resolvePrimaryCheckout,
  WORKTREE_INCLUDE_FILE,
} from './worktree-setup';

/**
 * Re-exported so every consumer can get the predicate from this module without
 * needing to know that the git plumbing lives next to `worktree-setup`. There is
 * still exactly ONE implementation.
 */
export {isLinkedWorktree} from './worktree-setup';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type HydrationProblemKind =
  | 'mise-untrusted'
  | 'node-modules'
  | 'worktreeinclude';

export interface HydrationProblem {
  kind: HydrationProblemKind;
  /** Terse noun phrase for the `Missing:` list, e.g. `node_modules`. */
  label: string;
  /** One sentence naming the CONSEQUENCE, for doctor's message. */
  detail: string;
}

export interface WorktreeHydrationStatus {
  /** The exact command that fixes it — never a vague "run setup". */
  fixCommand: string;
  isLinkedWorktree: boolean;
  /** Absolute primary checkout, or null when unresolvable. */
  primary: string | null;
  /** Always empty unless `isLinkedWorktree`. */
  problems: HydrationProblem[];
  target: string;
}

/** The project-local alias, when a project defines it. */
export const WORKTREE_SETUP_SCRIPT = 'worktree:setup';

/**
 * The static-safe invocation (D1): works in a repo that has never installed the
 * SDK, which is the whole point — a fresh worktree has no node_modules.
 */
export const WORKTREE_SETUP_BUNX =
  'bunx github:justinhaaheim/justin-sdk worktree-setup';

// ---------------------------------------------------------------------------
// package.json probes
// ---------------------------------------------------------------------------

interface PackageJsonShape {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

function readPackageJson(target: string): PackageJsonShape | null {
  const pkgPath = join(target, 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    return JSON.parse(readFileSync(pkgPath, 'utf-8')) as PackageJsonShape;
  } catch {
    // Unparseable package.json is somebody else's error to report.
    return null;
  }
}

function hasEntries(record: Record<string, string> | undefined): boolean {
  return record != null && Object.keys(record).length > 0;
}

/**
 * True when node_modules is missing, i.e. when NOTHING that resolves out of
 * node_modules can be trusted to run. Deliberately its own predicate rather than
 * a reuse of BLOCKING_PROBLEM_KINDS (below): that set answers "may signal run at
 * all", this one answers "can a local command resolve" — two different
 * questions that happen to have the same answer today.
 */
function nodeModulesMissing(problems: readonly HydrationProblem[]): boolean {
  return problems.some((problem) => problem.kind === 'node-modules');
}

/**
 * The exact command to print, given what is actually MISSING (finding F6).
 *
 * Per the conductor's install-universal ruling there is NO tier flag: install
 * runs at every tier, so the default (`js`) is always the right recommendation.
 *
 * STATE-AWARE, and this is a SAFETY rule, not an optimization. The fleet
 * convention for a `worktree:setup` alias is `bunx justin-sdk worktree-setup`,
 * which is expected to resolve the SDK out of the project's node_modules. In a
 * worktree where node_modules is MISSING that resolution fails, and bunx falls
 * back to fetching the BARE npm name `justin-sdk` from the registry — which is
 * NOT this package (ours is GitHub-only, under @justinhaaheim). So printing the
 * alias in that state hands the user a command that downloads and executes a
 * stranger's code. It must never be printed there, however convenient it is.
 *
 * Hence: node_modules missing ⇒ ALWAYS the explicit
 * `bunx github:justinhaaheim/justin-sdk` form, alias or no alias. The alias is
 * preferred only when node_modules is intact and can actually resolve it — the
 * include-missing / mise-untrusted cases.
 *
 * `problems` is REQUIRED on purpose. An optional parameter defaulting to "no
 * problems" would make a caller that simply forgot it get the hazardous answer;
 * there is no safe default for a question whose wrong answer runs foreign code.
 */
export function hydrationFixCommand(
  target: string,
  problems: readonly HydrationProblem[],
): string {
  if (nodeModulesMissing(problems)) return WORKTREE_SETUP_BUNX;
  const pkg = readPackageJson(target);
  return pkg?.scripts?.[WORKTREE_SETUP_SCRIPT] != null
    ? `bun run ${WORKTREE_SETUP_SCRIPT}`
    : WORKTREE_SETUP_BUNX;
}

// ---------------------------------------------------------------------------
// mise trust (READ-ONLY)
// ---------------------------------------------------------------------------

export type MiseTrustStatus = 'trusted' | 'unknown' | 'untrusted';

/**
 * Parse `mise trust --show` output for the line describing `targetDir` itself.
 *
 * Format (mise 2026.3.17, verified): one `<dir>: trusted|untrusted` line per
 * config file found from the directory UPWARD, so a worktree nested under a
 * mise-using primary checkout yields several lines and only the target's own
 * matters — a parent's trust state is not this worktree's hydration problem.
 * Paths under $HOME are printed tilde-abbreviated and are realpath-resolved
 * (`/private/var/…` on macOS), so both sides are canonicalized before compare.
 *
 * Anything unrecognized returns 'unknown', which reports NO problem. A detector
 * that guesses "untrusted" from unparsed output would block `signal` on a
 * cosmetic upstream output change.
 */
export function parseMiseTrustStatus(
  stdout: string,
  targetDir: string,
): MiseTrustStatus {
  const wanted = canonicalPath(targetDir);
  for (const line of stdout.split('\n')) {
    const separator = line.lastIndexOf(': ');
    if (separator <= 0) continue;
    const pathPart = expandTilde(line.slice(0, separator).trim());
    const statusPart = line.slice(separator + 2).trim();
    if (canonicalPath(pathPart) !== wanted) continue;
    if (statusPart === 'untrusted') return 'untrusted';
    if (statusPart === 'trusted') return 'trusted';
    return 'unknown';
  }
  return 'unknown';
}

function expandTilde(inputPath: string): string {
  if (inputPath === '~') return homedir();
  if (inputPath.startsWith('~/')) return join(homedir(), inputPath.slice(2));
  return inputPath;
}

function canonicalPath(inputPath: string): string {
  const absolute = resolve(inputPath);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/**
 * Trust status of `target`'s own mise.toml, using `mise trust --show` — which
 * the mise docs describe as "Show the trusted status … Does not trust or
 * untrust any files", and which was verified non-mutating here (the
 * trusted-configs state dir was byte-for-byte unchanged across a run). Nothing
 * in this module may prompt or write.
 *
 * Returns 'unknown' when there is no mise.toml or mise is not installed —
 * absence of mise is not a hydration problem.
 */
export function miseTrustStatus(target: string): MiseTrustStatus {
  if (!existsSync(join(target, 'mise.toml'))) return 'unknown';
  let stdout: string;
  try {
    stdout = execFileSync('mise', ['trust', '--show', '-C', target], {
      encoding: 'utf-8',
      // Explicit, not inherited: Bun's execFileSync otherwise hands the child
      // the env as it was at process START, ignoring later mutations — and
      // MISE_TRUSTED_CONFIG_PATHS is exactly the kind of variable a caller may
      // set programmatically.
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return 'unknown';
  }
  return parseMiseTrustStatus(stdout, target);
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * How many missing files to name before collapsing into "+N more". A wall of
 * paths is as unreadable as no list at all.
 */
const MAX_LISTED_PROBLEMS = 8;

function notLinked(target: string): WorktreeHydrationStatus {
  return {
    fixCommand: WORKTREE_SETUP_BUNX,
    isLinkedWorktree: false,
    primary: null,
    problems: [],
    target,
  };
}

/**
 * Decide whether `target` is an unhydrated linked worktree, and if so exactly
 * what is missing.
 *
 * The three signals are the ones that actually produce phantom failures:
 *   1. node_modules absent while package.json declares dependencies — the
 *      cause of the ~10 eslint/tsc errors in untouched files.
 *   2. a `.worktreeinclude` entry present-and-gitignored in the primary but
 *      absent here (D4: that file is the ONE copy manifest). Reuses
 *      planWorktreeIncludeCopies, whose `copy` action means precisely "should
 *      be here and is not".
 *   3. `mise.toml` present but untrusted — mise then refuses to supply the
 *      pinned toolchain, and the resulting failure blames the tools.
 *
 * A missing primary checkout is NOT reported as a problem: we cannot know what
 * should have been copied, and inventing a problem we can't describe is worse
 * than staying quiet.
 */
export function detectWorktreeHydration(
  target: string = process.cwd(),
): WorktreeHydrationStatus {
  const resolved = resolve(target);

  // One topology resolution serves both the predicate and the primary lookup.
  const topology = resolveGitTopology(resolved);
  if (topology == null || !topology.isLinked) return notLinked(resolved);

  const primary = resolvePrimaryCheckout(resolved, topology);
  const problems: HydrationProblem[] = [];

  const pkg = readPackageJson(resolved);
  const declaresDependencies =
    pkg != null &&
    (hasEntries(pkg.dependencies) || hasEntries(pkg.devDependencies));
  if (declaresDependencies && !existsSync(join(resolved, 'node_modules'))) {
    problems.push({
      detail:
        'node_modules is absent while package.json declares dependencies — eslint, tsc and every tool that lives in node_modules will fail in files you never touched',
      kind: 'node-modules',
      label: 'node_modules',
    });
  }

  if (primary != null && primary !== resolved) {
    const plan = planWorktreeIncludeCopies(primary, resolved);
    for (const entry of plan.entries) {
      if (entry.action !== 'copy') continue;
      problems.push({
        detail: `${entry.relPath} is listed in ${WORKTREE_INCLUDE_FILE} and present in the primary checkout, but absent here`,
        kind: 'worktreeinclude',
        label: entry.relPath,
      });
    }
  }

  if (miseTrustStatus(resolved) === 'untrusted') {
    problems.push({
      detail:
        'mise.toml is untrusted at this path — mise will refuse to supply the pinned toolchain, and the failure will look like a missing tool',
      kind: 'mise-untrusted',
      label: 'mise.toml (untrusted)',
    });
  }

  return {
    fixCommand: hydrationFixCommand(resolved, problems),
    isLinkedWorktree: true,
    primary,
    problems,
    target: resolved,
  };
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

/** Comma-joined problem labels for the `Missing:` list, capped. */
export function describeMissing(status: WorktreeHydrationStatus): string {
  const labels = status.problems.map((problem) => problem.label);
  if (labels.length <= MAX_LISTED_PROBLEMS) return labels.join(', ');
  const shown = labels.slice(0, MAX_LISTED_PROBLEMS);
  return `${shown.join(', ')}, +${labels.length - shown.length} more`;
}

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';

/**
 * The block `signal` prints INSTEAD of the checks. Deliberately unmissable and
 * deliberately front-loaded with the cause: the failure mode being fixed is a
 * human reading real-looking errors and believing them, so the first line must
 * say the errors are phantom before any of them could be read.
 */
export function formatUnhydratedWorktreeBanner(
  status: WorktreeHydrationStatus,
): string {
  const rule = '─'.repeat(72);
  return [
    '',
    `${RED}${rule}${RESET}`,
    `${BOLD}${RED}UNHYDRATED WORKTREE — signal checks were NOT run.${RESET}`,
    '',
    `This is an UNHYDRATED git worktree — the failures you saw are PHANTOM.`,
    `They blame code you never touched. Do not debug them.`,
    '',
    `  ${BOLD}Worktree:${RESET} ${status.target}`,
    `  ${BOLD}Missing:${RESET}  ${describeMissing(status)}`,
    `  ${BOLD}Fix:${RESET}      ${YELLOW}${status.fixCommand}${RESET}`,
    '',
    `Then re-run signal.`,
    `${RED}${rule}${RESET}`,
    '',
  ].join('\n');
}
