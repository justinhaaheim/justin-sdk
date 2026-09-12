/**
 * worktree-hydration.ts — detect a STALE or UNHYDRATED environment: linked
 * worktrees AND primary checkouts (home-base-j2n7 extends the v170 detector).
 *
 * WHY THIS IS THE HIGHEST-VALUE PIECE OF THE FEATURE. `setup-env` (see
 * src/setup-env.ts) is the FIXER; this is the GUARD. A fresh `git worktree`
 * contains only what git TRACKS, so every piece of gitignored build state is
 * absent — and the errors that produces name the WRONG CAUSE: ~10 eslint/tsc
 * failures in files the change never touched, CocoaPods errors pointing at the
 * primary checkout, `mise` refusing to run because the new mise.toml path is
 * untrusted. The natural response is to debug the wrong thing for twenty
 * minutes. This module converts that into a one-line instruction.
 *
 * THE PRIMARY-CHECKOUT CASE (j2n7.2): "check out a branch that added a dep,
 * forget to bun install, lose many minutes to the wrong error" is the same
 * misdiagnosis in the PRIMARY checkout — so the deps probes now run there too,
 * surfaced by doctor at severity WARN. Setup-env's execution model makes this
 * the only session-start guard locally: the fixer never runs on a heartbeat
 * (no hidden side effects), so the detector must speak up.
 *
 * WHY THE DEPS PROBE IS CONTENT-BASED, NOT MTIME-BASED (measured 2026-08-08,
 * j2n7.2 spec amendment): a no-op `bun install` does NOT touch node_modules'
 * mtime, so an mtime(node_modules) >= mtime(bun.lock) rule would keep warning
 * AFTER its own prescribed fix ran — a nagging-forever loop. Instead: every
 * declared dep has a directory, and (for semver-range specifiers only)
 * the installed version satisfies the declared range. Both clear naturally
 * after any successful install. `bun install --dry-run` was also ruled out —
 * it reports the resolved graph, not disk state (byte-identical output with a
 * package present vs deleted).
 *
 * TWO CONSUMERS, ONE DETECTION (D3 — the integration points are doctor and
 * signal, NOT a WorktreeCreate hook):
 *   - src/doctor.ts   — the ENV_HYDRATION check (error in a linked worktree,
 *                       warn in a primary checkout).
 *   - src/signal.ts   — a PREFLIGHT that refuses to run the checks at all,
 *                       because relaying phantom failures is worse than
 *                       printing nothing. DELIBERATELY still linked-worktree
 *                       only (j2n7.2 ruling): signal in a primary checkout has
 *                       always run against whatever tree exists, and its
 *                       failures there are real and loud, not phantom.
 *
 * BUDGET: < ~200ms. `git rev-parse`, `git check-ignore`, `stat`, at most one
 * `mise trust --show`, and up to one package.json read per declared dep
 * (~0.1ms each). No installs, no network, no mutation — this is a detector,
 * and a detector that changes state is a bug.
 */

import {execFileSync} from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import {homedir} from 'node:os';
import {isAbsolute, join, normalize, resolve} from 'node:path';
import {satisfies, validRange} from 'semver';

import {
  planWorktreeIncludeCopies,
  resolveGitTopology,
  resolvePrimaryCheckout,
  SETUP_ENV_SOURCE_PREFIX,
  WORKTREE_INCLUDE_FILE,
} from './setup-env';

/**
 * Re-exported so every consumer can get the predicate from this module without
 * needing to know that the git plumbing lives next to `worktree-setup`. There is
 * still exactly ONE implementation.
 */
