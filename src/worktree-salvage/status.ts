/**
 * Reading a checkout for worktree-salvage (epic home-base-us739, D2 and D6).
 *
 * EVERY GIT CALL HERE IS A READ, AND IS MADE NOT TO WRITE (D6). `git status`
 * normally refreshes the index's stat cache and rewrites `.git/index` as a side
 * effect; `--no-optional-locks` turns that off, so a save leaves the source
 * byte-identical, the index included. `core.fsmonitor=false` stops git from
 * starting an fsmonitor daemon (which writes a socket under `.git`) in a repo
 * that has one configured. Nothing here stashes, adds or checks out.
 *
 * A FAILED READ IS A TYPED FAILURE (critical rule 7). A git call that fails
 * returns `{ok: false, error}`, never an empty listing: an empty status means
 * "checked, and the checkout is clean", and saying that of a checkout that
 * could not be read is exactly how a worktree full of work gets removed.
 */

import {execFileSync} from 'child_process';
import {basename, dirname, isAbsolute, join, resolve} from 'path';

import {detectDefaultBranch} from '../repo-status/core';

/** A measurement that either worked or names why it did not. */
export type Measured<T> = {error: string; ok: false} | {ok: true; value: T};

/** The git arguments every read carries, so no read can write (D6). */
export const READ_ONLY_GIT_PREFIX: readonly string[] = [
  '--no-optional-locks',
  '-c',
  'core.fsmonitor=false',
];

/** The exact status read D2 names, minus the read-only prefix. */
export const STATUS_ARGS: readonly string[] = [
  'status',
  '--porcelain=v2',
  '-z',
  '--untracked-files=all',
];

/** The separate read of ignored entries (D2). */
export const IGNORED_STATUS_ARGS: readonly string[] = [
  ...STATUS_ARGS,
  '--ignored=matching',
];

/** git's all-zeros object id: "no object on this side". */
const ZERO_OID = /^0+$/u;

/** A big repo's status or patch is far over execFileSync's 1 MB default. */
const MAX_BUFFER = 512 * 1024 * 1024;

