#!/usr/bin/env bun

/**
 * worktree-setup / worktree-new — hydrate a fresh git worktree's gitignored
 * build state, and create worktrees the way Claude Code does.
 *
 * WHY: a `git worktree` checkout contains only what git TRACKS. Every piece of
 * gitignored build state (node_modules/, generated version files, .env.local,
 * ios/) is absent, so the tree is neither buildable nor lintable — and the
 * failures it produces name the wrong cause: CocoaPods errors that point at the
 * PRIMARY checkout, ~10 phantom eslint errors in files you never touched, a
 * Swift LSP reporting "No such module" for every file, `mise` refusing to run
 * because the new mise.toml path is untrusted. The natural response is to debug
 * the wrong thing for twenty minutes.
 *
 * STATIC-SAFE (D1). Both commands must work as
 * `bunx github:justinhaaheim/justin-sdk worktree-setup` in a repo that has
 * never installed the SDK — because a fresh worktree has no node_modules, so a
 * project-local `bun run worktree:setup` alias cannot possibly work there.
 * Consequences, both load-bearing:
 *   - nothing here may resolve an import from the consumer project, and nothing
 *     may read justin-sdk.config.json. Only node builtins, the SDK's own
 *     dependencies (`ignore`), and SDK-local modules.
 *   - all human-readable report output goes to STDERR. stdout is machine
 *     output only: EMPTY for worktree-setup, and exactly one line (the
 *     absolute worktree path) for worktree-new, which the `wt` zsh function
 *     captures to `cd`.
 *
 * .worktreeinclude IS THE ONLY COPY MANIFEST (D4). Claude Code natively copies
 * gitignored files matching that root-level, gitignore-syntax file into the
 * worktrees IT creates — but it is NOT processed for a manual
 * `git worktree add`. So we honor the same file: one manifest, two consumers,
 * no second `copyFromPrimary` config key. Matching uses the `ignore` package
 * (the parser eslint and prettier use internally), never hand-rolled globbing.
 *
 * TIERS (D5). The steps differ by ORDERS OF MAGNITUDE in cost, so projects
 * declare their own hydration scripts as `worktree-source:<tier>:<LABEL>`
 * package.json scripts — the same discovery convention as `signal-source:`
 * (src/signal.ts) and `fix-source:` (src/fix.ts), so there is no new config
 * file or key. Tiers are cumulative (lint ⊂ js ⊂ native), default `js`, and
 * run in package.json DECLARATION order, serially. `--lint` must never
 * execute a `native:` script.
 *
 * NOT built on check-runner, deliberately: check-runner has no per-check cwd
 * (it hardcodes `process.cwd()`), and its summary prints to stdout — both
 * disqualifying here, where every step runs with cwd = the TARGET worktree and
 * stdout must stay clean.
 */

import {execFileSync, spawnSync} from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import {basename, dirname, isAbsolute, join, resolve} from 'node:path';
import ignore from 'ignore';

// ---------------------------------------------------------------------------
// Constants and public types
// ---------------------------------------------------------------------------

/** Cost-ordered and cumulative: lint ⊂ js ⊂ native. */
export const TIER_ORDER = ['lint', 'js', 'native'] as const;
export type Tier = (typeof TIER_ORDER)[number];

/** `--js` is the floor at which `bun run signal` means anything. */
export const DEFAULT_TIER: Tier = 'js';

/** package.json script prefix, mirroring `signal-source:` / `fix-source:`. */
export const WORKTREE_SOURCE_PREFIX = 'worktree-source:';

/** Claude Code's own convention (D2) — byte-identical on purpose. */
export const WORKTREE_DIR_SEGMENTS = ['.claude', 'worktrees'] as const;
export const WORKTREE_BRANCH_PREFIX = 'worktree-';

/** The manifest Claude Code reads natively; we read the same one (D4). */
export const WORKTREE_INCLUDE_FILE = '.worktreeinclude';

/** No slashes: a slug names a directory leaf AND a branch leaf (D7). */
export const SLUG_PATTERN = /^[A-Za-z0-9._-]+$/;