export {isLinkedWorktree} from './setup-env';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type HydrationProblemKind =
  | 'dep-missing'
  | 'dep-version'
  /**
   * A file NAMED LITERALLY in this checkout's tsconfig `include`/`files` that
   * exists in the primary but not here (home-base-qe6b.4, D1) — a generated,
   * gitignored input no `.worktreeinclude` manifest lists. Advisory.
   */
  | 'generated-input'
  | 'mise-untrusted'
  | 'node-modules'
  | 'node-modules-symlink'
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
  /**
   * Deps/mise problems can appear for ANY checkout; worktreeinclude problems
   * only when `isLinkedWorktree` (they need a primary to copy from).
   */
  problems: HydrationProblem[];
  target: string;
}

/**
 * The problem kinds that make `signal` UNRUNNABLE, as opposed to merely
 * incomplete (finding F7). Exported at kind level so signal and any future
 * consumer share one definition of the split instead of each re-deciding it.
 *
 * Only node_modules qualifies, and the test is specifically "does this cause
 * PHANTOM CHECK FAILURES" — the single misdiagnosis the preflight exists to
 * prevent. Without node_modules, eslint and tsc fail in files the change never
 * touched, so relaying those results is worse than printing nothing.
 *
 * The others are hydration gaps that do not, on their own, make `signal` lie: a
 * missing `.worktreeinclude` file (a `.env.local`, a generated version file) and
 * an untrusted `mise.toml` may break a BUILD, but they do not corrupt check
 * results. Blocking on them would make `signal` unrunnable with no override in a
 * tree where it would have worked fine — which is the escape-hatch concern
 * raised on bead home-base-v170.2 and ruled here.
 *
 * `generated-input` IS ADVISORY BY DECISION (home-base-qe6b.4 D1), and it is the
 * one advisory kind for which the no-corruption claim is NOT safe to make: a
 * missing `expo-env.d.ts` was measured to flip typescript-eslint's
 * projectService program to `any` and produce 16 phantom `no-unsafe-*` errors,
 * while `tsc --noEmit` stayed green. It is advisory anyway because the FIRST
 * job is making the gap visible — promoting it to blocking would make `signal`
 * refuse to run fleet-wide off a heuristic that has never been exercised, which
 * is a far bigger change than this bead. The consequence sentence doctor prints
 * is split accordingly (see `makeEnvHydrationChecks`) rather than over-claiming.
 *
 * DOCTOR'S GATE IS DELIBERATELY NOT SPLIT: it reports state rather than gating
 * work, so it fires on ANY problem. Its MESSAGE does consult the split
 * (home-base-v170.6) — the PHANTOM claim is only true of a blocking problem, and
 * over-claiming it where it is false is what would make it disbelieved where it
 * is true.
 */
export const BLOCKING_PROBLEM_KINDS: ReadonlySet<HydrationProblemKind> =
  new Set(['node-modules']);

/** Whether this one problem makes `signal`'s results untrustworthy. */
export function isBlockingProblem(problem: HydrationProblem): boolean {
  return BLOCKING_PROBLEM_KINDS.has(problem.kind);
}

/** Whether ANY problem does — the preflight's actual question. */
export function hasBlockingProblem(status: WorktreeHydrationStatus): boolean {
  return status.problems.some(isBlockingProblem);
}

/** The project-local alias every base-setup project has. */
export const SETUP_ENV_SCRIPT = 'setup-env';

/** The pre-j2n7 alias, still preferred over bunx where it exists. */
export const LEGACY_WORKTREE_SETUP_SCRIPT = 'worktree:setup';

/**
 * The static-safe invocation (D1): works in a repo that has never installed the
 * SDK, which is the whole point — a fresh worktree has no node_modules.
 */
export const SETUP_ENV_BUNX = 'bunx github:justinhaaheim/justin-sdk setup-env';

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

/**
 * True when local resolution out of node_modules cannot be trusted: the whole
 * tree is missing, individual dep dirs are missing (the missing one may be the
 * SDK itself), or node_modules is a symlink (breaks native modules and
 * file:-linked packages — the audio-journal-1 failure class). Deliberately its
 * own predicate rather than a reuse of BLOCKING_PROBLEM_KINDS (below): that
 * set answers "may signal run at all", this one answers "can a local command
 * resolve" — two different questions.
 */
