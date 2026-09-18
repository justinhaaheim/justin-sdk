/**
 * Who am I, and where am I running from? (epic home-base-dchjw, decision D4.)
 *
 * Every SDK CLI answers `--version` with the SDK's OWN version and opens
 * `--help` with `<tool> vX.Y.Z · <absolute dir it runs from>`. Before this
 * existed, `cli.ts` never called yargs' `.version()`, so yargs guessed — and it
 * guesses from the package.json nearest its own hoisted install, which in a
 * consumer repo is THAT REPO's package.json. Measured 2026-09-16: `justin-sdk
 * --version` printed `0.5.0` in ~/Dev/prompts and `0.2.0` in home-base, neither
 * of which is a justin-sdk version. The path half of the header answers the
 * question the version alone cannot: WHICH copy is running — a pinned tarball in
 * node_modules, a bunx cache dir, or home-base/pkg/justin-sdk itself.
 *
 * Node builtins only, deliberately. `time-check` and `usage-check` run on a hook
 * path that pays for every module cli.ts imports eagerly, and this one is on it.
 */

import {existsSync, readFileSync} from 'fs';
import {resolve} from 'path';

/**
 * What `--version` and the help header print when the SDK cannot read its own
 * package.json. It is deliberately not semver-shaped: `0.0.0` was the previous
 * answer and it is a LIE — a version nothing is running, which then rendered as
 * real measurements like `justin-sdk 0.0.0 → 0.26.0 available (major)`
 * (home-base-uxwc.5 F10). Critical rule 6: a failed measurement must not be
 * representable as a normal value.
 */
export const UNKNOWN_VERSION = 'version unknown';

/**
 * The version in one specific package.json, or `null` for every way that can
 * fail: absent file, unreadable file, malformed JSON, no `version` key, a
 * `version` that is not a non-empty string.
 *
 * Split out from `getSdkVersion` purely so the FAILURE path has a real test.
 * The alternative was a by-construction claim, and "null on failure" is exactly
 * the kind of assertion that quietly stops being true.
 */
export function readSdkVersionFrom(pkgJsonPath: string): string | null {
  if (!existsSync(pkgJsonPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')) as {
      version?: unknown;
    };
    return typeof pkg.version === 'string' && pkg.version.length > 0
      ? pkg.version
      : null;
  } catch {
    return null;
  }
}

/**
 * The SDK's own package.json version, or `null` when it cannot be read.
 *
 * `null` is load-bearing: it is produced ONLY on failure, and every caller that
 * writes a version somewhere durable (a `#vX.Y.Z` pin, a config stamp) must
 * refuse rather than substitute. TypeScript will not catch a `${sdkVersion}`
 * template interpolation of null, so those call sites are guarded by hand.
 */
export function getSdkVersion(): string | null {
  return readSdkVersionFrom(resolve(import.meta.dirname, '..', 'package.json'));
}

/** The header line, given an already-measured version. Pure; see helpHeader. */
export function formatHelpHeader(
  toolName: string,
  version: string | null,
  sourceDir: string,
): string {
  const shown = version == null ? UNKNOWN_VERSION : `v${version}`;
  return `${toolName} ${shown} · ${sourceDir}`;
}

/**
 * The first line of any SDK CLI's `--help`.
 *
 * @param toolName the bin's name, e.g. `justin-sdk` or `repo-status`.
 * @param sourceDir pass `import.meta.dirname` from the CLI's entry file — that
 *   is literally where the running code lives, which is the whole point.
 */
export function helpHeader(toolName: string, sourceDir: string): string {
  return formatHelpHeader(toolName, getSdkVersion(), sourceDir);
}

/**
 * A yargs `.wrap()` width that never breaks the help header.
 *
 * Measured 2026-09-18 (yargs 18, bun 1.4.2): yargs' default width is
 * `min(80, stdout.columns)`, and piped — which is how every test and every
 * `| head -1` reads it — `columns` is undefined, so it is 80. cliui then
 * HARD-BREAKS a 105-character header mid-word, and `--help`'s first line becomes
 * `…/sdk-course-corr`. Widening to exactly the header's length keeps today's
 * layout everywhere the header already fits (the installed case is ~65 chars)
 * and only stretches the columns when the path is genuinely long.
 *
 * `.wrap(null)` also fixes the header, and was rejected: it unwraps every
 * command description too, so a long `describe` runs off the screen.
 */
export function helpWrapWidth(header: string, preferred: number): number {
  return Math.max(header.length, preferred);
}
