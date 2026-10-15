/**
 * Running `br` (beads_rust) — the ONE place the SDK shells out to it.
 *
 * `runBr` was extracted from the old `src/ralph.ts` (home-base-1r6d.33.2, D1)
 * into `src/justin-loop/br.ts` so the loop's `handoff.ts` and `runner.ts` could
 * share it, and moved HERE by home-base-vzwbj.4.1 (status report v4, dispatch 1)
 * so the thread commands use the same runner instead of a second one. The
 * justin-loop imports it from this file; there is no re-export left behind.
 *
 * On top of the raw runner sit typed helpers (list, show, create, update,
 * close, label add/remove) for the v4 session and request beads. Every one of
 * them returns a DISCRIMINATED OUTCOME, and a failed br call is never `null`,
 * `[]` or `0` (critical rule 7): "br could not answer" and "br answered: none"
 * are different facts, and the session-bead code makes a create-or-not decision
 * on exactly that difference.
 *
 * TARGETS. Each helper takes `{cwd}` (br auto-discovers `.beads/*.db` from
 * there) or `{db}` (br's global `--db <path>`, which writes to another
 * checkout's database from any cwd — verified 2026-10-11 with br 0.1.37; epic
 * home-base-vzwbj.4 D1 "which DB a write goes to" relies on it).
 */
import {spawnSync} from 'node:child_process';
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';

export interface BrOutcome {
  ok: boolean;
  /** Why it failed, in ONE line. null when ok — never an empty string. */
  reason: string | null;
  /**
   * Everything `br` wrote to stderr, trimmed (home-base-685h F4).
   *
   * `reason` is the first line only, which is the right size for a summary and
   * the wrong size for a diagnosis: br's real failures run to several lines (a
   * clap usage block, a Dolt error with its context, the auto-export warnings
   * followed by the actual error), and the D14 close-failure print showed the
   * first of them and threw the rest away.
   *
   * null when br printed NOTHING to stderr — never `''`. An empty string would
   * say br produced an empty diagnostic, which is a different fact from having
   * produced none at all (critical rule 7, and the null rule).
   */
  stderr: string | null;
  stdout: string;
}

/** How many lines of a failed call's stderr are worth printing. */
export const BR_STDERR_LINES = 5;

/** Trimmed stderr, or null when there was none. Never `''`. */
function capturedStderr(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The lines of a failed call's stderr that `reason` does NOT already carry.
 *
 * Callers print `reason` first, so line 1 would be a duplicate; this returns
 * lines 2..`max`, plus a count of anything past the bound rather than trailing
 * off silently. Empty when br said one line or nothing — so a caller can print
 * it unconditionally and a single-line failure looks exactly as it did before.
 */
export function brFailureDetail(
  out: BrOutcome,
  max: number = BR_STDERR_LINES,
): string[] {
  if (out.stderr == null) return [];
  const rest = out.stderr.split('\n').slice(1);
  if (rest.length === 0) return [];
  const shown = rest.slice(0, Math.max(0, max - 1));
  const hidden = rest.length - shown.length;
  return hidden > 0
    ? [...shown, `… and ${hidden} more line${hidden === 1 ? '' : 's'} from br`]
    : shown;
}

export type BrRunner = (cwd: string, args: string[]) => BrOutcome;

/**
 * An environment for one br call, merged OVER `process.env`
 * (home-base-vzwbj.4.9 P2). A key set to `undefined` UNSETS that variable for
 * br — which is how a caller keeps a `BEADS_DB` / `BEADS_DIR` exported in
 * Justin's shell from redirecting a `{cwd}` call, and how the tests' isolated
 * worlds (`CMUX_SURFACE_ID: undefined`) mean "not set" rather than the string
 * "undefined".
 */
export type BrEnv = Readonly<Record<string, string | undefined>>;

/**
 * The environment br is spawned with: `process.env`, then `env` over it.
 *
 * Built fresh on every call and passed explicitly, never omitted: Bun's
 * spawnSync without `env` uses a snapshot taken at startup and ignores later
 * `process.env` mutations (the tests' pinned-br PATH is one; see
 * tests/sandbox.ts for the measurement).
 */
export function brSpawnEnv(env: BrEnv | undefined): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) merged[key] = value;
  }
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value === undefined) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

/**
 * `runBr`, plus the raw stdout of a FAILED call. `runBr` blanks stdout on
 * failure (its callers read stdout only on success), but br writes a `--json`
 * call's error body to STDOUT when piped — measured 2026-10-11, br 0.1.37:
 * `br show <missing> --json` exits 3 with `{"error": {"code":
 * "ISSUE_NOT_FOUND", …}}` on stdout and nothing on stderr. The typed helpers
 * need that body to tell "not found" from "failed".
 */
