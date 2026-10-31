/**
 * Doctor — component-based environment validation.
 *
 * Reads justin-sdk.config.json to determine which components are installed,
 * then runs the corresponding doctor checks.
 *
 * Each component registers its own checks. Adding a new component
 * to justin-sdk.config.json automatically includes its doctor checks.
 */

import type {CheckNode, CheckResult} from './check-runner';
import type {HandlersByKnob} from './hook-entries';

import {execSync} from 'child_process';
import {existsSync, readFileSync, statSync} from 'fs';
import {join, resolve} from 'path';

import {SDK_BIN_SHADOW_SCRIPT, shadowsSdkBin} from './base-setup';
import {
  BR_EXIT_SYNC_CONFLICT,
  type BrListProbe,
  compareBrPin,
  mainCheckoutRoot,
  probeBrList,
} from './beads-setup';
import type {BrSemver} from './beads/br';

import {
  brSharesWorktreeDb,
  brVersionIn,
  compareSemver,
  findBeadsWorkspace,
  parseBrVersion,
} from './beads/br';
import {renderCheckTree, runCheckTree} from './check-runner';
import {configNameFor, resolveComponents} from './component-registry';
import {
  CRITICAL_RULES_CONFIG_KEY,
  legacyModulesWarning,
  refreshCriticalRulesArtifact,
  refreshSucceeded,
  RETIRED_MODULES_KEY,
} from './critical-rules-setup';
import {ESLINT_CONFIG_NAMES} from './eslint-setup';
import {
  checkSdkHookEntries,
  type DryRun,
  HOOK_ENTRIES_FIX,
} from './hook-entries-check';
import {buildComponentListing} from './list';
import {PINNED} from './pinned-versions';
import {
  checkRulesDrift,
  isRulesDriftProblem,
  rulesDriftAdvice,
} from './rules/rules-drift';
import {SDK_RUN} from './sdk-invocation';
import {
  checkHandoffSandbox,
  HANDOFF_COMMAND_DISPLAY,
  handoffSandboxAdvice,
  handoffSandboxCannotCheckAdvice,
} from './thread/handoff-sandbox';
import {
  HANDOFF_RULE_FILE,
  type HandoffSuccessorKnob,
  handoffSuccessorKnob,
  threadRulesFilesFor,
  threadRulesInstalledPath,
  threadRulesState,
} from './thread-rules';
import {
  checkUserLevelSessionStart,
  USER_SETTINGS_DISPLAY,
  userLevelHookAdvice,
} from './user-level-hook';
import {
  describeMissing,
  detectWorktreeHydration,
  hasBlockingProblem,
  isLinkedWorktree,
} from './worktree-hydration';
import {
  eslintWorktreeStatus,
  prettierWorktreeStatus,
  worktreeGitStatus,
} from './worktree-ignore';

const IS_REMOTE = process.env.CLAUDE_CODE_REMOTE === 'true';

