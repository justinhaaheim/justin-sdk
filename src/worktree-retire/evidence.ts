/**
 * The evidence `worktree-retire` records for one worktree, and its verdict
 * (home-base-rub4v.1.1, design "EVIDENCE PER WORKTREE", items 1-10).
 *
 * `plan` records this; `run` reads it again just before removing and compares
 * the two through `recheckKey` (items 1-8). Every read is a READ: git goes
 * through worktree-salvage's read-only runner (--no-optional-locks, no
 * fsmonitor), files are only opened for reading, and processes come from one
 * injected reader.
 *
 * FAILURE IS NEVER A CLEAN VALUE (critical rules §7). Each reading is a
 * `Measured`; a failed one is a reason the worktree is NOT eligible, and it
 * shows in the re-check key as `unknown (…)`, so it can never compare equal to
 * a clean reading.
 *
 * IGNORED FILES (item 4). Eligible only when every ignored path is
 *   - a known regenerable cache, by name, not walked (CACHE_NAMES below: the
 *     design's node_modules, .turbo, dist, build, plus what the 2026-10-29
 *     inventory treated as routine in home-base: .eslintcache, version-manager's
 *     dynamic-version.local.*, husky's .husky/_/);
 *   - under `.beads/`: KEPT, every file copied by `run` before removal (see
 *     beads below);
 *   - or a path holding no files at all (an empty directory loses nothing).
 * Everything else is "notable" and makes the worktree ineligible: tmp/
 * contents, .env, a nested repository, a path whose size cannot be measured.
 *
 * BEADS (item 9). Every ignored file under `.beads/`, not only the DB trio:
 * br's `.br_history/` snapshots are neither a cache nor a DB, and are 4.7 GB
 * across the 28 finished home-base candidates (measured 2026-10-29). Copying
 * them keeps the rule "nothing is deleted without a verified copy"; DEVIATION
 * from the design's "the DB trio", recorded on the bead.
 */

import type {Measured} from '../worktree-salvage/status';
import type {ProcessHandle} from './processes';

import {existsSync, lstatSync, readdirSync, realpathSync} from 'fs';
import {basename, dirname, join, resolve} from 'path';
import {z} from 'zod';

import {parseWorktreePorcelain} from '../repo-status/checkouts';
import {detectDefaultBranch} from '../repo-status/core';
import {
  formatBytes,
  formatCount,
  sha256OfFile,
  walkIgnored,
} from '../worktree-salvage/save';
import {readIgnoredStatus, runGit} from '../worktree-salvage/status';
import {processesInside} from './processes';

function measured<T extends z.ZodTypeAny>(value: T) {
  return z.discriminatedUnion('ok', [
    z.object({error: z.string(), ok: z.literal(false)}),
    z.object({ok: z.literal(true), value}),
  ]);
}

export const IgnoredSchema = z.object({
  /** Ignored git paths under `.beads/`: kept by copying. */
  beads: z.array(z.string()),
  /** Ignored git paths that are known caches, by name; not walked. */
  cache: z.array(z.string()),
  /** Ignored git paths that hold no files. */
  empty: z.array(z.string()),
  /** Anything else: each makes the worktree ineligible. */
  notable: z.array(z.object({detail: z.string(), path: z.string()})),
});
export type IgnoredClasses = z.infer<typeof IgnoredSchema>;

export const BeadsFileSchema = z.object({
  bytes: z.number(),
  /** Relative to the worktree root, e.g. `.beads/beads.db`. */
  path: z.string(),
  /** Recorded for the DB files (`*.db`, `-wal`, `-shm`); null for the rest. */
  sha256: z.string().nullable(),
});
export type BeadsFile = z.infer<typeof BeadsFileSchema>;

export const SubmoduleSchema = z.object({
  detail: z.string(),
  head: z.string().nullable(),
  initialized: z.boolean(),
  path: z.string(),
  /** Initialized, clean, HEAD on a remote branch, no local-only commits, no stash. */
  verified: z.boolean(),
});
export type SubmoduleState = z.infer<typeof SubmoduleSchema>;

export const IDENTITIES = [
  'linked worktree',
  'main checkout',
  'not a worktree of this repo',
  'directory is gone',
] as const;