function spawnBr(
  cwd: string,
  args: string[],
  env?: BrEnv,
): {outcome: BrOutcome; rawStdout: string} {
  const proc = spawnSync('br', [...args, '--no-auto-import'], {
    cwd,
    encoding: 'utf-8',
    env: brSpawnEnv(env),
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60_000,
  });
  const stderr = capturedStderr(proc.stderr);
  const rawStdout = proc.stdout ?? '';
  if (proc.error != null) {
    return {
      outcome: {
        ok: false,
        reason: `br could not run: ${proc.error.message}`,
        stderr,
        stdout: '',
      },
      rawStdout,
    };
  }
  if (proc.status !== 0) {
    const firstStderrLine = stderr?.split('\n')[0] ?? '';
    const how =
      proc.status != null
        ? `exited ${proc.status}`
        : `was killed (${proc.signal ?? 'unknown signal'})`;
    return {
      outcome: {
        ok: false,
        reason: `br ${how}${firstStderrLine !== '' ? `: ${firstStderrLine}` : ''}`,
        stderr,
        stdout: '',
      },
      rawStdout,
    };
  }
  // A SUCCESSFUL call's stderr is kept too: br writes its auto-export warnings
  // there and exits 0, and a caller that wants to show them should not have to
  // run the command again to see them.
  return {
    outcome: {ok: true, reason: null, stderr, stdout: rawStdout},
    rawStdout,
  };
}

/**
 * Run `br`, injectable so every caller is testable without a beads workspace.
 *
 * `--no-auto-import` on EVERY call, reads included: br's auto-import runs a real
 * `git merge origin/main` in the working directory (home-base c2u5 — a merge
 * that "appeared out of nowhere" in a worktree). A loop runner that quietly
 * merged into someone's branch mid-session would be far worse than a stale bead
 * list. MEASURED: accepted by br 0.1.37 and br 0.4.1 alike.
 *
 * `env` is merged over `process.env` (see `BrEnv`).
 */
export function runBr(cwd: string, args: string[], env?: BrEnv): BrOutcome {
  return spawnBr(cwd, args, env).outcome;
}

// ---------------------------------------------------------------------------
// Finding a beads workspace
// ---------------------------------------------------------------------------

/**
 * Where a checkout's beads live, or why there are none.
 *
 * THREE outcomes on purpose (rule 7): `none` is a measured "this checkout has
 * no br database" (not a git repo, no `.beads/`, or a `.beads/` with no `*.db`
 * — a bd/Dolt workspace, say); `failed` is "could not tell", which no caller
 * may read as `none`.
 */
export type BeadsWorkspace =
  | {beadsDir: string; db: string; kind: 'found'; root: string}
  | {kind: 'failed'; reason: string}
  | {kind: 'none'; reason: string};

function errorCode(error: unknown): string | null {
  return error != null && typeof error === 'object' && 'code' in error
    ? String((error as {code: unknown}).code)
    : null;
}

/**
 * The br database inside a `.beads/` directory: `beads.db` when present, else
 * the only `*.db`. Shared by workspace discovery and by readers that hold a
 * `beadsDir` from the sessions index, so the two never pick different files.
 */
export function findBeadsDb(
  beadsDir: string,
):
  | {db: string; kind: 'found'}
  | {kind: 'failed'; reason: string}
  | {kind: 'none'; reason: string} {
  let entries: string[];
  try {
    entries = readdirSync(beadsDir);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return {kind: 'none', reason: `no beads directory at ${beadsDir}`};
    }
    return {
      kind: 'failed',
      reason: `could not read ${beadsDir}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const dbs = entries.filter((name) => name.endsWith('.db')).sort();
  if (dbs.includes('beads.db')) {
    return {db: join(beadsDir, 'beads.db'), kind: 'found'};
  }
  const [only] = dbs;
  if (dbs.length === 1 && only != null) {
    return {db: join(beadsDir, only), kind: 'found'};
  }
  if (dbs.length === 0) {
    return {
      kind: 'none',
      reason: `${beadsDir} holds no *.db file (not a br workspace)`,
    };
  }
  return {
    kind: 'failed',
    reason: `${beadsDir} holds ${dbs.length} *.db files and none is beads.db: ${dbs.join(', ')}`,
  };
}

/**
 * The beads workspace of the checkout containing `cwd`: `.beads/*.db` next to
 * `git rev-parse --show-toplevel`. "Not a git repository" is a measured `none`;
 * any other git failure is `failed`.
 */
export function findBeadsWorkspace(cwd: string): BeadsWorkspace {
  if (!existsSync(cwd)) {
    return {kind: 'failed', reason: `the directory does not exist: ${cwd}`};
  }
  const proc = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf-8',
    timeout: 15_000,
  });
  if (proc.error != null) {
    return {
      kind: 'failed',
      reason: `git could not run in ${cwd}: ${proc.error.message}`,
    };
  }
  if (proc.status !== 0) {
    const stderr = (proc.stderr ?? '').trim();
    if (/not a git repository/i.test(stderr)) {
      return {kind: 'none', reason: `${cwd} is not inside a git repository`};
    }
    return {
      kind: 'failed',
      reason: `git rev-parse --show-toplevel failed in ${cwd}: ${stderr === '' ? `exit ${proc.status ?? 'unknown'}` : (stderr.split('\n')[0] ?? stderr)}`,
    };
  }
  const root = (proc.stdout ?? '').trim();
  if (root === '') {
    return {
      kind: 'failed',
      reason: `git rev-parse --show-toplevel printed nothing in ${cwd}`,
    };
  }
  const beadsDir = join(root, '.beads');
  const db = findBeadsDb(beadsDir);
  if (db.kind !== 'found') return db;
  return {beadsDir, db: db.db, kind: 'found', root};
}

