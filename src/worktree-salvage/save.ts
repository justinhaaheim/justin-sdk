/**
 * `worktree-salvage save` (epic home-base-us739, D2, D3, D5, D6).
 *
 * Copies a checkout's modified, staged, renamed, type-changed, conflicted and
 * untracked files, with a manifest, to `<outDir>/<repo>/<worktree>/<stamp>/`.
 *
 * WHAT IS SAVED (D2). Every entry of `git status --porcelain=v2
 * --untracked-files=all` is copied, except that a deletion is RECORDED (with
 * HEAD's blob, which git still has) rather than copied. Ignored paths are not
 * copied by default but are never silent: each one is listed, with its file
 * count and bytes, in the manifest and the printout. `--ignored` copies them
 * too, except `node_modules/` and `.git/` at any depth. A nested checkout (a
 * submodule, or a directory holding its own `.git`) is recorded, never entered.
 *
 * A PARTIAL SAVE NEVER REPORTS SUCCESS (D5, critical rule 7). In order:
 *   - free space at the destination is checked against the total first;
 *   - each file is hashed as it is read from the source, and the copy is
 *     re-read and hashed again; a mismatch fails;
 *   - after copying, the status listing and HEAD are read again and must be
 *     byte-identical to the first read;
 *   - every source file is hashed a THIRD time, because a file that was already
 *     modified keeps the same status line when it changes again, so the status
 *     comparison alone cannot see it (an addition to D5's two checks);
 *   - only then is `manifest.json` written, last.
 * Any failure after the stamp directory exists renames it `<stamp>.failed`
 * (kept for inspection, with FAILED.txt saying why), and the result is a
 * failure naming the file. A failure before anything is written (git cannot
 * read the checkout, the destination is short of space) creates nothing.
 *
 * THE SOURCE IS NEVER WRITTEN (D6): every git call goes through status.ts's
 * read-only runner, and every source file is opened read-only, with O_NOFOLLOW
 * so a symlink is never followed and O_NONBLOCK so a FIFO cannot hang the save.
 */

import type {ConfigEnv, Destination} from './config';
import type {
  IgnoredPath,
  IndexEntry,
  Manifest,
  ManifestEntry,
  ManifestNestedCheckout,
  Size,
  SkippedPath,
} from './manifest';
import type {CheckoutFacts, Measured, StatusEntry} from './status';
import type {Stats} from 'fs';

import {createHash} from 'crypto';
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  renameSync,
  statfsSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'fs';
import {dirname, join, relative, resolve, sep} from 'path';

import {
  fieldLines,
  type OutputStyle,
  outputStyle,
  paint,
  sectionHeader,
  spacedList,
  stepColumn,
  wrapHanging,
} from '../cli-style';
import {formatLocalTimestamp} from '../date';
import {getSdkVersion} from '../sdk-identity';
import {describeDestinationSource, resolveDestination} from './config';
import {
  FAILED_SUFFIX,
  FAILURE_FILE,
  FILES_DIR,
  INDEX_DIR,
  MANIFEST_SCHEMA_VERSION,
  PATCH_FILE,
  writeManifest,
} from './manifest';
import {
  readBlob,
  readBlobSize,
  readCheckoutFacts,
  readHead,
  readIgnoredStatus,
  readPatch,
  readStatus,
  readUnmergedStages,
} from './status';

/** Test seams. Production passes none; each one exists for a D5 negative control. */
export interface SaveSeams {
  /** Called after one file is copied and before the copy is verified. */
  afterCopy?: (copy: {dest: string; path: string; source: string}) => void;
  /** Called after the last copy and before the second status read. */
  beforeSecondRead?: () => void;
  /** Free bytes at `dir`, or null when it cannot be measured. Default: statfs. */
  freeBytes?: (dir: string) => number | null;
  /** Reads one index blob for `index/`. Default: status.ts's `readBlob` (`git cat-file blob`). */
  readIndexBlob?: (root: string, oid: string) => Measured<Buffer>;
}

export interface SaveOptions {
  /** Any path inside the checkout; the save covers the whole checkout. */
  checkout: string;
  destination: Destination;
  /** `--ignored`: copy ignored files too (never node_modules/ or .git/). */
  includeIgnored: boolean;
  now?: Date;
  seams?: SaveSeams;
}

/** What the ignored read and its walk found (D2). */
export interface IgnoredSurvey {
  paths: IgnoredPath[];
  skipped: SkippedPath[];
}

