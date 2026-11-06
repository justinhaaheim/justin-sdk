/**
 * mac-build-config.ts — the per-repo settings `justin-sdk mac-build` reads:
 * `componentConfig["mac-build"]` in the repo's own justin-sdk.config.json
 * (home-base-0jeya.1).
 *
 *   "mac-build": {
 *     "variant": "preview",                         // APP_VARIANT to prebuild and build
 *     "scheme": "NatureSoundsPreview",              // the workspace / scheme Expo generates for it
 *     "bundleId": "com.jhaa.naturesounds.preview",  // the only app the install step copies or replaces
 *     "configuration": "Release",                   // optional; see defaultConfiguration
 *     "variants": {                                 // optional; what `--variant <name>` can select
 *       "development": {
 *         "scheme": "NatureSoundsDev",
 *         "bundleId": "com.jhaa.naturesounds.dev"   // "configuration" is optional here too
 *       }
 *     }
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
 * THE "variants" MAP (home-base-0jeya.9) is how a second build of the same app,
 * typically Dev beside a Preview default, is one command-line argument away. Its
 * entries are written down for the same reason as the top-level values, so a name
 * in neither place is an error that shows the JSON to add, never the default and
 * never a scheme worked out at run time. Every entry is checked on every read: a
 * broken one makes the whole block invalid even when a different variant was
 * asked for, because a typo should not wait to be found by the build that needs
 * it. The top-level "variant" may not also be a key: that would be two sources
 * for one variant.
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
  | {
      /** The top-level values: what a build with no `--variant` builds. */
      config: MacBuildConfig;
      path: string;
      status: 'ok';
      /**
       * The "variants" entries, by name. A Map rather than the parsed object, so
       * `--variant constructor` cannot find something on Object.prototype.
       */
      variants: ReadonlyMap<string, MacBuildConfig>;
    }
  | {path: string; status: 'absent'}
  | {path: string; reason: string; status: 'invalid'}
  | {path: string; reason: string; status: 'unreadable'};

export type MacBuildConfigOk = Extract<MacBuildConfigRead, {status: 'ok'}>;

/** What `--variant` resolved to. There is no third case: no fallback exists. */
export type MacBuildVariantSelection =
  | {
      config: MacBuildConfig;
      /** Where the selected values are written, for messages. */
      configKey: string;
      status: 'selected';
    }
  | {message: string; status: 'unknown'};

const VARIANT_PATTERN = /^[a-z][a-z0-9-]*$/;
const SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;
const BUNDLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

const VARIANT_SHAPE =
  'an APP_VARIANT such as "development" or "preview" (lowercase letters, digits and -)';
const SCHEME_SHAPE =
  'the scheme Expo generates for that variant, e.g. "NatureSoundsPreview" (letters and digits)';
const BUNDLE_ID_SHAPE =
  'that variant’s bundle identifier, e.g. "com.example.app.preview"';

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

/** The optional map beside those keys, for the same message. */
export const MAC_BUILD_VARIANTS_EXAMPLE = `"variants": {
  "development": {
    "scheme": "MyAppDev",
    "bundleId": "com.example.myapp.dev"
  }
}`;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/** One required value's problem, as a list so callers can spread it. */
function requiredValueProblems(
  value: unknown,
  label: string,
  pattern: RegExp,
  shape: string,
): string[] {
  if (value == null) return [`"${label}" is missing (${shape}).`];
  if (typeof value !== 'string' || !pattern.test(value)) {
    return [`"${label}" is ${JSON.stringify(value)}, not ${shape}.`];
  }
  return [];
}

/**
 * The problems of the keys the top level and a "variants" entry share. `prefix`
 * says where they sit in the messages: empty at the top level,
 * `variants.development.` in an entry.
 */
function buildKeyProblems(
  block: Record<string, unknown>,
  prefix: string,
): string[] {
  const problems = [
    ...requiredValueProblems(
      block.scheme,
      `${prefix}scheme`,
      SCHEME_PATTERN,
      SCHEME_SHAPE,
    ),
    ...requiredValueProblems(
      block.bundleId,
      `${prefix}bundleId`,
      BUNDLE_ID_PATTERN,
      BUNDLE_ID_SHAPE,
    ),
  ];
  const configuration = block.configuration;
  if (
    configuration != null &&
    configuration !== 'Debug' &&
    configuration !== 'Release'
  ) {
    problems.push(
      `"${prefix}configuration" is ${JSON.stringify(configuration)}, not "Debug" or "Release".`,
    );
  }
  return problems;
}

