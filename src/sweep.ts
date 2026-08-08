/**
 * sweep.ts — `justin-sdk sweep`: the fleet propagation orchestrator
 * (home-base-j2n7, decisions of 2026-08-08).
 *
 * WHAT IT DOES, per enrolled repo: fresh worktree off the local default
 * branch → hydrate → `j update` (self-update the pin + re-apply components)
 * → prettier-normalize the SDK-written JSON → gate on the repo's own signal
 * + doctor → commit → merge --ff-only into the default branch → push →
 * clean up. Anything red: STOP that repo, leave the worktree standing for
 * inspection, keep going with the rest, and exit non-zero.
 *
 * THE RATCHET CONTRACT (Justin, verbatim-adjacent: "the more deterministic
 * we can make this, the better"): this script stays DUMB. It never grows
 * per-repo intelligence, retries beyond what is documented below, or
 * LLM-shaped judgment. When a repo goes red, the fix lands in the SDK (or
 * the repo) so the NEXT sweep is cleaner — failures improve the payload,
 * never the orchestrator.
 *
 * WHY LOCAL-FIRST (settled j2n7): at least one fleet remote lives in
 * Dropbox, not GitHub — cloud runners structurally cannot cover the fleet,
 * and the local machine already has gh auth + the Dropbox mount.
 *
 * MANIFEST = DISCOVERY: every direct child of --root (default ~/Dev) with a
 * justin-sdk.config.json. No hand-maintained repo list to go stale.
 *
 * MERGE SAFETY (the one subtle rule): a worktree branch cannot update a ref
 * that the primary checkout has checked out, and the primary may be dirty.
 * So the merge runs IN the primary, and only when (a) the primary is ON the
 * default branch and (b) none of the files the sweep changed are locally
 * dirty there. Otherwise the branch + worktree are left standing and
 * reported — green cases fully automatic, weird cases queue for a human.
 *
 * KNOWN RETRY (home-base-dl0q): the FIRST install in a fresh tree can exit
 * 127 (a github: dep's prepare runs a devDep bun never installed) while
 * leaving the tree usable — hydration is retried exactly once.
 */

import {execFileSync, spawnSync} from 'node:child_process';
import {existsSync, readdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename, join, resolve} from 'node:path';

import {getSdkVersion} from './setup-helpers';
import {detectPackageManager, setupEnv} from './setup-env';

export const SWEEP_BRANCH = 'worktree-sdk-sweep';
export const SWEEP_WORKTREE_SEGMENTS = [
  '.claude',
  'worktrees',
  'sdk-sweep',
] as const;

/** SDK-written files whose formatting rarely matches a repo's prettier config
 * (the t6a0.13 gotcha, reconfirmed on the j2n7 canary). */
const PRETTIER_NORMALIZE_FILES = [
  '.claude/settings.json',
  'justin-sdk.config.json',
  'package.json',
];

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';

export type RepoOutcome =
  | 'clean' // updated, gated green, merged, pushed
  | 'current' // nothing to do — already at the latest state
  | 'merge-pending' // green + committed, but the merge/push could not complete safely
  | 'failed' // a step went red; worktree left standing
  | 'skipped'; // preflight said don't touch this one

export interface RepoResult {
  repo: string;
  outcome: RepoOutcome;
  /** One line: what happened / why it stopped. */
  detail: string;
}

function say(line: string): void {
  console.log(line);
}

// ---------------------------------------------------------------------------
// git helpers — argv form only, never shell-interpolated
// ---------------------------------------------------------------------------

