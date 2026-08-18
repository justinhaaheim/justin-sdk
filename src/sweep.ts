/**
 * sweep.ts — `justin-sdk sweep`: the fleet propagation orchestrator
 * (home-base-j2n7, decisions of 2026-08-08).
 *
 * WHAT IT DOES, per enrolled repo: fresh worktree off the local default
 * branch → hydrate → `justin-sdk update` (self-update the pin + re-apply components)
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
 * ONE COMMAND, BOTH SURFACES (t6a0.21 D17): a `--component critical-rules` run
 * also refreshes THIS machine's user-level rules file at the end, because that
 * file is still the only channel serving the repos that are not enrolled. It is
 * a payload/summary addition with its own outcome line — not per-repo
 * intelligence, and the ratchet contract still holds.
 */

import {execFileSync, spawnSync} from 'node:child_process';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename, join, resolve} from 'node:path';

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
    ? {detail: `${file} already current (content ${after ?? 'unstamped'})`, status: 'current'}
    : {detail: `${file} refreshed (content ${before ?? 'none'} → ${after ?? 'unstamped'})`, status: 'refreshed'};
}

// ---------------------------------------------------------------------------
// The payload: what actually gets applied inside a hydrated worktree
// ---------------------------------------------------------------------------

export type PayloadOutcome =
  | {ok: true; note: string}
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
  const pin = `github:justinhaaheim/justin-sdk#v${getSdkVersion()}`;
  const {packageManager} = detectPackageManager(worktree);
  const PIN_ARGV: Record<string, string[]> = {
    bun: ['bun', 'add', '-d', pin],
    npm: ['npm', 'install', '--save-dev', pin],
    yarn: ['yarn', 'add', '--dev', pin],
  };
  const pinArgv = PIN_ARGV[packageManager ?? 'bun'];
  if (pinArgv == null) {
    return {
      detail: `no pin recipe for package manager ${String(packageManager)}`,
      ok: false,
    };
  }
  const pinAdd = run(pinArgv, worktree);
  if (pinAdd.exitCode !== 0) {
    return {
      detail: `${pinArgv.slice(0, 2).join(' ')} of ${pin} failed — worktree left for inspection`,
      ok: false,
    };
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
    worktree,
  );
  if (update.exitCode !== 0) {
    return {
      detail: 'justin-sdk update failed — worktree left for inspection',
      ok: false,
    };
  }
  return {note: `pinned ${pin} + re-applied components`, ok: true};
}

// ---------------------------------------------------------------------------
// The per-repo pipeline
// ---------------------------------------------------------------------------

interface SweepContext {
  dryRun: boolean;
  payload: SweepPayload;
}

async function sweepOneRepo(
  repo: string,
  context: SweepContext,
): Promise<RepoResult> {
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
  // Enrollment (component mode only) — decided from the config as COMMITTED on
  // the branch the sweep will branch from, before anything is created. A repo
  // that does not register the component is out of scope for this run: a
  // visible skip, never a silent one and never a failure.
  if (context.payload.mode === 'component') {
    const {component} = context.payload;
    const declared = committedConfigComponents(repo, defaultBranch);
    if (!declared.ok) {
      return {
        detail: `skipped — cannot read enrollment: ${declared.reason}`,
        outcome: 'skipped',
        repo: name,
      };
    }
    if (!isEnrolledIn(declared.components, component)) {
      return {
        detail: `skipped — not enrolled in ${component}`,
        outcome: 'skipped',
        repo: name,
      };
    }
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
      detail:
        context.payload.mode === 'component'
          ? `would apply ${context.payload.component} off ${defaultBranch} (pin untouched)`
          : `would sweep off ${defaultBranch}`,
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

  // --- Payload (pin + update, or one component in-process) -----------------
  const payload = await applySweepPayload(worktreePath, context.payload);
  if (!payload.ok) return fail(payload.detail);
  say(`  ${DIM}${payload.note}${RESET}`);

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
  if (doctor.exitCode !== 0) {
    return fail(
      `doctor red after update — worktree left for inspection${pinGateNote}`,
    );
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
      sweepCommitMessage(context.payload),
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
      detail: `green + committed on ${SWEEP_BRANCH}${pinGateNote}, but merge deferred: ${safety.reason}`,
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
    detail: `updated, merged into ${defaultBranch}, ${pushNote}${pinGateNote}`,
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

  const results: RepoResult[] = [];
  for (const repo of repos) {
    results.push(await sweepOneRepo(repo, {dryRun, payload}));
  }

  // D17. Unconditional on the repo results by design (see refreshUserLevelRules):
  // a repo that went red is no reason to leave this machine's own rules stale.
  const userRules = refreshUserLevelRules(payload, {dryRun});

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
  const failed = results.filter((result) => result.outcome === 'failed').length;
  const pending = results.filter(
    (result) => result.outcome === 'merge-pending',
  ).length;
  if (failed + pending > 0) {
    say(
      `\n${YELLOW}${failed} failed, ${pending} merge-pending — each left its worktree/branch standing for inspection. Fix the CAUSE in the SDK (ratchet contract), then re-sweep.${RESET}`,
    );
  }
  // A failed user-level refresh is a real failure and must not exit 0 — that
  // would be the silence-shaped kind. It is attributed to its own surface, never
  // to a repo, and the remedy is one command rather than another whole sweep.
  return failed > 0 || userRules?.status === 'failed' ? 1 : 0;
}
