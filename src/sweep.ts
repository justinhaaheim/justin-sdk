/**
 * sweep.ts — `justin-sdk sweep`: the fleet propagation orchestrator
 * (home-base-j2n7, decisions of 2026-08-08).
 *
 * WHAT IT DOES, per enrolled repo: fresh worktree off the local default
 * branch → hydrate → measure the BASELINE doctor/signal → `justin-sdk update`
 * (self-update the pin + re-apply components) → prettier-normalize the
 * SDK-written JSON → gate on the repo's own signal + doctor AS A RATCHET
 * (regression, not absolute health) → commit → merge --ff-only into the
 * default branch → push → clean up. Anything red: STOP that repo, remove its
 * worktree, write the failing step + output tail to the run log, keep going
 * with the rest, and exit non-zero.
 *
 * THE RATCHET GATE (home-base-ckc4 F3) — the gate measures REGRESSION, not
 * health. Measured 2026-09-04: five of six sweep failures were repos that were
 * never green to begin with (pre-existing red on main, or a fresh worktree
 * missing gitignored generated files), so an absolute-health gate reports
 * "the payload broke it" about trees the payload never touched. So each gate is
 * run twice — once on the hydrated tree before the payload, once after — and
 * only green→red fails. red→red proceeds with a loud per-repo note that says
 * the gate was BLIND there. Exit codes only: `signal` is repo-defined, so its
 * output is not a uniform interface. Stated limitation: a baseline-red repo
 * gets no payload-breakage protection at all.
 *
 * FAILURE IS NOT INSPECTABLE IN PLACE ANY MORE (ckc4 F2). Leaving the worktree
 * standing sounded helpful and was not: the name is fixed, so one red repo
 * blocked every later sweep of it (seven such leftovers accumulated by
 * 2026-09-04). Every failure now removes the worktree AND the branch, and the
 * evidence goes to a durable per-run log instead — failing step, exit code, and
 * the last 60 lines of its stdout+stderr. The two deliberate `merge-pending`
 * returns are the only paths that keep a worktree, and they say so.
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
 *
 * PAYLOAD SCOPE — `--component <name>` (home-base-4qsc, t6a0.21 D2a/D11):
 * the default payload is "bump the pin + re-apply every component". A rules
 * edit needs neither of those fleet-wide, so `--component X` narrows the
 * payload to that ONE component and makes the run PIN-NEUTRAL: no `bun add`
 * of the pin, no `update` subprocess, and the pin-bearing fields of
 * package.json / justin-sdk.config.json come out byte-identical. This is a
 * payload SCOPE filter, not per-repo intelligence — the ratchet contract
 * (this orchestrator stays dumb) is untouched. D11: the component runs
 * IN-PROCESS, i.e. the orchestrator's own code, precisely so a rules sweep
 * does not depend on the SDK version each repo happens to be pinned to.
 *
 * THE PIN WRITE (home-base-apus.1): remove-then-add, via the repo's OWN package
 * manager, across BOTH dependency sections — never `add` over the top. Adding
 * over an existing github spec is broken in two different directions at once
 * (`bun add -d` errors `DependencyLoop`; `bun add -d` / `yarn add --dev` over a
 * `dependencies` declaration return 0 and leave the manifest wrong), and the
 * post-condition is checked against the manifest rather than the exit code.
 * A repo whose SDK comes from a WORKSPACE MEMBER (home-base) gets no pin
 * written at all, with its own reported outcome — D21.
 *
 * ONE COMMAND, BOTH SURFACES (t6a0.21 D17): a `--component critical-rules` run
 * also refreshes THIS machine's user-level rules file at the end, because that
 * file is still the only channel serving the repos that are not enrolled. It is
 * a payload/summary addition with its own outcome line — not per-repo
 * intelligence, and the ratchet contract still holds.
 */

import {execFileSync, spawnSync} from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import {homedir} from 'node:os';
import {basename, join, relative, resolve} from 'node:path';

import {
  COMPONENT_NAMES,
  configNameFor,
  runComponentByName,
  type ComponentName,
} from './components';
import {
  readDeployedStamp,
  rulesFilePath,
  SYNC_RULES_CMD,
} from './plugin/lib/rules-file';
import {getSdkVersion, isQuiet, setQuiet, writeJson} from './setup-helpers';
import {detectPackageManager, setupEnv} from './setup-env';
import {runSyncRules} from './sync-rules';

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
  | 'failed' // a step went red; worktree removed, evidence in the run log
  | 'blocked' // COULD NOT sweep — preflight refused (ckc4 F4). Fails the run.
  | 'skipped'; // out of scope for this payload (not enrolled). Expected, not a failure.

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

/**
 * `git`, WITHOUT the trim — for `status --porcelain`, whose leading two-column
 * status field is load-bearing.
 *
 * MEASURED BUG this exists to fix (found by the ckc4 merge-pending test, and
 * pre-existing since the porcelain parser was written): `git()` trims, so the
 * leading space of a ` M path` first line disappeared, `parsePorcelainPaths`
 * sliced 3 characters off `M path` and returned `ath`. The dirty file was
 * therefore invisible to mergeSafety's overlap check, which then said "no
 * sweep-changed file is dirty in the primary" and let the merge run — the
 * conflation that degrades TOWARD the reassuring answer. git aborted the merge
 * itself, so nothing was lost; the sweep just reported the wrong reason.
 */
