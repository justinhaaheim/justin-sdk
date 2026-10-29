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
 * checkout's database from any cwd — verified 2026-10-11 with br 0.1.37, and
 * re-measured 2026-10-26 on 0.1.37 and 0.7.6 alike; epic home-base-vzwbj.4 D1
 * "which DB a write goes to" relies on it).
 *
 * RE-MEASURED ON br 0.7.6 (home-base-dj5m9.1.4): every br behaviour this file
 * cites is measured again by `bun run measure:br-contract --br <path>`
 * (scripts/measure-br-contract.ts), with measure:br-export-clobber and
 * measure:br-import-only for the write guard. Each comment below gives the
 * 0.7.6 result beside the 0.1.37 one.
 *
 * AN OLD br ON A NEW DB (home-base-dj5m9.1.5, `bun run measure:br-downgrade`,
 * measured 2026-10-29, scratch repos only). br 0.1.37 does NOT refuse a DB
 * that br 0.7.6 created (schema 19): with `--db <that DB>` from the primary
 * checkout, `list --json` (auto-import on and off), `show`, `create` (labels
 * and `--parent` included), `update`, `close` and `sync --flush-only` all
 * exit 0, and `create` from a linked worktree does too; every write lands in
 * the 0.7.6 DB (schema stays 19). That is what an old worktree's SDK does after the flip:
 * it passes `--db <primary's DB>` to the 0.1.37 its own pin names. After it:
 *   - 0.7.6 still opens the DB (`list`, `show` exit 0), and the DB keeps the
 *     fields only 0.7.6 has (`prerequisites`, `agent_context`).
 *   - The JSONL does not: 0.1.37's auto-flush rewrites the export without
 *     those fields, and 0.7.6 does not put them back on its next write to
 *     another issue, so the committed export silently loses them until that
 *     issue is written by 0.7.6 again.
 *   - 0.7.6's `doctor` reports "blocked_issues_cache is marked stale and
 *     needs rebuild" (WARN, exit 1), which the same writes by 0.7.6 alone do
 *     not cause.
 *   - Beads 0.1.37 creates carry `source_repo: "."` and no
 *     `source_repo_path` (0.7.6 writes the checkout's name and path).
 * A BARE 0.1.37 in a linked worktree with no DB of its own does not use the
 * primary's: it creates a new local `.beads/beads.db` there (from the
 * committed export) and writes to it, which 0.7.6 in that worktree would then
 * use instead of the primary's (see `findBeadsWorkspace`).
 */
import {spawnSync} from 'node:child_process';
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import {basename, dirname, join} from 'node:path';

import {primaryOfClaudeWorktreePath} from '../claude-worktree-path';

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

/**
 * A bead id as br prints it, as regex source: `<prefix>-<hash>`, then `.<n>`
 * per child level (`home-base-abcde`, `home-base-abcde.12`). Shared by the
 * `br create` output reader (thread/session-created.ts) and the `br close`
 * reader of the last-request nudge (thread/nudge.ts, home-base-yukaf.3).
 */
export const BEAD_ID_SOURCE = String.raw`[A-Za-z0-9][A-Za-z0-9_-]*-[A-Za-z0-9]+(?:\.\d+)*`;

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
 * failure (its callers read stdout only on success), but br can write a
 * `--json` call's error body to STDOUT: `br show <missing> --json` exits 3
 * with `{"error": {"code": "ISSUE_NOT_FOUND", …}}`, on STDOUT under br 0.7.6
 * and on STDERR under 0.1.37 (both measured 2026-10-26, piped; an earlier
 * note had 0.1.37 on stdout). `failedFrom` reads both. The typed helpers need
 * that body to tell "not found" from "failed".
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
 * list. MEASURED: accepted by br 0.1.37, 0.4.1 and 0.7.6 alike (0.7.6 on
 * 2026-10-26; its `br sync --help` adds that sync never runs git).
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
 *
 * A `found` says WHOSE database it is (home-base-dj5m9.1.1), because from br
 * 0.4.1 on a linked worktree can use its primary checkout's:
 *   - `via: 'checkout'`: `<root>/.beads`, the checkout's own. Every primary
 *     checkout, and a linked worktree that has a DB of its own (br 0.7.6 uses
 *     that one too, measured 2026-10-26 by scripts/probe-br-worktree-db.ts).
 *   - `via: 'primary'`: a linked worktree with no DB of its own whose br shares
 *     the primary checkout's (`brSharesWorktreeDb`). `beadsDir` and `db` are
 *     the PRIMARY's; `root` stays the worktree, the checkout the caller is in
 *     (its branch, its path in a sighting).
 */
export type BeadsWorkspace =
  | {
      beadsDir: string;
      db: string;
      kind: 'found';
      root: string;
      via: 'checkout';
    }
  | {
      beadsDir: string;
      /** The br version that shares the DB, as `br --version` printed it. */
      brVersion: string;
      db: string;
      kind: 'found';
      primaryRoot: string;
      root: string;
      via: 'primary';
    }
  | {
      /** Set when the worktree's br and its primary's disagree (F1). */
      brSplit?: BrPinSplit;
      kind: 'failed';
      reason: string;
    }
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

