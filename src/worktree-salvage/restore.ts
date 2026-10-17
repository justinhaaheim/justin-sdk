/**
 * `worktree-salvage restore <stamp dir> --into <checkout>` (epic home-base-us739,
 * D7; dispatch 2, home-base-us739.2).
 *
 * Copies a save's `files/` back into a checkout. Everything that can refuse is
 * checked BEFORE anything is written, so a refusal leaves the target exactly
 * as it was:
 *   - the stamp directory must hold a valid manifest (a `.failed` or incomplete
 *     save is refused);
 *   - the target must be a git checkout whose status can be read;
 *   - every archive file is re-hashed against the manifest; one mismatch
 *     refuses the whole restore;
 *   - no file is written through a symlinked directory, and no directory is
 *     ever replaced or removed.
 *
 * WHAT COUNTS AS OVERWRITING (D7 says "refuses to overwrite an existing file
 * unless --overwrite"). An existing file is refused unless it is a CLEAN
 * TRACKED file of the target (tracked, and not in the target's status): git
 * holds those bytes at the target's HEAD, so replacing it loses nothing that
 * `git checkout -- <path>` cannot bring back. Every other existing file
 * (untracked, modified, staged, ignored) is refused without `--overwrite`.
 * An existing file that already holds the saved bytes is left alone. This is
 * the reading that lets a save go back into a fresh checkout, where every
 * modified file of the save exists in its base version, without making
 * `--overwrite` the routine flag; recorded as a decision on home-base-us739.2.
 *
 * Each written file is re-hashed after the write; a mismatch fails the
 * restore. Recorded deletions (and a rename's original path) are applied only
 * with `--apply-deletions`, under the same rule. Restore never touches git's
 * index: staged-versus-unstaged is not recreated, and index-only versions
 * stay in the save's `index/`, which the printout names.
 */

import type {OutputStyle} from '../cli-style';
import type {Manifest, ManifestEntry} from './manifest';
import type {CommandIo} from './save';
import type {Measured} from './status';
import type {Stats} from 'fs';

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
} from 'fs';
import {basename, dirname, join, resolve} from 'path';

import {
  fieldLines,
  sectionHeader,
  spacedList,
  stepColumn,
  wrapHanging,
} from '../cli-style';
import {
  FAILED_SUFFIX,
  FILES_DIR,
  INDEX_DIR,
  PATCH_FILE,
  readManifest,
} from './manifest';
import {
  copyRegular,
  destinationFor,
  formatCount,
  processIo,
  sha256OfFile,
  sha256OfString,
} from './save';
import {readHead, readStatus, runGit} from './status';

/** Test seams. Production passes none. */
export interface RestoreSeams {
  /** Called after one file is written and before it is verified. */
  afterWrite?: (write: {dest: string; path: string}) => void;
}

export interface RestoreOptions {
  /** `--apply-deletions`: remove what the save recorded as deleted. */
  applyDeletions: boolean;
  /** Any path inside the target checkout; files land relative to its root. */
  into: string;
  /** `--overwrite`: replace existing files that git cannot bring back. */
  overwrite: boolean;
  seams?: RestoreSeams;
  stampDir: string;
}

export interface RestoreReport {
  /** Deletions applied: the path no longer exists in the target. */
  deleted: string[];
  /** Recorded deletions the target already lacked. */
  deletedAlready: string[];
  /** Recorded deletions left alone because `--apply-deletions` was not passed. */
  deletionsNotApplied: string[];
  /** Set when the target HEAD is not the save's base commit, or could not be read. */
  headWarning: string | null;
  /** How many index-only versions the save holds under `index/`; never restored. */
  indexFiles: number;
  manifest: Manifest;
  /** Existing files replaced; each says why that was allowed. */
  replaced: {path: string; why: 'clean-tracked' | 'overwrite'}[];
  /** The target checkout's root. */
  root: string;
  stampDir: string;
  /** Files that already held the saved bytes, left as they were. */
  unchanged: string[];
  /** Files written where nothing was before. */
  written: string[];
}