// ---------------------------------------------------------------------------
// Typed helpers (home-base-vzwbj.4.1)
// ---------------------------------------------------------------------------

/**
 * Where a br call goes: br's own discovery from `cwd`, or an explicit database
 * file via the global `--db` flag (any cwd). `env`, when given, is merged over
 * `process.env` for the call (home-base-vzwbj.4.9 P2); callers that were handed
 * an env (every v4 command takes one) pass it here.
 */
export type BrTarget = ({cwd: string} | {db: string}) & {env?: BrEnv};

/** A br call that did not produce an answer. Never a stand-in for "none". */
export interface BrFailed {
  /** The br command line that failed, for the reader. */
  command: string;
  /** br's stderr past the first line, bounded (see `brFailureDetail`). */
  detail: string[];
  kind: 'failed';
  /** One line: why. */
  reason: string;
}

/** One bead, as br's `--json` prints it, with the fields the SDK reads. */
export interface BrIssue {
  /**
   * Why it was closed (`close_reason`, set by `br close --reason`), null when
   * open or closed without one. The v4 answer store: `answer: <text>`.
   */
  closeReason: string | null;
  /**
   * When it was closed (`closed_at`), null while it is open. Added by
   * home-base-vzwbj.4.2: `thread answers` compares it with Claude's last yield.
   */
  closedAt: string | null;
  createdAt: string | null;
  description: string | null;
  id: string;
  issueType: string;
  /**
   * The bead's labels. br OMITS the `labels` key when a bead has none (not
   * `[]`, measured 2026-10-11 on br 0.1.37), so an absent key is a measured
   * "no labels" and becomes `[]` here — that is br's own encoding of none, not
   * a failure being papered over.
   */
  labels: string[];
  /** The notes field; null when the bead has none. */
  notes: string | null;
  priority: number | null;
  status: string;
  title: string;
  updatedAt: string | null;
}

export type BrListOutcome = BrFailed | {issues: BrIssue[]; kind: 'ok'};
export type BrShowOutcome =
  | BrFailed
  | {id: string; kind: 'notFound'}
  | {issue: BrIssue; kind: 'ok'};
export type BrCreateOutcome = BrFailed | {id: string; kind: 'ok'};
export type BrWriteOutcome = BrFailed | {kind: 'ok'};

function describeTarget(target: BrTarget): string {
  return 'db' in target ? `--db ${target.db}` : `(cwd ${target.cwd})`;
}

/**
 * The cwd a `{db}` call runs from: the checkout that holds the database (the
 * parent of `.beads/`). br itself does not need it — `--db` works from any cwd
 * — but mise resolves the PINNED br version from the cwd's mise.toml, so this
 * runs the br that checkout pins rather than whatever the caller's cwd pins.
 */
function cwdForDb(db: string): string {
  return dirname(dirname(db));
}