// ---------------------------------------------------------------------------
// Which br runs in a checkout, and whether it shares the primary's DB
// (home-base-dj5m9.1.1)
// ---------------------------------------------------------------------------

/** A br version's numbers. */
export interface BrSemver {
  major: number;
  minor: number;
  patch: number;
}

/**
 * The first br that uses the PRIMARY checkout's database from a linked
 * worktree that has none of its own. MEASURED: br 0.1.37 and 0.3.2 keep one DB
 * per worktree; 0.4.1, 0.5.10 and 0.7.6 share the primary's (2026-10-20
 * experiment, home-base-pp1vx.1.1's decision frame; 0.7.6 re-measured
 * 2026-10-26 by scripts/probe-br-worktree-db.ts). Versions between 0.3.2 and
 * 0.4.1 were never measured, so they count as per-worktree: that is what the
 * SDK assumed for every version before, so it is no change for them.
 */
export const BR_SHARED_DB_SINCE: BrSemver = {major: 0, minor: 4, patch: 1};

/**
 * The br version that runs in a checkout, or why it could not be read. A
 * `failed` is never read as "old" or "new" (rule 7): which DB br uses from a
 * worktree depends on it, so not knowing it is not knowing the DB.
 */
export type BrVersion =
  | {kind: 'failed'; reason: string}
  | (BrSemver & {kind: 'read'; text: string});

/** `br 0.7.6` (br's `--version` line) → its numbers; null for anything else. */
export function parseBrVersion(
  stdout: string,
): (BrSemver & {text: string}) | null {
  const match = /^br (\d+)\.(\d+)\.(\d+)\b/m.exec(stdout);
  const [, major, minor, patch] = match ?? [];
  if (major == null || minor == null || patch == null) return null;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    text: `${major}.${minor}.${patch}`,
  };
}

/** Does this br use the primary checkout's DB from a worktree without one? */
export function brSharesWorktreeDb(version: BrSemver): boolean {
  const since = BR_SHARED_DB_SINCE;
  if (version.major !== since.major) return version.major > since.major;
  if (version.minor !== since.minor) return version.minor > since.minor;
  return version.patch >= since.patch;
}

/**
 * The files in a checkout that mise reads its tool pins from. A change to any
 * of them can change which br runs there (home-base-dj5m9.1.6 F2). A parent
 * directory's config and mise's global config are not watched: no checkout of
 * an enrolled repo takes its br pin from either.
 */
const MISE_PIN_FILES = [
  'mise.toml',
  '.mise.toml',
  'mise.local.toml',
  '.mise.local.toml',
  '.tool-versions',
] as const;

/**
 * What decides which br a bare `br` runs in `checkout`: the checkout, `PATH`,
 * and each pin file's identity (size, mtime, ctime, inode, or why it could
 * not be stat'ed). Two equal signatures run the same br.
 */
