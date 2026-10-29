/**
 * pre-commit-ts-check/gate.ts — the pure half of the pre-commit type-check
 * gate (home-base-pp1vx.1.2): which staged paths can affect type-checking,
 * whether this commit runs the type-check, and the one line that says why.
 *
 * Justin, 2026-10-26: "It'll be fine as long as the files *ultimately* get
 * formatted before commit, and as long as the ts files ARE checked whenever
 * there's a ts change. but we should still make sure there's some ts check in
 * all these projects even without ts changes so we can catch if ts is broken
 * because of a ts version difference, a change in a preivous commit that got
 * missed, etc."
 *
 * Every input that could not be measured routes to RUNNING the type-check
 * (critical rule 7): staged paths that could not be listed, a last-green record
 * that could not be read, a record dated in the future, a config file that
 * could not be read. Skipping is the reassuring verdict, so it needs evidence.
 */

import {posix} from 'path';

import {
  FULL_TS_CHECK_EVERY_HOURS_DEFAULT,
  HUSKY_CONFIG_KEY,
  TS_CHECK_ON_COMMIT_DEFAULT,
  TS_CHECK_ON_COMMIT_MODES,
  type TsCheckOnCommitMode,
} from './defaults';

// ---------------------------------------------------------------------------
// Which staged paths can affect type-checking
// ---------------------------------------------------------------------------

/**
 * Extensions TypeScript never reads. The list is of what is KNOWN not to
 * matter, not of what does: a path with any other extension, or none (a
 * symlink in bin/, a submodule gitlink, mise.toml, bunfig.toml), counts as one
 * that can, so an unforeseen file type costs a type-check rather than skipping
 * one. Not here on purpose: `.json` (tsconfig, package.json, and any JSON a
 * module imports with resolveJsonModule), `.js`/`.mjs`/`.cjs` (allowJs), every
 * lockfile, and `.mdx`.
 */
const NON_TS_EXTENSIONS = new Set([
  '.gif',
  '.heic',
  '.ico',
  '.jpeg',
  '.jpg',
  '.jsonl',
  '.md',
  '.pdf',
  '.png',
  '.txt',
  '.webp',
]);

/** Whole filenames TypeScript never reads (their extname is ''). */
const NON_TS_BASENAMES = new Set(['.gitignore', '.prettierignore']);

/**
 * The beads directory at the repo root. TypeScript's wildcard includes skip
 * dot-directories, and this is the bead's own fix shape: a beads-only commit
 * (`.beads/issues.jsonl`, and on occasion `.beads/config.yaml`) is the commit
 * this gate exists for.
 */
const NON_TS_DIR_PREFIX = '.beads/';

/** True unless the path is known to be one TypeScript never reads. */
export function canAffectTypeCheck(path: string): boolean {
  if (path.startsWith(NON_TS_DIR_PREFIX)) return false;
  const base = posix.basename(path);
  if (NON_TS_BASENAMES.has(base)) return false;
  return !NON_TS_EXTENSIONS.has(posix.extname(base).toLowerCase());
}

// ---------------------------------------------------------------------------
// The knob
// ---------------------------------------------------------------------------

export interface GateKnob {
  everyHours: number;
  mode: TsCheckOnCommitMode;
  /** Lines to print: a value the gate could not use, and what it used instead. */
  problems: string[];
}

function isMode(value: unknown): value is TsCheckOnCommitMode {
  return (TS_CHECK_ON_COMMIT_MODES as readonly unknown[]).includes(value);
}

function readBlock(
  config: unknown,
): {fullTsCheckEveryHours?: unknown; tsCheckOnCommit?: unknown} | null {
  if (config == null || typeof config !== 'object') return null;
  const componentConfig = (config as {componentConfig?: unknown})
    .componentConfig;
  if (componentConfig == null || typeof componentConfig !== 'object') {
    return null;
  }
  const block = (componentConfig as Record<string, unknown>)[HUSKY_CONFIG_KEY];
  if (block == null || typeof block !== 'object') return null;
  return block as {fullTsCheckEveryHours?: unknown; tsCheckOnCommit?: unknown};
}

/**
 * Resolve the knob from the project config.
 *
 * `config` is the parsed `justin-sdk.config.json` (null when the file is
 * absent), or a string naming why it could not be used. An unusable file means
 * the default, "always", and says so: a config problem must never be what
 * switches the type-check off. Values are checked here rather than by a zod
 * enum, because a schema violation drops the WHOLE file (sdk-config.ts), and a
 * typo in this knob must not also switch off every thread knob in the repo.
 */
