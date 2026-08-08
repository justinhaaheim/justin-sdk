#!/usr/bin/env bun

/**
 * setup-env — hydrate a checkout's gitignored build state, for fresh git
 * worktrees, fresh clones, and remote (Claude Code web) environments.
 *
 * Supersedes the copied `scripts/setup-env.ts` template (home-base-j2n7): the
 * 209-line per-project copy could not stay in sync even in principle (a repo
 * with a different prettier config rewrites it on contact), so the logic lives
 * HERE and projects carry only a hook line + a package.json alias.
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
 * EXECUTION MODEL (home-base-j2n7 decision, Justin 2026-08-08):
 *   - LOCAL: runs at worktree creation (post-checkout preamble) and on manual
 *     invocation ONLY — never on a session-start heartbeat. Write actions need
 *     a trigger, not a heartbeat; no hidden side effects. Local session start
 *     gets the read-only ENV_HYDRATION doctor check instead (worktree-hydration.ts).
 *   - REMOTE (CLAUDE_CODE_REMOTE=true): runs at SessionStart via the hook
 *     line, and additionally bootstraps the environment (mise install, PATH
 *     wiring via CLAUDE_ENV_FILE) then delegates to `doctor --fix --yes`.
 *
 * STATIC-SAFE (D1). Must work as
 * `bunx github:justinhaaheim/justin-sdk setup-env` in a repo that has never
 * installed the SDK — because a fresh worktree has no node_modules, so a
 * project-local `bun run setup-env` alias cannot possibly work there.
 * Consequences, both load-bearing:
 *   - nothing here may resolve an import from the consumer project, and nothing
 *     may read justin-sdk.config.json. Only node builtins, the SDK's own
 *     dependencies (`ignore`), and SDK-local modules.
 *   - all human-readable report output goes to STDERR. stdout is machine
 *     output only: EMPTY for setup-env, and exactly one line (the absolute
 *     worktree path) for worktree-new (src/worktree-new.ts), which the `wt`
 *     zsh function captures to `cd`.
 *
 * SUBMODULES ARE PART OF "WHAT GIT TRACKS", BUT ONLY AS A POINTER. A fresh
 * worktree gets an EMPTY directory for every submodule, and when a submodule
 * backs a package-manager WORKSPACE (home-base consumes justin-sdk exactly that
 * way) the install dies with `Workspace not found "<path>"` — an error that
 * names the package.json rather than the submodule, i.e. the same
 * misdiagnosis-by-misleading-error this command exists to kill
 * (home-base-v170.7). Hence a SUBMODULES step BEFORE install.
 *
 * .worktreeinclude IS THE ONLY COPY MANIFEST (D4). Claude Code natively copies
 * gitignored files matching that root-level, gitignore-syntax file into the
 * worktrees IT creates — but it is NOT processed for a manual
 * `git worktree add`. So we honor the same file: one manifest, two consumers,
 * no second `copyFromPrimary` config key. Matching uses the `ignore` package
 * (the parser eslint and prettier use internally), never hand-rolled globbing.
 *
 * PROJECT SCRIPTS — `setup-env:<LABEL>`, FLAT, NO TIERS (j2n7 supersedes D5).
 * Same discovery convention as `signal-source:` (src/signal.ts) and
 * `fix-source:` (src/fix.ts); run serially in package.json DECLARATION order
 * (hydration steps have real generate-then-consume ordering, unlike
 * fix-source's label sort). Scripts are SELF-GUARDING: environment awareness
 * (remote-only installs, idempotence) lives in the script, not in engine
 * modes — reference: apple-reminders-mcp's setup-env:swift / setup-env:sqlite,
 * which no-op in milliseconds on macOS. The v170 tier system (lint/js/native)
 * was removed after a fleet autopsy found ZERO genuinely-needed tiered
 * scripts — the only adopter's three were convention-filling, each redundant
 * with an existing mechanism (expo prebuild auto-installs pods; every build
 * path already runs prebuild; `prepare` regenerates the dynamic version on
 * every install). See home-base-j2n7's ruled-out comment before reintroducing
 * a cost filter here.
 *
 * NOT built on check-runner, deliberately: check-runner has no per-check cwd
 * (it hardcodes `process.cwd()`), and its summary prints to stdout — both
 * disqualifying here, where every step runs with cwd = the TARGET tree and
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
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  resolve,
  sep,
} from 'node:path';
import ignore from 'ignore';

// ---------------------------------------------------------------------------
// Constants and public types
// ---------------------------------------------------------------------------

/** Cost-ordered and cumulative: lint ⊂ js ⊂ native. */
/** package.json script prefix, mirroring `signal-source:` / `fix-source:`. */
export const SETUP_ENV_SOURCE_PREFIX = 'setup-env:';