function brPinSignature(checkout: string): string {
  const files = MISE_PIN_FILES.map((name) => {
    try {
      const stat = statSync(join(checkout, name));
      return `${name}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
    } catch (error) {
      return `${name}:${errorCode(error) ?? 'unreadable'}`;
    }
  });
  return [checkout, process.env.PATH ?? '', ...files].join('\u0000');
}

/**
 * The last `br --version` READ per checkout, with the pin signature it was
 * read under (see `brVersionIn`). A failure is never stored.
 */
const brVersionCache = new Map<
  string,
  {signature: string; version: Extract<BrVersion, {kind: 'read'}>}
>();

function readBrVersion(cwd: string): BrVersion {
  // MISE_OFFLINE (home-base-dj5m9.1.6 F4): this runs on the UserPromptSubmit
  // hook path, and a checkout that merged a new pin before `mise install`
  // would otherwise make the mise shim download br inside the hook. Offline, a
  // pin that is not installed fails, and the failure is a `failed`. A pin of
  // `latest` still resolves offline, to the newest installed br (measured
  // 2026-10-29 in a worktree pinned to `latest`: `br 0.7.6`).
  const proc = spawnSync('br', ['--version'], {
    cwd,
    encoding: 'utf-8',
    env: brSpawnEnv({MISE_OFFLINE: '1'}),
    timeout: 15_000,
  });
  if (proc.error != null) {
    return {
      kind: 'failed',
      reason: `br --version could not run in ${cwd}: ${proc.error.message}`,
    };
  }
  if (proc.status !== 0) {
    const first = capturedStderr(proc.stderr)?.split('\n')[0] ?? null;
    const how =
      proc.status != null
        ? `exited ${proc.status}`
        : `was killed (${proc.signal ?? 'unknown signal'})`;
    return {
      kind: 'failed',
      reason: `br --version ${how} in ${cwd}${first != null ? `: ${first}` : ''}`,
    };
  }
  const parsed = parseBrVersion(proc.stdout ?? '');
  if (parsed == null) {
    return {
      kind: 'failed',
      reason: `br --version in ${cwd} printed no version: ${JSON.stringify((proc.stdout ?? '').trim().slice(0, 80))}`,
    };
  }
  return {...parsed, kind: 'read'};
}

/**
 * The version of the br that runs in `checkout`, from `br --version` spawned
 * THERE: mise resolves the pinned br from the cwd's mise.toml, so this is the
 * br a bare `br` in that checkout runs.
 *
 * Cached per checkout, but only while the checkout's pin files and PATH are
 * unchanged, and never a failure (home-base-dj5m9.1.6 F2). The dashboard
 * server reads beads in one process for hours: a cache for the life of the
 * process kept the answer from before a pin flip (and read worktrees' stale
 * JSONL as current), and kept one transient `br --version` failure until a
 * restart. The cost is a few `stat`s per call. A failure is read again on the
 * next call, so two calls in one command can disagree only when the first one
 * failed.
 */
export function brVersionIn(checkout: string): BrVersion {
  const signature = brPinSignature(checkout);
  const cached = brVersionCache.get(checkout);
  if (cached?.signature === signature) return cached.version;
  const version = readBrVersion(checkout);
  if (version.kind === 'read') {
    brVersionCache.set(checkout, {signature, version});
  } else {
    brVersionCache.delete(checkout);
  }
  return version;
}

/**
 * A checkout's place in its repo, from ONE git call: the primary checkout, or
 * a linked worktree with the primary it belongs to.
 */
type CheckoutLayout =
  | {
      commonDir: string;
      kind: 'linked';
      /** null when git's common dir is not `<checkout>/.git` (a bare repo's worktree). */
      primaryRoot: string | null;
      root: string;
    }
  | {kind: 'failed'; reason: string}
  | {kind: 'notGit'; reason: string}
  | {kind: 'primary'; root: string};

const LAYOUT_ARGS = [
  'rev-parse',
  '--path-format=absolute',
  '--show-toplevel',
  '--git-dir',
  '--git-common-dir',
] as const;

/**
 * `git rev-parse --show-toplevel --git-dir --git-common-dir` from `cwd`. A
 * linked worktree's git dir is `<common>/worktrees/<name>`; the primary's IS
 * the common dir. "Not a git repository" is a measured `notGit`; any other
 * git failure is `failed`.
 */
function readCheckoutLayout(cwd: string): CheckoutLayout {
  const command = `git ${LAYOUT_ARGS.join(' ')}`;
  const proc = spawnSync('git', LAYOUT_ARGS, {
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
      return {kind: 'notGit', reason: `${cwd} is not inside a git repository`};
    }
    return {
      kind: 'failed',
      reason: `${command} failed in ${cwd}: ${stderr === '' ? `exit ${proc.status ?? 'unknown'}` : (stderr.split('\n')[0] ?? stderr)}`,
    };
  }
  const lines = (proc.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const [root, gitDir, commonDir] = lines;
  if (root == null || gitDir == null || commonDir == null) {
    return {
      kind: 'failed',
      reason: `${command} printed ${lines.length} of 3 paths in ${cwd}`,
    };
  }
  if (gitDir === commonDir) return {kind: 'primary', root};
  return {
    commonDir,
    kind: 'linked',
    primaryRoot: basename(commonDir) === '.git' ? dirname(commonDir) : null,
    root,
  };
}

/**
 * A linked worktree whose br and whose primary checkout's br disagree on
 * whether a worktree shares the primary's DB (home-base-dj5m9.1.6 F1). The
 * worktree's br is what a bare `br` there runs; the primary's is what runs
 * every `{db}` call (`cwdForDb`). The fix is the same pin in both checkouts.
 */
export interface BrPinSplit {
  primary: {checkout: string; version: string};
  worktree: {checkout: string; version: string};
}

type PrimaryDb =
  | {
      beadsDir: string;
      brVersion: string;
      db: string;
      kind: 'found';
      primaryRoot: string;
    }
  | {brSplit?: BrPinSplit; kind: 'failed'; reason: string}
  | {kind: 'none'; reason: string};

/** "br 0.7.6 (shares the primary's DB)", for a reason that names both brs. */
function describeBrSharing(version: BrVersion): string {
  if (version.kind === 'failed') return `an unreadable br (${version.reason})`;
  return brSharesWorktreeDb(version)
    ? `br ${version.text}, which shares the primary checkout's database`
    : `br ${version.text}, which keeps one database per worktree`;
}

/**
 * The primary checkout's DB for a linked worktree that has none of its own,
 * when the br that decides (`versionFrom`) shares it; otherwise `none`, which is
 * what the SDK said for every linked worktree without a DB before. A br before
 * 0.4.1 gets the worktree's own reason word for word; only when the primary has
 * no DB either does the reason grow a clause saying so.
 *
 * TWO brs are read (home-base-dj5m9.1.6 F1): the one that DECIDES (a bare `br`
 * in the worktree) and the one that RUNS every `{db}` call (the primary's:
 * `cwdForDb` spawns from the primary's root, so mise runs its pin). When they
 * disagree on sharing, the SDK would resolve one DB and drive it with a br
 * that disagrees, so two br generations write one live DB. That is `failed`
 * with `brSplit`, and so is either br being unreadable (without `brSplit`).
 * When `versionFrom` IS the primary (a worktree that is gone), one br does
 * both.
 *
 * Files before processes: the primary's `.beads/` is read first, so a repo
 * with no beads anywhere never spawns br; the version is asked only when the
 * answer depends on it.
 */
function primaryDbForWorktree(input: {
  ownReason: string;
  primaryRoot: string | null;
  /** Why `primaryRoot` is null, for the failure that names it. */
  primaryUnknown: string;
  versionFrom: string;
  worktree: string;
}): PrimaryDb {
  const {ownReason, primaryRoot} = input;
  const primaryBeads = primaryRoot == null ? null : join(primaryRoot, '.beads');
  const primaryDb = primaryBeads == null ? null : findBeadsDb(primaryBeads);
  if (primaryDb?.kind === 'none') {
    // Neither checkout holds a DB, so no br version finds one.
    return {
      kind: 'none',
      reason: `${ownReason}; nor does its primary checkout (${primaryDb.reason})`,
    };
  }
  const version = brVersionIn(input.versionFrom);
  const runs =
    primaryRoot == null || primaryRoot === input.versionFrom
      ? null
      : brVersionIn(primaryRoot);
  if (version.kind === 'failed' || runs?.kind === 'failed') {
    const both =
      runs == null || primaryRoot == null
        ? ''
        : ` The worktree ${input.versionFrom} runs ${describeBrSharing(version)}; its primary checkout ${primaryRoot}, which runs every call on the primary's database, runs ${describeBrSharing(runs)}.`;
    return {
      kind: 'failed',
      reason: `${ownReason}; whether br uses the primary checkout's database instead depends on the br version, which could not be read: ${version.kind === 'failed' ? version.reason : runs?.kind === 'failed' ? runs.reason : ''}.${both}`,
    };
  }
  if (
    runs != null &&
    primaryRoot != null &&
    brSharesWorktreeDb(version) !== brSharesWorktreeDb(runs)
  ) {
    return {
      brSplit: {
        primary: {checkout: primaryRoot, version: runs.text},
        worktree: {checkout: input.versionFrom, version: version.text},
      },
      kind: 'failed',
      reason: `${ownReason}; the worktree ${input.versionFrom} runs ${describeBrSharing(version)}, but its primary checkout ${primaryRoot}, which runs every call on the primary's database, runs ${describeBrSharing(runs)}. The two would write one database with two br generations, so no database is chosen.`,
    };
  }
  if (!brSharesWorktreeDb(version)) return {kind: 'none', reason: ownReason};
  if (primaryRoot == null || primaryBeads == null || primaryDb == null) {
    return {
      kind: 'failed',
      reason: `${ownReason}; br ${version.text} uses the primary checkout's database from a linked worktree, but the primary checkout of ${input.worktree} could not be found: ${input.primaryUnknown}`,
    };
  }
  if (primaryDb.kind === 'failed') return primaryDb;
  return {
    beadsDir: primaryBeads,
    brVersion: version.text,
    db: primaryDb.db,
    kind: 'found',
    primaryRoot,
  };
}

/**
 * The beads workspace of the checkout containing `cwd`, found the way br
 * itself finds it (home-base-dj5m9.1.1):
 *   - a primary checkout: its own `.beads/*.db`, as before;
 *   - a linked worktree with a DB of its own: that DB (br uses it too);
 *   - a linked worktree without one: the PRIMARY checkout's DB when the br
 *     that runs in the worktree is 0.4.1 or later (`via: 'primary'`), and
 *     `none` when it is older, exactly as before. An unreadable br version is
 *     `failed`.
 * "Not a git repository" is a measured `none`; any other git failure is
 * `failed`.
 */
export function findBeadsWorkspace(cwd: string): BeadsWorkspace {
  if (!existsSync(cwd)) {
    return {kind: 'failed', reason: `the directory does not exist: ${cwd}`};
  }
  const layout = readCheckoutLayout(cwd);
  if (layout.kind === 'failed') return layout;
  if (layout.kind === 'notGit') return {kind: 'none', reason: layout.reason};
  const beadsDir = join(layout.root, '.beads');
  const own = findBeadsDb(beadsDir);
  if (own.kind === 'found') {
    return {
      beadsDir,
      db: own.db,
      kind: 'found',
      root: layout.root,
      via: 'checkout',
    };
  }
  if (own.kind === 'failed' || layout.kind === 'primary') return own;
  const shared = primaryDbForWorktree({
    ownReason: own.reason,
    primaryRoot: layout.primaryRoot,
    primaryUnknown: `git's common directory ${layout.commonDir} is not a checkout's .git`,
    versionFrom: layout.root,
    worktree: layout.root,
  });
  if (shared.kind !== 'found') return shared;
  return {...shared, root: layout.root, via: 'primary'};
}

/**
 * Where the beads of a RECORDED `.beads/` directory live now: the one way
 * every reader of a sessions-index `beadsDir` opens a DB (home-base-dj5m9.1.1).
 *
 * The index records the `.beads/` directory each bead was filed in, and is
 * never rewritten: old entries are resolved here, at read time. Under br
 * 0.1.37 every linked worktree had its own DB, so old entries name worktree
 * directories, and the move to a br that shares the primary's DB moves those
 * DBs aside; a worktree may also be deleted outright. So:
 *   1. The recorded directory's own DB, when it has one (`via: 'recorded'`).
 *   2. Otherwise, when the recorded directory is a linked worktree's `.beads/`
 *      and the repo's br shares DBs, the primary checkout's (`via: 'primary'`).
 *      How the primary is found:
 *      - The worktree is still a checkout: git says (its common dir), and the
 *        br that runs in the worktree decides, as in `findBeadsWorkspace`.
 *      - The worktree is gone, or its directory lingers but is no longer a
 *        checkout root: there is nothing left for git to ask, so the PATH is
 *        the only evidence. Claude Code puts worktrees at
 *        `<primary>/.claude/worktrees/<name>`, so the prefix before that
 *        segment is taken as the primary (`primaryOfClaudeWorktreePath`), and
 *        only while it is still a primary checkout (its `.git` is a
 *        directory). The PRIMARY's br decides, since the worktree's pin went
 *        with it. A gone worktree anywhere else cannot be traced to its
 *        primary, and is `none`.
 *   3. Otherwise `none`, with the recorded directory's own reason, or `failed`
 *      when it could not be told (an unreadable br version, a git failure).
 */
export type RecordedBeadsDb =
  | {beadsDir: string; db: string; kind: 'found'; via: 'recorded'}
  | {
      /** The primary checkout's `.beads/`, which holds `db`. */
      beadsDir: string;
      brVersion: string;
      db: string;
      kind: 'found';
      primaryRoot: string;
      /** The directory the index recorded, which holds no DB now. */
      recordedBeadsDir: string;
      via: 'primary';
    }
  | {kind: 'failed'; reason: string}
  | {kind: 'none'; reason: string};

/**
 * Is `dir` a primary checkout (its `.git` is a directory)? `failed` when that
 * could not be read: a missing `.git` is a measured "no", an unreadable one is
 * not.
 */
function isPrimaryCheckout(
  dir: string,
): boolean | {kind: 'failed'; reason: string} {
  try {
    return statSync(join(dir, '.git')).isDirectory();
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') {
      return false;
    }
    return {
      kind: 'failed',
      reason: `could not read ${join(dir, '.git')}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * The live layout of a recorded checkout, or `gone` when it is no longer a
 * checkout root: missing, not in a git repo, or inside some other checkout
 * (a worktree's leftover directory under the primary's tree).
 */
function recordedCheckoutLayout(
  checkout: string,
):
  | {kind: 'failed'; reason: string}
  | {kind: 'gone'}
  | {kind: 'linked'; layout: Extract<CheckoutLayout, {kind: 'linked'}>}
  | {kind: 'primary'} {
  if (!existsSync(checkout)) return {kind: 'gone'};
  const layout = readCheckoutLayout(checkout);
  if (layout.kind === 'failed') return layout;
  if (layout.kind === 'notGit') return {kind: 'gone'};
  let real: string;
  try {
    real = realpathSync(checkout);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return {kind: 'gone'};
    return {
      kind: 'failed',
      reason: `could not resolve ${checkout}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (layout.root !== real) return {kind: 'gone'};
  return layout.kind === 'primary'
    ? {kind: 'primary'}
    : {kind: 'linked', layout};
}

/**
 * The DB a sessions-index `beadsDir` names, resolved at read time. The rules,
 * and why they exist, are on `RecordedBeadsDb`.
 */
export function resolveRecordedBeadsDb(
  recordedBeadsDir: string,
): RecordedBeadsDb {
  const own = findBeadsDb(recordedBeadsDir);
  if (own.kind === 'found') {
    return {
      beadsDir: recordedBeadsDir,
      db: own.db,
      kind: 'found',
      via: 'recorded',
    };
  }
  if (own.kind === 'failed' || basename(recordedBeadsDir) !== '.beads') {
    return own;
  }
  const checkout = dirname(recordedBeadsDir);
  const live = recordedCheckoutLayout(checkout);
  if (live.kind === 'failed') return live;
  if (live.kind === 'primary') return own;
  let shared: PrimaryDb;
  if (live.kind === 'linked') {
    shared = primaryDbForWorktree({
      ownReason: own.reason,
      primaryRoot: live.layout.primaryRoot,
      primaryUnknown: `git's common directory ${live.layout.commonDir} is not a checkout's .git`,
      versionFrom: checkout,
      worktree: checkout,
    });
  } else {
    const primary = primaryOfClaudeWorktreePath(checkout);
    if (primary == null) {
      return {
        kind: 'none',
        reason: `${own.reason}; ${checkout} is no longer a checkout, and its primary checkout cannot be traced from a path outside .claude/worktrees/`,
      };
    }
    const isPrimary = isPrimaryCheckout(primary);
    if (isPrimary !== true) {
      return isPrimary === false
        ? {
            kind: 'none',
            reason: `${own.reason}; ${checkout} is no longer a checkout, and ${primary} (its primary by path) is not a primary checkout`,
          }
        : isPrimary;
    }
    shared = primaryDbForWorktree({
      ownReason: own.reason,
      primaryRoot: primary,
      primaryUnknown: 'the primary was found by path, so this cannot happen',
      versionFrom: primary,
      worktree: checkout,
    });
  }
  if (shared.kind !== 'found') return shared;
  return {...shared, recordedBeadsDir, via: 'primary'};
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
   * `[]`, measured 2026-10-11 on br 0.1.37 and 2026-10-26 on 0.7.6), so an
   * absent key is a measured "no labels" and becomes `[]` here — that is br's
   * own encoding of none, not a failure being papered over.
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
 * "message", …}}`, on stdout under br 0.7.6 and on stderr under 0.1.37 when
 * piped (measured 2026-10-26; see `spawnBr`), so callers try both. A text-mode
 * call's error is a plain `Error: …` line on stderr under both. null when the
 * text is not that shape.
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

// ---------------------------------------------------------------------------
// An old br on a new database (home-base-dj5m9.1.6 F9, layer 2 of the
// decision in home-base-dj5m9.1.7)
// ---------------------------------------------------------------------------

/**
 * The database schema each br version writes: SQLite's `PRAGMA user_version`
 * in `.beads/beads.db`. br keeps no other schema number (its `metadata` and
 * `config` tables hold none; 0.7.6 adds a `runtime_schema_witness_v1` row that
 * names the same 19). MEASURED 2026-10-29, `br init` + `create` in scratch
 * repos: 0.1.34 and 0.1.37 write 4; 0.2.19 writes 16; 0.2.22, 0.3.0, 0.3.2,
 * 0.4.0, 0.4.1 and 0.5.10 write 17; 0.7.6 writes 19. An unmeasured version
 * counts as the newest measured version at or below it, a lower bound; a br
 * older than every measured one has no known schema.
 */
export const BR_SCHEMA_WRITTEN: readonly {schema: number; since: BrSemver}[] = [
  {schema: 4, since: {major: 0, minor: 1, patch: 34}},
  {schema: 16, since: {major: 0, minor: 2, patch: 19}},
  {schema: 17, since: {major: 0, minor: 2, patch: 22}},
  {schema: 19, since: {major: 0, minor: 7, patch: 6}},
];

/** Order two br versions: negative, zero or positive. */
export function compareSemver(a: BrSemver, b: BrSemver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/** The newest schema `version` is known to write, or null when unknown. */
export function brSchemaWritten(version: BrSemver): number | null {
  let schema: number | null = null;
  for (const entry of BR_SCHEMA_WRITTEN) {
    if (compareSemver(version, entry.since) >= 0) schema = entry.schema;
  }
  return schema;
}

/**
 * A database's schema (`PRAGMA user_version`), read by `sqlite3 -readonly`
 * with a bounded wait, so no br opens the file to answer it. Measured
 * 2026-10-29 on 0.1.37 and 0.7.6 DBs with WAL frames: the read leaves the DB
 * and WAL bytes unchanged and both brs work on afterwards; when the `-shm` is
 * missing, SQLite creates it, as any br open does. A failed read is `failed`,
 * never a schema.
 */
export function readDbSchema(
  db: string,
): {kind: 'failed'; reason: string} | {kind: 'read'; schema: number} {
  const proc = spawnSync(
    'sqlite3',
    ['-readonly', '-cmd', '.timeout 2000', db, 'PRAGMA user_version'],
    {encoding: 'utf-8', env: brSpawnEnv(undefined), timeout: 10_000},
  );
  if (proc.error != null) {
    return {
      kind: 'failed',
      reason: `sqlite3 could not run to read the schema of ${db}: ${proc.error.message}`,
    };
  }
  const out = (proc.stdout ?? '').trim();
  if (proc.status !== 0 || !/^\d+$/.test(out)) {
    const said = capturedStderr(proc.stderr)?.split('\n')[0] ?? out;
    return {
      kind: 'failed',
      reason: `sqlite3 could not read the schema of ${db} (${proc.status != null ? `exit ${proc.status}` : `killed: ${proc.signal ?? 'unknown signal'}`}): ${said === '' ? 'it printed nothing' : said}`,
    };
  }
  return {kind: 'read', schema: Number(out)};
}

/**
 * Why br must not run on `db`, or null when it may: the database is on a
 * schema newer than the br that would run (the one `cwdForDb` picks) writes.
 * br 0.1.37 does NOT refuse a schema-19 DB: it reads and writes it, and its
 * export drops the fields only 0.7.6 has (measured 2026-10-29, `bun run
 * measure:br-downgrade`; see this file's header). Either unreadable is a
 * refusal too. Nothing is cached here but the br version, whose cache follows
 * the pin files (`brVersionIn`).
 */
function oldBrOnNewDbRefusal(db: string): string | null {
  const schema = readDbSchema(db);
  if (schema.kind === 'failed') {
    return `refused: the schema of the beads database could not be read, so whether this br is too old for it is unknown: ${schema.reason}`;
  }
  const checkout = cwdForDb(db);
  const version = brVersionIn(checkout);
  if (version.kind === 'failed') {
    return `refused: the br that would run on ${db} (the one ${checkout} pins) could not be read, so whether it is too old for the database's schema ${schema.schema} is unknown: ${version.reason}`;
  }
  const written = brSchemaWritten(version);
  if (written == null) {
    return `refused: br ${version.text} (pinned in ${checkout}) is older than every br whose schema was measured, so whether it can use ${db} (schema ${schema.schema}) is unknown`;
  }
  if (schema.schema <= written) return null;
  return `refused: ${db} is on schema ${schema.schema}, newer than the schema ${written} that br ${version.text} (pinned in ${checkout}, which runs every call on this database) writes. An older br reads and writes a newer database without refusing and drops the fields it does not know. Pin the br that wrote this database in ${checkout} (merge main there, then \`mise install\`).`;
}

