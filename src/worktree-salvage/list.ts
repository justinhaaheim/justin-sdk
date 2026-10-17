/**
 * `worktree-salvage list` (epic home-base-us739, D8).
 *
 * Every save under the destination, grouped by repo ROOT and worktree path as
 * the manifests record them. The folder names are not enough: two repos with
 * one basename share a `<repo name>/` folder, and that is why the root is
 * printed and grouped on.
 *
 * Every stamp directory is shown, and none is mistaken for a save it is not:
 *   complete     manifest.json present and valid: a save
 *   incomplete   no manifest.json: the save never finished; restore refuses it
 *   failed       `<stamp>.failed`: a save that failed, kept for inspection
 *   unreadable   a manifest.json that does not parse or match the schema
 * A directory that cannot be read fails the whole listing (exit 1): a listing
 * that silently left a folder out would read as "nothing saved there".
 */

import type {Destination} from './config';
import type {CommandIo} from './save';

import {lstatSync, readdirSync} from 'fs';
import {join} from 'path';

import {
  fieldLines,
  type OutputStyle,
  paint,
  sectionHeader,
  spacedList,
  stepColumn,
  wrapHanging,
} from '../cli-style';
import {describeDestinationSource, resolveDestination} from './config';
import {FAILED_SUFFIX, MANIFEST_FILE, readManifest} from './manifest';
import {formatBytes, formatCount, processIo} from './save';

export type SaveState = 'complete' | 'failed' | 'incomplete' | 'unreadable';

/** One stamp directory, as `list` reports it. */
export interface SaveListing {
  /** Base commit; null when there is no readable manifest. */
  baseCommit: string | null;
  /** null when there is no readable manifest, or HEAD was detached (see `state`). */
  branch: string | null;
  bytes: number | null;
  /** Absolute path of the stamp directory. */
  dir: string;
  /** Why the manifest could not be used (unreadable), else null. */
  error: string | null;
  files: number | null;
  repoFolder: string;
  /** From the manifest; null when there is none. */
  repoRoot: string | null;
  /** Whether the worktree still exists on disk; null when unknown (no manifest, or lstat failed). */
  sourceExists: boolean | null;
  stamp: string;
  state: SaveState;
  worktreeFolder: string;
  /** From the manifest; null when there is none. */
  worktreePath: string | null;
}

export type ListResult =
  | {error: string; ok: false}
  | {ok: true; outDirExists: boolean; saves: SaveListing[]};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): unknown {
  return error != null && typeof error === 'object' && 'code' in error
    ? (error as {code: unknown}).code
    : null;
}

/** Directory names in `dir`, or a failure. Files beside the saves are not saves. */
function subdirectories(dir: string): string[] {
  return readdirSync(dir, {withFileTypes: true})
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function sourceExists(path: string): boolean | null {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? false : null;
  }
}

function listingFor(
  dir: string,
  repoFolder: string,
  worktreeFolder: string,
  name: string,
): SaveListing {
  const blank = {
    baseCommit: null,
    branch: null,
    bytes: null,
    dir,
    error: null,
    files: null,
    repoFolder,
    repoRoot: null,
    sourceExists: null,
    worktreeFolder,
    worktreePath: null,
  };
  if (name.endsWith(FAILED_SUFFIX)) {
    return {
      ...blank,
      stamp: name.slice(0, -FAILED_SUFFIX.length),
      state: 'failed',
    };
  }
  const hasManifest = sourceExists(join(dir, MANIFEST_FILE));
  if (hasManifest === false) {
    return {...blank, stamp: name, state: 'incomplete'};
  }
  const manifest = readManifest(dir);
  if (!manifest.ok) {
    return {...blank, error: manifest.error, stamp: name, state: 'unreadable'};
  }
  return {
    baseCommit: manifest.value.head,
    branch: manifest.value.branch,
    bytes: manifest.value.totals.bytes,
    dir,
    error: null,
    files: manifest.value.totals.files,
    repoFolder,
    repoRoot: manifest.value.repoRoot,
    sourceExists: sourceExists(manifest.value.worktreePath),
    stamp: manifest.value.stamp,
    state: 'complete',
    worktreeFolder,
    worktreePath: manifest.value.worktreePath,
  };
}