function asText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * br's structured error, when a `--json` call fails: `{"error": {"code",
 * "message", …}}`, on stdout when piped (measured 2026-10-11, br 0.1.37; a
 * terminal shows it either way). null when the text is not that shape.
 */
function brJsonError(
  text: string | null,
): {code: string | null; message: string} | null {
  if (text == null) return null;
  // From the first brace: a mise warning line can precede br's own output.
  const start = text.indexOf('{');
  if (start === -1) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start));
    if (parsed == null || typeof parsed !== 'object') return null;
    const error = (parsed as {error?: unknown}).error;
    if (error == null || typeof error !== 'object') return null;
    const message = asText((error as {message?: unknown}).message);
    if (message == null) return null;
    return {code: asText((error as {code?: unknown}).code), message};
  } catch {
    return null;
  }
}

function failedFrom(
  out: BrOutcome,
  rawStdout: string,
  target: BrTarget,
  args: string[],
): BrFailed {
  const command = `br ${'db' in target ? `--db ${target.db} ` : ''}${args.join(' ')}`;
  const structured = brJsonError(rawStdout) ?? brJsonError(out.stderr);
  if (structured != null) {
    // The JSON body spread over lines is noise in a one-line reason; its
    // message is the diagnosis, and its code stays visible for matching.
    return {
      command,
      detail: [],
      kind: 'failed',
      reason: `${out.reason?.split(':')[0] ?? 'br failed'}: ${structured.message}${structured.code != null ? ` (${structured.code})` : ''}`,
    };
  }
  return {
    command,
    detail: brFailureDetail(out),
    kind: 'failed',
    reason: out.reason ?? 'br failed without saying why',
  };
}

/**
 * Run br against a target. A `{db}` whose file does not exist is refused here,
 * by name: spawning with a vanished checkout as cwd would fail as `spawnSync br
 * ENOENT`, which reads as "br is not installed" — the wrong diagnosis.
 */
function callBr(
  target: BrTarget,
  args: string[],
): {failed: BrFailed; ok: false} | {ok: true; out: BrOutcome} {
  if ('db' in target) {
    if (!existsSync(target.db)) {
      return {
        failed: {
          command: `br --db ${target.db} ${args.join(' ')}`,
          detail: [],
          kind: 'failed',
          reason: `beads database not found: ${target.db}`,
        },
        ok: false,
      };
    }
    const run = spawnBr(
      cwdForDb(target.db),
      ['--db', target.db, ...args],
      target.env,
    );
    return run.outcome.ok
      ? {ok: true, out: run.outcome}
      : {
          failed: failedFrom(run.outcome, run.rawStdout, target, args),
          ok: false,
        };
  }
  const run = spawnBr(target.cwd, args, target.env);
  return run.outcome.ok
    ? {ok: true, out: run.outcome}
    : {failed: failedFrom(run.outcome, run.rawStdout, target, args), ok: false};
}

/** One issue object from br's JSON, or null when it is not shaped like one. */
function parseIssue(value: unknown): BrIssue | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = asText(record.id);
  const title = asText(record.title);
  const status = asText(record.status);
  const issueType = asText(record.issue_type);
  if (id == null || title == null || status == null || issueType == null) {
    return null;
  }
  const rawLabels = record.labels;
  let labels: string[];
  if (rawLabels === undefined) {
    labels = [];
  } else if (
    Array.isArray(rawLabels) &&
    rawLabels.every((label) => typeof label === 'string')
  ) {
    labels = rawLabels;
  } else {
    // Present but not a list of strings: br changed shape. Refuse the record
    // rather than read it as "no labels".
    return null;
  }
  return {
    closeReason: asText(record.close_reason),
    closedAt: asText(record.closed_at),
    createdAt: asText(record.created_at),
    description: asText(record.description),
    id,
    issueType,
    labels,
    notes: asText(record.notes),
    priority: typeof record.priority === 'number' ? record.priority : null,
    status,
    title,
    updatedAt: asText(record.updated_at),
  };
}

/** Parse a list of issue records, or the reason it could not be. */
export function parseBrIssues(
  values: unknown[],
): {issues: BrIssue[]; ok: true} | {ok: false; reason: string} {
  const issues: BrIssue[] = [];
  for (const [index, value] of values.entries()) {
    const issue = parseIssue(value);
    if (issue == null) {
      return {
        ok: false,
        reason: `record ${index} is not an issue (missing id/title/status/issue_type, or labels is not a string list)`,
      };
    }
    issues.push(issue);
  }
  return {issues, ok: true};
}

export interface BrListFilters {
  /** Include closed beads (`--all`). */
  all: boolean;
  /** AND-filter on labels (`-l`, repeated). */
  labels?: string[];
  /** Filter on issue types (`-t`, repeated). */
  types?: string[];
}

/**
 * `br list --json --limit 0`, parsed. `--limit 0` ALWAYS: br's default is 50,
 * and a list silently cut at 50 is a measurement that lies about "none left".
 */
export function brList(
  target: BrTarget,
  filters: BrListFilters,
): BrListOutcome {
  const args = ['list', '--json', '--limit', '0'];
  if (filters.all) args.push('--all');
  for (const type of filters.types ?? []) args.push('-t', type);
  for (const label of filters.labels ?? []) args.push('-l', label);
  const call = callBr(target, args);
  if (!call.ok) return call.failed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.out.stdout);
  } catch (error) {
    return {
      command: `br ${args.join(' ')} ${describeTarget(target)}`,
      detail: [],
      kind: 'failed',
      reason: `br list printed something that is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const list =
    parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as {issues?: unknown}).issues
      : undefined;
  if (!Array.isArray(list)) {
    return {
      command: `br ${args.join(' ')} ${describeTarget(target)}`,
      detail: [],
      kind: 'failed',
      reason: 'br list --json printed no "issues" array',
    };
  }
  const issues = parseBrIssues(list);
  if (!issues.ok) {
    return {
      command: `br ${args.join(' ')} ${describeTarget(target)}`,
      detail: [],
      kind: 'failed',
      reason: `br list --json: ${issues.reason}`,
    };
  }
  return {issues: issues.issues, kind: 'ok'};
}