function git(repo: string, argv: string[]): string | null {
  try {
    return execFileSync('git', ['-C', repo, ...argv], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

function gitOk(repo: string, argv: string[]): boolean {
  return git(repo, argv) != null;
}

/** Run a command with output passed through (for update/signal/doctor). */
function run(
  argv: string[],
  cwd: string,
): {exitCode: number; error: string | null} {
  const [cmd, ...args] = argv;
  if (cmd == null) return {exitCode: 1, error: 'empty command'};
  const child = spawnSync(cmd, args, {cwd, env: process.env, stdio: 'inherit'});
  if (child.error) return {exitCode: 1, error: child.error.message};
  return {exitCode: child.status ?? 1, error: null};
}

// ---------------------------------------------------------------------------
// Discovery + preflight decisions (exported for tests)
// ---------------------------------------------------------------------------

/** Direct children of `root` carrying a justin-sdk.config.json. Sorted. */
export function discoverSweepRepos(root: string): string[] {
  if (!existsSync(root)) return [];
  const repos: string[] = [];
  for (const entry of readdirSync(root, {withFileTypes: true})) {
    if (!entry.isDirectory()) continue;
    const repo = join(root, entry.name);
    if (existsSync(join(repo, 'justin-sdk.config.json'))) repos.push(repo);
  }
  return repos.sort();
}

/**
 * The repo's default branch: origin/HEAD's target when set, else `main`,
 * else `master`, else null. Never guesses beyond that — a repo where none
 * resolve is a preflight skip, not a coin flip.
 */
export function defaultBranchOf(repo: string): string | null {
  const originHead = git(repo, [
    'symbolic-ref',
    '--quiet',
    'refs/remotes/origin/HEAD',
  ]);
  if (originHead != null && originHead !== '') {
    const name = originHead.replace(/^refs\/remotes\/origin\//, '');
    if (gitOk(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]))
      return name;
  }
  for (const name of ['main', 'master']) {
    if (gitOk(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]))
      return name;
  }
  return null;
}

/**
 * May the sweep's merge complete in the primary checkout? Only when the
 * primary is ON the default branch and none of `changedFiles` are dirty
 * there. Pure decision over inputs, so it is unit-testable.
 */
export function mergeSafety(
  primaryBranch: string | null,
  defaultBranch: string,
  dirtyFiles: readonly string[],
  changedFiles: readonly string[],
): {ok: boolean; reason: string} {
  if (primaryBranch !== defaultBranch) {
    return {
      ok: false,
      reason: `primary checkout is on ${primaryBranch ?? 'a detached HEAD'}, not ${defaultBranch}`,
    };
  }
  const dirty = new Set(dirtyFiles);
  const overlap = changedFiles.filter((file) => dirty.has(file));
  if (overlap.length > 0) {
    return {
      ok: false,
      reason: `sweep-changed file(s) locally dirty in the primary: ${overlap.join(', ')}`,
    };
  }
  return {ok: true, reason: ''};
}

/** Paths from `git status --porcelain`, both rename sides included. */
export function parsePorcelainPaths(porcelain: string): string[] {
  const paths: string[] = [];
  for (const raw of porcelain.split('\n')) {
    if (raw.length < 4) continue;
    const body = raw.slice(3);
    for (const side of body.split(' -> ')) {
      const trimmed = side.trim();
      if (trimmed !== '') paths.push(trimmed);
    }
  }
  return paths;
}

// ---------------------------------------------------------------------------
// The per-repo pipeline
// ---------------------------------------------------------------------------

interface SweepContext {
  dryRun: boolean;
}

function sweepOneRepo(repo: string, context: SweepContext): RepoResult {
  const name = basename(repo);
  const fail = (detail: string): RepoResult => ({
    detail,
    outcome: 'failed',
    repo: name,
  });

  say(`\n${BOLD}▸ ${name}${RESET} ${DIM}${repo}${RESET}`);

  // --- Preflight -----------------------------------------------------------
  if (!gitOk(repo, ['rev-parse', '--git-dir'])) {
    return {detail: 'not a git repository', outcome: 'skipped', repo: name};
  }
  const defaultBranch = defaultBranchOf(repo);
  if (defaultBranch == null) {
    return {
      detail: 'no default branch (origin/HEAD, main, master all unresolvable)',
      outcome: 'skipped',
      repo: name,
    };
  }
  const worktreePath = join(repo, ...SWEEP_WORKTREE_SEGMENTS);
  if (existsSync(worktreePath)) {
    return {
      detail: `stale sweep worktree exists at ${worktreePath} — resolve it (previous red run?), then re-sweep`,
      outcome: 'skipped',
      repo: name,
    };
  }
  if (
    gitOk(repo, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${SWEEP_BRANCH}`,
    ])
  ) {
    return {
      detail: `branch ${SWEEP_BRANCH} already exists — resolve it, then re-sweep`,
      outcome: 'skipped',
      repo: name,
    };
  }

  if (context.dryRun) {
    return {
      detail: `would sweep off ${defaultBranch}`,
      outcome: 'current',
      repo: name,
    };
  }

  // --- Worktree ------------------------------------------------------------
  const baseSha = git(repo, ['rev-parse', `refs/heads/${defaultBranch}`]);
  if (baseSha == null) return fail(`cannot resolve ${defaultBranch}`);
  const add = run(
    [
      'git',
      '-C',
      repo,
      'worktree',
      'add',
      '-b',
      SWEEP_BRANCH,
      worktreePath,
      baseSha,
    ],
    repo,
  );
  if (add.exitCode !== 0) return fail('git worktree add failed');

  const cleanupWorktree = (): void => {
    run(
      ['git', '-C', repo, 'worktree', 'remove', '--force', worktreePath],
      repo,
    );
    run(['git', '-C', repo, 'branch', '-D', SWEEP_BRANCH], repo);
  };

  // --- Hydrate (retry once — home-base-dl0q) -------------------------------
  let hydrated = setupEnv({target: worktreePath});
  if (hydrated.exitCode !== 0) {
    say(`  ${YELLOW}⚠${RESET} hydration failed once — retrying (dl0q class)`);
    hydrated = setupEnv({target: worktreePath});
  }
  if (hydrated.exitCode !== 0) {
    return fail('hydration failed twice — worktree left for inspection');
  }

  // --- Update --------------------------------------------------------------
  // The SWEEP pins the target, deterministically, to ITS OWN version — it IS
  // the latest SDK. Learned live on the first sweep run (raycast-j-recent,
  // pinned 0.6.1-era): delegating the bump to the TARGET's `j update`
  // self-update means trusting every ancient self-update code path in the
  // fleet, and 0.6.1's silently failed to move the pin at all. Pin first,
  // then run the NEW code with --no-self-update — no gh tag query, no old
  // code trusted, fleet version === orchestrator version by construction.
  // The pin is written with the repo's OWN package manager (third live-sweep
  // finding: raycast-j-recent is an npm repo — Raycast tooling — and `bun
  // add` there migrated package-lock.json and died in a resolver loop).
  // Mixing managers is exactly the class of nondeterminism this script
  // exists to avoid.
  const pin = `github:justinhaaheim/justin-sdk#v${getSdkVersion()}`;
  const {packageManager} = detectPackageManager(worktreePath);
  const PIN_ARGV: Record<string, string[]> = {
    bun: ['bun', 'add', '-d', pin],
    npm: ['npm', 'install', '--save-dev', pin],
    yarn: ['yarn', 'add', '--dev', pin],
  };
  const pinArgv = PIN_ARGV[packageManager ?? 'bun'];
  if (pinArgv == null) {
    return fail(`no pin recipe for package manager ${String(packageManager)}`);
  }
  const pinAdd = run(pinArgv, worktreePath);
  if (pinAdd.exitCode !== 0) {
    return fail(
      `${pinArgv.slice(0, 2).join(' ')} of ${pin} failed — worktree left for inspection`,
    );
  }
  // --allow-dirty because the tree IS dirty by design at this point: the
  // sweep's own pin bump is sitting uncommitted (fourth live-sweep finding —
  // update's dirty guard correctly refused). The sweep makes the one commit
  // itself after the gates.
  const update = run(
    [
      'bunx',
      '@justinhaaheim/justin-sdk',
      'update',
      '--no-self-update',
      '--allow-dirty',
      '--quiet',
    ],
    worktreePath,
  );
  if (update.exitCode !== 0) {
    return fail('j update failed — worktree left for inspection');
  }

  // Normalize SDK-written JSON to the repo's own prettier config.
  const present = PRETTIER_NORMALIZE_FILES.filter((file) =>
    existsSync(join(worktreePath, file)),
  );
  if (present.length > 0) {
    run(
      ['bunx', 'prettier', '--write', '--ignore-unknown', ...present],
      worktreePath,
    );
  }

  // --- Gates ---------------------------------------------------------------
  const doctor = run(
    ['bunx', '@justinhaaheim/justin-sdk', 'doctor', '--fix'],
    worktreePath,
  );
  if (doctor.exitCode !== 0) {
    return fail('doctor red after update — worktree left for inspection');
  }
  const signal = run(['bun', 'run', 'signal'], worktreePath);
  if (signal.exitCode !== 0) {
    return fail('signal red after update — worktree left for inspection');
  }

  // --- Commit --------------------------------------------------------------
  run(['git', '-C', worktreePath, 'add', '-A'], repo);
  const staged = git(worktreePath, ['diff', '--cached', '--name-only']);
  if (staged == null || staged === '') {
    cleanupWorktree();
    return {detail: 'already current', outcome: 'current', repo: name};
  }
  const commit = run(
    [
      'git',
      '-C',
      worktreePath,
      'commit',
      '-m',
      'chore: justin-sdk sweep — bump pin + re-apply components (automated, home-base-j2n7)',
    ],
    repo,
  );
  if (commit.exitCode !== 0) {
    return fail('commit failed — worktree left for inspection');
  }

  // --- Merge safety + merge -----------------------------------------------
  const changedFiles = staged.split('\n').filter((line) => line !== '');
  const primaryBranch = git(repo, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'HEAD',
  ]);
  const porcelain = git(repo, ['status', '--porcelain']) ?? '';
  const safety = mergeSafety(
    primaryBranch,
    defaultBranch,
    parsePorcelainPaths(porcelain),
    changedFiles,
  );
  if (!safety.ok) {
    return {
      detail: `green + committed on ${SWEEP_BRANCH}, but merge deferred: ${safety.reason}`,
      outcome: 'merge-pending',
      repo: name,
    };
  }
  const merge = run(
    ['git', '-C', repo, 'merge', '--ff-only', SWEEP_BRANCH],
    repo,
  );
  if (merge.exitCode !== 0) {
    return {
      detail: `merge --ff-only failed (diverged?) — branch ${SWEEP_BRANCH} left standing`,
      outcome: 'merge-pending',
      repo: name,
    };
  }

  // --- Push + cleanup ------------------------------------------------------
  let pushNote = 'no remote';
  const remotes = git(repo, ['remote']);
  if (remotes != null && remotes !== '') {
    const push = run(['git', '-C', repo, 'push'], repo);
    pushNote =
      push.exitCode === 0
        ? 'pushed'
        : 'PUSH FAILED (remote ahead?) — merged locally, push by hand';
  }
  cleanupWorktree();
  return {
    detail: `updated, merged into ${defaultBranch}, ${pushNote}`,
    outcome: 'clean',
    repo: name,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SweepOptions {
  dryRun?: boolean;
  /** Explicit repo paths — overrides discovery entirely when non-empty. */
  repos?: string[];
  /** Discovery root. Default ~/Dev. */
  root?: string;
}

export function runSweep(options: SweepOptions = {}): number {
  const root = resolve(options.root ?? join(homedir(), 'Dev'));
  const explicit = (options.repos ?? []).map((repoPath) => resolve(repoPath));
  const repos = explicit.length > 0 ? explicit : discoverSweepRepos(root);
  const dryRun = options.dryRun === true;

  say(
    `${BOLD}justin-sdk sweep${RESET} — ${repos.length} repo(s)` +
      `${explicit.length > 0 ? ' (explicit)' : ` discovered under ${root}`}` +
      `${dryRun ? ` ${DIM}(dry-run)${RESET}` : ''}`,
  );

  const results: RepoResult[] = [];
  for (const repo of repos) {
    results.push(sweepOneRepo(repo, {dryRun}));
  }

  say(`\n${BOLD}Summary${RESET}`);
  const ICON: Record<RepoOutcome, string> = {
    clean: `${GREEN}✓${RESET}`,
    current: `${GREEN}=${RESET}`,
    failed: `${RED}✗${RESET}`,
    'merge-pending': `${YELLOW}⏸${RESET}`,
    skipped: `${DIM}⊘${RESET}`,
  };
  for (const result of results) {
    say(
      `  ${ICON[result.outcome]} ${result.repo} ${DIM}${result.detail}${RESET}`,
    );
  }
  const failed = results.filter((result) => result.outcome === 'failed').length;
  const pending = results.filter(
    (result) => result.outcome === 'merge-pending',
  ).length;
  if (failed + pending > 0) {
    say(
      `\n${YELLOW}${failed} failed, ${pending} merge-pending — each left its worktree/branch standing for inspection. Fix the CAUSE in the SDK (ratchet contract), then re-sweep.${RESET}`,
    );
  }
  return failed > 0 ? 1 : 0;
}