export type RestoreResult =
  | {
      /** Refused before anything was written: the target is as it was. */
      kind: 'refused';
      problems: string[];
      reason: string;
    }
  | {
      /** Failed PART-WAY: these paths were already changed in the target. */
      changed: string[];
      kind: 'failed';
      reason: string;
      root: string;
    }
  | (RestoreReport & {kind: 'restored'});

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as {code?: unknown}).code === 'ENOENT') return null;
    throw error;
  }
}

function refused(reason: string, problems: string[] = []): RestoreResult {
  return {kind: 'refused', problems, reason};
}

/** Does the archive copy of `entry` still match the manifest? A reason when not. */
function archiveProblem(stampDir: string, entry: ManifestEntry): string | null {
  const filesDir = join(stampDir, FILES_DIR);
  const label = `${FILES_DIR}/${entry.path}`;
  let file: string;
  try {
    file = destinationFor(filesDir, entry.path);
  } catch (error) {
    return messageOf(error);
  }
  const stat = lstatOrNull(file);
  if (stat == null) return `${label} is missing from the save`;
  if (entry.symlinkTarget != null) {
    if (!stat.isSymbolicLink()) return `${label} should be a symlink`;
    const target = readlinkSync(file);
    if (
      target !== entry.symlinkTarget ||
      sha256OfString(target) !== entry.sha256
    ) {
      return `${label} no longer matches the manifest (the symlink points at "${target}")`;
    }
    return null;
  }
  if (!stat.isFile()) return `${label} is not a regular file`;
  const sha = sha256OfFile(file);
  if (sha !== entry.sha256) {
    return `${label} no longer matches the manifest: its sha256 is ${sha}, the manifest says ${entry.sha256 ?? 'none'}`;
  }
  return null;
}

/** Would writing `relPath` under `root` go through a symlink or a file? A reason when so. */
function parentProblem(root: string, relPath: string): string | null {
  const parts = relPath.split('/').slice(0, -1);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    const stat = lstatOrNull(current);
    if (stat == null) return null;
    if (stat.isSymbolicLink()) {
      return `${relPath}: ${current} is a symlink, and restore never writes through one`;
    }
    if (!stat.isDirectory()) {
      return `${relPath}: ${current} is a file where a directory is needed`;
    }
  }
  return null;
}

/** Does the file at `dest` already hold exactly what the save has? */
function alreadyMatches(
  dest: string,
  stat: Stats,
  entry: ManifestEntry,
): boolean {
  if (entry.symlinkTarget != null) {
    return stat.isSymbolicLink() && readlinkSync(dest) === entry.symlinkTarget;
  }
  return stat.isFile() && sha256OfFile(dest) === entry.sha256;
}

/** What the target's git says, read once before anything is written. */
interface TargetState {
  /** Paths the target's status names (changed, staged, untracked). */
  dirty: Set<string>;
  head: Measured<string>;
  root: string;
  tracked: Set<string>;
}

function readTarget(into: string): Measured<TargetState> {
  const top = runGit(into, ['rev-parse', '--show-toplevel']);
  if (!top.ok) {
    return {error: `${into} is not a git checkout: ${top.error}`, ok: false};
  }
  const root = top.value.trim();
  if (root === '') {
    return {
      error: `${into} has no working tree (a bare repository?)`,
      ok: false,
    };
  }
  const status = readStatus(root);
  if (!status.ok) {
    return {
      error: `could not read the target's status, so its own changes cannot be told from clean files: ${status.error}`,
      ok: false,
    };
  }
  const files = runGit(root, ['ls-files', '-z']);
  if (!files.ok) {
    return {
      error: `could not list the target's tracked files: ${files.error}`,
      ok: false,
    };
  }
  const dirty = new Set<string>();
  for (const entry of status.value.parsed.entries) {
    dirty.add(entry.path);
    if (entry.origPath != null) dirty.add(entry.origPath);
  }
  const tracked = new Set(
    files.value.split('\0').filter((path) => path !== ''),
  );
  return {ok: true, value: {dirty, head: readHead(root), root, tracked}};
}

type Disposition =
  | {kind: 'conflict'; reason: string}
  | {kind: 'new'}
  | {kind: 'replace'; why: 'clean-tracked' | 'overwrite'}
  | {kind: 'unchanged'};

