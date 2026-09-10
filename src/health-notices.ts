/**
 * health-notices.ts — the mechanism behind "a newer justin-sdk is available"
 * and "doctor has not run in this repo for an hour" (home-base-uxwc D1, D4, D5,
 * D7, D8).
 *
 * TWO PROBES, ONE MECHANISM: the SDK version check and the doctor heartbeat
 * share the tiers, the throttles, the config and the state file. Adding a third
 * should mean adding a section here, not a second copy of all of that.
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

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import {homedir} from 'os';
import {dirname, join, resolve} from 'path';

import type {
  EnvLike,
  PromptTier,
  ResolvedHealthNoticesConfig,
} from './sdk-config';
import type {SdkTagFetcher} from './sdk-latest';

/**
 * Env var that switches every health notice off for one invocation (D2).
 *
 * Declared HERE, and re-exported by `sdk-config`, because the callers that must
 * silence a CHILD justin-sdk process — `sweep`'s gates (home-base-uxwc.6), the
 * doctor heartbeat's own child — sit on `cli.ts`'s EAGER import graph, and
 * `sdk-config` brings 12-13ms of zod with it (see the file header).
 */
export const HEALTH_NOTICES_ENV_VAR = 'JUSTIN_SDK_HEALTH_NOTICES';

/** The value of {@link HEALTH_NOTICES_ENV_VAR} that means "stay quiet". */
export const HEALTH_NOTICES_OFF = 'off';

/**
 * `base`, with the kill switch set — the env any child justin-sdk (or `bun run`
 * script that may reach one) must be spawned with.
 *
 * Two callers, one reason each: the heartbeat's own `doctor --quiet` child must
 * not start a heartbeat of its own, and `sweep`'s per-worktree gates must not
 * nag about an upgrade they are in the middle of performing (uxwc.6).
 */
export function silencedChildEnv(
  base: EnvLike = process.env,
): Record<string, string | undefined> {
  return {...base, [HEALTH_NOTICES_ENV_VAR]: HEALTH_NOTICES_OFF};
}

// ---------------------------------------------------------------------------
// Which repo is this command about? (uxwc.5 F2)
// ---------------------------------------------------------------------------

/**
 * Name of the per-repo config file, at the project root.
 *
 * Declared HERE and re-exported by `sdk-config` for the same reason as
 * {@link HEALTH_NOTICES_ENV_VAR}: finding the repo root is the first thing the
 * middleware does, for every command, and this module may not import zod.
 */
export const PROJECT_CONFIG_FILENAME = 'justin-sdk.config.json';

/** A directory that is the root of a git repository (or a linked worktree). */
function isRepositoryRoot(dir: string): boolean {
  // A linked worktree has `.git` as a FILE, a primary checkout as a directory;
  // `existsSync` answers the only question here, which is "is this a boundary".
  return existsSync(join(dir, '.git'));
}

/**
 * The repo a command is about: the nearest directory at or above `startDir`
 * holding a {@link PROJECT_CONFIG_FILENAME}, or `startDir` when there is none.
 *
 * WHY (F2): everything here is keyed by project root — the notice throttle, the
 * heartbeat interval, the config file that tunes them. Keying on `cwd` instead
 * meant a repeated notice from every subdirectory, a heartbeat that NEVER ran
 * from one (the enrollment probe looked for the config file beside `cwd`), and
 * a state file growing one key per directory Justin ever typed a command in.
 *
 * THE WALK STOPS AT A REPOSITORY BOUNDARY. Without that it escapes into a
 * PARENT repo: `~/Dev/home-base/projects/justin-sdk` is a submodule with no
 * config of its own, so a bare walk resolves it to `~/Dev/home-base` and the
 * heartbeat spawns a doctor for a repo Justin is not in. A directory is checked
 * for the config file BEFORE it is checked for `.git`, so the ordinary case —
 * config and `.git` together at the root — still resolves there.
 *
 * `existsSync` answers false for a permissions error as well as for absence,
 * which here means falling back to `startDir`: the same not-enrolled verdict
 * the caller had before, never a claim of enrollment that was not measured.
 */
export function findProjectRoot(startDir: string): string {
  const start = resolve(startDir);
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, PROJECT_CONFIG_FILENAME))) return dir;
    if (isRepositoryRoot(dir)) return start;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

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

