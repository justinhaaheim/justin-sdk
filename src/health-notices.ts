/**
 * health-notices.ts — the mechanism behind "a newer justin-sdk is available"
 * (home-base-uxwc D1, D4, D5, D7).
 *
 * Justin's problem, in his words (2026-09-09): "I have not been consistent and
 * diligent about upgrading justin-sdk across my projects" — troubleshooting
 * sessions that ended in "oh, this repo is pinned to a version from 2 months
 * ago". The fix is a notice that finds him where he already is: on stderr, in
 * front of a command he was running anyway.
 *
 * FOUR INVARIANTS, in force order. Everything below exists to keep them.
 *
 *  1. NEVER CHANGE WHAT A COMMAND DOES. Nothing here writes stdout, throws into
 *     a caller, or influences an exit code. `worktree-new` prints one path,
 *     `justin-loop handoff` prints one bead id, `setup-env` prints nothing —
 *     three stdout contracts that a chatty notice would silently corrupt.
 *  2. NEVER SPEAK WHEN NOT ASKED. Tiers (D1) and per-kind throttles decide
 *     whether a notice is allowed out; the kill switch, CI and remote sessions
 *     switch the whole thing off before any of it runs.
 *  3. NEVER FETCH MORE THAN ONCE AN INTERVAL — including after a FAILURE. A
 *     failed check stamps the clock exactly as a successful one does, so an
 *     offline laptop makes one doomed 5s call an hour, not one per command.
 *  4. NEVER REPORT A CHECK THAT DID NOT RUN AS "UP TO DATE" (critical rule 6).
 *     "the newest tag is 0.26.0", "we could not ask", "we never asked" and "you
 *     told us not to ask" are four facts with four representations, and the
 *     reassuring one is only ever produced by an actual measurement.
 *
 * WHY THIS MODULE IMPORTS ONLY NODE BUILTINS AT THE TOP. `cli.ts` runs its
 * notice middleware for EVERY command, and the middleware must consult the
 * classification table below before it can know whether a command is eligible —
 * so this module is loaded even by `time-check`, `usage-check` and `prime`,
 * the UserPromptSubmit/SessionStart hooks that run on Justin's keystrokes.
 * `zod` alone costs 12-13ms to import against a 40-50ms CLI startup, so
 * `sdk-config`, `semver`, `sdk-latest` and `setup-helpers` are all `await
 * import`ed inside the functions that need them, and a NEVER command returns
 * having loaded nothing but this file.
 */