/**
 * br's not-found signal: exit 3 with `ISSUE_NOT_FOUND` (JSON mode) or
 * `Issue not found: <id>` (text mode) on stderr — measured 2026-10-11 on br
 * 0.1.37. Matched on the text, not the exit code alone, so some other exit-3
 * failure is never mistaken for an absence.
 */
function isNotFound(failed: BrFailed): boolean {
  const text = [failed.reason, ...failed.detail].join('\n');
  return /ISSUE_NOT_FOUND|Issue not found/.test(text);
}

/** `br show <id> --json`, parsed; a missing bead is `notFound`, not a failure. */
export function brShow(target: BrTarget, id: string): BrShowOutcome {
  const args = ['show', id, '--json'];
  const call = callBr(target, args);
  if (!call.ok) {
    return isNotFound(call.failed) ? {id, kind: 'notFound'} : call.failed;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.out.stdout);
  } catch (error) {
    return {
      command: `br ${args.join(' ')} ${describeTarget(target)}`,
      detail: [],
      kind: 'failed',
      reason: `br show printed something that is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  // br prints an array of one for `show <id>`; accept a bare object too.
  const records = Array.isArray(parsed) ? parsed : [parsed];
  const issues = parseBrIssues(records);
  if (!issues.ok || issues.issues.length !== 1) {
    return {
      command: `br ${args.join(' ')} ${describeTarget(target)}`,
      detail: [],
      kind: 'failed',
      reason: issues.ok
        ? `br show --json returned ${issues.issues.length} records for one id`
        : `br show --json: ${issues.reason}`,
    };
  }
  const [issue] = issues.issues;
  if (issue == null) {
    return {
      command: `br ${args.join(' ')} ${describeTarget(target)}`,
      detail: [],
      kind: 'failed',
      reason: 'br show --json returned no record',
    };
  }
  return {issue, kind: 'ok'};
}

/** A child of a bead, as `br show --json` lists it under `dependents`. */
export interface BrChild {
  id: string;
  status: string;
  title: string;
}

export type BrChildrenOutcome =
  | BrFailed
  | {children: BrChild[]; kind: 'ok'}
  | {id: string; kind: 'notFound'};

/**
 * A bead's CHILDREN: the `dependents` of `br show <id> --json` whose
 * `dependency_type` is `parent-child` (br 0.1.37; `br list --json` carries no
 * parent field, measured 2026-10-11). Added by home-base-vzwbj.4.2 so `thread
 * done` can name what it leaves open.
 */
export function brChildren(target: BrTarget, id: string): BrChildrenOutcome {
  const args = ['show', id, '--json'];
  const call = callBr(target, args);
  if (!call.ok) {
    return isNotFound(call.failed) ? {id, kind: 'notFound'} : call.failed;
  }
  const command = `br ${args.join(' ')} ${describeTarget(target)}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.out.stdout);
  } catch (error) {
    return {
      command,
      detail: [],
      kind: 'failed',
      reason: `br show printed something that is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const record: unknown = Array.isArray(parsed) ? parsed[0] : parsed;
  if (record == null || typeof record !== 'object') {
    return {
      command,
      detail: [],
      kind: 'failed',
      reason: 'br show --json returned no record',
    };
  }
  const dependents = (record as {dependents?: unknown}).dependents;
  if (dependents === undefined) return {children: [], kind: 'ok'};
  if (!Array.isArray(dependents)) {
    return {
      command,
      detail: [],
      kind: 'failed',
      reason: 'br show --json: dependents is not a list',
    };
  }
  const children: BrChild[] = [];
  for (const entry of dependents) {
    if (entry == null || typeof entry !== 'object') {
      return {
        command,
        detail: [],
        kind: 'failed',
        reason: 'br show --json: a dependent is not an object',
      };
    }
    const value = entry as Record<string, unknown>;
    if (value.dependency_type !== 'parent-child') continue;
    const childId = asText(value.id);
    const status = asText(value.status);
    const title = asText(value.title);
    if (childId == null || status == null || title == null) {
      return {
        command,
        detail: [],
        kind: 'failed',
        reason: 'br show --json: a child has no id, status or title',
      };
    }
    children.push({id: childId, status, title});
  }
  return {children, kind: 'ok'};
}

/**
 * True ONLY when the target's export file was read and holds no non-blank
 * line. Anything not measured (no workspace, unreadable metadata or export) is
 * false, so the guard refuses: the exemption must be proven, never assumed.
 * The file name comes from `.beads/metadata.json` (`jsonl_export`), else br's
 * default `issues.jsonl`.
 */
function exportHoldsNoIssues(target: BrTarget): boolean {
  let beadsDir: string;
  if ('db' in target) {
    beadsDir = dirname(target.db);
  } else {
    const space = findBeadsWorkspace(target.cwd);
    if (space.kind !== 'found') return false;
    beadsDir = space.beadsDir;
  }
  let name = 'issues.jsonl';
  const metadataPath = join(beadsDir, 'metadata.json');
  if (existsSync(metadataPath)) {
    try {
      const metadata: unknown = JSON.parse(readFileSync(metadataPath, 'utf8'));
      const named =
        metadata != null && typeof metadata === 'object'
          ? (metadata as {jsonl_export?: unknown}).jsonl_export
          : undefined;
      if (typeof named === 'string' && named !== '') name = named;
    } catch {
      return false;
    }
  }
  try {
    return readFileSync(join(beadsDir, name), 'utf8').trim() === '';
  } catch {
    return false;
  }
}

/**
 * The refusal's words when the export is still ahead after the import (or the
 * import could not be judged safe), shared with the tests and the capture
 * record. It names the one command that clears the state.
 */
export const EXPORT_AHEAD_REASON =
  'issues.jsonl is newer than the beads DB (a git pull or checkout moved it past the DB): run `br sync --import-only` in that checkout first. Nothing was written, so nothing was clobbered';

/**
 * The refusal when BOTH sides changed since they last agreed. Importing there
 * loses the pulled edit (see `exportAheadOfDb`), so the SDK does not import,
 * and the words say so instead of naming the import as the way out.
 */
export const EXPORT_AND_DB_BOTH_AHEAD_REASON =
  'issues.jsonl and the beads DB have each changed since they last agreed (a git pull moved the export while the DB held unexported changes). Nothing was written and nothing was imported: `br sync --import-only` here keeps the DB copy of an issue both sides changed, and the next write would put it over the pulled one. Check `br sync --status` and settle it by hand';

/** The two freshness flags of `br sync --status --json`. */
interface SyncFreshness {
  dbNewer: boolean;
  jsonlNewer: boolean;
}

/**
 * Read `br sync --status --json`. A failed call, or one that printed no
 * boolean for either flag, is a refusal (critical rule 7): "unknown" is never
 * "safe to write".
 */
function readSyncFreshness(
  target: BrTarget,
): {failed: BrFailed; ok: false} | {freshness: SyncFreshness; ok: true} {
  const args = ['sync', '--status', '--json'];
  const call = callBr(target, args);
  if (!call.ok) {
    return {
      failed: {
        ...call.failed,
        reason: `could not check whether issues.jsonl is newer than the beads DB, so nothing was written: ${call.failed.reason}`,
      },
      ok: false,
    };
  }
  let jsonlNewer: unknown = null;
  let dbNewer: unknown = null;
  try {
    const text = call.out.stdout;
    const parsed: unknown = JSON.parse(
      text.slice(Math.max(0, text.indexOf('{'))),
    );
    if (parsed != null && typeof parsed === 'object') {
      jsonlNewer = (parsed as {jsonl_newer?: unknown}).jsonl_newer;
      dbNewer = (parsed as {db_newer?: unknown}).db_newer;
    }
  } catch {
    jsonlNewer = null;
  }
  if (typeof jsonlNewer !== 'boolean' || typeof dbNewer !== 'boolean') {
    return {
      failed: {
        command: `br ${args.join(' ')} ${describeTarget(target)}`,
        detail: [],
        kind: 'failed',
        reason: `could not check whether issues.jsonl is newer than the beads DB, so nothing was written: br sync --status --json printed no boolean jsonl_newer and db_newer (stdout: ${JSON.stringify(call.out.stdout.slice(0, 200))})`,
      },
      ok: false,
    };
  }
  return {freshness: {dbNewer, jsonlNewer}, ok: true};
}

/**
 * P1 (home-base-vzwbj.4.9), revised by home-base-j8q3e.1.10 F3 (fixes
 * home-base-vzwbj.4.14): never write while the JSONL export is ahead of the
 * database. When ONLY the export is ahead, import it first and go on; refuse
 * in every other unsafe or unknown state. Every typed write below calls this
 * first, and only the v4 thread commands and the capture child use them.
 *
 * WHY NOT WRITE AT ONCE, measured 2026-10-11 on br 0.1.37 (`bun run
 * measure:br-export-clobber`): a write's auto-flush rewrites the export line of
 * every issue it touched from the DB. Every SDK call carries
 * `--no-auto-import`, so after a `git pull` that changed an issue in
 * issues.jsonl, `br update` on that issue put the DB's OLDER copy back in the
 * export (the pulled title was lost).
 *
 * WHY IMPORT RATHER THAN REFUSE, measured 2026-10-15 on br 0.1.37 (`bun run
 * measure:br-import-only`): `br sync --import-only --no-auto-import` ran NO git
 * command (a PATH shim that does log br's `git rev-parse` under `br stats` saw
 * none), left HEAD where it was with `origin/main` one commit ahead, left `git
 * status` clean and issues.jsonl byte-identical, imported the pulled title and
 * the pulled bead, and kept a bead only the DB held. The refusal it replaces
 * stopped every v4 write after every merge into main (the conductor ran the
 * import by hand four times on 2026-10-15), and would have done so in every
 * repo the rollout reaches.
 *
 * WHY BOTH-AHEAD STILL REFUSES, measured the same day: with an unexported DB
 * edit (`db_newer: true`) and a pulled edit to the same issue, the import
 * exits 0, "Skipped: 1 issues (up-to-date)", and the DB keeps its own copy, so
 * the next write's flush would put it over the pulled one.
 *
 * br's own read-only `br sync --status --json` is the signal: `jsonl_newer` is
 * true in exactly the pulled state, false in every normal state, and false
 * after a bare `touch` of the export (it follows content). File mtimes are NOT
 * usable (measured 2026-10-11): right after a normal write the export is the
 * OLDEST of beads.db / beads.db-wal / issues.jsonl.
 *
 * The status is read again after the import: an import that exits 0 but
 * leaves `jsonl_newer` set is still a refusal.
 */
function exportAheadOfDb(target: BrTarget): BrFailed | null {
  const status = readSyncFreshness(target);
  if (!status.ok) return status.failed;
  if (!status.freshness.jsonlNewer) return null;
  // A freshly `br init`-ed workspace reports jsonl_newer: true with an EMPTY
  // export (nothing exported yet; measured 2026-10-11, br 0.1.37). An export
  // with no issue line holds nothing a write could clobber — and refusing there
  // would stop the first session bead in every new beads repo for good.
  if (exportHoldsNoIssues(target)) return null;
  const statusCommand = `br sync --status --json ${describeTarget(target)}`;
  if (status.freshness.dbNewer) {
    return {
      command: statusCommand,
      detail: [],
      kind: 'failed',
      reason: EXPORT_AND_DB_BOTH_AHEAD_REASON,
    };
  }
  const importArgs = ['sync', '--import-only'];
  const imported = callBr(target, importArgs);
  if (!imported.ok) {
    return {
      ...imported.failed,
      reason: `issues.jsonl is newer than the beads DB and importing it failed, so nothing was written: ${imported.failed.reason}. Fix what br names, then run \`br sync --import-only\` in that checkout`,
    };
  }
  const recheck = readSyncFreshness(target);
  if (!recheck.ok) return recheck.failed;
  if (recheck.freshness.jsonlNewer) {
    return {
      command: statusCommand,
      detail: [
        `br sync --import-only exited 0, but br still reports jsonl_newer: true`,
      ],
      kind: 'failed',
      reason: EXPORT_AHEAD_REASON,
    };
  }
  return null;
}

