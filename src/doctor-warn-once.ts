/**
 * Session start prints each doctor warning once per change, not once per session
 * (home-base-p05kz.4 change 1). LINT_STAGED_INSTALLED appeared in 95 sessions over
 * 4 weeks, and a line that never changes stops being read.
 *
 * A warning prints when it first appears, and again as soon as its text changes.
 * While it is unchanged, the report carries one line naming it. A warning that
 * resolves loses its row, so it prints again if it returns.
 *
 * Only `session-start` installs this filter. `doctor` by hand has no way to take
 * one (see `RenderCheckTreeOptions`), and error-level checks never reach it.
 *
 * FAILING TO MEASURE NEVER HIDES A WARNING (critical rule 7). A state file that
 * cannot be read, parsed or written, and a repo that cannot be identified, all
 * show everything and say so in the same one line.
 *
 * The state is its own file, not a key in health-notices.json: `parseState` there
 * rebuilds the object from the keys it knows, so an older pinned SDK writing that
 * file would erase these rows.
 *
 * Rows are keyed by the repo's common git directory, not by checkout, so a new
 * worktree session does not reprint every warning.
 */

import type {
  WarningFilter,
  WarningFilterDecision,
  WarningForFilter,
} from './check-runner';

import {spawnSync} from 'child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import {dirname, join} from 'path';

import {DOCTOR_COMMAND, xdgStateHome} from './health-notices';

const SCHEMA_VERSION = 1;

interface ShownRow {
  /** When this text was printed. For a human reading the file. */
  shownAt: string;
  text: string;
}

/** Common git directory -> check label -> what was last printed. */
type ShownRepos = Record<string, Record<string, ShownRow>>;

type ShownRead =
  | {detail: string; status: 'broken'}
  | {detail: string; status: 'newer'}
  | {repos: ShownRepos; status: 'ok'};

export function warnOnceStatePath(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(xdgStateHome(env), 'justin-sdk', 'doctor-warnings-shown.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/** Any row that is off rejects the whole file: never a partly trusted one. */
function parseRepos(value: unknown): ShownRepos | null {
  if (!isRecord(value)) return null;
  const repos: ShownRepos = {};
  for (const [repo, rows] of Object.entries(value)) {
    if (!isRecord(rows)) return null;
    const parsed: Record<string, ShownRow> = {};
    for (const [label, row] of Object.entries(rows)) {
      if (!isRecord(row)) return null;
      if (typeof row.shownAt !== 'string' || typeof row.text !== 'string') {
        return null;
      }
      parsed[label] = {shownAt: row.shownAt, text: row.text};
    }
    repos[repo] = parsed;
  }
  return repos;
}

function readShown(file: string): ShownRead {
  if (!existsSync(file)) return {repos: {}, status: 'ok'};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf-8'));
    if (isRecord(parsed) && parsed.schemaVersion !== SCHEMA_VERSION) {
      return {
        detail: `schemaVersion ${JSON.stringify(parsed.schemaVersion)}`,
        status: 'newer',
      };
    }
    const repos = isRecord(parsed) ? parseRepos(parsed.repos) : null;
    if (repos == null) {
      return {detail: 'a field had the wrong shape', status: 'broken'};
    }
    return {repos, status: 'ok'};
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {detail, status: 'broken'};
  }
}

/** Temp file then rename, so a killed process cannot leave half a file. */
function writeShown(file: string, repos: ShownRepos): boolean {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(file), {recursive: true});
    writeFileSync(
      temp,
      `${JSON.stringify({repos, schemaVersion: SCHEMA_VERSION}, null, 2)}\n`,
    );
    renameSync(temp, file);
    return true;
  } catch {
    try {
      rmSync(temp, {force: true});
    } catch {
      // Already on the failure path, and the caller reports that.
    }
    return false;
  }
}