export const EvidenceSchema = z.object({
  beads: measured(z.array(BeadsFileSchema)).nullable(),
  branch: z.string().nullable(),
  commitsOutsideMain: measured(z.number()).nullable(),
  head: z.string().nullable(),
  identity: z.enum(IDENTITIES),
  ignored: measured(IgnoredSchema).nullable(),
  locked: z.boolean(),
  name: z.string(),
  path: z.string(),
  processes: measured(z.array(z.string())).nullable(),
  reasons: z.array(z.string()),
  stash: measured(z.array(z.string())).nullable(),
  submodules: measured(z.array(SubmoduleSchema)).nullable(),
  transcripts: z.object({
    dir: z.string(),
    files: measured(z.number()),
  }),
  uncommitted: measured(z.array(z.string())).nullable(),
  verdict: z.enum(['eligible', 'ineligible']),
});
export type WorktreeEvidence = z.infer<typeof EvidenceSchema>;

/** What every worktree's reading shares: the repo, main, the worktree list, the processes. */
export interface RepoContext {
  defaultBranch: string;
  home: string;
  processes: Measured<ProcessHandle[]>;
  repoName: string;
  /** The main checkout's root, real path. */
  repoRoot: string;
  /** `git worktree list --porcelain`, real paths where the directory exists. */
  worktrees: {
    branch: string | null;
    head: string | null;
    locked: boolean;
    path: string;
    prunable: boolean;
  }[];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function realOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Read what every worktree shares. `defaultBranch` overrides detection (run uses the plan's). */
export function readRepoContext(
  repoPath: string,
  options: {
    defaultBranch?: string;
    home: string;
    processes: Measured<ProcessHandle[]>;
  },
): Measured<RepoContext> {
  const common = runGit(repoPath, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  if (!common.ok) return common;
  const repoRoot = realOrResolved(dirname(common.value.trim()));
  const list = runGit(repoRoot, ['worktree', 'list', '--porcelain']);
  if (!list.ok) return list;
  const defaultBranch =
    options.defaultBranch ?? detectDefaultBranch(repoRoot) ?? null;
  if (defaultBranch == null) {
    return {
      error: `could not tell which branch is main in ${repoRoot} (no origin/HEAD, main or master)`,
      ok: false,
    };
  }
  const worktrees = parseWorktreePorcelain(list.value).map((entry) => ({
    branch: entry.branch,
    head: entry.head,
    locked: entry.locked,
    path: realOrResolved(entry.path),
    prunable: entry.prunable,
  }));
  return {
    ok: true,
    value: {
      defaultBranch,
      home: options.home,
      processes: options.processes,
      repoName: basename(repoRoot),
      repoRoot,
      worktrees,
    },
  };
}

/** Claude Code's project dir for a path: `/` and `.` become `-` (as the inventory used). */
export function transcriptsDirFor(home: string, path: string): string {
  return join(home, '.claude', 'projects', path.replace(/[/.]/gu, '-'));
}

function countTranscripts(dir: string): Measured<number> {
  if (!existsSync(dir)) return {ok: true, value: 0};
  try {
    const entries = readdirSync(dir, {recursive: true, withFileTypes: true});
    return {ok: true, value: entries.filter((entry) => entry.isFile()).length};
  } catch (error) {
    return {error: messageOf(error), ok: false};
  }
}

const CACHE_NAMES = new Set([
  'node_modules',
  '.turbo',
  'dist',
  'build',
  '.eslintcache',
  'dynamic-version.local.json',
  'dynamic-version.local.d.ts',
]);
const CACHE_PREFIXES = ['.husky/_/'];

function withoutSlash(path: string): string {
  return path.endsWith('/') ? path.slice(0, -1) : path;
}

function isBeadsPath(gitPath: string): boolean {
  return gitPath === '.beads/' || gitPath.startsWith('.beads/');
}

export function isCachePath(gitPath: string): boolean {
  const rel = withoutSlash(gitPath);
  const last = rel.split('/').at(-1) ?? rel;
  if (CACHE_NAMES.has(last)) return true;
  return CACHE_PREFIXES.some(
    (prefix) => gitPath.startsWith(prefix) || `${rel}/` === prefix,
  );
}

const DB_FILE = /\.db(-wal|-shm)?$/u;

interface IgnoredReading {
  beadsFiles: Measured<BeadsFile[]>;
  classes: IgnoredClasses;
}

function readIgnored(root: string): Measured<IgnoredReading> {
  const status = readIgnoredStatus(root);
  if (!status.ok) return status;
  const ignored = status.value.parsed.ignored;
  const cache = ignored.filter(isCachePath);
  const walk = walkIgnored(
    root,
    ignored.filter((path) => !isCachePath(path)),
  );
  const beads: string[] = [];
  const empty: string[] = [];
  const notable: IgnoredClasses['notable'] = [];
  let beadsError: string | null = null;
  for (const entry of walk.survey.paths) {
    if (isBeadsPath(entry.path)) {
      beads.push(entry.path);
      if (!entry.size.ok) beadsError = `${entry.path}: ${entry.size.error}`;
      continue;
    }
    if (!entry.size.ok) {
      notable.push({
        detail: `size unknown: ${entry.size.error}`,
        path: entry.path,
      });
    } else if (entry.size.value.files === 0) {
      empty.push(entry.path);
    } else {
      notable.push({
        detail: `${formatCount(entry.size.value.files, 'file')}, ${formatBytes(entry.size.value.bytes)}`,
        path: entry.path,
      });
    }
  }
  for (const skipped of walk.survey.skipped) {
    if (skipped.reason === 'node_modules') cache.push(skipped.path);
    else notable.push({detail: 'a .git directory', path: skipped.path});
  }
  for (const nested of walk.nested) {
    notable.push({detail: 'a nested repository', path: nested.path});
  }
  const classes = {beads, cache, empty, notable};
  if (beadsError != null) {
    return {
      ok: true,
      value: {beadsFiles: {error: beadsError, ok: false}, classes},
    };
  }
  const files: BeadsFile[] = [];
  for (const rel of walk.files.filter(isBeadsPath).sort()) {
    const abs = join(root, rel);
    try {
      const stat = lstatSync(abs);
      if (!stat.isFile()) {
        return {
          ok: true,
          value: {
            beadsFiles: {
              error: `${rel} is not a regular file, so it cannot be copied`,
              ok: false,
            },
            classes,
          },
        };
      }
      files.push({
        bytes: stat.size,
        path: rel,
        sha256: DB_FILE.test(rel) ? sha256OfFile(abs) : null,
      });
    } catch (error) {
      return {
        ok: true,
        value: {
          beadsFiles: {error: `${rel}: ${messageOf(error)}`, ok: false},
          classes,
        },
      };
    }
  }
  return {ok: true, value: {beadsFiles: {ok: true, value: files}, classes}};
}

function lines(text: string): string[] {
  return text.split('\n').filter((line) => line.trim() !== '');
}

function readSubmodule(
  root: string,
  prefix: string,
  sha: string,
  path: string,
): SubmoduleState {
  if (prefix === '-') {
    return {
      detail: 'not initialized',
      head: sha,
      initialized: false,
      path,
      verified: false,
    };
  }
  const sub = join(root, path);
  const problems: string[] = [];
  if (prefix !== ' ') {
    problems.push(
      prefix === '+'
        ? 'its checked-out commit differs from the one recorded'
        : 'it has merge conflicts',
    );
  }
  const head = runGit(sub, ['rev-parse', 'HEAD']);
  const status = runGit(sub, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ]);
  const remotes = runGit(sub, ['branch', '-r', '--contains', 'HEAD']);
  const localOnly = runGit(sub, [
    'log',
    '--branches',
    '--not',
    '--remotes',
    '--format=%H',
  ]);
  const stash = runGit(sub, ['stash', 'list']);
  for (const read of [head, status, remotes, localOnly, stash]) {
    if (!read.ok) problems.push(`unknown: ${read.error}`);
  }
  if (status.ok && lines(status.value).length > 0) {
    problems.push(`${lines(status.value).length} uncommitted paths`);
  }
  const onRemote = remotes.ok
    ? lines(remotes.value)
        .map((line) => line.trim())
        .filter((line) => !line.includes(' -> '))
    : [];
  if (remotes.ok && onRemote.length === 0) {
    problems.push('its HEAD is on no remote branch');
  }
  if (localOnly.ok && lines(localOnly.value).length > 0) {
    problems.push(
      `${formatCount(lines(localOnly.value).length, 'local-only commit')}`,
    );
  }
  if (stash.ok && lines(stash.value).length > 0) {
    problems.push(
      `${formatCount(lines(stash.value).length, 'stash entry', 'stash entries')}`,
    );
  }
  const verified = problems.length === 0;
  return {
    detail: verified
      ? `clean, HEAD on ${onRemote[0] ?? '?'}, no local-only commits, no stash`
      : problems.join('; '),
    head: head.ok ? head.value.trim() : null,
    initialized: true,
    path,
    verified,
  };
}

function readSubmodules(root: string): Measured<SubmoduleState[]> {
  const out = runGit(root, ['submodule', 'status']);
  if (!out.ok) return out;
  const states: SubmoduleState[] = [];
  for (const line of lines(out.value)) {
    const match = /^([ +\-U])([0-9a-f]+) (\S+)/u.exec(line);
    if (match?.[1] == null || match[2] == null || match[3] == null) {
      return {
        error: `unrecognised \`git submodule status\` line: ${line}`,
        ok: false,
      };
    }
    states.push(readSubmodule(root, match[1], match[2], match[3]));
  }
  return {ok: true, value: states};
}

function show<T>(reading: Measured<T> | null, describe: (value: T) => string) {
  if (reading == null) return 'not read';
  return reading.ok ? describe(reading.value) : `unknown (${reading.error})`;
}

function listOrNone(items: readonly string[]): string {
  return items.length === 0 ? 'none' : items.join('\n');
}

/**
 * Items 1-8 as one flat record of strings. `run` reads the worktree again and
 * skips it when any field differs from the plan's. Caches growing, the beads
 * files and transcripts are deliberately absent: they are not evidence that
 * work would be lost.
 */
export function recheckKey(evidence: WorktreeEvidence): Record<string, string> {
  return {
    branch: evidence.branch ?? '(detached)',
    'commits not in main': show(evidence.commitsOutsideMain, String),
    head: evidence.head ?? '(none)',
    identity: evidence.identity,
    'ignored, not a cache': show(evidence.ignored, (classes) =>
      listOrNone(
        classes.notable.map((entry) => `${entry.path} (${entry.detail})`),
      ),
    ),
    locked: evidence.locked ? 'locked' : 'not locked',
    path: evidence.path,
    processes: show(evidence.processes, listOrNone),
    stash: show(evidence.stash, listOrNone),
    submodules: show(evidence.submodules, (states) =>
      listOrNone(
        states.map(
          (state) => `${state.path} at ${state.head ?? '?'}: ${state.detail}`,
        ),
      ),
    ),
    uncommitted: show(evidence.uncommitted, listOrNone),
  };
}

/** Each field that differs, as `field: was …, now …`. Empty when nothing changed. */
export function recheckDifferences(
  planned: WorktreeEvidence,
  now: WorktreeEvidence,
): string[] {
  const before = recheckKey(planned);
  const after = recheckKey(now);
  return Object.keys(before)
    .filter((field) => before[field] !== after[field])
    .map(
      (field) =>
        `${field}: was ${JSON.stringify(before[field])}, now ${JSON.stringify(after[field])}`,
    );
}

const SHOWN_PATHS = 5;

function firstFew(items: readonly string[]): string {
  const shown = items.slice(0, SHOWN_PATHS).join(', ');
  return items.length > SHOWN_PATHS
    ? `${shown}, and ${items.length - SHOWN_PATHS} more`
    : shown;
}

function reasonsFor(evidence: Omit<WorktreeEvidence, 'reasons' | 'verdict'>) {
  const reasons: string[] = [];
  if (evidence.identity !== 'linked worktree') return [evidence.identity];
  if (evidence.branch == null) {
    reasons.push('HEAD is detached: only a worktree on a branch is retired');
  }
  if (evidence.locked) reasons.push('git has it locked');
  const failed = (what: string, reading: Measured<unknown> | null) => {
    if (reading == null) reasons.push(`${what}: not read`);
    else if (!reading.ok) reasons.push(`${what} failed: ${reading.error}`);
  };
  failed('comparing with main', evidence.commitsOutsideMain);
  if (
    evidence.commitsOutsideMain?.ok === true &&
    evidence.commitsOutsideMain.value > 0
  ) {
    reasons.push(
      `${formatCount(evidence.commitsOutsideMain.value, 'commit')} not in main (git cherry)`,
    );
  }
  failed('reading git status', evidence.uncommitted);
  if (
    evidence.uncommitted?.ok === true &&
    evidence.uncommitted.value.length > 0
  ) {
    reasons.push(
      `${formatCount(evidence.uncommitted.value.length, 'uncommitted or untracked path')}: ${firstFew(evidence.uncommitted.value.map((line) => line.slice(3)))}`,
    );
  }
  failed('reading ignored files', evidence.ignored);
  if (
    evidence.ignored?.ok === true &&
    evidence.ignored.value.notable.length > 0
  ) {
    reasons.push(
      `ignored files that are not caches: ${firstFew(evidence.ignored.value.notable.map((entry) => `${entry.path} (${entry.detail})`))}`,
    );
  }
  failed('checking for live processes', evidence.processes);
  if (evidence.processes?.ok === true && evidence.processes.value.length > 0) {
    reasons.push(`in use: ${evidence.processes.value.join('; ')}`);
  }
  failed('reading the stash', evidence.stash);
  if (evidence.stash?.ok === true && evidence.stash.value.length > 0) {
    reasons.push(
      `stash entries name its branch: ${firstFew(evidence.stash.value)}`,
    );
  }
  failed('reading submodules', evidence.submodules);
  if (evidence.submodules?.ok === true) {
    for (const state of evidence.submodules.value) {
      if (state.initialized && !state.verified) {
        reasons.push(`submodule ${state.path}: ${state.detail}`);
      }
    }
  }
  failed('listing the beads files', evidence.beads);
  return reasons;
}

function withVerdict(
  evidence: Omit<WorktreeEvidence, 'reasons' | 'verdict'>,
): WorktreeEvidence {
  const reasons = reasonsFor(evidence);
  return {
    ...evidence,
    reasons,
    verdict: reasons.length === 0 ? 'eligible' : 'ineligible',
  };
}

/** Read every item for the worktree at `path` (any spelling of its root). */
export function gatherEvidence(
  context: RepoContext,
  path: string,
): WorktreeEvidence {
  const real = realOrResolved(path);
  const transcriptsDir = transcriptsDirFor(context.home, real);
  const base = {
    beads: null,
    branch: null,
    commitsOutsideMain: null,
    head: null,
    ignored: null,
    locked: false,
    name: basename(real),
    path: real,
    processes: null,
    stash: null,
    submodules: null,
    transcripts: {dir: transcriptsDir, files: countTranscripts(transcriptsDir)},
    uncommitted: null,
  };
  const index = context.worktrees.findIndex((entry) => entry.path === real);
  const entry = context.worktrees[index];
  if (entry == null) {
    return withVerdict({...base, identity: 'not a worktree of this repo'});
  }
  const identityFields = {
    ...base,
    branch: entry.branch,
    head: entry.head,
    locked: entry.locked,
  };
  if (index === 0 || real === context.repoRoot) {
    return withVerdict({...identityFields, identity: 'main checkout'});
  }
  if (entry.prunable || !existsSync(real)) {
    return withVerdict({...identityFields, identity: 'directory is gone'});
  }
  const cherry: Measured<number> =
    entry.head == null
      ? {error: 'git lists no HEAD for it', ok: false}
      : (() => {
          const out = runGit(context.repoRoot, [
            'cherry',
            context.defaultBranch,
            entry.head,
          ]);
          return out.ok
            ? {
                ok: true,
                value: lines(out.value).filter((line) => line.startsWith('+'))
                  .length,
              }
            : out;
        })();
  const status = runGit(real, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ]);
  const ignored = readIgnored(real);
  const stash: Measured<string[]> = (() => {
    const out = runGit(context.repoRoot, ['stash', 'list', '--format=%gd %gs']);
    if (!out.ok) return out;
    const branch = entry.branch;
    return {
      ok: true,
      value:
        branch == null
          ? []
          : lines(out.value).filter((line) => line.includes(branch)),
    };
  })();
  return withVerdict({
    ...identityFields,
    beads: ignored.ok ? ignored.value.beadsFiles : ignored,
    commitsOutsideMain: cherry,
    identity: 'linked worktree',
    ignored: ignored.ok ? {ok: true, value: ignored.value.classes} : ignored,
    processes: context.processes.ok
      ? {ok: true, value: processesInside(context.processes.value, real)}
      : context.processes,
    stash,
    submodules: readSubmodules(real),
    uncommitted: status.ok ? {ok: true, value: lines(status.value)} : status,
  });
}