/**
 * Run br against a target. A `{db}` whose file does not exist is refused here,
 * by name: spawning with a vanished checkout as cwd would fail as `spawnSync br
 * ENOENT`, which reads as "br is not installed" — the wrong diagnosis. And
 * where the cwd does exist, br itself, given `--db` naming a missing file
 * inside an existing `.beads/`, CREATES that database and fills it from the
 * export (exit 0, on br 0.1.37 and 0.7.6 alike; outside a `.beads/` both exit
 * 2, NOT_INITIALIZED; measured 2026-10-26), so a stale recorded path would
 * quietly mint a second database. The refusal prevents both.
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
    const refusal = oldBrOnNewDbRefusal(target.db);
    if (refusal != null) {
      return {
        failed: {
          command: `br --db ${target.db} ${args.join(' ')}`,
          detail: [],
          kind: 'failed',
          reason: refusal,
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
 * The shape, `{issues, total, limit, offset, has_more}`, is the same on br
 * 0.1.37 and 0.7.6 (measured 2026-10-26; 0.7.6 prints it on one line and adds
 * `source_repo_path` to each issue, which this does not read).
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
 * `Issue not found: <id>` (text mode) — measured 2026-10-11 on br 0.1.37 and
 * 2026-10-26 on 0.7.6 (the JSON body on stdout there, on stderr under 0.1.37;
 * `failedFrom` folds either into the reason). Matched on the text, not the
 * exit code alone, so some other exit-3 failure is never mistaken for an
 * absence.
 *
 * br 0.7.6 also refuses to say "not found" for an id the export holds but the
 * DB does not (a pulled bead before the import): exit 6, SYNC_CONFLICT,
 * "refusing a false missing-issue result". That is a FAILURE here, never
 * `notFound`, which is right (rule 7). 0.1.37 answered ISSUE_NOT_FOUND there
 * (measured 2026-10-26).
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
  // br prints an array of one for `show <id>` (0.1.37 and 0.7.6, measured
  // 2026-10-26); accept a bare object too.
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
 * parent field, measured 2026-10-11; both unchanged on 0.7.6, measured
 * 2026-10-26: each dependent is `{dependency_type, id, priority, status,
 * title}`). Added by home-base-vzwbj.4.2 so `thread done` can name what it
 * leaves open.
 *
 * NOT what `br close` counts: from br 0.2.22 on (0.7.6 included) a bead's
 * open DOT-NOTATION children (`<id>.N`) block a plain close even after they
 * were moved to another parent, and those are not dependents here (measured
 * 2026-10-26; see scripts/migrate-ask-parents.ts).
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
 * default `issues.jsonl`. A fresh `br init` leaves a 0-byte export on br
 * 0.1.37 and 0.7.6 alike (measured 2026-10-26).
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
 * export (the pulled title was lost). Re-measured 2026-10-26: 0.1.37 the same;
 * br 0.7.6 clobbers nothing, but does not write cleanly either. `br create`
 * appends and leaves `jsonl_newer` set (the DB still lacks the pulled edit),
 * and `br update` of the pulled issue exits 0 while REFUSING its own export
 * (stderr: "automatic JSONL export failed … Sync conflict: JSONL changed for
 * issue …; refusing automatic export. Run `br sync --merge`"), leaving the
 * edit unexported: the both-ahead state below. So the import first is still
 * what keeps a write exported, under both.
 *
 * WHY IMPORT RATHER THAN REFUSE, measured 2026-10-15 on br 0.1.37 (`bun run
 * measure:br-import-only`): `br sync --import-only --no-auto-import` ran NO git
 * command (a PATH shim that does log br's `git rev-parse` under `br stats` saw
 * none), left HEAD where it was with `origin/main` one commit ahead, left `git
 * status` clean and issues.jsonl byte-identical, imported the pulled title and
 * the pulled bead, and kept a bead only the DB held. br 0.7.6 does all of the
 * same (re-measured 2026-10-26; its shim saw `git log` under `br stats`, so
 * the shim was not blind). The refusal it replaces stopped every v4 write
 * after every merge into main (the conductor ran the import by hand four times
 * on 2026-10-15), and would have done so in every repo the rollout reaches.
 *
 * WHY BOTH-AHEAD STILL REFUSES, measured the same day and again 2026-10-26 on
 * 0.1.37 and 0.7.6 alike (`measure:br-contract`): with an unexported DB edit
 * (`db_newer: true`) and a pulled edit to the same issue, the import exits 0
 * either way, and one edit is lost. When the DB edit is the newer, "Skipped: 1
 * issues (up-to-date)": the DB keeps its copy, and the next write's flush
 * would put it over the pulled one. When the pulled edit is the newer, the
 * import takes it and the DB edit is gone. `db_newer` stays set after both.
 *
 * WHEN br REFUSES THE IMPORT ITSELF (new in br 0.7.x, measured 2026-10-26):
 * an export that holds a DIFFERENT issue (another `created_at`) under an id the
 * DB already has, which two checkouts with their own DBs make when both mint
 * the same next id, exits 6: "Sync conflict: ID collision: … Importing would
 * discard one of them; run `br sync --merge` to keep both" (stderr). 0.1.37
 * imported it over the local issue and exited 0 (the local copy was lost). The
 * import-failed refusal below carries br's words, so the reader sees the
 * `--merge` remedy. A br 0.1.37 DB that still holds WAL frames makes EVERY
 * 0.7.6 command exit 6 (SYNC_CONFLICT, "engine recovery refused before
 * opening"), `br sync --status` first, so that case refuses before any import.
 *
 * br's own read-only `br sync --status --json` is the signal: `jsonl_newer` is
 * true in exactly the pulled state, false in every normal state, and false
 * after a bare `touch` of the export (it follows content). File mtimes are NOT
 * usable (measured 2026-10-11): right after a normal write the export is the
 * OLDEST of beads.db / beads.db-wal / issues.jsonl. All three re-measured
 * 2026-10-26 on 0.1.37 and 0.7.6: unchanged.
 *
 * The status is read again after the import: an import that exits 0 but
 * leaves `jsonl_newer` set is still a refusal.
 */