/** The repo's common git directory, or null when it cannot be measured. */
export function repoKeyFor(projectRoot: string): string | null {
  const result = spawnSync(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    {cwd: projectRoot, encoding: 'utf-8'},
  );
  if (result.status !== 0) return null;
  const key = result.stdout.replace(/\n$/, '');
  return key === '' ? null : key;
}

function everyWarning(why: string): WarningFilterDecision {
  return {hide: [], note: `Showing every warning: ${why}.`};
}

function hiddenNote(labels: readonly string[]): string {
  const count = labels.length === 1 ? '1 warning' : `${labels.length} warnings`;
  const them = labels.length === 1 ? 'it' : 'them';
  return `${count} unchanged since last shown: ${labels.join(', ')}. Run \`${DOCTOR_COMMAND}\` to see ${them}.`;
}

/**
 * The next rows for one repo, and which warnings they let the report hide.
 *
 * A warning with no text cannot be compared, so it is never hidden and gets no
 * row. A warning missing from `warnings` gets no row either, which is how a
 * resolved warning comes to print again when it returns.
 */
export function decideWarnOnce(options: {
  now: Date;
  previous: Readonly<Record<string, ShownRow>>;
  warnings: readonly WarningForFilter[];
}): {hide: string[]; rows: Record<string, ShownRow>} {
  const hide: string[] = [];
  const rows: Record<string, ShownRow> = {};
  for (const {label, text} of options.warnings) {
    if (text == null) continue;
    const prior = options.previous[label];
    if (prior?.text === text) {
      hide.push(label);
      rows[label] = prior;
    } else {
      rows[label] = {shownAt: options.now.toISOString(), text};
    }
  }
  return {hide, rows};
}

/** The filter for one repo. `repoKey` null means it could not be identified. */
export function makeWarnOnceFilter(options: {
  now?: Date;
  repoKey: string | null;
  stateFile: string;
}): WarningFilter {
  const {now = new Date(), repoKey, stateFile} = options;
  return (warnings) => {
    if (repoKey == null) {
      return everyWarning('could not tell which repository this is');
    }
    const read = readShown(stateFile);
    if (read.status === 'newer') {
      // Not ours to overwrite: it holds every repo's rows.
      return everyWarning(
        `${stateFile} was written by another justin-sdk version (${read.detail})`,
      );
    }
    const repos = read.status === 'ok' ? read.repos : {};
    const {hide, rows} = decideWarnOnce({
      now,
      previous: repos[repoKey] ?? {},
      warnings,
    });

    // Rewriting also heals a corrupt file, and a repo that is gone loses its row.
    const next: ShownRepos = {[repoKey]: rows};
    for (const [repo, repoRows] of Object.entries(repos)) {
      if (repo !== repoKey && existsSync(repo)) next[repo] = repoRows;
    }
    if (!writeShown(stateFile, next)) {
      return everyWarning(`could not write ${stateFile}`);
    }
    if (read.status === 'broken') {
      return everyWarning(`could not read ${stateFile} (${read.detail})`);
    }
    return {hide, note: hide.length === 0 ? null : hiddenNote(hide)};
  };
}

/**
 * The filter `session-start` passes to `renderDoctor`, or undefined when the
 * knob is off. The master switch counts too: with `healthNotices.enabled` false
 * there is no state to consult and every warning prints.
 *
 * `sdk-config` is imported here, not at the top: it pulls in zod, which must stay
 * off the path `cli.ts` loads statically (the same reason as health-notices.ts).
 */
export async function sessionStartWarningFilter(
  projectRoot: string,
  env: Record<string, string | undefined> = process.env,
): Promise<WarningFilter | undefined> {
  const {resolveHealthNoticesConfig} = await import('./sdk-config');
  const config = resolveHealthNoticesConfig(projectRoot, env);
  if (!config.enabled || !config.doctor.warnOncePerChange) return undefined;
  return makeWarnOnceFilter({
    repoKey: repoKeyFor(projectRoot),
    stateFile: warnOnceStatePath(env),
  });
}