/**
 * Every stamp directory under `outDir`. `repo` narrows to saves whose repo
 * folder (the repo's name) or whose manifest's repo root equals it.
 */
export function listSaves(outDir: string, repo: string | null): ListResult {
  try {
    lstatSync(outDir);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return {ok: true, outDirExists: false, saves: []};
    }
    return {error: `could not read ${outDir}: ${messageOf(error)}`, ok: false};
  }
  const saves: SaveListing[] = [];
  try {
    for (const repoFolder of subdirectories(outDir)) {
      for (const worktreeFolder of subdirectories(join(outDir, repoFolder))) {
        const parent = join(outDir, repoFolder, worktreeFolder);
        for (const name of subdirectories(parent)) {
          saves.push(
            listingFor(join(parent, name), repoFolder, worktreeFolder, name),
          );
        }
      }
    }
  } catch (error) {
    return {
      error: `could not read the saves under ${outDir}: ${messageOf(error)}`,
      ok: false,
    };
  }
  const filtered =
    repo == null
      ? saves
      : saves.filter(
          (save) => save.repoFolder === repo || save.repoRoot === repo,
        );
  return {ok: true, outDirExists: true, saves: filtered};
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

interface WorktreeGroup {
  label: string;
  saves: SaveListing[];
  sourceExists: boolean | null;
}

interface RepoGroup {
  label: string;
  worktrees: Map<string, WorktreeGroup>;
}

function groupSaves(saves: readonly SaveListing[]): Map<string, RepoGroup> {
  const repos = new Map<string, RepoGroup>();
  for (const save of saves) {
    const repoKey = save.repoRoot ?? `folder:${save.repoFolder}`;
    const repoLabel =
      save.repoRoot ??
      `${save.repoFolder}/ (repo root unknown: this folder has no readable manifest)`;
    let repoGroup = repos.get(repoKey);
    if (repoGroup == null) {
      repoGroup = {label: repoLabel, worktrees: new Map()};
      repos.set(repoKey, repoGroup);
    }
    const worktreeKey =
      save.worktreePath ?? `folder:${save.repoFolder}/${save.worktreeFolder}`;
    let worktreeGroup = repoGroup.worktrees.get(worktreeKey);
    if (worktreeGroup == null) {
      worktreeGroup = {
        label:
          save.worktreePath ??
          `${save.worktreeFolder}/ (worktree path unknown: no readable manifest)`,
        saves: [],
        sourceExists: save.sourceExists,
      };
      repoGroup.worktrees.set(worktreeKey, worktreeGroup);
    }
    worktreeGroup.saves.push(save);
  }
  return repos;
}

function stillOnDisk(value: boolean | null): string {
  if (value === true) return 'yes';
  if (value === false) return 'no: the worktree has been removed';
  return 'unknown';
}