/** What to do with one existing path under the overwrite rule (see the header). */
function existingDisposition(
  target: TargetState,
  relPath: string,
  stat: Stats,
  overwrite: boolean,
): Disposition {
  if (stat.isDirectory()) {
    return {
      kind: 'conflict',
      reason: `${relPath} is a directory in the target; restore never replaces a directory`,
    };
  }
  if (target.tracked.has(relPath) && !target.dirty.has(relPath)) {
    return {kind: 'replace', why: 'clean-tracked'};
  }
  if (overwrite) return {kind: 'replace', why: 'overwrite'};
  const what = target.tracked.has(relPath)
    ? 'has changes of its own in the target'
    : 'exists in the target and git does not track it';
  return {kind: 'conflict', reason: `${relPath} ${what}`};
}

interface WritePlan {
  dest: string;
  disposition: Exclude<Disposition, {kind: 'conflict'}>;
  entry: ManifestEntry;
}

interface DeletePlan {
  dest: string;
  path: string;
  /** null when the target already lacks it. */
  why: 'clean-tracked' | 'overwrite' | null;
}

/** Write one file (or symlink) into place through a temporary name, then verify it. */
function writeOne(
  stampDir: string,
  plan: WritePlan,
  seams: RestoreSeams,
): void {
  const {dest, entry} = plan;
  mkdirSync(dirname(dest), {recursive: true});
  const temporary = `${dest}.worktree-salvage-restore-${process.pid}`;
  if (entry.symlinkTarget != null) {
    symlinkSync(entry.symlinkTarget, temporary);
    renameSync(temporary, dest);
    seams.afterWrite?.({dest, path: entry.path});
    const now = readlinkSync(dest);
    if (now !== entry.symlinkTarget) {
      throw new Error(
        `${entry.path}: the restored symlink points at "${now}", not "${entry.symlinkTarget}"`,
      );
    }
    return;
  }
  const mode = entry.mode == null ? 0o644 : Number.parseInt(entry.mode, 8);
  copyRegular(
    destinationFor(join(stampDir, FILES_DIR), entry.path),
    temporary,
    mode,
  );
  renameSync(temporary, dest);
  seams.afterWrite?.({dest, path: entry.path});
  const sha = sha256OfFile(dest);
  if (sha !== entry.sha256) {
    throw new Error(
      `${entry.path}: sha256 of the restored file (${sha}) does not match the manifest (${entry.sha256 ?? 'none'})`,
    );
  }
}

/**
 * Restore `options.stampDir` into `options.into`. Never throws: a refusal
 * means nothing was written; a failure names what was already changed.
 */