export interface BrCreateInput {
  description?: string | null;
  labels?: string[];
  parent?: string | null;
  priority?: number | null;
  status?: string | null;
  title: string;
  type: string;
}

/**
 * `br create … --silent`, which prints only the new id (verified 2026-10-11).
 * br create has NO notes or acceptance-criteria flag; set those with
 * `brUpdate` afterwards.
 *
 * EVERY free-text value goes as `--flag=value`, never as a separate argument
 * or the positional title: br (clap) reads a value that starts with `-` as a
 * flag — `br create '-x fix'` exits 2 with `unexpected argument '-x'`, while
 * `--title=-x fix` works (measured 2026-10-11, br 0.1.37). A request title is
 * Claude's free text, so this is reachable.
 */
export function brCreate(
  target: BrTarget,
  input: BrCreateInput,
): BrCreateOutcome {
  const args = ['create', `--title=${input.title}`, `--type=${input.type}`];
  if (input.status != null) args.push(`--status=${input.status}`);
  if (input.priority != null) args.push(`--priority=${input.priority}`);
  if (input.labels != null && input.labels.length > 0) {
    args.push(`--labels=${input.labels.join(',')}`);
  }
  if (input.parent != null) args.push(`--parent=${input.parent}`);
  if (input.description != null) {
    args.push(`--description=${input.description}`);
  }
  args.push('--silent');
  const ahead = exportAheadOfDb(target);
  if (ahead != null) return ahead;
  const call = callBr(target, args);
  if (!call.ok) return call.failed;
  const id = call.out.stdout.trim().split('\n').pop()?.trim() ?? '';
  if (id === '' || /\s/.test(id)) {
    return {
      command: `br create ${describeTarget(target)}`,
      detail: [],
      kind: 'failed',
      reason: `br create --silent exited 0 but printed no id (stdout: ${JSON.stringify(call.out.stdout.slice(0, 200))})`,
    };
  }
  return {id, kind: 'ok'};
}