function renderSave(save: SaveListing, style: OutputStyle): string {
  const options = {
    color: style.color,
    indent: stepColumn(2),
    width: style.width,
  };
  const head = wrapHanging(paint(save.stamp, ['bold'], style.color), {
    hang: stepColumn(1),
    indent: stepColumn(1),
    width: style.width,
  });
  switch (save.state) {
    case 'complete': {
      return [
        head,
        fieldLines(
          [
            // A complete listing always carries these (they come from its
            // manifest); "unknown" rather than 0 if that ever stops being true.
            {
              label: 'files',
              value:
                save.files == null
                  ? 'unknown'
                  : formatCount(save.files, 'file'),
            },
            {
              label: 'bytes',
              value: save.bytes == null ? 'unknown' : formatBytes(save.bytes),
            },
            {label: 'branch', value: save.branch ?? '(detached HEAD)'},
            {
              label: 'base commit',
              value:
                save.baseCommit == null
                  ? 'unknown'
                  : save.baseCommit.slice(0, 12),
            },
            {label: 'saved in', value: save.dir},
          ],
          options,
        ),
      ].join('\n');
    }
    case 'failed': {
      return [
        head,
        fieldLines(
          [
            {
              label: 'state',
              value: paint(
                'FAILED: not a save; kept for inspection',
                ['red'],
                style.color,
              ),
            },
            {label: 'saved in', value: save.dir},
          ],
          options,
        ),
      ].join('\n');
    }
    case 'incomplete': {
      return [
        head,
        fieldLines(
          [
            {
              label: 'state',
              value: paint(
                `INCOMPLETE: no ${MANIFEST_FILE}, so this is not a save and restore refuses it`,
                ['yellow'],
                style.color,
              ),
            },
            {label: 'saved in', value: save.dir},
          ],
          options,
        ),
      ].join('\n');
    }
    case 'unreadable': {
      return [
        head,
        fieldLines(
          [
            {
              label: 'state',
              value: paint(
                `UNREADABLE: ${save.error ?? 'manifest could not be used'}`,
                ['yellow'],
                style.color,
              ),
            },
            {label: 'saved in', value: save.dir},
          ],
          options,
        ),
      ].join('\n');
    }
  }
}

function savesSummary(result: Extract<ListResult, {ok: true}>): string {
  if (!result.outDirExists) return 'none: the destination does not exist yet';
  if (result.saves.length === 0) return 'none';
  const complete = result.saves.filter(
    (save) => save.state === 'complete',
  ).length;
  const others = result.saves.length - complete;
  const completeText = formatCount(complete, 'complete save');
  return others === 0
    ? completeText
    : `${completeText}, plus ${formatCount(others, 'stamp directory', 'stamp directories')} that ${others === 1 ? 'is' : 'are'} not a save (marked below)`;
}

export function renderList(
  result: Extract<ListResult, {ok: true}>,
  destination: Destination,
  style: OutputStyle,
): string {
  const header = spacedList([
    sectionHeader('Saved worktrees', {color: style.color, emoji: '💾'}),
    fieldLines(
      [
        {label: 'destination', value: destination.dir},
        {label: 'from', value: describeDestinationSource(destination)},
        {
          label: 'saves',
          value: savesSummary(result),
        },
      ],
      {color: style.color, indent: stepColumn(0), width: style.width},
    ),
  ]);
  const blocks = [header];
  for (const repo of groupSaves(result.saves).values()) {
    blocks.push(sectionHeader(repo.label, {color: style.color, emoji: '📁'}));
    for (const worktree of repo.worktrees.values()) {
      blocks.push(
        fieldLines(
          [
            {label: 'worktree', value: worktree.label},
            {label: 'still on disk', value: stillOnDisk(worktree.sourceExists)},
          ],
          {color: style.color, indent: stepColumn(0), width: style.width},
        ),
      );
      for (const save of worktree.saves) blocks.push(renderSave(save, style));
    }
  }
  return spacedList(blocks);
}

export interface ListCommandArgs {
  json: boolean;
  out: string | null;
  repo: string | null;
}

/** `worktree-salvage list`. Exit 0 with the listing; 1 when it could not be read. */
export async function runListCommand(
  args: ListCommandArgs,
  io: CommandIo = processIo(),
): Promise<number> {
  let destination: Destination;
  try {
    destination = resolveDestination(args.out, {cwd: io.cwd, env: io.env});
  } catch (error) {
    await io.stderr(`worktree-salvage list: ${messageOf(error)}\n`);
    return 1;
  }
  const result = listSaves(destination.dir, args.repo);
  if (!result.ok) {
    await io.stderr(`worktree-salvage list: ${result.error}\n`);
    return 1;
  }
  if (args.json) {
    await io.stdout(
      `${JSON.stringify(
        {
          destination,
          outDirExists: result.outDirExists,
          saves: result.saves,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  await io.stdout(`${renderList(result, destination, io.stdoutStyle)}\n`);
  return 0;
}
