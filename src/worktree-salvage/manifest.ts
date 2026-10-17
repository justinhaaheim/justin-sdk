/**
 * The worktree-salvage manifest (epic home-base-us739, D3).
 *
 * A save is `<outDir>/<repo name>/<worktree dir name>/<stamp>/` holding
 * `files/<path>`, `changes.patch` and `manifest.json`. The manifest is written
 * LAST, so its presence is the claim "this save is complete and verified". A
 * stamp directory without one is an incomplete save: `list` says so and
 * restore refuses it. A failed save is renamed `<stamp>.failed`.
 *
 * Inside a manifest, `null` always means ABSENT (a deletion has no bytes, an
 * untracked file has no HEAD blob). It never means "could not be measured": a
 * save whose measurement failed writes no manifest at all. The informational
 * fields that may legitimately be unknown (upstream, commits not on the default
 * branch, an ignored path's size) say so through `{ok: false, error}`.
 */

import {readFileSync, renameSync, writeFileSync} from 'fs';
import {join} from 'path';
import {z} from 'zod';

export const MANIFEST_FILE = 'manifest.json';
export const FILES_DIR = 'files';
export const PATCH_FILE = 'changes.patch';
/** Index-only versions (D2's addition): `index/<path>`, `index/<path>.stage<N>`. */
export const INDEX_DIR = 'index';
/** Written into a `<stamp>.failed` directory: why the save failed. */
export const FAILURE_FILE = 'FAILED.txt';
export const FAILED_SUFFIX = '.failed';
export const MANIFEST_SCHEMA_VERSION = 1;

function measured<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion('ok', [
    z.object({error: z.string(), ok: z.literal(false)}),
    z.object({ok: z.literal(true), value}),
  ]);
}

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const Oid = z.string().regex(/^[0-9a-f]{40,64}$/u);

/** The size of an ignored path, or why it could not be measured. */
export const SizeSchema = measured(
  z.object({
    bytes: z.number().int().nonnegative(),
    files: z.number().int().nonnegative(),
  }),
);
export type Size = z.infer<typeof SizeSchema>;

export const EntrySchema = z.object({
  /** Bytes copied (a symlink: its target's length); null when not copied. */
  bytes: z.number().int().nonnegative().nullable(),
  /** True when this entry's file is under `files/`. */
  copied: z.boolean(),
  /** HEAD's blob: for a deletion, the base content git still has. */
  headBlob: Oid.nullable(),
  indexBlob: Oid.nullable(),
  kind: z.enum([
    'added',
    'copied',
    'deleted',
    'ignored',
    'modified',
    'renamed',
    'type-changed',
    'unmerged',
    'untracked',
  ]),
  /** Permission bits as four octal digits, e.g. "0755"; null when not copied. */
  mode: z
    .string()
    .regex(/^[0-7]{4}$/u)
    .nullable(),
  /** The path a rename or copy came from (git still has it at the base commit). */
  origPath: z.string().nullable(),
  /** Relative to the checkout root, and to `files/`. */
  path: z.string().min(1),
  /** sha256 of the bytes copied (a symlink: of its target string). */
  sha256: Sha256.nullable(),
  /** git's two status letters: `.M`, `R.`, `UU`, `??`; `!!` for an ignored file copied with --ignored. */
  status: z.string().min(1),
  /** A symlink's target, copied as a symlink and never followed. */
  symlinkTarget: z.string().nullable(),
});
export type ManifestEntry = z.infer<typeof EntrySchema>;

/**
 * A version of a file that exists ONLY in the index (D2's addition, home-base-
 * us739.2): staged and then edited again (`MM`), staged and then deleted from
 * disk (`AD`, `MD`), or one stage of a conflict. Once the worktree is removed
 * its blob is unreachable, so the save writes it to `index/<file>`.
 */
export const IndexEntrySchema = z.object({
  /** Bytes written; equal to `git cat-file -s` of the blob. */
  bytes: z.number().int().nonnegative(),
  /** Relative to `index/`: the path, plus `.stage<N>` for a conflict stage. */
  file: z.string().min(1),
  /** The blob git holds in the index for this path (or this stage). */
  indexBlob: Oid,
  /** The checkout path this version belongs to. */
  path: z.string().min(1),
  /** sha256 of the bytes written. */
  sha256: Sha256,
  /** 1 base, 2 ours, 3 theirs for a conflict; null for an ordinary staged version. */
  stage: z.number().int().min(1).max(3).nullable(),
});
export type IndexEntry = z.infer<typeof IndexEntrySchema>;