export interface BrUpdateInput {
  acceptanceCriteria?: string | null;
  addLabels?: string[];
  /**
   * REPLACES the notes field (`br update --notes` is not an append). To append,
   * read the bead first and write the whole text back — `thread note` does.
   */
  notes?: string | null;
  /**
   * Re-parent (`br update --parent`), added by home-base-vzwbj.4.16 for the
   * old-shape question migration. `remove` sends `--parent=` (br: "empty
   * string removes parent"). MEASURED 2026-10-12, br 0.1.37: moving a bead
   * straight to one of its own ANCESTORS is refused ("Cycle detected in
   * dependencies: Setting parent of <q> to <s> would create a cycle", exit 5)
   * — remove first, then set. The id and status do not change.
   */
  parent?: {id: string; kind: 'set'} | {kind: 'remove'};
  removeLabels?: string[];
  status?: string | null;
  title?: string | null;
}

/**
 * `br update <id> …`. One call carries every field, so it is one br run.
 * Values as `--flag=value` (see `brCreate`).
 */
export function brUpdate(
  target: BrTarget,
  id: string,
  input: BrUpdateInput,
): BrWriteOutcome {
  const args = ['update', id];
  if (input.title != null) args.push(`--title=${input.title}`);
  if (input.status != null) args.push(`--status=${input.status}`);
  if (input.acceptanceCriteria != null) {
    args.push(`--acceptance-criteria=${input.acceptanceCriteria}`);
  }
  if (input.notes != null) args.push(`--notes=${input.notes}`);
  for (const label of input.addLabels ?? []) {
    args.push(`--add-label=${label}`);
  }
  for (const label of input.removeLabels ?? []) {
    args.push(`--remove-label=${label}`);
  }
  if (input.parent != null) {
    args.push(
      input.parent.kind === 'remove'
        ? '--parent='
        : `--parent=${input.parent.id}`,
    );
  }
  if (args.length === 2) {
    return {
      command: `br update ${id}`,
      detail: [],
      kind: 'failed',
      reason: 'brUpdate was called with nothing to change',
    };
  }
  const ahead = exportAheadOfDb(target);
  if (ahead != null) return ahead;
  const call = callBr(target, args);
  return call.ok ? {kind: 'ok'} : call.failed;
}