export function restoreSave(options: RestoreOptions): RestoreResult {
  const stampDir = resolve(options.stampDir);
  const seams = options.seams ?? {};
  if (basename(stampDir).endsWith(FAILED_SUFFIX)) {
    return refused(
      `${stampDir} is a FAILED save (kept for inspection), not a save; it cannot be restored`,
    );
  }
  const manifestRead = readManifest(stampDir);
  if (!manifestRead.ok) {
    return refused(
      `${stampDir} is not a complete save, so it cannot be restored: ${manifestRead.error}`,
    );
  }
  const manifest = manifestRead.value;

  let target: TargetState;
  try {
    const read = readTarget(options.into);
    if (!read.ok) return refused(read.error);
    target = read.value;
  } catch (error) {
    return refused(messageOf(error));
  }
  const {root} = target;

  const copied = manifest.entries.filter((entry) => entry.copied);
  const archiveProblems = copied
    .map((entry) => archiveProblem(stampDir, entry))
    .filter((problem): problem is string => problem != null);
  if (archiveProblems.length > 0) {
    return refused(
      `the save's files no longer match its manifest (${formatCount(archiveProblems.length, 'file')}), so nothing was restored`,
      archiveProblems,
    );
  }

  const conflicts: string[] = [];
  const writes: WritePlan[] = [];
  const deletes: DeletePlan[] = [];
  const deletionsNotApplied: string[] = [];
  try {
    for (const entry of copied) {
      const dest = destinationFor(root, entry.path);
      const parent = parentProblem(root, entry.path);
      if (parent != null) {
        conflicts.push(parent);
        continue;
      }
      const stat = lstatOrNull(dest);
      if (stat == null) {
        writes.push({dest, disposition: {kind: 'new'}, entry});
        continue;
      }
      if (alreadyMatches(dest, stat, entry)) {
        writes.push({dest, disposition: {kind: 'unchanged'}, entry});
        continue;
      }
      const disposition = existingDisposition(
        target,
        entry.path,
        stat,
        options.overwrite,
      );
      if (disposition.kind === 'conflict') conflicts.push(disposition.reason);
      else writes.push({dest, disposition, entry});
    }

    const deletionPaths = [
      ...manifest.entries
        .filter((entry) => !entry.copied)
        .map((entry) => entry.path),
      ...manifest.entries
        .filter((entry) => entry.kind === 'renamed' && entry.origPath != null)
        .map((entry) => entry.origPath ?? ''),
    ];
    for (const path of deletionPaths) {
      if (!options.applyDeletions) {
        deletionsNotApplied.push(path);
        continue;
      }
      const dest = destinationFor(root, path);
      const parent = parentProblem(root, path);
      if (parent != null) {
        conflicts.push(parent);
        continue;
      }
      const stat = lstatOrNull(dest);
      if (stat == null) {
        deletes.push({dest, path, why: null});
        continue;
      }
      const disposition = existingDisposition(
        target,
        path,
        stat,
        options.overwrite,
      );
      if (disposition.kind === 'conflict') conflicts.push(disposition.reason);
      else if (disposition.kind === 'replace')
        deletes.push({dest, path, why: disposition.why});
    }
  } catch (error) {
    return refused(`could not plan the restore: ${messageOf(error)}`);
  }
  if (conflicts.length > 0) {
    return refused(
      `${formatCount(conflicts.length, 'path')} in the target would be overwritten or removed, and git could not bring ${conflicts.length === 1 ? 'it' : 'them'} back; nothing was restored (--overwrite replaces them)`,
      conflicts,
    );
  }

  const changed: string[] = [];
  try {
    for (const plan of writes) {
      if (plan.disposition.kind === 'unchanged') continue;
      writeOne(stampDir, plan, seams);
      changed.push(plan.entry.path);
    }
    for (const plan of deletes) {
      if (plan.why == null) continue;
      unlinkSync(plan.dest);
      changed.push(plan.path);
      if (lstatOrNull(plan.dest) != null)
        throw new Error(`${plan.path} still exists after it was removed`);
    }
  } catch (error) {
    return {changed, kind: 'failed', reason: messageOf(error), root};
  }

  const head = target.head;
  const headWarning = !head.ok
    ? `could not read the target's HEAD (${head.error}), so it was not compared with the save's base commit ${manifest.head}`
    : head.value === manifest.head
      ? null
      : `the target's HEAD is ${head.value}, but the save was made against ${manifest.head}: each restored file is the whole file as saved, so any change between the two commits to these files is replaced`;
  return {
    deleted: deletes
      .filter((plan) => plan.why != null)
      .map((plan) => plan.path),
    deletedAlready: deletes
      .filter((plan) => plan.why == null)
      .map((plan) => plan.path),
    deletionsNotApplied,
    headWarning,
    indexFiles: existsSync(join(stampDir, INDEX_DIR))
      ? manifest.indexEntries.length
      : 0,
    kind: 'restored',
    manifest,
    replaced: writes.flatMap((plan) =>
      plan.disposition.kind === 'replace'
        ? [{path: plan.entry.path, why: plan.disposition.why}]
        : [],
    ),
    root,
    stampDir,
    unchanged: writes
      .filter((plan) => plan.disposition.kind === 'unchanged')
      .map((plan) => plan.entry.path),
    written: writes
      .filter((plan) => plan.disposition.kind === 'new')
      .map((plan) => plan.entry.path),
  };
}

// ---------------------------------------------------------------------------
// Printing and the command
// ---------------------------------------------------------------------------