function exportAheadOfDb(target: BrTarget): BrFailed | null {
  const status = readSyncFreshness(target);
  if (!status.ok) return status.failed;
  if (!status.freshness.jsonlNewer) return null;
  // A freshly `br init`-ed workspace reports jsonl_newer: true with an EMPTY
  // export (nothing exported yet; measured 2026-10-11, br 0.1.37, and
  // 2026-10-26 on 0.7.6 alike). An export
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
 * `br create … --silent`, which prints only the new id (verified 2026-10-11;
 * the same on 0.7.6, 2026-10-26). br create has NO notes or
 * acceptance-criteria flag; set those with `brUpdate` afterwards.
 *
 * EVERY free-text value goes as `--flag=value`, never as a separate argument
 * or the positional title: br (clap) reads a value that starts with `-` as a
 * flag — `br create '-x fix'` exits 2 with `unexpected argument '-x'`, while
 * `--title=-x fix` works (measured 2026-10-11, br 0.1.37; the same on 0.7.6,
 * 2026-10-26). A request title is Claude's free text, so this is reachable.
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
   * — remove first, then set. The id and status do not change. Re-measured
   * 2026-10-26: 0.1.37 the same; br 0.7.6 accepts the direct move (exit 0),
   * and remove-then-set works on both.
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
 * 2026-10-11, br 0.1.37; exit 3 on 0.7.6 too, 2026-10-26, whose message also
 * names the skipped id and why), so its outcome is exactly this bead's. From
 * br 0.2.22 on, an open DOT-NOTATION child (`<id>.N`) blocks the close even
 * after it was moved to another parent (see `brChildren`).
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

