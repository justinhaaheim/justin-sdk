/**
 * sweep.ts — `justin-sdk sweep`: the fleet propagation orchestrator
 * (home-base-j2n7, decisions of 2026-08-08).
 *
 * WHAT IT DOES, per enrolled repo: list (and, when provably empty, remove)
 * earlier runs' leftovers → fetch the default branch's upstream and
 * fast-forward or refuse (39co9.6 S5) → fresh worktree named for THIS run off
 * the local default branch (S1) → hydrate → measure the BASELINE doctor/signal → `justin-sdk update`
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
 * ONE NAME PER RUN (home-base-39co9.6, 2026-10-05). Even with cleanup on every
 * red step, an INTERRUPTED run still stranded the fixed-name worktree, and its
 * commit then made the repo "COULD NOT SWEEP" until someone cleared it by hand
 * (three repos, 2026-10-05). So each run stamps its branch and worktree with
 * the run-log stamp, earlier leftovers are listed rather than blocking (still
 * removed when provably empty, never when they hold a commit), and the log is
 * written from the start so a killed run says how far it got. A push that fails
 * after the local merge is its own red outcome, and it and merge-pending both
 * fail the run (S7) — "0 failed" over four unpushed repos was the report that
 * prompted it.
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
 * POST-MERGE INSTALL (home-base-bgfl): the merge writes package.json and the
 * lockfile into the primary, but the primary's node_modules still holds the
 * PREVIOUS SDK — the sweep only ever installed inside its own worktree. MEASURED
 * 2026-09-12, right after the fleet sweep to v0.28.1: a `doctor` run in
 * apple-reminders-mcp printed "justin-sdk
 * 0.27.0 → 0.28.1 available" with the pin already AT 0.28.1, and six primaries
 * were still executing a pre-0.27 SDK after two sweeps — a run reporting
 * "updated, merged, pushed" about a repo that goes on running the old version,
 * i.e. the exact thing the sweep exists to change. So a successful merge is now
 * followed by the repo's own FROZEN install, run in the primary. Frozen
 * (`bun install --frozen-lockfile` / `npm ci` / `yarn install
 * --frozen-lockfile`) because the lockfile the sweep just committed must not be
 * rewritten by this step: a mismatch has to fail loudly instead. It runs only
 * when the sweep's own commit touched package.json or the lockfile, and only
 * when neither is dirty in the primary; every other case is a SKIP that names
 * its reason. A failed install is its own outcome (`install-failed`) rather
 * than a green with a footnote — the repo really is still running the old SDK.
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
  readdirSync,
  readFileSync,
} from 'node:fs';
import {homedir} from 'node:os';
import {basename, join, relative, resolve} from 'node:path';

import {
  COMPONENT_NAMES,
  type ComponentName,
  configNameFor,
  resolveComponents,
} from './component-registry';
import {runComponentByName} from './components';
import {silencedChildEnv} from './health-notices';
import {runInstall} from './install';
import {
  readDeployedStamp,
  rulesFilePath,
  SYNC_RULES_CMD,
} from './rules/rules-file';
import {getSdkVersion} from './sdk-identity';
import {resolveWorktreeSdkBin, worktreeSdkArgv} from './sdk-invocation';
import {sdkTagExistsOnRemote} from './sdk-latest';
import {detectPackageManager, type PackageManager, setupEnv} from './setup-env';
import {isQuiet, setQuiet, writeJson} from './setup-helpers';
import {
  applyInstallPayloadConfig,
  noProvenanceLine,
  planInstallPayload,
  renderInstallPayloadPlan,
} from './sweep-install';
import {runSyncRules} from './sync-rules';

// ---------------------------------------------------------------------------
// Run identity — one timestamped branch + worktree per run (home-base-39co9.6 S1)
// ---------------------------------------------------------------------------

/**
 * The directory the sweep's worktrees live in, relative to each repo — Claude
 * Code's own worktree convention, so the sweep's trees sit beside the ones the
 * worktree tool makes and are ignored on the same three surfaces.
 */
export const SWEEP_WORKTREES_DIR = ['.claude', 'worktrees'] as const;

/**
 * The FIXED name every run used until 2026-10-05 (branch `worktree-sdk-sweep`
 * at `.claude/worktrees/sdk-sweep`). No run creates it any more; it is kept
 * only so the leftover scan still recognises what those runs left behind.
 *
 * WHY THE FIXED NAME HAD TO GO (S1, Justin 2026-10-05): one name per repo meant
 * one stranded run blocked every later sweep of that repo. On 2026-10-05 three
 * repos were blocked by 2026-09-18 leftovers, each holding one sweep commit
 * that never merged. With a name per run, an older leftover can never collide
 * with a new run, so it is REPORTED (S2) instead of blocking.
 */
export const LEGACY_SWEEP_NAME = 'sdk-sweep';

/**
 * A run's stamp: the ISO start time with the colons swapped for dashes (legal
 * on macOS but hostile in shell arguments and Finder). The SAME string names
 * the run log, the branch and the worktree, so any one of them finds the other
 * two. Pure.
 */
export function sweepRunStamp(now: Date): string {
  return now.toISOString().replace(/:/g, '-');
}

/** Matches exactly what `sweepRunStamp` produces, and nothing looser. */
const SWEEP_STAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d{3})?Z$/;

export interface SweepRunNames {
  branch: string;
  /** The worktree directory's name under `.claude/worktrees/`. */
  name: string;
  worktreeSegments: readonly string[];
}

/** The branch and worktree one run uses. Pure. */
export function sweepRunNames(stamp: string): SweepRunNames {
  const name = `${LEGACY_SWEEP_NAME}-${stamp}`;
  return {
    branch: `worktree-${name}`,
    name,
    worktreeSegments: [...SWEEP_WORKTREES_DIR, name],
  };
}

/**
 * Is `name` a worktree name the sweep itself made — the legacy fixed name, or
 * `sdk-sweep-<stamp>` with a stamp `sweepRunStamp` could have produced? Strict
 * on purpose: the leftover scan may auto-REMOVE what this matches (when it is
 * provably empty), so a person's own `sdk-sweep-notes` worktree must not match.
 * Pure.
 */
export function isSweepWorktreeName(name: string): boolean {
  if (name === LEGACY_SWEEP_NAME) return true;
  const prefix = `${LEGACY_SWEEP_NAME}-`;
  return (
    name.startsWith(prefix) &&
    SWEEP_STAMP_PATTERN.test(name.slice(prefix.length))
  );
}

/** The branch a sweep worktree name goes with (Claude Code's `worktree-<name>`). */
export function sweepBranchFor(name: string): string {
  return `worktree-${name}`;
}

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
  | 'merge-pending' // green + committed, but the merge could not complete safely. Fails the run (S7: work not delivered).
  | 'install-failed' // merged, but the primary's post-merge install went red — it still runs the OLD SDK (bgfl)
  | 'push-failed' // merged LOCALLY, push rejected/failed — the default branch holds a commit the remote lacks (S6/S7). Fails the run.
  | 'failed' // a step went red; worktree removed, evidence in the run log
  | 'blocked' // COULD NOT sweep — preflight refused (ckc4 F4). Fails the run.
  | 'skipped'; // out of scope for this payload (not enrolled). Expected, not a failure.

/** What a repo's sweep decided, before its leftover report is attached. */
export interface RepoVerdict {
  /** One line: what happened / why it stopped. */
  detail: string;
  outcome: RepoOutcome;
  repo: string;
}

export interface RepoResult extends RepoVerdict {
  /** Earlier runs' worktrees/branches found in this repo (39co9.6 S2). */
  leftovers: LeftoverScanReport;
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
 *
 * HEALTH NOTICES ARE OFF IN EVERY CHILD (home-base-uxwc.6). D1 classifies
 * `sweep` itself as NEVER — "sweep IS the upgrade" — but that only covers this
 * process. The gates spawn `bun run justin-sdk doctor`, `… doctor --fix` and
 * `bun run signal` inside each temp worktree, and those are tier-2/tier-3 callsites in
 * their own right: without the kill switch a 12-repo sweep prints the upgrade
 * notice up to 12 times into the run log (the per-repo throttle is keyed by
 * project root, and every sweep worktree is a different path), and every one of
 * them would also fire a doctor heartbeat inside a gate that is already running
 * doctor. Noise, in exactly the log an operator reads when a sweep goes red.
 * This is the ONE funnel — `measureBaseline` and the direct callers all come
 * through here — so it is the one place the switch has to be set.
 */
function run(
  argv: string[],
  cwd: string,
  /**
   * `quiet` suppresses the ECHO of the child's output, never its capture — the
   * caller still gets every byte for the run log. For steps whose success is
   * uninteresting and whose failure is reported by the caller (the post-merge
   * install, home-base-bgfl). The `$ <command>` line is still printed: an
   * operator must always be able to see what is currently running.
   */
  options: {quiet?: boolean} = {},
): {error: string | null; exitCode: number; output: string} {
  const [cmd, ...args] = argv;
  if (cmd == null) return {error: 'empty command', exitCode: 1, output: ''};
  say(`  ${DIM}$ ${argv.join(' ')}${RESET}`);
  const child = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf-8',
    env: silencedChildEnv(process.env),
    // A full `bun install` + signal run can be large; the Node default (1MB)
    // would truncate exactly the tail the log needs.
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = `${child.stdout ?? ''}${child.stderr ?? ''}`;
  const trimmed = output.replace(/\n+$/, '');
  if (trimmed !== '' && options.quiet !== true) say(trimmed);
  if (child.error != null)
    return {error: child.error.message, exitCode: 1, output};
  return {error: null, exitCode: child.status ?? 1, output};
}

// ---------------------------------------------------------------------------
// WHICH SDK the gates run (dchjw.15 F2)
// ---------------------------------------------------------------------------

/**
 * The by-path resolver lives in sdk-invocation.ts — it is a way of SPELLING the
 * SDK, and that file is the one place they are spelled (D1). Re-exported here
 * because the sweep is where it was born and where its tests live; `update` is
 * the second caller (dchjw.17 F4).
 */
export {
  resolveWorktreeSdkBin,
  type SdkBinResolution,
  worktreeSdkArgv,
} from './sdk-invocation';

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
  /** The run's log file — printed at the top and the bottom of every run. */
  readonly path: string;
  /** false for a dry run, which writes nothing anywhere (the path is still printed). */
  readonly persisted: boolean;
  /**
   * A progress line, appended the moment it happens (S4): worktree created,
   * committed, merged, pushed, a leftover found. `repo` null = the run itself.
   */
  note: (repo: string | null, line: string) => void;
  /** A red step: its detail plus the tail of its output (ckc4 F2). */
  record: (entry: {
    detail: string;
    /** null = this step reports steps rather than raw command output. */
    output: string | null;
    repo: string;
    step: string;
  }) => void;
  /** Has any red step been recorded? Decides the "failure log:" line at the end. */
  recordedFailure: () => boolean;
}