function problemList(problems: readonly string[], style: OutputStyle): string {
  return problems
    .map((problem) =>
      wrapHanging(`- ${problem}`, {
        hang: stepColumn(1),
        indent: stepColumn(0),
        width: style.width,
      }),
    )
    .join('\n\n');
}

export function renderRestoreResult(
  result: RestoreResult,
  style: OutputStyle,
): string {
  const fieldOptions = {
    color: style.color,
    indent: stepColumn(0),
    width: style.width,
  };
  switch (result.kind) {
    case 'refused': {
      return spacedList([
        sectionHeader('worktree-salvage restore REFUSED: nothing was written', {
          color: style.color,
          emoji: '🛑',
        }),
        fieldLines([{label: 'reason', value: result.reason}], fieldOptions),
        result.problems.length === 0 ? '' : problemList(result.problems, style),
      ]);
    }
    case 'failed': {
      return spacedList([
        sectionHeader('worktree-salvage restore FAILED part-way', {
          color: style.color,
          emoji: '❌',
        }),
        fieldLines(
          [
            {label: 'target', value: result.root},
            {label: 'reason', value: result.reason},
            {
              label: 'changed',
              value:
                result.changed.length === 0
                  ? 'nothing yet'
                  : `${formatCount(result.changed.length, 'path')} before the failure (listed below)`,
            },
          ],
          fieldOptions,
        ),
        result.changed.length === 0 ? '' : problemList(result.changed, style),
      ]);
    }
    case 'restored': {
      const {manifest} = result;
      const deletions =
        result.deletionsNotApplied.length > 0
          ? `${formatCount(result.deletionsNotApplied.length, 'recorded deletion')} NOT applied (--apply-deletions applies them)`
          : `${formatCount(result.deleted.length, 'path')} removed, ${result.deletedAlready.length} already absent`;
      const fields = [
        {label: 'from', value: result.stampDir},
        {label: 'into', value: result.root},
        {
          label: 'written',
          value: `${formatCount(result.written.length, 'new file')}, each verified by sha256`,
        },
        {
          label: 'replaced',
          value:
            result.replaced.length === 0
              ? 'none'
              : `${formatCount(result.replaced.length, 'file')} (${result.replaced.filter((item) => item.why === 'clean-tracked').length} unmodified tracked files git still has, ${result.replaced.filter((item) => item.why === 'overwrite').length} by --overwrite)`,
        },
        {
          label: 'unchanged',
          value: `${formatCount(result.unchanged.length, 'file')} already held the saved bytes`,
        },
        {label: 'deletions', value: deletions},
        {label: 'base commit', value: manifest.head},
        ...(result.headWarning == null
          ? []
          : [{label: '⚠️ HEAD', value: result.headWarning}]),
        {
          label: 'index only',
          value:
            result.indexFiles === 0
              ? 'none in this save'
              : `${formatCount(result.indexFiles, 'staged version')} in ${join(result.stampDir, INDEX_DIR)}, NOT restored (git's index is never written); see the manifest's indexEntries`,
        },
        {
          label: 'patch',
          value: `${join(result.stampDir, PATCH_FILE)} shows the saved changes as a diff`,
        },
      ];
      return spacedList([
        sectionHeader('Restored', {color: style.color, emoji: '♻️'}),
        fieldLines(fields, fieldOptions),
      ]);
    }
  }
}

export interface RestoreCommandArgs {
  applyDeletions: boolean;
  into: string;
  overwrite: boolean;
  seams?: RestoreSeams;
  stampDir: string;
}

/** `worktree-salvage restore`. Exit 0 when restored; 1 when refused or failed. */
export async function runRestoreCommand(
  args: RestoreCommandArgs,
  io: CommandIo = processIo(),
): Promise<number> {
  const result = restoreSave({
    applyDeletions: args.applyDeletions,
    into: resolve(io.cwd, args.into),
    overwrite: args.overwrite,
    seams: args.seams,
    stampDir: resolve(io.cwd, args.stampDir),
  });
  if (result.kind === 'restored') {
    await io.stdout(`${renderRestoreResult(result, io.stdoutStyle)}\n`);
    return 0;
  }
  await io.stderr(`${renderRestoreResult(result, io.stderrStyle)}\n`);
  return 1;
}