function nodeModulesMissing(problems: readonly HydrationProblem[]): boolean {
  return problems.some(
    (problem) =>
      problem.kind === 'node-modules' ||
      problem.kind === 'dep-missing' ||
      problem.kind === 'node-modules-symlink',
  );
}

/**
 * The exact command to print, given what is actually MISSING (finding F6).
 *
 * Per the conductor's install-universal ruling there is NO tier flag: install
 * runs at every tier, so the default (`js`) is always the right recommendation.
 *
 * STATE-AWARE, and originally a SAFETY rule rather than an optimization. The
 * fleet convention for a `worktree:setup` alias is
 * `bunx @justinhaaheim/justin-sdk worktree-setup`, which is expected to resolve
 * the SDK out of the project's node_modules. In a worktree where node_modules is
 * MISSING that resolution fails and bunx falls through to the registry.
 *
 * When the alias still used the BARE name, that fallback fetched and EXECUTED
 * whatever `justin-sdk` resolved to on npm — an unclaimed, unscoped name anyone
 * could take. That hazard is narrowed: the aliases now name the `@justinhaaheim`
 * scope, so the fallback can only ever resolve to something published under that
 * scope, never to a top-level name a stranger can claim (home-base-2qhw). The
 * rule survives on the remaining ground — the scoped name is deliberately
 * unpublished, so the fallback simply FAILS, and printing it would hand the user
 * a command that cannot work in the exact state they are stuck in.
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
  if (nodeModulesMissing(problems)) return SETUP_ENV_BUNX;
  const pkg = readPackageJson(target);
  if (pkg?.scripts?.[SETUP_ENV_SCRIPT] != null) {
    return `bun run ${SETUP_ENV_SCRIPT}`;
  }
  return pkg?.scripts?.[LEGACY_WORKTREE_SETUP_SCRIPT] != null
    ? `bun run ${LEGACY_WORKTREE_SETUP_SCRIPT}`
    : SETUP_ENV_BUNX;
}

// ---------------------------------------------------------------------------
// tsconfig-named generated inputs (home-base-qe6b.4, D1)
// ---------------------------------------------------------------------------

/** The tsconfig this probe reads. Only the project root's own file. */
export const TSCONFIG_FILE = 'tsconfig.json';

/**
 * An `include`/`files` entry containing any of these is a PATTERN, not a named
 * file, and is deliberately ignored: a repo whose tsconfig names only globs
 * (`src/**\/*.ts`) says nothing about which individual generated files must
 * exist, and guessing would nag every worktree of every repo — the exact
 * failure mode that got the unconditional `no-manifest` advisory retracted.
 */
const GLOB_CHARACTERS = /[*?[\]{}]/;

/**
 * JSONC → JSON: strip `//` and block comments and trailing commas, both of
 * which TypeScript accepts in a tsconfig and `JSON.parse` does not. Exported
 * for its own tests.
 *
 * String-aware on purpose, in ONE pass. A regex-only stripper corrupts any
 * entry containing `//` (a URL, a Windows UNC path) or a comma before a
 * bracket, and the corruption is silent — it yields a parse that succeeds with
 * the wrong contents.
 */
export function stripJsoncExtras(text: string): string {
  let out = '';
  let index = 0;
  let inString = false;
  while (index < text.length) {
    const ch = text[index] as string;
    if (inString) {
      if (ch === '\\') {
        out += ch + (text[index + 1] ?? '');
        index += 2;
        continue;
      }
      if (ch === '"') inString = false;
      out += ch;
      index += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      index += 1;
      continue;
    }
    if (ch === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
      continue;
    }
    if (ch === '/' && text[index + 1] === '*') {
      index += 2;
      while (
        index < text.length &&
        !(text[index] === '*' && text[index + 1] === '/')
      ) {
        index += 1;
      }
      index += 2;
      continue;
    }
    if (ch === '}' || ch === ']') {
      // Drop a trailing comma. Safe here and nowhere else: we are outside every
      // string literal, so the tail being trimmed is structural punctuation.
      out = out.replace(/,\s*$/, '');
    }
    out += ch;
    index += 1;
  }
  return out;
}