import {mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'fs';
import {homedir} from 'os';
import {dirname, join, resolve} from 'path';

import type {
  EnvLike,
  PromptTier,
  ResolvedHealthNoticesConfig,
} from './sdk-config';
import type {SdkTagFetcher} from './sdk-latest';

// ---------------------------------------------------------------------------
// Command classification (D1)
// ---------------------------------------------------------------------------

/**
 * Commands a notice may interrupt beyond `doctor`: interactive, human-typed,
 * and none of them has an output contract another program parses.
 */
export const SELECT_COMMANDS = [
  'add',
  'fix',
  'init',
  'rules-diff',
  'rules-update',
  'setup-env',
  'signal',
  'sync-rules',
  'worktree-new',
] as const;

/**
 * Commands that must NEVER carry a notice, for two different reasons:
 *
 *  - `time-check`, `usage-check` and `prime` are HOOKS. Their output is
 *    injected into a Claude session's context, and their cost is paid on every
 *    prompt Justin types.
 *  - `update` and `sweep` ARE the upgrade. Telling someone mid-upgrade that an
 *    upgrade is available is noise at best and confusing at worst.
 *  - `skill` prints a document meant to be read whole, and `justin-loop
 *    handoff` prints a bead id on stdout that the runner parses.
 *
 * `--help` needs no entry: yargs resolves help BEFORE middleware runs
 * (measured 2026-09-10), so a notice can never reach it.
 */
export const NEVER_COMMANDS = [
  'justin-loop handoff',
  'prime',
  'skill',
  'sweep',
  'time-check',
  'update',
  'usage-check',
] as const;

/**
 * Every top-level command the CLI registers. Not used at runtime — its job is
 * to FAIL a test when a new command is added without anyone deciding which
 * list it belongs in (tests/health-notices-commands.test.ts derives the real
 * names from `justin-sdk --help` and compares). Anything here that is in
 * neither list above runs at tier 4, deliberately.
 */
export const ALL_COMMANDS = [
  'add',
  'beads-rebuild-dryrun',
  'config',
  'doctor',
  'eas-update',
  'fix',
  'init',
  'justin-loop',
  'migrate-to-prime',
  'prime',
  'repo-status',
  'rules-diff',
  'rules-update',
  'setup-env',
  'signal',
  'skill',
  'sweep',
  'sync-rules',
  'time-check',
  'update',
  'usage-check',
  'worktree-new',
] as const;

/**
 * yargs aliases, mapped to the command they alias. An alias is classified as
 * its primary — it is the same code path, and a second entry in the tier lists
 * is a second thing to forget.
 */
export const COMMAND_ALIASES: Readonly<Record<string, string>> = {
  agent: 'skill',
  'worktree-setup': 'setup-env',
};

/** Resolve an alias to its primary; anything else is returned unchanged. */
export function canonicalCommandName(name: string): string {
  return COMMAND_ALIASES[name] ?? name;
}

/**
 * The command words yargs parsed (`argv._`), as ONE classification key.
 *
 * `justin-loop handoff` is classified as a unit — including its `validate`
 * subcommand — because the whole subtree writes machine-read stdout, while
 * `justin-loop` itself is an ordinary long-running command.
 */
export function commandNameFromArgv(
  words: readonly (number | string)[],
): string | null {
  const first = words[0];
  if (first == null) return null;
  const name = canonicalCommandName(String(first));
  if (name === 'justin-loop' && String(words[1] ?? '') === 'handoff') {
    return 'justin-loop handoff';
  }
  return name;
}

/**
 * How loud this callsite is (D1). Compared against a notice's configured
 * `promptTier`: the notice speaks when `callsiteTier <= promptTier`, so
 * `promptTier: 1` is below every callsite and never speaks at all.
 *
 * null means "this command carries no notice, whatever the config says".
 */
export function callsiteTier(commandName: string | null): PromptTier | null {
  if (commandName == null) return null;
  const name = canonicalCommandName(commandName);
  if ((NEVER_COMMANDS as readonly string[]).includes(name)) return null;
  if (name === 'doctor') return 2;
  if ((SELECT_COMMANDS as readonly string[]).includes(name)) return 3;
  return 4;
}

// ---------------------------------------------------------------------------
// State file (D4)
// ---------------------------------------------------------------------------

/**
 * Bumped when a change would make an OLDER SDK misread a NEWER file. An
 * unrecognised version reads as absent, so the old SDK re-checks rather than
 * acting on a shape it does not understand.
 */
export const STATE_SCHEMA_VERSION = 1;

export type VersionBumpKind = 'major' | 'minor' | 'patch';

export const VERSION_BUMP_KINDS: readonly VersionBumpKind[] = [
  'major',
  'minor',
  'patch',
];

/** The most recent ATTEMPT to ask for the newest tag. */
export interface LastCheckRow {
  /** ISO time of the attempt — stamped whether it succeeded or failed (D5). */
  at: string;
  /** Why it failed. null iff `ok`. */
  error: string | null;
  /** What it found. null iff not `ok` — never carried forward from an
   * earlier success, which is what `lastKnownLatest` is for. */
  latest: string | null;
  ok: boolean;
}

/** The most recent SUCCESSFUL answer, and when it was measured. */
export interface LastKnownLatestRow {
  at: string;
  version: string;
}

/** One heartbeat doctor run, per repo. Written by home-base-uxwc.3. */
export interface DoctorRunRow {
  at: string;
  errors: number;
  passed: number;
  warnings: number;
}

export interface HealthNoticesState {
  /** projectRoot -> the last heartbeat doctor run there (D8; written by .3). */
  doctorRuns: Record<string, DoctorRunRow>;
  lastCheck: LastCheckRow | null;
  lastKnownLatest: LastKnownLatestRow | null;
  /** projectRoot -> kind -> ISO time that notice was last printed (D1). */
  lastNotified: Record<string, Partial<Record<VersionBumpKind, string>>>;
  schemaVersion: number;
}

/**
 * Why there is no usable state. All four read as "we know nothing yet" — but
 * they are four different facts and the reason travels with the outcome, so a
 * permissions problem is never silently indistinguishable from a first run.
 */
export type StateAbsentReason =
  | 'invalid-json'
  | 'no-file'
  | 'unknown-schema-version'
  | 'unknown-shape'
  | 'unreadable';

export type StateReadOutcome =
  | {
      detail: string | null;
      path: string;
      reason: StateAbsentReason;
      status: 'absent';
    }
  | {path: string; state: HealthNoticesState; status: 'ok'};

export interface HealthNoticesPaths {
  dir: string;
  file: string;
}

/**
 * `$XDG_STATE_HOME`, or `$HOME/.local/state` — the same directory the
 * justin-loop ledger uses (src/justin-loop/runner.ts DEFAULT_STATE_DIR).
 *
 * Unlike `xdgConfigHome()` in sdk-config.ts, the HOME fallback goes to
 * `homedir()` rather than `''`: this path is WRITTEN to, and an empty HOME
 * would resolve it under the current working directory — i.e. drop a state
 * file inside whichever repo happened to be checked out.
 */
export function xdgStateHome(env: EnvLike = process.env): string {
  const fromEnv = env.XDG_STATE_HOME;
  if (fromEnv != null && fromEnv.length > 0) return fromEnv;
  return resolve(
    env.HOME != null && env.HOME.length > 0 ? env.HOME : homedir(),
    '.local',
    'state',
  );
}

export function healthNoticesPaths(
  env: EnvLike = process.env,
): HealthNoticesPaths {
  const file = join(xdgStateHome(env), 'justin-sdk', 'health-notices.json');
  return {dir: dirname(file), file};
}

/** A state with nothing known yet. Not a failure — a first run. */
export function emptyState(): HealthNoticesState {
  return {
    doctorRuns: {},
    lastCheck: null,
    lastKnownLatest: null,
    lastNotified: {},
    schemaVersion: STATE_SCHEMA_VERSION,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

/**
 * Validate by hand rather than with zod: this module is on the hook hot path
 * (see the file header), and the shape is four fields deep.
 *
 * Returns null when anything is off — a state file we do not fully understand
 * is treated as no state at all, never as a partially-trusted one.
 */
function parseState(value: unknown): HealthNoticesState | null {
  if (!isRecord(value)) return null;
  if (!isRecord(value.lastNotified) || !isRecord(value.doctorRuns)) return null;

  let lastCheck: LastCheckRow | null = null;
  if (value.lastCheck !== null && value.lastCheck !== undefined) {
    const row = value.lastCheck;
    if (!isRecord(row)) return null;
    const error = optionalString(row.error);
    const latest = optionalString(row.latest);
    if (typeof row.at !== 'string') return null;
    if (typeof row.ok !== 'boolean') return null;
    if (error === undefined || latest === undefined) return null;
    lastCheck = {at: row.at, error, latest, ok: row.ok};
  }

  let lastKnownLatest: LastKnownLatestRow | null = null;
  if (value.lastKnownLatest !== null && value.lastKnownLatest !== undefined) {
    const row = value.lastKnownLatest;
    if (!isRecord(row)) return null;
    if (typeof row.at !== 'string' || typeof row.version !== 'string') {
      return null;
    }
    lastKnownLatest = {at: row.at, version: row.version};
  }

  const lastNotified: HealthNoticesState['lastNotified'] = {};
  for (const [root, kinds] of Object.entries(value.lastNotified)) {
    if (!isRecord(kinds)) return null;
    const entry: Partial<Record<VersionBumpKind, string>> = {};
    for (const kind of VERSION_BUMP_KINDS) {
      const at = kinds[kind];
      if (at === undefined) continue;
      if (typeof at !== 'string') return null;
      entry[kind] = at;
    }
    lastNotified[root] = entry;
  }

  const doctorRuns: HealthNoticesState['doctorRuns'] = {};
  for (const [root, row] of Object.entries(value.doctorRuns)) {
    if (!isRecord(row)) return null;
    if (
      typeof row.at !== 'string' ||
      typeof row.errors !== 'number' ||
      typeof row.passed !== 'number' ||
      typeof row.warnings !== 'number'
    ) {
      return null;
    }
    doctorRuns[root] = {
      at: row.at,
      errors: row.errors,
      passed: row.passed,
      warnings: row.warnings,
    };
  }

  return {
    doctorRuns,
    lastCheck,
    lastKnownLatest,
    lastNotified,
    schemaVersion: STATE_SCHEMA_VERSION,
  };
}

/** Read the state file. Never throws; every failure reads as absent-with-reason. */
export function readState(paths: HealthNoticesPaths): StateReadOutcome {
  let raw: string;
  try {
    raw = readFileSync(paths.file, 'utf-8');
  } catch (error) {
    const code =
      error != null && typeof error === 'object' && 'code' in error
        ? (error as {code: unknown}).code
        : null;
    if (code === 'ENOENT') {
      return {
        detail: null,
        path: paths.file,
        reason: 'no-file',
        status: 'absent',
      };
    }
    return {
      detail: error instanceof Error ? error.message : String(error),
      path: paths.file,
      reason: 'unreadable',
      status: 'absent',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      detail: error instanceof Error ? error.message : String(error),
      path: paths.file,
      reason: 'invalid-json',
      status: 'absent',
    };
  }

  if (!isRecord(parsed) || parsed.schemaVersion !== STATE_SCHEMA_VERSION) {
    return {
      detail: `expected schemaVersion ${STATE_SCHEMA_VERSION}, found ${JSON.stringify(
        isRecord(parsed) ? parsed.schemaVersion : null,
      )}`,
      path: paths.file,
      reason: 'unknown-schema-version',
      status: 'absent',
    };
  }

  const state = parseState(parsed);
  if (state == null) {
    return {
      detail: 'a field did not have the expected type',
      path: paths.file,
      reason: 'unknown-shape',
      status: 'absent',
    };
  }
  return {path: paths.file, state, status: 'ok'};
}

/**
 * Can we persist at all? Asked BEFORE any fetch (D4): without a state file
 * every command would re-fetch, which turns a once-an-hour 0.36s call into a
 * 0.36s tax on every invocation — including inside a Claude sandbox, where the
 * write is exactly what fails.
 */
export function isStateWritable(paths: HealthNoticesPaths): boolean {
  try {
    mkdirSync(paths.dir, {recursive: true});
  } catch {
    return false;
  }
  const probe = join(paths.dir, `.writable-probe-${process.pid}`);
  try {
    writeFileSync(probe, '');
  } catch {
    return false;
  }
  try {
    rmSync(probe, {force: true});
  } catch {
    // A probe we could write but not remove still proves writability.
  }
  return true;
}

/**
 * Write the state file. Returns false — never throws — when it could not be
 * written, so a caller can tell "recorded" from "not recorded" and never
 * assumes the clock was stamped.
 *
 * Temp-file-then-rename so a killed process cannot leave a half-written JSON
 * file that every later run would read as corrupt.
 */
export function writeState(
  paths: HealthNoticesPaths,
  state: HealthNoticesState,
): boolean {
  const temp = `${paths.file}.${process.pid}.tmp`;
  try {
    mkdirSync(paths.dir, {recursive: true});
    writeFileSync(temp, JSON.stringify(state, null, 2) + '\n');
    renameSync(temp, paths.file);
    return true;
  } catch {
    try {
      rmSync(temp, {force: true});
    } catch {
      // Nothing more to do: we are already on the failure path.
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// The version check (D3, D5)
// ---------------------------------------------------------------------------

export interface SdkVersionCheckResult {
  /** ISO time of the most recent ATTEMPT. null = never attempted. */
  checkedAt: string | null;
  /** The running SDK version. */
  current: string;
  /**
   * Why the most recent attempt failed, or why none was made. null means the
   * most recent attempt succeeded — check `checkedAt` for "never attempted".
   */
  error: string | null;
  /** current → latest. null when `latest` is null or not newer than current. */
  kind: VersionBumpKind | null;
  /**
   * Newest tag version last measured SUCCESSFULLY. null = never measured.
   * Paired with `latestMeasuredAt` so "known but undated" is unrepresentable.
   */
  latest: string | null;
  /** ISO time `latest` was measured. null iff `latest` is null. */
  latestMeasuredAt: string | null;
}

/**
 * Map a semver diff onto the three kinds Justin configures.
 *
 * Prerelease diffs collapse onto their base kind (D2). `prerelease` itself —
 * `1.0.0-a` → `1.0.0-b`, same release, different build — has no base kind and
 * is treated as a patch: the quietest tier, which is the right default for a
 * bump the fleet never publishes.
 */
export function bumpKindFromDiff(diff: string | null): VersionBumpKind | null {
  switch (diff) {
    case 'major':
    case 'premajor':
      return 'major';
    case 'minor':
    case 'preminor':
      return 'minor';
    case 'patch':
    case 'prepatch':
    case 'prerelease':
      return 'patch';
    default:
      return null;
  }
}

function minutesBetween(now: Date, isoEarlier: string): number | null {
  const earlier = Date.parse(isoEarlier);
  if (Number.isNaN(earlier)) return null;
  return (now.getTime() - earlier) / 60000;
}

/**
 * Compare the running version with the newest known tag. Returns null when
 * either side is not parseable semver — a comparison that could not be made is
 * never reported as "not newer" (critical rule 6).
 */
async function computeKind(
  current: string,
  latest: string | null,
): Promise<VersionBumpKind | null> {
  if (latest == null) return null;
  const semver = await import('semver');
  const from = semver.valid(semver.coerce(current));
  const to = semver.valid(semver.coerce(latest));
  if (from == null || to == null) return null;
  if (!semver.gt(to, from)) return null;
  return bumpKindFromDiff(semver.diff(from, to));
}

async function resultFromState(
  current: string,
  state: HealthNoticesState,
): Promise<SdkVersionCheckResult> {
  const latest = state.lastKnownLatest?.version ?? null;
  return {
    checkedAt: state.lastCheck?.at ?? null,
    current,
    error:
      state.lastCheck != null && !state.lastCheck.ok
        ? state.lastCheck.error
        : null,
    kind: await computeKind(current, latest),
    latest,
    latestMeasuredAt: state.lastKnownLatest?.at ?? null,
  };
}

/**
 * The pure half of the probe: state in, state out, at most one fetch.
 *
 * A FAILED fetch stamps `lastCheck.at` exactly as a successful one does — that
 * single line is what stops an offline machine from spending 5 seconds on
 * every command (D5, rule 3 in the file header). It does NOT touch
 * `lastKnownLatest`: what we learned last week is still what we last learned.
 */
export async function checkSdkVersion(options: {
  config: ResolvedHealthNoticesConfig;
  current: string;
  fetcher: SdkTagFetcher;
  now: Date;
  state: HealthNoticesState;
  timeoutMs?: number;
}): Promise<{result: SdkVersionCheckResult; state: HealthNoticesState}> {
  const {config, current, fetcher, now, state} = options;

  const lastAt = state.lastCheck?.at ?? null;
  const age = lastAt != null ? minutesBetween(now, lastAt) : null;
  if (age != null && age >= 0 && age < config.sdkVersion.checkIntervalMinutes) {
    return {result: await resultFromState(current, state), state};
  }

  const {DEFAULT_FETCH_TIMEOUT_MS} = await import('./sdk-latest');
  const outcome = fetcher({
    timeoutMs: options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
  });
  const at = now.toISOString();
  const next: HealthNoticesState =
    outcome.status === 'ok'
      ? {
          ...state,
          lastCheck: {at, error: null, latest: outcome.version, ok: true},
          lastKnownLatest: {at, version: outcome.version},
        }
      : {
          ...state,
          lastCheck: {at, error: outcome.error, latest: null, ok: false},
        };
  return {result: await resultFromState(current, next), state: next};
}

// ---------------------------------------------------------------------------
// The notice (D7)
// ---------------------------------------------------------------------------

/** What to run to take the notice's advice (D6). */
export const UPGRADE_COMMAND = 'bunx @justinhaaheim/justin-sdk update';

/** Exactly the two lines of D7. Nothing here decides whether to print them. */
export function renderNotice(
  current: string,
  latest: string,
  kind: VersionBumpKind,
): string[] {
  return [
    `justin-sdk ${current} → ${latest} available (${kind})`,
    `  upgrade: ${UPGRADE_COMMAND}`,
  ];
}

/**
 * Why a notice was or was not produced. A plain `null` would be enough for the
 * caller, but every silence here is a decision worth being able to assert on.
 */
export type NoticeOutcome =
  | {kind: VersionBumpKind; lines: string[]; status: 'notify'}
  | {
      reason:
        | 'disabled'
        | 'nothing-newer'
        | 'not-eligible'
        | 'state-unwritable'
        | 'throttled'
        | 'tier';
      status: 'silent';
    };

/**
 * Tier gate: a notice configured `promptTier: n` speaks at callsites of tier
 * `n` and quieter (lower number = more selective). `promptTier: 1` is below
 * `doctor`'s tier 2, so it never speaks anywhere — which is how a notice is
 * switched off per kind (D1).
 */
export function tierAllows(
  callsite: PromptTier,
  promptTier: PromptTier,
): boolean {
  return callsite <= promptTier;
}

export function decideNotice(options: {
  config: ResolvedHealthNoticesConfig;
  now: Date;
  projectRoot: string;
  result: SdkVersionCheckResult;
  state: HealthNoticesState;
  tier: PromptTier | null;
}): NoticeOutcome {
  const {config, now, projectRoot, result, state, tier} = options;
  if (!config.enabled) return {reason: 'disabled', status: 'silent'};
  if (tier == null) return {reason: 'not-eligible', status: 'silent'};
  if (result.kind == null || result.latest == null) {
    return {reason: 'nothing-newer', status: 'silent'};
  }

  const kindConfig = config.sdkVersion[result.kind];
  if (!tierAllows(tier, kindConfig.promptTier)) {
    return {reason: 'tier', status: 'silent'};
  }

  const lastNotified = state.lastNotified[projectRoot]?.[result.kind] ?? null;
  if (lastNotified != null && kindConfig.throttleMinutes > 0) {
    const age = minutesBetween(now, lastNotified);
    // An unparseable timestamp is not a licence to speak: treat it as "we
    // already said this" rather than re-notifying on every command forever.
    if (age == null || (age >= 0 && age < kindConfig.throttleMinutes)) {
      return {reason: 'throttled', status: 'silent'};
    }
  }

  return {
    kind: result.kind,
    lines: renderNotice(result.current, result.latest, result.kind),
    status: 'notify',
  };
}

/** Record that a notice was shown, so the throttle can see it next time. */
export function recordNotified(
  state: HealthNoticesState,
  projectRoot: string,
  kind: VersionBumpKind,
  now: Date,
): HealthNoticesState {
  return {
    ...state,
    lastNotified: {
      ...state.lastNotified,
      [projectRoot]: {
        ...(state.lastNotified[projectRoot] ?? {}),
        [kind]: now.toISOString(),
      },
    },
  };
}

/** The one place anything is printed. STDERR ONLY — see invariant 1. */
export function printNotice(lines: string[]): void {
  if (lines.length === 0) return;
  process.stderr.write(lines.join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** Outcome of a probe, including the reasons it may not have happened. */
export type SdkVersionProbe =
  | {
      detail: string;
      reason: 'disabled' | 'state-unwritable';
      status: 'skipped';
    }
  | {
      config: ResolvedHealthNoticesConfig;
      result: SdkVersionCheckResult;
      state: HealthNoticesState;
      status: 'checked';
    };

export interface ProbeOptions {
  env?: EnvLike;
  /** Injected by tests. Defaults to the real `git ls-remote` call. */
  fetcher?: SdkTagFetcher;
  now?: Date;
  projectRoot: string;
  timeoutMs?: number;
}

/** The running SDK's own version. */
async function currentSdkVersion(): Promise<string> {
  const {getSdkVersion} = await import('./setup-helpers');
  return getSdkVersion();
}

/**
 * Read state, check (fetching at most once per interval), persist. Never
 * throws.
 *
 * The persist failure is deliberately NOT fatal to the result: we already did
 * the work, and the worst case is that the next command checks again. It IS
 * why `isStateWritable` runs first — a machine that can never persist must not
 * fetch on every command.
 */
export async function probeSdkVersion(
  options: ProbeOptions,
): Promise<SdkVersionProbe> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const {resolveHealthNoticesConfig} = await import('./sdk-config');
  const config = resolveHealthNoticesConfig(options.projectRoot, env);
  if (!config.enabled) {
    return {
      detail:
        'health notices are off (JUSTIN_SDK_HEALTH_NOTICES=off, CI, or CLAUDE_CODE_REMOTE=true)',
      reason: 'disabled',
      status: 'skipped',
    };
  }

  const paths = healthNoticesPaths(env);
  if (!isStateWritable(paths)) {
    return {
      detail: `state directory is not writable (${paths.dir}), so no check was attempted`,
      reason: 'state-unwritable',
      status: 'skipped',
    };
  }

  const outcome = readState(paths);
  const state = outcome.status === 'ok' ? outcome.state : emptyState();

  let fetcher = options.fetcher;
  if (fetcher == null) {
    const {fetchLatestSdkTag} = await import('./sdk-latest');
    fetcher = fetchLatestSdkTag;
  }

  const checked = await checkSdkVersion({
    config,
    current: await currentSdkVersion(),
    fetcher,
    now,
    state,
    timeoutMs: options.timeoutMs,
  });

  if (checked.state !== state) writeState(paths, checked.state);

  return {
    config,
    result: checked.result,
    state: checked.state,
    status: 'checked',
  };
}

/**
 * The middleware's whole job: probe, decide, print, record. Never throws, never
 * writes stdout, never changes the exit code (see invariant 1).
 */
export async function maybeNotifySdkVersion(
  options: ProbeOptions & {commandName: string | null},
): Promise<NoticeOutcome> {
  const tier = callsiteTier(options.commandName);
  if (tier == null) return {reason: 'not-eligible', status: 'silent'};

  const probe = await probeSdkVersion(options);
  // The skip reason travels straight through: "you switched this off" and "this
  // machine cannot persist state" are different facts, and neither is
  // "there is nothing newer".
  if (probe.status === 'skipped') {
    return {reason: probe.reason, status: 'silent'};
  }

  const now = options.now ?? new Date();
  const decision = decideNotice({
    config: probe.config,
    now,
    projectRoot: options.projectRoot,
    result: probe.result,
    state: probe.state,
    tier,
  });
  if (decision.status !== 'notify') return decision;

  printNotice(decision.lines);
  writeState(
    healthNoticesPaths(options.env ?? process.env),
    recordNotified(probe.state, options.projectRoot, decision.kind, now),
  );
  return decision;
}

// ---------------------------------------------------------------------------
// The doctor SDK_VERSION check (D5, D6)
// ---------------------------------------------------------------------------

/**
 * What doctor should say. Kept here, next to the facts, so doctor.ts only maps
 * a verdict onto a CheckResult.
 *
 * `not-checked` is a PASS in doctor's terms and says so out loud: nobody asked
 * for the check, so nothing is wrong — but it must never render as "you are on
 * the latest version", which is the conflation this whole module exists to
 * avoid. `unknown` (we tried and could not tell) is a WARN, never a pass (D5).
 */
export type SdkVersionVerdict =
  | {kind: VersionBumpKind; message: string; silenced: boolean; status: 'newer'}
  | {message: string; status: 'not-checked'}
  | {message: string; status: 'unknown'}
  | {message: string; status: 'up-to-date'};

function describeAge(now: Date, iso: string | null): string {
  if (iso == null) return 'never';
  const minutes = minutesBetween(now, iso);
  if (minutes == null || minutes < 0) return iso;
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  if (minutes < 60 * 48) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

export function sdkVersionVerdict(
  probe: SdkVersionProbe,
  now: Date = new Date(),
): SdkVersionVerdict {
  if (probe.status === 'skipped') {
    return {message: `not checked — ${probe.detail}`, status: 'not-checked'};
  }
  const {config, result} = probe;

  if (result.error != null) {
    const known =
      result.latest != null
        ? ` Last known latest: ${result.latest} (measured ${describeAge(now, result.latestMeasuredAt)}).`
        : ' No tag has ever been read successfully on this machine.';
    return {
      message: `could not check for a newer justin-sdk: ${result.error}.${known}`,
      status: 'unknown',
    };
  }

  if (result.latest == null) {
    return {
      message:
        'no check has been made yet on this machine, so whether a newer justin-sdk exists is unknown',
      status: 'unknown',
    };
  }

  if (result.kind == null) {
    return {
      message: `justin-sdk ${result.current} is the latest tag (checked ${describeAge(now, result.checkedAt)})`,
      status: 'up-to-date',
    };
  }

  const promptTier = config.sdkVersion[result.kind].promptTier;
  const silenced = !tierAllows(2, promptTier);
  return {
    kind: result.kind,
    message:
      `justin-sdk ${result.current} → ${result.latest} available (${result.kind})` +
      (silenced
        ? ` — notices for ${result.kind} bumps are off (promptTier 1)`
        : ''),
    silenced,
    status: 'newer',
  };
}