export type StepStatus = 'done' | 'skipped' | 'failed';

export interface StepReport {
  /** Stable identifier — `HYDRATE:<script name>` for project-declared steps. */
  label: string;
  status: StepStatus;
  /** What was done, or why it was skipped/failed. Always populated. */
  detail: string;
}

export interface WorktreeSetupOptions {
  dryRun?: boolean;
  /** Directory to hydrate. Defaults to cwd. */
  target?: string;
  /** Defaults to DEFAULT_TIER. */
  tier?: Tier;
}

export interface WorktreeSetupResult {
  exitCode: number;
  /** Absolute path of the primary checkout, or null if unresolvable. */
  primary: string | null;
  steps: StepReport[];
  target: string;
  tier: Tier;
}

export type PackageManager = 'bun' | 'npm' | 'yarn';

// ---------------------------------------------------------------------------
// stderr reporting
// ---------------------------------------------------------------------------

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const YELLOW = '\x1b[33m';

/**
 * Every human-readable line in this module goes through here. Nothing in this
 * file may use console.log — stdout is reserved for machine output (D1).
 */
function report(line: string): void {
  process.stderr.write(`${line}\n`);
}

const STATUS_ICON: Record<StepStatus, string> = {
  done: `${GREEN}✓${RESET}`,
  failed: `${RED}✗${RESET}`,
  skipped: `${DIM}⊘${RESET}`,
};

function reportStep(step: StepReport): void {
  report(
    `  ${STATUS_ICON[step.status]} ${step.label} ${DIM}${step.detail}${RESET}`,
  );
}

// ---------------------------------------------------------------------------
// Tier resolution
// ---------------------------------------------------------------------------

export interface TierFlags {
  js?: boolean;
  lint?: boolean;
  native?: boolean;
}

export type TierResolution = {tier: Tier} | {error: string};

/**
 * Resolve the mutually-exclusive tier flags to a single tier. Returns an error
 * (rather than throwing or silently picking) when more than one is passed —
 * `--lint --native` is an ambiguous request, not a cheap one.
 */
export function resolveTier(flags: TierFlags): TierResolution {
  const given = TIER_ORDER.filter((tier) => flags[tier] === true);
  if (given.length > 1) {
    return {
      error: `${given.map((t) => `--${t}`).join(' and ')} are mutually exclusive — pass at most one tier flag`,
    };
  }
  return {tier: given[0] ?? DEFAULT_TIER};
}

/** True if `scriptTier` runs under `selected`, given cumulative tiers. */
export function tierIncludes(selected: Tier, scriptTier: Tier): boolean {
  return TIER_ORDER.indexOf(scriptTier) <= TIER_ORDER.indexOf(selected);
}