/**
 * The `include` + `files` entries of a tsconfig that name ONE FILE literally,
 * normalized to a repo-relative path.
 *
 * Pure, and takes the TEXT rather than a path so the parsing rules are testable
 * without a fixture tree.
 *
 * `extends` is NOT followed (D1 scope). A base config lives in node_modules or
 * a sibling repo, its paths resolve relative to ITS directory, and every case
 * this probe exists for — `expo-env.d.ts` — is named in the repo's own file.
 * The cost is a FALSE NEGATIVE (an advisory that stays quiet), never a false
 * positive, which is the direction this detector must fail in.
 */
export function literalTsconfigInputs(tsconfigText: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsoncExtras(tsconfigText));
  } catch {
    // KNOWN BLIND SPOT, matching this module's standing convention (an
    // unparseable package.json, an unrecognized `mise trust` line): a file we
    // cannot read yields NO advisory rather than a guessed one. Reporting
    // "something may be missing" without being able to name it is exactly the
    // nagging this probe was designed around.
    return [];
  }
  if (parsed == null || typeof parsed !== 'object') return [];
  const config = parsed as {files?: unknown; include?: unknown};
  const entries = [
    ...(Array.isArray(config.include) ? config.include : []),
    ...(Array.isArray(config.files) ? config.files : []),
  ];
  const literal: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'string') continue;
    if (entry === '' || GLOB_CHARACTERS.test(entry)) continue;
    if (isAbsolute(entry)) continue;
    const relPath = normalize(entry);
    // `..` would name a file outside the checkout, where "present in the
    // primary but absent here" is meaningless (both resolve to the same place).
    if (relPath === '.' || relPath.startsWith('..')) continue;
    if (!literal.includes(relPath)) literal.push(relPath);
  }
  return literal;
}

/**
 * The `generated-input` problems for a linked worktree: every literal tsconfig
 * input that is a FILE in the primary and absent here.
 *
 * The file test is deliberate — a bare directory in `include` (`"src"`) means
 * "everything under it", is tracked, and can never be the generated-input case.
 *
 * `covered` holds the labels already reported as `worktreeinclude` problems:
 * a manifest-listed file is the SAME missing file with a better message, and
 * listing it twice would double it in doctor's `Missing:` line.
 */
