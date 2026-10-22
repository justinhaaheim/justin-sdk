/**
 * mac-build-config.ts — the per-repo settings `justin-sdk mac-build` reads:
 * `componentConfig["mac-build"]` in the repo's own justin-sdk.config.json
 * (home-base-0jeya.1).
 *
 *   "mac-build": {
 *     "variant": "preview",                         // APP_VARIANT to prebuild and build
 *     "scheme": "NatureSoundsPreview",              // the workspace / scheme Expo generates for it
 *     "bundleId": "com.jhaa.naturesounds.preview",  // the only app the install step copies or replaces
 *     "configuration": "Release"                    // optional; see defaultConfiguration
 *   }
 *
 * WHY THE SCHEME AND BUNDLE ID ARE WRITTEN DOWN, NOT INFERRED. ios/ is routinely
 * prebuilt for a different variant (the simulator loop and Detox keep it on
 * development), so "whichever workspace is in ios/" — audio-journal-1's old rule
 * — silently builds and launches the wrong app. The scheme is asserted against
 * the workspace on disk after the prebuild, and the bundle id against the app
 * Xcode installed, so a stale value fails loudly instead of building something
 * else. Only the project file is read: which app a repo builds for the Mac is a
 * fact about that repo, never a machine-wide setting.
 *
 * Every value is restricted to a safe character set because each is used
 * somewhere a stray character would change meaning: the variant is written into
 * ios/.xcode.env.local, which Xcode's build phases `source` as shell; the scheme
 * becomes a path, a `pgrep -f` regular expression and an AppleScript string; the
 * bundle id is compared against Info.plist values.
 *
 * A LEAF on purpose: node builtins only. prime.ts reads `hasMacBuildConfig` as
 * the component's `includeIf` predicate, and prime.ts is in cli-main's static
 * import graph, where zod must not be reachable (tests/health-notices-cli.test.ts).
 */

import {readFileSync} from 'fs';
import {join} from 'path';

export const MAC_BUILD_CONFIG_KEY = 'mac-build';

export type MacBuildConfiguration = 'Debug' | 'Release';

export interface MacBuildConfig {
  readonly bundleId: string;
  readonly configuration: MacBuildConfiguration;
  /** Whether `configuration` was set in the file or derived from the variant. */
  readonly configurationSource: 'config' | 'default';
  readonly scheme: string;
  readonly variant: string;
}

/**
 * FOUR outcomes (critical rule 7): no block, a block that reads, a block that
 * does not, and a config file that could not be read at all. None of the
 * failures is ever represented as "no block".
 */
export type MacBuildConfigRead =
  | {config: MacBuildConfig; path: string; status: 'ok'}
  | {path: string; status: 'absent'}
  | {path: string; reason: string; status: 'invalid'}
  | {path: string; reason: string; status: 'unreadable'};

const VARIANT_PATTERN = /^[a-z][a-z0-9-]*$/;
const SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;
const BUNDLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

/**
 * Debug for `development`, Release for every other variant.
 *
 * Release is what makes a build "not a development build": Expo's bundle phase
 * skips bundling for any `*Debug*` configuration, so a Debug app embeds no JS and
 * needs Metro (or, through the dev launcher, an EAS update), while Release runs
 * `expo export:embed` and launches straight into the app. A development variant
 * is a dev client, so Debug is its natural pairing; preview and production are
 * not.
 */
export function defaultConfiguration(variant: string): MacBuildConfiguration {
  return variant === 'development' ? 'Debug' : 'Release';
}

export function macBuildConfigPath(projectRoot: string): string {
  return join(projectRoot, 'justin-sdk.config.json');
}

/** The example block every "fix your config" message shows. */
export const MAC_BUILD_CONFIG_EXAMPLE = `"componentConfig": {
  "${MAC_BUILD_CONFIG_KEY}": {
    "variant": "preview",
    "scheme": "MyAppPreview",
    "bundleId": "com.example.myapp.preview"
  }
}`;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/** The block's problems, one line each; empty when it is usable. */
function blockProblems(block: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const check = (key: string, pattern: RegExp, shape: string): void => {
    const value = block[key];
    if (value == null) {
      problems.push(`"${key}" is missing (${shape}).`);
    } else if (typeof value !== 'string' || !pattern.test(value)) {
      problems.push(`"${key}" is ${JSON.stringify(value)}, not ${shape}.`);
    }
  };
  check(
    'variant',
    VARIANT_PATTERN,
    'an APP_VARIANT such as "development" or "preview" (lowercase letters, digits and -)',
  );
  check(
    'scheme',
    SCHEME_PATTERN,
    'the scheme Expo generates for that variant, e.g. "NatureSoundsPreview" (letters and digits)',
  );
  check(
    'bundleId',
    BUNDLE_ID_PATTERN,
    'that variant’s bundle identifier, e.g. "com.example.app.preview"',
  );
  const configuration = block.configuration;
  if (
    configuration != null &&
    configuration !== 'Debug' &&
    configuration !== 'Release'
  ) {
    problems.push(
      `"configuration" is ${JSON.stringify(configuration)}, not "Debug" or "Release".`,
    );
  }
  return problems;
}

/** Read and check `componentConfig["mac-build"]` from the repo's own config file. */
export function readMacBuildConfig(projectRoot: string): MacBuildConfigRead {
  const path = macBuildConfigPath(projectRoot);

  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (error) {
    if ((error as {code?: unknown}).code === 'ENOENT') {
      return {path, status: 'absent'};
    }
    return {path, reason: describeError(error), status: 'unreadable'};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      path,
      reason: `not valid JSON: ${describeError(error)}`,
      status: 'unreadable',
    };
  }
  if (!isRecord(parsed)) {
    return {path, reason: 'not a JSON object', status: 'unreadable'};
  }

  const componentConfig = parsed.componentConfig;
  if (componentConfig == null) return {path, status: 'absent'};
  if (!isRecord(componentConfig)) {
    return {
      path,
      reason: '"componentConfig" is not an object',
      status: 'invalid',
    };
  }
  const block = componentConfig[MAC_BUILD_CONFIG_KEY];
  if (block == null) return {path, status: 'absent'};
  if (!isRecord(block)) {
    return {
      path,
      reason: `"componentConfig.${MAC_BUILD_CONFIG_KEY}" is not an object`,
      status: 'invalid',
    };
  }

  const problems = blockProblems(block);
  if (problems.length > 0) {
    return {path, reason: problems.join(' '), status: 'invalid'};
  }

  // blockProblems has checked every one of these.
  const variant = block.variant as string;
  const explicit = block.configuration as MacBuildConfiguration | undefined;
  return {
    config: {
      bundleId: block.bundleId as string,
      configuration: explicit ?? defaultConfiguration(variant),
      configurationSource: explicit == null ? 'default' : 'config',
      scheme: block.scheme as string,
      variant,
    },
    path,
    status: 'ok',
  };
}

/**
 * The `mac-build` component's gate: the repo has a `mac-build` block, valid or
 * not. A broken block still counts — the repo has said it wants a Mac build, and
 * the command is where the problem gets named. An unreadable config file does
 * not count: nothing in it can be read, and `doctor` reports that file anyway.
 */
export function hasMacBuildConfig(projectRoot: string): boolean {
  const read = readMacBuildConfig(projectRoot);
  return read.status === 'ok' || read.status === 'invalid';
}