/**
 * `br close <id> --reason <reason>`, ONE id per call.
 *
 * One id on purpose: `br close` with NO id closes the last-touched bead, and
 * with several it can skip some (a parent with open children) while closing
 * the rest. A single-id call that br skips exits 3 (`Nothing to do: all 1
 * issue(s) skipped — <id>: parent issue has 1/1 open children`, measured
 * 2026-10-11, br 0.1.37), so its outcome is exactly this bead's.
 *
 * `force` passes `--force`, which closes a parent whose children are still
 * open (the children stay open). Off unless the caller says so.
 */
export function brClose(
  target: BrTarget,
  id: string,
  reason: string,
  options: {force?: boolean} = {},
): BrWriteOutcome {
  if (id.trim() === '') {
    return {
      command: 'br close',
      detail: [],
      kind: 'failed',
      reason:
        'brClose was called with no id (br would close the last-touched bead)',
    };
  }
  const args = ['close', id, `--reason=${reason}`];
  if (options.force === true) args.push('--force');
  const ahead = exportAheadOfDb(target);
  if (ahead != null) return ahead;
  const call = callBr(target, args);
  return call.ok ? {kind: 'ok'} : call.failed;
}

// Labels are added and removed through `brUpdate({addLabels, removeLabels})`
// (`--add-label=` / `--remove-label=`). There is deliberately no `br label`
// helper: `br label add [ISSUES]... -l <label>` takes ISSUE ids as its
// positionals, so the obvious `br label add <id> <labels…>` reads each label
// as an issue id ("Issue not found: request", measured 2026-10-11) — the two
// helpers that did that were never called and were deleted
// (home-base-vzwbj.4.9 F3).

/** One line for a failed call: the reason, then br's own extra lines. */
export function describeBrFailed(failed: BrFailed): string {
  return [failed.reason, ...failed.detail].join('\n  ');
}

/** Is `br` on PATH and runnable? For tests that must not pass without it. */
export function brAvailable(): boolean {
  const proc = spawnSync('br', ['--version'], {
    encoding: 'utf-8',
    env: brSpawnEnv(undefined),
  });
  return proc.error == null && proc.status === 0;
}