/** The problems of the optional "variants" map, whichever variant is wanted. */
function variantsProblems(
  variants: unknown,
  topLevelVariant: unknown,
): string[] {
  if (variants === undefined) return [];
  if (!isRecord(variants)) {
    return [
      `"variants" is ${JSON.stringify(variants)}, not an object of variant names to {"scheme", "bundleId"}.`,
    ];
  }
  const problems: string[] = [];
  for (const [name, entry] of Object.entries(variants)) {
    if (!VARIANT_PATTERN.test(name)) {
      problems.push(
        `"variants" has the key ${JSON.stringify(name)}, not ${VARIANT_SHAPE}.`,
      );
    }
    if (name === topLevelVariant) {
      problems.push(
        `"variants.${name}" repeats the top-level "variant", so one variant has two sources. Remove the entry, or make a different variant the default.`,
      );
    }
    if (isRecord(entry)) {
      problems.push(...buildKeyProblems(entry, `variants.${name}.`));
    } else {
      problems.push(
        `"variants.${name}" is ${JSON.stringify(entry)}, not an object with "scheme" and "bundleId".`,
      );
    }
  }
  return problems;
}

/** The block's problems, one line each; empty when it is usable. */
function blockProblems(block: Record<string, unknown>): string[] {
  return [
    ...requiredValueProblems(
      block.variant,
      'variant',
      VARIANT_PATTERN,
      VARIANT_SHAPE,
    ),
    ...buildKeyProblems(block, ''),
    ...variantsProblems(block.variants, block.variant),
  ];
}

/** One checked block's values, for `variant`. blockProblems has checked them. */
function resolvedConfig(
  variant: string,
  block: Record<string, unknown>,
): MacBuildConfig {
  const explicit = block.configuration as MacBuildConfiguration | undefined;
  return {
    bundleId: block.bundleId as string,
    configuration: explicit ?? defaultConfiguration(variant),
    configurationSource: explicit == null ? 'default' : 'config',
    scheme: block.scheme as string,
    variant,
  };
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
  const entries = (block.variants ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  return {
    config: resolvedConfig(block.variant as string, block),
    path,
    status: 'ok',
    variants: new Map(
      Object.entries(entries).map(([name, entry]) => [
        name,
        resolvedConfig(name, entry),
      ]),
    ),
  };
}

/** Why `requested` cannot be built, the variants that can, and the JSON to add. */
function unknownVariantMessage(
  read: MacBuildConfigOk,
  requested: string,
): string {
  const isName = VARIANT_PATTERN.test(requested);
  // Only a usable name goes into the JSON: it is there to be pasted.
  const name = isName ? requested : '<variant>';
  const known = [
    `${read.config.variant} (the default)`,
    ...[...read.variants.keys()].sort(),
  ].join(', ');
  const opening = isName
    ? `"${requested}" is not a variant this repo's Mac build knows, so nothing was built.`
    : `${JSON.stringify(requested)} is not a variant name (lowercase letters, digits and -), so nothing was built.`;
  // The placeholders are not valid values, so pasting them unedited is refused
  // too. A plausible example scheme would build whatever it happened to match.
  const json = `"variants": {
  "${name}": {
    "scheme": "<scheme>",
    "bundleId": "<bundle id>"
  }
}`;
  return [
    `${opening} It knows: ${known}.`,
    `To build another variant, add it under "variants" in componentConfig.${MAC_BUILD_CONFIG_KEY} in ${read.path}:`,
    json,
    `"scheme" is the ios/*.xcworkspace name \`APP_VARIANT=${name} npx expo prebuild\` generates; "bundleId" is that variant's ios.bundleIdentifier. "configuration" is optional (Debug for development, Release otherwise).`,
  ].join('\n\n');
}

/**
 * Which values a build uses. `requested` is what `--variant` asked for, null when
 * it was not given. Null or the top-level variant gives the top-level values, a
 * key of "variants" gives that entry, and anything else is an error: this is the
 * one place a fallback to the default could happen, and it must not.
 */
export function selectMacBuildVariant(
  read: MacBuildConfigOk,
  requested: string | null,
): MacBuildVariantSelection {
  if (requested == null || requested === read.config.variant) {
    return {
      config: read.config,
      configKey: `componentConfig.${MAC_BUILD_CONFIG_KEY}`,
      status: 'selected',
    };
  }
  const entry = read.variants.get(requested);
  if (entry != null) {
    return {
      config: entry,
      configKey: `componentConfig.${MAC_BUILD_CONFIG_KEY}.variants.${requested}`,
      status: 'selected',
    };
  }
  return {message: unknownVariantMessage(read, requested), status: 'unknown'};
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