/**
 * One heartbeat doctor run, per repo (D8).
 *
 * EVERY field but `at` is nullable, and that is the whole point (critical rule
 * 6). A doctor that could not be spawned, was killed by the timeout, or printed
 * a summary this parser does not recognise has told us NOTHING about how many
 * checks passed — and `0` is a legal, reassuring answer to that question. The
 * counts are `null` in exactly those cases and `error` names the reason, so
 * "ran clean" and "never ran" can never be read as the same row.
 *
 * `exitCode` is null for the same reason: a child that did not run has no exit
 * code, and 0 would say it succeeded.
 */
export interface DoctorRunRow {
  at: string;
  /** Why the run produced no verdict. null iff the child ran to completion. */
  error: string | null;
  errors: number | null;
  exitCode: number | null;
  passed: number | null;
  warnings: number | null;
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
 * A field that may be a number, an explicit null, or missing entirely — the
 * three shapes a `DoctorRunRow` count can legitimately take. `undefined` is the
 * REJECT signal (a wrong type was present), never "absent": absent reads as
 * null, which is what an unknown count is.
 */
function optionalNumber(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' ? value : undefined;
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
    if (typeof row.at !== 'string') return null;
    // Only `at` is required. A row written by a SDK that recorded fewer fields
    // reads as "we know when, we do not know what" rather than as a corrupt
    // state file that throws the lastNotified throttles away with it.
    const error = row.error === undefined ? null : optionalString(row.error);
    const errors = optionalNumber(row.errors);
    const exitCode = optionalNumber(row.exitCode);
    const passed = optionalNumber(row.passed);
    const warnings = optionalNumber(row.warnings);
    if (
      error === undefined ||
      errors === undefined ||
      exitCode === undefined ||
      passed === undefined ||
      warnings === undefined
    ) {
      return null;
    }
    doctorRuns[root] = {at: row.at, error, errors, exitCode, passed, warnings};
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
 * How long a per-repo row survives without being touched (uxwc.5 F2). Long
 * enough that a repo worked on monthly keeps its throttles, short enough that
 * the file does not accumulate a row for every temp worktree ever created.
 */
export const STATE_RETENTION_DAYS = 30;

function isExpired(now: Date, iso: string, retentionDays: number): boolean {
  const age = minutesBetween(now, iso);
  // Unparseable or future stamps are NOT expired: "we cannot read this" is not
  // "this is old", and dropping a row we could not measure is a deletion made
  // on no evidence.
  return age != null && age > retentionDays * 24 * 60;
}

/**
 * Drop per-repo rows nothing has touched for {@link STATE_RETENTION_DAYS}.
 *
 * Both maps are keyed by project root, and roots are created faster than they
 * are retired — every `worktree-new` mints one that is deleted a week later.
 * Applied on every write (see {@link writeState}) so no caller can forget it.
 */
export function pruneState(
  state: HealthNoticesState,
  now: Date,
  retentionDays: number = STATE_RETENTION_DAYS,
): HealthNoticesState {
  const lastNotified: HealthNoticesState['lastNotified'] = {};
  for (const [root, kinds] of Object.entries(state.lastNotified)) {
    const stamps = Object.values(kinds).filter(
      (stamp): stamp is string => stamp != null,
    );
    // The NEWEST stamp decides: one kind going quiet must not retire a repo
    // whose other kinds are still speaking.
    const live =
      stamps.length === 0 ||
      stamps.some((stamp) => !isExpired(now, stamp, retentionDays));
    if (live) lastNotified[root] = kinds;
  }

  const doctorRuns: HealthNoticesState['doctorRuns'] = {};
  for (const [root, row] of Object.entries(state.doctorRuns)) {
    if (!isExpired(now, row.at, retentionDays)) doctorRuns[root] = row;
  }

  return {...state, doctorRuns, lastNotified};
}

/**
 * Write the state file. Returns false — never throws — when it could not be
 * written, so a caller can tell "recorded" from "not recorded" and never
 * assumes the clock was stamped.
 *
 * Temp-file-then-rename so a killed process cannot leave a half-written JSON
 * file that every later run would read as corrupt.
 *
 * PRUNES on the way out (F2), because every write is the moment the file is
 * already being rewritten and no caller can then forget to.
 */
export function writeState(
  paths: HealthNoticesPaths,
  state: HealthNoticesState,
  now: Date = new Date(),
): boolean {
  const temp = `${paths.file}.${process.pid}.tmp`;
  try {
    mkdirSync(paths.dir, {recursive: true});
    writeFileSync(temp, JSON.stringify(pruneState(state, now), null, 2) + '\n');
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

/**
 * Was this file written by a NEWER justin-sdk? Its detail, or null (uxwc.5 F8).
 *
 * An older SDK reading a `schemaVersion` it does not recognise reads the file
 * as ABSENT — which is right for reading, and catastrophic for writing: it
 * would then persist its own empty-plus-one-row state over a file holding every
 * repo's stamps. This is the one place that decides, so "do not use it" and "do
 * not overwrite it" can never disagree.
 */
export function newerSchemaDetail(outcome: StateReadOutcome): string | null {
  if (
    outcome.status === 'absent' &&
    outcome.reason === 'unknown-schema-version'
  ) {
    return outcome.detail ?? 'unrecognised schemaVersion';
  }
  return null;
}

/**
 * Re-read, apply THIS process's row to the fresh copy, write (uxwc.5 F3).
 *
 * WHY: both probes do slow work between reading state and writing it — a fetch
 * of up to 5s, a doctor child of up to 60s — and justin-sdk runs in several
 * shells at once. Writing back the snapshot taken before that work erases
 * whatever another process recorded meanwhile: a notice stamp, a heartbeat row,
 * the fetch clock. Only the rows `change` touches are this process's to write.
 *
 * `fallback` is used when the re-read fails for any OTHER reason (a corrupt or
 * unreadable file): the snapshot we already hold is better than nothing, and
 * self-heals the file. A file written by a newer SDK is refused outright — the
 * race F8 guards against is exactly an upgrade landing mid-run.
 */
export function updateState(options: {
  change: (base: HealthNoticesState) => HealthNoticesState;
  fallback: HealthNoticesState;
  now?: Date;
  paths: HealthNoticesPaths;
}): boolean {
  const fresh = readState(options.paths);
  if (newerSchemaDetail(fresh) != null) return false;
  const base = fresh.status === 'ok' ? fresh.state : options.fallback;
  return writeState(
    options.paths,
    options.change(base),
    options.now ?? new Date(),
  );
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
        /** We tried to find out and could not. NOT the same as "nothing newer". */
        | 'check-failed'
        | 'disabled'
        | 'nothing-newer'
        | 'not-eligible'
        /** The state file belongs to a NEWER justin-sdk (F8). */
        | 'state-newer-schema'
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
  // `config.enabled` is NOT re-checked here (F9): `probeSdkVersion` returns
  // `skipped: disabled` before this is ever reached, and a second gate that
  // cannot fire is a second gate to keep in sync.
  const {config, now, projectRoot, result, state, tier} = options;
  if (tier == null) return {reason: 'not-eligible', status: 'silent'};
  if (result.kind == null || result.latest == null) {
    // Both are silent, but they are not the same fact. A failed check is
    // reported by doctor's SDK_VERSION, not by a notice in front of every
    // command — but it must not be FILED as "you are up to date".
    return {
      reason: result.error != null ? 'check-failed' : 'nothing-newer',
      status: 'silent',
    };
  }

  const kindConfig = config.sdkVersion[result.kind];
  if (!tierAllows(tier, kindConfig.promptTier)) {
    return {reason: 'tier', status: 'silent'};
  }

  const lastNotified = state.lastNotified[projectRoot]?.[result.kind] ?? null;
  if (lastNotified != null && kindConfig.throttleMinutes > 0) {
    const age = minutesBetween(now, lastNotified);
    // An UNPARSEABLE stamp (age null) deliberately does NOT throttle. The
    // cautious verdict here is to speak: staying quiet on a stamp we cannot
    // read would silence this repo+kind forever — the throttle can only be
    // cleared by a notice, and a notice can never happen while it throttles.
    // Speaking once rewrites the stamp with a valid one, so it self-heals.
    // A FUTURE stamp (age negative, a skewed clock) is likewise not a licence
    // to go quiet indefinitely.
    if (age != null && age >= 0 && age < kindConfig.throttleMinutes) {
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

/**
 * Everything BOTH probes need, measured once per command (uxwc.5 F9).
 *
 * Before this existed, an eligible command resolved the config twice, read the
 * project config three times, and ran the writability probe — a mkdir, a write
 * and an unlink — twice. Each probe still resolves its own when a caller does
 * not supply one, so a direct call (doctor, the tests) needs nothing extra.
 */
export interface HealthNoticesContext {
  config: ResolvedHealthNoticesConfig;
  /**
   * Does doctor have anything to check here? `schema-violation` counts: the
   * file exists, and CONFIG_SCHEMA is the check that reports what is wrong
   * with it.
   */
  enrolled: boolean;
  projectRoot: string;
  /**
   * Can the state file be written? `null` means NOT PROBED, which happens only
   * when notices are off — an off switch must not touch the disk. Never `true`
   * unless a write actually succeeded (critical rule 6).
   */
  stateWritable: boolean | null;
}

/** Resolve {@link HealthNoticesContext} for one command in one repo. */
export async function resolveHealthNoticesContext(options: {
  env?: EnvLike;
  projectRoot: string;
}): Promise<HealthNoticesContext> {
  const env = options.env ?? process.env;
  const {readProjectConfig, readUserConfig, resolveHealthNoticesConfigFrom} =
    await import('./sdk-config');
  const project = readProjectConfig(options.projectRoot);
  const config = resolveHealthNoticesConfigFrom({
    env,
    project,
    user: readUserConfig(env),
  });
  return {
    config,
    enrolled: project.status === 'ok' || project.status === 'schema-violation',
    projectRoot: options.projectRoot,
    stateWritable: config.enabled
      ? isStateWritable(healthNoticesPaths(env))
      : null,
  };
}

/** Outcome of a probe, including the reasons it may not have happened. */
export type SdkVersionProbe =
  | {
      detail: string;
      /** `state-newer-schema`: the file belongs to a newer SDK (F8). */
      reason: 'disabled' | 'state-newer-schema' | 'state-unwritable';
      status: 'skipped';
    }
  | {
      config: ResolvedHealthNoticesConfig;
      result: SdkVersionCheckResult;
      state: HealthNoticesState;
      status: 'checked';
    };

export interface ProbeOptions {
  /** Pre-resolved by the middleware (F9). Absent: resolved here. */
  config?: ResolvedHealthNoticesConfig;
  env?: EnvLike;
  /** Injected by tests. Defaults to the real `git ls-remote` call. */
  fetcher?: SdkTagFetcher;
  now?: Date;
  projectRoot: string;
  /** Pre-probed by the middleware (F9). Absent: probed here. */
  stateWritable?: boolean | null;
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
  let config = options.config;
  if (config == null) {
    const {resolveHealthNoticesConfig} = await import('./sdk-config');
    config = resolveHealthNoticesConfig(options.projectRoot, env);
  }
  if (!config.enabled) {
    return {
      detail:
        'health notices are off (JUSTIN_SDK_HEALTH_NOTICES=off, CI, or CLAUDE_CODE_REMOTE=true)',
      reason: 'disabled',
      status: 'skipped',
    };
  }

  const paths = healthNoticesPaths(env);
  // `null` (not probed, because notices were off) cannot reach here, and would
  // fall through to a fresh probe rather than being read as writable.
  if ((options.stateWritable ?? isStateWritable(paths)) !== true) {
    return {
      detail: `state directory is not writable (${paths.dir}), so no check was attempted`,
      reason: 'state-unwritable',
      status: 'skipped',
    };
  }

  const outcome = readState(paths);
  const newerSchema = newerSchemaDetail(outcome);
  if (newerSchema != null) {
    // F8. Not merely "do not write": with no readable state there is no clock
    // to throttle the fetch, so carrying on would fetch on EVERY command
    // (invariant 3). The situation is self-correcting in the direction that
    // matters — a newer SDK wrote that file, which is the upgrade this notice
    // exists to ask for.
    return {
      detail: `the state file (${paths.file}) was written by a newer justin-sdk (${newerSchema}), so it was neither used nor overwritten`,
      reason: 'state-newer-schema',
      status: 'skipped',
    };
  }
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

  if (checked.state !== state) {
    // Only the two rows THIS process measured, merged into a re-read of the
    // file (F3): the fetch above may have taken seconds, and another shell's
    // notice stamp or heartbeat row must survive it.
    updateState({
      change: (base) => ({
        ...base,
        lastCheck: checked.state.lastCheck,
        lastKnownLatest: checked.state.lastKnownLatest,
      }),
      fallback: state,
      now,
      paths,
    });
  }

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
  // The write's boolean is deliberately not acted on: the notice has already
  // been printed, and there is no undo. A failure here costs one repeated
  // notice, and `isStateWritable` above has already ruled out the case where it
  // would fail every time. Only this repo's throttle stamp is written, onto a
  // re-read of the file (F3) — the fetch it just paid for takes real time.
  updateState({
    change: (base) =>
      recordNotified(base, options.projectRoot, decision.kind, now),
    fallback: probe.state,
    now,
    paths: healthNoticesPaths(options.env ?? process.env),
  });
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

// ---------------------------------------------------------------------------
// The doctor heartbeat (D8) — home-base-uxwc.3
// ---------------------------------------------------------------------------

/**
 * WHY A HEARTBEAT. Justin, 2026-09-09: a beads database was corrupt for weeks
 * with nothing saying so — "it is hard to overstate the benefit of NOT running
 * into a bug that is hard to diagnose". `doctor` already knows how to find that
 * class of problem; the gap is cadence. SessionStart runs it once per Claude
 * session, which misses every shell Justin works in and every session that runs
 * for hours. This runs it again, at most once per repo per interval, in front
 * of a command he was running anyway.
 *
 * IT INHERITS THE FOUR INVARIANTS AT THE TOP OF THIS FILE, and adds one:
 * a heartbeat never spawns a heartbeat. The child carries the kill switch
 * ({@link silencedChildEnv}) AND is `doctor`, which is excluded by name below —
 * two independent guards, because an infinite fork bomb is the one failure here
 * that would not be merely annoying.
 */

/** What to run for the full, unabridged version of the heartbeat's output. */
export const DOCTOR_COMMAND = 'bunx @justinhaaheim/justin-sdk doctor';

/** How long the child gets before it is killed (D3). */
export const DOCTOR_HEARTBEAT_TIMEOUT_MS = 60_000;

export interface DoctorSpawnRequest {
  args: readonly string[];
  command: string;
  cwd: string;
  env: Record<string, string | undefined>;
  timeoutMs: number;
}

/**
 * What a spawn attempt produced.
 *
 * `error` and `exitCode` are a PAIR: exactly one is non-null. A child that
 * could not be started, or was killed by the timeout, has no exit code — and
 * `0` would say it succeeded (critical rule 6).
 */
export interface DoctorSpawnOutcome {
  error: string | null;
  exitCode: number | null;
  stderr: string;
  stdout: string;
}

/** The injection seam. Tests pass a fake; nothing else does. */
export type DoctorSpawner = (
  request: DoctorSpawnRequest,
) => Promise<DoctorSpawnOutcome>;

/**
 * Why an outcome carries no verdict, or null when the child ran to completion.
 * The ONE place that decides "did this measure anything", so the line printed
 * and the reason recorded can never disagree.
 */
export function doctorFailureReason(
  outcome: DoctorSpawnOutcome,
): string | null {
  if (outcome.error != null) return outcome.error;
  // Belt and braces: the pair invariant makes this unreachable from the real
  // spawner, and an unreachable "no exit code" must still not read as success.
  if (outcome.exitCode == null) return 'the child produced no exit code';
  return null;
}

/**
 * Counts read out of doctor's summary. `null` means the summary did not say —
 * never `0`, which is a measurement (see {@link parseDoctorSummary}).
 */
export interface DoctorSummaryCounts {
  errors: number | null;
  passed: number | null;
  warnings: number | null;
}

/** ANSI SGR sequences, built from a char code so this file holds no ESC byte. */
const ANSI_SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

function matchCount(text: string, word: string): number | null {
  const found = new RegExp(`^\\s*(\\d+) ${word}\\s*$`, 'm').exec(text);
  const digits = found?.[1];
  if (digits == null) return null;
  const value = Number.parseInt(digits, 10);
  return Number.isNaN(value) ? null : value;
}

/**
 * Read `doctor --quiet`'s summary. Pure.
 *
 * `--quiet` has TWO shapes, and both are handled here because both are normal:
 *
 *  - all-pass, nothing skipped: one line, `✓ All 10 checks passed. [35ms]`;
 *  - anything else: the failing/warning checks, then ` 9 pass` / ` 1 warn` /
 *    ` 1 fail` (each line printed ONLY when its count is non-zero), then the
 *    `Ran 10 checks.` footer.
 *
 * THE FOOTER IS THE ANCHOR. `printSummary` writes it last, so its presence is
 * what makes a missing ` 1 warn` line mean "zero warnings" rather than "output
 * truncated". Without either shape's anchor every count is null: a summary we
 * did not recognise has told us nothing, and reporting it as 0/0/0 would file a
 * killed child as a clean run.
 */
export function parseDoctorSummary(output: string): DoctorSummaryCounts {
  const text = output.replace(ANSI_SGR, '');

  const allPassed = /^.*All (\d+) checks passed\./m.exec(text);
  if (allPassed?.[1] != null) {
    return {errors: 0, passed: Number.parseInt(allPassed[1], 10), warnings: 0};
  }

  if (!/^.*Ran \d+ checks\./m.test(text)) {
    return {errors: null, passed: null, warnings: null};
  }
  return {
    errors: matchCount(text, 'fail') ?? 0,
    passed: matchCount(text, 'pass') ?? 0,
    warnings: matchCount(text, 'warn') ?? 0,
  };
}

/** Why a heartbeat did not happen. Each is a different fact worth asserting. */
export type DoctorHeartbeatSkipReason =
  | 'disabled'
  /** The command IS doctor — running it again would be absurd, and recursive. */
  | 'is-doctor'
  | 'not-eligible'
  /** No readable `justin-sdk.config.json`: doctor has nothing to check here. */
  | 'not-enrolled'
  /** The state file belongs to a NEWER justin-sdk (F8) — do not touch it. */
  | 'state-newer-schema'
  | 'state-unwritable'
  | 'throttled'
  | 'tier';

export type DoctorHeartbeatDecision =
  {reason: DoctorHeartbeatSkipReason; status: 'skip'} | {status: 'run'};

/**
 * The pure gate (D2's order, minus the two steps that need the filesystem):
 * switched on, an eligible callsite, not doctor itself, loud enough for the
 * configured tier, and not inside the interval since the last run here.
 *
 * As with the notice throttle, an UNPARSEABLE or FUTURE `at` does not throttle:
 * a stamp only a run can rewrite must never be able to silence a repo forever.
 */
export function decideDoctorHeartbeat(options: {
  commandName: string | null;
  config: ResolvedHealthNoticesConfig;
  now: Date;
  projectRoot: string;
  state: HealthNoticesState;
}): DoctorHeartbeatDecision {
  const {commandName, config, now, projectRoot, state} = options;
  if (!config.enabled) return {reason: 'disabled', status: 'skip'};

  const tier = callsiteTier(commandName);
  if (tier == null) return {reason: 'not-eligible', status: 'skip'};
  if (canonicalCommandName(commandName ?? '') === 'doctor') {
    return {reason: 'is-doctor', status: 'skip'};
  }
  if (!tierAllows(tier, config.doctor.promptTier)) {
    return {reason: 'tier', status: 'skip'};
  }

  const lastAt = state.doctorRuns[projectRoot]?.at ?? null;
  // No `intervalMinutes > 0` guard (F9): the schema is `.positive()`, so a
  // zero would be a schema violation and the whole file it came from is
  // discarded before it reaches here.
  if (lastAt != null) {
    const age = minutesBetween(now, lastAt);
    if (age != null && age >= 0 && age < config.doctor.intervalMinutes) {
      return {reason: 'throttled', status: 'skip'};
    }
  }
  return {status: 'run'};
}

/**
 * What the heartbeat says out loud (D4). Pure, so every branch is assertable
 * without capturing a stream.
 *
 *  - the child never ran        → one line naming the reason;
 *  - non-zero exit              → a header, the child's output VERBATIM, and
 *                                 how to re-run it in full;
 *  - exit 0                     → nothing, unless `showOnPass`, and then one
 *                                 line. Warnings live here: they are not
 *                                 errors, and doctor already exits 0 for them.
 */
export function renderDoctorHeartbeat(options: {
  counts: DoctorSummaryCounts;
  outcome: DoctorSpawnOutcome;
  projectRoot: string;
  showOnPass: boolean;
}): string[] {
  const {counts, outcome, projectRoot, showOnPass} = options;

  const failure = doctorFailureReason(outcome);
  if (failure != null) {
    return [`justin-sdk doctor heartbeat could not run: ${failure}`];
  }

  if (outcome.exitCode !== 0) {
    // stdout then stderr, concatenated — the same shape sweep's `run` uses.
    // Their relative interleaving is lost; the content is not.
    const body = `${outcome.stdout}${outcome.stderr}`.replace(/\n+$/, '');
    return [
      `justin-sdk doctor (heartbeat) found errors in ${projectRoot}:`,
      ...(body === '' ? [] : body.split('\n')),
      `  full run: ${DOCTOR_COMMAND}`,
    ];
  }

  if (!showOnPass) return [];
  const summary =
    counts.passed == null || counts.warnings == null
      ? 'summary unparsed'
      : `${counts.passed} pass, ${counts.warnings} warn`;
  return [`✅ justin-sdk doctor: ${summary}`];
}

export type DoctorHeartbeatOutcome =
  | {lines: string[]; row: DoctorRunRow; status: 'ran'}
  | {reason: DoctorHeartbeatSkipReason; status: 'skipped'};

export interface DoctorHeartbeatOptions {
  commandName: string | null;
  /** Pre-resolved by the middleware (F9). Absent: resolved here. */
  config?: ResolvedHealthNoticesConfig;
  /** Pre-read by the middleware (F9). Absent: read here. */
  enrolled?: boolean;
  env?: EnvLike;
  now?: Date;
  projectRoot: string;
  /** Injected by tests. Defaults to a real `doctor --quiet` child process. */
  spawner?: DoctorSpawner;
  /** Pre-probed by the middleware (F9). Absent: probed here. */
  stateWritable?: boolean | null;
  timeoutMs?: number;
}

/** `bun <this src dir>/cli.ts doctor --quiet` — the SAME SDK that is running. */
export function doctorHeartbeatRequest(options: {
  cwd: string;
  env: EnvLike;
  timeoutMs: number;
}): DoctorSpawnRequest {
  return {
    // `cli.ts`, not the `justin-sdk` on PATH: the running SDK is the one whose
    // checks this build knows about, and a bunx lookup would be both slower and
    // a different (possibly older, possibly missing) version. Same shape as
    // `captureCommandList` in skill.ts.
    args: [resolve(import.meta.dirname, 'cli.ts'), 'doctor', '--quiet'],
    command: process.execPath,
    cwd: options.cwd,
    env: silencedChildEnv(options.env),
    timeoutMs: options.timeoutMs,
  };
}

async function spawnDoctor(
  request: DoctorSpawnRequest,
): Promise<DoctorSpawnOutcome> {
  const {spawnSync} = await import('node:child_process');
  const child = spawnSync(request.command, [...request.args], {
    cwd: request.cwd,
    encoding: 'utf-8',
    env: request.env,
    // Doctor's quiet output is small, but a check that dumps a diff is not.
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: request.timeoutMs,
  });
  const stderr = child.stderr ?? '';
  const stdout = child.stdout ?? '';
  if (child.error != null) {
    return {error: child.error.message, exitCode: null, stderr, stdout};
  }
  if (child.status == null) {
    // Killed by a signal (measured: the timeout arrives as SIGTERM with a
    // non-null `error`, but a signal from anywhere else does not).
    return {
      error: `doctor was killed by ${child.signal ?? 'an unknown signal'}`,
      exitCode: null,
      stderr,
      stdout,
    };
  }
  return {error: null, exitCode: child.status, stderr, stdout};
}

/**
 * Run doctor for this repo if it is due, say what needs saying, and record it.
 * Never writes stdout and never changes the caller's exit code. Everything it
 * calls is non-throwing by construction, and the one foreign thing — an
 * injected spawner — is caught and turned into a recorded failure below.
 *
 * WHY IT RE-READS STATE rather than taking it from the caller: the version
 * notice that runs immediately before this one may have just written a fresh
 * throttle stamp, and writing back a state captured before that would erase it.
 * The read is a few hundred bytes and happens at most once per command.
 *
 * WHY THE RUN IS RECORDED EVEN WHEN IT FAILED: the same rule that stops an
 * offline laptop re-fetching on every command (invariant 3). A doctor that
 * cannot be spawned here will not be spawnable on the next command either, and
 * an unrecorded failure would retry — with its 60s timeout — forever.
 */
export async function runDoctorHeartbeat(
  options: DoctorHeartbeatOptions,
): Promise<DoctorHeartbeatOutcome> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const {projectRoot} = options;

  const tier = callsiteTier(options.commandName);
  if (tier == null) return {reason: 'not-eligible', status: 'skipped'};

  let config = options.config;
  if (config == null) {
    const {resolveHealthNoticesConfig} = await import('./sdk-config');
    config = resolveHealthNoticesConfig(projectRoot, env);
  }
  if (!config.enabled) return {reason: 'disabled', status: 'skipped'};

  // "Enrolled" means doctor has something to say here. `absent` is the ordinary
  // case for any directory that is not one of Justin's repos. `invalid-json`
  // and `unreadable` are excluded too — deliberately: `runDoctor` would throw
  // on the first and report nothing useful on the second, and a heartbeat must
  // never turn a broken config into a wall of stderr on every command. The
  // CONFIG_SCHEMA doctor check is what reports those, when doctor is asked for.
  let enrolled = options.enrolled;
  if (enrolled == null) {
    const {readProjectConfig} = await import('./sdk-config');
    const enrollment = readProjectConfig(projectRoot);
    enrolled =
      enrollment.status === 'ok' || enrollment.status === 'schema-violation';
  }
  if (!enrolled) return {reason: 'not-enrolled', status: 'skipped'};

  const paths = healthNoticesPaths(env);
  if ((options.stateWritable ?? isStateWritable(paths)) !== true) {
    // Same pre-flight as the version probe (D4): a machine that cannot persist
    // the "already ran" stamp would spawn a doctor on EVERY command.
    return {reason: 'state-unwritable', status: 'skipped'};
  }

  const read = readState(paths);
  // F8, and for the same second reason as the version probe: with no readable
  // clock, a run that could not be recorded would spawn a doctor on EVERY
  // command.
  if (newerSchemaDetail(read) != null) {
    return {reason: 'state-newer-schema', status: 'skipped'};
  }
  const state = read.status === 'ok' ? read.state : emptyState();

  const decision = decideDoctorHeartbeat({
    commandName: options.commandName,
    config,
    now,
    projectRoot,
    state,
  });
  if (decision.status === 'skip') {
    return {reason: decision.reason, status: 'skipped'};
  }

  const spawner = options.spawner ?? spawnDoctor;
  const request = doctorHeartbeatRequest({
    cwd: projectRoot,
    env,
    timeoutMs: options.timeoutMs ?? DOCTOR_HEARTBEAT_TIMEOUT_MS,
  });
  let outcome: DoctorSpawnOutcome;
  try {
    outcome = await spawner(request);
  } catch (error) {
    // A spawner that THREW measured nothing. It is a failed run — recorded as
    // one, with the reason — never an absence of one, and never a skip.
    outcome = {
      error: error instanceof Error ? error.message : String(error),
      exitCode: null,
      stderr: '',
      stdout: '',
    };
  }

  // A child that did not finish told us NOTHING, so its partial output is not
  // parsed at all: `--quiet` output truncated mid-run can still contain a pass
  // count, and filing a killed doctor as "9 passed, nothing failed" is exactly
  // the manufactured-evidence failure of critical rule 6.
  const failure = doctorFailureReason(outcome);
  const counts =
    failure == null
      ? parseDoctorSummary(`${outcome.stdout}${outcome.stderr}`)
      : {errors: null, passed: null, warnings: null};

  const row: DoctorRunRow = {
    at: now.toISOString(),
    error: failure,
    errors: counts.errors,
    exitCode: outcome.exitCode,
    passed: counts.passed,
    warnings: counts.warnings,
  };

  // RECORD FIRST, THEN SPEAK. The stamp is what keeps the next command from
  // spawning another doctor; the printing is best-effort (a closed stderr
  // throws EPIPE). Unlike the version notice — whose stamp is a claim that it
  // spoke, and must not be written if it did not — this stamp only claims the
  // run happened, which is true either way.
  // Only this repo's row, onto a RE-READ of the file (F3): the child above may
  // have run for up to 60 seconds, and anything another process recorded in
  // that time — a notice stamp, another repo's heartbeat — must survive it.
  updateState({
    change: (base) => ({
      ...base,
      doctorRuns: {...base.doctorRuns, [projectRoot]: row},
    }),
    fallback: state,
    now,
    paths,
  });

  const lines = renderDoctorHeartbeat({
    counts,
    outcome,
    projectRoot,
    showOnPass: config.doctor.showOnPass,
  });
  printNotice(lines);

  return {lines, row, status: 'ran'};
}