function probeGeneratedInputProblems(
  primary: string,
  target: string,
  covered: ReadonlySet<string>,
): HydrationProblem[] {
  const tsconfigPath = join(target, TSCONFIG_FILE);
  if (!existsSync(tsconfigPath)) return [];
  let text: string;
  try {
    text = readFileSync(tsconfigPath, 'utf-8');
  } catch {
    return [];
  }
  const problems: HydrationProblem[] = [];
  for (const relPath of literalTsconfigInputs(text)) {
    if (covered.has(relPath)) continue;
    if (existsSync(join(target, relPath))) continue;
    let isFileInPrimary = false;
    try {
      isFileInPrimary = statSync(join(primary, relPath)).isFile();
    } catch {
      isFileInPrimary = false;
    }
    if (!isFileInPrimary) continue;
    problems.push({
      detail:
        `${relPath} is named in ${TSCONFIG_FILE} include/files and exists in the primary ` +
        `checkout but not here — a generated (gitignored) input; list it in ` +
        `${WORKTREE_INCLUDE_FILE}, or produce it with a ${SETUP_ENV_SOURCE_PREFIX}<LABEL> script`,
      kind: 'generated-input',
      label: relPath,
    });
  }
  return problems;
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

/**
 * The deps probes, shared by worktree and primary-checkout detection. All
 * READ-ONLY, all content-based (see the module header for why mtime and
 * `bun install --dry-run` are both ruled out):
 *
 *   1. node_modules absent while package.json declares dependencies — the
 *      cause of the ~10 eslint/tsc errors in untouched files.
 *   2. node_modules is a SYMLINK — breaks native modules, patch-package, and
 *      file:-linked packages (the audio-journal-1 fork's guard, absorbed here
 *      as a detection; the fix is a real install, which setup-env performs).
 *      Further per-dep probes are skipped: contents seen through the symlink
 *      belong to some other tree and would mislead either way.
 *   3. a declared dep with no directory under node_modules — the
 *      checked-out-a-branch-that-added-a-dep-and-forgot-to-install case.
 *   4. for SEMVER-RANGE specifiers only: the installed version does not
 *      satisfy the declared range (branch moved a pin; tree still has the old
 *      one). Non-registry specifiers (github:, file:, link:, workspace:*) are
 *      existence-only — validRange() rejects them. includePrerelease keeps a
 *      legitimately-locked prerelease from warning against a stable range.
 */
function probeDependencyProblems(resolved: string): HydrationProblem[] {
  const problems: HydrationProblem[] = [];
  const pkg = readPackageJson(resolved);
  const declared: Record<string, string> = {
    ...pkg?.dependencies,
    ...pkg?.devDependencies,
  };
  const names = Object.keys(declared);
  if (names.length === 0) return problems;

  const nodeModulesPath = join(resolved, 'node_modules');
  let nodeModulesStat: ReturnType<typeof lstatSync> | null = null;
  try {
    nodeModulesStat = lstatSync(nodeModulesPath);
  } catch {
    nodeModulesStat = null;
  }

  if (nodeModulesStat == null) {
    problems.push({
      detail:
        'node_modules is absent while package.json declares dependencies — eslint, tsc and every tool that lives in node_modules will fail in files you never touched',
      kind: 'node-modules',
      label: 'node_modules',
    });
    return problems;
  }

  if (nodeModulesStat.isSymbolicLink()) {
    problems.push({
      detail:
        'node_modules is a SYMLINK — native modules, patch-package, and file:-linked packages resolve against some other tree; a real install is needed',
      kind: 'node-modules-symlink',
      label: 'node_modules (symlink)',
    });
    return problems;
  }

  const missing: string[] = [];
  const mismatched: string[] = [];
  for (const [name, spec] of Object.entries(declared)) {
    if (!existsSync(join(nodeModulesPath, name))) {
      missing.push(name);
      continue;
    }
    const range = validRange(spec);
    if (range == null) continue;
    let installedVersion: string | null = null;
    try {
      const depPkg = JSON.parse(
        readFileSync(join(nodeModulesPath, name, 'package.json'), 'utf-8'),
      ) as {version?: string};
      installedVersion = depPkg.version ?? null;
    } catch {
      continue;
    }
    if (
      installedVersion != null &&
      !satisfies(installedVersion, range, {includePrerelease: true})
    ) {
      mismatched.push(`${name}@${installedVersion}≁${spec}`);
    }
  }

  if (missing.length > 0) {
    const shown = missing.slice(0, MAX_LISTED_PROBLEMS).join(', ');
    problems.push({
      detail: `${missing.length} declared dependenc${missing.length === 1 ? 'y has' : 'ies have'} no directory under node_modules (${shown}${missing.length > MAX_LISTED_PROBLEMS ? ', …' : ''}) — a branch likely added or renamed deps since the last install`,
      kind: 'dep-missing',
      label: `${missing.length} uninstalled dep${missing.length === 1 ? '' : 's'}`,
    });
  }
  if (mismatched.length > 0) {
    const shown = mismatched.slice(0, MAX_LISTED_PROBLEMS).join(', ');
    problems.push({
      detail: `installed versions no longer satisfy package.json ranges (${shown}${mismatched.length > MAX_LISTED_PROBLEMS ? ', …' : ''}) — the branch moved a pin since the last install`,
      kind: 'dep-version',
      label: `${mismatched.length} stale dep version${mismatched.length === 1 ? '' : 's'}`,
    });
  }
  return problems;
}

/**
 * Decide whether `target`'s environment is stale or unhydrated, and exactly
 * what is missing. Runs for ANY checkout (j2n7.2): the deps and mise probes
 * apply everywhere; the `.worktreeinclude` probe only inside a linked worktree
 * (it needs a primary to copy from).
 *
 * A missing primary checkout is NOT reported as a problem: we cannot know what
 * should have been copied, and inventing a problem we can't describe is worse
 * than staying quiet. A non-git directory gets the deps probes only.
 */
export function detectWorktreeHydration(
  target: string = process.cwd(),
): WorktreeHydrationStatus {
  const resolved = resolve(target);

  // One topology resolution serves both the predicate and the primary lookup.
  const topology = resolveGitTopology(resolved);
  const isLinked = topology?.isLinked === true;
  const primary = isLinked
    ? resolvePrimaryCheckout(resolved, topology)
    : topology == null
      ? null
      : resolved;

  const problems: HydrationProblem[] = [...probeDependencyProblems(resolved)];

  if (isLinked && primary != null && primary !== resolved) {
    const plan = planWorktreeIncludeCopies(primary, resolved);
    const manifestLabels = new Set<string>();
    for (const entry of plan.entries) {
      if (entry.action !== 'copy') continue;
      manifestLabels.add(entry.relPath);
      problems.push({
        detail: `${entry.relPath} is listed in ${WORKTREE_INCLUDE_FILE} and present in the primary checkout, but absent here`,
        kind: 'worktreeinclude',
        label: entry.relPath,
      });
    }
    // D1 (home-base-qe6b.4). THE BLIND SPOT THIS CLOSES: a repo with no
    // `.worktreeinclude` produced NO problem at all, so signal ran in a tree
    // missing a generated input and relayed phantom failures — the exact
    // misdiagnosis this module exists to prevent. Runs AFTER the manifest loop
    // because it consumes that loop's labels.
    problems.push(
      ...probeGeneratedInputProblems(primary, resolved, manifestLabels),
    );
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
    isLinkedWorktree: isLinked,
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
const DIM = '\x1b[2m';
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

/**
 * The ADVISORY counterpart (F7): printed when a worktree is partly unhydrated in
 * ways that cannot corrupt check results, and the checks therefore DO run.
 *
 * Deliberately three lines and deliberately not a banner. The full banner earns
 * its size by claiming the results below it are worthless; this one makes no such
 * claim, and a red rule around it would train the reader to ignore the real one.
 * It still carries all three actionable facts — which worktree, what is missing,
 * and the exact fix.
 */
export function formatAdvisoryWorktreeWarning(
  status: WorktreeHydrationStatus,
): string {
  // The parenthetical is the same claim doctor makes, and it is false for a
  // `generated-input` gap (home-base-qe6b.4): a missing tsconfig-named input
  // was measured to degrade type-aware lint to `any` while tsc stayed green.
  // The checks still run either way — only the claim about their worth differs.
  const caveat = status.problems.some(
    (problem) => problem.kind === 'generated-input',
  )
    ? 'running the checks anyway — but type-aware lint results may be wrong'
    : 'does not affect check results — running them anyway';
  return (
    [
      `${YELLOW}⚠${RESET} ${BOLD}partially unhydrated worktree${RESET} ${status.target}`,
      `  Missing: ${describeMissing(status)} ${DIM}(${caveat})${RESET}`,
      `  Fix:     ${YELLOW}${status.fixCommand}${RESET}`,
    ].join('\n') + '\n'
  );
}