/**
 * The v170-era tiered prefix. Discovery still RECOGNIZES it — but only to
 * skip it with a rename hint, so a project carrying stale scripts gets one
 * clear line instead of silent non-execution.
 */
export const LEGACY_WORKTREE_SOURCE_PREFIX = 'worktree-source:';

/** Claude Code's own convention (D2) — byte-identical on purpose. */
export const WORKTREE_DIR_SEGMENTS = ['.claude', 'worktrees'] as const;
export const WORKTREE_BRANCH_PREFIX = 'worktree-';

/** The manifest Claude Code reads natively; we read the same one (D4). */
export const WORKTREE_INCLUDE_FILE = '.worktreeinclude';

/** Tracked file whose presence is the only sign a repo has submodules at all. */
export const GITMODULES_FILE = '.gitmodules';

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

export interface SetupEnvOptions {
  dryRun?: boolean;
  /** Directory to hydrate. Defaults to cwd. */
  target?: string;
}

export interface SetupEnvResult {
  exitCode: number;
  /** Absolute path of the primary checkout, or null if unresolvable. */
  primary: string | null;
  steps: StepReport[];
  target: string;
}

export type PackageManager = 'bun' | 'npm' | 'yarn';

// ---------------------------------------------------------------------------
// stderr reporting
// ---------------------------------------------------------------------------

export const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
export const RED = '\x1b[31m';
export const DIM = '\x1b[2m';
export const BOLD = '\x1b[1m';
export const YELLOW = '\x1b[33m';

/**
 * Every human-readable line in this module (and worktree-new.ts, which shares
 * the stdout contract) goes through here. Nothing here may use console.log —
 * stdout is reserved for machine output (D1).
 */