export function resolveGateKnob(config: unknown): GateKnob {
  const defaults: GateKnob = {
    everyHours: FULL_TS_CHECK_EVERY_HOURS_DEFAULT,
    mode: TS_CHECK_ON_COMMIT_DEFAULT,
    problems: [],
  };
  if (typeof config === 'string') {
    return {
      ...defaults,
      problems: [
        `ts-check: type-checking every commit, because justin-sdk.config.json could not be used (${config})`,
      ],
    };
  }
  const block = readBlock(config);
  if (block == null) return defaults;

  const problems: string[] = [];
  let mode = defaults.mode;
  if (block.tsCheckOnCommit !== undefined) {
    if (isMode(block.tsCheckOnCommit)) {
      mode = block.tsCheckOnCommit;
    } else {
      problems.push(
        `ts-check: type-checking every commit, because componentConfig.${HUSKY_CONFIG_KEY}.tsCheckOnCommit is ${JSON.stringify(block.tsCheckOnCommit)}, not one of ${TS_CHECK_ON_COMMIT_MODES.map((m) => `"${m}"`).join(', ')}`,
      );
    }
  }
  let everyHours = defaults.everyHours;
  if (block.fullTsCheckEveryHours !== undefined) {
    if (
      typeof block.fullTsCheckEveryHours === 'number' &&
      Number.isFinite(block.fullTsCheckEveryHours)
    ) {
      everyHours = block.fullTsCheckEveryHours;
    } else {
      problems.push(
        `ts-check: componentConfig.${HUSKY_CONFIG_KEY}.fullTsCheckEveryHours is ${JSON.stringify(block.fullTsCheckEveryHours)}, not a number; using ${defaults.everyHours}`,
      );
    }
  }
  return {everyHours, mode, problems};
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/** The staged paths, or why they could not be listed. Never an empty stand-in. */
export type StagedPaths =
  | {error: string; kind: 'unknown'}
  | {kind: 'listed'; paths: readonly string[]};

/** The last green type-check in this checkout: three facts, kept apart. */
export type LastGreen =
  | {at: Date; kind: 'recorded'}
  | {error: string; kind: 'unreadable'}
  | {kind: 'none'};

export type GateDecision =
  /** The knob is off: today's behaviour, and no line is printed. */
  | {reason: 'always'; run: true}
  | {reason: 'staged-unknown'; run: true; staged: {error: string}}
  | {reason: 'ts-staged'; relevant: readonly string[]; run: true}
  | {
      ageHours: number | null;
      everyHours: number;
      lastGreen: LastGreen;
      reason: 'full-check-due';
      run: true;
    }
  | {
      ageHours: number;
      everyHours: number;
      reason: 'nothing-ts-staged';
      run: false;
      staged: readonly string[];
    };

export function decideTsCheck(input: {
  everyHours: number;
  lastGreen: LastGreen;
  mode: TsCheckOnCommitMode;
  now: Date;
  staged: StagedPaths;
}): GateDecision {
  const {everyHours, lastGreen, mode, now, staged} = input;
  if (mode === 'always') return {reason: 'always', run: true};
  if (staged.kind === 'unknown') {
    return {reason: 'staged-unknown', run: true, staged: {error: staged.error}};
  }
  const relevant = staged.paths.filter(canAffectTypeCheck);
  if (relevant.length > 0) return {reason: 'ts-staged', relevant, run: true};

  if (lastGreen.kind !== 'recorded') {
    return {
      ageHours: null,
      everyHours,
      lastGreen,
      reason: 'full-check-due',
      run: true,
    };
  }
  const ageHours = (now.getTime() - lastGreen.at.getTime()) / 3_600_000;
  // A record dated in the future is a clock we cannot trust, not a fresh check.
  if (ageHours < 0 || ageHours >= everyHours) {
    return {
      ageHours,
      everyHours,
      lastGreen,
      reason: 'full-check-due',
      run: true,
    };
  }
  return {
    ageHours,
    everyHours,
    reason: 'nothing-ts-staged',
    run: false,
    staged: staged.paths,
  };
}

// ---------------------------------------------------------------------------
// What it says
// ---------------------------------------------------------------------------

const KNOB_NAME = `componentConfig.${HUSKY_CONFIG_KEY}.tsCheckOnCommit`;

/** Up to three paths, then a count. */
function listPaths(paths: readonly string[]): string {
  const shown = paths.slice(0, 3).join(', ');
  return paths.length > 3 ? `${shown}, +${paths.length - 3} more` : shown;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** "under a minute", "42m", "5h 3m", "2d 4h". */
export function formatAge(hours: number): string {
  const minutes = Math.floor(hours * 60);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes}m`;
  const wholeHours = Math.floor(minutes / 60);
  if (wholeHours < 24) return `${wholeHours}h ${minutes % 60}m`;
  return `${Math.floor(wholeHours / 24)}d ${wholeHours % 24}h`;
}

function fullCheckCause(
  decision: Extract<GateDecision, {reason: 'full-check-due'}>,
): string {
  const {lastGreen} = decision;
  switch (lastGreen.kind) {
    case 'none':
      return 'this checkout has no green type-check on record';
    case 'unreadable':
      return `the record of the last green type-check could not be read (${lastGreen.error})`;
    case 'recorded':
      return decision.ageHours != null && decision.ageHours < 0
        ? `the last green type-check is dated in the future (${lastGreen.at.toISOString()}), so it is not trusted`
        : `the last green type-check was ${formatAge(decision.ageHours ?? 0)} ago (the limit is ${decision.everyHours}h)`;
  }
}

/** The one line printed before the type-check runs or is skipped; null prints nothing. */
export function decisionLine(decision: GateDecision): string | null {
  switch (decision.reason) {
    case 'always':
      return null;
    case 'staged-unknown':
      return `ts-check: running, because the staged files could not be listed (${decision.staged.error})`;
    case 'ts-staged':
      return `ts-check: running, because ${plural(decision.relevant.length, 'staged file')} can affect type-checking: ${listPaths(decision.relevant)}`;
    case 'full-check-due':
      return `ts-check: running the regular full check. Nothing staged affects type-checking, but ${fullCheckCause(decision)}`;
    case 'nothing-ts-staged': {
      const what =
        decision.staged.length === 0
          ? 'nothing is staged'
          : `no staged file can affect type-checking (${listPaths(decision.staged)})`;
      return `ts-check skipped: ${what}. Last green check ${formatAge(decision.ageHours)} ago; a full check runs once that passes ${decision.everyHours}h [${KNOB_NAME}]`;
    }
  }
}

/** Printed after a red type-check that ran only because the full check was due. */
export const FULL_CHECK_FAILED_LINE =
  'ts-check: the regular full check failed. The errors above may be in files this commit does not touch; the commit stays blocked until type-checking passes in this checkout.';
