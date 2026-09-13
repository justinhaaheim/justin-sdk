/**
 * WHERE THE SWEEP'S OWN CODE CAME FROM (home-base-ovzv).
 *
 * MEASURED HAZARD, 2026-09-12: `bun run sdk-sweep` is
 * `bunx @justinhaaheim/justin-sdk sweep`, and from any home-base checkout bunx
 * resolves the workspace link `home-base/node_modules/.bin/justin-sdk` →
 * `projects/justin-sdk/src/cli.ts` — the PRIMARY submodule checkout's WORKING
 * TREE, the same target as the `bin/justin-sdk` PATH symlink. That day the
 * primary sat on branch `thread-followups` (a live session's branch) while the
 * fleet was swept twice, and `justin-sdk --version` printed `0.1.0` (yargs'
 * guess, read from home-base's own package.json), so nothing on screen said
 * which code had just been propagated to ~12 repos.
 *
 * This module answers "what code is this?" as ONE PURE FUNCTION over injected
 * git output (`describeSweepSource`), with a thin impure reader beside it. The
 * verdict is what `runSweep` prints in its header and gates on.
 *
 * DIRECTION OF THE CAUTIOUS VERDICT (critical rule 6): every failed or
 * unavailable measurement lands on `unreleased` — the verdict that REFUSES —
 * never on `tag` or `packaged`, which proceed. A git command that could not run
 * must never read as "this is a released build".
 */

import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {join, resolve} from 'node:path';

/**
 * The provenance of the justin-sdk code that is currently executing.
 *
 *  - `tag`        — a git checkout sitting exactly at a tag, clean. The released
 *                   thing; its tag names it.
 *  - `unreleased` — a git checkout that is NOT exactly a clean tagged commit: on
 *                   a branch, detached without a tag, dirty (even at a tag — the
 *                   running code is then not the tagged code), or one whose git
 *                   probes could not be measured at all.
 *  - `packaged`   — no git checkout at all: a bunx cache copy or an installed
 *                   `node_modules` copy. Its pin IS its provenance, so there is
 *                   nothing further to measure.
 *
 * `sha` and `dirty` are nullable on `unreleased` ONLY because the git probe can
 * fail: a null there means "could not measure", never "clean" or "no commit".
 */
export type SweepSource =
  | {kind: 'tag'; sha: string; tag: string}
  | {
      branch: string | null;
      dirty: boolean | null;
      kind: 'unreleased';
      sha: string | null;
    }
  | {kind: 'packaged'};

/** The raw git measurements `describeSweepSource` reasons over. */
export interface SweepSourceInputs {
  /**
   * `git symbolic-ref --quiet --short HEAD` — the current branch. `null` for a
   * detached HEAD AND for a failed probe; both are already non-released, so the
   * conflation cannot move the verdict toward the reassuring answer.
   */
  branch: string | null;
  /**
   * Does the SDK's own package root carry a `.git` entry of EITHER kind? A
   * submodule checkout has a `.git` FILE (a gitdir pointer), not a directory,
   * so `statSync().isDirectory()` would misread the primary checkout — the one
   * this whole module exists to describe — as a packaged install.
   */
  hasGitEntry: boolean;
  /** `git rev-parse HEAD`, or `null` when the command failed. */
  headSha: string | null;
  /**
   * `git status --porcelain` VERBATIM, or `null` when the command failed.
   * Distinct from `''`, which means "measured, and the tree is clean".
   */
  porcelain: string | null;
  /**
   * `git tag --points-at HEAD` — newline-separated, `''` when HEAD carries no
   * tag, `null` when the command failed.
   *
   * `--points-at` rather than the `git describe --exact-match --tags HEAD` of
   * the original sketch: describe returns ONE tag and picks it itself, so the
   * v-prefix tie-break below would have nothing to break the tie over.
   */
  tagsAtHead: string | null;
}

/**
 * Prefer a `v`-prefixed version tag when several point at HEAD — the repo
 * carries both `0.14.0` and `v0.14.0` shapes and `pickLatestTag` is already
 * documented as nondeterministic across that pair (justin-sdk CLAUDE.md). Ties
 * within either group break by sort order, so the answer is at least stable.
 */
function pickHeadTag(tagsAtHead: string | null): string | null {
  if (tagsAtHead == null) return null;
  const tags = tagsAtHead
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .sort();
  return tags.find((tag) => /^v\d/.test(tag)) ?? tags[0] ?? null;
}

/** Pure: the provenance verdict for one set of measurements. */
export function describeSweepSource(inputs: SweepSourceInputs): SweepSource {
  if (!inputs.hasGitEntry) return {kind: 'packaged'};

  const dirty =
    inputs.porcelain == null ? null : inputs.porcelain.trim() !== '';
  const tag = pickHeadTag(inputs.tagsAtHead);

  // `tag` requires all three: a tag at HEAD, a readable sha, and a tree MEASURED
  // clean. A dirty tagged checkout is `unreleased` on purpose — the bytes about
  // to be propagated are not the bytes the tag names, and the union has no way
  // to say "tag, but modified", so saying "tag" would hide the modification.
  if (tag != null && inputs.headSha != null && dirty === false) {
    return {kind: 'tag', sha: inputs.headSha, tag};
  }
  return {
    branch: inputs.branch,
    dirty,
    kind: 'unreleased',
    sha: inputs.headSha,
  };
}

/** The parenthetical the sweep header (and its refusal) names the source by. */
export function formatSweepSource(source: SweepSource): string {
  if (source.kind === 'packaged') return 'packaged';
  if (source.kind === 'tag') return source.tag;
  const where =
    source.branch == null ? 'detached HEAD' : `branch ${source.branch}`;
  const sha = source.sha == null ? 'sha unknown' : source.sha.slice(0, 7);
  const dirty =
    source.dirty == null ? ', dirty unknown' : source.dirty ? ', dirty' : '';
  return `UNRELEASED: ${where} @ ${sha}${dirty}`;
}

// ---------------------------------------------------------------------------
// The impure half: measuring this SDK's own package root
// ---------------------------------------------------------------------------

/** This file lives in `<sdk root>/src`, so the root is one level up. */
export function sdkPackageRoot(): string {
  return resolve(import.meta.dirname, '..');
}

function gitOut(root: string, argv: string[]): string | null {
  try {
    return execFileSync('git', ['-C', root, ...argv], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}

/**
 * Measure one package root.
 *
 * THE `.git` CHECK COMES FIRST AND SHORT-CIRCUITS, deliberately: `git -C` walks
 * UP from its argument, so an installed copy under a consumer repo's
 * `node_modules` would otherwise report THAT REPO's tag, branch and cleanliness
 * as the SDK's own — a consumer sitting on a release tag would make unreleased
 * SDK code read as released, which is the reassuring direction.
 */
export function readSweepSourceInputs(root: string): SweepSourceInputs {
  if (!existsSync(join(root, '.git'))) {
    return {
      branch: null,
      hasGitEntry: false,
      headSha: null,
      porcelain: null,
      tagsAtHead: null,
    };
  }
  return {
    branch:
      gitOut(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])?.trim() ??
      null,
    hasGitEntry: true,
    headSha: gitOut(root, ['rev-parse', 'HEAD'])?.trim() ?? null,
    porcelain: gitOut(root, ['status', '--porcelain']),
    tagsAtHead: gitOut(root, ['tag', '--points-at', 'HEAD']),
  };
}

/** Measure and judge the running SDK. */
export function resolveSweepSource(
  root: string = sdkPackageRoot(),
): SweepSource {
  return describeSweepSource(readSweepSourceInputs(root));
}