export function report(line: string): void {
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
// git plumbing
// ---------------------------------------------------------------------------

/**
 * Run git and capture stdout VERBATIM, or null on any failure. argv form only —
 * a prior SDK bug was exactly a shell-interpolated ref name, so paths and branch
 * names never go through a shell here.
 *
 * Used directly only where LEADING whitespace is data. `git submodule status` is
 * exactly that case: its first column is a single status character, and an
 * initialized submodule's is a SPACE. Trimming the output therefore deletes the
 * status of the first submodule listed and makes it unparseable — a bug this
 * module actually shipped for the length of one test run.
 */
function gitCaptureRaw(argv: string[], cwd: string): string | null {
  try {
    return execFileSync('git', argv, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}

/** gitCaptureRaw, trimmed — the right default for single-value plumbing output. */
function gitCapture(argv: string[], cwd: string): string | null {
  return gitCaptureRaw(argv, cwd)?.trim() ?? null;
}

/** True if git exits 0. Used for existence probes (`rev-parse --verify`). */
export function gitSucceeds(argv: string[], cwd: string): boolean {
  try {
    execFileSync('git', argv, {cwd, stdio: ['pipe', 'pipe', 'pipe']});
    return true;
  } catch {
    return false;
  }
}

/**
 * The two git admin paths whose (in)equality is the ONLY reliable
 * linked-worktree test, resolved absolute.
 *
 * Why nothing simpler works: `.git` being a FILE does not mean "linked
 * worktree" — a submodule or a `--separate-git-dir` MAIN checkout has one too,
 * and THIS SDK is exactly that case — and `git worktree list` misreports the
 * main worktree for a submodule. `--git-dir` is per-worktree while
 * `--git-common-dir` is shared by every worktree of the repo, so they differ if
 * and only if the caller is inside a linked worktree.
 */
export interface GitTopology {
  /**
   * Absolute `--git-common-dir` — shared by every worktree of the repo. In the
   * no-subprocess fast path below this is `<target>/.git` as spelled, NOT
   * realpath-canonicalized; only its equality with `gitDir` is load-bearing.
   */
  commonDir: string;
  /** Absolute `--git-dir` — per-worktree. null only if git failed to report it. */
  gitDir: string | null;
  /**
   * True iff this is a LINKED worktree. Deliberately false when `gitDir` is
   * unknown: a false negative costs only a missed hint, while a false positive
   * would make `signal` refuse to run in a perfectly healthy checkout.
   */
  isLinked: boolean;
}

/**
 * Resolve `target`'s git topology, or null if it is not in a git repo.
 */
export function resolveGitTopology(target: string): GitTopology | null {
  // Fast path, no subprocess: a `.git` DIRECTORY means `target` is the MAIN
  // worktree of its repo — `git worktree add` always writes a gitFILE, never a
  // directory — and in that layout both --git-dir and --git-common-dir return
  // exactly this path. Worth special-casing because this predicate now runs
  // inside EVERY `signal` invocation, where a primary checkout is the
  // overwhelmingly common case and must cost nothing. The converse is NOT
  // true, so a `.git` file (or no `.git` at all, i.e. a subdirectory of the
  // repo) falls through to git itself.
  try {
    if (statSync(join(target, '.git')).isDirectory()) {
      const abs = resolve(target, '.git');
      return {commonDir: abs, gitDir: abs, isLinked: false};
    }
  } catch {
    // Missing or unreadable — ask git.
  }

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

  return {commonDir, gitDir, isLinked: gitDir != null && gitDir !== commonDir};
}

/**
 * True iff `target` sits inside a LINKED git worktree.
 *
 * THE one definition — worktree hydration detection, the doctor
 * WORKTREE_HYDRATION check and the `signal` preflight all route here. Two
 * implementations that could disagree about "is this a worktree?" would
 * reintroduce exactly the misdiagnosis this feature exists to eliminate.
 */
export function isLinkedWorktree(target: string): boolean {
  return resolveGitTopology(target)?.isLinked === true;
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
 *
 * `topology` is an optional already-resolved GitTopology, so a caller that
 * needed the linked-worktree predicate first does not pay for the same two
 * `rev-parse` calls twice. Omitting it is always equivalent.
 */
export function resolvePrimaryCheckout(
  target: string,
  topology?: GitTopology | null,
): string | null {
  const resolved =
    topology === undefined ? resolveGitTopology(target) : topology;
  if (resolved == null) return null;
  const {commonDir, gitDir} = resolved;

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

export interface ChildResult {
  exitCode: number;
  error: string | null;
}

/**
 * Run a child process with its stdout AND stderr wired straight to OUR stderr
 * (fd 2). Live, unbuffered, and structurally incapable of polluting stdout —
 * which matters because project hydration scripts print freely and
 * worktree-new's stdout contract is a single line.
 */
export function runChild(argv: string[], cwd: string): ChildResult {
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
// Step 3: git submodules
// ---------------------------------------------------------------------------

/**
 * `--init --recursive`, matching home-base's .husky/post-checkout hook exactly
 * (AC6). Recursive because a submodule may itself have submodules, and the
 * non-recursive form leaves those empty — the identical failure one level down.
 */
export const SUBMODULE_UPDATE_ARGV = [
  'git',
  'submodule',
  'update',
  '--init',
  '--recursive',
] as const;

/** Human-readable form of SUBMODULE_UPDATE_ARGV, for report details. */
const SUBMODULE_UPDATE_COMMAND = SUBMODULE_UPDATE_ARGV.join(' ');

export interface SubmoduleStatus {
  /** Every submodule path git reported, initialized or not. */
  all: string[];
  /** Paths git reports as NOT initialized — status line prefix `-`. */
  uninitialized: string[];
}

/**
 * A `git submodule status` line: one prefix character, the object id, a space,
 * then the path, then an OPTIONAL ` (<describe>)` suffix which git omits for an
 * uninitialized submodule. Verified against git 2.x output for both states, both
 * top-level and `--recursive`.
 *
 * The path group is lazy so the optional suffix wins where it exists; the object
 * id is 40 or 64 hex characters (sha1 / sha256 repositories). A submodule path
 * that itself ENDS in ` (...)` would have that stripped — accepted, because the
 * path is only ever printed, never acted on.
 */
const SUBMODULE_STATUS_LINE = /^(.)[0-9a-f]{40,64} (.*?)(?: \([^)]*\))?$/;

/**
 * Parse `git submodule status --recursive` output.
 *
 * The load-bearing datum is the PREFIX character, which is the documented
 * "needs initializing" signal: `-` means the submodule is not initialized, while
 * ` `, `+` (checked out at a different commit) and `U` (conflicts) all mean it
 * IS. So a dirty-but-populated submodule is correctly left alone — this step
 * initializes, it does not reconcile.
 */
export function parseSubmoduleStatus(stdout: string): SubmoduleStatus {
  const all: string[] = [];
  const uninitialized: string[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trimEnd();
    if (line === '') continue;
    const match = SUBMODULE_STATUS_LINE.exec(line);
    if (match == null) continue;
    const [, prefix, path] = match;
    if (path == null || path === '') continue;
    all.push(path);
    if (prefix === '-') uninitialized.push(path);
  }
  return {all, uninitialized};
}

export type SubmoduleProbe =
  | {kind: 'known'; status: SubmoduleStatus}
  | {kind: 'none'}
  | {kind: 'unknown'};

/**
 * What submodule work `target` needs, without changing anything.
 *
 * `none` (no `.gitmodules`) is the overwhelmingly common fleet case and must
 * cost one `stat`, so the whole probe short-circuits there — no subprocess, no
 * new noise in the report for the ~all repos that have no submodules (AC2).
 *
 * `unknown` means `.gitmodules` exists but `git submodule status` could not be
 * read. That is deliberately NOT treated as "nothing to do": silently skipping
 * is how the original bug reappears (the install then fails naming a workspace),
 * so the caller attempts the init and lets git report the real reason.
 */
export function probeSubmodules(target: string): SubmoduleProbe {
  if (!existsSync(join(target, GITMODULES_FILE))) return {kind: 'none'};
  // RAW, not gitCapture: the leading space of an initialized submodule's status
  // line IS the status, and trimming it silently loses the first submodule.
  const output = gitCaptureRaw(['submodule', 'status', '--recursive'], target);
  if (output == null) return {kind: 'unknown'};
  return {kind: 'known', status: parseSubmoduleStatus(output)};
}

/** `2 submodules (a, b)` — count first so the detail reads at a glance. */
function describeSubmodulePaths(paths: string[]): string {
  const noun = paths.length === 1 ? 'submodule' : 'submodules';
  return `${paths.length} ${noun}${paths.length > 0 ? ` (${paths.join(', ')})` : ''}`;
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
// Step 5: .worktreeinclude copy plan
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
  /**
   * Manifest lines (trimmed, verbatim) that contributed ZERO entries — finding
   * F3. Without this the report says "copied 0" and never says WHY, so a real
   * manifest with a directory-naming line (`ios/`) silently underdelivers: this
   * step copies FILES, not trees, so such a line can never match anything.
   * Comment (`#`) and negation (`!`) lines are excluded — neither is expected to
   * contribute an entry.
   */
  unmatchedPatterns: string[];
}

const GLOB_METACHARS = /[*?[\]!]/;

/**
 * Normalize a manifest line to a clean repo-relative POSIX path, or null if it
 * is not one.
 *
 * This is a hard requirement, not tidiness: `ignore`'s matcher THROWS a
 * RangeError ("path should be a `path.relative()`d string") for absolute,
 * `./`-prefixed, or `..`-escaping paths, and a TypeError for an empty one. A
 * `.worktreeinclude` line of `./foo` — a common habit, even though gitignore
 * syntax doesn't need the prefix — would otherwise crash the command with an
 * unhandled exception. `./foo` normalizes to `foo`; anything escaping the repo
 * is rejected outright.
 */
function toRelativeCandidate(line: string): string | null {
  const trimmed = line.replace(/^\/+/, '').replace(/\/+$/, '');
  if (trimmed === '') return null;
  const normalized = normalize(trimmed).split(sep).join('/');
  if (normalized === '' || normalized === '.') return null;
  if (normalized === '..' || normalized.startsWith('../')) return null;
  if (isAbsolute(normalized)) return null;
  return normalized;
}

/**
 * Match a path against the manifest, treating any matcher throw as "no match".
 * Belt-and-braces with toRelativeCandidate: no content of a project's
 * `.worktreeinclude` should ever be able to crash hydration.
 */
function matchesManifest(
  matcher: ReturnType<typeof ignore>,
  relPath: string,
): boolean {
  try {
    return matcher.ignores(relPath);
  } catch {
    return false;
  }
}

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
    const relPath = toRelativeCandidate(line);
    if (relPath == null) continue;
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
    return {
      entries: [],
      hasManifest: false,
      manifestPath,
      unmatchedPatterns: [],
    };
  }

  const content = readFileSync(manifestPath, 'utf-8');
  const matcher = ignore().add(content);
  const candidates = collectCandidates(primary, content.split('\n'));

  const entries: CopyPlanEntry[] = [];
  for (const relPath of candidates) {
    if (!matchesManifest(matcher, relPath)) continue;
    if (!gitSucceeds(['check-ignore', '-q', '--', relPath], primary)) continue;
    entries.push({
      relPath,
      action: existsSync(join(target, relPath)) ? 'skip-exists' : 'copy',
    });
  }

  return {
    entries,
    hasManifest: true,
    manifestPath,
    unmatchedPatterns: findUnmatchedPatterns(content, entries),
  };
}

/**
 * Which manifest lines contributed nothing (F3).
 *
 * Attribution is done against the FINAL entries, using a fresh single-line
 * matcher per pattern. Two consequences, both deliberate:
 *   - a pattern whose only candidate was removed by a later `!` negation is
 *     correctly reported as contributing nothing;
 *   - a pattern that jointly matches an entry another line also matched still
 *     gets credit, so `ios/` alongside `ios/.xcode.env.local` is NOT warned
 *     about — it really did name the file that got copied.
 * `skip-exists` entries count as contributions: the pattern named a copyable
 * file, it just happened to already be in the target.
 */
function findUnmatchedPatterns(
  content: string,
  entries: CopyPlanEntry[],
): string[] {
  const unmatched: string[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith('!')) continue;
    const single = ignore().add(line);
    if (entries.some((entry) => matchesManifest(single, entry.relPath))) {
      continue;
    }
    unmatched.push(line);
  }
  return unmatched;
}

/**
 * Why a pattern found nothing. The directory case is by far the most likely in a
 * real manifest (`ios/`, `android/`) and has a concrete remedy, so it gets its
 * own sentence rather than a generic one.
 */
function explainUnmatchedPattern(pattern: string): string {
  return pattern.endsWith('/')
    ? 'directories are not copied — list files'
    : 'nothing gitignored, untracked and present in the primary checkout matches it';
}

// ---------------------------------------------------------------------------
// Step 6: setup-env:<LABEL> discovery
// ---------------------------------------------------------------------------

export interface HydrationScript {
  /** Full package.json script name, e.g. `setup-env:swift`. */
  name: string;
  label: string;
  /**
   * True for a v170-era `worktree-source:<tier>:<LABEL>` script. Legacy
   * scripts are never RUN — they are reported with a rename hint, so stale
   * ones surface as one clear line instead of silently not executing.
   */
  legacy: boolean;
}

/**
 * Discover `setup-env:<LABEL>` scripts from a package.json, in DECLARATION
 * order (unlike `fix-source:`, which sorts by label — hydration steps have
 * real ordering dependencies, e.g. generate-then-consume).
 *
 * The bare `setup-env` script (no colon) is the project's own alias for this
 * command and is structurally excluded by the prefix — running it from here
 * would recurse.
 *
 * Also returns v170-era `worktree-source:` scripts as `legacy: true` entries.
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
    if (name.startsWith(SETUP_ENV_SOURCE_PREFIX)) {
      const label = name.slice(SETUP_ENV_SOURCE_PREFIX.length);
      if (label === '') continue;
      found.push({label, legacy: false, name});
      continue;
    }
    if (name.startsWith(LEGACY_WORKTREE_SOURCE_PREFIX)) {
      const rest = name.slice(LEGACY_WORKTREE_SOURCE_PREFIX.length);
      const separator = rest.indexOf(':');
      const label = separator >= 0 ? rest.slice(separator + 1) : rest;
      found.push({label, legacy: true, name});
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// worktree-setup
// ---------------------------------------------------------------------------

/**
 * Why `mise trust` failing aborts the run WITH a specific hint (F4).
 *
 * The abort itself is ruled (home-base-v170.1): an install into an untrusted
 * mise tree fails confusingly, so continuing is worse. But the epic's failure
 * mode 4 records the single most likely cause, and it is not the user's fault —
 * `mise trust` records trust by writing into ~/.local/state/mise/trusted-configs,
 * which a sandboxed agent is routinely blocked from. Without naming it, the
 * report says only "mise trust exited 1" and the next twenty minutes go to
 * debugging mise.
 */
export function formatMiseFailureDetail(
  exitCode: number,
  error: string | null,
): string {
  return (
    `mise trust exited ${exitCode}${error == null ? '' : ` (${error})`} — ` +
    'note: `mise trust` writes a symlink into ~/.local/state/mise/trusted-configs, ' +
    'and a sandboxed agent may be blocked from that; re-run outside the sandbox'
  );
}

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

function finish(result: SetupEnvResult): SetupEnvResult {
  const counts = {done: 0, failed: 0, skipped: 0};
  for (const s of result.steps) counts[s.status] += 1;
  const parts = [`${counts.done} done`, `${counts.skipped} skipped`];
  if (counts.failed > 0) parts.push(`${RED}${counts.failed} failed${RESET}`);
  report(`  ${DIM}${parts.join(', ')}${RESET}`);
  return result;
}

/**
 * Hydrate a checkout (worktree, clone, or primary). Steps run in a fixed order
 * and STOP at the first failure, because each later step assumes the earlier
 * ones: an install into an untrusted mise tree fails confusingly, an install
 * with an empty submodule-backed workspace fails outright, and a hydration
 * script cannot run without node_modules.
 *
 * Idempotent (epic AC #3): step 3 skips when every submodule is already
 * populated, step 4 is a no-op reinstall, step 5 skips files already present,
 * and step 6's scripts are the project's own responsibility — they ARE re-run on
 * every invocation, so projects must write them to be safely repeatable.
 */
export function setupEnv(options: SetupEnvOptions = {}): SetupEnvResult {
  const dryRun = options.dryRun === true;
  const target = resolve(options.target ?? process.cwd());
  const steps: StepReport[] = [];
  const result: SetupEnvResult = {
    exitCode: 0,
    primary: null,
    steps,
    target,
  };

  report(
    `${BOLD}setup-env${RESET} ${target}${dryRun ? ` ${DIM}(dry-run)${RESET}` : ''}`,
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
        formatMiseFailureDetail(child.exitCode, child.error),
      );
      result.exitCode = 1;
      return finish(result);
    }
    step(steps, 'MISE', 'done', 'mise trust');
  }

  // --- Step 3: git submodules ----------------------------------------------
  // BEFORE install, because an empty submodule directory that backs a
  // package-manager workspace makes the install fail outright
  // (home-base-v170.7). AFTER mise trust, because nothing here reads mise.
  const submodules: SubmoduleProbe =
    primary == null ? {kind: 'none'} : probeSubmodules(target);
  if (submodules.kind === 'none') {
    // `primary == null` collapses into this branch on purpose: with no git repo
    // there is nothing to initialize, and RESOLVE has already said so.
    step(steps, 'SUBMODULES', 'skipped', `no ${GITMODULES_FILE}`);
  } else if (
    submodules.kind === 'known' &&
    submodules.status.all.length === 0
  ) {
    step(
      steps,
      'SUBMODULES',
      'skipped',
      `${GITMODULES_FILE} present but git reports no submodules`,
    );
  } else if (
    submodules.kind === 'known' &&
    submodules.status.uninitialized.length === 0
  ) {
    // AC3: idempotent — a populated submodule is reported skipped, not re-done.
    step(
      steps,
      'SUBMODULES',
      'skipped',
      `already initialized — ${describeSubmodulePaths(submodules.status.all)}`,
    );
  } else {
    const pending =
      submodules.kind === 'known'
        ? `uninitialized: ${describeSubmodulePaths(submodules.status.uninitialized)}`
        : `\`git submodule status\` unreadable — attempting anyway`;
    if (dryRun) {
      step(
        steps,
        'SUBMODULES',
        'skipped',
        `dry-run: would run \`${SUBMODULE_UPDATE_COMMAND}\` (${pending})`,
      );
    } else {
      const child = runChild([...SUBMODULE_UPDATE_ARGV], target);
      if (child.exitCode !== 0) {
        step(
          steps,
          'SUBMODULES',
          'failed',
          `${SUBMODULE_UPDATE_COMMAND} exited ${child.exitCode}${child.error == null ? '' : ` (${child.error})`}`,
        );
        result.exitCode = 1;
        return finish(result);
      }
      step(
        steps,
        'SUBMODULES',
        'done',
        `${SUBMODULE_UPDATE_COMMAND} (${pending})`,
      );
    }
  }

  // --- Step 4: install dependencies ---------------------------------------
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

  // --- Step 5: .worktreeinclude copy --------------------------------------
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
      // F3: name every manifest line that contributed nothing. "copied 0" with
      // no reason is how a manifest silently underdelivers — and these lines are
      // ADVISORY, never a failure: the manifest is the project's to fix, and a
      // stale line in it must not break hydration.
      for (const pattern of plan.unmatchedPatterns) {
        report(
          `  ${YELLOW}⚠${RESET} ${WORKTREE_INCLUDE_FILE} pattern '${pattern}' matched no copyable files ${DIM}(${explainUnmatchedPattern(pattern)})${RESET}`,
        );
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

  // --- Step 6: project-declared hydration scripts -------------------------
  const scripts = discoverHydrationScripts(target);
  if (scripts.length === 0) {
    step(
      steps,
      'HYDRATE',
      'skipped',
      `no ${SETUP_ENV_SOURCE_PREFIX}<LABEL> scripts in package.json`,
    );
  } else {
    for (const script of scripts) {
      const label = `HYDRATE:${script.name}`;
      if (script.legacy) {
        step(
          steps,
          label,
          'skipped',
          `deprecated ${LEGACY_WORKTREE_SOURCE_PREFIX} script (tiers were removed) — rename to ${SETUP_ENV_SOURCE_PREFIX}${script.label} to run it, or delete it`,
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
