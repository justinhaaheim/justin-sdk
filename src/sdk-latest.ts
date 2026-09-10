/**
 * sdk-latest.ts — "what is the newest justin-sdk tag?", asked once, in one place
 * (home-base-uxwc D3).
 *
 * The answer comes from `git ls-remote --tags` against the PUBLIC SDK repo:
 * ~0.36s measured, no `gh`, no auth, no rate limit, and no dependency on a tool
 * that may not be installed. The old `gh api repos/.../tags` path this replaces
 * needed all three, and `justin-sdk update` degraded to "could not query" on any
 * machine without a logged-in `gh`.
 *
 * TWO callers share this: `justin-sdk update` (self-update.ts) and the health
 * notices probe (health-notices.ts). One implementation, so a fix to the parse
 * or the timeout cannot land in only one of them.
 *
 * FAILURE IS NEVER AN EMPTY ANSWER (critical rule 6): a timeout, a missing
 * `git`, a non-zero exit and "the repo has no semver tag" are four distinct
 * facts and all four come back as `{status: 'failed', error}` naming which one
 * happened. Nothing here ever returns "no newer version" for a check that did
 * not run — that is the reassuring direction, and it is the dangerous one.
 */

import {execFileSync} from 'child_process';

/** The public SDK repo. Cloneable and listable without credentials. */
export const SDK_REPO_URL = 'https://github.com/justinhaaheim/justin-sdk';

/**
 * Hard kill for the remote listing. The measured call is ~0.36s; 5s is
 * generous enough that a slow network still answers, and short enough that a
 * hung DNS lookup never becomes a hung shell command.
 */
export const DEFAULT_FETCH_TIMEOUT_MS = 5000;

const TAG_REF_PREFIX = 'refs/tags/';

/**
 * The outcome of asking for the newest tag.
 *
 * `tag` is the RAW ref name (so a `v`-prefixed tag keeps its `v` and can be
 * installed against); `version` is the same thing normalised for comparison
 * and display (`v0.26.0` → `0.26.0`).
 */
export type LatestTagOutcome =
  | {error: string; status: 'failed'}
  | {status: 'ok'; tag: string; version: string};

/** How the health-notices probe asks for a tag, so tests can inject a fake. */
export type SdkTagFetcher = (options: {timeoutMs: number}) => LatestTagOutcome;

/**
 * Parse a tag/version into [major, minor, patch], tolerating an optional
 * leading "v" (so both `0.6.1` and `v0.6.0` parse). Returns null if the
 * string doesn't start with an X.Y.Z triple.
 */