/**
 * `br reopen <id>`, ONE id per call: the bead goes back to `open` (br has no
 * way to reopen straight into another status; `thread unmark` follows it with
 * `brUpdate({status})` when the bead was in_progress before, home-base-yukaf.9
 * D-GMAIL-KEYS).
 */
export function brReopen(target: BrTarget, id: string): BrWriteOutcome {
  if (id.trim() === '') {
    return {
      command: 'br reopen',
      detail: [],
      kind: 'failed',
      reason: 'brReopen was called with no id',
    };
  }
  const ahead = exportAheadOfDb(target);
  if (ahead != null) return ahead;
  const call = callBr(target, ['reopen', id]);
  return call.ok ? {kind: 'ok'} : call.failed;
}

// Labels are added and removed through `brUpdate({addLabels, removeLabels})`
// (`--add-label=` / `--remove-label=`). There is deliberately no `br label`
// helper: `br label add [ISSUES]... -l <label>` takes ISSUE ids as its
// positionals, so the obvious `br label add <id> <labels…>` reads each label
// as an issue id ("Issue not found: request", measured 2026-10-11) — the two
// helpers that did that were never called and were deleted
// (home-base-vzwbj.4.9 F3). Re-measured 2026-10-26: br 0.1.37 reads every
// word but the LAST as an issue id (one label works; `<id> session request`
// fails on "session"), while 0.7.6 adds them all as labels. `--add-label=`
// means the same on both.

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