/** Read the centrally pinned version from versions.json (if available). */
function getCentralBeadsVersion(): string | null {
  const versionsPath = resolve(import.meta.dirname, '..', 'versions.json');
  if (!existsSync(versionsPath)) return null;
  try {
    const versions = JSON.parse(readFileSync(versionsPath, 'utf-8')) as Record<
      string,
      string
    >;
    return versions.beads_rust ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function exec(cmd: string, cwd: string): {exitCode: number; stdout: string} {
  try {
    const stdout = execSync(cmd, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return {exitCode: 0, stdout};
  } catch {
    return {exitCode: 1, stdout: ''};
  }
}

/** HOOK_ENTRIES as a CheckResult. Exported for tests. */
export function hookEntriesCheckResult(
  projectRoot: string,
  options: {byKnob?: HandlersByKnob; dryRun?: DryRun} = {},
): CheckResult {
  const report = checkSdkHookEntries(projectRoot, options);
  if (report.kind === 'cannot-check') {
    return {
      fix: 'Fix the file named above, then run doctor again',
      message: `UNKNOWN: ${report.reason}`,
      pass: false,
      severity: 'warn',
    };
  }
  const errors = [...report.doubleRuns, ...report.dead];
  const warnings = [...report.missing, ...report.stale, ...report.extra];
  if (errors.length === 0 && warnings.length === 0) {
    return {
      message: `${report.mode}: ${report.matched} SDK hook entr${report.matched === 1 ? 'y matches' : 'ies match'} what install writes`,
      pass: true,
    };
  }
  const section = (title: string, lines: string[]): string[] =>
    lines.length === 0
      ? []
      : [`${title}:`, ...lines.map((line) => `  ${line}`)];
  return {
    fix: HOOK_ENTRIES_FIX,
    message: [
      `${report.mode} mode — the SDK hook entries in .claude/settings.json do not match what install writes`,
      ...section('runs twice', report.doubleRuns),
      ...section('dead', report.dead),
      ...section('missing', report.missing),
      ...section('stale', report.stale),
      ...section('extra', report.extra),
    ].join('\n'),
    pass: false,
    severity: errors.length > 0 ? 'error' : 'warn',
  };
}

/**
 * USER_LEVEL_SESSION_START as a CheckResult. Exported for tests.
 *
 * `userLevelHooks: false` in the USER config (home-base-rtsx1.5) turns the
 * warning into a passing line: Justin chose not to install the hooks, so a
 * warning in every enrolled repo tells him nothing. Only a user config that
 * read and validated can say so. One that cannot be read, is not JSON or
 * breaks the schema leaves the choice UNKNOWN, and the check warns as before,
 * naming the file (critical rule 7: "could not read" is never "off").
 *
 * sdk-config is `await import`ed for the reason given at CONFIG_SCHEMA below.
 */
export async function userLevelSessionStartCheckResult(
  env: Record<string, string | undefined> = process.env,
): Promise<CheckResult> {
  const result = checkUserLevelSessionStart(env);
  if (result.status === 'installed') {
    return {message: result.message, pass: true};
  }

  const {describeConfigOutcome, readUserConfig} = await import('./sdk-config');
  const user = readUserConfig(env);
  if (user.status === 'ok' && user.config.userLevelHooks === false) {
    return {
      message: `The user-level hooks are off by your choice ("userLevelHooks": false in ${user.path}), so UNENROLLED repos get no repo-state block. To turn them back on, delete that key: doctor then warns again and prints the JSON to paste into ${USER_SETTINGS_DISPLAY}`,
      pass: true,
    };
  }

  const choiceUnknown =
    user.status === 'ok' || user.status === 'absent'
      ? ''
      : `. Whether you switched this warning off is UNKNOWN: ${describeConfigOutcome(user)}`;
  return {
    fix:
      result.status === 'cannot-check'
        ? `Read ${USER_SETTINGS_DISPLAY} by hand and confirm it registers \`session-start --user-level\` (SessionStart) and \`repo-state --hook --user-level\` (UserPromptSubmit)`
        : userLevelHookAdvice(),
    message: `${result.message}${choiceUnknown}`,
    pass: false,
    severity: 'warn',
  };
}

function parseMiseToml(projectRoot: string): Record<string, string> | null {
  const miseTomlPath = resolve(projectRoot, 'mise.toml');
  if (!existsSync(miseTomlPath)) return null;

  const content = readFileSync(miseTomlPath, 'utf-8');
  const versions: Record<string, string> = {};

  const toolPattern =
    /"([^"]+)"\s*=\s*(?:"([^"]+)"|\{[^}]*version\s*=\s*"([^"]+)"[^}]*\})/g;
  let match;
  while ((match = toolPattern.exec(content)) !== null) {
    const tool = match[1];
    const version = match[2] ?? match[3];
    if (tool != null && tool !== '' && version != null && version !== '') {
      versions[tool] = version;
    }
  }

  return versions;
}

// ---------------------------------------------------------------------------
// BR and BR_DB (beads-setup component; home-base-dj5m9.1.3)
// ---------------------------------------------------------------------------

/** The br version this repo's mise.toml pins, or null when it pins none. */
function repoBeadsPin(projectRoot: string): string | null {
  const miseVersions = parseMiseToml(projectRoot);
  if (miseVersions == null) return null;
  const key = Object.keys(miseVersions).find((k) => k.includes('beads_rust'));
  return key == null ? null : (miseVersions[key] ?? null);
}

/** The br this repo should run, and where that expectation comes from. */
interface BrExpectation {
  /** null when neither versions.json nor mise.toml names a version. */
  expected: string | null;
  /** Set when the repo pins a br NEWER than the SDK's: its pin is expected. */
  repoAbove: {repoPin: string; sdkPin: string} | null;
  source: 'mise.toml' | 'versions.json';
  /** The repo's pin cannot be ordered against the SDK's (`latest`, `0.7`). */
  unordered: boolean;
}

/**
 * The SDK's pin (versions.json), as before, unless this repo's mise.toml pins
 * a NEWER br: then the repo's own. During the br upgrade the SDK pin trails the
 * repos that have moved, and expecting the SDK's would advise running an older
 * br on a database a newer one wrote. A repo pinned at or below the SDK, or
 * not at all, gets exactly the old expectation.
 */
function brExpectation(projectRoot: string): BrExpectation {
  const sdkPin = getCentralBeadsVersion();
  const repoPin = repoBeadsPin(projectRoot);
  const order =
    sdkPin != null && repoPin != null ? compareBrPin(repoPin, sdkPin) : null;
  if (order?.kind === 'above' && repoPin != null && sdkPin != null) {
    return {
      expected: repoPin,
      repoAbove: {repoPin, sdkPin},
      source: 'mise.toml',
      unordered: false,
    };
  }
  return {
    expected: sdkPin ?? repoPin,
    repoAbove: null,
    source: sdkPin != null ? 'versions.json' : 'mise.toml',
    unordered: order?.kind === 'unordered',
  };
}

/**
 * The BR check as a CheckResult. Exported for tests.
 *
 * A repo pinned above versions.json is never pulled down (home-base-dj5m9.1.3):
 * its own pin is the expectation, a match passes with an info line, and the
 * install advice downloads that version, not the SDK's. A repo whose pin
 * cannot be ordered gets no direct-download advice, since any version named
 * could be older than the one it runs.
 *
 * The version comes from `brVersionIn`, the same cached reading BR_DB's
 * workspace discovery uses, so the two checks never see two different brs.
 */
export function brVersionCheckResult(projectRoot: string): CheckResult {
  const want = brExpectation(projectRoot);
  const installed = brVersionIn(projectRoot);
  if (installed.kind === 'failed') {
    // Try mise first, then the official install script for the expected
    // version, when there is one that names a single release.
    const download =
      want.expected == null || want.unordered ? null : want.expected;
    const versionTag =
      download == null || download.startsWith('v') ? download : `v${download}`;
    const fixCommand =
      versionTag == null
        ? 'mise install'
        : `mise install || curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/beads_rust/main/install.sh" | bash -s -- --version ${versionTag} --quiet --skip-skills`;
    return {
      fix:
        versionTag == null
          ? 'Run: mise install'
          : 'Run: mise install (falls back to direct GitHub download if mise is unavailable or rate-limited)',
      fixCommand,
      message: `br (beads_rust) is not installed or not on PATH (${installed.reason})`,
      pass: false,
      requiresApproval: true,
    };
  }

  const actual = installed.text;
  if (want.unordered) {
    // home-base-dj5m9.1.6 F7: a pin like `latest` or `0.7` cannot be ordered
    // against the SDK's, so "expected <SDK pin>" would read as advice to
    // downgrade. Report what runs, compare nothing.
    return {
      message: `br ${actual}: this repo's br pin (${repoBeadsPin(projectRoot) ?? 'none'}) is not a single X.Y.Z version, so it is not compared with the SDK's (${getCentralBeadsVersion() ?? 'none'}, versions.json)`,
      pass: true,
    };
  }
  const expected = want.expected?.replace(/^v/, '') ?? null;
  if (expected != null && actual !== expected) {
    return {
      fix: 'Run: mise install',
      fixCommand: 'mise install',
      message: `Version mismatch: expected ${want.expected} (from ${want.source}), got ${actual}`,
      pass: false,
      severity: 'warn',
    };
  }
  if (want.repoAbove != null) {
    return {
      message: `br ${actual}: this repo pins ${want.repoAbove.repoPin}, newer than the SDK's ${want.repoAbove.sdkPin} (versions.json). Fine: doctor never pulls a pin down.`,
      pass: true,
    };
  }
  return {message: `br ${actual}`, pass: true};
}

/**
 * Advice for a database `br list` failed on. Text only, never a fixCommand, so
 * `doctor --fix` (which remote sessions run through setup-env) cannot run it.
 *
 * It replaced `br doctor --fix`, which was wrong on both brs (measured
 * 2026-10-26 in temp repos): br 0.1.37 has no `--fix` (exit 2, "unexpected
 * argument"); on br 0.7.6 `--fix` is an alias of `--repair`, which rebuilds
 * the database from JSONL, writes .beads/, .doctor/ and the repo's .gitignore,
 * and, run from a linked worktree, does all of that in the PRIMARY checkout.
 */
const BR_DB_REPAIR_ADVICE =
  "Diagnose with `br doctor` before repairing anything, and back the database up first. A repair rebuilds the database from issues.jsonl and differs by br version: br 0.1.37 spells it `--repair` and has no `--fix`; on br 0.7.6 `--fix` is an alias of `--repair`, writes .beads/, .doctor/ and the repo .gitignore, and run from a linked worktree it repairs the PRIMARY checkout's database. Run any repair from the checkout that owns the database. doctor --fix does not run it for you.";

/** For br exit 6, br's own instruction is the advice: no rebuild at all. */
const BR_DB_SYNC_CONFLICT_ADVICE =
  "Do not repair, rebuild or move this database. br's own instruction for this error: close other database readers/writers and have the owning SQLite engine complete a truncating checkpoint before retrying; do not delete or replace the WAL or rebuild this database from JSONL. doctor --fix does not run anything for this.";

function brListFailedResult(
  db: string,
  probe: Extract<BrListProbe, {ok: false}>,
): CheckResult {
  const syncConflict = probe.exitCode === BR_EXIT_SYNC_CONFLICT;
  const lines = [
    `br list failed on ${db}: ${probe.detail}`,
    ...(syncConflict
      ? [
          'Exit 6 is SYNC_CONFLICT: br will not open this database as it stands. One measured cause: a database last written by br 0.1.37 that still holds WAL frames, opened by br 0.7.6.',
        ]
      : []),
  ];
  return {
    fix: syncConflict ? BR_DB_SYNC_CONFLICT_ADVICE : BR_DB_REPAIR_ADVICE,
    message: lines.join('\n'),
    pass: false,
  };
}

/**
 * A linked worktree with a beads database of its own, while its br shares the
 * primary checkout's: br 0.7.6 then uses the worktree's (measured 2026-10-26,
 * scripts/probe-br-worktree-db.ts), so it shadows the shared one. A WARN, null
 * when this is not that case. An unreadable br version is an UNKNOWN warn,
 * never "not shared" (critical rules §7).
 */
function worktreeDbShadowResult(
  projectRoot: string,
  db: string,
): CheckResult | null {
  if (!isLinkedWorktree(projectRoot)) return null;
  const version = brVersionIn(projectRoot);
  if (version.kind === 'failed') {
    return {
      fix: 'Fix what the message names, then run doctor again',
      message: `UNKNOWN: this worktree has a beads database of its own (${db}); whether it shadows the primary checkout's depends on the br version, which could not be read: ${version.reason}`,
      pass: false,
      severity: 'warn',
    };
  }
  if (!brSharesWorktreeDb(version)) return null;
  const primary = mainCheckoutRoot(projectRoot);
  const primaryDb = primary == null ? null : findBeadsWorkspace(primary);
  const consequence =
    primaryDb?.kind === 'found'
      ? `It shadows the primary checkout's ${primaryDb.db}: beads filed here never reach it.`
      : 'The primary checkout has no database br can use, so beads filed here exist in this worktree only.';
  return {
    fix: `Check what ${db} holds that the primary checkout's database lacks, then move this worktree's .beads/beads.db* aside by hand (never delete them), and br uses the primary's. doctor does not do this for you.`,
    message: `this linked worktree has its own beads database (${db}), and br ${version.text} shares one database across worktrees but uses a worktree's own when it exists. ${consequence}`,
    pass: false,
    severity: 'warn',
  };
}

/**
 * No database found for this checkout. The primary checkout gets the old
 * result, `br init` included. A linked worktree NEVER gets `br init`: under a
 * br that shares the primary's database that would create a database of the
 * worktree's own, which br 0.7.6 then prefers over the primary's.
 */
function missingBeadsDbResult(
  projectRoot: string,
  reason: string,
): CheckResult {
  if (!isLinkedWorktree(projectRoot)) {
    return {
      fix: 'Run: br init',
      fixCommand: 'br init',
      message: '.beads/beads.db not found — beads not initialized',
      pass: false,
    };
  }
  const version = brVersionIn(projectRoot);
  if (
    version.kind === 'read' &&
    !brSharesWorktreeDb(version) &&
    existsSync(join(projectRoot, '.beads'))
  ) {
    // Measured on br 0.1.37 (2026-10-26): any br command here, even
    // `br list --no-auto-import`, creates this worktree's database.
    return {
      message: `no beads database in this worktree yet: br ${version.text} keeps one per worktree and creates it from the committed .beads/ on first use`,
      pass: true,
    };
  }
  const primary = mainCheckoutRoot(projectRoot);
  const where =
    primary == null
      ? 'the primary checkout'
      : `the primary checkout (${primary})`;
  const why =
    version.kind === 'read' && brSharesWorktreeDb(version)
      ? ` A database made here would be this worktree's own, and br ${version.text} would use it instead of the primary's.`
      : '';
  return {
    fix: `Set up beads in ${where}, not in this worktree: do not run \`br init\` here.${why}`,
    message: `no beads database for this worktree: ${reason}`,
    pass: false,
  };
}

/**
 * The BR_DB check as a CheckResult. Exported for tests.
 *
 * The database is found the way br finds it (`findBeadsWorkspace`,
 * home-base-dj5m9.1.1): a linked worktree whose br shares the primary
 * checkout's database (br 0.4.1 and later) passes on the primary's, rather
 * than failing on a `.beads/beads.db` it was never meant to have. The `br list`
 * probe carries `--no-auto-import`, so a heartbeat run never imports into a
 * database, the primary's included.
 */
export function brDbCheckResult(projectRoot: string): CheckResult {
  const workspace = findBeadsWorkspace(projectRoot);
  if (workspace.kind === 'failed' && workspace.brSplit != null) {
    // home-base-dj5m9.1.6 F1: the br a bare `br` runs here and the br that
    // runs on the primary's database disagree. No br is probed: a probe from
    // here would run this worktree's br against a database it disagrees on.
    const {primary, worktree} = workspace.brSplit;
    return {
      fix: `Pin the same br in this worktree as in the main checkout (merge main into this worktree, then run \`mise install\`). This worktree runs br ${worktree.version}; the main checkout (${primary.checkout}) runs br ${primary.version}. doctor does not do this for you.`,
      message: `this worktree and its main checkout run brs that disagree on which beads database a worktree uses: ${workspace.reason}`,
      pass: false,
    };
  }
  if (workspace.kind === 'failed') {
    return {
      fix: 'Fix what the message names, then run doctor again',
      message: `UNKNOWN: could not tell which beads database this checkout uses: ${workspace.reason}`,
      pass: false,
      severity: 'warn',
    };
  }
  if (workspace.kind === 'none') {
    return missingBeadsDbResult(projectRoot, workspace.reason);
  }

  const shadow =
    workspace.via === 'checkout'
      ? worktreeDbShadowResult(projectRoot, workspace.db)
      : null;
  // home-base-dj5m9.1.6 F6: a shadow DB is never probed. The br that would
  // probe it shares the primary's database (or its version is unknown), and
  // br 0.7.6 opening a DB an older br made upgrades its schema, at session
  // start, in a database the warning says to move aside.
  if (shadow != null) return shadow;
  const probe = probeBrList(projectRoot, {autoImport: false});
  if (!probe.ok) return brListFailedResult(workspace.db, probe);
  if (workspace.via === 'primary') {
    return {
      message: `uses the primary checkout's database, ${workspace.db}: br ${workspace.brVersion} shares one database across a repo's worktrees`,
      pass: true,
    };
  }
  return {pass: true};
}

/**
 * The br a checkout pins: its mise.toml pin when that is a plain X.Y.Z (a
 * file read, no process), else the br that runs there (`br --version`,
 * offline). `failed` when neither can be read.
 */
function pinnedBrOf(
  checkout: string,
):
  | {kind: 'failed'; reason: string}
  | (BrSemver & {kind: 'read'; text: string}) {
  let pin: string | null;
  try {
    pin = repoBeadsPin(checkout);
  } catch (error) {
    return {
      kind: 'failed',
      reason: `its mise.toml could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const plain =
    pin == null ? null : parseBrVersion(`br ${pin.replace(/^v/, '')}`);
  if (plain != null && /^v?\d+\.\d+\.\d+$/.test(pin ?? '')) {
    return {...plain, kind: 'read'};
  }
  return brVersionIn(checkout);
}

/**
 * The repo's linked worktrees whose pinned br is OLDER than the main
 * checkout's (home-base-dj5m9.1.6 F10; layer 3 of the decision in
 * home-base-dj5m9.1.7). An old worktree's SDK passes `--db <main's DB>` to its
 * own old br, and br 0.1.37 writes a 0.7.6 database without refusing; the
 * fix is merging main into that worktree. A worktree whose br cannot be read
 * is listed as unknown, never left out. Exported for tests.
 */
export function brWorktreesCheckResult(projectRoot: string): CheckResult {
  const primary = mainCheckoutRoot(projectRoot);
  if (primary == null) {
    return {
      fix: 'Fix what the message names, then run doctor again',
      message:
        "UNKNOWN: the main checkout could not be found, so the worktrees' br pins were not compared with it",
      pass: false,
      severity: 'warn',
    };
  }
  const main = pinnedBrOf(primary);
  if (main.kind === 'failed') {
    return {
      fix: 'Fix what the message names, then run doctor again',
      message: `UNKNOWN: the main checkout's br (${primary}) could not be read, so no worktree was compared with it: ${main.reason}`,
      pass: false,
      severity: 'warn',
    };
  }
  const listed = exec('git worktree list --porcelain', primary);
  if (listed.exitCode !== 0) {
    return {
      fix: 'Fix what the message names, then run doctor again',
      message: `UNKNOWN: \`git worktree list --porcelain\` failed in ${primary}, so no worktree's br was checked`,
      pass: false,
      severity: 'warn',
    };
  }
  const worktrees = listed.stdout
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
    .filter((path) => path !== primary);
  const older: string[] = [];
  const unknown: string[] = [];
  for (const worktree of worktrees) {
    if (!existsSync(worktree)) {
      unknown.push(`${worktree}: br unknown (the directory is missing)`);
      continue;
    }
    const version = pinnedBrOf(worktree);
    if (version.kind === 'failed') {
      unknown.push(`${worktree}: br unknown (${version.reason})`);
    } else if (compareSemver(version, main) < 0) {
      older.push(`${worktree}: br ${version.text}`);
    }
  }
  if (older.length === 0 && unknown.length === 0) {
    return {
      message: `${worktrees.length} linked worktree${worktrees.length === 1 ? '' : 's'}, none pinned to a br older than the main checkout's ${main.text}`,
      pass: true,
    };
  }
  return {
    fix: 'Merge main into each worktree listed, then run `mise install` there. doctor does not do this for you.',
    message: [
      `${older.length} linked worktree${older.length === 1 ? '' : 's'} pinned to a br older than the main checkout's ${main.text}, and ${unknown.length} whose br could not be read. An older br writes the main checkout's newer database without refusing:`,
      ...older.map((line) => `  ${line}`),
      ...unknown.map((line) => `  ${line}`),
    ].join('\n'),
    pass: false,
    severity: 'warn',
  };
}

// ---------------------------------------------------------------------------
// Worktree hydration (base-setup component)
// ---------------------------------------------------------------------------

/**
 * The ENV_HYDRATION check — in EVERY checkout (home-base-j2n7 widened the
 * v170 WORKTREE_HYDRATION check, which registered only inside linked
 * worktrees).
 *
 * WHY EVERYWHERE: setup-env's execution model never auto-installs on a local
 * session-start heartbeat (no hidden side effects), so this read-only check is
 * the ONLY thing standing between "checked out a branch that added a dep" and
 * many minutes of misdiagnosed tool failures in the primary checkout.
 *
 * SEVERITY IS SPLIT BY TOPOLOGY: a linked worktree fails at ERROR (a fresh
 * worktree is expected to be hydrated before use — v170 behavior preserved); a
 * primary checkout WARNS (Justin's ruling: alert, never block, never fix).
 *
 * THE GATE IS NOT SPLIT (F7): doctor reports state rather than deciding whether
 * work may proceed, so ANY problem is `pass: false`. The MESSAGE is split, and
 * only the message (home-base-v170.6) — see the consequence sentence below.
 */
export function makeEnvHydrationChecks(projectRoot: string): CheckNode[] {
  return [
    {
      check: {
        fn: (): CheckResult => {
          const linked = isLinkedWorktree(projectRoot);
          const status = detectWorktreeHydration(projectRoot);
          if (status.problems.length === 0) {
            return {
              message: linked
                ? 'linked worktree, hydrated'
                : 'deps present, versions satisfy declared ranges',
              pass: true,
            };
          }
          // The PHANTOM claim is the one sentence in this whole feature that has
          // to be BELIEVED, so it is emitted only where F7 says it is true: a
          // blocking problem (a missing node_modules). Asserting it for an
          // advisory-only gap — say a missing .env.local with node_modules
          // intact — is simply false, and a reader who catches it being false
          // once will discount it in the blocking case where it matters.
          const blocking = hasBlockingProblem(status);
          const consequence = blocking
            ? 'Any lint/type failures here are PHANTOM (they blame untouched files).'
            : 'Lint/type results here are still trustworthy — this cannot fabricate failures — but a build, or any command needing the pinned toolchain, may fail.';
          return {
            fix: `Run: ${status.fixCommand}`,
            message:
              (linked
                ? `${blocking ? '' : 'partially '}unhydrated linked worktree — `
                : 'stale environment — ') +
              `missing ${describeMissing(status)}. ${consequence} ` +
              status.problems.map((problem) => problem.detail).join('; '),
            pass: false,
            severity: linked ? 'error' : 'warn',
          };
        },
        label: 'ENV_HYDRATION',
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Base checks (base-setup component)
// ---------------------------------------------------------------------------

function makeBaseChecks(projectRoot: string): CheckNode[] {
  return [
    // FIRST because it explains every other failure when it fires: in an
    // unhydrated worktree the other checks report symptoms, and this one reports
    // the cause. Contributes NOTHING in a primary checkout (empty array), so
    // doctor's output there is unchanged.
    ...makeEnvHydrationChecks(projectRoot),
    {
      check: {
        fn: (): CheckResult => {
          const {stdout, exitCode} = exec('bun --version', projectRoot);
          if (exitCode !== 0) {
            // Env-aware fix: brew on macOS, npm global elsewhere, curl as last resort
            let fixCommand: string;
            if (process.platform === 'darwin' && !IS_REMOTE) {
              fixCommand = 'brew install bun';
            } else {
              fixCommand =
                'npm i -g bun || curl -fsSL https://bun.sh/install | bash';
            }
            return {
              fix: `Run: ${fixCommand}`,
              fixCommand,
              message: 'bun is not installed',
              pass: false,
              requiresApproval: true,
            };
          }
          return {message: `bun ${stdout}`, pass: true};
        },
        label: 'BUN',
      },
    },
    {
      check: {
        fn: (): CheckResult => {
          if (!existsSync(resolve(projectRoot, 'CLAUDE.md'))) {
            return {message: 'No CLAUDE.md found', pass: false};
          }
          return {pass: true};
        },
        label: 'CLAUDE_MD',
      },
    },
    {
      check: {
        fn: (): Promise<CheckResult> => userLevelSessionStartCheckResult(),
        /**
         * Is the USER-LEVEL SessionStart hook installed (epic home-base-dchjw D6)?
         *
         * It is not this repo's business in the narrow sense — the check passes
         * or fails identically in every enrolled repo — but it is the only
         * place the absence can be NOTICED. Nothing detected that the `prime`
         * plugin had gone stale for a month, twice; putting its replacement's
         * absence in front of a routine `doctor` run is the whole point.
         *
         * WARN, never error, and READ-ONLY WITH NO FIXER. `~/.claude/settings.json`
         * is Justin's own file, outside every project boundary the SDK has, and
         * a doctor check that edited it would be the SDK reaching into the
         * user's machine on the strength of a heartbeat. The fix is printed and
         * pasted by hand.
         *
         * `cannot-check` also warns, but says so in those words: an unreadable
         * settings file is not evidence the hook is missing (rule 6).
         *
         * `userLevelHooks: false` in the user config passes it with one line
         * instead (home-base-rtsx1.5): see userLevelSessionStartCheckResult.
         */
        label: 'USER_LEVEL_SESSION_START',
        severity: 'warn',
      },
    },
    {
      check: {
        // hook-knobs reaches zod: loaded here, never statically (home-base-mbnjv.5).
        fn: async (): Promise<CheckResult> => {
          const {handlersByKnob} = await import('./hook-knobs');
          return hookEntriesCheckResult(projectRoot, {
            byKnob: handlersByKnob(projectRoot),
          });
        },
        /**
         * Do the SDK hook entries in .claude/settings.json match what
         * `install` writes for this repo's components and hooks.dispatch mode
         * (home-base-rtsx1.3)? Reports, never writes: Justin, 2026-10-17, "fine
         * to just report the discrepancy", with the per-repo and fleet repair
         * named in the fix. An error only when a handler runs twice or the
         * dispatcher entry is dead; anything else warns.
         */
        label: 'HOOK_ENTRIES',
      },
    },
    {
      check: {
        fn: (): CheckResult => {
          const pkgPath = resolve(projectRoot, 'package.json');
          if (!existsSync(pkgPath)) {
            return {message: 'No package.json found', pass: false};
          }

          const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
            scripts?: Record<string, string>;
          };
          const scripts = pkg.scripts ?? {};
          const required = ['setup-env', 'signal', 'doctor'];
          const missing = required.filter((name) => !(name in scripts));

          if (missing.length > 0) {
            return {
              fix: `Add missing scripts to package.json: ${missing.join(', ')}`,
              message: `Missing package.json scripts: ${missing.join(', ')}`,
              pass: false,
            };
          }

          return {pass: true};
        },
        label: 'PKG_SCRIPTS',
      },
    },
    {
      check: {
        fn: (): CheckResult => {
          if (!existsSync(resolve(projectRoot, 'justin-sdk.config.json'))) {
            return {
              fix: 'Create justin-sdk.config.json at project root',
              message: 'No justin-sdk.config.json found',
              pass: false,
            };
          }
          return {pass: true};
        },
        label: 'JUSTIN_SDK_JSON',
      },
    },
    // SCRIPT_SHADOWS_SDK_BIN (epic home-base-dchjw.4 F8). ERROR, not a warning:
    // every SDK-owned alias and every hook in this repo is spelled
    // `bun run justin-sdk …`, and `bun run` resolves a package.json SCRIPT
    // before `node_modules/.bin`. So a script with that name silently redirects
    // all of them somewhere else — and, because bun echoes `$ <command>` for a
    // script and prints nothing for a bin, it also injects a line into the
    // stdout of hooks whose output is parsed. Nothing on the fleet has one
    // today (measured 2026-09-18); this is the tripwire.
    //
    // No fixCommand: the fix is to rename or delete a script this repo's owner
    // wrote, which is a decision, not a scaffold repair.
    {
      check: {
        fn: (): CheckResult => {
          const pkgPath = resolve(projectRoot, 'package.json');
          if (!existsSync(pkgPath)) return {pass: true};
          let scripts: Record<string, unknown> | undefined;
          try {
            scripts = (
              JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
                scripts?: Record<string, unknown>;
              }
            ).scripts;
          } catch {
            // Unparseable package.json is JUSTIN_SDK_JSON's business, not this
            // check's. Reporting "no shadow" here would be a claim we cannot
            // make, so say so instead (critical rule 6).
            return {
              message: 'package.json could not be parsed — shadow not checked',
              pass: false,
              severity: 'warn',
            };
          }
          if (!shadowsSdkBin(scripts)) {
            return {
              message: 'no script shadows the justin-sdk bin',
              pass: true,
            };
          }
          return {
            fix: `Rename or remove the "${SDK_BIN_SHADOW_SCRIPT}" script in package.json. While it exists, \`${SDK_RUN} <cmd>\` runs that script instead of the SDK, and echoes "$ …" into hook stdout.`,
            message: `package.json has a script named "${SDK_BIN_SHADOW_SCRIPT}", which shadows the justin-sdk bin under \`bun run\``,
            pass: false,
          };
        },
        label: 'SCRIPT_SHADOWS_SDK_BIN',
      },
    },
    // CONFIG_SCHEMA (home-base-uxwc D9). A SIBLING of JUSTIN_SDK_JSON, not a
    // child: the user-level file still deserves validating in a repo that has
    // no project config yet. Warn-only — a config that parses but has one
    // wrong-typed key is a nuisance, not a broken environment — and it does not
    // enumerate what is MISSING, only what is wrong: unknown keys are always
    // allowed, so this can never fail a repo for being ahead of the SDK.
    //
    // sdk-config is `await import`ed rather than imported at the top of this
    // file: cli.ts loads doctor.ts eagerly, so a static import would put zod
    // (12-13ms against a 40-50ms CLI startup) into the time-check and
    // usage-check hook path, which runs on every prompt Justin types.
    {
      check: {
        fn: async (): Promise<CheckResult> => {
          const {
            describeConfigOutcome,
            isConfigProblem,
            readProjectConfig,
            readUserConfig,
          } = await import('./sdk-config');
          const outcomes = [readProjectConfig(projectRoot), readUserConfig()];
          const problems = outcomes
            .filter(isConfigProblem)
            .map((outcome) => describeConfigOutcome(outcome));
          if (problems.length > 0) {
            return {
              fix: 'See every accepted key, its type and its default: bun run justin-sdk config schema',
              message: problems.join(' | '),
              pass: false,
              severity: 'warn',
            };
          }
          return {
            message: outcomes
              .map((outcome) => describeConfigOutcome(outcome))
              .join('; '),
            pass: true,
          };
        },
        label: 'CONFIG_SCHEMA',
        severity: 'warn',
      },
    },
    // SDK_VERSION (home-base-uxwc D5, D6). Warn-only, and deliberately WITHOUT
    // a fixCommand or fixFn: the remote SessionStart hook runs `doctor --fix
    // --yes`, and --yes bypasses requiresApproval, so a fixCommand here would
    // rewrite package.json and bun.lock in every cloud session of every repo in
    // the fleet. The fix is TEXT; a human runs it.
    //
    // It shares the health-notices probe, so it is throttled by the same
    // checkIntervalMinutes as the stderr notice — running doctor does not
    // mean a network call.
    {
      check: {
        fn: async (): Promise<CheckResult> => {
          const {
            NOTICE_FETCH_TIMEOUT_MS,
            probeSdkVersion,
            sdkVersionVerdict,
            UPGRADE_COMMAND,
          } = await import('./health-notices');
          const {SDK_REPO_URL} = await import('./sdk-latest');
          const now = new Date();
          // The short timeout (uxwc.5 F7): doctor --quiet runs from the
          // SessionStart hook, so a dead network must not hold a session up.
          const verdict = sdkVersionVerdict(
            await probeSdkVersion({
              projectRoot,
              timeoutMs: NOTICE_FETCH_TIMEOUT_MS,
            }),
            now,
          );
          switch (verdict.status) {
            case 'newer':
              // `silenced` means promptTier 1 for this kind: Justin has said he
              // does not want to hear about these, so doctor states the fact
              // without colouring the run yellow.
              return verdict.silenced
                ? {message: verdict.message, pass: true}
                : {
                    fix: `Run: ${UPGRADE_COMMAND}`,
                    message: verdict.message,
                    pass: false,
                    severity: 'warn',
                  };
            case 'not-checked':
              // A check nobody asked for is not a failed check. The message
              // still says "not checked" out loud — what must never happen is
              // this rendering as "you are on the latest version".
              return {message: verdict.message, pass: true};
            case 'unknown':
              // Tried and could not tell. Never a pass (D5) — an unknown
              // version is exactly the state Justin has been stuck in.
              return {
                fix: `Check by hand: git ls-remote --tags ${SDK_REPO_URL} | tail`,
                message: verdict.message,
                pass: false,
                severity: 'warn',
              };
            case 'up-to-date':
              return {message: verdict.message, pass: true};
          }
        },
        label: 'SDK_VERSION',
        severity: 'warn',
      },
    },
    // Worktree hygiene. These live in base-setup (universal) ON PURPOSE: the
    // usual failure is a project NOT being enrolled in gitignore/eslint/prettier
    // -setup, so a surface-specific component check would never fire for exactly
    // the projects that need it. Reported as independent SIBLINGS so one missing
    // surface doesn't mask the others. tsconfig is intentionally NOT checked —
    // TS skips dot-dirs, so .claude/worktrees is already invisible to tsc.
    {
      check: {
        fn: (): CheckResult => {
          const status = worktreeGitStatus(projectRoot);
          if (status === 'committed' || status === 'not-git') {
            return {pass: true};
          }
          const message =
            status === 'ephemeral'
              ? '.claude/worktrees is ignored only by a non-committed layer (global git ignore or .git/info/exclude) — that does NOT travel with the repo, so EAS Build and fresh clones still archive the worktrees'
              : '.claude/worktrees is not git-ignored';
          return {
            fix: 'Run: bun run justin-sdk add gitignore (adds .claude/worktrees/ to the committed .gitignore)',
            fixCommand: 'bun run justin-sdk add gitignore',
            message,
            pass: false,
          };
        },
        label: 'WORKTREE_GITIGNORE',
      },
    },
    {
      check: {
        fn: (): CheckResult => {
          const status = eslintWorktreeStatus(projectRoot);
          if (!status.applicable || status.covered) return {pass: true};
          return {
            fix: `Add '**/.claude/worktrees/' to the ignores in ${status.configFile ?? 'your eslint config'}`,
            message: `${status.configFile ?? 'eslint config'} does not ignore .claude/worktrees — eslint will lint worktree copies (turns signal red)`,
            pass: false,
            severity: 'warn',
          };
        },
        label: 'WORKTREE_ESLINT',
        severity: 'warn',
      },
    },
    {
      check: {
        fn: (): CheckResult => {
          const status = prettierWorktreeStatus(
            projectRoot,
            worktreeGitStatus(projectRoot),
          );
          if (!status.applicable || status.covered) return {pass: true};
          return {
            fix: "Add '**/.claude/worktrees/' to .prettierignore (or ensure the committed .gitignore covers it — prettier reads .gitignore by default)",
            message:
              'prettier will format .claude/worktrees copies (neither .prettierignore nor the committed .gitignore excludes it)',
            pass: false,
            severity: 'warn',
          };
        },
        label: 'WORKTREE_PRETTIER',
        severity: 'warn',
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Beads checks (beads-setup component)
// ---------------------------------------------------------------------------

function makeBeadsChecks(projectRoot: string): CheckNode[] {
  return [
    // MISE and MISE_TOML are nice-to-haves: they provide the preferred
    // install path for br via mise. If they're missing, the BR check
    // falls back to a direct curl install. That's why they're warn-level
    // and siblings of (not parents of) the BR check.
    {
      check: {
        fn: (): CheckResult => {
          const {stdout, exitCode} = exec('mise --version', projectRoot);
          if (exitCode !== 0) {
            const fixCommand = IS_REMOTE
              ? 'curl -fsSL https://mise.run | sh'
              : 'brew install mise';
            return {
              fix: `Run: ${fixCommand}`,
              fixCommand,
              message:
                'mise is not installed (br falls back to direct install)',
              pass: false,
              requiresApproval: true,
            };
          }
          return {message: `mise ${stdout}`, pass: true};
        },
        label: 'MISE',
        severity: 'warn',
      },
    },
    {
      check: {
        fn: (): CheckResult => {
          if (!existsSync(resolve(projectRoot, 'mise.toml'))) {
            return {
              fix: 'Create mise.toml to enable mise-managed br installs',
              message: 'No mise.toml found (br falls back to direct install)',
              pass: false,
            };
          }
          return {pass: true};
        },
        label: 'MISE_TOML',
        severity: 'warn',
      },
    },
    {
      check: {
        fn: (): CheckResult => brVersionCheckResult(projectRoot),
        label: 'BR',
      },
      children: [
        {
          check: {
            fn: (): CheckResult => brDbCheckResult(projectRoot),
            label: 'BR_DB',
          },
          // AGENTS.md is no longer generated or required: cross-project guidance
          // is delivered by `justin-sdk prime` (SessionStart hook), and the
          // essential `br` commands live in the prime beads-workflow guideline
          // (+ `br --help`). The old AGENTS_MD / CLAUDE_MD_AGENTS_REF checks were
          // removed here so they stop re-generating AGENTS.md at session start.
          // See home-base-t6a0.12 (migrate-to-prime).
        },
        {
          check: {
            fn: (): CheckResult => brWorktreesCheckResult(projectRoot),
            label: 'BR_WORKTREES',
            severity: 'warn',
          },
        },
      ],
    },
    {
      check: {
        fn: (): CheckResult => {
          const prettierIgnore = resolve(projectRoot, '.prettierignore');
          if (!existsSync(prettierIgnore)) {
            return {
              fix: 'Create .prettierignore with .beads entry',
              message: '.prettierignore not found',
              pass: false,
            };
          }

          const content = readFileSync(prettierIgnore, 'utf-8');
          if (!content.includes('.beads')) {
            return {
              fix: 'Add .beads to .prettierignore',
              message: '.prettierignore does not include .beads',
              pass: false,
            };
          }

          return {pass: true};
        },
        label: 'PRETTIER_IGNORE_BEADS',
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Shared package.json helpers
// ---------------------------------------------------------------------------

function readPkgDevDep(projectRoot: string, name: string): string | null {
  const pkgPath = resolve(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return pkg.devDependencies?.[name] ?? pkg.dependencies?.[name] ?? null;
  } catch {
    return null;
  }
}

function readPkgScript(projectRoot: string, name: string): string | null {
  const pkgPath = resolve(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
      scripts?: Record<string, string>;
    };
    return pkg.scripts?.[name] ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Prettier checks (prettier-setup component)
// ---------------------------------------------------------------------------

function makePrettierChecks(projectRoot: string): CheckNode[] {
  return [
    {
      check: {
        fn: (): CheckResult => {
          const installed = readPkgDevDep(projectRoot, 'prettier');
          if (installed == null) {
            return {
              fix: 'Run: bun run justin-sdk add prettier',
              fixCommand: 'bun run justin-sdk add prettier',
              message: 'prettier not in package.json devDependencies',
              pass: false,
            };
          }
          if (installed !== PINNED.prettier) {
            return {
              fix: `Update prettier to ${PINNED.prettier} (currently ${installed})`,
              message: `prettier ${installed} installed, pinned is ${PINNED.prettier}`,
              pass: false,
              severity: 'warn',
            };
          }
          return {message: `prettier ${installed}`, pass: true};
        },
        label: 'PRETTIER_INSTALLED',
      },
    },
    {
      check: {
        fn: (): CheckResult => {
          if (!existsSync(resolve(projectRoot, '.prettierrc.json'))) {
            return {
              fix: 'Run: bun run justin-sdk add prettier',
              fixCommand: 'bun run justin-sdk add prettier',
              message: '.prettierrc.json not found',
              pass: false,
            };
          }
          return {pass: true};
        },
        label: 'PRETTIERRC',
      },
    },
    {
      check: {
        fn: (): CheckResult => {
          const prettierIgnore = resolve(projectRoot, '.prettierignore');
          if (!existsSync(prettierIgnore)) {
            return {
              fix: 'Run: bun run justin-sdk add prettier',
              fixCommand: 'bun run justin-sdk add prettier',
              message: '.prettierignore not found',
              pass: false,
            };
          }
          const content = readFileSync(prettierIgnore, 'utf-8');
          if (!content.includes('.beads')) {
            return {
              fix: 'Add .beads to .prettierignore (or re-run: bun run justin-sdk add prettier)',
              fixCommand: 'bun run justin-sdk add prettier',
              message: '.prettierignore does not include .beads',
              pass: false,
            };
          }
          return {pass: true};
        },
        label: 'PRETTIERIGNORE',
      },
    },
    {
      check: {
        fn: (): CheckResult => {
          const script = readPkgScript(projectRoot, 'signal-source:PRETTIER');
          if (script == null) {
            return {
              fix: 'Run: bun run justin-sdk add prettier',
              fixCommand: 'bun run justin-sdk add prettier',
              message: 'package.json missing signal-source:PRETTIER script',
              pass: false,
            };
          }
          return {pass: true};
        },
        label: 'SIGNAL_SOURCE_PRETTIER',
      },
    },
    {
      check: {
        fn: (): CheckResult => {
          const script = readPkgScript(projectRoot, 'fix-source:PRETTIER');
          if (script == null) {
            return {
              fix: 'Run: bun run justin-sdk add prettier',
              fixCommand: 'bun run justin-sdk add prettier',
              message: 'package.json missing fix-source:PRETTIER script',
              pass: false,
            };
          }
          return {pass: true};
        },
        label: 'FIX_SOURCE_PRETTIER',
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Tsconfig checks (tsconfig-setup component)
// ---------------------------------------------------------------------------

function makeTsconfigChecks(projectRoot: string): CheckNode[] {
  return [
    {
      check: {
        fn: (): CheckResult => {
          const version = readPkgDevDep(projectRoot, 'typescript');
          if (version == null) {
            return {
              fix: 'Run: bun run justin-sdk add tsconfig',
              fixCommand: 'bun run justin-sdk add tsconfig',
              message: 'typescript is not in devDependencies',
              pass: false,
            };
          }
          if (version !== PINNED.typescript) {
            return {
              fix: `Update package.json devDependencies.typescript to ${PINNED.typescript}`,
              message: `typescript is at ${version}, SDK pins ${PINNED.typescript}`,
              pass: false,
              severity: 'warn',
            };
          }
          return {message: `typescript ${version}`, pass: true};
        },
        label: 'TS_INSTALLED',
      },
    },
    {
      check: {
        fn: (): CheckResult => {
          const version = readPkgDevDep(projectRoot, '@types/bun');
          if (version == null) {
            return {
              fix: 'Run: bun run justin-sdk add tsconfig',
              fixCommand: 'bun run justin-sdk add tsconfig',
              message: '@types/bun is not in devDependencies',
              pass: false,
            };
          }
          return {message: `@types/bun ${version}`, pass: true};
        },
        label: 'TYPES_BUN_INSTALLED',
      },
    },
    {
      check: {
        fn: (): CheckResult => {
          if (!existsSync(resolve(projectRoot, 'tsconfig.json'))) {
            return {
              fix: 'Run: bun run justin-sdk add tsconfig',
              fixCommand: 'bun run justin-sdk add tsconfig',
              message: 'tsconfig.json not found at project root',
              pass: false,
            };
          }
          return {pass: true};
        },
        label: 'TSCONFIG',
      },
      children: [
        {
          check: {
            fn: (): CheckResult => {
              const tsconfigPath = resolve(projectRoot, 'tsconfig.json');
              const raw = readFileSync(tsconfigPath, 'utf-8');
              try {
                const parsed = JSON.parse(raw) as {
                  compilerOptions?: {strict?: boolean};
                };
                if (parsed.compilerOptions?.strict === true) {
                  return {pass: true};
                }
                return {
                  fix: 'Set compilerOptions.strict to true in tsconfig.json',
                  message: 'compilerOptions.strict is not true',
                  pass: false,
                };
              } catch {
                if (/"strict"\s*:\s*true/.test(raw)) {
                  return {pass: true};
                }
                return {
                  fix: 'Set compilerOptions.strict to true in tsconfig.json',
                  message:
                    'compilerOptions.strict is not true (JSONC fallback check)',
                  pass: false,
                };
              }
            },
            label: 'TSCONFIG_STRICT',
          },
        },
      ],
    },
    {
      check: {
        fn: (): CheckResult => {
          const script = readPkgScript(projectRoot, 'signal-source:TS');
          if (script == null) {
            return {
              fix: 'Run: bun run justin-sdk add tsconfig',
              fixCommand: 'bun run justin-sdk add tsconfig',
              message: 'package.json missing signal-source:TS script',
              pass: false,
            };
          }
          return {pass: true};
        },
        label: 'SIGNAL_SOURCE_TS',
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// GitHub Actions checks (gh-actions-setup component)
// ---------------------------------------------------------------------------

function makeGhActionsChecks(projectRoot: string): CheckNode[] {
  return [
    {
      check: {
        fn: (): CheckResult => {
          const workflow = resolve(projectRoot, '.github/workflows/signal.yml');
          if (!existsSync(workflow)) {
            return {
              fix: 'Run: bun run justin-sdk add gh-actions',
              fixCommand: 'bun run justin-sdk add gh-actions',
              message: '.github/workflows/signal.yml not found',
              pass: false,
            };
          }
          return {pass: true};
        },
        label: 'GH_ACTIONS_SIGNAL',
      },
      children: [
        {
          check: {
            fn: (): CheckResult => {
              const workflow = resolve(
                projectRoot,
                '.github/workflows/signal.yml',
              );
              const content = readFileSync(workflow, 'utf-8');
              if (!content.includes('oven-sh/setup-bun')) {
                return {
                  fix: 'Re-install with: bun run justin-sdk add gh-actions --force',
                  message:
                    '.github/workflows/signal.yml does not use oven-sh/setup-bun — may be a custom workflow',
                  pass: false,
                };
              }
              return {pass: true};
            },
            label: 'GH_ACTIONS_SIGNAL_BUN',
            severity: 'warn',
          },
        },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// Gitignore checks (gitignore-setup component)
// ---------------------------------------------------------------------------

function makeGitignoreChecks(projectRoot: string): CheckNode[] {
  const gitignorePath = resolve(projectRoot, '.gitignore');
  const FIX_CMD = 'bun run justin-sdk add gitignore';

  function readGitignore(): string | null {
    if (!existsSync(gitignorePath)) return null;
    return readFileSync(gitignorePath, 'utf-8');
  }

  return [
    {
      check: {
        fn: (): CheckResult => {
          if (readGitignore() == null) {
            return {
              fix: `Run: ${FIX_CMD}`,
              fixCommand: FIX_CMD,
              message: '.gitignore not found at project root',
              pass: false,
            };
          }
          return {pass: true};
        },
        label: 'GITIGNORE_EXISTS',
      },
      children: [
        {
          check: {
            fn: (): CheckResult => {
              const content = readGitignore() ?? '';
              if (!content.includes('node_modules/')) {
                return {
                  fix: `Run: ${FIX_CMD}`,
                  fixCommand: FIX_CMD,
                  message: '.gitignore missing node_modules/',
                  pass: false,
                };
              }
              return {pass: true};
            },
            label: 'GITIGNORE_HAS_NODE_MODULES',
          },
        },
        {
          check: {
            fn: (): CheckResult => {
              const content = readGitignore() ?? '';
              if (!content.includes('tmp/')) {
                return {
                  fix: `Run: ${FIX_CMD}`,
                  fixCommand: FIX_CMD,
                  message: '.gitignore missing tmp/',
                  pass: false,
                };
              }
              return {pass: true};
            },
            label: 'GITIGNORE_HAS_TMP',
            severity: 'warn',
          },
        },
        // There is deliberately NO `.env` check here. The gitignore baseline
        // stopped seeding `.env` / `.env.local` in dchjw.6 (Justin, 2026-09-18:
        // the local pattern is `*.local`, `*.local.json`, `*.local.*`), so this
        // check warned on every repo that was CORRECT, and its fix command —
        // `add gitignore` — could not make it green. A check whose remedy does
        // not work is worse than no check: it teaches people to ignore doctor.
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// ESLint checks (eslint-setup component)
// ---------------------------------------------------------------------------

/**
 * Every ESLint flat config actually on disk, in ESLint's own resolution order.
 *
 * The name list is IMPORTED from eslint-setup rather than retyped, so the
 * check and the installer can never disagree about what counts as a config.
 */
function eslintConfigsPresent(projectRoot: string): string[] {
  return ESLINT_CONFIG_NAMES.filter((name) =>
    existsSync(resolve(projectRoot, name)),
  );
}

function makeEslintChecks(projectRoot: string): CheckNode[] {
  return [
    {
      check: {
        fn: (): CheckResult => {
          const installed = readPkgDevDep(projectRoot, 'eslint');
          if (installed == null) {
            return {
              fix: 'Run: bun run justin-sdk add eslint',
              fixCommand: 'bun run justin-sdk add eslint',
              message: 'eslint not in package.json devDependencies',
              pass: false,
            };
          }
          if (installed !== PINNED.eslint) {
            return {
              fix: `Update eslint to ${PINNED.eslint} (currently ${installed})`,
              message: `eslint ${installed} installed, pinned is ${PINNED.eslint}`,
              pass: false,
              severity: 'warn',
            };
          }
          return {message: `eslint ${installed}`, pass: true};
        },
        label: 'ESLINT_INSTALLED',
      },
    },
    {
      check: {
        fn: (): CheckResult => {
          const installed = readPkgDevDep(
            projectRoot,
            'eslint-config-jha-react-node',
          );
          if (installed == null) {
            return {
              fix: 'Run: bun run justin-sdk add eslint',
              fixCommand: 'bun run justin-sdk add eslint',
              message:
                'eslint-config-jha-react-node not in package.json devDependencies',
              pass: false,
            };
          }
          return {
            message: `eslint-config-jha-react-node ${installed}`,
            pass: true,
          };
        },
        label: 'JHA_CONFIG_INSTALLED',
      },
    },
    {
      check: {
        fn: (): CheckResult => {
          const found = eslintConfigsPresent(projectRoot);
          if (found.length === 0) {
            return {
              fix: 'Run: bun run justin-sdk add eslint',
              fixCommand: 'bun run justin-sdk add eslint',
              message: `No eslint config found (looked for ${ESLINT_CONFIG_NAMES.join(', ')})`,
              pass: false,
            };
          }
          return {message: found[0], pass: true};
        },
        label: 'ESLINT_CONFIG',
      },
      children: [
        {
          check: {
            fn: (): CheckResult => {
              const found = eslintConfigsPresent(projectRoot);
              if (found.length <= 1) {
                return {message: `one flat config: ${found[0]}`, pass: true};
              }
              return {
                fix: `Delete all but one of ${found.join(', ')} — keep the one you actually maintain.`,
                message: `${found.length} flat configs present (${found.join(', ')}); ESLint loads only ${found[0]} and the rest are dead code`,
                pass: false,
              };
            },
            // Two flat configs is a SILENT misconfiguration: ESLint resolves
            // the names in a fixed order and loads the FIRST one it finds, so
            // the other is dead code that still looks authoritative in the
            // editor. eslint-setup already refuses to create the second one
            // (dchjw.6) — this reports the ones that are already there, which
            // an installer that declines to write can never do.
            //
            // WARN, and no fixCommand: the remedy is deleting one of two files
            // and only the author knows which, so offering `--fix` a choice
            // here would be offering it a deletion.
            label: 'ESLINT_CONFIG_UNIQUE',
            severity: 'warn',
          },
        },
      ],
    },
    {
      check: {
        fn: (): CheckResult => {
          const script = readPkgScript(projectRoot, 'signal-source:LINT');
          if (script == null) {
            return {
              fix: 'Run: bun run justin-sdk add eslint',
              fixCommand: 'bun run justin-sdk add eslint',
              message: 'package.json missing signal-source:LINT script',
              pass: false,
            };
          }
          return {pass: true};
        },
        label: 'SIGNAL_SOURCE_LINT',
      },
    },
    {
      check: {
        fn: (): CheckResult => {
          const script = readPkgScript(projectRoot, 'fix-source:LINT');
          if (script == null) {
            return {
              fix: 'Run: bun run justin-sdk add eslint',
              fixCommand: 'bun run justin-sdk add eslint',
              message: 'package.json missing fix-source:LINT script',
              pass: false,
            };
          }
          return {pass: true};
        },
        label: 'FIX_SOURCE_LINT',
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Husky checks (husky-setup component)
// ---------------------------------------------------------------------------

function makeHuskyChecks(projectRoot: string): CheckNode[] {
  const FIX_CMD = 'bun run justin-sdk add husky';
  return [
    {
      check: {
        fn: (): CheckResult => {
          const installed = readPkgDevDep(projectRoot, 'husky');
          if (installed == null) {
            return {
              fix: `Run: ${FIX_CMD}`,
              fixCommand: FIX_CMD,
              message: 'husky not in package.json devDependencies',
              pass: false,
            };
          }
          if (installed !== PINNED.husky) {
            return {
              fix: `Update husky to ${PINNED.husky} (currently ${installed})`,
              message: `husky ${installed} installed, pinned is ${PINNED.husky}`,
              pass: false,
              severity: 'warn',
            };
          }
          return {message: `husky ${installed}`, pass: true};
        },
        label: 'HUSKY_INSTALLED',
      },
    },
    {
      check: {
        fn: (): CheckResult => {
          const installed = readPkgDevDep(projectRoot, 'lint-staged');
          if (installed == null) {
            return {
              fix: `Run: ${FIX_CMD}`,
              fixCommand: FIX_CMD,
              message: 'lint-staged not in package.json devDependencies',
              pass: false,
            };
          }
          if (installed !== PINNED['lint-staged']) {
            return {
              fix: `Update lint-staged to ${PINNED['lint-staged']} (currently ${installed})`,
              message: `lint-staged ${installed} installed, pinned is ${PINNED['lint-staged']}`,
              pass: false,
              severity: 'warn',
            };
          }
          return {message: `lint-staged ${installed}`, pass: true};
        },
        label: 'LINT_STAGED_INSTALLED',
      },
    },
    {
      check: {
        fn: (): CheckResult => {
          const hookPath = resolve(projectRoot, '.husky/pre-commit');
          if (!existsSync(hookPath)) {
            return {
              fix: `Run: ${FIX_CMD}`,
              fixCommand: FIX_CMD,
              message: '.husky/pre-commit not found',
              pass: false,
            };
          }
          const mode = statSync(hookPath).mode;
          // Husky v9 layout: core.hooksPath points at .husky/_, whose shim
          // SOURCES the user file — the exec bit on .husky/pre-commit is
          // irrelevant there (verified live: mode 644 + working hooks in
          // home-base). Only the legacy layout (no shim dir) executes the
          // user file directly and needs the bit. Warning on the v9 layout
          // would print at every session start, forever, about nothing.
          const hasV9Shim = existsSync(
            resolve(projectRoot, '.husky/_/pre-commit'),
          );
          if ((mode & 0o111) === 0 && !hasV9Shim) {
            return {
              fix: 'Run: chmod +x .husky/pre-commit',
              fixCommand: 'chmod +x .husky/pre-commit',
              message: '.husky/pre-commit exists but is not executable',
              pass: false,
              severity: 'warn',
            };
          }
          return {pass: true};
        },
        label: 'HUSKY_PRECOMMIT',
      },
    },
    {
      check: {
        fn: (): CheckResult => {
          const script = readPkgScript(projectRoot, 'prepare');
          if (script == null) {
            return {
              fix: `Run: ${FIX_CMD}`,
              fixCommand: FIX_CMD,
              message: 'package.json missing "prepare" script',
              pass: false,
            };
          }
          if (!script.includes('husky')) {
            return {
              fix: 'Ensure the "prepare" script invokes husky (e.g., "husky" or "husky install")',
              message: `"prepare" script does not reference husky (current: "${script}")`,
              pass: false,
              severity: 'warn',
            };
          }
          return {message: `prepare: ${script}`, pass: true};
        },
        label: 'PREPARE_SCRIPT',
      },
    },
    {
      check: {
        fn: (): CheckResult => {
          // lint-staged reads config from a package.json key OR a standalone
          // config file — home-base uses lint-staged.config.mjs (it filters
          // symlinks/submodule gitlinks, which a JSON key cannot). Accept the
          // documented file names, not just the key.
          const CONFIG_FILES = [
            '.lintstagedrc',
            '.lintstagedrc.json',
            '.lintstagedrc.yaml',
            '.lintstagedrc.yml',
            '.lintstagedrc.mjs',
            '.lintstagedrc.cjs',
            '.lintstagedrc.js',
            'lint-staged.config.mjs',
            'lint-staged.config.cjs',
            'lint-staged.config.js',
          ];
          const configFile = CONFIG_FILES.find((name) =>
            existsSync(resolve(projectRoot, name)),
          );
          if (configFile != null) {
            return {message: configFile, pass: true};
          }
          const pkgPath = resolve(projectRoot, 'package.json');
          if (!existsSync(pkgPath)) {
            return {
              fix: `Run: ${FIX_CMD}`,
              fixCommand: FIX_CMD,
              message: 'package.json not found',
              pass: false,
            };
          }
          try {
            const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as Record<
              string,
              unknown
            >;
            if (!('lint-staged' in pkg)) {
              return {
                fix: `Run: ${FIX_CMD}`,
                fixCommand: FIX_CMD,
                message:
                  'no lint-staged config (package.json key or config file)',
                pass: false,
              };
            }
            return {pass: true};
          } catch {
            return {
              message: 'package.json is not valid JSON',
              pass: false,
            };
          }
        },
        label: 'LINT_STAGED_CONFIG',
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Critical-rules checks (critical-rules-setup component)
// ---------------------------------------------------------------------------

/**
 * Is the committed rules artifact the canonical one? (home-base-si46, D4/D5)
 *
 * The verdict comes from `checkRulesDrift` — the SAME function
 * SessionStart notice uses, so doctor and the session can never tell Justin two
 * different stories about one file. This check only decides how to say it.
 *
 * WARN, NEVER ERROR, for every unhappy state. Out-of-date rules are a nag, not a
 * broken environment: doctor runs at every session start (`doctor --quiet` via
 * the setup-env hook), and making stale rules exit non-zero would turn a routine
 * "there's an update" into a red gate on unrelated work.
 *
 * CANNOT-CHECK IS A WARN TOO, NOT A PASS (D5, critical rule 5). A failed refresh
 * leaves a usable-looking clone behind; certifying the artifact from it — or
 * silently passing because we could not tell — is the exact failure this whole
 * epic exists to prevent.
 *
 * THE FIXER IS IN-PROCESS, WRITE-ONLY, AND NEVER SHELLS OUT (home-base-r47v F1,
 * closing the si46 hole). `--fix` mode calls `refreshCriticalRulesArtifact`
 * directly, which writes exactly one path and never commits — which is the whole
 * requirement for the remote session-start path (`doctor --fix --yes` from
 * setup-env-command.ts): D4 says the write is "either committed with the session
 * work or discarded harmlessly". Neither shell command could do that
 * (`rules-update` COMMITS — it is the pull channel; `add critical-rules` re-runs
 * the whole installer, touching config and the SDK pin), and every fixCommand is
 * spawned in `process.cwd()`, which is not necessarily this `projectRoot`
 * (`runDoctor(target, …)` — home-base-6dni). A closure over projectRoot cannot
 * miss.
 *
 * ONLY `missing` AND `stale` GET A FIXER — the two states where "regenerate from
 * the recorded selection" is unambiguously right:
 *   locally-modified  a regenerate would either overwrite a human's edit (with
 *                     --force) or, without it, no-op and report success while
 *                     the file stays wrong — the advice (rules-diff first) is
 *                     the correct remedy and it needs a human.
 *   cannot-check      the source could not be verified, and the writer REFUSES
 *                     to write from an unverified checkout (D15). Offering a
 *                     fixer here would print a loud failure at every offline
 *                     session start while changing nothing.
 * A state with no fixer simply warns — no fix is attempted, so nothing can fail
 * quietly.
 */
function makeCriticalRulesChecks(projectRoot: string): CheckNode[] {
  return [
    {
      check: {
        fn: (): CheckResult => {
          const message = legacyModulesWarning(projectRoot);
          return message == null
            ? {pass: true}
            : {
                fix: `delete componentConfig["${CRITICAL_RULES_CONFIG_KEY}"].${RETIRED_MODULES_KEY} from justin-sdk.config.json`,
                message,
                pass: false,
                severity: 'warn',
              };
        },
        /**
         * The retired per-repo module include-list (epic home-base-dchjw D2).
         *
         * A config carrying `componentConfig["critical-rules"].modules` is not
         * broken — the key is simply ignored — so this warns and never errors.
         * There is no fixer: deleting a key from a human's config file is the
         * fleet sweep's job (dchjw.10), not a session-start side effect.
         *
         * PURE, and it must stay pure: check-runner re-runs every check after a
         * fix, so a latched "already warned once" flag here would report a
         * still-present key as green on the second pass.
         */
        label: 'RULES_MODULES_LEGACY',
        severity: 'warn',
      },
    },
    {
      check: {
        fn: (): CheckResult => {
          const drift = checkRulesDrift(projectRoot);
          if (!isRulesDriftProblem(drift.status)) return {pass: true};
          const advice = rulesDriftAdvice(drift.status);
          const writable =
            drift.status === 'missing' || drift.status === 'stale';
          return {
            ...(advice != null ? {fix: advice} : {}),
            ...(writable
              ? {
                  fixFn: (): void => {
                    const outcome = refreshCriticalRulesArtifact(projectRoot);
                    if (!refreshSucceeded(outcome)) {
                      // Loud, not silent: check-runner reports a thrown fixer as
                      // a fix FAILURE. Returning quietly here would leave the
                      // re-check red with no explanation of why the write
                      // did not happen (critical rule 5).
                      throw new Error(
                        `could not write the rules artifact (${outcome.status}): ${outcome.message}`,
                      );
                    }
                  },
                }
              : {}),
            message: `${drift.status}: ${drift.message}`,
            pass: false,
            severity: 'warn',
          };
        },
        label: 'RULES_ARTIFACT',
        severity: 'warn',
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Legacy-artifact checks (NOT keyed to a component — they run everywhere)
// ---------------------------------------------------------------------------

/**
 * The leftovers of the retired `prompts` and `claude-md` components (epic
 * home-base-dchjw D3, absorbing dchjw.9's legacy check).
 *
 * These deliberately belong to no component: the components that produced them
 * are DELETED, so a check keyed to either retired name would only ever run in a
 * repo whose config still names a component this SDK no longer has. The
 * artifacts on disk are the evidence, not the config.
 *
 * `severity: 'warn'` — a repo carrying them is stale, not broken, and the remedy
 * (`migrate-to-prime`) deletes files, so it is offered as advice and never as a
 * `fixCommand` doctor could run for you.
 */
function makeLegacyArtifactChecks(projectRoot: string): CheckNode[] {
  const ADVICE = 'Run: bun run justin-sdk migrate-to-prime';
  return [
    {
      check: {
        fn: (): CheckResult => {
          const found: string[] = [];
          if (existsSync(resolve(projectRoot, 'docs/prompts'))) {
            found.push('docs/prompts/');
          }
          if (
            existsSync(
              resolve(projectRoot, 'docs/.prompts-installed-from.json'),
            )
          ) {
            found.push('docs/.prompts-installed-from.json');
          }
          if (readPkgScript(projectRoot, 'install-my-prompts') != null) {
            found.push('the install-my-prompts package.json script');
          }
          if (found.length === 0) return {pass: true};
          return {
            fix: ADVICE,
            message: `${found.join(' + ')} left over from the retired prompts component — run migrate-to-prime`,
            pass: false,
          };
        },
        label: 'NO_LEGACY_PROMPTS',
        severity: 'warn',
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Threads rules (D-RULES-DOCTOR, home-base-yukaf.26) — NOT keyed to a component
// ---------------------------------------------------------------------------

/**
 * THREAD_RULES: are the files in `.claude/rules/justin-sdk/` that this repo
 * should carry (threadRulesFilesFor: status-report-format.md and requests.md,
 * plus handoff.md where componentConfig.thread.handoff.successor is on) the
 * SDK's bytes, and is there a handoff.md where the knob is off?
 *
 * It runs in every repo rather than only where `thread-rules-setup` is listed,
 * because the case that matters most is a repo where threads are ON and the
 * component is NOT listed (a config with an explicit `components` list written
 * before the component existed): Claude there gets the thread hooks and no
 * instructions for them. Checking only listed repos would never see it.
 *
 *   both match                     → ok
 *   missing, threads on            → warn; advice `install` (or `add
 *                                    thread-rules` where the config does not
 *                                    list it)
 *   missing, threads off           → ok: nothing is expected
 *   present but different          → warn with the command (install
 *                                    overwrites; a local edit is a human's
 *                                    call)
 *   unreadable (file or template)  → warn "could not check" — never "missing"
 *                                    and never "ok" (critical rule 7)
 *   handoff.md present, successor  → warn, naming whether it is the SDK's
 *   off (home-base-jm5kg.8)          copy; install never removes it, so this
 *                                    is where it is seen
 *   successor knob unreadable      → warn "could not check" for handoff.md
 *
 * ADVICE ONLY: no `fixCommand` and no `fixFn`, in any state. Doctor warns and
 * never fixes on its own, and a `fixCommand` runs in `process.cwd()`, not in
 * the repo this check examined: the first version had one, and `doctor --fix`
 * in tests/rules-drift.test.ts ran `add thread-rules` inside pkg/justin-sdk
 * itself (yukaf.26, found by the full suite).
 */
export function makeThreadRulesChecks(
  projectRoot: string,
  resolvedComponents: readonly string[],
  // Injectable so a test can reach the unknown branch: a real config that
  // reads but is invalid resolves to off, so nothing on disk makes it throw.
  readHandoffKnob: (
    root: string,
  ) => Promise<HandoffSuccessorKnob> = handoffSuccessorKnob,
): CheckNode[] {
  return [
    {
      check: {
        fn: async (): Promise<CheckResult> => {
          const all = threadRulesState(projectRoot);
          // `await import`: thread/config reaches sdk-config and zod, which
          // must stay off cli-main's static import graph (the hooks' startup
          // cost; tests/health-notices-cli.test.ts).
          const {resolveThreadConfig} = await import('./thread/config');
          const enabled = resolveThreadConfig({cwd: projectRoot}).enabled;
          const listed = resolvedComponents.includes(
            configNameFor('thread-rules'),
          );
          const command = listed
            ? `${SDK_RUN} install`
            : `${SDK_RUN} add thread-rules`;

          // home-base-jm5kg.8: handoff.md belongs only where the successor
          // knob is on. Unknown knob: the file is judged neither expected nor
          // stray, and the check says it could not tell (critical rule 7).
          const knob = await readHandoffKnob(projectRoot);
          const handoffRel = threadRulesInstalledPath(HANDOFF_RULE_FILE);
          const wanted = threadRulesFilesFor(knob.kind === 'on');
          const states = all.filter((state) => wanted.includes(state.file));
          const stray =
            knob.kind === 'off'
              ? (all.find(
                  (state) =>
                    state.file === HANDOFF_RULE_FILE &&
                    state.kind !== 'missing',
                ) ?? null)
              : null;

          const unchecked = [
            ...(knob.kind === 'unknown'
              ? [
                  `whether ${handoffRel} belongs here (componentConfig.thread.handoff.successor could not be read: ${knob.reason})`,
                ]
              : []),
            ...states.flatMap((state) =>
              state.kind === 'unreadable'
                ? [`${threadRulesInstalledPath(state.file)} (${state.reason})`]
                : state.kind === 'template-unreadable'
                  ? [`the SDK template for ${state.file}`]
                  : [],
            ),
          ];
          if (unchecked.length > 0) {
            return {
              message: `could not check: ${unchecked.join('; ')} — NOT verified`,
              pass: false,
              severity: 'warn',
            };
          }

          const drifted = states
            .filter((state) => state.kind === 'drifted')
            .map((state) => threadRulesInstalledPath(state.file));
          const problems: string[] = [];
          const fixes: string[] = [];
          if (drifted.length > 0) {
            problems.push(
              `${drifted.join(', ')} differ${drifted.length === 1 ? 's' : ''} from the SDK's copy`,
            );
            fixes.push(
              `Run: ${command} (it replaces them with the SDK's copy; look at the diff first if you edited them)`,
            );
          }
          if (stray != null) {
            // Install never removes, so this is the only place a stray
            // handoff rule is named after the run that left it.
            problems.push(
              `${handoffRel} is here, but componentConfig.thread.handoff.successor is off: it teaches thread handoff and spawn to sessions in a repo where they are not on, and install never removes it`,
            );
            fixes.push(
              stray.kind === 'matches'
                ? `It is byte-identical to the SDK's copy, so deleting it loses nothing: git rm ${handoffRel}`
                : stray.kind === 'drifted'
                  ? `It differs from the SDK's copy: read it before you delete it with git rm ${handoffRel}`
                  : `It could not be compared with the SDK's copy: read it before you delete it with git rm ${handoffRel}`,
            );
          }
          if (problems.length > 0) {
            return {
              fix: fixes.join(' '),
              message: problems.join('; '),
              pass: false,
              severity: 'warn',
            };
          }

          const missing = states
            .filter((state) => state.kind === 'missing')
            .map((state) => threadRulesInstalledPath(state.file));
          if (missing.length > 0 && enabled) {
            return {
              fix: `Run: ${command}`,
              message: `threads are on here (componentConfig.thread.enabled) but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing`,
              pass: false,
              severity: 'warn',
            };
          }
          if (missing.length === states.length) {
            return {
              message:
                'threads are off here, and no thread rules are installed',
              pass: true,
            };
          }
          if (missing.length > 0) {
            return {
              message: `threads are off here; ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing, and the rest match the SDK's copy`,
              pass: true,
            };
          }
          return {
            message: `${states.length} rule files match the SDK's copy${knob.kind === 'off' ? ` (${HANDOFF_RULE_FILE} is not expected here: componentConfig.thread.handoff.successor is off)` : ''}`,
            pass: true,
          };
        },
        label: 'THREAD_RULES',
        severity: 'warn',
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// The thread handoff sandbox exclusion (home-base-mbnjv.6, D4) — only where
// componentConfig.thread.handoff.successor is on
// ---------------------------------------------------------------------------

/**
 * HANDOFF_SANDBOX as a CheckResult. Exported for tests.
 *
 * Does `~/.claude/settings.json` let `thread handoff` run outside the sandbox
 * (a `sandbox.excludedCommands` entry) without a classifier review (a
 * `permissions.allow` rule)? See thread/handoff-sandbox.ts.
 *
 * WARN, READ-ONLY, ADVICE ONLY, as USER_LEVEL_SESSION_START: the SDK never
 * writes user settings, so there is no fixCommand and no fixFn. A file that
 * cannot be read or parsed is UNKNOWN, never "missing" (critical rule 7).
 */
export function handoffSandboxCheckResult(
  env: Record<string, string | undefined> = process.env,
): CheckResult {
  const status = checkHandoffSandbox(env);
  if (status.kind === 'cannot-check') {
    return {
      fix: handoffSandboxCannotCheckAdvice(),
      message: `${USER_SETTINGS_DISPLAY} could not be read or parsed (${status.reason}) — whether it lets \`${HANDOFF_COMMAND_DISPLAY}\` run outside the sandbox is UNKNOWN, not "missing"`,
      pass: false,
      severity: 'warn',
    };
  }

  const exclusionBy = status.exclusions.map((item) => item.by);
  const allowBy = status.allowRules.map((item) => item.by);
  if (
    exclusionBy.every((by) => by != null) &&
    allowBy.every((by) => by != null)
  ) {
    return {
      message: `${USER_SETTINGS_DISPLAY} covers \`${HANDOFF_COMMAND_DISPLAY}\`: sandbox.excludedCommands ${exclusionBy.map((by) => `\`${by}\``).join(', ')}; permissions.allow ${allowBy.map((by) => `\`${by}\``).join(', ')}`,
      pass: true,
    };
  }

  const missing = [
    ...(exclusionBy.every((by) => by != null)
      ? []
      : [
          'no sandbox.excludedCommands entry covers it, so a handoff runs inside the sandbox, cannot reach cmux, and is refused',
        ]),
    ...(allowBy.every((by) => by != null)
      ? []
      : [
          'no permissions.allow rule covers it, so in auto mode every handoff waits for the auto-mode classifier',
        ]),
  ];
  return {
    fix: handoffSandboxAdvice(status),
    message: `componentConfig.thread.handoff.successor is on here, and ${status.fileExists ? USER_SETTINGS_DISPLAY : `${USER_SETTINGS_DISPLAY}, which does not exist,`} does not cover \`${HANDOFF_COMMAND_DISPLAY}\`: ${missing.join('; ')}`,
    pass: false,
    severity: 'warn',
  };
}

/**
 * The HANDOFF_SANDBOX node. planDoctor adds it ONLY where the knob is on (the
 * check does not run, and prints nothing, where it is off: nothing then needs
 * the exclusion), and adds it AFTER withRunnableFixes: its advice is JSON to
 * paste, and a `bun install && ` prefix would make that JSON wrong. (Its
 * entries name `./node_modules/.bin/justin-sdk` since home-base-mbnjv.10, which
 * withRunnableFixes does not rewrite, but the JSON must stay out of its reach
 * whatever it names.)
 */
export function makeHandoffSandboxChecks(
  env: Record<string, string | undefined> = process.env,
): CheckNode[] {
  return [
    {
      check: {
        fn: (): CheckResult => handoffSandboxCheckResult(env),
        label: 'HANDOFF_SANDBOX',
        severity: 'warn',
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Components that APPLY here but are not installed (informational)
// ---------------------------------------------------------------------------

/**
 * The one thing `list` can see that no per-component check can: a component
 * whose `includeIf` predicates pass in this repo and which is simply not here —
 * `eas` in an Expo app that was enrolled before the component existed.
 *
 * Components are a per-repo list, so a new one reaches the fleet only through a
 * sweep (epic home-base-dchjw D3). This is the detector for the repos a sweep
 * has not reached, and the reason it lives in doctor is that doctor is the
 * thing that already runs everywhere.
 *
 * NEVER FAILS. It is an info line, not a verdict: nothing is wrong with a repo
 * that has decided it does not want a component, and a check that went red over
 * an available extra would fail SessionStart hooks and sweep gates fleet-wide.
 * Passing checks print their message but are suppressed under `--quiet`, which
 * is exactly the right audience — a human running `doctor`, not a hook.
 */
function makeComponentAvailabilityChecks(projectRoot: string): CheckNode[] {
  return [
    {
      check: {
        fn: (): CheckResult => {
          const listing = buildComponentListing(projectRoot);
          if (listing.problem != null) {
            // Rule 6: say that nothing was measured, never print the
            // reassuring "everything that applies is installed".
            return {
              message: `could not resolve the config (${listing.problem}) — availability NOT checked`,
              pass: true,
            };
          }
          const available = listing.rows.filter(
            (row) => row.applicable && !row.installed && !row.resolved,
          );
          if (available.length === 0) {
            return {
              message:
                'every component that applies to this repo is installed or already listed',
              pass: true,
            };
          }
          const names = available.map((row) => row.name).join(', ');
          return {
            message: `applies here but is not installed: ${names} — add with \`${SDK_RUN} add ${available[0]?.name ?? ''}\``,
            pass: true,
          };
        },
        label: 'COMPONENTS_AVAILABLE',
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Making the advice runnable
// ---------------------------------------------------------------------------

/**
 * `bun run justin-sdk …` resolves through `node_modules/.bin`, so in a checkout
 * that has never been hydrated — a fresh worktree, a fresh clone, a cloud
 * container before `setup-env` — every fix doctor offers fails with
 * `error: Script not found` and the operator is left with advice that cannot
 * work. Where the bin is absent, say what has to happen first.
 *
 * Applied in ONE place (`withRunnableFixes` below) rather than at each of the
 * ~30 call sites, so a check added later gets it for free, and applied to the
 * displayed `fix` as well as the executed `fixCommand` — prefixing only the
 * latter would leave the printed advice the same dead end it was.
 */
function needsInstallFirst(projectRoot: string): boolean {
  return !existsSync(
    resolve(projectRoot, 'node_modules', '.bin', 'justin-sdk'),
  );
}

const INSTALL_PREFIX = 'bun install && ';

function prefixSdkCommands(text: string): string {
  return text.split(SDK_RUN).join(`${INSTALL_PREFIX}${SDK_RUN}`);
}

/** Wrap every check in the tree so its result's fix advice is runnable here. */
function withRunnableFixes(
  nodes: CheckNode[],
  projectRoot: string,
): CheckNode[] {
  if (!needsInstallFirst(projectRoot)) return nodes;
  return nodes.map((node) => {
    const original = node.check.fn;
    return {
      check:
        original == null
          ? node.check
          : {
              ...node.check,
              fn: async (): Promise<CheckResult> => {
                const result = await original();
                if (result.fix == null && result.fixCommand == null) {
                  return result;
                }
                return {
                  ...result,
                  ...(result.fix == null
                    ? {}
                    : {fix: prefixSdkCommands(result.fix)}),
                  ...(result.fixCommand == null
                    ? {}
                    : {fixCommand: prefixSdkCommands(result.fixCommand)}),
                };
              },
            },
      ...(node.children == null
        ? {}
        : {children: withRunnableFixes(node.children, projectRoot)}),
    };
  });
}

// ---------------------------------------------------------------------------
// Component registry
// ---------------------------------------------------------------------------

// A component with no entry here simply has no doctor checks — see the
// skip-with-no-warning loop in runDoctor.
const componentCheckFactories: Record<
  string,
  (projectRoot: string) => CheckNode[]
> = {
  'base-setup': makeBaseChecks,
  'beads-setup': makeBeadsChecks,
  'critical-rules-setup': makeCriticalRulesChecks,
  'eslint-setup': makeEslintChecks,
  'gh-actions-setup': makeGhActionsChecks,
  'gitignore-setup': makeGitignoreChecks,
  'husky-setup': makeHuskyChecks,
  'prettier-setup': makePrettierChecks,
  'tsconfig-setup': makeTsconfigChecks,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DoctorOptions {
  fix?: boolean;
  quiet?: boolean;
  /** Pre-approve fixes that require approval (system-level installs). */
  yes?: boolean;
}

/**
 * Doctor's own report, as text, rather than as something already printed.
 *
 * `report` is what a CLI run would have written to STDOUT, verbatim and with
 * its ANSI colours intact — an empty string when there was nothing to say (a
 * `--quiet` run where everything passed says one line, so that case is not it).
 */
export interface DoctorReport {
  exitCode: number;
  report: string;
}

/** Everything doctor needs before it can run, or why it cannot. */
type DoctorPlan =
  | {componentCount: number; nodes: CheckNode[]; ok: true}
  | {error: string; ok: false};

/** The HANDOFF_SANDBOX nodes for this repo: none where the knob is off. */
async function handoffSandboxNodes(projectRoot: string): Promise<CheckNode[]> {
  const knob = await handoffSuccessorKnob(projectRoot);
  switch (knob.kind) {
    case 'off':
      return [];
    case 'on':
      return makeHandoffSandboxChecks();
    case 'unknown':
      return [
        {
          check: {
            fn: (): CheckResult => ({
              message: `could not read componentConfig.thread.handoff.successor (${knob.reason}) — whether this repo needs the thread handoff sandbox exclusion is UNKNOWN, so it was NOT checked`,
              pass: false,
              severity: 'warn',
            }),
            label: 'HANDOFF_SANDBOX',
            severity: 'warn',
          },
        },
      ];
  }
}

/**
 * Resolve the config and assemble the check tree.
 *
 * Separated from running it so `runDoctor` and `renderDoctor` cannot drift:
 * both take their checks, and their refusals, from here.
 */
async function planDoctor(projectRoot: string): Promise<DoctorPlan> {
  const configPath = resolve(projectRoot, 'justin-sdk.config.json');

  if (!existsSync(configPath)) {
    return {
      error:
        'Error: justin-sdk.config.json not found. Create one — `{}` is a complete config (components defaults to the core preset) — or run `bun run justin-sdk add base-setup`.',
      ok: false,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (error) {
    return {
      error: `Error: justin-sdk.config.json is not valid JSON (${error instanceof Error ? error.message : String(error)}). Doctor did not run — this is NOT a clean bill of health.`,
      ok: false,
    };
  }

  const resolved = resolveComponents(parsed, projectRoot);
  if (!resolved.ok) {
    return {
      error: `Error: ${resolved.reason}. Doctor did not run — this is NOT a clean bill of health.`,
      ok: false,
    };
  }
  const components = resolved.components;

  const nodes: CheckNode[] = [
    ...makeLegacyArtifactChecks(projectRoot),
    ...makeComponentAvailabilityChecks(projectRoot),
    ...makeThreadRulesChecks(projectRoot, components),
  ];
  for (const component of components) {
    const factory = componentCheckFactories[component];
    if (factory != null) {
      nodes.push(...factory(projectRoot));
    }
  }

  return {
    componentCount: components.length,
    nodes: [
      ...withRunnableFixes(nodes, projectRoot),
      // After withRunnableFixes on purpose: see makeHandoffSandboxChecks.
      ...(await handoffSandboxNodes(projectRoot)),
    ],
    ok: true,
  };
}

/**
 * With the legacy and availability checks always present this is unreachable,
 * but it is kept as the honest answer if it ever becomes reachable again: say
 * that nothing was checked, never imply that something was and passed.
 */
function emptyPlanMessage(componentCount: number): string {
  return `No doctor checks registered for the ${componentCount} resolved component(s).`;
}

function checkTreeOptions(
  options: DoctorOptions,
): Parameters<typeof runCheckTree>[1] {
  return {
    align: true,
    fix: options.fix,
    quiet: options.quiet,
    yes: options.yes,
  };
}

/**
 * Run doctor checks for the components this repo's config RESOLVES to, printing
 * the report as it goes.
 *
 * "Resolves to", not "lists": an absent `components` key means the core preset
 * (constraint F1). It used to mean an empty list, so a repo whose config had no
 * `components` — which after D3 is the recommended shape — ran zero checks and
 * printed a calm "No doctor checks registered", which reads as "nothing is
 * wrong" and meant "I did not look" (critical rule 6).
 *
 * @param projectRoot - Path to the project root (defaults to cwd)
 * @param options - Doctor options (fix, quiet, yes)
 * @returns Process exit code (0 = all pass, 1 = any fail)
 */
export async function runDoctor(
  projectRoot: string = process.cwd(),
  options: DoctorOptions = {},
): Promise<number> {
  const plan = await planDoctor(projectRoot);
  if (!plan.ok) {
    console.error(plan.error);
    return 1;
  }
  if (plan.nodes.length === 0) {
    console.log(emptyPlanMessage(plan.componentCount));
    return 0;
  }
  return await runCheckTree(plan.nodes, checkTreeOptions(options));
}

/**
 * The same run, RETURNED instead of printed — for `session-start`, where stdout
 * belongs to the SessionStart JSON envelope and anything doctor wrote there
 * would corrupt it into unparseable text.
 *
 * This replaced monkey-patching `console.log` and `process.stdout.write` around
 * `runDoctor` (needed because in Bun those are two independent channels), which
 * worked but was a global side effect in front of arbitrary check code, and
 * silently captured anything else the process happened to print meanwhile.
 *
 * A refusal is part of the REPORT here, not a stderr line: the caller is
 * building a context block, and "doctor did not run" is exactly the thing that
 * must not go missing from it (rule 6).
 */
export async function renderDoctor(
  projectRoot: string = process.cwd(),
  options: DoctorOptions = {},
): Promise<DoctorReport> {
  const plan = await planDoctor(projectRoot);
  if (!plan.ok) {
    return {exitCode: 1, report: plan.error};
  }
  if (plan.nodes.length === 0) {
    return {exitCode: 0, report: emptyPlanMessage(plan.componentCount)};
  }
  return await renderCheckTree(plan.nodes, checkTreeOptions(options));
}