/**
 * Written FROM THE START of the run, and appended to as each step happens
 * (home-base-39co9.6 S4).
 *
 * WHY NOT LAZILY ANY MORE: until 2026-10-05 nothing was written until a step
 * went red, so a clean run left no litter — and an INTERRUPTED run left no
 * trace either. That is exactly what three repos showed on 2026-10-05: each
 * held a 2026-09-18 sweep commit that never merged, and no log survived to say
 * which run made it or how far it got. Now the header names the run's branch
 * and worktree, and every step that changes something appends a line before
 * the next one starts, so a run killed after committing has said so on disk.
 *
 * A log-write failure is REPORTED (once, loudly) and never swallowed — but it
 * also never changes a repo's verdict. Losing the evidence is bad; turning a
 * green repo red because a directory was unwritable would be worse.
 */
export function createRunLog(
  dir: string = SWEEP_LOG_DIR,
  now: Date = new Date(),
  options: {header?: readonly string[]; persist?: boolean} = {},
): SweepRunLog {
  const stamp = sweepRunStamp(now);
  const path = join(dir, `${stamp}.log`);
  const persisted = options.persist !== false;
  let failureRecorded = false;
  let writeError: string | null = null;

  const append = (text: string): void => {
    if (!persisted || writeError != null) return;
    try {
      mkdirSync(dir, {recursive: true});
      appendFileSync(path, text);
    } catch (error) {
      writeError = error instanceof Error ? error.message : String(error);
      say(
        `  ${RED}✗${RESET} could not write the run log at ${path}: ${writeError} — ` +
          'this run keeps going, but nothing more will reach that file',
      );
    }
  };

  append(
    [
      `justin-sdk sweep — run ${stamp}, started ${now.toISOString()}`,
      ...(options.header ?? []),
      '',
    ].join('\n'),
  );

  return {
    note: (repo, line) => {
      const time = new Date().toISOString().slice(11, 19);
      append(`[${time}] ${repo == null ? '' : `${repo}: `}${line}\n`);
    },
    path,
    persisted,
    record: ({detail, output, repo, step}) => {
      failureRecorded = true;
      append(
        [
          '',
          '─'.repeat(72),
          `${repo} · step: ${step}`,
          detail,
          output == null
            ? '(this step reports steps, not raw command output — see the detail above)'
            : `--- last ${FAILURE_TAIL_LINES} lines of stdout+stderr ---\n${tailLines(output)}`,
          '',
        ].join('\n'),
      );
    },
    recordedFailure: () => failureRecorded,
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
    if (line.startsWith('worktree '))
      paths.push(line.slice('worktree '.length));
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
  /** What was removed, or exactly what survived. Never "probably gone". */
  detail: string;
  ok: boolean;
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
    run(
      ['git', '-C', repo, 'worktree', 'remove', '--force', worktreePath],
      repo,
    );
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
    ? {
        detail: `removed worktree ${worktreePath} and branch ${branch}`,
        ok: true,
      }
    : {
        detail: `cleanup INCOMPLETE — still present: ${survivors.join('; ')}`,
        ok: false,
      };
}

export interface WorktreeAddResult {
  detail: string;
  ok: boolean;
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
  // NAME ALREADY TAKEN → refuse, and touch NOTHING (39co9.6). The failure path
  // below removes the branch and the worktree to undo a half-made add — which
  // is only right when this call made them. With the fixed name the preflight
  // had always cleared the name first; with a name per run, something already
  // holding it is another run's (two runs in the same millisecond, or a leftover
  // that was kept because it holds work), and the salvage would `branch -D` it.
  const taken = [
    existsSync(worktreePath) ? `directory ${worktreePath}` : null,
    isWorktreeRegistered(repo, worktreePath)
      ? `worktree registration for ${worktreePath}`
      : null,
    gitOk(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
      ? `branch ${branch}`
      : null,
  ].filter((entry): entry is string => entry != null);
  if (taken.length > 0) {
    return {
      detail: `this run's name is already taken (${taken.join('; ')}) — nothing created, nothing removed`,
      ok: false,
      output: '',
    };
  }
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
    return {
      detail: `worktree added at ${worktreePath}`,
      ok: true,
      output: add.output,
    };
  }
  const salvage = cleanupWorktreeAndBranch(repo, worktreePath, branch);
  return {
    detail: `git worktree add failed (exit ${add.exitCode}) — ${
      salvage.ok ? 'nothing left behind' : `and ${salvage.detail.toLowerCase()}`
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
// Fetch first — build on the default branch as the REMOTE has it (39co9.6 S5)
// ---------------------------------------------------------------------------

/**
 * Where the local default branch stands against its upstream.
 *
 * MEASURED 2026-10-05: browser-automation-central's local main was 9 commits
 * behind origin/main (pushed from another machine 2026-09-26..28). The sweep
 * branched from the stale local main, merged its commit into it, and the push
 * was rejected as non-fast-forward — leaving local main DIVERGED. So the sweep
 * now fetches before it branches, and compares.
 *
 * `unknown` is its own state, never folded into "up to date" (rule 7): a fetch
 * that failed says nothing about whether the base is stale.
 */
export type UpstreamComparison =
  | {
      kind: 'compared';
      /** `git log --oneline` of what only the local branch has. */
      localOnly: string[];
      /** `git log --oneline` of what only the upstream has. */
      remoteOnly: string[];
      /** e.g. `origin/main`. */
      upstream: string;
      upstreamSha: string;
    }
  | {detail: string; kind: 'no-upstream'}
  | {detail: string; kind: 'unknown'; output: string | null};

export type FreshBasePlan =
  | {kind: 'block'; reason: string}
  | {kind: 'fast-forward'; note: string; upstreamSha: string}
  | {kind: 'proceed'; note: string | null};

/** How many commits of each side a COULD NOT SWEEP line prints. */
export const COMMIT_LIST_LIMIT = 25;

/** A commit list for a summary line: indented, capped, the cap stated. Pure. */
export function formatCommitList(
  commits: readonly string[],
  limit = COMMIT_LIST_LIMIT,
): string {
  const shown = commits.slice(0, limit).map((line) => `        ${line}`);
  if (commits.length > limit) {
    shown.push(`        … and ${commits.length - limit} more`);
  }
  return shown.join('\n');
}

/**
 * Fast-forward, proceed, or refuse the repo up front? A pure decision over the
 * measurements, so the whole table is unit-testable (S5).
 *
 *   up to date            → proceed.
 *   ahead only            → proceed, with a note: the push will publish those
 *                           local commits too (the sweep's long-standing shape,
 *                           now said out loud).
 *   strictly behind       → fast-forward, but ONLY when the primary is on the
 *                           default branch and has no tracked changes; otherwise
 *                           COULD NOT SWEEP — building on the stale base is the
 *                           2026-10-05 failure, and moving someone's checkout
 *                           out from under them is not the sweep's call.
 *   diverged              → COULD NOT SWEEP, both commit lists, no work done.
 *   no upstream           → proceed (nothing to fetch, nothing to fall behind).
 *   unknown               → COULD NOT SWEEP: a base that cannot be shown fresh
 *                           is not assumed fresh (rule 7's cautious verdict).
 *
 * `primaryTrackedClean` null = the status could not be read, which is not clean.
 * Untracked files do not count as dirty: `git merge --ff-only` refuses rather
 * than overwrite one, and that refusal is caught as COULD NOT SWEEP below.
 */
export function planFreshBase(input: {
  comparison: UpstreamComparison;
  defaultBranch: string;
  primaryBranch: string | null;
  primaryTrackedClean: boolean | null;
  repo: string;
}): FreshBasePlan {
  const {comparison, defaultBranch, primaryBranch, primaryTrackedClean, repo} =
    input;
  if (comparison.kind === 'no-upstream') {
    return {kind: 'proceed', note: comparison.detail};
  }
  if (comparison.kind === 'unknown') {
    return {
      kind: 'block',
      reason: `could not compare ${defaultBranch} with its upstream — ${comparison.detail}. A base that cannot be shown fresh is not assumed fresh; nothing was done here`,
    };
  }
  const {localOnly, remoteOnly, upstream} = comparison;
  if (localOnly.length > 0 && remoteOnly.length > 0) {
    return {
      kind: 'block',
      reason:
        `${defaultBranch} and ${upstream} have DIVERGED — nothing was done here. ` +
        `Reconcile them by hand (\`git -C ${repo} pull --rebase\` or a merge), then re-sweep.\n` +
        `      only on ${defaultBranch} (${localOnly.length}):\n${formatCommitList(localOnly)}\n` +
        `      only on ${upstream} (${remoteOnly.length}):\n${formatCommitList(remoteOnly)}`,
    };
  }
  if (remoteOnly.length > 0) {
    const where =
      primaryBranch !== defaultBranch
        ? `the primary checkout is on ${primaryBranch ?? 'a detached HEAD'}, not ${defaultBranch}`
        : primaryTrackedClean == null
          ? 'the primary checkout’s status could not be read'
          : primaryTrackedClean
            ? null
            : 'the primary checkout has uncommitted changes to tracked files';
    if (where != null) {
      return {
        kind: 'block',
        reason:
          `${defaultBranch} is ${remoteOnly.length} commit(s) behind ${upstream} and ${where}, ` +
          'so the sweep cannot fast-forward it — and will not build on a stale base. ' +
          `Bring ${defaultBranch} up to date (\`git -C ${repo} pull --ff-only\` on ${defaultBranch}), then re-sweep.\n` +
          `      only on ${upstream} (${remoteOnly.length}):\n${formatCommitList(remoteOnly)}`,
      };
    }
    return {
      kind: 'fast-forward',
      note: `${defaultBranch} was ${remoteOnly.length} commit(s) behind ${upstream} — fast-forwarded before branching`,
      upstreamSha: comparison.upstreamSha,
    };
  }
  if (localOnly.length > 0) {
    return {
      kind: 'proceed',
      note: `${defaultBranch} is ${localOnly.length} commit(s) ahead of ${upstream} — the push will publish them too`,
    };
  }
  return {kind: 'proceed', note: null};
}

/**
 * `git config --get`, keeping "unset" (exit 1) apart from "git failed" (any
 * other exit) — `git()` folds both into null, and here one means "no upstream,
 * proceed" while the other means "could not tell" (rule 7).
 */
function gitConfigValue(
  repo: string,
  key: string,
): {kind: 'error'} | {kind: 'unset'} | {kind: 'value'; value: string} {
  const child = spawnSync('git', ['-C', repo, 'config', '--get', key], {
    encoding: 'utf-8',
  });
  if (child.status === 0) return {kind: 'value', value: child.stdout.trim()};
  if (child.status === 1) return {kind: 'unset'};
  return {kind: 'error'};
}

/**
 * Fetch the default branch's upstream (unless `fetch` is false — a dry run
 * writes nothing, so it compares against the LAST fetch and says so), then
 * compare the two refs.
 */
export function compareWithUpstream(
  repo: string,
  defaultBranch: string,
  options: {fetch: boolean},
): UpstreamComparison {
  const remote = gitConfigValue(repo, `branch.${defaultBranch}.remote`);
  if (remote.kind === 'error') {
    return {
      detail: `\`git config branch.${defaultBranch}.remote\` failed`,
      kind: 'unknown',
      output: null,
    };
  }
  if (remote.kind === 'unset') {
    return {
      detail: `${defaultBranch} tracks no upstream — nothing fetched`,
      kind: 'no-upstream',
    };
  }
  // `.` is a LOCAL upstream: nothing to fetch, but still worth comparing.
  if (options.fetch && remote.value !== '.') {
    const fetched = run(
      ['git', '-C', repo, 'fetch', '--quiet', remote.value],
      repo,
      {quiet: true},
    );
    if (fetched.exitCode !== 0 || fetched.error != null) {
      return {
        detail: `\`git fetch ${remote.value}\` failed (${fetched.error ?? `exit ${fetched.exitCode}`})`,
        kind: 'unknown',
        output: fetched.output,
      };
    }
  }
  const asOf = options.fetch
    ? ''
    : ' (as of the last fetch — a dry run does not fetch)';
  const upstream = git(repo, [
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    `${defaultBranch}@{upstream}`,
  ]);
  const upstreamSha = git(repo, [
    'rev-parse',
    '--verify',
    '--quiet',
    `${defaultBranch}@{upstream}`,
  ]);
  const localSha = git(repo, [
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/heads/${defaultBranch}`,
  ]);
  if (upstream == null || upstreamSha == null || localSha == null) {
    return {
      detail: `${defaultBranch}'s upstream is configured but does not resolve${asOf}`,
      kind: 'unknown',
      output: null,
    };
  }
  const localOnly = commitsBeyond(repo, upstreamSha, localSha);
  const remoteOnly = commitsBeyond(repo, localSha, upstreamSha);
  if (localOnly == null || remoteOnly == null) {
    return {
      detail: `could not list the commits between ${defaultBranch} and ${upstream}`,
      kind: 'unknown',
      output: null,
    };
  }
  return {
    kind: 'compared',
    localOnly,
    remoteOnly,
    upstream: `${upstream}${asOf}`,
    upstreamSha,
  };
}

/**
 * Tracked changes in the primary (`--untracked-files=no`), or null when the
 * status could not be read — never `[]` for "could not look".
 */
function trackedChanges(repo: string): string[] | null {
  try {
    const out = execFileSync(
      'git',
      ['-C', repo, 'status', '--porcelain', '--untracked-files=no'],
      {encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe']},
    );
    return parsePorcelainPaths(out);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The post-merge install in the primary — home-base-bgfl
// ---------------------------------------------------------------------------

/**
 * The FROZEN install for each manager. Frozen is the whole point: the lockfile
 * the sweep just committed is the thing being propagated, so this step must
 * never be able to rewrite it — a mismatch fails loudly instead.
 */
const FROZEN_INSTALL: Record<PackageManager, readonly string[]> = {
  bun: ['bun', 'install', '--frozen-lockfile'],
  npm: ['npm', 'ci'],
  yarn: ['yarn', 'install', '--frozen-lockfile'],
};

/** The files whose change means the primary's node_modules is now stale. */
const INSTALL_TRIGGERS: Record<PackageManager, readonly string[]> = {
  bun: ['package.json', 'bun.lock', 'bun.lockb'],
  npm: ['package.json', 'package-lock.json'],
  yarn: ['package.json', 'yarn.lock'],
};

/** The frozen recipe for `packageManager`, or null when there is none. Pure. */
export function frozenInstallRecipe(
  packageManager: PackageManager | null,
): string[] | null {
  if (packageManager == null) return null;
  const recipe = FROZEN_INSTALL[packageManager];
  return recipe == null ? null : [...recipe];
}

export type PrimaryInstallPlan =
  | {argv: string[]; kind: 'run'}
  | {kind: 'skip'; reason: string};

/**
 * Should the sweep install in the PRIMARY after its merge, and with what? A
 * pure decision over three measurements, so it is unit-testable (D2):
 *
 *   changedFiles   — what the sweep's own commit touched. A component-only run
 *                    that changed neither package.json nor the lockfile leaves
 *                    node_modules perfectly valid, so it installs nothing.
 *   dirtyPaths     — `git status --porcelain` of the primary AFTER the merge.
 *                    Belt and braces over mergeSafety, and cheap: a locally
 *                    modified manifest or lockfile is someone's work in
 *                    progress, and a frozen install against it either fails
 *                    confusingly or installs something nobody asked for.
 *   packageManager — from the primary's own lockfile (detectPackageManager).
 *
 * A skip ALWAYS names its reason (rule 6: silence must be a claim) — "no
 * install ran" and "no install was needed" are different facts, and the summary
 * line has to say which one happened.
 *
 * STATED LIMITATION: the decision cannot see whether a lockfile exists, only
 * what changed and what is dirty. `detectPackageManager` answers `bun` for a
 * package.json with NO lockfile at all, and a frozen install there fails. That
 * shape is not reachable in the fleet — the sweep's own hydration installs in
 * the worktree, so a lockfile exists and is committed by the time this runs —
 * and if it ever is reached it fails LOUDLY as `install-failed` rather than
 * quietly claiming success.
 */
export function planPrimaryInstall(input: {
  changedFiles: readonly string[];
  dirtyPaths: readonly string[];
  packageManager: PackageManager | null;
}): PrimaryInstallPlan {
  const {changedFiles, dirtyPaths, packageManager} = input;
  const argv = frozenInstallRecipe(packageManager);
  if (packageManager == null || argv == null) {
    return {
      kind: 'skip',
      reason: `no frozen install recipe for ${packageManager ?? 'an undetectable package manager'}`,
    };
  }
  const triggers = INSTALL_TRIGGERS[packageManager];
  const changed = triggers.filter((file) => changedFiles.includes(file));
  if (changed.length === 0) {
    return {
      kind: 'skip',
      reason: `the sweep changed none of ${triggers.join(', ')}, so node_modules is still valid`,
    };
  }
  const dirty = triggers.filter((file) => dirtyPaths.includes(file));
  if (dirty.length > 0) {
    return {
      kind: 'skip',
      reason: `locally dirty in the primary: ${dirty.join(', ')} — run \`${argv.join(' ')}\` there once that is resolved`,
    };
  }
  return {argv, kind: 'run'};
}

interface PrimaryInstallResult {
  /** What ran (or would have), so the operator can repeat it by hand. */
  argv: string[] | null;
  /** The clause appended to this repo's summary line. Never empty. */
  note: string;
  /** false ONLY when an install really ran and really went red. */
  ok: boolean;
  /** A failed install's stdout+stderr, for the run log. null when none ran. */
  output: string | null;
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

/**
 * Decide, then (maybe) install, in the PRIMARY checkout after its merge —
 * home-base-bgfl. The effectful half; `planPrimaryInstall` is the decision.
 *
 * The primary's working tree is measured before and after and NEVER reverted:
 * anything the install leaves dirty is named on the summary line and left for
 * its owner. An unreadable `git status` is reported as unknown rather than
 * silently read as clean (rule 6) — and it makes the install a skip, because
 * "nothing is dirty" is exactly the claim that could not be checked.
 */
export function installInPrimary(
  repo: string,
  changedFiles: readonly string[],
): PrimaryInstallResult {
  const detection = detectPackageManager(repo);
  const before = gitPorcelain(repo);
  if (before == null) {
    return {
      argv: frozenInstallRecipe(detection.packageManager),
      note: ', primary install skipped: `git status --porcelain` of the primary could not be read, so "nothing is dirty" is UNVERIFIED',
      ok: true,
      output: null,
    };
  }
  const beforePaths = parsePorcelainPaths(before);
  const plan = planPrimaryInstall({
    changedFiles,
    dirtyPaths: beforePaths,
    packageManager: detection.packageManager,
  });
  if (plan.kind === 'skip') {
    // The DETECTION's own basis is only worth printing when detection is what
    // ruled the install out; otherwise it is noise on every green line.
    const basis =
      detection.packageManager == null ? ` (${detection.reason})` : '';
    return {
      argv: frozenInstallRecipe(detection.packageManager),
      note: `, primary install skipped: ${plan.reason}${basis}`,
      ok: true,
      output: null,
    };
  }

  const installed = run(plan.argv, repo, {quiet: true});
  const after = gitPorcelain(repo);
  let dirtNote = '';
  if (after == null) {
    dirtNote =
      ' [could not re-read `git status --porcelain` after the install — whether it left the primary dirty is UNKNOWN]';
  } else {
    const appeared = parsePorcelainPaths(after).filter(
      (path) => !beforePaths.includes(path),
    );
    if (appeared.length > 0) {
      dirtNote = ` [the install left these dirty in the primary and NOTHING was reverted: ${appeared.join(', ')}]`;
    }
  }

  if (installed.exitCode !== 0 || installed.error != null) {
    return {
      argv: plan.argv,
      note:
        `, PRIMARY INSTALL FAILED (${installed.error ?? `exit ${installed.exitCode}`}) — ` +
        `the primary still executes the OLD SDK; run \`${plan.argv.join(' ')}\` in ${repo} by hand${dirtNote}`,
      ok: false,
      output: installed.output,
    };
  }
  return {
    argv: plan.argv,
    note: `, primary installed${dirtNote}`,
    ok: true,
    output: null,
  };
}

/**
 * The dry-run's advisory line about the post-merge install (D5). It cannot know
 * what the real run will change, so it states the CONDITION rather than a
 * verdict — and it names the absence of a recipe, which is the case where a
 * real run would merge and then leave node_modules stale.
 */
function dryRunInstallNote(repo: string): string {
  const detection = detectPackageManager(repo);
  const recipe = frozenInstallRecipe(detection.packageManager);
  return recipe == null
    ? ` — and would NOT install in the primary: no frozen install recipe (${detection.reason})`
    : ` — would then \`${recipe.join(' ')}\` in the primary, if package.json or the lockfile change`;
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
  | {component: ComponentName; mode: 'component'}
  | {mode: 'install'};

/**
 * `--component install` is not a component — it is the ENROLLMENT REFRESH
 * payload (dchjw.10 SWEEP SEMANTICS): adopt what is installed, delete the dead
 * config keys, bump the pin, then `install` with removals DISABLED. It shares
 * `--component` because that option already answers "which payload", and no
 * component is or ever will be called `install`.
 */
export const INSTALL_PAYLOAD_OPTION = 'install';

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
): {component: ComponentName | null; ok: true} | {error: string; ok: false} {
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

/**
 * Parse `--component`, which selects the PAYLOAD: a component name, the
 * `install` enrollment refresh, or (absent) the historical full sweep.
 *
 * Kept as a thin layer over `parseComponentOption` so the component vocabulary
 * has exactly one validator.
 */
export function parseSweepPayloadOption(
  raw: string | undefined,
): {ok: true; payload: SweepPayload} | {error: string; ok: false} {
  if (raw?.trim() === INSTALL_PAYLOAD_OPTION) {
    return {ok: true, payload: {mode: 'install'}};
  }
  const parsed = parseComponentOption(raw);
  if (!parsed.ok) {
    return {
      error: `${parsed.error}, or "${INSTALL_PAYLOAD_OPTION}" for the enrollment-refresh payload`,
      ok: false,
    };
  }
  return {ok: true, payload: planSweepPayload(parsed.component)};
}

/** The one commit a swept repo gets. Names the component when scoped. */
export function sweepCommitMessage(payload: SweepPayload): string {
  if (payload.mode === 'install') {
    return (
      'chore(sdk): sweep install — adopt installed components, drop dead config keys, ' +
      'bump the SDK pin, re-apply (no removals; automated, home-base-dchjw)'
    );
  }
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
): {ok: true} | {offenders: string[]; ok: false; reason: string} {
  // Every payload EXCEPT a deliberate `--component beads`. The install payload
  // (dchjw.10) re-applies whatever the repo has, unattended, across the fleet —
  // if that reaches `.beads/config.yaml` it is the same accident this guard was
  // written for, not an instruction.
  if (payload.mode === 'component') return {ok: true};
  const offenders = changedFiles.filter(
    (file) =>
      file === '.beads/config.yaml' || file.endsWith('/.beads/config.yaml'),
  );
  if (offenders.length === 0) return {ok: true};
  return {
    offenders,
    ok: false,
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
      // The generated artifact, the claudeMdExcludes entry enrollment writes
      // (anhw half A), and justin-sdk.config.json — which no longer carries a
      // module selection (epic home-base-dchjw D2 deleted it) but is still
      // written by the base-setup chain, and is what dchjw.10's sweep DELETES
      // the retired `componentConfig["critical-rules"].modules` block from.
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

/**
 * Split a component sweep's staged files into the ones that component owns and
 * the ones it does not (home-base-926v).
 *
 * WHY THIS EXISTS. The sweep gates each worktree with `bun run justin-sdk
 * doctor --fix`, and
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
  | {present: true; reason: string; safe: boolean};

/**
 * May the sweep delete the leftover worktree/branch it found, or must it keep
 * it? (ckc4 F5; 39co9.6 S2/S3.) A kept leftover no longer blocks the repo — each
 * run has its own name — it is listed in the summary and the log instead.
 *
 * WHY AUTO-CLEAN AT ALL: the seven leftovers that had accumulated by 2026-09-04
 * all held nothing — zero commits, and at most a regenerable rules file — and
 * an empty leftover is pure litter. "Resolve it by hand" is a chore nobody does.
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
    registered && !directory
      ? 'worktree registration (directory already gone)'
      : null,
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
 * Every earlier sweep's worktree or branch still present in `repo`, by NAME
 * (39co9.6 S2). Three places are read, because each can survive without the
 * others: registered worktrees, `refs/heads/worktree-<name>` branches, and
 * directories under `.claude/worktrees/` git no longer knows about.
 *
 * `ok: false` when any of the three could not be read — "could not look" is
 * never reported as "no leftovers" (rule 7). Sorted: stamps sort by time, and
 * the legacy fixed name sorts first.
 */
export type SweepLeftoverScan =
  | {names: string[]; ok: true}
  | {ok: false; reason: string};

export function findSweepLeftoverNames(repo: string): SweepLeftoverScan {
  const names = new Set<string>();

  const porcelain = git(repo, ['worktree', 'list', '--porcelain']);
  if (porcelain == null) {
    return {ok: false, reason: '`git worktree list --porcelain` failed'};
  }
  const suffix = `/${SWEEP_WORKTREES_DIR.join('/')}/`;
  for (const path of parseWorktreePaths(porcelain)) {
    const at = path.lastIndexOf(suffix);
    if (at < 0) continue;
    const name = path.slice(at + suffix.length);
    if (isSweepWorktreeName(name)) names.add(name);
  }

  const refs = git(repo, [
    'for-each-ref',
    '--format=%(refname)',
    'refs/heads/',
  ]);
  if (refs == null) {
    return {ok: false, reason: '`git for-each-ref refs/heads/` failed'};
  }
  for (const ref of refs.split('\n')) {
    const branch = ref.replace(/^refs\/heads\//, '');
    if (!branch.startsWith('worktree-')) continue;
    const name = branch.slice('worktree-'.length);
    if (isSweepWorktreeName(name)) names.add(name);
  }

  const dir = join(repo, ...SWEEP_WORKTREES_DIR);
  if (existsSync(dir)) {
    try {
      for (const entry of readdirSync(dir)) {
        if (isSweepWorktreeName(entry)) names.add(entry);
      }
    } catch (error) {
      return {
        ok: false,
        reason: `could not list ${dir}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  return {names: [...names].sort(), ok: true};
}

/** One earlier run's leftover, as this run dealt with it. */
export interface LeftoverReport {
  /** removed = gone now; would-remove = dry run; kept = still present, on purpose. */
  action: 'kept' | 'removed' | 'would-remove';
  branch: string;
  /**
   * `git log --oneline` of what it holds beyond the default branch (branch and
   * worktree HEAD, deduplicated). null = could not be listed, which is not the
   * same as none. Empty for anything removed.
   */
  commits: string[] | null;
  /** Commands that show exactly what it holds. Empty for anything removed. */
  inspect: string[];
  name: string;
  reason: string;
  worktreePath: string;
}

/** What one repo's leftover scan found, or why it could not look. */
export type LeftoverScanReport =
  | {items: LeftoverReport[]; kind: 'scanned'}
  | {kind: 'failed'; reason: string}
  /** The repo was refused before the scan (not a repo, no default branch). */
  | {kind: 'not-scanned'};

/** `git log --oneline` of `<defaultBranch>..<ref>`, or null when git cannot say. */
function commitsBeyond(
  cwd: string,
  defaultBranch: string,
  ref: string,
): string[] | null {
  const out = git(cwd, [
    'log',
    '--oneline',
    '--no-decorate',
    `${defaultBranch}..${ref}`,
  ]);
  return out == null ? null : out.split('\n').filter((line) => line !== '');
}

/**
 * Find every earlier sweep's leftover in `repo`, auto-remove the provably empty
 * ones (as before), and KEEP and describe the rest (S2/S3). Never blocks: each
 * run has its own name, so nothing found here can collide with this run.
 *
 * Kept means kept: the only removal path is `cleanupWorktreeAndBranch` on a
 * leftover `assessSweepLeftover` called safe — so a leftover holding a commit
 * the default branch lacks is never deleted (S3).
 */
export function handleSweepLeftovers(
  repo: string,
  defaultBranch: string,
  allowedPaths: readonly string[],
  options: {dryRun: boolean},
): LeftoverScanReport {
  const scan = findSweepLeftoverNames(repo);
  if (!scan.ok) return {kind: 'failed', reason: scan.reason};

  const items: LeftoverReport[] = [];
  for (const name of scan.names) {
    const worktreePath = join(repo, ...SWEEP_WORKTREES_DIR, name);
    const branch = sweepBranchFor(name);
    const assessment = assessSweepLeftover(
      repo,
      worktreePath,
      branch,
      defaultBranch,
      allowedPaths,
    );
    if (!assessment.present) continue;
    const base = {branch, name, worktreePath};

    if (assessment.safe) {
      if (options.dryRun) {
        items.push({
          ...base,
          action: 'would-remove',
          commits: [],
          inspect: [],
          reason: assessment.reason,
        });
        continue;
      }
      const cleaned = cleanupWorktreeAndBranch(repo, worktreePath, branch);
      if (cleaned.ok) {
        items.push({
          ...base,
          action: 'removed',
          commits: [],
          inspect: [],
          reason: assessment.reason,
        });
        continue;
      }
      // Provably empty but not removable: kept, and said so — it no longer
      // blocks anything, so it is news rather than a refusal.
      items.push({
        ...base,
        action: 'kept',
        commits: [],
        inspect: inspectCommands(repo, defaultBranch, worktreePath, branch),
        reason: `${assessment.reason}, but it could not be removed — ${cleaned.detail}`,
      });
      continue;
    }

    items.push({
      ...base,
      action: 'kept',
      commits: leftoverCommits(repo, defaultBranch, worktreePath, branch),
      inspect: inspectCommands(repo, defaultBranch, worktreePath, branch),
      reason: assessment.reason,
    });
  }
  return {items, kind: 'scanned'};
}

/** The commits a kept leftover holds beyond the default branch, deduplicated. */
function leftoverCommits(
  repo: string,
  defaultBranch: string,
  worktreePath: string,
  branch: string,
): string[] | null {
  const lists: (string[] | null)[] = [];
  if (
    gitOk(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
  ) {
    lists.push(commitsBeyond(repo, defaultBranch, `refs/heads/${branch}`));
  }
  if (isWorktreeRegistered(repo, worktreePath) && existsSync(worktreePath)) {
    lists.push(commitsBeyond(worktreePath, defaultBranch, 'HEAD'));
  }
  if (lists.some((list) => list == null)) return null;
  return [...new Set(lists.flatMap((list) => list ?? []))];
}

/** The exact commands that show what a kept leftover holds. */
function inspectCommands(
  repo: string,
  defaultBranch: string,
  worktreePath: string,
  branch: string,
): string[] {
  const commands: string[] = [];
  if (
    gitOk(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
  ) {
    commands.push(`git -C ${repo} log --stat ${defaultBranch}..${branch}`);
  }
  if (existsSync(worktreePath)) {
    commands.push(`git -C ${worktreePath} status --short`);
  }
  return commands;
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
): {excluded: string[]; staged: string[]} {
  const readStaged = (): string[] => {
    const out = git(worktreePath, ['diff', '--cached', '--name-only']);
    return out == null ? [] : out.split('\n').filter((line) => line !== '');
  };

  git(worktreePath, ['add', '-A']);
  const scope = partitionByComponentContract(payload, readStaged());
  if (scope.outOfScope.length === 0)
    return {excluded: [], staged: scope.inScope};

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

export type ConfigComponents =
  | {components: string[]; ok: true; source: 'config' | 'core'}
  | {ok: false; reason: string};

/**
 * Components declared by a justin-sdk.config.json's raw text.
 *
 * AN ABSENT `components` KEY MEANS `core`, NOT NOTHING (dchjw.17 F3). It used
 * to return an empty list here, and the one caller asks "is this repo enrolled
 * in component X" — so every repo enrolled by the current `init`, which writes
 * no `components` key at all, answered "no" and was skipped by every
 * component-scoped sweep. That is rule 6's reassuring direction: an absent key
 * is the DEFAULT, and reading a default as an absence quietly excluded repos
 * from fleet work while the run reported a clean skip.
 *
 * `ok: false` stays reserved for content we could not read — an empty list now
 * means "read it, and it explicitly lists none".
 *
 * `projectRoot` is needed because `core` is computed per repo (eas only in an
 * Expo app). It is the repo's working tree while the JSON came from a commit,
 * so a predicate could in principle disagree with the commit being swept; that
 * is the same approximation `list` and `install` make, and the alternative is
 * materializing the tree to answer a scoping question.
 */
export function parseConfigComponents(
  json: string,
  projectRoot: string,
): ConfigComponents {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {ok: false, reason: 'justin-sdk.config.json is not valid JSON'};
  }
  if (typeof parsed !== 'object' || parsed == null) {
    return {ok: false, reason: 'justin-sdk.config.json is not a JSON object'};
  }
  const resolved = resolveComponents(parsed, projectRoot);
  if (!resolved.ok) return {ok: false, reason: resolved.reason};
  return {
    components: [...resolved.components],
    ok: true,
    source: resolved.source,
  };
}

/**
 * The components declared by the config AS COMMITTED ON `branch` — read with
 * `git show`, not off the working tree, because the sweep branches from that
 * exact commit. Reading the primary's working copy could disagree (dirty
 * checkout, different branch) and decide enrollment from a tree that is not
 * the one being swept.
 */
/**
 * Two states, on purpose. There is no benign "not enrolled" here: a repo the
 * sweep was asked to sweep and whose enrollment it could not read on the branch
 * is a repo this run FAILED to sweep, and has to be counted as one (ckc4 F4).
 * The `reason` distinguishes the three ways that happens — nothing committed,
 * committed but corrupt, git could not answer — without letting any of them
 * become a quiet skip.
 */
export type CommittedEnrollment =
  | {components: string[]; kind: 'enrolled'; source: 'config' | 'core'}
  | {kind: 'unreadable'; reason: string};

export function committedConfigComponents(
  repo: string,
  branch: string,
): CommittedEnrollment {
  // Presence first, and separately, so "the file is not there" (a repo that is
  // simply not enrolled — a visible skip) is never confused with "git could not
  // answer" (a repo this run FAILED to sweep). `git show` collapses both into
  // one non-zero exit (dchjw.17 F3, critical rule 6).
  const listed = git(repo, [
    'ls-tree',
    '--name-only',
    `refs/heads/${branch}`,
    '--',
    'justin-sdk.config.json',
  ]);
  if (listed == null) {
    return {
      kind: 'unreadable',
      reason: `git ls-tree failed on ${branch} — cannot tell whether justin-sdk.config.json is committed there`,
    };
  }
  if (listed.trim() === '') {
    return {
      kind: 'unreadable',
      reason: existsSync(join(repo, 'justin-sdk.config.json'))
        ? `justin-sdk.config.json is not committed on ${branch} — the working tree has one, but the sweep branches from the commit`
        : `justin-sdk.config.json is not committed on ${branch}`,
    };
  }

  const shown = git(repo, [
    'show',
    `refs/heads/${branch}:justin-sdk.config.json`,
  ]);
  if (shown == null) {
    return {
      kind: 'unreadable',
      reason: `justin-sdk.config.json is committed on ${branch} but could not be read`,
    };
  }
  const parsed = parseConfigComponents(shown, repo);
  if (!parsed.ok) return {kind: 'unreadable', reason: parsed.reason};
  return {
    components: parsed.components,
    kind: 'enrolled',
    source: parsed.source,
  };
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
 * `runBaseSetup`, whose stepDepsHasSdk adds the pin to package.json when
 * absent. Run in-process from the orchestrator, that would stamp the
 * orchestrator's version into a repo whose package.json still pins an older
 * one — a config that LIES about the installed SDK. So the component-mode
 * payload snapshots these fields and puts them back.
 *
 * The two justin-sdk.config.json stamps were in this list until D3 deleted them
 * from the schema; base-setup no longer writes either, so there is nothing left
 * there to restore.
 */
interface PinField {
  file: string;
  key: string;
  /** Containing object path; [] = top level. */
  parents: readonly string[];
}

const PIN_FIELDS: readonly PinField[] = [
  {file: 'package.json', key: SDK_PKG, parents: ['dependencies']},
  {file: 'package.json', key: SDK_PKG, parents: ['devDependencies']},
];

interface PinFieldValue {
  /** Did its containing object exist? (Absent parent must not be left as {}.) */
  parentPresent: boolean;
  /** Did the field itself exist? */
  present: boolean;
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
 * the fields it had to restore — in component mode that list is the visible
 * evidence the neutrality guard did its job, and an EMPTY one is now the
 * ordinary case: base-setup stopped stamping justin-sdk.config.json, so only a
 * package.json pin the payload actually added shows up here.
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
 * `doctor --fix` gate's fixCommands are `bun run justin-sdk add <component>`,
 * and every installer chains base-setup, whose stepDepsHasSdk writes the
 * package.json pin when it is absent. Measured direction of the damage: those
 * subprocesses resolve the TARGET's own pinned SDK, so the orchestrator's
 * version cannot leak in — but a write is still a write, and it would land in
 * the sweep's single commit, in a run whose entire contract is "the pin did not
 * move". (The justin-sdk.config.json half of this hazard is gone with D3: its
 * two SDK-version stamps are no longer written by anything.)
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
  | {declared: ReadonlyMap<DepSection, string>; ok: true}
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
  | {reason: string; satisfied: true}
  | {satisfied: false};

export function sdkWorkspaceSatisfaction(
  root: string,
  declared: ReadonlyMap<DepSection, string>,
): WorkspaceSatisfaction {
  for (const section of SDK_DEP_SECTIONS) {
    const spec = declared.get(section);
    if (spec?.startsWith('workspace:') === true) {
      return {reason: `${section}.${SDK_PKG} is "${spec}"`, satisfied: true};
    }
  }
  const pkg = readJsonObject(join(root, 'package.json'));
  if (pkg == null) return {satisfied: false};
  for (const pattern of workspacePatternsOf(pkg)) {
    for (const dir of expandWorkspacePattern(root, pattern)) {
      const member = readJsonObject(join(dir, 'package.json'));
      if (member?.name === SDK_PKG) {
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
 * name appearing inside a script alias (`justin-sdk doctor`), which carries no closing quote and colon.
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
  const [section, spec] = entries[0]!;
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
  | {detail: string; status: 'refreshed' | 'current' | 'dry-run'}
  | {detail: string; status: 'failed'};

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
      note: string;
      ok: true;
      /**
       * A short phrase that must survive into the repo's SUMMARY line, not just
       * the inline chatter — reserved for payload facts an operator would
       * misread the run without ("the pin was not written"). Absent for the
       * ordinary case, so the common summary line stays unchanged.
       */
      summaryNote?: string;
    }
  | {detail: string; ok: false};

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

/** The pin this SDK would write: its own version, as a published tag. */
function defaultSweepPin(): string | null {
  const version = getSdkVersion();
  return version == null ? null : `github:justinhaaheim/justin-sdk#v${version}`;
}

/**
 * Check the tag behind a `github:` pin against the remote. Anything that is not
 * a `github:…#tag` spec (a `file:` fixture pin) is not a tag question at all.
 */
function verifySweepPinTag(
  pin: string,
  repoUrl: string | undefined,
): {refuse: false} | {detail: string; refuse: true} {
  const tag = /^github:justinhaaheim\/justin-sdk#(.+)$/.exec(pin)?.[1];
  if (tag == null) return {refuse: false};
  const published = sdkTagExistsOnRemote(tag, {repoUrl});
  if (published.status === 'ok' && !published.exists) {
    return {
      detail:
        `${repoUrl ?? 'the SDK remote'} has no tag ${tag}, so pinning the fleet to it would give every repo an install that 404s ` +
        '(home-base-l9tz at fleet scale). Publish the release first — nothing was written.',
      refuse: true,
    };
  }
  if (published.status === 'failed') {
    say(
      `  ${YELLOW}⚠${RESET} could not verify tag ${tag} on the remote (${published.error}) — pinning anyway, UNVERIFIED`,
    );
  }
  return {refuse: false};
}

/**
 * The ENROLLMENT REFRESH payload (dchjw.10 SWEEP SEMANTICS), in order:
 *
 *   1. ADOPT installed-but-unlisted components into justin-sdk.config.json.
 *   2. DELETE the dead keys (`version`, `lastSynced`, the retired rules
 *      `modules` include-list).
 *   3. BUMP the SDK pin to this release — the tag verified on the remote first,
 *      because pinning twelve repos to a tag that was never pushed gives all of
 *      them a `bun install` that 404s (home-base-l9tz, at fleet scale).
 *   4. `install` with REMOVALS DISABLED, which rewrites the D1 script/hook
 *      spellings and regenerates the rules artifact from the registry.
 *
 * Steps 1 and 3 are in the SAME run on purpose: a repo whose `modules` block is
 * gone but whose pin is old reads as not-enrolled to its own rules check, so
 * that window must be one run rather than one release.
 *
 * NOTHING IS EVER REMOVED. See sweep-install.ts for why that is the rule and
 * not a timidity.
 */
async function applyInstallSweepPayload(
  worktree: string,
  options: {pin?: string; sdkRepoUrl?: string},
): Promise<PayloadOutcome> {
  const config = applyInstallPayloadConfig(worktree);
  if ('error' in config) {
    return {
      detail: `${config.error} — worktree left for inspection`,
      ok: false,
    };
  }

  const pin = options.pin ?? defaultSweepPin();
  if (pin == null) {
    return {
      detail:
        'the running SDK could not read its own package.json, so it cannot pin the fleet to itself — refusing rather than writing an unresolvable ref (D4, critical rule 6)',
      ok: false,
    };
  }
  // A CONFIRMED-ABSENT tag refuses. Could-not-ask is a third state and is
  // reported, not refused: an unreachable remote must not make the whole fleet
  // unsweepable, and the pin is the same one this SDK is running from.
  const tagNote = verifySweepPinTag(pin, options.sdkRepoUrl);
  if (tagNote.refuse) return {detail: tagNote.detail, ok: false};

  const pinWrite = writeSdkPin(worktree, pin);
  if (!pinWrite.ok) return pinWrite;

  let exitCode: number;
  try {
    // No `prune`, here or anywhere in the sweep: install does not remove by
    // default (dchjw.17 F1), and a sweep is the one caller that must never be
    // the thing that discovers an exception (dchjw.17 F2).
    exitCode = await runInstall({
      projectRoot: worktree,
      quiet: true,
    });
  } catch (error) {
    return {
      detail: `install threw: ${
        error instanceof Error ? error.message : String(error)
      } — worktree left for inspection`,
      ok: false,
    };
  }
  if (exitCode !== 0) {
    return {
      detail: `install failed (exit ${exitCode}) — worktree left for inspection`,
      ok: false,
    };
  }

  const notes = [
    config.adopted.length > 0
      ? `adopted ${config.adopted.join(', ')}`
      : 'adopted nothing',
    config.dropped.length > 0
      ? `dropped ${config.dropped.join(', ')}`
      : 'no dead keys',
    pinWrite.note,
    'installed (removals disabled)',
    // Carried into the run note, not just the dry-run plan: a component the
    // sweep declined to adopt is a decision waiting for Justin, and a live run
    // is the pass where it would otherwise never be mentioned (dchjw.19).
    ...config.notAdopted.map(noProvenanceLine),
  ];
  return {
    note: notes.join(' · '),
    ok: true,
    ...(config.adopted.length > 0
      ? {summaryNote: `adopted ${config.adopted.length} component(s)`}
      : {}),
  };
}

export function runSweepUpdate(worktree: string): PayloadOutcome {
  // dchjw.15 F2: the worktree's OWN binary, by path. `bun run justin-sdk` here
  // would fall through to the PATH shim on a half-failed install and re-apply
  // the ORCHESTRATOR's components while claiming to have run the target's.
  const sdkBin = resolveWorktreeSdkBin(worktree);
  if (!sdkBin.ok) {
    return {
      detail: `cannot run \`update\`: ${sdkBin.detail} — worktree left for inspection`,
      ok: false,
    };
  }
  const update = run(worktreeSdkArgv(sdkBin.path, SWEEP_UPDATE_ARGS), worktree);
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

/**
 * Apply `payload` to an already-hydrated worktree. Exported because this is
 * the one step `--component` changes, so it is also the step whose pin
 * neutrality has to be provable against a fixture repo without standing up
 * the whole sweep (hydration, the doctor/signal subprocesses, git plumbing).
 */
export async function applySweepPayload(
  worktree: string,
  payload: SweepPayload,
  /**
   * Injection points for the `install` payload, so the fixture test can run the
   * REAL code path offline: `pin` stands in for the published tag (a `file:`
   * spec resolves without a registry) and `sdkRepoUrl` for the remote the tag
   * is verified against (a local bare repo is a real remote to git).
   */
  options: {pin?: string; sdkRepoUrl?: string} = {},
): Promise<PayloadOutcome> {
  if (payload.mode === 'install') {
    return await applyInstallSweepPayload(worktree, options);
  }
  if (payload.mode === 'component') {
    // D11: run the orchestrator's OWN component code in-process. The
    // alternative — `bun run justin-sdk update --component` —
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
  const sdkVersion = getSdkVersion();
  if (sdkVersion == null) {
    return {
      detail:
        'the running SDK could not read its own package.json, so it cannot pin the fleet to itself — refusing rather than writing an unresolvable ref (D4, critical rule 6)',
      ok: false,
    };
  }
  const pinWrite = writeSdkPin(
    worktree,
    `github:justinhaaheim/justin-sdk#v${sdkVersion}`,
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
 * `justin-sdk update` inside the worktree — the second half of the full
 * payload, shared by the pinned and the workspace-satisfied paths so the
 * skip cannot accidentally skip the component re-apply too.
 */
/**
 * The exact flags the sweep gives `update`.
 *
 * `--allow-dirty` because the tree IS dirty by design at this point: the
 * sweep's own pin bump is sitting uncommitted (fourth live-sweep finding —
 * update's dirty guard correctly refused). The sweep makes the one commit
 * itself after the gates.
 *
 * A NAMED CONSTANT so a test can read the whole argv the fleet path runs and
 * assert what is NOT in it — nothing that removes (dchjw.17 F2). An argv built
 * inline is only assertable by spawning twelve repos' worth of sweep.
 */
export const SWEEP_UPDATE_ARGS = [
  'update',
  '--no-self-update',
  '--allow-dirty',
  '--quiet',
] as const;

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
  /** The run log: progress from the start (S4), and every red step's evidence. */
  log: SweepRunLog;
  /** This run's own branch and worktree name (S1). */
  names: SweepRunNames;
  payload: SweepPayload;
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
/**
 * The install payload's per-repo plan, for `--dry-run`. ADVISORY, like
 * `dryRunPinNote`: it reads the PRIMARY checkout, while the real run re-decides
 * inside a worktree branched from the default branch's committed state.
 */
function dryRunInstallPayloadPlan(repo: string): string[] {
  const plan = planInstallPayload(repo);
  if ('error' in plan) return [`plan UNREADABLE (${plan.error})`];
  return [...renderInstallPayloadPlan(plan)];
}

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

/**
 * One repo, start to finish: the steps decide the verdict, and the leftover
 * report the scan produced along the way is attached to it — whatever the
 * verdict, because a kept leftover is news in a failed repo too.
 */
async function sweepOneRepo(
  repo: string,
  context: SweepContext,
): Promise<RepoResult> {
  const scan: {report: LeftoverScanReport} = {report: {kind: 'not-scanned'}};
  const verdict = await sweepRepoSteps(repo, context, scan);
  context.log.note(verdict.repo, `${verdict.outcome} — ${verdict.detail}`);
  return {...verdict, leftovers: scan.report};
}

/** Print (and log) what the leftover scan did, one leftover at a time. */
function reportLeftovers(
  name: string,
  report: LeftoverScanReport,
  log: SweepRunLog,
): void {
  if (report.kind === 'failed') {
    say(
      `  ${YELLOW}⚠${RESET} could not list earlier sweeps' leftovers — ${report.reason}`,
    );
    log.note(name, `leftover scan FAILED — ${report.reason}`);
    return;
  }
  if (report.kind !== 'scanned') return;
  for (const item of report.items) {
    const label =
      item.action === 'removed'
        ? 'auto-removed a leftover from an earlier run'
        : item.action === 'would-remove'
          ? 'would auto-remove a leftover'
          : 'a leftover from an earlier run was left alone';
    say(`  ${YELLOW}⚠${RESET} ${label} (${item.name}) — ${item.reason}`);
    log.note(name, `${label} (${item.name}) — ${item.reason}`);
    for (const line of leftoverDetailLines(item)) {
      say(`    ${line}`);
      log.note(name, `  ${line}`);
    }
  }
}

/** The commits + inspect lines under a KEPT leftover. Empty otherwise. Pure. */
export function leftoverDetailLines(item: LeftoverReport): string[] {
  if (item.action !== 'kept') return [];
  const lines: string[] = [];
  if (item.commits == null) {
    lines.push('commits beyond the default branch: COULD NOT BE LISTED');
  } else if (item.commits.length > 0) {
    lines.push(
      `${item.commits.length} commit(s) beyond the default branch:`,
      ...item.commits.map((commit) => `  ${commit}`),
    );
  }
  for (const command of item.inspect) lines.push(`inspect: ${command}`);
  return lines;
}

async function sweepRepoSteps(
  repo: string,
  context: SweepContext,
  scan: {report: LeftoverScanReport},
): Promise<RepoVerdict> {
  const name = basename(repo);
  const {branch} = context.names;
  const worktreePath = join(repo, ...context.names.worktreeSegments);
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
  ): RepoVerdict => {
    context.log.record({detail, output, repo: name, step});
    if (output != null && output.trim() !== '') {
      say(`  ${RED}✗${RESET} ${step} — last ${FAILURE_TAIL_LINES} lines:`);
      say(tailLines(output));
    }
    let cleanupNote = '';
    if (worktreeCreated) {
      const cleaned = cleanupWorktreeAndBranch(repo, worktreePath, branch);
      cleanupNote = cleaned.ok ? ' [worktree removed]' : ` [${cleaned.detail}]`;
      if (!cleaned.ok) say(`  ${RED}✗${RESET} ${cleaned.detail}`);
    }
    return {
      detail: `${detail}${cleanupNote} — see ${context.log.path}`,
      outcome: 'failed',
      repo: name,
    };
  };

  /** Preflight said this repo cannot be swept at all (ckc4 F4). */
  const blocked = (detail: string): RepoVerdict => ({
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
  // Enrollment (component mode only) — decided from the config as COMMITTED on
  // the branch the sweep will branch from, before anything is created. A repo
  // that does not register the component is out of scope for this run: a
  // visible skip, never a silent one and never a failure.
  //
  // DECIDED here but ACTED ON below the leftover block, because the two answer
  // different questions: enrollment says whether the PAYLOAD applies to this
  // repo, while a leftover is the SWEEP's own litter, whatever the payload.
  // Tidying and reporting it is not payload-scoped, so it happens either way.
  /** Non-null = this repo is out of scope, and this is the line that says so. */
  let notEnrolled: string | null = null;
  if (context.payload.mode === 'component') {
    const {component} = context.payload;
    const declared = committedConfigComponents(repo, defaultBranch);
    if (declared.kind === 'unreadable') {
      // NOT a benign skip: "I could not read the enrollment" is a repo this run
      // failed to sweep, and it has to be counted as one (ckc4 F4).
      return blocked(`cannot read enrollment: ${declared.reason}`);
    }
    if (!isEnrolledIn(declared.components, component)) {
      notEnrolled = `skipped — not enrolled in ${component}${
        declared.source === 'core'
          ? ' (the config lists no components, so it tracks core, which does not include it here)'
          : ''
      }`;
    }
  }

  // --- Leftovers from earlier runs (ckc4 F5; 39co9.6 S2/S3) ----------------
  // NEVER blocking any more: this run's branch and worktree carry its own
  // stamp, so nothing an earlier run left can collide with it. Empty leftovers
  // are removed as before; the rest are KEPT and listed — here, in the log, and
  // under this repo's summary line, each with the command that shows it.
  scan.report = handleSweepLeftovers(
    repo,
    defaultBranch,
    allowedLeftoverPaths(context.payload),
    {dryRun: context.dryRun},
  );
  reportLeftovers(name, scan.report, context.log);
  const wouldRemove =
    scan.report.kind === 'scanned' &&
    scan.report.items.some((item) => item.action === 'would-remove');

  if (notEnrolled != null) {
    return {detail: notEnrolled, outcome: 'skipped', repo: name};
  }

  // --- Fetch first (39co9.6 S5) --------------------------------------------
  // Before anything is created: a base that is behind its upstream is brought
  // up to date (when that is safe), and one that has diverged — or cannot be
  // compared at all — is refused here, with no work done.
  const comparison = compareWithUpstream(repo, defaultBranch, {
    fetch: !context.dryRun,
  });
  const changes = trackedChanges(repo);
  const fresh = planFreshBase({
    comparison,
    defaultBranch,
    primaryBranch: git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    primaryTrackedClean: changes == null ? null : changes.length === 0,
    repo,
  });
  if (fresh.kind === 'block') {
    if (comparison.kind === 'unknown' && comparison.output != null) {
      say(tailLines(comparison.output));
    }
    context.log.note(name, `COULD NOT SWEEP (fetch first) — ${fresh.reason}`);
    return blocked(fresh.reason);
  }
  let freshNote = fresh.note == null ? '' : ` [${fresh.note}]`;
  if (fresh.kind === 'fast-forward') {
    if (context.dryRun) {
      freshNote = ` [would fast-forward first: ${fresh.note}]`;
    } else {
      const forwarded = run(
        ['git', '-C', repo, 'merge', '--ff-only', '--quiet', fresh.upstreamSha],
        repo,
      );
      const nowAt = git(repo, ['rev-parse', `refs/heads/${defaultBranch}`]);
      if (forwarded.exitCode !== 0 || nowAt !== fresh.upstreamSha) {
        context.log.note(name, 'fast-forward to the upstream FAILED');
        return blocked(
          `${fresh.note.replace(/ — fast-forwarded before branching$/, '')}, and the fast-forward FAILED (exit ${forwarded.exitCode}): ${tailLines(forwarded.output, 5)} — nothing was done here`,
        );
      }
    }
  }
  if (freshNote !== '') {
    say(`  ${DIM}${freshNote.trim()}${RESET}`);
    context.log.note(name, freshNote.trim().replace(/^\[|\]$/g, ''));
  }

  if (context.dryRun) {
    return {
      detail:
        (wouldRemove ? 'would auto-remove a leftover, then ' : '') +
        (context.payload.mode === 'component'
          ? `would apply ${context.payload.component} off ${defaultBranch} (pin untouched)`
          : context.payload.mode === 'install'
            ? `would refresh enrollment off ${defaultBranch}${dryRunPinNote(repo)}\n      ${dryRunInstallPayloadPlan(repo).join('\n      ')}`
            : `would sweep off ${defaultBranch}${dryRunPinNote(repo)}`) +
        dryRunInstallNote(repo) +
        freshNote,
      outcome: 'current',
      repo: name,
    };
  }

  // --- Worktree ------------------------------------------------------------
  const baseSha = git(repo, ['rev-parse', `refs/heads/${defaultBranch}`]);
  if (baseSha == null) {
    return fail('resolve-base', `cannot resolve ${defaultBranch}`, null);
  }
  const add = addSweepWorktree(repo, worktreePath, branch, baseSha);
  if (!add.ok) return fail('worktree-add', add.detail, add.output);
  worktreeCreated = true;
  context.log.note(
    name,
    `created worktree ${worktreePath} on branch ${branch} off ${defaultBranch} ${baseSha.slice(0, 12)}`,
  );

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

  // --- Which SDK the gates measure (dchjw.15 F2) ---------------------------
  // Resolved ONCE, before any gate runs, and named in the failure when absent.
  // Both doctor gates and `update` go through this path; nothing in the sweep
  // spawns `bun run justin-sdk` any more, because that resolves to the PATH
  // shim — the orchestrator's SDK — the moment a hydration half-fails.
  const sdkBin = resolveWorktreeSdkBin(worktreePath);
  if (!sdkBin.ok) return fail('sdk-bin', sdkBin.detail, null);

  // --- Baseline (ckc4 F3) --------------------------------------------------
  // Measured on the HYDRATED tree, BEFORE the payload, so the gates below can
  // tell "the payload broke this" from "this tree was never green". Read-only:
  // doctor without --fix, and the repo's own signal, which never writes.
  const doctorBaseline = measureBaseline(
    worktreeSdkArgv(sdkBin.path, ['doctor']),
    worktreePath,
  );
  const signalBaseline = measureBaseline(
    ['bun', 'run', 'signal'],
    worktreePath,
  );
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
    worktreeSdkArgv(sdkBin.path, ['doctor', '--fix']),
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
  const blindNote = blindNotes.length > 0 ? ` [${blindNotes.join('; ')}]` : '';

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
    const cleaned = cleanupWorktreeAndBranch(repo, worktreePath, branch);
    return {
      detail: `already current${freshNote}${payloadNote}${scopeNote}${blindNote}${
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
  // Logged BEFORE the commit runs, as well as after (S4): git writes the
  // commit before its post-commit hook finishes, so a run killed inside the
  // commit step has already made a commit that only this line points at.
  context.log.note(name, `committing on ${branch}: ${changedFiles.join(', ')}`);
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
    return fail(
      'commit',
      `commit failed (exit ${commit.exitCode})`,
      commit.output,
    );
  }
  const sweepSha = git(repo, ['rev-parse', `refs/heads/${branch}`]);
  context.log.note(
    name,
    `committed ${sweepSha?.slice(0, 12) ?? '(sha unreadable)'} on ${branch}: ${changedFiles.join(', ')}`,
  );

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
    // else now cleans up. It FAILS the run (S7): the payload did not reach the
    // default branch, and an exit 0 would say it had.
    return {
      detail: `green + committed on ${branch}${freshNote}${pinGateNote}${payloadNote}${scopeNote}${blindNote}, but merge deferred: ${safety.reason} — worktree + branch KEPT ON PURPOSE (they hold the commit). Merge it by hand once ${defaultBranch} is checked out: \`git -C ${repo} merge --ff-only ${branch}\``,
      outcome: 'merge-pending',
      repo: name,
    };
  }
  const preMergeSha = git(repo, ['rev-parse', `refs/heads/${defaultBranch}`]);
  const merge = run(['git', '-C', repo, 'merge', '--ff-only', branch], repo);
  if (merge.exitCode !== 0) {
    // The second deliberate keep — same reason: the commit lives on that branch.
    return {
      detail: `merge --ff-only failed (diverged?)${payloadNote}${scopeNote}${blindNote} — worktree + branch ${branch} KEPT ON PURPOSE (they hold the commit)`,
      outcome: 'merge-pending',
      repo: name,
    };
  }
  context.log.note(
    name,
    `merged ${branch} into ${defaultBranch} (${preMergeSha?.slice(0, 12) ?? '?'} → ${sweepSha?.slice(0, 12) ?? '?'})`,
  );

  // --- Post-merge install in the primary (home-base-bgfl) ------------------
  // D1: here, immediately after the merge and BEFORE the push. The push does
  // not depend on the install — the commit is correct either way — but the
  // install's verdict IS this repo's verdict, because a repo that still runs
  // the old SDK is not a repo the sweep finished.
  const install = installInPrimary(repo, changedFiles);
  if (!install.ok) {
    context.log.record({
      detail: install.note.replace(/^, /, ''),
      output: install.output,
      repo: name,
      step: 'primary-install',
    });
    if (install.output != null && install.output.trim() !== '') {
      say(
        `  ${RED}✗${RESET} primary-install — last ${FAILURE_TAIL_LINES} lines:`,
      );
      say(tailLines(install.output));
    }
  }

  // --- Push + cleanup ------------------------------------------------------
  // "no remote" is a success (there is nowhere to deliver to). A push that was
  // rejected or failed is a RED STEP (S6/S7): the default branch now holds a
  // commit the remote lacks, which is the browser-automation-central state of
  // 2026-10-05, and it used to be a quiet clause on a green line in a run that
  // exited 0. An unreadable remote list is not "no remote" (rule 7).
  const remotes = git(repo, ['remote']);
  let pushFailure: {detail: string; output: string | null} | null = null;
  let pushNote = 'no remote';
  if (remotes == null) {
    pushFailure = {
      detail:
        '`git remote` failed, so whether this repo needed a push is UNKNOWN',
      output: null,
    };
  } else if (remotes !== '') {
    const push = run(['git', '-C', repo, 'push'], repo);
    if (push.exitCode === 0 && push.error == null) {
      pushNote = 'pushed';
      context.log.note(name, 'pushed');
    } else {
      pushFailure = {
        detail: `\`git push\` failed (${push.error ?? `exit ${push.exitCode}`})`,
        output: push.output,
      };
    }
  }
  const cleaned = cleanupWorktreeAndBranch(repo, worktreePath, branch);
  context.log.note(name, cleaned.detail);
  const cleanupNote = cleaned.ok ? '' : ` [${cleaned.detail}]`;

  if (pushFailure != null) {
    const recovery = pushRecovery({
      defaultBranch,
      preMergeSha,
      repo,
      sweepSha,
    });
    const detail = `merged into ${defaultBranch} LOCALLY, but ${pushFailure.detail}.\n${recovery}`;
    context.log.record({
      detail,
      output: pushFailure.output,
      repo: name,
      step: 'push',
    });
    if (pushFailure.output != null && pushFailure.output.trim() !== '') {
      say(`  ${RED}✗${RESET} push — last ${FAILURE_TAIL_LINES} lines:`);
      say(tailLines(pushFailure.output));
    }
    return {
      detail: `PUSH FAILED — ${detail}${freshNote}${pinGateNote}${payloadNote}${scopeNote}${blindNote}${cleanupNote}${install.note} — see ${context.log.path}`,
      outcome: 'push-failed',
      repo: name,
    };
  }
  return {
    // The install clause goes LAST, after even the cleanup note: it is the
    // answer to "does this repo now RUN the new SDK?", which is the question
    // the whole line exists to answer.
    detail: `updated, merged into ${defaultBranch}, ${pushNote}${freshNote}${pinGateNote}${payloadNote}${scopeNote}${blindNote}${cleanupNote}${install.note}`,
    outcome: install.ok ? 'clean' : 'install-failed',
    repo: name,
  };
}

/**
 * The recovery steps for a push that failed after the local merge (S6). The
 * sweep commit is regenerable — the next sweep makes it again — so dropping it
 * is a real option, not just replaying it. Pure.
 */
export function pushRecovery(input: {
  defaultBranch: string;
  preMergeSha: string | null;
  repo: string;
  sweepSha: string | null;
}): string {
  const {defaultBranch, preMergeSha, repo, sweepSha} = input;
  const commit =
    sweepSha == null
      ? 'the sweep commit'
      : `sweep commit ${sweepSha.slice(0, 12)}`;
  const lines = [
    `      ${defaultBranch} in ${repo} now holds ${commit}, which the remote does not have. Recover with ONE of:`,
    `        replay it onto the remote:  git -C ${repo} pull --rebase  then  git -C ${repo} push`,
  ];
  lines.push(
    preMergeSha == null
      ? `        or drop it and re-sweep:    reset ${defaultBranch} to the commit before the sweep (its sha could not be read), then re-sweep`
      : `        or drop it and re-sweep:    git -C ${repo} reset --keep ${preMergeSha.slice(0, 12)}  then re-sweep`,
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SweepOptions {
  /**
   * Scope the payload to ONE component (short or `-setup` name) and leave the
   * SDK pin alone. Unknown name = the whole run refuses, before any repo is
   * touched. Default (absent) = the historical pin-bump-and-re-apply-all sweep.
   */
  component?: string;
  dryRun?: boolean;
  /** Where the run log goes. Default SWEEP_LOG_DIR. */
  logDir?: string;
  /**
   * The run's start time, which names its log, branch and worktree (S1).
   * Default now. Tests pass it so two runs cannot share a stamp.
   */
  now?: Date;
  /** Explicit repo paths — overrides discovery entirely when non-empty. */
  repos?: string[];
  /** Discovery root. Default ~/Dev. */
  root?: string;
}

/** Every KEPT leftover across the run, as `repo/name` pairs. Pure. */
function keptLeftovers(results: readonly RepoResult[]): string[] {
  return results.flatMap((result) =>
    result.leftovers.kind === 'scanned'
      ? result.leftovers.items
          .filter((item) => item.action === 'kept')
          .map((item) => `${result.repo}/${item.name}`)
      : [],
  );
}

/** The lines printed under a repo's summary line: its kept leftovers. Pure. */
export function summaryLeftoverLines(result: RepoResult): string[] {
  if (result.leftovers.kind === 'failed') {
    return [
      `could not list earlier sweeps' leftovers — ${result.leftovers.reason}`,
    ];
  }
  if (result.leftovers.kind !== 'scanned') return [];
  return result.leftovers.items
    .filter((item) => item.action === 'kept')
    .flatMap((item) => [
      `leftover from an earlier run, KEPT: ${item.name} (branch ${item.branch}) — ${item.reason}`,
      ...leftoverDetailLines(item).map((line) => `  ${line}`),
    ]);
}

export async function runSweep(options: SweepOptions = {}): Promise<number> {
  const parsedPayload = parseSweepPayloadOption(options.component);
  if (!parsedPayload.ok) {
    // Refuse the ENTIRE run: falling through to the default payload on a typo
    // would ship an SDK pin bump to the whole fleet.
    say(`${RED}✗ ${parsedPayload.error}${RESET}`);
    return 1;
  }
  const payload = parsedPayload.payload;

  const root = resolve(options.root ?? join(homedir(), 'Dev'));
  const explicit = (options.repos ?? []).map((repoPath) => resolve(repoPath));
  const repos = explicit.length > 0 ? explicit : discoverSweepRepos(root);
  const dryRun = options.dryRun === true;
  const now = options.now ?? new Date();
  const names = sweepRunNames(sweepRunStamp(now));
  const payloadLabel =
    payload.mode === 'component'
      ? `component ${payload.component} (SDK pin NOT bumped)`
      : payload.mode === 'install'
        ? 'install (enrollment refresh)'
        : 'full (pin bump + re-apply)';

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

  // Announced at the top AND at the bottom (ckc4 F2), and written FROM THE
  // START (S4): the header names this run's branch and worktree, so a run
  // killed mid-way can be matched to whatever it left in a repo.
  const log = createRunLog(options.logDir ?? SWEEP_LOG_DIR, now, {
    header: [
      `payload: ${payload.mode === 'component' ? payload.component : payload.mode}`,
      `branch: ${names.branch}`,
      `worktree: <repo>/${names.worktreeSegments.join('/')}`,
      `repos (${repos.length}): ${repos.join(', ')}`,
    ],
    persist: !dryRun,
  });
  say(
    dryRun
      ? `${DIM}run log: none (a dry run writes nothing) — a real run would write ${log.path}${RESET}`
      : `${DIM}run log: ${log.path}${RESET}`,
  );
  say(
    `${DIM}this run's branch: ${names.branch} (worktree .claude/worktrees/${names.name})${RESET}`,
  );

  const results: RepoResult[] = [];
  for (const repo of repos) {
    results.push(
      await sweepOneRepo(repo, {dryRun, log, names, payload: payload}),
    );
  }

  // D17. Unconditional on the repo results by design (see refreshUserLevelRules):
  // a repo that went red is no reason to leave this machine's own rules stale.
  const userRules = refreshUserLevelRules(payload, {dryRun});

  say(`\n${BOLD}Summary${RESET}`);
  log.note(null, `summary (${payloadLabel}):`);
  const ICON: Record<RepoOutcome, string> = {
    blocked: `${RED}⊘${RESET}`,
    clean: `${GREEN}✓${RESET}`,
    current: `${GREEN}=${RESET}`,
    failed: `${RED}✗${RESET}`,
    'install-failed': `${RED}⚠${RESET}`,
    'merge-pending': `${YELLOW}⏸${RESET}`,
    'push-failed': `${RED}✗${RESET}`,
    skipped: `${DIM}⊘${RESET}`,
  };
  for (const result of results) {
    say(
      `  ${ICON[result.outcome]} ${result.repo} ${DIM}${result.detail}${RESET}`,
    );
    log.note(null, `  ${result.outcome} ${result.repo} ${result.detail}`);
    for (const line of summaryLeftoverLines(result)) {
      say(`      ${YELLOW}${line}${RESET}`);
      log.note(null, `      ${line}`);
    }
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
    log.note(
      null,
      `  user-level rules ${userRules.status}: ${userRules.detail}`,
    );
  }
  const of = (outcome: RepoOutcome): RepoResult[] =>
    results.filter((result) => result.outcome === outcome);
  const failed = of('failed');
  const pending = of('merge-pending');
  const pushFailed = of('push-failed');
  const blocked = of('blocked');
  const skipped = of('skipped');
  const installFailed = of('install-failed');
  const kept = keptLeftovers(results);

  if (failed.length + pending.length + pushFailed.length > 0) {
    const line =
      `${failed.length} failed (worktree removed; evidence in the run log), ` +
      `${pushFailed.length} push-failed (merged locally, NOT pushed — recovery on each line above), ` +
      `${pending.length} merge-pending (worktree kept — it holds the commit). ` +
      'None of these delivered the payload, so the run fails. Fix the CAUSE in the SDK (ratchet contract), then re-sweep.';
    say(`\n${YELLOW}${line}${RESET}`);
    log.note(null, line);
  }
  if (log.recordedFailure()) {
    say(`${YELLOW}failure log: ${log.path}${RESET}`);
  } else if (log.persisted) {
    say(`${DIM}run log: ${log.path}${RESET}`);
  }
  // S2: listed, never blocking, never failing the run on their own — but
  // printed at the tail, because a kept leftover is a commit nobody merged.
  if (kept.length > 0) {
    const line = `${kept.length} leftover(s) from earlier runs KEPT (they hold work the default branch lacks; inspect commands under each repo above): ${kept.join(', ')}`;
    say(`${YELLOW}${line}${RESET}`);
    log.note(null, line);
  }
  // ckc4 F4. Two things that both used to be "skipped" and both used to exit 0:
  // a repo this payload does not apply to (expected), and a repo this run COULD
  // NOT SWEEP (an unreadable enrollment, a diverged or unfetchable default
  // branch, a non-repo). The second is a propagation failure — the fleet is now
  // out of sync and nothing said so — and it is printed LAST, where a long
  // run's tail is actually read.
  if (skipped.length > 0) {
    say(
      `${DIM}${skipped.length} not enrolled in this payload (expected, not a failure): ${skipped
        .map((result) => result.repo)
        .join(', ')}${RESET}`,
    );
  }
  // home-base-bgfl. Printed with the other red tails, because the failure mode
  // it names is precisely the silence-shaped one: the commit landed, the push
  // succeeded, every gate was green — and the repo goes on executing the SDK it
  // had before. Nothing else in this summary would say so.
  if (installFailed.length > 0) {
    say(
      `\n${RED}${installFailed.length} MERGED BUT STILL RUNNING THE OLD SDK (the post-merge install in the primary failed): ${installFailed
        .map((result) => result.repo)
        .join(', ')}${RESET}` +
        `\n${RED}Run the install named on each line above, in that repo, then re-check with doctor.${RESET}`,
    );
  }
  // S6/S7. Its own red tail: the default branch of each of these now holds a
  // commit its remote lacks, which nothing else on screen would make urgent.
  if (pushFailed.length > 0) {
    say(
      `\n${RED}${pushFailed.length} MERGED LOCALLY BUT NOT PUSHED: ${pushFailed
        .map((result) => result.repo)
        .join(', ')}${RESET}` +
        `\n${RED}Each one's default branch holds the sweep commit and its remote does not. Recover with the steps on its line above.${RESET}`,
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
  const exitCode =
    failed.length > 0 ||
    pending.length > 0 ||
    pushFailed.length > 0 ||
    blocked.length > 0 ||
    installFailed.length > 0 ||
    userRules?.status === 'failed'
      ? 1
      : 0;
  log.note(null, `exit ${exitCode}`);
  // A failed user-level refresh is a real failure and must not exit 0 — that
  // would be the silence-shaped kind. It is attributed to its own surface, never
  // to a repo, and the remedy is one command rather than another whole sweep.
  // S7: merge-pending and push-failed fail the run too — each is a repo whose
  // payload did not reach its remote, and "0 failed" over four unpushed repos
  // is exactly the 2026-10-05 report this replaces.
  return exitCode;
}
