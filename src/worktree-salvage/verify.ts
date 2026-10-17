/**
 * Does a checkout still match its save? (epic home-base-us739, fix round F2,
 * home-base-us739.6.)
 *
 * reclaim saves every git checkout inside a target at inspect time and deletes
 * the target at run time, possibly days later. A file modified or added in
 * between is not in the save, and reclaim's own changes-since-inspection walk
 * is capped, so it may never reach it. `checkoutMatchesSave` is the run-time
 * re-check: it compares the live checkout with the manifest and lists every
 * difference, so the caller can hold the deletion.
 *
 * PURE READ (D6). Every git call goes through status.ts's read-only runner;
 * every file is opened read-only with O_NOFOLLOW (sha256OfFile) or read with
 * readlink. Nothing is written, in the checkout or in the archive.
 *
 * A CHECK THAT CANNOT BE MADE IS NOT A MATCH (critical rule 7). A git read that
 * fails is `{ok: false, error}`; a file that cannot be read is a difference.
 * Only `{ok: true, value: {matches: true}}` says "the save still holds
 * everything", and only after every comparison below was actually made.
 */

import type {Manifest, ManifestEntry} from './manifest';
import type {Measured, StatusEntry} from './status';

import {readlinkSync, realpathSync} from 'fs';
import {join} from 'path';

import {sha256OfFile} from './save';
import {readHead, readStatus, runGit} from './status';

/** How many differences a result names; the rest are counted. */
export const MISMATCH_REASON_CAP = 20;

export type SaveMatch = {matches: false; reasons: string[]} | {matches: true};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * What git's status says about one path, as one comparable string: the status
 * letters, the rename source, and the HEAD and index blob ids. The blob ids
 * catch a change the letters cannot show, such as a file staged again
 * (`git add -p`) whose letters stay `MM`.
 */
function statusKey(entry: {
  headBlob: string | null;
  indexBlob: string | null;
  origPath: string | null;
  status: string;
}): string {
  return [
    entry.status,
    entry.origPath ?? '',
    entry.headBlob ?? '',
    entry.indexBlob ?? '',
  ].join('\0');
}

function realOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** The status comparison: every live entry is in the save, and every saved entry is still live. */
function statusDifferences(
  manifest: Manifest,
  live: readonly StatusEntry[],
): string[] {
  // A `!!` entry is an ignored file copied with --ignored; the status read
  // lists no ignored files, so those are checked by their hash alone.
  const saved = new Map(
    manifest.entries
      .filter((entry) => entry.kind !== 'ignored')
      .map((entry) => [entry.path, entry]),
  );
  const reasons: string[] = [];
  const livePaths = new Set<string>();
  for (const entry of live) {
    livePaths.add(entry.path);
    const before = saved.get(entry.path);
    if (before == null) {
      reasons.push(
        `${entry.path} (${entry.status}) is new since the save, so the save does not hold it`,
      );
    } else if (statusKey(before) !== statusKey(entry)) {
      reasons.push(
        before.status === entry.status
          ? `${entry.path}: its staged version changed since the save`
          : `${entry.path}: git status was ${before.status} at the save and is ${entry.status} now`,
      );
    }
  }
  for (const [path, entry] of saved) {
    if (!livePaths.has(path)) {
      reasons.push(
        `${path} (${entry.status} at the save) no longer shows as changed, so the checkout is not what was saved`,
      );
    }
  }
  return reasons;
}

/** The content comparison for one copied entry: null when the live file is what was saved. */
function contentDifference(root: string, entry: ManifestEntry): string | null {
  const source = join(root, entry.path);
  if (entry.symlinkTarget != null) {
    let now: string;
    try {
      now = readlinkSync(source);
    } catch (error) {
      return `${entry.path}: could not read the symlink to compare it with the save (${messageOf(error)})`;
    }
    return now === entry.symlinkTarget
      ? null
      : `${entry.path}: the symlink points elsewhere than when it was saved`;
  }
  if (entry.sha256 == null) {
    return `${entry.path}: the save recorded no sha256 for it, so it cannot be compared`;
  }
  let now: string;
  try {
    now = sha256OfFile(source);
  } catch (error) {
    return `${entry.path}: could not read it to compare it with the save (${messageOf(error)})`;
  }
  return now === entry.sha256
    ? null
    : `${entry.path}: its content changed since the save`;
}

function capped(reasons: readonly string[]): string[] {
  if (reasons.length <= MISMATCH_REASON_CAP) return [...reasons];
  const rest = reasons.length - MISMATCH_REASON_CAP;
  return [
    ...reasons.slice(0, MISMATCH_REASON_CAP),
    `and ${String(rest)} more ${rest === 1 ? 'difference' : 'differences'}`,
  ];
}

/**
 * Compare the checkout at `checkoutPath` with the save `manifest` describes:
 *
 *   - git's top level for `checkoutPath` is that directory, and is the one the
 *     save was taken of;
 *   - every live status entry (path, letters, rename source, blob ids) is in
 *     the manifest, and every manifest entry is still live;
 *   - every copied file is re-hashed (a symlink: its target re-read) and must
 *     equal the manifest's sha256;
 *   - HEAD is the manifest's `head`.
 *
 * A git read that fails returns `{ok: false}`. Every difference is a reason
 * naming its path, capped at MISMATCH_REASON_CAP plus a count of the rest.
 */
export function checkoutMatchesSave(
  manifest: Manifest,
  checkoutPath: string,
): Measured<SaveMatch> {
  const toplevel = runGit(checkoutPath, ['rev-parse', '--show-toplevel']);
  if (!toplevel.ok) return toplevel;
  const root = toplevel.value.trim();
  const reasons: string[] = [];
  const realRoot = realOrNull(root);
  const realCheckout = realOrNull(checkoutPath);
  if (realRoot == null || realRoot !== realCheckout) {
    return {
      error: `git's top level for ${checkoutPath} is ${root}, not the directory itself`,
      ok: false,
    };
  }
  if (realOrNull(manifest.worktreePath) !== realRoot) {
    reasons.push(
      `the save is of ${manifest.worktreePath}, not of ${checkoutPath}`,
    );
  }

  const status = readStatus(root);
  if (!status.ok) return status;
  reasons.push(...statusDifferences(manifest, status.value.parsed.entries));

  for (const entry of manifest.entries) {
    if (!entry.copied) continue;
    const difference = contentDifference(root, entry);
    if (difference != null) reasons.push(difference);
  }

  const head = readHead(root);
  if (!head.ok) return head;
  if (head.value !== manifest.head) {
    reasons.push(
      `HEAD moved since the save (${manifest.head.slice(0, 12)} → ${head.value.slice(0, 12)})`,
    );
  }

  return reasons.length === 0
    ? {ok: true, value: {matches: true}}
    : {ok: true, value: {matches: false, reasons: capped(reasons)}};
}