function isTier(value: string): value is Tier {
  return (TIER_ORDER as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// git plumbing
// ---------------------------------------------------------------------------

/**
 * Run git and capture stdout, or null on any failure. argv form only — a prior
 * SDK bug was exactly a shell-interpolated ref name, so paths and branch names
 * never go through a shell here.
 */
function gitCapture(argv: string[], cwd: string): string | null {
  try {
    return execFileSync('git', argv, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

/** True if git exits 0. Used for existence probes (`rev-parse --verify`). */
function gitSucceeds(argv: string[], cwd: string): boolean {
  try {
    execFileSync('git', argv, {cwd, stdio: ['pipe', 'pipe', 'pipe']});
    return true;
  } catch {
    return false;
  }
}

/**
 * Absolute path of the PRIMARY checkout for whatever repo `target` belongs to,
 * or null if `target` is not in a git repo.
 *
 * Layered, because "parent of --git-common-dir" is only correct for the common
 * layout, and this SDK itself is a counterexample (it is a submodule of
 * home-base, so its common dir is
 * `home-base/.git/modules/projects/justin-sdk`, whose parent is not a checkout
 * at all — and `git worktree list` misreports it the same way):
 *   1. main worktree (`--git-dir` === `--git-common-dir`) → its `--show-toplevel`.
 *      Correct regardless of where the git dir physically lives.
 *   2. linked worktree, common dir named `.git` → its parent (the usual case).
 *   3. linked worktree, detached git dir (submodule, `--separate-git-dir`) →
 *      `core.worktree` from the common config, resolved against the git dir.
 * Never does path math on the worktree's own location (epic AC #9).
 */
export function resolvePrimaryCheckout(target: string): string | null {
  const commonDirRaw = gitCapture(
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    target,
  );
  if (commonDirRaw == null || commonDirRaw === '') return null;
  const commonDir = resolve(target, commonDirRaw);

  const gitDirRaw = gitCapture(
    ['rev-parse', '--path-format=absolute', '--git-dir'],
    target,
  );
  const gitDir = gitDirRaw == null ? null : resolve(target, gitDirRaw);

  if (gitDir === commonDir) {
    const top = gitCapture(['rev-parse', '--show-toplevel'], target);
    return top != null && top !== '' ? top : null;
  }

  if (basename(commonDir) === '.git') return dirname(commonDir);

  const coreWorktree = gitCapture(
    [`--git-dir=${commonDir}`, 'config', '--get', 'core.worktree'],
    target,
  );
  if (coreWorktree != null && coreWorktree !== '') {
    const candidate = isAbsolute(coreWorktree)
      ? coreWorktree
      : resolve(commonDir, coreWorktree);
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Child processes
// ---------------------------------------------------------------------------

interface ChildResult {
  exitCode: number;
  error: string | null;
}

/**
 * Run a child process with its stdout AND stderr wired straight to OUR stderr
 * (fd 2). Live, unbuffered, and structurally incapable of polluting stdout —
 * which matters because project hydration scripts print freely and
 * worktree-new's stdout contract is a single line.
 */
function runChild(argv: string[], cwd: string): ChildResult {
  const [cmd, ...args] = argv;
  if (cmd == null) return {exitCode: 1, error: 'empty command'};
  const result = spawnSync(cmd, args, {
    cwd,
    env: process.env,
    stdio: ['ignore', 2, 2],
  });
  if (result.error) {
    return {exitCode: 1, error: result.error.message};
  }
  return {exitCode: result.status ?? 1, error: null};
}

// ---------------------------------------------------------------------------
// Package manager detection
// ---------------------------------------------------------------------------

const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
  ['yarn.lock', 'yarn'],
];

export interface PackageManagerDetection {
  /** null when there is nothing to install (no lockfile and no package.json). */
  packageManager: PackageManager | null;
  /** Human-readable basis for the decision — goes in the step report. */
  reason: string;
}

/**
 * Detect the package manager from the lockfile present in `target`. When a
 * package.json exists with NO lockfile we default to bun rather than skipping:
 * the tree still needs node_modules, and bun is the fleet default. That case is
 * not enumerated in the contract, so the reason string says so explicitly.
 */
export function detectPackageManager(target: string): PackageManagerDetection {
  for (const [file, packageManager] of LOCKFILES) {
    if (existsSync(join(target, file))) {
      return {packageManager, reason: `${file} → ${packageManager}`};
    }
  }
  if (existsSync(join(target, 'package.json'))) {
    return {
      packageManager: 'bun',
      reason: 'no lockfile; package.json present → defaulted to bun',
    };
  }
  return {packageManager: null, reason: 'no lockfile and no package.json'};
}

// ---------------------------------------------------------------------------
// Step 4: .worktreeinclude copy plan
// ---------------------------------------------------------------------------

export interface CopyPlanEntry {
  /** Repo-relative POSIX path, identical in primary and target. */
  relPath: string;
  action: 'copy' | 'skip-exists';
}

export interface CopyPlan {
  entries: CopyPlanEntry[];
  hasManifest: boolean;
  manifestPath: string;
}

const GLOB_METACHARS = /[*?[\]!]/;

/**
 * Candidate files in `primary` that a `.worktreeinclude` pattern could name.
 *
 * Two sources, unioned:
 *   (a) `git ls-files -o -i --exclude-standard --directory` — the gitignored,
 *       untracked files. `--directory` collapses wholly-ignored directories to
 *       a single entry so this stays bounded (without it, node_modules alone
 *       yields 100k+ paths); collapsed directories are NOT descended into,
 *       since this step copies files, not trees.
 *   (b) every literal (glob-free) pattern in the manifest that exists as a file
 *       — this is what still finds e.g. `ios/.xcode.env.local` when `ios/` was
 *       collapsed away by (a).
 * `-z` because git otherwise C-quotes paths containing unusual characters.
 */
function collectCandidates(primary: string, manifestLines: string[]): string[] {
  const candidates = new Set<string>();

  const listed = gitCapture(
    ['ls-files', '-z', '-o', '-i', '--exclude-standard', '--directory'],
    primary,
  );
  if (listed != null) {
    for (const entry of listed.split('\0')) {
      if (entry === '' || entry.endsWith('/')) continue;
      candidates.add(entry);
    }
  }

  for (const raw of manifestLines) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith('!')) continue;
    if (GLOB_METACHARS.test(line)) continue;
    const relPath = line.replace(/^\/+/, '').replace(/\/+$/, '');
    if (relPath === '') continue;
    try {
      if (statSync(join(primary, relPath)).isFile()) candidates.add(relPath);
    } catch {
      // Missing / unreadable / broken symlink — not a candidate.
    }
  }

  return [...candidates].sort();
}

/**
 * Decide what `.worktreeinclude` would copy from `primary` into `target`,
 * without touching the filesystem. A file is copied only if it MATCHES the
 * manifest AND is gitignored AND is absent from the target:
 *   - gitignored is verified with `git check-ignore` (no `--no-index`, so a
 *     TRACKED file is correctly reported as not-ignored and never duplicated —
 *     this mirrors Claude Code's rule that tracked files are never copied);
 *   - absent-from-target means we never clobber local state in the worktree.
 */
export function planWorktreeIncludeCopies(
  primary: string,
  target: string,
): CopyPlan {
  const manifestPath = join(primary, WORKTREE_INCLUDE_FILE);
  if (!existsSync(manifestPath)) {
    return {entries: [], hasManifest: false, manifestPath};
  }

  const content = readFileSync(manifestPath, 'utf-8');
  const matcher = ignore().add(content);
  const candidates = collectCandidates(primary, content.split('\n'));

  const entries: CopyPlanEntry[] = [];
  for (const relPath of candidates) {
    if (!matcher.ignores(relPath)) continue;
    if (!gitSucceeds(['check-ignore', '-q', '--', relPath], primary)) continue;
    entries.push({
      relPath,
      action: existsSync(join(target, relPath)) ? 'skip-exists' : 'copy',
    });
  }

  return {entries, hasManifest: true, manifestPath};
}

// ---------------------------------------------------------------------------
// Step 5: worktree-source:<tier>:<LABEL> discovery
// ---------------------------------------------------------------------------

export interface HydrationScript {
  /** Full package.json script name, e.g. `worktree-source:js:VERSION`. */
  name: string;
  label: string;
  /** null when the tier segment is not a known tier. */
  tier: Tier | null;
}

/**
 * Discover `worktree-source:<tier>:<LABEL>` scripts from a package.json, in
 * DECLARATION order (unlike `fix-source:`, which sorts by label — hydration
 * steps have real ordering dependencies, e.g. generate-then-consume).
 */
export function discoverHydrationScripts(target: string): HydrationScript[] {
  const pkgPath = join(target, 'package.json');
  if (!existsSync(pkgPath)) return [];

  let scripts: Record<string, string> = {};
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
      scripts?: Record<string, string>;
    };
    scripts = pkg.scripts ?? {};
  } catch {
    return [];
  }

  const found: HydrationScript[] = [];
  for (const name of Object.keys(scripts)) {
    if (!name.startsWith(WORKTREE_SOURCE_PREFIX)) continue;
    const rest = name.slice(WORKTREE_SOURCE_PREFIX.length);
    const separator = rest.indexOf(':');
    if (separator <= 0) continue;
    const tierSegment = rest.slice(0, separator);
    const label = rest.slice(separator + 1);
    if (label === '') continue;
    found.push({
      label,
      name,
      tier: isTier(tierSegment) ? tierSegment : null,
    });
  }
  return found;
}

// ---------------------------------------------------------------------------
// worktree-setup
// ---------------------------------------------------------------------------

function step(
  steps: StepReport[],
  label: string,
  status: StepStatus,
  detail: string,
): StepReport {
  const entry: StepReport = {detail, label, status};
  steps.push(entry);
  reportStep(entry);
  return entry;
}

function finish(result: WorktreeSetupResult): WorktreeSetupResult {
  const counts = {done: 0, failed: 0, skipped: 0};
  for (const s of result.steps) counts[s.status] += 1;
  const parts = [`${counts.done} done`, `${counts.skipped} skipped`];
  if (counts.failed > 0) parts.push(`${RED}${counts.failed} failed${RESET}`);
  report(`  ${DIM}${parts.join(', ')}${RESET}`);
  return result;
}

/**
 * Hydrate a worktree. Steps run in a fixed order and STOP at the first
 * failure, because each later step assumes the earlier ones: an install into an
 * untrusted mise tree fails confusingly, and a hydration script cannot run
 * without node_modules.
 *
 * Idempotent (epic AC #3): step 3 is a no-op reinstall, step 4 skips files
 * already present, and step 5's scripts are the project's own responsibility —
 * they ARE re-run on every invocation, so projects must write them to be
 * safely repeatable.
 */
export function worktreeSetup(
  options: WorktreeSetupOptions = {},
): WorktreeSetupResult {
  const tier = options.tier ?? DEFAULT_TIER;
  const dryRun = options.dryRun === true;
  const target = resolve(options.target ?? process.cwd());
  const steps: StepReport[] = [];
  const result: WorktreeSetupResult = {
    exitCode: 0,
    primary: null,
    steps,
    target,
    tier,
  };

  report(
    `${BOLD}worktree-setup${RESET} ${target} ${DIM}(tier: ${tier}${dryRun ? ', dry-run' : ''})${RESET}`,
  );

  // --- Step 1: resolve target + primary checkout ---------------------------
  if (!existsSync(target)) {
    step(steps, 'RESOLVE', 'failed', `target does not exist: ${target}`);
    result.exitCode = 1;
    return finish(result);
  }
  const primary = resolvePrimaryCheckout(target);
  result.primary = primary;
  const isPrimary = primary != null && resolve(primary) === target;
  step(
    steps,
    'RESOLVE',
    'done',
    primary == null
      ? 'not a git repo — primary checkout unresolvable'
      : isPrimary
        ? `target IS the primary checkout: ${primary}`
        : `primary checkout: ${primary}`,
  );

  // --- Step 2: mise trust --------------------------------------------------
  if (!existsSync(join(target, 'mise.toml'))) {
    step(steps, 'MISE', 'skipped', 'no mise.toml');
  } else if (dryRun) {
    step(steps, 'MISE', 'skipped', 'dry-run: would run `mise trust`');
  } else {
    const child = runChild(['mise', 'trust'], target);
    if (child.exitCode !== 0) {
      step(
        steps,
        'MISE',
        'failed',
        `mise trust exited ${child.exitCode}${child.error == null ? '' : ` (${child.error})`}`,
      );
      result.exitCode = 1;
      return finish(result);
    }
    step(steps, 'MISE', 'done', 'mise trust');
  }

  // --- Step 3: install dependencies ---------------------------------------
  const detection = detectPackageManager(target);
  const packageManager = detection.packageManager;
  if (packageManager == null) {
    step(steps, 'INSTALL', 'skipped', detection.reason);
  } else if (dryRun) {
    step(
      steps,
      'INSTALL',
      'skipped',
      `dry-run: would run \`${packageManager} install\` (${detection.reason})`,
    );
  } else {
    const child = runChild([packageManager, 'install'], target);
    if (child.exitCode !== 0) {
      step(
        steps,
        'INSTALL',
        'failed',
        `${packageManager} install exited ${child.exitCode}${child.error == null ? '' : ` (${child.error})`}`,
      );
      result.exitCode = 1;
      return finish(result);
    }
    step(
      steps,
      'INSTALL',
      'done',
      `${packageManager} install (${detection.reason})`,
    );
  }

  // --- Step 4: .worktreeinclude copy --------------------------------------
  if (primary == null) {
    step(
      steps,
      'WORKTREEINCLUDE',
      'skipped',
      'primary checkout unresolvable — nothing to copy from',
    );
  } else if (isPrimary) {
    step(
      steps,
      'WORKTREEINCLUDE',
      'skipped',
      'target is the primary checkout — copy is a no-op',
    );
  } else {
    const plan = planWorktreeIncludeCopies(primary, target);
    if (!plan.hasManifest) {
      step(
        steps,
        'WORKTREEINCLUDE',
        'skipped',
        `no ${WORKTREE_INCLUDE_FILE} in ${primary}`,
      );
    } else {
      const copied: string[] = [];
      const present: string[] = [];
      let failure: string | null = null;
      for (const entry of plan.entries) {
        if (entry.action === 'skip-exists') {
          present.push(entry.relPath);
          continue;
        }
        if (dryRun) {
          copied.push(entry.relPath);
          continue;
        }
        try {
          const dest = join(target, entry.relPath);
          mkdirSync(dirname(dest), {recursive: true});
          copyFileSync(join(primary, entry.relPath), dest);
          copied.push(entry.relPath);
        } catch (error) {
          failure = `${entry.relPath}: ${error instanceof Error ? error.message : String(error)}`;
          break;
        }
      }
      const summary =
        `${dryRun ? 'dry-run: would copy' : 'copied'} ${copied.length}` +
        `${copied.length > 0 ? ` (${copied.join(', ')})` : ''}` +
        `, ${present.length} already present` +
        `${present.length > 0 ? ` (${present.join(', ')})` : ''}`;
      if (failure != null) {
        step(steps, 'WORKTREEINCLUDE', 'failed', `copy failed — ${failure}`);
        result.exitCode = 1;
        return finish(result);
      }
      step(
        steps,
        'WORKTREEINCLUDE',
        copied.length > 0 ? 'done' : 'skipped',
        summary,
      );
    }
  }

  // --- Step 5: project-declared hydration scripts -------------------------
  const scripts = discoverHydrationScripts(target);
  if (scripts.length === 0) {
    step(
      steps,
      'HYDRATE',
      'skipped',
      `no ${WORKTREE_SOURCE_PREFIX}<tier>:<LABEL> scripts in package.json`,
    );
  } else {
    for (const script of scripts) {
      const label = `HYDRATE:${script.name}`;
      if (script.tier == null) {
        step(
          steps,
          label,
          'skipped',
          `unknown tier segment — expected one of ${TIER_ORDER.join('/')}`,
        );
        continue;
      }
      if (!tierIncludes(tier, script.tier)) {
        step(
          steps,
          label,
          'skipped',
          `tier ${script.tier} not included in --${tier}`,
        );
        continue;
      }
      if (packageManager == null) {
        step(
          steps,
          label,
          'skipped',
          'no package manager detected — cannot run scripts',
        );
        continue;
      }
      if (dryRun) {
        step(
          steps,
          label,
          'skipped',
          `dry-run: would run \`${packageManager} run ${script.name}\``,
        );
        continue;
      }
      const child = runChild([packageManager, 'run', script.name], target);
      if (child.exitCode !== 0) {
        step(
          steps,
          label,
          'failed',
          `exited ${child.exitCode}${child.error == null ? '' : ` (${child.error})`}`,
        );
        result.exitCode = 1;
        return finish(result);
      }
      step(steps, label, 'done', `${packageManager} run ${script.name}`);
    }
  }

  return finish(result);
}

// ---------------------------------------------------------------------------
// worktree-new
// ---------------------------------------------------------------------------

export interface WorktreeNewOptions {
  /** Where the command was invoked; used to resolve the repo. Defaults to cwd. */
  cwd?: string;
  /** Skip hydration entirely (just create the worktree). */
  noSetup?: boolean;
  slug: string;
  tier?: Tier;
}

export interface WorktreeNewResult {
  /** `origin/HEAD` or `HEAD`, or null if creation never happened. */
  baseRef: string | null;
  branch: string;
  exitCode: number;
  /** Absolute worktree path — null if it was not created. */
  path: string | null;
  setup: WorktreeSetupResult | null;
}

/**
 * Create a worktree exactly the way Claude Code does — directory
 * `<primary>/.claude/worktrees/<slug>`, branch `worktree-<slug>` (D2) — and
 * then hydrate it.
 *
 * Prints the absolute worktree path as the ONLY stdout line, as soon as
 * creation succeeds: creation is the irreversible fact, so the `wt` zsh
 * function can still `cd` there to debug when hydration afterwards fails. The
 * exit code reflects hydration.
 *
 * Refuses rather than guesses when the name is partly taken: an existing
 * directory is the `wt` function's own switch-to-existing case, and an existing
 * branch with no directory would mean silently attaching to unknown work.
 */
export function worktreeNew(options: WorktreeNewOptions): WorktreeNewResult {
  const {slug} = options;
  const branch = `${WORKTREE_BRANCH_PREFIX}${slug}`;
  const cwd = resolve(options.cwd ?? process.cwd());
  const failed = (message: string): WorktreeNewResult => {
    report(`${RED}Error:${RESET} ${message}`);
    return {baseRef: null, branch, exitCode: 1, path: null, setup: null};
  };

  if (!SLUG_PATTERN.test(slug)) {
    return failed(
      `invalid slug ${JSON.stringify(slug)} — must match ${String(SLUG_PATTERN)} (no slashes: the slug names both the directory and the branch)`,
    );
  }

  const primary = resolvePrimaryCheckout(cwd);
  if (primary == null) {
    return failed(`not inside a git repository: ${cwd}`);
  }

  const worktreePath = join(primary, ...WORKTREE_DIR_SEGMENTS, slug);
  if (existsSync(worktreePath)) {
    return failed(
      `worktree directory already exists: ${worktreePath} (use \`wt\` to switch to it)`,
    );
  }
  if (
    gitSucceeds(
      ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
      cwd,
    )
  ) {
    return failed(
      `branch ${branch} already exists but ${worktreePath} does not — refusing to attach silently. Delete the branch, pick another slug, or create the worktree yourself.`,
    );
  }

  // origin/HEAD when it already resolves locally; never fetch (a create should
  // not block on the network).
  const baseRef = gitSucceeds(
    ['rev-parse', '--verify', '--quiet', 'origin/HEAD'],
    cwd,
  )
    ? 'origin/HEAD'
    : 'HEAD';
  report(`${BOLD}worktree-new${RESET} ${branch} ${DIM}from ${baseRef}${RESET}`);

  const add = runChild(
    ['git', 'worktree', 'add', '-b', branch, worktreePath, baseRef],
    cwd,
  );
  if (add.exitCode !== 0) {
    report(
      `${RED}Error:${RESET} git worktree add exited ${add.exitCode}${add.error == null ? '' : ` (${add.error})`}`,
    );
    return {baseRef, branch, exitCode: 1, path: null, setup: null};
  }

  // The one and only stdout line (D1).
  process.stdout.write(`${worktreePath}\n`);

  if (options.noSetup === true) {
    report(`  ${DIM}⊘ hydration skipped (--no-setup)${RESET}`);
    return {baseRef, branch, exitCode: 0, path: worktreePath, setup: null};
  }

  const setup = worktreeSetup({target: worktreePath, tier: options.tier});
  if (setup.exitCode !== 0) {
    report(
      `${YELLOW}⚠${RESET} worktree created at ${worktreePath} but hydration failed`,
    );
  }
  return {
    baseRef,
    branch,
    exitCode: setup.exitCode,
    path: worktreePath,
    setup,
  };
}