export const NestedCheckoutSchema = z.object({
  /** Where it was found: the status listing, or a walk of an ignored path. */
  foundIn: z.enum(['ignored', 'status']),
  kind: z.enum(['nested-repository', 'submodule']),
  path: z.string().min(1),
  submoduleState: z.string().nullable(),
});
export type ManifestNestedCheckout = z.infer<typeof NestedCheckoutSchema>;

export const IgnoredPathSchema = z.object({
  /** As git matched it; a directory keeps its trailing `/`. */
  path: z.string().min(1),
  /** True when its files were copied (`--ignored`). */
  saved: z.boolean(),
  /** Files and bytes under it, EXCLUDING what `skipped` lists. */
  size: SizeSchema,
});
export type IgnoredPath = z.infer<typeof IgnoredPathSchema>;

export const SkippedPathSchema = z.object({
  path: z.string().min(1),
  /** Never copied, even with `--ignored`. */
  reason: z.enum(['.git', 'node_modules']),
  size: SizeSchema,
});
export type SkippedPath = z.infer<typeof SkippedPathSchema>;

export const ManifestSchema = z.object({
  branch: z.string().nullable(),
  commitsNotOnDefault: measured(
    z.object({
      commits: z.array(z.object({sha: z.string(), subject: z.string()})),
      defaultBranch: z.string(),
      total: z.number().int().nonnegative(),
    }),
  ),
  destination: z.object({
    configFile: z.string(),
    dir: z.string(),
    source: z.enum(['config', 'fallback', 'flag']),
  }),
  entries: z.array(EntrySchema),
  /** The commit every change here is relative to. */
  head: Oid,
  ignored: z.object({
    /** Whether `--ignored` was passed. */
    copied: z.boolean(),
    paths: z.array(IgnoredPathSchema),
    skipped: z.array(SkippedPathSchema),
  }),
  /**
   * Index-only versions under `index/`. Defaults to empty so a manifest written
   * before this field existed (dispatch 1) still reads; such a save predates
   * index copies, it does not claim there were none to make.
   */
  indexEntries: z.array(IndexEntrySchema).default([]),
  nestedCheckouts: z.array(NestedCheckoutSchema),
  patch: z.object({
    bytes: z.number().int().nonnegative(),
    file: z.literal(PATCH_FILE),
    sha256: Sha256,
  }),
  repoName: z.string().min(1),
  repoRoot: z.string().min(1),
  savedAt: z.string().min(1),
  schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION),
  sdkVersion: z.string().nullable(),
  stamp: z.string().min(1),
  tool: z.literal('worktree-salvage'),
  totals: z.object({
    bytes: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    files: z.number().int().nonnegative(),
  }),
  upstream: measured(z.string().nullable()),
  worktreeName: z.string().min(1),
  worktreePath: z.string().min(1),
});
export type Manifest = z.infer<typeof ManifestSchema>;

/**
 * Write the manifest into `stampDir`: to a temporary name first, then renamed,
 * so a crash mid-write never leaves a truncated `manifest.json` that would read
 * as a complete save.
 */
export function writeManifest(stampDir: string, manifest: Manifest): void {
  const checked = ManifestSchema.parse(manifest);
  const target = join(stampDir, MANIFEST_FILE);
  const temporary = `${target}.partial`;
  writeFileSync(temporary, `${JSON.stringify(checked, null, 2)}\n`, {
    flag: 'wx',
  });
  renameSync(temporary, target);
}

/** Read and validate `<stampDir>/manifest.json`. Never throws. */
export function readManifest(
  stampDir: string,
): {error: string; ok: false} | {ok: true; value: Manifest} {
  let text: string;
  try {
    text = readFileSync(join(stampDir, MANIFEST_FILE), 'utf-8');
  } catch (error) {
    return {
      error: `could not read ${MANIFEST_FILE}: ${error instanceof Error ? error.message : String(error)}`,
      ok: false,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      error: `${MANIFEST_FILE} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      ok: false,
    };
  }
  const checked = ManifestSchema.safeParse(parsed);
  if (!checked.success) {
    return {
      error: `${MANIFEST_FILE} does not match the schema: ${checked.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
      ok: false,
    };
  }
  return {ok: true, value: checked.data};
}