function gitPorcelain(repo: string): string | null {
  try {
    return execFileSync('git', ['-C', repo, 'status', '--porcelain'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}

/**
 * Run a command, CAPTURING its output and echoing it afterwards
 * (for update/signal/doctor).
 *
 * WHY CAPTURE RATHER THAN `stdio: 'inherit'` (ckc4 F2): a failure now removes
 * its worktree, so the output IS the evidence — it has to reach the run log,
 * and an inherited stream is unreadable to this process. The trade-off, stated
 * rather than hidden: output appears per STEP (when the child exits) instead of
 * live, so the `$ <command>` line printed before each step is what tells an
 * operator which long-running thing is currently running. stdout and stderr are
 * concatenated in that order, so their relative interleaving is lost.
 *
 * stdin is `ignore`, matching setup-env's runChild: a fleet tool must never
 * block on a child that decided to prompt.
 */
function run(
  argv: string[],
  cwd: string,
): {exitCode: number; error: string | null; output: string} {
  const [cmd, ...args] = argv;
  if (cmd == null) return {error: 'empty command', exitCode: 1, output: ''};
  say(`  ${DIM}$ ${argv.join(' ')}${RESET}`);
  const child = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf-8',
    env: process.env,
    // A full `bun install` + signal run can be large; the Node default (1MB)
    // would truncate exactly the tail the log needs.
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = `${child.stdout ?? ''}${child.stderr ?? ''}`;
  const trimmed = output.replace(/\n+$/, '');
  if (trimmed !== '') say(trimmed);
  if (child.error) return {error: child.error.message, exitCode: 1, output};
  return {error: null, exitCode: child.status ?? 1, output};
}

// ---------------------------------------------------------------------------
// The run log — where a failure's evidence goes now that the worktree is
// removed (home-base-ckc4 F2)
// ---------------------------------------------------------------------------

/** How many lines of a failed step's output reach the log and the screen. */
export const FAILURE_TAIL_LINES = 60;

/** The last `limit` lines of `text`, trailing blank lines dropped. Pure. */
export function tailLines(text: string, limit = FAILURE_TAIL_LINES): string {
  const lines = text.replace(/\n+$/, '').split('\n');
  return lines.slice(Math.max(0, lines.length - limit)).join('\n');
}

/**
 * One log file per run, under home-base's gitignored `tmp/`. Not the SDK's own
 * directory and not the swept repos': the sweep is run from home-base, the file
 * has to survive the worktree it describes, and `tmp/` is the documented home
 * for disposable output.
 */
export const SWEEP_LOG_DIR = join(
  homedir(),
  'Dev',
  'home-base',
  'tmp',
  'sdk-sweep',
);

export interface SweepRunLog {
  /** Where the failures WOULD be written — printed at the top of every run. */
  readonly path: string;
  /** Has anything actually been written? (An empty run writes no file.) */
  wrote: () => boolean;
  record: (entry: {
    repo: string;
    step: string;
    detail: string;
    /** null = this step reports steps rather than raw command output. */
    output: string | null;
  }) => void;
}

/**
 * Lazily-created: the path is decided (and printed) up front, but nothing is
 * written until something fails, so a clean run leaves no litter behind.
 *
 * A log-write failure is REPORTED and never swallowed — but it also never
 * changes a repo's verdict. Losing the evidence of a failure is bad; turning a
 * green repo red because a directory was unwritable would be worse.
 */
export function createRunLog(
  dir: string = SWEEP_LOG_DIR,
  now: Date = new Date(),
): SweepRunLog {
  // Colons are legal on macOS but hostile in shell arguments and Finder.
  const stamp = now.toISOString().replace(/:/g, '-');
  const path = join(dir, `${stamp}.log`);
  let written = false;
  return {
    path,
    record: ({detail, output, repo, step}) => {
      const body = [
        '',
        '─'.repeat(72),
        `${repo} · step: ${step}`,
        detail,
        output == null
          ? '(this step reports steps, not raw command output — see the detail above)'
          : `--- last ${FAILURE_TAIL_LINES} lines of stdout+stderr ---\n${tailLines(output)}`,
        '',
      ].join('\n');
      try {
        mkdirSync(dir, {recursive: true});
        appendFileSync(
          path,
          written
            ? body
            : `justin-sdk sweep — failure log for the run started ${now.toISOString()}\n${body}`,
        );
        written = true;
      } catch (error) {
        say(
          `  ${RED}✗${RESET} could not write the failure log at ${path}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    wrote: () => written,
  };
}

// ---------------------------------------------------------------------------
// Worktree plumbing — creation, recovery, removal (home-base-ckc4 F1/F2/F5)
// ---------------------------------------------------------------------------

/**
 * Neutralize the repo's hooks for ONE git invocation (ckc4 F1).
 *
 * MEASURED, on ynab-mcp-deluxe and reproduced in a fixture: `git worktree add`
 * runs the repo's `post-checkout` hook in the new tree and PROPAGATES its exit
 * code, while keeping the worktree it just created and registered. husky's hook
 * shells out to mise, mise refuses a mise.toml at an untrusted path, and the
 * sweep read the resulting exit 1 as "worktree add failed" — then left the
 * successfully-created worktree standing, which blocked every later sweep of
 * that repo.
 *
 * Disabling hooks is the right call on its own terms, not just as a workaround:
 * the hook's job (submodules, install, version stamps) is exactly what the
 * hydration step immediately does deliberately, so running it here is at best a
 * duplicate and at worst — as here — a foreign failure attributed to the sweep.
 *
 * `-c` is per-invocation: verified that the created worktree still resolves the
 * repo's real `core.hooksPath` afterwards.
 */
const HOOKS_OFF = ['-c', 'core.hooksPath=/dev/null'] as const;

/** The `worktree <path>` lines of `git worktree list --porcelain`. Pure. */
export function parseWorktreePaths(porcelain: string): string[] {
  const paths: string[] = [];
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) paths.push(line.slice('worktree '.length));
  }
  return paths;
}

/**
 * Is `path` registered as a worktree of `repo`? Registration is what blocks a
 * later `worktree add`, and it outlives the DIRECTORY — a hand-deleted worktree
 * is still registered (git calls it prunable) — so this is asked separately
 * from `existsSync`.
 */
export function isWorktreeRegistered(repo: string, path: string): boolean {
  const porcelain = git(repo, ['worktree', 'list', '--porcelain']);
  if (porcelain == null) return false;
  const wanted = resolve(path);
  return parseWorktreePaths(porcelain).some(
    (entry) => resolve(entry) === wanted,
  );
}

export interface CleanupResult {
  ok: boolean;
  /** What was removed, or exactly what survived. Never "probably gone". */
  detail: string;
}

/**
 * Remove the sweep's worktree AND its branch, and VERIFY both are gone.
 *
 * The single removal path for all four callers — a failed `worktree add`, any
 * red step, a preflight leftover, and the green finish — so "cleaned up" means
 * the same thing everywhere.
 *
 * Verified rather than assumed (rule 6): `worktree remove` can fail, and a
 * cleanup that reports success while leaving a registered worktree behind
 * recreates the exact bug this fixes. `prune` covers the case where the
 * directory is already gone but the registration is not.
 */
export function cleanupWorktreeAndBranch(
  repo: string,
  worktreePath: string,
  branch: string,
): CleanupResult {
  if (existsSync(worktreePath) || isWorktreeRegistered(repo, worktreePath)) {
    run(['git', '-C', repo, 'worktree', 'remove', '--force', worktreePath], repo);
    run(['git', '-C', repo, 'worktree', 'prune'], repo);
  }
  const branchRef = `refs/heads/${branch}`;
  if (gitOk(repo, ['rev-parse', '--verify', '--quiet', branchRef])) {
    run(['git', '-C', repo, 'branch', '-D', branch], repo);
  }

  const survivors: string[] = [];
  if (existsSync(worktreePath)) survivors.push(`directory ${worktreePath}`);
  if (isWorktreeRegistered(repo, worktreePath)) {
    survivors.push(`worktree registration for ${worktreePath}`);
  }
  if (gitOk(repo, ['rev-parse', '--verify', '--quiet', branchRef])) {
    survivors.push(`branch ${branch}`);
  }
  return survivors.length === 0
    ? {detail: `removed worktree ${worktreePath} and branch ${branch}`, ok: true}
    : {
        detail: `cleanup INCOMPLETE — still present: ${survivors.join('; ')}`,
        ok: false,
      };
}

export interface WorktreeAddResult {
  ok: boolean;
  detail: string;
  /** The add's own output, for the run log. */
  output: string;
}

/**
 * Create the sweep worktree with the repo's hooks disabled (ckc4 F1), and never
 * trust the exit code alone about what exists afterwards.
 *
 * A non-zero add that nonetheless registered the worktree is the exact shape of
 * the ynab-mcp-deluxe bug, so the failure path re-checks and cleans up. With
 * `HOOKS_OFF` that shape should now be unreachable — it is kept because "the
 * add failed" and "nothing was created" are different facts, and assuming the
 * second from the first is what stranded seven worktrees.
 */
export function addSweepWorktree(
  repo: string,
  worktreePath: string,
  branch: string,
  baseSha: string,
): WorktreeAddResult {
  const add = run(
    [
      'git',
      '-C',
      repo,
      ...HOOKS_OFF,
      'worktree',
      'add',
      '-b',
      branch,
      worktreePath,
      baseSha,
    ],
    repo,
  );
  if (add.exitCode === 0) {
    return {detail: `worktree added at ${worktreePath}`, ok: true, output: add.output};
  }
  const salvage = cleanupWorktreeAndBranch(repo, worktreePath, branch);
  return {
    detail:
      `git worktree add failed (exit ${add.exitCode}) — ${
        salvage.ok
          ? 'nothing left behind'
          : `and ${salvage.detail.toLowerCase()}`
      }`,
    ok: false,
    output: add.output,
  };
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

// ---------------------------------------------------------------------------
// Payload scope — `--component <name>` (home-base-4qsc)
// ---------------------------------------------------------------------------

/**
 * What the sweep applies inside each repo's worktree.
 *   full      — the historical payload: bump the pin, then `update` re-applies
 *               every registered component.
 * component   — ONE component, run in-process, pin left exactly as found.
 */
export type SweepPayload =
  | {mode: 'full'}
  | {mode: 'component'; component: ComponentName};

/** Absent `--component` means the historical full payload. Pure. */
export function planSweepPayload(
  component: ComponentName | null,
): SweepPayload {
  return component == null ? {mode: 'full'} : {component, mode: 'component'};
}

/**
 * Validate `--component`. Accepts either the short name (`gitignore`) or the
 * `-setup` config name (`gitignore-setup`) and normalizes to the short one.
 * An unknown name is an ERROR, never a silently-full sweep: a typo that fell
 * through to the default payload would ship an SDK bump to the whole fleet.
 */
export function parseComponentOption(
  raw: string | undefined,
): {ok: true; component: ComponentName | null} | {ok: false; error: string} {
  if (raw == null) return {component: null, ok: true};
  const wanted = raw.trim();
  for (const name of COMPONENT_NAMES) {
    if (wanted === name || wanted === configNameFor(name)) {
      return {component: name, ok: true};
    }
  }
  return {
    error:
      `unknown component "${raw}" — nothing was swept. Known components: ` +
      `${COMPONENT_NAMES.join(', ')}`,
    ok: false,
  };
}

/** The one commit a swept repo gets. Names the component when scoped. */
export function sweepCommitMessage(payload: SweepPayload): string {
  if (payload.mode === 'component') {
    return (
      `chore(sdk): sweep ${payload.component} — re-apply that component only, ` +
      'SDK pin unchanged (automated, home-base-4qsc)'
    );
  }
  return 'chore: justin-sdk sweep — bump pin + re-apply components (automated, home-base-j2n7)';
}

/**
 * DEFENCE IN DEPTH for home-base-o33r (fix shape 4).
 *
 * A full-mode sweep bumps the SDK pin and re-applies components. It has no
 * business rewriting any repo's beads `config.yaml` — that file carries the
 * repo's `issue_prefix`, i.e. the namespace of every issue id it has ever
 * minted. When the payload nonetheless produces a change there, the run stops
 * for that repo BEFORE the commit, leaving the worktree standing for
 * inspection; it is never committed, never merged, never pushed.
 *
 * Scoped to full mode on purpose: a `--component beads` sweep is an operator
 * deliberately re-applying that component, and stopping it would be stopping the
 * very thing that was asked for.
 *
 * Pure.
 */
export function beadsConfigGuard(
  payload: SweepPayload,
  changedFiles: readonly string[],
): {ok: true} | {ok: false; offenders: string[]; reason: string} {
  if (payload.mode !== 'full') return {ok: true};
  const offenders = changedFiles.filter(
    (file) =>
      file === '.beads/config.yaml' || file.endsWith('/.beads/config.yaml'),
  );
  if (offenders.length === 0) return {ok: true};
  return {
    ok: false,
    offenders,
    reason:
      `HARD STOP (home-base-o33r): the payload changed ${offenders.join(', ')}. ` +
      'A full sweep must never rewrite a beads config — it carries the issue ' +
      'prefix. Nothing was committed; worktree left for inspection.',
  };
}

/**
 * The paths one component owns — everything a `--component X` sweep is allowed
 * to COMMIT (home-base-926v). An entry ending in `/` is a directory prefix.
 *
 * `null` means the component's contract has not been pinned down, and the commit
 * keeps its historical `git add -A` shape. That default is deliberate and it is
 * the SAFE direction: a contract list that is too NARROW would silently drop a
 * change the component really made and then report "already current" — the
 * total-omission failure this whole epic exists to kill. So a component earns a
 * list only once someone has actually enumerated what it writes.
 */
export function componentContractPaths(
  component: ComponentName,
): readonly string[] | null {
  switch (component) {
    case 'critical-rules':
      // The generated artifact, the module selection that produced it, and the
      // claudeMdExcludes entry enrollment writes (t6a0.21 D12, anhw half A).
      return [
        '.claude/rules/justin-sdk/',
        '.claude/settings.json',
        'justin-sdk.config.json',
      ];
    default:
      return null;
  }
}

/**
 * Split a component sweep's staged files into the ones that component owns and
 * the ones it does not (home-base-926v).
 *
 * WHY THIS EXISTS. The sweep gates each worktree with `bunx … doctor --fix`, and
 * that resolves the TARGET repo's pinned SDK — not the one running the sweep. On
 * a repo still enrolled in components t6a0 retired, that fixer re-applies the
 * scaffolding the migration removed (observed 2026-08-19 in the `life` and
 * `userscripts-j` worktrees: `CLAUDE.md`, `scripts/setup-env.ts`, a setup-env
 * SessionStart hook). `git add -A` would then commit all of it under a message
 * that says "re-apply that component only". Nothing was damaged that run only
 * because those two repos' gates were red for unrelated reasons.
 *
 * `holdPinAfterGates` already establishes the principle — gate-time writes must
 * not leak into the commit — and holds the pin fields. This is the same rule for
 * whole files.
 *
 * NOT SILENT: the caller reports every out-of-scope path in the run output AND in
 * the repo's summary line. A path-limit nobody can see would hide the fact that
 * doctor is rewriting files, which is a real problem worth knowing about.
 *
 * RESIDUAL, stated rather than papered over: this is path granularity, so a
 * doctor edit INSIDE a contract file (the same `.claude/settings.json` that
 * carries the exclude) still rides along. Fixing that needs a content-level
 * snapshot across the gates, which is a bigger change than this bug warrants.
 *
 * Pure.
 */
export function partitionByComponentContract(
  payload: SweepPayload,
  changedFiles: readonly string[],
): {inScope: string[]; outOfScope: string[]} {
  if (payload.mode !== 'component') {
    return {inScope: [...changedFiles], outOfScope: []};
  }
  const contract = componentContractPaths(payload.component);
  if (contract == null) return {inScope: [...changedFiles], outOfScope: []};
  const owned = (file: string): boolean => matchesContract(contract, file);
  return {
    inScope: changedFiles.filter(owned),
    outOfScope: changedFiles.filter((file) => !owned(file)),
  };
}

/**
 * Does `file` fall inside `contract`? An entry ending in `/` is a directory
 * prefix, anything else is an exact path.
 *
 * Shared by the commit's scope filter and the preflight leftover check (ckc4
 * F5) on purpose: "paths this component owns" must mean the same thing when
 * deciding what may be committed and when deciding what may be deleted.
 * Pure.
 */
export function matchesContract(
  contract: readonly string[],
  file: string,
): boolean {
  return contract.some((entry) =>
    entry.endsWith('/') ? file.startsWith(entry) : file === entry,
  );
}

// ---------------------------------------------------------------------------
// Preflight: leftovers from an earlier run (home-base-ckc4 F5)
// ---------------------------------------------------------------------------

/**
 * Uncommitted paths a leftover worktree may carry and still be provably empty.
 *
 * In component mode that is the component's own contract — the sweep
 * REGENERATES exactly those files, so a modified one carries no information
 * that the next run will not reproduce. Anything else (including every full
 * sweep, whose payload has no enumerated contract) allows nothing: only a
 * pristine worktree is provably empty. Pure.
 */
export function allowedLeftoverPaths(payload: SweepPayload): readonly string[] {
  if (payload.mode !== 'component') return [];
  return componentContractPaths(payload.component) ?? [];
}

export type LeftoverAssessment =
  | {present: false}
  | {present: true; safe: boolean; reason: string};

/**
 * May the sweep delete the leftover worktree/branch it found, or must it refuse
 * to sweep this repo? (ckc4 F5.)
 *
 * WHY AUTO-CLEAN AT ALL: the worktree name is FIXED, so one leftover blocks
 * every future sweep of that repo permanently, and the seven that had
 * accumulated by 2026-09-04 all held nothing — zero commits, and at most a
 * regenerable rules file. "Resolve it by hand, then re-sweep" is a chore that
 * nobody does, which is how a propagation tool silently stops propagating.
 *
 * SAFE means PROVABLY EMPTY, and every leg is measured:
 *   - no commits beyond the default branch, on the branch AND in the worktree;
 *   - uncommitted changes confined to paths this payload regenerates;
 *   - the directory, if present, is really a registered worktree of this repo.
 * Anything unmeasurable — an unreadable status, an uncountable rev-list — is
 * UNSAFE, never "nothing found" (rule 6): the reassuring direction here deletes
 * someone's work.
 */
export function assessSweepLeftover(
  repo: string,
  worktreePath: string,
  branch: string,
  defaultBranch: string,
  allowedPaths: readonly string[],
): LeftoverAssessment {
  const directory = existsSync(worktreePath);
  const registered = isWorktreeRegistered(repo, worktreePath);
  const branchRef = `refs/heads/${branch}`;
  const branchExists = gitOk(repo, [
    'rev-parse',
    '--verify',
    '--quiet',
    branchRef,
  ]);
  if (!directory && !registered && !branchExists) return {present: false};

  const found = [
    directory ? 'worktree directory' : null,
    registered && !directory ? 'worktree registration (directory already gone)' : null,
    branchExists ? `branch ${branch}` : null,
  ]
    .filter((entry): entry is string => entry != null)
    .join(' + ');

  if (directory && !registered) {
    return {
      present: true,
      reason: `${found}: a directory sits at ${worktreePath} that git does not know as a worktree of this repo — not the sweep's to delete`,
      safe: false,
    };
  }

  const commitsBeyond = (from: string, ref: string): number | null => {
    const out = git(from, ['rev-list', '--count', `${defaultBranch}..${ref}`]);
    if (out == null) return null;
    const count = Number(out.trim());
    // Number('') is 0 — the empty-string-reads-as-zero conflation.
    return out.trim() === '' || !Number.isInteger(count) ? null : count;
  };

  if (branchExists) {
    const ahead = commitsBeyond(repo, branch);
    if (ahead == null) {
      return {
        present: true,
        reason: `${found}: could not count ${branch}'s commits beyond ${defaultBranch} — refusing to delete what cannot be measured`,
        safe: false,
      };
    }
    if (ahead > 0) {
      return {
        present: true,
        reason: `${found}: ${branch} has ${ahead} commit(s) beyond ${defaultBranch} — real work, kept`,
        safe: false,
      };
    }
  }

  if (directory) {
    const ahead = commitsBeyond(worktreePath, 'HEAD');
    if (ahead == null) {
      return {
        present: true,
        reason: `${found}: could not count the worktree's commits beyond ${defaultBranch} — refusing to delete what cannot be measured`,
        safe: false,
      };
    }
    if (ahead > 0) {
      return {
        present: true,
        reason: `${found}: the worktree's HEAD is ${ahead} commit(s) beyond ${defaultBranch} — real work, kept`,
        safe: false,
      };
    }
    const porcelain = gitPorcelain(worktreePath);
    if (porcelain == null) {
      return {
        present: true,
        reason: `${found}: could not read the worktree's git status — refusing to delete what cannot be measured`,
        safe: false,
      };
    }
    const offenders = parsePorcelainPaths(porcelain).filter(
      (file) => !matchesContract(allowedPaths, file),
    );
    if (offenders.length > 0) {
      return {
        present: true,
        reason: `${found}: uncommitted change(s) outside what this run regenerates: ${offenders.join(', ')} — kept`,
        safe: false,
      };
    }
  }

  return {
    present: true,
    reason:
      `${found}: 0 commits beyond ${defaultBranch}` +
      (directory
        ? `, and no uncommitted changes outside ${allowedPaths.length === 0 ? 'nothing (a full sweep regenerates no enumerated paths)' : allowedPaths.join(', ')}`
        : ''),
    safe: true,
  };
}

/**
 * Stage the worktree for the sweep's one commit, honouring the component
 * contract (home-base-926v).
 *
 * `git add -A` first, then UNSTAGE anything the component does not own, then
 * re-read the index — the returned list is what git actually holds, not what
 * the partition predicted, so a reset that silently failed cannot be reported
 * as a scoped commit.
 *
 * Un-staged, never reverted: the file keeps its new content in the worktree, so
 * an operator inspecting a red run still sees exactly what `doctor --fix` did.
 * On a green run the worktree is removed and the change dies with it — which is
 * what already happens today, just without the commit.
 */
export function stageForCommit(
  worktreePath: string,
  payload: SweepPayload,
): {staged: string[]; excluded: string[]} {
  const readStaged = (): string[] => {
    const out = git(worktreePath, ['diff', '--cached', '--name-only']);
    return out == null ? [] : out.split('\n').filter((line) => line !== '');
  };

  git(worktreePath, ['add', '-A']);
  const scope = partitionByComponentContract(payload, readStaged());
  if (scope.outOfScope.length === 0) return {excluded: [], staged: scope.inScope};

  git(worktreePath, ['reset', '-q', '--', ...scope.outOfScope]);
  return {excluded: scope.outOfScope, staged: readStaged()};
}

/** Is `component` registered in a repo's justin-sdk.config.json list? Pure. */
export function isEnrolledIn(
  components: readonly string[],
  component: ComponentName,
): boolean {
  return components.includes(configNameFor(component));
}

/**
 * Components declared by a justin-sdk.config.json's raw text. `ok: false` for
 * unparseable content — an empty list means "read it, it declares none", and
 * conflating the two would let a corrupt config read as "not enrolled".
 */
export function parseConfigComponents(
  json: string,
): {ok: true; components: string[]} | {ok: false; reason: string} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {ok: false, reason: 'justin-sdk.config.json is not valid JSON'};
  }
  if (typeof parsed !== 'object' || parsed == null) {
    return {ok: false, reason: 'justin-sdk.config.json is not a JSON object'};
  }
  const raw = (parsed as {components?: unknown}).components;
  if (raw == null) return {components: [], ok: true};
  if (!Array.isArray(raw) || raw.some((e) => typeof e !== 'string')) {
    return {
      ok: false,
      reason: 'justin-sdk.config.json components is not a string array',
    };
  }
  return {components: raw as string[], ok: true};
}

/**
 * The components declared by the config AS COMMITTED ON `branch` — read with
 * `git show`, not off the working tree, because the sweep branches from that
 * exact commit. Reading the primary's working copy could disagree (dirty
 * checkout, different branch) and decide enrollment from a tree that is not
 * the one being swept.
 */
export function committedConfigComponents(
  repo: string,
  branch: string,
): {ok: true; components: string[]} | {ok: false; reason: string} {
  const shown = git(repo, [
    'show',
    `refs/heads/${branch}:justin-sdk.config.json`,
  ]);
  if (shown == null) {
    return {
      ok: false,
      reason: `justin-sdk.config.json is not committed on ${branch}`,
    };
  }
  return parseConfigComponents(shown);
}

// ---------------------------------------------------------------------------
// Pin neutrality (the semantic contract of --component, t6a0.21 D2a)
// ---------------------------------------------------------------------------

const SDK_PKG = '@justinhaaheim/justin-sdk';

/**
 * Every field that records "which SDK version this repo is on". A
 * component-scoped sweep must leave all of them exactly as found.
 *
 * WHY THIS EXISTS AT ALL (measured, not assumed): skipping the pin step and
 * the `update` subprocess is NOT sufficient. Every component installer chains
 * `runBaseSetup`, whose stepJustinSdkConfig rewrites `version` to the RUNNING
 * SDK's version and `lastSynced` to today, and whose stepDepsHasSdk adds the
 * pin to package.json when absent. Run in-process from the orchestrator, that
 * would stamp the orchestrator's version into a repo whose package.json still
 * pins an older one — a config that LIES about the installed SDK. So the
 * component-mode payload snapshots these fields and puts them back.
 */
interface PinField {
  file: string;
  /** Containing object path; [] = top level. */
  parents: readonly string[];
  key: string;
}

const PIN_FIELDS: readonly PinField[] = [
  {file: 'package.json', key: SDK_PKG, parents: ['dependencies']},
  {file: 'package.json', key: SDK_PKG, parents: ['devDependencies']},
  {file: 'justin-sdk.config.json', key: 'version', parents: []},
  {file: 'justin-sdk.config.json', key: 'lastSynced', parents: []},
];

interface PinFieldValue {
  /** Did the field itself exist? */
  present: boolean;
  /** Did its containing object exist? (Absent parent must not be left as {}.) */
  parentPresent: boolean;
  value: unknown;
}

/** A snapshot of the pin-bearing fields. Keys are `<file>:<parents>.<key>`. */
export type PinSnapshot = ReadonlyMap<string, PinFieldValue>;

function pinFieldId(field: PinField): string {
  return `${field.file}:${[...field.parents, field.key].join('.')}`;
}

function objectAt(
  root: Record<string, unknown>,
  parents: readonly string[],
): Record<string, unknown> | null {
  let cursor: Record<string, unknown> = root;
  for (const parent of parents) {
    const next = cursor[parent];
    if (typeof next !== 'object' || next == null || Array.isArray(next)) {
      return null;
    }
    cursor = next as Record<string, unknown>;
  }
  return cursor;
}

function readJsonObject(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (typeof parsed !== 'object' || parsed == null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Snapshot the pin-bearing fields of a project root. */
export function readPinSnapshot(root: string): PinSnapshot {
  const snapshot = new Map<string, PinFieldValue>();
  for (const field of PIN_FIELDS) {
    const parsed = readJsonObject(join(root, field.file));
    const container = parsed == null ? null : objectAt(parsed, field.parents);
    snapshot.set(pinFieldId(field), {
      parentPresent: container != null,
      present: container != null && field.key in container,
      value: container == null ? undefined : container[field.key],
    });
  }
  return snapshot;
}

/**
 * Put every drifted pin field back to its snapshot value. Returns the ids of
 * the fields it had to restore — a non-empty list is expected in component
 * mode (base-setup always stamps version/lastSynced) and is worth printing,
 * because it is the visible evidence the neutrality guard did its job.
 */
export function restorePinSnapshot(
  root: string,
  before: PinSnapshot,
): string[] {
  const restored: string[] = [];
  const byFile = new Map<string, PinField[]>();
  for (const field of PIN_FIELDS) {
    const list = byFile.get(field.file) ?? [];
    list.push(field);
    byFile.set(field.file, list);
  }

  for (const [file, fields] of byFile) {
    const path = join(root, file);
    const parsed = readJsonObject(path);
    if (parsed == null) continue;
    let modified = false;

    for (const field of fields) {
      const want = before.get(pinFieldId(field));
      if (want == null) continue;
      const container = objectAt(parsed, field.parents);
      const hasNow = container != null && field.key in container;
      const valueNow = container == null ? undefined : container[field.key];

      if (want.present) {
        if (hasNow && valueNow === want.value) continue;
        // Recreate any missing parent so the value can go back.
        let cursor = parsed;
        for (const parent of field.parents) {
          const next = cursor[parent];
          if (typeof next !== 'object' || next == null || Array.isArray(next)) {
            cursor[parent] = {};
          }
          cursor = cursor[parent] as Record<string, unknown>;
        }
        cursor[field.key] = want.value;
        modified = true;
        restored.push(pinFieldId(field));
        continue;
      }

      if (!hasNow || container == null) continue;
      delete container[field.key];
      // An absent parent must not be left behind as an empty object — that is
      // still a diff in a run whose whole contract is "the pin did not move".
      if (!want.parentPresent && Object.keys(container).length === 0) {
        const owner = objectAt(parsed, field.parents.slice(0, -1));
        const last = field.parents[field.parents.length - 1];
        if (owner != null && last != null) delete owner[last];
      }
      modified = true;
      restored.push(pinFieldId(field));
    }

    // The SDK's own writer, so the restored file lands in the same shape the
    // installers write (2-space + the repo's OWN prettier when it has one) —
    // that is what makes "the pin fields came back byte-identical" true of the
    // whole file and not just of the parsed values.
    if (modified) writeJson(path, parsed);
  }
  return restored;
}

/**
 * Undo any pin drift the GATES reintroduced, after they have run
 * (home-base-r47v F2 — the residual gap Dispatch A left open).
 *
 * The payload is not the only thing in the pipeline that can move a pin: the
 * `doctor --fix` gate's fixCommands are `bunx @justinhaaheim/justin-sdk add
 * <component>`, every installer chains base-setup, and base-setup's
 * stepJustinSdkConfig stamps `version`/`lastSynced`. Measured direction of the
 * damage: those subprocesses resolve the TARGET's own pinned SDK, so the
 * orchestrator's version cannot leak in — but in a repo where a doctor check was
 * already RED (a green repo runs no fixer and writes nothing) `lastSynced` still
 * moves to today and `version` to the local pin's version. That would land in
 * the sweep's single commit, and a run whose entire contract is "the pin did not
 * move" would have moved it.
 *
 * COMPONENT MODE ONLY. In a full sweep the pin is SUPPOSED to move — that run's
 * whole purpose is the bump — so this must never restore there. Passing the
 * payload rather than a boolean keeps that decision in one place instead of at
 * the call site.
 */
export function holdPinAfterGates(
  worktree: string,
  payload: SweepPayload,
  beforeGates: PinSnapshot | null,
): string[] {
  if (payload.mode !== 'component' || beforeGates == null) return [];
  return restorePinSnapshot(worktree, beforeGates);
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
// The pin write (full payload only) — home-base-apus.1
// ---------------------------------------------------------------------------

const SDK_DEP_SECTIONS = ['dependencies', 'devDependencies'] as const;
export type DepSection = (typeof SDK_DEP_SECTIONS)[number];

/**
 * Which dependency sections declare the SDK, and at what spec.
 *
 * `ok: false` for a package.json that cannot be read or parsed — "I could not
 * look" must never render as "it is declared nowhere" (rule 5). That
 * conflation is not theoretical here: the empty verdict is exactly what sends
 * the pin step down the skip-the-remove path, which is how a stale declaration
 * survives into a second, contradictory one.
 */
export function readSdkDeclarations(
  root: string,
):
  | {ok: true; declared: ReadonlyMap<DepSection, string>}
  | {ok: false; reason: string} {
  const path = join(root, 'package.json');
  if (!existsSync(path)) return {ok: false, reason: 'package.json not found'};
  const parsed = readJsonObject(path);
  if (parsed == null) {
    return {ok: false, reason: 'package.json is not a readable JSON object'};
  }
  const declared = new Map<DepSection, string>();
  for (const section of SDK_DEP_SECTIONS) {
    // objectAt returns null unless the section really is a plain object, so a
    // `"dependencies": null` or `"dependencies": []` reads as "declares none"
    // rather than throwing on the way through.
    const container = objectAt(parsed, [section]);
    if (container == null) continue;
    const spec = container[SDK_PKG];
    if (typeof spec === 'string') declared.set(section, spec);
  }
  return {declared, ok: true};
}

/** The `workspaces` entries a package.json declares, in either supported shape. */
export function workspacePatternsOf(pkg: Record<string, unknown>): string[] {
  const raw = pkg.workspaces;
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'object' && raw != null
      ? ((raw as {packages?: unknown}).packages ?? null)
      : null;
  if (!Array.isArray(list)) return [];
  return list.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Directories a workspaces pattern names. Deliberately covers only the two
 * shapes that occur in practice — a literal path (`projects/justin-sdk`) and a
 * single trailing star (`packages/*`) — rather than pulling in a glob engine.
 *
 * The limit is safe because this is the SECONDARY signal: the primary one is a
 * `workspace:` spec on the declaration itself, which is what home-base (the
 * only workspace consumer in the fleet) actually carries. A pattern this cannot
 * expand simply contributes no evidence.
 */
function expandWorkspacePattern(root: string, pattern: string): string[] {
  const clean = pattern.replace(/\/+$/, '');
  if (clean === '') return [];
  if (!clean.includes('*')) return [join(root, clean)];
  const prefix = clean.slice(0, -2);
  if (!clean.endsWith('/*') || prefix.includes('*')) return [];
  const parent = join(root, prefix);
  if (!existsSync(parent)) return [];
  try {
    return readdirSync(parent, {withFileTypes: true})
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(parent, entry.name));
  } catch {
    return [];
  }
}

/**
 * Is the SDK already satisfied by a workspace member rather than by a pin?
 * (t6a0.21 D21 — the answer to Dispatch D's home-base QUESTION.)
 *
 * home-base declares `"@justinhaaheim/justin-sdk": "workspace:*"` and lists the
 * submodule that IS the SDK in its `workspaces` array. Writing a github pin
 * there would not bump a pin, it would convert the SDK's own development host
 * off the submodule+workspace arrangement — and it would do so GREEN, because
 * the gates plausibly still pass on the rewritten manifest. So the pin write is
 * skipped, with its own reported outcome; update, gates and component re-apply
 * still run.
 */
export type WorkspaceSatisfaction =
  | {satisfied: true; reason: string}
  | {satisfied: false};

export function sdkWorkspaceSatisfaction(
  root: string,
  declared: ReadonlyMap<DepSection, string>,
): WorkspaceSatisfaction {
  for (const section of SDK_DEP_SECTIONS) {
    const spec = declared.get(section);
    if (spec != null && spec.startsWith('workspace:')) {
      return {reason: `${section}.${SDK_PKG} is "${spec}"`, satisfied: true};
    }
  }
  const pkg = readJsonObject(join(root, 'package.json'));
  if (pkg == null) return {satisfied: false};
  for (const pattern of workspacePatternsOf(pkg)) {
    for (const dir of expandWorkspacePattern(root, pattern)) {
      const member = readJsonObject(join(dir, 'package.json'));
      if (member != null && member.name === SDK_PKG) {
        return {
          reason: `workspaces member ${relative(root, dir)} IS ${SDK_PKG}`,
          satisfied: true,
        };
      }
    }
  }
  return {satisfied: false};
}

/**
 * How many times package.json declares the SDK AS A KEY, counted in the RAW
 * TEXT rather than in the parsed object.
 *
 * Not redundant with verifySinglePin, which cannot see this: `bun add -d` over
 * an existing declaration in the same section writes the key TWICE into one
 * object (measured, bun 1.3.11, `file:` specs). That is valid JSON, JSON.parse
 * silently keeps the last one, and so every parsed view of the manifest —
 * including this module's own — reports one clean declaration while the
 * committed file is corrupt. A text-level count is the only thing that sees it.
 *
 * The literal `"<name>":` form is what separates a declaration from the package
 * name appearing inside a script alias (`bunx @justinhaaheim/justin-sdk
 * doctor`), which carries no closing quote and colon.
 */
export function countSdkKeyDeclarations(packageJsonText: string): number {
  return packageJsonText.split(`"${SDK_PKG}":`).length - 1;
}

/**
 * The post-condition of the pin write, measured off the manifest rather than
 * inferred from an exit code. EXACTLY ONE declaration, in devDependencies, at
 * the swept pin.
 *
 * This exists because every failure this function catches has already shipped:
 * `bun add -d` on a repo declaring the SDK in `dependencies` returns 0 and
 * leaves TWO contradictory declarations (health-logger-rn, commit d14c327,
 * committed and pushed), and `yarn add --dev` on the same shape returns 0 and
 * updates the spec in `dependencies`, silently ignoring `--dev`. A green exit
 * code is not evidence the manifest is right; the manifest is.
 */
export function verifySinglePin(
  declared: ReadonlyMap<DepSection, string>,
  pin: string,
): {ok: true} | {ok: false; reason: string} {
  const entries = [...declared.entries()];
  if (entries.length === 0) {
    return {
      ok: false,
      reason: `the pin step left ${SDK_PKG} declared in neither dependencies nor devDependencies (expected devDependencies "${pin}")`,
    };
  }
  if (entries.length > 1) {
    const shown = entries
      .map(([section, spec]) => `${section}: "${spec}"`)
      .join('; ');
    return {
      ok: false,
      reason: `the pin step left ${SDK_PKG} declared ${entries.length} times (${shown}) — exactly one declaration, in devDependencies, is the contract`,
    };
  }
  const [section, spec] = entries[0] as [DepSection, string];
  if (section !== 'devDependencies') {
    return {
      ok: false,
      reason: `the pin step left ${SDK_PKG} in ${section} ("${spec}") rather than devDependencies`,
    };
  }
  if (spec !== pin) {
    return {
      ok: false,
      reason: `the pin step left ${SDK_PKG} at "${spec}", not the swept pin "${pin}"`,
    };
  }
  return {ok: true};
}

// ---------------------------------------------------------------------------
// The USER-LEVEL surface — one command, both surfaces (t6a0.21 D17)
// ---------------------------------------------------------------------------

/**
 * A rules edit has to reach TWO places: the enrolled repos (the per-repo
 * artifacts, above) and `~/.claude/rules/justin-sdk/critical-rules.md`, which is
 * still the ONLY channel serving the ~69 repos that are not enrolled
 * (home-base-anhw). Making Justin remember a second command after every sweep is
 * exactly the kind of step that gets skipped and then silently rots, so the
 * sweep does it — same trigger-not-heartbeat principle as D4: an explicit act
 * by an invoker who is present, never a background write.
 *
 * SCOPED, and deliberately narrowly: only `--component critical-rules`. A
 * gitignore sweep has no business rewriting anyone's rules file, and the FULL
 * sweep is about SDK pins rather than rules content. Other machines still
 * converge through the existing session-start staleness notice.
 *
 * ISOLATED IN BOTH DIRECTIONS. It runs whatever the repos did (a failed repo is
 * no reason to leave THIS machine on stale rules), and its own outcome is a
 * separate value that never touches a RepoResult — so a broken prompts clone
 * cannot make twelve green repos read as failed, and a red repo cannot make a
 * successful refresh read as skipped.
 */
export type UserRulesOutcome =
  | {status: 'refreshed' | 'current' | 'dry-run'; detail: string}
  | {status: 'failed'; detail: string};

/** null ⇒ this payload has no business touching the user-level file. */
export function refreshUserLevelRules(
  payload: SweepPayload,
  options: {dryRun: boolean} = {dryRun: false},
): UserRulesOutcome | null {
  if (payload.mode !== 'component' || payload.component !== 'critical-rules') {
    return null;
  }
  const file = rulesFilePath();
  if (options.dryRun) {
    return {detail: `would refresh ${file}`, status: 'dry-run'};
  }

  // Report "did the bytes actually move?" by MEASURING the stamped hash either
  // side of the call, rather than by trusting an exit code to mean it. Also the
  // one thing that distinguishes a real refresh from an already-current no-op,
  // which sync-rules only says in prose.
  const before = readDeployedStamp(file)?.contentHash ?? null;
  const wasQuiet = isQuiet();
  let exitCode: number;
  try {
    // quiet: its success chatter would land in the middle of the summary. Its
    // FAILURE line still prints — fail() ignores quiet — so the cause is on
    // screen and this line only has to name the remedy.
    exitCode = runSyncRules({quiet: true});
  } catch (error) {
    return {
      detail:
        `sync-rules threw (${error instanceof Error ? error.message : String(error)}) — ` +
        `${file} was NOT refreshed; the repos above are unaffected`,
      status: 'failed',
    };
  } finally {
    setQuiet(wasQuiet);
  }
  if (exitCode !== 0) {
    return {
      detail:
        `sync-rules failed (exit ${exitCode}) — ${file} was NOT refreshed, so unenrolled repos ` +
        `still see the OLD rules. Fix the cause above, then run \`${SYNC_RULES_CMD}\`. The repos above are unaffected`,
      status: 'failed',
    };
  }
  const after = readDeployedStamp(file)?.contentHash ?? null;
  return after === before
    ? {
        detail: `${file} already current (content ${after ?? 'unstamped'})`,
        status: 'current',
      }
    : {
        detail: `${file} refreshed (content ${before ?? 'none'} → ${after ?? 'unstamped'})`,
        status: 'refreshed',
      };
}

// ---------------------------------------------------------------------------
// The payload: what actually gets applied inside a hydrated worktree
// ---------------------------------------------------------------------------

export type PayloadOutcome =
  | {
      ok: true;
      note: string;
      /**
       * A short phrase that must survive into the repo's SUMMARY line, not just
       * the inline chatter — reserved for payload facts an operator would
       * misread the run without ("the pin was not written"). Absent for the
       * ordinary case, so the common summary line stays unchanged.
       */
      summaryNote?: string;
    }
  | {ok: false; detail: string};

/**
 * Apply `payload` to an already-hydrated worktree. Exported because this is
 * the one step `--component` changes, so it is also the step whose pin
 * neutrality has to be provable against a fixture repo without standing up
 * the whole sweep (hydration, the doctor/signal subprocesses, git plumbing).
 */
export async function applySweepPayload(
  worktree: string,
  payload: SweepPayload,
): Promise<PayloadOutcome> {
  if (payload.mode === 'component') {
    // D11: run the orchestrator's OWN component code in-process. The
    // alternative — `bunx @justinhaaheim/justin-sdk update --component` —
    // resolves the TARGET's pinned SDK, so it would fail against every repo
    // until each pin was bumped once, which is the exact coupling this flag
    // exists to break.
    const before = readPinSnapshot(worktree);
    let exitCode: number;
    try {
      exitCode = await runComponentByName(payload.component, {
        force: false,
        noCommit: true,
        projectRoot: worktree,
        quiet: true,
        skipFetch: false,
      });
    } catch (error) {
      return {
        detail: `component ${payload.component} threw: ${
          error instanceof Error ? error.message : String(error)
        } — worktree left for inspection`,
        ok: false,
      };
    }
    // Restore even on failure: a half-applied component must not leave a
    // moved pin behind in the worktree an operator is about to inspect.
    const restored = restorePinSnapshot(worktree, before);
    if (exitCode !== 0) {
      return {
        detail: `component ${payload.component} failed (exit ${exitCode}) — worktree left for inspection`,
        ok: false,
      };
    }
    return {
      note:
        `applied ${payload.component}` +
        (restored.length > 0
          ? ` (pin held: ${restored.join(', ')})`
          : ' (pin untouched)'),
      ok: true,
    };
  }

  // --- Full payload: pin + update ------------------------------------------
  // The SWEEP pins the target, deterministically, to ITS OWN version — it IS
  // the latest SDK. Learned live on the first sweep run (raycast-j-recent,
  // pinned 0.6.1-era): delegating the bump to the TARGET's `justin-sdk update`
  // self-update means trusting every ancient self-update code path in the
  // fleet, and 0.6.1's silently failed to move the pin at all. Pin first,
  // then run the NEW code with --no-self-update — no gh tag query, no old
  // code trusted, fleet version === orchestrator version by construction.
  // The pin is written with the repo's OWN package manager (third live-sweep
  // finding: raycast-j-recent is an npm repo — Raycast tooling — and `bun
  // add` there migrated package-lock.json and died in a resolver loop).
  // Mixing managers is exactly the class of nondeterminism this script
  // exists to avoid.
  const pinWrite = writeSdkPin(
    worktree,
    `github:justinhaaheim/justin-sdk#v${getSdkVersion()}`,
  );
  if (!pinWrite.ok) return pinWrite;
  const update = runSweepUpdate(worktree);
  if (!update.ok) return update;
  return {
    ...pinWrite,
    note: `${pinWrite.note} + re-applied components`,
  };
}

/**
 * Write `pin` as the repo's ONE SDK declaration, using the repo's own package
 * manager — or report that this repo is not a pin consumer at all.
 *
 * REMOVE-THEN-ADD, never add-over-the-top (home-base-apus.1). Measured on
 * bun 1.3.11 / npm 11.12.1 / yarn 1.22.22, one fixture per manager and shape:
 *   bun  add -d over an existing devDeps GITHUB spec → internal
 *        `DependencyLoop` error, package.json untouched. That is the normal
 *        state of every repo a previous sweep has touched, so it took 4 of the
 *        first 6 repos of the maiden real sweep red.
 *   bun  add -d over an existing devDeps `file:` spec → exit 0, and the SAME
 *        KEY written TWICE into one object. Valid JSON, last-wins on parse, so
 *        the corruption is invisible to any parsed view of the manifest.
 *   bun  add -d over a `dependencies` declaration → exit 0, TWO contradictory
 *        declarations left behind (shipped: health-logger-rn d14c327,
 *        `dependencies` #v0.9.0 vs `devDependencies` #v0.18.0).
 *   yarn add --dev over a `dependencies` declaration → exit 0, spec updated IN
 *        `dependencies`; the `--dev` is silently ignored.
 *   npm  handles both shapes correctly on its own — the remove is kept anyway,
 *        because one recipe for all three managers is the point (uniformity),
 *        and it was measured harmless there.
 * One `<pm> remove` clears BOTH sections in all three managers, so a single
 * remove is the whole fix for every shape. Normalizing a `dependencies`
 * declaration into devDependencies is INTENDED, not collateral, which is why it
 * is reported when it happens.
 *
 * Exported so the four manifest shapes can be exercised against the REAL
 * package managers with a local `file:` pin — offline, and without standing up
 * hydration, the doctor/signal subprocesses and git plumbing around them.
 */
export function writeSdkPin(worktree: string, pin: string): PayloadOutcome {
  const {packageManager} = detectPackageManager(worktree);
  const PIN_ARGV: Record<string, string[]> = {
    bun: ['bun', 'add', '-d', pin],
    npm: ['npm', 'install', '--save-dev', pin],
    yarn: ['yarn', 'add', '--dev', pin],
  };
  const REMOVE_ARGV: Record<string, string[]> = {
    bun: ['bun', 'remove', SDK_PKG],
    npm: ['npm', 'uninstall', SDK_PKG],
    yarn: ['yarn', 'remove', SDK_PKG],
  };
  const manager = packageManager ?? 'bun';
  const pinArgv = PIN_ARGV[manager];
  const removeArgv = REMOVE_ARGV[manager];
  if (pinArgv == null || removeArgv == null) {
    return {
      detail: `no pin recipe for package manager ${String(packageManager)}`,
      ok: false,
    };
  }

  const before = readSdkDeclarations(worktree);
  if (!before.ok) {
    return {
      detail: `cannot read the SDK declaration before pinning: ${before.reason} — worktree left for inspection`,
      ok: false,
    };
  }

  // D21: a workspace consumer is not a pin consumer. Skip the write, loudly.
  const workspace = sdkWorkspaceSatisfaction(worktree, before.declared);
  if (workspace.satisfied) {
    return {
      note: `pin: workspace-satisfied, not written (${workspace.reason})`,
      ok: true,
      summaryNote: 'pin: workspace-satisfied, not written',
    };
  }

  const stale = [...before.declared.keys()];
  if (stale.length > 0) {
    const removed = run(removeArgv, worktree);
    if (removed.exitCode !== 0) {
      return {
        detail:
          `${removeArgv.join(' ')} failed (exit ${removed.exitCode}) — the pin was NOT written, ` +
          'worktree left for inspection',
        ok: false,
      };
    }
  }
  const pinAdd = run(pinArgv, worktree);
  if (pinAdd.exitCode !== 0) {
    return {
      detail: `${pinArgv.slice(0, 2).join(' ')} of ${pin} failed — worktree left for inspection`,
      ok: false,
    };
  }

  // Measure the MANIFEST, not the exit code: every shape listed above returned
  // 0 while leaving the manifest wrong.
  const pkgPath = join(worktree, 'package.json');
  const keyCount = countSdkKeyDeclarations(
    existsSync(pkgPath) ? readFileSync(pkgPath, 'utf-8') : '',
  );
  if (keyCount !== 1) {
    return {
      detail:
        `after the pin write package.json declares "${SDK_PKG}" as a key ${keyCount} time(s), ` +
        'not once — worktree left for inspection',
      ok: false,
    };
  }
  const after = readSdkDeclarations(worktree);
  if (!after.ok) {
    return {
      detail: `cannot read the SDK declaration after pinning: ${after.reason} — worktree left for inspection`,
      ok: false,
    };
  }
  const single = verifySinglePin(after.declared, pin);
  if (!single.ok) {
    return {
      detail: `${single.reason} — worktree left for inspection`,
      ok: false,
    };
  }

  return stale.includes('dependencies')
    ? {
        note: `pinned ${pin} (normalized from dependencies → devDependencies)`,
        ok: true,
        summaryNote: 'pin normalized: dependencies → devDependencies',
      }
    : {note: `pinned ${pin}`, ok: true};
}

/**
 * `justin-sdk update` inside the worktree — the second half of the full
 * payload, shared by the pinned and the workspace-satisfied paths so the
 * skip cannot accidentally skip the component re-apply too.
 */
function runSweepUpdate(worktree: string): PayloadOutcome {
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
    worktree,
  );
  if (update.exitCode !== 0) {
    return {
      detail: 'justin-sdk update failed — worktree left for inspection',
      ok: false,
    };
  }
  // The caller owns the note: it is the only one that knows whether the pin was
  // written, normalized, or deliberately skipped.
  return {note: 'components re-applied', ok: true};
}

// ---------------------------------------------------------------------------
// The ratchet gate — regression, not absolute health (home-base-ckc4 F3)
// ---------------------------------------------------------------------------

export type GateVerdict =
  | {kind: 'proceed'; note: string}
  /** Red before AND after: proceed, but say out loud that the gate saw nothing. */
  | {kind: 'blind'; note: string}
  | {kind: 'fail'; reason: string};

/**
 * What a gate's before/after exit codes mean.
 *
 *   green → green   proceed (the ordinary case)
 *   red   → red     proceed, BLIND: the tree was already broken, so this gate
 *                   proves nothing about the payload either way
 *   green → red     FAIL — the payload did it
 *   red   → green   proceed (the payload improved the tree)
 *
 * EXIT CODES ONLY. `signal` is defined by each repo's own package.json, so its
 * output has no uniform structure to diff; two different reds compare equal
 * here, and that limitation is the price of not growing per-repo intelligence
 * (the ratchet contract). What it buys: five of the six 2026-09-04 failures,
 * none of which the payload caused, stop being reported as payload failures.
 *
 * An UNMEASURABLE baseline is never treated as green — a red-after would then
 * be blamed on the payload without evidence — but it is also never treated as
 * red, which would silently disable the gate. It is its own verdict: fail, and
 * say why. Pure.
 */
export function ratchetVerdict(
  gate: string,
  baseline: number | null,
  after: number,
): GateVerdict {
  if (after === 0) {
    return baseline === 0 || baseline == null
      ? {kind: 'proceed', note: ''}
      : {
          kind: 'proceed',
          note: `${gate} was red before the update (exit ${baseline}) and is green after`,
        };
  }
  if (baseline == null) {
    return {
      kind: 'fail',
      reason: `${gate} red after the update (exit ${after}) and its BASELINE could not be measured — the red cannot be attributed to the tree, so it is attributed to the payload`,
    };
  }
  if (baseline === 0) {
    return {
      kind: 'fail',
      reason: `${gate} was GREEN before the update and is red after (exit ${after}) — the payload broke it`,
    };
  }
  return {
    kind: 'blind',
    note: `${gate} already red before the update (exit ${baseline}, still ${after} after) — PRE-EXISTING, gate blind here`,
  };
}

/**
 * A baseline measurement: the exit code, or `null` when the command could not
 * be run at all. The two are different facts and the verdict table treats them
 * differently, so they must not collapse into one number.
 */
export function measureBaseline(
  argv: string[],
  cwd: string,
): {exitCode: number | null; output: string} {
  const result = run(argv, cwd);
  return {
    exitCode: result.error == null ? result.exitCode : null,
    output: result.output,
  };
}

// ---------------------------------------------------------------------------
// The per-repo pipeline
// ---------------------------------------------------------------------------

interface SweepContext {
  dryRun: boolean;
  payload: SweepPayload;
  /** Where a red step's evidence goes now that the worktree does not survive. */
  log: SweepRunLog;
}

/**
 * The dry-run's advisory line about the pin, so `sweep --dry-run` says up front
 * which repo will NOT get a pin written — the one thing about a full sweep that
 * a plan reading "would sweep off main" hides.
 *
 * ADVISORY, deliberately: it reads the PRIMARY checkout's working tree, while
 * the real run re-decides inside a worktree branched from the default branch's
 * committed state. A dirty or off-branch primary can therefore disagree. The
 * real decision is never taken from here.
 */
function dryRunPinNote(repo: string): string {
  const declarations = readSdkDeclarations(repo);
  if (!declarations.ok) {
    return ` — pin: UNREADABLE (${declarations.reason}); the real run would fail here`;
  }
  const workspace = sdkWorkspaceSatisfaction(repo, declarations.declared);
  return workspace.satisfied
    ? ` — pin: workspace-satisfied, would NOT be written (${workspace.reason})`
    : '';
}

async function sweepOneRepo(
  repo: string,
  context: SweepContext,
): Promise<RepoResult> {
  const name = basename(repo);
  const worktreePath = join(repo, ...SWEEP_WORKTREE_SEGMENTS);
  let worktreeCreated = false;

  /**
   * A red step (ckc4 F2): write the evidence to the run log, remove the
   * worktree and branch, and report where to look. The cleanup runs for EVERY
   * failure after the worktree exists — the old "left standing for inspection"
   * behaviour is what stranded seven worktrees, each of which then blocked
   * every later sweep of its repo.
   */
  const fail = (
    step: string,
    detail: string,
    output: string | null,
  ): RepoResult => {
    context.log.record({detail, output, repo: name, step});
    if (output != null && output.trim() !== '') {
      say(`  ${RED}✗${RESET} ${step} — last ${FAILURE_TAIL_LINES} lines:`);
      say(tailLines(output));
    }
    let cleanupNote = '';
    if (worktreeCreated) {
      const cleaned = cleanupWorktreeAndBranch(repo, worktreePath, SWEEP_BRANCH);
      cleanupNote = cleaned.ok
        ? ' [worktree removed]'
        : ` [${cleaned.detail}]`;
      if (!cleaned.ok) say(`  ${RED}✗${RESET} ${cleaned.detail}`);
    }
    return {
      detail: `${detail}${cleanupNote} — see ${context.log.path}`,
      outcome: 'failed',
      repo: name,
    };
  };

  /** Preflight said this repo cannot be swept at all (ckc4 F4). */
  const blocked = (detail: string): RepoResult => ({
    detail,
    outcome: 'blocked',
    repo: name,
  });

  say(`\n${BOLD}▸ ${name}${RESET} ${DIM}${repo}${RESET}`);

  // --- Preflight -----------------------------------------------------------
  if (!gitOk(repo, ['rev-parse', '--git-dir'])) {
    return blocked('not a git repository');
  }
  const defaultBranch = defaultBranchOf(repo);
  if (defaultBranch == null) {
    return blocked(
      'no default branch (origin/HEAD, main, master all unresolvable)',
    );
  }
  // --- Leftovers from an earlier run (ckc4 F5) -----------------------------
  // BEFORE the enrollment check, deliberately: the leftover is the SWEEP's own
  // litter — a fixed-name worktree at a fixed path, which blocks every future
  // sweep of that repo whatever the payload — so tidying it is not payload
  // scoped. Measured 2026-09-04: two of the seven stranded worktrees on this
  // machine (imessage-exporter, ynab-mcp-deluxe) are in repos NOT enrolled in
  // critical-rules, so an enrollment-first order would leave exactly those two
  // stranded forever, by the run meant to clear them.
  const leftover = assessSweepLeftover(
    repo,
    worktreePath,
    SWEEP_BRANCH,
    defaultBranch,
    allowedLeftoverPaths(context.payload),
  );
  if (leftover.present) {
    if (!leftover.safe) {
      return blocked(`leftover from an earlier run — ${leftover.reason}`);
    }
    if (context.dryRun) {
      say(`  ${YELLOW}⚠${RESET} would auto-remove a leftover — ${leftover.reason}`);
    } else {
      const cleaned = cleanupWorktreeAndBranch(
        repo,
        worktreePath,
        SWEEP_BRANCH,
      );
      if (!cleaned.ok) {
        return blocked(
          `leftover was provably empty but could not be removed — ${cleaned.detail}`,
        );
      }
      say(
        `  ${YELLOW}⚠${RESET} auto-removed a leftover from an earlier run — ${leftover.reason}`,
      );
    }
  }

  // Enrollment (component mode only) — decided from the config as COMMITTED on
  // the branch the sweep will branch from, before anything is created. A repo
  // that does not register the component is out of scope for this run: a
  // visible skip, never a silent one and never a failure.
  if (context.payload.mode === 'component') {
    const {component} = context.payload;
    const declared = committedConfigComponents(repo, defaultBranch);
    if (!declared.ok) {
      // NOT a benign skip: "I could not read the enrollment" is a repo this run
      // failed to sweep, and it has to be counted as one (ckc4 F4).
      return blocked(`cannot read enrollment: ${declared.reason}`);
    }
    if (!isEnrolledIn(declared.components, component)) {
      return {
        detail: `skipped — not enrolled in ${component}`,
        outcome: 'skipped',
        repo: name,
      };
    }
  }

  if (context.dryRun) {
    return {
      detail:
        (leftover.present ? 'would auto-remove a leftover, then ' : '') +
        (context.payload.mode === 'component'
          ? `would apply ${context.payload.component} off ${defaultBranch} (pin untouched)`
          : `would sweep off ${defaultBranch}${dryRunPinNote(repo)}`),
      outcome: 'current',
      repo: name,
    };
  }

  // --- Worktree ------------------------------------------------------------
  const baseSha = git(repo, ['rev-parse', `refs/heads/${defaultBranch}`]);
  if (baseSha == null) {
    return fail('resolve-base', `cannot resolve ${defaultBranch}`, null);
  }
  const add = addSweepWorktree(repo, worktreePath, SWEEP_BRANCH, baseSha);
  if (!add.ok) return fail('worktree-add', add.detail, add.output);
  worktreeCreated = true;

  // --- Hydrate (retry once — home-base-dl0q) -------------------------------
  let hydrated = setupEnv({target: worktreePath});
  if (hydrated.exitCode !== 0) {
    say(`  ${YELLOW}⚠${RESET} hydration failed once — retrying (dl0q class)`);
    hydrated = setupEnv({target: worktreePath});
  }
  if (hydrated.exitCode !== 0) {
    // setupEnv reports STEPS rather than raw child output (its children write
    // straight to this process's stderr), so the log gets the step table — the
    // failing label and its detail — which is what names the cause here.
    return fail(
      'hydrate',
      'hydration failed twice',
      hydrated.steps
        .map((step) => `${step.label} ${step.status} — ${step.detail}`)
        .join('\n'),
    );
  }

  // --- Baseline (ckc4 F3) --------------------------------------------------
  // Measured on the HYDRATED tree, BEFORE the payload, so the gates below can
  // tell "the payload broke this" from "this tree was never green". Read-only:
  // doctor without --fix, and the repo's own signal, which never writes.
  const doctorBaseline = measureBaseline(
    ['bunx', '@justinhaaheim/justin-sdk', 'doctor'],
    worktreePath,
  );
  const signalBaseline = measureBaseline(['bun', 'run', 'signal'], worktreePath);
  say(
    `  ${DIM}baseline: doctor ${doctorBaseline.exitCode ?? 'UNMEASURABLE'}, signal ${signalBaseline.exitCode ?? 'UNMEASURABLE'}${RESET}`,
  );

  // --- Payload (pin + update, or one component in-process) -----------------
  const payload = await applySweepPayload(worktreePath, context.payload);
  if (!payload.ok) return fail('payload', payload.detail, null);
  say(`  ${DIM}${payload.note}${RESET}`);
  // Carried all the way to the summary line: a pin that was deliberately not
  // written must not be legible only in the scrollback above.
  const payloadNote =
    payload.summaryNote == null ? '' : ` [${payload.summaryNote}]`;

  // --- Gates ---------------------------------------------------------------
  // Snapshot AFTER the payload (which already restored the pin), so the gates
  // are measured against the state the commit is supposed to have.
  const pinBeforeGates =
    context.payload.mode === 'component' ? readPinSnapshot(worktreePath) : null;
  const doctor = run(
    ['bunx', '@justinhaaheim/justin-sdk', 'doctor', '--fix'],
    worktreePath,
  );
  // Before the exit-code check, deliberately (home-base-r47v F2): a red doctor
  // still ran its fixers, and a worktree an operator is about to inspect must
  // not have a moved pin sitting in it either.
  const pinHeldAfterGates = holdPinAfterGates(
    worktreePath,
    context.payload,
    pinBeforeGates,
  );
  const pinGateNote =
    pinHeldAfterGates.length > 0
      ? ` (post-gate pin held: ${pinHeldAfterGates.join(', ')})`
      : '';
  if (pinGateNote !== '') say(`  ${DIM}${pinGateNote.trim()}${RESET}`);

  // The ratchet, not the absolute verdict (ckc4 F3). The baseline was measured
  // with `doctor` (read-only); this is `doctor --fix`, so a repo whose doctor is
  // fixable goes red → green here and proceeds, which is the intended shape.
  const blindNotes: string[] = [];
  const doctorVerdict = ratchetVerdict(
    'doctor',
    doctorBaseline.exitCode,
    doctor.exitCode,
  );
  if (doctorVerdict.kind === 'fail') {
    return fail(
      'doctor',
      `${doctorVerdict.reason}${pinGateNote}`,
      `--- BASELINE (doctor, before the payload) ---\n${doctorBaseline.output}\n--- AFTER (doctor --fix) ---\n${doctor.output}`,
    );
  }
  if (doctorVerdict.kind === 'blind') {
    blindNotes.push(doctorVerdict.note);
    say(`  ${YELLOW}⚠${RESET} ${doctorVerdict.note}`);
  } else if (doctorVerdict.note !== '') {
    say(`  ${DIM}${doctorVerdict.note}${RESET}`);
  }

  // Normalize SDK-written JSON to the repo's own prettier config — AFTER
  // doctor --fix (fifth live-sweep finding: doctor's fixers re-write these
  // files unformatted, so normalizing before it hands signal a dirty file)
  // and BEFORE signal, whose PRETTIER check is the gate that cares.
  const present = PRETTIER_NORMALIZE_FILES.filter((file) =>
    existsSync(join(worktreePath, file)),
  );
  if (present.length > 0) {
    run(
      ['bunx', 'prettier', '--write', '--ignore-unknown', ...present],
      worktreePath,
    );
  }

  const signal = run(['bun', 'run', 'signal'], worktreePath);
  const signalVerdict = ratchetVerdict(
    'signal',
    signalBaseline.exitCode,
    signal.exitCode,
  );
  if (signalVerdict.kind === 'fail') {
    return fail(
      'signal',
      signalVerdict.reason,
      `--- BASELINE (signal, before the payload) ---\n${signalBaseline.output}\n--- AFTER ---\n${signal.output}`,
    );
  }
  if (signalVerdict.kind === 'blind') {
    blindNotes.push(signalVerdict.note);
    say(`  ${YELLOW}⚠${RESET} ${signalVerdict.note}`);
  } else if (signalVerdict.note !== '') {
    say(`  ${DIM}${signalVerdict.note}${RESET}`);
  }
  // Carried into the SUMMARY line, not just the scrollback: a repo that was
  // merged with its gates blind must not read as an ordinary green.
  const blindNote =
    blindNotes.length > 0 ? ` [${blindNotes.join('; ')}]` : '';

  // --- Commit --------------------------------------------------------------
  const stage = stageForCommit(worktreePath, context.payload);
  let scopeNote = '';
  if (stage.excluded.length > 0) {
    scopeNote = ` [NOT committed, outside this component's contract: ${stage.excluded.join(', ')}]`;
    say(
      `  ${YELLOW}⚠${RESET} left uncommitted (outside the component's contract): ${stage.excluded.join(', ')}`,
    );
  }

  const changedFiles = stage.staged;
  if (changedFiles.length === 0) {
    const cleaned = cleanupWorktreeAndBranch(repo, worktreePath, SWEEP_BRANCH);
    return {
      detail: `already current${payloadNote}${scopeNote}${blindNote}${
        cleaned.ok ? '' : ` [${cleaned.detail}]`
      }`,
      outcome: 'current',
      repo: name,
    };
  }
  const beadsGuard = beadsConfigGuard(context.payload, changedFiles);
  if (!beadsGuard.ok) {
    return fail('beads-config-guard', beadsGuard.reason, null);
  }
  const commit = run(
    [
      'git',
      '-C',
      worktreePath,
      'commit',
      // --no-verify (ckc4 F3b). health-logger-rn and ynab-mcp-deluxe run
      // `ts-check` in .husky/pre-commit, so a repo with a PRE-EXISTING red
      // baseline — which the ratchet gate above deliberately lets through —
      // would fail at the commit instead, re-importing the absolute-health gate
      // through the back door. The sweep IS its own gate, and it measured this
      // content. A lint-staged hook is also skipped as a result, which is a
      // second win: what gets committed is byte-identical to what was
      // generated, and a prettier-unstable artifact shows up as green→red on
      // the repo's own PRETTIER check, where it belongs.
      '--no-verify',
      '-m',
      sweepCommitMessage(context.payload),
    ],
    repo,
  );
  if (commit.exitCode !== 0) {
    return fail('commit', `commit failed (exit ${commit.exitCode})`, commit.output);
  }

  // --- Merge safety + merge -----------------------------------------------
  const primaryBranch = git(repo, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'HEAD',
  ]);
  const porcelain = gitPorcelain(repo) ?? '';
  const safety = mergeSafety(
    primaryBranch,
    defaultBranch,
    parsePorcelainPaths(porcelain),
    changedFiles,
  );
  if (!safety.ok) {
    // One of the two paths that DELIBERATELY keeps its worktree and branch
    // (ckc4 F2): the commit is green and still has to be merged by a human, so
    // deleting it would delete the work. Says so explicitly, because everything
    // else now cleans up.
    return {
      detail: `green + committed on ${SWEEP_BRANCH}${pinGateNote}${payloadNote}${scopeNote}${blindNote}, but merge deferred: ${safety.reason} — worktree + branch KEPT ON PURPOSE (they hold the commit)`,
      outcome: 'merge-pending',
      repo: name,
    };
  }
  const merge = run(
    ['git', '-C', repo, 'merge', '--ff-only', SWEEP_BRANCH],
    repo,
  );
  if (merge.exitCode !== 0) {
    // The second deliberate keep — same reason: the commit lives on that branch.
    return {
      detail: `merge --ff-only failed (diverged?)${payloadNote}${scopeNote}${blindNote} — worktree + branch ${SWEEP_BRANCH} KEPT ON PURPOSE (they hold the commit)`,
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
  const cleaned = cleanupWorktreeAndBranch(repo, worktreePath, SWEEP_BRANCH);
  return {
    detail: `updated, merged into ${defaultBranch}, ${pushNote}${pinGateNote}${payloadNote}${scopeNote}${blindNote}${
      cleaned.ok ? '' : ` [${cleaned.detail}]`
    }`,
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
  /**
   * Scope the payload to ONE component (short or `-setup` name) and leave the
   * SDK pin alone. Unknown name = the whole run refuses, before any repo is
   * touched. Default (absent) = the historical pin-bump-and-re-apply-all sweep.
   */
  component?: string;
  /** Where the run's failure log goes. Default SWEEP_LOG_DIR. */
  logDir?: string;
}

export async function runSweep(options: SweepOptions = {}): Promise<number> {
  const parsedComponent = parseComponentOption(options.component);
  if (!parsedComponent.ok) {
    // Refuse the ENTIRE run: falling through to the default payload on a typo
    // would ship an SDK pin bump to the whole fleet.
    say(`${RED}✗ ${parsedComponent.error}${RESET}`);
    return 1;
  }
  const payload = planSweepPayload(parsedComponent.component);

  const root = resolve(options.root ?? join(homedir(), 'Dev'));
  const explicit = (options.repos ?? []).map((repoPath) => resolve(repoPath));
  const repos = explicit.length > 0 ? explicit : discoverSweepRepos(root);
  const dryRun = options.dryRun === true;

  say(
    `${BOLD}justin-sdk sweep${RESET} — ${repos.length} repo(s)` +
      `${explicit.length > 0 ? ' (explicit)' : ` discovered under ${root}`}` +
      `${
        payload.mode === 'component'
          ? ` ${DIM}· component: ${payload.component} (SDK pin NOT bumped)${RESET}`
          : ''
      }` +
      `${dryRun ? ` ${DIM}(dry-run)${RESET}` : ''}`,
  );

  // Announced at the top AND at the bottom (ckc4 F2): a failure's worktree is
  // gone by the time the summary prints, so the log is the only evidence left
  // and the operator has to know where it is before the run starts scrolling.
  const log = createRunLog(options.logDir ?? SWEEP_LOG_DIR);
  say(`${DIM}failure log (written only if something fails): ${log.path}${RESET}`);

  const results: RepoResult[] = [];
  for (const repo of repos) {
    results.push(await sweepOneRepo(repo, {dryRun, log, payload}));
  }

  // D17. Unconditional on the repo results by design (see refreshUserLevelRules):
  // a repo that went red is no reason to leave this machine's own rules stale.
  const userRules = refreshUserLevelRules(payload, {dryRun});

  say(`\n${BOLD}Summary${RESET}`);
  const ICON: Record<RepoOutcome, string> = {
    blocked: `${RED}⊘${RESET}`,
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
  if (userRules != null) {
    // Its OWN line, visibly not a repo: the two surfaces succeed and fail
    // independently, so folding this in among the repo names would invite
    // reading a red user-level refresh as a red repo.
    const USER_ICON: Record<UserRulesOutcome['status'], string> = {
      current: `${GREEN}=${RESET}`,
      'dry-run': `${DIM}⊘${RESET}`,
      failed: `${RED}✗${RESET}`,
      refreshed: `${GREEN}✓${RESET}`,
    };
    say(
      `  ${USER_ICON[userRules.status]} ${BOLD}user-level rules${RESET} ${DIM}${userRules.detail}${RESET}`,
    );
  }
  const of = (outcome: RepoOutcome): RepoResult[] =>
    results.filter((result) => result.outcome === outcome);
  const failed = of('failed');
  const pending = of('merge-pending');
  const blocked = of('blocked');
  const skipped = of('skipped');

  if (failed.length + pending.length > 0) {
    say(
      `\n${YELLOW}${failed.length} failed (worktree removed; evidence in the run log), ${pending.length} merge-pending (worktree kept — it holds the commit). Fix the CAUSE in the SDK (ratchet contract), then re-sweep.${RESET}`,
    );
  }
  if (log.wrote()) {
    say(`${YELLOW}failure log: ${log.path}${RESET}`);
  }
  // ckc4 F4. Two things that both used to be "skipped" and both used to exit 0:
  // a repo this payload does not apply to (expected), and a repo this run COULD
  // NOT SWEEP (a leftover it may not delete, an unreadable enrollment, a
  // non-repo). The second is a propagation failure — the fleet is now out of
  // sync and nothing said so — and it is printed LAST, where a long run's tail
  // is actually read.
  if (skipped.length > 0) {
    say(
      `${DIM}${skipped.length} not enrolled in this payload (expected, not a failure): ${skipped
        .map((result) => result.repo)
        .join(', ')}${RESET}`,
    );
  }
  if (blocked.length > 0) {
    say(
      `\n${RED}${blocked.length} COULD NOT SWEEP: ${blocked
        .map((result) => result.repo)
        .join(', ')}${RESET}` +
        `\n${RED}These repos did NOT receive the payload. Resolve each (see its line above), then re-sweep.${RESET}`,
    );
  }
  // A failed user-level refresh is a real failure and must not exit 0 — that
  // would be the silence-shaped kind. It is attributed to its own surface, never
  // to a repo, and the remedy is one command rather than another whole sweep.
  return failed.length > 0 ||
    blocked.length > 0 ||
    userRules?.status === 'failed'
    ? 1
    : 0;
}