function describeGitError(args: readonly string[], error: unknown): string {
  const command = `git ${args.join(' ')}`;
  if (error != null && typeof error === 'object' && 'stderr' in error) {
    const stderr = (error as {stderr: unknown}).stderr;
    const text =
      typeof stderr === 'string'
        ? stderr
        : Buffer.isBuffer(stderr)
          ? stderr.toString('utf-8')
          : '';
    if (text.trim() !== '') return `\`${command}\` failed: ${text.trim()}`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `\`${command}\` failed: ${message}`;
}

/** Run one read-only git command in `cwd`. Never throws. */
export function runGit(cwd: string, args: readonly string[]): Measured<string> {
  try {
    const stdout = execFileSync('git', [...READ_ONLY_GIT_PREFIX, ...args], {
      cwd,
      encoding: 'utf-8',
      env: {...process.env, GIT_OPTIONAL_LOCKS: '0'},
      maxBuffer: MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {ok: true, value: stdout};
  } catch (error) {
    return {error: describeGitError(args, error), ok: false};
  }
}

/**
 * `runGit` for BYTES: the same read-only prefix and environment, stdout as a
 * Buffer. A blob read through `runGit` would be decoded as UTF-8, which
 * silently replaces every invalid byte of a binary file. Never throws.
 */
export function runGitBuffer(
  cwd: string,
  args: readonly string[],
): Measured<Buffer> {
  try {
    const stdout = execFileSync('git', [...READ_ONLY_GIT_PREFIX, ...args], {
      cwd,
      env: {...process.env, GIT_OPTIONAL_LOCKS: '0'},
      maxBuffer: MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {ok: true, value: stdout};
  } catch (error) {
    return {error: describeGitError(args, error), ok: false};
  }
}

/** One object's content, exactly as git stores it (D2's index-only copies). */
export function readBlob(root: string, oid: string): Measured<Buffer> {
  return runGitBuffer(root, ['cat-file', 'blob', oid]);
}

/** One object's size in bytes, from `git cat-file -s`. */
export function readBlobSize(root: string, oid: string): Measured<number> {
  const out = runGit(root, ['cat-file', '-s', oid]);
  if (!out.ok) return out;
  const text = out.value.trim();
  if (!/^\d+$/u.test(text)) {
    return {error: `git cat-file -s ${oid} printed "${text}"`, ok: false};
  }
  return {ok: true, value: Number(text)};
}

/** One stage of an unmerged path: 1 the common base, 2 ours, 3 theirs. */
export interface UnmergedStage {
  blob: string;
  path: string;
  stage: number;
}

/**
 * Every unmerged index entry, from `git ls-files -u -z`: one record per stage,
 * `<mode> <object> <stage>\t<path>`. A record that does not parse is a
 * failure, never skipped.
 */
export function readUnmergedStages(root: string): Measured<UnmergedStage[]> {
  const out = runGit(root, ['ls-files', '-u', '-z']);
  if (!out.ok) return out;
  const stages: UnmergedStage[] = [];
  for (const record of out.value.split('\0')) {
    if (record === '') continue;
    const match = /^[0-7]{6} ([0-9a-f]{40,64}) ([123])\t(.+)$/su.exec(record);
    if (match == null) {
      return {error: `unparseable ls-files -u record: ${record}`, ok: false};
    }
    stages.push({
      blob: match[1] ?? '',
      path: match[3] ?? '',
      stage: Number(match[2]),
    });
  }
  return {ok: true, value: stages};
}

/**
 * What git says changed about one path. `kind` is git's change; whether there
 * is a file to copy is `inWorktree`, because a renamed or added file can also
 * have been deleted from the worktree since.
 */
export type EntryKind =
  | 'added'
  | 'copied'
  | 'deleted'
  | 'modified'
  | 'renamed'
  | 'type-changed'
  | 'unmerged'
  | 'untracked';

/** One changed path, as `git status --porcelain=v2` reported it. */
export interface StatusEntry {
  /** HEAD's blob for this path; null when HEAD has none (added, untracked). */
  headBlob: string | null;
  /** False when the worktree no longer holds this path: a deletion. */
  inWorktree: boolean;
  /** The index's blob; null when the index has none. */
  indexBlob: string | null;
  kind: EntryKind;
  /** The path it was renamed or copied from; null for every other kind. */
  origPath: string | null;
  /** Relative to the checkout root, exactly as git printed it (no quoting under -z). */
  path: string;
  /** git's two status letters, index then worktree: `.M`, `R.`, `UU`, `??`. */
  status: string;
}

/**
 * A directory git reports but does not enter: a submodule, or an untracked
 * directory holding its own `.git` (git prints that as `? path/`). D2: these are
 * recorded, never entered, so their own changes are NOT in this save.
 */
export interface NestedCheckoutEntry {
  kind: 'nested-repository' | 'submodule';
  path: string;
  /** For a submodule, git's `S<c><m><u>` field; null for a nested repository. */
  submoduleState: string | null;
}

export interface ParsedStatus {
  entries: StatusEntry[];
  /** `!` lines, as git printed them (a directory keeps its trailing `/`). */
  ignored: string[];
  nested: NestedCheckoutEntry[];
}

/** `count` space-separated fields, then everything after them (the path, which may hold spaces). */
function splitFields(
  line: string,
  count: number,
): {fields: string[]; rest: string} | null {
  const fields: string[] = [];
  let cursor = 0;
  for (let index = 0; index < count; index += 1) {
    const space = line.indexOf(' ', cursor);
    if (space === -1) return null;
    fields.push(line.slice(cursor, space));
    cursor = space + 1;
  }
  const rest = line.slice(cursor);
  return rest === '' ? null : {fields, rest};
}

function blobOrNull(oid: string): string | null {
  return ZERO_OID.test(oid) ? null : oid;
}

function ordinaryKind(xy: string): EntryKind {
  const [x, y] = [xy[0] ?? '.', xy[1] ?? '.'];
  if (x === 'D' || y === 'D') return 'deleted';
  if (x === 'A') return 'added';
  if (x === 'T' || y === 'T') return 'type-changed';
  return 'modified';
}

/**
 * Parse `git status --porcelain=v2 -z` output. Pure.
 *
 * Every record type is parsed: `1` ordinary, `2` renamed or copied (its
 * original path is the NEXT NUL-separated token), `u` unmerged, `?` untracked,
 * `!` ignored. A record this parser does not recognise is a FAILURE naming the
 * record, never skipped: a skipped line is a file silently left out of a save.
 */
export function parsePorcelainV2(stdout: string): Measured<ParsedStatus> {
  const tokens = stdout.split('\0');
  const entries: StatusEntry[] = [];
  const ignored: string[] = [];
  const nested: NestedCheckoutEntry[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    if (token === '') {
      if (index === tokens.length - 1) continue;
      return {error: `empty record at position ${index}`, ok: false};
    }
    const type = token[0];
    if (type === '#') continue;
    if (type === '?') {
      const path = token.slice(2);
      if (path === '')
        return {error: `untracked record with no path`, ok: false};
      if (path.endsWith('/')) {
        nested.push({
          kind: 'nested-repository',
          path: path.slice(0, -1),
          submoduleState: null,
        });
        continue;
      }
      entries.push({
        headBlob: null,
        inWorktree: true,
        indexBlob: null,
        kind: 'untracked',
        origPath: null,
        path,
        status: '??',
      });
      continue;
    }
    if (type === '!') {
      const path = token.slice(2);
      if (path === '') return {error: `ignored record with no path`, ok: false};
      ignored.push(path);
      continue;
    }
    if (type === '1' || type === '2' || type === 'u') {
      const fieldCount = type === '1' ? 8 : type === '2' ? 9 : 10;
      const split = splitFields(token, fieldCount);
      if (split == null) {
        return {error: `malformed status record: ${token}`, ok: false};
      }
      const {fields, rest: path} = split;
      const xy = fields[1] ?? '';
      const sub = fields[2] ?? '';
      let origPath: string | null = null;
      if (type === '2') {
        index += 1;
        const next = tokens[index];
        if (next == null || next === '') {
          return {
            error: `renamed record with no original path: ${token}`,
            ok: false,
          };
        }
        origPath = next;
      }
      if (sub.startsWith('S')) {
        nested.push({kind: 'submodule', path, submoduleState: sub});
        continue;
      }
      if (type === 'u') {
        const worktreeMode = fields[6] ?? '';
        entries.push({
          headBlob: null,
          inWorktree: !ZERO_OID.test(worktreeMode),
          indexBlob: null,
          kind: 'unmerged',
          origPath: null,
          path,
          status: xy,
        });
        continue;
      }
      const worktreeMode = fields[5] ?? '';
      const inWorktree = !ZERO_OID.test(worktreeMode);
      const kind: EntryKind =
        type === '2'
          ? xy.startsWith('C')
            ? 'copied'
            : 'renamed'
          : ordinaryKind(xy);
      entries.push({
        headBlob: blobOrNull(fields[6] ?? ''),
        inWorktree,
        indexBlob: blobOrNull(fields[7] ?? ''),
        kind: inWorktree ? kind : 'deleted',
        origPath,
        path,
        status: xy,
      });
      continue;
    }
    return {error: `unrecognised status record: ${token}`, ok: false};
  }
  return {ok: true, value: {entries, ignored, nested}};
}

/** One status read: the raw bytes (compared before and after a save, D5) and the parse. */
export interface StatusRead {
  parsed: ParsedStatus;
  raw: string;
}

function readStatusWith(
  root: string,
  args: readonly string[],
): Measured<StatusRead> {
  const out = runGit(root, args);
  if (!out.ok) return out;
  const parsed = parsePorcelainV2(out.value);
  if (!parsed.ok) {
    return {error: `could not parse git status: ${parsed.error}`, ok: false};
  }
  return {ok: true, value: {parsed: parsed.value, raw: out.value}};
}

/** The checkout's modified, staged and untracked entries (no ignored ones). */
export function readStatus(root: string): Measured<StatusRead> {
  return readStatusWith(root, STATUS_ARGS);
}

/** The same read with `--ignored=matching`: the ignored paths, as git matched them. */
export function readIgnoredStatus(root: string): Measured<StatusRead> {
  return readStatusWith(root, IGNORED_STATUS_ARGS);
}

/** What the manifest records about the checkout itself (D3). */
export interface CheckoutFacts {
  /** The branch checked out; null when HEAD is detached. */
  branch: string | null;
  /**
   * Commits on HEAD that are not on the default branch. INFORMATIONAL only
   * (saving them is repo-status's domain): capped at COMMIT_LIST_CAP, with the
   * true count beside them.
   */
  commitsNotOnDefault: Measured<{
    commits: {sha: string; subject: string}[];
    defaultBranch: string;
    total: number;
  }>;
  /** The commit HEAD names: the base every saved change is relative to. */
  head: string;
  /** Where git keeps this checkout's index (a linked worktree's is under the common dir). */
  indexPath: string;
  /** `repoRoot`'s directory name: the archive's `<repo name>/` folder. */
  repoName: string;
  /** The main checkout's root (the common git dir's parent). */
  repoRoot: string;
  /** The checkout's own root (`--show-toplevel`). */
  root: string;
  /** The branch's upstream, or null when it has none (or HEAD is detached). */
  upstream: Measured<string | null>;
  /** `root`'s directory name: the archive's `<worktree>/` folder. */
  worktreeName: string;
}

/** How many commits-not-on-default the manifest lists by name. */
export const COMMIT_LIST_CAP = 200;

function trimmed(out: Measured<string>): Measured<string> {
  return out.ok ? {ok: true, value: out.value.trim()} : out;
}

function readUpstream(
  root: string,
  branch: string | null,
): Measured<string | null> {
  if (branch == null) return {ok: true, value: null};
  const out = trimmed(
    runGit(root, [
      'for-each-ref',
      '--format=%(upstream:short)',
      `refs/heads/${branch}`,
    ]),
  );
  if (!out.ok) return out;
  return {ok: true, value: out.value === '' ? null : out.value};
}

function readCommitsNotOnDefault(
  root: string,
): CheckoutFacts['commitsNotOnDefault'] {
  // detectDefaultBranch returns null both when no default branch exists and
  // when git failed; either way the list is UNKNOWN here, never empty.
  const defaultBranch = detectDefaultBranch(root);
  if (defaultBranch == null) {
    return {
      error:
        'could not determine the default branch (origin/HEAD, main, master)',
      ok: false,
    };
  }
  const range = `${defaultBranch}..HEAD`;
  const count = trimmed(runGit(root, ['rev-list', '--count', range]));
  if (!count.ok) return count;
  if (!/^\d+$/u.test(count.value)) {
    return {error: `rev-list --count printed "${count.value}"`, ok: false};
  }
  const log = runGit(root, [
    'log',
    `-n${COMMIT_LIST_CAP}`,
    '--format=%H%x09%s',
    range,
  ]);
  if (!log.ok) return log;
  const commits = log.value
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const tab = line.indexOf('\t');
      return tab === -1
        ? {sha: line, subject: ''}
        : {sha: line.slice(0, tab), subject: line.slice(tab + 1)};
    });
  return {
    ok: true,
    value: {commits, defaultBranch, total: Number(count.value)},
  };
}

/**
 * The facts a save records about `path`'s checkout. The checkout's root, its
 * HEAD and its branch are required: a save that cannot say what its changes
 * are relative to is refused. The upstream and the commits not on the default
 * branch are informational, and a failure there is recorded as unknown.
 */
export function readCheckoutFacts(path: string): Measured<CheckoutFacts> {
  const rootRead = trimmed(runGit(path, ['rev-parse', '--show-toplevel']));
  if (!rootRead.ok) {
    return {
      error: `${path} is not inside a git checkout: ${rootRead.error}`,
      ok: false,
    };
  }
  const root = rootRead.value;
  if (root === '') {
    return {
      error: `${path} has no working tree (a bare repository?)`,
      ok: false,
    };
  }
  const head = trimmed(
    runGit(root, ['rev-parse', '--verify', 'HEAD^{commit}']),
  );
  if (!head.ok) {
    return {
      error: `HEAD does not name a commit, so there is no base to save changes against: ${head.error}`,
      ok: false,
    };
  }
  const branchRead = trimmed(
    runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
  );
  if (!branchRead.ok) return branchRead;
  const branch = branchRead.value === 'HEAD' ? null : branchRead.value;
  const common = trimmed(
    runGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
  );
  if (!common.ok) return common;
  const indexRead = trimmed(
    runGit(root, [
      'rev-parse',
      '--path-format=absolute',
      '--git-path',
      'index',
    ]),
  );
  if (!indexRead.ok) return indexRead;
  const commonDir = common.value;
  const repoRoot =
    basename(commonDir) === '.git' ? dirname(commonDir) : commonDir;
  const indexPath = isAbsolute(indexRead.value)
    ? indexRead.value
    : resolve(root, indexRead.value);
  return {
    ok: true,
    value: {
      branch,
      commitsNotOnDefault: readCommitsNotOnDefault(root),
      head: head.value,
      indexPath,
      repoName: basename(repoRoot).replace(/\.git$/u, ''),
      repoRoot,
      root,
      upstream: readUpstream(root, branch),
      worktreeName: basename(root),
    },
  };
}

/** Re-read HEAD, for the after-copy comparison (D5). */
export function readHead(root: string): Measured<string> {
  return trimmed(runGit(root, ['rev-parse', '--verify', 'HEAD^{commit}']));
}

/**
 * The tracked changes against HEAD as a patch, for a human (D3).
 *
 * PLUMBING `diff-index -p -M HEAD`, NOT `git diff HEAD` (measured 2026-10-17,
 * git 2.54.0): porcelain `git diff` ends with a quiet index refresh that
 * REWRITES `.git/index` even under `--no-optional-locks` and
 * GIT_OPTIONAL_LOCKS=0, which breaks D6. `diff-index` never writes the index,
 * and with `-M` (porcelain diff's default rename detection) its patch was
 * byte-identical to `git diff HEAD` on the test fixture. No external diff
 * drivers or textconv filters run.
 */
export function readPatch(root: string): Measured<string> {
  return runGit(root, [
    'diff-index',
    '-p',
    '-M',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    'HEAD',
    '--',
  ]);
}

/** Path under the checkout, for a status entry. */
export function sourcePath(root: string, relPath: string): string {
  return join(root, relPath);
}