export type SaveResult =
  | {
      destination: Destination;
      failedDir: string | null;
      kind: 'failed';
      reason: string;
      root: string | null;
    }
  | {
      destination: Destination;
      facts: CheckoutFacts;
      ignored: IgnoredSurvey;
      kind: 'nothing-to-save';
      nestedCheckouts: ManifestNestedCheckout[];
    }
  | {
      destination: Destination;
      kind: 'saved';
      manifest: Manifest;
      stampDir: string;
    };

const COPY_CHUNK = 1024 * 1024;
/** Headroom on top of the bytes to copy: the manifest, and a block per file. */
const FREE_SPACE_MARGIN = 1024 * 1024;
const PER_FILE_OVERHEAD = 4096;

const READ_FLAGS =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** "674 MB" style, decimal units, the way Finder counts. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 'bytes';
  for (const next of units) {
    if (value < 1000) break;
    value /= 1000;
    unit = next;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

export function formatCount(
  count: number,
  noun: string,
  plural = `${noun}s`,
): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? noun : plural}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function modeString(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(4, '0');
}

export function sha256OfString(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/** Open `path` read-only without following a symlink, and insist it is a regular file. */
function openRegular(path: string): number {
  const fd = openSync(path, READ_FLAGS);
  const stat = fstatSync(fd);
  if (!stat.isFile()) {
    closeSync(fd);
    throw new Error(`${path} is no longer a regular file`);
  }
  return fd;
}

/** sha256 of a regular file's bytes, read in chunks. */
export function sha256OfFile(path: string): string {
  const hash = createHash('sha256');
  const fd = openRegular(path);
  try {
    const buffer = Buffer.allocUnsafe(COPY_CHUNK);
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * Copy `source` to `dest` (which must not exist), hashing the bytes as they are
 * read. Returns that hash and the byte count; the caller verifies the copy.
 */
export function copyRegular(
  source: string,
  dest: string,
  mode: number,
): {bytes: number; sha256: string} {
  const hash = createHash('sha256');
  const input = openRegular(source);
  let bytes = 0;
  try {
    const output = openSync(dest, 'wx', mode & 0o7777);
    try {
      const buffer = Buffer.allocUnsafe(COPY_CHUNK);
      for (;;) {
        const read = readSync(input, buffer, 0, buffer.length, null);
        if (read === 0) break;
        const chunk = buffer.subarray(0, read);
        hash.update(chunk);
        let written = 0;
        while (written < read) {
          written += writeSync(output, chunk, written, read - written);
        }
        bytes += read;
      }
      // The umask may have stripped bits from the open() mode; set them exactly.
      fchmodSync(output, mode & 0o7777);
    } finally {
      closeSync(output);
    }
  } finally {
    closeSync(input);
  }
  return {bytes, sha256: hash.digest('hex')};
}

/** Files and bytes under `abs` (lstat sizes; symlinks counted, never followed). */
function measureTree(abs: string): Size {
  let files = 0;
  let bytes = 0;
  const stack = [abs];
  try {
    while (stack.length > 0) {
      const current = stack.pop();
      if (current == null) break;
      const stat = lstatSync(current);
      if (!stat.isDirectory()) {
        files += 1;
        bytes += stat.size;
        continue;
      }
      for (const name of readdirSync(current)) stack.push(join(current, name));
    }
  } catch (error) {
    return {error: messageOf(error), ok: false};
  }
  return {ok: true, value: {bytes, files}};
}

function holdsGitDir(abs: string): boolean {
  return existsSync(join(abs, '.git'));
}

/** Exported for worktree-retire (home-base-rub4v.1.1), which classifies the same walk. */
export interface IgnoredWalk {
  /** Relative paths of every file a `--ignored` save copies. */
  files: string[];
  nested: ManifestNestedCheckout[];
  survey: IgnoredSurvey;
}

function withoutSlash(path: string): string {
  return path.endsWith('/') ? path.slice(0, -1) : path;
}

function lastSegment(relPath: string): string {
  const parts = relPath.split('/');
  return parts[parts.length - 1] ?? relPath;
}

/**
 * Walk every ignored path git matched. Each is measured (files and bytes,
 * excluding node_modules/ and .git/ below it, which are listed and measured
 * separately); a directory holding its own `.git` is a nested checkout and is
 * not entered. A walk that fails gives that path an UNKNOWN size, never 0.
 */
export function walkIgnored(
  root: string,
  ignored: readonly string[],
): IgnoredWalk {
  const files: string[] = [];
  const nested: ManifestNestedCheckout[] = [];
  const paths: IgnoredPath[] = [];
  const skipped: SkippedPath[] = [];
  for (const gitPath of ignored) {
    const rel = withoutSlash(gitPath);
    const abs = join(root, rel);
    const name = lastSegment(rel);
    if (name === 'node_modules' || name === '.git') {
      skipped.push({path: gitPath, reason: name, size: measureTree(abs)});
      continue;
    }
    let stat: Stats;
    try {
      stat = lstatSync(abs);
    } catch (error) {
      paths.push({
        path: gitPath,
        saved: false,
        size: {error: messageOf(error), ok: false},
      });
      continue;
    }
    if (stat.isDirectory() && holdsGitDir(abs)) {
      nested.push({
        foundIn: 'ignored',
        kind: 'nested-repository',
        path: rel,
        submoduleState: null,
      });
      continue;
    }
    const ownFiles: string[] = [];
    let count = 0;
    let bytes = 0;
    let failure: string | null = null;
    const stack: {abs: string; rel: string}[] = [{abs, rel}];
    while (stack.length > 0 && failure == null) {
      const current = stack.pop();
      if (current == null) break;
      try {
        const currentStat = current.abs === abs ? stat : lstatSync(current.abs);
        if (!currentStat.isDirectory()) {
          count += 1;
          bytes += currentStat.size;
          ownFiles.push(current.rel);
          continue;
        }
        for (const child of readdirSync(current.abs)) {
          const childAbs = join(current.abs, child);
          const childRel = `${current.rel}/${child}`;
          if (child === 'node_modules' || child === '.git') {
            const childStat = lstatSync(childAbs);
            if (childStat.isDirectory()) {
              skipped.push({
                path: `${childRel}/`,
                reason: child,
                size: measureTree(childAbs),
              });
              continue;
            }
          }
          const childStat = lstatSync(childAbs);
          if (childStat.isDirectory() && holdsGitDir(childAbs)) {
            nested.push({
              foundIn: 'ignored',
              kind: 'nested-repository',
              path: childRel,
              submoduleState: null,
            });
            continue;
          }
          stack.push({abs: childAbs, rel: childRel});
        }
      } catch (error) {
        failure = messageOf(error);
      }
    }
    if (failure == null) {
      files.push(...ownFiles);
      paths.push({
        path: gitPath,
        saved: false,
        size: {ok: true, value: {bytes, files: count}},
      });
    } else {
      paths.push({
        path: gitPath,
        saved: false,
        size: {error: failure, ok: false},
      });
    }
  }
  return {files, nested, survey: {paths, skipped}};
}

/** One thing a save will copy, planned from an lstat taken before copying. */
interface CopyPlan {
  entry: ManifestEntry;
  /** A regular file's permission bits; null for a symlink. */
  mode: number | null;
  source: string;
  /** A symlink's target; null for a regular file. */
  symlinkTarget: string | null;
}

function fail(
  destination: Destination,
  reason: string,
  root: string | null,
  failedDir: string | null = null,
): SaveResult {
  return {destination, failedDir, kind: 'failed', reason, root};
}

/** Plan one entry's copy from an lstat. Throws a reason naming the path. */
function planEntry(
  root: string,
  entry: StatusEntry | null,
  relPath: string,
): CopyPlan {
  const source = join(root, relPath);
  const base = {
    headBlob: entry?.headBlob ?? null,
    indexBlob: entry?.indexBlob ?? null,
    kind: entry?.kind ?? ('ignored' as const),
    origPath: entry?.origPath ?? null,
    path: relPath,
    status: entry?.status ?? '!!',
  };
  let stat: Stats;
  try {
    stat = lstatSync(source);
  } catch (error) {
    throw new Error(
      `${relPath} was listed by git but cannot be read from disk (${messageOf(error)}); the worktree may have changed during the save`,
    );
  }
  if (stat.isSymbolicLink()) {
    const target = readlinkSync(source);
    return {
      entry: {
        ...base,
        bytes: Buffer.byteLength(target, 'utf-8'),
        copied: true,
        mode: null,
        sha256: sha256OfString(target),
        symlinkTarget: target,
      },
      mode: null,
      source,
      symlinkTarget: target,
    };
  }
  if (!stat.isFile()) {
    throw new Error(
      `${relPath} is neither a regular file nor a symlink (${stat.isDirectory() ? 'a directory' : 'a special file'}), so it cannot be saved`,
    );
  }
  return {
    entry: {
      ...base,
      bytes: stat.size,
      copied: true,
      mode: modeString(stat.mode),
      sha256: null,
      symlinkTarget: null,
    },
    mode: stat.mode,
    source,
    symlinkTarget: null,
  };
}

function deletionEntry(entry: StatusEntry): ManifestEntry {
  return {
    bytes: null,
    copied: false,
    headBlob: entry.headBlob,
    indexBlob: entry.indexBlob,
    kind: entry.kind,
    mode: null,
    origPath: entry.origPath,
    path: entry.path,
    sha256: null,
    status: entry.status,
    symlinkTarget: null,
  };
}

export function destinationFor(filesDir: string, relPath: string): string {
  const dest = resolve(filesDir, relPath);
  const back = relative(filesDir, dest);
  if (back === '' || back.startsWith('..') || back.startsWith(sep)) {
    throw new Error(`${relPath} would be written outside ${filesDir}`);
  }
  return dest;
}

/** One index-only version to write under `index/`, sized before anything is written. */
interface IndexPlan {
  bytes: number;
  file: string;
  indexBlob: string;
  path: string;
  stage: number | null;
}

/**
 * Does this entry's index hold a version found nowhere else (D2's addition)?
 * The index must differ from HEAD (a different blob id) AND the worktree must
 * differ from the index. The second test is git's own status letter for the
 * worktree side (`Y` is not `.`), not a hash of the disk: git compares through
 * its clean filters (autocrlf, LFS), which a raw hash of the file would not.
 * A `Y` that is only a mode change saves a copy that was not strictly needed;
 * that errs toward keeping.
 */
function holdsIndexOnlyVersion(entry: StatusEntry): boolean {
  if (entry.kind === 'unmerged' || entry.indexBlob == null) return false;
  if (entry.indexBlob === entry.headBlob) return false;
  return (entry.status[1] ?? '.') !== '.';
}

/**
 * Plan every index-only copy: ordinary entries per `holdsIndexOnlyVersion`,
 * and every stage of every unmerged path from `git ls-files -u`. Each blob is
 * sized with `git cat-file -s`. Throws a reason on any failed read: this runs
 * before anything is written, so a failure here creates nothing.
 */
function planIndexCopies(
  root: string,
  entries: readonly StatusEntry[],
): IndexPlan[] {
  const wanted: Omit<IndexPlan, 'bytes'>[] = entries
    .filter(holdsIndexOnlyVersion)
    .map((entry) => ({
      file: entry.path,
      indexBlob: entry.indexBlob ?? '',
      path: entry.path,
      stage: null,
    }));
  if (entries.some((entry) => entry.kind === 'unmerged')) {
    const stages = readUnmergedStages(root);
    if (!stages.ok) {
      throw new Error(
        `could not read the conflict stages from the index: ${stages.error}`,
      );
    }
    for (const stage of stages.value) {
      wanted.push({
        file: `${stage.path}.stage${stage.stage}`,
        indexBlob: stage.blob,
        path: stage.path,
        stage: stage.stage,
      });
    }
  }
  return wanted.map((plan) => {
    const size = readBlobSize(root, plan.indexBlob);
    if (!size.ok) {
      throw new Error(
        `could not size the index version of ${plan.path}: ${size.error}`,
      );
    }
    return {...plan, bytes: size.value};
  });
}

/** Write one index-only version and verify it. Throws a reason naming the path. */
function writeIndexCopy(
  root: string,
  plan: IndexPlan,
  indexDir: string,
  seams: SaveSeams,
): IndexEntry {
  const content = (seams.readIndexBlob ?? readBlob)(root, plan.indexBlob);
  if (!content.ok) {
    throw new Error(
      `could not read the index version of ${plan.path} (${plan.indexBlob}): ${content.error}`,
    );
  }
  if (content.value.length !== plan.bytes) {
    throw new Error(
      `the index version of ${plan.path} is ${content.value.length} bytes, but git cat-file -s said ${plan.bytes}`,
    );
  }
  const dest = destinationFor(indexDir, plan.file);
  mkdirSync(dirname(dest), {recursive: true});
  writeFileSync(dest, content.value, {flag: 'wx'});
  const sha256 = createHash('sha256').update(content.value).digest('hex');
  const verified = sha256OfFile(dest);
  if (verified !== sha256) {
    throw new Error(
      `${INDEX_DIR}/${plan.file}: sha256 of the copy (${verified}) does not match what git returned (${sha256})`,
    );
  }
  return {
    bytes: plan.bytes,
    file: plan.file,
    indexBlob: plan.indexBlob,
    path: plan.path,
    sha256,
    stage: plan.stage,
  };
}

function defaultFreeBytes(dir: string): number | null {
  try {
    const stats = statfsSync(dir);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

function nearestExisting(dir: string): string {
  let current = resolve(dir);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

/**
 * Claim a fresh stamp directory under `parent`: `<stamp>`, else `<stamp>-2`,
 * `-3`… `mkdir` without `recursive` is the atomic claim, so two saves in one
 * second never share a directory. A name whose `.failed` twin exists is skipped,
 * so a later failure always has its rename target free.
 */
function claimStampDir(
  parent: string,
  stamp: string,
): {dir: string; stamp: string} {
  for (let attempt = 1; attempt < 1000; attempt += 1) {
    const candidate = attempt === 1 ? stamp : `${stamp}-${attempt}`;
    const dir = join(parent, candidate);
    if (existsSync(`${dir}${FAILED_SUFFIX}`)) continue;
    try {
      mkdirSync(dir);
      return {dir, stamp: candidate};
    } catch (error) {
      if ((error as {code?: unknown}).code === 'EEXIST') continue;
      throw error;
    }
  }
  throw new Error(`could not claim a stamp directory under ${parent}`);
}

/** Copy one planned entry and verify the copy. Returns the entry with its hash. */
function copyAndVerify(
  plan: CopyPlan,
  filesDir: string,
  seams: SaveSeams,
): ManifestEntry {
  const dest = destinationFor(filesDir, plan.entry.path);
  mkdirSync(dirname(dest), {recursive: true});
  if (plan.symlinkTarget != null) {
    symlinkSync(plan.symlinkTarget, dest);
    seams.afterCopy?.({dest, path: plan.entry.path, source: plan.source});
    const copied = readlinkSync(dest);
    if (copied !== plan.symlinkTarget) {
      throw new Error(
        `${plan.entry.path}: the copied symlink points at "${copied}", not "${plan.symlinkTarget}"`,
      );
    }
    return plan.entry;
  }
  const {bytes, sha256} = copyRegular(plan.source, dest, plan.mode ?? 0o644);
  seams.afterCopy?.({dest, path: plan.entry.path, source: plan.source});
  const verified = sha256OfFile(dest);
  if (verified !== sha256) {
    throw new Error(
      `${plan.entry.path}: sha256 of the copy (${verified}) does not match the source (${sha256})`,
    );
  }
  return {...plan.entry, bytes, sha256};
}

/** The third hash: has any source file changed since it was copied? */
function sourceStillMatches(
  entry: ManifestEntry,
  source: string,
): string | null {
  if (entry.symlinkTarget != null) {
    let now: string;
    try {
      now = readlinkSync(source);
    } catch (error) {
      return `${entry.path} changed during the save (${messageOf(error)})`;
    }
    return now === entry.symlinkTarget
      ? null
      : `${entry.path} changed during the save (the symlink now points elsewhere)`;
  }
  let now: string;
  try {
    now = sha256OfFile(source);
  } catch (error) {
    return `${entry.path} changed during the save (${messageOf(error)})`;
  }
  return now === entry.sha256
    ? null
    : `${entry.path} changed during the save (its content differs from what was copied)`;
}

function markFailed(stampDir: string, reason: string): string | null {
  const failedDir = `${stampDir}${FAILED_SUFFIX}`;
  try {
    renameSync(stampDir, failedDir);
  } catch {
    // The directory keeps its name and has no manifest, so `list` reports it
    // as an incomplete save; the reason still reaches the caller.
    return stampDir;
  }
  try {
    writeFileSync(join(failedDir, FAILURE_FILE), `${reason}\n`);
  } catch {
    // Best effort: the reason is in the result either way.
  }
  return failedDir;
}

/**
 * Save `options.checkout`. Never throws: every failure is a `failed` result
 * whose reason names what failed, and a failure never carries a manifest.
 */
export function saveCheckout(options: SaveOptions): SaveResult {
  const {destination, includeIgnored} = options;
  const seams = options.seams ?? {};
  const factsRead = readCheckoutFacts(options.checkout);
  if (!factsRead.ok) return fail(destination, factsRead.error, null);
  const facts = factsRead.value;
  const {root} = facts;

  const before = readStatus(root);
  if (!before.ok) return fail(destination, before.error, root);
  const ignoredBefore = readIgnoredStatus(root);
  if (!ignoredBefore.ok) return fail(destination, ignoredBefore.error, root);

  const walk = walkIgnored(root, ignoredBefore.value.parsed.ignored);
  const nestedCheckouts: ManifestNestedCheckout[] = [
    ...before.value.parsed.nested.map((nested) => ({
      ...nested,
      foundIn: 'status' as const,
    })),
    ...walk.nested,
  ];
  if (includeIgnored) {
    const unmeasured = [...walk.survey.paths].find((path) => !path.size.ok);
    if (unmeasured != null && !unmeasured.size.ok) {
      return fail(
        destination,
        `--ignored cannot save ${unmeasured.path}: ${unmeasured.size.error}`,
        root,
      );
    }
  }
  const ignoredSurvey: IgnoredSurvey = {
    paths: walk.survey.paths.map((path) => ({...path, saved: includeIgnored})),
    skipped: walk.survey.skipped,
  };

  const statusEntries = before.value.parsed.entries;
  const ignoredFiles = includeIgnored ? walk.files : [];
  if (statusEntries.length === 0 && ignoredFiles.length === 0) {
    return {
      destination,
      facts,
      ignored: ignoredSurvey,
      kind: 'nothing-to-save',
      nestedCheckouts,
    };
  }

  // Plan every copy from an lstat taken now, before anything is written.
  const plans: CopyPlan[] = [];
  const deletions: ManifestEntry[] = [];
  let indexPlans: IndexPlan[];
  try {
    for (const entry of statusEntries) {
      if (entry.inWorktree) plans.push(planEntry(root, entry, entry.path));
      else deletions.push(deletionEntry(entry));
    }
    for (const relPath of ignoredFiles)
      plans.push(planEntry(root, null, relPath));
    indexPlans = planIndexCopies(root, statusEntries);
  } catch (error) {
    return fail(destination, messageOf(error), root);
  }

  const patch = readPatch(root);
  if (!patch.ok) return fail(destination, patch.error, root);
  const patchBytes = Buffer.byteLength(patch.value, 'utf-8');

  const copyBytes =
    plans.reduce((sum, plan) => sum + (plan.entry.bytes ?? 0), 0) +
    indexPlans.reduce((sum, plan) => sum + plan.bytes, 0);
  const needed =
    copyBytes +
    patchBytes +
    FREE_SPACE_MARGIN +
    (plans.length + indexPlans.length) * PER_FILE_OVERHEAD;
  const measureAt = nearestExisting(destination.dir);
  const free = (seams.freeBytes ?? defaultFreeBytes)(measureAt);
  if (free == null) {
    return fail(
      destination,
      `could not measure the free space at ${measureAt}, so the save was not started`,
      root,
    );
  }
  if (free < needed) {
    return fail(
      destination,
      `not enough free space at ${measureAt}: the save needs ${formatBytes(needed)} and ${formatBytes(free)} is free`,
      root,
    );
  }

  const parent = join(destination.dir, facts.repoName, facts.worktreeName);
  let claimed: {dir: string; stamp: string};
  try {
    mkdirSync(parent, {recursive: true});
    claimed = claimStampDir(
      parent,
      formatLocalTimestamp(options.now ?? new Date()),
    );
  } catch (error) {
    return fail(
      destination,
      `could not create the save directory under ${parent}: ${messageOf(error)}`,
      root,
    );
  }
  const stampDir = claimed.dir;

  try {
    const filesDir = join(stampDir, FILES_DIR);
    mkdirSync(filesDir);
    const copied = plans.map((plan) => copyAndVerify(plan, filesDir, seams));
    const indexDir = join(stampDir, INDEX_DIR);
    if (indexPlans.length > 0) mkdirSync(indexDir);
    const indexEntries = indexPlans.map((plan) =>
      writeIndexCopy(root, plan, indexDir, seams),
    );

    const patchPath = join(stampDir, PATCH_FILE);
    writeFileSync(patchPath, patch.value, {flag: 'wx'});
    const patchSha = sha256OfString(patch.value);
    if (sha256OfFile(patchPath) !== patchSha) {
      throw new Error(
        `${PATCH_FILE}: the written patch does not match what git printed`,
      );
    }

    seams.beforeSecondRead?.();
    const after = readStatus(root);
    if (!after.ok)
      throw new Error(`the second status read failed: ${after.error}`);
    if (after.value.raw !== before.value.raw) {
      throw new Error(
        'the worktree changed during the save (git status differs from the first read); run it again',
      );
    }
    const headAfter = readHead(root);
    if (!headAfter.ok)
      throw new Error(`could not re-read HEAD: ${headAfter.error}`);
    if (headAfter.value !== facts.head) {
      throw new Error(
        `HEAD moved during the save (${facts.head} → ${headAfter.value}); run it again`,
      );
    }
    if (includeIgnored) {
      const ignoredAfter = readIgnoredStatus(root);
      if (!ignoredAfter.ok) {
        throw new Error(
          `the second ignored read failed: ${ignoredAfter.error}`,
        );
      }
      if (ignoredAfter.value.raw !== ignoredBefore.value.raw) {
        throw new Error(
          'the ignored files changed during the save (git status --ignored differs from the first read); run it again',
        );
      }
    }
    copied.forEach((entry, index) => {
      const source = plans[index]?.source;
      if (source == null)
        throw new Error(`no source recorded for ${entry.path}`);
      const changed = sourceStillMatches(entry, source);
      if (changed != null) throw new Error(`${changed}; run it again`);
    });

    const entries = [...copied, ...deletions].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
    const manifest: Manifest = {
      branch: facts.branch,
      commitsNotOnDefault: facts.commitsNotOnDefault,
      destination: {
        configFile: destination.configFile,
        dir: destination.dir,
        source: destination.source,
      },
      entries,
      head: facts.head,
      ignored: {
        copied: includeIgnored,
        paths: ignoredSurvey.paths,
        skipped: ignoredSurvey.skipped,
      },
      indexEntries,
      nestedCheckouts,
      patch: {bytes: patchBytes, file: PATCH_FILE, sha256: patchSha},
      repoName: facts.repoName,
      repoRoot: facts.repoRoot,
      savedAt: (options.now ?? new Date()).toISOString(),
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      sdkVersion: getSdkVersion(),
      stamp: claimed.stamp,
      tool: 'worktree-salvage',
      totals: {
        bytes: copied.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0),
        deletions: deletions.length,
        files: copied.length,
      },
      upstream: facts.upstream,
      worktreeName: facts.worktreeName,
      worktreePath: root,
    };
    writeManifest(stampDir, manifest);
    return {destination, kind: 'saved', manifest, stampDir};
  } catch (error) {
    const reason = messageOf(error);
    return fail(destination, reason, root, markFailed(stampDir, reason));
  }
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

function sizeText(size: Size): string {
  return size.ok
    ? `${formatBytes(size.value.bytes)}, ${formatCount(size.value.files, 'file')}`
    : `size UNKNOWN (${size.error})`;
}

function notSavedLines(
  survey: IgnoredSurvey,
  nested: readonly ManifestNestedCheckout[],
  includeIgnored: boolean,
): {label: string; value: string}[] {
  const lines: {label: string; value: string}[] = [];
  if (!includeIgnored) {
    for (const path of survey.paths) {
      lines.push({
        label: path.path,
        value: `${sizeText(path.size)}: ignored by git; --ignored copies it`,
      });
    }
  }
  for (const path of survey.skipped) {
    lines.push({
      label: path.path,
      value: `${sizeText(path.size)}: ${path.reason} is never copied, even with --ignored`,
    });
  }
  for (const checkout of nested) {
    lines.push({
      label: `${checkout.path}/`,
      value: `${checkout.kind === 'submodule' ? 'a submodule' : 'a nested checkout'}: not entered, so its own changes are not saved; save it on its own`,
    });
  }
  return lines;
}

function notSavedBlock(
  lines: readonly {label: string; value: string}[],
  style: OutputStyle,
): string {
  if (lines.length === 0) return '';
  // Path on its own line, what it is one step in below it: a long path never
  // pushes a shared value column off the right edge.
  return spacedList([
    sectionHeader('Not saved', {color: style.color, emoji: '🚫'}),
    ...lines.map((line) =>
      [
        wrapHanging(paint(line.label, ['bold'], style.color), {
          hang: stepColumn(0),
          indent: stepColumn(0),
          width: style.width,
        }),
        wrapHanging(line.value, {
          hang: stepColumn(1),
          indent: stepColumn(1),
          width: style.width,
        }),
      ].join('\n'),
    ),
  ]);
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

/** The printout for one save (AC 3): destination and its source, counts, bytes, branch, base. */
export function renderSaveResult(
  result: SaveResult,
  style: OutputStyle,
): string {
  const fieldOptions = {
    color: style.color,
    indent: stepColumn(0),
    width: style.width,
  };
  const destinationFields = [
    {label: 'destination', value: result.destination.dir},
    {label: 'from', value: describeDestinationSource(result.destination)},
  ];
  switch (result.kind) {
    case 'failed': {
      return spacedList([
        sectionHeader('worktree-salvage save FAILED: nothing was saved', {
          color: style.color,
          emoji: '❌',
        }),
        fieldLines(
          [
            {label: 'checkout', value: result.root ?? 'unknown'},
            {label: 'reason', value: result.reason},
            ...destinationFields,
            {
              label: 'kept at',
              value:
                result.failedDir == null
                  ? 'nothing was written'
                  : `${result.failedDir} (for inspection; it is not a save)`,
            },
          ],
          fieldOptions,
        ),
      ]);
    }
    case 'nothing-to-save': {
      return spacedList([
        sectionHeader('Nothing to save', {color: style.color, emoji: '✅'}),
        fieldLines(
          [
            {label: 'checkout', value: result.facts.root},
            {label: 'status', value: 'no modified, staged or untracked files'},
            {label: 'branch', value: result.facts.branch ?? '(detached HEAD)'},
            {label: 'base commit', value: shortSha(result.facts.head)},
            ...destinationFields,
          ],
          fieldOptions,
        ),
        notSavedBlock(
          notSavedLines(result.ignored, result.nestedCheckouts, false),
          style,
        ),
      ]);
    }
    case 'saved': {
      const {manifest} = result;
      return spacedList([
        sectionHeader('Saved', {color: style.color, emoji: '💾'}),
        fieldLines(
          [
            {label: 'checkout', value: manifest.worktreePath},
            {label: 'saved to', value: result.stampDir},
            ...destinationFields,
            {
              label: 'files',
              value: `${formatCount(manifest.totals.files, 'file')} copied`,
            },
            {
              label: 'deletions',
              value:
                manifest.totals.deletions === 0
                  ? 'none'
                  : `${formatCount(manifest.totals.deletions, 'deletion')} recorded (git still has the base version)`,
            },
            {
              label: 'index only',
              value:
                manifest.indexEntries.length === 0
                  ? 'none'
                  : `${formatCount(manifest.indexEntries.length, 'staged version')} found only in the index, saved under ${INDEX_DIR}/`,
            },
            {
              label: 'bytes',
              value:
                manifest.totals.bytes < 1000
                  ? formatBytes(manifest.totals.bytes)
                  : `${formatBytes(manifest.totals.bytes)} (${manifest.totals.bytes.toLocaleString('en-US')} bytes)`,
            },
            {label: 'branch', value: manifest.branch ?? '(detached HEAD)'},
            {label: 'base commit', value: shortSha(manifest.head)},
          ],
          fieldOptions,
        ),
        notSavedBlock(
          notSavedLines(
            {paths: manifest.ignored.paths, skipped: manifest.ignored.skipped},
            manifest.nestedCheckouts,
            manifest.ignored.copied,
          ),
          style,
        ),
      ]);
    }
  }
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/** Where a command prints, and what it reads paths from. Tests pass their own. */
export interface CommandIo {
  cwd: string;
  env: ConfigEnv;
  stderr: (text: string) => Promise<void>;
  stderrStyle: OutputStyle;
  stdout: (text: string) => Promise<void>;
  stdoutStyle: OutputStyle;
}

/** The real process: Bun.write waits for a pipe to drain before `process.exit` (see write-stdout.ts). */
export function processIo(): CommandIo {
  return {
    cwd: process.cwd(),
    env: process.env,
    stderr: async (text) => {
      await Bun.write(Bun.stderr, text);
    },
    stderrStyle: outputStyle(process.stderr),
    stdout: async (text) => {
      await Bun.write(Bun.stdout, text);
    },
    stdoutStyle: outputStyle(process.stdout),
  };
}

export interface SaveCommandArgs {
  checkout: string;
  includeIgnored: boolean;
  /** `--out`; null when not given. */
  out: string | null;
  seams?: SaveSeams;
}

/**
 * `worktree-salvage save <path>`. Exit 0 when the checkout was saved or had
 * nothing to save; 1 when anything failed, with the reason on stderr.
 */
export async function runSaveCommand(
  args: SaveCommandArgs,
  io: CommandIo = processIo(),
): Promise<number> {
  let destination: Destination;
  try {
    destination = resolveDestination(args.out, {cwd: io.cwd, env: io.env});
  } catch (error) {
    await io.stderr(
      `worktree-salvage save: nothing was saved, because the destination could not be resolved: ${messageOf(error)}\n`,
    );
    return 1;
  }
  const result = saveCheckout({
    checkout: resolve(io.cwd, args.checkout),
    destination,
    includeIgnored: args.includeIgnored,
    seams: args.seams,
  });
  if (result.kind === 'failed') {
    await io.stderr(`${renderSaveResult(result, io.stderrStyle)}\n`);
    return 1;
  }
  await io.stdout(`${renderSaveResult(result, io.stdoutStyle)}\n`);
  return 0;
}