export function parseSdkVersion(tag: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(tag.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Compare two parsed versions: >0 if a is newer, <0 if older, 0 if equal. */
export function compareSdkVersions(
  a: [number, number, number],
  b: [number, number, number],
): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * A tag that names a RELEASE: an X.Y.Z triple and nothing else after it.
 *
 * `v0.26.0-rc.1` and `0.26.0+build` are deliberately excluded (uxwc.5 F5).
 * Prereleases are out of scope for the fleet, and the comparison here only
 * reads the triple — so an rc tag compared EQUAL to its release and then won
 * the `v`-prefix tie-break, making `justin-sdk update` install a candidate
 * over the real thing.
 */
const RELEASE_TAG_PATTERN = /^v?\d+\.\d+\.\d+$/;

/**
 * Pick the highest-semver tag from a list of raw tag names, returning the
 * RAW name (the git ref we install against, so a `v`-prefixed tag keeps its
 * `v`). Names that are not plain releases are ignored; returns null if none
 * qualify.
 *
 * We sort ourselves rather than trusting the listing's order: `git ls-remote`
 * sorts refs LEXICALLY, which puts `refs/tags/0.15.0` before `refs/tags/0.2.0`
 * and every `v`-prefixed tag after every bare one.
 *
 * TIES PREFER THE `v`-PREFIXED SPELLING (home-base-j2n7.4 / v170.15): the
 * repo has carried BOTH `0.14.0` and `v0.14.0` pointing at DIFFERENT commits,
 * so a tie broken by input order made which TREE a fleet bump landed on
 * depend on the listing's ordering — silently. v-prefixed is the sweep-guard
 * convention; deterministic beats lucky.
 */
export function pickLatestTag(tagNames: string[]): string | null {
  let best: {name: string; version: [number, number, number]} | null = null;
  for (const name of tagNames) {
    if (!RELEASE_TAG_PATTERN.test(name.trim())) continue;
    const version = parseSdkVersion(name);
    if (version == null) continue;
    if (best == null || compareSdkVersions(version, best.version) > 0) {
      best = {name, version};
    } else if (
      compareSdkVersions(version, best.version) === 0 &&
      name.startsWith('v') &&
      !best.name.startsWith('v')
    ) {
      best = {name, version};
    }
  }
  return best?.name ?? null;
}

/**
 * Tag names out of a `git ls-remote --tags` listing.
 *
 * Each line is `<sha>\t<ref>`. An ANNOTATED tag contributes TWO lines — the tag
 * object and a PEELED one whose ref ends in `^{}` naming the commit it points
 * at. The peeled line is dropped: it is the same tag name a second time, and
 * keeping it would double every annotated tag in the list. A lightweight tag
 * has no peeled line, so nothing is ever lost by dropping them.
 */
export function parseLsRemoteTags(stdout: string): string[] {
  const names: string[] = [];
  for (const line of stdout.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const ref = line.slice(tab + 1).trim();
    if (!ref.startsWith(TAG_REF_PREFIX)) continue;
    if (ref.endsWith('^{}')) continue;
    const name = ref.slice(TAG_REF_PREFIX.length);
    if (name.length > 0) names.push(name);
  }
  return names;
}

/** Strip a tag's leading `v` for comparison and display. */
export function tagToVersion(tag: string): string {
  return tag.startsWith('v') ? tag.slice(1) : tag;
}

/**
 * The pure half of `fetchLatestSdkTag`: a listing in, an outcome out. Split out
 * so the parse and the "no usable tag" verdict are testable without a network
 * call — the suite must never reach GitHub.
 */
export function latestTagFromLsRemote(stdout: string): LatestTagOutcome {
  const names = parseLsRemoteTags(stdout);
  const tag = pickLatestTag(names);
  if (tag == null) {
    return {
      error: `no semver tag among ${names.length} tag ref(s) at ${SDK_REPO_URL}`,
      status: 'failed',
    };
  }
  return {status: 'ok', tag, version: tagToVersion(tag)};
}

function errorField(error: unknown, field: string): unknown {
  if (error == null || typeof error !== 'object') return undefined;
  return (error as Record<string, unknown>)[field];
}

/**
 * Name what went wrong precisely enough to act on. `execFileSync` reports a
 * timeout as a SIGTERM kill (with `code: 'ETIMEDOUT'` on most platforms), a
 * missing binary as ENOENT, and a git failure as a numeric `status` — three
 * different problems with three different fixes, so they get three messages.
 */
export function describeFetchFailure(
  error: unknown,
  timeoutMs: number,
): string {
  const code = errorField(error, 'code');
  const signal = errorField(error, 'signal');
  if (code === 'ETIMEDOUT' || signal === 'SIGTERM') {
    return `git ls-remote timed out after ${timeoutMs}ms`;
  }
  if (code === 'ENOENT') return 'git is not on PATH';
  const status = errorField(error, 'status');
  if (typeof status === 'number') {
    const stderr = errorField(error, 'stderr');
    const detail =
      typeof stderr === 'string' && stderr.trim().length > 0
        ? `: ${stderr.trim().split('\n')[0]}`
        : '';
    return `git ls-remote exited ${status}${detail}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Ask the SDK repo for its newest tag. Never throws.
 *
 * `execFileSync` (not a shell string) so the URL cannot be re-parsed by a
 * shell, and so `timeout` is a real kill rather than an advisory deadline.
 * `GIT_TERMINAL_PROMPT=0` because a credential prompt on a pipe is how a
 * "fast" command becomes a hung one — the repo is public, so being asked at
 * all means something is wrong and failing is the right answer.
 */
export function fetchLatestSdkTag(
  options: {timeoutMs?: number} = {},
): LatestTagOutcome {
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  let stdout: string;
  try {
    stdout = execFileSync('git', ['ls-remote', '--tags', SDK_REPO_URL], {
      encoding: 'utf-8',
      env: {...process.env, GIT_TERMINAL_PROMPT: '0'},
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
  } catch (error) {
    return {error: describeFetchFailure(error, timeoutMs), status: 'failed'};
  }
  return latestTagFromLsRemote(stdout);
}
